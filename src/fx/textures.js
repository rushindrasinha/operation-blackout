import * as THREE from 'three';
import { hash1, fbm, clamp01, smoothstep, mix } from './noise.js';

/**
 * Procedural FX texture bakery.
 *
 * Everything is generated in code — no fetches, no canvases-with-fonts, no
 * external assets. Two atlases:
 *
 *   PARTICLE_ATLAS   512²  = 4x4 tiles of 128px, RGBA. Alpha carries the shape,
 *                            RGB carries internal density shading. Tinted per
 *                            particle at draw time.
 *   DECAL_ATLAS      1024² = 4x4 tiles of 256px, RGBA albedo
 *   DECAL_NORMAL      512² = 4x4 tiles of 128px, tangent-space dent normals
 *   DECAL_ORM         512² = 4x4 tiles of 128px, R=AO G=roughness B=metalness
 *
 * Every tile is masked to zero alpha before its border so that mip bleed
 * between neighbouring tiles can only ever spread transparency, never colour.
 * That is what lets a single atlas be sampled with baked UV offsets instead of
 * needing 16 separate textures (16 draw calls).
 *
 * OWNER: fx
 */

/* ── particle atlas tile ids ──────────────────────────────────────────────── */
export const P = {
  PUFF_A: 0, PUFF_B: 1, WISP: 2, DENSE: 3,
  SPARK: 4, STREAK: 5, FLASH_STAR: 6, FLASH_BLOB: 7,
  EMBER: 8, MOTE: 9, MIST: 10, SLIVER: 11,
  RING: 12, POOL: 13, SPARKLE: 14, SOOT: 15,
};

/* ── decal atlas tile ids ─────────────────────────────────────────────────── */
export const D = {
  HOLE_CONCRETE_A: 0, HOLE_METAL_A: 1, HOLE_WOOD_A: 2, HOLE_PLASTER: 3,
  GLASS_CRACK: 4, DIRT_CRATER: 5, BLOOD_A: 6, BLOOD_B: 7,
  SCORCH: 8, FABRIC_HIT: 9, HOLE_CONCRETE_B: 10, HOLE_METAL_B: 11,
  HOLE_WOOD_B: 12, BLOOD_POOL: 13, SOOT_SMUDGE: 14, GOUGE: 15,
};

const GRID = 4;

/* ─────────────────────────── particle painters ──────────────────────────── */

/** Every painter takes normalised tile coords (u,v in 0..1) and writes into `out` (r,g,b,a 0..1). */

function paintPuff(u, v, out, seed, opts = {}) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx + dy * dy);
  const ang = Math.atan2(dy, dx);
  // Lumpy silhouette — a perfect circle is the single loudest "billboard" tell.
  const lump = fbm(Math.cos(ang) * 1.9 + 4.1, Math.sin(ang) * 1.9 + 2.3, seed, 3);
  const edge = (opts.edge ?? 0.80) + (lump - 0.5) * (opts.lumpiness ?? 0.34);
  let a = smoothstep(edge, edge * (opts.core ?? 0.10), r);
  // Internal density — this is what stops smoke reading as a fogged disc.
  const d = fbm(u * (opts.freq ?? 4.4) + 11.0, v * (opts.freq ?? 4.4) + 7.0, seed + 51, 5);
  a *= mix(opts.densityMin ?? 0.48, 1.0, d);
  a = clamp01(a) * (opts.gain ?? 1.0);
  // Self-shadowing: denser regions read darker, and the lower half sits in its
  // own shadow. Fake, but it is the difference between "smoke" and "grey blob".
  const shade = mix(0.62, 1.0, d) * mix(0.80, 1.06, smoothstep(-0.4, 0.9, dy * -1));
  out[0] = out[1] = out[2] = clamp01(shade);
  out[3] = a;
}

function paintWisp(u, v, out, seed) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  // Anisotropic: stretched along y so it reads as a torn shred of vapour.
  const r = Math.sqrt(dx * dx * 1.55 + dy * dy * 0.62);
  const n = fbm(u * 3.1 + 2.0, v * 6.4 + 9.0, seed, 5);
  let a = smoothstep(0.86 + (n - 0.5) * 0.55, 0.05, r);
  a *= mix(0.25, 1.0, fbm(u * 8.0, v * 5.0, seed + 3, 4));
  out[0] = out[1] = out[2] = clamp01(mix(0.58, 1.02, n));
  out[3] = clamp01(a) * 0.86;
}

function paintDense(u, v, out, seed) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx + dy * dy);
  const ang = Math.atan2(dy, dx);
  const lump = fbm(Math.cos(ang) * 2.6 + 1.0, Math.sin(ang) * 2.6 + 6.0, seed, 4);
  const edge = 0.72 + (lump - 0.5) * 0.28;
  let a = smoothstep(edge, 0.02, r);
  const d = fbm(u * 6.5, v * 6.5, seed + 17, 5);
  a *= mix(0.62, 1.0, d);
  out[0] = out[1] = out[2] = clamp01(mix(0.42, 0.98, d) * mix(0.78, 1.05, 1 - r));
  out[3] = clamp01(a);
}

