#!/usr/bin/env node
// Static preview of the built demo; no Stow server or private configuration.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../build/demo');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
  try {
    const url = new URL(request.url, 'http://localhost');
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(root, '.' + relative);
    if (!file.startsWith(root + path.sep) || !types[path.extname(file)] || /(?:^|\/)\./.test(relative)) throw new Error('Not a public asset');
    const bytes = await readFile(file);
    response.setHeader('Content-Type', types[path.extname(file)]);
    response.setHeader('Cache-Control', relative.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.listen(4175, '127.0.0.1', () => { console.log('Stow demo preview: http://localhost:4175'); });
