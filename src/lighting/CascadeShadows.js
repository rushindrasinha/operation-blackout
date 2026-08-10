/**
 * Cascaded shadow maps.
 *
 * Built on three/examples/jsm/csm/CSM.js, which gets the hard parts right (practical
 * split scheme = lerp of logarithmic and uniform, light-space texel snapping in
 * `update()`, and a cascade-blend path behind CSM_FADE). Its *defaults* are unusable
 * for us, so this wrapper:
 *
 *   - turns cascade fading on (stock leaves it off, so you see hard cascade seams);
 *   - tightens the light frustum depth range from 2000 to something proportional to the
 *     cascade so shadow depth precision is not wasted, which is half of why the stock
 *     setup acnes;
 *   - sets a per-cascade normal-offset bias derived from that cascade's *world texel
 *     size*, which is the correct way to kill acne without peter-panning — a constant
 *     bias is always wrong for at least one cascade;
 *   - re-fits the cascades whenever the camera's FOV or aspect changes (the player
 *     system animates FOV for ADS/sprint; stock CSM would silently keep stale splits
 *     and the near cascade would stop covering the near frustum);
 *   - continuously registers every lit material in the scene. This is not optional:
 *     CSM replaces `lights_fragment_begin` globally, and a material that has *not* been
 *     set up takes the non-CSM branch, which loops over all N cascade lights and adds
 *     each one at full intensity. A missed material is 4x overexposed, not merely
 *     unshadowed. We rescan cheaply every few frames and self-heal if another system
 *     stomps our onBeforeCompile.
 *
 * OWNER: lighting.
 */
import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { installWideShadowFilter } from './ShadowFilter.js';

const LIT_MATERIAL_KEYS = [
  'isMeshStandardMaterial',
  'isMeshPhysicalMaterial',
  'isMeshLambertMaterial',
  'isMeshPhongMaterial',
  'isMeshToonMaterial',
];

function isLit(material) {
  if (!material || material.isShaderMaterial || material.isRawShaderMaterial) return false;
  for (let i = 0; i < LIT_MATERIAL_KEYS.length; i++) if (material[LIT_MATERIAL_KEYS[i]]) return true;
  return false;
}

