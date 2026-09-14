export const startupMarks = [
  'main-executing', 'app-import-start', 'app-import-end', 'react-render-requested', 'store-constructing',
  'spinner-dom', 'session-start', 'session-response', 'session-json', 'account-verified',
  'account-opening', 'idb-open-start', 'idb-open-end', 'idb-read-start', 'idb-read-end',
  'updates-merge-start', 'updates-merge-end', 'updates-apply-start', 'updates-apply-end',
  'idb-drain-start', 'idb-drain-end', 'idb-compact-start', 'idb-compact-end', 'local-ready',
  'broadcast-encode-start', 'broadcast-encode-end', 'broadcast-posted',
  'snapshot-start', 'snapshot-end', 'account-opened', 'notes-dom', 'notes-frame',
  'socket-start', 'socket-open', 'sync-received', 'sync-apply-start', 'sync-apply-end', 'sync-reply-sent',
  'search-build-start', 'search-build-end',
] as const;
export type StartupMark = typeof startupMarks[number];
export const startupCounters = ['updateCount', 'updateBytes', 'mergedBytes', 'broadcastBytes', 'notes', 'items', 'revisions', 'sessionStatus', 'viewportWidth', 'viewportHeight', 'pixelRatio', 'hardwareConcurrency', 'visibleAtStart', 'frameMaxMs', 'searchIndexedNotes', 'searchSlices', 'searchActiveMs', 'searchMaxSliceMs'] as const;
export type StartupCounter = typeof startupCounters[number];
export const navigationFields = ['startTime', 'duration', 'workerStart', 'redirectStart', 'redirectEnd', 'fetchStart', 'domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd', 'secureConnectionStart', 'requestStart', 'responseStart', 'responseEnd', 'domInteractive', 'domContentLoadedEventStart', 'domContentLoadedEventEnd', 'loadEventStart', 'loadEventEnd', 'transferSize', 'encodedBodySize', 'decodedBodySize'] as const;
export const resourceFields = ['startTime', 'duration', 'requestStart', 'responseStart', 'responseEnd', 'transferSize', 'encodedBodySize', 'decodedBodySize', 'serverMs'] as const;
export interface StartupReport {
  schema: 1;
  id: string;
  startedAt: number;
  reason: 'ready' | 'waiting' | 'pagehide';
  marks: { name: StartupMark; at: number }[];
  counters: Partial<Record<StartupCounter, number>>;
  navigation: Partial<Record<typeof navigationFields[number], number>>;
  resources: ({ name: string } & Partial<Record<typeof resourceFields[number], number>>)[];
  frameGaps: { start: number; duration: number }[];
}
