import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  ExtrudeGeometry,
  type Group,
  type InstancedMesh,
  type Mesh,
  Object3D,
  PlaneGeometry,
  type Points,
  Shape,
} from 'three';
import type { LayerType, PlacedLayer } from '../state/useSession';

/**
 * Visual stand-in for a sound layer.
 *
 * Most types render as a single mesh whose geometry + material + per-frame
 * animation are all keyed off `layer.type`. Three types break out of that
 * pattern because their visual identity demands more than one drawcall:
 *
 *   - `texture` — a slightly bumpy plane with ~38 small three-sided
 *     pyramids (cones with radialSegments=3) protruding along its
 *     normal. The plane itself has flat-shaded random Z-displacement so
 *     it reads as a mineral surface; the pyramids look like crystals
 *     erupting through it. Whole group oscillates so the relief is seen
 *     from a changing angle. Per-spike phase + occasional sharp twitches
 *     give it the same kind of jittery noise vocabulary as glitch/bell.
 *
 *   - `pulse` — a wide outer ring + an extruded heart at its centre.
 *     The heart pulses with a lub-dub heartbeat synced loosely to the
 *     audio loop's cadence; the outer ring breathes very gently around it.
 *     A torus-knot was geometrically interesting but read as decoration,
 *     not rhythm.
 *
 *   - `breath` — a particle cone that emits from a point and expands
 *     outward along +Y. Each particle ages from 0 → lifespan; position =
 *     direction × speed × age. Particles respawn at age=0 (back at the
 *     source) so the cone looks continuous. Reads instantly as "exhale".
 *
 * The dispatch happens at LayerOrb top level so neither special case
 * pollutes the SingleOrb code path or the shared animateByType switch.
 */
export function LayerOrb({ layer }: { layer: PlacedLayer }) {
  if (layer.type === 'texture') return <TextureSurface layer={layer} />;
  if (layer.type === 'pulse') return <PulseHeart layer={layer} />;
  if (layer.type === 'breath') return <BreathCone layer={layer} />;
  return <SingleOrb layer={layer} />;
}

// ---------------------------------------------------------------------------
// Shared per-type palette — emissive/color/intensity. Used by SingleOrb's
// Material AND by the three custom components so all render paths stay in
// sync (and match the HUD presetColors map in Hud.tsx).
// ---------------------------------------------------------------------------
const PALETTE: Record<
  LayerType,
  { emissive: string; color: string; intensity: number }
> = {
  drone: { emissive: '#8aa1b3', color: '#0e1820', intensity: 0.7 },
  texture: { emissive: '#aab0a8', color: '#1a1c1d', intensity: 0.6 },
  pulse: { emissive: '#c9885b', color: '#1f1410', intensity: 0.95 },
  glitch: { emissive: '#7be0d4', color: '#062322', intensity: 1.0 },
  breath: { emissive: '#d4a098', color: '#1f1413', intensity: 0.55 },
  bell: { emissive: '#e8c97a', color: '#1f1808', intensity: 1.1 },
  drip: { emissive: '#7eb6d6', color: '#0a1420', intensity: 0.75 },
  swell: { emissive: '#9f7eb8', color: '#150a1c', intensity: 0.5 },
  chord: { emissive: '#d4c8a8', color: '#1c1a14', intensity: 0.65 },
};