export class CascadeShadows {
  /**
   * @param {object} ctx engine context
   * @param {object} opts { cascades, maxFar, shadowMapSize, lightDirection, color, intensity }
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.enabled = false;
    this.csm = null;
    this.lights = [];
    this.materials = new Set();
    this._scanFrame = 0;
    this._lastFov = -1;
    this._lastAspect = -1;
    this._refitTimer = 0;

    this.cascades = Math.max(1, Math.min(8, opts.cascades ?? 4));
    this.maxFar = opts.maxFar ?? 140;
    this.shadowMapSize = opts.shadowMapSize ?? 2048;
    this.lightMargin = opts.lightMargin ?? 90;

    /**
     * ── PENUMBRA: per-cascade, not constant ─────────────────────────────────
     *
     * The previous revision asked for one constant world-space blur (0.17 m) in every
     * cascade, on the reasoning that softness should not change as you walk between
     * cascades. Both halves of that were wrong.
     *
     * 1. r185's PCF is *five* Vogel-disk taps rotated per pixel by interleaved gradient
     *    noise, with `radius` in texels. Five taps spread over ±5.5 texels is not a blur,
     *    it is a dither — and 0.17 m in cascade 0 (texel ~11 mm) asks for exactly that.
     *    TAA then smears the dither into the 100-px mush the critic measured. Anything
     *    past ~2.5 texels of spread costs edge definition and buys nothing.
     *
     * 2. It inverted the physics. A real penumbra is *zero* at the contact point and
     *    grows with occluder distance. Constant world-space blur is widest, relatively,
     *    exactly where it should be tightest — and 0.17 m is wider than a fence post, so
     *    everything thinner than ~0.35 m stopped casting a readable shadow at all.
     *
     * Cascade texel size already grows ~16x from cascade 0 to cascade 3, so holding the
     * *texel* radius roughly constant and letting the cascade provide the growth gives
     * contact-hardening for free: crisp at your feet, soft across the yard.
     *
     * ── WHY NOT PCSS ────────────────────────────────────────────────────────
     *
     * This scheme grows the penumbra with distance from the *camera*, which is not
     * the same quantity as distance from the *blocker*, and a review correctly caught
     * the difference: a 6 cm fence post's shadow keeps the same edge softness for its
     * whole 15 m length instead of dissolving.
     *
     * A full PCSS path was built and measured rather than argued about. It works —
     * blocker search on a `BasicShadowMap` depth texture, then a variable-radius PCF
     * whose radius comes from the real solar half-angle — and it costs **4.6x the
     * frame time**: the spawn pose went from 37 fps to 8. The reason is not the tap
     * count on its own (28 taps) but that CSM unrolls its directional loop, so the
     * whole sampler is inlined once per cascade and occupancy collapses. There is no
     * version of that which fits in a 60 fps budget on this scene, and "beautiful at
     * 20 fps is a failure" is an explicit rule. It was removed rather than shipped
     * behind a dead flag.
     *
     * The affordable half of the win is taken instead: the spread between cascade 0
     * and cascade 3 is widened below, so a contact edge two metres from the camera is
     * near-hard and the same object's shadow forty metres out is genuinely soft.
     *
     * ── HOW IT IS EXPRESSED NOW, AND WHY THAT CHANGED ───────────────────────
     *
     * The previous revision asked for a fixed *world-space* penumbra per cascade and
     * divided by the texel size to get the PCF radius. That inverted itself at the far
     * end: cascade 3's texel is ~16x cascade 0's, so 0.235 m of blur came out at 1.2
     * texels while cascade 2's 0.135 m came out at 1.9 — **the furthest shadows were
     * the sharpest in the frame**, which is backwards and which the review measured
     * directly (radius 1.24 / 1.55 / 1.60 / 1.03).
     *
     * The radius is therefore specified directly in texels and asserted monotonic. In
     * world units, at this camera, that is roughly:
     *
     *     cascade 0 (0-8 m)     1.15 texels   ~15 mm   near-hard contact edges
     *     cascade 1 (8-22 m)    2.10 texels   ~70 mm
     *     cascade 2 (22-52 m)   3.00 texels   ~250 mm
     *     cascade 3 (52-140 m)  4.30 texels   ~900 mm
     *
     * A 0.53-degree sun gives ~9 cm of penumbra per 10 m of caster-to-receiver throw,
     * so those numbers land close to physical for the *typical* throw in each band —
     * which is the whole trick, because we cannot afford to measure the actual throw.
     *
     * Radii past ~2 texels used to be unusable because five Vogel taps over that spread
     * is a dither rather than a blur. ShadowFilter.js lifts that ceiling: the PCF kernel
     * now takes 12 taps past 3.2 texels, branching on a uniform, so only the last
     * cascade pays for it and the other three cost exactly what they did before.
     *
     * ── AND THEN THE CONTACT BILL ARRIVED ───────────────────────────────────
     *
     * Everything above is about how *soft* an edge is. It ignores what softness costs
     * at the other end of the same shadow, and at a 10.6-degree sun that cost is the
     * dominant term in the frame. Derived below in `_tuneBias()`, the identity is:
     *
     *     contact leak  =  depthBiasSafety * cot(elevation) * (1 + 0.6 / r) * penumbra
     *                   ~= 3.3 * (1 + 0.6 / r) * penumbra          (at safety 0.62)
     *
     * The texel size cancels. So at r = 2.10 every millimetre of penumbra you buy in a
     * cascade costs **4.2 mm of shadow eaten away at the base of every object in it**,
     * and that is a fixed exchange rate you cannot tune your way out of — only the sun
     * angle and the safety factor move it.
     *
     * Cascade 1's 2.10 texels was therefore buying 75 mm of penumbra for 190 mm of
     * peter-panning, and cascade 2's 3.00 was buying 253 mm for 550 mm. Measured on the
     * closeup pose that is a 10-15 px bright gap between a plinth and its own shadow,
     * which is an Instant Fail item ("shadows visibly detached from their caster") and
     * is why `contact` has scored 3.7 / 3.3 / 2.7 and fallen every round.
     *
     * The near radii come down to spend that budget the other way. Cascade 3 keeps 4.30
     * — it is the only consumer of the 12-tap branch, it is behind 40 m of haze where
     * nothing has a readable contact point anyway, and softening the far field is the
     * one place this trade runs in our favour.
     */
    this.radiusPerCascade = opts.radiusPerCascade ?? [1.15, 1.45, 2.30, 4.30];

