import { LAYER_TYPES, useSession } from '../state/useSession';
import type { LayerType } from '../state/useSession';

/**
 * Minimal HUD overlay. Mono, mix-blend-difference for the top status row so
 * it stays readable over any background. The bottom palette has its own
 * solid bg for hit-targeting comfort.
 *
 * Click on the scene places the selected preset. Keys 1-5 cycle.
 */
export function Hud() {
  const phase = useSession((s) => s.phase);
  const depth = useSession((s) => s.depth);
  const layers = useSession((s) => s.layers);
  const proxyOk = useSession((s) => s.proxyOk);
  const agentLine = useSession((s) => s.agentLine);
  const selected = useSession((s) => s.selectedPreset);
  const setSelected = useSession((s) => s.setSelectedPreset);
  const recording = useSession((s) => s.recording);

  if (phase === 'intro') return null;

  return (
    <>
      {/* Top status row + agent line */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 24,
          paddingBottom: 110,
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
          <span style={{ display: 'flex', gap: 16 }}>
            {recording && (
              <span style={{ color: '#c97a5b' }}>● REC</span>
            )}
            <span>DEPTH {Math.round(depth).toString().padStart(4, '0')}</span>
            <span>LAYERS {layers.length.toString().padStart(2, '0')}</span>
            <span>PROXY {proxyOk === null ? '…' : proxyOk ? 'OK' : 'OFFLINE'}</span>
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
      </div>

      {/* Bottom palette */}
      <div
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          padding: '20px 24px',
          display: 'flex',
          justifyContent: 'center',
          gap: 8,
          pointerEvents: 'auto',
          background:
            'linear-gradient(to top, rgba(5,5,7,0.85) 0%, rgba(5,5,7,0) 100%)',
        }}
      >
        {LAYER_TYPES.map((t, i) => (
          <PresetButton
            key={t}
            type={t}
            index={i + 1}
            active={t === selected}
            onClick={() => setSelected(t)}
          />
        ))}
      </div>

      {/* Hint line above palette — only while no layers placed yet */}
      {layers.length === 0 && (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 88,
            textAlign: 'center',
            fontSize: 11,
            letterSpacing: '0.2em',
            color: '#6a6660',
            pointerEvents: 'none',
          }}
        >
          CLICK INTO THE DARK TO PLACE A LAYER · KEYS 1-5 SELECT PRESET
        </div>
      )}
    </>
  );
}

const presetColors: Record<LayerType, string> = {
  drone: '#8aa1b3',
  texture: '#aab0a8',
  pulse: '#c9885b',
  glitch: '#7be0d4',
  breath: '#d4a098',
};

function PresetButton({
  type,
  index,
  active,
  onClick,
}: {
  type: LayerType;
  index: number;
  active: boolean;
  onClick: () => void;
}) {
  const color = presetColors[type];
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '10px 14px',
        minWidth: 86,
        background: active ? color : 'transparent',
        color: active ? '#050507' : '#d8d4cf',
        border: `1px solid ${active ? color : '#3a3a3e'}`,
        letterSpacing: '0.15em',
        fontSize: 11,
        textTransform: 'uppercase',
        cursor: 'pointer',
      }}
    >
      <span style={{ fontSize: 9, opacity: 0.6 }}>{index}</span>
      <span>{type}</span>
    </button>
  );
}
