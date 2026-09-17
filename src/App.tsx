import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Archive, ArchiveRestore, ArrowLeft, Check, CheckSquare,
  Cloud, CloudOff, Copy, Download, DownloadCloud, History, ImagePlus, LayoutGrid,
  List, LoaderCircle, Menu, Merge, MoreVertical, Palette, Pin,
  RotateCcw, Search, Settings, Trash2, Undo2, Redo2, X,
} from 'lucide-react';
import { store, useStow } from './core/store';
import type { Label, Note, NoteColor } from './core/types';
import { checklistGroups, isChecklistGroupChecked } from './core/checklist';
import EditorChecklist from './EditorChecklist';
import { useEditBoundaries } from './useEditBoundaries';
import { useDismissiblePopup } from './useDismissiblePopup';
import { useEditorViewport } from './useEditorViewport';
import { useEditorNavigation, type NewNote } from './useEditorNavigation';
import Logo from './Logo';
import Markdown from './Markdown';
import MarkdownField from './MarkdownField';
import AutoTextarea from './AutoTextarea';
import NoteImage from './NoteImage';
import NoteHistory from './NoteHistory';
import NoteLabels from './NoteLabels';
import LabelPicker from './LabelPicker';
import LabelNavigation from './LabelNavigation';
import { sortLabelsByRecentEdit } from './labelNavigation';
import { COLORS, noteColor } from './colors';
import WindowedNotes from './WindowedNotes';
import SelectionExport from './SelectionExport';
import DeleteNotesDialog, { type NoteDeletion } from './DeleteNotesDialog';
import StorageSettings from './StorageSettings';
import { IS_DEMO, DEMO_IMAGE_MESSAGE } from './runtime';
import ServerNotice from './ServerNotice';
import BuildVersion from './BuildVersion';
import { installStow, useInstallable } from './install';
import { copyNotes, downloadNotes } from './noteExport';
import { useCurrentSearch } from './useCurrentSearch';
import { navigateNoteFields } from './textNavigation';
import './styles.css';
import './markdown.css';

type View = 'notes' | 'archive' | 'trash';
const macShortcuts = /Mac|iPhone|iPad/.test(navigator.platform);
const undoShortcut = macShortcuts ? 'Cmd+Z' : 'Ctrl+Z';
const redoShortcut = macShortcuts ? 'Cmd+Shift+Z' : 'Ctrl+Shift+Z or Ctrl+Y';

function IconButton({ label, children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const toast = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = window.visualViewport!;
    const position = () => {
      const element = toast.current!;
      // Follow the visible screen, including keyboard-induced panning. A fixed
      // CSS top/bottom alone is relative to the larger layout viewport.
      element.style.top = `${viewport.offsetTop + 12}px`;
      element.style.left = `${viewport.offsetLeft + 12}px`;
      element.style.maxWidth = `${viewport.width - 24}px`;
      element.style.maxHeight = `${viewport.height - 24}px`;
    };
    position();
    viewport.addEventListener('resize', position);
    viewport.addEventListener('scroll', position);
    return () => {
      viewport.removeEventListener('resize', position);
      viewport.removeEventListener('scroll', position);
    };
  }, []);
  return <div ref={toast} className="toast toast-notification" role="status" aria-atomic="true"><span>{message}</span><IconButton label="Dismiss notification" onClick={onDismiss}><X size={18} /></IconButton></div>;
}

function HistoryMenu({ onAction, onClose }: { onAction: (kind: 'undo' | 'redo') => void; onClose: () => void }) {
  const { canUndo, canRedo } = useStow();
  return <><button aria-label="Undo last change" title={`Undo (${undoShortcut})`} disabled={!canUndo} onClick={() => { onAction('undo'); onClose(); }}><Undo2 size={18} />Undo</button><button aria-label="Redo last change" title={`Redo (${redoShortcut})`} disabled={!canRedo} onClick={() => { onAction('redo'); onClose(); }}><Redo2 size={18} />Redo</button></>;
}

function ColorPicker({ anchor, value, onChange, onClose }: { anchor: React.RefObject<HTMLDivElement | null>; value: NoteColor; onChange: (color: NoteColor) => void; onClose: () => void }) {
  useDismissiblePopup(true, anchor, restoreFocus => {
    onClose();
    if (restoreFocus) anchor.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  });
  return <div className="color-picker" role="group" aria-label="Note background color" onClick={e => e.stopPropagation()}>
    {COLORS.map(color => <button key={color.value} type="button" title={color.label} aria-label={color.label} aria-pressed={value === color.value} className={`color-swatch ${value === color.value ? 'chosen' : ''}`} style={{ backgroundColor: color.hex }} onClick={() => { onChange(color.value); onClose(); }}>{value === color.value && <Check size={15} />}</button>)}
  </div>;
}

