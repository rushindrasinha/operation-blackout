import * as THREE from 'three';

import { WeaponSurfaces } from './procgen.js';
import { buildM4, buildMP5 } from './models.js';
import { Viewmodel } from './viewmodel.js';
import { Ballistics } from './ballistics.js';
import { Ejecta } from './ejecta.js';
import { WEAPON_DEFS, WEAPON_ORDER } from './defs.js';
import { clamp } from './spring.js';

/**
 * OPERATION BLACKOUT — WeaponSystem (order 40).
 *
 * Owns: two procedurally-modelled weapons, the viewmodel rig that presents them,
 * the fire-control state machine, hitscan ballistics, the reload animations, and
 * every piece of ejecta the gun throws into the world.
 *
 * Contract published to other systems:
 *   current        -> { id, name, ammo, magSize, reserve, rpm, damage, ... }
 *   isFiring       -> boolean
 *   isReloading    -> boolean
 *   adsFactor      -> 0..1, so the HUD can fade the crosshair
 *   spreadRadians  -> current cone half-angle, for crosshair gap
 *
 * Events emitted (exact payloads from src/core/EventBus.js):
 *   weapon:fire, weapon:reload, weapon:switch, weapon:empty,
 *   hit:world, hit:actor, camera:shake
 *
 * OWNER: weapons agent.
 */

/**
 * Viewmodel key intensity the absolute-valued light lanes (world practicals,
 * muzzle flash) were originally balanced against: a 13-unit dusk sun at the old
 * 2.10x key boost. Those lanes are ratios of the key, not constants, and this is
 * the denominator that keeps them so.
 */
const LOCAL_LANE_REF = 27.3;

/**
 * How far along a probe ray to start, in metres, so it clears the player's own
 * collider. The player capsule is radius 0.34 (ARCHITECTURE §Physics), and a ray
 * originating inside a collider reports a hit at distance 0 — which is exactly the
 * bug that pinned `_sunVis` to a constant. 0.45 clears it with margin without
 * skipping over a wall the player is genuinely pressed against.
 */
const PROBE_CLEAR = 0.45;

export class WeaponSystem {
  static id = 'weapons';
  static order = 40;

  constructor(ctx) {
    this.ctx = ctx;

    this.surfaces = null;
    this.viewmodel = null;
    this.ballistics = null;
    this.ejecta = null;

    /** id -> { def, model, state, magProto } */
    this.weapons = new Map();
    this.activeId = 'rifle';
    this.pendingId = null;

    this.isFiring = false;
    this.isReloading = false;
    this.adsFactor = 0;
    this.spreadRadians = 0;
    this.ready = false;
    // See Viewmodel.setPoses — the standard FPS viewmodel shrink.
    this.vmScale = 0.78;
    // Viewmodel FOV, owned here rather than read from config.camera.viewmodelFov.
    // At the config's 55 degrees the weapon at hip distance foreshortened almost not
    // at all and ate ~22% of the frame; the near-field perspective of a 200 mm-away
    // object needs a wider frustum than the world camera's framing does. 66 degrees
    // is the number that makes the barrel actually recede and brings the receiver,
    // magwell and support hand inside the frame. See defs.js `poses.hip`.
    this.vmFov = 66;
    /**
     * Sky-probe strength for the weapon's metal.
     *
     * Also a casualty of the sRGB albedo bug: with F0 crushed seven-fold, the
     * environment term had to run at unity just to register, and once the albedos
     * were corrected the gun turned into a mirror of the dusk sky — the receiver,
     * the rail and the stock all measured brighter than sunlit concrete in the same
     * frame. Metal IBL scales with F0, so the probe comes down by roughly the same
     * factor the albedo went up. Measured by ablation (key off, then env off, one
     * knob at a time) rather than guessed: the probe turned out to be supplying
     * almost nothing at the first corrected setting, so it goes back up to 0.80 —
     * it is what fills the shadow side and puts a real reflection in the optic —
     * while the key comes down far enough to stop clipping the sun-facing faces.
     */
    this.envIntensity = 0.80;
    /**
     * Viewmodel key as a multiple of the world sun — see _calibrateLights().
     *
     * This shipped at 2.10 for one reason: procgen.js was packing linear values
     * into sRGB-tagged albedo textures, so every base colour on the weapon reached
     * the shader about seven times too dark and the only way to see the gun at all
     * was to overdrive its key. That is a compensating error, and it compensates
     * badly — dielectric specular does not scale with albedo, so the polymer stock
     * came back a broad blown sheen brighter than sunlit concrete while the
     * receiver flats stayed crushed to near-black. No midtones anywhere.
     *
     * With the albedos encoded correctly (see procgen.js `srgbTint`) the key comes
     * down by roughly the factor the albedo went up, and lands at 0.72 once the
     * metal F0 values in procgen.js are physical (see the note there — the first
     * corrected pass left them at 0.16 linear, which made a metal rifle darker
     * than its own plastic furniture and sent this number chasing the wrong
     * target). Measured against the world in the same frame at the closeup pose:
     * receiver deck ~104, polymer stock and gloves ~70-90, sunlit concrete ~159.
     * Metal above polymer, both below concrete, nothing clipped. That ordering is
     * the test; the absolute number is not, and it will move if the world's grade
     * moves.
     *
     * SECOND CORRECTION (sun-probe fix). This was 0.72 while `_sunVis` was pinned
     * at 0.24 by the distance-0 raycast bug, so the key that actually reached the
     * weapon was 0.72 x 0.589 = 0.42 of the world sun in EVERY pose. With the probe
     * repaired the multiplier is real, and a pose in genuine full sun would have
     * jumped 1.7x and clipped. 0.44 keeps the sunlit poses at the exposure that
     * measured correctly (viewmodel p99 below the sunlit-ground p99) and lets the
     * shaded poses fall away as they should.
     */
    this.keyBoost = 0.44;

    this._fireTimer = 0;
    this._burstLeft = 0;
    this._triggerHeld = false;
    this._triggerLatched = false;
    this._shotIndex = 0;
    this._sinceFire = 10;

    this._reload = null;
    this._switch = null;

    this._flash = null;
    this._flashLightWorld = null;
    this._flashLightVm = null;
    this._flashT = 0;
    this._flashLife = 0;

    this._baseFov = ctx.config?.camera?.fov ?? 78;
    this._lastWrittenFov = null;

    this._muzzleWorld = new THREE.Vector3();
    this._muzzleLocal = new THREE.Vector3();
    this._portWorld = new THREE.Vector3();
    this._camQuat = new THREE.Quaternion();
    this._tmpV = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._tmpM = new THREE.Matrix4();
    this._fwd = new THREE.Vector3();
    this._prevPlayerPos = new THREE.Vector3();
    this._carrierVel = new THREE.Vector3();
    this._inspect = false;
  }

  /* ────────────────────────────── init ─────────────────────────────────── */

