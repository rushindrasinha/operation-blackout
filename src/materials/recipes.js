/**
 * OPERATION BLACKOUT — procedural PBR texture recipes.
 * OWNER: materials agent.
 *
 * Pure JS (no THREE, no DOM) so this module runs identically on the main thread and
 * inside a Worker. Every recipe returns three RGBA Uint8Arrays:
 *
 *   albedo — sRGB encoded
 *   normal — linear, tangent space, Sobel-filtered from a SEPARATELY AUTHORED height
 *            field (never from the albedo)
 *   orm    — linear, R = ambient occlusion, G = roughness, B = metalness
 *
 * COLOUR NOTE: albedo values below are *sRGB display values*, because the texture is
 * flagged THREE.SRGBColorSpace and the shader linearises it. A real-world linear
 * reflectance of 0.25 must therefore be authored at ≈0.53 here. Getting this wrong is
 * what turns a scene into black mud.
 *
 * House rules baked into every recipe:
 *   · 4–7 octave FBM with domain warping as the base, never a single noise layer
 *   · EVERY field used as a `sstep()` mask is run through `equalize()` first — see the
 *     long note on that function in noise.js. Raw fbm is a sigma~0.12 bell around 0.5,
 *     so an unequalised `sstep(0.56, 0.88, f)` fires on <1% of texels and silently
 *     deletes the wear layer it gates. This was the cause of the "uniform roughness /
 *     no albedo variation" that the review flagged on almost every surface.
 *   · roughness driven by its own decorrelated noise field, never by the albedo, and
 *     authored to span at least 0.35 across a single tile (dust matte ~0.95, exposed
 *     aggregate ~0.55, worn/polished/damp ~0.40). One roughness value = amateur.
 *   · multi-scale cavity term → grime in crevices, wear-brightening on exposed edges
 *   · gravity-following streaks below features
 *   · low-frequency colour blotching *and* high-frequency grain, both in the ALBEDO —
 *     detail that only exists in the normal map reads as embossed plastic.
 */

import {
  mulberry32, clamp01, clamp, lerp, sstep,
  fbm, fbmSigned, warp, worley, cavity, heightToNormal,
  gravityStreak, scribe, equalize, equalizeAll, studs, microGrain,
} from './noise.js';

/* ────────────────────────────── shared plumbing ────────────────────────────── */

function hash2(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Root-mean-square, used to auto-normalise the cavity term per material. */
function rms(f) {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return Math.sqrt(s / f.length) || 1e-6;
}

/**
 * Common finishing pass: Sobel normals, multi-scale AO/cavity, cavity grime,
 * edge-wear brightening, ORM packing.
 */
function finish(W, H, o) {
  const S = W * H;
  const height = o.height;
  const rgb = o.rgb;
  const rough = o.rough;
  const metal = o.metal ?? 0;

  const normal = heightToNormal(height, W, H, o.normalStrength ?? 1.0);

  const cav = cavity(height, W, H, o.aoRadii ?? [3, 10, 30], o.aoWeights);
  const scale = 1 / (rms(cav) * 2.6);
  const aoAmt = o.aoStrength ?? 1.0;
  const grime = o.cavityGrime ?? 0.42;
  const edgeAmt = o.edgeWear ?? 0.10;
  const ec = o.edgeColor ?? [1, 1, 1];
  const er = ec[0], eg = ec[1], eb = ec[2];
  const edgeRough = o.edgeRoughDelta ?? -0.05;
  const edgeMetal = o.edgeMetalDelta ?? 0;
  const creviceRough = o.creviceRoughDelta ?? 0.06;

  /**
   * Per-material roughness gamut. Widening the recipes to fix the "uniform roughness"
   * defect made a handful of them overshoot: three independent gloss masks coinciding
   * could drive painted steel to 0.08, which is a mirror, and mirrors on a 90 m wall
   * alias into sparkle under TAA. These clamps are the physical floor for the
   * substance — they bound the gamut without flattening it.
   */
  const rMin = o.roughMin ?? 0.035;
  const rMax = o.roughMax ?? 1.0;

  const albedo = new Uint8Array(S * 4);
  const orm = new Uint8Array(S * 4);
  const roughIsField = typeof rough !== 'number';
  const metalIsField = typeof metal !== 'number';

  /**
   * ── THE WEAR CHANNEL (ORM.a) ────────────────────────────────────────────────
   *
   * The critics' first finding was that one high-contrast macro grunge mask drives
   * every material, and — worse — that it has no relationship to gravity or
   * geometry: rust sprayed isotropically across a container including its roof,
   * stains on the top face of a jersey barrier. That is not a recipe bug. A tile
   * cannot know which way is down.
   *
   * So each recipe now hands its weathering mask up here instead of burning all of
   * it into the albedo, and it ships in the ALPHA of the packed ORM — a channel that
   * was previously a constant 255 and therefore free. `surface.js` reads it in the
   * fragment stage, multiplies it by a world-space downward gradient, a splash-back
   * band at the ground junction and an up-facing wash-off term, and only then routes
   * it to albedo and roughness.
   *
   * The cavity term is folded in unconditionally: crevices, seams and weld lines
   * accumulate everywhere on every substance, which is the other half of the
   * critics' ask ("concentrates at weld seams").
   */
  const wear = o.wear ?? 0;
  const wearIsField = typeof wear !== 'number';
  const wearCavity = o.wearCavity ?? 0.55;

  for (let i = 0; i < S; i++) {
    const c = clamp(cav[i] * scale, -1, 1);
    const conc = c < 0 ? -c : 0;         // crevice
    const conv = c > 0 ? c : 0;          // exposed edge
    const ao = clamp01(1 - conc * 0.85 * aoAmt);

    const i3 = i * 3;
    let r = rgb[i3], g = rgb[i3 + 1], b = rgb[i3 + 2];

    // grime accumulates in the crevices (multiplicative, keeps hue)
    const gk = 1 - grime * conc;
    r *= gk; g *= gk; b *= gk;
    // exposed edges get abraded toward the wear colour
    const ek = edgeAmt * conv;
    r = r + (er - r) * ek;
    g = g + (eg - g) * ek;
    b = b + (eb - b) * ek;

    const o4 = i * 4;
    albedo[o4] = clamp01(r) * 255;
    albedo[o4 + 1] = clamp01(g) * 255;
    albedo[o4 + 2] = clamp01(b) * 255;
    albedo[o4 + 3] = 255;

    let rr = roughIsField ? rough[i] : rough;
    rr += conc * creviceRough + conv * edgeRough;
    let mm = metalIsField ? metal[i] : metal;
    mm += conv * edgeMetal;

    const wv = clamp01((wearIsField ? wear[i] : wear) + conc * wearCavity);

    orm[o4] = ao * 255;
    orm[o4 + 1] = clamp(rr, rMin, rMax) * 255;
    orm[o4 + 2] = clamp01(mm) * 255;
    orm[o4 + 3] = wv * 255;
  }

  return { albedo, normal, orm, width: W, height: H };
}

/** Two decorrelated warp fields, reused by nearly every recipe. */
function warpPair(W, H, seed, cells = 4, octaves = 3) {
  return [
    fbmSigned(W, H, { seed: seed + 911, cells, octaves }),
    fbmSigned(W, H, { seed: seed + 977, cells, octaves }),
  ];
}

/* ═══════════════════════════════ CONCRETE ═══════════════════════════════ */

function concrete(W, H, seed) {
  const S = W * H;
  const [wx, wy] = warpPair(W, H, seed, 4, 3);

  // Every one of these is equalised: they are all used as sstep masks or as direct
  // albedo/roughness drivers, and raw fbm delivers a sigma-0.12 bell that collapses
  // both. See noise.js::equalize.
  const macro = equalize(warp(fbm(W, H, { seed: seed + 0, cells: 1.5, octaves: 3, gain: 0.6 }), W, H, wx, wy, W * 0.10));
  const blotch = equalize(warp(fbm(W, H, { seed: seed + 1, cells: 3, octaves: 5, gain: 0.58 }), W, H, wx, wy, W * 0.07));
  const blotch2 = equalize(warp(fbm(W, H, { seed: seed + 2, cells: 5, octaves: 4, gain: 0.55 }), W, H, wy, wx, W * 0.05));
  const mid = equalize(warp(fbm(W, H, { seed: seed + 3, cells: 13, octaves: 5, gain: 0.5 }), W, H, wx, wy, W * 0.018));
  /**
   * THE 2-6 cm BAND. The review's "no fine grain at any distance / plastic-smooth
   * and takes light like paper" is a spectral hole, not a missing feature: the
   * recipe had 3 cm aggregate (which contributes almost nothing to relief), a 4 px
   * grain octave that mips away past ~2 m, and then nothing until the 2 m blotch.
   * Between 2 cm and 40 cm the slab was literally featureless, and that is exactly
   * the band the eye uses at 1.5-4 m. `cells: 46` on the 3.2 m tile is a ~7 cm
   * float/screed mottle; it goes into BOTH the height and the albedo.
   */
  const fineN = equalize(warp(fbm(W, H, { seed: seed + 15, cells: 46, octaves: 4, gain: 0.52 }), W, H, wy, wx, W * 0.005));
  // 32 texels down to 4 (≈5 cm → 6 mm on the 3.2 m tile) — see noise.js::microGrain
  const grain = microGrain(W, H, { seed: seed + 4, finest: 4, octaves: 4, gain: 0.6 });

  const agg = worley(W, H, Math.round(W / 20), seed + 5, { jitter: 0.95 });
  const pits = worley(W, H, Math.round(W / 7), seed + 6, { jitter: 1.0 });

  /**
   * ── CRACK NETWORK ────────────────────────────────────────────────────────────
   *
   * The old network was one Worley cell-boundary contour at a fixed 2-3 texel
   * width, and it read as exactly that: CLOSED pentagons and hexagons of uniform
   * darkness with rounded 120-degree junctions. Three things are wrong with a raw
   * F2-F1 ridge and all three are fixed here:
   *
   *  1. CLOSED LOOPS. Multiplied by an independent low-frequency "liveness" field
   *     thresholded so ~45 % of every loop is erased. What survives is a set of
   *     terminating branches that meet at Y junctions — which is what a shrinkage
   *     crack actually is.
   *  2. UNIFORM WIDTH. The half-width is driven by the same liveness value, so a
   *     crack opens up in the middle of a live run and tapers to nothing at both
   *     ends instead of stopping dead at full width.
   *  3. NO RELIEF AT DISTANCE. A 3 mm crack is sub-pixel past ~2 m, so mipping
   *     averaged its normal to flat and left only the albedo darkening — an ink
   *     line. Every crack now carries a SPALL SHOULDER 5x its own width (~2-3 cm),
   *     paler, rougher and slightly proud, which survives mipping and gives the
   *     raking sun a bright lip against a dark interior.
   *
   * Two scales: a coarse map-crack net at ~0.65 m cells carrying the wide splits,
   * and a hairline net at ~0.23 m for the local branching, gated by its own stress
   * mask so it does not simply draw a second polygon grid on top of the first.
   */
  const netCells = Math.max(4, Math.round(W / 300));
  const net = worley(W, H, netCells, seed + 7, { jitter: 0.88 });
  const netPx = (W / netCells) * 0.5;
  const hairCells = Math.max(6, Math.round(W / 110));
  const hairNet = worley(W, H, hairCells, seed + 16, { jitter: 0.95 });
  const hairPx = (W / hairCells) * 0.5;
  const alive = equalize(warp(fbm(W, H, { seed: seed + 17, cells: 7, octaves: 4, gain: 0.55 }), W, H, wx, wy, W * 0.03));
  const alive2 = equalize(warp(fbm(W, H, { seed: seed + 18, cells: 15, octaves: 4, gain: 0.55 }), W, H, wy, wx, W * 0.02));

  /**
   * A Voronoi boundary is a STRAIGHT LINE SEGMENT. That is the whole reason the old
   * network read as a computational-geometry diagram — long straight runs meeting at
   * clean 120-degree junctions. Warping the finished ridge distance field with a
   * dedicated 10-15 cm noise pair breaks every segment into a meander without
   * touching the topology, which is what makes it read as a fracture instead of a
   * cell diagram. The warp fields are separate from the recipe's global `wx/wy` on
   * purpose: those are 80 cm features and would translate a crack bodily rather than
   * wiggle it.
   */
  const kx = fbmSigned(W, H, { seed: seed + 19, cells: 20, octaves: 4, gain: 0.55 });
  const ky = fbmSigned(W, H, { seed: seed + 20, cells: 20, octaves: 4, gain: 0.55 });
  const ridgeA = new Float32Array(S);
  const ridgeB = new Float32Array(S);
  for (let i = 0; i < S; i++) {
    ridgeA[i] = (net.d2[i] - net.d1[i]) * netPx;
    ridgeB[i] = (hairNet.d2[i] - hairNet.d1[i]) * hairPx;
  }
  const ridgeAW = warp(ridgeA, W, H, kx, ky, W * 0.016);
  const ridgeBW = warp(ridgeB, W, H, ky, kx, W * 0.008);

  // roughness lives on its own field — decorrelated from anything in the albedo
  const roughN = equalize(warp(fbm(W, H, { seed: seed + 8, cells: 4, octaves: 4, gain: 0.56 }), W, H, wy, wx, W * 0.06));
  const dampN = equalize(warp(fbm(W, H, { seed: seed + 9, cells: 2.5, octaves: 3, gain: 0.6 }), W, H, wx, wy, W * 0.04));
  // an independent traffic/wear field — the polished path where boots and tyres run
  const pathN = equalize(warp(fbm(W, H, { seed: seed + 12, cells: 1.8, octaves: 3, gain: 0.62, scaleX: 1, scaleY: 3 }), W, H, wy, wx, W * 0.05));
  // diesel / hydraulic staining: dark, desaturated, tile-scale
  const oilN = equalize(warp(fbm(W, H, { seed: seed + 13, cells: 2.2, octaves: 4, gain: 0.58 }), W, H, wx, wy, W * 0.09));

  // hairline splits — sparse, thin, and only where the surface is already stressed
  const hair = new Float32Array(S);
  scribe(hair, W, H, seed + 10, {
    count: Math.max(6, Math.round(W / 90)), length: W * 0.34, wander: 0.6,
    width: W / 1400, strength: 0.8,
  });

  /**
   * Bug holes — the trapped-air voids left when concrete is cast against ply. The
   * review's ask on the plinth was for ~1 mm pitting at ~8 mm spacing so the surface
   * still resolves at 3 m; at the shipped 2 048² / ~2.1 m tile one texel is ~1 mm,
   * so a 30-texel grid puts them at roughly the right pitch.
   *
   * Deliberately NO form-tie plugs: they only exist on formed vertical faces, and
   * this same texture is the 90 m ground slab. A regular 4x6 plug grid tiling across
   * the yard would be a far worse defect than the missing detail on one plinth.
   */
  const bug = new Float32Array(S);
  studs(bug, W, H, seed + 14, {
    cols: Math.max(6, Math.round(W / 30)), radius: 0.17, jitter: 0.95,
    strength: 1, chance: 0.34,
  });

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);
  const wearF = new Float32Array(S);

  const crackAmt = new Float32Array(S);   // dark interior of the split
  const spallAmt = new Float32Array(S);   // pale, rough, slightly proud shoulder
  for (let i = 0; i < S; i++) {
    /**
     * Where the slab is stressed enough to have cracked at all.
     *
     * The gate used to be a bare product of two tile-scale fields, which meant
     * the ENTIRE crack network lived in one blob per tile — and a 2x2 layout
     * showed that blob repeating like a logo. A 0.34 floor keeps a thinner,
     * quieter network running everywhere and reserves the wide splits for the
     * genuinely stressed patches, so crack DENSITY varies without the network
     * having a tile-periodic address.
     */
    const stress = 0.34 + 0.66 * sstep(0.34, 0.72, blotch2[i]) * sstep(0.18, 0.60, macro[i]);

    // coarse map cracks — wide, spalled, terminating
    const aA = sstep(0.44, 0.74, alive[i]);
    const hwA = 0.7 + 2.3 * aA;
    const dA = ridgeAW[i];
    const coreA = sstep(hwA, hwA * 0.22, dA) * aA;
    const shA = sstep(hwA * 5.0 + 4.5, hwA * 1.05, dA) * aA * (1 - coreA);

    // hairline branches — thin, shallow, no meaningful shoulder
    const aB = sstep(0.56, 0.82, alive2[i]) * sstep(0.30, 0.68, blotch[i]);
    const hwB = 0.45 + 0.85 * aB;
    const dB = ridgeBW[i];
    const coreB = sstep(hwB, hwB * 0.2, dB) * aB;
    const shB = sstep(hwB * 3.4 + 1.6, hwB * 1.1, dB) * aB * (1 - coreB) * 0.55;

    const scribed = hair[i] * sstep(0.25, 0.55, blotch[i]);

    crackAmt[i] = clamp01((coreA + coreB * 0.85) * stress + scribed);
    spallAmt[i] = clamp01((shA + shB) * stress * (1 - crackAmt[i]));
  }

  // grime seeds → gravity streaks
  const seeds = new Float32Array(S);
  /**
   * Grime-streak seeds. The `blotch` gate used to be a bare multiply, which put
   * every streak in the tile inside one 1 m blob — and because a gravity streak
   * is a distinctive SHAPE (a dark head with two drips under it) rather than a
   * diffuse stain, the eye latched onto that shape and counted four of them
   * across the warehouse's cream panel. A floor scatters the heads over the
   * whole tile so no single silhouette repeats at a readable spacing.
   */
  for (let i = 0; i < S; i++) {
    seeds[i] = sstep(0.80, 0.95, mid[i]) * (0.38 + 0.62 * sstep(0.35, 0.62, blotch[i]));
  }
  const streak = gravityStreak(seeds, W, H, { decay: 1 - 3.2 / H, drift: wx, driftAmount: 0.5 });

  for (let i = 0; i < S; i++) {
    /**
     * Aggregate-exposure floor. `mid` runs at 13 cells per tile, so a bare
     * threshold meant exposed stone existed on about a sixth of the slab and
     * nowhere else — and the review's "no aggregate, no readable surface" was
     * measured on the other five sixths. A 0.34 floor keeps the 3 cm stone
     * reading across the whole slab and lets `mid` modulate how proud it stands.
     */
    const aggShow = 0.34 + 0.66 * sstep(0.46, 0.90, mid[i]);
    const stone = sstep(0.55, 0.20, agg.d1[i]) * aggShow;
    const sid = agg.id[i];
    const pit = clamp01(sstep(0.88, 0.995, 1 - pits.d1[i]) * sstep(0.34, 0.68, blotch2[i]) + clamp01(bug[i] - 0.42) * 1.4);
    /**
     * Laitance grain. `pits` is a ~11 mm cellular field at the shipped tile; the
     * blowhole layer above only uses its extreme tail, so the same field is reused
     * here as the sand/fines packing of the cement paste. It is deliberately in the
     * ALBEDO as well as the height — high-frequency detail that exists only in the
     * normal reads as embossed plastic the moment the sun moves.
     */
    const sand = (1 - pits.d1[i]) * (0.62 + 0.38 * sstep(0.30, 0.80, fineN[i]));
    const sandId = pits.id[i];
    const spall = spallAmt[i];

    /**
     * ── height. Aggregate contributes almost NOTHING to relief and everything to
     * colour, which is the physical truth of a power-floated slab: the stone is
     * embedded under the laitance, you see it, you do not feel it.
     *
     * The LOW-FREQUENCY terms are also deliberately small now. `macro` used to
     * carry 0.058 of the height range at a 2 m wavelength, and on any prop whose
     * UVs squeeze the tile — the jersey barrier's top face — that resolved as a bed
     * of crumpled foil / river cobbles rather than as cast concrete. The ground
     * shader in level/ground.js supplies all the 6-47 m structure the yard needs,
     * so the texture's job is the 5 mm - 20 cm band and nothing wider. Cracks,
     * voids and the 7 cm float mottle now carry the relief.
     */
    height[i] = 0.5
      + stone * 0.009
      + (mid[i] - 0.5) * 0.013
      + (fineN[i] - 0.5) * 0.026
      + (sand - 0.5) * 0.0034
      + (grain[i] - 0.5) * 0.006
      + (macro[i] - 0.5) * 0.016
      - pit * 0.030
      + spall * 0.028                          // proud lip on the spalled shoulder
      - crackAmt[i] * 0.120;

    // ── albedo: four decorrelated octaves of VALUE, not just a shading response to
    //    the normal map. Low-frequency stain, mid blotch, 7 cm mottle, per-granule
    //    scatter. Energy has been moved OUT of the 2 m band (which duplicated the
    //    ground macro shader and read as camouflage blotching on small props) and
    //    into the 2-10 cm band the eye actually reads at 1.5-4 m.
    /**
     * ── THE TILING BUDGET ────────────────────────────────────────────────────
     *
     * A 2x2 layout of the shipped albedo showed the repeat INSTANTLY, and the
     * game frame proved it: the warehouse's cream concrete panel carried the
     * same dark stain four times in a row at even spacing. "Visible texture
     * tiling repetition" is on the rubric's instant-fail list.
     *
     * The cause is arithmetic, not artistry. Every term below `macro` and
     * `blotch` has 1-3 features per tile, so each is effectively ONE BLOB per
     * repeat, and the multiplicative stains underneath (`oil` at -44 %, `damp`
     * at -26 %, `streak` at -22 %) were the highest-contrast thing in the map.
     * One high-contrast blob per tile IS the repeat — no amount of warping
     * hides it, because the eye locks onto the largest feature and finds its
     * period.
     *
     * So the tile-scale bands are cut roughly in half and the energy is moved
     * down into the 7-25 cm bands (`mid`, `fineN`), which the eye reads as
     * surface rather than as pattern and whose period is far too short to
     * register. Total albedo variance is preserved — measured luminance std
     * barely moves — but it is now spent where it cannot betray the tile.
     *
     * The ROUGHNESS drivers keep their full tile-scale swing on purpose: a
     * damp patch or a polished traffic lane has to be metres across to read as
     * one, and a repeating specular patch is far less legible than a repeating
     * dark stain because its appearance changes with view angle.
     */
    let v = 0.500
      + macro[i] * 0.038
      + blotch[i] * 0.062
      + (mid[i] - 0.5) * 0.130
      + (fineN[i] - 0.5) * 0.146
      + (grain[i] - 0.5) * 0.082;

    // per-granule value scatter — individual pieces of aggregate read as different
    // rocks (pale limestone, mid granite, dark basalt) instead of one embossed tone
    v += stone * (sid < 0.22 ? -0.115 : sid < 0.62 ? 0.028 : 0.128) * (0.6 + sid * 0.7)
      * (0.70 + 0.60 * grain[i]);   // grain breaks the disc so it is stone, not a paint splodge
    v += sand * (sandId - 0.5) * 0.155;        // every grain of fines a shade apart
    v *= 1 - 0.32 * pit;                       // blowholes read as dark specks

    const damp = sstep(0.52, 0.90, dampN[i]);
    const eff = sstep(0.62, 0.92, 1 - dampN[i]) * sstep(0.35, 0.78, blotch2[i]);
    const path = sstep(0.46, 0.90, pathN[i]);          // burnished traffic lane
    const oil = sstep(0.72, 0.96, oilN[i]);            // diesel / hydraulic spill
    v += eff * 0.052;
    v += spall * 0.062;                                // fresh fracture is pale
    /**
     * Tile-scale stains at roughly HALF their old baked contrast. The other half
     * now ships in ORM.a and comes back in the fragment stage multiplied by world
     * height and face orientation, so a stain pools at the foot of a wall and
     * washes off a horizontal top instead of being sprayed on isotropically.
     * Total contrast is unchanged; its placement is not.
     */
    v *= 1 - 0.060 * damp;
    v *= 1 - 0.058 * streak[i];
    v *= 1 - 0.46 * crackAmt[i];                       // cracks are metre-scale, not tile-scale
    v *= 1 - 0.040 * path;                             // rubbed-in dirt down the path
    v *= 1 - 0.085 * oil;
    wearF[i] = clamp01(streak[i] * 0.85 + oil * 0.95 + damp * 0.45 + path * 0.40);

    const i3 = i * 3;
    /**
     * Concrete is a NEUTRAL grey that reads faintly warm when dry. The previous
     * r/b ratio of 1.063 was enough that the level's rebar-rust vertex bleed tipped
     * the jersey barriers into salmon pink — well outside the desaturated palette.
     * 1.028 keeps the dry warmth without carrying the pink.
     */
    const warmth = 1 - damp * 0.8;
    let cr = v * (1.000 + 0.017 * warmth);
    let cg = v * (0.999 + 0.002 * warmth);
    let cb = v * (0.988 - 0.014 * warmth);
    // aggregate carries a little real hue — grey-blue basalt, buff limestone
    const hueK = stone * 1.0;
    if (sid < 0.22) { cr *= 1 - 0.055 * hueK; cb *= 1 + 0.058 * hueK; }
    else if (sid > 0.62) { cr *= 1 + 0.065 * hueK; cb *= 1 - 0.085 * hueK; }
    // oil desaturates hard toward neutral black-brown
    cr = lerp(cr, cr * 0.94, oil); cb = lerp(cb, cb * 1.05, oil);
    rgb[i3] = cr; rgb[i3 + 1] = cg; rgb[i3 + 2] = cb;

    /**
     * ── roughness. Target spread across one tile: dust/laitance ~0.96 → exposed
     * aggregate ~0.60 → burnished traffic path / damp patch ~0.40. Anything
     * narrower than ~0.35 of range reads as one continuous specular sheet under a
     * grazing sun, which is exactly what the review measured.
     *
     * The gloss drivers are combined and CLAMPED before the lerp rather than summed
     * as independent subtractions: summing let three unrelated masks coincide and
     * drive roughness to the 0.035 floor, which produced mirror specks in the dust.
     */
    const gloss = clamp01(
      0.28 * sstep(0.44, 0.90, roughN[i])       // trowel-burnished passes
      + 0.42 * damp                              // damp patches go glossy
      + 0.56 * path                              // polished traffic lane
      + 0.82 * oil                               // oil is the glossiest thing here
      - 0.20 * eff,                              // chalky efflorescence fights it
    );
    let r = lerp(0.965, 0.300, gloss);
    r -= 0.20 * stone;                           // exposed aggregate is smoother than paste
    r += 0.08 * pit;                             // torn blowhole walls are rough
    r += 0.14 * spall;                           // fresh fracture is the matte extreme
    r += 0.05 * crackAmt[i];
    r += (fineN[i] - 0.5) * 0.10;
    r += (grain[i] - 0.5) * 0.09;
    r += 0.05 * streak[i];
    rough[i] = r;
  }

  return finish(W, H, {
    height, rgb, rough, metal: 0, wear: wearF, wearCavity: 0.55,
    /**
     * 1.55, up from 0.66. The old value was chosen to kill a "cottage cheese" bump
     * that came from the aggregate pushing 0.078 of the height range; the aggregate
     * now contributes 0.006 and every wide low-frequency term has been cut, so the
     * only things left with real gradient are the cracks, the voids and the 7 cm
     * float mottle — the three things the review said had NO relief. The consumers
     * also ease this map hard (0.22 on walls, 0.24 on the yard), so at 0.66 the
     * cracks landed on the ground at an effective 0.15 and mipped to flat ink lines.
     */
    normalStrength: 1.55,
    aoRadii: [3, 11, 34],
    aoStrength: 1.05,
    cavityGrime: 0.48,
    edgeWear: 0.09,
    edgeColor: [0.72, 0.70, 0.675],
    edgeRoughDelta: -0.16,
    creviceRoughDelta: 0.05,
    roughMin: 0.24,
  });
}

