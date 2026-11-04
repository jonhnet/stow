//! Browser-approved, account-bound credentials for the Android shell.
//! Pairing exchanges are retryable with the same verifier; approval is immutable.
use super::*;
use serde::{Deserialize, Serialize};

const PAIRING_MS: f64 = 10. * 60. * 1000.;
#[derive(Clone, Deserialize, Serialize)]
struct Grant {
    id: String,
    name: String,
    user: String,
    vault_id: String,
    auth_mode: String,
    created_at: f64,
}
#[derive(Deserialize, Serialize)]
struct Pairing {
    challenge: String,
    code: String,
    name: String,
    expires_at: f64,
    grant: Option<Grant>,
}
#[derive(Default, Deserialize, Serialize)]
struct Registry {
    pending: BTreeMap<String, Pairing>,
    grants: BTreeMap<String, Grant>,
}
fn mode(state: &ServerState) -> &str {
    if state.config.auth_mode == AuthMode::Proxy {
        "proxy"
    } else {
        "password"
    }
}
fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn identifier(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn registry(state: &ServerState) -> Result<Registry> {
    read_optional(&state.config.data_dir.join("device-access.json"))?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(Error::from))
        .unwrap_or_else(|| Ok(Registry::default()))
}
fn save(state: &ServerState, registry: &Registry) -> Result<()> {
    atomic_write(
        &state.config.data_dir.join("device-access.json"),
        &serde_json::to_vec(registry)?,
    )
}
pub(super) fn credential(headers: &HeaderMap) -> Option<&str> {
    single_header(headers, "authorization")
        .and_then(|s| s.strip_prefix("StowDevice "))
        .or_else(|| {
            single_header(headers, "cookie").and_then(|s| {
                s.split(';')
                    .map(str::trim)
                    .find_map(|s| s.strip_prefix("stow_device="))
            })
        })
}
pub(super) fn authenticate(state: &ServerState, token: &str) -> Result<Principal> {
    if !identifier(token) {
        return Err(Error::request(401, "Invalid device credential"));
    }
    let _guard = state
        .devices_lock
        .lock()
        .map_err(|_| Error::invalid("Device credentials unavailable"))?;
    let registry = registry(state)?;
    let grant = registry.grants.get(&digest(token)).ok_or_else(|| {
        Error::request(
            401,
            "Device authorization expired or was revoked. Sign in again.",
        )
    })?;
    let current = if state.config.auth_mode == AuthMode::Proxy {
        account_reset::resolve(
            &state.secret,
            AuthMode::Proxy,
            &grant.user,
            &state.incarnations,
        )
    } else {
        state.password_id()
    };
    if grant.auth_mode != mode(state) || current != grant.vault_id {
        return Err(Error::request(
            401,
            "This device belongs to a different vault incarnation. Sign in again.",
        ));
    }
    Ok(Principal {
        user: grant.user.clone(),
        vault_id: grant.vault_id.clone(),
    })
}

