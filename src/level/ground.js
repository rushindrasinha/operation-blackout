/**
 * OPERATION BLACKOUT — ground macro system.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────
 *
 * The yard fills 40-55 % of every frame in the game and, before this pass, it was
 * one `concrete` material at one texel density laid unbroken across ~90 m. The
 * material recipe authors ~3 cm aggregate; the vertex-colour paint added variation
 * at ~10 m but only in ALBEDO, on a 1 m vertex grid. So between 4 cm and 90 m the
 * plane had literally no spatial-frequency content and no roughness variation at
 * all — which is the difference between "cast concrete" and "stucco ceiling".
 *
 * Two things fix that, and both live here:
 *
 *  1. A FRAGMENT-STAGE MACRO LAYER. A 3-octave value-noise field evaluated from
 *     world XZ at 6 m / 17 m / 47 m wavelengths, driving albedo (x0.74..1.22),
 *     roughness (±0.20) and a height-blended second ground layer (compacted dirt /
 *     loose gravel) sampled from the gravel albedo map at its own tile. Procedural,
 *     so it costs no memory and never repeats; and because it modulates ROUGHNESS
 *     it survives being looked at from 1 m and from 60 m.
 *
 *  2. A BAKED AUTHORING MASK — one 1024² RGBA texture covering the whole compound,
 *     sampled by world XZ:
 *        R = dust / dirt deposition   (lightens, roughens, pushes the dirt layer)
 *        G = wear                     (darkens, polishes — worn lanes, tyre ruts)
 *        B = wet / puddle basin       (darkens hard, drops roughness to a mirror)
 *        A = openness                 (1 = open ground, <1 = contact occlusion)
 *
 *     The alpha channel is the level's CONTACT SHADOW SOLUTION. Every solid in the
 *     map already registers a collision proxy with a world transform and a footprint;
 *     `markFromProxy()` reads those and splats an oriented rounded-rect gradient
 *     under each one, plus a wider dust apron in R. So every barrier, sandbag wall,
 *     container, post and building base gets a short-range darkening wedge at the
 *     ground junction *for free*, in the G-buffer, with no extra draw call, no
 *     transparency, no z-fighting and no decal aliasing.
 *
 * OWNER: level.
 */
import * as THREE from 'three';

/* ─────────────────────────────── the mask ─────────────────────────────── */

export class GroundMask {
  constructor(opts = {}) {
    this.size = opts.size ?? 1024;
    this.x0 = opts.x0 ?? -62;
    this.x1 = opts.x1 ?? 62;
    this.z0 = opts.z0 ?? -68;
    this.z1 = opts.z1 ?? 68;
    this.sx = this.size / (this.x1 - this.x0);
    this.sz = this.size / (this.z1 - this.z0);
    this.data = new Uint8Array(this.size * this.size * 4);
    // R dust = 0, G wear = 0, B wet = 0, A openness = 255
    for (let i = 3; i < this.data.length; i += 4) this.data[i] = 255;
    this.texture = null;
    this.splats = 0;
  }

  _u(x) { return (x - this.x0) * this.sx; }
  _v(z) { return (z - this.z0) * this.sz; }

  /** clamped rect of texel indices for a world-space AABB */
  _rect(x, z, rx, rz) {
    const S = this.size;
    return {
      i0: Math.max(0, Math.floor(this._u(x - rx))),
      i1: Math.min(S - 1, Math.ceil(this._u(x + rx))),
      j0: Math.max(0, Math.floor(this._v(z - rz))),
      j1: Math.min(S - 1, Math.ceil(this._v(z + rz))),
    };
  }

  _wx(i) { return this.x0 + (i + 0.5) / this.sx; }
  _wz(j) { return this.z0 + (j + 0.5) / this.sz; }

  /** additive-saturating write into channel c (0..3), value 0..1 */
  _add(i, j, c, v) {
    const o = (j * this.size + i) * 4 + c;
    const n = this.data[o] + v * 255;
    this.data[o] = n > 255 ? 255 : n;
  }

