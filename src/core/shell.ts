import { cachedAccount, rememberAccount, parseAccount, type Account } from './account';

export interface ShellConfig { api: 1; version: number; release: string; account: Account; trigger?: string; nativeEvents?: Array<{ sequence: number; at: number; message: string; trigger: string; shellVersion: number }> }
export interface AndroidRelease { version: number; minSdk: number; url: string; sha256: string }
declare global {
  interface Window {
    __STOW_SHELL__?: ShellConfig;
    StowShell?: { postMessage(message: string): void };
  }
}
export function shellConfig(): ShellConfig | undefined { return typeof window !== 'undefined' ? window.__STOW_SHELL__ : undefined; }
export function shellMessage(type: string, detail: Record<string, unknown> = {}) {
  if (!shellConfig() || !window.StowShell) throw new Error('The Android shell is unavailable.');
  window.StowShell.postMessage(JSON.stringify({ type, ...detail }));
}
export function initializeShell() {
  const shell = shellConfig(); if (!shell) return;
  if (shell.api !== 1 || !window.StowShell) throw new Error('Update the Android app to open this Stow release.');
  const account = parseAccount(shell.account);
  const previous = cachedAccount();
  if (previous && (previous.vaultId !== account.vaultId || previous.user !== account.user || previous.authMode !== account.authMode)) {
    throw new Error('This Android installation is paired with a different account. Its saved notes have been retained.');
  }
  if (!previous) rememberAccount(account);
}
/** Native endpoints have their own device authentication, outside proxy login. */
export function networkUrl(input: string | URL): string {
  const base = typeof location === 'undefined' ? 'http://localhost' : location.origin;
  const url = new URL(input, base);
  if (shellConfig() && url.origin === base && (url.pathname.startsWith('/api/') || url.pathname === '/sync')) url.pathname = '/native' + url.pathname;
  return url.href;
}
export function stowFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!shellConfig()) return fetch(input, init);
  if (input instanceof Request) return fetch(new Request(networkUrl(input.url), input), init);
  return fetch(networkUrl(input), init);
}
