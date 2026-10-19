import { useEffect, useRef, useState } from 'react';
import { store } from './core/store';
import type { Note } from './core/types';

export function SharedParticipants({ note }: { note: Note }) {
  if (!note.sharing) return null;
  return <div className="shared-participants" aria-label="Shared note participants"><span>Shared</span>{note.sharing.participants.map(person => <span className="participant-avatar" key={person.id} title={person.name} aria-label={person.name}>{person.guest ? '🐔' : person.name.split('@')[0].slice(0, 2).toUpperCase()}</span>)}{note.sharing.loading && <span role="status">{note.sharing.error ?? 'Loading shared note…'}</span>}</div>;
}
export function ShareNote({ note, onClose }: { note: Note; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current!.showModal();
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const publish = async () => {
    setBusy(true); setError('');
    try { setUrl(await store.shareNote(note.id)); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not share this note.'); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="share-dialog" aria-label="Share note" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <h2>Share {note.title || 'note'}</h2>
    <p>Anyone with this link can read and edit the note, and can forward the link. There is no owner or link revocation.</p>
    {!note.sharing && !url && <p>Sharing starts a new content history. Changes still offline on another device will not be included. Your placement, labels, and archive state stay private.</p>}
    {url ? <><label>Sharing link<input aria-label="Sharing link" readOnly value={url} onFocus={e => e.currentTarget.select()} /></label><button onClick={() => void navigator.clipboard.writeText(url).catch(() => setError('Select and copy the sharing link.'))}>Copy link</button></> : <button disabled={busy} onClick={() => void publish()}>{busy ? 'Preparing link…' : note.sharing ? 'Show sharing link' : 'Create sharing link'}</button>}
    {error && <p role="alert">{error}</p>}<button disabled={busy} onClick={onClose}>{url ? 'Done' : 'Cancel'}</button>
  </dialog>;
}
