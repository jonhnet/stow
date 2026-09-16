export interface SyncRejection {
  code: string;
  message: string;
  action: 'reload' | 'none';
  target: string;
}

export function parseSyncRejection(value: unknown): SyncRejection | null {
  if (value === undefined || value === null) return null;
  const notice = value as Partial<SyncRejection>;
  if (typeof notice.code !== 'string' || !notice.code || notice.code.length > 100 ||
      typeof notice.message !== 'string' || !notice.message || notice.message.length > 2000 ||
      typeof notice.target !== 'string' || !notice.target || notice.target.length > 200 ||
      (notice.action !== 'reload' && notice.action !== 'none')) throw new Error('The server returned an invalid sync rejection. Reload after checking the server configuration.');
  return { code: notice.code, message: notice.message, action: notice.action, target: notice.target };
}

export const UPDATE_IDLE_MS = 5000;

/** Reload only after an uninterrupted idle interval and a completed local flush.
 * The second safety check matters: input can arrive while IndexedDB is saving. */
export class IdleUpdateReload {
  private lastActivity = Date.now();
  private activityVersion = 0;
  private composing = false;
  private busy = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  automatic: boolean;
  private readonly key: string;

  constructor(account: string, target: string, private readonly callbacks: {
    safe: () => boolean;
    save: () => Promise<void>;
    reload: () => void;
    failed: () => void;
  }) {
    this.key = `stow-update-reload:${account}:${target}`;
    try { this.automatic = sessionStorage.getItem(this.key) === null; }
    catch { this.automatic = false; }
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'input', 'wheel', 'focus', 'visibilitychange']) window.addEventListener(event, this.activity, true);
    window.addEventListener('compositionstart', this.compositionStart, true);
    window.addEventListener('compositionend', this.compositionEnd, true);
    this.schedule();
  }

  private activity = () => { this.lastActivity = Date.now(); this.activityVersion++; this.schedule(); };
  private compositionStart = () => { this.composing = true; this.activity(); };
  private compositionEnd = () => { this.composing = false; this.activity(); };
  private idle() { return !this.composing && document.visibilityState === 'visible' && Date.now() - this.lastActivity >= UPDATE_IDLE_MS; }

  private schedule() {
    clearTimeout(this.timer);
    if (this.stopped || !this.automatic) return;
    this.timer = setTimeout(() => void this.attempt(true), Math.max(250, UPDATE_IDLE_MS - (Date.now() - this.lastActivity)));
  }

  async attempt(automatic = false) {
    if (this.stopped || this.busy || this.composing || !this.callbacks.safe() || (automatic && (!this.automatic || !this.idle()))) {
      this.schedule(); return;
    }
    this.busy = true;
    const activity = this.activityVersion;
    try {
      await this.callbacks.save();
      if (this.stopped || this.composing || !this.callbacks.safe() || this.activityVersion !== activity || (automatic && !this.idle())) return;
      // Mark before navigation. A cached bundle may still be rejected after a
      // reload; it must leave a durable notice instead of reloading in a loop.
      try { sessionStorage.setItem(this.key, 'attempted'); }
      catch { if (automatic) { this.automatic = false; this.callbacks.failed(); return; } }
      this.stop();
      this.callbacks.reload();
    } catch { this.automatic = false; this.callbacks.failed(); }
    finally { this.busy = false; this.schedule(); }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'input', 'wheel', 'focus', 'visibilitychange']) window.removeEventListener(event, this.activity, true);
    window.removeEventListener('compositionstart', this.compositionStart, true);
    window.removeEventListener('compositionend', this.compositionEnd, true);
  }
}
