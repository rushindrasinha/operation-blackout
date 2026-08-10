import * as THREE from 'three';

/**
 * OPERATION BLACKOUT — the SURFACE RESPONSE layer.
 * OWNER: materials agent.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * Three separate critic findings turned out to be one root cause, and it is a
 * cause a texture recipe *cannot* fix from inside a 1024² tile:
 *
 *  1. "One shared high-contrast macro grunge mask drives every material — the
 *     container, the barrier and the timber posts all carry the same leopard
 *     print, and it has no relationship to gravity or geometry."
 *  2. "Roughness is a constant per material. The rust blobs and the paint between
 *     them have identical specular response. The barrier's sun-baked top face has
 *     the same sheen as its vertical faces."
 *  3. "The ground has no readable surface — no aggregate, no micro-relief, and the
 *     cracks are painted albedo scribbles with ZERO normal relief."
 *
 * A tile-space texture is *isotropic by construction*. It does not know which way
 * is down, it does not know how high off the ground the texel is, it does not know
 * whether the face it lands on is a wall or a roof, and it cannot know how far the
 * camera is from it. So every weathering mask a recipe authors is necessarily
 * sprayed uniformly — including across the top face of a jersey barrier, which is
 * exactly what the review measured. Worse, the consumers of this library legally
 * scale the normal map down (`ARCH_NORMAL_EASE.concrete = 0.22` in the level) to
 * stop 1-2 m prop detail becoming popcorn on a 90 m yard, and that scaling takes
 * the crack relief down with it — a 3 mm crack authored at full Sobel tilt arrives
 * on the ground at 12° of slope and mips to a flat ink line.
 *
 * This layer bolts a small, uniform-driven fragment stage onto every material the
 * library ships. It runs once, after `<normal_fragment_maps>`, where `diffuseColor`,
 * `roughnessFactor`, `metalnessFactor`, `normal`, `nonPerturbedNormal` and `tbn` are
 * all live, and it does five things a tile cannot:
 *
 *   A. MACRO NORMAL BOOST + DISTANCE FADE. Extrapolates or attenuates the mapped
 *      normal about the geometric normal. Near the camera it restores the relief a
 *      consumer's `normalScale` ease removed (cracks get their lit lip back); past
 *      ~15 m it fades toward flat, which is the mip-attenuation the review asked for
 *      on the burlap weave and the catwalk tread and which stops both crawling.
 *   B. A DETAIL NORMAL + ROUGHNESS at 4-10× the base tile rate, i.e. the 0.15-0.5 m
 *      band. One extra fetch of a texture that is already resident and cache-hot.
 *      This is what makes raking light resolve on the ground.
 *   C. WORLD-ORIENTATION RESPONSE. Up-facing texels chalk (roughness up, value up,
 *      wear washed off); vertical texels keep their grime. A barrier top can finally
 *      differ from a barrier side.
 *   D. GRAVITY-DRIVEN WEAR. The recipes now export their weathering mask in the
 *      unused ALPHA channel of the packed ORM (R=AO G=rough B=metal A=wear) instead
 *      of burning all of it into the albedo. Here it is multiplied by a world-space
 *      downward gradient and a splash-back band at the ground junction, then routed
 *      to BOTH albedo and roughness. Same total contrast, physical placement.
 *   E. A METAL/DIELECTRIC GLOSS SPLIT. `roughnessFactor -= metalness * k`, so the
 *      surviving paint on a drum stays glossy while the rust beside it goes matte —
 *      the split that makes a rusted drum read as steel rather than as pottery.
 *
 * ── INTEGRATION NOTES (hard-won, do not "simplify") ──────────────────────────
 *
 *  · `Material.copy()` in three r185 does NOT copy `onBeforeCompile`, so a plain
 *    subclass-free hook would be silently dropped the moment the level clones a
 *    library material — which it does for every single surface in the map. Hence
 *    the two `Mtl*Material` subclasses: their `copy()` reinstalls the hook, and
 *    because `copy()` deep-clones `userData` the per-material config rides along.
 *  · The injected GLSL is IDENTICAL for every material; everything that varies is a
 *    uniform. That is deliberate. Three's program cache is keyed on material
 *    parameters plus `customProgramCacheKey()`, NOT on the identity of
 *    `onBeforeCompile`, so materials that inject different source but share a key
 *    would silently share one program. Identical source means one key is correct and
 *    we add exactly one program to the cache. Uniform *values* are per-material
 *    (`WebGLRenderer` calls `getUniforms(material)` before every `onBeforeCompile`),
 *    so per-material tuning still works.
 *  · The hook must be installed BEFORE the lighting system's CSM registration and
 *    before the level's ground shader; both chain whatever hook they find, and CSM
 *    re-chains every third frame if anyone replaces it. Installing at construction
 *    is the earliest possible point, so we are always the innermost link.
 */

