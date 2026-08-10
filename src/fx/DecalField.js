import * as THREE from 'three';
import { ATLAS_GRID } from './textures.js';

/**
 * Real projected decals in ONE draw call.
 *
 * Every decal is a genuine box-projection of the target mesh's triangles,
 * clipped against the six planes of the projector volume — so a bullet hole
 * placed near a corner wraps around it instead of floating as a z-fighting
 * quad. three ships `examples/jsm/geometries/DecalGeometry.js`, which performs
 * the same clip, but it (a) walks *every* triangle of the target with no
 * spatial reject, (b) allocates a fresh BufferGeometry per decal, and therefore
 * (c) costs one draw call per bullet hole. At 750rpm that is unusable. This is
 * the same algorithm rewritten to write into a fixed pooled vertex arena.
 *
 * Storage: MAX_DECALS fixed-stride slots inside one non-indexed BufferGeometry.
 * Unused vertices in a slot are collapsed to the origin and given zero alpha, so
 * they rasterise nothing. Recycling is a ring; the oldest slot is stolen when
 * the pool saturates.
 *
 * Fading without transparency: the material is **opaque and alpha-tested**, so
 * decals live in the G-buffer and receive AO, SSR and TAA like real geometry
 * (per the Phase A note, transparent objects get none of that and shimmer). To
 * still fade them we drive a per-vertex alpha through `vertexColors` with a
 * vec4 colour attribute — three multiplies it into `diffuseColor.a` *before*
 * the alpha test, so lowering it erodes the decal inward from its soft edges.
 * It reads as the mark weathering away and needs no shader surgery at all.
 *
 * OWNER: fx
 */

const MAX_DECALS = 176;
const VERTS_PER_DECAL = 66;      // 22 triangles of clipped, wrapped geometry
const POLY_MAX = 24;
const SURFACE_EPS = 0.0016;      // metres pushed out along the surface normal

/* ── lazy per-geometry triangle grid ──────────────────────────────────────
 *
 * The level ships as ~30 merged meshes totalling 384k triangles. A linear scan
 * of a 100k-triangle mesh per bullet hole is 3-5 ms — at 750rpm that is a
 * permanent 5% of frame budget spent looking for triangles that are metres
 * away from the impact.
 *
 * So the first decal on a given geometry pays once to bucket every triangle
 * into a uniform grid by centroid (counting sort into two typed arrays, no
 * per-triangle objects). Triangles too large for a cell go into an overflow
 * list that is always scanned. After that a bullet hole touches ~20 triangles
 * instead of 100000, and the cost stops scaling with level size.
 */
const GRID_TARGET_CELLS = 24;      // per longest axis
const GRID_MAX_CELLS = 96 * 1024;

