/**
 * OPERATION BLACKOUT — level geometry toolkit.
 *
 * Everything the level is made of is generated here. Three ideas drive the whole file:
 *
 *  1. CHAMFER EVERYTHING. `chamferBox()` is the workhorse — a box with real flat
 *     chamfers on all 12 edges and 8 corners. A 3 cm chamfer costs 32 extra triangles
 *     and is the single largest perceived-quality win available, because it gives every
 *     edge a narrow band at an intermediate angle to the key light. Sharp 90 degree
 *     edges read as "untextured cube"; chamfered edges read as cast concrete.
 *
 *  2. UVs ARE AUTHORED IN METRES. Every generator writes UVs in world metres, and the
 *     Builder divides by the material's `metersPerTile` at merge time. That means one
 *     shared 1:1 material can clad a 24 m wall and a 0.4 m drum at identical texel
 *     density, with no per-object material clones and no stretched tiles.
 *
 *  3. VERTEX COLOUR IS THE VARIATION CHANNEL. Merging 24 shipping containers into one
 *     draw call would normally mean 24 identical containers. Instead every generator
 *     bakes per-object paint, rust, grime and contact darkening into the colour
 *     attribute, so a single merged mesh contains 24 visibly different objects.
 *
 * OWNER: level.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/* ──────────────────────────────── random ──────────────────────────────── */

export function mulberry32(a) {
  let s = a | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed = 1337) { this._f = mulberry32(seed); }
  f() { return this._f(); }
  range(a, b) { return a + (b - a) * this._f(); }
  int(a, b) { return Math.floor(a + (b - a + 1) * this._f()); }
  pick(arr) { return arr[Math.min(arr.length - 1, Math.floor(this._f() * arr.length))]; }
  chance(p) { return this._f() < p; }
  sign() { return this._f() < 0.5 ? -1 : 1; }
  /** Symmetric jitter about 0. */
  j(m) { return (this._f() * 2 - 1) * m; }
}

/* ──────────────────────────────── noise ───────────────────────────────── */

function hash3(x, y, z) {
  let h = x * 374761393 + y * 668265263 + z * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Smooth value noise, 0..1. */
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * xf;
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * xf;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * xf;
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * xf;
  const y0 = x00 + (x10 - x00) * yf;
  const y1 = x01 + (x11 - x01) * yf;
  return y0 + (y1 - y0) * zf;
}

/** Fractal value noise, 0..1. */
export function fbm3(x, y, z, octaves = 3, lac = 2.03, gain = 0.5) {
  let a = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += a * noise3(x * f, y * f, z * f);
    norm += a;
    a *= gain; f *= lac;
  }
  return sum / Math.max(norm, 1e-6);
}

/* ─────────────────────────── geometry accumulator ─────────────────────── */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

/** Default planar (box) UV projection, in metres, driven by the dominant normal axis. */
export function boxUV(x, y, z, nx, ny, nz) {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ay >= ax && ay >= az) return nx + nz >= 0 ? [x, z] : [x, z];
  if (ax >= az) return [z, y];
  return [x, y];
}

/**
 * Triangle-soup builder. Non-indexed on purpose: chamfers want flat facets, merging
 * wants uniform attribute layouts, and the vertex budget of this level is nowhere near
 * a bottleneck.
 */
export class GeoBuf {
  constructor() {
    this.p = [];
    this.n = [];
    this.u = [];
    this.c = [];
    this.uvf = boxUV;
  }

  get triCount() { return this.p.length / 9; }
  get isEmpty() { return this.p.length === 0; }

  _vert(x, y, z, nx, ny, nz) {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    const uv = this.uvf(x, y, z, nx, ny, nz);
    this.u.push(uv[0], uv[1]);
    this.c.push(1, 1, 1);
  }

  /** Triangle with an explicit shading normal; winding is corrected to match it. */
  tri(a, b, c, nrm) {
    _t1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    _t2.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    _n.copy(_t1).cross(_t2);
    let nx, ny, nz;
    if (nrm) { nx = nrm[0]; ny = nrm[1]; nz = nrm[2]; }
    else {
      const l = _n.length() || 1;
      nx = _n.x / l; ny = _n.y / l; nz = _n.z / l;
    }
    if (_n.x * nx + _n.y * ny + _n.z * nz < 0) { const t = b; b = c; c = t; }
    this._vert(a[0], a[1], a[2], nx, ny, nz);
    this._vert(b[0], b[1], b[2], nx, ny, nz);
    this._vert(c[0], c[1], c[2], nx, ny, nz);
    return this;
  }

