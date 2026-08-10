/**
 * OPERATION BLACKOUT — procedural soldier animation.
 * OWNER: ai agent.
 *
 * No clips, no bakes. Everything here is solved every frame from the bot's motion
 * state, which is what lets a bot walk a curved path at an arbitrary speed while
 * aiming somewhere else entirely.
 *
 * The three things that separate this from "cubes sliding around":
 *
 *  1. FOOT PLANTING. The stance foot is pinned to a world position and the gait
 *     phase is driven by DISTANCE TRAVELLED, not by time. Sliding is therefore
 *     impossible by construction rather than by tuning. The pelvis is then dropped
 *     to whatever height keeps both legs inside their reach — that hip dip over a
 *     long stride is most of what reads as "weight".
 *  2. INDEPENDENT UPPER BODY. Legs face the direction of travel; the spine, chest
 *     and neck twist toward the target and the arms IK onto the weapon. A soldier
 *     who strafes while keeping his muzzle on you reads as trained; one who turns
 *     his whole body to walk reads as a turret.
 *  3. ANALYTIC TWO-BONE IK with explicit pole vectors, so knees always break
 *     forward and elbows always break down-and-out.
 *
 * Scratch discipline: the IK solver has its own private vector pool (`k*`) that no
 * caller may pass in, because callers hand it targets by reference.
 */
import * as THREE from 'three';
import { BONE_ORDER, BIND } from './SoldierRig.js';
import { clamp, clamp01, lerp, smoothstep, angleDelta, damp, dampAngle, TAU } from './utils.js';

/* ── solver-private scratch ───────────────────────────────────────────────── */
const k0 = new THREE.Vector3(), k1 = new THREE.Vector3(), k2 = new THREE.Vector3();
const k3 = new THREE.Vector3(), k4 = new THREE.Vector3(), k5 = new THREE.Vector3();
const kx = new THREE.Vector3(), ky = new THREE.Vector3(), kz = new THREE.Vector3();
const km = new THREE.Matrix4();
const kqa = new THREE.Quaternion(), kqb = new THREE.Quaternion();

/* ── caller scratch ───────────────────────────────────────────────────────── */
const t0 = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
const t3 = new THREE.Vector3(), t4 = new THREE.Vector3();
const ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3();
const tm = new THREE.Matrix4();
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion();
const eul = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

const ANKLE_H = BIND.footL[1];        // ankle height above the sole in bind pose
const HIP_DROP = BIND.hips[1] - BIND.upLegL[1];  // pelvis origin sits above the hip joint

/** Orient a bone whose rest child-offset points along local -Y. */
function orientBone(bone, childDirWorld, bendAxisWorld) {
  ky.copy(childDirWorld).negate().normalize();
  kx.copy(bendAxisWorld);
  kx.addScaledVector(ky, -kx.dot(ky));           // orthogonalise against the bone axis
  if (kx.lengthSq() < 1e-8) {
    kx.set(1, 0, 0).addScaledVector(ky, -ky.x);
    if (kx.lengthSq() < 1e-8) kx.set(0, 0, 1).addScaledVector(ky, -ky.z);
  }
  kx.normalize();
  kz.crossVectors(kx, ky).normalize();
  km.makeBasis(kx, ky, kz);
  kqa.setFromRotationMatrix(km);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(kqb);
    bone.quaternion.copy(kqb.invert()).multiply(kqa);
  } else {
    bone.quaternion.copy(kqa);
  }
}

