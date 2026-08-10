import * as THREE from 'three';
import { GROUPS, FILTERS, encodeGroups } from './groups.js';

/**
 * Debris field.
 *
 * Every chunk is a real dynamic rigid body, but the visuals go through one
 * InstancedMesh per surface material, so a wall taking 200 rounds costs ~4 draw
 * calls instead of 200. Bodies and instance slots are pooled and recycled, so
 * steady-state allocation is zero.
 *
 * Chunks are interpolated between fixed steps (60Hz physics, 120Hz display),
 * and fade out by shrinking + sinking over the last couple of seconds of life
 * so nothing ever pops out of existence in front of the player.
 *
 * OWNER: physics agent. Called by FX via ctx.physics.spawnDebris(...).
 */

const CAPACITY_PER_MATERIAL = 56;
const GLOBAL_ACTIVE_CAP = 190;
const DEFAULT_LIFE = 12.0;
const FADE_TIME = 2.2;

const DEBRIS_GROUPS = encodeGroups(GROUPS.DEBRIS, FILTERS.DEBRIS);

// Materials that should shatter into flat shards rather than rounded chunks.
const SHARD_MATERIALS = new Set(['glass', 'rustMetal', 'paintedMetal', 'metal', 'wood', 'fabric']);

/** Rough physical character per surface, so concrete chunks don't bounce like rubber. */
const SURFACE_PHYSICS = {
  concrete: { density: 2.2, restitution: 0.06, friction: 0.94, scale: 1.0 },
  plaster: { density: 1.1, restitution: 0.03, friction: 0.96, scale: 0.9 },
  asphalt: { density: 2.1, restitution: 0.05, friction: 0.98, scale: 0.85 },
  rustMetal: { density: 4.4, restitution: 0.18, friction: 0.72, scale: 0.8 },
  paintedMetal: { density: 4.2, restitution: 0.2, friction: 0.7, scale: 0.8 },
  metal: { density: 4.4, restitution: 0.2, friction: 0.7, scale: 0.8 },
  wood: { density: 0.9, restitution: 0.12, friction: 0.85, scale: 1.05 },
  glass: { density: 1.9, restitution: 0.24, friction: 0.55, scale: 0.7 },
  sandbags: { density: 1.6, restitution: 0.02, friction: 1.0, scale: 1.1 },
  fabric: { density: 0.5, restitution: 0.02, friction: 1.0, scale: 1.2 },
  rubber: { density: 1.2, restitution: 0.42, friction: 1.0, scale: 0.9 },
  dirt: { density: 1.7, restitution: 0.02, friction: 1.0, scale: 1.0 },
};

function surfaceProfile(name) {
  return SURFACE_PHYSICS[name] ?? SURFACE_PHYSICS.concrete;
}

