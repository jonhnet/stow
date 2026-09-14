import type { HistoryAction, HistorySource, HistoryState, LabelChange } from './history-types';
import { textSplice } from './text-splice';
import { historyText } from './history-view';

type Action = Omit<HistoryAction, 'changes'>;
export interface TextDescription {
  target: string; scope: 'Title' | 'Note' | 'Item'; index: number; removed: string; inserted: string;
}
export interface UndoDescription {
  description: string;
  text?: TextDescription;
  labelSetting?: { name: string; type: LabelChange['type'] };
  /** A precision repair can move this card without changing its own number. */
  movedNoteId?: string;
}

/** Excerpts are display text; the underlying revision keeps the complete edit. */
export function quoteExcerpt(value: string) {
  const characters = Array.from(value.replace(/\r\n|\r|\n/g, ' · ').replace(/\t/g, '\\t'));
  return `“${characters.slice(0, 120).join('')}${characters.length > 120 ? '…' : ''}”`;
}
export function describeTextChange(scope: TextDescription['scope'], removed: string, inserted: string) {
  if (removed && inserted) return `${scope}: replaced ${quoteExcerpt(removed)} with ${quoteExcerpt(inserted)}`;
  if (removed) return `${scope}: deleted ${quoteExcerpt(removed)}`;
  if (inserted) return `${scope}: added ${quoteExcerpt(inserted)}`;
  return `${scope}: edited text`;
}
export function textTarget(action: Action) {
  return action.type === 'text' ? JSON.stringify([action.noteId, action.field, action.itemId ?? null]) : undefined;
}
export function actionText(state: HistoryState, action: Action) {
  const source = action.noteId ? state.sources[action.noteId] : undefined;
  if (action.field === 'title' || action.field === 'body') return action.noteId ? historyText(state, action.noteId)?.[action.field] ?? '' : '';
  return action.itemId ? (source?.items[action.itemId] ?? Object.values(state.sources).find(entry => entry.items[action.itemId!])?.items[action.itemId])?.text ?? '' : '';
}
const wordCharacter = (value: string) => /^[\p{L}\p{N}\p{M}_]$/u.test(value);
const nextCharacter = (text: string, index: number) => text.codePointAt(index) === undefined ? '' : String.fromCodePoint(text.codePointAt(index)!);
function previousCharacter(text: string, index: number) {
  const last = text.charCodeAt(index - 1);
  return text.slice(index > 1 && last >= 0xdc00 && last <= 0xdfff ? index - 2 : index - 1, index);
}
/** Keep replacement descriptions readable when the minimal edit cuts a word. */
function withWordContext(edit: TextDescription, before: string, after: string): TextDescription {
  if (!edit.removed || !edit.inserted) return edit;
  let start = edit.index, oldEnd = start + edit.removed.length, newEnd = start + edit.inserted.length;
  for (let count = 0; count < 40 && start > 0; count++) {
    const previous = previousCharacter(before, start);
    if (!wordCharacter(previous) || !(wordCharacter(nextCharacter(before, start)) || wordCharacter(nextCharacter(after, start)))) break;
    start -= previous.length;
  }
  for (let count = 0; count < 40; count++) {
    const next = nextCharacter(before, oldEnd);
    if (!wordCharacter(next) || !(wordCharacter(previousCharacter(before, oldEnd)) || wordCharacter(previousCharacter(after, newEnd)))) break;
    oldEnd += next.length; newEnd += next.length;
  }
  return { ...edit, index: start, removed: before.slice(start, oldEnd), inserted: after.slice(start, newEnd) };
}
export function textDescription(before: HistoryState, after: HistoryState, action: Action): TextDescription | undefined {
  const target = textTarget(action); if (!target) return;
  const old = actionText(before, action), current = actionText(after, action), patch = textSplice(old, current);
  return withWordContext({ target, scope: action.field === 'title' ? 'Title' : action.field === 'body' ? 'Note' : 'Item',
    index: patch.index, removed: old.slice(patch.index, patch.index + patch.remove), inserted: patch.insert }, old, current);
}

