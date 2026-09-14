use crate::error::{Error, Result};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};
use yrs::{
    DeepObservable, Doc, Map, MapRef, OffsetKind, Options, Out, ReadTxn, StateVector, Subscription,
    Transact, TransactionMut, Update,
    types::{EntryChange, Event, PathSegment, ToJson},
    updates::{decoder::Decode, encoder::Encode},
};

pub const CURRENT_SCHEMA: &str = "stow-current-v1";
pub const ROOTS: &[&str] = &[
    "notes",
    "items",
    "attachments",
    "merges",
    "mergeRecipes",
    "textJoins",
    "textJoinSources",
    "deletedNotes",
    "deletedTextJoins",
    "deletedBlobCandidates",
    "importSources",
    "imports",
    "deletedImportSources",
    "labelColors",
    "labelLifecycle",
    "labelGenerationColors",
];
pub const OLD_ROOTS: &[&str] = &[
    "revisions",
    "revisionBuckets",
    "deletedRevisionIds",
    "historyCuts",
    "historyEpochs",
    "historyPruning",
];
pub fn assert_current(doc: &Doc) -> Result<()> {
    let tx = doc.transact();
    for name in OLD_ROOTS {
        // Empty root declarations are not encoded in Yjs updates. A decoded
        // legacy root therefore represents saved history, even if its last key
        // was deleted. Counting live entries would admit that older schema.
        if tx.get_map(*name).is_some() {
            return Err(Error::invalid(
                "This vault contains an older history format with replicated saved versions. Open a freshly imported vault with the current Stow version.",
            ));
        }
    }
    Ok(())
}
pub type Ids = BTreeSet<String>;
#[cfg(any(test, feature = "test-support"))]
thread_local! { static SCANS: std::cell::RefCell<BTreeMap<String,usize>> = const { std::cell::RefCell::new(BTreeMap::new()) }; }
#[cfg(any(test, feature = "test-support"))]
pub fn take_scans() -> BTreeMap<String, usize> {
    SCANS.with(|v| std::mem::take(&mut *v.borrow_mut()))
}
fn record_scan(name: &str) {
    #[cfg(any(test, feature = "test-support"))]
    SCANS.with(|v| *v.borrow_mut().entry(name.into()).or_default() += 1);
    #[cfg(not(any(test, feature = "test-support")))]
    let _ = name;
}
#[derive(Default, Clone)]
pub struct Changes {
    pub keys: BTreeMap<String, Ids>,
    pub touched: Ids,
}
impl Changes {
    pub fn has(&self, name: &str) -> bool {
        self.keys.get(name).is_some_and(|v| !v.is_empty())
    }
    pub fn ids(&self, name: &str) -> Ids {
        self.keys.get(name).cloned().unwrap_or_default()
    }
}