function paintSpark(u, v, out) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx + dy * dy);
  const halo = smoothstep(1.0, 0.0, r);
  const core = smoothstep(0.30, 0.0, r);
  const a = clamp01(halo * halo * 0.5 + core * core * 0.9);
  out[0] = out[1] = out[2] = clamp01(0.55 + core * 0.85);
  out[3] = a;
}

function paintStreak(u, v, out) {
  // Bar running along +v. +v is the direction of travel, so the head must be
  // the bright end and the tail must dissolve — the reverse reads as a comet
  // flying backwards, which is oddly hard to un-see once noticed.
  const across = Math.abs(u - 0.5) * 2;
  const along = v;
  const w = 1 - across;
  let a = w * w * w * w;
  a *= smoothstep(0.02, 0.72, along) * smoothstep(1.0, 0.93, along);
  const head = smoothstep(0.45, 1.0, along);
  out[0] = out[1] = out[2] = clamp01(0.42 + head * 0.85 + w * 0.30);
  out[3] = clamp01(a);
}

function paintFlashStar(u, v, out, seed) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx + dy * dy);
  const ang = Math.atan2(dy, dx);
  // Irregular spike count so a rotation never repeats a silhouette.
  const spikes = 0.55 + 0.45 * Math.cos(ang * 5 + hash1(seed, 3) * 6.28);
  const spikes2 = 0.6 + 0.4 * Math.cos(ang * 9 - hash1(seed, 7) * 6.28);
  const reach = 0.30 + spikes * spikes2 * 0.70;
  let a = smoothstep(reach, 0.0, r);
  a = a * a;
  const core = smoothstep(0.34, 0.0, r);
  a = clamp01(a * 0.55 + core * core * 1.0);
  out[0] = clamp01(0.72 + core * 0.5);
  out[1] = clamp01(0.60 + core * 0.55);
  out[2] = clamp01(0.42 + core * 0.62);
  out[3] = a;
}

function paintFlashBlob(u, v, out, seed) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx + dy * dy);
  const ang = Math.atan2(dy, dx);
  const lump = fbm(Math.cos(ang) * 2.2 + seed, Math.sin(ang) * 2.2, seed + 5, 3);
  const edge = 0.66 + (lump - 0.5) * 0.5;
  const body = smoothstep(edge, 0.0, r);
  const core = smoothstep(0.28, 0.0, r);
  const turb = fbm(u * 7.0, v * 7.0, seed + 21, 4);
  const a = clamp01(body * body * mix(0.55, 1.0, turb) + core * core * 0.9);
  out[0] = clamp01(0.80 + core * 0.4);
  out[1] = clamp01(0.62 + core * 0.5);
  out[2] = clamp01(0.36 + core * 0.6);
  out[3] = a;
}

function paintEmber(u, v, out) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx * 1.0 + dy * dy * 0.72);
  const core = smoothstep(0.34, 0.0, r);
  const halo = smoothstep(1.0, 0.10, r);
  out[0] = clamp01(0.75 + core * 0.45);
  out[1] = clamp01(0.38 + core * 0.5);
  out[2] = clamp01(0.12 + core * 0.3);
  out[3] = clamp01(halo * halo * 0.35 + core * core * 0.95);
}

function paintMote(u, v, out) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx + dy * dy);
  const a = smoothstep(1.0, 0.0, r);
  out[0] = out[1] = out[2] = 1.0;
  // Deliberately very soft: the visible core must be a good deal smaller than
  // the quad or a mote turns into a hard aliasing dot with no TAA to catch it.
  out[3] = clamp01(a * a * a * 0.92);
}

function paintMist(u, v, out, seed) {
  // Small cluster of droplets — restrained, never a splat.
  let a = 0;
  for (let i = 0; i < 7; i++) {
    const cx = 0.5 + (hash1(i * 13 + seed, 1) - 0.5) * 0.72;
    const cy = 0.5 + (hash1(i * 13 + seed, 2) - 0.5) * 0.72;
    const rad = 0.06 + hash1(i * 13 + seed, 3) * 0.13;
    const d = Math.hypot(u - cx, v - cy) / rad;
    a = Math.max(a, smoothstep(1.0, 0.15, d));
  }
  const edge = smoothstep(1.0, 0.72, Math.hypot(u - 0.5, v - 0.5) * 2);
  out[0] = 1.0; out[1] = 0.82; out[2] = 0.78;
  out[3] = clamp01(a * edge);
}

function paintSliver(u, v, out, seed) {
  // Tapered splinter along +v with a slight kink.
  const bend = (fbm(v * 3.0, seed * 0.7, seed, 2) - 0.5) * 0.22;
  const width = mix(0.19, 0.035, v) * (0.6 + hash1(seed, 9) * 0.7);
  const across = Math.abs(u - 0.5 - bend) / Math.max(width, 1e-3);
  let a = smoothstep(1.0, 0.25, across);
  a *= smoothstep(0.0, 0.08, v) * smoothstep(1.0, 0.86, v);
  const shade = mix(0.55, 1.0, 1 - across);
  out[0] = clamp01(shade); out[1] = clamp01(shade * 0.95); out[2] = clamp01(shade * 0.88);
  out[3] = clamp01(a);
}

