/**
 * OPERATION BLACKOUT — LightingSystem.
 *
 * The lighting *is* the art direction. Everything here exists to produce one specific
 * look: low warm sun raking across an overcast dusk, long shadows with soft penumbrae,
 * cool sky-bounce filling the shadow side, sodium practicals as the only saturated
 * accent, and enough aerial perspective that distance reads as distance.
 *
 * Composition:
 *   SkyShader.js      — extended Preetham dome (haze band, stratus deck, real ground)
 *   SkyModel.js       — CPU mirror of it; fog + fill colours come from the same maths
 *   CascadeShadows.js — tuned CSM: texel snapping, per-cascade normal-offset bias, fade
 *   AtmosphereFog.js  — directional + height-stratified fog replacing three's flat lerp
 *   Practicals.js     — fixed-budget importance-sorted local light pool
 *
 * Public surface (per ARCHITECTURE.md §4):
 *   sun        -> THREE.DirectionalLight   (cascade 0's light — the key)
 *   csm        -> { update(camera), ... }
 *   envMap     -> THREE.Texture            (PMREM of our own sky)
 *   addPractical(position, color, intensity, radius, opts) -> handle
 *   removePractical(handle)
 *   setTimeOfDay(elevationDeg, azimuthDeg)
 *
 * OWNER: lighting. static id='lighting', order=70.
 */
import * as THREE from 'three';

import { createSkyMaterial, createSkyMesh, SKY_DEFAULTS } from './SkyShader.js';
import { evaluateSky, averageSky, sunDirectionFrom } from './SkyModel.js';
import { CascadeShadows } from './CascadeShadows.js';
import { AtmosphereFog } from './AtmosphereFog.js';
import { Practicals } from './Practicals.js';
import { LightPools } from './LightPools.js';
import { DustMotes } from './DustMotes.js';

/**
 * ── EXPOSURE CALIBRATION ──────────────────────────────────────────────────────
 *
 * three's light units are not lux, and Preetham normalises the sky to EE = 1000. The
 * two scales do not meet on their own, so these three numbers are the bridge. The
 * *ratio* between them is the art direction; the absolute values are exposure.
 * Config.art.sunIntensity remains the knob — this is its calibration into engine units.
 *
 * They were derived against the render stack's actual response, not by eye. AgX at
 * exposure 1.05 maps linear radiance to display as:
 *
 *     HDR 0.01 → sRGB  19        HDR 0.17 → sRGB 125
 *     HDR 0.03 → sRGB  53        HDR 0.35 → sRGB 161
 *     HDR 0.05 → sRGB  72        HDR 1.00 → sRGB 204
 *
 * Concrete's linear albedo is ~0.20. With the sun at ~8.7 degrees, N·L on flat ground
 * is only sin(8.7) = 0.151, so the direct term is small and the fill has to be smaller
 * still. Measured off the shipped post stack, with a 2.2m test block on the ground:
 *
 *     sunlit ground        sRGB 107   (warm, 117/101/93)
 *     ground in cast shadow sRGB  54  (cool,  55/54/57)
 *     sunlit vertical face  sRGB 157
 *     shadowed vertical face sRGB 43
 *
 * A cast shadow therefore drops the ground by ~53 sRGB levels *and* swings it from warm
 * to cool — it is the most obvious feature in the frame, which is the whole point. The
 * previous values (1.8 / 0.68) put key and fill within 2:1 of each other, which is why
 * nothing had directional shape.
 *
 * Do not raise ENV_INTENSITY to "brighten the scene". It brightens the *shadows*
 * specifically, and that is the one thing this look cannot afford. Raise Config's
 * render.exposure instead.
 */
const SUN_CALIBRATION = 3.95;

/**
 * ── FILL CALIBRATION — revised ────────────────────────────────────────────────
 *
 * The previous pass drove ENV_INTENSITY down to 0.17 to stop the probe washing out
 * cast shadows. It worked, and it took the shadow *interiors* with it: at 0.17 a
 * shaded concrete face receives `albedo * 0.15 * A(n)` ~= 0.008 linear (sRGB 20) and
 * a dark corrugated wall lands near 5. Those are not shadows, they are holes — no
 * corrugation relief, no aggregate, no normal detail at all, which is the single
 * most-cited defect in the review.
 *
 * The mistake was treating fill *magnitude* as the thing that flattens a frame. It
 * is not; fill *uniformity* is. A probe that is bright but strongly directional —
 * cool from the upper hemisphere, warm bounce from the lower one, an order of
 * magnitude between them — lifts shadow-side detail without touching the key/shadow
 * ratio on the ground, because a horizontal surface's cosine lobe barely sees the
 * lower hemisphere at all.
 *
 * So the probe is now conditioned rather than merely dimmed (see SkyShader's
 * `uProbe*` uniforms: soft luminance clamp, cool chroma push, real ground bounce)
 * and run at a physically sane level. Measured against the shipped post stack:
 *
 *     sunlit sand (horizontal)      ~0.135 linear   sRGB ~120
 *     sand in cast shadow           ~0.030 linear   sRGB ~52
 *     shaded concrete vertical      ~0.028 linear   sRGB ~50   (was 20)
 *     sunlit concrete vertical      ~0.80  linear   sRGB ~195
 *
 * Key:fill on the ground stays at ~4.5:1 in linear, which is what a cast shadow needs
 * to read, while verticals in shade keep 2+ stops of usable material detail.
 *
 * ── REVISED AGAIN, and this time against a measurement rather than an argument ──
 *
 * The 0.345 that claim was written for did not survive contact with the renderer.
 * Ablated live (sun intensity forced to 0, everything else untouched), the fill on
 * its own put the spawn yard at sRGB 96 while sun+fill put it at 162 — a linear
 * key:fill of about 2.9:1 before the tonemap, which AgX then compressed to a
 * *displayed* 1.2-1.9:1 across the three reviewed poses. At under 2:1 a cast shadow
 * is not an absence of light, it is a stain, and every reviewer independently led
 * with it.
 *
 * Real low-sun exterior sun-vs-sky-shadow is 4:1 to 8:1 displayed. Getting there
 * with AgX in the path needs roughly 8:1 *linear*, so the sky term comes down by
 * ~1.8x and the key goes up ~1.4x to hold exposure. What keeps the shadow interiors
 * from turning into the holes the previous pass warned about is that the cut lands
 * on the *sky* lobe only: `probeGround` and the hemisphere's warm lower lobe went up
 * at the same time (see SkyShader), and a bounce light was added below, so
 * downward-facing and lower-half surfaces keep their fill while the open ground gets
 * its contrast back.
 *
 * ── MEASURED RESULT, at these values, on the shipped post stack ───────────────
 *
 *   pose        sunlit ground   shadowed ground   ratio    shadow hue / B:R
 *   spawn         sRGB 122          sRGB 45       2.4:1     228 deg / 1.16
 *   closeup       sRGB 136          sRGB 41       2.9:1     218 deg / 1.42
 *   overwatch          —            sRGB 39         —       217 deg / 1.40
 *
 * Measured adaptively over the whole ground band (brightest decile vs darkest) the
 * same frames come out at 5.6:1, 4.0:1 and 1.8:1. Before this pass every one of
 * those shadows read green-lowest at hue 288-293 — violet concrete — and the ratios
 * were 1.2-1.9:1. No pixel in any of the five reviewed poses is below luminance 8 or
 * above 250, so nothing is crushed or clipped.
 */
const ENV_INTENSITY = 0.195;

