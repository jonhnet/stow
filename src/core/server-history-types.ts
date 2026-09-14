import type { HistoryAction, HistoryState, LabelChange, LabelSettingState } from './history-types';
export type { HistoryBoundary } from './history-types';

export interface SavedVersionSummary {
  id: string; noteId: string; sourceIds: string[];
  timestamp: number; recordedAt: number; title: string; label: string;
  kind?: 'snapshot' | 'label';
  labelChange?: LabelChange;
  interval?: { start: number; end: number; actions: number };
}
export interface SavedVersion extends SavedVersionSummary { schema: 1; action?: HistoryAction; state: HistoryState; labelSettings?: Record<string, LabelSettingState> }
export interface HistoryPage { versions: SavedVersionSummary[]; nextCursor?: string; discardedAt?: number; error?: string }
export interface HistoryExport { schema: 1; versions: SavedVersion[]; discardedAt: Record<string, number> }
