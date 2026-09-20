import type { HistoryAction, HistoryBoundary, HistoryPatch } from '../src/core/history-types';

// Checked by tsc in both production and demo builds. No runtime fixture needed.
export function historyTypeContracts() {
  const patch = (_value: HistoryPatch) => {};
  const action = (_value: HistoryAction) => {};
  const boundary = (_value: HistoryBoundary) => {};
  patch({ op: 'set', sourceId: 'n', field: 'pinned', value: true });
  patch({ op: 'set', sourceId: 'n', field: 'color', value: 'sage' });
  patch({ op: 'item-set', sourceId: 'n', itemId: 'i', field: 'rank', value: 3 });
  // @ts-expect-error pinned requires a boolean
  patch({ op: 'set', sourceId: 'n', field: 'pinned', value: 'true' });
  // @ts-expect-error color requires a NoteColor, not an arbitrary string
  patch({ op: 'set', sourceId: 'n', field: 'color', value: 'not-a-color' });
  // @ts-expect-error rank requires a number
  patch({ op: 'item-set', sourceId: 'n', itemId: 'i', field: 'rank', value: false });
  // @ts-expect-error checked requires a boolean
  patch({ op: 'item-set', sourceId: 'n', itemId: 'i', field: 'checked', value: 1 });
  action({ type: 'text', noteId: 'n', field: 'body', changes: [] });
  action({ type: 'text', noteId: 'n', field: 'text', itemId: 'i', changes: [] });
  // @ts-expect-error checklist text edits identify their item
  action({ type: 'text', noteId: 'n', field: 'text', changes: [] });
  // @ts-expect-error text edits cannot target pinned
  action({ type: 'text', noteId: 'n', field: 'pinned', changes: [] });
  // @ts-expect-error image actions identify their attachment
  action({ type: 'image-remove', noteId: 'n', changes: [] });
  // @ts-expect-error check actions identify their resulting checked state
  action({ type: 'check', noteId: 'n', itemId: 'i', field: 'checked', changes: [] });
  // @ts-expect-error omitting changes must retain the discriminated action contract
  boundary({ sourceIds: ['n'], editedAt: 1, action: { type: 'text', noteId: 'n', field: 'text' } });
}
