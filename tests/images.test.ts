import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { openDB } from 'idb';
import { createHash } from 'node:crypto';
import { ImageStore, THUMBNAIL_DIGEST_HEADER, type ImageOptions } from '../src/core/images';
import type { Attachment } from '../src/core/types';

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
const vaultId = 'a'.repeat(64);
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function attachment(text: string): Attachment {
  return { id: text, noteId: 'note', hash: hash(text), name: `${text}.png`, type: 'image/png', size: Buffer.byteLength(text) };
}
function previewResponse(text = 'a small preview') {
  return new Response(text, { headers: { 'Content-Type': 'image/webp', [THUMBNAIL_DIGEST_HEADER]: hash(text) } });
}
function fixture(t: TestContext, overrides: Partial<ImageOptions> = {}) {
  const controller = new AbortController();
  const errors: (string | null)[] = [];
  const auth: string[] = [];
  const store = new ImageStore({
    vaultId, assertAccount() {}, isOnline: () => true, signal: controller.signal,
    onAuthError: message => { auth.push(message); controller.abort(); }, onError: error => errors.push(error),
    makeThumbnail: async blob => new Blob([`preview:${await blob.text()}`], { type: 'image/webp' }),
    fetch: async () => { throw new Error('Unexpected network request'); }, ...overrides,
  });
  t.after(() => store.close());
  return { store, errors, auth, controller };
}
async function cache(id = vaultId) { return await openDB(`stow-images-${id}`, 2); }

