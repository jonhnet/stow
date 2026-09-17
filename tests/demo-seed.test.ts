import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { seedDemo } from '../src/demo/seed';
import { sourceDir } from '../paths';
import catalogue from '../src/demo/kittens/catalogue.json';
import prompts from '../src/demo/kittens/prompts.json';

test('every demo seed has the complete tour, four distinct kittens, and no seed Undo history', () => {
  const variants = new Set<string>();
  for (let seed = 0; seed < 30; seed++) {
    const vault = new Vault();
    try {
      const images = seedDemo(vault, seed, 1_700_000_000_000);
      const notes = vault.getNotes();
      assert.equal(notes.length, 32);
      assert.equal(notes.filter(note => note.archived).length, 4);
      assert.equal(notes.filter(note => note.trashed).length, 3);
      assert.equal(notes.filter(note => note.pinned).length, 3);
      assert.equal(new Set(notes.map(note => note.color)).size, 12);
      assert.equal(vault.getLabels().length, 5);
      assert.equal(new Set(images.map(image => image.hash)).size, 4);
      assert.equal(notes.flatMap(note => note.images).length, 4);
      assert(notes.some(note => note.body.length > 8000));
      assert(notes.some(note => note.items.some(item => item.parentId && item.checked)));
      assert(notes.some(note => note.items.some(item => item.parentId && !item.checked)));
      assert.equal(vault.undoManager.undoStack.length, 0);
      assert.equal(vault.undoManager.redoStack.length, 0);
      assert.equal(vault.getPendingEdit(), null);
      assert(Y.encodeStateAsUpdate(vault.doc).byteLength < 200_000);
      variants.add(notes.map(note => note.title + note.body).join('\n'));
      const note = notes.find(note => note.items.length)!;
      const item = note.items.find(item => !item.parentId)!;
      vault.toggleItem(item.id); vault.undo();
      assert.deepEqual(vault.getNote(note.id)!.items, note.items);
    } finally { vault.destroy(); }
  }
  assert.equal(variants.size, 30);
});

test('all twelve generated kitten assets match the checked-in catalogue and prompt set', () => {
  assert.equal(catalogue.length, 12); assert.equal(prompts.prompts.length, 12);
  assert.equal(new Set(catalogue.map(image => image.hash)).size, 12);
  assert(catalogue.reduce((sum, image) => sum + image.size, 0) < 1_500_000);
  for (const image of catalogue) {
    const bytes = readFileSync(path.join(sourceDir, 'src/demo/kittens', image.file));
    assert.equal(bytes.subarray(8, 12).toString(), 'WEBP');
    assert.equal(bytes.length, image.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), image.hash);
    assert(prompts.prompts.some(prompt => prompt.id === image.id && prompt.prompt.includes('kitten')));
  }
});
