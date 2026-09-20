// Development backend for `npm run dev:web`: the renderer runs in a normal browser
// (Vite on :5174) and talks to this process over a WebSocket.

import { exec } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DEV_WS_PORT } from '@shared/api';
import { decodeWire, encodeWire } from '@shared/wire';
import { createBackend, dispatch } from '../backend/api';
import { onEmit } from '../backend/events';
import { setPlatform } from '../backend/platform';

const ALLOWED_ORIGINS = new Set(['http://localhost:5174', 'http://127.0.0.1:5174']);

setPlatform({
  isElectron: false,
  appVersion: '0.1.0-dev',
  electronVersion: '',
  userDataDir: path.join(process.env.APPDATA ?? path.join(os.homedir(), '.config'), 'KS Table'),
  documentsDir: path.join(os.homedir(), 'Documents'),
  openExternal: async (url) => {
    if (/^https?:\/\//i.test(url)) exec(`start "" "${url.replace(/"/g, '')}"`);
  },
  showItemInFolder: (p) => {
    exec(`explorer /select,"${p.replace(/"/g, '')}"`);
  }
});

const backend = createBackend();
const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: DEV_WS_PORT,
  verifyClient: (info: { origin: string }) => ALLOWED_ORIGINS.has(info.origin)
});

wss.on('connection', (ws) => {
  const off = onEmit((channel, payload) => {
    ws.send(encodeWire({ t: 'event', channel, payload }));
  });
  ws.on('message', async (data) => {
    let msg: { t: string; id: number; method: string; args: unknown[] };
    try {
      msg = decodeWire(String(data)) as typeof msg;
    } catch {
      return;
    }
    if (msg.t !== 'call') return;
    const res = await dispatch(backend.api, msg.method, msg.args);
    ws.send(encodeWire({ t: 'result', id: msg.id, res }));
  });
  ws.on('close', off);
});

const shutdown = () => {
  void backend.shutdown().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`KS Table dev backend listening on ws://127.0.0.1:${DEV_WS_PORT}`);
