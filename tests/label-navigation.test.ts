import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sortLabelsByRecentEdit } from '../src/labelNavigation';
import type { Label, Note } from '../src/core/types';

const catalog = (...names: string[]): Label[] => names.map(name => ({ name, color: 'default' }));
const names = (labels: readonly Label[]) => labels.map(label => label.name);
function note(id: string, labels: string[], updatedAt: number, flags: Partial<Pick<Note, 'archived' | 'trashed' | 'createdAt'>> = {}): Note {
  const section = { id, title: id, body: '', kind: 'text' as const, items: [], images: [], labels };
  return { ...section, color: 'default', pinned: false, archived: false, trashed: false, createdAt: 1, sortOrderDate: 1, updatedAt, sourceIds: [id], ...flags };
}

test('labels follow the most recently edited note in each set and reorder after another edit', () => {
  const labels = catalog('Alpha', 'Beta', 'Gamma');
  const notes = [note('a-latest', ['Alpha'], 40), note('beta', ['Beta'], 30), note('gamma', ['Gamma'], 20), note('a-old', ['Alpha'], 10)];
  assert.deepEqual(names(sortLabelsByRecentEdit(labels, notes)), ['Alpha', 'Beta', 'Gamma']);
  const edited = notes.map(value => value.id === 'gamma' ? { ...value, updatedAt: 50 } : value);
  assert.deepEqual(names(sortLabelsByRecentEdit(labels, edited)), ['Gamma', 'Alpha', 'Beta']);
  assert.deepEqual(names(sortLabelsByRecentEdit(labels, [...notes].reverse())), ['Alpha', 'Beta', 'Gamma']);
});

test('archived notes contribute recency while trashed notes do not', () => {
  const labels = catalog('Active', 'Archived', 'Trash only');
  const notes = [note('active', ['Active'], 10), note('archived', ['Archived'], 20, { archived: true }), note('trash', ['Active', 'Trash only'], 1000, { trashed: true })];
  assert.deepEqual(names(sortLabelsByRecentEdit(labels, notes)), ['Archived', 'Active', 'Trash only']);
});

test('equal recency uses exact-name lexical order, independent of locale or catalog order', () => {
  const labels = catalog('é', 'z', 'a', 'A');
  const notes = [note('shared', ['é', 'a', 'z', 'A'], 20)];
  assert.deepEqual(names(sortLabelsByRecentEdit(labels, notes)), ['A', 'a', 'z', 'é']);
});

test('unused catalog labels remain last even when used notes have zero or negative timestamps', () => {
  const labels = catalog('Unused Z', 'Pre-epoch', 'Unused A', 'Epoch');
  const notes = [note('old', ['Pre-epoch'], -100), note('epoch', ['Epoch'], 0)];
  assert.deepEqual(names(sortLabelsByRecentEdit(labels, notes)), ['Epoch', 'Pre-epoch', 'Unused A', 'Unused Z']);
  assert.deepEqual(names(sortLabelsByRecentEdit(labels, [])), ['Epoch', 'Pre-epoch', 'Unused A', 'Unused Z']);
});

test('matching is exact and sorting preserves catalog objects, colors, and input arrays', () => {
  const labels: readonly Label[] = Object.freeze([{ name: 'Work', color: 'mint' as const }, { name: 'work', color: 'coral' as const }, { name: 'Other', color: 'gray' as const }]);
  const notes = Object.freeze([note('lowercase', ['work'], 20), note('uppercase', ['Work'], 10), note('unlisted', ['Not in catalog'], 100)]);
  const result = sortLabelsByRecentEdit(labels, notes);
  assert.deepEqual(names(result), ['work', 'Work', 'Other']);
  assert.deepEqual(names(labels), ['Work', 'work', 'Other']);
  assert.equal(result[0], labels[1]); assert.equal(result[1], labels[0]); assert.equal(result[2], labels[2]);
  assert.equal(result[0].color, 'coral');
  assert.deepEqual(names(sortLabelsByRecentEdit([], notes)), []);
});
