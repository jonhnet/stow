import * as Y from 'yjs';
import type { Attachment, Item, Label, Note, NoteColor, NoteKind, SourceNote } from './types';
import type { EditDraft, HistoryAction, HistoryBoundary, HistoryState, LabelChange, LabelSettingState, PendingEdit } from './history-types';
export type { EditDraft } from './history-types';
import { diffHistory } from './history';
import { historyNotes } from './history-view';
import { VaultProjection } from './projection';
import { textSplice } from './text-splice';
import { checklistGroups, isChecklistGroupChecked, type ChecklistGroup } from './checklist';
import { compareAttachmentOrder } from './attachments';
import { authoredLabelNames, generationColorKey, generationMembershipKey, labelIdentityActive, type LabelLifecycle } from './labels';
import { actionText, composeTextDescriptions, describeHistoryAction, describeLabelChange, describeTextChange, quoteExcerpt, textDescription, textTarget, type TextDescription, type UndoDescription } from './history-description';
import { notePlacement, notePositionChanges, sameNoteBucket } from './note-order';
import type { MergeRecipe, SourceTextRef, TextRef } from './merged-text';
import { enforcePermanentDeletions, installPermanentDeletionGuard, PERMANENT_DELETION_ORIGIN } from './deletion';
import { redactEditDraft } from './edit-draft';
import { assertCurrentSchema } from './current-schema';

type RecordMap = Y.Map<any>;
const uid = () => globalThis.crypto.randomUUID();
const localOrigin = Symbol('local-edit');
const boundaryOrigin = Symbol('edit-boundary');
const SOURCES = 'stow-source-ids';
const DESCRIPTION = 'stow-action-description';
const CREATED = 'stow-composition-created';
const UNDO_ATTACHMENTS = 'stow-undo-attachments';
const HISTORY_IDLE_MS = 5000;
const UNDO_IDLE_MS = 500;
const UNDO_MAX_MS = 2000;
function immutable<T>(value: T): T {
  const freeze = (entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    Object.values(entry).forEach(freeze); Object.freeze(entry);
  };
  // Projections and drafts share immutable branches. Avoid copying unrelated
  // checklist items on every keypress.
  freeze(value); return value;
}
function requiredUndoDescription(item: { meta: Map<any, any> }): UndoDescription {
  const description = item.meta.get(DESCRIPTION) as UndoDescription | undefined;
  if (!description) throw new Error('An undo entry is missing its action description.');
  return description;
}

/** Change only the edited span; replacing the whole string defeats concurrent text edits. */
export function updateText(text: Y.Text, value: string) {
  const patch = textSplice(text.toString(), value);
  if (patch.remove) text.delete(patch.index, patch.remove);
  if (patch.insert) text.insert(patch.index, patch.insert);
}

type Action = Omit<HistoryAction, 'changes'>;
export class Vault {
  readonly doc: Y.Doc;
  readonly notes: Y.Map<RecordMap>;
  readonly items: Y.Map<RecordMap>;
  readonly attachments: Y.Map<Attachment>;
  readonly merges: Y.Map<{ a: string; b: string }>;
  readonly mergeRecipes: Y.Map<MergeRecipe>;
  readonly textJoins: Y.Map<Y.Text>;
  readonly labelColors: Y.Map<NoteColor>;
  readonly labelLifecycle: Y.Map<LabelLifecycle>;
  readonly labelGenerationColors: Y.Map<NoteColor>;
  readonly undoManager: Y.UndoManager;
  readonly deletedNotes: Y.Map<true>;
  private stopDeletionGuard: () => void;
  private projection: VaultProjection;
  private active?: { ids: Set<string>; timestamp: number; description?: UndoDescription; beforeText?: string; text?: boolean; boundarySources?: string[]; attachments?: Attachment[]; creation?: { kind: 'note' | 'item'; id: string } };
  private lastTextTarget?: string;
  private editDraft: EditDraft | null = null;
  private pendingListeners = new Set<() => void>();
  private boundaryListeners = new Set<(boundary: HistoryBoundary) => void>();
  private movingUndoAttachments: Attachment[] = [];
  private editTimer?: ReturnType<typeof setTimeout>;
  private composing = false;
  private finishRequested = false;
  private fineEdit?: { target: string; startedAt: number; lastAt: number; index: number; inserted: number; removed: number; direction?: 'backward' | 'forward' };
  private labelCatalogVersion = 0;
  private labelCatalog?: { version: number; labels: Label[] };
  private onLabelCatalogChange = () => { this.labelCatalogVersion++; };
  private onNoteLabels = (events: Y.YEvent<any>[]) => {
    // Ordinary text and checklist edits do not change the label catalog.
    if (events.some(event => event.target === this.notes || (event instanceof Y.YMapEvent &&
      [...event.keysChanged].some(key => key === 'labels' || key.startsWith('label:') || key.startsWith('label-generation:'))))) {
      this.onLabelCatalogChange();
    }
  };

  constructor(doc = new Y.Doc()) {
    assertCurrentSchema(doc);
    this.doc = doc;
    this.deletedNotes = doc.getMap<true>('deletedNotes');
    enforcePermanentDeletions(doc);
    this.notes = doc.getMap('notes'); this.items = doc.getMap('items'); this.attachments = doc.getMap('attachments');
    this.merges = doc.getMap('merges'); this.mergeRecipes = doc.getMap('mergeRecipes'); this.textJoins = doc.getMap('textJoins');
    this.labelColors = doc.getMap('labelColors');
    this.labelLifecycle = doc.getMap('labelLifecycle');
    this.labelGenerationColors = doc.getMap('labelGenerationColors');
    this.labelColors.observe(this.onLabelCatalogChange);
    this.labelLifecycle.observe(this.onLabelCatalogChange);
    this.labelGenerationColors.observe(this.onLabelCatalogChange);
    this.notes.observeDeep(this.onNoteLabels);
    this.deletedNotes.observe(this.onLabelCatalogChange);
    this.merges.observe(this.onLabelCatalogChange);
    this.projection = new VaultProjection(this.notes, this.items, this.attachments, this.merges, this.labelLifecycle, this.mergeRecipes, this.textJoins);
    this.undoManager = new Y.UndoManager([this.notes, this.items, this.attachments, this.merges, this.mergeRecipes, this.textJoins, this.labelColors, this.labelLifecycle, this.labelGenerationColors], { trackedOrigins: new Set([localOrigin]), captureTimeout: UNDO_IDLE_MS });
    const rememberSources = ({ stackItem }: { stackItem: { meta: Map<any, any> } }) => {
      if (!this.active) return;
      stackItem.meta.set(SOURCES, new Set([...(stackItem.meta.get(SOURCES) ?? []), ...this.active.ids]));
      if (this.active.attachments?.length) {
        const retained = new Map<string, Attachment>(stackItem.meta.get(UNDO_ATTACHMENTS));
        for (const image of this.active.attachments) retained.set(`${image.noteId}/${image.hash}`, image);
        stackItem.meta.set(UNDO_ATTACHMENTS, retained);
      }
      if (this.active.creation && !stackItem.meta.has(CREATED)) stackItem.meta.set(CREATED, this.active.creation);
      const creation = stackItem.meta.get(CREATED) as { kind: 'note' | 'item'; id: string } | undefined;
      const current = this.active.description;
      if (current) {
        const previous = stackItem.meta.get(DESCRIPTION) as UndoDescription | undefined;
        if (creation) {
          const description = creation.kind === 'note' ? `Note: created ${quoteExcerpt(this.getNote(creation.id)?.title || 'Untitled note')}` :
            `Item: added ${quoteExcerpt(this.items.get(creation.id)?.get('text')?.toString() || 'Empty item')}`;
          stackItem.meta.set(DESCRIPTION, { description } satisfies UndoDescription);
        } else if (previous?.text && current.text && previous.text.target === current.text.target) {
          const text = composeTextDescriptions(previous.text, current.text, this.active.beforeText!);
          stackItem.meta.set(DESCRIPTION, { description: describeTextChange(text.scope, text.removed, text.inserted), text } satisfies UndoDescription);
        } else stackItem.meta.set(DESCRIPTION, current);
      }
    };
    this.undoManager.on('stack-item-added', rememberSources); this.undoManager.on('stack-item-updated', rememberSources);
    this.doc.on('afterTransaction', transaction => {
      if (transaction.changed.size && transaction.origin !== localOrigin && transaction.origin !== boundaryOrigin && transaction.origin !== this.undoManager) {
        const draft = this.editDraft;
        // A peer changing the same note closes this local typing group. The
        // server captures its observed state; this hint never claims isolation.
        if (draft && (draft.sourceIds.some(id => this.deletedNotes.has(id)) ||
          diffHistory(draft.after, this.projection.state(draft.sourceIds)).length)) {
          this.setDraft(redactEditDraft(draft, this.deletedNotes));
          this.finishEdit(true);
        }
        this.breakUndo();
      }
    });
    this.stopDeletionGuard = installPermanentDeletionGuard(doc, () => this.discardDeletedUndo());
  }

