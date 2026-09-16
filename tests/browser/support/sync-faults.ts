import { expect, type Page, type TestInfo, type WebSocketRoute } from '@playwright/test';

export type WireBoundary = 'sync' | 'upload' | 'done' | 'blackhole';
type Frame = string | Buffer;
interface Connection { socket: WebSocketRoute; server: WebSocketRoute; held: (() => void)[]; stopped: boolean; blockedUp: boolean; blockedDown: boolean; kinds: Map<number, string> }

/** Gate real frames without reordering a live WebSocket. Closing a connection
 * drops its buffered frames; the production client must retry from durable state. */
export async function syncFaults(page: Page, info: TestInfo) {
  let boundary: WireBoundary | undefined, sessionHeld = false;
  const sessions: (() => Promise<void>)[] = [], connections: Connection[] = [], events: unknown[] = [];
  await page.route('**/api/session', async route => {
    events.push({ session: sessionHeld ? 'held' : 'pass' });
    if (!sessionHeld) return route.continue();
    await new Promise<void>(resolve => sessions.push(async () => { await route.continue().catch(() => {}); resolve(); }));
  });
  await page.routeWebSocket(/\/sync\?/, socket => {
    const server = socket.connectToServer();
    const connection: Connection = { socket, server, held: [], stopped: false, blockedUp: false, blockedDown: false, kinds: new Map() };
    connections.push(connection);
    const id = connections.length;
    const frame = (value: Frame, up: boolean) => {
      const control = typeof value === 'string' ? JSON.parse(value) : undefined;
      if (up && control?.type === 'begin') connection.kinds.set(control.id, control.kind);
      const hit = boundary === 'blackhole' || (up ? boundary === 'upload' && control?.type === 'begin' && control.kind === 'update'
        : (boundary === 'sync' && control?.type === 'begin' && control.kind === 'sync') || (boundary === 'done' && control?.type === 'done' && connection.kinds.get(control.id) === 'update'));
      if (hit) { if (up) connection.blockedUp = true; else connection.blockedDown = true; }
      const held = up ? connection.blockedUp : connection.blockedDown;
      events.push({ connection: id, direction: up ? 'upload' : 'download', control: control ?? { bytes: value.length }, held });
      const send = () => { if (!connection.stopped) (up ? server : socket).send(value); };
      if (held) connection.held.push(send); else send();
    };
    socket.onMessage(value => frame(value, true)); server.onMessage(value => frame(value, false));
    socket.onClose((code, reason) => { events.push({ connection: id, close: 'client', code, reason }); connection.stopped = true; server.close({ code, reason }); });
    server.onClose((code, reason) => { events.push({ connection: id, close: 'server', code, reason }); connection.stopped = true; socket.close({ code, reason }); });
  });
  return {
    events,
    arm(value: WireBoundary | 'session') { events.push({ arm: value }); if (value === 'session') sessionHeld = true; else boundary = value; },
    async held() { await expect.poll(() => sessions.length + connections.reduce((sum, connection) => sum + connection.held.length, 0)).toBeGreaterThan(0); },
    disconnect() {
      events.push({ disconnect: true });
      for (const connection of connections) if (!connection.stopped) {
        connection.stopped = true; connection.socket.close({ code: 1012, reason: 'Scheduled interruption' }); connection.server.close();
      }
    },
    async release(deliver = true) {
      boundary = undefined; sessionHeld = false;
      for (const resume of sessions.splice(0)) await resume();
      for (const connection of connections) {
        connection.blockedUp = connection.blockedDown = false;
        const held = connection.held.splice(0); if (deliver) held.forEach(send => send());
      }
      events.push({ release: deliver });
    },
    async save() { await info.attach('sync-schedule', { body: JSON.stringify(events, null, 2), contentType: 'application/json' }); },
  };
}

export async function workerGate(page: Page) {
  await page.addInitScript(() => {
    const WorkerType = Worker;
    const held: (() => void)[] = [];
    const control = { pause: false, commits: 0, requests: 0, held: 0, release() { control.pause = false; control.held = 0; held.splice(0).forEach(send => send()); } };
    Object.assign(window, { syncWorkerGate: control });
    window.Worker = class extends WorkerType {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name !== 'stow-persistence') return;
        this.addEventListener('message', event => { if (event.data.result) control.commits++; });
        const post = this.postMessage.bind(this);
        this.postMessage = (value: unknown) => {
          control.requests++;
          if (control.pause) { control.held++; held.push(() => post(value)); } else post(value);
        };
      }
    };
  });
}

export const origin = 'http://localhost:4174';
export const card = (page: Page, title = 'Scheduled note') => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
export const connected = (page: Page) => expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
export async function createNote(page: Page, title = 'Scheduled note', text = 'Baseline 🦀') {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  const body = page.getByRole('textbox', { name: 'Note text', exact: true }); await body.focus(); await body.fill(text);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await connected(page);
}
export async function edit(page: Page, change: (text: string) => string) {
  await card(page).getByRole('heading', { name: 'Scheduled note', exact: true }).click();
  const body = page.getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus(); await body.fill(change(await body.inputValue()));
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}