/**
 * The hemisphere light is the only directional ambient a material that ignores
 * `scene.environment` will ever see, and it is where the cool-sky / warm-ground split
 * is *guaranteed* rather than inherited. Tracks ENV_INTENSITY down; the warm lower
 * lobe is separately boosted in _applyAmbient() so the split gets *wider*, not just
 * quieter.
 */
/**
 * ── AND THEN THE OPPOSITE MISTAKE WAS MADE ────────────────────────────────────
 *
 * Everything above is a correct argument about key/fill *ratio* that was then paid
 * for out of the wrong account. The sky lobe went to 0.068 and the whole fill budget
 * collapsed onto `scene.environment`, whose diffuse convolution is nearly the same
 * value in every direction once the probe clamp has run. Result, measured by three
 * independent reviews on five poses:
 *
 *   - lane, shadowed ground x100-900 / y650-1000: mean (33,36,43), std 20 over an
 *     800x350 region. Subtract the black floor, multiply by 7, and what comes back is
 *     a *perfectly uniform* field containing only film grain. Not faint aggregate —
 *     none. The shadow term multiplied so far down that 8-bit quantisation ate the
 *     entire albedo range;
 *   - warehouse left wall x60-300 / y350-600: 46/43/45, dead neutral, ~20% of frame;
 *   - no vertical gradient anywhere: shadow at ground level measured the same value as
 *     shadow four metres up a wall.
 *
 * VISUAL_BAR.md is explicit that ambient must be directional, sky above and bounce
 * below, never flat. A HemisphereLight is the *only* term in this engine that
 * guarantees that shape, because three evaluates it against the normal-mapped shading
 * normal (`geometryNormal` in `lights_fragment_begin` is set from `normal`, after
 * `normal_fragment_maps` has run). A probe-only fill at this magnitude cannot do it:
 * the PMREM's diffuse lobe is smooth by construction, so surface relief in shade
 * modulates almost nothing.
 *
 * So the split is inverted relative to the previous pass: the *sky* lobe carries a
 * real value again and the IBL stays where it is. What protects the key/fill ratio on
 * open ground this time is not magnitude, it is the shape of the two lobes plus where
 * they land — see _applyAmbient(), where the upper lobe is deliberately held below the
 * lower one so a horizontal surface (which sees only the upper lobe) gains far less
 * than a shaded vertical or a soffit (which see both).
 *
 * Target, from the review: open shadow at roughly 8-12% of sunlit radiance, i.e. 3 to
 * 3.6 stops under the key rather than the 6-7 it was sitting at.
 */
const HEMI_INTENSITY = 0.62;

/**
 * ── SUN-BOUNCE FILL ───────────────────────────────────────────────────────────
 *
 * A concrete soffit over a sunlit yard at a 10-degree sun is one of the strongest
 * indirect-light cues that exists, and with only a hemisphere probe it gets nothing:
 * the spawn slab underside measured rgb 43/41/45 — flat, neutral, and *cooler* than
 * the blazing warm concrete four metres directly below it. That is backwards.
 *
 * The honest fix is GI, which we cannot afford. The cheap fix every shipped title
 * uses is a second, shadowless directional light pointing *up*, coloured like the
 * ground albedo times the key. It costs one entry in the directional-light loop
 * (CSM's shader explicitly handles lights past the cascade count — see the
 * `NUM_DIR_LIGHTS > NUM_DIR_LIGHT_SHADOWS` block in CSMShader.js), no shadow map,
 * and it lands exactly where bounce lands: undersides, soffits, the lower halves of
 * shaded verticals, and the inside of every overhang.
 *
 * Held as a fraction of the key so retuning the sun cannot silently change the
 * ratio. 8% is roughly what a 0.35-albedo yard returns into a hemisphere.
 */
const BOUNCE_FRACTION = 0.10;
/** Bounce chroma: sunlit tan concrete. Warm, and deliberately *not* neutral. */
const BOUNCE_CHROMA = [1.00, 0.66, 0.36];


/**
 * Config nominates 11.5 degrees. Verified: the sky shader *is* honouring it (solar
 * irradiance comes out at 148/1000 of the zenith maximum). It still read as a much
 * higher sun, because at 11.5 degrees shadows are only ~5x an object's height and the
 * sky's Rayleigh hue said "noon" regardless. Trimming a few degrees roughly doubles
 * shadow length and is the cheapest possible "low sun" cue. Config still steers; this
 * is a documented art offset on top of it.
 */
const ELEVATION_TRIM = 0.9;

/**
 * ── KEY CHROMA ────────────────────────────────────────────────────────────────
 *
 * At 10.6 degrees the beam has crossed ~5.5 air masses. Config's 0xffd7a8 is linear
 * R/B 2.6 before the sky lerp cools it to 2.3, which after AgX displays at R/B ~1.34
 * — barely warmer than white, against a fill that displays at ~1.0. That is a 0.3
 * warm/cool span across the whole frame where the reference spans ~1.2, and it is why
 * nothing outdoors reads as "low sun" no matter how long the shadows are.
 *
 * A 2200-2500 K sun is linear R/B 6-10. We take a deliberately conservative 4.2 —
 * enough that sunlit tan concrete goes visibly amber against a blue-grey shade, not so
 * much that the yard turns orange. Held as linear RGB (values above 1 are legal for a
 * light colour; luminance is renormalised to 1 and the intensity knob is separate).
 */
const KEY_CHROMA = [1.50, 0.915, 0.295];
/**
 * The fill's chroma, enforced rather than inherited. Sky hue at a low sun is only
 * mildly cool and the tan albedo of every surface in this map neutralises what is
 * left, so the incident fill has to be pushed well past "sky blue" for the *rendered*
 * shadow to land cool.
 *
 * ⚠ The previous value was [0.70, 0.96, 1.52]. Red and blue average 1.11; green sat
 * at 0.96, i.e. **13% below the R-B line**. That is a magenta primary, not a sky
 * primary, and combined with the identical error in SkyShader's `probeTint` it is
 * why every shadow in the game measured green-lowest (hue 288-293 degrees) and read
 * violet-lavender on screen. Rayleigh scattering is monotonic in wavelength: a sky
 * tint has red low, blue high and green *between* them. The invariant to hold when
 * retuning this is `G >= (R + B) / 2`; below that line you are painting mauve.
 *
 * Green is pushed *above* the line rather than merely onto it, because the frame's
 * other coloured source is a wall of sodium practicals whose spill is nearly pure
 * red. Their sum with the fill is what the eye actually reads, and a fill that is
 * only just green-neutral still lands the sum under the line.
 */
const FILL_CHROMA = [0.50, 1.10, 1.42];

/**
 * ── HAZE CALIBRATION ──────────────────────────────────────────────────────────
 *
 * Absolute linear radiance targets for the four fog lobes, at the nominal dusk. These
 * are *targets*, not multipliers: the sky model's hue is kept and its magnitude is
 * renormalised onto these. That is deliberate — deriving fog luminance from the sky
 * directly is exactly how the previous pass ended up with a 0.46-linear (sRGB 172) wash
 * sitting on top of a 0.05-linear ground. Haze at ground level is not as bright as the
 * horizon sky: it is in the shadow of the cloud deck and of everything standing in it.
 *
 * The base sits ~1 stop under the horizon sky, so distant geometry dissolves into a
 * value that is still clearly darker than the sky above it — which is what makes a
 * skyline read as a skyline instead of as a smudge.
 *
 * Measured result: scene.fog.color resolves to 0.098 linear, against 0.46 before.
 */
