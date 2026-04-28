import { useSession } from '../state/useSession';

/**
 * Minimal HUD overlay. Mono, mix-blend-difference so it stays readable
 * over any background colour without competing with the scene.
 */
export function Hud({ onPlace }: { onPlace: () => void }) {
  const phase = useSession((s) => s.phase);
  const depth = useSession((s) => s.depth);
  const layers = useSession((s) => s.layers);
  const proxyOk = useSession((s) => s.proxyOk);
  const agentLine = useSession((s) => s.agentLine);

  if (phase === 'intro') return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 24,
        mixBlendMode: 'difference',
        color: '#d8d4cf',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11,
          letterSpacing: '0.18em',
        }}
      >
        <span>SONOGLYPH</span>
        <span>
          DEPTH {Math.round(depth).toString().padStart(4, '0')} · LAYERS{' '}
          {layers.length.toString().padStart(2, '0')} · PROXY{' '}
          {proxyOk === null ? '…' : proxyOk ? 'OK' : 'OFFLINE'}
        </span>
      </div>

      {agentLine ? (
        <div
          style={{
            alignSelf: 'center',
            maxWidth: 640,
            textAlign: 'center',
            fontSize: 16,
            fontStyle: 'italic',
            opacity: 0.9,
            lineHeight: 1.6,
          }}
        >
          “{agentLine}”
        </div>
      ) : (
        <div />
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          pointerEvents: 'auto',
        }}
      >
        <button onClick={onPlace}>Place Layer</button>
      </div>
    </div>
  );
}