  get notesVersion() { return this.projection.version; }
  getEditDraft(): EditDraft | null { return this.editDraft; }
  private editedSources(draft: EditDraft): Set<string> {
    return new Set(diffHistory(draft.before, draft.after).flatMap(patch => {
      if ('sourceId' in patch) return [patch.sourceId];
      if ('joinId' in patch) { const owner = this.doc.getMap<string>('textJoinSources').get(patch.joinId); return owner ? [owner] : []; }
      return [];
    }).filter(id => !this.deletedNotes.has(id)));
  }
  getPendingEdit(): PendingEdit | null {
    const draft = this.editDraft;
    if (!draft) return null;
    const modifiedAt = Object.fromEntries([...this.editedSources(draft)].map(id => [id, draft.lastInputAt]));
    return Object.keys(modifiedAt).length ? { modifiedAt } : null;
  }
  onPendingEditChange(listener: () => void): () => void { this.pendingListeners.add(listener); return () => this.pendingListeners.delete(listener); }
  onHistoryBoundary(listener: (boundary: HistoryBoundary) => void): () => void { this.boundaryListeners.add(listener); return () => this.boundaryListeners.delete(listener); }
  private emitBoundary(boundary: HistoryBoundary) {
    const sourceIds = [...new Set(boundary.sourceIds)].filter(id => !this.deletedNotes.has(id));
    if (sourceIds.length) for (const listener of this.boundaryListeners) listener({ ...boundary, sourceIds });
  }
  private setDraft(draft: EditDraft | null) {
    this.editDraft = draft;
    this.pendingListeners.forEach(listener => listener());
  }
  private scheduleEdit() {
    clearTimeout(this.editTimer);
    if (!this.editDraft) return;
    this.editTimer = setTimeout(() => this.finishEdit(), HISTORY_IDLE_MS);
    // Browser timers are numbers; Node fixtures should not stay alive for a draft.
    if (typeof this.editTimer === 'object') this.editTimer.unref();
  }
  private stopUndoCapture() { this.undoManager.stopCapturing(); this.lastTextTarget = undefined; this.fineEdit = undefined; }
  breakUndo() {
    if (this.composing) return;
    this.stopUndoCapture();
  }
  beginComposition() {
    if (this.composing) return;
    this.stopUndoCapture(); this.composing = true;
    this.undoManager.captureTimeout = Infinity;
  }
  endComposition() {
    if (!this.composing) return;
    this.composing = false; this.undoManager.captureTimeout = UNDO_IDLE_MS;
    this.stopUndoCapture();
    if (this.finishRequested) this.finishEdit(); else this.scheduleEdit();
  }
  /** Completing an edit retains all existing fine Undo steps. */
  finishEdit(force = false) {
    if (this.composing && !force) { this.finishRequested = true; return; }
    clearTimeout(this.editTimer); this.editTimer = undefined; this.finishRequested = false;
    const draft = this.editDraft;
    if (draft) {
      const edited = this.editedSources(draft);
      this.doc.transact(() => {
        for (const id of edited) {
          const note = this.notes.get(id);
          if (note && draft.lastInputAt > (Number(note.get('updatedAt')) || 0)) note.set('updatedAt', draft.lastInputAt);
        }
        this.setDraft(null);
      }, boundaryOrigin);
      if (edited.size) this.emitBoundary({ sourceIds: draft.sourceIds, editedAt: draft.lastInputAt, action: draft.action,
        description: describeHistoryAction(draft.before, draft.after, draft.action, 'Edited note') });
    }
    this.stopUndoCapture();
  }
  /** Recover only a crashed writer's modification times. Text lives in the update log. */
  recoverPendingEdit(pending: PendingEdit) {
    if (!pending?.modifiedAt || typeof pending.modifiedAt !== 'object' ||
      Object.values(pending.modifiedAt).some(timestamp => !Number.isFinite(timestamp))) throw new Error('Invalid pending edit timestamp record.');
    this.doc.transact(() => {
      for (const [id, timestamp] of Object.entries(pending.modifiedAt)) {
        const note = this.notes.get(id);
        if (note && !this.deletedNotes.has(id) && timestamp > (Number(note.get('updatedAt')) || 0)) note.set('updatedAt', timestamp);
      }
    }, boundaryOrigin);
  }
  private prepareFineUndo(text: TextDescription, timestamp: number, before: string, after: string) {
    const previous = this.fineEdit;
    const inserted = text.inserted.length, removed = text.removed.length;
    // A common-prefix diff can place an insertion after identical existing
    // characters. Keep the actual continuous caret position when equivalent.
    if (previous?.target === text.target && inserted && !removed) {
      const expected = previous.index + previous.inserted;
      if (before.slice(0, expected) + text.inserted + before.slice(expected) === after) text = { ...text, index: expected };
    }
    const kind = inserted && removed ? 'replace' : inserted ? 'insert' : 'delete';
    const previousKind = previous && (previous.inserted && previous.removed ? 'replace' : previous.inserted ? 'insert' : 'delete');
    const direction = kind === 'delete' && previousKind === 'delete' && previous ?
      text.index + removed === previous.index ? 'backward' : text.index === previous.index ? 'forward' : undefined : undefined;
    const separated = !previous || previous.target !== text.target || timestamp - previous.lastAt >= UNDO_IDLE_MS || timestamp - previous.startedAt >= UNDO_MAX_MS ||
      kind !== previousKind || (kind === 'insert' && text.index !== previous.index + previous.inserted) ||
      (kind === 'delete' && (!direction || (previous.direction && direction !== previous.direction)));
    if (!this.composing && separated) this.undoManager.stopCapturing();
    this.fineEdit = { target: text.target, startedAt: previous && (!separated || this.composing) ? previous.startedAt : timestamp,
      lastAt: timestamp, index: text.index, inserted, removed, ...(direction ? { direction } : {}) };
  }
  private change(ids: Iterable<string>, action: Action, label: string, fn: () => void, separate = true) {
    if (this.active) { for (const id of ids) this.active.ids.add(id); fn(); return; }
    const typing = action.type === 'text' && !separate;
    const composingCreation = this.composing && (action.type === 'create' || action.type === 'item-add');
    if ((!typing && (!composingCreation || this.editDraft)) || (this.editDraft && textTarget(this.editDraft.action) !== textTarget(action))) this.finishEdit(true);
    const touched = new Set(ids), before = this.projection.state(touched), timestamp = Date.now();
    for (const id of Object.keys(before.sources)) touched.add(id);
    this.active = { ids: touched, timestamp, text: typing,
      ...(composingCreation ? { creation: { kind: action.type === 'create' ? 'note' : 'item', id: (action.type === 'create' ? action.noteId : action.itemId)! } } : {}) };
    const target = textTarget(action);
    if (!(this.composing && (typing || composingCreation)) && (separate || target !== this.lastTextTarget)) this.undoManager.stopCapturing();
    this.lastTextTarget = separate ? undefined : target;
    let boundary: HistoryBoundary | undefined;
    try {
      this.doc.transact(() => {
        fn();
        const after = this.projection.state(touched);
        this.active!.attachments = this.changedAttachments(before, after);
        const text = textDescription(before, after, action);
        this.active!.description ??= { description: describeHistoryAction(before, after, action, label), ...(text ? { text } : {}),
          ...(action.type === 'reorder' && action.field === 'sortOrderDate' ? { movedNoteId: action.noteId } : {}) };
        if (text) this.active!.beforeText = actionText(before, action);
        if (typing && text) {
          this.prepareFineUndo(text, timestamp, this.active!.beforeText!, actionText(after, action));
          const previous = this.editDraft;
          this.setDraft(immutable({ sourceIds: [...touched], action,
            before: previous?.before ?? before, after, firstInputAt: previous?.firstInputAt ?? timestamp, lastInputAt: timestamp }));
          this.scheduleEdit();
        } else if (diffHistory(before, after).length || this.active!.boundarySources) {
          boundary = { sourceIds: this.active!.boundarySources ?? [...touched], editedAt: timestamp, action,
            description: this.active!.description.description,
            ...(this.active!.description.labelSetting ? { labelSetting: this.active!.description.labelSetting } : {}) };
        }
        this.removedImageCandidates(before, after);
      }, localOrigin);
    } finally { this.active = undefined; if (separate && !composingCreation) this.undoManager.stopCapturing(); }
    if (boundary) this.emitBoundary(boundary);
  }
  private removedImageCandidates(before: HistoryState, after: HistoryState) {
    const candidates = this.doc.getMap<true>('deletedBlobCandidates');
    for (const [id, source] of Object.entries(before.sources)) for (const [imageId, image] of Object.entries(source.images)) {
      if (after.sources[id]?.images[imageId]?.hash !== image.hash && !candidates.has(image.hash)) candidates.set(image.hash, true);
    }
  }
  /** Only attachment changes can make Undo restore bytes absent from current notes. */
  private changedAttachments(before: HistoryState, after: HistoryState): Attachment[] {
    const retained: Attachment[] = [];
    for (const sourceId of new Set([...Object.keys(before.sources), ...Object.keys(after.sources)])) {
      const old = before.sources[sourceId]?.images ?? {}, current = after.sources[sourceId]?.images ?? {};
      for (const id of new Set([...Object.keys(old), ...Object.keys(current)])) if (old[id]?.hash !== current[id]?.hash) {
        if (old[id]) retained.push(old[id]);
        if (current[id]) retained.push(current[id]);
      }
    }
    return retained;
  }
  /** Local stack metadata protects pending uploads and cached images independently of history. */
  getUndoAttachments(): Attachment[] {
    const retained = new Map<string, Attachment>();
    // Stack events fire during replacement and before the opposite entry's
    // metadata is transferred. Keep those bytes eligible throughout the action.
    for (const image of [...this.movingUndoAttachments, ...(this.active?.attachments ?? [])]) {
      if (!this.deletedNotes.has(image.noteId)) retained.set(`${image.noteId}/${image.hash}`, image);
    }
    for (const entry of [...this.undoManager.undoStack, ...this.undoManager.redoStack]) {
      for (const [key, image] of entry.meta.get(UNDO_ATTACHMENTS) as Map<string, Attachment> ?? []) {
        if (!this.deletedNotes.has(image.noteId)) retained.set(key, image);
      }
    }
    return [...retained.values()];
  }
  private touch(id: string) {
    if (!this.active?.text) this.notes.get(id)?.set('updatedAt', this.active?.timestamp ?? Date.now());
    this.projection.sourceChanged(id);
  }

