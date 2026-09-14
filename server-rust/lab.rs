//! Authenticated gateway for disposable storage measurements. No deployment vault
//! is opened; each principal, run and scenario gets a separate synthetic account.
use crate::{
    crdt::*,
    error::{Error, Result},
    fixture,
    identity::{self, AuthMode},
    server::{self, Config},
    storage::{atomic_write, mkdir_durable},
};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::Request,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;
const SCENARIOS: &[&str] = &["fresh", "aged", "archive", "live", "both"];
fn run_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
}
fn namespace(value: &str) -> Result<String> {
    let suffix = value.strip_prefix('/').unwrap_or("");
    if suffix.is_empty()
        || !suffix.as_bytes()[0].is_ascii_lowercase()
        || !suffix
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(Error::invalid(
            "Use one absolute laboratory path segment without a trailing slash.",
        ));
    }
    Ok(value.into())
}
fn local_origin(origin: &str) -> bool {
    url::Url::parse(origin).is_ok_and(|u| {
        u.scheme() == "http"
            && [Some("localhost"), Some("127.0.0.1")].contains(&u.host_str())
            && u.port().is_some()
    })
}
struct Route {
    user: String,
    pathname: String,
    query: String,
    scenario: Option<String>,
    run: Option<String>,
    vault: Option<String>,
    scope: Option<String>,
}
fn route(
    req: &Request,
    origin: &str,
    proof: &str,
    secret: &[u8],
    local: bool,
    base: &str,
) -> Result<Route> {
    let url = url::Url::parse(origin)
        .and_then(|u| u.join(&req.uri().to_string()))
        .map_err(|e| Error::invalid(e.to_string()))?;
    let prefix = format!("{}/", namespace(base)?);
    if !url.path().starts_with(&prefix) {
        return Err(Error::invalid("Invalid laboratory namespace."));
    }
    let user = if local {
        if !local_origin(origin) {
            return Err(Error::invalid("Test authentication requires loopback."));
        }
        fixture::cookie(req, "stow_lab_user")
            .filter(|u| identity::valid_identity(u))
            .ok_or_else(|| Error::invalid("Set the explicit local-test user cookie."))?
    } else {
        identity::proxy_identity(req.headers(), proof)?
    };
    let pathname = &url.path()[base.len()..];
    let parts: Vec<_> = pathname.splitn(4, '/').collect();
    let mut r = Route {
        user,
        pathname: pathname.into(),
        query: url.query().map(|s| format!("?{s}")).unwrap_or_default(),
        scenario: None,
        run: None,
        vault: None,
        scope: None,
    };
    if parts.len() == 4
        && SCENARIOS.contains(&parts[1])
        && (parts[3] == "sync" || parts[3] == "api" || parts[3].starts_with("api/"))
    {
        if !run_id(parts[2]) {
            return Err(Error::invalid("Invalid laboratory run identity."));
        }
        let user_hash = hex::encode(Sha256::digest(r.user.as_bytes()));
        r.user = format!("{user_hash}-{}-{}@storage-lab.invalid", parts[1], parts[2]);
        r.vault = Some(identity::vault_identity(secret, AuthMode::Proxy, &r.user));
        r.scope = Some(identity::vault_identity(
            secret,
            AuthMode::Proxy,
            &format!("{user_hash}-{}@storage-lab.invalid", parts[2]),
        ));
        r.scenario = Some(parts[1].into());
        r.run = Some(parts[2].into());
        r.pathname = format!("/{}", parts[3]);
    }
    Ok(r)
}
fn finite(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|n| n.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&n))
}
fn report(v: &Value, r: &Route) -> Result<Value> {
    const NAMES: &[&str] = &[
        "startup-ready",
        "worker-write",
        "worker-compaction",
        "cold-preview",
        "frame",
        "input-core",
        "input-frame",
        "finish-edit",
        "completed-edit",
        "visibility-hidden",
        "visibility-visible",
        "editor-refocus",
    ];
    let valid = v["schema"] == 1
        && run_id(string(&v["id"]))
        && v["scenario"].as_str() == r.scenario.as_deref()
        && v["runId"].as_str() == r.run.as_deref()
        && finite(&v["startedAt"])
        && v["samples"].is_array()
        && array(&v["samples"]).len() <= 2000
        && array(&v["samples"]).iter().all(|s| {
            s.is_object()
                && NAMES.contains(&string(&s["name"]))
                && finite(&s["startMs"])
                && finite(&s["durationMs"])
                && ["bytes", "count"]
                    .iter()
                    .all(|k| s.get(k).is_none_or(finite))
                && object(s).all(|(k, _)| {
                    ["name", "startMs", "durationMs", "bytes", "count"].contains(&k.as_str())
                })
        });
    if !valid {
        return Err(Error::invalid("Invalid numeric measurements"));
    }
    let mut clean = json!({"schema":1,"id":v["id"],"scenario":v["scenario"],"runId":v["runId"],"startedAt":v["startedAt"],"samples":v["samples"]});
    if let Some(f) = v.get("failure") {
        let valid = f.is_object()
            && f["message"]
                .as_str()
                .is_some_and(|s| s.encode_utf16().count() <= 250)
            && [
                "startup", "preview", "editor", "typing", "edits", "sync", "report",
            ]
            .contains(&string(&f["phase"]))
            && f["iteration"].as_u64().is_some_and(|n| n <= 120)
            && finite(&f["percent"])
            && number(&f["percent"]) <= 100.
            && ["NONE", "DIV", "TEXTAREA"].contains(&string(&f["field"]))
            && ["body", "title", "other"].contains(&string(&f["focus"]))
            && f["dialog"].is_boolean()
            && object(f).all(|(k, _)| {
                [
                    "message",
                    "phase",
                    "iteration",
                    "percent",
                    "field",
                    "focus",
                    "dialog",
                ]
                .contains(&k.as_str())
            });
        if !valid {
            return Err(Error::invalid("Invalid failure diagnostic"));
        }
        clean["failure"] = f.clone();
    }
    Ok(clean)
}
fn completed_stage(report: &Value) -> Option<String> {
    if report.get("failure").is_some() {
        return None;
    }
    let samples = array(&report["samples"]);
    let starts: Vec<_> = samples
        .iter()
        .filter(|s| s["name"] == "startup-ready")
        .collect();
    let scenario = string(&report["scenario"]);
    if starts.len() == 1
        && let Some(n) = starts[0]["count"].as_u64().filter(|n| *n <= 5)
    {
        return Some(format!("{scenario}:load-{n}"));
    }
    let count = |name: &str| samples.iter().filter(|s| s["name"] == name).count();
    if starts.is_empty()
        && count("input-core") == 120
        && count("input-frame") == 120
        && count("completed-edit") == 40
    {
        Some(format!("{scenario}:actions"))
    } else {
        None
    }
}
struct Lab {
    origin: String,
    proof: String,
    secret: Vec<u8>,
    base: String,
    local: bool,
    data: PathBuf,
    fixtures_dir: PathBuf,
    reports_dir: PathBuf,
    fixtures: Value,
    build: Value,
    target: SocketAddr,
    seeds: Mutex<BTreeSet<String>>,
    stages: Mutex<BTreeMap<String, BTreeSet<String>>>,
}
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    mkdir_durable(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let target = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_tree(&e.path(), &target)?;
        } else {
            fs::copy(e.path(), target)?;
        }
    }
    Ok(())
}
impl Lab {
    async fn seed(&self, r: &Route) -> Result<()> {
        let (Some(vault), Some(scenario)) = (&r.vault, &r.scenario) else {
            return Ok(());
        };
        let mut seeds = self.seeds.lock().await;
        if seeds.contains(vault) {
            return Ok(());
        }
        let destination = self.data.join("users").join(vault);
        mkdir_durable(&destination)?;
        fs::copy(
            self.fixtures_dir.join(format!("{scenario}.yjs")),
            destination.join("vault.yjs"),
        )?;
        copy_tree(
            &self.fixtures_dir.join(scenario).join("history"),
            &destination.join("history"),
        )?;
        mkdir_durable(&destination.join("blobs"))?;
        for blob in array(&self.fixtures["blobs"]) {
            let hash = string(&blob["hash"]);
            if !crate::policy::is_hash(hash) {
                return Err(Error::invalid("Invalid fixture blob hash"));
            }
            fs::copy(
                self.fixtures_dir.join("blobs").join(hash),
                destination.join("blobs").join(hash),
            )?;
        }
        atomic_write(
            &destination.join("history-retention.json"),
            &serde_json::to_vec(
                &json!({"schema":1,"enabled":scenario=="archive"||scenario=="both","compressHistory":scenario=="live"||scenario=="both","quietSince":{}}),
            )?,
        )?;
        seeds.insert(vault.clone());
        Ok(())
    }
    fn headers(&self, r: &Route, h: &mut HeaderMap) -> Result<()> {
        h.remove("x-auth-user");
        h.insert(
            "x-auth-user",
            r.user
                .parse()
                .map_err(|_| Error::invalid("Invalid fixture principal"))?,
        );
        h.insert(
            "x-stow-proxy-secret",
            self.proof
                .parse()
                .map_err(|_| Error::invalid("Invalid proxy proof"))?,
        );
        Ok(())
    }
    async fn handle(&self, mut req: Request) -> Result<Response> {
        let mut r = match route(
            &req,
            &self.origin,
            &self.proof,
            &self.secret,
            self.local,
            &self.base,
        ) {
            Ok(r) => r,
            Err(_) => {
                return Ok((
                    StatusCode::FORBIDDEN,
                    "Authenticated laboratory access required.",
                )
                    .into_response());
            }
        };
        self.seed(&r).await?;
        if r.pathname.starts_with("/api/lab/") {
            let Some(vault) = &r.vault else {
                return Ok(StatusCode::NOT_FOUND.into_response());
            };
            if r.pathname != "/api/lab/manifest"
                && identity::single_header(req.headers(), "x-stow-vault") != Some(vault)
            {
                return Ok(StatusCode::CONFLICT.into_response());
            }
            let response = if req.method() == "GET" && r.pathname == "/api/lab/manifest" {
                Json(json!({"namespace":self.base,"build":self.build,"fixtures":self.fixtures,"scenario":r.scenario,"runId":r.run})).into_response()
            } else if req.method() == "POST" && r.pathname == "/api/lab/report" {
                let browser = identity::single_header(req.headers(), "user-agent")
                    .unwrap_or("")
                    .chars()
                    .take(300)
                    .collect::<String>();
                let bytes = match to_bytes(req.into_body(), 256 * 1024).await {
                    Ok(b) => b,
                    Err(_) => return Ok(StatusCode::BAD_REQUEST.into_response()),
                };
                let value = serde_json::from_slice(&bytes)
                    .ok()
                    .and_then(|v| report(&v, &r).ok());
                let Some(mut entry) = value else {
                    return Ok(StatusCode::BAD_REQUEST.into_response());
                };
                if array(&entry["samples"])
                    .iter()
                    .any(|s| s["name"] == "startup-ready")
                {
                    let mut request = Request::builder()
                        .uri("/api/diagnostics/startup")
                        .header("host", self.target.to_string())
                        .header("x-stow-vault", vault)
                        .body(Body::empty())
                        .unwrap();
                    self.headers(&r, request.headers_mut())?;
                    let response = fixture::forward(request, self.target).await?;
                    if !response.status().is_success() {
                        return Err(Error::invalid(
                            "Could not read laboratory startup diagnostics.",
                        ));
                    }
                    let bytes = to_bytes(response.into_body(), 1024 * 1024)
                        .await
                        .map_err(|e| Error::invalid(e.to_string()))?;
                    let diagnostics: Value = serde_json::from_slice(&bytes)?;
                    entry["startup"] = json!({"reports":array(&diagnostics["reports"]).iter().filter(|v|(number(&v["startedAt"])-number(&entry["startedAt"])).abs()<1.).collect::<Vec<_>>()});
                }
                entry["namespace"] = json!(self.base);
                entry["build"] = self.build.clone();
                entry["fixture"] = array(&self.fixtures["results"])
                    .iter()
                    .find(|v| v["scenario"].as_str() == r.scenario.as_deref())
                    .cloned()
                    .unwrap_or(Value::Null);
                entry["browser"] = json!(browser);
                entry["receivedAt"] = json!(chrono::Utc::now().to_rfc3339());
                atomic_write(
                    &self
                        .reports_dir
                        .join(format!("{vault}-{}.json", string(&entry["id"]))),
                    &serde_json::to_vec_pretty(&entry)?,
                )?;
                let mut stages = self.stages.lock().await;
                let stages = stages.entry(r.scope.clone().unwrap()).or_default();
                if let Some(stage) = completed_stage(&entry) {
                    stages.insert(stage);
                }
                (StatusCode::CREATED,Json(json!({"id":entry["id"],"namespace":self.base,"buildSha256":self.build["sha256"],"savedStages":stages.len()}))).into_response()
            } else if req.method() == "GET" && r.pathname == "/api/lab/reports" {
                let mut files: Vec<_> = fs::read_dir(&self.reports_dir)?
                    .filter_map(|e| e.ok())
                    .filter(|e| {
                        e.file_name()
                            .to_string_lossy()
                            .starts_with(&format!("{vault}-"))
                    })
                    .map(|e| e.path())
                    .collect();
                files.sort();
                let reports: Result<Vec<Value>> = files
                    .iter()
                    .rev()
                    .take(20)
                    .rev()
                    .map(|p| Ok(serde_json::from_slice(&fs::read(p)?)?))
                    .collect();
                Json(json!({"reports":reports?})).into_response()
            } else {
                StatusCode::NOT_FOUND.into_response()
            };
            let mut response = response;
            response
                .headers_mut()
                .insert("cache-control", "no-store".parse().unwrap());
            return Ok(response);
        }
        if r.pathname == "/" {
            let links = SCENARIOS
                .iter()
                .map(|name| {
                    format!(
                        "<li><a href=\"{}/{name}/?startup-profile=1\">{name}</a></li>",
                        self.base
                    )
                })
                .collect::<String>();
            return Ok(axum::response::Html(format!("<!doctype html><meta name=\"viewport\" content=\"width=device-width\"><title>Stow storage trial</title><h1>Stow storage trial</h1><p>These synthetic fixtures use separate test accounts. Open a fixture, reload five times, then select Run measurements.</p><ul>{links}</ul>")).into_response());
        }
        if SCENARIOS
            .iter()
            .any(|name| r.pathname == format!("/{name}/"))
        {
            r.pathname = "/index.html".into();
        }
        if req.headers().contains_key("upgrade") && (r.pathname != "/sync" || r.vault.is_none()) {
            return Ok(StatusCode::FORBIDDEN.into_response());
        }
        *req.uri_mut() = format!("{}{}", r.pathname, r.query)
            .parse()
            .map_err(|_| Error::invalid("Invalid fixture route"))?;
        self.headers(&r, req.headers_mut())?;
        fixture::forward(req, self.target).await
    }
}
pub async fn run() -> Result<()> {
    let options = crate::cli::parse(
        std::env::args().skip(2),
        &[
            "--port",
            "--origin",
            "--base",
            "--bundle-dir",
            "--fixtures-dir",
        ],
        &["--local-test"],
    )?;
    let values = options.values;
    let local = options.flags.contains("--local-test");
    let source = Path::new(env!("CARGO_MANIFEST_DIR"));
    let build_dir = source.parent().unwrap().join("build");
    let get = |key: &str, default: String| values.get(key).cloned().unwrap_or(default);
    let port: u16 = get("--port", "4180".into())
        .parse()
        .map_err(|_| Error::invalid("Invalid laboratory port"))?;
    let base = namespace(&get("--base", "/storage-lab".into()))?;
    let origin = get(
        "--origin",
        std::env::var("STOW_ORIGIN").unwrap_or_else(|_| format!("http://localhost:{port}")),
    );
    if local && !local_origin(&origin) {
        return Err(Error::invalid(
            "Local test authentication requires a loopback HTTP origin.",
        ));
    }
    let proof = if local {
        hex::encode(rand::random::<[u8; 32]>())
    } else {
        std::env::var("STOW_PROXY_SECRET").unwrap_or_default()
    };
    if proof.encode_utf16().count() < 32 {
        return Err(Error::invalid(
            "Set STOW_PROXY_SECRET before starting the authenticated laboratory.",
        ));
    }
    let data = tempfile::tempdir()?;
    let bundle = PathBuf::from(get(
        "--bundle-dir",
        build_dir.join("storage-lab").to_string_lossy().into_owned(),
    ));
    let fixtures_dir = PathBuf::from(get(
        "--fixtures-dir",
        build_dir
            .join("storage-lab/fixtures-current-v1")
            .to_string_lossy()
            .into_owned(),
    ));
    let fixtures: Value = serde_json::from_slice(&fs::read(fixtures_dir.join("manifest.json"))?)?;
    if fixtures["schema"] != 2 || fixtures["currentSchema"] != CURRENT_SCHEMA {
        return Err(Error::invalid(
            "The lab requires fresh current-only fixtures.",
        ));
    }
    let build: Value = serde_json::from_slice(&fs::read(bundle.join("build.json"))?)?;
    let reports_dir = build_dir.join("storage-lab/reports");
    mkdir_durable(&reports_dir)?;
    let backend=server::start(Config::for_test(&json!({"port":0,"host":"127.0.0.1","dataDir":data.path(),"staticDir":bundle.join("dist"),"authMode":"proxy","proxySecret":proof,"password":"","origin":origin}))?).await?;
    println!(
        "{}",
        json!({"url":format!("{origin}{base}/"),"localTest":local,"reportsDir":reports_dir})
    );
    let state = Arc::new(Lab {
        origin,
        proof,
        secret: fs::read(data.path().join("session-secret"))?,
        base,
        local,
        data: data.path().into(),
        fixtures_dir,
        reports_dir,
        fixtures,
        build,
        target: backend.address,
        seeds: Mutex::new(BTreeSet::new()),
        stages: Mutex::new(BTreeMap::new()),
    });
    let router = Router::new().fallback(move |req: Request| {
        let state = state.clone();
        async move {
            state.handle(req).await.unwrap_or_else(|e| {
                eprintln!("Storage laboratory request failed: {e}");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            })
        }
    });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    axum::serve(fixture::gateway_listener(listener), router)
        .with_graceful_shutdown(fixture::shutdown())
        .await?;
    backend.close().await
}