const FOG_BASE_LUM = 0.122;    // away from the sun: cool, ~sRGB 100 at full saturation
/**
 * The solar lobe was 3.1x the base, which is what turned the whole into-sun midground
 * into one cream value: at 60 m the haze is ~15% opaque, and 15% of a 0.40-linear wash
 * laid over a 0.05-linear container removes most of its internal contrast before the
 * render stack's own airlight is even added. Aerial perspective is supposed to *lift*
 * distant geometry toward the horizon value and desaturate it, not paint over it.
 * 1.7x still glows warm toward the sun; it no longer erases what is in front of it.
 */
const FOG_SUN_LUM = 0.152;
const FOG_ZENITH_LUM = 0.150;  // looking up through it
/**
 * Looking down into the layer. Deliberately raised: the old 0.052 meant an elevated
 * camera looking across the yard got almost no aerial perspective at all (the review
 * measured the far black floor lifting only +8 sRGB over 80 m looking away from the
 * sun, against +17 looking into it). Haze exists in every direction; only its colour
 * is allowed to depend on the sun bearing.
 */
const FOG_DOWN_LUM = 0.086;
/** Anti-solar sky luminance the four targets above are quoted at; they scale off it. */
const FOG_REF_SKY_LUM = 0.175;

/**
 * Multiplier on Config's `art.fogDensity`. Config nominates 0.0085, which reads as
 * weather rather than air: containers at 40 m lose their corrugation, doors and rust
 * entirely, and the fog ends up doing the job of an LOD system.
 *
 * ── WHY THIS ALSO GETS PUBLISHED BACK TO CONFIG ───────────────────────────────
 *
 * This scale used to be private, and that was a real bug rather than a style choice.
 * The render system's volumetric pass reads `Config.art.fogDensity` *directly* for
 * its Mie airlight term, so the engine was running two different atmospheres: ours at
 * 0.0053 and the inscatter at 0.0085. Ablated live in the lane pose, that inscatter
 * was worth +50 sRGB levels across the whole midground — the entire "milk bath" the
 * review measured was the volumetric pass integrating a density this system had
 * already decided was too high, and no amount of retuning *our* fog could touch it.
 *
 * So the effective density is now written back to `art.fogDensity` at init. Every
 * consumer sees one number, the Config knob still steers (the base value is captured
 * before we publish, so repeated init/setTimeOfDay cycles cannot ratchet it down),
 * and the long-range dissolve is bought back in our own shader's quadratic term,
 * which is the only place it belongs — aerial perspective is quadratic in distance,
 * near-field inscatter is linear, and they are not interchangeable.
 *
 * ── LOWERED AGAIN, BECAUSE THE PUBLISHED NUMBER IS NOT OURS ALONE ─────────────
 *
 * Publishing the effective density fixed the two-atmospheres bug but left a second
 * one standing: the render system's airlight term is *not* our fog. It integrates
 *
 *     trans   = 1 - exp( -fogDensity * min(dist, 170) )
 *     airlight = trans * ( 0.10 + hg(cosSun, 0.62) * 0.85 )      // phase capped at 2.2
 *     colour   = uSunColor * airlight * 0.30
 *
 * with `uSunColor` taken from our key light and scaled by 1.27. At 0.00374 that adds
 * up to ~0.28 x the key colour on any surface 170 m away and ~0.08 x at 40 m, on top
 * of our own fog — and it is near-neutral and warm, so it lands hardest on exactly the
 * midground the review measured as inverted: the distant building at 213/183/141
 * against sunlit foreground gravel at 162/137/104. Distance was 30% *brighter* than
 * the local key, which reads as a milk bath rather than as recession.
 *
 * We cannot edit that pass. We can stop feeding it: the published density comes down
 * by a third, which takes the airlight down with it roughly linearly in the near and
 * mid field. Our own optical depth is held constant by scaling `aerialScale` and
 * `groundScale` back up by the reciprocal (the aerial term is quadratic in density, so
 * its scale takes the full 1/k; the ground term is linear and takes the same 1/k).
 * Net: identical aerial perspective from our shader, a third less inscatter from
 * theirs, and the horizon finally sits below the foreground key.
 */
const FOG_DENSITY_SCALE = 0.295;

const _v = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _c = new THREE.Color();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _fwd = new THREE.Vector3();

const LUM = (c) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;

/** Rescale a colour to an exact luminance, preserving hue. */
function toLum(c, target) {
  const l = LUM(c);
  if (l > 1e-6) c.multiplyScalar(target / l);
  else c.setRGB(target, target, target, THREE.LinearSRGBColorSpace);
  return c;
}

/** Per-channel a/b, clamped — the shader wants tints relative to `fogColor`. */
function ratio(a, b, lo = 0.05, hi = 14.0) {
  const g = (x, y) => THREE.MathUtils.clamp(y > 1e-6 ? x / y : 1, lo, hi);
  return new THREE.Vector3(g(a.r, b.r), g(a.g, b.g), g(a.b, b.b));
}

export class LightingSystem {
  static id = 'lighting';
  static order = 70;

  constructor(ctx) {
    this.ctx = ctx;
    const art = ctx.config?.art ?? {};

    this.sun = null;
    this.csm = null;
    this.envMap = null;

    /**
     * Captured once, before `_applyAtmosphere()` publishes the scaled value back into
     * `art.fogDensity`. Without this the scale would compound on every setTimeOfDay()
     * and the map would slowly go clear.
     */
    this.baseFogDensity = art.fogDensity ?? 0.0085;

    this.sunElevation = Math.max(2.2, (art.sunElevation ?? 11.5) - ELEVATION_TRIM);
    this.sunAzimuth = art.sunAzimuth ?? 118;
    this.sunDirection = new THREE.Vector3(0, 1, 0);

    this.skyParams = { ...SKY_DEFAULTS, turbidity: art.skyTurbidity ?? SKY_DEFAULTS.turbidity };

    this.sky = null;
    this.skyMaterial = null;
    this.skyScene = null;
    this.hemi = null;
    this.bounce = null;
    /** Shadow-camera margin. */
    this.lightMargin = 90;
    this.fog = new AtmosphereFog();
    this.practicals = null;
    this.pools = null;
    this.dust = null;

    this._pmrem = null;
    this._envRT = null;
    this._time = 0;
    this._autoPracticalsDone = false;
    this._autoPracticals = [];
  }

