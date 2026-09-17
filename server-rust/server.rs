use crate::storage::DurableUpdate;
use crate::{
    account_metadata, account_reset,
    cache::{Cache, Lease},
    crdt::{CURRENT_SCHEMA, Ids},
    history_state,
    transfer::{self, Budget, Kind, Transfer, Unit},
};
use crate::{
    crdt::{array, string, strings},
    diagnostics,
    error::{Error, Result},
    identity::{self, AuthMode, single_header},
    images, policy,
    retention::HISTORY_SCAN_MS,
    storage::{Vault, atomic_write, mkdir_durable, read_optional},
};
use axum::serve::ListenerExt;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{
        ConnectInfo, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{net::TcpListener, sync::mpsc, task::JoinHandle};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use yrs::{StateVector, updates::decoder::Decode};
pub const MAX_UPDATE: usize = transfer::MAX;
pub const MAX_BLOB: usize = 20 * 1024 * 1024;
const SESSION_SECONDS: u64 = 30 * 24 * 60 * 60;
pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}

pub struct Config {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    pub password: String,
    pub auth_mode: AuthMode,
    pub proxy_secret: String,
    pub public_origin: Option<String>,
    fixed_now: Option<f64>,
}
pub(crate) fn resolve(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut clean = PathBuf::new();
    for part in absolute.components() {
        match part {
            std::path::Component::ParentDir => {
                clean.pop();
            }
            std::path::Component::CurDir => {}
            part => clean.push(part.as_os_str()),
        }
    }
    // Resolve existing ancestors as well: a symlink into build/ is still disposable storage.
    let mut suffix = Vec::new();
    let mut ancestor = clean.as_path();
    while !ancestor.exists() {
        if let Some(name) = ancestor.file_name() {
            suffix.push(name.to_os_string());
        } else {
            break;
        }
        ancestor = ancestor.parent().unwrap_or(Path::new("/"));
    }
    let mut result = std::fs::canonicalize(ancestor)?;
    for name in suffix.into_iter().rev() {
        result.push(name);
    }
    Ok(result)
}
impl Config {
    pub fn from_env() -> Result<Self> {
        Self::configure(&Value::Null, false)
    }
    #[cfg(any(test, feature = "test-support"))]
    pub fn for_test(options: &Value) -> Result<Self> {
        Self::configure(options, true)
    }
    pub(crate) fn configure(options: &Value, test: bool) -> Result<Self> {
        let setting = |key: &str, env: &str, default: &str| {
            options[key]
                .as_str()
                .map(str::to_owned)
                .or_else(|| std::env::var(env).ok())
                .unwrap_or_else(|| default.into())
        };
        let source = resolve(Path::new(env!("CARGO_MANIFEST_DIR")))?;
        let workspace = source
            .parent()
            .ok_or_else(|| Error::invalid("Missing workspace"))?;
        let build = workspace.join("build");
        let data_dir = resolve(Path::new(&setting(
            "dataDir",
            "DATA_DIR",
            &workspace.join("data").to_string_lossy(),
        )))?;
        let static_dir = resolve(Path::new(&setting(
            "staticDir",
            "STOW_STATIC_DIR",
            &build.join("dist").to_string_lossy(),
        )))?;
        let fixture = test && options["dataDir"].is_string();
        if !fixture && data_dir.starts_with(&source) {
            return Err(Error::invalid(
                "DATA_DIR must be outside the source repository; keep persistent data beside it.",
            ));
        }
        if !fixture && data_dir.starts_with(&build) {
            return Err(Error::invalid(
                "DATA_DIR must be outside build/; that directory contains disposable artifacts.",
            ));
        }
        if data_dir.starts_with(&static_dir) {
            return Err(Error::invalid(
                "DATA_DIR must be outside the frontend static directory.",
            ));
        }
        let host = setting("host", "HOST", "127.0.0.1");
        let password = setting("password", "STOW_PASSWORD", "");
        let proxy_secret = setting("proxySecret", "STOW_PROXY_SECRET", "");
        let auth_mode = match setting("authMode", "STOW_AUTH_MODE", "password").as_str() {
            "password" => AuthMode::Password,
            "proxy" => AuthMode::Proxy,
            _ => return Err(Error::invalid("STOW_AUTH_MODE must be password or proxy.")),
        };
        if auth_mode == AuthMode::Proxy && proxy_secret.encode_utf16().count() < 32 {
            return Err(Error::invalid(
                "Proxy mode requires STOW_PROXY_SECRET with at least 32 characters.",
            ));
        }
        let allow_insecure = options["allowInsecure"]
            .as_bool()
            .unwrap_or_else(|| std::env::var("STOW_ALLOW_INSECURE").is_ok_and(|s| s == "true"));
        if auth_mode == AuthMode::Password
            && !["127.0.0.1", "::1", "localhost"].contains(&host.as_str())
            && password.is_empty()
            && !allow_insecure
        {
            return Err(Error::invalid(
                "Set STOW_PASSWORD before listening beyond loopback, or explicitly set STOW_ALLOW_INSECURE=true.",
            ));
        }
        let port = if let Some(p) = options.get("port") {
            p.as_u64()
                .and_then(|v| u16::try_from(v).ok())
                .ok_or_else(|| Error::invalid("Invalid PORT"))?
        } else {
            setting("port", "PORT", "3001")
                .parse()
                .map_err(|_| Error::invalid("Invalid PORT"))?
        };
        let origin = setting("origin", "STOW_ORIGIN", "");
        let public_origin = if origin.is_empty() {
            None
        } else {
            let parsed =
                url::Url::parse(&origin).map_err(|_| Error::invalid("Invalid STOW_ORIGIN"))?;
            if !["http", "https"].contains(&parsed.scheme()) {
                return Err(Error::invalid("Invalid STOW_ORIGIN"));
            }
            Some(parsed.origin().ascii_serialization())
        };
        Ok(Self {
            host,
            port,
            data_dir,
            static_dir,
            password,
            auth_mode,
            proxy_secret,
            public_origin,
            fixed_now: if test { options["now"].as_f64() } else { None },
        })
    }
}
#[derive(Clone)]
struct Principal {
    user: String,
    vault_id: String,
}
struct Attempt {
    count: u32,
    reset_at: f64,
}
struct Report {
    vault_id: String,
    report: Value,
}
#[derive(Clone)]
struct Client {
    sender: mpsc::Sender<Unit>,
    queued: Arc<AtomicUsize>,
    slow: CancellationToken,
    budget: Budget,
}
impl Client {
    fn send(&self, kind: Kind, data: Vec<u8>) {
        let optional = kind.optional();
        let unit = Unit::new(kind, data.into(), &self.budget, self.queued.clone());
        let result = unit.and_then(|unit| {
            self.sender
                .try_send(unit)
                .map_err(|_| transfer::Failure::new("retry", "Sync is falling behind."))
        });
        if result.is_err() && !optional {
            self.slow.cancel();
        }
    }
    fn update(&self, accepted: &DurableUpdate) {
        self.send(Kind::Update, accepted.bytes().to_vec());
    }
    fn notice(&self, message: Value) {
        self.send(
            if message["type"] == "history-failure" {
                Kind::HistoryFailure
            } else {
                Kind::HistoryChanged
            },
            message.to_string().into_bytes(),
        );
    }
}
struct Account {
    vault: Vault,
    clients: BTreeMap<u64, Client>,
    slots: Arc<tokio::sync::Semaphore>,
}
impl Account {
    fn notice(&self, message: Value) {
        for c in self.clients.values() {
            c.notice(message.clone());
        }
    }
    fn broadcast(&self, accepted: &DurableUpdate, except: Option<u64>) {
        for (id, c) in &self.clients {
            if Some(*id) != except {
                c.update(accepted);
            }
        }
    }
}
pub struct ServerState {
    config: Config,
    secret: Vec<u8>,
    vaults: Cache<Account>,
    incarnations: account_reset::Incarnations,
    metadata_lock: Mutex<()>,
    transfer_budget: Budget,
    failures: Mutex<HashMap<String, Attempt>>,
    reports: Mutex<Vec<Report>>,
    shutdown: CancellationToken,
    connections: TaskTracker,
    next_client: AtomicU64,
    maintenance: tokio::sync::Mutex<()>,
}
impl ServerState {
    fn time(&self) -> f64 {
        self.config.fixed_now.unwrap_or_else(now)
    }
    fn required(&self) -> bool {
        self.config.auth_mode == AuthMode::Proxy || !self.config.password.is_empty()
    }
    fn password_id(&self) -> String {
        identity::vault_identity(&self.secret, AuthMode::Password, "owner")
    }
    fn sign(&self, value: &str) -> String {
        URL_SAFE_NO_PAD.encode(identity::mac(
            &self.secret,
            &[self.config.password.as_bytes(), b"\0", value.as_bytes()],
        ))
    }
    fn origin_allowed(&self, headers: &HeaderMap) -> bool {
        if !headers.contains_key("origin") {
            return true;
        }
        let Some(origin) = single_header(headers, "origin") else {
            return false;
        };
        let Ok(parsed) = url::Url::parse(origin) else {
            return false;
        };
        if !["http", "https"].contains(&parsed.scheme())
            || parsed.origin().ascii_serialization() != origin
        {
            return false;
        }
        if let Some(expected) = &self.config.public_origin {
            origin == expected
        } else {
            let host = &origin[parsed.scheme().len() + 3..];
            single_header(headers, "host") == Some(host)
        }
    }
    fn authenticate(&self, headers: &HeaderMap) -> Result<Principal> {
        if self.config.auth_mode == AuthMode::Proxy {
            let user = identity::proxy_identity(headers, &self.config.proxy_secret)?;
            let vault_id =
                account_reset::resolve(&self.secret, AuthMode::Proxy, &user, &self.incarnations);
            return Ok(Principal { user, vault_id });
        }
        if !self.config.password.is_empty() {
            let cookie = single_header(headers, "cookie").and_then(|s| {
                s.split(';')
                    .map(str::trim)
                    .find_map(|v| v.strip_prefix("stow_session="))
            });
            let authenticated = cookie.filter(|v| v.len() <= 512).is_some_and(|value| {
                let parts: Vec<_> = value.split('.').collect();
                if parts.len() != 3 || parts[1].is_empty() {
                    return false;
                }
                let Ok(expiry) = parts[0].parse::<f64>() else {
                    return false;
                };
                let now = now();
                expiry.is_finite()
                    && expiry > now
                    && expiry <= now + SESSION_SECONDS as f64 * 1000.0
                    && identity::same_secret(
                        parts[2],
                        &self.sign(&format!("{}.{}", parts[0], parts[1])),
                    )
            });
            if !authenticated {
                return Err(Error::request(401, "Sign in to continue"));
            }
        }
        Ok(Principal {
            user: "Personal vault".into(),
            vault_id: self.password_id(),
        })
    }
    fn session(&self, p: &Principal) -> Value {
        json!({"authenticated":true,"required":self.required(),"authMode":self.config.auth_mode,"user":p.user,"vaultId":p.vault_id})
    }
    fn password_session(&self) -> Value {
        self.session(&Principal {
            user: "Personal vault".into(),
            vault_id: self.password_id(),
        })
    }
    fn bind(&self, headers: &HeaderMap, p: &Principal) -> Result<()> {
        if single_header(headers, "x-stow-vault") != Some(p.vault_id.as_str()) {
            Err(Error::Request {
                status: 409,
                message: "Vault identity changed; reload before accessing this vault.".into(),
                code: Some("vault_mismatch"),
            })
        } else {
            Ok(())
        }
    }
    fn account_directory(&self, id: &str) -> PathBuf {
        if self.config.auth_mode == AuthMode::Password {
            self.config.data_dir.clone()
        } else {
            self.config.data_dir.join("users").join(id)
        }
    }
    // Serialize first publication independently of the vault cache: session
    // checks can identify an existing vault even when its CRDT cannot open.
    fn record_account(&self, principal: &Principal, create: bool) -> Result<()> {
        let _guard = self
            .metadata_lock
            .lock()
            .map_err(|_| Error::invalid("Account metadata unavailable"))?;
        let directory = self.account_directory(&principal.vault_id);
        match std::fs::metadata(&directory) {
            Ok(metadata) if metadata.is_dir() => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !create {
                    return Ok(());
                }
                mkdir_durable(&directory)?;
            }
            Err(error) => return Err(error.into()),
            _ => return Err(Error::invalid("Account vault is not a directory")),
        }
        let user = match self.config.auth_mode {
            AuthMode::Proxy => principal.user.as_str(),
            AuthMode::Password => "owner",
        };
        account_metadata::record(&directory, user, self.config.auth_mode, &principal.vault_id)
    }
    fn owned_account(&self, principal: &Principal) -> Result<Lease<Account>> {
        self.record_account(principal, true)?;
        self.account(&principal.vault_id)
    }
    fn account(&self, id: &str) -> Result<Lease<Account>> {
        self.vaults.acquire(id, || {
            let directory = self.account_directory(id);
            Ok(Account {
                vault: Vault::open(&directory, self.time())?,
                clients: BTreeMap::new(),
                slots: Arc::new(tokio::sync::Semaphore::new(16)),
            })
        })
    }
    async fn with_account<T: Send + 'static>(
        self: &Arc<Self>,
        id: String,
        operation: impl FnOnce(&mut Account) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let state = self.clone();
        tokio::task::spawn_blocking(move || {
            let account = state.account(&id)?;
            let mut account = account
                .lock()
                .map_err(|_| Error::invalid("Vault unavailable"))?;
            operation(&mut account)
        })
        .await
        .map_err(|e| Error::invalid(format!("Vault worker failed: {e}")))?
    }
    async fn with_owned_account<T: Send + 'static>(
        self: &Arc<Self>,
        principal: Principal,
        operation: impl FnOnce(&mut Account) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let state = self.clone();
        tokio::task::spawn_blocking(move || {
            let account = state.owned_account(&principal)?;
            let mut account = account
                .lock()
                .map_err(|_| Error::invalid("Vault unavailable"))?;
            operation(&mut account)
        })
        .await
        .map_err(|e| Error::invalid(format!("Vault worker failed: {e}")))?
    }
    fn account_owner(&self, id: &str) -> String {
        match account_metadata::read(&self.account_directory(id)) {
            Ok(Some(metadata))
                if metadata.vault_id == id
                    && metadata.auth_mode == self.config.auth_mode
                    && account_reset::resolve(
                        &self.secret,
                        metadata.auth_mode,
                        &metadata.user,
                        &self.incarnations,
                    ) == id =>
            {
                format!("owner {:?} ({:?})", metadata.user, metadata.auth_mode)
            }
            Ok(Some(_)) => "owner unknown; account.json does not match this vault".into(),
            Ok(None) => "owner unknown".into(),
            Err(error) => format!("owner unknown; {error}"),
        }
    }
    pub async fn run_maintenance(self: &Arc<Self>) -> Result<()> {
        let _guard = self.maintenance.lock().await;
        let ids = if self.config.auth_mode == AuthMode::Password {
            vec![self.password_id()]
        } else {
            match std::fs::read_dir(self.config.data_dir.join("users")) {
                Ok(entries) => entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|id| policy::is_hash(id))
                    .collect(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
                Err(e) => return Err(e.into()),
            }
        };
        for id in ids {
            if self.shutdown.is_cancelled() {
                break;
            }
            let time = self.time();
            let directory = self.account_directory(&id);
            if let Err(error) = self
                .with_account(id.clone(), move |account| {
                    if let Some(clean) = account.vault.sweep(time)? {
                        account
                            .notice(json!({"type":"history-changed","sourceIds":clean.source_ids}));
                    }
                    Ok(())
                })
                .await
            {
                let owner = self.account_owner(&id);
                eprintln!(
                    "Stow could not complete archived-history maintenance for vault {directory:?} ({owner}): {error}"
                );
            }
        }
        Ok(())
    }
}
pub struct Running {
    pub address: SocketAddr,
    pub state: Arc<ServerState>,
    task: JoinHandle<Result<()>>,
}
impl Running {
    pub async fn close(self) -> Result<()> {
        self.state.vaults.stop();
        self.state.shutdown.cancel();
        self.task.await.map_err(|e| Error::invalid(e.to_string()))?
    }
}
pub async fn start(config: Config) -> Result<Running> {
    images::verify_codecs().await?;
    mkdir_durable(&config.data_dir)?;
    let has_users = match std::fs::read_dir(config.data_dir.join("users")) {
        Ok(mut v) => v.next().transpose()?.is_some(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.into()),
    };
    if config.auth_mode == AuthMode::Password && has_users {
        return Err(Error::invalid(
            "This data directory contains user vault data. Password mode would reopen a stale shared vault; use proxy mode.",
        ));
    }
    let secret_path = config.data_dir.join("session-secret");
    let secret = match read_optional(&secret_path)? {
        Some(v) => v,
        None => {
            if has_users {
                return Err(Error::invalid(
                    "session-secret is missing from an existing installation. Restore it from backup to preserve user vault identities.",
                ));
            }
            let v = rand::random::<[u8; 32]>().to_vec();
            atomic_write(&secret_path, &v)?;
            v
        }
    };
    if secret.len() != 32 {
        return Err(Error::invalid("Invalid session-secret file"));
    }
    let incarnations = account_reset::load(&config.data_dir)?;
    let state = Arc::new(ServerState {
        config,
        secret,
        vaults: Cache::default(),
        incarnations,
        metadata_lock: Mutex::new(()),
        transfer_budget: Budget::default(),
        failures: Mutex::new(HashMap::new()),
        reports: Mutex::new(Vec::new()),
        shutdown: CancellationToken::new(),
        connections: TaskTracker::new(),
        next_client: AtomicU64::new(1),
        maintenance: tokio::sync::Mutex::new(()),
    });
    if state.config.auth_mode == AuthMode::Password {
        state
            .with_owned_account(
                Principal {
                    user: "owner".into(),
                    vault_id: state.password_id(),
                },
                |_| Ok(()),
            )
            .await?;
    }
    state.run_maintenance().await?;
    let listener = TcpListener::bind((state.config.host.as_str(), state.config.port)).await?;
    let address = listener.local_addr()?;
    let app = Router::new()
        .route("/sync", get(upgrade))
        .fallback(http_handler)
        .with_state(state.clone());
    let stop = state.shutdown.clone();
    let worker = state.clone();
    let task = tokio::spawn(async move {
        let timer_state = worker.clone();
        let timer = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(HISTORY_SCAN_MS));
            interval.tick().await;
            let mut eviction = tokio::time::interval(Duration::from_secs(30));
            loop {
                tokio::select! { _=timer_state.shutdown.cancelled()=>break,_=eviction.tick()=>{let _=timer_state.vaults.evict();},_=interval.tick()=>{if let Err(e)=timer_state.run_maintenance().await { eprintln!("Stow maintenance failed: {e}"); }} }
            }
        });
        let result = axum::serve(
            // Protocol 2 alternates small credit/commit controls with binary
            // frames. Nagle plus delayed TCP ACKs otherwise adds a delay to
            // each exchange, putting best-effort history hints behind edits.
            listener.tap_io(|stream| {
                if let Err(error) = stream.set_nodelay(true) {
                    eprintln!("Could not enable TCP_NODELAY for sync: {error}");
                }
            }),
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(stop.cancelled_owned())
        .await;
        worker.shutdown.cancel();
        let _ = timer.await;
        worker.connections.close();
        worker.connections.wait().await;
        worker.vaults.close();
        result.map_err(Error::from)
    });
    Ok(Running {
        address,
        state,
        task,
    })
}
async fn body_json(request: Request<Body>, limit: usize) -> Result<Value> {
    let bytes = body_bytes(request, limit).await?;
    serde_json::from_slice(&bytes).map_err(|_| Error::request(400, "Invalid request"))
}
async fn body_bytes(request: Request<Body>, limit: usize) -> Result<Vec<u8>> {
    to_bytes(request.into_body(), limit)
        .await
        .map(|v| v.to_vec())
        .map_err(|_| Error::request(413, "Attachment or request is too large"))
}
fn json_response(status: u16, value: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        axum::Json(value),
    )
        .into_response()
}