/* ═══════════════════════════════ ASPHALT ═══════════════════════════════ */

function asphalt(W, H, seed) {
  const S = W * H;
  const [wx, wy] = warpPair(W, H, seed, 5, 3);

  const stones = worley(W, H, Math.round(W / 14), seed + 1, { jitter: 1.0 });
  const fines = worley(W, H, Math.round(W / 5), seed + 2, { jitter: 1.0 });
  const binder = equalize(warp(fbm(W, H, { seed: seed + 3, cells: 3, octaves: 5, gain: 0.55 }), W, H, wx, wy, W * 0.05));
  const patch = equalize(warp(fbm(W, H, { seed: seed + 4, cells: 2, octaves: 3, gain: 0.6 }), W, H, wy, wx, W * 0.08));
  const oil = equalize(warp(fbm(W, H, { seed: seed + 5, cells: 4, octaves: 4, gain: 0.55 }), W, H, wx, wy, W * 0.09));
  const roughN = equalize(warp(fbm(W, H, { seed: seed + 6, cells: 3.5, octaves: 4, gain: 0.58 }), W, H, wy, wx, W * 0.07));
  const grain = microGrain(W, H, { seed: seed + 7, finest: 4, octaves: 4, gain: 0.6 });
  const wear = equalize(warp(fbm(W, H, { seed: seed + 8, cells: 2.5, octaves: 3 }), W, H, wx, wy, W * 0.05));
  // wind-blown grit and tyre-dragged dust: the matte end of the roughness range
  const dustN = equalize(warp(fbm(W, H, { seed: seed + 11, cells: 2.0, octaves: 4, gain: 0.6 }), W, H, wy, wx, W * 0.06));

  const cracks = new Float32Array(S);
  scribe(cracks, W, H, seed + 9, {
    count: Math.max(4, Math.round(W / 110)), length: W * 0.45, wander: 0.5,
    width: W / 900, strength: 0.9,
  });
  const net = worley(W, H, Math.max(4, Math.round(W / 130)), seed + 10, { jitter: 0.85 });

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);
  const wearF = new Float32Array(S);

  const seeds = new Float32Array(S);
  for (let i = 0; i < S; i++) seeds[i] = sstep(0.86, 0.99, oil[i]);
  const oilRun = gravityStreak(seeds, W, H, { decay: 1 - 6.0 / H, drift: wy, driftAmount: 0.6 });

  for (let i = 0; i < S; i++) {
    const repaired = sstep(0.62, 0.78, patch[i]);            // smoother tar repair
    const dust = sstep(0.44, 0.90, dustN[i]);                // dry grit film
    /**
     * Aggregate-exposure floor. `binder` runs at 3 cells per tile, so a bare
     * threshold meant the stone was visible in one half of every tile and
     * invisible in the other — a metre-scale light/dark camouflage blotch whose
     * period IS the tile. A 0.34 floor keeps the aggregate reading everywhere
     * and lets `binder` modulate how proud it stands instead of whether it
     * exists at all.
     */
    const exposure = clamp01((0.34 + 0.66 * sstep(0.26, 0.68, binder[i])) * (1 - repaired * 0.6));
    const stone = sstep(0.54, 0.11, stones.d1[i]) * exposure;
    const fine = sstep(0.50, 0.12, fines.d1[i]) * (0.4 + exposure * 0.6);
    const crackAmt = clamp01(cracks[i] * sstep(0.4, 0.62, wear[i])
      + sstep(0.018, 0.002, net.d2[i] - net.d1[i]) * sstep(0.58, 0.78, wear[i]));

    height[i] = 0.5
      + stone * 0.11
      + fine * 0.045
      + (grain[i] - 0.5) * 0.035
      + (binder[i] - 0.5) * 0.034
      - crackAmt * 0.34;

    // ── albedo: bitumen is dark but NOT black — aggregate carries the value range
    let v = 0.168 + (binder[i] - 0.5) * 0.048 + (grain[i] - 0.5) * 0.026;
    // per-aggregate value scatter — flint, granite and slag in the same mix
    v += stone * (0.110 + stones.id[i] * 0.255);
    v += fine * 0.032;
    v -= repaired * 0.024;
    const polish = sstep(0.62, 0.92, wear[i]);              // tyre-polished tracks
    v += polish * 0.038;
    const oily = clamp01(sstep(0.86, 0.98, oil[i]) * 0.8 + oilRun[i] * 0.55);
    v *= 1 - 0.20 * oily;                                   // value effect halved: see the tiling budget in concrete()
    v += dust * 0.052;                                      // pale grit lifts the value

    const i3 = i * 3;
    const tint = 0.985 + stones.id[i] * 0.07 * stone + dust * 0.03;
    rgb[i3] = v * tint;
    rgb[i3 + 1] = v * (0.995 + dust * 0.008);
    rgb[i3 + 2] = v * (1.025 - stone * 0.055 - dust * 0.045);

    /**
     * ── roughness: dry grit 0.97 → fresh bitumen skin 0.70 → polished wheel track
     * 0.45 → oil film 0.30. Clamped-sum so three coincident masks cannot punch a
     * mirror through the road.
     */
    const gloss = clamp01(
      0.26 * sstep(0.52, 0.90, roughN[i])
      + 0.34 * repaired
      + 0.42 * polish
      + 0.80 * oily
      + 0.16 * stone
      - 0.50 * dust,
    );
    let r = lerp(0.975, 0.315, gloss);
    r += (grain[i] - 0.5) * 0.07;
    rough[i] = r;
    wearF[i] = clamp01(oily * 0.9 + dust * 0.4 + polish * 0.3);
  }

  return finish(W, H, {
    height, rgb, rough, metal: 0, wear: wearF, wearCavity: 0.5,
    normalStrength: 1.25,
    aoRadii: [2, 8, 26],
    aoStrength: 1.15,
    cavityGrime: 0.32,
    edgeWear: 0.13,
    edgeColor: [0.47, 0.465, 0.465],
    creviceRoughDelta: 0.04,
    roughMin: 0.22,
  });
}

