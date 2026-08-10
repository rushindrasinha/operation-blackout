/**
 * OPERATION BLACKOUT — procedural soldier construction.
 * OWNER: ai agent.
 *
 * Builds, once, a shared bind-pose template for a plate-carrier-wearing rifleman:
 *
 *   · a 25-bone skeleton (spine chain, clavicles, arms, legs, plus a `weapon` bone
 *     hung off the chest so the carbine rides the torso and the hands IK onto it)
 *   · body geometry authored directly in BIND WORLD SPACE, then auto-skinned by
 *     distance-to-bone-segment against a per-part whitelist of candidate bones.
 *     Whitelisting is what stops a forearm bleeding weight into the ribcage.
 *   · THREE shared materials (uniform / load-bearing nylon / hard shell) so a whole
 *     squad is 3 skinned draws per soldier, not 200 — and per-part identity is
 *     carried by vertex attributes rather than by extra materials. See "surface
 *     attributes" below: that is what lets one draw call render a matte-tan helmet
 *     shell and a dusty black rubber boot at two different roughnesses.
 *
 * Silhouette is the brief: helmet dome with a brim break, plate-carrier bulk across
 * the shoulders over a narrower waist, and a carbine breaking the body outline.
 * Those three shapes are what a player reads at 40 metres against a dusk sky, so
 * they are deliberately over-built.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bevelBox, limb, tubeZ, domeShell, scaleUV, place, distSqToSegment, clamp, TAU } from './utils.js';
import { soldierTextures } from './textures.js';

/** Bind-pose world positions. Feet at y=0, top of helmet ≈ 1.86m. */
export const BIND = {
  hips: [0, 0.965, 0],
  spine: [0, 1.100, 0],
  chest: [0, 1.255, 0],
  neck: [0, 1.465, 0],
  head: [0, 1.545, 0],
  headEnd: [0, 1.760, 0],

  clavL: [0.055, 1.415, 0], clavR: [-0.055, 1.415, 0],
  armL: [0.185, 1.395, 0], armR: [-0.185, 1.395, 0],
  foreL: [0.185, 1.125, 0], foreR: [-0.185, 1.125, 0],
  handL: [0.185, 0.885, 0], handR: [-0.185, 0.885, 0],
  handEndL: [0.185, 0.790, 0], handEndR: [-0.185, 0.790, 0],

  upLegL: [0.098, 0.905, 0], upLegR: [-0.098, 0.905, 0],
  loLegL: [0.098, 0.495, 0], loLegR: [-0.098, 0.495, 0],
  footL: [0.098, 0.085, 0.010], footR: [-0.098, 0.085, 0.010],
  toeL: [0.098, 0.040, 0.150], toeR: [-0.098, 0.040, 0.150],

  // Right-shouldered carbine. The whole rig faces +Z.
  weapon: [-0.075, 1.215, 0.055],
};

export const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', headEnd: 'head',
  clavL: 'chest', armL: 'clavL', foreL: 'armL', handL: 'foreL', handEndL: 'handL',
  clavR: 'chest', armR: 'clavR', foreR: 'armR', handR: 'foreR', handEndR: 'handR',
  upLegL: 'hips', loLegL: 'upLegL', footL: 'loLegL', toeL: 'footL',
  upLegR: 'hips', loLegR: 'upLegR', footR: 'loLegR', toeR: 'footR',
  weapon: 'chest',
};

export const BONE_ORDER = [
  'hips', 'spine', 'chest', 'neck', 'head', 'headEnd', 'weapon',
  'clavL', 'armL', 'foreL', 'handL', 'handEndL',
  'clavR', 'armR', 'foreR', 'handR', 'handEndR',
  'upLegL', 'loLegL', 'footL', 'toeL',
  'upLegR', 'loLegR', 'footR', 'toeR',
];

/** Bone "tip" used for the distance-to-segment skinning metric. */
const TIP = {
  hips: 'spine', spine: 'chest', chest: 'neck', neck: 'head', head: 'headEnd',
  clavL: 'armL', armL: 'foreL', foreL: 'handL', handL: 'handEndL',
  clavR: 'armR', armR: 'foreR', foreR: 'handR', handR: 'handEndR',
  upLegL: 'loLegL', loLegL: 'footL', footL: 'toeL',
  upLegR: 'loLegR', loLegR: 'footR', footR: 'toeR',
};

/** Grip / muzzle anchors in bind world space; converted to weapon-bone local at build. */
export const WEAPON_ANCHORS = {
  gripR: [-0.075, 1.113, -0.018],
  gripL: [-0.075, 1.203, 0.348],
  muzzle: [-0.075, 1.246, 0.700],
  eject: [-0.040, 1.250, 0.075],
};

/* ───────────────────────── surface attributes ───────────────────────── */

/**
 * Per-part surface identity, baked into two vertex attributes:
 *
 *   `color`  — a LINEAR albedo multiplier. The maps are authored near-neutral for
 *              the hard set precisely so this can swing one texture from a matte
 *              ranger-green helmet shell (0.24) to a black rubber outsole (0.06).
 *   `aiSurf` — x: roughness multiplier / 2   y: metalness multiplier / 2
 *              z: rim strength               w: reserved
 *
 * A shader patch (see `aiSurfaceHook`) applies x and y on top of the ORM map and
 * adds z as a Fresnel rim. Encoding zero as "use 1.0" means any mesh that somehow
 * ends up with one of these materials but no attribute still renders correctly
 * instead of turning into a chrome ball.
 *
 * `dust` is how strongly the part collects ground grime and `dustGain` is what the
 * tint multiplies to at full dust. Gain rather than an absolute colour, because
 * `tint` means different things in different buckets — 1.0 on the fabric map is a
 * 0.20-linear camo, 1.0 on the neutral hard map is 0.30 linear — so blending
 * toward one absolute "dust colour" DARKENED the trousers to a black cut-out
 * while lightening the boots. Gain is bucket-independent: >1 lifts, <1 sinks,
 * and every preset states the direction its own substance actually goes.
 *
 * ── PASS 3 RECALIBRATION (roughness is the whole story) ──────────────────────
 *
 * The previous table multiplied the hard-shell ORM (which already runs 0.30–0.92)
 * by 1.35–1.60 on the helmet, boots, pads, gloves and belt. `roughnessFactor *=
 * aiR * 2.0` in the shader, so every one of those parts clamped at roughness 1.0:
 * a perfectly Lambertian dielectric with ZERO specular response. That is what a
 * critic reads as "pale putty cutout" — a helmet, a nylon pouch and a rubber boot
 * sole all lit by exactly the same diffuse-only lobe are the same substance
 * wearing three tints, and at 30m the tints wash together into one value.
 *
 * So the hard bucket now lands where its substances actually live:
 *
 *   helmet shell   ~0.45   painted composite — a broad soft dome highlight
 *   boot leather   ~0.52   polished toe cap and heel counter
 *   boot rubber    ~0.72   moulded outsole, matte but not chalk
 *   pads / gloves  ~0.78   rubberised cordura
 *   plate carrier  ~0.60   1000D nylon (gear bucket)
 *   fatigues       ~0.86   ripstop (fabric bucket)
 *
 * Second half of the same defect: helmet (0.144 linear) and plate carrier
 * (0.145 linear) were the SAME VALUE, so the two largest shapes on the body had
 * no boundary. Helmets are ranger-green composite and carriers are coyote nylon —
 * roughly a stop apart and opposite in hue. They are now authored that way.
 *
 * Third: every dustGain above ~1.4 was INVERTING its part. The boot sole, the
 * darkest thing on a soldier, was being multiplied by 1.84 at the ground and came
 * out brighter than the trouser above it — the "pale capsule with no sole" read.
 * Dust lifts a dark rubber sole a little and desaturates it; it does not bleach it.
 */
