import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, GripVertical, X } from 'lucide-react';
import { store } from './core/store';
import type { Item, Note } from './core/types';
import { checklistGroups, isChecklistGroupChecked } from './core/checklist';
import MarkdownField from './MarkdownField';
import NewChecklistItem from './NewChecklistItem';
import './checklist.css';

const INDENT = 40;
type DropTarget = { id: string; placement: 'before' | 'after'; parentId: string | null; markerId: string; markerPlacement: 'before' | 'after' };
type Drag = {
  itemId: string;
  text: string;
  checked: boolean;
  parentId: string | null;
  pointerId: number;
  handle: HTMLButtonElement;
  group: HTMLElement;
  scroller: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
};
type Preview = { itemId: string; text: string; x: number; y: number; width: number; target: DropTarget | null };
type FocusRequest = { id: string; kind: 'text' | 'grip'; selection?: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } };

function scrollContainer(element: HTMLElement): HTMLElement {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return document.scrollingElement as HTMLElement;
}

function viewport(scroller: HTMLElement) {
  return scroller === document.scrollingElement
    ? { top: 0, bottom: window.innerHeight }
    : scroller.getBoundingClientRect();
}

function depthBoundary(drag: Drag) {
  const root = drag.group.querySelector<HTMLElement>('[data-check-row]:not([data-parent-id])')!;
  const checkbox = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.getBoundingClientRect();
  // The entire root checkbox column is a top-level target. The boundary sits
  // in the gap before the child handles, independent of where a drag started.
  return (checkbox.right + root.getBoundingClientRect().left + INDENT) / 2;
}

function childDepth(drag: Drag) {
  return drag.x > depthBoundary(drag);
}

/** Resolve a literal row slot; a top-level drop can split a group between children. */
function dropTarget(drag: Drag): DropTarget | null {
  if (!drag.group.isConnected) return null;
  const bounds = drag.group.getBoundingClientRect();
  const visible = viewport(drag.scroller);
  if (drag.x < bounds.left || drag.x > bounds.right || drag.y < Math.max(bounds.top, visible.top) || drag.y > Math.min(bounds.bottom, visible.bottom)) return null;
  const rows = [...drag.group.querySelectorAll<HTMLElement>('[data-check-row]')].filter(row => row.dataset.checkRow !== drag.itemId);
  if (!rows.length) return null;
  let slot = rows.findIndex(row => { const box = row.getBoundingClientRect(); return drag.y < box.top + box.height / 2; });
  if (slot < 0) slot = rows.length;
  if (childDepth(drag)) {
    if (slot === 0) return null;
    const previous = rows[slot - 1];
    const parent = rows.slice(0, slot).reverse().find(row => !row.dataset.parentId) ?? rows[0];
    return { id: previous.dataset.checkRow!, placement: 'after', parentId: parent.dataset.checkRow!, markerId: previous.dataset.checkRow!, markerPlacement: 'after' };
  }
  const next = rows[slot];
  const target = next ?? rows[rows.length - 1];
  const placement = next ? 'before' : 'after';
  return { id: target.dataset.checkRow!, placement, parentId: null, markerId: target.dataset.checkRow!, markerPlacement: placement };
}

type RowActions = {
  start(event: ReactPointerEvent<HTMLButtonElement>, item: Item): void;
  move(event: ReactPointerEvent<HTMLButtonElement>): void;
  end(event: ReactPointerEvent<HTMLButtonElement>): void;
  cancel(event: ReactPointerEvent<HTMLButtonElement>): void;
  gripKey(event: ReactKeyboardEvent<HTMLButtonElement>, item: Item): void;
  textKey(event: ReactKeyboardEvent<HTMLElement>, item: Item, root: Item): void;
};

