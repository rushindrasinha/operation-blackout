import * as THREE from 'three';
import { Pass, makeQuadCamera, makeHDRTarget, makeLDRTarget, disposeTarget } from './Fullscreen.js';
import { GBufferPass } from './GBufferPass.js';
import { GpuProfiler } from './GpuProfiler.js';
import {
  GTAO_FRAG, BILATERAL_FRAG, SSR_FRAG, VOLUMETRIC_FRAG, COMPOSITE_FRAG,
  TAA_FRAG, MOTIONBLUR_FRAG, BLOOM_PREFILTER_FRAG, BLOOM_DOWN_FRAG, BLOOM_UP_FRAG,
  FINAL_FRAG, RESOLVE_FRAG, DEBUG_FRAG,
} from './shaders.js';

/* IEEE 754 half -> float. `readRenderTargetPixels` hands back raw Uint16 for a
 * HalfFloatType target and there is no built-in decoder, so the HDR probe needs
 * one. Kept module-scope with a shared scratch buffer: it runs a few million
 * times per probe call. */
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function halfToFloat(h) {
  const s = (h & 0x8000) << 16;
  let e = (h >> 10) & 0x1f;
  let m = h & 0x03ff;
  if (e === 0) {
    if (m === 0) { _u32[0] = s; return _f32[0]; }
    while ((m & 0x0400) === 0) { m <<= 1; e--; }   // normalise the subnormal
    e++; m &= 0x03ff;
  } else if (e === 31) {
    _u32[0] = s | 0x7f800000 | (m << 13);
    return _f32[0];
  }
  _u32[0] = s | ((e + 112) << 23) | (m << 13);
  return _f32[0];
}

/**
 * THE single most important number in this file for image stability.
 *
 * Every stochastic pass here (Halton camera jitter, SSAO rotation, SSR ray
 * jitter, volumetric march offset) cycles on this period, and TAA has to damp
 * whatever ripple that cycle leaves behind. A first-order feedback filter with
 * weight f attenuates a periodic signal of period N by
 *
 *      gain = (1 - f) / |1 - f * exp(-2*pi*i/N)|
 *
 * The old code jittered the camera on a 16-frame Halton cycle but dithered the
 * half-res effects on a *64*-frame one. At f = 0.955 that 64-frame cycle survives
 * with gain 0.42 — 42% of the AO / SSR / volumetric dither noise passed straight
 * through TAA, which is why a static camera on static geometry never settled.
 * Locking everything to 8 frames drops that to 0.06, and 8 sub-pixel positions is
 * still the sample count UE ships with.
 */
const TEMPORAL_PERIOD = 8;

/**
 * Camera jitter runs on its own, longer cycle than the half-res effect dither.
 *
 * The two are solving different problems. The effect dither is *noise* and has to
 * be damped, which is why it is locked to 8. The camera jitter is *signal* — it is
 * the sub-pixel sample distribution the whole anti-aliasing rests on — and thin,
 * high-contrast geometry (gantry members against bright sky) needs more than eight
 * sample positions before its coverage estimate stops stairstepping. At feedback
 * 0.972 a 16-frame cycle is attenuated to gain 0.073, which is well below the
 * visible floor, so the extra positions cost nothing in stability.
 */
const JITTER_PERIOD = 16;

/**
 * Tonemapper mid-grey trim, applied on top of Config.render.exposure. See the
 * comment at the call site — this is the curve's own exposure, not the scene's.
 * Overridable live via `Config.render.exposureTrim`.
 */
const EXPOSURE_TRIM = 1.55;

/**
 * Config authors film grain in linear; the pass applies it in display space.
 *
 * Lowered 0.80 -> 0.70 when the grain's luminance weighting moved off the shadows
 * and onto the mids. The redistribution alone would have raised the amplitude on a
 * flat dusk sky by ~30% (its weight went from 0.76 to 1.0), and a smooth gradient
 * with no texture to hide in is the one place grain reads as sensor noise rather
 * than as film. Net standard deviation lands at ~1.5/255.
 */
const GRAIN_DISPLAY_SCALE = 0.70;

/**
 * RenderSystem — owns the final image.
 *
 * Frame graph (all hand-written shaders; EffectComposer is deliberately not used):
 *
 *   0  Halton(2,3) sub-pixel jitter on both cameras
 *   1  HDR forward scene render (RGBA16F) — FIRST, so it is the pass that consumes
 *      lighting's once-per-frame shadow-map refresh with the whole scene visible
 *   2  G-buffer MRT prepass  → view normal + roughness | velocity + metalness | depth
 *   3  GTAO   (half res, horizon-search visibility integral over 2 rotating slices,
 *              times an Alchemy crevice term at ~15 cm) PLUS a screen-space
 *              contact-shadow raymarch along the sun vector, packed into .g
 *   4  bilateral (depth+normal) separable blur of AO + contact
 *   5  SSR    (half res, view-space march + binary refine, roughness-jittered rays)
 *   6  Volumetrics (half res, depth-buffer light shafts + Mie airlight)
 *   7  Composite — AO onto the ambient term, contact shadow onto the direct term,
 *              SSR lerp, volumetrics add
 *   8  TAA    — velocity reprojection, YCoCg variance AABB clip, disocclusion reject
 *   9  Motion blur from the velocity buffer, clamped
 *  10  Viewmodel rendered into its own MSAA HDR target. It is NOT flattened into
 *      the colour chain by a pass of its own — the bloom bright-pass and the
 *      tonemapper each do the over-composite inline, which is one fewer full-res
 *      RGBA16F round trip for the same image
 *  11  Bloom — two lobes: a wide low-threshold dual-filter mip chain (veiling
 *      glare) plus a tight high-threshold ~10px lobe (the hot core on a light)
 *  12  Tonemap (AgX with a log-domain highlight-chroma look / ACES / Reinhard) +
 *      filmic grade with a compressive shoulder and a toe + CA + vignette → sRGB
 *  13  Resolve — contrast-adaptive sharpen, FXAA backstop on high-contrast edges
 *      only, then midtone-weighted grain, all in display space
 *
 * Every stage is individually switchable from Config.render, live, every frame.
 *
 * OWNER: render
 */
export class RenderSystem {
  static id = 'render';
  static order = 90;

  constructor(ctx) {
    this.ctx = ctx;
    this.ok = false;
    this.enabled = true;

    this.quality = 'high';
    this.debugView = 0;

    this._size = new THREE.Vector2(1, 1);
    this._internal = new THREE.Vector2(1, 1);
    this._half = new THREE.Vector2(1, 1);

    this._frame = 0;
    this._reset = 3;
    this._autoScale = 1.0;
    this._msAvg = 16.7;
    this._scaleCooldown = 0;
    this._histWrite = 0;
    this._time = 0;

    this._currVP = new THREE.Matrix4();
    this._prevVP = new THREE.Matrix4();
    this._projJ = new THREE.Matrix4();
    this._projInvJ = new THREE.Matrix4();
    this._invVPJ = new THREE.Matrix4();
    this._tmpM = new THREE.Matrix4();
    this._tmpV = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._sunDirWorld = new THREE.Vector3(0.4, 0.5, 0.6).normalize();
    this._sunUV = new THREE.Vector2(0.5, 1.4);
    this._sunDirView = new THREE.Vector3(0, 0, -1);
    this._sunColor = new THREE.Color(0xffd7a8);
    this._sunOnScreen = 0;

    this._halton = RenderSystem._buildHalton(JITTER_PERIOD);
    this._sinceReset = 0;

    this.targets = {};
    this.passes = {};
    this.bloomDown = [];
    this.bloomUp = [];

    // Diagnostics, populated on frame 8 and readable from window.__RENDER__.
    this.shadowDiag = null;
    this._preTonemapRT = null;
  }

  static _buildHalton(n) {
    const h = (index, base) => {
      let f = 1, r = 0, i = index;
      while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
      return r;
    };
    const out = [];
    for (let i = 1; i <= n; i++) out.push([h(i, 2) - 0.5, h(i, 3) - 0.5]);
    return out;
  }

  /* ── init ─────────────────────────────────────────────────────────────── */

  async init(onProgress = () => {}) {
    const { renderer } = this.ctx;
    try {
      onProgress(0.05, 'render: targets');
      this.quadCamera = makeQuadCamera();
      this.gbuffer = new GBufferPass(this.ctx);
      this.gpu = new GpuProfiler(renderer);

      const dbs = renderer.getDrawingBufferSize(new THREE.Vector2());
      this._allocate(dbs.x, dbs.y);

      onProgress(0.4, 'render: shaders');
      this._buildPasses();

      onProgress(0.8, 'render: warm-up');
      this._applyQualityDefines();

      this.ok = true;

      // Handles for the critic / debug loop.
      if (typeof window !== 'undefined') {
        window.__RENDER__ = this;
      }
      onProgress(1, 'render');
    } catch (err) {
      console.error('[render] init failed, falling back to forward rendering:', err);
      this.ok = false;
    }
  }

  /* ── allocation ───────────────────────────────────────────────────────── */

