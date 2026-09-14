# Label identity and deletion

Label names are explicit metadata. The sidebar and note picker use the same catalog, ordered by the most recently edited nontrashed note carrying each label; archived notes participate. Chip colors are vault settings, independent of note backgrounds.

Original imported labels and the first explicit assignments use the original identity for that name. Independent per-note membership keys allow two offline devices to assign different labels without overwriting one another. A false assignment keeps an unused label available in the catalog.

Global deletion changes the name's lifecycle record to a deleted state with a fresh generation. Existing assignments and colors remain stored for Undo, but projections and the catalog hide them. Deleting a label does not edit note timestamps or append a revision to every note. The deletion is one undoable vault-setting transaction. Global color and deletion actions append one compact shared history event with affected source IDs and before/after label settings; affected notes display that event in their timelines. These events contain no note snapshot and do not become note-state compression bases. Undo/redo retain the event and append their own settings event. Events describe the label identity observed by their author; deleting and recreating a name does not rewrite earlier events.

Explicitly recreating a deleted name activates its new generation. Assignments and colors for that generation use separate keys, so delayed writes to an older identity cannot replace the new identity's assignments or colors. Two devices recreating the same observed deletion share the new generation. Undo of deletion restores the original identity, including its assignments and color.

The lifecycle record itself is a Yjs map value keyed by label name. Truly concurrent global deletion/recreation commands for the same name resolve by Yjs's deterministic conflict rules: either lifecycle can win. For example, a second offline deletion may win over a recreation performed on another device. This is a conflict between global commands; the isolation guarantee for old membership and color writes does not give those commands priority over one another. No wall-clock ordering or separate transfer protocol is involved.

Saved note revisions retain the label identities observed at the time. Historical previews still show the original label names. Restoring a copy attaches only identities that are still active; it does not recreate a deleted label or attach an unrelated new identity with the same name.

An explicit new Takeout import attaches its supplied label names to current identities and may recreate a deleted name for the imported notes. It does not reattach old notes. A previously applied import receipt returns before any lifecycle mutation, so retrying a plan cannot recreate labels deleted after that import. Import and history metadata preserve original source information without treating it as a current assignment to another identity.

All of this state lives in the account's existing CRDT. Opening, signing in, reloading, and syncing create no migrations or cross-account copies.
