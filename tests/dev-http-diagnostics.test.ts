import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { traceDevHttp } from '../scripts/dev-http-diagnostics.ts';

test('HTTP trace distinguishes full and conditional code responses without collecting private request headers', async () => {
  const traces: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    traceDevHttp(req, res, trace => traces.push(trace));
    res.setHeader('Cache-Control', 'max-age=31536000,immutable');
    res.setHeader('ETag', '"asset-version"');
    if (req.headers['if-none-match'] === '"asset-version"') res.writeHead(304).end();
    else { res.setHeader('Content-Length', 4); res.end('code'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const asset = '/@fs/work/build/vite/deps/react-dom_client.js?v=abcd1234';
  const headers = { 'User-Agent': 'Mozilla/5.0 Firefox/152.0', Cookie: 'private-cookie', 'X-Auth-User': 'private-user', 'X-Stow-Proxy-Secret': 'private-proof' };
  try {
    assert.equal((await fetch(base + asset, { headers })).status, 200);
    assert.equal((await fetch(base + asset, { headers: { ...headers, 'If-None-Match': '"asset-version"' } })).status, 304);
    await fetch(base + '/api/session', { headers });
    await fetch(base + '/api/blobs/private-note-image', { headers });
    assert.equal(traces.length, 2);
    assert.deepEqual(traces.map(trace => trace.status), [200, 304]);
    assert.equal(traces[0].browser, 'Firefox/152.0');
    assert.equal(traces[0].contentLength, 4);
    assert.equal(traces[1].ifNoneMatch, '"asset-version"');
    assert.equal(traces[0].responseCacheControl, 'max-age=31536000,immutable');
    assert.equal(traces[0].version, 'abcd1234');
    assert.equal(JSON.stringify(traces).includes('private-'), false);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