/* ═══════════════════════════════ RUST METAL ═══════════════════════════════ */

function rustMetal(W, H, seed) {
  const S = W * H;
  const [wx, wy] = warpPair(W, H, seed, 4, 3);

  const rustBase = equalize(warp(fbm(W, H, { seed: seed + 1, cells: 3, octaves: 6, gain: 0.55 }), W, H, wx, wy, W * 0.10));
  const rustDet = equalize(warp(fbm(W, H, { seed: seed + 2, cells: 16, octaves: 5, gain: 0.52 }), W, H, wy, wx, W * 0.03));
  const speck = equalize(microGrain(W, H, { seed: seed + 11, finest: 5, octaves: 3, gain: 0.55 }));
  const flake = worley(W, H, Math.round(W / 26), seed + 3, { jitter: 1.0 });
  const pit = worley(W, H, Math.round(W / 6), seed + 4, { jitter: 1.0 });
  const roughN = equalize(warp(fbm(W, H, { seed: seed + 5, cells: 5, octaves: 4 }), W, H, wy, wx, W * 0.05));
  // large-scale weather envelope: whole runs of plate stay bright while others dull
  const weatherN = equalize(warp(fbm(W, H, { seed: seed + 12, cells: 1.6, octaves: 3, gain: 0.62 }), W, H, wx, wy, W * 0.07));
  // wet/greasy patches — the low end of the roughness range on painted-out steel
  const filmN = equalize(warp(fbm(W, H, { seed: seed + 13, cells: 2.4, octaves: 4 }), W, H, wy, wx, W * 0.05));
  const mill = fbm(W, H, { seed: seed + 6, cells: 5, octaves: 4, scaleX: 6, scaleY: 1 }); // rolled-steel banding
  const grain = microGrain(W, H, { seed: seed + 7, finest: 4, octaves: 3 });

  const scratches = new Float32Array(S);
  scribe(scratches, W, H, seed + 8, {
    count: Math.round(W / 20), length: W * 0.5, wander: 0.06,
    width: W / 1500, strength: 0.9, dirBias: 0.28, biasStrength: 0.82,
  });

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);
  const metal = new Float32Array(S);
  const wearF = new Float32Array(S);

  const rustMask = new Float32Array(S);
  for (let i = 0; i < S; i++) {
    const f = rustBase[i] * 0.50 + rustDet[i] * 0.34 + speck[i] * 0.16;
    /**
     * Ragged primary front + hard speckled pinholes running ahead of it.
     *
     * The threshold moved up from 0.29 so oxide covers about 45 % of the plate
     * rather than 62 %. This material clads every drum, tube and railing in the
     * map, and rust is a DIELECTRIC — at 62 % coverage there was not enough
     * sound steel left anywhere on a 0.3 m drum for the low sun to put a
     * highlight on, which is why the review read four of them as unglazed clay
     * pots. What is left between the blooms is now a continuous run of painted
     * steel wide enough to carry a specular streak down the barrel.
     */
    rustMask[i] = clamp01(sstep(0.36, 0.74, f) + sstep(0.88, 1.0, speck[i]) * 0.55);
  }
  // rust bleeds downhill over clean steel — the signature look of neglected plate
  const seeds = new Float32Array(S);
  for (let i = 0; i < S; i++) seeds[i] = rustMask[i] > 0.72 ? rustMask[i] : 0;
  const bleed = gravityStreak(seeds, W, H, { decay: 1 - 3.4 / H, drift: wy, driftAmount: 0.55 });

  for (let i = 0; i < S; i++) {
    const rm = rustMask[i];
    const scab = sstep(0.55, 0.14, flake.d1[i]) * rm;
    /**
     * Pitting. Two corrections over a plain `sstep(0.72, 0.99, 1 - d1) * rm`:
     * the per-cell id modulates the threshold so pit DIAMETER varies by 3x and
     * roughly a third of cells never fire at all, and the whole field is gated
     * on the oxide-detail noise so pits cluster in the thick scale. Uniform
     * same-size dots on a jittered grid is the most recognisable Worley
     * signature there is, and at 3 m it read as a printed dot screen.
     */
    const pitting = sstep(0.60 + pit.id[i] * 0.34, 0.99, 1 - pit.d1[i])
      * rm * sstep(0.26, 0.66, rustDet[i]);

    /**
     * Oxide relief amplitudes pulled back roughly 40 %. This material's tile is
     * 1.6 m over 1024 texels, i.e. 1.6 mm per texel, and real bloomed rust
     * stands about 1 mm proud — under a texel. The map is therefore ALREADY
     * exaggerating by construction, and at the old amplitudes (scab 0.10, pit
     * 0.22) times normalScale 1.45 the surface stopped reading as corroded
     * steel and started reading as coral or crumb topping. Restrained relief
     * plus the roughness/metalness split is what sells rust; a big normal is
     * what sells a rock.
     */
    height[i] = 0.5
      + scab * 0.062
      + rm * (rustDet[i] - 0.5) * 0.085
      - pitting * 0.14
      - scratches[i] * 0.10 * (1 - rm)
      + (mill[i] - 0.5) * 0.014;

    // steel F0 is BRIGHT — dirty mild steel sits around 0.62 sRGB, slightly cool
    let sr = 0.448, sg = 0.462, sb = 0.484;
    const sc = scratches[i] * (1 - rm);
    sr += sc * 0.15; sg += sc * 0.15; sb += sc * 0.15;
    const millV = (mill[i] - 0.5) * 0.055;
    sr += millV; sg += millV; sb += millV;

    // rust ramp: near-black scale → deep oxide → orange → light powder
    const t = clamp01(rustDet[i] * 0.55 + rustBase[i] * 0.30 + speck[i] * 0.15);
    let rr, rg2, rb;
    if (t < 0.42) {
      const k = t / 0.42;
      rr = lerp(0.128, 0.222, k); rg2 = lerp(0.074, 0.120, k); rb = lerp(0.058, 0.084, k);
    } else if (t < 0.75) {
      const k = (t - 0.42) / 0.33;
      rr = lerp(0.222, 0.335, k); rg2 = lerp(0.120, 0.192, k); rb = lerp(0.084, 0.124, k);
    } else {
      const k = (t - 0.75) / 0.25;
      rr = lerp(0.335, 0.408, k); rg2 = lerp(0.192, 0.272, k); rb = lerp(0.124, 0.190, k);
    }
    const gn = (grain[i] - 0.5) * 0.055;
    rr += gn; rg2 += gn * 0.8; rb += gn * 0.6;
    rr -= scab * 0.065; rg2 -= scab * 0.055; rb -= scab * 0.04;
    // pitted oxide is darker in the holes — this is what stops rust reading as paint
    const pk = 1 - pitting * 0.30;
    rr *= pk; rg2 *= pk; rb *= pk;

    let r = lerp(sr, rr, rm);
    let g = lerp(sg, rg2, rm);
    let b = lerp(sb, rb, rm);

    // thin bleed stain over clean steel: tints but does not kill metalness
    const bl = clamp01(bleed[i] * (1 - rm)) * 0.85;
    r = lerp(r, 0.362, bl * 0.75);
    g = lerp(g, 0.216, bl * 0.75);
    b = lerp(b, 0.142, bl * 0.75);

    const i3 = i * 3;
    rgb[i3] = r; rgb[i3 + 1] = g; rgb[i3 + 2] = b;

    metal[i] = clamp01(1 - rm * 1.05 - bl * 0.25);
    // exported so surface.js can pool the oxide low and streak it down the drum
    wearF[i] = clamp01(rm * 0.85 + bl * 0.4);

    /**
     * Roughness 0.30 (wiped/greasy mill-finish steel) → 0.85 (blooming oxide).
     *
     * The ceiling came DOWN from 0.975. The level multiplies this material's
     * roughness map by 1.15, so anything authored above 0.87 clamped flat at 1.0 —
     * which is precisely the scaffolding tubes the review called out as "matte at
     * every orientation, no specular streak from the low sun on any bar". Rust is
     * matte, not a black hole: real oxide sits around 0.80-0.88 and still returns a
     * broad, visible lobe at a grazing angle.
     */
    const dull = sstep(0.28, 0.84, weatherN[i]);
    const film = sstep(0.66, 0.95, filmN[i]);
    /**
     * 0.775 at full oxide, not 0.845. The level multiplies this map by 1.15
     * (MATERIAL_TWEAK.rustMetal), so 0.845 lands at 0.97 and the recipe's own
     * ceiling of 0.88 lands at 1.01 — CLIPPED. Every scaffolding tube and every
     * oil drum in the map therefore carried the same saturated 1.0 roughness on
     * its rusted 60 %, which is precisely the "matte at every orientation, no
     * specular streak from the low sun on any bar" the review measured. Real
     * bloomed oxide is a broad lobe, not the absence of one: 0.775 → 0.89 after
     * the multiply keeps a wide, soft, but clearly present highlight running
     * down a vertical tube and around the shoulder of a drum.
     */
    let ro = lerp(0.36, 0.775, rm);
    ro += 0.16 * dull * (1 - rm);
    ro -= 0.24 * (1 - dull) * (1 - rm);
    ro -= 0.28 * film * (1 - rm * 0.6);
    ro += 0.10 * pitting;                 // the crater walls left where a scab lifted
    ro -= 0.07 * scab;                    // a fresh flake face keeps a sheen
    ro -= sc * 0.12;
    ro += bl * 0.20;
    ro += (grain[i] - 0.5) * 0.06;
    rough[i] = ro;
  }

  return finish(W, H, {
    height, rgb, rough, metal, wear: wearF, wearCavity: 0.60,
    normalStrength: 1.45,
    aoRadii: [2, 8, 24],
    aoStrength: 1.0,
    cavityGrime: 0.42,
    edgeWear: 0.18,
    edgeColor: [0.66, 0.675, 0.69],
    edgeRoughDelta: -0.18,
    edgeMetalDelta: 0.30,
    creviceRoughDelta: 0.05,
    // 0.82 × the level's 1.15 multiply = 0.94: the whole authored spread survives
    // instead of the top third folding onto a clipped 1.0.
    roughMin: 0.26, roughMax: 0.82,
  });
}

/* ═══════════════════════════════ PAINTED METAL ═══════════════════════════════ */

function paintedMetal(W, H, seed) {
  const S = W * H;
  const [wx, wy] = warpPair(W, H, seed, 4, 3);

  const orangePeel = microGrain(W, H, { seed: seed + 1, finest: 5, octaves: 3, gain: 0.55 });
  /**
   * OIL CANNING. A large pressed-steel panel is never flat: it dishes gently between
   * its stiffeners, and the whole reason a shipping container reads as steel rather
   * than as cardboard under a raking sun is that the specular highlight SWEEPS as
   * that dish passes under it. The review's "cream front face carries only stain
   * blotches, no grazing sheen anywhere along it" is this term missing. It is
   * deliberately very low amplitude and very low frequency — it must never read as
   * a bump, only as a slow bend in the reflection.
   */
  const canN = warp(fbm(W, H, { seed: seed + 12, cells: 1.7, octaves: 3, gain: 0.62 }), W, H, wx, wy, W * 0.05);
  // roll/brush micro-texture of the sheet under the paint
  const micro = microGrain(W, H, { seed: seed + 13, finest: 5, octaves: 2, gain: 0.5, scaleX: 3, scaleY: 1 });
  const fade = equalize(warp(fbm(W, H, { seed: seed + 2, cells: 2.5, octaves: 4, gain: 0.58 }), W, H, wx, wy, W * 0.07));
  const blotch = equalize(warp(fbm(W, H, { seed: seed + 10, cells: 1.6, octaves: 3, gain: 0.6 }), W, H, wy, wx, W * 0.09));
  const chipField = equalize(warp(fbm(W, H, { seed: seed + 3, cells: 5, octaves: 5, gain: 0.5 }), W, H, wy, wx, W * 0.06));
  const chipCell = worley(W, H, Math.round(W / 30), seed + 4, { jitter: 1.0 });
  const roughN = equalize(warp(fbm(W, H, { seed: seed + 5, cells: 4, octaves: 4 }), W, H, wx, wy, W * 0.06));
  const dirt = equalize(warp(fbm(W, H, { seed: seed + 6, cells: 5, octaves: 4 }), W, H, wy, wx, W * 0.05));
  const dent = equalize(warp(fbm(W, H, { seed: seed + 7, cells: 4, octaves: 3 }), W, H, wx, wy, W * 0.04));
  // where rain sits and where the sun bakes: the two ends of an enamel's gloss range
  const bakeN = equalize(warp(fbm(W, H, { seed: seed + 11, cells: 1.8, octaves: 3, gain: 0.62 }), W, H, wy, wx, W * 0.08));

  const scratches = new Float32Array(S);
  scribe(scratches, W, H, seed + 8, {
    count: Math.max(4, Math.round(W / 45)), length: W * 0.35, wander: 0.12,
    width: W / 1300, strength: 0.85, dirBias: 1.35, biasStrength: 0.6,
  });

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);
  const metal = new Float32Array(S);
  const wearF = new Float32Array(S);

  const seeds = new Float32Array(S);
  for (let i = 0; i < S; i++) seeds[i] = sstep(0.80, 0.95, dirt[i]);
  const streak = gravityStreak(seeds, W, H, { decay: 1 - 4.0 / H, drift: wx, driftAmount: 0.45 });

  for (let i = 0; i < S; i++) {
    // chips cluster where the panel is already stressed rather than dotting evenly
    // 0.34 floor on the tile-scale gate: without it every chip on the panel sat
    // inside one blob per repeat, and a 2x2 layout showed that cluster tiling.
    const chipMask = sstep(0.72, 0.88, chipField[i]) * (0.34 + 0.66 * sstep(0.35, 0.72, blotch[i]));
    /**
     * Chip density and bare-core threshold both pulled back. This material clads
     * the warehouse catwalk, and the review caught the tread "moiréing into a
     * shimmering mesh" at 10-14 m. Half of that is the normal map (fixed by the
     * distance attenuation in surface.js) and half is this: a dense field of
     * 0.575-albedo, metalness-0.95 bare-steel specks on a dark enamel is a
     * per-texel high-contrast signal, and no amount of mip filtering makes a
     * high-contrast speck field stop sparkling — it has to be less contrasty at
     * source. Fewer, softer chips; the primer ring does the storytelling.
     */
    const chip = clamp01(chipMask * sstep(0.42, 0.18, chipCell.d1[i]) * 1.02);
    const bare = clamp01((chip - 0.72) * 2.4);              // chip core = bare metal
    const primer = clamp01(chip - bare);                    // ring of primer

    height[i] = 0.5
      /**
       * 0.024, was 0.048. At this material's 1.8 m tile one texel is 1.76 mm, so
       * the finest octave this map can carry is ~7 mm — an order of magnitude
       * coarser than real orange peel. Run at the old amplitude it stopped
       * reading as a paint surface and started reading as embossed circuitry or
       * crumpled foil. Halved, it does the one job it can honestly do here:
       * break the specular into a soft roll-coat mottle.
       */
      + (orangePeel[i] - 0.5) * 0.024
      + (micro[i] - 0.5) * 0.012
      + (canN[i] - 0.5) * 0.115             // the slow panel dish — reflection, not bump
      + (dent[i] - 0.5) * 0.06
      - chip * 0.10
      - scratches[i] * 0.07;

    // olive-drab military enamel, sun-faded, with low-frequency panel blotching
    const f = sstep(0.30, 0.85, fade[i] * 0.7 + blotch[i] * 0.3);
    let r = lerp(0.222, 0.318, f);
    let g = lerp(0.240, 0.330, f);
    let b = lerp(0.178, 0.256, f);
    const chalk = sstep(0.72, 0.98, fade[i]);
    r = lerp(r, 0.415, chalk * 0.28); g = lerp(g, 0.418, chalk * 0.28); b = lerp(b, 0.372, chalk * 0.28);

    // primer (red-oxide) then bare steel inside the chips
    r = lerp(r, 0.395, primer); g = lerp(g, 0.236, primer); b = lerp(b, 0.178, primer);
    r = lerp(r, 0.505, bare); g = lerp(g, 0.516, bare); b = lerp(b, 0.532, bare);

    const sc = scratches[i];
    r += sc * 0.10; g += sc * 0.10; b += sc * 0.105;

    const st = streak[i];
    const k = 1 - 0.17 * st;
    r *= k; g *= k; b *= k;
    r += st * 0.032; g += st * 0.028; b += st * 0.021;

    const i3 = i * 3;
    rgb[i3] = r; rgb[i3 + 1] = g; rgb[i3 + 2] = b;

    metal[i] = clamp01(bare * 0.95);

    // semi-gloss enamel, chalked where sun-bleached, glossy on the bare metal
    /**
     * Semi-gloss enamel spans a LOT: 0.24 where it is still sound and washed, 0.88
     * where fifteen summers have chalked it to powder. The shipped 0.30-0.57 band
     * was a single plastic sheen across every walkway and door in the map.
     */
    const bake = sstep(0.40, 0.90, bakeN[i]);
    let ro = 0.40;
    ro += 0.30 * sstep(0.46, 0.90, roughN[i]);
    ro -= 0.18 * sstep(0.46, 0.90, 1 - roughN[i]);
    ro += bake * 0.26;                 // sun-baked flank goes flat
    ro -= (1 - bake) * 0.14;           // the sheltered flank keeps its gloss
    ro += chalk * 0.34;
    ro += primer * 0.28;
    ro = lerp(ro, 0.26, bare);
    ro -= sc * 0.14;
    ro += st * 0.14;
    ro += (orangePeel[i] - 0.5) * 0.09;
    ro += (micro[i] - 0.5) * 0.06;
    rough[i] = ro;
    wearF[i] = clamp01(st * 0.9 + chalk * 0.5 + primer * 0.6 + chip * 0.3);
  }

  return finish(W, H, {
    height, rgb, rough, metal, wear: wearF, wearCavity: 0.55,
    normalStrength: 1.15,
    aoRadii: [2, 7, 22],
    aoStrength: 0.9,
    cavityGrime: 0.36,
    edgeWear: 0.20,
    edgeColor: [0.60, 0.61, 0.625],
    edgeRoughDelta: -0.14,
    edgeMetalDelta: 0.30,
    // ceilinged at 0.88: the level multiplies this map by 1.10, and anything
    // authored above 0.91 clamped to a single flat 1.0 across whole panels
    roughMin: 0.22, roughMax: 0.88,
  });
}