function buildTriGrid(geom) {
  const posA = geom.attributes.position;
  const index = geom.index;
  const pArr = posA.array;
  const iArr = index ? index.array : null;
  const triCount = index ? (index.count / 3) | 0 : (posA.count / 3) | 0;
  if (triCount <= 0) return null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < posA.count; v++) {
    const x = pArr[v * 3], y = pArr[v * 3 + 1], z = pArr[v * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return null;

  const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
  // Size cells off the *mean* extent, not the longest. A 100x6x100 perimeter
  // wall sized off its longest axis gets 4m cells and the grid stops filtering.
  let cell = Math.max(0.35, ((sx + sy + sz) / 3) / GRID_TARGET_CELLS);
  let nx = Math.max(1, Math.ceil(sx / cell));
  let ny = Math.max(1, Math.ceil(sy / cell));
  let nz = Math.max(1, Math.ceil(sz / cell));
  while (nx * ny * nz > GRID_MAX_CELLS) {
    cell *= 1.5;
    nx = Math.max(1, Math.ceil(sx / cell));
    ny = Math.max(1, Math.ceil(sy / cell));
    nz = Math.max(1, Math.ceil(sz / cell));
  }
  const cells = nx * ny * nz;

  const counts = new Int32Array(cells + 1);
  const cellOf = new Int32Array(triCount);
  const overflow = [];
  const bigLimit = cell * 1.5;

  for (let t = 0; t < triCount; t++) {
    const i0 = iArr ? iArr[t * 3] : t * 3;
    const i1 = iArr ? iArr[t * 3 + 1] : t * 3 + 1;
    const i2 = iArr ? iArr[t * 3 + 2] : t * 3 + 2;
    const ax = pArr[i0 * 3], ay = pArr[i0 * 3 + 1], az = pArr[i0 * 3 + 2];
    const bx = pArr[i1 * 3], by = pArr[i1 * 3 + 1], bz = pArr[i1 * 3 + 2];
    const cx = pArr[i2 * 3], cy = pArr[i2 * 3 + 1], cz = pArr[i2 * 3 + 2];
    const ex = Math.max(ax, bx, cx) - Math.min(ax, bx, cx);
    const ey = Math.max(ay, by, cy) - Math.min(ay, by, cy);
    const ez = Math.max(az, bz, cz) - Math.min(az, bz, cz);
    if (ex > bigLimit || ey > bigLimit || ez > bigLimit) {
      cellOf[t] = -1;
      overflow.push(t);
      continue;
    }
    const gx = Math.min(nx - 1, Math.max(0, ((ax + bx + cx) / 3 - minX) / cell | 0));
    const gy = Math.min(ny - 1, Math.max(0, ((ay + by + cy) / 3 - minY) / cell | 0));
    const gz = Math.min(nz - 1, Math.max(0, ((az + bz + cz) / 3 - minZ) / cell | 0));
    const ci = (gz * ny + gy) * nx + gx;
    cellOf[t] = ci;
    counts[ci + 1]++;
  }
  for (let i = 0; i < cells; i++) counts[i + 1] += counts[i];
  const starts = counts;                       // now a prefix-sum table
  const items = new Int32Array(triCount - overflow.length);
  const cursor = new Int32Array(cells);
  for (let t = 0; t < triCount; t++) {
    const ci = cellOf[t];
    if (ci < 0) continue;
    items[starts[ci] + cursor[ci]++] = t;
  }

  return {
    nx, ny, nz, cell, minX, minY, minZ,
    starts, items,
    overflow: Int32Array.from(overflow),
    triCount,
  };
}

function boxVolume(b) {
  return Math.max(1e-6, (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z));
}

function makePolyBuf(n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
  return a;
}
const _polyA = makePolyBuf(POLY_MAX);
const _polyB = makePolyBuf(POLY_MAX);

const FLAT_CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];

