import type { Account } from './core/account';
import { shellConfig } from './core/shell';
import { BUILD_INFO } from './build-info';
import { BACKGROUND_INTERVAL, BACKGROUND_TAG, rememberBackgroundAccount, recordBackgroundEvent, type BackgroundAvailability } from './core/background-state';

interface PeriodicRegistration extends ServiceWorkerRegistration {
  periodicSync?: { getTags(): Promise<string[]>; register(tag: string, options: { minInterval: number }): Promise<void> };
}
export type { BackgroundAvailability } from './core/background-state';

/** An optional browser capability, never a substitute for foreground sync. */
export async function registerBackgroundSync(account: Account): Promise<BackgroundAvailability> {
  // Select the account even when registration is denied: a prior registration
  // may still wake, and must never target a previously signed-in account.
  await rememberBackgroundAccount(account);
  if (shellConfig()) return 'native';
  const standalone = matchMedia('(display-mode: standalone)').matches;
  await recordBackgroundEvent(account, { kind: 'registration-check', standalone }, BUILD_INFO.commit);
  const record = async (availability: BackgroundAvailability, permission?: PermissionState, message?: string) => {
    await recordBackgroundEvent(account, { kind: 'registration', availability, standalone, permission, message }, BUILD_INFO.commit);
    return availability;
  };
  try {
    if (!import.meta.env.PROD) return await record('unavailable');
    const registration = await navigator.serviceWorker.ready as PeriodicRegistration;
    if (!registration.periodicSync) return await record('unavailable');
    const permission = await navigator.permissions.query({ name: 'periodic-background-sync' as PermissionName });
    if (permission.state !== 'granted') return await record('not-permitted', permission.state);
    if (!(await registration.periodicSync.getTags()).includes(BACKGROUND_TAG)) {
      await registration.periodicSync.register(BACKGROUND_TAG, { minInterval: BACKGROUND_INTERVAL });
    }
    return await record('enabled', permission.state);
  } catch (error) {
    await record('error', undefined, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