const NoteCard = memo(function NoteCard({ note, labels, onOpen, selected, selecting, onSelect, onDelete }: { note: Note; labels: readonly Label[]; onOpen: (id: string) => void; selected: boolean; selecting: boolean; onSelect: (id: string) => void; onDelete: (note: Note) => void }) {
  const [palette, setPalette] = useState(false);
  const paletteRef = useRef<HTMLDivElement>(null);
  const activeItems = checklistGroups(note.items)
    .filter(group => !isChecklistGroupChecked(group))
    .flatMap(({ root, children }) => [{ item: root, child: false }, ...children.map(item => ({ item, child: true }))]);
  const visibleItems = activeItems.slice(0, 7);
  const completed = note.items.filter(i => i.checked).length;
  const body = note.body;
  const mutate = (patch: Parameters<typeof store.vault.setNoteMeta>[1]) => store.vault.setNoteMeta(note.id, patch);
  return <article className={`note-card ${selected ? 'selected' : ''} ${selecting ? 'selecting' : ''}`} style={{ backgroundColor: noteColor(note.color) }} tabIndex={0} aria-keyshortcuts={selecting ? undefined : "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"} aria-description={selecting ? "Select or deselect this note." : "Drag to reorder, or use Alt with arrow keys. Enter opens this note."} aria-label={`Open note: ${note.title || 'Untitled note'}`} onClick={() => { selecting ? onSelect(note.id) : onOpen(note.id); }} onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selecting ? onSelect(note.id) : onOpen(note.id); } }}>
    <button type="button" className={`select-note ${selected ? 'is-selected' : ''}`} aria-label={selected ? 'Deselect note' : 'Select note'} aria-pressed={selected} onClick={e => { e.stopPropagation(); onSelect(note.id); }}>{selected && <Check size={16} />}</button>
    {note.images.length > 0 && <div className="card-images">{note.images.slice(0, 2).map(img => <NoteImage key={img.id} attachment={img} />)}</div>}
    <div className="card-content">
      {note.title && <h2>{note.title}</h2>}
      {body && <Markdown interactive={false} className="card-body" text={body} />}
      {visibleItems.length > 0 && <div className="card-checklist">{visibleItems.map(({ item, child }) => <div key={item.id} className={`check-row${child ? ' check-child' : ''}`} data-check-depth={child ? 1 : 0}><input type="checkbox" checked={item.checked} disabled={note.trashed} aria-label={item.text || 'List item'} onClick={e => e.stopPropagation()} onChange={() => store.vault.toggleItem(item.id)} /><Markdown interactive={false} inline className={item.checked ? 'checked-preview' : ''} text={item.text} /></div>)}</div>}
      {activeItems.length > 7 && <div className="more-items">+{activeItems.length - 7} more items</div>}
      {completed > 0 && <div className="completed-count"><Check size={14} /> {completed} completed item{completed === 1 ? '' : 's'}</div>}
      <NoteLabels labels={note.labels} catalog={labels} />
      {!note.title && !body && !note.items.length && !note.images.length && <p className="empty-note">Empty note</p>}
    </div>
    <IconButton label={note.pinned ? 'Unpin note' : 'Pin note'} className={`card-pin ${note.pinned ? 'pinned' : ''}`} onClick={e => { e.stopPropagation(); mutate({ pinned: !note.pinned }); }}><Pin size={19} fill={note.pinned ? 'currentColor' : 'none'} /></IconButton>
    <div className="card-actions" onClick={e => e.stopPropagation()}>
      {note.trashed ? <><IconButton label="Restore note" onClick={() => mutate({ trashed: false })}><RotateCcw size={17} /></IconButton><IconButton label="Delete forever" onClick={() => onDelete(note)}><Trash2 size={17} /></IconButton></> : <>
        <div className="palette-anchor" ref={paletteRef}><IconButton label="Background color" aria-expanded={palette} onClick={() => setPalette(!palette)}><Palette size={17} /></IconButton>{palette && <ColorPicker anchor={paletteRef} value={note.color} onChange={color => mutate({ color })} onClose={() => setPalette(false)} />}</div>
        <IconButton label={note.archived ? 'Unarchive note' : 'Archive note'} onClick={() => mutate({ archived: !note.archived })}>{note.archived ? <ArchiveRestore size={17} /> : <Archive size={17} />}</IconButton>
        <IconButton label="Move to trash" onClick={() => mutate({ trashed: true })}><Trash2 size={17} /></IconButton>
      </>}
    </div>
  </article>;
});

