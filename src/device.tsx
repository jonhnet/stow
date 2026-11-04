import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function Devices() {
  const id = new URLSearchParams(location.search).get('request');
  const [session, setSession] = useState<{ authenticated: boolean; user?: string; authMode: string }>();
  const [devices, setDevices] = useState<Array<{ id: string; name: string }>>([]);
  const [code, setCode] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [approved, setApproved] = useState(false);
  async function request(path: string, body?: unknown) {
    const response = await fetch(path, { method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Device request failed'); return value;
  }
  async function load() { const current = await request('/api/session'); setSession(current); if (current.authenticated && !id) setDevices((await request('/api/devices')).devices); }
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  const attempt = (operation: () => Promise<unknown>) => { setError(''); void operation().catch(e => setError(e.message)); };
  return <main className="login-wrap"><div className="login-card"><h1>{id ? 'Connect Android Stow' : 'Connected Android devices'}</h1>{error && <p role="alert">{error}</p>}
    {!session ? <p>Loading…</p> : !session.authenticated ? session.authMode === 'password' ? <form onSubmit={e => { e.preventDefault(); attempt(async () => { await request('/api/login', { password }); await load(); }); }}><label>Server password<input type="password" value={password} onChange={e => setPassword(e.target.value)} /></label><button>Sign in</button></form> : <p>Sign in through your server’s authentication page, then reload.</p> : <><p>{session.user}</p>
    {approved ? <p>Device connected. Return to the Android app.</p> : id ? <form onSubmit={e => { e.preventDefault(); attempt(async () => { await request('/api/devices/approve', { requestId: id, code: code.trim().toUpperCase() }); setApproved(true); }); }}><p>Enter the code shown in the Android app to give that device access to this account.</p><label>Pairing code<input autoComplete="off" maxLength={8} value={code} onChange={e => setCode(e.target.value)} /></label><button>Connect device</button></form> : devices.map(device => <div key={device.id}><span>{device.name}</span><button onClick={() => attempt(async () => { await request('/api/devices/revoke', { deviceId: device.id }); await load(); })}>Revoke {device.name}</button></div>)}</>}
  </div></main>;
}
createRoot(document.getElementById('root')!).render(<Devices />);
