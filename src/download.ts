import { shellConfig, shellMessage } from './core/shell';

/** Android uses the system document picker; browser downloads keep their usual path. */
export function downloadText(content: string, mime: string, filename: string) {
  if (shellConfig()) {
    const bytes = new TextEncoder().encode(content);
    if (bytes.length > 64 * 1024 * 1024) throw new Error('This export is too large for the Android app. Export it from your browser.');
    shellMessage('export-start', { filename, mime, bytes: bytes.length });
    for (let offset = 0, sequence = 0; offset < bytes.length; offset += 24 * 1024, sequence++) {
      const chunk = bytes.subarray(offset, offset + 24 * 1024);
      shellMessage('export-chunk', { sequence, data: btoa(String.fromCharCode(...chunk)) });
    }
    shellMessage('export-end');
    return;
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime.startsWith('text/') ? `${mime};charset=utf-8` : mime }));
  const anchor = document.createElement('a');
  try { anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); }
  finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