export class DecalField {
  constructor(ctx, atlases) {
    this.ctx = ctx;
    this.ok = false;

    const total = MAX_DECALS * VERTS_PER_DECAL;
    this.positions = new Float32Array(total * 3);
    this.normals = new Float32Array(total * 3);
    this.uvs = new Float32Array(total * 2);
    this.colors = new Float32Array(total * 4);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.nrmAttr = new THREE.BufferAttribute(this.normals, 3).setUsage(THREE.DynamicDrawUsage);
    this.uvAttr = new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', this.nrmAttr);
    geo.setAttribute('uv', this.uvAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    const mat = new THREE.MeshStandardMaterial({
      map: atlases?.albedo ?? null,
      normalMap: atlases?.normal ?? null,
      roughnessMap: atlases?.orm ?? null,
      metalnessMap: atlases?.orm ?? null,
      aoMap: atlases?.orm ?? null,
      aoMapIntensity: 1.0,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(1.4, 1.4),
      vertexColors: true,
      transparent: false,
      alphaTest: 0.42,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
      // Coplanar with the surface it was clipped from — this is what keeps it
      // out of a z-fight without visibly pushing it off the wall.
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -8,
      dithering: true,
    });
    mat.name = 'fx:decals';
    this.material = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'fx:decals';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;
    this.mesh.raycast = () => {};

    this.slots = new Array(MAX_DECALS);
    for (let i = 0; i < MAX_DECALS; i++) {
      this.slots[i] = { used: false, verts: 0, age: 0, life: 75, fade: 6, alpha: 1, serial: -1, tint: null };
    }
    this.serial = 0;
    this.next = 0;
    this.highWater = 0;
    this._geomDirty = false;
    this._colorDirty = false;
    this._fadeAcc = 0;
    this.projected = 0;
    this.flat = 0;

    /* ── instance scratch: nothing in the hot path allocates ── */
    this._targetM = new THREE.Matrix4();
    this._instM = new THREE.Matrix4();
    this._projM = new THREE.Matrix4();
    this._projInv = new THREE.Matrix4();
    this._objInv = new THREE.Matrix4();
    this._nrmM = new THREE.Matrix3();
    this._n = new THREE.Vector3();
    this._ax = new THREE.Vector3();
    this._ay = new THREE.Vector3();
    this._bx = new THREE.Vector3();
    this._by = new THREE.Vector3();
    this._org = new THREE.Vector3();
    this._t0 = new THREE.Vector3();
    this._t1 = new THREE.Vector3();
    this._box = new THREE.Box3();
    this._objBox = new THREE.Box3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._alt = new THREE.Vector3(1, 0, 0);
    this._tri = new Int32Array(3);
    this._cand = new Int32Array(24576);
    this._meshCache = [];
    this._targets = [];
    this._cacheAge = 1e9;
    this._pad = new THREE.Vector3(0.25, 0.25, 0.25);
    this.missReason = { noTarget: 0, noTris: 0 };
    // Populated on every projection — cheap, and the only way to tell a
    // "nothing was near the impact" miss from a "the clip rejected it" miss.
    this.dbg = { cand: 0, aabb: 0, facing: 0, clipped: 0, grid: 0, tris: 0 };

    this.ok = true;
  }

  attach(scene) {
    try { scene.add(this.mesh); } catch { /* scene missing — decals silently off */ }
  }

  get count() {
    let n = 0;
    for (let i = 0; i < MAX_DECALS; i++) if (this.slots[i].used) n++;
    return n;
  }

  /**
   * Collect candidate meshes for a decal at `point`, nearest/tightest first.
   *
   * Deliberately NOT a THREE.Raycaster: `Raycaster.intersectObject(scene, true)`
   * runs a full per-triangle test against every mesh whose bounds the ray
   * touches, and this level ships 77k-triangle merged meshes. One bullet hole
   * cost several milliseconds and a burst of impacts halved the framerate. A
   * world-space AABB test over the cached mesh list costs nothing, and the
   * triangle grid inside `_project` does the precise work anyway.
   */
  _pickTargets(point) {
    const out = this._targets;
    out.length = 0;
    const list = this._meshCache;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const b = e.box;
      if (point.x < b.min.x || point.x > b.max.x) continue;
      if (point.y < b.min.y || point.y > b.max.y) continue;
      if (point.z < b.min.z || point.z > b.max.z) continue;
      out.push(e);
      if (out.length >= 32) break;
    }
    // Tightest bounds first: a crate inside a warehouse should win over the
    // warehouse shell.
    out.sort((a, b) => a.volume - b.volume);
    if (out.length > 8) out.length = 8;
    return out;
  }

  /** Rebuild the eligible-mesh cache. Cheap; runs a few times a second at most. */
  refreshTargets() {
    const scene = this.ctx.scene;
    if (!scene) return;
    const list = this._meshCache;
    list.length = 0;
    const pad = this._pad;
    try {
      scene.traverse((o) => {
        if (list.length >= 1400) return;
        if (!o.visible) return;
        if (!o.isMesh && !o.isInstancedMesh) return;
        if (o === this.mesh || o.isSkinnedMesh) return;
        if (o.userData && (o.userData.isDebris || o.userData.noDecal)) return;
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (!m || m.transparent === true || m.depthWrite === false) return;
        const g = o.geometry;
        if (!g || !g.attributes || !g.attributes.position) return;
        if (!g.boundingBox) { try { g.computeBoundingBox(); } catch { return; } }
        if (!g.boundingBox) return;

        if (o.isInstancedMesh) {
          const n = Math.min(o.count ?? 0, 128);
          for (let i = 0; i < n && list.length < 1400; i++) {
            o.getMatrixAt(i, this._instM);
            const world = new THREE.Matrix4().multiplyMatrices(o.matrixWorld, this._instM);
            const box = g.boundingBox.clone().applyMatrix4(world).expandByVector(pad);
            list.push({ object: o, matrix: world, box, volume: boxVolume(box) });
          }
          return;
        }
        const box = g.boundingBox.clone().applyMatrix4(o.matrixWorld).expandByVector(pad);
        list.push({ object: o, matrix: o.matrixWorld.clone(), box, volume: boxVolume(box) });
      });
    } catch (err) {
      // A broken traversal must never stop the game marking bullet holes.
      if (!this._loggedScan) { this._loggedScan = true; console.warn('[fx] decal target scan:', err); }
    }
    this._cacheAge = 0;
  }

