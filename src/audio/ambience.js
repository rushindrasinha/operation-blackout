/**
 * The ambient bed: wind over open ground, the low rumble of a city that is
 * still running somewhere behind you, and occasional far-off gunfire.
 *
 * The loops are long (10–14s) and are additionally modulated live by two slow
 * LFOs on filter cutoff and gain, so the loop point is never audible. Nothing
 * here is started until the AudioContext is actually running.
 *
 * OWNER: audio.
 */

import { Rng, buf, white, pink, brown, biquad, svfSweep, loopFold, dcBlock, normalizePeak } from './dsp.js';

/** Wind: band-limited noise with baked gusts, decorrelated across the stereo field. */
export function buildWind(sr) {
  const rng = new Rng(20707);
  const loopSec = 10, xfSec = 2.2;
  const n = Math.round(loopSec * sr);
  const total = n + Math.round(xfSec * sr);
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const b = pink(total, rng);
    // Slow, wandering band centre — the "moan" of wind round hard edges.
    svfSweep(b, 320, 1250, 0.9, sr, 'band', 1);
    const hiss = white(total, rng);
    biquad(hiss, 'bandpass', 2600 + ch * 220, 0.8, sr);
    biquad(hiss, 'lowpass', 5200, 0.7, sr);
    for (let i = 0; i < total; i++) {
      const t = i / sr;
      // Three incommensurate gust rates so nothing lines up inside the loop.
      const g =
        0.55 +
        0.30 * Math.sin(2 * Math.PI * 0.043 * t + ch * 1.1) +
        0.18 * Math.sin(2 * Math.PI * 0.111 * t + ch * 2.3) +
        0.10 * Math.sin(2 * Math.PI * 0.0197 * t);
      const gg = Math.max(0.06, g);
      b[i] = (b[i] * 1.0 + hiss[i] * 0.22 * gg) * gg;
    }
    biquad(b, 'highpass', 140, 0.7, sr);
    dcBlock(b, sr);
    const folded = loopFold(b, n, Math.round(xfSec * sr));
    normalizePeak(folded, 0.55);
    out.push(folded);
  }
  return out;
}

/** Distant city / generator rumble. Mostly felt. Keeps the low end alive. */
export function buildRumble(sr) {
  const rng = new Rng(88123);
  const loopSec = 14, xfSec = 3;
  const n = Math.round(loopSec * sr);
  const total = n + Math.round(xfSec * sr);
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const b = brown(total, rng, 0.9985);
    biquad(b, 'lowpass', 110, 0.7, sr, 0, 2);
    // A couple of near-static resonances: HVAC plant, a generator somewhere.
    for (let i = 0; i < total; i++) {
      const t = i / sr;
      b[i] +=
        0.055 * Math.sin(2 * Math.PI * (49.7 + ch * 0.3) * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.037 * t)) +
        0.030 * Math.sin(2 * Math.PI * (73.1 - ch * 0.4) * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.021 * t + 1.7));
    }
    // Traffic-ish mid haze, heavily rolled off.
    const haze = white(total, rng);
    biquad(haze, 'lowpass', 380, 0.6, sr, 0, 2);
    biquad(haze, 'highpass', 120, 0.7, sr);
    for (let i = 0; i < total; i++) {
      const t = i / sr;
      b[i] += haze[i] * 0.22 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.0133 * t + ch));
    }
    biquad(b, 'highpass', 26, 0.7, sr);
    dcBlock(b, sr);
    const folded = loopFold(b, n, Math.round(xfSec * sr));
    normalizePeak(folded, 0.6);
    out.push(folded);
  }
  return out;
}

/** A single soft metallic creak/clank — a gate, a loose panel, a distant shutter. */
export function buildCreak(sr) {
  const rng = new Rng(3391);
  const list = [];
  for (let v = 0; v < 3; v++) {
    const n = Math.round(1.1 * sr);
    const b = buf(n);
    const nn = Math.round(0.55 * sr);
    const noise = white(nn, rng);
    svfSweep(noise, rng.range(420, 700), rng.range(900, 1500), 7, sr, 'band', 0.7);
    for (let i = 0; i < nn; i++) {
      const t = i / nn;
      // Stick-slip: amplitude chatters as the hinge grabs and releases.
      const chat = 0.5 + 0.5 * Math.sin(i * rng.range(0.02, 0.05));
      b[i] += noise[i] * Math.sin(Math.PI * Math.pow(t, 0.8)) * chat * 0.8;
    }
    // Terminal clank.
    const off = Math.round(rng.range(0.5, 0.62) * sr);
    const cn = Math.round(0.3 * sr);
    const cl = white(cn, rng);
    biquad(cl, 'bandpass', rng.range(900, 1600), 1.0, sr);
    for (let i = 0; i < cn && off + i < n; i++) b[off + i] += cl[i] * Math.exp(-i / (0.006 * sr)) * 0.5;
    biquad(b, 'highpass', 260, 0.7, sr);
    dcBlock(b, sr);
    normalizePeak(b, 0.4);
    const fo = Math.round(0.08 * sr);
    for (let i = 0; i < fo; i++) b[n - 1 - i] *= i / fo;
    list.push(b);
  }
  return list;
}
