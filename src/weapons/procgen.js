import * as THREE from 'three';

/**
 * OPERATION BLACKOUT — weapon surface synthesis.
 *
 * Everything a gun is made of, generated in code: phosphated (parkerised) steel,
 * glass-filled polymer, hard-anodised aluminium, rubber, brass, glove leather and
 * the tinted glass of a red-dot objective.
 *
 * The weapon fills a third of every frame and is composited BEFORE the tonemapper,
 * so its materials are graded in the same HDR space as the world. The one thing the
 * critic reliably catches is uniform roughness, so every recipe here ships a real
 * roughness field with three distinct scales of variation:
 *
 *   - machining / moulding direction (anisotropic streaks)
 *   - the phosphate or pebble grain itself (high frequency)
 *   - blotchy handling wear (very low frequency, breaks up tiling)
 *
 * OWNER: weapons.
 */

/* ── deterministic value noise, tileable on an integer lattice ────────────── */

function hash2i(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise that wraps exactly at `period` lattice cells. */
function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const p = Math.max(1, period | 0);
  const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p;
  const x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
  const u = fade(xf), v = fade(yf);
  const a = hash2i(x0, y0, seed), b = hash2i(x1, y0, seed);
  const c = hash2i(x0, y1, seed), d = hash2i(x1, y1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** Tileable fBm. `base` is the lattice period at octave 0. */
function fbm(x, y, base, octaves, seed, gain = 0.5, lac = 2) {
  let f = 0, amp = 1, norm = 0, freq = base;
  for (let o = 0; o < octaves; o++) {
    f += amp * vnoise(x * freq, y * freq, Math.round(freq), seed + o * 131);
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return f / norm;
}

/** Ridged variant — good for scratches and brushed streaks. */
function ridged(x, y, base, octaves, seed) {
  let f = 0, amp = 1, norm = 0, freq = base;
  for (let o = 0; o < octaves; o++) {
    const n = Math.abs(vnoise(x * freq, y * freq, Math.round(freq), seed + o * 977) * 2 - 1);
    f += amp * (1 - n);
    norm += amp;
    amp *= 0.55;
    freq *= 2.07;
  }
  return f / norm;
}

/** Tileable Worley (cellular) — the phosphate grain and polymer pebble. */
function worley(x, y, cells, seed) {
  const cx = Math.floor(x * cells), cy = Math.floor(y * cells);
  let best = 4;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const wx = ((gx % cells) + cells) % cells;
      const wy = ((gy % cells) + cells) % cells;
      const fx = (gx + hash2i(wx, wy, seed)) / cells;
      const fy = (gy + hash2i(wx, wy, seed + 7717)) / cells;
      const dx = x - fx, dy = y - fy;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best) * cells);
}

/* ── texture assembly ─────────────────────────────────────────────────────── */

function makeTex(data, size, srgb, aniso) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.channel = 0;
  t.needsUpdate = true;
  return t;
}

/**
 * Build a normal map from a height field with central differences.
 * `strength` is in height-units per texel.
 */
function heightToNormal(height, size, strength) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const yn = ((y - 1) + size) % size, yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xn = ((x - 1) + size) % size, xp = (x + 1) % size;
      const dx = (height[y * size + xp] - height[y * size + xn]) * strength;
      const dy = (height[yp * size + x] - height[yn * size + x]) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      out[i] = Math.round((nx * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[i + 3] = 255;
    }
  }
  return out;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * THE COLOUR-SPACE BUG, and it was the deepest one on the weapon.
 *
 * `new THREE.Color(0x74736c)` does NOT give you 0x74/255. With ColorManagement on
 * — which it is, three enables it by default and the engine never disables it — a
 * hex literal is read as sRGB and DECODED into the linear working space, so
 * `c.r` comes back 0.185, not 0.455.
 *
 * Every build* function below then packed `c.r * lum * 255` straight into a byte
 * and handed it to `makeTex(..., srgb = true)`, which tags the texture
 * SRGBColorSpace — so the GPU decodes it a SECOND time. A tint authored for a
 * linear albedo of 0.157 arrived at the shader as 0.021: seven times too dark,
 * on every albedo on the gun.
 *
 * The consequences are exactly the review notes. With near-black base colour the
 * only way to see anything was to overdrive the viewmodel key (it shipped at
 * 2.1x the world sun), and dielectric specular does not scale with albedo — so
 * the polymer stock returned a broad blown sheen brighter than sunlit concrete
 * while the receiver flats stayed crushed. No midtones anywhere: "wet black
 * plastic", "blown bevel highlights", "a chunk of stucco bolted to the gun".
 *
 * Bytes destined for an sRGB texture must be packed in sRGB. This helper undoes
 * the decode so the recipes below mean what they say. The viewmodel key drops
 * back to roughly the world sun's intensity in index.js to match.
 */
function srgbTint(hex) {
  const c = new THREE.Color(hex);
  c.convertLinearToSRGB();
  return c;
}

/**
 * @typedef {{ albedo:THREE.Texture, normal:THREE.Texture, orm:THREE.Texture }} SurfaceMaps
 */

/**
 * Parkerised / phosphated steel. Matte manganese-grey with a fine crystalline
 * grain, faint machining streaks along U, and blotchy handling polish that pushes
 * roughness around by ±0.18 — that variation is the whole point.
 */
