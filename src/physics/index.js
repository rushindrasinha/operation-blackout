import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

import { GROUPS, FILTERS, encodeGroups, resolveInteractionGroups, queryGroups } from './groups.js';
import { DebrisField } from './debris.js';
import { PhysicsDebugView } from './debugview.js';

export { GROUPS, FILTERS, encodeGroups };

/**
 * OPERATION BLACKOUT — physics layer.
 *
 * Rapier3D, stepped at a hard 60Hz fixed timestep from fixedUpdate(). Owns:
 *   - static trimesh colliders for the level
 *   - the collider -> actor registry every raycast result is resolved through
 *   - collision groups (WORLD / PLAYER / ENEMY / DEBRIS / PROJECTILE / TRIGGER)
 *   - the kinematic character controller the player and bots drive
 *   - dynamic props + the pooled debris field
 *   - fixed-step interpolation so 60Hz physics is smooth on a 120Hz display
 *
 * Everything here is defensive: a missing level, a degenerate mesh or a broken
 * raycast degrades to a warning, never to a black screen.
 *
 * OWNER: physics agent. static id='physics', static order=10.
 */
export class PhysicsSystem {
  static id = 'physics';
  static order = 10;

  constructor(ctx) {
    this.ctx = ctx;
    this.RAPIER = RAPIER;

    /** @type {RAPIER.World|null} */
    this.world = null;
    this.ready = false;

    this.GROUPS = GROUPS;
    this.FILTERS = FILTERS;

    /** collider.handle -> game object (bot, prop, player, ...) */
    this.actors = new Map();
    /** collider.handle -> surface material name, for impact FX + audio */
    this.surfaces = new Map();

    /** Bodies whose THREE object we sync each frame, with interpolation state. */
    this._synced = [];
    /** Every body we created, so dispose() is complete. */
    this._bodies = new Set();

    this.debris = null;
    this.debugView = null;

    this.fixedStep = 1 / 60;
    this._alpha = 0;
    this._stepCount = 0;
    // Rapier only refreshes its scene-query acceleration structures inside
    // step(). A collider created between two steps is invisible to raycasts
    // until then, which silently breaks "spawn a bot, immediately shoot it".
    // We track that and force a zero-length settle step on demand.
    this._queryDirty = true;
    this.stats = { colliders: 0, bodies: 0, staticMeshes: 0, raycasts: 0, stepMs: 0 };

    // ── scratch (physics runs hot; nothing here allocates per-call) ──────────
    this._sv = new THREE.Vector3();
    this._sv2 = new THREE.Vector3();
    this._sq = new THREE.Quaternion();
    this._sm = new THREE.Matrix4();
    this._sscale = new THREE.Vector3();
    this._ray = null;
    this._rayOrigin = { x: 0, y: 0, z: 0 };
    this._rayDir = { x: 0, y: 0, z: 1 };
    this._sharedHit = {
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      distance: 0,
      collider: null,
      body: null,
      actor: null,
      material: 'concrete',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async init(onProgress = () => {}) {
    onProgress(0.05, 'physics: rapier');
    try {
      await RAPIER.init();
    } catch (err) {
      console.error('[physics] RAPIER.init() failed — physics disabled:', err);
      this.ready = false;
      return;
    }

    const g = this.ctx.config?.player?.gravity ?? -18.5;
    this.world = new RAPIER.World({ x: 0, y: g, z: 0 });
    this.fixedStep = this.ctx.engine?.fixedStep ?? 1 / 60;
    this.world.timestep = this.fixedStep;
    this.world.numSolverIterations = 4;

    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

    this.debris = new DebrisField(this);
    this.debugView = new PhysicsDebugView(this);

    onProgress(0.35, 'physics: level colliders');
    this._buildLevelColliders();

    onProgress(0.95, 'physics: ready');
    this._syncQueries();
    this.ready = true;
    this.stats.bodies = this.world.bodies.len();
    this.stats.colliders = this.world.colliders.len();
    console.info(
      `[physics] rapier ${RAPIER.version?.() ?? '?'} — ${this.stats.staticMeshes} static meshes, ` +
      `${this.stats.colliders} colliders, gravity ${g}`,
    );
  }

  _buildLevelColliders() {
    const level = this.ctx.level;
    const list = level?.collidables;
    if (!Array.isArray(list) || list.length === 0) {
      console.warn('[physics] ctx.level.collidables missing or empty — building fallback ground plane');
      this._buildFallbackGround();
      return;
    }

    let built = 0;
    for (const obj of list) {
      if (!obj) continue;
      try {
        built += this.addStaticMesh(obj) ? 1 : 0;
      } catch (err) {
        console.warn('[physics] failed to collide level mesh', obj?.name ?? '(unnamed)', err);
      }
    }
    this.stats.staticMeshes = built;

    if (built === 0) {
      console.warn('[physics] no level colliders were built — adding fallback ground');
      this._buildFallbackGround();
    }
  }

  _buildFallbackGround() {
    try {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
      const desc = RAPIER.ColliderDesc.cuboid(200, 0.5, 200)
        .setFriction(1.0)
        .setRestitution(0)
        .setCollisionGroups(encodeGroups(GROUPS.WORLD, FILTERS.WORLD));
      const collider = this.world.createCollider(desc, body);
      this._bodies.add(body);
      this._queryDirty = true;
      this.surfaces.set(collider.handle, 'concrete');
      this._fallbackGround = { body, collider };
    } catch (err) {
      console.error('[physics] fallback ground failed:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Static geometry
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build a static trimesh collider from a THREE.Mesh, correctly baking the
   * mesh's world matrix into the vertex data. Handles InstancedMesh (one
   * collider per instance) and Groups (recurses into mesh children).
   *
   * @param {THREE.Object3D} mesh
   * @param {object} [opts] { material, group, mask, friction, restitution, actor }
   * @returns {{ body: RAPIER.RigidBody, colliders: RAPIER.Collider[] }|null}
   */
  addStaticMesh(mesh, opts = {}) {
    if (!this.world || !mesh) return null;
    if (mesh.userData?.noCollide) return null;

    // Recurse containers so an agent can hand us a whole Group.
    if (!mesh.isMesh && !mesh.isInstancedMesh) {
      if (!mesh.isObject3D || !mesh.children?.length) return null;
      const out = [];
      for (const child of mesh.children) {
        const r = this.addStaticMesh(child, opts);
        if (r) out.push(r);
      }
      return out.length ? out[0] : null;
    }

    const geometry = mesh.geometry;
    const posAttr = geometry?.attributes?.position;
    if (!posAttr || posAttr.count < 3) return null;

    mesh.updateWorldMatrix(true, false);

    const materialName = opts.material
      ?? mesh.userData?.physicsMaterial
      ?? mesh.userData?.material
      ?? (typeof mesh.material?.name === 'string' && mesh.material.name ? mesh.material.name : 'concrete');

    const groups = resolveInteractionGroups(opts, 'WORLD');
    const friction = opts.friction ?? 0.92;
    const restitution = opts.restitution ?? 0.02;

    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this._bodies.add(body);
    const colliders = [];

    const indices = this._indicesFor(geometry);
    if (!indices) { this.world.removeRigidBody(body); this._bodies.delete(body); return null; }

    // FIX_INTERNAL_EDGES (which implies MERGE_DUPLICATE_VERTICES) is what stops
    // the character controller snagging on the seam between two coplanar
    // triangles — the classic "invisible kerb in the middle of the floor" bug.
    // DELETE_BAD_TOPOLOGY_TRIANGLES keeps open/non-manifold geometry from
    // failing the half-edge pass.
    const TF = RAPIER.TriMeshFlags;
    const preferredFlags = TF
      ? ((TF.FIX_INTERNAL_EDGES ?? 0) | (TF.DELETE_BAD_TOPOLOGY_TRIANGLES ?? 0)) || undefined
      : undefined;

    const addOne = (matrix) => {
      const verts = this._bakeVertices(posAttr, matrix);
      if (!verts) return;

      let collider = null;
      for (const flags of [preferredFlags, undefined]) {
        try {
          const desc = flags === undefined
            ? RAPIER.ColliderDesc.trimesh(verts, indices)
            : RAPIER.ColliderDesc.trimesh(verts, indices, flags);
          if (!desc) continue;
          desc.setFriction(friction).setRestitution(restitution).setCollisionGroups(groups);
          collider = this.world.createCollider(desc, body);
          if (collider) break;
        } catch (err) {
          if (flags === undefined) {
            console.warn('[physics] trimesh rejected for', mesh.name || '(unnamed)', err);
          }
        }
        if (preferredFlags === undefined) break; // both passes would be identical
      }
      if (!collider) return;

      colliders.push(collider);
      this.surfaces.set(collider.handle, materialName);
      if (opts.actor) this.actors.set(collider.handle, opts.actor);
      this._queryDirty = true;
    };

    if (mesh.isInstancedMesh) {
      const count = Math.min(mesh.count ?? 0, 512);
      if ((mesh.count ?? 0) > 512) {
        console.warn(`[physics] InstancedMesh "${mesh.name}" has ${mesh.count} instances — colliding first 512 only`);
      }
      for (let i = 0; i < count; i++) {
        mesh.getMatrixAt(i, this._sm);
        this._sm.premultiply(mesh.matrixWorld);
        addOne(this._sm);
      }
    } else {
      addOne(mesh.matrixWorld);
    }

    if (colliders.length === 0) {
      this.world.removeRigidBody(body);
      this._bodies.delete(body);
      return null;
    }

    mesh.userData.physicsBody = body;
    this.stats.staticMeshes++;
    return { body, colliders, collider: colliders[0] };
  }

  /** Convenience for the level agent: collide a whole array in one call. */
  addStaticMeshes(meshes, opts) {
    let n = 0;
    if (!Array.isArray(meshes)) return 0;
    for (const m of meshes) {
      try { if (this.addStaticMesh(m, opts)) n++; } catch (err) { console.warn('[physics] addStaticMeshes:', err); }
    }
    return n;
  }

  _indicesFor(geometry) {
    const posAttr = geometry.attributes.position;
    if (geometry.index) {
      const src = geometry.index.array;
      if (src instanceof Uint32Array) return src;
      const out = new Uint32Array(src.length);
      out.set(src);
      return out;
    }
    const n = posAttr.count;
    if (n % 3 !== 0) return null;
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = i;
    return out;
  }

  _bakeVertices(posAttr, matrix) {
    const n = posAttr.count;
    const out = new Float32Array(n * 3);
    const v = this._sv;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Primitive bodies
  // ─────────────────────────────────────────────────────────────────────────

  _makeBody(opts, pos, quat) {
    let desc;
    const type = opts.type ?? (opts.kinematic ? 'kinematic' : (opts.dynamic === false ? 'fixed' : 'dynamic'));
    if (type === 'fixed' || type === 'static') desc = RAPIER.RigidBodyDesc.fixed();
    else if (type === 'kinematic' || type === 'kinematicPosition') desc = RAPIER.RigidBodyDesc.kinematicPositionBased();
    else desc = RAPIER.RigidBodyDesc.dynamic();

    if (pos) desc.setTranslation(pos.x ?? 0, pos.y ?? 0, pos.z ?? 0);
    if (quat) desc.setRotation({ x: quat.x ?? 0, y: quat.y ?? 0, z: quat.z ?? 0, w: quat.w ?? 1 });
    if (opts.linearDamping !== undefined) desc.setLinearDamping(opts.linearDamping);
    if (opts.angularDamping !== undefined) desc.setAngularDamping(opts.angularDamping);
    if (opts.ccd) desc.setCcdEnabled(true);
    if (opts.canSleep === false) desc.setCanSleep(false);
    if (opts.gravityScale !== undefined && desc.setGravityScale) desc.setGravityScale(opts.gravityScale);

    const body = this.world.createRigidBody(desc);
    if (opts.lockRotations) body.lockRotations(true, false);
    this._bodies.add(body);
    return body;
  }

  _finishCollider(desc, body, opts, fallbackGroup) {
    desc.setFriction(opts.friction ?? 0.7)
      .setRestitution(opts.restitution ?? 0.05)
      .setCollisionGroups(resolveInteractionGroups(opts, fallbackGroup));
    if (opts.sensor) desc.setSensor(true);
    if (opts.density !== undefined) desc.setDensity(opts.density);
    else if (opts.mass !== undefined) desc.setMass(opts.mass);

    const collider = this.world.createCollider(desc, body);
    this._queryDirty = true;
    if (opts.actor) this.registerActor(collider, opts.actor);
    this.surfaces.set(collider.handle, opts.material ?? 'concrete');
    return collider;
  }

  /**
   * @param {THREE.Vector3|{x,y,z}|number[]} size FULL size (not half extents)
   * @returns {{body:RAPIER.RigidBody, collider:RAPIER.Collider}|null}
   */
  addBox(size, pos, quat = null, opts = {}) {
    if (!this.world) return null;
    try {
      const sx = Array.isArray(size) ? size[0] : (size?.x ?? 1);
      const sy = Array.isArray(size) ? size[1] : (size?.y ?? 1);
      const sz = Array.isArray(size) ? size[2] : (size?.z ?? 1);
      const body = this._makeBody(opts, pos, quat);
      const desc = RAPIER.ColliderDesc.cuboid(
        Math.max(1e-3, sx * 0.5), Math.max(1e-3, sy * 0.5), Math.max(1e-3, sz * 0.5),
      );
      const collider = this._finishCollider(desc, body, opts, opts.type === 'dynamic' ? 'DEBRIS' : 'WORLD');
      if (opts.mesh) this.track(body, opts.mesh);
      return { body, collider };
    } catch (err) {
      console.warn('[physics] addBox failed:', err);
      return null;
    }
  }

  /**
   * Capsule along +Y. `halfHeight` is the half-length of the cylindrical part,
   * NOT including the hemispherical caps (Rapier convention). Total height is
   * therefore 2*(halfHeight + radius).
   */
  addCapsule(halfHeight, radius, pos, opts = {}) {
    if (!this.world) return null;
    try {
      const hh = Math.max(1e-3, halfHeight ?? 0.5);
      const r = Math.max(1e-3, radius ?? 0.3);
      const body = this._makeBody({ lockRotations: true, ...opts }, pos, opts.quat ?? null);
      const desc = RAPIER.ColliderDesc.capsule(hh, r);
      const collider = this._finishCollider(desc, body, opts, 'PLAYER');
      if (opts.mesh) this.track(body, opts.mesh);
      return { body, collider };
    } catch (err) {
      console.warn('[physics] addCapsule failed:', err);
      return null;
    }
  }

  addSphere(radius, pos, opts = {}) {
    if (!this.world) return null;
    try {
      const body = this._makeBody(opts, pos, null);
      const desc = RAPIER.ColliderDesc.ball(Math.max(1e-3, radius ?? 0.2));
      const collider = this._finishCollider(desc, body, opts, 'DEBRIS');
      if (opts.mesh) this.track(body, opts.mesh);
      return { body, collider };
    } catch (err) {
      console.warn('[physics] addSphere failed:', err);
      return null;
    }
  }

  /**
   * Dynamic body approximating a THREE.Mesh — convex hull of its (world-scaled)
   * vertices, falling back to an oriented box from the bounding box. Used for
   * knocked-over props and large debris.
   *
   * The mesh keeps its own transform: pass opts.sync !== false and we drive it
   * from the simulation with interpolation.
   */
  addDynamicFromMesh(mesh, opts = {}) {
    if (!this.world || !mesh?.geometry) return null;
    try {
      mesh.updateWorldMatrix(true, false);
      this._sm.copy(mesh.matrixWorld).decompose(this._sv, this._sq, this._sscale);

      const geometry = mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const bb = geometry.boundingBox;

      // Centre of mass at the geometry centroid: build the collider in a frame
      // centred on the bbox centre, then offset the body so the mesh lines up.
      const centre = bb.getCenter(this._sv2).multiply(this._sscale);
      centre.applyQuaternion(this._sq);

      const body = this._makeBody(
        { type: 'dynamic', linearDamping: 0.08, angularDamping: 0.35, ...opts },
        { x: this._sv.x + centre.x, y: this._sv.y + centre.y, z: this._sv.z + centre.z },
        this._sq,
      );

      let desc = null;
      const posAttr = geometry.attributes.position;
      const localCentre = bb.getCenter(new THREE.Vector3());

      if (opts.shape !== 'box' && posAttr && posAttr.count >= 4 && posAttr.count <= 4096) {
        const pts = new Float32Array(posAttr.count * 3);
        const v = this._sv;
        for (let i = 0; i < posAttr.count; i++) {
          v.fromBufferAttribute(posAttr, i).sub(localCentre).multiply(this._sscale);
          pts[i * 3] = v.x; pts[i * 3 + 1] = v.y; pts[i * 3 + 2] = v.z;
        }
        try { desc = RAPIER.ColliderDesc.convexHull(pts); } catch { desc = null; }
      }

      if (!desc) {
        const hx = Math.max(1e-3, (bb.max.x - bb.min.x) * 0.5 * Math.abs(this._sscale.x));
        const hy = Math.max(1e-3, (bb.max.y - bb.min.y) * 0.5 * Math.abs(this._sscale.y));
        const hz = Math.max(1e-3, (bb.max.z - bb.min.z) * 0.5 * Math.abs(this._sscale.z));
        desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz);
      }

      const collider = this._finishCollider(
        desc,
        body,
        { friction: 0.85, restitution: 0.06, density: 1.6, group: 'DEBRIS', ...opts },
        'DEBRIS',
      );

      if (opts.sync !== false) this.track(body, mesh, localCentre.clone().multiply(this._sscale));
      return { body, collider };
    } catch (err) {
      console.warn('[physics] addDynamicFromMesh failed:', err);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Actor registry — how a raycast becomes "you hit bot #3"
  // ─────────────────────────────────────────────────────────────────────────

  registerActor(collider, actor) {
    if (!collider || actor === undefined || actor === null) return;
    const handle = typeof collider === 'number' ? collider : collider.handle;
    if (handle === undefined) return;
    this.actors.set(handle, actor);
  }

  unregisterActor(collider) {
    if (collider === undefined || collider === null) return;
    const handle = typeof collider === 'number' ? collider : collider.handle;
    this.actors.delete(handle);
    this.surfaces.delete(handle);
  }

  actorFor(collider) {
    if (!collider) return null;
    const handle = typeof collider === 'number' ? collider : collider.handle;
    return this.actors.get(handle) ?? null;
  }

  /** Tag a collider with a surface material name so FX/audio pick the right impact. */
  registerSurface(collider, materialName) {
    if (!collider || !materialName) return;
    const handle = typeof collider === 'number' ? collider : collider.handle;
    this.surfaces.set(handle, materialName);
  }

  surfaceFor(collider) {
    if (!collider) return 'concrete';
    const handle = typeof collider === 'number' ? collider : collider.handle;
    return this.surfaces.get(handle) ?? 'concrete';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * World-space raycast.
   *
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir           need not be normalised
   * @param {number} maxDist
   * @param {object|RAPIER.Collider|null} filter
   *        { exclude, excludeBody, excludeActor, group, mask, collisionGroups,
   *          solid, predicate, reuse }
   *        Passing a Collider directly is shorthand for { exclude: collider }.
   * @returns {{point:THREE.Vector3, normal:THREE.Vector3, distance:number,
   *            collider:RAPIER.Collider, body:RAPIER.RigidBody|null,
   *            actor:any, material:string}|null}
   */
  raycast(origin, dir, maxDist = 1000, filter = null) {
    if (!this.world || !origin || !dir) return null;
    if (this._queryDirty) this._syncQueries();

    let f = filter;
    if (f && typeof f.handle === 'number' && !('exclude' in f)) f = { exclude: f };
    f = f || {};

    const dx = dir.x, dy = dir.y, dz = dir.z;
    let len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-9)) return null;
    const inv = 1 / len;

    this._rayOrigin.x = origin.x; this._rayOrigin.y = origin.y; this._rayOrigin.z = origin.z;
    this._rayDir.x = dx * inv; this._rayDir.y = dy * inv; this._rayDir.z = dz * inv;
    this._ray.origin = this._rayOrigin;
    this._ray.dir = this._rayDir;

    const groups = typeof f.collisionGroups === 'number'
      ? f.collisionGroups >>> 0
      : queryGroups(f.group ?? GROUPS.PROJECTILE, typeof f.mask === 'number' ? f.mask : null);

    let predicate = f.predicate ?? undefined;
    if (f.excludeActor !== undefined && f.excludeActor !== null) {
      const banned = f.excludeActor;
      const inner = predicate;
      predicate = (c) => {
        if (this.actors.get(c.handle) === banned) return false;
        return inner ? inner(c) : true;
      };
    }

    let hit = null;
    try {
      this.stats.raycasts++;
      hit = this.world.castRayAndGetNormal(
        this._ray,
        maxDist,
        f.solid ?? true,
        f.flags ?? undefined,
        groups,
        f.exclude ?? undefined,
        f.excludeBody ?? undefined,
        predicate,
      );
    } catch (err) {
      console.warn('[physics] raycast failed:', err);
      return null;
    }
    if (!hit) return null;

    const t = hit.timeOfImpact ?? hit.toi ?? 0;
    const out = f.reuse ? this._sharedHit : {
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      distance: 0,
      collider: null,
      body: null,
      actor: null,
      material: 'concrete',
    };

    out.distance = t;
    out.point.set(
      origin.x + this._rayDir.x * t,
      origin.y + this._rayDir.y * t,
      origin.z + this._rayDir.z * t,
    );

    const n = hit.normal;
    out.normal.set(n?.x ?? 0, n?.y ?? 1, n?.z ?? 0);
    if (out.normal.lengthSq() < 1e-9) {
      out.normal.set(-this._rayDir.x, -this._rayDir.y, -this._rayDir.z);
    } else {
      out.normal.normalize();
      // Trimeshes can hand back an inward-facing normal depending on winding.
      // Always return the face that the ray actually struck.
      if (out.normal.x * this._rayDir.x + out.normal.y * this._rayDir.y + out.normal.z * this._rayDir.z > 0) {
        out.normal.negate();
      }
    }

    const collider = hit.collider;
    out.collider = collider;
    out.body = collider?.parent?.() ?? null;
    out.actor = collider ? (this.actors.get(collider.handle) ?? null) : null;
    out.material = collider ? (this.surfaces.get(collider.handle) ?? 'concrete') : 'concrete';
    return out;
  }

  /** True if `from` can see `to` with nothing solid in between. Used by AI. */
  hasLineOfSight(from, to, filter = null) {
    if (!this.world || !from || !to) return true;
    this._sv2.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const dist = this._sv2.length();
    if (dist < 1e-4) return true;
    const hit = this.raycast(from, this._sv2, dist - 0.02, {
      group: GROUPS.PROJECTILE,
      mask: GROUPS.WORLD,
      reuse: true,
      ...(filter || {}),
    });
    return !hit;
  }

  /**
   * Sphere cast — used for grenades and for "is there room to stand up".
   * Returns the same shape as raycast(), minus a meaningful surface normal
   * when the cast starts already penetrating.
   */
  spherecast(origin, dir, radius, maxDist = 50, filter = null) {
    if (!this.world) return null;
    if (this._queryDirty) this._syncQueries();
    const f = filter || {};
    this._sv2.set(dir.x, dir.y, dir.z);
    if (this._sv2.lengthSq() < 1e-9) return null;
    this._sv2.normalize();
    try {
      const groups = typeof f.collisionGroups === 'number'
        ? f.collisionGroups >>> 0
        : queryGroups(f.group ?? GROUPS.PROJECTILE, typeof f.mask === 'number' ? f.mask : null);
      const shape = new RAPIER.Ball(Math.max(1e-3, radius));
      const hit = this.world.castShape(
        { x: origin.x, y: origin.y, z: origin.z },
        { x: 0, y: 0, z: 0, w: 1 },
        { x: this._sv2.x, y: this._sv2.y, z: this._sv2.z },
        shape,
        0,
        maxDist,
        true,
        f.flags ?? undefined,
        groups,
        f.exclude ?? undefined,
        f.excludeBody ?? undefined,
        f.predicate ?? undefined,
      );
      if (!hit) return null;
      const t = hit.time_of_impact ?? hit.timeOfImpact ?? hit.toi ?? 0;
      const wp = hit.witness1 ?? { x: origin.x, y: origin.y, z: origin.z };
      const nn = hit.normal1 ?? { x: -this._sv2.x, y: -this._sv2.y, z: -this._sv2.z };
      return {
        point: new THREE.Vector3(wp.x, wp.y, wp.z),
        normal: new THREE.Vector3(nn.x, nn.y, nn.z),
        distance: t,
        collider: hit.collider ?? null,
        body: hit.collider?.parent?.() ?? null,
        actor: hit.collider ? (this.actors.get(hit.collider.handle) ?? null) : null,
        material: hit.collider ? (this.surfaces.get(hit.collider.handle) ?? 'concrete') : 'concrete',
      };
    } catch (err) {
      console.warn('[physics] spherecast failed:', err);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Character controller
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Kinematic character controller tuned for a modern-military FPS:
   * autostep over kerbs and sandbags, snap to ground on ramps and stairs,
   * climb up to ~50 degrees and slide back down anything over ~40.
   *
   * @param {number} offset skin width; keep small but non-zero
   */
  createCharacterController(offset = 0.02, opts = {}) {
    if (!this.world) return null;
    try {
      const cc = this.world.createCharacterController(Math.max(0.001, offset));
      cc.setUp({ x: 0, y: 1, z: 0 });

      const stepHeight = opts.stepHeight ?? this.ctx.config?.player?.stepHeight ?? 0.42;
      cc.enableAutostep(stepHeight, opts.stepMinWidth ?? 0.16, opts.stepDynamic ?? true);
      cc.enableSnapToGround(opts.snapDistance ?? Math.max(0.28, stepHeight * 0.75));

      cc.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(opts.maxSlopeClimbDeg ?? 50));
      cc.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(opts.minSlopeSlideDeg ?? 40));

      cc.setSlideEnabled(true);
      cc.setApplyImpulsesToDynamicBodies(opts.pushDynamics !== false);
      cc.setCharacterMass(opts.mass ?? 82);
      if (cc.setNormalNudgeFactor) cc.setNormalNudgeFactor(opts.normalNudge ?? 1.0e-4);

      return cc;
    } catch (err) {
      console.warn('[physics] createCharacterController failed:', err);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dynamic body <-> THREE object sync (with fixed-step interpolation)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Drive `object3d` from `body` every frame, interpolated between fixed steps.
   * `centreOffset` is the body-local offset of the mesh origin from the body
   * origin (convex hulls are built around the centroid, meshes usually are not).
   */
  track(body, object3d, centreOffset = null) {
    if (!body || !object3d) return null;
    const t = body.translation();
    const r = body.rotation();
    const entry = {
      body,
      object: object3d,
      offset: centreOffset ? centreOffset.clone().negate() : null,
      prevP: new THREE.Vector3(t.x, t.y, t.z),
      prevQ: new THREE.Quaternion(r.x, r.y, r.z, r.w),
      curP: new THREE.Vector3(t.x, t.y, t.z),
      curQ: new THREE.Quaternion(r.x, r.y, r.z, r.w),
    };
    object3d.matrixAutoUpdate = true;
    this._synced.push(entry);
    return entry;
  }

  untrack(bodyOrObject) {
    const i = this._synced.findIndex((e) => e.body === bodyOrObject || e.object === bodyOrObject);
    if (i >= 0) this._synced.splice(i, 1);
  }

  /** Fully remove a body (and any tracking / actor registration) from the world. */
  removeBody(body) {
    if (!this.world || !body) return;
    try {
      const n = body.numColliders?.() ?? 0;
      for (let i = 0; i < n; i++) {
        const c = body.collider(i);
        if (c) this.unregisterActor(c);
      }
    } catch { /* collider enumeration unavailable */ }
    this.untrack(body);
    this._bodies.delete(body);
    this._queryDirty = true;
    try { this.world.removeRigidBody(body); } catch (err) { console.warn('[physics] removeBody:', err); }
  }

  /** 0..1 progress through the current fixed step, for renderers that need it. */
  getInterpolationAlpha() {
    return this._alpha;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Destruction
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Spawn small dynamic chunks bursting out of a surface. Auto-despawns after
   * ~12 seconds with a shrink-and-sink fade. Called by FX on impacts.
   *
   * @returns {number} how many chunks were actually spawned
   */
  spawnDebris(position, normal, count = 6, materialName = 'concrete', opts = {}) {
    if (!this.debris) return 0;
    try {
      return this.debris.spawn(position, normal, count, materialName, opts);
    } catch (err) {
      console.warn('[physics] spawnDebris failed:', err);
      return 0;
    }
  }

  clearDebris() {
    try { this.debris?.clear(); } catch { /* nothing to clear */ }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Simulation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Advance the simulation by exactly `dt`. Called from fixedUpdate — do not
   * call this from anywhere else, and never with a variable dt.
   */
  step(dt) {
    if (!this.world) return;
    if (dt > 0 && Math.abs(this.world.timestep - dt) > 1e-9) this.world.timestep = dt;
    this.world.step();
    this._stepCount++;
    this._queryDirty = false;
  }

  /**
   * Make freshly-created colliders visible to scene queries without advancing
   * gameplay. A 10ns step costs one broad-phase refresh and moves nothing.
   */
  _syncQueries() {
    if (!this.world || !this._queryDirty) return;
    const saved = this.world.timestep;
    try {
      this.world.timestep = 1e-8;
      this.world.step();
    } catch (err) {
      console.warn('[physics] query sync step failed:', err);
    } finally {
      this.world.timestep = saved;
      this._queryDirty = false;
    }
  }

  fixedUpdate(fdt) {
    if (!this.world || !this.ready) return;
    this.fixedStep = fdt;

    // Snapshot before stepping so update() can interpolate prev -> current.
    for (const e of this._synced) { e.prevP.copy(e.curP); e.prevQ.copy(e.curQ); }
    this.debris?.savePrev();

    const t0 = performance.now();
    try {
      this.step(fdt);
    } catch (err) {
      console.error('[physics] world.step threw — pausing simulation:', err);
      this.ready = false;
      return;
    }
    this.stats.stepMs = this.stats.stepMs * 0.9 + (performance.now() - t0) * 0.1;

    for (const e of this._synced) {
      const t = e.body.translation();
      const r = e.body.rotation();
      e.curP.set(t.x, t.y, t.z);
      e.curQ.set(r.x, r.y, r.z, r.w);
    }
    try { this.debris?.readCurrent(fdt); } catch (err) { console.warn('[physics] debris update:', err); }
  }

  update(dt) {
    if (!this.world) return;

    // Engine drains its accumulator before running update(), so whatever is
    // left is exactly how far we are into the next fixed step.
    const engine = this.ctx.engine;
    const fs = engine?.fixedStep || this.fixedStep || 1 / 60;
    const acc = engine?._accumulator ?? 0;
    this._alpha = Math.min(1, Math.max(0, acc / fs));

    const a = this._alpha;
    for (const e of this._synced) {
      const obj = e.object;
      if (!obj || obj.userData?.physicsFrozen) continue;
      obj.position.lerpVectors(e.prevP, e.curP, a);
      obj.quaternion.copy(e.prevQ).slerp(e.curQ, a);
      if (e.offset) obj.position.add(this._sv.copy(e.offset).applyQuaternion(obj.quaternion));
    }

    try { this.debris?.render(a); } catch (err) { console.warn('[physics] debris render:', err); }
    try { this.debugView?.update(dt); } catch (err) { console.warn('[physics] debug view:', err); }
  }

  setDebugDraw(on) {
    if (this.ctx.config?.debug) this.ctx.config.debug.wireframe = !!on;
    this.debugView?.setEnabled(!!on);
  }

  dispose() {
    try { this.debugView?.dispose(); } catch { /* noop */ }
    try { this.debris?.dispose(); } catch { /* noop */ }
    this._synced.length = 0;
    this.actors.clear();
    this.surfaces.clear();
    this._bodies.clear();
    try { this.world?.free?.(); } catch { /* wasm already torn down */ }
    this.world = null;
    this.ready = false;
  }
}

export default PhysicsSystem;
