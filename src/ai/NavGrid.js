/**
 * OPERATION BLACKOUT — navigation.
 * OWNER: ai agent.
 *
 * There is no authored navmesh, because the level is procedural and owned by another
 * agent. So we build one: rasterise a grid over the level bounds, drop a ray on every
 * cell to find the floor, reject anything too steep or with no headroom, then flood
 * from the player's spawn so unreachable rooftops and voids never become path targets.
 *
 * On top of that:
 *   · A* over 8-connected cells with a corner-cut guard
 *   · string-pulled smoothing, so bots walk diagonals instead of staircases
 *   · a per-cell "exposure" field (how many of 8 compass directions are blocked
 *     within 3m) that the cover selector reads without any extra raycasting
 */
import * as THREE from 'three';

const WALK = 1;
const REACH = 2;

const NEI = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export class NavGrid {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.cell = opts.cell ?? 1.0;
    this.ready = false;
    this.w = 0; this.h = 0;
    this.minX = 0; this.minZ = 0;
    this.flags = null;
    this.height = null;
    this.exposure = null;
    this.walkableCells = [];

    this._open = null;
    this._gScore = null;
    this._came = null;
    this._stamp = null;
    this._epoch = 1;
    this._tmpPath = [];
  }

  /* ── construction ─────────────────────────────────────────────────────── */

  build(seedPoint) {
    const ctx = this.ctx;
    const phys = ctx.physics;
    if (!phys?.world) { console.warn('[ai] nav: no physics world; navigation disabled'); return false; }

    const box = new THREE.Box3();
    let found = false;
    const list = ctx.level?.collidables;
    if (Array.isArray(list)) {
      const tmp = new THREE.Box3();
      for (const o of list) {
        if (!o) continue;
        try {
          o.updateWorldMatrix(true, true);
          tmp.setFromObject(o);
          if (!Number.isFinite(tmp.min.x) || tmp.isEmpty()) continue;
          if (!found) { box.copy(tmp); found = true; } else box.union(tmp);
        } catch { /* degenerate mesh */ }
      }
    }
    if (!found) box.set(new THREE.Vector3(-30, -2, -30), new THREE.Vector3(30, 12, 30));

    // Clamp to something sane so a stray skybox mesh cannot make a 4000-cell grid.
    const cx = (box.min.x + box.max.x) * 0.5, cz = (box.min.z + box.max.z) * 0.5;
    const halfX = Math.min(90, Math.max(12, (box.max.x - box.min.x) * 0.5 + 2));
    const halfZ = Math.min(90, Math.max(12, (box.max.z - box.min.z) * 0.5 + 2));
    this.minX = cx - halfX; this.minZ = cz - halfZ;
    this.w = Math.max(4, Math.ceil((halfX * 2) / this.cell));
    this.h = Math.max(4, Math.ceil((halfZ * 2) / this.cell));

    // Keep the total cell count bounded regardless of level size.
    while (this.w * this.h > 26000) {
      this.cell *= 1.25;
      this.w = Math.max(4, Math.ceil((halfX * 2) / this.cell));
      this.h = Math.max(4, Math.ceil((halfZ * 2) / this.cell));
    }

    const n = this.w * this.h;
    this.flags = new Uint8Array(n);
    this.height = new Float32Array(n);
    this.exposure = new Uint8Array(n);
    this._gScore = new Float32Array(n);
    this._came = new Int32Array(n);
    this._stamp = new Int32Array(n);
    this._open = new Int32Array(n);

    const top = Math.min(box.max.y + 4, box.min.y + 60);
    const drop = Math.max(8, top - box.min.y + 6);
    const origin = new THREE.Vector3();
    const down = new THREE.Vector3(0, -1, 0);
    const up = new THREE.Vector3(0, 1, 0);

    let walk = 0;
    for (let z = 0; z < this.h; z++) {
      for (let x = 0; x < this.w; x++) {
        const i = z * this.w + x;
        const wx = this.minX + (x + 0.5) * this.cell;
        const wz = this.minZ + (z + 0.5) * this.cell;
        origin.set(wx, top, wz);
        const hit = phys.raycast(origin, down, drop, { group: 'PROJECTILE', mask: 1 /* WORLD */, reuse: true });
        if (!hit) { this.height[i] = NaN; continue; }
        const y = hit.point.y;
        if (hit.normal.y < 0.68) { this.height[i] = y; continue; }  // too steep to stand on
        this.height[i] = y;

        origin.set(wx, y + 0.35, wz);
        const clear = phys.raycast(origin, up, 1.55, { group: 'PROJECTILE', mask: 1, reuse: true });
        if (clear) continue;                                        // no headroom
        this.flags[i] = WALK;
        walk++;
      }
    }

    if (walk === 0) {
      console.warn('[ai] nav: no walkable cells found — bots will fall back to direct steering');
      this.ready = false;
      return false;
    }

    this._markReachable(seedPoint);
    this._computeExposure();

    this.walkableCells.length = 0;
    for (let i = 0; i < n; i++) if (this.flags[i] === (WALK | REACH)) this.walkableCells.push(i);
    // A flood that reaches almost nothing means the seed was stuck in a closet, not
    // that the map is one room. Fall back rather than confine the whole squad.
    if (this.walkableCells.length < Math.max(24, walk * 0.25)) {
      console.warn(`[ai] nav: reachable flood covered only ${this.walkableCells.length}/${walk} cells — accepting all walkables`);
      this.walkableCells.length = 0;
      for (let i = 0; i < n; i++) if (this.flags[i] & WALK) { this.flags[i] |= REACH; this.walkableCells.push(i); }
    }

    this.ready = true;
    console.info(`[ai] nav grid ${this.w}x${this.h} @${this.cell.toFixed(2)}m — ${this.walkableCells.length} walkable cells`);
    return true;
  }

  _markReachable(seedPoint) {
    const start = seedPoint ? this.cellAt(seedPoint.x, seedPoint.z) : -1;
    let seed = start;
    if (seed < 0 || !(this.flags[seed] & WALK)) {
      // nearest walkable to the seed, or just the first one
      let best = -1, bestD = Infinity;
      const sx = seedPoint ? seedPoint.x : 0, sz = seedPoint ? seedPoint.z : 0;
      for (let i = 0; i < this.flags.length; i++) {
        if (!(this.flags[i] & WALK)) continue;
        const x = this.minX + ((i % this.w) + 0.5) * this.cell;
        const z = this.minZ + (Math.floor(i / this.w) + 0.5) * this.cell;
        const d = (x - sx) * (x - sx) + (z - sz) * (z - sz);
        if (d < bestD) { bestD = d; best = i; }
      }
      seed = best;
    }
    if (seed < 0) return;

    const queue = new Int32Array(this.flags.length);
    let head = 0, tail = 0;
    queue[tail++] = seed;
    this.flags[seed] |= REACH;
    while (head < tail) {
      const i = queue[head++];
      const x = i % this.w, z = (i / this.w) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + NEI[k][0], nz = z + NEI[k][1];
        if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) continue;
        const j = nz * this.w + nx;
        if (this.flags[j] !== WALK) continue;
        if (Math.abs(this.height[j] - this.height[i]) > 0.55) continue;   // no teleporting up walls
        this.flags[j] |= REACH;
        queue[tail++] = j;
      }
    }
  }

  _computeExposure() {
    const r = Math.max(1, Math.round(2.6 / this.cell));
    for (let z = 0; z < this.h; z++) {
      for (let x = 0; x < this.w; x++) {
        const i = z * this.w + x;
        if (!(this.flags[i] & WALK)) continue;
        let blocked = 0;
        for (let k = 0; k < 8; k++) {
          const nx = x + NEI[k][0] * r, nz = z + NEI[k][1] * r;
          if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) { blocked++; continue; }
          const j = nz * this.w + nx;
          if (!(this.flags[j] & WALK) || this.height[j] - this.height[i] > 0.8) blocked++;
        }
        this.exposure[i] = blocked;
      }
    }
  }

  /* ── queries ──────────────────────────────────────────────────────────── */

  cellAt(x, z) {
    if (!this.ready && !this.flags) return -1;
    const cx = Math.floor((x - this.minX) / this.cell);
    const cz = Math.floor((z - this.minZ) / this.cell);
    if (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h) return -1;
    return cz * this.w + cx;
  }

  cellCentre(i, out) {
    out.set(
      this.minX + ((i % this.w) + 0.5) * this.cell,
      this.height[i] || 0,
      this.minZ + (Math.floor(i / this.w) + 0.5) * this.cell,
    );
    return out;
  }

  /**
   * Walkable AND connected to the seed. Requiring REACH is what stops a bot being
   * routed onto a 16m roof it can never actually get to — the raycast finds a flat
   * standable surface up there, but nothing joins it to the yard.
   */
  isWalkable(i) { return i >= 0 && (this.flags[i] & REACH) !== 0; }

  groundAt(x, z, fallback = 0) {
    const i = this.cellAt(x, z);
    if (i < 0) return fallback;
    const y = this.height[i];
    return Number.isFinite(y) ? y : fallback;
  }

  /** Nearest reachable cell to a world point, searched in expanding rings. */
  nearestWalkable(x, z, maxRings = 8) {
    const cx = Math.floor((x - this.minX) / this.cell);
    const cz = Math.floor((z - this.minZ) / this.cell);
    for (let r = 0; r <= maxRings; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) continue;
          const i = nz * this.w + nx;
          if (this.flags[i] & REACH) return i;
        }
      }
    }
    return -1;
  }

  randomWalkable(rng, awayFrom = null, minDist = 0) {
    const list = this.walkableCells;
    if (!list.length) return -1;
    const tries = minDist > 0 ? 24 : 1;
    let fallback = list[(rng() * list.length) | 0];
    for (let t = 0; t < tries; t++) {
      const i = list[(rng() * list.length) | 0];
      if (!awayFrom) return i;
      const x = this.minX + ((i % this.w) + 0.5) * this.cell;
      const z = this.minZ + (Math.floor(i / this.w) + 0.5) * this.cell;
      const d = Math.hypot(x - awayFrom.x, z - awayFrom.z);
      if (d >= minDist) return i;
      fallback = i;
    }
    return fallback;
  }

  /** Grid line-of-walk: true if a straight run between two cells stays walkable. */
  lineWalkable(i0, i1) {
    let x0 = i0 % this.w, z0 = (i0 / this.w) | 0;
    const x1 = i1 % this.w, z1 = (i1 / this.w) | 0;
    const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
    let err = dx - dz;
    let guard = dx + dz + 4;
    let prevH = this.height[i0];
    while (guard-- > 0) {
      const i = z0 * this.w + x0;
      if (!(this.flags[i] & REACH)) return false;
      if (Math.abs(this.height[i] - prevH) > 0.55) return false;
      prevH = this.height[i];
      if (x0 === x1 && z0 === z1) return true;
      const e2 = err * 2;
      if (e2 > -dz) { err -= dz; x0 += sx; }
      if (e2 < dx) { err += dx; z0 += sz; }
      // reject squeezing through a diagonal gap between two blockers
      if (e2 > -dz && e2 < dx) {
        const a = z0 * this.w + (x0 - sx), b = (z0 - sz) * this.w + x0;
        if (!(this.flags[a] & REACH) && !(this.flags[b] & REACH)) return false;
      }
    }
    return false;
  }

  /**
   * A* between two world points. Writes smoothed waypoints into `outPath`
   * (an array of THREE.Vector3 that is reused). Returns true on success.
   */
  findPath(from, to, outPath, maxNodes = 2600) {
    outPath.length = 0;
    if (!this.ready) return false;
    let s = this.cellAt(from.x, from.z);
    if (!this.isWalkable(s)) s = this.nearestWalkable(from.x, from.z, 4);
    let g = this.cellAt(to.x, to.z);
    if (!this.isWalkable(g)) g = this.nearestWalkable(to.x, to.z, 6);
    if (s < 0 || g < 0) return false;
    if (s === g) { const v = new THREE.Vector3(); this.cellCentre(g, v); outPath.push(v); return true; }

    const epoch = ++this._epoch;
    const gScore = this._gScore, came = this._came, stamp = this._stamp;
    const open = this._open;
    let openLen = 0;

    const hOf = (i) => {
      const dx = Math.abs((i % this.w) - (g % this.w));
      const dz = Math.abs(((i / this.w) | 0) - ((g / this.w) | 0));
      return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };

    stamp[s] = epoch; gScore[s] = 0; came[s] = -1;
    open[openLen++] = s;
    const fScore = this._fTmp || (this._fTmp = new Float32Array(this.flags.length));
    fScore[s] = hOf(s);

    let expanded = 0;
    let goalFound = false;
    while (openLen > 0 && expanded < maxNodes) {
      // linear-scan pop; grids this size never make it worth a real heap
      let bi = 0, bf = fScore[open[0]];
      for (let k = 1; k < openLen; k++) { const f = fScore[open[k]]; if (f < bf) { bf = f; bi = k; } }
      const cur = open[bi];
      open[bi] = open[--openLen];
      if (cur === g) { goalFound = true; break; }
      expanded++;

      const cx = cur % this.w, cz = (cur / this.w) | 0;
      const ch = this.height[cur];
      for (let k = 0; k < 8; k++) {
        const nx = cx + NEI[k][0], nz = cz + NEI[k][1];
        if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) continue;
        const j = nz * this.w + nx;
        if (!(this.flags[j] & REACH)) continue;
        const dh = this.height[j] - ch;
        if (Math.abs(dh) > 0.55) continue;
        if (k >= 4) {
          const a = cz * this.w + nx, b = nz * this.w + cx;
          if (!(this.flags[a] & REACH) || !(this.flags[b] & REACH)) continue;
        }
        // Prefer hugging cover: cheaper to walk where the surroundings are blocked.
        const cost = NEI[k][2] + Math.abs(dh) * 1.4 - this.exposure[j] * 0.035;
        const tentative = gScore[cur] + cost;
        if (stamp[j] === epoch && tentative >= gScore[j]) continue;
        stamp[j] = epoch;
        gScore[j] = tentative;
        came[j] = cur;
        fScore[j] = tentative + hOf(j) * 1.06;      // mild weighting: fewer nodes, ~same path
        if (openLen < open.length) open[openLen++] = j;
      }
    }

    if (!goalFound && stamp[g] !== epoch) return false;

    const raw = this._tmpPath;
    raw.length = 0;
    let n = g, guard = 0;
    while (n >= 0 && guard++ < 4096) { raw.push(n); n = came[n]; }
    raw.reverse();

    // string pull
    const v = new THREE.Vector3();
    let anchor = 0;
    outPath.push(this.cellCentre(raw[0], new THREE.Vector3()));
    while (anchor < raw.length - 1) {
      let far = anchor + 1;
      for (let j = raw.length - 1; j > anchor; j--) {
        if (this.lineWalkable(raw[anchor], raw[j])) { far = j; break; }
      }
      outPath.push(this.cellCentre(raw[far], new THREE.Vector3()));
      anchor = far;
    }
    void v;
    return outPath.length > 0;
  }
}

export default NavGrid;
