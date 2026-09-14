import { useEffect, useState } from 'react';
import type { Note } from './core/types';
import { CurrentNoteSearch } from './currentSearch';

const empty = { query: '', label: '', ids: new Set<string>() };

/** Keep the last complete results visible until the latest notes have been indexed. */
export function useCurrentSearch(notes: readonly Note[], search: string, onError: (message: string) => void) {
  const [index] = useState(() => new CurrentNoteSearch());
  const [result, setResult] = useState(empty);
  const query = search.trim().toLowerCase();
  useEffect(() => () => index.cancel(), [index]);
  useEffect(() => {
    let current = true;
    if (!query) setResult(empty);
    void index.update(notes).then(() => {
      if (current && query) setResult({ query, label: search, ids: new Set(notes.filter(note => index.matches(note.id, query)).map(note => note.id)) });
    }).catch(error => {
      if (current) onError(error instanceof Error ? error.message : 'Could not prepare note search.');
    });
    return () => { current = false; };
  }, [index, notes, query, search, onError]);
  return query ? result : empty;
}
