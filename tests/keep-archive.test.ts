import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createWriteStream } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pack, type Header } from 'tar-stream';
import { stageKeepSource, type StagedKeepFile } from '../scripts/keep-archive.ts';
import { buildDir } from '../paths.ts';

async function fixture(t: TestContext) {
  const parent = path.join(buildDir, 'test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'keep-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function archive(filename: string, entries: { name: string; text?: string; type?: Header['type']; linkname?: string }[]) {
  const tar = pack(), finished = pipeline(tar, createGzip(), createWriteStream(filename, { mode: 0o600 }));
  for (const entry of entries) {
    const { text = '', ...header } = entry;
    await new Promise<void>((resolve, reject) => tar.entry(header, text, error => error ? reject(error) : resolve()));
  }
  tar.finalize(); await finished;
}
async function content(files: Map<string, StagedKeepFile>) {
  return Object.fromEntries(await Promise.all([...files].map(async ([name, file]) => [name, { size: file.size, text: await readFile(file.path, 'utf8') }])));
}

test('tgz and extracted directories stage identical normalized names and bytes with private permissions', async t => {
  const root = await fixture(t), source = path.join(root, 'source'), filename = path.join(root, 'notes.tgz');
  await mkdir(path.join(source, 'Takeout', 'Keep'), { recursive: true });
  const entries = [
    { name: './Takeout/Keep/旅行.json', text: '{"title":"旅行 😀"}' },
    { name: 'Takeout/Keep/photo.png', text: 'synthetic image bytes' },
    { name: 'Takeout/Keep/empty', text: '' },
  ];
  for (const entry of entries) await writeFile(path.join(source, entry.name), entry.text);
  // A directory header after its children is valid, but may not be repeated.
  await archive(filename, [...entries, { name: 'Takeout/Keep/', type: 'directory' }, { name: './', type: 'directory' }]);
  const fromTar = await stageKeepSource(filename, path.join(root, 'tar-stage'));
  const fromDirectory = await stageKeepSource(source, path.join(root, 'directory-stage'));
  assert.deepEqual(await content(fromTar), await content(fromDirectory));
  assert(fromTar.has('Takeout/Keep/旅行.json'));
  for (const file of fromTar.values()) assert.equal((await lstat(file.path)).mode & 0o777, 0o600);
  for (const dir of ['tar-stage', 'tar-stage/Takeout', 'tar-stage/Takeout/Keep']) assert.equal((await lstat(path.join(root, dir))).mode & 0o777, 0o700);
});

test('absolute, traversal, drive and backslash tar paths are rejected without writing outside staging', async t => {
  const root = await fixture(t);
  const paths = ['/absolute.json', '../escape.json', 'safe/../../escape.json', 'C:/escape.json', './C:/escape.json', 'safe\\escape.json'];
  for (const [index, name] of paths.entries()) {
    const filename = path.join(root, `unsafe-${index}.tgz`), staging = path.join(root, `stage-${index}`);
    await archive(filename, [{ name, text: 'unsafe' }]);
    await assert.rejects(stageKeepSource(filename, staging), /unsafe|absolute|traversal/);
    assert.deepEqual(await readdir(staging), []);
  }
  await assert.rejects(lstat(path.join(root, 'escape.json')), { code: 'ENOENT' });
});

test('tar links and special entries are rejected', async t => {
  const root = await fixture(t);
  for (const [index, type] of (['symlink', 'link', 'fifo', 'character-device'] as const).entries()) {
    const filename = path.join(root, `link-${index}.tar.gz`);
    await archive(filename, [{ name: 'entry', type, ...(type === 'symlink' || type === 'link' ? { linkname: '../outside' } : {}) }]);
    await assert.rejects(stageKeepSource(filename, path.join(root, `stage-${index}`)), /link|unsupported/);
  }
});

test('duplicate normalized paths and file/directory collisions are rejected in either entry order', async t => {
  const root = await fixture(t);
  const cases = [
    [{ name: 'same', text: 'one' }, { name: './same', text: 'two' }],
    [{ name: 'dir/', type: 'directory' as const }, { name: './dir/', type: 'directory' as const }],
    [{ name: 'file', text: 'one' }, { name: 'file/child', text: 'two' }],
    [{ name: 'parent/child', text: 'one' }, { name: 'parent', text: 'two' }],
  ];
  for (const [index, entries] of cases.entries()) {
    const filename = path.join(root, `duplicate-${index}.tgz`);
    await archive(filename, entries);
    await assert.rejects(stageKeepSource(filename, path.join(root, `stage-${index}`)), /duplicate|collision/);
  }
});

test('file, total and entry limits apply to both archives and directories', async t => {
  const root = await fixture(t), source = path.join(root, 'source'), filename = path.join(root, 'limits.tgz');
  await mkdir(source);
  await writeFile(path.join(source, 'one'), '12345'); await writeFile(path.join(source, 'two'), '67890');
  await archive(filename, [{ name: 'one', text: '12345' }, { name: 'two', text: '67890' }]);
  let index = 0;
  for (const input of [source, filename]) {
    await assert.rejects(stageKeepSource(input, path.join(root, `stage-${index++}`), { maxFileBytes: 4 }), /per-file/);
    await assert.rejects(stageKeepSource(input, path.join(root, `stage-${index++}`), { maxTotalBytes: 9 }), /total byte/);
    await assert.rejects(stageKeepSource(input, path.join(root, `stage-${index++}`), { maxEntries: 1 }), /entry count/);
    const files = await stageKeepSource(input, path.join(root, `stage-${index++}`), { maxFileBytes: 5, maxTotalBytes: 10, maxEntries: 2 });
    assert.equal(files.size, 2);
  }
});

test('directory staging rejects symlinks and hardlinks rather than following them', async t => {
  const root = await fixture(t), outside = path.join(root, 'outside'); await writeFile(outside, 'private fixture');
  const symlinkSource = path.join(root, 'symlinks'); await mkdir(symlinkSource); await symlink(outside, path.join(symlinkSource, 'linked'));
  await assert.rejects(stageKeepSource(symlinkSource, path.join(root, 'symlink-stage')), /link/);
  const hardlinkSource = path.join(root, 'hardlinks'); await mkdir(hardlinkSource); await link(outside, path.join(hardlinkSource, 'linked'));
  await assert.rejects(stageKeepSource(hardlinkSource, path.join(root, 'hardlink-stage')), /link/);
  const sourceLink = path.join(root, 'source-link'); await symlink(symlinkSource, sourceLink);
  await assert.rejects(stageKeepSource(sourceLink, path.join(root, 'source-link-stage')), /without links/);
});

test('nonempty or linked staging paths and staging inside the input are rejected', async t => {
  const root = await fixture(t), source = path.join(root, 'source'); await mkdir(source); await writeFile(path.join(source, 'note.json'), '{}');
  const occupied = path.join(root, 'occupied'); await mkdir(occupied); await writeFile(path.join(occupied, 'keep'), 'untouched');
  await assert.rejects(stageKeepSource(source, occupied), /must be empty/);
  assert.equal(await readFile(path.join(occupied, 'keep'), 'utf8'), 'untouched');
  const linkParent = path.join(root, 'linked-parent'); await symlink(occupied, linkParent);
  await assert.rejects(stageKeepSource(source, path.join(linkParent, 'stage')), /link/);
  await assert.rejects(lstat(path.join(occupied, 'stage')), { code: 'ENOENT' });
  await assert.rejects(stageKeepSource(source, path.join(source, 'stage')), /inside the input/);
  await assert.rejects(stageKeepSource(source, path.join('/tmp', 'keep-staging-outside-build')), /child of build/);
});

test('truncated compressed input fails clearly rather than returning a partial successful staging result', async t => {
  const root = await fixture(t), filename = path.join(root, 'truncated.tgz');
  await archive(filename, [{ name: 'note.json', text: '{"title":"synthetic"}' }]);
  const bytes = await readFile(filename); await writeFile(filename, bytes.subarray(0, bytes.length - 8));
  await assert.rejects(stageKeepSource(filename, path.join(root, 'stage')), /unexpected end|truncated/i);
});
