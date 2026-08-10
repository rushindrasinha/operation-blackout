import * as THREE from 'three';
import { Perlin1D } from './noise.js';

/**
 * Everything that moves the camera *other than* the player's aim and feet.
 *
 * The whole point of this file is that view motion has exactly one composition
 * order and one place where it lands on the camera. When bob, recoil, shake and
 * landing each write to camera.rotation directly you get a rig that fights
 * itself: recoil recovery cancels the bob, shake overwrites the roll, and the
 * result is the mushy, slightly-drunk camera that marks a hobby FPS.
 *
 * Composition order (additive, applied once at the end of update):
 *
 *   rotation = aim(yaw,pitch)          the player's own aim — authoritative
 *            + recoil(pitch,yaw)       spring offset, decays fully to zero
 *            + landing pitch           impact dip
 *            + bob angular             tiny, speed-scaled
 *            + shake angular           perlin, decaying
 *   roll     = strafe + turn + bob + landing + shake
 *   position = eye
 *            + viewBasis * (bob.xy + shake.xyz - landingDip.y)
 *
 * The *permanent* half of recoil does not live here — addRecoil() pushes it
 * straight into the player's aim, so the spring in this file always targets
 * zero and can never fight mouse input.
 *
 * OWNER: player agent.
 */
export class CameraRig {
  constructor(player) {
    this.player = player;
    const cfg = player.ctx.config;

    // ── recoil spring ────────────────────────────────────────────────────────
    // omega chosen so an impulse settles to <5% in ~0.245s at zeta 0.85.
    this._recoilOmega = 19.5;
    this._recoilZeta = 0.85;
    // Impulse gain that makes addRecoil(a) peak at a radians of visual kick.
    // Solved numerically against this exact integrator — the closed-form
    // impulse-response peak is off by 2x for a damped-but-not-critical spring,
    // and a recoil that is half the size the weapon asked for is a silent bug.
    this._recoilGain = 2.604 * this._recoilOmega;
    this.recoil = new THREE.Vector2(0, 0);      // x = pitch, y = yaw (radians)
    this._recoilVel = new THREE.Vector2(0, 0);
    /** Fraction of each kick that becomes permanent aim drift the player must pull down. */
    this.recoilPermanence = 0.30;

    // ── view bob ─────────────────────────────────────────────────────────────
    this.bobPhase = 0;          // radians; advanced by DISTANCE, never by time
    this._bobWeight = 0;        // smoothed 0..~1.7
    this.bob = new THREE.Vector2(0, 0);
    this._bobAngle = new THREE.Vector3(0, 0, 0); // pitch, yaw, roll

    // ── landing impact ───────────────────────────────────────────────────────
    this.landDip = 0;           // metres, positive = camera pushed down
    this._landVel = 0;
    this._landOmega = 10.5;
    this._landZeta = 0.72;

    // ── roll ─────────────────────────────────────────────────────────────────
    this.roll = 0;
    this._rollTarget = 0;
    this._turnRoll = 0;

    // ── shake ────────────────────────────────────────────────────────────────
    this._shakes = [];
    this._shakeMax = 8;
    this._noise = [
      new Perlin1D(0x1f83d9ab), new Perlin1D(0x5be0cd19), new Perlin1D(0xcbbb9d5d),
      new Perlin1D(0x629a292a), new Perlin1D(0x9159015a), new Perlin1D(0x152fecd8),
    ];
    this._shakeTime = 0;
    this.shakeOffset = new THREE.Vector3();
    this.shakeAngle = new THREE.Vector3();

    // ── fov ──────────────────────────────────────────────────────────────────
    this.baseFov = cfg.camera.fov;
    this.fov = cfg.camera.fov;
    this._fovTarget = cfg.camera.fov;

    // ── sway (published for the weapon system) ───────────────────────────────
    this.sway = new THREE.Vector2(0, 0);

    // scratch
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._v = new THREE.Vector3();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Impulse inputs
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Weapon kick. `pitch` is upward kick in radians, `yaw` is horizontal drift.
   * Clamped hard so a mis-unit-ed caller (degrees instead of radians) cannot
   * fling the camera into the sky.
   */
  addRecoil(pitch = 0, yaw = 0) {
    let p = Number(pitch); let y = Number(yaw);
    if (!Number.isFinite(p)) p = 0;
    if (!Number.isFinite(y)) y = 0;
    p = THREE.MathUtils.clamp(p, -0.26, 0.26);
    y = THREE.MathUtils.clamp(y, -0.20, 0.20);

    // Visual half: an impulse into the spring, which always returns to zero.
    this._recoilVel.x += p * this._recoilGain;
    this._recoilVel.y += y * this._recoilGain;

    // Permanent half: real aim displacement. This is what the player fights.
    const k = this.recoilPermanence;
    this.player.pitch = THREE.MathUtils.clamp(
      this.player.pitch + p * k,
      -this.player.maxPitch, this.player.maxPitch,
    );
    this.player.yaw += y * k;
  }

  /** @param {{amplitude?:number,duration?:number,frequency?:number}} p */
  addShake(p = {}) {
    const amp = THREE.MathUtils.clamp(Number(p.amplitude ?? 0.5) || 0, 0, 4);
    if (amp <= 0.0005) return;
    const dur = THREE.MathUtils.clamp(Number(p.duration ?? 0.35) || 0.35, 0.03, 4);
    const freq = THREE.MathUtils.clamp(Number(p.frequency ?? 18) || 18, 0.5, 60);

    if (this._shakes.length >= this._shakeMax) {
      // Drop the weakest rather than the oldest — a big explosion must survive
      // a burst of small hit-reactions.
      let worst = 0;
      for (let i = 1; i < this._shakes.length; i++) {
        if (this._shakes[i].amp < this._shakes[worst].amp) worst = i;
      }
      if (this._shakes[worst].amp > amp) return;
      this._shakes.splice(worst, 1);
    }
    this._shakes.push({ amp, dur, freq, t: 0, seed: Math.random() * 500 });
  }

  /** Landing impact. `speed` is the downward speed at touchdown, m/s. */
  addLanding(speed) {
    const s = Math.abs(Number(speed) || 0);
    const impact = THREE.MathUtils.clamp((s - 2.0) / 9.5, 0, 1);
    if (impact <= 0.001) return 0;
    // Smoothstep so a light hop is a 4cm settle and a 6m drop is a 14cm thump —
    // proportional to fall velocity, but nowhere near linear in it.
    const e = impact * impact * (3 - 2 * impact);
    this._landVel += 0.34 + e * 3.1;
    if (e > 0.42) this.addShake({ amplitude: e * 0.55, duration: 0.26, frequency: 26 });
    return e;
  }

  /** Wipe every dynamic offset. Used on teleport / respawn / pose change. */
  reset() {
    this.recoil.set(0, 0);
    this._recoilVel.set(0, 0);
    this.bob.set(0, 0);
    this._bobAngle.set(0, 0, 0);
    this._bobWeight = 0;
    this.bobPhase = 0;
    this.landDip = 0;
    this._landVel = 0;
    this.roll = 0;
    this._rollTarget = 0;
    this._turnRoll = 0;
    this._shakes.length = 0;
    this.shakeOffset.set(0, 0, 0);
    this.shakeAngle.set(0, 0, 0);
    this.sway.set(0, 0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Per-frame
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * @param {number} dt
   * @param {object} s state from the player:
   *   { speed, planarSpeed, strafeAxis, grounded, crouchT, sprintT, adsT,
   *     mouseDX, distanceStep }
   */
  update(dt, s) {
    const d = Math.min(dt, 1 / 20); // a hitch must not explode the springs

    this._integrateRecoil(d);
    this._integrateBob(d, s);
    this._integrateLanding(d);
    this._integrateRoll(d, s);
    this._integrateShake(d);
    this._integrateSway(d, s);
  }

  _integrateRecoil(dt) {
    const k = this._recoilOmega * this._recoilOmega;
    const c = 2 * this._recoilZeta * this._recoilOmega;
    // Substep to a fixed ceiling rather than a frame-count. Semi-implicit Euler
    // at omega 19.5 loses ~20% of the peak on a 16ms frame, which would make
    // recoil literally weaker on a slower machine. Fixed h keeps the kick the
    // same size at 45fps and 500fps.
    const steps = Math.min(8, Math.max(1, Math.ceil(dt * 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this._recoilVel.x += (-k * this.recoil.x - c * this._recoilVel.x) * h;
      this._recoilVel.y += (-k * this.recoil.y - c * this._recoilVel.y) * h;
      this.recoil.x += this._recoilVel.x * h;
      this.recoil.y += this._recoilVel.y * h;
    }
    if (Math.abs(this.recoil.x) < 1e-5 && Math.abs(this._recoilVel.x) < 1e-4) {
      this.recoil.x = 0; this._recoilVel.x = 0;
    }
    if (Math.abs(this.recoil.y) < 1e-5 && Math.abs(this._recoilVel.y) < 1e-4) {
      this.recoil.y = 0; this._recoilVel.y = 0;
    }
    this.recoil.x = THREE.MathUtils.clamp(this.recoil.x, -0.35, 0.35);
    this.recoil.y = THREE.MathUtils.clamp(this.recoil.y, -0.30, 0.30);
  }

  _integrateBob(dt, s) {
    const cfg = this.player.ctx.config.player;

    // Phase is driven by distance travelled, so cadence follows speed for free
    // and a footstep always lands at the bottom of the bob (see stride below).
    const stride = this.player.strideLength;
    if (s.distanceStep > 0 && stride > 0.2) {
      this.bobPhase += (s.distanceStep * Math.PI) / stride;
      if (this.bobPhase > Math.PI * 2) this.bobPhase -= Math.PI * 2;
    }

    // Weight fades to exactly zero when stationary or airborne — a bob that
    // keeps ticking while you stand still is the single loudest amateur tell.
    let target = THREE.MathUtils.clamp(s.planarSpeed / Math.max(0.5, cfg.walkSpeed), 0, 1.55);
    if (target < 0.09) target = 0;
    if (!s.grounded) target = 0;
    target *= THREE.MathUtils.lerp(1.0, 0.62, s.crouchT);
    target *= THREE.MathUtils.lerp(1.0, 0.26, s.adsT);
    const rate = target > this._bobWeight ? 7.0 : 9.5;
    this._bobWeight += (target - this._bobWeight) * (1 - Math.exp(-rate * dt));
    if (this._bobWeight < 1e-4) this._bobWeight = 0;

    const w = this._bobWeight;
    if (w === 0) {
      this.bob.set(0, 0);
      this._bobAngle.set(0, 0, 0);
      return;
    }

    // Figure-eight: x = sin(p), y = cos(2p). One horizontal sweep per gait
    // cycle, two vertical dips — one per foot. A single sine is a pogo stick.
    const p = this.bobPhase;
    const sinp = Math.sin(p);
    const cos2p = Math.cos(2 * p);
    const ampX = 0.0205 * w;
    const ampY = 0.0135 * w;
    this.bob.set(sinp * ampX, -cos2p * ampY);

    this._bobAngle.set(
      Math.sin(2 * p + 0.62) * 0.0016 * w,   // pitch
      sinp * 0.0021 * w,                     // yaw
      Math.sin(p + 1.05) * 0.0034 * w,       // roll
    );
  }

  _integrateLanding(dt) {
    if (this.landDip === 0 && this._landVel === 0) return;
    const k = this._landOmega * this._landOmega;
    const c = 2 * this._landZeta * this._landOmega;
    const steps = Math.min(8, Math.max(1, Math.ceil(dt * 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this._landVel += (-k * this.landDip - c * this._landVel) * h;
      this.landDip += this._landVel * h;
    }
    this.landDip = THREE.MathUtils.clamp(this.landDip, -0.05, 0.26);
    if (Math.abs(this.landDip) < 2e-4 && Math.abs(this._landVel) < 2e-3) {
      this.landDip = 0; this._landVel = 0;
    }
  }

  _integrateRoll(dt, s) {
    const cfg = this.player.ctx.config.player;
    const speed01 = THREE.MathUtils.clamp(s.planarSpeed / Math.max(0.5, cfg.walkSpeed), 0, 1.2);

    // Lean into the strafe. 1.15 degrees at full lateral input — enough to feel,
    // small enough that nobody ever notices it as an effect.
    const strafeRoll = -s.strafeAxis * 0.0200 * speed01;

    // A whip of the mouse also rolls the shoulders slightly.
    const turn = THREE.MathUtils.clamp(-s.mouseDX * 0.00040, -0.011, 0.011);
    this._turnRoll += (turn - this._turnRoll) * (1 - Math.exp(-11 * dt));

    this._rollTarget = (strafeRoll + this._turnRoll) * THREE.MathUtils.lerp(1, 0.35, s.adsT);
    this.roll += (this._rollTarget - this.roll) * (1 - Math.exp(-7.5 * dt));
  }

  _integrateShake(dt) {
    this._shakeTime += dt;
    this.shakeOffset.set(0, 0, 0);
    this.shakeAngle.set(0, 0, 0);
    if (this._shakes.length === 0) return;

    let px = 0, py = 0, pz = 0, ap = 0, ay = 0, ar = 0;

    for (let i = this._shakes.length - 1; i >= 0; i--) {
      const sh = this._shakes[i];
      sh.t += dt;
      if (sh.t >= sh.dur) { this._shakes.splice(i, 1); continue; }
      const life = 1 - sh.t / sh.dur;
      const e = life * life * sh.amp;         // quadratic falloff — no click-off
      const tt = this._shakeTime * sh.freq + sh.seed;
      const n = this._noise;
      px += n[0].fbm(tt) * e;
      py += n[1].fbm(tt + 17.13) * e;
      pz += n[2].fbm(tt + 41.77) * e;
      ap += n[3].fbm(tt * 0.83 + 63.19) * e;
      ay += n[4].fbm(tt * 0.91 + 88.41) * e;
      ar += n[5].fbm(tt * 0.77 + 105.3) * e;
    }

    // Positional shake stays small — big translation reads as a broken camera.
    this.shakeOffset.set(
      THREE.MathUtils.clamp(px * 0.030, -0.10, 0.10),
      THREE.MathUtils.clamp(py * 0.030, -0.10, 0.10),
      THREE.MathUtils.clamp(pz * 0.016, -0.06, 0.06),
    );
    this.shakeAngle.set(
      THREE.MathUtils.clamp(ap * 0.0165, -0.06, 0.06),
      THREE.MathUtils.clamp(ay * 0.0165, -0.06, 0.06),
      THREE.MathUtils.clamp(ar * 0.0240, -0.09, 0.09),
    );
  }

  _integrateSway(dt, s) {
    // Low-passed mouse delta, published so the weapon system can lag the gun
    // behind the view without re-deriving it.
    const tx = THREE.MathUtils.clamp(-s.mouseDX * 0.0022, -1, 1);
    const ty = THREE.MathUtils.clamp(-s.mouseDY * 0.0022, -1, 1);
    const a = 1 - Math.exp(-9 * dt);
    this.sway.x += (tx - this.sway.x) * a;
    this.sway.y += (ty - this.sway.y) * a;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FOV
  // ───────────────────────────────────────────────────────────────────────────

  updateFov(dt, camera, { sprintT, adsT }) {
    const cam = this.player.ctx.config.camera;
    // ADS wins over sprint — you cannot be scoped and sprinting at once, and if
    // both blends are mid-transition the tighter one should dominate.
    const wide = THREE.MathUtils.lerp(cam.fov, cam.sprintFov, sprintT);
    this._fovTarget = THREE.MathUtils.lerp(wide, cam.adsFov, adsT);

    // ADS snaps in faster than sprint eases out: a slow ADS zoom feels laggy,
    // a fast sprint FOV pop feels like a bug.
    const rate = adsT > 0.01 ? 13.0 : 8.0;
    this.fov += (this._fovTarget - this.fov) * (1 - Math.exp(-rate * Math.min(dt, 0.1)));
    if (Math.abs(this.fov - this._fovTarget) < 0.004) this.fov = this._fovTarget;

    if (camera && Math.abs(camera.fov - this.fov) > 1e-4) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * Land every offset on the camera. This is the only place the rig writes to
   * the camera transform.
   */
  applyTo(camera, eyePosition, yaw, pitch) {
    const pitchTotal = THREE.MathUtils.clamp(
      pitch + this.recoil.x - this.landDip * 0.62 + this._bobAngle.x + this.shakeAngle.x,
      -1.5533, 1.5533,
    );
    const yawTotal = yaw + this.recoil.y + this._bobAngle.y + this.shakeAngle.y;
    const rollTotal = this.roll + this._bobAngle.z + this.shakeAngle.z;

    this._e.set(pitchTotal, yawTotal, rollTotal, 'YXZ');
    this._q.setFromEuler(this._e);

    this._v.set(
      this.bob.x + this.shakeOffset.x,
      this.bob.y + this.shakeOffset.y - this.landDip,
      this.shakeOffset.z,
    ).applyQuaternion(this._q);

    camera.position.copy(eyePosition).add(this._v);
    camera.quaternion.copy(this._q);
    camera.updateMatrixWorld(true);
  }
}

export default CameraRig;
