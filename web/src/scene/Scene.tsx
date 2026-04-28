import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  EffectComposer,
  Bloom,
  Vignette,
  Noise,
} from '@react-three/postprocessing';
import { Fog } from 'three';
import { useEffect, useMemo } from 'react';
import { useSession } from '../state/useSession';
import { LayerOrb } from './Layer';

/**
 * Drives the camera downward during the descent phase.
 * Pacing: ~6 minutes total descent → ~2.78 units/sec.
 *
 * Camera keeps its initial orientation (look slightly down-forward) for
 * the whole descent — the world drifts past as the camera falls.
 */
function DescentCamera() {
  const camera = useThree((s) => s.camera);
  const phase = useSession((s) => s.phase);
  const setDepth = useSession((s) => s.setDepth);

  useEffect(() => {
    camera.position.set(0, 0, 0);
    // Look down-and-forward; this orientation is preserved as we drop.
    camera.lookAt(0, -8, -10);
  }, [camera]);

  useFrame((_, delta) => {
    if (phase !== 'descent') return;
    const speed = 1000 / (6 * 60);
    camera.position.y -= speed * delta;
    setDepth(Math.max(0, -camera.position.y));
  });

  return null;
}

function FogSetup() {
  const { scene } = useThree();
  useEffect(() => {
    scene.fog = new Fog(0x050507, 6, 48);
  }, [scene]);
  return null;
}

/**
 * Faint ambient markers — give the void a felt depth even before the
 * player has placed any layers. Static cloud of dim points scattered
 * along the descent corridor. They are not interactive and produce no
 * sound; they just keep the scene from looking empty during the first
 * seconds.
 */
function DepthMarkers() {
  const points = useMemo(() => {
    const arr: Array<[number, number, number]> = [];
    const N = 220;
    for (let i = 0; i < N; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 3 + Math.random() * 14;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius - 6;
      const y = -(Math.random() * 1100); // spread across full descent
      arr.push([x, y, z]);
    }
    return arr;
  }, []);

  return (
    <group>
      {points.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[0.05, 6, 6]} />
          <meshBasicMaterial
            color={i % 5 === 0 ? '#c97a5b' : '#8aa1b3'}
            transparent
            opacity={0.45}
          />
        </mesh>
      ))}
    </group>
  );
}

export function Scene() {
  const layers = useSession((s) => s.layers);

  return (
    <Canvas
      camera={{ position: [0, 0, 0], fov: 70, near: 0.1, far: 300 }}
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      style={{ position: 'fixed', inset: 0, background: '#050507' }}
    >
      <FogSetup />
      <DescentCamera />

      <ambientLight intensity={0.22} />
      <pointLight position={[0, 0, 0]} intensity={0.6} distance={24} decay={2} />

      <DepthMarkers />

      {layers.map((l) => (
        <LayerOrb key={l.id} layer={l} />
      ))}

      <EffectComposer>
        <Bloom
          intensity={1.0}
          luminanceThreshold={0.18}
          luminanceSmoothing={0.5}
          mipmapBlur
        />
        <Noise opacity={0.06} />
        <Vignette eskil={false} offset={0.32} darkness={0.85} />
      </EffectComposer>
    </Canvas>
  );
}
