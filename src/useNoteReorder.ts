import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export type NoteMove = (id: string, targetId: string, position: 'before' | 'after') => boolean;
export type NoteSelect = (id: string, selected: boolean) => void;
export type NoteTile = { note: { id: string; title: string }; top: number; left: number; width: number; height: number };
type Target = { id: string; position: 'before' | 'after'; top: number; left: number; width: number; height: number };
type Drag = { id: string; title: string; x: number; y: number; target?: Target };
type Gesture = { id: string; pointerId: number; touch: boolean; startX: number; startY: number; x: number; y: number; active: boolean; held: boolean; hold?: ReturnType<typeof setTimeout>; frame?: number };

const interactive = 'button,input,textarea,select,a,label,[contenteditable],.note-image,[role="button"]';
const TOUCH_HOLD_MS = 450;
const TOUCH_SLOP = 10;

/** Touch scrolls until held; a hold selects, and deliberate movement then drags. */
export function useNoteReorder(container: RefObject<HTMLDivElement | null>, tiles: readonly NoteTile[], listView: boolean, onMove: NoteMove | undefined, disabled: boolean, onMoved: (id: string) => void, onActiveChange: (active: boolean) => void, onSelect?: NoteSelect) {
  const latest = useRef({ tiles, listView, onMove, disabled, onMoved, onActiveChange, onSelect });
  latest.current = { tiles, listView, onMove, disabled, onMoved, onActiveChange, onSelect };
  const [drag, setDrag] = useState<Drag>();
  const cancel = useRef<(unlessHeld?: boolean) => void>(() => {});

  useEffect(() => {
    const element = container.current!;
    let gesture: Gesture | undefined;
    let suppressClick = false;

    const finish = (commit = false) => {
      const current = gesture;
      if (!current) return;
      const target = current.active && commit && latest.current.tiles.some(tile => tile.note.id === current.id) ? locate(current) : undefined;
      gesture = undefined;
      clearTimeout(current.hold);
      if (current.frame) cancelAnimationFrame(current.frame);
      if (element.hasPointerCapture(current.pointerId)) element.releasePointerCapture(current.pointerId);
      setDrag(undefined);
      if (current.held && !current.active && !commit) latest.current.onSelect?.(current.id, false);
      if (target && (!latest.current.disabled || current.held) && latest.current.onMove?.(current.id, target.id, target.position)) latest.current.onMoved(current.id);
      if (current.active || current.held) latest.current.onActiveChange(false);
    };
    // The selection created by this hold must not cancel its own pointer. A
    // fresh gesture while selection mode is active is still disabled normally.
    cancel.current = (unlessHeld = false) => { if (!unlessHeld || !gesture?.held) finish(); };

    const locate = (current: Gesture): Target | undefined => {
      const rect = element.getBoundingClientRect();
      const x = current.x - rect.left, y = current.y - rect.top;
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) return;
      let closest: NoteTile | undefined;
      let distance = Infinity;
      for (const tile of latest.current.tiles) {
        const dx = Math.max(tile.left - x, 0, x - tile.left - tile.width);
        const dy = Math.max(tile.top - y, 0, y - tile.top - tile.height);
        const next = dx * dx + dy * dy;
        if (next < distance) { distance = next; closest = tile; }
      }
      if (!closest || closest.note.id === current.id) return;
      const before = latest.current.listView ? y < closest.top + closest.height / 2 : x < closest.left + closest.width / 2;
      return { id: closest.note.id, position: before ? 'before' : 'after', top: closest.top, left: closest.left, width: closest.width, height: closest.height };
    };

    const render = () => {
      const current = gesture;
      if (!current?.active) return;
      const tile = latest.current.tiles.find(tile => tile.note.id === current.id);
      if ((latest.current.disabled && !current.held) || !tile) { finish(); return; }
      const rect = element.getBoundingClientRect();
      if (current.x >= rect.left && current.x <= rect.right && current.y >= rect.top && current.y <= rect.bottom) {
        const top = 100, bottom = window.innerHeight - 65;
        const speed = current.y < top ? -Math.min(18, (top - current.y) / 4) : current.y > bottom ? Math.min(18, (current.y - bottom) / 4) : 0;
        if (speed) window.scrollBy(0, speed);
      }
      setDrag({ id: current.id, title: tile.note.title || 'Untitled note', x: current.x, y: current.y, target: locate(current) });
      current.frame = requestAnimationFrame(render);
    };

    const activate = () => {
      const current = gesture;
      if (!current || (latest.current.disabled && !current.held) || !latest.current.onMove) { finish(); return; }
      if (!current.held) latest.current.onActiveChange(true);
      else latest.current.onSelect?.(current.id, false);
      current.active = true;
      suppressClick = true;
      clearTimeout(current.hold);
      element.setPointerCapture(current.pointerId);
      window.getSelection()?.removeAllRanges();
      render();
    };

    const hold = () => {
      const current = gesture;
      if (!current || latest.current.disabled || !latest.current.onSelect || !latest.current.tiles.some(tile => tile.note.id === current.id)) { finish(); return; }
      current.held = true;
      suppressClick = true;
      // Freeze measured positions until release or the resulting drag ends.
      latest.current.onActiveChange(true);
      element.setPointerCapture(current.pointerId);
      window.getSelection()?.removeAllRanges();
      latest.current.onSelect(current.id, true);
    };

    const down = (event: PointerEvent) => {
      // A new physical gesture must not inherit suppression when the last drag had no click.
      suppressClick = false;
      if (gesture) { finish(); return; }
      if (!event.isPrimary || event.button !== 0 || latest.current.disabled || !latest.current.onMove) return;
      const target = event.target as HTMLElement;
      // An image-only tile still needs a generous selection target. Its quick
      // tap opens the preview; a touch hold owns and suppresses that click.
      const touchPreview = event.pointerType === 'touch' && target.closest('.open-image,.open-attachment');
      if (target.closest(interactive) && !touchPreview) return;
      const card = target.closest<HTMLElement>('.note-card');
      const wrapper = card?.closest<HTMLElement>('[data-note-id]');
      if (!wrapper || wrapper.closest('.windowed-notes') !== element) return;
      const id = wrapper.dataset.noteId!;
      gesture = { id, pointerId: event.pointerId, touch: event.pointerType === 'touch', startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, held: false };
      if (gesture.touch) gesture.hold = setTimeout(hold, TOUCH_HOLD_MS);
    };
    const move = (event: PointerEvent) => {
      const current = gesture;
      if (!current || event.pointerId !== current.pointerId) return;
      current.x = event.clientX; current.y = event.clientY;
      if (!current.active && Math.hypot(current.x - current.startX, current.y - current.startY) > (current.touch ? TOUCH_SLOP : 7)) {
        if (current.touch && !current.held) finish(); else activate();
      }
      if ((gesture?.active || gesture?.held) && event.cancelable) event.preventDefault();
    };
    const up = (event: PointerEvent) => {
      if (gesture?.pointerId !== event.pointerId) return;
      gesture.x = event.clientX; gesture.y = event.clientY;
      finish(true);
    };
    const cancelled = (event: PointerEvent) => { if (gesture?.pointerId === event.pointerId) finish(); };
    const lostCapture = (event: PointerEvent) => { if (event.target === element) cancelled(event); };
    const click = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const freshPointer = () => { if (!gesture) suppressClick = false; };
    const touchMove = (event: TouchEvent) => { if ((gesture?.active || gesture?.held) && event.cancelable) event.preventDefault(); };
    const touchStart = (event: TouchEvent) => { if (event.touches.length > 1) finish(); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !gesture) return;
      if (gesture.active || gesture.held) { event.preventDefault(); event.stopPropagation(); }
      finish();
    };
    const context = (event: MouseEvent) => { if (gesture) event.preventDefault(); };
    const nativeDrag = (event: DragEvent) => { if (gesture) event.preventDefault(); };
    const blur = () => finish();
    element.addEventListener('pointerdown', down);
    element.addEventListener('lostpointercapture', lostCapture);
    element.addEventListener('contextmenu', context);
    element.addEventListener('dragstart', nativeDrag);
    document.addEventListener('pointerdown', freshPointer, true);
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancelled);
    document.addEventListener('click', click, true);
    document.addEventListener('touchmove', touchMove, { passive: false });
    document.addEventListener('touchstart', touchStart, { passive: true });
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    return () => {
      finish();
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('lostpointercapture', lostCapture);
      element.removeEventListener('contextmenu', context);
      element.removeEventListener('dragstart', nativeDrag);
      document.removeEventListener('pointerdown', freshPointer, true);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancelled);
      document.removeEventListener('click', click, true);
      document.removeEventListener('touchmove', touchMove);
      document.removeEventListener('touchstart', touchStart);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
    };
  }, [container]);
  useEffect(() => { if (!onMove) cancel.current(); else if (disabled) cancel.current(true); }, [disabled, onMove]);
  const cancelDrag = useCallback(() => cancel.current(), []);
  return { drag, cancelDrag };
}
