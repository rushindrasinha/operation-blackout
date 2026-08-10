import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * OPERATION BLACKOUT — weapon geometry toolkit.
 *
 * Rules this file enforces so the gun never reads as a toy:
 *
 *  1. NOTHING is a sharp-edged box. Every primitive is chamfered; the chamfer band
 *     is what catches the key light and is the difference between "metal" and
 *     "grey polygon".
 *  2. Every vertex carries `aWear` (0 on a flat face, 1 across a chamfer) so the
 *     material can rub the finish off the edges.
 *  3. Every vertex carries `aAo` from a real per-vertex occlusion bake against the
 *     other parts of the weapon — the viewmodel scene is not in the G-buffer, so it
 *     gets no SSAO and this is the only cavity darkening it will ever have.
 *  4. UVs are box-projected in weapon space at a fixed texel density, so a 20 mm
 *     screw head and a 200 mm receiver have grain of the same physical size.
 *
 * Parts are accumulated into a Builder, then merged per material into one mesh each.
 *
 * OWNER: weapons.
 */

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/* ── primitives ───────────────────────────────────────────────────────────── */

/**
 * Chamfered box. `bevel` is the chamfer radius in metres — keep it 1-3 mm for
 * receiver-scale parts, 0.4-0.8 mm for small furniture.
 */
export function box(w, h, d, bevel = 0.0018, seg = 1) {
  const r = Math.max(0.00012, Math.min(bevel, Math.min(w, h, d) * 0.44));
  const g = new RoundedBoxGeometry(w, h, d, seg, r);
  // Wear MUST be derived before the part is rotated into weapon space: it is read
  // off the local normal's axis alignment, and an arbitrary rotation would make a
  // flat face look like a chamfer.
  wearFromAxes(g);
  return g;
}

/**
 * A lathe about +Z from a profile of [radius, z] pairs. Used for barrels, muzzle
 * devices, optic tubes, buffer tubes, screws. Creased so the cylinder stays smooth
 * around its axis while step transitions stay crisp.
 */
export function lathe(profile, segments = 20, creaseDeg = 42) {
  const pts = profile.map(([r, z]) => new THREE.Vector2(Math.max(1e-5, r), z));
  let g = new THREE.LatheGeometry(pts, segments);
  // LatheGeometry lathes about +Y; roll it onto +Z (profile z becomes world z).
  g.rotateX(Math.PI / 2);
  g.scale(1, 1, -1);
  try {
    g = toCreasedNormals(g, THREE.MathUtils.degToRad(creaseDeg));
  } catch (err) {
    g.computeVertexNormals();
  }
  wearFromAxial(g);
  return g;
}

/** Chamfered cylinder along +Z, centred at the origin. */
export function cyl(radius, length, bevel = 0.0008, segments = 20) {
  const hz = length / 2;
  const b = Math.max(1e-5, Math.min(bevel, radius * 0.4, length * 0.24));
  return lathe([
    [0.0001, -hz],
    [radius - b, -hz],
    [radius, -hz + b],
    [radius, hz - b],
    [radius - b, hz],
    [0.0001, hz],
  ], segments);
}

/** Hollow tube along +Z with chamfered lips — receivers, shrouds, optic bodies. */
export function tube(outer, inner, length, bevel = 0.0007, segments = 22) {
  const hz = length / 2;
  const b = Math.max(1e-5, Math.min(bevel, (outer - inner) * 0.4, length * 0.2));
  return lathe([
    [inner, -hz],
    [outer - b, -hz],
    [outer, -hz + b],
    [outer, hz - b],
    [outer - b, hz],
    [inner, hz],
    [inner, -hz],
  ], segments);
}

/** A truncated cone (flash hider cones, tapered barrels). */
export function cone(r0, r1, length, segments = 20) {
  const hz = length / 2;
  return lathe([
    [0.0001, -hz], [r0, -hz], [r1, hz], [0.0001, hz],
  ], segments);
}

/** Rounded plate — a flat panel with all four edges chamfered. Rails, latches. */
export function plate(w, h, t, bevel = 0.0008) {
  return box(w, h, t, bevel, 1);
}

/* ── transforms ───────────────────────────────────────────────────────────── */

/**
 * Position/rotate a geometry in weapon space.
 * @param {THREE.BufferGeometry} g
 * @param {number[]} pos  [x,y,z]
 * @param {number[]} [rot] [rx,ry,rz] radians
 * @param {number[]} [scale]
 */
