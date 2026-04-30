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
  TorusGeometry,
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
 * Generate a "heart-monitor" style displacement profile for one ring —
 * mostly flat baseline, with a handful of sharp narrow spikes and small
 * inverse dips, like the QRS complex on an ECG trace.
 *
 * Returns N samples of radial displacement (added to the ring's base radius
 * during torus vertex displacement). Sampled with linear interpolation when
 * applied, so vertex count and N don't have to match.
 */
function generatePulseProfile(N: number): number[] {
  const out = new Array<number>(N).fill(0);

  // Baseline micro-noise: barely perceptible wobble that breaks perfect
  // smoothness even between spikes. ±0.02 ≈ 0.3% of ring radius.
  for (let i = 0; i < N; i++) {
    out[i] = (Math.random() - 0.5) * 0.04;
  }

  // 5-8 sharp spike complexes randomly placed around the ring. Each is a
  // narrow Gaussian with optional adjacent inverse dip — mirrors the visual
  // shape of an ECG R-wave with neighboring S-wave.
  const numPulses = 5 + Math.floor(Math.random() * 4);
  for (let p = 0; p < numPulses; p++) {
    const center = Math.floor(Math.random() * N);
    const peakHeight = 0.35 + Math.random() * 0.55; // outward spike
    const width = 4 + Math.floor(Math.random() * 4); // half-width in samples

    for (let j = -width * 2; j <= width * 2; j++) {
      const idx = ((center + j) % N + N) % N;
      const t = j / width;
      // Tight Gaussian — sharp peak that decays in a few samples.
      out[idx] += peakHeight * Math.exp(-t * t * 1.5);
    }

    // 70% chance of an adjacent inverse dip on one side.
    if (Math.random() < 0.7) {
      const sign = Math.random() < 0.5 ? -1 : 1;
      const dipCenter =
        ((center + sign * (width + 2 + Math.floor(Math.random() * 3))) % N +
          N) %
        N;
      const dipDepth = 0.06 + Math.random() * 0.14;
      for (let j = -3; j <= 3; j++) {
        const idx = ((dipCenter + j) % N + N) % N;
        const t = j / 3;
        out[idx] -= dipDepth * Math.exp(-t * t * 2);
      }
    }
  }
  return out;
}

/**
 * Apply a radial-displacement profile to a TorusGeometry's vertices in-place.
 * Torus is constructed in the XY plane (ring around Z axis); we displace each
 * vertex radially outward from origin by an amount sampled from the profile
 * at the vertex's angle around the ring. Tube cross-section gets multiplied
 * along with the rest, but at our tube radius (0.03) that shape change is
 * imperceptible.
 */
function applyPulseToTorus(geo: TorusGeometry, profile: number[]): void {
  const pos = geo.attributes.position;
  const N = profile.length;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const angle = Math.atan2(y, x); // -π..π
    const t = (angle + Math.PI) / (Math.PI * 2); // 0..1
    const idxF = t * N;
    const i0 = Math.floor(idxF) % N;
    const i1 = (i0 + 1) % N;
    const frac = idxF - Math.floor(idxF);
    const disp = profile[i0] * (1 - frac) + profile[i1] * frac;

    const r = Math.sqrt(x * x + y * y);
    if (r > 1e-6) {
      const factor = (r + disp) / r;
      pos.setX(i, x * factor);
      pos.setY(i, y * factor);
    }
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
}

/**
 * Render depth-label text ("200", "400", ...) into a CanvasTexture. Wider
 * than tall to fit 3-4 digits in IBM Plex Mono.
 */
function makeDepthLabelTexture(text: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 80;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 80);
  ctx.fillStyle = '#a8a8a0';
  ctx.font = '500 56px "IBM Plex Mono", "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 44);
  const tex = new CanvasTexture(canvas);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  return tex;
}

/**
 * Faint horizontal rings every 100 depth units down through the corridor —
 * the player's only "ruler" against the void. Big change from the v1 grid:
 *
 * - Each ring's vertices are displaced by a per-ring pulse profile so the
 *   silhouette wiggles like an ECG trace (mostly flat with sharp narrow
 *   spikes). Generated once at mount and baked into the BufferGeometry.
 *
 * - ~30% of rings are broken arcs (40–80% of a full circle) at random
 *   start angles, ~14% are skipped entirely. Radii vary 5.5–8.0; centers
 *   are slightly off-axis (±1.5 x, ±1 z); each ring carries a small
 *   ±~6° tilt around X and Z so they don't all lie on the same horizontal
 *   plane.
 *
 * - Every 2nd ring is an "accent" — slightly more visible plus a depth
 *   label sprite ("200", "400", ...) pinned just outside its right side,
 *   so the player has a literal sense of how deep they've gone.
 *
 * - Brightness halved overall vs. v1: base #4a463f / opacity 0.10 (was
 *   0.18), accent #7a8a98 / opacity 0.18 (was 0.32). Rings now "emerge
 *   from the fog" rather than stand out in front of it.
 *
 * Cost: ~9-10 mesh draw calls (after misses) + ~5 sprites. Each torus has
 * 240×4 = 960 vertices — total geometry well under 10k vertices for the
 * whole layer.
 */