/* ─────────────────────────── configuration ─────────────────────────── */

/**
 * Every field is in the units the shader wants, so the hook is a straight copy with
 * no per-frame arithmetic.
 *
 *  detailScale   multiplier on the base UV for the detail fetch. Deliberately a
 *                NON-INTEGER around 2-3: the detail layer is the material's own
 *                normal map re-sampled, so an integer multiple would land its
 *                features on top of the base layer's and read as one embossed
 *                pattern instead of two scales of the same substance. At 3.3 on
 *                concrete's 3.2 m tile the recipe's 7 cm float mottle lands at
 *                ~2 cm and its crack net at ~20 cm — the aggregate-and-grit band
 *                the review measured as missing.
 *  detailNormal  amplitude of the detail normal. KEEP LOW on any material whose
 *                normal map contains a periodic structure — corrugation, brick
 *                courses, plank joints, a weave — or the detail fetch reproduces
 *                that structure at 1/detailScale of its size and you get a moiré
 *                barcode. Aperiodic materials (concrete, asphalt, gravel, plaster,
 *                rust) can take it at full strength.
 *  detailRough   how much the detail slope drives roughness (the "micro-glints
 *                instead of a flat wash" ask)
 *  normalBoost   1 = mapped normal untouched, >1 restores relief a consumer eased
 *                off, <1 softens an over-strong map
 *  fadeStart/End metres over which normalBoost lerps to farBoost
 *  detailFade    metres at which the detail normal has fully faded out
 *  wearRough     how far a full wear mask drags roughness TOWARD 1.0. Not an
 *                additive delta: the recipes author right up to their own ceiling
 *                and a += clipped the top third of every authored spread onto a
 *                flat 1.0, which is the exact "uniform roughness" tell this pass
 *                exists to remove. A mix() cannot clip.
 *  wearDark      how hard the wear tint multiplies the albedo
 *  splashH       metres above the ground over which the splash-back band runs
 *  splashAmt     extra wear added at the very bottom of a vertical face
 *  topRough      same mix()-toward-matte units as wearRough, on a fully up-facing
 *                texel (sun-baked chalk)
 *  topLift       albedo lift on a fully up-facing texel (settled dust)
 *  topWearKill   fraction of the wear mask rain scours off an up-facing texel
 *  metalGloss    how far a fully metallic texel is dragged toward gloss (0.145).
 *                Scaled by the metalness map, so it fires ONLY on the surviving
 *                bare/painted steel and never on the oxide — that split is what
 *                makes a rusted drum read as steel rather than as pottery, and it
 *                costs nothing because metalness already rides in the packed ORM.
 *  tint          the colour the wear mask multiplies toward
 */
const DEFAULT = {
  detailScale: 2.7, detailNormal: 0.30, detailRough: 0.10, normalBoost: 1.0,
  fadeStart: 6.0, fadeEnd: 26.0, farBoost: 0.55, detailFade: 16.0,
  wearRough: 0.16, wearDark: 0.24, splashH: 0.0, splashAmt: 0.0,
  topRough: 0.09, topLift: 0.03, topWearKill: 0.5, metalGloss: 0.10,
  tint: [0.72, 0.68, 0.62],
};

