import * as THREE from 'three';
import { lathe, box, boxUV, wearFromAxial, wearFromAxes, ao } from './geom.js';

/**
 * OPERATION BLACKOUT — physical ejecta.
 *
 * Spent cases and dropped magazines are real rigid bodies in the world, not
 * particles: they tumble, bounce off concrete and come to rest where they land.
 * Bodies are POOLED and recycled — creating and destroying a Rapier body twelve
 * times a second during automatic fire is a measurable cost and a fragmentation
 * source, whereas teleporting a sleeping body is free.
 *
 * Shells render through a single InstancedMesh, so the whole brass field on the
 * floor costs one draw call.
 *
 * OWNER: weapons.
 */

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);

const PARK_Y = -320;

/** 5.56 / 9 mm case: rim, extractor groove, body taper, case mouth. */
function shellGeometry(radius = 0.0049, length = 0.0455) {
  const r = radius;
  const g = lathe([
    [0.0001, 0],
    [r * 1.06, 0],
    [r * 1.06, 0.0016],
    [r * 0.80, 0.0028],
    [r * 0.80, 0.0044],
    [r * 1.00, 0.0060],
    [r * 0.98, length * 0.62],
    [r * 0.92, length * 0.80],
    [r * 0.80, length * 0.94],
    [r * 0.78, length],
    [r * 0.62, length],
    [r * 0.62, length * 0.94],
    [0.0001, length * 0.94],
  ], 12);
  // Centre it on its own middle so the physics body and the mesh agree.
  g.translate(0, 0, -length / 2);
  return g;
}

export class Ejecta {
  constructor(ctx, surfaces) {
    this.ctx = ctx;
    this.surfaces = surfaces;
    this.shellCount = 26;
    this.magCount = 4;
    this.shells = [];
    this.mags = [];
    this.instanced = null;
    this._cursor = 0;
    this._magCursor = 0;
    this.ready = false;
  }

  init() {
    const { ctx } = this;
    try {
      const geo = shellGeometry(0.0049, 0.0430);
      boxUV(geo, 0.02);
      wearFromAxial(geo);
      ao(geo, 1);
      const mat = this.surfaces.get('brass');
      const mesh = new THREE.InstancedMesh(geo, mat, this.shellCount);
      mesh.name = 'weapon_shells';
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // Everything in ctx.scene that is lit MUST go through CSM setup, or it takes
      // the non-CSM shader branch and receives all four cascades at full strength.
      try { ctx.lighting?.csm?.setupMaterial?.(mat); } catch (e) { /* swept later */ }
      ctx.scene.add(mesh);
      this.instanced = mesh;

      // Park every instance far below the map.
      _m.makeTranslation(0, PARK_Y, 0);
      for (let i = 0; i < this.shellCount; i++) mesh.setMatrixAt(i, _m);
      mesh.instanceMatrix.needsUpdate = true;

      const physics = ctx.physics;
      if (physics?.world) {
        for (let i = 0; i < this.shellCount; i++) {
          const b = physics.addBox(
            [0.0098, 0.0098, 0.0430],
            { x: 0, y: PARK_Y, z: 0 },
            null,
            {
              type: 'dynamic', group: 'DEBRIS', density: 2.9,
              friction: 0.55, restitution: 0.28,
              linearDamping: 0.06, angularDamping: 0.10,
              material: 'rustMetal',
            },
          );
          if (!b) break;
          this.shells.push({ body: b.body, collider: b.collider, alive: false, t: 0, index: i });
        }
      }
      this.ready = true;
    } catch (err) {
      console.error('[weapons] ejecta init failed:', err);
      this.ready = false;
    }
  }

