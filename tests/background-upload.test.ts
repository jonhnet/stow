import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadBackgroundLog, BACKGROUND_UPLOAD_INTERVAL } from '../src/core/background-upload';
import { openBackgroundDatabase, readBackgroundLog, recordBackgroundEvent } from '../src/core/background-state';

const account = { user: 'alice', vaultId: 'background-upload-alice', authMode: 'proxy' as const };
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
afterEach(() => { if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks); else Reflect.deleteProperty(navigator, 'locks'); });
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    async request(name: string, _options: unknown, run: (lock: unknown) => Promise<void>) {
      if (held.has(name)) return run(null);
      held.add(name);
      try { return await run({}); } finally { held.delete(name); }
    },
  } });
});
const record = () => recordBackgroundEvent(account, { kind: 'registration-check', standalone: true }, null);
const upload = (source: 'foreground' | 'background' = 'foreground') => uploadBackgroundLog(account, 'https://stow.test', source, null);

test('queued events retain their recording builds across upgrades and upload retries', async t => {
  const oldTab = 'a'.repeat(40), worker = 'b'.repeat(40), uploader = 'c'.repeat(40), retry = 'd'.repeat(40);
  await recordBackgroundEvent(account, { kind: 'registration-check', standalone: true }, oldTab);
  await recordBackgroundEvent(account, { kind: 'wake', runId: crypto.randomUUID() }, worker);
  // An event already queued by the deployed, unstamped client has no known build.
  const db = await openBackgroundDatabase();
  await db.add('events', { vaultId: account.vaultId, at: 1000, kind: 'registration-check', standalone: false });
  db.close();
  assert.deepEqual((await readBackgroundLog(account)).events.map(event => event.build), [oldTab, worker, undefined]);
  const batches: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
    if (url.pathname === '/api/session') return Response.json({ ...account, authenticated: true });
    const batch = JSON.parse(String(init!.body)); batches.push(batch);
    if (batches.length === 1) throw new TypeError('Lost acknowledgment');
    return Response.json({ deviceId: batch.deviceId, through: batch.through });
  });
  await assert.rejects(uploadBackgroundLog(account, 'https://stow.test', 'foreground', uploader), /Lost acknowledgment/);
  await uploadBackgroundLog(account, 'https://stow.test', 'background', retry);
  assert.deepEqual(batches.map(batch => batch.build), [uploader, retry]);
  assert.deepEqual(batches[0].events.map((event: any) => event.build), [oldTab, worker, undefined]);
  assert.deepEqual(batches[1].events, batches[0].events);
});

test('automatic uploads are throttled, delta-only, and retain events written during an upload', async t => {
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  await record();
  const batches: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
    if (url.pathname === '/api/session') return Response.json({ ...account, authenticated: true });
    assert.equal(new Headers(init!.headers).get('X-Stow-Vault'), account.vaultId);
    const batch = JSON.parse(String(init!.body)); batches.push(batch);
    assert.ok(batch.events.every((event: any) => !('vaultId' in event)));
    if (batches.length === 1) await record();
    return Response.json({ deviceId: batch.deviceId, through: batch.through });
  });
  await upload();
  assert.equal(batches[0].events.length, 1);
  assert.equal((await readBackgroundLog(account)).uploadedThrough, batches[0].through);
  await upload(); assert.equal(batches.length, 1);
  now += BACKGROUND_UPLOAD_INTERVAL;
  await Promise.all([upload(), upload()]);
  assert.equal(batches.length, 2);
  assert.equal(batches[1].events.length, 1);
  assert.ok(batches[1].events[0].seq > batches[0].through);
  now += BACKGROUND_UPLOAD_INTERVAL;
  await upload();
  assert.deepEqual(batches[2].events, []); // Heartbeat distinguishes an open app from absent scheduling.
  assert.equal(batches[2].through, batches[1].through);
  assert.equal((await readBackgroundLog(account)).lastUploadedAt, now);
});

for (const failure of ['offline', 'rejected', 'lost response', 'invalid acknowledgment']) test(`upload ${failure} retains the durable cursor and retries the same events`, async t => {
  await record(); let failed = true;
  const batches: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
    if (url.pathname === '/api/session') {
      if (failed && failure === 'offline') throw new TypeError('Offline');
      return Response.json({ ...account, authenticated: true });
    }
    const batch = JSON.parse(String(init!.body)); batches.push(batch);
    if (failed && failure === 'lost response') throw new TypeError('Response lost after server commit');
    if (failed && failure === 'rejected') return new Response('', { status: 503 });
    return Response.json({ deviceId: batch.deviceId, through: failed ? -1 : batch.through });
  });
  await assert.rejects(upload());
  assert.equal((await readBackgroundLog(account)).uploadedThrough, 0);
  failed = false;
  await upload('background');
  assert.ok((await readBackgroundLog(account)).uploadedThrough > 0);
  if (batches.length === 2) assert.deepEqual(batches[0].events, batches[1].events);
});

for (const session of [
  { ...account, authenticated: false },
  { ...account, user: 'bob', vaultId: 'different-account-bob', authenticated: true },
  { ...account, principalId: 'shared-participant', authenticated: true },
]) test(`log upload rejects a different or unauthenticated session: ${JSON.stringify(session)}`, async t => {
  await record();
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(session));
  await assert.rejects(upload(), /account changed|scope/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal((await readBackgroundLog(account)).uploadedThrough, 0);
});

test('expiry reports only records dropped without acknowledgment, not the retained display log', async t => {
  await record();
  t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
    if (url.pathname === '/api/session') return Response.json({ ...account, authenticated: true });
    const batch = JSON.parse(String(init!.body));
    return Response.json({ deviceId: batch.deviceId, through: batch.through });
  });
  await upload();
  for (let i = 0; i < 201; i++) await record();
  const log = await readBackgroundLog(account);
  assert.equal(log.events.length, 200);
  assert.equal(log.droppedUnacknowledged, 1);
});
