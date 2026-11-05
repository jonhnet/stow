use super::{api::*, *};
use axum::http::HeaderMap;
use sha2::{Digest, Sha256};

#[tokio::test]
async fn pairing_is_browser_approved_verifier_bound_retryable_and_revocable() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let verifier = "a".repeat(64);
    let started = json_request(
        &s,
        "POST",
        "/native/device/start",
        &HeaderMap::new(),
        json!({"name":"Tablet","challenge":hex::encode(Sha256::digest(verifier.as_bytes()))}),
    )
    .await;
    assert_eq!(started.status, 201);
    let started = started.json();
    let exchange = json!({"requestId":started["requestId"],"verifier":verifier});
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/native/device/token",
            &HeaderMap::new(),
            exchange.clone()
        )
        .await
        .status,
        202
    );
    let approval = json!({"requestId":started["requestId"],"code":started["code"]});
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/api/devices/approve",
            &HeaderMap::new(),
            approval.clone()
        )
        .await
        .status,
        401
    );
    let mut foreign = auth("alice", None);
    foreign.insert("origin", "https://evil.invalid".parse().unwrap());
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/api/devices/approve",
            &foreign,
            approval.clone()
        )
        .await
        .status,
        403
    );
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/api/devices/approve",
            &auth("alice", None),
            approval.clone()
        )
        .await
        .status,
        200
    );
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/api/devices/approve",
            &auth("bob", None),
            approval
        )
        .await
        .status,
        409
    );
    let mut wrong = exchange.clone();
    wrong["verifier"] = json!("b".repeat(64));
    assert_eq!(
        json_request(&s, "POST", "/native/device/token", &HeaderMap::new(), wrong)
            .await
            .status,
        403
    );
    let paired = json_request(
        &s,
        "POST",
        "/native/device/token",
        &HeaderMap::new(),
        exchange.clone(),
    )
    .await;
    assert_eq!(
        paired.status,
        200,
        "{}",
        String::from_utf8_lossy(&paired.bytes)
    );
    let paired = paired.json();
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/native/device/token",
            &HeaderMap::new(),
            exchange.clone()
        )
        .await
        .json(),
        paired,
        "Retry after lost response returns the same grant"
    );
    let mut h = HeaderMap::new();
    h.insert(
        "authorization",
        format!("StowDevice {}", string(&paired["token"]))
            .parse()
            .unwrap(),
    );
    let identity = request(&s, "GET", "/native/api/session", &h, vec![]).await;
    assert_eq!(identity.status, 200);
    assert_eq!(identity.json()["vaultId"], paired["account"]["vaultId"]);
    assert_eq!(identity.json()["user"], "alice");
    assert_eq!(
        request(&s, "GET", "/native/api/session", &auth("bob", None), vec![])
            .await
            .status,
        401,
        "Proxy identity cannot authorize native route"
    );
    h.insert("x-stow-vault", "different-vault-id-12345".parse().unwrap());
    assert_eq!(
        request(&s, "GET", "/native/api/storage", &h, vec![])
            .await
            .status,
        409
    );
    assert_eq!(
        request(&s, "GET", "/api/devices", &h, vec![]).await.status,
        403,
        "Device cannot manage credentials"
    );
    assert_eq!(
        request(&s, "GET", "/api/devices", &auth("bob", None), vec![])
            .await
            .json()["devices"],
        json!([])
    );
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/api/devices/revoke",
            &auth("bob", None),
            json!({"deviceId":paired["deviceId"]})
        )
        .await
        .status,
        200
    );
    assert_eq!(
        request(&s, "GET", "/native/api/session", &h, vec![])
            .await
            .status,
        200,
        "Another user cannot revoke this grant"
    );
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/api/devices/revoke",
            &auth("alice", None),
            json!({"deviceId":paired["deviceId"]})
        )
        .await
        .status,
        200
    );
    assert_eq!(
        request(&s, "GET", "/native/api/session", &h, vec![])
            .await
            .status,
        401
    );
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/native/device/token",
            &HeaderMap::new(),
            exchange
        )
        .await
        .status,
        410
    );
    s.close().await.unwrap();
}

