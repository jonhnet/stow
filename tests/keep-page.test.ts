import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchKeepPage, parseKeepPage, type KeepPageSource } from '../scripts/keep-page.ts';

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function row(value: string, indented = false, checked = false, attributes = '') {
  return `<div class="bVEB4e-rymPhb-ibnC6b" ${attributes}><div class="rymPhb-ibnC6b-bVEB4e-sM5MNb" style="margin-left: ${indented ? 25 : 0}px;"><div role="checkbox" aria-checked="${checked}"></div><div class="rymPhb-ibnC6b-bVEB4e-fmcmS-haAclf"><p>${escape(value)}</p></div></div></div>`;
}
function card(title: string, active: string, checked = '', attributes = '') {
  return `<div class="IZ65Hb-n0tgWb" ${attributes}><div role="textbox" class="vIzZGf-r4nke-YPqjbf">${escape(title)}</div><div>${active}</div>${checked ? `<div class="NYTeh">${checked}</div>` : ''}</div>`;
}
function page(cards: string, extra = '') {
  return parseKeepPage(`<html><body><a aria-label="Google Account: Synthetic Owner (owner@example.invalid)"></a>${extra}${cards}</body></html>`);
}
function source(title: string, items: [string, string, boolean?][], extra: Partial<KeepPageSource> = {}): KeepPageSource {
  return { id: 'source', title, archived: false, trashed: false, items: items.map(([id, text, checked = false]) => ({ id, text, checked })), ...extra };
}

test('static parsing reads the account header, explicit margins and checked flags without executing page scripts', () => {
  const parsed = page(card('A', row('Root') + row('Child 😀', true)), '<div aria-label="Collaborator other@example.invalid"></div><script>globalThis.keepPageTestExecuted = true</script><img src="http://127.0.0.1:9/never-fetch">');
  assert.equal(parsed.identity, 'owner@example.invalid');
  assert.equal((globalThis as any).keepPageTestExecuted, undefined);
  assert.equal(parsed.notes[0].title, 'A');
  assert.deepEqual(parsed.notes[0].items.map(item => [item.text, item.indented, item.parentIndex, item.checked]), [['Root', false, undefined, false], ['Child 😀', true, 0, false]]);
  assert.equal(parsed.notes[0].truncated, false);
  assert.deepEqual(parsed.notes[0].issues, []);
});

test('missing or multiple account headers and unsupported layouts fail clearly', () => {
  assert.throws(() => parseKeepPage(card('A', row('Root'))), /exactly one Google Account/);
  assert.throws(() => page(card('A', row('Root')), '<a aria-label="Google Account: Other (other@example.invalid)"></a>'), /exactly one Google Account/);
  assert.throws(() => page('<div>Unsupported layout</div>'), /supported Google Keep note-card layout/);
});

test('exact unique evidence produces stable parent links and complete coverage', () => {
  const parsed = page(card('A', row('Root') + row('Child one', true) + row('Child two', true)));
  const matched = matchKeepPage(parsed, [source('A', [['root', 'Root'], ['first', 'Child one'], ['second', 'Child two']])]);
  assert.deepEqual(matched.issues, []);
  assert.deepEqual(matched.matches, [{ cardIndex: 0, noteId: 'source', links: [{ itemId: 'first', parentId: 'root' }, { itemId: 'second', parentId: 'root' }], matchedItems: 3, sourceItems: 3, complete: true }]);
});

test('checked subsections supply their own roots and never inherit the active root', () => {
  const parsed = page(card('A', row('Active root'), row('Orphan checked child', true, true) + row('Checked root', false, true) + row('Checked child', true, true)));
  const matched = matchKeepPage(parsed, [source('A', [['active', 'Active root'], ['orphan', 'Orphan checked child', true], ['checked-root', 'Checked root', true], ['checked-child', 'Checked child', true]])]);
  assert.equal(parsed.notes[0].items[1].parentIndex, undefined);
  assert.deepEqual(matched.matches[0].links, [{ itemId: 'checked-child', parentId: 'checked-root' }]);
  assert.ok(matched.issues.some(issue => issue.reason === 'unresolved-parent-link:1'));
});

test('ellipsis cutoffs reset parent inference and truncated labels never match by prefix', () => {
  const parsed = page(card('A', row('Root') + row('Complete child', true) + row('Long child…', true) + '<div class="bVEB4e-rymPhb-zcdHbf">…</div>' + row('After cutoff', true)));
  const matched = matchKeepPage(parsed, [source('A', [['root', 'Root'], ['complete', 'Complete child'], ['long', 'Long child with omitted text'], ['after', 'After cutoff']])]);
  assert.equal(parsed.notes[0].truncated, true);
  assert.equal(parsed.notes[0].items[3].parentIndex, undefined);
  assert.deepEqual(matched.matches[0].links, [{ itemId: 'complete', parentId: 'root' }]);
  assert.equal(matched.matches[0].complete, false);
  assert.ok(matched.issues.some(issue => issue.reason === 'truncated-item-label:2'));
  assert.ok(matched.issues.some(issue => issue.reason === 'unresolved-parent-link:3'));
});