export const SURFACE = {
  /**
   * The yard. Detail at 3.2 m / 8 = 40 cm — the aggregate/grit/tyre-scuff band the
   * review said was the missing layer, and the reason a 22 %-of-frame plane read as
   * untextured. `normalBoost` 1.45 buys back the crack relief the level's 0.22
   * normal ease removes; cracks are the only thing left in this recipe's height
   * field with a steep gradient, so boosting cannot bring the old popcorn back.
   * splash: 45 cm of darkening and roughening where anything meets the slab.
   */
  concrete: {
    detailScale: 3.3, detailNormal: 0.30, detailRough: 0.12, normalBoost: 1.28,
    fadeStart: 5.0, fadeEnd: 26.0, farBoost: 0.55, detailFade: 13.0,
    wearRough: 0.19, wearDark: 0.30, splashH: 0.50, splashAmt: 0.30,
    topRough: 0.13, topLift: 0.045, topWearKill: 0.42, metalGloss: 0.0,
    tint: [0.64, 0.625, 0.60],
  },
  asphalt: {
    detailScale: 2.9, detailNormal: 0.30, detailRough: 0.12, normalBoost: 1.25,
    fadeStart: 5.0, fadeEnd: 26.0, farBoost: 0.52, detailFade: 13.0,
    wearRough: 0.16, wearDark: 0.22, splashH: 0.40, splashAmt: 0.24,
    topRough: 0.08, topLift: 0.03, topWearKill: 0.35, metalGloss: 0.0,
    tint: [0.70, 0.69, 0.68],
  },
  gravel: {
    detailScale: 2.6, detailNormal: 0.28, detailRough: 0.11, normalBoost: 1.12,
    fadeStart: 6.0, fadeEnd: 26.0, farBoost: 0.50, detailFade: 15.0,
    wearRough: 0.14, wearDark: 0.20, splashH: 0.35, splashAmt: 0.18,
    topRough: 0.10, topLift: 0.05, topWearKill: 0.3, metalGloss: 0.0,
    tint: [0.74, 0.70, 0.63],
  },

  /**
   * Containers and cladding. The corrugation is a SINUSOID in the normal map, so a
   * detail fetch at 6× would print a 5 cm ripple over the 30 cm profile — the exact
   * moiré barcode the earlier reviews complained about. Detail normal is therefore
   * nearly off and the work is done by the wear channel instead: the rust mask now
   * arrives here at 60 % of its old albedo strength and gets the other 40 % back
   * *multiplied by gravity*, so it pools low, streaks down and stays off the roof.
   * metalGloss 0.22 is the rust-vs-surviving-paint specular split.
   */
  corrugatedMetal: {
    detailScale: 2.3, detailNormal: 0.07, detailRough: 0.09, normalBoost: 1.0,
    fadeStart: 5.0, fadeEnd: 22.0, farBoost: 0.45, detailFade: 12.0,
    wearRough: 0.12, wearDark: 0.34, splashH: 1.10, splashAmt: 0.30,
    topRough: 0.16, topLift: 0.05, topWearKill: 0.62, metalGloss: 1.00,
    tint: [0.82, 0.62, 0.46],
  },
  rustMetal: {
    detailScale: 2.7, detailNormal: 0.26, detailRough: 0.12, normalBoost: 1.05,
    fadeStart: 5.0, fadeEnd: 22.0, farBoost: 0.45, detailFade: 12.0,
    wearRough: 0.12, wearDark: 0.32, splashH: 0.65, splashAmt: 0.26,
    topRough: 0.15, topLift: 0.045, topWearKill: 0.55, metalGloss: 1.05,
    tint: [0.84, 0.63, 0.47],
  },
  /**
   * Walkway gratings and doors. The tread pattern is periodic, so detail normal
   * stays low; the fade is aggressive because the catwalk is the one surface the
   * review caught moiréing into a shimmering mesh at 12 m.
   */
  paintedMetal: {
    detailScale: 2.9, detailNormal: 0.08, detailRough: 0.08, normalBoost: 0.90,
    fadeStart: 3.5, fadeEnd: 13.0, farBoost: 0.22, detailFade: 8.0,
    wearRough: 0.16, wearDark: 0.30, splashH: 0.55, splashAmt: 0.24,
    topRough: 0.14, topLift: 0.04, topWearKill: 0.55, metalGloss: 0.95,
    tint: [0.66, 0.60, 0.52],
  },

  /**
   * Burlap. Detail normal OFF and the strongest fade in the library: the review
   * caught individually-resolvable threads sparkling at 3-6 m, which is a weave
   * whose normal is not mip-attenuated. By 12 m it is down to 28 % and reads as the
   * soft directional texture a real sandbag wall has at that distance.
   */
  sandbags: {
    detailScale: 2.1, detailNormal: 0.0, detailRough: 0.06, normalBoost: 0.90,
    fadeStart: 3.0, fadeEnd: 13.0, farBoost: 0.28, detailFade: 6.0,
    wearRough: 0.14, wearDark: 0.26, splashH: 0.30, splashAmt: 0.22,
    topRough: 0.12, topLift: 0.05, topWearKill: 0.35, metalGloss: 0.0,
    tint: [0.68, 0.62, 0.50],
  },
  fabric: {
    detailScale: 2.1, detailNormal: 0.0, detailRough: 0.05, normalBoost: 0.92,
    fadeStart: 3.5, fadeEnd: 14.0, farBoost: 0.30, detailFade: 7.0,
    wearRough: 0.12, wearDark: 0.20, splashH: 0.0, splashAmt: 0.0,
    topRough: 0.10, topLift: 0.035, topWearKill: 0.3, metalGloss: 0.0,
    tint: [0.70, 0.68, 0.60],
  },
  tarp: {
    detailScale: 2.1, detailNormal: 0.06, detailRough: 0.06, normalBoost: 0.95,
    fadeStart: 4.0, fadeEnd: 16.0, farBoost: 0.35, detailFade: 8.0,
    wearRough: 0.14, wearDark: 0.22, splashH: 0.0, splashAmt: 0.0,
    topRough: 0.11, topLift: 0.04, topWearKill: 0.35, metalGloss: 0.0,
    tint: [0.68, 0.66, 0.60],
  },

  /** Plank joints are periodic; keep the detail low and let the wear do the work. */
  wood: {
    detailScale: 2.3, detailNormal: 0.12, detailRough: 0.10, normalBoost: 1.05,
    fadeStart: 5.0, fadeEnd: 20.0, farBoost: 0.42, detailFade: 11.0,
    wearRough: 0.18, wearDark: 0.30, splashH: 0.45, splashAmt: 0.30,
    topRough: 0.14, topLift: 0.05, topWearKill: 0.30, metalGloss: 0.0,
    tint: [0.62, 0.56, 0.47],
  },
  plaster: {
    detailScale: 3.1, detailNormal: 0.26, detailRough: 0.11, normalBoost: 1.22,
    fadeStart: 6.0, fadeEnd: 26.0, farBoost: 0.50, detailFade: 15.0,
    wearRough: 0.18, wearDark: 0.26, splashH: 0.60, splashAmt: 0.34,
    topRough: 0.12, topLift: 0.04, topWearKill: 0.45, metalGloss: 0.0,
    tint: [0.63, 0.60, 0.55],
  },
  /** Brick courses are periodic — detail normal stays near zero. */
  brick: {
    detailScale: 2.7, detailNormal: 0.09, detailRough: 0.10, normalBoost: 1.0,
    fadeStart: 6.0, fadeEnd: 24.0, farBoost: 0.45, detailFade: 12.0,
    wearRough: 0.16, wearDark: 0.26, splashH: 0.55, splashAmt: 0.30,
    topRough: 0.11, topLift: 0.04, topWearKill: 0.4, metalGloss: 0.0,
    tint: [0.64, 0.60, 0.55],
  },
  rubber: {
    detailScale: 2.5, detailNormal: 0.20, detailRough: 0.08, normalBoost: 1.0,
    fadeStart: 4.0, fadeEnd: 16.0, farBoost: 0.40, detailFade: 9.0,
    wearRough: 0.10, wearDark: 0.16, splashH: 0.0, splashAmt: 0.0,
    topRough: 0.09, topLift: 0.05, topWearKill: 0.3, metalGloss: 0.0,
    tint: [0.78, 0.76, 0.72],
  },
  /** Glass gets the distance fade and nothing else — no grime maths on a window. */
  glass: {
    detailScale: 2.0, detailNormal: 0.0, detailRough: 0.0, normalBoost: 1.0,
    fadeStart: 6.0, fadeEnd: 24.0, farBoost: 0.45, detailFade: 4.0,
    wearRough: 0.05, wearDark: 0.06, splashH: 0.0, splashAmt: 0.0,
    topRough: 0.0, topLift: 0.0, topWearKill: 0.0, metalGloss: 0.0,
    tint: [0.92, 0.92, 0.90],
  },
};