/* ═══════════════════════════════ SANDBAGS ═══════════════════════════════ */

function sandbags(W, H, seed) {
  const S = W * H;
  const [wx, wy] = warpPair(W, H, seed, 4, 3);

  /**
   * Weave pitch. `metersPerTile` for this material is 0.38 (see SPEC in index.js),
   * so 30 threads across the tile puts a weave knot at ~12.5 mm — woven
   * polypropylene sandbag, not the 4-5 cm basket-weave the review saw. The old
   * 0.85 m tile put the same 30 threads at 28 mm, which is knitted-wool territory.
   */
  const threads = Math.max(8, Math.round(W / 34));
  /**
   * NOT equalised, deliberately. These two feed `height` directly rather than gating
   * a mask, and equalising a direct height driver doubles its peak-to-peak swing —
   * which turned a gentle bag sag into a 6 cm snakeskin relief across the barricade.
   * Equalise masks; leave relief fields alone.
   */
  const sag = warp(fbm(W, H, { seed: seed + 1, cells: 2.5, octaves: 4, gain: 0.58 }), W, H, wx, wy, W * 0.05);
  const lumps = warp(fbm(W, H, { seed: seed + 2, cells: 6, octaves: 4 }), W, H, wy, wx, W * 0.03);
  const fibre = microGrain(W, H, { seed: seed + 3, finest: 4, octaves: 3, gain: 0.6 });
  const dirt = equalize(warp(fbm(W, H, { seed: seed + 4, cells: 3, octaves: 4 }), W, H, wx, wy, W * 0.06));
  const roughN = equalize(warp(fbm(W, H, { seed: seed + 5, cells: 4.5, octaves: 4 }), W, H, wy, wx, W * 0.05));
  const tone = equalize(warp(fbm(W, H, { seed: seed + 6, cells: 2, octaves: 4 }), W, H, wx, wy, W * 0.08));
  /**
   * Bag-scale fields. At a 0.38 m tile a `cells: 1.4` blob is ~27 cm across — about
   * half a sandbag — so adjacent bags land on different parts of these fields and no
   * two read as the same bag even though the level shares one merged mesh and one
   * UV projection. This is what replaces the per-instance jitter a merged-geometry
   * build cannot give us.
   */
  const bagTone = equalize(warp(fbm(W, H, { seed: seed + 8, cells: 1.4, octaves: 3, gain: 0.62 }), W, H, wy, wx, W * 0.09));
  const bagHue = equalize(warp(fbm(W, H, { seed: seed + 9, cells: 1.2, octaves: 3, gain: 0.6 }), W, H, wx, wy, W * 0.10));
  // damp: hessian that has wicked water goes markedly darker AND markedly glossier
  const wetN = equalize(warp(fbm(W, H, { seed: seed + 10, cells: 1.6, octaves: 4, gain: 0.6 }), W, H, wy, wx, W * 0.07));
  // high-frequency yarn wander — without this the weave reads as a printed grid
  const hx = fbmSigned(W, H, { seed: seed + 21, cells: W / 26, octaves: 3 });
  const hy = fbmSigned(W, H, { seed: seed + 22, cells: W / 26, octaves: 3 });

  /**
   * Loose fibre. The width was W/1600, i.e. 0.64 of a TEXEL — a sub-texel line
   * rasterises as isolated single-texel spikes, which is white noise in the height
   * field and therefore a per-texel step in the normal. That is the sparkle the
   * review saw crawling on the bags, and it is also invisible past mip 1. Widened
   * to ~1.6 texels so it survives mipping and reads as fibre rather than glitter.
   */
  const fuzz = new Float32Array(S);
  scribe(fuzz, W, H, seed + 7, {
    count: Math.round(W / 7), length: W * 0.02, wander: 0.9,
    width: W / 1150, strength: 0.7, taper: true,
  });

  // per-thread irregularity — real hessian has visibly uneven yarn
  const nT = threads + 2;
  const tw = new Float32Array(nT), tv = new Float32Array(nT);
  for (let i = 0; i < nT; i++) { tw[i] = 0.68 + hash2(i, 3, seed) * 0.62; tv[i] = hash2(i, 11, seed); }

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);
  const wearF = new Float32Array(S);

  for (let y = 0; y < H; y++) {
    const vbase = (y / H) * threads;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const u = (x / W) * threads + wx[i] * 0.48 + hx[i] * 0.30;
      const vv = vbase + wy[i] * 0.48 + hy[i] * 0.30;

      const iu = Math.floor(u), iv = Math.floor(vv);
      const fu = u - iu, fv = vv - iv;
      const over = ((iu + iv) & 1) === 0;
      const wu = tw[((iu % nT) + nT) % nT];
      const wv2 = tw[((iv % nT) + nT) % nT];

      // rounded thread cross-sections, the "over" thread sits proudly on top
      let bu = Math.sin(fu * Math.PI); bu *= 0.55 + 0.45 * bu * wu;
      let bv = Math.sin(fv * Math.PI); bv *= 0.55 + 0.45 * bv * wv2;
      /**
       * 0.21, was 0.26. Combined with the 0.86 normal strength and the distance
       * attenuation in surface.js this takes the weave from "individually
       * resolvable threads sparkling at 3-6 m" to the soft directional texture a
       * real polypropylene bag has at that range, without losing the weave.
       */
      const wp = over ? 0.21 * bv * (0.55 + 0.45 * bu) : 0.21 * bu * (0.55 + 0.45 * bv);
      const base = over ? 0.545 : 0.455;

      const th = base + wp + (fibre[i] - 0.5) * 0.16 + fuzz[i] * 0.10;
      height[i] = th * 0.44 + 0.28
        + (sag[i] - 0.5) * 0.44
        + (lumps[i] - 0.5) * 0.17;

      // hessian: dusty tan-olive, per-yarn tonal drift, never a flat colour
      const tv2 = tone[i] * 0.6 + (over ? tv[((iu % nT) + nT) % nT] : tv[((iv % nT) + nT) % nT]) * 0.4;
      let r = 0.318 + tv2 * 0.096;
      let g = 0.296 + tv2 * 0.086;
      let b = 0.238 + tv2 * 0.070;
      const shade = 0.86 + (over ? 0.18 : 0.05) + (fibre[i] - 0.5) * 0.34;
      r *= shade; g *= shade; b *= shade;

      // ── bag-scale value and hue drift: some bags olive, some tan, some grey
      const bt = 0.80 + bagTone[i] * 0.44;
      r *= bt; g *= bt; b *= bt;
      const bh = bagHue[i];
      if (bh < 0.34) { r *= 0.94; g *= 1.02; b *= 0.90; }          // olive
      else if (bh > 0.70) { r *= 0.985; g *= 0.995; b *= 1.075; }  // washed-out grey
      else { r *= 1.045; g *= 1.005; b *= 0.945; }                 // tan

      const d = sstep(0.18, 0.88, dirt[i]);
      r = lerp(r, 0.196, d * 0.88);
      g = lerp(g, 0.180, d * 0.88);
      b = lerp(b, 0.150, d * 0.88);

      // damp bags: darker, cooler, and much glossier than the dry ones next to them
      const wet = sstep(0.56, 0.94, wetN[i]);
      r *= 1 - wet * 0.34; g *= 1 - wet * 0.32; b *= 1 - wet * 0.26;

      r += fuzz[i] * 0.14; g += fuzz[i] * 0.125; b += fuzz[i] * 0.095;

      const i3 = i * 3;
      rgb[i3] = r; rgb[i3 + 1] = g; rgb[i3 + 2] = b;

      /**
       * Roughness 0.42 (damp / handled and polished) → 0.99 (dry dusty hessian).
       * The recipe previously shipped a 0.89–0.99 band, i.e. every one of the ~40
       * bags in the closeup frame carried an identical specular response, which is
       * precisely the "uniform roughness" tell.
       */
      const gloss = clamp01(
        0.34 * sstep(0.52, 0.92, roughN[i])       // rubbed, handled, polished by boots
        + 0.72 * wet
        - 0.30 * d,                               // caked dust fights all of it
      );
      let ro = lerp(0.985, 0.405, gloss);
      ro += 0.04 * d;
      ro += (fibre[i] - 0.5) * 0.07;
      rough[i] = ro;
      wearF[i] = clamp01(d * 0.85 + wet * 0.45);
    }
  }

  return finish(W, H, {
    height, rgb, rough, metal: 0, wear: wearF, wearCavity: 0.6,
    /**
     * 0.92, was 1.1. The review caught the burlap weave speckling and sparkling at
     * 3-6 m — a normal map too high-frequency for the distance it is actually seen
     * at. The other half of that fix is the distance attenuation in surface.js,
     * which takes this map to 28 % of its base by 13 m.
     */
    normalStrength: 0.86,
    aoRadii: [2, 6, 18],
    aoStrength: 1.2,
    cavityGrime: 0.52,
    edgeWear: 0.10,
    edgeColor: [0.50, 0.46, 0.37],
    edgeRoughDelta: -0.10,
    roughMin: 0.34,
  });
}

/* ═══════════════════════════════ WOOD ═══════════════════════════════ */

