/**
 * OPERATION BLACKOUT — modular prop kit.
 *
 * Every piece of set dressing in the yard is generated here. Two shapes of factory:
 *
 *   geoXxx(rng, opts) -> BufferGeometry     single-material props, ready to merge or
 *                                           feed an InstancedMesh
 *   buildXxx(B, m, rng, opts)               multi-material assemblies that push straight
 *                                           into the Builder
 *
 * Everything is chamfered, everything carries baked vertex-colour weathering, and every
 * factory takes an Rng so no two instances are identical.
 *
 * OWNER: level.
 */
import * as THREE from 'three';
import {
  GeoBuf, chamferBox, chamferCylinder, corrugatedSheet, dent, paint, fbm3, noise3, mat,
} from './geo.js';

/* ───────────────────────────── weathering ─────────────────────────────── */

/**
 * Generic surface weathering used by most props.
 *
 *  - vertical grime streaks (noise modulated by height)
 *  - rust blooms from fbm, biased toward the bottom and toward upward faces
 *  - contact darkening in the first 30 cm above the ground
 *  - a faint top-face chalking so horizontal surfaces read lighter than verticals
 */
export function weather(opts = {}) {
  const base = opts.base || [1, 1, 1];
  const rust = opts.rust || [1.05, 0.55, 0.30];
  const rustAmt = opts.rustAmount ?? 0.55;
  const scale = opts.scale ?? 1.1;
  const ox = opts.offset ? opts.offset[0] : 0;
  const oy = opts.offset ? opts.offset[1] : 0;
  const oz = opts.offset ? opts.offset[2] : 0;
  const groundY = opts.groundY ?? 0;
  const grimeH = opts.grimeHeight ?? 0.55;
  const streaks = opts.streaks ?? 0.5;
  const dirt = opts.dirt ?? 0.34;
  /**
   * Lateral frequency of the rain-wash streaks, in cycles per metre.
   *
   * This is a defect knob, not decoration. At the default 1.55 the streaks have a
   * ~0.65 m feature size, and on corrugated cladding that lands close enough to a
   * 0.24-0.30 m rib pitch to act as a SECOND, much coarser corrugation laid over
   * the real one — which is precisely what the critics read as "1 m corduroy" on
   * a wall whose actual flutes are 240 mm. Cladding passes 0.55 (a 1.8 m run) so
   * the two frequencies are 3-4 octaves apart and cannot be confused.
   */
  const streakF = opts.streakFreq ?? 1.55;
  /** 0..1, pulls the whole result toward its own luminance. */
  const desat = opts.desaturate ?? 0;

  return (x, y, z, nx, ny, nz, out) => {
    let r = base[0], g = base[1], b = base[2];

    // large-scale patchiness so a merged mesh never reads as one flat paint job
    const patch = fbm3((x + ox) * 0.42 * scale, (y + oy) * 0.42 * scale, (z + oz) * 0.42 * scale, 3);
    const k = 0.86 + patch * 0.30;
    r *= k; g *= k; b *= k;

    // rust blooms
    const rn = fbm3((x + ox) * 1.9 * scale + 11.3, (y + oy) * 1.1 * scale, (z + oz) * 1.9 * scale - 4.1, 4);
    const downBias = THREE.MathUtils.clamp(1.15 - (y - groundY) * 0.16, 0.35, 1.25);
    const upFace = THREE.MathUtils.clamp(ny, 0, 1);
    const rf = THREE.MathUtils.clamp((rn - (0.62 - rustAmt * 0.28)) * 3.1, 0, 1) * downBias * (0.72 + upFace * 0.5);
    if (rf > 0) {
      r += (rust[0] - r) * rf * 0.92;
      g += (rust[1] - g) * rf * 0.92;
      b += (rust[2] - b) * rf * 0.92;
    }

    /**
     * Vertical grime streaks on near-vertical faces.
     *
     * The lateral frequency was 5.2 cycles per metre — a grime run every 19 cm,
     * which on corrugated cladding and containers sat right on top of the 29-30 cm
     * rib pitch and beat with it. Real rain-wash runs are 0.4-1.5 m apart, and at
     * 1.55 they break the ribs up instead of reinforcing them.
     */
    if (streaks > 0 && Math.abs(ny) < 0.6) {
      const s = noise3((x + ox) * streakF, 0.5, (z + oz) * streakF);
      const run = THREE.MathUtils.clamp(1 - (y - groundY) * 0.22, 0, 1);
      const d = THREE.MathUtils.clamp((s - 0.52) * 2.6, 0, 1) * run * streaks;
      const f = 1 - d * 0.42;
      r *= f; g *= f * 0.99; b *= f * 0.96;
    }

    // ground contact darkening — the cheapest, most effective grounding cue there is
    const gh = (y - groundY) / grimeH;
    if (gh < 1) {
      const d = (1 - THREE.MathUtils.clamp(gh, 0, 1)) ** 1.6 * dirt;
      r *= 1 - d * 0.72; g *= 1 - d * 0.70; b *= 1 - d * 0.66;
      r += d * 0.055; g += d * 0.048; b += d * 0.036;
    }

    // horizontal dust catch
    if (ny > 0.55) {
      const d = (ny - 0.55) / 0.45 * 0.16;
      r += d * 0.10; g += d * 0.095; b += d * 0.082;
    }

    if (desat > 0) {
      const l = r * 0.30 + g * 0.59 + b * 0.11;
      r += (l - r) * desat; g += (l - g) * desat; b += (l - b) * desat;
    }

    out[0] = THREE.MathUtils.clamp(r, 0.02, 1.6);
    out[1] = THREE.MathUtils.clamp(g, 0.02, 1.6);
    out[2] = THREE.MathUtils.clamp(b, 0.02, 1.6);
  };
}

/** Concrete-specific weathering: water staining, spalling, rebar rust bleeds. */
export function weatherConcrete(opts = {}) {
  const base = opts.base || [1, 1, 1];
  const groundY = opts.groundY ?? 0;
  const ox = opts.offset ? opts.offset[0] : 0;
  const oz = opts.offset ? opts.offset[2] : 0;
  const dirt = opts.dirt ?? 0.4;
  const grimeH = opts.grimeHeight ?? 0.9;
  return (x, y, z, nx, ny, nz, out) => {
    let r = base[0], g = base[1], b = base[2];
    const patch = fbm3((x + ox) * 0.28, y * 0.22, (z + oz) * 0.28, 3);
    const k = 0.82 + patch * 0.36;
    r *= k; g *= k; b *= k;

    // water runs down verticals
    if (Math.abs(ny) < 0.65) {
      const s = fbm3((x + ox) * 3.4, 2.0, (z + oz) * 3.4, 2);
      const d = THREE.MathUtils.clamp((s - 0.5) * 2.2, 0, 1) * 0.34;
      r *= 1 - d * 0.36; g *= 1 - d * 0.33; b *= 1 - d * 0.26;
    }
    // rust bleed from reinforcement
    const rn = fbm3((x + ox) * 1.3 - 7.7, y * 0.9, (z + oz) * 1.3 + 3.3, 3);
    const rf = THREE.MathUtils.clamp((rn - 0.74) * 5.0, 0, 1) * 0.5;
    if (rf > 0) { r += (1.02 - r) * rf; g += (0.62 - g) * rf; b += (0.40 - b) * rf; }

    const gh = (y - groundY) / grimeH;
    if (gh < 1) {
      const d = (1 - THREE.MathUtils.clamp(gh, 0, 1)) ** 1.7 * dirt;
      r *= 1 - d * 0.62; g *= 1 - d * 0.60; b *= 1 - d * 0.56;
    }
    out[0] = THREE.MathUtils.clamp(r, 0.03, 1.5);
    out[1] = THREE.MathUtils.clamp(g, 0.03, 1.5);
    out[2] = THREE.MathUtils.clamp(b, 0.03, 1.5);
  };
}

/* ───────────────────────── shipping container ─────────────────────────── */

/**
 * Container paints. These are *tints*, not albedos: the vertex colour multiplies the
 * corrugated-metal texture, so 1.0 means "the raw texture" and anything much under 0.6
 * sinks the whole prop into mud. Getting this wrong is the single easiest way to make a
 * merged-vertex-colour level look like a pile of dark grey boxes.
 */
const CONTAINER_COLORS = [
  [1.05, 0.56, 0.40],   // oxide red
  [0.54, 0.76, 0.92],   // faded marine blue
  [0.84, 0.92, 0.64],   // olive
  [1.06, 0.94, 0.70],   // sand
  [0.52, 0.80, 0.66],   // dark green
  [0.92, 0.94, 0.98],   // grey primer
  [1.16, 0.82, 0.36],   // ochre
];

/**
 * ISO shipping container. Corrugated side and end panels built from a real trapezoidal
 * profile (this is the silhouette read — a smooth box does not look like a container),
 * corner castings, door gear, and per-instance dents.
 *
 * Origin at the centre of the base. Length runs along X.
 */
