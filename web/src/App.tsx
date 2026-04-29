import { useEffect, useRef } from 'react';
import { Scene } from './scene/Scene';
import { Hud } from './ui/Hud';
import { Intro } from './ui/Intro';
import { Finale } from './ui/Finale';
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
 * Sonoglyph root — Day 5.
 *
 * - Bridge WS opens IMMEDIATELY on mount (so we can show the pairing code
 *   before the player even thinks about clicking Begin).
 * - The player runs Hermes locally with the printed command; once Hermes
 *   connects via MCP, server emits `agent_paired` → Begin unlocks.
 * - On Begin: init audio (requires user gesture), tell server `hello` to
 *   start the descent.
 */
export function App() {
  const phase = useSession((s) => s.phase);
  const depth = useSession((s) => s.depth);
  const agentConnected = useSession((s) => s.agentConnected);
  const beginLocal = useSession((s) => s.beginLocal);
  const setProxyOk = useSession((s) => s.setProxyOk);
  const setRecording = useSession((s) => s.setRecording);
  const setSelectedPreset = useSession((s) => s.setSelectedPreset);
  const pushEvent = useSession((s) => s.pushEvent);
  const applySessionCreated = useSession((s) => s.applySessionCreated);
  const applyAgentPaired = useSession((s) => s.applyAgentPaired);
  const applySnapshot = useSession((s) => s.applySnapshot);
  const applyLayerAdded = useSession((s) => s.applyLayerAdded);
  const applyTurnChanged = useSession((s) => s.applyTurnChanged);
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

  // Keyboard 1-5 selects preset (only during play).
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

  // Spectral snapshots — feeds future spectral context for the journal.
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
  // Open the bridge on mount — well before Begin. We need the code to
  // show pairing instructions to the player. Audio init still waits for
  // a user gesture (Begin click).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (bridgeRef.current && bridgeRef.current.isOpen()) return;

    const conn = openBridge((msg) => {
      switch (msg.type) {
        case 'session_created':
          applySessionCreated({
            code: msg.code,
            mcpUrl: msg.mcpUrl,
            hermesCommand: msg.hermesCommand,
            hermesAddCommand: msg.hermesAddCommand,
          });
          return;
        case 'agent_paired':
          applyAgentPaired(true);
          return;
        case 'agent_disconnected':
          applyAgentPaired(false);
          return;
        case 'state':
          applySnapshot(msg.state);
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
        case 'finished':
          applyFinished(msg.artifact);
          return;
        case 'error':
          console.warn('[bridge]', msg.message);
          return;
      }
    });

    bridgeRef.current = conn;

    return () => {
      conn.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (!agentConnected) return;
    await initAudio();
    startRecording();
    setRecording(true);
    beginLocal();
    bridgeRef.current?.send({ type: 'hello' });
  };

  return (
    <>
      <Scene onPlace={handlePlace} />
      {phase === 'intro' && <Intro onBegin={handleBegin} />}
      {phase === 'playing' && <Hud />}
      {phase === 'finished' && <Finale />}
    </>
  );
}
