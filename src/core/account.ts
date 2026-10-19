export type AuthMode = 'password' | 'proxy';
export interface Account {
  user: string;
  vaultId: string;
  authMode: AuthMode;
  principalId?: string;
  guest?: boolean;
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
  if (account.principalId !== undefined && (typeof account.principalId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(account.principalId))) throw new Error('Invalid shared session identity.');
  return { user: account.user, vaultId: account.vaultId, authMode: account.authMode, ...(account.principalId ? { principalId: account.principalId, guest: !!account.guest } : {}) };
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

/** A verified identity must also match the requested document scope. A proxy
 * dropping a sharing header must never open private storage as a shared vault. */
export function assertAccountScope(account: Account, sharedId?: string): void {
  if (sharedId ? account.vaultId !== sharedId || !account.principalId : !!account.principalId || account.vaultId.startsWith('share_')) {
    throw new Error('The server returned a different document scope. Reload after checking the proxy configuration.');
  }
}