/** Flatten a config to the six numbers-blocks the shader consumes. */
export function packSurface(name) {
  const c = { ...DEFAULT, ...(SURFACE[name] ?? {}) };
  return [
    c.detailScale, c.detailNormal, c.detailRough, c.normalBoost,
    c.fadeStart, c.fadeEnd, c.farBoost, c.detailFade,
    c.wearRough, c.wearDark, c.splashH, c.splashAmt,
    c.topRough, c.topLift, c.topWearKill, c.metalGloss,
    c.tint[0], c.tint[1], c.tint[2],
  ];
}

/* ───────────────────────────── the shader ───────────────────────────── */

const PARS = /* glsl */`
uniform vec4 uMtlDet;    // x detailScale  y detailNormal  z detailRough  w normalBoost
uniform vec4 uMtlFade;   // x fadeStart    y fadeEnd       z farBoost     w detailFade
uniform vec4 uMtlWear;   // x wearRough    y wearDark      z splashH      w splashAmt
uniform vec4 uMtlTop;    // x topRough     y topLift       z topWearKill  w metalGloss
uniform vec3 uMtlTint;
varying vec2 vMtlW;        // x = world height (m)   y = world normal Y
`;

const VERT_PARS = /* glsl */`
varying vec2 vMtlW;
`;