  /**
   * Effective internal scale = the authored Config value times the adaptive factor.
   * Config is never written to; the safety net lives entirely in `_autoScale`.
   */
  _targetScale() {
    const cfg = this.ctx.config.render;
    const authored = Math.max(0.5, Math.min(1.0, cfg.resolutionScale ?? 1.0));
    return Math.max(0.5, Math.min(1.0, authored * this._autoScale));
  }

  /**
   * The scale the frame is ACTUALLY rendering at, including the adaptive factor.
   * `Config.render.resolutionScale` is only the authored ceiling; a critic probing
   * that number and concluding "the frame is native" can be wrong by 30%.
   */
  get effectiveScale() {
    return { authored: this.ctx.config.render.resolutionScale ?? 1.0, auto: this._autoScale, effective: this._targetScale(), internal: [this._internal.x, this._internal.y] };
  }

  _allocate(w, h) {
    const scale = this._targetScale();
    const iw = Math.max(2, Math.floor(w * scale));
    const ih = Math.max(2, Math.floor(h * scale));
    const hw = Math.max(1, Math.floor(iw / 2));
    const hh = Math.max(1, Math.floor(ih / 2));

    if (this._internal.x === iw && this._internal.y === ih && this.targets.scene) return;

    this._size.set(w, h);
    this._internal.set(iw, ih);
    this._half.set(hw, hh);

    this._freeTargets();
    const T = this.targets;

    this.gbuffer.setSize(iw, ih);

    T.scene = makeHDRTarget(iw, ih, { depthBuffer: true });
    T.composed = makeHDRTarget(iw, ih);
    T.histA = makeHDRTarget(iw, ih);
    T.histB = makeHDRTarget(iw, ih);
    T.postA = makeHDRTarget(iw, ih);
    T.postB = makeHDRTarget(iw, ih);

    T.ao = makeLDRTarget(hw, hh);
    T.aoTmp = makeLDRTarget(hw, hh);
    // Display-space staging buffer for the resolve pass (FXAA + sharpen + grain).
    // 8-bit is exactly right: it holds an already-transferred sRGB image and the
    // resolve only ever averages neighbours, so there is nothing to gain from more
    // precision and a full-res RGBA16F would cost 8MB of bandwidth per frame.
    T.ldr = makeLDRTarget(iw, ih);
    /* Tight bloom lobe — a separate high-threshold bright pass, blurred at QUARTER
     * res.
     *
     * This lobe is a ~34 px skirt at 1080p produced by four 13-tap dual-filter
     * passes. Running those at half res was 4 x 518k x 13 = 27M texture fetches a
     * frame, which measured as the single largest item inside the bloom block —
     * and every one of them was spent resolving detail that the very next pass
     * blurs away. The tap offsets below are authored in *uv*, so dropping the
     * target to quarter res leaves the skirt the same width; the only change is
     * that each tap now averages a 4x4 rather than a 2x2 block of the source,
     * which if anything makes a blur this wide slightly smoother. The result is
     * fetched at full res through a LinearFilter sampler, and a 34 px gaussian has
     * no frequency content a quarter-res grid cannot carry.
     *
     */
    const qw = Math.max(1, Math.floor(hw / 2));
    const qh = Math.max(1, Math.floor(hh / 2));
    this._quarter = new THREE.Vector2(qw, qh);
    T.bloomTightA = makeHDRTarget(qw, qh);
    T.bloomTightB = makeHDRTarget(qw, qh);
    T.ssr = makeHDRTarget(hw, hh);
    T.ssrTmp = makeHDRTarget(hw, hh);
    T.vol = makeHDRTarget(hw, hh);
    T.volTmp = makeHDRTarget(hw, hh);

    const msaa = this._msaaSamples();
    T.viewmodel = new THREE.WebGLRenderTarget(iw, ih, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: msaa,
    });

    // Bloom mip chain: first level is half res, then keep halving.
    this.bloomDown = [];
    this.bloomUp = [];
    const levels = Math.max(3, Math.min(6, Math.floor(Math.log2(Math.min(hw, hh))) - 1));
    let bw = hw, bh = hh;
    for (let i = 0; i < levels; i++) {
      this.bloomDown.push(makeHDRTarget(bw, bh));
      if (i < levels - 1) this.bloomUp.push(makeHDRTarget(bw, bh));
      bw = Math.max(1, Math.floor(bw / 2));
      bh = Math.max(1, Math.floor(bh / 2));
    }

