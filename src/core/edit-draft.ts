import type { EditDraft, PendingEdit } from './history-types';
import { diffHistory, redactHistoryState } from './history';

/** Erased source content must leave the in-memory editing group, too. */
export function redactEditDraft(draft: EditDraft, deleted: { has(id: string): boolean }): EditDraft | null {
  const sourceIds = draft.sourceIds.filter(id => !deleted.has(id));
  if (!sourceIds.length) return null;
  if (sourceIds.length === draft.sourceIds.length) return diffHistory(draft.before, draft.after).length ? draft : null;
  const kept = new Set(sourceIds);
  const before = redactHistoryState(draft.before, deleted), after = redactHistoryState(draft.after, deleted);
  if (!diffHistory(before, after).length) return null;
  const action = { ...draft.action };
  delete action.itemText;
  if (action.noteId && !kept.has(action.noteId)) action.noteId = sourceIds[0];
  if (action.itemId && ![...Object.values(before.sources), ...Object.values(after.sources)].some(source => source.items[action.itemId!])) delete action.itemId;
  return { ...draft, sourceIds, before, after, action };
}

export function redactPendingEdit(pending: PendingEdit, deleted: { has(id: string): boolean }): PendingEdit | null {
  const modifiedAt = Object.fromEntries(Object.entries(pending.modifiedAt).filter(([id]) => !deleted.has(id)));
  return Object.keys(modifiedAt).length ? { modifiedAt } : null;
}
