import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group, Mesh, Points } from 'three';
import type { LayerType, PlacedLayer } from '../state/useSession';

/**
 * Visual stand-in for a sound layer.
 *
 * Most types render as a single mesh whose geometry + material + per-frame
 * animation are all keyed off `layer.type`. Two types break out of that
 * pattern because their visual identity demands more than one drawcall:
 *
 *   - `texture` — a particle cloud (<points>). Atmospheric/grainy presence
 *     reads as "many specks of dust", not as a solid object. A sphere or
 *     icosahedron simply can't communicate that.
 *
 *   - `pulse` — two concentric rings (a <group> of two thin tori). The
 *     visual heartbeat needs an inner stable ring + an outer one whose
 *     radius oscillates with the audio loop. A torus-knot was geometrically
 *     interesting but read as "decorative knot", not "rhythm".
 *
 * The dispatch happens at LayerOrb top level so neither special case
 * pollutes the SingleOrb code path or the shared animateByType switch.
 */
export function LayerOrb({ layer }: { layer: PlacedLayer }) {
  if (layer.type === 'texture') return <TextureCloud layer={layer} />;
  if (layer.type === 'pulse') return <PulseRings layer={layer} />;
  return <SingleOrb layer={layer} />;
}

// ---------------------------------------------------------------------------
// Shared per-type palette — emissive/color/intensity. Used by SingleOrb's
// Material AND by TextureCloud / PulseRings so all three render paths
// stay visually in sync (and match the HUD presetColors map in Hud.tsx).
// ---------------------------------------------------------------------------
const PALETTE: Record<
  LayerType,
  { emissive: string; color: string; intensity: number }
> = {
  drone: { emissive: '#8aa1b3', color: '#0e1820', intensity: 0.7 },
  texture: { emissive: '#aab0a8', color: '#1a1c1d', intensity: 0.45 },
  pulse: { emissive: '#c9885b', color: '#1f1410', intensity: 0.95 },
  glitch: { emissive: '#7be0d4', color: '#062322', intensity: 1.0 },
  breath: { emissive: '#d4a098', color: '#1f1413', intensity: 0.55 },
  bell: { emissive: '#e8c97a', color: '#1f1808', intensity: 1.1 },
  drip: { emissive: '#7eb6d6', color: '#0a1420', intensity: 0.75 },
  swell: { emissive: '#9f7eb8', color: '#150a1c', intensity: 0.5 },
  chord: { emissive: '#d4c8a8', color: '#1c1a14', intensity: 0.65 },
};

// ---------------------------------------------------------------------------
// SingleOrb — covers 7 of 9 types: drone, glitch, breath, bell, drip,
// swell, chord. (texture + pulse have their own components above.)
// ---------------------------------------------------------------------------
function SingleOrb({ layer }: { layer: PlacedLayer }) {
  const ref = useRef<Mesh>(null);

  useFrame((s) => {
    if (!ref.current) return;
    animateByType(ref.current, layer, s.clock.elapsedTime);
  });

  return (
    <mesh ref={ref} position={layer.position}>
      <Geometry type={layer.type} />
      <Material type={layer.type} />
    </mesh>
  );
}

function Geometry({ type }: { type: LayerType }) {
  switch (type) {
    // Drone — dodecahedron with larger radius than the prior icosahedron.
    // Twelve pentagonal faces read as "geological boulder" rather than
    // "generic faceted ball". Paired with a no-rotation, deep-breath
    // animation in animateByType for a grounded, immobile feel.
    case 'drone':
      return <dodecahedronGeometry args={[0.62, 0]} />;
    // Texture — unreachable. LayerOrb dispatches texture to TextureCloud
    // before SingleOrb mounts. Fallback only exists to satisfy the
    // exhaustive switch and to avoid the optional-return TS surprise.
    case 'texture':
      return <sphereGeometry args={[0.5, 8, 8]} />;
    // Pulse — likewise unreachable, dispatched to PulseRings.
    case 'pulse':
      return <torusGeometry args={[0.4, 0.05, 8, 24]} />;
    case 'glitch':
      return <tetrahedronGeometry args={[0.5, 0]} />;
    // Breath — vertical capsule. The capsule axis is Y by default in
    // Three.js (since r140); we breathe through diameter (X/Z scale)
    // rather than length, which reads as a lung filling, not stretching.
    case 'breath':
      return <capsuleGeometry args={[0.32, 0.55, 4, 12]} />;
    case 'bell':
      return <octahedronGeometry args={[0.55, 0]} />;
    case 'drip':
      return <sphereGeometry args={[0.4, 16, 16]} />;
    case 'swell':
      return <torusGeometry args={[0.65, 0.08, 12, 36]} />;
    case 'chord':
      return <torusGeometry args={[0.55, 0.18, 14, 32]} />;
  }
}

