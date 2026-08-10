/**
 * OPERATION BLACKOUT — "GRACHEVKA YARD".
 *
 * A bombed-out Eastern-European industrial compound at dusk. Three-lane CoD structure:
 *
 *   WEST LANE   a gutted warehouse with a mezzanine, a catwalk and a collapsed
 *               north-west corner that the low sun burns straight through
 *   CENTRE      a long open asphalt yard, 90 m of sightline, chicaned by barriers,
 *               a wrecked lorry and a pipe gantry that frames the far end
 *   EAST LANE   a container stack yard with a steel stair tower up to an overwatch
 *               deck at 5.2 m looking straight down the central lane
 *
 * Cross-paths at z=-26, z=-2 and z=+22 loop the three lanes together.
 *
 * ── SUN GEOMETRY (this drove the whole layout) ────────────────────────────────
 * Config puts the sun at azimuth 118 degrees, elevation 8.7 degrees after the
 * lighting system's trim. That is a world direction of (-0.464, 0.151, 0.873) —
 * up and over the NORTH-WEST. At 8.7 degrees the sun clears an obstacle only if the
 * obstacle is lower than 0.153 x its distance, so *anything* standing on the
 * north-west perimeter hides it. The perimeter is therefore deliberately asymmetric:
 * tall unbroken blocks south, east and north-east; collapsed to 3 m rubble along the
 * whole north-west wedge. That gap is the light source for every hero shot in the map,
 * and the reason the warehouse's north-west corner is missing.
 *
 * OWNER: level.
 */
import {
  GeoBuf, Rng, chamferBox, chamferCylinder, iBeam, fbm3, mat,
} from './geo.js';
import {
  weather, weatherConcrete, geoContainer, geoJerseyBarrier, geoSandbag, geoSandPile,
  geoPebble, geoLitter, geoDrum,
  geoPallet, geoTyre, geoCrate, geoRubble, geoSpool, geoStairs, geoRailing,
  geoCatwalk, geoCorrugatedPanel, buildTruckWreck, mergeBufInto,
} from './kit.js';

const D2R = Math.PI / 180;

/**
 * Per-prop texel density, in texture repeats per metre.
 *
 * This is the table the level was missing. `Builder.add()` falls back to the
 * material's own `metersPerTile`, which is authored for the size of prop the
 * material library had in mind — 3.2 m for concrete, 1.6 m for rust. Wrapping
 * that around a 0.92 m jersey barrier gives you less than half a tile across the
 * whole face, so the recipe's 5 cm aggregate arrives as 12 cm cornflakes and the
 * barrier reads as lava rock. Every value here is derived from the prop's real
 * dimensions and the feature size the material should show ON that prop.
 */
export const PROP_UV = {
  /**
   * A jersey barrier is 0.92 m tall. The library's 3.2 m concrete tile puts less
   * than a third of a tile across that face, so the recipe's 5 cm aggregate arrives
   * as 15 cm cornflakes — the "lump of lava rock" read. But this recipe also carries
   * distinctive spall and stain blooms, and pushing past about 3 repeats/m makes
   * THOSE tile visibly, which is an instant fail on its own. 2.6 is the measured
   * ceiling: a 0.38 m tile, ~6 mm aggregate, 6.4 repeats along a 2.44 m unit and
   * 2.4 across its height. Verified on screen at native resolution — the regular
   * dark grid that shows on these barriers in the closeup frame is the CHAIN-LINK
   * FENCE SHADOW falling on them from the run at x=-12.6, not a texture repeat.
   * The remaining gap to a true 3 mm aggregate is a limit of the recipe, not of
   * the UVs: past ~3 repeats/m the recipe's worley pitting does start to tile.
   */
  barrier: 2.6,
  /**
   * Sandbags deliberately have NO entry: the material library now ships this recipe
   * at a 0.38 m tile with 30 hessian threads across it (12.5 mm knots), which is
   * already correct for a 0.5 m bag. Overriding it here pushed the weave into a
   * basket-weave checker.
   */
  /** structural steel under 0.5 m: rust blooms must be speckles, not boulders */
  steelFine: 2.4,
  /** beams, columns, gantry legs */
  steel: 1.7,
  /** stair treads, catwalk grating, handrails */
  walkway: 2.4,
  /** culverts, plinth copings, footings */
  concreteProp: 2.4,
};

/**
 * Absolute target tile size, in metres, for materials whose library metersPerTile
 * does not match the feature scale the recipe actually draws.
 *
 * Expressed as an absolute tile rather than as a multiplier on purpose: the
 * materials agent is tuning metersPerTile in the same batch as this pass, and a
 * multiplier would silently become wrong the moment they corrected a value. An
 * absolute target lands on the right texel density whatever the library says.
 */
export const TARGET_TILE = {
  /**
   * The brick recipe lays 8 courses x 3 stretchers per tile. A real metric brick is
   * 215 x 65 mm on a 75 mm course, so the tile has to be ~0.62 m. At the library's
   * 2.0 m it was a 250 mm course and a 667 mm stretcher — masonry for giants, and
   * the reason a five-storey wall read as a flat printed panel with no legible
   * masonry scale anywhere in it.
   */
  brick: 0.63,
  /**
   * ── CORRUGATION: TEXTURE PITCH MUST EQUAL GEOMETRY PITCH ───────────────
   *
   * The corrugatedMetal recipe bakes exactly 8 waves into one tile. The tile size
   * therefore *is* the texture's rib pitch divided by 8, and if it disagrees with
   * the geometric rib the two beat and the wall becomes a moire barcode with an
   * envelope somewhere around a metre — which is exactly the "1 m corduroy" all
   * three critics reported on a wall whose real flutes are 240 mm.
   *
   * Warehouse cladding runs a 240 mm box profile: 8 x 0.24 = 1.92 m.
   * Shipping containers run the ISO 290 mm profile: 8 x 0.29 = 2.32 m.
   *
   * They are two names for one recipe and one GPU texture (see MATERIAL_ALIAS in
   * index.js); the only cost of splitting them is one extra uniform block and one
   * extra draw call per bucket.
   */
  corrugatedMetal: 1.92,
  containerSteel: 2.32,
};

/** Geometric corrugation of the warehouse cladding. See TARGET_TILE above. */
export const CLAD_RIB = { period: 0.24, depth: 0.024, web: 0.15 };
/** Geometric corrugation of a shipping container shell (ISO box profile). */
export const BOX_RIB = { period: 0.29, depth: 0.018, web: 0.16 };

/* ────────────────────────────── layout constants ──────────────────────── */

export const LAYOUT = {
  // playable extents
  minX: -36, maxX: 36, minZ: -46, maxZ: 46,
  // warehouse footprint
  wh: { x0: -34, x1: -13, z0: -20, z1: 6, eaves: 11.4, ridge: 15.4 },
  mezzY: 4.8,
  catwalkY: 8.4,
};

/**
 * Collision for a flight of stairs, built so the AI can actually use it.
 *
 * The nav grid samples one height per 1.0 m cell and refuses to step between
 * neighbours more than 0.55 m apart, so a flight is only a *connection* if
 *   (a) its pitch is under 0.55 m of rise per metre of run, and
 *   (b) there is a cell at each end sitting flush with the platform it meets.
 * Measured on this map, 34-degree stairs failed (a) and even a 1:2 flight failed (b)
 * because the first sampled cell was already 0.6 m up the slope. This emits the ramp
 * *plus* a short flat lip at both ends, which pins (b) regardless of grid phase.
 *
 * Runs along Z. Rising toward +Z if yHi > yLo and zHi > zLo.
 */
function rampProxy(L, x, zLo, zHi, yLo, yHi, width, material = 'paintedMetal') {
  const dz = zHi - zLo, dy = yHi - yLo;
  const len = Math.hypot(dz, dy);
  const rx = -Math.atan2(dy, dz);
  L.addProxy(x, (yLo + yHi) * 0.5 - 0.1, (zLo + zHi) * 0.5, width, 0.4, len + 0.3, 0, material, { rx });
  const dir = Math.sign(dz) || 1;
  L.addProxy(x, yLo - 0.1, zLo - dir * 0.7, width, 0.22, 1.4, 0, material);
  L.addProxy(x, yHi - 0.1, zHi + dir * 0.7, width, 0.22, 1.4, 0, material);
}

/* ═══════════════════════════════════════════════════════════════════════ */

export function buildMap(ctx, L) {
  const rng = new Rng(0xB1A0C0);
  const B = L.builder;

  terrain(B, L, rng);
  pavement(B, L, rng);
  warehouse(B, L, rng);
  containerYard(B, L, rng);
  centralLane(B, L, rng);
  gantry(B, L, rng);
  midground(B, L, rng);
  perimeter(B, L, rng);
  backdrop(B, L, rng);
  scatter(B, L, rng);
  fences(B, L, rng);
  spawns(L);
}

/* ─────────────────────────────── terrain ──────────────────────────────── */

function terrain(B, L, rng) {
  // Non-uniform grid: 2 m cells across the play area, expanding out to a 340 m
  // skirt so the horizon never shows an edge.
  const xs = [], zs = [];
  const push = (arr, v) => { if (!arr.length || v - arr[arr.length - 1] > 1e-3) arr.push(v); };
  for (const v of [-340, -220, -150, -105, -78, -60]) push(xs, v);
  for (let x = -52; x <= 52; x += 2.6) push(xs, x);
  for (const v of [60, 78, 105, 150, 220, 340]) push(xs, v);
  for (const v of [-340, -220, -150, -105, -80, -66]) push(zs, v);
  for (let z = -60; z <= 60; z += 2.6) push(zs, z);
  for (const v of [66, 80, 105, 150, 220, 340]) push(zs, v);

  const H = (x, z) => {
    const r = Math.max(Math.abs(x) / 52, Math.abs(z) / 60);
    if (r < 1) return (fbm3(x * 0.06, 0, z * 0.06, 2) - 0.5) * 0.06;
    const t = Math.min(1, (r - 1) * 0.5);
    return (fbm3(x * 0.06, 0, z * 0.06, 2) - 0.5) * 0.06
      + t * ((fbm3(x * 0.012 + 40, 0, z * 0.012, 3) - 0.45) * 9.0);
  };

  /**
   * Analytic heightfield normal.
   *
   * The winding here is not cosmetic. The original loop emitted
   * `tri(a, b, c, null)` with a = (x0,z0), b = (x1,z0), c = (x1,z1), whose cross
   * product points at NEGATIVE Y — so the entire 5 900-triangle ground plane,
   * including the 340 m horizon skirt, was built inside out and back-face culled.
   * The compound only looked floored because the paving slab on top of it is
   * built with explicit +Y normals; everywhere the paving stopped you were
   * looking through a hole in the world at the sky dome, and every distant hill
   * that was supposed to sit under the backdrop blocks simply did not render.
   *
   * Vertices are ordered (x0,z0) -> (x0,z1) -> (x1,z1) -> (x1,z0), which winds
   * counter-clockwise seen from above, and normals are sampled per vertex so the
   * skirt reads as rolling ground rather than a field of flat lozenges.
   */
  const EPS = 0.65;
  const N = (x, z) => {
    const dhx = (H(x + EPS, z) - H(x - EPS, z)) / (2 * EPS);
    const dhz = (H(x, z + EPS) - H(x, z - EPS)) / (2 * EPS);
    const l = Math.hypot(dhx, 1, dhz) || 1;
    return [-dhx / l, 1 / l, -dhz / l];
  };

  const buf = new GeoBuf();
  const colCache = new Map();
  const sample = (i, j) => {
    const key = i * 4096 + j;
    let s = colCache.get(key);
    if (!s) {
      const x = xs[i], z = zs[j];
      s = { p: [x, H(x, z), z], n: N(x, z) };
      colCache.set(key, s);
    }
    return s;
  };

  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const s00 = sample(i, j), s01 = sample(i, j + 1);
      const s11 = sample(i + 1, j + 1), s10 = sample(i + 1, j);
      buf.triN(s00.p, s01.p, s11.p, s00.n, s01.n, s11.n);
      buf.triN(s00.p, s11.p, s10.p, s00.n, s11.n, s10.n);
    }
  }
  colCache.clear();
  const geo = buf.toGeometry();
  // UV straight from world XZ (the accumulator already wrote boxUV = [x,z] for up faces)
  B.add('groundGravel', geo, {
    bucket: 'terrain', shadow: false,
    paint: (x, y, z, nx, ny, nz, out) => {
      const p = fbm3(x * 0.055, 0, z * 0.055, 4);
      let k = 1.24 + p * 0.38;
      // damp mud / oil pooling in the yard
      const w = fbm3(x * 0.19 + 30, 0, z * 0.19, 3);
      if (w > 0.62) k *= 1 - (w - 0.62) * 1.1;
      // dust lifts toward the horizon so the distant skirt reads lighter
      const r = Math.hypot(x, z);
      if (r > 60) k *= 1 + Math.min(0.35, (r - 60) * 0.0016);
      out[0] = k * 1.02; out[1] = k * 0.98; out[2] = k * 0.90;
    },
  });

  /**
   * Ground collider — deliberately only a little larger than the compound.
   *
   * The AI sizes its nav grid from the bounding box of `collidables`; a 260 m slab
   * pushed that to 144x144 cells, most of them outside the perimeter wall where nothing
   * can ever stand. The bound walls in perimeter() keep anything from walking off this.
   */
  L.addProxy(0, -1.0, 0, 108, 2.0, 122, 0, 'gravel');
}

/* ─────────────────────────────── pavement ─────────────────────────────── */

/** Broken asphalt yard with ragged edges and a chamfered kerb down to the dirt. */
function pavement(B, L, rng) {
  const T = 0.055;
  const cell = 2.0;
  const x0 = -38, x1 = 38, z0 = -50, z1 = 50;
  const nx = Math.round((x1 - x0) / cell);
  const nz = Math.round((z1 - z0) / cell);

  const paved = (cx, cz) => {
    if (cx < -12.4) return false;                              // warehouse side is concrete
    const n = (fbm3(cx * 0.11, 0, cz * 0.11, 3) - 0.5) * 3.6;
    if (Math.abs(cx) < 11.5 + n && cz > -44 && cz < 44) return true;
    if (Math.abs(cz + 26) < 4.6 + n * 0.5 && cx > -12 && cx < 34) return true;
    if (Math.abs(cz + 2) < 5.2 + n * 0.5 && cx > -12 && cx < 34) return true;
    if (Math.abs(cz - 22) < 4.4 + n * 0.5 && cx > -12 && cx < 34) return true;
    if (cx > 13.5 + n * 0.6 && cx < 34 - n * 0.6 && cz > -34 && cz < 30) return true;
    return false;
  };

  const grid = [];
  for (let i = 0; i < nx; i++) {
    grid[i] = [];
    for (let j = 0; j < nz; j++) {
      grid[i][j] = paved(x0 + (i + 0.5) * cell, z0 + (j + 0.5) * cell);
    }
  }

  /**
   * ── JITTERED GRID NODES ────────────────────────────────────────────────
   *
   * The paving was emitted on a perfect 2 m lattice, so wherever it stopped it
   * stopped on a dead-straight, world-axis-aligned line with a 55 mm vertical
   * cliff behind it. The critics read that — correctly — as a gravel "tray"
   * dropped onto the slab, a decal quad rather than a bed.
   *
   * Displacing the NODES rather than the cells keeps the mesh watertight (every
   * cell that shares a node shares its displacement) while turning every
   * boundary into a broken line. 0.62 m of jitter on a 2 m cell is the most that
   * can be applied before a quad can go non-convex.
   */
  const NX = [], NZ = [];
  for (let i = 0; i <= nx; i++) {
    NX[i] = []; NZ[i] = [];
    for (let j = 0; j <= nz; j++) {
      const wx = x0 + i * cell, wz = z0 + j * cell;
      const a = fbm3(wx * 0.37 + 11.5, 0, wz * 0.37, 2) - 0.5;
      const b = fbm3(wx * 0.41 - 7.25, 0, wz * 0.41 + 3.5, 2) - 0.5;
      NX[i][j] = wx + a * 2.4;
      NZ[i][j] = wz + b * 2.4;
    }
  }
  /** Flat bilinear patch through four arbitrary corners at a constant height. */
  const patch = (buf, i, j, h, nu, nv) => {
    const P = (s, t) => {
      const ax2 = NX[i][j] + (NX[i + 1][j] - NX[i][j]) * s;
      const az2 = NZ[i][j] + (NZ[i + 1][j] - NZ[i][j]) * s;
      const bx2 = NX[i][j + 1] + (NX[i + 1][j + 1] - NX[i][j + 1]) * s;
      const bz2 = NZ[i][j + 1] + (NZ[i + 1][j + 1] - NZ[i][j + 1]) * s;
      return [ax2 + (bx2 - ax2) * t, h, az2 + (bz2 - az2) * t];
    };
    const up = [0, 1, 0];
    for (let a = 0; a < nu; a++) {
      for (let b = 0; b < nv; b++) {
        const s0 = a / nu, s1 = (a + 1) / nu, t0 = b / nv, t1 = (b + 1) / nv;
        const p00 = P(s0, t0), p10 = P(s1, t0), p11 = P(s1, t1), p01 = P(s0, t1);
        buf.triN(p00, p01, p11, up, up, up);
        buf.triN(p00, p11, p10, up, up, up);
      }
    }
  };
  /** Every open edge of the paving, for pebble spill and the mask feather. */
  const edges = [];

  /**
   * Two paving materials, laid as one cell grid.
   *
   * The yard is CONCRETE, not asphalt, and that is a lighting decision as much as an
   * art-direction one. Asphalt's authored albedo is ~0.02 linear; with an 8.7 degree sun
   * this map is largely in the warehouse's 80 m cast shadow, and asphalt in that shadow
   * resolves to (2,2,3) sRGB — a black hole across the bottom half of every frame, and
   * an instant fail on the "no crushed blacks" rule. Concrete at ~0.20 linear keeps the
   * shadowed ground at a readable cool grey while the shadow shape itself survives.
   * A narrow asphalt haul road down the lane keeps the tonal contrast.
   */
  const isRoad = (cx, cz) => {
    const n = (fbm3(cx * 0.13 + 70, 0, cz * 0.13, 3) - 0.5) * 2.4;
    if (Math.abs(cx) < 4.2 + n && cz > -42 && cz < 42) return true;
    if (Math.abs(cz + 26) < 2.6 + n * 0.4 && cx > -11 && cx < 30) return true;
    if (Math.abs(cz - 22) < 2.4 + n * 0.4 && cx > -11 && cx < 30) return true;
    return false;
  };

  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= nz) ? false : grid[i][j];
  const slabBuf = new GeoBuf();
  const roadBuf = new GeoBuf();
  const TR = T - 0.018;                            // the road sits worn-in below the slab
  const skirt = (buf, i0, j0, i1, j1, h, nrm) => {
    const a = [NX[i0][j0], h, NZ[i0][j0]];
    const b = [NX[i1][j1], h, NZ[i1][j1]];
    buf.quad(a, b, [a[0], 0, a[2]], nrm);
    edges.push([(a[0] + b[0]) * 0.5, (a[2] + b[2]) * 0.5]);
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      if (!grid[i][j]) continue;
      const road = isRoad(x0 + (i + 0.5) * cell, z0 + (j + 0.5) * cell);
      const buf = road ? roadBuf : slabBuf;
      const h = road ? TR : T;
      patch(buf, i, j, h, 2, 2);
      // kerb skirts wherever the paving stops
      if (!at(i - 1, j)) skirt(buf, i, j, i, j + 1, h, [-1, 0, 0]);
      if (!at(i + 1, j)) skirt(buf, i + 1, j, i + 1, j + 1, h, [1, 0, 0]);
      if (!at(i, j - 1)) skirt(buf, i, j, i + 1, j, h, [0, 0, -1]);
      if (!at(i, j + 1)) skirt(buf, i, j + 1, i + 1, j + 1, h, [0, 0, 1]);
    }
  }

  B.add('groundConcrete', slabBuf.toGeometry(), {
    bucket: 'terrain', shadow: false,
    paint: (x, y, z, nx2, ny, nz2, out) => {
      // The warehouse puts the whole south half of the yard in shade all evening;
      // 1.20 left that ground resolving into crush. 1.34 lifts the shadowed slab
      // to a readable cool grey without blowing the sunlit strips.
      let k = 1.40 + fbm3(x * 0.09 + 12, 0, z * 0.09, 4) * 0.26;
      // saw-cut control joints on a 4 m grid
      const jx = Math.abs(((x + 200) % 4) - 2), jz = Math.abs(((z + 200) % 4) - 2);
      if (jx > 1.94 || jz > 1.94) k *= 0.62;
      const c = Math.abs(fbm3(x * 0.42, 0, z * 0.42, 2) - 0.5);
      if (c < 0.035) k *= 0.68;
      const o = fbm3(x * 0.24 - 40, 0, z * 0.24, 3);
      if (o > 0.68) k *= 1 - (o - 0.68) * 1.25;          // oil / diesel staining
      if (ny < 0.5) k *= 0.72;                            // broken kerb edge, dirt-creep
      // the palette leans cool everywhere except the practicals; a neutral slab
      // multiplied by a warm dusk key was resolving as beach sand
      out[0] = k * 0.965; out[1] = k * 0.985; out[2] = k * 1.005;
    },
  });

  B.add('groundAsphalt', roadBuf.toGeometry(), {
    bucket: 'terrain', shadow: false,
    paint: (x, y, z, nx2, ny, nz2, out) => {
      // asphalt's own albedo is near-black, so this multiplier runs well over 1
      let k = 3.55 + fbm3(x * 0.09 + 12, 0, z * 0.09, 4) * 0.85;
      const c = Math.abs(fbm3(x * 0.46, 0, z * 0.46, 2) - 0.5);
      if (c < 0.035) k *= 0.7;                            // cracks
      const o = fbm3(x * 0.24 - 40, 0, z * 0.24, 3);
      if (o > 0.68) k *= 1 - (o - 0.68) * 1.3;
      k *= 1 + 0.18 * Math.exp(-((x / 5) ** 2));          // polished wheel track
      if (ny < 0.5) k *= 0.72;
      out[0] = k * 1.0; out[1] = k * 1.0; out[2] = k * 1.02;
    },
  });

  /**
   * ── THE SLAB-TO-DIRT TRANSITION ────────────────────────────────────────
   *
   * A broken node grid stops the boundary being a drawn line, but a real kerb
   * edge is not just wavy — material crosses it. Two more things do that:
   *
   *  1. A DUST FEATHER baked into the ground mask along every open edge. The
   *     mask's R channel drives the second (loose dirt / gravel) ground layer in
   *     the fragment shader, so a 0.5 m band of it height-blends grains up over
   *     the slab lip instead of cross-fading a colour.
   *  2. ACTUAL STONES sitting ON the slab. 3-5 per open edge, which across the
   *     whole yard is ~900 pebbles in one instanced draw call.
   */
  const spill = [];
  for (const [ex, ez] of edges) {
    L.markDust(ex, ez, 0.95, 0.62);
    if (!rng.chance(0.42)) continue;
    for (let k = 0; k < 2; k++) {
      const a = rng.range(0, 6.28);
      const rr = rng.range(0.05, 1.05);
      spill.push({
        x: ex + Math.cos(a) * rr, y: T - 0.004, z: ez + Math.sin(a) * rr,
        ry: rng.range(0, 6.28), rx: rng.j(0.7), rz: rng.j(0.7),
        scale: rng.range(0.8, 2.0),
        tint: [rng.range(0.7, 1.12), rng.range(0.68, 1.06), rng.range(0.64, 0.98)],
      });
    }
  }
  /**
   * Handed to `scatter()` rather than instanced here: one InstancedMesh that
   * spans the whole yard costs ten draw calls a frame across all the passes, and
   * the boundary spill and the midground scatter are the same stone in the same
   * material — there is no reason to pay for it twice.
   */
  L.pebbleSpill = spill;

  /**
   * ── APRON SLABS ────────────────────────────────────────────────────────
   *
   * These used to be `chamferBox` volumes, which means their edges were
   * dead-straight lines parallel to the world axes. The critics measured exactly
   * that in two separate frames: "a gravel band abruptly replaces smooth concrete
   * along a straight seam", "a lighter ground patch ends on a dead-straight
   * axis-aligned edge — these read as texture-atlas rectangles, which is what
   * they are."
   *
   * A real slab edge is a broken casting line with grit drifted over it, so the
   * apron is now a jittered node grid exactly like the paving: the boundary nodes
   * are displaced by a 2-octave noise field AND pushed outward by 0.3-1.1 m, so
   * no two metres of the perimeter run parallel to anything. On top of that goes
   * a wide dust feather into the ground mask, which drives the shader's
   * height-blended second layer — grains sit PROUD of the slab lip over a ~1.2 m
   * band rather than the two materials cross-fading on a drawn line.
   */
  const slab = (cx, cz, w, d, y = 0.07) => {
    const cellA = 1.9;
    const ni = Math.max(2, Math.round(w / cellA));
    const nj = Math.max(2, Math.round(d / cellA));
    const ax0 = cx - w * 0.5, az0 = cz - d * 0.5;
    const cw = w / ni, cd = d / nj;
    const AX = [], AZ = [];
    for (let i = 0; i <= ni; i++) {
      AX[i] = []; AZ[i] = [];
      for (let j = 0; j <= nj; j++) {
        const wx = ax0 + i * cw, wz = az0 + j * cd;
        const a = fbm3(wx * 0.43 + 3.1, 0, wz * 0.43, 2) - 0.5;
        const b = fbm3(wx * 0.39 - 5.7, 0, wz * 0.39 + 8.2, 2) - 0.5;
        let px = wx + a * Math.min(1.5, cw * 0.85);
        let pz = wz + b * Math.min(1.5, cd * 0.85);
        // boundary nodes are pushed OUTWARD as well as sideways: the slab may
        // never shrink inside its nominal rect (the shed walls stand on it), but
        // it is free to spill past it, which is what a broken casting line does.
        const e = 0.30 + Math.abs(fbm3(wx * 0.71 + 17, 0, wz * 0.71, 2) - 0.5) * 1.6;
        if (i === 0) px = Math.min(px, ax0 - e * 0.5);
        if (i === ni) px = Math.max(px, ax0 + w + e * 0.5);
        if (j === 0) pz = Math.min(pz, az0 - e * 0.5);
        if (j === nj) pz = Math.max(pz, az0 + d + e * 0.5);
        AX[i][j] = px; AZ[i][j] = pz;
      }
    }
    const sb = new GeoBuf();
    const up = [0, 1, 0];
    const Pn = (i, j) => [AX[i][j], y, AZ[i][j]];
    for (let i = 0; i < ni; i++) {
      for (let j = 0; j < nj; j++) {
        const p00 = Pn(i, j), p10 = Pn(i + 1, j), p11 = Pn(i + 1, j + 1), p01 = Pn(i, j + 1);
        sb.triN(p00, p01, p11, up, up, up);
        sb.triN(p00, p11, p10, up, up, up);
      }
    }
    // kerb skirt around the ragged perimeter
    const skirtQ = (a2, b2, nrm) => {
      sb.quad(a2, b2, [a2[0], -0.30, a2[2]], nrm);
    };
    for (let i = 0; i < ni; i++) {
      skirtQ(Pn(i, 0), Pn(i + 1, 0), [0, 0, -1]);
      skirtQ(Pn(i, nj), Pn(i + 1, nj), [0, 0, 1]);
    }
    for (let j = 0; j < nj; j++) {
      skirtQ(Pn(0, j), Pn(0, j + 1), [-1, 0, 0]);
      skirtQ(Pn(ni, j), Pn(ni, j + 1), [1, 0, 0]);
    }
    B.add('groundConcrete', sb.toGeometry(), {
      bucket: 'terrain', shadow: false,
      paint: (x, yy, z, nx2, ny, nz2, out) => {
        let k = 1.14 + fbm3(x * 0.10 + 5, 0, z * 0.10, 4) * 0.24;
        // expansion joints on a 4 m grid
        const jx = Math.abs(((x + 200) % 4) - 2), jz = Math.abs(((z + 200) % 4) - 2);
        if (jx > 1.955 || jz > 1.955) k *= 0.60;
        const c = Math.abs(fbm3(x * 0.5, 0, z * 0.5, 2) - 0.5);
        if (c < 0.03) k *= 0.66;
        const o = fbm3(x * 0.3 - 9, 0, z * 0.3, 3);
        if (o > 0.68) k *= 1 - (o - 0.68) * 1.3;
        if (ny < 0.5) k *= 0.7;
        out[0] = k * 0.965; out[1] = k * 0.985; out[2] = k * 1.005;
      },
    });
  };
  slab(-23.5, -7, 22.6, 27.6);       // warehouse floor
  slab(-8.5, -7, 8.0, 26.0);         // loading apron east of the warehouse
  slab(-24, 10.5, 20.0, 8.0);        // north apron

  /**
   * ── APRON EDGES ────────────────────────────────────────────────────────
   *
   * The aprons are chamfered boxes, so unlike the jittered paving grid their
   * edges are dead-straight lines parallel to the world axes — and the critics
   * photographed exactly that: a gravel strip between two razor edges reading as
   * "a raised rectangular tray dropped onto the concrete". The paving side of
   * that strip is now broken by the node jitter; this breaks the apron side, with
   * the same three tools: a dust feather into the ground mask, loose stones
   * lying ON the slab, and broken concrete along the lip.
   */
  const apronEdge = (cx, cz, w, d) => {
    const hw = w * 0.5, hd = d * 0.5;
    const perim = (w + d) * 2;
    const n = Math.round(perim / 0.45);
    for (let i = 0; i < n; i++) {
      const t = (i / n) * perim;
      let ex, ez, ox = 0, oz = 0;
      if (t < w) { ex = cx - hw + t; ez = cz - hd; oz = -1; }
      else if (t < w + d) { ex = cx + hw; ez = cz - hd + (t - w); ox = 1; }
      else if (t < w * 2 + d) { ex = cx + hw - (t - w - d); ez = cz + hd; oz = 1; }
      else { ex = cx - hw; ez = cz + hd - (t - w * 2 - d); ox = -1; }
      if (Math.abs(ex) > 37 || Math.abs(ez) > 46) continue;
      /**
       * Two overlapping deposits at different radii, straddling the lip. The
       * mask's R channel drives the height-blended dirt layer in the ground
       * shader, so a ~1.4 m band of it is what turns the seam into a gradual,
       * grain-by-grain interpenetration instead of a crossfade on a line. The
       * outer deposit is offset OUTWARD, so the drift is asymmetric the way
       * wind-blown grit actually is.
       */
      L.markDust(ex, ez, 1.15, 0.62);
      L.markDust(ex + ox * 0.85, ez + oz * 0.85, 1.5, 0.42);
      if (!rng.chance(0.46)) continue;
      const a = rng.range(0, 6.28), rr = rng.range(0.06, 1.35);
      spill.push({
        x: ex + Math.cos(a) * rr, y: 0.066, z: ez + Math.sin(a) * rr,
        ry: rng.range(0, 6.28), rx: rng.j(0.7), rz: rng.j(0.7),
        scale: rng.range(0.8, 2.1),
        tint: [rng.range(0.7, 1.12), rng.range(0.68, 1.06), rng.range(0.64, 0.98)],
      });
    }
  };
  apronEdge(-23.5, -7, 22.6, 27.6);
  apronEdge(-8.5, -7, 8.0, 26.0);
  apronEdge(-24, 10.5, 20.0, 8.0);
}

