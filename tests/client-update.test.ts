import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { IdleUpdateReload, parseSyncRejection, UPDATE_IDLE_MS } from '../src/core/client-update';

function environment(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  const events = new EventTarget(), document = { visibilityState: 'visible' }, saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  const reloads: IdleUpdateReload[] = [];
  t.after(() => reloads.forEach(reload => reload.stop()));
  for (const [key, value] of Object.entries({ window: events, document, sessionStorage: storage })) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (before) Object.defineProperty(globalThis, key, before); else Reflect.deleteProperty(globalThis, key); });
  }
  const state = { safe: true, reloads: 0, failures: 0, saves: 0 };
  const start = (save: () => Promise<void> = async () => { state.saves++; }) => {
    const reload = new IdleUpdateReload('account-a', 'schema/next', {
      safe: () => state.safe, save, reload: () => { state.reloads++; }, failed: () => { state.failures++; },
    });
    reloads.push(reload); return reload;
  };
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await Promise.resolve(); await Promise.resolve(); };
  return { events, document, storage, state, start, advance };
}

test('reload requires idle, visible, saved and composition-free state', async t => {
  const f = environment(t); f.start();
  await f.advance(4000); f.events.dispatchEvent(new Event('input'));
  await f.advance(4000); assert.equal(f.state.reloads, 0);
  f.state.safe = false; await f.advance(UPDATE_IDLE_MS); assert.equal(f.state.saves, 0);
  f.state.safe = true; f.document.visibilityState = 'hidden'; await f.advance(UPDATE_IDLE_MS); assert.equal(f.state.reloads, 0);
  f.document.visibilityState = 'visible'; f.events.dispatchEvent(new Event('compositionstart'));
  await f.advance(UPDATE_IDLE_MS); assert.equal(f.state.reloads, 0);
  f.events.dispatchEvent(new Event('compositionend')); await f.advance(UPDATE_IDLE_MS);
  assert.equal(f.state.reloads, 1); assert.equal(f.state.saves, 1);
});

test('new input while durability is awaited cancels that reload', async t => {
  const f = environment(t); let finish!: () => void;
  f.start(() => new Promise(resolve => { finish = resolve; }));
  await f.advance(UPDATE_IDLE_MS);
  f.events.dispatchEvent(new Event('input')); finish(); await f.advance(0);
  assert.equal(f.state.reloads, 0);
  await f.advance(UPDATE_IDLE_MS); finish(); await f.advance(0);
  assert.equal(f.state.reloads, 1);
});

test('a failed durable write retains the page and permits a later manual retry', async t => {
  const f = environment(t); let failing = true;
  const reload = f.start(async () => { if (failing) throw new Error('Quota exceeded'); });
  await f.advance(UPDATE_IDLE_MS);
  assert.equal(f.state.reloads, 0); assert.equal(f.state.failures, 1); assert.equal(reload.automatic, false);
  await f.advance(60000); assert.equal(f.state.failures, 1);
  failing = false; await reload.attempt(); assert.equal(f.state.reloads, 1);
});

test('the same requirement only reloads automatically once, manual reload remains available', async t => {
  const f = environment(t); f.start(); await f.advance(UPDATE_IDLE_MS);
  const again = f.start(); assert.equal(again.automatic, false);
  await f.advance(60000); assert.equal(f.state.reloads, 1);
  await again.attempt(); assert.equal(f.state.reloads, 2);
});

test('an unavailable reload guard prevents automatic loops but permits manual reload', async t => {
  const f = environment(t);
  t.mock.method(f.storage, 'setItem', () => { throw new Error('Storage denied'); });
  const reload = f.start(); await f.advance(UPDATE_IDLE_MS);
  assert.equal(f.state.reloads, 0); assert.equal(reload.automatic, false);
  await reload.attempt(); assert.equal(f.state.reloads, 1);
});

test('account blocking or page exit during a flush cancels navigation', async t => {
  const f = environment(t); let finish!: () => void;
  const reload = f.start(() => new Promise(resolve => { finish = resolve; }));
  await f.advance(UPDATE_IDLE_MS); reload.stop(); finish(); await f.advance(0);
  assert.equal(f.state.reloads, 0);
});

test('server notices accept only bounded plain messages and known actions', () => {
  const notice = { code: 'client_update_required', message: 'Reload Stow', target: 'schema/next', action: 'reload' };
  assert.deepEqual(parseSyncRejection(notice), notice);
  assert.equal(parseSyncRejection(undefined), null);
  for (const invalid of [false, {}, { ...notice, action: 'https://example.test/' }, { ...notice, message: 'x'.repeat(2001) }, { ...notice, target: '' }]) assert.throws(() => parseSyncRejection(invalid), /invalid sync rejection/);
});
