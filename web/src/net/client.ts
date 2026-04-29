/**
 * Thin WebSocket client. Connects to the bridge `/ws` endpoint and keeps
 * a single connection open for the lifetime of the session.
 *
 * URL resolution:
 *   - VITE_BRIDGE_WS env (set at build time) overrides everything
 *   - In a hosted build with no override, derive from window.location:
 *     https → wss, same host, /ws path
 *   - Local dev fallback: ws://localhost:8787/ws
 */

import type { ClientMessage, ServerMessage } from './protocol';

export type ServerHandler = (msg: ServerMessage) => void;

export interface BridgeConnection {
  send: (msg: ClientMessage) => void;
  close: () => void;
  isOpen: () => boolean;
}

export function openBridge(handler: ServerHandler): BridgeConnection {
  const wsUrl = resolveWsUrl();
  const ws = new WebSocket(wsUrl);

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data) as ServerMessage;
      handler(msg);
    } catch (err) {
      console.warn('[ws] unparseable message', err);
    }
  };

  ws.onerror = (e) => {
    console.error('[ws] error', e);
  };

  ws.onclose = () => {
    console.log('[ws] closed');
  };

  return {
    send: (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      } else {
        console.warn('[ws] send dropped — socket not open');
      }
    },
    close: () => ws.close(),
    isOpen: () => ws.readyState === WebSocket.OPEN,
  };
}

function resolveWsUrl(): string {
  const explicit = (import.meta.env.VITE_BRIDGE_WS as string | undefined)?.trim();
  if (explicit) return explicit;
  if (typeof window !== 'undefined' && window.location && window.location.host) {
    const isLocalDev =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1';
    if (!isLocalDev) {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/ws`;
    }
  }
  return 'ws://localhost:8787/ws';
}