test('sync eagerly caches previews, never originals, and repeated sync has no HEAD sweep', async t => {
  const notes = [attachment('first image'), attachment('second image')];
  const requests: string[] = [];
  const { store } = fixture(t, { fetch: async (input, options) => {
    const url = String(input);
    assert.equal(new Headers(options?.headers).get('X-Stow-Vault'), vaultId);
    assert.equal(options?.redirect, 'manual');
    requests.push(`${options?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/thumbnail')) return previewResponse(url);
    const note = notes.find(note => url.endsWith(note.hash));
    assert.ok(note);
    return new Response(note.id);
  } });
  await store.sync(notes);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.endsWith('/thumbnail')));
  await store.sync(notes);
  const thumb = await store.thumbnailUrl(notes[0]);
  assert.ok(thumb);
  thumb.release();
  assert.equal(requests.length, 2);
  const original = await store.originalUrl(notes[0]);
  assert.ok(original);
  assert.equal(requests.length, 3);
  assert.equal(await (await fetch(original.url)).text(), notes[0].id);
  original.release();
  await assert.rejects(fetch(original.url));
});

test('non-image attachments skip previews and download only on explicit access within the same bounded cache', async t => {
  const bytes = 'synthetic audio bytes';
  const audio: Attachment = { id: 'audio', noteId: 'note', hash: hash(bytes), name: 'voice-memo.3gp', type: 'audio/3gp', size: Buffer.byteLength(bytes) };
  const requests: string[] = [];
  const first = fixture(t, {
    makeThumbnail: async () => { throw new Error('An audio file must never enter an image decoder'); },
    fetch: async (input, options) => {
      requests.push(String(input));
      assert.equal(new Headers(options?.headers).get('X-Stow-Vault'), vaultId);
      assert.equal(String(input), `/api/blobs/${audio.hash}`);
      return new Response(bytes);
    },
  });
  await first.store.sync([audio]);
  assert.equal(first.store.progress.thumbnailsRemaining, 0);
  assert.deepEqual(requests, []);
  const original = await first.store.originalUrl(audio);
  assert.ok(original);
  assert.equal(await (await fetch(original.url)).text(), bytes);
  original.release();
  assert.equal(requests.length, 1);
  first.store.close();

  const offline = fixture(t, { isOnline: () => false, makeThumbnail: async () => { throw new Error('Do not decode cached audio'); } });
  await offline.store.sync([]); // Cached files stay files even without a current note reference.
  const saved = await offline.store.originalUrl(audio);
  assert.ok(saved);
  assert.equal(await (await fetch(saved.url)).text(), bytes);
  saved.release();
  const db = await cache(); t.after(() => db.close());
  assert.equal(await db.count('thumbnails'), 0);
  assert.equal((await db.get('metadata', audio.hash)).previewable, false);
  offline.store.close();

  const tiny = fixture(t, { budgetBytes: 0, isOnline: () => false });
  await tiny.store.ready;
  assert.equal(await tiny.store.originalUrl(audio), undefined);
  assert.equal(await db.get('blobs', audio.hash), undefined);
});

test('known non-image references do not decode older cached records without preview metadata', async t => {
  const audio: Attachment = { id: 'audio', noteId: 'note', hash: hash('saved audio'), name: 'saved.3gp', type: 'audio/3gp', size: 11 };
  const previous = await openDB(`stow-images-${vaultId}`, 1, { upgrade(db) { db.createObjectStore('blobs', { keyPath: 'hash' }); } });
  await previous.put('blobs', { hash: audio.hash, blob: new Blob(['saved audio'], { type: audio.type }), uploaded: false });
  previous.close();
  const { store } = fixture(t, { isOnline: () => false, makeThumbnail: async () => { throw new Error('Do not decode audio'); } });
  await store.sync([audio]);
  assert.equal(store.progress.pendingUploads, 1);
  assert.equal(store.progress.thumbnailsRemaining, 0);
  const db = await cache(); t.after(() => db.close());
  assert.equal(await db.count('thumbnails'), 0);
  assert.equal((await db.get('metadata', audio.hash)).uploaded, 0);
  assert.ok(await db.get('blobs', audio.hash));
});

test('same-account v1 upgrade preserves pending originals and derives offline previews before eviction', async t => {
  const alice = await openDB(`stow-images-${vaultId}`, 1, { upgrade(db) { db.createObjectStore('blobs', { keyPath: 'hash' }); } });
  const old = [attachment('old original one'), attachment('old original two'), attachment('still pending')];
  for (let i = 0; i < old.length; i++) await alice.put('blobs', { hash: old[i].hash, blob: new Blob([old[i].id]), uploaded: i !== 2 });
  alice.close();
  const otherId = 'b'.repeat(64);
  const other = await openDB(`stow-images-${otherId}`, 1, { upgrade(db) { db.createObjectStore('blobs', { keyPath: 'hash' }); } });
  await other.put('blobs', { hash: old[0].hash, blob: new Blob(['other account bytes']), uploaded: false });
  other.close();
  const originalGetAll = IDBObjectStore.prototype.getAll;
  t.mock.method(IDBObjectStore.prototype, 'getAll', function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['getAll']>) {
    assert.notEqual(this.name, 'blobs', 'must not read all full originals into an array');
    return originalGetAll.apply(this, args);
  });
  t.mock.method(indexedDB, 'databases', () => { throw new Error('Do not enumerate other accounts'); });
  const { store } = fixture(t, { budgetBytes: 0, isOnline: () => false });
  await store.ready;
  await store.sync([]); // Unreferenced old images must not permanently defeat the budget.
  const db = await cache();
  t.after(() => db.close());
  assert.deepEqual(await db.getAllKeys('blobs'), [old[2].hash]);
  assert.equal(await db.count('thumbnails'), 3);
  assert.equal((await db.get('metadata', old[2].hash)).uploaded, 0);
  assert.equal(store.progress.originalBytes, 0);
  assert.equal(store.progress.pendingUploads, 1);
  assert.ok(await store.thumbnailUrl(old[0]));
  assert.equal(await store.originalUrl(old[0]), undefined);
  const untouched = await openDB(`stow-images-${otherId}`, 1);
  assert.equal((await untouched.get('blobs', old[0].hash)).blob.size, Buffer.byteLength('other account bytes'));
  assert.equal(untouched.version, 1);
  untouched.close();
});

test('pending uploads remain protected across failure and reopening until durable acknowledgement', async t => {
  const file = new File(['pending original'], 'photo.png', { type: 'image/png' });
  const first = fixture(t, { budgetBytes: 0, fetch: async () => new Response('storage unavailable', { status: 503 }) });
  const saved = await first.store.add(file);
  await assert.rejects(first.store.sync([{ ...saved, id: 'pending-image', noteId: 'pending-note' }]), /could not upload/);
  const db = await cache();
  assert.equal((await db.get('metadata', saved.hash)).uploaded, 0);
  assert.equal((await db.get('blobs', saved.hash)).blob.size, file.size);
  db.close(); first.store.close();
  let acknowledge!: () => void;
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const second = fixture(t, { budgetBytes: 0, fetch: async (_input, options) => {
    assert.equal(options?.method, 'PUT'); started();
    await new Promise<void>(resolve => { acknowledge = resolve; });
    return new Response(null, { status: 204 });
  } });
  const sync = second.store.sync([{ ...saved, id: 'pending-image', noteId: 'pending-note' }]);
  await start;
  const waiting = await cache();
  assert.equal((await waiting.get('metadata', saved.hash)).uploaded, 0);
  assert.ok(await waiting.get('blobs', saved.hash));
  acknowledge(); await sync;
  assert.equal(await waiting.get('blobs', saved.hash), undefined);
  assert.ok(await waiting.get('thumbnails', saved.hash));
  waiting.close();
});

test('downloaded originals use LRU eviction while previews and active display leases survive', async t => {
  let time = 0;
  t.mock.method(Date, 'now', () => ++time);
  const notes = ['first12345', 'second1234', 'third12345'].map(attachment);
  const { store } = fixture(t, { budgetBytes: 20, fetch: async input => {
    const url = String(input);
    if (url.endsWith('/thumbnail')) return previewResponse(url);
    return new Response(notes.find(note => url.endsWith(note.hash))!.id);
  } });
  await store.sync(notes);
  (await store.originalUrl(notes[0]))!.release();
  (await store.originalUrl(notes[1]))!.release();
  const active = (await store.originalUrl(notes[0]))!;
  (await store.originalUrl(notes[2]))!.release();
  const db = await cache(); t.after(() => db.close());
  assert.ok(await db.get('blobs', notes[0].hash));
  assert.equal(await db.get('blobs', notes[1].hash), undefined);
  assert.ok(await db.get('blobs', notes[2].hash));
  assert.equal(await db.count('thumbnails'), 3);
  assert.ok(store.progress.originalBytes <= 20);
  assert.equal(await (await fetch(active.url)).text(), notes[0].id);
  active.release();

  let downloads = 0;
  const tiny = fixture(t, { budgetBytes: 0, fetch: async input => {
    assert.equal(String(input), `/api/blobs/${notes[2].hash}`);
    downloads++;
    return new Response(notes[2].id);
  } });
  await tiny.store.ready;
  assert.equal(await db.get('blobs', notes[2].hash), undefined);
  const lease = await tiny.store.originalUrl(notes[2]);
  assert.ok(lease);
  assert.equal(downloads, 1);
  assert.equal(await db.get('blobs', notes[2].hash), undefined);
  assert.equal(await (await fetch(lease.url)).text(), notes[2].id);
  lease.release();
});

test('quota failures are visible and never publish a partially saved local image', async t => {
  const { store, errors } = fixture(t);
  await store.ready;
  const originalPut = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'blobs') throw new DOMException('Storage quota reached', 'QuotaExceededError');
    return originalPut.apply(this, args);
  });
  await assert.rejects(store.add(new File(['new image'], 'image.png', { type: 'image/png' })), /quota/);
  assert.ok(errors.some(message => message?.includes('quota')));
  const db = await cache(); t.after(() => db.close());
  assert.equal(await db.count('blobs'), 0);
  assert.equal(await db.count('metadata'), 0);
  assert.equal(await db.count('thumbnails'), 0);
});

test('one queue bounds foreground and background network concurrency and deduplicates previews', async t => {
  const notes = Array.from({ length: 8 }, (_, i) => attachment(`original ${i}`));
  let active = 0, maximum = 0;
  const requests: string[] = [];
  const { store } = fixture(t, { concurrency: 2, fetch: async input => {
    const url = String(input); requests.push(url); active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return url.endsWith('/thumbnail') ? previewResponse(url) : new Response(notes.find(note => url.endsWith(note.hash))!.id);
  } });
  await store.ready;
  await Promise.all([store.sync(notes), store.thumbnailUrl(notes[0]).then(lease => lease?.release()), store.originalUrl(notes[1]).then(lease => lease?.release())]);
  assert.equal(maximum, 2);
  assert.equal(requests.filter(url => url === `/api/blobs/${notes[0].hash}/thumbnail`).length, 1);
});

test('auth rejection and an account change prevent image cache writes and revoke leases', async t => {
  const note = attachment('private image');
  for (const status of [401, 403, 409, 302]) {
    const { store, auth } = fixture(t, { fetch: async () => new Response('', { status }) });
    await assert.rejects(store.originalUrl(note), /account could not be verified/);
    assert.equal(auth.length, 1);
    store.close();
  }
  let allowed = true, resume!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const { store } = fixture(t, { assertAccount: () => { if (!allowed) throw new Error('Account changed'); }, fetch: async () => {
    started(); await new Promise<void>(resolve => { resume = resolve; }); return new Response(note.id);
  } });
  const request = store.originalUrl(note);
  await startedPromise; allowed = false; resume();
  await assert.rejects(request, /Account changed/);
  const db = await cache(); t.after(() => db.close());
  assert.equal(await db.count('blobs'), 0);
});

test('integrity mismatches are visible and cache neither originals nor previews', async t => {
  const { store, errors } = fixture(t, { fetch: async input => String(input).endsWith('/thumbnail')
    ? new Response('wrong preview', { headers: { [THUMBNAIL_DIGEST_HEADER]: hash('right preview') } })
    : new Response('wrong original') });
  const note = attachment('right original');
  await assert.rejects(store.thumbnailUrl(note), /integrity check/);
  await assert.rejects(store.originalUrl(note), /integrity check/);
  assert.equal(errors.length, 2);
  const db = await cache(); t.after(() => db.close());
  assert.equal(await db.count('thumbnails'), 0);
  assert.equal(await db.count('blobs'), 0);
});

test('permanent deletion removes only unused candidate blobs, previews and leases', async t => {
  const { store } = fixture(t, { isOnline: () => false });
  const files = await Promise.all(['deleted', 'shared', 'unrelated pending'].map(text => store.add(new File([text], `${text}.png`, { type: 'image/png' }))));
  const notes = files.map((file, i) => ({ ...file, id: String(i), noteId: String(i) }));
  const lease = await store.originalUrl(notes[0]);
  assert.ok(lease);
  store.setDeletedBlobs(new Set(files.slice(0, 2).map(file => file.hash)), new Set([files[1].hash]));
  await store.pruneDeleted();
  await assert.rejects(fetch(lease.url));
  lease.release();
  assert.equal(await store.originalUrl(notes[0]), undefined);
  assert.equal(await store.thumbnailUrl(notes[0]), undefined);
  const db = await cache(); t.after(() => db.close());
  for (const name of ['blobs', 'metadata', 'thumbnails']) {
    assert.equal(await db.get(name, files[0].hash), undefined);
    assert.ok(await db.get(name, files[1].hash));
    assert.ok(await db.get(name, files[2].hash));
  }
});

test('an in-flight deleted image cannot repopulate the cache after its purge', async t => {
  const note = attachment('original being deleted');
  const waiting: (() => void)[] = [];
  let allStarted!: () => void;
  const started = new Promise<void>(resolve => { allStarted = resolve; });
  const { store } = fixture(t, { fetch: async input => {
    await new Promise<void>(resolve => { waiting.push(resolve); if (waiting.length === 2) allStarted(); });
    return String(input).endsWith('/thumbnail') ? previewResponse() : new Response(note.id);
  } });
  const original = store.originalUrl(note), thumbnail = store.thumbnailUrl(note);
  await started;
  store.setDeletedBlobs(new Set([note.hash]), new Set());
  await store.pruneDeleted();
  waiting.forEach(resolve => resolve());
  assert.deepEqual(await Promise.all([original, thumbnail]), [undefined, undefined]);
  const db = await cache(); t.after(() => db.close());
  for (const name of ['blobs', 'metadata', 'thumbnails']) assert.equal(await db.count(name), 0);
});

test('pending uploads identify all sources and deletion during upload does not restore cached bytes', async t => {
  let resume!: () => void, uploadStarted!: () => void;
  const started = new Promise<void>(resolve => { uploadStarted = resolve; });
  const { store } = fixture(t, { fetch: async (_input, options) => {
    assert.deepEqual(JSON.parse(new Headers(options?.headers).get('X-Stow-Blob-Sources')!), ['first', 'second']);
    uploadStarted();
    await new Promise<void>(resolve => { resume = resolve; });
    return new Response(null, { status: 204 });
  } });
  const image = await store.add(new File(['upload then delete'], 'image.png', { type: 'image/png' }));
  const sync = store.sync([{ ...image, id: 'one', noteId: 'first' }, { ...image, id: 'two', noteId: 'second' }]);
  await started;
  store.setDeletedBlobs(new Set([image.hash]), new Set());
  await store.pruneDeleted();
  resume(); await sync;
  const db = await cache(); t.after(() => db.close());
  for (const name of ['blobs', 'metadata', 'thumbnails']) assert.equal(await db.count(name), 0);
});

test('a fresh attachment can reuse deleted bytes and unpublished pending files are retained without uploading', async t => {
  const requests: string[] = [];
  const { store } = fixture(t, { fetch: async (input, options) => {
    requests.push(String(input));
    assert.deepEqual(JSON.parse(new Headers(options?.headers).get('X-Stow-Blob-Sources')!), ['new-source']);
    return new Response(null, { status: 204 });
  } });
  const file = new File(['identical original'], 'image.png', { type: 'image/png' });
  const old = await store.add(file);
  await store.sync([]);
  assert.deepEqual(requests, []);
  store.setDeletedBlobs(new Set([old.hash]), new Set());
  await store.pruneDeleted();
  const fresh = await store.add(file);
  store.setDeletedBlobs(new Set([old.hash]), new Set([fresh.hash]));
  await store.pruneDeleted();
  await store.sync([{ ...fresh, id: 'new-attachment', noteId: 'new-source' }]);
  assert.equal(requests.length, 1);
  const db = await cache(); t.after(() => db.close());
  assert.ok(await db.get('blobs', fresh.hash));
  assert.ok(await db.get('thumbnails', fresh.hash));
});

test('failed cache deletion remains visible and retries without deleting unrelated files', async t => {
  const { store, errors } = fixture(t, { isOnline: () => false });
  const image = await store.add(new File(['retry purge'], 'image.png', { type: 'image/png' }));
  store.setDeletedBlobs(new Set([image.hash]), new Set());
  const remove = IDBObjectStore.prototype.delete;
  let fail = true;
  t.mock.method(IDBObjectStore.prototype, 'delete', function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    if (fail && this.name === 'thumbnails') throw new DOMException('Simulated storage failure', 'UnknownError');
    return remove.call(this, key);
  });
  await assert.rejects(store.pruneDeleted(), /storage failure/);
  assert.ok(errors.some(error => error?.includes('storage failure')));
  const db = await cache(); t.after(() => db.close());
  assert.ok(await db.get('blobs', image.hash));
  fail = false;
  await store.pruneDeleted();
  assert.equal(await db.get('blobs', image.hash), undefined);
});

test('deletion cleanup cannot consume fresh pending bytes before their source is published', async t => {
  const { store } = fixture(t, { isOnline: () => false });
  const file = new File(['reuse while saving'], 'image.png', { type: 'image/png' });
  const saved = await store.add(file);
  const candidates = new Set([saved.hash]);
  store.setDeletedBlobs(candidates, new Set());
  await store.pruneDeleted();
  const put = IDBObjectStore.prototype.put;
  let cleanup: Promise<void> | undefined;
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'blobs') {
      store.setDeletedBlobs(candidates, new Set());
      cleanup = store.pruneDeleted();
    }
    return put.apply(this, args);
  });
  let published = false;
  await store.add(file, attachment => { published = true; store.setDeletedBlobs(candidates, new Set([attachment.hash])); });
  await cleanup;
  assert.equal(published, true);
  const db = await cache(); t.after(() => db.close());
  assert.ok(await db.get('blobs', saved.hash));
  assert.equal((await db.get('metadata', saved.hash)).uploaded, 0);
});

test('adding a cached uploaded image to a new source republishes its bytes and ownership', async t => {
  const owners: string[][] = [];
  const { store } = fixture(t, { fetch: async (_input, options) => {
    owners.push(JSON.parse(new Headers(options?.headers).get('X-Stow-Blob-Sources')!));
    return new Response(null, { status: 204 });
  } });
  const file = new File(['same bytes, new source'], 'image.png', { type: 'image/png' });
  const original = await store.add(file);
  await store.sync([{ ...original, id: 'old-image', noteId: 'old-source' }]);
  const added = await store.add(file);
  await store.sync([{ ...added, id: 'new-image', noteId: 'new-source' }]);
  assert.deepEqual(owners, [['old-source'], ['new-source']]);
});

for (const anotherTab of [false, true]) test(`an old upload cannot acknowledge identical bytes newly added ${anotherTab ? 'in another tab' : 'to another source'}`, async t => {
  let resume!: () => void, uploadStarted!: () => void;
  const started = new Promise<void>(resolve => { uploadStarted = resolve; });
  const owners: string[][] = [];
  const { store } = fixture(t, { budgetBytes: 0, fetch: async (_input, options) => {
    owners.push(JSON.parse(new Headers(options?.headers).get('X-Stow-Blob-Sources')!));
    if (owners.length === 1) {
      uploadStarted();
      await new Promise<void>(resolve => { resume = resolve; });
    }
    return new Response(null, { status: 204 });
  } });
  const adder = anotherTab ? fixture(t, { budgetBytes: 0, isOnline: () => false }).store : store;
  await adder.ready;
  const file = new File(['same bytes, later ownership'], 'image.png', { type: 'image/png' });
  const original = await store.add(file);
  const db = await cache(); t.after(() => db.close());
  const originalGeneration = (await db.get('metadata', original.hash)).uploadGeneration;
  const upload = store.sync([{ ...original, id: 'old-image', noteId: 'old-source' }]);
  await started;
  const added = await adder.add(file);
  const newGeneration = (await db.get('metadata', added.hash)).uploadGeneration;
  assert.equal(typeof newGeneration, 'string');
  assert.notEqual(newGeneration, originalGeneration);
  resume(); await upload;

  const pending = await db.get('metadata', added.hash);
  assert.equal(pending.uploadGeneration, newGeneration);
  assert.equal(pending.uploaded, 0, 'The old response must not acknowledge the new source’s upload');
  assert.ok(await db.get('blobs', added.hash), 'The zero-byte cache budget must preserve newly pending bytes');
  assert.equal(store.progress.pendingUploads, 1);
  await store.sync([{ ...added, id: 'new-image', noteId: 'new-source' }]);
  assert.deepEqual(owners, [['old-source'], ['new-source']]);
  assert.equal(store.progress.pendingUploads, 0);
  assert.equal(await db.get('blobs', added.hash), undefined);
});

test('an original download completing after a new add preserves its pending upload generation and bytes', async t => {
  let resume!: () => void, downloadStarted!: () => void;
  const started = new Promise<void>(resolve => { downloadStarted = resolve; });
  const note = attachment('downloaded bytes with new ownership');
  const uploads: string[][] = [];
  const { store } = fixture(t, { budgetBytes: 0, fetch: async (_input, options) => {
    if (options?.method === 'PUT') {
      uploads.push(JSON.parse(new Headers(options.headers).get('X-Stow-Blob-Sources')!));
      return new Response(null, { status: 204 });
    }
    downloadStarted();
    await new Promise<void>(resolve => { resume = resolve; });
    return new Response(note.id);
  } });
  const download = store.originalUrl(note);
  await started;
  const added = await store.add(new File([note.id], 'added.png', { type: 'image/png' }));
  const db = await cache(); t.after(() => db.close());
  const generation = (await db.get('metadata', added.hash)).uploadGeneration;
  resume();
  const lease = await download;
  assert.ok(lease);
  lease.release();
  const pending = await db.get('metadata', added.hash);
  assert.equal(pending.uploadGeneration, generation);
  assert.equal(pending.uploaded, 0);
  assert.equal(pending.thumbnailReady, true);
  assert.ok(await db.get('blobs', added.hash), 'Downloading must not make fresh pending bytes eligible for eviction');
  await store.sync([{ ...added, id: 'new-image', noteId: 'new-source' }]);
  assert.deepEqual(uploads, [['new-source']]);
  assert.equal(store.progress.pendingUploads, 0);
});
