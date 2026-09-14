export interface ChecklistPosition { id: string; noteId: string; rank: number; parentId?: string }
export interface ChecklistGroup<T extends ChecklistPosition> { root: T; children: T[] }

const byId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const byPosition = <T extends ChecklistPosition>(a: T, b: T) => a.rank - b.rank || byId(a.id, b.id);

/**
 * Derive one visible child level without writing conflict repairs to the CRDT.
 * Chains flatten beneath their ultimate root; cycles choose the smallest ID.
 * Callers supply one logical checklist. Source ownership is retained for sync,
 * but it does not divide a merged checklist into separate nesting groups.
 * Missing, deleted (omitted), and self parents make a root.
 * Returned records retain their raw parent IDs for editing history and recovery.
 */
export function checklistGroups<T extends ChecklistPosition>(items: readonly T[]): ChecklistGroup<T>[] {
  const records = new Map(items.map(item => [item.id, item])), roots = new Map<string, string>();
  for (const item of items) {
    if (roots.has(item.id)) continue;
    const visited: string[] = [], indexes = new Map<string, number>();
    let current = item.id, root: string;
    for (;;) {
      const resolved = roots.get(current);
      if (resolved !== undefined) { root = resolved; break; }
      const cycle = indexes.get(current);
      if (cycle !== undefined) { root = visited.slice(cycle).sort(byId)[0]; break; }
      indexes.set(current, visited.length); visited.push(current);
      const record = records.get(current)!, parent = record.parentId ? records.get(record.parentId) : undefined;
      if (!parent || parent.id === current) { root = current; break; }
      current = parent.id;
    }
    for (const id of visited) roots.set(id, root);
  }
  const groups = new Map<string, ChecklistGroup<T>>();
  for (const item of items) {
    const rootId = roots.get(item.id)!;
    let group = groups.get(rootId);
    if (!group) groups.set(rootId, group = { root: records.get(rootId)!, children: [] });
    if (item.id !== rootId) group.children.push(item);
  }
  const ordered = [...groups.values()].sort((a, b) => byPosition(a.root, b.root));
  for (const group of ordered) group.children.sort(byPosition);
  return ordered;
}

export function orderChecklistItems<T extends ChecklistPosition>(items: readonly T[]): T[] {
  return checklistGroups(items).flatMap(group => [group.root, ...group.children]);
}

/**
 * Older merge edges join source-local rank spaces. Derive their displayed order
 * without changing those records; an authored edit can then persist these ranks.
 */
export function orderComponentChecklist<T extends ChecklistPosition>(sources: readonly { id: string; items: readonly T[]; unifiedChecklist?: boolean }[]): T[] {
  if (sources.length < 2 || sources.every(source => source.unifiedChecklist)) return orderChecklistItems(sources.flatMap(source => source.items));
  const ordered = sources.flatMap(source => orderChecklistItems(source.items));
  return orderChecklistItems(ordered.map((item, index) => ({ ...item, rank: (index + 1) * 1024 })));
}

export function isChecklistGroupChecked<T extends ChecklistPosition & { checked: boolean }>(group: ChecklistGroup<T>): boolean {
  return group.root.checked && group.children.every(item => item.checked);
}
