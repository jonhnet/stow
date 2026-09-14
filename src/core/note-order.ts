import type { Note } from './types';

export interface NotePlacement { pinned: boolean; sortOrderDate: number }
export function notePlacement(record: { get(key: string): any }): NotePlacement {
  return record.get('placement') ?? { pinned: !!record.get('pinned'), sortOrderDate: record.get('createdAt') ?? 0 };
}
export function sameNoteBucket(a: Pick<Note, 'pinned' | 'archived' | 'trashed'>, b: Pick<Note, 'pinned' | 'archived' | 'trashed'>) {
  return a.pinned === b.pinned && a.trashed === b.trashed && (a.trashed || a.archived === b.archived);
}

type Positioned = Pick<Note, 'id' | 'sortOrderDate'>;
function spaced(count: number, upper: number | undefined, lower: number | undefined, now: number): number[] | undefined {
  const step = Math.max(1, Math.abs(upper ?? lower ?? now) * Number.EPSILON * 2);
  const values = Array.from({ length: count }, (_, i) => {
    if (upper !== undefined && lower !== undefined) {
      const fraction = (i + 1) / (count + 1);
      return upper * (1 - fraction) + lower * fraction;
    }
    if (lower !== undefined) return Math.max(now, lower + step * count) - step * i;
    return upper === undefined ? now - step * i : upper - step * (i + 1);
  });
  return values.every((value, i) => Number.isFinite(value) && (i ? values[i - 1] > value : upper === undefined || upper > value) && (lower === undefined || value > lower)) ? values : undefined;
}

/** Plan a numeric move before writing. Equal dates or exhausted midpoint precision
 * expand only the surrounding window until its existing sequence fits again. */
export function notePositionChanges(sequence: Positioned[], index: number, now: number): Map<string, number> {
  if (!Number.isInteger(index) || index < 0 || index >= sequence.length) throw new RangeError('The moved note must have a valid position in its bucket.');
  if (!Number.isFinite(now) || sequence.some(note => !Number.isFinite(note.sortOrderDate))) throw new TypeError('Note ordering requires finite sort dates and a finite current time.');
  let start = index, end = index + 1;
  while (true) {
    const dates = spaced(end - start, sequence[start - 1]?.sortOrderDate, sequence[end]?.sortOrderDate, now);
    if (dates) return new Map(dates.flatMap((date, offset) => {
      const note = sequence[start + offset];
      return note.sortOrderDate === date ? [] : [[note.id, date] as const];
    }));
    if (start === 0 && end === sequence.length) throw new RangeError('These notes cannot be assigned distinct finite sort dates.');
    if (start > 0) start--;
    if (end < sequence.length) end++;
  }
}
