/**
 * OPERATION BLACKOUT — a single rifleman.
 * OWNER: ai agent.
 *
 * State machine, perception, steering and gunnery for one bot. Everything that is
 * per-bot lives here; anything shared (nav grid, geometry template, cover budget,
 * path-request queue) lives on the AISystem and is reached through `this.ai`.
 *
 * Design notes that matter more than the code:
 *
 *  · REACTION DELAY. A bot that acquires you and fires in the same frame feels like
 *    a hitscan turret. 200–400ms of "raise, settle, squeeze" is what makes a
 *    firefight feel human, so it is enforced on every fresh acquisition.
 *  · BELIEVABLE MISSES. Aim error is a slowly-drifting bias plus per-shot jitter,
 *    both scaled by range, target speed and how long the bot has been on target.
 *    Random uniform spread reads as noise; drift reads as a person correcting.
 *  · THE BOT NEVER CHEATS. It only knows where it has actually seen or heard you.
 */
import * as THREE from 'three';
import { SoldierAnim } from './Animator.js';
import { Ragdoll } from './Ragdoll.js';
import { instantiate } from './SoldierRig.js';
import { clamp, clamp01, lerp, angleDelta, damp, dampAngle } from './utils.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _w = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

export const STATE = {
  IDLE: 'IDLE', PATROL: 'PATROL', INVESTIGATE: 'INVESTIGATE', ENGAGE: 'ENGAGE',
  FLANK: 'FLANK', SEEK_COVER: 'SEEK_COVER', RELOAD: 'RELOAD', DEAD: 'DEAD',
};

const EYE_H = 1.60;
const CHEST_H = 1.25;
const BODY_R = 0.34;

let NEXT_ID = 1;

export class Bot {
  constructor(ai, index) {
    this.ai = ai;
    this.ctx = ai.ctx;
    this.index = index;
    this.id = NEXT_ID++;
    this.name = `bot_${this.id}`;
    this.type = 'bot';
    this.isBot = true;
    this.rng = ai.makeRng(this.id * 7919);

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.speed = 0;
    this.groundY = 0;
    this.fallVel = 0;      // >0 while the bot is dropping off a ledge
    this.bodyYaw = 0;
    this.aimYaw = 0;
    this.aimPitch = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.crouch = false;
    this.leanForward = 0;

    this.maxHealth = 100;
    this.health = this.maxHealth;
    this.alive = false;
    this.state = STATE.IDLE;
    this.stateTime = 0;
    this.thinkTimer = this.rng() * 0.12;

    // perception
    this.awareness = 0;
    this.canSeePlayer = false;
    this.sawPlayerAt = -999;
    this.lastKnown = new THREE.Vector3();
    this.hasLastKnown = false;
    this.losTimer = this.rng() * 0.14;
    this.aimTarget = new THREE.Vector3();
    this.targetVelEstimate = new THREE.Vector3();
    this.prevPlayerPos = new THREE.Vector3();

    // gunnery
    this.mag = 30;
    this.magSize = 30;
    this.fireCooldown = 0;
    this.burstLeft = 0;
    this.burstPause = 0;
    this.reactionTimer = 0;
    this.onTargetTime = 0;
    this.aimBias = new THREE.Vector3();
    this.aimBiasTarget = new THREE.Vector3();
    this.reloadTimer = 0;
    this.suppression = 0;

    // navigation
    this.path = [];
    this.pathIndex = 0;
    this.pathAge = 99;
    this.goal = new THREE.Vector3();
    this.hasGoal = false;
    this.repathCooldown = 0;
    this.stuckTimer = 0;
    this.lastProgressPos = new THREE.Vector3();
    this.strafeDir = this.rng() < 0.5 ? 1 : -1;
    this.strafeTimer = 0;

    // cover
    this.coverPos = new THREE.Vector3();
    this.hasCover = false;
    this.peeking = false;
    this.peekTimer = 0;

    // presentation
    this.rig = instantiate(ai.template);
    this.rig.group.visible = false;
    this.anim = new SoldierAnim(this, this.rig, ai.template);
    this.ctx.scene.add(this.rig.group);

    this.ragdoll = null;
    this.corpseTimer = 0;
    this.respawnTimer = 2 + this.rng() * 4;

    // physics proxies
    this.bodyActor = { bot: this, isHead: false, type: 'bot', team: 'enemy', name: this.name };
    this.headActor = { bot: this, isHead: true, type: 'bot', team: 'enemy', name: `${this.name}_head` };
    // Weapon systems differ in how they deliver damage; support every plausible
    // shape. `headY`/`height` are there so a ballistics layer that decides
    // headshots geometrically still gets the right answer if it never sees the
    // separate head collider.
    for (const actor of [this.bodyActor, this.headActor]) {
      actor.health = this.maxHealth;
      actor.height = 1.78;
      Object.defineProperty(actor, 'position', { get: () => this.pos });
      Object.defineProperty(actor, 'headY', { get: () => this.pos.y + (this.crouch ? 1.02 : 1.44) });
      actor.applyDamage = (amount, opts) => {
        actor.__directDamage = true;   // tells the hit:actor listener to stand down
        return this.applyDamage(amount, {
          ...(opts || {}),
          headshot: actor.isHead || !!(opts && (opts.headshot || opts.isHeadshot)),
        });
      };
      actor.takeDamage = actor.applyDamage;
      actor.damage = actor.applyDamage;
    }
    this._makeColliders();
  }

