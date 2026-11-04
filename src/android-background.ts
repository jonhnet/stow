import { initializeShell, shellConfig, shellMessage } from './core/shell';
import { rememberBackgroundAccount, recordBackgroundEvent, readBackgroundResult, openBackgroundDatabase } from './core/background-state';
import { runBackgroundSync } from './core/background-sync';
import { BUILD_INFO } from './build-info';

void (async () => {
  try {
    initializeShell();
    const shell = shellConfig(); if (!shell) throw new Error('Background refresh requires the Android shell.');
    await rememberBackgroundAccount(shell.account);
    const db = await openBackgroundDatabase();
    try {
      let through = Number(await db.get('metadata', 'native:through') ?? 0);
      for (const event of shell.nativeEvents ?? []) {
        if (event.sequence <= through) continue;
        await recordBackgroundEvent(shell.account, { kind: 'native', trigger: event.trigger, shellVersion: event.shellVersion, nativeAt: event.at, message: event.message }, BUILD_INFO.commit);
        through = event.sequence;
        await db.put('metadata', String(through), 'native:through');
      }
    } finally { db.close(); }
    const completed = await runBackgroundSync(location.origin, BUILD_INFO.commit);
    const result = await readBackgroundResult(shell.account);
    shellMessage('refresh-complete', { ok: completed, completedAt: result?.completedAt ?? 0 });
  } catch (error) {
    shellMessage('refresh-complete', { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
})();
