use super::api::{auth, request, start};
use super::*;
use axum::http::HeaderMap;
use base64::{Engine, engine::general_purpose::STANDARD};
const SHARED: &str = "share_11111111-2222-4333-8444-555555555555";
fn cap() -> String {
    format!("{SHARED}.{}", "a".repeat(64))
}
fn headers(user: &str, vault: &str) -> HeaderMap {
    auth(user, Some(vault))
}
fn shared_headers(user: &str) -> HeaderMap {
    let mut h = auth(user, Some(SHARED));
    h.insert("x-stow-share", cap().parse().unwrap());
    h
}

#[tokio::test]
async fn publication_is_idempotent_retires_private_sources_and_starts_fresh_history() {
    let dir = TempDir::new().unwrap();
    let server = start(dir.path(), json!({})).await;
    let session = request(
        &server,
        "GET",
        "/api/session",
        &auth("alice@example.test", None),
        vec![],
    )
    .await
    .json();
    let account = string(&session["vaultId"]);
    let doc = new_doc();
    note(&doc, "private", "private past");
    let mut private = Vault::open(&dir.path().join("users").join(account), 1.0).unwrap();
    private.accept(&encode(&doc), 1.0).unwrap();
    private
        .capture_history(&json!({"sourceIds":["private"],"editedAt":1}), 1.0)
        .unwrap();
    drop(private);
    let shared = new_doc();
    note(&shared, SHARED, "shared current");
    let body = json!({"capability":cap(),"snapshot":STANDARD.encode(encode(&shared)),"sourceIds":["private"]}).to_string().into_bytes();
    let h = headers("alice@example.test", account);
    for _ in 0..2 {
        let response = request(&server, "POST", "/api/shares/publish", &h, body.clone()).await;
        assert_eq!(
            response.status,
            200,
            "{}",
            String::from_utf8_lossy(&response.bytes)
        );
    }
    let shared_h = shared_headers("jeremy@example.test");
    let session = request(&server, "GET", "/api/session", &shared_h, vec![])
        .await
        .json();
    assert_eq!(session["vaultId"], SHARED);
    assert!(session["principalId"].is_string());
    let history = request(&server, "GET", "/api/history/export", &shared_h, vec![]).await;
    assert_eq!(history.status, 200);
    assert!(!String::from_utf8_lossy(&history.bytes).contains("private past"));
    let mut bad = shared_h.clone();
    bad.insert(
        "x-stow-share",
        format!("{SHARED}.{}", "b".repeat(64)).parse().unwrap(),
    );
    assert_eq!(
        request(&server, "GET", "/api/session", &bad, vec![])
            .await
            .status,
        403
    );
    let mut mismatch = shared_h.clone();
    mismatch.insert("x-stow-vault", account.parse().unwrap());
    assert_eq!(
        request(&server, "GET", "/api/history/export", &mismatch, vec![])
            .await
            .status,
        409
    );
    let mut add_h = shared_h.clone();
    add_h.insert(
        "x-stow-vault",
        string(&session["principalId"]).parse().unwrap(),
    );
    assert_eq!(
        request(&server, "POST", "/api/shares/add", &add_h, vec![])
            .await
            .status,
        200
    );
    let mut add_h = shared_h.clone();
    add_h.insert(
        "x-stow-vault",
        string(&session["principalId"]).parse().unwrap(),
    );
    assert_eq!(
        request(&server, "POST", "/api/shares/add", &add_h, vec![])
            .await
            .status,
        200
    );
    server.close().await.unwrap();
    let mut private = Vault::open(&dir.path().join("users").join(account), 10.0).unwrap();
    assert!(keys(&private.doc.transact(), "deletedNotes").contains("private"));
    assert_eq!(
        field(&private.doc.transact(), "notes", SHARED, "share")["id"],
        SHARED
    );
    append(&doc, "private", "body", " late offline text");
    private.accept(&encode(&doc), 11.0).unwrap();
    assert!(!keys(&private.doc.transact(), "notes").contains("private"));
}

