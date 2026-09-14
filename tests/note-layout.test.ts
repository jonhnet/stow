import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geometricNeighbor, layoutNotes, type CardSize, type LayoutCard } from '../src/noteLayout';

function measured(heights: number[], width = 100) {
  const notes = heights.map((_, index) => ({ id: String.fromCharCode(97 + index) }));
  const sizes = new Map<string, CardSize>(notes.map((note, index) => [note.id, { width, height: heights[index] }]));
  return { notes, sizes };
}

function tile(id: string, left: number, top: number, height: number): LayoutCard<{ id: string }> {
  return { note: { id }, left, top, width: 100, height };
}

test('shortest-column packing uses the leftmost equal-height column and preserves note sequence', () => {
  const { notes, sizes } = measured([300, 50, 90, 40, 60, 20]);
  const layout = layoutNotes(notes, 3, 100, 10, sizes);
  assert.deepEqual(layout.cards.map(card => [card.note.id, card.left, card.top]), [
    ['a', 0, 0], ['b', 110, 0], ['c', 220, 0], ['d', 110, 60], ['e', 220, 100], ['f', 110, 110],
  ]);
  assert.equal(layout.height, 300);
  assert.equal(layout.columns, 3);
  assert(layout.cards.every((card, index) => card.note === notes[index]));

  const tied = measured([50, 50, 50, 50, 50, 50]);
  assert.deepEqual(layoutNotes(tied.notes, 3, 100, 10, tied.sizes).cards.map(card => [card.left, card.top]), [
    [0, 0], [110, 0], [220, 0], [0, 60], [110, 60], [220, 60],
  ]);
});