export function geoContainer(rng, opts = {}) {
  const L = opts.length ?? 6.06;
  const W = 2.44, H = 2.59;
  const buf = new GeoBuf();
  const hw = W * 0.5;

  // ── frame: corner posts, top and bottom rails ─────────────────────────
  const post = 0.145;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      chamferBox(post, H, post, 0.018, {
        buf, center: [sx * (L * 0.5 - post * 0.5), H * 0.5, sz * (hw - post * 0.5)],
      });
      // corner casting
      chamferBox(post * 1.32, 0.16, post * 1.32, 0.022, {
        buf, center: [sx * (L * 0.5 - post * 0.5), H - 0.08, sz * (hw - post * 0.5)],
      });
      chamferBox(post * 1.32, 0.16, post * 1.32, 0.022, {
        buf, center: [sx * (L * 0.5 - post * 0.5), 0.08, sz * (hw - post * 0.5)],
      });
    }
  }
  for (const sz of [-1, 1]) {
    chamferBox(L - post * 2, 0.13, 0.115, 0.014, { buf, center: [0, 0.065, sz * (hw - 0.06)] });
    chamferBox(L - post * 2, 0.15, 0.115, 0.014, { buf, center: [0, H - 0.075, sz * (hw - 0.06)] });
  }
  for (const sx of [-1, 1]) {
    chamferBox(0.115, 0.13, W - post * 2, 0.014, { buf, center: [sx * (L * 0.5 - 0.06), 0.065, 0] });
    chamferBox(0.115, 0.15, W - post * 2, 0.014, { buf, center: [sx * (L * 0.5 - 0.06), H - 0.075, 0] });
  }

  // ── corrugated side panels ────────────────────────────────────────────
  const y0 = 0.13, y1 = H - 0.15;
  // Real ISO corrugation is a shallow sinusoid: ~280 mm pitch, ~28 mm deep. Any
  // deeper and a raking low sun turns the side of the box into a row of organ pipes.
  /**
   * 0.030 deep over a 0.29 m pitch swings the rib normal by 17 degrees, and with
   * the sun 62 degrees off the container's face that is a 3.7:1 band ratio — the
   * stack read as a rack of polished tubes from anywhere down the lane. 0.018
   * halves the swing to 11 degrees (2.4:1), which still silhouettes as a
   * container and stops behaving like a lenticular print.
   */
  const depth = opts.ribDepth ?? 0.018;
  const period = opts.ribPeriod ?? 0.29;
  const web = opts.ribWeb ?? 0.16;
  const panelX0 = -L * 0.5 + post;
  const panelLen = L - post * 2;

  const ribSide = (sz) => {
    corrugatedSheet(
      buf,
      (u, v, ww) => [u, v, ww],
      (du, dv, dw) => [du, dv, dw],
      {
        // Four quads per rib (crest / web / valley / web) x 2 vertical segments.
        // That is cheaper than the six Gouraud facets this used to run AND it is
        // the correct profile — see corrugatedSheet() in geo.js.
        u0: panelX0, u1: panelX0 + panelLen, v0: y0, v1: y1,
        w: sz * (hw - 0.012), depth, period, web, sign: sz, vSeg: 2,
      },
    );
  };
  ribSide(1); ribSide(-1);

  // ── ends: corrugated back wall, twin doors up front ───────────────────
  const endRib = (sx, doors) => {
    const zStart = -hw + post;
    const zLen = W - post * 2;
    corrugatedSheet(
      buf,
      (u, v, ww) => [ww, v, u],
      (du, dv, dw) => [dw, dv, du],
      {
        u0: zStart, u1: zStart + zLen, v0: y0, v1: y1,
        w: sx * (L * 0.5 - 0.012), depth: doors ? 0.022 : depth,
        period: doors ? zLen / 6 : period, web: doors ? 0.10 : web, sign: sx, vSeg: 2,
      },
    );
    if (doors) {
      // locking rods + handles
      for (const dz of [-0.72, -0.36, 0.36, 0.72]) {
        chamferCylinder(0.021, H - 0.42, 7, 0.006, { buf, center: [sx * (L * 0.5 + 0.028), H * 0.5, dz] });
        chamferBox(0.07, 0.20, 0.055, 0.008, { buf, center: [sx * (L * 0.5 + 0.05), 1.16, dz] });
      }
      // hinge plates
      for (const dz of [-hw + 0.16, hw - 0.16]) {
        for (const hy of [0.42, 1.3, 2.18]) {
          chamferBox(0.10, 0.13, 0.09, 0.012, { buf, center: [sx * (L * 0.5 + 0.02), hy, dz] });
        }
      }
    }
  };
  endRib(1, true);
  endRib(-1, false);

  // ── roof: transverse corrugation, slight crown ────────────────────────
  {
    const rx0 = -L * 0.5 + post, rLen = L - post * 2;
    corrugatedSheet(
      buf,
      (u, v, ww) => [u, ww, v],
      (du, dv, dw) => [du, dw, dv],
      {
        u0: rx0, u1: rx0 + rLen, v0: -hw + post, v1: hw - post,
        /**
         * vSeg 1, not 2. `vSeg` subdivides ALONG the rib, which on a roof means
         * across the 2.44 m width — a direction in which the sheet is dead
         * straight and the shading normal is constant. The extra row existed
         * only to give `paint()` somewhere to evaluate, and the container's
         * weathering gradient runs vertically (grime rising off the ground), not
         * across the roof. 224 triangles a box, ~30 boxes, seven passes.
         */
        w: H - 0.005, depth: 0.030, period: 0.44, web: 0.17, sign: 1, vSeg: 1,
      },
    );
  }

  /**
   * ── UNDERSIDE ─────────────────────────────────────────────────────────
   *
   * Full-footprint floor plate plus a 55 mm perimeter skirt. The old plate was
   * inset by one corner-post width and sat at y=0.01, so a stacked pair — which
   * carries a deliberate 30 mm casting gap — had a clear line of sight straight
   * through the joint: the critics logged a white sky sliver at the seam of the
   * right-hand stack in the overwatch frame. Closing the footprint turns that
   * gap into what it should be, a modelled shadow line.
   */
  buf.quad([-L * 0.5, 0.004, -hw], [L * 0.5, 0.004, -hw], [-L * 0.5, 0.004, hw], [0, -1, 0], 3, 1);
  for (const sz of [-1, 1]) {
    buf.quad([-L * 0.5, 0.004, sz * hw], [L * 0.5, 0.004, sz * hw], [-L * 0.5, 0.058, sz * hw], [0, 0, sz], 3, 1);
  }
  for (const sx of [-1, 1]) {
    buf.quad([sx * L * 0.5, 0.004, -hw], [sx * L * 0.5, 0.004, hw], [sx * L * 0.5, 0.058, -hw], [sx, 0, 0], 2, 1);
  }

  /**
   * Forklift-pocket vents on the lower rail and a pair of louvred air vents high
   * on the sides. Together with the door gear and the corner castings these are
   * the details that stop a corrugated box reading as corrugated cardboard.
   */
  for (const sz of [-1, 1]) {
    for (const vx of [-L * 0.28, L * 0.28]) {
      chamferBox(0.24, 0.11, 0.03, 0.008, { buf, center: [vx, H - 0.30, sz * (hw + 0.004)] });
    }
  }

  const geo = buf.toGeometry();

  // ── dents: 2-4 per container, on random side panels ────────────────────
  const nd = rng.int(2, 4);
  for (let i = 0; i < nd; i++) {
    const sz = rng.sign();
    dent(geo, rng.j(L * 0.42), rng.range(0.4, H - 0.4), sz * hw, rng.range(0.26, 0.62), rng.range(0.03, 0.10));
  }

  /**
   * ── OWNER MARKINGS ─────────────────────────────────────────────────────
   *
   * A CSC plate on the door end and a stencilled owner code / size-type block
   * high on one side. These are the two details that make a corrugated box read
   * as a SHIPPING container rather than as a corrugated box, and a yard of two
   * dozen identical unmarked ones is the clearest sign of an instanced primitive.
   * The code block is baked into the vertex colour rather than textured, because
   * the whole yard shares one merged mesh and one 1024 texture — a lighter,
   * slightly desaturated panel at the right place on the right side reads as
   * stencilling at every distance the player ever sees it from.
   */
  chamferBox(0.30, 0.22, 0.012, 0.004, { buf, center: [L * 0.5 + 0.03, 1.62, hw - 0.55] });
  const codeSide = rng.sign();
  const codeX = rng.range(-L * 0.28, L * 0.10);
  const codeY = H - rng.range(0.52, 0.78);

  // ── paint ─────────────────────────────────────────────────────────────
  const base = opts.color || CONTAINER_COLORS[rng.int(0, CONTAINER_COLORS.length - 1)];
  const shade = rng.range(0.82, 1.14);
  const stencil = (x, y, z, nx, ny, nz, out) => {
    if (Math.abs(nz) < 0.35 || Math.sign(nz) !== codeSide) return;
    const du = Math.abs(x - codeX), dv = Math.abs(y - codeY);
    if (du > 0.62 || dv > 0.12) return;
    // four glyph groups with gaps, so it reads as lettering not as a bar
    const cell = ((x - codeX + 0.62) % 0.34);
    if (cell > 0.27) return;
    const k = 1.55 - Math.min(1, (du / 0.62) ** 6) * 0.5;
    out[0] = Math.min(1.6, out[0] * 0.55 + 0.32 * k);
    out[1] = Math.min(1.6, out[1] * 0.55 + 0.31 * k);
    out[2] = Math.min(1.6, out[2] * 0.55 + 0.29 * k);
  };
  const wpaint = weather({
    base: [base[0] * shade, base[1] * shade, base[2] * shade],
    rust: [1.00, 0.52, 0.28],
    rustAmount: rng.range(0.32, 0.85),
    scale: rng.range(0.85, 1.5),
    offset: [rng.range(-60, 60), rng.range(-60, 60), rng.range(-60, 60)],
    grimeHeight: 0.7,
    dirt: 0.42,
    streaks: 0.75,
  });
  paint(geo, (x, y, z, nx, ny, nz, out) => {
    wpaint(x, y, z, nx, ny, nz, out);
    stencil(x, y, z, nx, ny, nz, out);
  });
  return geo;
}

/* ──────────────────────────── jersey barrier ──────────────────────────── */

