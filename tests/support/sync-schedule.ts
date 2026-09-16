import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openDB } from 'idb';
import * as Y from 'yjs';
import type { TestContext } from 'node:test';
import { buildDir } from '../../paths';
import { Vault } from '../../src/core/vault';
import { applyImport } from '../../src/core/import';
import { LocalPersistence } from '../../src/core/persistence';
import { writePersistenceBatch } from '../../src/core/persistence-write';
import { TabSync } from '../../src/core/tab-sync';
import { isEmptyUpdate } from '../../src/core/yjs-updates';
import { checklistGroups } from '../../src/core/checklist';
import { CurrentNoteSearch } from '../../src/currentSearch';

export type Action = 'append' | 'item' | 'item-edit' | 'attachment' | 'check' | 'parent' | 'cycle' | 'merge' | 'label' | 'delete-label' | 'color' | 'archive' | 'move' | 'convert' | 'undo' | 'redo' | 'delete' | 'late-edit' | 'deliver' | 'partition' | 'reconnect' | 'reload' | 'compact' | 'fail-write';
export interface Step { id: number; action: Action; actor: number; target?: number; value?: number }
export interface Schedule { version: 1; seed: number; sharedTabs: boolean; steps: Step[] }
export function random(seed: number) {
  let state = seed >>> 0;
  return (length: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor(state / 0x1_0000_0000 * length); };
}
export const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
export function generatedSchedule(seed: number, length = 75): Schedule {
  const choose = random(seed);
  // Conversion is covered separately: concurrent conversion has an executable TODO.
  const actions: Action[] = ['append', 'item', 'item-edit', 'attachment', 'check', 'parent', 'cycle', 'merge', 'label', 'delete-label', 'color', 'archive', 'move', 'undo', 'redo', 'deliver', 'deliver', 'partition', 'reconnect', 'reload', 'compact', 'fail-write'];
  const steps: Step[] = Array.from({ length }, (_, id) => ({ id: id + 1, action: actions[choose(actions.length)], actor: choose(3), target: choose(3), value: choose(12) }));
  steps.push({ id: length + 1, actor: 0, action: 'delete' }, { id: length + 2, actor: 2, action: 'late-edit' });
  return { version: 1, seed, sharedTabs: seed % 2 === 0, steps };
}

interface Packet { from: number; to: number; message: unknown; tab: boolean }
interface Replica { vault: Vault; persistence: LocalPersistence; tabs: TabSync; errors: Error[]; fail: boolean; compactions: number; stop(): void }

/** Application-operation scheduler, not a simulated implementation of the server.
 * Runs the real Vault, IndexedDB adapter/compactor, edit recovery and TabSync.
 * A lane is FIFO; retries may duplicate complete updates. A reconnect uses state
 * vectors so dropped and dependency-blocked updates must recover naturally.
 * Browser/transport tests separately exercise StowStore and the Rust server. */
