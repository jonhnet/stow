use super::{
    api::{auth, identity, json_request, request, start},
    *,
};
use crate::background_diagnostics::{self as logs, MAX_DEVICES, MAX_EVENTS, RETENTION_MS};
use axum::http::HeaderMap;

const DEVICE: &str = "11111111-1111-4111-8111-111111111111";
fn upload(device: &str, from: u64, to: u64) -> Value {
    json!({"schema":1,"deviceId":device,"source":"foreground","build":null,"through":to,"droppedUnacknowledged":0,
        "events":(from..=to).map(|seq| json!({"seq":seq,"at":1000,"kind":"registration","availability":"not-permitted","permission":"denied","standalone":true})).collect::<Vec<_>>()})
}

#[test]
fn event_builds_survive_new_uploaders_retries_and_unstamped_events() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("logs.json");
    let tab = "a".repeat(40);
    let worker = "b".repeat(40);
    let uploader = "c".repeat(40);
    let retry = "d".repeat(40);
    let mut body = upload(DEVICE, 1, 4);
    body["build"] = json!(uploader);
    body["events"][0]["build"] = json!(tab);
    body["events"][1]["build"] = json!(worker);
    // Missing (already queued before stamping) and explicitly unknown builds.
    body["events"][3]["build"] = Value::Null;
    logs::accept(
        &file,
        logs::parse(body.clone()).unwrap(),
        "browser".into(),
        1000.,
    )
    .unwrap();
    let first = logs::read(&file, 1001.).unwrap();
    let device = &first["devices"][0];
    assert_eq!(device["lastUploadBuild"], uploader);
    assert_eq!(device["events"][0]["build"], tab);
    assert_eq!(device["events"][1]["build"], worker);
    assert!(device["events"][2]["build"].is_null());
    assert!(device["events"][3]["build"].is_null());
    body["build"] = json!(retry);
    logs::accept(&file, logs::parse(body).unwrap(), "browser".into(), 2000.).unwrap();
    let after = logs::read(&file, 2001.).unwrap();
    assert_eq!(after["devices"][0]["lastUploadBuild"], retry);
    assert_eq!(after["devices"][0]["events"], device["events"]);
}

#[tokio::test]
async fn background_logs_are_bound_to_the_account_and_survive_restart_without_a_vault_crdt() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({"now":10000})).await;
    let alice = identity(&s, "alice").await;
    let bob = identity(&s, "bob").await;
    let h = auth("alice", Some(&alice));
    let endpoint = "/api/diagnostics/background";
    let mut body = upload(DEVICE, 1, 1);
    body["privateNote"] = json!("never retain this");
    body["events"][0]["privateNote"] = json!("never retain this either");
    assert_eq!(
        request(&s, "GET", endpoint, &HeaderMap::new(), vec![])
            .await
            .status,
        401
    );
    assert_eq!(
        json_request(
            &s,
            "POST",
            endpoint,
            &auth("alice", Some(&bob)),
            body.clone()
        )
        .await
        .status,
        409
    );
    let mut foreign = h.clone();
    foreign.insert("origin", "https://foreign.invalid".parse().unwrap());
    assert_eq!(
        json_request(&s, "POST", endpoint, &foreign, body.clone())
            .await
            .status,
        403
    );
    for _ in 0..2 {
        assert_eq!(
            json_request(&s, "POST", endpoint, &h, body.clone())
                .await
                .status,
            201
        );
    }
    let report = request(&s, "GET", endpoint, &h, vec![]).await.json();
    assert_eq!(report["devices"][0]["events"].as_array().unwrap().len(), 1);
    assert!(!report.to_string().contains("privateNote"));
    assert!(
        request(&s, "GET", endpoint, &auth("bob", Some(&bob)), vec![])
            .await
            .json()["devices"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        dir.path()
            .join("diagnostics/background-sync")
            .join(format!("{alice}.json"))
            .exists()
    );
    assert!(
        !dir.path()
            .join("users")
            .join(&alice)
            .join("vault.yjs")
            .exists()
    );
    s.close().await.unwrap();
    let s = start(dir.path(), json!({"now":11000})).await;
    assert_eq!(
        request(&s, "GET", endpoint, &h, vec![]).await.json(),
        report
    );
    s.close().await.unwrap();
}

#[test]
fn background_retention_deduplicates_retries_bounds_devices_and_uses_server_receipt_time() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("logs.json");
    for index in 0..=MAX_EVENTS / 200 {
        logs::accept(
            &file,
            logs::parse(upload(
                DEVICE,
                (index * 200 + 1) as u64,
                ((index + 1) * 200) as u64,
            ))
            .unwrap(),
            "Android".into(),
            10000.,
        )
        .unwrap();
    }
    let result = logs::read(&file, 10001.).unwrap();
    assert_eq!(
        result["devices"][0]["events"].as_array().unwrap().len(),
        MAX_EVENTS
    );
    let first = result["devices"][0]["events"][0].clone();
    logs::accept(
        &file,
        logs::parse(upload(DEVICE, 1, 200)).unwrap(),
        "Android".into(),
        11000.,
    )
    .unwrap();
    assert_eq!(
        logs::read(&file, 11000.).unwrap()["devices"][0]["events"][0],
        first
    );
    for i in 1..=MAX_DEVICES {
        let id = format!("{i:08x}-2222-4222-8222-222222222222");
        logs::accept(
            &file,
            logs::parse(upload(&id, 1, 1)).unwrap(),
            "Firefox".into(),
            12000.,
        )
        .unwrap();
    }
    let result = logs::read(&file, 12000.).unwrap();
    assert_eq!(result["devices"].as_array().unwrap().len(), MAX_DEVICES);
    assert!(!result.to_string().contains(DEVICE));
    assert!(
        logs::read(&file, 12001. + RETENTION_MS).unwrap()["devices"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        serde_json::from_slice::<Value>(&fs::read(file).unwrap()).unwrap()["devices"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn background_reports_validate_events_and_do_not_acknowledge_failed_persistence() {
    for change in [
        json!({"deviceId":"../../escape"}),
        json!({"through":0}),
        json!({"source":"notes"}),
        json!({"events":[{"seq":1,"at":1,"kind":"note-content"}]}),
        json!({"events":[{"seq":1,"at":1,"kind":"failure","runId":DEVICE,"durationMs":-1,"message":"error"}]}),
        json!({"events":[{"seq":1,"at":1,"kind":"registration-check","standalone":true,"build":"too-short"}]}),
        json!({"events":[{"seq":1,"at":1,"kind":"registration-check","standalone":true,"build":"g".repeat(40)}]}),
    ] {
        let mut report = upload(DEVICE, 1, 1);
        report
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        assert!(logs::parse(report).is_err());
    }
    assert!(logs::parse(upload(DEVICE, 1, 201)).is_err());
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("not-a-directory");
    fs::write(&file, b"unchanged").unwrap();
    assert!(
        logs::accept(
            &file.join("logs.json"),
            logs::parse(upload(DEVICE, 1, 1)).unwrap(),
            "browser".into(),
            1.
        )
        .is_err()
    );
    assert_eq!(fs::read(file).unwrap(), b"unchanged");
}
