/**
 * OPERATION BLACKOUT — AI shared maths + procedural geometry helpers.
 * OWNER: ai agent.
 *
 * Nothing in here allocates per-frame: the vector scratch pool at the bottom is
 * what the hot paths use. Geometry builders run once at init.
 */
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const TAU = Math.PI * 2;

/** Deterministic PRNG so every boot produces the same squad. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => { const x = clamp01(t); return x * x * (3 - 2 * x); };
export const easeInOut = (t) => { const x = clamp01(t); return x * x * x * (x * (x * 6 - 15) + 10); };

/** Shortest signed angular difference, result in (-PI, PI]. */
export function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Frame-rate independent exponential approach. `rate` is roughly 1/seconds. */
export function damp(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export function dampAngle(current, target, rate, dt) {
  return current + angleDelta(current, target) * (1 - Math.exp(-rate * dt));
}

/* ───────────────────────────── geometry builders ───────────────────────────── */

/**
 * A bevelled box. Real props never have a knife-edge 90° corner: the bevel band is
 * what catches the low sun and makes the silhouette read as a solid object rather
 * than a polygon. Built by pushing a segmented cube out onto a rounded shell, then
 * welding so the flat faces stay flat and only the bevel band curves.
 */
export function bevelBox(w, h, d, radius = 0.02, seg = 3) {
  const r = Math.min(radius, w * 0.49, h * 0.49, d * 0.49);
  const g = new THREE.BoxGeometry(1, 1, 1, seg, seg, seg);
  const pos = g.attributes.position;
  const hx = w * 0.5 - r, hy = h * 0.5 - r, hz = d * 0.5 - r;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i) * w, pos.getY(i) * h, pos.getZ(i) * d);
    const cx = clamp(v.x, -hx, hx), cy = clamp(v.y, -hy, hy), cz = clamp(v.z, -hz, hz);
    let nx = v.x - cx, ny = v.y - cy, nz = v.z - cz;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-6) { const s = r / len; nx *= s; ny *= s; nz *= s; }
    pos.setXYZ(i, cx + nx, cy + ny, cz + nz);
  }
  pos.needsUpdate = true;
  let out = g;
  try { out = mergeVertices(g, 1e-5); } catch { out = g; }
  out.computeVertexNormals();
  return out;
}

/**
 * A tapered, capped limb segment built as a lathe. Cheaper and far better shaped
 * than a capsule for thighs, calves and arms — muscles taper, cylinders do not.
 * Origin sits at the TOP of the segment; the body extends down -Y.
 */
export function limb(rTop, rBot, length, radial = 10, capSeg = 3) {
  const pts = [];
  for (let i = capSeg; i >= 1; i--) {
    const a = (i / capSeg) * Math.PI * 0.5;
    pts.push(new THREE.Vector2(Math.cos(a) * rTop * 0.999 + 1e-4, Math.sin(a) * rTop * 0.72));
  }
  // gentle mid-bulge so limbs are not straight cones
  pts.push(new THREE.Vector2(rTop, 0));
  pts.push(new THREE.Vector2(lerp(rTop, rBot, 0.35) * 1.045, -length * 0.35));
  pts.push(new THREE.Vector2(rBot, -length));
  for (let i = 1; i <= capSeg; i++) {
    const a = (i / capSeg) * Math.PI * 0.5;
    pts.push(new THREE.Vector2(Math.cos(a) * rBot * 0.999 + 1e-4, -length - Math.sin(a) * rBot * 0.72));
  }
  const g = new THREE.LatheGeometry(pts, radial);
  g.computeVertexNormals();
  return g;
}

/** Cylinder along Z (barrels, tubes). Origin centred. */
export function tubeZ(radius, length, radial = 12, open = false) {
  const g = new THREE.CylinderGeometry(radius, radius, length, radial, 1, open);
  g.rotateX(Math.PI * 0.5);
  return g;
}

/** Helmet shell: an over-scaled sphere cap with a thickened rim. */
export function domeShell(radius, thetaLength, wSeg = 20, hSeg = 12) {
  const g = new THREE.SphereGeometry(radius, wSeg, hSeg, 0, TAU, 0, thetaLength);
  return g;
}

/** Multiply every UV so a 1:1 material tiles at a sane real-world texel density. */
export function scaleUV(g, su, sv = su) {
  const uv = g.attributes.uv;
  if (!uv) return g;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return g;
}

/** Apply a TRS to a geometry in place. Rotation is XYZ euler radians. */
export function place(g, pos, rot = null, scale = null) {
  if (scale) g.scale(scale[0], scale[1], scale[2]);
  if (rot) {
    if (rot[0]) g.rotateX(rot[0]);
    if (rot[1]) g.rotateY(rot[1]);
    if (rot[2]) g.rotateZ(rot[2]);
  }
  if (pos) g.translate(pos[0], pos[1], pos[2]);
  return g;
}

/** Squared distance from point p to segment ab. */
export function distSqToSegment(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const denom = abx * abx + aby * aby + abz * abz;
  let t = denom > 1e-9 ? (apx * abx + apy * aby + apz * abz) / denom : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

/* ─────────────────────────────── scratch pool ─────────────────────────────── */

export const _v = [];
for (let i = 0; i < 24; i++) _v.push(new THREE.Vector3());
export const _q = [];
for (let i = 0; i < 10; i++) _q.push(new THREE.Quaternion());
export const _m = [];
for (let i = 0; i < 6; i++) _m.push(new THREE.Matrix4());
