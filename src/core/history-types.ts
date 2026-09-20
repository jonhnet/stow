import type { Attachment, NoteColor, NoteKind } from './types';
import type { MergeRecipe } from './merged-text';

/** Normalized history payload: each source, checklist item and image occurs once. */
export interface HistoryItem { text: string; checked: boolean; rank: number; parentId?: string }
export interface HistorySource {
  title: string; body: string; kind: NoteKind; color: NoteColor;
  pinned: boolean; archived: boolean; trashed: boolean; createdAt: number; updatedAt: number;
  sortOrderDate?: number;
  unifiedChecklist?: boolean;
  items: Record<string, HistoryItem>; images: Record<string, Attachment>; labels?: string[];
  /** Missing entries identify labels from before their first global deletion. */
  labelGenerations?: Record<string, string>;
}
export interface HistoryState {
  sources: Record<string, HistorySource>; groups: string[][];
  recipes?: Record<string, MergeRecipe>;
  /** Editable separator runs, independent of the original source texts. */
  joins?: Record<string, string>;
}
export type SourceField = Exclude<keyof HistorySource, 'items' | 'images' | 'title' | 'body' | 'labels' | 'labelGenerations' | 'unifiedChecklist'>;
type FieldValue<T, Keys extends keyof T> = {
  [K in Keys]-?: { field: K; value: NonNullable<T[K]> }
}[Keys];
export type HistoryPatch =
  | { op: 'source'; sourceId: string; value: HistorySource | null }
  | ({ op: 'set'; sourceId: string } & FieldValue<HistorySource, SourceField>)
  | { op: 'text'; sourceId: string; field: 'title' | 'body'; index: number; remove: number; insert: string }
  | { op: 'item'; sourceId: string; itemId: string; value: HistoryItem | null }
  | ({ op: 'item-set'; sourceId: string; itemId: string } & FieldValue<HistoryItem, 'checked' | 'rank'>)
  | { op: 'item-parent'; sourceId: string; itemId: string; value: string | null }
  | { op: 'item-text'; sourceId: string; itemId: string; index: number; remove: number; insert: string }
  | { op: 'image'; sourceId: string; attachmentId: string; value: Attachment | null }
  | { op: 'labels'; sourceId: string; value: string[]; generations?: Record<string, string> }
  | { op: 'checklist-mode'; sourceId: string; value: boolean | null }
  | { op: 'recipe'; recipeId: string; value: MergeRecipe | null }
  | { op: 'join'; joinId: string; value: string | null }
  | { op: 'join-text'; joinId: string; index: number; remove: number; insert: string }
  | { op: 'groups'; value: string[][] };
interface ActionFields {
  noteId?: string;
  field?: 'title' | 'body' | 'text' | 'checked' | 'rank' | 'parentId' | 'labels' | SourceField;
  itemId?: string;
  attachmentId?: string;
  itemText?: string;
  checked?: boolean;
}
type ActionVariant<T> = T & { [K in Exclude<keyof ActionFields, keyof T>]?: never };
/** Local action intent, before a diff is attached. Keep this union intact:
 * built-in Omit on a union would erase the field/target relationships. */
export type HistoryIntent =
  | ActionVariant<{ type: 'create' | 'merge' | 'separate'; noteId: string }>
  | ActionVariant<{ type: 'text'; noteId: string; field: 'title' | 'body' }>
  | ActionVariant<{ type: 'text'; noteId: string; field: 'text'; itemId: string }>
  | ActionVariant<{ type: 'metadata'; noteId?: string; field?: SourceField | 'labels' }>
  | ActionVariant<{ type: 'item-add' | 'item-delete'; noteId: string; itemId: string; itemText?: string }>
  | ActionVariant<{ type: 'check'; noteId: string; itemId: string; field: 'checked'; checked: boolean; itemText?: string }>
  | ActionVariant<{ type: 'reorder'; noteId: string; field: 'sortOrderDate' }>
  | ActionVariant<{ type: 'reorder'; noteId: string; itemId: string; field: 'rank' | 'parentId'; itemText?: string }>
  | ActionVariant<{ type: 'image-add' | 'image-remove'; noteId: string; attachmentId: string }>
  | ActionVariant<{ type: 'restore' }>
  // Undo/redo can describe effects on several sources or a global label setting.
  | ({ type: 'undo' | 'redo' } & ActionFields);
export type HistoryActionKind = HistoryIntent['type'];
export type HistoryAction = HistoryIntent & {
  /** Effect relative to the state observed immediately before this action. */
  changes: HistoryPatch[];
};
/** A best-effort notification after completed current-state edits. Never stored in Yjs. */
export interface HistoryBoundary {
  sourceIds: string[];
  editedAt: number;
  action?: HistoryIntent;
  description?: string;
  labelSetting?: { name: string; type: 'color' | 'delete' };
}
/** In-memory editing group. It is neither a saved version nor an upload queue. */
export interface EditDraft {
  sourceIds: string[];
  action: HistoryIntent;
  before: HistoryState;
  after: HistoryState;
  firstInputAt: number;
  lastInputAt: number;
}
/** Tiny local recovery metadata; live text is durable in the separate update log. */
export interface PendingEdit { modifiedAt: Record<string, number> }
export interface LabelSettingState { color: NoteColor; deleted: boolean; generation?: string }
export interface LabelChange {
  name: string; type: 'color' | 'delete'; before: LabelSettingState; after: LabelSettingState;
  direction?: 'undo' | 'redo';
}
