/**
 * HUDSystem — the player-facing overlay.
 *
 * ── Why this is DOM and not Three ───────────────────────────────────────────
 * The render system composites ctx.scene and ctx.viewmodelScene only, and it
 * renders last, straight to the canvas. Anything added to a THREE.Scene for HUD
 * purposes would be either invisible or eaten by the post stack. So the entire
 * HUD is a DOM/CSS overlay sitting above the canvas at z-index 60 (below the
 * click-to-deploy affordance at 90 and the boot veil at 100).
 *
 * ── Design brief ────────────────────────────────────────────────────────────
 * Modern Warfare restraint. Mostly nothing. Condensed uppercase type at 70–85%
 * white with a hard dark shadow so it survives a bright sky and a black doorway
 * equally. No panels, no borders, no gradients on chrome, no rounded corners.
 * Health is never a bar — it is desaturation, a red edge, a heartbeat, and blood
 * arriving from the direction that hurt you.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 * Per frame this system reads ~15 numbers and writes at most a dozen style
 * properties, all of them `transform` / `opacity` / a quantised filter string.
 * No layout property is ever animated. Expensive layers (backdrop-filter) are
 * display:none whenever they would be a no-op.
 *
 * OWNER: hud (src/ui/**). Do not edit from other systems — call ctx.hud.* or
 * emit the canonical events in src/core/EventBus.js.
 */

import { injectStyles } from './styles.js';
import { el, text, clamp, damp, setStyle } from './dom.js';
import { Reticle } from './reticle.js';
import { DamageFX } from './damage.js';
import { AmmoReadout } from './ammo.js';
import { KillFeed, Scoreboard } from './killfeed.js';
import { Optic } from './optic.js';

const DEG = Math.PI / 180;

const BOT_CALLSIGNS = [
  'VULTURE', 'HALVARD', 'REAPER-2', 'KESTREL', 'BOAR', 'SANDMAN',
  'IRONSIDE', 'MAGPIE', 'CRUCIBLE', 'DELTA-9', 'ROOK', 'ASHFORD',
];

export class HUDSystem {
  static id = 'hud';
  static order = 80;

  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this._offs = [];
    this._names = new WeakMap();
    this._nameIdx = 0;

    // Player-facing scoreline the scoreboard reads.
    this.stats = { kills: 0, deaths: 0, assists: 0, ping: 24 };

    // Smoothed / derived state
    this._ads = 0;
    this._spread = 0.012;
    this._bloom = 0;
    this._dead = false;
    this._health01 = 1;
    this._lastHitAt = -1e9;
    this._lastHitActor = null;
    this._lastHitHead = false;
    this._lastWeaponName = '';
    this._demo = false;
    this._demoT = 0;
    this._tabDown = false;

    // Last-known-good weapon descriptor. Kept so a momentarily-null `current`
    // (mid weapon swap) does not blank the counter for a frame.
    this._fallbackWeapon = { name: 'M4A1', ammo: 30, magSize: 30, reserve: 180, rpm: 780 };
    this._roster = [];
    this._rosterT = 0;

