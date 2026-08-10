/**
 * OPERATION BLACKOUT — AISystem.
 * OWNER: ai agent.  static id='ai', static order=30.
 *
 * Owns the enemy squad end to end: procedural bodies, procedural animation, a
 * rasterised navigation grid built from whatever geometry the level agent shipped,
 * perception, a cover-aware state machine, gunnery, ragdoll death and respawn.
 *
 * Everything expensive is budgeted per frame rather than per bot:
 *   · line-of-sight raycasts        (losBudget)
 *   · wall-probe raycasts           (wallBudget)
 *   · A* path solves                (2 per frame, queued)
 *   · cover evaluations             (1 per frame, queued)
 * so squad size scales without a frame-time cliff.
 *
 * Failure policy: every stage is wrapped. A broken nav grid degrades to direct
 * steering, a broken ragdoll degrades to a frozen corpse, a broken template
 * degrades to no bots at all — but the game always boots.
 */
import * as THREE from 'three';

import { buildTemplate } from './SoldierRig.js';
import { disposeSoldierTextures } from './textures.js';
import { NavGrid } from './NavGrid.js';
import { Bot, STATE } from './Bot.js';
import { Ragdoll } from './Ragdoll.js';
import { mulberry32, clamp01 } from './utils.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

export class AISystem {
  static id = 'ai';
  static order = 30;

  constructor(ctx) {
    this.ctx = ctx;
    this.bots = [];
    this.template = null;
    this.nav = null;
    this.enabled = true;
    this.time = 0;

    this._rngSeed = 0x5eed1;
    this.rng = mulberry32(this._rngSeed);

    this.losBudget = 0;
    this.wallBudget = 0;
    this._pathQueue = [];
    this._coverQueue = [];
    this._pendingHits = [];
    this._ragdolls = [];
    this.maxRagdolls = 4;

    this._spawnPoints = [];
    this._pendingSpawns = [];
    this._materialsRegistered = false;
    this._offHandlers = [];

    this.stats = { bots: 0, alive: 0, paths: 0, triangles: 0 };
  }

  makeRng(salt) { return mulberry32((this._rngSeed ^ (salt >>> 0)) >>> 0); }

  respawnDelay() { return 5 + this.rng() * 7; }

  /* ── init ─────────────────────────────────────────────────────────────── */

  async init(onProgress = () => {}) {
    const ctx = this.ctx;
    onProgress(0.05, 'ai: building soldiers');

    try {
      this.template = buildTemplate(ctx);
      this.stats.triangles = this.template.triangles;
      console.info(`[ai] soldier template: ${this.template.triangles} tris across ${Object.keys(this.template.geometries).length} materials`);
    } catch (err) {
      console.error('[ai] soldier template failed — no bots will spawn:', err);
      this.enabled = false;
      return;
    }

    onProgress(0.35, 'ai: navigation');
    try {
      this.nav = new NavGrid(ctx, { cell: 1.0 });
      const seed = ctx.player?.position ?? new THREE.Vector3();
      this.nav.build(seed);
    } catch (err) {
      console.warn('[ai] navigation build failed — bots will steer directly:', err);
      this.nav = null;
    }

    onProgress(0.7, 'ai: squad');
    this._collectSpawnPoints();

    const count = Math.max(0, Math.min(24, ctx.config?.gameplay?.botCount ?? 6));
    for (let i = 0; i < count; i++) {
      try {
        const bot = new Bot(this, i);
        this.bots.push(bot);
      } catch (err) {
        console.warn('[ai] bot construction failed:', err);
        break;
      }
    }
    this.stats.bots = this.bots.length;

    // Stagger the first wave so the map fills in rather than popping.
    this.bots.forEach((bot, i) => {
      const p = this._pickSpawn(i);
      if (p) bot.spawn(p);
      else bot.respawnTimer = 1 + i * 0.4;
    });

    this._wireEvents();
    onProgress(1, 'ai: ready');
  }

  _collectSpawnPoints() {
    const level = this.ctx.level;
    const list = [];
    const push = (v) => {
      if (!v) return;
      const p = v.isVector3 ? v : (Array.isArray(v) ? new THREE.Vector3(v[0], v[1], v[2])
        : (typeof v === 'object' && 'x' in v ? new THREE.Vector3(v.x, v.y, v.z) : null));
      if (p) list.push(p);
    };
    for (const key of ['botSpawns', 'enemySpawns', 'spawnPoints', 'spawns']) {
      const src = level?.[key];
      if (Array.isArray(src)) for (const v of src) push(v?.position ?? v);
    }
    this._spawnPoints = list;
  }

