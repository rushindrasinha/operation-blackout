/**
 * Procedural impulse responses for the two-space convolution reverb.
 *
 * This is the layer most browser gunshots skip, and it is the entire reason a
 * shot fired inside a warehouse and the same shot fired on open ground read as
 * different events. Both IRs are generated as exponentially-decaying, filtered,
 * decorrelated noise with explicitly placed early reflections; the audio system
 * crossfades between them based on whether the player has sky above them.
 *
 * OWNER: audio.
 */

import { Rng, buf, white, biquad, onePoleSweep, allpass, dcBlock } from './dsp.js';

/**
 * Normalise to a target **L2 norm**, not RMS.
 *
 * A ConvolverNode's broadband gain is sqrt(sum(ir²)) — the L2 norm — not the
 * RMS. Normalising RMS to a plausible-looking 0.055 across a 60000-sample IR
 * gives a convolution gain of 0.055·sqrt(60000) ≈ 13.5, i.e. +22dB of reverb,
 * which pins the master limiter permanently and turns sustained fire into an
 * undifferentiated wall. Target ≈ 0.8 keeps the wet field at roughly the same
 * total energy as the dry signal that fed it.
 */
function energyNormalise(chans, targetGain) {
  let g2 = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) g2 += c[i] * c[i];
  const norm = Math.sqrt(g2 / Math.max(1, chans.length));
  if (norm < 1e-9) return;
  const g = targetGain / norm;
  for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= g;
}

/**
 * Tight industrial interior: hard concrete floor, corrugated walls, a hard slap
 * at ~11ms and a flutter echo that decays inside half a second.
 */
export function indoorIR(sr, seed = 991) {
  const rng = new Rng(seed);
  const dur = 1.25;
  const n = Math.round(dur * sr);
  const chans = [buf(n), buf(n)];

  for (let ch = 0; ch < 2; ch++) {
    const out = chans[ch];

    // ── early reflections: discrete, audible, room-defining ──────────────
    const early = 16;
    for (let i = 0; i < early; i++) {
      const t = 0.005 + Math.pow(i / early, 1.35) * 0.085 + rng.range(-0.0015, 0.0015);
      const off = Math.max(0, Math.round(t * sr));
      const len = Math.round(rng.range(0.0006, 0.0022) * sr);
      const amp = 0.95 * Math.exp(-t / 0.048) * rng.range(0.6, 1.25) * (ch === 0 ? 1 : rng.range(0.75, 1.25));
      for (let k = 0; k < len && off + k < n; k++) {
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / len);
        out[off + k] += rng.bi() * w * amp;
      }
    }

    // ── flutter between two parallel steel walls ────────────────────────
    const flutter = 0.0118 + ch * 0.0006;
    for (let i = 1; i < 26; i++) {
      const t = flutter * i + rng.range(-0.0004, 0.0004);
      const off = Math.round(t * sr);
      if (off >= n) break;
      const len = Math.round(0.0014 * sr);
      const amp = 0.34 * Math.exp(-t / 0.13) * rng.range(0.7, 1.2);
      for (let k = 0; k < len && off + k < n; k++) {
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / len);
        out[off + k] += rng.bi() * w * amp;
      }
    }

    // ── late diffuse field ──────────────────────────────────────────────
    const late = white(n, rng);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      // Build-up over the first 12ms, then a two-slope decay: fast mid, slower low.
      const build = t < 0.012 ? t / 0.012 : 1;
      late[i] *= build * (0.72 * Math.exp(-t / 0.16) + 0.26 * Math.exp(-t / 0.42));
    }
    biquad(late, 'highpass', 95, 0.7, sr, 0, 2);
    onePoleSweep(late, 6200, 900, sr, 0.7);   // HF dies first, as in a real room
    allpass(late, Math.round(sr * (ch ? 0.0071 : 0.0063)), 0.62);
    allpass(late, Math.round(sr * (ch ? 0.0113 : 0.0129)), 0.55);
    for (let i = 0; i < n; i++) out[i] += late[i] * 0.9;

    // Concrete floor gives a low modal bloom.
    for (const f of [58, 79, 104]) {
      let ph = rng.range(0, 6.28), y = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        ph += 2 * Math.PI * f / sr;
        y = Math.sin(ph) * Math.exp(-t / 0.30) * 0.05;
        out[i] += y;
      }
    }

    dcBlock(out, sr);
    // Never let the IR start with a hard 1.0 spike — that is the dry signal's job.
    for (let i = 0; i < Math.round(0.0012 * sr); i++) out[i] *= i / Math.round(0.0012 * sr);
    const fo = Math.round(0.05 * sr);
    for (let i = 0; i < fo; i++) out[n - 1 - i] *= i / fo;
  }

  energyNormalise(chans, 0.78);
  return chans;
}

/**
 * Open ground between distant structures: almost no early energy, a handful of
 * discrete slapbacks off buildings 30–120m out, and a long air-absorbed tail.
 */
export function outdoorIR(sr, seed = 4423) {
  const rng = new Rng(seed);
  const dur = 2.6;
  const n = Math.round(dur * sr);
  const chans = [buf(n), buf(n)];

  // Shared slapback geometry so both ears agree on where the buildings are,
  // with only small inter-aural offsets.
  const slaps = [];
  for (let i = 0; i < 9; i++) {
    slaps.push({
      t: 0.055 + Math.pow(i / 9, 1.25) * 0.78 + rng.range(-0.01, 0.01),
      amp: rng.range(0.35, 0.9) * Math.exp(-i * 0.24),
      lp: rng.range(700, 2200) * Math.exp(-i * 0.12),
      pan: rng.bi(),
    });
  }

  for (let ch = 0; ch < 2; ch++) {
    const out = chans[ch];

    for (const s of slaps) {
      const skew = (ch === 0 ? -1 : 1) * s.pan * 0.0009;
      const off = Math.max(0, Math.round((s.t + skew) * sr));
      const len = Math.round(rng.range(0.010, 0.035) * sr);
      if (off >= n) continue;
      const seg = white(len, rng);
      biquad(seg, 'lowpass', s.lp, 0.7, sr, 0, 2);
      biquad(seg, 'highpass', 110, 0.7, sr);
      for (let k = 0; k < len; k++) {
        const w = Math.exp(-k / (len * 0.28));
        seg[k] *= w;
      }
      const g = s.amp * (1 + s.pan * (ch === 0 ? -0.35 : 0.35));
      for (let k = 0; k < len && off + k < n; k++) out[off + k] += seg[k] * g;
    }

    // Long air-absorbed tail.
    const late = white(n, rng);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const build = t < 0.06 ? Math.pow(t / 0.06, 1.6) : 1;
      late[i] *= build * (0.55 * Math.exp(-t / 0.52) + 0.45 * Math.exp(-t / 1.05));
    }
    biquad(late, 'highpass', 70, 0.7, sr, 0, 2);
    onePoleSweep(late, 3600, 280, sr, 0.55);
    allpass(late, Math.round(sr * (ch ? 0.0173 : 0.0191)), 0.5);
    allpass(late, Math.round(sr * (ch ? 0.0281 : 0.0247)), 0.45);
    for (let i = 0; i < n; i++) out[i] += late[i] * 0.85;

    dcBlock(out, sr);
    const fi = Math.round(0.004 * sr);
    for (let i = 0; i < fi; i++) out[i] *= i / fi;
    const fo = Math.round(0.25 * sr);
    for (let i = 0; i < fo; i++) out[n - 1 - i] *= i / fo;
  }

  energyNormalise(chans, 0.92);
  return chans;
}