test('updated measured heights repack the suffix without changing source notes or cached sizes', () => {
  const { notes, sizes } = measured([50, 100, 60, 30]);
  const before = layoutNotes(notes, 2, 100, 10, sizes);
  const changed = new Map(sizes);
  changed.set('a', { width: 100, height: 200 });
  const after = layoutNotes(notes, 2, 100, 10, changed);
  assert.deepEqual(before.cards.map(card => [card.left, card.top]), [[0, 0], [110, 0], [0, 60], [110, 110]]);
  assert.deepEqual(after.cards.map(card => [card.left, card.top]), [[0, 0], [110, 0], [110, 110], [110, 180]]);
  assert.equal(after.height, 210);
  assert.deepEqual(notes.map(note => note.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sizes.get('a'), { width: 100, height: 50 });
  assert.deepEqual(changed.get('a'), { width: 100, height: 200 });
});

test('unknown cards and measurements from another width use the explicit 210px estimate', () => {
  const notes = [{ id: 'unknown' }, { id: 'resized' }, { id: 'measured' }];
  const sizes = new Map([['resized', { width: 99, height: 600 }], ['measured', { width: 100, height: 35 }]]);
  const layout = layoutNotes(notes, 2, 100, 10, sizes);
  assert.deepEqual(layout.cards.map(card => [card.height, card.left, card.top]), [[210, 0, 0], [210, 110, 0], [35, 0, 220]]);
  assert.equal(layout.height, 255);
  assert.equal(sizes.size, 2);
  assert.deepEqual(sizes.get('resized'), { width: 99, height: 600 });
});

test('empty groups have zero height and one-column layouts stack without a trailing gap', () => {
  assert.deepEqual(layoutNotes([], 3, 100, 10, new Map()), { cards: [], height: 0, columns: 3 });
  const { notes, sizes } = measured([15, 30, 10]);
  const layout = layoutNotes(notes, 1, 100, 10, sizes);
  assert.deepEqual(layout.cards.map(card => [card.left, card.top]), [[0, 0], [0, 25], [0, 65]]);
  assert.equal(layout.height, 75);
});

test('vertical arrows follow actual same-column neighbors in a ragged layout', () => {
  const { notes, sizes } = measured([300, 50, 90, 40, 60, 20]);
  const { cards } = layoutNotes(notes, 3, 100, 10, sizes);
  assert.equal(geometricNeighbor(cards, 'b', 'ArrowDown')?.note.id, 'd');
  assert.equal(geometricNeighbor(cards, 'd', 'ArrowDown')?.note.id, 'f');
  assert.equal(geometricNeighbor(cards, 'f', 'ArrowUp')?.note.id, 'd');
  assert.equal(geometricNeighbor(cards, 'e', 'ArrowUp')?.note.id, 'c');
  assert.notEqual(geometricNeighbor(cards, 'b', 'ArrowDown'), cards[1 + 3]);
  assert.equal(geometricNeighbor(cards, 'b', 'ArrowUp'), undefined);
  assert.equal(geometricNeighbor(cards, 'a', 'ArrowDown'), undefined);
});

test('vertical navigation prefers its column even when another column has a closer card', () => {
  const cards = [tile('current', 0, 100, 50), tile('above', 0, 0, 20), tile('below', 0, 300, 20), tile('nearAbove', 110, 50, 40), tile('nearBelow', 110, 160, 30)];
  assert.equal(geometricNeighbor(cards, 'current', 'ArrowUp')?.note.id, 'above');
  assert.equal(geometricNeighbor(cards, 'current', 'ArrowDown')?.note.id, 'below');
});

test('horizontal arrows choose an overlapping card in the adjacent column rather than an index neighbor', () => {
  const { notes, sizes } = measured([300, 50, 90, 40, 60, 20]);
  const { cards } = layoutNotes(notes, 3, 100, 10, sizes);
  assert.equal(geometricNeighbor(cards, 'e', 'ArrowLeft')?.note.id, 'f');
  assert.equal(geometricNeighbor(cards, 'd', 'ArrowRight')?.note.id, 'c');
  assert.equal(geometricNeighbor(cards, 'd', 'ArrowLeft')?.note.id, 'a');
  assert.equal(geometricNeighbor(cards, 'e', 'ArrowRight'), undefined);
  assert.equal(geometricNeighbor(cards, 'a', 'ArrowLeft'), undefined);
});

test('horizontal navigation stays in the adjacent column and selects the nearest vertical span', () => {
  const cards = [tile('current', 0, 100, 50), tile('farAbove', 110, 0, 20), tile('nearBelow', 110, 160, 20), tile('farColumnOverlap', 220, 100, 50)];
  assert.equal(geometricNeighbor(cards, 'current', 'ArrowRight')?.note.id, 'nearBelow');
  assert.equal(geometricNeighbor(cards, 'farColumnOverlap', 'ArrowLeft')?.note.id, 'nearBelow');
});

test('overlapping horizontal candidates use center distance and deterministic geometric ties', () => {
  const current = tile('current', 0, 0, 100);
  const above = tile('above', 110, 0, 40), below = tile('below', 110, 60, 40);
  for (const cards of [[current, above, below], [below, above, current]]) {
    assert.equal(geometricNeighbor(cards, 'current', 'ArrowRight')?.note.id, 'above');
  }
  const unequal = [tile('current', 0, 0, 100), tile('farCenter', 110, 0, 10), tile('nearCenter', 110, 20, 70)];
  assert.equal(geometricNeighbor(unequal, 'current', 'ArrowRight')?.note.id, 'nearCenter');
});

test('navigation does not wrap across group edges or invent a target for a missing note', () => {
  const { notes, sizes } = measured([50, 50, 50, 50]);
  const { cards } = layoutNotes(notes, 2, 100, 10, sizes);
  assert.equal(geometricNeighbor(cards, 'b', 'ArrowRight'), undefined);
  assert.equal(geometricNeighbor(cards, 'c', 'ArrowLeft'), undefined);
  assert.equal(geometricNeighbor(cards, 'd', 'ArrowDown'), undefined);
  assert.equal(geometricNeighbor(cards, 'a', 'ArrowUp'), undefined);
  assert.equal(geometricNeighbor(cards, 'missing', 'ArrowRight'), undefined);
  assert.equal(geometricNeighbor([], 'missing', 'ArrowRight'), undefined);
});
