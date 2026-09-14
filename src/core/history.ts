import type { HistoryPatch, HistoryState, SourceField } from './history-types';
import { textSplice } from './text-splice';

const fields: SourceField[] = ['kind', 'color', 'pinned', 'archived', 'trashed', 'createdAt', 'sortOrderDate', 'updatedAt'];
const ids = (a: object, b: object) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();

export function diffHistory(before: HistoryState, after: HistoryState): HistoryPatch[] {
  const patches: HistoryPatch[] = [];
  for (const sourceId of ids(before.sources, after.sources)) {
    const a = before.sources[sourceId], b = after.sources[sourceId];
    if (!a || !b) { patches.push({ op: 'source', sourceId, value: b ?? null }); continue; }
    if (a.unifiedChecklist !== b.unifiedChecklist) patches.push({ op: 'checklist-mode', sourceId, value: b.unifiedChecklist ?? null });
    for (const field of ['title', 'body'] as const) if (a[field] !== b[field]) patches.push({ op: 'text', sourceId, field, ...textSplice(a[field], b[field]) });
    for (const field of fields) {
      const old = field === 'sortOrderDate' ? a.sortOrderDate ?? a.createdAt : a[field];
      const value = field === 'sortOrderDate' ? b.sortOrderDate ?? b.createdAt : b[field];
      if (old !== value) patches.push({ op: 'set', sourceId, field, value: value! });
    }
    if (JSON.stringify(a.labels ?? []) !== JSON.stringify(b.labels ?? []) || JSON.stringify(a.labelGenerations ?? {}) !== JSON.stringify(b.labelGenerations ?? {})) {
      patches.push({ op: 'labels', sourceId, value: b.labels ?? [], ...(b.labelGenerations ? { generations: b.labelGenerations } : {}) });
    }
    for (const itemId of ids(a.items, b.items)) {
      const old = a.items[itemId], current = b.items[itemId];
      if (!old || !current) { patches.push({ op: 'item', sourceId, itemId, value: current ?? null }); continue; }
      if (old.text !== current.text) patches.push({ op: 'item-text', sourceId, itemId, ...textSplice(old.text, current.text) });
      if (old.checked !== current.checked) patches.push({ op: 'item-set', sourceId, itemId, field: 'checked', value: current.checked });
      if (old.rank !== current.rank) patches.push({ op: 'item-set', sourceId, itemId, field: 'rank', value: current.rank });
      if (old.parentId !== current.parentId) patches.push({ op: 'item-parent', sourceId, itemId, value: current.parentId ?? null });
    }
    for (const attachmentId of ids(a.images, b.images)) if (JSON.stringify(a.images[attachmentId]) !== JSON.stringify(b.images[attachmentId])) {
      patches.push({ op: 'image', sourceId, attachmentId, value: b.images[attachmentId] ?? null });
    }
  }
  if (JSON.stringify(before.groups) !== JSON.stringify(after.groups)) patches.push({ op: 'groups', value: after.groups });
  for (const recipeId of ids(before.recipes ?? {}, after.recipes ?? {})) if (JSON.stringify(before.recipes?.[recipeId]) !== JSON.stringify(after.recipes?.[recipeId])) {
    patches.push({ op: 'recipe', recipeId, value: after.recipes?.[recipeId] ?? null });
  }
  for (const joinId of ids(before.joins ?? {}, after.joins ?? {})) {
    const old = before.joins?.[joinId], current = after.joins?.[joinId];
    if (old === current) continue;
    if (old === undefined || current === undefined) patches.push({ op: 'join', joinId, value: current ?? null });
    else patches.push({ op: 'join-text', joinId, ...textSplice(old, current) });
  }
  return patches;
}

function textPatch(value: string, patch: { index: number; remove: number; insert: string }) {
  if (!Number.isInteger(patch.index) || !Number.isInteger(patch.remove) || patch.index < 0 || patch.remove < 0 || patch.index + patch.remove > value.length) throw new Error('This history entry contains an invalid text change.');
  return value.slice(0, patch.index) + patch.insert + value.slice(patch.index + patch.remove);
}

