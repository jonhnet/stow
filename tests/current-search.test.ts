import test from 'node:test';
import assert from 'node:assert/strict';
import { CurrentNoteSearch } from '../src/currentSearch';
import { Vault } from '../src/core/vault';

function controlledBuild() {
  const tasks: (() => void)[] = [];
  let time = 0;
  const index = new CurrentNoteSearch({
    yieldTask: () => new Promise(resolve => tasks.push(resolve)),
    now: () => time++,
  });
  const tick = async () => { assert(tasks.length); tasks.shift()!(); await Promise.resolve(); };
  return { index, tick, async finish() { while (tasks.length) await tick(); } };
}

test('building yields within a checklist and readiness waits for the complete index', async () => {
  const vault = new Vault();
  const id = vault.createNote('checklist', { title: 'Many items' });
  const note = vault.getNote(id)!;
  let reads = 0;
  const items = Array.from({ length: 100 }, (_, i) => ({ id: String(i), noteId: id, checked: false, rank: i,
    get text() { reads++; return `Needle ${i}`; } }));
  const build = controlledBuild();
  let ready = false;
  const done = build.index.update([{ ...note, items }]).then(() => { ready = true; });
  assert.equal(reads, 0, 'No parsing in the task that queues the build');
  await build.tick();
  assert(reads > 0 && reads < 100, 'A large checklist spans multiple tasks');
  assert.equal(ready, false);
  await build.finish(); await done;
  assert.equal(build.index.matches(id, 'needle 99'), true);
  vault.destroy();
});

test('changes and removals during a build supersede stale work without rebuilding completed notes', async () => {
  const vault = new Vault();
  const first = vault.createNote('text', { body: 'Original' });
  const second = vault.createNote('text', { body: 'Remove me' });
  const third = vault.createNote('text', { body: 'Keep me' });
  const build = controlledBuild();
  let readable = true;
  const unchanged = { ...vault.getNote(third)!, get body() { assert(readable); return 'Keep me'; } };
  const initial = build.index.update([unchanged]);
  await build.finish(); await initial;
  readable = false;
  const old = build.index.update([vault.getNote(first)!, vault.getNote(second)!, unchanged]);
  await build.tick();
  vault.setNoteText(first, 'body', 'Replacement');
  const latest = build.index.update([vault.getNote(first)!, unchanged]);
  await build.finish(); await Promise.all([old, latest]);
  assert.equal(build.index.matches(first, 'original'), false);
  assert.equal(build.index.matches(first, 'replacement'), true);
  assert.equal(build.index.matches(second, 'remove me'), false);
  assert.equal(build.index.matches(third, 'keep me'), true);
  vault.destroy();
});

test('canceling a build releases pending work and allows effect cleanup/restart', async () => {
  const vault = new Vault();
  const id = vault.createNote('text', { body: 'Ready after restart' });
  const build = controlledBuild();
  const old = build.index.update(vault.getNotes());
  build.index.cancel();
  const restarted = build.index.update(vault.getNotes());
  await build.finish(); await Promise.all([old, restarted]);
  assert.equal(build.index.matches(id, 'ready after restart'), true);
  vault.destroy();
});

test('current search reuses unchanged note text and drops replaced and removed content', async () => {
  const vault = new Vault();
  const firstId = vault.createNote('text', { title: 'First', body: 'Old searchable phrase' });
  const secondId = vault.createNote('text', { title: 'Second', body: 'Unchanged phrase' });
  const first = vault.getNote(firstId)!, second = vault.getNote(secondId)!;
  let mayRead = true;
  const unchanged = { ...second, get body() { assert(mayRead, 'An unchanged note must not be reindexed.'); return second.body; } };
  const index = new CurrentNoteSearch();
  await index.update([first, unchanged]);
  mayRead = false;
  vault.setNoteText(firstId, 'body', 'New searchable phrase');
  await index.update([vault.getNote(firstId)!, unchanged]);
  assert.equal(index.matches(firstId, 'old searchable'), false);
  assert.equal(index.matches(firstId, 'new searchable'), true);
  assert.equal(index.matches(secondId, 'unchanged phrase'), true);
  await index.update([unchanged]);
  assert.equal(index.matches(firstId, 'new searchable'), false);
  vault.doc.destroy();
});

test('current search includes imported labels and attachment filenames without keeping replaced labels', async () => {
  const vault = new Vault();
  const id = vault.createNote('text', { title: 'Imported recording' });
  const note = vault.getNote(id)!;
  const labeled = { ...note, labels: ['Travel plans', 'Voice memos'], images: [{ id: 'audio', noteId: id, hash: 'a'.repeat(64), name: 'recording.3gp', type: 'audio/3gp', size: 10 }] };
  const index = new CurrentNoteSearch();
  await index.update([labeled]);
  assert.equal(index.matches(id, 'travel plans'), true);
  assert.equal(index.matches(id, 'voice memos'), true);
  assert.equal(index.matches(id, 'recording.3gp'), true);
  await index.update([{ ...labeled, labels: ['Trip ideas'], images: note.images }]);
  assert.equal(index.matches(id, 'travel plans'), false);
  assert.equal(index.matches(id, 'voice memos'), false);
  assert.equal(index.matches(id, 'trip ideas'), true);
  vault.doc.destroy();
});

test('current search finds visible escaped text and formatted phrases while preserving source and link destinations', async () => {
  const vault = new Vault();
  const id = vault.createNote('checklist', {
    title: 'Literal title_*',
    body: 'a\\_b \\*literal\\* &amp;lt; &lt;tag&gt;\n**visible** *phrase* and [friendly label](https://example.com/hidden-destination)',
  });
  const item = vault.addItem(id, 'item\\_name \\*asterisk\\* &amp;lt; and **bold** *checklist*');
  const note = vault.getNote(id)!;
  const index = new CurrentNoteSearch();
  await index.update([{ ...note, labels: ['Label_*'] }]);
  for (const query of ['a_b', '*literal*', '&lt;', '<tag>', 'visible phrase', 'friendly label', 'https://example.com/hidden-destination', 'a\\_b', '**visible**', 'item_name', '*asterisk*', 'bold checklist', 'literal title_*', 'label_*']) {
    assert.equal(index.matches(id, query), true, query);
  }
  vault.setNoteText(id, 'body', 'Replacement text');
  vault.setItemText(item, 'Replacement item');
  await index.update([vault.getNote(id)!]);
  for (const query of ['a_b', 'a\\_b', 'item_name', 'visible phrase', 'hidden-destination']) assert.equal(index.matches(id, query), false, query);
  vault.destroy();
});
