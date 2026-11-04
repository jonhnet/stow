import { useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';

// Mounted only while Settings is open: discovering an optional APK must never
// delay opening the vault, and reopening Settings discovers a new publication.
export default function AndroidDownload({ onDownload }: { onDownload(): void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    void (async () => {
      const response = await fetch('/native/release.json', { cache: 'no-store', redirect: 'error', signal });
      if (!response.ok) throw new Error(`Release check failed (${response.status})`);
      const { android } = await response.json();
      if (android === null) return;
      if (typeof android?.url !== 'string' || !/^\/native\/android\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.apk$/.test(android.url)) {
        throw new Error('Invalid Android download URL');
      }
      if (!signal.aborted) setUrl(android.url);
    })().catch(error => {
      if (!controller.signal.aborted) console.warn('Android download unavailable:', error);
    });
    return () => controller.abort();
  }, []);
  return url ? <a className="menu-link" href={url} download onClick={onDownload}><Smartphone size={18} />Get Android app</a> : null;
}