/* ─────────────────────────────── warehouse ────────────────────────────── */

function warehouse(B, L, rng) {
  const W = LAYOUT.wh;
  const cx = (W.x0 + W.x1) * 0.5;      // -23.5
  const cz = (W.z0 + W.z1) * 0.5;      // -7
  const wide = W.x1 - W.x0;            // 21
  const deep = W.z1 - W.z0;            // 26
  const eaves = W.eaves;
  const ridge = W.ridge;
  const bucket = 'warehouse';

  const conc = (o = {}) => ({
    bucket, paint: weatherConcrete({
      base: [o.b ?? 0.98, o.b ?? 0.96, (o.b ?? 0.94) * 0.97],
      offset: [o.ox ?? 0, 0, o.oz ?? 0], grimeHeight: o.gh ?? 1.4, dirt: o.d ?? 0.5,
    }),
  });
  /**
   * `streakFreq` 0.55 (a 1.8 m run) rather than the 1.55 default. See weather()
   * in kit.js: at 1.55 the rain-wash runs are ~0.65 m apart, which on a 240 mm
   * corrugation acts as a second, coarser corrugation and is what made the shed
   * read as hanging canvas. Strength drops with it — the ribs are supposed to be
   * the dominant surface event, not the grime.
   */
  const clad = (o = {}) => {
    const w = weather({
      base: o.base || [1.02, 1.05, 1.02], rust: [1.02, 0.54, 0.28],
      rustAmount: o.rust ?? 0.62, scale: o.scale ?? 0.85,
      offset: [o.ox ?? 0, 0, o.oz ?? 0], grimeHeight: 2.6, dirt: 0.5,
      streaks: 0.55, streakFreq: 0.55,
    });
    return { bucket, paint: w };
  };
  /**
   * Walkways get their own texel density. paintedMetal's natural 1.8 m tile puts
   * the recipe's paint blotches and chip clusters at roughly one feature per
   * catwalk width, which on a 1.5 m deck read as a gravel path rather than steel
   * grating — the mezzanine and catwalk looked like a rubble ridge. 1.7 repeats
   * per metre drops the feature size to ~15 cm, which is chequer-plate scale.
   */
  const walk = (o = {}) => ({
    bucket, uvScale: PROP_UV.walkway, paint: weather({
      base: o.base || [0.86, 0.92, 0.84], rust: [1.00, 0.68, 0.46],
      rustAmount: o.rust ?? 0.30, scale: 0.9, offset: [o.ox ?? 0, 0, o.oz ?? 0],
      grimeHeight: 1.2, dirt: 0.40, streaks: 0.55,
    }),
  });
  const steel = (o = {}) => ({
    bucket, uvScale: o.uv ?? PROP_UV.steel, paint: weather({
      base: o.base || [1.02, 1.02, 1.00], rust: [1.00, 0.74, 0.56],
      rustAmount: o.rust ?? 0.26, scale: 0.75, offset: [o.ox ?? 0, 0, o.oz ?? 0],
      grimeHeight: 1.6, dirt: 0.42, streaks: 0.45,
    }),
  });

  /* ── concrete plinth, 2.8 m, broken into segments around the openings ── */
  const PL = 2.8, PT = 0.42;
  /**
   * A plinth run is a 2.8 m blank concrete wall, and blank is the problem: in the
   * material-scrutiny framing the north plinth was the single brightest, flattest
   * object on screen and read as a white card leant against the shed. Three cheap
   * additions fix it — a proud coping band and a base kick, which are what a real
   * precast plinth has and which both self-shadow, and a spall/rubble skirt so it
   * meets the ground on a broken line rather than a drawn one.
   */
  const plinth = (x, z, w, d, h = PL) => {
    /**
     * 0.085, not 0.05. The critics measured this exact object: "a razor-sharp
     * box — its vertical corner is a perfectly straight, perfectly clean 90
     * degree arris running the full 3 m with no chip, no spall, no highlight."
     * At an 8.7 degree sun an 85 mm chamfer is ~1.5 pixels of bright hairline at
     * 12 m, which is the strongest "this is solid" cue available and costs
     * nothing — the chamfer geometry already exists, it was just too small to
     * resolve.
     */
    B.add('concrete', chamferBox(w, h, d, 0.085, { center: [x, h * 0.5, z], seg: [Math.max(1, Math.round(w / 3)), 2] }),
      conc({ ox: x, oz: z, b: 0.84 }));
    /**
     * Knocked-out corner chunks. A precast plinth that has been hit by a forklift
     * for fifteen years loses its arrises in bites, and the exposed aggregate
     * underneath is darker and coarser than the struck face. Modelled as small
     * chamfered wedges sitting IN the corner: they break the vertical line
     * without needing a CSG cut.
     */
    for (let i = 0, nSp = 3; i < nSp; i++) {
      const sx2 = rng.sign(), sz2 = rng.sign();
      const sy = rng.range(0.12, 0.92) * h;
      const sw = rng.range(0.10, 0.26);
      B.add('concrete', geoRubble(rng, rng.range(0.35, 0.62)), {
        matrix: mat(x + sx2 * (w * 0.5 - sw * 0.35), sy, z + sz2 * (d * 0.5 - sw * 0.35),
          rng.range(0, 6.28), { rx: rng.j(0.6), rz: rng.j(0.6) }),
        bucket, uvScale: PROP_UV.concreteProp,
      });
    }
    // coping and kick, both proud of the face by 6 cm
    B.add('concrete', chamferBox(w + 0.10, 0.17, d + 0.12, 0.028, { center: [x, h - 0.085, z] }), { ...conc({ ox: x + 4, oz: z, b: 0.90 }), uvScale: PROP_UV.concreteProp });
    B.add('concrete', chamferBox(w + 0.14, 0.30, d + 0.16, 0.035, { center: [x, 0.15, z] }), { ...conc({ ox: x + 8, oz: z, b: 0.74, gh: 0.5, d: 0.7 }), uvScale: PROP_UV.concreteProp });
    L.addProxy(x, h * 0.5, z, w, h, d, 0, 'concrete');
    // spall skirt along the longer axis
    const along = Math.max(w, d);
    const side = w > d ? [0, 1] : [1, 0];
    for (let i = 0, n = Math.max(2, Math.round(along * 0.75)); i < n; i++) {
      const t = (rng.f() - 0.5) * along * 0.94;
      const off = rng.sign() * (Math.min(w, d) * 0.5 + rng.range(0.05, 0.55));
      B.add('concrete', geoRubble(rng, rng.range(0.5, 1.15)), {
        matrix: mat(x + side[0] * t + side[1] * off, rng.range(-0.06, 0.10), z + side[1] * t + side[0] * off,
          rng.range(0, 6.28), { rx: rng.j(0.35), rz: rng.j(0.35) }),
        bucket,
      });
    }
  };

  // south wall (z0) — 8 m roller-door gap in the middle
  plinth(W.x0 + 3.2, W.z0, 6.4 + PT, PT);
  plinth(W.x1 - 3.2, W.z0, 6.4 + PT, PT);
  // north wall (z1) — only the eastern third survives, the rest is collapsed
  plinth(W.x1 - 3.0, W.z1, 6.0 + PT, PT);
  // west wall (x0)
  plinth(W.x0, -9.0, PT, 22.0);
  plinth(W.x0, W.z1 - 2.0, PT, 3.0, 1.1);          // stub of the collapsed corner
  // east wall (x1) — a blown-out section from z=-18..-11
  plinth(W.x1, -21.0 + 1.6, PT, 3.2);
  plinth(W.x1, -5.5, PT, 11.0);
  plinth(W.x1, 3.0, PT, 6.0);

  /* ── steel frame ─────────────────────────────────────────────────────── */
  const colZ = [];
  for (let z = W.z0 + 0.6; z <= W.z1 - 0.6; z += 6.35) colZ.push(z);
  for (const z of colZ) {
    for (const x of [W.x0 + 0.55, W.x1 - 0.55]) {
      const collapsed = (x < cx && z > 2.0);
      const h = collapsed ? 3.4 : eaves;
      const g = iBeam(h, 0.42, 0.24);
      g.rotateZ(Math.PI / 2);
      g.translate(x, h * 0.5, z);
      B.add('rustMetal', g, steel({ ox: x, oz: z, rust: collapsed ? 0.95 : 0.5 }));
      L.addProxy(x, h * 0.5, z, 0.3, h, 0.3, 0, 'rustMetal');
    }
    // roof truss
    if (z > 2.0) continue;               // north-west third of the roof is down
    const t = new GeoBuf();
    const half = wide * 0.5;
    const rise = ridge - eaves;
    for (const s of [-1, 1]) {
      const len = Math.hypot(half, rise);
      const g = iBeam(len, 0.34, 0.2);
      g.rotateZ(-s * Math.atan2(rise, half));
      g.translate(cx + s * half * 0.5, eaves + rise * 0.5, z);
      mergeBufInto(t, g);
    }
    chamferBox(wide - 1.0, 0.16, 0.14, 0.02, { buf: t, center: [cx, eaves + 0.1, z] });
    for (const s of [-1, 1]) {
      const g = new GeoBuf();
      chamferBox(0.09, Math.hypot(half * 0.5, rise), 0.09, 0.014, { buf: g });
      const gg = g.toGeometry();
      gg.rotateZ(-s * Math.atan2(half * 0.5, rise) * 0.9);
      gg.translate(cx + s * half * 0.26, eaves + rise * 0.55, z);
      mergeBufInto(t, gg);
    }
    B.add('rustMetal', t.toGeometry(), steel({ ox: z, oz: z, rust: 0.6 }));
  }
  // eaves purlins
  for (const x of [W.x0 + 0.55, W.x1 - 0.55]) {
    B.add('rustMetal', chamferBox(0.24, 0.3, deep, 0.02, { center: [x, eaves + 0.15, cz] }), steel({ ox: x }));
  }

  /* ── corrugated cladding ─────────────────────────────────────────────── */
  /**
   * depth was 0.032 over a 0.30 m period. Seen at the grazing angle you get from
   * anywhere down the lane that is a 10 % slope on every facet, and with an 8.7
   * degree sun the troughs go fully black while the crests take a hot specular:
   * the whole shed read as a stockade of separate planks with daylight between
   * them. 0.021 is still a real box profile and halves the facet contrast.
   */
  const panel = (w, h, m, o) => {
    // `cap` puts a folded barge flashing on the top edge — see geoCorrugatedPanel.
    // Every wall panel gets one: where it meets the roof it is a head flashing,
    // where it ends at the sky it is the difference between a sheet and a plane.
    B.add('corrugatedMetal', geoCorrugatedPanel(w, h, { ...CLAD_RIB, thickness: 0.055, cap: true }), { matrix: m, ...clad(o) });
  };

  // south gable wall
  panel(6.4, eaves - PL, mat(W.x0 + 3.2, PL + (eaves - PL) * 0.5, W.z0 - 0.02, Math.PI), { ox: 5, base: [0.98, 1.02, 0.99] });
  panel(6.4, eaves - PL, mat(W.x1 - 3.2, PL + (eaves - PL) * 0.5, W.z0 - 0.02, Math.PI), { ox: 9, base: [0.95, 1.00, 0.98] });
  panel(8.0, eaves - 6.0, mat(cx, 6.0 + (eaves - 6.0) * 0.5, W.z0 - 0.02, Math.PI), { ox: 13, base: [0.96, 1.00, 0.96] });
  // gable triangle
  {
    const g = new GeoBuf();
    g.tri([W.x0, eaves, W.z0], [W.x1, eaves, W.z0], [cx, ridge, W.z0], [0, 0, -1]);
    B.add('corrugatedMetal', g.toGeometry(), clad({ ox: 21, base: [0.90, 0.95, 0.94] }));
    L.addProxy(cx, (eaves + ridge) * 0.5, W.z0, wide, ridge - eaves, 0.3, 0, 'corrugatedMetal');
  }

  /**
   * West wall — the sun wall. A clerestory band is blown out between 7.4 m and 9.6 m
   * along its whole length. With the sun at 8.7 degrees the beams that come through it
   * rake almost horizontally down the shed instead of pooling on the floor, which is
   * both what actually happens at this solar elevation and the more dramatic read.
   */
  const CLERE_LO = 7.4, CLERE_HI = 9.6;
  for (let z = W.z0; z < 2.0; z += 3.25) {
    const w = Math.min(3.25, 2.0 - z);
    const zc = z + w * 0.5;
    panel(w, CLERE_LO - PL, mat(W.x0 - 0.02, (PL + CLERE_LO) * 0.5, zc, -Math.PI / 2), { ox: z, base: [0.93, 0.98, 0.96] });
    // a couple of surviving panes still in the band
    if (rng.chance(0.34)) {
      panel(w * 0.7, CLERE_HI - CLERE_LO, mat(W.x0 - 0.02, (CLERE_LO + CLERE_HI) * 0.5, zc, -Math.PI / 2), { ox: z + 3, base: [0.88, 0.93, 0.92] });
    }
    panel(w, eaves - CLERE_HI, mat(W.x0 - 0.02, (CLERE_HI + eaves) * 0.5, zc, -Math.PI / 2), { ox: z + 7, base: [0.90, 0.95, 0.94] });
    // mullion between the bays, so the band is framed rather than a raw slot
    B.add('rustMetal', chamferBox(0.14, CLERE_HI - CLERE_LO, 0.16, 0.02, {
      center: [W.x0 - 0.02, (CLERE_LO + CLERE_HI) * 0.5, z],
    }), steel({ ox: z * 3 }));
  }
  // north wall — surviving eastern third only
  panel(6.0, eaves - PL, mat(W.x1 - 3.0, PL + (eaves - PL) * 0.5, W.z1 + 0.02, 0), { ox: 31, base: [0.94, 0.99, 0.97] });
  // east wall
  panel(3.2, eaves - PL, mat(W.x1 + 0.02, PL + (eaves - PL) * 0.5, -19.4, Math.PI / 2), { ox: 41 });
  panel(11.0, eaves - PL, mat(W.x1 + 0.02, PL + (eaves - PL) * 0.5, -5.5, Math.PI / 2), { ox: 45 });
  panel(6.0, 4.2, mat(W.x1 + 0.02, PL + 2.1, 3.0, Math.PI / 2), { ox: 51 });

  /* ── roof: two slopes, holes near the ridge, collapsed NW quadrant ───── */
  const half = wide * 0.5;
  const rise = ridge - eaves;
  const slopeLen = Math.hypot(half, rise);
  const ang = Math.atan2(rise, half);
  const roofBuf = new GeoBuf();
  const holes = [
    { z: -14.0, s: 1, w: 3.6 }, { z: -3.0, s: -1, w: 4.4 }, { z: -9.5, s: -1, w: 2.8 },
  ];
  for (const s of [-1, 1]) {
    let z = W.z0 - 0.4;
    const zEnd = s < 0 ? 2.2 : W.z1 + 0.4;         // west slope stops at the collapse
    while (z < zEnd) {
      const step = 2.2;
      const zc = z + step * 0.5;
      const hole = holes.find((h) => h.s === s && Math.abs(h.z - zc) < h.w * 0.5);
      if (!hole && zc < zEnd) {
        const g = geoCorrugatedPanel(slopeLen, Math.min(step, zEnd - z), { ...CLAD_RIB, thickness: 0.11 });
        g.rotateX(-Math.PI / 2);
        g.rotateZ(s * ang);
        g.translate(cx + s * half * 0.5, eaves + rise * 0.5 + 0.12, zc);
        B.add('corrugatedMetal', g, clad({ ox: zc * 3, oz: s * 7, base: [0.86, 0.90, 0.90], rust: 0.75, scale: 0.6 }));
      }
      z += step;
    }
    /**
     * NO COLLIDER ON THE ROOF — and that is deliberate.
     *
     * The AI builds a 2.5D nav grid by raycasting straight down and keeping one height
     * per cell. A roof collider at 12 m means every cell inside this 21x26 m shed
     * samples the *roof*, so the entire warehouse interior — mezzanine, catwalk, the
     * whole west lane — vanishes from the nav grid and the flood fill confines the
     * squad to whichever side of it the seed landed on (measured: 333 of 20736 cells).
     * The roof only ever needs to stop bullets fired near-vertically from inside, which
     * nothing in the sightline graph does, so the trade is heavily one-sided.
     */
  }
  B.add('rustMetal', chamferBox(0.4, 0.3, deep, 0.04, { center: [cx, ridge + 0.05, cz] }), steel({ ox: 3 }));

  /**
   * Torn cladding still attached at the collapse edge. These MUST hang off real
   * structure — an earlier pass scattered them at random heights and they read as
   * debris floating in the sky, which is the single fastest way to destroy a frame.
   * Each one is pinned to the eaves purlin or the last surviving truss.
   */
  for (let i = 0; i < 6; i++) {
    const ln = rng.range(2.0, 3.8);
    const g = geoCorrugatedPanel(rng.range(1.4, 2.6), ln, { ...CLAD_RIB, thickness: 0.055 });
    // pivot about the panel's top edge so it swings down from the anchor
    g.translate(0, -ln * 0.5, 0);
    const droop = rng.range(0.55, 1.35);
    const anchorZ = 2.2 + rng.range(-0.5, 0.6);
    const anchorX = rng.chance(0.5) ? W.x0 + 0.55 : cx + rng.j(3.0);
    const anchorY = anchorX < cx - 4 ? eaves : eaves + (ridge - eaves) * (1 - Math.abs(anchorX - cx) / (wide * 0.5));
    B.add('corrugatedMetal', g, {
      matrix: mat(anchorX, anchorY - 0.05, anchorZ, rng.j(0.5), { rx: -droop, rz: rng.j(0.35) }),
      ...clad({ ox: i * 11, rust: 0.9, base: [0.82, 0.86, 0.86] }),
    });
  }

  /* ── mezzanine deck ──────────────────────────────────────────────────── */
  const MZ = { x0: -33.6, x1: -16.6, z0: -19.6, z1: -11.0, y: LAYOUT.mezzY };
  {
    const w = MZ.x1 - MZ.x0, d = MZ.z1 - MZ.z0;
    const mx = (MZ.x0 + MZ.x1) * 0.5, mz = (MZ.z0 + MZ.z1) * 0.5;
    B.add('concrete', chamferBox(w, 0.34, d, 0.04, { center: [mx, MZ.y - 0.17, mz], seg: [6, 3] }),
      conc({ ox: 60, gh: 0.3, d: 0.3 }));
    L.addProxy(mx, MZ.y - 0.17, mz, w, 0.34, d, 0, 'concrete');
    // support beams + posts
    for (let x = MZ.x0 + 2.4; x < MZ.x1; x += 4.2) {
      B.add('rustMetal', (() => { const g = iBeam(d, 0.34, 0.2); g.rotateY(Math.PI / 2); g.translate(x, MZ.y - 0.52, mz); return g; })(), steel({ ox: x }));
      B.add('rustMetal', chamferBox(0.22, MZ.y - 0.7, 0.22, 0.02, { center: [x, (MZ.y - 0.7) * 0.5, MZ.z1 - 0.5] }), steel({ ox: x + 2 }));
      L.addProxy(x, (MZ.y - 0.7) * 0.5, MZ.z1 - 0.5, 0.24, MZ.y - 0.7, 0.24, 0, 'rustMetal');
    }
    // railing on the open (north) edge, with a gap where the stair lands
    for (const seg of [[MZ.x0 + 0.2, -20.2], [-17.6, MZ.x1 - 0.1]]) {
      const len = seg[1] - seg[0];
      if (len <= 0.2) continue;
      const g = geoRailing(len, { height: 1.06, spacing: 1.7 });
      g.translate((seg[0] + seg[1]) * 0.5, MZ.y, MZ.z1 - 0.12);
      B.add('paintedMetal', g, walk({ ox: seg[0] }));
    }
    // railing on the east edge
    {
      const g = geoRailing(d - 0.4, { height: 1.06, spacing: 1.7 });
      g.rotateY(Math.PI / 2);
      g.translate(MZ.x1 - 0.12, MZ.y, mz);
      B.add('paintedMetal', g, walk({ ox: 77 }));
    }
  }

  /**
   * ── STAIRS AND THE AI NAV GRID ──────────────────────────────────────────
   * Every flight in this level is pitched at exactly 1:2 (26.6 degrees), and that is
   * not an aesthetic choice. The AI's nav grid samples one height per 1.0 m cell and
   * refuses to flood between neighbours more than 0.55 m apart, so the 34-degree
   * stairs this level shipped with were *invisible* as connections: every elevated
   * position — mezzanine, catwalk, container deck — was an island, and whenever the
   * flood seed landed on one the whole squad was confined to it (measured: 88 of
   * 13404 cells before the squad fell back to accepting everything). 1:2 leaves 0.50 m
   * per cell with 0.05 m of margin and still reads as a real industrial stair.
   */
  const STAIR_SLOPE = 0.4;

  /* ── stair A: floor -> mezzanine (runs -Z at x=-19) ──────────────────── */
  {
    const run = LAYOUT.mezzY / STAIR_SLOPE;              // 12.0 m
    const base = -11.0 + run;                            // z = +1.0
    const g = geoStairs(LAYOUT.mezzY, run, 1.4, { stepRise: 0.19 });
    g.rotateY(Math.PI);                       // run along -Z
    g.translate(-19.0, 0, base);
    B.add('paintedMetal', g, walk({ ox: 91 }));
    rampProxy(L, -19.0, base, -11.0, 0, LAYOUT.mezzY, 1.5, 'paintedMetal');
  }

  /* ── stair B: mezzanine -> catwalk (runs +Z at x=-20) ────────────────── */
  const CW_Z0 = -19.6 + (LAYOUT.catwalkY - LAYOUT.mezzY) / STAIR_SLOPE;   // -10.6
  {
    const rise = LAYOUT.catwalkY - LAYOUT.mezzY;
    const run = rise / STAIR_SLOPE;                       // 9.0 m
    const g = geoStairs(rise, run, 1.3, { stepRise: 0.19 });
    g.translate(-20.0, LAYOUT.mezzY, -19.6);
    B.add('paintedMetal', g, walk({ ox: 97 }));
    rampProxy(L, -20.0, -19.6, CW_Z0, LAYOUT.mezzY, LAYOUT.catwalkY, 1.4, 'paintedMetal');
  }

  /* ── catwalk: x=-20, z=-10.6 .. +5, y=8.4 ────────────────────────────── */
  {
    const len = 5.0 - CW_Z0, cwz = (CW_Z0 + 5.0) * 0.5;
    const g = geoCatwalk(len, 1.5, { railHeight: 1.06 });
    g.rotateY(Math.PI / 2);
    g.translate(-20.0, LAYOUT.catwalkY, cwz);
    B.add('paintedMetal', g, walk({ ox: 103 }));
    L.addProxy(-20.0, LAYOUT.catwalkY - 0.06, cwz, 1.7, 0.14, len, 0, 'paintedMetal');
    // hangers up to the trusses
    for (let z = CW_Z0 + 1; z < 5; z += 4.5) {
      B.add('rustMetal', chamferBox(0.07, eaves - LAYOUT.catwalkY, 0.07, 0.012, { center: [-20.0, (eaves + LAYOUT.catwalkY) * 0.5, z] }), steel({ ox: z }));
    }
  }

  /**
   * ── EAST-WALL DRESSING: THE SPAWN FRAME'S DEAD ZONE ────────────────────
   *
   * The critics measured the right 40 % of the spawn framing as "one continuous
   * near-featureless dark brown mass — no practical light, no readable structure,
   * no silhouette event". That is this wall, seen from inside at 6-10 m.
   *
   * Three things fix a dead mass, and all three are here: a RAKING PRACTICAL so
   * the corrugation resolves as planes instead of as tone, VERTICAL SILHOUETTE
   * (hoist chains hanging clear of the wall, which also break the horizontals of
   * the cladding), and NEAR CLUTTER with real depth — a pallet stack and a
   * leaning bundle of bar — so the eye has something to read scale against.
   */
  /**
   * @param {number} WX   x of the wall face
   * @param {number} sgn  +1 if the interior is at +x of the wall, -1 otherwise
   * @param {number[]} chainZ  z of each hoist chain
   * @param {number} stackZ    z of the pallet stack
   * @param {number} barZ      z of the bar bundle
   * @param {number[]} lampZ   z of the two bulkhead practicals
   */
  const wallDressing = (WX, sgn, chainZ, stackZ, barZ, lampZ) => {
    const EX = WX + sgn * 0.35;
    // hoist chains off the truss line
    for (const [cz, cl] of chainZ) {
      const cb = new GeoBuf();
      const links = Math.max(3, Math.round(cl / 0.16));
      for (let i = 0; i < links; i++) {
        const y = -i * 0.16;
        // alternate link planes, which is what makes a chain read as a chain
        chamferBox(i % 2 ? 0.034 : 0.012, 0.15, i % 2 ? 0.012 : 0.034, 0.004, {
          buf: cb, center: [Math.sin(i * 0.7) * 0.012, y, 0],
        });
      }
      // hook and a loose sling at the bottom
      chamferBox(0.05, 0.22, 0.05, 0.012, { buf: cb, center: [0, -links * 0.16 - 0.12, 0] });
      B.add('rustMetal', cb.toGeometry(), {
        matrix: mat(EX + sgn * 0.55, eaves - 0.7, cz, rng.range(0, 3.14), { rz: rng.j(0.05) }),
        ...steel({ ox: cz * 5, rust: 0.8 }),
      });
    }
    // pallet stack — a metre and a half of readable vertical silhouette
    for (let i = 0; i < 7; i++) {
      B.add('wood', geoPallet(rng), {
        matrix: mat(EX + sgn * 0.80 + rng.j(0.06), i * 0.145, stackZ + rng.j(0.07), rng.j(0.10)),
        bucket, uvScale: 2.6,
      });
    }
    L.addProxy(EX + sgn * 0.80, 0.52, stackZ, 1.4, 1.05, 1.0, 0, 'wood');
    L.markContact(EX + sgn * 0.80, stackZ, 0.75, 0.6, 0, 0.5, 0.6);
    // a bundle of reinforcing bar leaning on the wall
    for (let i = 0; i < 9; i++) {
      B.add('rustMetal', chamferBox(0.022, 3.4, 0.022, 0.005, { center: [0, 1.7, 0] }), {
        matrix: mat(EX + sgn * 0.07 + rng.j(0.10), 0, barZ + rng.j(0.24), rng.j(0.4), { rz: -sgn * (0.19 + rng.j(0.05)) }),
        ...steel({ ox: i * 4, rust: 0.9 }),
      });
    }
    L.addProxy(EX + sgn * 0.35, 1.6, barZ, 0.5, 3.2, 0.7, 0, 'rustMetal');
    // bulkhead practicals raking down the wall
    for (const lz of lampZ) {
      L.addPracticalSpec(EX + sgn * 0.20, 3.6, lz, 0xffb257, 11, 10, { flicker: rng.chance(0.4) ? 0.25 : 0 });
      const lb = new GeoBuf();
      chamferBox(0.10, 0.16, 0.30, 0.02, { buf: lb, center: [sgn * 0.06, 0, -0.10] });
      chamferCylinder(0.10, 0.13, 10, 0.02, { buf: lb, center: [0, -0.06, 0.08] });
      B.add('paintedMetal', lb.toGeometry(), {
        matrix: mat(EX + sgn * 0.07, 3.72, lz, 0), ...walk({ ox: lz }),
      });
      B.add('lampGlow', chamferCylinder(0.075, 0.05, 10, 0.012, { center: [0, 0, 0] }), {
        matrix: mat(EX + sgn * 0.16, 3.63, lz, 0), bucket, shadow: false,
      });
    }
  };
  // east wall (interior is to -x of it)
  wallDressing(LAYOUT.wh.x1, -1, [[-16.2, 5.4], [-9.4, 6.8], [-2.6, 4.6], [3.4, 6.0]], -12.4, -5.2, [-14.0, -4.0]);
  /**
   * West wall. This is the one the critics actually measured: from the south
   * warehouse spawn the whole right-hand 40 % of frame is this wall plus the
   * mezzanine soffit above it, and it carried no practical, no silhouette event
   * and nothing to give the weapon contrast to read against.
   */
  // z values chosen to miss the pallet racking bays at z = -19.7..-17.3,
  // -14.1..-11.7 and -8.5..-6.1 that already stand against this wall.
  wallDressing(LAYOUT.wh.x0, 1, [[-5.0, 6.4], [1.5, 5.2]], -15.9, -10.2, [-12.6, -3.4]);

  /* ── interior dressing ───────────────────────────────────────────────── */
  // pallet racking along the west wall
  for (let i = 0; i < 3; i++) {
    const z = -18.5 + i * 5.6;
    const rb = new GeoBuf();
    for (const dz of [-1.1, 1.1]) {
      for (const dx of [-1.35, 0, 1.35]) {
        chamferBox(0.10, 5.0, 0.10, 0.015, { buf: rb, center: [dx, 2.5, dz] });
      }
    }
    for (const y of [1.9, 3.5, 4.9]) {
      for (const dz of [-1.1, 1.1]) chamferBox(3.0, 0.09, 0.10, 0.014, { buf: rb, center: [0, y, dz] });
    }
    B.add('paintedMetal', rb.toGeometry(), {
      bucket, paint: weather({ base: [1.42, 0.86, 0.42], rust: [1.02, 0.53, 0.28], rustAmount: 0.5, scale: 1.4, offset: [i * 20, 0, 0], grimeHeight: 1.0, dirt: 0.4 }),
    });
    L.addProxy(-31.0, 2.5, z, 3.2, 5.0, 2.4, 0, 'paintedMetal');
    // crates on the shelves
    for (const y of [0, 1.99, 3.59]) {
      if (rng.chance(0.35)) continue;
      const cg = geoCrate(rng);
      B.add('wood', cg, { matrix: mat(-31.0 + rng.j(0.9), y + 0.02, z + rng.j(0.7), rng.j(0.3)), bucket });
    }
  }

  // fallen roof debris pile in the collapsed NW corner — grounds the collapse
  for (let i = 0; i < 26; i++) {
    const x = rng.range(W.x0 + 0.5, cx + 2.5);
    const z = rng.range(1.0, W.z1 + 3.0);
    const t = Math.max(0, 1 - Math.hypot(x - (W.x0 + 4), z - (W.z1 - 1)) / 12);
    B.add('concrete', geoRubble(rng, 1.1 + t * 1.5), {
      matrix: mat(x, rng.range(-0.05, 0.25 + t * 1.1), z, rng.range(0, 6.28), { rx: rng.j(0.35), rz: rng.j(0.35) }),
      bucket,
    });
  }
  for (let i = 0; i < 7; i++) {
    const g = geoCorrugatedPanel(rng.range(1.4, 3.0), rng.range(1.4, 3.2), { ...CLAD_RIB, thickness: 0.055 });
    B.add('corrugatedMetal', g, {
      matrix: mat(rng.range(W.x0 + 1, cx + 4), rng.range(0.05, 0.9), rng.range(0.5, W.z1 + 4), rng.range(0, 6.28), { rx: -1.4 + rng.j(0.5), rz: rng.j(0.4) }),
      ...clad({ ox: 200 + i * 9, rust: 0.95, base: [0.80, 0.84, 0.84] }),
    });
  }
  L.addProxy(W.x0 + 4.5, 0.55, W.z1 - 0.5, 11, 1.1, 8, 0, 'concrete');

  /* ── sodium practicals hanging from the trusses ──────────────────────── */
  const lampY = eaves - 1.4;
  const lampSpots = [
    [-29.0, -16.5], [-20.0, -16.5], [-29.0, -8.0], [-20.0, -8.0], [-24.5, -1.0], [-17.5, 3.0],
  ];
  for (const [lx, lz] of lampSpots) {
    const lb = new GeoBuf();
    chamferBox(0.05, 1.1, 0.05, 0.01, { buf: lb, center: [0, 0.55, 0] });
    // shallow reflector cone
    const R = 0.34, r2 = 0.12;
    for (let i = 0; i < 12; i++) {
      const a0 = (i / 12) * Math.PI * 2, a1 = ((i + 1) / 12) * Math.PI * 2;
      lb.quad(
        [Math.cos(a0) * R, -0.16, Math.sin(a0) * R],
        [Math.cos(a1) * R, -0.16, Math.sin(a1) * R],
        [Math.cos(a0) * r2, 0.06, Math.sin(a0) * r2],
        [Math.cos((a0 + a1) / 2) * 0.55, 0.83, Math.sin((a0 + a1) / 2) * 0.55],
      );
    }
    B.add('paintedMetal', lb.toGeometry(), {
      matrix: mat(lx, lampY, lz), bucket,
      paint: weather({ base: [0.96, 1.00, 0.94], rustAmount: 0.4, scale: 3, offset: [lx * 3, 0, lz * 3], grimeHeight: 0.2, dirt: 0.2, groundY: lampY - 0.2 }),
    });
    const bulb = chamferCylinder(0.10, 0.16, 10, 0.03, { center: [lx, lampY - 0.19, lz] });
    B.add('lampGlow', bulb, { bucket, shadow: false });
    L.addPracticalSpec(lx, lampY - 0.35, lz, 0xffb257, 16, 13, { flicker: rng.chance(0.3) ? 0.4 : 0 });
  }

  // wall-mounted work lights outside, over the doors
  L.addPracticalSpec(-12.6, 5.4, -14.0, 0xffb257, 11, 10, {});
  L.addPracticalSpec(-12.6, 5.4, 1.0, 0xffb257, 11, 10, { flicker: 0.55, flickerSpeed: 8 });

  /* ── light shafts through the west clerestory and the collapsed corner ─
   * The clerestory band is blown out between 6.6 m and 8.4 m; at 8.7 degrees of solar
   * elevation the beams rake almost horizontally down the length of the shed, which is
   * exactly the read we want.                                                        */
  /**
   * ── SHAFT GEOMETRY IS NOT DECORATION ───────────────────────────────────
   *
   * The sun travels (0.4641, -0.1513, -0.8728). A beam entering the west
   * clerestory at (x0, 8.5, z0) therefore exits through the SOUTH gable after
   * (z0 - z_south) / 0.8728 metres — it never reaches the slab, because at 8.7
   * degrees of elevation it would need 56 m of travel to fall 8.5 m and the shed
   * is 26 m deep. The three shafts this level shipped with were all 22-24 m long
   * regardless of that, so every one of them punched straight through the south
   * wall and parked an additive cone out in the open yard, and none of them lit
   * anything. They also sat at 6 m spacing with near-identical angles, which is
   * exactly the "stack of parallel sheets" read.
   *
   * Two shafts now, wider apart and wider open, each cut to its real travel
   * distance, each with a visible aperture at the clerestory it comes through and
   * a hot patch on the gable it actually strikes.
   */
  /**
   * ── A SHAFT NEEDS A SOURCE AND A DESTINATION ───────────────────────────
   *
   * The critics' verdict was that these read as "blurry milky billboards … no
   * cone taper you can trace, and critically, no visible aperture at the top for
   * it to come through." The cone maths were right — each beam genuinely enters
   * through the blown-out clerestory band and genuinely terminates on the south
   * gable — but neither end was LIT, so nothing on screen said so.
   *
   * Three changes: the spread comes down (1.55 -> 1.20) so the beam narrows and
   * reads as directional rather than as a wedge; the aperture patch on the inside
   * face of the west wall goes from a token 0.55 gain to a full one, so you can
   * see the hole the light is coming through; and a second, small, very hot patch
   * sits right in the mouth of the beam so the source has a core rather than a
   * soft glow. The shader carries the rest — see SHAFT_FRAG in index.js.
   */
  const shaft = (z0, y0, radius, spread, gain) => {
    const t = (z0 - W.z0) / 0.8728;
    L.addShaft(W.x0 - 0.2, y0, z0, radius, t, spread, gain);
    // aperture in the clerestory band, seen from inside: the hole it comes through
    L.addLightPatch(W.x0 + 0.06, y0, z0, radius * 1.00, 1, 0, 0, gain * 0.80);
    L.addLightPatch(W.x0 + 0.10, y0, z0, radius * 0.40, 1, 0, 0, gain * 1.05);
    // landing patch on the inside face of the south gable
    L.addLightPatch(W.x0 - 0.2 + 0.4641 * t, y0 - 0.1513 * t, W.z0 + 0.30,
      radius * spread * 1.05, 0, 0, 1, gain * 1.30);
    L.addLightPatch(W.x0 - 0.2 + 0.4641 * t, y0 - 0.1513 * t, W.z0 + 0.34,
      radius * spread * 0.40, 0, 0, 1, gain * 1.20);
  };
  shaft(-13.0, 8.55, 2.7, 1.20, 0.80);
  shaft(-4.6, 8.40, 2.5, 1.25, 0.74);
  /**
   * The two shafts through the collapsed north-west corner used to be 5.0 m and
   * 4.2 m at the mouth spreading 3.2x over 34 m — a 16 m-wide additive cone that
   * left the building entirely and parked itself across the open yard, where it
   * stopped reading as light in air and started reading as a solid white wedge in
   * front of the sandbag line. Half the length, half the spread, a third of the
   * gain: still a visible god ray from inside the shed, invisible from outside it.
   */
  /**
   * One low beam through the collapsed corner, aimed so it actually reaches the
   * SLAB: from 3.2 m it falls to zero over 21 m of travel, landing at roughly
   * (-20, 0, -10) in the middle of the shed floor. That pool is the whole point —
   * a god ray that lands on nothing is a billboard, a god ray with a hot floor
   * patch under it is light.
   */
  {
    const y0 = 3.2, t = y0 / 0.1513;
    L.addShaft(-30.0, y0, 8.0, 2.1, t, 1.35, 0.44);
    // where it lands: a broad pool with a hot core, so the beam terminates in
    // something rather than fading out in mid-air
    L.addLightPatch(-30.0 + 0.4641 * t, 0.09, 8.0 - 0.8728 * t, 4.6, 0, 1, 0, 0.62);
    L.addLightPatch(-30.0 + 0.4641 * t, 0.10, 8.0 - 0.8728 * t, 1.9, 0, 1, 0, 0.80);
  }
}