  /**
   * Project a decal onto whatever geometry is under `point`.
   *
   * @param {THREE.Vector3} point   world-space impact point
   * @param {THREE.Vector3} normal  world-space surface normal (unit)
   * @param {number} size           world-space width/height in metres
   * @param {number} tile           atlas tile index 0..15
   * @param {object} opts           { depth, roll, life, fade, tint:[r,g,b], alpha }
   * @returns {boolean} true if real conforming geometry was produced
   */
  add(point, normal, size, tile, opts = {}) {
    if (!this.ok) return false;

    const n = this._n.copy(normal);
    if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
    n.normalize();

    let targets = null;
    try { targets = this._pickTargets(point); } catch { targets = null; }

    const slot = this._acquire();
    if (slot < 0) return false;

    // Generous depth. The physics collider and the rendered mesh are not always
    // bit-identical (merged/welded level geometry drifts by a few centimetres),
    // and a shallow projector simply misses the wall it is supposed to mark.
    const depth = opts.depth ?? Math.max(0.36, size * 2.4);
    const roll = opts.roll ?? Math.random() * Math.PI * 2;

    // Projector basis. +Z is the surface normal; the box spans ±depth/2 along it.
    const upRef = Math.abs(n.y) > 0.94 ? this._alt : this._up;
    this._bx.crossVectors(upRef, n).normalize();
    this._by.crossVectors(n, this._bx).normalize();
    const cr = Math.cos(roll), sr = Math.sin(roll);
    this._ax.copy(this._bx).multiplyScalar(cr).addScaledVector(this._by, sr).normalize();
    this._ay.copy(this._by).multiplyScalar(cr).addScaledVector(this._bx, -sr).normalize();

    this._org.copy(point).addScaledVector(n, depth * 0.5);
    this._projM.makeBasis(this._ax, this._ay, n);
    this._projM.setPosition(this._org);
    this._projInv.copy(this._projM).invert();

    const hx = size * 0.5, hy = size * 0.5, hz = depth * 0.5;

    let verts = 0;
    if (targets && targets.length) {
      // Two passes. The first uses the authored depth, which keeps the decal
      // off any surface lurking behind the one that was hit. If nothing at all
      // was found, the collider and the render mesh have drifted apart (merged
      // level geometry does this), so widen the slab and try again rather than
      // give up and stamp an unprojected quad.
      for (let pass = 0; pass < 2 && verts === 0; pass++) {
        const dz = pass === 0 ? hz : Math.min(0.85, hz * 4.0);
        for (let i = 0; i < targets.length && verts === 0; i++) {
          this._targetM.copy(targets[i].matrix);
          try { verts = this._project(targets[i].object, hx, hy, dz, slot, tile); }
          catch { verts = 0; }
        }
      }
    }
    const conformed = verts > 0;
    if (!conformed && (!targets || targets.length === 0)) {
      // No mesh anywhere near the point. Laying down a flat patch here would
      // hang a decal in mid-air, which is far worse than no decal at all.
      this.missReason.noTarget++;
      this.slots[slot].used = false;
      return false;
    }
    if (!conformed) {
      this.missReason.noTris++;
      // Degradation path: nothing to clip against (instanced oddity, ray miss).
      // Lay down a flat patch so the shot still marks the world.
      verts = this._flatPatch(point, n, hx, hy, slot, tile);
      this.flat++;
    } else {
      this.projected++;
    }
    if (verts === 0) { this.slots[slot].used = false; return false; }

    // Collapse the unused tail of the slot so no stale triangle survives.
    const base = slot * VERTS_PER_DECAL;
    if (verts < VERTS_PER_DECAL) {
      this.positions.fill(0, (base + verts) * 3, (base + VERTS_PER_DECAL) * 3);
    }

    const s = this.slots[slot];
    s.used = true;
    s.verts = verts;
    s.age = 0;
    s.life = opts.life ?? 75;
    s.fade = opts.fade ?? 6;
    s.alpha = opts.alpha ?? 1;
    s.serial = this.serial++;
    s.tint = opts.tint || null;

    this._writeColors(slot);
    if (slot + 1 > this.highWater) {
      this.highWater = slot + 1;
      this.geometry.setDrawRange(0, this.highWater * VERTS_PER_DECAL);
    }
    this._geomDirty = true;
    this._colorDirty = true;
    return conformed;
  }

