import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { sourceDir } from '../paths';

test('schedule reduction retains causal steps and respects its attempt budget', () => {
  const result = execFileSync('python3', ['-B', '-c', `
import runpy
reduce = runpy.run_path('scripts/reduce-sync-schedule.py')['reduce_steps']
steps = list(range(20))
reduced, attempts = reduce(steps, lambda trial: 4 in trial and 17 in trial, 100)
assert reduced == [4, 17], (reduced, attempts)
assert steps == list(range(20)), 'Do not mutate the original trace'
calls = []
reduced, attempts = reduce(steps, lambda trial: calls.append(trial) or False, 3)
assert attempts == len(calls) == 3
assert reduced == steps
print('reducer verified')
`], { cwd: sourceDir, encoding: 'utf8' });
  assert.match(result, /reducer verified/);
});
