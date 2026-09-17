use super::*;
use crate::{
    server::{self, Config, Running},
    transfer::{Budget, Kind, Transfer, Unit},
};
use axum::{
    body::{Body, to_bytes},
    extract::ws::Message as Frame,
    http::{HeaderMap, Request},
};
use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use std::{
    sync::{Arc, atomic::AtomicUsize},
    time::Duration,
};
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{self, Message, client::IntoClientRequest},
};
pub(super) const PROOF: &str = "native-test-private-proxy-proof-32-characters";
pub(super) async fn start(directory: &Path, extra: Value) -> Running {
    let mut options = json!({"host":"127.0.0.1","port":0,"dataDir":directory,"authMode":"proxy","proxySecret":PROOF,"password":"","origin":""});
    for (k, v) in object(&extra) {
        options[k] = v.clone();
    }
    server::start(Config::for_test(&options).unwrap())
        .await
        .unwrap()
}
pub(super) fn auth(user: &str, vault: Option<&str>) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("x-auth-user", user.parse().unwrap());
    h.insert("x-stow-proxy-secret", PROOF.parse().unwrap());
    if let Some(v) = vault {
        h.insert("x-stow-vault", v.parse().unwrap());
    }
    h
}
pub(super) struct Response {
    pub status: u16,
    pub headers: HeaderMap,
    pub bytes: Vec<u8>,
}
impl Response {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap()
    }
}
pub(super) async fn request(
    s: &Running,
    method: &str,
    path: &str,
    h: &HeaderMap,
    body: Vec<u8>,
) -> Response {
    let stream = TcpStream::connect(s.address).await.unwrap();
    stream.set_nodelay(true).unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("host", s.address.to_string())
        .body(Body::from(body))
        .unwrap();
    req.headers_mut().extend(h.clone());
    let response = timeout(Duration::from_secs(10), sender.send_request(req))
        .await
        .unwrap()
        .unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = to_bytes(Body::new(response.into_body()), 32 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    Response {
        status,
        headers,
        bytes,
    }
}
pub(super) async fn json_request(
    s: &Running,
    method: &str,
    path: &str,
    h: &HeaderMap,
    body: Value,
) -> Response {
    let mut h = h.clone();
    h.insert("content-type", "application/json".parse().unwrap());
    request(s, method, path, &h, body.to_string().into_bytes()).await
}
pub(super) async fn identity(s: &Running, user: &str) -> String {
    let r = request(s, "GET", "/api/session", &auth(user, None), vec![]).await;
    assert_eq!(r.status, 200);
    string(&r.json()["vaultId"]).into()
}
pub(super) struct Socket {
    socket: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
    transfer: Transfer,
    budget: Budget,
    received: Vec<(Kind, Vec<u8>)>,
}
impl Socket {
    pub async fn connect(s: &Running, h: &HeaderMap, vault: &str) -> Self {
        Self::query(
            s,
            h,
            &format!("schema={CURRENT_SCHEMA}&protocol=3&vaultId={vault}"),
        )
        .await
        .unwrap()
    }
    pub async fn query(
        s: &Running,
        h: &HeaderMap,
        query: &str,
    ) -> std::result::Result<Self, tungstenite::Error> {
        let mut req = format!("ws://{}/sync?{query}", s.address)
            .into_client_request()
            .unwrap();
        req.headers_mut().extend(h.clone());
        let (socket, _) = connect_async(req).await?;
        let budget = Budget::default();
        Ok(Self {
            socket,
            transfer: Transfer::new(budget.clone()),
            budget,
            received: vec![],
        })
    }
    async fn frames(&mut self, frames: Vec<Frame>) {
        for frame in frames {
            let m = match frame {
                Frame::Text(s) => Message::Text(s.as_str().into()),
                Frame::Binary(b) => Message::Binary(b),
                _ => panic!("unexpected outgoing frame"),
            };
            self.socket.send(m).await.unwrap();
        }
    }
    async fn pump(&mut self) -> std::result::Result<(), String> {
        let m = timeout(Duration::from_secs(10), self.socket.next())
            .await
            .map_err(|_| "socket timeout")?
            .ok_or("socket closed")?
            .map_err(|e| e.to_string())?;
        let frame = match m {
            Message::Text(s) => Frame::Text(s.as_str().into()),
            Message::Binary(b) => Frame::Binary(b),
            Message::Ping(_) | Message::Pong(_) => return Ok(()),
            other => return Err(format!("socket ended: {other:?}")),
        };
        let (frames, received) = self
            .transfer
            .receive(frame)
            .map_err(|e| e.message.to_string())?;
        self.frames(frames).await;
        if let Some(r) = received {
            self.received.push((r.kind, r.data));
            let done = self.transfer.committed(r.id).unwrap();
            self.frames(vec![done]).await;
        }
        Ok(())
    }
    async fn send_result(&mut self, kind: Kind, bytes: Vec<u8>) -> std::result::Result<(), String> {
        let unit = Unit::new(
            kind,
            bytes.into(),
            &self.budget,
            Arc::new(AtomicUsize::new(0)),
        )
        .unwrap();
        let frames = self.transfer.send(unit).unwrap();
        self.frames(frames).await;
        while !self.transfer.ready_to_send() {
            self.pump().await?;
        }
        Ok(())
    }
    pub async fn send(&mut self, kind: Kind, bytes: Vec<u8>) {
        self.send_result(kind, bytes).await.unwrap();
    }
    pub async fn next(&mut self, kind: Kind) -> Vec<u8> {
        loop {
            if let Some(i) = self.received.iter().position(|v| v.0 == kind) {
                return self.received.remove(i).1;
            }
            self.pump().await.unwrap();
        }
    }
    pub async fn sync(&mut self, doc: &Doc) {
        self.send(Kind::SyncRequest, vector(doc)).await;
        let bytes = self.next(Kind::Sync).await;
        let marker = CURRENT_SCHEMA.len() + 1;
        assert_eq!(&bytes[..marker - 1], CURRENT_SCHEMA.as_bytes());
        let len = u32::from_be_bytes(bytes[marker..marker + 4].try_into().unwrap()) as usize;
        apply(doc, &bytes[marker + 4 + len..]).unwrap();
    }
    pub async fn boundary(&mut self, sources: &[&str], now: f64) {
        self.send(
            Kind::HistoryBoundary,
            json!({"sourceIds":sources,"editedAt":now})
                .to_string()
                .into_bytes(),
        )
        .await;
        self.next(Kind::HistoryChanged).await;
    }
    pub async fn close(mut self) {
        let _ = self.socket.close(None).await;
    }
}

#[tokio::test]
async fn acknowledged_offline_edits_converge_and_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "alice").await;
    let h = auth("alice", Some(&id));
    let left = new_doc();
    note(&left, "a", "Buy milk");
    let mut a = Socket::connect(&s, &h, &id).await;
    a.send(Kind::Update, encode(&left)).await;
    let right = new_doc();
    let mut b = Socket::connect(&s, &h, &id).await;
    b.sync(&right).await;
    assert_eq!(field(&right.transact(), "notes", "a", "body"), "Buy milk");
    a.close().await;
    b.close().await;
    s.close().await.unwrap();
    append(&left, "a", "body", " left");
    append(&right, "a", "body", " right");
    let s = start(dir.path(), json!({})).await;
    let mut a = Socket::connect(&s, &h, &id).await;
    a.send(Kind::Update, encode(&left)).await;
    a.send(Kind::Update, encode(&right)).await;
    let merged = new_doc();
    a.sync(&merged).await;
    let body = field(&merged.transact(), "notes", "a", "body");
    assert!(string(&body).contains("left"));
    assert!(string(&body).contains("right"));
    a.close().await;
    s.close().await.unwrap();
    let disk = Vault::open(&dir.path().join("users").join(id), 1.).unwrap();
    assert_eq!(field(&disk.doc.transact(), "notes", "a", "body"), body);
}
#[tokio::test]
async fn malformed_update_never_changes_durable_state_and_new_socket_can_retry() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "alice").await;
    let h = auth("alice", Some(&id));
    let doc = new_doc();
    note(&doc, "a", "keep");
    let mut a = Socket::connect(&s, &h, &id).await;
    a.send(Kind::Update, encode(&doc)).await;
    assert!(a.send_result(Kind::Update, vec![1]).await.is_err());
    drop(a);
    let mut a = Socket::connect(&s, &h, &id).await;
    let current = new_doc();
    a.sync(&current).await;
    assert_eq!(field(&current.transact(), "notes", "a", "body"), "keep");
    append(&doc, "a", "body", " retry");
    a.send(Kind::Update, encode(&doc)).await;
    a.close().await;
    s.close().await.unwrap();
}
#[tokio::test]
async fn account_isolation_covers_sync_blobs_binding_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let a = identity(&s, "alice").await;
    let b = identity(&s, "bob").await;
    assert_ne!(a, b);
    let ah = auth("alice", Some(&a));
    let bh = auth("bob", Some(&b));
    let doc = new_doc();
    note(&doc, "private", "Alice only");
    let mut alice = Socket::connect(&s, &ah, &a).await;
    let mut bob = Socket::connect(&s, &bh, &b).await;
    alice.send(Kind::Update, encode(&doc)).await;
    let empty = new_doc();
    bob.sync(&empty).await;
    assert!(keys(&empty.transact(), "notes").is_empty());
    use sha2::{Digest, Sha256};
    let bytes = b"account-local blob";
    let hash = hex::encode(Sha256::digest(bytes));
    let path = format!("/api/blobs/{hash}");
    let mut upload = ah.clone();
    upload.insert("x-stow-blob-sources", r#"["private"]"#.parse().unwrap());
    assert_eq!(
        request(&s, "PUT", &path, &upload, bytes.to_vec())
            .await
            .status,
        204
    );
    assert_eq!(request(&s, "GET", &path, &ah, vec![]).await.bytes, bytes);
    assert_eq!(request(&s, "GET", &path, &bh, vec![]).await.status, 404);
    assert_eq!(
        request(&s, "GET", &path, &auth("bob", Some(&a)), vec![])
            .await
            .status,
        409
    );
    alice.close().await;
    bob.close().await;
    s.close().await.unwrap();
    let s = start(dir.path(), json!({})).await;
    assert_eq!(identity(&s, "alice").await, a);
    let mut alice = Socket::connect(&s, &ah, &a).await;
    let saved = new_doc();
    alice.sync(&saved).await;
    assert_eq!(
        field(&saved.transact(), "notes", "private", "body"),
        "Alice only"
    );
    alice.close().await;
    s.close().await.unwrap();
}
#[tokio::test]
async fn proxy_requires_exact_private_proof_and_one_valid_identity() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    for (h, status) in [(HeaderMap::new(), 401), (auth("alice", None), 200)] {
        assert_eq!(
            request(&s, "GET", "/api/session", &h, vec![]).await.status,
            status
        );
    }
    let mut h = auth("alice", None);
    h.insert("x-stow-proxy-secret", "forged".parse().unwrap());
    assert_eq!(
        request(&s, "GET", "/api/session", &h, vec![]).await.status,
        403
    );
    for name in ["x-auth-user", "x-stow-proxy-secret"] {
        let mut h = auth("alice", None);
        let v = h[name].clone();
        h.append(name, v);
        assert_eq!(
            request(&s, "GET", "/api/session", &h, vec![]).await.status,
            401
        );
    }
    for user in ["alice,bob", "alice bob"] {
        assert_eq!(
            request(&s, "GET", "/api/session", &auth(user, None), vec![])
                .await
                .status,
            403
        );
    }
    assert!(!dir.path().join("vault.yjs").exists());
    s.close().await.unwrap();
}
#[tokio::test]
async fn schema_protocol_and_vault_duplicates_reject_before_account_open() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "new").await;
    let h = auth("new", Some(&id));
    let mut preflight = h.clone();
    preflight.insert("x-stow-sync-protocol", "2".parse().unwrap());
    preflight.insert("x-stow-schema", CURRENT_SCHEMA.parse().unwrap());
    let response = request(&s, "GET", "/api/session", &preflight, vec![]).await;
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["vaultId"], id);
    let rejection = response.json()["syncRejection"].clone();
    assert_eq!(rejection["code"], "client_update_required");
    assert_eq!(rejection["action"], "reload");
    assert_eq!(rejection["target"], format!("{CURRENT_SCHEMA}/3"));
    assert!(
        rejection["message"]
            .as_str()
            .unwrap()
            .contains("Reload Stow")
    );
    assert_eq!(response.headers["cache-control"], "no-store");
    preflight.insert("x-stow-sync-protocol", "3".parse().unwrap());
    assert!(
        request(&s, "GET", "/api/session", &preflight, vec![])
            .await
            .json()["syncRejection"]
            .is_null()
    );
    preflight.append("x-stow-sync-protocol", "3".parse().unwrap());
    assert_eq!(
        request(&s, "GET", "/api/session", &preflight, vec![])
            .await
            .json()["syncRejection"],
        rejection
    );
    preflight.remove("x-stow-proxy-secret");
    let unauthenticated = request(&s, "GET", "/api/session", &preflight, vec![]).await;
    assert_eq!(unauthenticated.status, 401);
    assert!(unauthenticated.json()["syncRejection"].is_null());
    for query in [
        format!("protocol=3&vaultId={id}"),
        format!("schema=old&protocol=3&vaultId={id}"),
        format!("schema={CURRENT_SCHEMA}&schema={CURRENT_SCHEMA}&protocol=3&vaultId={id}"),
        format!("schema={CURRENT_SCHEMA}&protocol=1&vaultId={id}"),
        format!("schema={CURRENT_SCHEMA}&protocol=2&vaultId={id}"),
        format!("schema={CURRENT_SCHEMA}&protocol=3&protocol=3&vaultId={id}"),
    ] {
        let mut rejected = Socket::query(&s, &h, &query).await.unwrap();
        assert_sync_rejection(&mut rejected, &rejection).await;
    }
    let Err(tungstenite::Error::Http(r)) = Socket::query(
        &s,
        &h,
        &format!("schema={CURRENT_SCHEMA}&protocol=3&vaultId={id}&vaultId={id}"),
    )
    .await
    else {
        panic!("admitted duplicate vault")
    };
    assert_eq!(r.status(), 409);
    assert!(!dir.path().join("users").join(id).exists());
    s.close().await.unwrap();
}

