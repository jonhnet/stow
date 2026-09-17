import { useSyncExternalStore } from 'react';
import { IS_DEMO } from './runtime';

interface InstallPrompt extends Event { prompt(): Promise<unknown> }
const browserMode = window.matchMedia('(display-mode: browser)');
const listeners = new Set<() => void>();
let pending: InstallPrompt | undefined;
let installed = false;
const changed = () => { for (const listener of listeners) listener(); };
const available = () => !IS_DEMO && !!pending && browserMode.matches && !installed;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// Imported by the entry point: Chrome can offer installation before the lazy
// application finishes loading, and long before the Settings menu is opened.
window.addEventListener('beforeinstallprompt', event => {
  if (IS_DEMO) { event.preventDefault(); return; }
  if (!browserMode.matches || installed) return;
  event.preventDefault();
  pending = event as InstallPrompt;
  changed();
});
window.addEventListener('appinstalled', () => {
  installed = true;
  pending = undefined;
  changed();
});
browserMode.addEventListener('change', () => {
  if (!browserMode.matches) pending = undefined;
  changed();
});

export function useInstallable() { return useSyncExternalStore(subscribe, available); }

export async function installStow(): Promise<void> {
  if (!available()) return;
  const event = pending!;
  // Each offer is single-use, even after dismissal or failure. Consume it before
  // invoking Chrome, and invoke synchronously while the click is user-activated.
  pending = undefined;
  changed();
  await event.prompt();
}
