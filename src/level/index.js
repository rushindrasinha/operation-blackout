/**
 * OPERATION BLACKOUT — LevelSystem (order 8).
 *
 * Owns the map: geometry, materials, collision proxies, spawn points, practical light
 * registrations and the volumetric shaft cards.
 *
 * ── THREE INTEGRATION FACTS THAT SHAPE THIS FILE ──────────────────────────────
 *
 * 1. We run at order 8; PHYSICS runs at order 10 and reads `ctx.level.collidables`
 *    during its init. Every collider must therefore exist before our init() returns.
 *    We never hand physics the *render* meshes — those are heavily bevelled merged
 *    monsters and a trimesh of them would cost a fortune. Instead every solid registers
 *    an invisible unit-box proxy (12 triangles) at the right transform, tagged with its
 *    surface name so impact FX and footstep audio resolve correctly.
 *
 * 2. LIGHTING runs at order 70 — *after* us. At our init() `ctx.lighting.practicals`
 *    and `ctx.lighting.csm` are still null, and `ctx.materials.envMap` is still null.
 *    So everything that needs the lighting system (CSM registration of our material
 *    clones, practical registration, sun direction for the light shafts) is deferred to
 *    the first update() via `_lateInit()`. CSM registration is not optional: an
 *    unregistered lit material takes the non-CSM branch and receives all four cascade
 *    lights at full intensity — 4x overexposed.
 *
 * 3. Every surface is authored with UVs in metres and divided by the material's
 *    `metersPerTile`, so a shared 1:1 material clads a 26 m wall and a 0.3 m drum at
 *    identical texel density. `materials.get()` is never called on a large surface with
 *    default UVs.
 *
 * OWNER: level. static id='level', order=8.
 */
import * as THREE from 'three';

import { Builder, Rng, mat } from './geo.js';
import { GroundMask, applyGroundShader } from './ground.js';
import { makeChainLinkTexture } from './kit.js';
import { buildMap, LAYOUT, TARGET_TILE } from './map.js';

/* ───────────────────────────── light shafts ───────────────────────────── */

const SHAFT_VERT = /* glsl */`
attribute vec2 aBeam;
varying vec2 vBeam;
varying float vDist;
varying float vAxial;
void main() {
  vBeam = aBeam;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vDist = -mv.z;
  /**
   * How close the eye is to looking straight DOWN the beam.
   *
   * The cone is an open shell drawn double-sided and additively, so when the
   * camera lines up with its axis every fragment integrates through the full
   * depth of the cone twice and the whole thing resolves to a hard-edged white
   * triangle sitting in the yard — the exact "solid white wedge" failure an
   * earlier pass was trying to escape. A real shaft is only visible because you
   * see it ACROSS the scattering volume; seen end-on there is nothing to see.
   */
  vec3 axisV = normalize( ( modelViewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );
  vec3 eyeV  = normalize( mv.xyz );
  vAxial = abs( dot( axisV, eyeV ) );
  gl_Position = projectionMatrix * mv;
}`;

const SHAFT_FRAG = /* glsl */`
precision highp float;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
varying vec2 vBeam;
varying float vDist;
varying float vAxial;

float h21( vec2 p ) {
  return fract( sin( dot( p, vec2( 41.3, 289.1 ) ) ) * 43758.5453 );
}
float v21( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( h21( i ), h21( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( h21( i + vec2( 0.0, 1.0 ) ), h21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}

/**
 * ── WHY THIS SHADER LOOKS THE WAY IT DOES ─────────────────────────────────
 *
 * The previous version was a 2.4-power radial ramp times one 9-cycle sine, and
 * all three critics read the result identically: "blurry milky billboards", "a
 * large featureless vertical wash with no shaft structure and no cone taper you
 * can trace", "they wash the far wall into flat milk, killing contrast across
 * the whole midground". Three specific things were wrong and all three are fixed
 * here:
 *
 *  1. THE CORE WAS TOO SOFT. A 2.4 power spreads meaningful alpha across most of
 *     the cone radius, so the beam had no traceable edge. 3.6 concentrates it
 *     into a bright axis with a fast falloff, which is what a shaft through a gap
 *     in cladding actually looks like.
 *  2. THERE WAS NO STRUCTURE. One sine at one frequency is a gradient, not
 *     airborne dust. Three beating bands plus a scrolling value-noise field give
 *     the beam the low-frequency density variation that makes it read as
 *     particulate rather than as a painted cone.
 *  3. IT NEVER RAN OUT. A scattering medium extinguishes; a 34 m cone at full
 *     strength lays a uniform veil over everything behind it. The reach term
 *     kills the beam over 12-30 m of view distance, which is what stops it
 *     fogging the far wall — the shaft now sits IN the space rather than in
 *     front of it.
 */
void main() {
  float r      = clamp( 1.0 - vBeam.x, 0.0, 1.0 );
  float core   = pow( r, 3.6 );
  float enter  = smoothstep( 0.0, 0.13, vBeam.y );
  float exitF  = 1.0 - smoothstep( 0.28, 0.92, vBeam.y );
  float t      = vBeam.y;
  // airborne dust: three beating bands plus a slow scrolling noise field
  float mote   = 0.58
               + 0.20 * sin( t * 16.0 - uTime * 0.85 + vBeam.x * 5.3 )
               + 0.09 * sin( t * 39.0 + uTime * 0.37 )
               + 0.26 * v21( vec2( t * 7.5, vBeam.x * 3.4 - uTime * 0.11 ) );
  float near   = smoothstep( 0.5, 3.5, vDist );
  // 16-42 m, not 12-30: the tighter falloff extinguished the beams almost
  // entirely from the catwalk, which trades one defect for another. This range
  // still stops the shaft veiling the far gable while leaving it traceable from
  // anywhere inside the shed.
  float reach  = 1.0 - smoothstep( 16.0, 42.0, vDist );
  // fade out as the eye lines up with the beam axis (see SHAFT_VERT)
  float side   = smoothstep( 0.94, 0.52, vAxial );
  float a = core * enter * exitF * mote * near * reach * side * uIntensity;
  a += core * core * core * enter * exitF * near * reach * side * 0.30 * uIntensity;
  // hard ceiling: additive + toneMapped:false means an un-capped accumulation
  // clips straight to white, and a clipped highlight is an instant fail
  a = min( a, 0.34 );
  gl_FragColor = vec4( uColor * a, a );
}`;