/** Analytic two-bone IK. `upper`/`lower` rest child offsets must run along -Y. */
function twoBoneIK(upper, lower, end, targetW, poleW) {
  const l1 = lower.position.length();
  const l2 = end.position.length();
  if (l1 < 1e-5 || l2 < 1e-5) return;

  upper.updateWorldMatrix(true, false);
  k0.setFromMatrixPosition(upper.matrixWorld);

  k1.copy(targetW).sub(k0);
  let d = k1.length();
  const maxReach = (l1 + l2) * 0.995;
  const minReach = Math.abs(l1 - l2) + 0.02;
  if (d < 1e-5) { k1.set(0, -1, 0); d = 0.05; } else k1.divideScalar(d);
  d = clamp(d, minReach, maxReach);

  k2.copy(poleW).sub(k0);
  k2.addScaledVector(k1, -k2.dot(k1));
  if (k2.lengthSq() < 1e-8) {
    k2.set(0, 0, 1).addScaledVector(k1, -k1.z);
    if (k2.lengthSq() < 1e-8) k2.set(1, 0, 0).addScaledVector(k1, -k1.x);
  }
  k2.normalize();

  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const angA = Math.acos(cosA);

  k3.copy(k1).multiplyScalar(Math.cos(angA) * l1)
    .addScaledVector(k2, Math.sin(angA) * l1)
    .add(k0);                                     // world position of the mid joint

  k5.crossVectors(k1, k2).normalize();            // one shared bend axis: no twist

  k4.copy(k3).sub(k0).normalize();
  orientBone(upper, k4, k5);
  upper.updateWorldMatrix(false, false);
  lower.updateWorldMatrix(true, false);

  k4.copy(targetW).sub(k3);
  if (k4.lengthSq() < 1e-8) k4.set(0, -1, 0); else k4.normalize();
  orientBone(lower, k4, k5);
  lower.updateWorldMatrix(false, false);
}

/* ────────────────────────────────────────────────────────────────────────── */

export class SoldierAnim {
  constructor(bot, rig, template) {
    this.bot = bot;
    this.rig = rig;
    this.bones = rig.bones;
    this.rest = rig.rest;
    this.anchors = template.anchors;

    this.phase = Math.random();
    this.swayPhase = Math.random() * TAU;

    this.feet = [];
    for (let i = 0; i < 2; i++) {
      this.feet.push({
        side: i === 0 ? 1 : -1,
        plant: new THREE.Vector3(),
        from: new THREE.Vector3(),
        target: new THREE.Vector3(),
        current: new THREE.Vector3(),
        swinging: false,
        initialised: false,
        phase: i * 0.5,
        phaseLocal: 0,
        swingT: -1,
        ankleLift: 0,
      });
    }

    this.hipY = 0;
    this.crouch = 0;
    this.lean = 0;
    this.aimBlend = 0;
    this.headYaw = 0;
    this.headPitch = 0;
    this.twist = 0;
    this.pitchSmooth = 0;

    this.hitImpulse = 0;
    this.hitDir = new THREE.Vector3(0, 0, 1);
    this.recoil = 0;
    this.recoilVel = 0;

    this.muzzleWorld = new THREE.Vector3();
    this.muzzleDir = new THREE.Vector3(0, 0, 1);
    this.muzzleMatrix = new THREE.Matrix4();

    this._reset();
  }

  _reset() {
    for (const name of BONE_ORDER) {
      const b = this.bones[name];
      b.position.copy(this.rest[name]);
      b.quaternion.identity();
    }
  }

  /** Re-seat the gait without smearing feet across the map. */
  teleport(pos) {
    for (const f of this.feet) {
      f.initialised = false;
      f.plant.copy(pos); f.current.copy(pos); f.target.copy(pos); f.from.copy(pos);
    }
    this.hipY = 0;
  }

  addHit(dirWorld, power = 1) {
    this.hitImpulse = Math.min(1.4, this.hitImpulse + power);
    if (dirWorld) {
      this.hitDir.copy(dirWorld).setY(0);
      if (this.hitDir.lengthSq() > 1e-6) this.hitDir.normalize();
    }
  }

  addRecoil(power = 1) { this.recoilVel += power * 9.0; }

  /* ── the frame ──────────────────────────────────────────────────────── */

