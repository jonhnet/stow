use super::*;
use crate::retention::{HISTORY_GRACE_MS, selection_token};
const DAY: f64 = 86_400_000.;
const START: f64 = 1_789_171_200_000.;
fn archived(f: &Fixture, id: &str) {
    note(&f.client, id, "Original content");
    meta(&f.client, id, "archived", json!(true));
}
fn token(f: &Fixture, sources: &[&str]) -> String {
    selection_token(&f.vault, &ids(sources)).unwrap()
}
#[test]
fn automatic_cleanup_is_opt_in_and_grants_seven_days_without_changing_current_bytes() {
    let mut f = Fixture::new();
    archived(&f, "a");
    f.save(&["a"], START);
    assert!(f.vault.sweep(START + 100. * DAY).unwrap().is_none());
    f.vault.set_retention(true, START + 100. * DAY).unwrap();
    let current = f.vault.state();
    assert!(f.vault.sweep(START + 107. * DAY - 1.).unwrap().is_none());
    assert_eq!(
        f.vault
            .sweep(START + 107. * DAY)
            .unwrap()
            .unwrap()
            .cleaned_note_count,
        1
    );
    assert_eq!(f.vault.history.count().unwrap(), 0);
    assert_eq!(f.vault.state(), current);
    assert_eq!(
        f.vault.history.list(&ids(&["a"]), None, 50).unwrap()["discardedAt"],
        START + 107. * DAY
    );
}
#[test]
fn offline_edits_use_server_receipt_time_for_fresh_grace() {
    let mut f = Fixture::new();
    archived(&f, "a");
    f.save(&["a"], START);
    f.vault.set_retention(true, START).unwrap();
    text(&f.client, "a", "body", "Old offline edit");
    meta(&f.client, "a", "updatedAt", json!(1));
    f.save(&["a"], START + 6. * DAY);
    assert_eq!(f.vault.retention.quiet_since["a"], START + 6. * DAY);
    assert!(f.vault.sweep(START + 13. * DAY - 1.).unwrap().is_none());
    assert_eq!(
        f.vault
            .sweep(START + 13. * DAY)
            .unwrap()
            .unwrap()
            .cleaned_note_count,
        1
    );
}
#[test]
fn unarchive_cancels_timer_and_rearchive_and_reenable_grant_full_grace() {
    let mut f = Fixture::new();
    archived(&f, "a");
    f.save(&["a"], START);
    f.vault.set_retention(true, START).unwrap();
    meta(&f.client, "a", "archived", json!(false));
    f.save(&["a"], START + 6. * DAY);
    assert!(!f.vault.retention.quiet_since.contains_key("a"));
    assert!(f.vault.sweep(START + 20. * DAY).unwrap().is_none());
    meta(&f.client, "a", "archived", json!(true));
    f.save(&["a"], START + 21. * DAY);
    assert_eq!(f.vault.retention.quiet_since["a"], START + 21. * DAY);
    f.vault.set_retention(false, START + 22. * DAY).unwrap();
    f.vault.set_retention(true, START + 30. * DAY).unwrap();
    assert!(f.vault.sweep(START + 37. * DAY - 1.).unwrap().is_none());
    assert_eq!(
        f.vault
            .sweep(START + 37. * DAY)
            .unwrap()
            .unwrap()
            .cleaned_note_count,
        1
    );
}
#[test]
fn newly_observed_archives_and_missing_metadata_receive_full_grace() {
    let mut f = Fixture::new();
    f.vault.set_retention(true, START).unwrap();
    archived(&f, "a");
    meta(&f.client, "a", "createdAt", json!(100));
    f.save(&["a"], START + 50. * DAY);
    assert_eq!(f.vault.retention.quiet_since["a"], START + 50. * DAY);
    fs::write(
        &f.vault.retention_path,
        r#"{"schema":1,"enabled":true,"quietSince":{}}"#,
    )
    .unwrap();
    f.vault = Vault::open(f.directory.path(), START + 80. * DAY).unwrap();
    assert_eq!(f.vault.retention.quiet_since["a"], START + 80. * DAY);
    assert!(f.vault.sweep(START + 87. * DAY - 1.).unwrap().is_none());
}
#[test]
fn confirmed_selection_allows_unrelated_edits_but_rejects_changed_content_or_unarchive() {
    let mut f = Fixture::new();
    archived(&f, "a");
    note(&f.client, "live", "");
    f.save(&["a", "live"], START);
    let selected = token(&f, &["a"]);
    text(&f.client, "live", "body", "Unrelated");
    f.save(&["live"], START + DAY);
    assert_eq!(token(&f, &["a"]), selected);
    text(&f.client, "a", "body", "Changed");
    f.save(&["a"], START + 2. * DAY);
    assert_eq!(
        f.vault
            .discard_history(&ids(&["a"]), Some(&selected), START + 2. * DAY)
            .err()
            .unwrap()
            .code(),
        Some("archive_selection_changed")
    );
    let fresh = token(&f, &["a"]);
    meta(&f.client, "a", "archived", json!(false));
    f.save(&["a"], START + 3. * DAY);
    assert!(
        f.vault
            .discard_history(&ids(&["a"]), Some(&fresh), START + 3. * DAY)
            .is_err()
    );
}
#[test]
fn concurrent_merge_cannot_expand_confirmed_cleanup_selection() {
    let mut f = Fixture::new();
    archived(&f, "a");
    archived(&f, "b");
    f.save(&["a", "b"], START);
    let selected = token(&f, &["a"]);
    put(
        &mut f.client.transact_mut(),
        "merges",
        "edge",
        json!({"a":"a","b":"b"}),
    );
    f.save(&["a", "b"], START + DAY);
    assert!(
        f.vault
            .discard_history(&ids(&["a"]), Some(&selected), START + DAY)
            .is_err()
    );
    let fresh = token(&f, &["a", "b"]);
    assert_eq!(
        f.vault
            .discard_history(&ids(&["a", "b"]), Some(&fresh), START + DAY)
            .unwrap()
            .cleaned_note_count,
        1
    );
}
#[test]
fn stale_current_snapshot_cannot_restore_discarded_versions() {
    let mut f = Fixture::new();
    archived(&f, "a");
    f.save(&["a"], START);
    let selected = token(&f, &["a"]);
    f.vault
        .discard_history(&ids(&["a"]), Some(&selected), START + DAY)
        .unwrap();
    f.submit(START + 2. * DAY).unwrap();
    assert_eq!(f.vault.history.count().unwrap(), 0);
    text(&f.client, "a", "body", "Late current text");
    f.save(&["a"], START + 3. * DAY);
    assert_eq!(f.vault.history.count().unwrap(), 1);
    assert_eq!(
        f.vault.history.export().unwrap()["versions"][0]["state"]["sources"]["a"]["body"],
        "Late current text"
    );
    f.reopen();
    assert_eq!(f.vault.history.count().unwrap(), 1);
}
#[test]
fn archive_cleanup_retains_image_bytes_for_undo_until_permanent_source_deletion() {
    let mut f = Fixture::new();
    archived(&f, "a");
    let h = "a".repeat(64);
    attachment(&f.client, "image", "a", &h);
    f.save(&["a"], START);
    fs::write(f.vault.blob_dir.join(&h), "old").unwrap();
    let thumbs = f.directory.path().join("thumbnails-v1");
    fs::create_dir(&thumbs).unwrap();
    fs::write(thumbs.join(format!("{h}.webp")), "thumbnail").unwrap();
    remove(&mut f.client.transact_mut(), "attachments", "image");
    f.save(&["a"], START + DAY);
    let before = f.vault.state();
    let selected = token(&f, &["a"]);
    f.vault
        .discard_history(&ids(&["a"]), Some(&selected), START + 2. * DAY)
        .unwrap();
    let storage = f.vault.storage().unwrap();
    assert_eq!(storage["originalsBytes"], 3);
    assert_eq!(storage["thumbnailsBytes"], 9);
    assert_eq!(storage["historyCount"], 0);
    assert_eq!(f.vault.state(), before);
    tombstone(&f.client, "a");
    f.submit(START + 3. * DAY).unwrap();
    let storage = f.vault.storage().unwrap();
    assert_eq!(storage["originalsBytes"], 0);
    assert_eq!(storage["thumbnailsBytes"], 0);
}
#[test]
fn scheduling_failure_rejects_edits_while_cleanup_failure_keeps_current_state() {
    let mut f = Fixture::new();
    archived(&f, "a");
    f.save(&["a"], START);
    f.vault.set_retention(true, START).unwrap();
    let original = f.vault.retention_path.clone();
    f.vault.retention_path = f.directory.path().join("missing/schedule.json");
    text(&f.client, "a", "body", "Not committed");
    assert_eq!(f.submit(START + DAY).err().unwrap().code(), Some("ENOENT"));
    assert_eq!(f.body("a"), "Original content");
    f.vault.retention_path = original;
    f.save(&["a"], START + DAY);
    let current = f.vault.state();
    f.vault.history.faults.insert("discard".into());
    let selected = token(&f, &["a"]);
    assert_eq!(
        f.vault
            .discard_history(&ids(&["a"]), Some(&selected), START + 2. * DAY)
            .err()
            .unwrap()
            .code(),
        Some("ENOSPC")
    );
    assert_eq!(f.vault.state(), current);
    assert!(f.vault.history.count().unwrap() > 0);
}
#[test]
fn ordinary_keystrokes_never_read_saved_versions_or_rewrite_full_snapshot() {
    let mut f = Fixture::new();
    archived(&f, "a");
    note(&f.client, "live", "");
    f.save(&["a", "live"], START);
    let selected = token(&f, &["a"]);
    f.vault
        .discard_history(&ids(&["a"]), Some(&selected), START + DAY)
        .unwrap();
    let snapshot = fs::read(&f.vault.snapshot_path).unwrap();
    f.vault.history.faults = ids(&["list", "export", "sourcesWithHistory", "blobReferences"])
        .into_iter()
        .collect();
    append(&f.client, "live", "body", "x");
    f.submit(START + 2. * DAY).unwrap();
    assert_eq!(fs::read(&f.vault.snapshot_path).unwrap(), snapshot);
    assert_eq!(f.vault.update_files.len(), 1);
}
fn compression(category: &str) {
    let mut f = Fixture::new();
    note(&f.client, "a", "Original");
    if category != "active" {
        meta(&f.client, "a", category, json!(true));
    }
    assert_eq!(f.vault.storage().unwrap()["compression"]["enabled"], true);
    f.vault.set_compression(false).unwrap();
    for i in 0..105 {
        text(&f.client, "a", "body", &format!("Version {i}"));
        f.save(&["a"], START + i as f64);
    }
    assert_eq!(f.vault.history.count().unwrap(), 105);
    let before = f.vault.state();
    f.vault.set_retention(true, START + 200.).unwrap();
    assert_eq!(f.vault.retention.compress_history, Some(false));
    f.vault.set_compression(true).unwrap();
    assert_eq!(f.vault.history.count().unwrap(), 75);
    assert_eq!(f.vault.state(), before);
    for v in array(&f.vault.history.list(&ids(&["a"]), None, 100).unwrap()["versions"])
        .iter()
        .take(50)
    {
        let full = f.vault.history.get(string(&v["id"])).unwrap().unwrap();
        assert_eq!(
            full["state"]["sources"]["a"]["body"],
            format!("Version {}", number(&v["timestamp"]) - START)
        );
    }
    f.reopen();
    assert_eq!(f.vault.history.count().unwrap(), 75);
    assert!(f.vault.retention.enabled);
    assert_eq!(f.vault.retention.compress_history, Some(true));
}
#[test]
fn compression_active() {
    compression("active")
}
#[test]
fn compression_archived() {
    compression("archived")
}
#[test]
fn compression_trashed() {
    compression("trashed")
}
#[test]
fn failed_compression_preserves_durable_current_edit_and_same_state_retry_thins() {
    let mut f = Fixture::new();
    note(&f.client, "a", "");
    for i in 0..100 {
        text(&f.client, "a", "body", &format!("Version {i}"));
        f.save(&["a"], START + i as f64);
    }
    f.vault.history.faults.insert("thin".into());
    text(&f.client, "a", "body", "Still durable");
    f.submit(START + 100.).unwrap();
    assert_eq!(
        f.vault
            .capture_history(
                &json!({"sourceIds":["a"],"editedAt":START+100.}),
                START + 100.
            )
            .unwrap_err()
            .code(),
        Some("ENOSPC")
    );
    assert_eq!(f.body("a"), "Still durable");
    assert_eq!(f.vault.history.count().unwrap(), 101);
    f.vault.history.faults.clear();
    f.vault
        .capture_history(
            &json!({"sourceIds":["a"],"editedAt":START+100.}),
            START + 101.,
        )
        .unwrap();
    assert_eq!(f.vault.history.count().unwrap(), 75);
    assert!(!f.vault.history.thin(&ids(&["a"])).unwrap());
}
#[test]
fn offline_current_edit_after_compression_cannot_resurrect_discarded_history() {
    let mut f = Fixture::new();
    note(&f.client, "a", "Original body");
    f.save(&["a"], START);
    let first = f.vault.history.list(&ids(&["a"]), None, 100).unwrap()["versions"][0]["id"].clone();
    let offline = clone_doc(&f.client).unwrap();
    text(&offline, "a", "title", "Late offline title");
    for i in 0..180 {
        text(&f.client, "a", "body", &format!("Current body {i}"));
        f.save(&["a"], START + 1. + i as f64);
    }
    let before = f.vault.history.list(&ids(&["a"]), None, 100).unwrap();
    let retained: Vec<_> = array(&before["versions"])
        .iter()
        .map(|v| v["id"].clone())
        .collect();
    assert!(retained.contains(&first));
    let update = diff(&f.vault.doc, &offline.transact().state_vector());
    apply(&offline, &update).unwrap();
    f.client = offline;
    f.save(&["a"], START + 1000.);
    assert_eq!(f.body("a"), "Current body 179");
    let after = f.vault.history.list(&ids(&["a"]), None, 100).unwrap();
    assert!(array(&after["versions"]).len() <= 100);
    assert_eq!(
        array(&after["versions"])
            .iter()
            .filter(|v| !retained.contains(&v["id"]))
            .count(),
        1
    );
    assert_eq!(
        field(&f.vault.doc.transact(), "notes", "a", "title"),
        "Late offline title"
    );
}
#[test]
fn grace_constant_is_seven_days() {
    assert_eq!(HISTORY_GRACE_MS, 7. * DAY);
}