const SYNC_PROTOCOL: &str = "3";

fn client_update_required() -> Value {
    json!({
        "code": "client_update_required",
        "message": "This version of Stow can no longer sync with the server. Reload Stow to update. Your locally saved edits will be kept.",
        "action": "reload",
        "target": format!("{CURRENT_SCHEMA}/{SYNC_PROTOCOL}")
    })
}
fn set_header(response: &mut Response, key: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        response.headers_mut().insert(key, value);
    }
}
async fn http_handler(
    State(state): State<Arc<ServerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    request: Request<Body>,
) -> Response {
    let api = request.uri().path() == "/api" || request.uri().path().starts_with("/api/");
    let head = request.method() == Method::HEAD;
    let mut response = match handle_http(state, remote, request).await {
        Ok(v) => v,
        Err(e) => e.into_response(),
    };
    set_header(&mut response, "x-content-type-options", "nosniff");
    set_header(&mut response, "referrer-policy", "same-origin");
    set_header(&mut response, "x-frame-options", "DENY");
    if api {
        set_header(&mut response, "cache-control", "no-store");
    }
    if head {
        *response.body_mut() = Body::empty();
    }
    response
}
async fn handle_http(
    state: Arc<ServerState>,
    remote: SocketAddr,
    request: Request<Body>,
) -> Result<Response> {
    let query = request.uri().query().unwrap_or("").to_owned();
    let path = request.uri().path().trim_end_matches('/').to_owned();
    let method = request.method().clone();
    let headers = request.headers().clone();
    if path != "/api" && !path.starts_with("/api/") {
        return static_file(&state.config.static_dir, &path, &method).await;
    }
    if !state.origin_allowed(&headers) {
        return Err(Error::request(403, "Origin is not allowed"));
    }
    let read = method == Method::GET || method == Method::HEAD;
    if path == "/api/health" && read {
        return Ok(json_response(200, json!({"ok":true})));
    }
    if path == "/api/session" && read {
        let mut response = match state.authenticate(&headers) {
            Ok(p) => {
                let mut value = state.session(&p);
                // Browsers cannot read a rejected WebSocket handshake's body.
                // Return its actionable reason during authenticated preflight,
                // before opening any account storage. Headerless callers only
                // request identity; WebSocket admission still checks versions.
                if (headers.contains_key("x-stow-sync-protocol")
                    || headers.contains_key("x-stow-schema"))
                    && (single_header(&headers, "x-stow-sync-protocol") != Some(SYNC_PROTOCOL)
                        || single_header(&headers, "x-stow-schema") != Some(CURRENT_SCHEMA))
                {
                    value["syncRejection"] = client_update_required();
                } else {
                    let copy = state.clone();
                    tokio::task::spawn_blocking(move || copy.record_account(&p, false))
                        .await
                        .map_err(|e| {
                            Error::invalid(format!("Account metadata worker failed: {e}"))
                        })??;
                }
                json_response(200, value)
            }
            Err(e) => {
                let proxy = state.config.auth_mode == AuthMode::Proxy;
                let status = if proxy {
                    match e {
                        Error::Request { status, .. } => status,
                        _ => 401,
                    }
                } else {
                    200
                };
                let mut value = json!({"authenticated":false,"required":state.required(),"authMode":state.config.auth_mode});
                if proxy {
                    value["error"] = json!(e.to_string());
                }
                json_response(status, value)
            }
        };
        set_header(&mut response, "server-timing", "session;dur=0");
        return Ok(response);
    }
    if path == "/api/login" && method == Method::POST {
        if state.config.auth_mode == AuthMode::Proxy {
            return Err(Error::request(
                405,
                "Sign in through the authenticating proxy.",
            ));
        }
        let body = body_json(request, 4096).await?;
        let time = now();
        let remote = remote.ip().to_string();
        let mut failures = state
            .failures
            .lock()
            .map_err(|_| Error::invalid("Login state unavailable"))?;
        if let Some(attempt) = failures.get(&remote)
            && attempt.reset_at > time
            && attempt.count >= 10
        {
            let mut response = json_response(
                429,
                json!({"error":"Too many attempts. Try again shortly."}),
            );
            set_header(
                &mut response,
                "retry-after",
                &((attempt.reset_at - time) / 1000.0).ceil().to_string(),
            );
            return Ok(response);
        }
        if !state.config.password.is_empty()
            && (!body["password"].is_string()
                || !identity::same_secret(string(&body["password"]), &state.config.password))
        {
            failures.retain(|_, a| a.reset_at > time);
            let attempt = failures.entry(remote).or_insert(Attempt {
                count: 0,
                reset_at: time + 60_000.0,
            });
            attempt.count += 1;
            return Err(Error::request(401, "Incorrect password"));
        }
        failures.remove(&remote);
        let value = format!(
            "{}.{}",
            time as u64 + SESSION_SECONDS * 1000,
            URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>())
        );
        let cookie = format!(
            "stow_session={value}.{}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECONDS}{}",
            state.sign(&value),
            if state
                .config
                .public_origin
                .as_ref()
                .is_some_and(|s| s.starts_with("https:"))
            {
                "; Secure"
            } else {
                ""
            }
        );
        let mut response = json_response(200, state.password_session());
        set_header(&mut response, "set-cookie", &cookie);
        return Ok(response);
    }
    if path == "/api/logout" && method == Method::POST {
        if state.config.auth_mode == AuthMode::Proxy {
            return Err(Error::request(
                405,
                "Sign out through the authenticating proxy.",
            ));
        }
        let mut response = json_response(
            200,
            if state.config.password.is_empty() {
                state.password_session()
            } else {
                json!({"authenticated":false,"required":state.required(),"authMode":state.config.auth_mode})
            },
        );
        set_header(
            &mut response,
            "set-cookie",
            "stow_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        );
        return Ok(response);
    }
    let principal = state.authenticate(&headers)?;
    if path == "/api/diagnostics/startup" {
        state.bind(&headers, &principal)?;
        if method == Method::POST {
            let report = diagnostics::parse(body_json(request, 32768).await?)?;
            let id = report["id"].clone();
            let mut report = report;
            report["receivedAt"] = json!(chrono::Utc::now().to_rfc3339());
            report["browser"] = json!(
                single_header(&headers, "user-agent")
                    .unwrap_or("")
                    .chars()
                    .take(300)
                    .collect::<String>()
            );
            let mut recent = state
                .reports
                .lock()
                .map_err(|_| Error::invalid("Diagnostics unavailable"))?;
            recent.retain(|e| e.vault_id != principal.vault_id || e.report["id"] != id);
            recent.push(Report {
                vault_id: principal.vault_id,
                report,
            });
            if recent.len() > 100 {
                recent.remove(0);
            }
            return Ok(json_response(201, json!({"id":id})));
        }
        if read {
            let recent = state
                .reports
                .lock()
                .map_err(|_| Error::invalid("Diagnostics unavailable"))?;
            let mut reports: Vec<_> = recent
                .iter()
                .rev()
                .filter(|e| e.vault_id == principal.vault_id)
                .take(20)
                .map(|e| e.report.clone())
                .collect();
            reports.reverse();
            return Ok(json_response(200, json!({"reports":reports})));
        }
    }
    if path == "/api/storage" || path.starts_with("/api/history") || path.starts_with("/api/blobs")
    {
        state.bind(&headers, &principal)?;
    }
    let time = state.time();
    if path == "/api/storage" && read {
        return Ok(json_response(
            200,
            state
                .with_owned_account(principal, |a| a.vault.storage())
                .await?,
        ));
    }
    if path == "/api/history" && read {
        let pairs: Vec<_> = url::form_urlencoded::parse(query.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let single = |name: &str| -> Result<Option<String>> {
            let values: Vec<_> = pairs
                .iter()
                .filter(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
                .collect();
            if values.len() > 1 {
                return Err(Error::request(400, "Invalid history query"));
            }
            Ok(values.into_iter().next())
        };
        let note = single("noteId")?
            .filter(|n| !n.is_empty() && n.encode_utf16().count() <= 512)
            .ok_or_else(|| Error::request(400, "Invalid history query"))?;
        let cursor = single("cursor")?;
        let limit = single("limit")?
            .map(|v| {
                if !v.is_empty() && v.bytes().all(|c| c.is_ascii_digit()) {
                    v.parse::<usize>().ok().filter(|n| (1..=100).contains(n))
                } else {
                    None
                }
            })
            .unwrap_or(Some(50))
            .ok_or_else(|| Error::request(400, "Invalid history query"))?;
        let result = state
            .with_owned_account(principal, move |a| {
                a.vault.history_read(|v| {
                    let sources = history_state::groups(&v.doc)
                        .into_iter()
                        .find(|g| g.contains(&note))
                        .unwrap_or(vec![note]);
                    let mut page = v.history.list(&sources, cursor.as_deref(), limit)?;
                    if sources
                        .iter()
                        .any(|s| v.history_capture_failures.contains(s))
                    {
                        page["error"] = json!(
                            "A saved version could not be recorded. Current notes are saved."
                        );
                    }
                    Ok(page)
                })
            })
            .await?;
        return Ok(json_response(200, result));
    }
    if let Some(version) = path.strip_prefix("/api/history/")
        && read
    {
        let version = percent_encoding::percent_decode_str(version)
            .decode_utf8()
            .map_err(|_| Error::request(400, "Invalid history identity"))?
            .into_owned();
        let result = state
            .with_owned_account(principal, move |a| {
                a.vault.history_read(|v| {
                    if version == "export" {
                        v.history.export()
                    } else {
                        v.history
                            .get(&version)?
                            .ok_or_else(|| Error::request(404, "Saved version not found"))
                    }
                })
            })
            .await?;
        return Ok(json_response(200, result));
    }
    if path == "/api/history-retention/compression" && method == Method::PUT {
        let body = body_json(request, 4096).await?;
        let enabled = body["enabled"]
            .as_bool()
            .filter(|_| body.as_object().is_some_and(|v| v.len() == 1))
            .ok_or_else(|| {
                Error::request(400, "Specify whether history compression is enabled.")
            })?;
        let storage = state
            .with_owned_account(principal, move |a| {
                a.vault.set_compression(enabled)?;
                let storage = a.vault.storage()?;
                a.notice(json!({"type":"history-changed"}));
                Ok(storage)
            })
            .await?;
        return Ok(json_response(200, storage));
    }
    if path == "/api/history-retention" && method == Method::PUT {
        let body = body_json(request, 4096).await?;
        let enabled = body["enabled"]
            .as_bool()
            .filter(|_| body.as_object().is_some_and(|m| m.len() == 1))
            .ok_or_else(|| {
                Error::request(400, "Specify whether automatic history cleanup is enabled.")
            })?;
        return Ok(json_response(
            200,
            state
                .with_owned_account(principal, move |a| {
                    a.vault.set_retention(enabled, time)?;
                    a.vault.storage()
                })
                .await?,
        ));
    }
    if path == "/api/history-retention/cleanup" && method == Method::POST {
        let body = body_json(request, 2 * 1024 * 1024).await?;
        let sources = strings(&body["sourceIds"]);
        let token = string(&body["selectionToken"]).to_owned();
        if !body["sourceIds"].is_array()
            || array(&body["sourceIds"]).len() != sources.len()
            || sources.len() > 100_000
            || sources
                .iter()
                .any(|s| s.is_empty() || s.encode_utf16().count() > 512)
            || sources
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != sources.len()
            || !policy::is_hash(&token)
        {
            return Err(Error::request(400, "Invalid archived-note selection."));
        }
        return Ok(json_response(200,state.with_owned_account(principal,move|a|{let clean=a.vault.discard_history(&sources,Some(&token),time)?;if clean.cleaned_note_count>0 { a.notice(json!({"type":"history-changed","sourceIds":clean.source_ids})); }Ok(json!({"storage":a.vault.storage()?,"cleanedNoteCount":clean.cleaned_note_count}))}).await?));
    }
    if let Some(blob) = path.strip_prefix("/api/blobs/") {
        let (hash, thumbnail) = blob
            .strip_suffix("/thumbnail")
            .map(|s| (s, true))
            .unwrap_or((blob, false));
        if !policy::is_hash(hash) {
            return Err(Error::request(400, "Invalid SHA-256 hash"));
        }
        let hash = hash.to_owned();
        if method == Method::PUT && !thumbnail {
            let sources = blob_sources(&headers)?;
            let bytes = body_bytes(request, MAX_BLOB).await?;
            if bytes.is_empty() {
                return Err(Error::request(400, "Empty attachment"));
            }
            if hex::encode(Sha256::digest(&bytes)) != hash {
                return Err(Error::request(
                    400,
                    "Attachment does not match its SHA-256 hash",
                ));
            }
            state
                .with_owned_account(principal, move |a| a.vault.upload(&hash, &sources, &bytes))
                .await?;
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        if read {
            let sources = if method == Method::HEAD && headers.contains_key("x-stow-blob-sources") {
                Some(blob_sources(&headers)?)
            } else {
                None
            };
            let runtime = tokio::runtime::Handle::current();
            let output = state
                .with_owned_account(principal, move |a| {
                    if thumbnail {
                        let image =
                            runtime.block_on(images::thumbnail(&a.vault.blob_dir, &hash))?;
                        Ok((image.bytes, Some(image.digest)))
                    } else {
                        if let Some(sources) = sources {
                            a.vault.reserve_upload(&hash, &sources)?;
                        }
                        Ok((std::fs::read(a.vault.blob_dir.join(hash))?, None))
                    }
                })
                .await;
            let (bytes, digest) = match output {
                Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(Error::request(
                        404,
                        if thumbnail {
                            "Original image not found"
                        } else {
                            "Attachment not found"
                        },
                    ));
                }
                other => other?,
            };
            let length = bytes.len();
            let mut response = bytes.into_response();
            set_header(&mut response, "content-length", &length.to_string());
            set_header(
                &mut response,
                "content-type",
                if thumbnail {
                    "image/webp"
                } else {
                    "application/octet-stream"
                },
            );
            if let Some(digest) = digest {
                set_header(&mut response, "x-stow-thumbnail-sha256", &digest);
            } else {
                set_header(&mut response, "content-disposition", "attachment");
            }
            return Ok(response);
        }
    }
    Err(Error::request(404, "Not found"))
}
fn blob_sources(headers: &HeaderMap) -> Result<Vec<String>> {
    if !headers.contains_key("x-stow-blob-sources") {
        return Ok(vec![]);
    }
    let value = single_header(headers, "x-stow-blob-sources")
        .ok_or_else(|| Error::request(400, "Invalid attachment source identities"))?;
    let v: Value = serde_json::from_str(value)
        .map_err(|_| Error::request(400, "Invalid attachment source identities"))?;
    let sources = strings(&v);
    if !v.is_array()
        || sources.is_empty()
        || sources.len() != array(&v).len()
        || sources
            .iter()
            .any(|s| s.is_empty() || s.encode_utf16().count() > 512)
    {
        return Err(Error::request(400, "Invalid attachment source identities"));
    }
    Ok(sources)
}
async fn static_file(directory: &Path, path: &str, method: &Method) -> Result<Response> {
    if method != Method::GET && method != Method::HEAD {
        return Err(Error::request(404, "Not found"));
    }
    let decoded = percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .map_err(|_| Error::request(400, "Invalid path"))?;
    let relative = Path::new(decoded.trim_start_matches('/'));
    let safe = relative.components().all(
        |p| matches!(p,std::path::Component::Normal(s) if !s.to_string_lossy().starts_with('.')),
    );
    let target = directory.join(relative);
    let mut file = None;
    if safe
        && let Ok(canonical) = tokio::fs::canonicalize(&target).await
        && canonical.starts_with(directory)
        && canonical.is_file()
    {
        file = Some(canonical);
    }
    let filename = file.unwrap_or_else(|| directory.join("index.html"));
    let bytes=match tokio::fs::read(&filename).await { Ok(v)=>v,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok((StatusCode::NOT_FOUND,"Stow frontend has not been built. Run npm run build, or use the Vite development server.").into_response()),Err(e)=>return Err(e.into()) };
    let mime = match filename.extension().and_then(|s| s.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    let mut response = bytes.into_response();
    set_header(&mut response, "content-type", mime);
    set_header(
        &mut response,
        "cache-control",
        if filename.starts_with(directory.join("assets")) {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        },
    );
    Ok(response)
}
pub fn decode_base64(value: &Value, max: usize) -> Result<Vec<u8>> {
    let s = value
        .as_str()
        .filter(|s| s.len() <= max.div_ceil(3) * 4)
        .ok_or_else(|| Error::invalid("Invalid or oversized base64 payload"))?;
    let bytes = STANDARD
        .decode(s)
        .map_err(|_| Error::invalid("Invalid base64 payload"))?;
    if bytes.is_empty() || bytes.len() > max || STANDARD.encode(&bytes) != s {
        return Err(Error::invalid("Invalid or oversized payload"));
    }
    Ok(bytes)
}
async fn upgrade(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    uri: Uri,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    if state.shutdown.is_cancelled() {
        return Err(Error::request(503, "Service unavailable"));
    }
    if !state.origin_allowed(&headers) {
        return Err(Error::request(403, "Origin is not allowed"));
    }
    let principal = state.authenticate(&headers)?;
    let expected: Vec<_> = url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .filter(|(k, _)| k == "vaultId")
        .map(|(_, v)| v.into_owned())
        .collect();
    if expected != [principal.vault_id.clone()] {
        return Err(Error::request(409, "Vault identity changed"));
    }
    let pairs: Vec<_> = url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()).collect();
    for (key, value) in [("protocol", SYNC_PROTOCOL), ("schema", CURRENT_SCHEMA)] {
        let values: Vec<_> = pairs
            .iter()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.as_ref())
            .collect();
        if values != [value] {
            // Browser WebSocket APIs hide failed HTTP handshakes. Upgrade only
            // to deliver a terminal notice, before opening or leasing a vault.
            let tracker = state.connections.clone();
            let shutdown = state.shutdown.clone();
            return Ok(ws
                .max_message_size(transfer::FRAME)
                .max_frame_size(transfer::FRAME)
                .on_upgrade(move |socket| {
                    tracker.track_future(reject_incompatible(socket, shutdown))
                })
                .into_response());
        }
    }
    let copy = state.clone();
    let owner = principal.clone();
    let (lease, slot) = tokio::task::spawn_blocking(move || {
        let lease = copy.owned_account(&owner)?;
        let slot = lease
            .lock()?
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::request(503, "Too many vault connections"))?;
        Ok::<_, Error>((lease, slot))
    })
    .await
    .map_err(|e| Error::request(503, e.to_string()))?
    .map_err(|_| Error::request(503, "Could not open vault"))?;
    let tracker = state.connections.clone();
    Ok(ws
        .max_message_size(transfer::FRAME)
        .max_frame_size(transfer::FRAME)
        .on_upgrade(move |socket| {
            tracker.track_future(async move {
                let _lease = lease;
                let _slot = slot;
                connection(state, principal.vault_id, socket).await
            })
        })
        .into_response())
}