function paintRing(u, v, out) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx + dy * dy);
  const band = 1 - Math.min(1, Math.abs(r - 0.66) / 0.24);
  out[0] = out[1] = out[2] = 1.0;
  out[3] = clamp01(band * band * smoothstep(1.0, 0.86, r));
}

function paintPool(u, v, out) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx + dy * dy);
  const a = smoothstep(1.0, 0.0, r);
  out[0] = out[1] = out[2] = 1.0;
  out[3] = clamp01(a * a * 0.85);
}

function paintSparkle(u, v, out, seed) {
  let a = 0;
  for (let i = 0; i < 9; i++) {
    const cx = 0.5 + (hash1(i * 7 + seed, 11) - 0.5) * 0.82;
    const cy = 0.5 + (hash1(i * 7 + seed, 12) - 0.5) * 0.82;
    const rad = 0.018 + hash1(i * 7 + seed, 13) * 0.05;
    const d = Math.hypot(u - cx, v - cy) / rad;
    a = Math.max(a, smoothstep(1.0, 0.0, d));
  }
  out[0] = 0.92; out[1] = 0.97; out[2] = 1.0;
  out[3] = clamp01(a * smoothstep(1.0, 0.78, Math.hypot(u - 0.5, v - 0.5) * 2));
}

function paintSoot(u, v, out, seed) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx * 0.8 + dy * dy * 1.3);
  const n = fbm(u * 4.4 + 3.0, v * 4.4 + 8.0, seed, 5);
  let a = smoothstep(0.92 + (n - 0.5) * 0.6, 0.0, r);
  a *= mix(0.2, 1.0, n);
  out[0] = out[1] = out[2] = clamp01(mix(0.22, 0.62, n));
  out[3] = clamp01(a * 0.9);
}

const PARTICLE_PAINTERS = [
  (u, v, o) => paintPuff(u, v, o, 101, { edge: 0.80, lumpiness: 0.34, freq: 4.4 }),
  (u, v, o) => paintPuff(u, v, o, 233, { edge: 0.74, lumpiness: 0.44, freq: 5.6, densityMin: 0.36 }),
  (u, v, o) => paintWisp(u, v, o, 401),
  (u, v, o) => paintDense(u, v, o, 577),
  (u, v, o) => paintSpark(u, v, o),
  (u, v, o) => paintStreak(u, v, o),
  (u, v, o) => paintFlashStar(u, v, o, 907),
  (u, v, o) => paintFlashBlob(u, v, o, 1093),
  (u, v, o) => paintEmber(u, v, o),
  (u, v, o) => paintMote(u, v, o),
  (u, v, o) => paintMist(u, v, o, 1361),
  (u, v, o) => paintSliver(u, v, o, 1567),
  (u, v, o) => paintRing(u, v, o),
  (u, v, o) => paintPool(u, v, o),
  (u, v, o) => paintSparkle(u, v, o, 1811),
  (u, v, o) => paintSoot(u, v, o, 2003),
];

/* ─────────────────────────── decal painters ─────────────────────────────── */

/**
 * A bullet hole is three concentric events, and skipping any one of them is
 * what makes browser bullet holes look like stickers:
 *   1. the entry cavity  — near-black, tiny, hard-edged
 *   2. the chipped rim   — BRIGHTER than the wall (fresh, unweathered material)
 *   3. the spall halo    — dusty, irregular, fading, with radial micro-cracks
 */
function bulletProfile(u, v, seed, cfg) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  let r = Math.sqrt(dx * dx + dy * dy);
  const ang = Math.atan2(dy, dx);

  // Warp the radius so nothing is concentric.
  const warp = fbm(Math.cos(ang) * 2.4 + 5.0, Math.sin(ang) * 2.4 + 1.0, seed, 4);
  r *= 1.0 + (warp - 0.5) * (cfg.irregular ?? 0.34);

  const coreR = cfg.coreR ?? 0.20;
  const rimR = cfg.rimR ?? 0.36;
  const haloR = cfg.haloR ?? 0.92;

  const core = smoothstep(coreR, coreR * 0.55, r);          // 1 inside the cavity
  const rim = smoothstep(rimR, coreR * 0.9, r) * (1 - core * 0.9);
  let halo = smoothstep(haloR, rimR * 0.9, r);

  // Radial micro-cracks — hashed per angle so they are irregular in count,
  // length and thickness.
  let crack = 0;
  const spokes = cfg.cracks ?? 0;
  for (let i = 0; i < spokes; i++) {
    const a0 = hash1(seed + i * 37, 5) * Math.PI * 2;
    const len = (cfg.crackLen ?? 0.85) * (0.35 + hash1(seed + i * 37, 6) * 0.9);
    const thick = 0.014 + hash1(seed + i * 37, 7) * 0.030;
    let da = ang - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const wobble = (fbm(r * 7.0, i * 3.3, seed + 91, 3) - 0.5) * 0.22;
    const dist = Math.abs(da + wobble) * Math.max(r, 0.06);
    const along = smoothstep(len, len * 0.25, r) * smoothstep(coreR * 0.6, coreR * 1.4, r);
    crack = Math.max(crack, smoothstep(thick, 0.0, dist) * along);
  }

  const grain = fbm(u * 13.0, v * 13.0, seed + 303, 4);
  halo *= mix(0.18, 1.0, grain);

  return { r, ang, core, rim, halo, crack, grain };
}

