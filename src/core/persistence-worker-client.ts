import type { PersistenceWriter, PersistenceWriteResult } from './persistence-write';

export function browserPersistenceWriter(databaseName: string): PersistenceWriter {
  let worker: Worker | undefined, nextId = 0, closed = false;
  const pending = new Map<number, { resolve: (result: PersistenceWriteResult) => void; reject: (error: Error) => void; compacting: () => void }>();
  const fail = (error: Error) => {
    worker?.terminate(); worker = undefined;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const open = () => {
    if (closed) throw new Error('Local persistence is closed.');
    if (typeof Worker === 'undefined') throw new Error('Stow requires browser worker support for local storage.');
    if (!worker) {
      worker = new Worker(new URL('./persistence-worker.ts', import.meta.url), { type: 'module', name: 'stow-persistence' });
      worker.onmessage = (event: MessageEvent<{ id: number; compacting?: boolean; result?: PersistenceWriteResult; error?: { name: string; message: string } }>) => {
        const request = pending.get(event.data.id); if (!request) return;
        if (event.data.compacting) { request.compacting(); return; }
        pending.delete(event.data.id);
        if (event.data.error) { const error = new Error(event.data.error.message); error.name = event.data.error.name; request.reject(error); }
        else if (event.data.result) request.resolve(event.data.result);
        else request.reject(new Error('The storage worker returned an invalid response.'));
      };
      worker.onerror = event => { event.preventDefault(); fail(new Error('The storage worker stopped. Changes remain pending; retry saving.')); };
      worker.onmessageerror = () => fail(new Error('Could not read the storage worker response. Changes remain pending.'));
    }
    return worker;
  };
  return {
    write(db, request, compacting) {
      if (db.name !== databaseName) return Promise.reject(new Error('Persistence worker account does not match local storage.'));
      return new Promise((resolve, reject) => {
        try {
          const target = open(), id = ++nextId;
          pending.set(id, { resolve, reject, compacting });
          // Structured cloning leaves the main thread's pending buffers intact
          // until commit, including if the worker dies after receiving them.
          try { target.postMessage({ id, databaseName, request }); }
          catch (error) { pending.delete(id); throw error; }
        } catch (error) { reject(error); }
      });
    },
    close() { closed = true; fail(new Error('Local persistence is closed.')); },
  };
}
