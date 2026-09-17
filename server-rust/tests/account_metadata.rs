use crate::{account_metadata, identity::AuthMode};
use serde_json::json;
use std::{fs, os::unix::fs::MetadataExt};

const USER: &str = "person@example.com";
const VAULT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[test]
fn missing_metadata_is_recorded_with_private_permissions() {
    let directory = tempfile::tempdir().unwrap();
    assert_eq!(account_metadata::read(directory.path()).unwrap(), None);
    account_metadata::record(directory.path(), USER, AuthMode::Proxy, VAULT).unwrap();
    let path = directory.path().join("account.json");
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(path).unwrap()).unwrap(),
        json!({"user":USER,"authMode":"proxy","vaultId":VAULT})
    );
    let metadata = account_metadata::read(directory.path()).unwrap().unwrap();
    assert_eq!(metadata.user, USER);
    assert_eq!(metadata.auth_mode, AuthMode::Proxy);
    assert_eq!(metadata.vault_id, VAULT);
}

#[test]
fn repeated_authentication_leaves_matching_file_untouched() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("account.json");
    // Preserve even its original formatting, rather than merely equivalent JSON.
    let bytes = format!("{{\"vaultId\":\"{VAULT}\",\"user\":\"{USER}\",\"authMode\":\"proxy\"}}\n");
    fs::write(&path, &bytes).unwrap();
    let before = fs::metadata(&path).unwrap();
    account_metadata::record(directory.path(), USER, AuthMode::Proxy, VAULT).unwrap();
    let after = fs::metadata(&path).unwrap();
    assert_eq!(before.ino(), after.ino());
    assert_eq!(before.modified().unwrap(), after.modified().unwrap());
    assert_eq!(fs::read(path).unwrap(), bytes.as_bytes());
}

#[test]
fn an_existing_owner_mode_or_vault_is_never_reassigned() {
    let directory = tempfile::tempdir().unwrap();
    let other_vault = "a".repeat(64);
    for (user, mode, vault) in [
        ("other@example.com", "proxy", VAULT),
        (USER, "proxy", other_vault.as_str()),
        ("owner", "password", VAULT),
    ] {
        let path = directory.path().join("account.json");
        let bytes =
            serde_json::to_vec(&json!({"user":user,"authMode":mode,"vaultId":vault})).unwrap();
        fs::write(&path, &bytes).unwrap();
        let error =
            account_metadata::record(directory.path(), USER, AuthMode::Proxy, VAULT).unwrap_err();
        assert!(error.to_string().contains("does not match"));
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn malformed_or_unbounded_metadata_is_rejected_without_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let valid = json!({"user":USER,"authMode":"proxy","vaultId":VAULT});
    let mut cases = vec![
        b"not JSON".to_vec(),
        vec![b' '; 4097],
        serde_json::to_vec(&json!({"user":USER,"authMode":"proxy"})).unwrap(),
    ];
    for (key, value) in [
        ("user", json!(" person@example.com")),
        ("user", json!("a".repeat(321))),
        ("user", json!("person\n@example.com")),
        ("vaultId", json!("not-a-vault-id")),
        ("authMode", json!("anonymous")),
        ("authMode", json!("password")),
        ("unexpected", json!(true)),
    ] {
        let mut value_with_error = valid.clone();
        value_with_error[key] = value;
        cases.push(serde_json::to_vec(&value_with_error).unwrap());
    }
    for bytes in cases {
        let path = directory.path().join("account.json");
        fs::write(&path, &bytes).unwrap();
        let error = account_metadata::read(directory.path()).unwrap_err();
        assert!(error.to_string().contains("Invalid account metadata"));
        assert!(error.to_string().contains("account.json"));
        assert!(account_metadata::record(directory.path(), USER, AuthMode::Proxy, VAULT).is_err());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn password_account_uses_its_canonical_identity() {
    let directory = tempfile::tempdir().unwrap();
    assert!(
        account_metadata::record(
            directory.path(),
            "Personal vault",
            AuthMode::Password,
            VAULT
        )
        .is_err()
    );
    assert!(!directory.path().join("account.json").exists());
    account_metadata::record(directory.path(), "owner", AuthMode::Password, VAULT).unwrap();
    let metadata = account_metadata::read(directory.path()).unwrap().unwrap();
    assert_eq!(metadata.user, "owner");
    assert_eq!(metadata.auth_mode, AuthMode::Password);
}

#[test]
fn recording_metadata_does_not_create_a_vault_directory() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join(VAULT);
    assert!(account_metadata::record(&missing, USER, AuthMode::Proxy, VAULT).is_err());
    assert!(!missing.exists());
}
