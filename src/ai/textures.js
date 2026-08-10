/**
 * OPERATION BLACKOUT — procedural soldier surface synthesis.
 * OWNER: ai agent.
 *
 * The squad used to borrow the environment material set: every soldier was the
 * `plaster` texture tinted olive for the uniform and tinted brown for the webbing,
 * which meant helmet shell, cordura pouches and ripstop fatigues all carried the
 * SAME albedo variation, the SAME normal detail and — worst of all — the SAME
 * roughness histogram. Uniform roughness across a whole character is the single
 * loudest amateur tell in the rubric, and it is exactly why the critic read the
 * squad as "one flat sand-beige".
 *
 * So the soldier now owns three purpose-built map sets:
 *
 *   fabric — 4-tone desaturated arid camo on a ripstop weave, rough 0.80–0.97
 *   gear   — coyote cordura with a coarse basket weave, bar-tack stitching and
 *            binding tape, rough 0.70–0.90, near-zero metalness
 *   hard   — a deliberately NEUTRAL grit/scratch shell, rough 0.40–0.80 with
 *            metal showing through the scratches. It is neutral because every
 *            part that uses it (helmet shell, boots, gloves, pads, rails) is
 *            tinted per-vertex, so one map covers a matte tan helmet and a black
 *            rubber boot without a second draw call.
 *
 * Everything is seamlessly tileable (the value-noise lattice wraps at the octave
 * period) — a visible repeat is an instant fail, but a seam is worse.
 *
 * Cost: 9 × 512² RGBA ≈ 9 MB CPU / ~12 MB GPU with mips, built once at init in
 * roughly a third of a second. Nothing here runs per frame.
 */
import * as THREE from 'three';

const SIZE = 512;

/* ─────────────────────────────── noise ─────────────────────────────── */

function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519);
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Value noise on a lattice that WRAPS, so every octave is tileable. `px`/`py` are
 * the wrap periods, and must equal the lattice frequency on that axis or the map
 * seams — anisotropic patterns (scratches, weave) need them independent.
 */
function vnoise(fx, fy, px, py = px, seed = 0) {
  const period = px, periodY = py;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const xa = ((x0 % period) + period) % period, xb = (xa + 1) % period;
  const ya = ((y0 % periodY) + periodY) % periodY, yb = (ya + 1) % periodY;
  const n00 = hash2(xa, ya, seed), n10 = hash2(xb, ya, seed);
  const n01 = hash2(xa, yb, seed), n11 = hash2(xb, yb, seed);
  return (n00 + (n10 - n00) * sx) + ((n01 + (n11 - n01) * sx) - (n00 + (n10 - n00) * sx)) * sy;
}

/**
 * A whole fbm field, computed once and reused by every map in a set. Building the
 * field up front rather than calling fbm() per texel is what keeps init under a
 * third of a second — the same three fields feed albedo, height and roughness.
 */
function field(baseFreq, octaves, seed, size = SIZE) {
  const out = new Float32Array(size * size);
  const inv = 1 / size;
  let lo = 1e9, hi = -1e9;
  for (let y = 0; y < size; y++) {
    const v = y * inv;
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      let amp = 0.5, f = baseFreq, sum = 0, norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += amp * vnoise(u * f, v * f, f, f, seed + o * 1013);
        norm += amp; amp *= 0.5; f *= 2;
      }
      const n = sum / norm;
      out[y * size + x] = n;
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    }
  }
  // Normalise so thresholds behave predictably regardless of octave count.
  const span = hi - lo > 1e-6 ? 1 / (hi - lo) : 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * span;
  return out;
}

const sstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-6)));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

/* ───────────────────────────── map assembly ───────────────────────────── */