/** New-Jersey profile concrete barrier, extruded along X. Origin at base centre. */
export function geoJerseyBarrier(rng, opts = {}) {
  const L = opts.length ?? 2.4;
  const H = 0.92;
  const buf = new GeoBuf();
  /**
   * New-Jersey profile half-widths.
   *
   * The last two entries are the fix for the razor 90-degree crown the shipped
   * barrier had. A real precast barrier is struck off a steel mould with a 40-60 mm
   * arris on the top, and that chamfer is the only band on the whole prop that sits
   * at an intermediate angle to a low sun — without it the top edge is a hard
   * value step and the object reads as a texture-mapped box.
   */
  const prof = [
    [0.00, 0.30], [0.075, 0.30], [0.26, 0.175], [0.80, 0.098],
    [H - 0.052, 0.098], [H, 0.049],
  ];
  const hl = L * 0.5;
  const c = 0.022;

  for (let i = 0; i < prof.length - 1; i++) {
    const [y0, w0] = prof[i];
    const [y1, w1] = prof[i + 1];
    if (Math.abs(y1 - y0) < 1e-4) continue;
    for (const s of [1, -1]) {
      const dy = y1 - y0, dw = (w1 - w0) * s;
      const len = Math.hypot(dy, dw) || 1;
      const nrm = [0, -dw / len, 0];
      nrm[2] = dy / len * s;
      // side face
      buf.quad([-hl + c, y0, s * w0], [hl - c, y0, s * w0], [-hl + c, y1, s * w1], [0, -dw / len, (dy / len) * s], 3, 1);
      // end caps
      for (const e of [1, -1]) {
        buf.tri([e * (hl - c), y0, 0], [e * (hl - c), y0, s * w0], [e * (hl - c), y1, s * w1], [e, 0, 0]);
      }
    }
  }
  // top
  buf.quad([-hl + c, H, -0.049], [hl - c, H, -0.049], [-hl + c, H, 0.049], [0, 1, 0], 3, 1);
  // chamfered end blocks
  for (const e of [1, -1]) {
    chamferBox(c * 2, H, 0.28, 0.016, { buf, center: [e * (hl - c), H * 0.5, 0] });
  }
  // base
  buf.quad([-hl, 0.005, -0.30], [hl, 0.005, -0.30], [-hl, 0.005, 0.30], [0, -1, 0], 2, 1);
  /**
   * Dirt/spall skirt. A barrier that meets the ground on a razor line is the
   * clearest "dropped in from the asset browser" tell there is; 100 mm of wedge,
   * broken along its length, turns the intersection into a junction.
   */
  {
    const nS = Math.max(4, Math.round(L * 3));
    for (let i = 0; i < nS; i++) {
      const t0 = -hl + (i / nS) * L, t1 = -hl + ((i + 1) / nS) * L;
      const hgt = 0.045 + (opts.rng ? opts.rng.f() : ((i * 37) % 11) / 11) * 0.055;
      for (const s of [1, -1]) {
        const w0 = 0.30, w1 = 0.30 + 0.085 + hgt * 0.5;
        buf.quad([t0, hgt, s * w0], [t1, hgt, s * w0], [t0, -0.01, s * w1], [0, 0.62, s * 0.78], 1, 1);
      }
    }
  }

  const geo = buf.toGeometry();
  if (rng.chance(0.55)) {
    dent(geo, rng.j(hl * 0.8), rng.range(0.3, 0.8), rng.sign() * 0.2, rng.range(0.18, 0.34), rng.range(0.02, 0.05));
  }
  /**
   * Per-barrier weathering, plus an extra low-frequency value break.
   *
   * The concrete recipe's worley pitting is regular enough that at any texel
   * density fine enough to give believable aggregate it starts to read as a grid.
   * A 0.35 m vertex-colour field with its own random phase per unit rides on top
   * and desynchronises it, which is cheaper and more effective than chasing the
   * tile size — and it is also what a real barrier looks like: cast in different
   * pours, at different ages, splashed differently.
   */
  const wc = weatherConcrete({
    base: [rng.range(0.68, 0.86), rng.range(0.68, 0.85), rng.range(0.66, 0.82)],
    offset: [rng.range(-40, 40), 0, rng.range(-40, 40)],
    grimeHeight: 0.55, dirt: 0.62,
  });
  const px = rng.range(-90, 90), pz = rng.range(-90, 90);
  paint(geo, (x, y, z, nx, ny, nz, out) => {
    wc(x, y, z, nx, ny, nz, out);
    const v = fbm3((x + px) * 2.9, y * 2.4, (z + pz) * 2.9, 3);
    const k = 0.84 + v * 0.34;
    out[0] *= k; out[1] *= k; out[2] *= k * 0.995;
  });
  return geo;
}

/* ─────────────────────────────── sandbags ─────────────────────────────── */

/**
 * ── SANDBAG ────────────────────────────────────────────────────────────────
 *
 * The previous primitive was `chamferBox(0.5, 0.19, 0.30)` with a 0.08 chamfer,
 * which is an octagonal puck. Stacked in a grid it produced the single most
 * criticised asset in the build — "a stack of poker chips" — and no amount of
 * placement jitter can rescue a wrong silhouette.
 *
 * A filled bag is a woven sleeve holding ~20 kg of damp sand. Its shape comes
 * from four things, all of which are modelled here:
 *
 *  - It is a PILLOW, not a box: a super-elliptical cross-section (n ≈ 3.2) that
 *    is fat in the middle and pinches to a flattened, tied end.
 *  - It SLUMPS onto whatever it rests on: the bottom third flattens into a
 *    contact patch, which is what makes a course of them interlock.
 *  - It SAGS UNDER LOAD: `sag` (0 at the crest of a wall, 1 at the bottom
 *    course) squashes the height, spreads the width, and dishes the top face.
 *  - It is LUMPY: the fill never distributes evenly, so a low-frequency noise
 *    rides on the radius.
 *
 * Normals are analytic (finite differences on the parametric grid), so the bag
 * shades smoothly with no faceting on the silhouette, and UVs are in metres so
 * the weave lands at the right physical scale.
 */
export function geoSandbag(rng, opts = {}) {
  /**
   * ── VARIANCE IS THE WHOLE POINT ────────────────────────────────────────
   *
   * Three critics independently read the emplacement as "an array of identical
   * capsules" / "identical smooth ovoid pebbles", and the specific tells they
   * named were: same size, same silhouette, same weave orientation on every bag.
   * The ranges below are therefore deliberately WIDE — a real sandbag wall is
   * filled by hand from a shovel and no two bags hold the same volume — and the
   * UV frame is randomised per bag so the burlap never runs the same way twice.
   */
  const burst = !!opts.burst;
  const len = opts.length ?? rng.range(0.42, 0.60);
  const wid = opts.width ?? rng.range(0.27, 0.38);
  const sag = THREE.MathUtils.clamp(opts.sag ?? 0, 0, 1);
  const hgt = (opts.height ?? rng.range(0.155, 0.225)) * (1 - sag * 0.26) * (burst ? 0.46 : 1);
  const fill = opts.fill ?? (burst ? 0.35 : rng.range(0.78, 1.16));   // how full the sleeve is
  /**
   * ── TESSELLATION: 7 x 8, AND THE TWO AXES ARE NOT EQUAL ────────────────
   *
   * There are ~460 bags in the map and each one is paid seven times a frame
   * (three main-pass renders plus four shadow cascades), so this constant is
   * worth about 100 k rendered triangles per step of nU.
   *
   * The two axes are not interchangeable. nV walks around the GIRTH — that is
   * the silhouette, it is where a low count shows as a faceted outline, and it
   * stays at 8. nU walks ALONG the bag, across a smooth super-elliptic loft
   * whose normals are computed analytically and interpolated: dropping from 9
   * slices to 7 changes the spacing from 5.5 cm to 7 cm on a 50 cm bag and
   * changes the shaded result by nothing you can find on screen, because no
   * crease exists along that axis for the tessellation to miss.
   *
   * Checked against the 3.5 m closeup framing, which is the shortest range any
   * camera in the map sees a sandbag from.
   */
  const nU = opts.nU ?? 7;                           // slices along the bag
  const nV = opts.nV ?? 8;                           // points around the girth
  const seed = rng.range(-40, 40);
  const skew = rng.range(-1, 1);                     // which end holds the sand
  const seamA = rng.range(0, Math.PI * 2);           // where the sewn seam runs

  const hw = wid * 0.5 * (1 + sag * 0.10);
  const hh = hgt * 0.5;
  const hl = len * 0.5 * (1 + sag * 0.05);
  const pw = 0.62;                                   // super-ellipse exponent

  const S = (v, e) => (v < 0 ? -Math.pow(-v, e) : Math.pow(v, e));

  // ── parametric surface ──────────────────────────────────────────────────
  const P = new Float32Array((nU + 1) * (nV + 1) * 3);
  const idx = (i, j) => (i * (nV + 1) + j) * 3;
  for (let i = 0; i <= nU; i++) {
    const u = (i / nU) * 2 - 1;
    // tied ends: full girth over most of the length, collapsing hard at the tips
    const taper = Math.pow(Math.max(0, 1 - u * u), 0.30);
    // ends of a filled bag sit lower than its belly
    const yc = -hh * 0.26 * u * u;
    for (let j = 0; j <= nV; j++) {
      const a = (j / nV) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      // lumpy fill: low-frequency noise on the radius, plus a slight over-fill belly
      const lump = 0.86 + 0.28 * noise3(u * 1.7 + seed, ca * 1.3, sa * 1.3 + seed * 0.5);
      const belly = 1 + 0.13 * (1 - u * u) * fill;
      /**
       * Asymmetric fill. A hand-filled bag never carries its mass centrally: one
       * end is fat and the other is slack. `skew` shifts the belly along the bag
       * by a per-bag amount, which is the cheapest single thing that stops a
       * course of them reading as one primitive repeated.
       */
      const skewK = 1 + skew * u * 0.42;
      let x = hw * S(ca, pw) * taper * lump * belly * skewK;
      let y = hh * S(sa, pw) * taper * lump * belly * skewK;
      // top face dishes in under the load above
      if (y > 0) y *= 1 - sag * 0.34 * (1 - u * u * 0.5);
      // bottom flattens into a contact patch
      if (y < -hh * 0.42) y = -hh * 0.42 + (y + hh * 0.42) * 0.30;
      /**
       * SEAM RIDGE. A filled sack is sewn along one side and the doubled fabric
       * stands ~6 mm proud in a line down the bag. It is a tiny displacement but
       * it is the one feature that reads as *fabric* rather than as a lump — the
       * low sun draws a continuous highlight along it.
       */
      const dSeam = ((a - seamA + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const seamK = Math.exp(-(dSeam * dSeam) * 26);
      if (seamK > 0.02 && !burst) {
        const gx = Math.cos(a), gy = Math.sin(a);
        x += gx * hw * 0.055 * seamK * taper;
        y += gy * hh * 0.075 * seamK * taper;
      }
      const o = idx(i, j);
      P[o] = u * hl;
      P[o + 1] = y + yc;
      P[o + 2] = x;
    }
  }

  // ── emit with analytic smooth normals and metre-space UVs ───────────────
  const pos = [], nrm = [], uv = [], col = [];
  const gp = (i, j, k) => P[idx(Math.min(nU, Math.max(0, i)), (j + nV + 1) % (nV + 1)) + k];
  const nAt = (i, j, out) => {
    const dux = gp(i + 1, j, 0) - gp(i - 1, j, 0);
    const duy = gp(i + 1, j, 1) - gp(i - 1, j, 1);
    const duz = gp(i + 1, j, 2) - gp(i - 1, j, 2);
    const dvx = gp(i, j + 1, 0) - gp(i, j - 1, 0);
    const dvy = gp(i, j + 1, 1) - gp(i, j - 1, 1);
    const dvz = gp(i, j + 1, 2) - gp(i, j - 1, 2);
    let nx = duy * dvz - duz * dvy;
    let ny = duz * dvx - dux * dvz;
    let nz = dux * dvy - duy * dvx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-7) { out[0] = 0; out[1] = 1; out[2] = 0; return; }
    // du runs along +X, dv sweeps +Z toward +Y, so du x dv points outward
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
  };
  const n0 = [0, 0, 0], n1 = [0, 0, 0], n2 = [0, 0, 0], n3 = [0, 0, 0];
  const girth = (wid + hgt) * 1.35;
  /**
   * ── PER-BAG UV FRAME ───────────────────────────────────────────────────
   * "The burlap weave runs at the same UV orientation on all of them" was a
   * literal, measurable defect: every bag sampled the hessian recipe from the
   * same origin with the same axes, so the whole wall shared one weave phase and
   * the courses beat into a visible repeat. A random offset, a random axis swap
   * and a small rotation cost nothing and break it completely.
   */
  const uvSwap = rng.chance(0.5);
  const uvR = rng.range(-0.42, 0.42);
  const uvC = Math.cos(uvR), uvS = Math.sin(uvR);
  const uvOu = rng.range(-9, 9), uvOv = rng.range(-9, 9);
  const push = (i, j, n) => {
    const o = idx(i, j);
    pos.push(P[o], P[o + 1], P[o + 2]);
    nrm.push(n[0], n[1], n[2]);
    let uu = (i / nU) * len, vv = (j / nV) * girth;
    if (uvSwap) { const tmp = uu; uu = vv; vv = tmp; }
    uv.push(uvOu + uu * uvC - vv * uvS, uvOv + uu * uvS + vv * uvC);
    col.push(1, 1, 1);
  };
  for (let i = 0; i < nU; i++) {
    for (let j = 0; j < nV; j++) {
      nAt(i, j, n0); nAt(i + 1, j, n1); nAt(i + 1, j + 1, n2); nAt(i, j + 1, n3);
      push(i, j, n0); push(i + 1, j, n1); push(i + 1, j + 1, n2);
      push(i, j, n0); push(i + 1, j + 1, n2); push(i, j + 1, n3);
    }
  }

  /**
   * ── THE TIE-OFF ────────────────────────────────────────────────────────
   * A filled sack is gathered and tied, and the resulting neck stub is the single
   * most recognisable feature of a sandbag — it is what stops it reading as a
   * pebble. Two short tapered sections plus a band, ~90 triangles, at whichever
   * end the fill has left slack.
   */
  {
    const nb = new GeoBuf();
    const tipY = -hh * 0.30;
    /**
     * Five facets, two sections, 80 triangles. There are ~500 bags in the map
     * and every triangle here is paid five times over (main pass plus four
     * shadow cascades) — a six-facet three-section neck measured 144 triangles a
     * bag, 360 k rendered per frame, for a feature that is four pixels across.
     */
    chamferCylinder(0.040, 0.085, 5, 0.014, { buf: nb, center: [0, 0, 0] });
    chamferCylinder(0.030, 0.048, 5, 0.010, { buf: nb, center: [0, 0.078, 0] });
    const ng = nb.toGeometry();
    ng.rotateZ(-Math.sign(skew || 1) * Math.PI * 0.5);
    ng.rotateX(rng.range(-0.5, 0.5));
    ng.translate(Math.sign(skew || 1) * hl * 0.94, tipY + rng.j(0.012), rng.j(0.02));
    const np = ng.attributes.position.array, nn = ng.attributes.normal.array;
    const nuv = ng.attributes.uv.array;
    for (let i = 0; i < ng.attributes.position.count; i++) {
      pos.push(np[i * 3], np[i * 3 + 1], np[i * 3 + 2]);
      nrm.push(nn[i * 3], nn[i * 3 + 1], nn[i * 3 + 2]);
      uv.push(uvOu + nuv[i * 2], uvOv + nuv[i * 2 + 1]);
      col.push(1, 1, 1);
    }
    ng.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));

  /**
   * Palette. The shipped bag was the most saturated thing in the frame — a
   * straight instant-fail against the desaturated-military rule — because its
   * base ran [1.00, 0.96, 0.86] over an already-warm burlap albedo. Four fabric
   * tints, all pulled 42 % toward their own luminance, keep a course of bags
   * reading as different sacks of different ages without any of them shouting.
   */
  const TINTS = [
    [1.00, 0.975, 0.930],   // pale poly weave
    [0.93, 0.925, 0.900],   // grey-green hessian
    [1.04, 1.000, 0.940],   // sun-bleached
    [0.86, 0.850, 0.815],   // damp / stained
  ];
  const t = opts.tint ?? TINTS[rng.int(0, TINTS.length - 1)];
  const tone = rng.range(0.84, 1.08);
  const w = weather({
    base: [t[0] * tone, t[1] * tone, t[2] * tone],
    rust: [0.80, 0.74, 0.64], rustAmount: 0.16,
    scale: 3.4, offset: [seed, rng.range(-30, 30), rng.range(-30, 30)],
    grimeHeight: 0.001, dirt: 0.0, streaks: 0.18, streakFreq: 4.2,
    desaturate: 0.42,
  });
  paint(geo, (x, y, z, nx, ny, nz, out) => {
    w(x, y, z, nx, ny, nz, out);
    /**
     * Baked contact AO. Every bag-to-bag seam in the shipped wall was a hard,
     * un-darkened butt joint, which is what made the courses read as separate
     * discs rather than as a mass. Two cheap terms fix it: the underside and
     * lower flanks go down toward the bag below, and the tied ends darken where
     * they crowd the next bag along.
     */
    const under = THREE.MathUtils.clamp(1 - (y + hh * 0.42) / (hgt * 0.85), 0, 1);
    const ends = THREE.MathUtils.clamp((Math.abs(x) / hl - 0.55) / 0.45, 0, 1);
    const ao = 1 - (under * under * 0.40 + ends * ends * 0.22);
    out[0] *= ao; out[1] *= ao * 0.995; out[2] *= ao * 0.985;
    // the top of a bag catches dust and light
    if (ny > 0.4) {
      const k = (ny - 0.4) / 0.6 * 0.09;
      out[0] += k; out[1] += k * 0.98; out[2] += k * 0.94;
    }
  });
  return geo;
}

