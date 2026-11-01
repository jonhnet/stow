import * as Y from 'yjs';
import type { StowStore, Snapshot } from './store';
import type { Note, Attachment } from './types';
import type { Vault } from './vault';
import { ScopedUndo } from './scoped-undo';
import { capability, parseCapability, sharedReference, newSharedReference, sharedSnapshot, referencedNote, type SharedReference, type Participant } from './shared-note';

export interface SharingActions {
  readonly sharedPage: boolean;
  shareNote(id: string): Promise<string>;
  addSharedToCollection(): Promise<void>;
  refreshParticipants(): Promise<void>;
}
export function landingReference(): SharedReference | undefined {
  if (location.pathname !== '/share') return undefined;
  return parseCapability(decodeURIComponent(location.hash.slice(1)));
}
const base64 = (bytes: Uint8Array) => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); };

/** Routes UI operations, without combining documents or their update streams. */
export function collectionStore(primary: StowStore, create: (ref: SharedReference) => StowStore): StowStore & SharingActions {
  const sharedPage = !!primary.shared;
  const scopes = new Map<string, StowStore>();
  if (primary.shared) scopes.set(primary.shared.id, primary);
  const allStores = () => [...new Set([primary, ...scopes.values()])];
  const barrier = { safe: () => allStores().every(s => s.getSnapshot().canReload), save: async () => { await Promise.all(allStores().map(s => s.saveBeforeReload())); } };
  primary.reloadBarrier = barrier;
  const participants = new Map<string, Participant[]>();
  const memberVersions = new Map<string, number>();
  const memberRequests = new Map<string, number>();
  const memberRetries = new Map<string, ReturnType<typeof setTimeout>>();
  const undo = new ScopedUndo(); undo.add(primary.vault, () => primary.getSnapshot().access === 'ready');
  const restored = new Set<StowStore>();
  const listeners = new Set<() => void>();
  let snapshot: Snapshot, refreshing = false;
  const versions = new Map<string, StowStore>();
  const views = new Map<string, { reference: Note; content: Note; participants?: Participant[]; view: Note }>();
  // Save/sync notifications run several times per keystroke. Resolve sharing
  // from an index, rather than rereading every note's CRDT maps each time.
  const references = new Map<string, SharedReference>();
  const readReference = (id: string) => {
    const ref = sharedReference(primary.vault.notes.get(id)?.get('share'));
    if (ref) references.set(id, ref); else references.delete(id);
  };
  if (!sharedPage) {
    for (const id of primary.vault.notes.keys()) readReference(id);
    primary.vault.notes.observeDeep(events => {
      const changed = new Set<string>();
      for (const event of events) {
        if (!(event instanceof Y.YMapEvent)) continue;
        if (event.target === primary.vault.notes) for (const id of event.keysChanged) changed.add(id);
        else if (event.path.length === 1 && event.keysChanged.has('share')) changed.add(String(event.path[0]));
      }
      // Read the final transaction state, including replaced/deleted records.
      for (const id of changed) readReference(id);
    });
  }
  const reference = (id: string) => sharedPage ? (id === primary.shared?.id ? primary.shared : undefined) : references.get(id);
  const contentId = (id: string) => reference(id)?.id ?? id;
  const owner = (id: string): StowStore => {
    const ref = reference(id) ?? scopes.get(id)?.shared;
    if (ref) { const scope = scopes.get(ref.id); if (!scope?.getSnapshot().ready || scope.getSnapshot().access !== 'ready') throw new Error('This shared note is still loading or unavailable.'); return scope; }
    return [...scopes.values()].find(scope => scope.vault.items.has(id) || scope.vault.attachments.has(id)) ?? primary;
  };
  const loadParticipants = async (ref: SharedReference) => {
    clearTimeout(memberRetries.get(ref.id));
    const request = (memberRequests.get(ref.id) ?? 0) + 1; memberRequests.set(ref.id, request);
    const response = await fetch('/api/shares/participants', { headers: { 'X-Stow-Share': capability(ref) }, cache: 'no-store', redirect: 'manual' });
    if (!response.ok) {
      if (response.status === 503 && memberRequests.get(ref.id) === request) memberRetries.set(ref.id, setTimeout(() => { void loadParticipants(ref).catch(() => {}); }, 1000));
      throw new Error('Could not load shared participants.');
    }
    const result = await response.json();
    if (memberRequests.get(ref.id) !== request) return;
    participants.set(ref.id, result.participants); refresh();
  };
  function refresh() {
    if (refreshing) return; refreshing = true;
    try {
      for (const scope of allStores()) if (scope.getSnapshot().ready && !restored.has(scope)) { restored.add(scope); undo.restored(scope.vault); }
      const current = primary.getSnapshot();
      for (const note of current.notes) {
        const ref = reference(note.id);
        if (ref && !scopes.has(ref.id)) {
          const scope = create(ref); scope.reloadBarrier = barrier; scopes.set(ref.id, scope); undo.add(scope.vault, () => scope.getSnapshot().access === 'ready' && primary.getSnapshot().notes.some(note => reference(note.id)?.id === ref.id)); scope.subscribe(refresh);
          void loadParticipants(ref).catch(() => {});
        }
      }
      for (const scope of scopes.values()) {
        const state = scope.getSnapshot(), version = state.membershipVersion ?? 0;
        if (state.ready && state.access === 'ready' && memberVersions.get(scope.shared!.id) !== version) {
          memberVersions.set(scope.shared!.id, version);
          void loadParticipants(scope.shared!).catch(() => {});
        }
      }
      const notes = current.notes.map(note => {
        const ref = reference(note.id); if (!ref) return note;
        const scope = scopes.get(ref.id)!, state = scope.getSnapshot(), content = scope.vault.getNote(ref.id);
        const people = participants.get(ref.id);
        if (content && state.access === 'ready') {
          const cached = views.get(note.id);
          if (cached?.reference === note && cached.content === content && cached.participants === people) return cached.view;
          const view = { ...referencedNote(note, content), sharing: { participants: people ?? [], loading: false } };
          views.set(note.id, { reference: note, content, participants: people, view }); return view;
        }
        return { ...note, sharing: { participants: people ?? [], loading: true, error: state.accessMessage ?? state.error ?? undefined } };
      });
      const additional = [...scopes.values()].filter(scope => scope !== primary).map(scope => scope.getSnapshot());
      snapshot = { ...current, notes, canUndo: undo.can('undo'), canRedo: undo.can('redo'),
        images: additional.reduce((sum, s) => ({ pendingUploads: sum.pendingUploads + s.images.pendingUploads, thumbnailsRemaining: sum.thumbnailsRemaining + s.images.thumbnailsRemaining, originalBytes: sum.originalBytes + s.images.originalBytes }), current.images),
        automaticReload: current.automaticReload || additional.some(s => s.automaticReload),
        syncRejection: current.syncRejection ?? additional.find(s => s.syncRejection)?.syncRejection ?? null,
        historyError: current.historyError ?? additional.find(s => s.historyError)?.historyError ?? null,
        historyVersion: current.historyVersion + additional.reduce((sum, s) => sum + s.historyVersion, 0),
        localPending: current.localPending + additional.reduce((sum, s) => sum + s.localPending, 0),
        pending: current.pending + additional.reduce((sum, s) => sum + s.pending, 0),
        canReload: current.canReload && additional.every(s => s.canReload),
        error: current.error ?? additional.find(s => s.error || s.accessMessage)?.error ?? additional.find(s => s.accessMessage)?.accessMessage ?? null,
        status: current.status === 'online' && additional.some(s => s.status !== 'online') ? 'connecting' : current.status,
      };
    } finally { refreshing = false; }
    for (const listener of listeners) listener();
  }
  const privateMethods = new Set(['setNoteLabel', 'moveNoteRelative', 'createNote', 'deleteLabel', 'setLabelColor']);
  const proxyVault = new Proxy(primary.vault, { get(target, key) {
    if (key === 'getNotes') return () => snapshot.notes;
    if (key === 'getNote') return (id: string) => snapshot.notes.find(n => n.id === id || n.sourceIds.includes(id));
    if (key === 'getItems') return (id: string) => snapshot.notes.find(n => n.id === id)?.items ?? [];
    if (key === 'undo' || key === 'redo') return () => { const result = undo.run(key); refresh(); return result; };
    if (key === 'finishEdit' || key === 'breakUndo' || key === 'beginComposition' || key === 'endComposition') return (...args: []) => { primary.vault[key](...args); for (const scope of scopes.values()) if (scope !== primary) scope.vault[key](...args); };
    const member = Reflect.get(target, key);
    if (typeof member !== 'function') return member;
    return (...args: unknown[]) => {
      if (key === 'mergeNotes' || key === 'splitNote') {
        const ids = Array.isArray(args[0]) ? args[0] : [args[0]];
        if (ids.some(id => typeof id === 'string' && reference(id))) throw new Error('Shared notes cannot be merged or split.');
      }
      const personal = privateMethods.has(String(key)) || key === 'setNoteMeta' && !(args[1] as { kind?: string })?.kind;
      if (sharedPage && (personal || key === 'deleteNotesForever')) throw new Error('Add this note to your collection to organize it.');
      const scope = !personal && typeof args[0] === 'string' ? owner(args[0]) : primary;
      undo.before(scope.vault);
      if (!personal && typeof args[0] === 'string') args[0] = contentId(args[0]);
      return (Reflect.get(scope.vault, key) as (...args: unknown[]) => unknown).apply(scope.vault, args);
    };
  } });
  const extras: SharingActions = {
    sharedPage,
    async shareNote(id) {
      const existing = reference(id);
      if (existing) return `${location.origin}/share#${capability(existing)}`;
      await primary.whenSynchronized();
      const journal = `stow-publish-${primary.verifiedAccountId()}-${id}`;
      const saved = localStorage.getItem(journal);
      let request;
      if (saved) request = JSON.parse(saved);
      else {
        const note = primary.vault.getNote(id); if (!note) throw new Error('The note is no longer available.');
        const ref = newSharedReference(), doc = sharedSnapshot(note, ref.id);
        request = { capability: capability(ref), sourceIds: note.sourceIds, snapshot: base64(Y.encodeStateAsUpdate(doc)) };
        doc.destroy();
        // Persist before sending: a lost response retries the same publication.
        localStorage.setItem(journal, JSON.stringify(request));
      }
      await primary.storageRequest('/api/shares/publish', 'POST', request);
      localStorage.removeItem(journal);
      return `${location.origin}/share#${request.capability}`;
    },
    async addSharedToCollection() {
      if (!primary.shared) return;
      const response = await fetch('/api/shares/add', { method: 'POST', headers: { 'X-Stow-Share': capability(primary.shared), 'X-Stow-Vault': primary.verifiedAccountId() }, redirect: 'manual' });
      if (!response.ok) throw new Error('Sign in before adding this note to your collection.');
      location.assign('/');
    },
    async refreshParticipants() { await Promise.all([...scopes.values()].map(scope => loadParticipants(scope.shared!))); },
  };
  const historyScope = (id: string) => versions.get(id) ?? primary;
  const proxy = new Proxy(primary, { get(target, key) {
    if (key === 'vault') return proxyVault;
    if (key === 'getSnapshot') return () => snapshot;
    if (key === 'subscribe') return (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
    if (key in extras) return Reflect.get(extras, key);
    if (key === 'fetchHistoryVersions') return async (id: string, cursor?: string) => {
      const scope = owner(id), page = await scope.fetchHistoryVersions(contentId(id), cursor);
      for (const version of page.versions) versions.set(version.id, scope);
      return page;
    };
    if (key === 'fetchHistoryVersion') return (id: string) => historyScope(id).fetchHistoryVersion(id);
    if (key === 'restoreHistoryVersion') return async (id: string) => {
      const scope = historyScope(id);
      if (scope === primary && !sharedPage) { undo.before(primary.vault); return primary.restoreHistoryVersion(id); }
      if (sharedPage) throw new Error('Add this note to your collection before restoring a private copy.');
      await primary.whenSynchronized();
      const version = await scope.fetchHistoryVersion(id), state = structuredClone(version.state);
      const files: File[] = [];
      for (const source of Object.values(state.sources)) {
        for (const image of Object.values(source.images)) {
          const lease = await scope.originalUrl(image);
          if (!lease) throw new Error('An image is unavailable. Retry before restoring this copy.');
          try { files.push(new File([await (await fetch(lease.url)).blob()], image.name, { type: image.type })); }
          finally { lease.release(); }
        }
        source.images = {};
      }
      undo.before(primary.vault);
      const newId = primary.vault.restoreHistoryState(state);
      for (const file of files) await primary.addImage(newId, file);
      return newId;
    };
    if (key === 'reloadAccount') return () => (allStores().find(s => s.getSnapshot().syncRejection) ?? primary).reloadAccount();
    if (key === 'exportData' || key === 'exportCurrentNotes') return async () => {
      const stores = [primary, ...[...scopes.values()].filter(s => s !== primary)];
      const documents = await Promise.all(stores.map(s => s.exportDocument(key === 'exportData')));
      primary.downloadExport({ format: 'stow-scoped-export-v1', exportedAt: new Date().toISOString(), notes: snapshot.notes, documents });
    };
    if (key === 'addImage') return (id: string, file: File) => owner(id).addImage(contentId(id), file);
    if (key === 'thumbnailUrl' || key === 'originalUrl') return (attachment: Attachment) => owner(attachment.noteId)[key](attachment);
    if (key === 'retainHistoryPreview') return (attachments: Attachment[]) => {
      const releases = [...new Set(attachments.map(a => owner(a.noteId)))].map(scope => scope.retainHistoryPreview(attachments.filter(a => owner(a.noteId) === scope)));
      return () => releases.forEach(release => release());
    };
    if (key === 'deleteNotesForever' && sharedPage) return () => { throw new Error('Only collection references can be removed.'); };
    const member = Reflect.get(target, key); return typeof member === 'function' ? member.bind(target) : member;
  } });
  primary.subscribe(refresh); refresh();
  if (primary.shared) void loadParticipants(primary.shared).catch(() => {});
  // Membership is durable metadata, not presence. Refresh on demand/visibility.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void extras.refreshParticipants().catch(() => {}); });
  return proxy as StowStore & SharingActions;
}