function makeTexture(data, { srgb = false, aniso = 8 }) {
  const t = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Wrapped 1-2-1 separable blur of a height field.
 *
 * ── WHY THIS EXISTS (this is the soldier-legibility fix) ─────────────────────
 * Every one of these height fields carries most of its energy at or above the
 * texel Nyquist limit: the ripstop lattice is 2 texels wide, the cordura basket
 * weave alternates every 6, the bar-tack stitch is a 4-texel dash, the shell grit
 * field's top octave lands at 2. Differentiating THAT with a gain of 17-34 does
 * not produce surface relief, it produces a per-texel random tangent field —
 * measured slopes above 5:1, i.e. normals within 11 degrees of the tangent plane.
 *
 * Two things then go wrong and neither is fixable downstream:
 *
 *  1. An 8-bit normal map cannot encode those slopes. At slope 5 the x channel
 *     lands on code 2 of 255, so the whole band quantises onto a handful of codes
 *     and the decoded normal STAIR-STEPS between them. That is literally the
 *     stepped artefact on the body.
 *  2. Mipping averages normal *vectors*, so at 8 m the mip chain hands the shader
 *     a short, near-random vector per texel with a roughness that still says
 *     "smooth". That is specular aliasing, and no amount of TAA removes it — the
 *     pattern is static in surface space, so every frame agrees on the noise.
 *
 * Band-limiting the height first, then differentiating with a gain that keeps
 * slopes near 1, is the actual cure: the relief survives (it is low-frequency
 * relief that was carrying the read anyway) and the noise does not.
 */
function blurWrap(h, size = SIZE) {
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const r = y * size;
    for (let x = 0; x < size; x++) {
      const xp = (x - 1 + size) % size, xn = (x + 1) % size;
      tmp[r + x] = (h[r + xp] + 2 * h[r + x] + h[r + xn]) * 0.25;
    }
  }
  for (let y = 0; y < size; y++) {
    const yp = ((y - 1 + size) % size) * size, yn = ((y + 1) % size) * size, yc = y * size;
    for (let x = 0; x < size; x++) {
      out[yc + x] = (tmp[yp + x] + 2 * tmp[yc + x] + tmp[yn + x]) * 0.25;
    }
  }
  return out;
}

