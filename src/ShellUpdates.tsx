import { useEffect, useRef, useState } from 'react';
import { shellConfig, shellMessage } from './core/shell';
import { store } from './core/store';

export interface ShellView { view: 'notes' | 'archive' | 'trash'; search: string; selectedLabel: string | null; listView: boolean }
interface SavedView extends ShellView { y: number; anchor?: { id: string; offset: number }; release: string }
interface Updates { pending?: string; requiresShell?: boolean; android?: { version: number; minSdk: number } }
const key = () => `stow-shell-view:${shellConfig()?.account.vaultId}`;
export function restoredShellView(): SavedView | undefined {
  if (!shellConfig()) return;
  try {
    const value = JSON.parse(localStorage.getItem(key()) ?? 'null');
    if (!value || !['notes', 'archive', 'trash'].includes(value.view) || typeof value.search !== 'string' || !(value.selectedLabel === null || typeof value.selectedLabel === 'string') || typeof value.listView !== 'boolean' || !Number.isFinite(value.y)) return;
    return value;
  } catch { return; }
}
export function useRestoreShellScroll(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const saved = restoredShellView(); if (!saved) return;
    let frames = 0, canceled = false, handle = 0;
    const cancel = (event?: Event) => { canceled = true; cancelAnimationFrame(handle); if (event) localStorage.removeItem(key()); };
    const restore = () => {
      if (canceled) return;
      window.scrollTo(0, saved.y);
      const anchor = saved.anchor && document.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(saved.anchor.id)}"]`);
      if (anchor && saved.anchor) window.scrollBy(0, anchor.getBoundingClientRect().top - saved.anchor.offset);
      if (++frames < 12) handle = requestAnimationFrame(restore);
      else localStorage.removeItem(key());
    };
    handle = requestAnimationFrame(restore);
    window.addEventListener('pointerdown', cancel, { once: true }); window.addEventListener('wheel', cancel, { once: true });
    return () => { cancel(); window.removeEventListener('pointerdown', cancel); window.removeEventListener('wheel', cancel); };
  }, [ready]);
}
export function useShellUpdates(view: ShellView, busy: boolean) {
  const [updates, setUpdates] = useState<Updates>({}); const [error, setError] = useState('');
  const current = useRef({ view, busy, updates }); current.current = { view, busy, updates };
  const switching = useRef(false); const activity = useRef(0);
  const interacting = useRef({ pointers: new Set<number>(), composing: false, dragging: false });
  const unsafe = (blockedRestart = false) => (!blockedRestart && current.current.busy) || interacting.current.pointers.size > 0 || interacting.current.composing || interacting.current.dragging || (!blockedRestart && !!document.querySelector('[role="dialog"], .popup-menu'));
  const shell = shellConfig();
  async function restart(automatic: boolean, apk = false) {
    const blockedRestart = !automatic && store.getSnapshot().syncRejection?.code === 'client_update_required';
    if (!shell || switching.current || (!apk && !current.current.updates.pending) || unsafe(blockedRestart) || !store.getSnapshot().canReload) return;
    const stamp = activity.current; switching.current = true;
    try {
      await store.prepareRestart();
      if (stamp !== activity.current || unsafe(blockedRestart) || !store.getSnapshot().canReload) return;
      const anchor = [...document.querySelectorAll<HTMLElement>('[data-note-id]')].filter(e => e.getBoundingClientRect().bottom > 80).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
      const saved: SavedView = { ...current.current.view, y: window.scrollY, release: shell.release,
        ...(anchor ? { anchor: { id: anchor.dataset.noteId!, offset: anchor.getBoundingClientRect().top } } : {}) };
      localStorage.setItem(key(), JSON.stringify(saved));
      shellMessage(apk ? 'update-apk' : 'activate', { automatic });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not restart Stow.'); }
    finally { switching.current = false; }
  }
  useEffect(() => {
    if (!shell) return;
    const userActivity = (event: Event) => {
      activity.current++;
      if (event.type === 'pointerdown') interacting.current.pointers.add((event as PointerEvent).pointerId);
      if (event.type === 'pointerup' || event.type === 'pointercancel') interacting.current.pointers.delete((event as PointerEvent).pointerId);
      if (event.type === 'compositionstart') interacting.current.composing = true;
      if (event.type === 'compositionend') interacting.current.composing = false;
      if (event.type === 'dragstart') interacting.current.dragging = true;
      if (event.type === 'dragend') interacting.current.dragging = false;
    };
    const receive = (event: Event) => {
      const message = (event as CustomEvent).detail;
      if (message.type === 'updates') setUpdates(message);
      if (message.type === 'hidden') void restart(true);
    };
    window.addEventListener('stow-shell', receive);
    for (const name of ['pointerdown', 'pointerup', 'pointercancel', 'input', 'compositionstart', 'compositionend', 'keydown', 'dragstart', 'dragend']) window.addEventListener(name, userActivity, true);
    shellMessage('ready');
    return () => { window.removeEventListener('stow-shell', receive); for (const name of ['pointerdown', 'pointerup', 'pointercancel', 'input', 'compositionstart', 'compositionend', 'keydown', 'dragstart', 'dragend']) window.removeEventListener(name, userActivity, true); };
  }, []);
  if (!shell) return null;
  return (updates.pending || updates.requiresShell || (updates.android && updates.android.version > shell.version) || error) ? <div className="shell-update" role="status">
    {updates.pending && <span>New Stow update available <button disabled={(busy && store.getSnapshot().syncRejection?.code !== 'client_update_required') || !store.getSnapshot().canReload} onClick={() => void restart(false)}>Restart</button></span>}
    {(updates.requiresShell || (updates.android && updates.android.version > shell.version)) && <span>{updates.requiresShell ? 'Update the Android app to use the new Stow release.' : 'Android app update available.'}{updates.android && <button disabled={(busy && store.getSnapshot().syncRejection?.code !== 'client_update_required') || !store.getSnapshot().canReload} onClick={() => void restart(false, true)}>Update</button>}</span>}
    {error && <span role="alert">{error}</span>}
  </div> : null;
}