  update(dt, s) {
    const bones = this.bones;
    const group = this.rig.group;

    this._reset();

    /* 1 — pose scalars */
    this.crouch = damp(this.crouch, s.crouch ? 1 : 0, 7, dt);
    this.aimBlend = damp(this.aimBlend, s.aiming ? 1 : 0, 8, dt);
    this.hitImpulse = Math.max(0, this.hitImpulse - dt * 2.6);

    // recoil as a damped spring rather than a decaying ramp
    this.recoilVel -= (this.recoil * 260 + this.recoilVel * 22) * dt;
    this.recoil = clamp(this.recoil + this.recoilVel * dt, -0.45, 0.45);

    const speed = s.speed;
    const running = speed > 4.0;
    this.swayPhase += dt * (0.9 + speed * 0.12);
    const breath = Math.sin(this.swayPhase * 1.35) * 0.5 + Math.sin(this.swayPhase * 0.61) * 0.5;

    /* 2 — gait phase, driven by distance
     *
     * Step length is deliberately shorter than a real human's. It has to be: the
     * stance foot is pinned in world space, so the pelvis must stay within leg
     * reach of it for the whole stance phase, and `legReach` here is 0.82m. A
     * realistic 1.2m step would drag the hips to 0.6m off the deck at toe-off.
     * Shorter steps at a higher cadence is exactly the trade every IK-driven
     * locomotion system makes, and nobody reads cadence — everybody reads sliding.
     */
    const stride = clamp(0.48 + speed * 0.070, 0.50, 0.78) * (1 - this.crouch * 0.24);
    const cycle = stride * 2;
    const moving = speed > 0.22;

    const duty = running ? 0.52 : 0.60;     // a run has a real flight phase
    this._duty = duty;
    const lift = (running ? 0.19 : 0.105) * (1 - this.crouch * 0.35);

    /* 3 — feet */
    const groundY = s.groundY;
    const fwdX = Math.sin(s.bodyYaw), fwdZ = Math.cos(s.bodyYaw);
    const rgtX = fwdZ, rgtZ = -fwdX;
    const halfStance = 0.098 * (1 + this.crouch * 0.3);
    const legReach = (bones.loLegL.position.length() + bones.footL.position.length()) * 0.985;
    const advance = moving ? (speed * dt) / Math.max(0.2, cycle) : 0;

    // Standing → walking. Both feet are square under the body at rest, so if the
    // phases are left alone one leg spends most of the first cycle trailing and
    // the pelvis has to dive to stay attached to it. Kick the trailing foot into
    // its swing immediately and reseat the other at the top of stance.
    if (moving && !this._wasMoving) {
      const f0 = this.feet[0], f1 = this.feet[1];
      const behind = (f) => (f.current.x - s.px) * fwdX + (f.current.z - s.pz) * fwdZ;
      const first = behind(f0) <= behind(f1) ? f0 : f1;
      const second = first === f0 ? f1 : f0;
      first.phase = duty;
      second.phase = 0.04;
    }
    this._wasMoving = moving;

    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const lateral = f.side * halfStance;
      const other = this.feet[1 - i];
      const neutralX = s.px + rgtX * lateral;
      const neutralZ = s.pz + rgtZ * lateral;
      if (!f.initialised) {
        f.phase = i * 0.5;
        f.plant.set(neutralX, groundY, neutralZ);
        f.from.copy(f.plant); f.target.copy(f.plant); f.current.copy(f.plant);
        f.initialised = true;
      }

      // Each foot carries its own phase so a single leg can be re-planted early
      // without desynchronising the other one. A shared phase means the only way
      // out of an over-extended stance is to drag the hips down — which is what
      // used to collapse a sprinting bot into the floor on a hard turn.
      if (f.phase >= duty) {
        // Airborne. Distance-driven, but with a floor on the rate so a corrective
        // step still completes when the bot has stopped or crawls.
        f.phase += Math.max(advance, dt * 1.5);
      } else {
        // STANCE IS PINNED. Advancing purely by distance travelled is the entire
        // no-sliding guarantee, so this branch must never be time-driven.
        f.phase += moving ? advance : dt * 0.03;

        // Two escape hatches, both of which start a fresh step rather than letting
        // the pelvis sink: the leg running out of reach (hard turns, sudden speed
        // changes), and the feet left splayed where the last stride ended after the
        // bot has come to a halt.
        const dx = f.current.x - s.px, dz = f.current.z - s.pz;
        const along = dx * fwdX + dz * fwdZ;
        const side = dx * rgtX + dz * rgtZ - lateral;
        const replantAt = Math.max(0.40, duty * cycle * 0.5 + 0.05);
        const reach = Math.hypot(along, side);
        const settling = speed < 0.6
          && Math.hypot(f.current.x - neutralX, f.current.z - neutralZ) > 0.16;
        // Normally we refuse to lift both feet at once — but a leg that is badly
        // over-extended has to go now, because the alternative is the pelvis
        // dropping through the floor to stay in reach of it. A foot already past
        // the apex of its swing counts as "nearly down" for this purpose.
        const grounded = other.phase < duty * 0.92
          || (other.phase - duty) / (1 - duty) > 0.45;
        if ((reach > replantAt && grounded) || reach > replantAt * 1.15 || (settling && grounded)) {
          f.phase = duty;
        }
      }
      if (f.phase >= 1) f.phase -= Math.floor(f.phase);

      const local = f.phase;
      const swinging = local >= duty;

      if (swinging && !f.swinging) {
        f.from.copy(f.current);
        f.groundSampledAt = -999;
      } else if (!swinging && f.swinging) {
        f.plant.copy(f.target);
      }
      f.swinging = swinging;

      if (swinging) {
        // Re-aim the landing point EVERY frame, not just at lift-off. Solving it
        // once means a bot that stops or turns mid-swing plants the foot where it
        // was going a third of a second ago — which is exactly how you end up with
        // a stance foot a metre out in front and the pelvis diving to reach it.
        //
        // Remaining swing covers (1-local) of a cycle, so the body will travel
        // (1-local)*cycle further before touchdown; land the foot duty*cycle/2
        // ahead of where the body will be then.
        const ahead = moving ? ((1 - local) + duty * 0.5) * cycle : 0;
        const tx = neutralX + fwdX * ahead;
        const tz = neutralZ + fwdZ * ahead;
        if (Math.hypot(tx - f.target.x, tz - f.target.z) > 0.22 || f.groundSampledAt < 0) {
          f.target.set(tx, this.bot.sampleGround(tx, tz, groundY), tz);
          f.groundSampledAt = 1;
        } else {
          f.target.x = tx; f.target.z = tz;
        }
      }

      if (swinging) {
        const t = (local - duty) / (1 - duty);
        // Land slightly before the phase formally ends and hold. Without this the
        // foot is still a few centimetres short when the phase wraps and it snaps
        // the last of the way in one frame — a 4 m/s pop on a "planted" foot.
        const k = clamp01(t * 1.14);
        f.current.lerpVectors(f.from, f.target, smoothstep(k));
        f.current.y += Math.sin(Math.PI * k) * lift * (moving ? 1 : 0.22);
        f.swingT = t;
        // Carry the ankle-over-toe rise off push-off and back into the heel-strike
        // rise, so the ankle target is C0 continuous across both transitions. A
        // 28mm step in the target at touchdown is a 1.7 m/s pop on a planted foot.
        f.ankleLift = 0.100 * (1 - smoothstep(t / 0.25)) + 0.028 * smoothstep((t - 0.70) / 0.30);
      } else {
        f.current.copy(f.plant);
        f.swingT = -1;
        // The ankle is only on the deck through mid-stance. It rides up over the
        // heel at contact and well up over the toe at push-off, and that rise is
        // what buys the leg the reach it needs at the ends of the stride.
        const u = clamp01(local / duty);
        f.ankleLift = (0.028 * (1 - smoothstep(u / 0.25))
          + 0.100 * smoothstep((u - 0.55) / 0.45)) * (moving ? 1 : 0.15);
      }
      f.phaseLocal = local;
    }
    // Body rhythm (bob, hip swing, arm counter-swing) rides the left foot.
    this.phase = this.feet[0].phase;

