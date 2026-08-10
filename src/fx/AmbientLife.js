import * as THREE from 'three';
import { K } from './ParticleBatch.js';
import { P } from './textures.js';

/**
 * Ambient life.
 *
 * A completely static world reads as a diorama no matter how good the lighting
 * is. Three layers, all cheap:
 *
 *   1. dust motes  — a wrapping volume of slow brownian specks that follows the
 *                    camera. They are the single highest-value-per-instruction
 *                    effect in the whole system: they give the heavy dusk haze
 *                    something to *be*, and they read as depth cueing because
 *                    near ones move fast across frame and far ones barely move.
 *   2. ground drift — very large, very faint dust sheets crossing the low
 *                    ground on the wind. Sells air movement at mid distance.
 *   3. litter      — a handful of paper scraps resting on the ground that
 *                    periodically get stirred, flutter and settle again. Opaque
 *                    and alpha-tested so they are in the G-buffer, get AO and
 *                    do not shimmer.
 *   4. embers      — registered per fire source by the level, plus autodetect
 *                    of anything in the scene named like a fire.
 *
 * OWNER: fx
 */

const MOTE_COUNT = 340;
const MOTE_BOX = 17.0;         // half-extent of the wrapping volume, metres
const LITTER_COUNT = 16;

export class AmbientLife {
  constructor(ctx, batches) {
    this.ctx = ctx;
    this.additive = batches.additive;
    this.lit = batches.lit;

    this.moteSlots = new Int32Array(MOTE_COUNT).fill(-1);
    this.moteCentre = new THREE.Vector3();
    this._seeded = false;

    this.emberSources = [];
    this._emberAcc = 0;
    this._driftAcc = 0;
    this._autoScanned = false;

    this.litter = null;
    this._litterState = null;
    this._litterReady = false;
    this._litterProbeAt = 1.8;

    this._wind = new THREE.Vector3(0.55, 0, -0.30);
    this._tmp = new THREE.Vector3();
    this._o = {};
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3(1, 1, 1);
  }

  /* ── dust motes ───────────────────────────────────────────────────────── */

  _seedMotes(centre) {
    const o = this._o;
    for (let i = 0; i < MOTE_COUNT; i++) {
      if (this.moteSlots[i] >= 0) continue;
      o.x = centre.x + (Math.random() - 0.5) * 2 * MOTE_BOX;
      o.y = centre.y + (Math.random() - 0.5) * 2 * MOTE_BOX * 0.55 + 1.0;
      o.z = centre.z + (Math.random() - 0.5) * 2 * MOTE_BOX;
      o.vx = 0; o.vy = 0; o.vz = 0;
      o.kind = K.MOTE;
      o.tile = P.MOTE;
      o.life = 1e6;
      o.size = 0.020 + Math.random() * 0.034;
      o.endSize = o.size;
      // Deliberately dim. Bright specks with no TAA behind them crawl; these
      // must read as *catching* the light, not as emitting it.
      o.alpha = 0.16 + Math.random() * 0.30;
      o.r = 1.0; o.g = 0.90; o.b = 0.74;
      o.r2 = 1.0; o.g2 = 0.90; o.b2 = 0.74;
      o.emissive = 0.55 + Math.random() * 0.85;
      o.endEmissive = o.emissive;
      o.fadeIn = 0.001;
      o.fadeExp = 0;
      o.rot = Math.random() * 6.28;
      o.rotv = 0;
      o.drag = 0; o.gravity = 0; o.stretch = 0;
      o.bounce = 0; o.turbulence = 0;
      o.nx = 0; o.ny = 1; o.nz = 0;
      o.seed = Math.random();
      this.moteSlots[i] = this.additive.spawn(o);
    }
  }

