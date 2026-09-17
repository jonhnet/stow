//! Account incarnations only change through the explicit offline administrator command.
use crate::{
    account_metadata,
    crdt::{string, truthy},
    error::{Error, Result},
    identity::{self, AuthMode},
    policy::is_hash,
    storage::{atomic_write, mkdir_durable, read_optional, sync_directory},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
pub type Incarnations = BTreeMap<String, String>;
pub fn load(directory: &Path) -> Result<Incarnations> {
    let Some(bytes) = read_optional(&directory.join("vault-incarnations.json"))? else {
        match fs::read_dir(directory.join("reset-backups")) {
            Ok(mut entries) => {
                if entries.next().transpose()?.is_some() {
                    return Err(Error::invalid(
                        "vault-incarnations.json is missing from an installation with account reset backups. Restore it from backup to preserve account vault identities.",
                    ));
                }
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        return Ok(Incarnations::new());
    };
    let map: Incarnations = serde_json::from_slice(&bytes)
        .map_err(|_| Error::invalid("Invalid vault-incarnations.json identity map."))?;
    let values: BTreeSet<_> = map.values().collect();
    if values.len() != map.len()
        || map
            .iter()
            .any(|(k, v)| !is_hash(k) || !is_hash(v) || map.contains_key(v))
    {
        return Err(Error::invalid(
            "Invalid vault-incarnations.json identities.",
        ));
    }
    Ok(map)
}
pub fn resolve(secret: &[u8], mode: AuthMode, user: &str, incarnations: &Incarnations) -> String {
    let account = identity::vault_identity(secret, mode, user);
    incarnations.get(&account).cloned().unwrap_or(account)
}
pub fn reset(options: &Value) -> Result<Value> {
    let user = string(&options["user"]);
    let expected = string(&options["expectedVaultId"]);
    let directory = std::path::absolute(string(&options["dataDir"]))?;
    if !identity::valid_identity(user) || !is_hash(expected) {
        return Err(Error::invalid(
            "Reset requires a valid user and expected current vault identity.",
        ));
    }
    let apply = truthy(&options["apply"]);
    if apply && !truthy(&options["serverStopped"]) {
        return Err(Error::invalid(
            "Stop every Stow server using this data directory, then confirm --server-stopped.",
        ));
    }
    let secret = fs::read(directory.join("session-secret"))?;
    if secret.len() != 32 {
        return Err(Error::invalid("Invalid session-secret file"));
    }
    let mut incarnations = load(&directory)?;
    let account = identity::vault_identity(&secret, AuthMode::Proxy, user);
    let old = resolve(&secret, AuthMode::Proxy, user, &incarnations);
    if expected != old {
        return Err(Error::invalid(
            "Expected vault identity does not match the current account; preview the reset again.",
        ));
    }
    let previous = directory.join("users").join(&old);
    if !fs::symlink_metadata(&previous)?.is_dir() {
        return Err(Error::invalid(
            "The selected account vault is not a directory.",
        ));
    }
    if let Some(metadata) = account_metadata::read(&previous)?
        && (metadata.user != user
            || metadata.auth_mode != AuthMode::Proxy
            || metadata.vault_id != old)
    {
        return Err(Error::invalid(format!(
            "Account metadata in {} does not match the selected account and vault.",
            previous.join("account.json").display()
        )));
    }
    if !apply {
        return Ok(json!({"user":user,"previousVaultId":old,"vaultId":old,"applied":false}));
    }
    // The stopped-server requirement serializes metadata recording with sign-in.
    // Preserve the known owner alongside both incarnations before committing the
    // new identity. Metadata does not choose the account or replacement vault.
    account_metadata::record(&previous, user, AuthMode::Proxy, &old)?;
    let id = hex::encode(rand::random::<[u8; 32]>());
    let fresh = directory.join("users").join(&id);
    fs::create_dir(&fresh)?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&fresh, fs::Permissions::from_mode(0o700))?;
    account_metadata::record(&fresh, user, AuthMode::Proxy, &id)?;
    sync_directory(&directory.join("users"))?;
    let backups = directory.join("reset-backups");
    mkdir_durable(&backups)?;
    let backup = backups.join(format!("{old}-{id}"));
    incarnations.insert(account, id.clone());
    atomic_write(
        &directory.join("vault-incarnations.json"),
        &serde_json::to_vec_pretty(&incarnations)?,
    )?;
    let result = (|| {
        fs::rename(&previous, &backup)?;
        sync_directory(&backups)?;
        sync_directory(&directory.join("users"))
    })();
    if result.is_err() {
        return Err(Error::invalid(format!(
            "Account reset committed to {id}, but preserving its old directory failed. Inspect {} and {} before restarting.",
            previous.display(),
            backup.display()
        )));
    }
    Ok(json!({"user":user,"previousVaultId":old,"vaultId":id,"backupPath":backup,"applied":true}))
}