const ChecklistRow = memo(function ChecklistRow({ item, root, disabled, preview, actions }: {
  item: Item; root: Item; disabled: boolean; preview: Preview | null; actions: RefObject<RowActions>;
}) {
    const parentId = item.id === root.id ? undefined : root.id;
    const target = preview?.target?.markerId === item.id ? preview.target : undefined;
    const insertion = target ? `insert-${target.markerPlacement}` : '';
    const style = target ? { '--drop-offset': `${(target.parentId ? INDENT : 0) - (parentId ? INDENT : 0)}px` } as CSSProperties : undefined;
    return <div key={item.id} role="listitem" data-check-row={item.id} data-root-id={root.id} data-parent-id={parentId} style={style} className={`editor-check-row ${parentId ? 'is-child' : ''} ${item.checked ? 'is-checked' : ''} ${preview?.itemId === item.id ? 'drag-source' : ''} ${insertion}`}>
      {!disabled && <button type="button" className="item-drag-handle" aria-label={`Reorder ${item.text || 'list item'}`} aria-describedby={`${item.id}-nesting-help`} aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight" title="Drag to reorder or nest. Arrow keys move, indent, or outdent." onPointerDown={event => actions.current.start(event, item)} onPointerMove={event => actions.current.move(event)} onPointerUp={event => actions.current.end(event)} onPointerCancel={event => actions.current.cancel(event)} onLostPointerCapture={event => actions.current.cancel(event)} onClick={event => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={event => actions.current.gripKey(event, item)}><GripVertical size={17} /></button>}
      <input type="checkbox" checked={item.checked} disabled={disabled} aria-label={`Complete ${item.text || 'list item'}`} onChange={() => store.vault.toggleItem(item.id)} />
      <MarkdownField data-note-field inline className="item-text" data-item-id={item.id} value={item.text} disabled={disabled} aria-label="List item text" onChange={event => { const value = event.currentTarget.value; store.vault.setItemText(item.id, value); }} onKeyDown={event => actions.current.textKey(event, item, root)} />
      {!disabled && <div className="item-actions"><button type="button" className="icon-button" aria-label="Delete list item" title="Delete list item" onClick={() => store.vault.deleteItem(item.id)}><X size={16} /></button></div>}
      <span id={`${item.id}-nesting-help`} className="sr-only">{parentId ? `Child of ${root.text || 'an empty item'}. ` : 'Top-level item. '}Up and down move this item. Right indents; left outdents.</span>
    </div>;
  });

function EditorChecklist({ note, disabled, onAddItem }: { note: Note; disabled: boolean; onAddItem: (text: string) => string }) {
  const [showCompleted, setShowCompleted] = useState(true);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [composingItemId, setComposingItemId] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);
  const noteRef = useRef(note); noteRef.current = note;
  const dragRef = useRef<Drag | null>(null);
  const frameRef = useRef<number | null>(null);
  const groups = checklistGroups(note.items);
  const active = groups.filter(group => !isChecklistGroupChecked(group));
  const completed = groups.filter(isChecklistGroupChecked);

  useLayoutEffect(() => {
    if (!focusRequest) return;
    const family = groups.find(group => group.root.id === focusRequest.id || group.children.some(child => child.id === focusRequest.id));
    if (!showCompleted && family && isChecklistGroupChecked(family)) { setShowCompleted(true); return; }
    const selector = focusRequest.kind === 'grip' ? `[data-check-row="${focusRequest.id}"] .item-drag-handle` : `[data-item-id="${focusRequest.id}"]`;
    ref.current?.querySelector<HTMLElement>(selector)?.focus();
    // Focusing a rendered Markdown field mounts its source textarea. Restore its
    // selection after that render when a bucket change had to remount the row.
    const frame = requestAnimationFrame(() => {
      const field = ref.current?.querySelector<HTMLElement>(selector);
      if (field instanceof HTMLTextAreaElement && field === document.activeElement && focusRequest.selection) {
        const { start, end, direction } = focusRequest.selection;
        field.setSelectionRange(start, end, direction);
      }
      setFocusRequest(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, showCompleted]);

  const updatePreview = (drag: Drag) => {
    if (!drag.moved) return;
    setPreview({
      itemId: drag.itemId, text: drag.text,
      x: drag.x, y: drag.y,
      width: Math.min(340, drag.group.getBoundingClientRect().width),
      target: dropTarget(drag),
    });
  };

  const finishDrag = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Clear capture state first: releasing capture must not cancel a committed move.
    dragRef.current = null;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    const target = commit && drag.moved ? dropTarget(drag) : null;
    setPreview(null);
    if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    if (target) {
      store.vault.moveItemRelative(drag.itemId, target.id, target.placement, target.parentId);
      const items = store.vault.getItems(noteRef.current.id);
      const parent = target.parentId && items.find(item => item.id === target.parentId);
      const family = checklistGroups(items).find(group => group.root.id === drag.itemId || group.children.some(child => child.id === drag.itemId));
      if (family && isChecklistGroupChecked(family) !== drag.checked) {
        setFocusRequest({ id: drag.itemId, kind: 'grip' });
      }
      setAnnouncement(parent ? `Moved ${drag.text} under ${parent.text || 'an empty item'}.` : `Moved ${drag.text} to the top level.`);
    } else if (drag.moved || !commit) setAnnouncement(`Reordering ${drag.text} canceled.`);
    if (drag.handle.isConnected) drag.handle.focus({ preventScroll: true });
  };

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dragRef.current) {
        event.preventDefault(); event.stopPropagation();
        finishDrag(false);
      }
    };
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('keydown', escape, true);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag?.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    };
  }, []);

  useEffect(() => {
    const drag = dragRef.current;
    if (!drag) return;
    const current = checklistGroups(note.items).find(group => group.root.id === drag.itemId || group.children.some(child => child.id === drag.itemId));
    const parentId = current && current.root.id !== drag.itemId ? current.root.id : null;
    if (disabled || !current || isChecklistGroupChecked(current) !== drag.checked || parentId !== drag.parentId || (drag.checked && !showCompleted)) finishDrag(false);
    else updatePreview(drag);
  }, [disabled, note.items, showCompleted]);

  const autoScroll = () => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.moved) {
      const area = viewport(drag.scroller);
      const group = drag.group.getBoundingClientRect();
      if (drag.x >= group.left && drag.x <= group.right && drag.y >= area.top && drag.y <= area.bottom) {
        const edge = 38;
        const distance = drag.y < area.top + edge ? drag.y - area.top - edge
          : drag.y > area.bottom - edge ? drag.y - area.bottom + edge : 0;
        if (distance) {
          const before = drag.scroller.scrollTop;
          drag.scroller.scrollTop += Math.sign(distance) * Math.min(10, Math.abs(distance) / 3);
          if (drag.scroller.scrollTop !== before) updatePreview(drag);
        }
      }
    }
    frameRef.current = requestAnimationFrame(autoScroll);
  };

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, item: Item) => {
    if (disabled || event.button !== 0 || !event.isPrimary || dragRef.current) return;
    event.preventDefault(); event.stopPropagation();
    const handle = event.currentTarget;
    const group = handle.closest<HTMLElement>('[data-check-group]')!;
    const family = groups.find(family => family.root.id === item.id || family.children.some(child => child.id === item.id))!;
    const parentId = family.root.id === item.id ? null : family.root.id;
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    dragRef.current = {
      itemId: item.id, text: item.text || 'list item', checked: isChecklistGroupChecked(family), parentId,
      pointerId: event.pointerId, handle, group, scroller: scrollContainer(group),
      startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, moved: false,
    };
    setAnnouncement(`Reordering ${item.text || 'list item'}. Drag left or right to change nesting. Press Escape to cancel.`);
    frameRef.current = requestAnimationFrame(autoScroll);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    drag.x = event.clientX; drag.y = event.clientY;
    drag.moved ||= Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 4;
    updatePreview(drag);
  };

  const indent = (item: Item, outdent: boolean) => {
    const previousFamily = groups.find(group => group.root.id === item.id || group.children.some(child => child.id === item.id))!;
    const source = document.activeElement;
    const selection = source instanceof HTMLTextAreaElement && source.dataset.itemId === item.id ? { start: source.selectionStart, end: source.selectionEnd, direction: source.selectionDirection } : undefined;
    const changed = outdent ? store.vault.outdentItem(item.id) : store.vault.indentItem(item.id);
    if (changed) {
      const family = checklistGroups(store.vault.getItems(note.id)).find(group => group.root.id === item.id || group.children.some(child => child.id === item.id))!;
      if (isChecklistGroupChecked(family) !== isChecklistGroupChecked(previousFamily)) {
        setFocusRequest({ id: item.id, kind: selection ? 'text' : 'grip', selection });
      }
      setAnnouncement(family.root.id === item.id ? `${item.text || 'List item'} moved to the top level.` : `${item.text || 'List item'} nested under ${family.root.text || 'an empty item'}.`);
    } else if (!outdent && previousFamily.root.id === item.id) setAnnouncement('There is no preceding item to nest under.');
    return changed;
  };

  // Memoized rows invoke the current handlers, including current neighbor order
  // after another row moves. Their text and pointer elements remain mounted.
  const actions = useRef<RowActions>(null!);
  actions.current = {
    start: startDrag, move: moveDrag,
    end(event) {
        if (dragRef.current?.pointerId === event.pointerId) { event.preventDefault(); event.stopPropagation(); dragRef.current.x = event.clientX; dragRef.current.y = event.clientY; finishDrag(true); }
      },
    cancel(event) { if (dragRef.current?.pointerId === event.pointerId) finishDrag(false); },
    gripKey(event, item) {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault(); event.stopPropagation();
          if (dragRef.current) return;
          store.vault.moveItem(item.id, event.key === 'ArrowUp' ? -1 : 1);
          setAnnouncement(`Moved ${item.text || 'list item'} ${event.key === 'ArrowUp' ? 'up' : 'down'}.`);
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); if (!dragRef.current) indent(item, event.key === 'ArrowLeft'); }
      },
    textKey(event, item, root) {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && indent(item, event.shiftKey)) { event.preventDefault(); event.stopPropagation(); }
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); setFocusRequest({ id: store.vault.addItemAfter(note.id, item.id), kind: 'text' }); }
        if (event.key === 'Backspace' && !item.text) {
          event.preventDefault();
          const families = active.some(group => group.root.id === root.id) ? active : completed;
          const group = families.flatMap(group => [group.root, ...group.children]);
          const index = group.findIndex(entry => entry.id === item.id);
          store.vault.deleteItem(item.id);
          if (index > 0) setFocusRequest({ id: group[index - 1].id, kind: 'text' });
          else ref.current?.querySelector<HTMLInputElement>('.new-item input')?.focus();
        }
        if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); store.vault.moveItem(item.id, event.key === 'ArrowUp' ? -1 : 1); }
      },
  };
  const renderGroup = (group: typeof groups[number]) => [group.root, ...group.children]
    .filter(item => item.id !== composingItemId).map(item => <ChecklistRow key={item.id} item={item} root={group.root} disabled={disabled} preview={preview} actions={actions} />);
  const completedCount = completed.reduce((count, group) => count + 1 + group.children.length, 0);
  return <div ref={ref} className={`editor-checklist ${preview ? 'is-reordering' : ''}`} style={{ '--check-indent': `${INDENT}px` } as CSSProperties}>
    <div className="checklist-group" role="list" aria-label="Checklist items" data-check-group="unchecked">{active.flatMap(renderGroup)}</div>
    {!disabled && <NewChecklistItem onAdd={onAddItem} onEdit={(id, text) => store.vault.setItemText(id, text)} onFocus={id => setFocusRequest({ id, kind: 'text' })} onPendingChange={setComposingItemId} />}
    {completedCount > 0 && <div className="completed-items"><button type="button" className="completed-toggle" onClick={() => setShowCompleted(!showCompleted)}>{showCompleted ? <ChevronDown size={16} /> : <ChevronRight size={16} />}{completedCount} completed item{completedCount === 1 ? '' : 's'}</button>{showCompleted && <div className="checklist-group" role="list" aria-label="Completed checklist items" data-check-group="checked">{completed.flatMap(renderGroup)}</div>}</div>}
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    {preview && createPortal(<div className={`check-drag-preview ${preview.target ? '' : 'invalid-drop'} ${preview.target?.parentId ? 'nested-drop' : ''}`} aria-hidden="true" style={{ width: preview.width, left: Math.max(8, Math.min(preview.x + 14, window.innerWidth - preview.width - 8)), top: Math.max(8, Math.min(preview.y + 12, window.innerHeight - 60)) }}><GripVertical size={16} /><div><span>{preview.text}</span>{preview.target?.parentId && <small>Nested item</small>}</div></div>, document.body)}
  </div>;
}

// Body/title edits do not change any checklist input or event target.
export default memo(EditorChecklist, (before, after) => before.disabled === after.disabled && before.onAddItem === after.onAddItem && before.note.id === after.note.id &&
  before.note.items.length === after.note.items.length && before.note.items.every((item, index) => item === after.note.items[index]));
