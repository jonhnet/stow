//! Informational ownership metadata. Authentication and vault routing never read it.
use crate::{
    error::{Error, Result},
    identity::{AuthMode, valid_identity},
    policy::is_hash,
    storage::atomic_write,
};
use serde::{Deserialize, Serialize};
use std::{fs::File, io::Read, path::Path};

const MAX_BYTES: u64 = 4096;

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountMetadata {
    pub user: String,
    pub auth_mode: AuthMode,
    pub vault_id: String,
}

impl AccountMetadata {
    fn valid(&self) -> bool {
        valid_identity(&self.user)
            && is_hash(&self.vault_id)
            && (self.auth_mode != AuthMode::Password || self.user == "owner")
    }
}

pub fn read(directory: &Path) -> Result<Option<AccountMetadata>> {
    let path = directory.join("account.json");
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let invalid = || Error::invalid(format!("Invalid account metadata in {}.", path.display()));
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(invalid());
    }
    let metadata: AccountMetadata = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if !metadata.valid() {
        return Err(invalid());
    }
    Ok(Some(metadata))
}

/// Serialize calls for the same directory, after independently authenticating
/// and resolving its vault. The directory must already exist. Existing ownership is
/// checked, never changed or used to decide which account can access the vault.
pub fn record(directory: &Path, user: &str, mode: AuthMode, vault_id: &str) -> Result<()> {
    let metadata = AccountMetadata {
        user: user.into(),
        auth_mode: mode,
        vault_id: vault_id.into(),
    };
    if !metadata.valid() {
        return Err(Error::invalid("Cannot record invalid account metadata."));
    }
    if let Some(existing) = read(directory)? {
        if existing != metadata {
            return Err(Error::invalid(format!(
                "Account metadata in {} does not match the authenticated account and vault.",
                directory.join("account.json").display()
            )));
        }
        return Ok(());
    }
    atomic_write(
        &directory.join("account.json"),
        &serde_json::to_vec_pretty(&metadata)?,
    )
}