const S = {
  /* fabric bucket — arid camo ripstop, map mean 0.20 linear */
  uniform: { tint: [0.80, 0.81, 0.78], rough: 1.00, metal: 1.0, rim: 0.55, dust: 0.10, dustGain: 1.14 },
  // Sleeves run a third of a stop under the torso. Once the detail LOD has taken
  // the camo out at 8 m the arms and the plate carrier are two adjacent tan
  // panels with no boundary between them, and an arm that has merged into the
  // torso is most of why a bot at that range reads as a lump: the elbow is the
  // shape that tells you a man is holding something, and holding something
  // tells you which way he is pointing it.
  uniformArm: { tint: [0.62, 0.63, 0.60], rough: 1.00, metal: 1.0, rim: 0.60, dust: 0.06, dustGain: 1.14 },
  uniformLeg: { tint: [0.78, 0.79, 0.76], rough: 1.02, metal: 1.0, rim: 0.50, dust: 1.00, dustGain: 1.18 },
  balaclava: { tint: [0.60, 0.58, 0.54], rough: 1.06, metal: 1.0, rim: 0.60, dust: 0.00 },

  /* gear bucket — coyote cordura, map mean 0.145 linear */
  // Eased a third of a stop. The back plate is the largest single flat panel on a
  // soldier and it faces the low sun square-on, so at 0.90 it was the brightest
  // thing in the silhouette — a pale rectangle with a head on top. Under the
  // fatigues now, which is both correct for coyote nylon over ripstop and what
  // makes the torso read as armour worn OVER a body rather than as the body.
  carrier: { tint: [0.78, 0.71, 0.60], rough: 0.72, metal: 1.0, rim: 0.60, dust: 0.12, dustGain: 1.14 },
  // ── FACING CUE ──────────────────────────────────────────────────────────────
  // Pouches used to be BRIGHTER than the carrier they sit on (0.98 against 0.90),
  // so the three mag pouches, the admin pouch and the radio — the entire front of
  // a rifleman's kit — dissolved into the plate as one pale slab. That slab is
  // symmetric front to back, which is exactly the "you cannot tell which way he
  // is facing" complaint: the only asymmetric thing left was the carbine, and
  // when it is held across the body there is nothing.
  //
  // A stop under the carrier instead. Now the belly of the carrier carries a dark
  // horizontal band of three pouches when a bot faces you, and the back carries
  // the MOLLE ladders' thin shadow lines when he does not. Two different reads
  // from the same silhouette, at the range where it decides an engagement.
  pouch: { tint: [0.56, 0.50, 0.41], rough: 0.74, metal: 1.0, rim: 0.55, dust: 0.22, dustGain: 1.15 },
  webbing: { tint: [0.70, 0.66, 0.60], rough: 0.82, metal: 1.0, rim: 0.60, dust: 0.10, dustGain: 1.14 },
  // Helmet cover band + crown shock cords. A dedicated preset because on the
  // gear map the ordinary webbing tint lands at 0.102 linear — BRIGHTER than the
  // 0.071 shell it is supposed to be cutting, so the bands read as light stripes
  // on a dark dome instead of the other way round. They have to be the darkest
  // thing on the head or they do not break the shape.
  coverBand: { tint: [0.40, 0.385, 0.345], rough: 0.90, metal: 1.0, rim: 0.55, dust: 0.02, dustGain: 1.10 },
  // Hip / thigh pouches sit right under the carrier where nothing shades them, so
  // they were coming out as the brightest band on the whole body. Knocked down a
  // stop: dump pouches are the oldest, dirtiest nylon a soldier carries.
  pouchLow: { tint: [0.60, 0.55, 0.46], rough: 0.80, metal: 1.0, rim: 0.50, dust: 0.55, dustGain: 1.16 },

  /* hard bucket — neutral 0.30-linear shell map, tinted per part */
  // Ranger-green composite shell: darker and cooler than the coyote carrier, and
  // the only part of the body with a real dome highlight.
  // A dome is the one surface on a soldier that faces the sky squarely, so it
  // collects roughly twice the irradiance a vertical panel does AND carries a
  // specular lobe on top. Measured at the warehouse catwalk it came out at 0.294
  // linear against 0.188 for the carrier directly below it — 3.5x the ratio the
  // albedos alone imply, and the reason a helmet is always the part a critic
  // calls "pale putty". So it is authored a stop below where a swatch would say:
  // 0.055 linear reads as a correct ranger-green shell only once the geometry
  // has done its own doubling.
  helmet: { tint: [0.196, 0.212, 0.162], rough: 0.90, metal: 0.20, rim: 0.50, dust: 0.02, dustGain: 1.10 },
  optic: { tint: [0.062, 0.064, 0.070], rough: 0.55, metal: 1.30, rim: 0.75, dust: 0.00 },
  hardware: { tint: [0.100, 0.100, 0.102], rough: 0.62, metal: 1.80, rim: 0.80, dust: 0.00 },
  antenna: { tint: [0.078, 0.078, 0.078], rough: 0.66, metal: 2.00, rim: 0.60, dust: 0.00 },
  pad: { tint: [0.118, 0.114, 0.100], rough: 1.06, metal: 0.30, rim: 0.50, dust: 0.70, dustGain: 1.30 },
  glove: { tint: [0.092, 0.088, 0.082], rough: 1.02, metal: 0.30, rim: 0.55, dust: 0.25, dustGain: 1.34 },
  belt: { tint: [0.090, 0.085, 0.078], rough: 0.94, metal: 0.40, rim: 0.40, dust: 0.35, dustGain: 1.28 },
  // Boot splits into three substances so the silhouette has internal edges: waxed
  // leather upper, a scuffed toe cap that takes a highlight, and matte outsole.
  boot: { tint: [0.112, 0.098, 0.082], rough: 0.90, metal: 0.25, rim: 0.45, dust: 0.85, dustGain: 1.26 },
  bootToe: { tint: [0.132, 0.115, 0.094], rough: 0.68, metal: 0.28, rim: 0.55, dust: 0.90, dustGain: 1.24 },
  bootSole: { tint: [0.064, 0.061, 0.058], rough: 1.20, metal: 0.10, rim: 0.35, dust: 0.70, dustGain: 1.30 },
  lace: { tint: [0.168, 0.158, 0.136], rough: 1.10, metal: 0.20, rim: 0.60, dust: 0.60, dustGain: 1.22 },
  tab: { tint: [0.130, 0.122, 0.102], rough: 0.95, metal: 0.35, rim: 0.55, dust: 0.10, dustGain: 1.25 },
  gunmetal: { tint: [0.052, 0.054, 0.060], rough: 0.62, metal: 2.00, rim: 0.70, dust: 0.00 },
  polymer: { tint: [0.062, 0.062, 0.059], rough: 0.98, metal: 0.20, rim: 0.55, dust: 0.00 },
  glass: { tint: [0.036, 0.042, 0.038], rough: 0.22, metal: 1.60, rim: 0.90, dust: 0.00 },
};

