/**
 * Offline DSP toolkit for procedural sound synthesis.
 *
 * Everything the audio system plays is generated here into Float32Arrays at
 * init, then uploaded into AudioBuffers. Rendering offline (rather than wiring
 * a dozen live nodes per gunshot) is what lets us fire 12 rounds a second and
 * still spend the CPU budget on HRTF panning and two convolution reverbs.
 *
 * OWNER: audio.
 */

/** Deterministic PRNG — same bank every boot, so tuning is reproducible. */
export class Rng {
  constructor(seed = 1) { this.s = (seed >>> 0) || 1; }
  next() {
    let t = (this.s += 0x6D2B79F5) | 0;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  /** Bipolar −1..1 */
  bi() { return this.next() * 2 - 1; }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  pick(arr) { return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))]; }
  /** Roughly gaussian via central limit — nicer for jitter than uniform. */
  gauss() { return (this.next() + this.next() + this.next() - 1.5) * 1.1547; }
}

export function buf(n) { return new Float32Array(Math.max(1, n | 0)); }

export function white(n, rng) {
  const b = buf(n);
  for (let i = 0; i < b.length; i++) b[i] = rng.bi();
  return b;
}

/** Paul Kellet's economical pink-noise filter. */
export function pink(n, rng) {
  const b = buf(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < b.length; i++) {
    const w = rng.bi();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    b[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
    b6 = w * 0.115926;
  }
  return b;
}

/** Leaky-integrated noise — the −6dB/oct rumble bed. */
export function brown(n, rng, leak = 0.997) {
  const b = buf(n);
  let v = 0;
  for (let i = 0; i < b.length; i++) {
    v = v * leak + rng.bi() * 0.045;
    b[i] = v;
  }
  return b;
}

/**
 * RBJ cookbook biquad, applied in place. `passes` cascades identical sections
 * for a steeper slope (2 passes on a lowpass ≈ 24dB/oct).
 */
export function biquad(b, type, f0, Q, sr, gainDb = 0, passes = 1) {
  f0 = Math.max(8, Math.min(f0, sr * 0.48));
  Q = Math.max(1e-4, Q);
  const w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  const al = sw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass':  b0 = (1 - cw) / 2; b1 = 1 - cw;    b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'bandpass': b0 = al;           b1 = 0;         b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'notch':    b0 = 1;            b1 = -2 * cw;   b2 = 1;  a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'peaking': {
      const A = Math.pow(10, gainDb / 40);
      b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A;
      a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break;
    }
    case 'lowshelf': {
      const A = Math.pow(10, gainDb / 40), s = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) - (A - 1) * cw + s);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - s; break;
    }
    case 'highshelf': {
      const A = Math.pow(10, gainDb / 40), s = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) + (A - 1) * cw + s);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - s; break;
    }
    default: return b;
  }
  const B0 = b0 / a0, B1 = b1 / a0, B2 = b2 / a0, A1 = a1 / a0, A2 = a2 / a0;
  for (let p = 0; p < passes; p++) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < b.length; i++) {
      const x = b[i];
      const y = B0 * x + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      b[i] = y;
    }
  }
  return b;
}

/**
 * Chamberlin state-variable filter with a per-sample exponential frequency
 * sweep. This is how the bullet whiz and the charging handle get their glide —
 * a static biquad cannot do it.
 * mode: 'low' | 'band' | 'high'
 */
export function svfSweep(b, f0, f1, Q, sr, mode = 'band', curve = 1) {
  const n = b.length;
  const fMax = sr / 6;
  const q = 1 / Math.max(0.35, Q);
  let low = 0, band = 0;
  const lf0 = Math.log(Math.max(20, f0)), lf1 = Math.log(Math.max(20, f1));
  for (let i = 0; i < n; i++) {
    const t = Math.pow(n > 1 ? i / (n - 1) : 0, curve);
    const fc = Math.min(fMax, Math.exp(lf0 + (lf1 - lf0) * t));
    const f = 2 * Math.sin(Math.PI * fc / sr);
    const x = b[i];
    low += f * band;
    const high = x - low - q * band;
    band += f * high;
    b[i] = mode === 'low' ? low : mode === 'high' ? high : band * q;
  }
  return b;
}

/** One-pole lowpass whose cutoff glides — cheap air-absorption modelling. */
export function onePoleSweep(b, f0, f1, sr, curve = 1) {
  const n = b.length;
  let y = 0;
  const lf0 = Math.log(Math.max(10, f0)), lf1 = Math.log(Math.max(10, f1));
  for (let i = 0; i < n; i++) {
    const t = Math.pow(n > 1 ? i / (n - 1) : 0, curve);
    const fc = Math.exp(lf0 + (lf1 - lf0) * t);
    const a = 1 - Math.exp(-2 * Math.PI * fc / sr);
    y += a * (b[i] - y);
    b[i] = y;
  }
  return b;
}

/** Remove DC so a soft-clipper doesn't get pushed off-centre. */
export function dcBlock(b, sr) {
  const r = 1 - 20 / sr;
  let x1 = 0, y1 = 0;
  for (let i = 0; i < b.length; i++) {
    const x = b[i];
    const y = x - x1 + r * y1;
    x1 = x; y1 = y;
    b[i] = y;
  }
  return b;
}

/**
 * Attack/decay envelope. `attack` seconds of raised-cosine rise, then a sum of
 * up to two exponential decays. Two decays is what gives a gunshot its
 * characteristic "crack then bloom" rather than a single dull blip.
 */