function paintBulletHole(u, v, out, seed, cfg) {
  const p = bulletProfile(u, v, seed, cfg);
  const cav = cfg.cavity ?? [0.020, 0.019, 0.018];
  const rimC = cfg.rimColor ?? [0.78, 0.76, 0.72];
  const haloC = cfg.haloColor ?? [0.62, 0.60, 0.57];
  const crackC = cfg.crackColor ?? [0.14, 0.135, 0.13];

  // Alpha: cavity and rim are opaque, halo is a dusting.
  let a = clamp01(p.core + p.rim * 0.98 + p.halo * (cfg.haloAlpha ?? 0.46) + p.crack * 0.85);
  // Hard border mask so mip levels can only bleed transparency between tiles.
  a *= smoothstep(1.0, 0.80, Math.hypot(u - 0.5, v - 0.5) * 2);

  const rimShade = mix(0.72, 1.18, p.grain);
  let r = cav[0] * p.core;
  let g = cav[1] * p.core;
  let b = cav[2] * p.core;
  r += rimC[0] * rimShade * p.rim; g += rimC[1] * rimShade * p.rim; b += rimC[2] * rimShade * p.rim;
  const hs = mix(0.65, 1.1, p.grain);
  r += haloC[0] * hs * p.halo; g += haloC[1] * hs * p.halo; b += haloC[2] * hs * p.halo;
  const ck = p.crack * (1 - p.core);
  r = mix(r, crackC[0], ck); g = mix(g, crackC[1], ck); b = mix(b, crackC[2], ck);

  // Soot ring — every round leaves burnt propellant around the entry.
  const soot = smoothstep(cfg.sootR ?? 0.62, (cfg.rimR ?? 0.36) * 0.8, p.r) * (cfg.soot ?? 0.35);
  const sk = soot * (1 - p.core) * mix(0.4, 1.0, p.grain);
  r = mix(r, 0.055, sk); g = mix(g, 0.050, sk); b = mix(b, 0.046, sk);

  out[0] = clamp01(r); out[1] = clamp01(g); out[2] = clamp01(b);
  out[3] = clamp01(a);
}

function paintGlassCrack(u, v, out, seed) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx + dy * dy);
  const ang = Math.atan2(dy, dx);

  let line = 0;
  for (let i = 0; i < 11; i++) {
    const a0 = hash1(seed + i * 41, 2) * Math.PI * 2;
    let da = ang - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const wobble = (fbm(r * 5.5, i * 2.7, seed + 13, 3) - 0.5) * 0.30;
    const dist = Math.abs(da + wobble) * Math.max(r, 0.05);
    const len = 0.45 + hash1(seed + i * 41, 4) * 0.55;
    line = Math.max(line, smoothstep(0.020, 0.0, dist) * smoothstep(len, len * 0.2, r));
  }
  // Concentric fracture rings.
  for (let i = 0; i < 3; i++) {
    const rr = 0.16 + i * 0.19 + hash1(seed + i, 8) * 0.07;
    const wob = (fbm(Math.cos(ang) * 3.0, Math.sin(ang) * 3.0, seed + i * 9, 3) - 0.5) * 0.10;
    line = Math.max(line, smoothstep(0.020, 0.0, Math.abs(r - rr + wob)) * 0.8);
  }
  const shatter = smoothstep(0.20, 0.0, r);
  let a = clamp01(line * 0.95 + shatter * 0.85);
  a *= smoothstep(1.0, 0.82, r);
  out[0] = 0.90; out[1] = 0.94; out[2] = 0.97;
  out[3] = a;
}

function paintDirtCrater(u, v, out, seed) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const ang = Math.atan2(dy, dx);
  const warp = fbm(Math.cos(ang) * 2.0 + 2.0, Math.sin(ang) * 2.0, seed, 4);
  const r = Math.sqrt(dx * dx + dy * dy) * (1 + (warp - 0.5) * 0.45);
  const grain = fbm(u * 10.0, v * 10.0, seed + 71, 4);

  const pit = smoothstep(0.34, 0.06, r);
  const ridge = smoothstep(0.62, 0.34, r) * (1 - pit);
  const dust = smoothstep(0.98, 0.55, r);

  let a = clamp01(pit * 0.95 + ridge * 0.8 + dust * 0.42 * mix(0.2, 1.0, grain));
  a *= smoothstep(1.0, 0.80, Math.hypot(u - 0.5, v - 0.5) * 2);

  const dark = [0.085, 0.070, 0.052];
  const loose = [0.31, 0.255, 0.185];
  const pale = [0.44, 0.385, 0.30];
  let rr = dark[0] * pit + loose[0] * ridge * mix(0.7, 1.2, grain) + pale[0] * dust * 0.8;
  let gg = dark[1] * pit + loose[1] * ridge * mix(0.7, 1.2, grain) + pale[1] * dust * 0.8;
  let bb = dark[2] * pit + loose[2] * ridge * mix(0.7, 1.2, grain) + pale[2] * dust * 0.8;
  out[0] = clamp01(rr); out[1] = clamp01(gg); out[2] = clamp01(bb);
  out[3] = a;
}

