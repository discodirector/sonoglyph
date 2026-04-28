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
  }
}

function Material({ type }: { type: LayerType }) {
  // Emissive choices keyed to mood:
  //   drone   — cool blue   (foundation)
  //   texture — pale grey   (atmosphere)
  //   pulse   — warm amber  (rhythm presence)
  //   glitch  — sharp cyan  (digital intrusion)
  //   breath  — soft rose   (vocal warmth)
  const palette: Record<LayerType, { emissive: string; color: string; intensity: number }> = {
    drone: { emissive: '#8aa1b3', color: '#0e1820', intensity: 0.7 },
    texture: { emissive: '#aab0a8', color: '#1a1c1d', intensity: 0.45 },
    pulse: { emissive: '#c9885b', color: '#1f1410', intensity: 0.85 },
    glitch: { emissive: '#7be0d4', color: '#062322', intensity: 1.0 },
    breath: { emissive: '#d4a098', color: '#1f1413', intensity: 0.55 },
  };
  const p = palette[type];
  return (
    <meshStandardMaterial
      emissive={p.emissive}
      emissiveIntensity={p.intensity}
      color={p.color}
      roughness={type === 'glitch' ? 0.3 : 0.6}
      metalness={type === 'pulse' ? 0.4 : 0.1}
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
  }
}
