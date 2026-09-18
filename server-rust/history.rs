use crate::{
    crdt::*,
    error::{Error, Result},
    history_state as state,
    policy::{self, References},
    storage::{Vault, atomic_write, mkdir_durable, read_optional, sync_directory},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

pub fn hash(value: &Value) -> String {
    hex::encode(Sha256::digest(value.to_string().as_bytes()))
}
fn unavailable(error: impl ToString) -> Error {
    Error::Request {
        status: 503,
        code: Some("history_unavailable"),
        message: error.to_string(),
    }
}
struct Indexed {
    summary: Value,
    fingerprint: String,
    blobs: References,
}
struct Bundle {
    bytes: u64,
    records: Vec<Indexed>,
}
pub struct History {
    pub directory: PathBuf,
    bundles: BTreeMap<String, Bundle>,
    by_source: BTreeMap<String, Ids>,
    pub discarded: BTreeMap<String, f64>,
    pub garbage: Ids,
    pub error: Option<String>,
    #[cfg(any(test, feature = "test-support"))]
    pub faults: Ids,
    #[cfg(any(test, feature = "test-support"))]
    pub scans: BTreeMap<String, usize>,
}
impl History {
    pub fn open(directory: &Path) -> Self {
        let mut h = Self {
            directory: directory.into(),
            bundles: BTreeMap::new(),
            by_source: BTreeMap::new(),
            discarded: BTreeMap::new(),
            garbage: Ids::new(),
            error: None,
            #[cfg(any(test, feature = "test-support"))]
            faults: Ids::new(),
            #[cfg(any(test, feature = "test-support"))]
            scans: BTreeMap::new(),
        };
        let _ = h.reload();
        h
    }
    pub fn ready(&self) -> Result<()> {
        if let Some(e) = &self.error {
            Err(unavailable(e))
        } else {
            Ok(())
        }
    }
    fn fault(&self, name: &str) -> Result<()> {
        #[cfg(any(test, feature = "test-support"))]
        if self.faults.contains(name) {
            return Err(std::io::Error::from_raw_os_error(28).into());
        }
        let _ = name;
        Ok(())
    }
    pub fn reload(&mut self) -> Result<()> {
        self.bundles.clear();
        self.by_source.clear();
        self.discarded.clear();
        self.garbage.clear();
        self.error = None;
        let result = self.initialize();
        if let Err(e) = &result {
            self.error = Some(e.to_string());
        }
        result.map_err(unavailable)
    }
    fn temporary(name: &str) -> bool {
        let Some((prefix, tail)) = name.split_once(".json.") else {
            return false;
        };
        let Some(nonce) = tail.strip_suffix(".tmp") else {
            return false;
        };
        (policy::is_hash(prefix) || ["discarded", "garbage"].contains(&prefix))
            && nonce.len() == 16
            && nonce
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }
    fn initialize(&mut self) -> Result<()> {
        mkdir_durable(&self.directory)?;
        if let Some(bytes) = read_optional(&self.directory.join("garbage.json"))? {
            let value: Value = serde_json::from_slice(&bytes)?;
            if !value.is_array() || array(&value).iter().any(|h| !policy::is_hash(string(h))) {
                return Err(Error::invalid(
                    "Invalid saved-history image cleanup metadata",
                ));
            }
            self.garbage = strings(&value).into_iter().collect();
        }
        if let Some(bytes) = read_optional(&self.directory.join("discarded.json"))? {
            let v: Value = serde_json::from_slice(&bytes)?;
            if v["schema"] != 1
                || !v["sources"].is_object()
                || object(&v["sources"]).any(|(_, t)| !t.as_f64().is_some_and(f64::is_finite))
            {
                return Err(Error::invalid("Invalid saved-history cleanup metadata"));
            }
            self.discarded = object(&v["sources"])
                .map(|(id, t)| (id.clone(), number(t)))
                .collect();
        }
        let names = fs::read_dir(&self.directory)?
            .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<std::io::Result<Vec<_>>>()?;
        for name in names {
            if ["garbage.json", "discarded.json"].contains(&name.as_str()) || Self::temporary(&name)
            {
                continue;
            }
            let key = name
                .strip_suffix(".json")
                .filter(|k| policy::is_hash(k))
                .ok_or_else(|| Error::invalid("Unexpected saved-history file"))?;
            let records = self.read_bundle(key)?;
            let cleaned = records
                .iter()
                .filter_map(|r| {
                    let removed = strings(&r["sourceIds"])
                        .into_iter()
                        .filter(|s| {
                            number(&r["recordedAt"])
                                <= *self.discarded.get(s).unwrap_or(&f64::NEG_INFINITY)
                        })
                        .collect();
                    self.redact(r, &removed).transpose()
                })
                .collect::<Result<Vec<_>>>()?;
            self.index(
                key,
                &records,
                json!({"schema":1,"versions":records}).to_string().len() as u64,
            );
            if cleaned != records {
                self.write_bundle(key, &cleaned)?;
            }
        }
        self.remove_temporaries()
    }
    fn remove_temporaries(&self) -> Result<()> {
        let mut removed = false;
        for entry in fs::read_dir(&self.directory)? {
            let e = entry?;
            if Self::temporary(&e.file_name().to_string_lossy()) {
                fs::remove_file(e.path())?;
                removed = true;
            }
        }
        if removed {
            sync_directory(&self.directory)?;
        }
        Ok(())
    }
    fn read_bundle(&self, key: &str) -> Result<Vec<Value>> {
        let bytes = fs::read(self.directory.join(format!("{key}.json")))?;
        let v: Value = serde_json::from_slice(&bytes)
            .map_err(|e| Error::invalid(format!("Invalid JSON in saved history: {e}")))?;
        if v["schema"] != 1
            || !v["versions"].is_array()
            || array(&v["versions"]).iter().any(|r| {
                r["schema"] != 1
                    || !string(&r["id"]).starts_with(&format!("{key}."))
                    || !r["sourceIds"].is_array()
                    || !r["state"]["sources"].is_object()
                    || !r["state"]["groups"].is_array()
                    || !r["timestamp"].as_f64().is_some_and(f64::is_finite)
                    || !r["recordedAt"].as_f64().is_some_and(f64::is_finite)
            })
        {
            return Err(Error::invalid("Invalid saved-history bundle"));
        }
        Ok(array(&v["versions"]).to_vec())
    }
    fn index(&mut self, key: &str, records: &[Value], bytes: u64) {
        if let Some(old) = self.bundles.remove(key) {
            for r in old.records {
                for source in strings(&r.summary["sourceIds"]) {
                    if let Some(keys) = self.by_source.get_mut(&source) {
                        keys.remove(key);
                        if keys.is_empty() {
                            self.by_source.remove(&source);
                        }
                    }
                }
            }
        }
        if records.is_empty() {
            return;
        }
        let records=records.iter().map(|r|{let mut summary=r.clone();if let Some(s)=summary.as_object_mut(){for key in ["schema","state","action","labelSettings"]{s.remove(key);}}
            let mut blobs=References::new();for (source,s) in object(&r["state"]["sources"]){for (_,image) in object(&s["images"]){blobs.entry(string(&image["hash"]).into()).or_default().insert(source.clone());}}
            for source in strings(&r["sourceIds"]){self.by_source.entry(source).or_default().insert(key.into());}
            Indexed{summary,fingerprint:hash(&json!({"state":r["state"],"labelSettings":r.get("labelSettings").unwrap_or(&json!({}))})),blobs}
        }).collect();
        self.bundles.insert(key.into(), Bundle { bytes, records });
    }
    fn write_bundle(&mut self, key: &str, records: &[Value]) -> Result<()> {
        self.fault("writeBundle")?;
        let retained: Ids = records
            .iter()
            .flat_map(|r| {
                object(&r["state"]["sources"]).flat_map(|(_, s)| {
                    object(&s["images"]).map(|(_, a)| string(&a["hash"]).to_owned())
                })
            })
            .collect();
        let mut garbage = self.garbage.clone();
        if let Some(old) = self.bundles.get(key) {
            for r in &old.records {
                for hash in r.blobs.keys() {
                    if !retained.contains(hash) {
                        garbage.insert(hash.clone());
                    }
                }
            }
        }
        if garbage != self.garbage {
            atomic_write(
                &self.directory.join("garbage.json"),
                &serde_json::to_vec(&garbage)?,
            )?;
            self.garbage = garbage;
        }
        let bytes = serde_json::to_vec(&json!({"schema":1,"versions":records}))?;
        let path = self.directory.join(format!("{key}.json"));
        if records.is_empty() {
            fs::remove_file(path)?;
            sync_directory(&self.directory)?;
        } else {
            atomic_write(&path, &bytes)?;
        }
        self.index(key, records, bytes.len() as u64);
        Ok(())
    }
    fn keys_for(&self, sources: &Ids) -> Ids {
        sources
            .iter()
            .flat_map(|s| self.by_source.get(s).into_iter().flatten().cloned())
            .collect()
    }
    fn redact(&self, r: &Value, removed: &Ids) -> Result<Option<Value>> {
        if removed.is_empty() {
            return Ok(Some(r.clone()));
        }
        let state = state::redact(&r["state"], removed);
        let ids: Vec<_> = object(&state["sources"])
            .map(|(id, _)| id.clone())
            .collect();
        if ids.is_empty() {
            return Ok(None);
        }
        let note = array(&state["groups"])
            .first()
            .and_then(|g| array(g).first())
            .and_then(Value::as_str)
            .unwrap_or(&ids[0]);
        let mut kept = r.clone();
        for key in ["action", "labelChange", "kind", "labelSettings"] {
            kept.as_object_mut()
                .ok_or_else(|| Error::invalid("Invalid history record"))?
                .remove(key);
        }
        kept["sourceIds"] = json!(ids);
        kept["noteId"] = json!(note);
        kept["title"] = json!(state::text(&state, note)?.0);
        kept["label"] = json!("Saved note");
        if r.get("labelSettings").is_some() {
            let names: Ids = object(&state["sources"])
                .flat_map(|(_, s)| strings(&s["labels"]))
                .collect();
            kept["labelSettings"] = Value::Object(
                object(&r["labelSettings"])
                    .filter(|(n, _)| names.contains(*n))
                    .map(|(n, v)| (n.clone(), v.clone()))
                    .collect(),
            );
        }
        kept["state"] = state;
        Ok(Some(kept))
    }
    pub fn bytes(&self) -> Result<u64> {
        self.ready()?;
        Ok(self.bundles.values().map(|b| b.bytes).sum())
    }
    pub fn count(&self) -> Result<usize> {
        self.ready()?;
        Ok(self.bundles.values().map(|b| b.records.len()).sum())
    }
    pub fn sources(&self) -> Result<Ids> {
        self.ready()?;
        self.fault("sourcesWithHistory")?;
        Ok(self.by_source.keys().cloned().collect())
    }
    pub fn references(&self) -> Result<References> {
        self.ready()?;
        self.fault("blobReferences")?;
        let mut refs = References::new();
        for r in self.bundles.values().flat_map(|b| &b.records) {
            for (hash, owners) in &r.blobs {
                refs.entry(hash.clone())
                    .or_default()
                    .extend(owners.iter().cloned());
            }
        }
        Ok(refs)
    }
    pub fn fingerprint(&self, sources: &[String]) -> Result<String> {
        self.ready()?;
        let selected: Ids = sources.iter().cloned().collect();
        Ok(hash(&json!(
            self.keys_for(&selected)
                .iter()
                .flat_map(|key| self.bundles[key]
                    .records
                    .iter()
                    .filter(|r| strings(&r.summary["sourceIds"])
                        .iter()
                        .any(|id| selected.contains(id)))
                    .map(|r| &r.summary))
                .collect::<Vec<_>>()
        )))
    }
    pub fn list(&self, sources: &[String], cursor: Option<&str>, limit: usize) -> Result<Value> {
        self.ready()?;
        self.fault("list")?;
        let selected: Ids = sources.iter().cloned().collect();
        let mut records: Vec<_> = self
            .keys_for(&selected)
            .iter()
            .flat_map(|key| self.bundles[key].records.iter().map(|r| r.summary.clone()))
            .filter(|r| {
                strings(&r["sourceIds"])
                    .iter()
                    .any(|s| selected.contains(s))
            })
            .collect();
        records.sort_by(|a, b| {
            number(&b["recordedAt"])
                .total_cmp(&number(&a["recordedAt"]))
                .then(string(&b["id"]).cmp(string(&a["id"])))
        });
        let offset = if let Some(cursor) = cursor {
            records
                .iter()
                .position(|r| r["id"] == cursor)
                .map(|p| p + 1)
                .ok_or_else(|| Error::request(409, "History changed; reload the list."))?
        } else {
            0
        };
        let versions: Vec<_> = records.iter().skip(offset).take(limit).cloned().collect();
        let mut page = json!({"versions":versions});
        if offset + limit < records.len() {
            page["nextCursor"] = versions
                .last()
                .ok_or_else(|| Error::invalid("Invalid page size"))?["id"]
                .clone();
        }
        let discarded = sources
            .iter()
            .filter_map(|s| self.discarded.get(s))
            .copied()
            .fold(0.0, f64::max);
        if discarded > 0.0 {
            page["discardedAt"] = json!(discarded);
        }
        Ok(page)
    }
    pub fn get(&self, id: &str) -> Result<Option<Value>> {
        self.ready()?;
        let Some((key, suffix)) = id.split_once('.') else {
            return Ok(None);
        };
        if !policy::is_hash(key)
            || suffix.len() != 32
            || !suffix
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || !self.bundles.contains_key(key)
        {
            return Ok(None);
        }
        Ok(self.read_bundle(key)?.into_iter().find(|r| r["id"] == id))
    }
    pub fn export(&self) -> Result<Value> {
        self.ready()?;
        self.fault("export")?;
        let mut versions = Vec::new();
        for key in self.bundles.keys() {
            versions.extend(self.read_bundle(key)?);
        }
        Ok(json!({"schema":1,"versions":versions,"discardedAt":self.discarded}))
    }
    pub fn capture(
        &mut self,
        state: &Value,
        boundary: &Value,
        now: f64,
        settings: &Value,
        observed: Option<&Value>,
        compress: bool,
    ) -> Result<bool> {
        self.ready()?;
        let ids: Vec<_> = object(&state["sources"])
            .map(|(id, _)| id.clone())
            .collect();
        if ids.is_empty() {
            return Ok(false);
        }
        let key = hash(&json!(ids));
        let previous = self.bundles.get(&key).and_then(|b| b.records.last());
        if previous.is_some_and(|r| {
            r.fingerprint == hash(&json!({"state":state,"labelSettings":settings}))
        }) {
            return if compress { self.thin(&ids) } else { Ok(false) };
        }
        let mut records = if self.bundles.contains_key(&key) {
            self.read_bundle(&key)?
        } else {
            vec![]
        };
        let now = ids
            .iter()
            .filter_map(|s| self.discarded.get(s))
            .fold(now, |n, t| n.max(t + 1.0))
            .max(
                records
                    .last()
                    .map(|r| number(&r["recordedAt"]) + 1.0)
                    .unwrap_or(0.0),
            );
        let empty = json!({"sources":{},"groups":[]});
        let mut record = state::make_version(
            state,
            boundary,
            now,
            &format!("{key}.{}", hex::encode(rand::random::<[u8; 16]>())),
            records.last().map(|r| &r["state"]).unwrap_or(&empty),
        )?;
        if object(settings).next().is_some() {
            record["labelSettings"] = settings.clone();
        }
        let hint = &boundary["labelSetting"];
        let name = string(&hint["name"]);
        let before = records
            .last()
            .map(|r| r["labelSettings"][name].clone())
            .unwrap_or(Value::Null);
        let after = &settings[name];
        let derived = if !before.is_null() && !after.is_null() && before != *after {
            Some(json!({"name":name,"type":hint["type"],"before":before,"after":after}))
        } else {
            None
        };
        if let Some(change) = observed.or(derived.as_ref()) {
            record["kind"] = json!("label");
            record["labelChange"] = change.clone();
            record["label"] = json!(if change["type"] == "color" {
                format!(
                    "Label: colored {} {}",
                    state::quote(string(&change["name"])),
                    string(&change["after"]["color"])
                )
            } else {
                format!("Label: deleted {}", state::quote(string(&change["name"])))
            });
        } else {
            record["kind"] = json!("snapshot");
        }
        records.push(record);
        self.write_bundle(&key, &records)?;
        if compress {
            self.thin(&ids)?;
        }
        Ok(true)
    }
    pub fn thin(&mut self, sources: &[String]) -> Result<bool> {
        self.ready()?;
        self.fault("thin")?;
        let selected: Ids = sources.iter().cloned().collect();
        let keys = self.keys_for(&selected);
        let count: usize = keys
            .iter()
            .map(|k| {
                self.bundles[k]
                    .records
                    .iter()
                    .filter(|r| {
                        strings(&r.summary["sourceIds"])
                            .iter()
                            .any(|id| selected.contains(id))
                    })
                    .count()
            })
            .sum();
        if count <= 100 {
            return Ok(false);
        }
        let mut bundles = BTreeMap::new();
        for key in &keys {
            bundles.insert(key.clone(), self.read_bundle(key)?);
        }
        let all = bundles
            .values()
            .flatten()
            .filter(|r| {
                strings(&r["sourceIds"])
                    .iter()
                    .any(|id| selected.contains(id))
            })
            .cloned()
            .collect();
        let kept: BTreeMap<String, Value> = state::thin(all)
            .into_iter()
            .map(|r| (string(&r["id"]).into(), r))
            .collect();
        for (key, records) in bundles {
            let mut next = Vec::new();
            for r in &records {
                if !strings(&r["sourceIds"])
                    .iter()
                    .any(|id| selected.contains(id))
                {
                    next.push(r.clone());
                } else if let Some(r) = kept.get(string(&r["id"])) {
                    next.push(r.clone());
                } else if let Some(r) = self.redact(r, &selected)? {
                    next.push(r);
                }
            }
            if next != records {
                self.write_bundle(&key, &next)?;
            }
        }
        Ok(true)
    }
    pub fn discard(&mut self, sources: &[String], now: f64) -> Result<()> {
        self.ready()?;
        self.fault("discard")?;
        let selected: Ids = sources.iter().cloned().collect();
        let latest = self
            .keys_for(&selected)
            .iter()
            .flat_map(|k| &self.bundles[k].records)
            .fold(now, |n, r| n.max(number(&r.summary["recordedAt"])));
        let mut discarded = self.discarded.clone();
        for s in sources {
            let time = latest.max(*discarded.get(s).unwrap_or(&0.0));
            discarded.insert(s.clone(), time);
        }
        atomic_write(
            &self.directory.join("discarded.json"),
            &serde_json::to_vec(&json!({"schema":1,"sources":discarded}))?,
        )?;
        self.discarded = discarded;
        self.remove_sources(&selected)
    }
    pub fn remove_sources(&mut self, removed: &Ids) -> Result<()> {
        self.ready()?;
        for key in self.keys_for(removed) {
            let records = self.read_bundle(&key)?;
            let mut next = Vec::new();
            for r in &records {
                if let Some(r) = self.redact(r, removed)? {
                    next.push(r);
                }
            }
            if records != next {
                self.write_bundle(&key, &next)?;
            }
        }
        if !removed.is_empty() {
            self.remove_temporaries()?;
        }
        Ok(())
    }
}
impl Vault {
    pub fn recover_history(&mut self) -> Result<()> {
        if self.history_error.is_some() {
            self.history.reload()?;
            self.history
                .remove_sources(&keys(&self.doc.transact(), "deletedNotes"))?;
        }
        self.history.ready()?;
        self.history_error = None;
        Ok(())
    }
    pub fn capture_history(&mut self, boundary: &Value, now: f64) -> Result<Vec<String>> {
        #[cfg(test)]
        if self.history.faults.remove("panicCapture") {
            // Prove recovery discards memory mutated before unwinding.
            crate::crdt::put(
                &mut self.doc.transact_mut(),
                "notes",
                "panic-only",
                json!({"body":"Not durable"}),
            );
            panic!("Injected history capture panic");
        }
        self.recover_history()?;
        let selected: Ids = strings(&boundary["sourceIds"]).into_iter().collect();
        let groups = state::groups(&self.doc);
        let mut changed = Ids::new();
        for ids in groups
            .into_iter()
            .filter(|g| g.iter().any(|s| selected.contains(s)))
        {
            let snapshot = state::capture(&self.doc, &ids)?;
            let mut names: Ids = object(&snapshot["sources"])
                .flat_map(|(_, s)| strings(&s["labels"]))
                .collect();
            let hint = &boundary["labelSetting"];
            let name = string(&hint["name"]);
            if !name.is_empty() {
                names.insert(name.into());
            }
            let settings: serde_json::Map<_, _> = names
                .into_iter()
                .map(|n| {
                    let v = state::label_setting(&self.doc, &n);
                    (n, v)
                })
                .collect();
            let mut boundary = boundary.clone();
            boundary["sourceIds"] = json!(ids);
            if self.history.capture(
                &snapshot,
                &boundary,
                now,
                &Value::Object(settings),
                self.pending_label_changes.get(name),
                self.retention.compress_history.unwrap_or(true),
            )? {
                changed.extend(ids.iter().cloned());
            }
            for id in &ids {
                self.history_capture_failures.remove(id);
            }
        }
        if let Some(name) = boundary["labelSetting"]["name"].as_str() {
            self.pending_label_changes.remove(name);
        }
        self.history_error = None;
        Ok(changed.into_iter().collect())
    }
    pub fn history_read<T>(&mut self, op: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        let result = self.recover_history().and_then(|_| op(self));
        if let Err(e) = &result
            && !matches!(
                e,
                Error::Request {
                    status: 400..=499,
                    ..
                }
            )
        {
            self.history_error = Some(e.to_string());
            return Err(unavailable(e));
        }
        result
    }
}
use yrs::Transact;
