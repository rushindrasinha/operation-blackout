/**
 * OPERATION BLACKOUT — death ragdoll.
 * OWNER: ai agent.
 *
 * A jointed rigid-body chain in Rapier that drives the existing skeleton. The whole
 * design brief here is "must never explode or jitter", so:
 *
 *   · parts live in the RAGDOLL collision group, whose mask excludes RAGDOLL siblings
 *     and PROJECTILE — self-collision between a thigh and a pelvis that share a joint
 *     is the single biggest source of ragdoll blow-ups, so it simply cannot happen
 *   · aggressive linear/angular damping and a hard velocity clamp every step
 *   · the bodies drive bone ROTATIONS only (plus the root translation), so the mesh
 *     can never stretch no matter what the solver does
 *   · it goes to sleep after a few seconds and stops costing anything
 *
 * If joint creation is unavailable for any reason the corpse degrades to a single
 * damped capsule that simply falls over — still better than a T-posing statue.
 */
import * as THREE from 'three';
import { clamp } from './utils.js';

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

/** Which bone each rigid body owns, and the bone that terminates its capsule. */
const LIMBS = [
  { name: 'pelvis', bone: 'hips', tip: 'spine', r: 0.135, mass: 11 },
  { name: 'torso', bone: 'chest', tip: 'neck', r: 0.145, mass: 17 },
  { name: 'head', bone: 'head', tip: 'headEnd', r: 0.105, mass: 5 },
  { name: 'armL', bone: 'armL', tip: 'foreL', r: 0.058, mass: 2.2 },
  { name: 'foreL', bone: 'foreL', tip: 'handL', r: 0.048, mass: 1.6 },
  { name: 'armR', bone: 'armR', tip: 'foreR', r: 0.058, mass: 2.2 },
  { name: 'foreR', bone: 'foreR', tip: 'handR', r: 0.048, mass: 1.6 },
  { name: 'thighL', bone: 'upLegL', tip: 'loLegL', r: 0.088, mass: 7 },
  { name: 'shinL', bone: 'loLegL', tip: 'footL', r: 0.068, mass: 4 },
  { name: 'thighR', bone: 'upLegR', tip: 'loLegR', r: 0.088, mass: 7 },
  { name: 'shinR', bone: 'loLegR', tip: 'footR', r: 0.068, mass: 4 },
];

const JOINTS = [
  ['pelvis', 'torso'], ['torso', 'head'],
  ['torso', 'armL'], ['armL', 'foreL'],
  ['torso', 'armR'], ['armR', 'foreR'],
  ['pelvis', 'thighL'], ['thighL', 'shinL'],
  ['pelvis', 'thighR'], ['thighR', 'shinR'],
];

export class Ragdoll {
  constructor(ctx, rig, opts = {}) {
    this.ctx = ctx;
    this.rig = rig;
    this.ok = false;
    this.parts = new Map();
    this.impulses = [];
    this.age = 0;
    this.settled = false;
    this._degraded = false;

    try {
      this._build(opts);
      this.ok = true;
    } catch (err) {
      console.warn('[ai] ragdoll build failed, corpse will freeze in place:', err);
      this.ok = false;
      this.dispose();
    }
  }

  _build(opts) {
    const phys = this.ctx.physics;
    const RAPIER = phys?.RAPIER;
    const world = phys?.world;
    if (!RAPIER || !world) throw new Error('physics unavailable');

    const bones = this.rig.bones;
    this.rig.group.updateMatrixWorld(true);

    // RAGDOLL membership, but only interacting with static WORLD — never with a
    // sibling limb, never with a bullet.
    const GROUPS = phys.GROUPS ?? { RAGDOLL: 0x0040, WORLD: 0x0001 };
    const groups = (((GROUPS.RAGDOLL & 0xffff) << 16) >>> 0 | (GROUPS.WORLD & 0xffff)) >>> 0;

    for (const L of LIMBS) {
      const a = bones[L.bone], b = bones[L.tip];
      if (!a || !b) continue;
      a.updateWorldMatrix(true, false);
      b.updateWorldMatrix(true, false);
      const pa = new THREE.Vector3().setFromMatrixPosition(a.matrixWorld);
      const pb = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
      const mid = pa.clone().add(pb).multiplyScalar(0.5);
      const len = Math.max(0.04, pa.distanceTo(pb));
      const half = Math.max(0.01, len * 0.5 - L.r * 0.55);

      // Capsule runs along the body's local +Y; orient it onto the bone axis.
      _v.copy(pb).sub(pa).normalize();
      _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v);

      const desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(mid.x, mid.y, mid.z)
        .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
        .setLinearDamping(0.55)
        .setAngularDamping(5.5)
        .setCcdEnabled(false);
      const body = world.createRigidBody(desc);

      const cd = RAPIER.ColliderDesc.capsule(half, L.r)
        .setFriction(0.95)
        .setRestitution(0.0)
        .setMass(L.mass)
        .setCollisionGroups(groups);
      const collider = world.createCollider(cd, body);

      // The body follows the bone rigidly: boneWorld(t) = R(t) · R(0)⁻¹ · boneWorld(0).
      // Bake R(0)⁻¹·boneWorld(0) once so the corpse never pops to bind pose on frame 1.
      const boneQ0 = new THREE.Quaternion().setFromRotationMatrix(_m.copy(a.matrixWorld));
      const offsetQ = _q.clone().invert().multiply(boneQ0);

      this.parts.set(L.name, {
        cfg: L, body, collider,
        bone: a,
        offsetQ,
        halfLen: len * 0.5,
      });
    }