function wood(W, H, seed) {
  const S = W * H;
  const rnd = mulberry32(seed + 4242);
  const [wx, wy] = warpPair(W, H, seed, 5, 3);

  const PLANKS = 5;
  const grainNoise = fbm(W, H, { seed: seed + 1, cells: 4, octaves: 5, gain: 0.55, scaleX: 1, scaleY: 8 });
  const grainNoise2 = fbm(W, H, { seed: seed + 11, cells: 11, octaves: 4, gain: 0.5, scaleX: 1, scaleY: 6 });
  /**
   * ── THE SALT-AND-PEPPER BUG ──────────────────────────────────────────────────
   *
   * This field used to be `fbm(cells: W/5, scaleY: 5)`. `fbm` builds a rectangular
   * lattice of `round(cells*scaleX) x round(cells*scaleY)` nodes, so that request
   * was a 205 x 1024 lattice on a 1024² texture: ONE LATTICE NODE PER TEXEL down
   * the Y axis, i.e. pure white noise, at three octaves. It fed the ring phase (x2.7),
   * the height and the roughness — which is the entire reason the nearest prop in
   * the game read as coarse asphalt grit rather than as timber, with no grain
   * direction visible anywhere.
   *
   * The replacement is a genuinely ANISOTROPIC fibre field: 16:1 stretched along the
   * plank axis, capped at two octaves so the finest lattice is still ~4 texels and
   * survives mipping instead of aliasing into speckle.
   */
  const fibre = fbm(W, H, { seed: seed + 2, cells: W / 150, octaves: 2, gain: 0.5, scaleX: 1, scaleY: 16 });
  const fibre2 = fbm(W, H, { seed: seed + 12, cells: W / 400, octaves: 3, gain: 0.52, scaleX: 1, scaleY: 20 });
  const roughN = equalize(warp(fbm(W, H, { seed: seed + 3, cells: 4, octaves: 4 }), W, H, wy, wx, W * 0.05));
  const weather = equalize(warp(fbm(W, H, { seed: seed + 4, cells: 2.5, octaves: 4 }), W, H, wx, wy, W * 0.06));
  const dirt = equalize(warp(fbm(W, H, { seed: seed + 5, cells: 4, octaves: 4 }), W, H, wy, wx, W * 0.05));
  // rain-soaked / oil-soaked boards sit right next to bone-dry chalked ones
  const wetN = equalize(warp(fbm(W, H, { seed: seed + 7, cells: 2.0, octaves: 4 }), W, H, wx, wy, W * 0.07));
  // saw-blade chatter: the fine parallel scoring left on a rough-sawn board
  const sawN = fbm(W, H, { seed: seed + 13, cells: W / 220, octaves: 2, gain: 0.5, scaleX: 1, scaleY: 9 });

  const splinter = new Float32Array(S);
  scribe(splinter, W, H, seed + 6, {
    count: Math.round(W / 26), length: W * 0.22, wander: 0.05,
    width: W / 1500, strength: 0.9, dirBias: 0, biasStrength: 0.97,
  });

  /**
   * Nail / staple heads at the batten lines. A packing crate is nailed, and two rows
   * of struck steel heads per board is one of the fastest reads that a wooden box is
   * a real object rather than a textured cube.
   */
  const nails = new Float32Array(S);
  studs(nails, W, H, seed + 14, {
    cols: 7, rows: PLANKS * 2, radius: 0.055, jitter: 0.22, strength: 1, chance: 0.62, rim: 0.35,
  });

  // per-plank parameters
  const pOff = new Float32Array(PLANKS), pTint = new Float32Array(PLANKS),
    pFreq = new Float32Array(PLANKS), pCent = new Float32Array(PLANKS), pSkew = new Float32Array(PLANKS);
  const knotX = new Float32Array(PLANKS), knotY = new Float32Array(PLANKS), knotOn = new Float32Array(PLANKS);
  for (let p = 0; p < PLANKS; p++) {
    pOff[p] = rnd();
    pTint[p] = rnd();
    pFreq[p] = 9 + rnd() * 12;
    pCent[p] = 0.15 + rnd() * 0.7;
    pSkew[p] = 0.10 + rnd() * 0.24;
    knotOn[p] = rnd() < 0.5 ? 1 : 0;
    knotX[p] = rnd();
    knotY[p] = 0.28 + rnd() * 0.44;
  }

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);
  const metal = new Float32Array(S);
  const wearF = new Float32Array(S);

  for (let y = 0; y < H; y++) {
    const gy = y / H;
    const py = gy * PLANKS;
    const pi = Math.min(PLANKS - 1, Math.floor(py));
    const pf = py - pi;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const gx = (x / W + pOff[pi]) % 1;

      // ── grain: distorted rings around an origin outside the board
      const cy = (pf - pCent[pi]);
      const dxg = (gx - 0.5) * pSkew[pi] + (grainNoise[i] - 0.5) * 0.62 + (grainNoise2[i] - 0.5) * 0.20;
      let d = Math.sqrt(dxg * dxg + cy * cy * 3.4);
      if (knotOn[pi]) {
        const kx = gx - knotX[pi], ky = pf - knotY[pi];
        const kd = Math.sqrt(kx * kx + ky * ky * 0.42);
        d = Math.min(d, kd * 1.9);
      }
      let ring = d * pFreq[pi] + (fibre2[i] - 0.5) * 1.5 + (grainNoise2[i] - 0.5) * 2.2;
      ring = ring - Math.floor(ring);
      const dark = Math.pow(1 - Math.abs(ring * 2 - 1), 2.6);
      // the fine longitudinal fibre that rides ON TOP of the ring figure
      const fib = (fibre[i] - 0.5) * 1.35 + (fibre2[i] - 0.5) * 0.55;
      const saw = (sawN[i] - 0.5);

      // ── plank joints
      const jointW = 0.045;
      const joint = 1 - sstep(0, jointW, pf) * sstep(0, jointW, 1 - pf);
      const edgeRound = sstep(0.14, 0.0, Math.min(pf, 1 - pf));
      // the arris: the 2-3 mm strip right at the board edge, rubbed smooth and pale
      const arris = sstep(0.16, 0.03, Math.min(pf, 1 - pf)) * (1 - joint);

      const knotCore = knotOn[pi]
        ? sstep(0.050, 0.010, Math.sqrt(
          (gx - knotX[pi]) * (gx - knotX[pi]) + (pf - knotY[pi]) * (pf - knotY[pi]) * 0.35))
        : 0;
      // the darker halo of compressed grain that sweeps around every knot
      const knotHalo = knotOn[pi]
        ? sstep(0.145, 0.045, Math.sqrt(
          (gx - knotX[pi]) * (gx - knotX[pi]) + (pf - knotY[pi]) * (pf - knotY[pi]) * 0.35))
        : 0;

      const nail = clamp01(nails[i] - 0.55) * 2.2;

      height[i] = 0.55
        - dark * 0.052
        - joint * 0.42
        - edgeRound * 0.10
        - splinter[i] * 0.09
        + fib * 0.026                       // raised late-wood fibre, along the plank
        + saw * 0.016                       // saw chatter
        - knotCore * 0.10
        - nail * 0.09;                      // struck nail head sits below the surface

      // ── colour: weathered, greyed-out timber with a warm core
      /**
       * Base value lifted from ~0.26 to ~0.38 sRGB. Weathered softwood is a mid
       * grey-tan; the old recipe authored it at roughly the reflectance of dark
       * chocolate, and a surface that dark cannot show grain, knots or wear no
       * matter what is written into it.
       */
      const t = pTint[pi];
      const wthr = sstep(0.30, 0.85, weather[i] * 0.7 + t * 0.3);
      let r = lerp(0.408, 0.372, wthr);
      let g = lerp(0.348, 0.352, wthr);
      let b = lerp(0.268, 0.312, wthr);
      // per-plank value jitter: +/-20 %, so no two boards are the same board
      const pk = 0.80 + t * 0.42;
      r *= pk; g *= pk * 0.985; b *= pk * 0.97;

      const dk = 1 - dark * 0.34 - clamp01(fib) * 0.14;
      r *= dk; g *= dk * 0.99; b *= dk * 0.975;
      // early-wood between the rings picks up a touch more warmth
      r += (1 - dark) * 0.016;

      // knots are much darker and resinous
      r = lerp(r, 0.190, knotHalo * 0.45); g = lerp(g, 0.140, knotHalo * 0.45); b = lerp(b, 0.096, knotHalo * 0.45);
      r = lerp(r, 0.128, knotCore); g = lerp(g, 0.086, knotCore); b = lerp(b, 0.058, knotCore);

      const dv = sstep(0.5, 0.92, dirt[i]);
      r *= 1 - dv * 0.28; g *= 1 - dv * 0.28; b *= 1 - dv * 0.24;

      r += splinter[i] * 0.11; g += splinter[i] * 0.095; b += splinter[i] * 0.07;
      // rubbed arris — bare pale timber where the edge has been handled
      r += arris * 0.070; g += arris * 0.062; b += arris * 0.046;
      const jk = 1 - joint * 0.70;
      r *= jk; g *= jk; b *= jk;
      // galvanised nail head: cool, bright, and a genuine metal
      r = lerp(r, 0.520, nail); g = lerp(g, 0.532, nail); b = lerp(b, 0.548, nail);

      const i3 = i * 3;
      rgb[i3] = r; rgb[i3 + 1] = g; rgb[i3 + 2] = b;
      metal[i] = nail * 0.85;

      /**
       * Roughness: rough-sawn face 0.90, weathered chalk 0.97, rubbed arris and
       * handled patches 0.45, oil-soaked board 0.38, resin knot 0.55. A single
       * 0.86 across a crate is the "one uniform roughness" tell.
       */
      let ro = 0.895;
      ro += 0.075 * wthr;                                 // weathered timber goes chalky
      ro -= 0.34 * sstep(0.46, 0.90, roughN[i]);          // handled/oiled patches
      ro -= 0.36 * sstep(0.56, 0.92, wetN[i]);            // soaked / oil-stained boards
      ro -= arris * 0.40;                                 // the polished plank edge
      ro += dark * 0.05;
      ro -= knotCore * 0.30;                              // resin is glossier
      ro -= nail * 0.52;                                  // struck steel
      ro += saw * 0.10;
      ro += fib * 0.07;
      rough[i] = ro;
      wearF[i] = clamp01(dv * 0.9 + sstep(0.56, 0.92, wetN[i]) * 0.45 + joint * 0.5);
    }
  }

  return finish(W, H, {
    height, rgb, rough, metal, wear: wearF, wearCavity: 0.6,
    normalStrength: 1.35,
    aoRadii: [2, 8, 26],
    aoStrength: 1.15,
    cavityGrime: 0.48,
    edgeWear: 0.11,
    edgeColor: [0.56, 0.47, 0.36],
    roughMin: 0.28,
  });
}

/* ═══════════════════════════════ GLASS ═══════════════════════════════ */

function glass(W, H, seed) {
  const S = W * H;
  const [wx, wy] = warpPair(W, H, seed, 4, 3);
  const film = equalize(warp(fbm(W, H, { seed: seed + 1, cells: 3, octaves: 5, gain: 0.55 }), W, H, wx, wy, W * 0.08));
  const dust = microGrain(W, H, { seed: seed + 2, finest: 4, octaves: 3 });
  const smudge = equalize(warp(fbm(W, H, { seed: seed + 3, cells: 6, octaves: 4 }), W, H, wy, wx, W * 0.05));

  const scratches = new Float32Array(S);
  scribe(scratches, W, H, seed + 4, {
    count: Math.round(W / 40), length: W * 0.3, wander: 0.25,
    width: W / 900, strength: 0.7,
  });

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);

  const seeds = new Float32Array(S);
  for (let i = 0; i < S; i++) seeds[i] = sstep(0.84, 0.97, film[i]);
  const runs = gravityStreak(seeds, W, H, { decay: 1 - 5.0 / H, drift: wx, driftAmount: 0.4 });

  for (let i = 0; i < S; i++) {
    const grime = clamp01(sstep(0.55, 0.95, film[i]) * 0.7 + runs[i] * 0.55 + dust[i] * 0.10);
    height[i] = 0.5 + (film[i] - 0.5) * 0.012 + grime * 0.01 + scratches[i] * 0.02;

    const i3 = i * 3;
    // glass tint: faint cool green, grime lifts it toward dusty grey
    const g0 = 0.845, g1 = 0.672;
    rgb[i3] = lerp(g0, g1, grime * 0.55);
    rgb[i3 + 1] = lerp(g0 + 0.018, g1 + 0.010, grime * 0.55);
    rgb[i3 + 2] = lerp(g0 + 0.012, g1 - 0.020, grime * 0.55);

    let ro = 0.045;
    ro += grime * 0.30;
    ro += sstep(0.55, 0.95, smudge[i]) * 0.14;
    ro += scratches[i] * 0.22;
    rough[i] = ro;
  }

  return finish(W, H, {
    height, rgb, rough, metal: 0, wear: 0, wearCavity: 0.0,
    normalStrength: 0.35,
    aoRadii: [3, 12], aoWeights: [0.6, 0.4],
    aoStrength: 0.25,
    cavityGrime: 0.12,
    edgeWear: 0.0,
    roughMin: 0.035, roughMax: 0.2,
  });
}

/* ═══════════════════════════════ FABRIC ═══════════════════════════════ */

function fabric(W, H, seed) {
  const S = W * H;
  const [wx, wy] = warpPair(W, H, seed, 4, 3);
  const ribs = Math.max(8, Math.round(W / 36));
  const drape = warp(fbm(W, H, { seed: seed + 1, cells: 2.5, octaves: 4, gain: 0.6 }), W, H, wx, wy, W * 0.05);
  const nap = microGrain(W, H, { seed: seed + 2, finest: 4, octaves: 3 });
  const tone = equalize(warp(fbm(W, H, { seed: seed + 3, cells: 2.5, octaves: 4 }), W, H, wy, wx, W * 0.07));
  const roughN = equalize(warp(fbm(W, H, { seed: seed + 4, cells: 5, octaves: 4 }), W, H, wx, wy, W * 0.04));
  const wearN = equalize(warp(fbm(W, H, { seed: seed + 5, cells: 4, octaves: 4 }), W, H, wy, wx, W * 0.05));
  const dirt = equalize(warp(fbm(W, H, { seed: seed + 6, cells: 3, octaves: 4 }), W, H, wx, wy, W * 0.06));
  // grease and rain: canvas that has been handled or soaked is far from matte
  const sheenN = equalize(warp(fbm(W, H, { seed: seed + 7, cells: 2.2, octaves: 4 }), W, H, wy, wx, W * 0.06));
  const hx = fbmSigned(W, H, { seed: seed + 21, cells: W / 24, octaves: 3 });
  const hy = fbmSigned(W, H, { seed: seed + 22, cells: W / 24, octaves: 3 });

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);
  const wearF = new Float32Array(S);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // 2/1 twill — the diagonal wale is why mil-spec canvas reads as canvas
      const d = ((x * 1 + y * 2) / W) * ribs + wx[i] * 0.55 + hx[i] * 0.42;
      const fd = d - Math.floor(d);
      const rib = Math.sin(fd * Math.PI);
      const cross = ((x * 2 - y * 1) / W) * ribs * 0.5 + wy[i] * 0.5 + hy[i] * 0.35;
      const fc = cross - Math.floor(cross);
      const crossRib = Math.sin(fc * Math.PI);

      height[i] = 0.5 + rib * 0.105 + crossRib * 0.04
        + (nap[i] - 0.5) * 0.17
        + (drape[i] - 0.5) * 0.24;

      // olive drab 7 field canvas
      const t = tone[i];
      let r = 0.222 + t * 0.086;
      let g = 0.232 + t * 0.084;
      let b = 0.178 + t * 0.062;
      const sh = 0.84 + rib * 0.22 + (nap[i] - 0.5) * 0.32;
      r *= sh; g *= sh; b *= sh;

      const wv = sstep(0.62, 0.95, wearN[i]);      // abraded, fibres lifted & paler
      r = lerp(r, 0.298, wv * 0.42);
      g = lerp(g, 0.296, wv * 0.42);
      b = lerp(b, 0.252, wv * 0.42);

      const dv = sstep(0.55, 0.95, dirt[i]);
      r *= 1 - dv * 0.30; g *= 1 - dv * 0.30; b *= 1 - dv * 0.26;

      const i3 = i * 3;
      rgb[i3] = r; rgb[i3 + 1] = g; rgb[i3 + 2] = b;

      // 0.42 (greasy handled band) → 0.98 (dry dusty canvas). The shipped 0.84-0.93
      // band gave every tarp, seat and webbing strap in the map one sheen.
      const gloss = clamp01(0.42 * sstep(0.48, 0.92, roughN[i]) + 0.66 * sstep(0.60, 0.95, sheenN[i]) - 0.25 * dv);
      let ro = lerp(0.985, 0.415, gloss);
      ro += wv * 0.05;
      ro += (nap[i] - 0.5) * 0.06;
      rough[i] = ro;
      wearF[i] = clamp01(dv * 0.9 + wv * 0.35);
    }
  }

  return finish(W, H, {
    height, rgb, rough, metal: 0, wear: wearF, wearCavity: 0.55,
    normalStrength: 0.95,
    aoRadii: [2, 6, 18],
    aoStrength: 1.15,
    cavityGrime: 0.42,
    edgeWear: 0.09,
    edgeColor: [0.44, 0.44, 0.38],
    roughMin: 0.36,
  });
}

/* ═══════════════════════════════ PLASTER ═══════════════════════════════ */