#[tokio::test]
async fn pairing_expires_and_credentials_survive_server_restart() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let verifier = "c".repeat(64);
    let p = json_request(
        &s,
        "POST",
        "/native/device/start",
        &HeaderMap::new(),
        json!({"name":"Phone","challenge":hex::encode(Sha256::digest(verifier.as_bytes()))}),
    )
    .await
    .json();
    json_request(
        &s,
        "POST",
        "/api/devices/approve",
        &auth("alice", None),
        json!({"requestId":p["requestId"],"code":p["code"]}),
    )
    .await;
    let grant = json_request(
        &s,
        "POST",
        "/native/device/token",
        &HeaderMap::new(),
        json!({"requestId":p["requestId"],"verifier":verifier}),
    )
    .await
    .json();
    s.close().await.unwrap();
    let path = dir.path().join("device-access.json");
    let mut saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    saved["pending"][string(&p["requestId"])]["expires_at"] = json!(0);
    fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
    let s = start(dir.path(), json!({})).await;
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/native/device/token",
            &HeaderMap::new(),
            json!({"requestId":p["requestId"],"verifier":verifier})
        )
        .await
        .status,
        410
    );
    let mut h = HeaderMap::new();
    h.insert(
        "cookie",
        format!("stow_device={}", string(&grant["token"]))
            .parse()
            .unwrap(),
    );
    assert_eq!(
        request(&s, "GET", "/native/api/session", &h, vec![])
            .await
            .json()["user"],
        "alice"
    );
    s.close().await.unwrap();
}

#[tokio::test]
async fn revocation_closes_native_socket_and_incarnation_change_rejects_old_device() {
    use futures_util::StreamExt;
    use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let verifier = "d".repeat(64);
    let pairing = json_request(
        &s,
        "POST",
        "/native/device/start",
        &HeaderMap::new(),
        json!({"name":"Closed app","challenge":hex::encode(Sha256::digest(verifier.as_bytes()))}),
    )
    .await
    .json();
    json_request(
        &s,
        "POST",
        "/api/devices/approve",
        &auth("alice", None),
        json!({"requestId":pairing["requestId"],"code":pairing["code"]}),
    )
    .await;
    let grant = json_request(
        &s,
        "POST",
        "/native/device/token",
        &HeaderMap::new(),
        json!({"requestId":pairing["requestId"],"verifier":verifier}),
    )
    .await
    .json();
    let vault = string(&grant["account"]["vaultId"]);
    let mut req = format!(
        "ws://{}/native/sync?schema={CURRENT_SCHEMA}&protocol={SYNC_PROTOCOL}&vaultId={vault}",
        s.address
    )
    .into_client_request()
    .unwrap();
    req.headers_mut().insert(
        "cookie",
        format!("stow_device={}", string(&grant["token"]))
            .parse()
            .unwrap(),
    );
    let (mut socket, _) = connect_async(req).await.unwrap();
    // A missing release resource is a real 404, never the application's HTML.
    assert_eq!(
        request(
            &s,
            "GET",
            "/native/assets/absent.js",
            &HeaderMap::new(),
            vec![]
        )
        .await
        .status,
        404
    );
    // Create the account's storage, then preserve the registry to independently
    // test incarnation invalidation after the revocation assertion.
    request(
        &s,
        "GET",
        "/api/storage",
        &auth("alice", Some(vault)),
        vec![],
    )
    .await;
    let registry = fs::read(dir.path().join("device-access.json")).unwrap();
    json_request(
        &s,
        "POST",
        "/api/devices/revoke",
        &auth("alice", None),
        json!({"deviceId":grant["deviceId"]}),
    )
    .await;
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while let Some(Ok(message)) = socket.next().await {
            if message.is_close() {
                break;
            }
        }
    })
    .await
    .expect("Revocation must close an already-open socket");
    s.close().await.unwrap();
    fs::write(dir.path().join("device-access.json"), registry).unwrap();
    crate::account_reset::reset(&json!({"dataDir":dir.path(),"user":"alice","expectedVaultId":vault,"apply":true,"serverStopped":true})).unwrap();
    let s = start(dir.path(), json!({})).await;
    let mut h = HeaderMap::new();
    h.insert(
        "cookie",
        format!("stow_device={}", string(&grant["token"]))
            .parse()
            .unwrap(),
    );
    assert_eq!(
        request(&s, "GET", "/native/api/session", &h, vec![])
            .await
            .status,
        401
    );
    assert_ne!(identity(&s, "alice").await, vault);
    s.close().await.unwrap();
}