#[tokio::test]
async fn anonymous_participants_have_signed_identity_and_no_retention_reference() {
    let dir = TempDir::new().unwrap();
    let server = start(dir.path(), json!({})).await;
    let session = request(&server, "GET", "/api/session", &auth("alice", None), vec![])
        .await
        .json();
    let account = string(&session["vaultId"]);
    let doc = new_doc();
    note(&doc, "private", "current");
    Vault::open(&dir.path().join("users").join(account), 1.0)
        .unwrap()
        .accept(&encode(&doc), 1.0)
        .unwrap();
    let shared = new_doc();
    note(&shared, SHARED, "current");
    let body = json!({"capability":cap(),"snapshot":STANDARD.encode(encode(&shared)),"sourceIds":["private"]}).to_string().into_bytes();
    assert_eq!(
        request(
            &server,
            "POST",
            "/api/shares/publish",
            &headers("alice", account),
            body
        )
        .await
        .status,
        200
    );
    let mut guest = HeaderMap::new();
    guest.insert("x-stow-share", cap().parse().unwrap());
    let joined = request(&server, "POST", "/api/shares/join", &guest, vec![]).await;
    assert_eq!(joined.status, 200);
    assert_eq!(joined.json()["participant"]["guest"], true);
    assert_eq!(joined.json()["canAdd"], false);
    guest.insert(
        "cookie",
        joined
            .headers
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .parse()
            .unwrap(),
    );
    let repeated = request(&server, "POST", "/api/shares/join", &guest, vec![])
        .await
        .json();
    assert_eq!(joined.json()["participant"], repeated["participant"]);
    assert_eq!(
        request(&server, "POST", "/api/shares/add", &guest, vec![])
            .await
            .status,
        401
    );
    assert_eq!(
        request(&server, "GET", "/api/session", &guest, vec![])
            .await
            .status,
        200
    );
    let refs = fs::read_dir(dir.path().join("share-references"))
        .unwrap()
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    assert_eq!(
        refs.len(),
        1,
        "guest must not acquire a retention reference"
    );
    server.close().await.unwrap();
}

#[test]
fn shared_storage_rejects_cross_document_content_and_global_deletion() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join(SHARED);
    let doc = new_doc();
    note(&doc, SHARED, "shared");
    let mut vault = Vault::open(&path, 1.0).unwrap();
    vault.accept(&encode(&doc), 1.0).unwrap();
    note(&doc, "private", "escape");
    assert!(vault.accept(&encode(&doc), 2.0).is_err());
    let deleted = clone_doc(&vault.doc).unwrap();
    put(
        &mut deleted.transact_mut(),
        "deletedNotes",
        SHARED,
        json!(true),
    );
    assert!(vault.accept(&encode(&deleted), 3.0).is_err());
    assert_eq!(
        field(&vault.doc.transact(), "notes", SHARED, "body"),
        "shared"
    );
}

async fn seed_publication(directory: &Path) -> (crate::server::Running, String) {
    let server = start(directory, json!({"now": 1000000})).await;
    let session = request(&server, "GET", "/api/session", &auth("alice", None), vec![])
        .await
        .json();
    let account = string(&session["vaultId"]).to_owned();
    let doc = new_doc();
    note(&doc, "private", "private content");
    Vault::open(&directory.join("users").join(&account), 1.0)
        .unwrap()
        .accept(&encode(&doc), 1.0)
        .unwrap();
    let doc = new_doc();
    note(&doc, SHARED, "public content");
    let body = json!({"capability":cap(),"snapshot":STANDARD.encode(encode(&doc)),"sourceIds":["private"]}).to_string().into_bytes();
    assert_eq!(
        request(
            &server,
            "POST",
            "/api/shares/publish",
            &headers("alice", &account),
            body
        )
        .await
        .status,
        200
    );
    (server, account)
}