  /** multiplicative darkening of the openness channel */
  _occl(i, j, k) {
    const o = (j * this.size + i) * 4 + 3;
    const n = this.data[o] * k;
    this.data[o] = n < 0 ? 0 : n;
  }

  /**
   * Contact occlusion + dust apron under one footprint.
   *
   * @param {number} x,z  centre
   * @param {number} hw,hd  half extents (world, before rotation)
   * @param {number} ry   yaw
   * @param {number} strength  0..1 peak darkening
   * @param {number} feather   metres the gradient extends past the footprint
   */
  contact(x, z, hw, hd, ry = 0, strength = 0.42, feather = 0.55) {
    const c = Math.cos(-ry), s = Math.sin(-ry);
    const reach = Math.hypot(hw, hd) + feather + 0.35;
    const r = this._rect(x, z, reach, reach);
    const dustR = feather + 0.55;
    for (let j = r.j0; j <= r.j1; j++) {
      const wz = this._wz(j) - z;
      for (let i = r.i0; i <= r.i1; i++) {
        const wx = this._wx(i) - x;
        // into the footprint's local frame
        const lx = wx * c - wz * s;
        const lz = wx * s + wz * c;
        // signed distance to the rounded rectangle
        const dx = Math.abs(lx) - hw;
        const dz = Math.abs(lz) - hd;
        const outside = Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
        const d = outside > 0 ? outside : Math.max(dx, dz);
        if (d > dustR) continue;
        if (d <= 0) {
          this._occl(i, j, 1 - strength);
        } else {
          const t = 1 - d / feather;
          if (t > 0) this._occl(i, j, 1 - strength * t * t * (3 - 2 * t));
        }
        // dust wedge: peaks just OUTSIDE the footprint and dies off
        const dt = 1 - Math.abs(d - 0.06) / dustR;
        if (dt > 0) this._add(i, j, 0, dt * dt * 0.55);
      }
    }
    this.splats++;
  }

  /**
   * A baked directional shadow smear for a small prop.
   *
   * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
   * The sun sits at 10.6 degrees of elevation. Cascaded shadow maps carry a
   * normal-offset bias proportional to their texel size, and that offset moves
   * the receiver's lookup `bias / tan(elevation)` metres back along the light
   * ray — 0.63 m in cascade 2 and 0.86 m in cascade 3 on this map. Anything
   * whose footprint is narrower than that, which is every drum, crate, sandbag
   * course and railing in the level, therefore has its cast shadow completely
   * erased past ~22 m, and the critics correctly reported a sun stripe running
   * through four barrels unbroken.
   *
   * The level cannot retune the cascades (they belong to the lighting system),
   * but it CAN put the missing occlusion where it belongs: the openness channel
   * of the ground mask is already a per-texel multiplier on the ground albedo,
   * sampled in the G-buffer, free of draw calls, transparency and decal
   * aliasing. So every small solid stamps the wedge its own shadow would carve
   * — an elongated, noise-broken lobe running down the sun bearing, `h/tan(e)`
   * metres long, fading quadratically along its length the way a real penumbra
   * does at this elevation.
   *
   * @param {number} x,z      footprint centre
   * @param {number} hw,hd    half extents before rotation
   * @param {number} ry       yaw
   * @param {number} height   object height above ground
   * @param {number} dx,dz    NORMALISED horizontal direction of light travel
   * @param {number} slope    metres of shadow length per metre of height
   * @param {number} strength peak darkening at the contact end
   */
  shadowSmear(x, z, hw, hd, ry, height, dx, dz, slope, strength = 0.5) {
    const len = Math.min(9.0, Math.max(0.35, height * slope));
    // half-width of the caster measured across the light direction
    const c = Math.cos(ry), s = Math.sin(ry);
    const ax = Math.abs(c * hw) + Math.abs(s * hd);
    const az = Math.abs(s * hw) + Math.abs(c * hd);
    const across = Math.abs(-dz) * ax + Math.abs(dx) * az;
    const wide = Math.max(0.16, across * 0.92);
    // AABB of the whole lobe
    const cx2 = x + dx * len * 0.5, cz2 = z + dz * len * 0.5;
    const rx = Math.abs(dx) * len * 0.5 + wide + 0.5;
    const rz = Math.abs(dz) * len * 0.5 + wide + 0.5;
    const r = this._rect(cx2, cz2, rx, rz);
    for (let j = r.j0; j <= r.j1; j++) {
      const wz = this._wz(j) - z;
      for (let i = r.i0; i <= r.i1; i++) {
        const wx = this._wx(i) - x;
        const t = wx * dx + wz * dz;                 // metres along the shadow
        if (t < -0.25 || t > len) continue;
        const p = wx * -dz + wz * dx;                // metres across it
        // the lobe widens slightly and softens as it runs out
        const u = Math.max(0, t) / len;
        const half = wide * (1.0 + u * 0.55);
        const q = Math.abs(p) / half;
        if (q >= 1) continue;
        // ragged edges: a shadow of a real object is never a clean lozenge
        const n = 0.80 + 0.34 * this._n2((this._wx(i)) * 0.9, (this._wz(j)) * 0.9);
        const lateral = (1 - q * q) ** 0.85;
        const along = (1 - u) ** 1.25;
        const k = lateral * along * n * strength;
        if (k > 0.004) this._occl(i, j, 1 - Math.min(0.86, k));
      }
    }
    this.splats++;
  }