    // Scratch vectors — allocated once, never per frame.
    const T = ctx.THREE;
    this._fwd = new T.Vector3();
    this._right = new T.Vector3();
    this._delta = new T.Vector3();
  }

  // ────────────────────────────────────────────────────────────────── init

  async init(onProgress = () => {}) {
    try {
      onProgress(0.1, 'hud');
      injectStyles(document);

      const root = el('div', null, document.body);
      root.id = 'hud-root';
      this.root = root;

      // Order matters: full-screen effects paint under the readouts.
      this.damage = new DamageFX(root);
      this.optic = new Optic(root);
      this.reticle = new Reticle(root);
      this.ammo = new AmmoReadout(root);
      this.killfeed = new KillFeed(root);
      this.scoreboard = new Scoreboard(root);

      const obj = el('div', 'objective', root);
      text('div', 'hi', 'OBJ · Secure the yard', obj);
      text('div', null, 'Sector 07 · 18:42 local', obj);

      this.kia = text('div', 'kia', 'You were killed in action', root);

      onProgress(0.55, 'hud');
      this._wireEvents();
      this._wireKeys();

      // Prime the readouts so the first rendered frame is already correct rather
      // than showing a placeholder for one frame.
      this._syncWeapon(0.016);
      this.reticle.resize(window.innerWidth, window.innerHeight);

      this._demo = /(?:^|[?&])hud=demo(?:&|$)/.test(location.search);
      if (this._demo) this._seedDemo();

      // Small authoring hook so the screenshot harness can exercise transient
      // states. No effect unless something calls it.
      window.__HUD_DEMO__ = (what) => { try { this._demoTrigger(what); } catch (e) { console.warn('[hud] demo', e); } };

      onProgress(1, 'hud');
    } catch (err) {
      // A broken HUD must never black out the game for the other ten systems.
      console.error('[hud] init failed, continuing without overlay:', err);
      this._broken = true;
    }
  }

  // ──────────────────────────────────────────────────────────────── events

  _wireEvents() {
    const ev = this.ctx.events;
    const on = (name, fn) => this._offs.push(ev.on(name, fn));

    on('weapon:fire', (p) => {
      this.reticle.kick(0.55);
      this.ammo.fireTick();
      // The fire event carries the cone that was actually used — the most
      // authoritative spread reading available, so seed the estimator with it.
      if (p && typeof p.spread === 'number' && isFinite(p.spread)) {
        this._firedSpread = p.spread > 0.35 ? p.spread * DEG : p.spread;
        this._firedAt = performance.now();
      }
      this._bloom = Math.min(0.026, this._bloom + 0.0042);
    });

    on('weapon:empty', () => this.ammo.emptyTick());

    on('weapon:switch', (p) => {
      const w = this.ctx.weapons?.current;
      const name = (p && p.to) || w?.name || 'WEAPON';
      const sub = w?.caliber || (w?.slot === 2 ? 'Secondary' : 'Primary');
      this.ammo.showSwitch(name, sub);
    });

    on('weapon:reload', () => { this._bloom = 0; });

    on('hit:actor', (p) => {
      if (!p) return;
      if (p.actor && p.actor === this.ctx.player) return; // we were hit, not them
      this._lastHitAt = performance.now();
      this._lastHitActor = p.actor ?? null;
      this._lastHitHead = !!p.isHeadshot;
      this.reticle.hitmarker(p.isHeadshot ? 'head' : 'hit');
    });

    on('actor:death', (p) => {
      if (!p) return;
      const actor = p.actor ?? null;
      const player = this.ctx.player;

      if (actor && actor === player) { this._onPlayerDeath(p.killer); return; }

      const now = performance.now();
      const byPlayer = p.killer === player
        || p.killer?.isPlayer === true
        || (now - this._lastHitAt < 500 && (!this._lastHitActor || this._lastHitActor === actor));

      if (byPlayer) {
        this.stats.kills++;
        this.reticle.hitmarker('kill');
      }
      this.killfeed.push(
        byPlayer ? 'You' : this._actorName(p.killer),
        this._actorName(actor),
        {
          byPlayer,
          headshot: byPlayer && this._lastHitHead && (now - this._lastHitAt < 500),
          weapon: this.ctx.weapons?.current?.name ?? '',
        },
      );
      this._rosterT = 0; // force a scoreboard refresh
    });

    on('player:damage', (p) => {
      if (!p) return;
      const src = p.from ?? p.fromPosition ?? p.position ?? null;
      const sev = clamp((p.amount ?? 12) / 42, 0.15, 1);
      const ang = this._screenAngleTo(src);
      if (ang === null) {
        // Sourceless damage (fall, explosion, scripted): a symmetric flash, never
        // an arc — pointing at nothing would be worse than pointing at nowhere.
        this.damage.hit(0, sev * 0.8, true);
      } else {
        this.damage.hit(ang, sev);
        this.reticle.damageArc(ang, sev);
      }
    });

    on('player:death', () => this._onPlayerDeath(null));
  }

  _wireKeys() {
    this._onKeyDown = (e) => {
      if (e.code === 'Tab') { this._tabDown = true; e.preventDefault(); }
    };
    this._onKeyUp = (e) => {
      if (e.code === 'Tab') { this._tabDown = false; e.preventDefault(); }
    };
    this._onBlur = () => { this._tabDown = false; };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  _onPlayerDeath(killer) {
    if (this._dead) return;
    this._dead = true;
    this.stats.deaths++;
    this.damage.slam();
    setStyle(this.kia, 'opacity', '1');
    this.root?.classList.add('dead');
    // Only feed a line when we know who did it — "UNKNOWN killed YOU" is noise
    // sitting next to a banner that already says you are dead.
    if (killer) {
      this.killfeed.push(this._actorName(killer), 'You', { againstPlayer: true, weapon: '' });
    }
  }

  /** Stable, human callsign for an actor object. */
  _actorName(actor) {
    if (!actor) return 'Unknown';
    if (actor === this.ctx.player || actor.isPlayer) return 'You';
    if (typeof actor === 'string') return actor;
    if (actor.callsign) return actor.callsign;
    // The AI system names its actors BOT_1..BOT_n, which is correct for it and
    // wrong for a kill feed. Map those to callsigns; keep any authored name.
    if (actor.name && !/^bot[\s_-]*\d+$/i.test(actor.name)) return actor.name;
    let n = this._names.get(actor);
    if (!n) {
      n = BOT_CALLSIGNS[this._nameIdx % BOT_CALLSIGNS.length];
      if (this._nameIdx >= BOT_CALLSIGNS.length) n += '-' + (1 + ((this._nameIdx / BOT_CALLSIGNS.length) | 0));
      this._nameIdx++;
      this._names.set(actor, n);
    }
    return n;
  }

  /**
   * Screen-space bearing to a world point: 0 = dead ahead, +ve = to the right,
   * ±π = behind. Yaw only — vertical offset is not useful on a damage arc.
   * Returns null when there is no usable source position.
   */
  _screenAngleTo(src) {
    if (!src || typeof src.x !== 'number' || !isFinite(src.x)) return null;
    const cam = this.ctx.camera;
    const eye = this.ctx.player?.eyePosition ?? cam.position;
    cam.getWorldDirection(this._fwd);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-8) return null;
    this._fwd.normalize();
    // right = forward × up, for a right-handed Y-up basis.
    this._right.set(-this._fwd.z, 0, this._fwd.x);
    this._delta.set(src.x - eye.x, 0, src.z - eye.z);
    if (this._delta.lengthSq() < 1e-6) return null;
    return Math.atan2(this._delta.dot(this._right), this._delta.dot(this._fwd));
  }

  // ──────────────────────────────────────────────────────────── per frame

  update(dt, elapsed) {
    if (this._broken || !this.root) return;
    const d = Math.min(dt || 0.016, 0.1);

    try {
      const ctx = this.ctx;
      const player = ctx.player;

      // ── health ────────────────────────────────────────────────────────────
      const maxHp = player?.maxHealth || ctx.config?.gameplay?.playerHealth || 100;
      const hp = typeof player?.health === 'number' ? player.health : maxHp;
      this._health01 = clamp(hp / (maxHp || 100), 0, 1);
      // The player system owns life state; the event is only the notification.
      // Reading isDead directly means a respawn clears the HUD even if the death
      // event was missed (e.g. the HUD initialised mid-round).
      if (typeof player?.isDead === 'boolean') {
        if (player.isDead && !this._dead) this._onPlayerDeath(null);
        else if (!player.isDead && this._dead) {
          this._dead = false;
          setStyle(this.kia, 'opacity', '0');
          this.root?.classList.remove('dead');
        }
      } else if (this._dead && hp > 0.5) {
        this._dead = false;
        setStyle(this.kia, 'opacity', '0');
        this.root?.classList.remove('dead');
      }
      this.damage.update(this._health01, this._dead, d);

      // ── aim ───────────────────────────────────────────────────────────────
      const adsRaw = this._readAds();
      this._ads = damp(this._ads, adsRaw, 15, d);
      const hasOptic = this._hasOptic();
      const breath = clamp(1 - this._health01, 0, 1);
      this.optic.update(this._ads, hasOptic, d, breath);

      // ── reticle ───────────────────────────────────────────────────────────
      this._bloom = Math.max(0, this._bloom - d * 0.055);
      this._spread = this._readSpread(d);
      const fov = ctx.camera?.fov || ctx.config?.camera?.fov || 78;
      // Behind a red dot the crosshair is redundant and would fight the reticle,
      // so it is gone by the time the optic is up. Irons/no-optic keep it.
      let hide = hasOptic ? clamp((this._ads - 0.35) / 0.45, 0, 1) : 0;
      // Dead or reading the scoreboard: the reticle is noise, not information.
      if (this._dead || this._tabDown) hide = 1;
      this._hide = damp(this._hide ?? hide, hide, 22, d);
      this.reticle.update(this._spread, fov, this._hide, d);

      // ── ammunition ────────────────────────────────────────────────────────
      this._syncWeapon(d);

      // ── feeds ─────────────────────────────────────────────────────────────
      this.killfeed.update();

      // ── scoreboard ────────────────────────────────────────────────────────
      this.scoreboard.setOpen(this._tabDown);
      if (this._tabDown) {
        this._rosterT -= d;
        if (this._rosterT <= 0) {
          this._rosterT = 0.5;
          this.scoreboard.render(this._buildRoster());
        }
      }

      if (this._demo) this._demoTick(d, elapsed);
    } catch (err) {
      // One bad frame must not kill the loop; report once, then stay quiet.
      if (!this._loggedUpdateError) {
        this._loggedUpdateError = true;
        console.error('[hud] update error (suppressed after first):', err);
      }
    }
  }

  _syncWeapon(dt) {
    const w = this.ctx.weapons;
    const cur = (w && w.current) ? w.current : this._fallbackWeapon;
    if (cur !== this._fallbackWeapon) this._fallbackWeapon = cur;

    if (this._demo && this._demoWeapon) {
      this.ammo.update(this._demoWeapon, this._demoReloading);
      return;
    }

    const name = String(cur.name ?? 'WEAPON');
    if (name !== this._lastWeaponName) {
      // A weapon that appeared without a 'weapon:switch' event still gets its
      // moment — otherwise the first spawn silently swaps the readout.
      if (this._lastWeaponName) this.ammo.showSwitch(name, cur.caliber || 'Primary');
      this._lastWeaponName = name;
    }
    this.ammo.update(cur, !!(w && w.isReloading));
    void dt;
  }

  /** 0..1 aim-down-sight progress from whichever system actually publishes it. */
  _readAds() {
    const w = this.ctx.weapons, p = this.ctx.player;
    // Player first: it owns the aim transition (`adsT`) and drives the camera FOV,
    // so its value is the one the frame was actually rendered with.
    for (const src of [p, w]) {
      if (!src) continue;
      // player.adsT and weapons.adsFactor are the two published names; the rest
      // are defensive aliases in case either system renames.
      for (const k of ['adsT', 'adsFactor', 'adsProgress', 'adsAmount', 'ads']) {
        const v = src[k];
        if (typeof v === 'number' && isFinite(v)) return clamp(v, 0, 1);
      }
    }
    if (p && typeof p.isADS === 'boolean') return p.isADS ? 1 : 0;
    if (w && typeof w.isADS === 'boolean') return w.isADS ? 1 : 0;
    return 0;
  }

  _hasOptic() {
    const c = this.ctx.weapons?.current;
    if (!c) return true;
    if (typeof c.optic !== 'undefined') return !!c.optic;
    if (typeof c.sight !== 'undefined') return !!c.sight;
    if (typeof c.hasOptic !== 'undefined') return !!c.hasOptic;
    return true;
  }

  /**
   * Weapon cone half-angle in radians.
   *
   * Prefers a live number off the weapon system. Values above 0.35 are assumed
   * to be degrees (0.35 rad = 20° would be an absurd cone for any firearm), so
   * a weapon system that reports in either unit lands in the right place.
   * Falls back to a local estimator driven by stance, motion and fire rate so
   * the reticle is alive even before the weapon system publishes anything.
   */
  _readSpread(dt) {
    const w = this.ctx.weapons;
    let v = null;

    if (w) {
      // `spreadRadians` is the name the weapon system publishes for exactly this
      // purpose; the rest are defensive aliases.
      for (const k of ['spreadRadians', 'spread', 'currentSpread', 'spreadRad', 'coneRad', 'spreadAngle']) {
        const n = w[k];
        // Exactly zero means "not published yet" (a real firearm never has a
        // zero cone), so fall through to the estimator rather than pinning the
        // reticle shut for the frames before the weapon system is live.
        if (typeof n === 'number' && isFinite(n) && n > 1e-6) { v = n; break; }
      }
      if (v === null && typeof w.getSpread === 'function') {
        try { const g = w.getSpread(); if (typeof g === 'number' && isFinite(g)) v = g; } catch { /* ignore */ }
      }
      if (v === null && w.current) {
        for (const k of ['spread', 'currentSpread', 'coneRad']) {
          const n = w.current[k];
          // Exactly zero means "not published yet" (a real firearm never has a
        // zero cone), so fall through to the estimator rather than pinning the
        // reticle shut for the frames before the weapon system is live.
        if (typeof n === 'number' && isFinite(n) && n > 1e-6) { v = n; break; }
        }
      }
    }

    if (v !== null) {
      const rad = v > 0.35 ? v * DEG : v;
      return damp(this._spread, rad, 24, dt);
    }

    // Local estimator.
    const p = this.ctx.player;
    let base = 0.0105;
    if (p) {
      if (p.isADS) base *= 0.24;
      else if (p.isCrouching) base *= 0.66;
      if (p.isSprinting) base *= 1.85;
      if (p.isGrounded === false) base *= 2.3;
      const vel = p.velocity;
      if (vel && typeof vel.x === 'number') {
        const speed = Math.hypot(vel.x, vel.z || 0);
        base += Math.min(speed, 7) * (p.isADS ? 0.0009 : 0.0024);
      }
    }
    let est = base + this._bloom;

    // If the weapon told us its real cone on the last shot, trust that as the
    // floor for a short while — it is measured, ours is guessed.
    if (this._firedSpread && performance.now() - this._firedAt < 900) {
      est = Math.max(est, this._firedSpread * 0.9);
    }
    return damp(this._spread, est, 20, dt);
  }

  _buildRoster() {
    const ai = this.ctx.ai;
    const list = (ai && (ai.bots || ai.actors || ai.agents)) || null;
    const out = [];
    if (Array.isArray(list) && list.length) {
      for (const b of list) {
        if (!b || b.isPlayer) continue;
        out.push({
          name: this._actorName(b),
          kills: (b.kills | 0) || 0,
          deaths: (b.deaths | 0) || 0,
          ping: (b.ping | 0) || 20 + ((this._hashName(this._actorName(b)) % 44)),
        });
      }
    }
    if (!out.length) {
      if (!this._fallbackRoster) this._fallbackRoster = Scoreboard.fallbackRoster(11);
      for (const r of this._fallbackRoster) out.push({ ...r });
    }
    out.push({ name: 'You', kills: this.stats.kills, deaths: this.stats.deaths, ping: this.stats.ping, you: true });
    out.sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
    return out;
  }

  _hashName(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0);
  }

  // ─────────────────────────────────────────────────── public API for others

  /** Other systems may call ctx.hud.* instead of emitting, if they prefer. */
  hitmarker(kind) { try { this.reticle?.hitmarker(kind); } catch { /* ignore */ } }
  addKill(killer, victim, opts) { try { this.killfeed?.push(killer, victim, opts || {}); } catch { /* ignore */ } }
  showWeapon(name, sub) { try { this.ammo?.showSwitch(name, sub); } catch { /* ignore */ } }

  // ───────────────────────────────────────────────────────────── demo mode

  _seedDemo() {
    this._demoWeapon = { name: 'M4A1', ammo: 7, magSize: 30, reserve: 124, rpm: 780, mode: 'AUTO' };
    this._demoReloading = false;
    this.killfeed.push('You', 'Vulture', { byPlayer: true, headshot: true, weapon: 'M4A1' });
    this.killfeed.push('Halvard', 'Kestrel', { weapon: 'AK-74' });
    this.killfeed.push('You', 'Boar', { byPlayer: true, weapon: 'M4A1' });
    this.stats.kills = 9;
    this.stats.deaths = 4;
  }

  _demoTick(dt, elapsed) {
    this._demoT -= dt;
    if (this._demoT > 0) return;
    this._demoT = 0.42;
    this._demoPhase = ((this._demoPhase | 0) + 1) % 8;
    const phase = this._demoPhase;
    this.reticle.hitmarker(phase % 3 === 0 ? 'hit' : phase % 3 === 1 ? 'head' : 'kill');
    if (phase === 2 || phase === 6) {
      const ang = phase === 2 ? -0.95 : 2.1;
      this.reticle.damageArc(ang, 0.8);
      this.damage.hit(ang, 0.8);
    }
    if (phase === 0) {
      // Keep the feed populated: entries expire after 5.2s by design.
      const roll = (this._demoKill = (this._demoKill | 0) + 1) % 3;
      if (roll === 0) this.killfeed.push('You', 'Vulture', { byPlayer: true, headshot: true, weapon: 'M4A1' });
      else if (roll === 1) this.killfeed.push('Halvard', 'Kestrel', { weapon: 'AK-74' });
      else this.killfeed.push('Boar', 'You', { againstPlayer: true, weapon: 'RPK' });
    }
    void elapsed;
  }

  _demoTrigger(what) {
    switch (what) {
      case 'hit': this.reticle.hitmarker('hit'); break;
      case 'head': this.reticle.hitmarker('head'); break;
      case 'kill': this.reticle.hitmarker('kill'); break;
      case 'damage': {
        const a = -1.1;
        this.reticle.damageArc(a, 0.9); this.damage.hit(a, 0.9);
        break;
      }
      case 'board': this._tabDown = !this._tabDown; break;
      case 'switch': this.ammo.showSwitch('MK18', 'Primary · 5.56×45'); break;
      default: break;
    }
  }

  // ─────────────────────────────────────────────────────────────── lifecycle

  resize(w, h) {
    try { this.reticle?.resize(w, h); } catch { /* ignore */ }
  }

  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    try { this.root?.remove(); } catch { /* ignore */ }
    try { document.getElementById('hud-style')?.remove(); } catch { /* ignore */ }
    this.root = null;
  }
}

export default HUDSystem;
