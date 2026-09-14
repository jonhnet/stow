import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  composeTextDescriptions, describeHistoryAction,
  describeTextChange, quoteExcerpt, textDescription,
} from '../src/core/history-description';
import type { HistoryState } from '../src/core/history-types';

const action = { type: 'text', noteId: 'note', field: 'body' } as const;
function state(body: string): HistoryState {
  return { groups: [['note']], sources: { note: {
    title: 'Minnesota trip', body, kind: 'text', color: 'default', pinned: false,
    archived: false, trashed: false, createdAt: 1, updatedAt: 1, items: {}, images: {},
  } } };
}

test('descriptions identify added, deleted and replaced content in the authored field', () => {
  assert.equal(describeHistoryAction(state('Call'), state('Call tomorrow'), action, 'Edited note text'), 'Note: added “ tomorrow”');
  assert.equal(describeHistoryAction(state('Call tomorrow'), state('Call'), action, 'Edited note text'), 'Note: deleted “ tomorrow”');
  assert.equal(describeHistoryAction(state('Buy lemons'), state('Buy oranges'), action, 'Edited note text'), 'Note: replaced “lemons” with “oranges”');
  assert.equal(describeHistoryAction(state('Cobalt'), state('Copper'), action, 'Edited note text'), 'Note: replaced “Cobalt” with “Copper”');
  const prefix = 'q'.repeat(2000);
  const longWord = describeHistoryAction(state(prefix + 'X'), state(prefix + 'Y'), action, 'Edited note text');
  assert(longWord.includes('X') && longWord.includes('Y'), 'Context must leave room for the actual changed letters in both excerpts');
  assert.equal(describeTextChange('Title', '', 'is a checklist'), 'Title: added “is a checklist”');
  assert.equal(describeTextChange('Item', '', 'Hard things'), 'Item: added “Hard things”');
});

test('excerpts bound long text without splitting emoji or concealing whitespace-only changes', () => {
  assert.equal(quoteExcerpt('😀'.repeat(121)), `“${'😀'.repeat(120)}…”`);
  assert.equal(quoteExcerpt('line\r\nnext\rend\n\tend'), '“line · next · end · \\tend”');
  assert.equal(describeTextChange('Note', '\n', ''), 'Note: deleted “ · ”');
  assert.equal(describeTextChange('Note', '', ' '), 'Note: added “ ”');
});

test('grouped typing describes the whole insertion including corrections', () => {
  const original = 'Existing note.';
  const values = ['Existing note. H', 'Existing note. Ha', 'Existing note. Hard', 'Existing note. Hardd', 'Existing note. Hard', 'Existing note. Hard things'];
  let before = original, combined: ReturnType<typeof textDescription>;
  for (const value of values) {
    const next = textDescription(state(before), state(value), action)!;
    combined = combined ? composeTextDescriptions(combined, next, before) : next;
    before = value;
  }
  assert.equal(describeTextChange(combined!.scope, combined!.removed, combined!.inserted), 'Note: added “ Hard things”');
  assert.equal(combined!.removed, '');
  assert.equal(combined!.index, original.length);
});

test('composed edits retain an exact reversible span across cursor moves, replacements and Unicode', () => {
  let seed = 42051;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let trial = 0; trial < 60; trial++) {
    const original = 'First 😀 note; last 🥕 item.';
    let before = original, combined: ReturnType<typeof textDescription>;
    for (let edit = 0; edit < 25; edit++) {
      const points = Array.from(before), index = random(points.length + 1);
      points.splice(index, random(Math.min(4, points.length - index) + 1), ...Array.from(['', 'xyz', '🌲', '\n'][random(4)]));
      const after = points.join('');
      const next = textDescription(state(before), state(after), action)!;
      combined = combined ? composeTextDescriptions(combined, next, before) : next;
      assert.equal(original.slice(combined.index, combined.index + combined.removed.length), combined.removed);
      assert.equal(original.slice(0, combined.index) + combined.inserted + original.slice(combined.index + combined.removed.length), after);
      assert.equal(after.slice(0, combined.index) + combined.removed + after.slice(combined.index + combined.inserted.length), original);
      before = after;
    }
  }
});

test('metadata descriptions identify the note acted on', () => {
  const before = state('body'), after = structuredClone(before);
  after.sources.note.pinned = true;
  assert.equal(describeHistoryAction(before, after, { type: 'metadata', noteId: 'note', field: 'pinned' }, 'Pinned note'), 'Note: pinned “Minnesota trip”');
});
