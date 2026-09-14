import type { HistoryState } from './history-types';
import type { SourceNote } from './types';
import { composeText, materializeNote } from './merged-text';
import { compareAttachmentOrder } from './attachments';

/** History payloads retain raw sources; public views use the live materializer. */
export function historyGroups(state: HistoryState): string[][] {
  const groups = state.groups.map(group => group.filter(id => state.sources[id])).filter(group => group.length);
  const included = new Set(groups.flat());
  for (const id of Object.keys(state.sources)) if (!included.has(id)) groups.push([id]);
  return groups;
}

export function historySources(state: HistoryState): Record<string, SourceNote> {
  return Object.fromEntries(Object.entries(state.sources).map(([id, source]) => [id, {
    ...source, id, sortOrderDate: source.sortOrderDate ?? source.createdAt,
    items: Object.entries(source.items).map(([itemId, item]) => ({ ...item, id: itemId, noteId: id })),
    images: Object.values(source.images).sort(compareAttachmentOrder),
  }]));
}

export function historyNotes(state: HistoryState) {
  const sources = historySources(state);
  return historyGroups(state).map(group => materializeNote(group, sources, state.recipes ?? {}, state.joins ?? {}));
}

/** Text-only lookup avoids materializing checklists while describing each input. */
export function historyText(state: HistoryState, id: string) {
  const group = state.groups.find(group => group.includes(id)) ?? (state.sources[id] ? [id] : undefined);
  return group ? composeText(group, state.sources, state.recipes ?? {}, state.joins ?? {}) : undefined;
}