#[tokio::test]
async fn retention_counts_real_references_including_trash_but_not_guests_and_never_resurrects() {
    use crate::server::sharing;
    let dir = TempDir::new().unwrap();
    let (server, account) = seed_publication(dir.path()).await;
    let reference = new_doc();
    note(&reference, SHARED, "reference");
    meta(
        &reference,
        SHARED,
        "share",
        json!({"id":SHARED,"token":"a".repeat(64)}),
    );
    meta(&reference, SHARED, "archived", json!(true));
    meta(&reference, SHARED, "trashed", json!(true));
    sharing::reconcile(&server.state, &account, &reference).unwrap();
    sharing::collect(&server.state).unwrap();
    assert!(
        sharing::authorize(&server.state, &cap())
            .unwrap()
            .unreferenced_at
            .is_none()
    );
    // A crash between persisting account data and deriving the index cannot
    // permit collection, even when the old grace period has elapsed.
    put(
        &mut reference.transact_mut(),
        "deletedNotes",
        SHARED,
        json!(true),
    );
    sharing::dirty(&server.state, &account).unwrap();
    let path = dir.path().join("sharing").join(format!("{SHARED}.json"));
    let mut record = sharing::authorize(&server.state, &cap()).unwrap();
    record.unreferenced_at = Some(-sharing::GRACE_MS);
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    sharing::collect(&server.state).unwrap();
    assert!(sharing::authorize(&server.state, &cap()).is_ok());
    sharing::reconcile(&server.state, &account, &reference).unwrap();
    // A guest joins without extending the retention period.
    let mut guest = HeaderMap::new();
    guest.insert("x-stow-share", cap().parse().unwrap());
    assert_eq!(
        request(&server, "POST", "/api/shares/join", &guest, vec![])
            .await
            .status,
        200
    );
    sharing::collect(&server.state).unwrap();
    assert_eq!(
        request(
            &server,
            "GET",
            "/api/session",
            &shared_headers("alice"),
            vec![]
        )
        .await
        .status,
        410
    );
    assert!(!dir.path().join("shared").join(SHARED).exists());
    let mut add = headers("alice", &account);
    add.insert("x-stow-share", cap().parse().unwrap());
    assert_eq!(
        request(&server, "POST", "/api/shares/add", &add, vec![])
            .await
            .status,
        410
    );
    assert!(!dir.path().join("shared").join(SHARED).exists());
    server.close().await.unwrap();
}

#[tokio::test]
async fn permanently_removed_reference_can_be_added_again_during_grace_with_a_fresh_identity() {
    let dir = TempDir::new().unwrap();
    let (server, account) = seed_publication(dir.path()).await;
    server.close().await.unwrap();
    let mut vault = Vault::open(&dir.path().join("users").join(&account), 2.0).unwrap();
    let edit = clone_doc(&vault.doc).unwrap();
    put(
        &mut edit.transact_mut(),
        "deletedNotes",
        SHARED,
        json!(true),
    );
    vault.accept(&encode(&edit), 3.0).unwrap();
    drop(vault);
    let server = start(dir.path(), json!({})).await;
    let mut h = headers("alice", &account);
    h.insert("x-stow-share", cap().parse().unwrap());
    for _ in 0..2 {
        assert_eq!(
            request(&server, "POST", "/api/shares/add", &h, vec![])
                .await
                .status,
            200
        );
    }
    server.close().await.unwrap();
    let vault = Vault::open(&dir.path().join("users").join(&account), 4.0).unwrap();
    let notes = keys(&vault.doc.transact(), "notes");
    assert_eq!(notes.len(), 1);
    let reference = notes.first().unwrap();
    assert_ne!(reference, SHARED);
    assert_eq!(
        field(&vault.doc.transact(), "notes", reference, "share")["id"],
        SHARED
    );
}

#[tokio::test]
async fn unfinished_publication_recovers_before_account_sync_after_restart() {
    use crate::server::sharing;
    let dir = TempDir::new().unwrap();
    let (server, account) = seed_publication(dir.path()).await;
    server.close().await.unwrap();
    let directory = dir.path().join("users").join(&account);
    let vault = Vault::open(&directory, 2.0).unwrap();
    let publication = STANDARD.encode(vault.state());
    drop(vault);
    // Emulate a crash with the durable intent present but account commit absent.
    fs::remove_dir_all(&directory).unwrap();
    let doc = new_doc();
    note(&doc, "private", "private content");
    Vault::open(&directory, 3.0)
        .unwrap()
        .accept(&encode(&doc), 3.0)
        .unwrap();
    let path = dir.path().join("sharing").join(format!("{SHARED}.json"));
    let mut record: sharing::Record = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record.publication = Some(publication);
    fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
    fs::write(
        dir.path()
            .join("share-references")
            .join(format!("{account}.dirty")),
        b"1",
    )
    .unwrap();
    let server = start(dir.path(), json!({})).await;
    // Bound HTTP must recover too: otherwise a later Add operation could
    // reconcile the index and accidentally clear another publication's marker.
    assert_eq!(
        request(
            &server,
            "GET",
            "/api/history/export",
            &headers("alice", &account),
            vec![]
        )
        .await
        .status,
        200
    );
    assert!(
        sharing::authorize(&server.state, &cap())
            .unwrap()
            .publication
            .is_none()
    );
    // Retrying the original publication recovers its exact intent.
    let body = json!({"capability":cap(),"snapshot":"", "sourceIds":["private"]})
        .to_string()
        .into_bytes();
    assert_eq!(
        request(
            &server,
            "POST",
            "/api/shares/publish",
            &headers("alice", &account),
            body
        )
        .await
        .status,
        200
    );
    assert!(
        sharing::authorize(&server.state, &cap())
            .unwrap()
            .publication
            .is_none()
    );
    server.close().await.unwrap();
    let vault = Vault::open(&directory, 4.0).unwrap();
    assert_eq!(
        keys(&vault.doc.transact(), "notes"),
        [SHARED.to_owned()].into_iter().collect()
    );
    assert!(keys(&vault.doc.transact(), "deletedNotes").contains("private"));
}