  createNote(kind: NoteKind = 'text', initial: { title?: string; body?: string } = {}): string {
    const id = uid(), createdAt = this.active?.timestamp ?? Date.now();
    this.change([id], { type: 'create', noteId: id }, 'Created note', () => {
      const note = new Y.Map(); this.notes.set(id, note);
      note.set('title', new Y.Text(initial.title ?? '')); note.set('body', new Y.Text(initial.body ?? ''));
      note.set('kind', kind); note.set('color', 'default'); note.set('placement', { pinned: false, sortOrderDate: createdAt }); note.set('archived', false); note.set('trashed', false);
      note.set('createdAt', createdAt); note.set('updatedAt', this.active!.timestamp);
      this.projection.sourceChanged(id, true);
    });
    return id;
  }

  setNoteText(id: string, field: 'title' | 'body', value: string) {
    const note = this.getNote(id); if (!note || note[field] === value) return;
    const prepared = this.prepareLegacyText(note.id);
    this.change(note.sourceIds, { type: 'text', noteId: note.id, field }, field === 'title' ? 'Edited title' : 'Edited note text', () => {
      if (prepared) this.saveRecipe(prepared);
      const text = this.projection.text(note.id);
      this.replaceTextRuns(field === 'title' ? [text.titleRef] : text.bodyRefs, value);
    }, false);
  }

  private textField(ref: TextRef): Y.Text {
    const text = ref.field === 'join' ? this.textJoins.get(ref.joinId) : this.notes.get(ref.sourceId)?.get(ref.field);
    if (!(text instanceof Y.Text)) throw new Error('This note composition refers to a missing editable text field.');
    return text;
  }
  private createJoins(values: { sourceId: string; text: string }[]): TextRef[] {
    if (this.active) throw new Error('Joining text must be allocated before its authored note change.');
    const refs = values.map(value => ({ sourceId: value.sourceId, field: 'join' as const, joinId: uid() }));
    // A later remote recipe may reuse these runs after the creating merge is
    // undone. Allocation is retained; every subsequent edit is ordinary undoable text.
    this.doc.transact(() => refs.forEach((ref, index) => {
      this.textJoins.set(ref.joinId, new Y.Text(values[index].text));
      this.doc.getMap<string>('textJoinSources').set(ref.joinId, ref.sourceId);
    }), 'join-allocation');
    return refs;
  }
  private joinedBody(texts: { titleRef: SourceTextRef; bodyRefs: TextRef[] }[]): TextRef[] {
    const titles = texts.slice(1).map(text => text.titleRef);
    const values = [...titles.map((ref, index) => ({ sourceId: ref.sourceId, text: index === titles.length - 1 ? '\n\n' : '\n' })),
      ...texts.slice(0, -1).map(text => ({ sourceId: text.bodyRefs.at(-1)!.sourceId, text: '\n\n' }))];
    const joins = this.createJoins(values);
    return [...titles.flatMap((ref, index) => [ref, joins[index]]), ...texts.flatMap((text, index) =>
      [...text.bodyRefs, ...(index < texts.length - 1 ? [joins[titles.length + index]] : [])])];
  }
  private saveRecipe(recipe: MergeRecipe) {
    this.mergeRecipes.set(recipe.id, recipe); this.projection.compositionChanged(recipe.sourceIds);
  }
  /** Keep every original field, including empty fields, as an editable CRDT run. */
  private replaceTextRuns(refs: TextRef[], value: string) {
    if (!refs.length) throw new Error('This note composition has no editable text runs.');
    const runs = refs.map(ref => ({ ref, text: this.textField(ref), value: this.textField(ref).toString(), start: 0 }));
    let length = 0;
    for (const run of runs) { run.start = length; length += run.value.length; }
    const patch = textSplice(runs.map(run => run.value).join(''), value);
    const insertion = runs.find(run => patch.index <= run.start + run.value.length) ?? runs[runs.length - 1];
    for (const run of runs) {
      const start = Math.max(patch.index, run.start), end = Math.min(patch.index + patch.remove, run.start + run.value.length);
      if (end > start) { run.text.delete(start - run.start, end - start); this.touch(run.ref.sourceId); }
    }
    if (patch.insert) { insertion.text.insert(patch.index - insertion.start, patch.insert); this.touch(insertion.ref.sourceId); }
  }
  private prepareLegacyText(id: string): MergeRecipe | undefined {
    const text = this.projection.text(id); if (!text.needsMaterialization) return;
    const sourceIds = this.projection.sourceIds(id), members = new Set(sourceIds);
    const edgeIds = [...this.merges].filter(([, edge]) => members.has(edge.a) && members.has(edge.b)).map(([edgeId]) => edgeId);
    const texts = text.sourceOrder.map(sourceId => ({ titleRef: { sourceId, field: 'title' as const }, bodyRefs: [{ sourceId, field: 'body' as const }] }));
    return { id: uid(), sourceIds: text.sourceOrder, edgeIds, title: text.titleRef, body: this.joinedBody(texts), order: 0 };
  }

