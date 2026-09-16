//! Current-state projection and standalone history policy. No history lives in Yrs.
use crate::{
    crdt::*,
    error::{Error, Result},
};
use icu_properties::{
    CodePointMapData,
    props::{GeneralCategory, GeneralCategoryGroup},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yrs::{ClientID, Doc, ID, Map, Out, ReadTxn, Text, Transact, TransactionMut};

// Character masks retain the original text so concurrent conversion Undo never
// inserts it twice. Match src/core/converted-text.ts; new character IDs stay live.
fn visible_text(
    tx: &mut TransactionMut,
    owner: &str,
    note: &Value,
    field: &str,
    join: Option<&str>,
) -> String {
    let masks: Vec<&Value> = note
        .as_object()
        .into_iter()
        .flat_map(|n| n.iter())
        .filter(|(key, mask)| {
            key.starts_with("text-mask:")
                && mask["field"] == field
                && mask["joinId"].as_str() == join
        })
        .flat_map(|(_, mask)| mask["spans"].as_array().into_iter().flatten())
        .collect();
    if masks.is_empty() {
        return if let Some(join) = join {
            string(&get(tx, "textJoins", join)).into()
        } else {
            string(&note[field]).into()
        };
    }
    let value = if let Some(join) = join {
        tx.get_map("textJoins").and_then(|map| map.get(tx, join))
    } else {
        tx.get_map("notes")
            .and_then(|map| map.get(tx, owner))
            .and_then(|v| match v {
                Out::YMap(map) => map.get(tx, field),
                _ => None,
            })
    };
    let Some(Out::YText(text)) = value else {
        return String::new();
    };
    // A synthetic current snapshot excludes only the masked character IDs.
    // Yrs walks spans once; per-character sticky-index lookup is quadratic on
    // heavily edited text. Splitting snapshot boundaries authors no CRDT update.
    let mut snapshot = tx.snapshot();
    for span in masks {
        if let (Some(client), Some(clock), Some(length)) = (
            span["client"].as_u64(),
            span["clock"].as_u64(),
            span["length"].as_u64(),
        ) && let (Ok(clock), Ok(length)) = (u32::try_from(clock), u32::try_from(length))
            && client <= 9_007_199_254_740_991
            && length > 0
            && clock.checked_add(length).is_some()
        {
            snapshot
                .delete_set
                .insert(ID::new(ClientID::new(client), clock), length);
        }
    }
    text.diff_range(tx, Some(&snapshot), None, |change| change)
        .into_iter()
        .map(|diff| diff.insert.to_string(tx))
        .collect()
}

// Keep independently edited copies, but suppress untouched conversion duplicates
// and remap children of equivalent parents. Match converted-checklist.ts.
fn converted_items(items: Vec<(String, Value)>) -> Vec<(String, Value)> {
    let mut groups = BTreeMap::<String, Vec<(String, Value)>>::new();
    let mut result = Vec::new();
    for (id, item) in items {
        if let Some(source) = item["conversion"]["source"].as_str() {
            groups.entry(source.into()).or_default().push((id, item));
        } else {
            result.push((id, item));
        }
    }
    let mut aliases = BTreeMap::new();
    let signature = |item: &Value| {
        json!([
            item["text"],
            truthy(&item["checked"]),
            if string(&item["parentId"]).is_empty() {
                Value::Null
            } else {
                item["parentId"].clone()
            },
            if item["rank"] == item["conversion"]["rank"] {
                Value::Null
            } else {
                item["rank"].clone()
            },
            truthy(&item["deleted"])
        ])
        .to_string()
    };
    for group in groups.values_mut() {
        group.sort_by(|a, b| a.0.cmp(&b.0));
        let edited: Vec<_> = group
            .iter()
            .filter(|(_, item)| {
                truthy(&item["deleted"])
                    || truthy(&item["checked"])
                    || !string(&item["parentId"]).is_empty()
                    || item["text"] != item["conversion"]["text"]
                    || item["rank"] != item["conversion"]["rank"]
            })
            .collect();
        let mut variants = BTreeMap::new();
        for (id, item) in if edited.is_empty() {
            group.iter().collect()
        } else {
            edited
        } {
            variants.entry(signature(item)).or_insert((id, item));
        }
        let mut selected: Vec<_> = variants.values().copied().collect();
        selected.sort_by(|a, b| a.0.cmp(b.0));
        let fallback = selected
            .iter()
            .find(|(_, item)| !truthy(&item["deleted"]))
            .unwrap_or(&selected[0])
            .0;
        for (id, item) in group.iter() {
            aliases.insert(
                id.clone(),
                variants
                    .get(&signature(item))
                    .map_or(fallback, |(id, _)| id)
                    .clone(),
            );
        }
        result.extend(
            selected
                .into_iter()
                .map(|(id, item)| (id.clone(), item.clone())),
        );
    }
    result.retain(|(_, item)| !truthy(&item["deleted"]));
    for (_, item) in &mut result {
        if let Some(parent) = aliases.get(string(&item["parentId"])) {
            item["parentId"] = json!(parent);
        }
    }
    result
}

pub fn groups(doc: &Doc) -> Vec<Vec<String>> {
    let tx = doc.transact();
    let ids = keys(&tx, "notes");
    let mut parents: BTreeMap<String, String> = ids
        .union(&keys(&tx, "deletedNotes"))
        .map(|s| (s.clone(), s.clone()))
        .collect();
    fn find(p: &BTreeMap<String, String>, id: &str) -> String {
        let mut id = id;
        while let Some(next) = p.get(id) {
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
            parents.insert(find(&parents, b), find(&parents, a));
        }
    }
    let mut grouped = BTreeMap::<String, Vec<String>>::new();
    for id in ids {
        grouped.entry(find(&parents, &id)).or_default().push(id);
    }
    let compare = |a: &String, b: &String| {
        number(&field(&tx, "notes", a, "createdAt"))
            .total_cmp(&number(&field(&tx, "notes", b, "createdAt")))
            .then(a.cmp(b))
    };
    let mut result: Vec<_> = grouped.into_values().collect();
    for group in &mut result {
        group.sort_by(compare);
    }
    result.sort_by(|a, b| compare(&a[0], &b[0]));
    result
}
pub fn label_setting(doc: &Doc, name: &str) -> Value {
    let tx = doc.transact();
    let life = get(&tx, "labelLifecycle", name);
    let color = if life.is_null() {
        get(&tx, "labelColors", name)
    } else {
        get(
            &tx,
            "labelGenerationColors",
            &json!([name, life["generation"]]).to_string(),
        )
    };
    let mut v =
        json!({"color":color.as_str().unwrap_or("default"),"deleted":truthy(&life["deleted"])});
    if !life.is_null() {
        v["generation"] = life["generation"].clone();
    }
    v
}
pub fn capture(doc: &Doc, selected: &[String]) -> Result<Value> {
    let wanted: Ids = selected.iter().cloned().collect();
    let groups: Vec<_> = groups(doc)
        .into_iter()
        .filter(|g| g.iter().any(|id| wanted.contains(id)))
        .collect();
    let ids: Ids = groups.iter().flatten().cloned().collect();
    let mut tx = doc.transact_mut();
    let mut sources = serde_json::Map::new();
    for id in &ids {
        let n = get(&tx, "notes", id);
        let created = n.get("createdAt").cloned().unwrap_or(json!(0));
        let placement = n
            .get("placement")
            .cloned()
            .unwrap_or_else(|| json!({"pinned":truthy(&n["pinned"]),"sortOrderDate":created}));
        let mut v = json!({"title":n["title"].as_str().unwrap_or(""),"body":n["body"].as_str().unwrap_or(""),"kind":n["kind"].as_str().unwrap_or("text"),"color":n["color"].as_str().unwrap_or("default"),"pinned":placement["pinned"],"sortOrderDate":placement["sortOrderDate"],"archived":truthy(&n["archived"]),"trashed":truthy(&n["trashed"]),"createdAt":created,"updatedAt":n.get("updatedAt").cloned().unwrap_or(json!(0)),"items":{},"images":{}});
        for field in ["title", "body"] {
            v[field] = json!(visible_text(&mut tx, id, &n, field, None));
        }
        if n.get("unifiedChecklist").is_some() {
            v["unifiedChecklist"] = json!(truthy(&n["unifiedChecklist"]));
        }
        let baseline = strings(&n["labels"]);
        let mut names = baseline.clone();
        let mut authored = Ids::new();
        for (key, _) in object(&n) {
            if let Some(name) = key.strip_prefix("label:") {
                authored.insert(name.into());
            } else if let Some(key) = key.strip_prefix("label-generation:") {
                let key: Value = serde_json::from_str(key)
                    .map_err(|_| Error::invalid("Invalid label membership"))?;
                if let Some(name) = key[0].as_str() {
                    authored.insert(name.into());
                }
            }
        }
        let mut authored: Vec<_> = authored
            .into_iter()
            .filter(|n| !baseline.contains(n))
            .collect();
        // JavaScript's label sort compares UTF-16 code units, including emoji.
        authored.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        names.extend(authored);
        let labels: Vec<_> = names
            .into_iter()
            .filter(|name| {
                let life = get(&tx, "labelLifecycle", name);
                if truthy(&life["deleted"]) {
                    false
                } else if !life.is_null() {
                    n[format!("label-generation:{}", json!([name, life["generation"]]))] == true
                } else {
                    let value = &n[format!("label:{name}")];
                    *value == true || (*value != false && baseline.contains(name))
                }
            })
            .collect();
        if !labels.is_empty() {
            v["labels"] = json!(labels);
            let generations: serde_json::Map<String, Value> = labels
                .iter()
                .filter_map(|name| {
                    let life = get(&tx, "labelLifecycle", name);
                    life.get("generation").map(|g| (name.clone(), g.clone()))
                })
                .collect();
            if !generations.is_empty() {
                v["labelGenerations"] = Value::Object(generations);
            }
        }
        sources.insert(id.clone(), v);
    }
    let mut source_items = BTreeMap::<String, Vec<(String, Value)>>::new();
    let components: BTreeMap<_, _> = groups
        .iter()
        .flat_map(|group| group.iter().map(|id| (id.as_str(), group[0].as_str())))
        .collect();
    for (id, item) in entries(&tx, "items", None) {
        let owner = string(&item["noteId"]);
        source_items
            .entry(components.get(owner).copied().unwrap_or(owner).into())
            .or_default()
            .push((id, item));
    }
    for (id, item) in source_items.into_values().flat_map(converted_items) {
        let owner = string(&item["noteId"]);
        if let Some(source) = sources.get_mut(owner)
            && !truthy(&item["deleted"])
            && item["text"].is_string()
        {
            let mut v = json!({"text":item["text"],"checked":truthy(&item["checked"]),"rank":number(&item["rank"])});
            if !string(&item["parentId"]).is_empty() {
                v["parentId"] = item["parentId"].clone();
            }
            source["items"][id] = v;
        }
    }
    for (id, image) in entries(&tx, "attachments", None) {
        if let Some(source) = sources.get_mut(string(&image["noteId"])) {
            source["images"][id] = image;
        }
    }
    let deleted = keys(&tx, "deletedNotes");
    let mut recipes = serde_json::Map::new();
    let mut joins = serde_json::Map::new();
    for (id, r) in entries(&tx, "mergeRecipes", None) {
        if strings(&r["sourceIds"]).iter().any(|s| ids.contains(s))
            && strings(&r["edgeIds"]).iter().any(|e| {
                let edge = get(&tx, "merges", e);
                ["a", "b"]
                    .iter()
                    .all(|k| ids.contains(string(&edge[k])) || deleted.contains(string(&edge[k])))
            })
        {
            for run in array(&r["body"]) {
                if run["field"] == "join" {
                    let id = string(&run["joinId"]);
                    let value = get(&tx, "textJoins", id);
                    if !value.is_string() {
                        return Err(Error::invalid(
                            "This note composition refers to missing joining text.",
                        ));
                    }
                    let owner = string(&run["sourceId"]);
                    let owner_note = get(&tx, "notes", owner);
                    joins.insert(
                        id.into(),
                        json!(visible_text(&mut tx, owner, &owner_note, "join", Some(id))),
                    );
                }
            }
            recipes.insert(id, r);
        }
    }
    let mut state = json!({"sources":sources,"groups":groups});
    if !recipes.is_empty() {
        state["recipes"] = Value::Object(recipes);
    }
    if !joins.is_empty() {
        state["joins"] = Value::Object(joins);
    }
    Ok(state)
}
pub fn text(state: &Value, id: &str) -> Result<(String, String)> {
    let group = array(&state["groups"])
        .iter()
        .find(|g| strings(g).iter().any(|s| s == id))
        .map(strings)
        .unwrap_or_else(|| vec![id.into()]);
    let members: Ids = group.iter().cloned().collect();
    let mut recipes: Vec<_> = object(&state["recipes"])
        .map(|(_, r)| r)
        .filter(|r| {
            strings(&r["sourceIds"])
                .iter()
                .any(|id| members.contains(id))
        })
        .collect();
    recipes.sort_by(|a, b| {
        number(&b["order"])
            .total_cmp(&number(&a["order"]))
            .then(string(&b["id"]).cmp(string(&a["id"])))
    });
    let mut order = Vec::new();
    for id in recipes
        .iter()
        .flat_map(|r| strings(&r["sourceIds"]))
        .chain(group.clone())
    {
        if members.contains(&id) && !order.contains(&id) {
            order.push(id);
        }
    }
    let title = recipes
        .iter()
        .map(|r| r["title"].clone())
        .find(|r| members.contains(string(&r["sourceId"])))
        .unwrap_or_else(|| json!({"sourceId":order.first(),"field":"title"}));
    let key = |r: &Value| {
        json!([
            r["sourceId"],
            r["field"],
            r.get("joinId").unwrap_or(&json!(""))
        ])
        .to_string()
    };
    let at = |r: &Value| -> Result<String> {
        let v = if r["field"] == "join" {
            &state["joins"][string(&r["joinId"])]
        } else {
            &state["sources"][string(&r["sourceId"])][string(&r["field"])]
        };
        v.as_str()
            .map(str::to_owned)
            .ok_or_else(|| Error::invalid("This note composition refers to a missing text field."))
    };
    let mut seen = Ids::from([key(&title)]);
    let mut body = String::new();
    let mut append = |r: &Value| -> Result<()> {
        if members.contains(string(&r["sourceId"])) && seen.insert(key(r)) {
            body.push_str(&at(r)?);
        }
        Ok(())
    };
    for (i, r) in recipes.iter().enumerate() {
        if i > 0 {
            append(&r["title"])?;
        }
        for run in array(&r["body"]) {
            append(run)?;
        }
    }
    for field in ["title", "body"] {
        for id in &order {
            append(&json!({"sourceId":id,"field":field}))?;
        }
    }
    if group.len() > 1 && recipes.is_empty() {
        body = format!(
            "{}\n\n{}",
            order
                .iter()
                .skip(1)
                .map(|id| string(&state["sources"][id]["title"]))
                .collect::<Vec<_>>()
                .join("\n"),
            order
                .iter()
                .map(|id| string(&state["sources"][id]["body"]))
                .collect::<Vec<_>>()
                .join("\n\n")
        );
    }
    Ok((at(&title)?, body))
}
pub fn redact(state: &Value, removed: &Ids) -> Value {
    let sources: serde_json::Map<_, _> = object(&state["sources"])
        .filter(|(id, _)| !removed.contains(*id))
        .map(|(id, v)| (id.clone(), v.clone()))
        .collect();
    let groups: Vec<_> = array(&state["groups"])
        .iter()
        .map(|g| {
            strings(g)
                .into_iter()
                .filter(|id| !removed.contains(id))
                .collect::<Vec<_>>()
        })
        .filter(|g| !g.is_empty())
        .collect();
    let mut recipes = serde_json::Map::new();
    let mut joins = Ids::new();
    for (id, r) in object(&state["recipes"]) {
        let members: Vec<_> = strings(&r["sourceIds"])
            .into_iter()
            .filter(|id| !removed.contains(id))
            .collect();
        if members.is_empty() {
            continue;
        }
        let mut r = r.clone();
        r["sourceIds"] = json!(members);
        if removed.contains(string(&r["title"]["sourceId"])) {
            r["title"] = json!({"sourceId":members[0],"field":"title"});
        }
        r["body"] = json!(
            array(&r["body"])
                .iter()
                .filter(|r| !removed.contains(string(&r["sourceId"])))
                .collect::<Vec<_>>()
        );
        for r in array(&r["body"]) {
            if r["field"] == "join" {
                joins.insert(string(&r["joinId"]).into());
            }
        }
        recipes.insert(id.clone(), r);
    }
    let mut v = json!({"sources":sources,"groups":groups});
    if !recipes.is_empty() {
        v["recipes"] = Value::Object(recipes);
    }
    if !joins.is_empty() {
        v["joins"] = Value::Object(
            object(&state["joins"])
                .filter(|(id, _)| joins.contains(*id))
                .map(|(id, v)| (id.clone(), v.clone()))
                .collect(),
        );
    }
    v
}
pub fn splice(a: &str, b: &str) -> Value {
    // Character boundaries retain full surrogate pairs; public offsets are UTF-16.
    let a: Vec<_> = a.chars().collect();
    let b: Vec<_> = b.chars().collect();
    let mut start = 0;
    while start < a.len().min(b.len()) && a[start] == b[start] {
        start += 1;
    }
    let mut suffix = 0;
    while suffix < a.len() - start
        && suffix < b.len() - start
        && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix]
    {
        suffix += 1;
    }
    json!({"index":a[..start].iter().map(|c|c.len_utf16()).sum::<usize>(),"remove":a[start..a.len()-suffix].iter().map(|c|c.len_utf16()).sum::<usize>(),"insert":b[start..b.len()-suffix].iter().collect::<String>()})
}
fn union(a: &Value, b: &Value) -> Ids {
    object(a)
        .chain(object(b))
        .map(|(id, _)| id.clone())
        .collect()
}
pub fn diff(a: &Value, b: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for id in union(&a["sources"], &b["sources"]) {
        let a = &a["sources"][&id];
        let b = &b["sources"][&id];
        if a.is_null() || b.is_null() {
            out.push(json!({"op":"source","sourceId":id,"value":b}));
            continue;
        }
        if a["unifiedChecklist"] != b["unifiedChecklist"] {
            out.push(json!({"op":"checklist-mode","sourceId":id,"value":b["unifiedChecklist"]}));
        }
        for field in ["title", "body"] {
            if a[field] != b[field] {
                let mut p = splice(string(&a[field]), string(&b[field]));
                p["op"] = json!("text");
                p["sourceId"] = json!(id);
                p["field"] = json!(field);
                out.push(p);
            }
        }
        for field in [
            "kind",
            "color",
            "pinned",
            "archived",
            "trashed",
            "createdAt",
            "sortOrderDate",
            "updatedAt",
        ] {
            let old = if field == "sortOrderDate" {
                a.get(field).unwrap_or(&a["createdAt"])
            } else {
                &a[field]
            };
            let current = if field == "sortOrderDate" {
                b.get(field).unwrap_or(&b["createdAt"])
            } else {
                &b[field]
            };
            if old != current {
                out.push(json!({"op":"set","sourceId":id,"field":field,"value":current}));
            }
        }
        if strings(&a["labels"]) != strings(&b["labels"])
            || a["labelGenerations"] != b["labelGenerations"]
        {
            let mut p = json!({"op":"labels","sourceId":id,"value":strings(&b["labels"])});
            if let Some(g) = b.get("labelGenerations") {
                p["generations"] = g.clone();
            }
            out.push(p);
        }
        for item in union(&a["items"], &b["items"]) {
            let a = &a["items"][&item];
            let b = &b["items"][&item];
            if a.is_null() || b.is_null() {
                out.push(json!({"op":"item","sourceId":id,"itemId":item,"value":b}));
                continue;
            }
            if a["text"] != b["text"] {
                let mut p = splice(string(&a["text"]), string(&b["text"]));
                p["op"] = json!("item-text");
                p["sourceId"] = json!(id);
                p["itemId"] = json!(item);
                out.push(p);
            }
            for field in ["checked", "rank"] {
                if a[field] != b[field] {
                    out.push(json!({"op":"item-set","sourceId":id,"itemId":item,"field":field,"value":b[field]}));
                }
            }
            if a["parentId"] != b["parentId"] {
                out.push(
                    json!({"op":"item-parent","sourceId":id,"itemId":item,"value":b["parentId"]}),
                );
            }
        }
        for image in union(&a["images"], &b["images"]) {
            if a["images"][&image] != b["images"][&image] {
                out.push(json!({"op":"image","sourceId":id,"attachmentId":image,"value":b["images"][&image]}));
            }
        }
    }
    if a["groups"] != b["groups"] {
        out.push(json!({"op":"groups","value":b["groups"]}));
    }
    for id in union(&a["recipes"], &b["recipes"]) {
        if a["recipes"][&id] != b["recipes"][&id] {
            out.push(json!({"op":"recipe","recipeId":id,"value":b["recipes"][&id]}));
        }
    }
    for id in union(&a["joins"], &b["joins"]) {
        let old = &a["joins"][&id];
        let new = &b["joins"][&id];
        if old != new {
            if old.is_null() || new.is_null() {
                out.push(json!({"op":"join","joinId":id,"value":new}));
            } else {
                let mut p = splice(string(old), string(new));
                p["op"] = json!("join-text");
                p["joinId"] = json!(id);
                out.push(p);
            }
        }
    }
    out
}
pub fn quote(s: &str) -> String {
    let s = s
        .replace("\r\n", " · ")
        .replace(['\r', '\n'], " · ")
        .replace('\t', "\\t");
    format!(
        "“{}{}”",
        s.chars().take(120).collect::<String>(),
        if s.chars().count() > 120 { "…" } else { "" }
    )
}
fn action_text(state: &Value, hint: &Value) -> String {
    let id = string(&hint["noteId"]);
    match string(&hint["field"]) {
        "title" => text(state, id).map(|t| t.0).unwrap_or_default(),
        "body" => text(state, id).map(|t| t.1).unwrap_or_default(),
        _ => state["sources"][id]["items"][string(&hint["itemId"])]["text"]
            .as_str()
            .or_else(|| {
                object(&state["sources"])
                    .find_map(|(_, v)| v["items"][string(&hint["itemId"])]["text"].as_str())
            })
            .unwrap_or("")
            .into(),
    }
}
pub fn make_version(
    state: &Value,
    boundary: &Value,
    now: f64,
    id: &str,
    before: &Value,
) -> Result<Value> {
    let changes = diff(before, state);
    let hint = &boundary["action"];
    let source = string(&hint["noteId"]);
    let item = string(&hint["itemId"]);
    let mut action = json!({"type":"metadata","changes":changes});
    let mut label = "Saved note".to_owned();
    let source_state = if state["sources"][source].is_null() {
        &before["sources"][source]
    } else {
        &state["sources"][source]
    };
    let title = text(state, source)
        .or_else(|_| text(before, source))
        .map(|t| t.0)
        .unwrap_or_default();
    let title = if title.is_empty() {
        "Untitled note"
    } else {
        &title
    };
    if hint["type"] == "text" {
        let a = action_text(before, hint);
        let b = action_text(state, hint);
        if a != b {
            action["type"] = json!("text");
            for k in ["noteId", "itemId", "field"] {
                if let Some(v) = hint.get(k) {
                    action[k] = v.clone();
                }
            }
            let av: Vec<_> = a.chars().collect();
            let bv: Vec<_> = b.chars().collect();
            let mut start = 0;
            while start < av.len().min(bv.len()) && av[start] == bv[start] {
                start += 1;
            }
            let mut suffix = 0;
            while suffix < av.len() - start
                && suffix < bv.len() - start
                && av[av.len() - 1 - suffix] == bv[bv.len() - 1 - suffix]
            {
                suffix += 1;
            }
            let mut ae = av.len() - suffix;
            let mut be = bv.len() - suffix;
            let categories = CodePointMapData::<GeneralCategory>::new();
            let word = |c: char| {
                let category = categories.get(c);
                c == '_'
                    || GeneralCategoryGroup::Letter.contains(category)
                    || GeneralCategoryGroup::Number.contains(category)
                    || GeneralCategoryGroup::Mark.contains(category)
            };
            if ae > start && be > start {
                for _ in 0..40 {
                    if start == 0
                        || !word(av[start - 1])
                        || !(av.get(start).is_some_and(|c| word(*c))
                            || bv.get(start).is_some_and(|c| word(*c)))
                    {
                        break;
                    }
                    start -= 1;
                }
                for _ in 0..40 {
                    if !av.get(ae).is_some_and(|c| word(*c))
                        || !(ae > 0 && word(av[ae - 1]) || be > 0 && word(bv[be - 1]))
                    {
                        break;
                    }
                    ae += 1;
                    be += 1;
                }
            }
            let removed = av[start..ae].iter().collect::<String>();
            let inserted = bv[start..be].iter().collect::<String>();
            let scope = match string(&hint["field"]) {
                "title" => "Title",
                "body" => "Note",
                _ => "Item",
            };
            label = if removed.is_empty() {
                format!("{scope}: added {}", quote(&inserted))
            } else if inserted.is_empty() {
                format!("{scope}: deleted {}", quote(&removed))
            } else {
                format!(
                    "{scope}: replaced {} with {}",
                    quote(&removed),
                    quote(&inserted)
                )
            };
        }
    }
    if action["type"] != "text" {
        if let Some(p) = changes.iter().find(|p| {
            p["op"] == "item-set"
                && p["field"] == "checked"
                && (item.is_empty() || p["itemId"] == item)
        }) {
            let sid = string(&p["sourceId"]);
            let iid = string(&p["itemId"]);
            let t = state["sources"][sid]["items"][iid]["text"]
                .as_str()
                .or_else(|| before["sources"][sid]["items"][iid]["text"].as_str())
                .unwrap_or("");
            action = json!({"type":"check","noteId":sid,"itemId":iid,"itemText":t,"checked":truthy(&p["value"]),"field":"checked","changes":changes});
            label = format!(
                "{} {}",
                if truthy(&p["value"]) {
                    "Checked"
                } else {
                    "Unchecked"
                },
                quote(if t.is_empty() { "Empty item" } else { t })
            );
        } else if hint["type"] == "metadata"
            && changes.iter().any(|p| {
                p["sourceId"] == source
                    && ((p["op"] == "set" && p["field"] == hint["field"])
                        || (p["op"] == "labels" && hint["field"] == "labels"))
            })
        {
            action["noteId"] = json!(source);
            action["field"] = hint["field"].clone();
            let field = string(&hint["field"]);
            let phrase = match field {
                "pinned" => Some(if truthy(&source_state[field]) {
                    "pinned"
                } else {
                    "unpinned"
                }),
                "archived" => Some(if truthy(&source_state[field]) {
                    "archived"
                } else {
                    "unarchived"
                }),
                "trashed" => Some(if truthy(&source_state[field]) {
                    "moved to trash"
                } else {
                    "restored from trash"
                }),
                "kind" => Some(if source_state[field] == "checklist" {
                    "added checklist to"
                } else {
                    "changed format of"
                }),
                _ => None,
            };
            if let Some(p) = phrase {
                label = format!("Note: {p} {}", quote(title));
            }
            if field == "color" {
                label = format!(
                    "Note: colored {} {}",
                    quote(title),
                    string(&source_state["color"])
                );
            }
            if field == "labels" {
                let old = strings(&before["sources"][source]["labels"]);
                let new = strings(&state["sources"][source]["labels"]);
                let added: Vec<_> = new
                    .iter()
                    .filter(|n| !old.contains(n))
                    .map(|n| quote(n))
                    .collect();
                let removed: Vec<_> = old
                    .iter()
                    .filter(|n| !new.contains(n))
                    .map(|n| quote(n))
                    .collect();
                if !added.is_empty() {
                    label = format!("Label: added {}", added.join(", "));
                } else if !removed.is_empty() {
                    label = format!("Label: removed {}", removed.join(", "));
                }
            }
        } else if ["item-add", "item-delete"].contains(&string(&hint["type"])) {
            if let Some(p) = changes.iter().find(|p| {
                p["op"] == "item"
                    && p["itemId"] == item
                    && p["value"].is_null() != (hint["type"] == "item-add")
            }) {
                let sid = string(&p["sourceId"]);
                let t = p["value"]["text"]
                    .as_str()
                    .or_else(|| before["sources"][sid]["items"][item]["text"].as_str())
                    .unwrap_or("");
                action = json!({"type":hint["type"],"noteId":sid,"itemId":item,"itemText":t,"changes":changes});
                label = format!(
                    "Item: {} {}",
                    if hint["type"] == "item-add" {
                        "added"
                    } else {
                        "deleted"
                    },
                    quote(if t.is_empty() { "Empty item" } else { t })
                );
            }
        } else if hint["type"] == "create"
            && changes
                .iter()
                .any(|p| p["op"] == "source" && p["sourceId"] == source && !p["value"].is_null())
        {
            action["type"] = json!("create");
            action["noteId"] = json!(source);
            label = format!("Note: created {}", quote(title));
        }
    }
    let sources: Vec<_> = object(&state["sources"])
        .map(|(id, _)| id.clone())
        .collect();
    let note = array(&state["groups"])
        .first()
        .and_then(|g| array(g).first())
        .and_then(Value::as_str)
        .or_else(|| sources.first().map(String::as_str))
        .ok_or_else(|| Error::invalid("Empty history state"))?;
    Ok(
        json!({"schema":1,"id":id,"noteId":note,"sourceIds":sources,"timestamp":boundary["editedAt"],"recordedAt":now,"title":text(state,note)?.0,"label":label,"action":action,"state":state}),
    )
}
pub fn thin(mut records: Vec<Value>) -> Vec<Value> {
    records.sort_by(|a, b| {
        number(&a["recordedAt"])
            .total_cmp(&number(&b["recordedAt"]))
            .then(string(&a["id"]).cmp(string(&b["id"])))
    });
    if records.len() <= 100 {
        return records;
    }
    let recent = records.split_off(records.len() - 50);
    let mut groups: Vec<_> = records
        .into_iter()
        .map(|r| {
            let interval = r.get("interval").cloned().unwrap_or_else(
                || json!({"start":r["timestamp"],"end":r["timestamp"],"actions":1}),
            );
            (r, interval)
        })
        .collect();
    while groups.len() > 25 {
        let best = (1..groups.len() - 1)
            .min_by(|a, b| {
                let gap = |i: usize| {
                    (number(&groups[i + 1].1["start"]) - number(&groups[i].1["end"])).max(0.0)
                };
                gap(*a).total_cmp(&gap(*b))
            })
            .unwrap_or(1);
        let (_, first) = groups.remove(best);
        let (_, last) = &mut groups[best];
        *last = json!({"start":number(&first["start"]).min(number(&last["start"])),"end":number(&first["end"]).max(number(&last["end"])),"actions":number(&first["actions"])+number(&last["actions"])});
    }
    groups
        .into_iter()
        .map(|(mut r, i)| {
            if number(&i["actions"]) > 1.0 {
                r["interval"] = i;
            }
            r
        })
        .chain(recent)
        .collect()
}
