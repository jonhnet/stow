import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDB } from 'idb';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { ImageStore } from '../src/core/images';
import { getPermanentDeletionBlobCandidates } from '../src/core/deletion';
import type { Attachment } from '../src/core/types';

const image = (noteId: string, id = 'image', hash = 'a'.repeat(64)): Attachment => ({ id, noteId, hash, name: `${id}.png`, type: 'image/png', size: 10, order: 0 });

test('removed images remain owned by Undo and Redo, including while stack events are firing', t => {
  const vault = new Vault(); t.after(() => vault.destroy()); const note = vault.createNote(), attachment = image(note);
  vault.addAttachment(attachment); vault.undoManager.clear(); vault.removeAttachment(attachment.id);
  assert.deepEqual(vault.getUndoAttachments(), [attachment]);
  const observed: Attachment[][] = [];
  for (const event of ['stack-item-added', 'stack-item-popped'] as const) vault.undoManager.on(event, () => observed.push(vault.getUndoAttachments()));
  vault.undo(); assert.equal(vault.attachments.get(attachment.id)?.hash, attachment.hash);
  vault.undoManager.clear(true, false); assert.deepEqual(vault.getUndoAttachments(), [attachment], 'The redo stack alone retains its original');
  vault.redo(); assert.equal(vault.attachments.has(attachment.id), false);
  assert.deepEqual(vault.getUndoAttachments(), [attachment]); assert(observed.length >= 4);
  for (const entries of observed) assert.deepEqual(entries, [attachment]);
  const state = Y.encodeStateAsUpdate(vault.doc); vault.getUndoAttachments(); assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), state);
  const peer = new Vault(); t.after(() => peer.destroy()); Y.applyUpdate(peer.doc, state);
  assert.deepEqual(peer.getUndoAttachments(), [], 'Local Undo ownership is never replicated');
  vault.undoManager.clear(); assert.deepEqual(vault.getUndoAttachments(), []);
});

test('restored copies keep attachment metadata; dropping Redo releases only its images', t => {
  const vault = new Vault(); t.after(() => vault.destroy()); const note = vault.createNote();
  vault.addAttachment(image(note)); const snapshot = vault.captureHistoryState([note]); vault.undoManager.clear();
  const restored = vault.restoreHistoryState(snapshot), restoredImage = vault.getNote(restored)!.images[0];
  assert(vault.getUndoAttachments().some(entry => entry.id === restoredImage.id));
  vault.undo(); assert.equal(vault.getNote(restored), undefined);
  assert(vault.getUndoAttachments().some(entry => entry.id === restoredImage.id));
  vault.setNoteText(note, 'body', 'new branch'); vault.finishEdit();
  assert.deepEqual(vault.getUndoAttachments(), [], 'Unrelated text edits do not retain every image in their note');
});

test('permanent deletion drops that source’s Undo image ownership without discarding a surviving shared hash', t => {
  const vault = new Vault(); t.after(() => vault.destroy()); const gone = vault.createNote(), kept = vault.createNote();
  vault.addAttachment(image(gone, 'gone-image')); vault.addAttachment(image(kept, 'kept-image')); vault.undoManager.clear();
  vault.removeAttachment('gone-image'); vault.removeAttachment('kept-image');
  assert.equal(vault.getUndoAttachments().length, 2);
  vault.setNoteMeta(gone, { trashed: true }); vault.deleteNotesForever([gone]);
  assert.deepEqual(vault.getUndoAttachments(), [image(kept, 'kept-image')]);
  vault.undo(); assert(vault.attachments.has('kept-image')); assert(!vault.attachments.has('gone-image'));
});

test('an offline image added then removed keeps its durable pending bytes and uploads through Undo ownership', async t => {
  const vault = new Vault(); t.after(() => vault.destroy()); const note = vault.createNote();
  const vaultId = crypto.randomUUID().replaceAll('-', ''), controller = new AbortController();
  let online = false; const uploads: string[] = [];
  const images = new ImageStore({ vaultId, assertAccount() {}, isOnline: () => online, signal: controller.signal,
    onAuthError(message) { throw new Error(message); }, onError(message) { if (message) throw new Error(message); },
    makeThumbnail: async () => new Blob(['preview'], { type: 'image/webp' }),
    fetch: async (_input, options) => {
      assert.equal(options?.method, 'PUT'); uploads.push(...JSON.parse(new Headers(options?.headers).get('X-Stow-Blob-Sources')!));
      return new Response(null, { status: 204 });
    },
  });
  t.after(() => images.close());
  const file = new File(['offline original bytes'], 'offline.png', { type: 'image/png' });
  await images.add(file, attachment => vault.addAttachment({ ...attachment, id: 'offline-image', noteId: note }));
  const attachment = vault.attachments.get('offline-image')!;
  vault.removeAttachment(attachment.id);
  const retained = [...vault.attachments.values(), ...vault.getUndoAttachments()];
  images.setDeletedBlobs(getPermanentDeletionBlobCandidates(vault.doc), new Set(retained.map(entry => entry.hash)));
  await images.pruneDeleted(); await images.sync(retained);
  const db = await openDB(`stow-images-${vaultId}`); t.after(() => db.close());
  assert.equal((await db.get('metadata', attachment.hash)).uploaded, 0);
  assert.equal(await (await db.get('blobs', attachment.hash)).blob.text(), 'offline original bytes');
  assert.equal(images.progress.pendingUploads, 1); assert.deepEqual(uploads, []);
  online = true; await images.sync(retained); assert.deepEqual(uploads, [note]);
  vault.undo(); const lease = await images.originalUrl(vault.attachments.get(attachment.id)!);
  assert(lease); assert.equal(await (await fetch(lease.url)).text(), 'offline original bytes'); lease.release();
});