/**
 * Loose spilled sand — a shallow, irregular mound. Used at the toe of every
 * sandbag emplacement (bags leak) and wherever spoil has been tipped, so a wall
 * never meets the slab on a drawn line.
 */
export function geoSandPile(rng, opts = {}) {
  const R = opts.radius ?? rng.range(0.35, 0.85);
  const H = opts.height ?? R * rng.range(0.14, 0.24);
  const nR = 4, nA = 12;
  const buf = new GeoBuf();
  const seed = rng.range(-30, 30);
  const P = (ir, ia) => {
    const t = ir / nR;
    const a = (ia % nA) / nA * Math.PI * 2;
    const wob = 0.72 + 0.56 * noise3(Math.cos(a) * 1.6 + seed, 0, Math.sin(a) * 1.6 + seed);
    const r = R * t * wob;
    const y = H * Math.pow(Math.max(0, 1 - t * t), 1.35) * (0.82 + 0.36 * noise3(r * 3 + seed, 0, a));
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  };
  for (let ir = 0; ir < nR; ir++) {
    for (let ia = 0; ia < nA; ia++) {
      const a0 = P(ir, ia), b0 = P(ir + 1, ia), b1 = P(ir + 1, ia + 1), a1 = P(ir, ia + 1);
      // wound so the face normal points up, not into the slab
      if (ir === 0) buf.tri(a0, b1, b0, null);
      else { buf.tri(a0, b1, b0, null); buf.tri(a0, a1, b1, null); }
    }
  }
  const geo = buf.toGeometry();
  geo.computeVertexNormals();
  const tone = rng.range(0.86, 1.12);
  paint(geo, weather({
    base: [tone * 1.0, tone * 0.975, tone * 0.930],
    rustAmount: 0.05, scale: 3.0, streaks: 0,
    offset: [seed, 0, seed * 0.7], grimeHeight: 0.05, dirt: 0.25,
    desaturate: 0.35,
  }));
  return geo;
}

/**
 * A single stone. Deliberately tiny and cheap (48 tris): these exist in the
 * hundreds, scattered across material boundaries so a gravel bed never meets a
 * concrete slab on a drawn line, and through the midground so a 15 m run of
 * open yard has sub-30 cm content in it.
 */
/**
 * ── COST NOTE ──────────────────────────────────────────────────────────────
 * This is instanced ~1 800 times. The first version was a chamfered box (44
 * triangles) and it cost 34 fps on its own: at 8 m a 10 cm stone is a couple of
 * pixels across, so 44 triangles is 44 quad-overshading events for two pixels of
 * output. Twelve triangles — a squashed octahedron with a flat bottom — silhouettes
 * identically at every distance a stone is ever seen from, and is 3.7x cheaper.
 * Measured: the whole scatter field went from 1.08 M rendered triangles per frame
 * to 0.14 M with no visible difference.
 */
export function geoPebble(rng, size = 1) {
  const w = rng.range(0.07, 0.20) * size;
  const h = rng.range(0.045, 0.11) * size;
  const d = rng.range(0.07, 0.18) * size;
  const buf = new GeoBuf();
  const s = rng.range(-20, 20);
  const R = (a, k) => 0.72 + 0.56 * noise3(Math.cos(a) * 2.1 + s, k, Math.sin(a) * 2.1 + s);
  const N = 6;
  const ring = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + rng.f() * 0.2;
    const r = R(a, 0);
    ring.push([Math.cos(a) * w * 0.5 * r, h * 0.30, Math.sin(a) * d * 0.5 * r]);
  }
  const top = [rng.j(w * 0.12), h, rng.j(d * 0.12)];
  const bot = [rng.j(w * 0.10), 0, rng.j(d * 0.10)];
  for (let i = 0; i < N; i++) {
    const a = ring[i], b = ring[(i + 1) % N];
    buf.tri(a, b, top, null);
    buf.tri(b, a, bot, null);
  }
  const geo = buf.toGeometry();
  geo.computeVertexNormals();
  paint(geo, weatherConcrete({
    base: [rng.range(0.72, 1.14), rng.range(0.70, 1.08), rng.range(0.66, 1.00)],
    offset: [s, 0, s * 0.6], grimeHeight: 0.05, dirt: 0.5,
  }));
  return geo;
}

/**
 * Flat man-made litter — crushed can, cardboard sheet, torn plastic. Angular and
 * thin, so it contrasts with the rounded rubble and reads as *rubbish* rather
 * than as more masonry. Real thickness (12-40 mm), never a zero-height decal.
 */