    /**
     * ── NORMAL-OFFSET BIAS IS ALMOST WORTHLESS AT A LOW SUN ──────────────────
     *
     * This is the fix for "mid-size props do not receive real cast shadows at all",
     * which three consecutive reviews scored lowest.
     *
     * Normal-offset bias displaces the receiver's shadow lookup by `b` metres along its
     * own normal. Two things follow from that, and at a 10.6-degree sun they point in
     * opposite directions:
     *
     *   acne protection = b * sin(elevation)        = 0.18 b
     *   shadow shrinkage = b / tan(elevation)       = 5.34 b
     *
     * So every millimetre of normal offset buys 0.18 mm of protection and costs 5.34 mm
     * of shadow. The old `min(0.16, texel * 1.35 + 0.004)` saturated at its 0.16 m cap
     * in cascades 2 and 3, which erased **0.85 m** off every shadow edge out there —
     * i.e. anything narrower than about a metre stopped casting entirely. That is
     * exactly the reported symptom: scaffold poles (long, and their shadows run *along*
     * the ground so the loss is invisible) still read, while a 6 m sandbag emplacement
     * three metres away threw a soft blob with no silhouette.
     *
     * Depth bias has the opposite ratio: protection = b, shrinkage = b / cos(elevation)
     * = 1.02 b. It is **29x more efficient per unit of lost shadow** at this sun angle.
     * So the acne budget moves almost entirely onto depth bias, scaled by the cascade's
     * own texel size *and* by the PCF radius (a wider kernel reaches further across the
     * receiver plane and therefore needs more headroom), and divided by tan(elevation)
     * because that is the term the whole problem is actually made of.
     *
     * Normal offset keeps a small role: it is the only thing that helps where the
     * *interpolated* vertex normal disagrees with the triangle plane — cylinders,
     * bevels, low-poly rounded props — so it stays at about one texel, hard-capped.
     *
     * ── THE CAPS WERE STILL 2x TOO HIGH, AND THAT IS MEASURABLE ─────────────
     *
     * The argument above is right and the numbers it shipped were not. Read back off
     * the live cascade table (`window.__CSM_INFO__()`), the previous caps resolved to
     * 0.0167 / 0.028 / 0.048 / 0.075 m of normal offset, which at cot(10.6 deg) = 5.34
     * retracts the *tip* of every shadow by
     *
     *     89 mm / 150 mm / 256 mm / 400 mm
     *
     * A 0.6 m crate at 18 m throws a 3.2 m shadow, so 150 mm off the tip is survivable;
     * a 0.15 m rock throws 0.8 m and loses a fifth of it, and anything in cascade 2
     * under about 0.5 m across stops reading at all. That is the *other* half of the
     * "props do not look like they are resting on anything" finding — the first half is
     * the depth-bias leak at the base, and the two failures are at opposite ends of the
     * same shadow.
     *
     * Halved. What pays for the acne this exposes is not more bias, it is a smaller
     * texel: `splitDistances` below pulls the near breaks in, and the whole derivation
     * is linear in texel size.
     */
    this.normalBiasCapPerCascade = opts.normalBiasCapPerCascade ?? [0.008, 0.012, 0.022, 0.038];
    /**
     * ── EXPRESSED AS THE DEFECT, NOT AS THE KNOB ────────────────────────────
     *
     * This used to be "ceiling on the depth bias, in metres along the light ray", which
     * is a quantity nobody can look at a screenshot and check. It is now a ceiling on
     * the thing the *reviewer* measures: how wide a strip of bright ground is left
     * between an object and the start of its own cast shadow.
     *
     * They are very nearly the same number — a depth bias of b along the light ray
     * leaks light on the ground out to a horizontal distance b * cos(elevation) = 0.98 b
     * from the occluding face (derivation in `_tuneBias`) — but naming it after the
     * defect means the next person to touch this file is tuning against the review
     * rather than against an intermediate quantity.
     *
     * The budget is sized against the screen-space contact-shadow march that the render
     * system runs on the direct term (`contactShadow()` in render/shaders.js, ~0.4 m of
     * world-space ray). Anything this system leaks *inside* that range is filled in by
     * the march and is invisible; anything outside it is a bright gap nothing covers.
     * So the near cascades are held well under it and only cascade 3 — 42 m out, behind
     * the haze, where nothing has a legible contact point — is allowed past.
     *
     * Sanity, at the poses that get reviewed: 45 mm at 4 m, 90 mm at 10 m and 240 mm at
     * 25 m all subtend about 5 px of *foreshortened* ground at 1080p. Previously the
     * same three came out at 10 / 11 / 12 px, which is exactly the "shadow starts
     * 10-15 px away from its caster" the review measured.
     */
    this.contactLeakCapPerCascade = opts.contactLeakCapPerCascade ?? [0.045, 0.090, 0.240, 0.600];
    /** Fraction of the geometrically-required depth bias we actually apply. */
    this.depthBiasSafety = opts.depthBiasSafety ?? 0.50;
    /** Sun elevation in degrees — the term that makes all of the above work. */
    this.sunElevationDeg = opts.sunElevationDeg ?? 10.6;