async fn assert_sync_rejection(socket: &mut Socket, rejection: &Value) {
    let frame = timeout(Duration::from_secs(2), socket.socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(text) = frame else {
        panic!("expected a readable update notice, got {frame:?}")
    };
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        json!({"type": "sync-rejection", "rejection": rejection})
    );
    let frame = timeout(Duration::from_secs(2), socket.socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Close(Some(close)) = frame else {
        panic!("expected policy close immediately after notice, got {frame:?}")
    };
    assert_eq!(u16::from(close.code), 1008);
    assert_eq!(close.reason, "client_update_required");
    // Complete the close handshake. No transfer receipts or commits were sent.
    socket.socket.flush().await.unwrap();
    assert!(
        timeout(Duration::from_secs(2), socket.socket.next())
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn incompatible_socket_after_successful_preflight_rejects_without_accessing_vault() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let mut headers = auth("deployment-race", None);
    headers.insert("x-stow-sync-protocol", "3".parse().unwrap());
    headers.insert("x-stow-schema", CURRENT_SCHEMA.parse().unwrap());
    let session = request(&s, "GET", "/api/session", &headers, vec![]).await;
    assert_eq!(session.status, 200);
    assert!(session.json()["syncRejection"].is_null());
    let id = session.json()["vaultId"].as_str().unwrap().to_owned();
    let headers = auth("deployment-race", Some(&id));

    // Session approval does not guarantee WebSocket compatibility: a deployment
    // can change the required versions between those two requests.
    let query = format!("schema={CURRENT_SCHEMA}&protocol=2&vaultId={id}");
    let mut socket = Socket::query(&s, &headers, &query).await.unwrap();
    let pending = new_doc();
    note(
        &pending,
        "offline",
        "Pending edits must remain on the client",
    );
    let unit = Unit::new(
        Kind::Update,
        encode(&pending).into(),
        &socket.budget,
        Arc::new(AtomicUsize::new(0)),
    )
    .unwrap();
    let frames = socket.transfer.send(unit).unwrap();
    socket.frames(frames).await;
    let mut incompatible = headers.clone();
    incompatible.insert("x-stow-sync-protocol", "2".parse().unwrap());
    let rejection = request(&s, "GET", "/api/session", &incompatible, vec![])
        .await
        .json()["syncRejection"]
        .clone();
    assert_sync_rejection(&mut socket, &rejection).await;
    assert!(!dir.path().join("users").join(&id).exists());

    // Reject origin, authentication, and ambiguous/wrong identities before
    // upgrading, even when the advertised protocol is also incompatible.
    let mut foreign = headers.clone();
    foreign.insert("origin", "https://foreign.example".parse().unwrap());
    let mut unauthenticated = headers.clone();
    unauthenticated.remove("x-stow-proxy-secret");
    for (headers, query, status) in [
        (foreign, query.clone(), 403),
        (unauthenticated, query.clone(), 401),
        (headers.clone(), format!("{query}&vaultId={id}"), 409),
        (
            headers.clone(),
            format!("schema={CURRENT_SCHEMA}&protocol=2&vaultId=wrong"),
            409,
        ),
    ] {
        let Err(tungstenite::Error::Http(response)) = Socket::query(&s, &headers, &query).await
        else {
            panic!("upgraded a request with invalid origin, auth, or identity")
        };
        assert_eq!(response.status(), status);
    }
    assert!(!dir.path().join("users").join(id).exists());
    s.close().await.unwrap();
}

#[tokio::test]
async fn incompatible_socket_waiting_for_close_does_not_delay_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "unresponsive-client").await;
    let mut socket = Socket::query(
        &s,
        &auth("unresponsive-client", Some(&id)),
        &format!("schema={CURRENT_SCHEMA}&protocol=2&vaultId={id}"),
    )
    .await
    .unwrap();
    assert!(matches!(
        timeout(Duration::from_secs(2), socket.socket.next())
            .await
            .unwrap(),
        Some(Ok(Message::Text(_)))
    ));
    // Leave the socket alive without reading/acknowledging the server close.
    // Shutdown must cancel the tracked task, without waiting for its deadline.
    timeout(Duration::from_secs(2), s.close())
        .await
        .unwrap()
        .unwrap();
    assert!(!dir.path().join("users").join(id).exists());
}
#[tokio::test]
async fn large_initial_sync_then_incremental_update_is_durable() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "alice").await;
    let h = auth("alice", Some(&id));
    let doc = new_doc();
    note(&doc, "a", &"x".repeat(3 * 1024 * 1024));
    let mut a = Socket::connect(&s, &h, &id).await;
    a.send(Kind::Update, encode(&doc)).await;
    a.close().await;
    let mut b = Socket::connect(&s, &h, &id).await;
    let copy = new_doc();
    b.sync(&copy).await;
    assert_eq!(
        field(&copy.transact(), "notes", "a", "body"),
        field(&doc.transact(), "notes", "a", "body")
    );
    let v = doc.transact().state_vector();
    append(&doc, "a", "body", "!");
    let update = diff(&doc, &v);
    assert!(update.len() < 100);
    b.send(Kind::Update, update).await;
    b.close().await;
    s.close().await.unwrap();
    let disk = Vault::open(&dir.path().join("users").join(id), 1.).unwrap();
    assert_eq!(
        field(&disk.doc.transact(), "notes", "a", "body"),
        field(&doc.transact(), "notes", "a", "body")
    );
}
#[tokio::test]
async fn history_is_bound_no_store_and_downloads_full_state_only_on_request() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "alice").await;
    let h = auth("alice", Some(&id));
    let mut socket = Socket::connect(&s, &h, &id).await;
    let doc = new_doc();
    note(&doc, "a", "Observed current body");
    socket.send(Kind::Update, encode(&doc)).await;
    assert_eq!(
        request(
            &s,
            "GET",
            "/api/history?noteId=a",
            &HeaderMap::new(),
            vec![]
        )
        .await
        .status,
        401
    );
    assert_eq!(
        request(
            &s,
            "GET",
            "/api/history?noteId=a",
            &auth("alice", None),
            vec![]
        )
        .await
        .status,
        409
    );
    assert!(
        array(
            &request(&s, "GET", "/api/history?noteId=a", &h, vec![])
                .await
                .json()["versions"]
        )
        .is_empty()
    );
    socket.boundary(&["a"], 10.).await;
    let r = request(&s, "GET", "/api/history?noteId=a", &h, vec![]).await;
    assert_eq!(r.headers["cache-control"], "no-store");
    assert!(!contains(&r.bytes, "Observed current body"));
    let page = r.json();
    assert!(page["versions"][0].get("state").is_none());
    assert!(page["versions"][0].get("action").is_none());
    let path = format!("/api/history/{}", string(&page["versions"][0]["id"]));
    let detail = request(&s, "GET", &path, &h, vec![]).await;
    assert_eq!(detail.headers["cache-control"], "no-store");
    assert_eq!(
        detail.json()["state"]["sources"]["a"]["body"],
        "Observed current body"
    );
    let b = identity(&s, "bob").await;
    assert_eq!(
        request(&s, "GET", &path, &auth("bob", Some(&b)), vec![])
            .await
            .status,
        404
    );
    assert_eq!(
        request(&s, "GET", "/api/history/export", &h, vec![])
            .await
            .json()["versions"][0]["state"]["sources"]["a"]["body"],
        "Observed current body"
    );
    socket.close().await;
    s.close().await.unwrap();
}
#[tokio::test]
async fn reconnect_history_records_only_final_current_state() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "alice").await;
    let h = auth("alice", Some(&id));
    let mut socket = Socket::connect(&s, &h, &id).await;
    let doc = new_doc();
    note(&doc, "a", "Offline one");
    text(&doc, "a", "body", "Offline two");
    text(&doc, "a", "body", "Final offline body");
    socket.send(Kind::Update, encode(&doc)).await;
    socket.send(Kind::SyncComplete, b"{}".to_vec()).await;
    socket.next(Kind::HistoryChanged).await;
    let export = request(&s, "GET", "/api/history/export", &h, vec![]).await;
    assert_eq!(array(&export.json()["versions"]).len(), 1);
    assert!(contains(&export.bytes, "Final offline body"));
    assert!(!contains(&export.bytes, "Offline one"));
    assert!(!contains(&export.bytes, "Offline two"));
    socket.close().await;
    s.close().await.unwrap();
}
#[tokio::test]
async fn history_write_failure_is_separate_and_read_only_repair_keeps_socket_usable() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "alice").await;
    let h = auth("alice", Some(&id));
    let mut socket = Socket::connect(&s, &h, &id).await;
    let doc = new_doc();
    note(&doc, "a", "Before failure");
    socket.send(Kind::Update, encode(&doc)).await;
    let path = dir
        .path()
        .join("users")
        .join(&id)
        .join("history")
        .join(format!("{}.json", crate::history::hash(&json!(["a"]))));
    fs::create_dir(&path).unwrap();
    socket
        .send(
            Kind::HistoryBoundary,
            json!({"sourceIds":["a"],"editedAt":10})
                .to_string()
                .into_bytes(),
        )
        .await;
    assert!(contains(
        &socket.next(Kind::HistoryFailure).await,
        "Current notes are saved"
    ));
    assert_eq!(
        request(&s, "GET", "/api/history?noteId=a", &h, vec![])
            .await
            .status,
        503
    );
    text(&doc, "a", "body", "After failure");
    socket.send(Kind::Update, encode(&doc)).await;
    fs::remove_dir(path).unwrap();
    let repaired = request(&s, "GET", "/api/history?noteId=a", &h, vec![]).await;
    assert_eq!(repaired.status, 200);
    assert!(array(&repaired.json()["versions"]).is_empty());
    assert!(repaired.json()["error"].is_string());
    socket.boundary(&["a"], 11.).await;
    assert!(
        request(&s, "GET", "/api/history?noteId=a", &h, vec![])
            .await
            .json()
            .get("error")
            .is_none()
    );
    assert!(contains(
        &request(&s, "GET", "/api/history/export", &h, vec![])
            .await
            .bytes,
        "After failure"
    ));
    socket.close().await;
    s.close().await.unwrap();
}
#[tokio::test]
async fn malformed_history_hint_preserves_next_acknowledged_current_update() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "alice").await;
    let h = auth("alice", Some(&id));
    let mut socket = Socket::connect(&s, &h, &id).await;
    let doc = new_doc();
    note(&doc, "a", "Before");
    socket.send(Kind::Update, encode(&doc)).await;
    socket
        .send(
            Kind::HistoryBoundary,
            br#"{"sourceIds":["a"],"editedAt":"yesterday"}"#.to_vec(),
        )
        .await;
    assert!(contains(
        &socket.next(Kind::HistoryFailure).await,
        "Invalid history boundary"
    ));
    text(&doc, "a", "body", "After");
    socket.send(Kind::Update, encode(&doc)).await;
    socket.boundary(&["a"], 12.).await;
    socket.close().await;
    s.close().await.unwrap();
}

