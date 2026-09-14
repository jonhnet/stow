use super::*;
use crate::storage::atomic_write;

#[test]
fn legacy_history_snapshots_and_logs_fail_without_rewriting_bytes() {
    for name in OLD_ROOTS {
        for deleted in [false, true] {
            for log in [false, true] {
                let f = Fixture::new();
                let old = new_doc();
                let root = old.get_or_insert_map(*name);
                root.insert(&mut old.transact_mut(), "old", "preserve");
                if deleted {
                    root.remove(&mut old.transact_mut(), "old");
                }
                let bytes = encode(&old);
                let path = if log {
                    f.vault.update_dir.join("0000000000000001.yjs")
                } else {
                    f.vault.snapshot_path.clone()
                };
                fs::write(&path, &bytes).unwrap();
                assert!(
                    Vault::open(f.directory.path(), 1.)
                        .err()
                        .unwrap()
                        .to_string()
                        .contains("older history format")
                );
                assert_eq!(fs::read(path).unwrap(), bytes);
            }
        }
    }
}
#[test]
fn small_updates_append_without_cloning_or_rewriting_the_snapshot() {
    let mut f = Fixture::new();
    note(&f.client, "a", &"x".repeat(100_000));
    f.submit(1.).unwrap();
    let snapshot = fs::read(&f.vault.snapshot_path).unwrap();
    let live = f.vault.doc.guid();
    let validation = f.vault.validation.doc.guid();
    take_scans();
    append(&f.client, "a", "body", "!");
    let update = f.submit(2.).unwrap();
    let scans = take_scans();
    assert_eq!(
        scans.get("materializedMaps"),
        None,
        "Typing must not copy whole note maps"
    );
    for name in ["notes", "items", "attachments", "merges"] {
        assert_eq!(
            scans.get(name),
            None,
            "Typing must not scan the {name} root"
        );
    }
    assert!(update.bytes().len() < 100);
    assert_eq!(live, f.vault.doc.guid());
    assert_eq!(validation, f.vault.validation.doc.guid());
    assert_eq!(fs::read(&f.vault.snapshot_path).unwrap(), snapshot);
    assert_eq!(f.vault.update_files.len(), 1);
    assert_eq!(
        fs::read(f.vault.update_dir.join(&f.vault.update_files[0])).unwrap(),
        update.bytes()
    );
    f.reopen();
    assert_eq!(f.body("a"), json!(format!("{}!", "x".repeat(100_000))));
    assert_eq!(
        field(&f.vault.validation.doc.transact(), "notes", "a", "body"),
        f.body("a")
    );
}
#[test]
fn malformed_and_truncated_updates_never_poison_accepted_or_validation_state() {
    let mut f = Fixture::new();
    note(&f.client, "a", "keep");
    f.submit(1.).unwrap();
    let snapshot = fs::read(&f.vault.snapshot_path).unwrap();
    note(&f.client, "b", "retry 👩🏽‍💻");
    let update = diff(&f.client, &f.vault.doc.transact().state_vector());
    for end in 0..update.len() {
        assert!(
            f.vault.accept(&update[..end], 2.).is_err(),
            "truncation {end}"
        );
        assert!(get(&f.vault.doc.transact(), "notes", "b").is_null());
        assert!(get(&f.vault.validation.doc.transact(), "notes", "b").is_null());
        assert_eq!(fs::read(&f.vault.snapshot_path).unwrap(), snapshot);
        assert!(names(&f.vault.update_dir).is_empty());
    }
    f.submit(3.).unwrap();
    f.reopen();
    assert_eq!(f.body("b"), "retry 👩🏽‍💻");
}
#[test]
fn legacy_updates_reject_live_and_tombstoned_history_and_allow_valid_retry() {
    let mut f = Fixture::new();
    note(&f.client, "a", "keep");
    f.submit(1.).unwrap();
    let before = f.vault.state();
    for name in OLD_ROOTS {
        for deleted in [false, true] {
            let attack = clone_doc(&f.vault.doc).unwrap();
            let map = attack.get_or_insert_map(*name);
            map.insert(&mut attack.transact_mut(), "old", 1);
            if deleted {
                map.remove(&mut attack.transact_mut(), "old");
            }
            assert!(f.vault.accept(&encode(&attack), 2.).is_err());
            assert_eq!(f.vault.state(), before);
            assert_current(&f.vault.validation.doc).unwrap();
        }
    }
    append(&f.client, "a", "body", " valid");
    f.submit(3.).unwrap();
    assert_eq!(f.body("a"), "keep valid");
}
#[test]
fn failed_append_preserves_state_and_retry_succeeds() {
    let mut f = Fixture::new();
    note(&f.client, "a", "keep");
    f.submit(1.).unwrap();
    let old = f.vault.update_dir.clone();
    f.vault.update_dir = f.directory.path().join("missing/updates");
    note(&f.client, "b", "retry");
    assert_eq!(f.submit(2.).err().unwrap().code(), Some("ENOENT"));
    assert!(get(&f.vault.doc.transact(), "notes", "b").is_null());
    assert!(get(&f.vault.validation.doc.transact(), "notes", "b").is_null());
    f.vault.update_dir = old;
    f.submit(3.).unwrap();
    f.reopen();
    assert_eq!(f.body("b"), "retry");
}
#[test]
fn published_snapshot_before_log_cleanup_tolerates_duplicate_replay() {
    let mut f = Fixture::new();
    note(&f.client, "a", "first");
    f.submit(1.).unwrap();
    for word in [" second", " third"] {
        append(&f.client, "a", "body", word);
        f.submit(2.).unwrap();
    }
    atomic_write(&f.vault.snapshot_path, &f.vault.state()).unwrap();
    assert_eq!(f.vault.update_files.len(), 2);
    f.reopen();
    assert_eq!(f.body("a"), "first second third");
    f.vault.compact().unwrap();
    assert!(names(&f.vault.update_dir).is_empty());
    append(&f.client, "a", "body", "!");
    f.submit(3.).unwrap();
    f.reopen();
    assert_eq!(f.body("a"), "first second third!");
}
#[test]
fn periodic_snapshot_bounds_logs_and_retains_every_acknowledged_change() {
    let mut f = Fixture::new();
    for i in 0..505 {
        put(
            &mut f.client.transact_mut(),
            "items",
            &i.to_string(),
            json!(i),
        );
        f.submit(i as f64).unwrap();
    }
    assert!(f.vault.update_files.len() < 10);
    let snapshot = new_doc();
    apply(&snapshot, &fs::read(&f.vault.snapshot_path).unwrap()).unwrap();
    assert!(keys(&snapshot.transact(), "items").len() >= 500);
    f.reopen();
    assert_eq!(keys(&f.vault.doc.transact(), "items").len(), 505);
}
#[test]
fn out_of_order_dependencies_survive_restart_and_duplicate_replay() {
    let mut f = Fixture::new();
    note(&f.client, "a", "A🌍");
    let first = encode(&f.client);
    let v = f.client.transact().state_vector();
    append(&f.client, "a", "body", "B");
    let second = diff(&f.client, &v);
    f.vault.accept(&second, 1.).unwrap();
    assert!(has_pending(&f.vault.doc));
    f.reopen();
    f.vault.accept(&first, 2.).unwrap();
    f.vault.accept(&second, 3.).unwrap();
    f.vault.compact().unwrap();
    f.reopen();
    assert_eq!(f.body("a"), "A🌍B");
    assert_eq!(vector(&f.vault.doc), vector(&f.client));
}
#[test]
fn only_published_update_files_are_replayed_and_corruption_is_preserved() {
    let mut f = Fixture::new();
    fs::write(
        f.vault
            .update_dir
            .join("0000000000000001.yjs.0123456789abcdef.tmp"),
        [1],
    )
    .unwrap();
    f.reopen();
    let path = f.vault.update_dir.join("0000000000000001.yjs");
    fs::write(&path, [1]).unwrap();
    assert!(Vault::open(f.directory.path(), 1.).is_err());
    assert_eq!(fs::read(path).unwrap(), [1]);
}
