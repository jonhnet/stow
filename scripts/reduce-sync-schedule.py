#!/usr/bin/env python3
"""Remove chunks of a saved schedule while preserving its original failure."""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile


def reduce_steps(steps, fails, budget):
    """Bounded delta debugging. Retain step IDs and reject different failures."""
    current, divisions, attempts = list(steps), 2, 0
    while current and attempts < budget:
        width = math.ceil(len(current) / divisions)
        for start in range(0, len(current), width):
            candidate = current[:start] + current[start + width:]
            attempts += 1
            if fails(candidate):
                current = candidate
                divisions = max(2, divisions - 1)
                break
            if attempts >= budget:
                return current, attempts
        else:
            if divisions >= len(current):
                break
            divisions = min(len(current), divisions * 2)
    return current, attempts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('trace', type=Path)
    parser.add_argument('--attempts', type=int, default=100)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.attempts < 1:
        parser.error('--attempts must be positive')
    original = json.loads(args.trace.read_text())
    if original.get('version') != 1 or not original.get('failure'):
        parser.error('Expected a version 1 failing sync schedule')
    source = Path(__file__).resolve().parent.parent
    build = source.parent / 'build'
    (build / 'tmp').mkdir(parents=True, exist_ok=True)
    plan = {key: original[key] for key in ('version', 'seed', 'sharedTabs', 'steps')}
    with tempfile.TemporaryDirectory(prefix='reduce-sync-', dir=build / 'tmp') as temporary:
        directory = Path(temporary)

        def fails(steps):
            candidate = directory / 'candidate.json'
            candidate.write_text(json.dumps({**plan, 'steps': steps}))
            failures = directory / 'failures'
            if failures.exists():
                for item in failures.glob('*.json'):
                    item.unlink()
            result = subprocess.run(
                ['node', '--import', 'tsx', '--test', 'tests/sync-schedule.test.ts'],
                cwd=source, env={**os.environ, 'STOW_SYNC_REPLAY': str(candidate),
                                 'STOW_SYNC_FAILURE_DIR': str(failures)},
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30, check=False,
            )
            return result.returncode != 0 and any(
                json.loads(item.read_text()).get('failure') == original['failure']
                for item in failures.glob('*.json')
            )

        if not fails(plan['steps']):
            parser.error('The original failure no longer reproduces; no reduced trace was written')
        steps, attempts = reduce_steps(plan['steps'], fails, args.attempts)
    output = args.output or build / 'sync-failures' / f"reduced-{plan['seed']}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({**plan, 'steps': steps, 'failure': original['failure']}, indent=2) + '\n')
    print(f'Reduced {len(plan["steps"])} steps to {len(steps)} in {attempts} attempts: {output}')
    print(f'STOW_SYNC_REPLAY={output} node --import tsx --test tests/sync-schedule.test.ts')


if __name__ == '__main__':
    main()
