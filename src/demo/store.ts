import { useSyncExternalStore } from 'react';
import type { AppStore, Snapshot } from '../core/store';
import type { Attachment } from '../core/types';
import { Vault } from '../core/vault';
import { downloadNotes } from '../noteExport';
import { DEMO_IMAGE_MESSAGE } from '../runtime';
import { seedDemo } from './seed';
import { kittenAssets } from './kitten-assets';

/** The static build substitutes this module for core/store at build time. It
 * never constructs the account, persistence, sync, or image-upload services. */
class DemoStore implements AppStore {
  readonly vault = new Vault();
  private listeners = new Set<() => void>();
  private snapshot!: Snapshot;

  constructor() {
    const selected = seedDemo(this.vault, crypto.getRandomValues(new Uint32Array(1))[0]);
    this.vault.doc.on('update', this.refresh);
    for (const event of ['stack-item-added', 'stack-item-popped', 'stack-item-updated', 'stack-cleared'] as const) this.vault.undoManager.on(event, this.refresh);
    this.refresh();
    // Preload only this visit's four photos. All twelve belong to the static
    // bundle, and original/preview viewers share these same immutable assets.
    for (const kitten of selected) { const image = new Image(); image.src = kittenAssets.get(kitten.hash)!.url; }
    window.addEventListener('blur', () => this.vault.finishEdit());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.vault.finishEdit(); });
    // Back/forward cache must not quietly turn this into a persistent vault.
    window.addEventListener('pagehide', () => { this.vault.doc.off('update', this.refresh); this.vault.destroy(); });
    window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  }

  private refresh = () => {
    this.snapshot = {
      notes: this.vault.getNotes(), labels: this.vault.getLabels(), historyVersion: 0,
      status: 'demo', ready: true, access: 'ready', user: 'Demo playground', canReload: true,
      error: null, historyError: null, accessMessage: null, syncRejection: null, automaticReload: false,
      canUndo: this.vault.undoManager.undoStack.length > 0, canRedo: this.vault.undoManager.redoStack.length > 0,
      pending: 0, localPending: 0, images: { pendingUploads: 0, thumbnailsRemaining: 0, originalBytes: 0 },
    };
    this.listeners.forEach(listener => listener());
  };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  async reloadAccount() { location.reload(); }

  private sampleImage(attachment: Attachment) {
    const kitten = kittenAssets.get(attachment.hash);
    if (!kitten) throw new Error('This image is not part of the demo.');
    return { url: kitten.url, release() {} };
  }
  async thumbnailUrl(attachment: Attachment) { return this.sampleImage(attachment); }
  async originalUrl(attachment: Attachment) { return this.sampleImage(attachment); }
  async deleteNotesForever(sourceIds: readonly string[]) { this.vault.deleteNotesForever(sourceIds); }
  exportCurrentNotes() { downloadNotes(this.vault.getNotes(), 'markdown'); }

  // Explicitly unsupported capabilities, also guarded in the UI. These do not
  // fall through to fetch(), even if a caller forgets the feature restriction.
  async addImage(): Promise<never> { throw new Error(DEMO_IMAGE_MESSAGE); }
  async login(): Promise<never> { throw new Error('The demo has no account or sign-in.'); }
  async fetchStorage(): Promise<never> { throw new Error('The demo does not save notes.'); }
  async setHistoryRetention(): Promise<never> { throw new Error('Saved history is unavailable in the demo.'); }
  async setHistoryCompression(): Promise<never> { throw new Error('Saved history is unavailable in the demo.'); }
  async discardArchivedHistory(): Promise<never> { throw new Error('Saved history is unavailable in the demo.'); }
  async fetchHistoryVersions(): Promise<never> { throw new Error('Saved history is unavailable in the demo.'); }
  async fetchHistoryVersion(): Promise<never> { throw new Error('Saved history is unavailable in the demo.'); }
  async restoreHistoryVersion(): Promise<never> { throw new Error('Saved history is unavailable in the demo.'); }
  retainHistoryPreview() { return () => {}; }
  async exportData(): Promise<never> { throw new Error('The demo has no server backup. Export current notes instead.'); }
}

export const store: AppStore = new DemoStore();
export function useStow() { return useSyncExternalStore(store.subscribe, store.getSnapshot); }
