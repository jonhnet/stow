use super::api::*;
use super::*;
use axum::http::HeaderMap;
use tokio_tungstenite::tungstenite;

fn metadata(directory: &Path) -> Value {
    serde_json::from_slice(&fs::read(directory.join("account.json")).unwrap()).unwrap()
}

fn expected(user: &str, mode: &str, id: &str) -> Value {
    json!({"user":user,"authMode":mode,"vaultId":id})
}

fn legacy_snapshot(directory: &Path) -> Vec<u8> {
    fs::create_dir_all(directory).unwrap();
    let doc = new_doc();
    let revisions = doc.get_or_insert_map("revisions");
    revisions.insert(&mut doc.transact_mut(), "old-revision", "saved history");
    let bytes = encode(&doc);
    fs::write(directory.join("vault.yjs"), &bytes).unwrap();
    bytes
}

#[tokio::test]
async fn proxy_metadata_is_created_by_bound_http_and_sync_without_cross_account_writes() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let alice = identity(&s, "alice@example.com").await;
    let bob = identity(&s, "bob@example.com").await;
    let alice_dir = dir.path().join("users").join(&alice);
    let bob_dir = dir.path().join("users").join(&bob);
    assert!(!alice_dir.exists());
    assert!(!bob_dir.exists());

    let response = request(
        &s,
        "GET",
        "/api/storage",
        &auth("alice@example.com", Some(&alice)),
        vec![],
    )
    .await;
    assert_eq!(response.status, 200);
    assert_eq!(
        metadata(&alice_dir),
        expected("alice@example.com", "proxy", &alice)
    );
    assert!(!bob_dir.exists());

    let socket = Socket::connect(&s, &auth("bob@example.com", Some(&bob)), &bob).await;
    assert_eq!(
        metadata(&bob_dir),
        expected("bob@example.com", "proxy", &bob)
    );
    assert_eq!(
        metadata(&alice_dir),
        expected("alice@example.com", "proxy", &alice)
    );
    socket.close().await;
    s.close().await.unwrap();
}

#[tokio::test]
async fn session_backfills_an_existing_unsupported_vault_without_opening_or_rewriting_it() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "returning-owner").await;
    let vault_dir = dir.path().join("users").join(&id);
    let before = legacy_snapshot(&vault_dir);

    assert_eq!(identity(&s, "returning-owner").await, id);
    assert_eq!(
        metadata(&vault_dir),
        expected("returning-owner", "proxy", &id)
    );
    assert_eq!(names(&vault_dir), ["account.json", "vault.yjs"]);
    assert_eq!(fs::read(vault_dir.join("vault.yjs")).unwrap(), before);
    assert_eq!(identity(&s, "returning-owner").await, id);
    assert_eq!(fs::read(vault_dir.join("vault.yjs")).unwrap(), before);
    s.close().await.unwrap();
}

#[tokio::test]
async fn sync_records_the_verified_owner_even_when_the_vault_format_cannot_open() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "old-format-owner").await;
    let vault_dir = dir.path().join("users").join(&id);
    let before = legacy_snapshot(&vault_dir);
    let Err(tungstenite::Error::Http(response)) = Socket::query(
        &s,
        &auth("old-format-owner", Some(&id)),
        &format!("schema={CURRENT_SCHEMA}&protocol=3&vaultId={id}"),
    )
    .await
    else {
        panic!("opened an unsupported vault")
    };
    assert_eq!(response.status(), 503);
    assert_eq!(
        metadata(&vault_dir),
        expected("old-format-owner", "proxy", &id)
    );
    assert_eq!(fs::read(vault_dir.join("vault.yjs")).unwrap(), before);
    s.close().await.unwrap();
}