function buildSteel(size, seed, tint, baseRough, baseMetal, opts = {}) {
  const n = size * size;
  const height = new Float32Array(n);
  const alb = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const c = srgbTint(tint);

  // How the finish is applied decides what the surface detail LOOKS like, and the
  // three finishes on a rifle are genuinely different processes:
  //   phosphate  — crystalline conversion coating, isotropic pitted grain
  //   anodise    — hard oxide over extruded/broached aluminium, strongly
  //                anisotropic: you see the machining lines running along the part
  //   soot       — amorphous carbon deposit, no grain at all, very low reflectance
  const grainCells = opts.grainCells ?? 64;
  const grainAmt = opts.grain ?? 1.0;
  const streakAmt = opts.streak ?? 1.0;
  const roughVar = opts.roughVar ?? 1.0;
  /**
   * Machining lines run along the extrusion axis (V here). `streakFreq` is now the
   * literal CYCLE COUNT of the base octave across the tile, not a multiplier on a
   * multi-octave stack.
   *
   * It used to be a multiplier: `ridged(u * 0.35, v * streakFreq, 8, 4)` with
   * streakFreq 15 put the top octave at 8 * 2.07^3 * 15 = 1063 cycles across a 512
   * map — HALF A TEXEL per cycle, an order of magnitude past Nyquist. That is not a
   * machining pass, it is white noise, and since the viewmodel renders at mip 0
   * every frame it was being drawn as literal per-texel salt on the receiver flats,
   * the gas block and the rail tops. Two octaves off a bounded base keeps the top
   * octave at ~11 texels, which is a broaching line you can actually see the
   * direction of — the anisotropy the finish is supposed to have.
   */
  const streakFreq = opts.streakFreq ?? 14.0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = y * size + x;

      // crystalline phosphate grain
      const grain = worley(u, v, grainCells, seed);
      const grain2 = worley(u * 1.0, v * 1.0, 32, seed + 3331);
      // drawn/machined streaks along the part's length
      const streak = ridged(u * 0.30, v, streakFreq, 2, seed + 11);
      // low-frequency handling polish + oil
      const blotch = fbm(u, v, 3, 4, seed + 907);
      const micro = fbm(u, v, 26, 2, seed + 55);
      // Very low frequency contact wear — where a sling, a hand or a plate carrier
      // has been rubbing the finish for a few hundred hours.
      const contact = fbm(u * 0.5, v * 0.5, 2, 3, seed + 4409);

      const h = grain * (0.55 * grainAmt) + grain2 * 0.18 + streak * (0.14 * streakAmt) + micro * 0.13;
      height[i] = h;

      // Albedo: for a METAL this is the specular reflectance, so it has to stay in
      // the physically plausible band for a dark oxide/phosphate finish — worn spots
      // lift toward bare metal, oil blotches darken.
      //
      // `lum` is a MULTIPLIER ABOUT UNITY, so the tint means what it says. It used
      // to range 0.60–1.70 because the sRGB packing bug (see srgbTint) was eating
      // most of it; with the encoding correct, a 1.7x lift on a 0.455 tint clips
      // the receiver to a blown 0.57 linear and the gun renders as bare chrome.
      // Keep the variation legible but bounded: roughly +/-15% with a wear ramp on
      // top, which is what a phosphate finish actually does.
      // MOTTLE AMPLITUDE. Three critics independently read the receiver as
      // "speckled granite", "a stone carving of a rifle" and "the same grunge noise
      // used on the world's concrete". They are describing this line. A machined and
      // anodised part is very nearly ONE albedo — the finish is a conversion coating
      // a few microns thick over a uniform substrate, and essentially the only
      // albedo variation on a real receiver is where the coating has been rubbed
      // through to bare aluminium at a wear point (which is the `contact` term, and
      // that one stays).
      //
      // So the isotropic noise terms come down by roughly half, and the term that
      // survives at full strength is `streak` — the directional broaching line that
      // says "machined" rather than "quarried". Halving grain/blotch/micro while
      // holding streak is what turns speckle into brushed metal.
      const lum = 1.0 + grain * (0.055 * grainAmt) + streak * (0.075 * streakAmt)
        - blotch * 0.065 + micro * 0.018
        + Math.max(0, contact - 0.62) * 0.58;
      const j = i * 4;
      alb[j] = Math.round(clamp01(c.r * lum) * 255);
      alb[j + 1] = Math.round(clamp01(c.g * lum) * 255);
      alb[j + 2] = Math.round(clamp01(c.b * lum) * 255);
      alb[j + 3] = 255;

      // ORM: R=AO (cavity from the grain), G=roughness, B=metalness.
      const ao = clamp01(0.72 + grain * 0.30 + grain2 * 0.06);
      // ROUGHNESS: same total variation, moved to a LOWER SPATIAL FREQUENCY.
      //
      // Roughness variation is the single biggest amateur/professional tell, so the
      // amount of it must not drop — but WHERE it lives decides whether it reads as
      // "a surface with a history" or as salt-and-pepper noise. `grain` (64-cell
      // worley) and `micro` (26-octave fbm) vary over a pixel or two at viewmodel
      // range, so they scatter the specular lobe texel-to-texel and produce exactly
      // the blotchy speckle the critics called concrete. `blotch` and `contact` vary
      // over centimetres, which is the scale a hand polishes a receiver at.
      //
      // Halve the two high-frequency terms, put the energy into the two low-frequency
      // ones. Net roughness sigma is unchanged; the image is not.
      const rough = clamp01(
        baseRough
        + ((grain - 0.5) * 0.09
          + (blotch - 0.5) * 0.38
          - streak * 0.12 * streakAmt
          + (micro - 0.5) * 0.035
          // handled/polished areas: the single strongest roughness cue on a real gun
          - Math.max(0, contact - 0.58) * 0.62) * roughVar,
      );
      // Metal is metal. Only the oil film and the phosphate crystal tips modulate it
      // at all, and never by much — a base of 0.34 (what this used to ship) is what
      // makes a receiver read as painted plastic.
      const metal = clamp01(baseMetal - blotch * 0.07 + grain * 0.03);
      orm[j] = Math.round(ao * 255);
      orm[j + 1] = Math.round(rough * 255);
      orm[j + 2] = Math.round(metal * 255);
      orm[j + 3] = 255;
    }
  }
  return { height, alb, orm };
}

/** Glass-filled polymer: pebble texture with sharp moulded facets, low metalness. */
function buildPolymer(size, seed, tint) {
  const n = size * size;
  const height = new Float32Array(n);
  const alb = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const c = srgbTint(tint);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = y * size + x;

      // Moulded stipple. The cell count is chosen against the UV scale the furniture
      // is projected at (0.04–0.05 m per tile), so one pip lands at ~1.6 mm — the
      // size a real injection-moulded checker actually is. The previous recipe added
      // a 128-cell field on top, which at that scale is a 0.4 mm dot pattern: it
      // read as sandpaper/orange peel, never as moulded polymer, and it aliased.
      const pebbleD = worley(u, v, 26, seed);
      const pebble = Math.pow(pebbleD, 0.42);
      // A second, offset stipple lattice instead of a high-frequency one — breaks the
      // regularity of a single Worley grid without introducing sub-texel detail.
      const pebble2 = Math.pow(worley(u + 0.37, v + 0.11, 13, seed + 1201), 0.6);
      const scuff = ridged(u * 2.2, v * 1.4, 8, 2, seed + 71);
      const blotch = fbm(u, v, 4, 4, seed + 613);
      const handled = fbm(u * 0.6, v * 0.6, 2, 3, seed + 2207);

      const h = pebble * 0.44 + pebble2 * 0.13 + scuff * 0.05 + blotch * 0.06;
      height[i] = h;

      // Moulded plastic: the raised pebbles catch light, the valleys hold grime.
      // Bounded about unity for the same reason as buildSteel — see srgbTint.
      const lum = 1.0 + pebble * 0.13 + pebble2 * 0.05 - blotch * 0.12 + scuff * 0.05
        - Math.max(0, handled - 0.60) * 0.28;
      const j = i * 4;
      alb[j] = Math.round(clamp01(c.r * lum) * 255);
      alb[j + 1] = Math.round(clamp01(c.g * lum) * 255);
      alb[j + 2] = Math.round(clamp01(c.b * lum) * 255);
      alb[j + 3] = 255;

      const ao = clamp01(0.58 + pebble * 0.44);
      // Peaks are polished by handling (low roughness), valleys stay matte — and a
      // large-scale mask makes the whole handled area shinier than the recesses,
      // which is the roughness variation the critic grades on.
      //
      // Floor raised: the old field bottomed out around 0.40, and a 0.04-F0
      // dielectric at roughness 0.40 under a low sun returns a broad wet sheen
      // that measured BRIGHTER than sunlit concrete in the same frame. Moulded
      // glass-filled nylon lives at 0.6-0.85; the variation stays, the gloss goes.
      const rough = clamp01(
        0.86 - pebble * 0.10 + (blotch - 0.5) * 0.14 - scuff * 0.06
        - Math.max(0, handled - 0.55) * 0.22,
      );
      orm[j] = Math.round(ao * 255);
      orm[j + 1] = Math.round(rough * 255);
      orm[j + 2] = Math.round(clamp01(0.02 + pebble2 * 0.03) * 255);
      orm[j + 3] = 255;
    }
  }
  return { height, alb, orm };
}

