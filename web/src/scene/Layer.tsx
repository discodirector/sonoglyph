import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Mesh } from 'three';
import type { LayerType, PlacedLayer } from '../state/useSession';

/**
 * Visual stand-in for a sound layer. Geometry + emissive colour vary by
 * preset so the type is readable at a glance even from a distance.
 */
export function LayerOrb({ layer }: { layer: PlacedLayer }) {
  const ref = useRef<Mesh>(null);

  useFrame((s) => {
    if (!ref.current) return;
    const t = s.clock.elapsedTime;
    animateByType(ref.current, layer, t);
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
    case 'drone':
      return <icosahedronGeometry args={[0.55, 1]} />;
    case 'texture':
      return <sphereGeometry args={[0.7, 24, 24]} />;
    case 'pulse':
      return <torusKnotGeometry args={[0.42, 0.13, 96, 12]} />;
    case 'glitch':
      return <tetrahedronGeometry args={[0.5, 0]} />;
    case 'breath':
      return <sphereGeometry args={[0.55, 18, 12]} />;
    // Day 6 expansion:
    //   bell  — sharp octahedron, suggests a struck metallic resonator.
    //   drip  — small smooth sphere, like a single bead of water.
    //   swell — flat ring (low-profile torus), looks like an approaching
    //           pressure wave seen edge-on.
    //   chord — fatter torus stack feels like layered halos for the three
    //           harmonic partials.
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
  // Emissive choices keyed to mood:
  //   drone   — cool blue    (foundation)
  //   texture — pale grey    (atmosphere)
  //   pulse   — warm amber   (rhythm presence)
  //   glitch  — sharp cyan   (digital intrusion)
  //   breath  — soft rose    (vocal warmth)
  //   bell    — gold         (resonant strike)
  //   drip    — water blue   (single event)
  //   swell   — pale violet  (slow wave)
  //   chord   — ivory        (harmonic halo)
  const palette: Record<LayerType, { emissive: string; color: string; intensity: number }> = {
    drone: { emissive: '#8aa1b3', color: '#0e1820', intensity: 0.7 },
    texture: { emissive: '#aab0a8', color: '#1a1c1d', intensity: 0.45 },
    pulse: { emissive: '#c9885b', color: '#1f1410', intensity: 0.85 },
    glitch: { emissive: '#7be0d4', color: '#062322', intensity: 1.0 },
    breath: { emissive: '#d4a098', color: '#1f1413', intensity: 0.55 },
    bell: { emissive: '#e8c97a', color: '#1f1808', intensity: 1.1 },
    drip: { emissive: '#7eb6d6', color: '#0a1420', intensity: 0.75 },
    swell: { emissive: '#9f7eb8', color: '#150a1c', intensity: 0.5 },
    chord: { emissive: '#d4c8a8', color: '#1c1a14', intensity: 0.65 },
  };
  const p = palette[type];
  // Bell + chord lean a bit metallic; glitch is shiny.
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
      const period = 220 / layer.freq;
      const breathe = 0.92 + Math.sin((t * Math.PI) / period) * 0.08;
      mesh.scale.setScalar(breathe);
      mesh.rotation.y += 0.0015;
      mesh.rotation.x += 0.0008;
      return;
    }
    case 'texture': {
      const drift = 0.95 + Math.sin(t * 0.4) * 0.05;
      mesh.scale.setScalar(drift);
      mesh.rotation.y += 0.001;
      return;
    }
    case 'pulse': {
      // Match the audio loop's ~5s cadence with a stronger pulse.
      const pulse = 0.85 + Math.abs(Math.sin(t * 0.6)) * 0.35;
      mesh.scale.setScalar(pulse);
      mesh.rotation.x += 0.005;
      mesh.rotation.y += 0.003;
      return;
    }
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
      // Slow elongation — non-uniform scale on Y to suggest exhale.
      const breath = 0.9 + Math.sin(t * 0.55) * 0.18;
      mesh.scale.set(1, breath, 1);
      mesh.rotation.y += 0.0006;
      return;
    }
    case 'bell': {
      // Slow rotation + gentle metallic shimmer (faint scale wobble).
      mesh.rotation.y += 0.004;
      mesh.rotation.z += 0.001;
      const shimmer = 0.96 + Math.sin(t * 1.4) * 0.04;
      mesh.scale.setScalar(shimmer);
      return;
    }
    case 'drip': {
      // Mostly still; occasional sharp downward "drip" — a quick squash on Y
      // followed by a slower restore. Same trick as glitch but biased so it
      // reads as a discrete event, not constant jitter.
      if (Math.random() < 0.025) {
        mesh.scale.set(1.1, 0.55, 1.1);
      } else {
        // Ease scale back toward 1 component-wise (avoids a Vector3 alloc
        // every frame).
        mesh.scale.x += (1 - mesh.scale.x) * 0.05;
        mesh.scale.y += (1 - mesh.scale.y) * 0.05;
        mesh.scale.z += (1 - mesh.scale.z) * 0.05;
      }
      mesh.rotation.y += 0.0008;
      return;
    }
    case 'swell': {
      // Long expansion/contraction — matches the audio's 10-second LFO.
      const wave = 0.85 + Math.sin(t * 0.6) * 0.25;
      mesh.scale.setScalar(wave);
      // Slow tilt; the ring catches light differently as it rotates.
      mesh.rotation.x = Math.sin(t * 0.25) * 0.4;
      mesh.rotation.y += 0.0015;
      return;
    }
    case 'chord': {
      // Three-fold breath suggests three layered partials. Slow rotation on
      // two axes so the halo always reads as ring-like, not a flat disc.
      const breathe = 0.92 + Math.sin(t * 0.35) * 0.06;
      mesh.scale.setScalar(breathe);
      mesh.rotation.x += 0.002;
      mesh.rotation.y += 0.0035;
      return;
    }
  }
}