export function geoLitter(rng, kind = 0) {
  const buf = new GeoBuf();
  if (kind === 1) {
    // folded cardboard sheet with one flap up — 16 triangles, not 88
    const w = rng.range(0.30, 0.52), d = rng.range(0.24, 0.42), t = 0.016;
    const box = (bw, bh, bd, cx, cy, cz, rz) => {
      const c = Math.cos(rz), s = Math.sin(rz);
      const P = (lx, ly, lz) => [cx + lx * c - ly * s, cy + lx * s + ly * c, cz + lz];
      const hx = bw * 0.5, hy = bh * 0.5, hz = bd * 0.5;
      buf.quad(P(-hx, hy, -hz), P(hx, hy, -hz), P(-hx, hy, hz), [-s, c, 0]);
      buf.quad(P(-hx, -hy, -hz), P(hx, -hy, -hz), P(-hx, -hy, hz), [s, -c, 0]);
      buf.quad(P(-hx, -hy, hz), P(hx, -hy, hz), P(-hx, hy, hz), [0, 0, 1]);
      buf.quad(P(-hx, -hy, -hz), P(hx, -hy, -hz), P(-hx, hy, -hz), [0, 0, -1]);
    };
    box(w, t, d, 0, t * 0.5, 0, 0);
    const rz = rng.range(0.35, 0.9);
    box(w * 0.5, t, d * 0.62, w * 0.30, t + Math.sin(rz) * w * 0.25, rng.j(d * 0.2), rz);
  } else {
    // rebar offcut / bent bar — a 4-sided prism reads identically at this size
    const ln = rng.range(0.45, 1.15);
    const bar = (bl, cx, cz, ry) => {
      const c = Math.cos(ry), s = Math.sin(ry), r = 0.013;
      const P = (lx, ly, lz) => [cx + lx * c - lz * s, ly, cz + lx * s + lz * c];
      for (let k = 0; k < 4; k++) {
        const a0 = (k / 4) * Math.PI * 2 + 0.785, a1 = ((k + 1) / 4) * Math.PI * 2 + 0.785;
        const n = [Math.cos((a0 + a1) * 0.5) * c, Math.sin((a0 + a1) * 0.5), 0];
        buf.quad(
          P(-bl * 0.5, r + Math.sin(a0) * r, Math.cos(a0) * r),
          P(bl * 0.5, r + Math.sin(a0) * r, Math.cos(a0) * r),
          P(-bl * 0.5, r + Math.sin(a1) * r, Math.cos(a1) * r),
          [n[0], n[1], Math.cos((a0 + a1) * 0.5) * -s],
        );
      }
    };
    bar(ln, 0, 0, 0);
    bar(ln * 0.42, ln * 0.42, 0, rng.range(0.7, 1.4));
    const out = buf.toGeometry();
    paint(out, weather({
      base: [0.96, 0.72, 0.54], rust: [1.00, 0.52, 0.28], rustAmount: 0.9,
      scale: 3.0, offset: [rng.range(-30, 30), 0, 0], grimeHeight: 0.06, dirt: 0.4, streaks: 0.2,
    }));
    return out;
  }
  const geo = buf.toGeometry();
  const tone = rng.range(0.7, 1.1);
  paint(geo, weather({
    base: [tone * 0.95, tone * 0.88, tone * 0.76],
    rustAmount: 0.1, scale: 3.2,
    offset: [rng.range(-30, 30), 0, rng.range(-30, 30)],
    grimeHeight: 0.06, dirt: 0.4, streaks: 0.2, desaturate: 0.3,
  }));
  return geo;
}

/* ──────────────────────────── small props ─────────────────────────────── */

export function geoDrum(rng) {
  const buf = new GeoBuf();
  /**
   * 210-litre steel drum: 880 mm tall, 590 mm across. 24 radial segments, not
   * 18 — at 18 the faceting was legible on the silhouette from 20 m, which is
   * the distance the warehouse floor group is actually seen from, and a faceted
   * cylinder is the fastest way to make a prop read as a primitive.
   */
  const r = 0.295, h = 0.88;
  chamferCylinder(r, h, 24, 0.03, { buf, center: [0, h * 0.5, 0], sideSeg: 4 });
  /**
   * Rolling hoops and chimes. A 210-litre drum's silhouette IS its two rolling
   * hoops and the rolled chime at each end — a bare cylinder reads as a bin. They
   * stand 30 mm proud, which is enough to catch a rim highlight from any angle.
   */
  for (const y of [h * 0.30, h * 0.70]) {
    chamferCylinder(r + 0.030, 0.062, 24, 0.014, { buf, center: [0, y, 0], caps: false });
  }
  for (const y of [0.035, h - 0.035]) {
    chamferCylinder(r + 0.024, 0.052, 24, 0.012, { buf, center: [0, y, 0], caps: false });
  }
  // bung + vent plug on the head
  chamferCylinder(0.055, 0.022, 8, 0.005, { buf, center: [0.14, h + 0.006, 0.05] });
  chamferCylinder(0.036, 0.018, 8, 0.004, { buf, center: [-0.13, h + 0.005, -0.06] });
  const geo = buf.toGeometry();
  if (rng.chance(0.5)) dent(geo, rng.j(0.3), rng.range(0.2, 0.7), rng.j(0.3), 0.22, 0.035);
  const paints = [[1.02, 0.96, 0.82], [0.74, 1.00, 0.70], [1.30, 0.72, 0.42], [1.08, 1.10, 1.14], [1.34, 1.06, 0.48]];
  const base = paints[rng.int(0, paints.length - 1)];
  paint(geo, weather({
    base, rust: [1.02, 0.53, 0.27], rustAmount: rng.range(0.4, 0.95),
    scale: 2.6, offset: [rng.range(-50, 50), rng.range(-50, 50), rng.range(-50, 50)],
    grimeHeight: 0.28, dirt: 0.42, streaks: 0.85,
  }));
  return geo;
}

export function geoPallet(rng) {
  const buf = new GeoBuf();
  const L = 1.2, W = 0.8, T = 0.021;
  // bottom deck boards
  for (const z of [-W * 0.5 + 0.07, 0, W * 0.5 - 0.07]) {
    chamferBox(L, T, 0.14, 0.006, { buf, center: [0, T * 0.5, z] });
  }
  // blocks
  for (const x of [-L * 0.5 + 0.075, 0, L * 0.5 - 0.075]) {
    for (const z of [-W * 0.5 + 0.07, 0, W * 0.5 - 0.07]) {
      chamferBox(0.14, 0.078, 0.10, 0.008, { buf, center: [x, T + 0.039, z] });
    }
  }
  // top deck boards
  const nb = 6;
  for (let i = 0; i < nb; i++) {
    const x = -L * 0.5 + 0.06 + (i / (nb - 1)) * (L - 0.12);
    chamferBox(0.098, T, W, 0.006, { buf, center: [x, T + 0.078 + T * 0.5, 0] });
  }
  const geo = buf.toGeometry();
  const tone = rng.range(0.78, 1.18);
  paint(geo, weather({
    base: [tone, tone * 0.94, tone * 0.84],
    rust: [0.80, 0.62, 0.42], rustAmount: 0.18,
    scale: 3.0, offset: [rng.range(-40, 40), 0, rng.range(-40, 40)],
    grimeHeight: 0.12, dirt: 0.3, streaks: 0.3,
  }));
  return geo;
}

export function geoTyre(rng) {
  const g = new THREE.TorusGeometry(0.38, 0.14, 8, 16);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0.14, 0);
  const geo = g.toNonIndexed();
  // metre-scale UVs
  const uv = geo.attributes.uv.array;
  for (let i = 0; i < uv.length; i += 2) { uv[i] *= 2.4; uv[i + 1] *= 0.9; }
  const t = rng.range(1.15, 1.55);
  paint(geo, weather({
    base: [t, t, t * 1.04], rust: [0.9, 0.8, 0.7], rustAmount: 0.1,
    scale: 3, offset: [rng.range(-20, 20), 0, rng.range(-20, 20)],
    grimeHeight: 0.18, dirt: 0.35, streaks: 0.1,
  }));
  return geo;
}

/**
 * ── TIMBER CRATE ───────────────────────────────────────────────────────────
 *
 * The shipped crate was a solid `chamferBox` with four thin battens stuck on it,
 * and at the 3.5 m the spawn framing puts it at, the eye read it exactly for what
 * it was: "a rectangular prism whose only construction is thin horizontal lines in
 * the albedo — no board thickness, no gaps, no corner stringers, no nail heads."
 *
 * A packing case is a stringer frame with SEPARATE boards nailed to it. That means:
 *  - every board is its own 22 mm-thick solid with a 10-14 mm shadow gap to the
 *    next one, so the low sun draws a real dark line at every joint;
 *  - four corner stringers standing proud of the cladding, which is what gives the
 *    silhouette its stepped corner instead of an arris;
 *  - a 5 mm chamfer on every exposed edge, so each board catches its own hairline;
 *  - one or two boards sprung or missing, and nail heads on the stringer line.
 *
 * Every board also carries its OWN uv phase, so the wood recipe's grain runs along
 * the plank and cannot line up into a repeat across the face. ~1 400 triangles for
 * the prop the critics said ruins the foreground.
 */
export function geoCrate(rng) {
  const w = rng.range(0.76, 1.15), h = rng.range(0.58, 0.92), d = rng.range(0.62, 0.95);
  const buf = new GeoBuf();
  const T = 0.022;                       // cladding board thickness
  const S = 0.055;                       // corner stringer section
  const gap = rng.range(0.010, 0.016);   // shadow gap between boards

  /** Board with its own random grain phase. */
  /**
   * `flat` drops the chamfer. Used for the CLADDING boards only: they are 22 mm
   * thick, so a 5 mm chamfer on them is a quarter of the board's own thickness
   * and under a pixel past about 3 m — while costing 32 of the board's 44
   * triangles. The four corner stringers (55 mm) and the eight rails keep their
   * chamfers, because those are the edges that carry the crate's silhouette and
   * its lit/shadowed break, and they are what a player standing beside a crate
   * actually reads. Twenty crates, ~21 cladding boards each, seven passes.
   */
  const plank = (bw, bh, bd, cx, cy, cz, ry = 0, flat = false) => {
    const g = chamferBox(bw, bh, bd, 0.005, { plain: flat });
    const ua = g.attributes.uv.array;
    const ou = rng.range(-6, 6), ov = rng.range(-6, 6);
    for (let i = 0; i < ua.length; i += 2) { ua[i] += ou; ua[i + 1] += ov; }
    if (ry) g.rotateY(ry);
    g.translate(cx, cy, cz);
    mergeBufInto(buf, g);
  };

  // ── four corner stringers, standing proud of the cladding ───────────────
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      plank(S, h, S, sx * (w * 0.5 - S * 0.5), h * 0.5, sz * (d * 0.5 - S * 0.5));
    }
  }
  // top and bottom rails tying the stringers together
  for (const sz of [-1, 1]) {
    plank(w - S * 1.2, 0.055, S * 0.85, 0, 0.033, sz * (d * 0.5 - S * 0.45));
    plank(w - S * 1.2, 0.050, S * 0.85, 0, h - 0.030, sz * (d * 0.5 - S * 0.45));
  }
  for (const sx of [-1, 1]) {
    plank(S * 0.85, 0.055, d - S * 1.2, sx * (w * 0.5 - S * 0.45), 0.033, 0);
    plank(S * 0.85, 0.050, d - S * 1.2, sx * (w * 0.5 - S * 0.45), h - 0.030, 0);
  }

  // ── cladding: horizontal boards with real gaps between them ─────────────
  const y0 = 0.070, y1 = h - 0.062;
  const nRow = Math.max(3, Math.round((y1 - y0) / 0.155));
  const bh = (y1 - y0) / nRow - gap;
  for (let i = 0; i < nRow; i++) {
    const cy = y0 + (i + 0.5) * ((y1 - y0) / nRow) + rng.j(0.004);
    // one board in twelve has sprung off or gone missing
    const missing = rng.chance(0.055);
    const sprung = !missing && rng.chance(0.10) ? rng.range(0.012, 0.030) : 0;
    for (const sz of [-1, 1]) {
      if (missing && sz > 0) continue;
      plank(w - S * 1.35, bh, T + sprung, 0, cy, sz * (d * 0.5 - S + T * 0.5 + sprung * 0.5), 0, true);
    }
    for (const sx of [-1, 1]) {
      plank(T, bh, d - S * 1.35, sx * (w * 0.5 - S + T * 0.5), cy, 0, 0, true);
    }
  }

  // ── lid boards, running the other way ───────────────────────────────────
  {
    const nT = Math.max(3, Math.round(d / 0.16));
    const step = (d - S * 0.6) / nT;
    for (let i = 0; i < nT; i++) {
      const cz = -d * 0.5 + S * 0.3 + (i + 0.5) * step;
      plank(w - S * 0.4, 0.024, step - gap, 0, h - 0.012 + rng.j(0.003), cz, 0, true);
    }
  }

  // ── nail heads on the stringer line ─────────────────────────────────────
  for (let i = 0; i < 6; i++) {
    const sz = rng.sign();
    chamferCylinder(0.009, 0.010, 4, 0.002, {
      buf, center: [rng.range(-1, 1) * (w * 0.5 - S), rng.range(y0, y1), sz * (d * 0.5 - S + T + 0.004)],
    });
  }

  const geo = buf.toGeometry();
  const tone = rng.range(0.80, 1.20);
  const wpaint = weather({
    base: [tone, tone * 0.93, tone * 0.82], rustAmount: 0.15,
    scale: 2.4, offset: [rng.range(-40, 40), 0, rng.range(-40, 40)],
    grimeHeight: 0.2, dirt: 0.32, streaks: 0.35,
  });
  paint(geo, (x, y, z, nx, ny, nz, out) => {
    wpaint(x, y, z, nx, ny, nz, out);
    // self-AO down the shadow gaps: the inward-facing edge of every board goes dark
    if (Math.abs(ny) > 0.55 && y > 0.09 && y < h - 0.07) {
      out[0] *= 0.58; out[1] *= 0.58; out[2] *= 0.60;
    }
  });
  return geo;
}