    /* 4 — pelvis height: the constraint that produces weight */
    let standY = groundY + BIND.hips[1] - this.crouch * 0.34;
    standY -= Math.cos(this.phase * TAU * 2) * (moving ? 0.017 + speed * 0.006 : 0.004);
    standY += breath * 0.006;

    for (const f of this.feet) {
      // Only a foot that is actually bearing weight constrains the pelvis. A
      // swinging foot reaches well past the hip near the end of its arc, and
      // letting it vote here is what used to dip the hips on every step.
      if (f.swingT >= 0) continue;
      const dx = f.current.x - s.px, dz = f.current.z - s.pz;
      const along = dx * fwdX + dz * fwdZ;
      const side = dx * rgtX + dz * rgtZ - f.side * halfStance;
      const horiz = Math.hypot(along, side);
      const allowed = Math.sqrt(Math.max(0.0025, legReach * legReach - horiz * horiz));
      standY = Math.min(standY, f.current.y + ANKLE_H + (f.ankleLift || 0) + allowed + HIP_DROP);
    }
    // Safety net. The early-replant logic above should make this unreachable, but
    // if it ever is reached a slightly over-extended leg (the IK clamps the reach)
    // looks infinitely better than a soldier sinking into the tarmac.
    standY = Math.max(standY, groundY + BIND.hips[1] - this.crouch * 0.34 - 0.19);
    // Asymmetric: the pelvis floats up gently but must come DOWN almost
    // immediately, because `standY` is the reach limit — lagging above it leaves
    // the leg over-extended and the IK visibly short of the plant, which reads as
    // the foot skating. Rising is cosmetic; falling is a constraint.
    this.hipY = this.hipY === 0 ? standY
      : damp(this.hipY, standY, standY < this.hipY ? 95 : 22, dt);
    if (Math.abs(this.hipY - standY) > 0.6) this.hipY = standY;

