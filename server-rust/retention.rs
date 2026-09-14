use crate::{
    crdt::*,
    error::{Error, Result},
    storage::{Vault, atomic_write, read_optional},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};
use yrs::{Map, Out, Transact};
pub const HISTORY_GRACE_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
pub const HISTORY_SCAN_MS: u64 = 4 * 60 * 60 * 1000;
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Schedule {
    schema: u8,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compress_history: Option<bool>,
    pub quiet_since: BTreeMap<String, f64>,
}
impl Default for Schedule {
    fn default() -> Self {
        Self {
            schema: 1,
            enabled: false,
            compress_history: None,
            quiet_since: BTreeMap::new(),
        }
    }
}
impl Schedule {
    pub fn read(path: &Path) -> Result<Self> {
        let Some(bytes) = read_optional(path)? else {
            return Ok(Self::default());
        };
        let value: Self = serde_json::from_slice(&bytes)
            .map_err(|_| Error::invalid("Invalid history retention schedule"))?;
        if value.schema != 1
            || value
                .quiet_since
                .iter()
                .any(|(id, t)| id.is_empty() || !t.is_finite() || *t < 0.0)
        {
            return Err(Error::invalid("Invalid history retention schedule"));
        }
        Ok(value)
    }
}
pub fn archived_groups(doc: &yrs::Doc) -> Vec<Vec<String>> {
    let tx = doc.transact();
    let notes = root(&tx, "notes");
    let deleted = keys(&tx, "deletedNotes");
    let mut parents: BTreeMap<String, String> = keys(&tx, "notes")
        .union(&deleted)
        .map(|s| (s.clone(), s.clone()))
        .collect();
    fn root_id(parents: &BTreeMap<String, String>, id: &str) -> String {
        let mut id = id;
        while let Some(next) = parents.get(id) {
            if next == id {
                break;
            }
            id = next;
        }
        id.into()
    }
    for (_, edge) in entries(&tx, "merges", None) {
        let a = string(&edge["a"]);
        let b = string(&edge["b"]);
        if parents.contains_key(a) && parents.contains_key(b) {
            let a = root_id(&parents, a);
            let b = root_id(&parents, b);
            parents.insert(b, a);
        }
    }
    let mut groups = BTreeMap::<String, Vec<String>>::new();
    for (id, note) in notes.iter(&tx) {
        if matches!(note, Out::YMap(_)) && !deleted.contains(id) {
            groups
                .entry(root_id(&parents, id))
                .or_default()
                .push(id.into());
        }
    }
    let mut groups: Vec<_> = groups
        .into_values()
        .filter(|g| {
            g.iter()
                .all(|id| truthy(&field(&tx, "notes", id, "archived")))
                && !g
                    .iter()
                    .all(|id| truthy(&field(&tx, "notes", id, "trashed")))
        })
        .map(|mut g| {
            g.sort();
            g
        })
        .collect();
    groups.sort();
    groups
}
pub fn selection_token(vault: &Vault, source_ids: &[String]) -> Result<String> {
    let fingerprint = vault.history.fingerprint(source_ids)?;
    Ok(selection_token_parts(
        &vault.doc,
        source_ids,
        &vault.retention.quiet_since,
        &fingerprint,
    ))
}
pub fn selection_token_parts(
    doc: &yrs::Doc,
    source_ids: &[String],
    quiet_since: &BTreeMap<String, f64>,
    fingerprint: &str,
) -> String {
    let selected: Ids = source_ids.iter().cloned().collect();
    let tx = doc.transact();
    let mut digest = Sha256::new();
    let joins: Ids = entries(&tx, "mergeRecipes", None)
        .iter()
        .filter(|(_, v)| {
            strings(&v["sourceIds"])
                .iter()
                .any(|s| selected.contains(s))
        })
        .flat_map(|(_, v)| {
            array(&v["body"])
                .iter()
                .filter(|r| r["field"] == "join")
                .map(|r| string(&r["joinId"]).to_owned())
        })
        .collect();
    let mut put = |kind: &str, id: &str, v: Value| {
        digest.update(serde_json::to_vec(&json!([kind, id, v])).expect("JSON"))
    };
    for id in &selected {
        put("note", id, get(&tx, "notes", id));
        put("observed", id, json!(quiet_since.get(id)));
    }
    for name in [
        "items",
        "attachments",
        "merges",
        "mergeRecipes",
        "textJoins",
    ] {
        let mut entries = entries(&tx, name, None);
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (id, v) in entries {
            let include = match name {
                "items" | "attachments" => selected.contains(string(&v["noteId"])),
                "merges" => {
                    selected.contains(string(&v["a"])) || selected.contains(string(&v["b"]))
                }
                "mergeRecipes" => strings(&v["sourceIds"])
                    .iter()
                    .any(|s| selected.contains(s)),
                _ => joins.contains(&id),
            };
            if include {
                put(name, &id, v);
            }
        }
    }
    put("history", "", json!(fingerprint));
    hex::encode(digest.finalize())
}
fn directory_bytes(path: &Path) -> Result<u64> {
    let entries = match fs::read_dir(path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let mut bytes = 0;
    for entry in entries {
        let e = entry?;
        if e.file_type()?.is_file() && !e.file_name().to_string_lossy().ends_with(".tmp") {
            bytes += e.metadata()?.len();
        }
    }
    Ok(bytes)
}
pub struct Cleaned {
    pub source_ids: Vec<String>,
    pub cleaned_note_count: usize,
}
impl Vault {
    fn save_schedule(&mut self, schedule: Schedule) -> Result<()> {
        if schedule != self.retention {
            atomic_write(&self.retention_path, &serde_json::to_vec(&schedule)?)?;
            self.retention = schedule;
        }
        Ok(())
    }
    pub fn set_retention(&mut self, enabled: bool, now: f64) -> Result<()> {
        if enabled == self.retention.enabled {
            return Ok(());
        }
        let quiet_since = if enabled {
            archived_groups(&self.doc)
                .into_iter()
                .flatten()
                .map(|id| (id, now))
                .collect()
        } else {
            BTreeMap::new()
        };
        self.save_schedule(Schedule {
            schema: 1,
            enabled,
            quiet_since,
            compress_history: self.retention.compress_history,
        })
    }
    pub(crate) fn record_activity(&mut self, touched: &Ids, now: f64) -> Result<()> {
        if !self.retention.enabled || touched.is_empty() {
            return Ok(());
        }
        if !touched.iter().any(|id| {
            self.retention.quiet_since.contains_key(id)
                || truthy(&field(
                    &self.validation.doc.transact(),
                    "notes",
                    id,
                    "archived",
                ))
        }) {
            return Ok(());
        }
        let mut quiet_since = BTreeMap::new();
        for group in archived_groups(&self.validation.doc) {
            let changed = group
                .iter()
                .any(|id| touched.contains(id) || !self.retention.quiet_since.contains_key(id));
            for id in group {
                let old = *self.retention.quiet_since.get(&id).unwrap_or(&0.0);
                quiet_since.insert(id, if changed { now.max(old) } else { old });
            }
        }
        self.save_schedule(Schedule {
            schema: 1,
            enabled: true,
            quiet_since,
            compress_history: self.retention.compress_history,
        })
    }
    pub(crate) fn reconcile_retention(&mut self, now: f64) -> Result<()> {
        if !self.retention.enabled {
            return Ok(());
        }
        let mut quiet_since = BTreeMap::new();
        for group in archived_groups(&self.doc) {
            let fresh = group
                .iter()
                .any(|id| !self.retention.quiet_since.contains_key(id));
            for id in group {
                let time = if fresh {
                    now
                } else {
                    self.retention.quiet_since[&id]
                };
                quiet_since.insert(id, time);
            }
        }
        self.save_schedule(Schedule {
            schema: 1,
            enabled: true,
            quiet_since,
            compress_history: self.retention.compress_history,
        })
    }
    pub fn storage(&self) -> Result<Value> {
        let groups = archived_groups(&self.doc);
        let mut sources: Vec<_> = groups.iter().flatten().cloned().collect();
        sources.sort();
        let snapshot = if self.has_snapshot {
            fs::metadata(&self.snapshot_path)?.len()
        } else {
            0
        };
        Ok(
            json!({"crdtBytes":encode(&self.doc).len(),"durableBytes":snapshot+self.update_bytes,"historyBytes":self.history.bytes()?,"historyCount":self.history.count()?,"originalsBytes":directory_bytes(&self.blob_dir)?,"thumbnailsBytes":directory_bytes(&self.blob_dir.parent().expect("vault directory").join("thumbnails-v1"))?,"archivedNoteCount":groups.len(),"archivedSourceIds":sources,"archivedSelectionToken":selection_token(self,&sources)?,"retention":{"enabled":self.retention.enabled,"graceDays":7,"scanHours":4},"compression":{"enabled":self.retention.compress_history.unwrap_or(true),"limit":100,"recent":50,"older":25}}),
        )
    }
    pub fn discard_history(
        &mut self,
        sources: &[String],
        token: Option<&str>,
        now: f64,
    ) -> Result<Cleaned> {
        let selected: Ids = sources.iter().cloned().collect();
        let groups: Vec<_> = archived_groups(&self.doc)
            .into_iter()
            .filter(|g| g.iter().any(|id| selected.contains(id)))
            .collect();
        let actual: Ids = groups.iter().flatten().cloned().collect();
        if actual != selected
            || (token.is_some() && token != Some(selection_token(self, sources)?.as_str()))
        {
            return Err(Error::selection());
        }
        let history = self.history.sources()?;
        let clean: Vec<_> = groups
            .into_iter()
            .filter(|g| g.iter().any(|id| history.contains(id)))
            .collect();
        if clean.is_empty() {
            return Ok(Cleaned {
                source_ids: vec![],
                cleaned_note_count: 0,
            });
        }
        let source_ids = clean.iter().flatten().cloned().collect::<Vec<_>>();
        if let Err(e) = self
            .history
            .discard(&source_ids, now)
            .and_then(|_| self.cleanup_history_blobs())
        {
            self.history_error = Some(e.to_string());
            return Err(e);
        }
        Ok(Cleaned {
            source_ids,
            cleaned_note_count: clean.len(),
        })
    }
    pub fn set_compression(&mut self, enabled: bool) -> Result<()> {
        self.save_schedule(Schedule {
            compress_history: Some(enabled),
            ..self.retention.clone()
        })?;
        if enabled {
            let result = (|| {
                for ids in crate::history_state::groups(&self.doc) {
                    self.history.thin(&ids)?;
                }
                self.cleanup_history_blobs()
            })();
            if let Err(e) = result {
                self.history_error = Some(e.to_string());
                return Err(e);
            }
        }
        Ok(())
    }
    pub fn sweep(&mut self, now: f64) -> Result<Option<Cleaned>> {
        if !self.retention.enabled {
            return Ok(None);
        }
        self.reconcile_retention(now)?;
        let history = self.history.sources()?;
        let sources: Vec<_> = archived_groups(&self.doc)
            .into_iter()
            .filter(|g| {
                g.iter().any(|id| history.contains(id))
                    && g.iter()
                        .all(|id| now - self.retention.quiet_since[id] >= HISTORY_GRACE_MS)
            })
            .flatten()
            .collect();
        if sources.is_empty() {
            Ok(None)
        } else {
            self.discard_history(&sources, None, now).map(Some)
        }
    }
}