  // ────────────────────────────────────────────────────────────────────────
  async init(onProgress = () => {}) {
    const { ctx } = this;
    const art = ctx.config?.art ?? {};
    const rcfg = ctx.config?.render ?? {};

    sunDirectionFrom(this.sunElevation, this.sunAzimuth, this.sunDirection);

    // ── sky dome ─────────────────────────────────────────────────────────
    onProgress(0.05, 'sky');
    try {
      this.skyMaterial = createSkyMaterial(this.skyParams);
      this.skyMaterial.uniforms.uSunDirection.value.copy(this.sunDirection);

      this.sky = createSkyMesh(this.skyMaterial, 12000);
      ctx.scene.add(this.sky);

      // A second dome in an isolated scene, so PMREM captures only the sky.
      this.skyScene = new THREE.Scene();
      this.skyScene.add(createSkyMesh(this.skyMaterial, 12000));
    } catch (err) {
      console.error('[lighting] sky construction failed:', err);
    }

    // ── atmosphere (must be installed before any program compiles) ────────
    onProgress(0.2, 'atmosphere');
    this._applyAtmosphere();

    // ── cascaded shadows ─────────────────────────────────────────────────
    onProgress(0.35, 'shadows');
    try {
      const renderer = ctx.renderer;
      renderer.shadowMap.enabled = true;
      // PCFSoftShadowMap is deprecated in r185 — WebGLShadowMap silently downgrades it
      // to PCFShadowMap on the first shadow render (with a console warning) and forces a
      // full material recompile. Ask for the real thing up front.
      renderer.shadowMap.type = THREE.PCFShadowMap;
      // The render pipeline draws the scene more than once per frame (G-buffer prepass
      // + HDR pass), and three re-renders every cascade on *each* renderer.render().
      // Driving the update ourselves collapses 8 shadow-map passes back down to 4.
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;

      this.csm = new CascadeShadows(ctx, {
        cascades: rcfg.csmCascades ?? 4,
        maxFar: rcfg.csmMaxDistance ?? 140,
        shadowMapSize: rcfg.shadowMapSize ?? 2048,
        lightDirection: _v.copy(this.sunDirection).negate(),
        color: art.sunColor ?? 0xffd7a8,
        intensity: (art.sunIntensity ?? 3.1) * SUN_CALIBRATION,
        lightMargin: this.lightMargin,
        // The entire bias derivation is a function of this — see CascadeShadows'
        // note on normal-offset vs depth bias at a grazing sun.
        sunElevationDeg: this.sunElevation,
      });
      this.sun = this.csm.sun;
      this._applySunColour();
      this.csm.scanScene(true);
      /**
       * Publish the resolved cascade table. Every shadow defect this system has ever
       * been sent back for was a number in here being something other than what the
       * code claimed — the 0.16 m normal bias, the far cascade being sharper than the
       * near one — and none of them are visible by reading the source, because they
       * are all derived from a texel size the CSM computes at runtime from the camera.
       * Cheap, read-only, and it turns "is the bias actually what I think" into a
       * console expression instead of a screenshot.
       */
      if (typeof window !== 'undefined') window.__CSM_INFO__ = () => this.csm?.describe();
    } catch (err) {
      console.error('[lighting] shadow system failed:', err);
    }

    // ── ambient fill ─────────────────────────────────────────────────────
    onProgress(0.55, 'ambient');
    try {
      this.hemi = new THREE.HemisphereLight(0x8ea3b8, 0x2a2620, 0.35);
      this.hemi.position.set(0, 50, 0);
      ctx.scene.add(this.hemi);

      // Fake indirect: one shadowless directional light travelling upward, standing in
      // for the sun bouncing off the yard. Added *before* the first frame so
      // NUM_DIR_LIGHTS is settled by the time anything compiles — adding a light later
      // invalidates every program in the scene. See BOUNCE_FRACTION.
      this.bounce = new THREE.DirectionalLight(0xffa863, 0.0);
      this.bounce.name = 'SunBounce';
      this.bounce.castShadow = false;
      ctx.scene.add(this.bounce);
      ctx.scene.add(this.bounce.target);

      this._applyAmbient();
    } catch (err) {
      console.error('[lighting] hemisphere fill failed:', err);
    }

    // ── image based lighting ─────────────────────────────────────────────
    onProgress(0.7, 'environment');
    this._buildEnvironment();

    // ── practicals ───────────────────────────────────────────────────────
    onProgress(0.9, 'practicals');
    try {
      /**
       * The budget stays at 8 — and that is a measurement, not an assumption.
       *
       * The review's "practicals illuminate nothing" finding pointed at raising it,
       * so 12 was tried and benchmarked: the spawn pose went from 64 fps to 33. In a
       * forward renderer every extra point light is a full-screen fragment cost, and
       * four of them is half the frame. "Beautiful at 20 fps is a failure."
       *
       * The finding is answered instead by (a) a much steeper falloff, so a slotted
       * lamp actually blazes at the fixture rather than smearing across the yard
       * (see PRACTICAL_DECAY), and (b) view-aware slot selection below, so the eight
       * slots go to the fixtures the player is *looking at* rather than to whatever
       * happens to be nearest — which is what was really costing the closeup wall
       * head and the warehouse pendants their lights.
       */
      /**
       * ── 8 -> 7: PAYING FOR THE FALLOFF FIX OUT OF THE SAME BUDGET ─────────
       *
       * Everything above still holds — in a forward renderer each extra point light
       * is a full-screen fragment cost, and the file's own benchmark put four extra
       * lights at half the frame. The corollary the previous pass did not draw is
       * that the trade runs in both directions.
       *
       * The falloff fix (PRACTICAL_DECAY 2.7 -> 2.0 plus the 1.55x radius floor in
       * addPractical) roughly triples the ground area each fixture actually lights.
       * Seven slots at the new falloff cover materially more of the frame than eight
       * did at the old one, so giving one back is a net gain in lit area *and* buys
       * back the frame time this pass spent on wider shadow kernels and a denser
       * mote field. That is the honest way to fund a quality change: out of your own
       * module, not out of the frame budget.
       */
      this.practicals = new Practicals(ctx.scene, 7);
      this.pools = new LightPools(ctx, this.practicals);
    } catch (err) {
      console.error('[lighting] practical pool failed:', err);
    }

    // ── near-field particulate ───────────────────────────────────────────
    onProgress(0.96, 'atmosphere');
    try {
      /**
       * The review looked for particulate and found none ("no dust motes, no drifting
       * embers — so the sun shafts read as clean grey smears rather than light through
       * dusty air"), which was fair: at 640 motes and 0.19 intensity the field was
       * below the film grain. Half again the count, three times the intensity, and
       * the field is widened so it survives being looked *across* rather than only
       * being stood in. Still one draw call, still all motion in the vertex shader.
       */
      this.dust = new DustMotes(ctx, { count: 950, extent: 19.0, intensity: 0.56, size: 1.2 });
      this.dust.setSunDirection(this.sunDirection);
    } catch (err) {
      console.error('[lighting] dust motes failed:', err);
    }

    onProgress(1, 'lighting');
  }

  // ── public API ──────────────────────────────────────────────────────────

  /**
   * Register a local light. Returns a handle you can pass to removePractical().
   * Only the 8 most important are live at any moment, so a level may register
   * hundreds without a shader-budget cliff.
   */
  addPractical(position, color = this.ctx.config?.art?.practicalColor ?? 0xffb257, intensity = 12, radius = 11, opts = {}) {
    if (!this.practicals) return null;
    try {
      // The first real practical retires the placeholder ring.
      if (!opts.auto && this._autoPracticals.length) {
        this.practicals.removeWhere((e) => e.auto);
        this._autoPracticals.length = 0;
      }
      /**
       * ── RADIUS FLOOR ──────────────────────────────────────────────────────
       *
       * `radius` becomes `PointLight.distance`, and three does not treat that as a
       * soft cutoff: `getDistanceAttenuation` multiplies by `(1 - (d/R)^4)^2`, which
       * is already down to 35% at 0.8 R and hard zero at R. A fixture registered with
       * a 13 m window therefore stops lighting anything much past 8 m — and the level
       * ships its warehouse pendants at exactly that, four metres above a floor they
       * consequently never reach.
       *
       * Widening the window costs nothing (a forward point light is a full-screen
       * fragment cost whatever its radius) and is the other half of the falloff fix in
       * Practicals.js. Held as a scale with a floor rather than a hard override so a
       * level that deliberately registers a tiny lamp inside a crate still gets one.
       */
      const reach = THREE.MathUtils.clamp((radius ?? 11) * 1.55, Math.min(radius ?? 11, 5), 26);
      return this.practicals.add(position, this._conditionPracticalColour(color), intensity, reach, opts);
    } catch (err) {
      console.error('[lighting] addPractical failed:', err);
      return null;
    }
  }

  removePractical(handle) {
    if (handle && this.practicals) this.practicals.remove(handle);
  }

