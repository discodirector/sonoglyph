import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Mesh } from 'three';
import type { PlacedLayer } from '../state/useSession';

/**
 * Visual stand-in for a sound layer — a softly glowing icosahedron that
 * breathes at a tempo derived from its sound's fundamental.
 */
export function LayerOrb({ layer }: { layer: PlacedLayer }) {
  const ref = useRef<Mesh>(null);

  useFrame((s) => {
    if (!ref.current) return;
    const t = s.clock.elapsedTime;
    // Slower breathe for lower frequencies — feels right.
    const period = 220 / layer.freq; // ~2..4 seconds
    const breathe = 0.92 + Math.sin((t * Math.PI) / period) * 0.08;
    ref.current.scale.setScalar(breathe);
    ref.current.rotation.y += 0.0015;
    ref.current.rotation.x += 0.0008;
  });

  return (
    <mesh ref={ref} position={layer.position}>
      <icosahedronGeometry args={[0.55, 1]} />
      <meshStandardMaterial
        emissive={'#8aa1b3'}
        emissiveIntensity={0.7}
        color={'#0e1820'}
        roughness={0.55}
        metalness={0.1}
      />
    </mesh>
  );
}
