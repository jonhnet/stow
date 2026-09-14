import type { Note, SourceNote } from './types';
import { orderComponentChecklist } from './checklist';

export type SourceTextRef = { sourceId: string; field: 'title' | 'body' };
export type TextRef = SourceTextRef | { sourceId: string; field: 'join'; joinId: string };
/** An authored arrangement of existing CRDT fields and editable joining text. */
export interface MergeRecipe {
  id: string; sourceIds: string[]; edgeIds: string[];
  title: SourceTextRef; body: TextRef[]; order: number;
}
type TextSources = Record<string, { title: string; body: string }>;
const key = (ref: TextRef) => JSON.stringify([ref.sourceId, ref.field, ref.field === 'join' ? ref.joinId : '']);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function textAt(sources: TextSources, ref: TextRef, joins: Record<string, string> = {}): string {
  const value = ref.field === 'join' ? joins[ref.joinId] : sources[ref.sourceId]?.[ref.field];
  if (typeof value !== 'string') throw new Error('This note composition refers to a missing text field.');
  return value;
}
export function composeText(sourceIds: string[], sources: TextSources, recipes: Record<string, MergeRecipe>, joins: Record<string, string> = {}) {
  if (!sourceIds.length) throw new Error('A note composition requires at least one source.');
  for (const id of sourceIds) { textAt(sources, { sourceId: id, field: 'title' }); textAt(sources, { sourceId: id, field: 'body' }); }
  const members = new Set(sourceIds);
  const ordered = Object.values(recipes).filter(recipe => recipe.sourceIds.some(id => members.has(id)))
    .sort((a, b) => b.order - a.order || compare(b.id, a.id));
  const sourceOrder = [...new Set([...ordered.flatMap(recipe => recipe.sourceIds).filter(id => members.has(id)), ...sourceIds])];
  const titleRef = ordered.map(recipe => recipe.title).find(ref => members.has(ref.sourceId)) ?? { sourceId: sourceOrder[0], field: 'title' as const };
  const seen = new Set([key(titleRef)]), bodyRefs: TextRef[] = [];
  const append = (ref: TextRef) => {
    // A recipe can straddle components after an edge is undone. Each source
    // remains visible in the component that still owns its stable identity.
    if (!members.has(ref.sourceId) || seen.has(key(ref))) return;
    textAt(sources, ref, joins); seen.add(key(ref)); bodyRefs.push(ref);
  };
  for (const recipe of ordered) { if (recipe !== ordered[0]) append(recipe.title); recipe.body.forEach(append); }
  for (const sourceId of sourceOrder) append({ sourceId, field: 'title' });
  for (const sourceId of sourceOrder) append({ sourceId, field: 'body' });
  const needsMaterialization = sourceIds.length > 1 && !ordered.length;
  const body = needsMaterialization
    ? sourceOrder.slice(1).map(id => sources[id].title).join('\n') + '\n\n' + sourceOrder.map(id => sources[id].body).join('\n\n')
    : bodyRefs.map(ref => textAt(sources, ref, joins)).join('');
  return { title: textAt(sources, titleRef), body, titleRef, bodyRefs, sourceOrder, needsMaterialization };
}

/** Common live/history view; source snapshots stay separate from this ordinary note. */
export function materializeNote(sourceIds: string[], sources: Record<string, SourceNote>, recipes: Record<string, MergeRecipe>, joins: Record<string, string> = {}): Note {
  const text = composeText(sourceIds, sources, recipes, joins), primary = sources[sourceIds[0]];
  const ordered = text.sourceOrder.map(id => sources[id]);
  const labels = [...new Set(ordered.flatMap(source => source.labels ?? []))];
  const items = orderComponentChecklist(ordered);
  return { id: primary.id, title: text.title, body: text.body,
    kind: ordered.some(source => source.kind === 'checklist') || items.length ? 'checklist' : 'text',
    color: primary.color, pinned: primary.pinned, archived: ordered.every(source => source.archived), trashed: ordered.every(source => source.trashed),
    createdAt: primary.createdAt, sortOrderDate: primary.sortOrderDate, updatedAt: Math.max(...ordered.map(source => source.updatedAt)),
    sourceIds, ...(labels.length ? { labels } : {}), items, images: ordered.flatMap(source => source.images) };
}
