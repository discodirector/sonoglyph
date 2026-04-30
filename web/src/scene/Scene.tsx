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
 *
 * Pitch: lookAt (0, -9.2, -10) → atan2(9.2, 10) ≈ 42.6° below horizon.
 * Combined with 70° vertical FOV the frustum sweeps from -77.6° to -7.6°,
 * so most of what's rendered is *below* the camera — the rings, dust, and
 * glyph stream all sit in the productive part of the frame as we fall
 * past them, which sells the descent better than a near-horizontal gaze.
 */
function DescentCamera() {
  const camera = useThree((s) => s.camera);
  const phase = useSession((s) => s.phase);
  const setDepth = useSession((s) => s.setDepth);

  useEffect(() => {
    camera.position.set(0, 0, 0);
    camera.lookAt(0, -9.2, -10);
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
 * Living depth rings — each ring is a perfect torus at rest, but its vertex
 * positions are recomputed every frame as the sum of a small pool of active
 * "pulse events" that randomly spawn, peak, and decay. Reads as a calm
 * circle that occasionally spikes outward (or briefly dips inward) at random
 * spots, like an ECG trace bent into a loop.
 *
 * Architecture per ring:
 *   - Geometry is a TorusGeometry built once at mount (the canonical "rest"
 *     shape). We cache its base xy positions, base radii, and base angles
 *     into Float32Arrays so the per-frame loop never calls atan2 / sqrt.
 *   - A pool of `RingEvent`s tracks currently-active spikes: each has a
 *     birth/peak/end time, a target angle, an amplitude (signed), and a
 *     spatial half-width. Time envelope is asymmetric — fast rise, slower
 *     fall — to look like a heartbeat blip rather than a sine wobble.
 *   - Each frame: cull events whose `end < now`, spawn fresh events when
 *     the ring's `nextSpawnAt` clock fires, then for every vertex sum the
 *     contribution of every active event and write the displaced position
 *     directly into the underlying Float32Array (faster than .setX/.setY).
 *
 * Spawn cadence is ring-class-aware: accent rings fire ~every 0.8-2.5s,
 * non-accent rings ~every 1.5-4.0s. With ~9 rings active that gives ~3
 * pops per second across the whole shaft — present enough to feel alive,
 * sparse enough to read as deliberate.
 *
 * Structure: rings spaced every 50 ud down to -1100 (22 slots, ~14%
 * skipped → ~19 rings active), accent every 4th ring so labels still
 * land on clean 200-multiples (200, 400, 600, 800, 1000). Centers sit
 * ~4.5 ud forward of the camera (cz ≈ -4.5, cx ≈ 0) — close enough
 * that the camera (always at x=0, z=0) stays inside each ring's
 * interior with comfortable margin (min radius 5.5 vs. max distance
 * ~5.0), but far enough that the bulk of the ring sits in front of the
 * camera in the FOV — the eye reads each pass as "we fell through that"
 * rather than "that materialized around us". ~30% partial arcs, slight
 * per-ring tilt + radius variation, dim palette so rings emerge from
 * the fog rather than stand out.
 *
 * Cost: ~19 rings × 240 vertices × ~3 active events ≈ 14k Gaussian
 * evals per frame; ~55 KB position-buffer upload / 60 Hz.
 */
function DepthRings() {
  type RingSpec = {
    y: number;
    cx: number;
    cz: number;
    radius: number;
    arc: number; // 1.0 full circle; 0.4-0.8 when broken
    tiltX: number;
    tiltZ: number;
    arcRotY: number;
    accent: boolean;
    label: string | null;
  };

  type RingEvent = {
    birth: number;
    peak: number;
    end: number;
    angle: number; // radians, in geometry's local frame (0..arc*2π)
    amplitude: number; // signed peak displacement (positive = outward)
    width: number; // angular half-width (radians)
  };

  type RingRuntime = {
    geo: TorusGeometry;
    N: number;
    baseX: Float32Array;
    baseY: Float32Array;
    baseRadius: Float32Array;
    baseAngle: Float32Array; // -π..π
    events: RingEvent[];
    nextSpawnAt: number; // ms (performance.now timeline)
  };

  const rings = useMemo<RingSpec[]>(() => {
    const out: RingSpec[] = [];
    // 22 slots × 50 ud = 1100 ud total. Accent every 4th ring → labels
    // land on 200, 400, 600, 800, 1000.
    for (let i = 1; i <= 22; i++) {
      if (Math.random() < 0.14) continue; // ~14% skipped
      const broken = Math.random() < 0.3;
      const accent = i % 4 === 0;
      out.push({
        y: -i * 50,
        // Ring center sits ~4.5 ud forward of the camera path. Math:
        // distance from camera (0, y, 0) to (cx, ringY, cz) at the moment
        // of crossing = √(cx² + cz²). With cz ∈ [-4.9, -4.1] and cx ∈
        // [-0.75, 0.75], distance ∈ [4.1, 4.96]. Min ring radius is 5.5,
        // so the camera is always inside the ring's circle with ≥0.54 ud
        // margin (more than enough to absorb tilt error). Putting the
        // ring forward instead of centered on the camera restores the
        // "falling-through-a-hoop" feel — most of the ring's geometry
        // ends up in the forward FOV cone rather than wrapping around
        // the camera's flanks where it can't be seen.
        cx: (Math.random() - 0.5) * 1.5,
        cz: -4.5 + (Math.random() - 0.5) * 0.8,
        radius: 5.5 + Math.random() * 2.5,
        arc: broken ? 0.4 + Math.random() * 0.4 : 1.0,
        tiltX: (Math.random() - 0.5) * 0.2,
        tiltZ: (Math.random() - 0.5) * 0.2,
        arcRotY: Math.random() * Math.PI * 2,
        accent,
        label: accent ? `${i * 50}` : null,
      });
    }
    return out;
  }, []);

  // Per-ring runtime: geometry + cached base data + event pool. Built once
  // when `rings` settles and reused across renders.
  const runtimes = useMemo<RingRuntime[]>(() => {
    return rings.map((r) => {
      // tubularSegments=240 → ~1.5° per segment; sharp enough for fast
      // spikes to read crisp without running up the vertex count.
      const geo = new TorusGeometry(
        r.radius,
        0.03,
        4,
        240,
        Math.PI * 2 * r.arc,
      );
      const pos = geo.attributes.position;
      const N = pos.count;
      const baseX = new Float32Array(N);
      const baseY = new Float32Array(N);
      const baseRadius = new Float32Array(N);
      const baseAngle = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        baseX[i] = x;
        baseY[i] = y;
        baseRadius[i] = Math.sqrt(x * x + y * y);
        baseAngle[i] = Math.atan2(y, x);
      }
      return {
        geo,
        N,
        baseX,
        baseY,
        baseRadius,
        baseAngle,
        events: [],
        // Stagger initial spawn across rings so they don't all pop in
        // unison on the first frame.
        nextSpawnAt: 0,
      };
    });
  }, [rings]);

  // Initialize spawn clocks once we know `performance.now()` at mount.
  useEffect(() => {
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    runtimes.forEach((rt, i) => {
      const stagger = (rings[i].accent ? 1500 : 2500) * Math.random();
      rt.nextSpawnAt = now + stagger;
    });
  }, [runtimes, rings]);

  // Per-frame: evolve events and rewrite vertex buffers.
  useFrame(() => {
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();

    for (let r = 0; r < runtimes.length; r++) {
      const rt = runtimes[r];
      const spec = rings[r];

      // 1. Cull expired events (in-place compaction; no allocation).
      let writeIdx = 0;
      for (let i = 0; i < rt.events.length; i++) {
        if (now < rt.events[i].end) {
          if (writeIdx !== i) rt.events[writeIdx] = rt.events[i];
          writeIdx++;
        }
      }
      rt.events.length = writeIdx;

      // 2. Spawn fresh events. Loop because a long frame could have skipped
      //    multiple spawn windows.
      while (now >= rt.nextSpawnAt) {
        const spawnAt = rt.nextSpawnAt;
        // 88% outward spike, 12% inward dip — keeps the dominant shape
        // "blipping outward" while occasional dips give variety.
        const isOutward = Math.random() < 0.88;
        const amplitude =
          (isOutward ? 1 : -1) * (0.32 + Math.random() * 0.55);
        const rise = 70 + Math.random() * 130; // 70-200 ms
        const decay = 380 + Math.random() * 620; // 380-1000 ms
        rt.events.push({
          birth: spawnAt,
          peak: spawnAt + rise,
          end: spawnAt + rise + decay,
          angle: Math.random() * Math.PI * 2 * spec.arc,
          amplitude,
          width: 0.04 + Math.random() * 0.04, // 2.3°-4.6°
        });
        const minGap = spec.accent ? 800 : 1500;
        const maxGap = spec.accent ? 2500 : 4000;
        rt.nextSpawnAt = spawnAt + minGap + Math.random() * (maxGap - minGap);
      }

      // 3. Recompute vertex positions: base + sum-of-active-event displacements.
      const pos = rt.geo.attributes.position;
      const arr = pos.array as Float32Array;
      const N = rt.N;
      const events = rt.events;
      const eventCount = events.length;
      const PI2 = Math.PI * 2;

      for (let i = 0; i < N; i++) {
        const a = rt.baseAngle[i];
        let disp = 0;
        for (let e = 0; e < eventCount; e++) {
          const ev = events[e];
          // Time envelope (asymmetric: linear rise 0..1, linear decay 1..0).
          let env: number;
          if (now < ev.peak) {
            env = (now - ev.birth) / (ev.peak - ev.birth);
          } else {
            env = 1 - (now - ev.peak) / (ev.end - ev.peak);
          }
          if (env <= 0) continue;
          // Spatial Gaussian with angular wrap.
          let d = a - ev.angle;
          if (d > Math.PI) d -= PI2;
          else if (d < -Math.PI) d += PI2;
          const sigma = ev.width;
          // Skip vertices outside the spike's footprint — saves the exp().
          if (d > sigma * 4 || d < -sigma * 4) continue;
          disp += ev.amplitude * env * Math.exp(-(d * d) / (2 * sigma * sigma));
        }
        const r0 = rt.baseRadius[i];
        if (r0 > 1e-6) {
          const factor = (r0 + disp) / r0;
          // Direct array writes — ~3× faster than pos.setX/.setY on tight
          // loops. Vertex layout is [x, y, z, x, y, z, ...].
          arr[i * 3] = rt.baseX[i] * factor;
          arr[i * 3 + 1] = rt.baseY[i] * factor;
        }
      }
      pos.needsUpdate = true;
    }
  });

  // Label textures — one per unique depth string ("200", "400", ...).
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
      runtimes.forEach((rt) => rt.geo.dispose());
      labelTextures.forEach((t) => t.dispose());
    };
  }, [runtimes, labelTextures]);

  return (
    <group>
      {rings.map((r, i) => (
        <group key={r.y} position={[r.cx, r.y, r.cz]}>
          <group rotation={[r.tiltX, r.arcRotY, r.tiltZ]}>
            <mesh rotation={[Math.PI / 2, 0, 0]} geometry={runtimes[i].geo}>
              <meshBasicMaterial
                color={r.accent ? '#7a8a98' : '#4a463f'}
                transparent
                opacity={r.accent ? 0.18 : 0.1}
                depthWrite={false}
              />
            </mesh>
          </group>
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

      {/* Everything below is gated on `phase !== 'intro'`. During pairing
          the player is reading dense instructions in the centre of the
          screen — any background motion (rings, glyph drift, parallax
          dust) competes for attention and degrades readability. The
          Canvas's own clear colour (#050507, set on the <Canvas> style
          prop) provides the pure black void during intro. Once we cut
          to `playing`, the full visual stack mounts at once. */}
      {phase !== 'intro' && (
        <>
          <ambientLight intensity={0.22} />
          <pointLight position={[0, 0, 0]} intensity={0.6} distance={24} decay={2} />

          <DepthMarkers />
          <ParallaxDust />
          <DepthRings />
          <GlyphStream />

          {layers.map((l) => (
            <LayerOrb key={l.id} layer={l} />
          ))}
        </>
      )}

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
