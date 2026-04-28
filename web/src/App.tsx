import { useEffect, useRef } from 'react';
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

/**
 * Sonoglyph root.
 *
 * Day 2 vertical slice:
 *   - INTRO gate (audio context requires user gesture)
 *   - Click anywhere in the descent → spawns selected preset at that point
 *   - Keyboard 1-5 selects preset, palette in HUD reflects choice
 *   - Spectrum snapshots every 5s into the session log
 *   - Master recorder runs from begin() → blob retrievable later (Day 4 UI)
 *   - Stub Hermes call every 30s → narrate line in HUD (Day 3 wires real one)
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

  // Layer handles for future fade-out (Day 4 will wire arrival → fade).
  const layerHandlesRef = useRef<Map<string, () => void>>(new Map());

  // Health check on mount.
  useEffect(() => {
    fetch('/health')
      .then((r) => r.json())
      .then((d) => setProxyOk(Boolean(d?.ok)))
      .catch(() => setProxyOk(false));
  }, [setProxyOk]);

  // Mirror global depth into the audio engine (depth → reverb send).
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

  // Stub Hermes call every 30s (Day 3 swaps for real streaming + tool use).
  useEffect(() => {
    if (phase !== 'descent') return;

    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/hermes/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ depth: useSession.getState().depth }),
        });
        if (!res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const events = buf.split('\n\n');
          buf = events.pop() ?? '';
          for (const evt of events) {
            const eventLine = evt.match(/event: (\w+)/)?.[1];
            const dataLine = evt.match(/data: (.+)/)?.[1];
            if (eventLine === 'tool_call' && dataLine) {
              try {
                const tool = JSON.parse(dataLine);
                if (tool?.name === 'narrate' && tool.arguments?.text) {
                  setAgentLine(tool.arguments.text);
                  pushEvent({
                    type: 'agent_narrate',
                    text: tool.arguments.text,
                    mood: tool.arguments.mood ?? 'calm',
                    depth: useSession.getState().depth,
                  });
                  window.setTimeout(() => setAgentLine(null), 9000);
                }
              } catch {
                /* malformed — ignore */
              }
            }
          }
        }
      } catch {
        /* network down — silent */
      }
    };

    const initial = window.setTimeout(tick, 4000);
    const interval = window.setInterval(tick, 30000);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [phase, setAgentLine, pushEvent]);

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
    // Default selectedPreset is 'drone'.
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