function DepthRings() {
  type RingSpec = {
    y: number;
    cx: number;
    cz: number;
    radius: number;
    arc: number; // 1.0 for full ring; 0.4-0.8 when broken
    tiltX: number;
    tiltZ: number;
    arcRotY: number; // world Y rotation that decides where a broken arc starts
    accent: boolean;
    label: string | null;
    profile: number[];
  };

  const rings = useMemo<RingSpec[]>(() => {
    const out: RingSpec[] = [];
    for (let i = 1; i <= 11; i++) {
      // ~14% of rings skipped entirely — uneven gaps make the structure
      // feel discovered rather than placed.
      if (Math.random() < 0.14) continue;
      const broken = Math.random() < 0.3;
      const accent = i % 2 === 0; // every 200 ud → 5 accents
      const y = -i * 100;
      out.push({
        y,
        cx: (Math.random() - 0.5) * 3,
        cz: -6 + (Math.random() - 0.5) * 2,
        radius: 5.5 + Math.random() * 2.5,
        arc: broken ? 0.4 + Math.random() * 0.4 : 1.0,
        tiltX: (Math.random() - 0.5) * 0.2, // ±~5.7°
        tiltZ: (Math.random() - 0.5) * 0.2,
        arcRotY: Math.random() * Math.PI * 2,
        accent,
        label: accent ? `${i * 100}` : null,
        profile: generatePulseProfile(240),
      });
    }
    return out;
  }, []);

  // Build one TorusGeometry per ring with the pulse profile baked in. Done
  // in a single useMemo so we control disposal explicitly.
  const geometries = useMemo<TorusGeometry[]>(() => {
    return rings.map((r) => {
      // tubularSegments=240 gives ~1.5° resolution — fine enough that the
      // pulse spikes look sharp. radialSegments=4 because the tube is so
      // thin (0.03) that cross-section detail is invisible.
      const geo = new TorusGeometry(
        r.radius,
        0.03,
        4,
        240,
        Math.PI * 2 * r.arc,
      );
      applyPulseToTorus(geo, r.profile);
      return geo;
    });
  }, [rings]);

  // Cache CanvasTextures for the labels (one per unique label string).
  const labelTextures = useMemo(() => {
    const map = new Map<string, CanvasTexture>();
    for (const r of rings) {
      if (r.label && !map.has(r.label)) {
        map.set(r.label, makeDepthLabelTexture(r.label));
      }
    }
    return map;
  }, [rings]);

  // Dispose GPU resources on unmount.
  useEffect(() => {
    return () => {
      geometries.forEach((g) => g.dispose());
      labelTextures.forEach((t) => t.dispose());
    };
  }, [geometries, labelTextures]);

  return (
    <group>
      {rings.map((r, i) => (
        <group key={r.y} position={[r.cx, r.y, r.cz]}>
          {/* Inner group composes: rotate around world Y to set arc start
              position, then add small X/Z tilts. The leaf mesh's
              [PI/2, 0, 0] rotation flips the torus from XY plane to
              horizontal. */}
          <group rotation={[r.tiltX, r.arcRotY, r.tiltZ]}>
            <mesh rotation={[Math.PI / 2, 0, 0]} geometry={geometries[i]}>
              <meshBasicMaterial
                color={r.accent ? '#7a8a98' : '#4a463f'}
                transparent
                opacity={r.accent ? 0.18 : 0.1}
                depthWrite={false}
              />
            </mesh>
          </group>
          {/* Depth label — sits just past the ring's right side at its own
              y level. Sprites always face the camera so it's readable from
              any descent angle. Position is in the un-tilted outer group so
              labels stay on a clean vertical column. */}
          {r.label && labelTextures.get(r.label) && (
            <sprite
              position={[r.radius + 1.4, 0, 0]}
              scale={[1.6, 0.5, 1]}
            >
              <spriteMaterial
                map={labelTextures.get(r.label)}
                transparent
                opacity={0.35}
                depthWrite={false}
              />
            </sprite>
          )}
        </group>
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
