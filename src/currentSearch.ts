import type { Note } from './core/types';
import { plainText } from './Markdown';
import { startupCount, startupMark } from './core/startup-diagnostics';

// Yield between fields, too, so one long checklist cannot monopolize a slice.
function* searchableText(note: Note): Generator<void, string> {
  const parts = [note.title, note.body, plainText(note.body), ...(note.labels ?? [])];
  yield;
  for (const item of note.items) {
    parts.push(item.text, plainText(item.text, true));
    yield;
  }
  for (const image of note.images) parts.push(image.name);
  return parts.join('\n').toLowerCase();
}

interface BuildSchedule {
  yieldTask: () => Promise<void>;
  now: () => number;
}
const browserSchedule: BuildSchedule = {
  yieldTask: () => new Promise(resolve => setTimeout(resolve, 0)),
  now: () => performance.now(),
};

/** Disposable text cache, built in roughly 4 ms tasks. Unchanged notes retain their entries. */
export class CurrentNoteSearch {
  private entries = new Map<string, { note: Note; text: string }>();
  private pending = new Map<string, Note>();
  private building?: { note: Note; steps: Generator<void, string> };
  private task?: Promise<void>;
  private stats = { slices: 0, indexed: 0, activeMs: 0, maxSliceMs: 0 };

  constructor(private readonly schedule: BuildSchedule = browserSchedule) {}

  update(notes: readonly Note[]): Promise<void> {
    const current = new Set<string>();
    for (const note of notes) {
      current.add(note.id);
      if (this.entries.get(note.id)?.note === note) this.pending.delete(note.id);
      else this.pending.set(note.id, note);
    }
    for (const id of this.entries.keys()) if (!current.has(id)) this.entries.delete(id);
    for (const id of this.pending.keys()) if (!current.has(id)) this.pending.delete(id);
    if (this.pending.size && !this.task) this.task = this.build();
    return this.task ?? Promise.resolve();
  }

  private async build() {
    let slices = 0, indexed = 0, activeMs = 0, maxSliceMs = 0;
    startupMark('search-build-start');
    try {
      // Even the first slice starts outside the render/effect that queued it.
      while (this.pending.size) {
        await this.schedule.yieldTask();
        const start = this.schedule.now();
        while (this.pending.size) {
          if (!this.building || this.pending.get(this.building.note.id) !== this.building.note) {
            const note = this.pending.values().next().value!;
            this.building = { note, steps: searchableText(note) };
          }
          const { note, steps } = this.building;
          const next = steps.next();
          if (next.done) {
            this.entries.set(note.id, { note, text: next.value });
            this.pending.delete(note.id);
            this.building = undefined;
            indexed++;
          }
          if (this.schedule.now() - start >= 4) break;
        }
        const elapsed = this.schedule.now() - start;
        activeMs += elapsed; maxSliceMs = Math.max(maxSliceMs, elapsed); slices++;
      }
    } finally {
      this.building = undefined;
      this.task = undefined;
    }
    startupMark('search-build-end');
    this.stats.indexed += indexed; this.stats.slices += slices;
    this.stats.activeMs += activeMs; this.stats.maxSliceMs = Math.max(this.stats.maxSliceMs, maxSliceMs);
    startupCount('searchIndexedNotes', this.stats.indexed);
    startupCount('searchSlices', this.stats.slices);
    startupCount('searchActiveMs', this.stats.activeMs);
    startupCount('searchMaxSliceMs', this.stats.maxSliceMs);
  }

  cancel() {
    this.pending.clear();
    this.building = undefined;
  }

  matches(id: string, query: string) { return this.entries.get(id)?.text.includes(query) ?? false; }
}
