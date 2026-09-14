//! Source-aware redaction. These rules also run in the browser; interoperability tests
//! feed real browser documents through this implementation and check the resulting views.
use crate::{
    crdt::*,
    error::{Error, Result},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yrs::{Doc, Map, Transact};

pub fn is_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn recipe_clean(recipe: &Value, removed: &Ids) -> Value {
    let sources: Vec<String> = strings(&recipe["sourceIds"])
        .into_iter()
        .filter(|s| !removed.contains(s))
        .collect();
    if sources.is_empty() {
        return Value::Null;
    }
    let mut kept = recipe.clone();
    kept["sourceIds"] = json!(sources);
    if removed.contains(string(&recipe["title"]["sourceId"])) {
        kept["title"] = json!({"sourceId":sources[0],"field":"title"});
    }
    kept["body"] = json!(
        array(&recipe["body"])
            .iter()
            .filter(|r| !removed.contains(string(&r["sourceId"])))
            .collect::<Vec<_>>()
    );
    kept
}
pub fn enforce_deletions(doc: &Doc, changes: Option<&Changes>) -> bool {
    let mut tx = doc.transact_mut();
    let deleted = keys(&tx, "deletedNotes");
    if deleted.is_empty() {
        return false;
    }
    let changes = changes.filter(|c| !c.has("deletedNotes"));
    let mut changed = false;
    let mut discovered = false;
    let recipes = entries(&tx, "mergeRecipes", changes);
    let mut dead = Vec::new();
    for (id, source) in entries(&tx, "textJoinSources", changes) {
        if deleted.contains(string(&source)) {
            dead.push(id);
        }
    }
    for (_, recipe) in &recipes {
        for r in array(&recipe["body"]) {
            if r["field"] == "join" && deleted.contains(string(&r["sourceId"])) {
                dead.push(string(&r["joinId"]).into());
            }
        }
    }
    for id in dead {
        discovered |= !root(&tx, "deletedTextJoins").contains_key(&tx, &id);
        changed |= put(&mut tx, "deletedTextJoins", &id, json!(true));
    }
    for id in entry_ids(&tx, "notes", changes) {
        if deleted.contains(&id) {
            let raw = field(&tx, "notes", &id, "takeout")["rawHash"].clone();
            if raw.is_string() {
                changed |= put(&mut tx, "deletedBlobCandidates", string(&raw), json!(true));
            }
            changed |= remove(&mut tx, "notes", &id);
        }
    }
    for id in entry_ids(&tx, "items", changes) {
        if deleted.contains(string(&field(&tx, "items", &id, "noteId"))) {
            changed |= remove(&mut tx, "items", &id);
        }
    }
    for (id, a) in entries(&tx, "attachments", changes) {
        if deleted.contains(string(&a["noteId"])) {
            changed |= put(
                &mut tx,
                "deletedBlobCandidates",
                string(&a["hash"]),
                json!(true),
            );
            changed |= remove(&mut tx, "attachments", &id);
        }
    }
    for (id, r) in recipes {
        let kept = recipe_clean(&r, &deleted);
        changed |= if kept.is_null() {
            remove(&mut tx, "mergeRecipes", &id)
        } else {
            put(&mut tx, "mergeRecipes", &id, kept)
        };
    }
    let dead = keys(&tx, "deletedTextJoins");
    let ids = if let Some(c) = changes.filter(|_| !discovered) {
        c.ids("textJoins")
            .union(&c.ids("deletedTextJoins"))
            .cloned()
            .collect()
    } else {
        dead.clone()
    };
    for id in ids {
        if dead.contains(&id) {
            changed |= remove(&mut tx, "textJoins", &id);
            changed |= remove(&mut tx, "textJoinSources", &id);
        }
    }
    changed
}
pub type References = BTreeMap<String, Ids>;
fn add_reference(refs: &mut References, hash: &Value, source: &str) {
    if is_hash(string(hash)) {
        refs.entry(string(hash).into())
            .or_default()
            .insert(source.into());
    }
}
pub fn references(doc: &Doc) -> References {
    let tx = doc.transact();
    let mut refs = References::new();
    for (_, a) in entries(&tx, "attachments", None) {
        add_reference(&mut refs, &a["hash"], string(&a["noteId"]));
    }
    for id in keys(&tx, "notes") {
        add_reference(
            &mut refs,
            &field(&tx, "notes", &id, "takeout")["rawHash"],
            &id,
        );
    }
    for (id, v) in entries(&tx, "importSources", None) {
        add_reference(&mut refs, &v["manifestHash"], &format!("import:{id}"));
    }
    refs
}
pub fn validate_candidates(doc: &Doc) -> Result<()> {
    if keys(&doc.transact(), "deletedBlobCandidates")
        .iter()
        .any(|s| !is_hash(s))
    {
        return Err(Error::invalid("Invalid permanent deletion blob hash"));
    }
    Ok(())
}
