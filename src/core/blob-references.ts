import * as Y from 'yjs';
import type { Attachment } from './types';

const HASH = /^[a-f0-9]{64}$/;
export const isBlobHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);

/** Import receipts identify retries; only importSources owns a saved manifest. */
export const importBlobOwner = (operationId: string) => `import:${operationId}`;

function add(references: Map<string, Set<string>>, hash: unknown, sourceId: string) {
  if (!isBlobHash(hash)) return;
  let owners = references.get(hash);
  if (!owners) { owners = new Set(); references.set(hash, owners); }
  owners.add(sourceId);
}

/** Current-note and import owners. The server tracks saved-version references separately. */
export function collectBlobReferences(doc: Y.Doc): Map<string, Set<string>> {
  const references = new Map<string, Set<string>>();
  for (const attachment of doc.getMap<Attachment>('attachments').values()) add(references, attachment.hash, attachment.noteId);
  for (const [id, note] of doc.getMap<Y.Map<unknown>>('notes')) {
    if (note instanceof Y.Map) add(references, (note.get('takeout') as { rawHash?: unknown } | undefined)?.rawHash, id);
  }
  for (const [id, source] of doc.getMap<{ manifestHash?: unknown }>('importSources')) {
    add(references, source.manifestHash, importBlobOwner(id));
  }
  return references;
}

export const collectReferencedBlobHashes = (doc: Y.Doc): Set<string> => new Set(collectBlobReferences(doc).keys());
