//! Native regressions for the storage, policy and HTTP contracts formerly tested
//! through TypeScript adapters. Fixtures use the same UTF-16 CRDT schema as Yjs.
use crate::{crdt::*, history_state, storage::Vault};
use serde_json::{Value, json};
use std::{fs, path::Path};
use tempfile::TempDir;
use yrs::{Doc, Map, MapPrelim, MapRef, Out, ReadTxn, Text, TextPrelim, Transact};

mod account_metadata;
mod account_metadata_api;
mod api;
mod deletion;
mod history;
mod identity;
mod images;
mod retention;
mod storage;

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| (*s).into()).collect()
}
fn map(doc: &Doc, root_name: &str, id: &str) -> MapRef {
    match root(&doc.transact(), root_name)
        .get(&doc.transact(), id)
        .unwrap()
    {
        Out::YMap(map) => map,
        _ => panic!("expected nested map"),
    }
}
fn note(doc: &Doc, id: &str, body: &str) {
    let mut tx = doc.transact_mut();
    let note = root(&tx, "notes").insert(&mut tx, id, MapPrelim::default());
    note.insert(&mut tx, "title", TextPrelim::new(id));
    note.insert(&mut tx, "body", TextPrelim::new(body));
    for (k, v) in [
        ("kind", json!("text")),
        ("color", json!("default")),
        ("createdAt", json!(1)),
        ("updatedAt", json!(1)),
        ("archived", json!(false)),
        ("trashed", json!(false)),
        ("placement", json!({"pinned":false,"sortOrderDate":1})),
    ] {
        note.insert(&mut tx, k, yrs::encoding::serde::to_any(&v).unwrap());
    }
}
fn meta(doc: &Doc, id: &str, key: &str, v: Value) {
    map(doc, "notes", id).insert(
        &mut doc.transact_mut(),
        key,
        yrs::encoding::serde::to_any(&v).unwrap(),
    );
}
fn append(doc: &Doc, id: &str, key: &str, value: &str) {
    let map = map(doc, "notes", id);
    let mut tx = doc.transact_mut();
    let Out::YText(text) = map.get(&tx, key).unwrap() else {
        panic!("expected text")
    };
    let len = text.len(&tx);
    text.insert(&mut tx, len, value);
}
fn text(doc: &Doc, id: &str, key: &str, value: &str) {
    let map = map(doc, "notes", id);
    let mut tx = doc.transact_mut();
    let Out::YText(text) = map.get(&tx, key).unwrap() else {
        panic!("expected text")
    };
    let len = text.len(&tx);
    text.remove_range(&mut tx, 0, len);
    text.insert(&mut tx, 0, value);
}
fn tombstone(doc: &Doc, id: &str) {
    put(&mut doc.transact_mut(), "deletedNotes", id, json!(true));
}
fn attachment(doc: &Doc, id: &str, owner: &str, hash: &str) {
    put(
        &mut doc.transact_mut(),
        "attachments",
        id,
        json!({"id":id,"noteId":owner,"hash":hash,"name":id,"type":"image/png","size":8}),
    );
}
fn names(path: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(path)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}
fn contains(bytes: &[u8], value: &str) -> bool {
    bytes.windows(value.len()).any(|w| w == value.as_bytes())
}
struct Fixture {
    directory: TempDir,
    vault: Vault,
    client: Doc,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let vault = Vault::open(directory.path(), 1.).unwrap();
        Self {
            directory,
            vault,
            client: new_doc(),
        }
    }
    fn submit(&mut self, now: f64) -> crate::error::Result<crate::storage::DurableUpdate> {
        let update = diff(&self.client, &self.vault.doc.transact().state_vector());
        let accepted = self.vault.accept(&update, now)?;
        apply(&self.client, accepted.bytes())?;
        Ok(accepted)
    }
    fn save(&mut self, sources: &[&str], now: f64) {
        self.submit(now).unwrap();
        self.vault
            .capture_history(&json!({"sourceIds":sources,"editedAt":now}), now)
            .unwrap();
    }
    fn reopen(&mut self) {
        self.vault = Vault::open(self.directory.path(), 1.).unwrap();
    }
    fn body(&self, id: &str) -> Value {
        field(&self.vault.doc.transact(), "notes", id, "body")
    }
}