  /* ── physics proxies ──────────────────────────────────────────────────── */

  _makeColliders() {
    const phys = this.ctx.physics;
    if (!phys?.world) return;
    try {
      // Total capsule height 1.72 → halfHeight excludes the caps (physics note #2).
      const r = BODY_R * 0.82;
      const half = Math.max(0.05, (1.72 * 0.5) - r);
      const made = phys.addCapsule(half, r, { x: 0, y: 0.86, z: 0 }, {
        type: 'kinematicPosition',
        group: 'ENEMY',
        material: 'fabric',
        actor: this.bodyActor,
        friction: 0.6,
      });
      if (!made) return;
      this.body = made.body;
      this.collider = made.collider;
      this.capsuleOffset = 0.86;

      const RAPIER = phys.RAPIER;
      if (RAPIER) {
        const hd = RAPIER.ColliderDesc.ball(0.135)
          .setTranslation(0, 1.56 - this.capsuleOffset, 0.02)
          .setFriction(0.4)
          .setCollisionGroups(
            ((((phys.GROUPS?.ENEMY ?? 4) & 0xffff) << 16) >>> 0
              | ((phys.FILTERS?.ENEMY ?? 0xffff) & 0xffff)) >>> 0,
          );
        this.headCollider = phys.world.createCollider(hd, this.body);
        phys.registerActor(this.headCollider, this.headActor);
        phys.registerSurface(this.headCollider, 'fabric');
        phys._queryDirty = true;
      }
    } catch (err) {
      console.warn('[ai] bot collider failed:', err);
    }
  }

  _syncCollider() {
    if (!this.body) return;
    try {
      const y = this.pos.y + (this.crouch ? 0.60 : 0.86);
      this.body.setNextKinematicTranslation({ x: this.pos.x, y, z: this.pos.z });
      if (this.headCollider) {
        const hy = (this.crouch ? 1.14 : 1.56) - (this.crouch ? 0.60 : 0.86);
        this.headCollider.setTranslationWrtParent({ x: 0, y: hy, z: 0.02 });
      }
    } catch { /* body freed mid-frame */ }
  }

  /**
   * INTEGRATION: rapier 0.19's query pipeline keeps returning a collider that has
   * been `setEnabled(false)` — verified by raycasting a corpse point-blank and
   * still getting the capsule back. So bullets kept registering `hit:actor` on a
   * dead soldier: hitmarker ping, blood spray and a reticle flash off a body
   * lying on the floor. Zeroing the *membership* bits is what actually removes it
   * from queries, because rapier's interaction test needs
   * `(membership & otherFilter) !== 0` and 0 can never match.
   */
  _disableCollider(disabled) {
    const phys = this.ctx.physics;
    const groups = disabled
      ? 0
      : ((((phys?.GROUPS?.ENEMY ?? 0x0004) & 0xffff) << 16) >>> 0
         | ((phys?.FILTERS?.ENEMY ?? 0xffff) & 0xffff)) >>> 0;
    for (const col of [this.collider, this.headCollider]) {
      if (!col) continue;
      try {
        col.setEnabled(!disabled);
        col.setCollisionGroups(groups);
      } catch { /* body freed mid-frame */ }
    }
    if (phys) phys._queryDirty = true;
  }

  /* ── spawn / death ────────────────────────────────────────────────────── */

  spawn(position) {
    this.pos.copy(position);
    this.groundY = this.sampleGround(this.pos.x, this.pos.z, this.pos.y);
    this.pos.y = this.groundY;
    this.vel.set(0, 0, 0);
    this.speed = 0;
    this.health = this.maxHealth;
    this.bodyActor.health = this.headActor.health = this.maxHealth;
    this.alive = true;
    this.state = STATE.PATROL;
    this.stateTime = 0;
    this.awareness = 0;
    this.hasLastKnown = false;
    this.mag = this.magSize;
    this.burstLeft = 0;
    this.suppression = 0;
    this.path.length = 0;
    this.hasGoal = false;
    this.hasCover = false;
    this.corpseTimer = 0;

    const px = this.ctx.player?.position ?? _a.set(0, 0, 0);
    this.bodyYaw = Math.atan2(px.x - this.pos.x, px.z - this.pos.z);
    this.aimYaw = this.lookYaw = this.bodyYaw;
    this.aimPitch = this.lookPitch = 0;

    if (this.ragdoll) { this.ragdoll.dispose(); this.ragdoll = null; }
    this.anim.teleport(this.pos);
    this.anim._reset();
    this.rig.group.visible = true;
    this.rig.group.position.copy(this.pos);
    this._disableCollider(false);
    this._syncCollider();
  }