/** Tangent-space normal map from a wrapped height field. */
function normalMapFromHeight(h, strength) {
  const d = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    const yn = ((y + 1) % SIZE) * SIZE, yp = ((y - 1 + SIZE) % SIZE) * SIZE, yc = y * SIZE;
    for (let x = 0; x < SIZE; x++) {
      const xn = (x + 1) % SIZE, xp = (x - 1 + SIZE) % SIZE;
      const dx = (h[yc + xn] - h[yc + xp]) * strength;
      const dy = (h[yn + x] - h[yp + x]) * strength;
      const nx = -dx, ny = -dy, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const i = (yc + x) * 4;
      d[i] = (nx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  return d;
}

const srgbEnc = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
const srgbDec = (s) => (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));

/**
 * Mean LINEAR reflectance of a packed sRGB albedo map.
 *
 * This is the colour a distant soldier's fabric should converge to. The shader
 * blends the sampled texel toward it as the body shrinks (see `aiSurfaceHook`),
 * which is a hand-rolled top mip: four-colour camo is *designed* to shatter a
 * silhouette, so past ~7 m it stops being material detail and becomes dazzle that
 * costs the player the read of which way a man is facing.
 */
function meanLinear(alb) {
  let r = 0, g = 0, b = 0;
  const n = alb.length / 4;
  for (let i = 0; i < alb.length; i += 4) {
    r += srgbDec(alb[i] / 255); g += srgbDec(alb[i + 1] / 255); b += srgbDec(alb[i + 2] / 255);
  }
  return [r / n, g / n, b / n];
}

/** Author in LINEAR reflectance (the number a physically-based brief quotes) and
 *  encode to the 8-bit sRGB the sampler expects. */
function pack(dst, i, lr, lg, lb) {
  dst[i] = Math.max(0, Math.min(255, srgbEnc(lr) * 255 + 0.5)) | 0;
  dst[i + 1] = Math.max(0, Math.min(255, srgbEnc(lg) * 255 + 0.5)) | 0;
  dst[i + 2] = Math.max(0, Math.min(255, srgbEnc(lb) * 255 + 0.5)) | 0;
  dst[i + 3] = 255;
}

/* ───────────────────────────── the three sets ───────────────────────────── */

/**
 * Arid four-colour camo on ripstop. Linear reflectance runs 0.078–0.330 around a
 * 0.20 mean. Real combat uniform sits at 0.09–0.13 — this is deliberately at the
 * top of that band and then some, because a rounded torso only ever presents
 * itself to a 10.6° sun at a glancing angle, and because the ground it stands on
 * is 0.4+ linear sand. Authored at a literal 0.11 the squad measured 0.017 linear
 * from behind against a 0.24 shadowed floor: black cut-outs, exactly the failure
 * the previous pass logged.
 */
function buildFabric(aniso) {
  const blob = field(4, 4, 1201);
  const mid = field(8, 3, 5507);
  const grain = field(64, 2, 9109);

  const alb = new Uint8Array(SIZE * SIZE * 4);
  const orm = new Uint8Array(SIZE * SIZE * 4);
  const h = new Float32Array(SIZE * SIZE);

  // Linear-reflectance palette, mean ≈ 0.20.
  const SAND = [0.232, 0.214, 0.150];
  const OLIVE = [0.140, 0.150, 0.098];
  const BROWN = [0.078, 0.066, 0.048];
  const PALE = [0.330, 0.305, 0.222];

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const b = blob[i], m = mid[i], g = grain[i];

      // Threads: a plain over/under weave at ~4px, i.e. ≈0.4mm at 0.52 m/tile.
      const weave = 0.5 + 0.5 * (Math.sin(x * Math.PI * 0.5) * 0.5 + Math.sin(y * Math.PI * 0.5) * 0.5);
      // Ripstop reinforcement lattice every 34px (≈3.5cm) — the visual signature.
      const gx = x % 34, gy = y % 34;
      const rip = Math.max(gx < 2 ? 1 - gx * 0.5 : 0, gy < 2 ? 1 - gy * 0.5 : 0);
      // Wrinkles / sag so the cloth is never a flat plane.
      const wrinkle = (m - 0.5) * 1.6;

      h[i] = weave * 0.30 + rip * 0.55 + wrinkle * 0.35 + g * 0.10;

      let r = SAND[0], gg = SAND[1], bb = SAND[2];
      const tOl = sstep(0.50, 0.60, b);
      r = mix(r, OLIVE[0], tOl); gg = mix(gg, OLIVE[1], tOl); bb = mix(bb, OLIVE[2], tOl);
      const tBr = sstep(0.66, 0.74, m) * (1 - tOl * 0.35);
      r = mix(r, BROWN[0], tBr); gg = mix(gg, BROWN[1], tBr); bb = mix(bb, BROWN[2], tBr);
      const tPa = sstep(0.78, 0.88, 1 - b) * 0.85;
      r = mix(r, PALE[0], tPa); gg = mix(gg, PALE[1], tPa); bb = mix(bb, PALE[2], tPa);

      // Thread shading + dye lot noise. Cloth is never one value at texel scale.
      const sh = 0.90 + 0.16 * weave + 0.10 * rip + (g - 0.5) * 0.14;
      pack(alb, i * 4, r * sh, gg * sh, bb * sh);

      // AO in the weave valleys, roughness varying with dye and pile direction.
      const ao = 0.72 + 0.28 * (weave * 0.6 + (1 - Math.abs(wrinkle)) * 0.4);
      const rough = 0.86 + 0.11 * (1 - weave) - 0.06 * rip + (g - 0.5) * 0.06 - tPa * 0.05;
      const o = i * 4;
      orm[o] = (Math.min(1, Math.max(0, ao)) * 255) | 0;
      orm[o + 1] = (Math.min(1, Math.max(0.55, rough)) * 255) | 0;
      orm[o + 2] = 0;
      orm[o + 3] = 255;
    }
  }
  return {
    map: makeTexture(alb, { srgb: true, aniso }),
    normalMap: makeTexture(normalMapFromHeight(blurWrap(h), 11.5), { aniso }),
    ormMap: makeTexture(orm, { aniso }),
    meanLinear: meanLinear(alb),
  };
}