/**
 * The world-space facing term is computed HERE, per vertex, not per fragment.
 *
 * It started life as an `inverseTransformDirection( normal, viewMatrix )` in the
 * fragment stage, which is a mat4 multiply and a normalize on every pixel of every
 * opaque surface in the frame — measurable, and completely wasted: the term decides
 * whether a texel is on a roof or on a wall, and that is a property of the GEOMETRY.
 * Feeding it the normal-mapped normal actually made it worse, because aggregate
 * bumps then flickered the "is this a top face" decision at the texel level.
 */
const VERT_NORMAL = /* glsl */`
  vMtlW.y = inverseTransformDirection( transformedNormal, viewMatrix ).y;
`;

/**
 * Mirrors three's own `worldpos_vertex` so batching and instancing are handled,
 * without depending on that chunk actually being compiled in (it is gated behind
 * USE_SHADOWMAP / USE_ENVMAP and we must not care).
 */
const VERT_BODY = /* glsl */`
  vec4 mtlWP = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    mtlWP = batchingMatrix * mtlWP;
  #endif
  #ifdef USE_INSTANCING
    mtlWP = instanceMatrix * mtlWP;
  #endif
  vMtlW.x = ( modelMatrix * mtlWP ).y;
`;

const FRAG_BODY = /* glsl */`
{
  float mtlDist = length( vViewPosition );

  /**
   * ── A + B. one relief pass, ONE normalize ────────────────────────────────
   *
   * Macro boost (restore the relief a consumer's normalScale ease removed near the
   * camera, attenuate it far away so the weave and the tread stop crawling) and the
   * high-frequency detail layer are accumulated into the same unnormalised vector
   * and normalised once. Two normalizes here cost a second rsqrt on every opaque
   * pixel in the frame for no visual difference.
   *
   * The branch is on a UNIFORM, which is what makes it legal: an implicit-LOD
   * texture fetch must sit in dynamically-uniform control flow in GLSL ES 3.0, and
   * a uniform comparison is uniform across the whole draw call. It buys back the
   * fetch on every material that does not want a detail layer — glass, the weaves,
   * the coated fabrics — which is a third of the library.
   */
  float mtlFar = smoothstep( uMtlFade.x, uMtlFade.y, mtlDist );
  float mtlBoost = mix( uMtlDet.w, uMtlDet.w * uMtlFade.z, mtlFar );
  vec3 mtlN = nonPerturbedNormal + ( normal - nonPerturbedNormal ) * mtlBoost;

  #ifdef USE_NORMALMAP_TANGENTSPACE
    if ( uMtlDet.y > 0.001 || uMtlDet.z > 0.001 ) {
      float mtlDF = 1.0 - smoothstep( uMtlFade.x * 0.35, uMtlFade.w, mtlDist );
      vec2 mtlDN = texture2D( normalMap, vNormalMapUv * uMtlDet.x ).xy * 2.0 - 1.0;
      mtlN += tbn * vec3( mtlDN * ( uMtlDet.y * mtlDF ), 0.0 );
      roughnessFactor += ( length( mtlDN ) - 0.18 ) * uMtlDet.z * mtlDF;
    }
  #endif
  normal = normalize( mtlN );

  // ── C. which way is up (geometric, interpolated in the vertex stage) ──────
  float mtlUp = clamp( vMtlW.y, 0.0, 1.0 );
  mtlUp *= mtlUp;

  // ── D. gravity-placed weathering ──────────────────────────────────────────
  float mtlWear = 0.0;
  #ifdef USE_ROUGHNESSMAP
    mtlWear = texelRoughness.a;
  #endif
  float mtlLow = 1.0 - smoothstep( 0.0, max( uMtlWear.z, 0.001 ), max( vMtlW.x, 0.0 ) );
  mtlLow *= step( 0.001, uMtlWear.z );
  mtlWear *= mix( 1.0, 1.0 - uMtlTop.z, mtlUp );      // rain scours the tops
  mtlWear = clamp( mtlWear * ( 0.72 + 0.55 * mtlLow ) + mtlLow * ( 1.0 - mtlUp ) * uMtlWear.w, 0.0, 1.0 );

  diffuseColor.rgb *= mix( vec3( 1.0 ), uMtlTint, mtlWear * uMtlWear.y )
    * ( 1.0 + mtlUp * uMtlTop.y );   // ── C'. settled dust on every horizontal face

  /**
   * Roughness is moved TOWARD an end of the range rather than added to, because
   * the recipes deliberately author right up to their own ceiling (dust at 0.96,
   * oxide at 0.78 before a consumer's 1.45x multiply) and a plain += clipped the
   * top third of every authored spread onto a flat 1.0 — which is the "uniform
   * roughness" tell this whole pass exists to remove. A mix() can never clip.
   */
  roughnessFactor = mix( roughnessFactor, 1.0,
    clamp( mtlWear * uMtlWear.x + mtlUp * uMtlTop.x, 0.0, 0.92 ) );

  // ── E. metal keeps its gloss, oxide does not ──────────────────────────────
  roughnessFactor = mix( roughnessFactor, 0.145, clamp( metalnessFactor * uMtlTop.w, 0.0, 0.92 ) );

  roughnessFactor = clamp( roughnessFactor, 0.035, 1.0 );
}
`;

