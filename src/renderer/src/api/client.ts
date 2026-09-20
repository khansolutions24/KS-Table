// Renderer side of the RPC bridge. In Electron the preload exposes window.ksBridge;
// in the browser (npm run dev:web) calls go over a WebSocket to src/devserver.

import type { Api, EventMap, RpcResponse } from '@shared/api';
import { DEV_WS_PORT } from '@shared/api';
import type { SqlError } from '@shared/types';
import { decodeWire, encodeWire } from '@shared/wire';

interface KsBridge {
  platform: string;
  invoke(method: string, args: unknown[]): Promise<RpcResponse>;
  onEvent(cb: (channel: string, payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    ksBridge?: KsBridge;
  }
}

export class RpcError extends Error {
  code?: string;
  errno?: number;
  sqlState?: string;
  sql?: string;

  constructor(e: SqlError & { name?: string }) {
    super(e.message);
    this.name = e.name || 'RpcError';
    this.code = e.code;
    this.errno = e.errno;
    this.sqlState = e.sqlState;
    this.sql = e.sql;
  }
}

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

function fire(channel: string, payload: unknown): void {
  listeners.get(channel)?.forEach((l) => {
    try {
      l(payload);
    } catch (e) {
      console.error(e);
    }
  });
}

export const isElectron = !!window.ksBridge;

let invokeRaw: (method: string, args: unknown[]) => Promise<RpcResponse>;

if (window.ksBridge) {
  const bridge = window.ksBridge;
  invokeRaw = (method, args) => bridge.invoke(method, args);
  bridge.onEvent(fire);
} else {
  const pending = new Map<number, (r: RpcResponse) => void>();
  let seq = 0;
  let ws: WebSocket;
  let ready: Promise<void>;
  let connectedOnce = false;
  const connect = () => {
    ws = new WebSocket(`ws://127.0.0.1:${DEV_WS_PORT}`);
    ready = new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        if (connectedOnce) fire('backend:restarted', null);
        connectedOnce = true;
        resolve();
      };
      ws.onerror = () => reject(new Error('Dev backend not reachable (npm run dev:web)'));
    });
    ready.catch(() => undefined);
    ws.onmessage = (ev) => {
      const msg = decodeWire(String(ev.data)) as
        | { t: 'result'; id: number; res: RpcResponse }
        | { t: 'event'; channel: string; payload: unknown };
      if (msg.t === 'result') {
        pending.get(msg.id)?.(msg.res);
        pending.delete(msg.id);
      } else if (msg.t === 'event') fire(msg.channel, msg.payload);
    };
    ws.onclose = () => {
      for (const p of pending.values()) p({ ok: false, error: { message: 'Connection to dev backend lost' } });
      pending.clear();
      setTimeout(connect, 1500);
    };
  };
  connect();
  invokeRaw = async (method, args) => {
    await ready;
    const id = ++seq;
    return new Promise<RpcResponse>((resolve) => {
      pending.set(id, resolve);
      ws.send(encodeWire({ t: 'call', id, method, args }));
    });
  };
}

export async function invoke(method: string, args: unknown[]): Promise<unknown> {
  const r = await invokeRaw(method, args);
  if (r.ok) return r.value;
  throw new RpcError(r.error);
}

/** Typed proxy: api.meta.tables(sessionId, schema) → invoke('meta.tables', [...]) */
export const api: Api = new Proxy({} as Api, {
  get: (_t, ns: string) =>
    new Proxy(
      {},
      {
        get:
          (_t2, fn: string) =>
          (...args: unknown[]) =>
            invoke(`${ns}.${fn}`, args)
      }
    )
});

export function onEvent<K extends keyof EventMap>(channel: K, cb: (payload: EventMap[K]) => void): () => void {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  const l = cb as Listener;
  set.add(l);
  return () => set!.delete(l);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function errorCode(e: unknown): string | undefined {
  return e instanceof RpcError ? e.code : undefined;
}