function paintBlood(u, v, out, seed, cfg) {
  const cx = 0.5, cy = 0.5;
  const dx = (u - cx) * 2, dy = (v - cy) * 2;
  const ang = Math.atan2(dy, dx);
  const warp = fbm(Math.cos(ang) * 2.6 + 7.0, Math.sin(ang) * 2.6 + 4.0, seed, 4);
  const r = Math.sqrt(dx * dx + dy * dy) * (1 + (warp - 0.5) * 0.55);

  let a = smoothstep(cfg.mainR ?? 0.46, (cfg.mainR ?? 0.46) * 0.45, r);

  // Satellite droplets, biased outward — reads as directional cast-off.
  const n = cfg.drops ?? 14;
  for (let i = 0; i < n; i++) {
    const da = hash1(seed + i * 53, 1) * Math.PI * 2;
    const dr = 0.28 + hash1(seed + i * 53, 2) * 0.62;
    const px = 0.5 + Math.cos(da) * dr * 0.5;
    const py = 0.5 + Math.sin(da) * dr * 0.5;
    const rad = (0.012 + hash1(seed + i * 53, 3) * 0.045) * (cfg.dropScale ?? 1);
    const d = Math.hypot(u - px, v - py) / rad;
    a = Math.max(a, smoothstep(1.0, 0.2, d) * 0.9);
  }
  a *= smoothstep(1.0, 0.84, Math.hypot(u - 0.5, v - 0.5) * 2);

  const grain = fbm(u * 9.0, v * 9.0, seed + 41, 3);
  // Deliberately dark and desaturated. Bright red is the single fastest way to
  // make a military scene look like a cartoon.
  const edgeDark = smoothstep(0.20, 0.55, r);
  const base = mix(1.0, 0.55, edgeDark) * mix(0.75, 1.1, grain);
  out[0] = clamp01(0.150 * base);
  out[1] = clamp01(0.0165 * base);
  out[2] = clamp01(0.0135 * base);
  out[3] = clamp01(a * (cfg.alpha ?? 0.95));
}

function paintScorch(u, v, out, seed) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const ang = Math.atan2(dy, dx);
  const warp = fbm(Math.cos(ang) * 2.2 + 3.0, Math.sin(ang) * 2.2 + 6.0, seed, 4);
  const r = Math.sqrt(dx * dx + dy * dy) * (1 + (warp - 0.5) * 0.55);
  const grain = fbm(u * 7.5, v * 7.5, seed + 5, 5);
  // Stipple. A smooth alpha ramp through an alpha test produces a hard-edged
  // blob, which is exactly what a soot mark must not be. High-frequency noise
  // straddling the cutoff lets the test carve a broken, organic edge instead.
  const stip = fbm(u * 26.0, v * 26.0, seed + 61, 3);
  let a = smoothstep(0.78, 0.0, r) * mix(0.30, 1.25, grain) * mix(0.42, 1.30, stip);
  a *= smoothstep(1.0, 0.80, Math.hypot(u - 0.5, v - 0.5) * 2);
  const c = mix(0.030, 0.115, grain);
  out[0] = c; out[1] = c * 0.94; out[2] = c * 0.88;
  out[3] = clamp01(a);
}

function paintFabricHit(u, v, out, seed) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx + dy * dy);
  const ang = Math.atan2(dy, dx);
  let fibre = 0;
  for (let i = 0; i < 14; i++) {
    const a0 = hash1(seed + i * 29, 1) * Math.PI * 2;
    let da = ang - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const dist = Math.abs(da) * Math.max(r, 0.05);
    const len = 0.22 + hash1(seed + i * 29, 2) * 0.28;
    fibre = Math.max(fibre, smoothstep(0.016, 0.0, dist) * smoothstep(len, len * 0.2, r));
  }
  const hole = smoothstep(0.16, 0.02, r);
  const spill = smoothstep(0.60, 0.14, r) * fbm(u * 8, v * 8, seed + 3, 4);
  let a = clamp01(hole + fibre * 0.8 + spill * 0.55);
  a *= smoothstep(1.0, 0.82, r);
  const grain = fbm(u * 11, v * 11, seed + 9, 3);
  out[0] = clamp01(mix(0.045, 0.30, grain) * (1 - hole * 0.8) + 0.26 * fibre);
  out[1] = clamp01(mix(0.042, 0.27, grain) * (1 - hole * 0.8) + 0.24 * fibre);
  out[2] = clamp01(mix(0.038, 0.21, grain) * (1 - hole * 0.8) + 0.19 * fibre);
  out[3] = a;
}

