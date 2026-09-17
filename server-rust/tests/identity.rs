use super::api::*;
use super::*;
use crate::{
    account_metadata,
    account_reset::{self, reset},
    identity::{AuthMode, vault_identity},
    server::Config,
};
use std::collections::BTreeMap;
fn tree(directory: &Path) -> BTreeMap<String, Vec<u8>> {
    fn visit(root: &Path, path: &Path, result: &mut BTreeMap<String, Vec<u8>>) {
        for e in fs::read_dir(path).unwrap() {
            let p = e.unwrap().path();
            let name = p.strip_prefix(root).unwrap().to_str().unwrap().to_owned();
            if p.is_dir() {
                result.insert(format!("{name}/"), vec![]);
                visit(root, &p, result);
            } else {
                result.insert(name, fs::read(p).unwrap());
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(directory, directory, &mut result);
    result
}
fn accounts() -> (TempDir, String, String) {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("session-secret"), [83; 32]).unwrap();
    let a = vault_identity(&[83; 32], AuthMode::Proxy, "owner");
    let b = vault_identity(&[83; 32], AuthMode::Proxy, "other");
    for (id, user) in [(&a, "owner"), (&b, "other")] {
        let mut vault = Vault::open(&dir.path().join("users").join(id), 1.).unwrap();
        let doc = new_doc();
        note(&doc, "a", &format!("Private for {user}"));
        vault.accept(&encode(&doc), 1.).unwrap();
        fs::write(
            vault.blob_dir.join("a".repeat(64)),
            format!("Attachment for {user}"),
        )
        .unwrap();
    }
    (dir, a, b)
}
fn options(dir: &Path, id: &str) -> Value {
    json!({"dataDir":dir,"user":"owner","expectedVaultId":id,"apply":true,"serverStopped":true})
}
#[test]
fn preview_and_rejected_reset_preconditions_leave_every_byte_untouched() {
    let (dir, id, _) = accounts();
    let before = tree(dir.path());
    let mut o = options(dir.path(), &id);
    o["apply"] = json!(false);
    assert_eq!(reset(&o).unwrap()["applied"], false);
    assert_eq!(tree(dir.path()), before);
    o["apply"] = json!(true);
    o["serverStopped"] = json!(false);
    assert!(reset(&o).is_err());
    assert!(reset(&options(dir.path(), &"a".repeat(64))).is_err());
    assert_eq!(tree(dir.path()), before);
}
#[test]
fn reset_records_both_incarnations_without_identifying_other_accounts() {
    let (dir, old, other) = accounts();
    let other_path = dir.path().join("users").join(&other);
    let other_files = tree(&other_path);
    let result = reset(&options(dir.path(), &old)).unwrap();
    let new = string(&result["vaultId"]);
    let backup = Path::new(string(&result["backupPath"]));
    for (path, id) in [
        (backup.to_path_buf(), old.as_str()),
        (dir.path().join("users").join(new), new),
    ] {
        let metadata = account_metadata::read(&path).unwrap().unwrap();
        assert_eq!(metadata.user, "owner");
        assert_eq!(metadata.auth_mode, AuthMode::Proxy);
        assert_eq!(metadata.vault_id, id);
    }
    assert_eq!(tree(&other_path), other_files);
    assert_eq!(account_metadata::read(&other_path).unwrap(), None);
}
#[test]
fn mismatched_or_corrupt_owner_metadata_refuses_reset_without_changing_files() {
    let (dir, old, _) = accounts();
    let path = dir.path().join("users").join(&old).join("account.json");
    for bytes in [
        json!({"user":"other","authMode":"proxy","vaultId":old}).to_string(),
        json!({"user":"owner","authMode":"password","vaultId":old}).to_string(),
        json!({"user":"owner","authMode":"proxy","vaultId":"a".repeat(64)}).to_string(),
        "{broken".into(),
    ] {
        fs::write(&path, bytes).unwrap();
        let before = tree(dir.path());
        for apply in [false, true] {
            let mut o = options(dir.path(), &old);
            o["apply"] = json!(apply);
            assert!(reset(&o).is_err());
            assert_eq!(tree(dir.path()), before);
        }
    }
}
#[tokio::test]
async fn reset_rotates_only_selected_account_preserves_backup_and_rejects_stale_http_and_ws() {
    let (dir, old, other) = accounts();
    let s = start(dir.path(), json!({})).await;
    assert_eq!(identity(&s, "owner").await, old);
    assert_eq!(identity(&s, "other").await, other);
    s.close().await.unwrap();
    let old_path = dir.path().join("users").join(&old);
    let old_files = tree(&old_path);
    let other_files = tree(&dir.path().join("users").join(&other));
    let reset = reset(&options(dir.path(), &old)).unwrap();
    let new = string(&reset["vaultId"]);
    assert_ne!(new, old);
    assert_eq!(tree(Path::new(string(&reset["backupPath"]))), old_files);
    let backup_metadata = account_metadata::read(Path::new(string(&reset["backupPath"])))
        .unwrap()
        .unwrap();
    assert_eq!(backup_metadata.user, "owner");
    assert_eq!(backup_metadata.auth_mode, AuthMode::Proxy);
    assert_eq!(backup_metadata.vault_id, old);
    let new_metadata = account_metadata::read(&dir.path().join("users").join(new))
        .unwrap()
        .unwrap();
    assert_eq!(new_metadata.user, "owner");
    assert_eq!(new_metadata.auth_mode, AuthMode::Proxy);
    assert_eq!(new_metadata.vault_id, new);
    assert!(!old_path.exists());
    assert_eq!(tree(&dir.path().join("users").join(&other)), other_files);
    assert_eq!(
        fs::read(dir.path().join("session-secret")).unwrap(),
        [83; 32]
    );
    let registry = account_reset::load(dir.path()).unwrap();
    assert_eq!(
        account_reset::resolve(&[83; 32], AuthMode::Proxy, "owner", &registry),
        new
    );
    assert_eq!(
        account_reset::resolve(&[83; 32], AuthMode::Proxy, "other", &registry),
        other
    );
    let s = start(dir.path(), json!({})).await;
    assert_eq!(identity(&s, "owner").await, new);
    for (method, path) in [
        ("GET", "/api/storage"),
        ("PUT", "/api/history-retention"),
        (
            "GET",
            "/api/blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
    ] {
        let r = request(&s, method, path, &auth("owner", Some(&old)), vec![]).await;
        assert_eq!(r.status, 409);
        assert_eq!(r.json()["code"], "vault_mismatch");
    }
    assert!(
        Socket::query(
            &s,
            &auth("owner", None),
            &format!("schema={CURRENT_SCHEMA}&protocol=3&vaultId={old}")
        )
        .await
        .is_err()
    );
    let mut socket = Socket::connect(&s, &auth("owner", Some(new)), new).await;
    let empty = new_doc();
    socket.sync(&empty).await;
    assert!(keys(&empty.transact(), "notes").is_empty());
    socket.close().await;
    let mut socket = Socket::connect(&s, &auth("other", Some(&other)), &other).await;
    let doc = new_doc();
    socket.sync(&doc).await;
    assert_eq!(
        field(&doc.transact(), "notes", "a", "body"),
        "Private for other"
    );
    socket.close().await;
    s.close().await.unwrap();
    let before = tree(dir.path());
    assert!(account_reset::reset(&options(dir.path(), &old)).is_err());
    assert_eq!(tree(dir.path()), before);
}
#[tokio::test]
async fn invalid_identity_registries_refuse_startup_and_reset_without_rewriting_storage() {
    let (dir, id, _) = accounts();
    let path = dir.path().join("vault-incarnations.json");
    for bytes in [
        "{broken".into(),
        "null".into(),
        "[]".into(),
        json!({"../outside":"a".repeat(64)}).to_string(),
        json!({&id:"../outside"}).to_string(),
        json!({&id:4}).to_string(),
        json!({&id:&id}).to_string(),
        json!({&id:"a".repeat(64),"b".repeat(64):"a".repeat(64)}).to_string(),
        json!({&id:"a".repeat(64),"a".repeat(64):"b".repeat(64)}).to_string(),
    ] {
        fs::write(&path, bytes).unwrap();
        assert!(account_reset::load(dir.path()).is_err());
    }
    let before = tree(dir.path());
    assert!(
        crate::server::start(
            Config::for_test(
                &json!({"dataDir":dir.path(),"port":0,"authMode":"proxy","proxySecret":PROOF})
            )
            .unwrap()
        )
        .await
        .is_err()
    );
    assert!(reset(&options(dir.path(), &id)).is_err());
    assert_eq!(tree(dir.path()), before);
}
#[tokio::test]
async fn missing_registry_after_reset_refuses_startup_and_further_reset() {
    let (dir, id, _) = accounts();
    reset(&options(dir.path(), &id)).unwrap();
    fs::remove_file(dir.path().join("vault-incarnations.json")).unwrap();
    let before = tree(dir.path());
    assert!(account_reset::load(dir.path()).is_err());
    assert!(
        crate::server::start(
            Config::for_test(
                &json!({"dataDir":dir.path(),"port":0,"authMode":"proxy","proxySecret":PROOF})
            )
            .unwrap()
        )
        .await
        .is_err()
    );
    assert!(reset(&options(dir.path(), &id)).is_err());
    assert_eq!(tree(dir.path()), before);
}
#[test]
fn deployment_paths_reject_source_build_static_and_symlink_aliases() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR"));
    let build = source.parent().unwrap().join("build");
    let dir = tempfile::tempdir().unwrap();
    for target in [source, build.as_path()] {
        let alias = dir
            .path()
            .join(if target == source { "source" } else { "build" });
        std::os::unix::fs::symlink(target, &alias).unwrap();
        for path in [
            target.to_path_buf(),
            target.join("private"),
            target.join("nested/../private"),
            alias.join("missing/private"),
        ] {
            let e = Config::configure(
                &json!({"dataDir":path,"authMode":"proxy","proxySecret":"short"}),
                false,
            )
            .err()
            .unwrap();
            assert!(e.to_string().contains("DATA_DIR must be outside"));
        }
        let sibling = format!("{}-backup", target.display());
        assert!(
            Config::configure(
                &json!({"dataDir":sibling,"authMode":"proxy","proxySecret":"short"}),
                false
            )
            .err()
            .unwrap()
            .to_string()
            .contains("STOW_PROXY_SECRET")
        );
    }
    assert!(
        Config::for_test(
            &json!({"dataDir":build.join("tmp/fixture"),"authMode":"proxy","proxySecret":"short"})
        )
        .err()
        .unwrap()
        .to_string()
        .contains("STOW_PROXY_SECRET")
    );
    for path in [dir.path().to_path_buf(), dir.path().join("private")] {
        assert!(
            Config::for_test(&json!({"dataDir":path,"staticDir":dir.path()}))
                .err()
                .unwrap()
                .to_string()
                .contains("frontend static")
        );
    }
}
#[test]
fn public_bind_and_proxy_mode_require_explicit_security() {
    assert!(
        Config::for_test(
            &json!({"host":"0.0.0.0","password":"","authMode":"password","allowInsecure":false})
        )
        .err()
        .unwrap()
        .to_string()
        .contains("STOW_PASSWORD")
    );
    assert!(Config::for_test(&json!({"authMode":"proxy","proxySecret":"short"})).is_err());
}