#[tokio::test]
async fn capabilities_do_not_authorize_private_data_forged_identity_or_account_switches() {
    let dir = TempDir::new().unwrap();
    let (server, account) = seed_publication(dir.path()).await;
    let mut h = shared_headers("jeremy");
    h.remove("x-stow-proxy-secret");
    assert_eq!(
        request(&server, "GET", "/api/session", &h, vec![])
            .await
            .status,
        401
    );
    let joined = request(
        &server,
        "POST",
        "/api/shares/join",
        &h,
        b"{\"name\":\"Alice\",\"guest\":false}".to_vec(),
    )
    .await;
    assert_eq!(joined.json()["participant"]["guest"], true);
    assert!(string(&joined.json()["participant"]["name"]).starts_with("Anonymous Chicken"));
    h.insert(
        "cookie",
        format!("stow_guest={}.{}", "b".repeat(64), "c".repeat(64))
            .parse()
            .unwrap(),
    );
    assert_eq!(
        request(&server, "GET", "/api/session", &h, vec![])
            .await
            .status,
        401
    );
    let mut changed = headers("jeremy", &account);
    changed.insert("x-stow-share", cap().parse().unwrap());
    assert_eq!(
        request(&server, "POST", "/api/shares/add", &changed, vec![])
            .await
            .status,
        409
    );
    let mut cap_only = HeaderMap::new();
    cap_only.insert("x-stow-share", cap().parse().unwrap());
    let joined = request(&server, "POST", "/api/shares/join", &cap_only, vec![]).await;
    cap_only.insert(
        "cookie",
        joined
            .headers
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .parse()
            .unwrap(),
    );
    cap_only.insert("x-stow-vault", account.parse().unwrap());
    assert_eq!(
        request(&server, "GET", "/api/history/export", &cap_only, vec![])
            .await
            .status,
        409
    );
    cap_only.insert("x-stow-vault", SHARED.parse().unwrap());
    assert_eq!(
        request(
            &server,
            "PUT",
            "/api/history-retention/compression",
            &cap_only,
            b"{\"enabled\":false}".to_vec()
        )
        .await
        .status,
        403
    );
    server.close().await.unwrap();
}

#[tokio::test]
async fn incremental_reference_index_removes_tombstones_and_ignores_wrong_tokens() {
    use crate::server::sharing;
    let dir = TempDir::new().unwrap();
    let (server, account) = seed_publication(dir.path()).await;
    let doc = new_doc();
    note(&doc, SHARED, "ref");
    meta(
        &doc,
        SHARED,
        "share",
        json!({"id":SHARED,"token":"a".repeat(64)}),
    );
    sharing::reconcile(&server.state, &account, &doc).unwrap();
    // Unrelated keystrokes preserve existing entries without scanning the vault.
    note(&doc, "unrelated", "text");
    sharing::reconcile_changes(
        &server.state,
        &account,
        &doc,
        Some(&["unrelated".to_owned()].into_iter().collect()),
    )
    .unwrap();
    sharing::collect(&server.state).unwrap();
    assert!(
        sharing::authorize(&server.state, &cap())
            .unwrap()
            .unreferenced_at
            .is_none()
    );
    put(&mut doc.transact_mut(), "deletedNotes", SHARED, json!(true));
    note(&doc, "forged", "bad token");
    meta(
        &doc,
        "forged",
        "share",
        json!({"id":SHARED,"token":"b".repeat(64)}),
    );
    sharing::reconcile_changes(
        &server.state,
        &account,
        &doc,
        Some(
            &[SHARED.to_owned(), "forged".to_owned()]
                .into_iter()
                .collect(),
        ),
    )
    .unwrap();
    sharing::collect(&server.state).unwrap();
    assert!(
        sharing::authorize(&server.state, &cap())
            .unwrap()
            .unreferenced_at
            .is_some()
    );
    server.close().await.unwrap();
}