  _acquire() {
    for (let k = 0; k < MAX_DECALS; k++) {
      const i = (this.next + k) % MAX_DECALS;
      if (!this.slots[i].used) { this.next = (i + 1) % MAX_DECALS; return i; }
    }
    let oldest = -1, best = Infinity;
    for (let i = 0; i < MAX_DECALS; i++) {
      if (this.slots[i].serial < best) { best = this.slots[i].serial; oldest = i; }
    }
    if (oldest < 0) return -1;
    this._clearSlot(oldest);
    this.next = (oldest + 1) % MAX_DECALS;
    return oldest;
  }

  _clearSlot(i) {
    const s = this.slots[i];
    s.used = false;
    s.verts = 0;
    s.tint = null;
    const base = i * VERTS_PER_DECAL;
    this.positions.fill(0, base * 3, (base + VERTS_PER_DECAL) * 3);
    this.colors.fill(0, base * 4, (base + VERTS_PER_DECAL) * 4);
    this._geomDirty = true;
    this._colorDirty = true;
  }

  /**
   * Clip the target's triangles against the projector box, emitting world-space
   * geometry into the slot. Returns the vertex count written.
   */
  _project(target, hx, hy, hz, slot, tile) {
    const geom = target.geometry;
    const posA = geom.attributes.position;
    const nrmA = geom.attributes.normal || null;
    const index = geom.index;
    const triCount = index ? (index.count / 3) | 0 : (posA.count / 3) | 0;
    if (triCount <= 0) return 0;

    const world = this._targetM;
    this._nrmM.getNormalMatrix(world);

    // World AABB of the projector volume, then the same box in the target's own
    // object space — the cheap spatial reject that makes this affordable on a
    // 40k-triangle level mesh.
    this._box.makeEmpty();
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          this._t0.set(sx * hx, sy * hy, sz * hz).applyMatrix4(this._projM);
          this._box.expandByPoint(this._t0);
        }
      }
    }
    this._objInv.copy(world).invert();
    this._objBox.copy(this._box).applyMatrix4(this._objInv);
    const bmin = this._objBox.min, bmax = this._objBox.max;

    const pArr = posA.array;
    const nArr = nrmA ? nrmA.array : null;
    const iArr = index ? index.array : null;

    const base = slot * VERTS_PER_DECAL;
    let out = 0;

    const A = _polyA, B = _polyB;
    const iv = this._projInv.elements;
    const pe = this._projM.elements;
    const pnx = pe[8], pny = pe[9], pnz = pe[10];   // projector +Z in world space

    // Candidate list: the grid for anything big enough to be worth indexing,
    // a straight scan for small meshes where building the grid costs more than
    // the scan it saves.
    let cand = null, candCount = triCount;
    if (triCount > 2048) {
      let grid = geom.userData.__fxTriGrid;
      if (grid === undefined) {
        try { grid = buildTriGrid(geom); } catch { grid = null; }
        geom.userData.__fxTriGrid = grid;
      }
      if (grid) {
        candCount = this._gather(grid, bmin, bmax);
        cand = this._cand;
        this.dbg.grid = 1;
        if (candCount === 0) { this.dbg.cand = 0; return 0; }
      }
    }
    this.dbg.cand = candCount;
    this.dbg.tris = triCount;
    this.dbg.aabb = 0; this.dbg.facing = 0; this.dbg.clipped = 0;

    for (let ci = 0; ci < candCount; ci++) {
      const t = cand ? cand[ci] : ci;
      const i0 = iArr ? iArr[t * 3] : t * 3;
      const i1 = iArr ? iArr[t * 3 + 1] : t * 3 + 1;
      const i2 = iArr ? iArr[t * 3 + 2] : t * 3 + 2;

      const ax = pArr[i0 * 3], ay = pArr[i0 * 3 + 1], az = pArr[i0 * 3 + 2];
      const bx = pArr[i1 * 3], by = pArr[i1 * 3 + 1], bz = pArr[i1 * 3 + 2];
      const cx = pArr[i2 * 3], cy = pArr[i2 * 3 + 1], cz = pArr[i2 * 3 + 2];

      if (Math.min(ax, bx, cx) > bmax.x || Math.max(ax, bx, cx) < bmin.x) continue;
      if (Math.min(ay, by, cy) > bmax.y || Math.max(ay, by, cy) < bmin.y) continue;
      if (Math.min(az, bz, cz) > bmax.z || Math.max(az, bz, cz) < bmin.z) continue;
      this.dbg.aabb++;

      const idx = this._tri;
      idx[0] = i0; idx[1] = i1; idx[2] = i2;
      let sumNx = 0, sumNy = 0, sumNz = 0;
      for (let k = 0; k < 3; k++) {
        const vi = idx[k];
        this._t0.set(pArr[vi * 3], pArr[vi * 3 + 1], pArr[vi * 3 + 2]).applyMatrix4(world);
        if (nArr) {
          this._t1.set(nArr[vi * 3], nArr[vi * 3 + 1], nArr[vi * 3 + 2])
            .applyMatrix3(this._nrmM).normalize();
        } else {
          this._t1.set(pnx, pny, pnz);
        }
        const p = A[k];
        p.nx = this._t1.x; p.ny = this._t1.y; p.nz = this._t1.z;
        sumNx += p.nx; sumNy += p.ny; sumNz += p.nz;
        const wx = this._t0.x, wy = this._t0.y, wz = this._t0.z;
        p.x = iv[0] * wx + iv[4] * wy + iv[8] * wz + iv[12];
        p.y = iv[1] * wx + iv[5] * wy + iv[9] * wz + iv[13];
        p.z = iv[2] * wx + iv[6] * wy + iv[10] * wz + iv[14];
      }

      // Grazing / back faces never take the decal — this is what stops a hole
      // punching through to the far side of a thin wall.
      const facing = (sumNx * pnx + sumNy * pny + sumNz * pnz) / 3;
      if (facing < 0.12) continue;
      this.dbg.facing++;

      let cnt = 3;
      cnt = clipAxis(A, cnt, B, 0, hx, true); if (cnt < 3) continue;
      cnt = clipAxis(B, cnt, A, 0, hx, false); if (cnt < 3) continue;
      cnt = clipAxis(A, cnt, B, 1, hy, true); if (cnt < 3) continue;
      cnt = clipAxis(B, cnt, A, 1, hy, false); if (cnt < 3) continue;
      cnt = clipAxis(A, cnt, B, 2, hz, true); if (cnt < 3) continue;
      cnt = clipAxis(B, cnt, A, 2, hz, false); if (cnt < 3) continue;
      this.dbg.clipped++;

      for (let f = 1; f + 1 < cnt; f++) {
        if (out + 3 > VERTS_PER_DECAL) return out;
        this._emit(base + out, A[0], hx, hy, tile); out++;
        this._emit(base + out, A[f], hx, hy, tile); out++;
        this._emit(base + out, A[f + 1], hx, hy, tile); out++;
      }
    }
    return out;
  }

  /** Fill `this._cand` with triangle indices whose cell overlaps the box. */
  _gather(grid, bmin, bmax) {
    const { nx, ny, nz, cell, minX, minY, minZ, starts, items, overflow } = grid;
    const x0 = Math.max(0, Math.min(nx - 1, Math.floor((bmin.x - minX) / cell)));
    const x1 = Math.max(0, Math.min(nx - 1, Math.floor((bmax.x - minX) / cell)));
    const y0 = Math.max(0, Math.min(ny - 1, Math.floor((bmin.y - minY) / cell)));
    const y1 = Math.max(0, Math.min(ny - 1, Math.floor((bmax.y - minY) / cell)));
    const z0 = Math.max(0, Math.min(nz - 1, Math.floor((bmin.z - minZ) / cell)));
    const z1 = Math.max(0, Math.min(nz - 1, Math.floor((bmax.z - minZ) / cell)));

    const out = this._cand;
    const cap = out.length;
    let n = 0;

    // One cell of slop each way: triangles are bucketed by centroid, so one
    // straddling a boundary can live in the neighbouring cell.
    const cx0 = Math.max(0, x0 - 1), cx1 = Math.min(nx - 1, x1 + 1);
    for (let z = Math.max(0, z0 - 1); z <= Math.min(nz - 1, z1 + 1); z++) {
      for (let y = Math.max(0, y0 - 1); y <= Math.min(ny - 1, y1 + 1); y++) {
        const rowBase = (z * ny + y) * nx;
        const s = starts[rowBase + cx0];
        const e = starts[rowBase + cx1 + 1];
        for (let i = s; i < e && n < cap; i++) out[n++] = items[i];
      }
    }
    for (let i = 0; i < overflow.length && n < cap; i++) out[n++] = overflow[i];
    return n;
  }

  _emit(vi, p, hx, hy, tile) {
    this._t0.set(p.x, p.y, p.z).applyMatrix4(this._projM);
    const p3 = vi * 3;
    this.positions[p3] = this._t0.x + p.nx * SURFACE_EPS;
    this.positions[p3 + 1] = this._t0.y + p.ny * SURFACE_EPS;
    this.positions[p3 + 2] = this._t0.z + p.nz * SURFACE_EPS;
    this.normals[p3] = p.nx;
    this.normals[p3 + 1] = p.ny;
    this.normals[p3 + 2] = p.nz;

    // Atlas UV baked straight into the attribute — that is what lets 16 decal
    // looks share one texture, and therefore one draw call.
    const col = tile % ATLAS_GRID;
    const row = Math.floor(tile / ATLAS_GRID);
    let lu = 0.5 + p.x / (hx * 2);
    let lv = 0.5 + p.y / (hy * 2);
    lu = lu < 0 ? 0 : lu > 1 ? 1 : lu;
    lv = lv < 0 ? 0 : lv > 1 ? 1 : lv;
    const p2 = vi * 2;
    this.uvs[p2] = (col + lu) / ATLAS_GRID;
    this.uvs[p2 + 1] = (row + lv) / ATLAS_GRID;
  }

  /** Fallback: an unprojected quad, used only when projection found nothing. */
  _flatPatch(point, n, hx, hy, slot, tile) {
    const base = slot * VERTS_PER_DECAL;
    const col = tile % ATLAS_GRID;
    const row = Math.floor(tile / ATLAS_GRID);
    for (let k = 0; k < 6; k++) {
      const c = FLAT_CORNERS[k];
      const vi = base + k;
      const p3 = vi * 3;
      this.positions[p3] = point.x + this._ax.x * c[0] * hx + this._ay.x * c[1] * hy + n.x * 0.004;
      this.positions[p3 + 1] = point.y + this._ax.y * c[0] * hx + this._ay.y * c[1] * hy + n.y * 0.004;
      this.positions[p3 + 2] = point.z + this._ax.z * c[0] * hx + this._ay.z * c[1] * hy + n.z * 0.004;
      this.normals[p3] = n.x; this.normals[p3 + 1] = n.y; this.normals[p3 + 2] = n.z;
      const p2 = vi * 2;
      this.uvs[p2] = (col + (c[0] * 0.5 + 0.5)) / ATLAS_GRID;
      this.uvs[p2 + 1] = (row + (c[1] * 0.5 + 0.5)) / ATLAS_GRID;
    }
    return 6;
  }

  _writeColors(slot) {
    const s = this.slots[slot];
    const base = slot * VERTS_PER_DECAL;
    const tint = s.tint;
    const r = tint ? tint[0] : 1, g = tint ? tint[1] : 1, b = tint ? tint[2] : 1;
    const a = s.alpha;
    for (let k = 0; k < VERTS_PER_DECAL; k++) {
      const o = (base + k) * 4;
      if (k < s.verts) {
        this.colors[o] = r; this.colors[o + 1] = g; this.colors[o + 2] = b; this.colors[o + 3] = a;
      } else {
        this.colors[o] = 0; this.colors[o + 1] = 0; this.colors[o + 2] = 0; this.colors[o + 3] = 0;
      }
    }
  }

  update(dt) {
    // The level is static but props, doors and destructibles are not, so the
    // candidate cache is rebuilt on a slow cadence rather than assumed forever.
    this._cacheAge += dt;
    if (this._cacheAge > 2.0) this.refreshTargets();

    this._fadeAcc += dt;
    if (this._fadeAcc >= 0.28) {
      const step = this._fadeAcc;
      this._fadeAcc = 0;
      let touched = false;
      for (let i = 0; i < MAX_DECALS; i++) {
        const s = this.slots[i];
        if (!s.used) continue;
        s.age += step;
        const remain = s.life - s.age;
        if (remain <= 0) { this._clearSlot(i); touched = true; continue; }
        const want = remain < s.fade ? Math.max(0, remain / s.fade) : 1;
        if (Math.abs(want - s.alpha) > 0.004) {
          s.alpha = want;
          this._writeColors(i);
          touched = true;
        }
      }
      if (touched) this._colorDirty = true;
    }

    if (this._geomDirty) {
      this.posAttr.needsUpdate = true;
      this.nrmAttr.needsUpdate = true;
      this.uvAttr.needsUpdate = true;
      this._geomDirty = false;
    }
    if (this._colorDirty) {
      this.colAttr.needsUpdate = true;
      this._colorDirty = false;
    }
  }

  clear() {
    for (let i = 0; i < MAX_DECALS; i++) if (this.slots[i].used) this._clearSlot(i);
    this.highWater = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose() {
    try { this.mesh.parent?.remove(this.mesh); } catch { /* noop */ }
    try { this.geometry.dispose(); } catch { /* noop */ }
    try { this.material.dispose(); } catch { /* noop */ }
  }
}

