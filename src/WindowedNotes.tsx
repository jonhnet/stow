import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Note } from './core/types';
import { useNoteReorder, type NoteMove, type NoteSelect } from './useNoteReorder';
import { geometricNeighbor, layoutNotes, type CardSize } from './noteLayout';
import './noteReorder.css';

const OVERSCAN = 600;
const DRAG_ACTIVITY = 'stow-note-drag-activity';
type ScrollAnchor = { id: string; top: number; scrollY: number };

/** Anchor the visible collection, even when a preceding pinned group changes. */
function readScrollAnchor(): ScrollAnchor | undefined {
  if (window.scrollY <= 0 || document.body.style.overflow === 'hidden') return;
  const header = document.querySelector('.topbar');
  if (!header) return;
  const edge = header.getBoundingClientRect().bottom + 12;
  let best: { id: string; top: number; left: number; distance: number } | undefined;
  for (const element of document.querySelectorAll<HTMLElement>('.windowed-card')) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= edge || rect.top >= window.innerHeight) continue;
    const distance = Math.abs(rect.top - edge);
    if (!best || distance < best.distance || (distance === best.distance && rect.left < best.left)) {
      best = { id: element.dataset.noteId!, top: rect.top, left: rect.left, distance };
    }
  }
  return best && { id: best.id, top: best.top, scrollY: window.scrollY };
}

