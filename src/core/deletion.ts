import * as Y from 'yjs';
import type { Attachment } from './types';
import type { MergeRecipe } from './merged-text';
import { assertCurrentSchema } from './current-schema';

/** This origin is deliberately outside the local UndoManager's tracked origins. */
export const PERMANENT_DELETION_ORIGIN = Symbol('permanent-deletion');
export const getPermanentDeletionBlobCandidates = (doc: Y.Doc) => new Set(doc.getMap<true>('deletedBlobCandidates').keys());

/** Small, content-free identities survive deletion so old offline updates cannot
 * reintroduce a source or separator. Saved versions live only on the server. */
export function enforcePermanentDeletions(doc: Y.Doc, transaction?: Y.Transaction): boolean {
  assertCurrentSchema(doc);
  const deleted = doc.getMap<true>('deletedNotes');
  if (!deleted.size) return false;
  const notes = doc.getMap<Y.Map<any>>('notes'), items = doc.getMap<Y.Map<any>>('items');
  const attachments = doc.getMap<Attachment>('attachments');
  const recipes = doc.getMap<MergeRecipe>('mergeRecipes'), joins = doc.getMap<Y.Text>('textJoins');
  const joinSources = doc.getMap<string>('textJoinSources'), deletedJoins = doc.getMap<true>('deletedTextJoins');
  const candidates = doc.getMap<true>('deletedBlobCandidates');
  const full = !transaction || transaction.changed.has(deleted as Y.AbstractType<any>);
  const entries = <T>(map: Y.Map<T>): [string, T][] => {
    if (full) return [...map];
    const ids = new Set<string>();
    for (const event of transaction.changedParentTypes.get(map as Y.AbstractType<any>) ?? []) {
      if (event.target === map && event instanceof Y.YMapEvent) for (const id of event.keysChanged) ids.add(id);
      else if (typeof event.path[0] === 'string') ids.add(event.path[0]);
    }
    return [...ids].flatMap(id => { const value = map.get(id); return value === undefined ? [] : [[id, value]]; });
  };
  let changed = false;
  let discoveredJoin = false;
  const remove = (map: { has(id: string): boolean; delete(id: string): unknown }, id: string) => { if (map.has(id)) { map.delete(id); changed = true; } };
  const put = <T>(map: { get(id: string): T | undefined; set(id: string, value: T): unknown }, id: string, value: T) => {
    if (JSON.stringify(map.get(id)) !== JSON.stringify(value)) { map.set(id, value); changed = true; }
  };
  const image = (attachment: Attachment) => { if (deleted.has(attachment.noteId)) put(candidates, attachment.hash, true); };
  const inspectRecipe = (recipe: MergeRecipe) => {
    for (const ref of recipe.body) if (ref.field === 'join' && deleted.has(ref.sourceId)) {
      discoveredJoin ||= !deletedJoins.has(ref.joinId); put(deletedJoins, ref.joinId, true);
    }
  };
  const cleanRecipe = (recipe: MergeRecipe): MergeRecipe | null => {
    const sourceIds = recipe.sourceIds.filter(id => !deleted.has(id));
    if (!sourceIds.length) return null;
    if (sourceIds.length === recipe.sourceIds.length) return recipe;
    return { ...recipe, sourceIds, title: deleted.has(recipe.title.sourceId) ? { sourceId: sourceIds[0], field: 'title' } : recipe.title,
      body: recipe.body.filter(ref => !deleted.has(ref.sourceId)) };
  };

  doc.transact(() => {
    // Discover ownership before removing recipes. Separator allocation
    // can arrive before its recipe, so new joins also carry explicit ownership.
    for (const [id, sourceId] of entries(joinSources)) if (deleted.has(sourceId)) {
      discoveredJoin ||= !deletedJoins.has(id); put(deletedJoins, id, true);
    }
    for (const [, recipe] of entries(recipes)) inspectRecipe(recipe);
    for (const [id, note] of entries(notes)) if (deleted.has(id)) {
      const takeout = note.get('takeout');
      if (typeof takeout?.rawHash === 'string') put(candidates, takeout.rawHash, true);
      remove(notes, id);
    }
    for (const [id, item] of entries(items)) if (deleted.has(item.get('noteId'))) remove(items, id);
    for (const [id, attachment] of entries(attachments)) if (deleted.has(attachment.noteId)) { image(attachment); remove(attachments, id); }
    // Merge edges carry only source IDs. Keep their original Yjs identities so
    // surviving members remain connected and a delayed undo still removes the
    // authored edge, rather than an independently rewritten replacement edge.
    for (const [id, recipe] of entries(recipes)) { const kept = cleanRecipe(recipe); if (kept) put(recipes, id, kept); else remove(recipes, id); }
    const joinIds = full || discoveredJoin ? [...deletedJoins.keys()] : [...new Set([...entries(joins).map(([id]) => id), ...entries(deletedJoins).map(([id]) => id)])];
    for (const id of joinIds) if (deletedJoins.has(id)) { remove(joins, id); remove(joinSources, id); }

  }, PERMANENT_DELETION_ORIGIN);
  return changed;
}

/** Install before application subscribers so received edits are purged in the
 * same synchronous update turn. The Rust server enforces the same deletion rules. */
export function installPermanentDeletionGuard(doc: Y.Doc, beforeCleanup?: () => void): () => void {
  let cleaning = false;
  const enforce = (transaction?: Y.Transaction) => {
    if (cleaning || transaction?.origin === PERMANENT_DELETION_ORIGIN || !doc.getMap('deletedNotes').size) return;
    cleaning = true;
    try {
      if (!transaction || transaction.changed.has(doc.getMap('deletedNotes') as Y.AbstractType<any>)) beforeCleanup?.();
      enforcePermanentDeletions(doc, transaction);
    }
    finally { cleaning = false; }
  };
  enforce();
  doc.on('afterTransaction', enforce);
  return () => doc.off('afterTransaction', enforce);
}