#[tokio::test]
async fn rejected_requests_do_not_label_even_an_existing_unknown_vault() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let id = identity(&s, "unknown-owner").await;
    let other = identity(&s, "another-owner").await;
    let vault_dir = dir.path().join("users").join(&id);
    fs::create_dir_all(&vault_dir).unwrap();
    let h = auth("unknown-owner", Some(&id));
    let mut bad_proof = h.clone();
    bad_proof.insert("x-stow-proxy-secret", "wrong".parse().unwrap());
    let mut foreign = h.clone();
    foreign.insert("origin", "https://foreign.example".parse().unwrap());
    for headers in [&bad_proof, &foreign] {
        assert_eq!(
            request(&s, "GET", "/api/session", headers, vec![])
                .await
                .status,
            403
        );
    }
    let mut incompatible = h.clone();
    incompatible.insert("x-stow-sync-protocol", "2".parse().unwrap());
    incompatible.insert("x-stow-schema", CURRENT_SCHEMA.parse().unwrap());
    assert_eq!(
        request(&s, "GET", "/api/session", &incompatible, vec![])
            .await
            .json()["syncRejection"]["code"],
        "client_update_required"
    );
    assert_eq!(
        request(
            &s,
            "GET",
            "/api/storage",
            &auth("unknown-owner", Some(&other)),
            vec![]
        )
        .await
        .status,
        409
    );
    let rejected = Socket::query(
        &s,
        &h,
        &format!("schema={CURRENT_SCHEMA}&protocol=2&vaultId={id}"),
    )
    .await
    .unwrap();
    rejected.close().await;
    assert!(
        Socket::query(
            &s,
            &h,
            &format!("schema={CURRENT_SCHEMA}&protocol=3&vaultId={other}")
        )
        .await
        .is_err()
    );
    assert!(!vault_dir.join("account.json").exists());
    assert!(!vault_dir.join("vault.yjs").exists());
    assert!(!dir.path().join("users").join(other).exists());
    s.close().await.unwrap();
}

#[tokio::test]
async fn password_vault_records_the_canonical_owner_not_a_proxy_header_or_display_label() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(
        dir.path(),
        json!({"authMode":"password","password":"correct horse"}),
    )
    .await;
    let response = json_request(
        &s,
        "POST",
        "/api/login",
        &auth("spoofed@example.com", None),
        json!({"password":"correct horse"}),
    )
    .await;
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["user"], "Personal vault");
    let id = string(&response.json()["vaultId"]).to_owned();
    assert_eq!(metadata(dir.path()), expected("owner", "password", &id));
    assert!(!dir.path().join("users").exists());
    assert_eq!(
        request(&s, "GET", "/api/session", &HeaderMap::new(), vec![])
            .await
            .json()["authenticated"],
        false
    );
    s.close().await.unwrap();
}

#[tokio::test]
async fn conflicting_metadata_is_preserved_and_cannot_redirect_an_authenticated_account() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let alice = identity(&s, "alice").await;
    let bob = identity(&s, "bob").await;
    let alice_dir = dir.path().join("users").join(&alice);
    fs::create_dir_all(&alice_dir).unwrap();
    let forged = expected("bob", "proxy", &bob).to_string();
    fs::write(alice_dir.join("account.json"), &forged).unwrap();

    let response = request(&s, "GET", "/api/session", &auth("alice", None), vec![]).await;
    assert_eq!(response.status, 400);
    assert!(string(&response.json()["error"]).contains("account.json"));
    assert_eq!(
        request(
            &s,
            "GET",
            "/api/storage",
            &auth("alice", Some(&alice)),
            vec![]
        )
        .await
        .status,
        400
    );
    assert_eq!(identity(&s, "bob").await, bob);
    assert_eq!(
        request(
            &s,
            "GET",
            "/api/storage",
            &auth("bob", Some(&alice)),
            vec![]
        )
        .await
        .status,
        409
    );
    assert_eq!(
        fs::read_to_string(alice_dir.join("account.json")).unwrap(),
        forged
    );
    assert!(!alice_dir.join("vault.yjs").exists());
    assert!(!dir.path().join("users").join(bob).exists());
    s.close().await.unwrap();
}