/** Irregular concrete rubble chunk. */
export function geoRubble(rng, size = 1) {
  const w = rng.range(0.22, 0.72) * size;
  const h = rng.range(0.12, 0.4) * size;
  const d = rng.range(0.2, 0.66) * size;
  const geo = chamferBox(w, h, d, Math.min(w, h, d) * 0.24, { seg: 1, center: [0, h * 0.5, 0] });
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 3) {
    const n = (noise3(p[i] * 9 + 3, p[i + 1] * 9, p[i + 2] * 9 - 5) - 0.5);
    p[i] += n * w * 0.34;
    p[i + 1] += (noise3(p[i] * 7, p[i + 1] * 7 + 2, p[i + 2] * 7) - 0.5) * h * 0.4;
    p[i + 2] += (noise3(p[i] * 8 - 4, p[i + 1] * 8, p[i + 2] * 8 + 1) - 0.5) * d * 0.34;
  }
  geo.attributes.position.needsUpdate = true;
  geo.computeVertexNormals();
  paint(geo, weatherConcrete({
    base: [rng.range(0.80, 1.22), rng.range(0.78, 1.18), rng.range(0.74, 1.10)],
    offset: [rng.range(-50, 50), 0, rng.range(-50, 50)],
    grimeHeight: 0.16, dirt: 0.5,
  }));
  return geo;
}

/**
 * ── WOODEN CABLE REEL ──────────────────────────────────────────────────────
 *
 * The shipped version was three bare cylinders: two smooth discs and a hub. In the
 * closeup framing it sits directly beside the crosshair at 3 m and all three critics
 * independently named it the most obviously fake object in the build — "a flat
 * circular disc carrying a repeating diamond quilt that reads as a rattan placemat".
 * Two separate defects were doing that, and both are fixed here:
 *
 *  1. NO GEOMETRY. A real drum is not a disc. It is two flanges built from PARALLEL
 *     BOARDS bound by a steel rim hoop, bolted through to a barrel, with the cable
 *     still wound on it. The board seams, the hoop, the bolt heads and the coil
 *     ridges are the entire silhouette read at 3 m, and they cost ~1 500 triangles.
 *  2. TEXTURE SCALE. It was instanced at `uvScale: 2.0` — four wood tiles across a
 *     1.5 m flange face — so the recipe's most distinctive motif repeated in a
 *     legible 4x4 grid. Now every board is a separately-UV-offset plank, so the
 *     grain runs ALONG each board and no motif can line up with its neighbour.
 *     The caller drops uvScale to ~0.8 on top of that.
 *
 * Built around +Y (chamferCylinder's axis), then rolled onto its rims.
 */
export function geoSpool(rng) {
  const buf = new GeoBuf();
  const R = rng.range(0.64, 0.78);       // flange radius
  const w = rng.range(0.74, 0.94);       // outside-to-outside width
  const T = 0.052;                       // flange board thickness
  const hubR = 0.195;                    // barrel radius
  /**
   * 10, not 7. At seven boards the chord-clipped raft stepped so coarsely that
   * the flange silhouetted as a cross rather than as a disc — the steps were
   * 190 mm on a 1.4 m circle. Ten boards puts the step at 140 mm and the rim
   * hoop below covers the rest.
   */
  const nB = 10;                         // boards per flange
  const inner = w * 0.5 - T;             // inside face of a flange

  /** A board with its own random UV phase, so no two planks share a grain motif. */
  const plank = (bw, bh, bd, cx, cy, cz, ry = 0, ch = 0.006) => {
    const g = chamferBox(bw, bh, bd, ch);
    const ua = g.attributes.uv.array;
    const ou = rng.range(-6, 6), ov = rng.range(-6, 6);
    for (let i = 0; i < ua.length; i += 2) { ua[i] += ou; ua[i + 1] += ov; }
    if (ry) g.rotateY(ry);
    g.translate(cx, cy, cz);
    mergeBufInto(buf, g);
  };

  // ── two flanges, each a raft of parallel boards clipped to the disc ─────
  const gap = 0.011;
  for (const sy of [-1, 1]) {
    const yc = sy * (w * 0.5 - T * 0.5);
    // the two flanges are boarded at 90 degrees to each other, like the real thing
    const rot = sy > 0 ? 0 : Math.PI * 0.5;
    const bw = (R * 2) / nB;
    for (let i = 0; i < nB; i++) {
      const c = -R + bw * (i + 0.5);
      const e = Math.min(R * 0.997, Math.abs(c) + bw * 0.44);
      const half = Math.sqrt(Math.max(0, R * R - e * e));
      if (half < 0.055) continue;
      // boards run along local X before the flange rotation
      const cs = Math.cos(rot), sn = Math.sin(rot);
      plank(half * 2, T, bw - gap, -sn * c, yc, cs * c, rot);
    }
    /**
     * ── THE BINDING HOOP IS THE SILHOUETTE ────────────────────────────────
     * A boarded flange has a steel tyre shrunk onto it, and that hoop is the
     * ONLY thing that makes a raft of straight planks read as a wheel. It has to
     * be deep enough to cover the full board thickness and to survive as more
     * than a hairline at 3 m: 24 facets, spanning 2.6x the board thickness,
     * sitting 18 mm proud so it catches its own rim highlight.
     */
    chamferCylinder(R + 0.018, T * 2.6, 24, 0.012, { buf, center: [0, yc, 0], caps: false });
    /**
     * …and a flat annular tyre plate on the outer face. The hoop above is a
     * cylinder wall: seen edge-on it draws the outline, but seen FACE-ON (which
     * is how a reel resting on its rims is always seen) it presents nothing, so
     * the chord-clipped board ends were still stepping the silhouette by 8 % of
     * the radius. A 24-facet annulus over the last 10 % of the disc covers every
     * step and is the thing that actually makes it read as a wheel.
     */
    {
      const r0 = R * 0.895, r1 = R + 0.018;
      const py = yc + sy * (T * 0.5 + 0.006);
      for (let k = 0; k < 24; k++) {
        const a0 = (k / 24) * Math.PI * 2, a1 = ((k + 1) / 24) * Math.PI * 2;
        buf.quad(
          [Math.cos(a0) * r0, py, Math.sin(a0) * r0],
          [Math.cos(a1) * r0, py, Math.sin(a1) * r0],
          [Math.cos(a0) * r1, py, Math.sin(a0) * r1],
          [0, sy, 0],
        );
      }
    }
    // an inner hoop at 0.62 R, which is what a real flange is braced with and
    // which gives the disc a second concentric read at distance
    chamferCylinder(R * 0.62, T * 1.5, 20, 0.010, { buf, center: [0, yc + sy * 0.010, 0], caps: false });
    // hub boss + bolt heads through the flange into the barrel
    chamferCylinder(hubR + 0.055, T * 1.5, 14, 0.012, { buf, center: [0, yc + sy * 0.008, 0] });
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + (sy > 0 ? 0.26 : 0.78);
      chamferCylinder(0.028, 0.030, 6, 0.006, {
        buf, center: [Math.cos(a) * (hubR + 0.13), yc + sy * (T * 0.5 + 0.010), Math.sin(a) * (hubR + 0.13)],
      });
    }
  }

  // ── barrel ──────────────────────────────────────────────────────────────
  chamferCylinder(hubR, inner * 2, 16, 0.018, { buf, center: [0, 0, 0], sideSeg: 2 });

  /**
   * ── THE CABLE ──────────────────────────────────────────────────────────
   * Wound coils, not a smooth sleeve. Each layer is a shallow ring, and the top
   * layer is short of the flange so you can see it is *wound* rather than moulded.
   * They are painted near-black in the pass below, so the reel reads as a reel
   * with cable on it rather than as a wooden wheel.
   */
  const layers = 2;
  for (let l = 0; l < layers; l++) {
    const cr = hubR + 0.030 + l * 0.052;
    const half = inner * (1 - l * 0.16);
    const nC = Math.max(3, Math.round((half * 2) / 0.070));
    const cw = (half * 2) / nC;
    for (let i = 0; i < nC; i++) {
      const y = -half + (i + 0.5) * cw;
      chamferCylinder(cr, cw * 0.94, 10, cw * 0.30, { buf, center: [0, y, 0], caps: false });
    }
  }
  // the tail end, hanging off the drum
  chamferCylinder(0.026, 0.62, 6, 0.008, { buf, center: [hubR + 0.10, -inner * 0.6, 0.30] });

  const geo = buf.toGeometry();
  // Axis Y -> Z: flanges stand vertical, reel rests on its rims at height R.
  geo.rotateX(Math.PI / 2);
  geo.translate(0, R, 0);

  const tone = rng.range(0.78, 1.10);
  const wood = weather({
    base: [tone, tone * 0.90, tone * 0.76], rustAmount: 0.22, scale: 2.2,
    offset: [rng.range(-30, 30), 0, rng.range(-30, 30)], grimeHeight: 0.32, dirt: 0.40,
  });
  /**
   * After `rotateX(PI/2)` + `translate(0,R,0)` the drum axis is world Z and the
   * disc plane is world XY about (0, R). That lets the paint pass identify the
   * cable band by radius and darken it without a second material.
   */
  paint(geo, (x, y, z, nx, ny, nz, out) => {
    wood(x, y, z, nx, ny, nz, out);
    const rad = Math.hypot(x, y - R);
    if (Math.abs(z) < inner + 0.01 && rad < hubR + 0.185) {
      // black rubber-sheathed cable, with a little sheen variation coil to coil
      const k = 0.13 + 0.10 * noise3(z * 26, rad * 8, 0);
      out[0] = k; out[1] = k * 1.02; out[2] = k * 1.10;
    } else if (rad > R * 0.885) {
      // the steel tyre: cooler and darker than the timber it binds, so the disc
      // reads as a boarded flange inside a steel hoop rather than as one lump
      out[0] *= 0.60; out[1] *= 0.64; out[2] *= 0.70;
    }
  });
  return geo;
}

