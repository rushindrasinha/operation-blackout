/**
 * OPERATION BLACKOUT — procedural noise & field toolkit.
 * OWNER: materials agent.
 *
 * Pure JavaScript, zero imports. This file is loaded both on the main thread and
 * inside a module Worker, so it must never touch THREE, DOM or window.
 *
 * Everything here operates on Float32Array "fields" of size W*H laid out row-major
 * with y increasing downward. Every generator is *seamlessly tileable* — the lattice
 * and cellular grids wrap, blurs wrap, streaks wrap. That is what lets a 1024px
 * texture cover a 40m wall without a visible seam.
 */

/* ────────────────────────────── rng ────────────────────────────── */

export function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ───────────────────────── scalar helpers ───────────────────────── */

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function sstep(edge0, edge1, x) {
  let t = (x - edge0) / (edge1 - edge0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/* ──────────────────────── value-noise fbm ──────────────────────── */

function lattice(n, seed) {
  const rand = mulberry32(seed);
  const a = new Float32Array(n * n);
  for (let i = 0; i < a.length; i++) a[i] = rand();
  return a;
}

function accumulateOctave(out, W, H, lat, n, amp, ridged) {
  const xi0 = new Int32Array(W);
  const xi1 = new Int32Array(W);
  const xw = new Float32Array(W);
  const sx = n / W;
  for (let x = 0; x < W; x++) {
    const fx = x * sx;
    const i0 = Math.floor(fx);
    const f = fx - i0;
    const a = ((i0 % n) + n) % n;
    xi0[x] = a;
    xi1[x] = (a + 1) % n;
    xw[x] = f * f * f * (f * (f * 6 - 15) + 10);
  }
  const sy = n / H;
  for (let y = 0; y < H; y++) {
    const fy = y * sy;
    const j0 = Math.floor(fy);
    const f = fy - j0;
    const wy = f * f * f * (f * (f * 6 - 15) + 10);
    const r0 = (((j0 % n) + n) % n) * n;
    const r1 = ((((j0 + 1) % n) + n) % n) * n;
    const o = y * W;
    if (ridged) {
      for (let x = 0; x < W; x++) {
        const w = xw[x];
        const i0 = xi0[x], i1 = xi1[x];
        const t = lat[r0 + i0] + (lat[r0 + i1] - lat[r0 + i0]) * w;
        const b = lat[r1 + i0] + (lat[r1 + i1] - lat[r1 + i0]) * w;
        let v = t + (b - t) * wy;
        v = 1 - Math.abs(v * 2 - 1);
        out[o + x] += v * amp;
      }
    } else {
      for (let x = 0; x < W; x++) {
        const w = xw[x];
        const i0 = xi0[x], i1 = xi1[x];
        const t = lat[r0 + i0] + (lat[r0 + i1] - lat[r0 + i0]) * w;
        const b = lat[r1 + i0] + (lat[r1 + i1] - lat[r1 + i0]) * w;
        out[o + x] += (t + (b - t) * wy) * amp;
      }
    }
  }
}

/**
 * Multi-octave fractal brownian motion. Returns a field normalised to 0..1.
 *   cells      — lattice cells across the texture at octave 0 (low = big blotches)
 *   octaves    — 5..7 for anything that ships
 *   gain       — amplitude falloff per octave
 *   lacunarity — frequency growth per octave
 *   ridged     — ridged multifractal (veins, cracks, fibres)
 */
export function fbm(W, H, o = {}) {
  const octaves = o.octaves ?? 6;
  const seed = (o.seed ?? 1) >>> 0;
  const gain = o.gain ?? 0.5;
  const lac = o.lacunarity ?? 2.0;
  const ridged = !!o.ridged;
  const sx = o.scaleX ?? 1;
  const sy = o.scaleY ?? 1;
  let cells = o.cells ?? 4;
  const out = new Float32Array(W * H);
  const cap = Math.max(W, H);
  let amp = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = Math.max(2, Math.round(cells));
    if (n > cap) break;
    // Anisotropic lattices (stretched grain, wood, brushed metal) use a rectangular
    // lattice by feeding a different cell count per axis via two passes of the same
    // helper — cheaper here to just build a square lattice at the larger count.
    const nx = Math.max(2, Math.round(cells * sx));
    const ny = Math.max(2, Math.round(cells * sy));
    if (nx === ny) {
      accumulateOctave(out, W, H, lattice(n, seed + i * 7919 + 13), n, amp, ridged);
    } else {
      accumulateRect(out, W, H, latticeRect(nx, ny, seed + i * 7919 + 13), nx, ny, amp, ridged);
    }
    norm += amp;
    amp *= gain;
    cells *= lac;
  }
  if (norm > 0) {
    const inv = 1 / norm;
    for (let i = 0; i < out.length; i++) out[i] *= inv;
  }
  return out;
}

/**
 * BAND-LIMITED FINE GRAIN — use this, never a raw `fbm({ cells: W/3 })`.
 *
 * WHY THIS EXISTS. Every recipe in the library wanted a "fine grain" octave and
 * every one of them asked for it the same wrong way: `fbm(W, H, { cells: W/3,
 * octaves: 3 })`. `fbm` multiplies `cells` by the lacunarity each octave, so that
 * request builds lattices at W/3, 2W/3 and 4W/3 nodes — the last two of which are
 * AT OR PAST NYQUIST. One lattice node per texel is not noise with a scale, it is
 * white noise, and white noise in a PBR map does three bad things at once:
 *
 *   1. It aliases. A per-texel height step becomes a per-texel normal step, and a
 *      raking sun turns that into the salt-and-pepper sparkle the review read as
 *      "coarse asphalt grit" on the crate and as glitter on the painted panels.
 *   2. It DISAPPEARS the moment the surface mips. Mip 1 is the average of four
 *      texels of white noise, i.e. a constant. That is why the review could say
 *      "no fine grain at any distance" about surfaces that demonstrably had a
 *      grain field — the grain only ever existed at mip 0, inside 1.5 m.
 *   3. It costs a full octave of generation time to produce a constant.
 *
 * This helper takes the wavelength you actually want at the FINEST octave, in
 * texels, and works backwards. `finest: 4` keeps the tightest feature four texels
 * across, which survives two mip levels intact and still reads as grain rather
 * than as a pattern. Anisotropic requests are handled on the tighter axis.
 */
export function microGrain(W, H, o = {}) {
  const octaves = Math.max(1, o.octaves ?? 3);
  const finest = Math.max(2, o.finest ?? 4);
  const lac = o.lacunarity ?? 2;
  const sx = o.scaleX ?? 1;
  const sy = o.scaleY ?? 1;
  const tight = Math.max(sx, sy);
  const cells = (W / finest) / (Math.pow(lac, octaves - 1) * tight);
  return fbm(W, H, {
    seed: o.seed ?? 1,
    cells: Math.max(2, cells),
    octaves,
    gain: o.gain ?? 0.55,
    lacunarity: lac,
    scaleX: sx,
    scaleY: sy,
    ridged: !!o.ridged,
  });
}

function latticeRect(nx, ny, seed) {
  const rand = mulberry32(seed);
  const a = new Float32Array(nx * ny);
  for (let i = 0; i < a.length; i++) a[i] = rand();
  return a;
}

function accumulateRect(out, W, H, lat, nx, ny, amp, ridged) {
  const xi0 = new Int32Array(W);
  const xi1 = new Int32Array(W);
  const xw = new Float32Array(W);
  const sx = nx / W;
  for (let x = 0; x < W; x++) {
    const fx = x * sx;
    const i0 = Math.floor(fx);
    const f = fx - i0;
    const a = ((i0 % nx) + nx) % nx;
    xi0[x] = a;
    xi1[x] = (a + 1) % nx;
    xw[x] = f * f * f * (f * (f * 6 - 15) + 10);
  }
  const sy = ny / H;
  for (let y = 0; y < H; y++) {
    const fy = y * sy;
    const j0 = Math.floor(fy);
    const f = fy - j0;
    const wy = f * f * f * (f * (f * 6 - 15) + 10);
    const r0 = (((j0 % ny) + ny) % ny) * nx;
    const r1 = ((((j0 + 1) % ny) + ny) % ny) * nx;
    const o = y * W;
    for (let x = 0; x < W; x++) {
      const w = xw[x];
      const i0 = xi0[x], i1 = xi1[x];
      const t = lat[r0 + i0] + (lat[r0 + i1] - lat[r0 + i0]) * w;
      const b = lat[r1 + i0] + (lat[r1 + i1] - lat[r1 + i0]) * w;
      let v = t + (b - t) * wy;
      if (ridged) v = 1 - Math.abs(v * 2 - 1);
      out[o + x] += v * amp;
    }
  }
}

/** fbm remapped to -1..1. */
export function fbmSigned(W, H, o) {
  const f = fbm(W, H, o);
  for (let i = 0; i < f.length; i++) f[i] = f[i] * 2 - 1;
  return f;
}

/* ─────────────────────── domain warping ─────────────────────── */

/**
 * Domain warp: resample `src` at (x + dx*amount, y + dy*amount) with wrapping
 * bilinear filtering. This is what kills the "obviously procedural" look —
 * straight noise reads as noise, warped noise reads as weathering.
 */
export function warp(src, W, H, dx, dy, amount, amountY) {
  const ay = amountY ?? amount;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) {
      const i = o + x;
      let u = x + dx[i] * amount;
      let v = y + dy[i] * ay;
      u = u - Math.floor(u / W) * W;
      v = v - Math.floor(v / H) * H;
      const x0 = u | 0, y0 = v | 0;
      const fx = u - x0, fy = v - y0;
      const x1 = x0 + 1 === W ? 0 : x0 + 1;
      const y1 = y0 + 1 === H ? 0 : y0 + 1;
      const r0 = y0 * W, r1 = y1 * W;
      const a = src[r0 + x0], b = src[r0 + x1];
      const c = src[r1 + x0], d = src[r1 + x1];
      const t = a + (b - a) * fx;
      const bt = c + (d - c) * fx;
      out[i] = t + (bt - t) * fy;
    }
  }
  return out;
}

