import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

// Faults affect native requests only; the desktop continues using the real server.
export async function faultProxy(port, backendPort) {
  const fault = { session: false, sync: false, assets: false, hits: 0 };
  const connections = new Set();
  const server = http.createServer((request, response) => {
    if (fault.assets && (request.url.startsWith('/native/assets/') || request.url === '/native/index.html')) { fault.hits++; return; }
    if (fault.session && request.url === '/native/api/session') { fault.hits++; return; }
    const upstream = http.request({ host: '127.0.0.1', port: backendPort, path: request.url, method: request.method, headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); });
    response.on('close', () => upstream.destroy()); request.pipe(upstream);
  });
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  const websocket = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${backendPort}${request.url}`, { headers: request.headers });
    upstream.on('error', () => socket.destroy());
    upstream.on('open', () => websocket.handleUpgrade(request, socket, head, downstream => {
      downstream.on('message', (data, binary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary }); });
      upstream.on('message', (data, binary) => {
        // Permit the transfer header, then stop before the snapshot payload can
        // complete. This is a genuine interrupted transfer, not a mocked save.
        if (fault.sync && request.url.startsWith('/native/sync') && binary) { fault.hits++; return; }
        if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
      });
      downstream.on('error', () => upstream.terminate());
      downstream.on('close', () => upstream.terminate()); upstream.on('close', () => downstream.close());
    }));
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { fault, close() { for (const socket of connections) socket.destroy(); websocket.close(); server.close(); } };
}