function NewNoteLauncher({ onCreate }: { onCreate: (note: NewNote) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const addFiles = (incoming: FileList | File[]) => {
    const files = Array.from(incoming).filter(file => file.type.startsWith('image/'));
    if (files.length) onCreate({ kind: 'text', files });
  };
  return <div className="composer" onPaste={event => {
    if (event.clipboardData.files.length) { event.preventDefault(); addFiles(event.clipboardData.files); }
  }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
    <input type="file" accept="image/*" multiple ref={fileRef} hidden onChange={event => {
      const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; addFiles(files);
    }} />
    <div className="composer-collapsed">
      <button className="composer-prompt" onClick={() => onCreate({ kind: 'text' })}>Take a note…</button>
      <IconButton label="New checklist" onClick={() => onCreate({ kind: 'checklist' })}><CheckSquare size={23} /></IconButton>
      <IconButton label="New note with image" disabled={IS_DEMO} title={IS_DEMO ? DEMO_IMAGE_MESSAGE : undefined} onClick={() => fileRef.current?.click()}><ImagePlus size={23} /></IconButton>
    </div>
  </div>;
}


function NoteEditor({ note: savedNote, initial, onCreated, labels, onClose: closeNote, onError, onRestore, onUndoRedo, onDelete }: {
  note?: Note; initial?: NewNote; onCreated: (id: string) => void; labels: readonly Label[]; onClose: () => void;
  onError: (message: string) => void; onRestore: (id: string) => void; onUndoRedo: (kind: 'undo' | 'redo') => void; onDelete: (note: Note) => void;
}) {
  const { canUndo, canRedo } = useStow();
  // A blank view is local to this editor; the first mutation creates the ordinary vault note.
  const [emptyNote] = useState<Note>(() => ({ id: '', sourceIds: [], title: '', body: '', kind: initial?.kind ?? 'text',
    color: 'default', pinned: false, archived: false, trashed: false, createdAt: 0, sortOrderDate: 0, updatedAt: 0, items: [], images: [], labels: [] }));
  const note = savedNote ?? emptyNote;
  const noteRef = useRef(note); noteRef.current = note;
  const idRef = useRef(savedNote?.id);
  if (savedNote) idRef.current = savedNote.id;
  const created = useRef(onCreated); created.current = onCreated;
  const ensureNote = useCallback(() => {
    if (idRef.current && store.vault.getNote(idRef.current)) return idRef.current;
    const id = store.vault.createNote(noteRef.current.kind);
    idRef.current = id; created.current(id);
    return id;
  }, []);
  const addItem = useCallback((text: string) => store.vault.addItem(ensureNote(), text), [ensureNote]);
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const [history, setHistory] = useState(false);
  const showingHistory = history && savedNote !== undefined;
  useEffect(() => { if (!savedNote) setHistory(false); }, [savedNote?.id]);
  const [uploading, setUploading] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissiblePopup(menu, menuRef, restoreFocus => {
    setMenu(false);
    if (restoreFocus) menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  });
  const backdrop = useRef<HTMLDivElement>(null);
  useEditorViewport(backdrop, dialog);
  const boundaries = useEditBoundaries(dialog, onUndoRedo);
  const onClose = () => boundaries.close(closeNote);
  const fileRef = useRef<HTMLInputElement>(null);
  const focusNewItem = useRef(false);
  useLayoutEffect(() => {
    if (!focusNewItem.current) return;
    dialog.current?.querySelector<HTMLInputElement>('.new-item input')?.focus();
    focusNewItem.current = false;
  }, [note.kind]);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement;
    // Mouse clicks leave a card focused too. Return those to the overview;
    // keyboard users should retain their place in the card navigation order.
    const pointerOpenedCard = previous?.closest('.note-card') && !previous.matches(':focus-visible');
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const selector = initial ? initial.kind === 'checklist' ? '.new-item input' : '[aria-label="Note text"]' : '.title-input:not(:disabled)';
    if (!dialog.current?.contains(document.activeElement)) (dialog.current?.querySelector<HTMLElement>(selector) || dialog.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
    return () => {
      document.body.style.overflow = overflow;
      const target = pointerOpenedCard ? document.querySelector<HTMLElement>('.main-content')
        : previous?.isConnected ? previous : document.querySelector<HTMLInputElement>('[aria-label="Search notes"]');
      target?.focus({ preventScroll: true });
    };
  }, []);
  const addImages = async (files: FileList | File[]) => {
    const images = Array.from(files).filter(file => file.type.startsWith('image/'));
    if (!images.length || note.trashed || showingHistory) return;
    if (IS_DEMO) { onError(DEMO_IMAGE_MESSAGE); return; }
    const id = ensureNote();
    setUploading(count => count + images.length);
    await Promise.all(images.map(async file => {
      try { await store.addImage(id, file); }
      catch (err) { onError(err instanceof Error ? err.message : 'Could not add image'); }
      finally { setUploading(count => count - 1); }
    }));
  };
  const initialFilesAdded = useRef(false);
  useEffect(() => {
    if (!initial?.files?.length || initialFilesAdded.current) return;
    initialFilesAdded.current = true;
    void addImages(initial.files);
  }, [initial?.files]);
  const backToNote = () => { setHistory(false); requestAnimationFrame(() => dialog.current?.querySelector<HTMLButtonElement>('[aria-label="More note actions"]')?.focus()); };
  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onClose(); return; }
    navigateNoteFields(e);
    if (e.key === 'Escape') { e.preventDefault(); if (palette) setPalette(false); else if (menu) setMenu(false); else if (history) backToNote(); else onClose(); }
    if (e.key === 'Tab') {
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), textarea:not(:disabled), a[href], [tabindex="0"]') || []).filter(el => el.offsetParent !== null);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!dialog.current?.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first)?.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };
  return <div ref={backdrop} className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={dialog} {...boundaries.events} className="note-editor" style={{ backgroundColor: noteColor(note.color) }} role="dialog" aria-modal="true" aria-label={showingHistory ? 'Version history' : 'Edit note'} onKeyDown={keyDown} onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); void addImages(e.clipboardData.files); } }} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void addImages(e.dataTransfer.files); }}>
      {showingHistory ? <NoteHistory note={note} onBack={backToNote} onRestore={onRestore} onError={onError} /> : <>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => { const files = Array.from(e.currentTarget.files || []); e.currentTarget.value = ''; void addImages(files); }} />
      <div className="editor-scroll">
        {note.trashed && <div className="trash-banner">This note is in the trash.<button onClick={() => { store.vault.setNoteMeta(note.id, { trashed: false }); }}>Restore</button></div>}
        <section className="editor-section">
          {note.images.length > 0 && <div className="editor-images">{note.images.map(img => <NoteImage key={img.id} attachment={img} onRemove={note.trashed ? undefined : () => store.vault.removeAttachment(img.id)} />)}</div>}
          <div className="editor-title-row"><AutoTextarea data-note-field className="title-input" placeholder="Title" aria-label="Note title" value={note.title} disabled={note.trashed} onChange={e => { const value = e.currentTarget.value; store.vault.setNoteText(ensureNote(), 'title', value); }} />{!note.trashed && <IconButton label={note.pinned ? 'Unpin note' : 'Pin note'} onClick={() => store.vault.setNoteMeta(ensureNote(), { pinned: !note.pinned })}><Pin size={22} fill={note.pinned ? 'currentColor' : 'none'} /></IconButton>}</div>
          <MarkdownField data-note-field className="editor-body" placeholder="Take a note…" aria-label="Note text" value={note.body} disabled={note.trashed} onChange={e => { const value = e.currentTarget.value; store.vault.setNoteText(ensureNote(), 'body', value); }} />
          {(note.kind === 'checklist' || note.items.length > 0) && <EditorChecklist note={note} disabled={note.trashed} onAddItem={addItem} />}
          <NoteLabels labels={note.labels} catalog={labels} onRemove={note.trashed ? undefined : name => store.vault.setNoteLabel(note.id, name, false)} />
        </section>
        {uploading > 0 && <div className="uploading"><LoaderCircle size={16} className="spinning" />Adding image…</div>}
        {savedNote && <div className="editor-date">Edited {new Date(note.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>}
      </div>
      <div className="editor-toolbar">
        <IconButton label="Close" title="Back to notes" onClick={onClose}><ArrowLeft size={20} /></IconButton><span className="toolbar-spacer" />
        {note.trashed && <IconButton label="Delete forever" onClick={() => onDelete(note)}><Trash2 size={18} /></IconButton>}
        <IconButton label="Undo" title={`Undo (${undoShortcut})`} disabled={!canUndo} onClick={() => onUndoRedo('undo')}><Undo2 size={19} /></IconButton>
        <IconButton label="Redo" title={`Redo (${redoShortcut})`} disabled={!canRedo} onClick={() => onUndoRedo('redo')}><Redo2 size={19} /></IconButton>
        {!note.trashed && <><LabelPicker labels={labels} selected={note.labels} onToggle={(name, present) => store.vault.setNoteLabel(ensureNote(), name, present)} onOpen={() => { setPalette(false); setMenu(false); }} /><div className="palette-anchor" ref={paletteRef}><IconButton label="Background color" aria-expanded={palette} onClick={() => { setPalette(!palette); setMenu(false); }}><Palette size={18} /></IconButton>{palette && <ColorPicker anchor={paletteRef} value={note.color} onChange={color => store.vault.setNoteMeta(ensureNote(), { color })} onClose={() => setPalette(false)} />}</div>
          <IconButton label="Add image" disabled={IS_DEMO} title={IS_DEMO ? DEMO_IMAGE_MESSAGE : undefined} onClick={() => fileRef.current?.click()}><ImagePlus size={18} /></IconButton>
          {note.kind === 'text' && <IconButton label="Add checklist" onClick={() => { focusNewItem.current = true; store.vault.setNoteMeta(ensureNote(), { kind: 'checklist' }); }}><CheckSquare size={18} /></IconButton>}
          <IconButton label={note.archived ? 'Unarchive note' : 'Archive note'} disabled={!savedNote} onClick={() => { store.vault.setNoteMeta(note.id, { archived: !note.archived }); onClose(); }}>{note.archived ? <ArchiveRestore size={18} /> : <Archive size={18} />}</IconButton>
        </>}
        <div className="menu-anchor" ref={menuRef}><IconButton label="More note actions" aria-expanded={menu} onClick={() => { setMenu(!menu); setPalette(false); }}><MoreVertical size={18} /></IconButton>{menu && <div className="popup-menu editor-menu">
          <button disabled={IS_DEMO || !savedNote} title={IS_DEMO ? "Saved version history is unavailable in the demo." : undefined} onClick={() => { setMenu(false); setHistory(true); }}><History size={17} />Version history</button>
          <HistoryMenu onAction={onUndoRedo} onClose={() => setMenu(false)} />
          {!note.trashed && <>
            <button disabled={!note.body.trim()} onClick={() => {
              store.vault.convertBodyToChecklist(note.id); setMenu(false);
              menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
            }}><CheckSquare size={17} />Convert to checklist</button>
            <button disabled={!savedNote} onClick={() => { store.vault.setNoteMeta(note.id, { trashed: true }); onClose(); }}><Trash2 size={17} />Move to trash</button>
          </>}
        </div>}</div>
      </div>
      </>}
    </div>
  </div>;
}