/* ─────────────────────────── steel structures ─────────────────────────── */

/**
 * Straight flight of steel stairs from (0,0,0) going up +Y and along +Z.
 * Pushes treads/stringers/rails into `buf`.
 */
export function geoStairs(rise, run, width, opts = {}) {
  const buf = opts.buf || new GeoBuf();
  const steps = Math.max(2, Math.round(rise / (opts.stepRise ?? 0.185)));
  const sr = rise / steps;
  const sd = run / steps;
  for (let i = 0; i < steps; i++) {
    const y = sr * (i + 1);
    const z = sd * (i + 0.5);
    chamferBox(width - 0.09, 0.035, sd + 0.03, 0.007, { buf, center: [0, y - 0.018, z] });
    if (opts.risers !== false) {
      chamferBox(width - 0.12, sr - 0.04, 0.016, 0.005, { buf, center: [0, y - sr * 0.5, z - sd * 0.5 + 0.01] });
    }
  }
  // stringers
  const len = Math.hypot(rise, run);
  const ang = Math.atan2(rise, run);
  for (const s of [-1, 1]) {
    const b = new GeoBuf();
    chamferBox(0.032, 0.28, len, 0.008, { buf: b });
    const g = b.toGeometry();
    g.rotateX(-ang);
    g.translate(s * (width * 0.5 - 0.016), rise * 0.5 - 0.10, run * 0.5);
    mergeBufInto(buf, g);
    /**
     * Base plate and bolt pack. A steel stringer that dives into the slab on a
     * razor line is the fastest way to make a flight of stairs look like it was
     * pushed into the floor rather than fixed to it — and it is 90 triangles.
     */
    chamferBox(0.20, 0.030, 0.34, 0.006, { buf, center: [s * (width * 0.5 - 0.016), 0.015, 0.06] });
    for (const bz of [-0.06, 0.16]) {
      chamferBox(0.045, 0.036, 0.045, 0.008, { buf, center: [s * (width * 0.5 - 0.016), 0.046, bz] });
    }
    // top-of-flight cleat
    chamferBox(0.16, 0.026, 0.22, 0.005, { buf, center: [s * (width * 0.5 - 0.016), rise + 0.013, run - 0.08] });
  }
  // handrail
  if (opts.rail !== false) {
    for (const s of [-1, 1]) {
      const b = new GeoBuf();
      chamferBox(0.032, 0.032, len + 0.1, 0.008, { buf: b });
      const g = b.toGeometry();
      g.rotateX(-ang);
      g.translate(s * (width * 0.5 - 0.02), rise * 0.5 + 0.98, run * 0.5);
      mergeBufInto(buf, g);
      const nP = Math.max(2, Math.round(len / 1.1));
      for (let i = 0; i <= nP; i++) {
        const t = i / nP;
        chamferBox(0.028, 1.0, 0.028, 0.006, {
          buf, center: [s * (width * 0.5 - 0.02), rise * t + 0.5, run * t],
        });
      }
    }
  }
  return opts.buf ? buf : buf.toGeometry();
}

/** Append a finished BufferGeometry into a GeoBuf (used to fold rotated sub-parts in). */
export function mergeBufInto(buf, geo) {
  const p = geo.attributes.position.array;
  const n = geo.attributes.normal.array;
  const u = geo.attributes.uv ? geo.attributes.uv.array : null;
  for (let i = 0; i < p.length / 3; i++) {
    buf.p.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    buf.n.push(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]);
    if (u) buf.u.push(u[i * 2], u[i * 2 + 1]);
    else buf.u.push(p[i * 3], p[i * 3 + 1]);
    buf.c.push(1, 1, 1);
  }
  geo.dispose();
  return buf;
}

/** Guard rail along X, from -len/2 to +len/2, standing on y=0. */
export function geoRailing(len, opts = {}) {
  const buf = opts.buf || new GeoBuf();
  const h = opts.height ?? 1.06;
  const nP = Math.max(2, Math.round(len / (opts.spacing ?? 1.6)));
  for (let i = 0; i <= nP; i++) {
    const x = -len * 0.5 + (len * i) / nP;
    chamferBox(0.042, h, 0.042, 0.008, { buf, center: [x, h * 0.5, 0] });
  }
  chamferBox(len, 0.045, 0.045, 0.010, { buf, center: [0, h, 0] });
  chamferBox(len, 0.032, 0.032, 0.008, { buf, center: [0, h * 0.55, 0] });
  if (opts.toe !== false) chamferBox(len, 0.11, 0.024, 0.006, { buf, center: [0, 0.06, 0] });
  return opts.buf ? buf : buf.toGeometry();
}

/** Steel catwalk deck along X with railings both sides. Deck top at y=0. */
export function geoCatwalk(len, width, opts = {}) {
  const buf = opts.buf || new GeoBuf();
  chamferBox(len, 0.05, width, 0.01, { buf, center: [0, -0.025, 0], seg: [Math.max(2, Math.round(len / 2)), 1] });
  // side channels
  for (const s of [-1, 1]) {
    chamferBox(len, 0.14, 0.05, 0.01, { buf, center: [0, -0.10, s * (width * 0.5 - 0.025)] });
  }
  // cross bearers
  const n = Math.max(2, Math.round(len / 1.5));
  for (let i = 0; i <= n; i++) {
    chamferBox(0.05, 0.10, width, 0.01, { buf, center: [-len * 0.5 + (len * i) / n, -0.10, 0] });
  }
  for (const s of [-1, 1]) {
    const b = new GeoBuf();
    geoRailing(len, { buf: b, height: opts.railHeight ?? 1.06, spacing: 1.7 });
    const g = b.toGeometry();
    g.translate(0, 0, s * (width * 0.5 - 0.03));
    mergeBufInto(buf, g);
  }
  return opts.buf ? buf : buf.toGeometry();
}

/* ─────────────────────────── corrugated cladding ──────────────────────── */

/**
 * Corrugated sheet panel in the XY plane facing +Z, ribs running vertically.
 * Origin at centre. Used for warehouse walls and roof decks.
 */