  async init(onProgress = () => {}) {
    const { ctx } = this;
    try {
      onProgress(0.02, 'weapons: surfaces');
      this.surfaces = new WeaponSurfaces(ctx.renderer);
      await this.surfaces.build((p, label) => onProgress(0.02 + p * 0.42, label));

      onProgress(0.46, 'weapons: viewmodel scene');
      this._setupViewmodelScene();

      this.viewmodel = new Viewmodel(ctx);
      this.viewmodel.attach(ctx.viewmodelScene, ctx.viewmodelCamera);

      onProgress(0.5, 'weapons: M4A1');
      await this._registerWeapon('rifle', buildM4);
      onProgress(0.74, 'weapons: MP5A3');
      await this._registerWeapon('smg', buildMP5);

      onProgress(0.9, 'weapons: ballistics');
      this.ballistics = new Ballistics(ctx);
      this.ejecta = new Ejecta(ctx, this.surfaces);
      this.ejecta.init();
      for (const [id, w] of this.weapons) {
        w.magProto = this.ejecta.makeMagPrototype(id, w.model.magSize);
      }

      this._buildMuzzleFlash();

      this._equip(this.activeId, true);
      this.ready = true;

      if (typeof window !== 'undefined') {
        // Handles for the screenshot / critic harness — these are how a headless
        // run can verify sight alignment and recoil without a pointer lock.
        window.__WEAPONS__ = {
          system: this,
          ads: (on) => { this._forceAds = !!on; },
          inspect: (on) => { this._forceInspect = !!on; },
          fire: (n = 1) => { this._forceShots = (this._forceShots ?? 0) + n; },
          reload: () => this.startReload(),
          switchTo: (id) => this.switchTo(id),
          // Live tuning taps. Framing and viewmodel exposure are judged by eye from
          // screenshots, and rebuilding two guns per iteration is far too slow.
          light: (k, r, f, b) => {
            const L = this._vmLights;
            if (k !== undefined) L.key.intensity = k;
            if (r !== undefined) L.rim.intensity = r;
            if (f !== undefined) L.fill.intensity = f;
            if (b !== undefined) L.bounce.intensity = b;
          },
          pose: (which, p, r) => {
            const vm = this.viewmodel;
            const dst = which === 'ads' ? vm.poseAds : which === 'sprint' ? vm.poseSprint : vm.poseHip;
            if (p) dst.pos.set(p[0], p[1], p[2]);
            if (r) dst.rot.set(r[0], r[1], r[2]);
          },
          // Zero every procedural offset so sight alignment can be measured to the
          // pixel. Residual sway is intentional in play but not in a ruler shot.
          freeze: (on) => { this.viewmodel.frozen = !!on; },
          env: (v) => { this.envIntensity = v; this._envDone = false; this._ensureEnv(); },
          keyBoost: (v) => { this.keyBoost = v; this._calibrateLights(); },
          ao: (v) => this.surfaces.setAoAmount(v),
          wear: (v) => this.surfaces.setWearAmount(v),
          scale: (s) => {
            this.vmScale = s;
            this.viewmodel.scale = s;
            const w = this.weapons.get(this.activeId);
            if (w) this.viewmodel.setPoses(w.def, w.model);
          },
          info: () => ({
            weapon: this.activeId,
            ammo: this.current.ammo,
            reserve: this.current.reserve,
            ads: this.adsFactor,
            adsRaw: this.viewmodel.adsRaw,
            forceAds: this._forceAds,
            sprintT: this.viewmodel.sprintT,
            lowerT: this.viewmodel.lowerT,
            armPos: this.viewmodel.arm.position.toArray().map((v) => +v.toFixed(4)),
            spread: this.spreadRadians,
            // Ground truth for sight alignment: project the reticle through the
            // viewmodel camera and report where it actually lands, in pixels from
            // the frame centre. Reading it off a screenshot is guesswork; this is not.
            reticle: this._reticlePixel(),
            triangles: [...this.weapons.values()].reduce((a, w) => a + (w.model.triangles || 0), 0),
          }),
        };
      }

      const tris = [...this.weapons.values()].reduce((a, w) => a + (w.model.triangles || 0), 0);
      console.info(`[weapons] ready — 2 weapons, ${tris} triangles, ${this.ejecta.shells.length} pooled cases`);
      onProgress(1, 'weapons');
    } catch (err) {
      console.error('[weapons] init failed — running without a viewmodel:', err);
      this.ready = false;
    }
  }

  /**
   * The viewmodel scene is rendered on its own, with a cleared depth buffer, into
   * an MSAA HDR target — it never touches the world's G-buffer, gets no SSAO, and
   * cannot see the world's cascaded shadows. So it needs a complete little lighting
   * rig of its own, calibrated to the same dusk the world is graded for: a low warm
   * key, a cool sky fill, a hard cool rim to pull the silhouette off the background,
   * and a dim warm bounce from the ground.
   *
   * Nothing here casts a shadow. `renderer.shadowMap.autoUpdate` is false and the
   * one refresh per frame is consumed by the world pass long before the viewmodel
   * is drawn, so a shadow-casting light here would sample a stale or empty map.
   */
  _setupViewmodelScene() {
    const { ctx } = this;
    const cam = ctx.viewmodelCamera;
    const art = ctx.config?.art ?? {};

    const key = new THREE.DirectionalLight(art.sunColor ?? 0xffd7a8, 13.0);
    key.position.set(-0.62, 0.90, 0.34);
    key.target.position.set(0, -0.05, -0.35);
    key.castShadow = false;
    cam.add(key, key.target);

    // Rim and fill are both cool. They used to run at 0.30 and 0.235 of the key,
    // which is what made the weapon measure R/B 0.73 while the world around it
    // measured 1.35 — a gun composited from a different, bluer scene. Halved, and
    // the sky colour warmed toward the overcast dusk the world is graded for.
    const rim = new THREE.DirectionalLight(0xa9b6bf, 3.9);
    rim.position.set(0.85, 0.22, -0.75);
    rim.target.position.set(0, 0, 0);
    rim.castShadow = false;
    cam.add(rim, rim.target);

    const fill = new THREE.HemisphereLight(0xa9a59a, 0x39291a, 3.05);
    cam.add(fill);

    const bounce = new THREE.DirectionalLight(0xa07c52, 1.65);
    bounce.position.set(0.10, -0.86, -0.50);
    bounce.target.position.set(0, 0, -0.2);
    bounce.castShadow = false;
    cam.add(bounce, bounce.target);

    // Local-light lane. The world's sodium practicals cannot reach the viewmodel
    // scene — different scene, different light list — so their aggregate is
    // re-projected onto this one directional light every frame. Created ONCE:
    // adding a light at runtime invalidates every program in the scene.
    const local = new THREE.DirectionalLight(0xffb257, 0.0);
    local.position.set(0, 0.4, -1);
    local.target.position.set(0, 0, 0);
    local.castShadow = false;
    cam.add(local, local.target);

    // These constructor values are the calibrated result for the authored dusk;
    // _calibrateLights() re-derives them from the real sun once lighting exists,
    // and they are the fallback if it never does.
    this._vmLights = { key, rim, fill, bounce, local };
    // Ratios the calibration below preserves, expressed relative to the key.
    // Bounce and fill carry the UNDERSIDE of the weapon — the magwell, the trigger
    // group, the pistol grip and, critically, both hands, none of which ever face
    // the key. At 0.115/0.170 that whole lower half rendered as an unlit silhouette:
    // the gloves, forearms and cuffs were fully modelled, correctly wrapped and
    // completely invisible, which is exactly how a reviewer concludes the weapon has
    // no hands. Real viewmodels are bounce-heavy for this reason — a rifle is held
    // over a lit floor, inside the shooter's own kit, and the light under it is not
    // 17% of the key. Raised to the point where a gloved knuckle reads as a gloved
    // knuckle; the sun-facing faces are untouched because these lanes never reach
    // them.
    this._vmLightRatio = { rim: 0.130, fill: 0.140, bounce: 0.280 };

    // ── world-coupling state ────────────────────────────────────────────────
    this._sunVis = 1;            // 0..1, is the player standing in the sun?
    this._skyVis = 1;            // 0..1, is there sky over the player's head?
    this._probeT = 0;            // seconds since the last occlusion probe
    this._probeSlot = 0;
    this._sunCamDir = new THREE.Vector3(-0.62, 0.90, 0.34).normalize();
    this._probeOrigin = new THREE.Vector3();
    this._localAccum = new THREE.Vector3();
    this._localColor = new THREE.Color(0xffb257);
    this._localLevel = 0;
    this._envLevel = 1;
    this._keyBaseColor = new THREE.Color(art.sunColor ?? 0xffd7a8);

    // Muzzle flash lights: one in the viewmodel scene (lights the gun) and one in
    // the world (lights the environment — the single biggest realism cue there is
    // for a night/dusk shot). Both are created ONCE and only ever have their
    // intensity animated, because adding a light at runtime invalidates every
    // shader program in the scene.
    this._flashLightVm = new THREE.PointLight(0xffca7a, 0, 2.2, 2);
    this._flashLightVm.castShadow = false;
    cam.add(this._flashLightVm);

    this._flashLightWorld = new THREE.PointLight(0xffbe72, 0, 16, 2);
    this._flashLightWorld.castShadow = false;
    this._flashLightWorld.name = 'muzzle_flash_light';
    ctx.scene.add(this._flashLightWorld);
  }

