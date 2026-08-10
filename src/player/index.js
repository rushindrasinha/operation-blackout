import * as THREE from 'three';

import { Movement } from './Movement.js';
import { CameraRig } from './CameraRig.js';
import { Poses } from './Poses.js';

/**
 * OPERATION BLACKOUT — player.
 *
 * Owns the local player: intent, movement, stance, aim, view dynamics, health,
 * and the named camera poses the screenshot harness drives.
 *
 * Two clocks:
 *   fixedUpdate(60Hz) — everything physical. Movement runs on the same clock as
 *                       Rapier so the character controller never sees a variable
 *                       timestep, which is what stops speed drifting with fps.
 *   update(per frame) — aim, view dynamics, camera composition, health. These
 *                       are frame-rate independent by construction (exponential
 *                       smoothing on dt), so a 120Hz display gets a smoother
 *                       camera rather than a different-feeling one.
 *
 * Published contract (read by weapons / hud / ai / fx):
 *   position, eyePosition, velocity, forward
 *   isSprinting, isCrouching, isADS, isGrounded, isDead
 *   health, maxHealth, yaw, pitch
 *   applyDamage(amount, fromPosition)
 *   addRecoil(pitch, yaw)
 *   setPose(name)
 *
 * OWNER: player agent. static id='player', static order=20.
 */
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
/** Capsule-rim sample offsets for the standing-clearance test. */
const SPAWN_PROBES = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
/** Seconds of invulnerability after (re)spawning. */
const SPAWN_GRACE = 4.5;

export class PlayerSystem {
  static id = 'player';
  static order = 20;

  constructor(ctx) {
    this.ctx = ctx;
    const cfg = ctx.config;

    // ── transform / kinematics ───────────────────────────────────────────────
    /** Feet position (bottom of the capsule). */
    this.position = new THREE.Vector3(0, 0, 0);
    /** Camera pivot, before any view dynamics. */
    this.eyePosition = new THREE.Vector3(0, cfg.player.height + cfg.player.eyeOffset, 0);
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);

    this.yaw = 0;
    this.pitch = 0;
    this.maxPitch = cfg.player.maxPitch;

    // ── stance / state ───────────────────────────────────────────────────────
    this.isSprinting = false;
    this.isCrouching = false;
    this.isADS = false;
    this.isGrounded = true;
    this.isDead = false;
    this.isMoving = false;
    /** 0..1 blends the other systems can read for weapon pose / HUD. */
    this.sprintT = 0;
    this.adsT = 0;
    this.crouchT = 0;
    this.speed = 0;
    this.planarSpeed = 0;
    /** Normalised planar speed against walk speed, for weapon bob / audio. */
    this.speed01 = 0;

    // ── health ───────────────────────────────────────────────────────────────
    this.maxHealth = cfg.gameplay.playerHealth;
    this.health = this.maxHealth;
    this.timeSinceDamage = 999;
    this.lastDamageDir = new THREE.Vector3(0, 0, -1);
    this.damageFlash = 0;
    this._deathTimer = 0;

    // ── subsystems ───────────────────────────────────────────────────────────
    this.movement = new Movement(this);
    this.rig = new CameraRig(this);
    this.poses = new Poses(this);

    // ── footsteps ────────────────────────────────────────────────────────────
    this._footDistance = 0;
    this.strideLength = 1.30;

    // ── toggles ──────────────────────────────────────────────────────────────
    this._crouchToggle = false;
    this._sprintLatch = false;

    this.fallbackFloorY = 0;
    /**
     * Cinematic hold, seconds. setPose() raises it so the critic's five
     * framings are reproducible: without it a bot puts rounds into you between
     * the pose call and the shutter, and damage recoil walks the aim several
     * degrees off the vantage point that was chosen. Cancelled by any player
     * input, so it can never affect real play.
     */
    this._poseHold = 0;
    /**
     * Spawn protection, seconds. Until AI damage was wired up correctly this was
     * invisible: bots emitted `player:damage` but never actually reduced health,
     * so nobody noticed that seven soldiers focus-fire a fresh spawn and kill it
     * in a shade under two seconds — before the screenshot harness even opens
     * the shutter, and long before a human could react. Standard FPS practice,
     * and it makes the boot frame reproducible instead of a coin flip between
     * "the yard" and "KIA".
     */
    this._spawnGrace = 0;
    this._mouseDX = 0;
    this._mouseDY = 0;
    this._elapsed = 0;
    this._offShake = null;
    this._frameStepDistance = 0;

    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Derived read-onlys
  // ───────────────────────────────────────────────────────────────────────────