  applyDamage(amount, opts = {}) {
    if (!this.alive) return 0;
    const headshot = !!opts.headshot || !!opts.isHeadshot;
    const dmg = Math.max(0, (Number(amount) || 0)) * (headshot ? 2.6 : 1);
    if (dmg <= 0) return 0;

    this.health -= dmg;
    this.bodyActor.health = this.headActor.health = this.health;
    this.suppression = Math.min(1.6, this.suppression + 0.55);

    const from = opts.from ?? opts.origin ?? opts.point ?? this.ctx.player?.eyePosition;
    if (from) {
      _a.copy(this.pos).sub(from).setY(0);
      if (_a.lengthSq() > 1e-6) _a.normalize(); else _a.set(0, 0, 1);
      this.anim.addHit(_a, headshot ? 1.1 : 0.65);
      // Being shot is the loudest possible cue about where the shooter is.
      this.lastKnown.copy(from);
      this.hasLastKnown = true;
      this.awareness = Math.max(this.awareness, 0.95);
    }

    // Blood is spawned by FX off the canonical 'hit:actor' event that the weapon
    // system emits immediately before calling us. Spraying here as well stacked
    // two bursts on one wound. Only spray when the damage arrived without an
    // event behind it (scripted damage, melee, a future explosion system).
    if (opts.silentSource) {
      try { this.ctx.fx?.spawnBloodHit?.(opts.point ?? this.chestPoint(_b), _a); } catch { /* optional */ }
    }

    if (this.health <= 0) {
      this.die({ headshot, hitDir: _a, killer: opts.killer ?? this.ctx.player ?? null });
      return dmg;
    }
    if (this.state !== STATE.ENGAGE && this.state !== STATE.SEEK_COVER) this.setState(STATE.ENGAGE);
    return dmg;
  }

  die(opts = {}) {
    if (!this.alive) return;
    this.alive = false;
    this.state = STATE.DEAD;
    this.stateTime = 0;
    this.corpseTimer = 0;
    this.respawnTimer = this.ai.respawnDelay();
    this.burstLeft = 0;
    this._disableCollider(true);

    try {
      this.ragdoll = this.ai.acquireRagdoll(this, {
        velocity: this.vel,
        hitDir: opts.hitDir,
        hitPower: opts.headshot ? 1.6 : 1.0,
        headshot: !!opts.headshot,
      });
    } catch (err) {
      console.warn('[ai] ragdoll spawn failed:', err);
      this.ragdoll = null;
    }

    try {
      this.ctx.events?.emit('actor:death', { actor: this.bodyActor, killer: opts.killer ?? null });
    } catch { /* noop */ }
    try { this.ctx.audio?.play?.('death', { position: this.chestPoint(_b), volume: 0.9 }); } catch { /* noop */ }
  }

  /* ── helpers ──────────────────────────────────────────────────────────── */

  eyePoint(out) { return out.set(this.pos.x, this.pos.y + (this.crouch ? 1.16 : EYE_H), this.pos.z); }
  chestPoint(out) { return out.set(this.pos.x, this.pos.y + (this.crouch ? 0.92 : CHEST_H), this.pos.z); }

  /**
   * Ground height under a world XZ, raycast-accurate, nav-grid fallback.
   *
   * The probe used to stop 4.2m down, so stepping off anything taller than that
   * returned no hit and fell through to the nav grid — which stores the height
   * of whatever the *downward build ray* struck first, i.e. the catwalk, not the
   * yard underneath it. The bot then "stood" on a surface that was no longer
   * beneath it. Reach the whole way to the floor and let the caller fall.
   */
  sampleGround(x, z, fallback = 0) {
    const phys = this.ctx.physics;
    if (phys?.world) {
      _c.set(x, (this.pos.y || fallback) + 1.4, z);
      const hit = phys.raycast(_c, _down, 60, { group: 'PROJECTILE', mask: 1, reuse: true });
      if (hit) return hit.point.y;
    }
    const nav = this.ai.nav;
    if (nav?.ready) return nav.groundAt(x, z, fallback);
    return fallback;
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.stateTime = 0;
    if (next !== STATE.ENGAGE) this.burstLeft = 0;
  }

  /* ── perception ───────────────────────────────────────────────────────── */

  _perceive(dt) {
    const player = this.ctx.player;
    if (!player) return;

    this.losTimer -= dt;
    const playerAlive = (player.health ?? 100) > 0;

    if (this.losTimer <= 0) {
      this.losTimer = 0.11 + this.rng() * 0.06;
      this.canSeePlayer = false;
      if (playerAlive && this.ai.losBudget > 0) {
        this.eyePoint(_a);
        const target = player.eyePosition ?? _b.copy(player.position).setY(player.position.y + 1.6);
        _c.copy(target).sub(_a);
        const dist = _c.length();
        if (dist < 78) {
          _c.divideScalar(Math.max(1e-4, dist));
          const facing = _c.x * Math.sin(this.aimYaw) + _c.z * Math.cos(this.aimYaw);
          // 115° cone, opening to nearly full circle at knife range
          const coneCos = dist < 4 ? -0.5 : -0.20;
          if (facing > coneCos) {
            this.ai.losBudget--;
            if (this.ctx.physics?.hasLineOfSight(_a, target)) {
              this.canSeePlayer = true;
            } else {
              // second chance at the chest — heads peek over cover the body does not
              _d.copy(player.position).setY(player.position.y + 1.0);
              this.ai.losBudget--;
              if (this.ctx.physics.hasLineOfSight(_a, _d)) this.canSeePlayer = true;
            }
          }
        }
      }
    }

    if (this.canSeePlayer) {
      const p = player.position;
      this.eyePoint(_a);
      const dist = _a.distanceTo(p);
      // Closer, more central and faster-moving targets register quicker.
      const moving = clamp01((player.velocity?.length?.() ?? 0) / 5);
      const rate = (1.9 - clamp01(dist / 70) * 1.1) * (0.72 + moving * 0.5)
        * (player.isSprinting ? 1.35 : 1) * (player.isCrouching ? 0.7 : 1);
      this.awareness = Math.min(1.35, this.awareness + rate * dt);
      this.lastKnown.copy(p);
      this.hasLastKnown = true;
      this.sawPlayerAt = this.ai.time;

      // velocity estimate for lead, deliberately lagged
      _b.copy(p).sub(this.prevPlayerPos).divideScalar(Math.max(1e-3, dt));
      if (_b.lengthSq() < 400) this.targetVelEstimate.lerp(_b, 1 - Math.exp(-6 * dt));
      this.prevPlayerPos.copy(p);
    } else {
      this.awareness = Math.max(0, this.awareness - dt * (this.state === STATE.ENGAGE ? 0.16 : 0.36));
      this.targetVelEstimate.multiplyScalar(Math.exp(-2 * dt));
    }

    this.suppression = Math.max(0, this.suppression - dt * 0.5);
  }

