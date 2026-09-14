import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completedStage } from '../scripts/storage-lab/progress';

test('trial progress counts every reload and only complete action reports, without advancing on a duplicate or failure', () => {
  const stages = new Set<string>();
  const actions = [...Array.from({ length: 120 }, () => ({ name: 'input-core' })),
    ...Array.from({ length: 120 }, () => ({ name: 'input-frame' })), ...Array.from({ length: 40 }, () => ({ name: 'completed-edit' }))];
  for (const scenario of ['fresh', 'aged', 'archive', 'live', 'both']) {
    for (let count = 0; count <= 5; count++) {
      const stage = completedStage({ scenario, samples: [{ name: 'startup-ready', count }] });
      assert.ok(stage); stages.add(stage); stages.add(stage);
    }
    assert.equal(completedStage({ scenario, samples: actions.slice(0, -1) }), undefined);
    assert.equal(completedStage({ scenario, samples: actions, failure: { message: 'editor closed' } }), undefined);
    const stage = completedStage({ scenario, samples: actions }); assert.ok(stage); stages.add(stage);
  }
  assert.equal(stages.size, 35);
  assert.equal(completedStage({ scenario: 'fresh', samples: [{ name: 'startup-ready', count: 6 }] }), undefined);
});
