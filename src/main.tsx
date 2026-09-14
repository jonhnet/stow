import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './install';
import { startStartupDiagnostics, startupMark } from './core/startup-diagnostics';

startStartupDiagnostics();
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
  void import('./App').then(({ default: App }) => {
    startupMark('app-import-end');
    startupMark('react-render-requested');
    root.render(<React.StrictMode><App /></React.StrictMode>);
    if (import.meta.env.PROD) void navigator.serviceWorker.register('/sw.js').catch(console.error);
  });
}