function plaster(W, H, seed) {
  const S = W * H;
  const [wx, wy] = warpPair(W, H, seed, 3, 3);

  const swirl = equalize(warp(fbm(W, H, { seed: seed + 1, cells: 4, octaves: 5, gain: 0.55 }), W, H, wx, wy, W * 0.14));
  const trowel = equalize(warp(fbm(W, H, { seed: seed + 2, cells: 8, octaves: 4, scaleX: 4, scaleY: 1 }), W, H, wy, wx, W * 0.06));
  const blotch = equalize(warp(fbm(W, H, { seed: seed + 3, cells: 1.8, octaves: 4 }), W, H, wx, wy, W * 0.08));
  const grain = microGrain(W, H, { seed: seed + 4, finest: 4, octaves: 3 });
  /**
   * The missing octave. The recipe had 48 cm swirl and 9 mm grain and NOTHING in
   * between, which is exactly why the plinth read as watercolour blooms: at any
   * viewing distance past ~2 m the grain has mipped away and only the blooms are
   * left. `cells: 30` on a ~1.9 m tile is a 6 cm float/mottle scale — the band the
   * eye actually uses to judge that a surface is rendered mortar and not paint.
   */
  const mott = equalize(warp(fbm(W, H, { seed: seed + 15, cells: 30, octaves: 4, gain: 0.52 }), W, H, wy, wx, W * 0.012));
  const roughN = equalize(warp(fbm(W, H, { seed: seed + 5, cells: 3.5, octaves: 4 }), W, H, wy, wx, W * 0.06));
  const stainN = equalize(warp(fbm(W, H, { seed: seed + 6, cells: 3, octaves: 4 }), W, H, wx, wy, W * 0.07));
  // an independent wet/dry field so the roughness break-up does not trace the stains
  const dampN = equalize(warp(fbm(W, H, { seed: seed + 12, cells: 2.2, octaves: 4 }), W, H, wy, wx, W * 0.05));
  const flakeCell = worley(W, H, Math.round(W / 40), seed + 7, { jitter: 1.0 });
  const net = worley(W, H, Math.max(4, Math.round(W / 110)), seed + 8, { jitter: 0.9 });
  const netPx = (W / Math.max(4, Math.round(W / 110))) * 0.5;
  /**
   * ── CRACK NETWORK, same treatment as the concrete recipe ─────────────────
   *
   * This recipe shipped the raw `sstep(0.016, 0.002, d2 - d1)` Voronoi contour,
   * and a 2x2 layout of the albedo showed exactly what the review said it would:
   * CLOSED pentagons and hexagons of uniform width meeting at rounded 120-degree
   * junctions — a computational-geometry diagram, not a crazed render coat. Three
   * corrections, all of them the same ones concrete already carries:
   *
   *   · a low-frequency "liveness" field erases roughly half of every loop, so
   *     what survives terminates in branches instead of closing;
   *   · the half-width is driven by that same liveness, so a crack opens in the
   *     middle of a live run and tapers to nothing at each end;
   *   · the finished ridge distance is domain-warped by a dedicated short-
   *     wavelength noise pair, which turns every straight Voronoi segment into a
   *     meander without touching the topology.
   */
  const alive = equalize(warp(fbm(W, H, { seed: seed + 16, cells: 6, octaves: 4, gain: 0.55 }), W, H, wx, wy, W * 0.03));
  const ckx = fbmSigned(W, H, { seed: seed + 17, cells: 22, octaves: 4, gain: 0.55 });
  const cky = fbmSigned(W, H, { seed: seed + 18, cells: 22, octaves: 4, gain: 0.55 });
  const netRidge = new Float32Array(S);
  for (let i = 0; i < S; i++) netRidge[i] = (net.d2[i] - net.d1[i]) * netPx;
  const netW = warp(netRidge, W, H, ckx, cky, W * 0.012);

  /**
   * THE fix for "no high-frequency detail at 3 m — watercolour blooms on drywall".
   * A render-coat over blockwork is a sand-cement mortar: at this material's ~1.9 m
   * shipped tile one texel is ~1.9 mm, so a cellular field at ~4.5 texels puts a
   * sand grain every ~8 mm, which is what you actually see standing three metres off
   * a rendered plinth. It goes into the ALBEDO as well as the height — detail that
   * only exists in the normal reads as embossed plastic.
   */
  const sandCell = worley(W, H, Math.max(8, Math.round(W / 4.5)), seed + 13, { jitter: 1.0 });
  // sparse blow-holes / popped aggregate, an order of magnitude coarser than the sand
  const pock = new Float32Array(S);
  studs(pock, W, H, seed + 14, {
    cols: Math.max(6, Math.round(W / 15)), radius: 0.13, jitter: 0.95,
    strength: 1, chance: 0.42,
  });

  const cracks = new Float32Array(S);
  scribe(cracks, W, H, seed + 9, {
    count: Math.max(4, Math.round(W / 110)), length: W * 0.38, wander: 0.5,
    width: W / 1400, strength: 0.9,
  });

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);
  const wearF = new Float32Array(S);

  const seeds = new Float32Array(S);
  for (let i = 0; i < S; i++) seeds[i] = sstep(0.80, 0.95, stainN[i]);
  const stain = gravityStreak(seeds, W, H, { decay: 1 - 2.6 / H, drift: wy, driftAmount: 0.6 });

  for (let i = 0; i < S; i++) {
    // crazing net: terminating, tapered, meandering — see the note by `alive`
    const av = sstep(0.42, 0.76, alive[i]);
    const hw = 0.45 + 1.35 * av;
    const core = sstep(hw, hw * 0.22, netW[i]) * av;
    const stress = 0.30 + 0.70 * sstep(0.42, 0.74, blotch[i]);
    const crackAmt = clamp01(cracks[i] * sstep(0.30, 0.55, blotch[i]) + core * stress);
    /**
     * Flakes. `flakeCell.d1` alone gave every blown patch of render the same
     * circular 7 cm footprint — a field of identical dark polka dots, which is
     * as recognisable a Worley signature as the closed crack loops were. The
     * per-cell id now varies the radius by 2.5x and empties roughly a third of
     * the cells, and the distance itself is perturbed by the 6 cm float noise
     * so the edge of a blown patch is ragged rather than a perfect circle.
     */
    // 0.18 floor: without it every blown patch on the wall lived inside ONE
    // tile-scale blob, and the 2x2 layout showed that cluster repeating like a
    // watermark. A floor scatters isolated flakes across the whole tile and
    // keeps the dense patch as a variation rather than as the only occurrence.
    /**
     * 0.58 floor, was 0.18. The shipped frame proved the old value: the cream
     * plinth in the closeup carried the SAME distinctive speckled flake cluster
     * four times in a row at the same height — a textbook "visible texture tiling
     * repetition" instant-fail. The cause is that the gate is a tile-scale field,
     * so at an 0.18 floor essentially all the flaking lived inside one blob per
     * repeat and the blob's silhouette became the tile's signature. Raising the
     * floor scatters flaking over the whole tile and demotes the dense patch from
     * "the only occurrence" to "a variation".
     */
    const flakeMask = 0.58 + 0.42 * sstep(0.50, 0.86, swirl[i] * 0.58 + blotch[i] * 0.42);
    const fEdge = 0.28 + flakeCell.id[i] * 0.32;
    /**
     * The perturbation has to be SHORTER-wavelength than the cell it is
     * breaking, or it just translates the disc instead of ragging its edge —
     * which is why a 6 cm mottle alone left perfect circles on a 7 cm flake.
     * `grain` runs 5 cm down to 6 mm and does the actual work here.
     */
    const fd = flakeCell.d1[i] + (grain[i] - 0.5) * 0.34 + (mott[i] - 0.5) * 0.14;
    const flake = clamp01(flakeMask * sstep(fEdge, fEdge * 0.34, fd) * 1.35);

    // ~1 mm sand grain, plus the occasional popped void
    const sand = sstep(0.62, 0.14, sandCell.d1[i]);
    const sid = sandCell.id[i];
    const hole = clamp01(pock[i] - 0.34) * 1.4;

    height[i] = 0.52
      + (swirl[i] - 0.5) * 0.058
      + (trowel[i] - 0.5) * 0.050            // trowel ridges: real relief, not a tint
      + (mott[i] - 0.5) * 0.052              // 6 cm float texture
      + (grain[i] - 0.5) * 0.016
      + (sand - 0.5) * 0.030
      - hole * 0.20
      - crackAmt * 0.28
      - flake * 0.16;

    // warm off-white render, desaturated toward the desaturated-military palette
    /**
     * Dropped from a 0.712 base to 0.628 and the variation terms widened. The plinth
     * shipped as a near-white cream that clipped on the sunlit face, and a clipped
     * surface cannot show ANY of the detail underneath it — the review's "single
     * uniform sheen across the whole 4 m face" was partly a value problem, not only a
     * roughness one. A dusty render sits well below paper white.
     */
    /**
     * Tile-scale budget, same reasoning as the concrete recipe: `blotch` runs at
     * 1.8 cells per tile, so at 0.152 it was a single high-contrast bloom per
     * repeat and a 2x2 layout read as wallpaper. Halved, with the energy pushed
     * into the 6 cm float mottle, which cannot betray the tile.
     */
    const v = 0.628 + blotch[i] * 0.074 + (swirl[i] - 0.5) * 0.048 + (grain[i] - 0.5) * 0.052
      + (trowel[i] - 0.5) * 0.062 + (mott[i] - 0.5) * 0.160;
    const st = clamp01(stain[i]);
    let r = v * 1.012, g = v * 0.998, b = v * 0.964;
    // every grain of sand is a slightly different mineral — this is the high-frequency
    // ALBEDO break-up that keeps the surface alive at three metres
    const gk = 1 + (sid - 0.5) * 0.30 * sand - sand * 0.055;
    r *= gk; g *= gk * 0.997; b *= gk * 0.992;
    r *= 1 - hole * 0.26; g *= 1 - hole * 0.26; b *= 1 - hole * 0.25;
    // nicotine / water stain: yellow-brown, follows gravity. Held to a third of
    // its old strength — it seeds off a 3-cell field, so at full contrast it was
    // one unmistakable tan continent per tile.
    r = lerp(r, 0.470, st * 0.34);
    g = lerp(g, 0.410, st * 0.36);
    b = lerp(b, 0.318, st * 0.40);
    /**
     * Flaked render reveals the grey backing coat, not a hole. At 0.68 toward
     * 0.408 a flake was 35 % darker than the wall around it, which is what made
     * the cluster read as a stamped decal rather than as lost surface.
     */
    r = lerp(r, 0.492, flake * 0.42); g = lerp(g, 0.486, flake * 0.42); b = lerp(b, 0.472, flake * 0.42);
    const ck = 1 - crackAmt * 0.52;
    r *= ck; g *= ck; b *= ck;

    const i3 = i * 3;
    rgb[i3] = r; rgb[i3 + 1] = g; rgb[i3 + 2] = b;

    /**
     * Roughness spread 0.40 (burnished / damp) → 0.97 (chalked, dusty, flaked).
     * The plinth previously shipped 0.75–0.90, which is a single specular lobe over
     * a 4 m face. Clamped-sum form so coincident masks cannot punch through to a
     * mirror.
     */
    const damp = sstep(0.66, 0.94, dampN[i]);
    const gloss = clamp01(
      0.42 * sstep(0.52, 0.92, roughN[i])      // burnished trowel passes
      + 0.34 * damp                             // rain-wetted band
      + 0.34 * st                               // stains are damp-glossy
      + 0.22 * sstep(0.60, 0.95, trowel[i])     // the steel-troweled ridge tops shine
      + 0.20 * sstep(0.58, 0.96, mott[i]),
    );
    wearF[i] = clamp01(st * 0.9 + flake * 0.45 + crackAmt * 0.35);
    let ro = lerp(0.975, 0.375, gloss);
    ro += flake * 0.10;                         // torn render is matte
    ro += hole * 0.06;
    ro += sand * 0.05;
    ro += (grain[i] - 0.5) * 0.07;
    rough[i] = ro;
  }

  return finish(W, H, {
    height, rgb, rough, metal: 0, wear: wearF, wearCavity: 0.55,
    // the level eases this material's normal to 0.36 for architectural surfaces, so
    // the recipe has to author well above 1.0 for the 6 cm float texture to survive
    normalStrength: 1.40,
    aoRadii: [2, 9, 28],
    aoStrength: 1.05,
    cavityGrime: 0.44,
    edgeWear: 0.11,
    edgeColor: [0.86, 0.845, 0.81],
    edgeRoughDelta: -0.14,
    creviceRoughDelta: 0.06,
    roughMin: 0.3,
  });
}

/* ═══════════════════════════════ RUBBER ═══════════════════════════════ */

function rubber(W, H, seed) {
  const S = W * H;
  const [wx, wy] = warpPair(W, H, seed, 4, 3);
  const pebble = worley(W, H, Math.round(W / 11), seed + 1, { jitter: 1.0 });
  const pebble2 = worley(W, H, Math.round(W / 5), seed + 8, { jitter: 1.0 });
  const micro = microGrain(W, H, { seed: seed + 2, finest: 4, octaves: 3 });
  const mould = warp(fbm(W, H, { seed: seed + 9, cells: 3, octaves: 4, scaleX: 2.5, scaleY: 1 }), W, H, wx, wy, W * 0.05);
  const dust = equalize(warp(fbm(W, H, { seed: seed + 3, cells: 3, octaves: 4 }), W, H, wx, wy, W * 0.07));
  const roughN = equalize(warp(fbm(W, H, { seed: seed + 4, cells: 4, octaves: 4 }), W, H, wy, wx, W * 0.05));
  const scuffN = equalize(warp(fbm(W, H, { seed: seed + 5, cells: 6, octaves: 4 }), W, H, wx, wy, W * 0.04));

  const scuffs = new Float32Array(S);
  scribe(scuffs, W, H, seed + 6, {
    count: Math.round(W / 30), length: W * 0.3, wander: 0.2,
    width: W / 800, strength: 0.9,
  });

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);
  const wearF = new Float32Array(S);

  for (let i = 0; i < S; i++) {
    const peb = sstep(0.78, 0.06, pebble.d1[i]);
    const peb2 = sstep(0.70, 0.10, pebble2.d1[i]);
    height[i] = 0.46 + peb * 0.16 + peb2 * 0.07
      + (mould[i] - 0.5) * 0.09
      + (micro[i] - 0.5) * 0.05
      - scuffs[i] * 0.05;

    // vulcanised black rubber: linear albedo ≈0.02 → ~0.15 sRGB, never pure black
    let v = 0.148 + (micro[i] - 0.5) * 0.026 + pebble.id[i] * 0.014 + peb * 0.010;
    const d = sstep(0.5, 0.92, dust[i]);
    let r = v, g = v * 0.995, b = v * 1.012;
    r = lerp(r, 0.252, d * 0.42);
    g = lerp(g, 0.244, d * 0.42);
    b = lerp(b, 0.232, d * 0.42);
    const sc = scuffs[i];
    r += sc * 0.075; g += sc * 0.072; b += sc * 0.068;

    const i3 = i * 3;
    rgb[i3] = r; rgb[i3 + 1] = g; rgb[i3 + 2] = b;

    // rubber has a broad, soft specular — mid roughness with real variation
    // moulded rubber: 0.40 on a clean released face, 0.95 where it is dusty and
    // sun-perished. Shipped band was 0.54-0.69 — a single soft plastic lobe.
    let ro = 0.58;
    ro += 0.30 * sstep(0.46, 0.92, roughN[i]);
    ro -= 0.24 * sstep(0.50, 0.92, 1 - roughN[i]);
    ro += d * 0.26;
    ro += sstep(0.55, 0.94, scuffN[i]) * 0.14;
    ro += sc * 0.14;
    ro += (micro[i] - 0.5) * 0.06;
    rough[i] = ro;
    wearF[i] = clamp01(d * 0.8);
  }

  return finish(W, H, {
    height, rgb, rough, metal: 0, wear: wearF, wearCavity: 0.45,
    normalStrength: 1.2,
    aoRadii: [2, 6, 18],
    aoStrength: 1.0,
    cavityGrime: 0.26,
    edgeWear: 0.07,
    edgeColor: [0.30, 0.298, 0.292],
    roughMin: 0.3,
  });
}

/* ═══════════════════════════ CORRUGATED METAL ═══════════════════════════ */

/**
 * Galvanised profiled cladding, fifteen winters old.
 *
 * The review called this "a rack of polished chrome half-pipes". Three separate
 * causes, all fixed here rather than by pushing the level's scalar multipliers harder:
 *
 *  1. METALNESS. The recipe shipped 0.98 on clean zinc. Galvanising that has weathered
 *     is not bare zinc any more — it is zinc carbonate/hydroxide chalk, a DIELECTRIC
 *     powder over the metal. 0.42 with a mid roughness is what makes it read as sheet
 *     rather than chrome tube.
 *  2. NO ROUGHNESS BREAK BETWEEN CREST AND TROUGH. Rain scours the crests and dirt
 *     packs the valleys; that is the single strongest cue that a corrugation is a
 *     pressed sheet. Valleys now take +0.22 roughness and -30% albedo.
 *  3. PERFECT PERIODICITY. Every rib carried an identical highlight. Three
 *     decorrelated breakers now cross the ribs: a large-scale roughness envelope at a
 *     non-integer ratio to the rib pitch, per-panel value jitter, and rust runs that
 *     ignore the corrugation phase entirely.
 *
 * WAVES is 8 per 2.4 m tile = a 300 mm texture pitch, deliberately EQUAL to the
 * level's geometric corrugation period. The old 7 (343 mm) beat against the geometry
 * with a 2.4 m envelope and made every wall a moire barcode.
 */
