import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, History, LoaderCircle, RotateCcw } from 'lucide-react';
import { store, useStow } from './core/store';
import type { Label, Note } from './core/types';
import type { SavedVersion, SavedVersionSummary } from './core/server-history-types';
import { historyNotes } from './core/history-view';
import { checklistGroups } from './core/checklist';
import Markdown from './Markdown';
import NoteImage from './NoteImage';
import NoteLabels from './NoteLabels';
import LabelChip from './LabelChip';
import { COLORS } from './colors';

function VersionPreview({ note, revision, labels }: { note: Note; revision: SavedVersion; labels: readonly Label[] }) {
  const changes = revision.action?.changes ?? [];
  const changed = (field?: 'title' | 'body', itemId?: string, attachmentId?: string) => changes.some(change => {
    if (itemId) return 'itemId' in change && change.itemId === itemId;
    if (attachmentId) return change.op === 'image' && change.attachmentId === attachmentId;
    if (!('sourceId' in change)) return field === 'body';
    if (!note.sourceIds.includes(change.sourceId)) return false;
    if (change.op === 'source') return true;
    if (revision.action?.type === 'text') return revision.action.field === field && change.op === 'text';
    return change.op === 'text' && (change.field === field || (field === 'body' && change.field === 'title'));
  });
  return <div className="revision-preview" aria-label="Saved version preview">
    {revision.action && <p className="history-highlight-key">Highlighted changes</p>}
    <section>
      {(note.title || changed('title')) && <h4 className={changed('title') ? 'history-changed' : ''}>{note.title || 'Untitled note'}</h4>}
      {(note.body || changed('body')) && <div className={changed('body') ? 'history-changed' : ''}>{note.body ? <Markdown text={note.body} /> : <span className="history-empty-field">Text cleared</span>}</div>}
      {checklistGroups(note.items).flatMap(({ root, children }) => [{ item: root, child: false }, ...children.map(item => ({ item, child: true }))]).map(({ item, child }) => <div key={item.id} data-check-depth={child ? 1 : 0} className={`history-item ${child ? 'check-child' : ''} ${changed(undefined, item.id) ? 'history-changed' : ''}`}><span aria-label={item.checked ? 'Checked' : 'Unchecked'}>{item.checked ? '☑' : '☐'}</span><span className={item.checked ? 'checked-preview' : ''}><Markdown inline text={item.text} /></span></div>)}
      {note.images.length > 0 && <div className="history-images">{note.images.map(image => <div key={image.id} className={changed(undefined, undefined, image.id) ? 'history-changed' : ''}><NoteImage attachment={image} /></div>)}</div>}
      <NoteLabels labels={note.labels} catalog={labels} />
    </section>
    {revision.action?.type === 'item-delete' && <p className="history-removed">Removed item: {revision.action.itemText || 'Empty item'}</p>}
  </div>;
}

