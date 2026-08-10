import * as THREE from 'three';
import { Spring, Spring3, easeOutExpo, easeOutCubic, clamp, damp } from './spring.js';

/**
 * OPERATION BLACKOUT — viewmodel rig.
 *
 * The rig is a chain of nodes parented to the viewmodel CAMERA, not to the scene.
 * That matters: every offset below is therefore camera-relative by construction, so
 * the sight alignment stays exact even if another system decides to move the
 * viewmodel camera (shake, lean, death cam).
 *
 *   viewmodelCamera
 *     └ arm      pose blend (hip / ADS / sprint), the only node with authority
 *        └ sway  look lag + breathing, spring driven
 *           └ bob walk / sprint cycle
 *              └ kick recoil, spring driven, pivoting behind the grip
 *                 └ model  the weapon; its ORIGIN is the optic's optical axis
 *
 * Because `model`'s origin is the optical axis reference, the ADS pose is simply
 * "put arm at (0, 0, −eyeRelief) with zero rotation" and the red dot lands on the
 * exact centre pixel. No hand-tuned nudging, no per-weapon fudge factors.
 *
 * OWNER: weapons.
 */

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export class Viewmodel {
  constructor(ctx) {
    this.ctx = ctx;

    this.arm = new THREE.Group();   this.arm.name = 'vm_arm';
    this.sway = new THREE.Group();  this.sway.name = 'vm_sway';
    this.bob = new THREE.Group();   this.bob.name = 'vm_bob';
    this.kick = new THREE.Group();  this.kick.name = 'vm_kick';
    this.mount = new THREE.Group(); this.mount.name = 'vm_mount';

    this.arm.add(this.sway);
    this.sway.add(this.bob);
    this.bob.add(this.kick);
    this.kick.add(this.mount);

    // ── state ───────────────────────────────────────────────────────────────
    this.adsT = 0;              // 0 hip, 1 ADS  (eased)
    this.adsRaw = 0;            // linear driver behind adsT
    this.sprintT = 0;
    this.lowerT = 0;            // holster / draw
    this.inspectT = 0;

    this.bobPhase = 0;
    this.breathPhase = Math.random() * 100;
    this.stepImpulse = 0;

    // Look lag. Underdamped on purpose: a fast flick must visibly overshoot and
    // settle, which is the single most important weapon-feel detail in the game.
    this.lagRot = new Spring3(58, 11.0);
    this.lagPos = new Spring3(70, 12.5);
    this.moveLag = new Spring3(46, 11.0);

    // Recoil.
    this.kickRot = new Spring3(190, 21);
    this.kickPos = new Spring3(210, 23);
    this.jump = new Spring(48, 9.5);

    // Reload / action offsets, driven by the animation clips.
    this.animPos = new THREE.Vector3();
    this.animRot = new THREE.Euler();

    this.poseHip = { pos: new THREE.Vector3(), rot: new THREE.Euler() };
    this.poseAds = { pos: new THREE.Vector3(), rot: new THREE.Euler() };
    this.poseSprint = { pos: new THREE.Vector3(), rot: new THREE.Euler() };
    this.poseInspect = { pos: new THREE.Vector3(), rot: new THREE.Euler() };

    this._prevYaw = null;
    this._prevPitch = null;
    this._lastSpeed = 0;
    this._tmpPos = new THREE.Vector3();
    this._tmpRot = new THREE.Euler();
  }

  attach(scene, camera) {
    try {
      // Parent the whole rig to the camera so every offset is camera-relative.
      if (camera.parent !== scene) scene.add(camera);
      camera.add(this.arm);
    } catch (err) {
      console.error('[weapons] viewmodel attach failed:', err);
      scene.add(this.arm);
    }
  }

  setModel(model) {
    for (let i = this.mount.children.length - 1; i >= 0; i--) {
      this.mount.remove(this.mount.children[i]);
    }
    if (model) this.mount.add(model.root);
    this.model = model ?? null;
  }

  setPoses(def, model) {
    const P = def.poses;
    const load = (dst, src) => {
      dst.pos.set(src.pos[0], src.pos[1], src.pos[2]);
      dst.rot.set(src.rot[0], src.rot[1], src.rot[2], 'XYZ');
    };
    load(this.poseHip, P.hip);
    load(this.poseAds, P.ads);
    load(this.poseSprint, P.sprint);
    load(this.poseInspect, P.inspect);

    // ── the alignment guarantee ─────────────────────────────────────────────
    // `model.root` is offset inside `mount` so that the model's OPTICAL AXIS
    // reference node sits exactly at the mount origin. With sway/bob/kick at rest
    // and the arm at (0,0,−z) with zero rotation, that axis is therefore the
    // camera's −Z and the reticle is on the centre pixel by construction.
    if (model?.sight && model.root) {
      model.sight.updateMatrix();
      const s = model.sight.position;
      model.root.position.set(-s.x, -s.y, -s.z);
    }
    // ADS keeps only its Z: x/y must be zero or the sight walks off centre.
    this.poseAds.pos.x = 0;
    this.poseAds.pos.y = 0;
    this.poseAds.rot.set(0, 0, 0);

    // Viewmodel scale. Every FPS shrinks the weapon relative to the world, because
    // a true-scale rifle held at a true-scale eye relief puts its magazine, grip and
    // firing hand outside a 55-degree frustum entirely. Shrinking the MODEL while
    // leaving the hip pose distance alone is what buys those back.
    //
    // The ADS distance must scale with it, or the optic would shrink in the aimed
    // view too — and the aimed view is the one that has to look correct.
    const s = this.scale ?? 1;
    this.mount.scale.setScalar(s);
    this.poseAds.pos.z = P.ads.pos[2] * s;

    this.adsEyeRelief = Math.abs(this.poseAds.pos.z);
  }

  /** Called every frame with the player's look delta so the weapon can lag it. */
  feedLook(yaw, pitch, dt) {
    if (this._prevYaw === null || !(dt > 0)) {
      this._prevYaw = yaw; this._prevPitch = pitch;
      return;
    }
    let dYaw = yaw - this._prevYaw;
    // Unwrap so crossing ±pi does not produce a one-frame catapult.
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    else if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const dPitch = pitch - this._prevPitch;
    this._prevYaw = yaw;
    this._prevPitch = pitch;

    const yawVel = clamp(dYaw / dt, -14, 14);
    const pitchVel = clamp(dPitch / dt, -14, 14);

    // Steady-state lag proportional to angular velocity, damped down in ADS where
    // the shooter's cheek weld locks the weapon to the head.
    const scale = 1 - this.adsT * 0.72;
    const rotGain = 0.052 * scale;
    const posGain = 0.0085 * scale;

    this.lagRot.setTarget(
      clamp(pitchVel * rotGain * 0.85, -0.24, 0.24),
      clamp(-yawVel * rotGain, -0.30, 0.30),
      clamp(-yawVel * rotGain * 0.55, -0.20, 0.20),
    );
    this.lagPos.setTarget(
      clamp(-yawVel * posGain, -0.045, 0.045),
      clamp(-pitchVel * posGain * 0.8, -0.035, 0.035),
      0,
    );
  }

  /** Recoil impulse for one shot. */
  addRecoil(def, adsT, crouched) {
    const r = def.recoil;
    const mul = (1 - adsT * (1 - r.adsMul)) * (crouched ? r.crouchMul : 1);
    const sign = Math.random() < 0.5 ? -1 : 1;
    this.kickRot.k = r.vmStiffness;
    this.kickRot.d = r.vmDamping;
    this.kickPos.k = r.vmStiffness * 1.1;
    this.kickPos.d = r.vmDamping * 1.08;
    this.kickRot.impulse(
      r.vmPitch * mul * (24 + Math.random() * 8),
      sign * r.vmRoll * mul * (7 + Math.random() * 6),
      sign * r.vmRoll * mul * (13 + Math.random() * 9),
    );
    this.kickPos.impulse(
      sign * r.vmPunch * mul * (2.2 + Math.random() * 1.6),
      r.vmPunch * mul * (2.6 + Math.random() * 1.4),
      r.vmPunch * mul * (26 + Math.random() * 8),
    );
  }

  addJumpImpulse(v) { this.jump.impulse(v); }
  addStepImpulse(v) { this.stepImpulse = Math.min(1.4, this.stepImpulse + v); }

  /**
   * @param {number} dt
   * @param {object} s  { speed, maxSpeed, sprinting, crouching, grounded, ads, adsTime, lowered }
   */
  update(dt, s) {
    const d = Math.min(dt, 0.05);

    /* ── ADS blend ────────────────────────────────────────────────────────── */
    const adsRate = 1 / Math.max(0.02, s.adsTime ?? 0.2);
    const wantAds = s.ads && !s.sprinting && !s.lowered ? 1 : 0;
    this.adsRaw = clamp(this.adsRaw + (wantAds ? d * adsRate : -d * adsRate * 1.25), 0, 1);
    // Fast-out / slow-in going in, a gentler curve coming out.
    this.adsT = wantAds ? easeOutExpo(this.adsRaw) : easeOutCubic(this.adsRaw);

    const sprintRate = 1 / Math.max(0.05, s.sprintTime ?? 0.18);
    const wantSprint = s.sprinting && !s.ads ? 1 : 0;
    this.sprintT = clamp(this.sprintT + (wantSprint ? d * sprintRate : -d * sprintRate * 1.35), 0, 1);
    const sprintE = this.sprintT * this.sprintT * (3 - 2 * this.sprintT);

    this.lowerT = clamp(this.lowerT + ((s.lowered ? 1 : 0) - this.lowerT) * Math.min(1, d * 14), 0, 1);
    this.inspectT = clamp(this.inspectT + ((s.inspect ? 1 : 0) - this.inspectT) * Math.min(1, d * 8), 0, 1);

    /* ── pose blend ───────────────────────────────────────────────────────── */
    const pos = this._tmpPos.copy(this.poseHip.pos);
    const rot = this._tmpRot.set(this.poseHip.rot.x, this.poseHip.rot.y, this.poseHip.rot.z);

    if (sprintE > 0.0001) {
      pos.lerp(this.poseSprint.pos, sprintE);
      rot.set(
        THREE.MathUtils.lerp(rot.x, this.poseSprint.rot.x, sprintE),
        THREE.MathUtils.lerp(rot.y, this.poseSprint.rot.y, sprintE),
        THREE.MathUtils.lerp(rot.z, this.poseSprint.rot.z, sprintE),
      );
    }
    if (this.inspectT > 0.0001) {
      pos.lerp(this.poseInspect.pos, this.inspectT);
      rot.set(
        THREE.MathUtils.lerp(rot.x, this.poseInspect.rot.x, this.inspectT),
        THREE.MathUtils.lerp(rot.y, this.poseInspect.rot.y, this.inspectT),
        THREE.MathUtils.lerp(rot.z, this.poseInspect.rot.z, this.inspectT),
      );
    }
    if (this.adsT > 0.0001) {
      pos.lerp(this.poseAds.pos, this.adsT);
      rot.set(
        THREE.MathUtils.lerp(rot.x, 0, this.adsT),
        THREE.MathUtils.lerp(rot.y, 0, this.adsT),
        THREE.MathUtils.lerp(rot.z, 0, this.adsT),
      );
    }

    // Holster: drop and roll the weapon out of frame.
    if (this.lowerT > 0.0001) {
      pos.y -= 0.20 * this.lowerT;
      pos.z += 0.05 * this.lowerT;
      rot.x -= 0.85 * this.lowerT;
      rot.z += 0.30 * this.lowerT;
    }

    // Reload / action clip offsets ride on top of the pose.
    pos.add(this.animPos);
    rot.x += this.animRot.x;
    rot.y += this.animRot.y;
    rot.z += this.animRot.z;

    this.arm.position.copy(pos);
    this.arm.rotation.copy(rot);

    /* ── look lag + breathing ─────────────────────────────────────────────── */
    this.lagRot.update(d).clamp(0.45);
    this.lagPos.update(d).clamp(0.07);

    // Aimed-in, the cheek weld and both elbows are locked, so breathing shows up as
    // a much smaller residual. At 111 mm eye relief a 1 mm wander is 12 px of dot
    // drift at 1080p — enough that this factor is doing real work.
    const breathScale = (1 - this.adsT * 0.82) * (1 - sprintE * 0.5);
    this.breathPhase += d;
    const bp = this.breathPhase;
    // Two incommensurate rates so the idle never visibly loops.
    const bx = Math.sin(bp * 0.62) * 0.55 + Math.sin(bp * 0.231 + 1.7) * 0.45;
    const by = Math.sin(bp * 0.48 + 0.9) * 0.55 + Math.sin(bp * 0.187 + 3.1) * 0.45;

    this.sway.position.set(
      this.lagPos.x + bx * 0.0026 * breathScale,
      this.lagPos.y + by * 0.0031 * breathScale,
      this.lagPos.z,
    );
    this.sway.rotation.set(
      this.lagRot.x + by * 0.0100 * breathScale,
      this.lagRot.y + bx * 0.0125 * breathScale,
      this.lagRot.z + bx * 0.0060 * breathScale,
    );

    /* ── walk / sprint bob ────────────────────────────────────────────────── */
    const speed = s.speed ?? 0;
    const maxSpeed = Math.max(0.5, s.maxSpeed ?? 6.3);
    const norm = clamp(speed / maxSpeed, 0, 1.4);
    const grounded = s.grounded !== false;

    // Cycle rate rises with speed; the sprint cadence is markedly faster.
    const cadence = (1.55 + norm * 3.05) * (s.sprinting ? 1.16 : 1.0);
    if (grounded) this.bobPhase += d * cadence * Math.PI * 2 * clamp(norm * 1.15, 0, 1.3);

    const amp = norm * norm * (s.sprinting ? 1.55 : 1.0) * (1 - this.adsT * 0.70) * (grounded ? 1 : 0.15);
    const p = this.bobPhase;
    // Figure-of-eight: horizontal at the step rate, vertical at twice it.
    const bobX = Math.sin(p) * 0.0135 * amp;
    const bobY = -Math.abs(Math.sin(p * 1.0 + 1.5708)) * 0.0125 * amp - 0.0025 * amp;
    const bobZ = Math.sin(p * 2) * 0.0042 * amp;

    // Lateral lean into the direction of travel, spring damped.
    this.moveLag.setTarget(
      clamp((s.strafe ?? 0) * -0.030 * (1 - this.adsT * 0.6), -0.05, 0.05),
      0,
      clamp((s.forward ?? 0) * -0.014 * (1 - this.adsT * 0.6), -0.03, 0.03),
    );
    this.moveLag.update(d).clamp(0.09);

    this.jump.target = 0;
    this.jump.update(d);

    this.bob.position.set(
      bobX + this.moveLag.x,
      bobY + this.moveLag.y + this.jump.value * 0.03 - this.stepImpulse * 0.0055,
      bobZ + this.moveLag.z,
    );
    this.bob.rotation.set(
      -bobY * 1.7 + this.jump.value * 0.09,
      bobX * 1.1,
      Math.sin(p) * 0.020 * amp + this.moveLag.x * 1.1,
    );

    this.stepImpulse = damp(this.stepImpulse, 0, 11, d);

    /* ── recoil ───────────────────────────────────────────────────────────── */
    this.kickRot.setTarget(0, 0, 0);
    this.kickPos.setTarget(0, 0, 0);
    this.kickRot.update(d).clamp(0.55);
    this.kickPos.update(d).clamp(0.09);

    if (this.frozen) {
      // Alignment-measurement mode: strip every procedural offset so the only thing
      // positioning the weapon is the pose blend.
      this.sway.position.set(0, 0, 0);
      this.sway.rotation.set(0, 0, 0);
      this.bob.position.set(0, 0, 0);
      this.bob.rotation.set(0, 0, 0);
      this.kick.position.set(0, 0, 0);
      this.kick.rotation.set(0, 0, 0);
      return;
    }

    // Kick has to pivot behind the grip — around the shoulder, not around the
    // optic — or the whole weapon translates upward instead of the muzzle rising.
    // Rotating about a pivot p is R(v−p)+p, and here v is the node origin, so the
    // correction is exactly p − R·p. L is the distance back to the shoulder.
    const L = this.kickPivotBack ?? 0.26;
    const cx = Math.cos(this.kickRot.x), sx = Math.sin(this.kickRot.x);
    const cy = Math.cos(this.kickRot.y), sy = Math.sin(this.kickRot.y);
    this.kick.position.set(
      this.kickPos.x - L * sy * cx,
      this.kickPos.y + L * sx,
      this.kickPos.z + L * (1 - cx * cy),
    );
    this.kick.rotation.set(this.kickRot.x, this.kickRot.y, this.kickRot.z);
  }

  dispose() {
    this.arm.removeFromParent();
  }
}

export default Viewmodel;
