export type CardSize = { width: number; height: number };
export type LayoutCard<T extends { id: string }> = { note: T; top: number; left: number; width: number; height: number };
type Direction = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

/** Measurements belong to one card width; unseen or resized cards start at 210px. */
export function layoutNotes<T extends { id: string }>(notes: readonly T[], columns: number, width: number, gap: number, sizes: ReadonlyMap<string, CardSize>): { cards: LayoutCard<T>[]; height: number; columns: number } {
  const heights = Array<number>(columns).fill(0);
  const cards = notes.map(note => {
    let column = 0;
    for (let candidate = 1; candidate < columns; candidate++) {
      if (heights[candidate] < heights[column]) column = candidate;
    }
    const size = sizes.get(note.id);
    const height = size?.width === width ? size.height : 210;
    const top = heights[column];
    heights[column] += height + gap;
    return { note, top, left: column * (width + gap), width, height };
  });
  return { cards, height: Math.max(0, ...heights) - (cards.length ? gap : 0), columns };
}

/** Navigate the measured arrangement without wrapping to another row or group. */
export function geometricNeighbor<T extends { id: string }>(cards: readonly LayoutCard<T>[], id: string, direction: Direction): LayoutCard<T> | undefined {
  const current = cards.find(card => card.note.id === id);
  if (!current) return;
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
  let candidates: readonly LayoutCard<T>[];
  if (horizontal) {
    const side = cards.filter(card => direction === 'ArrowLeft' ? card.left < current.left : card.left > current.left);
    if (!side.length) return;
    const column = direction === 'ArrowLeft' ? Math.max(...side.map(card => card.left)) : Math.min(...side.map(card => card.left));
    candidates = side.filter(card => card.left === column);
  } else {
    const side = cards.filter(card => card.note.id !== id && (direction === 'ArrowUp' ? card.top + card.height <= current.top : card.top >= current.top + current.height));
    const sameColumn = side.filter(card => card.left === current.left);
    candidates = sameColumn.length ? sameColumn : side;
  }
  let nearest: LayoutCard<T> | undefined;
  let nearestScore: number[] | undefined;
  for (const card of candidates) {
    const verticalGap = Math.max(current.top - card.top - card.height, card.top - current.top - current.height, 0);
    const horizontalGap = Math.max(current.left - card.left - card.width, card.left - current.left - current.width, 0);
    const centerDistance = Math.abs(card.top + card.height / 2 - current.top - current.height / 2);
    const score = horizontal ? [verticalGap, centerDistance, card.top] : [horizontalGap, verticalGap, centerDistance, card.left];
    const firstDifference = nearestScore ? score.findIndex((value, index) => value !== nearestScore![index]) : -1;
    if (!nearest || firstDifference >= 0 && score[firstDifference] < nearestScore![firstDifference] || firstDifference < 0 && card.note.id < nearest.note.id) {
      nearest = card;
      nearestScore = score;
    }
  }
  return nearest;
}