  /** Build the dropped-magazine mesh for a given weapon (once per weapon). */
  makeMagPrototype(id, size) {
    try {
      const w = size?.[0] ?? 0.026, h = size?.[1] ?? 0.19, d = size?.[2] ?? 0.038;
      const g = box(w, h, d, 0.0022, 1);
      boxUV(g, 0.05);
      wearFromAxes(g);
      ao(g, 0.85);
      // Clone, do not share. This prototype is parented into ctx.scene, so the
      // lighting sweep adopts its material into CSM — and that mutation is on the
      // material instance, which the *viewmodel* magazine was also using. One
      // part of the rifle then rendered down the cascade-shadow branch inside the
      // viewmodel scene while the rest of the gun did not.
      const magMat = this.surfaces.get('magPolymer')?.clone() ?? this.surfaces.get('magPolymer');
      if (magMat && magMat.name) magMat.name = `${magMat.name}_world`;
      const mesh = new THREE.Mesh(g, magMat);
      mesh.name = `dropped_mag_${id}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.visible = false;
      try { this.ctx.lighting?.csm?.setupMaterial?.(mesh.material); } catch (e) { /* swept later */ }
      this.ctx.scene.add(mesh);
      return { mesh, size: [w, h, d] };
    } catch (err) {
      console.warn('[weapons] mag prototype failed:', err);
      return null;
    }
  }

  /**
   * Eject a case.
   * @param {THREE.Vector3} pos    world position of the ejection port
   * @param {THREE.Quaternion} rot world orientation of the weapon
   * @param {THREE.Vector3} carrier player velocity, inherited by the case
   * @param {object} cfg  { speed, spread, dir }
   */
  ejectShell(pos, rot, carrier, cfg) {
    if (!this.ready || this.shells.length === 0) return;
    const e = this.shells[this._cursor % this.shells.length];
    this._cursor++;
    try {
      const dir = cfg?.dir ?? [1, 0.42, 0.2];
      _v.set(dir[0], dir[1], dir[2]).normalize().applyQuaternion(rot);
      const sp = cfg?.speed ?? 3.0;
      const jitter = cfg?.spread ?? 0.5;
      const vx = _v.x * sp + (Math.random() - 0.5) * jitter + (carrier?.x ?? 0);
      const vy = _v.y * sp + (Math.random() - 0.5) * jitter + 0.6 + (carrier?.y ?? 0);
      const vz = _v.z * sp + (Math.random() - 0.5) * jitter + (carrier?.z ?? 0);

      e.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
      e.body.setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w }, true);
      e.body.setLinvel({ x: vx, y: vy, z: vz }, true);
      e.body.setAngvel({
        x: (Math.random() - 0.5) * 46,
        y: (Math.random() - 0.5) * 30,
        z: (Math.random() - 0.5) * 46,
      }, true);
      e.alive = true;
      e.t = 0;
    } catch (err) {
      // A pooled body that Rapier has invalidated: drop it rather than throw.
      e.alive = false;
    }
  }

  /** Drop a magazine at a world transform with an initial velocity. */
  dropMag(proto, pos, rot, vel) {
    if (!proto?.mesh) return;
    const physics = this.ctx.physics;
    if (!physics?.world) return;
    try {
      // Retire the oldest if we are at the cap.
      if (this.mags.length >= this.magCount) {
        const old = this.mags.shift();
        try { physics.removeBody(old.body); } catch (e) { /* already gone */ }
        try { this.ctx.scene.remove(old.mesh); old.mesh.geometry.dispose(); } catch (e) { /* noop */ }
      }
      const mesh = proto.mesh.clone();
      mesh.geometry = proto.mesh.geometry.clone();
      // proto.mesh.material is already a world-only clone (see makeMagPrototype),
      // so Object3D.clone() sharing it here is correct and costs nothing.
      mesh.visible = true;
      mesh.position.copy(pos);
      mesh.quaternion.copy(rot);
      this.ctx.scene.add(mesh);
      try {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) this.ctx.lighting?.csm?.setupMaterial?.(m);
      } catch (e) { /* swept later */ }

      const res = physics.addBox(
        proto.size,
        { x: pos.x, y: pos.y, z: pos.z },
        { x: rot.x, y: rot.y, z: rot.z, w: rot.w },
        {
          type: 'dynamic', group: 'DEBRIS', density: 1.1,
          friction: 0.85, restitution: 0.12,
          linearDamping: 0.10, angularDamping: 0.35,
          material: 'rubber', mesh,
        },
      );
      if (!res) { this.ctx.scene.remove(mesh); return; }
      res.body.setLinvel({
        x: (vel?.x ?? 0) + (Math.random() - 0.5) * 0.5,
        y: (vel?.y ?? 0) - 0.5,
        z: (vel?.z ?? 0) + (Math.random() - 0.5) * 0.5,
      }, true);
      res.body.setAngvel({
        x: (Math.random() - 0.5) * 7,
        y: (Math.random() - 0.5) * 5,
        z: (Math.random() - 0.5) * 7,
      }, true);
      this.mags.push({ body: res.body, mesh, t: 0 });
    } catch (err) {
      console.warn('[weapons] dropMag failed:', err);
    }
  }

  update(dt) {
    if (!this.ready) return;
    const mesh = this.instanced;
    if (mesh) {
      let dirty = false;
      for (const e of this.shells) {
        if (!e.alive) continue;
        e.t += dt;
        try {
          const t = e.body.translation();
          const r = e.body.rotation();
          _v.set(t.x, t.y, t.z);
          _q.set(r.x, r.y, r.z, r.w);
          // Fade out by shrinking, then park.
          let scale = 1;
          if (e.t > 11) scale = Math.max(0, 1 - (e.t - 11) / 1.6);
          if (scale <= 0.02 || t.y < -40) {
            e.alive = false;
            e.body.setTranslation({ x: 0, y: PARK_Y, z: 0 }, false);
            e.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
            e.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
            e.body.sleep?.();
            _m.makeTranslation(0, PARK_Y, 0);
          } else {
            _s.set(scale, scale, scale);
            _m.compose(_v, _q, _s);
          }
          mesh.setMatrixAt(e.index, _m);
          dirty = true;
        } catch (err) {
          e.alive = false;
        }
      }
      if (dirty) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.computeBoundingSphere) mesh.boundingSphere = null;
      }
    }

    for (let i = this.mags.length - 1; i >= 0; i--) {
      const m = this.mags[i];
      m.t += dt;
      if (m.t > 26) {
        try { this.ctx.physics?.removeBody(m.body); } catch (e) { /* noop */ }
        try { this.ctx.scene.remove(m.mesh); m.mesh.geometry.dispose(); } catch (e) { /* noop */ }
        this.mags.splice(i, 1);
      }
    }
  }

  dispose() {
    try {
      for (const e of this.shells) { try { this.ctx.physics?.removeBody(e.body); } catch (err) { /* noop */ } }
      this.shells.length = 0;
      for (const m of this.mags) {
        try { this.ctx.physics?.removeBody(m.body); } catch (err) { /* noop */ }
        try { this.ctx.scene.remove(m.mesh); } catch (err) { /* noop */ }
      }
      this.mags.length = 0;
      if (this.instanced) {
        this.ctx.scene.remove(this.instanced);
        this.instanced.geometry.dispose();
      }
    } catch (err) { /* teardown is best-effort */ }
  }
}

export default Ejecta;