  /**
   * Toroidal wrap of the mote volume around the camera.
   *
   * Modulo rather than a single-step nudge on purpose: a respawn teleports the
   * camera tens of metres in one frame, and a step-wrap would leave the whole
   * cloud trailing behind for several seconds before it caught up.
   */
  _wrapMotes(centre) {
    const b = this.additive;
    const ex = MOTE_BOX, ey = MOTE_BOX * 0.55, ez = MOTE_BOX;
    const cy = centre.y + 1.0;
    for (let i = 0; i < MOTE_COUNT; i++) {
      const s = this.moteSlots[i];
      if (s < 0 || !b.alive[s]) { this.moteSlots[i] = -1; continue; }
      const dx = b.px[s] - centre.x;
      const dy = b.py[s] - cy;
      const dz = b.pz[s] - centre.z;
      if (dx >= -ex && dx <= ex && dy >= -ey && dy <= ey && dz >= -ez && dz <= ez) continue;
      const wx = ((dx + ex) % (2 * ex) + 2 * ex) % (2 * ex) - ex;
      const wy = ((dy + ey) % (2 * ey) + 2 * ey) % (2 * ey) - ey;
      const wz = ((dz + ez) % (2 * ez) + 2 * ez) % (2 * ez) - ez;
      b.px[s] = centre.x + wx;
      b.py[s] = cy + wy;
      b.pz[s] = centre.z + wz;
      // Teleporting the position must teleport the trail too, or the stretched
      // billboard smears a streak right across the frame for one frame.
      b.ox[s] = b.px[s]; b.oy[s] = b.py[s]; b.oz[s] = b.pz[s];
    }
  }

  /* ── ground dust drift ────────────────────────────────────────────────── */

  _spawnDrift(centre, elapsed) {
    const o = this._o;
    const ang = Math.random() * Math.PI * 2;
    const dist = 7 + Math.random() * 12;
    o.x = centre.x + Math.cos(ang) * dist;
    o.y = 0.20 + Math.random() * 0.75;
    o.z = centre.z + Math.sin(ang) * dist;
    const w = this._wind;
    o.vx = w.x * (0.6 + Math.random() * 0.9);
    o.vy = 0.03 + Math.random() * 0.06;
    o.vz = w.z * (0.6 + Math.random() * 0.9);
    o.kind = K.SMOKE;
    o.tile = Math.random() < 0.5 ? P.WISP : P.PUFF_B;
    o.life = 7.5 + Math.random() * 5.0;
    o.size = 1.4 + Math.random() * 1.6;
    o.endSize = o.size * (2.0 + Math.random());
    o.alpha = 0.030 + Math.random() * 0.030;
    o.r = 0.72; o.g = 0.68; o.b = 0.61;
    o.r2 = 0.66; o.g2 = 0.63; o.b2 = 0.58;
    o.emissive = 1; o.endEmissive = 1;
    o.fadeIn = 2.2;
    o.fadeExp = 1.5;
    o.rot = Math.random() * 6.28;
    o.rotv = (Math.random() - 0.5) * 0.08;
    o.drag = 0.16; o.gravity = -0.012;
    o.stretch = 0; o.bounce = 0; o.turbulence = 0.012;
    o.nx = 0; o.ny = 1; o.nz = 0;
    o.seed = elapsed;
    this.lit.spawn(o);
  }

  /* ── embers ───────────────────────────────────────────────────────────── */

  /** Register a fire. Returns a handle the caller can pass to removeEmberSource. */
  addEmberSource(position, opts = {}) {
    const src = {
      pos: position.isVector3 ? position.clone() : new THREE.Vector3().fromArray(position ?? [0, 0, 0]),
      radius: opts.radius ?? 0.4,
      rate: opts.rate ?? 7,
      smoke: opts.smoke !== false,
      acc: Math.random(),
    };
    this.emberSources.push(src);
    return src;
  }

  removeEmberSource(handle) {
    const i = this.emberSources.indexOf(handle);
    if (i >= 0) this.emberSources.splice(i, 1);
  }

