// Backend → renderer event bus. The transport (Electron IPC or WebSocket) subscribes via onEmit().

import type { EventMap } from '@shared/api';

type Listener = (channel: string, payload: unknown) => void;

const listeners = new Set<Listener>();

export function emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): void {
  for (const l of listeners) {
    try {
      l(channel, payload);
    } catch {
      // a broken transport must not break the backend
    }
  }
}

export function onEmit(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
