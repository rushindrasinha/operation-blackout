import * as THREE from 'three';
import { PENETRABLE } from './defs.js';

/**
 * OPERATION BLACKOUT — hitscan ballistics.
 *
 * Hitscan with a real spread state machine, distance falloff, headshot detection
 * and material penetration. The spread state is the part that carries the feel:
 * it grows per shot and with movement, shrinks when still / crouched / aimed, and
 * has a short recovery delay so tapping is rewarded and holding the trigger is not.
 *
 * OWNER: weapons.
 */

const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class Ballistics {
  constructor(ctx) {
    this.ctx = ctx;
    this.spread = 0;
    this._sinceShot = 10;
    this._pierceBudget = 0;
  }

  reset() { this.spread = 0; this._sinceShot = 10; }

  /**
   * @param {number} dt
   * @param {object} def weapon definition
   * @param {object} s   { moving01, sprinting, crouching, grounded, adsT }
   */
  update(dt, def, s) {
    const sp = def.spread;
    this._sinceShot += dt;
    if (this._sinceShot > sp.recoveryDelay) {
      const rate = sp.recovery * (1 + (s.adsT ?? 0) * 1.3) * (s.crouching ? 1.35 : 1);
      this.spread = Math.max(0, this.spread - rate * dt);
    }
  }

  /** Total cone half-angle in radians for the next shot. */
  currentSpread(def, s) {
    const sp = def.spread;
    let base = THREE.MathUtils.lerp(sp.base, sp.ads, s.adsT ?? 0);
    if (s.crouching) base *= sp.crouch;
    let total = base + this.spread;
    total += sp.moving * (s.moving01 ?? 0) * (1 - (s.adsT ?? 0) * 0.45);
    if (s.sprinting) total += sp.sprint;
    if (s.grounded === false) total += sp.air;
    return Math.min(sp.max + base, total);
  }

  bumpSpread(def) {
    const sp = def.spread;
    this.spread = Math.min(sp.max, this.spread + sp.perShot);
    this._sinceShot = 0;
  }

  /**
   * Fire one round.
   *
   * @param {object} def
   * @param {THREE.Vector3} origin     eye position
   * @param {THREE.Vector3} forward    normalised look direction
   * @param {number} spreadAngle       cone half-angle, radians
   * @param {object} opts { shooter, seed }
   * @returns {{ hits:Array, dir:THREE.Vector3, end:THREE.Vector3 }}
   */
  fire(def, origin, forward, spreadAngle, opts = {}) {
    const physics = this.ctx.physics;
    const out = { hits: [], dir: new THREE.Vector3(), end: new THREE.Vector3() };

    _dir.copy(forward).normalize();

    // Uniform disc sampling inside the cone, oriented by a stable basis.
    if (spreadAngle > 1e-6) {
      _up.set(0, 1, 0);
      if (Math.abs(_dir.y) > 0.985) _up.set(1, 0, 0);
      _side.crossVectors(_dir, _up).normalize();
      _up.crossVectors(_side, _dir).normalize();
      const r = Math.sqrt(Math.random()) * spreadAngle;
      const a = Math.random() * Math.PI * 2;
      _dir.addScaledVector(_side, Math.tan(r) * Math.cos(a));
      _dir.addScaledVector(_up, Math.tan(r) * Math.sin(a));
      _dir.normalize();
    }
    out.dir.copy(_dir);

    if (!physics || typeof physics.raycast !== 'function') {
      out.end.copy(origin).addScaledVector(_dir, def.range);
      return out;
    }

    const G = physics.GROUPS ?? { PROJECTILE: 0x0010, WORLD: 0x0001, PLAYER: 0x0002, ENEMY: 0x0004 };
    // PROJECTILE membership with a WORLD|ENEMY mask: bullets ignore debris, the
    // shell casings we just ejected, and the shooter's own capsule.
    const filter = {
      group: G.PROJECTILE,
      mask: (G.WORLD | G.ENEMY) >>> 0,
      excludeActor: opts.shooter ?? null,
    };

    _origin.copy(origin);
    let remaining = def.range;
    let pierce = def.penetration ?? 0;
    let damageScale = 1;
    /** Distance from the true muzzle origin to the current segment origin. */
    let advanced = 0;

    /**
     * Every actor this round has already resolved, keyed by *body*, not by
     * collider.
     *
     * DEFECT FIX (double hit:actor). A bot is two overlapping colliders sharing
     * one rigid body: a 1.72 m capsule and a 0.135 m head ball whose centre sits
     * at 1.56 m — i.e. the head is entirely *inside* the capsule. The old loop
     * stepped the segment origin 3 cm past each impact and re-cast, and 3 cm past
     * the capsule surface is still inside the bot, so Rapier (solid: true) handed
     * back a second intersection at timeOfImpact 0. The result was two records at
     * an identical distance, both `actor: true`, both `mat: fabric` — exactly the
     * QA trace. Downstream that was not merely double damage: WeaponSystem emits
     * `hit:actor` and *then* calls `actor.applyDamage()`, and the AI system's
     * `__directDamage` de-dupe flag is a single boolean per actor, so two hits in
     * one round defeated it and the second hit landed a third time. Measured:
     * 58.2 damage for one 26-damage round, bot dead in 2 rounds instead of 4.
     *
     * The rule now: one ray, one `hit:actor` per body per round. Interior
     * colliders of an already-resolved body are stepped over silently.
     */
    const seen = new Set();

    // A body is at most ~0.56 m thick (capsule diameter). Jump clear of the whole
    // actor in one step when a round penetrates rather than crawling 3 cm at a
    // time through its interior.
    const ACTOR_DEPTH = 0.62;
    const INTERIOR_STEP = 0.22;

    for (let seg = 0; seg < 6; seg++) {
      if (remaining <= 0.2) break;
      let hit = null;
      try {
        hit = physics.raycast(_origin, _dir, remaining, filter);
      } catch (err) {
        console.warn('[weapons] raycast failed:', err);
        hit = null;
      }
      if (!hit) break;

      const actor = hit.actor ?? null;
      const body = actor ? this._actorBody(actor) : null;

      // Already resolved this body — this is one of its interior colliders (or the
      // far wall of the same capsule). Step over it without emitting anything.
      if (body !== null && seen.has(body)) {
        const step = hit.distance + INTERIOR_STEP;
        _origin.addScaledVector(_dir, step);
        advanced += step;
        remaining -= step;
        continue;
      }

      const travelled = advanced + hit.distance;
      const record = {
        point: hit.point.clone(),
        normal: hit.normal.clone(),
        distance: travelled,
        material: hit.material || 'concrete',
        actor,
        collider: hit.collider ?? null,
        damage: this.damageAt(def, travelled) * damageScale,
        isHeadshot: false,
        penetrated: false,
      };

      if (actor) {
        seen.add(body);
        record.isHeadshot = this._classifyHeadshot(physics, hit, body, _dir);
        if (record.isHeadshot) record.damage *= def.headshotMul ?? 2;
      }

      out.hits.push(record);
      out.end.copy(hit.point);

      // Can the round keep going?
      const cost = actor ? 0.45 : (PENETRABLE[record.material] ?? Infinity);
      if (!Number.isFinite(cost) || cost > pierce) break;
      pierce -= cost;
      damageScale *= 0.62;
      record.penetrated = true;

      // Clear the whole body on an actor pass-through; a 3 cm nudge only for world
      // surfaces, where the next face genuinely is the far side of the material.
      const step = hit.distance + (actor ? ACTOR_DEPTH : 0.03);
      _origin.addScaledVector(_dir, step);
      advanced += step;
      remaining -= step;
    }

    if (out.hits.length === 0) {
      out.end.copy(origin).addScaledVector(_dir, def.range);
    }
    return out;
  }

  damageAt(def, distance) {
    const near = def.falloffNear ?? 30;
    const far = def.falloffFar ?? 90;
    const min = def.falloffMin ?? 0.5;
    if (distance <= near) return def.damage;
    if (distance >= far) return def.damage * min;
    const t = (distance - near) / Math.max(0.001, far - near);
    return def.damage * THREE.MathUtils.lerp(1, min, t);
  }

  /**
   * The identity a round de-dupes on.
   *
   * Actors are per-collider proxies (a bot registers a separate object for its
   * body capsule and for its head ball) but damage and hit events belong to the
   * *character*. Every proxy an actor system publishes must therefore agree on
   * one shared owner; `bot`, `owner` and `root` cover the shapes in the project,
   * and an actor that publishes none of them is its own owner.
   */
  _actorBody(actor) {
    if (!actor) return null;
    return actor.bot ?? actor.owner ?? actor.root ?? actor;
  }

  /**
   * Head/body classification for a single resolved actor impact.
   *
   * The head ball lives *inside* the body capsule, so "nearest collider" can never
   * be the head — a geometric test is the only correct answer. Two tiers:
   *
   *  1. Precise: re-cast the same ray from the entry point with a predicate that
   *     accepts only head colliders belonging to *this* body. It is restricted to
   *     the depth of one torso, so it cannot reach through a wall or pick up a
   *     second soldier, and `solid: true` means an entry point already inside the
   *     head volume reports at distance 0. One extra raycast per actor hit only.
   *  2. Fallback: the published `headY` / height test, for actors that do not
   *     register a dedicated head collider at all.
   */
  _classifyHeadshot(physics, hit, body, dir) {
    const hasDedicatedHead = !!(body && body.headActor && body.headActor.isHead === true)
      || hit.actor?.isHead === true;
    try {
      if (typeof physics.actorFor === 'function') {
        const G = physics.GROUPS ?? { PROJECTILE: 0x0010, ENEMY: 0x0004 };
        const headHit = physics.raycast(hit.point, dir, 0.8, {
          group: G.PROJECTILE ?? 0x0010,
          mask: G.ENEMY ?? 0x0004,
          solid: true,
          reuse: true,
          predicate: (c) => {
            const a = physics.actorFor(c);
            return !!a && a.isHead === true && this._actorBody(a) === body;
          },
        });
        if (headHit) return true;
        // A body that owns a head collider and did not intersect it was a body shot.
        if (hasDedicatedHead) return false;
      }
    } catch (err) { /* fall through to the geometric test */ }
    return this._isHeadshot(hit);
  }

  /**
   * Headshot test. Actors do not have to expose anything for this to work — if
   * they publish a head height or a hitbox we use it, otherwise we fall back to a
   * height above the actor's feet.
   */
  _isHeadshot(hit) {
    const a = hit.actor;
    if (!a) return false;
    try {
      if (a.isHead === true) return true;
      if (typeof a.headshotFor === 'function') return !!a.headshotFor(hit.point);
      if (typeof a.headY === 'number') return hit.point.y >= a.headY;
      const base = a.position?.y ?? a.root?.position?.y;
      if (typeof base === 'number') {
        const h = a.height ?? 1.78;
        return hit.point.y >= base + h - 0.26;
      }
    } catch (err) { /* not fatal */ }
    return false;
  }
}

export default Ballistics;
