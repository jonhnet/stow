import React from 'react';
import { createRoot } from 'react-dom/client';
import DemoNotice from './DemoNotice';
import '../styles.css';
import './demo.css';

document.documentElement.classList.add('demo');
const root = createRoot(document.getElementById('root')!);
if (!window.isSecureContext) {
  root.render(<main className="login-wrap"><div className="login-card"><h1>Open the Stow demo over HTTPS</h1><p>HTTP localhost also works for a local preview.</p></div></main>);
} else {
  // No diagnostics, account bootstrap, service worker, or offline shell.
  void import('../App').then(({ default: App }) => {
    root.render(<React.StrictMode><DemoNotice /><App /></React.StrictMode>);
  });
}