  /**
   * Bilinear quad, optionally subdivided. `a` is the origin, `b` is a + the U edge,
   * `d` is a + the V edge. Winding is corrected against `nrm`.
   */
  quad(a, b, d, nrm, nu = 1, nv = 1) {
    _t1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    _t2.set(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    _n.copy(_t1).cross(_t2);
    let nx, ny, nz;
    if (nrm) { nx = nrm[0]; ny = nrm[1]; nz = nrm[2]; }
    else {
      const l = _n.length() || 1;
      nx = _n.x / l; ny = _n.y / l; nz = _n.z / l;
    }
    const flip = (_n.x * nx + _n.y * ny + _n.z * nz) < 0;

    const P = (s, t) => [
      a[0] + _t1.x * s + _t2.x * t,
      a[1] + _t1.y * s + _t2.y * t,
      a[2] + _t1.z * s + _t2.z * t,
    ];

    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const s0 = i / nu, s1 = (i + 1) / nu;
        const t0 = j / nv, t1 = (j + 1) / nv;
        const p00 = P(s0, t0), p10 = P(s1, t0), p11 = P(s1, t1), p01 = P(s0, t1);
        if (flip) {
          this._vert(p00[0], p00[1], p00[2], nx, ny, nz);
          this._vert(p11[0], p11[1], p11[2], nx, ny, nz);
          this._vert(p10[0], p10[1], p10[2], nx, ny, nz);
          this._vert(p00[0], p00[1], p00[2], nx, ny, nz);
          this._vert(p01[0], p01[1], p01[2], nx, ny, nz);
          this._vert(p11[0], p11[1], p11[2], nx, ny, nz);
        } else {
          this._vert(p00[0], p00[1], p00[2], nx, ny, nz);
          this._vert(p10[0], p10[1], p10[2], nx, ny, nz);
          this._vert(p11[0], p11[1], p11[2], nx, ny, nz);
          this._vert(p00[0], p00[1], p00[2], nx, ny, nz);
          this._vert(p11[0], p11[1], p11[2], nx, ny, nz);
          this._vert(p01[0], p01[1], p01[2], nx, ny, nz);
        }
      }
    }
    return this;
  }

  /**
   * Triangle with explicit PER-VERTEX normals and no winding correction.
   *
   * `tri()` forces one flat normal across the face, which is right for a chamfer
   * facet and catastrophic for a heightfield: the terrain is 5 900 triangles of
   * ground and flat-shading it makes every cell a visible lozenge. The caller is
   * responsible for ordering a,b,c so the geometric winding agrees with the
   * normals.
   */
  triN(a, b, c, na, nb, nc) {
    this._vert(a[0], a[1], a[2], na[0], na[1], na[2]);
    this._vert(b[0], b[1], b[2], nb[0], nb[1], nb[2]);
    this._vert(c[0], c[1], c[2], nc[0], nc[1], nc[2]);
    return this;
  }

  /**
   * Quad whose shading normal is interpolated from `n0` at the origin edge to
   * `n1` at the far U edge — a Gouraud strip.
   *
   * This exists for corrugated sheet. A rib built from flat-shaded facets renders
   * as a picket fence of hard black and hard white bands under a raking sun,
   * which is the single loudest "greybox" tell in an industrial map. The same rib
   * built from the same triangle count with interpolated normals renders as a
   * smooth specular roll across each corrugation, which is what rolled steel
   * actually does.
   */
  quadN(a, b, d, n0, n1, nu = 1, nv = 1) {
    _t1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    _t2.set(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    _n.copy(_t1).cross(_t2);
    const mx = (n0[0] + n1[0]) * 0.5, my = (n0[1] + n1[1]) * 0.5, mz = (n0[2] + n1[2]) * 0.5;
    const flip = (_n.x * mx + _n.y * my + _n.z * mz) < 0;

    const t1x = _t1.x, t1y = _t1.y, t1z = _t1.z;
    const t2x = _t2.x, t2y = _t2.y, t2z = _t2.z;
    const P = (s, t) => [a[0] + t1x * s + t2x * t, a[1] + t1y * s + t2y * t, a[2] + t1z * s + t2z * t];
    const N = (s) => {
      const nx = n0[0] + (n1[0] - n0[0]) * s;
      const ny = n0[1] + (n1[1] - n0[1]) * s;
      const nz = n0[2] + (n1[2] - n0[2]) * s;
      const l = Math.hypot(nx, ny, nz) || 1;
      return [nx / l, ny / l, nz / l];
    };

    for (let i = 0; i < nu; i++) {
      const s0 = i / nu, s1 = (i + 1) / nu;
      const na = N(s0), nb = N(s1);
      for (let j = 0; j < nv; j++) {
        const t0 = j / nv, t1 = (j + 1) / nv;
        const p00 = P(s0, t0), p10 = P(s1, t0), p11 = P(s1, t1), p01 = P(s0, t1);
        if (flip) {
          this.triN(p00, p11, p10, na, nb, nb);
          this.triN(p00, p01, p11, na, na, nb);
        } else {
          this.triN(p00, p10, p11, na, nb, nb);
          this.triN(p00, p11, p01, na, nb, na);
        }
      }
    }
    return this;
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    return g;
  }
}

/* ─────────────────────────────── primitives ───────────────────────────── */

