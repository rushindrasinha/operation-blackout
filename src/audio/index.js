/**
 * OPERATION BLACKOUT — audio.
 *
 * Fully procedural. There is not a single sample file in this project: every
 * gunshot, impact, footstep, shell casing and gust of wind is synthesised into
 * an AudioBuffer at init (see banks.js / ambience.js), and the reverb tails come
 * from impulse responses generated the same way (impulses.js).
 *
 * Signal flow
 * ───────────
 *   voice ─ source → airLP → gain → panner ┬→ bus ─┐
 *                                          └→ send → reverbSend ┬→ indoorGain → convIndoor ┐
 *                                                               └→ outdoorGain → convOutdoor ┤
 *                                                                          reverbReturn ←────┘
 *   weaponBus ──────────────────────────┐
 *   uiBus ──────────────────────────────┤
 *   reverbReturn ───────────────────────┼→ master → limiter → saturator → out → destination
 *   worldBus  ┐                         │
 *   ambience  ┴→ duckGain ──────────────┘
 *
 * `duckGain` is sidechained off every shot, so the world and the ambient bed
 * pull back ~7dB for 200ms and the report stays punchy. The reverb return is
 * deliberately *not* ducked — the tail is the best part of the sound.
 *
 * Indoor/outdoor is resolved by raycasting straight up from the player: sky
 * above → outdoor IR, ceiling above → warehouse IR, crossfaded over ~0.4s.
 *
 * OWNER: audio. Exports AudioSystem (id 'audio', order 60).
 */

import * as THREE from 'three';
import { buildBank } from './banks.js';
import { indoorIR, outdoorIR } from './impulses.js';
import { buildWind, buildRumble, buildCreak } from './ambience.js';
import { Rng } from './dsp.js';

const IMPACT_MAP = {
  concrete: 'impact_concrete', plaster: 'impact_concrete', asphalt: 'impact_concrete',
  stone: 'impact_concrete', brick: 'impact_concrete', tarmac: 'impact_concrete',
  rustmetal: 'impact_metal', paintedmetal: 'impact_metal', metal: 'impact_metal',
  steel: 'impact_metal', grate: 'impact_metal', pipe: 'impact_metal',
  corrugatedmetal: 'impact_metal',
  dirt: 'impact_dirt', sand: 'impact_dirt', gravel: 'impact_dirt', ground: 'impact_dirt',
  grass: 'impact_dirt', mud: 'impact_dirt', sandbags: 'impact_dirt',
  wood: 'impact_wood', plywood: 'impact_wood', crate: 'impact_wood', plank: 'impact_wood',
  glass: 'impact_glass',
  fabric: 'impact_dirt', rubber: 'impact_dirt', tarp: 'impact_dirt',
  flesh: 'impact_flesh', body: 'impact_flesh',
};

const STEP_MAP = {
  concrete: 'concrete', plaster: 'concrete', asphalt: 'concrete', stone: 'concrete',
  brick: 'concrete', tarmac: 'concrete',
  rustmetal: 'metal', paintedmetal: 'metal', metal: 'metal', steel: 'metal', grate: 'metal',
  corrugatedmetal: 'metal',
  dirt: 'dirt', sand: 'dirt', gravel: 'dirt', ground: 'dirt', grass: 'dirt', mud: 'dirt',
  wood: 'wood', plywood: 'wood', plank: 'wood',
  fabric: 'soft', rubber: 'soft', sandbags: 'soft', carpet: 'soft', tarp: 'soft',
};

/**
 * Per-material timbre bias, applied on top of the impact sound it maps to.
 * Several materials share one bank but are physically very different: thin
 * corrugated sheet rings a fifth higher than a rusted steel drum, and glass in
 * a frame rattles rather than shatters cleanly. [pitch, volume].
 */
const MATERIAL_TONE = {
  corrugatedmetal: [1.24, 1.06],
  paintedmetal: [1.05, 0.97],
  rustmetal: [0.93, 1.0],
  grate: [1.15, 0.9],
  pipe: [1.30, 0.85],
  plaster: [1.12, 0.82],
  brick: [0.95, 1.02],
  asphalt: [0.90, 0.95],
  gravel: [1.08, 0.92],
  sand: [0.92, 0.85],
  sandbags: [0.80, 0.78],
  fabric: [0.85, 0.62],
  tarp: [1.05, 0.58],
  rubber: [0.78, 0.70],
  plywood: [1.14, 0.92],
};