#[tokio::test]
async fn failed_disk_write_is_neither_acknowledged_nor_broadcast_and_can_retry() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "alice").await;
    let h = auth("alice", Some(&id));
    let mut writer = Socket::connect(&s, &h, &id).await;
    let doc = new_doc();
    note(&doc, "a", "Saved");
    writer.send(Kind::Update, encode(&doc)).await;
    let mut observer = Socket::connect(&s, &h, &id).await;
    let before = new_doc();
    observer.sync(&before).await;
    let v = doc.transact().state_vector();
    append(&doc, "a", "body", " pending");
    let update = diff(&doc, &v);
    let directory = dir.path().join("users").join(&id);
    fs::rename(directory.join("updates"), directory.join("unavailable")).unwrap();
    assert!(
        writer
            .send_result(Kind::Update, update.clone())
            .await
            .is_err()
    );
    drop(writer);
    let accepted = new_doc();
    observer.sync(&accepted).await;
    assert_eq!(field(&accepted.transact(), "notes", "a", "body"), "Saved");
    assert!(!observer.received.iter().any(|v| v.0 == Kind::Update));
    fs::rename(directory.join("unavailable"), directory.join("updates")).unwrap();
    let mut retry = Socket::connect(&s, &h, &id).await;
    retry.send(Kind::Update, update.clone()).await;
    assert_eq!(observer.next(Kind::Update).await, update);
    retry.close().await;
    observer.close().await;
    s.close().await.unwrap();
}
#[tokio::test]
async fn concurrent_writers_retain_every_acknowledged_update_through_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "alice").await;
    let h = auth("alice", Some(&id));
    let mut sockets = vec![];
    for _ in 0..12 {
        sockets.push(Socket::connect(&s, &h, &id).await);
    }
    let tasks = sockets
        .into_iter()
        .enumerate()
        .map(|(i, mut socket)| async move {
            let doc = new_doc();
            note(&doc, &format!("writer-{i}"), &format!("value-{i} 🦀"));
            socket.send(Kind::Update, encode(&doc)).await;
            socket
        });
    let sockets = futures_util::future::join_all(tasks).await;
    s.close().await.unwrap();
    drop(sockets);
    let s = start(dir.path(), json!({})).await;
    let mut socket = Socket::connect(&s, &h, &id).await;
    let doc = new_doc();
    socket.sync(&doc).await;
    for i in 0..12 {
        assert_eq!(
            field(&doc.transact(), "notes", &format!("writer-{i}"), "body"),
            format!("value-{i} 🦀")
        );
    }
    socket.close().await;
    s.close().await.unwrap();
}
#[tokio::test]
async fn lost_durable_acknowledgment_replays_after_restart_without_duplicate_text() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "alice").await;
    let h = auth("alice", Some(&id));
    let mut socket = Socket::connect(&s, &h, &id).await;
    let doc = new_doc();
    note(&doc, "a", "Once 🦀");
    let update = encode(&doc);
    let unit = Unit::new(
        Kind::Update,
        update.clone().into(),
        &socket.budget,
        Arc::new(AtomicUsize::new(0)),
    )
    .unwrap();
    let frames = socket.transfer.send(unit).unwrap();
    socket.frames(frames).await;
    loop {
        let m = timeout(Duration::from_secs(10), socket.socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Text(s) = m else {
            panic!("expected control")
        };
        let v: Value = serde_json::from_str(&s).unwrap();
        if v["type"] == "done" {
            break;
        }
        let (frames, _) = socket
            .transfer
            .receive(Frame::Text(s.as_str().into()))
            .unwrap();
        socket.frames(frames).await;
    }
    assert!(
        !socket.transfer.ready_to_send(),
        "lost done frame must leave sender pending"
    );
    drop(socket);
    s.close().await.unwrap();
    let s = start(dir.path(), json!({})).await;
    let mut socket = Socket::connect(&s, &h, &id).await;
    socket.send(Kind::Update, update).await;
    let copy = new_doc();
    socket.sync(&copy).await;
    assert_eq!(field(&copy.transact(), "notes", "a", "body"), "Once 🦀");
    assert_eq!(vector(&copy), vector(&doc));
    socket.close().await;
    s.close().await.unwrap();
}
#[tokio::test]
async fn sixteen_slots_are_account_local_and_close_releases_one() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "alice").await;
    let h = auth("alice", Some(&id));
    let query = format!("schema={CURRENT_SCHEMA}&protocol=3&vaultId={id}");
    let mut sockets = vec![];
    for _ in 0..16 {
        sockets.push(Socket::connect(&s, &h, &id).await);
    }
    let Err(tungstenite::Error::Http(r)) = Socket::query(&s, &h, &query).await else {
        panic!("accepted seventeenth connection")
    };
    assert_eq!(r.status(), 503);
    let other = identity(&s, "bob").await;
    let other = Socket::connect(&s, &auth("bob", Some(&other)), &other).await;
    sockets.pop().unwrap().close().await;
    let mut replacement = timeout(Duration::from_secs(5), async {
        loop {
            match Socket::query(&s, &h, &query).await {
                Ok(socket) => break socket,
                Err(tungstenite::Error::Http(r)) if r.status() == 503 => {
                    tokio::task::yield_now().await
                }
                Err(e) => panic!("{e}"),
            }
        }
    })
    .await
    .unwrap();
    let doc = new_doc();
    note(&doc, "a", "slot reused");
    replacement.send(Kind::Update, encode(&doc)).await;
    replacement.close().await;
    other.close().await;
    for socket in sockets {
        socket.close().await;
    }
    s.close().await.unwrap();
}
#[tokio::test]
async fn password_sessions_protect_blobs_origin_and_persist_until_password_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let options = json!({"authMode":"password","password":"correct horse"});
    let s = start(dir.path(), options.clone()).await;
    let empty = HeaderMap::new();
    assert_eq!(
        request(&s, "GET", "/api/session", &empty, vec![])
            .await
            .json(),
        json!({"authenticated":false,"required":true,"authMode":"password"})
    );
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/api/login",
            &empty,
            json!({"password":"wrong"})
        )
        .await
        .status,
        401
    );
    let mut foreign = HeaderMap::new();
    foreign.insert("origin", "https://evil.example".parse().unwrap());
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/api/login",
            &foreign,
            json!({"password":"correct horse"})
        )
        .await
        .status,
        403
    );
    let login = json_request(
        &s,
        "POST",
        "/api/login",
        &empty,
        json!({"password":"correct horse"}),
    )
    .await;
    assert_eq!(login.status, 200);
    let cookie = login.headers["set-cookie"].to_str().unwrap();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Strict"));
    let mut h = HeaderMap::new();
    h.insert("cookie", cookie.split(';').next().unwrap().parse().unwrap());
    h.insert(
        "x-stow-vault",
        string(&login.json()["vaultId"]).parse().unwrap(),
    );
    let bytes = b"attachment";
    use sha2::{Digest, Sha256};
    let path = format!("/api/blobs/{}", hex::encode(Sha256::digest(bytes)));
    assert_eq!(request(&s, "GET", &path, &empty, vec![]).await.status, 401);
    assert_eq!(
        request(&s, "PUT", &path, &h, b"wrong".to_vec())
            .await
            .status,
        400
    );
    assert_eq!(
        request(&s, "PUT", &path, &h, bytes.to_vec()).await.status,
        204
    );
    let mut bad = h.clone();
    bad.insert("origin", "https://evil.example".parse().unwrap());
    assert_eq!(
        request(&s, "PUT", &path, &bad, bytes.to_vec()).await.status,
        403
    );
    assert!(
        Socket::query(
            &s,
            &bad,
            &format!(
                "schema={CURRENT_SCHEMA}&protocol=3&vaultId={}",
                h["x-stow-vault"].to_str().unwrap()
            )
        )
        .await
        .is_err()
    );
    s.close().await.unwrap();
    let s = start(dir.path(), options).await;
    assert_eq!(
        request(&s, "GET", "/api/session", &h, vec![]).await.json()["authenticated"],
        true
    );
    assert_eq!(request(&s, "GET", &path, &h, vec![]).await.bytes, bytes);
    s.close().await.unwrap();
    let s = start(
        dir.path(),
        json!({"authMode":"password","password":"rotated"}),
    )
    .await;
    assert_eq!(
        request(&s, "GET", "/api/session", &h, vec![]).await.json()["authenticated"],
        false
    );
    s.close().await.unwrap();
}
#[tokio::test]
async fn configured_https_origin_issues_secure_cookies_and_allows_proxy_websocket() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(
        dir.path(),
        json!({"authMode":"password","password":"password","origin":"https://notes.example.com"}),
    )
    .await;
    let mut h = HeaderMap::new();
    h.insert("origin", "https://notes.example.com".parse().unwrap());
    let login = json_request(&s, "POST", "/api/login", &h, json!({"password":"password"})).await;
    assert_eq!(login.status, 200);
    let cookie = login.headers["set-cookie"].to_str().unwrap();
    assert!(cookie.contains("Secure"));
    h.insert("cookie", cookie.split(';').next().unwrap().parse().unwrap());
    let socket = Socket::connect(&s, &h, string(&login.json()["vaultId"])).await;
    socket.close().await;
    h.insert("origin", format!("http://{}", s.address).parse().unwrap());
    assert_eq!(
        request(&s, "GET", "/api/session", &h, vec![]).await.status,
        403
    );
    s.close().await.unwrap();
}
#[tokio::test]
async fn storage_preferences_are_strict_account_bound_and_same_origin() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let a = identity(&s, "alice").await;
    let b = identity(&s, "bob").await;
    let h = auth("alice", Some(&a));
    assert_eq!(
        request(&s, "GET", "/api/storage", &HeaderMap::new(), vec![])
            .await
            .status,
        401
    );
    assert_eq!(
        request(&s, "GET", "/api/storage", &auth("alice", None), vec![])
            .await
            .status,
        409
    );
    let mut foreign = h.clone();
    foreign.insert("origin", "https://foreign.invalid".parse().unwrap());
    for path in [
        "/api/history-retention",
        "/api/history-retention/compression",
    ] {
        assert_eq!(
            json_request(&s, "PUT", path, &foreign, json!({"enabled":true}))
                .await
                .status,
            403
        );
        assert_eq!(
            json_request(
                &s,
                "PUT",
                path,
                &auth("alice", Some(&b)),
                json!({"enabled":true})
            )
            .await
            .status,
            409
        );
        for invalid in [
            json!({}),
            json!({"enabled":"false"}),
            json!({"enabled":true,"extra":1}),
        ] {
            assert_eq!(json_request(&s, "PUT", path, &h, invalid).await.status, 400);
        }
    }
    assert_eq!(
        json_request(
            &s,
            "PUT",
            "/api/history-retention",
            &h,
            json!({"enabled":true})
        )
        .await
        .json()["retention"]["enabled"],
        true
    );
    let changed = json_request(
        &s,
        "PUT",
        "/api/history-retention/compression",
        &h,
        json!({"enabled":false}),
    )
    .await
    .json();
    assert_eq!(changed["compression"]["enabled"], false);
    assert_eq!(changed["retention"]["enabled"], true);
    let other = request(&s, "GET", "/api/storage", &auth("bob", Some(&b)), vec![])
        .await
        .json();
    assert_eq!(other["retention"]["enabled"], false);
    assert_eq!(other["compression"]["enabled"], true);
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/api/history-retention/cleanup",
            &h,
            json!({"sourceIds":[]})
        )
        .await
        .status,
        400
    );
    s.close().await.unwrap();
}
#[tokio::test]
async fn diagnostics_validate_payloads_strip_private_fields_and_bound_account_local_ring() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let a = identity(&s, "alice").await;
    let b = identity(&s, "bob").await;
    let h = auth("alice", Some(&a));
    let endpoint = "/api/diagnostics/startup";
    let body = json!({"schema":1,"id":"11111111-1111-4111-8111-111111111111","startedAt":1000,"reason":"ready","marks":[{"name":"session-start","at":100},{"name":"session-response","at":650}],"counters":{"updateBytes":7100000,"searchIndexedNotes":2709,"searchSlices":70,"searchActiveMs":260,"searchMaxSliceMs":5},"navigation":{"responseEnd":30},"resources":[{"name":"/api/session","startTime":100,"duration":550,"serverMs":0.12}],"frameGaps":[]});
    assert_eq!(
        request(&s, "GET", endpoint, &HeaderMap::new(), vec![])
            .await
            .status,
        401
    );
    assert_eq!(
        request(&s, "GET", endpoint, &auth("alice", None), vec![])
            .await
            .status,
        409
    );
    assert_eq!(
        json_request(&s, "POST", endpoint, &auth("alice", Some(&b)), body.clone())
            .await
            .status,
        409
    );
    let mut forged = h.clone();
    forged.insert("x-stow-proxy-secret", "forged".parse().unwrap());
    assert_eq!(
        json_request(&s, "POST", endpoint, &forged, body.clone())
            .await
            .status,
        403
    );
    let mut foreign = h.clone();
    foreign.insert("origin", "https://foreign.example".parse().unwrap());
    assert_eq!(
        json_request(&s, "POST", endpoint, &foreign, body.clone())
            .await
            .status,
        403
    );
    for (key, v) in [
        ("marks", json!([{"name":"private text","at":1}])),
        ("counters", json!({"updateBytes":-1})),
        (
            "resources",
            json!([{"name":"/api/blobs/private","duration":2}]),
        ),
    ] {
        let mut invalid = body.clone();
        invalid[key] = v;
        assert_eq!(
            json_request(&s, "POST", endpoint, &h, invalid).await.status,
            400
        );
    }
    let mut private = body.clone();
    private["privateText"] = json!("must not be retained");
    assert_eq!(
        json_request(&s, "POST", endpoint, &h, private).await.status,
        201
    );
    let r = request(&s, "GET", endpoint, &h, vec![]).await.json();
    assert_eq!(array(&r["reports"]).len(), 1);
    assert!(r["reports"][0].get("privateText").is_none());
    assert_eq!(r["reports"][0]["marks"], body["marks"]);
    assert_eq!(r["reports"][0]["counters"], body["counters"]);
    assert!(
        array(
            &request(&s, "GET", endpoint, &auth("bob", Some(&b)), vec![])
                .await
                .json()["reports"]
        )
        .is_empty()
    );
    let mut waiting = body.clone();
    waiting["reason"] = json!("waiting");
    assert_eq!(
        json_request(&s, "POST", endpoint, &h, waiting).await.status,
        201
    );
    assert_eq!(
        array(&request(&s, "GET", endpoint, &h, vec![]).await.json()["reports"]).len(),
        1
    );
    for i in 1..=23 {
        let mut next = body.clone();
        next["id"] = json!(format!("{i:08}-1111-4111-8111-111111111111"));
        next["startedAt"] = json!(1000 + i);
        assert_eq!(
            json_request(&s, "POST", endpoint, &h, next).await.status,
            201
        );
    }
    let r = request(&s, "GET", endpoint, &h, vec![]).await.json();
    assert_eq!(array(&r["reports"]).len(), 20);
    assert_eq!(array(&r["reports"]).last().unwrap()["startedAt"], 1023);
    let mut large = body;
    large["padding"] = json!("x".repeat(40_000));
    assert_eq!(
        json_request(&s, "POST", endpoint, &h, large).await.status,
        413
    );
    s.close().await.unwrap();
}