/**
 * One shared hook for every material in the library. `this` is the material, so the
 * per-material numbers come out of `userData.mtl` — which survives `clone()` because
 * `Material.copy()` deep-copies userData.
 */
function mtlHook(shader) {
  try {
    const p = this.userData?.mtl;
    if (!p || p.length < 19) return;
    shader.uniforms.uMtlDet = { value: new THREE.Vector4(p[0], p[1], p[2], p[3]) };
    shader.uniforms.uMtlFade = { value: new THREE.Vector4(p[4], p[5], p[6], p[7]) };
    shader.uniforms.uMtlWear = { value: new THREE.Vector4(p[8], p[9], p[10], p[11]) };
    shader.uniforms.uMtlTop = { value: new THREE.Vector4(p[12], p[13], p[14], p[15]) };
    shader.uniforms.uMtlTint = { value: new THREE.Vector3(p[16], p[17], p[18]) };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\n' + VERT_NORMAL)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_BODY);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG_BODY);
  } catch (err) {
    console.warn('[materials] surface hook failed:', err);
  }
}

/**
 * Install on a material. Idempotent, and safe to call on a material another system
 * has already hooked — we chain rather than replace.
 */
export function installSurface(material, packed) {
  if (!material) return material;
  try {
    material.userData = material.userData || {};
    if (packed) material.userData.mtl = packed;
    if (material.__mtlHooked) return material;
    const prev = material.onBeforeCompile;
    if (typeof prev === 'function' && prev !== mtlHook && prev !== THREE.Material.prototype.onBeforeCompile) {
      material.onBeforeCompile = function (shader, renderer) {
        try { prev.call(this, shader, renderer); } catch (e) { console.warn('[materials] chained OBC threw:', e); }
        mtlHook.call(this, shader, renderer);
      };
    } else {
      material.onBeforeCompile = mtlHook;
    }
    material.__mtlHooked = true;
    material.needsUpdate = true;
  } catch (err) {
    console.warn('[materials] installSurface failed:', err);
  }
  return material;
}

/**
 * `customProgramCacheKey` must be stable and shared: the injected source is byte-
 * identical for every material in the library, so one key is correct and the whole
 * library costs the program cache exactly one extra entry. Consumers that inject
 * further source (the level's ground shader) append their own discriminator on top
 * of whatever this returns, which is why it is composable rather than final.
 */
const CACHE_KEY = 'mtlSurface2';

export class MtlStandardMaterial extends THREE.MeshStandardMaterial {
  constructor(params) {
    super(params);
    installSurface(this, null);
  }

  copy(source) {
    super.copy(source);
    // userData (and therefore userData.mtl) has just been deep-copied by super.
    this.__mtlHooked = false;
    installSurface(this, null);
    return this;
  }

  customProgramCacheKey() { return CACHE_KEY; }
}

export class MtlPhysicalMaterial extends THREE.MeshPhysicalMaterial {
  constructor(params) {
    super(params);
    installSurface(this, null);
  }

  copy(source) {
    super.copy(source);
    this.__mtlHooked = false;
    installSurface(this, null);
    return this;
  }

  customProgramCacheKey() { return CACHE_KEY; }
}

export default installSurface;