/* ─────────────────────── cellular / worley ─────────────────────── */

/**
 * Tileable Worley. Returns { d1, d2, id } where d1/d2 are normalised distances to
 * the nearest / second-nearest feature point and id is a stable per-cell random
 * value (use it to tint individual stones, bricks, spangles).
 */
export function worley(W, H, cells, seed, opts = {}) {
  const cx = Math.max(2, Math.round(cells));
  const cy = Math.max(2, Math.round(cells * (H / W)));
  const cw = W / cx, chh = H / cy;
  const jitter = opts.jitter ?? 0.8;
  const rand = mulberry32(seed >>> 0);
  const n = cx * cy;
  const px = new Float32Array(n), py = new Float32Array(n), pv = new Float32Array(n);
  const m = (1 - jitter) * 0.5;
  for (let j = 0; j < cy; j++) {
    for (let i = 0; i < cx; i++) {
      const k = j * cx + i;
      px[k] = (i + m + rand() * jitter) * cw;
      py[k] = (j + m + rand() * jitter) * chh;
      pv[k] = rand();
    }
  }
  const d1 = new Float32Array(W * H);
  const d2 = new Float32Array(W * H);
  const id = new Float32Array(W * H);
  const norm = 1 / Math.max(cw, chh);
  for (let y = 0; y < H; y++) {
    const gy = Math.min(cy - 1, (y / chh) | 0);
    for (let x = 0; x < W; x++) {
      const gx = Math.min(cx - 1, (x / cw) | 0);
      let b1 = 1e20, b2 = 1e20, bid = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const ry = gy + oy;
        const wy = ry < 0 ? -H : ry >= cy ? H : 0;
        const yy = ((ry % cy) + cy) % cy;
        const row = yy * cx;
        for (let ox = -1; ox <= 1; ox++) {
          const rx = gx + ox;
          const wx = rx < 0 ? -W : rx >= cx ? W : 0;
          const xx = ((rx % cx) + cx) % cx;
          const k = row + xx;
          const ddx = px[k] + wx - x;
          const ddy = py[k] + wy - y;
          const d = ddx * ddx + ddy * ddy;
          if (d < b1) { b2 = b1; b1 = d; bid = pv[k]; }
          else if (d < b2) { b2 = d; }
        }
      }
      const o = y * W + x;
      d1[o] = Math.min(1, Math.sqrt(b1) * norm);
      d2[o] = Math.min(1, Math.sqrt(b2) * norm);
      id[o] = bid;
    }
  }
  return { d1, d2, id };
}