/* ──────────────────────── east container yard ─────────────────────────── */

function containerYard(B, L, rng) {
  const bucket = 'east';

  /** place one container: (x,y,z) is the base centre, ry radians */
  const place = (x, y, z, ry, len, opts = {}) => {
    const g = geoContainer(rng, {
      length: len, color: opts.color,
      ribPeriod: BOX_RIB.period, ribDepth: BOX_RIB.depth, ribWeb: BOX_RIB.web,
    });
    const m = mat(x, y, z, ry, { rx: opts.rx || 0, rz: opts.rz || 0 });
    // `containerSteel` is the corrugatedMetal recipe at the ISO 290 mm texel
    // density — see TARGET_TILE. Same GPU texture, one extra draw call.
    B.add('containerSteel', g, { matrix: m, bucket: opts.bucket || bucket });
    const c = Math.cos(ry), s = Math.sin(ry);
    L.addProxy(x, y + 1.3, z, len, 2.6, 2.44, ry, 'corrugatedMetal');
    // dirt / rubble skirt so it never looks dropped in
    if (y < 0.4) {
      for (let i = 0; i < 5; i++) {
        const t = rng.range(-0.5, 0.5) * len;
        const sd = rng.sign() * (1.22 + rng.range(0.0, 0.5));
        B.add('gravel', geoRubble(rng, 0.55), {
          matrix: mat(x + c * t - s * sd, -0.03, z + s * t + c * sd, rng.range(0, 6.28), { rz: rng.j(0.3) }),
          bucket: opts.bucket || bucket, shadow: false,
        });
      }
    }
    return { x, y, z, ry, len };
  };

  // ── the overwatch stack ────────────────────────────────────────────────
  /**
   * Tiers are spaced 2.62 m, not 2.59. A container is exactly 2.59 m tall, so
   * stacking at 2.59 puts the upper box's underside quad in the same plane as the
   * lower one's roof corrugation crests and they interpenetrate — visible from the
   * overwatch deck as the upper box's face cutting into the one below it. Real
   * stacks sit on corner castings and carry a 25-30 mm gap.
   */
  place(26.0, 0, -14.0, 0, 12.19);
  place(26.15, 2.62, -14.1, 0.018, 12.19);
  // Third and fourth tiers sit at the WEST end only, so the deck at x≈26.5..32 stays
  // open sky and the stack still reads as a stepped silhouette from the lane.
  //
  // These used to be at x=21.6 and x=20.4 on top of a 12.19 m tier whose west face is
  // at x=19.9. That put 1.3 m of tier three and a further 1.2 m of tier four out past
  // the edge below them — a cumulative 2.5 m of unsupported box, which from the lane
  // spawn read as three containers hanging in mid-air rather than a stack. Both are
  // now inside the footprint they stand on (tier four keeps a 0.3 m lip so it doesn't
  // become a plain column), and the tilt is dialled back: a container cocked 3° on a
  // flat roof lifts a corner and re-sells the floating read.
  /**
   * Pushed 1.5 m further west than they were. From the published `overwatch`
   * vantage at x=31 the old tier-3/4 pair stood 5 m off the lens and bisected the
   * frame vertically as one unlit black slab with the crosshair sitting in the
   * only gap. Moving them inboard turns them into a stepped silhouette on the left
   * third instead of a wall down the middle, and the practical added in midground()
   * lifts their shaded east flank off black.
   */
  place(21.6, 5.24, -14.15, 0.016, 6.06, { color: [0.62, 0.84, 0.98] });
  place(21.9, 7.86, -14.32, -0.013, 6.06, { color: [1.12, 0.62, 0.46] });

  // ── stair tower up the east side to the 5.2 m deck ─────────────────────
  {
    const sx = 33.9;
    const steelPaint = {
      bucket, uvScale: PROP_UV.walkway, paint: weather({
        base: [0.84, 0.90, 0.82], rust: [1.00, 0.68, 0.46], rustAmount: 0.34,
        scale: 0.9, offset: [90, 0, 0], grimeHeight: 1.4, dirt: 0.42, streaks: 0.55,
      }),
    };
    // flight 1 : z +1.0 -> -5.5, y 0 -> 2.6   (1:2.5, see rampProxy)
    let g = geoStairs(2.6, 6.5, 1.4, { stepRise: 0.19 });
    g.rotateY(Math.PI); g.translate(sx, 0, 1.0);
    B.add('paintedMetal', g, steelPaint);
    rampProxy(L, sx, 1.0, -5.5, 0, 2.6, 1.5);
    // landing
    B.add('paintedMetal', (() => { const c = geoCatwalk(1.8, 1.5, {}); c.rotateY(Math.PI / 2); c.translate(sx, 2.6, -6.3); return c; })(), steelPaint);
    L.addProxy(sx, 2.53, -6.3, 1.6, 0.16, 2.0, 0, 'rustMetal');
    // flight 2 : z -7.1 -> -13.6, y 2.6 -> 5.2
    g = geoStairs(2.6, 6.5, 1.4, { stepRise: 0.19 });
    g.rotateY(Math.PI); g.translate(sx, 2.6, -7.1);
    B.add('paintedMetal', g, steelPaint);
    rampProxy(L, sx, -7.1, -13.6, 2.6, 5.2, 1.5);
    // bridge across to the container top
    const c = geoCatwalk(3.4, 1.6, {});
    c.translate(sx - 1.9, 5.22, -13.6);
    B.add('paintedMetal', c, steelPaint);
    L.addProxy(sx - 1.9, 5.12, -13.6, 3.8, 0.16, 1.8, 0, 'rustMetal');
    // legs
    for (const z of [0.0, -6.3, -12.4]) {
      for (const dx of [-0.72, 0.72]) {
        const h = z > -6.0 ? 2.6 : 5.2;
        B.add('paintedMetal', chamferBox(0.09, h, 0.09, 0.014, { center: [sx + dx, h * 0.5, z] }), steelPaint);
      }
    }
    // railings along the deck edge on top of the container
    const r = geoRailing(6.0, { height: 1.06, spacing: 1.5, toe: true });
    r.rotateY(Math.PI / 2);
    r.translate(28.6, 5.23, -15.15);
    B.add('paintedMetal', r, steelPaint);
  }

  // ── the rest of the yard: rows at varied angles ────────────────────────
  /**
   * ── ROW GEOMETRY ───────────────────────────────────────────────────────
   *
   * The published yaws were all inside +/-0.1 rad (6 degrees at most, usually
   * 1-3), which is not enough to break a row: the overwatch frame read as one
   * perfectly axis-aligned rank of identical boxes running unbroken to the frame
   * edge. Real yards are stacked by a reach-stacker driver in a hurry — units sit
   * several degrees out, a 20 ft box turns up in a row of 40s, and no two boxes
   * are the same paint age.
   *
   * Yaws below are the AUTHORED ones (they matter for cover lines and for the
   * chain-link clearances); `jitter` adds up to +/-8 degrees on top, and lengths
   * that are marked `v` are allowed to swap between a 20 ft and a 40 ft unit.
   */
  /**
   * `[x, z, yaw, length, stackedLength|0]`. A non-zero fifth entry puts a second
   * unit on top, and it INHERITS the ground unit's jittered heading — a box that
   * is eight degrees off the one it stands on immediately reads as falling off
   * it, which is the failure an earlier pass here had to undo.
   */
  const rows = [
    // 17.5 with a 12.19 m box reached x=11.4 and drove the chain-link line at
    // x=12.6 straight through the middle of it. Shortened and pushed east.
    [17.6, -30.0, 0.06, 6.06, 6.06],
    [25.2, -30.6, -0.05, 6.06, 0],
    [28.0, -28.0, -0.10, 6.06, 6.06],
    [31.0, -20.0, 1.57 + 0.05, 6.06, 0],
    [16.0, -19.0, 0.02, 6.06, 0],
    [19.0, -3.0, 1.57 - 0.04, 12.19, 6.06],
    [23.5, 3.5, 0.05, 12.19, 0],
    [24.0, 6.5, 0.9, 6.06, 0],
    [31.5, 10.0, 1.57, 12.19, 6.06],
    [18.0, 14.0, -0.06, 12.19, 0],
    [26.0, 18.0, 0.5, 6.06, 0],
    [15.0, 26.0, 1.2, 12.19, 6.06],
    [28.0, 28.0, -0.2, 6.06, 0],
    [22.0, 33.0, 0.1, 12.19, 0],
    // a couple of strays across the central lane for cover / silhouette
    [8.5, -32.0, 1.05, 6.06, 0], [-6.0, 18.0, 0.35, 6.06, 0],
    [6.5, 5.0, 1.42, 6.06, 0],
  ];
  for (const [x, z, ry, len, up] of rows) {
    // +/- 8 degrees. The published yaws were all inside 3 degrees, which is why
    // the overwatch frame read as one dead-straight axis-aligned rank.
    const yaw = ry + rng.j(0.11);
    const bkt = x < 12 ? 'central' : 'east';
    // a 20 ft unit turning up in a row of 40s, but only where nothing stands on it
    const l = (!up && len > 10 && rng.chance(0.3)) ? 6.06 : len;
    place(x, 0, z, yaw, l, { bucket: bkt });
    if (up) {
      place(x + rng.j(0.28), 2.62, z + rng.j(0.28), yaw + rng.j(0.022), up, { bucket: bkt });
    }
  }
  // a toppled one, on its side
  {
    const g = geoContainer(rng, {
      length: 6.06, color: [0.38, 0.22, 0.14],
      ribPeriod: BOX_RIB.period, ribDepth: BOX_RIB.depth, ribWeb: BOX_RIB.web,
    });
    B.add('containerSteel', g, { matrix: mat(20.5, 2.45, 21.0, 0.6, { rz: Math.PI / 2 }), bucket });
    L.addProxy(20.5, 1.22, 21.0, 6.4, 2.44, 2.6, 0.6, 'corrugatedMetal');
  }

  L.addPracticalSpec(33.0, 5.6, -9.5, 0xffb257, 13, 12, { flicker: 0.25 });
  L.addPracticalSpec(20.5, 5.0, 16.0, 0xffb257, 11, 11, {});
}

