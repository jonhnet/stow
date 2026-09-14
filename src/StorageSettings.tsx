import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, X } from 'lucide-react';
import { store } from './core/store';
import type { VaultStorage } from './core/storage-types';
import './storageSettings.css';

function bytes(value: number) {
  if (value < 1024) return `${value.toLocaleString()} B`;
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
  return `${(value / 1024 ** exponent).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB'][exponent]}`;
}

type Confirmation = { kind: 'enable' } | { kind: 'enable-compression' } | { kind: 'discard'; storage: VaultStorage };

function ConfirmHistoryCleanup({ confirmation, onComplete, onClose }: {
  confirmation: Confirmation;
  onComplete: (storage: VaultStorage) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId(), descriptionId = useId();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const enabling = confirmation.kind !== 'discard', live = confirmation.kind === 'enable-compression';
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal(); cancel.current!.focus();
    return () => { element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const confirm = async () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const storage = confirmation.kind === 'enable-compression' ? await store.setHistoryCompression(true) : confirmation.kind === 'enable'
        ? await store.setHistoryRetention(true)
        : (await store.discardArchivedHistory(confirmation.storage)).storage;
      onComplete(storage);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not update archived history.'); setBusy(false); }
  };
  return <dialog ref={dialog} className="delete-notes-dialog history-cleanup-confirm" role="alertdialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <h2 id={titleId}>{live ? 'Compress older note history?' : enabling ? 'Enable automatic history cleanup?' : 'Discard archived history now?'}</h2>
    <div id={descriptionId}>
      {live ? <><p>When a note exceeds 100 saved versions, keep its newest 50 versions and 25 older versions spaced across its history.</p><p>Intermediate older versions are permanently discarded. This applies to existing history too. Saved history is stored on the server. Current edits and local Undo are preserved.</p></> : confirmation.kind === 'enable' ? <><p>Version history will be permanently discarded after notes have been archived and unchanged for 7 days.</p><p>Existing archived notes get a full 7 days when this is enabled.</p></> : confirmation.kind === 'discard' ? <p>Version history for {confirmation.storage.archivedNoteCount.toLocaleString()} archived {confirmation.storage.archivedNoteCount === 1 ? 'note' : 'notes'} will be permanently discarded now, without the 7-day wait.</p> : null}
      <p>Current contents and note dates are preserved. Discarded history cannot be restored.</p>
    </div>
    {error && <p className="delete-error" role="alert">{error}</p>}
    <div className="delete-dialog-actions">
      <button ref={cancel} type="button" className="text-button" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="text-button destructive-button" disabled={busy} onClick={() => void confirm()}>{busy ? 'Saving…' : enabling ? 'Enable cleanup' : 'Discard history'}</button>
    </div>
  </dialog>;
}

export default function StorageSettings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId(), policyDescriptionId = useId();
  const [storage, setStorage] = useState<VaultStorage>();
  const [busy, setBusy] = useState(true), [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [protectedStorage, setProtectedStorage] = useState<boolean>();
  const [requestingProtection, setRequestingProtection] = useState(false);
  useEffect(() => {
    const element = dialog.current!;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    element.showModal(); closeButton.current!.focus();
    let active = true;
    void navigator.storage.persisted().then(value => { if (active) setProtectedStorage(value); }).catch(() => {});
    void store.fetchStorage().then(value => { if (active) setStorage(value); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : 'Could not load storage information.'); })
      .finally(() => { if (active) setBusy(false); });
    return () => {
      active = false; element.close(); document.body.style.overflow = overflow;
      document.querySelector<HTMLElement>('[aria-label="Settings"]')?.focus({ preventScroll: true });
    };
  }, []);
  const update = async (request: () => Promise<VaultStorage>, changesSetting = false) => {
    if (busy) return;
    setBusy(true); setSaving(changesSetting); setError(undefined);
    try { setStorage(await request()); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not update storage settings.'); }
    finally { setBusy(false); setSaving(false); }
  };
  const protectStorage = async () => {
    if (requestingProtection) return;
    setRequestingProtection(true);
    try { setProtectedStorage(await navigator.storage.persist()); }
    catch { setError('The browser could not protect local storage. Try again.'); }
    finally { setRequestingProtection(false); }
  };
  return <>
    <dialog ref={dialog} className="storage-settings" aria-labelledby={titleId} aria-busy={busy}
      onCancel={event => { event.preventDefault(); if (!saving) onClose(); }} onKeyDown={event => event.stopPropagation()}>
      <div className="storage-heading"><h2 id={titleId}>Storage and history</h2><button ref={closeButton} type="button" className="icon-button" aria-label="Close storage settings" disabled={saving} onClick={onClose}><X size={22} /></button></div>
      <div className="storage-content">
        {error && <p className="storage-error" role="alert">{error}</p>}
        <section className="storage-history" aria-labelledby={`${titleId}-local`}>
          <h3 id={`${titleId}-local`}>Local storage</h3>
          <p className="storage-explanation">{protectedStorage === true ? 'Protected from automatic eviction by the browser.' : 'The browser may clear local data when device storage is low. Protect it to help keep offline edits available.'}</p>
          {protectedStorage !== true && <button type="button" className="text-button" disabled={requestingProtection} onClick={() => void protectStorage()}>{requestingProtection ? 'Waiting for browser permission…' : 'Protect local storage'}</button>}
        </section>
        {!storage && busy && <div className="storage-loading" role="status" aria-label="Loading storage information"><LoaderCircle size={24} className="spinning" aria-hidden="true" /></div>}
        {storage && <>
          <section aria-labelledby={`${titleId}-usage`}>
            <div className="storage-section-heading"><h3 id={`${titleId}-usage`}>Server storage</h3><button type="button" className="icon-button" aria-label="Refresh storage information" title="Refresh storage information" disabled={busy} onClick={() => void update(() => store.fetchStorage())}><RefreshCw size={17} className={busy ? 'spinning' : undefined} /></button></div>
            <dl className="storage-figures">
              <div><dt>Current notes (synced to devices)</dt><dd>{bytes(storage.crdtBytes)}</dd></div>
              <div className="storage-detail"><dt>Saved history (server only)</dt><dd>{bytes(storage.historyBytes)}</dd></div>
              <div><dt>Vault files on disk</dt><dd>{bytes(storage.durableBytes)}</dd></div>
              <div><dt>Original attachments</dt><dd>{bytes(storage.originalsBytes)}</dd></div>
              <div><dt>Thumbnails</dt><dd>{bytes(storage.thumbnailsBytes)}</dd></div>
            </dl>
            <p className="storage-explanation">Saved versions are fetched when opened. Vault files contain current notes and their pending log compaction.</p>
          </section>
          <section className="storage-history" aria-labelledby={`${titleId}-retention`}>
            <h3 id={`${titleId}-retention`}>Archived history</h3>
            <label className="storage-policy"><input type="checkbox" checked={storage.retention.enabled} disabled={busy} aria-describedby={policyDescriptionId} onChange={event => {
              if (event.currentTarget.checked) setConfirmation({ kind: 'enable' });
              else void update(() => store.setHistoryRetention(false), true);
            }} /><span>Discard history after archived notes have been unchanged for 7 days</span></label>
            <p id={policyDescriptionId} className="storage-explanation">Editing an archived note restarts the wait. Unarchiving stops cleanup. The server checks every 4 hours.</p>
            <button type="button" className="text-button destructive-button storage-discard" disabled={busy || storage.archivedNoteCount === 0} onClick={() => setConfirmation({ kind: 'discard', storage })}>Discard archived history now…</button>
          </section>
          <section className="storage-history" aria-labelledby={`${titleId}-compression`}>
            <h3 id={`${titleId}-compression`}>Note history</h3>
            <label className="storage-policy"><input type="checkbox" checked={storage.compression.enabled} disabled={busy} aria-describedby={`${policyDescriptionId}-live`} onChange={event => {
              if (event.currentTarget.checked) setConfirmation({ kind: 'enable-compression' });
              else void update(() => store.setHistoryCompression(false), true);
            }} /><span>Compress older note history</span></label>
            <p id={`${policyDescriptionId}-live`} className="storage-explanation">Above 100 saved versions, keep the newest 50 and 25 older versions. Intermediate older versions are discarded. Current contents and Undo stay available. Applies to active, archived, and trashed notes.</p>
          </section>
        </>}
        {!storage && !busy && <button type="button" className="text-button" onClick={() => void update(() => store.fetchStorage())}>Try again</button>}
      </div>
    </dialog>
    {confirmation && <ConfirmHistoryCleanup confirmation={confirmation} onClose={() => setConfirmation(undefined)} onComplete={value => { setStorage(value); setError(undefined); setConfirmation(undefined); }} />}
  </>;
}