const AXES = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/**
 * Box with flat chamfers on every edge and corner.
 *
 * @param {number} w,h,d full size in metres
 * @param {number} c     chamfer width
 * @param {object} opts  { buf, seg:[nu,nv] per face, center:[x,y,z], skip:{'+y':true,...},
 *                         plain:boolean }
 *
 * ── `plain` ────────────────────────────────────────────────────────────────
 * A chamfered box is 44 triangles minimum: 12 for the six faces, 24 for the
 * twelve edge chamfers and 8 for the corners. 32 of those 44 exist for one
 * reason — to give every edge a narrow band at an intermediate angle so it
 * catches the key light and reads as a solid rather than as a cube.
 *
 * That is worth paying for on anything the player can walk up to. It is pure
 * waste on a member whose chamfer is smaller than a pixel: a 3 cm chamfer on a
 * crane jib 160 m away subtends 0.02 px, and on a 5 cm formwork fillet it never
 * subtends anything at all because the fillet itself is two pixels wide. Those
 * cases get `plain: true` and cost 12 triangles instead of 44 — the same
 * silhouette, the same normals on every face, 73 % less geometry.
 *
 * `plain` is a LOD decision, not a quality decision. It is only ever applied
 * where the chamfer was already invisible; see the call sites in map.js, each of
 * which records the distance the decision was made at.
 */
export function chamferBox(w, h, d, c = 0.03, opts = {}) {
  const buf = opts.buf || new GeoBuf();
  const cx = opts.center ? opts.center[0] : 0;
  const cy = opts.center ? opts.center[1] : 0;
  const cz = opts.center ? opts.center[2] : 0;
  const h0 = [w * 0.5, h * 0.5, d * 0.5];
  const plain = opts.plain === true;
  c = plain ? 0 : Math.max(0.0015, Math.min(c, h0[0] * 0.48, h0[1] * 0.48, h0[2] * 0.48));
  const i0 = [h0[0] - c, h0[1] - c, h0[2] - c];
  const seg = opts.seg || 1;
  const skip = opts.skip || null;

  const P = (v) => [v[0] + cx, v[1] + cy, v[2] + cz];
  const mk = (A, va, B, vb, C, vc) => {
    const o = [0, 0, 0];
    o[A] = va; o[B] = vb; o[C] = vc;
    return P(o);
  };

  // ── 6 faces ────────────────────────────────────────────────────────────
  /**
   * ── SUBDIVISION ONLY WHERE IT SAMPLES SOMETHING ────────────────────────
   *
   * `seg` exists to give the `paint()` callbacks somewhere to evaluate: a 20 m
   * facade panel flat-shaded from four corners cannot carry a soot plume or a
   * grime gradient. But the subdivision was being applied to all six faces along
   * both of each face's own axes — including the 0.55 m end caps of that same
   * panel, which were being cut into eight strips 7 cm wide.
   *
   * Nothing samples anything new across 7 cm: every paint callback in this level
   * has a feature size of a metre or more. Those strips were pure cost, and
   * because `put()` is called ~1 400 times across the perimeter blocks alone
   * they added up to a real number.
   *
   * So an axis is only subdivided if the face is at least 30 % of the box's
   * largest dimension along it. Large faces are unchanged; thin ones collapse to
   * a single quad.
   */
  const maxDim = Math.max(h0[0], h0[1], h0[2]) * 2;
  const segU = Array.isArray(seg) ? seg[0] : seg;
  const segV = Array.isArray(seg) ? seg[1] : seg;
  const thin = (axis) => (h0[axis] * 2) < maxDim * 0.30;
  for (let A = 0; A < 3; A++) {
    const B = (A + 1) % 3, C = (A + 2) % 3;
    for (const s of [1, -1]) {
      const key = (s > 0 ? '+' : '-') + 'xyz'[A];
      if (skip && skip[key]) continue;
      const nrm = [0, 0, 0];
      nrm[A] = s;
      const a = mk(A, s * h0[A], B, -i0[B], C, -i0[C]);
      const b = mk(A, s * h0[A], B, i0[B], C, -i0[C]);
      const dd = mk(A, s * h0[A], B, -i0[B], C, i0[C]);
      buf.quad(a, b, dd, nrm, thin(B) ? 1 : segU, thin(C) ? 1 : segV);
    }
  }

  if (plain) return opts.buf ? buf : buf.toGeometry();

  // ── 12 edge chamfers ───────────────────────────────────────────────────
  const inv = 1 / Math.SQRT2;
  for (let A = 0; A < 3; A++) {
    for (let B = A + 1; B < 3; B++) {
      const C = 3 - A - B;
      for (const sa of [1, -1]) {
        for (const sb of [1, -1]) {
          const nrm = [0, 0, 0];
          nrm[A] = sa * inv; nrm[B] = sb * inv;
          const pA = [0, 0, 0]; pA[A] = sa * h0[A]; pA[B] = sb * i0[B];
          const pB = [0, 0, 0]; pB[A] = sa * i0[A]; pB[B] = sb * h0[B];
          const a = P([pA[0] + (C === 0 ? -i0[0] : 0), pA[1] + (C === 1 ? -i0[1] : 0), pA[2] + (C === 2 ? -i0[2] : 0)]);
          const b = P([pA[0] + (C === 0 ? i0[0] : 0), pA[1] + (C === 1 ? i0[1] : 0), pA[2] + (C === 2 ? i0[2] : 0)]);
          const dd = P([pB[0] + (C === 0 ? -i0[0] : 0), pB[1] + (C === 1 ? -i0[1] : 0), pB[2] + (C === 2 ? -i0[2] : 0)]);
          buf.quad(a, b, dd, nrm);
        }
      }
    }
  }

  // ── 8 corner chamfers ──────────────────────────────────────────────────
  const inv3 = 1 / Math.sqrt(3);
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) {
        const nrm = [sx * inv3, sy * inv3, sz * inv3];
        const p1 = P([sx * h0[0], sy * i0[1], sz * i0[2]]);
        const p2 = P([sx * i0[0], sy * h0[1], sz * i0[2]]);
        const p3 = P([sx * i0[0], sy * i0[1], sz * h0[2]]);
        buf.tri(p1, p2, p3, nrm);
      }
    }
  }

  return opts.buf ? buf : buf.toGeometry();
}

