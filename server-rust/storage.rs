use crate::{
    crdt::*,
    error::{Error, Result},
    history::History,
    history_state, policy,
    retention::Schedule,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
use yrs::{Doc, Map, ReadTxn, Transact};

// Only the disposable test driver configures this gate. Production builds omit
// it entirely. A test observes `reached` before killing the actual server process.
#[cfg(feature = "test-support")]
pub(crate) static TEST_STORAGE_GATE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
#[cfg(feature = "test-support")]
fn test_storage_gate(path: &Path, phase: &str) -> Result<()> {
    let Some(directory) = TEST_STORAGE_GATE.get() else {
        return Ok(());
    };
    let Some(bytes) = read_optional(&directory.join("armed.json"))? else {
        return Ok(());
    };
    let gate: Value = serde_json::from_slice(&bytes)?;
    if gate["phase"] == phase
        && gate["suffix"]
            .as_str()
            .is_some_and(|suffix| path.ends_with(suffix))
    {
        fs::write(directory.join("reached"), phase)?;
        while !directory.join("release").exists() {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    Ok(())
}

pub fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}
pub fn mkdir_durable(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    for parent in path.ancestors() {
        if !parent.as_os_str().is_empty() {
            sync_directory(parent)?;
        }
    }
    Ok(())
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| Error::invalid("Invalid file path"))?
        .to_string_lossy();
    let tmp = path.with_file_name(format!(
        "{name}.{}.tmp",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(feature = "test-support")]
        test_storage_gate(path, "before-publish")?;
        fs::rename(&tmp, path)?;
        sync_directory(
            path.parent()
                .ok_or_else(|| Error::invalid("Missing parent directory"))?,
        )?;
        #[cfg(feature = "test-support")]
        test_storage_gate(path, "after-publish")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
pub fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn unlink_optional(path: &Path) -> Result<bool> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
fn is_update(name: &str) -> bool {
    name.len() == 20 && name.ends_with(".yjs") && name[..16].bytes().all(|b| b.is_ascii_digit())
}
fn temporary(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(prefix, suffix)| {
        suffix == "tmp"
            && prefix.rsplit_once('.').is_some_and(|(_, nonce)| {
                nonce.len() == 16
                    && nonce
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            })
    })
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct CleanupJournal {
    pub pending: Vec<String>,
    pub uploads: BTreeMap<String, Vec<String>>,
    pub owners: BTreeMap<String, Vec<String>>,
}

/// A capability produced only after the accepted bytes have reached durable storage.
/// HTTP/WebSocket code can acknowledge or broadcast this value; it cannot construct one.
pub struct DurableUpdate {
    bytes: Vec<u8>,
    corrected: bool,
    pub touched: Ids,
}
impl DurableUpdate {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn corrected(&self) -> bool {
        self.corrected
    }
}

/// All mutation requires exclusive access. The server owns one mutex per account and
/// holds its guard through persistence and publication, including maintenance and blobs.
pub struct Vault {
    pub(crate) doc: Doc,
    pub(crate) validation: ObservedDoc,
    pub(crate) snapshot_path: PathBuf,
    pub(crate) update_dir: PathBuf,
    pub(crate) blob_dir: PathBuf,
    pub(crate) update_files: Vec<String>,
    pub(crate) update_bytes: u64,
    next_update: u64,
    pub(crate) has_snapshot: bool,
    pub(crate) needs_compaction: bool,
    pub(crate) cleanup_path: PathBuf,
    pub(crate) cleanup: CleanupJournal,
    pub(crate) retention_path: PathBuf,
    pub(crate) retention: Schedule,
    pub history: History,
    pub history_error: Option<String>,
    pub history_capture_failures: Ids,
    pub pending_label_changes: BTreeMap<String, Value>,
    #[cfg(feature = "test-support")]
    pub(crate) validation_resets: u64,
}
impl Vault {
    pub fn open(directory: &Path, now: f64) -> Result<Self> {
        mkdir_durable(directory)?;
        let blob_dir = directory.join("blobs");
        mkdir_durable(&blob_dir)?;
        let update_dir = directory.join("updates");
        mkdir_durable(&update_dir)?;
        let snapshot_path = directory.join("vault.yjs");
        let doc = new_doc();
        let bytes = read_optional(&snapshot_path)?;
        let has_snapshot = bytes.is_some();
        if let Some(bytes) = bytes {
            apply(&doc, &bytes)?;
        }
        let mut names = fs::read_dir(&update_dir)?
            .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<std::io::Result<Vec<_>>>()?;
        names.sort();
        let mut update_files = Vec::new();
        let mut update_bytes = 0;
        let mut next_update = 1;
        for name in names {
            if name.len() == 41 && temporary(&name) && is_update(&name[..20]) {
                continue;
            }
            if !is_update(&name) {
                return Err(Error::invalid(format!(
                    "Unexpected vault update file: {name}"
                )));
            }
            let sequence = name[..16]
                .parse::<u64>()
                .map_err(|_| Error::invalid("Invalid vault update sequence"))?;
            if sequence == 0 || sequence > 9_007_199_254_740_991 {
                return Err(Error::invalid("Invalid vault update sequence"));
            }
            let bytes = fs::read(update_dir.join(&name))?;
            apply(&doc, &bytes)?;
            update_bytes += bytes.len() as u64;
            update_files.push(name);
            next_update = next_update.max(sequence + 1);
        }
        assert_current(&doc)?;
        let cleanup_path = directory.join("blob-cleanup.json");
        let cleanup: CleanupJournal = match read_optional(&cleanup_path)? {
            Some(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| Error::invalid("Invalid blob cleanup journal"))?,
            None => CleanupJournal::default(),
        };
        if cleanup.pending.iter().any(|s| !policy::is_hash(s))
            || cleanup
                .uploads
                .iter()
                .chain(cleanup.owners.iter())
                .any(|(hash, owners)| !policy::is_hash(hash) || owners.iter().any(String::is_empty))
        {
            return Err(Error::invalid("Invalid blob cleanup journal"));
        }
        let retention_path = directory.join("history-retention.json");
        let retention = Schedule::read(&retention_path)?;
        let mut vault = Self {
            doc,
            validation: ObservedDoc::new(new_doc()),
            snapshot_path,
            update_dir,
            blob_dir,
            update_files,
            update_bytes,
            next_update,
            has_snapshot,
            needs_compaction: false,
            cleanup_path,
            cleanup,
            retention_path,
            retention,
            history: History::open(&directory.join("history")),
            history_error: None,
            history_capture_failures: Ids::new(),
            pending_label_changes: BTreeMap::new(),
            #[cfg(feature = "test-support")]
            validation_resets: 0,
        };
        let deleted = policy::enforce_deletions(&vault.doc, None);
        policy::validate_candidates(&vault.doc)?;
        let manifests = vault.revoke_manifests(false)?;
        vault.sanitize_history(true);
        vault.remember_owners(&vault.references()?)?;
        if deleted || manifests || !keys(&vault.doc.transact(), "deletedNotes").is_empty() {
            vault.queue_cleanup(false)?;
            vault.compact()?;
            vault.clean_blobs()?;
        }
        apply(&vault.validation.doc, &encode(&vault.doc))?;
        vault.reconcile_retention(now)?;
        Ok(vault)
    }
    pub fn state(&self) -> Vec<u8> {
        encode(&self.doc)
    }
    pub fn state_vector(&self) -> Vec<u8> {
        vector(&self.doc)
    }
    pub fn sync(&self, vector: &yrs::StateVector) -> Vec<u8> {
        diff(&self.doc, vector)
    }
    pub fn accept(&mut self, update: &[u8], now: f64) -> Result<DurableUpdate> {
        self.persist(update, now, false, false)
    }
    pub(crate) fn persist(
        &mut self,
        update: &[u8],
        now: f64,
        server_owned: bool,
        compact: bool,
    ) -> Result<DurableUpdate> {
        let result = self.validate_and_write(update, now, server_owned, compact);
        if result.is_err() {
            self.validation = ObservedDoc::new(clone_doc(&self.doc)?);
            #[cfg(feature = "test-support")]
            {
                self.validation_resets += 1;
            }
        }
        let accepted = result?;
        apply(&self.doc, accepted.bytes())?;
        let deleted = !keys(&self.doc.transact(), "deletedNotes").is_empty();
        self.sanitize_history(deleted);
        self.clean_blobs()?;
        Ok(accepted)
    }
    fn validate_and_write(
        &mut self,
        update: &[u8],
        now: f64,
        server_owned: bool,
        compact: bool,
    ) -> Result<DurableUpdate> {
        let before = self.validation.doc.transact().state_vector();
        let deleted_before = keys(&self.validation.doc.transact(), "deletedNotes").len();
        let candidates_before =
            keys(&self.validation.doc.transact(), "deletedBlobCandidates").len();
        let had_pending = has_pending(&self.validation.doc);
        let (changes, emitted) = self.validation.apply(update)?;
        assert_current(&self.validation.doc)?;
        let mut ownership = policy::References::new();
        {
            let tx = self.validation.doc.transact();
            for (_, a) in entries(&tx, "attachments", Some(&changes)) {
                ownership
                    .entry(string(&a["hash"]).into())
                    .or_default()
                    .insert(string(&a["noteId"]).into());
            }
            for (id, source) in entries(&tx, "importSources", Some(&changes)) {
                if policy::is_hash(string(&source["manifestHash"])) {
                    ownership
                        .entry(string(&source["manifestHash"]).into())
                        .or_default()
                        .insert(format!("import:{id}"));
                }
            }
            for id in &changes.touched {
                let raw = field(&tx, "notes", id, "takeout")["rawHash"].clone();
                if policy::is_hash(string(&raw)) {
                    ownership
                        .entry(string(&raw).into())
                        .or_default()
                        .insert(id.clone());
                }
            }
        }
        let mut names = changes.ids("labelColors");
        names.extend(changes.ids("labelLifecycle"));
        for key in changes.ids("labelGenerationColors") {
            let key: Value = serde_json::from_str(&key)?;
            if let Some(name) = key[0].as_str() {
                names.insert(name.into());
            }
        }
        let mut label_changes = BTreeMap::new();
        for name in names {
            let before = history_state::label_setting(&self.doc, &name);
            let after = history_state::label_setting(&self.validation.doc, &name);
            if before != after {
                label_changes.insert(name.clone(),json!({"name":name,"type":if before["deleted"]!=after["deleted"]{"delete"}else{"color"},"before":before,"after":after}));
            }
        }
        if !server_owned {
            self.record_activity(&changes.touched, now)?;
        }
        let permanent = policy::enforce_deletions(&self.validation.doc, Some(&changes));
        policy::validate_candidates(&self.validation.doc)?;
        let mut corrected = permanent;
        let mut accepted = update.to_vec();
        if deleted_before > 0 {
            accepted = if has_pending(&self.validation.doc) {
                diff(&self.validation.doc, &before)
            } else if emitted.is_empty() {
                vec![0, 0]
            } else {
                yrs::merge_updates_v1(emitted.iter().map(Vec::as_slice))
                    .map_err(|e| Error::invalid(e.to_string()))?
            };
        }
        let deletion_changed = permanent
            || ((deleted_before > 0) && had_pending)
            || keys(&self.validation.doc.transact(), "deletedNotes").len() != deleted_before
            || keys(&self.validation.doc.transact(), "deletedBlobCandidates").len()
                != candidates_before;
        let manifests = if deletion_changed || changes.has("importSources") {
            self.revoke_manifests(true)?
        } else {
            false
        };
        self.remember_owners(&ownership)?;
        corrected |= manifests;
        if corrected {
            accepted = diff(&self.validation.doc, &before);
        }
        if deletion_changed || manifests || compact || self.needs_compaction {
            accepted = diff(&self.validation.doc, &before);
            self.queue_cleanup(true)?;
            self.needs_compaction = true;
            atomic_write(&self.snapshot_path, &encode(&self.validation.doc))?;
            self.has_snapshot = true;
            apply(&self.doc, &accepted)?;
            self.remove_update_files()?;
            self.needs_compaction = false;
        } else if !self.has_snapshot {
            atomic_write(&self.snapshot_path, &encode(&self.validation.doc))?;
            self.has_snapshot = true;
        } else {
            if self.update_files.len() >= 500 || self.update_bytes >= 4 * 1024 * 1024 {
                self.compact()?;
            }
            if self.next_update > 9_007_199_254_740_991 {
                return Err(Error::invalid("Vault update sequence exhausted"));
            }
            let filename = format!("{:016}.yjs", self.next_update);
            atomic_write(&self.update_dir.join(&filename), &accepted)?;
            self.update_files.push(filename);
            self.update_bytes += accepted.len() as u64;
            self.next_update += 1;
        }
        self.pending_label_changes.extend(label_changes);
        Ok(DurableUpdate {
            bytes: accepted,
            corrected,
            touched: changes.touched,
        })
    }
    pub fn compact(&mut self) -> Result<()> {
        atomic_write(&self.snapshot_path, &encode(&self.doc))?;
        self.has_snapshot = true;
        self.remove_update_files()
    }
    fn remove_update_files(&mut self) -> Result<()> {
        let mut names: Ids = self.update_files.iter().cloned().collect();
        for e in fs::read_dir(&self.update_dir)? {
            let name = e?.file_name().to_string_lossy().into_owned();
            if name.len() == 41 && temporary(&name) && is_update(&name[..20]) {
                names.insert(name);
            }
        }
        for name in names {
            unlink_optional(&self.update_dir.join(name))?;
        }
        sync_directory(&self.update_dir)?;
        self.update_files.clear();
        self.update_bytes = 0;
        let directory = self
            .snapshot_path
            .parent()
            .ok_or_else(|| Error::invalid("Missing snapshot directory"))?;
        let prefix = format!(
            "{}.",
            self.snapshot_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        );
        for e in fs::read_dir(directory)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(&prefix) && name.len() == prefix.len() + 20 && temporary(&name) {
                unlink_optional(&e.path())?;
            }
        }
        sync_directory(directory)
    }
    fn write_cleanup(&mut self, cleanup: CleanupJournal) -> Result<()> {
        if self.cleanup != cleanup {
            atomic_write(&self.cleanup_path, &serde_json::to_vec(&cleanup)?)?;
            self.cleanup = cleanup;
        }
        Ok(())
    }
    fn queue_cleanup(&mut self, validation: bool) -> Result<()> {
        let doc = if validation {
            &self.validation.doc
        } else {
            &self.doc
        };
        policy::validate_candidates(doc)?;
        let mut pending: Ids = self.cleanup.pending.iter().cloned().collect();
        pending.extend(keys(&doc.transact(), "deletedBlobCandidates"));
        pending.extend(self.history.garbage.iter().cloned());
        pending.extend(
            self.cleanup
                .owners
                .keys()
                .filter(|hash| self.owners_retired(doc, hash))
                .cloned(),
        );
        self.write_cleanup(CleanupJournal {
            pending: pending.into_iter().collect(),
            ..self.cleanup.clone()
        })
    }
    fn owner_retired(doc: &Doc, owner: &str) -> bool {
        let tx = doc.transact();
        if let Some(id) = owner.strip_prefix("import:") {
            root(&tx, "deletedImportSources").contains_key(&tx, id)
        } else {
            root(&tx, "deletedNotes").contains_key(&tx, owner)
        }
    }
    fn owners_retired(&self, doc: &Doc, hash: &str) -> bool {
        self.cleanup.owners.get(hash).is_some_and(|owners| {
            !owners.is_empty() && owners.iter().all(|id| Self::owner_retired(doc, id))
        })
    }
    fn references(&self) -> Result<policy::References> {
        let mut refs = policy::references(&self.doc);
        if self.history_error.is_none() {
            for (hash, owners) in self.history.references()? {
                refs.entry(hash).or_default().extend(owners);
            }
        }
        Ok(refs)
    }
    fn remember_owners(&mut self, refs: &policy::References) -> Result<()> {
        let mut cleanup = self.cleanup.clone();
        for (hash, ids) in refs {
            if !policy::is_hash(hash) {
                continue;
            }
            let mut combined: Ids = cleanup
                .owners
                .get(hash)
                .into_iter()
                .flatten()
                .cloned()
                .collect();
            combined.extend(ids.iter().cloned());
            cleanup
                .owners
                .insert(hash.clone(), combined.into_iter().collect());
        }
        self.write_cleanup(cleanup)
    }
    fn sanitize_history(&mut self, check_deleted: bool) {
        let result = (|| {
            self.history.ready()?;
            if check_deleted || self.history_error.is_some() {
                let deleted = keys(&self.doc.transact(), "deletedNotes");
                if !deleted.is_empty() {
                    self.history.remove_sources(&deleted)?;
                }
                self.queue_cleanup(false)?;
            }
            Ok::<_, Error>(())
        })();
        if let Err(e) = result {
            self.history_error = Some(e.to_string());
        }
    }
    pub fn cleanup_history_blobs(&mut self) -> Result<()> {
        self.queue_cleanup(false)?;
        self.clean_blobs()
    }
    fn revoke_manifests(&mut self, validation: bool) -> Result<bool> {
        let doc = if validation {
            &self.validation.doc
        } else {
            &self.doc
        };
        let tx = doc.transact();
        let deleted = keys(&tx, "deletedNotes");
        if deleted.is_empty() {
            return Ok(false);
        }
        let revoked = keys(&tx, "deletedImportSources");
        let mut removed = Vec::new();
        for (id, source) in entries(&tx, "importSources", None) {
            let hash = string(&source["manifestHash"]);
            if !policy::is_hash(hash) {
                continue;
            }
            if revoked.contains(&id) {
                removed.push((id, hash.to_owned()));
                continue;
            }
            let Some(bytes) = read_optional(&self.blob_dir.join(hash))? else {
                continue;
            };
            let manifest: Value = serde_json::from_slice(&bytes)?;
            if manifest["format"] != "stow-keep-source-v1" || !manifest["notes"].is_array() {
                return Err(Error::invalid("Invalid saved Google Keep source manifest"));
            }
            if array(&manifest["notes"]).iter().any(|n| {
                let digest = hex::encode(Sha256::digest(
                    serde_json::to_vec(&json!([id, "note", n["sourcePath"]])).expect("JSON"),
                ));
                deleted.contains(&format!("keep-{}", &digest[..32]))
            }) {
                removed.push((id, hash.to_owned()));
            }
        }
        drop(tx);
        let mut tx = doc.transact_mut();
        for (id, hash) in &removed {
            remove(&mut tx, "importSources", id);
            put(&mut tx, "deletedImportSources", id, json!(true));
            put(&mut tx, "deletedBlobCandidates", hash, json!(true));
        }
        Ok(!removed.is_empty())
    }
    pub fn reserve_upload(&mut self, hash: &str, source_ids: &[String]) -> Result<()> {
        if !policy::is_hash(hash) {
            return Err(Error::request(400, "Invalid attachment hash"));
        }
        let references = self.references()?;
        let owners: Ids = source_ids
            .iter()
            .filter(|s| !Self::owner_retired(&self.doc, s))
            .cloned()
            .collect();
        if (!source_ids.is_empty() && owners.is_empty())
            || (keys(&self.doc.transact(), "deletedBlobCandidates").contains(hash)
                && !references.contains_key(hash)
                && owners.is_empty())
        {
            return Err(Error::request(
                410,
                "This attachment belongs to a permanently deleted note.",
            ));
        }
        self.remember_owners(&BTreeMap::from([(hash.into(), owners.clone())]))?;
        let pending: Ids = owners
            .into_iter()
            .filter(|s| !references.get(hash).is_some_and(|r| r.contains(s)))
            .collect();
        if pending.is_empty() {
            return Ok(());
        }
        let mut cleanup = self.cleanup.clone();
        let mut all: Ids = cleanup
            .uploads
            .get(hash)
            .into_iter()
            .flatten()
            .cloned()
            .collect();
        all.extend(pending);
        cleanup
            .uploads
            .insert(hash.into(), all.into_iter().collect());
        self.write_cleanup(cleanup)
    }
    pub fn upload(&mut self, hash: &str, sources: &[String], bytes: &[u8]) -> Result<()> {
        self.reserve_upload(hash, sources)?;
        atomic_write(&self.blob_dir.join(hash), bytes)
    }
    fn clean_blobs(&mut self) -> Result<()> {
        if self.history_error.is_some() {
            return Ok(());
        }
        if self.cleanup.pending.is_empty() && self.cleanup.uploads.is_empty() {
            return Ok(());
        }
        let references = self.references()?;
        let tx = self.doc.transact();
        let deleted = keys(&tx, "deletedNotes");
        let receipts = keys(&tx, "imports");
        let uploads: BTreeMap<String, Vec<String>> = self
            .cleanup
            .uploads
            .iter()
            .filter_map(|(hash, owners)| {
                let pending: Vec<String> = owners
                    .iter()
                    .filter(|s| {
                        !deleted.contains(*s)
                            && !references.get(hash).is_some_and(|r| r.contains(*s))
                            && !s
                                .strip_prefix("import:")
                                .is_some_and(|id| receipts.contains(id))
                    })
                    .cloned()
                    .collect();
                (!pending.is_empty()).then(|| (hash.clone(), pending))
            })
            .collect();
        drop(tx);
        let mut pending = Vec::new();
        let mut owners = self.cleanup.owners.clone();
        let thumbnails = self
            .blob_dir
            .parent()
            .expect("vault directory")
            .join("thumbnails-v1");
        let mut blobs_changed = false;
        let mut thumbnails_changed = false;
        for hash in &self.cleanup.pending {
            if !policy::is_hash(hash) {
                return Err(Error::invalid("Invalid blob cleanup journal hash"));
            }
            if !self.owners_retired(&self.doc, hash) {
                continue;
            }
            if uploads.contains_key(hash) {
                pending.push(hash.clone());
                continue;
            }
            if references.contains_key(hash) {
                continue;
            }
            owners.remove(hash);
            blobs_changed |= unlink_optional(&self.blob_dir.join(hash))?;
            thumbnails_changed |= unlink_optional(&thumbnails.join(format!("{hash}.webp")))?;
        }
        if blobs_changed {
            sync_directory(&self.blob_dir)?;
        }
        if thumbnails_changed {
            sync_directory(&thumbnails)?;
        }
        self.write_cleanup(CleanupJournal {
            pending,
            uploads,
            owners,
        })
    }
}