/* ─────────────────────────── central lane ─────────────────────────────── */

function centralLane(B, L, rng) {
  const bucket = 'central';

  /* ── jersey barrier chicanes ─────────────────────────────────────────── */
  const barrierRun = (x, z, ry, n, spread = 2.44) => {
    for (let i = 0; i < n; i++) {
      const t = (i - (n - 1) * 0.5) * spread;
      const c = Math.cos(ry), s = Math.sin(ry);
      const bx = x + c * t, bz = z + s * t;
      const jr = ry + rng.j(0.045);
      B.add('concrete', geoJerseyBarrier(rng, {}), {
        matrix: mat(bx, rng.range(-0.02, 0.02), bz, jr, { rz: rng.j(0.02) }),
        bucket, uvScale: PROP_UV.barrier,
      });
      L.addProxy(bx, 0.46, bz, 2.44, 0.92, 0.62, jr, 'concrete');
      // dirt skirt: three chips of spall at the foot so it never reads as dropped in
      for (let k = 0; k < 3; k++) {
        const off = (rng.f() - 0.5) * 2.3;
        const side = rng.sign() * rng.range(0.30, 0.58);
        B.add('gravel', geoRubble(rng, 0.5), {
          matrix: mat(bx + Math.cos(jr) * off - Math.sin(jr) * side, -0.035,
            bz + Math.sin(jr) * off + Math.cos(jr) * side, rng.range(0, 6.28), { rz: rng.j(0.3) }),
          bucket, shadow: false,
        });
      }
    }
  };
  barrierRun(-4.0, -33.0, 0.06, 4);
  barrierRun(5.5, -27.5, 1.60, 3);
  barrierRun(-6.5, -14.0, 1.52, 3);
  barrierRun(3.0, -6.5, 0.03, 4);
  barrierRun(-3.0, 9.0, 1.57, 3);
  barrierRun(7.0, 16.0, 0.10, 3);
  barrierRun(-5.0, 28.0, 0.02, 4);
  barrierRun(9.5, 32.0, 1.5, 2);

  /* ── sandbag emplacements ────────────────────────────────────────────── */
  /**
   * ── SANDBAG EMPLACEMENT ────────────────────────────────────────────────
   *
   * The shipped version laid identical capsules in a perfect running bond with a
   * dead-straight crest, and it read as procedural output rather than as something
   * a section stacked in the dark. Four things fix that, and all four are physical
   * rather than decorative:
   *
   *  - SETTLING. A filled bag is 20 kg of wet sand. The bottom course carries the
   *    whole wall and squashes ~14 % in height while bulging ~9 % sideways; the top
   *    course carries nothing and keeps its shape. Interpolating that load down the
   *    stack is what makes the wall look built rather than assembled.
   *  - AN UNEVEN CREST. Bags go missing off the top and the last course never
   *    finishes flush.
   *  - BAGS OUT OF LINE. One in twelve is shoved proud, with extra yaw.
   *  - SLUMP. A bag or two has come off the wall and is lying at the toe, which is
   *    also what stops the wall meeting the ground on a drawn line.
   */
  /**
   * ── HOW THE WALL IS BUILT ──────────────────────────────────────────────
   *
   * Two things changed after the critic pass, and only the second one is about
   * placement:
   *
   *  1. THE PRIMITIVE. `geoSandbag()` is now a lofted, sagging pillow rather than
   *     a chamfered box (see kit.js). No stacking rule can rescue a puck.
   *  2. THE WALL IS TWO BAGS THICK. It was one rank of 0.30 m bags on a 0.44 m
   *     pitch, so a fifth of the wall's area was literally open air and the frame
   *     showed daylight straight through it in two places. A real emplacement is
   *     laid header-and-stretcher, two deep, with each course breaking joint over
   *     the one below. Here that is a front and a back rank offset by half a bag
   *     along the wall AND by half a pitch course to course, which closes every
   *     line of sight through it without a single extra rule.
   *
   * Sag is driven by the load above: `load` is 1 in the bottom course and 0 at
   * the crest, and it feeds the bag generator directly, so the bottom bags are
   * genuinely squashed and dished rather than uniformly scaled copies.
   */
  const sandbagWall = (x, z, ry, len, rows = 5) => {
    const c = Math.cos(ry), s = Math.sin(ry);
    const PITCH = 0.40;
    let y = 0;
    for (let r = 0; r < rows; r++) {
      const load = 1 - r / Math.max(1, rows - 1);          // 1 at the bottom course
      /**
       * Course height is deliberately ~10 % LESS than a bag's rendered height,
       * so every course beds into the one below instead of balancing on it. That
       * overlap is what closes the horizontal joint lines the critics saw
       * daylight through, and it is also physically what happens when 20 kg of
       * wet sand lands on a bag.
       */
      const courseH = 0.134 + (1 - load) * 0.014;
      const inset = r * 0.042;
      const top = r === rows - 1;
      const n = Math.max(1, Math.round((len - inset * 2) / PITCH));
      /**
       * ── COURSE PHASE ────────────────────────────────────────────────────
       * The running bond used a fixed half-bag offset on alternate courses,
       * which is a perfectly regular lattice — and a regular lattice is exactly
       * what all three critics read off the wall ("a regular running-bond course
       * with uniform spacing", "visible row offset regularity"). A per-course
       * random phase on top of the bond breaks the vertical alignment without
       * breaking the bond itself.
       */
      const coursePhase = rng.range(-0.22, 0.22);
      for (let rank = 0; rank < 2; rank++) {
        // front rank sits proud; back rank is offset half a bag along the wall
        const off = (rank ? 0.152 : -0.152) - inset * 0.25;
        const phase = (r % 2 ? 0.5 : 0) + (rank ? 0.5 : 0) + coursePhase;
        for (let i = 0; i < n; i++) {
          // the crest is never finished flush, and the back rank runs out first
          if (top && rng.chance(rank ? 0.34 : 0.16)) continue;
          const t = (i - (n - 1) * 0.5 + phase) * PITCH + rng.j(0.055);
          if (Math.abs(t) > len * 0.5 + 0.16) continue;
          const kick = (rng.chance(0.10) ? rng.sign() * rng.range(0.05, 0.15) : 0);
          const bx = x + c * t - s * (off + kick), bz = z + s * t + c * (off + kick);
          /**
           * ── NON-UNIFORM SCALE ───────────────────────────────────────────
           * "Every bag is the same size" was true in a way a uniform 0.92-1.08
           * jitter could never fix: a scaled copy of a shape is still the same
           * shape. Scaling the three axes INDEPENDENTLY — and squashing the
           * bottom two courses vertically by 12-20 % because they are carrying
           * the wall — makes each bag a different solid, not a different size.
           */
          const squash = r < 2 ? rng.range(0.80, 0.90) : rng.range(0.90, 1.06);
          const sx2 = rng.range(0.86, 1.18);
          const sz2 = rng.range(0.88, 1.16);
          const g = geoSandbag(rng, { sag: load * rng.range(0.62, 1.0) });
          B.add('sandbags', g, {
            matrix: mat(bx, y + courseH * 0.5 - 0.012 + rng.j(0.014), bz,
              // +/- 22 degrees, more where a bag has been shoved out of line
              ry + rng.j(0.38) + (kick ? rng.j(0.40) : 0),
              { rz: rng.j(0.12), rx: rng.j(0.08), scale: [sx2, squash, sz2] }),
            bucket,
          });
        }
      }
      y += courseH;
    }
    /**
     * ── BURST BAGS ────────────────────────────────────────────────────────
     * Two or three bags per emplacement have split and dumped their fill. They
     * are the thing that says a section stacked this in the dark and it has been
     * sat in ever since, and the spilled cone at the base is what makes the wall
     * grow out of the slab.
     */
    for (let i = 0; i < 3; i++) {
      const t = rng.j(len * 0.52);
      const side = rng.sign() * rng.range(0.30, 0.55);
      const bx = x + c * t - s * side, bz = z + s * t + c * side;
      B.add('sandbags', geoSandbag(rng, { burst: true, sag: 1.0 }), {
        matrix: mat(bx, 0.032, bz, ry + rng.j(1.4), { rz: rng.j(0.35), rx: rng.j(0.2), scale: [1.16, 0.7, 1.1] }),
        bucket,
      });
      B.add('sandbags', geoSandPile(rng, { radius: rng.range(0.34, 0.58), height: rng.range(0.05, 0.11) }), {
        matrix: mat(bx + rng.j(0.22), 0.008, bz + rng.j(0.22), rng.range(0, 6.28)),
        bucket, shadow: false,
      });
    }
    // slumped bags at the toe — two on one side, one on the other
    for (let i = 0; i < 4; i++) {
      const t = rng.j(len * 0.48);
      const side = (i & 1 ? -1 : 1) * rng.range(0.34, 0.62);
      B.add('sandbags', geoSandbag(rng, { sag: 0.9 }), {
        matrix: mat(x + c * t - s * side, 0.055, z + s * t + c * side,
          ry + rng.j(1.1), { rz: rng.j(0.5), rx: rng.j(0.25), scale: [1.02, 0.86, 1.04] }),
        bucket,
      });
    }
    /**
     * Spilled sand. Bags leak, and the pile at the toe is what makes the wall
     * grow out of the slab instead of being parked on it. Six mounds per
     * emplacement, biased to the sunlit face so they actually read.
     */
    for (let i = 0; i < 7; i++) {
      const t = rng.j(len * 0.55);
      const side = rng.sign() * rng.range(0.22, 0.68);
      B.add('sandbags', geoSandPile(rng, { radius: rng.range(0.30, 0.72) }), {
        matrix: mat(x + c * t - s * side, 0.012, z + s * t + c * side, rng.range(0, 6.28)),
        bucket, shadow: false,
      });
    }
    L.addProxy(x, y * 0.5, z, len + 0.5, y, 0.58, ry, 'sandbags');
    // widen the ground contact so the emplacement sits in a dust wedge
    L.markContact(x, z, len * 0.5 + 0.34, 0.52, ry, 0.5, 0.95);
  };
  sandbagWall(-7.0, 7.5, 0.03, 4.4, 5);
  sandbagWall(-5.2, 5.6, 1.57, 2.6, 5);
  sandbagWall(8.0, -12.0, 0.02, 5.0, 6);
  sandbagWall(-2.0, 30.0, 1.57, 3.4, 5);
  sandbagWall(12.6, 3.0, 1.55, 3.0, 4);

  /* ── the wrecked lorry — hero prop at the south end of the lane ──────── */
  buildTruckWreck(B, mat(3.5, 0.02, -23.0, 2.55, { rz: 0.035 }), rng, { bucket });
  L.addProxy(3.5, 1.2, -23.0, 7.2, 2.4, 2.5, 2.55, 'paintedMetal');
  L.markContact(3.5, -23.0, 3.9, 1.5, 2.55, 0.5, 1.1);
  L.addProxy(6.4, 1.6, -24.9, 2.4, 2.6, 2.3, 2.55, 'paintedMetal');

  // a second, further-gone wreck up north for layering
  buildTruckWreck(B, mat(-8.0, 0.02, 26.0, 0.85, { rz: -0.06 }), rng, { bucket });
  L.addProxy(-8.0, 1.2, 26.0, 7.2, 2.4, 2.5, 0.85, 'paintedMetal');
  L.markContact(-8.0, 26.0, 3.9, 1.5, 0.85, 0.5, 1.1);

  /* ── concrete culvert pipes: cover + strong silhouette ───────────────── */
  const pipe = (x, z, ry, R = 0.95, len = 3.0) => {
    const b = new GeoBuf();
    const seg = 16, t = 0.10;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const co0 = Math.cos(a0), si0 = Math.sin(a0), co1 = Math.cos(a1), si1 = Math.sin(a1);
      const nm = [0, Math.cos((a0 + a1) / 2), Math.sin((a0 + a1) / 2)];
      b.quad([-len / 2, co0 * R, si0 * R], [len / 2, co0 * R, si0 * R], [-len / 2, co1 * R, si1 * R], nm, 2, 1);
      b.quad([-len / 2, co0 * (R - t), si0 * (R - t)], [len / 2, co0 * (R - t), si0 * (R - t)], [-len / 2, co1 * (R - t), si1 * (R - t)], [-nm[0], -nm[1], -nm[2]], 2, 1);
      for (const e of [-1, 1]) {
        b.quad([e * len / 2, co0 * R, si0 * R], [e * len / 2, co1 * R, si1 * R], [e * len / 2, co0 * (R - t), si0 * (R - t)], [e, 0, 0]);
      }
    }
    const g = b.toGeometry();
    B.add('concrete', g, {
      matrix: mat(x, R, z, ry), bucket, uvScale: PROP_UV.concreteProp,
      paint: weatherConcrete({ base: [0.94, 0.92, 0.9], offset: [x, 0, z], grimeHeight: 1.4, dirt: 0.55, groundY: -R }),
    });
    L.addProxy(x, R, z, len, R * 2, R * 2, ry, 'concrete');
  };
  pipe(-9.0, -20.0, 0.25);
  pipe(-9.4, -20.2, 0.22, 0.95, 3.0);
  pipe(-8.6, -18.0, 1.2);
  pipe(10.5, 22.0, 1.35);
  pipe(11.0, 24.2, 1.3);

  /* ── sodium lamp poles down the lane ─────────────────────────────────── */
  const lamp = (x, z, ry, h = 7.4) => {
    const b = new GeoBuf();
    chamferCylinder(0.10, h, 10, 0.02, { buf: b, center: [0, h * 0.5, 0], sideSeg: 3 });
    chamferCylinder(0.11, 0.24, 10, 0.03, { buf: b, center: [0, 0.12, 0] });
    // arm
    const arm = new GeoBuf();
    chamferCylinder(0.06, 1.5, 8, 0.015, { buf: arm, center: [0, 0, 0] });
    const ag = arm.toGeometry();
    ag.rotateZ(Math.PI / 2 - 0.28);
    ag.translate(0.72, h - 0.22, 0);
    mergeBufInto(b, ag);
    // head
    chamferBox(0.56, 0.16, 0.30, 0.045, { buf: b, center: [1.42, h - 0.44, 0] });
    B.add('paintedMetal', b.toGeometry(), {
      matrix: mat(x, 0, z, ry), bucket, uvScale: PROP_UV.steelFine,
      paint: weather({ base: [0.94, 0.99, 0.94], rust: [1.02, 0.54, 0.28], rustAmount: 0.6, scale: 1.1, offset: [x * 5, 0, z * 5], grimeHeight: 1.2, dirt: 0.4, streaks: 0.7 }),
    });
    const lensG = chamferBox(0.44, 0.05, 0.22, 0.02, { center: [1.42, h - 0.53, 0] });
    lensG.applyMatrix4(mat(x, 0, z, ry));
    B.add('lampGlow', lensG, { bucket, shadow: false, uvScale: 1 });
    L.addProxy(x, h * 0.5, z, 0.24, h, 0.24, 0, 'paintedMetal');
    const c = Math.cos(ry), s = Math.sin(ry);
    L.addPracticalSpec(x + c * 1.42, h - 0.62, z + s * 1.42, 0xffa040, 42, 24, { flicker: rng.chance(0.35) ? 0.45 : 0 });
  };
  /**
   * Sodium poles down both kerbs of the lane.
   *
   * These are not decoration — they are the fill light for half the map. With an 8.7
   * degree sun the warehouse throws an 75 m shadow diagonally across the central lane,
   * and measured off the shipped post stack that shadowed ground lands at sRGB 29
   * against a 157 sky: a black pit. A sodium pool at 1.2 m puts a warm, saturated
   * accent into exactly that region, which is both the fix and the art direction —
   * warm practicals as the only saturated colour in a cool desaturated frame.
   */
  lamp(-11.5, -36.0, 0.0);
  lamp(11.8, -28.0, Math.PI);
  lamp(-11.5, -18.0, 0.0);
  lamp(11.8, -10.0, Math.PI);
  lamp(-13.0, -2.0, 0.0, 6.6);
  lamp(11.8, 6.0, Math.PI);
  lamp(-11.5, 16.0, 0.0);
  lamp(11.8, 26.0, Math.PI);
  lamp(-11.5, 34.0, 0.0);
  // east alley — the strip between the container yard and the works wall sits in the
  // perimeter block's shadow all evening and was reading as a black pit
  lamp(34.6, 10.0, Math.PI, 6.8);
  lamp(34.6, 28.0, Math.PI, 6.8);
  lamp(-34.8, 24.0, 0.0, 6.4);
  /**
   * The container yard itself. The stack at x=20..32 casts a 60 m shadow across
   * everything east of the lane all evening, and measured off the shipped build
   * the ground between the rows resolved to sRGB (11,13,20) — a black pit filling
   * a third of every east-facing frame. Two more poles put warm sodium pools into
   * exactly that region and give the rows something to silhouette against.
   */
  lamp(14.4, -24.0, 0.0, 6.8);
  lamp(24.6, -8.6, Math.PI * 0.5, 6.6);
  lamp(26.5, 24.0, -Math.PI * 0.5, 6.6);

  /* ── burn barrels: ground-level warm pools with real falloff onto the paving ── */
  const burnBarrel = (x, z) => {
    const g = geoDrum(rng);
    B.add('rustMetal', g, {
      matrix: mat(x, 0, z, rng.range(0, 6.28)), bucket, uvScale: 3.4,
      paint: weather({
        base: [0.86, 0.74, 0.62], rust: [1.05, 0.55, 0.30], rustAmount: 0.95,
        scale: 2.4, offset: [x * 7, 0, z * 7], grimeHeight: 0.3, dirt: 0.55, streaks: 0.9,
      }),
    });
    // charred contents, seen from above and glowing
    const coals = chamferCylinder(0.25, 0.06, 12, 0.02, { center: [x, 0.86, z] });
    B.add('emberGlow', coals, { bucket, shadow: false });
    L.addProxy(x, 0.44, z, 0.62, 0.88, 0.62, 0, 'rustMetal');
    L.addPracticalSpec(x, 1.15, z, 0xff7a26, 17, 11, { flicker: 0.85, flickerSpeed: 9.5 });
  };
  burnBarrel(-8.2, -28.5);
  burnBarrel(9.4, -6.0);
  burnBarrel(-7.6, 24.0);
  burnBarrel(29.8, 12.5);
  burnBarrel(-3.0, -19.5);
  burnBarrel(21.0, -33.0);
  burnBarrel(22.6, -24.4);
  burnBarrel(15.0, -6.5);

  /**
   * ── LANE FOREGROUND ANCHOR ─────────────────────────────────────────────
   *
   * Measured defect: in the `lane` pose roughly 35 % of the frame — everything
   * from x0-1000, y600-1080 — was a single undifferentiated dark mass at a mean
   * sRGB of 33/36/43, with no readable object, no foreground element and no
   * leading line. The one strong idea in that frame (a converging lane to a sun
   * on the vanishing point) was fighting a dead zone occupying the whole
   * lower-left, so the composition had two layers instead of three.
   *
   * The camera sits at (9.5, 0.1, -22) looking at (-8, 3, 24), so its right
   * vector is (-0.93, 0, -0.35) — frame-LEFT is +X/+Z. This group is placed by
   * projecting candidate points onto that basis: it lands 6-9 m out and 0.4-0.6
   * of a half-frame to the left, which is the near-foreground third exactly.
   *
   * It has to do three things or it is just more clutter:
   *   1. READ AS A SILHOUETTE — a barrier slab, a drum stack and a leaning
   *      pallet rack give three different, unmistakable outlines;
   *   2. CATCH THE KEY ON ITS TOP EDGE — the sun bears (-0.464, 0.151, 0.873),
   *      i.e. it is behind and left of this group, so every top surface takes a
   *      rim and every vertical face falls away into the dark mass. That rim is
   *      the leading line the frame was missing;
   *   3. CARRY A PRACTICAL — a burn barrel inside the group puts a warm pool on
   *      the ground under it, so the dead zone has a value gradient rather than
   *      one flat number.
   */
  {
    const FX0 = 10.4, FZ0 = -14.2;
    // a) the jersey slab that catches the rim — angled across the sightline
    for (let i = 0; i < 2; i++) {
      const bx = FX0 - 0.5 + i * 2.30, bz = FZ0 - 2.6 + i * 0.55;
      const jr = 1.35 + i * 0.06;
      B.add('concrete', geoJerseyBarrier(rng, {}), {
        matrix: mat(bx, 0.0, bz, jr, { rz: rng.j(0.03) }), bucket, uvScale: PROP_UV.barrier,
      });
      L.addProxy(bx, 0.46, bz, 2.44, 0.92, 0.62, jr, 'concrete');
      L.markContact(bx, bz, 1.28, 0.36, jr, 0.50, 0.85);
    }
    // b) a stack of drums, one on its side, on a pallet — a tall broken outline
    const drumStack = [
      [FX0 + 1.15, FZ0 + 1.10, 0.0, 0],
      [FX0 + 1.72, FZ0 + 1.55, 0.0, 0],
      [FX0 + 1.42, FZ0 + 1.32, 0.90, 0],
      [FX0 + 0.72, FZ0 + 2.05, 0.0, Math.PI / 2],
    ];
    for (const [dx2, dz2, dy, rz] of drumStack) {
      B.add('rustMetal', geoDrum(rng), {
        matrix: mat(dx2, dy, dz2, rng.range(0, 6.28), { rz }), bucket, uvScale: 3.4,
        paint: weather({
          base: [0.90, 0.82, 0.70], rust: [1.05, 0.55, 0.30], rustAmount: rng.range(0.5, 0.95),
          scale: 2.4, offset: [dx2 * 9, 0, dz2 * 9], grimeHeight: 0.30, dirt: 0.55, streaks: 0.9,
        }),
      });
      if (dy < 0.05) L.addProxy(dx2, 0.45, dz2, 0.64, 0.9, 0.64, 0, 'rustMetal');
      L.markContact(dx2, dz2, 0.33, 0.33, 0, 0.46, 0.55);
    }
    // c) a leaning pallet rack: a diagonal, which is what gives the group a read
    for (let i = 0; i < 3; i++) {
      B.add('wood', geoPallet(rng), {
        matrix: mat(FX0 - 1.55 + rng.j(0.10), 0.02 + i * 0.135, FZ0 + 0.55 + rng.j(0.10),
          0.75 + rng.j(0.12), { rz: rng.j(0.04) }),
        bucket, uvScale: 2.0,
        paint: weather({
          base: [1.02, 0.94, 0.80], rustAmount: 0.2, scale: 3.0,
          offset: [i * 11, 0, 4], grimeHeight: 0.12, dirt: 0.32, streaks: 0.3,
        }),
      });
    }
    B.add('wood', geoPallet(rng), {
      matrix: mat(FX0 - 2.35, 0.44, FZ0 + 0.30, 0.4, { rz: 1.15 }), bucket, uvScale: 2.0,
      paint: weather({ base: [0.98, 0.90, 0.76], rustAmount: 0.2, scale: 3.0, grimeHeight: 0.2, dirt: 0.34, streaks: 0.3 }),
    });
    L.addProxy(FX0 - 1.6, 0.24, FZ0 + 0.55, 1.4, 0.48, 1.1, 0.75, 'wood');
    L.markContact(FX0 - 1.7, FZ0 + 0.5, 0.9, 0.75, 0.75, 0.46, 0.9);
    // d) the practical that lifts the whole dead zone off the floor
    burnBarrel(FX0 + 2.85, FZ0 - 0.35);
    L.markDust(FX0, FZ0, 4.2, 0.42);

    /**
     * ── A NEAR CLUSTER, LIT FROM INSIDE ────────────────────────────────────
     *
     * The lane camera looks along bearing 21 degrees west of north and the sun
     * bears 28 degrees west of north — they are SEVEN degrees apart, so every
     * near object in this frame presents its unlit face and no amount of extra
     * geometry in the lower-left will read off the key alone. The only light
     * that can describe a near object here is a practical, so the second cluster
     * is built around one: a burn barrel at 4.5 m with two drums and a barrier
     * standing in its pool, which turns the dead corner into a warm, legible
     * foreground layer with a value gradient running out of it.
     */
    burnBarrel(11.55, -17.75);
    for (const [dx2, dz2] of [[10.55, -18.55], [12.45, -18.15]]) {
      B.add('rustMetal', geoDrum(rng), {
        matrix: mat(dx2, 0, dz2, rng.range(0, 6.28)), bucket, uvScale: 3.4,
        paint: weather({
          base: [0.92, 0.84, 0.72], rust: [1.05, 0.55, 0.30], rustAmount: rng.range(0.5, 0.95),
          scale: 2.4, offset: [dx2 * 13, 0, dz2 * 13], grimeHeight: 0.30, dirt: 0.55, streaks: 0.9,
        }),
      });
      L.addProxy(dx2, 0.45, dz2, 0.64, 0.9, 0.64, 0, 'rustMetal');
      L.markContact(dx2, dz2, 0.33, 0.33, 0, 0.46, 0.55);
    }
    {
      const bx = 11.35, bz = -19.95, jr = 1.18;
      B.add('concrete', geoJerseyBarrier(rng, {}), {
        matrix: mat(bx, 0, bz, jr, { rz: rng.j(0.03) }), bucket, uvScale: PROP_UV.barrier,
      });
      L.addProxy(bx, 0.46, bz, 2.44, 0.92, 0.62, jr, 'concrete');
      L.markContact(bx, bz, 1.28, 0.36, jr, 0.50, 0.85);
    }
    L.markDust(11.5, -18.4, 3.2, 0.40);
  }

  /* ── kerb islands and a bent lamp for asymmetry ──────────────────────── */
  {
    const b = new GeoBuf();
    chamferCylinder(0.10, 4.4, 10, 0.02, { buf: b, center: [0, 2.2, 0], sideSeg: 3 });
    const g = b.toGeometry();
    g.rotateZ(0.55);
    g.translate(13.6, 0.1, 39.5);
    B.add('paintedMetal', g, {
      bucket, paint: weather({ base: [0.92, 0.97, 0.92], rustAmount: 0.85, scale: 1.2, offset: [11, 0, 5], grimeHeight: 1.0, dirt: 0.4 }),
    });
  }
}

