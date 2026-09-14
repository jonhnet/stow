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
export type HistoryPatch =
  | { op: 'source'; sourceId: string; value: HistorySource | null }
  | { op: 'set'; sourceId: string; field: SourceField; value: string | number | boolean }
  | { op: 'text'; sourceId: string; field: 'title' | 'body'; index: number; remove: number; insert: string }
  | { op: 'item'; sourceId: string; itemId: string; value: HistoryItem | null }
  | { op: 'item-set'; sourceId: string; itemId: string; field: 'checked' | 'rank'; value: boolean | number }
  | { op: 'item-parent'; sourceId: string; itemId: string; value: string | null }
  | { op: 'item-text'; sourceId: string; itemId: string; index: number; remove: number; insert: string }
  | { op: 'image'; sourceId: string; attachmentId: string; value: Attachment | null }
  | { op: 'labels'; sourceId: string; value: string[]; generations?: Record<string, string> }
  | { op: 'checklist-mode'; sourceId: string; value: boolean | null }
  | { op: 'recipe'; recipeId: string; value: MergeRecipe | null }
  | { op: 'join'; joinId: string; value: string | null }
  | { op: 'join-text'; joinId: string; index: number; remove: number; insert: string }
  | { op: 'groups'; value: string[][] };
export type HistoryActionKind = 'create' | 'text' | 'metadata' | 'item-add' | 'item-delete' | 'check' | 'reorder' | 'image-add' | 'image-remove' | 'merge' | 'separate' | 'restore' | 'undo' | 'redo';
export interface HistoryAction {
  type: HistoryActionKind;
  noteId?: string;
  field?: 'title' | 'body' | 'text' | 'checked' | 'rank' | 'parentId' | 'labels' | SourceField;
  itemId?: string;
  attachmentId?: string;
  itemText?: string;
  checked?: boolean;
  /** Effect relative to the state observed immediately before this action. */
  changes: HistoryPatch[];
}
/** A best-effort notification after completed current-state edits. Never stored in Yjs. */
export interface HistoryBoundary {
  sourceIds: string[];
  editedAt: number;
  action?: Omit<HistoryAction, 'changes'>;
  description?: string;
  labelSetting?: { name: string; type: 'color' | 'delete' };
}
/** In-memory editing group. It is neither a saved version nor an upload queue. */
export interface EditDraft {
  sourceIds: string[];
  action: Omit<HistoryAction, 'changes'>;
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