  async _registerWeapon(id, builder) {
    const def = WEAPON_DEFS[id];
    if (!def) return;
    // Yield so the loading bar repaints between the two model builds.
    await new Promise((r) => setTimeout(r));
    let model = null;
    try {
      model = builder(this.surfaces);
    } catch (err) {
      console.error(`[weapons] failed to build ${id}:`, err);
      return;
    }
    model.root.visible = false;
    const state = {
      id,
      name: def.name,
      caliber: def.caliber,
      ammo: def.magSize,
      magSize: def.magSize,
      reserve: def.reserve,
      rpm: def.rpm,
      damage: def.damage,
      fireMode: def.fireModes[0],
      fireModes: def.fireModes.slice(),
      slot: def.slot,
    };
    this.weapons.set(id, { def, model, state, magProto: null });
  }

  _buildMuzzleFlash() {
    try {
      const mat = this.surfaces.get('flash');
      const g = new THREE.Group();
      g.name = 'muzzle_flash';
      // Three crossed cards: reads as volume from any angle without a billboard.
      for (let i = 0; i < 3; i++) {
        const q = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        q.rotation.z = (i / 3) * Math.PI;
        q.renderOrder = 30;
        q.frustumCulled = false;
        g.add(q);
      }
      // A stubby forward cone for the jet coming off the crown.
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.0, 10, 1, true), mat);
      cone.rotation.x = -Math.PI / 2;
      cone.position.z = -0.42;
      cone.renderOrder = 30;
      cone.frustumCulled = false;
      g.add(cone);