#[cfg(test)]
mod tests {
    use super::*;
    const PROOF: &str = "laboratory-test-proof-at-least-32-characters";
    const RUN: &str = "11111111-1111-4111-8111-111111111111";
    fn req(user: &str, path: &str, proof: &str) -> Request {
        Request::builder()
            .uri(path)
            .header("x-auth-user", user)
            .header("x-stow-proxy-secret", proof)
            .body(Body::empty())
            .unwrap()
    }
    #[test]
    fn routes_require_proof_and_isolate_principal_run_and_policy() {
        let path = format!("/storage-lab/aged/{RUN}/api/session");
        let resolve = |user: &str, path: &str, proof: &str| {
            route(
                &req(user, path, proof),
                "https://stow.example",
                PROOF,
                &[44; 32],
                false,
                "/storage-lab",
            )
        };
        assert!(resolve("first", &path, "forged").is_err());
        assert!(resolve("first", &path, "").is_err());
        let first = resolve("first", &path, PROOF).unwrap();
        let other = resolve("second", &path, PROOF).unwrap();
        assert_ne!(first.vault, other.vault);
        assert_ne!(first.scope, other.scope);
        assert_eq!(first.pathname, "/api/session");
        let fresh = resolve("first", &path.replace("/aged/", "/fresh/"), PROOF).unwrap();
        assert_ne!(first.vault, fresh.vault);
        assert_eq!(first.scope, fresh.scope);
        assert_ne!(
            first.vault,
            resolve(
                "first",
                &path.replace(RUN, "21111111-1111-4111-8111-111111111111"),
                PROOF
            )
            .unwrap()
            .vault
        );
        assert_eq!(
            first.vault,
            resolve("first", &path.replace("/api/session", "/sync"), PROOF)
                .unwrap()
                .vault
        );
        assert!(resolve("first", "/api/session", PROOF).is_err());
        assert!(resolve("first", &path.replace(RUN, &"-".repeat(36)), PROOF).is_err());
        assert!(
            route(
                &req("first", &path, PROOF),
                "https://stow.example",
                PROOF,
                &[44; 32],
                true,
                "/storage-lab"
            )
            .is_err()
        );
    }
    #[test]
    fn namespace_remains_exact_for_api_socket_and_assets() {
        let resolve = |path: &str| {
            route(
                &req("first", path, PROOF),
                "https://stow.example",
                PROOF,
                &[44; 32],
                false,
                "/storage-trial",
            )
        };
        let path = format!("/storage-trial/aged/{RUN}/api/session");
        assert_eq!(
            resolve(&path).unwrap().vault,
            resolve(&path.replace("/api/session", "/sync"))
                .unwrap()
                .vault
        );
        assert_eq!(
            resolve("/storage-trial/assets/index.js").unwrap().pathname,
            "/assets/index.js"
        );
        assert!(resolve(&path.replace("storage-trial", "storage-lab")).is_err());
        assert!(resolve(&path.replace("storage-trial", "storage-trial-suffix")).is_err());
    }
    #[test]
    fn failed_and_incomplete_measurements_never_advance_progress() {
        let mut stages = BTreeSet::new();
        for scenario in SCENARIOS {
            for n in 0..6 {
                let stage = completed_stage(
                    &json!({"scenario":scenario,"samples":[{"name":"startup-ready","count":n}]}),
                )
                .unwrap();
                stages.insert(stage.clone());
                stages.insert(stage);
            }
            let mut samples = vec![];
            for (name, n) in [
                ("input-core", 120),
                ("input-frame", 120),
                ("completed-edit", 40),
            ] {
                samples.extend((0..n).map(|_| json!({"name":name})));
            }
            assert!(
                completed_stage(&json!({"scenario":scenario,"samples":&samples[..279]})).is_none()
            );
            assert!(
                completed_stage(&json!({"scenario":scenario,"samples":samples,"failure":{}}))
                    .is_none()
            );
            stages
                .insert(completed_stage(&json!({"scenario":scenario,"samples":samples})).unwrap());
        }
        assert_eq!(stages.len(), 35);
    }
    #[test]
    fn numeric_reports_reject_private_or_unbounded_measurements_and_mismatched_runs() {
        let r = route(
            &req(
                "first",
                &format!("/storage-lab/aged/{RUN}/api/lab/report"),
                PROOF,
            ),
            "https://stow.example",
            PROOF,
            &[44; 32],
            false,
            "/storage-lab",
        )
        .unwrap();
        let valid = json!({"schema":1,"id":RUN,"runId":RUN,"scenario":"aged","startedAt":1000,"samples":[{"name":"startup-ready","startMs":0,"durationMs":1,"count":0}],"privateText":"discard this"});
        assert!(report(&valid, &r).unwrap().get("privateText").is_none());
        for (key, value) in [
            ("scenario", json!("fresh")),
            ("runId", json!("21111111-1111-4111-8111-111111111111")),
            (
                "samples",
                json!([{"name":"private note","startMs":0,"durationMs":1}]),
            ),
            (
                "samples",
                json!([{"name":"frame","startMs":-1,"durationMs":1}]),
            ),
            (
                "samples",
                json!([{"name":"frame","startMs":0,"durationMs":1,"privateText":"secret"}]),
            ),
            (
                "samples",
                json!(vec![
                    json!({"name":"frame","startMs":0,"durationMs":1});
                    2001
                ]),
            ),
            ("failure", json!({"message":"private","phase":"unknown"})),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = value;
            assert!(report(&invalid, &r).is_err());
        }
    }
}
