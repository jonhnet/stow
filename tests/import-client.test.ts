import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import path from 'node:path';
import * as Y from 'yjs';
import { ImportClient, type ImportClientOptions } from '../scripts/import-client.ts';
import { startServer, type ServerOptions } from '../scripts/server-fixture.ts';
import { buildDir } from '../paths.ts';

const proof = 'import-client-test-private-proof-'.repeat(2);
const user = 'import-owner@example.test';
async function fixture(t: TestContext, options: Partial<ServerOptions> = {}) {
  const directory = path.join(buildDir, 'test-tmp'); await mkdir(directory, { recursive: true });
  const dataDir = await mkdtemp(path.join(directory, 'import-client-'));
  let server = await startServer({ host: '127.0.0.1', port: 0, dataDir, authMode: 'proxy', proxySecret: proof, password: '', ...options });
  const clients: ImportClient[] = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const input = (): ImportClientOptions => ({ url: `http://127.0.0.1:${server.port}`, authMode: options.authMode ?? 'proxy', ...(options.authMode === 'password' ? { password: options.password } : { user, proxySecret: proof }) });
  return {
    dataDir, input, port: () => server.port,
    async client(overrides: Partial<ImportClientOptions> = {}) { const client = await ImportClient.open({ ...input(), ...overrides }); clients.push(client); return client; },
    async restart() { await server.close(); server = await startServer({ host: '127.0.0.1', port: 0, dataDir, authMode: 'proxy', proxySecret: proof, password: '', ...options }); },
  };
}

test('proxy import binds the requested account and rejects wrong identity, proof and authentication mode', async t => {
  const server = await fixture(t);
  const owner = await server.client();
  assert.equal(owner.account.user, user); assert.equal(owner.account.authMode, 'proxy');
  await assert.rejects(server.client({ user: 'other@example.test', expectedVaultId: owner.account.vaultId }), /identity/);
  await assert.rejects(server.client({ proxySecret: 'incorrect-private-proof'.repeat(3) }), /authentication failed/);
  await assert.rejects(server.client({ proxySecret: undefined }), /requires/);
  await assert.rejects(server.client({ authMode: 'password', password: 'irrelevant' }), /authentication failed/);
  const other = await server.client({ user: 'other@example.test' });
  assert.notEqual(owner.account.vaultId, other.account.vaultId);
  assert.equal(other.doc.getMap('notes').size, 0);
});

test('password import logs in only after an explicit password-mode session response', async t => {
  const server = await fixture(t, { authMode: 'password', password: 'correct import password' });
  await assert.rejects(server.client({ password: 'wrong import password' }), /authentication failed/);
  await assert.rejects(server.client({ password: undefined }), /configured Stow password/);
  await assert.rejects(server.client({ authMode: 'proxy', user, proxySecret: proof }), /authentication mode/);
  const client = await server.client();
  assert.equal(client.account.user, 'Personal vault'); assert.equal(client.account.authMode, 'password');
  client.doc.getMap('notes').set('private', 'password account');
  await client.submit(Y.encodeStateAsUpdate(client.doc));
  const reopened = await server.client({ expectedVaultId: client.account.vaultId });
  assert.equal(reopened.doc.getMap('notes').get('private'), 'password account');
});

test('matching acknowledgments mean durable data, duplicate updates are safe, and refresh never commits pending edits', async t => {
  const server = await fixture(t);
  const first = await server.client(), second = await server.client();
  const received = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Peer update did not arrive')), 2000);
    second.doc.once('update', () => { clearTimeout(timer); resolve(); });
  });
  first.doc.getMap('notes').set('one', 'durable');
  const update = Y.encodeStateAsUpdate(first.doc);
  await first.submit(update); await received; await first.submit(update);
  assert.equal(second.doc.getMap('notes').get('one'), 'durable');
  await Promise.all([second.refresh(), second.refresh()]);
  assert.equal(second.doc.getMap('notes').get('one'), 'durable');
  first.doc.getMap('notes').set('pending', 'must remain local');
  await first.refresh(); await second.refresh();
  assert.equal(first.doc.getMap('notes').get('pending'), 'must remain local');
  assert.equal(second.doc.getMap('notes').has('pending'), false);
  await server.restart();
  const reopened = await server.client({ expectedVaultId: first.account.vaultId });
  assert.equal(reopened.doc.getMap('notes').get('one'), 'durable');
  assert.equal(reopened.doc.getMap('notes').has('pending'), false);
});

test('a twenty-MiB update submits and reopens successfully, while an oversized update is rejected before sending', async t => {
  const server = await fixture(t);
  const client = await server.client();
  const body = 'x'.repeat(20 * 1024 * 1024);
  client.doc.getText('large-note').insert(0, body);
  await client.submit(Y.encodeStateAsUpdate(client.doc));
  const reopened = await server.client();
  assert.equal(reopened.doc.getText('large-note').length, body.length);
  assert.equal(reopened.doc.getText('large-note').toString(), body);
  await assert.rejects(client.submit(new Uint8Array(128 * 1024 * 1024 + 1)), /128 MiB/);
  await reopened.refresh();
  assert.equal(reopened.doc.getText('large-note').length, body.length);
});

