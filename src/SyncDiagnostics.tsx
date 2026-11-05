import { useEffect, useId, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import { store, useStow } from './core/store';
import type { BackgroundResult } from './core/background-state';
import BuildVersion from './BuildVersion';
import './syncDiagnostics.css';

export default function SyncDiagnostics({ syncLabel, onClose }: { syncLabel: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const { lastSyncAt, backgroundSync } = useStow();
  const [result, setResult] = useState<BackgroundResult | null>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const element = dialog.current!;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    element.showModal(); closeButton.current!.focus();
    let active = true;
    void store.getBackgroundResult().then(value => { if (active) setResult(value); }, () => { if (active) setError('Could not read background refresh diagnostics.'); });
    return () => {
      active = false; element.close(); document.body.style.overflow = overflow;
      document.querySelector<HTMLElement>('[aria-label="Settings"]')?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className="sync-diagnostics" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <div className="diagnostics-heading"><h2 id={titleId}>Sync diagnostics</h2><button ref={closeButton} type="button" className="icon-button" aria-label="Close sync diagnostics" onClick={onClose}><X size={22} /></button></div>
    <BuildVersion />
    <div className="diagnostics-content">
      <p>{syncLabel}</p>
      {lastSyncAt && <p>Last synced on this device: {new Date(lastSyncAt).toLocaleString()}</p>}
      {backgroundSync && <p>{backgroundSync === 'native' ? 'Background refresh: Android scheduled' : backgroundSync === 'enabled' ? 'Background refresh: registered; timing controlled by browser' : backgroundSync === 'not-permitted' ? 'Background refresh: not permitted by this browser' : backgroundSync === 'error' ? 'Background refresh could not be enabled' : 'Background refresh: unavailable'}</p>}
      {result === null ? <p>Background refresh: no attempts recorded on this device.</p> : result && <>
        <p>Last background attempt: {new Date(result.attemptedAt).toLocaleString()}</p>
        <p>Last background success: {result.completedAt ? new Date(result.completedAt).toLocaleString() : 'none recorded'}</p>
        {result.error ? <p>Last background error: {result.error}</p>
          : result.completedAt === undefined || result.completedAt < result.attemptedAt ? <p>Last attempt has no recorded completion; it may still be running or have been interrupted.</p> : null}
      </>}
      {error && <p className="diagnostics-error" role="alert">{error}</p>}
      <button type="button" className="text-button" onClick={() => { void store.exportBackgroundLog().catch(() => setError('Could not export background refresh diagnostics.')); }}><Download size={16} />Download background log</button>
    </div>
  </dialog>;
}