pub fn new_doc() -> Doc {
    let doc = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    for name in ROOTS {
        doc.get_or_insert_map(*name);
    }
    doc
}
pub fn apply(doc: &Doc, bytes: &[u8]) -> Result<()> {
    // Decoder errors must never publish partially applied state. The caller uses a validation replica.
    let update =
        Update::decode_v1(bytes).map_err(|e| Error::invalid(format!("Invalid Yjs update: {e}")))?;
    doc.transact_mut()
        .apply_update(update)
        .map_err(|e| Error::invalid(format!("Invalid Yjs update: {e}")))
}
pub fn encode(doc: &Doc) -> Vec<u8> {
    diff(doc, &StateVector::default())
}
pub fn diff(doc: &Doc, vector: &StateVector) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(vector)
}
pub fn vector(doc: &Doc) -> Vec<u8> {
    doc.transact().state_vector().encode_v1()
}
pub fn has_pending(doc: &Doc) -> bool {
    let tx = doc.transact();
    tx.store().pending_update().is_some() || tx.store().pending_ds().is_some()
}
pub fn clone_doc(doc: &Doc) -> Result<Doc> {
    let copy = new_doc();
    apply(&copy, &encode(doc))?;
    Ok(copy)
}
/// JavaScript has one numeric type. Yrs's serde bridge emits integral Number
/// values as f64; normalize them before comparing JSON schemas or stored values.
fn normalize(v: &mut Value) {
    match v {
        Value::Number(n) => {
            if let Some(f) = n.as_f64()
                && f.fract() == 0.0
                && f.abs() <= 9_007_199_254_740_991.0
            {
                *n = serde_json::Number::from(f as i64);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(normalize),
        Value::Object(values) => values.values_mut().for_each(normalize),
        _ => {}
    }
}
pub fn value<T: ReadTxn>(tx: &T, out: &Out) -> Value {
    if matches!(out, Out::YMap(_)) {
        record_scan("materializedMaps");
    }
    let mut v = yrs::encoding::serde::from_any(&out.to_json(tx)).unwrap_or(Value::Null);
    normalize(&mut v);
    v
}
pub fn root<T: ReadTxn>(tx: &T, name: &str) -> MapRef {
    tx.get_map(name).expect("known document root")
}
pub fn get<T: ReadTxn>(tx: &T, name: &str, id: &str) -> Value {
    root(tx, name)
        .get(tx, id)
        .map(|v| value(tx, &v))
        .unwrap_or(Value::Null)
}
/// Read metadata without copying the note's text, checklist, or other fields.
pub fn field<T: ReadTxn>(tx: &T, name: &str, id: &str, key: &str) -> Value {
    match root(tx, name).get(tx, id) {
        Some(Out::YMap(map)) => map
            .get(tx, key)
            .map(|v| value(tx, &v))
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}
pub fn entry_ids<T: ReadTxn>(tx: &T, name: &str, changes: Option<&Changes>) -> Ids {
    changes
        .map(|c| c.ids(name))
        .unwrap_or_else(|| keys(tx, name))
}
pub fn keys<T: ReadTxn>(tx: &T, name: &str) -> Ids {
    record_scan(name);
    root(tx, name).keys(tx).map(str::to_owned).collect()
}
pub fn entries<T: ReadTxn>(tx: &T, name: &str, changed: Option<&Changes>) -> Vec<(String, Value)> {
    let map = root(tx, name);
    match changed {
        Some(c) => c
            .ids(name)
            .into_iter()
            .filter_map(|id| map.get(tx, &id).map(|v| (id, value(tx, &v))))
            .collect(),
        None => {
            record_scan(name);
            map.iter(tx)
                .map(|(id, v)| (id.to_owned(), value(tx, &v)))
                .collect()
        }
    }
}
pub fn put(tx: &mut TransactionMut, name: &str, id: &str, mut v: Value) -> bool {
    normalize(&mut v);
    if get(tx, name, id) == v {
        return false;
    }
    let a = yrs::encoding::serde::to_any(&v).expect("JSON is representable in Yjs");
    root(tx, name).insert(tx, id, a);
    true
}
pub fn remove(tx: &mut TransactionMut, name: &str, id: &str) -> bool {
    root(tx, name).remove(tx, id).is_some()
}
pub fn number(v: &Value) -> f64 {
    v.as_f64().filter(|n| n.is_finite()).unwrap_or(0.0)
}
pub fn string(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn strings(v: &Value) -> Vec<String> {
    array(v)
        .iter()
        .filter_map(|s| s.as_str().map(str::to_owned))
        .collect()
}
pub fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn object(v: &Value) -> impl Iterator<Item = (&String, &Value)> {
    v.as_object().into_iter().flat_map(|v| v.iter())
}
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(_) => number(v) != 0.0,
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub struct ObservedDoc {
    pub doc: Doc,
    changes: Arc<Mutex<Changes>>,
    emitted: Arc<Mutex<Vec<Vec<u8>>>>,
    _subscriptions: Vec<Subscription>,
}
fn owners<T: ReadTxn>(tx: &T, name: &str, id: &str, out: &Out) -> Vec<String> {
    if name == "notes" {
        return vec![id.into()];
    }
    if name == "items" {
        return match out {
            Out::YMap(map) => map
                .get(tx, "noteId")
                .map(|v| vec![string(&value(tx, &v)).into()])
                .unwrap_or_default(),
            _ => vec![],
        };
    }
    if !["attachments", "merges", "mergeRecipes"].contains(&name) {
        return vec![];
    }
    let v = value(tx, out);
    match name {
        "notes" => vec![id.into()],
        "items" | "attachments" => vec![string(&v["noteId"]).into()],
        "merges" => vec![string(&v["a"]).into(), string(&v["b"]).into()],
        "mergeRecipes" => strings(&v["sourceIds"]),
        _ => vec![],
    }
}
impl ObservedDoc {
    pub fn new(doc: Doc) -> Self {
        let changes = Arc::new(Mutex::new(Changes::default()));
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let mut subscriptions = Vec::new();
        for &name in ROOTS {
            let c = changes.clone();
            let map = doc.get_or_insert_map(name);
            subscriptions.push(map.clone().observe_deep(move |tx, events| {
                let mut c = c.lock().expect("CRDT observer lock");
                for event in events.iter() {
                    if let Some(PathSegment::Key(id)) = event.path().front() {
                        c.keys
                            .entry(name.into())
                            .or_default()
                            .insert(id.to_string());
                        if name == "notes" {
                            c.touched.insert(id.to_string());
                        } else if let Some(v) = map.get(tx, id) {
                            c.touched.extend(
                                owners(tx, name, id, &v)
                                    .into_iter()
                                    .filter(|s| !s.is_empty()),
                            );
                        }
                        if name == "items"
                            && let Event::Map(e) = event
                            && let Some(EntryChange::Updated(old, _) | EntryChange::Removed(old)) =
                                e.keys(tx).get("noteId")
                            && let Some(id) = value(tx, old).as_str()
                        {
                            c.touched.insert(id.into());
                        }
                    } else if let Event::Map(e) = event {
                        for (id, change) in e.keys(tx) {
                            c.keys
                                .entry(name.into())
                                .or_default()
                                .insert(id.to_string());
                            let values = match change {
                                EntryChange::Inserted(v) | EntryChange::Removed(v) => vec![v],
                                EntryChange::Updated(a, b) => vec![a, b],
                            };
                            for v in values {
                                c.touched.extend(
                                    owners(tx, name, id, v)
                                        .into_iter()
                                        .filter(|s| !s.is_empty()),
                                );
                            }
                        }
                    }
                }
            }));
        }
        let e = emitted.clone();
        subscriptions.push(
            doc.observe_update_v1(move |_, update| {
                e.lock()
                    .expect("CRDT observer lock")
                    .push(update.update.clone());
            })
            .expect("new document observer"),
        );
        Self {
            doc,
            changes,
            emitted,
            _subscriptions: subscriptions,
        }
    }
    pub fn apply(&self, bytes: &[u8]) -> Result<(Changes, Vec<Vec<u8>>)> {
        *self.changes.lock().expect("CRDT observer lock") = Changes::default();
        self.emitted.lock().expect("CRDT observer lock").clear();
        apply(&self.doc, bytes)?;
        let mut changes = std::mem::take(&mut *self.changes.lock().expect("CRDT observer lock"));
        if changes.has("textJoins") {
            let joins = changes.ids("textJoins");
            let tx = self.doc.transact();
            for (_, recipe) in entries(&tx, "mergeRecipes", None) {
                if array(&recipe["body"])
                    .iter()
                    .any(|r| r["field"] == "join" && joins.contains(string(&r["joinId"])))
                {
                    changes.touched.extend(strings(&recipe["sourceIds"]));
                }
            }
        }
        Ok((
            changes,
            std::mem::take(&mut *self.emitted.lock().expect("CRDT observer lock")),
        ))
    }
}
