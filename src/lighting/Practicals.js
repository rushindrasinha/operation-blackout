/**
 * Local lights ("practicals" — the sodium-vapour lamps, work lights and window spill
 * that give a dusk exterior its only saturated accents).
 *
 * The design constraint is that adding or removing a light from the scene changes
 * NUM_POINT_LIGHTS, which invalidates every shader program and causes a multi-frame
 * compile stall. So we allocate a fixed pool of point lights ONCE, keep all of them
 * parented forever, and merely re-point and re-weight them. The light *budget* is
 * therefore constant no matter how many practicals a level registers.
 *
 * Selection is an importance sort: inverse-square contribution at the camera, so a
 * bright lamp 30m away can outrank a dim one at 8m, which is what your eye expects.
 * Slot reassignment cross-fades (out, swap, in) so lights never pop.
 *
 * OWNER: lighting.
 */
import * as THREE from 'three';

let _nextId = 1;

/**
 * ── FALLOFF EXPONENT ──────────────────────────────────────────────────────────
 *
 * Physical decay is 2. We ship 2.7, and this is the single most consequential
 * number in the file, so it gets a real justification.
 *
 * The level registers 43 practicals, several at 42 cd with a 24 m window. Tuned in
 * isolation those read correctly *at the fixture*. Ablated against the graded frame,
 * they were also putting 20+ sRGB levels of pure red into cast shadows twenty metres
 * away — and because the sky fill under them is blue, red-plus-blue-minus-green is
 * literally the definition of magenta. Every "the shadows are lavender / the yard
 * floor is mauve / the ambient is magenta" finding in the review traces to this one
 * interaction, not to the sky term everyone assumed. Killing the practicals live
 * moves the closeup shadow from hue 275 to hue 217 in a single step.
 *
 * The fix cannot be "dim the lamps" — the brief wants sodium practicals as the
 * frame's only saturated accent, and a separate finding (correctly) says they do not
 * read strongly enough head-on. What is wrong is the *shape* of the falloff, not its
 * peak: a lamp should be a hot pool you can stand in, not a wash across the yard.
 * At 2.7 the value 0.3 m from a fixture goes *up* by 4x while the value at 20 m
 * drops to a fifth, which is exactly the trade we want. It is not physical; neither
 * is a 43-fixture budget of 8 point lights, and every shipped title cheats the same
 * way for the same reason.
 */
/**
 * ── REVISED: THE CHROMA ARGUMENT WAS RIGHT, THE INSTRUMENT WAS WRONG ──────────
 *
 * Everything above about red spill making violet shadows is correct and still holds.
 * What is wrong is using the falloff exponent to fix it, because the exponent is not
 * a colour knob — it is the shape of the pool, and cranking it to 2.7 collapsed the
 * pool to about 1.5 m. The review measured the consequence directly: the warehouse
 * sodium head at x430-530 / y290-350 is a bright bulb with the corrugated wall 30 cm
 * behind it completely unlit and no pool on the floor or the mezzanine below it. A
 * lamp that lights nothing is worse than no lamp, and "practicals with real falloff
 * and warm colour bleed onto nearby surfaces" is on the reference calibration list.
 *
 * The chroma problem is now fixed at its actual source — `_conditionPracticalColour()`
 * in LightingSystem snaps every fixture onto a ~2050 K blackbody floor, so the spill
 * carries a third of its red in green and cannot make magenta no matter how far it
 * reaches. With that in place the exponent is free to be physical again.
 *
 * 2.0 is inverse-square. `_decayComp` holds the irradiance at 1.6 m invariant, so this
 * is not a brightness change at the fixture: it is purely reach. Combined with the
 * radius floor in LightingSystem.addPractical() (the level ships several fixtures at a
 * 13 m window, which three hard-clips to zero well before the floor) the pools now
 * actually land on the surfaces under them.
 */
const PRACTICAL_DECAY = 2.0;

export class Practicals {
  /**
   * @param {THREE.Scene} scene
   * @param {number} budget max simultaneously active point lights
   */
  constructor(scene, budget = 8) {
    this.scene = scene;
    this.budget = budget;
    this.decay = PRACTICAL_DECAY;
    this.entries = [];
    this.slots = [];

    const group = new THREE.Group();
    group.name = 'Practicals';
    group.matrixAutoUpdate = false;
    scene.add(group);
    this.group = group;

    for (let i = 0; i < budget; i++) {
      const light = new THREE.PointLight(0xffb257, 0, 12, PRACTICAL_DECAY);
      light.castShadow = false;      // cube shadow maps at 8x are not affordable
      light.visible = true;          // never toggle: keeps NUM_POINT_LIGHTS stable
      light.intensity = 0;
      group.add(light);
      this.slots.push({ light, entry: null, pending: null, fade: 0 });
    }
  }

