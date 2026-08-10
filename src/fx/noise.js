/**
 * Tiny, allocation-free procedural noise used only by the FX texture bakery.
 *
 * Self-contained on purpose: the materials agent owns `src/materials/noise.js`
 * and may change its signatures at any moment. FX must never break because of
 * that, so it carries its own 60 lines.
 *
 * OWNER: fx
 */

/** 32-bit integer hash -> [0,1). Deterministic across runs. */
export function ihash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function hash1(i, s) {
  let h = Math.imul(i | 0, 1103515245) ^ Math.imul(s | 0, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Bilinear value noise. */
export function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smooth(xf), v = smooth(yf);
  const a = ihash(xi, yi, s);
  const b = ihash(xi + 1, yi, s);
  const c = ihash(xi, yi + 1, s);
  const d = ihash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal sum. `oct` in 1..6. Returns roughly [0,1]. */
export function fbm(x, y, s, oct = 4, lac = 2.03, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += vnoise(x * freq, y * freq, s + i * 131) * amp;
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / (norm || 1);
}

/** Ridged fractal — good for cracks and fibres. */
export function ridged(x, y, s, oct = 4) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(vnoise(x * freq, y * freq, s + i * 77) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.52;
    freq *= 2.11;
  }
  return sum / (norm || 1);
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function smoothstep(e0, e1, x) {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function mix(a, b, t) { return a + (b - a) * t; }