async fn reject_incompatible(mut socket: WebSocket, shutdown: CancellationToken) {
    let close = async {
        socket
            .send(Message::Text(
                json!({"type": "sync-rejection", "rejection": client_update_required()})
                    .to_string()
                    .into(),
            ))
            .await?;
        socket
            .send(Message::Close(Some(CloseFrame {
                code: 1008,
                reason: "client_update_required".into(),
            })))
            .await?;
        // Finish the close handshake so browsers receive the policy code.
        // Discard any data already in flight without processing or acknowledging
        // it. This path has no account handle or sync transfer state.
        while let Some(Ok(message)) = socket.next().await {
            if matches!(message, Message::Close(_)) {
                break;
            }
        }
        Ok::<_, axum::Error>(())
    };
    tokio::select! {
        _ = shutdown.cancelled() => {},
        _ = tokio::time::timeout(Duration::from_secs(5), close) => {},
    }
}

async fn process_unit(
    state: &Arc<ServerState>,
    vault_id: &str,
    connection_id: u64,
    client: &Client,
    unit: transfer::Received,
    catchup: Ids,
    completed: bool,
) -> Result<(Ids, bool)> {
    let client = client.clone();
    let time = state.time();
    state.with_account(vault_id.into(), move |account| {
        let mut catchup = catchup;
        let mut completed = completed;
        let capture = |account: &mut Account, boundary: &Value| {
            let result = account.vault.capture_history(boundary, time).and_then(|ids| {
                account.vault.cleanup_history_blobs()?;
                Ok(ids)
            });
            match result {
                Ok(ids) => {
                    if !ids.is_empty() {
                        account.notice(json!({"type":"history-changed","sourceIds":ids}));
                    }
                }
                Err(e) => {
                    account.vault.history_error = Some(e.to_string());
                    account.vault.history_capture_failures.extend(strings(&boundary["sourceIds"]));
                    client.notice(json!({"type":"history-failure","message":format!("Current notes are saved, but history could not be recorded: {e}")}));
                }
            }
        };
        match unit.kind {
            Kind::SyncRequest => {
                if unit.data.len() > 1024 * 1024 {
                    return Err(Error::invalid("Invalid sync vector"));
                }
                let vector = StateVector::decode_v1(&unit.data)
                    .map_err(|_| Error::invalid("Invalid sync message"))?;
                client.send(Kind::Sync, transfer::pack(&account.vault.sync(&vector), &account.vault.state_vector()));
            }
            Kind::Update => {
                let accepted = account.vault.accept(&unit.data, time)?;
                if accepted.corrected() { client.update(&accepted); }
                account.broadcast(&accepted, Some(connection_id));
                if !completed { catchup.extend(accepted.touched.iter().cloned()); }
                if let Some(e) = &account.vault.history_error {
                    client.notice(json!({"type":"history-failure","message":e}));
                }
            }
            Kind::SyncComplete => {
                if !completed {
                    completed = true;
                    capture(account, &json!({"sourceIds":catchup,"editedAt":time}));
                    catchup.clear();
                }
            }
            Kind::HistoryBoundary => {
                let boundary: Value = serde_json::from_slice(&unit.data).unwrap_or(Value::Null);
                let ids = strings(&boundary["sourceIds"]);
                if !boundary["sourceIds"].is_array()
                    || ids.len() != array(&boundary["sourceIds"]).len()
                    || ids.len() > 100_000
                    || ids.iter().any(|s| s.is_empty() || s.encode_utf16().count() > 512)
                    || !boundary["editedAt"].as_f64().is_some_and(f64::is_finite)
                {
                    client.notice(json!({"type":"history-failure","message":"Invalid history boundary; current notes remain saved."}));
                } else { capture(account, &boundary); }
            }
            _ => return Err(Error::invalid("Invalid sync message")),
        }
        Ok((catchup, completed))
    }).await
}