    group.position.set(s.px, groundY, s.pz);
    group.rotation.set(0, s.bodyYaw, 0);

    /* 5 — spine chain */
    const hips = bones.hips;
    hips.position.y = this.hipY - groundY;
    hips.position.x = moving ? Math.sin(this.phase * TAU) * 0.015 : 0;
    hips.position.z = -this.crouch * 0.05;

    const twistTarget = clamp(angleDelta(s.bodyYaw, s.aimYaw), -1.45, 1.45);
    this.twist = dampAngle(this.twist, twistTarget, 11, dt);
    this.pitchSmooth = damp(this.pitchSmooth, clamp(s.aimPitch, -0.85, 0.85), 11, dt);

    const hipSwing = moving ? Math.sin(this.phase * TAU) * (0.16 + speed * 0.012) : 0;
    const shoulderSwing = -hipSwing * 0.55;
    const hitK = this.hitImpulse;
    const hitFwd = this.hitDir.x * fwdX + this.hitDir.z * fwdZ;
    const hitSide = this.hitDir.x * rgtX + this.hitDir.z * rgtZ;

    eul.set(
      moving ? Math.sin(this.phase * TAU * 2) * 0.03 : 0,
      hipSwing * 0.55 + this.twist * 0.10,
      moving ? Math.sin(this.phase * TAU) * 0.045 : 0,
      'YXZ',
    );
    hips.quaternion.setFromEuler(eul);

    const leanTarget = clamp(s.leanForward, -0.25, 0.45) + this.crouch * 0.16 + (running ? 0.14 : 0);
    this.lean = damp(this.lean, leanTarget, 8, dt);

    eul.set(
      this.lean * 0.42 + this.pitchSmooth * 0.18 * this.aimBlend + hitK * hitFwd * 0.22,
      this.twist * 0.30 - hipSwing * 0.12,
      breath * 0.012 + hitK * hitSide * 0.18,
      'YXZ',
    );
    bones.spine.quaternion.setFromEuler(eul);

