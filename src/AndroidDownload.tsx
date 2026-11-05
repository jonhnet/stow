import { useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { shellConfig, stowFetch, type AndroidRelease } from './core/shell';

// Mounted only while Settings is open: discovering an optional APK must never
// delay opening the vault, and reopening Settings discovers a new publication.
export default function AndroidDownload({ onDownload, onUpdate, updateDisabled }: { onDownload(): void; onUpdate(release: AndroidRelease): void; updateDisabled: boolean }) {
  const shell = shellConfig();
  const [release, setRelease] = useState<AndroidRelease | null>();
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setRelease(undefined); setFailed(false);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    void (async () => {
      const response = await stowFetch('/api/release', { cache: 'no-store', redirect: 'error', signal });
      if (!response.ok) throw new Error(`Release check failed (${response.status})`);
      const { android } = await response.json();
      if (android !== null && (typeof android?.url !== 'string' || !/^\/native\/android\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.apk$/.test(android.url) ||
          !Number.isSafeInteger(android.version) || android.version < 1 || !Number.isSafeInteger(android.minSdk) || android.minSdk < 28 ||
          typeof android.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(android.sha256))) {
        throw new Error('Invalid Android release');
      }
      if (!signal.aborted) setRelease(android);
    })().catch(error => {
      if (!controller.signal.aborted) { setFailed(true); console.warn('Android download unavailable:', error); }
    });
    return () => controller.abort();
  }, [attempt]);
  if (!shell) return release ? <a className="menu-link" href={release.url} download onClick={onDownload}><Smartphone size={18} />Get Android app</a> : null;
  if (failed) return <button type="button" title="Could not check for an Android update. Connect and try again." onClick={() => setAttempt(value => value + 1)}><Smartphone size={18} />Check for Android updates</button>;
  const newer = release && release.version > shell.version;
  return <button type="button" disabled={!newer || updateDisabled} onClick={() => { if (newer) onUpdate(release); }}><Smartphone size={18} />{release === undefined ? 'Checking for Android updates…' : release === null ? 'No Android app release published' : newer ? 'Get updated Android app' : 'Android app is up-to-date'}</button>;
}