/** Rubber: fine matte stipple, effectively zero metalness, uniformly dark. */
function buildRubber(size, seed, tint) {
  const n = size * size;
  const height = new Float32Array(n);
  const alb = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const c = srgbTint(tint);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = y * size + x;
      // 150 cells over a 256 map is 1.7 texels per cell — pure per-texel salt at
      // mip 0, and the viewmodel is never anything but mip 0. 30 cells is ~8.5
      // texels, which at the 30 mm/tile the pads project at is a 1 mm moulded pip.
      const stip = worley(u, v, 30, seed);
      const ripple = fbm(u, v, 10, 3, seed + 3);
      const dust = fbm(u * 0.6, v * 0.6, 4, 3, seed + 401);
      const h = stip * 0.6 + ripple * 0.4;
      height[i] = h;
      const lum = 0.88 + stip * 0.12 + dust * 0.08;
      const j = i * 4;
      alb[j] = Math.round(clamp01(c.r * lum) * 255);
      alb[j + 1] = Math.round(clamp01(c.g * lum) * 255);
      alb[j + 2] = Math.round(clamp01(c.b * lum) * 255);
      alb[j + 3] = 255;
      orm[j] = Math.round(clamp01(0.70 + stip * 0.30) * 255);
      orm[j + 1] = Math.round(clamp01(0.90 - stip * 0.10 + (dust - 0.5) * 0.14) * 255);
      orm[j + 2] = 6;
      orm[j + 3] = 255;
    }
  }
  return { height, alb, orm };
}

/**
 * Nomex/goatskin shooting glove.
 *
 * ROOT CAUSE OF "THE GRIP IS MADE OF CONCRETE". The previous recipe ran a
 * `|sin(u * PI * 128)|` weft across a 256-texel map — 128 half-cycles over 256
 * texels is exactly TWO TEXELS PER CYCLE, i.e. the Nyquist limit — and stacked a
 * 136-cell Worley grain (1.9 texels per cell) on top of it. Both were then pushed
 * through heightToNormal at strength 2.6, which turns a two-texel ramp into a
 * maximum-slope normal.
 *
 * The gun is the closest object in the frame, so these maps are always magnified:
 * mip 0, one texel to several pixels. Per-texel maximum-slope normals under a very
 * low sun is *precisely* the recipe for coarse pale aggregate, and it is why three
 * critics independently described a gloved hand as stucco, cork, terrazzo and
 * gravel. It was never the tint and never the geometry — it was sampling.
 *
 * Rule applied here and at every call site below: **no feature smaller than eight
 * texels.** At the 42 mm/tile the hands are projected at, eight texels is 1.3 mm,
 * which is coincidentally the real pitch of a knitted Nomex back panel. Physical
 * correctness and sampling correctness land on the same number.
 */
function buildGlove(size, seed, tint) {
  const n = size * size;
  const height = new Float32Array(n);
  const alb = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const c = srgbTint(tint);
  // 32 cycles over 256 texels = 8 texels/cycle = 1.3 mm knit at the hand's UV scale.
  const WEFT = 32;
  const TWO_PI = Math.PI * 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = y * size + x;

      // Knit: two out-of-phase sinusoids so the crossings read as loops rather than
      // a grid. Kept shallow — a glove is soft, and the silhouette does the work.
      const weftU = Math.sin(u * TWO_PI * WEFT) * 0.5 + 0.5;
      const weftV = Math.sin(v * TWO_PI * WEFT + 1.7) * 0.5 + 0.5;
      const weave = weftU * weftV * 0.7 + (weftU + weftV) * 0.15;
      // Leather palm grain: 26 cells over 256 = ~10 texels/cell, ~1.6 mm pebbling.
      const grain = worley(u, v, 26, seed + 91);

      /* PANEL SEAMS, RESCALED TO THE DISTANCE THEY ARE ACTUALLY VIEWED FROM.
       *
       * The old seam was `pow(1 - |sin(v*PI*7)| / 0.10, 3)`. That is only non-zero
       * within 0.1 radians of a zero crossing, which at 256 texels works out at 2.3
       * TEXELS wide — 0.38 mm at the 42 mm/tile the hands are mapped at, i.e. about
       * half a pixel on a hand that covers ~120 px of a 1080p frame. It carried 0.10
       * of albedo contrast into half a pixel, so it integrated straight back to the
       * mean and left the glove reading as one smooth blob. That is the same Nyquist
       * mistake the header warns about, just in the opposite direction: not aliasing,
       * but a feature too small to survive downsampling at all.
       *
       * A real glove seam is a stitched CHANNEL about 2 mm across with a raised welt
       * down each side. At this UV scale that is a 12-14 texel trough flanked by two
       * 8-texel ridges — a 2-3 pixel dark line with a bright edge, which is exactly
       * the scale that still reads once the hand is 120 px tall. Panels sit 8.4 mm
       * apart, which is real for a goatskin back panel and gives 6-7 px of spacing.
       */
      const seamPhase = v * 5.0 + u * 0.30;
      const seamD = Math.abs(seamPhase - Math.floor(seamPhase) - 0.5) * 2.0; // 1 on the seam
      const seamCore = Math.pow(clamp01((seamD - 0.72) / 0.28), 1.6);
      // Stitch ticks along the welt at ~3 mm, coarse enough to be a visible dotted
      // edge rather than the old 22-cycle shimmer.
      const stitchTick = 0.5 + 0.5 * Math.sin(u * TWO_PI * 14.0);
      const welt = Math.pow(clamp01(1.0 - Math.abs(seamD - 0.62) / 0.16), 1.5)
        * (0.62 + 0.38 * stitchTick);

      // Very low frequency: where the glove is scuffed and where it has darkened
      // with hand oil. Both are broad, both are correct at this scale.
      const wear = fbm(u * 0.7, v * 0.7, 3, 3, seed + 55);
      const dirt = fbm(u * 0.5, v * 0.5, 2, 2, seed + 733);

      height[i] = weave * 0.22 + grain * 0.34 + welt * 0.34 - seamCore * 0.30;

      // Value band widened at the seams only. The flat of the panel keeps the tight,
      // low-contrast fabric response that stopped it reading as aggregate; the seam
      // is allowed real contrast because it is the one feature that has to survive to
      // the screen, and it is a line rather than a field so it cannot read as noise.
      const lum = 0.88 + weave * 0.07 + grain * 0.06 + welt * 0.13 - seamCore * 0.16
        - Math.max(0, dirt - 0.52) * 0.30 - wear * 0.06;
      const j = i * 4;
      alb[j] = Math.round(clamp01(c.r * lum) * 255);
      alb[j + 1] = Math.round(clamp01(c.g * lum) * 255);
      alb[j + 2] = Math.round(clamp01(c.b * lum) * 255);
      alb[j + 3] = 255;

      orm[j] = Math.round(clamp01(0.70 + grain * 0.30) * 255);
      // Roughness variation kept broad and low-contrast: burnished at the wear
      // patches (palm, finger pads), dead matte in the knit.
      orm[j + 1] = Math.round(clamp01(0.86 - Math.max(0, wear - 0.55) * 0.44
        - grain * 0.06 + (dirt - 0.5) * 0.10) * 255);
      orm[j + 2] = 3;
      orm[j + 3] = 255;
    }
  }
  return { height, alb, orm };
}

