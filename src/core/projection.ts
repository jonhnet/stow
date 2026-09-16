import * as Y from 'yjs';
import type { Attachment, Item, Note, SourceNote } from './types';
import type { HistoryItem, HistorySource, HistoryState } from './history-types';
import { orderChecklistItems } from './checklist';
import { compareAttachmentOrder } from './attachments';
import { effectiveLabels, hasLabelRecord, type LabelLifecycle } from './labels';
import { notePlacement } from './note-order';
import { composeText, materializeNote, type MergeRecipe } from './merged-text';
import { coalesceConversions, type ConversionItem } from './converted-checklist';
import { visibleText } from './converted-text';

type RecordMap = Y.Map<any>;
type SourceView = SourceNote;

/** Disposable indexes. Each edit invalidates its source/component, never every checklist. */
export class VaultProjection {
  version = 0;
  private itemOwners = new Map<string, string>();
  private imageOwners = new Map<string, string>();
  private itemsBySource = new Map<string, Set<string>>();
  private imagesBySource = new Map<string, Set<string>>();
  private itemViews = new Map<string, Item[]>();
  private itemRecords = new Map<string, ConversionItem>();
  private itemConversions = new Map<string, string>();
  private conversionItems = new Map<string, Set<string>>();
  private historyItems = new WeakMap<Item, HistoryItem>();
  private historyItemMaps = new WeakMap<Item[], Record<string, HistoryItem>>();
  private historySources = new WeakMap<SourceView, HistorySource>();
  private sourceViews = new Map<string, SourceView>();
  private noteViews = new Map<string, Note>();
  private sourceGroup = new Map<string, string>();
  private groups = new Map<string, string[]>();
  private orderedGroups: string[] = [];
  private groupsDirty = true;
  private orderDirty = true;
  private list?: Note[];
  private cleanups: (() => void)[] = [];

  constructor(private notes: Y.Map<RecordMap>, private items: Y.Map<RecordMap>, private attachments: Y.Map<Attachment>, private merges: Y.Map<{ a: string; b: string }>, private labelLifecycle: Y.Map<LabelLifecycle>, private recipes: Y.Map<MergeRecipe>, private joins: Y.Map<Y.Text>) {
    for (const id of items.keys()) this.itemChanged(id);
    for (const id of attachments.keys()) this.imageChanged(id);
    const affected = (events: Y.YEvent<any>[], root: Y.AbstractType<any>) => {
      const ids = new Set<string>();
      for (const event of events) {
        if (event.target === root && event instanceof Y.YMapEvent) for (const id of event.keysChanged) ids.add(id);
        else if (typeof event.path[0] === 'string') ids.add(event.path[0]);
      }
      return ids;
    };
    const onNotes = (events: Y.YEvent<any>[]) => {
      for (const event of events) if (event.target === notes || (event instanceof Y.YMapEvent && event.keysChanged.has('createdAt'))) this.groupsDirty = true;
      for (const event of events) if (event instanceof Y.YMapEvent && event.keysChanged.has('placement')) this.orderDirty = true;
      for (const id of affected(events, notes)) this.sourceChanged(id);
    };
    const onItems = (events: Y.YEvent<any>[]) => { for (const id of affected(events, items)) this.itemChanged(id); };
    const onImages = (event: Y.YMapEvent<Attachment>) => { for (const id of event.keysChanged) this.imageChanged(id); };
    const onMerges = (event: Y.YMapEvent<{ a: string; b: string }>) => {
      const sources = [...event.changes.keys].flatMap(([id, change]) => [change.oldValue, merges.get(id)].filter(Boolean).flatMap(edge => [edge.a, edge.b]));
      for (const id of sources.flatMap(id => this.sourceIds(id))) { this.itemViews.delete(id); this.sourceViews.delete(id); }
      this.compositionChanged(sources); this.membershipChanged();
    };
    const onRecipes = (event: Y.YMapEvent<MergeRecipe>) => {
      const sources = [...event.changes.keys].flatMap(([id, change]) => [change.oldValue, recipes.get(id)].filter(Boolean).flatMap(recipe => recipe.sourceIds));
      this.compositionChanged(sources);
    };
    const onJoins = (events: Y.YEvent<any>[]) => {
      const changed = affected(events, joins);
      for (const recipe of recipes.values()) if (recipe.body.some(ref => ref.field === 'join' && changed.has(ref.joinId))) this.compositionChanged(recipe.sourceIds);
    };
    const onLabels = (event: Y.YMapEvent<LabelLifecycle>) => this.labelsChanged(event.keysChanged);
    const deletedNotes = notes.doc!.getMap<true>('deletedNotes');
    const onDeletedNotes = () => { this.noteViews.clear(); this.membershipChanged(); };
    notes.observeDeep(onNotes); items.observeDeep(onItems); attachments.observe(onImages); merges.observe(onMerges);
    labelLifecycle.observe(onLabels);
    recipes.observe(onRecipes);
    joins.observeDeep(onJoins);
    deletedNotes.observe(onDeletedNotes);
    this.cleanups = [() => notes.unobserveDeep(onNotes), () => items.unobserveDeep(onItems), () => attachments.unobserve(onImages), () => merges.unobserve(onMerges), () => labelLifecycle.unobserve(onLabels), () => recipes.unobserve(onRecipes), () => joins.unobserveDeep(onJoins), () => deletedNotes.unobserve(onDeletedNotes)];
  }