test('blobs are verified, uploaded durably and reused by hash; wrong file contents block later note commit', async t => {
  const server = await fixture(t);
  const client = await server.client();
  const bytes = Buffer.from('synthetic original image bytes');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const filename = path.join(server.dataDir, 'original-fixture'); await writeFile(filename, bytes);
  const blob = { hash, path: filename, size: bytes.length, type: 'image/png' };
  assert.equal(await client.putBlob(blob), 'uploaded');
  assert.equal(await client.putBlob(blob), 'existing');
  assert.deepEqual(await readFile(path.join(server.dataDir, 'users', client.account.vaultId, 'blobs', hash)), bytes);
  client.doc.getMap('notes').set('pending', 'do not commit after failed media');
  await assert.rejects(client.putBlob({ ...blob, hash: 'a'.repeat(64) }), /SHA-256/);
  await assert.rejects(client.submit(Y.encodeStateAsUpdate(client.doc)), /SHA-256/);
  const fresh = await server.client(); assert.equal(fresh.doc.getMap('notes').size, 0);
});

/** A small same-origin fixture can reject selected routes without changing production APIs. */
async function front(t: TestContext, port: number, intercept: (req: IncomingMessage) => { status: number; headers?: Record<string, string>; body?: string } | undefined) {
  const server = createServer((req, res) => {
    const blocked = intercept(req);
    if (blocked) { res.writeHead(blocked.status, blocked.headers); res.end(blocked.body); return; }
    const upstream = httpRequest({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    const upstream = httpRequest({ hostname: '127.0.0.1', port, path: req.url, method: 'GET', headers: req.headers });
    upstream.on('upgrade', (response, target, targetHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) target.write(head); if (targetHead.length) socket.write(targetHead);
      target.pipe(socket); socket.pipe(target);
      target.on('error', () => socket.destroy()); socket.on('error', () => target.destroy());
    });
    upstream.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`); response.resume(); });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('redirected authentication is rejected without following its destination or leaking credentials', async t => {
  const server = await fixture(t);
  let destinationRequests = 0;
  const url = await front(t, server.port(), req => {
    if (req.url === '/destination') destinationRequests++;
    if (req.url === '/api/session') return { status: 302, headers: { location: '/destination' } };
  });
  let message = '';
  try { await ImportClient.open({ ...server.input(), url }); } catch (error) { message = (error as Error).message; }
  assert.match(message, /redirected/); assert.equal(message.includes(proof), false); assert.equal(destinationRequests, 0);
});

test('a server-rejected blob poisons the import connection and leaves server notes unchanged', async t => {
  const server = await fixture(t);
  const url = await front(t, server.port(), req => req.method === 'PUT' && req.url?.startsWith('/api/blobs/') ? { status: 507 } : undefined);
  const client = await server.client({ url });
  const bytes = Buffer.from('rejected image bytes'), filename = path.join(server.dataDir, 'rejected-fixture'); await writeFile(filename, bytes);
  client.doc.getMap('notes').set('pending', 'not committed');
  await assert.rejects(client.putBlob({ hash: createHash('sha256').update(bytes).digest('hex'), path: filename, size: bytes.length, type: 'image/png' }), /507/);
  await assert.rejects(client.submit(Y.encodeStateAsUpdate(client.doc)), /507/);
  const fresh = await server.client(); assert.equal(fresh.doc.getMap('notes').size, 0);
});

test('account changes after connecting block both refresh and note submission', async t => {
  const server = await fixture(t);
  let changed = false;
  const url = await front(t, server.port(), req => changed && req.url === '/api/session' ? {
    status: 200, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authenticated: true, required: true, authMode: 'proxy', user: 'another@example.test', vaultId: 'd'.repeat(64) }),
  } : undefined);
  const client = await server.client({ url }); changed = true;
  await assert.rejects(client.refresh(), /identity/);
  await assert.rejects(client.submit(Y.encodeStateAsUpdate(client.doc)), /identity/);
  const fresh = await server.client(); assert.equal(fresh.doc.getMap('notes').size, 0);
});

test('server rejection never counts as an acknowledgment and blocks subsequent submissions', async t => {
  const server = await fixture(t), client = await server.client();
  await assert.rejects(client.submit(new Uint8Array([1])), /Invalid sync message/);
  const pending = new Y.Doc(); pending.getMap('notes').set('pending', 'rejected connection');
  await assert.rejects(client.submit(Y.encodeStateAsUpdate(pending)), /Invalid sync message/); pending.destroy();
  const fresh = await server.client(); assert.equal(fresh.doc.getMap('notes').size, 0);
});

test('blob redirects are rejected without following them or issuing an upload', async t => {
  const server = await fixture(t);
  let uploads = 0, destinations = 0;
  const url = await front(t, server.port(), req => {
    if (req.url === '/unexpected-destination') destinations++;
    if (req.method === 'PUT') uploads++;
    if (req.method === 'HEAD' && req.url?.startsWith('/api/blobs/')) return { status: 302, headers: { location: '/unexpected-destination' } };
  });
  const client = await server.client({ url });
  const bytes = Buffer.from('redirected fixture'), filename = path.join(server.dataDir, 'redirected-fixture'); await writeFile(filename, bytes);
  await assert.rejects(client.putBlob({ hash: createHash('sha256').update(bytes).digest('hex'), path: filename, size: bytes.length, type: 'image/png' }), /redirected/);
  assert.equal(uploads, 0); assert.equal(destinations, 0);
});