function Login({ onError, error }: { onError: (s: string) => void; error: string | null }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  return <div className="login-wrap"><form className="login-card" onSubmit={async e => { e.preventDefault(); setBusy(true); try { await store.login(password); } catch (err) { onError(err instanceof Error ? err.message : 'Could not connect'); } finally { setBusy(false); } }}><div className="login-logo"><Logo size={34} /></div><h1>Sign in to Stow</h1>{error && <p role="alert">{error}</p>}<label htmlFor="password">Server password</label><input id="password" type="password" autoComplete="current-password" autoFocus required value={password} onChange={e => setPassword(e.target.value)} /><button type="submit" disabled={busy}>{busy ? <LoaderCircle className="spinning" size={18} /> : null}{busy ? 'Connecting…' : 'Sign in'}</button></form></div>;
}

export default function App() {
  const installable = useInstallable();
  const { notes, labels, status, ready, access, accessMessage, authMode, user, canReload, error, canUndo, canRedo, pending, localPending, images, syncRejection } = useStow();
  const orderedLabels = useMemo(() => sortLabelsByRecentEdit(labels, notes), [labels, notes]);
  const [view, setView] = useState<View>('notes');
  const [search, setSearch] = useState('');
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [labelsExpanded, setLabelsExpanded] = useState(false);
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 900);
  const [listView, setListView] = useState(() => { if (IS_DEMO) return false; try { return localStorage.getItem('stow-list-view') === 'true'; } catch { return false; } });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useEditorNavigation();
  const [toast, setToast] = useState<{ message: string; kind: 'error' | 'history' | 'copy' } | null>(null);
  const [settings, setSettings] = useState(false);
  const [storageSettings, setStorageSettings] = useState(false);
  const [deletion, setDeletion] = useState<NoteDeletion | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const activeNote = editing?.noteId ? notes.find(note => note.id === editing.noteId || note.sourceIds.includes(editing.noteId!)) : undefined;
  const notify = useCallback((message: string) => setToast({ message, kind: 'error' }), []);
  const undoOrRedo = useCallback((kind: 'undo' | 'redo') => {
    const description = store.vault[kind]();
    if (description) setToast({ message: `${kind === 'undo' ? 'Undid' : 'Redid'}: ${description}`, kind: 'history' });
  }, []);
  const openNote = useCallback((id: string) => setEditing({ key: id, noteId: id }), []);
  const createNote = (newNote: NewNote) => {
    if (IS_DEMO && newNote.files?.length) { notify(DEMO_IMAGE_MESSAGE); return; }
    setEditing({ key: crypto.randomUUID(), newNote });
  };
  const deleteNote = useCallback((note: Note) => setDeletion({ sourceIds: [...note.sourceIds], titles: [note.title], emptyTrash: false }), []);
  const closeDeletion = useCallback(() => setDeletion(null), []);
  const deleteForever = useCallback(async (sourceIds: string[]) => {
    await store.deleteNotesForever(sourceIds);
    setEditing(previous => previous?.noteId && !store.vault.getNote(previous.noteId) ? null : previous);
  }, []);
  const toggleSelected = useCallback((id: string) => setSelected(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }), []);
  const selectNote = useCallback((id: string, present: boolean) => setSelected(previous => {
    const next = new Set(previous); if (present) next.add(id); else next.delete(id); return next;
  }), []);
  const searchResult = useCurrentSearch(notes, search, notify);
  const query = searchResult.query;
  const filtered = useMemo(() => {
    return notes.filter(note => (selectedLabel !== null ? !note.trashed && !!note.labels?.includes(selectedLabel) && (!query || searchResult.ids.has(note.id)) : query ? !note.trashed && searchResult.ids.has(note.id) : view === 'trash' ? note.trashed : !note.trashed && note.archived === (view === 'archive')));
  }, [notes, query, view, selectedLabel, searchResult]);
  const live = useMemo(() => filtered.filter(note => note.trashed || !note.archived), [filtered]);
  const archived = useMemo(() => filtered.filter(note => !note.trashed && note.archived), [filtered]);
  const selectedNotes = useMemo(() => [
    ...live.filter(note => note.pinned), ...live.filter(note => !note.pinned),
    ...archived.filter(note => note.pinned), ...archived.filter(note => !note.pinned),
  ].filter(note => selected.has(note.id)), [live, archived, selected]);
  useEffect(() => {
    const visible = new Set(filtered.map(note => note.id));
    setSelected(previous => [...previous].every(id => visible.has(id)) ? previous : new Set([...previous].filter(id => visible.has(id))));
  }, [filtered]);
  const copySelected = useCallback(async () => {
    if (access !== 'ready' || !selectedNotes.length) return;
    try {
      await copyNotes(selectedNotes);
      if (store.getSnapshot().access !== 'ready') return;
      setToast({ message: selectedNotes.length === 1 ? 'Copied note to clipboard.' : `Copied ${selectedNotes.length} notes to clipboard.`, kind: 'copy' });
    } catch (error) { if (store.getSnapshot().access === 'ready') notify(error instanceof Error ? error.message : 'Could not copy notes.'); }
  }, [access, selectedNotes, notify]);
  const exportSelected = (format: Parameters<typeof downloadNotes>[1]) => {
    if (access !== 'ready' || !selectedNotes.length) return;
    try { downloadNotes(selectedNotes, format); }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not export notes.'); }
  };
  const moveNote = useCallback((id: string, targetId: string, placement: 'before' | 'after') => {
    if (store.getSnapshot().access !== 'ready') return false;
    try { return store.vault.moveNoteRelative(id, targetId, placement); }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not move this note.'); return false; }
  }, [notify]);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [query, view, selectedLabel]);
  useEffect(() => {
    if (selectedLabel !== null && !labels.some(label => label.name === selectedLabel)) {
      setSelectedLabel(null); setView('notes'); setSearch(''); setSelected(new Set());
    }
  }, [labels, selectedLabel]);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(null), 5000); return () => clearTimeout(timer); } }, [toast]);
  useEffect(() => { if (error) notify(error); }, [error, notify]);
  useEffect(() => { if (access === 'locked' || access === 'blocked') { setEditing(null); setDeletion(null); setStorageSettings(false); } }, [access, setEditing]);
  useEffect(() => {
    if (access === 'ready' && ready && editing?.noteId && !activeNote && !editing.newNote) setEditing(null);
  }, [access, ready, editing, activeNote, setEditing]);
  useEffect(() => { if (access !== 'ready') setToast(previous => previous?.kind !== 'error' ? null : previous); }, [access]);
  useEffect(() => { if (IS_DEMO) return; try { localStorage.setItem('stow-list-view', String(listView)); } catch { /* Account bootstrap reports unavailable browser storage. */ } }, [listView]);
  useEffect(() => {
    const keys = (event: globalThis.KeyboardEvent) => {
      if (access !== 'ready' || deletion || storageSettings) return;
      const target = event.target as HTMLElement;
      const input = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (!input && event.key === '/' && !editing) { event.preventDefault(); searchRef.current?.focus(); }
      const noteInput = input && !target.hasAttribute('data-native-undo') && !!target.closest('.note-editor');
      const key = event.key.toLowerCase();
      if (!input && !editing && !target.closest('.note-editor, .image-viewer, .attachment-viewer') && selectedNotes.length && !event.isComposing && !event.altKey && !event.shiftKey && (event.metaKey || event.ctrlKey) && key === 'c') {
        event.preventDefault(); void copySelected();
      }
      if ((!input || noteInput) && !event.isComposing && (event.metaKey || event.ctrlKey) && (key === 'z' || (event.ctrlKey && key === 'y'))) {
        event.preventDefault();
        undoOrRedo(key === 'y' || event.shiftKey ? 'redo' : 'undo');
      }
      if (event.key === 'Escape' && !editing) { setSelected(new Set()); setSettings(false); if (search) setSearch(''); }
    };
    document.addEventListener('keydown', keys); return () => document.removeEventListener('keydown', keys);
  }, [editing, search, access, undoOrRedo, selectedNotes.length, copySelected, deletion, storageSettings]);
  useDismissiblePopup(settings, settingsRef, restoreFocus => {
    setSettings(false);
    if (restoreFocus) settingsRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  });
  if (access !== 'ready') {
    if (access === 'locked' && authMode === 'password') return <Login onError={notify} error={toast?.kind === 'error' ? toast.message : null} />;
    if (access === 'opening' && !accessMessage) return <><div className="loading-state" role="status" aria-label="Loading"><LoaderCircle size={28} className="spinning" aria-hidden="true" />{error && <p role="alert">{error}</p>}</div><ServerNotice /></>;
    return <div className="login-wrap"><div className="login-card" role="alert"><div className="login-logo"><Logo size={34} /></div><h1>{access === 'opening' ? 'Stow' : ready ? 'Your account changed' : 'Sign in to Stow'}</h1>{accessMessage && <p>{accessMessage}</p>}{error && <p>{error}</p>}<button disabled={!canReload} onClick={() => void store.reloadAccount()}>Reload Stow</button>{!canReload && <><p>Keep this tab open until your edits are saved on this device.</p><button onClick={() => store.exportCurrentNotes()}>Download vault backup</button></>}</div></div>;
  }
  const navigate = (next: View) => { setView(next); setSelectedLabel(null); setSearch(''); setSelected(new Set()); if (window.innerWidth < 900) setSidebar(false); };
  const bulk = (patch: Parameters<typeof store.vault.setNoteMeta>[1]) => { selected.forEach(id => store.vault.setNoteMeta(id, patch)); setSelected(new Set()); };
  const renderCards = (group: Note[]) => <WindowedNotes notes={group} listView={listView} onMove={moveNote} onSelect={selectNote} disabled={selected.size > 0}>{note => <NoteCard note={note} labels={labels} onOpen={openNote} selected={selected.has(note.id)} selecting={selected.size > 0} onSelect={toggleSelected} onDelete={deleteNote} />}</WindowedNotes>;
  const renderNoteGroups = (group: Note[]) => {
    const pinned = group.filter(note => note.pinned), other = group.filter(note => !note.pinned);
    return <>{pinned.length > 0 && <><h2 className="group-label">Pinned</h2>{renderCards(pinned)}</>}{other.length > 0 && <>{pinned.length > 0 && <h2 className="group-label others-label">Others</h2>}{renderCards(other)}</>}</>;
  };
  const nav = [{ id: 'notes' as View, label: 'Notes', icon: Logo }, { id: 'archive' as View, label: 'Archive', icon: Archive }, { id: 'trash' as View, label: 'Trash', icon: Trash2 }];
  const imageStatus = images.pendingUploads ? `Uploading ${images.pendingUploads} image${images.pendingUploads === 1 ? '' : 's'}…` : images.thumbnailsRemaining ? `Saving ${images.thumbnailsRemaining} image previews for offline use…` : null;
  const syncLabel = error || syncRejection?.message || (status === 'demo' ? 'Demo — not saved or synchronized' : localPending > 0 ? 'Saving on this device…' : status === 'online' ? pending ? 'Syncing…' : imageStatus || 'Connected' : status === 'connecting' ? 'Connecting…' : status === 'locked' ? 'Locked' : status === 'error' ? 'Could not sync' : 'Offline — notes stored on this device');
  return <div className={`app ${sidebar ? 'sidebar-open' : 'sidebar-closed'}`}>
    <header className={`topbar ${selected.size ? 'selection-topbar' : ''}`}>
      {selected.size ? <><IconButton label="Clear selection" onClick={() => setSelected(new Set())}><X size={24} /></IconButton><span className="selection-count">{selected.size}<span className="selection-count-word"> selected</span></span><div className="selection-actions"><IconButton label="Copy selected notes" title={`Copy selected notes (${macShortcuts ? 'Cmd+C' : 'Ctrl+C'})`} aria-keyshortcuts={macShortcuts ? "Meta+c" : "Control+c"} onClick={() => void copySelected()}><Copy size={21} /></IconButton><SelectionExport onExport={exportSelected} />{selected.size > 1 && view !== 'trash' && <button className="merge-button" aria-label="Merge notes" onClick={() => { const id = store.vault.mergeNotes([...selected]); setSelected(new Set()); openNote(id); }}><Merge size={19} /><span>Merge notes</span></button>}{selectedNotes.every(note => note.trashed) ? <><IconButton label="Restore selected notes" onClick={() => bulk({ trashed: false })}><RotateCcw size={22} /></IconButton><IconButton label="Delete forever" onClick={() => setDeletion({ sourceIds: selectedNotes.flatMap(note => note.sourceIds), titles: selectedNotes.map(note => note.title), emptyTrash: false })}><Trash2 size={22} /></IconButton></> : <><IconButton label="Pin selected notes" onClick={() => bulk({ pinned: true })}><Pin size={21} /></IconButton><IconButton label={view === 'archive' ? 'Unarchive selected notes' : 'Archive selected notes'} onClick={() => bulk({ archived: view !== 'archive' })}><Archive size={21} /></IconButton><IconButton label="Trash selected notes" onClick={() => bulk({ trashed: true })}><Trash2 size={21} /></IconButton></>}</div></> : <>
        <div className="brand-group"><IconButton label={sidebar ? 'Close navigation' : 'Open navigation'} onClick={() => setSidebar(!sidebar)}><Menu size={23} /></IconButton><button className="brand" onClick={() => navigate('notes')} aria-label="Stow home"><span className="brand-mark"><Logo size={26} strokeWidth={2.3} /></span><span>Stow</span></button></div>
        <div className="search-box"><Search size={21} /><input ref={searchRef} type="search" placeholder="Search" aria-label="Search notes" value={search} onChange={e => setSearch(e.target.value)} />{search && <IconButton label="Clear search" onClick={() => setSearch('')}><X size={20} /></IconButton>}</div>
        <div className="header-actions"><span className={`sync-state sync-${status}`} title={`${syncLabel}${pending ? ` · ${pending} pending changes` : ''}`} role="status" aria-label={syncLabel}>{status === 'online' ? <Cloud size={20} /> : status === 'connecting' ? <LoaderCircle size={19} className="spinning" /> : <CloudOff size={20} />}<span>{status === 'demo' ? 'Demo' : error ? 'Sync issue' : localPending > 0 ? 'Saving…' : status === 'online' ? pending ? 'Syncing…' : imageStatus ? 'Saving images…' : 'Connected' : status === 'connecting' ? 'Connecting…' : status === 'locked' ? 'Locked' : 'Offline'}</span></span><IconButton label="Undo" title={`Undo (${undoShortcut})`} aria-keyshortcuts={macShortcuts ? "Meta+z" : "Control+z"} className="history-button" disabled={!canUndo} onClick={() => undoOrRedo('undo')}><Undo2 size={21} /></IconButton><IconButton label="Redo" title={`Redo (${redoShortcut})`} aria-keyshortcuts={macShortcuts ? "Meta+Shift+z" : "Control+Shift+z Control+y"} className="history-button" disabled={!canRedo} onClick={() => undoOrRedo('redo')}><Redo2 size={21} /></IconButton><IconButton label={listView ? 'Grid view' : 'List view'} className="view-button" onClick={() => setListView(!listView)}>{listView ? <LayoutGrid size={22} /> : <List size={24} />}</IconButton><div className="menu-anchor" ref={settingsRef}><IconButton label="Settings" onClick={() => setSettings(!settings)}><Settings size={22} /></IconButton>{settings && <div className="popup-menu settings-menu"><div className="settings-heading">{user}</div><BuildVersion /><div className="settings-sync"><Cloud size={16} /><span>{syncLabel}</span></div>{installable && <button type="button" onClick={() => { void installStow().catch(() => notify("Could not open the install prompt. Try installing Stow from your browser menu.")); setSettings(false); }}><DownloadCloud size={18} />Install Stow</button>}<HistoryMenu onAction={undoOrRedo} onClose={() => setSettings(false)} /><button disabled={IS_DEMO} title={IS_DEMO ? "The demo does not save notes or history." : undefined} onClick={() => { setSettings(false); setStorageSettings(true); }}><History size={18} />Storage and history</button><button onClick={() => { void store.exportData().catch(error => notify(error instanceof Error ? error.message : 'Could not export the vault.')); setSettings(false); }} disabled={status !== 'online'}><Download size={18} />Download vault backup</button>{status !== 'online' && <button onClick={() => { store.exportCurrentNotes(); setSettings(false); }}><Download size={18} />Export current notes</button>}</div>}</div></div>
      </>}
    </header>
    <>
      {sidebar && <div className="mobile-nav-backdrop" onClick={() => setSidebar(false)} />}
      <aside className="sidebar" aria-label="Main navigation"><nav>{nav.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={`nav-item ${view === id && selectedLabel === null && !query ? 'active' : ''}`} aria-current={view === id && selectedLabel === null && !query ? 'page' : undefined} title={!sidebar ? label : undefined} onClick={() => navigate(id)}><Icon size={22} /><span>{label}</span></button>)}<LabelNavigation onColor={(name, color) => store.vault.setLabelColor(name, color)} onDelete={name => store.vault.deleteLabel(name)} labels={orderedLabels} selected={selectedLabel} expanded={labelsExpanded && sidebar} compact={!sidebar} onExpandedChange={expanded => { setLabelsExpanded(expanded); if (expanded) setSidebar(true); }} onSelect={name => { setSelectedLabel(name); setView('notes'); setSearch(''); setSelected(new Set()); if (window.innerWidth < 900) setSidebar(false); }} /></nav></aside>
      <main className="main-content" tabIndex={-1}>
        {error && <div className="error-banner" role="alert"><CloudOff size={19} /><span>{error}</span></div>}
        {!ready ? <div className="loading-state" role="status" aria-label="Loading notes">
          {status === 'connecting' || status === 'online' ? <><LoaderCircle size={28} className="spinning" aria-hidden="true" /><p>Loading notes…</p></> : <p>{status === 'error' ? 'Notes have not finished loading. Reload to retry.' : 'Connect to finish downloading your notes.'}</p>}
        </div> : <>
          {view === 'notes' && selectedLabel === null && !query && <NewNoteLauncher onCreate={createNote} />}
          {selectedLabel !== null && <div className="view-heading"><h1>{selectedLabel}</h1></div>}
          {view === 'trash' && !query && selectedLabel === null && notes.some(note => note.trashed) && <div className="trash-actions"><button type="button" className="text-button destructive-button" onClick={() => {
            const trashed = notes.filter(note => note.trashed);
            setDeletion({ sourceIds: trashed.flatMap(note => note.sourceIds), titles: trashed.map(note => note.title), emptyTrash: true });
          }}><Trash2 size={18} />Empty trash</button></div>}
          {query && <div className="search-summary">{filtered.length} result{filtered.length === 1 ? '' : 's'} for “{searchResult.label}”</div>}
          {filtered.length ? <div className="notes-container">{renderNoteGroups(live)}{archived.length > 0 && (view === 'archive' && !query && selectedLabel === null ? renderNoteGroups(archived) : <section className={`archived-results ${live.length ? 'after-live-notes' : ''}`} aria-label="Archived notes"><h2 className="archive-fold-heading"><Archive size={18} />Archived notes</h2>{renderNoteGroups(archived)}</section>)}</div> : <div className="empty-state">
            {!query && selectedLabel === null && (view === 'archive' ? <Archive size={88} strokeWidth={1.2} aria-hidden="true" /> : view === 'trash' ? <Trash2 size={88} strokeWidth={1.2} aria-hidden="true" /> : <Logo size={88} strokeWidth={1.2} aria-hidden="true" />)}
            <h2>{query ? 'No matching notes' : selectedLabel !== null ? 'No notes with this label' : view === 'archive' ? 'No archived notes' : view === 'trash' ? 'Trash is empty' : 'No notes'}</h2>
          </div>}
        </>}
      </main>
    </>
    {access === 'ready' && editing && (activeNote || editing.newNote) && <NoteEditor key={editing.key} note={activeNote} initial={editing.newNote}
      onCreated={id => setEditing(current => current?.key === editing.key ? { ...current, noteId: id } : current)}
      labels={orderedLabels} onClose={() => setEditing(null)} onError={notify} onUndoRedo={undoOrRedo} onDelete={deleteNote}
      onRestore={id => { setSelectedLabel(null); setView('notes'); setSearch(''); openNote(id); }} />}
    {deletion && <DeleteNotesDialog deletion={deletion} onDelete={deleteForever} onClose={closeDeletion} />}
    {storageSettings && <StorageSettings onClose={() => setStorageSettings(false)} />}
    <ServerNotice />
    {toast && !syncRejection && <Toast message={toast.message} onDismiss={() => setToast(null)} />}
  </div>;
}
