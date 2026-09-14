/** A real aged Yjs upload/download with a durable server restart. Separate Node
 * processes report OS high-water RSS, including encoding/application overhead. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, loadavg, cpus } from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { startServer } from '../server-fixture.ts';
import { ImportClient } from '../import-client.ts';
import { TRANSFER_FRAME_BYTES, TRANSFER_WINDOW, type TransferOptions } from '../../src/core/sync-transfer.ts';
import { buildDir } from '../../paths.ts';
import { LAB_FIXTURES } from './fixtures.ts';
import { CURRENT_SCHEMA, assertCurrentSchema } from '../../src/core/current-schema.ts';

const memory = () => ({ ...process.memoryUsage(), maxRSSBytes: process.resourceUsage().maxRSS * 1024 });
const dataDir = await mkdtemp(path.join(tmpdir(), 'stow-transfer-trial-')), proof = randomBytes(32).toString('hex');
const filename = path.join(LAB_FIXTURES, 'aged.yjs'), bytes = new Uint8Array(await readFile(filename));
let server: Awaited<ReturnType<typeof startServer>> | undefined, client: ImportClient | undefined;
const start = async () => {
  server = await startServer({ host: '127.0.0.1', port: 0, dataDir, authMode: 'proxy', proxySecret: proof }, path.join(buildDir, 'cargo-target', 'release', 'stow-test-driver'));
  return { port: server.port, memory: await server.memory() };
};
const stop = async () => { await server?.close(); server = undefined; };
const call = async (_message: { type: 'memory' }) => ({ memory: await server!.memory() });
  const metrics: Parameters<NonNullable<TransferOptions['onMetrics']>>[0][] = [];
  const input = (port: number) => ({ url: `http://127.0.0.1:${port}`, authMode: 'proxy' as const, user: 'aged-transfer@storage-lab.test', proxySecret: proof, onTransferMetrics: (value: typeof metrics[number]) => metrics.push(value) });
  try {
    const initial = await start(); client = await ImportClient.open(input(initial.port));
    const before = memory(), loadStart = performance.now(); Y.applyUpdate(client.doc, bytes);
    const expected = Y.encodeStateVector(client.doc), loadMs = performance.now() - loadStart;
    assertCurrentSchema(client.doc);
    const uploadedNotes = client.doc.getMap('notes').size;
    const startUpload = performance.now(); await client.submit(bytes); const uploadMs = performance.now() - startUpload;
    const serverUpload = await call({ type: 'memory' }), clientUpload = memory();
    await client.close(); client = undefined; await stop();
    const restarted = await start(), startDownload = performance.now(); client = await ImportClient.open(input(restarted.port));
    const downloadMs = performance.now() - startDownload;
    assert.deepEqual(Y.encodeStateVector(client.doc), expected);
    assert.equal(client.doc.getMap('notes').size, uploadedNotes); assertCurrentSchema(client.doc);
    await client.refresh();
    const serverDownload = await call({ type: 'memory' });
    const report = { schema: 1, at: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      node: process.version, cpu: cpus()[0]?.model, loadAverage: loadavg(), fixtureBytes: bytes.length,
      fixtureHash: createHash('sha256').update(bytes).digest('hex'), notes: uploadedNotes, replicatedHistory: 0, currentSchema: CURRENT_SCHEMA, serverRuntime: 'Rust',
      loadMs, uploadMs, downloadAfterRestartMs: downloadMs, before, serverInitial: initial.memory,
      clientUpload, serverUpload: serverUpload.memory, clientAfterDownload: memory(), serverDownload: serverDownload.memory, metrics };
    for (const metric of metrics) assert(metric.maxInFlightBytes <= TRANSFER_FRAME_BYTES * TRANSFER_WINDOW);
    await writeFile(path.join(buildDir, 'storage-lab', 'transfers.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally { await client?.close(); await stop(); await rm(dataDir, { recursive: true, force: true }); }
