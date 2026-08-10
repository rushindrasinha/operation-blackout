import * as THREE from 'three';
import { ParticleBatch, K } from './ParticleBatch.js';
import { DecalField } from './DecalField.js';
import { AmbientLife } from './AmbientLife.js';
import { TracerBeams } from './TracerBeams.js';
import { buildParticleAtlas, buildDecalAtlases, buildPaperTexture, P, D } from './textures.js';

/**
 * FXSystem — the moment-to-moment spectacle.
 *
 * Everything a shot produces lives here: material-correct impact bursts,
 * conforming projected decals, travelling tracers, muzzle flash and smoke,
 * restrained blood, and the ambient particulate that stops the world reading as
 * a diorama.
 *
 * Cost model — the whole layer is five draw calls plus litter:
 *   1  lit / alpha-blended batch    (smoke, dust, splinters, blood mist)
 *   2  additive batch               (sparks, flash, embers, motes)
 *   3  additive viewmodel batch     (muzzle flash inside the gun's own scene)
 *   4  tracer beams                 (world-space segments; only while in flight)
 *   5  decal field                  (all 16 decal looks, one atlas)
 *   6  paper litter InstancedMesh
 *
 * Nothing allocates at runtime. Particles are pooled Structure-of-Arrays,
 * decals are a fixed vertex arena, and every spawn call reuses one options
 * object.
 *
 * Two engine facts shape every decision in here (ARCHITECTURE.md, Phase A):
 *  - transparent / depthWrite:false objects are excluded from the G-buffer, so
 *    they get no AO, no SSR and no TAA. Particles must therefore be soft, wide
 *    and low-contrast; decals must be opaque + alpha-tested so they DO land in
 *    the G-buffer and get antialiased like real geometry.
 *  - the G-buffer depth texture is written after the beauty pass, so sampling
 *    it from a particle shader reads last frame's depth. One frame of latency
 *    on a soft-particle fade is invisible; the alternative — hard quad/geometry
 *    intersection lines — is the loudest amateur tell in real-time VFX.
 *
 * OWNER: fx
 */

const MAT_FAMILY = {
  concrete: 'concrete', plaster: 'plaster', asphalt: 'concrete', brick: 'concrete',
  stone: 'concrete', rubble: 'concrete', tile: 'concrete',
  rustmetal: 'metal', rustMetal: 'metal', paintedMetal: 'metal', paintedmetal: 'metal',
  metal: 'metal', steel: 'metal', iron: 'metal', aluminium: 'metal', pipe: 'metal',
  wood: 'wood', plank: 'wood', crate: 'wood', plywood: 'wood',
  dirt: 'dirt', sand: 'dirt', gravel: 'dirt', grass: 'dirt', mud: 'dirt', earth: 'dirt',
  glass: 'glass', window: 'glass',
  fabric: 'fabric', sandbags: 'fabric', canvas: 'fabric', cloth: 'fabric', tarp: 'fabric',
  rubber: 'rubber', tyre: 'rubber', tire: 'rubber',
  flesh: 'flesh', body: 'flesh',
};

/** Physics debris material per family — physics keeps its own density table. */
const DEBRIS_MAT = {
  concrete: 'concrete', plaster: 'plaster', metal: 'rustMetal', wood: 'wood',
  dirt: 'dirt', glass: 'glass', fabric: 'sandbags', rubber: 'rubber',
};

export class FXSystem {
  static id = 'fx';
  static order = 50;

  constructor(ctx) {
    this.ctx = ctx;
    this.ok = false;
    this.enabled = true;

    this.batches = { lit: null, additive: null, vm: null };
    this.decals = null;
    this.ambient = null;
    this.tracers = null;

    this.quality = 1.0;           // global particle-count multiplier
    /**
     * Rounds per tracer. Belts and magazines are loaded 4:1 ball:tracer for
     * exactly the reason it matters here — a tracer on every round is not a
     * stream of tracers, it is a solid line. At 620 m/s and 10 rounds/s the
     * streaks butt end to end and the result reads as one static bar hanging in
     * mid-air with no emitter at either end, which is precisely what three
     * critics independently reported. Every third round keeps the read.
     */
    this.tracerEvery = 3;
    this._tracerSeq = Math.floor(Math.random() * 3);

    this._o = {};                 // shared spawn options object — never reallocated
    this._impactBudget = 6;
    this._impactsThisFrame = 0;
    this._lastMuzzle = -10;
    this._lastTracer = -10;
    this._lastBloodDecal = -10;
    this._elapsed = 0;

    this._camPos = new THREE.Vector3();
    this._sunDirWorld = new THREE.Vector3(0.3, 0.6, 0.5).normalize();
    this._sunDirView = new THREE.Vector3(0, 0, -1);
    this._sunCol = new THREE.Vector3(1.1, 0.92, 0.72);
    this._skyCol = new THREE.Vector3(0.16, 0.19, 0.23);
    this._gndCol = new THREE.Vector3(0.05, 0.045, 0.04);
    this._upView = new THREE.Vector3(0, 1, 0);

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._v4 = new THREE.Vector3();
    this._tan = new THREE.Vector3();
    this._bit = new THREE.Vector3();
    // We run at order 50; the renderer does not refresh camera.matrixWorldInverse
    // until order 90, so at this point that matrix is a frame stale. Derive our
    // own or every particle sorts and lights against the previous frame's view.
    this._viewM = new THREE.Matrix4();
    this._unsubs = [];

    this._sunVis = 1;
    // Adaptive load control. Particles are fill-rate bound, not CPU bound: a
    // dozen overlapping metre-wide soft quads two metres from the lens is
    // several full-screen passes worth of shading. Rather than authoring for
    // the worst case and looking thin everywhere else, author for the common
    // case and shed particle count when the frame actually starts to slip.
    this._msAvg = 12.0;
    this._qualityCooldown = 0;
    this.stats = { impacts: 0, tracers: 0, decals: 0, flashes: 0 };
  }

  /* ── init ─────────────────────────────────────────────────────────────── */

  async init(onProgress = () => {}) {
    const { ctx } = this;
    try {
      onProgress(0.05, 'fx: particle atlas');
      const particleAtlas = buildParticleAtlas(512, this._aniso());
      await this._yield();

      onProgress(0.35, 'fx: decal atlas');
      const decalAtlases = buildDecalAtlases(1024, 512, this._aniso());
      await this._yield();

      onProgress(0.72, 'fx: batches');
      this.batches.lit = new ParticleBatch({
        capacity: 460, atlas: particleAtlas, additive: false, lit: true,
        scene: ctx.scene, renderOrder: 10, soft: true, name: 'fx:smoke',
      });
      this.batches.additive = new ParticleBatch({
        capacity: 980, atlas: particleAtlas, additive: true, lit: false,
        scene: ctx.scene, renderOrder: 12, soft: true, name: 'fx:additive',
      });
      // The viewmodel lives in its own scene with its own camera, so its flash
      // needs its own batch. Soft fading is off there: the world depth buffer
      // has nothing to say about a gun rendered in a separate pass.
      this.batches.vm = new ParticleBatch({
        capacity: 96, atlas: particleAtlas, additive: true, lit: false,
        scene: ctx.viewmodelScene, renderOrder: 20, soft: false, name: 'fx:vmflash',
      });
      this.batches.vm.material.uniforms.uNearFade.value = 0.0;
      this.batches.vm.material.uniforms.uFogAtten.value = 0.0;
      // Sparks and tracers are small and hot. They still must not punch through
      // a wall, but fading them over a smoke-sized depth range erases them the
      // moment they skitter along the surface they came off.
      this.batches.additive.material.uniforms.uSoftScale.value = 0.30;

      // Tracers are segments, not particles — see TracerBeams.js for why that
      // distinction is the whole fix. One extra draw call, only while a round
      // is actually in the air.
      this.tracers = new TracerBeams({
        capacity: 40, scene: ctx.scene, renderOrder: 13,
      });

      onProgress(0.86, 'fx: decals');
      this.decals = new DecalField(ctx, decalAtlases);
      this.decals.attach(ctx.scene);
      this._registerMaterial(this.decals.material);

      onProgress(0.93, 'fx: ambient life');
      this.ambient = new AmbientLife(ctx, this.batches);
      this.ambient.buildLitter(buildPaperTexture(128), ctx.scene, (m) => this._registerMaterial(m));

      this._subscribe();

      this.ok = true;
      if (typeof window !== 'undefined') window.__FX__ = this;
      console.info(
        `[fx] ready — ${this.batches.lit.capacity + this.batches.additive.capacity + this.batches.vm.capacity}`
        + ' pooled particles in 3 batches, 176 projected decals, soft-particle depth fade on');
      onProgress(1, 'fx');
    } catch (err) {
      console.error('[fx] init failed — effects disabled, game continues:', err);
      this.ok = false;
    }
  }

