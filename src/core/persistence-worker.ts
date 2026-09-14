import { openPersistenceDatabase, type PersistenceConnection } from './persistence-database';
import { writePersistenceBatch, type PersistenceWrite } from './persistence-write';

const scope = globalThis as unknown as { onmessage: (event: MessageEvent<{ id: number; databaseName: string; request: PersistenceWrite }>) => void; postMessage(value: unknown, transfer?: Transferable[]): void };
let connection: Promise<PersistenceConnection> | undefined, databaseName: string | undefined;
let sequence: Promise<void> = Promise.resolve();
scope.onmessage = event => {
  const { id, databaseName: name, request } = event.data;
  sequence = sequence.then(async () => {
    try {
      if (databaseName && databaseName !== name) throw new Error('Persistence worker account changed.');
      databaseName = name;
      connection ??= openPersistenceDatabase(name, () => { void connection?.then(db => db.close()); connection = undefined; }).catch(error => { connection = undefined; throw error; });
      const result = await writePersistenceBatch(await connection, request, () => scope.postMessage({ id, compacting: true }));
      scope.postMessage({ id, result }, result.correction ? [result.correction.buffer as ArrayBuffer] : []);
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      scope.postMessage({ id, error: { name: error.name, message: error.message } });
    }
  });
};