/* ──────────────────────── blur / cavity / AO ──────────────────────── */

function blurAxis(src, dst, W, H, r, horizontal) {
  const inv = 1 / (2 * r + 1);
  if (horizontal) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += src[row + (((i % W) + W) % W)];
      for (let x = 0; x < W; x++) {
        dst[row + x] = sum * inv;
        const add = (x + r + 1) % W;
        const sub = (((x - r) % W) + W) % W;
        sum += src[row + add] - src[row + sub];
      }
    }
  } else {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += src[(((i % H) + H) % H) * W + x];
      for (let y = 0; y < H; y++) {
        dst[y * W + x] = sum * inv;
        const add = ((y + r + 1) % H) * W + x;
        const sub = ((((y - r) % H) + H) % H) * W + x;
        sum += src[add] - src[sub];
      }
    }
  }
}

/** Wrapping separable box blur (two passes ≈ tent filter). */
export function blur(src, W, H, r) {
  if (r < 1) return Float32Array.from(src);
  const a = new Float32Array(W * H);
  const b = new Float32Array(W * H);
  blurAxis(src, a, W, H, r, true);
  blurAxis(a, b, W, H, r, false);
  blurAxis(b, a, W, H, Math.max(1, r >> 1), true);
  blurAxis(a, b, W, H, Math.max(1, r >> 1), false);
  return b;
}

