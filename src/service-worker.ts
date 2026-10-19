import { BACKGROUND_TAG } from './core/background-state';
import { runBackgroundSync } from './core/background-sync';

// Vite fills these after emitting the complete application bundle.
declare const __STOW_ASSETS__: string[];
declare const __STOW_CACHE__: string;
interface LifetimeEvent { waitUntil(promise: Promise<unknown>): void }
interface WorkerEvents {
  install: LifetimeEvent;
  activate: LifetimeEvent;
  fetch: { request: Request; respondWith(response: Promise<Response | undefined>): void };
  periodicsync: LifetimeEvent & { tag: string };
}
const scope = globalThis as unknown as {
  location: Location;
  clients: { claim(): Promise<void> };
  addEventListener<K extends keyof WorkerEvents>(type: K, handler: (event: WorkerEvents[K]) => void): void;
};
const ASSETS = __STOW_ASSETS__, CACHE = __STOW_CACHE__;
scope.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
scope.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('stow-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => scope.clients.claim())));
scope.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== scope.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sync') return;
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request).catch(() => caches.match('/index.html')));
  else if (ASSETS.includes(url.pathname)) event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
scope.addEventListener('periodicsync', event => {
  if (event.tag === BACKGROUND_TAG) event.waitUntil(runBackgroundSync(scope.location.origin));
});