  /** Gunshot heard: `pos` is where the shot came from, `strength` 0..1. */
  hearGunshot(pos, strength) {
    if (!this.alive) return;
    this.lastKnown.copy(pos);
    this.hasLastKnown = true;
    this.awareness = Math.min(1.35, this.awareness + 0.55 * strength);
    if (this.state === STATE.IDLE || this.state === STATE.PATROL) {
      this.setState(this.awareness > 0.9 ? STATE.ENGAGE : STATE.INVESTIGATE);
      this.hasGoal = false;
    }
  }

  /* ── navigation ───────────────────────────────────────────────────────── */

  setGoal(point) {
    this.goal.copy(point);
    this.hasGoal = true;
    this.pathAge = 99;
  }

  _followPath(dt, desiredSpeed, out) {
    out.set(0, 0, 0);
    if (!this.hasGoal) return 0;

    this.pathAge += dt;
    this.repathCooldown -= dt;
    const needPath = this.path.length === 0
      || this.pathIndex >= this.path.length
      || this.pathAge > 2.4;
    if (needPath && this.repathCooldown <= 0 && this.ai.requestPath(this)) {
      this.repathCooldown = 0.35 + this.rng() * 0.3;
    }

    if (this.path.length === 0) {
      // No path yet: steer straight at the goal so the bot never stands frozen.
      out.copy(this.goal).sub(this.pos).setY(0);
      const d = out.length();
      if (d < 0.6) { this.hasGoal = false; return 0; }
      out.divideScalar(d);
      return desiredSpeed;
    }

    let node = this.path[Math.min(this.pathIndex, this.path.length - 1)];
    _a.copy(node).sub(this.pos).setY(0);
    let d = _a.length();
    const arrive = this.pathIndex >= this.path.length - 1 ? 0.55 : 0.85;
    while (d < arrive && this.pathIndex < this.path.length - 1) {
      this.pathIndex++;
      node = this.path[this.pathIndex];
      _a.copy(node).sub(this.pos).setY(0);
      d = _a.length();
    }
    if (d < arrive && this.pathIndex >= this.path.length - 1) {
      this.hasGoal = false;
      this.path.length = 0;
      return 0;
    }
    out.copy(_a).divideScalar(Math.max(1e-4, d));
    // ease off on the last metre so bots stop instead of overshooting
    return desiredSpeed * clamp01(d / 1.2 + 0.25);
  }

  /* ── movement integration ─────────────────────────────────────────────── */

  _move(dt, wishDir, wishSpeed) {
    // separation from squadmates: gives the squad natural spacing
    _b.set(0, 0, 0);
    const bots = this.ai.bots;
    for (let i = 0; i < bots.length; i++) {
      const o = bots[i];
      if (o === this || !o.alive) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 1.44 || d2 < 1e-5) continue;
      const d = Math.sqrt(d2);
      _b.x += (dx / d) * (1.2 - d);
      _b.z += (dz / d) * (1.2 - d);
    }
    if (_b.lengthSq() > 1e-6) {
      wishDir.addScaledVector(_b, 1.6);
      if (wishDir.lengthSq() > 1e-6) wishDir.normalize();
    }

    const target = _c.copy(wishDir).multiplyScalar(wishSpeed);
    const accel = wishSpeed > 0.1 ? 14 : 20;
    this.vel.x = damp(this.vel.x, target.x, accel, dt);
    this.vel.z = damp(this.vel.z, target.z, accel, dt);
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    if (this.speed < 0.05) { this.vel.x = this.vel.z = 0; this.speed = 0; }

    if (this.speed > 0.01) {
      const stepX = this.vel.x * dt, stepZ = this.vel.z * dt;
      const nx = this.pos.x + stepX, nz = this.pos.z + stepZ;
      // Wall probe at chest height so bots do not walk into geometry the nav grid
      // rounded off. Cheap: one ray, and only while actually moving.
      const phys = this.ctx.physics;
      let blocked = false;
      if (phys?.world && this.ai.wallBudget > 0) {
        this.ai.wallBudget--;
        this.chestPoint(_a);
        _d.set(this.vel.x, 0, this.vel.z).normalize();
        const hit = phys.raycast(_a, _d, 0.55, { group: 'PROJECTILE', mask: 1, reuse: true });
        if (hit) {
          blocked = true;
          // slide along the wall instead of stopping dead
          const n = hit.normal;
          const dot = this.vel.x * n.x + this.vel.z * n.z;
          this.vel.x -= n.x * dot; this.vel.z -= n.z * dot;
          this.pos.x += this.vel.x * dt;
          this.pos.z += this.vel.z * dt;
        }
      }
      if (!blocked) { this.pos.x = nx; this.pos.z = nz; }
    }