/**
 * Multi-scale cavity: height minus blurred height, summed over several radii.
 * Negative = crevice, positive = exposed edge. This is the term that produces both
 * grime-in-the-cracks and worn-bright-edges, the two things that read as "scanned".
 */
export function cavity(hf, W, H, radii = [2, 7, 22], weights = [0.5, 0.32, 0.18]) {
  const out = new Float32Array(W * H);
  for (let k = 0; k < radii.length; k++) {
    const r = Math.max(1, Math.round(radii[k] * (W / 1024)));
    const b = blur(hf, W, H, r);
    const w = weights[k] ?? 1 / radii.length;
    for (let i = 0; i < out.length; i++) out[i] += (hf[i] - b[i]) * w;
  }
  return out;
}

/* ───────────────────────── normals (Sobel) ───────────────────────── */

/**
 * Sobel-filter a *height field authored separately from the albedo* into a tangent
 * space normal map. Deriving normals from albedo is the classic amateur mistake and
 * produces bumps painted onto the colour rather than real relief.
 *
 * Convention: DataTexture has flipY = false, so array row index == +v. For a height
 * field h(u,v) the tangent normal is normalize(-dh/du, -dh/dv, 1).
 */
export function heightToNormal(hf, W, H, strength = 1.0) {
  const out = new Uint8Array(W * H * 4);
  const xm = new Int32Array(W), xp = new Int32Array(W);
  for (let x = 0; x < W; x++) { xm[x] = x === 0 ? W - 1 : x - 1; xp[x] = x === W - 1 ? 0 : x + 1; }
  const k = strength * W * 0.02;
  for (let y = 0; y < H; y++) {
    const ym = (y === 0 ? H - 1 : y - 1) * W;
    const yy = y * W;
    const yp = (y === H - 1 ? 0 : y + 1) * W;
    for (let x = 0; x < W; x++) {
      const a = hf[ym + xm[x]], b = hf[ym + x], c = hf[ym + xp[x]];
      const d = hf[yy + xm[x]], f = hf[yy + xp[x]];
      const g = hf[yp + xm[x]], hh = hf[yp + x], i = hf[yp + xp[x]];
      const gx = (c + 2 * f + i) - (a + 2 * d + g);
      const gy = (g + 2 * hh + i) - (a + 2 * b + c);
      let nx = -gx * k, ny = -gy * k, nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + 1);
      nx /= len; ny /= len; nz /= len;
      const o = (yy + x) * 4;
      out[o] = (nx * 0.5 + 0.5) * 255;
      out[o + 1] = (ny * 0.5 + 0.5) * 255;
      out[o + 2] = (nz * 0.5 + 0.5) * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

/* ───────────────────── gravity streaks & drips ───────────────────── */

/**
 * Runs a source field downward with exponential decay and a per-column lateral
 * drift, producing the vertical grime trails that appear under every ledge, sill and
 * bolt head in the real world. Wraps vertically (two passes) so the texture tiles.
 */
export function gravityStreak(src, W, H, opts = {}) {
  const decay = opts.decay ?? 0.985;
  const drift = opts.drift ?? null;   // signed field, sub-pixel lateral wander
  const driftAmt = opts.driftAmount ?? 0.35;
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = src[i];
  const passes = opts.passes ?? 2;
  const carry = new Float32Array(W);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      const o = y * W;
      const prev = ((y - 1 + H) % H) * W;
      for (let x = 0; x < W; x++) {
        let sx = x;
        if (drift) {
          const dx = drift[o + x] * driftAmt;
          sx = x + (dx > 0.5 ? 1 : dx < -0.5 ? -1 : 0);
          if (sx < 0) sx += W; else if (sx >= W) sx -= W;
        }
        carry[x] = out[prev + sx] * decay;
      }
      for (let x = 0; x < W; x++) {
        const v = carry[x];
        if (v > out[o + x]) out[o + x] = v;
      }
    }
  }
  return out;
}