  /** A spawn point on walkable ground, well away from the player. */
  _pickSpawn(seq = 0) {
    const player = this.ctx.player?.position;
    const minDist = 16;
    const candidates = [];

    for (const p of this._spawnPoints) {
      if (!player || p.distanceTo(player) > minDist) candidates.push(p);
    }
    if (candidates.length) {
      const p = candidates[(seq + ((this.rng() * candidates.length) | 0)) % candidates.length];
      _a.copy(p);
      if (this.nav?.ready) {
        const c = this.nav.nearestWalkable(_a.x, _a.z, 6);
        if (c >= 0) return this.nav.cellCentre(c, new THREE.Vector3());
      }
      return _a.clone();
    }

    if (this.nav?.ready) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cell = this.nav.randomWalkable(this.rng, player, minDist - attempt * 4);
        if (cell >= 0) return this.nav.cellCentre(cell, new THREE.Vector3());
      }
    }

    // last resort: a ring around the origin
    const ang = this.rng() * Math.PI * 2;
    const r = 18 + this.rng() * 8;
    return new THREE.Vector3(Math.sin(ang) * r, 0, Math.cos(ang) * r);
  }

  _wireEvents() {
    const ev = this.ctx.events;
    if (!ev) return;

    // Gunfire is the loudest thing in the world; every bot in earshot reacts.
    this._offHandlers.push(ev.on('weapon:fire', (p) => {
      const origin = p?.origin ?? this.ctx.player?.eyePosition;
      if (!origin) return;
      for (const bot of this.bots) {
        if (!bot.alive) continue;
        const d = bot.pos.distanceTo(origin);
        if (d > 55) continue;
        // Muffled through geometry: a shot you cannot see is harder to place.
        bot.hearGunshot(origin, clamp01(1 - d / 55) * 0.9 + 0.1);
      }
    }));

    /**
     * Fallback path for a weapon system that reports hits by EVENT ONLY.
     *
     * The shipped one does both: it emits `hit:actor` and then calls
     * `actor.applyDamage(...)` on the very next line. Handling the event here as
     * well applied every round twice and halved the number of shots a soldier
     * could take. So this defers: it records the hit, and a deferred pass at the
     * top of the next update() applies it only if nobody called the actor
     * directly in the meantime.
     */
    this._offHandlers.push(ev.on('hit:actor', (p) => {
      const actor = p?.actor;
      const bot = actor?.bot ?? (actor?.isBot ? actor : null);
      if (!bot || !bot.alive || !(p.damage > 0)) return;
      actor.__directDamage = false;
      this._pendingHits.push({
        actor,
        bot,
        damage: p.damage,
        headshot: !!p.isHeadshot || !!actor.isHead,
        point: p.point ? p.point.clone() : null,
        from: (p.origin ?? this.ctx.player?.eyePosition)?.clone?.() ?? null,
      });
    }));
  }

  /* ── shared services the bots call ────────────────────────────────────── */

  /** Queue an A* solve. Returns true if the request was accepted. */
  requestPath(bot) {
    if (!this.nav?.ready) return false;
    if (this._pathQueue.includes(bot)) return true;
    if (this._pathQueue.length > 12) return false;
    this._pathQueue.push(bot);
    return true;
  }

  _servicePaths() {
    let solved = 0;
    while (this._pathQueue.length && solved < 2) {
      const bot = this._pathQueue.shift();
      if (!bot.alive || !bot.hasGoal) continue;
      solved++;
      try {
        const ok = this.nav.findPath(bot.pos, bot.goal, bot.path);
        bot.pathIndex = 0;
        bot.pathAge = 0;
        this.stats.paths++;
        if (!ok) {
          bot.path.length = 0;
          // Unreachable goal: stop asking for it.
          if (bot.state === STATE.PATROL || bot.state === STATE.SEEK_COVER) bot.hasGoal = false;
        }
      } catch (err) {
        console.warn('[ai] pathfind failed:', err);
        bot.path.length = 0;
        bot.hasGoal = false;
      }
    }
  }

  /**
   * A nearby cell that breaks the player's line of sight. Evaluated against the
   * real physics world, budgeted to one bot per frame so a whole squad calling
   * this at once cannot spike the frame.
   */
  findCover(bot) {
    const nav = this.nav;
    const player = this.ctx.player;
    if (!nav?.ready || !player) return null;
    if (this._coverThisFrame) return null;
    this._coverThisFrame = true;

    const eye = _a.copy(player.eyePosition ?? player.position).setY(
      (player.eyePosition ?? player.position).y + (player.eyePosition ? 0 : 1.6),
    );

    let best = null, bestScore = -Infinity;
    const radius = 11;
    for (let i = 0; i < 10; i++) {
      const ang = this.rng() * Math.PI * 2;
      const r = 2.5 + this.rng() * radius;
      const x = bot.pos.x + Math.sin(ang) * r;
      const z = bot.pos.z + Math.cos(ang) * r;
      const cell = nav.cellAt(x, z);
      if (!nav.isWalkable(cell)) continue;
      nav.cellCentre(cell, _b);

      // Standing chest height at the candidate.
      _c.set(_b.x, _b.y + 1.15, _b.z);
      const exposed = this.ctx.physics?.hasLineOfSight(eye, _c) ?? true;
      if (exposed) continue;

      // Prefer close, enclosed cells that still face roughly toward the threat.
      const distCost = _b.distanceTo(bot.pos);
      const score = nav.exposure[cell] * 1.5 - distCost * 0.6
        + (_b.distanceTo(player.position) > 8 ? 1.5 : -2);
      if (score > bestScore) { bestScore = score; best = _b.clone(); }
    }
    return best;
  }

  /** A cell with sight of the last known position from a materially different bearing. */
  findFlank(bot) {
    const nav = this.nav;
    if (!nav?.ready || !bot.hasLastKnown) return null;
    const target = bot.lastKnown;
    const baseAng = Math.atan2(bot.pos.x - target.x, bot.pos.z - target.z);
    const side = this.rng() < 0.5 ? 1 : -1;
    const dist = Math.max(7, Math.min(24, bot.pos.distanceTo(target)));
    for (let i = 0; i < 5; i++) {
      const ang = baseAng + side * (0.8 + i * 0.28);
      const x = target.x + Math.sin(ang) * dist;
      const z = target.z + Math.cos(ang) * dist;
      const cell = nav.nearestWalkable(x, z, 3);
      if (cell < 0) continue;
      nav.cellCentre(cell, _b);
      if (_b.distanceTo(bot.pos) < 4) continue;
      return _b.clone();
    }
    return null;
  }

  /**
   * Damage the player.
   *
   * INTEGRATION: `ctx.player.applyDamage()` is the authority — it decrements
   * health, kicks the rig and emits the canonical `player:damage` itself. The
   * previous version of this method emitted the event *instead* of calling
   * applyDamage whenever anything was subscribed, and audio + hud subscribe, so
   * the "somebody is listening" test always passed and the player's health
   * never moved: bots shot you forever and you never died. Call the system;
   * only fall back to a raw emit if the player system is missing entirely.
   */
  damagePlayer(amount, fromWorld) {
    const ctx = this.ctx;
    const from = _c.copy(fromWorld);
    const player = ctx.player;
    if (player && typeof player.applyDamage === 'function') {
      try {
        player.applyDamage(amount, from);
        return;
      } catch (err) {
        console.warn('[ai] player.applyDamage threw:', err);
      }
    }
    // No player system (or it threw) — at least let the HUD and audio react.
    try { ctx.events?.emit('player:damage', { amount, from: from.clone() }); } catch { /* noop */ }
  }

  acquireRagdoll(bot, opts) {
    // Hard cap: retire the oldest corpse before adding a new one.
    while (this._ragdolls.length >= this.maxRagdolls) {
      const old = this._ragdolls.shift();
      try { old.owner.rig.group.visible = false; } catch { /* noop */ }
      try { old.dispose(); } catch { /* noop */ }
      if (old.owner) old.owner.ragdoll = null;
    }
    const rd = new Ragdoll(this.ctx, bot.rig, opts);
    rd.owner = bot;
    if (rd.ok) this._ragdolls.push(rd);
    return rd;
  }

  requestRespawn(bot) {
    if (bot.alive) return;
    if (bot.ragdoll) {
      const i = this._ragdolls.indexOf(bot.ragdoll);
      if (i >= 0) this._ragdolls.splice(i, 1);
      try { bot.ragdoll.dispose(); } catch { /* noop */ }
      bot.ragdoll = null;
    }
    const p = this._pickSpawn(bot.index);
    if (!p) { bot.respawnTimer = 2; return; }
    try { bot.spawn(p); } catch (err) {
      console.warn('[ai] respawn failed:', err);
      bot.respawnTimer = 4;
    }
  }

  /* ── frame ────────────────────────────────────────────────────────────── */

  update(dt, elapsed) {
    if (!this.enabled) return;
    this.time = elapsed ?? (this.time + dt);

    // The lighting system comes up after us (order 70). Register our materials the
    // first frame it exists — an unregistered lit material takes the non-CSM branch
    // and receives all four cascades at full intensity, i.e. 4x overexposed.
    if (!this._materialsRegistered && this.ctx.lighting) {
      this._materialsRegistered = true;
      try {
        const mats = this.template?.materials;
        const scale = this.ctx.materials?.envIntensityScale ?? 1;
        for (const key of Object.keys(mats || {})) {
          const m = mats[key];
          if (this.ctx.lighting.registerMaterial) this.ctx.lighting.registerMaterial(m);
          else this.ctx.lighting.csm?.setupMaterial?.(m);
          // MaterialSystem.applyEnvMap() only walks its own cache, and ours are
          // built at order 30 — before the PMREM exists. Bind it ourselves, at the
          // same env weight the rest of the scene is using, or the squad sits a
          // stop out of key with everything around it.
          if (this.ctx.materials?.envMap) {
            m.envMap = this.ctx.materials.envMap;
            m.envMapIntensity = (m.userData.baseEnv ?? 1) * scale;
            m.needsUpdate = true;
          }
        }
      } catch (err) {
        console.warn('[ai] material registration failed:', err);
      }
    }

    // Deferred event-only damage — see the 'hit:actor' handler.
    if (this._pendingHits.length) {
      for (const h of this._pendingHits) {
        if (h.actor.__directDamage) { h.actor.__directDamage = false; continue; }
        try {
          h.bot.applyDamage(h.damage, {
            headshot: h.headshot,
            point: h.point,
            from: h.from,
            killer: this.ctx.player ?? null,
          });
        } catch (err) { console.warn('[ai] deferred hit failed:', err); }
      }
      this._pendingHits.length = 0;
    }

    // Per-frame budgets.
    this.losBudget = 14;
    this.wallBudget = 10;
    this._coverThisFrame = false;

    this._servicePaths();

    const cam = this.ctx.camera;
    let alive = 0;
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      let detail = 1;
      if (cam) {
        const d = bot.pos.distanceTo(cam.position);
        // Far background bots still walk and shoot, they just do not solve IK.
        if (d > 62) detail = 0;
        /**
         * Four cascades × three skinned meshes is the real cost of a soldier, so
         * shadow casting is a RAMP rather than one on/off cutoff:
         *
         *   < 30 m   all three buckets cast
         *   < 46 m   fabric + hard        (drop the load-bearing gear)
         *   < 55 m   fabric only          (body silhouette)
         *   ≥ 55 m   nothing casts
         *
         * Both middle bands are free quality, because a cast shadow only carries
         * the OUTLINE. The gear bucket is pouches, MOLLE ladders, straps and the
         * sling — 3.0k triangles of 2-centimetre relief that sits *inside* a
         * silhouette the body and plate already define, so through a cascade-2
         * penumbra several texels wide it changes no pixel of the shadow. Past
         * 46 m the helmet and boots are two screen pixels and the fabric bucket
         * (torso, limbs, skull) is the whole readable shape on its own.
         *
         * Measured at the warehouse pose, where three of seven bots sit in the
         * 44-47 m band: this removes ~24 shadow draw calls and ~130k triangles a
         * frame. That is what pays for the boot, webbing and helmet-cover
         * geometry this pass added (+2,524 tris per soldier, 8,160 -> 10,684).
         *
         * At a 9° sun a man throws a 12-metre shadow and that shadow is the ONLY
         * thing anchoring him to the ground at mid distance, so the OUTER cutoff
         * does not move — the ramp only thins what casts, never how far.
         */
        const lod = d < 30 ? 3 : d < 46 ? 2 : d < 55 ? 1 : 0;
        if (bot._shadowLod !== lod) {
          bot._shadowLod = lod;
          for (const m of bot.rig.meshes) {
            const b = m.userData.aiBucket;
            m.castShadow = lod === 3
              || (lod === 2 && b !== 'gear')
              || (lod === 1 && b === 'fabric');
          }
        }
      }
      try {
        bot.update(dt, detail);
      } catch (err) {
        if (!bot._updateError) {
          bot._updateError = true;
          console.error('[ai] bot update failed (suppressing further reports):', err);
        }
      }
      if (bot.alive) alive++;
    }
    this.stats.alive = alive;
  }

  /* ── teardown ─────────────────────────────────────────────────────────── */

  dispose() {
    for (const off of this._offHandlers) { try { off(); } catch { /* noop */ } }
    this._offHandlers.length = 0;
    for (const rd of this._ragdolls) { try { rd.dispose(); } catch { /* noop */ } }
    this._ragdolls.length = 0;
    for (const bot of this.bots) { try { bot.dispose(); } catch { /* noop */ } }
    this.bots.length = 0;
    try {
      for (const key of Object.keys(this.template?.geometries || {})) {
        this.template.geometries[key].dispose();
      }
      for (const key of Object.keys(this.template?.materials || {})) {
        this.template.materials[key].dispose();
      }
    } catch { /* noop */ }
    try { disposeSoldierTextures(); } catch { /* noop */ }
    this.template = null;
    this.nav = null;
  }
}

export default AISystem;