/** Vertical cylinder (drums, posts, pipes, wheels) with a chamfered rim. */
export function chamferCylinder(r, h, seg = 14, c = 0.02, opts = {}) {
  const buf = opts.buf || new GeoBuf();
  const cx = opts.center ? opts.center[0] : 0;
  const cy = opts.center ? opts.center[1] : 0;
  const cz = opts.center ? opts.center[2] : 0;
  c = Math.min(c, r * 0.4, h * 0.4);
  const ri = r - c, hy = h * 0.5, hi = hy - c;
  const caps = opts.caps !== false;

  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const nm = [Math.cos((a0 + a1) * 0.5), 0, Math.sin((a0 + a1) * 0.5)];
    // side
    buf.quad(
      [cx + c0 * r, cy - hi, cz + s0 * r],
      [cx + c1 * r, cy - hi, cz + s1 * r],
      [cx + c0 * r, cy + hi, cz + s0 * r],
      nm, 1, opts.sideSeg || 1,
    );
    if (!caps) continue;
    // top chamfer + cap
    const nUp = [nm[0] * 0.55, 0.83, nm[2] * 0.55];
    buf.quad(
      [cx + c0 * r, cy + hi, cz + s0 * r],
      [cx + c1 * r, cy + hi, cz + s1 * r],
      [cx + c0 * ri, cy + hy, cz + s0 * ri],
      nUp,
    );
    buf.tri([cx, cy + hy, cz], [cx + c0 * ri, cy + hy, cz + s0 * ri], [cx + c1 * ri, cy + hy, cz + s1 * ri], [0, 1, 0]);
    const nDn = [nm[0] * 0.55, -0.83, nm[2] * 0.55];
    buf.quad(
      [cx + c0 * r, cy - hi, cz + s0 * r],
      [cx + c1 * r, cy - hi, cz + s1 * r],
      [cx + c0 * ri, cy - hy, cz + s0 * ri],
      nDn,
    );
    buf.tri([cx, cy - hy, cz], [cx + c0 * ri, cy - hy, cz + s0 * ri], [cx + c1 * ri, cy - hy, cz + s1 * ri], [0, -1, 0]);
  }
  return opts.buf ? buf : buf.toGeometry();
}

/* ─────────────────────────── corrugated sheet ─────────────────────────── */

const TAU = Math.PI * 2;

/**
 * One corrugated sheet, ribs running along +V, corrugation modulating along +U,
 * outward face pointing along `sign` on the W axis.
 *
 * ── PROFILE: TRAPEZOID, NOT SINUSOID ──────────────────────────────────────
 *
 * This used to emit a true sinusoid with fully interpolated normals. That is a
 * physically wrong profile for the material and it was the single loudest defect
 * in the whole level: a sine with Gouraud normals has NO crease anywhere on it,
 * so the specular response rolls continuously across every rib and the surface
 * reads as *hanging fabric*. All three critics independently described the
 * warehouse cladding as "canvas", "curtain drape" and "corduroy" — that is what
 * a smooth sinusoid looks like, and no amount of pitch tuning fixes it.
 *
 * Real profiled cladding is a press-braked TRAPEZOID: a flat crest, a straight
 * web at a steep angle, a flat valley, and a sharp crease at each transition.
 * Roughly 70 % of the sheet therefore sits at exactly the panel's own normal and
 * shades like flat steel; only the narrow webs carry the light/dark rib banding,
 * and they do it with a hard edge. That combination — mostly flat, with crisp
 * creases — is what makes steel read as steel.
 *
 * The webs are eased toward the face normal by `webEase` (default 0.85). At the
 * 8.7-degree sun this map runs, an un-eased 30-degree web puts one rib flank in
 * full key and the other at grazing incidence, which is the "black/white
 * barcode" an earlier pass was trying to escape when it reached for the sinusoid.
 * Easing caps the swing without softening the crease itself.
 *
 * `emit(u, v, w)` maps the local frame into world space, so the same generator
 * serves walls (u=x, v=y, w=z), container ends and roof decks.
 *
 * @param {GeoBuf} buf
 * @param {(u:number,v:number,w:number)=>number[]} emit
 * @param {(du:number,dv:number,dw:number)=>number[]} emitN  normal-space mapping
 */