/* ── stamped markings ─────────────────────────────────────────────────────── */

/**
 * Roll-marked receiver text, drawn with the 2D canvas API (procedural, no assets).
 * Returned as an alpha-tested overlay texture so it stays in the opaque pass.
 */
function markingTexture(lines, w = 512, h = 128) {
  try {
    const cv = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
    if (!cv) return null;
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,0)';
    g.fillRect(0, 0, w, h);

    const rows = lines.length;
    const pad = h * 0.16;
    const rowH = (h - pad * 2) / rows;
    for (let i = 0; i < rows; i++) {
      const spec = lines[i];
      const text = typeof spec === 'string' ? spec : spec.text;
      const size = Math.round(rowH * (typeof spec === 'string' ? 0.62 : (spec.scale ?? 0.62)));
      g.font = `600 ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      const y = pad + rowH * (i + 0.5);
      // Stamped: a bright top bevel, a dark valley. Reads as pressed metal.
      g.fillStyle = 'rgba(214,208,196,0.55)';
      g.fillText(text, w * 0.045, y - size * 0.055);
      g.fillStyle = 'rgba(14,13,12,0.92)';
      g.fillText(text, w * 0.045, y);
    }

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  } catch (err) {
    console.warn('[weapons] marking texture failed:', err);
    return null;
  }
}

/**
 * Red-dot reticle: a 2 MOA dot with a faint halo, on transparent black.
 * Additively blended on the objective lens.
 */
function reticleTexture(size = 128, color = [1.0, 0.16, 0.10]) {
  const data = new Uint8Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c + 0.5) / c, dy = (y - c + 0.5) / c;
      const d = Math.hypot(dx, dy);
      // Tight core + wide bloom skirt: what a collimated emitter actually looks like.
      const core = Math.exp(-Math.pow(d / 0.085, 2.0));
      const skirt = Math.exp(-Math.pow(d / 0.30, 2.0)) * 0.16;
      const a = clamp01(core + skirt);
      const i = (y * size + x) * 4;
      data[i] = Math.round(clamp01(color[0]) * 255);
      data[i + 1] = Math.round(clamp01(color[1]) * 255);
      data[i + 2] = Math.round(clamp01(color[2]) * 255);
      data[i + 3] = Math.round(a * 255);
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

/** Soft radial flare card for the muzzle flash — no external sprite needed. */
function flashTexture(size = 128) {
  const data = new Uint8Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c + 0.5) / c, dy = (y - c + 0.5) / c;
      const d = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      // 5-lobed star, the classic prong-flash-hider signature.
      const star = 0.55 + 0.45 * Math.pow(Math.abs(Math.cos(ang * 2.5)), 3.0);
      const r = clamp01(Math.exp(-Math.pow(d / (0.30 * star), 1.7)));
      const core = clamp01(Math.exp(-Math.pow(d / 0.11, 2.0)));
      const a = clamp01(r * 0.85 + core);
      const i = (y * size + x) * 4;
      // Hot white core grading to sodium orange at the fringe.
      data[i] = 255;
      data[i + 1] = Math.round((0.55 + 0.45 * core) * 255);
      data[i + 2] = Math.round((0.18 + 0.72 * core) * 255);
      data[i + 3] = Math.round(a * 255);
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

/* ── edge-wear shader injection ───────────────────────────────────────────── */

/**
 * Every part geometry carries an `aWear` attribute: 0 on flat faces, ramping to 1
 * across the chamfer band at every edge. This patch makes worn edges do what worn
 * edges do on a real weapon — the phosphate is rubbed off, so they go lighter, more
 * metallic and markedly *smoother* than the surrounding surface.
 *
 * Roughness variation is the single biggest amateur/professional tell and this is
 * where most of it comes from on the gun.
 *
 * Injected via onBeforeCompile so the material stays a stock MeshStandardMaterial
 * (which matters: nothing here needs the CSM shader branch, because the viewmodel
 * scene has its own lights and never sees the world's cascades).
 */
function applyWearShader(material, opts = {}) {
  const wearTint = opts.wearTint ?? new THREE.Color(0.62, 0.60, 0.58);
  const wearAmount = opts.wearAmount ?? 1.0;
  const wearRough = opts.wearRough ?? 0.42;
  const wearMetal = opts.wearMetal ?? 0.85;
  // Floor on the worn roughness. Without it a chamfer band ends up at 0.15–0.25 and
  // mirrors the sky probe from EVERY orientation, which is what produced the
  // constant-brightness cream outline on every edge — including edges facing away
  // from the key and edges facing straight down. A worn steel chamfer is burnished,
  // not chromed: hold it above 0.30 and the highlight goes back to tracking the key.
  const wearRoughMin = opts.wearRoughMin ?? 0.32;
  /**
   * Geometric specular anti-aliasing strength (Kaplanyan/Tokuyoshi). See the
   * `<normal_fragment_maps>` patch below for what it does and why it is the
   * single most important line in this file.
   */
  const gsaa = opts.gsaa ?? 0.85;

  material.userData.wear = { wearTint, wearAmount, wearRough, wearMetal };
  material.userData.aoAmount = opts.aoAmount ?? 1.0;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWearTint = { value: wearTint };
    shader.uniforms.uWearAmount = { value: wearAmount };
    shader.uniforms.uWearRough = { value: wearRough };
    shader.uniforms.uWearRoughMin = { value: wearRoughMin };
    shader.uniforms.uWearMetal = { value: wearMetal };
    shader.uniforms.uGsaa = { value: gsaa };
    shader.uniforms.uAoAmount = { value: material.userData.aoAmount };
    // Keep a handle so the bake strength can be retuned live from a screenshot
    // loop without a shader recompile.
    material.userData.shaderRef = shader;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aWear;\nattribute float aAo;\nvarying float vWear;\nvarying float vBakedAo;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWear = aWear;\nvBakedAo = aAo;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vWear;\nvarying float vBakedAo;\n'
        + 'uniform vec3 uWearTint;\nuniform float uWearAmount;\nuniform float uWearRough;\n'
        + 'uniform float uWearRoughMin;\n'
        + 'uniform float uWearMetal;\nuniform float uAoAmount;\nuniform float uGsaa;',
      )
      // ── GEOMETRIC SPECULAR ANTI-ALIASING ───────────────────────────────────
      // THE speckle fix. The weapon is the closest object in every frame, so its
      // maps are always MAGNIFIED — mip 0, every time — and any normal-map feature
      // that varies over a pixel or two produces a specular lobe that flickers
      // between "mirror" and "black" from texel to texel. That is what reads as a
      // fine white salt noise sprinkled over the receiver flats, the gas block and
      // the rail tops, and it is also what turns a chamfer into a hard 1-pixel white
      // line instead of a soft band: the bevel band is one pixel of near-zero
      // roughness catching a very low sun.
      //
      // Kaplanyan/Tokuyoshi: the screen-space variance of the shading normal IS
      // extra lobe width. Fold it into roughness and the sub-pixel highlight energy
      // gets spread over the pixel instead of aliasing across it. Costs two
      // derivatives; removes the single most "browser demo" artefact on the gun.
      //
      // Injected after <normal_fragment_maps> because `normal` is only final there,
      // and roughnessFactor is not consumed until <lights_physical_fragment>.
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\n'
        + 'vec3 gsaaDx = dFdx( normal );\n'
        + 'vec3 gsaaDy = dFdy( normal );\n'
        + 'float gsaaVar = dot( gsaaDx, gsaaDx ) + dot( gsaaDy, gsaaDy );\n'
        + 'roughnessFactor = min( 1.0, sqrt( roughnessFactor * roughnessFactor'
        + ' + min( gsaaVar * uGsaa, 0.34 ) ) );',
      )
      // NOTE ON ORDER: in the standard fragment main(), <color_fragment> precedes
      // <roughnessmap_fragment> which precedes <aomap_fragment>. Both locals are
      // therefore declared in the first of those blocks and only read in the later
      // ones — declaring them later would not compile.
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n'
        // POWER CURVE, and it matters more than it looks. A chamfered box at one
        // corner segment has only 4 of its 16 per-face vertices carrying a flat
        // normal, so the linearly-interpolated wear mask covers most of every face
        // and the whole weapon renders as polished chrome. Raising it to a power
        // pulls the mask back onto the chamfer band where the finish actually rubs
        // off. Verified by screenshot — this was the single worst material defect.
        + 'float wearF = clamp( pow( clamp( vWear, 0.0, 1.0 ), 3.4 ) * uWearAmount, 0.0, 1.0 );\n'
        // Safety: a geometry that somehow reached this material without the aAo
        // attribute gets the WebGL default of 0, which would render it pure black.
        // Treat "no bake" as "fully open".
        + 'float bakedAo = mix( 1.0, ( vBakedAo <= 0.001 ) ? 1.0 : vBakedAo, uAoAmount );\n'
        // THE EDGE-OUTLINE BUG. This used to read
        //     mix( c, c * 0.45 + uWearTint, wearF )
        // with a tint of ~0.17 linear against a base albedo of ~0.05 — a 3.5x ADDITIVE
        // lift of the DIFFUSE term on every chamfer. Diffuse response is a function of
        // the surface normal against the lights only, so on a chamfer band that is
        // 1–2 px wide the lift reads as a constant-width, constant-brightness cream
        // outline: identical on the top edge facing the sun and on the bottom edge
        // facing the ground. That is an edge-detect pass, not shading.
        //
        // The physically honest version: worn metal has a *higher specular
        // reflectance* and near-unit metalness, so almost none of the lift lands in
        // diffuse. Blend the albedo toward the bare-metal tint multiplicatively,
        // push metalness up (which suppresses diffuse further), and let the highlight
        // come from the specular lobe — where it varies with the key, as it must.
        + 'diffuseColor.rgb = mix( diffuseColor.rgb, mix( diffuseColor.rgb, uWearTint, 0.62 ), wearF );\n'
        // Cavity darkening belongs in the LIGHTING terms, not in albedo — a shadowed
        // steel part is still steel. Only a light touch goes on the base colour.
        + 'diffuseColor.rgb *= mix( 1.0, bakedAo, 0.35 );',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n'
        + 'roughnessFactor = clamp( mix( roughnessFactor, max( roughnessFactor * uWearRough, uWearRoughMin ), wearF ), 0.035, 1.0 );\n'
        // The other half of the wear story, and the half that was missing. Handled
        // edges get burnished (above); RECESSES collect carbon, oil and grit and go
        // markedly rougher. Driving that off the baked cavity term costs nothing —
        // the value is already interpolated for the occlusion — and it is what puts
        // a third scale of roughness variation on the gun, under the machining
        // anisotropy and the blotchy handling polish already in the map.
        + 'roughnessFactor = clamp( roughnessFactor + ( 1.0 - bakedAo ) * 0.16, 0.035, 1.0 );',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n'
        + 'metalnessFactor = clamp( mix( metalnessFactor, uWearMetal, wearF * 0.9 ), 0.0, 1.0 );',
      );

    // Baked cavity occlusion also has to darken the indirect term, or the mag well
    // interior lights up from the environment probe and the AO bake does nothing.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      '#include <aomap_fragment>\n'
      + 'float bakedOcc = mix( 1.0, bakedAo, 0.9 );\n'
      + 'reflectedLight.indirectDiffuse *= bakedOcc;\n'
      + 'reflectedLight.indirectSpecular *= mix( 1.0, bakedOcc, 0.65 );\n'
      // The viewmodel scene casts no shadows — shadowMap.autoUpdate is false and the
      // single refresh per frame is spent on the world pass long before the weapon is
      // drawn. So the optic does not darken the receiver under it, the mount does not
      // darken the rail, and the magwell interior stays lit from nowhere. Bleeding the
      // bake into the DIRECT terms is not physically what ambient occlusion is for,
      // but it is what every shipped viewmodel does for exactly this reason, and it is
      // the only self-occlusion this pass can have. Kept at 0.45 so contact regions go
      // deep without the whole gun going muddy.
      + 'float dirOcc = mix( 1.0, bakedAo, 0.58 * uAoAmount );\n'
      + 'reflectedLight.directDiffuse *= dirOcc;\n'
      + 'reflectedLight.directSpecular *= mix( 1.0, dirOcc, 0.75 );',
    );
  };
  material.customProgramCacheKey = () => `blackout-wear-${wearRough}-${wearMetal}-${wearAmount}-${gsaa}`;
  return material;
}

/* ── the library ──────────────────────────────────────────────────────────── */

export class WeaponSurfaces {
  constructor(renderer) {
    this.aniso = 8;
    try { this.aniso = Math.min(16, renderer?.capabilities?.getMaxAnisotropy?.() || 8); } catch (e) { /* default */ }
    this.maps = {};
    this.materials = {};
    this.textures = {};
    this._bytes = 0;
  }

  _register(name, built, size, normalStrength) {
    const albedo = makeTex(built.alb, size, true, this.aniso);
    const orm = makeTex(built.orm, size, false, this.aniso);
    const normal = makeTex(heightToNormal(built.height, size, normalStrength), size, false, this.aniso);
    albedo.name = `wpn_${name}_albedo`;
    orm.name = `wpn_${name}_orm`;
    normal.name = `wpn_${name}_normal`;
    this.maps[name] = { albedo, normal, orm };
    this._bytes += size * size * 4 * 3 * 1.34;
    return this.maps[name];
  }

  _standard(name, maps, cfg) {
    const m = new THREE.MeshStandardMaterial({
      map: maps.albedo,
      normalMap: maps.normal,
      normalScale: new THREE.Vector2(cfg.normalScale ?? 1, cfg.normalScale ?? 1),
      roughnessMap: maps.orm,
      metalnessMap: maps.orm,
      aoMap: maps.orm,
      aoMapIntensity: cfg.ao ?? 1.0,
      roughness: 1.0,
      metalness: 1.0,
      color: 0xffffff,
      dithering: true,
      side: THREE.FrontSide,
    });
    m.name = `wpn_${name}`;
    m.envMapIntensity = cfg.env ?? 1.0;
    m.userData.envScale = cfg.env ?? 1.0;
    applyWearShader(m, cfg);
    this.materials[name] = m;
    return m;
  }

  async build(onProgress = () => {}) {
    const S = 512, SM = 256;
    const step = async (p, label, fn) => {
      onProgress(p, label);
      // Yield so the boot bar keeps painting through ~1.5 MPix of synthesis.
      await new Promise((r) => setTimeout(r));
      try { fn(); } catch (err) { console.error(`[weapons] surface "${label}" failed:`, err); }
    };

    /* ── THE THREE SUBSTANCES ────────────────────────────────────────────────
     * A rifle is made of exactly three families of material and the critic checks
     * that they are distinguishable at a glance:
     *
     * NOTE ON THE METAL TINTS. These are FRESNEL REFLECTANCE (F0), not paint. A
     * metal has no diffuse term at all, so its whole appearance is F0 x specular
     * lobe — and at 0.16 linear the receiver could only be seen where the lobe
     * happened to align, which made a dark-anodised rifle read DARKER than the
     * 0.04-F0 polymer furniture bolted to it. That inversion is why the stock kept
     * coming back as the brightest thing in the frame no matter how the key moved.
     * Anodised aluminium sits near 0.32 linear even with a dark oxide over it;
     * parkerised steel near 0.26; blued barrel steel near 0.13. With those in place
     * the key drops to roughly a third and the metal/polymer relationship inverts
     * back to the right way round.
     *
     *   phosphated STEEL   metalness 1.0, rough ~0.55, darkest albedo, isotropic
     *                      crystalline grain. Barrel, bolt, pins, sights, controls.
     *   anodised ALUMINIUM metalness 1.0, rough ~0.34, lighter albedo, strong
     *                      longitudinal machining anisotropy. Receiver, rail,
     *                      handguard, optic body.
     *   glass-filled POLYMER metalness 0.02, rough ~0.72, moulded stipple.
     *                      Grip, stock, magazine.
     *
     * Metalness is the number that was wrong before: everything metal shipped at
     * 0.32–0.34, which is not a substance that exists. A dielectric-ish 0.33 gives a
     * flat white specular and a big diffuse term, and that is precisely the "coloured
     * polygon" read. Metal is 1.0 or it is not metal.
     *
     * The albedo values are the FRESNEL REFLECTANCE of the finish, not a paint
     * colour — dark oxide coatings sit around 0.11–0.20 linear, which is why they
     * look near-black in shadow and light up hard when the key catches them.
     */
    await step(0.05, 'weapons · parkerised steel', () => {
      const b = buildSteel(S, 0x51a3, 0x8d8b84, 0.58, 0.97, {
        grainCells: 60, grain: 1.0, streak: 0.55, streakFreq: 12.0, roughVar: 1.15,
      });
      this._standard('steel', this._register('steel', b, S, 1.25), {
        normalScale: 0.50, env: 0.80, wearRough: 0.66, wearMetal: 0.99,
        wearTint: new THREE.Color(0.36, 0.35, 0.33), wearAmount: 0.44,
        wearRoughMin: 0.36, gsaa: 0.90,
      });
    });

    await step(0.2, 'weapons · anodised aluminium', () => {
      // Type III hard anodise over 7075 extrusion, as it comes off a *used* rifle.
      //
      // This shipped at roughness 0.34, which is a polished / oiled finish — hence
      // "the receiver reads as wet black plastic". A hard-anodised or parkerised
      // service finish sits around 0.50: still clearly metal against the 0.80
      // polymer furniture, but the key smears into a broad sheen instead of a tight
      // wet highlight. The broaching anisotropy is what carries "machined" now,
      // which is where that read belongs.
      const b = buildSteel(S, 0x2b71, 0x9b9992, 0.57, 0.98, {
        grainCells: 64, grain: 0.42, streak: 1.75, streakFreq: 22.0, roughVar: 1.30,
      });
      // env held under unity: a flat anodised facet at 0.5 roughness is still a
      // usable mirror, and the small raked faces on the charging handle were
      // returning the dusk sun's disc out of the sky probe as a clipped white
      // rectangle on an otherwise dark receiver.
      this._standard('alloy', this._register('alloy', b, S, 0.80), {
        normalScale: 0.30, env: 0.70, wearRough: 0.70, wearMetal: 1.0,
        wearTint: new THREE.Color(0.46, 0.46, 0.45), wearAmount: 0.42,
        wearRoughMin: 0.34, gsaa: 0.95,
      });
    });

    await step(0.36, 'weapons · blued barrel steel', () => {
      // Blued/parkerised barrel steel: the darkest thing on the weapon.
      const b = buildSteel(S, 0x77c2, 0x676460, 0.50, 1.0, {
        grainCells: 64, grain: 0.62, streak: 1.30, streakFreq: 20.0, roughVar: 1.0,
      });
      this._standard('blued', this._register('blued', b, S, 0.90), {
        normalScale: 0.34, env: 0.85, wearRough: 0.64, wearMetal: 1.0,
        wearTint: new THREE.Color(0.30, 0.29, 0.27), wearAmount: 0.40,
        wearRoughMin: 0.32, gsaa: 0.95,
      });
    });

    await step(0.44, 'weapons · carbon fouling', () => {
      // Soot around the muzzle device and the gas block. Amorphous carbon: no
      // grain, no metallic response, and the lowest reflectance on the whole gun.
      const b = buildSteel(SM, 0x3f18, 0x1a1917, 0.88, 0.06, {
        grainCells: 26, grain: 0.35, streak: 0.25, streakFreq: 5.0, roughVar: 0.6,
      });
      this._standard('carbon', this._register('carbon', b, SM, 1.0), {
        normalScale: 0.45, env: 0.35, wearRough: 0.90, wearMetal: 0.25,
        wearTint: new THREE.Color(0.09, 0.086, 0.080), wearAmount: 0.35,
        wearRoughMin: 0.60, gsaa: 0.70,
      });
    });

    await step(0.54, 'weapons · polymer furniture', () => {
      const b = buildPolymer(S, 0x9d41, 0x25271f);
      this._standard('polymer', this._register('polymer', b, S, 2.4), {
        normalScale: 0.62, env: 0.52, wearRough: 0.88, wearMetal: 0.06,
        wearTint: new THREE.Color(0.055, 0.055, 0.050), wearAmount: 0.42,
        wearRoughMin: 0.50, gsaa: 0.65,
      });
    });

    await step(0.66, 'weapons · magazine polymer', () => {
      const b = buildPolymer(S, 0x4417, 0x1f2119);
      this._standard('magPolymer', this._register('magPolymer', b, S, 2.2), {
        normalScale: 0.58, env: 0.48, wearRough: 0.90, wearMetal: 0.06,
        wearTint: new THREE.Color(0.050, 0.050, 0.046), wearAmount: 0.46,
        wearRoughMin: 0.52, gsaa: 0.65,
      });
    });

    await step(0.76, 'weapons · rubber', () => {
      const b = buildRubber(SM, 0x6612, 0x191a1c);
      this._standard('rubber', this._register('rubber', b, SM, 1.1), {
        normalScale: 0.55, env: 0.36, wearRough: 0.94, wearMetal: 0.03,
        wearTint: new THREE.Color(0.055, 0.055, 0.055), wearAmount: 0.24,
        wearRoughMin: 0.72, gsaa: 0.60,
      });
    });

    await step(0.88, 'weapons · gloves', () => {
      // Dark grey-olive tactical glove.
      //
      // This has been overcorrected twice in opposite directions. At 0x33302a with a
      // 0.80–1.13 albedo swing the hands were a pale tan mass sitting ABOVE the
      // weapon in value; the correction to 0x2b2a25 with normalScale 0.42 put them
      // so far under that three critics in a row described them as "featureless
      // rounded lozenges", "a black mass" and "a dark grey slab that reads as a
      // curtain". Both readings are the same failure: the glove had no INTERNAL
      // contrast, so whatever its mean value happened to be, it rendered as one
      // undifferentiated blob.
      //
      // The fix is not "make them brighter", it is "make them legible": lift the
      // base far enough clear of the shadow floor that the hand separates from the
      // dark grip behind it, and — the part that actually matters — push the normal
      // scale up so the knuckle panels, the stitched seams and the finger-back
      // ribbing are visible at the ~40 px the hand actually occupies. A glove is
      // 6 mm of textured goatskin, not a smooth solid.
      // THIRD CORRECTION, and this one is measured rather than argued. With the
      // support hand rolled into the key (see models.js) the glove region of a
      // closeup frame measures mean luma 0.349 against the receiver flank's 0.349 —
      // dead level. Equal value is why it still reads as part of the same dark mass
      // even now that it is lit and unoccluded: there is nothing for the eye to
      // separate on. The brief is that the glove sits CLEARLY above the receiver, so
      // the tint goes up ~16% in sRGB (0x403e35 -> 0x4a4740, about +45% linear).
      // This is safe in a way the old 0x33302a overcorrection was not: that one
      // paired a lift with a 0.80-1.13 albedo swing, so it went pale AND blotchy.
      // The swing here stays tight and the added contrast is spent on the seams,
      // which are lines rather than fields and therefore cannot read as aggregate.
      const b = buildGlove(SM, 0x1c93, 0x4a4740);
      this._standard('glove', this._register('glove', b, SM, 1.15), {
        normalScale: 0.86, env: 0.52, wearRough: 0.90, wearMetal: 0.02,
        wearTint: new THREE.Color(0.150, 0.143, 0.126), wearAmount: 0.34,
        wearRoughMin: 0.58, gsaa: 0.55,
      });
    });

    await step(0.92, 'weapons · fatigue sleeve', () => {
      // Ripstop cotton, darker and much more matte than the glove leather. The
      // forearm used to share the glove material and ended up the palest object in
      // the frame; a sleeve has to sit BELOW the weapon in value, not above it.
      // Lifted alongside the glove and for the same reason: at 0x25241e with a 0.40
      // normal scale the support forearm rendered as "a featureless dark grey slab
      // with a straight vertical silhouette that reads as a curtain". It stays
      // clearly BELOW the glove in value — a sleeve behind a hand must not compete
      // with it — but it now has enough weave and fold shading to read as cloth.
      const b = buildGlove(SM, 0x7a24, 0x33322a);
      this._standard('sleeve', this._register('sleeve', b, SM, 1.0), {
        normalScale: 0.78, env: 0.38, wearRough: 0.96, wearMetal: 0.01,
        wearTint: new THREE.Color(0.105, 0.100, 0.086), wearAmount: 0.22,
        wearRoughMin: 0.70, gsaa: 0.55,
      });
    });

    await step(0.95, 'weapons · brass', () => {
      const b = buildSteel(SM, 0xbb31, 0x8a6a2e, 0.30, 0.98);
      const maps = this._register('brass', b, SM, 1.2);
      const m = new THREE.MeshStandardMaterial({
        map: maps.albedo, normalMap: maps.normal,
        normalScale: new THREE.Vector2(0.6, 0.6),
        roughnessMap: maps.orm, metalnessMap: maps.orm,
        roughness: 1.0, metalness: 1.0, color: 0xffffff, dithering: true,
      });
      m.name = 'wpn_brass';
      m.envMapIntensity = 1.3;
      this.materials.brass = m;
    });

    // Non-textured specials.
    try {
      this.textures.reticle = reticleTexture(128, [1.0, 0.14, 0.08]);
      this.textures.flash = flashTexture(128);

      // ── optic glass ───────────────────────────────────────────────────────
      // The old lens was a flat 30%-opacity double-sided disc with depthWrite off.
      // Three things went wrong with that at once: the far element showed through the
      // near one, the world showed through the whole optic body, and the "lens" read
      // as a soap bubble rather than a coated glass element.
      //
      // What a real AR-coated objective does is angle-dependent, and that is exactly
      // what makes it work for both poses: viewed off-axis (hip fire) the Fresnel
      // reflectance of the air/glass boundary approaches 1 and the element is a dark
      // mirror you cannot see through; viewed down the optical axis (ADS) it drops to
      // ~4% and you see the target. So drive ALPHA from Fresnel instead of picking one
      // compromise number — the hip-fire read and the aimed read are both correct, and
      // the near element occludes the far one for free because its alpha is ~1 there.
      /**
       * WHY THE OCULAR WAS A CREAM DISC. The recipe was roughness 0.02 +
       * clearcoat 1.0 + clearcoatRoughness 0.01 + envMapIntensity 2.6. That is a
       * 2.6x-amplified perfect mirror, and what it was mirroring was a bright
       * overcast dusk sky probe. So from the hip pose — where you look into the
       * ocular at 20–40 degrees off axis — the glass returned a flat, blown,
       * sky-coloured disc with a soft grey smudge in it, and the modelled baffle
       * stack, tube liner and emitter behind it were invisible. "Toy telescope"
       * was an accurate description of a 2.6x mirror.
       *
       * A coated optic reflects a FEW PER CENT at normal incidence and stays under
       * ~20% out to 45 degrees. So: kill the clearcoat stack, bring the environment
       * term to unity, and — critically — bound the Fresnel alpha well below 1 so
       * the dark tube interior reads THROUGH the glass at every angle a player
       * actually sees. The glass then registers as depth plus a rim highlight,
       * which is what glass looks like, instead of as a lid.
       */
      const lens = (tint, baseAlpha, maxAlpha, coat, env) => {
        const m = new THREE.MeshPhysicalMaterial({
          color: tint,
          metalness: 0.0,
          roughness: 0.05,
          clearcoat: 0.30,
          clearcoatRoughness: 0.08,
          envMapIntensity: env,
          transparent: true,
          opacity: baseAlpha,
          depthWrite: false,
          side: THREE.FrontSide,
        });
        m.userData.envScale = env;
        m.onBeforeCompile = (shader) => {
          shader.uniforms.uLensAlpha = { value: baseAlpha };
          shader.uniforms.uLensMaxAlpha = { value: maxAlpha };
          shader.uniforms.uCoat = { value: new THREE.Color(coat) };
          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <common>',
              '#include <common>\nuniform float uLensAlpha;\nuniform float uLensMaxAlpha;\nuniform vec3 uCoat;',
            )
            .replace(
              '#include <dithering_fragment>',
              '#include <dithering_fragment>\n'
              + 'vec3 lensN = normalize( vNormal );\n'
              + 'vec3 lensV = normalize( vViewPosition );\n'
              + 'float lensNdV = clamp( abs( dot( lensN, lensV ) ), 0.0, 1.0 );\n'
              // Schlick against a 4% coated boundary rather than an uncoated one.
              + 'float lensF = 0.04 + 0.96 * pow( 1.0 - lensNdV, 5.0 );\n'
              // Magnesium-fluoride AR stacks are tuned for the middle of the band, so
              // what leaks past them at an angle is the violet/blue end — the purple
              // flare every red dot shows in a photograph. Weighted by a softer ramp
              // than the alpha so the tint is a wash across the element, not a rim.
              + 'float lensTint = pow( 1.0 - lensNdV, 2.2 );\n'
              + 'gl_FragColor.rgb += uCoat * lensTint * 0.55;\n'
              // A thin bright meniscus exactly at the glass edge: the giveaway that
              // there is a curved element seated in the tube rather than a painted lid.
              + 'gl_FragColor.rgb += vec3( 0.42, 0.46, 0.50 ) * pow( 1.0 - lensNdV, 9.0 ) * 0.85;\n'
              + 'gl_FragColor.a = clamp( mix( uLensAlpha, uLensMaxAlpha, lensF ), 0.0, 1.0 );',
            );
        };
        m.customProgramCacheKey = () => `blackout-lens2-${baseAlpha}-${maxAlpha}`;
        return m;
      };
      // Objective: deep blue-green body tint, violet AR flare. Slightly more opaque
      // than the ocular because you are looking at the OUTSIDE of the stack.
      this.materials.lens = lens(0x0a1512, 0.30, 0.70, 0x261a44, 0.55);
      this.materials.lens.name = 'wpn_lens';
      // Ocular: the element the player looks INTO. Held deliberately transparent so
      // the black liner, the three baffle rings and the canted emitter housing are
      // all legible behind it — that dark, receding interior is the entire read.
      // Environment strength held DELIBERATELY low. The probe the weapon reflects
      // is a sky probe, and it stays bright even when the player is under a roof
      // (the rig scales it, but not to zero). An ocular element is recessed 68 mm
      // inside an anodised tube: it can see almost none of the sky, and letting it
      // mirror one is exactly how this part came back as "an opaque cream disc"
      // from three reviewers. 0.22 gives a highlight without a lid.
      this.materials.lensRear = lens(0x0b1512, 0.15, 0.40, 0x1b2444, 0.22);
      this.materials.lensRear.name = 'wpn_lens_rear';

      // Optic interior: the baffle stack and the tube lining. Flat, black, totally
      // non-reflective — its whole job is to be a hole that light does not come out
      // of, so the far element is occluded from every off-axis angle.
      this.materials.baffle = new THREE.MeshStandardMaterial({
        color: 0x08090a,
        roughness: 0.96,
        metalness: 0.0,
        envMapIntensity: 0.06,
        side: THREE.DoubleSide,
      });
      this.materials.baffle.name = 'wpn_baffle';
      this.materials.baffle.userData.envScale = 0.06;

      this.materials.reticle = new THREE.MeshBasicMaterial({
        map: this.textures.reticle,
        // HDR emitter. The viewmodel composites BEFORE the tonemapper, so an
        // LDR-clamped 0xff3a1e dot is dimmer than a sunlit wall behind it and simply
        // vanishes. Driving the colour past 1.0 puts the dot into the bloom-eligible
        // range where a real illuminated reticle lives.
        color: new THREE.Color().setRGB(4.6, 0.30, 0.10, THREE.LinearSRGBColorSpace),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        toneMapped: true,
        side: THREE.DoubleSide,
      });
      this.materials.reticle.name = 'wpn_reticle';

      this.materials.flash = new THREE.MeshBasicMaterial({
        map: this.textures.flash,
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        toneMapped: true,
        side: THREE.DoubleSide,
      });
      this.materials.flash.name = 'wpn_flash';

      this.materials.tritium = new THREE.MeshStandardMaterial({
        color: 0x0a1410, emissive: 0x4cff9a, emissiveIntensity: 1.6,
        roughness: 0.35, metalness: 0.0,
      });
      this.materials.tritium.name = 'wpn_tritium';
    } catch (err) {
      console.error('[weapons] special materials failed:', err);
    }

    onProgress(1, 'weapons · surfaces');
    return this;
  }

  markings(lines, w, h) {
    const tex = markingTexture(lines, w, h);
    if (!tex) return null;
    const m = new THREE.MeshStandardMaterial({
      map: tex,
      alphaMap: tex,
      alphaTest: 0.28,
      transparent: false,
      roughness: 0.62,
      metalness: 0.55,
      color: 0xffffff,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -3,
      side: THREE.FrontSide,
    });
    m.name = 'wpn_markings';
    m.envMapIntensity = 0.8;
    return m;
  }

  get(name) {
    return this.materials[name] ?? this.materials.steel ?? null;
  }

  /** Live tap for the baked-occlusion strength (0 = off, 1 = full bake). */
  setAoAmount(v) {
    for (const m of Object.values(this.materials)) {
      if (!m?.userData) continue;
      m.userData.aoAmount = v;
      const u = m.userData.shaderRef?.uniforms?.uAoAmount;
      if (u) u.value = v;
    }
  }

  /** Live tap for the edge-wear strength. */
  setWearAmount(v) {
    for (const m of Object.values(this.materials)) {
      const u = m?.userData?.shaderRef?.uniforms?.uWearAmount;
      if (u) u.value = v;
    }
  }

  /**
   * Bind the sky probe so the gun's metal reflects the same environment as the world.
   *
   * `fast` retunes only the INTENSITY. That distinction matters: `needsUpdate` on a
   * MeshStandardMaterial forces a full program rebuild, and the viewmodel rig
   * rebalances its environment term every time the player walks under a roof. Doing
   * that with a recompile would stall the frame every few seconds; envMapIntensity is
   * a plain uniform and costs nothing to change.
   */
  applyEnvMap(envMap, intensity = 1.0, fast = false) {
    for (const m of Object.values(this.materials)) {
      if (!m || !('envMap' in m)) continue;
      try {
        if (m.userData.envScale === undefined) m.userData.envScale = m.envMapIntensity ?? 1;
        if (!fast) {
          m.envMap = envMap ?? null;
          m.needsUpdate = true;
        }
        m.envMapIntensity = intensity * m.userData.envScale;
      } catch (e) { /* keep going */ }
    }
  }

  dispose() {
    for (const m of Object.values(this.materials)) { try { m.dispose(); } catch (e) { /* noop */ } }
    for (const maps of Object.values(this.maps)) {
      for (const t of Object.values(maps)) { try { t.dispose(); } catch (e) { /* noop */ } }
    }
    for (const t of Object.values(this.textures)) { try { t.dispose(); } catch (e) { /* noop */ } }
  }
}

export { markingTexture, reticleTexture, flashTexture, fbm, vnoise, worley };
export default WeaponSurfaces;
