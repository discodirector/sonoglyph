import { useCallback, useEffect, useRef } from 'react';
import { Scene } from './scene/Scene';
import { Hud } from './ui/Hud';
import { LAYER_TYPES, useSession } from './state/useSession';
import {
  addLayer,
  captureSpectrum,
  initAudio,
  setGlobalDepth,
  startRecording,
} from './audio/engine';
import { runAgentTurn } from './agent/voiceLoop';

/**
 * Sonoglyph root.
 *
 * Day 3:
 *   - Real Hermes voice loop with TTS playback (graceful fallback to stub
 *     and silent line if .env keys missing).
 *   - Voice ducks layer audio while playing.
 *   - Periodic turn every 28s + debounced turn 4s after each layer placement,
 *     gated by 15s hard cooldown.
 */
export function App() {
  const phase = useSession((s) => s.phase);
  const depth = useSession((s) => s.depth);
  const begin = useSession((s) => s.begin);
  const setProxyOk = useSession((s) => s.setProxyOk);
  const setAgentLine = useSession((s) => s.setAgentLine);
  const addLayerToState = useSession((s) => s.addLayer);
  const pushEvent = useSession((s) => s.pushEvent);
  const setSelectedPreset = useSession((s) => s.setSelectedPreset);
  const setRecording = useSession((s) => s.setRecording);
  const layerCount = useSession((s) => s.layers.length);

  // Layer handles for future fade-out (Day 4 will wire arrival → fade).
  const layerHandlesRef = useRef<Map<string, () => void>>(new Map());

  // Voice loop state.
  const lastNarrateAtRef = useRef<number>(0);
  const turnBusyRef = useRef(false);

  // Health check on mount.
  useEffect(() => {
    fetch('/health')
      .then((r) => r.json())
      .then((d) => setProxyOk(Boolean(d?.ok)))
      .catch(() => setProxyOk(false));
  }, [setProxyOk]);

  // Mirror global depth into the audio engine.
  useEffect(() => {
    setGlobalDepth(depth);
  }, [depth]);

  // Keyboard 1-5 selects preset.
  useEffect(() => {
    if (phase !== 'descent') return;
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
    if (phase !== 'descent') return;
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
  // Voice loop
  // ---------------------------------------------------------------------------
  const tryAgentTurn = useCallback(async () => {
    if (turnBusyRef.current) return;
    if (Date.now() - lastNarrateAtRef.current < 15000) return; // hard cooldown

    turnBusyRef.current = true;
    try {
      await runAgentTurn({
        onNarrate: (text, mood) => {
          setAgentLine(text);
          pushEvent({
            type: 'agent_narrate',
            text,
            mood,
            depth: useSession.getState().depth,
          });
          lastNarrateAtRef.current = Date.now();
          window.setTimeout(() => setAgentLine(null), 9000);
        },
        onSuggest: (layerType, reason) => {
          pushEvent({
            type: 'agent_suggest',
            layerType,
            reason,
            depth: useSession.getState().depth,
          });
        },
      });
    } finally {
      turnBusyRef.current = false;
    }
  }, [setAgentLine, pushEvent]);

  // Periodic + opening turn.
  useEffect(() => {
    if (phase !== 'descent') return;
    const initial = window.setTimeout(tryAgentTurn, 5000);
    const interval = window.setInterval(tryAgentTurn, 28000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [phase, tryAgentTurn]);

  // Triggered turn shortly after each layer placement (cooldown still applies).
  useEffect(() => {
    if (phase !== 'descent') return;
    if (layerCount === 0) return;
    const t = window.setTimeout(tryAgentTurn, 4000);
    return () => window.clearTimeout(t);
  }, [phase, layerCount, tryAgentTurn]);

  /**
   * Place a layer at a world-space point. Reads the currently selected preset
   * from the store so keyboard/palette changes apply immediately.
   */
  const handlePlace = (point: [number, number, number]) => {
    const type = useSession.getState().selectedPreset;
    const handle = addLayer(type, point);
    layerHandlesRef.current.set(handle.id, handle.dispose);
    addLayerToState({
      id: handle.id,
      type,
      freq: handle.freq,
      position: point,
      bornAt: Date.now(),
    });
  };

  const handleBegin = async () => {
    await initAudio();
    startRecording();
    setRecording(true);
    begin(); // sets phase, startedAt, fresh log
    // Seed a layer in front-and-below so the descent isn't silent.
    handlePlace([0, -16, -10]);
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
            A descent. Place tones into the dark and the stone will remember.
          </p>
          <button onClick={handleBegin}>Begin descent</button>
        </div>
      ) : (
        <Hud />
      )}
    </>
  );
}