/* ──────────────────────────── pipe gantry ─────────────────────────────── */

function gantry(B, L, rng) {
  const bucket = 'central';
  const y = 6.4, z = 14.0;
  const steelP = {
    bucket, uvScale: PROP_UV.steelFine,
    paint: weather({ base: [1.00, 1.00, 0.97], rust: [1.00, 0.72, 0.54], rustAmount: 0.34, scale: 0.8, offset: [55, 0, 0], grimeHeight: 2.0, dirt: 0.48, streaks: 0.6 }),
  };

  // legs
  for (const x of [-12.5, 12.5]) {
    const b = new GeoBuf();
    for (const dz of [-0.8, 0.8]) {
      for (const dx of [-0.55, 0.55]) {
        chamferBox(0.16, y, 0.16, 0.02, { buf: b, center: [dx, y * 0.5, dz] });
      }
    }
    for (let h = 1.5; h < y; h += 1.7) {
      chamferBox(1.26, 0.09, 0.09, 0.014, { buf: b, center: [0, h, -0.8] });
      chamferBox(1.26, 0.09, 0.09, 0.014, { buf: b, center: [0, h, 0.8] });
      chamferBox(0.09, 0.09, 1.7, 0.014, { buf: b, center: [-0.55, h, 0] });
      chamferBox(0.09, 0.09, 1.7, 0.014, { buf: b, center: [0.55, h, 0] });
    }
    B.add('rustMetal', b.toGeometry(), { matrix: mat(x, 0, z, 0), ...steelP });
    for (const dz of [-0.8, 0.8]) {
      for (const dx of [-0.55, 0.55]) L.addProxy(x + dx, y * 0.5, z + dz, 0.2, y, 0.2, 0, 'rustMetal');
    }
    // concrete footing
    B.add('concrete', chamferBox(2.0, 0.5, 2.6, 0.05, { center: [x, 0.18, z] }), {
      bucket, uvScale: PROP_UV.concreteProp,
      paint: weatherConcrete({ base: [0.92, 0.9, 0.88], offset: [x, 0, z], grimeHeight: 0.5, dirt: 0.55 }),
    });
    L.addProxy(x, 0.2, z, 2.0, 0.44, 2.6, 0, 'concrete');
  }

  // deck truss across
  {
    const b = new GeoBuf();
    const span = 25.0;
    for (const dz of [-0.8, 0.8]) {
      chamferBox(span, 0.18, 0.14, 0.02, { buf: b, center: [0, y - 0.1, dz] });
      chamferBox(span, 0.18, 0.14, 0.02, { buf: b, center: [0, y + 1.3, dz] });
    }
    for (let x = -span / 2 + 0.6; x < span / 2; x += 1.9) {
      for (const dz of [-0.8, 0.8]) chamferBox(0.09, 1.4, 0.09, 0.014, { buf: b, center: [x, y + 0.6, dz] });
      chamferBox(0.09, 0.09, 1.7, 0.014, { buf: b, center: [x, y - 0.1, 0] });
    }
    // the pipes it carries
    B.add('rustMetal', b.toGeometry(), { matrix: mat(0, 0, z, 0), ...steelP });
    for (const [pz, pr] of [[-0.45, 0.30], [0.15, 0.22], [0.6, 0.16]]) {
      const g = chamferCylinder(pr, 25.0, 12, 0.03, { sideSeg: 6 });
      g.rotateZ(Math.PI / 2);
      g.translate(0, y + 1.65 + pr, z + pz);
      B.add('rustMetal', g, {
        bucket, uvScale: PROP_UV.steel,
        paint: weather({ base: [1.06, 0.88, 0.72], rust: [1.04, 0.54, 0.28], rustAmount: 0.9, scale: 0.9, offset: [pz * 30, 0, 0], grimeHeight: 3, dirt: 0.4, streaks: 0.9, groundY: y }),
      });
      // lagging bands
      for (let x = -11; x <= 11; x += 2.6) {
        B.add('paintedMetal', chamferCylinder(pr + 0.03, 0.16, 12, 0.02, { caps: false }), {
          matrix: mat(x, y + 1.65 + pr, z + pz, 0, { rz: Math.PI / 2 }), bucket, uvScale: PROP_UV.steelFine,
          paint: weather({ base: [1.15, 1.05, 0.86], rustAmount: 0.5, scale: 2, grimeHeight: 1, dirt: 0.2, groundY: y }),
        });
      }
    }
    // Deck and pipes are visual only, for the nav-grid reason documented on the
    // warehouse roof: a 25 m solid band at 6.4 m would sever the central lane for the
    // AI even though a player walks straight under it. The legs and footings below
    // still collide, which is what actually matters for cover.
  }
}

/* ─────────────────────── midground composition ────────────────────────── */

/**
 * ── WHY THIS FUNCTION EXISTS ───────────────────────────────────────────────
 *
 * The critics' verdict on composition was that the frames are not composed: the
 * eye jumps straight from the yard at 0-25 m to the fog band at 60 m+ with
 * nothing between, so there is no focal point and no depth ladder. `lane` was the
 * only framed shot in the map, because it happens to have the gantry sitting at
 * the vanishing point.
 *
 * A midground anchor has to do three specific things or it is just another prop:
 *   1. sit at 25-45 m from where the camera actually stands,
 *   2. BREAK THE HORIZON, so it silhouettes against the haze rather than being
 *      absorbed by the ground plane,
 *   3. read as one legible object at that range — an open lattice or a long
 *      diagonal, not another 2.4 m box.
 *
 * These three are ray-marched from the published camera poses:
 *   - the toppled crane boom sits 30-40 m down the `overwatch` bearing and 45 m
 *     down the `lane-south` sweep, and its 7 m propped end cuts the skyline;
 *   - the conveyor trestle is 28 m north of the lane spawn and frames the gantry;
 *   - the tipped bowser closes the north end of the lane.
 */
function midground(B, L, rng) {
  const bucket = 'midground';
  const steelP = (seed, base) => ({
    bucket, uvScale: PROP_UV.steelFine,
    paint: weather({
      base: base || [0.98, 0.98, 0.94], rust: [1.02, 0.58, 0.32], rustAmount: 0.7,
      scale: 0.8, offset: [seed, 0, seed * 0.7], grimeHeight: 2.2, dirt: 0.45, streaks: 0.8,
    }),
  });

  /**
   * Square lattice boom section along +X, tapering from `r0` to `r1` half-width.
   * Four chords with K-lacing on all four faces — the open web is what makes it
   * silhouette as a crane rather than as a beam.
   */
  const boom = (len, r0, r1, bay = 1.5, chord = 0.10) => {
    const b = new GeoBuf();
    const n = Math.max(2, Math.round(len / bay));
    const R = (t) => r0 + (r1 - r0) * t;
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        // chord: a run of short boxes so it can taper
        for (let i = 0; i < n; i++) {
          const t0 = i / n, t1 = (i + 1) / n;
          const y0 = sy * R(t0), z0 = sz * R(t0);
          const y1 = sy * R(t1), z1 = sz * R(t1);
          const seg = len / n;
          const g = new GeoBuf();
          chamferBox(seg + 0.02, chord, chord, chord * 0.2, { buf: g });
          const gg = g.toGeometry();
          gg.rotateZ(Math.atan2(y1 - y0, seg));
          gg.translate(-len * 0.5 + (i + 0.5) * seg, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
          mergeBufInto(b, gg);
        }
      }
    }
    // lacing: alternating diagonals on the two vertical faces, verticals on the rest
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = -len * 0.5 + (i + 0.5) * (len / n);
      const rr = R(t);
      for (const sz of [-1, 1]) {
        const dl = Math.hypot(len / n, rr * 2);
        const g = new GeoBuf();
        chamferBox(dl, chord * 0.62, chord * 0.62, chord * 0.14, { buf: g });
        const gg = g.toGeometry();
        gg.rotateZ((i % 2 ? 1 : -1) * Math.atan2(rr * 2, len / n));
        gg.translate(x, 0, sz * rr);
        mergeBufInto(b, gg);
      }
      for (const sy of [-1, 1]) {
        chamferBox(chord * 0.6, chord * 0.6, rr * 2, chord * 0.14, { buf: b, center: [x, sy * rr, 0] });
      }
    }
    return b.toGeometry();
  };

  /**
   * ── 1. THE TOPPLED CRANE ──────────────────────────────────────────────
   * A 22 m lattice boom that has come down across the south yard, its head still
   * propped 7 m up on the wreck of its own A-frame. It crosses the `overwatch`
   * sightline at 32 m and the `lane` sweep at 45 m, and the propped end is the
   * only thing in the south half of the map that cuts the skyline.
   */
  {
    const ax = 13.5, az = -37.0;          // butt end, on the ground
    const bx = -3.0, bz = -30.5;          // head end, up in the air
    const hy = 7.2;
    const dx = bx - ax, dz = bz - az;
    const run = Math.hypot(dx, dz);
    const len = Math.hypot(run, hy);
    const yaw = Math.atan2(dz, dx);
    const g = boom(len, 0.62, 0.34, 1.45, 0.115);
    g.rotateZ(Math.atan2(hy, run));
    g.rotateY(-yaw);
    g.translate((ax + bx) * 0.5, hy * 0.5 + 0.35, (az + bz) * 0.5);
    B.add('rustMetal', g, steelP(19, [1.02, 0.90, 0.74]));
    // colliders along the boom so it is real cover, not a hologram
    for (let i = 0; i < 6; i++) {
      const t = (i + 0.5) / 6;
      L.addProxy(ax + dx * t, 0.35 + hy * t, az + dz * t, 1.5, 1.3, 1.5, yaw, 'rustMetal');
    }
    // the A-frame stub it is resting on
    for (const s of [-1, 1]) {
      const gg = new GeoBuf();
      chamferBox(0.22, 8.4, 0.22, 0.03, { buf: gg });
      const g2 = gg.toGeometry();
      g2.rotateZ(s * 0.28);
      g2.translate(bx + s * 1.2, 4.2, bz + 0.8);
      B.add('rustMetal', g2, steelP(27));
      L.addProxy(bx + s * 1.2, 4.2, bz + 0.8, 0.5, 8.4, 0.5, 0, 'rustMetal');
    }
    // ballast blocks and a shed skirt at the butt
    for (let i = 0; i < 4; i++) {
      B.add('concrete', chamferBox(2.0, 0.42, 1.3, 0.05, { center: [0, 0.21, 0] }), {
        matrix: mat(ax + rng.j(1.6), i * 0.42, az + rng.j(1.4), rng.j(0.5)),
        bucket, uvScale: PROP_UV.concreteProp,
        paint: weatherConcrete({ base: [0.9, 0.88, 0.85], offset: [ax + i, 0, az], grimeHeight: 0.6, dirt: 0.6 }),
      });
    }
    L.addProxy(ax, 0.85, az, 2.4, 1.7, 1.8, 0, 'concrete');
    L.markContact(ax, az, 2.2, 2.0, 0, 0.5, 1.3);
    // a warm practical under the propped head, so the boom is read as a shape and
    // not as another black bar across the frame
    L.addPracticalSpec(bx + 0.6, 2.6, bz - 1.4, 0xffb257, 13, 13, {});
  }

  /**
   * ── 2. CONVEYOR TRESTLE ────────────────────────────────────────────────
   * A raking lattice conveyor 28 m north of the lane spawn, running from a hopper
   * on the west kerb up over the fence to a spoil heap. It puts a diagonal across
   * the upper third of every north-facing frame, which is the one part of the
   * composition that had nothing in it at all.
   */
  {
    const ax = -14.5, az = 19.0, bx = -1.5, bz = 31.0, hy = 8.6;
    const dx = bx - ax, dz = bz - az;
    const run = Math.hypot(dx, dz);
    const len = Math.hypot(run, hy - 1.1);
    const yaw = Math.atan2(dz, dx);
    const g = boom(len, 0.55, 0.42, 1.6, 0.10);
    g.rotateZ(Math.atan2(hy - 1.1, run));
    g.rotateY(-yaw);
    g.translate((ax + bx) * 0.5, (1.1 + hy) * 0.5, (az + bz) * 0.5);
    B.add('rustMetal', g, steelP(41, [0.96, 0.94, 0.88]));
    // support bents
    for (const t of [0.34, 0.72]) {
      const px = ax + dx * t, pz = az + dz * t, py = 1.1 + (hy - 1.1) * t;
      for (const s of [-1, 1]) {
        const gg = new GeoBuf();
        chamferBox(0.16, py, 0.16, 0.024, { buf: gg, center: [0, py * 0.5, 0] });
        const g2 = gg.toGeometry();
        g2.applyMatrix4(mat(px - Math.sin(yaw) * s * 0.9, 0, pz + Math.cos(yaw) * s * 0.9, 0, { rz: s * 0.06 }));
        B.add('rustMetal', g2, steelP(53));
        L.addProxy(px - Math.sin(yaw) * s * 0.9, py * 0.5, pz + Math.cos(yaw) * s * 0.9, 0.3, py, 0.3, 0, 'rustMetal');
      }
      L.markContact(px, pz, 1.2, 1.2, yaw, 0.42, 0.7);
    }
    // hopper at the foot
    B.add('rustMetal', chamferBox(2.6, 2.2, 2.2, 0.06, { center: [0, 1.1, 0], seg: 2 }), {
      matrix: mat(ax - 0.6, 0, az - 0.6, yaw), ...steelP(61, [1.0, 0.86, 0.7]),
    });
    L.addProxy(ax - 0.6, 1.1, az - 0.6, 2.8, 2.2, 2.4, yaw, 'rustMetal');
    // spoil heap it discharges onto — the reason the whole thing is here
    L.markContact(bx, bz + 1.5, 3.0, 3.0, 0, 0.4, 1.6);
    for (let i = 0; i < 26; i++) {
      const rr = 3.2 * Math.pow(rng.f(), 0.55);
      const a = rng.range(0, 6.28);
      B.add('gravel', geoRubble(rng, 0.9), {
        matrix: mat(bx + Math.cos(a) * rr, Math.max(0, 1.5 - rr * 0.5) + rng.j(0.1),
          bz + 1.4 + Math.sin(a) * rr, rng.range(0, 6.28), { rx: rng.j(0.5), rz: rng.j(0.5) }),
        bucket,
      });
    }
    L.addProxy(bx, 0.7, bz + 1.4, 5.0, 1.4, 5.0, 0, 'gravel');
    L.addPracticalSpec(ax + 1.0, 3.4, az + 0.4, 0xffb257, 11, 11, { flicker: 0.3 });
  }

  /**
   * ── 3. FILL FOR THE NEAR-BLACK MASSES ──────────────────────────────────
   * At 8.7 degrees the sun reaches almost nothing under an overhang, and the
   * critics called out three specific black rectangles: the underside of the
   * mezzanine, the shaded flank of the container stack that bisects `overwatch`,
   * and the warehouse overhang the `spawn` camera stands under. Practicals are
   * shadowless by design in this project, which makes them exactly the right tool
   * for a bounce card — they lift the underside to a readable dark concrete
   * without touching anything the key already handles.
   */
  const bounce = (x, y, z, i, r) => L.addPracticalSpec(x, y, z, 0xc8b49a, i, r, { pool: false });
  bounce(-25.0, 3.4, -15.0, 7, 10);       // under the mezzanine
  bounce(-30.5, 2.2, -18.0, 5, 9);        // mezzanine back corner
  bounce(-16.5, 2.6, -8.0, 6, 12);        // warehouse door overhang
  bounce(28.0, 3.6, -14.0, 7, 11);        // shaded flank of the container stack
  bounce(24.0, 7.2, -14.5, 6, 10);        // upper tiers of the stack
  bounce(-9.0, 2.0, -22.0, 5, 10);        // culvert group
}

/* ───────────────────────────── perimeter ──────────────────────────────── */

/**
 * Ruined block with a real punched facade — spandrels and piers with actual holes,
 * a dark interior box behind them, a parapet, and optional battle damage that removes
 * the top floor of one corner.
 */