export class SyncSchedule {
  readonly replicas: Replica[] = [];
  readonly events: unknown[] = [];
  private packets: Packet[] = [];
  private online = [true, true, true];
  private owners = new Set<string>();
  private expected = new Set<string>();
  private authored = new Map<string, number>();
  private deleted = false;
  private tick = 0;
  private uuid = 0;
  private now = 1_000_000;
  private epoch = [0, 0, 0];
  private database(actor: number) { return `schedule-${this.plan.seed}-${this.plan.sharedTabs && actor < 2 ? 'tabs' : actor}`; }
  constructor(readonly plan: Schedule, t: TestContext) {
    globalThis.indexedDB = new IDBFactory();
    // Each operation has its own identity namespace: replay and trace reduction
    // do not depend on how many UUIDs earlier operations allocated.
    t.mock.method(globalThis.crypto, 'randomUUID', () => `${this.plan.seed.toString(16).padStart(8, '0')}-${this.tick.toString(16).padStart(4, '0')}-4000-8000-${(++this.uuid).toString(16).padStart(12, '0')}`);
    t.mock.method(Date, 'now', () => this.now);
  }
  private post(from: number, message: unknown, tab: boolean) {
    for (let to = 0; to < 3; to++) if (to !== from && (!tab || this.database(from) === this.database(to))) {
      this.packets.push({ from, to, tab, message: structuredClone(message) });
    }
  }
  private async open(actor: number) {
    const doc = new Y.Doc();
    doc.clientID = 100 + actor + (++this.epoch[actor]) * 10;
    const vault = new Vault(doc), errors: Error[] = [];
    const owner = `${actor}:${this.epoch[actor]}`;
    const replica = { vault, errors, fail: false, compactions: 0 } as Replica;
    const persistence = new LocalPersistence(doc, {
      databaseName: this.database(actor), onError: error => errors.push(error),
      writer: { close() {}, async write(db, request, compacting) {
        if (replica.fail) { replica.fail = false; throw new DOMException('Injected scheduled write failure', 'QuotaExceededError'); }
        const result = await writePersistenceBatch(db, request, compacting);
        if (result.compaction) replica.compactions++;
        return result;
      } },
      edits: { owner, ownership: { acquire: async key => {
        if (this.owners.has(key)) return null;
        this.owners.add(key); return () => { this.owners.delete(key); };
      } }, getPending: () => vault.getPendingEdit(), onPendingChange: fn => vault.onPendingEditChange(fn), recover: draft => vault.recoverPendingEdit(draft) },
    });
    replica.persistence = persistence;
    await persistence.ready;
    replica.tabs = new TabSync(doc, message => this.post(actor, message, true));
    const update = (bytes: Uint8Array, origin: unknown) => {
      if (origin !== 'scheduled-wire' && origin !== 'broadcast' && origin !== persistence) this.post(actor, bytes, false);
      if (origin !== 'broadcast' && origin !== persistence) this.post(actor, bytes, true);
    };
    doc.on('update', update); replica.stop = () => doc.off('update', update);
    this.replicas[actor] = replica;
    this.post(actor, replica.tabs.hello(), true);
  }
  async initialize() {
    for (let actor = 0; actor < 3; actor++) await this.open(actor);
    applyImport(this.replicas[0].vault, { id: 'schedule-fixture', manifestHash: 'a'.repeat(64), replaceSourceIds: [],
      notes: ['one', 'two', 'three', 'gone'].map((id, i) => ({ id, title: `Title ${id}`, body: `Body ${id}`, kind: 'checklist', color: 'default', pinned: false, archived: false, trashed: id === 'gone', createdAt: i + 1, updatedAt: i + 1,
        items: id === 'one' ? ['parent-a', 'parent-b', 'child'].map((item, rank) => ({ id: item, noteId: id, text: item, rank: rank * 1024, checked: false })) : [], images: [], labels: ['Original'] })) });
    await this.heal();
    this.replicas.forEach(replica => replica.vault.undoManager.clear());
  }
  private receive(packet: Packet) {
    const replica = this.replicas[packet.to];
    if (packet.tab) replica.tabs.receive(packet.message);
    else Y.applyUpdate(replica.vault.doc, packet.message as Uint8Array, 'scheduled-wire');
  }
  private deliver(from: number, to: number, duplicate = false) {
    const index = this.packets.findIndex(packet => packet.from === from && packet.to === to && (packet.tab || (this.online[from] && this.online[to])));
    if (index < 0) return;
    const [packet] = this.packets.splice(index, 1);
    this.events.push({ deliver: { from, to, tab: packet.tab, duplicate, bytes: packet.message instanceof Uint8Array ? packet.message.length : 'hello' } });
    this.receive(packet);
    if (duplicate) this.receive(packet);
  }
  private reconnect(actor: number) {
    this.online[actor] = true;
    for (let peer = 0; peer < 3; peer++) if (peer !== actor && this.online[peer]) {
      for (const [from, to] of [[actor, peer], [peer, actor]]) {
        const bytes = Y.encodeStateAsUpdate(this.replicas[from].vault.doc, Y.encodeStateVector(this.replicas[to].vault.doc));
        if (!isEmptyUpdate(bytes)) this.packets.push({ from, to, message: bytes, tab: false });
      }
    }
    this.post(actor, this.replicas[actor].tabs.hello(), true);
  }
  async step(step: Step) {
    this.tick = step.id; this.uuid = 0; this.now = 1_000_000 + step.id * 10_000;
    this.events.push({ step });
    const { actor, action, target = (actor + 1) % 3, value = 0 } = step;
    const replica = this.replicas[actor], vault = replica.vault;
    const token = `⟦edit:${actor}:${step.id}🦀⟧`;
    const remember = () => { this.expected.add(token); this.authored.set(token, actor); };
    switch (action) {
      case 'append': vault.setNoteText('one', 'body', vault.getNote('one')!.body + ` ${token}`); remember(); break;
      case 'item': vault.addItem('one', token); remember(); break;
      case 'item-edit': vault.setItemText('child', vault.getItems('one').find(item => item.id === 'child')!.text + ` ${token}`); remember(); break;
      case 'attachment': vault.addAttachment({ id: crypto.randomUUID(), noteId: 'one', hash: createHash('sha256').update(token).digest('hex'), name: token, type: 'application/octet-stream', size: Buffer.byteLength(token) }); remember(); break;
      case 'check': vault.toggleItem('child'); break;
      case 'parent': vault.setItemParent('child', value % 3 === 0 ? null : value % 3 === 1 ? 'parent-a' : 'parent-b'); break;
      case 'cycle': vault.setItemParent(value % 2 ? 'parent-a' : 'parent-b', value % 2 ? 'parent-b' : 'parent-a'); break;
      case 'merge': vault.mergeNotes(value % 2 ? ['two', 'one'] : ['two', 'three']); break;
      case 'label': vault.setNoteLabel('one', 'Shared', value % 2 === 0); break;
      case 'delete-label': vault.deleteLabel('Shared'); break;
      case 'color': vault.setLabelColor('Shared', value % 2 ? 'sage' : 'coral'); break;
      case 'archive': vault.setNoteMeta('one', { archived: value % 2 === 0 }); break;
      case 'move': vault.moveNoteRelative('one', 'three', value % 2 ? 'before' : 'after'); break;
      case 'convert': vault.convertBodyToChecklist('one'); break;
      case 'undo': case 'redo': {
        const before = JSON.stringify(vault.getNotes());
        vault[action]();
        const after = JSON.stringify(vault.getNotes());
        // Undo may withdraw this participant's own input, never another writer's.
        // Observe only tokens changed by this action, not an absent delayed token.
        for (const [input, author] of this.authored) if (author === actor && before.includes(input) !== after.includes(input)) {
          if (after.includes(input)) this.expected.add(input); else this.expected.delete(input);
        }
        break;
      }
      case 'delete': if (vault.getNote('gone')) { vault.setNoteMeta('gone', { trashed: true }); vault.deleteNotesForever(['gone']); this.deleted = true; } break;
      case 'late-edit': if (vault.getNote('gone')) { vault.setNoteMeta('gone', { trashed: false }); vault.setNoteText('gone', 'body', 'ERASED_LATE_PAYLOAD'); vault.addItem('gone', 'ERASED_LATE_ITEM'); } break;
      case 'partition': this.online[actor] = false; this.packets = this.packets.filter(packet => packet.tab || (packet.from !== actor && packet.to !== actor)); break;
      case 'reconnect': this.reconnect(actor); break;
      case 'deliver': this.deliver(actor, target, value % 2 === 0); break;
      case 'reload': {
        const wasOnline = this.online[actor];
        replica.stop(); await replica.persistence.destroy(); vault.destroy(); await this.open(actor);
        if (wasOnline) this.reconnect(actor);
        break;
      }
      case 'compact': {
        await replica.persistence.whenDurable();
        const compactions = this.replicas.reduce((sum, current) => sum + current.compactions, 0);
        const db = await openDB(this.database(actor));
        try {
          const tx = db.transaction('updates', 'readwrite'), store = tx.objectStore('updates');
          const count = await store.count();
          for (let i = count; i < 499; i++) await store.add(Uint8Array.of(0, 0));
          await tx.done;
        } finally { db.close(); }
        vault.setNoteMeta('three', { color: vault.getNote('three')!.color === 'sage' ? 'coral' : 'sage' });
        await Promise.all(this.replicas.map(current => current.persistence.whenDurable()));
        assert(this.replicas.reduce((sum, current) => sum + current.compactions, 0) > compactions, 'The scheduled threshold must actually compact');
        break;
      }
      case 'fail-write': {
        await replica.persistence.whenDurable(); replica.fail = true;
        const count = replica.errors.length;
        vault.setNoteText('one', 'body', vault.getNote('one')!.body + ` ${token}`); remember();
        await assert.rejects(replica.persistence.whenDurable(), { name: 'QuotaExceededError' });
        assert.equal(replica.errors.length, count + 1);
        await replica.persistence.whenDurable(); break;
      }
    }
    for (const current of this.replicas) this.readInvariants(current.vault);
  }
  private readInvariants(vault: Vault) {
    let writes = 0;
    const update = () => { writes++; };
    vault.doc.on('update', update);
    try {
      const notes = vault.getNotes(), sources = notes.flatMap(note => note.sourceIds), items = notes.flatMap(note => note.items.map(item => item.id));
      assert.equal(new Set(sources).size, sources.length, 'A source must be projected exactly once');
      assert.equal(new Set(items).size, items.length, 'An item must be projected exactly once');
      assert.deepEqual([...sources].sort(), [...vault.notes.keys()].sort(), 'No live source can disappear from the projection');
      for (const note of notes) {
        const projected = checklistGroups(note.items).flatMap(group => [group.root, ...group.children]).map(item => item.id);
        assert.deepEqual(projected.sort(), note.items.map(item => item.id).sort(), 'Cycles and dangling parents must project without hiding items');
        assert(note.items.every(item => Number.isFinite(item.rank)));
      }
      vault.getLabels();
      assert.equal(writes, 0, 'Reads must not author repair updates');
    } finally { vault.doc.off('update', update); }
  }
  async heal(order = [0, 1, 2]) {
    this.replicas.forEach(replica => replica.vault.finishEdit());
    for (let round = 0; round < 4; round++) {
      for (const actor of order) this.reconnect(actor);
      let budget = 100_000;
      while (this.packets.length) {
        assert(budget-- > 0, 'Replication must reach quiescence');
        this.receive(this.packets.shift()!);
      }
      await Promise.all(this.replicas.map(replica => replica.persistence.whenDurable()));
    }
  }
  async verify() {
    await this.heal();
    const expected = this.replicas[0].vault.getNotes(), labels = this.replicas[0].vault.getLabels();
    const reference = this.replicas[0].vault.doc;
    for (const replica of this.replicas) {
      const { vault } = replica;
      this.readInvariants(vault);
      assert.deepEqual(vault.getNotes(), expected, 'Healed replicas must converge');
      assert.deepEqual(vault.getLabels(), labels, 'Label generations and colors must converge');
      for (const root of new Set([...reference.share.keys(), ...vault.doc.share.keys()])) {
        assert.deepEqual(vault.doc.getMap(root).toJSON(), reference.getMap(root).toJSON(), `Raw shared root diverged: ${root}`);
      }
      assert.deepEqual(Y.decodeStateVector(Y.encodeStateVector(vault.doc)), Y.decodeStateVector(Y.encodeStateVector(reference)), 'Healed state vectors must agree');
      assert.equal(vault.doc.store.pendingStructs, null, 'No unresolved update dependencies after healing');
      assert.equal(vault.doc.store.pendingDs, null, 'No unresolved deletion dependencies after healing');
      const text = JSON.stringify(vault.getNotes());
      for (const token of this.expected) assert.equal(text.split(token).length - 1, 1, `Authored content must survive exactly once: ${token}`);
      if (this.deleted) { assert(!vault.getNote('gone')); assert(!text.includes('ERASED_')); }
      const search = new CurrentNoteSearch();
      await search.update(vault.getNotes());
      for (const token of this.expected) assert(vault.getNotes().some(note => search.matches(note.id, token.toLowerCase())), `Search lost ${token}`);
      search.cancel();
    }
    const durableRoots = Object.fromEntries([...reference.share.keys()].map(root => [root, reference.getMap(root).toJSON()]));
    // Close every writer before disk-only reload: no surviving in-memory peer
    // can silently repair data that the local adapter failed to retain.
    for (const replica of this.replicas) { replica.stop(); await replica.persistence.destroy(); replica.vault.destroy(); }
    this.packets = [];
    for (let actor = 0; actor < 3; actor++) {
      await this.open(actor);
      assert.deepEqual(this.replicas[actor].vault.getNotes(), expected, `Replica ${actor} lost durable data on reload`);
      assert.deepEqual(this.replicas[actor].vault.getLabels(), labels);
      for (const [root, value] of Object.entries(durableRoots)) assert.deepEqual(this.replicas[actor].vault.doc.getMap(root).toJSON(), value, `Replica ${actor} lost shared root ${root} on reload`);
    }
  }
  async close() {
    for (const replica of this.replicas) { replica.stop(); await replica.persistence.destroy(); replica.vault.destroy(); }
  }
}

export async function runSchedule(plan: Schedule, t: TestContext, verify?: (harness: SyncSchedule) => void | Promise<void>) {
  const harness = new SyncSchedule(plan, t);
  try {
    await harness.initialize();
    for (const step of plan.steps) await harness.step(step);
    await harness.verify();
    await verify?.(harness);
  } catch (error) {
    const directory = process.env.STOW_SYNC_FAILURE_DIR ?? path.join(buildDir, 'sync-failures'); await mkdir(directory, { recursive: true });
    const digest = createHash('sha256').update(JSON.stringify(plan.steps)).digest('hex').slice(0, 10);
    const filename = path.join(directory, `schedule-${plan.seed}-${plan.sharedTabs ? 'tabs' : 'devices'}-${digest}.json`);
    await writeFile(filename, JSON.stringify({ ...plan, events: harness.events, failure: String(error) }, null, 2) + '\n');
    t.diagnostic(`Replay: STOW_SYNC_REPLAY=${filename} node --import tsx --test tests/sync-schedule.test.ts`);
    throw error;
  } finally { await harness.close(); }
}