/** Per-id mix defaults: bus, base level, reverb send, priority, min retrigger gap. */
const SOUND_DEFS = {
  rifle_fire:      { bus: 'weapon', gain: 0.84, send: 0.95, prio: 10, gap: 0.020, noThrottle: true },
  smg_fire:        { bus: 'weapon', gain: 0.72, send: 0.90, prio: 10, gap: 0.016, noThrottle: true },
  fire_distant:    { bus: 'world',  gain: 0.85, send: 1.30, prio: 4,  gap: 0.03  },
  reload_mag_out:  { bus: 'weapon', gain: 0.55, send: 0.35, prio: 8,  gap: 0.05  },
  reload_mag_in:   { bus: 'weapon', gain: 0.62, send: 0.40, prio: 8,  gap: 0.05  },
  reload_charge:   { bus: 'weapon', gain: 0.60, send: 0.42, prio: 8,  gap: 0.05  },
  weapon_swap:     { bus: 'weapon', gain: 0.45, send: 0.30, prio: 6,  gap: 0.05  },
  empty_click:     { bus: 'weapon', gain: 0.50, send: 0.25, prio: 7,  gap: 0.06  },
  impact_concrete: { bus: 'world',  gain: 0.62, send: 0.70, prio: 5,  gap: 0.014 },
  impact_metal:    { bus: 'world',  gain: 0.58, send: 0.75, prio: 5,  gap: 0.014 },
  impact_dirt:     { bus: 'world',  gain: 0.52, send: 0.45, prio: 4,  gap: 0.014 },
  impact_wood:     { bus: 'world',  gain: 0.55, send: 0.55, prio: 4,  gap: 0.014 },
  impact_glass:    { bus: 'world',  gain: 0.50, send: 0.65, prio: 5,  gap: 0.02  },
  impact_flesh:    { bus: 'world',  gain: 0.62, send: 0.30, prio: 6,  gap: 0.014 },
  footstep:        { bus: 'world',  gain: 0.34, send: 0.40, prio: 2,  gap: 0.06  },
  land:            { bus: 'world',  gain: 0.55, send: 0.45, prio: 5,  gap: 0.10  },
  bullet_whiz:     { bus: 'world',  gain: 0.70, send: 0.35, prio: 7,  gap: 0.03  },
  shell_casing:    { bus: 'world',  gain: 0.26, send: 0.45, prio: 1,  gap: 0.01  },
  hitmarker:       { bus: 'ui',     gain: 0.30, send: 0,    prio: 9,  gap: 0.02, spatial: false },
  hitmarker_head:  { bus: 'ui',     gain: 0.34, send: 0,    prio: 9,  gap: 0.02, spatial: false },
  death:           { bus: 'world',  gain: 0.72, send: 0.60, prio: 8,  gap: 0.05  },
  player_hurt:     { bus: 'ui',     gain: 0.60, send: 0.15, prio: 9,  gap: 0.22, spatial: false },
};

const MAX_VOICES = 46;
const SPEED_OF_SOUND = 343;

export class AudioSystem {
  static id = 'audio';
  static order = 60;

  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = false;      // an AudioContext exists
    this.ready = false;        // banks built, graph wired
    this.actx = null;
    this.buffers = {};
    this.rng = new Rng(1337);

    this._voices = new Set();
    this._lastPlay = new Map();
    this._offs = [];
    this._gestureBound = false;
    this._ambienceStarted = false;
    this._indoor = 0;          // 0 = outdoor, 1 = indoor (smoothed)
    this._indoorTimer = 0;
    this._surface = 'concrete';     // footstep profile
    this._surfaceRaw = 'concrete';  // the level's own material name, for timbre bias
    this._surfaceTimer = 0;
    this._strideAcc = 0;
    this._airTime = 0;
    this._wasGrounded = true;
    this._externalFootsteps = false;
    this._lastPos = new THREE.Vector3();
    this._havePos = false;
    this._farFireTimer = 9;
    this._creakTimer = 22;
    this._warned = new Set();
    this._shotsThisSecond = 0;
    this._shotWindow = 0;