export function envAD(n, sr, attack, tau1, amp1 = 1, tau2 = 0, amp2 = 0) {
  const e = buf(n);
  const aN = Math.max(1, Math.round(attack * sr));
  for (let i = 0; i < e.length; i++) {
    const t = i / sr;
    let a = 1;
    if (i < aN) a = 0.5 - 0.5 * Math.cos(Math.PI * (i / aN));
    let d = amp1 * Math.exp(-t / Math.max(1e-5, tau1));
    if (tau2 > 0) d += amp2 * Math.exp(-t / tau2);
    e[i] = a * d;
  }
  return e;
}

export function applyEnv(b, e) {
  const n = Math.min(b.length, e.length);
  for (let i = 0; i < n; i++) b[i] *= e[i];
  for (let i = n; i < b.length; i++) b[i] = 0;
  return b;
}

export function mixInto(dst, src, offsetSamples = 0, gain = 1) {
  const o = Math.max(0, offsetSamples | 0);
  const n = Math.min(src.length, dst.length - o);
  for (let i = 0; i < n; i++) dst[o + i] += src[i] * gain;
  return dst;
}

export function scale(b, g) { for (let i = 0; i < b.length; i++) b[i] *= g; return b; }

/**
 * Damped sinusoid with an optional exponential pitch glide. The low body of a
 * gunshot is a sine swept 300→70Hz; metal rings are stacks of these.
 */
export function decaySine(dst, sr, opts) {
  const {
    freq, freqEnd = freq, tau, amp = 1, offset = 0,
    glide = 0.05, phase = 0, attack = 0.0004, fm = 0, fmHz = 0,
  } = opts;
  const n = Math.min(dst.length - (offset | 0), Math.ceil(tau * 6 * sr));
  if (n <= 0) return dst;
  const o = offset | 0;
  const aN = Math.max(1, Math.round(attack * sr));
  let ph = phase;
  const lf0 = Math.log(Math.max(1, freq)), lf1 = Math.log(Math.max(1, freqEnd));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const k = glide > 0 ? 1 - Math.exp(-t / glide) : 1;
    let f = Math.exp(lf0 + (lf1 - lf0) * k);
    if (fm > 0 && fmHz > 0) f *= 1 + fm * Math.sin(2 * Math.PI * fmHz * t);
    ph += 2 * Math.PI * f / sr;
    let a = amp * Math.exp(-t / tau);
    if (i < aN) a *= i / aN;
    dst[o + i] += Math.sin(ph) * a;
  }
  return dst;
}

/** A filtered noise burst — the primitive behind every transient in the game. */
export function noiseBurst(sr, rng, o = {}) {
  const {
    dur = 0.05, attack = 0.0003, tau = 0.01, tau2 = 0, amp2 = 0,
    hp = 0, lp = 0, bp = 0, bpQ = 1.2, tilt = 0, source = 'white',
  } = o;
  const n = Math.max(2, Math.round(dur * sr));
  const b = source === 'pink' ? pink(n, rng) : white(n, rng);
  if (bp) biquad(b, 'bandpass', bp, bpQ, sr);
  if (hp) biquad(b, 'highpass', hp, 0.72, sr, 0, 2);
  if (lp) biquad(b, 'lowpass', lp, 0.72, sr, 0, 2);
  if (tilt) biquad(b, 'highshelf', 2600, 0.7, sr, tilt);
  applyEnv(b, envAD(n, sr, attack, tau, 1, tau2, amp2));
  return b;
}

export function normalizePeak(b, target = 0.98) {
  let m = 0;
  for (let i = 0; i < b.length; i++) { const a = Math.abs(b[i]); if (a > m) m = a; }
  if (m > 1e-9) scale(b, target / m);
  return b;
}

export function rms(b) {
  let s = 0;
  for (let i = 0; i < b.length; i++) s += b[i] * b[i];
  return Math.sqrt(s / Math.max(1, b.length));
}

/** tanh saturation — glues the layers of a gunshot into one event. */
export function softClip(b, drive = 1.6) {
  const k = Math.tanh(drive);
  for (let i = 0; i < b.length; i++) b[i] = Math.tanh(b[i] * drive) / k;
  return b;
}

/** Kill start/end discontinuities so a one-shot never ticks. */
export function fadeEdges(b, sr, inMs = 0.4, outMs = 6) {
  const a = Math.max(1, Math.round(inMs * 0.001 * sr));
  const o = Math.max(1, Math.round(outMs * 0.001 * sr));
  for (let i = 0; i < a && i < b.length; i++) b[i] *= i / a;
  for (let i = 0; i < o && i < b.length; i++) b[b.length - 1 - i] *= i / o;
  return b;
}

/**
 * Fold the tail of a buffer back over its head so it loops without a seam.
 * Returns a buffer `n` samples long built from `n + xf` of source material.
 */
export function loopFold(src, n, xf) {
  const out = buf(n);
  out.set(src.subarray(0, n));
  for (let i = 0; i < xf && i < n; i++) {
    const w = i / xf;
    out[i] = out[i] * w + src[n + i] * (1 - w);
  }
  return out;
}

/** Comb/allpass smear — cheap diffusion for impulse responses. */
export function allpass(b, delaySamples, g = 0.6) {
  const d = Math.max(1, delaySamples | 0);
  const z = new Float32Array(d);
  let p = 0;
  for (let i = 0; i < b.length; i++) {
    const x = b[i];
    const y = z[p];
    const v = x + g * y;
    z[p] = v;
    b[i] = y - g * v;
    p = (p + 1) % d;
  }
  return b;
}