export default function NoteHistory({ note, onBack, onRestore, onError }: {
  note: Note; onBack: () => void; onRestore: (id: string) => void; onError: (message: string) => void;
}) {
  const { historyVersion, historyError, status, labels } = useStow();
  const online = status === 'online';
  const [selected, setSelected] = useState<string>();
  const [revisions, setRevisions] = useState<SavedVersionSummary[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [discardedAt, setDiscardedAt] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<{ notes?: Note[]; version?: SavedVersion; error?: string }>();
  const [retry, setRetry] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  useEffect(() => { back.current?.focus(); }, []);
  useEffect(() => {
    const request = ++generation.current;
    setRevisions([]); setCursor(undefined); setError(undefined); setDiscardedAt(undefined);
    if (!online) { setLoading(false); return; }
    setLoading(true);
    void store.fetchHistoryVersions(note.id).then(page => {
      if (request !== generation.current) return;
      setRevisions(page.versions); setCursor(page.nextCursor); setDiscardedAt(page.discardedAt); setError(page.error);
    }).catch(error => { if (request === generation.current) setError(error instanceof Error ? error.message : 'Could not load version history.'); })
      .finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [note.id, historyVersion, online, retry]);
  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    setPreview(undefined);
    if (selected && online) void store.fetchHistoryVersion(selected).then(version => {
      if (!active) return;
      const notes = historyNotes(version.state);
      release = store.retainHistoryPreview(notes.flatMap(note => note.images));
      setPreview({ notes, version });
    }).catch(error => { if (active) setPreview({ error: error instanceof Error ? error.message : 'Could not load this version.' }); });
    return () => { active = false; release?.(); };
  }, [selected, historyVersion, online]);
  const earlier = async () => {
    if (!cursor || loading) return;
    const request = generation.current;
    setLoading(true);
    try {
      const page = await store.fetchHistoryVersions(note.id, cursor);
      if (request === generation.current) {
        setRevisions(versions => [...versions, ...page.versions.filter(version => !versions.some(existing => existing.id === version.id))]);
        setCursor(page.nextCursor);
      }
    } catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : 'Could not load earlier versions.'); }
    finally { if (request === generation.current) setLoading(false); }
  };
  const restore = async (id: string) => {
    if (restoring) return;
    setRestoring(true);
    try { onRestore(await store.restoreHistoryVersion(id)); }
    catch (error) { onError(error instanceof Error ? error.message : 'Could not restore this version.'); }
    finally { setRestoring(false); }
  };
  return <>
    <div className="history-heading"><button ref={back} className="text-button" onClick={onBack}><ArrowLeft size={18} />Back to note</button><h2>Version history</h2><p>{note.title || 'Untitled note'}</p></div>
    <div className="editor-scroll note-history">
      {!online ? <p className="history-empty">Connect to view version history.</p> : <>
        {(error || historyError) && <p className="history-error" role="status">{error || historyError} <button className="text-button" onClick={() => setRetry(value => value + 1)}>Try again</button></p>}
        {discardedAt !== undefined && <p className="history-discarded">Earlier history discarded on <time dateTime={new Date(discardedAt).toISOString()}>{new Date(discardedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</time>.</p>}
        {revisions.length > 0 && <div className="revision-list">{revisions.map(revision => <article className="revision-card" key={revision.id}>
          <div className="revision-icon"><History size={18} /></div>
          <div className="revision-content"><h3>{revision.label.replace(/\\n|\r\n|\r|\n/g, ' · ')}</h3>
            <p>Saved <time dateTime={new Date(revision.recordedAt).toISOString()} title={new Date(revision.recordedAt).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' })}>{new Date(revision.recordedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}</time></p>
            {Math.abs(revision.timestamp - revision.recordedAt) >= 60000 && <p>Edit time: {new Date(revision.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}</p>}
            {revision.interval && revision.interval.actions > 1 && <p>{revision.interval.actions} changes consolidated · {new Date(revision.interval.start).toLocaleDateString()} – {new Date(revision.interval.end).toLocaleDateString()}</p>}
            {note.sourceIds.length > 1 && revision.title && <p className="history-source-title">{revision.title}</p>}
          {revision.labelChange && <div className="history-label-change" aria-label="Label change">
            <span role="img" aria-label={`Before: ${revision.labelChange.name}, ${revision.labelChange.before.deleted ? 'deleted' : COLORS.find(color => color.value === revision.labelChange!.before.color)!.label}`}>{revision.labelChange.before.deleted ? <span className="history-empty-field">Deleted</span> : <LabelChip name={revision.labelChange.name} color={revision.labelChange.before.color} />}</span>
            <ArrowRight size={15} aria-hidden="true" />
            <span role="img" aria-label={`After: ${revision.labelChange.name}, ${revision.labelChange.after.deleted ? 'deleted' : COLORS.find(color => color.value === revision.labelChange!.after.color)!.label}`}>{revision.labelChange.after.deleted ? <span className="history-empty-field">Deleted</span> : <LabelChip name={revision.labelChange.name} color={revision.labelChange.after.color} />}</span>
          </div>}
            {revision.kind !== 'label' && <div className="revision-actions"><button className="preview-button" aria-expanded={selected === revision.id} onClick={() => setSelected(selected === revision.id ? undefined : revision.id)}>{selected === revision.id ? 'Hide version' : 'Preview version'}{selected === revision.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button><button className="text-button restore-version" disabled={restoring} onClick={() => void restore(revision.id)}><RotateCcw size={15} />Restore copy</button></div>}
            {selected === revision.id && (preview?.notes && preview.version?.id === revision.id ? preview.notes.map(saved => <VersionPreview key={saved.id} note={saved} revision={preview.version!} labels={labels} />) : preview?.error ? <p className="history-error" role="status">{preview.error}</p> : <div role="status" aria-label="Loading saved version"><LoaderCircle size={20} className="spinning" /></div>)}
          </div>
        </article>)}</div>}
        {loading && <div role="status" aria-label="Loading version history"><LoaderCircle size={24} className="spinning" /></div>}
        {!loading && !error && revisions.length === 0 && <p className="history-empty">No saved changes</p>}
        {cursor && <button className="text-button older-history" disabled={loading} onClick={() => void earlier()}>Show earlier changes</button>}
      </>}
    </div>
    <div className="history-footer">Restore copy creates a new note. Version history requires a connection.</div>
  </>;
}
