import { store, useStow } from './core/store';
import { useEffect, useRef } from 'react';

export default function ServerNotice() {
  const { syncRejection, canReload, automaticReload, error } = useStow();
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (syncRejection?.code === 'client_update_required') notice.current?.focus();
  }, [syncRejection]);
  if (!syncRejection) return null;
  return <div ref={notice} tabIndex={-1} className="toast server-notice" role="alert" aria-label="Sync stopped" aria-atomic="true">
    <div><p>{syncRejection.message}</p>{syncRejection.action === 'reload' && <p className="server-notice-status">
      {!canReload ? error || 'Waiting for your edits to save on this device. Keep this tab open.'
        : automaticReload ? 'Stow will reload after 5 seconds without activity, once your edits are saved on this device.'
          : 'Automatic reload is paused. If this persists after reloading, check that the server is serving the latest build.'}
    </p>}</div>
    {syncRejection.action === 'reload' && <button type="button" disabled={!canReload} onClick={() => void store.reloadAccount()}>Reload</button>}
    {!canReload && error && <button type="button" onClick={() => store.exportCurrentNotes()}>Export current notes</button>}
  </div>;
}