function paintSootSmudge(u, v, out, seed) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx * 0.75 + dy * dy * 1.25);
  const n = fbm(u * 3.6 + 1.0, v * 3.6 + 5.0, seed, 5);
  const stip = fbm(u * 22.0, v * 22.0, seed + 47, 3);
  let a = smoothstep(0.92 + (n - 0.5) * 0.5, 0.05, r)
    * mix(0.12, 1.15, n) * mix(0.40, 1.35, stip);
  a *= smoothstep(1.0, 0.80, Math.hypot(u - 0.5, v - 0.5) * 2);
  const c = mix(0.045, 0.16, n);
  out[0] = c; out[1] = c * 0.96; out[2] = c * 0.92;
  out[3] = clamp01(a);
}

function paintGouge(u, v, out, seed) {
  // Long asphalt/rubber scrape — used for ricochets on the ground.
  const bend = (fbm(v * 2.4, 3.1, seed, 3) - 0.5) * 0.18;
  const across = Math.abs(u - 0.5 - bend) * 2;
  const width = mix(0.55, 0.16, Math.abs(v - 0.5) * 2);
  let a = smoothstep(width, width * 0.15, across);
  a *= smoothstep(0.0, 0.12, v) * smoothstep(1.0, 0.88, v);
  const grain = fbm(u * 14, v * 6, seed + 4, 4);
  a *= mix(0.35, 1.0, grain);
  const c = mix(0.10, 0.40, grain);
  out[0] = clamp01(c * 1.02); out[1] = clamp01(c * 0.98); out[2] = clamp01(c * 0.92);
  out[3] = clamp01(a * 0.9);
}

const DECAL_PAINTERS = [
  // 0 concrete A
  (u, v, o) => paintBulletHole(u, v, o, 3301, {
    coreR: 0.18, rimR: 0.34, haloR: 0.94, cracks: 7, crackLen: 0.85, soot: 0.30,
    rimColor: [0.80, 0.785, 0.745], haloColor: [0.60, 0.585, 0.55], haloAlpha: 0.50,
  }),
  // 1 metal A — torn bright rim, heavy soot, no dust halo
  (u, v, o) => paintBulletHole(u, v, o, 4177, {
    coreR: 0.145, rimR: 0.33, haloR: 0.60, cracks: 6, crackLen: 0.48, soot: 0.42, sootR: 0.80,
    irregular: 0.48, rimColor: [0.94, 0.935, 0.915], haloColor: [0.26, 0.235, 0.205],
    haloAlpha: 0.42, crackColor: [0.44, 0.42, 0.39],
  }),
  // 2 wood A — pale splintered fibres
  (u, v, o) => paintBulletHole(u, v, o, 5233, {
    coreR: 0.19, rimR: 0.36, haloR: 0.90, cracks: 11, crackLen: 0.95, soot: 0.26,
    irregular: 0.44, rimColor: [0.66, 0.545, 0.375], haloColor: [0.40, 0.325, 0.225],
    haloAlpha: 0.40, crackColor: [0.55, 0.44, 0.29],
  }),
  // 3 plaster / drywall — big white powder halo
  (u, v, o) => paintBulletHole(u, v, o, 6113, {
    coreR: 0.20, rimR: 0.35, haloR: 0.72, cracks: 8, crackLen: 0.8, soot: 0.22,
    rimColor: [0.88, 0.875, 0.862], haloColor: [0.74, 0.735, 0.72], haloAlpha: 0.34,
  }),
  (u, v, o) => paintGlassCrack(u, v, o, 7001),
  (u, v, o) => paintDirtCrater(u, v, o, 7717),
  (u, v, o) => paintBlood(u, v, o, 8231, { mainR: 0.46, drops: 15, alpha: 0.95 }),
  (u, v, o) => paintBlood(u, v, o, 8681, { mainR: 0.30, drops: 22, dropScale: 0.7, alpha: 0.88 }),
  (u, v, o) => paintScorch(u, v, o, 9109),
  (u, v, o) => paintFabricHit(u, v, o, 9631),
  // 10 concrete B
  (u, v, o) => paintBulletHole(u, v, o, 10267, {
    coreR: 0.165, rimR: 0.31, haloR: 0.86, cracks: 9, crackLen: 0.95, soot: 0.38,
    irregular: 0.46, rimColor: [0.76, 0.75, 0.72], haloColor: [0.56, 0.55, 0.52], haloAlpha: 0.44,
  }),
  // 11 metal B
  (u, v, o) => paintBulletHole(u, v, o, 11311, {
    coreR: 0.13, rimR: 0.30, haloR: 0.56, cracks: 7, crackLen: 0.44, soot: 0.38, sootR: 0.76,
    irregular: 0.55, rimColor: [0.90, 0.895, 0.875], haloColor: [0.24, 0.22, 0.19],
    haloAlpha: 0.40, crackColor: [0.46, 0.44, 0.40],
  }),
  // 12 wood B
  (u, v, o) => paintBulletHole(u, v, o, 12433, {
    coreR: 0.165, rimR: 0.32, haloR: 0.84, cracks: 13, crackLen: 1.0, soot: 0.22,
    irregular: 0.5, rimColor: [0.62, 0.51, 0.35], haloColor: [0.36, 0.29, 0.20],
    haloAlpha: 0.36, crackColor: [0.50, 0.40, 0.26],
  }),
  // 13 blood pool
  (u, v, o) => paintBlood(u, v, o, 13217, { mainR: 0.68, drops: 12, dropScale: 1.35, alpha: 0.95 }),
  (u, v, o) => paintSootSmudge(u, v, o, 14009),
  (u, v, o) => paintGouge(u, v, o, 15013),
];

