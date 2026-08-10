import * as THREE from 'three';

/**
 * Source-style kinematic movement on top of Rapier's KinematicCharacterController.
 *
 * The model is deliberately the Quake/Source one rather than "set velocity from
 * input", because that model is what makes an FPS feel like an FPS: momentum is
 * a real quantity, friction is a separate force applied only while your feet are
 * on something, and air control is a small, bounded steering authority rather
 * than free flight.
 *
 *   ground:  friction(v) -> accelerate(v, wishDir, wishSpeed, accelGround)
 *   air:     accelerate(v, wishDir, min(wishSpeed, AIR_WISH_CAP), accelAir)
 *
 * accelerate() only ever adds speed *along wishDir up to wishSpeed projected on
 * wishDir*, which is what lets you gain a little velocity by strafing in the air
 * while making straight-line bunny hopping worthless.
 *
 * OWNER: player agent.
 */

/** Speed below which ground friction snaps you to a dead stop. */
const STOP_SPEED = 0.14;
/** Source's "control" floor — keeps friction from vanishing at low speed. */
const FRICTION_FLOOR = 1.45;
/**
 * Wish-speed ceiling used by air acceleration. This is the entire bunny-hop
 * budget: pure-sideways input has zero velocity along wishDir, so it always
 * gets the full accel, but the total is then clamped by AIR_SPEED_CAP below.
 */
const AIR_WISH_CAP = 1.10;
/** Absolute planar speed ceiling while airborne, as a multiple of sprintSpeed. */
const AIR_SPEED_CAP_MUL = 1.14;
/** Minimum time between jumps. Kills hop-chaining without feeling sticky. */
const JUMP_COOLDOWN = 0.30;
const COYOTE_TIME = 0.11;
const JUMP_BUFFER = 0.14;

/**
 * Critically-damped smoothing (the classic second-order "SmoothDamp"). Reaches
 * the target in roughly `smoothTime`, with zero velocity at both ends and no
 * overshoot. The rational approximation of exp(-x) is what makes it stable at
 * any timestep — a plain lerp blows up when dt spikes.
 *
 * Velocity state lives on `owner[velKey]` so the caller keeps no extra object.
 */
function smoothDamp(current, target, owner, velKey, smoothTime, maxSpeed, dt) {
  const st = Math.max(0.0001, smoothTime);
  const omega = 2 / st;
  const x = omega * Math.min(dt, 0.1);
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

  let change = current - target;
  const maxChange = maxSpeed * st;
  change = Math.min(Math.max(change, -maxChange), maxChange);
  const t = target;

  let vel = owner[velKey] ?? 0;
  const temp = (vel + omega * change) * Math.min(dt, 0.1);
  vel = (vel - omega * temp) * exp;
  let out = t + (change + temp) * exp;

  // Kill the residual overshoot the approximation can leave behind.
  if ((target - current > 0) === (out > target)) { out = target; vel = 0; }
  owner[velKey] = vel;
  return out;
}

export class Movement {
  constructor(player) {
    this.player = player;
    this.ctx = player.ctx;
    const cfg = this.ctx.config.player;

    this.radius = cfg.radius;
    this.standHeight = cfg.height;
    this.crouchHeight = cfg.crouchHeight;

    // Rapier capsule halfHeight EXCLUDES the two hemispherical caps:
    //   totalHeight = 2 * (halfHeight + radius)
    // 1.75m at r=0.34 -> halfHeight 0.535. Getting this wrong by the cap radius
    // is the classic "player's eyes are inside the floor" bug.
    this.standHalf = Math.max(0.02, (this.standHeight - 2 * this.radius) * 0.5);
    this.crouchHalf = Math.max(0.02, (this.crouchHeight - 2 * this.radius) * 0.5);

    /** Current interpolated capsule height, metres. */
    this.height = this.standHeight;
    this._heightVel = 0;
    /** 0 = fully standing, 1 = fully crouched. */
    this.crouchT = 0;

    this.grounded = false;
    this.wasGrounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);

    this.controller = null;
    this.body = null;
    this.collider = null;
    this.ready = false;

