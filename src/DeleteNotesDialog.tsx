import { useEffect, useId, useRef, useState } from 'react';

export interface NoteDeletion {
  sourceIds: string[];
  titles: string[];
  emptyTrash: boolean;
}

export default function DeleteNotesDialog({ deletion, onDelete, onClose }: {
  deletion: NoteDeletion;
  onDelete: (sourceIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId(), descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const count = deletion.titles.length;
  const title = deletion.emptyTrash ? 'Empty trash?' : count === 1 ? 'Delete note forever?' : `Delete ${count} notes forever?`;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current!.showModal();
    cancel.current!.focus();
    return () => {
      dialog.current?.close();
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLElement>('.main-content')?.focus({ preventScroll: true });
    };
  }, []);
  const remove = async () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await onDelete(deletion.sourceIds); onClose(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not delete these notes.'); setBusy(false); }
  };
  return <dialog ref={dialog} className="delete-notes-dialog" role="alertdialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <h2 id={titleId}>{title}</h2>
    <p id={descriptionId}>{count === 1 ? `“${deletion.titles[0] || 'Untitled note'}” and its version history will be deleted.` : `${count} notes and their version histories will be deleted.`} This cannot be undone.</p>
    {error && <p className="delete-error" role="alert">{error}</p>}
    <div className="delete-dialog-actions">
      <button ref={cancel} type="button" className="text-button" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="text-button destructive-button" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : deletion.emptyTrash ? 'Empty trash' : 'Delete forever'}</button>
    </div>
  </dialog>;
}
