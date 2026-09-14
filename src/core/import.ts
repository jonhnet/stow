import * as Y from 'yjs';
import type { Attachment, Item, NoteColor, NoteKind } from './types';
import type { Vault } from './vault';
import { generationMembershipKey } from './labels';

export interface TakeoutProvenance {
  sourcePath: string;
  rawHash: string;
  labels: string[];
}

/** IDs and timestamps are assigned by the importer, before applying this batch. */
export interface ImportedNote {
  id: string;
  title: string;
  body: string;
  kind: NoteKind;
  color: NoteColor;
  pinned: boolean;
  archived: boolean;
  trashed: boolean;
  createdAt: number;
  updatedAt: number;
  items: Item[];
  images: Attachment[];
  labels?: string[];
  takeout?: TakeoutProvenance;
}

export interface ImportOptions {
  id: string;
  manifestHash: string;
  notes: ImportedNote[];
  replaceSourceIds: string[];
}

export interface ImportResult {
  status: 'applied' | 'already-applied';
  added: number;
  removed: number;
}

interface ImportReceipt { manifestHash: string; added: number; removed: number }

const colors = new Set<NoteColor>(['default', 'coral', 'peach', 'sand', 'mint', 'sage', 'fog', 'storm', 'dusk', 'blossom', 'clay', 'gray']);
const hash = /^[a-f0-9]{64}$/;

function requireValue(valid: unknown, message: string): asserts valid {
  if (!valid) throw new Error(`Invalid import: ${message}`);
}

function string(value: unknown, field: string, nonempty = false): asserts value is string {
  requireValue(typeof value === 'string' && (!nonempty || value.length > 0), `${field} must be ${nonempty ? 'a nonempty string' : 'a string'}`);
  // Yjs uses UTF-8 on the wire. Reject malformed UTF-16 instead of changing text on reload.
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      requireValue(next >= 0xdc00 && next <= 0xdfff, `${field} contains an unpaired surrogate`);
    } else requireValue(unit < 0xdc00 || unit > 0xdfff, `${field} contains an unpaired surrogate`);
  }
}

function unique(value: unknown, seen: Set<string>, field: string): asserts value is string {
  string(value, field, true);
  requireValue(!seen.has(value), `duplicate ${field}`);
  seen.add(value);
}

/**
 * Apply an explicit import to the existing document. Root deletions retain Yjs
 * tombstones, so stale edits to discarded sources cannot restore their content.
 * Existing revisions are retained for recovery; no imported edit history is invented.
 * Callers upload blobs first and persist the resulting update through normal sync.
 */
