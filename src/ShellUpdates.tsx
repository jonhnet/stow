import { useEffect, useRef, useState } from 'react';
import { shellConfig, shellMessage, type AndroidRelease } from './core/shell';
import { store } from './core/store';

export interface ShellView { view: 'notes' | 'archive' | 'trash'; search: string; selectedLabel: string | null; listView: boolean }
interface SavedView extends ShellView { y: number; anchor?: { id: string; offset: number }; release: string }
interface Updates { pending?: string; requiresShell?: boolean; android?: AndroidRelease | null }
const sameAndroidRelease = (a: AndroidRelease | null | undefined, b: AndroidRelease) => a?.version === b.version && a.url === b.url && a.sha256 === b.sha256;
// Settings reads the current manifest independently of the shell's cached
// metadata. Let the installed shell acquire that exact selection before asking
// its existing verified installer to use it. No new APK/bridge API is needed.
function confirmAndroidRelease(expected: AndroidRelease, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const clean = () => { window.removeEventListener('stow-shell', receive); signal.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(new Error('Could not check the Android update. Connect and try again.')); };
    const receive = (event: Event) => {
      const message = (event as CustomEvent).detail;
      if (message.type !== 'updates' || !sameAndroidRelease(message.android, expected)) return;
      clean(); resolve();
    };
    if (signal.aborted) { abort(); return; }
    window.addEventListener('stow-shell', receive); signal.addEventListener('abort', abort, { once: true });
    try { shellMessage('check-updates'); } catch (error) { clean(); reject(error); }
  });
}
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
  const checking = useRef<AbortController | undefined>(undefined);
  const [checkingAndroid, setCheckingAndroid] = useState(false);
  const interacting = useRef({ pointers: new Set<number>(), composing: false, dragging: false });
  const unsafe = (blockedRestart = false) => (!blockedRestart && current.current.busy) || interacting.current.pointers.size > 0 || interacting.current.composing || interacting.current.dragging || (!blockedRestart && !!document.querySelector('[role="dialog"], .popup-menu'));
  const shell = shellConfig();
  async function restart(automatic: boolean, apk = false, expected?: AndroidRelease) {
    const blockedRestart = !automatic && store.getSnapshot().syncRejection?.code === 'client_update_required';
    if (!shell || switching.current || (!apk && !current.current.updates.pending) || unsafe(blockedRestart) || !store.getSnapshot().canReload) return;
    const stamp = activity.current; switching.current = true;
    try {
      setError('');
      if (expected && !sameAndroidRelease(current.current.updates.android, expected)) {
        checking.current = new AbortController(); setCheckingAndroid(true);
        // Native release downloads have a two-minute deadline.
        await confirmAndroidRelease(expected, AbortSignal.any([checking.current.signal, AbortSignal.timeout(130_000)]));
      }
      if (stamp !== activity.current || unsafe(blockedRestart) || !store.getSnapshot().canReload) return;
      await store.prepareRestart();
      if (stamp !== activity.current || unsafe(blockedRestart) || !store.getSnapshot().canReload) return;
      const anchor = [...document.querySelectorAll<HTMLElement>('[data-note-id]')].filter(e => e.getBoundingClientRect().bottom > 80).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
      const saved: SavedView = { ...current.current.view, y: window.scrollY, release: shell.release,
        ...(anchor ? { anchor: { id: anchor.dataset.noteId!, offset: anchor.getBoundingClientRect().top } } : {}) };
      localStorage.setItem(key(), JSON.stringify(saved));
      shellMessage(apk ? 'update-apk' : 'activate', { automatic });
    } catch (e) { if (!checking.current?.signal.aborted) setError(e instanceof Error ? e.message : 'Could not restart Stow.'); }
    finally { checking.current = undefined; setCheckingAndroid(false); switching.current = false; }
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
      if (message.type === 'hidden') { checking.current?.abort(); void restart(true); }
    };
    window.addEventListener('stow-shell', receive);
    for (const name of ['pointerdown', 'pointerup', 'pointercancel', 'input', 'compositionstart', 'compositionend', 'keydown', 'dragstart', 'dragend']) window.addEventListener(name, userActivity, true);
    shellMessage('ready');
    return () => { checking.current?.abort(); window.removeEventListener('stow-shell', receive); for (const name of ['pointerdown', 'pointerup', 'pointercancel', 'input', 'compositionstart', 'compositionend', 'keydown', 'dragstart', 'dragend']) window.removeEventListener(name, userActivity, true); };
  }, []);
  const notice = shell && (updates.pending || updates.requiresShell || (updates.android && updates.android.version > shell.version) || error || checkingAndroid) ? <div className="shell-update" role="status">
    {checkingAndroid && <span>Checking Android update…</span>}
    {updates.pending && <span>New Stow update available <button disabled={(busy && store.getSnapshot().syncRejection?.code !== 'client_update_required') || !store.getSnapshot().canReload} onClick={() => void restart(false)}>Restart</button></span>}
    {(updates.requiresShell || (updates.android && updates.android.version > shell.version)) && <span>{updates.requiresShell ? 'Update the Android app to use the new Stow release.' : 'Android app update available.'}{updates.android && <button disabled={(busy && store.getSnapshot().syncRejection?.code !== 'client_update_required') || !store.getSnapshot().canReload} onClick={() => void restart(false, true)}>Update</button>}</span>}
    {error && <span role="alert">{error}</span>}
  </div> : null;
  return { notice, updateAndroid: (release: AndroidRelease) => restart(false, true, release) };
}