  /** A worn traffic lane between two points: darkens and polishes. */
  wearLane(ax, az, bx, bz, halfWidth = 1.6, strength = 0.7) {
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    const pad = halfWidth + 1.2;
    const r = this._rect((ax + bx) * 0.5, (az + bz) * 0.5,
      Math.abs(dx) * 0.5 + pad, Math.abs(dz) * 0.5 + pad);
    for (let j = r.j0; j <= r.j1; j++) {
      const wz = this._wz(j);
      for (let i = r.i0; i <= r.i1; i++) {
        const wx = this._wx(i);
        let t = ((wx - ax) * dx + (wz - az) * dz) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + dx * t, pz = az + dz * t;
        const d = Math.hypot(wx - px, wz - pz);
        // ragged edge so the lane never reads as a drawn stripe
        const wob = halfWidth * (0.78 + 0.44 * this._n2(wx * 0.21, wz * 0.21));
        if (d > wob + 1.1) continue;
        const k = 1 - Math.max(0, (d - wob * 0.45)) / (wob * 0.55 + 1.1);
        if (k <= 0) continue;
        const f = k * k * (3 - 2 * k);
        this._add(i, j, 1, f * strength);
        // spoil pushed to the shoulder
        if (d > wob * 0.8) this._add(i, j, 0, (1 - k) * 0.5);
      }
    }
    this.splats++;
  }

  /** Loose dust / spoil drift. */
  dust(x, z, radius, strength = 0.6) {
    const r = this._rect(x, z, radius, radius);
    for (let j = r.j0; j <= r.j1; j++) {
      const wz = this._wz(j) - z;
      for (let i = r.i0; i <= r.i1; i++) {
        const wx = this._wx(i) - x;
        const d = Math.hypot(wx, wz) / radius;
        if (d >= 1) continue;
        const n = 0.62 + 0.76 * this._n2((wx + x) * 0.5, (wz + z) * 0.5);
        const k = (1 - d) ** 1.6 * n;
        this._add(i, j, 0, k * strength);
      }
    }
    this.splats++;
  }

  /** Standing-water basin: hard darkening plus a mirror-smooth roughness. */
  puddle(x, z, radius, strength = 0.85) {
    const r = this._rect(x, z, radius * 1.35, radius * 1.35);
    for (let j = r.j0; j <= r.j1; j++) {
      const wz = this._wz(j) - z;
      for (let i = r.i0; i <= r.i1; i++) {
        const wx = this._wx(i) - x;
        // irregular rim — a circular puddle reads as a decal
        const ang = Math.atan2(wz, wx);
        const wob = radius * (0.72 + 0.5 * this._n2(Math.cos(ang) * 2.2 + x, Math.sin(ang) * 2.2 + z));
        const d = Math.hypot(wx, wz);
        if (d > wob) continue;
        const k = Math.min(1, (1 - d / wob) * 3.2);
        this._add(i, j, 2, k * strength);
        this._add(i, j, 1, k * 0.35);
      }
    }
    this.splats++;
  }