/* ─────────────────────── line / scratch rasteriser ─────────────────────── */

/**
 * Scribes random-walk lines into a field (cracks, scratches, saw marks, rebar
 * scoring). Wraps at the edges so the marks tile.
 */
export function scribe(field, W, H, seed, o = {}) {
  const count = o.count ?? 24;
  const rand = mulberry32(seed >>> 0);
  const len = o.length ?? W * 0.6;
  const wander = o.wander ?? 0.35;
  const width = o.width ?? 1.2;
  const strength = o.strength ?? 1;
  const dirBias = o.dirBias ?? null; // radians, if set lines mostly follow it
  const biasAmt = o.biasStrength ?? 0.9;
  const taper = o.taper ?? true;
  for (let c = 0; c < count; c++) {
    let x = rand() * W;
    let y = rand() * H;
    let a = dirBias != null
      ? dirBias + (rand() - 0.5) * (1 - biasAmt) * Math.PI * 2
      : rand() * Math.PI * 2;
    const steps = Math.max(4, Math.round(len * (0.35 + rand() * 1.3)));
    const w = width * (0.5 + rand() * 1.1);
    const s = strength * (0.45 + rand() * 0.85);
    for (let i = 0; i < steps; i++) {
      a += (rand() - 0.5) * wander;
      x += Math.cos(a);
      y += Math.sin(a);
      if (x < 0) x += W; else if (x >= W) x -= W;
      if (y < 0) y += H; else if (y >= H) y -= H;
      const t = taper ? Math.sin((i / steps) * Math.PI) : 1;
      const amp = s * t;
      const rw = Math.max(1, Math.ceil(w));
      for (let dy = -rw; dy <= rw; dy++) {
        const yy = (((y | 0) + dy) % H + H) % H;
        const row = yy * W;
        for (let dx = -rw; dx <= rw; dx++) {
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > w) continue;
          const xx = (((x | 0) + dx) % W + W) % W;
          const v = amp * (1 - d / w);
          if (v > field[row + xx]) field[row + xx] = v;
        }
      }
    }
  }
  return field;
}

/* ───────────────────────────── misc ops ───────────────────────────── */

/**
 * Histogram-equalise a field to a (near) uniform distribution on 0..1, in place.
 *
 * WHY THIS EXISTS — this is the fix for the single biggest defect the library had.
 * `fbm()` sums N octaves of uniform value noise and divides by the amplitude sum. By
 * the central limit theorem the result is a NARROW BELL around 0.5: a 4-octave field
 * at gain 0.56 measures sigma ~= 0.124, so it essentially never leaves 0.30..0.70.
 *
 * Every recipe in this library masks its wear with `sstep(0.56, 0.88, field)` style
 * thresholds — written as though the field spanned 0..1. Against a sigma-0.124 bell
 * those upper edges sit at +3 sigma, so the mask fired on well under 1% of texels and
 * the authored roughness break-up, damp patches, polish and staining were multiplied
 * by ~0.05 before they ever reached the packed ORM. Measured result: concrete
 * roughness std 0.083 and albedo hue std 0.0012 — the "uniform roughness / no albedo
 * variation" the critics flagged. The recipes were right; the fields were flat.
 *
 * Equalising makes `sstep(a, b, field)` mean what it reads as: the fraction of the
 * surface covered by a mask is exactly the width of the band above `a`.
 *
 * Cost is two linear passes and a 512-bin histogram — ~8 ms on a 2048² field.
 */