  /**
   * @param {THREE.Vector3} position
   * @param {number|THREE.Color} color
   * @param {number} intensity  candela-ish; ~4-30 for a street lamp
   * @param {number} radius     cutoff distance in metres
   * @param {object} [opts]     { flicker:0..1, flickerSpeed:number, tag:string }
   * @returns {object} handle
   */
  add(position, color = 0xffb257, intensity = 12, radius = 11, opts = {}) {
    const entry = {
      id: _nextId++,
      position: position?.isVector3 ? position.clone() : new THREE.Vector3().fromArray(position ?? [0, 0, 0]),
      color: new THREE.Color(color ?? 0xffb257),
      intensity: Math.max(0, intensity ?? 12),
      radius: Math.max(0.5, radius ?? 11),
      flicker: THREE.MathUtils.clamp(opts.flicker ?? 0, 0, 1),
      flickerSpeed: opts.flickerSpeed ?? 7.3,
      phase: Math.random() * 100,
      tag: opts.tag ?? '',
      auto: opts.auto === true,
      /** Importance multiplier — lets a level mark a hero fixture. */
      boost: opts.boost ?? 1,
      /** Ground pool: radius in metres, 0 disables. Filled in by LightPools. */
      pool: opts.pool !== false,
      poolY: opts.poolY,
      _score: 0,
      _gain: 1,
      /**
       * Keeps `intensity` meaning the same thing under a non-physical decay: the
       * irradiance at 1.6 m is held, everything nearer gets brighter and
       * everything further gets darker. See PRACTICAL_DECAY.
       */
      _decayComp: Math.pow(1.6, PRACTICAL_DECAY - 2),
    };
    this.entries.push(entry);
    return entry;
  }

  remove(handle) {
    const i = this.entries.indexOf(handle);
    if (i >= 0) this.entries.splice(i, 1);
    for (const s of this.slots) {
      if (s.entry === handle) { s.entry = null; s.fade = 0; s.light.intensity = 0; }
      if (s.pending === handle) s.pending = null;
    }
  }

