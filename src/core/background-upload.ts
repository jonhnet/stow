import { assertAccountScope, parseAccount, type Account } from './account';
import { openBackgroundDatabase } from './background-state';
import { stowFetch } from './shell';

export const BACKGROUND_UPLOAD_INTERVAL = 5 * 60 * 1000;

/** A separate, account-bound diagnostic upload. It never gates opening notes or
 * changes their sync status. The local cursor advances only after a durable ack. */
export async function uploadBackgroundLog(account: Account, origin: string, source: 'foreground' | 'background', build: string | null) {
  assertAccountScope(account);
  await navigator.locks.request(`stow-background-log-upload:${account.vaultId}`, { ifAvailable: true }, async lock => {
    if (!lock) return;
    const db = await openBackgroundDatabase();
    try {
      const attemptKey = `uploadAttempt:${account.vaultId}`;
      const lastAttempt = Number(await db.get('metadata', attemptKey) ?? 0);
      const now = Date.now();
      if (source === 'foreground' && now >= lastAttempt && now - lastAttempt < BACKGROUND_UPLOAD_INTERVAL) return;
      const deviceId = await db.get('metadata', 'deviceId');
      if (!deviceId) return;
      await db.put('metadata', String(now), attemptKey);
      const signal = AbortSignal.timeout(10_000);
      const session = await stowFetch(new URL('/api/session', origin), { credentials: 'include', redirect: 'manual', cache: 'no-store', signal });
      if (!session.ok) throw new Error(`Background log upload could not verify the account (HTTP ${session.status}).`);
      const payload = await session.json();
      const verified = parseAccount(payload);
      assertAccountScope(verified);
      if (payload.authenticated !== true || verified.vaultId !== account.vaultId || verified.user !== account.user || verified.authMode !== account.authMode) {
        throw new Error('Background log upload account changed.');
      }
      const tx = db.transaction(['metadata', 'events'], 'readonly');
      const cursorKey = `uploaded:${account.vaultId}`;
      const [cursor, dropped, values, keys] = await Promise.all([
        tx.objectStore('metadata').get(cursorKey), tx.objectStore('metadata').get(`dropped:${account.vaultId}`),
        tx.objectStore('events').index('vaultId').getAll(account.vaultId),
        tx.objectStore('events').index('vaultId').getAllKeys(account.vaultId),
      ]);
      await tx.done;
      const through = Number(cursor ?? 0);
      const events = values.map(({ vaultId: _vaultId, ...event }, index) => ({ ...event, seq: keys[index] })).filter(event => event.seq > through);
      const sentThrough = events.at(-1)?.seq ?? through;
      const response = await stowFetch(new URL('/api/diagnostics/background', origin), {
        method: 'POST', credentials: 'include', redirect: 'manual', signal,
        headers: { 'Content-Type': 'application/json', 'X-Stow-Vault': account.vaultId },
        body: JSON.stringify({ schema: 1, deviceId, source, build, through: sentThrough, events, droppedUnacknowledged: Number(dropped ?? 0) }),
      });
      if (!response.ok) throw new Error(`Background log upload failed (HTTP ${response.status}).`);
      const ack = await response.json();
      if (ack.deviceId !== deviceId || ack.through !== sentThrough) throw new Error('Invalid background log upload acknowledgment.');
      const saved = db.transaction('metadata', 'readwrite');
      await saved.store.put(String(sentThrough), cursorKey);
      await saved.store.put(String(Date.now()), `uploadedAt:${account.vaultId}`);
      await saved.done;
    } finally { db.close(); }
  });
}
