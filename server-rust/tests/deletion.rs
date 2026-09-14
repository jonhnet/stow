use super::*;
use sha2::{Digest, Sha256};
fn hash(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}
#[test]
fn deletion_purges_private_bytes_logs_history_and_previews_preserving_shared_owners() {
    let mut f = Fixture::new();
    note(&f.client, "a", "Erase-private-body");
    text(&f.client, "a", "title", "Erase-private-title");
    note(&f.client, "b", "Retained");
    let old = hash("old");
    let current = hash("current");
    let shared = hash("shared");
    let stage = hash("stage");
    for (id, h) in [("old", &old), ("current", &current), ("shared", &shared)] {
        attachment(&f.client, id, "a", h);
    }
    attachment(&f.client, "surviving-history-image", "b", &shared);
    let thumbs = f.directory.path().join("thumbnails-v1");
    fs::create_dir(&thumbs).unwrap();
    for h in [&old, &current, &shared, &stage] {
        fs::write(f.vault.blob_dir.join(h), "original").unwrap();
        fs::write(thumbs.join(format!("{h}.webp")), "preview").unwrap();
    }
    f.save(&["a", "b"], 1.);
    for id in ["old", "surviving-history-image"] {
        remove(&mut f.client.transact_mut(), "attachments", id);
    }
    f.save(&["a", "b"], 2.);
    text(&f.client, "a", "body", "Erase-revised-private-body");
    f.submit(3.).unwrap();
    fs::write(
        f.directory.path().join("vault.yjs.0123456789abcdef.tmp"),
        "Erase-private-title",
    )
    .unwrap();
    fs::write(
        f.vault
            .update_dir
            .join("0000000000000099.yjs.0123456789abcdef.tmp"),
        "Erase-private-body",
    )
    .unwrap();
    fs::write(
        f.directory
            .path()
            .join("history")
            .join(format!("{}.json.0123456789abcdef.tmp", "a".repeat(64))),
        "Erase-private-history",
    )
    .unwrap();
    tombstone(&f.client, "a");
    f.submit(4.).unwrap();
    assert!(get(&f.vault.doc.transact(), "notes", "a").is_null());
    assert_eq!(f.body("b"), "Retained");
    assert!(names(&f.vault.update_dir).is_empty());
    for directory in [
        f.directory.path().to_path_buf(),
        f.directory.path().join("history"),
    ] {
        assert!(names(&directory).iter().all(|n| !n.ends_with(".tmp")));
    }
    assert!(!contains(
        &fs::read(&f.vault.snapshot_path).unwrap(),
        "Erase-"
    ));
    assert!(
        !f.vault
            .history
            .export()
            .unwrap()
            .to_string()
            .contains("Erase-")
    );
    let mut kept = vec![shared.clone(), stage.clone()];
    kept.sort();
    assert_eq!(names(&f.vault.blob_dir), kept);
    assert_eq!(
        names(&thumbs),
        kept.iter().map(|h| format!("{h}.webp")).collect::<Vec<_>>()
    );
    f.reopen();
    assert_eq!(get(&f.vault.doc.transact(), "deletedNotes", "a"), true);
    tombstone(&f.client, "b");
    f.submit(5.).unwrap();
    assert_eq!(names(&f.vault.blob_dir), vec![stage]);
}
#[test]
fn late_offline_attachments_are_corrected_before_publication() {
    let mut f = Fixture::new();
    note(&f.client, "a", "");
    f.submit(1.).unwrap();
    let offline = clone_doc(&f.client).unwrap();
    text(&offline, "a", "body", "Late-private-body");
    let h = hash("late");
    attachment(&offline, "late", "a", &h);
    fs::write(f.vault.blob_dir.join(&h), "late").unwrap();
    tombstone(&f.client, "a");
    f.submit(2.).unwrap();
    let update = diff(&offline, &f.vault.doc.transact().state_vector());
    let accepted = f.vault.accept(&update, 3.).unwrap();
    assert!(accepted.corrected());
    apply(&offline, accepted.bytes()).unwrap();
    assert!(get(&offline.transact(), "notes", "a").is_null());
    assert!(keys(&f.vault.doc.transact(), "attachments").is_empty());
    assert!(names(&f.vault.blob_dir).is_empty());
    assert!(!contains(
        &fs::read(&f.vault.snapshot_path).unwrap(),
        "Late-private-body"
    ));
    assert!(names(&f.vault.update_dir).is_empty());
    f.reopen();
    assert!(keys(&f.vault.doc.transact(), "notes").is_empty());
}
#[test]
fn late_nested_text_to_collected_source_is_never_written_but_surviving_edit_is() {
    let mut f = Fixture::new();
    note(&f.client, "a", "Original");
    note(&f.client, "b", "Keep");
    f.submit(1.).unwrap();
    let offline = clone_doc(&f.client).unwrap();
    let v = offline.transact().state_vector();
    append(&offline, "a", "body", "Late-erased-secret");
    append(&offline, "b", "body", " this edit");
    let late = diff(&offline, &v);
    assert!(contains(&late, "Late-erased-secret"));
    tombstone(&f.client, "a");
    f.submit(2.).unwrap();
    let snapshot = fs::read(&f.vault.snapshot_path).unwrap();
    f.vault.accept(&late, 3.).unwrap();
    assert_eq!(fs::read(&f.vault.snapshot_path).unwrap(), snapshot);
    assert_eq!(f.vault.update_files.len(), 1);
    assert!(!contains(
        &fs::read(f.vault.update_dir.join(&f.vault.update_files[0])).unwrap(),
        "Late-erased-secret"
    ));
    f.reopen();
    assert_eq!(f.body("b"), "Keep this edit");
    assert!(get(&f.vault.doc.transact(), "notes", "a").is_null());
}
#[test]
fn resolving_pending_dependencies_removes_private_payload_without_losing_live_edit() {
    let mut f = Fixture::new();
    note(&f.client, "a", "Original");
    note(&f.client, "b", "Keep");
    f.submit(1.).unwrap();
    let offline = clone_doc(&f.client).unwrap();
    let v = offline.transact().state_vector();
    append(&offline, "b", "body", " this edit");
    let predecessor = diff(&offline, &v);
    let v = offline.transact().state_vector();
    append(&offline, "a", "body", "Unresolved-erased-secret");
    let dependent = diff(&offline, &v);
    tombstone(&f.client, "a");
    f.submit(2.).unwrap();
    f.vault.accept(&dependent, 3.).unwrap();
    assert!(has_pending(&f.vault.validation.doc));
    f.vault.accept(&predecessor, 4.).unwrap();
    assert!(!has_pending(&f.vault.validation.doc));
    assert!(names(&f.vault.update_dir).is_empty());
    assert!(!contains(
        &fs::read(&f.vault.snapshot_path).unwrap(),
        "Unresolved-erased-secret"
    ));
    f.reopen();
    assert_eq!(f.body("b"), "Keep this edit");
}
#[test]
fn invalid_deletion_hashes_cannot_publish_state_or_access_other_paths() {
    let mut f = Fixture::new();
    note(&f.client, "a", "Retained");
    f.submit(1.).unwrap();
    let outside = f.directory.path().join("outside");
    fs::write(&outside, "Keep").unwrap();
    let snapshot = fs::read(&f.vault.snapshot_path).unwrap();
    for h in [
        "../outside".into(),
        "/tmp/outside".into(),
        "a".repeat(63),
        "A".repeat(64),
    ] {
        let attack = clone_doc(&f.vault.doc).unwrap();
        put(
            &mut attack.transact_mut(),
            "deletedBlobCandidates",
            &h,
            json!(true),
        );
        assert!(
            f.vault
                .accept(&encode(&attack), 2.)
                .err()
                .unwrap()
                .to_string()
                .contains("Invalid permanent deletion blob hash")
        );
        assert_eq!(fs::read(&f.vault.snapshot_path).unwrap(), snapshot);
        assert!(names(&f.vault.update_dir).is_empty());
        assert!(keys(&f.vault.doc.transact(), "deletedBlobCandidates").is_empty());
        assert_eq!(fs::read(&outside).unwrap(), b"Keep");
    }
}
#[test]
fn cleanup_journal_resumes_after_failure_following_document_publication() {
    let mut f = Fixture::new();
    note(&f.client, "a", "");
    let h = hash("interrupted");
    attachment(&f.client, "image", "a", &h);
    f.submit(1.).unwrap();
    let path = f.vault.blob_dir.join(&h);
    fs::create_dir(&path).unwrap();
    tombstone(&f.client, "a");
    assert_eq!(f.submit(2.).err().unwrap().code(), Some("EISDIR"));
    let journal: Value = serde_json::from_slice(&fs::read(&f.vault.cleanup_path).unwrap()).unwrap();
    assert!(strings(&journal["pending"]).contains(&h));
    assert!(get(&f.vault.doc.transact(), "notes", "a").is_null());
    fs::remove_dir(&path).unwrap();
    fs::write(path, "original").unwrap();
    f.reopen();
    assert!(names(&f.vault.blob_dir).is_empty());
    assert!(f.vault.cleanup.pending.is_empty());
}
#[test]
fn cleanup_intent_before_failed_publication_does_not_authorize_deletion() {
    let mut f = Fixture::new();
    note(&f.client, "a", "");
    let h = hash("keep");
    attachment(&f.client, "image", "a", &h);
    f.submit(1.).unwrap();
    fs::write(f.vault.blob_dir.join(&h), "original").unwrap();
    f.vault.snapshot_path = f.directory.path().join("unavailable/vault.yjs");
    tombstone(&f.client, "a");
    assert_eq!(f.submit(2.).err().unwrap().code(), Some("ENOENT"));
    assert!(f.vault.cleanup.pending.contains(&h));
    assert!(!get(&f.vault.doc.transact(), "notes", "a").is_null());
    f.reopen();
    assert!(!get(&f.vault.doc.transact(), "notes", "a").is_null());
    assert_eq!(fs::read(f.vault.blob_dir.join(h)).unwrap(), b"original");
}
#[test]
fn upload_reservations_protect_hash_reuse_across_deletion_restart_and_later_sync() {
    let mut f = Fixture::new();
    note(&f.client, "a", "");
    let h = hash("reuse");
    attachment(&f.client, "image", "a", &h);
    f.submit(1.).unwrap();
    f.vault.reserve_upload(&h, &ids(&["future"])).unwrap();
    fs::write(f.vault.blob_dir.join(&h), "original").unwrap();
    tombstone(&f.client, "a");
    f.submit(2.).unwrap();
    f.reopen();
    assert_eq!(f.vault.cleanup.uploads[&h], ids(&["future"]));
    let snapshot = fs::read(&f.vault.snapshot_path).unwrap();
    note(&f.client, "unrelated", "");
    f.submit(3.).unwrap();
    assert_eq!(fs::read(&f.vault.snapshot_path).unwrap(), snapshot);
    note(&f.client, "future", "");
    attachment(&f.client, "future-image", "future", &h);
    f.submit(4.).unwrap();
    assert!(f.vault.cleanup.uploads.is_empty());
    assert_eq!(fs::read(f.vault.blob_dir.join(&h)).unwrap(), b"original");
    tombstone(&f.client, "future");
    f.submit(5.).unwrap();
    assert!(names(&f.vault.blob_dir).is_empty());
    assert!(f.vault.reserve_upload(&h, &[]).is_err());
    assert!(f.vault.reserve_upload(&h, &ids(&["a"])).is_err());
    f.vault.reserve_upload(&h, &ids(&["another"])).unwrap();
}
#[test]
fn import_deletion_removes_raw_original_manifest_but_keeps_other_originals_and_receipt() {
    let mut f = Fixture::new();
    let a = hash("private raw");
    let b = hash("retained raw");
    let manifest_bytes=json!({"format":"stow-keep-source-v1","notes":[{"sourcePath":"a.json"},{"sourcePath":"b.json"}]}).to_string();
    let manifest = hash(&manifest_bytes);
    let source_id = |path: &str| {
        format!(
            "keep-{}",
            &hash(&json!(["op", "note", path]).to_string())[..32]
        )
    };
    let aid = source_id("a.json");
    let bid = source_id("b.json");
    for (id, h) in [(&aid, &a), (&bid, &b)] {
        note(&f.client, id, "");
        meta(&f.client, id, "takeout", json!({"rawHash":h}));
        fs::write(f.vault.blob_dir.join(h), "raw").unwrap();
    }
    put(
        &mut f.client.transact_mut(),
        "imports",
        "op",
        json!({"sourceIds":[aid,bid]}),
    );
    put(
        &mut f.client.transact_mut(),
        "importSources",
        "op",
        json!({"source":"google-keep","manifestHash":manifest}),
    );
    fs::write(f.vault.blob_dir.join(&manifest), &manifest_bytes).unwrap();
    f.submit(1.).unwrap();
    tombstone(&f.client, &aid);
    assert!(f.submit(2.).unwrap().corrected());
    assert!(get(&f.vault.doc.transact(), "importSources", "op").is_null());
    assert!(!get(&f.vault.doc.transact(), "imports", "op").is_null());
    assert_eq!(names(&f.vault.blob_dir), vec![b]);
    f.reopen();
    put(
        &mut f.client.transact_mut(),
        "importSources",
        "op",
        json!({"manifestHash":manifest}),
    );
    f.submit(3.).unwrap();
    assert!(get(&f.vault.doc.transact(), "importSources", "op").is_null());
    put(
        &mut f.client.transact_mut(),
        "importSources",
        "fresh",
        json!({"manifestHash":manifest}),
    );
    fs::write(f.vault.blob_dir.join(&manifest), &manifest_bytes).unwrap();
    f.submit(4.).unwrap();
    assert!(!get(&f.vault.doc.transact(), "importSources", "fresh").is_null());
}
#[test]
fn removed_images_survive_for_undo_until_every_owner_is_permanently_deleted() {
    let mut f = Fixture::new();
    note(&f.client, "a", "");
    note(&f.client, "b", "");
    let h = hash("undo");
    attachment(&f.client, "image-a", "a", &h);
    attachment(&f.client, "image-b", "b", &h);
    f.submit(1.).unwrap();
    fs::write(f.vault.blob_dir.join(&h), "original").unwrap();
    for id in ["image-a", "image-b"] {
        remove(&mut f.client.transact_mut(), "attachments", id);
    }
    f.submit(2.).unwrap();
    assert_eq!(f.vault.history.count().unwrap(), 0);
    f.reopen();
    assert_eq!(f.vault.cleanup.owners[&h], ids(&["a", "b"]));
    attachment(&f.client, "image-b", "b", &h);
    f.submit(3.).unwrap();
    assert_eq!(fs::read(f.vault.blob_dir.join(&h)).unwrap(), b"original");
    remove(&mut f.client.transact_mut(), "attachments", "image-b");
    f.submit(4.).unwrap();
    tombstone(&f.client, "a");
    f.submit(5.).unwrap();
    assert!(f.vault.blob_dir.join(&h).exists());
    tombstone(&f.client, "b");
    f.submit(6.).unwrap();
    assert!(names(&f.vault.blob_dir).is_empty());
}