  sourceChanged(id: string, membership = false, placement = false) {
    this.sourceViews.delete(id);
    const group = this.sourceGroup.get(id); if (group) this.noteViews.delete(group);
    if (membership) this.groupsDirty = true;
    if (placement) this.orderDirty = true;
    this.list = undefined; this.version++;
  }
  compositionChanged(ids: Iterable<string>) {
    for (const id of ids) this.noteViews.delete(this.sourceGroup.get(id) ?? id);
    this.list = undefined; this.version++;
  }
  membershipChanged() { this.groupsDirty = true; this.list = undefined; this.version++; }
  labelsChanged(names: Iterable<string>) {
    const changed = [...names];
    for (const [id, note] of this.notes) if (changed.some(name => hasLabelRecord(note, name))) this.sourceChanged(id);
  }
  private ownerChange(id: string, owner: string | undefined, owners: Map<string, string>, bySource: Map<string, Set<string>>) {
    const previous = owners.get(id);
    if (previous !== undefined) { bySource.get(previous)?.delete(id); this.itemViews.delete(previous); this.sourceChanged(previous); }
    if (owner === undefined) owners.delete(id);
    else {
      owners.set(id, owner);
      let set = bySource.get(owner); if (!set) bySource.set(owner, set = new Set()); set.add(id);
      this.itemViews.delete(owner); this.sourceChanged(owner);
    }
  }
  itemChanged(id: string) {
    const old = this.itemConversions.get(id), key = this.items.get(id)?.get('conversion')?.source as string | undefined;
    const owners = new Set([this.itemOwners.get(id), this.items.get(id)?.get('noteId')].filter((id): id is string => !!id));
    if (old) { this.conversionItems.get(old)?.delete(id); this.itemConversions.delete(id); }
    if (key) {
      let set = this.conversionItems.get(key); if (!set) this.conversionItems.set(key, set = new Set());
      set.add(id); this.itemConversions.set(id, key);
    }
    this.itemRecords.delete(id); this.ownerChange(id, this.items.get(id)?.get('noteId'), this.itemOwners, this.itemsBySource);
    // A different representative can change parent aliases in another source
    // of this merged note, even when that source's own records did not change.
    if (old || key) for (const owner of owners) for (const source of this.sourceIds(owner)) {
      this.itemViews.delete(source); this.sourceChanged(source);
    }
  }
  imageChanged(id: string) { this.ownerChange(id, this.attachments.get(id)?.noteId, this.imageOwners, this.imagesBySource); }
  sourceItems(id: string): Item[] {
    const cached = this.itemViews.get(id); if (cached) return cached;
    const result: ConversionItem[] = [], selected = new Set(this.itemsBySource.get(id));
    const members = new Set(this.sourceIds(id));
    for (const itemId of selected) {
      const item = this.items.get(itemId);
      for (const key of [this.itemConversions.get(itemId), this.itemConversions.get(item?.get('parentId'))]) {
        if (key) for (const candidate of this.conversionItems.get(key) ?? []) {
          if (members.has(this.itemOwners.get(candidate)!)) selected.add(candidate);
        }
      }
    }
    for (const itemId of selected) {
      const cached = this.itemRecords.get(itemId);
      if (cached) { result.push(cached); continue; }
      const item = this.items.get(itemId);
      if (item && item.get('text')) {
        const view = { id: itemId, noteId: item.get('noteId'), text: item.get('text').toString(), checked: !!item.get('checked'), deleted: !!item.get('deleted'), conversion: item.get('conversion'), rank: Number(item.get('rank')) || 0, ...(typeof item.get('parentId') === 'string' && item.get('parentId') ? { parentId: item.get('parentId') } : {}) };
        this.itemRecords.set(itemId, view); result.push(view);
      }
    }
    const ordered = orderChecklistItems(coalesceConversions(result).filter(item => item.noteId === id));
    this.itemViews.set(id, ordered); return ordered;
  }
  source(id: string): SourceView | undefined {
    const cached = this.sourceViews.get(id); if (cached) return cached;
    const note = this.notes.get(id); if (!note) return undefined;
    const labels = effectiveLabels(note, this.labelLifecycle);
    const source: SourceView = {
      id, title: note.get('title') ? visibleText(note.get('title'), note, 'title') : '', body: note.get('body') ? visibleText(note.get('body'), note, 'body') : '', kind: note.get('kind') ?? 'text',
      color: note.get('color') ?? 'default', ...notePlacement(note), archived: !!note.get('archived'), trashed: !!note.get('trashed'),
      createdAt: note.get('createdAt') ?? 0, updatedAt: note.get('updatedAt') ?? 0,
      ...(labels.length ? { labels } : {}),
      ...(note.has('unifiedChecklist') ? { unifiedChecklist: !!note.get('unifiedChecklist') } : {}),
      items: this.sourceItems(id), images: [...(this.imagesBySource.get(id) ?? [])].map(imageId => this.attachments.get(imageId)!).filter(Boolean).sort((a, b) => compareAttachmentOrder(a, b) || a.id.localeCompare(b.id)),
    };
    this.sourceViews.set(id, source); return source;
  }
  private compareSource = (a: string, b: string) => Number(this.notes.get(a)?.get('createdAt') ?? 0) - Number(this.notes.get(b)?.get('createdAt') ?? 0) || a.localeCompare(b);
  private ensureGroups() {
    if (!this.groupsDirty) return;
    this.groupsDirty = false;
    const deleted = this.notes.doc!.getMap<true>('deletedNotes');
    const parents = new Map([...this.notes.keys(), ...deleted.keys()].map(id => [id, id]));
    const root = (id: string): string => { let result = id; while (parents.get(result) !== result) result = parents.get(result)!; while (parents.get(id) !== id) { const next = parents.get(id)!; parents.set(id, result); id = next; } return result; };
    for (const { a, b } of this.merges.values()) if (parents.has(a) && parents.has(b)) parents.set(root(b), root(a));
    const grouped = new Map<string, string[]>();
    for (const id of this.notes.keys()) { const key = root(id); let group = grouped.get(key); if (!group) grouped.set(key, group = []); group.push(id); }
    const next = new Map<string, string[]>();
    this.sourceGroup.clear();
    for (const group of grouped.values()) {
      group.sort(this.compareSource);
      const previous = this.groups.get(group[0]);
      const same = previous?.length === group.length && previous.every((id, index) => id === group[index]);
      next.set(group[0], same ? previous : group);
      if (!same) this.noteViews.delete(group[0]);
      for (const id of group) this.sourceGroup.set(id, group[0]);
    }
    for (const id of this.groups.keys()) if (!next.has(id)) this.noteViews.delete(id);
    this.groups = next;
    this.orderDirty = true;
    this.list = undefined;
  }
  sourceIds(id: string): string[] { this.ensureGroups(); const group = this.sourceGroup.get(id); return group ? this.groups.get(group)! : []; }
  activeRecipes(sourceIds: string[]): Record<string, MergeRecipe> {
    const members = new Set(sourceIds);
    const deleted = this.notes.doc!.getMap<true>('deletedNotes');
    return Object.fromEntries([...this.recipes].filter(([, recipe]) => recipe.edgeIds.some(id => {
      const edge = this.merges.get(id);
      return edge && (members.has(edge.a) || deleted.has(edge.a)) && (members.has(edge.b) || deleted.has(edge.b)) && recipe.sourceIds.some(sourceId => members.has(sourceId));
    })));
  }
  text(id: string) {
    const sourceIds = this.sourceIds(id);
    const recipes = this.activeRecipes(sourceIds);
    return composeText(sourceIds, Object.fromEntries(sourceIds.map(sourceId => [sourceId, this.source(sourceId)!])), recipes, this.joinState(recipes));
  }
  private joinState(recipes: Record<string, MergeRecipe>): Record<string, string> {
    return Object.fromEntries(Object.values(recipes).flatMap(recipe => recipe.body.flatMap(ref => {
      if (ref.field !== 'join') return [];
      const text = this.joins.get(ref.joinId);
      if (!(text instanceof Y.Text)) throw new Error('This note composition refers to missing joining text.');
      return [[ref.joinId, visibleText(text, this.notes.get(ref.sourceId)!, 'join', ref.joinId)]];
    })));
  }
  getItems(id: string): Item[] { return this.getNote(id)?.items ?? []; }
  getNote(id: string): Note | undefined {
    this.ensureGroups();
    const key = this.sourceGroup.get(id); if (!key) return undefined;
    const cached = this.noteViews.get(key); if (cached) return cached;
    const sourceIds = this.groups.get(key)!;
    const sources = Object.fromEntries(sourceIds.map(sourceId => [sourceId, this.source(sourceId)!]));
    const recipes = this.activeRecipes(sourceIds);
    const note = materializeNote(sourceIds, sources, recipes, this.joinState(recipes));
    this.noteViews.set(key, note); return note;
  }
  getNotes(): Note[] {
    this.ensureGroups();
    if (this.orderDirty) {
      this.orderedGroups = [...this.groups.keys()].sort((a, b) => notePlacement(this.notes.get(b)!).sortOrderDate - notePlacement(this.notes.get(a)!).sortOrderDate || this.compareSource(b, a));
      this.orderDirty = false; this.list = undefined;
    }
    return this.list ??= this.orderedGroups.map(id => this.getNote(id)!);
  }

