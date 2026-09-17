# Resetting an account before a fresh import

`reset-account.sh` replaces one proxy account's vault with a new empty CRDT and a
new browser storage identity. It preserves the previous vault, including images,
under `DATA_DIR/reset-backups/`. Other accounts and proxy authentication stay unchanged.
Both directories receive an `account.json` identifying the selected owner and
their respective vault IDs; an existing record with conflicting ownership stops
the reset without changing data.

1. Read the account's current `vaultId` from its authenticated `/api/session` response.
2. Preview: `./reset-account.sh --user owner@example.com --vault CURRENT_VAULT_ID`.
3. Stop **every** Stow server using this data directory. This is an offline
   administrator operation; `--server-stopped` asserts that you have done so.
4. Apply: `./reset-account.sh --user owner@example.com --vault CURRENT_VAULT_ID --apply --server-stopped`.
5. Restart Stow. Reload open tabs when they report the changed vault identity.
6. Run the Keep importer against the empty account. Create a fresh import plan;
   old plans are bound to the previous vault identity.

The script loads the workspace `.env` and invokes the Rust backend's local command interface. Run `./setup.sh` first; `STOW_SERVER_BIN` may select a separately built `stow-server` executable. `--data-dir` can explicitly select the
installation. Keep `session-secret` and `vault-incarnations.json` with the server
backup: together they bind accounts to their current vaults. Do not delete or
rotate these files to empty an account.
If reset backups exist but the identity registry is missing, startup fails until
the registry is restored, preventing reuse of a former account namespace.

The server commits the replacement identity before moving old data to backup.
If the operation reports a failure after that commit, inspect the paths in its
error before restarting. Never copy the old CRDT into the fresh namespace.
Browsers retain the old local cache but cannot upload it to the replacement
vault: session checks, HTTP requests, and WebSocket connections require the new
identity. A reset therefore also discards unsynchronized edits from old clients.

This differs from the importer's `--replace`: that operation replaces observed
notes inside the existing CRDT, retaining deletion bookkeeping for offline peers.