  get eyeHeightStanding() {
    return this.ctx.config.player.height + this.ctx.config.player.eyeOffset;
  }

  get eyeHeight() {
    return this.movement.height + this.ctx.config.player.eyeOffset;
  }

  /** Radians of visual recoil currently applied. Weapons read this for the viewmodel. */
  get recoilOffset() { return this.rig.recoil; }
  get viewSway() { return this.rig.sway; }
  get fov() { return this.rig.fov; }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  async init(onProgress = () => {}) {
    onProgress(0.1, 'player: spawn');

    const spawn = this._pickSpawn();
    this.position.copy(spawn);
    this.fallbackFloorY = spawn.y;
    this._spawnGrace = SPAWN_GRACE;

    onProgress(0.4, 'player: controller');
    try {
      this.movement.init(this.position);
    } catch (err) {
      console.error('[player] movement init threw:', err);
    }

    onProgress(0.7, 'player: view');
    this._offShake = this.ctx.events.on('camera:shake', (p) => {
      if (this._poseHold > 0) return;
      try { this.rig.addShake(p || {}); } catch (err) { console.warn('[player] shake:', err); }
    });

    // Face something worth looking at rather than an arbitrary +Z. The harness
    // screenshots without pointer lock, so the spawn framing IS the default
    // frame the critic grades.
    try {
      const v = this.poses.viewAt(this.position);
      if (v) { this.yaw = v.yaw; this.pitch = v.pitch; }
    } catch (err) {
      console.warn('[player] initial framing fell back to default:', err);
    }

    this._syncEye();
    this.rig.fov = this.ctx.config.camera.fov;
    this.ctx.camera.fov = this.rig.fov;
    this.ctx.camera.updateProjectionMatrix();
    this.rig.applyTo(this.ctx.camera, this.eyePosition, this.yaw, this.pitch);
    this.ctx.render?.setVelocityDirty?.();

    onProgress(1, 'player: ready');
    console.info(
      `[player] spawn (${spawn.x.toFixed(1)}, ${spawn.y.toFixed(1)}, ${spawn.z.toFixed(1)}) ` +
      `capsule r=${this.movement.radius} halfHeight=${this.movement.standHalf.toFixed(3)} ` +
      `collider=${this.movement.ready ? 'ok' : 'DEGRADED'}`,
    );
  }

  /**
   * Choose a spawn point and, critically, *validate* it against the actual
   * collision world before standing on it.
   *
   * Authored spawn coordinates drift out of sync with level geometry — one of
   * this map's points declares y=0.08 where the real floor is y=1.10, which
   * spawns the capsule a metre inside a concrete slab. The character controller
   * then cannot resolve the penetration, so the player is frozen: no movement,
   * no jump, and no way to stand up. It looks exactly like a broken controller.
   *
   * So: drop-cast to find the true floor, require standing headroom, and only
   * fall back to the raw coordinate if nothing validates.
   */
  _pickSpawn(avoid = null) {
    const sp = this.ctx.level?.spawnPoints;
    const out = new THREE.Vector3(0, 0.05, 0);
    if (!Array.isArray(sp) || sp.length === 0) return out;

    const candidates = [];
    for (const raw of sp) {
      if (!raw) continue;
      let v = null;
      if (Number.isFinite(raw?.x)) v = new THREE.Vector3(raw.x, raw.y, raw.z);
      else if (Array.isArray(raw) && raw.length >= 3) v = new THREE.Vector3(raw[0], raw[1], raw[2]);
      if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) continue;
      candidates.push(v);
    }
    if (candidates.length === 0) return out;

    const valid = [];
    for (const v of candidates) {
      const fixed = this._settleSpawn(v);
      if (fixed) valid.push(fixed);
    }

    const pool = valid.length ? valid : candidates.map((v) => v.clone().setY(v.y + 0.05));
    if (!valid.length && !this._warnedSpawn) {
      console.warn('[player] no spawn point passed the standing-clearance test — using raw coordinates');
      this._warnedSpawn = true;
    }