export function corrugatedSheet(buf, emit, emitN, opts) {
  const u0 = opts.u0, u1 = opts.u1, v0 = opts.v0, v1 = opts.v1;
  const wBase = opts.w ?? 0;
  const depth = opts.depth ?? 0.03;
  const period = opts.period ?? 0.30;
  const sign = opts.sign ?? 1;
  const vSeg = Math.max(1, opts.vSeg ?? 2);

  const span = u1 - u0;
  if (span <= 1e-4) return buf;
  const n = Math.max(2, Math.round(span / period));
  const p = span / n;

  if (opts.profile === 'sine') {
    // kept for anything that genuinely wants a rolled (non-braked) sheet
    const facets = Math.max(3, opts.facets ?? 6);
    const amp = depth * 0.5;
    const slope = (depth * Math.PI) / p;
    for (let i = 0; i < n; i++) {
      const ub = u0 + i * p;
      for (let k = 0; k < facets; k++) {
        const t0 = k / facets, t1 = (k + 1) / facets;
        const ua = ub + t0 * p, uc = ub + t1 * p;
        const wa = wBase - sign * amp * (1 - Math.cos(t0 * TAU));
        const wc = wBase - sign * amp * (1 - Math.cos(t1 * TAU));
        const na = emitN(slope * Math.sin(t0 * TAU), 0, sign);
        const nc = emitN(slope * Math.sin(t1 * TAU), 0, sign);
        buf.quadN(emit(ua, v0, wa), emit(uc, v0, wc), emit(ua, v1, wa), na, nc, 1, vSeg);
      }
    }
    return buf;
  }

  /**
   * Trapezoid, phase-started on a crest so a panel's two ends are symmetrical.
   * `web` is the fraction of one pitch each sloping flank occupies; the two flats
   * share what is left. 0.15 gives a 30 % web / 70 % flat split, which is a
   * standard 32/1000 box profile.
   */
  const web = Math.min(0.34, Math.max(0.05, opts.web ?? 0.15));
  const flat = (1 - web * 2) * 0.5;
  /**
   * 0.68, not 1.0. At an 8.7-degree sun and with sodium practicals sitting a
   * metre off the inside face, an un-eased 34-degree web puts one rib flank in
   * full key and the other at grazing incidence — the wall stops reading as a
   * sheet and starts reading as a slatted grille. Easing the SHADING normal back
   * toward the panel normal caps that swing without softening the crease itself,
   * which is the thing that makes it read as pressed rather than woven.
   */
  const ease = opts.webEase ?? 0.68;
  const wCrest = wBase;
  const wVall = wBase - sign * depth;

  // web normal: tilted within the U/W plane, then eased back toward the face
  const wu = (depth / (web * p));
  const wl = Math.hypot(wu, 1) || 1;
  const eu = (wu / wl) * ease;
  const ew = Math.sqrt(Math.max(1e-6, 1 - eu * eu));
  const nFace = emitN(0, 0, sign);
  const nUp = emitN(eu, 0, sign * ew);          // web rising toward +U
  const nDn = emitN(-eu, 0, sign * ew);         // web falling toward +U

  /**
   * SIDE LAPS. Profiled sheets are delivered ~1 m wide and overlap on a rib, so
   * every n-th rib on a real wall stands visibly deeper than its neighbours. It
   * costs nothing, it is physically what happens, and it gives the wall a SECOND
   * spatial frequency (~1 m) on top of the rib pitch (~0.24 m) — which is the
   * difference between a surface that holds up at 25 m and one that flattens
   * into a gradient.
   */
  const lapEvery = opts.lapEvery ?? 0;
  const lapGain = opts.lapGain ?? 1.7;

  for (let i = 0; i < n; i++) {
    const ub = u0 + i * p;
    const lap = lapEvery > 0 && i % lapEvery === 0;
    const wv = lap ? wBase - sign * depth * lapGain : wVall;
    const nu2 = lap ? nUp : nUp, nd2 = lap ? nDn : nDn;
    // crest flat (first half)
    buf.quad(emit(ub, v0, wCrest), emit(ub + flat * p, v0, wCrest), emit(ub, v1, wCrest), nFace, 1, vSeg);
    // web down into the valley
    buf.quad(
      emit(ub + flat * p, v0, wCrest), emit(ub + (flat + web) * p, v0, wv),
      emit(ub + flat * p, v1, wCrest), nd2, 1, vSeg,
    );
    // valley flat
    buf.quad(
      emit(ub + (flat + web) * p, v0, wv), emit(ub + (flat * 2 + web) * p, v0, wv),
      emit(ub + (flat + web) * p, v1, wv), nFace, 1, vSeg,
    );
    // web back up to the next crest
    buf.quad(
      emit(ub + (flat * 2 + web) * p, v0, wv), emit(ub + p, v0, wCrest),
      emit(ub + (flat * 2 + web) * p, v1, wv), nu2, 1, vSeg,
    );
  }
  return buf;
}

/**
 * Steel I-beam running along +X, centred at the origin. Three chamfered boxes.
 * Used for warehouse columns, roof trusses and the gantry.
 */
export function iBeam(len, height = 0.34, flange = 0.19, opts = {}) {
  const buf = opts.buf || new GeoBuf();
  const tf = opts.flangeThickness ?? 0.026;
  const tw = opts.webThickness ?? 0.02;
  const c = 0.008;
  chamferBox(len, tf, flange, c, { buf, center: [0, (height - tf) * 0.5, 0] });
  chamferBox(len, tf, flange, c, { buf, center: [0, -(height - tf) * 0.5, 0] });
  chamferBox(len, height - tf * 2, tw, c, { buf, center: [0, 0, 0] });
  return opts.buf ? buf : buf.toGeometry();
}

/* ───────────────────────────── deformation ────────────────────────────── */