    eul.set(
      this.lean * 0.34 + this.pitchSmooth * 0.30 * this.aimBlend - this.recoil * 0.5 + hitK * hitFwd * 0.30,
      this.twist * 0.44 + shoulderSwing * 0.35,
      breath * 0.02 + hitK * hitSide * 0.24 + shoulderSwing * 0.08,
      'YXZ',
    );
    bones.chest.quaternion.setFromEuler(eul);

    const headYawT = clamp(angleDelta(s.bodyYaw + this.twist, s.lookYaw), -0.95, 0.95);
    const headPitchT = clamp(s.lookPitch - this.pitchSmooth * 0.48 * this.aimBlend, -0.6, 0.55);
    this.headYaw = dampAngle(this.headYaw, headYawT, 9, dt);
    this.headPitch = damp(this.headPitch, headPitchT, 9, dt);

    eul.set(this.headPitch * 0.42 - this.lean * 0.22, this.headYaw * 0.45, 0, 'YXZ');
    bones.neck.quaternion.setFromEuler(eul);
    eul.set(this.headPitch * 0.58 - this.lean * 0.30 - hitK * 0.25, this.headYaw * 0.55, breath * 0.02, 'YXZ');
    bones.head.quaternion.setFromEuler(eul);

    /* 6 — weapon carriage */
    this._poseWeapon(s);

    /* 7 — flush the torso so the IK reads correct world matrices */
    group.updateMatrixWorld(true);

    /* 8 — legs */
    this._legIK(0, bones.upLegL, bones.loLegL, bones.footL, fwdX, fwdZ);
    this._legIK(1, bones.upLegR, bones.loLegR, bones.footR, fwdX, fwdZ);

    /* 9 — arms onto the weapon */
    this._armIK(fwdX, fwdZ, rgtX, rgtZ);

