import { shellConfig, shellMessage } from './core/shell';
/** A compatibility-triggered reload must bypass the installed shell. Ordinary
 * launches stay cache-first; worker installation still precaches updates atomically. */
export function reloadStow() {
  if (shellConfig()) { shellMessage('check-updates'); return; }
  if (!navigator.serviceWorker?.controller) { location.reload(); return; }
  const url = new URL(location.href);
  url.searchParams.set('stow-update', '1');
  history.replaceState(history.state, '', url);
  location.reload();
}