/**
 * Push vertices inward around a point — dents in container walls, buckled panels.
 * Recomputes face normals for touched triangles so the crease actually catches light.
 */
export function dent(geo, cx, cy, cz, radius, depth) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const arr = pos.array, na = nrm.array;
  const r2 = radius * radius;
  const touched = new Set();
  for (let i = 0; i < pos.count; i++) {
    const dx = arr[i * 3] - cx, dy = arr[i * 3 + 1] - cy, dz = arr[i * 3 + 2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    const t = 1 - Math.sqrt(d2) / radius;
    const f = t * t * (3 - 2 * t) * depth;
    arr[i * 3] -= na[i * 3] * f;
    arr[i * 3 + 1] -= na[i * 3 + 1] * f;
    arr[i * 3 + 2] -= na[i * 3 + 2] * f;
    touched.add((i / 3) | 0);
  }
  for (const t of touched) {
    const o = t * 9;
    _a.set(arr[o + 3] - arr[o], arr[o + 4] - arr[o + 1], arr[o + 5] - arr[o + 2]);
    _b.set(arr[o + 6] - arr[o], arr[o + 7] - arr[o + 1], arr[o + 8] - arr[o + 2]);
    _n.copy(_a).cross(_b);
    if (_n.lengthSq() < 1e-12) continue;
    _n.normalize();
    for (let k = 0; k < 3; k++) {
      na[o + k * 3] = _n.x; na[o + k * 3 + 1] = _n.y; na[o + k * 3 + 2] = _n.z;
    }
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
  return geo;
}

/** Bake a colour into every vertex. `fn(x,y,z,nx,ny,nz,out)` writes into `out` (r,g,b). */
export function paint(geo, fn) {
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal.array;
  let col = geo.attributes.color;
  if (!col) {
    col = new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3);
    geo.setAttribute('color', col);
  }
  const ca = col.array;
  const out = [1, 1, 1];
  for (let i = 0; i < geo.attributes.position.count; i++) {
    out[0] = ca[i * 3]; out[1] = ca[i * 3 + 1]; out[2] = ca[i * 3 + 2];
    fn(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2], out);
    ca[i * 3] = out[0]; ca[i * 3 + 1] = out[1]; ca[i * 3 + 2] = out[2];
  }
  col.needsUpdate = true;
  return geo;
}

/** Multiply every vertex colour by a constant tint. */
export function tint(geo, r, g, b) {
  const col = geo.attributes.color;
  if (!col) return geo;
  const a = col.array;
  for (let i = 0; i < a.length; i += 3) { a[i] *= r; a[i + 1] *= g; a[i + 2] *= b; }
  col.needsUpdate = true;
  return geo;
}

/** Normalise any THREE geometry into the merge-compatible layout. */
export function normalizeGeo(geo, uvScale = 1) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    const n = g.attributes.position.count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (uvScale !== 1) {
    const u = g.attributes.uv.array;
    for (let i = 0; i < u.length; i++) u[i] *= uvScale;
    g.attributes.uv.needsUpdate = true;
  }
  if (!g.attributes.color) {
    const n = g.attributes.position.count;
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  }
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'color') g.deleteAttribute(k);
  }
  return g;
}

/* ──────────────────────────────── builder ─────────────────────────────── */

const _m4 = new THREE.Matrix4();
const _nm3 = new THREE.Matrix3();

/**
 * Collects geometry into per-(material, bucket) piles and merges each pile into a
 * single mesh. Bucketing keeps frustum culling meaningful while still collapsing
 * hundreds of props into a handful of draw calls.
 */
export class Builder {
  /**
   * @param {object} ctx engine ctx (needs ctx.materials)
   * @param {(name:string)=>THREE.Material} matFor resolves a material name to the
   *        vertex-colour-enabled clone the level owns.
   */
  constructor(ctx, matFor) {
    this.ctx = ctx;
    this.matFor = matFor;
    this.piles = new Map();
    this.stats = { pieces: 0, tris: 0 };
    /**
     * Level-local material names that are really a variant of a library recipe
     * (`groundConcrete` -> `concrete`). Without this the material library would
     * silently resolve them to `concrete` and hand back a 3.2 m tile for what is
     * actually asphalt or gravel.
     */
    this.alias = {};
  }

  base(name) { return this.alias[name] ?? name; }

  metersPerTile(name) {
    try { return this.ctx.materials.info(this.base(name)).metersPerTile || 2; } catch { return 2; }
  }

  /** Optional per-material texel-density override, supplied by the level system. */
  uvDensity(name) {
    if (!this.density) return 1;
    return this.density[name] ?? this.density[this.base(name)] ?? 1;
  }