/* ── height fields used to derive the decal normal + ORM atlases ───────────── */

/** Signed surface height in tile space, in "arbitrary dent units". */
function decalHeight(tile, u, v) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r0 = Math.sqrt(dx * dx + dy * dy);
  const ang = Math.atan2(dy, dx);

  switch (tile) {
    case D.HOLE_CONCRETE_A: case D.HOLE_CONCRETE_B:
    case D.HOLE_METAL_A: case D.HOLE_METAL_B:
    case D.HOLE_WOOD_A: case D.HOLE_WOOD_B:
    case D.HOLE_PLASTER: {
      const seed = 3301 + tile * 977;
      const warp = fbm(Math.cos(ang) * 2.4 + 5.0, Math.sin(ang) * 2.4 + 1.0, seed, 3);
      const r = r0 * (1 + (warp - 0.5) * 0.35);
      const cavity = -smoothstep(0.36, 0.02, r) * 1.0;              // pit
      const lip = smoothstep(0.52, 0.30, r) * (1 - smoothstep(0.32, 0.16, r)) * 0.34; // raised rim
      const rough = (fbm(u * 18, v * 18, seed + 7, 3) - 0.5) * 0.10 * smoothstep(0.95, 0.2, r);
      return cavity + lip + rough;
    }
    case D.DIRT_CRATER: {
      const warp = fbm(Math.cos(ang) * 2.0 + 2.0, Math.sin(ang) * 2.0, 7717, 3);
      const r = r0 * (1 + (warp - 0.5) * 0.45);
      return -smoothstep(0.46, 0.05, r) * 0.75 + smoothstep(0.72, 0.42, r) * 0.30;
    }
    case D.GLASS_CRACK:
      return (fbm(u * 20, v * 20, 7001, 3) - 0.5) * 0.14 * smoothstep(0.95, 0.1, r0);
    case D.GOUGE: {
      const bend = (fbm(v * 2.4, 3.1, 15013, 3) - 0.5) * 0.18;
      const across = Math.abs(u - 0.5 - bend) * 2;
      const width = mix(0.55, 0.16, Math.abs(v - 0.5) * 2);
      return -smoothstep(width, width * 0.2, across) * 0.45;
    }
    default:
      return 0;
  }
}

/** R = AO, G = roughness, B = metalness for a decal tile. */
function decalORM(tile, u, v, out) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r = Math.sqrt(dx * dx + dy * dy);
  const h = decalHeight(tile, u, v);
  // Cavities occlude.
  const ao = clamp01(1 + Math.min(0, h) * 0.85);

  let rough = 0.90, metal = 0.0;
  switch (tile) {
    case D.HOLE_METAL_A: case D.HOLE_METAL_B: {
      // Freshly torn steel is bright and much smoother than the weathered plate.
      const rim = smoothstep(0.34, 0.12, r) * (1 - smoothstep(0.16, 0.05, r));
      rough = mix(0.86, 0.30, rim);
      metal = mix(0.06, 0.92, rim);
      break;
    }
    case D.HOLE_CONCRETE_A: case D.HOLE_CONCRETE_B:
      rough = mix(0.97, 0.86, smoothstep(0.45, 0.15, r));
      break;
    case D.HOLE_WOOD_A: case D.HOLE_WOOD_B:
      rough = mix(0.94, 0.78, smoothstep(0.42, 0.15, r));
      break;
    case D.HOLE_PLASTER: rough = 0.96; break;
    case D.GLASS_CRACK: rough = mix(0.12, 0.55, fbm(u * 12, v * 12, 7001, 3)); break;
    case D.BLOOD_A: case D.BLOOD_B: case D.BLOOD_POOL:
      // Wet: the one place in this palette where a low roughness is correct.
      rough = mix(0.20, 0.46, fbm(u * 8, v * 8, 8231, 3));
      break;
    case D.SCORCH: case D.SOOT_SMUDGE: rough = 0.99; break;
    case D.DIRT_CRATER: rough = 0.97; break;
    case D.GOUGE: rough = 0.88; break;
    default: rough = 0.92; break;
  }
  out[0] = ao; out[1] = clamp01(rough); out[2] = clamp01(metal);
}

/* ───────────────────────────── bakery ────────────────────────────────────── */

function makeTexture(data, size, srgb, aniso) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/**
 * Bake the particle atlas. 512², 4x4 of 128.
 * @returns {THREE.DataTexture}
 */