  setNoteMeta(id: string, patch: Partial<{ kind: NoteKind; color: NoteColor; pinned: boolean; archived: boolean; trashed: boolean }>) {
    const current = this.getNote(id); if (!current) return;
    const changed = current.sourceIds.filter(sourceId => Object.entries(patch).some(([key, value]) => {
      const source = this.notes.get(sourceId)!;
      return (key === 'pinned' ? notePlacement(source).pinned : source.get(key)) !== value;
    }));
    if (!changed.length) return;
    const pinChanged = patch.pinned !== undefined && current.sourceIds.some(sourceId => notePlacement(this.notes.get(sourceId)!).pinned !== patch.pinned);
    const positions = pinChanged ? notePositionChanges([current, ...this.getNotes().filter(note => note.id !== current.id && sameNoteBucket(note, { ...current, ...patch }))], 0, Date.now()) : new Map<string, number>();
    const label = 'trashed' in patch ? patch.trashed ? 'Moved note to trash' : 'Restored note from trash' : 'archived' in patch ? patch.archived ? 'Archived note' : 'Unarchived note' : 'pinned' in patch ? patch.pinned ? 'Pinned note' : 'Unpinned note' : 'kind' in patch ? 'Changed note format' : 'Changed note color';
    const keys = Object.keys(patch);
    this.change([...current.sourceIds, ...positions.keys()], { type: 'metadata', noteId: current.id, ...(keys.length === 1 ? { field: keys[0] as HistoryAction['field'] } : {}) }, label, () => {
      this.applyNotePositions(positions);
      for (const sourceId of changed) {
        const source = this.notes.get(sourceId)!;
        Object.entries(patch).forEach(([key, value]) => {
          if (key === 'pinned') {
            source.set('placement', { pinned: value, sortOrderDate: positions.get(current.id) ?? current.sortOrderDate });
            this.projection.sourceChanged(sourceId, false, true);
          } else source.set(key, value);
        });
        this.touch(sourceId);
      }
    });
  }

  private applyNotePositions(positions: Map<string, number>) {
    for (const [id, sortOrderDate] of positions) {
      const source = this.notes.get(id)!;
      source.set('placement', { ...notePlacement(source), sortOrderDate });
      this.projection.sourceChanged(id, false, true);
    }
  }

  /** Targets are resolved in the full bucket, so filtered views share one order. */
  moveNoteRelative(id: string, targetId: string, side: 'before' | 'after'): boolean {
    const current = this.getNote(id), target = this.getNote(targetId);
    if (!current || !target || current.id === target.id || !sameNoteBucket(current, target)) return false;
    const bucket = this.getNotes().filter(note => sameNoteBucket(note, current));
    const desired = bucket.filter(note => note.id !== current.id);
    const index = desired.findIndex(note => note.id === target.id) + (side === 'after' ? 1 : 0);
    desired.splice(index, 0, current);
    if (desired.every((note, i) => note.id === bucket[i].id)) return false;
    const positions = notePositionChanges(desired, index, Date.now());
    this.change([...current.sourceIds, ...positions.keys()], { type: 'reorder', noteId: current.id, field: 'sortOrderDate' }, 'Moved note', () => this.applyNotePositions(positions));
    return true;
  }

  setNoteLabel(id: string, name: string, present: boolean) {
    if (!name) throw new Error('A label name is required.');
    const current = this.getNote(id); if (!current) return;
    const lifecycle = this.labelLifecycle.get(name);
    const changed = current.sourceIds.map(sourceId => this.projection.source(sourceId)!).filter(source => (source.labels?.includes(name) ?? false) !== present);
    if (!changed.length) return;
    this.change(current.sourceIds, { type: 'metadata', noteId: id, field: 'labels' }, `${present ? 'Added' : 'Removed'} label “${name}”`, () => {
      if (lifecycle?.deleted && present) {
        // Devices recreating the same observed deletion share its fresh identity.
        this.labelLifecycle.set(name, { ...lifecycle, deleted: false });
        this.projection.labelsChanged([name]);
      }
      for (const section of changed) {
        this.notes.get(section.id)!.set(lifecycle ? generationMembershipKey(name, lifecycle.generation) : `label:${name}`, present);
        this.touch(section.id);
      }
    });
  }

  setLabelColor(name: string, color: NoteColor) {
    if (!name) throw new Error('A label name is required.');
    const lifecycle = this.labelLifecycle.get(name);
    if (lifecycle?.deleted) return;
    const colors = lifecycle ? this.labelGenerationColors : this.labelColors;
    const key = lifecycle ? generationColorKey(name, lifecycle.generation) : name;
    if (colors.has(key) && colors.get(key) === color) return;
    this.changeLabelSetting(name, 'color', () => colors.set(key, color));
  }

  deleteLabel(name: string) {
    if (!name) throw new Error('A label name is required.');
    if (!this.getLabels().some(label => label.name === name)) return;
    // Assignments and color remain intact for undo. The new identity keeps old
    // offline writes from appearing if this spelling is explicitly recreated.
    this.changeLabelSetting(name, 'delete', () => {
      this.labelLifecycle.set(name, { generation: uid(), deleted: true });
      this.projection.labelsChanged([name]);
    });
  }

  private labelSetting(name: string): LabelSettingState {
    const lifecycle = this.labelLifecycle.get(name);
    return { color: (lifecycle ? this.labelGenerationColors.get(generationColorKey(name, lifecycle.generation)) : this.labelColors.get(name)) ?? 'default',
      deleted: lifecycle?.deleted ?? false, ...(lifecycle ? { generation: lifecycle.generation } : {}) };
  }
  private labelSources(name: string): string[] {
    return this.getNotes().flatMap(note => note.sourceIds.filter(id => this.projection.source(id)!.labels?.includes(name)));
  }
  private changeLabelSetting(name: string, type: LabelChange['type'], fn: () => void) {
    const before = this.labelSetting(name), sources = this.labelSources(name);
    this.change([], { type: 'metadata' }, '', () => {
      fn();
      const labelChange: LabelChange = { name, type, before, after: this.labelSetting(name) };
      const description = describeLabelChange(labelChange);
      this.active!.description = { description, labelSetting: { name, type } };
      this.active!.boundarySources = [...new Set([...sources, ...this.labelSources(name)])];
    });
  }

