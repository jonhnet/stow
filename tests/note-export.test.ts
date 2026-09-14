import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown, { markdownHtml, markdownText } from '../src/Markdown';
import { copyNotes, downloadNotes, formatNotes } from '../src/noteExport';
import type { Note } from '../src/core/types';

const { createDocument } = createRequire(import.meta.url)('@mixmark-io/domino') as { createDocument(html: string): Document };
function note(id: string, title: string, body = '', extra: Partial<Note> = {}): Note {
  return { id, title, body, kind: 'text', items: [], images: [], color: 'default', pinned: false, archived: false, trashed: false, createdAt: 1, updatedAt: 1, sortOrderDate: 1, sourceIds: [id], ...extra };
}
function globalValue(t: TestContext, name: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); });
}

test('selected export retains the whole note, all completed families and effective child indentation in visual order', () => {
  const first = note('a', 'Primary', 'Former title\n\n**Authored** [link](https://example.test/path)\n\nSecond body', {
    kind: 'checklist', labels: ['Specific label'],
    items: [
      { id: 'done', noteId: 'a', text: 'Finished root', checked: true, rank: 0 },
      { id: 'root', noteId: 'a', text: '**Active** parent', checked: false, rank: 1 },
      { id: 'child', noteId: 'a', text: 'Finished child', checked: true, rank: 0, parentId: 'root' },
      { id: 'last', noteId: 'a', text: 'Late child', checked: false, rank: 1, parentId: 'child' },
    ],
  });
  const other = note('c', 'Next selected', 'Last body');
  const markdown = formatNotes([first, other], 'markdown');
  assert(markdown.includes(first.body), 'Original Markdown source is preserved');
  assert.match(markdown, /- \[ \] \*\*Active\*\* parent\n    - \[x\] Finished child\n    - \[ \] Late child\n- \[x\] Finished root/);
  assert.match(markdown, /# Primary[\s\S]*Former title[\s\S]*\n---\n\n# Next selected/);
  const text = formatNotes([first, other], 'text');
  assert.match(text, /Authored link \(https:\/\/example.test\/path\)/);
  assert.match(text, /- \[ \] Active parent\n    - \[x\] Finished child/);
  assert.match(text, /Labels: Specific label/);
  const html = createDocument(formatNotes([first, other], 'html'));
  assert.deepEqual(Array.from(html.querySelectorAll('article > h1')).map(h => h.textContent), ['Primary', 'Next selected']);
  assert.equal(html.querySelectorAll('h2').length, 0);
  assert(html.body.textContent!.includes('Former title'));
  assert.equal(html.querySelectorAll('article:first-child > ul > li').length, 2);
  assert.equal(html.querySelectorAll('article:first-child > ul > li:first-child > ul > li').length, 2);
  assert.equal(html.querySelectorAll('[aria-label="Checked"]').length, 2);
});

test('safe HTML export shares Markdown rendering rules and retains text tables and link destinations', () => {
  const source = '# Heading\n\n> Quote\n\n3. Three\n4. Four\n   - Nested\n\n| Name | Value |\n| --- | ---: |\n| a | **b** |\n\n<script>alert(1)</script> [bad](javascript:alert(2)) [private](/api/images/hash) [safe](https://example.test/path) ![diagram](https://example.test/image.png)';
  const expected = createDocument(renderToStaticMarkup(createElement(Markdown, { text: source })));
  const html = createDocument(markdownHtml(source));
  assert.equal(html.body.innerHTML, expected.querySelector('.markdown-body')!.innerHTML);
  assert.equal(html.querySelectorAll('script,img,input').length, 0);
  assert.deepEqual(Array.from(html.querySelectorAll('a')).map(anchor => anchor.getAttribute('href')), ['https://example.test/path', 'https://example.test/image.png']);
  assert.equal(html.querySelector('th:last-child')!.getAttribute('style'), 'text-align:right');
  const text = markdownText(source);
  assert.match(text, /3\. Three\n4\. Four\n   - Nested/);
  assert.match(text, /Name \| Value\na \| b/);
  assert.match(text, /safe \(https:\/\/example.test\/path\)/);
  assert.match(text, /diagram \(https:\/\/example.test\/image.png\)/);
  assert.doesNotMatch(text, /javascript:|\/api\/images/);
  assert.equal(markdownText('person@example.test', true), 'person@example.test');
});

test('attachment placeholders preserve filenames without embedding protected URLs or image bytes', () => {
  const value = note('a', 'Attachments', '', { images: [
    { id: 'i', noteId: 'a', hash: 'a'.repeat(64), name: 'photo <family>.jpg', type: 'image/jpeg', size: 42 },
    { id: 'j', noteId: 'a', hash: 'b'.repeat(64), name: 'memo.ogg', type: 'audio/ogg', size: 80 },
  ] });
  const text = formatNotes([value], 'text');
  assert.match(text, /\[Image: photo <family>\.jpg \(file not included\)\]/);
  assert.match(text, /\[Attachment: memo\.ogg \(file not included\)\]/);
  for (const format of ['text', 'markdown', 'html'] as const) assert.doesNotMatch(formatNotes([value], format), /\/api\/|data:|[ab]{64}/);
  const html = createDocument(formatNotes([value], 'html'));
  assert.equal(html.querySelectorAll('img,a,family').length, 0);
  assert(html.body.textContent!.includes('photo <family>.jpg'));
});

test('noninteractive Markdown displays identical link labels without anchors', () => {
  const source = '**See** [website](https://example.test/) and ![diagram](https://example.test/image.png)';
  const html = createDocument(renderToStaticMarkup(createElement(Markdown, { text: source, interactive: false })));
  assert.equal(html.querySelectorAll('a,img').length, 0);
  assert.equal(html.body.textContent, 'See website and diagram');
  assert.equal(html.querySelector('strong')!.textContent, 'See');
});

test('copy writes one ClipboardItem with plain and rich representations and propagates write rejection', async t => {
  let parts: Record<string, Blob> = {}, calls = 0;
  class ClipboardEntry { constructor(value: Record<string, Blob>) { parts = value; } }
  globalValue(t, 'ClipboardItem', ClipboardEntry);
  const failure = new Error('Clipboard permission denied');
  globalValue(t, 'navigator', { clipboard: { write: async (items: unknown[]) => { calls++; assert.equal(items.length, 1); assert(items[0] instanceof ClipboardEntry); if (calls === 2) throw failure; } } });
  const value = note('a', 'Title', '**Bold** [destination](https://example.test/path)');
  await copyNotes([value]);
  assert.deepEqual(Object.keys(parts), ['text/plain', 'text/html']);
  assert.equal(await parts['text/plain'].text(), formatNotes([value], 'text'));
  assert.equal(await parts['text/html'].text(), formatNotes([value], 'html'));
  assert.equal(parts['text/plain'].type, 'text/plain');
  await assert.rejects(copyNotes([value]), error => error === failure);
  assert.equal(calls, 2, 'No alternate clipboard write is attempted');
  globalValue(t, 'navigator', {});
  await assert.rejects(copyNotes([value]), /requires a current browser over HTTPS or localhost/);
});

test('downloads produce safe filenames and one selected textual file, clean up URLs, and leave inputs unchanged', async t => {
  const blobs: Blob[] = [], revoked: string[] = [], clicked: string[] = [];
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => { blobs.push(blob); return `blob:export-${blobs.length}`; });
  t.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let removed = 0, appended = 0;
  globalValue(t, 'document', { body: { append: () => appended++ }, createElement: () => ({
    href: '', download: '', click() { clicked.push(this.download); }, remove() { removed++; },
  }) });
  const value = note('a', '../bad/name:<title> *?', '**Source**');
  const before = structuredClone(value);
  downloadNotes([value], 'markdown');
  assert.match(clicked[0], /\.md$/); assert.doesNotMatch(clicked[0], /[/\\:*?"<>|]|^\./);
  assert.equal(blobs[0].type, 'text/markdown;charset=utf-8');
  assert.equal(await blobs[0].text(), formatNotes([value], 'markdown'));
  downloadNotes([value, note('b', 'Second')], 'html');
  assert.equal(clicked[1], 'stow-2-notes.html');
  const html = await blobs[1].text();
  assert.match(html, /^<!doctype html>/); assert.match(html, /<meta charset="utf-8">/);
  assert.equal(createDocument(html).querySelectorAll('article').length, 2);
  assert.equal(appended, 2); assert.equal(removed, 2);
  assert.deepEqual(revoked, []); t.mock.timers.tick(1000);
  assert.deepEqual(revoked, ['blob:export-1', 'blob:export-2']);
  assert.deepEqual(value, before);
  assert.throws(() => formatNotes([], 'text'), /Select at least one note/);
  assert.throws(() => formatNotes([value], 'json' as 'text'), /Unsupported note export format/);
});
