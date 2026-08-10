import * as THREE from 'three';

/**
 * Named camera vantage points for the screenshot harness.
 *
 * The critic agent shoots the same five framings every iteration, so they have
 * to be *stable* and they have to *show off the map*. Hard-coding coordinates
 * would break the moment the level agent moves a building, so instead we survey
 * the level once with raycasts and derive the poses from what is actually there:
 *
 *   spawn      — the real spawn point, facing the most interesting direction
 *   overwatch  — elevated, looking down across the whole playspace
 *   warehouse  — the most enclosed standable spot (interiors + practicals)
 *   lane       — the longest unbroken sightline on the map, shot down its length
 *   closeup    — 2–4m from a large surface, for material scrutiny
 *
 * If the level publishes its own `poses` table we prefer that; the survey is the
 * fallback that guarantees the harness always gets something usable.
 *
 * OWNER: player agent.
 */

const YAW_SAMPLES = 16;
const GRID = 9;

export class Poses {
  constructor(player) {
    this.player = player;
    this.ctx = player.ctx;
    this._survey = null;
    this._bounds = null;
  }

  names() { return ['spawn', 'overwatch', 'warehouse', 'lane', 'closeup']; }

  /**
   * Best facing for an ARBITRARY standing position — used on boot and on every
   * respawn, where the spawn point is chosen at random from the level's list.
   * resolve('spawn') deliberately evaluates spawnPoints[0] so the harness gets a
   * reproducible framing; using that yaw at a randomly-chosen spawn would aim
   * the camera using sightlines measured somewhere else entirely.
   *
   * @returns {{yaw:number, pitch:number}}
   */
  viewAt(position) {
    const eyeH = this.player.eyeHeightStanding;
    TMP_EYE.set(position.x, position.y + eyeH, position.z);
    const v = this._bestView(TMP_EYE, 'depth');
    return { yaw: v.yaw, pitch: v.pitch };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Level survey
  // ───────────────────────────────────────────────────────────────────────────

  _levelBounds() {
    if (this._bounds) return this._bounds;
    const box = new THREE.Box3();
    let any = false;

    const list = this.ctx.level?.collidables;
    if (Array.isArray(list) && list.length) {
      const tmp = new THREE.Box3();
      for (const o of list) {
        if (!o || !o.isObject3D) continue;
        try {
          tmp.setFromObject(o);
          if (tmp.isEmpty()) continue;
          if (!Number.isFinite(tmp.min.x) || !Number.isFinite(tmp.max.x)) continue;
          box.union(tmp);
          any = true;
        } catch { /* skip degenerate object */ }
      }
    }

    if (!any) {
      box.set(new THREE.Vector3(-30, -1, -30), new THREE.Vector3(30, 8, 30));
    }

    // A skybox or ground slab can be enormous; clamp the horizontal extent so
    // the sample grid stays over the playable area rather than out in the void.
    // Vertical extent must NOT be clamped the same way — the true floor and
    // roof heights are what 'overwatch' decides its altitude from, and clamping
    // them to a minimum of 3m made a flat map look 3.5m "tall" and cancelled
    // the elevated shot entirely.
    const centre = box.getCenter(new THREE.Vector3());
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const trueMinY = box.min.y;
    const trueMaxY = box.max.y;
    half.x = THREE.MathUtils.clamp(half.x, 8, 60);
    half.z = THREE.MathUtils.clamp(half.z, 8, 60);
    half.y = THREE.MathUtils.clamp(half.y, 1, 40);

    this._bounds = {
      centre,
      half,
      // Sampling range: generous, so a raised walkway is still found.
      minY: Math.max(trueMinY, centre.y - 45),
      maxY: Math.min(trueMaxY, centre.y + 45),
      trueMinY,
      trueMaxY,
    };
    return this._bounds;
  }

  /** Raycast down onto the level. Returns ground Y or null. */
  _groundAt(x, z, fromY) {
    const physics = this.ctx.physics;
    if (!physics?.world) return null;
    const from = new THREE.Vector3(x, fromY, z);
    const hit = physics.raycast(from, DOWN, fromY - (this._levelBounds().minY - 6), {
      group: 'PROJECTILE',
      mask: physics.GROUPS?.WORLD ?? 0x0001,
      exclude: this.player.movement?.collider ?? undefined,
    });
    return hit ? hit.point.y : null;
  }

  /** Distance to the first wall along a yaw, from a given eye point. */
  _sightline(eye, yaw, max = 70) {
    return this._cast(eye, yaw, 0, max).dist;
  }

  /**
   * Horizontal cast from `eye` raised by `dy`, returning both the distance and
   * the height of whatever it struck.
   */
  _cast(eye, yaw, dy = 0, max = 70) {
    const physics = this.ctx.physics;
    if (!physics?.world) return { dist: max, y: eye.y + dy };
    DIR.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    TMP_FROM.set(eye.x, eye.y + dy, eye.z);
    const hit = physics.raycast(TMP_FROM, DIR, max, {
      group: 'PROJECTILE',
      mask: physics.GROUPS?.WORLD ?? 0x0001,
      exclude: this.player.movement?.collider ?? undefined,
      reuse: true,
    });
    return hit ? { dist: hit.distance, y: hit.point.y } : { dist: max, y: eye.y + dy };
  }

  /**
   * Vertical profile of the view along a yaw: what is in front of the camera at
   * knee, eye and overhead height.
   *
   * A single eye-height ray cannot tell an open corridor from a waist-high wall
   * two metres away — both report "clear to 40m". That is exactly how the first
   * pass at these poses ended up framing a shadowed container across the bottom
   * 40% of two of the five shots.
   */
  _probe(eye, yaw, max = 70) {
    const low = this._cast(eye, yaw, -1.05, max);
    const mid = this._cast(eye, yaw, 0, max);
    const high = this._cast(eye, yaw, 0.75, max);
    return { low: low.dist, mid: mid.dist, high: high.dist, midY: mid.y, lowY: low.y };
  }

  /** True if the sky is visible straight up — used to tell inside from outside. */
  _hasRoof(eye) {
    const physics = this.ctx.physics;
    if (!physics?.world) return false;
    const hit = physics.raycast(eye, UP, 26, {
      group: 'PROJECTILE',
      mask: physics.GROUPS?.WORLD ?? 0x0001,
      exclude: this.player.movement?.collider ?? undefined,
      reuse: true,
    });
    return !!hit;
  }

  /**
   * One-off scan: a GRID×GRID lattice of standable points, each with a
   * 16-direction sightline profile. ~1400 raycasts, a couple of milliseconds,
   * run lazily on the first setPose() call and cached forever after.
   */
  survey() {
    if (this._survey) return this._survey;
    const b = this._levelBounds();
    const eyeH = this.player.eyeHeightStanding;
    const points = [];

    const castFromY = b.maxY + 4;
    for (let ix = 0; ix < GRID; ix++) {
      for (let iz = 0; iz < GRID; iz++) {
        const fx = (ix + 0.5) / GRID, fz = (iz + 0.5) / GRID;
        const x = b.centre.x + (fx * 2 - 1) * b.half.x * 0.88;
        const z = b.centre.z + (fz * 2 - 1) * b.half.z * 0.88;
        const gy = this._groundAt(x, z, castFromY);
        if (gy === null) continue;
        if (gy < b.minY - 2 || gy > b.maxY) continue;

        const eye = new THREE.Vector3(x, gy + eyeH, z);
        const sight = new Float32Array(YAW_SAMPLES);
        let openness = 0, longest = 0, longestYaw = 0, shortest = 999;
        for (let i = 0; i < YAW_SAMPLES; i++) {
          const yaw = (i / YAW_SAMPLES) * Math.PI * 2;
          const d = this._sightline(eye, yaw);
          sight[i] = d;
          openness += d;
          if (d > longest) { longest = d; longestYaw = yaw; }
          if (d < shortest) shortest = d;
        }
        openness /= YAW_SAMPLES;
        // Discard points wedged inside geometry.
        if (shortest < 0.55) continue;

        points.push({
          pos: new THREE.Vector3(x, gy, z),
          eye,
          sight,
          openness,
          longest,
          longestYaw,
          shortest,
          roofed: this._hasRoof(eye),
          groundY: gy,
        });
      }
    }

    this._survey = { bounds: b, points };
    if (points.length === 0) {
      console.warn('[player] level survey found no standable ground — poses will use spawn points only');
    }
    return this._survey;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Pose scoring helpers
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 1 at the middle of the playspace, 0 at its edge. Used purely as a tie-break:
   * on a featureless map every sample point scores identically and whichever one
   * the loop happened to visit last wins — which parked all five poses in the
   * same corner. Weighting toward the centre keeps the framings sane no matter
   * how sparse the geometry is.
   */
  _centrality(p, b) {
    const nx = (p.pos.x - b.centre.x) / Math.max(1e-3, b.half.x);
    const nz = (p.pos.z - b.centre.z) / Math.max(1e-3, b.half.z);
    return THREE.MathUtils.clamp(1 - Math.hypot(nx, nz) / 1.414, 0, 1);
  }

  /**
   * Pick the yaw AND pitch at `eye` that frame the most content.
   *
   * Pitch is derived, never a constant: a fixed downward tilt that reads well in
   * the open puts a ceiling across the top of the frame indoors, and a fixed
   * level aim wastes half the frame on sky from a rooftop. Both are decided from
   * what the rays actually hit.
   *
   * @returns {{yaw:number, pitch:number, dist:number}}
   */
  _bestView(eye, mode = 'depth') {
    let best = { yaw: this.player.yaw, pitch: -0.05, dist: 20 };
    let bestScore = -Infinity;
    const N = YAW_SAMPLES * 2;

    for (let i = 0; i < N; i++) {
      const yaw = (i / N) * Math.PI * 2;
      const p = this._probe(eye, yaw);
      const dl = this._sightline(eye, yaw - 0.32);
      const dr = this._sightline(eye, yaw + 0.32);

      // A near obstacle below the sightline is the single most damaging thing
      // to a framing — it becomes an unlit slab across the bottom of the shot.
      const lowBlock = p.low < 3.2 ? (3.2 - p.low) * 6.0 : 0;

      let score;
      if (mode === 'close') {
        // Want a real surface 2–4.5m out at chest height, filling the frame.
        const subject = Math.min(p.low, p.mid);
        score = -Math.abs(subject - 3.2) * 4.0 + Math.min(dl, 20) * 0.06 + Math.min(dr, 20) * 0.06;
      } else if (mode === 'lane') {
        // A genuine corridor: open at BOTH knee and eye height, with the flanks
        // closer than the centre so the frame has walls to lead the eye down.
        const corridor = Math.min(p.mid, p.low);
        score = Math.min(corridor, 70)
          - Math.max(0, dl - p.mid) * 0.35
          - Math.max(0, dr - p.mid) * 0.35;
      } else {
        const depth = Math.min(p.mid, 55);
        const variance = Math.abs(dl - p.mid) + Math.abs(dr - p.mid);
        score = depth * 0.8 + Math.min(variance, 30) * 0.6;
      }
      // A close-up WANTS something near the camera; every other mode is ruined
      // by it.
      if (mode !== 'close') score -= lowBlock;

      if (score > bestScore) {
        bestScore = score;
        best = { yaw, pitch: this._pitchFor(eye, p, mode), dist: p.mid };
      }
    }
    return best;
  }

  /** Backwards-compatible yaw-only helper. */
  _bestYaw(eye, mode = 'depth') { return this._bestView(eye, mode).yaw; }

  _pitchFor(eye, p, mode) {
    if (mode === 'close') {
      // Look straight at the subject so it fills the frame rather than sitting
      // under a wide establishing shot.
      const d = Math.max(1.2, Math.min(p.low, p.mid));
      const y = p.low <= p.mid ? p.lowY : p.midY;
      return THREE.MathUtils.clamp(Math.atan2(y - eye.y, d), -0.42, 0.12);
    }
    if (mode === 'lane') {
      // Level down the corridor; a tilt here just eats the far end.
      return p.high < 5 ? -0.075 : -0.028;
    }
    // Depth: nose down a touch, and further if there is a roof close overhead —
    // otherwise the spawn canopy takes the top sixth of the frame.
    return p.high < 4.5 ? -0.105 : -0.052;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The poses
  // ───────────────────────────────────────────────────────────────────────────

  /** @returns {{pos:THREE.Vector3, yaw:number, pitch:number, fly:boolean}|null} */
  resolve(name) {
    const key = String(name || 'spawn').toLowerCase();

    // 1. Level-authored poses always win.
    const authored = this._authored(key);
    if (authored) return authored;

    const b = this._levelBounds();
    const eyeH = this.player.eyeHeightStanding;
    const spawn = this._spawnPoint();

    // 2. 'spawn' is the hot path (init + every respawn) — it only needs a yaw
    //    sweep from one point, so never pay for the full survey here.
    if (key === 'spawn') {
      const eye = TMP_EYE.set(spawn.x, spawn.y + eyeH, spawn.z);
      const v = this._bestView(eye, 'depth');
      return { pos: spawn.clone(), yaw: v.yaw, pitch: v.pitch, fly: false };
    }

    // 3. Everything else is derived from the one-off level survey.
    let s = null;
    try { s = this.survey(); } catch (err) { console.warn('[player] survey failed:', err); }
    const pts = s?.points ?? [];

    if (pts.length === 0) {
      const eye = TMP_EYE.set(spawn.x, spawn.y + eyeH, spawn.z);
      const v = this._bestView(eye, 'depth');
      return { pos: spawn.clone(), yaw: v.yaw, pitch: v.pitch, fly: false };
    }

    if (key === 'overwatch') {
      // Highest standable point wins; if the map is flat, lift the camera to a
      // rooftop height above the most open point and look down across it.
      let best = pts[0];
      let bestScore = -Infinity;
      for (const p of pts) {
        const score = (p.groundY - b.trueMinY) * 3.0 + p.openness * 0.12
          + (p.roofed ? -4 : 2) + this._centrality(p, b) * 2.5;
        if (score > bestScore) { bestScore = score; best = p; }
      }
      let y = best.groundY;
      let fly = false;
      const rise = best.groundY - b.trueMinY;
      if (rise < 2.5) {
        // Nothing standable is high enough to see over the map, so lift the rig
        // clear of the tallest thing in it. Flat maps still get 6.5m of height.
        y = Math.min(
          b.trueMinY + 30,
          Math.max(b.trueMinY + 6.5, b.trueMaxY + 1.5),
        );
        fly = true;
      }
      const pos = best.pos.clone();
      pos.y = y;
      const eye = TMP_EYE.set(pos.x, pos.y + eyeH, pos.z);
      // Aim at the centre of mass of the playspace, slightly down.
      const dx = b.centre.x - pos.x, dz = b.centre.z - pos.z;
      let yaw = Math.atan2(-dx, -dz);
      if (Math.hypot(dx, dz) < 3) yaw = this._bestYaw(eye, 'depth');
      // Frame by horizon position rather than by "angle to the centre": from a
      // rooftop the latter still leaves the skyline through the middle of the
      // frame, so half the shot is empty sky. Put the horizon a third of the way
      // down and the playspace fills the bottom two thirds.
      const vFov = THREE.MathUtils.degToRad(this.ctx.config.camera.fov);
      const drop = (pos.y + eyeH) - (b.trueMinY + 1.2);
      const dist = Math.max(6, Math.hypot(dx, dz));
      const toCentre = -Math.atan2(drop, dist);
      const horizonRule = (0.34 - 0.5) * vFov;   // horizon at 34% from the top
      const pitch = THREE.MathUtils.clamp(
        Math.min(toCentre, horizonRule), -0.55, -0.06,
      );
      return { pos, yaw, pitch, fly };
    }

    if (key === 'warehouse') {
      // Most enclosed standable spot with enough room to see something.
      let best = null, bestScore = -Infinity;
      for (const p of pts) {
        const score = (p.roofed ? 30 : 0) + Math.min(p.longest, 26)
          - p.openness * 0.35 + this._centrality(p, b) * 6;
        if (score > bestScore) { bestScore = score; best = p; }
      }
      if (!best) best = pts[0];
      const eye = TMP_EYE.copy(best.eye);
      const v = this._bestView(eye, 'depth');
      return { pos: best.pos.clone(), yaw: v.yaw, pitch: v.pitch, fly: false };
    }

    if (key === 'lane') {
      // Longest sightline on the map, stood a little way back down it.
      let best = null, bestScore = -Infinity;
      for (const p of pts) {
        const score = p.longest - p.openness * 0.25 + this._centrality(p, b) * 6;
        if (score > bestScore) { bestScore = score; best = p; }
      }
      if (!best) best = pts[0];
      const eye = TMP_EYE.copy(best.eye);
      const v = this._bestView(eye, 'lane');
      return { pos: best.pos.clone(), yaw: v.yaw, pitch: v.pitch, fly: false };
    }

    if (key === 'closeup') {
      // Somewhere with a wall in arm's reach — this is the material-detail shot.
      let best = null, bestScore = -Infinity;
      for (const p of pts) {
        let near = 999;
        for (let i = 0; i < p.sight.length; i++) near = Math.min(near, p.sight[i]);
        // Want a surface within easy walking range — close enough that the
        // approach below is a short, safe step, far enough that the sample
        // point is not already jammed against it.
        const approachable = near > 1.8 && near < 22 ? 8 : 0;
        const score = -Math.abs(near - 6.0) * 0.9 + approachable
          + Math.min(p.longest, 30) * 0.10 + this._centrality(p, b) * 4;
        if (score > bestScore) { bestScore = score; best = p; }
      }
      if (!best) best = pts[0];
      const eye = TMP_EYE.copy(best.eye);
      const v = this._bestView(eye, 'close');
      const yaw = v.yaw;

      // Walk the camera IN until the subject is ~2.4m away. Picking the yaw
      // alone is not enough: the survey lattice is 9x9 across the whole map, so
      // the nearest sample point to a wall can still be 10m off it — which is
      // how "closeup" kept coming back as a wide establishing shot.
      //
      // The yaw is then FROZEN. Re-running the direction search from the new
      // position picks whatever is nearest *there*, which is usually back the
      // way we came — the approach undoes itself and you land on a wide shot
      // again, one metre from where you started.
      const pos = best.pos.clone();
      const reach = Math.min(v.dist, this._cast(eye, yaw, -1.05).dist);
      const step = reach - 2.4;
      if (step > 0.6 && reach < 60) {
        const nx = pos.x - Math.sin(yaw) * step;
        const nz = pos.z - Math.cos(yaw) * step;
        const gy = this._groundAt(nx, nz, b.maxY + 4);
        // Only commit if there is real floor there and it is not a cliff edge.
        if (gy !== null && Math.abs(gy - best.groundY) < 1.2) {
          pos.set(nx, gy, nz);
          TMP_EYE.set(nx, gy + eyeH, nz);
          const p2 = this._probe(TMP_EYE, yaw);
          return { pos, yaw, pitch: this._pitchFor(TMP_EYE, p2, 'close'), fly: false };
        }
      }
      return { pos, yaw, pitch: v.pitch, fly: false };
    }

    // Unknown name: behave like 'spawn' rather than throwing at the harness.
    const eye = TMP_EYE.set(spawn.x, spawn.y + eyeH, spawn.z);
    const fv = this._bestView(eye, 'depth');
    return { pos: spawn.clone(), yaw: fv.yaw, pitch: fv.pitch, fly: false };
  }

  _authored(key) {
    const table = this.ctx.level?.poses;
    const entry = table && (table[key] ?? table[key.toLowerCase()]);
    if (!entry) return null;
    try {
      const p = entry.position ?? entry.pos;
      if (!p) return null;
      const pos = Array.isArray(p) ? new THREE.Vector3(p[0], p[1], p[2]) : new THREE.Vector3(p.x, p.y, p.z);
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return null;

      let yaw = Number(entry.yaw);
      let pitch = Number(entry.pitch ?? 0);
      const look = entry.lookAt ?? entry.target;
      if (look) {
        const t = Array.isArray(look) ? new THREE.Vector3(look[0], look[1], look[2])
          : new THREE.Vector3(look.x, look.y, look.z);
        const dx = t.x - pos.x, dz = t.z - pos.z;
        const dy = t.y - (pos.y + this.player.eyeHeightStanding);
        yaw = Math.atan2(-dx, -dz);
        pitch = Math.atan2(dy, Math.max(0.2, Math.hypot(dx, dz)));
      }
      if (!Number.isFinite(yaw)) yaw = 0;
      if (!Number.isFinite(pitch)) pitch = 0;
      return { pos, yaw, pitch: THREE.MathUtils.clamp(pitch, -1.4, 1.4), fly: !!entry.fly };
    } catch (err) {
      console.warn('[player] level pose table entry rejected:', err);
      return null;
    }
  }

  _spawnPoint(index = 0) {
    const sp = this.ctx.level?.spawnPoints;
    let v = null;
    if (Array.isArray(sp) && sp.length) {
      const p = sp[index % sp.length];
      if (p && Number.isFinite(p.x)) v = new THREE.Vector3(p.x, p.y, p.z);
      else if (Array.isArray(p) && p.length >= 3) v = new THREE.Vector3(p[0], p[1], p[2]);
    }
    if (!v) return new THREE.Vector3(0, 0, 0);
    // Same floor-snap the live spawn gets — authored spawn heights are not
    // reliably in sync with the collision geometry.
    return this.player._settleSpawn?.(v) ?? v;
  }

  invalidate() { this._survey = null; this._bounds = null; }
}

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const DIR = new THREE.Vector3();
const TMP_EYE = new THREE.Vector3();
const TMP_FROM = new THREE.Vector3();

export default Poses;