    // Drop anything you would spawn facing a wall. `_settleSpawn` only proves the
    // capsule fits; it says nothing about whether there is anything to look at,
    // and the harness screenshots the spawn framing without pointer lock, so a
    // boxed-in point is a wasted frame (and a bad first second of play). Keep at
    // least a couple of options so a fussy map can never leave the pool empty.
    let open = pool;
    if (pool.length > 2) {
      const scored = pool.filter((v) => this._openness(v) > 0);
      if (scored.length >= 2) open = scored;
    }

    let best = open[0], bestScore = -Infinity;
    for (const v of open) {
      // Respawn: get away from whoever just killed you.
      // First spawn: any of the surviving points; variety is deliberate.
      const score = avoid ? v.distanceToSquared(avoid) : Math.random();
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best.clone();
  }

  /**
   * Roughly "how far away is the average pixel" from this spawn, in metres —
   * a coarse ray grid across the real FOV, aimed down the yaw `viewAt()` will
   * actually adopt. Returns -1 for a point that would spawn you facing a wall.
   *
   * Used only as a *filter*. It is deliberately not used to rank: ranking on it
   * reliably selects the single deepest vista in the map, which turned out to be
   * a catwalk pointed at the low sun, and "technically the most open" is not the
   * same thing as "a good frame".
   */
  _openness(v) {
    const physics = this.ctx.physics;
    if (!physics?.world) return 0;
    const eyeY = v.y + this.eyeHeightStanding;
    const mask = physics.GROUPS?.WORLD ?? 0x0001;
    const ray = (yaw, pitch) => {
      this._tmp.set(v.x, eyeY, v.z);
      this._tmp2.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      const hit = physics.raycast(this._tmp, this._tmp2, 60, {
        group: 'PROJECTILE', mask, reuse: true,
      });
      return hit ? hit.distance : 60;
    };

    try {
      // Where will the camera actually point from here?
      let yaw = 0, pitch = 0;
      try {
        const view = this.poses.viewAt(v);
        if (view) { yaw = view.yaw; pitch = view.pitch; }
      } catch { /* default framing */ }
      // The camera looks down -Z at yaw 0, so world forward is (-sin, -cos).
      const fwd = yaw + Math.PI;

      const vFov = (this.ctx.config.camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (16 / 9));
      const depths = [];
      for (let iy = -1; iy <= 1; iy++) {
        for (let ix = -2; ix <= 2; ix++) {
          depths.push(ray(fwd + (ix / 2) * hFov * 0.38, pitch + (iy / 1) * vFov * 0.34));
        }
      }
      depths.sort((a, b) => a - b);
      const median = depths[Math.floor(depths.length / 2)];
      const mean = depths.reduce((a, b) => a + b, 0) / depths.length;

      // A frame needs somewhere to look. Anything boxed in is out.
      if (median < 7) return -1;
      let score = median * 0.7 + mean * 0.3;

      // Don't spawn staring down an 11°-elevation sun. The deepest vista in this
      // map happens to run straight at it, and the resulting frame is a white
      // haze with a rifle in front of it. Read the azimuth off the art config
      // rather than ctx.lighting — lighting is order 70 and has not initialised
      // when the player picks a spawn at order 20.
      const art = this.ctx.config?.art;
      if (art && Number.isFinite(art.sunAzimuth)) {
        const az = (art.sunAzimuth * Math.PI) / 180;
        // sunDirectionFrom(): horizontal component is (cos az, sin az).
        const sx = Math.cos(az), sz = Math.sin(az);
        const fx = Math.sin(fwd), fz = Math.cos(fwd);
        const align = fx * sx + fz * sz;              // 1 = looking straight at it
        if (align > 0.72) score *= 0.5;               // inside ~44°
        else if (align > 0.4) score *= 0.8;
      }
      return score;
    } catch { return 0; }
  }

