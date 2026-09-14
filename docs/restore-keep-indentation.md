# Restore Keep checklist indentation

This saved-page tool only recovers rows present in the captured page. Unloaded notes and truncated rows limit its coverage; it cannot reconstruct all nesting across an account.

`restore-keep-indentation.sh` recovers explicit checklist parent-child relationships from a saved Google Keep web page into an existing Stow import. It does not reimport note content. Sharing and reminders are outside this recovery operation.

The script requires the original import plan and its staged JSON files for preview. The saved page must identify the same Google account as the Stow proxy identity. It parses HTML locally, without executing scripts, loading saved resources, or contacting Google.

```sh
./restore-keep-indentation.sh \
  --html '/path/Google Keep.html' \
  --import-plan /path/keep-import/plan.json
```

Preview compares the page's note titles and complete checklist labels with original Takeout JSON, then checks the matched Stow checklists against their imported item identities, text, checked state, and positions. Changed, merged, archived, trashed, or ambiguous destination lists are left untouched and reported. It writes a private recovery plan beneath `../build/keep-indentation-*/`, and displays coverage, skipped cards, and the account/vault.

Keep saves only the cards/rows currently present in its page. Both whole lists and individual labels may be truncated. Recovery uses explicit row indentation and exact unambiguous item matches; it does not infer hidden rows or match shortened labels by a guessed prefix. A parent must be explicitly visible in the same checklist section as its child. The generated plan lists every eligible child and its existing parent ID for inspection.

Apply the exact saved preview:

```sh
./restore-keep-indentation.sh \
  --plan /path/keep-indentation/plan.json \
  --apply --vault VAULT_ID_FROM_PREVIEW
```

The wrapper reads the workspace `.env` just like `import-keep.sh`. Apply verifies the account and original import receipt, rechecks every selected list, and saves a persistent `before.yjs` plus `indentation-plan.json` under `../data/indentation-backups/<vault-id>/`. Use `--backup-dir` for another persistent location outside the source checkout and `build/`.

Recovery uses normal indentation commands, retaining note/item IDs, text, checkbox states, and attachments. It adjusts child positions and edited timestamps as a normal indentation does. A single durable sync update includes a completion receipt. This script publishes current data without individual history-boundary hints; it does not guarantee a saved version for each recovered indentation or before/after snapshots. Retrying the same recovery plan is a no-op after success, even if the user has since changed the recovered list. An apply-time checklist mismatch stops the operation before it submits changes; generate and inspect a new preview to reassess coverage.

Preconditions check the latest synchronized state, without locking other clients. Concurrent edits after that check follow the normal CRDT merge rules. The script checks the recovered parent IDs again after acknowledgement and reports any observed conflicting relationships.

The backup is recovery material, not a file to merge as an automatic rollback: merging an old CRDT snapshot does not undo later writes. `before.yjs` preserves the pre-recovery current state; saved history contains only snapshots actually captured by the server and is not a substitute for that backup. This tool's backup excludes separate server history and image bytes; a [complete data-directory backup](../README.md#back-up-and-restore) preserves those too. Keep the original page and Takeout archive independently of disposable build files.