  getLabels(): Label[] {
    if (this.labelCatalog?.version === this.labelCatalogVersion) return this.labelCatalog.labels;
    // An explicit detach still keeps the label available in navigation. Its
    // persisted override supplies membership without an unrelated color write.
    const editedNames = [...this.notes.values()].flatMap(note => authoredLabelNames(note, this.labelLifecycle));
    const originalColorNames = [...this.labelColors.keys()].filter(name => labelIdentityActive(this.labelLifecycle, name));
    const recreatedNames = [...this.labelLifecycle].filter(([, state]) => !state.deleted).map(([name]) => name);
    const names = new Set([...this.getNotes().flatMap(note => note.labels ?? []), ...editedNames, ...originalColorNames, ...recreatedNames]);
    const entries = [...names].sort().map(name => {
      const lifecycle = this.labelLifecycle.get(name);
      return { name, color: (lifecycle ? this.labelGenerationColors.get(generationColorKey(name, lifecycle.generation)) : this.labelColors.get(name)) ?? 'default' };
    });
    const previous = this.labelCatalog?.labels;
    const labels = previous && previous.length === entries.length && entries.every((entry, index) =>
      entry.name === previous[index].name && entry.color === previous[index].color) ? previous : entries;
    this.labelCatalog = { version: this.labelCatalogVersion, labels };
    return labels;
  }

  private insertItem(id: string, noteId: string, text: string, rank: number, parentId?: string) {
    const item = new Y.Map(); this.items.set(id, item);
    item.set('noteId', noteId); item.set('text', new Y.Text(text)); item.set('checked', false); item.set('deleted', false);
    item.set('parentId', parentId ?? null); item.set('rank', rank);
    this.notes.get(noteId)!.set('kind', 'checklist'); this.projection.itemChanged(id); this.touch(noteId);
  }
  /** Materialize only as part of an explicit edit, never while opening a vault. */
  private prepareChecklist(noteId: string) {
    const sources = this.projection.sourceIds(noteId);
    if (sources.length < 2 || sources.every(id => this.notes.get(id)!.get('unifiedChecklist') === true)) return;
    const items = this.getItems(noteId);
    for (const item of items) this.positionItem(item.id, item.parentId, item.rank);
    this.markChecklistUnified(sources);
  }
  private markChecklistUnified(sources: readonly string[]) {
    for (const id of sources) {
      const note = this.notes.get(id)!;
      if (note.get('unifiedChecklist') === true) continue;
      note.set('unifiedChecklist', true); this.touch(id);
    }
  }
  /** Called inside the merge transaction, while notes still reflect selection order. */
  private orderMergedChecklist(notes: readonly Note[]) {
    const groups = notes.flatMap(note => checklistGroups(note.items));
    for (const [index, group] of groups.entries()) {
      this.positionItem(group.root.id, group.root.parentId, (index + 1) * 1024);
      // Preserve each visible family's child order, including a legacy projection.
      for (const child of group.children) this.positionItem(child.id, child.parentId, child.rank);
    }
    this.markChecklistUnified(notes.flatMap(note => note.sourceIds));
  }
  /** Parent and sibling rank are always authored together, including re-spacing. */
  private positionItem(id: string, parentId: string | undefined, rank: number) {
    const item = this.items.get(id)!;
    if ((item.get('parentId') ?? undefined) === parentId && item.get('rank') === rank) return;
    item.set('parentId', parentId ?? null); item.set('rank', rank); this.projection.itemChanged(id);
    this.touch(item.get('noteId'));
  }
  /** A visibly single child move must not carry siblings hidden behind a raw chain. */
  private detachChildDependents(id: string, group: ChecklistGroup<Item>) {
    if (group.root.id === id) return;
    for (const item of [group.root, ...group.children]) if (item.id !== id && item.parentId === id) {
      this.positionItem(item.id, item.id === group.root.id ? undefined : group.root.id, item.rank);
    }
  }
  private placeItem(id: string, parentId: string | undefined, siblings: Item[], index: number) {
    const before = siblings[index - 1], after = siblings[index];
    const rank = before && after ? before.rank / 2 + after.rank / 2 : before ? before.rank + 1024 : after ? after.rank - 1024 : 1024;
    if (Number.isFinite(rank) && (!before || rank > before.rank) && (!after || rank < after.rank)) {
      this.positionItem(id, parentId, rank); return false;
    }
    const order = siblings.map(item => item.id); order.splice(index, 0, id);
    order.forEach((itemId, position) => this.positionItem(itemId, parentId, (position + 1) * 1024));
    return true;
  }
  addItem(noteId: string, text = '', parentId?: string): string {
    const id = uid(); if (!this.notes.has(noteId)) return id;
    const groups = checklistGroups(this.getItems(noteId)), parent = parentId ? groups.find(group => group.root.id === parentId) : undefined;
    if (parentId && !parent) return id;
    const siblings = parent ? parent.children : groups.map(group => group.root);
    this.change([noteId], { type: 'item-add', noteId, itemId: id, itemText: text }, text ? `Added “${text}”` : 'Added checklist item', () => {
      this.prepareChecklist(noteId);
      this.insertItem(id, noteId, text, 0, parentId); this.placeItem(id, parentId, siblings, siblings.length);
    });
    return id;
  }
  setItemText(id: string, value: string) {
    const item = this.items.get(id); if (!item || item.get('text').toString() === value) return;
    const noteId = item.get('noteId');
    this.change([noteId], { type: 'text', noteId, itemId: id, field: 'text' }, 'Edited checklist text', () => { updateText(item.get('text'), value); this.projection.itemChanged(id); this.touch(noteId); }, false);
  }
  addItemAfter(noteId: string, afterItemId: string, text = ''): string {
    const id = uid(); if (!this.notes.has(noteId)) return id;
    const groups = checklistGroups(this.getItems(noteId));
    const group = groups.find(group => group.root.id === afterItemId || group.children.some(item => item.id === afterItemId));
    const firstChild = group?.root.id === afterItemId && group.children.length > 0;
    const parentId = group && (group.root.id !== afterItemId || firstChild) ? group.root.id : undefined;
    const siblings = parentId ? group!.children : groups.map(group => group.root);
    const index = siblings.findIndex(item => item.id === afterItemId);
    const insertAt = firstChild ? 0 : index < 0 ? siblings.length : index + 1;
    this.change([noteId], { type: 'item-add', noteId, itemId: id, itemText: text }, text ? `Added “${text}”` : 'Added checklist item', () => {
      this.prepareChecklist(noteId);
      this.insertItem(id, noteId, text, 0, parentId); this.placeItem(id, parentId, siblings, insertAt);
    });
    return id;
  }
  toggleItem(id: string) {
    const item = this.items.get(id); if (!item || item.get('deleted')) return;
    const noteId = item.get('noteId'), itemText = item.get('text').toString();
    const group = checklistGroups(this.getItems(noteId)).find(group => group.root.id === id);
    const checked = !item.get('checked');
    const selected = group ? [group.root.id, ...group.children.map(child => child.id)] : [id];
    this.change([noteId], { type: 'check', noteId, itemId: id, itemText, checked, field: 'checked' }, `${checked ? 'Checked' : 'Unchecked'} “${itemText || 'List item'}”`, () => {
      const owners = new Set<string>();
      for (const itemId of selected) {
        const selectedItem = this.items.get(itemId)!;
        if (!!selectedItem.get('checked') === checked) continue;
        selectedItem.set('checked', checked); this.projection.itemChanged(itemId); owners.add(selectedItem.get('noteId'));
      }
      for (const owner of owners) this.touch(owner);
    });
  }
  deleteItem(id: string) {
    const item = this.items.get(id); if (!item || item.get('deleted')) return;
    const noteId = item.get('noteId'), itemText = item.get('text').toString();
    const groups = checklistGroups(this.getItems(noteId)), membership = groups.find(group => group.root.id === id || group.children.some(child => child.id === id));
    const group = membership?.root.id === id ? membership : undefined;
    this.change([noteId], { type: 'item-delete', noteId, itemId: id, itemText }, `Removed “${itemText || 'List item'}”`, () => {
      this.prepareChecklist(noteId);
      if (membership) this.detachChildDependents(id, membership);
      item.set('deleted', true); this.projection.itemChanged(id);
      if (group?.children.length) {
        // Promote observed children in place; concurrent children remain visible
        // through missing-parent projection instead of losing their text.
        let roots = groups.filter(entry => entry !== group).map(entry => entry.root), index = groups.indexOf(group);
        for (const child of group.children) {
          const respaced = this.placeItem(child.id, undefined, roots, index);
          if (respaced) roots = roots.map(root => ({ ...root, rank: this.items.get(root.id)!.get('rank') }));
          roots.splice(index++, 0, { ...child, parentId: undefined, rank: this.items.get(child.id)!.get('rank') });
        }
      }
      this.touch(noteId);
    });
  }

