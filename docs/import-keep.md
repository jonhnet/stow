# Import Google Keep

The importer previews a Google Keep Takeout export, then applies a saved plan to one explicitly selected Stow vault. Existing notes are kept by default.

## Import into a self-hosted Podman installation

These commands work with both the [home](HOME_HOSTING.md) and [internet](INTERNET_HOSTING.md) installations. Run them on the computer running Stow, from the source checkout. Keep Stow running. Only the hosting prerequisites are needed; the command builds a temporary import container with its own dependencies.

Export only **Keep** at [Google Takeout](https://takeout.google.com), then copy the download to this computer, outside `stow-git` and `build`. Use a `.tgz`, `.tar.gz`, or extracted `Takeout/Keep` directory. Keep images and other attachments beside their JSON notes. If the export includes other Google products, select only the extracted `Takeout/Keep` directory.

After making a backup as described in your hosting guide, update Stow so the server and importer use the same version. Then preview the import, replacing the input path:

```sh
git pull --ff-only
sudo ./self-host.py
sudo ./import-keep-podman.py --input /path/to/takeout.tgz
```

For a ZIP export, extract it first using Python, which the hosting setup already installed:

```sh
python3 -m zipfile -e /path/to/takeout.zip ../takeout
sudo ./import-keep-podman.py --input ../takeout/Takeout/Keep
```

Preview changes no notes and uploads no files. Review the note counts and warnings, then use the exact `plan` filename and `vaultId` it prints:

```sh
sudo ./import-keep-podman.py --plan /path/printed/by/preview/plan.json \
  --apply --vault VAULT_ID_FROM_PREVIEW
```

Open Stow at your usual HTTPS URL to see the imported notes. After an interruption, retry that same apply command; a completed plan is not imported twice.

The command reads the installed password from `/var/lib/stow/stow.env` and connects through the running application container's private network namespace. The same command works behind nginx and with home certificates; no URL, certificate import, or password copy is needed. It uses the authenticated API and does not mount or edit the server's live notes directory.

Saved plans and staged input remain under `../build/keep-import-stow/` on the host. Keep them until the operation is complete. Before applying, the importer saves a persistent backup beneath `/var/lib/stow/import-backups/`. Keep the original Takeout export independently of `build`; deleting build files removes saved plans but does not remove Stow notes or these backups.

If you installed with a custom name and state directory, keep supplying `--name` and `--state-dir` to `self-host.py`, and `--state-dir` to every import command; the importer reads the service name from its settings. `--build-network host` is available for machines that needed it during hosting setup. To intentionally replace existing notes, add `--replace` to the preview command and read [replacement behavior](#append-replace-and-retry) first.

Takeout import requires no Google credentials. Takeout omits checklist nesting, so imported checklists are flat; text and checked states are retained. Restore nesting manually in Stow.

## Development and other server installations

The direct `import-keep.sh` client requires the [development prerequisites](../CONTRIBUTING.md), including Node.js, Rust, and ImageMagick. Run `./setup.sh` first. It can import into a local or remote server through HTTP and WebSockets.

`import-keep.sh` loads the private workspace `.env` (`../.env` relative to the checkout) as shell settings. Credentials come from `STOW_PROXY_SECRET` or `STOW_PASSWORD`, never command arguments. File values override matching exported shell variables. The Podman wrapper above instead reads the installer's literal env file; do not copy or source that file as shell code.

For a single personal vault, configure `STOW_AUTH_MODE=password` and `STOW_PASSWORD` in the workspace `.env`, then run:

```sh
./import-keep.sh --input /path/to/Takeout/Keep \
  --auth-mode password --server https://stow.example.com
```

An nginx TLS proxy does not change the authentication mode: both `self-host.py` hosting paths use the Stow password. For a server deliberately configured with multi-user proxy authentication, set `STOW_AUTH_MODE=proxy` and `STOW_PROXY_SECRET`, and supply the exact stable identity normally sent by that authenticating proxy:

```sh
./import-keep.sh --input /path/to/takeout.tgz \
  --auth-mode proxy --user 'your-proxy-identity'
```

The backend defaults to `http://127.0.0.1:3001`. Use `--server https://stow.example.com` or another backend root URL when needed. The destination must accept the selected authentication mode for both HTTP and WebSockets. Proxy mode requires its private proof and user identity; password login is attempted only after a password-mode session response. Redirects and account mismatches stop the import.

### Preview and apply with the direct client

The commands above append notes. Add `--replace` when creating the preview to discard the account's existing note sources:

```sh
./import-keep.sh --input /path/to/takeout.tgz \
  --auth-mode proxy --user 'your-proxy-identity' --replace
```

Preview connects to the account, validates and stages the input beneath `../build/keep-import-*/`, and prints:

- The authenticated user and opaque vault ID.
- Counts of notes, active/archive/trash state, checklist items, attachments, and labels.
- The number of existing sources selected for replacement.
- Upload bytes, encoded update size, and conversion warnings.
- The path to the saved `plan.json`.

Preview uploads no files and changes no notes. Review the account, replacement count, and warnings before applying. Use the exact plan path and vault ID printed by the preview:

```sh
./import-keep.sh --plan /absolute/path/to/plan.json \
  --apply --vault 'VAULT_ID_FROM_PREVIEW'
```

The saved plan binds the server, authentication mode, user, vault, source files, and replacement selection. Applying requires `--vault`; changing a bound account or editing the plan causes validation to fail. The staged files are checked against their sizes and SHA-256 hashes again before upload.

Apply saves a persistent backup, uploads source files and attachments, and then publishes the note changes and import receipt in one CRDT update. Completion is reported only after the server durably acknowledges that update and the receipt is verified. A failed upload stops before note publication. Files already uploaded during an interrupted attempt may remain on the server and are reused by hash on retry.

## Append, replace, and retry

Append derives its operation and note IDs from the source manifest. Repeating the same manifest for the same account is a no-op, including after subsequent edits in Stow. This is import deduplication, not continuous synchronization with Keep: an updated export or different relative source paths can produce a new manifest and another set of notes.

Each new `--replace` preview has fresh note IDs and freezes the source IDs present in that account at preview time. It includes active, archived, and trashed sources. Notes created afterward are preserved. Edits made afterward to a selected source are still part of the source being discarded; finish intended edits and review the selection before applying.

Replacement records deletions in the existing CRDT document. It preserves the account identity and document's merge metadata, so stale offline edits to discarded sources cannot resurrect those sources on reconnect. It does not reset the server secret, account directory, or browser databases.

For an entirely fresh CRDT, use the explicit [offline account reset](account-reset.md) before importing. It gives only the selected account a new vault identity, preserves its former data in a reset backup, and prevents old browser caches from uploading into the replacement. Create a new import plan after the reset.

After an interruption or uncertain connection result, rerun the **same saved plan** with `--apply --vault`. The atomic receipt makes an already completed operation a no-op. A new replacement preview starts a new operation. Keep the plan and its staged files until completion; deleting `build/` removes the files needed to retry that plan. The original Takeout export should be retained independently.

## Preserved content and conversion warnings

| Keep content | Stow result |
| --- | --- |
| Titles, note text, checklists | Imported with the exported item sequence and checked state. The audited Takeout JSON/HTML contains no checklist hierarchy, so imported checklists are flat. Plain text is escaped for Stow's Markdown renderer so punctuation keeps its displayed meaning. Plaintext bodies and checklist items discard spaces and tabs at the beginning and end of each line; internal spacing and source line breaks remain, although extra blank-line spacing is not fully preserved in display. |
| Rich text | Supported formatting converts to Markdown. The preview reports conversions and formatting that remains only in the source JSON. |
| Created and edited timestamps | Preserved at millisecond precision; the original microsecond values remain in the raw JSON. |
| Pin, archive, trash, and color | Preserved, with Keep colors mapped to Stow's palette, including gray. |
| Labels | Preserved as explicit labels, shown on notes, editable with **Edit labels**, and included in search and the sidebar label catalog. Label chip colors can be set in Stow; note backgrounds stay independent. Hashtags are not interpreted as labels. A new explicit import can recreate a previously deleted label name, attaching it only to the imported notes; retrying an already applied plan does not recreate labels. |
| Images | Original bytes, note references, and exported attachment order are retained in newly generated plans. Preview checks that Stow can decode images and generate thumbnails. Older plans/attachments without an explicit order retain their existing display order. |
| Audio and other attachments | Original bytes and references are retained as downloadable files. Open them in an app supporting their format; the importer does not transcode audio. |
| Link annotations | HTTP(S) links missing from the authored text are appended once as ordinary Markdown links, using the exported webpage title as the label when available. Existing URLs are not duplicated. The preview reports added links. Webpage preview cards are intentionally outside Stow's scope; descriptions and unused preview titles remain only in source JSON and need no separate conversion warning. |

Keep sharing/collaborator settings and task metadata remain in the source JSON; they do not create shared vaults or Stow tasks. Underlining, unsupported table layout, extra note/checklist metadata, and unsupported annotation destinations also produce source-only warnings. Read the warning codes and affected-file counts in the preview; the private plan lists the affected source paths.

Each note's exact original JSON is retained as a content-addressed server blob. A source manifest records source paths, hashes, converted notes, and warnings, and is also retained as a server blob. Unreferenced non-JSON/non-HTML files are preserved with a warning. Takeout's generated per-note HTML export files are omitted; any `textContentHtml` inside the original JSON remains available there. The importer does not retain the entire archive as a server blob, so keep the original export for its complete packaging and generated HTML.


The import creates no fabricated edit history or session undo entries. A later Stow edit records the imported state as its starting point and retains subsequent authored changes normally. Existing history and server blobs from replaced sources remain retained, although discarded notes disappear from the overview.

## Backups and recovery

Before an unapplied operation uploads files or changes notes, the importer saves a backup directory. The Podman command uses `/var/lib/stow/import-backups/<vault-id>/` (or your custom state directory); the direct client defaults to `../data/import-backups/<vault-id>/`. Each backup contains:

- `before.yjs`: the synchronized current-state CRDT.
- `before-notes.json`: the materialized notes for inspecting or recovering content.
- `before-history.json`: independent saved versions exported from the selected account.
- `blobs/<hash>`: originals referenced by current notes, saved versions, or retained import source metadata, verified by their SHA-256 hashes.
- `import-plan.json`: the reviewed operation.
- `result.json`: completion details, written after a successful apply.

The direct client accepts `--backup-dir /persistent/path/import-backups` for a different location; its default is independent of the server's `DATA_DIR`. Backups must remain outside the source checkout and disposable `build/`. These files contain private note content. A history export failure, missing original, or mismatched hash stops the import before uploads or note changes. Maintain a [complete server data backup](../README.md#back-up-and-restore) as well; it also preserves account identity, server settings, and originals retained solely for an existing note's local Undo stack.

These snapshots are recovery material, not an automatic rollback. Merging `before.yjs` into the current document will not undo CRDT deletion records. Recover wanted content as new notes with fresh identities. Replacing server files from a backup also requires the device-state considerations described in the general backup documentation; reconnecting replicas can carry later changes.

## Limits and failures

Staging rejects links, absolute or traversal paths, duplicate entries, and file/directory collisions. It creates private files in an empty staging directory beneath `build/`. Default limits are 100,000 entries, 20 MiB per file, and 5 GiB of staged file content; decompressed archive overhead is bounded too.

The server accepts blobs up to 20 MiB and one incoming sync update up to 16 MiB. Preview measures the actual encoded import update and fails when it exceeds that limit. Split a larger source into smaller append imports, keeping each note's referenced files with it. Empty input, malformed note data, missing attachments, or images Stow cannot decode stop validation before publication. There is no silent skip mode.