/** Irregular rock chunk — an icosahedron with jittered vertices. 20 tris. */
function makeChunkGeometry(seed = 1) {
  const geo = new THREE.IcosahedronGeometry(0.5, 0);
  const pos = geo.attributes.position;
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = 0; i < pos.count; i++) {
    const k = 0.62 + rnd() * 0.7;
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * (0.7 + rnd() * 0.55), pos.getZ(i) * k);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Flat angular shard — a squashed, sheared box. 12 tris. */
function makeShardGeometry() {
  const geo = new THREE.BoxGeometry(1, 0.26, 0.74, 1, 1, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setX(i, pos.getX(i) * (1 + y * 0.9));
    pos.setZ(i, pos.getZ(i) * (1 - y * 0.5));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

export class DebrisField {
  /** @param {import('./index.js').PhysicsSystem} physics */
  constructor(physics) {
    this.physics = physics;
    this.ctx = physics.ctx;
    this.RAPIER = physics.RAPIER;

    /** @type {Map<string, object>} material name -> pool */
    this.pools = new Map();
    this.activeCount = 0;
    this._enabled = true;

    this._chunkGeo = null;
    this._shardGeo = null;

    // scratch
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._scale = new THREE.Vector3();
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this._tangent = new THREE.Vector3();
    this._bitangent = new THREE.Vector3();

    // Round-robin ordering so the global cap recycles the oldest chunk.
    this._serial = 0;
  }

  _geoFor(materialName) {
    if (SHARD_MATERIALS.has(materialName)) {
      if (!this._shardGeo) this._shardGeo = makeShardGeometry();
      return this._shardGeo;
    }
    if (!this._chunkGeo) this._chunkGeo = makeChunkGeometry(7);
    return this._chunkGeo;
  }

  _material(name) {
    try {
      const m = this.ctx.materials?.get?.(name);
      if (m) return m;
    } catch { /* materials system not ready or unknown name */ }
    return this._fallbackMaterial ??= new THREE.MeshStandardMaterial({
      color: 0x6d6a66, roughness: 0.94, metalness: 0.02,
    });
  }

  _pool(materialName) {
    let pool = this.pools.get(materialName);
    if (pool) return pool;

    const geo = this._geoFor(materialName);
    const mat = this._material(materialName);
    const mesh = new THREE.InstancedMesh(geo, mat, CAPACITY_PER_MATERIAL);
    mesh.name = `debris:${materialName}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;      // instances move far from the origin bounds
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < CAPACITY_PER_MATERIAL; i++) mesh.setMatrixAt(i, this._zero);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.isDebris = true;
    try { this.ctx.scene.add(mesh); } catch { /* scene missing — visuals degrade, physics fine */ }

    pool = {
      name: materialName,
      mesh,
      slots: new Array(CAPACITY_PER_MATERIAL).fill(null),
      free: Array.from({ length: CAPACITY_PER_MATERIAL }, (_, i) => CAPACITY_PER_MATERIAL - 1 - i),
      active: [],
      profile: surfaceProfile(materialName),
    };
    this.pools.set(materialName, pool);
    return pool;
  }

  /** Lazily create the body/collider for a slot; size is fixed per slot and reused forever. */
  _slot(pool, index) {
    let slot = pool.slots[index];
    if (slot) return slot;

    const RAPIER = this.RAPIER;
    const world = this.physics.world;
    const p = pool.profile;
    const s = p.scale;
    const sx = (0.045 + Math.random() * 0.075) * s;
    const sy = (0.035 + Math.random() * 0.06) * s;
    const sz = (0.045 + Math.random() * 0.075) * s;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, -500, 0)
      .setLinearDamping(0.12)
      .setAngularDamping(0.55)
      .setCanSleep(true)
      .setCcdEnabled(true);
    const body = world.createRigidBody(bodyDesc);

    // Cuboid approximation of the visual chunk — cheap and stable.
    // Collider is inflated a touch over the visual chunk: at 5cm scale nobody
    // can see the gap, and it stops fast chunks tunnelling through the level's
    // (hollow, surface-only) trimeshes.
    const colDesc = RAPIER.ColliderDesc.cuboid(sx * 0.62, sy * 0.62, sz * 0.62)
      .setDensity(p.density)
      .setRestitution(p.restitution)
      .setFriction(p.friction)
      .setCollisionGroups(DEBRIS_GROUPS);
    const collider = world.createCollider(colDesc, body);
    this.physics._queryDirty = true;

    body.setEnabled(false);

    slot = {
      index,
      body,
      collider,
      size: new THREE.Vector3(sx, sy, sz),
      active: false,
      age: 0,
      life: DEFAULT_LIFE,
      serial: 0,
      prevP: new THREE.Vector3(0, -500, 0),
      prevQ: new THREE.Quaternion(),
      curP: new THREE.Vector3(0, -500, 0),
      curQ: new THREE.Quaternion(),
    };
    pool.slots[index] = slot;
    return slot;
  }

  /**
   * Spawn `count` chunks bursting out of `position` along `normal`.
   * Safe to call with junk arguments — it clamps and defaults everything.
   */
  spawn(position, normal, count = 6, materialName = 'concrete', opts = {}) {
    if (!this._enabled || !this.physics.world) return 0;
    if (!position) return 0;

    const n = Math.max(1, Math.min(24, count | 0 || 6));
    const name = typeof materialName === 'string' && materialName ? materialName : 'concrete';

    let pool;
    try { pool = this._pool(name); } catch (err) {
      console.warn('[physics] debris pool failed for', name, err);
      return 0;
    }

    const px = position.x ?? 0, py = position.y ?? 0, pz = position.z ?? 0;
    this._v.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
    if (this._v.lengthSq() < 1e-6) this._v.set(0, 1, 0);
    this._v.normalize();

    // Build a basis around the surface normal so the cone is oriented properly.
    this._tangent.set(0, 1, 0);
    if (Math.abs(this._v.y) > 0.92) this._tangent.set(1, 0, 0);
    this._tangent.crossVectors(this._tangent, this._v).normalize();
    this._bitangent.crossVectors(this._v, this._tangent).normalize();

    const speed = opts.speed ?? 3.1;
    const spread = opts.spread ?? 0.85;
    const life = opts.life ?? DEFAULT_LIFE;

    let spawned = 0;
    for (let i = 0; i < n; i++) {
      const slot = this._acquire(pool);
      if (!slot) break;

      const jitter = 0.035;
      const ox = px + (Math.random() - 0.5) * jitter + this._v.x * 0.03;
      const oy = py + (Math.random() - 0.5) * jitter + this._v.y * 0.03;
      const oz = pz + (Math.random() - 0.5) * jitter + this._v.z * 0.03;

      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spread;
      this._v2.copy(this._v)
        .addScaledVector(this._tangent, Math.cos(a) * r)
        .addScaledVector(this._bitangent, Math.sin(a) * r)
        .normalize();

      const sp = speed * (0.45 + Math.random() * 1.15);

      const body = slot.body;
      body.setEnabled(true);
      body.setTranslation({ x: ox, y: oy, z: oz }, false);
      this._q.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      body.setRotation({ x: this._q.x, y: this._q.y, z: this._q.z, w: this._q.w }, false);
      body.setLinvel({ x: this._v2.x * sp, y: this._v2.y * sp + 0.9, z: this._v2.z * sp }, false);
      body.setAngvel({
        x: (Math.random() - 0.5) * 22,
        y: (Math.random() - 0.5) * 22,
        z: (Math.random() - 0.5) * 22,
      }, false);
      body.wakeUp();

      slot.active = true;
      slot.age = 0;
      slot.life = life * (0.82 + Math.random() * 0.36);
      slot.serial = this._serial++;
      slot.prevP.set(ox, oy, oz);
      slot.curP.set(ox, oy, oz);
      slot.prevQ.copy(this._q);
      slot.curQ.copy(this._q);
      pool.active.push(slot);
      this.activeCount++;
      spawned++;
    }

    this._enforceGlobalCap();
    return spawned;
  }

  _acquire(pool) {
    let index = pool.free.pop();
    if (index === undefined) {
      // Pool saturated — steal the oldest chunk in this pool.
      let oldest = null;
      for (const s of pool.active) if (!oldest || s.serial < oldest.serial) oldest = s;
      if (!oldest) return null;
      this._release(pool, oldest);
      index = pool.free.pop();
      if (index === undefined) return null;
    }
    return this._slot(pool, index);
  }

  _release(pool, slot) {
    if (!slot.active) return;
    slot.active = false;
    try {
      slot.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      slot.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      slot.body.setTranslation({ x: 0, y: -500, z: 0 }, false);
      slot.body.setEnabled(false);
    } catch { /* body already gone */ }
    const i = pool.active.indexOf(slot);
    if (i >= 0) pool.active.splice(i, 1);
    pool.free.push(slot.index);
    pool.mesh.setMatrixAt(slot.index, this._zero);
    pool.mesh.instanceMatrix.needsUpdate = true;
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  _enforceGlobalCap() {
    while (this.activeCount > GLOBAL_ACTIVE_CAP) {
      let victimPool = null, victim = null;
      for (const pool of this.pools.values()) {
        for (const s of pool.active) {
          if (!victim || s.serial < victim.serial) { victim = s; victimPool = pool; }
        }
      }
      if (!victim) break;
      this._release(victimPool, victim);
    }
  }

  /** Called immediately BEFORE world.step() — snapshot for interpolation. */
  savePrev() {
    for (const pool of this.pools.values()) {
      for (const s of pool.active) {
        s.prevP.copy(s.curP);
        s.prevQ.copy(s.curQ);
      }
    }
  }

  /** Called immediately AFTER world.step() — read fresh transforms + age out. */
  readCurrent(fdt) {
    for (const pool of this.pools.values()) {
      // Iterate backwards: _release() splices out of pool.active.
      for (let i = pool.active.length - 1; i >= 0; i--) {
        const s = pool.active[i];
        s.age += fdt;
        if (s.age >= s.life) { this._release(pool, s); continue; }
        const t = s.body.translation();
        const r = s.body.rotation();
        s.curP.set(t.x, t.y, t.z);
        s.curQ.set(r.x, r.y, r.z, r.w);
        if (s.curP.y < -60) this._release(pool, s);
      }
    }
  }

  /** Per rendered frame: interpolate + write instance matrices. */
  render(alpha) {
    const a = alpha;
    for (const pool of this.pools.values()) {
      if (pool.active.length === 0) continue;
      for (const s of pool.active) {
        this._v.lerpVectors(s.prevP, s.curP, a);
        this._q.copy(s.prevQ).slerp(s.curQ, a);

        // Fade: shrink and sink over the last FADE_TIME seconds.
        const remain = s.life - s.age;
        let k = 1;
        if (remain < FADE_TIME) {
          k = Math.max(0, remain / FADE_TIME);
          k = k * k * (3 - 2 * k); // smoothstep
          this._v.y -= (1 - k) * s.size.y * 0.6;
        }
        this._scale.set(s.size.x * k, s.size.y * k, s.size.z * k);
        this._m.compose(this._v, this._q, this._scale);
        pool.mesh.setMatrixAt(s.index, this._m);
      }
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  clear() {
    for (const pool of this.pools.values()) {
      for (let i = pool.active.length - 1; i >= 0; i--) this._release(pool, pool.active[i]);
    }
    this.activeCount = 0;
  }

  dispose() {
    this.clear();
    for (const pool of this.pools.values()) {
      try { pool.mesh.parent?.remove(pool.mesh); } catch { /* already detached */ }
      try { pool.mesh.dispose(); } catch { /* noop */ }
      for (const s of pool.slots) {
        if (!s) continue;
        try { this.physics.world?.removeRigidBody(s.body); } catch { /* world gone */ }
      }
    }
    this.pools.clear();
    this._chunkGeo?.dispose();
    this._shardGeo?.dispose();
    this._fallbackMaterial?.dispose();
  }
}

export default DebrisField;
