import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { buildDir } from '../paths.ts';
import Markdown, { plainText } from '../src/Markdown.tsx';
import { keepPlaintextMarkdown, readKeepSource } from '../scripts/keep-source.ts';

const source = (extra: Record<string, unknown> = {}) => ({ title: 'Synthetic note', color: 'DEFAULT',
  isPinned: false, isArchived: false, isTrashed: false,
  createdTimestampUsec: 1420070400000000, userEditedTimestampUsec: 1520070456000000, ...extra });
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const render = (text: string, inline = false) => renderToStaticMarkup(createElement(Markdown, { text, inline }));
async function fixture(t: TestContext, files: Record<string, string | Buffer>) {
  await mkdir(buildDir, { recursive: true });
  const directory = await mkdtemp(path.join(buildDir, 'keep-source-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input');
  await mkdir(input);
  for (const [name, bytes] of Object.entries(files)) {
    const filename = path.join(input, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes);
  }
  return { input, staging: path.join(directory, 'staged') };
}

test('source conversion retains timestamps, flags, colors, labels, checklist order, raw JSON and all media', async t => {
  const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: '#739ac1' } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#57a134' } }).jpeg().toBuffer();
  const raw = JSON.stringify(source({ color: 'GRAY', isPinned: true, isArchived: true, isTrashed: true,
    textContent: 'A literal *star*', labels: [{ name: 'Travel' }, { name: 'Ideas' }],
    listContent: [{ text: 'First *literal*', isChecked: true }, { text: 'Second', isChecked: false }],
    attachments: [{ filePath: 'picture.png', mimetype: 'image/png' }, { filePath: 'voice.3gp', mimetype: 'audio/3gp' }],
    sharees: [{ email: 'synthetic@example.invalid', isOwner: false, type: 'USER' }], tasks: [{ id: 'source-task' }],
  }), null, 3) + '\n';
  const { input, staging } = await fixture(t, { 'Takeout/Keep/note.json': raw, 'Takeout/Keep/note.html': '<p>Duplicate export view</p>',
    'Takeout/Keep/picture.png': png, 'Takeout/Keep/voice.3gp': Buffer.from('synthetic audio bytes'),
    'Takeout/Keep/orphan.jpg': jpeg, 'Takeout/Keep/Labels.txt': 'Travel\nIdeas\n' });
  const result = await readKeepSource(input, staging);
  assert.equal(result.notes.length, 1);
  const note = result.notes[0];
  assert.deepEqual([note.createdAt, note.updatedAt], [1420070400000, 1520070456000]);
  assert.deepEqual([note.color, note.pinned, note.archived, note.trashed, note.kind], ['gray', true, true, true, 'checklist']);
  assert.deepEqual(note.labels, ['Travel', 'Ideas']);
  assert.deepEqual(note.takeout, { sourcePath: 'Takeout/Keep/note.json', rawHash: hash(raw), labels: ['Travel', 'Ideas'] });
  assert.deepEqual(note.items, [{ text: 'First \\*literal\\*', checked: true }, { text: 'Second', checked: false }]);
  assert.deepEqual(note.attachments.map(value => [value.name, value.type]), [['picture.png', 'image/png'], ['voice.3gp', 'audio/3gp']]);
  assert.equal(result.blobs.length, 5);
  const original = result.blobs.find(value => value.role === 'source-json')!;
  assert.equal(await readFile(original.path, 'utf8'), raw);
  assert.equal(original.hash, hash(raw));
  assert.ok(result.blobs.some(value => value.role === 'unreferenced' && value.hash === hash(jpeg)));
  assert.ok(result.blobs.some(value => value.role === 'audio'));
  assert.ok(!result.blobs.some(value => value.type === 'text/html'));
  assert.equal(result.counts.validatedImages, 2);
  assert.deepEqual(result.warnings.map(value => value.code), ['collaborators-retained-in-source-only', 'task-metadata-retained-in-source-only', 'unreferenced-file-preserved']);
});