    const g = this.sampleGround(this.pos.x, this.pos.z, this.groundY);
    // INTEGRATION FIX — soldiers hovering 8m in the air.
    //
    // This used to be a symmetric clamp: any ground delta over 1.6m was rejected
    // and the bot simply kept its old height. Rejecting a step *up* is right (a
    // bot must not teleport up a wall) but rejecting a step *down* left anyone
    // who walked off the elevated catwalk stranded in mid-air permanently —
    // three of seven bots were floating over the yard in the spawn framing.
    // Downward deltas now fall under gravity instead of being ignored.
    const drop = this.groundY - g;
    if (drop > 0.55) {
      this.fallVel = Math.min(this.fallVel + 24 * dt, 28);
      this.groundY = Math.max(g, this.groundY - this.fallVel * dt);
      if (this.groundY - g < 1e-3) { this.groundY = g; this.fallVel = 0; }
    } else {
      this.fallVel = 0;
      // Never teleport up a wall; step up only within stride height.
      this.groundY = (g - this.groundY) > 1.6 ? this.groundY : damp(this.groundY, g, 22, dt);
    }
    this.pos.y = this.groundY;

    // stuck detection
    if (this.hasGoal) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 1.1) {
        if (this.pos.distanceToSquared(this.lastProgressPos) < 0.09) {
          this.path.length = 0;
          this.pathAge = 99;
          this.repathCooldown = 0;
          // shove sideways so the next path starts from a different cell
          this.pos.x += Math.cos(this.bodyYaw) * 0.22 * this.strafeDir;
          this.pos.z -= Math.sin(this.bodyYaw) * 0.22 * this.strafeDir;
          this.strafeDir *= -1;
        }
        this.lastProgressPos.copy(this.pos);
        this.stuckTimer = 0;
      }
    } else {
      this.stuckTimer = 0;
      this.lastProgressPos.copy(this.pos);
    }
  }

  /* ── gunnery ──────────────────────────────────────────────────────────── */

  _aimAndShoot(dt) {
    const player = this.ctx.player;
    const engaging = this.state === STATE.ENGAGE || this.state === STATE.FLANK;
    const hasTarget = engaging && this.hasLastKnown && player;

    // Where the bot believes the target is.
    if (hasTarget) {
      if (this.canSeePlayer) {
        this.onTargetTime += dt;
        const lead = 0.10 + this.rng() * 0.06;
        _a.copy(player.position)
          .addScaledVector(this.targetVelEstimate, lead)
          .setY(player.position.y + (player.isCrouching ? 0.85 : 1.18));
      } else {
        this.onTargetTime = Math.max(0, this.onTargetTime - dt * 2.5);
        _a.copy(this.lastKnown).setY(this.lastKnown.y + 0.9);
      }

      // Slowly drifting bias: this is what makes misses read as a person.
      if (this.rng() < dt * 1.6) {
        const dist = this.pos.distanceTo(player.position);
        const spread = (0.16 + dist * 0.022)
          * (1 + this.suppression * 0.9)
          * (1 - clamp01(this.onTargetTime / 2.4) * 0.55)
          * (this.crouch ? 0.72 : 1);
        this.aimBiasTarget.set(
          (this.rng() * 2 - 1) * spread,
          (this.rng() * 2 - 1) * spread * 0.55,
          (this.rng() * 2 - 1) * spread,
        );
      }
      this.aimBias.lerp(this.aimBiasTarget, 1 - Math.exp(-5.5 * dt));
      _a.add(this.aimBias);
      this.aimTarget.lerp(_a, 1 - Math.exp(-13 * dt));
    } else {
      // Idle: look where you are walking, or scan.
      this.aimTarget.lerp(_a.set(
        this.pos.x + Math.sin(this.lookYaw) * 12,
        this.pos.y + 1.4,
        this.pos.z + Math.cos(this.lookYaw) * 12,
      ), 1 - Math.exp(-4 * dt));
    }

    this.eyePoint(_b);
    _c.copy(this.aimTarget).sub(_b);
    const flat = Math.hypot(_c.x, _c.z);
    const wantYaw = Math.atan2(_c.x, _c.z);
    const wantPitch = Math.atan2(_c.y, Math.max(0.05, flat));
    const turnRate = engaging ? 9 : 4.5;
    this.aimYaw = dampAngle(this.aimYaw, wantYaw, turnRate, dt);
    this.aimPitch = damp(this.aimPitch, wantPitch, turnRate, dt);
    this.lookYaw = dampAngle(this.lookYaw, wantYaw, turnRate * 0.8, dt);
    this.lookPitch = damp(this.lookPitch, wantPitch, turnRate * 0.8, dt);

    // ── trigger discipline ──
    this.fireCooldown -= dt;
    this.burstPause -= dt;
    if (this.state === STATE.RELOAD) return;

    const wantsToShoot = this.state === STATE.ENGAGE
      && this.canSeePlayer
      && (!this.hasCover || this.peeking)
      && this.mag > 0;

    if (!wantsToShoot) {
      this.reactionTimer = 0.20 + this.rng() * 0.20;   // fresh delay on re-acquisition
      return;
    }
    if (this.reactionTimer > 0) { this.reactionTimer -= dt; return; }

    // muzzle must actually be pointing near the target before the trigger breaks
    const aimErr = Math.abs(angleDelta(this.aimYaw, wantYaw));
    if (aimErr > 0.22) return;

    if (this.burstLeft <= 0) {
      if (this.burstPause > 0) return;
      this.burstLeft = 3 + ((this.rng() * 3) | 0);
      this.burstLeft = Math.min(this.burstLeft, this.mag);
    }
    if (this.fireCooldown > 0) return;

    this._fire();
    this.fireCooldown = 60 / 720;
    this.burstLeft--;
    if (this.burstLeft <= 0) this.burstPause = 0.34 + this.rng() * 0.8;
    if (this.mag <= 0) this.setState(STATE.RELOAD);
  }

  _fire() {
    this.mag--;
    this.anim.addRecoil(0.85 + this.rng() * 0.35);

    const from = _a.copy(this.anim.muzzleWorld);
    const dir = _b.copy(this.aimTarget).sub(from);
    if (dir.lengthSq() < 1e-6) return;
    dir.normalize();
    // per-shot jitter on top of the drifting bias
    const j = 0.006 + this.suppression * 0.006;
    dir.x += (this.rng() * 2 - 1) * j;
    dir.y += (this.rng() * 2 - 1) * j;
    dir.z += (this.rng() * 2 - 1) * j;
    dir.normalize();

    const ctx = this.ctx;
    try { ctx.fx?.spawnMuzzleFlash?.(this.anim.muzzleMatrix, 0.75); } catch { /* optional */ }
    try {
      ctx.audio?.play?.('rifle_fire', { position: from, volume: 0.55, pitch: 0.92 + this.rng() * 0.1 });
    } catch { /* optional */ }
    try { ctx.lighting?.flash?.(from, 0.35); } catch { /* optional */ }

    const phys = ctx.physics;
    let hitDist = 140;
    let hitPoint = null, hitNormal = null, hitMaterial = 'concrete';
    if (phys?.world) {
      const hit = phys.raycast(from, dir, 140, { group: 'PROJECTILE', mask: 1, reuse: true });
      if (hit) {
        hitDist = hit.distance;
        hitPoint = _c.copy(hit.point);
        hitNormal = _d.copy(hit.normal);
        hitMaterial = hit.material;
      }
    }

    // Analytic ray/capsule test against the player. Done in code rather than through
    // the physics query so it works whether or not the player owns a collider.
    const player = ctx.player;
    let struckPlayer = false;
    if (player?.position) {
      const h = player.isCrouching ? 1.05 : 1.75;
      const closest = this._rayCapsule(from, dir, player.position, h, 0.30);
      if (closest !== null && closest < hitDist) {
        struckPlayer = true;
        hitDist = closest;
      }
    }

    const end = new THREE.Vector3().copy(from).addScaledVector(dir, Math.min(hitDist, 140));
    try { ctx.fx?.spawnTracer?.(from, end, 620); } catch { /* optional */ }

    if (struckPlayer) {
      const dmg = 7 + this.rng() * 5;
      try { ctx.fx?.spawnBloodHit?.(end, _d.copy(dir).negate()); } catch { /* optional */ }
      this.ai.damagePlayer(dmg, from);
    } else {
      if (hitPoint) {
        // spawnImpact lays its own material-correct decal — a second generic
        // 'bullet' decal on top just doubled the decal churn.
        try { ctx.fx?.spawnImpact?.(hitPoint, hitNormal, hitMaterial); } catch { /* optional */ }
      }
      // near-miss crack for anything passing within a metre of the player's head
      if (player?.eyePosition) {
        const miss = this._rayPointDistance(from, dir, player.eyePosition, hitDist);
        if (miss < 1.4) {
          try { ctx.audio?.play?.('bullet_whiz', { position: player.eyePosition, volume: 0.5 }); } catch { /* optional */ }
        }
      }
    }
  }

  /** Distance along the ray at which it first enters a vertical capsule, else null. */
  _rayCapsule(origin, dir, feet, height, radius) {
    // Treat the player as a vertical segment with a radius — accurate enough and
    // branchless compared with a true capsule intersection.
    const ax = feet.x, ay = feet.y + radius, az = feet.z;
    const by = feet.y + height - radius;
    let bestT = null;
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const py = lerp(ay, by, i / steps);
      const ox = ax - origin.x, oy = py - origin.y, oz = az - origin.z;
      const t = ox * dir.x + oy * dir.y + oz * dir.z;
      if (t < 0) continue;
      const dx = ox - dir.x * t, dy = oy - dir.y * t, dz = oz - dir.z * t;
      if (dx * dx + dy * dy + dz * dz <= radius * radius) {
        const enter = Math.max(0, t - radius);
        if (bestT === null || enter < bestT) bestT = enter;
      }
    }
    return bestT;
  }

  _rayPointDistance(origin, dir, point, maxT) {
    const ox = point.x - origin.x, oy = point.y - origin.y, oz = point.z - origin.z;
    const t = clamp(ox * dir.x + oy * dir.y + oz * dir.z, 0, maxT);
    const dx = ox - dir.x * t, dy = oy - dir.y * t, dz = oz - dir.z * t;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* ── the state machine ────────────────────────────────────────────────── */

  _think(dt) {
    const player = this.ctx.player;
    const distToPlayer = player ? this.pos.distanceTo(player.position) : 999;
    const alerted = this.awareness >= 1.0;
    const hurt = this.health < this.maxHealth * 0.42;

    switch (this.state) {
      case STATE.IDLE:
        this.crouch = false;
        if (this.stateTime > 1.5 + this.rng() * 3) this.setState(STATE.PATROL);
        if (alerted) this.setState(STATE.ENGAGE);
        else if (this.awareness > 0.35 && this.hasLastKnown) this.setState(STATE.INVESTIGATE);
        break;

      case STATE.PATROL:
        this.crouch = false;
        if (!this.hasGoal) {
          const cell = this.ai.nav?.randomWalkable(this.rng, this.pos, 9);
          if (cell !== undefined && cell >= 0) {
            this.ai.nav.cellCentre(cell, _a);
            this.setGoal(_a);
          } else if (this.stateTime > 1.2) {
            this.setState(STATE.IDLE);
          }
        }
        if (alerted) { this.setState(STATE.ENGAGE); this.hasGoal = false; }
        else if (this.awareness > 0.35 && this.hasLastKnown) { this.setState(STATE.INVESTIGATE); this.hasGoal = false; }
        break;

      case STATE.INVESTIGATE:
        this.crouch = false;
        if (alerted) { this.setState(STATE.ENGAGE); this.hasGoal = false; break; }
        if (!this.hasGoal) {
          if (this.hasLastKnown && this.stateTime < 0.4) {
            this.setGoal(this.lastKnown);
          } else if (this.stateTime > 3.5 + this.rng() * 2.5) {
            this.hasLastKnown = false;
            this.setState(STATE.PATROL);
          } else {
            // sweep the muzzle across the area before giving up
            this.lookYaw += (this.rng() - 0.5) * 0.9;
          }
        }
        break;

      case STATE.ENGAGE:
        this._engageThink(dt, distToPlayer, hurt);
        break;

      case STATE.FLANK:
        this.crouch = false;
        if (!this.hasGoal || this.stateTime > 7) { this.setState(STATE.ENGAGE); this.hasGoal = false; }
        else if (this.canSeePlayer && this.stateTime > 1.4) { this.setState(STATE.ENGAGE); this.hasGoal = false; }
        break;

      case STATE.SEEK_COVER:
        if (!this.hasGoal) {
          this.hasCover = true;
          this.coverPos.copy(this.pos);
          this.setState(STATE.ENGAGE);
        } else if (this.stateTime > 6) {
          this.setState(STATE.ENGAGE);
          this.hasGoal = false;
        }
        break;

      case STATE.RELOAD:
        this.crouch = this.hasCover || hurt;
        if (this.stateTime > 2.35) {
          this.mag = this.magSize;
          this.setState(this.awareness > 0.6 ? STATE.ENGAGE : STATE.PATROL);
        }
        break;

      default: break;
    }

    if (this.mag <= 0 && this.state !== STATE.RELOAD && this.state !== STATE.DEAD) {
      this.setState(STATE.RELOAD);
      try { this.ctx.audio?.play?.('reload_mag_out', { position: this.chestPoint(_a), volume: 0.35 }); } catch { /* optional */ }
    }
  }

  _engageThink(dt, dist, hurt) {
    const nav = this.ai.nav;
    const player = this.ctx.player;
    if (!player) { this.setState(STATE.PATROL); return; }

    // Cover cycling: sit behind the geometry, pop out, shoot, drop back.
    if (this.hasCover) {
      this.peekTimer -= dt;
      if (this.peekTimer <= 0) {
        this.peeking = !this.peeking;
        this.peekTimer = this.peeking ? 0.9 + this.rng() * 1.1 : 1.1 + this.rng() * 1.3;
      }
      this.crouch = !this.peeking;
      // lost the player entirely? abandon the position
      if (this.ai.time - this.sawPlayerAt > 5.5) { this.hasCover = false; this.peeking = true; }
    } else {
      this.crouch = hurt && this.canSeePlayer && this.rng() < 0.5;
      this.peeking = true;
    }

    // Decide whether to reposition.
    if (!this.hasGoal) {
      const wantCover = (hurt || this.suppression > 0.7 || !this.canSeePlayer) && !this.hasCover;
      if (wantCover) {
        const cover = this.ai.findCover(this);
        if (cover) { this.setGoal(cover); this.setState(STATE.SEEK_COVER); return; }
      }
      if (!this.canSeePlayer && this.ai.time - this.sawPlayerAt > 2.4 && this.hasLastKnown) {
        // Break contact and come at it from a new angle.
        const flank = this.ai.findFlank(this);
        if (flank) { this.setGoal(flank); this.setState(STATE.FLANK); return; }
        this.setGoal(this.lastKnown);
        return;
      }
      if (dist > 26 && this.canSeePlayer && this.rng() < 0.5) {
        // close the distance to an effective range
        _a.copy(player.position).sub(this.pos).setY(0).normalize()
          .multiplyScalar(dist - 16).add(this.pos);
        if (nav?.ready) {
          const c = nav.nearestWalkable(_a.x, _a.z, 4);
          if (c >= 0) { nav.cellCentre(c, _a); this.setGoal(_a); }
        } else this.setGoal(_a);
        return;
      }
      if (dist < 6.5 && this.canSeePlayer) {
        // too close: back off rather than nose-to-nose
        _a.copy(this.pos).sub(player.position).setY(0).normalize()
          .multiplyScalar(5).add(this.pos);
        if (nav?.ready) {
          const c = nav.nearestWalkable(_a.x, _a.z, 3);
          if (c >= 0) { nav.cellCentre(c, _a); this.setGoal(_a); }
        }
        return;
      }
    }

    if (this.awareness <= 0.18 && this.ai.time - this.sawPlayerAt > 9) {
      this.hasCover = false;
      this.setState(STATE.INVESTIGATE);
    }
  }

  /* ── per-frame ────────────────────────────────────────────────────────── */

  update(dt, detail) {
    this.stateTime += dt;

    if (!this.alive) {
      this.corpseTimer += dt;
      this.respawnTimer -= dt;
      if (this.ragdoll?.ok) {
        try {
          this.ragdoll.clampVelocities();
          this.ragdoll.apply(dt);
        } catch (err) {
          console.warn('[ai] ragdoll update failed:', err);
          this.ragdoll.ok = false;
        }
      }
      if (this.respawnTimer <= 0) this.ai.requestRespawn(this);
      return;
    }

    this._perceive(dt);

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      const step = 0.11 + this.rng() * 0.05;
      this.thinkTimer = step;
      try { this._think(step); } catch (err) { console.warn('[ai] think failed:', err); this.setState(STATE.PATROL); }
    }

    // desired speed by state
    let desired;
    switch (this.state) {
      case STATE.PATROL: desired = 1.75; break;
      case STATE.INVESTIGATE: desired = 2.55; break;
      case STATE.ENGAGE: desired = this.crouch ? 1.15 : 2.9; break;
      case STATE.FLANK: desired = 5.1; break;
      case STATE.SEEK_COVER: desired = 5.4; break;
      case STATE.RELOAD: desired = this.hasCover ? 0 : 1.7; break;
      default: desired = 0;
    }

    const wish = _w.set(0, 0, 0);
    let wishSpeed = this._followPath(dt, desired, wish);

    // Combat strafing: never stand still in the open while shooting.
    if (this.state === STATE.ENGAGE && !this.hasGoal && this.canSeePlayer && !this.hasCover) {
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeTimer = 0.9 + this.rng() * 1.5;
        this.strafeDir *= this.rng() < 0.62 ? -1 : 1;
      }
      _a.copy(this.ctx.player.position).sub(this.pos).setY(0);
      if (_a.lengthSq() > 1e-4) {
        _a.normalize();
        wish.set(_a.z * this.strafeDir, 0, -_a.x * this.strafeDir);
        wishSpeed = this.crouch ? 1.0 : 2.4;
      }
    }

    this._move(dt, wish, wishSpeed);

    // Lower body faces travel; if standing still it settles toward the aim.
    if (this.speed > 0.45) {
      const moveYaw = Math.atan2(this.vel.x, this.vel.z);
      // Trained soldiers keep the muzzle up: cap how far the legs may diverge.
      const diff = angleDelta(this.aimYaw, moveYaw);
      const capped = this.aimYaw + clamp(diff, -1.35, 1.35);
      this.bodyYaw = dampAngle(this.bodyYaw, capped, 7.5, dt);
    } else {
      this.bodyYaw = dampAngle(this.bodyYaw, this.aimYaw, 4.2, dt);
    }
    this.leanForward = clamp01(this.speed / 5.5) * 0.22 + (this.state === STATE.ENGAGE ? 0.10 : 0);

    this._aimAndShoot(dt);
    this._syncCollider();

    // Animation — full solve up close, cheap solve for distant background bots.
    const st = this._animState;
    st.px = this.pos.x; st.pz = this.pos.z; st.groundY = this.pos.y;
    st.speed = this.speed;
    st.bodyYaw = this.bodyYaw; st.aimYaw = this.aimYaw; st.aimPitch = this.aimPitch;
    st.lookYaw = this.lookYaw; st.lookPitch = this.lookPitch;
    st.crouch = this.crouch;
    st.aiming = this.state === STATE.ENGAGE || this.state === STATE.FLANK
      || (this.state === STATE.INVESTIGATE && this.awareness > 0.5);
    st.aimTarget = st.aiming ? this.aimTarget : null;
    st.leanForward = this.leanForward;

    if (detail > 0) {
      try { this.anim.update(dt, st); } catch (err) {
        if (!this._animError) { this._animError = true; console.warn('[ai] animation failed:', err); }
      }
    } else {
      this.rig.group.position.set(this.pos.x, this.pos.y, this.pos.z);
      this.rig.group.rotation.set(0, this.bodyYaw, 0);
    }
  }

  get _animState() {
    if (!this.__animState) {
      this.__animState = {
        px: 0, pz: 0, groundY: 0, speed: 0, bodyYaw: 0, aimYaw: 0, aimPitch: 0,
        lookYaw: 0, lookPitch: 0, crouch: false, aiming: false, aimTarget: null,
        leanForward: 0,
      };
    }
    return this.__animState;
  }

  dispose() {
    try { this.ragdoll?.dispose(); } catch { /* noop */ }
    try {
      const phys = this.ctx.physics;
      if (this.headCollider) phys?.unregisterActor?.(this.headCollider);
      if (this.body) phys?.removeBody?.(this.body);
    } catch { /* noop */ }
    try { this.ctx.scene.remove(this.rig.group); } catch { /* noop */ }
  }
}

export default Bot;