test('a truncated root cannot supply a parent even when a full child uniquely identifies the note', () => {
  const parsed = page(card('A', row('Long root…') + row('Complete child', true)));
  const matched = matchKeepPage(parsed, [source('A', [['root', 'Long root with omitted text'], ['child', 'Complete child']])]);
  assert.equal(matched.matches.length, 1);
  assert.deepEqual(matched.matches[0].links, []);
});

test('NBSP and wrapping paragraph newline normalize without collapsing real whitespace or resolving collisions', () => {
  const parsed = page(card('A', row('Root\u00a0') + row('Child  text', true)));
  const correct = source('A', [['root', 'Root \n'], ['child', 'Child  text']]);
  assert.equal(matchKeepPage(parsed, [correct]).matches[0].links.length, 1);
  const wrongSpacing = source('A', [['root', 'Root '], ['child', 'Child text']]);
  assert.deepEqual(matchKeepPage(parsed, [wrongSpacing]).matches, []);
  const collision = source('A', [['root', 'Root '], ['other-root', 'Root\u00a0'], ['child', 'Child  text']]);
  const ambiguous = matchKeepPage(parsed, [collision]);
  assert.deepEqual(ambiguous.matches[0].links, []);
  assert.ok(ambiguous.issues.some(issue => issue.reason === 'ambiguous-source-item:0'));
});

test('duplicate titles require unique complete-item evidence, and duplicate item labels never guess IDs', () => {
  const parsed = page(card('A', row('Root') + row('Child', true)));
  const a = source('A', [['root', 'Root'], ['child', 'Child']]);
  const b = source('A', [['other-root', 'Different root'], ['other-child', 'Different child']], { id: 'other' });
  assert.equal(matchKeepPage(parsed, [a, b]).matches[0].noteId, 'source');
  assert.deepEqual(matchKeepPage(parsed, [a, { ...a, id: 'duplicate' }]).matches, []);
  const duplicateChild = source('A', [['root', 'Root'], ['child', 'Child'], ['other-child', 'Child']]);
  assert.deepEqual(matchKeepPage(parsed, [duplicateChild]).matches[0].links, []);
});

test('archived or trashed sources cannot supply matches', () => {
  const parsed = page(card('A', row('Root') + row('Child', true)));
  for (const extra of [{ archived: true }, { trashed: true }]) {
    assert.deepEqual(matchKeepPage(parsed, [source('A', [['root', 'Root'], ['child', 'Child']], extra)]).matches, []);
  }
});

test('hidden cards and rows never provide matching evidence or parent links', () => {
  const original = source('A', [['root', 'Root'], ['child', 'Child'], ['unavailable', 'Unavailable parent'], ['orphan', 'Orphan'], ['hidden-child', 'Hidden child']]);
  assert.deepEqual(matchKeepPage(page(card('A', row('Root') + row('Child', true), '', 'hidden')), [original]).matches, []);
  const parsed = page(card('A', row('Root') + row('Child', true) + row('Unknown stale content', false, false, 'style="display:none !important"')
    + row('Unavailable parent', false, false, 'aria-hidden="true"') + row('Orphan', true) + row('Hidden child', true, false, 'style="visibility:hidden"')));
  const matched = matchKeepPage(parsed, [original]);
  assert.equal(matched.matches.length, 1, 'Hidden unmatched text cannot reject the visible note evidence');
  assert.deepEqual(matched.matches[0].links, [{ itemId: 'child', parentId: 'root' }]);
  assert.ok(matched.issues.some(issue => issue.reason === 'hidden-item-row:2'));
  assert.ok(matched.issues.some(issue => issue.reason === 'unresolved-parent-link:4'));
});

test('unknown depth and malformed rows invalidate parent inference until another explicit root', () => {
  const unknown = row('Unknown').replace('margin-left: 0px', 'margin-left: 50px');
  const parsed = page(card('A', row('Root') + unknown + row('Child', true)));
  const matched = matchKeepPage(parsed, [source('A', [['root', 'Root'], ['unknown', 'Unknown'], ['child', 'Child']])]);
  assert.equal(parsed.notes[0].items[1].valid, false);
  assert.equal(parsed.notes[0].items[2].parentIndex, undefined);
  assert.deepEqual(matched.matches[0].links, []);
});

test('multiple rendered copies of the same source are excluded rather than combined', () => {
  const parsed = page(card('A', row('Root') + row('Child', true)) + card('A', row('Root') + row('Child')));
  const matched = matchKeepPage(parsed, [source('A', [['root', 'Root'], ['child', 'Child']])]);
  assert.deepEqual(matched.matches, []);
  assert.equal(matched.issues.filter(issue => issue.reason === 'source-note-rendered-more-than-once').length, 2);
});