function Material({ type }: { type: LayerType }) {
  const p = PALETTE[type];
  // Bell + chord lean a bit metallic; pulse keeps its prior 0.4 even though
  // the visual is now PulseRings (which has its own material). Glitch + bell
  // get reduced roughness for a sharper, more reflective look.
  const metalness =
    type === 'pulse' || type === 'bell' || type === 'chord' ? 0.4 : 0.1;
  const roughness = type === 'glitch' || type === 'bell' ? 0.3 : 0.6;
  return (
    <meshStandardMaterial
      emissive={p.emissive}
      emissiveIntensity={p.intensity}
      color={p.color}
      roughness={roughness}
      metalness={metalness}
    />
  );
}

function animateByType(mesh: Mesh, layer: PlacedLayer, t: number) {
  switch (layer.type) {
    case 'drone': {
      // Slow, deep breath. Period 8s (angular freq π/4), amplitude 0.075
      // → scale oscillates between 0.90 and 1.05. NO rotation — drone is
      // supposed to feel like a stationary mass, not an active object.
      const breathe = 0.975 + Math.sin((t * Math.PI) / 4) * 0.075;
      mesh.scale.setScalar(breathe);
      return;
    }
    case 'texture':
      // Handled by TextureCloud — never reached.
      return;
    case 'pulse':
      // Handled by PulseRings — never reached.
      return;
    case 'glitch': {
      // Jittered rotation — occasional snap, otherwise still.
      if (Math.random() < 0.04) {
        mesh.rotation.x += (Math.random() - 0.5) * 0.6;
        mesh.rotation.y += (Math.random() - 0.5) * 0.6;
      }
      const flicker = Math.random() < 0.06 ? 1.18 : 0.95;
      mesh.scale.setScalar(flicker);
      return;
    }
    case 'breath': {
      // Diameter pulses (X/Z); length (Y) stays constant. The capsule
      // looks like a small lung filling and emptying. Slow Y rotation
      // adds a hint of life without becoming a spinning prop.
      const breath = 1 + Math.sin(t * 0.55) * 0.15;
      mesh.scale.set(breath, 1, breath);
      mesh.rotation.y += 0.0006;
      return;
    }
    case 'bell': {
      // Slow rotation + faint metallic shimmer.
      mesh.rotation.y += 0.004;
      mesh.rotation.z += 0.001;
      const shimmer = 0.96 + Math.sin(t * 1.4) * 0.04;
      mesh.scale.setScalar(shimmer);
      return;
    }
    case 'drip': {
      // Mostly still; occasional sharp downward "drip" — quick squash on
      // Y followed by a slower restore via component-wise lerp toward 1.
      if (Math.random() < 0.025) {
        mesh.scale.set(1.1, 0.55, 1.1);
      } else {
        mesh.scale.x += (1 - mesh.scale.x) * 0.05;
        mesh.scale.y += (1 - mesh.scale.y) * 0.05;
        mesh.scale.z += (1 - mesh.scale.z) * 0.05;
      }
      mesh.rotation.y += 0.0008;
      return;
    }
    case 'swell': {
      // Long expansion/contraction matching the audio's 10-second LFO.
      const wave = 0.85 + Math.sin(t * 0.6) * 0.25;
      mesh.scale.setScalar(wave);
      mesh.rotation.x = Math.sin(t * 0.25) * 0.4;
      mesh.rotation.y += 0.0015;
      return;
    }
    case 'chord': {
      // Three-fold breath nods at the three partials; two-axis rotation
      // keeps the halo reading as a ring rather than a flat disc.
      const breathe = 0.92 + Math.sin(t * 0.35) * 0.06;
      mesh.scale.setScalar(breathe);
      mesh.rotation.x += 0.002;
      mesh.rotation.y += 0.0035;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// TEXTURE — particle cloud.
//
// 50 unlit points distributed inside a sphere of radius ~0.8 around the
// layer's position. The cloud rotates slowly on Y + tilts on X, with a
// subtle scale drift. Particles use `pointsMaterial` (no PBR — points
// can't be lit), so we set `toneMapped: false` and rely on the emissive
// color value directly to make them legible against the dark scene.
//
// Particle layout is generated once per layer (memoized on layer.id) so
// the cloud doesn't reshuffle every frame. Each layer ends up with a
// stable, unique distribution.
// ---------------------------------------------------------------------------
const TEXTURE_PARTICLE_COUNT = 50;

function TextureCloud({ layer }: { layer: PlacedLayer }) {
  const ref = useRef<Points>(null);

  const positions = useMemo(() => {
    const arr = new Float32Array(TEXTURE_PARTICLE_COUNT * 3);
    for (let i = 0; i < TEXTURE_PARTICLE_COUNT; i++) {
      // Roughly uniform sphere distribution — random radius + spherical
      // angles. Not perfectly uniform (proper uniformity would use cube
      // root on r) but at this scale the eye doesn't notice.
      const r = 0.35 + Math.random() * 0.5;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = r * Math.cos(phi);
    }
    return arr;
  }, [layer.id]);

  useFrame((s) => {
    if (!ref.current) return;
    const t = s.clock.elapsedTime;
    ref.current.rotation.y = t * 0.08;
    ref.current.rotation.x = Math.sin(t * 0.12) * 0.3;
    const drift = 0.95 + Math.sin(t * 0.4) * 0.05;
    ref.current.scale.setScalar(drift);
  });

  const p = PALETTE.texture;

  return (
    <points ref={ref} position={layer.position}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.045}
        color={p.emissive}
        transparent
        opacity={0.85}
        sizeAttenuation
        toneMapped={false}
      />
    </points>
  );
}

// ---------------------------------------------------------------------------
// PULSE — concentric rings.
//
// Inner ring: stable, narrow torus at radius 0.30. Outer ring: narrower
// torus at radius 0.55, with its scale oscillating in time with the audio
// loop's ~5s heartbeat (engine.ts buildPulse uses a 4–7.5s interval; the
// 0.6 rad/s oscillation here gives ~5.2s per beat-cycle, close enough that
// audio + visual feel coupled without us actually wiring them).
//
// The whole group rotates slowly on Z (and a hint on Y) so the rings stay
// alive between beats without distracting from the pulse itself.
// ---------------------------------------------------------------------------
function PulseRings({ layer }: { layer: PlacedLayer }) {
  const groupRef = useRef<Group>(null);
  const outerRef = useRef<Mesh>(null);

  useFrame((s) => {
    const t = s.clock.elapsedTime;
    if (outerRef.current) {
      // |sin| gives a "ping" that hits the peak briefly and returns to 1
      // — closer to a heartbeat than a smooth sine sweep.
      const pulse = 1 + Math.abs(Math.sin(t * 0.6)) * 0.45;
      outerRef.current.scale.setScalar(pulse);
    }
    if (groupRef.current) {
      groupRef.current.rotation.z += 0.003;
      groupRef.current.rotation.y += 0.0015;
    }
  });

  const p = PALETTE.pulse;

  return (
    <group ref={groupRef} position={layer.position}>
      {/* Inner stable ring */}
      <mesh>
        <torusGeometry args={[0.3, 0.04, 8, 24]} />
        <meshStandardMaterial
          emissive={p.emissive}
          emissiveIntensity={p.intensity}
          color={p.color}
          roughness={0.6}
          metalness={0.4}
        />
      </mesh>
      {/* Outer pulsing ring — slightly dimmer so the inner one anchors the eye */}
      <mesh ref={outerRef}>
        <torusGeometry args={[0.55, 0.03, 8, 32]} />
        <meshStandardMaterial
          emissive={p.emissive}
          emissiveIntensity={p.intensity * 0.85}
          color={p.color}
          roughness={0.6}
          metalness={0.4}
        />
      </mesh>
    </group>
  );
}