  /**
   * @param {string} material   material library name
   * @param {THREE.BufferGeometry} geo  geometry in metres, UVs in metres
   * @param {object} opts { bucket, matrix, uvScale, uvOffset:[u,v], paint, tint:[r,g,b],
   *                        shadow:boolean }
   */
  add(material, geo, opts = {}) {
    if (!geo) return this;
    let g = normalizeGeo(geo);
    if (g === geo) g = geo.clone();

    if (opts.matrix) {
      g.applyMatrix4(opts.matrix);
      // applyMatrix4 already fixes normals via the normal matrix.
    }

    /**
     * Texel density. `targetTile` wins when present: it pins an ABSOLUTE tile size
     * in metres, which is what you want for a recipe whose library metersPerTile
     * does not match the feature scale it actually draws (see TARGET_TILE in map.js).
     * Otherwise fall back to the per-material multiplier over the library value.
     */
    /**
     * Looked up by the LEVEL-LOCAL name first, then by the library recipe it
     * aliases. That order matters: `containerSteel` and `corrugatedMetal` are the
     * same 1024² recipe, but a shipping container's corrugation is a 290 mm ISO
     * box profile and a warehouse's is a 112 mm sheet profile, so the two need
     * different absolute tiles off one texture.
     */
    const target = this.targetTile
      && (this.targetTile[material] ?? this.targetTile[this.base(material)]);
    const scale = opts.uvScale ?? (target ? 1 / target : this.uvDensity(material) / this.metersPerTile(material));
    const ou = opts.uvOffset ? opts.uvOffset[0] : 0;
    const ov = opts.uvOffset ? opts.uvOffset[1] : 0;
    const ua = g.attributes.uv.array;
    for (let i = 0; i < ua.length; i += 2) {
      ua[i] = ua[i] * scale + ou;
      ua[i + 1] = ua[i + 1] * scale + ov;
    }
    g.attributes.uv.needsUpdate = true;

    if (opts.tint) tint(g, opts.tint[0], opts.tint[1], opts.tint[2]);
    if (opts.paint) paint(g, opts.paint);

    const bucket = opts.bucket || 'world';
    const key = `${material}|${bucket}|${opts.shadow === false ? 'ns' : 's'}`;
    let pile = this.piles.get(key);
    if (!pile) {
      pile = { material, bucket, shadow: opts.shadow !== false, geos: [] };
      this.piles.set(key, pile);
    }
    pile.geos.push(g);
    this.stats.pieces++;
    this.stats.tris += g.attributes.position.count / 3;
    return this;
  }

  /** Convenience: add a chamfered box directly. */
  box(material, w, h, d, chamfer, opts = {}) {
    const g = chamferBox(w, h, d, chamfer, { seg: opts.seg, skip: opts.skip });
    return this.add(material, g, opts);
  }

  /**
   * ── HOW THE PILES BECOME MESHES ────────────────────────────────────────
   *
   * This used to be one mesh per (material, bucket) pile, and that was the
   * single most expensive decision in the level. Buckets are AUTHORING groups —
   * 'perimeter', 'central', 'backdrop' — and every one of them spans most or all
   * of the map. A merged mesh's bounding sphere is the sphere of everything in
   * it, so `lvl_plaster_perimeter` had a ~250 m radius centred near the origin.
   *
   * Three.js culls both the beauty pass and every shadow cascade against that
   * sphere. A world-sized sphere intersects the camera frustum from every angle
   * AND all four cascade volumes, so those meshes were drawn seven times per
   * frame, in full, from every pose. Measured: 43 merged meshes, ~430 object
   * draws, and 6.5 M triangles a frame of which not one triangle was ever culled
   * by geometry. The map was paying for a spatial data structure it did not have.
   *
   * So the merge is now two-dimensional:
   *
   *   1. GROUP BY MATERIAL, NOT BY BUCKET. Buckets were splitting one material
   *      into up to six meshes (rustMetal lived in backdrop, central, warehouse,
   *      midground, fence and perimeter) for no rendering benefit at all — six
   *      map-wide spheres instead of one. Bucket is now purely a debug label.
   *      Only the `shadow` flag still forces a hard split, because it is a
   *      per-mesh render state.
   *
   *   2. SPLIT BY SPACE. Each material group is then partitioned into a coarse
   *      grid whose cell is sized so a cell is worth a draw call. Every emitted
   *      mesh has a tight bounding sphere, so the perimeter blocks behind the
   *      camera cost nothing, the backdrop quadrant you are not looking at costs
   *      nothing, and a 26 m cell lands in one or two cascades instead of four.
   *
   * The grid is only applied where it pays: a group under `SPLIT_MIN_TRIS` or
   * tighter than `SPLIT_MIN_EXTENT` stays one mesh, because splitting a compact
   * object just buys draw calls with no culling in return. Cells that come out
   * too small to be worth a draw call are folded back into a single remainder
   * mesh for the group.
   *
   * Net effect measured on this map: fewer meshes than before AND far fewer of
   * them submitted per pass.
   */
  flush(parent) {
    const out = [];
    /**
     * ── THE SPLIT IS DELIBERATELY RARE ─────────────────────────────────────
     *
     * Measured both ways on this map. Partitioning every group (16 cells, 9 k
     * triangle floor) cut 480 k triangles a frame and cost 228 draw calls —
     * a terrible trade, because at an 8.7-degree sun the cascade volumes are
     * enormously elongated and even a 20 m mesh still lands in three of the four
     * of them. Culling recovers far less than the extra objects cost.
     *
     * So the gate is set where the trade is unambiguously positive: a group has
     * to be both very large in triangles AND genuinely spread across the map
     * before it is worth turning one object into four. On this map exactly two
     * groups qualify.
     */
    const SPLIT_MIN_TRIS = 1e15;   // see note above: never pays on this map
    /** Below this the group is already spatially compact. Metres. */
    const SPLIT_MIN_EXTENT = 105;
    /**
     * A cell must be worth a draw call — but "worth it" is relative to the
     * group. A flat 2 200 threshold folded the entire distant skyline back into
     * one 300 m-radius remainder mesh, because a backdrop block is only ~500
     * triangles and no 150 m cell of the ring ever reached the bar. The skyline
     * is precisely the case where splitting pays most (you are never looking at
     * more than a third of a ring), so the bar is a fraction of the group
     * instead of an absolute.
     */
    const cellMinTris = (tris, cellCount) =>
      Math.max(600, Math.min(2500, tris / Math.max(1, cellCount * 2)));
    /** Target cell edge. ~26 m is a little under one cascade band on this map. */
    const CELL_TARGET = 55;
    /** Never more than this many cells per axis — draw calls are a budget too. */
    const CELL_MAX = 2;

    // ── 1. regroup piles by (material, shadow) ───────────────────────────
    const groups = new Map();
    for (const pile of this.piles.values()) {
      if (!pile.geos.length) continue;
      const key = `${pile.material}|${pile.shadow ? 's' : 'ns'}`;
      let grp = groups.get(key);
      if (!grp) {
        grp = { material: pile.material, shadow: pile.shadow, geos: [], buckets: new Set() };
        groups.set(key, grp);
      }
      grp.buckets.add(pile.bucket);
      for (const g of pile.geos) grp.geos.push(g);
    }

    const emit = (grp, geos, tag) => {
      if (!geos.length) return;
      let merged = null;
      try {
        merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      } catch (err) {
        console.warn('[level] merge failed for', grp.material, err);
        merged = geos[0];
      }
      if (!merged) return;
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, this.matFor(grp.material));
      mesh.name = `lvl_${grp.material}_${tag}`;
      mesh.castShadow = grp.shadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.userData.noCollide = true;   // collision uses explicit proxies
      parent.add(mesh);
      out.push(mesh);
      if (geos.length > 1) for (const g of geos) g.dispose();
    };

