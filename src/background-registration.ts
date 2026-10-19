import type { Account } from './core/account';
import { BACKGROUND_INTERVAL, BACKGROUND_TAG, rememberBackgroundAccount } from './core/background-state';

interface PeriodicRegistration extends ServiceWorkerRegistration {
  periodicSync?: { getTags(): Promise<string[]>; register(tag: string, options: { minInterval: number }): Promise<void> };
}
export type BackgroundAvailability = 'enabled' | 'unavailable' | 'not-permitted' | 'error';

/** An optional browser capability, never a substitute for foreground sync. */
export async function registerBackgroundSync(account: Account): Promise<BackgroundAvailability> {
  if (!import.meta.env.PROD) return 'unavailable';
  const registration = await navigator.serviceWorker.ready as PeriodicRegistration;
  if (!registration.periodicSync) return 'unavailable';
  const permission = await navigator.permissions.query({ name: 'periodic-background-sync' as PermissionName });
  if (permission.state !== 'granted') return 'not-permitted';
  await rememberBackgroundAccount(account);
  if (!(await registration.periodicSync.getTags()).includes(BACKGROUND_TAG)) {
    await registration.periodicSync.register(BACKGROUND_TAG, { minInterval: BACKGROUND_INTERVAL });
  }
  return 'enabled';
}