/** Pure reconstruction with structural sharing. Neither the record nor its base is mutated. */
export function applyHistory(base: HistoryState, patches: HistoryPatch[]): HistoryState {
  const state: HistoryState = { ...base, sources: { ...base.sources } };
  const copied = new Set<string>();
  let copiedJoins = false;
  for (const patch of patches) {
    if (patch.op === 'groups') { state.groups = patch.value; continue; }
    if (patch.op === 'recipe') {
      const recipes = { ...state.recipes };
      if (patch.value) recipes[patch.recipeId] = patch.value; else delete recipes[patch.recipeId];
      if (Object.keys(recipes).length) state.recipes = recipes; else delete state.recipes;
      continue;
    }
    if (patch.op === 'join' || patch.op === 'join-text') {
      if (!copiedJoins) { state.joins = { ...state.joins }; copiedJoins = true; }
      const joins = state.joins!;
      if (patch.op === 'join') {
        if (patch.value === null) delete joins[patch.joinId]; else joins[patch.joinId] = patch.value;
      } else {
        if (joins[patch.joinId] === undefined) throw new Error('This history entry refers to a missing text join.');
        joins[patch.joinId] = textPatch(joins[patch.joinId], patch);
      }
      continue;
    }
    const id = patch.sourceId;
    if (patch.op === 'source') {
      if (patch.value) state.sources[id] = patch.value; else delete state.sources[id];
      copied.delete(id); continue;
    }
    if (!state.sources[id]) throw new Error('This history entry refers to a missing source note.');
    if (!copied.has(id)) {
      const source = state.sources[id];
      state.sources[id] = { ...source, items: { ...source.items }, images: { ...source.images } };
      copied.add(id);
    }
    const source = state.sources[id];
    switch (patch.op) {
      case 'checklist-mode':
        if (patch.value === null) delete source.unifiedChecklist;
        else source.unifiedChecklist = patch.value;
        break;
      case 'set': Object.assign(source, { [patch.field]: patch.value }); break;
      case 'text': source[patch.field] = textPatch(source[patch.field], patch); break;
      case 'item': if (patch.value) source.items[patch.itemId] = patch.value; else delete source.items[patch.itemId]; break;
      case 'item-set': {
        const item = source.items[patch.itemId];
        if (!item) throw new Error('This history entry refers to a missing checklist item.');
        source.items[patch.itemId] = { ...item, [patch.field]: patch.value }; break;
      }
      case 'item-parent': {
        const item = source.items[patch.itemId];
        if (!item) throw new Error('This history entry refers to a missing checklist item.');
        if (patch.value === null) {
          const { parentId: _parentId, ...root } = item;
          source.items[patch.itemId] = root;
        } else source.items[patch.itemId] = { ...item, parentId: patch.value };
        break;
      }
      case 'item-text': {
        const item = source.items[patch.itemId];
        if (!item) throw new Error('This history entry refers to a missing checklist item.');
        source.items[patch.itemId] = { ...item, text: textPatch(item.text, patch) }; break;
      }
      case 'image': if (patch.value) source.images[patch.attachmentId] = patch.value; else delete source.images[patch.attachmentId]; break;
      case 'labels':
        source.labels = patch.value;
        if (patch.generations) source.labelGenerations = patch.generations;
        else delete source.labelGenerations;
        break;
    }
  }
  if (copiedJoins && !Object.keys(state.joins!).length) delete state.joins;
  return state;
}

/** Remove permanently erased source content from a self-contained snapshot. */
export function redactHistoryState(state: HistoryState, excluded: { has(id: string): boolean }): HistoryState {
  const recipes = Object.fromEntries(Object.entries(state.recipes ?? {}).flatMap(([id, recipe]) => {
    const members = recipe.sourceIds.filter(sourceId => !excluded.has(sourceId));
    return members.length ? [[id, { ...recipe, sourceIds: members,
      title: excluded.has(recipe.title.sourceId) ? { sourceId: members[0], field: 'title' as const } : recipe.title,
      body: recipe.body.filter(ref => !excluded.has(ref.sourceId)) }]] : [];
  }));
  const joins = new Set(Object.values(recipes).flatMap(recipe => recipe.body.flatMap(ref => ref.field === 'join' ? [ref.joinId] : [])));
  return { sources: Object.fromEntries(Object.entries(state.sources).filter(([id]) => !excluded.has(id))),
    groups: state.groups.map(group => group.filter(id => !excluded.has(id))).filter(group => group.length),
    ...(Object.keys(recipes).length ? { recipes } : {}),
    ...(joins.size ? { joins: Object.fromEntries(Object.entries(state.joins ?? {}).filter(([id]) => joins.has(id))) } : {}) };
}