export function at(g, pos, rot = null, scale = null) {
  if (scale) g.scale(scale[0], scale[1], scale[2]);
  if (rot) {
    _e.set(rot[0] || 0, rot[1] || 0, rot[2] || 0, 'XYZ');
    _q.setFromEuler(_e);
    _m.makeRotationFromQuaternion(_q);
    g.applyMatrix4(_m);
  }
  if (pos) g.translate(pos[0] || 0, pos[1] || 0, pos[2] || 0);
  return g;
}

/* ── attributes ───────────────────────────────────────────────────────────── */

/**
 * Box-project UVs from weapon-space position along the dominant normal axis.
 * `scale` is metres per texture tile.
 */
export function boxUV(g, scale = 0.075) {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  if (!pos || !nor) return g;
  const uv = new Float32Array(pos.count * 2);
  const s = 1 / Math.max(1e-4, scale);
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u, v;
    if (nx >= ny && nx >= nz) { u = pz * s; v = py * s; }
    else if (ny >= nz) { u = px * s; v = pz * s; }
    else { u = px * s; v = py * s; }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * Edge wear for a box-like part, read off the LOCAL normal's axis alignment.
 * A flat face is (1,0,0); an edge chamfer is (0.71,0.71,0); a corner is
 * (0.577,0.577,0.577). The second-largest component is therefore the edge mask.
 *
 * Must be called before the part is rotated into weapon space.
 */
export function wearFromAxes(g) {
  const nor = g.attributes.normal;
  if (!nor) return g;
  const out = new Float32Array(nor.count);
  for (let i = 0; i < nor.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    const mx = Math.max(nx, ny, nz);
    const mn = Math.min(nx, ny, nz);
    const md = nx + ny + nz - mx - mn;
    let w = THREE.MathUtils.smoothstep(md, 0.18, 0.60);
    w = Math.min(1, w + THREE.MathUtils.smoothstep(mn, 0.26, 0.55) * 0.55);
    out[i] = w;
  }
  g.setAttribute('aWear', new THREE.BufferAttribute(out, 1));
  return g;
}

/**
 * Edge wear for a lathed part. Here the axis-alignment test is meaningless — a
 * plain cylinder wall at 45 degrees of azimuth has normal (0.71,0.71,0) and would
 * be flagged as an edge across half its circumference. What actually marks a
 * chamfer on a body of revolution is the AXIAL component sitting between "wall"
 * (|nz| = 0) and "end cap" (|nz| = 1).
 *
 * Must be called before the part is rotated into weapon space (lathes are built
 * about +Z here).
 */
export function wearFromAxial(g) {
  const nor = g.attributes.normal;
  if (!nor) return g;
  const out = new Float32Array(nor.count);
  for (let i = 0; i < nor.count; i++) {
    const az = Math.abs(nor.getZ(i));
    // Bump centred on 0.71: rises off the wall, falls again on the flat end face.
    const rise = THREE.MathUtils.smoothstep(az, 0.22, 0.66);
    const fall = 1 - THREE.MathUtils.smoothstep(az, 0.80, 0.96);
    out[i] = rise * fall;
  }
  g.setAttribute('aWear', new THREE.BufferAttribute(out, 1));
  return g;
}

/** Scale an existing wear mask in place (per-part authoring control). */
export function scaleWear(g, amount = 1.0) {
  const a = g.attributes.aWear;
  if (!a) return g;
  if (amount === 1) return g;
  const arr = a.array;
  for (let i = 0; i < arr.length; i++) arr[i] *= amount;
  a.needsUpdate = true;
  return g;
}

/** Placeholder occlusion, overwritten by the bake. Guarantees the attribute exists. */
export function ao(g, value = 1.0) {
  const pos = g.attributes.position;
  if (!pos) return g;
  const out = new Float32Array(pos.count);
  out.fill(value);
  g.setAttribute('aAo', new THREE.BufferAttribute(out, 1));
  return g;
}

/* ── AO bake ──────────────────────────────────────────────────────────────── */

function rayBox(ox, oy, oz, dx, dy, dz, b, maxT) {
  // Slab test. Direction components are never exactly zero here (jittered), so the
  // reciprocal is safe.
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  let t0 = (b[0] - ox) * ix, t1 = (b[3] - ox) * ix;
  let tmin = Math.min(t0, t1), tmax = Math.max(t0, t1);
  t0 = (b[1] - oy) * iy; t1 = (b[4] - oy) * iy;
  tmin = Math.max(tmin, Math.min(t0, t1));
  tmax = Math.min(tmax, Math.max(t0, t1));
  t0 = (b[2] - oz) * iz; t1 = (b[5] - oz) * iz;
  tmin = Math.max(tmin, Math.min(t0, t1));
  tmax = Math.min(tmax, Math.max(t0, t1));
  if (tmax < Math.max(tmin, 0) || tmin > maxT) return -1;
  return tmin > 0 ? tmin : (tmax > 0 ? 0 : -1);
}

/** Cosine-weighted hemisphere directions in tangent space, fixed set (deterministic). */
const HEMI = (() => {
  const out = [];
  const N = 13;
  for (let i = 0; i < N; i++) {
    // Vogel spiral on the disc -> cosine hemisphere.
    const r = Math.sqrt((i + 0.5) / N);
    const th = i * 2.39996323;
    const x = r * Math.cos(th), y = r * Math.sin(th);
    const z = Math.sqrt(Math.max(0.02, 1 - x * x - y * y));
    out.push([x, y, z]);
  }
  return out;
})();

/**
 * Per-vertex ambient obscurance against the weapon's own parts, approximated with
 * their oriented bounding boxes in weapon space.
 *
 * This is what puts real darkness inside the magazine well, under the handguard,
 * inside the trigger guard, and in the gap between the optic and the rail. Without
 * it the gun looks like it is lit from inside.
 *
 * @param {Array<{geometry:THREE.BufferGeometry, occlude:boolean, aoScale:number}>} parts
 * @param {object} opts { radius, strength, minAo }
 */
export function bakeAO(parts, opts = {}) {
  const radius = opts.radius ?? 0.085;
  const strength = opts.strength ?? 1.0;
  const minAo = opts.minAo ?? 0.16;

  // Collect occluder boxes.
  const boxes = [];
  for (const p of parts) {
    if (p.occlude === false) continue;
    const g = p.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb) continue;
    // Shrink very slightly so a surface vertex is not perpetually inside its own box.
    const sx = Math.min(0.0009, (bb.max.x - bb.min.x) * 0.12);
    const sy = Math.min(0.0009, (bb.max.y - bb.min.y) * 0.12);
    const sz = Math.min(0.0009, (bb.max.z - bb.min.z) * 0.12);
    const arr = [bb.min.x + sx, bb.min.y + sy, bb.min.z + sz, bb.max.x - sx, bb.max.y - sy, bb.max.z - sz];
    const cx = (arr[0] + arr[3]) * 0.5, cy = (arr[1] + arr[4]) * 0.5, cz = (arr[2] + arr[5]) * 0.5;
    const rr = Math.hypot(arr[3] - cx, arr[4] - cy, arr[5] - cz);
    boxes.push({ b: arr, cx, cy, cz, r: rr });
  }

  const near = [];
  const nSamples = HEMI.length;

  for (const p of parts) {
    const g = p.geometry;
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    if (!pos || !nor) continue;
    const scale = p.aoScale ?? 1.0;
    const out = new Float32Array(pos.count);

    // Cache: many vertices share a position (non-indexed geometry duplicates them).
    const cache = new Map();

    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);

      const key = `${(px * 4000) | 0},${(py * 4000) | 0},${(pz * 4000) | 0},${(nx * 8) | 0},${(ny * 8) | 0},${(nz * 8) | 0}`;
      const hit = cache.get(key);
      if (hit !== undefined) { out[i] = hit; continue; }

      // Prefilter occluders by distance.
      near.length = 0;
      for (let k = 0; k < boxes.length; k++) {
        const bx = boxes[k];
        const d = Math.hypot(bx.cx - px, bx.cy - py, bx.cz - pz) - bx.r;
        if (d < radius) near.push(bx.b);
      }

      let occ = 0;
      if (near.length) {
        // Build a tangent frame around the normal.
        let ux = 0, uy = 0, uz = 0;
        if (Math.abs(nz) < 0.9) { ux = -ny; uy = nx; uz = 0; } else { ux = 0; uy = -nz; uz = ny; }
        const ul = 1 / (Math.hypot(ux, uy, uz) || 1);
        ux *= ul; uy *= ul; uz *= ul;
        const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;

        const ox = px + nx * 0.0011, oy = py + ny * 0.0011, oz = pz + nz * 0.0011;
        for (let s = 0; s < nSamples; s++) {
          const h = HEMI[s];
          // Jitter tiny amounts so no ray is ever exactly axis-parallel.
          const dx = ux * h[0] + vx * h[1] + nx * h[2] + 1e-5;
          const dy = uy * h[0] + vy * h[1] + ny * h[2] + 1.3e-5;
          const dz = uz * h[0] + vz * h[1] + nz * h[2] + 0.7e-5;
          for (let k = 0; k < near.length; k++) {
            const t = rayBox(ox, oy, oz, dx, dy, dz, near[k], radius);
            if (t >= 0.0022) {
              // Distance falloff: a contact at 3 mm occludes far harder than one at 60 mm.
              occ += 1 - THREE.MathUtils.smoothstep(t, 0.004, radius);
              break;
            }
          }
        }
      }

      const a = Math.max(minAo, 1 - (occ / nSamples) * strength * scale);
      cache.set(key, a);
      out[i] = a;
    }
    g.setAttribute('aAo', new THREE.BufferAttribute(out, 1));
  }
}

