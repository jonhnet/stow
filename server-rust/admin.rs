//! Offline administrator CLI; no Node runtime or test adapter is involved.
use crate::{
    account_reset,
    error::{Error, Result},
};
use serde_json::json;
use std::path::Path;
pub fn reset(args: impl Iterator<Item = String>) -> Result<()> {
    let mut options = crate::cli::parse(
        args,
        &["--user", "--vault", "--data-dir"],
        &["--apply", "--server-stopped", "--help"],
    )?;
    if options.flags.contains("--help") {
        println!(
            "Preview an account reset:\n  ./reset-account.sh --user owner@example.com --vault CURRENT_VAULT_ID\n\nStop every Stow server using the data directory, then apply:\n  ./reset-account.sh --user owner@example.com --vault CURRENT_VAULT_ID --apply --server-stopped\n\nProxy accounts only. DATA_DIR or --data-dir selects the installation.\nThe old vault moves to DATA_DIR/reset-backups; other accounts keep their identities.\nRestart Stow, reload browsers, and import into the new empty account."
        );
        return Ok(());
    }
    let user = options.values.remove("--user");
    let vault = options.values.remove("--vault");
    let directory = options.values.remove("--data-dir");
    let apply = options.flags.contains("--apply");
    let stopped = options.flags.contains("--server-stopped");
    let (user, vault) = user.zip(vault).ok_or_else(|| {
        Error::invalid("Specify --user and --vault. Use --help for the offline reset procedure.")
    })?;
    if std::env::var("STOW_AUTH_MODE").as_deref() != Ok("proxy") {
        return Err(Error::invalid(
            "Account reset requires STOW_AUTH_MODE=proxy.",
        ));
    }
    let source = crate::server::resolve(Path::new(env!("CARGO_MANIFEST_DIR")))?;
    let workspace = source.parent().unwrap();
    let build = workspace.join("build");
    let data = directory
        .or_else(|| std::env::var("DATA_DIR").ok())
        .unwrap_or_else(|| workspace.join("data").to_string_lossy().into_owned());
    let data = crate::server::resolve(Path::new(&data))?;
    if data.starts_with(&source) || data.starts_with(&build) {
        return Err(Error::invalid(
            "The data directory and reset backups must be outside the source repository and build/.",
        ));
    }
    if let Ok(static_dir) = std::env::var("STOW_STATIC_DIR")
        && data.starts_with(crate::server::resolve(Path::new(&static_dir))?)
    {
        return Err(Error::invalid(
            "DATA_DIR must be outside the frontend static directory.",
        ));
    }
    let mut result = account_reset::reset(
        &json!({"dataDir":data,"user":user,"expectedVaultId":vault,"apply":apply,"serverStopped":stopped}),
    )?;
    result["event"] = json!(if apply {
        "account-reset"
    } else {
        "account-reset-preview"
    });
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