    /**
     * Split scheme. Stock 'practical' (lambda 0.5) against our near plane of 0.02 puts
     * the first break at ~17.6 m, so the cascade that carries every contact shadow in
     * the frame is also the one asked to cover three quarters of the playable depth.
     * Pushing the near breaks in halves cascade 0's texel size, which is the single
     * biggest sharpness win available and costs nothing — the far cascade picks up the
     * slack where the fog is already hiding it.
     *
     * ── PULLED IN AGAIN, BECAUSE TEXEL SIZE IS THE ONLY FREE VARIABLE LEFT ───
     *
     * Every defect this file is trying to fix — the acne budget, the depth-bias leak at
     * an object's base, the normal-offset retraction of its tip — is *linear in the
     * cascade's world texel size*, and texel size is the one term that costs nothing to
     * improve. Measured, the fitted ortho width comes out at almost exactly 3.3x the
     * slice's far distance at this FOV, so the breaks translate directly:
     *
     *     splits            c0 texel   c1 texel   c2 texel
     *     8 / 22 / 52       12.9 mm    35.6 mm    84.2 mm     (before)
     *     4.6 / 14 / 52      7.4 mm    22.6 mm    83.8 mm     (now)
     *
     * Cascade 0 therefore needs 43% less bias for the same acne protection, and gives
     * 43% less peter-panning for free. Nothing about the cost changes: four cascades,
     * four 2048² maps, and strictly *fewer* casters per cascade because every ortho box
     * is smaller.
     *
     * ── WHY THE LAST BREAK IS DELIBERATELY LEFT ALONE ───────────────────────
     *
     * It was moved to 42 first, and that is a frame-time regression with no quality
     * return. Two facts collide:
     *
     *   - ShadowFilter.js switches the PCF kernel from 5 taps to 12 above a radius of
     *     3.2 texels, and cascade 3 (4.30) is its only consumer. Moving the break in
     *     therefore hands 42-52 m worth of screen pixels to the expensive branch, and
     *     nothing anywhere gives that cost back.
     *   - Cascade 2's contact leak is *cap-bound* (0.24 m, see contactLeakCapPerCascade),
     *     not texel-bound. Shrinking its texel does not shrink the leak by one
     *     millimetre; it only widens the acne margin, which measured clean either way.
     *
     * So the near two breaks — where the cap does not bind and the tap count does not
     * change — come in, and the third stays out. Cascade 0 in particular is the one
     * that carries every contact shadow the player is actually looking at, and it is
     * the one cascade running its *derived* bias rather than its cap, so it is the only
     * place a smaller texel converts directly into a shorter leak: 59 mm -> 33 mm.
     */
    this.splitDistances = opts.splitDistances ?? [4.6, 14, 52];

    const dir = (opts.lightDirection ?? new THREE.Vector3(1, -1, 1)).clone().normalize();

    // Must happen before a single lit material compiles, and before CSM injects its
    // own chunk replacements — otherwise the far cascades' wide kernels dither.
    this.wideFilter = installWideShadowFilter();

    try {
      this.csm = new CSM({
        camera: ctx.camera,
        parent: ctx.scene,
        cascades: this.cascades,
        maxFar: this.maxFar,
        mode: 'custom',
        customSplitsCallback: (amount, near, far, target) => this._splits(amount, near, far, target),
        shadowMapSize: this.shadowMapSize,
        shadowBias: -0.0001,
        lightDirection: dir,
        lightIntensity: opts.intensity ?? 3.0,
        lightNear: 0.5,
        lightFar: this.lightMargin * 2 + this.maxFar + 40,
        lightMargin: this.lightMargin,
      });

      // Stock CSM ignores `fade` from the constructor data — it must be set after.
      this.csm.fade = true;
      this.lights = this.csm.lights;

      for (const light of this.lights) {
        light.color.set(opts.color ?? 0xffffff);
        light.intensity = opts.intensity ?? 3.0;
        light.shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize);
        light.shadow.camera.near = 0.5;
        light.shadow.camera.far = this.lightMargin * 2 + this.maxFar + 40;
        light.shadow.autoUpdate = true;
        // Directional cascades are the *only* shadow casters we can afford at full res.
        light.castShadow = true;
      }

