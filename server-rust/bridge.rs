//! Local command adapter for administrator/import/lab tools. HTTP exposes none of these commands.
use crate::{
    account_reset,
    crdt::*,
    error::{Error, Result},
    history::History,
    history_state,
    storage::mkdir_durable,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    path::Path,
};
pub fn info(h: &History) -> Value {
    json!({"directory":h.directory,"count":h.count().ok(),"bytes":h.bytes().ok(),"discardedAt":h.discarded,"error":h.error})
}
pub fn history_call(h: &mut History, r: &Value) -> Result<Value> {
    let sources = strings(&r["sourceIds"]);
    let now = r["now"].as_f64().unwrap_or_else(crate::server::now);
    #[cfg(feature = "test-support")]
    {
        h.faults = strings(&r["faults"]).into_iter().collect();
    }
    match string(&r["method"]) {
        "list" => h.list(
            &sources,
            r["cursor"].as_str(),
            r["limit"].as_u64().unwrap_or(50) as usize,
        ),
        "get" => Ok(h.get(string(&r["id"]))?.unwrap_or(Value::Null)),
        "export" => h.export(),
        "capture" => h
            .capture(
                &r["state"],
                &r["boundary"],
                now,
                r.get("settings").unwrap_or(&json!({})),
                r.get("observed"),
                r["compress"].as_bool().unwrap_or(true),
            )
            .map(|v| json!(v)),
        "thin" => h.thin(&sources).map(|v| json!(v)),
        "discard" => {
            h.discard(&sources, now)?;
            Ok(Value::Null)
        }
        "removeSources" => {
            h.remove_sources(&sources.into_iter().collect())?;
            Ok(Value::Null)
        }
        "reload" => {
            h.reload()?;
            Ok(Value::Null)
        }
        "sourcesWithHistory" => Ok(json!(h.sources()?)),
        "blobReferences" => Ok(json!(h.references()?)),
        "fingerprint" => Ok(json!(h.fingerprint(&sources)?)),
        "info" => Ok(info(h)),
        _ => Err(Error::invalid("Unknown history command")),
    }
}
pub fn command(r: &Value) -> Result<Value> {
    match string(&r["op"]) {
        "resetAccount" => account_reset::reset(&r["options"]),
        "incarnations" => Ok(json!(account_reset::load(Path::new(string(
            &r["directory"]
        )))?)),
        "resolveIdentity" => {
            let secret = STANDARD
                .decode(string(&r["secret"]))
                .map_err(|e| Error::invalid(e.to_string()))?;
            let mode = if r["mode"] == "proxy" {
                crate::identity::AuthMode::Proxy
            } else {
                crate::identity::AuthMode::Password
            };
            Ok(json!(account_reset::resolve(
                &secret,
                mode,
                string(&r["user"]),
                &serde_json::from_value(r["incarnations"].clone())?
            )))
        }
        "makeVersion" => history_state::make_version(
            &r["state"],
            &r["boundary"],
            number(&r["now"]),
            r["id"]
                .as_str()
                .unwrap_or(&hex::encode(rand::random::<[u8; 16]>())),
            r.get("before")
                .unwrap_or(&json!({"sources":{},"groups":[]})),
        ),
        "thinVersions" => Ok(json!(history_state::thin(array(&r["records"]).to_vec()))),
        "history" => {
            let started = std::time::Instant::now();
            let mut history = History::open(Path::new(string(&r["directory"])));
            let open_ms = started.elapsed().as_secs_f64() * 1000.0;
            let started = std::time::Instant::now();
            let result = history_call(&mut history, r);
            let operation_ms = started.elapsed().as_secs_f64() * 1000.0;
            Ok(
                json!({"result":response(result),"info":info(&history),"timing":{"openMs":open_ms,"operationMs":operation_ms}}),
            )
        }
        "selectionToken" => {
            let doc = new_doc();
            apply(
                &doc,
                &STANDARD
                    .decode(string(&r["doc"]))
                    .map_err(|e| Error::invalid(e.to_string()))?,
            )?;
            let quiet = serde_json::from_value(r["quietSince"].clone())?;
            Ok(json!(crate::retention::selection_token_parts(
                &doc,
                &strings(&r["sourceIds"]),
                &quiet,
                string(&r["fingerprint"])
            )))
        }
        "projection" => {
            let doc = new_doc();
            apply(
                &doc,
                &STANDARD
                    .decode(string(&r["doc"]))
                    .map_err(|e| Error::invalid(e.to_string()))?,
            )?;
            assert_current(&doc)?;
            match string(&r["method"]) {
                "label" => Ok(history_state::label_setting(&doc, string(&r["name"]))),
                "capture" => history_state::capture(&doc, &strings(&r["sourceIds"])),
                _ => Err(Error::invalid("Unknown projection")),
            }
        }
        "mkdir" => {
            mkdir_durable(Path::new(string(&r["path"])))?;
            Ok(Value::Null)
        }
        _ => Err(Error::invalid("Unknown local backend command")),
    }
}
pub fn response(result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(e) => {
            json!({"ok":false,"error":e.to_string(),"code":e.code(),"status":match e {Error::Request{status,..}=>Some(status),_=>None}})
        }
    }
}
pub fn run() -> Result<()> {
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let r: Value = serde_json::from_str(&line?)?;
        let response = response(command(&r));
        serde_json::to_writer(&mut out, &response)?;
        writeln!(out)?;
        out.flush()?;
    }
    Ok(())
}