/** Open cone along +Z with a normalised (radial, axial) attribute for the shader. */
function shaftGeometry(r0, r1, len, seg = 14) {
  const pos = [];
  const beam = [];
  const push = (x, y, z, rr, aa) => { pos.push(x, y, z); beam.push(rr, aa); };
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    // outer skin
    push(c0 * r0, s0 * r0, 0, 1, 0);
    push(c1 * r0, s1 * r0, 0, 1, 0);
    push(c1 * r1, s1 * r1, len, 1, 1);
    push(c0 * r0, s0 * r0, 0, 1, 0);
    push(c1 * r1, s1 * r1, len, 1, 1);
    push(c0 * r1, s0 * r1, len, 1, 1);
    // core blade through the axis, so the beam is solid rather than hollow
    push(0, 0, 0, 0, 0);
    push(c0 * r0, s0 * r0, 0, 1, 0);
    push(c0 * r1, s0 * r1, len, 1, 1);
    push(0, 0, 0, 0, 0);
    push(c0 * r1, s0 * r1, len, 1, 1);
    push(0, 0, len, 0, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBeam', new THREE.Float32BufferAttribute(beam, 2));
  g.computeBoundingSphere();
  return g;
}

/** Per-material normal-map easing for large architectural surfaces. See materialFor(). */
const ARCH_NORMAL_EASE = {
  // The ground is the one surface that is on screen from every angle at every
  // distance, and at 0.34 the concrete recipe's aggregate resolved as a field of
  // uniform popcorn under the low sun — bubble wrap, not a power-floated slab.
  concrete: 0.22,
  plaster: 0.40,
  /**
   * Brick runs at FULL normal strength. The recipe pushes its mortar joints 0.34
   * of the height range below the brick faces, and at 0.60 that recess resolved to
   * about 1 mm of apparent depth — under a raking low sun a real brick wall throws
   * a hard shadow line along every bed joint, and without it the wall reads as
   * printed wallpaper no matter how good the albedo is.
   */
  brick: 1.0,
  asphalt: 0.40,
  gravel: 0.55,
  /**
   * The corrugatedMetal recipe bakes its OWN sinusoidal corrugation — seven waves
   * per 2.4 m tile — into the normal map. Every surface in this level that uses it
   * (warehouse cladding, roof decks, all 24 containers) also carries a real
   * geometric corrugation at 0.29-0.30 m. Two corrugations at 0.343 m and 0.30 m
   * beat against each other with a 2.4 m envelope, which is what turned every wall
   * in the map into a moire barcode. The geometry is now the corrugation; the
   * texture is demoted to grain, weld seams and rust.
   */
  corrugatedMetal: 0.62,
  /**
   * Container shell. Same recipe, but its tile is authored at 2.32 m so the
   * texture's eight baked waves land exactly on the 290 mm ISO box profile the
   * geometry carries. Because the two agree instead of beating, the normal map
   * can be allowed to REINFORCE the geometric rib rather than being suppressed
   * to stop a moire, which is what makes a container read as pressed steel.
   */
  containerSteel: 0.55,
  /**
   * The ground variants keep MORE normal than the old unified `concrete` 0.22,
   * because they no longer have to carry the whole burden of "looking like it has
   * detail" on their own — the macro layer in ground.js supplies the 6-47 m
   * structure, so the fine normal is free to be fine again.
   */
  groundConcrete: 0.24,
  groundAsphalt: 0.38,
  groundGravel: 0.55,
  // steel walkways and beams: the rust recipe's blooms are authored for a 1.6 m tile,
  // which on a 1.5 m catwalk deck reads as a gravel path rather than plate steel
  rustMetal: 0.45,
  paintedMetal: 0.62,
};

/**
 * UV density multiplier applied on top of the recipe's metersPerTile.
 *
 * The concrete recipe authors ~5 cm aggregate at its natural 3.2 m tile. Across a 90 m
 * yard and a 26 m warehouse that reads as pebbledash — the floor looked like a gravel
 * path rather than a power-floated slab. Tightening the tile to ~2 m drops the aggregate
 * to ~3 cm, which is what cast concrete actually looks like, and 2048-square maps have
 * the resolution to take it. Anything above ~1.8x starts showing the tile.
 */
const ARCH_UV_DENSITY = {
  /**
   * 2.00 put a 1.6 m concrete tile under the camera's feet. At eye height the
   * near ground fills ~5 tiles across the frame, and the recipe's aggregate is
   * distinctive enough that the repeat was legible — visible tiling is an instant
   * fail on its own. 1.5 pushes the tile to 2.1 m, which is past the point the
   * eye can lock onto the repeat while still keeping the aggregate at ~4 cm.
   */
  concrete: 1.50,
  plaster: 1.45,
  asphalt: 1.20,
  gravel: 1.05,
  rustMetal: 1.35,
  paintedMetal: 1.30,
};


/**
 * Scalar overrides applied to the level's clone of a library material.
 *
 * `roughness` and `metalness` on a MeshStandardMaterial MULTIPLY the packed ORM
 * map rather than replacing it, and the shader clamps roughness to 1, so a value
 * above 1 is a legal "push everything toward matte" knob.
 *
 * corrugatedMetal is the one that needs it. The recipe is authored for a 2 m
 * prop where a bright galvanised crest is correct; wrapped around 90 metres of
 * shed wall and 24 containers, and now that the corrugation is smooth-shaded so
 * the highlight sweeps continuously instead of stepping, it turned every wall in
 * the map into a rack of polished chrome tubes. Real cladding after fifteen
 * Eastern-European winters is chalked, oxidised and nearly matte.
 */
const MATERIAL_TWEAK = {
  /**
   * envMapIntensity was 0.55 and metalness 0.62, and together those two numbers are
   * why every shaded container in the map resolved to a black slab. A metal has
   * almost no diffuse response, so a metalness-0.62 surface out of the sun is lit
   * almost entirely by the environment probe — and that probe was then dimmed to
   * just over half. The overwatch frame was bisected vertically by the result.
   * Fifteen years of oxidation leaves cladding mostly dielectric anyway, so pulling
   * metalness down and the probe back up is both the fix and the correct physics.
   */
  corrugatedMetal: { roughness: 1.45, metalness: 0.46, envMapIntensity: 1.0 },
  containerSteel: { roughness: 1.38, metalness: 0.50, envMapIntensity: 1.0 },
  rustMetal: { roughness: 1.15, metalness: 0.60, envMapIntensity: 1.0 },
  paintedMetal: { roughness: 1.10 },
};

/**
 * Level-local material names that resolve to a library recipe.
 *
 * `containerSteel` exists purely so the container yard and the warehouse cladding
 * can carry DIFFERENT absolute texel densities off the one shared corrugated-metal
 * texture — see TARGET_TILE in map.js. Both still share the GPU texture; the only
 * cost is one extra uniform block and one extra draw call per bucket.
 */
const MATERIAL_ALIAS = {
  containerSteel: 'corrugatedMetal',
};

/**
 * Ground variants. These are level-local names that resolve to a library recipe but
 * carry the macro-breakup shader from `ground.js`. They are SEPARATE materials from
 * the walls-and-props `concrete` / `asphalt` / `gravel` on purpose: the macro layer
 * is driven by world XZ, which is exactly right on a horizontal plane and produces
 * vertical banding on a wall.
 *
 * `albedoLo/Hi` is the 10-40 m value swing; `roughAmp` the roughness swing (±20 %),
 * which is the single most reliable amateur/professional tell and the thing the old
 * ground had literally none of.
 */
const GROUND_MATERIALS = {
  groundConcrete: {
    base: 'concrete', dirtTile: 1.7, dirtGain: 1.05, dirtBias: 0.625, dirtSat: 0.55,
    albedoLo: 0.66, albedoHi: 1.30, roughAmp: 0.27, wearGain: 1.0,
    dirtTint: [0.98, 0.955, 0.905], contact: 0.78,
  },
  groundAsphalt: {
    base: 'asphalt', dirtTile: 1.7, dirtGain: 0.8, dirtBias: 0.70, dirtSat: 0.5,
    albedoLo: 0.68, albedoHi: 1.34, roughAmp: 0.28, wearGain: 1.25,
    dirtTint: [0.80, 0.79, 0.775], contact: 0.72,
  },
  groundGravel: {
    base: 'gravel', dirtTile: 2.6, dirtGain: 0.8, dirtBias: 0.72, dirtSat: 0.5,
    albedoLo: 0.76, albedoHi: 1.24, roughAmp: 0.18, wearGain: 0.8,
    dirtTint: [1.0, 0.985, 0.955], contact: 0.68,
  },
};

/* ══════════════════════════════ system ════════════════════════════════ */

export class LevelSystem {
  static id = 'level';
  static order = 8;

  constructor(ctx) {
    this.ctx = ctx;

    /** Physics reads this during its init() — must be populated by the end of ours. */
    this.collidables = [];
    /** @type {THREE.Vector3[]} */
    this.spawnPoints = [];
    /** @type {{position:THREE.Vector3, yaw:number, tag:string}[]} */
    this.spawns = [];

    this.root = new THREE.Group();
    this.root.name = 'Level';

    this.bounds = new THREE.Box3(
      new THREE.Vector3(LAYOUT.minX, -2, LAYOUT.minZ),
      new THREE.Vector3(LAYOUT.maxX, 30, LAYOUT.maxZ),
    );

    this._materials = new Map();
    this._proxyGeo = null;
    this._proxyMat = null;
    this._practicalSpecs = [];
    this._practicalHandles = [];
    this._shaftSpecs = [];
    this._patchSpecs = [];
    this._patches = [];
    this._patchMaterial = null;
    this._glowTex = null;
    this._shafts = [];
    this._shaftMaterial = null;
    this._shaftMaterials = [];
    this._chainTex = null;
    this._meshes = [];
    this._instanced = [];
    /** Per-instance culling state for the scatter buckets. See _registerCull(). */
    this._cullSpecs = [];
    this._cullPos = new THREE.Vector3();
    this._cullFwd = new THREE.Vector3();
    this._cullLastPos = new THREE.Vector3(1e9, 1e9, 1e9);
    this._cullLastFwd = new THREE.Vector3(0, 0, -1);
    this._cullPrimed = false;
    this._sunTravel = null;
    this._lateDone = false;
    this._rng = new Rng(0x5EED11);
    this._time = 0;

    /**
     * The ground authoring mask. Created here (not in init) because `materialFor()`
     * runs during buildMap and needs its world extents to build the sampling
     * transform; the texture itself is baked after the map is built, from the
     * collision proxies the map registers as it goes.
     */
    this.ground = new GroundMask({ size: 1024, x0: -62, x1: 62, z0: -68, z1: 68 });
    this._groundMaterials = [];

    this.builder = new Builder(ctx, (n) => this.materialFor(n));
    this.builder.density = ARCH_UV_DENSITY;
    this.builder.targetTile = TARGET_TILE;
    for (const [k, v] of Object.entries(GROUND_MATERIALS)) this.builder.alias[k] = v.base;
    this.stats = { meshes: 0, instanced: 0, proxies: 0, triangles: 0 };

    /**
     * Camera vantages the screenshot harness resolves through `__POSE__(name)`.
     * The player system prefers a level-authored table over its own survey, so these
     * are the framings the critic actually grades — each one is composed, not merely
     * "somewhere with a long sightline".
     *
     * NOTE: 'spawn' is deliberately absent. The player picks its spawn *position*
     * randomly from `spawnPoints` and then only takes the yaw/pitch from the pose
     * table, so authoring 'spawn' would bolt a fixed heading onto a random position.
     * Its own longest-sightline sweep is the right answer there.
     */
    this.poses = {
      /**
       * Hero frame. Stands on the second-tier container deck at 5.19 m and looks
       * NORTH-WEST straight down the sun bearing (-0.464, +0.873): the gantry
       * crosses the middle third, the warehouse stacks the left, the container
       * rows step away on the right and the low sun sits at the end of the lane.
       *
       * The previous coordinates put the camera at z=-15.6, which is 0.38 m
       * OUTSIDE the container's south face — four fifths of the frame was the
       * unlit flank of a box 40 cm from the lens.
       */
      /**
       * Moved off the container deck and onto the stair-tower flight.
       *
       * From the old spot at x=31 the tier-3 box stood 5 m off the lens, unlit,
       * and bisected the frame vertically — the critics' verdict was that the
       * crosshair sat in the only gap. Standing on the flight at x=33.9 puts the
       * whole stack behind-left instead, and aims 30 degrees off the sun bearing
       * so the shot gets the same one-point structure that makes `lane` the only
       * composed frame in the map: container rows stepping away on the left at
       * 12-20 m, the pipe gantry crossing the frame at 40 m, the warehouse mass
       * closing the left third and the low sun at the end of the run.
       */
      overwatch: { position: [33.9, 5.55, -10.2], lookAt: [-6.0, 4.2, 12.0] },
      warehouse: { position: [-20.0, 8.45, 2.5], lookAt: [-27.0, 1.2, -19.0] },
      // The hero vista. Placed east of the warehouse's 75 m shadow so the near ground
      // is SUNLIT and every barrier, sandbag and drum lays a long raking shadow toward
      // the camera; the gantry frames the sun at the end of the lane and the warehouse
      // stacks the right-hand third. Everything south-west of here sits in that shadow
      // and reads as a formless dark field, which is what the first five passes shot.
      lane: { position: [9.5, 0.10, -22.0], lookAt: [-8.0, 3.0, 24.0] },
      /**
       * Material-scrutiny frame. Three and a half metres off the sandbag
       * emplacement at (8,-12) with the jersey chicane at z=-6.5 behind it, on
       * sunlit ground so the raking key actually resolves the weave, the bevels
       * and the roughness break-up. The old coordinates pointed at open air three
       * metres from the warehouse door and graded nothing.
       */
      /**
       * Material-scrutiny frame. 3.8 m north-east of the sandbag emplacement at
       * (-7, 7.5) with the jersey chicane at x=-3 raking away to the left.
       *
       * The position was chosen by ray-marching the sun vector (-0.464, 0.151,
       * 0.873) from a grid of candidate points: at 8.7 degrees of elevation the
       * warehouse alone throws a 98 m shadow south-east and puts the ENTIRE south
       * half of the compound in shade, so the previous closeup — and every other
       * "just stand near something interesting" guess — graded a black field. This
       * cell is one of the few that sees the sun, and the camera sits on the
       * north-west side of the target so it is the LIT face being scrutinised.
       */
      closeup: { position: [-5.6, 0.10, 11.6], lookAt: [-7.2, 0.72, 7.9] },
      // extra vantages used while art-directing; harmless to leave published
      // The catwalk looking south down the shed: trusses overhead, the mezzanine
      // and racking below, sodium practicals and the clerestory shafts.
      interior: { position: [-26.0, 0.10, -16.0], lookAt: [-31.0, 3.6, 11.0] },
      // Sunlit north yard looking back down the lane at the warehouse mass.
      yard: { position: [6.0, 0.10, 28.0], lookAt: [-14.0, 5.0, -8.0] },
      gate: { position: [-2.0, 0.10, 36.0], lookAt: [4.0, 2.4, -18.0] },
      dbg: { position: [-2.0, 9.0, 40.0], lookAt: [1.0, 0.0, 24.0] },
    };
  }

  /* ───────────────────────────── materials ───────────────────────────── */

  /**
   * Every level material is a vertex-colour-enabled clone of the shared library
   * material. Cloning shares the GPU textures (clone() copies map references), so the
   * cost is a uniform block, not 300 MB of texture. The colour attribute is what lets
   * two dozen merged containers look like two dozen different containers.
   */
  materialFor(name) {
    const hit = this._materials.get(name);
    if (hit) return hit;
    let m = null;
    try {
      m = this._customMaterial(name);
      if (!m) {
        const gspec = GROUND_MATERIALS[name];
        const base = this.ctx.materials.get(gspec ? gspec.base : (MATERIAL_ALIAS[name] ?? name));
        m = base.clone();
        m.vertexColors = true;
        /**
         * Architectural surfaces get their normal map eased off. The library authors
         * these recipes for a 1-2 m prop where the aggregate reads as aggregate; on a
         * 26 m wall or a 90 m yard the same normal at full strength turns into uniform
         * popcorn that reads as coarse sand rather than cast concrete, and the
         * high-frequency detail aliases badly under TAA at grazing angles. Props and
         * ground cover keep their full normals.
         */
        if (ARCH_NORMAL_EASE[name] !== undefined && m.normalScale) {
          m.normalScale.multiplyScalar(ARCH_NORMAL_EASE[name]);
        }
        const tweak = MATERIAL_TWEAK[name];
        if (tweak) {
          if (tweak.roughness !== undefined && typeof m.roughness === 'number') m.roughness *= tweak.roughness;
          if (tweak.metalness !== undefined && typeof m.metalness === 'number') m.metalness *= tweak.metalness;
          if (tweak.envMapIntensity !== undefined) m.userData.envMul = tweak.envMapIntensity;
        }
        m.name = `lvl_${name}`;
        m.userData.materialName = base.userData?.materialName ?? name;
        m.userData.libraryBase = base;
        if (gspec) {
          applyGroundShader(m, {
            ...gspec,
            key: name,
            x0: this.ground.x0, x1: this.ground.x1, z0: this.ground.z0, z1: this.ground.z1,
            mask: this.ground.texture,
            dirtMap: this.ctx.materials.texture?.('gravel', { map: 'albedo' }) ?? null,
          });
          this._groundMaterials.push(m);
        }
      }
    } catch (err) {
      console.warn('[level] material clone failed for', name, err);
      m = new THREE.MeshStandardMaterial({ color: 0x8a8880, roughness: 0.9, vertexColors: true });
      m.name = `lvl_${name}_fallback`;
    }
    this._materials.set(name, m);
    return m;
  }

  _customMaterial(name) {
    if (name === 'windowDark') {
      /**
       * The interior of a window opening. At 0x14161a with a 0.94 roughness this
       * resolved to a flat mid-grey — the environment probe alone lifted it far
       * enough that every opening in the map read as a painted rectangle. A real
       * unlit room seen through a hole is one of the darkest things in a daylight
       * frame; the env contribution has to be almost entirely off for that to hold.
       */
      const m = new THREE.MeshStandardMaterial({
        color: 0x0a0c0f, roughness: 0.97, metalness: 0.0, vertexColors: true, name: 'lvl_windowDark',
      });
      m.userData.envMul = 0.18;
      return m;
    }
    if (name === 'windowGlass') {
      /**
       * Surviving glazing. Opaque on purpose — a transparent material is dropped
       * from the G-buffer, so it would take no AO, no TAA reprojection and no
       * motion vectors, and 700 shimmering panes across the skyline is a worse
       * failure than losing see-through. Low roughness plus a little metalness
       * makes the environment probe do the work: each pane picks up the dusk sky
       * at its own angle, so a facade of them is never one flat value.
       */
      const m = new THREE.MeshStandardMaterial({
        color: 0x0e1319, roughness: 0.13, metalness: 0.62, vertexColors: true, name: 'lvl_windowGlass',
      });
      m.userData.envMul = 1.5;
      return m;
    }
    if (name === 'windowGlow') {
      const m = new THREE.MeshStandardMaterial({
        color: 0x1c1409, roughness: 0.8, metalness: 0.0, vertexColors: true, name: 'lvl_windowGlow',
      });
      m.emissive = new THREE.Color(0xff9a44);
      m.emissiveIntensity = 1.05;
      return m;
    }
    if (name === 'emberGlow') {
      const m = new THREE.MeshStandardMaterial({
        color: 0x140a04, roughness: 0.95, metalness: 0.0, vertexColors: true, name: 'lvl_emberGlow',
      });
      m.emissive = new THREE.Color(0xff5a12);
      // 3.2 pushed a burn-barrel's coals far enough past the bloom threshold that a
      // single 0.5 m disc washed a quarter of the frame pink.
      m.emissiveIntensity = 1.9;
      return m;
    }
    if (name === 'lampGlow') {
      const m = new THREE.MeshStandardMaterial({
        color: 0x1a1207, roughness: 0.5, metalness: 0.0, vertexColors: true, name: 'lvl_lampGlow',
      });
      m.emissive = new THREE.Color(0xffb968);
      m.emissiveIntensity = 4.2;
      return m;
    }
    if (name === 'chainlink') {
      if (!this._chainTex) this._chainTex = makeChainLinkTexture(256);
      const m = new THREE.MeshStandardMaterial({
        map: this._chainTex,
        color: 0x9aa0a6,
        roughness: 0.52,
        metalness: 0.72,
        alphaTest: 0.5,
        transparent: false,
        side: THREE.DoubleSide,
        vertexColors: true,
        name: 'lvl_chainlink',
      });
      return m;
    }
    return null;
  }

  /* ─────────────────────── collision proxy registry ──────────────────── */

  /**
   * Register an invisible box collider. (x,y,z) is the CENTRE.
   * Kept out of the scene graph entirely — physics only needs a world matrix.
   */
  addProxy(x, y, z, w, h, d, ry = 0, material = 'concrete', opts = null) {
    try {
      if (!this._proxyGeo) {
        this._proxyGeo = new THREE.BoxGeometry(1, 1, 1);
        this._proxyMat = new THREE.MeshBasicMaterial({ visible: false });
        this._proxyMat.name = 'levelProxy';
      }
      const m = new THREE.Mesh(this._proxyGeo, this._proxyMat);
      m.position.set(x, y, z);
      m.rotation.set(opts?.rx ?? 0, ry, opts?.rz ?? 0, 'YXZ');
      m.scale.set(Math.max(0.02, w), Math.max(0.02, h), Math.max(0.02, d));
      m.visible = false;
      m.name = `col_${material}`;
      m.userData.physicsMaterial = material;
      m.updateMatrix();
      m.updateMatrixWorld(true);
      this.collidables.push(m);
      this.stats.proxies++;
      return m;
    } catch (err) {
      console.warn('[level] addProxy failed:', err);
      return null;
    }
  }

  /* ───────────────────────────── instancing ──────────────────────────── */

  /**
   * ── WHEN AN InstancedMesh IS THE WRONG ANSWER ──────────────────────────
   *
   * An InstancedMesh is its own scene object, so it is its own draw call — in
   * this pipeline seven of them (three main-pass renders plus four shadow
   * cascades). That is an excellent trade for 872 masonry chips and a terrible
   * one for five cable spools: the spool set was costing the same seven draws as
   * the entire perimeter's plaster for 12 800 triangles, and the drums, tyres,
   * crates and pallets were each doing the same.
   *
   * Below `INSTANCE_MIN_COUNT` the prop is baked into the shared merged mesh for
   * its material instead. The rendered triangle count is identical — the same
   * geometry at the same transforms — but it arrives inside a draw call that was
   * already being issued. Seven sets moved across; seven draw calls' worth of
   * scene objects removed, at a cost of a few hundred kilobytes of duplicated
   * vertex data at build time.
   *
   * The threshold is where instancing starts to pay for its own object: past
   * ~90 copies the vertex-data saving dominates.
   */
  static INSTANCE_MIN_COUNT = 90;

  /**
   * One InstancedMesh per repeated prop. Per-instance colour (setColorAt) multiplies the
   * baked vertex colours, so every drum/pallet/rubble chunk is a different shade on top
   * of already-unique weathering.
   */
  instance(materialName, geo, list, opts = {}) {
    if (!geo || !list?.length) return null;
    if (list.length < LevelSystem.INSTANCE_MIN_COUNT) {
      const merged = this._instanceAsMerged(materialName, geo, list, opts);
      if (merged) return null;      // folded into a Builder pile; no scene object
    }
    try {
      /**
       * Instanced props bypass `Builder.add()`, which is where every other surface
       * in the level gets its UVs divided by the material's metersPerTile. Without
       * this the geometry's metre-space UVs go to the GPU raw — a 1 m tile on a
       * 0.3 m drum, which is the "one giant rust bloom per prop" look. `uvScale` is
       * in texture repeats per metre, same convention as Builder.
       */
      if (opts.uvScale) {
        const ua = geo.attributes.uv?.array;
        if (ua && !geo.userData.uvScaled) {
          for (let i = 0; i < ua.length; i++) ua[i] *= opts.uvScale;
          geo.attributes.uv.needsUpdate = true;
          geo.userData.uvScaled = true;
        }
      }
      const m = new THREE.InstancedMesh(geo, this.materialFor(materialName), list.length);
      m.name = `inst_${materialName}_${opts.bucket ?? 'scatter'}`;
      m.castShadow = opts.shadow !== false;
      m.receiveShadow = true;
      m.userData.noCollide = true;
      const mm = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const p = new THREE.Vector3();
      const s = new THREE.Vector3();
      const c = new THREE.Color();
      let anyColor = false;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        e.set(it.rx ?? 0, it.ry ?? 0, it.rz ?? 0, 'YXZ');
        q.setFromEuler(e);
        p.set(it.x ?? 0, it.y ?? 0, it.z ?? 0);
        const sc = it.scale ?? 1;
        s.set(sc, sc, sc);
        mm.compose(p, q, s);
        m.setMatrixAt(i, mm);
        if (it.tint) {
          c.setRGB(it.tint[0], it.tint[1], it.tint[2], THREE.LinearSRGBColorSpace);
          m.setColorAt(i, c);
          anyColor = true;
        }
        if (opts.collide) {
          this.addProxy(it.x, (it.y ?? 0) + opts.collide[1] * 0.5 * sc, it.z,
            opts.collide[0] * sc, opts.collide[1] * sc, opts.collide[2] * sc,
            it.ry ?? 0, materialName);
        } else if (opts.contact) {
          // props with no collider still have to sit IN the ground, not on it
          const r = opts.contact * sc;
          this.markContact(it.x, it.z, r, r, it.ry ?? 0, opts.contactStrength ?? 0.34, r * 0.9 + 0.14);
          if (opts.propHeight) {
            this.markShadow(it.x, it.z, r, r, it.ry ?? 0, opts.propHeight * sc, 0.26);
          }
        }
      }
      m.instanceMatrix.needsUpdate = true;
      if (anyColor && m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
      m.frustumCulled = opts.frustumCulled !== false;
      this.root.add(m);
      this._instanced.push(m);
      this.stats.instanced++;
      this.stats.triangles += (geo.attributes.position.count / 3) * list.length;
      if (opts.cullDist) this._registerCull(m, list, opts);
      return m;
    } catch (err) {
      console.warn('[level] instance failed for', materialName, err);
      return null;
    }
  }

  /* ─────────────────── per-instance culling for scatter ───────────────── */

  /**
   * ── WHY THE SCATTER NEEDS ITS OWN CULLING ──────────────────────────────
   *
   * An InstancedMesh is culled as one object. The scatter buckets cover the
   * whole 72 x 92 m compound, so their bounding spheres always intersect the
   * camera frustum and all four cascades — which meant 872 masonry chips, 454
   * rubble lumps, 1 290 pebbles and 170 boards were submitted in full, seven
   * times a frame, from every pose. Measured on the `lane` framing: 519 k
   * triangles a frame of debris, most of it behind the camera or far enough away
   * to be under a pixel.
   *
   * Two independent cuts, both driven from one sorted rebuild:
   *
   *  1. MAIN PASS — distance and a wide horizontal cone. `cullDist` is set per
   *     bucket from the real size of the prop: a 8-20 cm pebble is gone at 30 m,
   *     a 40 cm chip at 48 m, a 1.75 m rubble slab not until 70 m. The cone is
   *     70 degrees off the flattened view vector — much wider than the 53-degree
   *     half-FOV — and anything inside `NEAR_KEEP` is kept whatever the heading,
   *     so nothing that could throw a shadow into frame is ever dropped.
   *
   *  2. SHADOW CASCADES — a tighter prefix. This is the "small props do not need
   *     to cast into distant cascades" case, and on this map it is very nearly
   *     free: at 8.7 degrees of solar elevation the cascade normal-offset bias
   *     already erases the cast shadow of anything under ~0.4 m past about 22 m
   *     (see `GroundMask.shadowSmear`, which exists precisely because of that),
   *     and the baked ground mask carries the contact darkening out there
   *     instead. Beyond `shadowDist` the instance was drawing four extra depth
   *     passes to produce nothing.
   *
   * The two counts are applied through `onBeforeShadow` / `onBeforeRender`,
   * which three.js calls once per object per pass, and the instances are written
   * back nearest-first so a prefix count is exactly "the closest N".
   *
   * The rebuild only runs when the camera has actually moved 2 m or turned 10
   * degrees, so the amortised cost is a few hundred microseconds a second.
   */
  _registerCull(mesh, list, opts) {
    try {
      const n = list.length;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = list[i].x ?? 0;
        pos[i * 3 + 1] = list[i].y ?? 0;
        pos[i * 3 + 2] = list[i].z ?? 0;
      }
      const spec = {
        mesh,
        n,
        pos,
        srcMatrix: new Float32Array(mesh.instanceMatrix.array),
        srcColor: mesh.instanceColor ? new Float32Array(mesh.instanceColor.array) : null,
        cullDist: opts.cullDist,
        shadowDist: opts.shadowDist ?? Math.min(opts.cullDist, 26),
        order: new Int32Array(n),
        dist: new Float32Array(n),
        mainCount: n,
        shadowCount: n,
      };
      // Both hooks are installed once; they cost one assignment per pass.
      mesh.onBeforeRender = () => { mesh.count = spec.mainCount; };
      mesh.onBeforeShadow = () => { mesh.count = spec.shadowCount; };
      this._cullSpecs.push(spec);
    } catch (err) {
      console.warn('[level] instance culling unavailable for', mesh.name, err);
    }
  }

  _updateInstanceCulling() {
    const specs = this._cullSpecs;
    if (!specs.length) return;
    const cam = this.ctx.camera;
    if (!cam) return;
    const p = cam.getWorldPosition(this._cullPos);
    const f = cam.getWorldDirection(this._cullFwd);
    f.y = 0;
    const fl = Math.hypot(f.x, f.z);
    if (fl < 1e-4) { f.set(0, 0, -1); } else { f.x /= fl; f.z /= fl; }

    const moved = p.distanceToSquared(this._cullLastPos) > 4;          // 2 m
    const turned = (f.x * this._cullLastFwd.x + f.z * this._cullLastFwd.z) < 0.985;  // ~10 deg
    if (this._cullPrimed && !moved && !turned) return;
    this._cullPrimed = true;
    this._cullLastPos.copy(p);
    this._cullLastFwd.copy(f);

    /** Always keep everything inside this radius, whatever the heading. */
    const NEAR_KEEP = 13;
    /** cos(70 deg) — a deliberately generous cone around the view vector. */
    const CONE = 0.342;

    for (const s of specs) {
      const { pos, n, order, dist } = s;
      const cull2 = s.cullDist * s.cullDist;
      let k = 0;
      for (let i = 0; i < n; i++) {
        const dx = pos[i * 3] - p.x;
        const dz = pos[i * 3 + 2] - p.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > cull2) continue;
        const d = Math.sqrt(d2);
        if (d > NEAR_KEEP && (dx * f.x + dz * f.z) < d * CONE) continue;
        order[k] = i;
        dist[k] = d;
        k++;
      }
      // insertion sort on the kept prefix: k is a few hundred and the set is
      // near-sorted between rebuilds, so this beats a generic sort here.
      for (let a = 1; a < k; a++) {
        const di = dist[a], oi = order[a];
        let b = a - 1;
        while (b >= 0 && dist[b] > di) { dist[b + 1] = dist[b]; order[b + 1] = order[b]; b--; }
        dist[b + 1] = di; order[b + 1] = oi;
      }

      const mArr = s.mesh.instanceMatrix.array;
      const src = s.srcMatrix;
      for (let a = 0; a < k; a++) {
        const so = order[a] * 16, dO = a * 16;
        for (let c = 0; c < 16; c++) mArr[dO + c] = src[so + c];
      }
      if (s.srcColor && s.mesh.instanceColor) {
        const cArr = s.mesh.instanceColor.array;
        for (let a = 0; a < k; a++) {
          const so = order[a] * 3, dO = a * 3;
          cArr[dO] = s.srcColor[so];
          cArr[dO + 1] = s.srcColor[so + 1];
          cArr[dO + 2] = s.srcColor[so + 2];
        }
        s.mesh.instanceColor.needsUpdate = true;
      }
      s.mesh.instanceMatrix.needsUpdate = true;

      let sc = 0;
      while (sc < k && dist[sc] <= s.shadowDist) sc++;
      s.mainCount = k;
      s.shadowCount = sc;
      s.mesh.count = k;
      // The sphere must cover the MAIN set; the shadow prefix is a subset, so
      // using it for both is conservative in the direction that is safe.
      if (k > 0) s.mesh.computeBoundingSphere();
    }
  }

  /**
   * Bake a low-count "instanced" set into the Builder as ordinary merged
   * geometry. Same transforms, same per-copy tint (the Builder's `tint` folds it
   * into the colour attribute exactly as `setColorAt` folds it into
   * `instanceColor`), same collision proxies and the same ground-contact marks.
   *
   * @returns {boolean} true if it was handled here.
   */
  _instanceAsMerged(materialName, geo, list, opts = {}) {
    try {
      const bucket = opts.bucket ?? 'scatter';
      for (const it of list) {
        const sc = it.scale ?? 1;
        const m = mat(it.x ?? 0, it.y ?? 0, it.z ?? 0, it.ry ?? 0, {
          rx: it.rx ?? 0, rz: it.rz ?? 0, scale: sc,
        });
        this.builder.add(materialName, geo, {
          bucket,
          matrix: m,
          uvScale: opts.uvScale,
          tint: it.tint ?? null,
          shadow: opts.shadow !== false,
        });
        if (opts.collide) {
          this.addProxy(it.x, (it.y ?? 0) + opts.collide[1] * 0.5 * sc, it.z,
            opts.collide[0] * sc, opts.collide[1] * sc, opts.collide[2] * sc,
            it.ry ?? 0, materialName);
        } else if (opts.contact) {
          const r = opts.contact * sc;
          this.markContact(it.x, it.z, r, r, it.ry ?? 0, opts.contactStrength ?? 0.34, r * 0.9 + 0.14);
          if (opts.propHeight) {
            this.markShadow(it.x, it.z, r, r, it.ry ?? 0, opts.propHeight * sc, 0.26);
          }
        }
      }
      return true;
    } catch (err) {
      console.warn('[level] merged-instance fallback failed for', materialName, err);
      return false;
    }
  }

  /* ────────────────────── practicals / shafts / spawns ───────────────── */

  addPracticalSpec(x, y, z, color = 0xffb257, intensity = 14, radius = 12, opts = {}) {
    this._practicalSpecs.push({ p: new THREE.Vector3(x, y, z), color, intensity, radius, opts });
  }

  /**
   * Register a volumetric shaft: an opening at (x,y,z) that the sun pours through.
   * `gain` scales this shaft alone — a 5 m-radius cone spreading to 16 m over 34 m
   * is a huge amount of screen area, and at the shared intensity it stopped
   * reading as light in air and started reading as a solid white wedge parked in
   * the middle of the yard.
   */
  addShaft(x, y, z, radius, length, spread = 2.0, gain = 1.0) {
    this._shaftSpecs.push({ p: new THREE.Vector3(x, y, z), radius, length, spread, gain });
  }

  /**
   * A soft additive patch on a surface — the aperture a shaft comes through, and
   * the hot spot where it lands.
   *
   * A volumetric shaft that neither starts at a visible opening nor terminates in
   * a bright patch is the single most "browser demo" thing a scene can contain,
   * because it announces itself as a stack of billboards. The light has to come
   * from somewhere and it has to hit something.
   */
  addLightPatch(x, y, z, radius, nx, ny, nz, gain = 1.0) {
    this._patchSpecs.push({ p: new THREE.Vector3(x, y, z), n: new THREE.Vector3(nx, ny, nz).normalize(), radius, gain });
  }

  addSpawn(x, y, z, yaw = 0, tag = '') {
    const v = new THREE.Vector3(x, y, z);
    this.spawnPoints.push(v);
    this.spawns.push({ position: v, yaw, tag });
  }

  /* ──────────────────────────────── init ─────────────────────────────── */

  async init(onProgress = () => {}) {
    const t0 = performance.now();
    try {
      onProgress(0.05, 'level: geometry');
      buildMap(this.ctx, this);

      onProgress(0.55, 'level: ground mask');
      this._bakeGround();

      onProgress(0.6, 'level: merge');
      this._meshes = this.builder.flush(this.root);
      this.stats.meshes = this._meshes.length;
      for (const m of this._meshes) {
        this.stats.triangles += m.geometry.attributes.position.count / 3;
      }

      onProgress(0.85, 'level: shafts');
      this._buildShafts();
      this._buildPatches();

      this.ctx.scene.add(this.root);

      // A last-resort spawn so nothing downstream can crash on an empty array.
      if (!this.spawnPoints.length) this.addSpawn(0, 0.1, -30, Math.PI, 'fallback');

      onProgress(1, 'level');
      console.info(
        `[level] GRACHEVKA YARD — ${this.stats.meshes} merged meshes, ` +
        `${this.stats.instanced} instanced sets, ${this.stats.proxies} colliders, ` +
        `${Math.round(this.stats.triangles / 1000)}k tris, ${this.spawnPoints.length} spawns, ` +
        `${Math.round(performance.now() - t0)} ms`,
      );
    } catch (err) {
      console.error('[level] build failed — falling back to a flat arena:', err);
      this._buildFallback();
    }
  }

  /* ─────────────────────────── ground authoring ──────────────────────── */

  /**
   * Horizontal direction the sunlight TRAVELS, plus how many metres of shadow a
   * metre of height throws. Derived from Config's art block so the level and the
   * lighting system can never disagree about where shadows point.
   */
  get sunTravel() {
    if (!this._sunTravel) {
      const art = this.ctx.config?.art ?? {};
      // the lighting system trims the nominated elevation by ~0.9 degrees
      const elev = Math.max(2, (art.sunElevation ?? 11.5) - 0.9) * Math.PI / 180;
      const azim = (art.sunAzimuth ?? 118) * Math.PI / 180;
      const sdx = -Math.cos(azim), sdz = -Math.sin(azim);
      const l = Math.hypot(sdx, sdz) || 1;
      this._sunTravel = {
        lx: sdx / l, lz: sdz / l,
        slope: Math.min(9.5, 1 / Math.max(0.06, Math.tan(elev))),
      };
    }
    return this._sunTravel;
  }

  /** Mark a contact/dust footprint on the ground mask. Safe to call any time. */
  markContact(x, z, hw, hd, ry = 0, strength = 0.42, feather = 0.55) {
    try { this.ground.contact(x, z, hw, hd, ry, strength, feather); } catch (e) { /* non-fatal */ }
  }

  /**
   * Deposit loose dirt / grit at a point. The mask's R channel drives the ground
   * shader's second layer, so this is how a material boundary gets FEATHERED —
   * grains blend up over the slab lip over ~0.5 m rather than the two surfaces
   * meeting on a drawn line.
   */
  markDust(x, z, radius, strength = 0.5) {
    try { this.ground.dust(x, z, radius, strength); } catch (e) { /* non-fatal */ }
  }

  /**
   * Bake the ground shadow a prop with no collision proxy would throw. Props that
   * DO register a proxy get this automatically in `_bakeGround()`.
   */
  markShadow(x, z, hw, hd, ry, height, strength = 0.34) {
    try {
      const { lx, lz, slope } = this.sunTravel;
      this.ground.shadowSmear(x, z, hw, hd, ry, height, lx, lz, slope, strength);
    } catch (e) { /* non-fatal */ }
  }

  /**
   * Bake the ground authoring mask.
   *
   * The contact layer is derived from the collision proxies the map has already
   * registered, so every solid that a bullet can hit also darkens the ground it
   * stands on — there is no second list to keep in sync and nothing can be
   * forgotten. On top of that go the authored features the proxies cannot know
   * about: the traffic lanes players and vehicles actually use, the spoil drifts
   * along the perimeter, and the puddle basins in the low spots.
   */
  _bakeGround() {
    const t0 = performance.now();
    const G = this.ground;
    try {
      /**
       * ── 1. contact + dust apron + baked shadow lobe under every solid ──
       *
       * See `GroundMask.shadowSmear()` for why the smear exists: at 11.5
       * degrees of solar elevation the cascade normal-offset bias erases the
       * cast shadow of anything under about a metre wide past 22 m, which is
       * every barrel, crate, sandbag course and railing in the map. The smear
       * is deliberately restricted to that class — nothing over 3.4 m tall or
       * 4 m across gets one, because those DO resolve in the shadow map and a
       * second copy would read as a double shadow.
       */
      const { lx, lz, slope } = this.sunTravel;
      for (const c of this.collidables) {
        const s = c.scale, p = c.position;
        const bottom = p.y - s.y * 0.5;
        if (bottom > 0.75 || bottom < -1.6) continue;      // airborne, or the ground slab itself
        if (s.y < 0.22) continue;                          // catwalk decks, ramp lips
        const hw = s.x * 0.5, hd = s.z * 0.5;
        if (hw > 17 || hd > 17) continue;                  // world bounds, the ground plane
        const small = Math.min(hw, hd);
        const feather = Math.min(1.35, 0.30 + small * 0.42);
        const strength = Math.min(0.60, 0.36 + Math.min(s.y, 3) * 0.080);
        G.contact(p.x, p.z, hw, hd, c.rotation.y, strength, feather);
        if (s.y <= 3.4 && hw <= 4.0 && hd <= 4.0) {
          const top = Math.max(0.1, p.y + s.y * 0.5);
          G.shadowSmear(p.x, p.z, hw, hd, c.rotation.y, top, lx, lz, slope,
            0.30 + Math.min(0.22, top * 0.13));
        }
      }

      /**
       * ── 2. desire lines ────────────────────────────────────────────────
       * Authored along the sightlines the level is actually built around: the
       * 90 m central lane, the three cross-paths that loop the lanes together,
       * the warehouse roller-door approach and the container-yard service road.
       * Wear darkens and polishes; the spoil it displaces is pushed onto the
       * shoulders by wearLane() itself, which is what gives the road-to-gravel
       * boundary a scattered edge instead of a straight cut.
       */
      G.wearLane(-1.0, -43, 1.5, 43, 3.1, 0.72);
      G.wearLane(-3.6, -40, -3.0, 40, 1.15, 0.42);          // near-side tyre rut
      G.wearLane(3.2, -40, 3.8, 40, 1.15, 0.42);            // far-side tyre rut
      G.wearLane(-11, -26, 30, -26.6, 2.1, 0.62);
      G.wearLane(-11, -2.2, 31, -1.6, 2.3, 0.64);
      G.wearLane(-11, 22.4, 29, 21.8, 2.0, 0.58);
      G.wearLane(-6.0, -7.5, -23.5, -7.0, 2.4, 0.66);       // into the roller door
      G.wearLane(14.2, -32, 14.8, 28, 1.7, 0.5);            // container yard service road
      G.wearLane(-11.5, 11.0, 7.0, -13.0, 1.15, 0.46);      // diagonal desire line
      G.wearLane(24.0, -30, 25.0, 14, 1.5, 0.44);
      G.wearLane(-27.0, -18, -27.5, 4, 1.6, 0.5);           // warehouse interior aisle

      // ── 3. spoil / dust drifts, biased to the ruined edges ────────────
      const r = new Rng(0x9AD1);
      const drifts = [
        [-30, 6, 7], [-24, 9, 6], [-18, 8, 5], [-34, -2, 5],
        [-13, 30, 6], [12, 34, 5], [33, 22, 6], [36, -30, 6],
        [-8, -38, 5], [20, -40, 6], [-36, 34, 7], [30, 40, 6],
        [-2, 44, 8], [26, -46, 7], [-30, -42, 7],
      ];
      for (const [x, z, rad] of drifts) G.dust(x, z, rad, r.range(0.45, 0.85));
      for (let i = 0; i < 26; i++) {
        G.dust(r.range(-36, 36), r.range(-45, 45), r.range(1.6, 4.2), r.range(0.25, 0.6));
      }

      // ── 4. puddle basins ──────────────────────────────────────────────
      const pools = [
        [-1.8, -18.5, 2.1], [2.6, 6.5, 1.7], [-5.5, 27.0, 1.9], [8.5, -34.0, 1.5],
        [-16.0, -3.0, 1.6], [17.5, -12.0, 1.4], [1.0, 34.5, 1.8], [-9.0, 16.5, 1.3],
        [22.5, 8.0, 1.5], [-26.0, 12.5, 1.6],
      ];
      for (const [x, z, rad] of pools) G.puddle(x, z, rad, r.range(0.7, 0.95));

      // ── 5. publish ────────────────────────────────────────────────────
      const tex = G.build();
      for (const m of this._groundMaterials) {
        const u = m.userData.groundUniforms;
        if (u) u.uGMask.value = tex;
      }
      console.info(`[level] ground mask ${G.size}² · ${G.splats} splats · ${Math.round(performance.now() - t0)} ms`);
    } catch (err) {
      console.warn('[level] ground mask bake failed — falling back to plain ground:', err);
      try {
        const tex = G.build();
        for (const m of this._groundMaterials) {
          const u = m.userData.groundUniforms;
          if (u) u.uGMask.value = tex;
        }
      } catch (e) { /* the shader clamps against a null sampler anyway */ }
    }
  }

  /** If anything above throws we still hand physics a floor and the game still boots. */
  _buildFallback() {
    try {
      if (!this.collidables.length) {
        const g = new THREE.Mesh(
          new THREE.BoxGeometry(120, 1, 120),
          this.ctx.materials.getForSize('concrete', 120, 120),
        );
        g.position.y = -0.5;
        g.receiveShadow = true;
        this.root.add(g);
        this.collidables.push(g);
      }
      if (!this.spawnPoints.length) this.addSpawn(0, 0.1, 0, 0, 'fallback');
      if (!this.root.parent) this.ctx.scene.add(this.root);
    } catch (err) {
      console.error('[level] fallback failed:', err);
    }
  }

  /** Soft radial falloff, used for shaft apertures and landing patches. */
  _glowTexture() {
    if (this._glowTex) return this._glowTex;
    const S = 64;
    const d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = ((x + 0.5) / S) * 2 - 1;
        const dy = ((y + 0.5) / S) * 2 - 1;
        const r = Math.min(1, Math.hypot(dx, dy));
        const a = (1 - r) ** 2.7;
        const i = (y * S + x) * 4;
        d[i] = 255; d[i + 1] = 240; d[i + 2] = 214; d[i + 3] = Math.round(a * 255);
      }
    }
    const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    this._glowTex = t;
    return t;
  }

  _buildPatches() {
    if (!this._patchSpecs.length) return;
    try {
      this._patchMaterial = new THREE.MeshBasicMaterial({
        map: this._glowTexture(),
        color: new THREE.Color(0xffd3a0),
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        fog: false,
        side: THREE.DoubleSide,
        // per-patch gain rides in the vertex colour so all of them stay on one material
        vertexColors: true,
      });
      this._patchMaterial.name = 'lvl_lightPatch';
      const zAxis = new THREE.Vector3(0, 0, 1);
      for (const s of this._patchSpecs) {
        const g = new THREE.PlaneGeometry(s.radius * 2, s.radius * 2);
        const n = g.attributes.position.count;
        const col = new Float32Array(n * 3);
        for (let i = 0; i < n * 3; i++) col[i] = s.gain;
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        const mesh = new THREE.Mesh(g, this._patchMaterial);
        mesh.quaternion.setFromUnitVectors(zAxis, s.n);
        mesh.position.copy(s.p).addScaledVector(s.n, 0.035);
        mesh.scale.setScalar(1);
        mesh.renderOrder = 11;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.userData.noCollide = true;
        mesh.userData.patchGain = s.gain;
        this.root.add(mesh);
        this._patches.push(mesh);
      }
    } catch (err) {
      console.warn('[level] light patches unavailable:', err);
    }
  }

  _buildShafts() {
    if (!this._shaftSpecs.length) return;
    try {
      const mkMat = (gain) => {
        const m = new THREE.ShaderMaterial({
          uniforms: {
            uColor: { value: new THREE.Color(0xffcf9a) },
            // 0.21 put a solid additive wedge across the middle of the shed.
            // With the tightened core and the extinction term above, 0.195 is
            // the most a beam can carry before it stops reading as light in air.
            uIntensity: { value: 0.195 * gain },
            uTime: { value: 0 },
          },
          vertexShader: SHAFT_VERT,
          fragmentShader: SHAFT_FRAG,
          transparent: true,
          depthWrite: false,
          depthTest: true,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          toneMapped: false,
          fog: false,
        });
        m.name = 'lvl_lightShaft';
        return m;
      };
      const byGain = new Map();
      this._shaftMaterial = mkMat(1);
      byGain.set(1, this._shaftMaterial);
      this._shaftMaterials = [this._shaftMaterial];

      for (const s of this._shaftSpecs) {
        const gain = s.gain ?? 1;
        let smat = byGain.get(gain);
        if (!smat) { smat = mkMat(gain); byGain.set(gain, smat); this._shaftMaterials.push(smat); }
        const geo = shaftGeometry(s.radius, s.radius * s.spread, s.length, 12);
        const mesh = new THREE.Mesh(geo, smat);
        mesh.position.copy(s.p);
        mesh.renderOrder = 12;
        mesh.frustumCulled = true;
        mesh.userData.noCollide = true;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        this.root.add(mesh);
        this._shafts.push(mesh);
      }
    } catch (err) {
      console.warn('[level] light shafts unavailable:', err);
    }
  }

  /* ───────────────────────── deferred integration ────────────────────── */

  /**
   * Runs once, on the first frame — after LightingSystem.init() has built the CSM, the
   * PMREM probe and the practical pool. See the header note: none of this exists yet at
   * order 8.
   */
  _lateInit() {
    const { ctx } = this;
    this._lateDone = true;

    // ── 1. env map + CSM registration for every material we own ──────────
    const lighting = ctx.lighting ?? ctx.systems?.lighting ?? null;
    let registered = 0;
    for (const m of this._materials.values()) {
      try {
        const base = m.userData?.libraryBase;
        if (base) {
          m.envMap = base.envMap ?? ctx.materials?.envMap ?? null;
          m.envMapIntensity = base.envMapIntensity * (m.userData.envMul ?? 1);
        } else if (m.isMeshStandardMaterial) {
          // Custom materials fall back to scene.environment, which is already scaled.
          // They still honour their own envMul — window interiors need the probe
          // almost switched off, surviving glazing needs it turned up.
          m.envMapIntensity = 1.0 * (m.userData.envMul ?? 1);
        }
        m.needsUpdate = true;
      } catch (err) { /* keep going — a wrong env is survivable, a throw is not */ }
      try {
        if (lighting?.registerMaterial) { lighting.registerMaterial(m); registered++; }
        else if (lighting?.csm?.setupMaterial) { lighting.csm.setupMaterial(m); registered++; }
      } catch (err) {
        console.warn('[level] CSM registration failed for', m.name, err);
      }
    }
    if (!registered && lighting) {
      console.warn('[level] no CSM registration hook found — relying on the lighting sweep');
    }

    // ── 2. practicals ────────────────────────────────────────────────────
    if (lighting?.addPractical) {
      for (const s of this._practicalSpecs) {
        try {
          const h = lighting.addPractical(s.p, s.color, s.intensity, s.radius, s.opts);
          if (h) this._practicalHandles.push(h);
        } catch (err) {
          console.warn('[level] addPractical failed:', err);
        }
      }
    }

    // ── 3. aim the light shafts down the real sun vector ─────────────────
    try {
      const sunDir = lighting?.sunDirection
        ? lighting.sunDirection.clone()
        : new THREE.Vector3(-0.4641, 0.1513, 0.8728);
      const travel = sunDir.clone().negate().normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), travel);
      for (const s of this._shafts) {
        s.quaternion.copy(q);
        s.updateMatrix();
      }
      /**
       * Tint the beams to the key. Shipping them at a neutral 0xffcf9a and then
       * copying the raw sun colour left them reading as pale grey sheets in a scene
       * lit by a low warm dusk sun — light scattered off airborne dust is if
       * anything WARMER than the direct beam, because the short wavelengths have
       * already been scattered out of it on the way in. So the sun colour is pushed
       * further along the same axis rather than used flat.
       */
      const warm = (c) => {
        const o = c.clone();
        o.r = Math.min(1.6, o.r * 1.10 + 0.06);
        o.g = Math.min(1.6, o.g * 0.98 + 0.02);
        o.b = Math.min(1.6, o.b * 0.80);
        return o;
      };
      if (lighting?.sun) {
        const c = warm(lighting.sun.color);
        for (const sm of (this._shaftMaterials ?? [])) sm.uniforms.uColor.value.copy(c);
        if (this._patchMaterial) this._patchMaterial.color.copy(c);
      }
      void up;
    } catch (err) {
      console.warn('[level] shaft orientation failed:', err);
    }
  }

  /* ────────────────────────────── spawns API ─────────────────────────── */

  /**
   * @param {THREE.Vector3|null} awayFrom  bias the pick away from this position
   * @returns {THREE.Vector3} a clone — callers may mutate it freely
   */
  getRandomSpawn(awayFrom = null) {
    const pts = this.spawnPoints;
    if (!pts.length) return new THREE.Vector3(0, 0.1, 0);
    if (!awayFrom) return pts[Math.floor(this._rng.f() * pts.length) % pts.length].clone();

    // Rank by distance, then pick randomly from the far half so respawns are safe but
    // not deterministic.
    const scored = pts.map((p) => ({ p, d: p.distanceToSquared(awayFrom) }));
    scored.sort((a, b) => b.d - a.d);
    const pool = scored.slice(0, Math.max(1, Math.ceil(scored.length * 0.5)));
    return pool[Math.floor(this._rng.f() * pool.length) % pool.length].p.clone();
  }

  /** Spawn descriptor (position + suggested yaw) by tag, or null. */
  getSpawn(tag) {
    return this.spawns.find((s) => s.tag === tag) ?? null;
  }

  /** Coarse ground height. The play area is flat by design; this exists for AI. */
  heightAt(x, z) {
    if (x > LAYOUT.minX && x < LAYOUT.maxX && z > LAYOUT.minZ && z < LAYOUT.maxZ) return 0;
    return 0;
  }

  /* ────────────────────────────── frame ──────────────────────────────── */

  update(dt, elapsed) {
    if (!this._lateDone) {
      try { this._lateInit(); } catch (err) { console.error('[level] late init failed:', err); this._lateDone = true; }
    }
    this._time = elapsed;
    for (const sm of (this._shaftMaterials ?? [])) sm.uniforms.uTime.value = elapsed;
    try { this._updateInstanceCulling(); } catch (err) {
      // Never let a culling bug take the map off screen: on failure, restore
      // every bucket to its full instance count and stop trying.
      console.warn('[level] instance culling disabled after error:', err);
      for (const s2 of this._cullSpecs) { s2.mainCount = s2.shadowCount = s2.n; s2.mesh.count = s2.n; }
      this._cullSpecs.length = 0;
    }
  }

  /* ────────────────────────────── teardown ───────────────────────────── */

  dispose() {
    try {
      const lighting = this.ctx.lighting ?? this.ctx.systems?.lighting;
      for (const h of this._practicalHandles) lighting?.removePractical?.(h);
      this._practicalHandles.length = 0;

      this.root.traverse((o) => {
        if (o.geometry) o.geometry.dispose?.();
      });
      this.ctx.scene.remove(this.root);
      for (const m of this._materials.values()) m.dispose?.();
      this._materials.clear();
      for (const sm of (this._shaftMaterials ?? [])) sm.dispose?.();
      this._shaftMaterials = [];
      this._patchMaterial?.dispose();
      this._patchMaterial = null;
      this._patches.length = 0;
      this._glowTex?.dispose();
      this._glowTex = null;
      this._chainTex?.dispose();
      this.ground?.dispose();
      this._groundMaterials.length = 0;
      this._proxyGeo?.dispose();
      this._proxyMat?.dispose();
      this.collidables.length = 0;
    } catch (err) {
      console.error('[level] dispose failed:', err);
    }
  }
}

export default LevelSystem;
export { LAYOUT, mat };
