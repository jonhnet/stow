import type { Label, Note } from './core/types';

/** Catalog order follows each label's latest nontrashed note edit, including
 * archived notes. Unused labels remain visible after labels with current notes. */
export function sortLabelsByRecentEdit(labels: readonly Label[], notes: readonly Note[]): Label[] {
  const latest = new Map<string, number>();
  for (const note of notes) {
    if (note.trashed) continue;
    for (const name of note.labels ?? []) {
      const previous = latest.get(name);
      if (previous === undefined || note.updatedAt > previous) latest.set(name, note.updatedAt);
    }
  }
  const byName = (a: Label, b: Label) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  return [...labels].sort((a, b) => {
    const aTime = latest.get(a.name), bTime = latest.get(b.name);
    if (aTime === undefined) return bTime === undefined ? byName(a, b) : 1;
    if (bTime === undefined) return -1;
    return bTime - aTime || byName(a, b);
  });
}