  moveItem(id: string, direction: -1 | 1) {
    const item = this.items.get(id); if (!item) return;
    const groups = checklistGroups(this.getItems(item.get('noteId')));
    const group = groups.find(group => group.root.id === id || group.children.some(child => child.id === id));
    if (!group) return;
    const parentId = group.root.id === id ? undefined : group.root.id;
    const siblings = parentId ? group.children : groups.filter(entry => isChecklistGroupChecked(entry) === isChecklistGroupChecked(group)).map(entry => entry.root);
    const index = siblings.findIndex(entry => entry.id === id), other = siblings[index + direction];
    if (index < 0 || !other) return;
    this.moveItemRelative(id, other.id, direction === -1 ? 'before' : 'after', parentId ?? null);
  }
  /**
   * Undefined parent infers the target's visible sibling group; null means root.
   * A root move targeting a child anchors against that child's whole group.
   * An explicit parent with target==parent and 'after' inserts the first child.
   */
  moveItemRelative(itemId: string, targetId: string, placement: 'before' | 'after', requestedParent?: string | null): boolean {
    if (itemId === targetId) return false;
    const item = this.items.get(itemId), target = this.items.get(targetId);
    if (!item || !target || !this.projection.sourceIds(item.get('noteId')).includes(target.get('noteId'))) return false;
    const noteId = item.get('noteId');
    const groups = checklistGroups(this.getItems(noteId));
    const sourceGroup = groups.find(group => group.root.id === itemId || group.children.some(child => child.id === itemId));
    const targetGroup = groups.find(group => group.root.id === targetId || group.children.some(child => child.id === targetId));
    if (!sourceGroup || !targetGroup || isChecklistGroupChecked(sourceGroup) !== isChecklistGroupChecked(targetGroup)) return false;
    const parentId = requestedParent === undefined ? targetGroup.root.id === targetId ? undefined : targetGroup.root.id : requestedParent ?? undefined;
    if (parentId === itemId || (parentId && sourceGroup.root.id === itemId && sourceGroup.children.length)) return false;
    const parentGroup = parentId ? groups.find(group => group.root.id === parentId) : undefined;
    if (parentId && !parentGroup) return false;
    const anchorId = parentId ? targetId : targetGroup.root.id;
    if (parentId && !(targetId === parentId && placement === 'after') && !parentGroup!.children.some(child => child.id === targetId)) return false;
    const siblings = parentGroup ? parentGroup.children : groups.filter(group => isChecklistGroupChecked(group) === isChecklistGroupChecked(sourceGroup)).map(group => group.root);
    const remaining = siblings.filter(entry => entry.id !== itemId);
    const index = parentId && targetId === parentId ? 0 : remaining.findIndex(entry => entry.id === anchorId) + (placement === 'after' ? 1 : 0);
    if (index < 0 || (!parentId && anchorId === itemId)) return false;
    if (siblings.findIndex(entry => entry.id === itemId) === index && (item.get('parentId') ?? undefined) === parentId) return false;
    this.change([noteId], { type: 'reorder', noteId, itemId, field: 'rank', itemText: item.get('text').toString() }, 'Reordered checklist item', () => {
      this.prepareChecklist(noteId);
      if (parentId !== sourceGroup.root.id) this.detachChildDependents(itemId, sourceGroup);
      this.placeItem(itemId, parentId, remaining, index);
    });
    return true;
  }

  /** Set a visible root parent, or outdent immediately after the former group. */
  setItemParent(itemId: string, requestedParent?: string | null): boolean {
    const item = this.items.get(itemId); if (!item || item.get('deleted')) return false;
    const noteId = item.get('noteId'), parentId = requestedParent ?? undefined;
    const groups = checklistGroups(this.getItems(noteId));
    const source = groups.find(group => group.root.id === itemId || group.children.some(child => child.id === itemId));
    if (!source || parentId === itemId) return false;
    const currentParent = source.root.id === itemId ? undefined : source.root.id;
    if (currentParent === parentId && (item.get('parentId') ?? undefined) === parentId) return false;
    const parent = parentId ? groups.find(group => group.root.id === parentId) : undefined;
    if (parentId && (!parent || (source.root.id === itemId && source.children.length))) return false;
    const siblings = (parent ? parent.children : groups.map(group => group.root)).filter(entry => entry.id !== itemId);
    const index = parent ? siblings.length : currentParent ? siblings.findIndex(entry => entry.id === currentParent) + 1 : Math.max(0, groups.findIndex(group => group.root.id === itemId));
    this.change([noteId], { type: 'reorder', noteId, itemId, field: 'parentId', itemText: item.get('text').toString() }, parent ? 'Indented checklist item' : 'Outdented checklist item', () => {
      this.prepareChecklist(noteId);
      if (parentId !== source.root.id) this.detachChildDependents(itemId, source);
      this.placeItem(itemId, parentId, siblings, index);
    });
    return true;
  }

  indentItem(itemId: string): boolean {
    const item = this.items.get(itemId); if (!item || item.get('deleted')) return false;
    const groups = checklistGroups(this.getItems(item.get('noteId'))), group = groups.find(group => group.root.id === itemId);
    if (!group || group.children.length) return false;
    const visible = groups.filter(entry => isChecklistGroupChecked(entry) === isChecklistGroupChecked(group));
    const index = visible.indexOf(group);
    return index > 0 ? this.setItemParent(itemId, visible[index - 1].root.id) : false;
  }

  outdentItem(itemId: string): boolean {
    const item = this.items.get(itemId); if (!item || item.get('deleted')) return false;
    const group = checklistGroups(this.getItems(item.get('noteId'))).find(group => group.children.some(child => child.id === itemId));
    return group ? this.setItemParent(itemId, undefined) : false;
  }