#[tokio::test]
async fn android_publication_survives_web_replacement_without_exposing_other_data() {
    let dir = tempfile::tempdir().unwrap();
    let web = tempfile::tempdir().unwrap();
    fs::write(
        web.path().join("release.json"),
        json!({"format":1,"release":"first","files":{},"android":null}).to_string(),
    )
    .unwrap();
    let s = start(dir.path(), json!({"staticDir":web.path()})).await;
    let headers = HeaderMap::new();
    assert!(
        request(&s, "GET", "/native/release.json", &headers, vec![])
            .await
            .json()["android"]
            .is_null()
    );
    let published = dir.path().join("android-release");
    fs::create_dir(&published).unwrap();
    fs::write(published.join("stow-2.apk"), b"an apk").unwrap();
    let metadata =
        json!({"version":2,"minSdk":28,"url":"/native/android/stow-2.apk","sha256":"a".repeat(64)});
    fs::write(published.join("release.json"), metadata.to_string()).unwrap();
    fs::write(
        web.path().join("release.json"),
        json!({"format":1,"release":"second","files":{},"android":null}).to_string(),
    )
    .unwrap();
    let manifest = request(&s, "GET", "/native/release.json", &headers, vec![]).await;
    assert_eq!(manifest.json()["release"], "second");
    assert_eq!(manifest.json()["android"], metadata);
    // Settings uses the API route allowed by existing installed WebViews.
    // It returns the same fresh publication, with normal browser/device auth.
    let verifier = "f".repeat(64);
    let pairing = json_request(&s, "POST", "/native/device/start", &headers,
        json!({"name":"Settings test","challenge":hex::encode(Sha256::digest(verifier.as_bytes()))})).await.json();
    assert_eq!(
        json_request(
            &s,
            "POST",
            "/api/devices/approve",
            &auth("alice", None),
            json!({"requestId":pairing["requestId"],"code":pairing["code"]})
        )
        .await
        .status,
        200
    );
    let grant = json_request(
        &s,
        "POST",
        "/native/device/token",
        &headers,
        json!({"requestId":pairing["requestId"],"verifier":verifier}),
    )
    .await
    .json();
    let mut native = HeaderMap::new();
    native.insert(
        "authorization",
        format!("StowDevice {}", string(&grant["token"]))
            .parse()
            .unwrap(),
    );
    for (path, credentials) in [
        ("/api/release", auth("alice", None)),
        ("/native/api/release", native),
    ] {
        let checked = request(&s, "GET", path, &credentials, vec![]).await;
        assert_eq!(checked.status, 200);
        assert_eq!(checked.json(), manifest.json());
        assert_eq!(checked.headers["cache-control"], "no-store");
        assert_eq!(request(&s, "GET", path, &headers, vec![]).await.status, 401);
        let mut foreign = credentials;
        foreign.insert("origin", "https://foreign.invalid".parse().unwrap());
        assert_eq!(request(&s, "GET", path, &foreign, vec![]).await.status, 403);
    }
    assert_eq!(
        request(&s, "GET", "/native/android/stow-2.apk", &headers, vec![])
            .await
            .bytes,
        b"an apk"
    );
    assert_eq!(
        request(
            &s,
            "GET",
            "/native/android/%2e%2e/session-secret",
            &headers,
            vec![]
        )
        .await
        .status,
        404
    );
    fs::remove_file(published.join("stow-2.apk")).unwrap();
    assert_eq!(
        request(&s, "GET", "/native/release.json", &headers, vec![])
            .await
            .status,
        503,
        "A broken publication must not silently disappear"
    );
    s.close().await.unwrap();
}
