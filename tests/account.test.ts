import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import * as Y from 'yjs';
import { ACCOUNT_KEY, cachedAccount, parseAccount, rememberAccount } from '../src/core/account';
import { LocalPersistence } from '../src/core/persistence';
import { inlinePersistenceWriter } from '../src/core/persistence-write';

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });

test('account records require an explicit stable vault identity and auth mode', () => {
  const account = { user: 'owner@example.test', vaultId: '0123456789abcdef', authMode: 'proxy' } as const;
  assert.deepEqual(parseAccount(account), account);
  for (const invalid of [null, {}, { ...account, vaultId: '' }, { ...account, vaultId: '../shared-database' }, { ...account, authMode: 'unknown' }, { ...account, user: '' }]) {
    assert.throws(() => parseAccount(invalid), /valid vault identity/);
  }
});

test('account parsing discards obsolete migration metadata without changing identity', () => {
  const account = { user: 'owner@example.test', vaultId: 'current-owner-vault-123', authMode: 'proxy' } as const;
  for (const obsolete of [
    { legacyImport: true, legacyVaultId: 'password-vault-123' },
    { legacyImport: false },
    { legacyImport: true, legacyVaultId: account.vaultId },
    { legacyImport: 'invalid', legacyVaultId: '../shared-database' },
  ]) {
    assert.deepEqual(parseAccount({ ...account, ...obsolete }), account);
    const passwordAccount = { ...account, authMode: 'password' } as const;
    assert.deepEqual(parseAccount({ ...passwordAccount, ...obsolete }), passwordAccount);
  }
});

test('offline account metadata has no shared-storage path when missing, corrupt, or unwritable', t => {
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => { Reflect.deleteProperty(globalThis, 'localStorage'); });
  assert.equal(cachedAccount(), undefined);
  const account = { user: 'owner@example.test', vaultId: '0123456789abcdef', authMode: 'proxy' } as const;
  rememberAccount(account);
  assert.deepEqual(cachedAccount(), account);
  // Existing browsers retain their identity, but old metadata cannot request an import.
  records.set(ACCOUNT_KEY, JSON.stringify({ ...account, legacyImport: true, legacyVaultId: 'password-vault-123' }));
  assert.deepEqual(cachedAccount(), account);
  rememberAccount(cachedAccount()!);
  assert.deepEqual(JSON.parse(records.get(ACCOUNT_KEY)!), account);
  records.set(ACCOUNT_KEY, '{invalid');
  assert.throws(() => cachedAccount(), /saved offline account is invalid/);
  storage.setItem = () => { throw new DOMException('Storage disabled', 'SecurityError'); };
  assert.throws(() => rememberAccount(account), /Browser storage is unavailable/);
});

test('named local stores reopen only the selected account database', async t => {
  const alice = new Y.Doc(), bob = new Y.Doc();
  const onError = (error: Error) => { throw error; };
  const aliceName = 'stow-notes-alice-vault-12345';
  const bobName = 'stow-notes-bob-vault-1234567';
  const first = new LocalPersistence(alice, { writer: inlinePersistenceWriter, databaseName: aliceName, onError });
  const second = new LocalPersistence(bob, { writer: inlinePersistenceWriter, databaseName: bobName, onError });
  await Promise.all([first.ready, second.ready]);
  alice.getText('body').insert(0, 'Alice only');
  bob.getText('body').insert(0, 'Bob only');
  await Promise.all([first.destroy(), second.destroy()]);
  const originalOpen = indexedDB.open;
  const opened: string[] = [];
  t.mock.method(indexedDB, 'open', function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
    opened.push(args[0]);
    return originalOpen.apply(this, args);
  });
  t.mock.method(indexedDB, 'databases', () => { throw new Error('Account startup must not discover other databases.'); });
  const reopened = new Y.Doc();
  const again = new LocalPersistence(reopened, { writer: inlinePersistenceWriter, databaseName: aliceName, onError });
  try {
    await again.ready;
    assert.equal(reopened.getText('body').toString(), 'Alice only');
    assert.deepEqual(opened, [aliceName]);
  } finally { await again.destroy(); alice.destroy(); bob.destroy(); reopened.destroy(); }
});