  /**
   * Adopt a material into the cascaded-shadow shader path.
   *
   * ARCHITECTURE.md names this as *the* registration hook — "After creating any mesh
   * with a lit material, register it: `ctx.lighting.registerMaterial(mesh.material)`"
   * — and four systems (level, fx, ai, weapons) call it before falling back to
   * `csm.setupMaterial`. It was never actually implemented, so every one of them was
   * silently taking the fallback and the level was one refactor away from logging
   * "no CSM registration hook found" and relying on the periodic sweep instead.
   *
   * That matters more than a missing method usually would: a lit material that has
   * not been through CSM setup takes the non-CSM branch of `lights_fragment_begin`,
   * which adds all four cascade lights at full intensity — 4x overexposed, not merely
   * unshadowed. Accepts a material, an array of materials, or a mesh.
   */
  registerMaterial(target) {
    if (!target || !this.csm) return false;
    try {
      if (Array.isArray(target)) {
        let ok = false;
        for (const m of target) ok = this.registerMaterial(m) || ok;
        return ok;
      }
      const mat = target.isMaterial ? target : target.material;
      if (!mat) return false;
      if (Array.isArray(mat)) return this.registerMaterial(mat);
      this.csm.setupMaterial(mat);
      return true;
    } catch (err) {
      console.error('[lighting] registerMaterial failed:', err);
      return false;
    }
  }

  /**
   * Snap a practical's colour onto a physically reachable incandescent locus.
   *
   * The level ships fixtures at 0xff7a26 and 0xff5a12 — linear (1.00, 0.19, 0.03)
   * and (1.00, 0.10, 0.005). Those are not lamp colours; nothing thermal is that
   * narrow. Real high-pressure sodium runs about 2000-2100 K, which is linear
   * (1.00, 0.45, 0.14); an open wood fire at ~1800 K is (1.00, 0.33, 0.06). Even
   * the reddest thing you can light a scene with keeps a third of its red in green.
   *
   * It matters far beyond pedantry. Ablated live, the practicals were supplying
   * ~80% of the light in shadowed ground at the closeup framing — and supplying it
   * as almost pure red. Red spill on a blue sky fill is exactly the recipe for
   * green-lowest, and the reviews measured the result as violet-lavender concrete
   * across three separate poses. Putting the fixtures back on the blackbody line
   * fixes the hue at source instead of fighting it downstream, and it makes the
   * lamps read *more* like sodium rather than less: 0xff7a26 lands where a real
   * street head actually sits.
   *
   * Peak is preserved, so nothing about brightness or the level's intensity tuning
   * changes — only the chroma floor.
   */
  _conditionPracticalColour(color) {
    try {
      const c = new THREE.Color(color ?? 0xffb257);
      const peak = Math.max(c.r, c.g, c.b, 1e-6);
      c.multiplyScalar(1 / peak);
      // ~2050 K floor, expressed relative to the dominant channel.
      const warm = c.r >= c.b;
      if (warm) {
        if (c.g < c.r * 0.40) c.g = c.r * 0.40;
        if (c.b < c.r * 0.095) c.b = c.r * 0.095;
      }
      return c.multiplyScalar(peak);
    } catch {
      return color;
    }
  }

  /** Retune the whole look from sun angles. Regenerates IBL, fog and shadows. */
  setTimeOfDay(elevationDeg, azimuthDeg) {
    try {
      this.sunElevation = elevationDeg ?? this.sunElevation;
      this.sunAzimuth = azimuthDeg ?? this.sunAzimuth;
      sunDirectionFrom(this.sunElevation, this.sunAzimuth, this.sunDirection);

      if (this.skyMaterial) this.skyMaterial.uniforms.uSunDirection.value.copy(this.sunDirection);
      if (this.csm) {
        this.csm.setLightDirection(_v.copy(this.sunDirection).negate());
        this.csm.setSunElevation(this.sunElevation);
        this._applySunColour();
      }
      this.dust?.setSunDirection(this.sunDirection);
      this._applyAtmosphere(true);
      this._applyAmbient();
      this._buildEnvironment();
    } catch (err) {
      console.error('[lighting] setTimeOfDay failed:', err);
    }
  }

  /** Live sky knobs, e.g. setSkyParams({ cloudCoverage: 0.8 }). */
  setSkyParams(params = {}) {
    Object.assign(this.skyParams, params);
    if (!this.skyMaterial) return;
    const u = this.skyMaterial.uniforms;
    const set = (name, key) => {
      if (params[key] === undefined || !u[name]) return;
      const v = params[key];
      if (Array.isArray(v) && u[name].value?.isVector3) u[name].value.set(v[0], v[1], v[2]);
      else u[name].value = v;
    };
    set('uTurbidity', 'turbidity');
    set('uRayleigh', 'rayleigh');
    set('uMieCoefficient', 'mieCoefficient');
    set('uMieDirectionalG', 'mieDirectionalG');
    set('uSkyIntensity', 'skyIntensity');
    set('uSaturation', 'saturation');
    set('uHazeFalloff', 'hazeFalloff');
    set('uHazeStrength', 'hazeStrength');
    set('uHazeLift', 'hazeLift');
    set('uHazeCool', 'hazeCool');
    set('uHazeWarm', 'hazeWarm');
    set('uGroundColor', 'groundColor');
    set('uCloudCoverage', 'cloudCoverage');
    set('uCloudDensity', 'cloudDensity');
    set('uCloudSharpness', 'cloudSharpness');
    set('uCloudScale', 'cloudScale');
    set('uCloudSpeed', 'cloudSpeed');
    set('uCloudShadow', 'cloudShadow');
    set('uCloudLit', 'cloudLit');
    set('uCloudRim', 'cloudRim');
    set('uSunDiscIntensity', 'sunDiscIntensity');
    set('uSunDiscColor', 'sunDiscColor');
    set('uCloudOcclusion', 'cloudOcclusion');
    set('uSunGlowIntensity', 'sunGlowIntensity');
    set('uSunGlowExponent', 'sunGlowExponent');
    set('uSunHaloIntensity', 'sunHaloIntensity');
    set('uSunHaloExponent', 'sunHaloExponent');
    set('uSunVeilIntensity', 'sunVeilIntensity');
    set('uSunVeilExponent', 'sunVeilExponent');
    set('uSkyWarm', 'skyWarm');
    set('uSkyCool', 'skyCool');
    set('uSkyRampExp', 'skyRampExp');
    set('uZenithScale', 'zenithScale');
    set('uProbeTint', 'probeTint');
    set('uProbeGround', 'probeGround');
    set('uProbeClamp', 'probeClamp');
    this._applyAtmosphere(true);
    this._applyAmbient();
    this._buildEnvironment();
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** Horizon / sun-side / zenith radiance straight out of the same model as the sky. */
  _sampleSky() {
    const sun = this.sunDirection;
    const p = this.skyParams;

    // General horizon: a ring at ~2.5 degrees. Averaged *geometrically*, because the
    // solar horizon is an order of magnitude brighter than the rest of the ring and an
    // arithmetic mean would let it drag the base fog colour up into milk. The sun side
    // is reintroduced as a directional tint instead, which is what it actually is.
    const horizon = new THREE.Color(0, 0, 0);
    const N = 8;
    let lr = 0, lg = 0, lb = 0;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      _v.set(Math.cos(a) * 0.999, 0.0436, Math.sin(a) * 0.999).normalize();
      evaluateSky(_v, sun, p, _c);
      lr += Math.log(Math.max(_c.r, 1e-4)) / N;
      lg += Math.log(Math.max(_c.g, 1e-4)) / N;
      lb += Math.log(Math.max(_c.b, 1e-4)) / N;
    }
    horizon.setRGB(Math.exp(lr), Math.exp(lg), Math.exp(lb), THREE.LinearSRGBColorSpace);

    // Sun-side horizon: the sun's azimuth, dragged down to just above the skyline.
    _v.set(sun.x, 0.055, sun.z).normalize();
    const sunSide = averageSky(_v, sun, p, 14, 7, new THREE.Color());

    // Anti-sun horizon and zenith give us the cool end of the gradient.
    _v.set(-sun.x, 0.09, -sun.z).normalize();
    const antiSun = averageSky(_v, sun, p, 18, 7, new THREE.Color());

    _v.set(0, 1, 0);
    const zenith = averageSky(_v, sun, p, 35, 9, new THREE.Color());

    // Upwelling ground bounce (for the hemisphere fill's lower lobe).
    _v.set(sun.x * 0.35, -0.85, sun.z * 0.35).normalize();
    const ground = evaluateSky(_v, sun, p, new THREE.Color());

    return { horizon, sunSide, antiSun, zenith, ground };
  }