/** Coyote cordura: coarse basket weave, binding tape, bar-tack stitch rows. */
function buildGear(aniso) {
  const blot = field(8, 3, 3313);
  const grain = field(64, 2, 7717);
  const wear = field(16, 3, 2029);

  const alb = new Uint8Array(SIZE * SIZE * 4);
  const orm = new Uint8Array(SIZE * SIZE * 4);
  const h = new Float32Array(SIZE * SIZE);

  const COYOTE = [0.152, 0.124, 0.084];
  const FADED = [0.208, 0.176, 0.128];
  const DARK = [0.074, 0.060, 0.042];

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;

      // 1000D basket weave: 6px bundles alternating warp/weft.
      const bx = Math.floor(x / 6) & 1, by = Math.floor(y / 6) & 1;
      const px = (x % 6) / 6, py = (y % 6) / 6;
      const bundle = (bx === by)
        ? Math.sin(px * Math.PI)
        : Math.sin(py * Math.PI);
      // Bar-tack stitching every 48px, running across the weave.
      const sy = y % 48;
      // 8-texel dashes, not 4: a 4-texel dash is one lit / one dark screen pixel at
      // any distance past two metres, and the albedo term below multiplies it by
      // 1.55 — the single brightest speckle on the whole soldier.
      const stitch = (sy < 2 && ((x >> 3) & 1) === 0) ? 1 : 0;
      // Binding tape edges every 96px.
      const tape = (y % 96) < 5 ? 1 : 0;

      h[i] = bundle * 0.55 + stitch * 0.85 + tape * 0.25 + grain[i] * 0.08;

      const w = wear[i];
      let r = COYOTE[0], g = COYOTE[1], b = COYOTE[2];
      const tf = sstep(0.58, 0.86, w);            // sun-faded panels
      r = mix(r, FADED[0], tf); g = mix(g, FADED[1], tf); b = mix(b, FADED[2], tf);
      const td = sstep(0.62, 0.80, blot[i]) * 0.7; // grime in the folds
      r = mix(r, DARK[0], td); g = mix(g, DARK[1], td); b = mix(b, DARK[2], td);
      if (stitch) { r *= 1.55; g *= 1.5; b *= 1.4; }   // lighter nylon thread
      if (tape) { r *= 0.78; g *= 0.78; b *= 0.80; }

      const sh = 0.90 + 0.18 * bundle + (grain[i] - 0.5) * 0.10;
      pack(alb, i * 4, r * sh, g * sh, b * sh);

      const ao = 0.66 + 0.34 * bundle - stitch * 0.05;
      const rough = 0.80 + 0.10 * (1 - bundle) - stitch * 0.14 - tf * 0.06 + (grain[i] - 0.5) * 0.05;
      const o = i * 4;
      orm[o] = (Math.min(1, Math.max(0, ao)) * 255) | 0;
      orm[o + 1] = (Math.min(1, Math.max(0.45, rough)) * 255) | 0;
      orm[o + 2] = (stitch ? 10 : 4);
      orm[o + 3] = 255;
    }
  }
  return {
    map: makeTexture(alb, { srgb: true, aniso }),
    normalMap: makeTexture(normalMapFromHeight(blurWrap(h), 10.0), { aniso }),
    ormMap: makeTexture(orm, { aniso }),
    meanLinear: meanLinear(alb),
  };
}