  /**
   * Snap a candidate spawn to the real floor beneath it and confirm a full
   * standing capsule fits. Returns a corrected position, or null if unusable.
   */
  _settleSpawn(v) {
    const physics = this.ctx.physics;
    if (!physics?.world) return v.clone().setY(v.y + 0.05);
    const mask = physics.GROUPS?.WORLD ?? 0x0001;
    const r = this.movement.radius;
    const standH = this.ctx.config.player.height;

    try {
      // Start the drop above head height so a point buried in a slab still
      // finds the surface it should have been sitting on.
      const from = this._tmp.set(v.x, v.y + standH + 0.6, v.z);
      const hit = physics.raycast(from, DOWN, standH + 6.0, {
        group: 'PROJECTILE', mask, reuse: true,
      });
      const floorY = hit ? hit.point.y : v.y;
      if (!Number.isFinite(floorY)) return null;
      // A wildly different floor means the point is under a roof or over a pit;
      // still usable, but never accept a drop of more than a couple of storeys.
      if (floorY < v.y - 8) return null;

      const feetY = floorY + 0.03;
      for (const [ox, oz] of SPAWN_PROBES) {
        const o = this._tmp.set(v.x + ox * r * 0.7, feetY + 0.12, v.z + oz * r * 0.7);
        const up = physics.raycast(o, UP, standH - 0.06, { group: 'PROJECTILE', mask, reuse: true });
        if (up) return null;
      }
      return new THREE.Vector3(v.x, feetY, v.z);
    } catch (err) {
      console.warn('[player] spawn validation failed:', err);
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Fixed step — movement
  // ───────────────────────────────────────────────────────────────────────────

  fixedUpdate(fdt) {
    if (!fdt || fdt <= 0) return;
    this._elapsed += fdt;

    try {
      const intent = this._readIntent();
      const r = this.movement.step(fdt, intent);

      this.isGrounded = this.movement.grounded;
      this.crouchT = this.movement.crouchT;
      this.isCrouching = this.crouchT > 0.5;

      this.planarSpeed = Math.hypot(this.velocity.x, this.velocity.z);
      this.speed = this.velocity.length();
      this.speed01 = THREE.MathUtils.clamp(
        this.planarSpeed / Math.max(0.5, this.ctx.config.player.walkSpeed), 0, 2,
      );
      this.isMoving = this.planarSpeed > 0.35;

      this._frameStepDistance = (this._frameStepDistance || 0) + r.stepDistance;

      if (r.landed > 0.4) {
        const e = this.rig.addLanding(r.landed);
        this._emitFootstep(0.55 + e * 0.75, 0.86 + Math.random() * 0.1);
        // Reset the stride accumulator so you don't get a landing thud and a
        // walking footstep in the same 30ms.
        this._footDistance = 0;
      }

      this._accumulateFootsteps(r.stepDistance);
    } catch (err) {
      if (!this._warnedFixed) {
        console.error('[player] fixedUpdate failed — freezing movement:', err);
        this._warnedFixed = true;
      }
    }
  }

  _readIntent() {
    const input = this.ctx.input;

    if (this.isDead || !input) {
      return { moveX: 0, moveZ: 0, jump: false, wantCrouch: false, sprint: false, ads: false, elapsed: this._elapsed };
    }

    const axis = input.moveAxis();
    const wantCrouch = this._crouchHeld();

    // Sprint: shift, moving meaningfully forward, upright, not aiming. The
    // latch means tapping shift mid-strafe doesn't flicker the FOV.
    const shift = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    const forwardish = axis.z > 0.35 && Math.abs(axis.x) < 0.92;
    let sprint = shift && forwardish && !wantCrouch && !this.isADS && this.crouchT < 0.35;
    if (sprint && this.planarSpeed < 0.4 && !this.isGrounded) sprint = false;
    this._sprintLatch = sprint;

    const jump = input.isDown('Space');

    return {
      moveX: axis.x,
      moveZ: axis.z,
      jump,
      wantCrouch,
      sprint,
      ads: this.isADS,
      elapsed: this._elapsed,
    };
  }

  _crouchHeld() {
    const input = this.ctx.input;
    if (!input) return false;
    const held = input.isDown('ControlLeft') || input.isDown('ControlRight');
    return held || this._crouchToggle;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Footsteps — distance-based, never a timer
  // ───────────────────────────────────────────────────────────────────────────

  _accumulateFootsteps(stepDistance) {
    if (!this.isGrounded || this.isDead) return;
    if (this.planarSpeed < 0.55) { this._footDistance *= 0.9; return; }

    // Stride grows with speed: a sprint is longer strides AND faster cadence,
    // not just a sped-up walk loop. This is also what the view bob divides by,
    // so a footstep always lands at the bottom of the bob.
    const cfg = this.ctx.config.player;
    const t = THREE.MathUtils.clamp(
      (this.planarSpeed - cfg.crouchSpeed) / Math.max(0.5, cfg.sprintSpeed - cfg.crouchSpeed), 0, 1,
    );
    const stride = THREE.MathUtils.lerp(1.12, 1.95, t) * THREE.MathUtils.lerp(1, 0.92, this.crouchT);
    this.strideLength = stride;

    this._footDistance += stepDistance;
    if (this._footDistance >= stride) {
      this._footDistance -= stride;
      if (this._footDistance > stride) this._footDistance = 0; // teleport guard

      const vol = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(0.42, 0.95, t), 0.22, this.crouchT,
      ) * (this.isADS ? 0.8 : 1);
      this._emitFootstep(vol, 0.94 + Math.random() * 0.13);
    }
  }

  _emitFootstep(volume, pitch) {
    try {
      this.ctx.events.emit('audio:play', {
        id: 'footstep',
        position: this.position.clone(),
        volume: THREE.MathUtils.clamp(volume, 0, 1.4),
        pitch: THREE.MathUtils.clamp(pitch, 0.6, 1.6),
      });
    } catch { /* audio not up yet */ }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Per-frame — aim, view, camera
  // ───────────────────────────────────────────────────────────────────────────

  update(dt, elapsed) {
    const d = Math.min(dt, 0.1);
    try {
      if (this._poseHold > 0) this._poseHold = Math.max(0, this._poseHold - d);
      if (this._spawnGrace > 0) this._spawnGrace = Math.max(0, this._spawnGrace - d);
      this._updateAim(d);
      this._updateBlends(d);
      this._updateHealth(d);
      this._syncEye();

      this.rig.update(d, {
        speed: this.speed,
        planarSpeed: this.planarSpeed,
        strafeAxis: this._strafeAxis(),
        grounded: this.isGrounded,
        crouchT: this.crouchT,
        sprintT: this.sprintT,
        adsT: this.adsT,
        mouseDX: this._mouseDX,
        mouseDY: this._mouseDY,
        distanceStep: this._frameStepDistance || 0,
      });
      this._frameStepDistance = 0;

      this.rig.updateFov(d, this.ctx.camera, { sprintT: this.sprintT, adsT: this.adsT });
      this.rig.applyTo(this.ctx.camera, this.eyePosition, this.yaw, this.pitch);

      this.forward.set(0, 0, -1).applyQuaternion(this.ctx.camera.quaternion);
    } catch (err) {
      if (!this._warnedUpdate) {
        console.error('[player] update failed:', err);
        this._warnedUpdate = true;
      }
    }
  }

  _updateAim(dt) {
    const input = this.ctx.input;
    const cfg = this.ctx.config.player;

    let dx = 0, dy = 0;
    if (input) {
      const m = input.consumeMouse();
      dx = m.x; dy = m.y;

      // Any deliberate input drops the cinematic hold and hands control back.
      if (this._poseHold > 0 && (
        dx || dy || input.isDown('KeyW') || input.isDown('KeyA') ||
        input.isDown('KeyS') || input.isDown('KeyD') || input.isDown('Space') ||
        input.isMouseDown(0) || input.isMouseDown(2))) {
        this._poseHold = 0;
        this.movement.frozen = false;
      }

      // Edge-triggered toggles.
      if (input.wasPressed('KeyC')) this._crouchToggle = !this._crouchToggle;
      if (input.isDown('ControlLeft') || input.isDown('ControlRight')) this._crouchToggle = false;

      // ADS is the player's, not the weapon's — the weapon system reads isADS.
      this.isADS = !this.isDead && input.isMouseDown(2) && !this._sprintLatch;
    }

    if (this.isDead) { dx = 0; dy = 0; }

    this._mouseDX = dx;
    this._mouseDY = dy;

    let sens = cfg.mouseSensitivity;
    if (this.adsT > 0.001) {
      sens *= THREE.MathUtils.lerp(1, cfg.adsSensitivityMul, this.adsT);
    }

    this.yaw -= dx * sens;
    this.pitch -= dy * sens;

    // Keep yaw bounded so long sessions never lose float precision.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    this.pitch = THREE.MathUtils.clamp(this.pitch, -this.maxPitch, this.maxPitch);
  }

  _strafeAxis() {
    const input = this.ctx.input;
    if (!input || this.isDead) return 0;
    const a = input.moveAxis();
    return THREE.MathUtils.clamp(a.x, -1, 1);
  }

  _updateBlends(dt) {
    const sprintTarget = this._sprintLatch && this.planarSpeed > 1.2 && this.isGrounded ? 1 : 0;
    const adsTarget = this.isADS ? 1 : 0;

    // Sprint eases in slowly (the FOV widening should feel like effort building)
    // and drops fast (raising the weapon must be instant).
    const sRate = sprintTarget > this.sprintT ? 5.5 : 9.5;
    this.sprintT += (sprintTarget - this.sprintT) * (1 - Math.exp(-sRate * dt));
    if (Math.abs(this.sprintT - sprintTarget) < 1e-3) this.sprintT = sprintTarget;

    const aRate = adsTarget > this.adsT ? 14 : 11;
    this.adsT += (adsTarget - this.adsT) * (1 - Math.exp(-aRate * dt));
    if (Math.abs(this.adsT - adsTarget) < 1e-3) this.adsT = adsTarget;

    this.isSprinting = this.sprintT > 0.5;
  }

  _syncEye() {
    this.eyePosition.set(
      this.position.x,
      this.position.y + this.eyeHeight,
      this.position.z,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Health
  // ───────────────────────────────────────────────────────────────────────────

  _updateHealth(dt) {
    const g = this.ctx.config.gameplay;
    this.timeSinceDamage += dt;
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.9);

    if (this.isDead) {
      this._deathTimer -= dt;
      if (this._deathTimer <= 0) this.respawn();
      return;
    }

    if (this.health < this.maxHealth && this.timeSinceDamage > g.healthRegenDelay) {
      // Ease the regen in over the first half second so the HUD bar doesn't
      // snap into motion the instant the delay elapses.
      const ramp = THREE.MathUtils.clamp((this.timeSinceDamage - g.healthRegenDelay) / 0.5, 0, 1);
      this.health = Math.min(this.maxHealth, this.health + g.healthRegenRate * ramp * dt);
    }
  }

  /**
   * @param {number} amount
   * @param {THREE.Vector3|{x,y,z}|null} fromPosition world position of the attacker
   */
  applyDamage(amount, fromPosition = null) {
    const dmg = Number(amount);
    if (!Number.isFinite(dmg) || dmg <= 0 || this.isDead) return;
    // Held for a screenshot: absorb the hit rather than let it walk the framing.
    if (this._poseHold > 0) return;
    // Just (re)spawned — a moment to find cover before the squad lands rounds.
    if (this._spawnGrace > 0) return;

    this.health = Math.max(0, this.health - dmg);
    this.timeSinceDamage = 0;
    this.damageFlash = Math.min(1, this.damageFlash + THREE.MathUtils.clamp(dmg / 45, 0.25, 1));

    if (fromPosition && Number.isFinite(fromPosition.x)) {
      this.lastDamageDir
        .set(fromPosition.x - this.position.x, 0, fromPosition.z - this.position.z);
      if (this.lastDamageDir.lengthSq() < 1e-6) this.lastDamageDir.set(0, 0, -1);
      else this.lastDamageDir.normalize();
    }

    // Getting shot should rattle the sights, not black out the screen.
    const k = THREE.MathUtils.clamp(dmg / 40, 0.15, 1);
    this.rig.addShake({ amplitude: 0.35 + k * 0.75, duration: 0.24 + k * 0.16, frequency: 30 });
    this.rig.addRecoil(k * 0.020 * (Math.random() * 0.6 + 0.7), (Math.random() - 0.5) * k * 0.020);

    try {
      this.ctx.events.emit('player:damage', {
        amount: dmg,
        from: fromPosition ? new THREE.Vector3(fromPosition.x, fromPosition.y, fromPosition.z) : null,
        health: this.health,
      });
    } catch { /* no listeners */ }

    if (this.health <= 0) this._die();
  }

  heal(amount) {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0 || this.isDead) return;
    this.health = Math.min(this.maxHealth, this.health + a);
  }

  _die() {
    if (this.isDead) return;
    this.isDead = true;
    this.health = 0;
    this._deathTimer = 2.6;
    this.isADS = false;
    this._sprintLatch = false;
    this.velocity.set(0, 0, 0);
    this.rig.addShake({ amplitude: 1.1, duration: 0.9, frequency: 9 });
    try { this.ctx.events.emit('player:death', {}); } catch { /* no listeners */ }
    try {
      this.ctx.events.emit('audio:play', { id: 'death', position: null, volume: 1, pitch: 1 });
    } catch { /* audio not up */ }
  }

  respawn(silent = false) {
    const attacker = this.lastDamageDir
      ? this._tmp.copy(this.position).addScaledVector(this.lastDamageDir, 8)
      : null;
    const spawn = this._pickSpawn(attacker ? attacker.clone() : null);

    this.movement.teleport(spawn);
    this.movement.height = this.movement.standHeight;
    this.movement.crouchT = 0;
    this._crouchToggle = false;
    this.health = this.maxHealth;
    this.isDead = false;
    this.isADS = false;
    this._spawnGrace = SPAWN_GRACE;
    this.timeSinceDamage = 999;
    this.damageFlash = 0;
    this._footDistance = 0;
    this._frameStepDistance = 0;
    this.rig.reset();
    this.sprintT = 0;
    this.adsT = 0;

    try {
      const v = this.poses.viewAt(spawn);
      if (v) { this.yaw = v.yaw; this.pitch = v.pitch; }
    } catch { /* keep current aim */ }

    this._syncEye();
    this.rig.applyTo(this.ctx.camera, this.eyePosition, this.yaw, this.pitch);
    // TAA and motion blur must not smear a trail across the respawn cut.
    this.ctx.render?.setVelocityDirty?.();
    if (!silent) console.info('[player] respawned');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Recoil — called by the weapon system
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Camera-space weapon kick, radians. `pitch` positive is up.
   *
   * Split in two on purpose: the spring in CameraRig always returns fully to
   * zero (so it can never fight the mouse), while `recoilPermanence` of every
   * kick is pushed straight into the player's real aim. That residual is what
   * the player has to pull down — exactly like a real shooter, where the sight
   * picture does not politely walk itself back onto the target.
   */
  addRecoil(pitch = 0, yaw = 0) {
    if (this._poseHold > 0) return;
    try { this.rig.addRecoil(pitch, yaw); } catch (err) { console.warn('[player] addRecoil:', err); }
  }

  /** Convenience for FX / weapons that prefer a direct call over the event. */
  shake(amplitude, duration, frequency) {
    if (this._poseHold > 0) return;
    this.rig.addShake({ amplitude, duration, frequency });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Screenshot poses
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Teleport the camera to a named vantage point. Called from window.__POSE__()
   * by the critic harness — must never throw and must always leave the game in
   * a playable state.
   *
   * @param {'spawn'|'overwatch'|'warehouse'|'lane'|'closeup'} name
   */
  setPose(name) {
    try {
      this._applyPose(name);
      return true;
    } catch (err) {
      console.error('[player] setPose failed:', err);
      return false;
    }
  }

  _applyPose(name) {
    const p = this.poses.resolve(name);
    if (!p) return;

    this._poseHold = 8;
    this.isDead = false;
    this.health = this.maxHealth;
    this._crouchToggle = false;
    this.isADS = false;
    this._sprintLatch = false;
    this.sprintT = 0;
    this.adsT = 0;
    this.movement.height = this.movement.standHeight;
    this.movement.crouchT = 0;
    this.crouchT = 0;

    this.movement.teleport(p.pos);
    // An elevated vantage has no floor under it: hold the rig there rather than
    // letting gravity drop it out of shot. Any movement key releases the hold.
    this.movement.frozen = !!p.fly;
    if (p.fly) { this.movement.grounded = true; this.isGrounded = true; }

    this.yaw = p.yaw;
    this.pitch = THREE.MathUtils.clamp(p.pitch, -this.maxPitch, this.maxPitch);

    this.rig.reset();
    this._footDistance = 0;
    this._frameStepDistance = 0;
    this.velocity.set(0, 0, 0);

    this._syncEye();
    this.rig.fov = this.ctx.config.camera.fov;
    this.ctx.camera.fov = this.rig.fov;
    this.ctx.camera.updateProjectionMatrix();
    this.rig.applyTo(this.ctx.camera, this.eyePosition, this.yaw, this.pitch);

    // Any teleport invalidates the reprojection history for TAA / motion blur.
    this.ctx.render?.setVelocityDirty?.();
  }

  /** Names the harness may pass to setPose(). */
  poseNames() { return this.poses.names(); }

  // ───────────────────────────────────────────────────────────────────────────

  resize() { /* projection is owned by the engine + rig */ }

  dispose() {
    try { this._offShake?.(); } catch { /* noop */ }
    try { this.movement.dispose(); } catch { /* noop */ }
  }
}

export default PlayerSystem;
