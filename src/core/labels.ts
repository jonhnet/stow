import type * as Y from 'yjs';

/** Concurrent global delete/recreate actions use Yjs's same-key conflict order.
 * Ordinary membership and color edits never write this lifecycle register. */
export interface LabelLifecycle { generation: string; deleted: boolean }
type RecordMap = Y.Map<any>;
const MEMBERSHIP_PREFIX = 'label-generation:';

export const generationColorKey = (name: string, generation: string) => JSON.stringify([name, generation]);
export const generationMembershipKey = (name: string, generation: string) => `${MEMBERSHIP_PREFIX}${generationColorKey(name, generation)}`;

export function labelIdentityActive(lifecycle: Y.Map<LabelLifecycle>, name: string, generation?: string) {
  const current = lifecycle.get(name);
  return !current?.deleted && current?.generation === generation;
}

/** Original imports and boolean label keys belong to the implicit first generation. */
export function effectiveLabels(note: RecordMap, lifecycle: Y.Map<LabelLifecycle>): string[] {
  const baseline = new Set<string>(note.get('labels') ?? []);
  const current = (name: string) => {
    const state = lifecycle.get(name);
    if (state?.deleted) return false;
    if (state) return note.get(generationMembershipKey(name, state.generation)) === true;
    const override = note.get(`label:${name}`);
    return override === true || (override !== false && baseline.has(name));
  };
  return [...baseline].filter(current).concat(authoredLabelNames(note, lifecycle)
    .filter(name => !baseline.has(name) && current(name)).sort());
}

/** False overrides keep an explicitly managed label available after its last detach. */
export function authoredLabelNames(note: RecordMap, lifecycle: Y.Map<LabelLifecycle>): string[] {
  const names = new Set<string>();
  for (const key of note.keys()) {
    if (key.startsWith('label:')) {
      const name = key.slice('label:'.length);
      if (labelIdentityActive(lifecycle, name)) names.add(name);
    } else if (key.startsWith(MEMBERSHIP_PREFIX)) {
      const [name, generation] = JSON.parse(key.slice(MEMBERSHIP_PREFIX.length)) as [string, string];
      if (labelIdentityActive(lifecycle, name, generation)) names.add(name);
    }
  }
  return [...names];
}

export function hasLabelRecord(note: RecordMap, name: string) {
  return (note.get('labels') as string[] | undefined)?.includes(name) || note.has(`label:${name}`)
    || [...note.keys()].some(key => key.startsWith(MEMBERSHIP_PREFIX)
      && (JSON.parse(key.slice(MEMBERSHIP_PREFIX.length)) as [string, string])[0] === name);
}