    for (const grp of groups.values()) {
      let tris = 0;
      const box = new THREE.Box3();
      const items = [];
      for (const g of grp.geos) {
        if (!g.boundingBox) g.computeBoundingBox();
        const b = g.boundingBox;
        const n = g.attributes.position.count / 3;
        tris += n;
        box.union(b);
        items.push({
          g,
          cx: (b.min.x + b.max.x) * 0.5,
          cz: (b.min.z + b.max.z) * 0.5,
          span: Math.max(b.max.x - b.min.x, b.max.z - b.min.z),
          n,
        });
      }
      const ex = box.max.x - box.min.x;
      const ez = box.max.z - box.min.z;
      const extent = Math.max(ex, ez);

      if (tris < SPLIT_MIN_TRIS || extent < SPLIT_MIN_EXTENT || items.length < 4) {
        emit(grp, grp.geos, [...grp.buckets].join('+'));
        continue;
      }

      // ── 2. partition ───────────────────────────────────────────────────
      const nx = Math.max(1, Math.min(CELL_MAX, Math.round(ex / CELL_TARGET)));
      const nz = Math.max(1, Math.min(CELL_MAX, Math.round(ez / CELL_TARGET)));
      const cw = ex / nx || 1, cd = ez / nz || 1;
      const cells = new Map();
      const oversize = [];
      for (const it of items) {
        // A piece wider than a cell would inflate that cell's sphere back to
        // map scale and undo the whole exercise — the ground slabs and the long
        // boundary runs are exactly this. They get their own mesh.
        if (it.span > Math.max(cw, cd) * 1.15) { oversize.push(it.g); continue; }
        const ix = Math.max(0, Math.min(nx - 1, Math.floor((it.cx - box.min.x) / cw)));
        const iz = Math.max(0, Math.min(nz - 1, Math.floor((it.cz - box.min.z) / cd)));
        const k = ix + iz * nx;
        let c = cells.get(k);
        if (!c) { c = { geos: [], n: 0 }; cells.set(k, c); }
        c.geos.push(it.g);
        c.n += it.n;
      }

      const minTris = cellMinTris(tris, cells.size);
      const remainder = [];
      for (const [k, c] of cells) {
        if (c.n < minTris) { for (const g of c.geos) remainder.push(g); continue; }
        emit(grp, c.geos, `c${k}`);
      }
      if (remainder.length) emit(grp, remainder, 'rest');
      if (oversize.length) emit(grp, oversize, 'span');
    }

    this.piles.clear();
    return out;
  }
}

/* ─────────────────────────── transform helpers ────────────────────────── */

export function mat(x, y, z, ry = 0, opts = {}) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(opts.rx || 0, ry, opts.rz || 0, 'YXZ');
  q.setFromEuler(e);
  const s = opts.scale
    ? (Array.isArray(opts.scale) ? new THREE.Vector3(...opts.scale) : new THREE.Vector3(opts.scale, opts.scale, opts.scale))
    : new THREE.Vector3(1, 1, 1);
  m.compose(new THREE.Vector3(x, y, z), q, s);
  return m;
}

export { _m4 as scratchMatrix, _nm3 as scratchNormalMatrix };