/** Compose local typing into one edited span, retaining no whole-note snapshots. */
export function composeTextDescriptions(previous: TextDescription, next: TextDescription, beforeNext: string): TextDescription {
  const start = Math.min(previous.index, next.index);
  const end = Math.max(previous.index + previous.inserted.length, next.index + next.removed.length);
  const removed = beforeNext.slice(start, previous.index) + previous.removed + beforeNext.slice(previous.index + previous.inserted.length, end);
  const inserted = beforeNext.slice(start, next.index) + next.inserted + beforeNext.slice(next.index + next.removed.length, end);
  const compact = textSplice(removed, inserted);
  const result = { ...next, index: start + compact.index, removed: removed.slice(compact.index, compact.index + compact.remove), inserted: compact.insert };
  if (!result.removed || !result.inserted) return result;
  const prefix = beforeNext.slice(0, start), suffix = beforeNext.slice(end);
  return withWordContext(result, prefix + removed + suffix, prefix + inserted + suffix);
}

function metadataDescription(source: Partial<HistorySource> | undefined, action: Action, existingLabel: string) {
  if (!source) return existingLabel;
  const title = quoteExcerpt(source.title || 'Untitled note');
  switch (action.field) {
    case 'pinned': return `Note: ${source.pinned ? 'pinned' : 'unpinned'} ${title}`;
    case 'archived': return `Note: ${source.archived ? 'archived' : 'unarchived'} ${title}`;
    case 'trashed': return `Note: ${source.trashed ? 'moved to trash' : 'restored from trash'} ${title}`;
    case 'kind': return `Note: ${source.kind === 'checklist' ? 'added checklist to' : 'changed format of'} ${title}`;
    case 'color': return `Note: colored ${title} ${source.color}`;
    default: return existingLabel;
  }
}
export function describeHistoryAction(before: HistoryState, after: HistoryState, action: Action, existingLabel: string): string {
  const text = textDescription(before, after, action);
  if (text) return describeTextChange(text.scope, text.removed, text.inserted);
  const rawSource = action.noteId ? after.sources[action.noteId] ?? before.sources[action.noteId] : undefined;
  const flatText = action.noteId ? historyText(after, action.noteId) ?? historyText(before, action.noteId) : undefined;
  const source = rawSource && flatText ? { ...rawSource, title: flatText.title, body: flatText.body } : rawSource;
  if (action.type === 'create') return `Note: created ${quoteExcerpt(source?.title || 'Untitled note')}`;
  if (action.type === 'item-add' || action.type === 'item-delete') return `Item: ${action.type === 'item-add' ? 'added' : 'deleted'} ${quoteExcerpt(action.itemText || 'Empty item')}`;
  if (action.type === 'metadata') {
    if (action.field === 'labels') {
      const id = action.noteId!, old = before.sources[id]?.labels ?? [], current = after.sources[id]?.labels ?? [];
      const added = current.filter(name => !old.includes(name)), removed = old.filter(name => !current.includes(name));
      if (added.length) return `Label: added ${added.map(quoteExcerpt).join(', ')}`;
      if (removed.length) return `Label: removed ${removed.map(quoteExcerpt).join(', ')}`;
    }
    return metadataDescription(source, action, existingLabel);
  }
  if (action.type === 'reorder') {
    if (action.field === 'sortOrderDate') return `Note: moved ${quoteExcerpt(source?.title || 'Untitled note')}`;
    const item = quoteExcerpt(action.itemText || 'Empty item');
    if (action.field === 'parentId') return `Item: ${source?.items[action.itemId!]?.parentId ? 'indented' : 'outdented'} ${item}`;
    return `Item: moved ${item}`;
  }
  return existingLabel;
}

export function describeLabelChange(change: LabelChange) {
  return change.type === 'color' ? `Label: colored ${quoteExcerpt(change.name)} ${change.after.color}` : `Label: deleted ${quoteExcerpt(change.name)}`;
}