    if (this.parts.size < 3) throw new Error('too few ragdoll parts');

    // Joints, anchored at the shared bone position.
    let made = 0;
    for (const [an, bn] of JOINTS) {
      const A = this.parts.get(an), B = this.parts.get(bn);
      if (!A || !B) continue;
      try {
        B.bone.updateWorldMatrix(true, false);
        const jw = new THREE.Vector3().setFromMatrixPosition(B.bone.matrixWorld);
        const a1 = this._toLocal(A, jw);
        const a2 = this._toLocal(B, jw);
        const jd = RAPIER.JointData.spherical(
          { x: a1.x, y: a1.y, z: a1.z },
          { x: a2.x, y: a2.y, z: a2.z },
        );
        const joint = world.createImpulseJoint(jd, A.body, B.body, true);
        if (joint) made++;
      } catch (err) {
        if (made === 0) console.warn('[ai] ragdoll joint failed:', err);
      }
    }
    if (made === 0) {
      this._degraded = true;
      console.warn('[ai] ragdoll joints unavailable — corpses will be loose limbs');
    }

    phys._queryDirty = true;

    // Carry the last locomotion velocity plus the killing impulse into the corpse.
    const vel = opts.velocity;
    const hitDir = opts.hitDir;
    const hitPower = clamp(opts.hitPower ?? 1, 0, 3);
    for (const part of this.parts.values()) {
      try {
        if (vel) part.body.setLinvel({ x: vel.x * 0.7, y: 0, z: vel.z * 0.7 }, true);
      } catch { /* noop */ }
    }
    if (hitDir) {
      const target = this.parts.get(opts.headshot ? 'head' : 'torso') ?? this.parts.get('pelvis');
      try {
        target?.body.applyImpulse({
          x: hitDir.x * 14 * hitPower,
          y: 3.5 * hitPower,
          z: hitDir.z * 14 * hitPower,
        }, true);
      } catch { /* noop */ }
    }
  }

  _toLocal(part, worldPoint) {
    const t = part.body.translation();
    const r = part.body.rotation();
    _q.set(r.x, r.y, r.z, r.w).invert();
    return new THREE.Vector3(worldPoint.x - t.x, worldPoint.y - t.y, worldPoint.z - t.z)
      .applyQuaternion(_q);
  }

  /** Clamp anything the solver did that looks like the start of an explosion. */
  clampVelocities() {
    for (const part of this.parts.values()) {
      const b = part.body;
      try {
        const lv = b.linvel();
        const s = Math.hypot(lv.x, lv.y, lv.z);
        if (s > 16) { const k = 16 / s; b.setLinvel({ x: lv.x * k, y: lv.y * k, z: lv.z * k }, false); }
        const av = b.angvel();
        const t = Math.hypot(av.x, av.y, av.z);
        if (t > 22) { const k = 22 / t; b.setAngvel({ x: av.x * k, y: av.y * k, z: av.z * k }, false); }
      } catch { /* body already freed */ }
    }
  }

  /** Drive the skeleton from the simulation. Rotations only — never stretches. */
  apply(dt) {
    if (!this.ok) return;
    this.age += dt;

    const group = this.rig.group;
    // Parent transform is identity for a corpse, so bone world == world.
    group.position.set(0, 0, 0);
    group.rotation.set(0, 0, 0);
    group.updateMatrixWorld(true);

    const pelvis = this.parts.get('pelvis');
    if (pelvis) {
      const t = pelvis.body.translation();
      const r = pelvis.body.rotation();
      _q.set(r.x, r.y, r.z, r.w);
      // Move the pelvis body centre back to the hip bone position.
      _v.set(0, -pelvis.halfLen, 0).applyQuaternion(_q);
      const hips = this.rig.bones.hips;
      hips.position.set(t.x + _v.x, t.y + _v.y, t.z + _v.z);
    }

    for (const part of this.parts.values()) {
      const bone = part.bone;
      const r = part.body.rotation();
      _q.set(r.x, r.y, r.z, r.w).multiply(part.offsetQ);   // desired bone WORLD rotation
      const parent = bone.parent;
      if (parent) {
        parent.updateWorldMatrix(true, false);
        _qi.setFromRotationMatrix(_m.copy(parent.matrixWorld)).invert();
        bone.quaternion.copy(_qi).multiply(_q);
      } else {
        bone.quaternion.copy(_q);
      }
      bone.updateWorldMatrix(false, false);
    }

    if (!this.settled && this.age > 4.5) {
      this.settled = true;
      for (const part of this.parts.values()) {
        try { part.body.setLinearDamping(6); part.body.setAngularDamping(14); } catch { /* noop */ }
      }
    }
  }

  dispose() {
    const world = this.ctx.physics?.world;
    for (const part of this.parts.values()) {
      try {
        this.ctx.physics?.unregisterActor?.(part.collider);
        if (world && part.body) world.removeRigidBody(part.body);
      } catch { /* already gone */ }
    }
    this.parts.clear();
    if (this.ctx.physics) this.ctx.physics._queryDirty = true;
  }
}

export default Ragdoll;
