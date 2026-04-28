import { useEffect } from 'react';
import { Scene } from './scene/Scene';
import { Hud } from './ui/Hud';
import { useSession } from './state/useSession';
import { addDroneLayer, initAudio, setGlobalDepth } from './audio/engine';

/**
 * Sonoglyph root.
 *
 * Day 1 vertical slice:
 *   - INTRO gate (audio context requires user gesture)
 *   - DESCENT phase: camera drifts down, "Place Layer" spawns a drone
 *   - Proxy /health ping on mount
 *   - Periodic stub call to /api/hermes/stream → narrate line in HUD
 */
export function App() {
  const phase = useSession((s) => s.phase);
  const depth = useSession((s) => s.depth);
  const begin = useSession((s) => s.begin);
  const setProxyOk = useSession((s) => s.setProxyOk);
  const setAgentLine = useSession((s) => s.setAgentLine);
  const addLayerToState = useSession((s) => s.addLayer);
  const pushEvent = useSession((s) => s.pushEvent);

  // Verify proxy is reachable on boot.
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

  // Periodically nudge the agent (stub Day 1).
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
                /* ignore malformed */
              }
            }
          }
        }
      } catch {
        /* network / proxy down — silent on Day 1 */
      }
    };

    // Fire once shortly after begin, then every 30s.
    const initial = window.setTimeout(tick, 4000);
    const interval = window.setInterval(tick, 30000);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [phase, setAgentLine, pushEvent]);

  /**
   * Place a layer in a forward-down cone relative to the camera so the
   * descending camera approaches it gradually (~5-7s of visibility).
   * The camera looks ~39° below horizon, so orbs sit below + forward.
   */
  const placeLayerAtCurrentDepth = (currentDepth: number) => {
    const handle = addDroneLayer();
    const angle = Math.random() * Math.PI * 2;
    const radius = 2 + Math.random() * 3.5;
    const xOffset = Math.cos(angle) * radius;
    const zOffset = -(8 + Math.random() * 8) + Math.sin(angle) * 1.5;
    const yOffset = -(currentDepth + 13 + Math.random() * 8);
    addLayerToState({
      id: handle.id,
      freq: handle.freq,
      position: [xOffset, yOffset, zOffset],
      bornAt: Date.now(),
    });
  };

  const handleBegin = async () => {
    await initAudio();
    placeLayerAtCurrentDepth(0); // seed bed, visible from descent start
    begin();
  };

  const handlePlace = () => {
    placeLayerAtCurrentDepth(depth);
  };

  return (
    <>
      <Scene />
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
        <Hud onPlace={handlePlace} />
      )}
    </>
  );
}
