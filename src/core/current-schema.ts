import type * as Y from 'yjs';

export const CURRENT_SCHEMA = 'stow-current-v1';

/** Saved versions are server data, never a second branch of the current vault. */
export function assertCurrentSchema(doc: Y.Doc): void {
  for (const name of ['revisions', 'revisionBuckets', 'deletedRevisionIds', 'historyCuts', 'historyEpochs', 'historyPruning']) {
    if (doc.share.get(name)?._map.size) throw new Error('This vault contains an older history format with replicated saved versions. Open a freshly imported vault with the current Stow version.');
  }
}