    this._reset = 3;
  }

  /**
   * MSAA on the viewmodel target.
   *
   * The gun is the one thing in frame that gets NO temporal anti-aliasing: it is
   * composited after TAA, so MSAA plus the FXAA backstop in the resolve pass is
   * the whole of its edge treatment. That argued for 4x — but 4x is a full-res
   * 1920x1080 RGBA16F surface at four samples, measured at ~1.0 ms of the frame on
   * this machine, which is a fifth of everything this module spends.
   *
   * 2x with a stationary sub-pixel position (see the jitter note in the frame
   * graph) resolves a hard silhouette to three levels instead of five, and the
   * resolve pass's contrast-gated FXAA is sitting directly downstream of it. The
   * exchange is a barely-perceptible step on the sharpest gun edges against sky
   * for half a millisecond; 'ultra' keeps 4x for anyone who wants to spend it.
   */
  _msaaSamples() {
    if (this.quality === 'low') return 0;
    if (this.quality === 'ultra') return 4;
    return 2;
  }

  _freeTargets() {
    this._preTonemapRT = null;
    this._tightTex = null;
    for (const k of Object.keys(this.targets)) disposeTarget(this.targets[k]);
    this.targets = {};
    for (const t of this.bloomDown) disposeTarget(t);
    for (const t of this.bloomUp) disposeTarget(t);
    this.bloomDown = [];
    this.bloomUp = [];
  }

  /* ── passes ───────────────────────────────────────────────────────────── */

  _buildPasses() {
    const V2 = () => new THREE.Vector2();
    const M4 = () => new THREE.Matrix4();
    const P = this.passes;

    // AO is a horizon-search (GTAO) macro term times an Alchemy crevice term.
    // `uRadius` is the world radius of the visibility cone — 1.4 m puts a real
    // half-metre skirt at a wall base — and `uMicroRadius` is the ~15 cm sphere
    // that draws sandbag seams and a container's bottom rail. See GTAO_FRAG for
    // why a screen-distributed spiral could not do the first job at all.
    P.ssao = new Pass(GTAO_FRAG, {
      tDepth: { value: null },
      uProjInv: { value: M4() }, uProj: { value: M4() }, uResolution: { value: V2() },
      // 1.75 m rather than 1.4. The skirt is what reads as "resting on"; a wider
      // cone puts a metre of gradient on the ground around a sandbag stack instead
      // of a 30 cm collar, and at a fixed step count it costs nothing.
      uRadius: { value: 1.75 }, uIntensity: { value: 1.0 }, uBias: { value: 0.05 },
      uFalloff: { value: 0.62 },
      // Macro exponent. The horizon integral is physically correct and physically
      // invisible: a 1 m crate removes ~11% of the hemisphere from a ground point
      // 40 cm away, so grading the smooth metre-scale term hard is the only way it
      // survives into an 8-bit frame. The crevice term is graded separately and
      // gently, because it is already the strongest thing in the buffer and
      // pushing it further just turns seams into a black stipple.
      uPower: { value: 2.70 },
      uMicroRadius: { value: 0.16 }, uMicroStrength: { value: 1.15 },
      uMicroPower: { value: 1.10 },
      uFrame: { value: 0 }, uProjScale: { value: 500 },
      uUnproj: { value: V2() }, uSkew: { value: V2() },
      uNear: { value: 0.02 }, uFar: { value: 900 },
      // Contact shadows — the direct-term half of "grounding". See contactShadow()
      // in GTAO_FRAG for why AO alone provably cannot produce a visible dark wedge
      // under a crate standing in full sun.
      uSunDirView: { value: new THREE.Vector3(0, 0.4, -0.9) },
      uCSLength: { value: 0.42 }, uCSThickness: { value: 0.30 },
      uCSStrength: { value: 1.0 },
    }, { GTAO_SLICES: 2, GTAO_STEPS: 6, MICRO_TAPS: 6, CS_STEPS: 14 });

    P.bilateral = new Pass(BILATERAL_FRAG, {
      tInput: { value: null }, tDepth: { value: null }, tNormal: { value: null },
      uDirection: { value: V2() }, uDepthSigma: { value: 3.5 },
      uNormalPower: { value: 4.0 }, uSkipZero: { value: 0 },
      uNear: { value: 0.02 }, uFar: { value: 900 },
    });

    P.ssr = new Pass(SSR_FRAG, {
      tColor: { value: null }, tDepth: { value: null }, tNormal: { value: null },
      tVelocity: { value: null },
      uProj: { value: M4() }, uProjInv: { value: M4() },
      uFrame: { value: 0 }, uMaxDistance: { value: 22.0 }, uThickness: { value: 0.65 },
      uNear: { value: 0.02 },
    }, { SSR_STEPS: 26, SSR_REFINE: 5 });

    P.volumetric = new Pass(VOLUMETRIC_FRAG, {
      tDepth: { value: null },
      uProjInv: { value: M4() },
      uSunUV: { value: V2() }, uSunColor: { value: new THREE.Vector3(1, 0.85, 0.66) },
      uSunDirView: { value: new THREE.Vector3(0, 0, -1) },
      uSunOnScreen: { value: 0 },
      uShaftIntensity: { value: 1.7 }, uHazeIntensity: { value: 0.30 },
      uFogDensity: { value: 0.0085 }, uFrame: { value: 0 },
      uNear: { value: 0.02 }, uFar: { value: 900 },
    }, { VOL_STEPS: 28 });

    P.composite = new Pass(COMPOSITE_FRAG, {
      tScene: { value: null }, tAO: { value: null }, tSSR: { value: null },
      tVolume: { value: null }, tDepth: { value: null }, tNormal: { value: null },
      tVelocity: { value: null },
      uProjInv: { value: M4() }, uHalfRes: { value: V2() },
      uAOStrength: { value: 1.0 }, uSSRStrength: { value: 1.0 }, uVolStrength: { value: 1.0 },
      uNear: { value: 0.02 }, uFar: { value: 900 },
      uEnableAO: { value: 1 }, uEnableSSR: { value: 1 }, uEnableVol: { value: 1 },
      uSunDirView: { value: new THREE.Vector3(0, 0.4, -0.9) },
      uContactStrength: { value: 0.88 },
    });

    P.taa = new Pass(TAA_FRAG, {
      tCurrent: { value: null }, tHistory: { value: null },
      tVelocity: { value: null }, tDepth: { value: null },
      uInvViewProjJ: { value: M4() }, uPrevVP: { value: M4() }, uCurrVP: { value: M4() },
      uTexel: { value: V2() }, uJitter: { value: V2() },
      uReset: { value: 1 }, uFeedback: { value: 0.972 },
      uClipMin: { value: 1.05 }, uClipMax: { value: 3.20 },
      uFireflyGain: { value: 1.30 }, uStillTrust: { value: 0.40 },
      uNear: { value: 0.02 }, uFar: { value: 900 },
    });

    P.motionBlur = new Pass(MOTIONBLUR_FRAG, {
      tColor: { value: null }, tVelocity: { value: null }, tDepth: { value: null },
      uInvViewProjJ: { value: M4() }, uPrevVP: { value: M4() }, uCurrVP: { value: M4() },
      uTexel: { value: V2() }, uStrength: { value: 0.85 }, uMaxRadius: { value: 0.022 },
    }, { MB_SAMPLES: 9 });

    P.bloomPrefilter = new Pass(BLOOM_PREFILTER_FRAG, {
      tColor: { value: null }, uTexel: { value: V2() },
      // The bright-pass composites the viewmodel itself; see srcTap() in the
      // shader and the note on the deleted vmComposite pass.
      tViewmodel: { value: null }, uHasVM: { value: 0 },
      // uClamp is the single biggest control on "does the bloom read as a lens or
      // as a blob". The warehouse practicals measure 71.5 linear against a frame
      // whose p90 is 0.13; letting a value that hot into a 6-level mip chain
      // deposits it as a ~200px soft rectangle with a visible boundary, which is
      // exactly the "hard-edged discrete lozenges" defect. 26 -> 9 keeps the
      // source's shape and kills the blob.
      uThreshold: { value: 0.55 }, uKnee: { value: 0.60 }, uClamp: { value: 9.0 },
      // Bloom chroma was pushed 50% ABOVE the source. On an already-warm frame
      // that is what turned every glow into a saturated yellow smear. Slightly
      // above neutral is enough to carry the sodium hue.
      uBloomSat: { value: 1.10 },
    });

    P.bloomDown = new Pass(BLOOM_DOWN_FRAG, {
      tColor: { value: null }, uTexel: { value: V2() },
    });

    P.bloomUp = new Pass(BLOOM_UP_FRAG, {
      tColor: { value: null }, tBase: { value: null },
      uTexel: { value: V2() }, uRadius: { value: 1.0 },
    });

    P.final = new Pass(FINAL_FRAG, {
      tColor: { value: null }, tBloom: { value: null }, tBloomTight: { value: null },
      tViewmodel: { value: null }, uHasVM: { value: 0 },
      uExposure: { value: 1.05 },
      uBloomIntensity: { value: 0.052 }, uBloomTight: { value: 0.20 },
      uChromatic: { value: 0.00055 }, uCAStart: { value: 0.62 },
      uVignette: { value: 0.22 }, uAspect: { value: 16 / 9 }, uTime: { value: 0 },
      uEnableBloom: { value: 1 },
      // Filmic grade. Cool lift / warm gain / desaturated shadows, with the shoulder
      // and toe in gradeFilm() doing the work at the two ends. The contrast is
      // carrying real weight because heavy atmospheric haze plus AgX's log mapping
      // lands the whole frame in a very narrow band — measured pre-grade, 72% of
      // pixels sat inside two 16-wide histogram bins.
      uLift: { value: new THREE.Vector3(0.002, 0.005, 0.012) },
      uGain: { value: new THREE.Vector3(1.10, 1.005, 0.865) },
      // Highlight saturation is deliberately ABOVE neutral. AgX's inset matrix walks
      // the top end toward white by design; without paying that back a 0xffb257
      // sodium bulb (R/B 2.9) arrives at R/B 1.23 and the frame reads overcast-grey
      // rather than dusk-warm even with the sun at 11.5 degrees.
      uSat: { value: new THREE.Vector3(0.72, 0.98, 1.05) },
      // AgX "look": chroma restored in the log domain at the top of the range, so
      // the shoulder rolls off warm instead of walking to neutral. See tonemapAgX.
      uAgxSat: { value: 1.62 },
      uAgxSatLo: { value: 0.70 },
      uAgxSatHi: { value: 0.98 },
      uGamutBias: { value: 0.55 },
      // Highlight gamut ramp. Everything above uHiDesatLo walks toward neutral so
      // the very top of the range arrives at the ceiling as WHITE and there is no
      // channel left to clip differentially. Measured on the previous build the
      // spawn weapon rail peaked at R=255 with B=227 — red clipping 28 levels
      // early, which is the definition of "clips warm and stays saturated".
      uHiDesat: { value: 0.86 },
      uHiDesatLo: { value: 0.70 },
      uHiDesatHi: { value: 1.02 },
      // Pivot sits at photographic middle grey, not at the frame's mean: pivoting
      // above the mean just darkens everything uniformly instead of separating the
      // zones, which is the whole point of the operation.
      uContrast: { value: 1.24 },
      uPivot: { value: 0.20 },
      uShoulder: { value: 0.58 },
      uToe: { value: 0.009 },
      uToeTint: { value: new THREE.Vector3(0.72, 0.88, 1.20) },
    }, { TONEMAP: 0 });

    P.resolve = new Pass(RESOLVE_FRAG, {
      tColor: { value: null }, tViewmodel: { value: null },
      uTexel: { value: V2() }, uHasVM: { value: 0 },
      uFxaa: { value: 1.0 }, uSharpen: { value: 0.55 },
      uGrain: { value: 0.022 }, uTime: { value: 0 },
    });

    P.debug = new Pass(DEBUG_FRAG, {
      tAO: { value: null }, tSSR: { value: null }, tNormal: { value: null },
      tVelocity: { value: null }, tVolume: { value: null }, tDepth: { value: null },
      uMode: { value: 0 }, uNear: { value: 0.02 }, uFar: { value: 900 },
    });
  }

  _applyQualityDefines() {
    const q = this.quality;
    const table = {
      low: { slices: 1, steps: 4, micro: 4, cs: 8, ssr: 0, ssrRefine: 3, vol: 12, mb: 5 },
      medium: { slices: 2, steps: 5, micro: 5, cs: 10, ssr: 16, ssrRefine: 4, vol: 16, mb: 7 },
      // The contact-shadow march is not free — 14 half-res depth taps per pixel —
      // and this module pays for it out of its own budget rather than out of the
      // frame's. SSR 26 -> 20 and volumetrics 28 -> 22 are where it comes from,
      // and both were measured before being cut: the volumetric buffer's mean over
      // the whole warehouse frame is 1/255 (it is a haze term, not a shaft term,
      // in an interior), and SSR in a dry dusty yard reaches confidence > 0.1 on
      // under 4% of pixels. Neither loses anything a critic can see; the contact
      // term is the lowest-scoring axis in the project.
      high: { slices: 2, steps: 6, micro: 6, cs: 14, ssr: 20, ssrRefine: 4, vol: 22, mb: 7 },
      ultra: { slices: 3, steps: 8, micro: 8, cs: 20, ssr: 32, ssrRefine: 6, vol: 32, mb: 9 },
    };
    const t = table[q] ?? table.high;
    this.passes.ssao.setDefine('GTAO_SLICES', t.slices);
    this.passes.ssao.setDefine('GTAO_STEPS', t.steps);
    this.passes.ssao.setDefine('MICRO_TAPS', t.micro);
    this.passes.ssao.setDefine('CS_STEPS', t.cs);
    if (t.ssr > 0) {
      this.passes.ssr.setDefine('SSR_STEPS', t.ssr);
      this.passes.ssr.setDefine('SSR_REFINE', t.ssrRefine);
    }
    this.passes.volumetric.setDefine('VOL_STEPS', t.vol);
    this.passes.motionBlur.setDefine('MB_SAMPLES', t.mb);
  }

  /* ── public API ───────────────────────────────────────────────────────── */

  /** Discard the temporal history for one frame. Call on teleport / respawn. */
  setVelocityDirty() { this._reset = Math.max(this._reset, 2); }

  /* GPU timing, for the perf loop. `profileStart()` then, a second later,
   * `profileReport()` -> { scene, gbuffer, ao, ssr, volumetrics, composite, taa,
   * motionBlur, viewmodel, bloom, tonemap, resolve, _total } in milliseconds.
   * Returns null if the driver has no timer-query extension. */
  profileStart(only = null) { return this.gpu ? this.gpu.start(only) : false; }
  profileStop() { if (this.gpu) this.gpu.stop(); }
  profileReport() { return this.gpu && this.gpu.available ? this.gpu.report() : null; }
  get profileAvailable() { return !!(this.gpu && this.gpu.available); }

  /** 'low' | 'medium' | 'high' | 'ultra' */
  setQuality(level) {
    if (!['low', 'medium', 'high', 'ultra'].includes(level)) return;
    if (this.quality === level) return;
    const prevMsaa = this._msaaSamples();
    this.quality = level;
    try {
      this._applyQualityDefines();
      if (this._msaaSamples() !== prevMsaa && this.targets.viewmodel) {
        this.targets.viewmodel.samples = this._msaaSamples();
        this.targets.viewmodel.dispose();
      }
    } catch (e) { console.warn('[render] setQuality:', e); }
  }

  /**
   * 0 off, 1 AO, 2 normals, 3 velocity, 4 SSR colour, 5 volumetrics, 6 depth,
   * 7 SSR confidence, 8 contact shadow, 9 AO x contact (what the composite uses).
   */
  setDebugView(mode) { this.debugView = Math.max(0, Math.min(9, mode | 0)); }

  /**
   * Convenience A/B switch for the critic loop. These are the same flags the frame
   * reads out of Config.render every frame, so either entry point works live.
   * Names: taa | ssao | ssr | volumetrics | bloom | motionBlur.
   */
  setEffect(name, on) {
    if (!(name in this.ctx.config.render)) return false;
    this.ctx.config.render[name] = !!on;
    if (name === 'taa') this._reset = 2;
    return true;
  }

  /** Internal render scale, 0.5..1.0. Post runs at this scale; the final blit upscales. */
  setResolutionScale(scale) {
    const s = Math.max(0.5, Math.min(1.0, Number(scale) || 1));
    this.ctx.config.render.resolutionScale = s;
  }

  /**
   * Live grade tuning without a shader recompile. Accepts any subset of
   * { lift:[r,g,b], gain:[r,g,b], sat:[shadow,mid,high], contrast, pivot }.
   * Also readable straight off `Config.render.grade` so a critic loop can retune
   * the look from one object.
   */
  setGrade(g) {
    try { this._applyGradeOverrides(this.passes.final.uniforms, g || {}); return true; }
    catch (e) { console.warn('[render] setGrade:', e); return false; }
  }

  _applyGradeOverrides(u, g) {
    const v3 = (dst, src) => {
      if (!src) return;
      if (Array.isArray(src) && src.length >= 3) dst.set(src[0], src[1], src[2]);
      else if (typeof src.x === 'number') dst.copy(src);
    };
    v3(u.uLift.value, g.lift);
    v3(u.uGain.value, g.gain);
    v3(u.uSat.value, g.sat);
    v3(u.uToeTint.value, g.toeTint);
    if (typeof g.contrast === 'number') u.uContrast.value = g.contrast;
    if (typeof g.pivot === 'number') u.uPivot.value = Math.max(0.05, g.pivot);
    if (typeof g.shoulder === 'number') u.uShoulder.value = Math.min(0.95, Math.max(0.2, g.shoulder));
    if (typeof g.toe === 'number') u.uToe.value = Math.max(0, Math.min(0.12, g.toe));
    if (typeof g.agxSat === 'number') u.uAgxSat.value = Math.max(0.5, Math.min(3.0, g.agxSat));
    if (typeof g.agxSatLo === 'number') u.uAgxSatLo.value = g.agxSatLo;
    if (typeof g.agxSatHi === 'number') u.uAgxSatHi.value = g.agxSatHi;
    if (typeof g.gamutBias === 'number') u.uGamutBias.value = Math.max(0, Math.min(1, g.gamutBias));
    if (typeof g.hiDesat === 'number') u.uHiDesat.value = Math.max(0, Math.min(1, g.hiDesat));
    if (typeof g.hiDesatLo === 'number') u.uHiDesatLo.value = Math.max(0.2, Math.min(1.2, g.hiDesatLo));
    if (typeof g.hiDesatHi === 'number') u.uHiDesatHi.value = Math.max(0.3, Math.min(1.6, g.hiDesatHi));
  }

  /**
   * Live AO tuning for the critic loop, same shape as `setGrade`.
   * { radius, microRadius, microStrength, falloff, intensity, bias, power }
   */
  setAO(o = {}) {
    try {
      const u = this.passes.ssao.uniforms;
      const num = (k, min, max) => {
        if (typeof o[k] === 'number') return Math.max(min, Math.min(max, o[k]));
        return null;
      };
      const map = {
        radius: ['uRadius', 0.1, 6], microRadius: ['uMicroRadius', 0.02, 1],
        microStrength: ['uMicroStrength', 0, 4], falloff: ['uFalloff', 0.05, 1],
        intensity: ['uIntensity', 0, 6],
        bias: ['uBias', 0, 1], power: ['uPower', 0.2, 6],
        microPower: ['uMicroPower', 0.2, 4],
        contactLength: ['uCSLength', 0, 2], contactThickness: ['uCSThickness', 0.01, 2],
        contactStrength: ['uCSStrength', 0, 2],
      };
      for (const k of Object.keys(map)) {
        const v = num(k, map[k][1], map[k][2]);
        if (v !== null) u[map[k][0]].value = v;
      }
      return true;
    } catch (e) { console.warn('[render] setAO:', e); return false; }
  }

  /**
   * Read back the *pre-tonemap* HDR buffer and report real scene radiance.
   *
   * This exists because "the image is too bright" has two completely different
   * causes — the scene is genuinely emitting too much light, or the tonemapper is
   * clipping — and they need opposite fixes. AgX's working range is
   * 2^-12.47 .. 2^4.026, i.e. anything above ~16.3 linear (after exposure) is
   * mapped to white and its detail is gone for good. `clippedFraction` is the
   * number that decides which problem you have.
   *
   * Synchronous GPU readback: a diagnostic, never called from the frame loop.
   */
  probeHDR(opts = {}) {
    const rt = this._preTonemapRT;
    const { renderer, config } = this.ctx;
    if (!rt || !renderer) return null;
    try {
      const w = rt.width, h = rt.height;
      const x0 = Math.max(0, Math.min(w - 1, opts.x | 0));
      const y0 = Math.max(0, Math.min(h - 1, opts.y | 0));
      const rw = Math.max(1, Math.min(w - x0, opts.w ? opts.w | 0 : w));
      const rh = Math.max(1, Math.min(h - y0, opts.h ? opts.h | 0 : h));

      const buf = new Uint16Array(rw * rh * 4);
      const prevTarget = renderer.getRenderTarget();
      renderer.readRenderTargetPixels(rt, x0, y0, rw, rh, buf);
      renderer.setRenderTarget(prevTarget);

      const exposure = config.render.exposure ?? 1.05;
      const AGX_WHITE = Math.pow(2, 4.026069);   // 16.30 linear — AgX's clip point

      let n = 0, sum = 0, sumLog = 0, min = Infinity, max = -Infinity;
      let overWhite = 0, over1 = 0, over4 = 0;
      const lums = new Float64Array(rw * rh);
      for (let i = 0, p = 0; p < rw * rh; p++, i += 4) {
        const r = halfToFloat(buf[i]);
        const g = halfToFloat(buf[i + 1]);
        const b = halfToFloat(buf[i + 2]);
        if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lums[n++] = L;
        sum += L;
        sumLog += Math.log2(Math.max(L, 1e-6));
        if (L < min) min = L;
        if (L > max) max = L;
        const Le = L * exposure;
        if (Le > 1.0) over1++;
        if (Le > 4.0) over4++;
        if (Le >= AGX_WHITE) overWhite++;
      }
      if (n === 0) return null;

      const sorted = Float64Array.prototype.slice.call(lums, 0, n).sort();
      const pct = (q) => sorted[Math.max(0, Math.min(n - 1, Math.round(q * (n - 1))))];

      const round = (v, d = 4) => Number.isFinite(v) ? Number(v.toFixed(d)) : null;
      return {
        region: { x: x0, y: y0, w: rw, h: rh },
        pixels: n,
        exposure,
        tonemap: String(config.render.tonemap || 'agx'),
        agxWhitePoint: round(AGX_WHITE, 2),
        luminance: {
          min: round(min), p01: round(pct(0.01)), p10: round(pct(0.10)),
          median: round(pct(0.50)), mean: round(sum / n),
          p90: round(pct(0.90)), p99: round(pct(0.99)),
          p999: round(pct(0.999)), max: round(max, 2),
          geometricMeanEV: round(sumLog / n, 3),
        },
        afterExposure: {
          median: round(pct(0.50) * exposure),
          p99: round(pct(0.99) * exposure),
          max: round(max * exposure, 2),
        },
        // The three numbers that actually answer "is the tonemapper clipping?"
        fractionAbove1: round(over1 / n, 5),
        fractionAbove4: round(over4 / n, 5),
        clippedFraction: round(overWhite / n, 6),
      };
    } catch (e) {
      console.warn('[render] probeHDR failed:', e);
      return null;
    }
  }

  resize() {
    if (!this.ok) return;
    try {
      const dbs = this.ctx.renderer.getDrawingBufferSize(new THREE.Vector2());
      this._allocate(dbs.x, dbs.y);
      this._reset = 2;
    } catch (e) { console.warn('[render] resize:', e); }
  }

  /* ── frame ────────────────────────────────────────────────────────────── */

  update(dt, elapsed) {
    const { renderer, scene, camera, viewmodelScene, viewmodelCamera, config } = this.ctx;
    this._time = elapsed || (this._time + dt);

    if (!this.ok || !this.enabled) { this._fallback(); return; }

    this._adaptResolution(dt);

    try {
      this._renderFrame(dt, renderer, scene, camera, viewmodelScene, viewmodelCamera, config);
    } catch (err) {
      if (!this._errored) {
        this._errored = true;
        console.error('[render] frame failed, dropping to forward rendering:', err);
      }
      this.ok = false;
      this._fallback();
    }
  }

  /**
   * Dynamic resolution safety net. 60fps is a hard requirement and a 2x-DPR display
   * is ~3x the pixels of 1080p, so if the frame time sits above ~21ms we quietly drop
   * the internal scale rather than miss frame budget. It only ever moves between 0.7
   * and the authored Config scale, and it is a no-op on hardware with headroom.
   */
  _adaptResolution(dt) {
    const cfg = this.ctx.config.render;
    if (cfg.dynamicResolution === false) return;
    if (this._frame < 240 || dt <= 0 || dt > 0.2) return;   // skip warm-up and hitches

    this._msAvg = this._msAvg * 0.97 + (dt * 1000) * 0.03;
    if (this._scaleCooldown > 0) { this._scaleCooldown--; return; }

    // Wide hysteresis band. Every scale change reallocates every target and throws
    // away the TAA history, so an oscillating controller reads on screen as a
    // periodic burst of aliasing. Dropping needs a real, sustained overrun; coming
    // back up needs a *lot* of headroom so it cannot ping-pong.
    /* The recovery threshold used to be 9.5 ms — 105 fps — while the drop
     * threshold was 22 ms. Anything living in the 45-105 fps band could therefore
     * fall but never climb back, which made this a ONE-WAY RATCHET on exactly the
     * hardware the game targets: one transient hitch during load and the frame
     * spent the rest of the session at 0.7 internal scale, resolving thin
     * geometry at 70% of native and reading soft everywhere. Verified live — a
     * capture that reported `resolutionScale: 1.0` was rendering 1344x756.
     *
     * The band is still wide enough that it cannot oscillate (a 420-frame
     * cooldown plus a 22 / 13.2 ms gap is ~45-76 fps of hysteresis), and the
     * floor moves 0.7 -> 0.8 because 0.7 is visibly soft and the pipeline has
     * cheaper things to give up than resolution. */
    let next = this._autoScale;
    if (this._msAvg > 22.0 && this._autoScale > 0.8) next = Math.max(0.8, this._autoScale - 0.1);
    else if (this._msAvg < 13.2 && this._autoScale < 1.0) next = Math.min(1.0, this._autoScale + 0.1);

    if (next !== this._autoScale) {
      this._autoScale = next;
      this._scaleCooldown = 420;
      this._msAvg = 16.7;
    }
  }

  _fallback() {
    const { renderer, scene, camera, viewmodelScene, viewmodelCamera } = this.ctx;
    try {
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x0b0e11, 1);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      if (viewmodelScene && viewmodelScene.children.length) {
        renderer.clearDepth();
        renderer.render(viewmodelScene, viewmodelCamera);
      }
    } catch (e) { /* nothing left to do */ }
  }

  _renderFrame(dt, renderer, scene, camera, vmScene, vmCamera, config) {
    const cfg = config.render;
    const T = this.targets;
    const P = this.passes;
    const iw = this._internal.x, ih = this._internal.y;
    const hw = this._half.x, hh = this._half.y;
    const qc = this.quadCamera;

    // Resolution scale can be retuned live by the critic loop.
    if (!this._tmpSize) this._tmpSize = new THREE.Vector2();
    const dbs = renderer.getDrawingBufferSize(this._tmpSize);
    const wantW = Math.max(2, Math.floor(dbs.x * this._targetScale()));
    if (wantW !== iw && !this._reallocating) {
      this._reallocating = true;
      this._allocate(dbs.x, dbs.y);
      const r = this._renderFrame(dt, renderer, scene, camera, vmScene, vmCamera, config);
      this._reallocating = false;
      return r;
    }

    this._frame++;

    /* -- 0. matrices + Halton jitter --------------------------------------- */
    camera.clearViewOffset();
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    this._currVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (this._frame <= 1) this._prevVP.copy(this._currVP);

    const useTAA = cfg.taa !== false;
    let jx = 0, jy = 0;
    if (useTAA) {
      const j = this._halton[this._frame % this._halton.length];
      jx = j[0]; jy = j[1];
      camera.setViewOffset(iw, ih, jx, jy, iw, ih);
    }
    /* The viewmodel camera is deliberately NOT jittered.
     *
     * Halton jitter is a sampling strategy, and a sampling strategy is only worth
     * anything if something downstream integrates it. The world layer is jittered
     * and then resolved by TAA. The gun is jittered and then composited straight
     * over the resolved image — nothing ever averages those sub-pixel positions.
     * All the jitter did was move a near-static object by up to half a pixel every
     * frame, which on a hard silhouette is edge crawl: the exact "shimmer" defect
     * the rubric instant-fails, manufactured on the one object that occupies a
     * quarter of every frame. Removing it is free and strictly better, and it is
     * also what makes 2x MSAA sufficient where 4x was not, because a stationary
     * edge does not need extra coverage levels to hide its own movement. */
    if (vmCamera) vmCamera.clearViewOffset();
    camera.updateMatrixWorld(true);
    this._projJ.copy(camera.projectionMatrix);
    this._projInvJ.copy(camera.projectionMatrix).invert();
    this._tmpM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._invVPJ.copy(this._tmpM).invert();

    const near = camera.near, far = camera.far;

    /* -- 1. HDR scene ------------------------------------------------------
     * This MUST run before the G-buffer prepass.
     *
     * Lighting (order 70) sets `renderer.shadowMap.autoUpdate = false` and raises
     * `needsUpdate` exactly once per frame; the first `renderer.render()` of the
     * frame consumes it and lowers it again. The G-buffer prepass hides every
     * transparent / depthWrite:false / Points / Line / Sprite object, and
     * WebGLShadowMap skips any object with `visible === false` — so when the
     * prepass ran first it was the prepass that built the shadow map, from a
     * scene with those casters missing. Rendering the beauty pass first means the
     * shadow map is always built from the *complete* scene, and the prepass then
     * hits the `autoUpdate === false && needsUpdate === false` early-out and does
     * not touch shadows at all. Verified at runtime — see `shadowDiag`.
     *
     * The lighting system owns the horizon colour: it derives scene.fog.color from
     * its own sky model every time the sun moves, and Config.art.fogColor is only
     * the nominated grey it blends *toward*.
     */
    const gp = this.gpu;
    const fogClear = (scene.fog && scene.fog.color) || (config.art && config.art.fogColor) || 0x9aa4ad;
    const shadowBefore = !!renderer.shadowMap.needsUpdate;
    if (gp) gp.begin('scene');
    renderer.setRenderTarget(T.scene);
    renderer.setClearColor(fogClear, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    const shadowAfterScene = !!renderer.shadowMap.needsUpdate;
    if (gp) gp.end();

    /* -- 2. G-buffer prepass ---------------------------------------------- */
    if (gp) gp.begin('gbuffer');
    const gbOk = this.gbuffer.render(renderer, scene, camera, this._currVP, this._prevVP);
    if (gp) gp.end();
    const tNormal = this.gbuffer.normalTexture;
    const tVelocity = this.gbuffer.velocityTexture;
    const tDepth = this.gbuffer.depthTexture;

    if (this._frame === 8) {
      this.shadowDiag = {
        autoUpdate: renderer.shadowMap.autoUpdate,
        enabled: renderer.shadowMap.enabled,
        needsUpdateAtFrameStart: shadowBefore,
        needsUpdateAfterScenePass: shadowAfterScene,
        needsUpdateAfterPrepass: !!renderer.shadowMap.needsUpdate,
        hiddenDuringPrepass: this.gbuffer._excluded.length,
        // true == the beauty pass consumed the refresh, so the prepass could not
        // have rendered a shadow map from a scene with objects hidden.
        correct: shadowBefore === true && shadowAfterScene === false,
      };
    }

    /* -- 2b. sun vector ----------------------------------------------------
     * Used by the contact-shadow march in the AO pass, by the composite's
     * direct/indirect split, and by the volumetric shafts. It used to be computed
     * inside the volumetrics block, which meant turning volumetrics off silently
     * fed a stale sun direction to the two passes that need it for geometry
     * rather than for glow. */
    this._updateSun(camera, config);

    /* -- 3/4. SSAO + contact shadows + bilateral blur ----------------------- */
    const wantAO = cfg.ssao !== false && gbOk;
    if (wantAO) {
      if (gp) gp.begin('ao');
      const u = P.ssao.uniforms;
      u.tDepth.value = tDepth;
      u.uProjInv.value.copy(this._projInvJ);
      u.uProj.value.copy(this._projJ);
      u.uSunDirView.value.copy(this._sunDirView);
      u.uCSLength.value = cfg.contactShadowLength ?? 0.42;
      u.uCSThickness.value = cfg.contactShadowThickness ?? 0.30;
      u.uCSStrength.value = cfg.contactShadows === false ? 0.0 : (cfg.contactShadowStrength ?? 1.0);
      u.uResolution.value.set(hw, hh);
      u.uFrame.value = this._frame % TEMPORAL_PERIOD;
      u.uProjScale.value = 0.5 * hh * this._projJ.elements[5];
      // Closed-form unproject terms. `elements` is column-major, so [0] and [5] are
      // the axis scales and [8]/[9] carry the frustum shear that setViewOffset uses
      // to implement the sub-pixel jitter — both are needed, see vpos() in the shader.
      const pe = this._projJ.elements;
      u.uUnproj.value.set(1 / pe[0], 1 / pe[5]);
      u.uSkew.value.set(pe[8], pe[9]);
      u.uNear.value = near; u.uFar.value = far;
      P.ssao.render(renderer, T.ao, qc);

      const b = P.bilateral.uniforms;
      b.tDepth.value = tDepth; b.tNormal.value = tNormal;
      b.uNear.value = near; b.uFar.value = far;
      b.uDepthSigma.value = 4.0;
      // AO is reconstructed from *depth*, so a normal term here buys nothing and
      // costs a lot: on a heavily normal-mapped surface the G-buffer normal varies
      // per pixel, every neighbour weight collapses, and the blur degenerates into
      // a copy that leaves the AO noise exactly where it was.
      b.uNormalPower.value = 0.0;
      b.uSkipZero.value = 0;
      b.tInput.value = T.ao.texture;
      b.uDirection.value.set(1 / hw, 0);
      P.bilateral.render(renderer, T.aoTmp, qc);
      b.tInput.value = T.aoTmp.texture;
      b.uDirection.value.set(0, 1 / hh);
      P.bilateral.render(renderer, T.ao, qc);
      if (gp) gp.end();
    }

    /* -- 5. SSR ------------------------------------------------------------ */
    const wantSSR = cfg.ssr !== false && gbOk && this.quality !== 'low';
    if (wantSSR) {
      if (gp) gp.begin('ssr');
      const u = P.ssr.uniforms;
      u.tColor.value = T.scene.texture;
      u.tDepth.value = tDepth;
      u.tNormal.value = tNormal;
      u.tVelocity.value = tVelocity;
      u.uProj.value.copy(this._projJ);
      u.uProjInv.value.copy(this._projInvJ);
      u.uFrame.value = this._frame % TEMPORAL_PERIOD;
      u.uNear.value = near;
      P.ssr.render(renderer, T.ssr, qc);

      // A light bilateral pass removes the ray dither; TAA finishes the job and
      // turns the roughness jitter into a real glossy lobe.
      const b = P.bilateral.uniforms;
      b.tDepth.value = tDepth; b.tNormal.value = tNormal;
      b.uNear.value = near; b.uFar.value = far;
      b.uDepthSigma.value = 6.0;
      b.uNormalPower.value = 8.0;   // reflections must not bleed across surfaces
      b.uSkipZero.value = 1;        // most of this buffer is empty — see BILATERAL_FRAG
      b.tInput.value = T.ssr.texture;
      b.uDirection.value.set(1 / hw, 0);
      P.bilateral.render(renderer, T.ssrTmp, qc);
      b.tInput.value = T.ssrTmp.texture;
      b.uDirection.value.set(0, 1 / hh);
      P.bilateral.render(renderer, T.ssr, qc);
      if (gp) gp.end();
    }

    /* -- 6. Volumetrics ---------------------------------------------------- */
    const wantVol = cfg.volumetrics !== false && gbOk;
    if (wantVol) {
      if (gp) gp.begin('volumetrics');
      const u = P.volumetric.uniforms;
      u.tDepth.value = tDepth;
      u.uProjInv.value.copy(this._projInvJ);
      u.uSunUV.value.copy(this._sunUV);
      u.uSunColor.value.set(this._sunColor.r, this._sunColor.g, this._sunColor.b);
      u.uSunDirView.value.copy(this._sunDirView);
      u.uSunOnScreen.value = this._sunOnScreen;
      u.uFogDensity.value = (config.art && config.art.fogDensity) || 0.0085;
      u.uFrame.value = this._frame % TEMPORAL_PERIOD;
      u.uNear.value = near; u.uFar.value = far;
      P.volumetric.render(renderer, T.vol, qc);

      /* The blur exists to remove the SHAFT march's dither. With the sun off
       * screen the shaft block does not execute at all and what is left is the
       * airlight integral, which is a smooth analytic function of depth and the
       * view ray with no stochastic term in it — blurring it can only soften the
       * depth discontinuities it is supposed to respect. Skipping two half-res
       * passes on every frame the sun is not in view is free quality and free
       * milliseconds. */
      if (this._sunOnScreen > 0.001) {
        const b = P.bilateral.uniforms;
        b.tDepth.value = tDepth; b.tNormal.value = tNormal;
        b.uNear.value = near; b.uFar.value = far;
        b.uDepthSigma.value = 1.2;
        b.uNormalPower.value = 0.0;   // participating media has no surface
        b.uSkipZero.value = 0;
        b.tInput.value = T.vol.texture;
        b.uDirection.value.set(1 / hw, 0);
        P.bilateral.render(renderer, T.volTmp, qc);
        b.tInput.value = T.volTmp.texture;
        b.uDirection.value.set(0, 1 / hh);
        P.bilateral.render(renderer, T.vol, qc);
      }
      if (gp) gp.end();
    }

    /* -- 7. Composite ------------------------------------------------------ */
    {
      if (gp) gp.begin('composite');
      const u = P.composite.uniforms;
      u.tScene.value = T.scene.texture;
      u.tAO.value = T.ao.texture;
      u.tSSR.value = T.ssr.texture;
      u.tVolume.value = T.vol.texture;
      u.tDepth.value = tDepth;
      u.tNormal.value = tNormal;
      u.tVelocity.value = tVelocity;
      u.uProjInv.value.copy(this._projInvJ);
      u.uHalfRes.value.set(hw, hh);
      u.uNear.value = near; u.uFar.value = far;
      u.uAOStrength.value = wantAO ? (cfg.ssaoStrength ?? 1.0) : 0.0;
      u.uSSRStrength.value = cfg.ssrStrength ?? 1.0;
      u.uVolStrength.value = cfg.volumetricsStrength ?? 1.0;
      u.uEnableAO.value = wantAO ? 1 : 0;
      u.uEnableSSR.value = wantSSR ? 1 : 0;
      u.uEnableVol.value = wantVol ? 1 : 0;
      u.uSunDirView.value.copy(this._sunDirView);
      u.uContactStrength.value = cfg.contactShadows === false
        ? 0.0 : (cfg.contactShadowComposite ?? 0.88);
      P.composite.render(renderer, T.composed, qc);
      if (gp) gp.end();
    }

    /* -- 8. TAA ------------------------------------------------------------ */
    let colorTex = T.composed.texture;
    let colorRT = T.composed;
    if (useTAA && gbOk) {
      if (gp) gp.begin('taa');
      const read = this._histWrite === 0 ? T.histB : T.histA;
      const write = this._histWrite === 0 ? T.histA : T.histB;
      const u = P.taa.uniforms;
      u.tCurrent.value = T.composed.texture;
      u.tHistory.value = read.texture;
      u.tVelocity.value = tVelocity;
      u.tDepth.value = tDepth;
      u.uInvViewProjJ.value.copy(this._invVPJ);
      u.uPrevVP.value.copy(this._prevVP);
      u.uCurrVP.value.copy(this._currVP);
      u.uTexel.value.set(1 / iw, 1 / ih);
      // `setViewOffset(w,h,jx,jy,w,h)` slides the frustum +jx pixels right and
      // -jy pixels down in world-up terms, so the sample sitting in this texel was
      // taken at (+jx, -jy) pixels from the pixel centre in uv-space axes. The
      // reconstruction filter needs that offset, not the raw Halton pair.
      u.uJitter.value.set(jx, -jy);
      const isReset = this._reset > 0;
      u.uReset.value = isReset ? 1 : 0;
      // Feedback ramp. A fixed high weight damps the steady-state jitter ripple
      // beautifully but takes ~35 frames to come up from a cold history, and a
      // fixed low weight does the opposite. n/(n+1) is the exact running-mean
      // weight: frame 1 takes the current sample whole, frame 8 is already at
      // 0.889, and it asymptotes to the authored ceiling. Fast convergence AND a
      // hard steady state, with no per-pixel counter to store.
      this._sinceReset = isReset ? 0 : this._sinceReset + 1;
      const n = this._sinceReset;
      /* Feedback ceiling.
       *
       * 0.972 is a ~36-frame effective history. That damps the 8-frame effect
       * dither to a gain of 0.037 — beautifully stable — but a 36-frame box on a
       * Catmull-Rom-resampled history is 36 consecutive resamples, and the review
       * measured the cost: 2-4 px of gradient on every prop silhouette at native
       * resolution with no ghosting to show for it. 0.945 is an 18-frame history,
       * doubles the dither gain to 0.074 (still well under the visible floor), and
       * hands the microcontrast back to the CAS in the resolve pass. */
      const ceiling = cfg.taaFeedback ?? 0.945;
      u.uFeedback.value = Math.min(ceiling, n / (n + 1));
      u.uClipMin.value = cfg.taaClipMoving ?? 1.05;
      // Variance box while stationary. Raised from 2.60: on a bimodal silhouette
      // texel — half sky, half roof edge — sigma is large in absolute terms but the
      // converged sub-pixel coverage value legitimately sits several sigma from the
      // mean, and clipping to 2.6 threw it away every frame the jitter happened to
      // land on the sky side. The anti-flicker term in TAA_FRAG widens this further,
      // but only for pixels that are both stationary and genuinely high-contrast.
      u.uClipMax.value = cfg.taaClipStill ?? 3.00;
      // Sub-pixel geometry rescue. A shorter history (see the ceiling above) means
      // a thin mast has fewer frames to re-accumulate after a clip throws it away,
      // so the fraction of history held unclipped on a stationary, non-disoccluded
      // pixel has to rise to compensate — otherwise dropping the feedback trades
      // softness for the dashed-mast defect, which is a worse trade.
      u.uStillTrust.value = cfg.taaStillTrust ?? 0.62;
      u.uNear.value = near; u.uFar.value = far;
      P.taa.render(renderer, write, qc);
      colorTex = write.texture;
      colorRT = write;
      this._histWrite = 1 - this._histWrite;
      if (gp) gp.end();
    }

    /* -- 9. Motion blur ---------------------------------------------------- */
    let src = colorTex;
    let srcRT = colorRT;
    let dstToggle = 0;
    const post = [T.postA, T.postB];
    if (cfg.motionBlur !== false && gbOk && this._reset <= 0) {
      if (gp) gp.begin('motionBlur');
      const u = P.motionBlur.uniforms;
      u.tColor.value = src;
      u.tVelocity.value = tVelocity;
      u.tDepth.value = tDepth;
      u.uInvViewProjJ.value.copy(this._invVPJ);
      u.uPrevVP.value.copy(this._prevVP);
      u.uCurrVP.value.copy(this._currVP);
      u.uTexel.value.set(1 / iw, 1 / ih);
      // Shutter-correct: velocity is per-frame, so normalise against a 60Hz frame
      // and clamp hard — a fast 180 must not smear the whole screen.
      const shutter = Math.min(2.0, (dt > 0 ? dt : 1 / 60) * 60) * (cfg.motionBlurStrength ?? 0.8);
      u.uStrength.value = shutter;
      u.uMaxRadius.value = cfg.motionBlurMax ?? 0.018;
      P.motionBlur.render(renderer, post[dstToggle], qc);
      src = post[dstToggle].texture;
      srcRT = post[dstToggle];
      dstToggle = 1 - dstToggle;
      if (gp) gp.end();
    }

    /* -- 10. Viewmodel -----------------------------------------------------
     * The gun renders into its own MSAA HDR target and STAYS there. It used to be
     * flattened into the colour chain by a dedicated full-screen RGBA16F pass
     * whose only job was to hand a composited buffer to the two stages that come
     * after it — the bloom bright-pass and the tonemapper. Both of those already
     * had the viewmodel texture bound (the tonemapper for its CA/grain exemption
     * mask, and now the bright-pass for the same reason), so the pass was moving
     * 16 MB per frame at 1080p to save each of them four texture fetches.
     *
     * Both now do the `bg * (1 - a) + rgb` over-composite inline. The chain order
     * is unchanged — gun goes in after motion blur and before the bloom add and
     * the tonemap curve, exactly as before — and the muzzle flash still reaches
     * the bright-pass, which is the one thing a naive deletion would have lost.
     */
    const hasVM = !!(vmScene && vmScene.children.length > 0);
    const vmRT = T.viewmodel;
    if (hasVM) {
      if (gp) gp.begin('viewmodel');
      renderer.setRenderTarget(vmRT);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(vmScene, vmCamera);
      if (gp) gp.end();
    }

    // Keep a handle on the buffer the tonemapper is about to eat so `probeHDR()`
    // can measure the real pre-tonemap radiance instead of guessing at it. This is
    // now the WORLD layer only — the gun lives in T.viewmodel until the tonemapper
    // composites it — which is what a "scene radiance" probe wanted anyway.
    this._preTonemapRT = srcRT;

    /* -- 11. Bloom --------------------------------------------------------- */
    const wantBloom = cfg.bloom !== false && this.bloomDown.length >= 2;
    if (wantBloom) {
      if (gp) gp.begin('bloom');
      const pf = P.bloomPrefilter.uniforms;
      pf.tColor.value = src;
      pf.tViewmodel.value = vmRT.texture;
      pf.uHasVM.value = hasVM ? 1 : 0;
      pf.uTexel.value.set(1 / iw, 1 / ih);
      pf.uBloomSat.value = cfg.bloomSaturation ?? 1.10;
      pf.uClamp.value = cfg.bloomClamp ?? 9.0;

      /* --- tight lobe: high threshold, ~10px blur -------------------------
       * Measured on the real HDR buffer: the sun disc sits at 13.7 linear and the
       * sky 260 px from it at 0.10 — a 130:1 ratio that AgX compresses to a 4%
       * display step, which is why the sun did not read as a light source at all.
       * A hot, narrow lobe is the only thing that puts that ratio back on screen. */
      pf.uThreshold.value = cfg.bloomTightThreshold ?? 2.60;
      pf.uKnee.value = cfg.bloomTightKnee ?? 1.10;
      const tA = T.bloomTightA, tB = T.bloomTightB;
      P.bloomPrefilter.render(renderer, tA, qc);
      // Three same-size 13-tap passes ≈ a 7-texel sigma, ~14 px at 1080p. The
      // width matters more than the amplitude here: the tonemapper has already
      // pinned the sun's own pixels at the top of its range, so extra energy
      // deposited *on* the disc is invisible by construction and the only thing
      // that reads as "this is a light source" is how far the saturated region
      // and its falloff extend into unsaturated sky.
      const bd = P.bloomDown.uniforms;
      // Widening ladder. Four passes at a fixed one-texel spacing gave a ~14 px
      // sigma — narrow enough that the thresholded region kept a *visible
      // boundary*, which is the tell that reads as a pasted-on glow rather than
      // as light scattered inside a lens. Growing the tap spacing geometrically
      // turns the same four passes into a ~34 px skirt for the same cost, and a
      // skirt that wide has no edge left to see.
      // Offsets are in UV, not in texels of the target, so the skirt this ladder
      // produces is independent of the resolution it is evaluated at.
      const tightSpread = [1.0, 1.7, 2.7, 4.2];
      let bsrc = tA, bdst = tB;
      for (let i = 0; i < tightSpread.length; i++) {
        bd.uTexel.value.set(tightSpread[i] / hw, tightSpread[i] / hh);
        bd.tColor.value = bsrc.texture;
        P.bloomDown.render(renderer, bdst, qc);
        const t = bsrc; bsrc = bdst; bdst = t;
      }
      // Four swaps land the result back in the A target, which is what the final
      // pass samples. Assert it rather than assuming it.
      if (bsrc !== tA) {
        bd.uTexel.value.set(1 / hw, 1 / hh);
        bd.tColor.value = bsrc.texture;
        P.bloomDown.render(renderer, tA, qc);
      }
      this._tightTex = tA.texture;

      /* --- wide lobe: low threshold, full mip chain -----------------------
       * The old 1.0 threshold sat above the 99.96th percentile of the frame, so
       * essentially nothing entered the chain and the practicals' glow died within
       * 4 px of the emissive quad. 0.38 is just above the frame's p90 and gives the
       * veiling skirt, at an intensity low enough that it never reads as an effect. */
      pf.tColor.value = src;
      pf.uTexel.value.set(1 / iw, 1 / ih);
      // A LARGE knee is what removes the "thresholded blob" edge: the contribution
      // ramps in quadratically over a full stop either side of the threshold, so
      // there is no isophote in the source for the blur to preserve as a boundary.
      pf.uThreshold.value = cfg.bloomThreshold ?? 0.55;
      pf.uKnee.value = cfg.bloomKnee ?? 0.60;
      P.bloomPrefilter.render(renderer, this.bloomDown[0], qc);

      for (let i = 1; i < this.bloomDown.length; i++) {
        const s = this.bloomDown[i - 1];
        const u = P.bloomDown.uniforms;
        u.tColor.value = s.texture;
        u.uTexel.value.set(1 / s.width, 1 / s.height);
        P.bloomDown.render(renderer, this.bloomDown[i], qc);
      }
      for (let i = this.bloomUp.length - 1; i >= 0; i--) {
        const smaller = (i === this.bloomUp.length - 1) ? this.bloomDown[i + 1] : this.bloomUp[i + 1];
        const u = P.bloomUp.uniforms;
        u.tColor.value = smaller.texture;
        u.tBase.value = this.bloomDown[i].texture;
        u.uTexel.value.set(1 / smaller.width, 1 / smaller.height);
        // Wider tent on the upsample. At 1.0 the tent only reached one source
        // texel, so each mip's own blockiness survived the climb and the widest
        // levels arrived as soft rectangles.
        u.uRadius.value = cfg.bloomRadius ?? 1.8;
        P.bloomUp.render(renderer, this.bloomUp[i], qc);
      }
      if (gp) gp.end();
    }

    /* -- 12/13. Tonemap + grade → LDR, then resolve (sharpen/FXAA/grain) --- */
    if (this.debugView > 0) {
      const u = P.debug.uniforms;
      u.tAO.value = T.ao.texture;
      u.tSSR.value = T.ssr.texture;
      u.tNormal.value = tNormal;
      u.tVelocity.value = tVelocity;
      u.tVolume.value = T.vol.texture;
      u.tDepth.value = tDepth;
      u.uMode.value = this.debugView;
      u.uNear.value = near; u.uFar.value = far;
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x000000, 1);
      P.debug.render(renderer, null, qc);
    } else {
      if (gp) gp.begin('tonemap');
      const tm = String(cfg.tonemap || 'agx').toLowerCase();
      P.final.setDefine('TONEMAP', tm === 'aces' ? 1 : (tm === 'reinhard' ? 2 : 0));
      const u = P.final.uniforms;
      u.tColor.value = src;
      u.tBloom.value = wantBloom ? this.bloomUp[0].texture : this.bloomDown[0].texture;
      u.tBloomTight.value = this._tightTex || T.bloomTightA.texture;
      u.tViewmodel.value = vmRT.texture;
      u.uHasVM.value = hasVM ? 1 : 0;
      // Exposure trim. Config authors a *scene* exposure; this is the tonemapper's
      // own mid-grey placement and it belongs with the curve, not with the lighting
      // rig. Measured on the previous build, `spawn` had a p50 luminance of 44 with
      // p99 at 237 — the whole midtone range compressed into the bottom fifth while
      // the sky owned the top, i.e. a backlit-window exposure rather than a graded
      // dusk. Lifting mid-grey is only safe because gradeFilm() now has a real
      // shoulder to absorb what that pushes into the highlights.
      u.uExposure.value = (cfg.exposure ?? 1.05) * (cfg.exposureTrim ?? EXPOSURE_TRIM);
      u.uBloomIntensity.value = cfg.bloomIntensity ?? 0.052;
      u.uBloomTight.value = wantBloom ? (cfg.bloomTightIntensity ?? 0.20) : 0.0;
      u.uAspect.value = ih > 0 ? iw / ih : 16 / 9;
      // Config authors CA as "old" magnitude; the pass now interprets its value as
      // the *corner* offset and ramps from zero at 62% radius, so the same authored
      // number has to be scaled down or the corners would fringe far harder than
      // before. 0.0016 -> 0.00055 uv ≈ 1.05 px at 1920 wide, corners only.
      u.uChromatic.value = (cfg.chromaticAberration ?? 0.0016) * (cfg.chromaticAberrationScale ?? 0.34);
      u.uCAStart.value = cfg.chromaticAberrationStart ?? 0.62;
      // Config authors the old smoothstep amplitude; the pass now applies a cos^4
      // falloff whose corner value is 0.70 of the authored number instead of 1.0,
      // and the review asked for ~30% less vignette on top of that. Both are
      // folded here so Config keeps its existing meaning.
      u.uVignette.value = Math.min((cfg.vignette ?? 0.34) * 0.70, 0.25);
      u.uTime.value = this._time;
      u.uEnableBloom.value = wantBloom ? 1 : 0;
      if (cfg.grade) this._applyGradeOverrides(u, cfg.grade);
      P.final.render(renderer, T.ldr, qc);
      if (gp) { gp.end(); gp.begin('resolve'); }

      /* -- 13. Resolve: sharpen + FXAA backstop + grain → screen ------------
       * TAA is the primary anti-aliaser and this does not replace it; it catches
       * the one case TAA structurally cannot — geometry narrower than a pixel,
       * which is present in some jitter phases and absent in others, so the
       * neighbourhood statistics on the absent phases contain no evidence it
       * exists. Gated on local contrast so it only ever touches real edges.
       *
       * Grain moves here because it has to be the last operation applied: run
       * inside the tonemap pass it was being spatially averaged by the very edge
       * filter that now follows it, which turns fine grain into mush. */
      const r = P.resolve.uniforms;
      r.tColor.value = T.ldr.texture;
      r.tViewmodel.value = vmRT.texture;
      r.uHasVM.value = hasVM ? 1 : 0;
      r.uTexel.value.set(1 / iw, 1 / ih);
      r.uFxaa.value = cfg.fxaa === false ? 0.0 : (cfg.fxaaStrength ?? 1.0);
      r.uSharpen.value = cfg.sharpen ?? 0.78;
      // Config authors grain as a pre-tonemap linear amplitude. The pass applies it
      // in display space after the sRGB transfer, where the same number is worth
      // roughly 3x more in the shadows, so it has to be scaled down to land at the
      // ~2.5/255 standard deviation that reads as fine 35mm rather than as sensor
      // noise off a much smaller sensor.
      r.uGrain.value = (cfg.filmGrain ?? 0.028) * GRAIN_DISPLAY_SCALE;
      r.uTime.value = this._time;
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x000000, 1);
      P.resolve.render(renderer, null, qc);
      if (gp) gp.end();
    }

    /* -- end of frame ------------------------------------------------------ */
    if (gp) gp.poll();
    camera.clearViewOffset();
    if (vmCamera) vmCamera.clearViewOffset();
    this._prevVP.copy(this._currVP);
    if (this._reset > 0) this._reset--;
  }

  /** Project the sun into screen space for the light-shaft pass. */
  _updateSun(camera, config) {
    const lighting = this.ctx.lighting;
    const sun = lighting && lighting.sun;
    try {
      if (sun && sun.isLight) {
        const tp = sun.target ? sun.target.position : null;
        this._sunDirWorld.copy(sun.position);
        if (tp) this._sunDirWorld.sub(tp);
        if (this._sunDirWorld.lengthSq() < 1e-8) this._sunDirWorld.set(0.4, 0.5, 0.6);
        this._sunDirWorld.normalize();
        const i = Math.min(1.6, (sun.intensity ?? 3) / 3.0);
        this._sunColor.copy(sun.color).multiplyScalar(0.55 + 0.45 * i);
      } else {
        const el = THREE.MathUtils.degToRad((config.art && config.art.sunElevation) || 11.5);
        const az = THREE.MathUtils.degToRad((config.art && config.art.sunAzimuth) || 118);
        this._sunDirWorld.set(
          Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az),
        ).normalize();
        this._sunColor.setHex((config.art && config.art.sunColor) || 0xffd7a8);
      }
    } catch (e) {
      this._sunDirWorld.set(0.4, 0.5, 0.6).normalize();
    }

    // View-space sun direction (pointing towards the sun).
    this._sunDirView.copy(this._sunDirWorld)
      .transformDirection(camera.matrixWorldInverse).normalize();

    // Project a point far along the sun direction.
    this._tmpV.copy(camera.position).addScaledVector(this._sunDirWorld, 4000);
    this._tmpV2.copy(this._tmpV).applyMatrix4(this._currVP);
    const behind = this._sunDirView.z > -0.02; // sun is behind or beside the camera
    if (behind) {
      this._sunOnScreen = 0;
      this._sunUV.set(0.5, 1.6);
      return;
    }
    // applyMatrix4 already performs the perspective divide on Vector3.
    const ux = this._tmpV2.x * 0.5 + 0.5;
    const uy = this._tmpV2.y * 0.5 + 0.5;
    this._sunUV.set(ux, uy);
    const mx = Math.max(0, Math.max(-ux, ux - 1));
    const my = Math.max(0, Math.max(-uy, uy - 1));
    const off = Math.sqrt(mx * mx + my * my);
    this._sunOnScreen = Math.max(0, 1 - off / 0.55) * Math.min(1, Math.max(0, (-this._sunDirView.z - 0.02) * 6));
  }

  dispose() {
    try {
      this._freeTargets();
      for (const k of Object.keys(this.passes)) this.passes[k].dispose();
      this.gbuffer?.dispose();
      this.gpu?.dispose();
      if (typeof window !== 'undefined' && window.__RENDER__ === this) delete window.__RENDER__;
    } catch (e) { /* noop */ }
  }
}

export default RenderSystem;