export function buildParticleAtlas(size = 512, aniso = 4) {
  const tile = size / GRID;
  const data = new Uint8Array(size * size * 4);
  const out = [0, 0, 0, 0];
  for (let ty = 0; ty < GRID; ty++) {
    for (let tx = 0; tx < GRID; tx++) {
      const id = ty * GRID + tx;
      const paint = PARTICLE_PAINTERS[id];
      for (let y = 0; y < tile; y++) {
        const v = (y + 0.5) / tile;
        for (let x = 0; x < tile; x++) {
          const u = (x + 0.5) / tile;
          out[0] = out[1] = out[2] = out[3] = 0;
          paint(u, v, out);
          // Guaranteed transparent gutter: mip bleed can only spread alpha 0.
          const gutter = smoothstep(0.5, 0.455, Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)));
          const px = ((ty * tile + y) * size + (tx * tile + x)) * 4;
          data[px] = (clamp01(out[0]) * 255) | 0;
          data[px + 1] = (clamp01(out[1]) * 255) | 0;
          data[px + 2] = (clamp01(out[2]) * 255) | 0;
          data[px + 3] = (clamp01(out[3] * gutter) * 255) | 0;
        }
      }
    }
  }
  return makeTexture(data, size, false, aniso);
}

/**
 * Bake the three decal atlases in one pass.
 * @returns {{ albedo:THREE.DataTexture, normal:THREE.DataTexture, orm:THREE.DataTexture }}
 */
export function buildDecalAtlases(albedoSize = 1024, dataSize = 512, aniso = 8) {
  const at = albedoSize / GRID;
  const albedo = new Uint8Array(albedoSize * albedoSize * 4);
  const out = [0, 0, 0, 0];

  for (let ty = 0; ty < GRID; ty++) {
    for (let tx = 0; tx < GRID; tx++) {
      const id = ty * GRID + tx;
      const paint = DECAL_PAINTERS[id];
      for (let y = 0; y < at; y++) {
        const v = (y + 0.5) / at;
        for (let x = 0; x < at; x++) {
          const u = (x + 0.5) / at;
          out[0] = out[1] = out[2] = out[3] = 0;
          paint(u, v, out);
          const gutter = smoothstep(0.5, 0.462, Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)));
          const px = ((ty * at + y) * albedoSize + (tx * at + x)) * 4;
          albedo[px] = (clamp01(out[0]) * 255) | 0;
          albedo[px + 1] = (clamp01(out[1]) * 255) | 0;
          albedo[px + 2] = (clamp01(out[2]) * 255) | 0;
          albedo[px + 3] = (clamp01(out[3] * gutter) * 255) | 0;
        }
      }
    }
  }

  const dt = dataSize / GRID;
  const normal = new Uint8Array(dataSize * dataSize * 4);
  const orm = new Uint8Array(dataSize * dataSize * 4);
  const eps = 1 / dt;
  const ormOut = [1, 0.9, 0];

  for (let ty = 0; ty < GRID; ty++) {
    for (let tx = 0; tx < GRID; tx++) {
      const id = ty * GRID + tx;
      for (let y = 0; y < dt; y++) {
        const v = (y + 0.5) / dt;
        for (let x = 0; x < dt; x++) {
          const u = (x + 0.5) / dt;
          const px = ((ty * dt + y) * dataSize + (tx * dt + x)) * 4;

          // Central differences on the height field -> tangent-space normal.
          const hL = decalHeight(id, u - eps, v);
          const hR = decalHeight(id, u + eps, v);
          const hD = decalHeight(id, u, v - eps);
          const hU = decalHeight(id, u, v + eps);
          const STRENGTH = 5.0;
          let nx = (hL - hR) * STRENGTH;
          let ny = (hD - hU) * STRENGTH;
          let nz = 1.0;
          const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
          nx *= inv; ny *= inv; nz *= inv;
          normal[px] = ((nx * 0.5 + 0.5) * 255) | 0;
          normal[px + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
          normal[px + 2] = ((nz * 0.5 + 0.5) * 255) | 0;
          normal[px + 3] = 255;

          decalORM(id, u, v, ormOut);
          orm[px] = (clamp01(ormOut[0]) * 255) | 0;
          orm[px + 1] = (clamp01(ormOut[1]) * 255) | 0;
          orm[px + 2] = (clamp01(ormOut[2]) * 255) | 0;
          orm[px + 3] = 255;
        }
      }
    }
  }

  return {
    albedo: makeTexture(albedo, albedoSize, true, aniso),
    normal: makeTexture(normal, dataSize, false, aniso),
    orm: makeTexture(orm, dataSize, false, aniso),
  };
}

/** Small paper-scrap texture for the ambient-life litter. Opaque, alpha-tested. */
export function buildPaperTexture(size = 128) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      // Torn irregular sheet.
      const edge = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2;
      const tear = fbm(u * 6.0, v * 6.0, 2411, 4);
      const a = edge < (0.80 + (tear - 0.5) * 0.32) ? 1 : 0;
      const stain = fbm(u * 4.5, v * 4.5, 991, 4);
      const grime = fbm(u * 16.0, v * 16.0, 313, 3);
      const l = clamp01(mix(0.30, 0.62, stain) * mix(0.82, 1.06, grime));
      const px = (y * size + x) * 4;
      data[px] = (clamp01(l * 1.02) * 255) | 0;
      data[px + 1] = (clamp01(l * 0.99) * 255) | 0;
      data[px + 2] = (clamp01(l * 0.90) * 255) | 0;
      data[px + 3] = a * 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export { GRID as ATLAS_GRID };