function buildBlock(B, L, rng, o) {
  const { x, z, w, d, h, ry = 0 } = o;
  const bucket = o.bucket || 'perimeter';
  const floors = o.floors ?? Math.max(1, Math.round(h / 3.4));
  const fh = h / floors;
  const winH = Math.min(fh * 0.52, 1.7);
  const winTop = fh * 0.86;
  const surface = o.material || 'plaster';
  const tone = o.tone ?? 1.0;
  /**
   * Facade paint. `Builder.add()` applies the placement matrix BEFORE the paint
   * callback, so these coordinates are already world-space; every block is placed
   * with ry=0, so local = world - origin and the floor rhythm can be recovered.
   *
   * Two things are layered on top of the generic concrete weathering:
   *
   *  - SOOT PLUMES above every window head. A burnt-out block is defined by the
   *    black fan of smoke above each opening; without them a punched facade is a
   *    printed texture and reads as cardboard from 60 m, which is exactly how the
   *    whole skyline was reading.
   *  - a much wider low-frequency tonal spread, so no two bays of the same block
   *    resolve to the same value through the haze.
   */
  const baseWeather = weatherConcrete({
    base: [tone * 1.0, tone * 0.975, tone * 0.93],
    offset: [x * 1.7, 0, z * 1.7], grimeHeight: 2.6, dirt: o.dirt ?? 0.45,
  });
  const soot = o.soot ?? 0.85;
  const pnt = {
    bucket,
    paint: (px, py, pz, nx, ny, nz, out) => {
      baseWeather(px, py, pz, nx, ny, nz, out);
      const lx = px - x, lz = pz - z;
      // broad panel-to-panel value spread
      const macro = fbm3(lx * 0.055 + x * 0.3, py * 0.028, lz * 0.055 + z * 0.3, 3);
      const mk = 0.80 + macro * 0.46;
      out[0] *= mk; out[1] *= mk; out[2] *= mk;
      if (soot > 0 && Math.abs(ny) < 0.7 && py > 1.0) {
        const f = py % fh;
        const above = f - winTop;                       // metres above the window head
        if (above > -0.05 && above < fh * 0.95) {
          const u = Math.abs(nx) > Math.abs(nz) ? lz : lx;
          // plumes only over the openings, feathered and noise-broken
          const bay = Math.abs(((u + 400) % 4.6) - 2.3) / 2.3;   // 0 at bay centre
          const lateral = Math.max(0, 1 - bay * 1.35);
          const fade = Math.max(0, 1 - above / (fh * 0.8)) ** 1.35;
          const grain = 0.55 + fbm3(u * 1.5 + 9, py * 1.9, (Math.abs(nx) > Math.abs(nz) ? lx : lz) * 1.5, 3) * 0.9;
          const s = Math.min(0.88, lateral * fade * grain * soot);
          out[0] *= 1 - s * 0.80; out[1] *= 1 - s * 0.82; out[2] *= 1 - s * 0.80;
        }
      }
    },
  };
  const m = mat(x, 0, z, ry);

  const wallT = 0.55;
  const dmgSide = o.damage ? rng.int(0, 3) : -1;
  const buf = new GeoBuf();
  const dark = new GeoBuf();
  const glassBuf = new GeoBuf();
  const boardBuf = new GeoBuf();
  const plantBuf = new GeoBuf();

  /**
   * ── WHY THE WINDOWS LOOK LIKE THIS ─────────────────────────────────────
   *
   * The previous facade punched an opening and hung a single flat quad 30 cm
   * behind it. From 40 m that is a printed rectangle: no reveal, no sill shadow,
   * no depth gradient, no glass, and — most damagingly — twenty identical
   * openings on a perfect grid, none boarded, none blown, no plant on any of them.
   * At 11.5 degrees of solar elevation a real 40 cm reveal throws a hard wedge of
   * shadow across the head and one jamb of every opening, and that single cue does
   * more for a five-storey block than any amount of texture work.
   *
   * So each opening is now:
   *   - a proud LINTEL, 0.20 m out of the wall, which is the thing that actually
   *     casts the wedge (a recess alone casts nothing at a raking sun — the light
   *     comes in almost parallel to the wall);
   *   - a proud SILL that catches the key and stains the wall below it;
   *   - a five-face RECESSED INTERIOR box, painted with a gradient (bounce on the
   *     floor, black at the ceiling) so the hole reads as a room, not a colour;
   *   - a GLASS pane at reveal depth on some, boarding on some, nothing on some,
   *     and an air-conditioner or a fallen lintel on a few — chosen per opening.
   */
  const OPEN_GLAZED = 0, OPEN_BOARDED = 1, OPEN_BLOWN = 2, OPEN_EMPTY = 3;
  const REVEAL = 0.40;          // metres from the facade face to the glass line

  const side = (sideIdx) => {
    const horiz = sideIdx % 2 === 0;               // 0,2 -> faces +/-Z ; 1,3 -> +/-X
    const sgn = sideIdx < 2 ? 1 : -1;
    const spanW = horiz ? w : d;
    const off = (horiz ? d : w) * 0.5;
    const nCol = Math.max(2, Math.round(spanW / 4.6));
    const pierW = Math.max(0.7, (spanW / nCol) * 0.42);
    const cellW = spanW / nCol;

    /** local (u = along the facade, y = up, t = depth INTO the wall from its face) */
    const P = (u, yy, t) => (horiz ? [u, yy, sgn * (off - t)] : [sgn * (off - t), yy, u]);
    /** local normal: du along the facade, dy up, dt outward */
    const N = (du, dy, dt) => (horiz ? [du, dy, sgn * dt] : [sgn * dt, dy, du]);
    /** chamfered box in the local frame; `t` is the depth of its CENTRE */
    const boxAt = (target, u, yy, t, du, dh, dt, ch = 0.03, plain = false) => {
      const g = horiz
        ? chamferBox(du, dh, dt, ch, { center: [u, yy, sgn * (off - t)], plain })
        : chamferBox(dt, dh, du, ch, { center: [sgn * (off - t), yy, u], plain });
      mergeBufInto(target, g);
    };

    const put = (u, yy, uw, hh, thick = wallT) => {
      if (hh <= 0.02 || uw <= 0.02) return;
      const g = horiz
        ? chamferBox(uw, hh, thick, 0.04, { center: [u, yy, sgn * (off - thick * 0.5)], seg: [Math.max(1, Math.round(uw / 2.5)), 1] })
        : chamferBox(thick, hh, uw, 0.04, { center: [sgn * (off - thick * 0.5), yy, u], seg: [1, Math.max(1, Math.round(uw / 2.5))] });
      mergeBufInto(buf, g);
    };

    for (let f = 0; f < floors; f++) {
      const y0 = f * fh;
      const damaged = (sideIdx === dmgSide && f === floors - 1);
      if (damaged) continue;
      // spandrel under the windows + lintel band above
      put(0, y0 + (winTop - winH) * 0.5, spanW, winTop - winH);
      put(0, y0 + winTop + (fh - winTop) * 0.5, spanW, fh - winTop);
      // piers between windows
      for (let c2 = 0; c2 <= nCol; c2++) {
        const u = -spanW * 0.5 + c2 * cellW;
        const uw = pierW;
        const uu = c2 === 0 ? u + uw * 0.5 : (c2 === nCol ? u - uw * 0.5 : u);
        put(uu, y0 + winTop - winH * 0.5, uw, winH);
      }

      for (let c2 = 0; c2 < nCol; c2++) {
        const u = -spanW * 0.5 + (c2 + 0.5) * cellW;
        const uw = cellW - pierW;
        if (uw < 0.4) continue;
        const yy = y0 + winTop - winH;          // sill line
        const yh = yy + winH;                   // head line
        const hu = uw * 0.5;

        // per-opening state — the grid must not be uniform
        const roll = rng.f();
        const state = roll < 0.17 ? OPEN_BOARDED
          : roll < 0.29 ? OPEN_BLOWN
            : roll < 0.86 ? OPEN_GLAZED : OPEN_EMPTY;

        /* ── recessed interior: five faces, so the hole has depth ────────── */
        const tb = REVEAL + 0.55;               // back of the room box
        dark.quad(P(u - hu, yy, tb), P(u + hu, yy, tb), P(u - hu, yh, tb), N(0, 0, 1));               // back
        dark.quad(P(u - hu, yy, REVEAL), P(u - hu, yy, tb), P(u - hu, yh, REVEAL), N(1, 0, 0));       // jamb
        dark.quad(P(u + hu, yy, REVEAL), P(u + hu, yy, tb), P(u + hu, yh, REVEAL), N(-1, 0, 0));      // jamb
        dark.quad(P(u - hu, yh, REVEAL), P(u + hu, yh, REVEAL), P(u - hu, yh, tb), N(0, -1, 0));      // soffit
        dark.quad(P(u - hu, yy, REVEAL), P(u + hu, yy, REVEAL), P(u - hu, yy, tb), N(0, 1, 0));       // inner floor

        /* ── proud lintel: the shadow-caster ─────────────────────────────── */
        /**
         * LOD: `plain` on all four of these. The nearest perimeter facade is
         * 30 m from any camera pose and most are 60-100 m out. A 0.022 m
         * chamfer at 30 m subtends 0.66 px and at 60 m a third of that — it
         * has never been resolvable on any of these members. What DOES read is
         * the 0.20 m projection, which is untouched: the lintel still stands
         * proud of the facade and still drops its wedge of shadow across the
         * head and one jamb at the 8.7-degree sun. 44 triangles to 12 each,
         * four members per opening, ~600 openings across the perimeter.
         */
        const lintelD = 0.22 + rng.f() * 0.06;
        boxAt(buf, u, yh + 0.10, -lintelD * 0.5 + wallT * 0.5,
          uw + 0.46, 0.20, wallT + lintelD, 0.022, true);

        /* ── proud sill, with a wider drip nose ──────────────────────────── */
        boxAt(buf, u, yy - 0.06, -0.09 + wallT * 0.5, uw + 0.40, 0.12, wallT + 0.30, 0.02, true);
        /**
         * The second, lower "drip nose" box is gone. It was 80 x 160 mm, sitting
         * 160 mm under a sill that is itself 120 mm deep and 300 mm proud. The
         * nearest perimeter facade any camera in this map sees is 30 m away,
         * where 80 mm is 2.4 px and it is 2.4 px of the same dark line the sill
         * above it already draws; at the 60-100 m these blocks are normally read
         * at, it is under a pixel. One box per opening, ~600 openings.
         */

        /* ── contents ────────────────────────────────────────────────────── */
        if (state === OPEN_GLAZED) {
          // one pane, split by a mullion, sat at reveal depth
          const gt = REVEAL + 0.02;
          glassBuf.quad(P(u - hu + 0.05, yy + 0.06, gt), P(u + hu - 0.05, yy + 0.06, gt),
            P(u - hu + 0.05, yh - 0.06, gt), N(0, 0, 1));
          /**
           * The mullion is gone too. It was a 60 mm bar standing at reveal
           * depth — that is, 400 mm INSIDE a 400 mm-deep hole, against the
           * near-black `windowDark` room box, lit by nothing. Dark geometry in
           * front of dark geometry at 30 m and beyond contributes no measurable
           * pixel difference, and it was carried on every glazed opening.
           */
        } else if (state === OPEN_BOARDED) {
          // crossed timber, nailed over the opening from the outside
          for (let b = 0; b < 2; b++) {
            const ang = b ? -1 : 1;
            const ln = Math.hypot(uw, winH) * 0.98;
            const g = new GeoBuf();
            chamferBox(ln, 0.19, 0.045, 0.008, { buf: g });
            const gg = g.toGeometry();
            gg.rotateZ(ang * Math.atan2(winH, uw));
            if (!horiz) gg.rotateY(Math.PI / 2);
            gg.translate(...P(u, (yy + yh) * 0.5, 0.06));
            mergeBufInto(boardBuf, gg);
          }
          if (rng.chance(0.5)) {
            const g2 = new GeoBuf();
            chamferBox(uw * 0.96, 0.17, 0.04, 0.008, { buf: g2 });
            const gg2 = g2.toGeometry();
            gg2.rotateZ(rng.j(0.12));
            if (!horiz) gg2.rotateY(Math.PI / 2);
            gg2.translate(...P(u, yy + winH * rng.range(0.25, 0.75), 0.1));
            mergeBufInto(boardBuf, gg2);
          }
        } else if (state === OPEN_BLOWN) {
          // the lintel has come down: a broken stub at one side, rubble on the sill
          const st = rng.sign();
          boxAt(buf, u + st * uw * 0.28, yh - 0.12, wallT * 0.5, uw * 0.42, 0.24, wallT, 0.02, true);
          for (let k = 0; k < 2; k++) {
            const g = geoRubble(rng, 0.42);
            g.applyMatrix4(mat(...P(u + rng.j(hu * 0.7), yy + 0.02, rng.range(0.05, 0.3)),
              rng.range(0, 6.28), { rz: rng.j(0.4) }));
            mergeBufInto(buf, g);
          }
        }

        // plant: an air-conditioner or a satellite dish bracket on a few
        if (rng.chance(0.09)) {
          boxAt(plantBuf, u + rng.j(hu * 0.4), yy + 0.34, -0.24, 0.72, 0.52, 0.44, 0.02, true);
          boxAt(plantBuf, u + rng.j(hu * 0.4), yy + 0.06, -0.20, 0.62, 0.05, 0.34, 0.012, true);
        } else if (rng.chance(0.05)) {
          boxAt(plantBuf, u, yh + 0.30, -0.30, 0.10, 0.10, 0.55, 0.015, true);
          boxAt(plantBuf, u, yh + 0.34, -0.56, 0.62, 0.62, 0.10, 0.03, true);
        }
      }

      /**
       * Floor-line string course. Pushed from 0.19 m proud to 0.34 m: at 11.5
       * degrees the shadow it drops on the wall below is 5x its projection, and
       * at 0.19 m that landed inside one shadow-map texel at 40 m and vanished.
       */
      if (f > 0) {
        const g2 = horiz
          ? chamferBox(spanW + 0.3, 0.19, wallT + 0.42, 0.025, { center: [0, y0 + 0.09, sgn * (off - wallT * 0.5 + 0.18)] })
          : chamferBox(wallT + 0.42, 0.19, spanW + 0.3, 0.025, { center: [sgn * (off - wallT * 0.5 + 0.18), y0 + 0.09, 0] });
        mergeBufInto(buf, g2);
      }

      /**
       * Formwork panel joints on a 2.4 m grid — a 3 cm proud fillet rather than a
       * painted line, so it self-shadows. Cast concrete is poured against panels
       * and every real slab carries this rhythm; without it a 20 m facade has no
       * intermediate scale between the window grid and the aggregate.
       */
      if (surface !== 'brick') {
        for (let uu = -spanW * 0.5 + 2.4; uu < spanW * 0.5 - 0.4; uu += 2.4) {
          // The fillet itself is 50 mm wide — barely over a pixel at 30 m — so a
          // 12 mm chamfer on it was a quarter of a pixel of shading detail
          // costing 32 triangles, ~160 times per block.
          boxAt(buf, uu, y0 + fh * 0.5, wallT * 0.5 - 0.015, 0.05, fh - 0.1, wallT + 0.03, 0.012, true);
        }
      }
    }
  };
  for (let s = 0; s < 4; s++) side(s);

  // plinth: a slightly proud base course. Buildings meeting the ground on a hard flat
  // line is one of the loudest "greybox" tells there is.
  mergeBufInto(buf, chamferBox(w + 0.44, 1.05, d + 0.44, 0.06, { center: [0, 0.52, 0] }));
  // cornice under the parapet
  mergeBufInto(buf, chamferBox(w + 0.62, 0.30, d + 0.62, 0.05, { center: [0, h - 0.15, 0] }));

  /**
   * ── FLOOR SLABS: DELETED, THEY WERE NEVER VISIBLE ──────────────────────
   *
   * The comment on these said "visible through the windows". They are not.
   * Every opening in the facade is sealed by the five-face `dark` room box,
   * whose back wall sits at REVEAL + 0.55 = 0.95 m behind the facade line and
   * spans the full width and height of the opening. Nothing behind that plane
   * can be seen from outside, and the player can never get inside a perimeter
   * block — the collider shell is four solid walls with no door.
   *
   * That made these slabs pure hidden interior geometry: one 44-triangle box
   * per floor per block, drawn three times in the main pass and up to four
   * times more in the cascades, for a surface with no line of sight to any
   * camera in the map. Removed.
   */
  /**
   * Parapet — broken into panels with random gaps and heights rather than one
   * continuous extrusion. A dead-straight parapet line is the single loudest
   * "this is a box" tell on a skyline, and these blocks ARE the skyline.
   */
  for (const [ax, az, along, thick] of [
    [0, d * 0.5 - 0.2, w, 0.4], [0, -d * 0.5 + 0.2, w, 0.4],
    [w * 0.5 - 0.2, 0, d, 0.4], [-w * 0.5 + 0.2, 0, d, 0.4],
  ]) {
    const horiz = Math.abs(ax) < 0.01;
    const nSeg = Math.max(3, Math.round(along / 3.2));
    const seg = along / nSeg;
    for (let i = 0; i < nSeg; i++) {
      if (rng.chance(0.16)) continue;                      // shelled-out panel
      const u = -along * 0.5 + (i + 0.5) * seg;
      const ph = 0.75 * rng.range(0.62, 1.06);
      const box = horiz
        ? chamferBox(seg * 0.99, ph, thick, 0.05, { center: [u, h + ph * 0.5, az], plain: true })
        : chamferBox(thick, ph, seg * 0.99, 0.05, { center: [ax, h + ph * 0.5, u], plain: true });
      mergeBufInto(buf, box);
    }
  }

  /**
   * Rooftop plant. Water tanks, a lift-motor room, a stairwell head and a couple
   * of aerials. This is what turns a run of parapets into a skyline instead of a
   * bar chart, and it costs nothing — it merges into the same buffer as the
   * facade, so the whole perimeter is still one draw call per material.
   */
  {
    const nClutter = rng.int(2, 4);
    for (let i = 0; i < nClutter; i++) {
      const cxr = rng.j(w * 0.32), czr = rng.j(d * 0.32);
      const k = rng.f();
      if (k < 0.34) {
        // cylindrical water tank on short legs
        const r = rng.range(0.9, 1.7), th = rng.range(1.6, 2.8);
        mergeBufInto(buf, chamferCylinder(r, th, 10, 0.08, { center: [cxr, h + 0.55 + th * 0.5, czr] }));
        for (const [lx, lz] of [[-r * 0.6, -r * 0.6], [r * 0.6, -r * 0.6], [-r * 0.6, r * 0.6], [r * 0.6, r * 0.6]]) {
          mergeBufInto(buf, chamferBox(0.16, 0.6, 0.16, 0.02, { center: [cxr + lx, h + 0.3, czr + lz], plain: true }));
        }
      } else if (k < 0.72) {
        // plant room / stairwell head with a shallow mono-pitch cap
        const bw = rng.range(2.4, 4.6), bd = rng.range(2.2, 3.8), bh = rng.range(2.0, 3.4);
        mergeBufInto(buf, chamferBox(bw, bh, bd, 0.06, { center: [cxr, h + bh * 0.5, czr], seg: [2, 1] }));
        mergeBufInto(buf, chamferBox(bw + 0.4, 0.22, bd + 0.4, 0.04, { center: [cxr, h + bh + 0.11, czr], plain: true }));
        // vent hood
        mergeBufInto(buf, chamferCylinder(0.34, 0.8, 6, 0.05, { center: [cxr + bw * 0.28, h + bh + 0.5, czr] }));
      } else {
        // lattice aerial mast with guy-post stubs
        const mh = rng.range(4.5, 9.5);
        mergeBufInto(buf, chamferBox(0.22, mh, 0.22, 0.03, { center: [cxr, h + mh * 0.5, czr], plain: true }));
        for (const yy of [0.32, 0.62, 0.86]) {
          mergeBufInto(buf, chamferBox(1.5, 0.09, 0.09, 0.015, { center: [cxr, h + mh * yy, czr], plain: true }));
          mergeBufInto(buf, chamferBox(0.09, 0.09, 1.2, 0.015, { center: [cxr, h + mh * yy - 0.5, czr], plain: true }));
        }
        mergeBufInto(buf, chamferBox(1.0, 0.16, 1.0, 0.03, { center: [cxr, h + 0.08, czr], plain: true }));
      }
    }
  }

  B.add(surface, buf.toGeometry(), { matrix: m, ...pnt });
  /**
   * The recessed room boxes. The gradient is baked from the face normal rather
   * than from a texture: the soffit is nearly black, the jambs sit between, and
   * the inner floor is lifted because in a real room that is the one surface the
   * low sun and the sky actually reach through the opening. That value ramp is
   * what makes twenty holes read as twenty rooms instead of twenty grey stickers.
   */
  B.add('windowDark', dark.toGeometry(), {
    matrix: m, bucket, shadow: false,
    paint: (px, py, pz, nx, ny, nz, out) => {
      let k = 0.62;                                   // jamb / back wall
      if (ny > 0.5) k = 1.35;                         // inner floor: catches bounce
      else if (ny < -0.5) k = 0.20;                   // soffit: the darkest thing on the block
      const grain = 0.82 + fbm3(px * 0.7, py * 0.7, pz * 0.7, 2) * 0.42;
      out[0] = k * grain; out[1] = k * grain * 1.01; out[2] = k * grain * 1.06;
    },
  });
  if (!glassBuf.isEmpty) B.add('windowGlass', glassBuf.toGeometry(), { matrix: m, bucket, shadow: false });
  if (!boardBuf.isEmpty) {
    B.add('wood', boardBuf.toGeometry(), {
      matrix: m, bucket, uvScale: 1.4,
      paint: weather({ base: [0.72, 0.64, 0.53], rustAmount: 0.2, scale: 2.0, offset: [x, 0, z], grimeHeight: 0.4, dirt: 0.4, streaks: 0.5, groundY: 3 }),
    });
  }
  if (!plantBuf.isEmpty) {
    B.add('paintedMetal', plantBuf.toGeometry(), {
      matrix: m, bucket, uvScale: 2.6,
      paint: weather({ base: [0.86, 0.88, 0.86], rust: [1.0, 0.6, 0.36], rustAmount: 0.55, scale: 2.2, offset: [x + 13, 0, z], grimeHeight: 0.5, dirt: 0.35, streaks: 0.7, groundY: 3 }),
    });
  }

  // a handful of lit windows — the only warm accents in the far silhouette
  if (o.litWindows !== 0) {
    const glow = new GeoBuf();
    const n = o.litWindows ?? rng.int(2, 5);
    for (let i = 0; i < n; i++) {
      const f = rng.int(0, floors - 1);
      const horiz = rng.chance(0.5);
      const sgn = rng.sign();
      const spanW = horiz ? w : d;
      const off = (horiz ? d : w) * 0.5;
      const u = rng.range(-spanW * 0.35, spanW * 0.35);
      const uw = 1.5;
      const g = horiz
        ? chamferBox(uw, winH * 0.9, 0.08, 0.02, { center: [u, f * fh + winTop - winH * 0.5, sgn * (off - wallT - 0.2)] })
        : chamferBox(0.08, winH * 0.9, uw, 0.02, { center: [sgn * (off - wallT - 0.2), f * fh + winTop - winH * 0.5, u] });
      mergeBufInto(glow, g);
    }
    B.add('windowGlow', glow.toGeometry(), { matrix: m, bucket, shadow: false });
  }

  // colliders: a shell of four wall boxes so bullets and bodies stop at the facade
  const cs = Math.cos(ry), sn = Math.sin(ry);
  const put = (lx, lz, lw, ld) => L.addProxy(x + cs * lx - sn * lz, h * 0.5 + 0.4, z + sn * lx + cs * lz, lw, h + 0.8, ld, ry, surface);
  put(0, d * 0.5 - 0.3, w, 0.9);
  put(0, -d * 0.5 + 0.3, w, 0.9);
  put(w * 0.5 - 0.3, 0, 0.9, d);
  put(-w * 0.5 + 0.3, 0, 0.9, d);

  // rubble skirt at the base
  const nR = Math.round((w + d) * 0.55);
  for (let i = 0; i < nR; i++) {
    const t = rng.f() * 4;
    const e = Math.floor(t), u = (t - e - 0.5);
    let px, pz;
    if (e === 0) { px = u * w; pz = d * 0.5 + rng.range(0.2, 2.6); }
    else if (e === 1) { px = u * w; pz = -d * 0.5 - rng.range(0.2, 2.6); }
    else if (e === 2) { px = w * 0.5 + rng.range(0.2, 2.6); pz = u * d; }
    else { px = -w * 0.5 - rng.range(0.2, 2.6); pz = u * d; }
    B.add('concrete', geoRubble(rng, rng.range(0.7, 1.6)), {
      matrix: mat(x + cs * px - sn * pz, rng.range(-0.06, 0.12), z + sn * px + cs * pz, rng.range(0, 6.28), { rx: rng.j(0.3), rz: rng.j(0.3) }),
      bucket,
    });
  }
  return { x, z, w, d, h };
}

function perimeter(B, L, rng) {
  const bucket = 'perimeter';

  // ── SOUTH: an unbroken three-to-five storey wall of ruined blocks ──────
  buildBlock(B, L, rng, { x: -26, z: -52, w: 26, d: 16, h: 15.5, floors: 5, material: 'plaster', tone: 0.46, damage: true, litWindows: 3 });
  buildBlock(B, L, rng, { x: -2, z: -54, w: 24, d: 18, h: 12.5, floors: 4, material: 'brick', tone: 0.47, damage: true, litWindows: 2 });
  buildBlock(B, L, rng, { x: 20, z: -52, w: 20, d: 16, h: 19.0, floors: 6, material: 'plaster', tone: 0.43, damage: true, litWindows: 4 });
  buildBlock(B, L, rng, { x: 36, z: -56, w: 18, d: 14, h: 10.0, floors: 3, material: 'brick', tone: 0.50, litWindows: 1 });

  // ── EAST: works buildings and a boundary wall ─────────────────────────
  buildBlock(B, L, rng, { x: 45, z: -22, w: 16, d: 30, h: 13.0, floors: 4, material: 'brick', tone: 0.46, damage: true, litWindows: 2 });
  buildBlock(B, L, rng, { x: 46, z: 16, w: 18, d: 26, h: 17.5, floors: 5, material: 'plaster', tone: 0.44, damage: true, litWindows: 3 });
  boundaryWall(B, L, rng, 38.5, -46, 38.5, 44, 4.2, 'concrete');

  // ── NORTH-EAST: apartment blocks. NORTH-WEST: collapsed to rubble ─────
  buildBlock(B, L, rng, { x: 24, z: 54, w: 26, d: 18, h: 20.0, floors: 6, material: 'plaster', tone: 0.43, damage: true, litWindows: 5 });
  buildBlock(B, L, rng, { x: 2, z: 56, w: 20, d: 16, h: 14.0, floors: 4, material: 'brick', tone: 0.46, damage: true, litWindows: 2 });
  // low broken wall across the sun gap — deliberately under 4 m
  boundaryWall(B, L, rng, -38, 48, 12, 48, 3.2, 'concrete', true);
  boundaryWall(B, L, rng, -38, 48, -38, 8, 3.4, 'concrete', true);

  // ── WEST: the boiler house, its chimney, and a tall wall — all SOUTH of
  //    the sun bearing so none of it eats the light. ────────────────────
  buildBlock(B, L, rng, { x: -50, z: -18, w: 22, d: 30, h: 16.0, floors: 4, material: 'brick', tone: 0.45, damage: true, litWindows: 2 });
  buildBlock(B, L, rng, { x: -46, z: -46, w: 18, d: 20, h: 11.0, floors: 3, material: 'plaster', tone: 0.49, litWindows: 1 });
  boundaryWall(B, L, rng, -38.5, -46, -38.5, 6, 5.0, 'concrete');

  // chimney: the silhouette anchor on the left of every north-facing frame
  {
    const b = new GeoBuf();
    const H = 26;
    const segs = 8;
    for (let i = 0; i < segs; i++) {
      const y0 = (i / segs) * H, y1 = ((i + 1) / segs) * H;
      const r0 = 1.75 - (y0 / H) * 0.85, r1 = 1.75 - (y1 / H) * 0.85;
      const n = 14;
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
        const nm = [Math.cos((a0 + a1) / 2), 0.07, Math.sin((a0 + a1) / 2)];
        b.quad(
          [Math.cos(a0) * r0, y0, Math.sin(a0) * r0],
          [Math.cos(a1) * r0, y0, Math.sin(a1) * r0],
          [Math.cos(a0) * r1, y1, Math.sin(a0) * r1],
          nm, 1, 1,
        );
      }
    }
    chamferBox(2.2, 0.5, 2.2, 0.06, { buf: b, center: [0, H + 0.2, 0] });
    for (const y of [8, 14, 20]) chamferCylinder(1.75 - (y / H) * 0.85 + 0.09, 0.4, 14, 0.05, { buf: b, center: [0, y, 0], caps: false });
    B.add('brick', b.toGeometry(), {
      matrix: mat(-44.0, 0, -32.0, 0), bucket,
      paint: weatherConcrete({ base: [0.78, 0.70, 0.64], offset: [7, 0, 3], grimeHeight: 6, dirt: 0.55 }),
    });
    L.addProxy(-44.0, 13, -32.0, 3.4, 26, 3.4, 0, 'brick');
    L.addPracticalSpec(-44.0, 26.6, -32.0, 0xff4530, 6, 9, { flicker: 0.9, flickerSpeed: 1.4 });
  }

  /**
   * ── WATER TOWER ────────────────────────────────────────────────────────
   * The east half of the skyline was a flat run of parapets. A riveted water
   * tower on a lattice frame is the standard Eastern-European industrial
   * landmark and, at 19 m on four splayed legs, it is the only thing in the map
   * that breaks the horizon with an open lattice — which is what stops a skyline
   * reading as a bar chart. Sited east-north-east, well off the sun bearing, so
   * it costs the hero light nothing.
   */
  {
    const TX = 34.2, TZ = 30.5;
    const legH = 12.6, spread = 3.1, top = 3.2;
    const b = new GeoBuf();
    const legs = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      legs.push([Math.cos(a), Math.sin(a)]);
    }
    // Legs splay from `spread` at the ground to `top` at the tank ring. Built
    // along +Y, then tilted by theta about Z and swung to azimuth phi about Y —
    // rotateZ(-theta) sends +Y to (sin t, cos t, 0) and rotateY(-phi) swings that
    // into the leg's bearing.
    for (const [cxs, czs] of legs) {
      const bx = cxs * spread, bz = czs * spread;
      const tx = cxs * top, tz2 = czs * top;
      const dx = tx - bx, dz = tz2 - bz;
      const horiz = Math.hypot(dx, dz);
      const len = Math.hypot(legH, horiz);
      const theta = Math.atan2(horiz, legH);
      const phi = Math.atan2(dz, dx);
      const g = new GeoBuf();
      chamferBox(0.17, len, 0.17, 0.022, { buf: g });
      const gg = g.toGeometry();
      gg.rotateZ(-theta);
      gg.rotateY(-phi);
      gg.translate((bx + tx) * 0.5, legH * 0.5, (bz + tz2) * 0.5);
      mergeBufInto(b, gg);
      L.addProxy(TX + (bx + tx) * 0.5, legH * 0.5, TZ + (bz + tz2) * 0.5, 0.34, legH, 0.34, 0, 'rustMetal');
      // concrete pad footing so the tower is not standing on nothing
      B.add('concrete', chamferBox(1.1, 0.4, 1.1, 0.05, { center: [0, 0.14, 0] }), {
        matrix: mat(TX + bx, 0, TZ + bz, 0), bucket,
        paint: weatherConcrete({ base: [0.92, 0.9, 0.87], offset: [bx, 0, bz], grimeHeight: 0.4, dirt: 0.6 }),
      });
    }
    // bracing rings and diagonals
    for (let k = 1; k <= 4; k++) {
      const t = k / 5;
      const r = spread + (top - spread) * t;
      const y = legH * t;
      for (let i = 0; i < 4; i++) {
        const a0 = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const a1 = ((i + 1) / 4) * Math.PI * 2 + Math.PI / 4;
        const p0 = [Math.cos(a0) * r, y, Math.sin(a0) * r];
        const p1 = [Math.cos(a1) * r, y, Math.sin(a1) * r];
        const seg = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
        const g = new GeoBuf();
        chamferBox(seg, 0.09, 0.09, 0.014, { buf: g });
        const gg = g.toGeometry();
        gg.rotateY(-Math.atan2(p1[2] - p0[2], p1[0] - p0[0]));
        gg.translate((p0[0] + p1[0]) * 0.5, y, (p0[2] + p1[2]) * 0.5);
        mergeBufInto(b, gg);
        // diagonal to the next ring up
        if (k < 4) {
          const r2 = spread + (top - spread) * ((k + 1) / 5);
          const y2 = legH * ((k + 1) / 5);
          const q1 = [Math.cos(a1) * r2, y2, Math.sin(a1) * r2];
          const ddx = q1[0] - p0[0], ddy = q1[1] - p0[1], ddz = q1[2] - p0[2];
          const dh = Math.hypot(ddx, ddz);
          const dl = Math.hypot(ddy, dh);
          const g2 = new GeoBuf();
          chamferBox(0.07, dl, 0.07, 0.012, { buf: g2 });
          const gg2 = g2.toGeometry();
          gg2.rotateZ(-Math.atan2(dh, ddy));
          gg2.rotateY(-Math.atan2(ddz, ddx));
          gg2.translate((p0[0] + q1[0]) * 0.5, (p0[1] + q1[1]) * 0.5, (p0[2] + q1[2]) * 0.5);
          mergeBufInto(b, gg2);
        }
      }
    }
    B.add('rustMetal', b.toGeometry(), {
      matrix: mat(TX, 0, TZ, 0), bucket, uvScale: PROP_UV.steelFine,
      paint: weather({
        base: [0.94, 0.96, 0.92], rust: [1.02, 0.56, 0.30], rustAmount: 0.72,
        scale: 0.8, offset: [21, 0, 7], grimeHeight: 3.0, dirt: 0.45, streaks: 0.75,
      }),
    });
    // the tank itself: riveted cylinder with a conical roof and a skirt
    {
      const t = new GeoBuf();
      chamferCylinder(3.35, 5.0, 20, 0.10, { buf: t, center: [0, legH + 2.5, 0], sideSeg: 5 });
      for (const yy of [legH + 0.7, legH + 2.5, legH + 4.3]) {
        chamferCylinder(3.42, 0.16, 20, 0.04, { buf: t, center: [0, yy, 0], caps: false });
      }
      // conical cap
      for (let i = 0; i < 20; i++) {
        const a0 = (i / 20) * Math.PI * 2, a1 = ((i + 1) / 20) * Math.PI * 2;
        t.tri(
          [0, legH + 6.5, 0],
          [Math.cos(a0) * 3.4, legH + 5.0, Math.sin(a0) * 3.4],
          [Math.cos(a1) * 3.4, legH + 5.0, Math.sin(a1) * 3.4],
          [Math.cos((a0 + a1) / 2) * 0.42, 0.91, Math.sin((a0 + a1) / 2) * 0.42],
        );
      }
      // downpipe
      chamferCylinder(0.13, legH, 8, 0.02, { buf: t, center: [2.4, legH * 0.5, 0.6], sideSeg: 3 });
      B.add('rustMetal', t.toGeometry(), {
        matrix: mat(TX, 0, TZ, 0), bucket, uvScale: PROP_UV.steel,
        paint: weather({
          base: [1.00, 0.92, 0.80], rust: [1.04, 0.52, 0.26], rustAmount: 0.92,
          scale: 0.55, offset: [3, 0, 41], grimeHeight: 4.0, dirt: 0.4, streaks: 1.0,
          groundY: legH,
        }),
      });
      L.addProxy(TX, legH + 2.6, TZ, 6.8, 5.4, 6.8, 0, 'rustMetal');
    }
    // aircraft-warning lamp on the cap — a single saturated accent on the skyline
    L.addPracticalSpec(TX, legH + 6.9, TZ, 0xff3a20, 5, 8, { flicker: 0.9, flickerSpeed: 1.1 });
  }

  // ── invisible bounds: the player never walks out of the compound ──────
  L.addProxy(0, 12, -49, 120, 24, 2.0, 0, 'concrete');
  L.addProxy(0, 12, 49, 120, 24, 2.0, 0, 'concrete');
  L.addProxy(-39.5, 12, 0, 2.0, 24, 120, 0, 'concrete');
  L.addProxy(39.5, 12, 0, 2.0, 24, 120, 0, 'concrete');
}

