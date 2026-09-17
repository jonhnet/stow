export type NoteKind = 'text' | 'checklist';
export type NoteColor = 'default' | 'coral' | 'peach' | 'sand' | 'mint' | 'sage' | 'fog' | 'storm' | 'dusk' | 'blossom' | 'clay' | 'gray';
export interface Label { name: string; color: NoteColor }
export interface Item { id: string; noteId: string; text: string; checked: boolean; rank: number; parentId?: string }
export interface Attachment {
  id: string; noteId: string; hash: string; name: string; type: string; size: number;
  /** Position within its source note. Older attachments have no stored position. */
  order?: number;
}
export interface Section { id: string; title: string; body: string; kind: NoteKind; items: Item[]; images: Attachment[]; labels?: string[] }
export interface SourceNote extends Section { color: NoteColor; pinned: boolean; archived: boolean; trashed: boolean; createdAt: number; sortOrderDate: number; updatedAt: number; unifiedChecklist?: boolean }
export interface Note extends Omit<SourceNote, 'unifiedChecklist'> { sourceIds: string[] }
export type { HistoryAction } from './history-types';
export type SyncStatus = 'connecting' | 'online' | 'offline' | 'locked' | 'error' | 'demo';