    // Scratch vectors — no per-frame allocation.
    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._down = new THREE.Vector3(0, -1, 0);
    this._listenerPos = new THREE.Vector3();
    this._fwd = new THREE.Vector3(0, 0, -1);
    this._camUp = new THREE.Vector3(0, 1, 0);
  }

  /* ───────────────────────────── init ──────────────────────────────── */

  async init(onProgress = () => {}) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { console.warn('[audio] Web Audio unavailable — running silent.'); return; }
      this.actx = new AC({ latencyHint: 'interactive' });
      this.enabled = true;
    } catch (err) {
      console.warn('[audio] could not create AudioContext — running silent:', err);
      this.enabled = false;
      return;
    }

    const sr = this.actx.sampleRate;

    try {
      this._buildGraph();
      onProgress(0.05, 'audio: graph');

      const bank = await buildBank(sr, (p, label) => onProgress(0.05 + p * 0.62, label));
      for (const id in bank) {
        this.buffers[id] = bank[id].map((data) => this._toBuffer([data], sr));
      }
      onProgress(0.70, 'audio: reverb');

      // Impulse responses. These are the expensive ones; yield around them.
      await this._yield();
      this.convIndoor.buffer = this._toBuffer(indoorIR(sr), sr);
      onProgress(0.80, 'audio: warehouse IR');
      await this._yield();
      this.convOutdoor.buffer = this._toBuffer(outdoorIR(sr), sr);
      onProgress(0.88, 'audio: exterior IR');
      await this._yield();

      this._windBuffer = this._toBuffer(buildWind(sr), sr);
      onProgress(0.94, 'audio: wind');
      await this._yield();
      this._rumbleBuffer = this._toBuffer(buildRumble(sr), sr);
      this.buffers.creak = buildCreak(sr).map((d) => this._toBuffer([d], sr));
      onProgress(0.99, 'audio: ambience');

      this._bindEvents();
      this.ready = true;
      this._bindGesture();
      onProgress(1, 'audio');
    } catch (err) {
      console.warn('[audio] init failed — running silent:', err);
      this.ready = false;
    }
  }

  _yield() { return new Promise((r) => setTimeout(r, 0)); }

  _toBuffer(channels, sr) {
    const n = channels[0].length;
    const b = this.actx.createBuffer(channels.length, n, sr);
    for (let c = 0; c < channels.length; c++) {
      const dst = b.getChannelData(c);
      dst.set(channels[c].subarray(0, n));
    }
    return b;
  }

  _buildGraph() {
    const a = this.actx;
    const cfg = this.ctx.config?.audio ?? {};

    this.out = a.createGain();
    this.out.gain.value = 0.92;
    this.out.connect(a.destination);

    // Final safety saturator: a tanh curve so a stack of simultaneous shots
    // rounds over instead of digitally clipping.
    this.saturator = a.createWaveShaper();
    const curve = new Float32Array(2049);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 1.35) / Math.tanh(1.35);
    }
    this.saturator.curve = curve;
    this.saturator.oversample = '2x';
    this.saturator.connect(this.out);

    // Master limiter.
    // Catches peaks only. Sitting it low enough to be permanently engaged is
    // what flattens a firefight into a wall — it must be a safety net, not a
    // mix bus compressor.
    this.limiter = a.createDynamicsCompressor();
    this.limiter.threshold.value = -4;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.0025;
    this.limiter.release.value = 0.14;
    this.limiter.connect(this.saturator);

    this.master = a.createGain();
    this.master.gain.value = (cfg.master ?? 0.85);
    this.master.connect(this.limiter);

    const sfx = cfg.sfx ?? 1.0;

    this.weaponBus = a.createGain(); this.weaponBus.gain.value = 1.0 * sfx;
    this.weaponBus.connect(this.master);

    this.uiBus = a.createGain(); this.uiBus.gain.value = 0.95 * sfx;
    this.uiBus.connect(this.master);

    // Everything that ducks under a shot.
    this.duckGain = a.createGain(); this.duckGain.gain.value = 1;
    this.duckGain.connect(this.master);

    this.worldBus = a.createGain(); this.worldBus.gain.value = 1.0 * sfx;
    this.worldBus.connect(this.duckGain);

    this.ambienceFilter = a.createBiquadFilter();
    this.ambienceFilter.type = 'lowpass';
    this.ambienceFilter.frequency.value = this._nyq(18000);
    this.ambienceFilter.Q.value = 0.6;
    this.ambienceFilter.connect(this.duckGain);

    this.ambienceBus = a.createGain();
    this.ambienceBus.gain.value = 0.0001;   // faded in when the context starts
    this.ambienceBus.connect(this.ambienceFilter);

    // ── reverb ──────────────────────────────────────────────────────────
    this.reverbReturn = a.createGain();
    this.reverbReturn.gain.value = 1.0;
    this.reverbReturn.connect(this.master);

    this.convIndoor = a.createConvolver();  this.convIndoor.normalize = false;
    this.convOutdoor = a.createConvolver(); this.convOutdoor.normalize = false;
    this.convIndoor.connect(this.reverbReturn);
    this.convOutdoor.connect(this.reverbReturn);

    this.indoorGain = a.createGain();  this.indoorGain.gain.value = 0;
    this.outdoorGain = a.createGain(); this.outdoorGain.gain.value = 1;
    this.indoorGain.connect(this.convIndoor);
    this.outdoorGain.connect(this.convOutdoor);

    this.reverbSend = a.createGain(); this.reverbSend.gain.value = 0.44;
    this.reverbSend.connect(this.indoorGain);
    this.reverbSend.connect(this.outdoorGain);

    // ── dedicated sub path for nearby muzzle blast ──────────────────────
    this.subFilter = a.createBiquadFilter();
    this.subFilter.type = 'lowpass';
    this.subFilter.frequency.value = this._nyq(130);
    this.subFilter.Q.value = 0.8;
    this.subGain = a.createGain();
    this.subGain.gain.value = 1;
    this.subFilter.connect(this.subGain);
    this.subGain.connect(this.weaponBus);

    // Listener defaults.
    const L = a.listener;
    if (L.forwardX) {
      L.forwardX.value = 0; L.forwardY.value = 0; L.forwardZ.value = -1;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else if (L.setOrientation) {
      L.setOrientation(0, 0, -1, 0, 1, 0);
    }
  }

  _nyq(f) { return Math.min(f, (this.actx?.sampleRate ?? 48000) * 0.45); }

  /* ─────────────────────── gesture / resume ────────────────────────── */

  _bindGesture() {
    if (this._gestureBound) return;
    this._gestureBound = true;
    const resume = () => this.resume();
    this._resumeHandler = resume;
    for (const ev of ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'click']) {
      window.addEventListener(ev, resume, { passive: true });
    }
    document.addEventListener('pointerlockchange', resume);
    // In case the browser lets us start without a gesture at all.
    this.resume();
  }

  resume() {
    if (!this.actx) return;
    if (this.actx.state === 'running') { this._onRunning(); return; }
    try {
      const p = this.actx.resume();
      if (p && p.then) p.then(() => this._onRunning()).catch(() => {});
    } catch { /* degrade silently */ }
  }

  _onRunning() {
    if (this.ready && !this._ambienceStarted) this._startAmbience();
    // Drop the gesture listeners once we are live.
    if (this._resumeHandler && this.actx && this.actx.state === 'running') {
      for (const ev of ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'click']) {
        window.removeEventListener(ev, this._resumeHandler);
      }
      document.removeEventListener('pointerlockchange', this._resumeHandler);
      this._resumeHandler = null;
    }
  }

  _startAmbience() {
    const a = this.actx;
    if (!a || this._ambienceStarted) return;
    try {
      const t = a.currentTime;

      const mk = (buffer, gain, rate) => {
        if (!buffer) return null;
        const src = a.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        src.playbackRate.value = rate;
        const g = a.createGain();
        g.gain.value = gain;
        src.connect(g).connect(this.ambienceBus);
        src.start(t + 0.05, this.rng.range(0, buffer.duration * 0.5));
        return { src, g };
      };

      // The bed must sit around −24dBFS. Loud enough to remove the "silent
      // vacuum" tell, quiet enough that a rifle has 20dB of headroom above it.
      this._wind = mk(this._windBuffer, 0.10, 1.0);
      // Second wind layer at a different rate — two 10s loops beating against
      // each other never repeat inside a play session.
      this._wind2 = mk(this._windBuffer, 0.062, 0.786);
      this._rumble = mk(this._rumbleBuffer, 0.17, 1.0);

      // Slow filter movement on the wind so it breathes.
      if (this._wind) {
        this._windFilter = a.createBiquadFilter();
        this._windFilter.type = 'lowpass';
        this._windFilter.frequency.value = this._nyq(2600);
        this._windFilter.Q.value = 0.7;
        this._wind.g.disconnect();
        this._wind.g.connect(this._windFilter);
        this._windFilter.connect(this.ambienceBus);

        this._windLfo = a.createOscillator();
        this._windLfo.frequency.value = 0.036;
        this._windLfoGain = a.createGain();
        this._windLfoGain.gain.value = this._nyq(1500);
        this._windLfo.connect(this._windLfoGain);
        this._windLfoGain.connect(this._windFilter.frequency);
        this._windLfo.start(t);
      }

      this.ambienceBus.gain.cancelScheduledValues(t);
      this.ambienceBus.gain.setValueAtTime(0.0001, t);
      this.ambienceBus.gain.setTargetAtTime(0.6, t + 0.1, 0.9);

      this._ambienceStarted = true;
    } catch (err) {
      console.warn('[audio] ambience failed:', err);
      this._ambienceStarted = true; // do not retry every frame
    }
  }

  /* ───────────────────────────── events ────────────────────────────── */

  _bindEvents() {
    const e = this.ctx.events;
    if (!e) return;
    const on = (name, fn) => this._offs.push(e.on(name, (p) => {
      try { fn(p || {}); } catch (err) { console.warn(`[audio] handler ${name}:`, err); }
    }));

    on('weapon:fire', (p) => this._onWeaponFire(p));
    on('weapon:reload', (p) => this._onReload(p));
    on('weapon:empty', () => this.play('empty_click'));
    on('weapon:switch', () => this.play('weapon_swap'));
    on('hit:world', (p) => this._onHitWorld(p));
    on('hit:actor', (p) => this._onHitActor(p));
    on('actor:death', (p) => this._onDeath(p));
    on('player:damage', (p) => this.play('player_hurt', { volume: 0.5 + Math.min(0.5, (p.amount ?? 10) / 45) }));
    on('player:death', () => this.play('death', { volume: 0.9, spatial: false }));
    on('audio:play', (p) => {
      if (p && p.id) this.play(p.id, { position: p.position, volume: p.volume, pitch: p.pitch });
    });
    // If the player system drives its own footsteps, stand down.
    on('player:footstep', (p) => {
      this._externalFootsteps = true;
      this.play('footstep', { position: p.position ?? this.ctx.player?.position, surface: p.surface, volume: p.volume });
    });
    on('weapon:shell', (p) => this._playShell(p?.position));
  }

  _weaponSoundId(name) {
    const s = String(name ?? '').toLowerCase();
    if (/smg|mp5|mp7|ump|vector|uzi|pistol|p90|sidearm/.test(s)) return 'smg_fire';
    return 'rifle_fire';
  }

  _onWeaponFire(p) {
    const id = this._weaponSoundId(p.weapon ?? this.ctx.weapons?.current?.id);
    const origin = this._toVec(p.origin) ?? this._listenerPos;
    const dist = origin.distanceTo(this._listenerPos);
    const isPlayer = dist < 3.2;

    // Sustained fire fatigue: after a few rounds in quick succession, trim the
    // level slightly. Real ears do this; it also keeps the limiter honest.
    const now = this.actx ? this.actx.currentTime : 0;
    if (now - this._shotWindow > 0.6) { this._shotWindow = now; this._shotsThisSecond = 0; }
    this._shotsThisSecond++;
    const fatigue = 1 / (1 + Math.max(0, this._shotsThisSecond - 3) * 0.045);

    this.play(id, {
      position: isPlayer ? null : origin,
      spatial: !isPlayer,
      volume: (isPlayer ? 1.0 : 0.95) * fatigue,
      pitch: 1 + this.rng.gauss() * 0.022,
      pan: isPlayer ? 0.10 : 0,
      reverb: isPlayer ? 1.0 : 1.15,
    });

    if (isPlayer) {
      this._subThump(0.5 * fatigue);
      this._playShell(null, 0.30 + this.rng.range(0, 0.12));
    } else {
      if (dist > 8) this._maybeWhiz(origin, this._toVec(p.dir));
      if (dist < 26) this._subThump(0.22 * Math.max(0, 1 - dist / 26));
    }
    this._duck(isPlayer ? 0.42 : 0.62, isPlayer ? 0.22 : 0.16);
  }

  _onReload(p) {
    const d = Math.max(0.6, Number(p.duration) || 2.3);
    this.play('reload_mag_out', { delay: 0.08 * d, volume: 0.9 });
    this.play('reload_mag_in', { delay: 0.52 * d, volume: 1.0 });
    // Charging handle only when the weapon ran dry.
    const dry = (this.ctx.weapons?.current?.ammo ?? 1) <= 0 || p.empty === true;
    if (dry) this.play('reload_charge', { delay: 0.80 * d, volume: 0.95 });
  }

  _onHitWorld(p) {
    const point = this._toVec(p.point);
    const key = String(p.material ?? 'concrete').toLowerCase();
    const id = IMPACT_MAP[key] ?? 'impact_concrete';
    const imp = Math.max(0.25, Math.min(1.8, (p.impulse ?? 1)));
    const tone = MATERIAL_TONE[key] ?? [1, 1];
    this.play(id, {
      position: point,
      volume: (0.75 + 0.35 * Math.min(1, imp)) * tone[1],
      pitch: tone[0] * (1 + this.rng.gauss() * 0.075),
    });
  }

  _onHitActor(p) {
    const point = this._toVec(p.point);
    this.play('impact_flesh', { position: point, pitch: 1 + this.rng.gauss() * 0.06 });
    // Hitmarker only when the player is the one landing the round.
    const dist = point ? point.distanceTo(this._listenerPos) : 0;
    if (dist < 220) this.play(p.isHeadshot ? 'hitmarker_head' : 'hitmarker');
  }

  _onDeath(p) {
    const a = p.actor;
    const pos = this._toVec(a?.position ?? a?.mesh?.position ?? a?.root?.position ?? p.point);
    this.play('death', { position: pos, pitch: 1 + this.rng.gauss() * 0.05 });
  }

  /* ───────────────────────────── playback ──────────────────────────── */

  /**
   * @param {string} id
   * @param {object} [opts]
   *   position  THREE.Vector3|{x,y,z}|null   world position; null = head-locked
   *   volume    number  (default 1)
   *   pitch     number  playback-rate multiplier (default 1, jittered anyway)
   *   delay     number  seconds to defer
   *   spatial   boolean force on/off
   *   surface   string  for 'footstep'
   *   reverb    number  multiplier on the reverb send
   *   pan       number  −1..1 for non-spatial voices
   */
  play(id, opts = {}) {
    if (!this.ready || !this.actx || this.actx.state !== 'running') return null;

    let bankId = id;
    if (id === 'footstep') bankId = 'footstep_' + (STEP_MAP[String(opts.surface ?? this._surface).toLowerCase()] ?? this._surface ?? 'concrete');
    const list = this.buffers[bankId];
    if (!list || !list.length) {
      if (!this._warned.has(id)) { this._warned.add(id); console.warn(`[audio] unknown sound id "${id}"`); }
      return null;
    }

    const def = SOUND_DEFS[id] ?? SOUND_DEFS[bankId] ?? { bus: 'world', gain: 0.6, send: 0.5, prio: 3, gap: 0.012 };
    const t0 = this.actx.currentTime;
    const delay = Math.max(0, Number(opts.delay) || 0);

    // Retrigger throttle — stops a burst of identical impacts from stacking
    // into a comb filter. Weapon fire is exempt: the throttle is keyed on the
    // sound id, so with it enabled a bot firing 15ms before the player would
    // silently eat the player's own shot, which is unacceptable. Weapons are
    // already rate-limited by their own RPM.
    const last = this._lastPlay.get(bankId) ?? -1;
    if (!def.noThrottle && delay === 0 && t0 - last < (def.gap ?? 0.012)) return null;
    this._lastPlay.set(bankId, t0 + delay);

    if (this._voices.size >= MAX_VOICES) {
      if (!this._evict(def.prio ?? 3)) return null;
    }

    try {
      return this._spawn(list, def, opts, t0 + delay);
    } catch (err) {
      console.warn('[audio] play failed:', err);
      return null;
    }
  }

  _spawn(list, def, opts, when) {
    const a = this.actx;
    const buffer = list[Math.floor(this.rng.next() * list.length) % list.length];

    const pos = this._toVec(opts.position);
    const spatial = opts.spatial !== undefined ? !!opts.spatial
      : (def.spatial !== undefined ? def.spatial : !!pos);

    let dist = 0;
    if (spatial && pos) dist = Math.max(0, pos.distanceTo(this._listenerPos));

    // Propagation delay. Only past ~8m, so the player's own weapon is instant.
    let start = when;
    if (spatial && dist > 8) start += Math.min(0.75, (dist - 8) / SPEED_OF_SOUND);

    const src = a.createBufferSource();
    src.buffer = buffer;
    const jitter = 1 + this.rng.gauss() * 0.028;
    src.playbackRate.value = Math.max(0.55, Math.min(1.9, (Number(opts.pitch) || 1) * jitter));

    // Air absorption: distant sources lose their top end long before they lose
    // their level. This is what makes far gunfire read as *far* and not "quiet".
    const air = a.createBiquadFilter();
    air.type = 'lowpass';
    air.Q.value = 0.6;
    const cutoff = 320 + 19500 * Math.exp(-dist / 16);
    air.frequency.value = this._nyq(cutoff * (0.92 + this.rng.next() * 0.16));

    const g = a.createGain();
    const vol = (Number(opts.volume) === 0 ? 0 : (Number(opts.volume) || 1));
    g.gain.value = Math.max(0, (def.gain ?? 0.6) * vol * (0.93 + this.rng.next() * 0.14));

    let spatialNode;
    if (spatial && pos) {
      const p = a.createPanner();
      p.panningModel = dist < 42 ? 'HRTF' : 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = Number(opts.refDistance) || 3.4;
      p.maxDistance = 600;
      p.rolloffFactor = Number(opts.rolloff) || 0.98;
      p.coneInnerAngle = 360; p.coneOuterAngle = 360; p.coneOuterGain = 1;
      this._setPanner(p, pos);
      spatialNode = p;
    } else {
      const p = a.createStereoPanner ? a.createStereoPanner() : a.createGain();
      if (p.pan) p.pan.value = Math.max(-1, Math.min(1, Number(opts.pan) || 0));
      spatialNode = p;
    }

    src.connect(air).connect(g).connect(spatialNode);

    const busName = opts.bus ?? def.bus ?? 'world';
    const bus = busName === 'weapon' ? this.weaponBus : busName === 'ui' ? this.uiBus : this.worldBus;
    spatialNode.connect(bus);

    // Reverb send: scaled by distance, so a far shot is heard mostly as tail.
    let send = null;
    const sendBase = (def.send ?? 0.4) * (opts.reverb !== undefined ? opts.reverb : 1);
    if (sendBase > 0.001) {
      send = a.createGain();
      send.gain.value = sendBase * (1 + Math.min(1.35, dist / 34));
      spatialNode.connect(send);
      send.connect(this.reverbSend);
    }

    const voice = {
      src, air, g, spatialNode, send,
      prio: def.prio ?? 3,
      endsAt: start + buffer.duration / src.playbackRate.value + 0.15,
    };
    this._voices.add(voice);
    src.onended = () => this._release(voice);
    src.start(Math.max(a.currentTime, start));
    return voice;
  }

  _setPanner(p, v) {
    const x = Number.isFinite(v.x) ? v.x : 0;
    const y = Number.isFinite(v.y) ? v.y : 0;
    const z = Number.isFinite(v.z) ? v.z : 0;
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
    else if (p.setPosition) p.setPosition(x, y, z);
  }

  _release(voice) {
    if (!this._voices.has(voice)) return;
    this._voices.delete(voice);
    try { voice.src.disconnect(); } catch { /* already gone */ }
    try { voice.air.disconnect(); } catch { /* already gone */ }
    try { voice.g.disconnect(); } catch { /* already gone */ }
    try { voice.spatialNode.disconnect(); } catch { /* already gone */ }
    if (voice.send) { try { voice.send.disconnect(); } catch { /* already gone */ } }
  }

  /** Steal the lowest-priority active voice if the newcomer outranks it. */
  _evict(prio) {
    let worst = null;
    for (const v of this._voices) {
      if (!worst || v.prio < worst.prio || (v.prio === worst.prio && v.endsAt < worst.endsAt)) worst = v;
    }
    if (!worst || worst.prio > prio) return false;
    try { worst.src.stop(); } catch { /* already stopped */ }
    this._release(worst);
    return true;
  }

  /** Chest-punch sub layer for shots close to the listener. */
  _subThump(amount) {
    const a = this.actx;
    if (!a || amount <= 0.001) return;
    try {
      const t = a.currentTime;
      const o = a.createOscillator();
      o.type = 'sine';
      const f0 = 62 * (0.92 + this.rng.next() * 0.16);
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.5, t + 0.16);
      const g = a.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.002, amount), t + 0.007);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      o.connect(g).connect(this.subFilter);
      o.start(t);
      o.stop(t + 0.3);
      o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* gone */ } };
    } catch { /* degrade silently */ }
  }

  /** Sidechain: pull the world and the bed down under the report. */
  _duck(depth, hold) {
    const a = this.actx;
    if (!a) return;
    try {
      const t = a.currentTime;
      const p = this.duckGain.gain;
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(depth, t + 0.010);
      p.setTargetAtTime(1.0, t + hold, 0.085);
    } catch { /* degrade silently */ }
  }

  _playShell(position, delay) {
    const p = this.ctx.player;
    let pos = this._toVec(position);
    if (!pos) {
      const base = p?.position ?? this._listenerPos;
      pos = this._v3.set(
        base.x + this.rng.range(-1.1, 1.1),
        (p?.position?.y ?? this._listenerPos.y - 1.6) + 0.04,
        base.z + this.rng.range(-1.1, 1.1),
      );
    }
    this.play('shell_casing', {
      position: pos,
      delay: delay ?? this.rng.range(0.3, 0.45),
      pitch: 1 + this.rng.gauss() * 0.09,
      volume: 0.9 + this.rng.range(0, 0.25),
    });
  }

  /**
   * Bullet whiz. Fires when an incoming round's closest approach to the
   * listener is inside ~4.5m; the panner is flown along the trajectory so the
   * round genuinely crosses the stereo field.
   */
  _maybeWhiz(origin, dir) {
    if (!dir) return;
    const d = this._v0.copy(dir);
    if (d.lengthSq() < 1e-8) return;
    d.normalize();
    const rel = this._v1.copy(this._listenerPos).sub(origin);
    const along = rel.dot(d);
    if (along < 3) return;
    const closest = this._v2.copy(origin).addScaledVector(d, along);
    const miss = closest.distanceTo(this._listenerPos);
    if (miss > 4.5 || miss < 0.25) return;

    const a = this.actx;
    const travel = along / 880;                    // 5.56 muzzle velocity-ish
    const voice = this.play('bullet_whiz', {
      position: closest,
      delay: Math.min(0.4, travel),
      volume: 0.55 + 0.75 * (1 - miss / 4.5),
      pitch: 1 + this.rng.gauss() * 0.06,
    });
    if (!voice || !voice.spatialNode || !voice.spatialNode.positionX) return;

    // Fly the panner from 9m before to 9m after the closest-approach point.
    try {
      const t = a.currentTime + Math.min(0.4, travel);
      const pn = voice.spatialNode;
      const from = this._v0.copy(closest).addScaledVector(d, -9);
      const to = this._v1.copy(closest).addScaledVector(d, 9);
      const dur = 0.16;
      for (const [ax, f, c] of [['positionX', from.x, to.x], ['positionY', from.y, to.y], ['positionZ', from.z, to.z]]) {
        const p = pn[ax];
        p.cancelScheduledValues(t);
        p.setValueAtTime(f, t);
        p.linearRampToValueAtTime(c, t + dur);
      }
    } catch { /* automation unsupported — the baked sweep still sells it */ }
  }

  /* ───────────────────────────── per frame ─────────────────────────── */

  update(dt) {
    if (!this.enabled || !this.actx) return;
    if (!this.ready) return;
    if (this.actx.state === 'running' && !this._ambienceStarted) this._startAmbience();
    if (this.actx.state !== 'running') return;

    const d = Math.min(0.1, dt || 0.016);
    try { this._updateListener(); } catch { /* keep the frame alive */ }
    try { this._updateSpace(d); } catch { /* keep the frame alive */ }
    try { this._updateFootsteps(d); } catch { /* keep the frame alive */ }
    try { this._updateAmbientEvents(d); } catch { /* keep the frame alive */ }

    // Safety sweep: if onended ever fails to fire, do not leak nodes.
    const now = this.actx.currentTime;
    if (this._voices.size) {
      for (const v of this._voices) {
        if (now > v.endsAt + 1.5) this._release(v);
      }
    }
  }

  _updateListener() {
    const cam = this.ctx.camera;
    const L = this.actx.listener;
    if (!cam) return;
    cam.getWorldPosition(this._listenerPos);
    this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this._camUp.set(0, 1, 0).applyQuaternion(cam.quaternion);

    const p = this._listenerPos;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;

    const t = this.actx.currentTime;
    if (L.positionX) {
      // Direct assignment rather than automation: the listener moves every
      // frame and a scheduled event per param per frame grows the automation
      // timeline for the whole session.
      L.positionX.value = p.x;
      L.positionY.value = p.y;
      L.positionZ.value = p.z;
      L.forwardX.value = this._fwd.x;
      L.forwardY.value = this._fwd.y;
      L.forwardZ.value = this._fwd.z;
      L.upX.value = this._camUp.x;
      L.upY.value = this._camUp.y;
      L.upZ.value = this._camUp.z;
      void t;
    } else {
      L.setPosition?.(p.x, p.y, p.z);
      L.setOrientation?.(this._fwd.x, this._fwd.y, this._fwd.z, this._camUp.x, this._camUp.y, this._camUp.z);
    }
  }

  /** Decide which room we are in and crossfade the two impulse responses. */
  _updateSpace(dt) {
    this._indoorTimer -= dt;
    if (this._indoorTimer <= 0) {
      this._indoorTimer = 0.28;
      let indoor = null;
      const lvl = this.ctx.level;
      if (lvl && typeof lvl.isIndoor === 'function') {
        try { indoor = !!lvl.isIndoor(this._listenerPos); } catch { indoor = null; }
      }
      if (indoor === null) {
        const ph = this.ctx.physics;
        if (ph && typeof ph.raycast === 'function') {
          // Start ABOVE the player capsule. Rapier's solid raycast reports a
          // hit at t=0 for a ray originating inside a collider, so casting from
          // the eye means the player's own capsule answers "yes, indoors"
          // everywhere on the map.
          const feet = this.ctx.player?.position;
          const baseY = (feet && Number.isFinite(feet.y)) ? feet.y + 2.15 : this._listenerPos.y + 0.55;
          const from = this._v0.set(this._listenerPos.x, baseY, this._listenerPos.z);
          const hit = ph.raycast(from, this._up, 18, { reuse: true, excludeActor: this.ctx.player });
          indoor = !!(hit && hit.distance > 0.02);
        } else {
          indoor = false;
        }
      }
      this._indoorTarget = indoor ? 1 : 0;
    }

    const target = this._indoorTarget ?? 0;
    // ~0.4s crossfade.
    this._indoor += (target - this._indoor) * Math.min(1, dt * 2.6);
    const k = this._indoor;

    // Only touch the automation timeline when the space actually changed —
    // scheduling five events every frame for an hour is how you leak memory.
    if (Math.abs(k - (this._lastSpaceK ?? -1)) < 0.004) return;
    this._lastSpaceK = k;

    const t = this.actx.currentTime;
    this.indoorGain.gain.setTargetAtTime(k, t, 0.08);
    this.outdoorGain.gain.setTargetAtTime(1 - k, t, 0.08);
    // Indoors the wind is muffled and quieter, and the whole send gets wetter.
    this.ambienceFilter.frequency.setTargetAtTime(this._nyq(18000 - k * 16600), t, 0.2);
    this.reverbSend.gain.setTargetAtTime(0.44 + k * 0.16, t, 0.2);
    if (this._ambienceStarted) this.ambienceBus.gain.setTargetAtTime(0.6 - k * 0.30, t, 0.35);
  }

  _updateFootsteps(dt) {
    const pl = this.ctx.player;
    if (!pl || !pl.position || this._externalFootsteps) return;
    const pos = pl.position;
    if (!Number.isFinite(pos.x)) return;

    if (!this._havePos) { this._lastPos.copy(pos); this._havePos = true; return; }

    const dx = pos.x - this._lastPos.x;
    const dz = pos.z - this._lastPos.z;
    const moved = Math.hypot(dx, dz);
    this._lastPos.copy(pos);
    if (moved > 4) { this._strideAcc = 0; return; }     // teleport / respawn

    const grounded = pl.isGrounded !== false;
    if (!grounded) {
      this._airTime += dt;
    } else if (this._airTime > 0) {
      if (this._airTime > 0.22) {
        this.play('land', {
          position: pos,
          volume: Math.min(1.15, 0.6 + this._airTime * 0.7),
          pitch: 1 + this.rng.gauss() * 0.05,
        });
        this._duck(0.72, 0.06);
      }
      this._airTime = 0;
      this._strideAcc = 0;
    }
    this._wasGrounded = grounded;
    if (!grounded) return;

    const speed = moved / Math.max(1e-4, dt);
    if (speed < 0.45) { this._strideAcc = Math.max(0, this._strideAcc - dt * 0.5); return; }

    // Refresh the surface under the boot every so often.
    this._surfaceTimer -= dt;
    if (this._surfaceTimer <= 0) {
      this._surfaceTimer = 0.3;
      const ph = this.ctx.physics;
      if (ph && typeof ph.raycast === 'function') {
        const from = this._v0.set(pos.x, pos.y + 0.5, pos.z);
        const hit = ph.raycast(from, this._down, 1.6, { reuse: true });
        if (hit && hit.material) {
          this._surfaceRaw = String(hit.material).toLowerCase();
          this._surface = STEP_MAP[this._surfaceRaw] ?? 'concrete';
        }
      }
    }

    const crouch = !!pl.isCrouching;
    const sprint = !!pl.isSprinting;
    const stride = crouch ? 0.66 : sprint ? 1.18 : 0.86;
    this._strideAcc += moved;
    if (this._strideAcc >= stride) {
      this._strideAcc -= stride;
      const vol = crouch ? 0.42 : sprint ? 1.15 : 0.78;
      const tone = MATERIAL_TONE[this._surfaceRaw] ?? [1, 1];
      this.play('footstep', {
        position: this._v1.set(pos.x, pos.y + 0.05, pos.z),
        volume: vol * tone[1] * (0.88 + this.rng.next() * 0.24),
        pitch: tone[0] * (crouch ? 1.06 : sprint ? 0.96 : 1.0) * (1 + this.rng.gauss() * 0.05),
        reverb: crouch ? 0.7 : 1,
      });
    }
  }

  /** Distant contact somewhere else in the AO, plus the occasional loose panel. */
  _updateAmbientEvents(dt) {
    this._farFireTimer -= dt;
    if (this._farFireTimer <= 0) {
      this._farFireTimer = this.rng.range(8, 21);
      const ang = this.rng.range(0, Math.PI * 2);
      const r = this.rng.range(110, 260);
      const pos = this._v0.set(
        this._listenerPos.x + Math.cos(ang) * r,
        this._listenerPos.y + this.rng.range(-4, 10),
        this._listenerPos.z + Math.sin(ang) * r,
      );
      const rounds = this.rng.int(2, 6);
      let t = 0;
      for (let i = 0; i < rounds; i++) {
        this.play('fire_distant', {
          position: pos,
          delay: t,
          volume: this.rng.range(0.5, 0.85),
          pitch: 1 + this.rng.gauss() * 0.05,
          refDistance: 34,
          rolloff: 0.55,
        });
        t += this.rng.range(0.09, 0.16);
      }
    }

    this._creakTimer -= dt;
    if (this._creakTimer <= 0) {
      this._creakTimer = this.rng.range(17, 42);
      if (this.buffers.creak) {
        const ang = this.rng.range(0, Math.PI * 2);
        const r = this.rng.range(9, 26);
        this.play('creak', {
          position: this._v0.set(
            this._listenerPos.x + Math.cos(ang) * r,
            this._listenerPos.y + this.rng.range(0, 3.5),
            this._listenerPos.z + Math.sin(ang) * r,
          ),
          volume: this.rng.range(0.25, 0.55),
          pitch: 1 + this.rng.gauss() * 0.12,
        });
      }
    }
  }

  /* ───────────────────────────── helpers ───────────────────────────── */

  _toVec(v) {
    if (!v) return null;
    if (v.isVector3) return v;
    if (Array.isArray(v) && v.length >= 3) return this._v3.set(v[0], v[1], v[2]);
    if (typeof v.x === 'number') return this._v3.set(v.x, v.y ?? 0, v.z ?? 0);
    return null;
  }

  /** Master volume, 0..1. Exposed so a settings menu can drive it. */
  setMasterVolume(v) {
    if (!this.master) return;
    const t = this.actx.currentTime;
    this.master.gain.setTargetAtTime(Math.max(0, Math.min(1.5, v)), t, 0.05);
  }

  get isIndoor() { return this._indoor > 0.5; }

  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* gone */ } }
    this._offs.length = 0;
    for (const v of [...this._voices]) {
      try { v.src.stop(); } catch { /* gone */ }
      this._release(v);
    }
    for (const l of [this._wind, this._wind2, this._rumble]) {
      if (l) { try { l.src.stop(); } catch { /* gone */ } }
    }
    if (this._windLfo) { try { this._windLfo.stop(); } catch { /* gone */ } }
    if (this._resumeHandler) {
      for (const ev of ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'click']) {
        window.removeEventListener(ev, this._resumeHandler);
      }
      document.removeEventListener('pointerlockchange', this._resumeHandler);
      this._resumeHandler = null;
    }
    this.ready = false;
    if (this.actx) { try { this.actx.close(); } catch { /* gone */ } }
  }
}

export default AudioSystem;