  /**
   * Fog is the single most destructive thing in this system when it is wrong, so it is
   * built in two clearly separated halves:
   *
   *   COLOUR — take the *hue* of the sky in four reference directions and renormalise
   *   each onto an absolute radiance target (the FOG_*_LUM constants). Never inherit the
   *   sky's magnitude: horizon sky at a low sun runs 0.19-1.8 linear and a fog colour
   *   anywhere near that buries a ground plane sitting at 0.17.
   *
   *   DENSITY — a quadratic aerial term plus a weak stratified ground layer, so the near
   *   field is measurably clear. We assert that here rather than trusting the shader.
   */
  _applyAtmosphere(refresh = false) {
    const { ctx } = this;
    const art = ctx.config?.art ?? {};
    try {
      const s = this._sampleSky();

      // Everything scales with how bright the sky actually is, so setTimeOfDay() into
      // night does not leave a glowing bank of haze behind.
      /**
       * The reference is captured on the first evaluation rather than hard-coded.
       *
       * `FOG_REF_SKY_LUM` existed so that retuning the sun toward night would take the
       * haze down with it, which is right — but as a *constant* it silently couples the
       * fog calibration to every sky-dome edit. Deepening `skyCool` for the anti-solar
       * hemisphere (see SkyShader) halves the anti-sun sample and would have halved
       * every fog lobe with it, for no reason anybody would ever connect to the change
       * they actually made. Anchoring on the first sample makes `sky` mean exactly what
       * it is supposed to mean: how bright the sky is *relative to the nominal dusk
       * this look was calibrated at*.
       */
      if (this._fogRefSkyLum === undefined) {
        this._fogRefSkyLum = Math.max(LUM(s.antiSun), FOG_REF_SKY_LUM * 0.05);
      }
      const sky = THREE.MathUtils.clamp(LUM(s.antiSun) / this._fogRefSkyLum, 0.12, 2.4);

      // ── base: the haze you see looking across the scene, away from the sun ──
      // Sun-side sky is deliberately excluded from the base — it is an order of
      // magnitude brighter than everything else and averaging it in is precisely what
      // turns directional haze into flat milk. It comes back as a lobe instead.
      const cfg = _c.set(art.fogColor ?? 0x9aa4ad);
      const base = s.antiSun.clone().lerp(s.horizon, 0.35).lerp(cfg, 0.30);
      toLum(base, FOG_BASE_LUM * sky);

      const density = (this.baseFogDensity ?? art.fogDensity ?? 0.0085) * FOG_DENSITY_SCALE;
      // Publish the effective density so the render system's volumetric airlight
      // integrates the same atmosphere we do. See FOG_DENSITY_SCALE.
      if (art) art.fogDensity = density;
      if (!ctx.scene.fog || !ctx.scene.fog.isFogExp2) {
        ctx.scene.fog = new THREE.FogExp2(base.getHex(), density);
      }
      ctx.scene.fog.color.copy(base);
      ctx.scene.fog.density = density;

      ctx.renderer.setClearColor(base, 1);

      // ── lobes ───────────────────────────────────────────────────────────────
      const sunCol = toLum(s.sunSide.clone(), FOG_SUN_LUM * sky);
      const zenCol = toLum(s.zenith.clone().lerp(s.antiSun, 0.30), FOG_ZENITH_LUM * sky);
      // Looking down into the layer you are looking at ground-bounce, which at dusk is
      // warm and very dark. This is what stops the near ground plane hazing white.
      const downCol = toLum(s.ground.clone().lerp(base, 0.25), FOG_DOWN_LUM * sky);

      this.fog.setParams({
        sunDir: this.sunDirection.clone(),
        sunTint: ratio(sunCol, base),
        zenithTint: ratio(zenCol, base),
        downTint: ratio(downCol, base),
        // Narrower solar lobes as well as a dimmer one: a broad exponent of 2.6 puts
        // warm inscatter across a 90-degree cone, which is most of the frame whenever
        // you are facing the sun at all.
        // Narrower again. The review's instruction was to cap the inscatter luminance
        // so distant surfaces sit at or below the foreground key *except* within ~15
        // degrees of the sun disc. `pow(cos, 5.2)` is half-strength at 32 degrees and
        // 5% at 60; the sharp lobe carries the last 15 degrees. Away from the sun the
        // haze is now unambiguously darker than sunlit ground.
        sunExponent: 5.2,
        sunSharpExponent: 22.0,
        sunBroadWeight: 0.33,
        sunSharpWeight: 0.52,
        upScale: 1.7,
        // Softened: the down lobe reaching full strength 24 degrees below the horizon
        // is what made an elevated camera see almost no haze at all.
        downScale: 1.5,
        // Density was cut again (see FOG_DENSITY_SCALE), so the long-range quadratic
        // is raised to hold the 150 m+ dissolve while the linear ground layer is
        // deliberately *not* fully compensated. That is the whole point: the linear
        // term is what lifts the 10-60 m band — the band the cast shadows and the
        // container corrugation live in — and the quadratic is what dissolves the
        // skyline. Trading one for the other is how you keep aerial perspective and
        // still get a readable midground.
        // Both scaled by 1 / FOG_DENSITY_SCALE's change so the optical depth this
        // shader integrates is bit-for-bit what it was before the published density
        // came down. See the FOG_DENSITY_SCALE note: the cut is aimed at the render
        // system's airlight, not at our own aerial perspective.
        aerialScale: 2.148,
        groundScale: 0.567,
        heightFalloff: 0.105,
        // Second, much taller scale height for the quadratic term, so the haze pools
        // low and the upper floors of a building stay readable while its base fogs out.
        aerialHeightFalloff: 0.028,
        baseHeight: 0.0,
        densityScale: 1.0,
      });

      if (!this.fog.installed) this.fog.install();
      else if (refresh) this.fog.refresh(ctx.scene);

      this._auditFog(density);
    } catch (err) {
      console.error('[lighting] atmosphere setup failed:', err);
    }
  }

  /**
   * Assert the near field is actually clear. This exists because "the fog looks fine"
   * is not checkable by eye until it is already too late, and the failure mode is a
   * frame that looks *lit wrong* rather than *fogged wrong*. Warns, never throws.
   */
  _auditFog(density) {
    try {
      const eye = 1.75;
      const near = this.fog.factorAt(10, eye, density);
      const mid = this.fog.factorAt(60, eye, density);
      const far = this.fog.factorAt(300, eye, density);
      this.fogProfile = { near, mid, far };
      if (near > 0.06) {
        console.warn(
          `[lighting] near-field fog is ${(near * 100).toFixed(1)}% at 10m — that will ` +
          'wash out cast shadows. Lower art.fogDensity or AtmosphereFog groundScale.',
        );
      }
      if (far < 0.75) {
        console.warn(`[lighting] fog only reaches ${(far * 100).toFixed(0)}% at 300m — no aerial perspective.`);
      }
    } catch { /* diagnostics must never break a frame */ }
  }

