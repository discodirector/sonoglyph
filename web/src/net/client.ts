/**
 * Thin WebSocket client. Connects to the bridge `/ws` endpoint and keeps
 * a single connection open for the lifetime of the session. No reconnect
 * logic for now — the descent is short enough that a connection drop ends
 * the session anyway.
 */

import type { ClientMessage, ServerMessage } from './protocol';

export type ServerHandler = (msg: ServerMessage) => void;

export interface BridgeConnection {
  send: (msg: ClientMessage) => void;
  close: () => void;
  isOpen: () => boolean;
}

/**
 * Open a WS to the bridge. Vite proxies /api but not /ws, so we connect
 * directly to the bridge port. Falls back to host derivation for a hosted
 * deployment.
 */
export function openBridge(handler: ServerHandler): BridgeConnection {
  const wsUrl = resolveWsUrl();
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    handler({ type: 'state', state: emptyState() }); // synthetic ping so UI knows connection live
    ws.send(JSON.stringify({ type: 'hello' } satisfies ClientMessage));
  };

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
  // Default — local dev: bridge runs on 8787, browser on 5173.
  return 'ws://localhost:8787/ws';
}

function emptyState(): import('./protocol').GameStateSnapshot {
  return {
    phase: 'lobby',
    layers: [],
    turnCount: 0,
    maxLayers: 35,
    currentTurn: null,
    cooldownEndsAt: null,
    agentBusy: false,
  };
}
