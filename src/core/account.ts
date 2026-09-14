export type AuthMode = 'password' | 'proxy';
export interface Account {
  user: string;
  vaultId: string;
  authMode: AuthMode;
}
export const ACCOUNT_KEY = 'stow-account-v1';

/** Accept only complete, server-issued account records. Missing identity never means shared storage. */
export function parseAccount(value: unknown): Account {
  if (!value || typeof value !== 'object') throw new Error('The server did not supply a valid vault identity.');
  const account = value as Partial<Account>;
  if (typeof account.user !== 'string' || !account.user.trim() ||
      typeof account.vaultId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(account.vaultId) ||
      (account.authMode !== 'proxy' && account.authMode !== 'password')) {
    throw new Error('The server did not supply a valid vault identity.');
  }
  return { user: account.user, vaultId: account.vaultId, authMode: account.authMode };
}

export function rememberAccount(account: Account): void {
  try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account)); }
  catch { throw new Error('Browser storage is unavailable. Stow cannot safely remember which offline vault belongs to you.'); }
}

export function cachedAccount(): Account | undefined {
  let value: string | null;
  try { value = localStorage.getItem(ACCOUNT_KEY); }
  catch { throw new Error('Browser storage is unavailable. Stow cannot identify your offline vault.'); }
  if (!value) return undefined;
  try { return parseAccount(JSON.parse(value)); }
  catch { throw new Error('The saved offline account is invalid. Connect to the server to identify your vault.'); }
}
