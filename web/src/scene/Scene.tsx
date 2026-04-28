import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  EffectComposer,
  Bloom,
  Vignette,
  Noise,
} from '@react-three/postprocessing';
import { Fog } from 'three';
import type { Mesh } from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useSession } from '../state/useSession';
import { setListenerPosition } from '../audio/engine';
import { LayerOrb } from './Layer';

/**
 * Drives the camera downward during the descent phase and keeps the audio
 * listener glued to it for spatial panning.
 *
 * Pacing: ~6 minutes total descent → ~2.78 units/sec.
 */
function DescentCamera() {
  const camera = useThree((s) => s.camera);
  const phase = useSession((s) => s.phase);
  const setDepth = useSession((s) => s.setDepth);

  useEffect(() => {
    camera.position.set(0, 0, 0);
    camera.lookAt(0, -8, -10);
  }, [camera]);

  useFrame((_, delta) => {
    if (phase === 'descent') {
      const speed = 1000 / (6 * 60);
      camera.position.y -= speed * delta;
      setDepth(Math.max(0, -camera.position.y));
    }
    // Listener follows the camera so 3D-panned layers feel located in space.
    setListenerPosition(camera.position.x, camera.position.y, camera.position.z);
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
 * Faint ambient markers — give the void a felt depth even before any layers
 * are placed. Static cloud, no audio.
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
      const y = -(Math.random() * 1100);
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

/**
 * Invisible horizontal plane that follows ~18 units below the camera. Catches
 * pointer clicks anywhere in the descent corridor and reports the world-space
 * hit point so App can spawn a layer there. Depth-write disabled so it never
 * occludes orbs visually.
 */
function PlacementPlane({
  onPlace,
}: {
  onPlace: (point: [number, number, number]) => void;
}) {
  const ref = useRef<Mesh>(null);
  const camera = useThree((s) => s.camera);

  useFrame(() => {
    if (!ref.current) return;
    ref.current.position.x = camera.position.x;
    ref.current.position.y = camera.position.y - 18;
    ref.current.position.z = camera.position.z - 6;
  });

  return (
    <mesh
      ref={ref}
      rotation={[-Math.PI / 2, 0, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onPlace([e.point.x, e.point.y, e.point.z]);
      }}
    >
      <planeGeometry args={[240, 240]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

export function Scene({
  onPlace,
}: {
  onPlace: (point: [number, number, number]) => void;
}) {
  const layers = useSession((s) => s.layers);
  const phase = useSession((s) => s.phase);

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

      {phase === 'descent' && <PlacementPlane onPlace={onPlace} />}

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