export function applyImport(vault: Vault, options: ImportOptions): ImportResult {
  requireValue(options && typeof options === 'object', 'options are required');
  string(options.id, 'operation id', true);
  requireValue(typeof options.manifestHash === 'string' && hash.test(options.manifestHash), 'manifestHash must be a lowercase SHA-256 hash');
  const receipts = vault.doc.getMap<ImportReceipt>('imports');
  const previous = receipts.get(options.id);
  if (previous) {
    requireValue(previous.manifestHash === options.manifestHash, 'operation id already belongs to a different manifest');
    return { status: 'already-applied', added: previous.added, removed: previous.removed };
  }

  requireValue(Array.isArray(options.notes), 'notes must be an array');
  requireValue(Array.isArray(options.replaceSourceIds), 'replaceSourceIds must be an array');
  const replacements = new Set<string>();
  for (const id of options.replaceSourceIds) {
    unique(id, replacements, 'replacement source id');
    requireValue(vault.notes.has(id), 'replacement source does not exist');
  }
  // A saved plan may predate a later merge. Do not broaden its deletion set or
  // remove the joining text that belongs to the unreplaced part of that note.
  const checkedNotes = new Set<string>();
  for (const id of replacements) {
    const note = vault.getNote(id)!;
    if (checkedNotes.has(note.id)) continue;
    checkedNotes.add(note.id);
    requireValue(note.sourceIds.every(sourceId => replacements.has(sourceId)), 'replacement must include the whole connected note; regenerate and review the import plan');
  }
  const noteIds = new Set<string>(), itemIds = new Set<string>(), imageIds = new Set<string>();
  for (const note of options.notes) {
    requireValue(note && typeof note === 'object', 'note must be an object');
    unique(note.id, noteIds, 'note id');
    requireValue(!vault.notes.has(note.id) || replacements.has(note.id), 'note id already exists outside the replacement');
    string(note.title, 'note title'); string(note.body, 'note body');
    requireValue(note.kind === 'text' || note.kind === 'checklist', 'note kind is unsupported');
    requireValue(colors.has(note.color), 'note color is unsupported');
    for (const field of ['pinned', 'archived', 'trashed'] as const) requireValue(typeof note[field] === 'boolean', `${field} must be a boolean`);
    for (const field of ['createdAt', 'updatedAt'] as const) requireValue(Number.isSafeInteger(note[field]), `${field} must be an integer timestamp in milliseconds`);
    requireValue(Array.isArray(note.items), 'items must be an array');
    requireValue(Array.isArray(note.images), 'images must be an array');
    if (note.labels !== undefined) {
      requireValue(Array.isArray(note.labels), 'labels must be an array');
      for (const label of note.labels) string(label, 'label');
    }
    for (const item of note.items) {
      requireValue(item && typeof item === 'object', 'item must be an object');
      unique(item.id, itemIds, 'item id');
      requireValue(item.noteId === note.id, 'item noteId must match its source');
      string(item.text, 'item text');
      requireValue(typeof item.checked === 'boolean', 'item checked must be a boolean');
      requireValue(Number.isFinite(item.rank), 'item rank must be finite');
      if (item.parentId !== undefined) string(item.parentId, 'item parentId', true);
      const existing = vault.items.get(item.id);
      requireValue(!existing || replacements.has(existing.get('noteId')), 'item id already exists outside the replacement');
    }
    const parents = new Map(note.items.map(item => [item.id, item]));
    for (const item of note.items) if (item.parentId) {
      const parent = parents.get(item.parentId);
      requireValue(parent && parent.id !== item.id && !parent.parentId, 'item parent must be a different root in the same source');
    }
    for (const image of note.images) {
      requireValue(image && typeof image === 'object', 'image must be an object');
      unique(image.id, imageIds, 'image id');
      requireValue(image.noteId === note.id, 'image noteId must match its source');
      requireValue(typeof image.hash === 'string' && hash.test(image.hash), 'image hash must be a lowercase SHA-256 hash');
      string(image.name, 'image name'); string(image.type, 'image type', true);
      requireValue(Number.isSafeInteger(image.size) && image.size >= 0, 'image size must be a nonnegative integer');
      if (image.order !== undefined) requireValue(Number.isSafeInteger(image.order) && image.order >= 0, 'image order must be a nonnegative safe integer');
      const existing = vault.attachments.get(image.id);
      requireValue(!existing || replacements.has(existing.noteId), 'image id already exists outside the replacement');
    }
    if (note.takeout !== undefined) {
      requireValue(note.takeout && typeof note.takeout === 'object', 'takeout provenance must be an object');
      string(note.takeout.sourcePath, 'Takeout source path', true);
      requireValue(typeof note.takeout.rawHash === 'string' && hash.test(note.takeout.rawHash), 'Takeout rawHash must be a lowercase SHA-256 hash');
      requireValue(Array.isArray(note.takeout.labels), 'Takeout labels must be an array');
      for (const label of note.takeout.labels) string(label, 'Takeout label');
    }
  }

  // Complete validation and construct detached records before touching the document:
  // Yjs transactions are atomic observations, but cannot roll back a thrown exception.
  const prepared = options.notes.map(note => ({
    id: note.id,
    record: new Y.Map<unknown>([
      ['title', new Y.Text(note.title)], ['body', new Y.Text(note.body)],
      ['kind', note.kind], ['color', note.color], ['placement', { pinned: note.pinned, sortOrderDate: note.createdAt }], ['archived', note.archived], ['trashed', note.trashed],
      ['createdAt', note.createdAt], ['updatedAt', note.updatedAt],
      ...(note.labels?.length ? [['labels', note.labels.filter(name => !vault.labelLifecycle.has(name))] as [string, unknown]] : []),
      ...(note.labels ?? []).flatMap(name => {
        const lifecycle = vault.labelLifecycle.get(name);
        return lifecycle ? [[generationMembershipKey(name, lifecycle.generation), true] as [string, unknown]] : [];
      }),
      ...(note.takeout ? [['takeout', { sourcePath: note.takeout.sourcePath, rawHash: note.takeout.rawHash, labels: [...note.takeout.labels] }] as [string, unknown]] : []),
    ]),
    items: note.items.map(item => ({ id: item.id, record: new Y.Map<unknown>([
      ['noteId', item.noteId], ['text', new Y.Text(item.text)], ['checked', item.checked], ['deleted', false], ['parentId', item.parentId ?? null], ['rank', item.rank],
    ]) })),
    images: note.images.map(image => ({ id: image.id, noteId: image.noteId, hash: image.hash, name: image.name, type: image.type, size: image.size, ...(image.order !== undefined ? { order: image.order } : {}) })),
  }));
  const removedItems = [...vault.items].filter(([, item]) => replacements.has(item.get('noteId'))).map(([id]) => id);
  const removedImages = [...vault.attachments].filter(([, image]) => replacements.has(image.noteId)).map(([id]) => id);
  const removedMerges = [...vault.merges].filter(([, edge]) => replacements.has(edge.a) || replacements.has(edge.b)).map(([id]) => id);
  const removedRecipes = [...vault.mergeRecipes].filter(([, recipe]) => recipe.sourceIds.some(id => replacements.has(id))).map(([id]) => id);
  const receipt: ImportReceipt = { manifestHash: options.manifestHash, added: prepared.length, removed: replacements.size };
  vault.doc.transact(() => {
    // An explicit new import may recreate a label; it never revives memberships
    // from the previous identity or changes an already-applied import receipt.
    for (const name of new Set(options.notes.flatMap(note => note.labels ?? []))) {
      const lifecycle = vault.labelLifecycle.get(name);
      if (lifecycle?.deleted) vault.labelLifecycle.set(name, { ...lifecycle, deleted: false });
    }
    for (const id of replacements) vault.notes.delete(id);
    for (const id of removedItems) vault.items.delete(id);
    for (const id of removedImages) vault.attachments.delete(id);
    for (const id of removedMerges) vault.merges.delete(id);
    for (const id of removedRecipes) vault.mergeRecipes.delete(id);
    for (const note of prepared) {
      vault.notes.set(note.id, note.record);
      for (const item of note.items) vault.items.set(item.id, item.record);
      for (const image of note.images) vault.attachments.set(image.id, image);
    }
    receipts.set(options.id, receipt);
  }, 'import');
  return { status: 'applied', added: receipt.added, removed: receipt.removed };
}
