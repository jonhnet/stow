import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

type HttpTrace = Record<string, string | number | boolean | null>;
const header = (value: unknown) => typeof value === 'string' ? value.slice(0, 200) : typeof value === 'number' ? value : null;

/** Observe only three public code assets. Never capture cookies, identity, or note requests. */
export function traceDevHttp(req: IncomingMessage, res: ServerResponse, record: (trace: HttpTrace) => void) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'GET' || !(url.pathname === '/src/main.tsx' || /\/vite\/deps\/(react-dom_client|lucide-react)\.js$/.test(url.pathname))) return;
  const started = performance.now();
  const browser = req.headers['user-agent']?.match(/(?:Firefox|(?:Headless)?Chrome)\/[0-9.]+/)?.[0] ?? 'other';
  const version = url.searchParams.get('v');
  const request = {
    receivedAt: new Date().toISOString(), browser, asset: url.pathname,
    version: version && /^[a-f0-9]{1,32}$/.test(version) ? version : null,
    requestCacheControl: header(req.headers['cache-control']), pragma: header(req.headers.pragma),
    ifNoneMatch: header(req.headers['if-none-match']), ifModifiedSince: header(req.headers['if-modified-since']),
    originPresent: typeof req.headers.origin === 'string',
  };
  res.once('finish', () => record({ ...request, durationMs: Math.round((performance.now() - started) * 10) / 10,
    status: res.statusCode, contentLength: header(res.getHeader('content-length')),
    responseCacheControl: header(res.getHeader('cache-control')), etag: header(res.getHeader('etag')), vary: header(res.getHeader('vary')) }));
}

export function devHttpDiagnostics(logFile: string): Plugin {
  return {
    name: 'stow-dev-http-diagnostics', apply: 'serve',
    configureServer(server) {
      const startedAt = new Date().toISOString();
      const requests: HttpTrace[] = [];
      let timer: ReturnType<typeof setTimeout>;
      let pending = Promise.resolve();
      server.middlewares.use((req, res, next) => {
        traceDevHttp(req, res, trace => {
          requests.push(trace); if (requests.length > 200) requests.shift();
          clearTimeout(timer);
          timer = setTimeout(() => {
            const body = JSON.stringify({ startedAt, requests }, null, 2);
            pending = pending.then(async () => { await mkdir(path.dirname(logFile), { recursive: true }); await writeFile(logFile, body, { mode: 0o600 }); })
              .catch(() => { server.config.logger.warn('Could not save development HTTP timings.'); });
          }, 250);
        });
        next();
      });
      server.httpServer?.once('close', () => clearTimeout(timer));
    },
  };
}