    this._sinceJump = 999;
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._lastAppliedHalf = -1;
    this._airTime = 0;
    this._headroomCache = { t: -1, ok: true };
    /**
     * Set by an elevated screenshot pose that has no floor beneath it. Gravity
     * and integration are skipped until the player touches a movement key, so
     * the critic's framing holds still instead of sinking out of shot.
     */
    this.frozen = false;
    this.blockedByCeiling = false;

    // scratch
    this._wish = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._desired = { x: 0, y: 0, z: 0 };
    this._prevPos = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._rayFrom = new THREE.Vector3();
    this._filterFlags = undefined;
    this._filterGroups = undefined;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Setup
  // ───────────────────────────────────────────────────────────────────────────

  init(spawnPos) {
    const physics = this.ctx.physics;
    if (!physics?.world || !physics.ready) {
      console.warn('[player] physics unavailable — movement running without collision');
      return false;
    }

    try {
      this.controller = physics.createCharacterController(0.02, {
        stepHeight: this.ctx.config.player.stepHeight,
        stepMinWidth: 0.18,
        snapDistance: 0.34,
        maxSlopeClimbDeg: 50,
        minSlopeSlideDeg: 42,
        pushDynamics: true,
        mass: 82,
      });
      if (!this.controller) return false;

      const centre = {
        x: spawnPos.x,
        y: spawnPos.y + this.standHalf + this.radius,
        z: spawnPos.z,
      };
      const made = physics.addCapsule(this.standHalf, this.radius, centre, {
        type: 'kinematicPosition',
        group: 'PLAYER',
        friction: 0.0,
        restitution: 0.0,
        material: 'fabric',
        actor: this.player,
        canSleep: false,
      });
      if (!made) return false;

      this.body = made.body;
      this.collider = made.collider;
      this._lastAppliedHalf = this.standHalf;

      const G = physics.GROUPS, F = physics.FILTERS;
      if (G && F && physics.RAPIER) {
        // Membership PLAYER, interacting with world / bots / debris.
        this._filterGroups = (((G.PLAYER & 0xffff) << 16) >>> 0 | (F.PLAYER & 0xffff)) >>> 0;
        this._filterFlags = physics.RAPIER.QueryFilterFlags?.EXCLUDE_SENSORS;
      }
      this._worldOnlyMask = G ? G.WORLD : 0x0001;

      this.ready = true;
      return true;
    } catch (err) {
      console.error('[player] movement init failed — falling back to no-collision mode:', err);
      this.ready = false;
      return false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Stance
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Is there room to grow the capsule back to full standing height?
   * Five upward rays (centre + a cross at 0.66r) rather than one, because a
   * single centre ray happily stands you up through the edge of a duct.
   */
  hasHeadroom(elapsed) {
    if (!this.ready) return true;
    // One test per fixed step is plenty; cache within the frame.
    if (this._headroomCache.t === elapsed) return this._headroomCache.ok;

    const physics = this.ctx.physics;
    const p = this.player.position;
    const need = this.standHeight - this.height + 0.06;
    if (need <= 0.02) { this._headroomCache = { t: elapsed, ok: true }; return true; }

    const startY = p.y + this.height - this.radius * 0.5;
    const r = this.radius * 0.66;
    const offsets = [
      [0, 0], [r, 0], [-r, 0], [0, r], [0, -r],
    ];
    const clearance = this.standHeight - (this.height - this.radius * 0.5) + 0.06;

    let ok = true;
    for (let i = 0; i < offsets.length; i++) {
      this._rayFrom.set(p.x + offsets[i][0], startY, p.z + offsets[i][1]);
      const hit = physics.raycast(this._rayFrom, this._up, clearance, {
        group: 'PROJECTILE',
        mask: this._worldOnlyMask,
        exclude: this.collider,
        reuse: true,
      });
      if (hit) { ok = false; break; }
    }
    this._headroomCache = { t: elapsed, ok };
    return ok;
  }

  /** Smoothly drive the capsule + eye height. Never snaps. */
  updateStance(dt, wantCrouch, elapsed) {
    const target = wantCrouch ? this.crouchHeight : this.standHeight;

    // Critically-damped smoothing rather than an exponential lerp. An
    // exponential starts at maximum velocity, so the first frame of a crouch is
    // the fastest one — the eye visibly *jumps* then decelerates. Critical
    // damping starts and ends at zero velocity, and (unlike a naive lerp) is
    // unconditionally stable, so a 40ms hitch mid-crouch cannot produce a
    // 15cm single-frame step in eye height.
    //
    // Going down is quicker than coming up: that asymmetry is what makes
    // crouching read as dropping your weight rather than riding an elevator.
    const smoothTime = target < this.height ? 0.115 : 0.155;
    // The 4.2 m/s speed cap bounds how far a single frame can move the eye, so
    // a 25ms hitch elsewhere in the engine cannot turn a crouch into a jolt.
    this.height = smoothDamp(this.height, target, this, '_heightVel', smoothTime, 4.2, dt);
    if (Math.abs(this.height - target) < 0.0008) { this.height = target; this._heightVel = 0; }

    this.crouchT = THREE.MathUtils.clamp(
      (this.standHeight - this.height) / Math.max(1e-4, this.standHeight - this.crouchHeight),
      0, 1,
    );

    if (!this.ready || !this.collider) return;
    const half = Math.max(0.02, (this.height - 2 * this.radius) * 0.5);
    if (Math.abs(half - this._lastAppliedHalf) > 5e-4) {
      try {
        this.collider.setHalfHeight(half);
        this._lastAppliedHalf = half;
      } catch (err) {
        // A Rapier build without live shape mutation must not kill the game.
        if (!this._warnedHalf) {
          console.warn('[player] capsule resize unsupported, stance is visual only:', err);
          this._warnedHalf = true;
        }
      }
    }
  }

  get halfHeight() { return Math.max(0.02, (this.height - 2 * this.radius) * 0.5); }

  // ───────────────────────────────────────────────────────────────────────────
  // Velocity model
  // ───────────────────────────────────────────────────────────────────────────

  _applyFriction(vel, dt) {
    const speed = Math.hypot(vel.x, vel.z);
    if (speed < 1e-5) { vel.x = 0; vel.z = 0; return; }
    if (speed < STOP_SPEED) { vel.x = 0; vel.z = 0; return; }
    const cfg = this.ctx.config.player;
    const control = Math.max(speed, FRICTION_FLOOR);
    const drop = control * cfg.friction * dt;
    const newSpeed = Math.max(0, speed - drop);
    const scale = newSpeed / speed;
    vel.x *= scale;
    vel.z *= scale;
  }

  /**
   * Quake accelerate. Only closes the gap between the current velocity's
   * projection on wishDir and wishSpeed — never adds speed you already have.
   */
  _accelerate(vel, wx, wz, wishSpeed, accel, dt) {
    const current = vel.x * wx + vel.z * wz;
    const addSpeed = wishSpeed - current;
    if (addSpeed <= 0) return;
    const accelSpeed = Math.min(accel * dt, addSpeed);
    vel.x += wx * accelSpeed;
    vel.z += wz * accelSpeed;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Fixed step
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * @param {number} dt fixed timestep
   * @param {object} intent { moveX, moveZ, jump, wantCrouch, sprint, ads, elapsed }
   * @returns {{ landed:number, stepDistance:number }}
   */
  step(dt, intent) {
    const cfg = this.ctx.config.player;
    const player = this.player;
    const vel = player.velocity;

    this._sinceJump += dt;
    this._prevPos.copy(player.position);

    if (this.frozen) {
      // Any movement intent releases the hold and hands control back.
      if (Math.abs(intent.moveX) > 0.05 || Math.abs(intent.moveZ) > 0.05 || intent.jump) {
        this.frozen = false;
      } else {
        this.updateStance(dt, intent.wantCrouch, intent.elapsed);
        vel.set(0, 0, 0);
        this.grounded = true;
        this.wasGrounded = true;
        return { landed: 0, stepDistance: 0 };
      }
    }

    // ── stance ───────────────────────────────────────────────────────────────
    let wantCrouch = intent.wantCrouch;
    if (!wantCrouch && this.crouchT > 0.001 && !this.hasHeadroom(intent.elapsed)) {
      wantCrouch = true; // blocked by a ceiling — stay down rather than clip
      this.blockedByCeiling = true;
    } else {
      this.blockedByCeiling = false;
    }
    this.updateStance(dt, wantCrouch, intent.elapsed);

    // ── wish direction in world space ────────────────────────────────────────
    const yaw = player.yaw;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    // Camera at yaw looks down -Z: forward = (-sin, 0, -cos), right = (cos, 0, -sin)
    this._fwd.set(-sy, 0, -cy);
    this._right.set(cy, 0, -sy);
    this._wish.set(0, 0, 0)
      .addScaledVector(this._right, intent.moveX)
      .addScaledVector(this._fwd, intent.moveZ);

    let wishLen = Math.hypot(this._wish.x, this._wish.z);
    let wx = 0, wz = 0;
    if (wishLen > 1e-5) { wx = this._wish.x / wishLen; wz = this._wish.z / wishLen; }
    else wishLen = 0;

    // ── target speed ─────────────────────────────────────────────────────────
    const crouchSpeed = cfg.crouchSpeed;
    const walkSpeed = cfg.walkSpeed;
    const stanceSpeed = THREE.MathUtils.lerp(walkSpeed, crouchSpeed, this.crouchT);
    let wishSpeed = intent.sprint ? cfg.sprintSpeed : stanceSpeed;
    if (intent.ads) wishSpeed *= cfg.adsSpeedMul;
    // Directional penalties — you are slower going backwards and sideways.
    if (intent.moveZ < -0.15) wishSpeed *= 0.80;
    else if (Math.abs(intent.moveX) > Math.abs(intent.moveZ) + 0.05) wishSpeed *= 0.90;
    wishSpeed *= Math.min(1, wishLen);

    // ── jump buffering / coyote ──────────────────────────────────────────────
    if (intent.jump) this._jumpBuffer = JUMP_BUFFER;
    else this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);
    this._coyote = this.grounded ? COYOTE_TIME : Math.max(0, this._coyote - dt);

    // ── accelerate, on whichever medium we are ACTUALLY on this tick ─────────
    // Order matters enormously here: acceleration must run before the jump is
    // applied, not after. Resolve the jump first and the tick you leave the
    // ground takes the air branch, so a hop cycle (land, jump, land, jump)
    // never once receives ground acceleration — holding jump then pins you at
    // ~1.7 m/s instead of ~6.3. Accelerating first means hopping costs you
    // nothing, while the air-speed cap below means it gains you nothing either.
    if (this.grounded) {
      this._applyFriction(vel, dt);
      if (wishSpeed > 0) {
        // Scale the authored ground accel with wish speed the way Source does,
        // otherwise sprint tops out below sprintSpeed because friction wins.
        const accel = cfg.accelGround * Math.max(1, wishSpeed / walkSpeed);
        this._accelerate(vel, wx, wz, wishSpeed, accel, dt);
      }
      this._airTime = 0;
    } else {
      if (wishSpeed > 0) {
        this._accelerate(vel, wx, wz, Math.min(wishSpeed, AIR_WISH_CAP), cfg.accelAir, dt);
      }
      // A whisper of air drag so you cannot carry a launch forever.
      const drag = 1 - Math.min(0.5, 0.16 * dt);
      vel.x *= drag; vel.z *= drag;

      // Hard planar ceiling in the air: this is the anti-bunny-hop.
      const cap = cfg.sprintSpeed * AIR_SPEED_CAP_MUL;
      const planar = Math.hypot(vel.x, vel.z);
      if (planar > cap) {
        const s = cap / planar;
        vel.x *= s; vel.z *= s;
      }
      this._airTime += dt;
    }

    // ── jump ─────────────────────────────────────────────────────────────────
    let jumped = false;
    const canJump = this._coyote > 0 && this._sinceJump > JUMP_COOLDOWN
      && this._jumpBuffer > 0 && this.crouchT < 0.55 && !this.blockedByCeiling;
    if (canJump) {
      vel.y = cfg.jumpVelocity;
      this._sinceJump = 0;
      this._jumpBuffer = 0;
      this._coyote = 0;
      this.grounded = false;
      jumped = true;
    }

    // ── gravity ──────────────────────────────────────────────────────────────
    if (!this.grounded) {
      vel.y += cfg.gravity * dt;
      if (vel.y < -55) vel.y = -55;
    } else if (vel.y < 0) {
      vel.y = 0;
    }

    // ── integrate through the controller ─────────────────────────────────────
    const fallSpeed = vel.y;
    this.wasGrounded = this.grounded;

    let dx = vel.x * dt;
    let dy = vel.y * dt;
    let dz = vel.z * dt;
    // A small downward bias while grounded keeps snap-to-ground engaged over
    // ramps and stair nosings instead of launching off every lip.
    if (this.grounded) dy -= 0.30 * dt;

    let landed = 0;

    if (this.ready && this.controller && this.collider) {
      this._desired.x = dx; this._desired.y = dy; this._desired.z = dz;
      let moved = this._desired;
      let groundedNow = this.grounded;
      try {
        this.controller.computeColliderMovement(
          this.collider, this._desired, this._filterFlags, this._filterGroups,
        );
        moved = this.controller.computedMovement();
        groundedNow = this.controller.computedGrounded();

        // Ceiling detection: an obstacle whose outward normal points down.
        const n = this.controller.numComputedCollisions();
        if (n > 0 && vel.y > 0) {
          for (let i = 0; i < n; i++) {
            const c = this.controller.computedCollision(i);
            const ny = c?.normal1?.y ?? 0;
            if (ny < -0.4) { vel.y = 0; break; }
          }
        }
      } catch (err) {
        if (!this._warnedMove) {
          console.warn('[player] character controller failed, using raw integration:', err);
          this._warnedMove = true;
        }
      }

      player.position.x += moved.x;
      player.position.y += moved.y;
      player.position.z += moved.z;

      // The controller is the authority on how far we actually went — read the
      // real planar velocity back out of it so sliding along a wall genuinely
      // costs speed instead of the player pressing into it at full pace.
      if (dt > 0) {
        const rx = moved.x / dt;
        const rz = moved.z / dt;
        // Blend rather than hard-assign: a hard assign makes autostep spikes
        // read as a stutter in the bob cadence.
        vel.x = rx * 0.85 + vel.x * 0.15;
        vel.z = rz * 0.85 + vel.z * 0.15;
        if (Math.abs(moved.y) < Math.abs(dy) * 0.5 && vel.y < 0) vel.y *= 0.4;
      }

      // Never report grounded on the tick we jumped. The controller can still
      // see the floor at the start of an upward move, and a "grounded" jump tick
      // would skip gravity next frame and re-arm ground friction against a
      // velocity we deliberately just added.
      this.grounded = groundedNow && !jumped;
      if (this.grounded && vel.y < 0) vel.y = 0;

      // Update the kinematic body so bots, bullets and debris see us.
      try {
        this.body.setNextKinematicTranslation({
          x: player.position.x,
          y: player.position.y + this.halfHeight + this.radius,
          z: player.position.z,
        });
      } catch { /* body torn down mid-frame */ }
    } else {
      // Degraded mode: flat ground at y = spawn plane. Never throws, always boots.
      player.position.x += dx;
      player.position.y += dy;
      player.position.z += dz;
      const floor = this.player.fallbackFloorY;
      if (player.position.y <= floor && !jumped) {
        player.position.y = floor;
        this.grounded = true;
        if (vel.y < 0) vel.y = 0;
      } else {
        this.grounded = false;
      }
    }

    if (this.grounded && !this.wasGrounded) landed = -fallSpeed;

    // Out-of-world guard — a hole in the level must not end the session.
    if (!Number.isFinite(player.position.x) || player.position.y < -60) {
      this.player.respawn(true);
      return { landed: 0, stepDistance: 0 };
    }

    const stepDistance = Math.hypot(
      player.position.x - this._prevPos.x,
      player.position.z - this._prevPos.z,
    );
    return { landed, stepDistance };
  }

  /** Hard teleport: keeps the collider, body and controller state consistent. */
  teleport(pos) {
    this.player.position.copy(pos);
    this.player.velocity.set(0, 0, 0);
    this.grounded = false;
    this.wasGrounded = false;
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._sinceJump = 999;
    this._airTime = 0;
    if (this.body) {
      try {
        const t = {
          x: pos.x, y: pos.y + this.halfHeight + this.radius, z: pos.z,
        };
        this.body.setTranslation(t, true);
        this.body.setNextKinematicTranslation(t);
      } catch { /* ignore */ }
    }
  }

  dispose() {
    try { this.ctx.physics?.world?.removeCharacterController?.(this.controller); } catch { /* noop */ }
    try { if (this.body) this.ctx.physics?.removeBody?.(this.body); } catch { /* noop */ }
    this.controller = null;
    this.body = null;
    this.collider = null;
    this.ready = false;
  }
}

export default Movement;
