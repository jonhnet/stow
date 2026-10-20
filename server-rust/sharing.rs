//! Bearer-authorized document scopes. Participant identities and retention are
//! server records, never claims writable through the shared CRDT.
use super::*;
use crate::crdt::{self, clone_doc, diff, field, get, keys, put, root};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use yrs::{Doc, Map, MapPrelim, ReadTxn, TextPrelim, Transact};

pub const GRACE_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub digest: String,
    // Publication retry identity only; this account has no special permissions.
    pub publisher: String,
    pub sources: Vec<String>,
    pub unreferenced_at: Option<f64>,
    pub collected: bool,
    // Durable publication intent; replayed before serving the publishing vault.
    pub publication: Option<String>,
}
fn valid_id(id: &str) -> bool {
    id.strip_prefix("share_")
        .is_some_and(|v| v.len() == 36 && v.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'))
}
fn parts(cap: &str) -> Result<(&str, &str)> {
    let (id, token) = cap
        .split_once('.')
        .ok_or_else(|| Error::request(403, "Invalid sharing link"))?;
    if !valid_id(id) || !policy::is_hash(token) {
        return Err(Error::request(403, "Invalid sharing link"));
    }
    Ok((id, token))
}
fn digest(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}
fn record_path(state: &ServerState, id: &str) -> PathBuf {
    state
        .config
        .data_dir
        .join("sharing")
        .join(format!("{id}.json"))
}
fn read(state: &ServerState, id: &str) -> Result<Record> {
    let bytes = read_optional(&record_path(state, id))?
        .ok_or_else(|| Error::request(404, "This shared note is unavailable."))?;
    Ok(serde_json::from_slice(&bytes)?)
}
fn write(state: &ServerState, record: &Record) -> Result<()> {
    mkdir_durable(&state.config.data_dir.join("sharing"))?;
    atomic_write(
        &record_path(state, &record.id),
        &serde_json::to_vec(record)?,
    )
}
pub fn authorize(state: &ServerState, cap: &str) -> Result<Record> {
    let (id, token) = parts(cap)?;
    let record = read(state, id)?;
    if !identity::same_secret(&record.digest, &digest(token)) {
        return Err(Error::request(403, "Invalid sharing link"));
    }
    if record.collected {
        return Err(Error::request(
            410,
            "This shared note no longer has any saved references and has been deleted.",
        ));
    }
    if record.publication.is_some() {
        return Err(Error::request(503, "Publication is finishing. Try again."));
    }
    Ok(record)
}
pub fn credential(headers: &HeaderMap) -> Option<&str> {
    single_header(headers, "x-stow-share").or_else(|| {
        single_header(headers, "sec-websocket-protocol")?
            .split(',')
            .map(str::trim)
            .find(|s| s.starts_with("share_"))
    })
}
pub fn actor(state: &ServerState, headers: &HeaderMap) -> Result<(String, String, bool)> {
    if let Ok(p) = state.authenticate_private(headers) {
        return Ok((p.vault_id, p.user, false));
    }
    let cookie = single_header(headers, "cookie").and_then(|s| {
        s.split(';')
            .map(str::trim)
            .find_map(|s| s.strip_prefix("stow_guest="))
    });
    let (id, sig) = cookie.and_then(|s| s.split_once('.')).ok_or_else(|| {
        Error::request(401, "Open the sharing link to establish a guest session.")
    })?;
    if !policy::is_hash(id) || !identity::same_secret(sig, &state.sign(&format!("guest:{id}"))) {
        return Err(Error::request(401, "Invalid guest session"));
    }
    Ok((
        format!("guest_{id}"),
        format!("Anonymous Chicken {}", &id[..4]),
        true,
    ))
}
pub(super) fn principal(state: &ServerState, headers: &HeaderMap, cap: &str) -> Result<Principal> {
    let record = authorize(state, cap)?;
    let (_, user, _) = actor(state, headers)?;
    Ok(Principal {
        user,
        vault_id: record.id,
    })
}
/// Shared documents cannot delete themselves, publish more documents, or hold
/// collection metadata. Incomplete updates may wait for dependencies normally.
pub fn validate(doc: &Doc, id: &str, changes: Option<&crdt::Changes>) -> Result<()> {
    let tx = doc.transact();
    if keys(&tx, "notes") != [id.to_owned()].into_iter().collect()
        || !keys(&tx, "deletedNotes").is_empty()
        || ["merges", "mergeRecipes", "importSources", "imports"]
            .iter()
            .any(|name| !keys(&tx, name).is_empty())
        || !field(&tx, "notes", id, "share").is_null()
    {
        return Err(Error::invalid(
            "Shared notes cannot be merged, published again, or permanently deleted by a participant.",
        ));
    }
    let meta = |key| field(&tx, "notes", id, key);
    let private_labels = match root(&tx, "notes").get(&tx, id) {
        Some(yrs::Out::YMap(note)) => note.keys(&tx).any(|key| key.starts_with("label:")),
        _ => false,
    };
    if meta("archived") == true
        || meta("trashed") == true
        || meta("pinned") == true
        || meta("placement")["pinned"] == true
        || meta("color")
            .as_str()
            .is_some_and(|color| color != "default")
        || meta("labels")
            .as_array()
            .is_some_and(|labels| !labels.is_empty())
        || private_labels
    {
        return Err(Error::invalid(
            "Organization belongs to your private collection reference.",
        ));
    }
    for name in ["items", "attachments"] {
        for key in crdt::entry_ids(&tx, name, changes) {
            // Attachments are atomic JSON; item ownership is a small map field.
            let owner = if name == "attachments" {
                get(&tx, name, &key)["noteId"].clone()
            } else {
                field(&tx, name, &key, "noteId")
            };
            if owner.is_string() && owner != id {
                return Err(Error::invalid(
                    "Shared content belongs to a different document.",
                ));
            }
        }
    }
    Ok(())
}
fn reference_update(
    account: &Account,
    id: &str,
    token: &str,
    title: &str,
    original: Option<&str>,
    sources: &[String],
) -> Result<Vec<u8>> {
    let doc = clone_doc(&account.vault.doc)?;
    let before = doc.transact().state_vector();
    {
        let mut tx = doc.transact_mut();
        let old = original
            .map(|key| get(&tx, "notes", key))
            .unwrap_or(Value::Null);
        let existing = root(&tx, "notes").keys(&tx).any(|key| {
            !root(&tx, "deletedNotes").contains_key(&tx, key)
                && field(&tx, "notes", key, "share")["id"] == id
                && field(&tx, "notes", key, "share")["token"] == token
        });
        if !existing {
            let reference_id = if root(&tx, "deletedNotes").contains_key(&tx, id) {
                format!("ref_{}", hex::encode(rand::random::<[u8; 16]>()))
            } else {
                id.to_owned()
            };
            let note =
                root(&tx, "notes").insert(&mut tx, reference_id.as_str(), MapPrelim::default());
            note.insert(&mut tx, "title", TextPrelim::new(title));
            note.insert(&mut tx, "body", TextPrelim::new(""));
            for (key, value) in [
                ("kind", json!("text")),
                ("createdAt", json!(now())),
                ("updatedAt", json!(now())),
                (
                    "color",
                    old.get("color").cloned().unwrap_or(json!("default")),
                ),
                (
                    "archived",
                    old.get("archived").cloned().unwrap_or(json!(false)),
                ),
                ("trashed", json!(false)),
                (
                    "placement",
                    old.get("placement")
                        .cloned()
                        .unwrap_or(json!({"pinned":false,"sortOrderDate":now()})),
                ),
                ("share", json!({"id":id,"token":token})),
            ] {
                note.insert(&mut tx, key, yrs::encoding::serde::to_any(&value).unwrap());
            }
            if let Some(fields) = old.as_object() {
                for (key, value) in fields {
                    if key == "labels"
                        || key.starts_with("label:")
                        || key.starts_with("label-generation:")
                    {
                        note.insert(
                            &mut tx,
                            key.as_str(),
                            yrs::encoding::serde::to_any(value).unwrap(),
                        );
                    }
                }
            }
        }
        for source in sources {
            put(&mut tx, "deletedNotes", source, json!(true));
        }
    }
    Ok(diff(&doc, &before))
}
fn records(state: &ServerState) -> Result<Vec<Record>> {
    let dir = state.config.data_dir.join("sharing");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.path().extension().is_some_and(|x| x == "json") {
            result.push(serde_json::from_slice(&std::fs::read(entry.path())?)?);
        }
    }
    Ok(result)
}
/// Account updates are durable first. A dirty marker prevents collection until
/// the derived reference index is reconciled, including after a process crash.
pub fn dirty(state: &ServerState, id: &str) -> Result<()> {
    if id.starts_with("share_") {
        return Ok(());
    }
    let dir = state.config.data_dir.join("share-references");
    mkdir_durable(&dir)?;
    atomic_write(&dir.join(format!("{id}.dirty")), b"1")
}
#[derive(Serialize, Deserialize)]
struct Reference {
    id: String,
    digest: String,
}
pub fn reconcile(state: &ServerState, id: &str, doc: &Doc) -> Result<()> {
    reconcile_changes(state, id, doc, None)
}
pub fn reconcile_changes(
    state: &ServerState,
    id: &str,
    doc: &Doc,
    touched: Option<&crate::crdt::Ids>,
) -> Result<()> {
    if id.starts_with("share_") {
        return Ok(());
    }
    let dir = state.config.data_dir.join("share-references");
    mkdir_durable(&dir)?;
    let path = dir.join(format!("{id}.json"));
    let tx = doc.transact();
    let previous: BTreeMap<String, Reference> = read_optional(&path)?
        .map(|bytes| serde_json::from_slice(&bytes))
        .transpose()?
        .unwrap_or_default();
    let before: BTreeSet<_> = previous
        .values()
        .map(|r| (r.id.clone(), r.digest.clone()))
        .collect();
    let mut refs: BTreeMap<String, Reference> = if touched.is_some() {
        previous
    } else {
        BTreeMap::new()
    };
    let all = if touched.is_none() {
        keys(&tx, "notes")
    } else {
        Default::default()
    };
    for key in touched.unwrap_or(&all) {
        refs.remove(key);
        let r = field(&tx, "notes", key, "share");
        if let (Some(shared), Some(token)) = (r["id"].as_str(), r["token"].as_str())
            && valid_id(shared)
            && policy::is_hash(token)
            && !root(&tx, "deletedNotes").contains_key(&tx, key)
        {
            refs.insert(
                key.clone(),
                Reference {
                    id: shared.to_owned(),
                    digest: digest(token),
                },
            );
        }
    }
    let after: BTreeSet<_> = refs
        .values()
        .map(|r| (r.id.clone(), r.digest.clone()))
        .collect();
    atomic_write(&path, &serde_json::to_vec(&refs)?)?;
    let marker = dir.join(format!("{id}.dirty"));
    if marker.exists() {
        std::fs::remove_file(marker)?;
        crate::storage::sync_directory(&dir)?;
    }
    if touched.is_none() {
        // Also invalidates clients after recovery of an index written before a crash.
        let _ = state.membership_changes.send(None);
    } else {
        for (shared, _) in before.symmetric_difference(&after) {
            let _ = state.membership_changes.send(Some(shared.clone()));
        }
    }
    Ok(())
}
pub(super) fn recover(state: &ServerState, id: &str, account: &mut Account) -> Result<()> {
    if id.starts_with("share_") {
        return Ok(());
    }
    // Only a dirty account can have an unfinished publication. Avoid scanning
    // the registry on every sync frame or history request.
    if !state
        .config
        .data_dir
        .join("share-references")
        .join(format!("{id}.dirty"))
        .exists()
    {
        return Ok(());
    }
    for mut record in records(state)?
        .into_iter()
        .filter(|r| r.publisher == id && r.publication.is_some())
    {
        let bytes = STANDARD
            .decode(record.publication.as_ref().unwrap())
            .map_err(|_| Error::invalid("Invalid publication journal"))?;
        let accepted = account.vault.accept(&bytes, state.time())?;
        account.broadcast(&accepted, None);
        record.publication = None;
        write(state, &record)?;
        reconcile(state, id, &account.vault.doc)?;
    }
    if state
        .config
        .data_dir
        .join("share-references")
        .join(format!("{id}.dirty"))
        .exists()
    {
        reconcile(state, id, &account.vault.doc)?;
    }
    Ok(())
}
/// Membership is a projection of the durable retention index, never join history.
fn members(state: &ServerState, cap: &str) -> Result<Vec<Value>> {
    let _guard = state
        .sharing_lock
        .lock()
        .map_err(|_| Error::invalid("Sharing unavailable"))?;
    let record = authorize(state, cap)?;
    let dir = state.config.data_dir.join("share-references");
    let mut members = BTreeMap::new();
    if !dir.exists() {
        return Ok(vec![]);
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().is_some_and(|x| x == "dirty") {
            return Err(Error::request(
                503,
                "Membership is being reconciled. Retry shortly.",
            ));
        }
        if path.extension().is_none_or(|x| x != "json") {
            continue;
        }
        let Some(id) = path
            .file_stem()
            .and_then(|v| v.to_str())
            .filter(|id| policy::is_hash(id))
        else {
            continue;
        };
        let refs: BTreeMap<String, Reference> = serde_json::from_slice(&std::fs::read(&path)?)?;
        if !refs
            .values()
            .any(|r| r.id == record.id && r.digest == record.digest)
        {
            continue;
        }
        let metadata = account_metadata::read(&state.account_directory(id))?
            .ok_or_else(|| Error::invalid("Missing retained account identity"))?;
        if metadata.vault_id != id
            || account_reset::resolve(
                &state.secret,
                metadata.auth_mode,
                &metadata.user,
                &state.incarnations,
            ) != id
        {
            continue;
        }
        members.insert(
            id.to_owned(),
            json!({"id":id,"name":metadata.user,"guest":false}),
        );
    }
    Ok(members.into_values().collect())
}