/* ── builder ──────────────────────────────────────────────────────────────── */

/**
 * Accumulates parts, then emits one merged mesh per material plus any parts that
 * were flagged as separately animated (magazine, bolt, charging handle, ...).
 */
export class PartBuilder {
  constructor(surfaces) {
    this.surfaces = surfaces;
    this.parts = [];
  }

  /**
   * @param {THREE.BufferGeometry} geometry  already positioned in weapon space
   * @param {string} material                key into WeaponSurfaces
   * @param {object} [opts] { uv, wear, group, occlude, aoScale }
   *   group: null merges into the static body; a string emits a separate node so
   *          the animation rig can move it.
   */
  add(geometry, material = 'steel', opts = {}) {
    try {
      const g = geometry.index ? geometry.toNonIndexed() : geometry;
      if (g !== geometry) geometry.dispose();
      // Wear was derived in the primitive constructor, in the part's own local
      // frame. If a caller handed us raw geometry, fall back to the box variant.
      if (!g.attributes.aWear) wearFromAxes(g);
      scaleWear(g, opts.wear ?? 1.0);
      // UVs are box-projected in WEAPON space, so they must be computed after the
      // part has been placed — that is what keeps texel density uniform.
      boxUV(g, opts.uv ?? 0.075);
      ao(g, 1.0);
      g.computeBoundingBox();
      this.parts.push({
        geometry: g,
        material,
        group: opts.group ?? null,
        occlude: opts.occlude !== false,
        aoScale: opts.aoScale ?? 1.0,
      });
      return g;
    } catch (err) {
      console.warn('[weapons] part build failed:', err);
      return null;
    }
  }