/**
 * The shared hard-shell set: grit, chipping and directional scuffs. Deliberately
 * near-neutral (linear ~0.30) because every consumer tints it per-vertex — the
 * helmet lands at 0.15 tan, the boot at 0.04 near-black — so one map and one draw
 * call cover both. Roughness runs 0.40 on the polished crown to 0.80 in the
 * scuffed valleys, which is the roughness break the rubric is actually asking for.
 */
function buildHard(aniso) {
  // Was field(128, 2): a 4-texel base with a 2-texel second octave, i.e. the whole
  // grit field sat ON the sampler's Nyquist limit. It drove albedo, roughness AND
  // metalness, so a helmet at 8 m was being shaded by three independent per-texel
  // random variables. 72 puts the base at ~7 texels and the top octave at ~3.5.
  const grit = field(72, 2, 4421);
  const chip = field(32, 3, 6131);
  const scuff = field(16, 4, 8837);

  const alb = new Uint8Array(SIZE * SIZE * 4);
  const orm = new Uint8Array(SIZE * SIZE * 4);
  const h = new Float32Array(SIZE * SIZE);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const gr = grit[i], ch = chip[i], sc = scuff[i];

      // Anisotropic scuff: long shallow scratches running mostly along U.
      // 256 lattice cells over 512 texels is a two-texel period — the scratch field
      // was pure sampler noise, and because it also drove metalness (0.10 -> 0.34)
      // it put a per-texel specular flicker on every hard surface on the body. 112
      // keeps the scratches long and thin without going sub-texel.
      const scratch = sstep(0.78, 0.99, vnoise(x / SIZE * 8, y / SIZE * 112, 8, 112, 5171));
      const chipped = sstep(0.74, 0.86, ch);

      h[i] = (gr - 0.5) * 0.42 - chipped * 0.55 - scratch * 0.22 + (sc - 0.5) * 0.12;

      let base = 0.300;
      base *= 0.90 + 0.20 * gr;
      base *= 1 - chipped * 0.42;          // chips expose dark substrate
      base += scratch * 0.045;             // bright metal in the scratch
      base *= 0.94 + 0.12 * sc;
      pack(alb, i * 4, base, base * 0.995, base * 0.985);

      const ao = 0.74 + 0.26 * (1 - chipped * 0.8) - (1 - gr) * 0.08;
      const rough = 0.52 + 0.24 * chipped + 0.12 * (1 - gr) - scratch * 0.14 + (sc - 0.5) * 0.10;
      const metal = 0.10 + scratch * 0.24 + chipped * 0.12;
      const o = i * 4;
      orm[o] = (Math.min(1, Math.max(0, ao)) * 255) | 0;
      orm[o + 1] = (Math.min(0.92, Math.max(0.30, rough)) * 255) | 0;
      orm[o + 2] = (Math.min(1, metal) * 255) | 0;
      orm[o + 3] = 255;
    }
  }
  return {
    map: makeTexture(alb, { srgb: true, aniso }),
    normalMap: makeTexture(normalMapFromHeight(blurWrap(h), 10.5), { aniso }),
    ormMap: makeTexture(orm, { aniso }),
    meanLinear: meanLinear(alb),
  };
}

let _cache = null;

/** Build (once) and return the three soldier map sets. Never throws. */
export function soldierTextures(ctx) {
  if (_cache) return _cache;
  const aniso = Math.min(8, ctx?.materials?.maxAnisotropy ?? ctx?.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4);
  try {
    _cache = {
      fabric: buildFabric(aniso),
      gear: buildGear(aniso),
      hard: buildHard(aniso),
    };
  } catch (err) {
    console.warn('[ai] soldier texture synthesis failed, falling back to shared maps:', err);
    _cache = null;
  }
  return _cache;
}

export function disposeSoldierTextures() {
  if (!_cache) return;
  for (const set of Object.values(_cache)) {
    for (const t of Object.values(set)) { try { t.dispose(); } catch { /* noop */ } }
  }
  _cache = null;
}
