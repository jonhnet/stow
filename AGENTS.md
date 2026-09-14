# Stow engineering rules

- Keep UI copy functional: navigation, control labels, concise state feedback, and actionable errors. Omit slogans and decorative prose. Discuss changes to copy that identifies the current view, explains empty/loading states, or describes non-obvious behavior before removing it.
- Keep the repository source-only. Dependencies, bundles, tool caches, and test output belong in the sibling `build/` directory; install dependencies with `./setup.sh`. Persistent vault data and private configuration stay outside both source and build. Deleting `build/` must never remove user data.
- Supported browser environment: current browsers over HTTPS, plus HTTP localhost for development. The server may use HTTP behind a TLS-terminating reverse proxy.
- Prefer one supported implementation path. Do not add speculative compatibility branches, alternate crypto implementations, or silent degraded modes to accommodate an unsupported environment. State the requirement and fail clearly before initializing the vault when it is not met.
- A new compatibility path needs a concrete product requirement, documented semantics, and a test for that environment. Fix deployment/configuration when that satisfies the existing contract.
- Offline editing, retained pending writes, reconnect retries, and history recovery are intended product behavior. Preserve them; report storage failures rather than silently dropping data or claiming a failed write succeeded.
- Keep note/component identities stable across merges so edits from offline devices remain visible.
- Scope every vault, image store, sync broadcast, and browser database to an explicitly verified account. Bind sync and blob requests to the account the client expects; reject mismatches before accessing data. Proxy identity requires the configured private proxy proof, never merely a loopback connection.
- Never import or copy data between account vaults or from old shared storage during startup, sign-in, reload, or sync. Open only the verified account's explicitly scoped storage; retain each account's pending offline edits in that account.