/** Precast concrete boundary wall with panel joints, lean and missing sections. */
function boundaryWall(B, L, rng, x0, z0, x1, z1, h, material, ruined = false) {
  const bucket = 'perimeter';
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const ry = Math.atan2(dz, dx);
  const panel = 2.5;
  const n = Math.max(1, Math.round(len / panel));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const px = x0 + dx * t, pz = z0 + dz * t;
    const gone = ruined ? rng.chance(0.30) : rng.chance(0.06);
    if (gone) {
      for (let k = 0; k < 4; k++) {
        B.add('concrete', geoRubble(rng, rng.range(0.8, 1.8)), {
          matrix: mat(px + rng.j(1.6), rng.range(-0.05, 0.2), pz + rng.j(1.6), rng.range(0, 6.28), { rx: rng.j(0.4), rz: rng.j(0.4) }),
          bucket,
        });
      }
      continue;
    }
    const ph = ruined ? h * rng.range(0.45, 1.0) : h * rng.range(0.94, 1.0);
    const lean = ruined ? rng.j(0.09) : rng.j(0.015);
    B.add(material, chamferBox(panel * 0.97, ph, 0.24, 0.035, { center: [0, ph * 0.5, 0], seg: [2, Math.max(1, Math.round(ph / 1.6))] }), {
      matrix: mat(px, 0, pz, ry, { rz: lean }), bucket,
      paint: weatherConcrete({ base: [0.95, 0.93, 0.9], offset: [px, 0, pz], grimeHeight: 1.4, dirt: 0.5 }),
    });
    // pilaster
    B.add(material, chamferBox(0.3, ph + 0.1, 0.34, 0.03, { center: [0, (ph + 0.1) * 0.5, 0] }), {
      matrix: mat(px + Math.cos(ry) * panel * 0.5, 0, pz + Math.sin(ry) * panel * 0.5, ry), bucket,
      paint: weatherConcrete({ base: [0.92, 0.9, 0.87], offset: [px + 3, 0, pz], grimeHeight: 1.4, dirt: 0.5 }),
    });
    L.addProxy(px, ph * 0.5, pz, panel, ph, 0.3, ry, material);
  }
}

/* ─────────────────────────────── backdrop ─────────────────────────────── */

/**
 * Distant city. Pure silhouette — no punched facades, just chamfered masses with a
 * painted window grid, sitting under the sun's 8.7 degree line so the light stays
 * clear over the north-west.
 */
function backdrop(B, L, rng) {
  const bucket = 'backdrop';
  /**
   * Tone is the whole game out here. At 150 m the fog is ~72% opaque, so a distant block
   * is mostly *fog colour* — and if its own albedo sits near 1.0 it resolves brighter
   * than the sky behind it and reads as white cardboard, which is an instant fail. Held
   * down around 0.4 it stays a silhouette: darker than the sky and lifting toward it
   * with distance, which is what aerial perspective actually looks like.
   */
  /**
   * ── DEPTH BANDS ────────────────────────────────────────────────────────
   *
   * Everything out here used to take one continuous `0.34 - dist*0.0007` ramp,
   * and with fog on top the whole city resolved to a single value: the critics
   * read it as one cardboard cut-out with no separation between near and far.
   *
   * Three discrete bands instead, each with its own value AND its own height
   * ceiling, so the silhouette steps as well as the tone. The near band is the
   * only one dark enough to read as a solid mass; the far band is barely above
   * the fog and exists purely to give the horizon a second edge.
   */
  const bandOf = (dist) => (dist < 165 ? 0 : dist < 235 ? 1 : 2);
  const BAND_VALUE = [0.40, 0.255, 0.165];
  /** Windows are collected across the whole city and merged into one mesh. */
  const winBuf = new GeoBuf();

  const put = (x, z, w, d, h, mtl, dist) => {
    const g = new GeoBuf();
    const band = bandOf(dist);
    const dark = BAND_VALUE[band];
    const yaw = rng.range(-0.35, 0.35);
    /**
     * ── LOD BUDGET FOR THE SKYLINE ─────────────────────────────────────────
     *
     * Nothing out here is closer than 130 m and the fog is ~72 % opaque at that
     * range, so the only two things a backdrop block contributes are its
     * SILHOUETTE and a broad tonal wash. Three costs were being paid for
     * neither:
     *
     *  1. FACE SUBDIVISION AT 7 m. The subdivision exists to sample the `paint`
     *     callback, whose noise field has a 20 m feature size — so 7 m was
     *     oversampling a signal that cannot resolve below 20 m. A 34 m block was
     *     spending 600 triangles on six faces to carry a gradient. 14 m samples
     *     the same field at Nyquist and costs a quarter of that.
     *  2. THE UNDERSIDE. Every block stands on y = 0 and the camera never gets
     *     above 9 m, so the -y face is unreachable — and because `seg` applies
     *     to all six faces, it was the single most subdivided invisible surface
     *     in the map.
     *  3. CHAMFERS ON THE ROOF FURNITURE. A 0.12 m parapet chamfer at 200 m is
     *     a tenth of a pixel.
     *
     * The main mass keeps its 0.25 m chamfer: at 130 m that is still ~2 px of
     * intermediate-angle edge, and it is what stops the near band reading as a
     * cut-out. Everything stacked on top of it does not.
     */
    chamferBox(w, h, d, 0.25, {
      buf: g, center: [0, h * 0.5, 0], skip: { '-y': true },
      seg: [Math.max(2, Math.round(w / 20)), Math.max(2, Math.round(h / 20))],
    });
    // parapet + a stepped-back penthouse so the roofline is never one flat edge
    chamferBox(w + 0.5, 0.9, d + 0.5, 0.12, { buf: g, center: [0, h + 0.45, 0], plain: true });
    if (rng.chance(0.6)) {
      const pw = w * rng.range(0.3, 0.6), pd = d * rng.range(0.3, 0.6), ph = rng.range(2.5, 6.0);
      chamferBox(pw, ph, pd, 0.2, { buf: g, center: [rng.j(w * 0.22), h + 0.9 + ph * 0.5, rng.j(d * 0.22)], plain: true });
    }
    // roof clutter: tanks, plant rooms, aerials. This is what stops a skyline reading
    // as a bar chart.
    /**
     * ── ROOF CLUTTER MUST SIT ON THE ROOF ──────────────────────────────────
     *
     * These were centred at a FIXED height above the parapet (h+2.4, h+1.9)
     * regardless of how tall the object was, so anything under ~3 m floated with
     * a visible gap under it. On a block 200 m out whose body is hidden behind a
     * foreground wall, a floating tank is a few dark pixels of nothing in clear
     * sky — which is precisely the unattached quad the critics logged in the
     * spawn frame. Everything now beds onto the parapet at h + 0.9.
     */
    const ROOF = h + 0.88;
    for (let i = 0, n2 = rng.int(1, 3); i < n2; i++) {
      const k = rng.f();
      // 6 sides, not 8, and no chamfers: a 2 m tank at 130-300 m is 8 px wide,
      // where the 7th and 8th side of the cylinder land inside the same pixel
      // as the 6th. The silhouette is unchanged; only the tessellation is.
      if (k < 0.45) {
        const th = rng.range(2.0, 4.5);
        chamferCylinder(rng.range(1.0, 2.2), th, 6, 0.2, {
          buf: g, center: [rng.j(w * 0.35), ROOF + th * 0.5 - 0.12, rng.j(d * 0.35)],
        });
      } else if (k < 0.8) {
        const bh = rng.range(1.4, 3.0);
        chamferBox(rng.range(1.5, 3.5), bh, rng.range(1.5, 3.5), 0.12, {
          buf: g, center: [rng.j(w * 0.35), ROOF + bh * 0.5 - 0.12, rng.j(d * 0.35)], plain: true,
        });
      } else {
        const mh = rng.range(6, 13);
        chamferBox(0.35, mh, 0.35, 0.06, {
          buf: g, center: [rng.j(w * 0.4), ROOF + mh * 0.5 - 0.6, rng.j(d * 0.4)], plain: true,
        });
      }
    }
    /**
     * ── WINDOWS AS GEOMETRY, NOT AS VERTEX PAINT ───────────────────────────
     *
     * The window grid used to be evaluated inside `paint()`, which runs PER
     * VERTEX — and these boxes are segmented at one vertex every 7 m. A 3.4 m
     * floor pitch sampled every 7 m produces nothing at all, which is why the
     * critics measured "6-8 rectangular slabs with no windows".
     *
     * Real openings instead: a 1.9 x 1.5 m dark quad recessed 0.14 m into each
     * facade, on a 3.4 m floor / 2.9 m bay grid, merged across the whole city
     * into ONE mesh on the `windowDark` material. ~2 tris each, ~20 k for the
     * entire skyline, and it survives at any distance because it is real
     * silhouette-breaking geometry rather than a per-vertex approximation.
     */
    if (dist < 255) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      // Y rotation: world = (lx*c + lz*s, ly, -lx*s + lz*c)
      const toW = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
      const toN = (lx, lz) => [lx * c + lz * s, -lx * s + lz * c];
      const floors = Math.max(1, Math.floor((h - 3.4) / 3.4));
      for (const side of [0, 1, 2, 3]) {
        const nlx = side === 0 ? 1 : side === 1 ? -1 : 0;
        const nlz = side === 2 ? 1 : side === 3 ? -1 : 0;
        // 40 mm proud of the facade: the block is solid, so a recessed pane
        // would simply be inside it and invisible
        const half = (side < 2 ? w : d) * 0.5 + 0.04;
        const across = (side < 2 ? d : w) * 0.5 - 1.5;
        if (across < 1.2) continue;
        const bays = Math.max(1, Math.floor((across * 2) / 2.9));
        const [nx2, nz2] = toN(nlx, nlz);
        const ax2 = -nz2, az2 = nx2;
        const hw2 = 0.95, hh2 = 0.75;
        for (let fy = 0; fy < floors; fy++) {
          const wy = 3.0 + fy * 3.4;
          for (let bi = 0; bi < bays; bi++) {
            if (rng.chance(0.16)) continue;                 // boarded / bricked up
            const t = (bi - (bays - 1) * 0.5) * 2.9;
            const [wx, wz] = toW(nlx * half + (side < 2 ? 0 : t), nlz * half + (side < 2 ? t : 0));
            const c0 = winBuf.c.length;
            winBuf.quad(
              [wx - ax2 * hw2, wy - hh2, wz - az2 * hw2],
              [wx + ax2 * hw2, wy - hh2, wz + az2 * hw2],
              [wx - ax2 * hw2, wy + hh2, wz - az2 * hw2],
              [nx2, 0, nz2], 1, 1,
            );
            /**
             * ── PER-OPENING STATE ──────────────────────────────────────────
             * "Stamped, identical window rectangles in a perfect grid — no
             * variation between openings" was measurable: every quad in the
             * whole city shared one material and one vertex colour, so a facade
             * was a regular array of the same value. A per-window multiplier
             * costs nothing (it rides in the colour attribute of a mesh that is
             * already merged) and buys the thing that actually reads at 150 m —
             * an irregular pattern of dark, half-dark and boarded holes.
             */
            const roll = rng.f();
            const wk = roll < 0.14 ? rng.range(1.55, 2.30)      // boarded / bricked: lighter than the hole
              : roll < 0.30 ? rng.range(0.85, 1.25)             // partially blocked
                : rng.range(0.35, 0.72);                        // open, dark
            for (let vi = c0; vi < winBuf.c.length; vi += 3) {
              winBuf.c[vi] *= wk; winBuf.c[vi + 1] *= wk * 0.99; winBuf.c[vi + 2] *= wk * 0.97;
            }
            /**
             * A proud head band over one opening in three, built in the BLOCK'S
             * OWN local frame (the block matrix carries the yaw). At this range
             * a recess is invisible, but a 0.18 m lintel standing out of the
             * facade drops a real shadow line under itself at an 8.7 degree sun
             * — which is the single cue that makes a distant slab read as a
             * building with holes in it rather than as a printed panel.
             */
            // only on the near band, and only one opening in five: past ~200 m
            // the band is well under a pixel and is pure cost.
            if (dist < 200 && rng.chance(0.20)) {
              const lx = nlx * half + (side < 2 ? 0 : t);
              const lz = nlz * half + (side < 2 ? t : 0);
              chamferBox(side < 2 ? 0.34 : hw2 * 2.6, 0.18, side < 2 ? hw2 * 2.6 : 0.34, 0.04, {
                buf: g, center: [lx + nlx * 0.10, wy + hh2 + 0.17, lz + nlz * 0.10], plain: true,
              });
            }
          }
        }
      }
    }

    /**
     * Emitted LAST, because the window loop above folds proud head bands back
     * into the block's own buffer. `toGeometry()` snapshots the accumulator, so
     * anything pushed after this call is silently dropped.
     */
    B.add(mtl, g.toGeometry(), {
      matrix: mat(x, 0, z, yaw), bucket, shadow: false,
      // 130-300 m out: a real 78 mm brick course is far under a pixel and would
      // alias into a crawling moire. The backdrop wants texture as tone, not as
      // masonry, so it keeps a deliberately coarse 2.5 m tile.
      uvScale: 0.4,
      paint: (px, py, pz, nx, ny, nz, out) => {
        const k = dark * (0.80 + fbm3(px * 0.05, py * 0.05, pz * 0.05, 3) * 0.52);
        out[0] = k; out[1] = k * 0.98; out[2] = k * 0.96;
      },
    });
  };

  const sunAz = 118 * D2R;
  const sunDirX = Math.cos(sunAz), sunDirZ = Math.sin(sunAz);

  for (let i = 0; i < 62; i++) {
    const a = rng.range(0, Math.PI * 2);
    // Pushed out from 95 m to 130 m minimum. Closer than that, a distant block is only
    // ~60% fogged: it keeps a hard silhouette but has lost all internal contrast, so it
    // reads as a white card pasted on the haze. Past 130 m the fog dissolves the edge
    // too and it behaves like real aerial perspective.
    const r = rng.range(130, 300);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    // how aligned is this direction with the sun?
    const align = (Math.cos(a) * sunDirX + Math.sin(a) * sunDirZ);
    // sun clearance: nothing may exceed 0.153 * r along the sun bearing
    let hMax = 34;
    if (align > 0.86) hMax = Math.min(hMax, r * 0.115);
    else if (align > 0.66) hMax = Math.min(hMax, r * 0.16);
    /**
     * One block in six is a genuine tower. A skyline where every mass tops out
     * between 9 and 34 m has no rhythm — the critics called it a bar chart with
     * all the bars the same height — and the sun-clearance rule above already
     * guarantees the tall ones cannot get in front of the key.
     */
    const tall = rng.chance(0.17) && align < 0.5;
    const h = Math.min(hMax, tall ? rng.range(38, 72) : rng.range(9, 30));
    if (h < 4) continue;
    put(x, z, rng.range(14, 34), rng.range(14, 32), h, rng.chance(0.5) ? 'plaster' : 'brick', r);
  }

  /**
   * ── SKYLINE BREAKERS ───────────────────────────────────────────────────
   * Gantry cranes and lattice masts. Four of them, all off the sun bearing, all
   * taller than the block they stand behind, so the roofline is crossed by
   * something that is not another rectangle.
   */
  for (const [cx2, cz2, ch, cboom, cflip] of [
    [-118, 96, 44, 34, 1], [88, 132, 38, 28, -1], [-172, 22, 52, 40, 1], [58, -196, 34, 26, -1],
  ]) {
    const g = new GeoBuf();
    const leg = 1.5;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        chamferBox(0.9, ch, 0.9, 0.12, { buf: g, center: [sx * leg, ch * 0.5, sz * leg], plain: true });
      }
    }
    for (let y = 6; y < ch; y += 6) {
      chamferBox(leg * 2 + 0.9, 0.6, 0.6, 0.08, { buf: g, center: [0, y, -leg], plain: true });
      chamferBox(leg * 2 + 0.9, 0.6, 0.6, 0.08, { buf: g, center: [0, y, leg], plain: true });
    }
    /**
     * ── THE JIB IS A TRUSS, NOT A PLANK ────────────────────────────────────
     *
     * This was `chamferBox(cboom, 1.5, 1.6)` — a solid beam — and the critics
     * read it exactly right: "a flat, uniform beige silhouette with essentially
     * zero tonal variation across the jib … a tower crane jib is an open lattice
     * you see sky through; this one reads as a 2D cutout pasted on the horizon."
     *
     * At 100-200 m the only thing that matters is that SKY GETS THROUGH, and
     * that needs nothing more than four chords and a run of diagonals. ~180
     * triangles per crane, four cranes, and it is the difference between a
     * silhouette that reads as a machine and one that reads as a rectangle.
     * The chords are also split top/bottom so the two catch the low sun
     * differently instead of resolving to one flat value.
     */
    const jib = (x0, x1, yTop, hTop, hBot, chordS) => {
      const dir = Math.sign(x1 - x0) || 1;
      const span = Math.abs(x1 - x0);
      const n = Math.max(3, Math.round(span / 3.2));
      const seg = span / n;
      const hw = 0.85;
      for (const sz of [-1, 1]) {
        // top chord and bottom chord: separate members, so they shade separately
        chamferBox(span, chordS, chordS, chordS * 0.22, { buf: g, center: [(x0 + x1) * 0.5, yTop, sz * hw], plain: true });
        chamferBox(span, chordS * 0.9, chordS * 0.9, chordS * 0.2, {
          buf: g, center: [(x0 + x1) * 0.5, yTop - hTop, sz * hw], plain: true,
        });
      }
      for (let i = 0; i <= n; i++) {
        const px = x0 + dir * i * seg;
        // vertical posts
        for (const sz of [-1, 1]) {
          chamferBox(chordS * 0.7, hTop, chordS * 0.7, chordS * 0.16, { buf: g, center: [px, yTop - hTop * 0.5, sz * hw], plain: true });
        }
        // transverse ties top and bottom
        chamferBox(chordS * 0.7, chordS * 0.7, hw * 2, chordS * 0.16, { buf: g, center: [px, yTop, 0], plain: true });
        if (i >= n) continue;
        // K-lacing on both vertical faces
        const dl = Math.hypot(seg, hTop);
        for (const sz of [-1, 1]) {
          const b2 = new GeoBuf();
          chamferBox(dl, chordS * 0.55, chordS * 0.55, chordS * 0.14, { buf: b2, plain: true });
          const gg = b2.toGeometry();
          gg.rotateZ((i % 2 ? 1 : -1) * Math.atan2(hTop, seg) * dir);
          gg.translate(px + dir * seg * 0.5, yTop - hTop * 0.5, sz * hw);
          mergeBufInto(g, gg);
        }
      }
      void hBot;
    };
    // jib and counter-jib, both open trusses
    jib(cflip * 2.2, cflip * cboom * 0.92, ch + 1.9, 1.9, 1.4, 0.30);
    jib(-cflip * 2.0, -cflip * cboom * 0.34, ch + 2.2, 2.4, 1.8, 0.36);
    // counterweight slab on the tail of the counter-jib
    chamferBox(cboom * 0.10, 2.2, 2.4, 0.12, { buf: g, center: [-cflip * cboom * 0.30, ch + 1.4, 0], plain: true });
    // slew ring and operator cab
    chamferBox(2.6, 1.0, 2.6, 0.10, { buf: g, center: [0, ch + 0.5, 0], plain: true });
    chamferBox(1.7, 1.9, 1.8, 0.14, { buf: g, center: [cflip * 1.9, ch + 1.6, 0], plain: true });
    // tie bars back to a short A-frame
    chamferBox(0.5, 7.0, 0.5, 0.08, { buf: g, center: [0, ch + 5.0, 0], plain: true });
    for (const [tx, ty] of [[cflip * cboom * 0.55, ch + 2.6], [-cflip * cboom * 0.28, ch + 2.8]]) {
      const dxT = tx - 0, dyT = ty - (ch + 8.2);
      const lT = Math.hypot(dxT, dyT);
      const b3 = new GeoBuf();
      chamferBox(lT, 0.24, 0.24, 0.05, { buf: b3, plain: true });
      const gg = b3.toGeometry();
      gg.rotateZ(Math.atan2(dyT, dxT));
      gg.translate(tx * 0.5, (ty + ch + 8.2) * 0.5, 0);
      mergeBufInto(g, gg);
    }
    B.add('rustMetal', g.toGeometry(), {
      matrix: mat(cx2, 0, cz2, rng.range(0, 6.28)), bucket, shadow: false, uvScale: 0.5,
      /**
       * Break the uniform tone. A single value across every face is what made
       * the jib read as a cutout: top faces of a lattice catch the sky and the
       * low sun, undersides sit in their own shadow, and the two must not
       * resolve to the same number. Roughly a 2:1 spread top to bottom.
       */
      paint: (px, py, pz, nx, ny, nz, out) => {
        let k = 0.28 + fbm3(px * 0.05, py * 0.05, pz * 0.05, 3) * 0.22;
        k *= 1 + Math.max(0, ny) * 0.55 - Math.max(0, -ny) * 0.34;
        out[0] = k * 1.06; out[1] = k * 0.96; out[2] = k * 0.88;
      },
    });
  }

  // a far cooling tower and two chimneys for skyline interest, kept off the sun line
  for (const [bx, bz, bh, br] of [[-150, -120, 42, 9], [120, -170, 34, 5], [175, 60, 30, 4.5]]) {
    const b = new GeoBuf();
    const segs = 6, n = 16;
    for (let i = 0; i < segs; i++) {
      const y0 = (i / segs) * bh, y1 = ((i + 1) / segs) * bh;
      const w0 = br * (1 - 0.45 * Math.sin((y0 / bh) * Math.PI * 0.8));
      const w1 = br * (1 - 0.45 * Math.sin((y1 / bh) * Math.PI * 0.8));
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
        b.quad(
          [Math.cos(a0) * w0, y0, Math.sin(a0) * w0],
          [Math.cos(a1) * w0, y0, Math.sin(a1) * w0],
          [Math.cos(a0) * w1, y1, Math.sin(a0) * w1],
          [Math.cos((a0 + a1) / 2), 0.1, Math.sin((a0 + a1) / 2)], 1, 1,
        );
      }
    }
    /**
     * `plaster`, not `concrete`. These three towers are 150-175 m out behind
     * ~72 % fog and their `paint` callback overwrites the albedo outright, so
     * the only thing the recipe still contributes is a noise pattern far below
     * a pixel. Naming the material `concrete` bought nothing and cost a whole
     * extra scene object (three draws a frame) because no other non-casting
     * concrete exists; on `plaster` they join the backdrop mesh for free.
     */
    B.add('plaster', b.toGeometry(), {
      matrix: mat(bx, 0, bz, 0), bucket, shadow: false, uvScale: 0.4,
      paint: (px, py, pz, nx, ny, nz, out) => {
        const k = 0.34 + fbm3(px * 0.04, py * 0.04, pz * 0.04, 3) * 0.24;
        out[0] = k; out[1] = k * 0.98; out[2] = k * 0.95;
      },
    });
  }

  // one merged mesh for every window in the city
  if (!winBuf.isEmpty) {
    B.add('windowDark', winBuf.toGeometry(), { bucket, shadow: false, uvScale: 0.5 });
  }
}