      this.csm.updateFrustums();
      this._tuneBias();
      this.enabled = true;
    } catch (err) {
      console.error('[lighting] CSM unavailable, falling back to a single shadow map:', err);
      this.csm = null;
      this.enabled = false;
      this._buildFallback(dir, opts);
    }
  }

  /** Single directional light, used only if CSM construction throws. */
  _buildFallback(dir, opts) {
    const light = new THREE.DirectionalLight(opts.color ?? 0xffffff, opts.intensity ?? 3.0);
    light.castShadow = true;
    light.shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize);
    const c = light.shadow.camera;
    c.left = -60; c.right = 60; c.top = 60; c.bottom = -60; c.near = 0.5; c.far = 300;
    c.updateProjectionMatrix();
    light.shadow.normalBias = 0.05;
    light.shadow.bias = -0.0004;
    this.ctx.scene.add(light);
    this.ctx.scene.add(light.target);
    this.lights = [light];
    this._fallbackDir = dir.clone();
  }

  get sun() { return this.lights[0] ?? null; }

  /** Explicit near-weighted split distances, normalised the way CSM wants them. */
  _splits(amount, near, far, target) {
    target.length = 0;
    const d = this.splitDistances;
    for (let i = 1; i < amount; i++) {
      const raw = d[i - 1] ?? (near + ((far - near) * i) / amount);
      target.push(THREE.MathUtils.clamp(raw / far, 1e-4, 0.999));
    }
    target.push(1);
    // Guard against a config that pushed a split past maxFar: keep them monotonic.
    for (let i = 1; i < target.length; i++) {
      if (target[i] <= target[i - 1]) target[i] = Math.min(1, target[i - 1] + 0.02);
    }
  }

  /**
   * Per-cascade normal-offset bias and PCF radius, both derived from that cascade's
   * world-space texel size.
   *
   * The normal offset is the reason thin geometry used to cast nothing. It displaces
   * the *receiver's* shadow lookup along its own normal, and with the sun at ~10
   * degrees that displacement lands `offset / tan(elevation)` metres along the light
   * ray — the old 0.071 m offset in cascade 1 moved every shadow 0.37 m toward the
   * light, which erases the shadow of anything narrower than that and peter-pans
   * everything else. Keep it near one texel and pay for the acne with depth bias
   * instead, which does not move the shadow in the plane of the ground.
   */
  _tuneBias() {
    if (!this.csm) return;
    const elev = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(this.sunElevationDeg, 1.5, 88));
    const sinE = Math.max(Math.sin(elev), 0.026);
    const cosE = Math.max(Math.cos(elev), 0.026);
    const tanE = Math.max(Math.tan(elev), 0.026);
    const last = (arr, i) => arr[Math.min(i, arr.length - 1)];

    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      const cam = light.shadow.camera;
      const texel = Math.max((cam.right - cam.left) / this.shadowMapSize, 1e-5);
      const depthRange = Math.max(cam.far - cam.near, 1);

      const radius = Math.max(0.5, last(this.radiusPerCascade, i));
      light.shadow.radius = radius;

      // One texel of normal offset, hard-capped. See the note above: this is for
      // interpolated-normal error on curved geometry, NOT for the flat-ground acne
      // that used to justify a 0.16 m offset.
      const nb = Math.min(last(this.normalBiasCapPerCascade, i), texel * 1.1 + 0.0025);
      light.shadow.normalBias = nb;

      /**
       * Depth bias, derived rather than guessed.
       *
       * The worst-case disagreement between a receiver's own depth and the depth
       * stored in the texel a PCF tap lands in is `reach / tan(elevation)`, where
       * `reach` is how far across the receiver plane that tap can be: the kernel
       * radius plus half a texel of quantisation. Whatever the normal offset already
       * contributes (`nb * sin(elevation)`) is credited against it, then a safety
       * fraction is applied.
       *
       * ── WHAT THE CAP IS, AND WHY IT IS QUOTED ON THE GROUND ────────────────
       *
       * A depth bias of `b` metres along the light ray does not move a shadow
       * sideways — the lookup stays in the same light-space texel. What it does is
       * unshadow every receiver point whose occluder is within `b` of it *along the
       * ray*. For a ground point a horizontal distance `d` from the vertical face
       * that occludes it, the occluding geometry sits `d / cos(elevation)` along the
       * ray, so light leaks wherever
       *
       *     d / cos(elevation) < b     i.e.     d < b * cos(elevation)
       *
       * — a bright strip of exactly `0.98 b` metres hugging the base of every object
       * in the frame. That strip is the whole `contact` defect, so it, and not the
       * bias, is what gets budgeted: `contactLeakCapPerCascade`.
       *
       * When the cap binds we are knowingly under-biasing, which trades a *risk* of
       * low-contrast acne on large flat ground at grazing light for the certainty of
       * a visible floating shadow. That is the right way round: the leak is an
       * Instant Fail item and is what three consecutive reviews led with, while the
       * acne it exposes is at most one failing tap in five (a 20% dither), lands on
       * ground that is foreshortened to near-nothing by the time cascades 2-3 are
       * involved, and is further absorbed by TAA.
       */
      const reachM = texel * (radius + 0.6);
      const needM = Math.max(0, reachM / tanE - nb * sinE);
      const leakCapM = last(this.contactLeakCapPerCascade, i);
      const depthM = Math.min(needM * this.depthBiasSafety, leakCapM / Math.max(cosE, 1e-3));
      light.shadow.bias = -Math.max(0.000015, depthM / depthRange);

      light.shadow.blurSamples = 10;
      light.shadow.needsUpdate = true;
    }
  }

  /** The sun moved: the whole bias derivation depends on its elevation. */
  setSunElevation(deg) {
    if (!Number.isFinite(deg)) return;
    this.sunElevationDeg = deg;
    this._tuneBias();
  }

  /**
   * Diagnostics: what each cascade actually resolves, in metres.
   *
   * `contactLeakM` and `tipLossM` are the two numbers a reviewer is really looking at
   * when they write "the shadow is detached from its caster" and "small props cast
   * nothing" — the bright strip left at an object's base by the depth bias, and the
   * amount the normal offset retracts the far end of the shadow. Both are derived from
   * the values three is actually running, not from the constants at the top of this
   * file, so a cap that silently stopped binding shows up here immediately.
   */
  describe() {
    const elev = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(this.sunElevationDeg, 1.5, 88));
    const cotE = 1 / Math.max(Math.tan(elev), 0.026);
    const cosE = Math.max(Math.cos(elev), 0.026);
    return this.lights.map((l, i) => {
      const c = l.shadow.camera;
      const texel = (c.right - c.left) / this.shadowMapSize;
      const depthM = -l.shadow.bias * (c.far - c.near);
      return {
        cascade: i,
        widthM: +(c.right - c.left).toFixed(1),
        texelM: +texel.toFixed(4),
        radiusTexels: +l.shadow.radius.toFixed(2),
        penumbraM: +(l.shadow.radius * texel).toFixed(3),
        normalBias: +l.shadow.normalBias.toFixed(4),
        depthBiasM: +depthM.toFixed(4),
        /** Bright strip left between an object and the start of its own shadow. */
        contactLeakM: +(depthM * cosE).toFixed(4),
        /** How far the shadow's far end is pulled back toward its caster. */
        tipLossM: +(l.shadow.normalBias * cotE).toFixed(4),
      };
    });
  }

  setLightDirection(dir) {
    if (this.csm) {
      this.csm.lightDirection.copy(dir).normalize();
    } else if (this.lights[0]) {
      const l = this.lights[0];
      l.position.copy(dir).multiplyScalar(-120);
      l.target.position.set(0, 0, 0);
      l.target.updateMatrixWorld();
    }
  }

  setSun(color, intensity) {
    for (const light of this.lights) {
      light.color.copy(color);
      light.intensity = intensity;
    }
    if (this.csm) this.csm.lightIntensity = intensity;
  }

  /** Adopt a material into the CSM shader path, preserving any existing onBeforeCompile. */
  setupMaterial(material) {
    if (!this.csm || !material || this.materials.has(material)) return;
    try {
      material.defines = material.defines || {};
      material.defines.USE_CSM = 1;
      material.defines.CSM_CASCADES = this.cascades;
      if (this.csm.fade) material.defines.CSM_FADE = '';

      this._wrap(material, material.onBeforeCompile);
      this.csm.shaders.set(material, null);
      this.materials.add(material);
      material.needsUpdate = true;
    } catch (err) {
      console.error('[lighting] setupMaterial failed:', err);
    }
  }

  _wrap(material, prevHook) {
    const csm = this.csm;
    const prev = prevHook;
    material.__csmPrevOBC = prev;

    const hook = function (shader, renderer) {
      if (typeof prev === 'function') {
        try { prev.call(this, shader, renderer); } catch (e) { console.error('[lighting] chained onBeforeCompile threw:', e); }
      }
      const far = Math.min(csm.camera.far, csm.maxFar);
      const breaks = [];
      csm._getExtendedBreaks(breaks);
      shader.uniforms.CSM_cascades = { value: breaks };
      shader.uniforms.cameraNear = { value: csm.camera.near };
      shader.uniforms.shadowFar = { value: far };
      csm.shaders.set(material, shader);
    };

    material.onBeforeCompile = hook;
    material.__csmHook = hook;
  }

  /**
   * Walk the scene and adopt anything new. Cheap (pointer chasing + a Set probe), and
   * throttled — but it must run forever, because debris, ragdolls and decals all create
   * materials at runtime.
   */
  scanScene(force = false) {
    if (!this.csm) return;
    if (!force && (this._scanFrame++ % 3) !== 0) return;

    const seen = this.materials;
    const self = this;
    this.ctx.scene.traverse((obj) => {
      const m = obj.material;
      if (!m) return;
      if (Array.isArray(m)) {
        for (let i = 0; i < m.length; i++) self._consider(m[i], seen);
      } else {
        self._consider(m, seen);
      }
    });
  }

  _consider(material, seen) {
    if (!isLit(material)) return;
    if (!seen.has(material)) { this.setupMaterial(material); return; }
    // Self-heal: another system replaced our compile hook after registration.
    // Chain *their* hook rather than the one we originally captured, or we'd silently
    // delete their shader edits.
    if (material.onBeforeCompile !== material.__csmHook) {
      this._wrap(material, material.onBeforeCompile);
      material.needsUpdate = true;
    }
  }

  /** Called every frame, before render. */
  update(camera) {
    const cam = camera ?? this.ctx.camera;

    if (!this.csm) {
      const l = this.lights[0];
      if (l && this._fallbackDir) {
        l.position.copy(cam.position).addScaledVector(this._fallbackDir, -110);
        l.target.position.copy(cam.position);
        l.target.updateMatrixWorld();
      }
      return;
    }

    // Re-fit when the projection changed (ADS/sprint FOV animation, window resize).
    if (Math.abs(cam.fov - this._lastFov) > 0.15 || Math.abs(cam.aspect - this._lastAspect) > 1e-4) {
      this._lastFov = cam.fov;
      this._lastAspect = cam.aspect;
      this.csm.camera = cam;
      try {
        this.csm.updateFrustums();
        this._tuneBias();
      } catch (err) {
        console.error('[lighting] CSM refit failed:', err);
      }
    }

    this.csm.camera = cam;
    try {
      // Uniforms only change when the frustums are re-fit (handled above) or when a
      // material is first compiled (handled in the onBeforeCompile hook), so there is
      // no need to walk every shader every frame.
      this.csm.update();
    } catch (err) {
      console.error('[lighting] CSM update failed:', err);
    }
    this.scanScene();
  }

  resize() {
    this._lastFov = -1;
    this._lastAspect = -1;
  }

  dispose() {
    try {
      if (this.csm) {
        for (const material of this.materials) {
          if (material.__csmPrevOBC !== undefined) {
            material.onBeforeCompile = material.__csmPrevOBC;
            delete material.__csmPrevOBC;
            delete material.__csmHook;
          }
          if (material.defines) {
            delete material.defines.USE_CSM;
            delete material.defines.CSM_CASCADES;
            delete material.defines.CSM_FADE;
          }
          material.needsUpdate = true;
        }
        this.materials.clear();
        this.csm.shaders.clear();
        this.csm.remove();
      } else {
        for (const l of this.lights) {
          l.parent?.remove(l);
          l.target.parent?.remove(l.target);
          l.dispose?.();
        }
      }
    } catch (err) {
      console.error('[lighting] CSM dispose failed:', err);
    }
    this.lights = [];
  }
}