#[tokio::test]
async fn publication_copies_only_images_owned_by_the_published_note() {
    use sha2::{Digest, Sha256};
    let dir = TempDir::new().unwrap();
    let server = start(dir.path(), json!({})).await;
    let session = request(&server, "GET", "/api/session", &auth("alice", None), vec![])
        .await
        .json();
    let account = string(&session["vaultId"]);
    let bytes = b"retained original attachment";
    let hash = hex::encode(Sha256::digest(bytes));
    let doc = new_doc();
    note(&doc, "private", "current");
    note(&doc, "other", "unshared");
    attachment(&doc, "photo", "private", &hash);
    let mut private = Vault::open(&dir.path().join("users").join(account), 1.0).unwrap();
    private.accept(&encode(&doc), 1.0).unwrap();
    private
        .upload(&hash, &["private".to_owned()], bytes)
        .unwrap();
    drop(private);
    let shared = new_doc();
    note(&shared, SHARED, "current");
    attachment(&shared, "shared-photo", SHARED, &hash);
    let body = json!({"capability":cap(),"snapshot":STANDARD.encode(encode(&shared)),"sourceIds":["other"]}).to_string().into_bytes();
    assert_eq!(
        request(
            &server,
            "POST",
            "/api/shares/publish",
            &headers("alice", account),
            body
        )
        .await
        .status,
        403
    );
    let body = json!({"capability":cap(),"snapshot":STANDARD.encode(encode(&shared)),"sourceIds":["private"]}).to_string().into_bytes();
    assert_eq!(
        request(
            &server,
            "POST",
            "/api/shares/publish",
            &headers("alice", account),
            body
        )
        .await
        .status,
        200
    );
    let result = request(
        &server,
        "GET",
        &format!("/api/blobs/{hash}"),
        &shared_headers("jeremy"),
        vec![],
    )
    .await;
    assert_eq!(result.status, 200);
    assert_eq!(result.bytes, bytes);
    let mut wrong = shared_headers("jeremy");
    wrong.insert(
        "x-stow-share",
        format!("{SHARED}.{}", "b".repeat(64)).parse().unwrap(),
    );
    assert_eq!(
        request(
            &server,
            "GET",
            &format!("/api/blobs/{hash}"),
            &wrong,
            vec![]
        )
        .await
        .status,
        403
    );
    server.close().await.unwrap();
}