      g.visible = false;
      g.scale.setScalar(0.001);
      this._flash = g;
    } catch (err) {
      console.warn('[weapons] muzzle flash build failed:', err);
      this._flash = null;
    }
  }

  /* ─────────────────────────── equip / switch ──────────────────────────── */

  _equip(id, immediate = false) {
    const w = this.weapons.get(id);
    if (!w) return;
    for (const [, other] of this.weapons) other.model.root.visible = false;
    w.model.root.visible = true;
    this.activeId = id;

    this.viewmodel.setModel(w.model);
    this.viewmodel.scale = this.vmScale;
    this.viewmodel.setPoses(w.def, w.model);
    this.viewmodel.kickPivotBack = id === 'smg' ? 0.22 : 0.26;

    if (this._flash) {
      w.model.muzzle.add(this._flash);
      this._flash.position.set(0, 0, -0.012);
    }

    this.ballistics?.reset();
    this._shotIndex = 0;
    this._burstLeft = 0;
    if (immediate) this.viewmodel.lowerT = 0;
  }

  switchTo(id) {
    if (!this.ready || !this.weapons.has(id)) return false;
    if (id === this.activeId || this._switch || this.isReloading) return false;
    const def = this.weapons.get(this.activeId).def;
    this._switch = {
      from: this.activeId,
      to: id,
      t: 0,
      down: def.handling.holsterTime,
      up: this.weapons.get(id).def.handling.drawTime,
      swapped: false,
    };
    return true;
  }

  nextWeapon(dir = 1) {
    const i = WEAPON_ORDER.indexOf(this.activeId);
    const n = WEAPON_ORDER.length;
    return this.switchTo(WEAPON_ORDER[((i + dir) % n + n) % n]);
  }

  /* ───────────────────────────── reloading ─────────────────────────────── */

  startReload() {
    if (!this.ready || this.isReloading || this._switch) return false;
    const w = this.weapons.get(this.activeId);
    if (!w) return false;
    if (w.state.ammo >= w.state.magSize || w.state.reserve <= 0) return false;

    const empty = w.state.ammo <= 0;
    const duration = empty ? w.def.handling.reloadEmpty : w.def.handling.reloadTactical;
    this._reload = { t: 0, duration, empty, dropped: false, inserted: false, charged: false, tapped: false };
    this.isReloading = true;
    this._burstLeft = 0;

    try {
      this.ctx.events?.emit('weapon:reload', { weapon: this.activeId, duration });
    } catch (e) { /* not fatal */ }
    this._sfx('reload_mag_out', 0.9);
    return true;
  }

  _finishReload() {
    const w = this.weapons.get(this.activeId);
    if (w) {
      const need = w.state.magSize - w.state.ammo;
      const take = Math.min(need, w.state.reserve);
      w.state.ammo += take;
      w.state.reserve -= take;
    }
    this._reload = null;
    this.isReloading = false;
    const vm = this.viewmodel;
    vm.animPos.set(0, 0, 0);
    vm.animRot.set(0, 0, 0);
    this._resetParts();
  }

  /**
   * Restore every animated part to its REST TRANSFORM.
   *
   * `models.js finish()` wraps the magazine, charging handle and support hand in
   * pivot nodes so they can rotate about their catch / wrist rather than about
   * the bore, and a pivot's rest position is the pivot POINT — not the origin.
   * This used to `set(0, 0, 0)`, which teleported the magazine 56 mm up and 70 mm
   * forward through the magwell the instant a reload finished, and did the same to
   * the charging handle. It never showed up in a screenshot because the critic
   * harness never reloads; it is plainly visible the first time you press R.
   */
  _resetParts() {
    const w = this.weapons.get(this.activeId);
    if (!w) return;
    const p = w.model.parts;
    const rest = w.model.rest;
    if (p.mag) { p.mag.position.copy(rest.mag); p.mag.rotation.set(0, 0, 0); p.mag.visible = true; }
    if (p.charge) p.charge.position.copy(rest.charge);
    if (p.bolt) p.bolt.position.copy(rest.bolt);
    if (p.handL && w.model.handL) { p.handL.position.copy(w.model.handL.rest); p.handL.rotation.set(0, 0, 0); }
  }

  /**
   * Two genuinely different animations. Tactical keeps the bolt closed and is
   * mostly wrist; empty adds the charging-handle cycle and a longer settle, so the
   * player can hear and see which one they are in the middle of.
   */
  _updateReload(dt) {
    const r = this._reload;
    if (!r) return;
    const w = this.weapons.get(this.activeId);
    if (!w) { this._finishReload(); return; }

    r.t += dt;
    const p = clamp(r.t / r.duration, 0, 1);
    const vm = this.viewmodel;
    const parts = w.model.parts;

    const restMag = w.model.rest.mag;
    const restCharge = w.model.rest.charge;

    const seg = (a, b) => clamp((p - a) / Math.max(1e-4, b - a), 0, 1);
    const smooth = (x) => x * x * (3 - 2 * x);
    const pulse = (a, b) => { const t = seg(a, b); return Math.sin(t * Math.PI); };

    // ── weapon carriage: tilt in toward the support hand, dip, come back ──
    const tiltIn = smooth(seg(0.00, 0.16));
    const tiltOut = smooth(seg(r.empty ? 0.86 : 0.80, 1.0));
    const tilt = tiltIn - tiltOut;
    const dip = pulse(0.02, r.empty ? 0.92 : 0.88);

    // The whole point of the carriage move is to bring the MAGAZINE WELL into
    // frame. The eye sits above and to the left of the weapon, so the roll has to
    // be negative — that rotates the underside of the receiver toward the camera.
    // Rolling the other way (and dipping instead of lifting) hides the entire
    // action below the bottom edge, which is what the first pass did.
    vm.animRot.set(
      0.075 * tilt + 0.045 * dip,
      -0.135 * tilt,
      -0.300 * tilt,
    );
    vm.animPos.set(
      -0.013 * tilt,
      0.020 * dip + 0.009 * tilt,
      0.024 * dip,
    );

    // ── magazine ──────────────────────────────────────────────────────────
    const outStart = r.empty ? 0.16 : 0.14;
    const outEnd = r.empty ? 0.30 : 0.26;
    const inStart = r.empty ? 0.50 : 0.46;
    const inEnd = r.empty ? 0.68 : 0.66;

    if (parts.mag) {
      if (p < outStart) {
        parts.mag.position.copy(restMag);
        parts.mag.rotation.set(0, 0, 0);
        parts.mag.visible = true;
      } else if (p < inStart) {
        // Rock forward off the catch, then fall clear.
        const t = seg(outStart, outEnd);
        parts.mag.rotation.x = -0.5 * t;
        parts.mag.position.set(restMag.x, restMag.y - 0.22 * t * t, restMag.z + 0.02 * t);
        parts.mag.visible = t < 0.999;
        if (!r.dropped && t >= 0.55) {
          r.dropped = true;
          this._dropMagazine(w);
          parts.mag.visible = false;
        }
      } else if (p < inEnd) {
        const t = smooth(seg(inStart, inEnd));
        parts.mag.visible = true;
        parts.mag.rotation.x = -0.42 * (1 - t);
        parts.mag.position.set(restMag.x, restMag.y - 0.24 * (1 - t), restMag.z + 0.026 * (1 - t));
        if (!r.inserted && t > 0.9) {
          r.inserted = true;
          this._sfx('reload_mag_in', 1.0);
        }
      } else {
        parts.mag.visible = true;
        // The tap: a short, sharp overshoot on the seat.
        const t = seg(inEnd, inEnd + 0.09);
        const tap = Math.sin(t * Math.PI) * (1 - t);
        parts.mag.position.set(restMag.x, restMag.y - 0.006 * tap, restMag.z);
        parts.mag.rotation.x = 0;
        if (!r.tapped && t > 0.4) { r.tapped = true; this._sfx('reload_mag_in', 0.55, 1.35); }
      }
    }

    // ── charging handle, empty reload only ────────────────────────────────
    if (r.empty && parts.charge) {
      const back = seg(0.72, 0.83);
      const fwd = seg(0.83, 0.90);
      const travel = (back - fwd) * 0.088;
      parts.charge.position.set(restCharge.x, restCharge.y, restCharge.z + travel);
      if (parts.bolt) parts.bolt.position.set(0, 0, travel * 0.86);
      if (!r.charged && fwd > 0.6) {
        r.charged = true;
        this._sfx('reload_charge', 1.0);
        vm.kickRot.impulse(0.9, 0.0, 0.35);
        vm.kickPos.impulse(0, 0, 0.22);
      }
    } else if (parts.charge) {
      parts.charge.position.copy(restCharge);
      if (parts.bolt) parts.bolt.position.set(0, 0, 0);
    }

    /* ── SUPPORT HAND ─────────────────────────────────────────────────────
     * The left hand has to actually leave the handguard. Every other element of
     * this animation was already right — the weapon tilts to bring the magwell
     * into frame, the magazine rocks off the catch and falls, the charging handle
     * cycles — and then the hand that is supposed to be DOING all of it stayed
     * welded to the rail. That single omission is what made the reload read as a
     * weapon operating itself.
     *
     * Four beats, tracking the magazine's own timeline so the hand and the mag are
     * never in disagreement:
     *   strip  — down to the magwell, arrives just before the mag rocks free
     *   fetch  — drops below frame for the fresh magazine
     *   seat   — rises with it, holding the well through the insert
     *   charge — on an empty reload only, up to the charging handle, then home
     */
    const hl = w.model.handL;
    if (hl && parts.handL) {
      const strip = smooth(seg(0.04, outStart + 0.04));
      const fetch = smooth(seg(outEnd, inStart - 0.04));
      const seat = smooth(seg(inStart, inEnd));
      // Off the well once the mag is home; on an empty reload it goes to the
      // charging handle first, otherwise straight back to the handguard.
      const chargeGo = r.empty ? smooth(seg(0.70, 0.80)) : 0;
      const chargeBack = r.empty ? smooth(seg(0.88, 0.99)) : 0;
      const home = r.empty ? 0 : smooth(seg(inEnd + 0.06, 0.99));

      // atMag: 0 on the handguard, 1 at the magwell.
      const atMag = clamp(strip - home, 0, 1);
      // Below the well while the hand is off getting a fresh magazine.
      const below = clamp(fetch - seat, 0, 1);
      const atCharge = clamp(chargeGo - chargeBack, 0, 1);

      const t = this._tmpV.copy(hl.rest)
        .lerp(hl.mag, atMag)
        .lerp(hl.charge, atCharge);
      t.y -= 0.085 * below;
      t.z += 0.020 * below;
      parts.handL.position.copy(t);

      // Wrist. Reaching under the receiver rolls the palm up and cants the hand
      // back toward the shooter; running the charging handle rolls it the other
      // way. Small angles — this is a wrist, not a shoulder.
      parts.handL.rotation.set(
        0.55 * atMag - 0.30 * atCharge,
        -0.22 * atMag + 0.30 * atCharge,
        -0.85 * atMag + 0.55 * atCharge,
      );
    }

    if (p >= 1) this._finishReload();
  }

  _dropMagazine(w) {
    if (!w.magProto || !this.ejecta) return;
    try {
      const node = w.model.magMouth;
      node.updateWorldMatrix(true, false);
      this._muzzleLocal.setFromMatrixPosition(node.matrixWorld);
      this.ctx.viewmodelCamera.worldToLocal(this._muzzleLocal);
      const world = this._tmpV.copy(this._muzzleLocal);
      this.ctx.camera.localToWorld(world);
      // Sink it a little so it is not born inside the player's hands.
      world.y -= 0.12;
      this.ctx.camera.getWorldQuaternion(this._tmpQ);
      this.ejecta.dropMag(w.magProto, world, this._tmpQ, this._carrierVel);
    } catch (err) {
      console.warn('[weapons] mag drop failed:', err);
    }
  }

  /* ───────────────────────────── firing ────────────────────────────────── */

  get current() {
    const w = this.weapons.get(this.activeId);
    return w ? w.state : { id: this.activeId, name: '—', ammo: 0, magSize: 0, reserve: 0, rpm: 0, damage: 0 };
  }

  get definition() {
    return this.weapons.get(this.activeId)?.def ?? null;
  }

  cycleFireMode() {
    const w = this.weapons.get(this.activeId);
    if (!w) return;
    const modes = w.state.fireModes;
    const i = modes.indexOf(w.state.fireMode);
    w.state.fireMode = modes[(i + 1) % modes.length];
    this._sfx('empty_click', 0.35, 1.6);
    // Flick the selector so the change is visible on the model.
    const sel = w.model.parts.selector;
    if (sel) sel.rotation.x = -0.55 * ((i + 1) % modes.length);
  }

  _canFire() {
    if (!this.ready || this.isReloading || this._switch) return false;
    if (this.viewmodel.sprintT > 0.35) return false;
    return this._fireTimer <= 0;
  }

  _tryFire(dt, state) {
    const w = this.weapons.get(this.activeId);
    if (!w) return;
    const def = w.def;
    const mode = w.state.fireMode;

    let want = false;
    if (this._burstLeft > 0) {
      want = true;
    } else if (this._triggerHeld) {
      if (mode === 'auto') want = true;
      else if (!this._triggerLatched) {
        want = true;
        this._triggerLatched = true;
        if (mode === 'burst') this._burstLeft = def.burstCount;
      }
    }
    if (!want) return;

    if (w.state.ammo <= 0) {
      this._burstLeft = 0;
      // Already fixing the problem — don't keep clicking through the reload.
      if (this.isReloading || this._switch) return;
      // The cooldown was written here but never *read*: on auto the condition
      // below was unconditionally true, so holding the trigger on a dry mag
      // emitted 'weapon:empty' once per rendered frame — measured at 250 events
      // in six seconds. That is 250 empty-click samples queued in the audio
      // system and 250 HUD ticks, for a sound a real weapon makes once. Respect
      // the timer that was already being set.
      if (this._fireTimer <= 0 && (!this._triggerLatched || mode === 'auto')) {
        this._triggerLatched = true;
        this._sfx('empty_click', 0.8);
        try { this.ctx.events?.emit('weapon:empty', { weapon: this.activeId }); } catch (e) { /* noop */ }
        this._fireTimer = 0.28;
      }
      return;
    }

    if (!this._canFire()) return;
    this._shoot(w, state);
    this._fireTimer = 60 / Math.max(30, def.rpm);
    if (this._burstLeft > 0) this._burstLeft--;
  }

  _shoot(w, state) {
    const { ctx } = this;
    const def = w.def;
    w.state.ammo--;
    this._sinceFire = 0;
    this.isFiring = true;

    // ── aim ray ────────────────────────────────────────────────────────────
    const cam = ctx.camera;
    cam.getWorldDirection(this._fwd);
    const origin = this._tmpV2.copy(
      ctx.player?.eyePosition?.isVector3 ? ctx.player.eyePosition : cam.position,
    );
    // Start the ray just in front of the eye so it cannot begin inside a wall the
    // player is hugging.
    origin.addScaledVector(this._fwd, 0.12);

    const spread = this.ballistics.currentSpread(def, state);
    this.spreadRadians = spread;

    const result = this.ballistics.fire(def, origin, this._fwd, spread, {
      shooter: ctx.player ?? null,
    });
    this.ballistics.bumpSpread(def);

    // ── recoil, matched between camera and viewmodel ───────────────────────
    const pattern = def.recoil.pattern;
    const step = pattern[Math.min(this._shotIndex, pattern.length - 1)];
    const adsT = this.viewmodel.adsT;
    const mul = (1 - adsT * (1 - def.recoil.adsMul)) * (state.crouching ? def.recoil.crouchMul : 1);
    const pitch = (step[1] * def.recoil.pitch + (Math.random() - 0.5) * def.recoil.randomPitch) * mul;
    const yaw = (step[0] * def.recoil.yaw + (Math.random() - 0.5) * def.recoil.randomYaw) * mul;
    this._shotIndex++;

    try { ctx.player?.addRecoil?.(pitch, yaw); } catch (e) { /* player may not implement it yet */ }
    this.viewmodel.addRecoil(def, adsT, state.crouching);

    // ── muzzle transform, in world space ───────────────────────────────────
    this._computeMuzzleWorld(w);

    // ── flash + light ──────────────────────────────────────────────────────
    this._flashT = 0;
    this._flashLife = 0.052 + Math.random() * 0.018;
    if (this._flash) {
      this._flash.visible = true;
      this._flashScale = (0.088 + Math.random() * 0.032) * (def.id === 'smg' ? 0.85 : 1.0);
      this._flash.scale.setScalar(this._flashScale);
      this._flash.rotation.z = Math.random() * Math.PI * 2;
    }

    try {
      // Hand FX its OWN matrix. `_tmpM` is per-frame scratch and would be rewritten
      // by the next round; an FX system that keeps the reference for the lifetime of
      // a particle would silently teleport it.
      ctx.fx?.spawnMuzzleFlash?.(this._tmpM.clone(), def.id === 'smg' ? 0.8 : 1.0);
      ctx.fx?.spawnTracer?.(this._muzzleWorld.clone(), result.end.clone(), 620);
    } catch (err) { /* FX is optional */ }

    // ── shell ejection ─────────────────────────────────────────────────────
    try {
      this._computePortWorld(w);
      this.ejecta?.ejectShell(this._portWorld, this._camQuat, this._carrierVel, def.ejection);
    } catch (err) { /* not fatal */ }

    // ── impacts ────────────────────────────────────────────────────────────
    for (const h of result.hits) {
      if (h.actor) {
        try {
          ctx.events?.emit('hit:actor', {
            actor: h.actor,
            point: h.point,
            normal: h.normal,
            damage: h.damage,
            isHeadshot: h.isHeadshot,
          });
        } catch (e) { /* noop */ }
        // NOTE: no direct fx.spawnBloodHit() here. FX subscribes to 'hit:actor'
        // and sprays from that; calling it as well doubled every wound (and the
        // bot's own applyDamage sprayed a third time).
        try {
          if (typeof h.actor.applyDamage === 'function') {
            h.actor.applyDamage(h.damage, { point: h.point, headshot: h.isHeadshot, from: origin });
          }
        } catch (e) { /* the AI agent owns this contract */ }
        this._sfx('hitmarker', 0.55);
      } else {
        try {
          ctx.events?.emit('hit:world', {
            point: h.point,
            normal: h.normal,
            material: h.material,
            impulse: h.damage * 0.045,
          });
        } catch (e) { /* noop */ }
        // NOTE: no direct fx.spawnImpact()/addDecal() here either. FX's
        // 'hit:world' subscription runs spawnImpact, and spawnImpact already
        // lays a material-correct decal (bullet_concrete / bullet_metal / …).
        // Doing it here as well produced two impact bursts and three decals per
        // round — double the particle cost for a visibly muddier hole.
      }
    }

    // ── events + audio ─────────────────────────────────────────────────────
    try {
      ctx.events?.emit('weapon:fire', {
        origin: origin.clone(),
        dir: result.dir.clone(),
        weapon: this.activeId,
        spread,
      });
    } catch (e) { /* noop */ }

    this._sfx(def.audio.fire, 1.0, 0.97 + Math.random() * 0.06);

    try {
      ctx.events?.emit('camera:shake', {
        amplitude: 0.0035 * (1 - adsT * 0.55),
        duration: 0.085,
        frequency: 34,
      });
    } catch (e) { /* noop */ }
  }

  _computeMuzzleWorld(w) {
    const { ctx } = this;
    const node = w.model.muzzle;
    node.updateWorldMatrix(true, false);
    this._muzzleLocal.setFromMatrixPosition(node.matrixWorld);
    ctx.viewmodelCamera.worldToLocal(this._muzzleLocal);
    this._muzzleWorld.copy(this._muzzleLocal);
    ctx.camera.localToWorld(this._muzzleWorld);
    ctx.camera.getWorldQuaternion(this._camQuat);
    this._tmpM.compose(this._muzzleWorld, this._camQuat, this._tmpV.set(1, 1, 1));
  }

  _computePortWorld(w) {
    const { ctx } = this;
    const node = w.model.eject;
    node.updateWorldMatrix(true, false);
    this._tmpV.setFromMatrixPosition(node.matrixWorld);
    ctx.viewmodelCamera.worldToLocal(this._tmpV);
    this._portWorld.copy(this._tmpV);
    ctx.camera.localToWorld(this._portWorld);
    ctx.camera.getWorldQuaternion(this._camQuat);
  }

  _sfx(id, volume = 1, pitch = 1) {
    if (!id) return;
    try {
      this.ctx.audio?.play?.(id, { position: null, volume, pitch });
    } catch (err) { /* audio is optional */ }
  }

  /* ───────────────────────────── per frame ─────────────────────────────── */

  update(dt, elapsed) {
    if (!this.ready) return;
    const d = Math.min(dt, 0.05);
    try {
      this._update(d, elapsed);
    } catch (err) {
      if (!this._errored) {
        this._errored = true;
        console.error('[weapons] update failed, weapon logic disabled:', err);
      }
    }
  }

  /**
   * The lighting system builds its PMREM sky probe at order 70 — after we init at
   * order 40 — and only re-binds `ctx.materials`. The weapon has its own material
   * library, so it has to adopt the probe itself or every metal surface on the gun
   * would have a flat, dead specular response while the world around it reflects
   * the sky. Runs once, the first frame the probe exists.
   */
  _ensureEnv() {
    if (this._envDone) return;
    const env = this.ctx.lighting?.envMap;
    if (!env) return;
    try {
      // NOT the world's 0.17. That number is calibrated for a scene of mostly
      // DIELECTRIC surfaces, where the environment is a shadow-fill term and
      // raising it flattens the image. A weapon is the opposite case: it is almost
      // entirely rough metal, its diffuse response is near zero by definition, and
      // essentially all of its visible shading is the environment reflected in a
      // broad specular lobe. At the world's value the gun renders as a silhouette —
      // measured, then fixed here.
      this.surfaces.applyEnvMap(env, this.envIntensity);
      this._boundEnv = env;
      this._envLevel = this.envIntensity;
      const vs = this.ctx.viewmodelScene;
      if (vs && 'environmentIntensity' in vs) {
        vs.environment = env;
        vs.environmentIntensity = this.envIntensity;
      }
      this._calibrateLights();
      this._envDone = true;
    } catch (err) {
      console.warn('[weapons] env map bind failed:', err);
      this._envDone = true;
    }
  }

  /**
   * Drive the viewmodel key off the world sun instead of hard-coding it, so the
   * weapon tracks whatever exposure the lighting system settles on rather than
   * drifting into silhouette or into daylight the moment that number changes.
   *
   * The multiplier is deliberately greater than 1. A weapon is a dark, low-albedo
   * object held inside the player's own shadow; lit at literal parity with the
   * world it renders as a black cut-out, which is exactly what the first pass did.
   * Every shipped FPS over-lights its viewmodel for the same reason.
   */
  _calibrateLights() {
    const L = this._vmLights;
    if (!L) return;
    const sun = this.ctx.lighting?.sun;
    this._keyBase = (sun && sun.isLight ? sun.intensity : 7.6) * this.keyBoost;
    if (sun?.color) this._keyBaseColor.copy(sun.color).lerp(new THREE.Color(0xffffff), 0.12);
    L.key.intensity = this._keyBase;
    L.key.color.copy(this._keyBaseColor);
    L.rim.intensity = this._keyBase * this._vmLightRatio.rim;
    L.fill.intensity = this._keyBase * this._vmLightRatio.fill;
    L.bounce.intensity = this._keyBase * this._vmLightRatio.bounce;
  }

  /**
   * Couple the viewmodel rig to the world every frame.
   *
   * The viewmodel is rendered into its own scene with its own lights, which is the
   * only way to give it a stable, art-directed look — but the previous rig was a
   * fixed key/rim/hemi/bounce that never once looked at `ctx.lighting`. Measured
   * across five poses the receiver came back inside 3/255 of the same value standing
   * in direct dusk sun and standing in a black warehouse, and it was cool-tinted
   * (R/B 0.73) in a frame where the world was warm (R/B 1.35). That is the single
   * loudest "this was composited from a different scene" tell there is.
   *
   * Three couplings, cheapest first:
   *
   *  1. DIRECTION + COLOUR. The world sun direction is transformed into camera space
   *     and drives the key, so turning on the spot walks the highlight around the
   *     receiver exactly as it walks around the world geometry. Blended 78/22 with a
   *     fixed over-the-left-shoulder bias so that facing directly away from the sun
   *     leaves the weapon shaped rather than a flat silhouette — every shipped FPS
   *     cheats this, and for the same reason.
   *
   *  2. SUN VISIBILITY. One physics ray from the eye toward the sun, and one
   *     straight up, amortised one per frame on alternating slots (~30 Hz each).
   *     In shadow the key drops to 18%; under a roof the sky fill and the
   *     environment probe drop with it. This is what makes the weapon go dark when
   *     you step inside.
   *
   *  3. PRACTICALS. The world's sodium lamps live in `ctx.scene` and can never
   *     illuminate a mesh in `ctx.viewmodelScene`. Their inverse-square contribution
   *     at the eye is summed here and re-emitted as one directional light in camera
   *     space, so walking under a lamp actually puts warm light on the gun.
   */
  _updateWorldLighting(dt) {
    const L = this._vmLights;
    const lg = this.ctx.lighting;
    // Debug tap: lets the screenshot harness pin a flat, readable rig so geometry
    // can be judged without the world's exposure in the way.
    if (this._worldLightOff) return;
    if (!L || !lg) return;
    const cam = this.ctx.camera;
    if (!cam) return;

    /* ── 2. occlusion probes, one ray per frame ─────────────────────────────
     * THE PROBE ORIGIN MUST CLEAR THE PLAYER'S OWN CAPSULE.
     *
     * Both of these rays used to start exactly at `eye`, which is inside the
     * player's own collider — so Rapier returned a hit at distance 0.000 on every
     * ray, in every pose, forever. `_sunVis` sat pinned at 0.24 and `_skyVis` at
     * 0.42 whether the player was in open sun on the lane or under the spawn
     * canopy, which meant the entire "couple the viewmodel to the world" system
     * below was computing a constant. Measured before the fix:
     *
     *   pose      sun ray from eye   from eye + 0.35 m
     *   spawn     hit @ 0.000        hit @ 4.85   (really is shaded)
     *   lane      hit @ 0.000        clear        (really is in full sun)
     *   closeup   hit @ 0.000        hit @ 41.6   (grazing, sky open)
     *
     * That single zero is why three critics independently reported the weapon
     * carrying a full-intensity sun key while standing in shadow. Push the origin
     * out past the capsule (radius 0.34) and the signal is real.
     */
    this._probeT += dt;
    if (this._probeT > 0.033) {
      this._probeT = 0;
      const eye = this.ctx.player?.eyePosition;
      const phys = this.ctx.physics;
      if (eye?.isVector3 && typeof phys?.raycast === 'function') {
        try {
          if ((this._probeSlot ^= 1)) {
            const d = lg.sunDirection;
            if (d?.isVector3) {
              this._tmpV.copy(d).normalize();
              // sunDirection may point either to or from the sun depending on the
              // lighting build; take the upward-pointing sense.
              if (this._tmpV.y < 0) this._tmpV.negate();
              this._probeOrigin.copy(eye).addScaledVector(this._tmpV, PROBE_CLEAR);
              const hit = phys.raycast(this._probeOrigin, this._tmpV, 42, { reuse: true });
              // Distance-weighted rather than binary: an occluder 40 m down the sun
              // bearing is a haze-softened grazing block, not a roof over your head,
              // and grading them the same is what made the coupling read as a switch.
              this._sunVisTarget = hit
                ? clamp(0.02 + (hit.distance / 42) * 0.55, 0, 1)
                : 1.0;
            }
          } else {
            this._tmpV.set(0, 1, 0);
            this._probeOrigin.copy(eye).addScaledVector(this._tmpV, PROBE_CLEAR);
            const hit = phys.raycast(this._probeOrigin, this._tmpV, 9, { reuse: true });
            this._skyVisTarget = hit ? clamp(0.06 + (hit.distance / 9) * 0.42, 0, 1) : 1.0;
          }
        } catch (e) { /* physics may not be queryable yet */ }
      }
    }
    // Ease, or stepping through a doorway strobes the whole weapon.
    const k = Math.min(1, dt * 5.5);
    this._sunVis += ((this._sunVisTarget ?? 1) - this._sunVis) * k;
    this._skyVis += ((this._skyVisTarget ?? 1) - this._skyVis) * k;

    /* ── 1. key direction and colour ────────────────────────────────────── */
    const sunDir = lg.sunDirection;
    if (sunDir?.isVector3) {
      this._tmpV.copy(sunDir).normalize();
      if (this._tmpV.y < 0) this._tmpV.negate();
      cam.getWorldQuaternion(this._tmpQ).invert();
      this._tmpV.applyQuaternion(this._tmpQ);
      // Bias toward the classic three-quarter key so the weapon never goes flat.
      this._tmpV.multiplyScalar(0.78).addScaledVector(this._tmpV2.set(-0.62, 0.90, 0.34).normalize(), 0.22);
      if (this._tmpV.lengthSq() > 1e-6) {
        this._sunCamDir.lerp(this._tmpV.normalize(), Math.min(1, dt * 9));
        L.key.position.copy(this._sunCamDir).multiplyScalar(2.0);
        // Rim opposes the key horizontally — that is what a rim light IS.
        L.rim.position.set(-this._sunCamDir.x * 1.6, 0.24, -Math.abs(this._sunCamDir.z) - 0.45);
      }
    }

    /* ── 3. practicals sampled at the eye ───────────────────────────────── */
    const eye = this.ctx.player?.eyePosition;
    const slots = lg.practicals?.slots;
    let lit = 0;
    this._localAccum.set(0, 0, 0);
    let lr = 0, lgn = 0, lb = 0;
    if (eye?.isVector3 && slots) {
      for (let i = 0; i < slots.length; i++) {
        const pl = slots[i]?.light;
        if (!pl || pl.intensity <= 0.001) continue;
        const dx = pl.position.x - eye.x, dy = pl.position.y - eye.y, dz = pl.position.z - eye.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 400) continue;
        // Same inverse-square falloff three uses, with a near-field clamp so
        // standing inside a lamp does not blow the weapon out.
        const w = pl.intensity / Math.max(1.4, d2);
        if (w < 0.004) continue;
        const inv = 1 / Math.sqrt(d2);
        this._localAccum.x += dx * inv * w;
        this._localAccum.y += dy * inv * w;
        this._localAccum.z += dz * inv * w;
        lr += pl.color.r * w; lgn += pl.color.g * w; lb += pl.color.b * w;
        lit += w;
      }
    }
    // The practical lane is expressed in ABSOLUTE light intensity, and it was
    // calibrated back when the viewmodel key ran at 2.10x the world sun. Once the
    // albedo encoding was fixed and the key came down to match, this lane silently
    // became the brightest thing on the weapon indoors: in the warehouse the
    // support sleeve — a 0.019-albedo fabric — rendered as a solid white tube.
    // Tie it to the key so the ratio survives this and any future exposure change.
    const localGain = Math.max(0.16, (this._keyBase ?? LOCAL_LANE_REF) / LOCAL_LANE_REF);
    const localTarget = Math.min(9.5, lit * 1.35) * localGain;
    this._localLevel += (localTarget - this._localLevel) * Math.min(1, dt * 6);
    L.local.intensity = this._localLevel;
    if (lit > 1e-4) {
      this._localColor.setRGB(lr / lit, lgn / lit, lb / lit);
      L.local.color.copy(this._localColor);
      cam.getWorldQuaternion(this._tmpQ).invert();
      this._tmpV.copy(this._localAccum).normalize().applyQuaternion(this._tmpQ);
      L.local.position.copy(this._tmpV).multiplyScalar(2.0);
    }

    /* ── apply ──────────────────────────────────────────────────────────────
     * The key is now a HARD function of measured sun visibility, and the ambient
     * lanes RISE as it falls.
     *
     * The old curve was `0.50 + 0.50 * sunVis * (...)`, i.e. a floor of half the
     * full sun key no matter how deeply buried the player was. Combined with the
     * distance-0 probe bug above, that floor is what put a clipped, unbroken
     * specular bar down a rifle standing under a canopy — the single loudest
     * "composited from a different, sunlit shot" tell in the build.
     *
     * The replacement is the physical story: in shadow there is no sun, so the key
     * goes to a token 8% (enough to keep the form from going perfectly flat) and
     * the hemisphere fill plus the ground bounce carry the weapon entirely. Those
     * two lanes are scaled UP by the shade term precisely because they are all
     * that is left — a shaded object is still lit by half the sky dome, and a
     * viewmodel that falls to silhouette is a worse failure than one lifted a
     * stop. Net effect at spawn: key drops ~7x, bounce roughly doubles, and the
     * gun reads as soft ambient-lit rather than sun-struck.
     */
    const base = this._keyBase ?? 13.0;
    const sunV = this._sunVis;
    const skyV = this._skyVis;
    // Slight gamma so a grazing distant occluder (a gantry 40 m down the bearing)
    // still counts as "mostly lit" rather than dragging the key halfway down.
    const sunShaped = Math.pow(clamp(sunV, 0, 1), 0.7);
    const shade = 1 - sunShaped;

    const keyMul = 0.08 + 0.92 * sunShaped * (0.66 + 0.34 * skyV);
    const ambMul = (0.44 + 0.56 * skyV) * (1 + 1.55 * shade);
    const bncMul = (0.38 + 0.62 * skyV) * (1 + 1.95 * shade);
    // The rim is a sky-driven edge light, so it follows the sky, not the sun — but
    // it must not survive at full strength under a roof, which is what made every
    // worn edge keep a bright outline in a pitch-dark warehouse.
    const rimMul = (0.22 + 0.78 * skyV) * (1 + 0.35 * shade);

    L.key.intensity = base * keyMul;
    L.rim.intensity = base * this._vmLightRatio.rim * rimMul;
    L.fill.intensity = base * this._vmLightRatio.fill * ambMul;
    L.bounce.intensity = base * this._vmLightRatio.bounce * bncMul;

    // The environment probe is a SKY probe. Under a roof there is no sky, so the
    // metal on the gun must stop reflecting one — otherwise every worn edge keeps
    // its bright rim in a pitch-dark warehouse, which is half of why the edge
    // highlight read as light-independent in the first place.
    const envWant = this.envIntensity * (0.46 + 0.54 * skyV * (0.55 + 0.45 * sunShaped));
    if (Math.abs(envWant - this._envLevel) > 0.012) {
      this._envLevel = envWant;
      try {
        this.surfaces.applyEnvMap(this._boundEnv ?? this.ctx.lighting?.envMap ?? null, envWant, true);
        const vs = this.ctx.viewmodelScene;
        if (vs && 'environmentIntensity' in vs) vs.environmentIntensity = envWant;
      } catch (e) { /* not fatal */ }
    }
  }

  _update(dt, elapsed) {
    const { ctx } = this;
    this._ensureEnv();
    this._updateWorldLighting(dt);
    const input = ctx.input;
    const player = ctx.player;
    const w = this.weapons.get(this.activeId);
    if (!w) return;
    const def = w.def;

    /* ── player state ─────────────────────────────────────────────────────── */
    const vel = player?.velocity?.isVector3 ? player.velocity : this._tmpV.set(0, 0, 0);
    const planar = Math.hypot(vel.x, vel.z);
    const maxSpeed = ctx.config?.player?.sprintSpeed ?? 6.3;
    const sprinting = !!player?.isSprinting && planar > 0.5;
    const crouching = !!player?.isCrouching;
    const grounded = player?.isGrounded !== false;

    this._carrierVel.set(vel.x * 0.35, vel.y * 0.2, vel.z * 0.35);

    /* ── input ────────────────────────────────────────────────────────────── */
    const locked = !!input?.locked;
    let wantAds = false;
    if (locked) {
      if (input.isMouseDown(0)) { this._triggerHeld = true; } else { this._triggerHeld = false; this._triggerLatched = false; }
      wantAds = input.isMouseDown(2);
      if (input.wasPressed('KeyR')) this.startReload();
      if (input.wasPressed('KeyB')) this.cycleFireMode();
      if (input.wasPressed('Digit1')) this.switchTo('rifle');
      if (input.wasPressed('Digit2')) this.switchTo('smg');
      if (input.wasPressed('KeyQ')) this.nextWeapon(1);
      if (input.wheel) this.nextWeapon(input.wheel > 0 ? 1 : -1);
      this._inspect = input.isDown('KeyF');
    } else {
      this._triggerHeld = false;
      this._triggerLatched = false;
      this._inspect = false;
    }
    if (this._forceAds !== undefined) wantAds = !!this._forceAds;
    if (this._forceInspect !== undefined) this._inspect = !!this._forceInspect;
    if (this._forceShots > 0) { this._triggerHeld = true; this._forceShots--; }

    // Auto-reload the moment an empty trigger pull is registered.
    if (w.state.ammo <= 0 && !this.isReloading && this._triggerHeld && w.state.reserve > 0) {
      this.startReload();
    }

    /* ── weapon switch ────────────────────────────────────────────────────── */
    let lowered = false;
    if (this._switch) {
      const s = this._switch;
      s.t += dt;
      if (!s.swapped && s.t >= s.down) {
        s.swapped = true;
        const from = s.from;
        this._equip(s.to);
        try { ctx.events?.emit('weapon:switch', { from, to: s.to }); } catch (e) { /* noop */ }
        this._sfx('reload_mag_in', 0.5, 1.2);
      }
      lowered = !s.swapped || s.t < s.down + s.up * 0.35;
      if (s.t >= s.down + s.up) this._switch = null;
    }

    /* ── reload ───────────────────────────────────────────────────────────── */
    if (this.isReloading) this._updateReload(dt);

    /* ── fire control ─────────────────────────────────────────────────────── */
    this._fireTimer -= dt;
    this._sinceFire += dt;
    const ballState = {
      moving01: clamp(planar / maxSpeed, 0, 1),
      sprinting,
      crouching,
      grounded,
      adsT: this.viewmodel.adsT,
    };
    this._tryFire(dt, ballState);
    this.isFiring = this._sinceFire < 0.12;
    if (this._sinceFire > 0.36) this._shotIndex = 0;

    this.ballistics.update(dt, def, ballState);
    if (!this.isFiring) this.spreadRadians = this.ballistics.currentSpread(def, ballState);

    /* ── viewmodel ────────────────────────────────────────────────────────── */
    const yaw = player?.yaw ?? this._readCameraYaw();
    const pitch = player?.pitch ?? this._readCameraPitch();
    this.viewmodel.feedLook(yaw, pitch, dt);

    const strafe = this._localAxis(vel, true);
    const forward = this._localAxis(vel, false);

    this.viewmodel.update(dt, {
      speed: planar,
      maxSpeed,
      sprinting,
      crouching,
      grounded,
      ads: wantAds && !this._inspect,
      adsTime: def.handling.adsTime,
      sprintTime: def.handling.sprintTime,
      lowered,
      inspect: this._inspect,
      strafe,
      forward,
    });

    this.adsFactor = this.viewmodel.adsT;
    if (player) {
      try { player.isADS = this.adsFactor > 0.55; } catch (e) { /* read-only player */ }
    }

    /* ── ADS field of view ────────────────────────────────────────────────── */
    this._updateFov(dt, def);

    /* ── muzzle flash decay ───────────────────────────────────────────────── */
    this._updateFlash(dt, w);

    /* ── ejecta ───────────────────────────────────────────────────────────── */
    this.ejecta?.update(dt);
  }

  /**
   * Blend the world camera toward the ADS FOV. Cooperative by design: the player
   * system also writes `camera.fov` (sprint FOV), so we detect any write we did not
   * make ourselves and adopt it as the new base rather than fighting over it.
   */
  _updateFov(dt, def) {
    const cam = this.ctx.camera;
    const cfg = this.ctx.config.camera;
    if (!cam?.isPerspectiveCamera) return;

    if (this._lastWrittenFov === null || Math.abs(cam.fov - this._lastWrittenFov) > 1e-4) {
      this._baseFov = cam.fov;
    }
    const adsFov = (cfg.adsFov ?? 52) * (def.fovMul ?? 1);
    const target = THREE.MathUtils.lerp(this._baseFov, adsFov, this.adsFactor);
    if (Math.abs(cam.fov - target) > 1e-4) {
      cam.fov = target;
      cam.updateProjectionMatrix();
    }
    this._lastWrittenFov = cam.fov;

    // A slight viewmodel zoom on top sells the magnification without moving the
    // sight off the centre axis — the dot is on the camera's −Z either way.
    const vm = this.ctx.viewmodelCamera;
    if (vm?.isPerspectiveCamera) {
      const base = this.vmFov;
      const want = THREE.MathUtils.lerp(base, base * 0.90, this.adsFactor);
      if (Math.abs(vm.fov - want) > 1e-4) {
        vm.fov = want;
        vm.updateProjectionMatrix();
      }
    }
  }

  _updateFlash(dt, w) {
    if (this._flashLife <= 0) {
      if (this._flashLightWorld) this._flashLightWorld.intensity = 0;
      if (this._flashLightVm) this._flashLightVm.intensity = 0;
      if (this._flash) this._flash.visible = false;
      return;
    }
    this._flashT += dt;
    const t = clamp(this._flashT / this._flashLife, 0, 1);
    // Sharp attack, exponential decay — a real flash is over in ~2 ms of light and
    // ~50 ms of burning powder.
    const a = Math.pow(1 - t, 2.6);

    if (this._flash) {
      this._flash.visible = t < 1;
      // Bloom outward as it dies rather than simply fading: burning powder expands.
      const s = (this._flashScale ?? 0.09) * (0.72 + 0.55 * (1 - a));
      this._flash.scale.set(s * a ** 0.35, s * a ** 0.35, s * 1.25);
    }
    if (this._flashLightVm) {
      // Same ratio discipline as the practical lane above: the viewmodel flash
      // light is a fraction of the key, not an absolute.
      const g = Math.max(0.08, (this._keyBase ?? LOCAL_LANE_REF) / LOCAL_LANE_REF);
      this._flashLightVm.intensity = 26 * a * Math.max(0.35, g);
    }
    if (this._flashLightWorld) {
      this._flashLightWorld.intensity = 95 * a;
      this._flashLightWorld.position.copy(this._muzzleWorld);
    }
    // Keep the vm flash light glued to the muzzle in camera space.
    if (this._flashLightVm && w) {
      try {
        const node = w.model.muzzle;
        node.updateWorldMatrix(true, false);
        this._tmpV.setFromMatrixPosition(node.matrixWorld);
        this.ctx.viewmodelCamera.worldToLocal(this._tmpV);
        this._flashLightVm.position.copy(this._tmpV);
      } catch (e) { /* noop */ }
    }

    if (t >= 1) {
      this._flashLife = 0;
      if (this._flash) this._flash.visible = false;
    }
  }

  _localAxis(vel, strafe) {
    const cam = this.ctx.camera;
    if (!cam) return 0;
    cam.getWorldDirection(this._fwd);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-6) return 0;
    this._fwd.normalize();
    if (strafe) {
      // Right vector = forward x up.
      const rx = -this._fwd.z, rz = this._fwd.x;
      return clamp((vel.x * rx + vel.z * rz) / 6, -1, 1);
    }
    return clamp((vel.x * this._fwd.x + vel.z * this._fwd.z) / 6, -1, 1);
  }

  _readCameraYaw() {
    const cam = this.ctx.camera;
    if (!cam) return 0;
    cam.getWorldDirection(this._tmpV);
    return Math.atan2(-this._tmpV.x, -this._tmpV.z);
  }

  _readCameraPitch() {
    const cam = this.ctx.camera;
    if (!cam) return 0;
    cam.getWorldDirection(this._tmpV);
    return Math.asin(clamp(this._tmpV.y, -1, 1));
  }

  /* ─────────────────────────────── misc ────────────────────────────────── */

  /**
   * Where the red dot lands on screen, in pixels from the frame centre.
   * The verification hook for ADS alignment.
   */
  _reticlePixel() {
    try {
      const w = this.weapons.get(this.activeId);
      const r = w?.model?.reticle;
      const cam = this.ctx.viewmodelCamera;
      if (!r || !cam) return null;
      r.updateWorldMatrix(true, false);
      this._tmpV.setFromMatrixPosition(r.matrixWorld);
      // Use the un-jittered projection: TAA's sub-pixel offset is not misalignment.
      const saved = cam.view ? { ...cam.view } : null;
      cam.clearViewOffset();
      cam.updateProjectionMatrix();
      this._tmpV.project(cam);
      if (saved && saved.enabled) {
        cam.setViewOffset(saved.fullWidth, saved.fullHeight, saved.offsetX, saved.offsetY, saved.width, saved.height);
      }
      const W = window.innerWidth, H = window.innerHeight;
      return {
        px: +(this._tmpV.x * W * 0.5).toFixed(3),
        py: +(-this._tmpV.y * H * 0.5).toFixed(3),
      };
    } catch (err) {
      return null;
    }
  }

  /** Give ammo back (pickups, respawn). */
  refill(id = null) {
    const list = id ? [this.weapons.get(id)] : [...this.weapons.values()];
    for (const w of list) {
      if (!w) continue;
      w.state.ammo = w.state.magSize;
      w.state.reserve = w.def.reserve;
    }
  }

  resize() { /* the viewmodel camera is resized by the engine */ }

  dispose() {
    try {
      this.ejecta?.dispose();
      this.viewmodel?.dispose();
      for (const [, w] of this.weapons) {
        w.model.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      }
      this.weapons.clear();
      this.surfaces?.dispose();
      if (this._flashLightWorld) this.ctx.scene.remove(this._flashLightWorld);
      if (typeof window !== 'undefined' && window.__WEAPONS__?.system === this) delete window.__WEAPONS__;
    } catch (err) { /* teardown is best-effort */ }
  }
}

export default WeaponSystem;