pub(super) async fn api(state: Arc<ServerState>, request: Request<Body>) -> Result<Response> {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let headers = request.headers().clone();
    if !state.origin_allowed(&headers) {
        return Err(Error::request(403, "Origin is not allowed"));
    }
    let public = path.starts_with("/native/device/");
    // Approval and management deliberately require the ordinary browser login.
    // A device credential cannot mint a second credential.
    let owner = if public {
        None
    } else {
        if credential(&headers).is_some() {
            return Err(Error::request(
                403,
                "Use your browser account to manage devices",
            ));
        }
        Some(state.authenticate_private(&headers)?)
    };
    let body = if method == Method::POST {
        body_json(request, 4096).await?
    } else {
        Value::Null
    };
    tokio::task::spawn_blocking(move || {
        let _guard = state.devices_lock.lock().map_err(|_| Error::invalid("Device credentials unavailable"))?;
        let mut registry = registry(&state)?;
        registry.pending.retain(|_, p| p.expires_at > now());
        registry.grants.retain(|key, _| !key.starts_with("pending:") || registry.pending.contains_key(&key[8..]));
        match (path.as_str(), method) {
            ("/native/device/start", Method::POST) => {
                let challenge = string(&body["challenge"]);
                let name = string(&body["name"]).trim();
                if !identifier(challenge) || name.is_empty() || name.len() > 80 { return Err(Error::request(400, "Invalid pairing request")); }
                if registry.pending.len() >= 64 { return Err(Error::request(429, "Too many pending device pairings. Try again later.")); }
                let id = hex::encode(rand::random::<[u8; 32]>());
                let code = hex::encode(rand::random::<[u8; 4]>()).to_uppercase();
                registry.pending.insert(id.clone(), Pairing { challenge: challenge.into(), code: code.clone(), name: name.into(), expires_at: now() + PAIRING_MS, grant: None });
                save(&state, &registry)?;
                Ok(json_response(201, json!({"requestId":id,"code":code,"expiresIn":600,"approvalPath":format!("/device.html?request={id}")})))
            }
            ("/native/device/token", Method::POST) => {
                let id = string(&body["requestId"]);
                let verifier = string(&body["verifier"]);
                if !identifier(id) || !identifier(verifier) { return Err(Error::request(400, "Invalid pairing exchange")); }
                let pair = registry.pending.get(id).ok_or_else(|| Error::request(410, "Pairing expired. Start again."))?;
                if !identity::same_secret(&pair.challenge, &digest(verifier)) { return Err(Error::request(403, "Invalid pairing verifier")); }
                let Some(grant) = pair.grant.clone() else { return Ok(json_response(202, json!({"pending":true}))); };
                let token = hex::encode(identity::mac(&state.secret, &[b"stow-device-v1\0", id.as_bytes(), verifier.as_bytes()]));
                let key = digest(&token);
                // A revoked approval cannot be replayed to re-authorize a device.
                if !registry.grants.contains_key(&key) {
                    // Approval reserves the ID; a completed exchange replaces its reservation.
                    let reserved = format!("pending:{}", grant.id);
                    if registry.grants.remove(&reserved).is_none() { return Err(Error::request(410, "Device authorization revoked")); }
                    registry.grants.insert(key, grant.clone());
                    save(&state, &registry)?;
                }
                let principal = Principal { user: grant.user, vault_id: grant.vault_id };
                Ok(json_response(200, json!({"token":token,"deviceId":grant.id,"account":state.session(&principal)})))
            }
            ("/api/devices/approve", Method::POST) => {
                let id = string(&body["requestId"]);
                let principal = owner.as_ref().unwrap();
                let pair = registry.pending.get_mut(id).ok_or_else(|| Error::request(410, "Pairing expired. Start again."))?;
                if !identity::same_secret(string(&body["code"]), &pair.code) { return Err(Error::request(403, "The pairing code does not match")); }
                if let Some(g) = &pair.grant {
                    if g.vault_id != principal.vault_id { return Err(Error::request(409, "Pairing was already approved for another account")); }
                } else {
                    if registry.grants.len() >= 1024 { return Err(Error::request(429, "Too many registered devices")); }
                    let grant = Grant { id: id.into(), name: pair.name.clone(), user: principal.user.clone(), vault_id: principal.vault_id.clone(), auth_mode: mode(&state).into(), created_at: now() };
                    pair.grant = Some(grant.clone());
                    registry.grants.insert(format!("pending:{id}"), grant);
                    save(&state, &registry)?;
                }
                Ok(json_response(200, json!({"approved":true})))
            }
            ("/api/devices", Method::GET) => {
                let owner = owner.unwrap();
                let grants: Vec<_> = registry.grants.values().filter(|g| g.vault_id == owner.vault_id).map(|g| json!({"id":g.id,"name":g.name,"createdAt":g.created_at})).collect();
                Ok(json_response(200, json!({"devices":grants})))
            }
            ("/api/devices/revoke", Method::POST) => {
                let owner = owner.unwrap();
                let id = string(&body["deviceId"]);
                registry.grants.retain(|_, g| !(g.id == id && g.vault_id == owner.vault_id));
                if registry.pending.get(id).and_then(|p| p.grant.as_ref()).is_some_and(|g| g.vault_id == owner.vault_id) { registry.pending.remove(id); }
                save(&state, &registry)?;
                let _ = state.devices_changed.send(());
                Ok(json_response(200, json!({"revoked":true})))
            }
            _ => Err(Error::request(404, "Unknown device endpoint")),
        }
    }).await.map_err(|e| Error::invalid(format!("Device credential worker failed: {e}")))?
}
