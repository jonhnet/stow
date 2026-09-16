import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generatedSchedule, orders, runSchedule, SyncSchedule, type Schedule, type Step } from './support/sync-schedule';

const replay = process.env.STOW_SYNC_REPLAY;
if (replay) {
  const plan = JSON.parse(readFileSync(replay, 'utf8')) as Schedule;
  assert.equal(plan.version, 1); assert(Array.isArray(plan.steps));
  test(`replay sync schedule ${plan.seed}`, t => runSchedule(plan, t));
} else {
  test('the schedule oracle rejects lost content even when all replicas agree', async t => {
    const harness = new SyncSchedule({ version: 1, seed: 3000, sharedTabs: false, steps: [] }, t);
    try {
      await harness.initialize(); await harness.step({ id: 1, actor: 0, action: 'append' }); await harness.heal();
      for (const { vault } of harness.replicas) vault.setNoteText('one', 'body', 'Body one');
      await assert.rejects(harness.verify(), /Authored content must survive exactly once/);
    } finally { await harness.close(); }
  });
  const seeds = process.env.STOW_SYNC_SEEDS?.split(',').map(Number) ?? [1, 2, 7, 18, 31, 42, 101, 202];
  const length = Number(process.env.STOW_SYNC_STEPS ?? 75);
  assert(seeds.every(seed => Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff));
  assert(Number.isSafeInteger(length) && length >= 1 && length <= 10000);
  for (const seed of seeds) test(`seeded sync schedule ${seed}: structural edits, interruptions and durable reload`, t => runSchedule(generatedSchedule(seed, length), t));

  for (const order of orders) for (const sharedTabs of [false, true]) {
    test(`merge, late edits and permanent deletion reconnect ${order.join('-')} (${sharedTabs ? 'shared tabs' : 'separate devices'})`, async t => {
      const actions: Omit<Step, 'id'>[] = [
        ...[0, 1, 2].map(actor => ({ actor, action: 'partition' as const })),
        { actor: 0, action: 'merge', value: 1 }, { actor: 1, action: 'merge', value: 0 },
        { actor: 2, action: 'append' }, { actor: 2, action: 'item' },
        { actor: 1, action: 'parent', value: 1 }, { actor: 2, action: 'parent', value: 2 },
        { actor: 0, action: 'delete' }, { actor: 2, action: 'late-edit' },
        { actor: 1, action: 'compact' }, { actor: 2, action: 'fail-write' },
        ...order.flatMap(actor => [{ actor, action: 'reconnect' as const }, ...[0, 1, 2].filter(target => actor !== target).map(target => ({ actor, target, action: 'deliver' as const }))]),
        { actor: 2, action: 'reload' },
      ];
      await runSchedule({ version: 1, seed: 1000 + orders.indexOf(order), sharedTabs, steps: actions.map((step, index) => ({ ...step, id: index + 1 })) }, t);
    });
  }
  test('a conversion and its Undo/Redo preserve concurrent remote insertions through a delayed dependency and reload', t => runSchedule({
    version: 1, seed: 2000, sharedTabs: false,
    steps: [
      { id: 1, actor: 0, action: 'convert' }, { id: 2, actor: 1, action: 'append' },
      { id: 3, actor: 2, action: 'item' }, { id: 4, actor: 0, action: 'undo' },
      { id: 5, actor: 1, target: 0, action: 'deliver' }, { id: 6, actor: 0, action: 'redo' },
      { id: 7, actor: 0, action: 'partition' }, { id: 8, actor: 0, action: 'reload' },
    ],
  }, t));
}