test('ordinary Keep HTML uses authoritative plaintext without interpreting Markdown or collapsing spaces', async t => {
  const plain = '## Heading\n- item\n1. numbered\n> quote\n---\n\n**literal** and _literal_ [label](url)\n    indented  text\n\ttab\n`code` &amp; <script> 😀\n';
  const { input, staging } = await fixture(t, { 'note.json': JSON.stringify(source({ textContent: plain,
    textContentHtml: '<p><span style="font-weight:400;white-space:pre-wrap">The HTML whitespace is deliberately different.</span></p>' })) });
  const result = await readKeepSource(input, staging);
  assert.equal(result.notes[0].body, keepPlaintextMarkdown(plain));
  assert.deepEqual(result.warnings, []);
  const html = render(result.notes[0].body);
  assert.doesNotMatch(html, /<(?:h[1-6]|ul|ol|li|blockquote|hr|pre|code|em|strong|script)\b/);
  assert.match(html, /## Heading<br\/>- item<br\/>1\. numbered<br\/>&gt; quote<br\/>---/);
  assert.match(html, /    indented  text<br\/>\ttab/);
  assert.match(html, /`code` &amp;amp; &lt;script&gt; 😀/);
});

test('plaintext escaping prevents accidental Markdown across bodies and inline checklists', () => {
  for (const plain of ['***', '___', '---', '===', '#### heading', '+ bullet', '- bullet', '123) item', '1. item',
    '![image](https://example.invalid/a.png)', '[a]: https://example.invalid', '| a | b |', '~~deleted~~', '\\*star*',
    '&lt;not a tag&gt;', '<tag>', '    four spaces', '\ttab']) {
    const html = render(keepPlaintextMarkdown(plain));
    assert.doesNotMatch(html, /<(?:h[1-6]|ul|ol|li|blockquote|hr|pre|code|em|strong|s|table|img)\b/, plain);
    assert.doesNotMatch(render(keepPlaintextMarkdown(plain), true), /<(?:em|strong|s|img)\b/, plain);
  }
});

test('literal URLs retain underscores, query ampersands, encoded text and readable labels', () => {
  const plain = 'See https://example.invalid/a_b/~user?q=two&next=three%20words. Or www.example.org/a_b and a_b@example.invalid.';
  const html = render(keepPlaintextMarkdown(plain), true);
  assert.match(html, /href="https:\/\/example.invalid\/a_b\/~user\?q=two&amp;next=three%20words"[^>]*>https:\/\/example.invalid\/a_b\/~user\?q=two&amp;next=three%20words<\/a>\./);
  assert.match(html, />www.example.org\/a_b<\/a>/);
  assert.match(html, /href="mailto:a_b@example.invalid"[^>]*>a_b@example.invalid<\/a>/);
  assert.doesNotMatch(html, /\\_|\\~|amp;amp/);
});

test('line-edge whitespace and ordinary line breaks survive inline rendering exactly', () => {
  const plain = '  Two spaces\n One space\n    Four spaces\nTrailing  \n\ttab\t\n  \n\nlast ';
  assert.equal(plainText(keepPlaintextMarkdown(plain), true), plain);
});

test('Keep CSS bold, italic and strike become inline Markdown; headings and links remain meaningful', async t => {
  const { input, staging } = await fixture(t, { 'note.json': JSON.stringify(source({
    textContent: 'Heading\nBold and italic; done. Link',
    textContentHtml: '<h2>Heading</h2><p><span style="font-weight:700">Bold</span> and <span style="font-style:italic">italic</span>; <span style="text-decoration:line-through">done</span>. <a href="https://example.invalid">Link</a></p>',
    listContent: [{ text: 'very bold', isChecked: false, textHtml: '<p><span style="font-weight:700;white-space:pre-wrap">very bold</span></p>' }],
  })) });
  const result = await readKeepSource(input, staging);
  const html = render(result.notes[0].body);
  assert.match(html, /<h2>Heading<\/h2>/);
  assert.match(html, /<strong>Bold<\/strong> and <em>italic<\/em>; <s>done<\/s>/);
  assert.match(html, /href="https:\/\/example.invalid\/"/);
  assert.equal(render(result.notes[0].items[0].text, true), '<span class="markdown-inline"><strong>very bold</strong></span>');
  assert.deepEqual(result.warnings.map(value => value.code), ['rich-text-converted-to-markdown']);
});

test('rich span boundaries retain one space and preserve formatting, literal entities and link destinations', async t => {
  const cases = [
    { text: 'Bold tail', textHtml: '<p><span style="font-weight:700">Bold </span><span>tail</span></p>' },
    { text: 'Before bold', textHtml: '<p><span>Before</span><span style="font-weight:700"> bold</span></p>' },
    { text: 'Before bold after', textHtml: '<p><span>Before</span><span style="font-weight:700"> bold </span><span>after</span></p>' },
    { text: 'Italic tail', textHtml: '<p><span style="font-style:italic">Italic </span>tail</p>' },
    { text: 'Done tail', textHtml: '<p><span style="text-decoration:line-through">Done </span>tail</p>' },
    { text: 'See named &#32; link now', textHtml: '<p><span style="font-weight:700">See </span><a href="https://example.invalid/a_b?q=1&amp;x=2"><span>named &amp;#32; link</span></a><span> now</span></p>' },
  ];
  const { input, staging } = await fixture(t, { 'note.json': JSON.stringify(source({
    textContent: cases[0].text, textContentHtml: cases[0].textHtml,
    listContent: cases.map(value => ({ ...value, isChecked: false })),
  })) });
  const { notes: [note] } = await readKeepSource(input, staging);
  assert.equal(plainText(note.body), cases[0].text);
  for (const [index, item] of note.items.entries()) assert.equal(plainText(item.text, true), cases[index].text);
  assert.equal(render(note.items[0].text, true), '<span class="markdown-inline"><strong>Bold</strong> tail</span>');
  assert.match(render(note.items[1].text, true), /Before <strong>bold<\/strong>/);
  assert.match(render(note.items[2].text, true), /Before <strong>bold<\/strong> after/);
  assert.match(render(note.items[3].text, true), /<em>Italic<\/em> tail/);
  assert.match(render(note.items[4].text, true), /<s>Done<\/s> tail/);
  assert.match(render(note.items[5].text, true), /<strong>See<\/strong> <a href="https:\/\/example.invalid\/a_b\?q=1&amp;x=2"[^>]*>named &amp;#32; link<\/a> now/);
});

test('underline stays in source metadata with an explicit warning and the plaintext stays visible', async t => {
  const { input, staging } = await fixture(t, { 'note.json': JSON.stringify(source({ textContent: 'underlined  words\nnext',
    textContentHtml: '<p><span style="text-decoration:underline">underlined  words</span><br>next</p>' })) });
  const result = await readKeepSource(input, staging);
  assert.equal(result.notes[0].body, 'underlined  words\nnext');
  assert.deepEqual(result.warnings, [{ code: 'underline-retained-in-source-only', sourcePaths: ['note.json'] }]);
});

test('annotation URLs missing from note text are appended once and existing URLs stay unduplicated', async t => {
  const added = { title: 'A [useful] link', url: 'https://example.invalid/missing?q=1&x=2', description: 'Metadata description', source: 'WEBLINK' };
  const { input, staging } = await fixture(t, { 'note.json': JSON.stringify(source({ textContent: 'Existing https://example.invalid/existing',
    annotations: [{ ...added, url: 'https://example.invalid/existing' }, added, added] })) });
  const result = await readKeepSource(input, staging);
  const html = render(result.notes[0].body);
  assert.equal((html.match(/href=/g) ?? []).length, 2);
  assert.match(html, /href="https:\/\/example.invalid\/missing\?q=1&amp;x=2"[^>]*>A \[useful\] link<\/a>/);
  assert.deepEqual(result.warnings, [{ code: 'missing-annotation-links-added-to-body', sourcePaths: ['note.json'] }]);
});

test('identical content is stored once while every source path remains in the manifest', async t => {
  const raw = JSON.stringify(source({ textContent: 'Same content' }));
  const { input, staging } = await fixture(t, { 'a.json': raw, 'b.json': raw, 'first.txt': 'Same extra file', 'second.txt': 'Same extra file' });
  const result = await readKeepSource(input, staging);
  assert.equal(result.notes.length, 2);
  assert.equal(result.blobs.length, 2);
  assert.deepEqual(result.blobs.find(value => value.role === 'source-json')!.sourcePaths, ['a.json', 'b.json']);
  assert.deepEqual(result.blobs.find(value => value.role === 'unreferenced')!.sourcePaths, ['first.txt', 'second.txt']);
});

test('invalid source schemas and unsafe or missing attachment references stop preflight', async t => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ color: 'UNRECOGNIZED' }, /color is unsupported/],
    [{ title: '\ud800' }, /unpaired surrogate/],
    [{ createdTimestampUsec: Number.MAX_SAFE_INTEGER + 1 }, /safe integer/],
    [{ listContent: [{ text: 'item', isChecked: 'yes' }] }, /must be a boolean/],
    [{ attachments: [{ filePath: '../elsewhere.png', mimetype: 'image/png' }] }, /path is unsafe/],
    [{ attachments: [{ filePath: '/absolute.png', mimetype: 'image/png' }] }, /path is unsafe/],
    [{ attachments: [{ filePath: 'missing.png', mimetype: 'image/png' }] }, /attachment is missing/],
  ];
  for (const [extra, error] of cases) {
    const { input, staging } = await fixture(t, { 'note.json': JSON.stringify(source(extra)) });
    await assert.rejects(readKeepSource(input, staging), error);
  }
});

test('corrupt images including unreferenced images stop preflight without a decoder alternative', async t => {
  for (const referenced of [true, false]) {
    const { input, staging } = await fixture(t, { 'note.json': JSON.stringify(source(referenced
      ? { attachments: [{ filePath: 'broken.png', mimetype: 'image/png' }] } : {})), 'broken.png': Buffer.from('not an image') });
    await assert.rejects(readKeepSource(input, staging), /image cannot be decoded by Stow/);
  }
});

test('unknown note and checklist metadata is retained verbatim and reported', async t => {
  const raw = JSON.stringify(source({ reminder: { date: 'source-only' }, listContent: [{ text: 'Nested item', isChecked: false, indent: 1 }] }));
  const { input, staging } = await fixture(t, { 'note.json': raw });
  const result = await readKeepSource(input, staging);
  assert.equal(await readFile(result.blobs[0].path, 'utf8'), raw);
  assert.deepEqual(result.warnings.map(value => value.code), ['extra-checklist-metadata-retained-in-source-only', 'extra-note-metadata-retained-in-source-only']);
});