function corrugatedMetal(W, H, seed) {
  const S = W * H;
  const [wx, wy] = warpPair(W, H, seed, 4, 3);
  const WAVES = 8;
  const PANELS = 3;                      // ~800 mm sheets across the 2.4 m tile

  const spangle = worley(W, H, Math.round(W / 44), seed + 1, { jitter: 1.0 });
  const rustN = equalize(warp(fbm(W, H, { seed: seed + 2, cells: 3, octaves: 6, gain: 0.55 }), W, H, wx, wy, W * 0.09));
  const rustDet = equalize(warp(fbm(W, H, { seed: seed + 3, cells: 18, octaves: 4 }), W, H, wy, wx, W * 0.025));
  const dentN = equalize(warp(fbm(W, H, { seed: seed + 4, cells: 5, octaves: 4 }), W, H, wx, wy, W * 0.05));
  const roughN = equalize(warp(fbm(W, H, { seed: seed + 5, cells: 4.5, octaves: 4 }), W, H, wy, wx, W * 0.05));
  const grain = microGrain(W, H, { seed: seed + 6, finest: 4, octaves: 3 });
  /**
   * The periodicity breaker. cells 1.7 is deliberately NOT a divisor of WAVES, so
   * runs of ribs go dull while their neighbours stay sharp and the pattern never
   * lines up with itself.
   */
  const dullN = equalize(warp(fbm(W, H, { seed: seed + 9, cells: 1.7, octaves: 3, gain: 0.62 }), W, H, wx, wy, W * 0.06));
  // chalking: the white powdery bloom that kills the specular on old galvanising
  const chalkN = equalize(warp(fbm(W, H, { seed: seed + 10, cells: 2.6, octaves: 4 }), W, H, wy, wx, W * 0.05));
  /**
   * MICRO-SURFACE OF THE RUST ITSELF. The review's sharpest observation on the
   * containers was that "the corrugation's smooth specular gradient runs straight
   * through every rust blotch completely unchanged" — the rust was an albedo decal
   * over an otherwise intact sheet. Real oxide is a scab: it lifts, flakes, and
   * leaves a pitted crater under whatever has spalled off. These two cellular
   * fields are keyed entirely off the rust mask, so they exist ONLY inside the
   * blotches, and they break the rib highlight exactly where the paint has gone.
   */
  const oxidePit = worley(W, H, Math.round(W / 5), seed + 11, { jitter: 1.0 });
  const oxideFlake = worley(W, H, Math.round(W / 26), seed + 12, { jitter: 1.0 });

  const scratches = new Float32Array(S);
  scribe(scratches, W, H, seed + 7, {
    count: Math.round(W / 34), length: W * 0.3, wander: 0.08,
    width: W / 1600, strength: 0.85, dirBias: Math.PI / 2, biasStrength: 0.85,
  });

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);
  const metal = new Float32Array(S);
  const wearF = new Float32Array(S);

  // rust seeds preferentially in the valleys, then runs downward
  const valley = new Float32Array(S);
  const corrF = new Float32Array(S);
  const TWO_PI = Math.PI * 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = (x / W) * WAVES * TWO_PI;
      const c = Math.sin(t) * 0.5 + 0.5;
      corrF[i] = c;
      valley[i] = 1 - c;
    }
  }
  const seeds = new Float32Array(S);
  for (let i = 0; i < S; i++) {
    seeds[i] = sstep(0.62, 0.85, rustN[i]) * (0.35 + valley[i] * 0.65);
  }
  const rustRun = gravityStreak(seeds, W, H, { decay: 1 - 2.4 / H, drift: wx, driftAmount: 0.3 });
  /**
   * A SECOND rust run seeded with no valley weighting at all, so these streaks cross
   * crest and trough alike. This is what breaks the unbroken tube highlight: the
   * review's point was that a rib-locked stain still leaves a clean lozenge on every
   * crest, and the eye reads that as chrome.
   */
  const crossSeeds = new Float32Array(S);
  for (let i = 0; i < S; i++) crossSeeds[i] = sstep(0.80, 0.96, rustN[i] * 0.5 + rustDet[i] * 0.5);
  const crossRun = gravityStreak(crossSeeds, W, H, { decay: 1 - 1.7 / H, drift: wy, driftAmount: 0.5 });

  const boltRows = 3;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = corrF[i];

      // fastener dimples ride the ridge crests
      let bolt = 0;
      const ry = (y / H) * boltRows;
      const rf = Math.abs(ry - Math.floor(ry) - 0.5);
      const bx = (x / W) * WAVES;
      const bf = Math.abs(bx - Math.floor(bx) - 0.25);
      if (rf < 0.06 && bf < 0.06) {
        const dd = Math.sqrt((rf / 0.06) * (rf / 0.06) + (bf / 0.06) * (bf / 0.06));
        bolt = sstep(1.0, 0.25, dd);
      }

      /**
       * ── RUST PLACEMENT ──────────────────────────────────────────────────
       *
       * The review: "large soft-edged black blobs at ~40 cm scale scattered
       * randomly across a pale olive base... they run ACROSS the corrugation ribs
       * rather than following them. Real corten rust originates at fasteners,
       * seams and the bottom rail and streaks vertically downward under gravity."
       *
       * The old mask was 45 % isotropic threshold blob and 55 % streak, and the
       * blob term was the one with hard edges and full contrast, so it won the
       * eye. It is now down to a quarter of the total and acts as a *seed field*
       * for the two gravity runs rather than as rust in its own right, the
       * fastener dimples seed corrosion directly (which is where it actually
       * starts), and the streaks carry three quarters of the mask.
       *
       * The remaining 40 % of the vertical placement — "concentrate in the bottom
       * third, keep it off the roof" — cannot be done from inside a tile that
       * repeats four times up a container. That half of the fix lives in
       * surface.js, driven from world Y, and this mask is what feeds it.
       */
      const rustSeed = sstep(0.64, 0.90, rustN[i] * 0.7 + rustDet[i] * 0.3);
      const rm = clamp01(
        rustSeed * (0.26 + valley[i] * 0.44) * 0.42
        + rustRun[i] * 0.88
        + crossRun[i] * 0.44
        + bolt * 0.46,
      );

      // per-panel value shift — no two sheets on a real shed weathered the same
      const pIdx = Math.floor((x / W) * PANELS);
      const pv = hash2(pIdx, 3, seed);
      const panelK = 0.90 + pv * 0.22;
      // the standing seam where two sheets lap
      const pf = (x / W) * PANELS - pIdx;
      const seam = sstep(0.030, 0.0, Math.min(pf, 1 - pf));

      /**
       * The texture's own corrugation is deliberately SHALLOW (0.26, was 0.72). Every
       * cladding surface in the level carries a real geometric corrugation; the
       * texture's job here is grain, seams and rust, not a second competing profile.
       */
      /**
       * Oxide micro-relief, present only where the rust is a REAL SCAB.
       *
       * `rm` is a sum of a threshold mask and two gravity-streak runs, so it
       * carries a low but non-zero value across almost the whole sheet — the
       * faint bleed stain below every rust patch. Keying the pitting straight
       * off it therefore stippled 6 mm craters over the intact galvanising as
       * well, and a container that is pitted edge to edge reads as hammered
       * metal or a golf ball, not as sound sheet with rust blooms on it.
       * Hardening the mask means the specular of the clean sheet stays smooth
       * and the break-up happens exactly at the paint boundary, which is the
       * contrast the review was actually asking for.
       */
      /**
       * A deliberately UNSATURATED copy of the mask for the wear channel. `rm`
       * plateaus at 1.0 over large runs — fine for an albedo blend, but a wear
       * channel that saturates produces flat 1.0 continents with hard boundaries,
       * and those boundaries then read as a roughness step in the frame. The
       * softer sum keeps a gradient everywhere.
       */
      wearF[i] = clamp01(rustSeed * 0.34 + rustRun[i] * 0.52 + crossRun[i] * 0.30 + bolt * 0.30);
      const rmHard = sstep(0.34, 0.74, rm);
      // per-cell threshold → pit diameter varies 3x and ~a third of cells are
      // empty, so this reads as corrosion rather than as a Worley dot screen
      const oxPit = sstep(0.56 + oxidePit.id[i] * 0.36, 0.98, 1 - oxidePit.d1[i]) * rmHard;
      const oxScab = sstep(0.44, 0.24, oxideFlake.d1[i]) * rmHard;

      height[i] = 0.5
        + (c - 0.5) * 0.26
        + (dentN[i] - 0.5) * 0.070          // dents and bent ribs, now that they fire
        + rm * (rustDet[i] - 0.5) * 0.06
        + oxScab * 0.075                    // lifted flakes stand proud of the sheet
        - oxPit * 0.115                     // and leave a crater where they came off
        - seam * 0.30
        - bolt * 0.06
        - scratches[i] * 0.02;

      // weathered galvanising: chalked, cool, much less bright than fresh zinc
      const chalk = sstep(0.30, 0.86, chalkN[i]);
      const sp = spangle.id[i];
      let zr = 0.478 + sp * 0.066;
      let zg = 0.490 + sp * 0.066;
      let zb = 0.506 + sp * 0.064;
      const facet = sstep(0.55, 0.1, spangle.d1[i]) * 0.04;
      zr += facet; zg += facet; zb += facet;
      // the chalk bloom itself: a pale, flat, slightly warm-grey powder
      zr = lerp(zr, 0.520, chalk * 0.45); zg = lerp(zg, 0.516, chalk * 0.45); zb = lerp(zb, 0.500, chalk * 0.45);
      const gv = (grain[i] - 0.5) * 0.05;
      zr += gv; zg += gv; zb += gv;
      const sc = scratches[i];
      zr += sc * 0.11; zg += sc * 0.112; zb += sc * 0.115;

      /**
       * Rust ramp, dark end lifted from 0.196 to 0.252 sRGB. Combined with the
       * trough dirt, the cavity grime and a low sun this ramp was resolving to
       * near-black on screen, and the review read the container as "near-black-to-
       * tan contrast" leopard print rather than as corrosion. Real oxide is a mid
       * red-brown; it is never the darkest thing in a daylight frame.
       */
      const t = clamp01(rustDet[i] * 0.55 + rustN[i] * 0.45);
      const rr = lerp(0.345, 0.492, t);
      const rg2 = lerp(0.228, 0.346, t);
      const rb = lerp(0.176, 0.252, t);

      /**
       * Only 62 % of the mask is spent here. The rest is carried in ORM.a and
       * re-applied by surface.js *after* it has been multiplied by world height and
       * face orientation — which is what stops the pattern being isotropic and is
       * why the total contrast is preserved rather than merely reduced.
       */
      const rmA = rm * 0.62;
      let r = lerp(zr, rr, rmA);
      let g = lerp(zg, rg2, rmA);
      let b = lerp(zb, rb, rmA);

      // ridges get washed clean by rain, valleys pack with dirt
      const dirt = valley[i] * valley[i] * 0.20;
      r *= 1 - dirt; g *= 1 - dirt; b *= 1 - dirt * 0.92;
      r *= panelK; g *= panelK; b *= panelK;
      r *= 1 - seam * 0.30; g *= 1 - seam * 0.30; b *= 1 - seam * 0.30;
      r *= 1 - bolt * 0.25; g *= 1 - bolt * 0.25; b *= 1 - bolt * 0.25;

      const i3 = i * 3;
      rgb[i3] = r; rgb[i3 + 1] = g; rgb[i3 + 2] = b;

      /**
       * Metalness 0.42 on the clean sheet, not 0.98. Fifteen-year-old galvanising is
       * a dielectric chalk film over the zinc; treating it as a pure conductor is
       * what produced the blown-out white lozenge on every rib.
       */
      /**
       * `1 - rm * 0.88`, not `1 - rm * 1.05`. Rust IS a dielectric, but taking
       * metalness to a hard zero under the oxide while the zinc beside it sits at
       * 0.6 makes the two respond to the environment probe completely differently:
       * on a shaded face — where the probe is most of the light — the metal picks
       * up the bright sky and the oxide does not, and a 1.6:1 albedo difference
       * arrives on screen as a 5:1 one. That expansion is what the review measured
       * as "near-black-to-tan" leopard print. A small conductive floor under the
       * scale (real oxide is a thin film over steel, not a slab of ceramic) keeps
       * the two in the same lighting regime.
       */
      metal[i] = clamp01((0.60 - chalk * 0.18) * (1 - rm * 0.88));

      /**
       * Roughness floor 0.44 — high enough that the specular lobe is wider than a
       * pixel at the distances this material is seen at, which also kills the
       * shimmer/aliasing the review saw on the rib highlights.
       */
      const dull = sstep(0.25, 0.80, dullN[i]);
      let ro = lerp(0.32, 0.62, rm);
      ro += 0.13 * dull * (1 - rm);              // large-scale dull/sharp runs
      ro -= 0.11 * (1 - dull) * (1 - rm);
      ro += chalk * 0.10 * (1 - rm);             // chalk is matte
      ro += valley[i] * valley[i] * 0.14;        // dirt in the troughs
      ro += oxPit * 0.12;                        // torn crater walls are the matte extreme
      ro -= oxScab * 0.06;                       // a fresh flake face still has a sheen
      ro += seam * 0.08;
      ro -= sc * 0.06;
      ro += (grain[i] - 0.5) * 0.05;
      /**
       * Band 0.28-0.66, NOT 0.38-0.90. The level multiplies this material's
       * roughness by 1.45 (a legal "push to matte" knob, since the scalar multiplies
       * the map). At the old band that multiply drove everything above 0.69 into the
       * 1.0 clamp — so the top two thirds of the authored spread, including every
       * rust blotch, collapsed onto a single value and the sheet carried ONE sheen.
       * 0.28-0.66 lands on 0.41-0.96 after the multiply with the whole range intact.
       */
      rough[i] = clamp(ro, 0.28, 0.66);
    }
  }

  return finish(W, H, {
    height, rgb, rough, metal, wear: wearF, wearCavity: 0.62,
    normalStrength: 0.9,
    aoRadii: [3, 12, 40],
    aoStrength: 0.95,
    cavityGrime: 0.30,
    edgeWear: 0.14,
    edgeColor: [0.66, 0.675, 0.69],
    edgeRoughDelta: -0.12,
    edgeMetalDelta: 0.20,
    roughMin: 0.24, roughMax: 0.72,
  });
}

/* ═══════════════════════════════ GRAVEL ═══════════════════════════════ */

function gravel(W, H, seed) {
  const S = W * H;
  const [wx, wy] = warpPair(W, H, seed, 5, 3);

  const big = worley(W, H, Math.round(W / 30), seed + 1, { jitter: 1.0 });
  const mid = worley(W, H, Math.round(W / 15), seed + 2, { jitter: 1.0 });
  const small = worley(W, H, Math.round(W / 7), seed + 3, { jitter: 1.0 });
  const dirtN = equalize(warp(fbm(W, H, { seed: seed + 4, cells: 3, octaves: 5, gain: 0.55 }), W, H, wx, wy, W * 0.06));
  const roughN = equalize(warp(fbm(W, H, { seed: seed + 5, cells: 4, octaves: 4 }), W, H, wy, wx, W * 0.05));
  const grain = microGrain(W, H, { seed: seed + 6, finest: 4, octaves: 4 });
  const wet = equalize(warp(fbm(W, H, { seed: seed + 7, cells: 2.5, octaves: 4 }), W, H, wx, wy, W * 0.08));
  /**
   * Fine wind-blown dust drifting over the top of the stones. This is the mask the
   * review asked the roughness to key off: dust = matte 0.95, exposed aggregate =
   * 0.55, rained-on/polished stone = 0.40. Without it the sunlit half of the yard
   * resolved as ONE broad specular sheet and dry gravel read as wet.
   */
  const dustN = equalize(warp(fbm(W, H, { seed: seed + 8, cells: 1.8, octaves: 4, gain: 0.6 }), W, H, wy, wx, W * 0.07));
  // vehicle tracks — a low-frequency compacted band that polishes the stone tops
  const trackN = equalize(warp(fbm(W, H, { seed: seed + 9, cells: 1.5, octaves: 3, gain: 0.62, scaleX: 1, scaleY: 4 }), W, H, wx, wy, W * 0.04));

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);
  const wearF = new Float32Array(S);

  for (let i = 0; i < S; i++) {
    const bigStone = sstep(0.85, 0.06, big.d1[i]) * sstep(0.34, 0.56, dirtN[i]);
    const midStone = sstep(0.82, 0.08, mid.d1[i]);
    const smStone = sstep(0.80, 0.10, small.d1[i]);

    // stones layered largest-last so big ones sit on top
    let hs = smStone * 0.16 + midStone * 0.30;
    let id = small.id[i];
    if (midStone > 0.45) id = mid.id[i];
    if (bigStone > 0.35) { hs = Math.max(hs, 0.30 + bigStone * 0.36); id = big.id[i]; }

    const dust = sstep(0.34, 0.86, dustN[i]);            // silted-over
    const track = sstep(0.58, 0.94, trackN[i]);          // compacted wheel path

    height[i] = 0.30 + hs * (1 - dust * 0.45 - track * 0.30)
      + (grain[i] - 0.5) * 0.045 + (dirtN[i] - 0.5) * 0.06;

    /**
     * `dust` runs at 1.8 cells per tile. At the old 0.62 it wiped the stones out
     * completely across roughly a third of every tile, leaving a smooth featureless
     * tan continent — which is both the review's "one flat tan across the entire
     * bed" AND, because that continent repeats, a legible tiling signature. 0.34
     * silts the stones over without erasing them: they still read through the film.
     */
    const stoneAmt = clamp01(Math.max(bigStone, Math.max(midStone * 0.9, smStone * 0.7))
      * (1 - dust * 0.34));

    // stone palette: grey granite → tan limestone → dark basalt
    let sr, sg, sb;
    if (id < 0.4) { const k = id / 0.4; sr = lerp(0.310, 0.492, k); sg = lerp(0.318, 0.496, k); sb = lerp(0.328, 0.490, k); }
    else if (id < 0.78) { const k = (id - 0.4) / 0.38; sr = lerp(0.478, 0.598, k); sg = lerp(0.440, 0.540, k); sb = lerp(0.368, 0.436, k); }
    else { const k = (id - 0.78) / 0.22; sr = lerp(0.168, 0.268, k); sg = lerp(0.166, 0.262, k); sb = lerp(0.178, 0.270, k); }
    // per-granule value scatter on top of the palette — no two pebbles the same rock
    /**
     * Per-granule value scatter widened to ±24 % (was ±20 %) and given an
     * independent hue kick. Ballast separates into individual chips by TONE as
     * much as by the shadow between stones; without enough tonal spread the
     * shadows are the only cue and the bed reads as one crusted mass.
     */
    const idv = 0.76 + ((id * 7919) % 1) * 0.48;
    const idh = ((id * 3121) % 1) - 0.5;
    sr *= idv * (1 + idh * 0.10); sg *= idv; sb *= idv * (1 - idh * 0.12);
    const gv = (grain[i] - 0.5) * 0.085;
    sr += gv; sg += gv; sb += gv;

    // packed dust/dirt between the stones
    const dv = dirtN[i];
    const dr = 0.322 + dv * 0.122, dg = 0.290 + dv * 0.104, db = 0.234 + dv * 0.078;

    let r = lerp(dr, sr, stoneAmt);
    let g = lerp(dg, sg, stoneAmt);
    let b = lerp(db, sb, stoneAmt);

    // pale alkaline dust film lifts and desaturates whatever it settles on
    const dk = dust * 0.34;
    r = lerp(r, 0.438, dk); g = lerp(g, 0.410, dk); b = lerp(b, 0.354, dk);
    // trodden paths are rubbed darker and greyer
    r *= 1 - track * 0.11; g *= 1 - track * 0.105; b *= 1 - track * 0.085;

    const wv = sstep(0.72, 0.96, wet[i]);
    r *= 1 - wv * 0.21; g *= 1 - wv * 0.21; b *= 1 - wv * 0.18;

    const i3 = i * 3;
    rgb[i3] = r; rgb[i3 + 1] = g; rgb[i3 + 2] = b;

    /**
     * Roughness: 0.98 in the dust → 0.55 on a clean stone face → 0.40 where it is
     * damp or polished by traffic. Previously the whole field lived in 0.76–0.95,
     * which is one specular lobe and the reason dry gravel read as glazed.
     */
    const gloss = clamp01(
      0.42 * stoneAmt * sstep(0.42, 0.92, roughN[i])
      + 0.40 * track
      + 0.62 * wv
      - 0.55 * dust,
    );
    let ro = lerp(0.975, 0.375, gloss);
    ro += dust * 0.02;
    ro += (grain[i] - 0.5) * 0.07;
    rough[i] = ro;
    wearF[i] = clamp01(dust * 0.55 + track * 0.6 + wv * 0.45);
  }

  return finish(W, H, {
    height, rgb, rough, metal: 0, wear: wearF, wearCavity: 0.5,
    normalStrength: 1.45,
    aoRadii: [2, 7, 22],
    aoStrength: 1.3,
    cavityGrime: 0.48,
    edgeWear: 0.13,
    edgeColor: [0.62, 0.59, 0.53],
    roughMin: 0.32,
  });
}

