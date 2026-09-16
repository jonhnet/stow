import { store, useStow } from './core/store';

export default function ServerNotice() {
  const { syncRejection, canReload, automaticReload, error } = useStow();
  if (!syncRejection) return null;
  return <div className="toast server-notice" role="alert" aria-label="Sync stopped" aria-atomic="true">
    <div><p>{syncRejection.message}</p>{syncRejection.action === 'reload' && <p className="server-notice-status">
      {!canReload ? error || 'Waiting for your edits to save on this device. Keep this tab open.'
        : automaticReload ? 'Stow will reload after 5 seconds without activity, once your edits are saved on this device.'
          : 'Automatic reload is paused. If this persists after reloading, check that the server is serving the latest build.'}
    </p>}</div>
    {syncRejection.action === 'reload' && <button type="button" disabled={!canReload} onClick={() => void store.reloadAccount()}>Reload</button>}
  </div>;
}