#[tokio::test]
async fn maintenance_removes_unpublished_crash_artifacts_without_touching_published_documents() {
    let dir = TempDir::new().unwrap();
    let (server, _) = seed_publication(dir.path()).await;
    let orphan = dir
        .path()
        .join("shared")
        .join("share_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    fs::create_dir_all(&orphan).unwrap();
    fs::write(orphan.join("partial-copy"), b"unpublished").unwrap();
    crate::server::sharing::collect(&server.state).unwrap();
    assert!(!orphan.exists());
    assert!(
        dir.path()
            .join("shared")
            .join(SHARED)
            .join("vault.yjs")
            .exists()
    );
    assert_eq!(
        request(
            &server,
            "GET",
            "/api/session",
            &shared_headers("alice"),
            vec![]
        )
        .await
        .status,
        200
    );
    server.close().await.unwrap();
}

#[tokio::test]
async fn membership_follows_references_not_join_history() {
    use crate::server::sharing;
    let dir = TempDir::new().unwrap();
    let (server, alice) = seed_publication(dir.path()).await;
    let h = shared_headers("jeremy");
    let joined = request(&server, "POST", "/api/shares/join", &h, vec![])
        .await
        .json();
    let jeremy = string(&joined["participant"]["id"]);
    let mut guest = HeaderMap::new();
    guest.insert("x-stow-share", cap().parse().unwrap());
    request(&server, "POST", "/api/shares/join", &guest, vec![]).await;
    let roster = request(&server, "GET", "/api/shares/participants", &h, vec![])
        .await
        .json();
    assert_eq!(
        roster["participants"].as_array().unwrap().len(),
        1,
        "opening a link is not membership"
    );
    assert_eq!(roster["participants"][0]["id"], alice);
    let mut add = h.clone();
    add.insert("x-stow-vault", jeremy.parse().unwrap());
    assert_eq!(
        request(&server, "POST", "/api/shares/add", &add, vec![])
            .await
            .status,
        200
    );
    let refs = new_doc();
    for id in ["one", "two"] {
        note(&refs, id, "reference");
        meta(
            &refs,
            id,
            "share",
            json!({"id":SHARED,"token":"a".repeat(64)}),
        );
        meta(&refs, id, "trashed", json!(true));
    }
    sharing::reconcile(&server.state, jeremy, &refs).unwrap();
    for remaining in [2, 1, 0] {
        let roster = request(&server, "GET", "/api/shares/participants", &h, vec![])
            .await
            .json();
        assert_eq!(
            roster["participants"].as_array().unwrap().len(),
            if remaining > 0 { 2 } else { 1 }
        );
        if remaining > 0 {
            let id = if remaining == 2 { "one" } else { "two" };
            put(&mut refs.transact_mut(), "deletedNotes", id, json!(true));
            sharing::reconcile_changes(
                &server.state,
                jeremy,
                &refs,
                Some(&[id.to_owned()].into_iter().collect()),
            )
            .unwrap();
        }
    }
    // A forged reference never grants membership, even for an authenticated account.
    note(&refs, "forged-member", "reference");
    meta(
        &refs,
        "forged-member",
        "share",
        json!({"id":SHARED,"token":"b".repeat(64)}),
    );
    sharing::dirty(&server.state, jeremy).unwrap();
    assert_eq!(
        request(&server, "GET", "/api/shares/participants", &h, vec![])
            .await
            .status,
        503
    );
    sharing::reconcile(&server.state, jeremy, &refs).unwrap();
    assert_eq!(
        request(&server, "GET", "/api/shares/participants", &h, vec![])
            .await
            .json()["participants"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // Old append-only records must not resurrect a former member or guest.
    let path = dir.path().join("sharing").join(format!("{SHARED}.json"));
    let mut old: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    old["participants"] = json!({"obsolete":{"id":"obsolete","name":"Old guest","guest":true}});
    fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
    let roster = request(&server, "GET", "/api/shares/participants", &h, vec![])
        .await
        .json();
    assert_eq!(roster["participants"].as_array().unwrap().len(), 1);
    // The actual retained private reference still makes Add idempotent.
    assert_eq!(
        request(&server, "POST", "/api/shares/add", &add, vec![])
            .await
            .status,
        200
    );
    assert_eq!(
        request(&server, "GET", "/api/shares/participants", &h, vec![])
            .await
            .json()["participants"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    server.close().await.unwrap();
}

#[tokio::test]
async fn membership_recovers_a_deletion_committed_before_index_reconciliation() {
    let dir = TempDir::new().unwrap();
    let (server, alice) = seed_publication(dir.path()).await;
    server.close().await.unwrap();
    let mut vault = Vault::open(&dir.path().join("users").join(&alice), 2.0).unwrap();
    let doc = clone_doc(&vault.doc).unwrap();
    put(&mut doc.transact_mut(), "deletedNotes", SHARED, json!(true));
    vault.accept(&encode(&doc), 3.0).unwrap();
    drop(vault);
    fs::write(
        dir.path()
            .join("share-references")
            .join(format!("{alice}.dirty")),
        b"1",
    )
    .unwrap();
    let server = start(dir.path(), json!({})).await;
    let response = request(
        &server,
        "GET",
        "/api/shares/participants",
        &shared_headers("alice"),
        vec![],
    )
    .await;
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["participants"], json!([]));
    assert!(
        !dir.path()
            .join("share-references")
            .join(format!("{alice}.dirty"))
            .exists()
    );
    server.close().await.unwrap();
}
