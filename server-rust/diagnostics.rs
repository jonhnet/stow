use crate::{
    crdt::{array, string},
    error::{Error, Result},
};
use serde_json::{Value, json};
use std::collections::BTreeSet;
const MARKS: &str = "main-executing app-import-start app-import-end react-render-requested store-constructing spinner-dom session-start session-response session-json account-verified account-opening idb-open-start idb-open-end idb-read-start idb-read-end updates-merge-start updates-merge-end updates-apply-start updates-apply-end idb-drain-start idb-drain-end idb-compact-start idb-compact-end local-ready broadcast-encode-start broadcast-encode-end broadcast-posted snapshot-start snapshot-end account-opened notes-dom notes-frame socket-start socket-open sync-received sync-apply-start sync-apply-end sync-reply-sent search-build-start search-build-end";
const COUNTERS: &str = "updateCount updateBytes mergedBytes broadcastBytes notes items revisions sessionStatus viewportWidth viewportHeight pixelRatio hardwareConcurrency visibleAtStart frameMaxMs searchIndexedNotes searchSlices searchActiveMs searchMaxSliceMs";
const NAVIGATION: &str = "startTime duration workerStart redirectStart redirectEnd fetchStart domainLookupStart domainLookupEnd connectStart connectEnd secureConnectionStart requestStart responseStart responseEnd domInteractive domContentLoadedEventStart domContentLoadedEventEnd loadEventStart loadEventEnd transferSize encodedBodySize decodedBodySize";
const RESOURCES: &str = "startTime duration requestStart responseStart responseEnd transferSize encodedBodySize decodedBodySize serverMs";
fn valid_number(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|n| n.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&n))
}
fn numeric_fields(v: &Value, allowed: &str) -> bool {
    v.as_object().is_some_and(|v| {
        v.iter()
            .all(|(k, v)| allowed.split_whitespace().any(|s| s == k) && valid_number(v))
    })
}
pub fn parse(v: Value) -> Result<Value> {
    let invalid = || Error::request(400, "Invalid startup timing report.");
    let id = string(&v["id"]);
    if !v.is_object()
        || v["schema"] != 1
        || id.len() != 36
        || !id
            .bytes()
            .all(|b| b == b'-' || b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !valid_number(&v["startedAt"])
        || !["ready", "waiting", "pagehide"].contains(&string(&v["reason"]))
    {
        return Err(invalid());
    }
    if !v["marks"].is_array() || array(&v["marks"]).len() > MARKS.split_whitespace().count() {
        return Err(invalid());
    }
    let mut names = BTreeSet::new();
    let mut marks = Vec::new();
    for mark in array(&v["marks"]) {
        let name = string(&mark["name"]);
        if !MARKS.split_whitespace().any(|s| s == name)
            || !valid_number(&mark["at"])
            || !names.insert(name)
        {
            return Err(invalid());
        }
        marks.push(json!({"name":name,"at":mark["at"]}));
    }
    if !v["resources"].is_array() || array(&v["resources"]).len() > 80 {
        return Err(invalid());
    }
    let mut resources = Vec::new();
    for r in array(&v["resources"]) {
        let name = string(&r["name"]);
        let Some(mut timing) = r.as_object().cloned() else {
            return Err(invalid());
        };
        timing.remove("name");
        let code_path = name.starts_with('/')
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_./@-".contains(&b))
            && [".js", ".mjs", ".cjs", ".ts", ".tsx", ".css"]
                .iter()
                .any(|s| name.ends_with(s));
        if name.len() > 200
            || (name != "/api/session" && !code_path)
            || !numeric_fields(&Value::Object(timing), RESOURCES)
        {
            return Err(invalid());
        }
        resources.push(r.clone());
    }
    if !numeric_fields(&v["counters"], COUNTERS)
        || !numeric_fields(&v["navigation"], NAVIGATION)
        || !v["frameGaps"].is_array()
        || array(&v["frameGaps"]).len() > 20
    {
        return Err(invalid());
    }
    let mut gaps = Vec::new();
    for g in array(&v["frameGaps"]) {
        if !valid_number(&g["start"]) || !valid_number(&g["duration"]) {
            return Err(invalid());
        }
        gaps.push(json!({"start":g["start"],"duration":g["duration"]}));
    }
    Ok(
        json!({"schema":1,"id":v["id"],"startedAt":v["startedAt"],"reason":v["reason"],"marks":marks,"counters":v["counters"],"navigation":v["navigation"],"resources":resources,"frameGaps":gaps}),
    )
}