export function equalize(f, strength = 1) {
  const N = 512;
  const hist = new Uint32Array(N);
  const n = f.length;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const v = f[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo;
  if (!(span > 1e-9)) return f;
  const sc = (N - 1) / span;
  for (let i = 0; i < n; i++) hist[((f[i] - lo) * sc) | 0]++;
  // CDF → lookup, sampled at bin centres so the mapping is monotone and smooth
  const lut = new Float32Array(N);
  let acc = 0;
  const inv = 1 / n;
  for (let b = 0; b < N; b++) {
    const c = hist[b];
    lut[b] = (acc + c * 0.5) * inv;      // mid-bin CDF avoids the 0/1 pile-up
    acc += c;
  }
  if (strength >= 1) {
    for (let i = 0; i < n; i++) {
      const t = (f[i] - lo) * sc;
      const b0 = t | 0;
      const b1 = b0 + 1 < N ? b0 + 1 : b0;
      const w = t - b0;
      f[i] = lut[b0] + (lut[b1] - lut[b0]) * w;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const t = (f[i] - lo) * sc;
      const b0 = t | 0;
      const b1 = b0 + 1 < N ? b0 + 1 : b0;
      const w = t - b0;
      const e = lut[b0] + (lut[b1] - lut[b0]) * w;
      f[i] += (e - f[i]) * strength;
    }
  }
  return f;
}

/** Equalise several fields at once. Returns the array so it can be inlined. */
export function equalizeAll(...fields) {
  for (const f of fields) equalize(f);
  return fields;
}

/**
 * Variance stretch about the field's own mean — cheaper than `equalize` and keeps the
 * bell shape, for cases where a uniform distribution would look mechanical.
 */
export function spread(f, targetStd = 0.22) {
  const n = f.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += f[i];
  const m = s / n;
  let s2 = 0;
  for (let i = 0; i < n; i++) { const d = f[i] - m; s2 += d * d; }
  const sd = Math.sqrt(s2 / n) || 1e-6;
  const k = targetStd / sd;
  for (let i = 0; i < n; i++) f[i] = clamp01(0.5 + (f[i] - m) * k);
  return f;
}

/**
 * Stamps soft radial discs on a jittered grid — bug holes in cast concrete, form-tie
 * plugs, rivet heads. Wraps. `depth` is signed so callers can raise or sink them.
 */
export function studs(field, W, H, seed, o = {}) {
  const cols = Math.max(1, o.cols ?? 6);
  const rows = Math.max(1, o.rows ?? cols);
  const rad = (o.radius ?? 0.25) * (W / cols);
  const jit = o.jitter ?? 0.35;
  const amp = o.strength ?? 1;
  const chance = o.chance ?? 1;
  const rim = o.rim ?? 0;
  const cw = W / cols, ch = H / rows;
  const rand = mulberry32((seed >>> 0) + 12347);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const keep = rand();
      const cx = (i + 0.5 + (rand() - 0.5) * jit * 2) * cw;
      const cy = (j + 0.5 + (rand() - 0.5) * jit * 2) * ch;
      const rr = rad * (0.55 + rand() * 0.9);
      const a = amp * (0.6 + rand() * 0.8);
      if (keep > chance) continue;
      const R = Math.ceil(rr) + 1;
      for (let dy = -R; dy <= R; dy++) {
        const yy = ((((cy + dy) | 0) % H) + H) % H;
        const row = yy * W;
        for (let dx = -R; dx <= R; dx++) {
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > rr) continue;
          const xx = ((((cx + dx) | 0) % W) + W) % W;
          const t = 1 - d / rr;
          // smooth dome, optional raised rim just inside the edge
          let v = t * t * (3 - 2 * t);
          if (rim > 0) v -= rim * Math.exp(-((d - rr * 0.82) * (d - rr * 0.82)) / (rr * rr * 0.02));
          field[row + xx] += v * a;
        }
      }
    }
  }
  return field;
}

export function remap(f, lo, hi) {
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = lo + (hi - lo) * f[i];
  return out;
}

export function contrast(f, k, pivot = 0.5) {
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = clamp01((f[i] - pivot) * k + pivot);
  return out;
}

export function mulField(a, b) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * b[i];
  return out;
}

export function normalize01(f) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.length; i++) { const v = f[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const d = hi - lo || 1;
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) / d;
  return f;
}
