/**
 * Session store — single source of truth for the descent.
 *
 * The session log is the artifact: it feeds Kimi's field journal (Day 5)
 * and the deterministic ASCII glyph (Day 4). Append-only events keep the
 * full history reproducible.
 */

import { create } from 'zustand';

export type SessionEvent =
  | { t: number; type: 'descent_started' }
  | { t: number; type: 'layer_placed'; layerId: string; freq: number; depth: number }
  | { t: number; type: 'layer_faded'; layerId: string; depth: number }
  | { t: number; type: 'agent_narrate'; text: string; mood: string; depth: number }
  | { t: number; type: 'spectral_snapshot'; bands: number[]; depth: number };

// Distributive Omit so each union member keeps its own discriminator/fields.
// Plain Omit<SessionEvent, 't'> would collapse to the intersection of keys.
export type PendingEvent = SessionEvent extends infer E
  ? E extends SessionEvent
    ? Omit<E, 't'>
    : never
  : never;

export interface PlacedLayer {
  id: string;
  freq: number;
  position: [number, number, number];
  bornAt: number;
}

export type Phase = 'intro' | 'descent' | 'arrival' | 'surface';

interface SessionState {
  phase: Phase;
  depth: number; // 0..1000
  layers: PlacedLayer[];
  log: SessionEvent[];
  proxyOk: boolean | null;
  agentLine: string | null;
  startedAt: number | null;
  begin: () => void;
  setDepth: (d: number) => void;
  setProxyOk: (ok: boolean) => void;
  addLayer: (layer: PlacedLayer) => void;
  setAgentLine: (line: string | null) => void;
  pushEvent: (e: PendingEvent) => void;
}

export const useSession = create<SessionState>((set) => ({
  phase: 'intro',
  depth: 0,
  layers: [],
  log: [],
  proxyOk: null,
  agentLine: null,
  startedAt: null,

  begin: () =>
    set(() => ({
      phase: 'descent',
      startedAt: Date.now(),
      log: [{ t: 0, type: 'descent_started' }],
    })),

  setDepth: (d) => set({ depth: d }),

  setProxyOk: (ok) => set({ proxyOk: ok }),

  addLayer: (layer) =>
    set((s) => ({
      layers: [...s.layers, layer],
      log: [
        ...s.log,
        {
          t: relTime(s.startedAt),
          type: 'layer_placed',
          layerId: layer.id,
          freq: layer.freq,
          depth: s.depth,
        },
      ],
    })),

  setAgentLine: (line) => set({ agentLine: line }),

  pushEvent: (e) =>
    set((s) => ({
      log: [...s.log, { ...e, t: relTime(s.startedAt) } as SessionEvent],
    })),
}));

function relTime(startedAt: number | null): number {
  return startedAt ? (Date.now() - startedAt) / 1000 : 0;
}