  _applyAmbient() {
    if (!this.hemi) return;
    try {
      const s = this._sampleSky();
      // Cool from the sky, warm from the ground: that split is what stops shadows
      // reading as flat grey holes. Both are hue-only — magnitude comes from
      // HEMI_INTENSITY, which is part of the key/fill calibration and must not drift
      // when the sky is retuned.
      const skyCol = s.zenith.clone().lerp(s.antiSun, 0.45);
      const cfgTint = _c.set(this.ctx.config?.art?.ambientTint ?? 0x4a5a68);
      skyCol.lerp(cfgTint, 0.30);
      // Enforce the fill chroma rather than inheriting it. Sky hue at a low sun is
      // only mildly cool, and every albedo in this map is tan — left alone the
      // *rendered* shadow comes back neutral-to-warm, which is exactly what the
      // review measured (shaded ground R/B 1.16 under a sky at R/B 0.74).
      const fill = new THREE.Color().setRGB(
        FILL_CHROMA[0], FILL_CHROMA[1], FILL_CHROMA[2], THREE.LinearSRGBColorSpace,
      );
      toLum(fill, 1.0);
      // Pushed from 0.65 to 0.85: the sampled sky is inherently near-neutral once the
      // dome's desaturation has run, so leaving 35% of it in the mix was enough to
      // drag the fill back off the blue axis. The enforced chroma is the point.
      skyCol.lerp(fill, 0.85);
      /**
       * ── THE TWO LOBES ARE NOT EQUAL, AND THAT IS THE WHOLE MECHANISM ───────
       *
       * `HEMI_INTENSITY` went up ~6x to put readable light back into shade. If both
       * lobes went up with it, open ground — which faces straight up and therefore
       * sees the sky lobe and nothing else — would gain the full 6x and every cast
       * shadow in the map would wash out. That is exactly the failure the previous
       * revision was written to avoid, and it was right about it.
       *
       * So the lobes are split hard. The upper lobe is held at 0.50 while the lower
       * (ground-bounce) lobe runs at 1.30, a 2.6:1 spread. Consequences, all of them
       * the ones we want:
       *
       *   horizontal ground   sees 1.00 sky + 0.00 bounce  -> gains least
       *   vertical wall       sees 0.50 sky + 0.50 bounce  -> gains a lot
       *   soffit / underside  sees 0.00 sky + 1.00 bounce  -> gains most
       *
       * A cast shadow on open ground therefore keeps most of its contrast against the
       * key, while shaded corrugation, sandbag weave and the undersides that were
       * reading as dead neutral grey get an unambiguous vertical gradient across them
       * — which is the specific thing the review said was missing ("shadow at ground
       * level is the same value as shadow 4 m up a wall"). It is also, not
       * incidentally, what real bounce does.
       */
      toLum(skyCol, 0.50);
      this._enforceSkyChroma(skyCol);

      this.hemi.color.copy(skyCol);
      // Ground bounce off a sunlit sand yard: warm, and much brighter than the sky
      // dome's own underside. This is the lobe that puts a gradient on a vertical
      // shadow-side face instead of letting it go flat. Raised relative to the sky
      // lobe (0.30 -> 0.62 of it) because the sky lobe was cut hard for the key/fill
      // ratio and the bounce is the half of the fill that is allowed to stay: it
      // never lands on open horizontal ground, so it cannot wash a cast shadow.
      // Warm sun-bounce off a tan yard. `fac496` is the review's nomination and it is
      // very close to what the sky model's own downwelling sample lands on, so it is
      // used as the anchor rather than as an override.
      const bounce = s.ground.clone().lerp(new THREE.Color(0xfac496), 0.70);
      this.hemi.groundColor.copy(toLum(bounce, 1.30));
      this.hemi.intensity = HEMI_INTENSITY;

      this._applyBounce();
    } catch (err) {
      console.error('[lighting] ambient setup failed:', err);
    }
  }

  /**
   * Clamp a fill colour onto the blue side of the Rayleigh line.
   *
   * Every magenta-shadow defect in the review traced back to a fill primary whose
   * green channel sat *below* the midpoint of red and blue. Scattering is monotonic
   * in wavelength, so that is physically impossible for a sky term and instantly
   * legible on screen as violet concrete. Rather than trust three separate hand-tuned
   * triples to stay on the right side of the line forever, assert it: green is lifted
   * to at least the R-B midpoint, and blue is held above red.
   */
  _enforceSkyChroma(c, greenBias = 1.10) {
    const mid = (c.r + c.b) * 0.5;
    if (c.g < mid * greenBias) c.g = mid * greenBias;
    if (c.b < c.r * 1.06) c.b = c.r * 1.06;
    return c;
  }

  /**
   * The upward-pointing sun-bounce light. See BOUNCE_FRACTION.
   *
   * Shadowless and cheap: it is the fifth entry in the directional loop, past the four
   * cascades, which CSM's shader replacement handles explicitly. Aimed mostly straight
   * up with a slight lean *toward* the sun, because the bounce comes off the brightest
   * ground, which is the ground the sun is actually hitting.
   */
  _applyBounce() {
    try {
      if (!this.bounce) return;
      const key = (this.sun && this.sun.isLight) ? this.sun.intensity : 8;
      const col = new THREE.Color().setRGB(
        BOUNCE_CHROMA[0], BOUNCE_CHROMA[1], BOUNCE_CHROMA[2], THREE.LinearSRGBColorSpace,
      );
      const peak = Math.max(col.r, col.g, col.b, 1e-6);
      col.multiplyScalar(1 / peak);
      this.bounce.color.copy(col);
      this.bounce.intensity = key * BOUNCE_FRACTION * peak;
      // Direction of travel is upward: three points the light from `position` toward
      // `target`, so the position has to sit *below* the target for the light to hit
      // downward-facing normals.
      const s = this.sunDirection;
      this.bounce.position.set(s.x * 22, -100, s.z * 22);
      this.bounce.target.position.set(0, 0, 0);
      this.bounce.target.updateMatrixWorld();
    } catch (err) {
      console.error('[lighting] bounce light failed:', err);
    }
  }

  _applySunColour() {
    if (!this.csm) return;
    const art = this.ctx.config?.art ?? {};
    try {
      // Start from Config's nominated key so the art knob still steers the hue, then
      // drive it toward KEY_CHROMA. The old code did the opposite — it lerped 30%
      // toward the Preetham sun-side *sky* hue, which at this turbidity is R/B 1.5 and
      // therefore *cooled* an already-too-neutral key. A low sun does not take the
      // colour of the sky around it; it is what makes that sky warm in the first place.
      const cfg = new THREE.Color(art.sunColor ?? 0xffd7a8);
      toLum(cfg, 1.0);
      const target = new THREE.Color().setRGB(
        KEY_CHROMA[0], KEY_CHROMA[1], KEY_CHROMA[2], THREE.LinearSRGBColorSpace,
      );
      toLum(target, 1.0);
      const col = cfg.lerp(target, 0.82);
      // Renormalise so retuning the sky never silently changes exposure.
      toLum(col, 1.0);
      this.keyChroma = col.clone();

      /**
       * ── PEAK-NORMALISE, don't luminance-normalise ────────────────────────
       *
       * At R/B ~4 a luminance-normalised amber sits at (1.44, 0.93, 0.38): its red
       * channel is *above one*. That is legal for `color * intensity` — and a trap
       * for every consumer that reads `light.color` on its own. There are three in
       * this codebase; the render system's volumetric pass is one, and it multiplies
       * the raw colour by a term that saturates in intensity, so a colour above 1.0
       * silently inflates the airlight by 44% in the red channel — which is a large
       * part of why looking toward the sun washed the whole midground cream.
       *
       * Peak-normalising (max channel = 1) and folding the difference into intensity
       * leaves `color * intensity` bit-for-bit identical, so nothing about the actual
       * lighting changes, and hands every colour-only consumer a sane value.
       */
      const peak = Math.max(col.r, col.g, col.b, 1e-6);
      col.multiplyScalar(1 / peak);

      this.csm.setSun(col, (art.sunIntensity ?? 3.1) * SUN_CALIBRATION * peak);
      this.sun = this.csm.sun;
    } catch (err) {
      console.error('[lighting] sun colour failed:', err);
    }
  }

