import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';

test('checklist projection waits for owner and text in either arrival order without repairing the record', t => {
  for (const ownerFirst of [true, false]) {
    const vault = new Vault(); t.after(() => vault.destroy());
    const owner = vault.createNote('checklist');
    const author = new Y.Doc(); t.after(() => author.destroy());
    Y.applyUpdate(author, Y.encodeStateAsUpdate(vault.doc));
    const item = new Y.Map<unknown>(); author.getMap('items').set('row', item);
    const receive = () => Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(author, Y.encodeStateVector(vault.doc)), 'remote');
    const first = ownerFirst ? 'noteId' : 'text', second = ownerFirst ? 'text' : 'noteId';
    item.set(first, ownerFirst ? owner : new Y.Text('arriving')); receive();
    assert.deepEqual(vault.getItems(owner), []);
    item.set(second, ownerFirst ? new Y.Text('arriving') : owner); receive();
    let updates = 0; vault.doc.on('update', () => updates++);
    assert.deepEqual(vault.getItems(owner), [{ id: 'row', noteId: owner, text: 'arriving', checked: false, rank: 0 }]);
    assert.equal(updates, 0);
    assert.equal(item.has('checked'), false);
    assert.equal(item.has('rank'), false);
    (item.get('text') as Y.Text).insert(8, ' later'); receive();
    assert.equal(vault.getItems(owner)[0].text, 'arriving later');
  }
});

test('a malformed checklist text is reported instead of being presented as valid editable text', t => {
  const vault = new Vault(); t.after(() => vault.destroy());
  const owner = vault.createNote('checklist'), item = new Y.Map<unknown>();
  vault.doc.transact(() => { vault.items.set('bad', item); item.set('noteId', owner); item.set('text', 42); });
  assert.throws(() => vault.getItems(owner), /checklist.*text/i);
  assert.equal(item.get('text'), 42, 'projection must preserve the received bytes');
  item.set('text', new Y.Text('repaired by a later update'));
  assert.equal(vault.getItems(owner)[0].text, 'repaired by a later update');
});

test('conversion metadata is atomic while unknown fields and existing optional defaults remain tolerated', async () => {
  const { readChecklistItem } = await import('../src/core/checklist-record');
  const doc = new Y.Doc(), item = doc.getMap<unknown>('item');
  try {
    item.set('noteId', 'n'); item.set('text', new Y.Text('line'));
    item.set('rank', '12'); item.set('checked', 1); item.set('future-field', { opaque: true });
    item.set('conversion', { source: 'source-span', text: 'line', rank: 12 });
    assert.equal(readChecklistItem('row', item)!.rank, 12);
    assert.equal(readChecklistItem('row', item)!.checked, true);
    assert.deepEqual(readChecklistItem('row', item)!.conversion, { source: 'source-span', text: 'line', rank: 12 });
    item.set('conversion', { source: 'source-span' });
    assert.throws(() => readChecklistItem('row', item), /conversion metadata/);
    assert.deepEqual(item.get('conversion'), { source: 'source-span' });
  } finally { doc.destroy(); }
});