#[tokio::test]
async fn repaired_history_redacts_permanently_deleted_sources_before_reading_survivors() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "alice").await;
    let h = auth("alice", Some(&id));
    let mut socket = Socket::connect(&s, &h, &id).await;
    let doc = new_doc();
    note(&doc, "a", "PRIVATE_ERASED_BODY");
    note(&doc, "b", "Still available");
    socket.send(Kind::Update, encode(&doc)).await;
    socket.boundary(&["a"], 10.).await;
    socket.boundary(&["b"], 10.).await;
    let page = request(&s, "GET", "/api/history?noteId=a", &h, vec![])
        .await
        .json();
    let version = string(&page["versions"][0]["id"]);
    let path = dir
        .path()
        .join("users")
        .join(&id)
        .join("history")
        .join(format!("{}.json", version.split('.').next().unwrap()));
    let original = fs::read(&path).unwrap();
    fs::write(&path, "{broken json").unwrap();
    let detail = format!("/api/history/{version}");
    assert_eq!(request(&s, "GET", &detail, &h, vec![]).await.status, 503);
    tombstone(&doc, "a");
    socket.send(Kind::Update, encode(&doc)).await;
    fs::write(path, original).unwrap();
    let repaired = request(&s, "GET", "/api/history?noteId=b", &h, vec![]).await;
    assert_eq!(repaired.status, 200);
    assert_eq!(array(&repaired.json()["versions"]).len(), 1);
    let export = request(&s, "GET", "/api/history/export", &h, vec![]).await;
    assert!(!contains(&export.bytes, "PRIVATE_ERASED_BODY"));
    assert!(contains(&export.bytes, "Still available"));
    assert_eq!(request(&s, "GET", &detail, &h, vec![]).await.status, 404);
    socket.close().await;
    s.close().await.unwrap();
}
#[tokio::test]
async fn startup_maintenance_uses_durable_grace_and_only_cleans_enabled_accounts() {
    let dir = tempfile::tempdir().unwrap();
    let time = 1_789_171_200_000.;
    let s = start(dir.path(), json!({"now":time})).await;
    let a = identity(&s, "alice").await;
    let b = identity(&s, "bob").await;
    s.close().await.unwrap();
    for (index, id) in [&a, &b].into_iter().enumerate() {
        let mut vault = Vault::open(&dir.path().join("users").join(id), time).unwrap();
        let doc = new_doc();
        note(&doc, "a", "Archived");
        meta(&doc, "a", "archived", json!(true));
        vault.accept(&encode(&doc), time).unwrap();
        vault
            .capture_history(&json!({"sourceIds":["a"],"editedAt":time}), time)
            .unwrap();
        if index == 0 {
            vault.set_retention(true, time).unwrap();
        }
    }
    let time = time + crate::retention::HISTORY_GRACE_MS;
    let s = start(dir.path(), json!({"now":time})).await;
    s.state.run_maintenance().await.unwrap();
    s.close().await.unwrap();
    for (index, id) in [&a, &b].into_iter().enumerate() {
        let vault = Vault::open(&dir.path().join("users").join(id), time).unwrap();
        assert_eq!(vault.history.count().unwrap(), index);
    }
}
#[tokio::test]
async fn startup_never_imports_shared_or_pending_migration_storage() {
    let dir = tempfile::tempdir().unwrap();
    let secret = [7; 32];
    fs::write(dir.path().join("session-secret"), secret).unwrap();
    let shared = new_doc();
    note(&shared, "shared", "Shared note must stay shared");
    let shared_bytes = encode(&shared);
    fs::write(dir.path().join("vault.yjs"), &shared_bytes).unwrap();
    fs::write(
        dir.path().join("legacy-migration.json"),
        "obsolete unreadable metadata",
    )
    .unwrap();
    let a = crate::identity::vault_identity(&secret, crate::identity::AuthMode::Proxy, "alice");
    let b = crate::identity::vault_identity(&secret, crate::identity::AuthMode::Proxy, "bob");
    for (id, body) in [(&a, "Alice existing"), (&b, "Bob existing")] {
        let directory = dir.path().join("users").join(id);
        let mut vault = Vault::open(&directory, 1.).unwrap();
        let doc = new_doc();
        note(&doc, "a", body);
        vault.accept(&encode(&doc), 1.).unwrap();
        fs::write(
            directory.join("legacy-import.json"),
            "obsolete pending metadata",
        )
        .unwrap();
    }
    let next = crate::identity::vault_identity(&secret, crate::identity::AuthMode::Proxy, "new");
    let staging = dir.path().join("users").join(format!(".legacy-{next}"));
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("vault.yjs"), &shared_bytes).unwrap();
    for _ in 0..2 {
        let s = start(dir.path(), json!({})).await;
        for (user, id, body) in [
            ("alice", &a, Some("Alice existing")),
            ("bob", &b, Some("Bob existing")),
            ("new", &next, None),
        ] {
            assert_eq!(identity(&s, user).await, *id);
            let mut socket = Socket::connect(&s, &auth(user, Some(id)), id).await;
            let doc = new_doc();
            socket.sync(&doc).await;
            if let Some(body) = body {
                assert_eq!(field(&doc.transact(), "notes", "a", "body"), body);
            } else {
                assert!(keys(&doc.transact(), "notes").is_empty());
            }
            assert!(get(&doc.transact(), "notes", "shared").is_null());
            socket.close().await;
        }
        s.close().await.unwrap();
    }
    assert_eq!(
        fs::read(dir.path().join("vault.yjs")).unwrap(),
        shared_bytes
    );
    assert_eq!(fs::read(staging.join("vault.yjs")).unwrap(), shared_bytes);
    assert!(
        !dir.path()
            .join("users")
            .join(next)
            .join("legacy-import.json")
            .exists()
    );
    assert!(
        server::start(
            Config::for_test(
                &json!({"port":0,"dataDir":dir.path(),"authMode":"password","password":""})
            )
            .unwrap()
        )
        .await
        .is_err()
    );
}
#[tokio::test]
async fn missing_session_secret_never_rotates_existing_vault_identity() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "alice").await;
    let mut socket = Socket::connect(&s, &auth("alice", Some(&id)), &id).await;
    let doc = new_doc();
    note(&doc, "a", "Do not strand this vault");
    socket.send(Kind::Update, encode(&doc)).await;
    socket.close().await;
    s.close().await.unwrap();
    let path = dir.path().join("session-secret");
    let secret = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    let result = server::start(
        Config::for_test(
            &json!({"port":0,"dataDir":dir.path(),"authMode":"proxy","proxySecret":PROOF}),
        )
        .unwrap(),
    )
    .await;
    assert!(
        result
            .err()
            .unwrap()
            .to_string()
            .contains("session-secret is missing")
    );
    assert!(!path.exists());
    fs::write(path, secret).unwrap();
    let s = start(dir.path(), json!({})).await;
    assert_eq!(identity(&s, "alice").await, id);
    let mut socket = Socket::connect(&s, &auth("alice", Some(&id)), &id).await;
    let restored = new_doc();
    socket.sync(&restored).await;
    assert_eq!(
        field(&restored.transact(), "notes", "a", "body"),
        "Do not strand this vault"
    );
    socket.close().await;
    s.close().await.unwrap();
}