  /** Convenience: chamfered box placed in weapon space. */
  boxAt(size, pos, rot, material, opts = {}) {
    const g = box(size[0], size[1], size[2], opts.bevel ?? 0.0016, opts.seg ?? 1);
    at(g, pos, rot);
    return this.add(g, material, opts);
  }

  /** Convenience: chamfered cylinder along +Z placed in weapon space. */
  cylAt(radius, length, pos, rot, material, opts = {}) {
    const g = cyl(radius, length, opts.bevel ?? 0.0007, opts.segments ?? 18);
    at(g, pos, rot);
    return this.add(g, material, opts);
  }

  /** Convenience: lathe profile placed in weapon space. */
  latheAt(profile, pos, rot, material, opts = {}) {
    const g = lathe(profile, opts.segments ?? 20, opts.crease ?? 42);
    at(g, pos, rot);
    return this.add(g, material, opts);
  }

  /**
   * Bake occlusion, merge by (group, material), and return a THREE.Group plus a
   * map of animated sub-groups.
   */
  build(name, aoOpts) {
    const root = new THREE.Group();
    root.name = name;
    const groups = {};

    try {
      bakeAO(this.parts, aoOpts);
    } catch (err) {
      console.warn('[weapons] AO bake failed (continuing without it):', err);
    }

    // Bucket by group then material.
    const buckets = new Map();
    for (const p of this.parts) {
      const key = `${p.group ?? ''}|${p.material}`;
      let b = buckets.get(key);
      if (!b) { b = { group: p.group, material: p.material, geos: [] }; buckets.set(key, b); }
      b.geos.push(p.geometry);
    }

    let tris = 0;
    for (const b of buckets.values()) {
      let geo = null;
      try {
        geo = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
      } catch (err) {
        console.warn('[weapons] merge failed for', b.material, err);
        geo = b.geos[0];
      }
      if (!geo) continue;
      geo.computeBoundingSphere();
      tris += geo.attributes.position.count / 3;

      const mat = this.surfaces.get(b.material);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `${name}_${b.group ?? 'body'}_${b.material}`;
      mesh.frustumCulled = false;   // viewmodel is always on screen
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = true;

      if (b.group) {
        let g = groups[b.group];
        if (!g) {
          g = new THREE.Group();
          g.name = `${name}_${b.group}`;
          groups[b.group] = g;
          root.add(g);
        }
        g.add(mesh);
      } else {
        root.add(mesh);
      }
    }

    this.stats = { triangles: Math.round(tris), meshes: buckets.size };
    return { root, groups };
  }
}

export default PartBuilder;