/* ═══════════════════════════════ BRICK ═══════════════════════════════ */

function brick(W, H, seed) {
  const S = W * H;
  const [wx, wy] = warpPair(W, H, seed, 5, 3);

  const ROWS = 8, COLS = 3;
  const face = equalize(warp(fbm(W, H, { seed: seed + 1, cells: 14, octaves: 5, gain: 0.5 }), W, H, wx, wy, W * 0.02));
  const sand = microGrain(W, H, { seed: seed + 2, finest: 4, octaves: 4 });
  const jointN = fbmSigned(W, H, { seed: seed + 3, cells: 22, octaves: 3 });
  const soot = equalize(warp(fbm(W, H, { seed: seed + 4, cells: 2.5, octaves: 4 }), W, H, wy, wx, W * 0.08));
  const roughN = equalize(warp(fbm(W, H, { seed: seed + 5, cells: 4, octaves: 4 }), W, H, wx, wy, W * 0.05));
  const pit = worley(W, H, Math.round(W / 10), seed + 6, { jitter: 1.0 });
  const effN = equalize(warp(fbm(W, H, { seed: seed + 7, cells: 3.5, octaves: 4 }), W, H, wy, wx, W * 0.06));
  const dampN = equalize(warp(fbm(W, H, { seed: seed + 9, cells: 2.0, octaves: 4 }), W, H, wx, wy, W * 0.06));

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);
  const wearF = new Float32Array(S);

  const seeds = new Float32Array(S);
  for (let i = 0; i < S; i++) seeds[i] = sstep(0.80, 0.94, soot[i]);
  const sootRun = gravityStreak(seeds, W, H, { decay: 1 - 3.0 / H, drift: wx, driftAmount: 0.5 });

  const MJ_V = 0.115;  // mortar joint thickness in brick units
  const MJ_H = 0.048;

  for (let y = 0; y < H; y++) {
    const ry = (y / H) * ROWS;
    const ri = Math.floor(ry);
    const rf = ry - ri;
    const stagger = (ri & 1) ? 0.5 : 0.0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // wobble the joints so they are not laser-straight
      const jv = jointN[i] * 0.018;
      const cx = (x / W) * COLS + stagger + jv * 0.5;
      const ci = Math.floor(cx);
      const cf = cx - ci;

      const dv = Math.min(rf, 1 - rf) - jv;
      const dh = Math.min(cf, 1 - cf) - jv;
      const inV = sstep(MJ_V * 0.35, MJ_V, dv);
      const inH = sstep(MJ_H * 0.35, MJ_H, dh);
      let inBrick = inV * inH;

      const bid = hash2(ci, ri, seed);
      const bid2 = hash2(ci + 91, ri + 17, seed);
      const bid3 = hash2(ci + 7, ri + 133, seed);

      /**
       * PER-BRICK NOISE PHASE. `face` and `pit` are global fields, so every brick in
       * the wall used to contain the same mottle motif at the same phase — the
       * review's "one identical block cell everywhere". Re-sampling the same fields
       * at a per-brick hashed offset (and a per-brick 90-degree rotation) costs one
       * extra fetch and makes every brick a different brick, without a second
       * texture or a second noise evaluation. The offsets wrap, so tiling is intact.
       */
      const ox = (hash2(ci + 311, ri + 53, seed) * W) | 0;
      const oy = (hash2(ci + 17, ri + 907, seed) * H) | 0;
      const flip = hash2(ci + 401, ri + 211, seed) < 0.5;
      const bx = flip ? y : x;
      const by = flip ? x : y;
      const fi = (((by + oy) % H) * W) + ((bx + ox) % W);
      const faceV = face[fi];
      const pitV = pit.d1[fi];

      // chipped corners / broken faces on a minority of bricks
      const chipK = bid3 < 0.30 ? sstep(0.30, 0.0, bid3) : 0;
      const cornerD = Math.min(dv / MJ_V, dh / MJ_H);
      const chip = chipK * sstep(2.2, 0.4, cornerD) * sstep(0.35, 0.75, faceV);
      inBrick = clamp01(inBrick - chip * 0.9);

      const pitting = sstep(0.72, 0.98, 1 - pitV) * inBrick * sstep(0.35, 0.7, faceV);

      height[i] = 0.5
        - (1 - inBrick) * 0.34
        + inBrick * (faceV - 0.5) * 0.062
        + (sand[i] - 0.5) * 0.030
        - pitting * 0.13;

      // ── brick colour: desaturated red-browns with grey/overburnt outliers
      let br, bg, bb;
      if (bid < 0.16) { br = 0.268; bg = 0.216; bb = 0.198; }        // dark overburnt
      else if (bid < 0.34) { br = 0.382; bg = 0.268; bb = 0.212; }   // ochre
      else if (bid < 0.80) { br = 0.402; bg = 0.222; bb = 0.172; }   // standard red
      else { br = 0.342; bg = 0.272; bb = 0.238; }                   // buff / grey
      // per-brick VALUE scale, 0.85-1.15, on top of the palette pick
      const bv = (bid2 - 0.5) * 0.075;
      br += bv; bg += bv * 0.85; bb += bv * 0.75;
      const fv = (faceV - 0.5) * 0.128;
      br += fv; bg += fv * 0.8; bb += fv * 0.7;
      br += (sand[i] - 0.5) * 0.04; bg += (sand[i] - 0.5) * 0.034; bb += (sand[i] - 0.5) * 0.03;
      // per-brick soiling — a wall of identically clean bricks reads as wallpaper
      const soil = (0.74 + hash2(ci + 53, ri + 71, seed) * 0.30)
        * (0.86 + hash2(ci + 617, ri + 29, seed) * 0.30);
      br *= soil; bg *= soil; bb *= soil;

      // ── mortar: pale sandy grey, coarse
      const mvar = (sand[i] - 0.5) * 0.095 + (faceV - 0.5) * 0.055;
      const mr = 0.505 + mvar, mg = 0.492 + mvar, mb = 0.455 + mvar;

      let r = lerp(mr, br, inBrick);
      let g = lerp(mg, bg, inBrick);
      let b = lerp(mb, bb, inBrick);

      // efflorescence blooms out of the joints
      const eff = sstep(0.70, 0.94, effN[i]) * (1 - inBrick * 0.55);
      r = lerp(r, 0.72, eff * 0.5); g = lerp(g, 0.715, eff * 0.5); b = lerp(b, 0.695, eff * 0.5);

      // soot / rain grime running down
      const sv = clamp01(sootRun[i]);
      const sk = 1 - sv * 0.36;
      r *= sk; g *= sk; b *= sk;

      const i3 = i * 3;
      rgb[i3] = r; rgb[i3 + 1] = g; rgb[i3 + 2] = b;

      // fired brick skin is glassy where it survives, chalky where it has spalled
      const damp = sstep(0.62, 0.94, dampN[i]);
      let ro = lerp(0.965, 0.735, inBrick);
      ro += (hash2(ci + 733, ri + 191, seed) - 0.5) * 0.22 * inBrick;  // per-brick sheen
      ro -= 0.34 * sstep(0.46, 0.90, roughN[i]) * inBrick;   // fired-face sheen
      ro += 0.10 * sstep(0.50, 0.92, 1 - roughN[i]);
      ro -= 0.30 * damp;                                     // rain-darkened band
      ro += eff * 0.07;
      ro += pitting * 0.10;
      ro += (sand[i] - 0.5) * 0.06;
      rough[i] = ro;
      wearF[i] = clamp01(sv * 0.9 + eff * 0.35 + (1 - inBrick) * 0.35);
    }
  }

  return finish(W, H, {
    height, rgb, rough, metal: 0, wear: wearF, wearCavity: 0.55,
    normalStrength: 1.05,
    aoRadii: [3, 10, 30],
    aoStrength: 1.2,
    cavityGrime: 0.48,
    edgeWear: 0.10,
    edgeColor: [0.68, 0.60, 0.54],
    roughMin: 0.32,
  });
}

/* ═══════════════════════════════ TARP ═══════════════════════════════ */

function tarp(W, H, seed) {
  const S = W * H;
  const [wx, wy] = warpPair(W, H, seed, 4, 3);

  const scrim = Math.max(10, Math.round(W / 44));
  const fold = warp(fbm(W, H, { seed: seed + 1, cells: 2, octaves: 4, gain: 0.6, scaleX: 1, scaleY: 3 }), W, H, wx, wy, W * 0.07);
  const wrinkle = warp(fbm(W, H, { seed: seed + 2, cells: 5, octaves: 5, gain: 0.5, ridged: true, scaleX: 1, scaleY: 2 }), W, H, wy, wx, W * 0.05);
  const dirtN = equalize(warp(fbm(W, H, { seed: seed + 3, cells: 3, octaves: 4 }), W, H, wx, wy, W * 0.06));
  const roughN = equalize(warp(fbm(W, H, { seed: seed + 4, cells: 4, octaves: 4 }), W, H, wy, wx, W * 0.05));
  const fadeN = equalize(warp(fbm(W, H, { seed: seed + 5, cells: 2.2, octaves: 4 }), W, H, wx, wy, W * 0.07));
  const chalkN = equalize(warp(fbm(W, H, { seed: seed + 8, cells: 1.8, octaves: 3, gain: 0.62 }), W, H, wy, wx, W * 0.08));
  const micro = microGrain(W, H, { seed: seed + 6, finest: 4, octaves: 3 });
  const hx = fbmSigned(W, H, { seed: seed + 21, cells: W / 30, octaves: 3 });
  const hy = fbmSigned(W, H, { seed: seed + 22, cells: W / 30, octaves: 3 });

  const tears = new Float32Array(S);
  scribe(tears, W, H, seed + 7, {
    count: Math.max(2, Math.round(W / 120)), length: W * 0.12, wander: 0.35,
    width: W / 1000, strength: 0.9,
  });

  const height = new Float32Array(S);
  const rgb = new Float32Array(S * 3);
  const rough = new Float32Array(S);
  const wearF = new Float32Array(S);

  const seeds = new Float32Array(S);
  for (let i = 0; i < S; i++) seeds[i] = sstep(0.78, 0.94, dirtN[i]);
  const run = gravityStreak(seeds, W, H, { decay: 1 - 3.6 / H, drift: wy, driftAmount: 0.5 });

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // woven scrim visible under the PVC coating
      const u = (x / W) * scrim + wx[i] * 0.28 + hx[i] * 0.30;
      const v = (y / H) * scrim + wy[i] * 0.28 + hy[i] * 0.30;
      const su = Math.sin((u - Math.floor(u)) * Math.PI);
      const sv = Math.sin((v - Math.floor(v)) * Math.PI);
      const over = ((Math.floor(u) + Math.floor(v)) & 1) === 0;
      const weave = over ? su * 0.7 + sv * 0.3 : sv * 0.7 + su * 0.3;

      const wr = wrinkle[i];
      height[i] = 0.5
        + (fold[i] - 0.5) * 0.42
        + (wr - 0.5) * 0.16
        + weave * 0.026
        + (micro[i] - 0.5) * 0.02
        - tears[i] * 0.20;

      // faded olive-grey PVC
      const f = sstep(0.25, 0.85, fadeN[i]);
      let r = lerp(0.196, 0.288, f);
      let g = lerp(0.222, 0.302, f);
      let b = lerp(0.198, 0.268, f);
      const sh = 0.92 + weave * 0.10 + (micro[i] - 0.5) * 0.12;
      r *= sh; g *= sh; b *= sh;

      const dv = clamp01(sstep(0.5, 0.92, dirtN[i]) * 0.7 + run[i] * 0.6);
      r = lerp(r, 0.232, dv * 0.55);
      g = lerp(g, 0.212, dv * 0.55);
      b = lerp(b, 0.176, dv * 0.55);

      r += tears[i] * 0.12; g += tears[i] * 0.12; b += tears[i] * 0.11;

      const i3 = i * 3;
      rgb[i3] = r; rgb[i3 + 1] = g; rgb[i3 + 2] = b;

      // coated fabric: notably glossier than raw canvas, and unevenly so
      // PVC keeps a real gloss where it is still sound (0.26) and chalks to 0.88
      // where the sun has got at it. Coated fabric is never one value.
      let ro = 0.46;
      ro += 0.30 * sstep(0.46, 0.92, roughN[i]);
      ro -= 0.20 * sstep(0.50, 0.92, 1 - roughN[i]);
      ro += 0.28 * sstep(0.42, 0.92, chalkN[i]);
      ro += dv * 0.26;
      ro += (micro[i] - 0.5) * 0.06;
      rough[i] = ro;
      wearF[i] = clamp01(dv * 0.95);
    }
  }

  return finish(W, H, {
    height, rgb, rough, metal: 0, wear: wearF, wearCavity: 0.5,
    normalStrength: 1.0,
    aoRadii: [3, 9, 28],
    aoStrength: 1.05,
    cavityGrime: 0.42,
    edgeWear: 0.08,
    edgeColor: [0.42, 0.43, 0.39],
    roughMin: 0.24,
  });
}

/* ═════════════════════════════ dispatch table ═════════════════════════════ */

const RECIPES = {
  concrete, asphalt, rustMetal, paintedMetal, sandbags, wood, glass,
  fabric, plaster, rubber, corrugatedMetal, gravel, brick, tarp,
};

export const RECIPE_NAMES = Object.keys(RECIPES);

export function hasRecipe(name) { return !!RECIPES[name]; }

/**
 * Build the three RGBA map buffers for a material.
 * @returns {{albedo:Uint8Array, normal:Uint8Array, orm:Uint8Array, width:number, height:number}}
 */
export function buildMaterialMaps(name, size, seed) {
  const fn = RECIPES[name];
  if (!fn) throw new Error(`unknown material recipe "${name}"`);
  return fn(size, size, (seed ?? 1) >>> 0);
}
