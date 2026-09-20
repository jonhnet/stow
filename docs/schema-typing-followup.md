# Raw schema typing follow-up

History diffs now require an explicit handler for every `HistorySource` field,
including optional fields. History patch application is exhaustive, and tests
exercise each field in both directions. Patch values and local action targets
are correlated by discriminated unions.

The remaining schema-typing work is deferred: replacing the raw `Y.Map<any>`
access in the browser and `serde_json::Value` projection in Rust with codecs.
This needs an explicit boundary between partially received CRDT records and
normalized, complete application records. Offline updates may deliver fields
in different orders; missing fields alone do not prove corrupt input. Existing
readers also normalize some missing values and coerce others. A blanket strict
codec at update receipt would change those semantics.

Before implementing that replacement, decide:

- Which incomplete records should use today's display defaults, remain pending,
  or be reported as invalid, and at what point in synchronization?
- How should unknown or wrongly typed fields be handled without discarding
  unrelated valid edits in the same CRDT update?

Recommended direction: separate raw partial-record types from normalized view
and saved-history types, define matching browser/server normalization rules,
and test those rules against reordered dependencies, restarts, and existing
exports before changing acceptance behavior. Preserve the current persisted
representation unless a separate schema change is explicitly intended.
