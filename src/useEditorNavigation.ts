import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import type { NoteKind } from './core/types';

export type NewNote = { kind: NoteKind; files?: File[] };
export type EditorSession = { key: string; noteId?: string; newNote?: NewNote };
const entry = (): EditorSession | null => window.history.state?.stowEditor ?? null;

/** An open note is one browser navigation step, also in an installed PWA. */
export function useEditorNavigation() {
  const [editing, setEditing] = useState(entry);
  const current = useRef(editing);
  const closing = useRef(false);
  useEffect(() => {
    const pop = () => {
      closing.current = false;
      current.current = entry(); setEditing(current.current);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const navigate = useCallback((action: SetStateAction<EditorSession | null>) => {
    const previous = current.current;
    const next = typeof action === 'function' ? action(previous) : action;
    if (next === previous || closing.current) return;
    if (!next && entry()) {
      // Wait for popstate so repeated Close presses cannot consume a second
      // entry. Back, Close, Escape, and archive all consume the same step.
      closing.current = true; window.history.back(); return;
    }
    const state = { ...window.history.state, stowEditor: next && {
      key: next.key, noteId: next.noteId,
      // Files are consumed by the original editor, never replayed on Forward.
      ...(next.newNote ? { newNote: { kind: next.newNote.kind } } : {}),
    } };
    if (next && !previous) window.history.pushState(state, '');
    else window.history.replaceState(state, '');
    current.current = next; setEditing(next);
  }, []);
  return [editing, navigate] as const;
}
