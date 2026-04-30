import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  EffectComposer,
  Bloom,
  Vignette,
  Noise,
} from '@react-three/postprocessing';
import {
  CanvasTexture,
  Fog,
  LinearFilter,
  Object3D,
  SpriteMaterial,
} from 'three';
import type { InstancedMesh, Mesh } from 'three';
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
    if (phase === 'playing') {
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
 * Closer, denser, dimmer dust band — the parallax companion to DepthMarkers.
 *
 * DepthMarkers sit at radius 3-14 from the descent axis, which is far enough
 * that they barely register motion against the void. ParallaxDust adds a
 * tighter band (radius 0.8-4) of much smaller specks. Because they're closer
 * to the camera path, they sweep past noticeably faster in screen space —
 * that velocity contrast is what reads to the eye as "we're really moving".
 *
 * Implemented as a single InstancedMesh (one draw call) with N=140 specks
 * recycled around the camera: anything that has scrolled past the camera +
 * a small buffer is repositioned 30-50 units below at a fresh angle/radius.
 * That keeps density constant near the camera regardless of how deep we are,
 * with zero allocation per frame.
 */
function ParallaxDust() {
  const meshRef = useRef<InstancedMesh>(null);
  const camera = useThree((s) => s.camera);
  const N = 140;
  const dummy = useMemo(() => new Object3D(), []);
  const instances = useMemo(() => {
    const arr: Array<{ x: number; y: number; z: number; s: number }> = [];
    for (let i = 0; i < N; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 0.8 + Math.random() * 3.2;
      arr.push({
        x: Math.cos(angle) * radius,
        y: -Math.random() * 30, // initial scatter just below origin
        z: Math.sin(angle) * radius - 6,
        s: 0.022 + Math.random() * 0.02,
      });
    }
    return arr;
  }, []);

  useFrame(() => {
    if (!meshRef.current) return;
    const camY = camera.position.y;
    for (let i = 0; i < N; i++) {
      const inst = instances[i];
      // Recycle anything that has scrolled above the camera (with a small
      // buffer so respawn isn't visible at the screen edge).
      if (inst.y > camY + 4) {
        const angle = Math.random() * Math.PI * 2;
        const radius = 0.8 + Math.random() * 3.2;
        inst.x = Math.cos(angle) * radius;
        inst.y = camY - 30 - Math.random() * 22;
        inst.z = Math.sin(angle) * radius - 6;
        inst.s = 0.022 + Math.random() * 0.02;
      }
      dummy.position.set(inst.x, inst.y, inst.z);
      dummy.scale.setScalar(inst.s);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, N]}
      frustumCulled={false}
    >
      <sphereGeometry args={[1, 6, 6]} />
      <meshBasicMaterial
        color="#8aa1b3"
        transparent
        opacity={0.32}
        depthWrite={false}
      />
    </instancedMesh>
  );
}

/**
 * Faint horizontal rings every ~80 depth units, like contour lines on a
 * vertical map. As the camera flies through them they give a tactile,
 * measurable sense of descent — "another one passed" — without crowding the
 * visual field. Every 5th ring is slightly more visible to add a rhythm.
 *
 * Static — placed once at mount, no per-frame work. Fog naturally clips
 * far rings; cheap MeshBasic, ~14 draw calls but each is trivial.
 */
function DepthRings() {
  const rings = useMemo(() => {
    const out: Array<{ y: number; accent: boolean }> = [];
    // Start at i=1 so the first ring is below the starting camera position.
    for (let i = 1; i <= 14; i++) {
      out.push({ y: -i * 80, accent: i % 5 === 0 });
    }
    return out;
  }, []);

  return (
    <group>
      {rings.map((r) => (
        <mesh
          key={r.y}
          position={[0, r.y, -6]}
          rotation={[Math.PI / 2, 0, 0]}
        >
          {/* args: ringRadius, tubeRadius, radialSegments, tubularSegments.
              Tube radius 0.03 keeps the ring as a thin filament; 4 radial
              segments are enough since the tube's own thickness is invisibly
              small at viewing distance. */}
          <torusGeometry args={[6.5, 0.03, 4, 72]} />
          <meshBasicMaterial
            color={r.accent ? '#8aa1b3' : '#6a6660'}
            transparent
            opacity={r.accent ? 0.32 : 0.18}
          />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Sparse mono-font glyphs floating at random points in the descent corridor.
 * Implemented as billboard sprites with per-glyph CanvasTextures so the
 * characters always face the camera. Pulls visual character from the same
 * IBM Plex Mono / JetBrains Mono register as the UI, so the void feels like
 * the same "document" the player is reading from above.
 *
 * 36 sprites, 13 unique glyphs → at most 13 GPU materials (we share
 * SpriteMaterial instances across same-glyph sprites). Static positions —
 * since the camera moves, the glyphs naturally drift up out of frame.
 */
function GlyphStream() {
  const textures = useMemo(() => {
    const chars = ['◇', '─', '│', '·', '╱', '╲', '+', '°', '▽', '◯', '┃', '━', '◊'];
    return chars.map((ch) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, 128, 128);
      ctx.fillStyle = '#d8d4cf';
      ctx.font = '500 92px "IBM Plex Mono", "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Slight y-bias because some glyphs (·, °) sit visually high and look
      // off-center otherwise — averages well across the set.
      ctx.fillText(ch, 64, 68);
      const tex = new CanvasTexture(canvas);
      tex.minFilter = LinearFilter;
      tex.magFilter = LinearFilter;
      return tex;
    });
  }, []);

  // One SpriteMaterial per glyph, shared across all sprites that use it.
  // Without sharing we'd allocate 36 materials and 36 GL programs; with
  // sharing it's at most 13.
  const materials = useMemo(() => {
    return textures.map(
      (tex) =>
        new SpriteMaterial({
          map: tex,
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
        }),
    );
  }, [textures]);

  // Dispose GPU resources when the component unmounts (mostly relevant in
  // dev / HMR; in production this lives for the whole session).
  useEffect(() => {
    return () => {
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
    };
  }, [materials, textures]);

  const items = useMemo(() => {
    return Array.from({ length: 36 }, () => {
      const angle = Math.random() * Math.PI * 2;
      const radius = 1.5 + Math.random() * 6;
      return {
        x: Math.cos(angle) * radius,
        y: -Math.random() * 1100,
        z: Math.sin(angle) * radius - 6,
        glyph: Math.floor(Math.random() * 13),
        scale: 0.28 + Math.random() * 0.4,
      };
    });
  }, []);

  return (
    <group>
      {items.map((it, i) => (
        <sprite key={i} position={[it.x, it.y, it.z]} scale={it.scale}>
          <primitive object={materials[it.glyph]} attach="material" />
        </sprite>
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
      <ParallaxDust />
      <DepthRings />
      <GlyphStream />

      {layers.map((l) => (
        <LayerOrb key={l.id} layer={l} />
      ))}

      {phase === 'playing' && <PlacementPlane onPlace={onPlace} />}

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