    /* 10 — cache the muzzle for the shooting code */
    const wb = bones.weapon;
    wb.updateWorldMatrix(true, false);
    this.muzzleMatrix.copy(wb.matrixWorld);
    this.muzzleWorld.copy(this.anchors.muzzle).applyMatrix4(wb.matrixWorld);
    this.muzzleDir.set(0, 0, 1).transformDirection(wb.matrixWorld);
  }

  _poseWeapon(s) {
    const wb = this.bones.weapon;
    const rest = this.rest.weapon;
    const aim = this.aimBlend;

    wb.position.set(
      lerp(rest.x + 0.050, rest.x + 0.004, aim),
      lerp(rest.y - 0.048, rest.y + 0.050, aim) - this.crouch * 0.02,
      lerp(rest.z - 0.030, rest.z + 0.018, aim) - this.recoil * 0.05,
    );

    const sway = Math.sin(this.swayPhase * 0.83) * 0.02 + Math.sin(this.swayPhase * 1.9) * 0.008;
    const bounce = s.speed > 0.22 ? Math.sin(this.phase * TAU * 2) * (0.03 + s.speed * 0.008) : 0;

    // low-ready / patrol carry, expressed in the chest's frame
    eul.set(-0.60 + bounce + sway * 0.5, 0.30, -0.28, 'YXZ');
    qb.setFromEuler(eul);

    if (aim > 0.015 && s.aimTarget) {
      // Solve the bore in world space so the muzzle stays honest while the torso
      // twists, bobs and recoils, then pull the result back into chest space.
      wb.updateWorldMatrix(true, false);
      t0.setFromMatrixPosition(wb.matrixWorld);
      t1.copy(s.aimTarget).sub(t0);
      if (t1.lengthSq() < 1e-6) t1.set(Math.sin(s.aimYaw), 0, Math.cos(s.aimYaw));
      t1.normalize();

      az.copy(t1);
      ay.copy(UP).addScaledVector(az, -UP.dot(az));
      if (ay.lengthSq() < 1e-6) ay.set(0, 0, 1).addScaledVector(az, -az.z);
      ay.normalize();
      ax.crossVectors(ay, az).normalize();
      tm.makeBasis(ax, ay, az);
      qa.setFromRotationMatrix(tm);

      qc.setFromAxisAngle(az, -0.11 + sway * 0.4);   // outboard cant
      qa.multiply(qc);
      qc.setFromAxisAngle(ax, this.recoil * 1.1 + bounce * 0.35);
      qa.premultiply(qc);

      wb.parent.getWorldQuaternion(qc);
      qa.premultiply(qc.invert());
      wb.quaternion.copy(qb).slerp(qa, smoothstep(aim));
    } else {
      wb.quaternion.copy(qb);
    }
  }

  _legIK(i, up, lo, foot, fwdX, fwdZ) {
    const f = this.feet[i];
    up.updateWorldMatrix(true, false);
    t0.setFromMatrixPosition(up.matrixWorld);

    t1.set(f.current.x, f.current.y + ANKLE_H + (f.ankleLift || 0), f.current.z);
    // Knee pole: well forward of the hip and a little low. Knees never break back.
    t2.set(t0.x + fwdX * 1.15, t0.y - 0.25, t0.z + fwdZ * 1.15);
    twoBoneIK(up, lo, foot, t1, t2);

    // Foot roll. Positive pitch is toe-DOWN for this bone (its child offset runs
    // +Z), so heel strike is negative and push-off is positive.
    const gaitGain = this.bot.speed > 0.3 ? 1 : 0.12;
    let pitch;
    if (f.swingT >= 0) {
      const t = f.swingT;
      pitch = (t < 0.35 ? lerp(0.50, -0.12, smoothstep(t / 0.35))
        : lerp(-0.12, -0.30, smoothstep((t - 0.35) / 0.65))) * gaitGain;
    } else {
      const u = clamp01(f.phaseLocal / this._duty);
      pitch = (u < 0.22 ? lerp(-0.30, 0, smoothstep(u / 0.22))
        : u > 0.55 ? lerp(0, 0.52, smoothstep((u - 0.55) / 0.45)) : 0) * gaitGain;
    }
    foot.updateWorldMatrix(true, false);
    foot.parent.getWorldQuaternion(qa);
    eul.set(pitch, Math.atan2(fwdX, fwdZ), 0, 'YXZ');
    qb.setFromEuler(eul);
    foot.quaternion.copy(qa.invert()).multiply(qb);
  }

  _armIK(fwdX, fwdZ, rgtX, rgtZ) {
    const b = this.bones;
    const wb = b.weapon;
    wb.updateWorldMatrix(true, false);

    t3.copy(this.anchors.gripR).applyMatrix4(wb.matrixWorld);
    t4.copy(this.anchors.gripL).applyMatrix4(wb.matrixWorld);

    // Right (firing) elbow: down, back and outboard.
    b.armR.updateWorldMatrix(true, false);
    t0.setFromMatrixPosition(b.armR.matrixWorld);
    t2.set(t0.x - rgtX * 0.80 - fwdX * 0.45, t0.y - 0.70, t0.z - rgtZ * 0.80 - fwdZ * 0.45);
    twoBoneIK(b.armR, b.foreR, b.handR, t3, t2);

    // Left (support) elbow: tucked down and slightly inboard.
    b.armL.updateWorldMatrix(true, false);
    t0.setFromMatrixPosition(b.armL.matrixWorld);
    t2.set(t0.x + rgtX * 0.28 - fwdX * 0.10, t0.y - 0.95, t0.z + rgtZ * 0.28 - fwdZ * 0.10);
    twoBoneIK(b.armL, b.foreL, b.handL, t4, t2);

    // Wrists wrap the weapon rather than dangling off the forearm.
    wb.getWorldQuaternion(qc);
    for (let i = 0; i < 2; i++) {
      const hand = i === 0 ? b.handR : b.handL;
      const roll = i === 0 ? -0.30 : 0.60;
      hand.updateWorldMatrix(true, false);
      hand.parent.getWorldQuaternion(qa);
      eul.set(1.12, 0, roll, 'YXZ');
      qb.setFromEuler(eul);
      qb.premultiply(qc);
      hand.quaternion.copy(qa.invert()).multiply(qb);
    }
  }
}

export default SoldierAnim;
