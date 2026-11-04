import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeShell, networkUrl, stowFetch } from '../src/core/shell';
import { ACCOUNT_KEY } from '../src/core/account';
for (const key of ['window', 'location', 'localStorage']) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: undefined });
const account = { user: 'Alice', vaultId: 'alice-private-vault-1234', authMode: 'proxy' };

test('native account binding fails before replacing an existing offline account', t => {
  const saved = new Map<string, string>();
  t.mock.property(globalThis, 'localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } as any);
  const window = { __STOW_SHELL__: { api: 1, version: 1, release: 'abc', account }, StowShell: { postMessage() {} } };
  t.mock.property(globalThis, 'window', window as any);
  initializeShell(); assert.equal(JSON.parse(saved.get(ACCOUNT_KEY)!).user, 'Alice');
  window.__STOW_SHELL__.account = { ...account, vaultId: 'another-private-vault-1234' };
  assert.throws(initializeShell, /different account/);
  assert.deepEqual(JSON.parse(saved.get(ACCOUNT_KEY)!), account);
});

test('only same-origin APIs use the device route and request binding headers survive', async t => {
  t.mock.property(globalThis, 'window', { __STOW_SHELL__: { api: 1, account } } as any);
  t.mock.property(globalThis, 'location', { origin: 'https://stow.example' } as any);
  assert.equal(networkUrl('/api/images/a?size=small'), 'https://stow.example/native/api/images/a?size=small');
  assert.equal(networkUrl('/sync'), 'https://stow.example/native/sync');
  assert.equal(networkUrl('https://other.example/api/session'), 'https://other.example/api/session');
  assert.equal(networkUrl('/native/api/session'), 'https://stow.example/native/api/session');
  const fetch = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => { const request = input as Request; assert.equal(request.url, 'https://stow.example/native/api/example'); assert.equal(request.headers.get('X-Stow-Vault'), account.vaultId); assert.equal(await request.text(), 'body'); return new Response('ok'); });
  await stowFetch(new Request('https://stow.example/api/example', { method: 'POST', body: 'body', headers: { 'X-Stow-Vault': account.vaultId } }));
  assert.equal(fetch.mock.callCount(), 1);
});

test('Android note exports transfer complete UTF-8 bytes, including multibyte chunk boundaries', async t => {
  const messages: any[] = [];
  t.mock.property(globalThis, 'window', { __STOW_SHELL__: { api: 1, account }, StowShell: { postMessage(message: string) { messages.push(JSON.parse(message)); } } } as any);
  const { downloadText } = await import('../src/download');
  const text = '✈️ Flight plan\n'.repeat(3000);
  downloadText(text, 'text/markdown', 'flight.md');
  assert.equal(messages[0].bytes, Buffer.byteLength(text));
  assert.equal(messages.at(-1).type, 'export-end');
  assert.equal(Buffer.concat(messages.slice(1, -1).map(message => Buffer.from(message.data, 'base64'))).toString('utf8'), text);
});