  addAttachment(attachment: Attachment) {
    if (!this.notes.has(attachment.noteId)) return;
    const images = this.projection.source(attachment.noteId)!.images;
    const order = attachment.order ?? (images.reduce((last, image) => Math.max(last, image.order ?? -1), -1) + 1);
    if (!Number.isSafeInteger(order) || order < 0) throw new Error('Attachment order must be a nonnegative safe integer.');
    this.change([attachment.noteId], { type: 'image-add', noteId: attachment.noteId, attachmentId: attachment.id }, `Added image “${attachment.name}”`, () => { this.attachments.set(attachment.id, { ...attachment, order }); this.projection.imageChanged(attachment.id); this.touch(attachment.noteId); });
  }
  removeAttachment(id: string) {
    const attachment = this.attachments.get(id); if (!attachment) return;
    this.change([attachment.noteId], { type: 'image-remove', noteId: attachment.noteId, attachmentId: id }, `Removed image “${attachment.name}”`, () => { this.attachments.delete(id); this.projection.imageChanged(id); this.touch(attachment.noteId); });
  }

  getItems(noteId: string): Item[] { return this.projection.getItems(noteId); }
  getNotes(): Note[] { return this.projection.getNotes(); }
  getNote(id: string): Note | undefined { return this.projection.getNote(id); }
  getSource(id: string): SourceNote | undefined { return this.projection.source(id); }
  getSourceOrder(id: string): string[] { return this.projection.text(id).sourceOrder; }

  /** Delete only the sources explicitly displayed by the confirmation dialog.
   * A later merge or restore must never broaden that destructive selection. */
  deleteNotesForever(sourceIds: readonly string[]): boolean {
    this.finishEdit(true);
    const selected = new Set(sourceIds), present = [...selected].filter(id => !this.deletedNotes.has(id));
    if (!present.length) return false;
    for (const id of present) {
      const note = this.getNote(id);
      if (!note || !note.trashed || note.sourceIds.some(sourceId => !selected.has(sourceId))) {
        throw new Error('The selected notes have changed. Review the trash and try again.');
      }
    }
    this.undoManager.stopCapturing(); this.lastTextTarget = undefined;
    this.doc.transact(() => {
      for (const id of present) this.deletedNotes.set(id, true);
      this.discardDeletedUndo();
      enforcePermanentDeletions(this.doc);
    }, PERMANENT_DELETION_ORIGIN);
    return true;
  }

  private discardDeletedUndo() {
    this.discardSourceUndo(this.deletedNotes);
    if (this.editDraft) { this.setDraft(redactEditDraft(this.editDraft, this.deletedNotes)); this.scheduleEdit(); }
  }
  private discardSourceUndo(sources: { has(id: string): boolean }) {
    const manager = this.undoManager;
    const affected = (item: typeof manager.undoStack[number]) => [...(item.meta.get(SOURCES) as Set<string> ?? [])].some(id => sources.has(id));
    const keepUndo = manager.undoStack.filter(item => !affected(item)), keepRedo = manager.redoStack.filter(item => !affected(item));
    if (keepUndo.length === manager.undoStack.length && keepRedo.length === manager.redoStack.length) return;
    // Let Yjs release its retained deleted structs for the discarded entries.
    // Keep unrelated entries and their normal deep undo/redo behavior intact.
    manager.undoStack = manager.undoStack.filter(affected); manager.redoStack = manager.redoStack.filter(affected);
    manager.clear();
    manager.undoStack = keepUndo; manager.redoStack = keepRedo;
    Y.tryGc(Y.createDeleteSetFromStructStore(this.doc.store), this.doc.store, this.doc.gcFilter);
  }

  mergeNotes(ids: string[]): string {
    const notes = [...new Map(ids.map(id => this.getNote(id)).filter((note): note is Note => !!note).map(note => [note.id, note])).values()];
    if (notes.length < 2) return notes[0]?.id ?? '';
    const sources = notes.flatMap(note => note.sourceIds);
    const prepared = notes.map(note => this.prepareLegacyText(note.id));
    const texts = notes.map((note, index) => {
      const existing = this.projection.text(note.id), recipe = prepared[index];
      return recipe ? { titleRef: recipe.title, bodyRefs: recipe.body, sourceOrder: recipe.sourceIds } : existing;
    });
    const order = Math.max(0, ...notes.flatMap(note => Object.values(this.projection.activeRecipes(note.sourceIds)).map(recipe => recipe.order))) + 1;
    // Own the complete observed union, including sources already connected by
    // older merges. Undoing an older merge must not dismantle this later intent.
    const edgeIds = sources.slice(1).map(() => uid());
    const recipe: MergeRecipe = { id: uid(), sourceIds: texts.flatMap(text => text.sourceOrder), edgeIds,
      title: texts[0].titleRef, body: this.joinedBody(texts), order };
    this.change(sources, { type: 'merge', noteId: notes[0].id }, 'Merged notes', () => {
      for (const previous of prepared) if (previous) this.saveRecipe(previous);
      this.orderMergedChecklist(notes);
      sources.slice(1).forEach((sourceId, index) => this.merges.set(edgeIds[index], { a: sources[0], b: sourceId }));
      this.saveRecipe(recipe);
      sources.forEach(id => this.touch(id)); this.projection.membershipChanged();
      const first = notes[0], representativeId = this.getNote(first.id)!.id;
      // Own the first selection's metadata even when unchanged: undoing an
      // earlier merge must not replace a later remote merge's chosen appearance.
      // Copy placement directly so merging does not perform a pin-to-top action.
      const representative = this.notes.get(representativeId)!;
      representative.set('color', first.color);
      representative.set('placement', { pinned: first.pinned, sortOrderDate: first.sortOrderDate });
      this.projection.sourceChanged(representativeId, false, true);
    });
    return this.getNote(notes[0].id)!.id;
  }
  captureHistoryState(sourceIds: Iterable<string>): HistoryState { return structuredClone(this.projection.state(sourceIds)); }

  restoreHistoryState(state: HistoryState): string {
    const copies = historyNotes(state);
    if (!copies.length) return '';
    let first = '', ordinal = 0;
    this.change([], { type: 'restore' }, 'Restored a historical copy', () => {
      for (const sourceNote of copies) {
        const newId = this.createNote(sourceNote.kind, { title: sourceNote.title, body: sourceNote.body });
        first ||= newId;
        const note = this.notes.get(newId)!;
        note.set('createdAt', this.active!.timestamp + ordinal++); note.set('color', sourceNote.color);
        const labels = (sourceNote.labels ?? []).filter(name => sourceNote.sourceIds.some(sourceId => {
          const source = state.sources[sourceId];
          return source?.labels?.includes(name) && labelIdentityActive(this.labelLifecycle, name, source.labelGenerations?.[name]);
        }));
        const originalLabels = labels.filter(name => !this.labelLifecycle.has(name));
        if (originalLabels.length) note.set('labels', originalLabels);
        for (const name of labels) {
          const generation = this.labelLifecycle.get(name)?.generation;
          if (generation) note.set(generationMembershipKey(name, generation), true);
        }
        // One map for the entire historical component retains cross-source parents.
        const oldItemIds = sourceNote.items.map(item => item.id).sort(), freshItemIds = oldItemIds.map(() => uid()).sort();
        const itemIds = new Map(oldItemIds.map((itemId, index) => [itemId, freshItemIds[index]]));
        for (const item of sourceNote.items) {
          const itemId = itemIds.get(item.id)!, parentId = item.parentId ? itemIds.get(item.parentId) : undefined;
          this.insertItem(itemId, newId, item.text, item.rank, parentId); this.items.get(itemId)!.set('checked', item.checked); this.projection.itemChanged(itemId);
        }
        note.set('kind', sourceNote.kind);
        sourceNote.images.forEach((image, order) => this.addAttachment({ ...image, id: uid(), noteId: newId, order }));
        this.projection.sourceChanged(newId, true);
      }
      this.projection.membershipChanged();
    });
    return this.getNote(first)?.id ?? '';
  }