pub fn collect(state: &ServerState) -> Result<()> {
    let _lock = state
        .sharing_lock
        .lock()
        .map_err(|_| Error::invalid("Sharing unavailable"))?;
    let dir = state.config.data_dir.join("share-references");
    let mut refs = BTreeMap::<String, Vec<String>>::new();
    if dir.exists() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            if entry.path().extension().is_some_and(|x| x == "dirty") {
                return Ok(());
            }
            if entry.path().extension().is_some_and(|x| x == "json") {
                let values: BTreeMap<String, Reference> =
                    serde_json::from_slice(&std::fs::read(entry.path())?)?;
                for value in values.into_values() {
                    refs.entry(value.id).or_default().push(value.digest);
                }
            }
        }
    }
    for mut record in records(state)? {
        if record.collected {
            let directory = state.account_directory(&record.id);
            if directory.exists() {
                std::fs::remove_dir_all(directory)?;
            }
            continue;
        }
        if record.publication.is_some() {
            continue;
        }
        let retained = refs
            .get(&record.id)
            .is_some_and(|values| values.contains(&record.digest));
        if retained {
            record.unreferenced_at = None;
        } else if let Some(since) = record.unreferenced_at {
            if state.time() - since >= GRACE_MS {
                // Publish the tombstone before removing bytes. Active sockets
                // check this tombstone on every incoming transfer.
                record.collected = true;
                write(state, &record)?;
                let directory = state.account_directory(&record.id);
                if directory.exists() {
                    std::fs::remove_dir_all(directory)?;
                }
            }
        } else {
            record.unreferenced_at = Some(state.time());
        }
        write(state, &record)?;
    }
    // A crash before the registry intent is durable can leave a prepared
    // directory. It was never published and has no account reference. Holding
    // the publication lock makes orphan cleanup safe against an active publish.
    let directory = state.config.data_dir.join("shared");
    if directory.exists() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let id = entry.file_name();
            if let Some(id) = id.to_str()
                && valid_id(id)
                && entry.file_type()?.is_dir()
                && !record_path(state, id).exists()
            {
                std::fs::remove_dir_all(entry.path())?;
            }
        }
    }
    Ok(())
}
pub fn alive(state: &ServerState, id: &str) -> Result<()> {
    if id.starts_with("share_") && read(state, id)?.collected {
        return Err(Error::request(410, "This shared note has been deleted."));
    }
    Ok(())
}
pub async fn api(state: Arc<ServerState>, request: Request<Body>) -> Result<Response> {
    let path = request.uri().path().to_owned();
    let headers = request.headers().clone();
    let method = request.method().clone();
    if !state.origin_allowed(&headers) {
        return Err(Error::request(403, "Origin is not allowed"));
    }
    if path == "/api/shares/publish" && method == Method::POST {
        let principal = state.authenticate_private(&headers)?;
        state.bind(&headers, &principal)?;
        let body = body_json(request, MAX_UPDATE).await?;
        let cap = string(&body["capability"]).to_owned();
        let (id, token) = parts(&cap)?;
        let id = id.to_owned();
        let token = token.to_owned();
        let seed = STANDARD
            .decode(string(&body["snapshot"]))
            .map_err(|_| Error::invalid("Invalid shared snapshot"))?;
        let sources = strings(&body["sourceIds"]);
        if sources.is_empty() {
            return Err(Error::invalid("Choose a note to share"));
        }
        let owner = principal.vault_id.clone();
        let copy = state.clone();
        state
            .with_owned_account(principal, move |account| {
                let _lock = copy
                    .sharing_lock
                    .lock()
                    .map_err(|_| Error::invalid("Sharing unavailable"))?;
                if record_path(&copy, &id).exists() {
                    let record = read(&copy, &id)?;
                    if record.publisher != owner
                        || record.digest != digest(&token)
                        || record.sources != sources
                    {
                        return Err(Error::request(409, "Publication identity already exists"));
                    }
                    recover(&copy, &owner, account)?;
                    alive(&copy, &id)?;
                    return Ok(());
                }
                let snapshot = crdt::new_doc();
                crdt::apply(&snapshot, &seed)?;
                validate(&snapshot, &id, None)?;
                if keys(&snapshot.transact(), "notes") != [id.clone()].into_iter().collect() {
                    return Err(Error::invalid("Publish exactly one note"));
                }
                if sources.iter().any(|source| {
                    !root(&account.vault.doc.transact(), "notes")
                        .contains_key(&account.vault.doc.transact(), source)
                        || root(&account.vault.doc.transact(), "deletedNotes")
                            .contains_key(&account.vault.doc.transact(), source)
                        || !field(&account.vault.doc.transact(), "notes", source, "share").is_null()
                }) {
                    return Err(Error::request(
                        409,
                        "The private note changed or was already shared. Reload before sharing.",
                    ));
                }
                let title = field(&snapshot.transact(), "notes", &id, "title")
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                let update =
                    reference_update(account, &id, &token, &title, Some(&sources[0]), &sources)?;
                let directory = copy.account_directory(&id);
                if directory.exists() {
                    std::fs::remove_dir_all(&directory)?;
                }
                mkdir_durable(&directory)?;
                let mut shared = Vault::open(&directory, copy.time())?;
                for (_, image) in crdt::entries(&snapshot.transact(), "attachments", None) {
                    let hash = string(&image["hash"]);
                    if !policy::is_hash(hash) {
                        return Err(Error::invalid("Invalid shared image"));
                    }
                    let allowed = crdt::entries(&account.vault.doc.transact(), "attachments", None)
                        .iter()
                        .any(|(_, a)| {
                            a["hash"] == hash && sources.contains(&string(&a["noteId"]).to_owned())
                        });
                    if !allowed {
                        return Err(Error::request(
                            403,
                            "Image does not belong to the published note",
                        ));
                    }
                    let bytes = std::fs::read(account.directory.join("blobs").join(hash)).map_err(
                        |_| {
                            Error::request(
                                409,
                                "Wait for images to finish uploading before sharing.",
                            )
                        },
                    )?;
                    atomic_write(&directory.join("blobs").join(hash), &bytes)?;
                }
                shared.accept(&seed, copy.time())?;
                shared.capture_history(
                    &json!({"sourceIds":[id],"editedAt":copy.time()}),
                    copy.time(),
                )?;
                dirty(&copy, &owner)?;
                write(
                    &copy,
                    &Record {
                        id: id.clone(),
                        digest: digest(&token),
                        publisher: owner.clone(),
                        sources,
                        unreferenced_at: None,
                        collected: false,
                        publication: Some(STANDARD.encode(update)),
                    },
                )?;
                recover(&copy, &owner, account)
            })
            .await?;
        return Ok(json_response(200, json!({"ok":true})));
    }
    let cap = single_header(&headers, "x-stow-share")
        .ok_or_else(|| Error::request(403, "Sharing link required"))?
        .to_owned();
    let record = authorize(&state, &cap)?;
    if path == "/api/shares/participants" && method == Method::GET {
        let copy = state.clone();
        let participants = tokio::task::spawn_blocking(move || members(&copy, &cap))
            .await
            .map_err(|e| Error::invalid(format!("Membership lookup failed: {e}")))??;
        return Ok(json_response(200, json!({"participants":participants})));
    }
    if path == "/api/shares/join" && method == Method::POST {
        let principal = state.authenticate_private(&headers).ok();
        let mut cookie = None;
        let (id, name, guest) = if let Some(p) = &principal {
            (p.vault_id.clone(), p.user.clone(), false)
        } else {
            let existing = single_header(&headers, "cookie").and_then(|s| {
                s.split(';')
                    .map(str::trim)
                    .find_map(|s| s.strip_prefix("stow_guest="))
            });
            let valid = existing
                .and_then(|s| s.split_once('.'))
                .filter(|(id, sig)| {
                    policy::is_hash(id)
                        && identity::same_secret(sig, &state.sign(&format!("guest:{id}")))
                });
            let id = valid
                .map(|(id, _)| id.to_owned())
                .unwrap_or_else(|| hex::encode(rand::random::<[u8; 32]>()));
            cookie = Some(format!(
                "stow_guest={id}.{}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000{}",
                state.sign(&format!("guest:{id}")),
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
            ));
            (
                format!("guest_{id}"),
                format!("Anonymous Chicken {}", &id[..4]),
                true,
            )
        };
        let mut response = json_response(
            200,
            json!({"participant":{"id":id,"name":name,"guest":guest},"canAdd":principal.is_some()}),
        );
        if let Some(cookie) = cookie {
            set_header(&mut response, "set-cookie", &cookie);
        }
        return Ok(response);
    }
    if path == "/api/shares/add" && method == Method::POST {
        let principal = state.authenticate_private(&headers)?;
        state.bind(&headers, &principal)?;
        let (id, token) = parts(&cap)?;
        let id = id.to_owned();
        let token = token.to_owned();
        let title = state
            .with_account(id.clone(), move |account| {
                Ok(field(&account.vault.doc.transact(), "notes", &id, "title")
                    .as_str()
                    .unwrap_or("")
                    .to_owned())
            })
            .await?;
        let id = record.id;
        let owner = principal.vault_id.clone();
        let copy = state.clone();
        state
            .with_owned_account(principal, move |account| {
                let _lock = copy
                    .sharing_lock
                    .lock()
                    .map_err(|_| Error::invalid("Sharing unavailable"))?;
                authorize(&copy, &cap)?;
                let update = reference_update(account, &id, &token, &title, None, &[])?;
                dirty(&copy, &owner)?;
                let accepted = account.vault.accept(&update, copy.time())?;
                reconcile(&copy, &owner, &account.vault.doc)?;
                account.broadcast(&accepted, None);
                Ok(())
            })
            .await?;
        return Ok(json_response(200, json!({"ok":true})));
    }
    Err(Error::request(404, "Unknown sharing operation"))
}