function MeasuredCard({ id, top, left, width, lastColumn, dragging, measure, children }: {
  id: string; top: number; left: number; width: number; lastColumn: boolean; dragging: boolean;
  measure: (id: string, width: number, height: number) => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current!;
    const observer = new ResizeObserver(([entry]) => measure(id, width, entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, width, measure]);
  return <div ref={ref} className={`windowed-card ${lastColumn ? 'column-end' : ''} ${dragging ? 'note-drag-source' : ''}`} data-note-id={id} style={{ top, left, width }}>{children}</div>;
}

/** Keep the full collection searchable, but mount cards only around the viewport. */
export default function WindowedNotes({ notes, listView, children, onMove, onSelect, disabled = false }: {
  notes: readonly Note[]; listView: boolean; children: (note: Note) => ReactNode; onMove?: NoteMove; onSelect?: NoteSelect; disabled?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, top: 0, bottom: window.innerHeight });
  const [sizes, setSizes] = useState(new Map<string, CardSize>());
  const [focused, setFocused] = useState<string>();
  const pendingFocus = useRef<string | undefined>(undefined);
  const anchor = useRef<ScrollAnchor | undefined>(undefined);
  const measured = useRef(sizes); measured.current = sizes;
  const pendingSizes = useRef(new Map<string, CardSize>());
  const measurementFrame = useRef<number | undefined>(undefined);
  const dragging = useRef(false);
  const alive = useRef(true);
  const noteIds = useMemo(() => new Set(notes.map(note => note.id)), [notes]);
  const gap = window.innerWidth <= 620 ? 10 : window.innerWidth <= 1200 ? 14 : 16;
  const minimum = window.innerWidth >= 1700 ? 245 : window.innerWidth <= 1200 ? 215 : 230;
  const columns = listView ? 1 : window.innerWidth <= 620 ? 2 : Math.max(1, Math.floor((viewport.width + gap) / (minimum + gap)));
  const width = Math.max(1, (viewport.width - gap * (columns - 1)) / columns);
  const geometry = useRef({ width, containerWidth: viewport.width, noteIds });
  geometry.current = { width, containerWidth: viewport.width, noteIds };
  const flushMeasurements = useCallback(() => {
    measurementFrame.current = undefined;
    if (!alive.current || dragging.current) return;
    const changes = [...pendingSizes.current].filter(([id, size]) => {
      const previous = measured.current.get(id);
      return geometry.current.noteIds.has(id) && size.width === geometry.current.width
        && (previous?.width !== size.width || Math.abs(previous.height - size.height) >= 1);
    });
    pendingSizes.current.clear();
    if (!changes.length) return;
    if (!pendingFocus.current) anchor.current = readScrollAnchor();
    setSizes(previous => {
      const next = new Map(previous);
      for (const [id, size] of changes) next.set(id, size);
      return next;
    });
  }, []);
  const scheduleMeasurements = useCallback(() => {
    if (alive.current && !dragging.current && measurementFrame.current === undefined && pendingSizes.current.size) {
      measurementFrame.current = requestAnimationFrame(flushMeasurements);
    }
  }, [flushMeasurements]);
  const measure = useCallback((id: string, width: number, height: number) => {
    if (height <= 0) return;
    pendingSizes.current.set(id, { width, height });
    scheduleMeasurements();
  }, [scheduleMeasurements]);
  useEffect(() => {
    // A changing pinned section can move a drag target in the Others section.
    // All mounted groups hold their measured geometry for the same gesture.
    const activity = (event: Event) => {
      dragging.current = (event as CustomEvent<boolean>).detail;
      if (!dragging.current) scheduleMeasurements();
    };
    window.addEventListener(DRAG_ACTIVITY, activity);
    return () => window.removeEventListener(DRAG_ACTIVITY, activity);
  }, [scheduleMeasurements]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (measurementFrame.current !== undefined) cancelAnimationFrame(measurementFrame.current);
      measurementFrame.current = undefined; pendingSizes.current.clear();
    };
  }, []);
  useLayoutEffect(() => {
    const element = container.current!;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      // Width changes can redistribute columns. Scrolling by itself does not.
      if (rect.width !== geometry.current.containerWidth && !dragging.current && !pendingFocus.current) anchor.current = readScrollAnchor();
      setViewport(previous => {
        const next = { width: rect.width, top: -rect.top, bottom: window.innerHeight - rect.top };
        return previous.width === next.width && previous.top === next.top && previous.bottom === next.bottom ? previous : next;
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(document.body);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    update();
    return () => { observer.disconnect(); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); cancelAnimationFrame(frame); };
  }, []);
  const layout = useMemo(() => layoutNotes(notes, columns, width, gap, sizes), [notes, sizes, columns, width, gap]);
  const focusMoved = useCallback((id: string) => { pendingFocus.current = id; setFocused(id); }, []);
  const dragStateChanged = useCallback((active: boolean) => {
    window.dispatchEvent(new CustomEvent(DRAG_ACTIVITY, { detail: active }));
  }, []);
  const { drag, cancelDrag } = useNoteReorder(container, layout.cards, listView || columns === 1, onMove, disabled, focusMoved, dragStateChanged, onSelect);
  const sequence = notes.map(note => note.id).join('|');
  // A pending long press belongs to the old arrangement too.
  useLayoutEffect(() => cancelDrag(), [sequence, width, columns, cancelDrag]);
  useLayoutEffect(() => {
    const saved = anchor.current; anchor.current = undefined;
    if (!saved || Math.abs(window.scrollY - saved.scrollY) > 1 || dragging.current || document.body.style.overflow === 'hidden') return;
    const element = document.querySelector<HTMLElement>(`.windowed-card[data-note-id="${CSS.escape(saved.id)}"]`);
    if (element) {
      const offset = element.getBoundingClientRect().top - saved.top;
      if (Math.abs(offset) >= 1) window.scrollBy(0, offset);
    }
  }, [layout]);
  useEffect(() => {
    setSizes(previous => {
      if ([...previous.keys()].every(id => noteIds.has(id))) return previous;
      return new Map([...previous].filter(([id]) => noteIds.has(id)));
    });
  }, [noteIds]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const card = container.current?.querySelector<HTMLElement>(`[data-note-id="${pendingFocus.current}"] .note-card`);
    if (card) { pendingFocus.current = undefined; card.focus({ preventScroll: true }); }
  });
  return <div ref={container} className={`notes-grid windowed-notes ${listView ? 'list-view' : ''} ${onMove && !disabled ? 'note-reorder-enabled' : ''} ${drag ? 'note-drag-active' : ''}`} style={{ height: layout.height }}
    onFocusCapture={event => setFocused((event.target as HTMLElement).closest<HTMLElement>('[data-note-id]')?.dataset.noteId)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(undefined); }}
    onKeyDown={event => {
      const target = event.target as HTMLElement;
      if (!target.classList.contains('note-card') || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const id = target.closest<HTMLElement>('[data-note-id]')?.dataset.noteId;
      if (!id) return;
      const next = geometricNeighbor(layout.cards, id, event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown');
      event.preventDefault();
      if (event.altKey) {
        const before = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
        if (!disabled && onMove && next && onMove(id, next.note.id, before ? 'before' : 'after')) {
          pendingFocus.current = id; setFocused(id);
          const origin = container.current!.getBoundingClientRect().top + window.scrollY;
          if (next.top < viewport.top + 90 || next.top + next.height > viewport.bottom) window.scrollTo({ top: Math.max(0, origin + next.top - 100) });
        }
        return;
      }
      if (!next) return;
      pendingFocus.current = next.note.id; setFocused(next.note.id);
      const origin = container.current!.getBoundingClientRect().top + window.scrollY;
      if (next.top < viewport.top + 90 || next.top + next.height > viewport.bottom) window.scrollTo({ top: Math.max(0, origin + next.top - 100) });
    }}>
    {viewport.width > 0 && layout.cards.filter(card => card.note.id === focused || card.note.id === drag?.id || card.note.id === anchor.current?.id || card.top + card.height >= viewport.top - OVERSCAN && card.top <= viewport.bottom + OVERSCAN)
      .map(card => <MeasuredCard key={card.note.id} id={card.note.id} top={card.top} left={card.left} width={card.width} dragging={card.note.id === drag?.id} lastColumn={layout.columns > 1 && card.left + card.width >= viewport.width - 1} measure={measure}>{children(card.note)}</MeasuredCard>)}
    {drag?.target && <div className="note-drop-marker" aria-hidden="true" data-drop-note={drag.target.id} data-drop-position={drag.target.position} style={listView || layout.columns === 1
      ? { left: drag.target.left, top: drag.target.top + (drag.target.position === 'after' ? drag.target.height + 4 : -6), width: drag.target.width, height: 3 }
      : { left: drag.target.left + (drag.target.position === 'after' ? drag.target.width + 4 : -6), top: drag.target.top, width: 3, height: drag.target.height }} />}
    {drag && <div className="note-drag-ghost" aria-hidden="true" style={{ left: Math.min(window.innerWidth - 180, drag.x + 14), top: Math.min(window.innerHeight - 64, drag.y + 14) }}>{drag.title}</div>}
  </div>;
}