  _yield() { return new Promise((r) => setTimeout(r, 0)); }

  _aniso() {
    try { return Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy()); }
    catch { return 4; }
  }

  /**
   * A lit material that has not been through CSM setup takes the non-CSM shader
   * branch and receives all four cascade lights at full intensity — 4x
   * overexposed. This is the single most dangerous gotcha in the project.
   */
  _registerMaterial(mat) {
    if (!mat) return;
    try {
      const l = this.ctx.lighting;
      if (!l) return;
      if (typeof l.registerMaterial === 'function') l.registerMaterial(mat);
      else if (l.csm && typeof l.csm.setupMaterial === 'function') l.csm.setupMaterial(mat);
    } catch (err) {
      console.warn('[fx] CSM registration failed:', err);
    }
  }

  _subscribe() {
    const e = this.ctx.events;
    if (!e) return;
    this._unsubs.push(e.on('hit:world', (p) => {
      if (!p || !p.point || !p.normal) return;
      this.spawnImpact(p.point, p.normal, p.material, p.impulse);
    }));
    this._unsubs.push(e.on('hit:actor', (p) => {
      if (!p || !p.point) return;
      this._v4.copy(p.normal || this._sunDirWorld);
      this.spawnBloodHit(p.point, this._v4, p.isHeadshot ? 1.5 : 1.0);
    }));
    this._unsubs.push(e.on('weapon:fire', (p) => this._onWeaponFire(p)));
  }

  /* ── public API ───────────────────────────────────────────────────────── */

  /**
   * Material-correct impact burst. Concrete throws grey dust and chips, metal
   * throws bouncing orange sparks with motion trails, wood throws splinters,
   * dirt gives a soft puff, glass shatters into glinting shards.
   */
  spawnImpact(point, normal, materialName, impulse = 1) {
    if (!this.ok || !this.enabled) return;
    if (this._impactsThisFrame >= this._impactBudget) return;
    this._impactsThisFrame++;
    this.stats.impacts++;

    try {
      const fam = this.familyOf(materialName);
      const n = this._v.copy(normal);
      if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
      n.normalize();
      this._basis(n);

      this._sunVis = this._sampleSunVis(point);
      const scale = Math.min(1.6, Math.max(0.5, impulse || 1));
      switch (fam) {
        case 'metal': this._impactMetal(point, n, scale); break;
        case 'wood': this._impactWood(point, n, scale); break;
        case 'dirt': this._impactDirt(point, n, scale); break;
        case 'glass': this._impactGlass(point, n, scale); break;
        case 'fabric': this._impactFabric(point, n, scale); break;
        case 'rubber': this._impactRubber(point, n, scale); break;
        case 'flesh': this.spawnBloodHit(point, n, scale); break;
        case 'plaster': this._impactConcrete(point, n, scale, true); break;
        default: this._impactConcrete(point, n, scale, false); break;
      }
    } catch (err) {
      if (!this._loggedImpact) { this._loggedImpact = true; console.warn('[fx] spawnImpact:', err); }
    }
  }

  /**
   * Project a decal that CONFORMS to the geometry it lands on.
   * `type` is a semantic name, not a tile index.
   */
  addDecal(point, normal, size = 0.12, type = 'bullet') {
    if (!this.ok || !this.enabled || !this.decals) return false;
    try {
      const spec = this._decalSpec(type);
      const ok = this.decals.add(point, normal, size * (spec.scale ?? 1), spec.tile, spec.opts);
      this.stats.decals++;
      return ok;
    } catch (err) {
      if (!this._loggedDecal) { this._loggedDecal = true; console.warn('[fx] addDecal:', err); }
      return false;
    }
  }

  /**
   * A tracer that actually TRAVELS — as a world-space segment, not a billboard.
   *
   * This used to spawn two screen-space stretched particles whose length was
   * `speed * dt`, which meant the streak was longer on a slow machine than a
   * fast one and had no perspective taper along 20 m of depth. TracerBeams
   * renders a real head→tail ribbon instead; see that file for the full
   * reasoning. The signature and contract are unchanged.
   *
   * Only every `tracerEvery`-th call actually produces a round — the ratio lives
   * here rather than in each caller so the weapon system, the bots and our own
   * `weapon:fire` fallback all obey one policy.
   */
  spawnTracer(from, to, speed = 330) {
    if (!this.ok || !this.enabled) return;
    try {
      this._v2.copy(to).sub(from);
      const dist = this._v2.length();
      // A start and end point that coincide produce a degenerate quad with an
      // arbitrary orientation — that is exactly the "orphan streak with no
      // emitter and no falloff" failure. Refuse it here as well as in spawn().
      if (!(dist > 0.6)) return;
      this._v2.multiplyScalar(1 / dist);

      // Every call is a *round*; only some rounds are tracers.
      this._lastTracer = this._elapsed;
      if (++this._tracerSeq < this.tracerEvery) return;
      this._tracerSeq = 0;

      const dropped = this.tracers
        ? this.tracers.spawn(from, this._v2, dist, speed, {
          width: 0.09,
          gain: 1.0,
          // The halo carries the amber; the core is warm near-white. Keeping
          // the saturation in the dim lobe stops the tracer being the most
          // saturated element in a deliberately desaturated frame.
          r: 1.0, g: 0.64, b: 0.34,
        })
        : -1;
      if (dropped >= 0) this.stats.tracers++;

      // A round leaving the barrel lights the air just in front of the muzzle.
      // One small additive puff sells the departure without re-introducing a
      // billboard along the flight path.
      //
      // It outlives the muzzle flash that produced it (30-66 ms) on purpose. A
      // tracer is in the air for roughly 100 ms; if the emitter's light is gone
      // by then, any single frame catches a streak hanging in mid-air with
      // nothing at either end — which is exactly how all three critics read it.
      // A ~120 ms departure glow means the shooter is almost always still
      // visible while their round is.
      if (dropped >= 0 && this.batches.additive) {
        const o = this._reset();
        o.x = from.x + this._v2.x * 0.25;
        o.y = from.y + this._v2.y * 0.25;
        o.z = from.z + this._v2.z * 0.25;
        o.kind = K.FLASH; o.tile = P.SPARK;
        o.life = 0.125;
        o.size = 0.13; o.endSize = 0.26;
        o.alpha = 0.40;
        o.r = 1.0; o.g = 0.72; o.b = 0.42;
        o.r2 = 1.0; o.g2 = 0.46; o.b2 = 0.18;
        o.emissive = 2.2; o.endEmissive = 0.18;
        o.fadeIn = 0.004; o.fadeExp = 1.9;
        this.batches.additive.spawn(o);
      }
    } catch (err) {
      if (!this._loggedTracer) { this._loggedTracer = true; console.warn('[fx] spawnTracer:', err); }
    }
  }

  /**
   * Brief multi-plane muzzle flash with randomised rotation, scale and sprite,
   * plus smoke that lingers and drifts. Never the same silhouette twice.
   *
   * @param {THREE.Matrix4|THREE.Vector3} matrix muzzle transform (or position)
   * @param {number} scale
   * @param {object} opts { space:'world'|'viewmodel', dir:Vector3, smoke:boolean }
   */
  spawnMuzzleFlash(matrix, scale = 1, opts = {}) {
    if (!this.ok || !this.enabled) return;
    try {
      const pos = this._v;
      const dir = this._v2;
      if (matrix && matrix.isMatrix4) {
        pos.setFromMatrixPosition(matrix);
        const e = matrix.elements;
        dir.set(-e[8], -e[9], -e[10]);          // three convention: forward is -Z
        if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
        dir.normalize();
      } else if (matrix && matrix.isVector3) {
        pos.copy(matrix);
        dir.copy(opts.dir || this._forward(this._v3)).normalize();
      } else {
        return;
      }
      if (opts.dir && opts.dir.isVector3) dir.copy(opts.dir).normalize();

      const vm = opts.space === 'viewmodel' || opts.viewmodel === true;
      const batch = vm ? this.batches.vm : this.batches.additive;
      if (!batch) return;

      this._lastMuzzle = this._elapsed;
      this.stats.flashes++;
      this._sunVis = this._sampleSunVis(pos);
      const s = Math.max(0.15, scale || 1);

      const o = this._reset();
      o.kind = K.FLASH;
      o.drag = 0; o.gravity = 0; o.stretch = 0;

      // 3-4 overlapping planes, each with its own sprite, roll and scale. The
      // roll is continuous, so the silhouette differs on literally every shot —
      // the "same sprite twice" tell is impossible.
      const planes = 3 + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < planes; i++) {
        const along = 0.02 + i * 0.035 * s + Math.random() * 0.03 * s;
        o.x = pos.x + dir.x * along;
        o.y = pos.y + dir.y * along;
        o.z = pos.z + dir.z * along;
        o.vx = o.vy = o.vz = 0;
        o.tile = i === 0 ? P.FLASH_STAR : (Math.random() < 0.5 ? P.FLASH_BLOB : P.FLASH_STAR);
        o.life = 0.030 + Math.random() * 0.036;
        const sz = s * (0.16 + Math.random() * 0.20) * (i === 0 ? 1.35 : 1.0);
        o.size = sz * 0.55; o.endSize = sz;
        o.rot = Math.random() * Math.PI * 2;
        o.rotv = (Math.random() - 0.5) * 14;
        o.alpha = 0.95;
        o.r = 1.0; o.g = 0.82; o.b = 0.52;
        o.r2 = 1.0; o.g2 = 0.50; o.b2 = 0.20;
        o.emissive = 5.5 + Math.random() * 4.0;
        o.endEmissive = 1.0;
        o.fadeIn = 0.002; o.fadeExp = 1.3;
        batch.spawn(o);
      }

      // Forward jet of burning propellant.
      for (let i = 0; i < 3; i++) {
        const along = (0.09 + Math.random() * 0.20) * s;
        o.x = pos.x + dir.x * along + (Math.random() - 0.5) * 0.02;
        o.y = pos.y + dir.y * along + (Math.random() - 0.5) * 0.02;
        o.z = pos.z + dir.z * along + (Math.random() - 0.5) * 0.02;
        o.tile = P.FLASH_BLOB;
        o.life = 0.024 + Math.random() * 0.026;
        o.size = s * 0.05; o.endSize = s * (0.10 + Math.random() * 0.10);
        o.rot = Math.random() * 6.28; o.rotv = 0;
        o.alpha = 0.8;
        o.r = 1.0; o.g = 0.72; o.b = 0.40;
        o.r2 = 0.9; o.g2 = 0.34; o.b2 = 0.10;
        o.emissive = 3.6; o.endEmissive = 0.5;
        batch.spawn(o);
      }

      // Unburnt powder thrown out of the muzzle.
      for (let i = 0; i < 5; i++) {
        this._basis(dir);
        this._cone(dir, 0.55, this._v3);
        const sp = 2.4 + Math.random() * 5.5;
        o.x = pos.x + dir.x * 0.05; o.y = pos.y + dir.y * 0.05; o.z = pos.z + dir.z * 0.05;
        o.vx = this._v3.x * sp; o.vy = this._v3.y * sp; o.vz = this._v3.z * sp;
        o.kind = vm ? K.FLASH : K.SPARK;
        o.tile = P.SPARK;
        o.life = 0.10 + Math.random() * 0.20;
        o.size = 0.010 + Math.random() * 0.010; o.endSize = 0.004;
        o.rot = 0; o.rotv = 0;
        o.alpha = 1;
        o.r = 1.0; o.g = 0.66; o.b = 0.26;
        o.r2 = 0.9; o.g2 = 0.24; o.b2 = 0.04;
        o.emissive = 3.4; o.endEmissive = 0.5;
        o.stretch = 0.75;
        o.drag = 1.6; o.gravity = vm ? 0 : -6.5;
        o.fadeIn = 0.002; o.fadeExp = 1.0;
        batch.spawn(o);
        o.kind = K.FLASH; o.stretch = 0; o.drag = 0; o.gravity = 0;
      }

      // Lingering smoke, always in world space: it has to outlive the window in
      // which the gun's local frame is still meaningful.
      if (opts.smoke !== false) {
        if (vm) {
          this._muzzleWorldGuess(this._v3);
          this._forward(this._v4);
          this._muzzleSmoke(this._v3, this._v4, s);
        } else {
          this._muzzleSmoke(pos, dir, s);
        }
      }

      // Bounce light: a soft additive pool on whatever surface is in front of
      // the muzzle. Cheaper and far safer than adding a real point light, which
      // would force a full material recompile mid-game.
      if (!vm) this._flashBounce(pos, dir, s);
    } catch (err) {
      if (!this._loggedFlash) { this._loggedFlash = true; console.warn('[fx] spawnMuzzleFlash:', err); }
    }
  }

  /** Restrained directional mist. Deliberately dark, short-lived and small. */
  spawnBloodHit(point, normal, scale = 1) {
    if (!this.ok || !this.enabled) return;
    const b = this.batches.lit;
    if (!b) return;
    try {
      const n = this._v.copy(normal || this._sunDirWorld);
      if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
      n.normalize();
      this._basis(n);
      this._sunVis = this._sampleSunVis(point);

      const o = this._reset();
      const count = Math.round(9 * scale * this.quality);
      for (let i = 0; i < count; i++) {
        this._cone(n, 0.85, this._v3);
        const sp = 0.9 + Math.random() * 2.8 * scale;
        o.x = point.x + n.x * 0.02; o.y = point.y + n.y * 0.02; o.z = point.z + n.z * 0.02;
        o.vx = this._v3.x * sp; o.vy = this._v3.y * sp + 0.35; o.vz = this._v3.z * sp;
        o.kind = K.CHIP;
        o.tile = P.MIST;
        o.life = 0.24 + Math.random() * 0.42;
        o.size = 0.018 + Math.random() * 0.028;
        o.endSize = o.size * (2.0 + Math.random());
        o.alpha = 0.42 + Math.random() * 0.24;
        // Dark and desaturated, and it darkens further as it disperses. Bright
        // red is the fastest way to make a military scene look like a cartoon —
        // but it still has to survive being multiplied by a shadowed ambient,
        // or a hit in cover produces no feedback at all.
        o.r = 0.400; o.g = 0.058; o.b = 0.048;
        o.r2 = 0.185; o.g2 = 0.026; o.b2 = 0.022;
        o.fadeIn = 0.02; o.fadeExp = 1.5;
        o.rot = Math.random() * 6.28; o.rotv = (Math.random() - 0.5) * 4;
        o.drag = 2.6; o.gravity = -5.2;
        o.stretch = 0.25;
        b.spawn(o);
      }

      // A few heavier droplets that actually arc.
      for (let i = 0; i < 3; i++) {
        this._cone(n, 0.55, this._v3);
        const sp = 2.6 + Math.random() * 3.4;
        o.x = point.x; o.y = point.y; o.z = point.z;
        o.vx = this._v3.x * sp; o.vy = this._v3.y * sp + 1.1; o.vz = this._v3.z * sp;
        o.tile = P.MIST;
        o.life = 0.5 + Math.random() * 0.4;
        o.size = 0.012; o.endSize = 0.016;
        o.alpha = 0.6;
        o.drag = 0.5; o.gravity = -9.0;
        o.stretch = 0.5;
        o.fadeExp = 0.8;
        b.spawn(o);
      }

      // One ground mark at a time, at most. Tasteful, not a slaughterhouse.
      if (this._elapsed - this._lastBloodDecal > 0.55) {
        this._lastBloodDecal = this._elapsed;
        this._bloodGroundMark(point);
      }
    } catch (err) {
      if (!this._loggedBlood) { this._loggedBlood = true; console.warn('[fx] spawnBloodHit:', err); }
    }
  }

  /** Level hook: register a fire so embers and smoke drift off it. */
  addEmberSource(position, opts) { return this.ambient?.addEmberSource(position, opts) ?? null; }
  removeEmberSource(h) { this.ambient?.removeEmberSource(h); }

  /** Level hook: a persistent smoke vent / burning-wreck plume. */
  addSmokeVent(position, opts = {}) {
    return this.ambient?.addEmberSource(position, {
      radius: opts.radius ?? 0.5, rate: opts.embers ?? 0, smoke: true,
    }) ?? null;
  }

  familyOf(name) {
    if (!name) return 'concrete';
    const k = String(name);
    return MAT_FAMILY[k] ?? MAT_FAMILY[k.toLowerCase()] ?? 'concrete';
  }

  /* ── impact recipes ───────────────────────────────────────────────────── */

  _impactConcrete(pt, n, scale, isPlaster) {
    const lit = this.batches.lit, add = this.batches.additive;
    const o = this._reset();
    const q = this.quality;

    // Dust is the signature of masonry: bright and fast, then it hangs.
    const dustN = Math.round((isPlaster ? 13 : 10) * scale * q);
    for (let i = 0; i < dustN; i++) {
      this._cone(n, 0.95, this._v3);
      const sp = 0.7 + Math.random() * 3.4 * scale;
      o.x = pt.x + n.x * 0.03; o.y = pt.y + n.y * 0.03; o.z = pt.z + n.z * 0.03;
      o.vx = this._v3.x * sp; o.vy = this._v3.y * sp + 0.5; o.vz = this._v3.z * sp;
      o.kind = K.SMOKE;
      o.tile = i % 3 === 0 ? P.WISP : (i % 3 === 1 ? P.PUFF_A : P.PUFF_B);
      o.life = 1.0 + Math.random() * 2.0;
      o.size = 0.055 + Math.random() * 0.07;
      o.endSize = o.size * (5.5 + Math.random() * 5.5);
      o.alpha = 0.30 + Math.random() * 0.24;
      const g = isPlaster ? 0.80 : 0.66;
      o.r = g; o.g = g * 0.985; o.b = g * 0.945;
      o.r2 = g * 0.72; o.g2 = g * 0.71; o.b2 = g * 0.69;
      o.fadeIn = 0.025; o.fadeExp = 1.9;
      o.rot = Math.random() * 6.28; o.rotv = (Math.random() - 0.5) * 2.2;
      o.drag = 2.4; o.gravity = -0.45;
      o.stretch = 0.10;
      lit.spawn(o);
    }

    // Small chips pinging off — grey, not glowing. Concrete does not spark.
    for (let i = 0; i < Math.round(6 * scale * q); i++) {
      this._cone(n, 0.75, this._v3);
      const sp = 2.6 + Math.random() * 5.5;
      o.x = pt.x + n.x * 0.02; o.y = pt.y + n.y * 0.02; o.z = pt.z + n.z * 0.02;
      o.vx = this._v3.x * sp; o.vy = this._v3.y * sp + 0.8; o.vz = this._v3.z * sp;
      o.kind = K.CHIP;
      o.tile = P.SLIVER;
      o.life = 0.5 + Math.random() * 0.7;
      o.size = 0.010 + Math.random() * 0.014;
      o.endSize = o.size;
      o.alpha = 0.85;
      o.r = 0.52; o.g = 0.505; o.b = 0.48;
      o.r2 = 0.40; o.g2 = 0.39; o.b2 = 0.37;
      o.fadeIn = 0.005; o.fadeExp = 0.7;
      o.rot = Math.random() * 6.28; o.rotv = (Math.random() - 0.5) * 22;
      o.drag = 0.5; o.gravity = -12.5;
      o.stretch = 0.20;
      lit.spawn(o);
    }

    this._surfaceFlash(pt, n, add, 0.16 * scale, 0.9, 0.72, 0.52, 0.75);
    this._debris(pt, n, isPlaster ? 3 : 4, isPlaster ? 'plaster' : 'concrete', 2.9);
    this._impactDecal(pt, n, isPlaster ? 'bullet_plaster' : 'bullet_concrete', 0.105 + Math.random() * 0.05);
  }

  _impactMetal(pt, n, scale) {
    const lit = this.batches.lit, add = this.batches.additive;
    const o = this._reset();
    const q = this.quality;
    const planeD = pt.x * n.x + pt.y * n.y + pt.z * n.z;

    // Sparks are the whole point of a metal hit: stretched, gravity-bound, and
    // they bounce off the plate they came out of before burning out.
    const nSpark = Math.round(20 * scale * q);
    for (let i = 0; i < nSpark; i++) {
      this._cone(n, 1.05, this._v3);
      const sp = 2.8 + Math.random() * 6.4 * scale;
      o.x = pt.x + n.x * 0.015; o.y = pt.y + n.y * 0.015; o.z = pt.z + n.z * 0.015;
      o.vx = this._v3.x * sp; o.vy = this._v3.y * sp + 0.6; o.vz = this._v3.z * sp;
      o.kind = K.SPARK;
      o.tile = Math.random() < 0.7 ? P.SPARK : P.STREAK;
      o.life = 0.42 + Math.random() * 0.85;
      o.size = 0.016 + Math.random() * 0.018;
      o.endSize = 0.005;
      o.alpha = 1;
      // White-hot only for the first instant, then amber, then a dull red
      // ember. Holding white for long is what makes browser sparks look like
      // confetti instead of hot steel.
      o.r = 1.0; o.g = 0.74; o.b = 0.36;
      o.r2 = 0.92; o.g2 = 0.14; o.b2 = 0.02;
      o.emissive = 5.5 + Math.random() * 4.0;
      o.endEmissive = 0.28;
      o.fadeIn = 0.002; o.fadeExp = 0.85;
      o.drag = 1.35; o.gravity = -9.8;
      o.stretch = 1.05 + Math.random() * 0.7;
      o.bounce = 0.35 + Math.random() * 0.3;
      o.nx = n.x; o.ny = n.y; o.nz = n.z;
      o.planeD = planeD;
      add.spawn(o);
    }
    o.bounce = 0; o.planeD = -1e9;

    // Thin blue-grey smoke off the strike.
    for (let i = 0; i < Math.round(4 * scale * q); i++) {
      this._cone(n, 0.7, this._v3);
      const sp = 0.6 + Math.random() * 1.6;
      o.x = pt.x + n.x * 0.03; o.y = pt.y + n.y * 0.03; o.z = pt.z + n.z * 0.03;
      o.vx = this._v3.x * sp; o.vy = this._v3.y * sp + 0.7; o.vz = this._v3.z * sp;
      o.kind = K.SMOKE;
      o.tile = P.WISP;
      o.life = 0.55 + Math.random() * 0.9;
      o.size = 0.035; o.endSize = 0.24 + Math.random() * 0.2;
      o.alpha = 0.20;
      o.r = 0.46; o.g = 0.47; o.b = 0.50;
      o.r2 = 0.34; o.g2 = 0.35; o.b2 = 0.38;
      o.emissive = 1; o.endEmissive = 1;   // the spark loop above left this hot
      o.fadeIn = 0.03; o.fadeExp = 1.6;
      o.rot = Math.random() * 6.28; o.rotv = (Math.random() - 0.5) * 3;
      o.drag = 2.2; o.gravity = 0.15;
      o.stretch = 0;
      lit.spawn(o);
    }

    this._surfaceFlash(pt, n, add, 0.19 * scale, 1.0, 0.66, 0.30, 1.7);
    this._debris(pt, n, 2, 'metal', 3.6);
    this._impactDecal(pt, n, 'bullet_metal', 0.070 + Math.random() * 0.035);
  }

  _impactWood(pt, n, scale) {
    const lit = this.batches.lit, add = this.batches.additive;
    const o = this._reset();
    const q = this.quality;

    // Splinters: long, tumbling, pale on the fresh face.
    for (let i = 0; i < Math.round(11 * scale * q); i++) {
      this._cone(n, 0.85, this._v3);
      const sp = 2.2 + Math.random() * 6.0;
      o.x = pt.x + n.x * 0.02; o.y = pt.y + n.y * 0.02; o.z = pt.z + n.z * 0.02;
      o.vx = this._v3.x * sp; o.vy = this._v3.y * sp + 0.9; o.vz = this._v3.z * sp;
      o.kind = K.CHIP;
      o.tile = P.SLIVER;
      o.life = 0.7 + Math.random() * 1.1;
      o.size = 0.020 + Math.random() * 0.032;
      o.endSize = o.size;
      o.alpha = 0.95;
      o.r = 0.60; o.g = 0.475; o.b = 0.305;
      o.r2 = 0.40; o.g2 = 0.315; o.b2 = 0.205;
      o.fadeIn = 0.006; o.fadeExp = 0.8;
      o.rot = Math.random() * 6.28; o.rotv = (Math.random() - 0.5) * 26;
      o.drag = 1.1; o.gravity = -11.5;
      o.stretch = 0.35;
      lit.spawn(o);
    }

    // Warm sawdust haze.
    for (let i = 0; i < Math.round(7 * scale * q); i++) {
      this._cone(n, 0.9, this._v3);
      const sp = 0.6 + Math.random() * 2.4;
      o.x = pt.x + n.x * 0.03; o.y = pt.y + n.y * 0.03; o.z = pt.z + n.z * 0.03;
      o.vx = this._v3.x * sp; o.vy = this._v3.y * sp + 0.4; o.vz = this._v3.z * sp;
      o.kind = K.SMOKE;
      o.tile = i % 2 ? P.PUFF_B : P.WISP;
      o.life = 0.7 + Math.random() * 1.3;
      o.size = 0.04; o.endSize = 0.30 + Math.random() * 0.28;
      o.alpha = 0.25;
      o.r = 0.65; o.g = 0.535; o.b = 0.385;
      o.r2 = 0.48; o.g2 = 0.41; o.b2 = 0.31;
      o.fadeIn = 0.03; o.fadeExp = 1.8;
      o.rot = Math.random() * 6.28; o.rotv = (Math.random() - 0.5) * 2.4;
      o.drag = 2.6; o.gravity = -0.7;
      o.stretch = 0;
      lit.spawn(o);
    }

    this._surfaceFlash(pt, n, add, 0.12 * scale, 0.85, 0.62, 0.36, 0.5);
    this._debris(pt, n, 4, 'wood', 3.0);
    this._impactDecal(pt, n, 'bullet_wood', 0.115 + Math.random() * 0.05);
  }

  _impactDirt(pt, n, scale) {
    const lit = this.batches.lit;
    const o = this._reset();
    const q = this.quality;

    // Soft, slow, wide. A puff, not a burst.
    for (let i = 0; i < Math.round(14 * scale * q); i++) {
      this._cone(n, 1.0, this._v3);
      const sp = 0.6 + Math.random() * 3.0 * scale;
      o.x = pt.x + n.x * 0.03; o.y = pt.y + n.y * 0.03; o.z = pt.z + n.z * 0.03;
      o.vx = this._v3.x * sp; o.vy = this._v3.y * sp + 0.7; o.vz = this._v3.z * sp;
      o.kind = K.SMOKE;
      o.tile = i % 3 === 0 ? P.DENSE : (i % 3 === 1 ? P.PUFF_A : P.PUFF_B);
      o.life = 1.3 + Math.random() * 2.2;
      o.size = 0.06 + Math.random() * 0.07;
      o.endSize = o.size * (5.5 + Math.random() * 5.0);
      o.alpha = 0.27 + Math.random() * 0.20;
      o.r = 0.52; o.g = 0.435; o.b = 0.325;
      o.r2 = 0.40; o.g2 = 0.345; o.b2 = 0.265;
      o.fadeIn = 0.05; o.fadeExp = 2.1;
      o.rot = Math.random() * 6.28; o.rotv = (Math.random() - 0.5) * 1.6;
      o.drag = 3.0; o.gravity = -0.55;
      o.stretch = 0;
      lit.spawn(o);
    }

    // Clods.
    for (let i = 0; i < Math.round(5 * scale * q); i++) {
      this._cone(n, 0.7, this._v3);
      const sp = 2.0 + Math.random() * 4.5;
      o.x = pt.x; o.y = pt.y; o.z = pt.z;
      o.vx = this._v3.x * sp; o.vy = this._v3.y * sp + 1.4; o.vz = this._v3.z * sp;
      o.kind = K.CHIP;
      o.tile = P.PUFF_B;
      o.life = 0.6 + Math.random() * 0.6;
      o.size = 0.018 + Math.random() * 0.02; o.endSize = o.size * 0.8;
      o.alpha = 0.9;
      o.r = 0.30; o.g = 0.245; o.b = 0.175;
      o.r2 = 0.24; o.g2 = 0.20; o.b2 = 0.145;
      o.fadeIn = 0.005; o.fadeExp = 0.7;
      o.rot = Math.random() * 6.28; o.rotv = (Math.random() - 0.5) * 14;
      o.drag = 0.6; o.gravity = -13.0;
      lit.spawn(o);
    }

    this._debris(pt, n, 3, 'dirt', 2.4);
    this._impactDecal(pt, n, 'dirt_crater', 0.20 + Math.random() * 0.10);
  }

  _impactGlass(pt, n, scale) {
    const lit = this.batches.lit, add = this.batches.additive;
    const o = this._reset();
    const q = this.quality;

    // Bright specular glints as shards tumble through the light.
    for (let i = 0; i < Math.round(16 * scale * q); i++) {
      this._cone(n, 1.1, this._v3);
      const sp = 2.4 + Math.random() * 7.0;
      o.x = pt.x + n.x * 0.02; o.y = pt.y + n.y * 0.02; o.z = pt.z + n.z * 0.02;
      o.vx = this._v3.x * sp; o.vy = this._v3.y * sp + 0.7; o.vz = this._v3.z * sp;
      o.kind = K.SPARK;
      o.tile = P.SPARKLE;
      o.life = 0.5 + Math.random() * 0.9;
      o.size = 0.020 + Math.random() * 0.022; o.endSize = o.size * 0.7;
      o.alpha = 0.85;
      o.r = 0.80; o.g = 0.90; o.b = 1.0;
      o.r2 = 0.55; o.g2 = 0.66; o.b2 = 0.78;
      o.emissive = 1.4; o.endEmissive = 0.22;
      o.fadeIn = 0.004; o.fadeExp = 1.0;
      o.drag = 0.55; o.gravity = -11.0;
      o.stretch = 0.3;
      add.spawn(o);
    }

    // Fine powdered glass.
    for (let i = 0; i < Math.round(6 * scale * q); i++) {
      this._cone(n, 0.9, this._v3);
      const sp = 1.0 + Math.random() * 2.2;
      o.x = pt.x; o.y = pt.y; o.z = pt.z;
      o.vx = this._v3.x * sp; o.vy = this._v3.y * sp; o.vz = this._v3.z * sp;
      o.kind = K.SMOKE;
      o.tile = P.WISP;
      o.life = 0.5 + Math.random() * 0.8;
      o.size = 0.03; o.endSize = 0.22;
      o.alpha = 0.18;
      o.r = 0.70; o.g = 0.75; o.b = 0.80;
      o.r2 = 0.55; o.g2 = 0.60; o.b2 = 0.66;
      o.emissive = 1; o.endEmissive = 1;   // the sparkle loop above left this hot
      o.fadeIn = 0.02; o.fadeExp = 1.7;
      o.rot = Math.random() * 6.28; o.rotv = (Math.random() - 0.5) * 3;
      o.drag = 2.4; o.gravity = -1.2;
      o.stretch = 0;
      lit.spawn(o);
    }

    this._debris(pt, n, 6, 'glass', 3.4);
    this._impactDecal(pt, n, 'glass_crack', 0.26 + Math.random() * 0.14);
  }

  _impactFabric(pt, n, scale) {
    const lit = this.batches.lit;
    const o = this._reset();
    const q = this.quality;
    for (let i = 0; i < Math.round(12 * scale * q); i++) {
      this._cone(n, 0.95, this._v3);
      const sp = 0.8 + Math.random() * 3.0;
      o.x = pt.x + n.x * 0.03; o.y = pt.y + n.y * 0.03; o.z = pt.z + n.z * 0.03;
      o.vx = this._v3.x * sp; o.vy = this._v3.y * sp + 0.4; o.vz = this._v3.z * sp;
      o.kind = K.SMOKE;
      o.tile = i % 2 ? P.PUFF_A : P.DENSE;
      o.life = 0.9 + Math.random() * 1.4;
      o.size = 0.05; o.endSize = 0.34 + Math.random() * 0.3;
      o.alpha = 0.28;
      o.r = 0.56; o.g = 0.49; o.b = 0.375;
      o.r2 = 0.44; o.g2 = 0.39; o.b2 = 0.30;
      o.fadeIn = 0.04; o.fadeExp = 2.0;
      o.rot = Math.random() * 6.28; o.rotv = (Math.random() - 0.5) * 1.8;
      o.drag = 3.2; o.gravity = -0.9;
      o.stretch = 0;
      lit.spawn(o);
    }
    this._debris(pt, n, 2, 'fabric', 2.0);
    this._impactDecal(pt, n, 'fabric_hit', 0.13 + Math.random() * 0.05);
  }

  _impactRubber(pt, n, scale) {
    const lit = this.batches.lit;
    const o = this._reset();
    for (let i = 0; i < Math.round(7 * scale * this.quality); i++) {
      this._cone(n, 0.8, this._v3);
      const sp = 0.7 + Math.random() * 2.2;
      o.x = pt.x + n.x * 0.03; o.y = pt.y + n.y * 0.03; o.z = pt.z + n.z * 0.03;
      o.vx = this._v3.x * sp; o.vy = this._v3.y * sp + 0.5; o.vz = this._v3.z * sp;
      o.kind = K.SMOKE;
      o.tile = P.SOOT;
      o.life = 0.8 + Math.random() * 1.2;
      o.size = 0.04; o.endSize = 0.30;
      o.alpha = 0.28;
      o.r = 0.28; o.g = 0.27; o.b = 0.26;
      o.r2 = 0.20; o.g2 = 0.195; o.b2 = 0.19;
      o.fadeIn = 0.03; o.fadeExp = 1.8;
      o.rot = Math.random() * 6.28; o.rotv = (Math.random() - 0.5) * 2;
      o.drag = 2.8; o.gravity = -0.4;
      o.stretch = 0;
      lit.spawn(o);
    }
    this._impactDecal(pt, n, 'scorch', 0.14 + Math.random() * 0.06);
  }

  /* ── shared impact helpers ────────────────────────────────────────────── */

  /** A brief additive pool glued to the surface — the impact's own light. */
  _surfaceFlash(pt, n, batch, size, r, g, b, gain) {
    if (!batch) return;
    const o = this._reset();
    o.x = pt.x + n.x * 0.006; o.y = pt.y + n.y * 0.006; o.z = pt.z + n.z * 0.006;
    o.kind = K.ORIENTED;
    o.tile = P.POOL;
    o.life = 0.055 + Math.random() * 0.045;
    o.size = size * 0.7; o.endSize = size * 1.9;
    o.alpha = 0.9;
    o.r = r; o.g = g; o.b = b;
    o.r2 = r * 0.8; o.g2 = g * 0.55; o.b2 = b * 0.35;
    o.emissive = gain; o.endEmissive = 0.1;
    o.fadeIn = 0.002; o.fadeExp = 1.6;
    o.rot = Math.random() * 6.28; o.rotv = 0;
    o.nx = n.x; o.ny = n.y; o.nz = n.z;
    o.drag = 0; o.gravity = 0; o.stretch = 0;
    batch.spawn(o);
  }

  _debris(pt, n, count, family, speed) {
    const phys = this.ctx.physics;
    if (!phys || typeof phys.spawnDebris !== 'function') return 0;
    try {
      const c = Math.max(1, Math.round(count * this.quality));
      return phys.spawnDebris(pt, n, c, DEBRIS_MAT[family] ?? 'concrete',
        { speed, spread: 0.8, life: 11 });
    } catch { return 0; }
  }

  _impactDecal(pt, n, type, size) {
    this.addDecal(pt, n, size, type);
  }

  _decalSpec(type) {
    const rnd = Math.random() < 0.5;
    switch (type) {
      case 'bullet_metal':
        return { tile: rnd ? D.HOLE_METAL_A : D.HOLE_METAL_B, opts: { life: 90, fade: 8 } };
      case 'bullet_wood':
        return { tile: rnd ? D.HOLE_WOOD_A : D.HOLE_WOOD_B, opts: { life: 90, fade: 8 } };
      case 'bullet_plaster':
        return { tile: D.HOLE_PLASTER, opts: { life: 90, fade: 8 } };
      case 'glass_crack':
        return { tile: D.GLASS_CRACK, opts: { life: 240, fade: 10, depth: 0.06 } };
      case 'dirt_crater':
        return { tile: D.DIRT_CRATER, opts: { life: 55, fade: 8 } };
      case 'fabric_hit':
        return { tile: D.FABRIC_HIT, opts: { life: 120, fade: 8 } };
      case 'scorch':
        return { tile: D.SCORCH, opts: { life: 60, fade: 8 } };
      case 'soot':
        return { tile: D.SOOT_SMUDGE, opts: { life: 45, fade: 8 } };
      case 'gouge':
        return { tile: D.GOUGE, opts: { life: 60, fade: 8 } };
      case 'blood':
        return { tile: rnd ? D.BLOOD_A : D.BLOOD_B, opts: { life: 42, fade: 9 } };
      case 'blood_pool':
        return { tile: D.BLOOD_POOL, opts: { life: 50, fade: 10 } };
      case 'bullet':
      case 'bullet_concrete':
      default:
        return { tile: rnd ? D.HOLE_CONCRETE_A : D.HOLE_CONCRETE_B, opts: { life: 90, fade: 8 } };
    }
  }

  _bloodGroundMark(point) {
    const phys = this.ctx.physics;
    if (!phys || typeof phys.raycast !== 'function') return;
    try {
      const hit = phys.raycast(point, this._v2.set(0, -1, 0), 3.2, { reuse: true });
      if (!hit || hit.normal.y < 0.6) return;
      this._v3.copy(hit.point);
      this._v4.copy(hit.normal);
      this.addDecal(this._v3, this._v4, 0.22 + Math.random() * 0.20, 'blood');
    } catch { /* no ground under the hit — nothing to mark */ }
  }

  /* ── muzzle helpers ───────────────────────────────────────────────────── */

  _muzzleSmoke(pos, dir, s) {
    const lit = this.batches.lit;
    if (!lit) return;
    const o = this._reset();
    const n = Math.round(4 * this.quality);
    for (let i = 0; i < n; i++) {
      const along = 0.05 + Math.random() * 0.32 * s;
      o.x = pos.x + dir.x * along + (Math.random() - 0.5) * 0.05;
      o.y = pos.y + dir.y * along + (Math.random() - 0.5) * 0.05;
      o.z = pos.z + dir.z * along + (Math.random() - 0.5) * 0.05;
      const sp = 0.9 + Math.random() * 1.6;
      o.vx = dir.x * sp + (Math.random() - 0.5) * 0.35;
      o.vy = dir.y * sp + 0.35 + Math.random() * 0.3;
      o.vz = dir.z * sp + (Math.random() - 0.5) * 0.35;
      o.kind = K.SMOKE;
      o.tile = i % 2 ? P.WISP : P.PUFF_A;
      o.life = 0.85 + Math.random() * 1.5;
      o.size = 0.045 * s; o.endSize = (0.32 + Math.random() * 0.35) * s;
      o.alpha = 0.15 + Math.random() * 0.11;
      o.r = 0.56; o.g = 0.555; o.b = 0.55;
      o.r2 = 0.44; o.g2 = 0.44; o.b2 = 0.45;
      o.fadeIn = 0.035; o.fadeExp = 1.8;
      o.rot = Math.random() * 6.28; o.rotv = (Math.random() - 0.5) * 2.6;
      o.drag = 2.5; o.gravity = 0.10;
      o.stretch = 0.08;
      lit.spawn(o);
    }
  }

  _flashBounce(pos, dir, s) {
    const phys = this.ctx.physics;
    const add = this.batches.additive;
    if (!phys || !add || typeof phys.raycast !== 'function') return;
    try {
      const hit = phys.raycast(pos, dir, 3.0, { reuse: true });
      if (!hit) return;
      const d = hit.distance;
      const falloff = Math.max(0, 1 - d / 3.0);
      if (falloff < 0.06) return;
      this._surfaceFlash(hit.point, hit.normal, add,
        (0.55 + d * 0.5) * s, 1.0, 0.74, 0.44, 1.0 * falloff * falloff);
    } catch { /* nothing in front of the muzzle */ }
  }

  /** Best-effort world muzzle position when only a viewmodel matrix exists. */
  _muzzleWorldGuess(out) {
    const cam = this.ctx.camera;
    out.copy(cam.position);
    this._forward(this._v2);
    out.addScaledVector(this._v2, 0.62);
    out.y -= 0.10;
    return out;
  }

  _forward(out) {
    const e = this.ctx.camera.matrixWorld.elements;
    return out.set(-e[8], -e[9], -e[10]).normalize();
  }

  _onWeaponFire(p) {
    if (!this.ok || !this.enabled || !p) return;
    try {
      const origin = p.origin;
      const dir = p.dir;
      if (!origin || !dir) return;

      // If the weapon system drove the flash itself, do not double up.
      if (this._elapsed - this._lastMuzzle > 0.035) {
        this._v3.copy(origin).addScaledVector(dir, 0.62);
        // Offset toward where a rifle muzzle actually sits, not the eye.
        this._v4.set(0, 1, 0).cross(dir);
        if (this._v4.lengthSq() > 1e-6) {
          this._v4.normalize();
          this._v3.addScaledVector(this._v4, 0.10);
        }
        this._v3.y -= 0.13;
        this.spawnMuzzleFlash(this._v3, 1.0, { space: 'world', dir, smoke: true });
      }

      /**
       * The weapon system calls `spawnTracer()` directly with the real muzzle
       * transform and then emits `weapon:fire` in the same frame. Without this
       * guard we spawned a SECOND tracer from an eye-relative guess — different
       * origin, different speed, therefore a different length — so every player
       * shot drew two near-parallel streaks. That is the "second segment at
       * x≈900-1120 with no emitter" the critics logged, and it is the same class
       * of double-drive the `_lastMuzzle` check already prevents for the flash.
       * This path is a fallback for callers that only emit the event.
       */
      if (this._elapsed - this._lastTracer > 0.05) {
        const phys = this.ctx.physics;
        let end = null;
        if (phys && typeof phys.raycast === 'function') {
          try {
            const hit = phys.raycast(origin, dir, 220, { reuse: true });
            if (hit) end = this._v2.copy(hit.point);
          } catch { end = null; }
        }
        if (!end) end = this._v2.copy(origin).addScaledVector(dir, 120);
        this._v3.copy(origin).addScaledVector(dir, 0.55);
        this.spawnTracer(this._v3, end, 620);
      }
    } catch (err) {
      if (!this._loggedFire) { this._loggedFire = true; console.warn('[fx] weapon:fire:', err); }
    }
  }

  /* ── math helpers ─────────────────────────────────────────────────────── */

  _reset() {
    const o = this._o;
    o.x = o.y = o.z = 0;
    o.vx = o.vy = o.vz = 0;
    o.kind = K.SMOKE; o.tile = 0;
    o.life = 1; o.size = 0.1; o.endSize = 0.1;
    o.rot = 0; o.rotv = 0;
    o.r = 1; o.g = 1; o.b = 1;
    o.r2 = 1; o.g2 = 1; o.b2 = 1;
    o.alpha = 1; o.fadeIn = 0.03; o.fadeExp = 1.6;
    o.drag = 0.6; o.gravity = 0;
    o.stretch = 0; o.bounce = 0;
    o.nx = 0; o.ny = 1; o.nz = 0; o.planeD = -1e9;
    o.emissive = 1; o.endEmissive = 1;
    o.turbulence = 0; o.seed = Math.random() * 1000;
    o.sunVis = this._sunVis;
    return o;
  }

  /**
   * How much direct sun reaches a point — one ray per burst, not per particle.
   *
   * Without this, dust thrown off a wall that is deep in shadow still picks up
   * the warm key light and reads as a glowing orange smudge pasted onto a cool
   * surface. It is the single cheapest thing that makes particles look like
   * they belong in the scene.
   */
  _sampleSunVis(point) {
    const phys = this.ctx.physics;
    if (!phys || typeof phys.raycast !== 'function') return 1;
    try {
      const hit = phys.raycast(point, this._sunDirWorld, 26, { reuse: true });
      return hit ? 0.26 : 1.0;
    } catch { return 1; }
  }

  /** Build a tangent frame around `n` into `_tan` / `_bit`. */
  _basis(n) {
    if (Math.abs(n.y) > 0.92) this._tan.set(1, 0, 0);
    else this._tan.set(0, 1, 0);
    this._tan.crossVectors(this._tan, n).normalize();
    this._bit.crossVectors(n, this._tan).normalize();
  }

  /** Random unit vector inside a cone of half-spread `spread` around `axis`. */
  _cone(axis, spread, out) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    out.copy(axis)
      .addScaledVector(this._tan, Math.cos(a) * r)
      .addScaledVector(this._bit, Math.sin(a) * r)
      .normalize();
    return out;
  }

  /* ── frame ────────────────────────────────────────────────────────────── */

  update(dt, elapsed) {
    if (!this.ok) return;
    this._elapsed = elapsed;
    this._impactsThisFrame = 0;
    if (!this.enabled) return;

    this._adaptQuality(dt);

    try {
      const cam = this.ctx.camera;
      cam.updateMatrixWorld();
      cam.getWorldPosition(this._camPos);
      this._viewM.copy(cam.matrixWorld).invert();

      this._updateLighting(cam);
      this._bindDepth(cam);

      const vm = this._viewM;
      this.batches.lit.update(dt, elapsed, vm);
      this.batches.additive.update(dt, elapsed, vm);
      this.batches.vm.update(dt, elapsed, null);
      if (this.tracers) {
        this.tracers.setCamera(cam, this.ctx.renderer?.domElement?.height);
        this.tracers.update(dt, elapsed);
      }

      this.decals?.update(dt);
      this.ambient?.update(dt, elapsed, this._camPos);
    } catch (err) {
      if (!this._loggedUpdate) {
        this._loggedUpdate = true;
        console.error('[fx] update failed (suppressing further reports):', err);
      }
    }
  }

  /**
   * Shed particle count when the frame slips, restore it when there is
   * headroom. Wide hysteresis: an oscillating budget reads on screen as bursts
   * of density change, which is more distracting than a slightly thinner burst.
   */
  _adaptQuality(dt) {
    if (dt <= 0 || dt > 0.2) return;           // ignore hitches and alt-tabs
    this._msAvg = this._msAvg * 0.96 + dt * 1000 * 0.04;
    if (this._qualityCooldown > 0) { this._qualityCooldown--; return; }
    // Only shed if the FX layer is plausibly the thing costing the time. A
    // scene that is slow for unrelated reasons must not silently starve the
    // effects — that would make FX quality a function of someone else's bugs.
    const load = this.batches.lit.count + this.batches.additive.count * 0.3;
    let q = this.quality;
    if (this._msAvg > 17.5 && load > 280 && q > 0.45) q = Math.max(0.45, q - 0.25);
    else if ((this._msAvg < 13.0 || load < 150) && q < 1.0) q = Math.min(1.0, q + 0.25);
    if (q !== this.quality) {
      this.quality = q;
      this._impactBudget = q < 0.7 ? 4 : 6;
      this._qualityCooldown = 90;
      this._msAvg = 13.0;
    }
  }

  _updateLighting(cam) {
    const l = this.ctx.lighting;
    const sun = l && l.sun;
    if (sun && sun.isLight) {
      this._sunDirWorld.copy(sun.position);
      if (sun.target) this._sunDirWorld.sub(sun.target.position);
      if (this._sunDirWorld.lengthSq() < 1e-8) this._sunDirWorld.set(0.3, 0.6, 0.5);
      this._sunDirWorld.normalize();
      // Radiance, not irradiance: the shader's phase terms carry the angular
      // distribution, so divide out pi the same way the standard BRDF does or
      // smoke sits three times brighter than the ground it is floating over.
      const k = Math.min(14, sun.intensity ?? 7.6) / Math.PI * 0.30;
      this._sunCol.set(sun.color.r * k, sun.color.g * k, sun.color.b * k);
    }
    this._sunDirView.copy(this._sunDirWorld).transformDirection(this._viewM).normalize();
    this._upView.set(0, 1, 0).transformDirection(this._viewM).normalize();

    // Ambient: the horizon colour is the honest answer — it is exactly the
    // radiance the haze surrounding the particle is already carrying.
    const fog = this.ctx.scene.fog;
    if (fog && fog.color) {
      const c = fog.color;
      // Floor the ambient. The horizon colour goes very dark at this time of
      // day, and without a floor every particle in shadow collapses to black —
      // which is wrong: fine airborne dust is lit by the whole sky dome, not
      // by the small patch of horizon behind it.
      const F = 0.052;
      this._skyCol.set(
        Math.max(c.r * 0.55, F), Math.max(c.g * 0.55, F * 1.04), Math.max(c.b * 0.55, F * 1.12));
      this._gndCol.set(
        Math.max(c.r * 0.17, F * 0.42), Math.max(c.g * 0.15, F * 0.38), Math.max(c.b * 0.13, F * 0.33));
    }

    this.batches.lit.setLighting(
      this._sunDirView, this._sunCol, this._skyCol, this._gndCol, this._upView);
  }

  _bindDepth(cam) {
    const r = this.ctx.render;
    let tex = null, iw = 0, ih = 0;
    try {
      if (r && r.ok && r.gbuffer && r.gbuffer.target) {
        tex = r.gbuffer.depthTexture;
        iw = r.gbuffer.target.width;
        ih = r.gbuffer.target.height;
      }
    } catch { tex = null; }
    if (tex && iw > 1 && ih > 1) {
      this.batches.lit.setDepth(tex, 1 / iw, 1 / ih, cam.near, cam.far);
      this.batches.additive.setDepth(tex, 1 / iw, 1 / ih, cam.near, cam.far);
      this.tracers?.setDepth(tex, 1 / iw, 1 / ih, cam.near, cam.far);
    } else {
      this.batches.lit.setDepth(null);
      this.batches.additive.setDepth(null);
      this.tracers?.setDepth(null);
    }
  }

  /* ── diagnostics ──────────────────────────────────────────────────────── */

  debugInfo() {
    return {
      ok: this.ok,
      lit: this.batches.lit?.count ?? 0,
      additive: this.batches.additive?.count ?? 0,
      viewmodel: this.batches.vm?.count ?? 0,
      tracers: this.tracers?.count ?? 0,
      decals: this.decals?.count ?? 0,
      decalsProjected: this.decals?.projected ?? 0,
      decalsFlat: this.decals?.flat ?? 0,
      soft: this.batches.lit?.material.uniforms.uSoftEnabled.value ?? 0,
      quality: this.quality,
      msAvg: Math.round(this._msAvg * 100) / 100,
      litter: this.ambient?.litter ? this.ambient.litter.count : 0,
      litterPlaced: this.ambient?._litterState
        ? this.ambient._litterState.filter((s) => s.placed).length : 0,
      emberSources: this.ambient?.emberSources.length ?? 0,
      stats: this.stats,
    };
  }

  clear() {
    try {
      this.batches.lit?.clear();
      this.batches.additive?.clear();
      this.batches.vm?.clear();
      this.tracers?.clear();
      this.decals?.clear();
      if (this.ambient) this.ambient._seeded = false;
    } catch { /* noop */ }
  }

  dispose() {
    for (const off of this._unsubs) { try { off(); } catch { /* noop */ } }
    this._unsubs.length = 0;
    try { this.batches.lit?.dispose(); } catch { /* noop */ }
    try { this.batches.additive?.dispose(); } catch { /* noop */ }
    try { this.batches.vm?.dispose(); } catch { /* noop */ }
    try { this.tracers?.dispose(); } catch { /* noop */ }
    try { this.decals?.dispose(); } catch { /* noop */ }
    try { this.ambient?.dispose(); } catch { /* noop */ }
    if (typeof window !== 'undefined' && window.__FX__ === this) delete window.__FX__;
  }
}

export default FXSystem;