fn application_failure(error: Error) -> transfer::Failure {
    match error {
        Error::Io(_) => transfer::Failure::new(
            "storage",
            "Storage unavailable; changes remain on this device. Reconnect to retry.",
        ),
        Error::Invalid(message) if message.starts_with("Invalid Yjs update:") => {
            transfer::Failure::invalid("Invalid sync message")
        }
        error => transfer::Failure::invalid(error.to_string()),
    }
}
async fn connection(state: Arc<ServerState>, vault_id: String, mut socket: WebSocket) {
    let id = state.next_client.fetch_add(1, Ordering::Relaxed);
    let (sender, mut receiver) = mpsc::channel(128);
    let slow = CancellationToken::new();
    let client = Client {
        sender,
        queued: Arc::new(AtomicUsize::new(0)),
        slow: slow.clone(),
        budget: state.transfer_budget.clone(),
    };
    let registered = client.clone();
    if state
        .with_account(vault_id.clone(), move |a| {
            a.clients.insert(id, registered);
            Ok(())
        })
        .await
        .is_err()
    {
        return;
    }
    let mut transfer = Transfer::new(state.transfer_budget.clone());
    let mut catchup = Ids::new();
    let mut completed = false;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    let mut deadline = tokio::time::interval(Duration::from_secs(1));
    let mut alive = true;
    let outcome:std::result::Result<(),transfer::Failure>=async{loop{
        let frames=tokio::select!{
            _=state.shutdown.cancelled()=>break,
            _=slow.cancelled()=>return Err(transfer::Failure::new("retry","Reconnect to catch up")),
            _=deadline.tick()=>{transfer.check_timeout()?;continue;},
            _=heartbeat.tick()=>{if !alive{break;}alive=false;vec![Message::Ping(vec![].into())]},
            Some(unit)=receiver.recv(),if transfer.ready_to_send()=>transfer.send(unit)?,
            incoming=socket.next()=>{let Some(Ok(message))=incoming else{break;};match message{Message::Pong(_)=>{alive=true;continue;},Message::Ping(_)=>continue,Message::Close(_)=>break,_=>{}}
                let (mut frames,received)=transfer.receive(message)?;
                if let Some(unit)=received{
                    // Transport credit precedes application; durable completion follows it.
                    for frame in frames.drain(..){socket.send(frame).await.map_err(|_|transfer::Failure::new("retry","Sync connection closed"))?;}
                    let transfer_id = unit.id;
                    let result=process_unit(&state,&vault_id,id,&client,unit,std::mem::take(&mut catchup),completed).await;
                    match result{Ok((sources,done))=>{catchup=sources;completed=done;},Err(e)=>return Err(application_failure(e))}
                    transfer.check_timeout()?;frames.push(transfer.committed(transfer_id)?);
                }frames
            }
        };
        for frame in frames{tokio::time::timeout(Duration::from_secs(30),socket.send(frame)).await.map_err(|_|transfer::Failure::new("retry","Sync timed out"))?.map_err(|_|transfer::Failure::new("retry","Sync connection closed"))?;}
    }Ok(())}.await;
    if let Err(e) = outcome {
        let _ = socket.send(e.frame()).await;
        let _ = socket
            .send(Message::Close(Some(CloseFrame {
                code: if e.code == "limit" {
                    1009
                } else if e.code == "invalid" {
                    1008
                } else {
                    1013
                },
                reason: e.code.into(),
            })))
            .await;
    }
    drop(transfer);
    drop(receiver);
    let _ = state
        .with_account(vault_id, move |a| {
            a.clients.remove(&id);
            Ok(())
        })
        .await;
}