/**
 * Sutherland–Hodgman clip of a convex polygon against one slab plane.
 * `positive` selects `axis <= lim` vs `axis >= -lim`. Interpolates the normal.
 * No closures, no allocation — this runs a few thousand times per shot.
 */
function clipAxis(src, count, dst, axis, lim, positive) {
  let out = 0;
  for (let i = 0; i < count; i++) {
    const cur = src[i];
    const nxt = src[(i + 1) % count];
    const cv = axis === 0 ? cur.x : axis === 1 ? cur.y : cur.z;
    const nv = axis === 0 ? nxt.x : axis === 1 ? nxt.y : nxt.z;
    const d0 = positive ? lim - cv : cv + lim;
    const d1 = positive ? lim - nv : nv + lim;
    const ci = d0 >= 0;
    const ni = d1 >= 0;

    if (ci) {
      if (out >= POLY_MAX) return out;
      const b = dst[out++];
      b.x = cur.x; b.y = cur.y; b.z = cur.z;
      b.nx = cur.nx; b.ny = cur.ny; b.nz = cur.nz;
    }
    if (ci !== ni) {
      const den = d0 - d1;
      if (Math.abs(den) < 1e-12) continue;
      const s = d0 / den;
      if (out >= POLY_MAX) return out;
      const o = dst[out++];
      o.x = cur.x + (nxt.x - cur.x) * s;
      o.y = cur.y + (nxt.y - cur.y) * s;
      o.z = cur.z + (nxt.z - cur.z) * s;
      o.nx = cur.nx + (nxt.nx - cur.nx) * s;
      o.ny = cur.ny + (nxt.ny - cur.ny) * s;
      o.nz = cur.nz + (nxt.nz - cur.nz) * s;
      const l = Math.sqrt(o.nx * o.nx + o.ny * o.ny + o.nz * o.nz) || 1;
      o.nx /= l; o.ny /= l; o.nz /= l;
    }
  }
  return out;
}

export { MAX_DECALS, VERTS_PER_DECAL };
export default DecalField;