  /** PMREM the sky dome into scene.environment and hand it to the material system. */
  _buildEnvironment() {
    const { ctx } = this;
    if (!this.skyScene || !ctx.renderer) return;
    let restoreDisc = null;
    let restoreProbe = null;
    try {
      if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(ctx.renderer);

      // The sun disc belongs to the DirectionalLight, not the IBL — leaving it in the
      // probe double-counts the key and produces a hard hot spot in every reflection.
      const u = this.skyMaterial?.uniforms?.uShowSunDisc;
      if (u) { restoreDisc = u.value; u.value = 0; }
      // Probe conditioning: soft luminance clamp, cool chroma push, sunlit-yard bounce
      // in the lower hemisphere. See SkyShader's SKY_DEFAULTS.probe* notes.
      const up = this.skyMaterial?.uniforms?.uProbe;
      if (up) { restoreProbe = up.value; up.value = 1; }

      const prevRT = this._envRT;
      this._envRT = this._pmrem.fromScene(this.skyScene, 0.0, 1, 60000);
      this.envMap = this._envRT.texture;

      ctx.scene.environment = this.envMap;
      // Left at 1.0 the sky probe out-lights the sun on horizontal surfaces and every
      // cast shadow washes out — which is exactly what "the shadows are missing" looks
      // like. See SUN_CALIBRATION.
      if ('environmentIntensity' in ctx.scene) ctx.scene.environmentIntensity = ENV_INTENSITY;

      if (prevRT) prevRT.dispose();

      const mats = ctx.materials ?? ctx.systems?.materials;
      if (mats) {
        mats.envMap = this.envMap;
        // MaterialSystem binds the probe as `material.envMap`, and three only honours
        // `scene.environmentIntensity` when `material.envMap === null`. Without passing
        // the calibration through here the whole material library runs the probe at
        // 1.0 while this system believes it is at ENV_INTENSITY — the sky out-lights
        // the key and every cast shadow washes out.
        if (typeof mats.applyEnvMap === 'function') mats.applyEnvMap(this.envMap, ENV_INTENSITY);
      }
    } catch (err) {
      console.error('[lighting] environment map generation failed:', err);
    } finally {
      const u = this.skyMaterial?.uniforms?.uShowSunDisc;
      if (u && restoreDisc !== null) u.value = restoreDisc;
      const up = this.skyMaterial?.uniforms?.uProbe;
      if (up) up.value = restoreProbe ?? 0;
      try { ctx.renderer.setRenderTarget(null); } catch { /* ignore */ }
    }
  }

  /** True if some other system parented its own local lights into the scene. */
  _sceneHasForeignLights() {
    const mine = this.practicals?.group;
    let found = false;
    this.ctx.scene.traverse((o) => {
      if (found || !o.isLight) return;
      if (o.isDirectionalLight || o.isHemisphereLight || o.isAmbientLight) return;
      if (mine && o.parent === mine) return;
      found = true;
    });
    return found;
  }

  /**
   * Placeholder street lighting, used only while no level has registered practicals and
   * nothing else has put local lights in the scene. It retires itself the instant a real
   * practical arrives — see addPractical().
   */
  _spawnAutoPracticals() {
    const { ctx } = this;
    const art = ctx.config?.art ?? {};
    const origin = ctx.level?.spawnPoints?.[0] ?? ctx.systems?.level?.spawnPoints?.[0] ?? new THREE.Vector3();
    const col = art.practicalColor ?? 0xffb257;
    const specs = [
      [10.5, 4.4, 6.0, 16, 15, 0.0],
      [-9.0, 4.4, 11.0, 14, 14, 0.35],
      [4.0, 3.6, -12.5, 13, 13, 0.0],
      [-13.5, 4.0, -6.5, 12, 13, 0.55],
      [16.0, 3.2, -16.0, 10, 12, 0.0],
    ];
    for (const [x, y, z, i, r, fl] of specs) {
      const h = this.addPractical(
        new THREE.Vector3(origin.x + x, (origin.y ?? 0) + y, origin.z + z),
        col, i, r,
        { flicker: fl, flickerSpeed: 6 + Math.random() * 5, auto: true, tag: 'auto' },
      );
      if (h) this._autoPracticals.push(h);
    }
  }

  // ── frame ───────────────────────────────────────────────────────────────
  update(dt, elapsed) {
    const { ctx } = this;
    this._time = elapsed;

    try {
      if (this.skyMaterial) this.skyMaterial.uniforms.uTime.value = elapsed;
    } catch { /* ignore */ }

    try {
      const cam = ctx.camera;
      cam.updateMatrixWorld();
      cam.getWorldPosition(_camPos);

      if (this.csm) this.csm.update(cam);

      // Exactly one shadow-map refresh per frame, consumed by whichever pass renders
      // the scene first. See the autoUpdate note in init().
      ctx.renderer.shadowMap.needsUpdate = true;

      if (!this._autoPracticalsDone && elapsed > 1.2) {
        this._autoPracticalsDone = true;
        if (this.practicals && this.practicals.count === 0 && !this._sceneHasForeignLights()) {
          this._spawnAutoPracticals();
        }
      }

      if (this.practicals) {
        // Camera forward in world space — third column of the world matrix, negated.
        cam.matrixWorld.extractBasis(_bx, _by, _bz);
        _fwd.copy(_bz).negate();
        this.practicals.update(dt, elapsed, _camPos, _fwd);
      }
      if (this.pools) this.pools.update(dt, _camPos);
      if (this.dust) this.dust.update(elapsed, _camPos);
    } catch (err) {
      if (!this._loggedUpdateError) {
        this._loggedUpdateError = true;
        console.error('[lighting] update failed (suppressing further reports):', err);
      }
    }
  }

  resize() {
    try { this.csm?.resize(); } catch { /* ignore */ }
  }

  dispose() {
    try {
      this.csm?.dispose();
      this.pools?.dispose();
      this.dust?.dispose();
      this.practicals?.dispose();
      this.fog.uninstall();
      if (this.sky) { this.ctx.scene.remove(this.sky); this.sky.geometry.dispose(); }
      if (this.skyScene) {
        for (const c of [...this.skyScene.children]) { this.skyScene.remove(c); c.geometry?.dispose(); }
      }
      this.skyMaterial?.dispose();
      if (this.hemi) this.ctx.scene.remove(this.hemi);
      if (this.bounce) {
        this.ctx.scene.remove(this.bounce);
        this.ctx.scene.remove(this.bounce.target);
        this.bounce.dispose?.();
      }
      this._envRT?.dispose();
      this._pmrem?.dispose();
    } catch (err) {
      console.error('[lighting] dispose failed:', err);
    }
  }
}

export default LightingSystem;
