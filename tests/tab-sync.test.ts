import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { TabSync } from '../src/core/tab-sync';

function bus(docs: Y.Doc[]) {
  const sent: { sender: number; message: unknown }[] = [];
  const queued: { sender: number; message: unknown }[] = [];
  const peers = docs.map((doc, sender) => new TabSync(doc, message => post(sender, message)));
  function post(sender: number, message: unknown) {
    sent.push({ sender, message }); queued.push({ sender, message });
  }
  return {
    peers, sent, post,
    flush() {
      let delivered = 0;
      while (queued.length) {
        assert(++delivered < 100, 'The handshake must terminate without an echo loop');
        const { sender, message } = queued.shift()!;
        peers.forEach((peer, i) => { if (i !== sender) peer.receive(structuredClone(message)); });
      }
    },
  };
}

test('an unaccompanied tab announces only its state vector, regardless of document size', () => {
  const doc = new Y.Doc();
  try {
    doc.getText('body').insert(0, 'large body '.repeat(100000));
    const channel = bus([doc]);
    const hello = channel.peers[0].hello();
    channel.post(0, hello); channel.flush();
    assert(hello.vector.byteLength < 100);
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent.some(entry => entry.message instanceof Uint8Array), false);
  } finally { doc.destroy(); }
});

test('one hello exchanges missing edits in both directions using small differences', () => {
  const left = new Y.Doc(), right = new Y.Doc();
  try {
    left.getText('shared').insert(0, 'shared text '.repeat(10000));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    left.getText('left').insert(0, 'Offline left');
    right.getText('right').insert(0, 'Offline right');
    const channel = bus([left, right]);
    channel.post(0, channel.peers[0].hello()); channel.flush();
    for (const doc of [left, right]) {
      assert.equal(doc.getText('left').toString(), 'Offline left');
      assert.equal(doc.getText('right').toString(), 'Offline right');
    }
    const updates = channel.sent.map(entry => entry.message).filter(message => message instanceof Uint8Array);
    assert.equal(updates.length, 2);
    assert(updates.every(update => update.byteLength < 200));
  } finally { left.destroy(); right.destroy(); }
});

test('matching vectors still exchange deletions, and an ordinary broadcast does not echo', () => {
  const left = new Y.Doc(), right = new Y.Doc();
  try {
    left.getText('body').insert(0, 'Removed');
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    left.getText('body').delete(0, 7);
    assert.deepEqual(Y.encodeStateVector(left), Y.encodeStateVector(right));
    const channel = bus([left, right]);
    channel.post(1, channel.peers[1].hello()); channel.flush();
    assert.equal(right.getText('body').toString(), '');
    let update!: Uint8Array;
    left.on('update', bytes => { update = bytes; });
    left.getText('body').insert(0, 'Next edit');
    const before = channel.sent.length;
    channel.post(0, update); channel.flush();
    assert.equal(channel.sent.length, before + 1);
    assert.equal(right.getText('body').toString(), 'Next edit');
  } finally { left.destroy(); right.destroy(); }
});

test('three simultaneous tab openings converge and replies are addressed to the initiating tab', () => {
  const docs = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
  try {
    docs.forEach((doc, i) => doc.getMap('edits').set(String(i), i));
    const channel = bus(docs);
    channel.peers.forEach((peer, i) => channel.post(i, peer.hello()));
    channel.flush();
    for (const doc of docs) assert.equal(doc.getMap('edits').size, 3);
  } finally { docs.forEach(doc => doc.destroy()); }
});

test('tabs from the previous build can still exchange binary updates and bare hellos', () => {
  const current = new Y.Doc(), old = new Y.Doc();
  try {
    current.getMap('data').set('current', true);
    old.getMap('data').set('old', true);
    const sent: unknown[] = [];
    const sync = new TabSync(current, message => sent.push(message));
    // The old handler recognizes hello (ignoring extra fields) and returns a full update.
    assert.equal(sync.hello().type, 'hello');
    sync.receive(Y.encodeStateAsUpdate(old));
    sync.receive({ type: 'hello' });
    assert.equal(sent.length, 1);
    assert(sent[0] instanceof Uint8Array);
    Y.applyUpdate(old, sent[0]);
    assert.deepEqual(old.getMap('data').toJSON(), current.getMap('data').toJSON());
  } finally { current.destroy(); old.destroy(); }
});