  private undoOrRedo(kind: 'undo' | 'redo'): string | undefined {
    this.finishEdit(true);
    const stack = kind === 'undo' ? this.undoManager.undoStack : this.undoManager.redoStack;
    if (!stack.length) return;
    this.undoManager.stopCapturing(); this.lastTextTarget = undefined;
    // UndoManager can skip entries made obsolete by remote edits. Capture indexed
    // source views for its candidates, then retain only the components it changed.
    const candidates = new Set<string>(stack.flatMap(item => [...(item.meta.get(SOURCES) as Set<string> ?? [])]));
    const beforeAll = this.projection.state(candidates), timestamp = Date.now();
    const settings = new Map<string, { state: LabelSettingState; sources: string[] }>();
    for (const item of stack) {
      const name = requiredUndoDescription(item).labelSetting?.name;
      if (name !== undefined && !settings.has(name)) settings.set(name, { state: this.labelSetting(name), sources: this.labelSources(name) });
    }
    // Yjs owns this transaction and its stack bookkeeping. Notify history only
    // after the current change and its modification times have been committed.
    this.movingUndoAttachments = this.getUndoAttachments();
    let popped: ReturnType<Y.UndoManager['undo']>;
    try {
      popped = this.undoManager[kind]();
      const retained = popped?.meta.get(UNDO_ATTACHMENTS) as Map<string, Attachment> | undefined;
      if (retained) (kind === 'undo' ? this.undoManager.redoStack : this.undoManager.undoStack).at(-1)?.meta.set(UNDO_ATTACHMENTS, retained);
    } finally { this.movingUndoAttachments = []; }
    if (!popped) return;
    const opposite = kind === 'undo' ? this.undoManager.redoStack : this.undoManager.undoStack;
    const original = requiredUndoDescription(popped);
    const description = original.description;
    opposite.at(-1)?.meta.set(DESCRIPTION, original);
    if (original.labelSetting) {
      const { name, type } = original.labelSetting, before = settings.get(name)!;
      opposite.at(-1)?.meta.set(SOURCES, new Set<string>());
      this.emitBoundary({ sourceIds: [...before.sources, ...this.labelSources(name)], editedAt: timestamp, action: { type: kind },
        description: `${kind === 'undo' ? 'Undid' : 'Redid'}: ${description}`, labelSetting: { name, type } });
      return description;
    }
    const afterAll = this.projection.state(candidates);
    const allEffects = diffHistory(beforeAll, afterAll);
    const changed = new Set(allEffects.flatMap(patch => 'sourceId' in patch ? [patch.sourceId] : []));
    for (const patch of allEffects) if (patch.op === 'recipe') {
      for (const sourceId of beforeAll.recipes?.[patch.recipeId]?.sourceIds ?? []) changed.add(sourceId);
      for (const sourceId of afterAll.recipes?.[patch.recipeId]?.sourceIds ?? []) changed.add(sourceId);
    }
    const changedJoins = new Set(allEffects.flatMap(patch => 'joinId' in patch ? [patch.joinId] : []));
    if (changedJoins.size) for (const recipe of [...Object.values(beforeAll.recipes ?? {}), ...Object.values(afterAll.recipes ?? {})]) {
      if ([recipe.title, ...recipe.body].some(ref => ref.field === 'join' && changedJoins.has(ref.joinId))) {
        for (const sourceId of recipe.sourceIds) changed.add(sourceId);
      }
    }
    if (original.movedNoteId) changed.add(original.movedNoteId);
    const beforeMembership = new Map(beforeAll.groups.flatMap(group => group.map(id => [id, group.join('|')] as const)));
    const afterMembership = new Map(afterAll.groups.flatMap(group => group.map(id => [id, group.join('|')] as const)));
    for (const sourceId of candidates) if (beforeMembership.get(sourceId) !== afterMembership.get(sourceId)) changed.add(sourceId);
    const narrow = (state: HistoryState): HistoryState => {
      const groups = state.groups.filter(group => group.some(sourceId => changed.has(sourceId))), selected = new Set(groups.flat());
      const recipes = Object.fromEntries(Object.entries(state.recipes ?? {}).filter(([, recipe]) => recipe.sourceIds.some(sourceId => selected.has(sourceId))));
      const joinIds = new Set(Object.values(recipes).flatMap(recipe => [recipe.title, ...recipe.body].flatMap(ref => ref.field === 'join' ? [ref.joinId] : [])));
      const joins = Object.fromEntries(Object.entries(state.joins ?? {}).filter(([joinId]) => joinIds.has(joinId)));
      return { groups, sources: Object.fromEntries(Object.entries(state.sources).filter(([sourceId]) => selected.has(sourceId))),
        ...(Object.keys(recipes).length ? { recipes } : {}), ...(Object.keys(joins).length ? { joins } : {}) };
    };
    const before = narrow(beforeAll), after = narrow(afterAll), effects = diffHistory(before, after);
    const modified = new Set(effects.flatMap(patch => 'sourceId' in patch &&
      !(patch.op === 'set' && (patch.field === 'sortOrderDate' || patch.field === 'updatedAt')) ? [patch.sourceId] : []));
    if (effects.some(patch => patch.op === 'groups' || patch.op === 'recipe' || patch.op === 'join' || patch.op === 'join-text')) {
      for (const sourceId of Object.keys(after.sources)) modified.add(sourceId);
    }
    // Undo/Redo is a new completed edit. Its timestamp stays outside the Undo
    // stack, and pure tile moves stay neutral.
    for (const group of after.groups) if (group.some(sourceId => modified.has(sourceId))) for (const sourceId of group) {
      after.sources[sourceId] = { ...after.sources[sourceId], updatedAt: Math.max(after.sources[sourceId].updatedAt, timestamp) };
    }
    const action: Action = { type: kind };
    const checks = effects.filter(patch => patch.op === 'item-set' && patch.field === 'checked'), check = checks[0];
    if (check?.op === 'item-set') {
      action.noteId = check.sourceId; action.itemId = check.itemId; action.field = 'checked'; action.checked = !!check.value;
      action.itemText = after.sources[check.sourceId]?.items[check.itemId]?.text ?? before.sources[check.sourceId]?.items[check.itemId]?.text ?? '';
    }
    // Carry affected IDs onto the opposite stack so a later redo/undo uses the
    // same stable source identities, including sources removed by creation undo.
    opposite.at(-1)?.meta.set(SOURCES, new Set([...Object.keys(before.sources), ...Object.keys(after.sources)]));
    this.doc.transact(() => {
      for (const id of modified) {
        const note = this.notes.get(id);
        if (note && timestamp > (Number(note.get('updatedAt')) || 0)) note.set('updatedAt', timestamp);
      }
      this.removedImageCandidates(before, after);
    }, boundaryOrigin);
    this.emitBoundary({ sourceIds: [...Object.keys(before.sources), ...Object.keys(after.sources)], editedAt: timestamp, action,
      description: `${kind === 'undo' ? 'Undid' : 'Redid'}: ${description}` });
    return description;
  }
  undo() { return this.undoOrRedo('undo'); }
  redo() { return this.undoOrRedo('redo'); }
  destroy() {
    clearTimeout(this.editTimer); this.pendingListeners.clear(); this.boundaryListeners.clear();
    this.stopDeletionGuard();
    this.labelColors.unobserve(this.onLabelCatalogChange); this.labelLifecycle.unobserve(this.onLabelCatalogChange); this.labelGenerationColors.unobserve(this.onLabelCatalogChange);
    this.notes.unobserveDeep(this.onNoteLabels); this.deletedNotes.unobserve(this.onLabelCatalogChange); this.merges.unobserve(this.onLabelCatalogChange);
    this.projection.destroy(); this.undoManager.destroy(); this.doc.destroy();
  }
}