  removeWhere(pred) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (pred(this.entries[i])) this.remove(this.entries[i]);
    }
  }

  clear() {
    this.entries.length = 0;
    for (const s of this.slots) { s.entry = null; s.pending = null; s.fade = 0; s.light.intensity = 0; }
  }

  get count() { return this.entries.length; }
  get activeCount() { return this.slots.reduce((n, s) => n + (s.entry ? 1 : 0), 0); }

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {THREE.Vector3} cameraPos
   */
  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {THREE.Vector3} cameraPos
   * @param {THREE.Vector3} [cameraDir] unit forward vector; enables view-aware slotting
   */
  update(dt, elapsed, cameraPos, cameraDir) {
    const entries = this.entries;
    if (entries.length === 0) {
      for (const s of this.slots) {
        if (s.light.intensity !== 0) s.light.intensity = 0;
        s.entry = null; s.pending = null; s.fade = 0;
      }
      return;
    }

    // ── importance ────────────────────────────────────────────────────────
    //
    // The score must approximate what the light actually *does* to the pixels in
    // front of you, which is intensity / distance-to-the-surfaces-it-lights. The
    // previous form, `intensity * radius / (1 + d^2 * 0.55)`, rewarded radius twice
    // (once directly, once through the reach test) and decayed so fast with distance
    // that a 42 cd street lamp 30 m out still outranked the 16 cd lamp hanging four
    // metres over your head — so interior fixtures with the whole frame to light lost
    // their slot to something you could barely see. Rank by peak contribution at the
    // light's own working radius instead, and only kill an entry once three.js's
    // distance window has actually closed on it.
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const d2 = e.position.distanceToSquared(cameraPos);
      const r = e.radius;
      // three windows a point light to zero at `distance`; past that it is genuinely
      // free, so drop it. Inside, weight by how much of its pool the camera can see.
      const reach = d2 > (r + 6) * (r + 6) ? 0 : 1;
      // Contribution of the lamp to the surfaces around *it*, attenuated by how far
      // away those surfaces are from the eye. The +9 keeps a lamp you are standing
      // under from being scored at infinity.
      /**
       * ── VIEW-AWARE SLOTTING ─────────────────────────────────────────────
       *
       * Distance alone is the wrong ranking for a budget this tight. The review
       * found the two warehouse pendants and the wall head in the closeup framing
       * lit nothing — and the reason was not that they were far, it was that a
       * fixture *behind the camera* at the same distance scored identically and
       * took the slot. A light you cannot see contributes nothing to the frame no
       * matter how close it is.
       *
       * So the score is weighted by how far in front of the camera the fixture sits.
       * The floor of 0.35 is deliberate: a lamp just off-frame still spills onto
       * geometry that IS in frame, and dropping it to zero would make lights pop as
       * you turn. Costs one dot product per entry per frame.
       */
      let facing = 1;
      if (cameraDir) {
        const dx = e.position.x - cameraPos.x;
        const dy = e.position.y - cameraPos.y;
        const dz = e.position.z - cameraPos.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const dot = (dx * cameraDir.x + dy * cameraDir.y + dz * cameraDir.z) / len;
        facing = 0.35 + 0.65 * Math.max(0, dot);
        // Anything within a few metres is lighting the surfaces around the player
        // regardless of where they are looking; do not let facing starve it.
        if (d2 < 36) facing = Math.max(facing, 0.85);
      }
      e._score = reach * facing * (e.intensity / (9 + d2 * 0.16)) * (e.boost ?? 1);

      // Flicker is evaluated for *every* entry, slotted or not, so that a lamp's
      // ground pool and its point light pulse together even while the light itself
      // is outside the budget.
      if (e.flicker > 0) {
        const t = elapsed * e.flickerSpeed + e.phase;
        // layered sines + a hard dropout: reads as a failing ballast, not a sine wave
        const w = Math.sin(t) * 0.5 + Math.sin(t * 2.37 + 1.1) * 0.3 + Math.sin(t * 5.13 + 2.7) * 0.2;
        const dropout = Math.sin(t * 0.41 + e.phase) > 0.93 ? 0.35 : 1.0;
        const g = ((1 - e.flicker * 0.5) + e.flicker * 0.5 * (w * 0.5 + 0.5)) * dropout;
        e._gain += (g - e._gain) * Math.min(1, dt * 22);
      } else if (e._gain !== 1) {
        e._gain = 1;
      }
      e._live = 0;
    }

    // Partial selection: we only need the top `budget`, so an O(n*k) scan beats a sort
    // once a level has a few dozen practicals.
    const chosen = [];
    const k = Math.min(this.budget, entries.length);
    const used = new Set();
    for (let n = 0; n < k; n++) {
      let best = null; let bestScore = 0;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (used.has(e) || e._score <= 0) continue;
        if (e._score > bestScore) { bestScore = e._score; best = e; }
      }
      if (!best) break;
      used.add(best);
      chosen.push(best);
    }

    // ── slot assignment with hysteresis ───────────────────────────────────
    // Keep entries already resident where they are so nothing swaps needlessly.
    const unassigned = [];
    const resident = new Set();
    for (const s of this.slots) if (s.entry && used.has(s.entry)) resident.add(s.entry);
    for (const e of chosen) if (!resident.has(e)) unassigned.push(e);

    for (const s of this.slots) {
      if (s.entry && !used.has(s.entry)) {
        // Evict: fade out first, then take on whatever is queued.
        s.pending = unassigned.length ? unassigned.shift() : null;
        s.entry = null;
      } else if (!s.entry && !s.pending && unassigned.length) {
        s.pending = unassigned.shift();
      }
    }

    // ── drive the pool ────────────────────────────────────────────────────
    const fadeRate = dt > 0 ? Math.min(1, dt * 6.5) : 1;
    for (const s of this.slots) {
      const light = s.light;

      if (!s.entry) {
        s.fade += (0 - s.fade) * fadeRate;
        if (s.fade < 0.02) {
          s.fade = 0;
          if (s.pending) { s.entry = s.pending; s.pending = null; }
        }
      } else {
        s.fade += (1 - s.fade) * fadeRate;
      }

      const e = s.entry;
      if (!e) { light.intensity = 0; continue; }
      // Published so LightPools can cross-fade its ground decal against the real
      // light: a lamp that owns a slot lights its own floor properly and must not
      // also get a painted pool on top of it.
      e._live = s.fade;

      light.position.copy(e.position);
      light.color.copy(e.color);
      light.distance = e.radius;
      light.decay = this.decay;
      // Renormalised so a steeper exponent does not silently dim the fixture: the
      // intensity a caller passes is understood as "correct at ~1.6 m from the lamp",
      // which is where a wall-mounted head and its bracket actually sit.
      light.intensity = e.intensity * e._decayComp * s.fade * e._gain;
    }
  }

  dispose() {
    for (const s of this.slots) {
      s.light.parent?.remove(s.light);
      s.light.dispose?.();
    }
    this.slots.length = 0;
    this.entries.length = 0;
    this.group.parent?.remove(this.group);
  }
}
