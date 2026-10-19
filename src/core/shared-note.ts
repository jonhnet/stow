import * as Y from 'yjs';
import type { Note } from './types';

export interface SharedReference { id: string; token: string }
export interface Participant { id: string; name: string; guest: boolean }
export const sharedReference = (value: unknown): SharedReference | undefined => {
  if (value === undefined) return undefined;
  const v = value as Partial<SharedReference> | null;
  if (!v || typeof v.id !== 'string' || !/^share_[0-9a-f-]{36}$/.test(v.id) || typeof v.token !== 'string' || !/^[0-9a-f]{64}$/.test(v.token)) throw new Error('Invalid shared note reference.');
  return { id: v.id, token: v.token };
};
export const capability = (ref: SharedReference) => `${ref.id}.${ref.token}`;
export function parseCapability(value: string): SharedReference {
  const [id, token, extra] = value.split('.');
  if (extra !== undefined) throw new Error('Invalid sharing link.');
  return sharedReference({ id, token })!;
}
export function newSharedReference(): SharedReference {
  return { id: `share_${crypto.randomUUID()}`, token: [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('') };
}
/** Serialize current, visible content only. Never move Yjs structs, deleted text,
 * import provenance, labels, placement, or private history into a shared document. */
export function sharedSnapshot(note: Note, id: string): Y.Doc {
  const doc = new Y.Doc(), source = new Y.Map<unknown>();
  doc.getMap('notes').set(id, source);
  for (const [key, value] of Object.entries({ title: new Y.Text(note.title), body: new Y.Text(note.body), kind: note.kind,
    color: 'default', pinned: false, archived: false, trashed: false, createdAt: note.createdAt, updatedAt: note.updatedAt,
    placement: { pinned: false, sortOrderDate: note.createdAt }, unifiedChecklist: true })) source.set(key, value);
  const ids = new Map(note.items.map(item => [item.id, crypto.randomUUID()]));
  for (const [order, item] of note.items.entries()) {
    const record = new Y.Map<unknown>(); doc.getMap('items').set(ids.get(item.id)!, record);
    for (const [key, value] of Object.entries({ noteId: id, text: new Y.Text(item.text), checked: item.checked, rank: order, deleted: false, parentId: item.parentId ? ids.get(item.parentId) ?? null : null })) record.set(key, value);
  }
  for (const [order, attachment] of note.images.entries()) { const imageId = crypto.randomUUID(); doc.getMap('attachments').set(imageId, { ...attachment, id: imageId, noteId: id, order }); }
  return doc;
}
/** Organization belongs to the reference. Content belongs to the shared scope. */
export function referencedNote(reference: Note, content: Note): Note {
  return { ...content, id: reference.id, sourceIds: [reference.id], color: reference.color, pinned: reference.pinned,
    archived: reference.archived, trashed: reference.trashed, labels: reference.labels, sortOrderDate: reference.sortOrderDate };
}