  /** Capture only affected components. Sources are normalized once for history. */
  state(ids: Iterable<string>): HistoryState {
    this.ensureGroups();
    const selected = new Set<string>();
    for (const id of ids) for (const sourceId of this.sourceIds(id)) selected.add(sourceId);
    const sources: Record<string, HistorySource> = {};
    const selectedGroups = new Set<string>();
    for (const id of selected) {
      const source = this.source(id); if (!source) continue;
      const cached = this.historySources.get(source);
      if (cached) { sources[id] = cached; selectedGroups.add(this.sourceGroup.get(id)!); continue; }
      const labelGenerations = Object.fromEntries((source.labels ?? []).flatMap(name => {
        const lifecycle = this.labelLifecycle.get(name);
        return lifecycle ? [[name, lifecycle.generation]] : [];
      }));
      let items = this.historyItemMaps.get(source.items);
      if (!items) {
        items = Object.fromEntries(source.items.map(item => {
          let saved = this.historyItems.get(item);
          if (!saved) { const { text, checked, rank, parentId } = item; saved = { text, checked, rank, ...(parentId ? { parentId } : {}) }; this.historyItems.set(item, saved); }
          return [item.id, saved];
        }));
        this.historyItemMaps.set(source.items, items);
      }
      sources[id] = {
        title: source.title, body: source.body, kind: source.kind, color: source.color,
        pinned: source.pinned, archived: source.archived, trashed: source.trashed, createdAt: source.createdAt, sortOrderDate: source.sortOrderDate, updatedAt: source.updatedAt,
        ...(source.unifiedChecklist !== undefined ? { unifiedChecklist: source.unifiedChecklist } : {}),
        ...(source.labels?.length ? { labels: source.labels } : {}),
        ...(Object.keys(labelGenerations).length ? { labelGenerations } : {}),
        items,
        images: Object.fromEntries(source.images.map(image => [image.id, image])),
      };
      this.historySources.set(source, sources[id]);
      selectedGroups.add(this.sourceGroup.get(id)!);
    }
    const recipes = this.activeRecipes([...selected]);
    const joins = this.joinState(recipes);
    return { sources, groups: [...selectedGroups].sort(this.compareSource).map(id => this.groups.get(id)!), ...(Object.keys(recipes).length ? { recipes } : {}), ...(Object.keys(joins).length ? { joins } : {}) };
  }
  destroy() { this.cleanups.forEach(cleanup => cleanup()); }
}