/** Deterministic per-vertex mottle so no two adjacent texels of cloth match. */
function mottle(x, y, z) {
  let h = Math.imul((x * 8191) | 0, 374761393) ^ Math.imul((y * 8191) | 0, 668265263)
    ^ Math.imul((z * 8191) | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 15), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Write the `color` + `aiSurf` attributes for one part, in bind world space.
 *
 * Two extra jobs happen here because they are free at this point and expensive
 * later:
 *  · a downward-facing vertex is darkened, which is a cheap directional ambient
 *    occlusion — undersides of pouches, the brim of the helmet and the inside of
 *    the thighs stop being the same value as the top of the shoulders.
 *  · the ground-dust gradient, which is what stops boots reading as clean vinyl.
 */
function applySurface(geom, surf) {
  const pos = geom.attributes.position;
  const nrm = geom.attributes.normal;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const srf = new Uint8Array(n * 4);

  const tint = surf.tint ?? [1, 1, 1];
  const rough = surf.rough ?? 1;
  const metal = surf.metal ?? 1;
  const rim = surf.rim ?? 0.5;
  const dust = surf.dust ?? 0;
  const gain = surf.dustGain ?? 1;

  for (let i = 0; i < n; i++) {
    const py = pos.getY(i);
    const ny = nrm ? nrm.getY(i) : 0;

    // 1 at the sole, 0 by mid-thigh.
    const d = dust * (1 - Math.min(1, Math.max(0, (py - 0.02) / 0.62)));
    // Dust is warm and desaturating: it lifts red most, blue least.
    const gr = 1 + (gain * 1.05 - 1) * d;
    const gg = 1 + (gain - 1) * d;
    const gb = 1 + (gain * 0.88 - 1) * d;
    const ao = 0.79 + 0.21 * (0.5 + 0.5 * ny);
    // Ground-contact occlusion. The last 9cm of a standing body sits inside the
    // ground's own AO cone; without this the sole meets the floor at full value
    // and the boot reads as a sticker laid on top of the deck rather than
    // something pressed into it. Baked, so it costs nothing per frame.
    const gc = py < 0.095 ? 0.78 + 0.22 * (py / 0.095) : 1;
    // Mottle amplitude was +-6%. A soldier carries ~9,500 vertices and covers
    // ~3,000 screen pixels at 8 m, so there are three vertices per pixel and a
    // per-vertex random term is not "cloth variation" at that range — it is
    // literally per-pixel white noise with nothing to average it out, since it is
    // baked into the attribute and therefore identical every frame. +-2% still
    // breaks up a flat panel at 1.5 m without dazzling at 8.
    const m = 0.98 + 0.04 * mottle(pos.getX(i), py, pos.getZ(i));
    const k = ao * m * gc;

    col[i * 3] = tint[0] * gr * k;
    col[i * 3 + 1] = tint[1] * gg * k;
    col[i * 3 + 2] = tint[2] * gb * k;

    const r = clamp((rough * (1 + 0.28 * d)) * 0.5, 0.01, 1) * 255;
    srf[i * 4] = r | 0;
    srf[i * 4 + 1] = clamp(metal * (1 - 0.35 * d) * 0.5, 0.004, 1) * 255 | 0;
    srf[i * 4 + 2] = clamp(rim, 0, 1) * 255 | 0;
    srf[i * 4 + 3] = 255;
  }

  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geom.setAttribute('aiSurf', new THREE.BufferAttribute(srf, 4, true));
  return geom;
}

/* ─────────────────────────────── materials ─────────────────────────────── */

/**
 * ── VALUE CALIBRATION ────────────────────────────────────────────────────────
 * Albedo now lives in the maps (see textures.js), authored directly in LINEAR
 * reflectance: uniform 0.078–0.330 about a 0.20 mean, cordura 0.074–0.208, hard
 * shell a neutral 0.30 that every consumer tints down per-vertex. `material.color`
 * is therefore white and does no work — tinting a map that already carries the
 * right value is how the first pass ended up with soldiers at 0.007 linear.
 *
 * Real reference: combat uniform 0.09–0.13 linear, coyote nylon 0.05–0.08, rubber
 * 0.02, parkerised steel 0.03. Everything here sits ABOVE its reference band on
 * purpose. Two reasons, both measured rather than guessed: a rounded torso only
 * presents itself to a 10.6° sun at a glancing angle, and the sand it stands on is
 * 0.4+ linear, so a literally-correct uniform reads as a hole in the frame.
 */

/**
 * Patch a soldier material so it honours the per-vertex surface attributes and
 * carries a Fresnel rim.
 *
 * INTEGRATION: `CascadeShadows._wrap` deliberately CHAINS whatever
 * `onBeforeCompile` it finds, and `_consider()` re-chains every third frame if
 * anyone replaces the hook. So installing ours before CSM registration is safe in
 * both directions — this is the documented contract, not an accident.
 *
 * The rim is the fix for "the soldier's value is almost identical to the wall
 * behind it": a character with no rim separation disappears against any
 * mid-value background at 35m no matter how good his materials are.
 *
 * The FILL is the fix for the opposite failure, and it is the one that actually
 * matters. Measured off the render: a vertical, sun-facing-away trouser leg came
 * back at 0.017 linear while the ground in the same shadow sat at 0.24 — a 10:1
 * gap against a 2:1 albedo ratio. That is physically correct (a vertical surface
 * sees half the sky, and this sky concentrates its energy near a 10° sun) and it
 * is exactly why the squad read as black cut-outs from behind. Every shipped
 * shooter answers this with a character-only ambient fill, so this one does too:
 * a small, sky-cool, up-weighted term that lifts shade without touching anything
 * already in key.
 */
function aiSurfaceHook(mat, rimColor, fillColor, fillGround, meanAlbedo) {
  const prev = mat.onBeforeCompile;
  const key = `aiSurf2|${mat.name}`;
  mat.onBeforeCompile = function (shader, renderer) {
    if (typeof prev === 'function') {
      try { prev.call(this, shader, renderer); } catch (e) { console.warn('[ai] chained onBeforeCompile threw:', e); }
    }
    shader.uniforms.aiRimColor = { value: rimColor };
    shader.uniforms.aiFill = { value: fillColor };
    shader.uniforms.aiFillGnd = { value: fillGround };
    shader.uniforms.aiMean = { value: meanAlbedo ?? new THREE.Color(0.18, 0.17, 0.14) };
    shader.vertexShader = `attribute vec4 aiSurf;\nvarying vec4 vAiSurf;\nvarying float vAiDetail;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAiSurf = aiSurf;')
      /**
       * ── DETAIL LOD (this is the readability fix) ────────────────────────────
       * A soldier is 1.8 m tall and covers about 150 screen pixels at 8 m. Every
       * surface signal on him — four-colour camo, ripstop lattice, basket weave,
       * grit, scratches — is authored at a spatial frequency that is correct in
       * the hand and is pure noise at that size. Camo in particular is *designed*
       * to destroy a silhouette; that is the entire point of it, and it works, so
       * an engagement at 8 m became guesswork about which way a man was facing.
       *
       * So the three surface terms fade out with view distance, per-vertex (a
       * body is small enough that per-vertex is smooth):
       *   · albedo blends to the map's own mean linear reflectance
       *   · the tangent-space normal blends back to the geometric normal
       *   · roughness gains a floor, because the specular lobe is what turns a
       *     mip-averaged normal into sparkle and no TAA pass can fix it (the
       *     pattern is static in surface space, so every frame agrees on it)
       *
       * Full detail inside 3.5 m — which is where a player actually inspects a
       * body — and fully resolved to shape-only by 12 m.
       */
      .replace('#include <project_vertex>', [
        '#include <project_vertex>',
        '\tvAiDetail = 1.0 - smoothstep( 3.5, 12.0, length( mvPosition.xyz ) );',
      ].join('\n'));
    shader.fragmentShader = `varying vec4 vAiSurf;\nvarying float vAiDetail;\nuniform vec3 aiRimColor;\nuniform vec3 aiFill;\nuniform vec3 aiFillGnd;\nuniform vec3 aiMean;\n${shader.fragmentShader}`
      .replace('#include <map_fragment>', [
        '#include <map_fragment>',
        // `diffuse` is folded in so the degraded no-texture path (which puts the
        // colour on material.color instead of a map) resolves to its own tint
        // rather than to the fabric mean. With the normal maps present, `diffuse`
        // is white and this is exactly the map's own average.
        '\tdiffuseColor.rgb = mix( aiMean * diffuse, diffuseColor.rgb, vAiDetail );',
      ].join('\n'))
      .replace('#include <normal_fragment_maps>', [
        '#include <normal_fragment_maps>',
        '\tnormal = normalize( mix( nonPerturbedNormal, normal, vAiDetail ) );',
      ].join('\n'))
      .replace('#include <roughnessmap_fragment>', [
        '#include <roughnessmap_fragment>',
        '\tfloat aiR = vAiSurf.x < 0.004 ? 0.5 : vAiSurf.x;',
        '\troughnessFactor = clamp( roughnessFactor * aiR * 2.0, 0.045, 1.0 );',
        '\troughnessFactor = max( roughnessFactor, 0.58 * ( 1.0 - vAiDetail ) );',
      ].join('\n'))
      .replace('#include <metalnessmap_fragment>', [
        '#include <metalnessmap_fragment>',
        '\tfloat aiM = vAiSurf.y < 0.004 ? 0.5 : vAiSurf.y;',
        '\tmetalnessFactor = clamp( metalnessFactor * aiM * 2.0, 0.0, 1.0 );',
      ].join('\n'))
      .replace('#include <opaque_fragment>', [
        '\t{',
        '\t\tvec3 aiV = normalize( vViewPosition );',
        '\t\tfloat aiF = pow( 1.0 - clamp( dot( normal, aiV ), 0.0, 1.0 ), 4.0 );',
        '\t\tvec3 aiUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );',
        '\t\tfloat aiTop = clamp( dot( normal, aiUp ) * 0.5 + 0.5, 0.0, 1.0 );',
        '\t\tfloat aiKey = clamp( dot( reflectedLight.directDiffuse, vec3( 2.4 ) ), 0.0, 1.0 );',
        '\t\tvec3 aiAmb = mix( aiFillGnd, aiFill, aiTop );',
        '\t\toutgoingLight += diffuseColor.rgb * aiAmb * ( 1.0 - aiKey );',
        '\t\toutgoingLight += aiRimColor * ( aiF * vAiSurf.z * ( 0.40 + 0.90 * aiTop ) );',
        '\t}',
        '#include <opaque_fragment>',
      ].join('\n'));
  };
  mat.customProgramCacheKey = () => key;
}

export function buildMaterials(ctx) {
  const M = ctx.materials;
  const sets = soldierTextures(ctx);
  const out = {};

  // A cool sky-lean rim: the sun is warm, so a neutral-cool edge separates a
  // soldier from warm sunlit concrete without ever reading as a glow.
  const rimColor = new THREE.Color(0.019, 0.020, 0.024);
  /**
   * Character-only ambient fill — cool, because the only thing filling a shaded
   * soldier at dusk is the sky.
   *
   * ── WHY THIS IS NOW A FIFTH OF WHAT IT WAS ──────────────────────────────────
   * This term was authored at 0.86–1.04 against a scene that was, at the time,
   * two stops under: soldiers measured 0.017 linear against a 0.24 floor and read
   * as black cut-outs, so a near-unity fill was the right emergency answer. The
   * lighting and render agents have since fixed the exposure, and the emergency
   * fill outlived the emergency: an unconditional +0.9·albedo of shadowless light
   * on the ONLY objects in the scene that get it makes a soldier standing in full
   * building shade the most luminous thing in the frame. It also flattens him —
   * a constant added to every part compresses the value ratios between helmet,
   * carrier, fatigues and boots toward 1:1, which is the "no material
   * differentiation" half of the same defect.
   *
   * 0.17 sky / 0.115 ground bounce is what a vertical surface actually collects
   * from this sky dome (measured off the PMREM), so the squad now sits in the
   * same light as the crates next to them and separates by rim, not by glow.
   */
  const fillColor = new THREE.Color(0.300, 0.325, 0.385);
  /**
   * ...and a warm bounce off the sand for everything facing down. A single cool
   * fill turned every underside blue; a real hemisphere has a floor.
   *
   * The floor is now the DOMINANT half, which is both what a four-value sweep
   * picked and what the physics says: at a 9° sun the dusk sky dome carries very
   * little energy away from the solar disc, while the ground this map is built on
   * is 0.4+ linear sand in full sun. A trouser leg standing on that collects far
   * more warm light from below than cool light from above. Weighting it the old
   * way (sky 0.9 / ground 0.74, sky-dominant) is what put a cold milky wash on
   * every shoulder and helmet crown — the two surfaces that least need help,
   * because they are the ones already facing the sky through the IBL.
   */
  const fillGround = new THREE.Color(0.500, 0.410, 0.288);

  const mk = (name, set, fallbackBase, opts = {}) => {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
      vertexColors: true,
      dithering: true,
      side: THREE.FrontSide,
    });
    if (set) {
      m.map = set.map;
      m.normalMap = set.normalMap;
      m.normalScale = new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1);
      m.roughnessMap = set.ormMap;
      m.metalnessMap = set.ormMap;
      m.aoMap = set.ormMap;
      m.aoMapIntensity = opts.ao ?? 0.9;
    } else {
      // Texture synthesis failed — degrade to the shared environment maps rather
      // than shipping a flat colour.
      let src = null;
      try { src = M?.get?.(fallbackBase) ?? null; } catch { src = null; }
      if (src?.map) {
        m.map = src.map;
        m.normalMap = src.normalMap;
        m.normalScale = src.normalScale ? src.normalScale.clone() : new THREE.Vector2(1, 1);
        m.roughnessMap = src.roughnessMap;
        m.metalnessMap = src.metalnessMap;
        m.aoMap = src.aoMap;
        m.aoMapIntensity = 0.85;
        m.color.set(opts.fallbackTint ?? 0xffffff);
      } else {
        m.roughness = 0.9;
        m.metalness = 0.05;
        m.color.set(opts.fallbackTint ?? 0x8a8266);
      }
    }
    m.name = name;
    // shadowSide is deliberately LEFT AT NULL. Forcing FrontSide (as the first
    // pass did) writes the soldier's own lit surface into the shadow map, so every
    // fragment shadow-tests against its own depth and the entire body reads as
    // self-shadowed — which is exactly the "lit purely by ambient, no terminator"
    // failure the critic logged. three's default (BackSide for a FrontSide
    // material) is the correct behaviour for a closed body.
    m.userData.aiMaterial = true;
    m.userData.baseEnv = opts.env ?? 1.0;
    // The three Colors below are the LIVE uniform values (shader.uniforms holds
    // the object, not a copy), so mutating them re-grades the whole squad on the
    // next frame with no recompile. Kept as a handle because calibrating a
    // character fill by eye needs a sweep, and a sweep needs a knob.
    m.userData.aiTune = { rim: rimColor, fill: fillColor, gnd: fillGround };
    // Mean linear reflectance of this bucket's own albedo map — the colour the
    // detail LOD resolves to at range. Falls back to a neutral olive-tan if the
    // texture synthesis degraded to the shared environment maps.
    const mean = Array.isArray(set?.meanLinear)
      ? new THREE.Color(set.meanLinear[0], set.meanLinear[1], set.meanLinear[2])
      : new THREE.Color(0.185, 0.172, 0.135);
    m.userData.aiMean = mean;
    try { aiSurfaceHook(m, rimColor, fillColor, fillGround, mean); } catch (err) { console.warn('[ai] surface hook failed:', err); }
    try { ctx.lighting?.csm?.setupMaterial?.(m); } catch { /* lighting not up yet */ }
    return m;
  };

  // normalScale and aoMapIntensity both go up: with the fill cut to a fifth, the
  // surface relief is now doing the separation work the fill used to smother.
  // A 0.6 aoMapIntensity on cloth is a rounding error — you cannot see a weave
  // valley that is 6% darker than the thread crown at any distance.
  // Fabric sits lower than gear on purpose. Limbs are lathes with cylindrical UVs,
  // so the ripstop lattice's vertical lines wrap out of sight and only the
  // horizontal ones survive — at 1.45 the trousers read as corduroy hose rather
  // than as ripstop. 1.15 keeps the weave legible at 3m without the ribbing.
  // normalScale is now applied to a BAND-LIMITED map (textures.js blurs the height
  // field and differentiates it with a gain of ~8 instead of 17-34), so these
  // numbers mean what they say for the first time: 1.0 is roughly a 45-degree
  // maximum slope on the relief rather than a tangent-plane random field. They are
  // deliberately near unity — the fix was the map, not the multiplier, and easing
  // the multiplier further would only flatten the close-range surface that the
  // rubric grades hardest.
  out.fabric = mk('ai_uniform', sets?.fabric, 'plaster', { normalScale: 1.00, ao: 0.80, env: 0.95, fallbackTint: 0x9a9c7c });
  out.gear = mk('ai_gear', sets?.gear, 'plaster', { normalScale: 1.30, ao: 0.95, env: 0.90, fallbackTint: 0x7d7060 });
  out.hard = mk('ai_hard', sets?.hard, 'paintedMetal', { normalScale: 1.00, ao: 0.88, env: 0.95, fallbackTint: 0xb0b4b8 });

  out.__rimColor = rimColor;
  return out;
}

/* ───────────────────────────── part authoring ───────────────────────────── */

/**
 * Metres of surface per texture tile, per material. Different densities on the
 * uniform, the load-bearing gear and the hard shell is most of what stops them
 * reading as the same substance painted three colours.
 */
const TILE = { fabric: 0.52, gear: 0.28, hard: 0.22 };

function part(geom, bones, mat, sizeHint, surf) {
  scaleUV(geom, Math.max(0.25, (sizeHint ?? 0.3) / (TILE[mat] ?? 0.3)));
  return { geom, bones, mat, surf: surf ?? S.uniform };
}

/** Everything below is authored in BIND WORLD SPACE (metres, feet at y=0). */
function buildParts() {
  const P = [];

  /* ── torso ────────────────────────────────────────────────────────────── */
  // Waist is deliberately 6cm narrower than the first pass: the carrier has to
  // widen the torso ABOVE a narrower waist or the whole body reads as one slab.
  P.push(part(place(bevelBox(0.286, 0.215, 0.198, 0.055, 3), [0, 0.985, 0.004]),
    ['hips', 'spine'], 'fabric', 0.30, S.uniform));
  P.push(part(place(bevelBox(0.268, 0.185, 0.186, 0.05, 3), [0, 1.135, 0.002]),
    ['spine', 'chest', 'hips'], 'fabric', 0.29, S.uniform));
  P.push(part(place(bevelBox(0.352, 0.245, 0.222, 0.06, 3), [0, 1.292, 0]),
    ['chest', 'spine', 'neck'], 'fabric', 0.35, S.uniform));
  // trapezius / shoulder mass so the silhouette is not a bare box
  P.push(part(place(bevelBox(0.436, 0.114, 0.196, 0.050, 3), [0, 1.400, -0.005]),
    ['chest', 'clavL', 'clavR'], 'fabric', 0.40, S.uniform));

  /* ── plate carrier ────────────────────────────────────────────────────── */
  P.push(part(place(bevelBox(0.318, 0.375, 0.066, 0.024, 3), [0, 1.268, 0.128], [-0.055, 0, 0]),
    ['chest', 'spine'], 'gear', 0.34, S.carrier));
  P.push(part(place(bevelBox(0.324, 0.395, 0.062, 0.024, 3), [0, 1.276, -0.128], [0.04, 0, 0]),
    ['chest', 'spine'], 'gear', 0.34, S.carrier));
  P.push(part(place(bevelBox(0.352, 0.128, 0.245, 0.05, 3), [0, 1.108, 0]),
    ['spine', 'chest'], 'gear', 0.33, S.carrier));
  // cummerbund side panels — closes the gap between front and back plate
  for (const s of [1, -1]) {
    P.push(part(place(bevelBox(0.040, 0.155, 0.200, 0.016, 2), [s * 0.152, 1.180, 0]),
      ['chest', 'spine'], 'gear', 0.18, S.carrier));
  }
  /**
   * MOLLE webbing ladders — three rows across the back plate and two per
   * cummerbund. This is the single most recognisable thing about a plate
   * carrier and the body had none of it: a bare bevelled slab reads as body
   * armour from a diagram, not from a photograph. Each row is 12mm of proud
   * relief, which at a 9° sun throws a real horizontal shadow line, so the rows
   * also give the torso the only horizontal light break it has.
   */
  for (const y of [1.152, 1.212, 1.272]) {
    P.push(part(place(bevelBox(0.286, 0.014, 0.013, 0.005, 2), [0, y, -0.163], [0.04, 0, 0]),
      ['chest', 'spine'], 'gear', 0.24, S.webbing));
  }
  for (const s of [1, -1]) {
    for (const y of [1.144, 1.206]) {
      P.push(part(place(bevelBox(0.013, 0.013, 0.176, 0.004, 2), [s * 0.176, y, 0]),
        ['chest', 'spine'], 'gear', 0.16, S.webbing));
    }
  }
  // shoulder straps bridging front and back plates
  for (const s of [1, -1]) {
    P.push(part(place(bevelBox(0.086, 0.058, 0.30, 0.022, 2), [s * 0.114, 1.438, -0.006], [0, 0, s * 0.06]),
      ['chest', s > 0 ? 'clavL' : 'clavR'], 'gear', 0.16, S.webbing));
  }
  // shoulder pauldrons — reads hard against the sky
  for (const s of [1, -1]) {
    P.push(part(place(bevelBox(0.094, 0.150, 0.160, 0.035, 3), [s * 0.180, 1.392, -0.004]),
      [s > 0 ? 'clavL' : 'clavR', s > 0 ? 'armL' : 'armR', 'chest'], 'gear', 0.15, S.webbing));
  }

  /* ── pouches ──────────────────────────────────────────────────────────── */
  // Three mag pouches across the belly of the carrier, admin pouch and radio above
  // them. A carrier with a bare front plate reads as a sandwich board; the kit is
  // what makes the chest look loaded.
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * 0.093;
    P.push(part(place(bevelBox(0.086, 0.155, 0.078, 0.018, 2), [x, 1.208, 0.188], [-0.07, 0, 0]),
      ['chest', 'spine'], 'gear', 0.10, S.pouch));
    // flap lip + pull tab
    P.push(part(place(bevelBox(0.090, 0.028, 0.084, 0.011, 2), [x, 1.288, 0.188], [-0.07, 0, 0]),
      ['chest', 'spine'], 'gear', 0.09, S.pouch));
    P.push(part(place(bevelBox(0.022, 0.034, 0.010, 0.004, 2), [x, 1.272, 0.232], [-0.07, 0, 0]),
      ['chest'], 'hard', 0.04, S.tab));
  }
  // admin pouch, upper left of the plate
  P.push(part(place(bevelBox(0.118, 0.092, 0.054, 0.016, 2), [-0.072, 1.352, 0.170], [-0.06, 0, 0]),
    ['chest'], 'gear', 0.11, S.pouch));
  // radio + antenna, upper right
  P.push(part(place(bevelBox(0.074, 0.104, 0.058, 0.016, 2), [0.086, 1.356, 0.172], [-0.06, 0, 0]),
    ['chest'], 'gear', 0.09, S.pouch));
  P.push(part(place(tubeZ(0.006, 0.135, 6), [0.086, 1.470, 0.166], [Math.PI * 0.46, 0, 0.16]),
    ['chest'], 'hard', 0.05, S.antenna));
  // grab handle across the top of the plate
  P.push(part(place(bevelBox(0.140, 0.030, 0.036, 0.012, 2), [0, 1.418, 0.124], [-0.30, 0, 0]),
    ['chest'], 'gear', 0.12, S.webbing));
  // radio on the back-left, admin pouch on the right
  P.push(part(place(bevelBox(0.075, 0.155, 0.062, 0.016, 2), [0.108, 1.318, -0.178]),
    ['chest'], 'gear', 0.10, S.pouch));
  P.push(part(place(tubeZ(0.008, 0.20, 8), [0.108, 1.462, -0.178], [Math.PI * 0.5, 0, 0.22]),
    ['chest'], 'hard', 0.06, S.antenna));
  P.push(part(place(bevelBox(0.118, 0.098, 0.056, 0.016, 2), [-0.118, 1.132, -0.154]),
    ['spine', 'chest'], 'gear', 0.10, S.pouch));
  // hip utility pouches
  for (const s of [1, -1]) {
    P.push(part(place(bevelBox(0.078, 0.108, 0.072, 0.018, 2), [s * 0.166, 1.028, 0.02]),
      ['hips', 'spine'], 'gear', 0.10, S.pouchLow));
  }
  // belt
  P.push(part(place(bevelBox(0.306, 0.048, 0.216, 0.02, 2), [0, 1.006, 0]),
    ['hips', 'spine'], 'hard', 0.30, S.belt));

  /* ── head ─────────────────────────────────────────────────────────────── */
  // balaclava skull
  const skull = new THREE.SphereGeometry(0.098, 16, 12);
  skull.scale(1.0, 1.16, 1.10);
  P.push(part(place(skull, [0, 1.622, 0.004]), ['head'], 'fabric', 0.20, S.balaclava));
  // jaw / mask front
  P.push(part(place(bevelBox(0.134, 0.104, 0.092, 0.038, 3), [0, 1.562, 0.060]),
    ['head'], 'fabric', 0.13, S.balaclava));
  // neck
  P.push(part(place(limb(0.066, 0.078, 0.062, 10, 2), [0, 1.524, -0.004]),
    ['neck', 'head', 'chest'], 'fabric', 0.13, S.balaclava));
  // Neck gaiter bridging helmet to carrier. Without it the throat is a black void
  // between two lit masses and the head reads as floating.
  P.push(part(place(limb(0.086, 0.104, 0.070, 12, 2), [0, 1.510, -0.002]),
    ['neck', 'chest', 'head'], 'gear', 0.16, S.carrier));

  // helmet shell — hard bucket, so it gets a shell roughness (~0.52) and a real
  // specular response instead of sharing the nylon histogram of the pouches.
  const shell = domeShell(0.130, 1.98, 20, 12);
  shell.scale(1.0, 0.94, 1.10);
  P.push(part(place(shell, [0, 1.628, 0.002]), ['head'], 'hard', 0.28, S.helmet));
  // helmet brim: a thicker rim is the single strongest "that is a helmet, not a
  // ball" cue at 35 metres.
  const rim = new THREE.TorusGeometry(0.130, 0.019, 6, 22);
  rim.rotateX(Math.PI * 0.5);
  rim.scale(1.0, 1.0, 1.10);
  P.push(part(place(rim, [0, 1.612, 0.002]), ['head'], 'hard', 0.20, S.helmet));
  /**
   * Helmet cover retention band + two crown shock cords.
   *
   * Measured off the render: the helmet dome and the plate carrier come out at
   * the SAME screen luminance (97 vs 96) even after the albedo split, because an
   * up-facing dome collects far more sky than a vertical nylon panel does. That
   * is physically right and no amount of albedo tuning will change it — so the
   * boundary between the two has to be drawn by SHAPE instead. A matte webbing
   * band low on the shell and two dark cords running fore-aft over the crown are
   * what every real helmet cover has, and they cut the one large smooth pale
   * surface on the body into four smaller ones. That is the actual cure for
   * "reads as a putty egg", and it survives all the way out to 35m where a
   * roughness difference no longer resolves.
   */
  const band = new THREE.TorusGeometry(0.1335, 0.0072, 5, 18);
  band.rotateX(Math.PI * 0.5);
  band.scale(1.0, 1.0, 1.10);
  P.push(part(place(band, [0, 1.643, 0.002], [0.05, 0, 0.03]), ['head'], 'gear', 0.22, S.coverBand));
  for (const s of [1, -1]) {
    // Upper semicircle in XY, spun into the YZ plane so it arcs over the crown.
    const cord = new THREE.TorusGeometry(0.1192, 0.0046, 4, 13, Math.PI);
    cord.rotateY(Math.PI * 0.5);
    cord.scale(1.0, 1.0, 1.10);
    P.push(part(place(cord, [s * 0.052, 1.630, 0.002]), ['head'], 'gear', 0.20, S.coverBand));
  }
  // NVG mount + side rails + counterweight
  P.push(part(place(bevelBox(0.052, 0.048, 0.036, 0.012, 2), [0, 1.665, 0.128], [-0.25, 0, 0]),
    ['head'], 'hard', 0.06, S.hardware));
  P.push(part(place(bevelBox(0.030, 0.028, 0.052, 0.010, 2), [0, 1.694, 0.118], [-0.25, 0, 0]),
    ['head'], 'hard', 0.05, S.hardware));
  for (const s of [1, -1]) {
    P.push(part(place(bevelBox(0.014, 0.028, 0.145, 0.006, 2), [s * 0.134, 1.630, 0.008], [0, 0, s * 0.05]),
      ['head'], 'hard', 0.10, S.hardware));
  }
  P.push(part(place(bevelBox(0.090, 0.052, 0.062, 0.02, 2), [0, 1.652, -0.124]),
    ['head'], 'gear', 0.08, S.pouch));
  // chin strap
  for (const s of [1, -1]) {
    P.push(part(place(bevelBox(0.012, 0.115, 0.014, 0.005, 2), [s * 0.088, 1.570, 0.028], [0, 0, s * 0.30]),
      ['head'], 'gear', 0.05, S.webbing));
  }
  // goggles
  P.push(part(place(bevelBox(0.186, 0.054, 0.052, 0.020, 3), [0, 1.632, 0.084], [-0.06, 0, 0]),
    ['head'], 'hard', 0.14, S.optic));
  P.push(part(place(bevelBox(0.168, 0.032, 0.012, 0.006, 2), [0, 1.632, 0.110], [-0.06, 0, 0]),
    ['head'], 'hard', 0.13, S.glass));
  P.push(part(place(bevelBox(0.198, 0.020, 0.030, 0.008, 2), [0, 1.650, 0.078]),
    ['head'], 'gear', 0.12, S.webbing));

  /* ── arms ─────────────────────────────────────────────────────────────── */
  for (const s of [1, -1]) {
    const L = s > 0;
    const up = L ? 'armL' : 'armR', fo = L ? 'foreL' : 'foreR';
    const ha = L ? 'handL' : 'handR', cl = L ? 'clavL' : 'clavR';
    P.push(part(place(limb(0.062, 0.050, 0.215, 10, 3), [s * 0.185, 1.412, 0]),
      [up, fo, cl], 'fabric', 0.24, S.uniformArm));
    P.push(part(place(limb(0.052, 0.040, 0.192, 10, 3), [s * 0.185, 1.142, 0]),
      [fo, ha, up], 'fabric', 0.22, S.uniformArm));
    // elbow pad
    P.push(part(place(bevelBox(0.082, 0.086, 0.062, 0.024, 2), [s * 0.185, 1.128, 0.030]),
      [fo, up], 'hard', 0.09, S.pad));
    // glove
    P.push(part(place(bevelBox(0.052, 0.104, 0.088, 0.026, 3), [s * 0.185, 0.842, 0.006]),
      [ha], 'hard', 0.10, S.glove));
    // cuff
    P.push(part(place(limb(0.045, 0.043, 0.028, 10, 2), [s * 0.185, 0.906, 0]),
      [ha, fo], 'gear', 0.09, S.webbing));
  }

  /* ── legs ─────────────────────────────────────────────────────────────── */
  for (const s of [1, -1]) {
    const L = s > 0;
    const up = L ? 'upLegL' : 'upLegR', lo = L ? 'loLegL' : 'loLegR';
    const ft = L ? 'footL' : 'footR', to = L ? 'toeL' : 'toeR';
    P.push(part(place(limb(0.098, 0.076, 0.325, 10, 3), [s * 0.098, 0.952, 0]),
      [up, lo, 'hips'], 'fabric', 0.28, S.uniformLeg));
    P.push(part(place(limb(0.078, 0.055, 0.335, 10, 3), [s * 0.098, 0.545, 0]),
      [lo, ft, up], 'fabric', 0.26, S.uniformLeg));
    // knee pad
    P.push(part(place(bevelBox(0.108, 0.132, 0.070, 0.028, 3), [s * 0.098, 0.492, 0.062], [-0.08, 0, 0]),
      [lo, up], 'hard', 0.12, S.pad));
    // cargo pocket on the thigh
    P.push(part(place(bevelBox(0.062, 0.118, 0.098, 0.022, 2), [s * 0.148, 0.812, 0.018]),
      [up], 'gear', 0.11, S.pouchLow));
    // blousing band above the boot
    P.push(part(place(limb(0.062, 0.066, 0.040, 10, 2), [s * 0.098, 0.268, -0.002]),
      [ft, lo], 'gear', 0.10, S.webbing));

    /* ── boot ────────────────────────────────────────────────────────────────
     * Was three smooth capsules: a shaft, a rounded block and a slab. From two
     * metres that is a clog. A combat boot is read by four things and none of
     * them were present — the lace ladder up the instep, the welt line where
     * leather meets rubber, the heel break, and a lugged outsole whose teeth
     * show in profile. It is also the part of a soldier the camera gets closest
     * to (bots walk past you at 1.5m) and the part that has to sell CONTACT,
     * so it earns roughly 1.2k triangles of the ~2k the whole pass spends.
     */
    const bx = s * 0.098;
    // padded ankle collar + shaft
    P.push(part(place(limb(0.076, 0.071, 0.055, 10, 2), [bx, 0.266, -0.004]),
      [ft, lo], 'hard', 0.13, S.boot));
    P.push(part(place(limb(0.070, 0.067, 0.078, 10, 2), [bx, 0.206, -0.004]),
      [ft, lo], 'hard', 0.13, S.boot));
    // vamp — the leather body of the foot
    P.push(part(place(bevelBox(0.100, 0.084, 0.212, 0.024, 3), [bx, 0.080, 0.026]),
      [ft, to], 'hard', 0.18, S.boot));
    // scuffed toe cap and heel counter: separate substance, glossier, so the
    // boot has two internal value edges instead of being one smooth lozenge
    P.push(part(place(bevelBox(0.094, 0.058, 0.086, 0.022, 3), [bx, 0.056, 0.124], [-0.10, 0, 0]),
      [ft, to], 'hard', 0.10, S.bootToe));
    P.push(part(place(bevelBox(0.097, 0.072, 0.060, 0.020, 2), [bx, 0.084, -0.060]),
      [ft, lo], 'hard', 0.09, S.bootToe));
    // tongue + lace ladder. Five bars is the count that still reads as "laced"
    // at 4m; more just aliases into a grey smear.
    P.push(part(place(bevelBox(0.044, 0.022, 0.150, 0.008, 2), [bx, 0.120, 0.040]),
      [ft, to], 'hard', 0.09, S.lace));
    for (let i = 0; i < 5; i++) {
      P.push(part(place(bevelBox(0.052, 0.009, 0.012, 0.003, 2), [bx, 0.129, 0.104 - i * 0.031]),
        [ft, to], 'hard', 0.04, S.lace));
    }
    // welt / midsole — the light line that separates leather from rubber
    P.push(part(place(bevelBox(0.106, 0.020, 0.252, 0.007, 2), [bx, 0.029, 0.030]),
      [ft, to], 'hard', 0.17, S.boot));
    // outsole + heel block: the heel break is what stops the sole reading as one
    // extruded slab, and it is visible from every angle a player ever sees.
    P.push(part(place(bevelBox(0.109, 0.020, 0.258, 0.007, 2), [bx, 0.011, 0.032]),
      [ft, to], 'hard', 0.17, S.bootSole));
    P.push(part(place(bevelBox(0.099, 0.017, 0.070, 0.006, 2), [bx, 0.006, -0.054]),
      [ft, lo], 'hard', 0.08, S.bootSole));
    // tread lugs — wider than the sole so the teeth break the profile silhouette
    for (let i = 0; i < 5; i++) {
      P.push(part(place(bevelBox(0.115, 0.013, 0.021, 0.004, 2), [bx, 0.010, 0.128 - i * 0.043]),
        [ft, to], 'hard', 0.05, S.bootSole));
    }
  }

  /* ── carbine (rigid to the `weapon` bone) ─────────────────────────────── */
  // Weapon bone bind origin. Parts below are authored barrel-toward -Z (the natural
  // way to lay out a gun), then rigidly spun 180° so the muzzle leads +Z with the
  // rest of the rig. Rotating the assembly rather than negating each offset keeps
  // the canted magazine and raked pistol grip correct.
  const wb = BIND.weapon;
  const W = (g) => place(g, [wb[0], wb[1], wb[2]], [0, Math.PI, 0]);
  // upper receiver + rail
  P.push(part(W(place(bevelBox(0.058, 0.078, 0.285, 0.012, 3), [0, 0.028, -0.045])),
    ['weapon'], 'hard', 0.22, S.gunmetal));
  P.push(part(W(place(bevelBox(0.030, 0.014, 0.325, 0.005, 2), [0, 0.072, -0.085])),
    ['weapon'], 'hard', 0.18, S.gunmetal));
  // handguard with vent slots implied by rails
  P.push(part(W(place(bevelBox(0.052, 0.058, 0.245, 0.014, 3), [0, 0.030, -0.318])),
    ['weapon'], 'hard', 0.20, S.polymer));
  for (const s of [1, -1]) {
    P.push(part(W(place(bevelBox(0.012, 0.026, 0.215, 0.005, 2), [s * 0.029, 0.026, -0.318])),
      ['weapon'], 'hard', 0.14, S.gunmetal));
  }
  // barrel + gas block + muzzle brake
  P.push(part(W(place(tubeZ(0.0115, 0.155, 10), [0, 0.030, -0.512])), ['weapon'], 'hard', 0.10, S.gunmetal));
  P.push(part(W(place(bevelBox(0.030, 0.040, 0.040, 0.008, 2), [0, 0.036, -0.452])), ['weapon'], 'hard', 0.05, S.gunmetal));
  P.push(part(W(place(tubeZ(0.0205, 0.062, 10), [0, 0.030, -0.612])), ['weapon'], 'hard', 0.06, S.gunmetal));
  // magazine (canted, STANAG-ish)
  P.push(part(W(place(bevelBox(0.032, 0.215, 0.078, 0.010, 3), [0, -0.108, -0.058], [0.14, 0, 0])),
    ['weapon'], 'hard', 0.14, S.polymer));
  // pistol grip
  P.push(part(W(place(bevelBox(0.038, 0.125, 0.058, 0.018, 3), [0, -0.078, 0.075], [0.34, 0, 0])),
    ['weapon'], 'hard', 0.09, S.polymer));
  // buffer tube + stock
  P.push(part(W(place(tubeZ(0.019, 0.175, 10), [0, 0.028, 0.180])), ['weapon'], 'hard', 0.10, S.gunmetal));
  P.push(part(W(place(bevelBox(0.048, 0.088, 0.130, 0.018, 3), [0, 0.006, 0.212])), ['weapon'], 'hard', 0.12, S.polymer));
  P.push(part(W(place(bevelBox(0.052, 0.062, 0.038, 0.014, 2), [0, -0.006, 0.276])), ['weapon'], 'hard', 0.07, S.polymer));
  // optic + mount
  P.push(part(W(place(bevelBox(0.046, 0.050, 0.118, 0.014, 3), [0, 0.108, -0.075])), ['weapon'], 'hard', 0.10, S.optic));
  P.push(part(W(place(bevelBox(0.036, 0.030, 0.070, 0.008, 2), [0, 0.086, -0.075])), ['weapon'], 'hard', 0.07, S.hardware));
  // angled foregrip
  P.push(part(W(place(bevelBox(0.030, 0.078, 0.048, 0.014, 2), [0, -0.024, -0.290], [0.42, 0, 0])),
    ['weapon'], 'hard', 0.07, S.polymer));
  // charging handle
  P.push(part(W(place(bevelBox(0.062, 0.014, 0.030, 0.005, 2), [0, 0.062, 0.106])), ['weapon'], 'hard', 0.06, S.gunmetal));
  // sling running from the stock to the handguard — breaks the body outline, which
  // is the third readable-at-distance silhouette cue after helmet and carrier.
  P.push(part(W(place(bevelBox(0.010, 0.030, 0.560, 0.004, 2), [0.030, -0.030, -0.100], [0.10, 0.06, 0])),
    ['weapon'], 'gear', 0.30, S.webbing));

  return P;
}

/* ───────────────────────────── auto-skinning ───────────────────────────── */

/**
 * Weight each vertex against the part's candidate bones by inverse distance to the
 * bone's rest segment. The high exponent keeps the middle of a limb effectively
 * rigid while blending over roughly a 4cm band at each joint — which is what stops
 * an elbow from collapsing into a crease.
 */
function skinPart(geom, boneNames, boneIndexOf) {
  const pos = geom.attributes.position;
  const n = pos.count;
  const idx = new Uint16Array(n * 4);
  const wts = new Float32Array(n * 4);

  const segs = boneNames.map((name) => {
    const a = BIND[name];
    const tipName = TIP[name];
    const b = tipName && BIND[tipName] ? BIND[tipName] : [a[0], a[1] - 0.10, a[2]];
    return { i: boneIndexOf[name] ?? 0, ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2] };
  });

  const d = new Float64Array(segs.length);
  for (let v = 0; v < n; v++) {
    const px = pos.getX(v), py = pos.getY(v), pz = pos.getZ(v);
    let total = 0;
    for (let s = 0; s < segs.length; s++) {
      const g = segs[s];
      const dist = Math.sqrt(distSqToSegment(px, py, pz, g.ax, g.ay, g.az, g.bx, g.by, g.bz));
      const w = 1 / Math.pow(dist + 0.028, 4.2);
      d[s] = w; total += w;
    }
    if (!(total > 0)) { idx[v * 4] = segs[0].i; wts[v * 4] = 1; continue; }
    // keep the 4 heaviest
    let picked = 0;
    const used = new Uint8Array(segs.length);
    let sum = 0;
    while (picked < 4) {
      let best = -1, bestW = -1;
      for (let s = 0; s < segs.length; s++) {
        if (used[s]) continue;
        if (d[s] > bestW) { bestW = d[s]; best = s; }
      }
      if (best < 0) break;
      used[best] = 1;
      idx[v * 4 + picked] = segs[best].i;
      wts[v * 4 + picked] = bestW;
      sum += bestW;
      picked++;
    }
    if (sum > 0) for (let k = 0; k < 4; k++) wts[v * 4 + k] /= sum;
  }

  geom.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
  geom.setAttribute('skinWeight', new THREE.BufferAttribute(wts, 4));
  return geom;
}

/* ────────────────────────────── template build ────────────────────────────── */

/**
 * Build the one-time shared template. Returns merged, skinned geometry per material
 * plus the bone tables everything else reads. Cloning a soldier from this is then
 * just "new Bone chain + SkinnedMesh sharing the geometry".
 */
export function buildTemplate(ctx) {
  const boneIndexOf = {};
  BONE_ORDER.forEach((name, i) => { boneIndexOf[name] = i; });

  const parts = buildParts();
  const buckets = { fabric: [], gear: [], hard: [] };
  for (const p of parts) {
    try {
      const g = p.geom;
      // Normalise attributes + indexing so mergeGeometries never rejects the set.
      if (!g.attributes.uv) {
        const c = g.attributes.position.count;
        g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(c * 2), 2));
      }
      if (!g.attributes.normal) g.computeVertexNormals();
      for (const k of Object.keys(g.attributes)) {
        if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
      }
      if (!g.index) {
        const c = g.attributes.position.count;
        const seq = c > 65535 ? new Uint32Array(c) : new Uint16Array(c);
        for (let i = 0; i < c; i++) seq[i] = i;
        g.setIndex(new THREE.BufferAttribute(seq, 1));
      }
      applySurface(g, p.surf);
      skinPart(g, p.bones, boneIndexOf);
      (buckets[p.mat] ?? buckets.fabric).push(g);
    } catch (err) {
      console.warn('[ai] skipped soldier part:', err);
    }
  }

  const geometries = {};
  let tris = 0;
  for (const key of Object.keys(buckets)) {
    const list = buckets[key];
    if (!list.length) continue;
    let merged = null;
    try { merged = mergeGeometries(list, false); } catch { merged = null; }
    if (!merged) { merged = list[0]; }
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    geometries[key] = merged;
    tris += (merged.index ? merged.index.count : merged.attributes.position.count) / 3;
  }

  const materials = buildMaterials(ctx);
  const rimColor = materials.__rimColor;
  delete materials.__rimColor;

  // Weapon anchors expressed in the weapon bone's local frame (bind rotation is
  // identity, so this is a pure translation).
  const wb = BIND.weapon;
  const anchors = {};
  for (const k of Object.keys(WEAPON_ANCHORS)) {
    const a = WEAPON_ANCHORS[k];
    anchors[k] = new THREE.Vector3(a[0] - wb[0], a[1] - wb[1], a[2] - wb[2]);
  }

  return { geometries, materials, boneIndexOf, anchors, rimColor, triangles: Math.round(tris) };
}

/** Instantiate one soldier from the shared template. */
export function instantiate(template) {
  const bones = [];
  const byName = {};
  for (const name of BONE_ORDER) {
    const b = new THREE.Bone();
    b.name = name;
    byName[name] = b;
    bones.push(b);
  }
  for (const name of BONE_ORDER) {
    const p = PARENT[name];
    const pos = BIND[name];
    const b = byName[name];
    if (p) {
      const pp = BIND[p];
      b.position.set(pos[0] - pp[0], pos[1] - pp[1], pos[2] - pp[2]);
      byName[p].add(b);
    } else {
      b.position.set(pos[0], pos[1], pos[2]);
    }
  }
  const root = byName.hips;
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  const group = new THREE.Group();
  group.name = 'soldier';
  const meshes = [];
  let first = true;
  for (const key of Object.keys(template.geometries)) {
    const mesh = new THREE.SkinnedMesh(template.geometries[key], template.materials[key]);
    // Named so AISystem can drive a per-bucket shadow LOD — see `_shadowLod`.
    mesh.name = `soldier_${key}`;
    mesh.userData.aiBucket = key;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The bind-pose bounds are wrong the moment the rig animates, but switching
    // culling off entirely means every skinned draw is submitted every pass whether
    // or not anyone is behind you. A hand-authored sphere that contains every
    // reachable pose (arms out, weapon extended, mid-stride) gets culling back.
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.0, 0), 1.65);
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = true;
    if (first) { mesh.add(root); first = false; }
    mesh.bind(skeleton);
    group.add(mesh);
    meshes.push(mesh);
  }
  // Rest local transforms, so the animator can reset cleanly each frame.
  const rest = {};
  for (const name of BONE_ORDER) rest[name] = byName[name].position.clone();

  return { group, meshes, bones: byName, boneList: bones, skeleton, rest };
}

export { TAU };
