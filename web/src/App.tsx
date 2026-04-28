import { useEffect, useRef } from 'react';
import { Scene } from './scene/Scene';
import { Hud } from './ui/Hud';
import { LAYER_TYPES, useSession } from './state/useSession';
import {
  addLayer,
  captureSpectrum,
  initAudio,
  pickFreqForType,
  setGlobalDepth,
  startRecording,
} from './audio/engine';
import { openBridge, type BridgeConnection } from './net/client';

/**
 * Sonoglyph root.
 *
 * Day 4 architecture:
 *   - Bridge (Node + WS) is the authority for layers, turns, cooldowns.
 *   - Browser opens WS on Begin, sends place_layer, receives layer_added
 *     for both its own placements and the agent's, plays each via the
 *     audio engine.
 *   - Stub agent in bridge auto-places after a short think delay during
 *     the cooldown window. Day 5 swaps stub for Hermes via MCP.
 */
export function App() {
  const phase = useSession((s) => s.phase);
  const depth = useSession((s) => s.depth);
  const beginLocal = useSession((s) => s.beginLocal);
  const setProxyOk = useSession((s) => s.setProxyOk);
  const setRecording = useSession((s) => s.setRecording);
  const setSelectedPreset = useSession((s) => s.setSelectedPreset);
  const pushEvent = useSession((s) => s.pushEvent);
  const applySnapshot = useSession((s) => s.applySnapshot);
  const applyLayerAdded = useSession((s) => s.applyLayerAdded);
  const applyTurnChanged = useSession((s) => s.applyTurnChanged);
  const applyAgentThinking = useSession((s) => s.applyAgentThinking);
  const applyFinished = useSession((s) => s.applyFinished);

  const bridgeRef = useRef<BridgeConnection | null>(null);
  const layerHandlesRef = useRef<Map<string, () => void>>(new Map());

  // Health check (proxy reachability indicator).
  useEffect(() => {
    fetch('/health')
      .then((r) => r.json())
      .then((d) => setProxyOk(Boolean(d?.ok)))
      .catch(() => setProxyOk(false));
  }, [setProxyOk]);

  // Mirror depth into audio engine (drives reverb wetness).
  useEffect(() => {
    setGlobalDepth(depth);
  }, [depth]);

  // Keyboard 1-5 selects preset (only when it's player's turn).
  useEffect(() => {
    if (phase !== 'playing') return;
    const onKey = (e: KeyboardEvent) => {
      const idx = parseInt(e.key, 10) - 1;
      if (idx >= 0 && idx < LAYER_TYPES.length) {
        setSelectedPreset(LAYER_TYPES[idx]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, setSelectedPreset]);

  // Spectral snapshots every 5s — feeds Kimi journal + glyph generation.
  useEffect(() => {
    if (phase !== 'playing') return;
    const interval = window.setInterval(() => {
      const bands = captureSpectrum();
      pushEvent({
        type: 'spectral_snapshot',
        bands,
        depth: useSession.getState().depth,
      });
    }, 5000);
    return () => window.clearInterval(interval);
  }, [phase, pushEvent]);

  // ---------------------------------------------------------------------------
  // Bridge connection — WS messages dispatched into the store + audio engine.
  // ---------------------------------------------------------------------------
  const openBridgeConnection = () => {
    if (bridgeRef.current && bridgeRef.current.isOpen()) return;

    const conn = openBridge((msg) => {
      switch (msg.type) {
        case 'state':
          applySnapshot(msg.state);
          // Replay any layers that already exist (handles reconnects).
          for (const layer of msg.state.layers) {
            if (!layerHandlesRef.current.has(layer.id)) {
              const handle = addLayer(
                layer.type,
                layer.position,
                layer.freq,
                layer.id,
              );
              layerHandlesRef.current.set(layer.id, handle.dispose);
            }
          }
          return;
        case 'layer_added': {
          applyLayerAdded(msg.layer);
          // Spawn audio for this layer (skip if already known — defensive
          // against stray duplicates).
          if (!layerHandlesRef.current.has(msg.layer.id)) {
            const handle = addLayer(
              msg.layer.type,
              msg.layer.position,
              msg.layer.freq,
              msg.layer.id,
            );
            layerHandlesRef.current.set(msg.layer.id, handle.dispose);
          }
          return;
        }
        case 'turn_changed':
          applyTurnChanged(msg.currentTurn, msg.cooldownEndsAt, msg.turnCount);
          return;
        case 'agent_thinking':
          applyAgentThinking();
          return;
        case 'finished':
          applyFinished();
          return;
        case 'error':
          console.warn('[bridge]', msg.message);
          return;
      }
    });

    bridgeRef.current = conn;
  };

  // ---------------------------------------------------------------------------
  // Player turn handler — only valid when game state allows it. Server
  // validates again, this is just to avoid useless WS chatter.
  // ---------------------------------------------------------------------------
  const handlePlace = (point: [number, number, number]) => {
    const s = useSession.getState();
    if (s.phase !== 'playing') return;
    if (s.currentTurn !== 'player') return;
    if (s.cooldownEndsAt && Date.now() < s.cooldownEndsAt) return;
    if (s.layers.length >= s.maxLayers) return;

    const type = s.selectedPreset;
    const freq = pickFreqForType(type);
    bridgeRef.current?.send({
      type: 'place_layer',
      layerType: type,
      position: point,
      freq,
    });
  };

  const handleBegin = async () => {
    await initAudio();
    startRecording();
    setRecording(true);
    beginLocal();
    openBridgeConnection();
  };

  return (
    <>
      <Scene onPlace={handlePlace} />
      {phase === 'intro' ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 28,
            textAlign: 'center',
            padding: 32,
            pointerEvents: 'auto',
          }}
        >
          <h1 style={{ letterSpacing: '0.45em', fontWeight: 300, fontSize: 30, margin: 0 }}>
            SONOGLYPH
          </h1>
          <p style={{ maxWidth: 480, color: '#a09d99', fontStyle: 'italic', margin: 0 }}>
            A descent. Place tones into the dark and the stone will remember —
            but you do not descend alone.
          </p>
          <button onClick={handleBegin}>Begin descent</button>
        </div>
      ) : (
        <Hud />
      )}
    </>
  );
}
