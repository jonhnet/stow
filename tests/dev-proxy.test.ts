import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { startDevServer } from '../scripts/dev-server-fixture.ts';

test('the real Vite API proxy accepts browser-origin requests and image uploads', async t => {
  const dev = await startDevServer(); t.after(dev.close);
  const session = await fetch(`${dev.origin}/api/session`);
  assert.equal(session.status, 200);
  const { vaultId } = await session.json();

  const browserSession = await fetch(`${dev.origin}/api/session`, { headers: { Origin: dev.origin } });
  assert.equal(browserSession.status, 200, await browserSession.text());
  const bytes = Buffer.from('Synthetic development attachment');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const headers = { Origin: dev.origin, 'X-Stow-Vault': vaultId, 'X-Stow-Blob-Sources': '["dev-proxy-note"]' };
  const upload = await fetch(`${dev.origin}/api/blobs/${hash}`, { method: 'PUT', headers, body: bytes });
  assert.equal(upload.status, 204, await upload.text());
  const download = await fetch(`${dev.origin}/api/blobs/${hash}`, { headers });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
});

test('the development proxy retains foreign-origin rejection and vault identity binding', async t => {
  const dev = await startDevServer(); t.after(dev.close);
  const { vaultId } = await (await fetch(`${dev.origin}/api/session`)).json();
  const bytes = Buffer.from('Rejected attachment');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const url = `${dev.origin}/api/blobs/${hash}`;

  const foreign = await fetch(url, { method: 'PUT', body: bytes,
    headers: { Origin: 'https://foreign.example', 'X-Stow-Vault': vaultId } });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'Origin is not allowed');
  const wrongAccount = await fetch(url, { method: 'PUT', body: bytes,
    headers: { Origin: dev.origin, 'X-Stow-Vault': 'another-vault-identity' } });
  assert.equal(wrongAccount.status, 409, await wrongAccount.clone().text());
  assert.equal((await wrongAccount.json()).code, 'vault_mismatch');
  const absent = await fetch(url, { headers: { 'X-Stow-Vault': vaultId } });
  assert.equal(absent.status, 404, 'Rejected requests must not store a blob in the verified vault');
});
