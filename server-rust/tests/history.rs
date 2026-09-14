use super::*;
use crate::{
    history::History,
    history_state::{make_version, thin},
};

#[test]
fn snapshots_are_independent_paginated_durable_and_absent_from_current_crdt() {
    let mut f = Fixture::new();
    note(&f.client, "a", "First body");
    f.save(&["a"], 1.);
    for (i, body) in ["Second body", "Third body"].iter().enumerate() {
        text(&f.client, "a", "body", body);
        f.save(&["a"], i as f64 + 2.);
    }
    let page = f.vault.history.list(&ids(&["a"]), None, 2).unwrap();
    assert_eq!(array(&page["versions"]).len(), 2);
    let next = f
        .vault
        .history
        .list(&ids(&["a"]), page["nextCursor"].as_str(), 2)
        .unwrap();
    assert_eq!(array(&next["versions"]).len(), 1);
    let full = f
        .vault
        .history
        .get(string(&next["versions"][0]["id"]))
        .unwrap()
        .unwrap();
    assert_eq!(full["state"]["sources"]["a"]["body"], "First body");
    for v in array(&page["versions"]) {
        for key in ["state", "schema", "action", "labelSettings"] {
            assert!(v.get(key).is_none());
        }
    }
    assert!(!contains(&f.vault.state(), "First body"));
    assert_current(&f.vault.doc).unwrap();
    f.save(&["a"], 4.);
    assert_eq!(f.vault.history.count().unwrap(), 3);
    let reopened = History::open(&f.directory.path().join("history"));
    assert_eq!(
        reopened.export().unwrap(),
        f.vault.history.export().unwrap()
    );
}
#[test]
fn descriptions_derive_actual_changes_and_ignore_forged_hints() {
    let f = Fixture::new();
    note(&f.client, "a", "");
    let mut before = history_state::capture(&f.client, &ids(&["a"])).unwrap();
    before["sources"]["a"]["items"] =
        json!({"item":{"text":"Actual item","checked":false,"rank":1}});
    let mut after = before.clone();
    after["sources"]["a"]["items"]["item"]["checked"] = json!(true);
    let checked=make_version(&after,&json!({"sourceIds":["a"],"editedAt":5,"action":{"type":"check","noteId":"a","itemId":"item","itemText":"Invented item","checked":false}}),5.,"test",&before).unwrap();
    assert!(string(&checked["label"]).contains("Checked “Actual item”"));
    assert_eq!(checked["action"]["checked"], true);
    assert!(!checked.to_string().contains("Invented"));
    let unchanged=make_version(&before,&json!({"sourceIds":["a"],"editedAt":6,"description":"Lies","action":{"type":"item-delete","noteId":"a","itemId":"item","itemText":"Invented deletion"}}),6.,"same",&before).unwrap();
    assert_eq!(unchanged["label"], "Saved note");
    assert!(!unchanged.to_string().contains("Invented"));
    let wrong=make_version(&after,&json!({"sourceIds":["a"],"editedAt":7,"action":{"type":"text","noteId":"a","field":"title"}}),7.,"wrong",&before).unwrap();
    assert_eq!(wrong["action"]["type"], "check");
}
#[test]
fn unicode_text_descriptions_match_actual_word_changes() {
    let f = Fixture::new();
    note(&f.client, "a", "");
    for (a, b, removed, inserted) in [
        ("hello world", "hello whirl", "world", "whirl"),
        ("a café", "a cafè", "café", "cafè"),
        ("first 漢字", "first 漢語", "漢字", "漢語"),
        ("x Ⅷcat", "x Ⅷbat", "Ⅷcat", "Ⅷbat"),
        (
            "old\ntext",
            "new\r\nbody\rend",
            "old · text",
            "new · body · end",
        ),
    ] {
        text(&f.client, "a", "body", a);
        let before = history_state::capture(&f.client, &ids(&["a"])).unwrap();
        text(&f.client, "a", "body", b);
        let after = history_state::capture(&f.client, &ids(&["a"])).unwrap();
        let version=make_version(&after,&json!({"sourceIds":["a"],"editedAt":1,"action":{"type":"text","noteId":"a","field":"body"}}),1.,"id",&before).unwrap();
        assert_eq!(
            version["label"],
            format!("Note: replaced “{removed}” with “{inserted}”")
        );
    }
}
#[test]
fn thinning_preserves_first_and_recent_fifty_exact_endpoints_and_action_count() {
    let f = Fixture::new();
    note(&f.client, "a", "");
    let records: Vec<_> = (0..101)
        .map(|i| {
            text(&f.client, "a", "body", &i.to_string());
            make_version(
                &history_state::capture(&f.client, &ids(&["a"])).unwrap(),
                &json!({"sourceIds":["a"],"editedAt":i}),
                i as f64,
                &format!("{i:03}"),
                &json!({"sources":{},"groups":[]}),
            )
            .unwrap()
        })
        .collect();
    let kept = thin(records.clone());
    assert_eq!(kept.len(), 75);
    assert_eq!(kept[0]["id"], "000");
    assert_eq!(&kept[25..], &records[51..]);
    assert_eq!(
        kept.iter()
            .map(|r| r["interval"]["actions"].as_f64().unwrap_or(1.) as u64)
            .sum::<u64>(),
        101
    );
    for r in &kept {
        assert_eq!(
            r["state"]["sources"]["a"]["body"],
            string(&r["id"]).parse::<u32>().unwrap().to_string()
        );
    }
    assert_eq!(thin(records.clone()), kept);
    assert!(records.iter().all(|r| r.get("interval").is_none()));
}
#[test]
fn interrupted_discard_finishes_redaction_on_restart_and_preserves_other_sources() {
    let mut f = Fixture::new();
    note(&f.client, "a", "ERASE_A");
    note(&f.client, "b", "Keep B");
    f.save(&["a", "b"], 1.);
    f.vault.history.faults.insert("writeBundle".into());
    assert_eq!(
        f.vault
            .history
            .discard(&ids(&["a"]), 2.)
            .unwrap_err()
            .code(),
        Some("ENOSPC")
    );
    f.reopen();
    assert!(array(&f.vault.history.list(&ids(&["a"]), None, 50).unwrap()["versions"]).is_empty());
    assert_eq!(
        array(&f.vault.history.list(&ids(&["b"]), None, 50).unwrap()["versions"]).len(),
        1
    );
    let exported = f.vault.history.export().unwrap().to_string();
    assert!(!exported.contains("ERASE_A"));
    assert!(exported.contains("Keep B"));
    for path in fs::read_dir(f.directory.path().join("history")).unwrap() {
        assert!(!contains(
            &fs::read(path.unwrap().path()).unwrap(),
            "ERASE_A"
        ));
    }
}
#[test]
fn permanent_deletion_redacts_mixed_snapshots_and_descriptions() {
    let mut f = Fixture::new();
    note(&f.client, "a", "ERASE_PRIVATE_BODY");
    text(&f.client, "a", "title", "ERASE_PRIVATE_TITLE");
    note(&f.client, "b", "Kept body");
    put(
        &mut f.client.transact_mut(),
        "merges",
        "edge",
        json!({"a":"a","b":"b"}),
    );
    f.save(&["a", "b"], 1.);
    meta(&f.client, "a", "trashed", json!(true));
    f.save(&["a", "b"], 2.);
    tombstone(&f.client, "a");
    f.submit(3.).unwrap();
    assert!(array(&f.vault.history.list(&ids(&["a"]), None, 50).unwrap()["versions"]).is_empty());
    let all = f.vault.history.export().unwrap().to_string();
    assert!(!all.contains("ERASE_PRIVATE"));
    assert!(all.contains("Kept body"));
}
#[test]
fn label_color_uses_actual_before_after_even_without_prior_history() {
    let mut f = Fixture::new();
    note(&f.client, "a", "");
    meta(&f.client, "a", "label:shrek", json!(true));
    put(
        &mut f.client.transact_mut(),
        "labelColors",
        "shrek",
        json!("sage"),
    );
    f.submit(1.).unwrap();
    put(
        &mut f.client.transact_mut(),
        "labelColors",
        "shrek",
        json!("coral"),
    );
    f.submit(2.).unwrap();
    f.vault
        .capture_history(
            &json!({"sourceIds":["a"],"editedAt":3,"labelSetting":{"name":"shrek","type":"color"}}),
            3.,
        )
        .unwrap();
    let page = f.vault.history.list(&ids(&["a"]), None, 50).unwrap();
    let v = &page["versions"][0];
    assert_eq!(v["kind"], "label");
    assert_eq!(v["labelChange"]["before"]["color"], "sage");
    assert_eq!(v["labelChange"]["after"]["color"], "coral");
}
#[test]
fn corrupt_history_is_separate_from_readable_current_notes() {
    let mut f = Fixture::new();
    note(&f.client, "a", "Current safe");
    f.save(&["a"], 1.);
    let path = f.directory.path().join("history").join(
        names(&f.directory.path().join("history"))
            .into_iter()
            .find(|n| n.len() == 69)
            .unwrap(),
    );
    fs::write(path, "{bad json").unwrap();
    f.reopen();
    assert_eq!(f.body("a"), "Current safe");
    assert!(f.vault.history_error.is_some());
    assert!(f.vault.history.list(&ids(&["a"]), None, 50).is_err());
}
#[test]
fn compressing_mixed_sources_preserves_other_sources_complete_timeline() {
    let mut f = Fixture::new();
    note(&f.client, "a", "");
    note(&f.client, "b", "Untouched B");
    for i in 0..110 {
        append(&f.client, "a", "body", &i.to_string());
        f.vault
            .history
            .capture(
                &history_state::capture(&f.client, &ids(&["a", "b"])).unwrap(),
                &json!({"sourceIds":["a","b"],"editedAt":i}),
                i as f64,
                &json!({}),
                None,
                false,
            )
            .unwrap();
    }
    let before = f.vault.history.export().unwrap();
    f.vault.history.thin(&ids(&["a"])).unwrap();
    let selected = f.vault.history.list(&ids(&["a"]), None, 200).unwrap();
    assert_eq!(array(&selected["versions"]).len(), 75);
    assert_eq!(
        array(&f.vault.history.list(&ids(&["b"]), None, 200).unwrap()["versions"]).len(),
        110
    );
    for v in array(&before["versions"]) {
        assert_eq!(
            f.vault.history.get(string(&v["id"])).unwrap().unwrap()["state"]["sources"]["b"],
            v["state"]["sources"]["b"]
        );
    }
    f.vault.history.thin(&ids(&["b"])).unwrap();
    assert_eq!(
        array(&f.vault.history.list(&ids(&["b"]), None, 200).unwrap()["versions"]).len(),
        75
    );
    assert_eq!(
        array(&f.vault.history.list(&ids(&["a"]), None, 200).unwrap()["versions"])
            .iter()
            .map(|v| v["id"].clone())
            .collect::<Vec<_>>(),
        array(&selected["versions"])
            .iter()
            .map(|v| v["id"].clone())
            .collect::<Vec<_>>()
    );
}
