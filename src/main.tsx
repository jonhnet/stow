import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './install';
import serviceWorkerUrl from './service-worker?worker&url';
import { startStartupDiagnostics, startupMark } from './core/startup-diagnostics';
import { initializeShell, shellConfig } from './core/shell';

startStartupDiagnostics();
// Keep the one-navigation update instruction out of bookmarks and shared URLs.
if (new URL(location.href).searchParams.has('stow-update')) {
  const url = new URL(location.href); url.searchParams.delete('stow-update');
  history.replaceState(history.state, '', url);
}
// Mark intentionally non-authoritative production builds, such as device trials.
if (import.meta.env.DEV || import.meta.env.VITE_STOW_DEVELOPMENT === 'true') {
  document.documentElement.classList.add('development');
  document.title = 'Stow DEV';
  const notice = document.createElement('div');
  notice.className = 'development-notice';
  notice.setAttribute('role', 'note');
  notice.textContent = 'DEVELOPMENT · NOT AUTHORITATIVE';
  document.body.append(notice);
}
const root = createRoot(document.getElementById('root')!);
if (!window.isSecureContext) {
  root.render(<main className="login-wrap"><div className="login-card"><h1>Open Stow over HTTPS</h1><p>Use your HTTPS address to open your notes. HTTP localhost is supported for development.</p></div></main>);
} else {
  // Load the vault only after checking the browser contract. Unsupported origins
  // must not initialize storage or start a partially functioning sync client.
  startupMark('app-import-start');
  void Promise.resolve().then(() => { initializeShell(); return import('./App'); }).then(({ default: App }) => {
    startupMark('app-import-end');
    startupMark('react-render-requested');
    root.render(<React.StrictMode><App /></React.StrictMode>);
    if (import.meta.env.PROD && !shellConfig()) void navigator.serviceWorker.register(serviceWorkerUrl).catch(console.error);
  }).catch(error => {
    root.render(<main className="login-wrap"><div className="login-card" role="alert"><h1>Could not open Stow</h1><p>{error instanceof Error ? error.message : 'Reload to try again.'}</p><a href="/">Open my collection</a></div></main>);
  });
}