// ---------------------------------------------------------------------------
// SingleOrb — covers 6 of 9 types: drone, glitch, bell, drip, swell, chord.
// (texture, pulse, breath have their own components.)
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
    case 'drone':
      // Dodecahedron — heavier than the prior icosahedron, twelve pentagonal
      // faces read as "geological boulder" rather than "generic die".
      return <dodecahedronGeometry args={[0.62, 0]} />;
    // texture / pulse / breath — unreachable. LayerOrb dispatches them to
    // their own components before SingleOrb mounts. Fallback geometries
    // exist only to satisfy the exhaustive switch.
    case 'texture':
      return <sphereGeometry args={[0.5, 8, 8]} />;
    case 'pulse':
      return <torusGeometry args={[0.4, 0.05, 8, 24]} />;
    case 'breath':
      return <capsuleGeometry args={[0.32, 0.55, 4, 12]} />;
    case 'glitch':
      return <tetrahedronGeometry args={[0.5, 0]} />;
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
      // Slow, deep breath. Period 8s, scale oscillates 0.90↔1.05. NO
      // rotation — drone is a stationary mass, not an active object.
      const breathe = 0.975 + Math.sin((t * Math.PI) / 4) * 0.075;
      mesh.scale.setScalar(breathe);
      return;
    }
    case 'texture':
    case 'pulse':
    case 'breath':
      // Handled by their own components.
      return;
    case 'glitch': {
      if (Math.random() < 0.04) {
        mesh.rotation.x += (Math.random() - 0.5) * 0.6;
        mesh.rotation.y += (Math.random() - 0.5) * 0.6;
      }
      const flicker = Math.random() < 0.06 ? 1.18 : 0.95;
      mesh.scale.setScalar(flicker);
      return;
    }
    case 'bell': {
      mesh.rotation.y += 0.004;
      mesh.rotation.z += 0.001;
      const shimmer = 0.96 + Math.sin(t * 1.4) * 0.04;
      mesh.scale.setScalar(shimmer);
      return;
    }
    case 'drip': {
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
      const wave = 0.85 + Math.sin(t * 0.6) * 0.25;
      mesh.scale.setScalar(wave);
      mesh.rotation.x = Math.sin(t * 0.25) * 0.4;
      mesh.rotation.y += 0.0015;
      return;
    }
    case 'chord': {
      const breathe = 0.92 + Math.sin(t * 0.35) * 0.06;
      mesh.scale.setScalar(breathe);
      mesh.rotation.x += 0.002;
      mesh.rotation.y += 0.0035;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// TEXTURE — bumpy plane with triangular spikes.
//
// Two pieces share one parent group:
//
//   1. A 16×16-subdivided plane (0.85×0.85 units) whose vertex Z values
//      have been jittered ±0.012. Combined with `flatShading`, every
//      triangle on the plane catches light at a slightly different angle
//      — the surface reads as faceted/rough, like crinkled foil or
//      mineral schist. The displacement is small enough that the silhouette
//      stays planar; the texture lives in the lighting, not in the outline.
//
//   2. 38 instanced cones with `radialSegments=3` (= triangular pyramids)
//      protruding from the plane along its +Z normal. Heights randomized
//      across [0.06, 0.20] so the spikes form a varied skyline rather
//      than a uniform brush. Each pyramid breathes in height with its
//      own phase, and any pyramid has a small chance per frame to "twitch"
//      — height jumps for ~150ms then relaxes. The twitch is the same
//      noise idea as glitch's 4% snap, dialed down to ~0.6% so the
//      surface mostly looks calm with occasional sparks.
//
// The whole group oscillates ±0.4 rad on X/Y on slow sine waves so the
// camera never sees the plane straight-on for long; the changing angle
// is what makes the spike profile readable.
// ---------------------------------------------------------------------------

// Sized to roughly match the visual footprint of the other layer types
// when the camera is ~12-20 units away. Earlier 0.85 squares read as
// "small grey patches" at typical descent distances.
const TEXTURE_PLANE_SIZE = 1.7;
const TEXTURE_PLANE_SUBDIV = 20;
// Fewer but individually larger spikes — at 38 small spikes on a 1.7-square
// plane the silhouette read as static fuzz; at 28 chunky spikes you can
// actually count each triangular crystal poking through the surface.
const TEXTURE_SPIKE_COUNT = 28;
const TEXTURE_SPIKE_BASE_HEIGHT = 0.42; // geometry height before per-instance scale

interface TextureSpike {
  x: number;
  y: number;
  /** Per-instance height multiplier in [0.4, 1.0]; varies the skyline. */
  heightBase: number;
  /** Z-axis spin (around the spike's own axis, after rotating it upright). */
  rotZ: number;
  /** Phase offset for the breathing animation so spikes don't pulse in unison. */
  phase: number;
  /** Twitch state — when set, spike's height is boosted until this time. */
  twitchUntil: number;
  twitchAmount: number;
}

function TextureSurface({ layer }: { layer: PlacedLayer }) {
  const groupRef = useRef<Group>(null);
  const spikesRef = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);

  // Bumpy plane — built once per layer. PlaneGeometry has its vertices on
  // a regular grid; we displace each Z by a small random amount and let
  // flatShading on the material expose the resulting micro-relief.
  const planeGeom = useMemo(() => {
    const g = new PlaneGeometry(
      TEXTURE_PLANE_SIZE,
      TEXTURE_PLANE_SIZE,
      TEXTURE_PLANE_SUBDIV,
      TEXTURE_PLANE_SUBDIV,
    );
    const pos = g.attributes.position;
    // Displacement scaled with plane size so the relative bumpiness stays
    // consistent if the size is tuned later.
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, (Math.random() - 0.5) * 0.05);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id]);

  const spikes = useMemo<TextureSpike[]>(() => {
    return Array.from({ length: TEXTURE_SPIKE_COUNT }, () => ({
      // Keep 4% margin from the plane edge so spikes don't poke past it.
      x: (Math.random() - 0.5) * TEXTURE_PLANE_SIZE * 0.92,
      y: (Math.random() - 0.5) * TEXTURE_PLANE_SIZE * 0.92,
      // Wider range than the prior cloud — mix of stubby and tall spikes
      // is what makes the silhouette interesting.
      heightBase: 0.4 + Math.random() * 1.0,
      rotZ: Math.random() * Math.PI * 2,
      phase: Math.random() * Math.PI * 2,
      twitchUntil: 0,
      twitchAmount: 0,
    }));
  }, [layer.id]);

  useFrame((s) => {
    const t = s.clock.elapsedTime;

    // Slow oscillating tilt — heavily biased so the plane is mostly seen
    // at a steep angle. At rotation.x ≈ -0.7 rad (~40°) the plane is
    // almost a parallelogram in screen space and the spikes silhouette
    // crisply against the void above. Going more horizontal would make
    // the spikes brighter against negative space but the plane itself
    // loses readability; -0.7±0.4 keeps both visible.
    if (groupRef.current) {
      groupRef.current.rotation.x = -0.7 + Math.sin(t * 0.18) * 0.4;
      groupRef.current.rotation.y = Math.sin(t * 0.13) * 0.55;
    }

    if (!spikesRef.current) return;

    for (let i = 0; i < TEXTURE_SPIKE_COUNT; i++) {
      const sp = spikes[i];
      // Roll a twitch — rare sharp jump that decays over ~150ms.
      if (Math.random() < 0.006 && t > sp.twitchUntil) {
        sp.twitchUntil = t + 0.15;
        sp.twitchAmount = 0.4 + Math.random() * 0.6;
      }
      let twitchBoost = 0;
      if (t < sp.twitchUntil) {
        twitchBoost = sp.twitchAmount * (sp.twitchUntil - t) / 0.15;
      }
      // Smooth breathing wave + rare twitch boost.
      const breathe = 0.7 + Math.sin(t * 1.0 + sp.phase) * 0.3;
      const heightMul = sp.heightBase * (breathe + twitchBoost);
      const halfH = (TEXTURE_SPIKE_BASE_HEIGHT * heightMul) / 2;

      // Cone default axis is +Y. Rx(+PI/2) sends apex to +Z (toward camera
      // through the plane normal); the Z rotation just spins the pyramid
      // around its own axis so the three triangular faces are oriented
      // differently per instance (3-fold symmetry means rotZ ∈ [0, 2π/3)
      // is enough but using full 2π is harmless).
      dummy.position.set(sp.x, sp.y, halfH);
      dummy.rotation.set(Math.PI / 2, 0, sp.rotZ);
      dummy.scale.set(1, heightMul, 1);
      dummy.updateMatrix();
      spikesRef.current.setMatrixAt(i, dummy.matrix);
    }
    spikesRef.current.instanceMatrix.needsUpdate = true;
  });

  const p = PALETTE.texture;

  return (
    <group ref={groupRef} position={layer.position}>
      <mesh geometry={planeGeom}>
        <meshStandardMaterial
          emissive={p.emissive}
          emissiveIntensity={p.intensity * 0.55}
          color={p.color}
          roughness={0.7}
          metalness={0.1}
          flatShading
        />
      </mesh>
      <instancedMesh
        ref={spikesRef}
        args={[undefined, undefined, TEXTURE_SPIKE_COUNT]}
      >
        {/* radialSegments=3 → triangular pyramid (3 lateral triangles + base).
            Wider base radius (0.09) makes each face of the pyramid large
            enough to read at descent distances. */}
        <coneGeometry args={[0.09, TEXTURE_SPIKE_BASE_HEIGHT, 3]} />
        <meshStandardMaterial
          emissive={p.emissive}
          emissiveIntensity={p.intensity * 1.5}
          color={p.color}
          roughness={0.4}
          metalness={0.3}
          flatShading
        />
      </instancedMesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// PULSE — wide outer ring + heartbeating heart.
//
// The outer ring (radius 0.85, very thin) breathes gently — barely 5%
// scale variation over a slow 6-sec cycle, so it acts as an arena that
// frames the heart inside. The heart is a small extruded shape (~0.4
// across), pumped by an explicit lub-dub envelope: a strong "lub" beat
// at phase 0.0–0.2 of each ~1s cycle, a smaller "dub" at 0.2–0.4, then
// flat. This is the unmistakable two-stage cardiac rhythm — much more
// readable than a smooth sine pulse.
//
// The whole group rotates very slowly on Z so the composition stays
// alive between beats but the heart's orientation never strays far from
// upright.
// ---------------------------------------------------------------------------
function makeHeartShape(): Shape {
  const s = new Shape();
  // Heart drawn in a normalized box, cleft up at +Y, point down at -Y.
  // Curve coordinates from the canonical Three.js heart example.
  s.moveTo(0, 0);
  s.bezierCurveTo(0, 0, -0.5, -0.4, -1, 0);
  s.bezierCurveTo(-1.5, 0.4, -0.5, 1, 0, 1.5);
  s.bezierCurveTo(0.5, 1, 1.5, 0.4, 1, 0);
  s.bezierCurveTo(0.5, -0.4, 0, 0, 0, 0);
  return s;
}

function PulseHeart({ layer }: { layer: PlacedLayer }) {
  const groupRef = useRef<Group>(null);
  const heartRef = useRef<Mesh>(null);
  const outerRef = useRef<Mesh>(null);

  // Build the extruded heart geometry once per layer. We center the geom
  // on its bounding box so the heart pivots around its visual middle, not
  // around the shape's drawing origin (which sits on the bottom point).
  const heartGeom = useMemo(() => {
    const g = new ExtrudeGeometry(makeHeartShape(), {
      depth: 0.08,
      bevelEnabled: false,
      curveSegments: 16,
    });
    g.scale(0.22, -0.22, 0.22); // negative Y flips so cleft is up to camera
    g.center();
    return g;
  }, []);

  useFrame((s) => {
    const t = s.clock.elapsedTime;

    // Outer ring — very gentle breathing so it doesn't compete with the
    // heart's beat. Period 6s, amplitude 0.05.
    if (outerRef.current) {
      const breathe = 1 + Math.sin(t * 1.05) * 0.05;
      outerRef.current.scale.setScalar(breathe);
    }

    // Heart — explicit lub-dub envelope. Period 1.0s, two distinct beats.
    if (heartRef.current) {
      const phase = t % 1.0;
      let beat = 0;
      if (phase < 0.08) {
        // Lub up
        beat = (phase / 0.08) * 0.45;
      } else if (phase < 0.18) {
        // Lub down
        beat = 0.45 - ((phase - 0.08) / 0.1) * 0.42;
      } else if (phase < 0.28) {
        // Dub up (smaller)
        beat = 0.03 + ((phase - 0.18) / 0.1) * 0.27;
      } else if (phase < 0.42) {
        // Dub down
        beat = 0.3 - ((phase - 0.28) / 0.14) * 0.3;
      }
      // else flat at 0
      heartRef.current.scale.setScalar(1 + beat);
    }

    if (groupRef.current) {
      groupRef.current.rotation.z += 0.0012;
    }
  });

  const p = PALETTE.pulse;

  return (
    <group ref={groupRef} position={layer.position}>
      {/* Outer ring — thin, wide, frames the heart */}
      <mesh ref={outerRef}>
        <torusGeometry args={[0.85, 0.025, 8, 48]} />
        <meshStandardMaterial
          emissive={p.emissive}
          emissiveIntensity={p.intensity * 0.7}
          color={p.color}
          roughness={0.6}
          metalness={0.4}
        />
      </mesh>
      {/* Heart — extruded shape, pulses with explicit lub-dub */}
      <mesh ref={heartRef} geometry={heartGeom}>
        <meshStandardMaterial
          emissive={p.emissive}
          emissiveIntensity={p.intensity * 1.15}
          color={p.color}
          roughness={0.5}
          metalness={0.5}
        />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// BREATH — conical particle emission.
//
// 60 particles. Each has a fixed direction (within a 35° cone around +Y),
// a fixed speed (0.25–0.6 u/s), and a cyclic age that runs 0 → lifespan
// → 0. Position = direction × speed × age, so at age=0 the particle is at
// the source (tightly clustered with its neighbours) and at age=lifespan
// it's at the cone's far edge (well separated from them). Particles
// respawn back at the source so the cone looks continuously emitting.
//
// Initial ages are staggered across [0, lifespan) so the cone is fully
// populated from frame zero rather than starting empty and filling.
//
// Rendered as <points> with toneMapped=false so the rose colour pops on
// the dark background.
// ---------------------------------------------------------------------------
const BREATH_PARTICLE_COUNT = 60;

interface BreathParticle {
  dir: [number, number, number];
  speed: number;
  lifespan: number;
  age: number;
}

function BreathCone({ layer }: { layer: PlacedLayer }) {
  const ref = useRef<Points>(null);

  const particles = useMemo<BreathParticle[]>(() => {
    const halfAngle = (Math.PI * 35) / 180;
    return Array.from({ length: BREATH_PARTICLE_COUNT }, () => {
      // Uniform sample within a cone around +Y. cosTheta ∈ [cos(halfAngle), 1].
      const phi = Math.random() * Math.PI * 2;
      const cosTheta = 1 - Math.random() * (1 - Math.cos(halfAngle));
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      const lifespan = 2.5 + Math.random() * 1.8;
      return {
        dir: [sinTheta * Math.cos(phi), cosTheta, sinTheta * Math.sin(phi)],
        speed: 0.25 + Math.random() * 0.35,
        lifespan,
        // Stagger initial ages so the cone is populated end-to-end on mount.
        age: Math.random() * lifespan,
      };
    });
  }, [layer.id]);

  // Single mutable Float32Array — we write in place each frame and flag the
  // attribute dirty. Size matches the buffer attached below.
  const positions = useMemo(
    () => new Float32Array(BREATH_PARTICLE_COUNT * 3),
    [],
  );

  useFrame((_, delta) => {
    if (!ref.current) return;
    for (let i = 0; i < BREATH_PARTICLE_COUNT; i++) {
      const p = particles[i];
      p.age += delta;
      if (p.age >= p.lifespan) p.age -= p.lifespan;
      const dist = p.age * p.speed;
      positions[i * 3] = p.dir[0] * dist;
      positions[i * 3 + 1] = p.dir[1] * dist;
      positions[i * 3 + 2] = p.dir[2] * dist;
    }
    const attr = ref.current.geometry.getAttribute('position');
    attr.needsUpdate = true;
  });

  const p = PALETTE.breath;

  return (
    <points ref={ref} position={layer.position}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.06}
        color={p.emissive}
        transparent
        opacity={0.9}
        sizeAttenuation
        toneMapped={false}
      />
    </points>
  );
}