  /* cheap 2D value noise for mask authoring (CPU side) */
  _n2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const h = (a, b) => {
      let n = a * 374761393 + b * 668265263;
      n = (n ^ (n >>> 13)) * 1274126177;
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
  }

  build() {
    if (this.texture) return this.texture;
    const t = new THREE.DataTexture(this.data, this.size, this.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.needsUpdate = true;
    t.name = 'groundMask';
    this.texture = t;
    return t;
  }

  dispose() { this.texture?.dispose(); this.texture = null; }
}

/* ───────────────────────────── the shader ─────────────────────────────── */

const GROUND_COMMON = /* glsl */`
varying vec3 vGroundW;
uniform sampler2D uGMask;
uniform vec4 uGMaskXf;        // xy = origin, zw = 1/extent
uniform sampler2D uGDirt;
uniform vec4 uGDirtCfg;       // x = 1/tile, y = blend gain, z = blend bias, w = dirt sat
uniform vec4 uGMacro;         // x = albedo lo, y = albedo hi, z = rough amp, w = wear gain
uniform vec4 uGTint;          // rgb = dirt tint, a = contact strength

float gHash21( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}
float gVal( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = gHash21( i );
  float b = gHash21( i + vec2( 1.0, 0.0 ) );
  float c = gHash21( i + vec2( 0.0, 1.0 ) );
  float d = gHash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
`;

const GROUND_BODY = /* glsl */`
  vec2 gXZ = vGroundW.xz;
  vec2 gMuv = ( gXZ - uGMaskXf.xy ) * uGMaskXf.zw;
  vec4 gM = texture2D( uGMask, clamp( gMuv, 0.0035, 0.9965 ) );
  float gDust = gM.r;
  float gWear = gM.g * uGMacro.w;
  float gWet  = gM.b;
  float gOpen = gM.a;

  /**
   * Four octaves: 47 m drifts, 17 m patches, 6.5 m mottle, 2.3 m break-up.
   *
   * The 2.3 m octave is not decoration — it is the specific band the critics said
   * was missing. Before this the ground had content at 4 cm (the aggregate) and at
   * 90 m (the shape of the yard) and NOTHING in between, which is what makes a
   * plane read as porridge rather than as ground. Weights are deliberately flat-ish
   * so no single band dominates; a peaked spectrum just moves the problem.
   */
  float gA = gVal( gXZ * 0.0213 );
  float gB = gVal( gXZ * 0.0588 + 31.7 );
  float gC = gVal( gXZ * 0.1538 - 17.3 );
  float gD = gVal( gXZ * 0.4348 + 53.1 );
  float gMacro = gA * 0.40 + gB * 0.28 + gC * 0.20 + gD * 0.12;
  float gMacro2 = gVal( gXZ * 0.0345 + 77.0 ) * 0.44 + gC * 0.30 + gD * 0.26;
`;

/**
 * Albedo stage — runs right after `<map_fragment>`, so `diffuseColor` already
 * holds the tiled base albedo times the vertex colour.
 */
const GROUND_ALBEDO_A = /* glsl */`
  // 1. broad value swing: the 10-40 m scale the plane had no trace of
  float gK = mix( uGMacro.x, uGMacro.y, gMacro );
  gK *= 1.0 - gWear * 0.30;
  gK *= 1.0 + gDust * 0.24;
  diffuseColor.rgb *= gK;
`;

const GROUND_ALBEDO_B = /* glsl */`
  // 3. standing water darkens hard and kills the albedo variance
  diffuseColor.rgb *= 1.0 - gWet * 0.52;

  // 4. contact occlusion at every object/ground junction
  diffuseColor.rgb *= mix( 1.0, gOpen, uGTint.a );
`;

/** Second ground layer — only compiled in when a dirt albedo is actually available. */
const GROUND_DIRT = /* glsl */`
  // 2. second ground layer (compacted dirt / loose gravel), HEIGHT-blended so the
  //    grains sit proud of the slab at the boundary instead of cross-fading
  vec3 gDirtRaw = texture2D( uGDirt, gXZ * uGDirtCfg.x ).rgb;
  gDirtRaw *= gDirtRaw;                                   // approximate sRGB decode
  float gDirtH = dot( gDirtRaw, vec3( 0.34, 0.42, 0.24 ) );
  float gWant = clamp( gDust * uGDirtCfg.y + ( gMacro - uGDirtCfg.z ) * 1.75, 0.0, 1.0 );
  float gBlend = clamp( ( gWant + gDirtH * 0.85 - 0.62 ) * 4.2, 0.0, 1.0 ) * step( 0.004, gWant );
  vec3 gDirtCol = mix( vec3( gDirtH ), gDirtRaw, uGDirtCfg.w ) * uGTint.rgb;
  diffuseColor.rgb = mix( diffuseColor.rgb, gDirtCol * ( 0.72 + gMacro * 0.55 ), gBlend );
`;

/** Roughness stage — after `<roughnessmap_fragment>`. */
const GROUND_ROUGH = /* glsl */`
  roughnessFactor *= 1.0 + ( gMacro2 - 0.5 ) * uGMacro.z * 2.0;
  roughnessFactor += gDust * 0.13;
  roughnessFactor -= gWear * 0.20;
  roughnessFactor = mix( roughnessFactor, 0.075, gWet * 0.92 );
  roughnessFactor = clamp( roughnessFactor, 0.045, 1.0 );
`;

/**
 * Bolt the macro layer onto a MeshStandardMaterial.
 *
 * Must be called BEFORE the lighting system registers the material for CSM: that
 * registration chains whatever `onBeforeCompile` it finds, and its scene sweep
 * self-heals if it is ever replaced, so installing first is the safe order.
 *
 * The `customProgramCacheKey` override is not optional. Three's program cache is
 * keyed on material *parameters*, not on the identity of `onBeforeCompile`; two
 * clones of `concrete` that differ only in their compile hook would silently share
 * one program and one of them would render with the other's shader.
 */
export function applyGroundShader(material, cfg) {
  if (!material || !material.isMeshStandardMaterial) return material;
  try {
    const u = {
      uGMask: { value: cfg.mask ?? null },
      uGMaskXf: { value: new THREE.Vector4(cfg.x0, cfg.z0, 1 / (cfg.x1 - cfg.x0), 1 / (cfg.z1 - cfg.z0)) },
      uGDirt: { value: cfg.dirtMap ?? null },
      uGDirtCfg: { value: new THREE.Vector4(1 / (cfg.dirtTile ?? 2.2), cfg.dirtGain ?? 1.15, cfg.dirtBias ?? 0.66, cfg.dirtSat ?? 0.85) },
      uGMacro: { value: new THREE.Vector4(cfg.albedoLo ?? 0.74, cfg.albedoHi ?? 1.22, cfg.roughAmp ?? 0.20, cfg.wearGain ?? 1.0) },
      uGTint: { value: new THREE.Vector4(cfg.dirtTint?.[0] ?? 1.0, cfg.dirtTint?.[1] ?? 0.94, cfg.dirtTint?.[2] ?? 0.82, cfg.contact ?? 0.62) },
    };
    material.userData.groundUniforms = u;

    const prev = material.onBeforeCompile;
    material.onBeforeCompile = function (shader, renderer) {
      if (typeof prev === 'function') {
        try { prev.call(this, shader, renderer); } catch (e) { console.warn('[level] chained OBC threw', e); }
      }
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGroundW;')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\nvGroundW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      const albedo = GROUND_BODY + GROUND_ALBEDO_A
        + (cfg.dirtMap ? GROUND_DIRT : '') + GROUND_ALBEDO_B;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + GROUND_COMMON)
        .replace('#include <map_fragment>', '#include <map_fragment>\n' + albedo)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + GROUND_ROUGH);
    };

    const baseKey = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => `${baseKey()}|gnd:${cfg.key}`;
    material.needsUpdate = true;
  } catch (err) {
    console.warn('[level] ground shader injection failed:', err);
  }
  return material;
}

export default GroundMask;