  /** One-shot sweep for level geometry that names itself as a fire. */
  _autoScan() {
    this._autoScanned = true;
    const scene = this.ctx.scene;
    if (!scene) return;
    const re = /(fire|brazier|burn|ember|flame|campfire)/i;
    const found = [];
    try {
      scene.traverse((o) => {
        if (found.length >= 8) return;
        if (!o.isObject3D) return;
        const tag = `${o.name || ''} ${o.userData?.fx || ''}`;
        if (o.userData?.fire === true || re.test(tag)) found.push(o);
      });
    } catch { /* traversal is best-effort */ }
    for (const o of found) {
      try {
        o.getWorldPosition(this._tmp);
        this.addEmberSource(this._tmp, { radius: 0.35, rate: 8 });
      } catch { /* skip */ }
    }
    // The level agent can also publish an explicit list.
    const list = this.ctx.level?.fires ?? this.ctx.level?.emberSources ?? null;
    if (Array.isArray(list)) {
      for (const f of list) {
        const p = f?.isVector3 ? f : f?.position;
        if (p) this.addEmberSource(p, { radius: f.radius ?? 0.4, rate: f.rate ?? 8 });
      }
    }
  }

  _emitEmbers(dt, elapsed, camPos) {
    const o = this._o;
    for (const src of this.emberSources) {
      const d2 = src.pos.distanceToSquared(camPos);
      if (d2 > 60 * 60) continue;
      const rate = src.rate * (d2 > 30 * 30 ? 0.35 : 1);
      src.acc += dt * rate;
      let n = Math.floor(src.acc);
      if (n > 4) n = 4;
      src.acc -= n;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * src.radius;
        o.x = src.pos.x + Math.cos(a) * r;
        o.y = src.pos.y + Math.random() * 0.16;
        o.z = src.pos.z + Math.sin(a) * r;
        o.vx = (Math.random() - 0.5) * 0.35 + this._wind.x * 0.25;
        o.vy = 0.85 + Math.random() * 1.5;
        o.vz = (Math.random() - 0.5) * 0.35 + this._wind.z * 0.25;
        o.kind = K.EMBER;
        o.tile = P.EMBER;
        o.life = 1.5 + Math.random() * 2.6;
        o.size = 0.016 + Math.random() * 0.022;
        o.endSize = o.size * 0.35;
        o.alpha = 0.85;
        o.r = 1.0; o.g = 0.52; o.b = 0.16;
        o.r2 = 0.72; o.g2 = 0.13; o.b2 = 0.03;
        o.emissive = 3.4 + Math.random() * 2.2;
        o.endEmissive = 0.25;
        o.fadeIn = 0.05;
        o.fadeExp = 1.1;
        o.rot = Math.random() * 6.28;
        o.rotv = 0;
        o.drag = 0.42; o.gravity = 0.55;   // hot gas: embers rise
        o.stretch = 0.6; o.bounce = 0;
        o.turbulence = 1.5;
        o.nx = 0; o.ny = 1; o.nz = 0;
        o.seed = Math.random() * 100;
        this.additive.spawn(o);
      }
      if (src.smoke && Math.random() < dt * 3.2) {
        o.x = src.pos.x + (Math.random() - 0.5) * src.radius;
        o.y = src.pos.y + 0.2;
        o.z = src.pos.z + (Math.random() - 0.5) * src.radius;
        o.vx = this._wind.x * 0.5; o.vy = 1.1 + Math.random() * 0.6; o.vz = this._wind.z * 0.5;
        o.kind = K.SMOKE;
        o.tile = Math.random() < 0.5 ? P.PUFF_A : P.DENSE;
        o.life = 3.4 + Math.random() * 2.6;
        o.size = 0.30; o.endSize = 1.9 + Math.random();
        o.alpha = 0.19;
        o.r = 0.26; o.g = 0.24; o.b = 0.22;
        o.r2 = 0.40; o.g2 = 0.38; o.b2 = 0.36;
        o.emissive = 1; o.endEmissive = 1;
        o.fadeIn = 0.5; o.fadeExp = 1.7;
        o.rot = Math.random() * 6.28; o.rotv = (Math.random() - 0.5) * 0.5;
        o.drag = 0.55; o.gravity = 0.30;
        o.stretch = 0; o.bounce = 0; o.turbulence = 0.30;
        o.nx = 0; o.ny = 1; o.nz = 0;
        o.seed = elapsed;
        this.lit.spawn(o);
      }
    }
  }

  /* ── paper litter ─────────────────────────────────────────────────────── */

  buildLitter(paperTexture, scene, registerMaterial) {
    try {
      const geo = new THREE.PlaneGeometry(0.16, 0.21, 3, 3);
      // Give the sheet a slight natural curl so it never reads as a flat card.
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        pos.setZ(i, (x * x * 0.9 + y * y * 0.35) * 0.28 - 0.004);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({
        map: paperTexture,
        color: 0xbfb9a8,
        roughness: 0.94,
        metalness: 0.0,
        alphaTest: 0.5,
        transparent: false,
        side: THREE.DoubleSide,
        dithering: true,
      });
      mat.name = 'fx:litter';
      if (registerMaterial) registerMaterial(mat);

      const mesh = new THREE.InstancedMesh(geo, mat, LITTER_COUNT);
      mesh.name = 'fx:litter';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData.noDecal = true;
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < LITTER_COUNT; i++) mesh.setMatrixAt(i, zero);
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      this.litter = mesh;

      this._litterState = new Array(LITTER_COUNT);
      for (let i = 0; i < LITTER_COUNT; i++) {
        this._litterState[i] = {
          placed: false,
          p: new THREE.Vector3(),
          rest: new THREE.Vector3(),
          v: new THREE.Vector3(),
          rot: new THREE.Vector3(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28),
          rotv: new THREE.Vector3(),
          air: 0,
          cool: 1 + Math.random() * 9,
          scale: 0.7 + Math.random() * 0.8,
        };
      }
    } catch (err) {
      console.warn('[fx] litter setup failed:', err);
      this.litter = null;
    }
  }

  _placeLitter(camPos) {
    const physics = this.ctx.physics;
    if (!physics || !physics.world || !this._litterState) return;
    const down = this._tmp.set(0, -1, 0);
    let placed = 0;
    for (let i = 0; i < LITTER_COUNT; i++) {
      const s = this._litterState[i];
      if (s.placed) { placed++; continue; }
      const ang = Math.random() * Math.PI * 2;
      const dist = 2.5 + Math.random() * 13;
      const ox = camPos.x + Math.cos(ang) * dist;
      const oz = camPos.z + Math.sin(ang) * dist;
      let hit = null;
      try {
        hit = physics.raycast({ x: ox, y: camPos.y + 3.5, z: oz }, down, 12, { reuse: true });
      } catch { hit = null; }
      if (!hit || hit.normal.y < 0.75) continue;
      s.rest.set(hit.point.x, hit.point.y + 0.006, hit.point.z);
      s.p.copy(s.rest);
      s.rot.set(-Math.PI / 2 + (Math.random() - 0.5) * 0.12, Math.random() * 6.28, 0);
      s.placed = true;
      placed++;
    }
    if (placed >= LITTER_COUNT) this._litterReady = true;
  }

  _updateLitter(dt, elapsed, camPos) {
    const mesh = this.litter;
    if (!mesh || !this._litterState) return;
    const m = this._m, q = this._q, e = this._e, sc = this._s;
    let dirty = false;
    for (let i = 0; i < LITTER_COUNT; i++) {
      const s = this._litterState[i];
      if (!s.placed) continue;

      if (s.air > 0) {
        s.air -= dt;
        s.v.y -= 5.2 * dt;
        // Aerodynamic flutter: a sheet of paper does not fall, it sails.
        const w = elapsed * 6.0 + i * 1.7;
        s.v.x += (Math.sin(w) * 0.9 + this._wind.x * 0.8) * dt;
        s.v.z += (Math.cos(w * 1.3) * 0.9 + this._wind.z * 0.8) * dt;
        s.v.y += (0.55 + 0.45 * Math.sin(w * 2.1)) * 3.4 * dt;
        s.v.multiplyScalar(Math.max(0, 1 - 2.4 * dt));
        s.p.addScaledVector(s.v, dt);
        s.rot.x += s.rotv.x * dt;
        s.rot.y += s.rotv.y * dt;
        s.rot.z += s.rotv.z * dt;
        if (s.p.y <= s.rest.y) {
          s.p.y = s.rest.y;
          s.air = 0;
          s.rest.x = s.p.x; s.rest.z = s.p.z;
          s.rot.set(-Math.PI / 2 + (Math.random() - 0.5) * 0.15, Math.random() * 6.28, 0);
          s.cool = 5 + Math.random() * 16;
        }
        dirty = true;
      } else {
        s.cool -= dt;
        const near = s.p.distanceToSquared(camPos) < 26 * 26;
        if (s.cool <= 0 && near) {
          s.cool = 6 + Math.random() * 18;
          s.air = 1.4 + Math.random() * 1.8;
          s.v.set(
            this._wind.x * (0.8 + Math.random()) + (Math.random() - 0.5) * 0.7,
            0.9 + Math.random() * 1.1,
            this._wind.z * (0.8 + Math.random()) + (Math.random() - 0.5) * 0.7,
          );
          s.rotv.set((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7);
          dirty = true;
        } else {
          // Resting sheets still breathe a little in the wind.
          const w = elapsed * 1.4 + i * 2.3;
          const lift = Math.max(0, Math.sin(w)) * 0.10;
          if (lift > 0.002) {
            s.p.y = s.rest.y + lift * 0.03;
            s.rot.x = -Math.PI / 2 + lift * 0.30;
            dirty = true;
          }
        }
      }

      e.set(s.rot.x, s.rot.y, s.rot.z, 'XYZ');
      q.setFromEuler(e);
      sc.set(s.scale, s.scale, s.scale);
      m.compose(s.p, q, sc);
      mesh.setMatrixAt(i, m);
    }
    if (dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  /* ── frame ────────────────────────────────────────────────────────────── */

  update(dt, elapsed, camPos) {
    // Wind slowly veers so nothing in the scene ever loops visibly.
    const wa = Math.sin(elapsed * 0.037) * 0.6 + Math.sin(elapsed * 0.011 + 1.3) * 0.4;
    this._wind.set(Math.cos(wa) * 0.62, 0, Math.sin(wa) * 0.62);

    if (!this._seeded) {
      this.moteCentre.copy(camPos);
      this._seedMotes(camPos);
      this._seeded = true;
    } else {
      this.moteCentre.copy(camPos);
      this._wrapMotes(camPos);
      // Top the pool back up if the batch had to evict motes for combat FX.
      if (elapsed % 1 < dt) this._seedMotes(camPos);
    }

    this._driftAcc += dt;
    if (this._driftAcc > 1.6) {
      this._driftAcc = 0;
      this._spawnDrift(camPos, elapsed);
    }

    if (!this._autoScanned && elapsed > 1.5) this._autoScan();
    if (this.emberSources.length) this._emitEmbers(dt, elapsed, camPos);

    if (this.litter) {
      if (!this._litterReady && elapsed > this._litterProbeAt) {
        this._litterProbeAt = elapsed + 0.35;
        this._placeLitter(camPos);
      }
      this._updateLitter(dt, elapsed, camPos);
    }
  }

  dispose() {
    if (this.litter) {
      try { this.litter.parent?.remove(this.litter); } catch { /* noop */ }
      try { this.litter.geometry.dispose(); this.litter.material.dispose(); } catch { /* noop */ }
      this.litter = null;
    }
  }
}

export default AmbientLife;