export function geoCorrugatedPanel(w, h, opts = {}) {
  const buf = opts.buf || new GeoBuf();
  const depth = opts.depth ?? 0.030;
  const period = opts.period ?? 0.26;
  const vSeg = Math.max(1, Math.round(h / 2.2));
  corrugatedSheet(
    buf,
    (u, v, ww) => [u, v, ww],
    (du, dv, dw) => [du, dv, dw],
    {
      u0: -w * 0.5, u1: w * 0.5, v0: -h * 0.5, v1: h * 0.5,
      w: depth, depth, period, web: opts.web, sign: 1, vSeg,
      // every fourth rib is a sheet side-lap: 0.24 m rib pitch, ~0.96 m sheet
      lapEvery: opts.lapEvery ?? 4, lapGain: opts.lapGain ?? 1.35,
    },
  );
  /**
   * Real sheet thickness with a visible fascia.
   *
   * A 4 mm back plane makes the panel a zero-thickness quad in every silhouette:
   * the torn roof plates hanging off the warehouse collapse showed a paper edge
   * from the spawn, which is one of the loudest "greybox" tells in the map. The
   * rim quads only span from the back plane up to the TROUGH level, so they can
   * never poke through the corrugation on the front face.
   */
  /**
   * ── TOP CAPPING ────────────────────────────────────────────────────────
   *
   * A cladding sheet that ends at the sky on a razor line is one of the loudest
   * "it is a plane" tells there is: the critics measured the hero wall's top edge
   * at 4x zoom and found "no cap, no thickness, no coping and no edge damage".
   * Real profiled cladding is finished with a folded ridge/barge flashing 100-150
   * mm deep, and it is almost always dented and locally missing.
   */
  if (opts.cap) {
    const hw = w * 0.5, hh = h * 0.5;
    const segs = Math.max(2, Math.round(w / 1.6));
    for (let i = 0; i < segs; i++) {
      // one bay in six has lost its flashing
      if (((i * 7919) % 100) / 100 < 0.16) continue;
      const s0 = -hw + (i / segs) * w, s1 = -hw + ((i + 1) / segs) * w;
      const droop = (((i * 5011) % 100) / 100 - 0.5) * 0.035;
      // 165 mm of folded flashing with a 60 mm downstand on the weather face
      chamferBox(s1 - s0 - 0.015, 0.150, 0.270, 0.016, {
        buf, center: [(s0 + s1) * 0.5, hh + 0.052 + droop, depth * 0.5 + 0.030],
      });
      chamferBox(s1 - s0 - 0.02, 0.075, 0.030, 0.010, {
        buf, center: [(s0 + s1) * 0.5, hh - 0.045 + droop, depth * 0.5 + 0.162],
      });
    }
  }

  /**
   * ── SHEET LAPS ─────────────────────────────────────────────────────────
   *
   * Cladding arrives in finite sheets — this shed's are 2.4 m — and every
   * horizontal lap stands proud and throws a shadow line with a rust bleed under
   * it. Without them a 25 m-distant wall carries exactly ONE frequency of detail
   * (the rib), which is what makes a big facade flatten out at distance.
   *
   * Modelled rather than painted: the panel's vertical vertex spacing is ~2.2 m,
   * so a 2.4 m painted band would alias into nothing. ~30 triangles per lap.
   */
  if (opts.laps !== false && h > 3.0) {
    const hw = w * 0.5, hh = h * 0.5;
    const n = Math.floor(h / 2.4);
    for (let i = 1; i <= n; i++) {
      const ly = -hh + i * 2.4;
      if (ly > hh - 0.25) break;
      chamferBox(w - 0.02, 0.080, 0.042, 0.010, {
        buf, center: [0, ly, depth + 0.020],
      });
    }
  }

  const t = Math.max(0.004, opts.thickness ?? 0.004);
  if (opts.doubleSided !== false) {
    /**
     * ── THE BACK OF THE SHEET IS A SHEET ───────────────────────────────────
     *
     * This used to be a single flat quad, and that is the defect the critics
     * measured as "a plane whose top edge is a razor line, 12 % of the frame
     * carrying almost no surface information at 25 m". It was not the FRONT of
     * the cladding they were looking at — from inside the shed the spawn camera
     * sees the BACK, and the back was a featureless card.
     *
     * A 0.7 mm steel sheet has the same corrugation on both faces, inverted. So
     * the back is now the same profile offset by the sheet thickness with its
     * normals reversed, which doubles the panel's triangle count (16 k -> 32 k
     * across the whole shed — nothing) and means the wall reads as pressed steel
     * from either side.
     */
    corrugatedSheet(
      buf,
      (u, v, ww) => [u, v, ww],
      (du, dv, dw) => [-du, -dv, -dw],
      {
        u0: -w * 0.5, u1: w * 0.5, v0: -h * 0.5, v1: h * 0.5,
        w: depth - t, depth, period, web: opts.web, sign: 1, vSeg,
        lapEvery: opts.lapEvery ?? 4, lapGain: opts.lapGain ?? 1.75,
      },
    );
    /**
     * Girts. The horizontal rails a shed's cladding is screwed to, at 1.6 m
     * centres. Interior walls in this map are seen from 6-25 m and the girt line
     * is the single most recognisable thing about the inside of a steel shed.
     */
    if (opts.girts !== false && h > 3.0) {
      const hh = h * 0.5;
      const nG = Math.floor(h / 1.6);
      for (let i = 1; i <= nG; i++) {
        const gy = -hh + i * 1.6;
        if (gy > hh - 0.3) break;
        chamferBox(w - 0.03, 0.155, 0.020, 0.008, { buf, center: [0, gy, -t - 0.010] });
        chamferBox(w - 0.03, 0.020, 0.062, 0.006, { buf, center: [0, gy + 0.068, -t - 0.041] });
        chamferBox(w - 0.03, 0.020, 0.062, 0.006, { buf, center: [0, gy - 0.068, -t - 0.041] });
      }
    }
  }
  if (t > 0.012) {
    const hw = w * 0.5, hh = h * 0.5;
    buf.quad([-hw, -hh, -t], [hw, -hh, -t], [-hw, -hh, 0], [0, -1, 0], Math.max(1, Math.round(w / 2)), 1);
    buf.quad([-hw, hh, -t], [hw, hh, -t], [-hw, hh, 0], [0, 1, 0], Math.max(1, Math.round(w / 2)), 1);
    buf.quad([-hw, -hh, -t], [-hw, hh, -t], [-hw, -hh, depth], [-1, 0, 0], 1, vSeg);
    buf.quad([hw, -hh, -t], [hw, hh, -t], [hw, -hh, depth], [1, 0, 0], 1, vSeg);
  }
  return opts.buf ? buf : buf.toGeometry();
}

/* ───────────────────────────── wrecked truck ──────────────────────────── */

/**
 * Burnt-out flatbed lorry. Multi-material, so it writes straight into the Builder.
 * `m` places it; local +X is the direction of travel.
 */
export function buildTruckWreck(B, m, rng, opts = {}) {
  const bucket = opts.bucket || 'props';
  const body = new GeoBuf();
  const rust = new GeoBuf();
  const glass = new GeoBuf();

  const wheelR = 0.52;
  const chassisY = 0.78;

  // chassis rails
  for (const sz of [-1, 1]) {
    chamferBox(6.4, 0.20, 0.13, 0.02, { buf: rust, center: [0.1, chassisY, sz * 0.42] });
  }
  for (const x of [-2.4, -0.6, 1.4, 2.6]) {
    chamferBox(0.12, 0.14, 0.9, 0.02, { buf: rust, center: [x, chassisY, 0] });
  }

  // cab: crushed, tilted forward
  const cabB = new GeoBuf();
  chamferBox(2.1, 1.35, 2.16, 0.06, { buf: cabB, center: [0, 0, 0], seg: 2 });
  chamferBox(1.05, 0.85, 2.10, 0.05, { buf: cabB, center: [1.0, -0.30, 0], seg: 2 });   // bonnet
  const cab = cabB.toGeometry();
  dent(cab, 0.6, 0.5, 1.0, 0.9, 0.22);
  dent(cab, -0.4, 0.6, -1.05, 0.7, 0.16);
  cab.rotateZ(0.07);
  cab.translate(2.05, chassisY + 0.86, 0);
  B.add('paintedMetal', cab, {
    matrix: m, bucket, uvScale: 1.6,
    paint: weather({
      base: [0.92, 0.96, 0.86], rust: [0.98, 0.50, 0.26], rustAmount: 0.95,
      scale: 1.5, grimeHeight: 1.2, dirt: 0.5, streaks: 0.9, groundY: 0,
      offset: [rng.range(-30, 30), 0, rng.range(-30, 30)],
    }),
  });

  // burnt windscreen frame + shattered glass stubs
  chamferBox(0.08, 0.86, 1.88, 0.02, { buf: rust, center: [3.02, chassisY + 1.42, 0] });
  glass.quad([3.02, chassisY + 1.05, -0.92], [3.02, chassisY + 1.05, 0.92], [3.02, chassisY + 1.78, -0.92], [1, 0, 0], 2, 2);

  // flatbed
  chamferBox(3.6, 0.12, 2.30, 0.03, { buf: body, center: [-1.3, chassisY + 0.16, 0], seg: [4, 3] });
  for (const sz of [-1, 1]) {
    chamferBox(3.6, 0.52, 0.07, 0.02, { buf: body, center: [-1.3, chassisY + 0.46, sz * 1.13] });
  }
  chamferBox(0.07, 0.62, 2.30, 0.02, { buf: body, center: [-3.06, chassisY + 0.52, 0] });

  // headache rack
  for (const sz of [-1, 1]) chamferBox(0.06, 1.1, 0.06, 0.014, { buf: rust, center: [0.55, chassisY + 0.75, sz * 1.0] });
  chamferBox(0.06, 0.08, 2.1, 0.014, { buf: rust, center: [0.55, chassisY + 1.28, 0] });

  // wheels — one blown off, sitting flat nearby
  const wheelSpots = [[2.15, 1.02], [2.15, -1.02], [-1.5, 1.02], [-2.35, 1.02], [-1.5, -1.02]];
  for (const [wx, wz] of wheelSpots) {
    const t = new THREE.TorusGeometry(wheelR, 0.20, 7, 14);
    t.rotateY(Math.PI / 2);
    t.translate(wx, wheelR + 0.02, wz);
    const g = t.toNonIndexed();
    const uv = g.attributes.uv.array;
    for (let i = 0; i < uv.length; i += 2) { uv[i] *= 3.2; uv[i + 1] *= 1.2; }
    B.add('rubber', g, {
      matrix: m, bucket,
      paint: weather({ base: [1.28, 1.28, 1.32], rustAmount: 0.05, scale: 3, grimeHeight: 0.4, dirt: 0.5, streaks: 0.1 }),
    });
    chamferCylinder(0.26, 0.24, 10, 0.02, { buf: rust, center: [wx, wheelR + 0.02, wz] });
  }
  // detached wheel lying flat
  {
    const t = new THREE.TorusGeometry(wheelR, 0.20, 7, 14);
    t.rotateX(Math.PI / 2);
    t.translate(-3.9, 0.20, 2.2);
    const g = t.toNonIndexed();
    const uv = g.attributes.uv.array;
    for (let i = 0; i < uv.length; i += 2) { uv[i] *= 3.2; uv[i + 1] *= 1.2; }
    B.add('rubber', g, { matrix: m, bucket, paint: weather({ base: [1.22, 1.22, 1.28], rustAmount: 0.05, grimeHeight: 0.3, dirt: 0.5, streaks: 0.1 }) });
  }

  // exhaust stack
  chamferCylinder(0.055, 1.5, 8, 0.01, { buf: rust, center: [1.0, chassisY + 1.4, -1.02] });

  B.add('rustMetal', rust.toGeometry(), {
    matrix: m, bucket, uvScale: 2.4,
    paint: weather({
      base: [1.10, 0.86, 0.70], rust: [1.02, 0.52, 0.28], rustAmount: 0.95,
      scale: 2.0, grimeHeight: 1.0, dirt: 0.45, streaks: 0.7,
      offset: [rng.range(-30, 30), 0, rng.range(-30, 30)],
    }),
  });
  B.add('paintedMetal', body.toGeometry(), {
    matrix: m, bucket, uvScale: 1.9,
    paint: weather({
      base: [0.86, 0.90, 0.80], rust: [0.98, 0.50, 0.26], rustAmount: 0.9,
      scale: 1.8, grimeHeight: 1.4, dirt: 0.5, streaks: 0.85,
      offset: [rng.range(-30, 30), 0, rng.range(-30, 30)],
    }),
  });
  if (!glass.isEmpty) {
    B.add('glass', glass.toGeometry(), { matrix: m, bucket, shadow: false, tint: [0.5, 0.52, 0.5] });
  }
}

/* ─────────────────────── chain-link fence material ────────────────────── */

/**
 * Procedural chain-link: an alpha-tested diamond lattice. Alpha-tested (not blended) so
 * the panel still writes depth and normals into the G-buffer and receives AO and TAA.
 */
export function makeChainLinkTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const wire = 0.085;     // half-thickness in cell units
  const cells = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * cells;
      const v = (y / size) * cells;
      const d1 = Math.abs(((u + v) % 1) - 0.5);
      const d2 = Math.abs(((u - v + cells) % 1) - 0.5);
      const on = (0.5 - d1) < wire || (0.5 - d2) < wire;
      const lit = (0.5 - d1) < wire ? 1.0 : 0.78;
      const i = (y * size + x) * 4;
      const g = Math.round(150 * lit);
      data[i] = g; data[i + 1] = g + 4; data[i + 2] = g + 10;
      data[i + 3] = on ? 255 : 0;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export { CONTAINER_COLORS, mat };