/* ───────────────────────────── chain-link ─────────────────────────────── */

function fences(B, L, rng) {
  const bucket = 'fence';
  const run = (x0, z0, x1, z1, h = 2.4, gapChance = 0.16) => {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const ry = Math.atan2(dz, dx);
    const bay = 3.0;
    const n = Math.max(1, Math.round(len / bay));
    const postBuf = new GeoBuf();
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const px = x0 + dx * t, pz = z0 + dz * t;
      const lean = rng.j(0.05);
      const g = chamferCylinder(0.045, h + 0.12, 8, 0.012, { center: [0, (h + 0.12) * 0.5, 0] });
      g.applyMatrix4(mat(px, 0, pz, 0, { rz: lean }));
      mergeBufInto(postBuf, g);
    }
    // top rail
    {
      const g = chamferCylinder(0.032, len, 8, 0.01, { sideSeg: Math.max(2, Math.round(len / 3)) });
      g.rotateZ(Math.PI / 2);
      g.rotateY(-ry);
      g.translate((x0 + x1) * 0.5, h, (z0 + z1) * 0.5);
      mergeBufInto(postBuf, g);
    }
    B.add('rustMetal', postBuf.toGeometry(), {
      bucket, uvScale: PROP_UV.steelFine,
      paint: weather({ base: [1.04, 1.04, 1.02], rust: [1.00, 0.74, 0.56], rustAmount: 0.32, scale: 0.9, offset: [x0, 0, z0], grimeHeight: 0.6, dirt: 0.5, streaks: 0.7 }),
    });

    for (let i = 0; i < n; i++) {
      if (rng.chance(gapChance)) continue;
      const t0 = i / n, t1 = (i + 1) / n;
      const mx = x0 + dx * (t0 + t1) * 0.5, mz = z0 + dz * (t0 + t1) * 0.5;
      const bw = len / n;
      const sag = rng.range(0, 0.16);
      const g = new GeoBuf();
      g.quad([-bw * 0.5, 0.06, 0], [bw * 0.5, 0.06, 0], [-bw * 0.5, h - sag, sag * 0.7], [0, 0, 1], 1, 1);
      B.add('chainlink', g.toGeometry(), {
        matrix: mat(mx, 0, mz, ry), bucket, shadow: true,
        uvScale: 2.0,          // 16 diamonds/m — a real 60 mm chain-link gauge
        tint: [rng.range(0.8, 1.05), rng.range(0.8, 1.05), rng.range(0.82, 1.05)],
      });
      L.addProxy(mx, h * 0.5, mz, bw, h, 0.1, ry, 'rustMetal');
    }
  };

  run(12.6, -40, 12.6, -18);
  run(12.6, -14, 12.6, 6.5);
  run(12.6, 10, 12.6, 30, 2.4, 0.28);
  run(-12.6, 14, -12.6, 40, 2.4, 0.22);
  run(-12.6, 40, 10, 42, 2.4, 0.3);
  run(14, -42, 34, -42, 2.4, 0.25);
}

/* ─────────────────────── instanced scatter dressing ───────────────────── */

function scatter(B, L, rng) {
  // ── drums ──────────────────────────────────────────────────────────────
  const drumSpots = [
    [-10.2, -12.5], [-10.9, -13.4], [-10.0, -14.2], [-11.4, -12.2],
    [6.8, 3.5], [7.6, 3.0], [7.2, 4.3], [6.2, 2.6],
    [-2.5, -35.0], [-3.4, -35.6],
    [15.5, -8.0], [16.3, -8.6], [15.0, -9.2],
    [30.0, 14.0], [30.9, 14.6], [31.2, 13.4],
    [-27.0, -3.5], [-26.2, -4.2], [-28.0, -4.0], [-27.4, -5.1],
    [-19.5, -12.0], [-20.4, -12.6],
    [9.0, 28.0], [9.9, 28.7], [8.4, 29.0],
    [-6.5, 21.0], [-7.4, 21.6],
    [22.0, -35.0], [22.9, -35.5],
    [-31.0, 12.0], [-30.2, 12.7], [-31.6, 13.1],
    [12.0, -30.0], [11.2, -30.7],
    [34.0, -2.0], [33.2, -2.8],
  ];
  L.instance('rustMetal', geoDrum(rng), drumSpots.map(([x, z]) => ({
    x, y: 0, z, ry: rng.range(0, 6.28), rz: rng.chance(0.12) ? Math.PI / 2 : 0,
    tint: [rng.range(0.82, 1.16), rng.range(0.82, 1.14), rng.range(0.8, 1.12)],
  })), { collide: [0.62, 0.9, 0.62], uvScale: 3.4 });

  // ── pallets ────────────────────────────────────────────────────────────
  const palletSpots = [];
  for (let i = 0; i < 26; i++) {
    const pick = rng.int(0, 5);
    const zones = [
      [-30, -18, -18, -2], [-9, -6, -18, 6], [14, 32, -32, 6],
      [-8, 8, 10, 34], [16, 32, 10, 32], [-4, 8, -38, -28],
    ];
    const [ax, bx, az, bz] = zones[pick];
    palletSpots.push({
      x: rng.range(ax, bx), y: rng.chance(0.25) ? 0.14 : 0, z: rng.range(az, bz),
      ry: rng.range(0, 6.28), rx: rng.chance(0.15) ? rng.range(0.2, 1.3) : 0,
      tint: [rng.range(0.8, 1.15), rng.range(0.8, 1.1), rng.range(0.78, 1.08)],
    });
  }
  L.instance('wood', geoPallet(rng), palletSpots, { uvScale: 2.6, contact: 0.62, contactStrength: 0.30 });

  // ── tyres ──────────────────────────────────────────────────────────────
  const tyreSpots = [];
  for (let i = 0; i < 22; i++) {
    tyreSpots.push({
      x: rng.range(-34, 34), y: 0, z: rng.range(-40, 40),
      ry: rng.range(0, 6.28), rz: rng.chance(0.3) ? Math.PI / 2 : 0,
      tint: [rng.range(0.75, 1.1), rng.range(0.75, 1.1), rng.range(0.78, 1.1)],
    });
  }
  // keep them out of the warehouse floor and off the perimeter
  const keep = tyreSpots.filter((s) => !(s.x < -12 && s.z > -22 && s.z < 8));
  L.instance('rubber', geoTyre(rng), keep, { contact: 0.5, contactStrength: 0.38 });

  // ── crates ─────────────────────────────────────────────────────────────
  const crateSpots = [];
  for (let i = 0; i < 20; i++) {
    const zones = [[-32, -18, -19, -12], [14, 31, -30, 4], [-9, 8, 12, 32], [16, 30, 14, 30]];
    const [ax, bx, az, bz] = zones[rng.int(0, 3)];
    crateSpots.push({
      x: rng.range(ax, bx), y: 0, z: rng.range(az, bz), ry: rng.range(0, 6.28),
      tint: [rng.range(0.78, 1.18), rng.range(0.78, 1.12), rng.range(0.76, 1.06)],
    });
  }
  // 1.5, not 2.2: the crate is now built from separate boards that each carry
  // their own grain phase, so the density can come down to the one the wood
  // recipe was authored for without the face going flat.
  L.instance('wood', geoCrate(rng), crateSpots, { collide: [0.95, 0.75, 0.85], bucket: 'crate', uvScale: 1.5 });

  /**
   * ── CABLE SPOOLS ───────────────────────────────────────────────────────
   *
   * `uvScale` was 2.0 — four wood tiles across a 1.5 m flange face — and the
   * critics photographed the recipe's dark bowtie motif repeating in a legible
   * 4x4 grid at the exact centre of the closeup composition. 0.78 puts a single
   * tile across the whole drum, which is the density the recipe was authored
   * for. `geoSpool` also now gives every board its own grain phase, so even at
   * this density two adjacent planks cannot show the same motif.
   *
   * They also mark their own contact ring: a reel resting on two rims touches
   * the slab on two short arcs, and the dust wedge between them is what stops it
   * looking parked on the floor.
   */
  const spoolSpots = [
    { x: -10.5, y: 0, z: 4.0, ry: 0.4 },
    { x: 17.0, y: 0, z: 4.5, ry: 1.9 },
    { x: -25.0, y: 0, z: 9.5, ry: 2.6 },
    { x: 27.5, y: 0, z: 24.0, ry: 0.9 },
    { x: 1.5, y: 0, z: -12.0, ry: 5.1 },
  ];
  L.instance('wood', geoSpool(rng), spoolSpots, { collide: [1.55, 1.5, 1.0], bucket: 'spool', uvScale: 0.78 });
  for (const s of spoolSpots) {
    L.markContact(s.x, s.z, 0.72, 0.46, s.ry, 0.52, 0.72);
    L.markDust(s.x, s.z, 1.25, 0.42);
  }

  /**
   * ── RUBBLE: AUTHORED PILES, NOT A SCATTER FIELD ────────────────────────
   *
   * The shipped version threw 420 chunks at uniform random across the whole
   * compound with a 45 % edge bias. That produces exactly what the critics saw:
   * five near-identical 1.5 m hulls evenly spaced across an otherwise empty yard,
   * and a near-regular row of small identical cuboids. Real urban rubble does two
   * things that uniform scatter cannot:
   *
   *  1. It COLLECTS. Masonry falls off a wall and stays at the foot of that wall,
   *     under the blast hole that made it, or where a loader pushed it. The open
   *     middle of a yard is swept, because vehicles have to drive through it.
   *  2. It is a POWER-LAW SIZE DISTRIBUTION. Hundreds of 5-15 cm chips, dozens of
   *     30 cm lumps, a handful of 60 cm slabs — never one modal size.
   *
   * So this is a cluster generator: authored pile centres with a radius and a
   * mass, chunks placed with a `r^1.7` radial density so the pile has a dense
   * core and a thinning apron, and sizes drawn from `min * (1-u)^2.4` so small
   * chunks dominate. Every pile also stamps a dust ring into the ground mask, so
   * it emerges from the ground instead of sitting on it.
   */
  const rubbleSpots = [];
  const bits = [];
  const rubbleGeo = geoRubble(rng, 1.0);
  const bitGeo = geoRubble(rng, 0.42);

  /** @param {number} x,z centre  @param {number} rad apron radius  @param {number} mass 0..2 */
  const rubblePile = (x, z, rad, mass, opts = {}) => {
    const nBig = Math.round(mass * 5);
    const nMid = Math.round(mass * 16);
    const nChip = Math.round(mass * 34);
    const drop = (n, sMin, sMax, arr, big) => {
      for (let i = 0; i < n; i++) {
        // r^1.7 keeps the core dense and thins the apron
        const rr = rad * Math.pow(rng.f(), 0.59);
        const a = rng.range(0, 6.28);
        const px = x + Math.cos(a) * rr * (opts.stretch ?? 1);
        const pz = z + Math.sin(a) * rr;
        // the pile has a height profile — chunks near the centre ride up on each other
        const heap = (opts.heap ?? 0.55) * mass * Math.max(0, 1 - rr / rad) ** 1.8;
        // power-law size: small dominates
        const sc = sMin + (sMax - sMin) * Math.pow(1 - rng.f(), 2.4);
        arr.push({
          x: px, y: heap + rng.range(-0.07, 0.05), z: pz,
          ry: rng.range(0, 6.28), rx: rng.j(0.55), rz: rng.j(0.55), scale: sc,
          tint: big
            ? [rng.range(0.66, 1.06), rng.range(0.66, 1.02), rng.range(0.64, 0.96)]
            : [rng.range(0.62, 0.98), rng.range(0.56, 0.90), rng.range(0.52, 0.86)],
        });
      }
    };
    drop(nBig, 0.85, 1.75, rubbleSpots, true);
    drop(nMid, 0.40, 0.95, rubbleSpots, true);
    drop(nChip, 0.35, 1.05, bits, false);
    L.markContact(x, z, rad * 0.55, rad * 0.55, 0, 0.34, rad * 0.8);
  };

  /**
   * Pile sites. Every one of these has a REASON: the foot of a wall that shed it,
   * the base of a blast hole, the collapsed warehouse corner, or a spoil heap a
   * loader pushed against a fence. Nothing sits alone in the middle of the yard.
   */
  const piles = [
    // warehouse: the collapsed north-west corner and the blown-out east wall
    [-31.5, 6.5, 5.5, 1.8, { heap: 0.9 }], [-25.0, 8.0, 4.6, 1.3, { heap: 0.7 }],
    [-13.6, -15.5, 3.0, 0.9], [-12.8, 2.0, 2.6, 0.7],
    // against the perimeter blocks, south run
    [-24.0, -42.0, 5.0, 1.2, { stretch: 1.8 }], [-4.0, -43.5, 4.4, 1.0, { stretch: 1.9 }],
    [18.0, -42.0, 4.8, 1.1, { stretch: 1.8 }], [33.0, -44.0, 3.6, 0.8],
    // east works wall
    [36.5, -20.0, 3.4, 0.9, { stretch: 0.6 }], [36.8, 12.0, 3.2, 0.8, { stretch: 0.55 }],
    // north-west collapsed boundary — this is the sun gap, so the pile silhouettes
    [-33.0, 44.5, 5.2, 1.3, { stretch: 1.7 }], [-8.0, 45.0, 4.2, 1.0, { stretch: 1.8 }],
    [-36.0, 20.0, 3.4, 0.9, { stretch: 0.55 }],
    // north-east blocks
    [16.0, 44.0, 4.0, 1.0, { stretch: 1.7 }], [30.0, 42.0, 3.4, 0.8],
    // spoil pushed against the two chain-link lines
    [12.9, -22.0, 2.4, 0.6, { stretch: 0.5 }], [12.9, 12.0, 2.2, 0.55, { stretch: 0.5 }],
    [-12.9, 24.0, 2.4, 0.6, { stretch: 0.5 }],
    // working piles in the yard, each tucked against something
    [-9.6, -20.5, 2.2, 0.5], [10.8, 22.6, 2.4, 0.55], [21.5, 21.0, 2.6, 0.6],
    [-6.2, 26.5, 2.0, 0.45], [4.5, -24.5, 2.2, 0.5],
    [-44.0, -30.5, 3.0, 0.7],                                  // foot of the chimney
    [34.2, 30.5, 3.2, 0.75],                                   // foot of the water tower
  ];
  for (const [px, pz, rad, mass, o2] of piles) rubblePile(px, pz, rad, mass, o2 || {});

  /**
   * A thin residue of loose chips over the traffic lanes — enough to break the
   * paving, far too little to read as scatter. Deliberately excluded from the
   * swept centre of the yard: the open floor has to read as traversable space.
   */
  for (let i = 0; i < 170; i++) {
    const x = rng.range(-36, 36), z = rng.range(-45, 45);
    if (Math.abs(x) < 6.5 && Math.abs(z) < 34) continue;       // the swept lane
    bits.push({
      x, y: rng.range(-0.05, 0.02), z,
      ry: rng.range(0, 6.28), rx: rng.j(0.6), rz: rng.j(0.6), scale: rng.range(0.3, 0.8),
      tint: [rng.range(0.62, 0.98), rng.range(0.56, 0.90), rng.range(0.52, 0.86)],
    });
  }

  /**
    * Cull distances are derived from the prop, not picked: a lump of masonry
    * between 0.4 m and 1.75 m across still reads as an object at 70 m, so that
    * is where it goes; its cast shadow stops resolving in the cascades at about
    * 30 m (the 8.7-degree sun plus the normal-offset bias), so that is where it
    * stops being submitted to them.
    */
  L.instance('concrete', rubbleGeo, rubbleSpots, {
    shadow: true, contact: 0.55, contactStrength: 0.22, cullDist: 70, shadowDist: 30,
  });
  /**
   * ── GROUND-LEVEL SCATTER MUST CAST ─────────────────────────────────────
   *
   * 872 masonry chips lying in open sun, throwing nothing, while the column
   * beside them threw a hard 15 m shadow. That contrast is what makes a scatter
   * field read as a decal sheet rather than as debris on a floor — the small
   * objects sitting directly on the ground carry ALL of the grounding
   * information in a frame, and switching them off was the single largest
   * remaining defect in the level.
   *
   * `contact` is on as well as `shadow`, because at 8.7 degrees of solar
   * elevation the cascade normal-offset bias erases the cast shadow of anything
   * under ~0.4 m past about 22 m (see `GroundMask.shadowSmear`). The shadow map
   * carries the near field and the baked mask carries the far field; between
   * them nothing in the yard is left floating.
   */
  L.instance('brick', bitGeo, bits, {
    shadow: true, uvScale: 2.6, contact: 0.24, contactStrength: 0.30,
    // 15-44 cm chips: two pixels at 48 m, and their shadows are already being
    // carried by the baked mask rather than the cascades past ~22 m.
    cullDist: 48, shadowDist: 24,
  });

  // loose boards and offcuts — angular, man-made litter to contrast the rubble
  const boards = [];
  // 45 mm, not 35: a scaffold board seen at 8 m has to have a readable edge, and
  // the critics measured "effectively zero thickness — reads as a decal".
  const boardGeo = chamferBox(1.5, 0.045, 0.18, 0.007, { center: [0, 0.023, 0] });
  (() => {
    const g = boardGeo;
    const pnt = weather({
      base: [0.92, 0.86, 0.74], rustAmount: 0.2, scale: 2.4,
      grimeHeight: 0.1, dirt: 0.35, streaks: 0.3,
    });
    const arr = g.attributes.position.array, na = g.attributes.normal.array;
    const out = [1, 1, 1];
    const col = g.attributes.color.array;
    for (let i = 0; i < g.attributes.position.count; i++) {
      out[0] = 1; out[1] = 1; out[2] = 1;
      pnt(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2], na[i * 3], na[i * 3 + 1], na[i * 3 + 2], out);
      col[i * 3] = out[0]; col[i * 3 + 1] = out[1]; col[i * 3 + 2] = out[2];
    }
    g.attributes.color.needsUpdate = true;
  })();
  for (let i = 0; i < 190; i++) {
    const bx0 = rng.range(-34, 34), bz0 = rng.range(-42, 42);
    // the swept lane keeps a THIN residue rather than none: a 15 m run of open
    // concrete with two decal-flat planks in it was the emptiest band in the map
    if (Math.abs(bx0) < 5.5 && Math.abs(bz0) < 32 && !rng.chance(0.22)) continue;
    boards.push({
      x: bx0, y: rng.range(0.005, 0.05), z: bz0,
      ry: rng.range(0, 6.28), rz: rng.j(0.10), rx: rng.j(0.06),
      scale: rng.range(0.6, 1.35),
      tint: [rng.range(0.72, 1.15), rng.range(0.7, 1.05), rng.range(0.62, 0.95)],
    });
  }
  /**
   * Boards CAST now. They were `shadow: false`, and a 1.5 m plank lying in open
   * sun with no shadow at all is exactly why the critics read them as decals
   * painted on the floor rather than as timber lying on it.
   */
  L.instance('wood', boardGeo, boards, {
    shadow: true, contact: 0.42, contactStrength: 0.24, cullDist: 58, shadowDist: 30,
  });

  /**
   * ── SUB-30 cm SCATTER ──────────────────────────────────────────────────
   *
   * The single largest remaining hole in the midground was that there was
   * nothing at all between the 40 cm rubble chips and the 2 m props. A working
   * industrial yard has hundreds of small objects per bay, and they are not
   * uniformly distributed: they collect at the foot of anything vertical (wind,
   * sweeping, and the fact that things get put down against walls) and thin out
   * across the middle where vehicles drive.
   *
   * So: every ground-standing collision proxy under 8 m across becomes an
   * ANCHOR, and 70 % of the scatter is placed in a ring just outside its
   * footprint. The rest is a thin uniform field. Five instanced sets, five draw
   * calls, ~2 400 objects.
   */
  const anchors = [];
  for (const c of L.collidables) {
    const s = c.scale, p = c.position;
    if (p.y - s.y * 0.5 > 0.6) continue;                   // airborne
    if (s.y < 0.5) continue;                               // decks, ramps, lips
    if (s.x > 8 || s.z > 8) continue;                      // the ground plane, long walls
    if (Math.hypot(p.x, p.z) > 46) continue;
    anchors.push([p.x, p.z, Math.max(s.x, s.z) * 0.5]);
  }
  /**
   * THREE sets, not five, and every geometry under 25 triangles.
   *
   * Measured cost of the first attempt (five sets, 44-96 tris each, 2 400
   * objects): 1.08 M rendered triangles and 50 draw calls per frame, which took
   * the closeup framing from 71 fps to 37. Sub-pixel triangles are the most
   * expensive thing a GPU can be asked to rasterise. Same visual density, an
   * eighth of the cost.
   */
  const stones = L.pebbleSpill ?? [];      // the paving-edge spill, folded in here
  const card = [], bars = [];
  const place = (arr, x, z, sMin, sMax, lift = 0.0) => {
    arr.push({
      x, y: lift + rng.range(-0.012, 0.012), z,
      ry: rng.range(0, 6.28), rx: rng.j(0.5), rz: rng.j(0.5),
      scale: rng.range(sMin, sMax),
      tint: [rng.range(0.68, 1.14), rng.range(0.66, 1.06), rng.range(0.62, 0.98)],
    });
  };
  const pick = () => {
    const r = rng.f();
    if (r < 0.84) return stones;
    if (r < 0.93) return card;
    return bars;
  };
  // (a) collected against anything vertical
  for (const [ax, az, rad] of anchors) {
    const n = Math.min(9, Math.round(2 + rad * 2.4));
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, 6.28);
      const d = rad + rng.range(0.05, 1.5) * Math.pow(rng.f(), 0.5);
      const px = ax + Math.cos(a) * d, pz = az + Math.sin(a) * d;
      if (Math.abs(px) > 37 || Math.abs(pz) > 46) continue;
      place(pick(), px, pz, 0.8, 2.0);
    }
  }
  // (b) a thin field everywhere, INCLUDING the swept lane
  for (let i = 0; i < 330; i++) {
    const px = rng.range(-36, 36), pz = rng.range(-45, 45);
    const lane = Math.abs(px) < 6.5 && Math.abs(pz) < 34;
    if (lane && !rng.chance(0.55)) continue;
    place(pick(), px, pz, 0.8, 2.0);
  }
  /**
   * The pebble field stays out of the shadow pass — 1 196 objects at 8-20 cm are
   * below the cascade's texel footprint at any range past the first few metres,
   * so they would cost four extra depth draws and 57 k shadow triangles to
   * produce nothing. They get the baked contact term instead, which is what
   * actually reads: a stone sitting in a shallow dark socket in the dust.
   *
   * The card and bar litter DO cast — a 0.5 m sheet of cardboard and a 1.1 m
   * rebar offcut are both well inside what the near cascade resolves, and both
   * were sitting in full sun projecting nothing.
   */
  L.instance('gravel', geoPebble(rng), stones, {
    bucket: 'scat', uvScale: 5.5, shadow: false, contact: 0.13, contactStrength: 0.34,
    // The brief's own example: a 4 cm pebble contributes nothing at 40 m. These
    // run 8-20 cm, so 30 m is the equivalent cutoff. They never cast anyway —
    // the baked contact socket in the ground mask is what reads at any range.
    cullDist: 30,
  });
  L.instance('wood', geoLitter(rng, 1), card, {
    bucket: 'scat', uvScale: 3.2, shadow: true, contact: 0.26, contactStrength: 0.26,
    cullDist: 42, shadowDist: 26,
  });
  L.instance('rustMetal', geoLitter(rng, 2), bars, {
    bucket: 'scat', uvScale: 3.0, shadow: true, contact: 0.30, contactStrength: 0.24,
    cullDist: 45, shadowDist: 28,
  });
}

/* ────────────────────────────── spawn points ──────────────────────────── */

function spawns(L) {
  const P = (x, y, z, yaw, tag) => L.addSpawn(x, y, z, yaw, tag);
  P(-27.0, 0.08, -17.0, Math.PI, 'warehouse-south');       // looks north up the interior
  P(-28.0, 0.08, -2.5, 2.6, 'warehouse-collapse');   // clear of the collapse rubble mound
  P(-19.5, 0.08, -9.0, Math.PI, 'warehouse-floor');
  P(-28.0, 4.85, -15.0, Math.PI, 'mezzanine');
  // north end of the catwalk: from here the long axis of the shed runs south and the
  // collapsed corner opens north, so the player's longest-sightline sweep has somewhere
  // worth pointing. Mid-catwalk put a wall 7 m off the nose.
  P(-20.0, 8.45, 3.2, Math.PI, 'catwalk');
  P(9.5, 0.06, -30.0, Math.PI, 'lane-south');
  P(-3.0, 0.06, 36.0, 0.0, 'lane-north');
  P(6.5, 0.06, -3.0, Math.PI, 'lane-mid');
  P(-8.0, 0.06, 14.0, 2.6, 'lane-west');
  // east-south / east-north used to sit 0.25–0.27 m from a container wall — inside
  // the 0.34 m player capsule radius, so the character controller had to resolve a
  // penetration on the very first step (a visible shove, and on a bad frame a stall
  // against the corner). Probed the collision world and moved both to the nearest
  // point with >1.4 m of clearance in all sixteen directions and open sky above.
  P(20.0, 0.06, -33.0, Math.PI, 'east-south');
  P(29.8, 5.28, -14.4, 2.35, 'container-top');
  P(25.0, 0.06, 22.0, 3.6, 'east-north');
  P(31.0, 0.06, 2.0, 3.9, 'east-mid');
  P(-31.0, 0.06, 22.0, 2.2, 'west-north');
  P(-24.0, 0.06, 30.0, 2.4, 'north-yard');
  P(17.5, 0.06, -36.0, 2.9, 'south-east');
}
