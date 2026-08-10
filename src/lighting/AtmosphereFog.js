/**
 * Aerial perspective.
 *
 * three's stock fog is a distance-only lerp to one flat colour. That is the single
 * biggest reason browser scenes read as cheap: real haze is *directional* (it glows
 * warm toward the sun and goes cold away from it) and *stratified* (it pools in the
 * low ground and thins with altitude). Without those two cues there is no depth
 * cueing, and every distant building looks pasted on.
 *
 * It is also the single biggest way to *ruin* a dusk exterior, which is exactly what
 * the previous revision did: a linear-dominant optical depth put ~7% of a 0.46-linear
 * grey over everything at 10 metres and ~29% at 40 metres, so the near ground — the
 * part of the frame the cast shadows live on — was permanently milked out. The fix has
 * two halves and both matter:
 *
 *   1. the optical depth is now *quadratic-dominant* (FogExp2's real signature), with
 *      the linear term demoted to a low, height-stratified ground layer. The near field
 *      is essentially clear (~2% at 10m), haze becomes legible at 40-60m and the
 *      dissolve completes over hundreds of metres — which is what "heavy haze" actually
 *      looks like from inside it;
 *   2. the inscatter colour is a four-lobe directional evaluation (base / sun / zenith /
 *      downward) rather than one constant, so haze toward the low sun glows warm and
 *      bright while haze away from it stays cool and dark. One flat value in all
 *      directions is precisely what "milky" means.
 *
 * Mechanically we replace the four fog ShaderChunks globally, once, at init — before any
 * program is compiled. The replacement:
 *
 *   - reconstructs the world-space position of the fragment from `mvPosition` alone,
 *     using `transpose(mat3(viewMatrix))` (the view rotation is orthonormal, so its
 *     transpose is its inverse — free) plus `cameraPosition`. Deliberately *not* using
 *     `transformed` or `worldPosition`, because sprite and points shaders do not define
 *     them and the FX system will absolutely be using both;
 *   - integrates an exponential height-density profile analytically along the view ray,
 *     so haze pools correctly whether you're standing in it or looking down into it;
 *   - tints the result: three's own `fogColor` uniform stays the base (so three's colour
 *     management still applies and `scene.fog.color` is still live-tunable), and we bake
 *     *relative* multipliers for each lobe.
 *
 * The sun direction and the tint multipliers are baked as GLSL constants rather than
 * uniforms, because there is no way to inject a uniform into every fogged material in
 * the engine — including ones other agents create at runtime — without owning their
 * onBeforeCompile. Baking means it Just Works for every material forever. Retuning
 * (setTimeOfDay) re-bakes and forces a recompile, which is fine for something the critic
 * loop calls a handful of times.
 *
 * If anything about the patch fails, the original chunks are restored and the game falls
 * back to stock three fog. It degrades, it never throws.
 *
 * OWNER: lighting.
 */
import * as THREE from 'three';

const CHUNK_KEYS = ['fog_vertex', 'fog_pars_vertex', 'fog_fragment', 'fog_pars_fragment'];

function f(x) {
  const v = Number.isFinite(x) ? x : 0;
  const s = v.toFixed(6);
  return s.indexOf('.') === -1 ? `${s}.0` : s;
}
const v3 = (x, y, z) => `vec3( ${f(x)}, ${f(y)}, ${f(z)} )`;

export class AtmosphereFog {
  constructor() {
    this.installed = false;
    this.version = 0;
    this._original = null;
    this.params = {
      sunDir: new THREE.Vector3(0, 0.2, 1).normalize(),

      // Per-lobe multipliers on `fogColor`. LightingSystem recomputes these from the
      // sky model; these defaults are the dusk look in case it never gets that far.
      sunTint: new THREE.Vector3(4.6, 3.1, 1.9),      // toward the sun: warm, glowing
      zenithTint: new THREE.Vector3(1.10, 1.24, 1.48),// looking up: cool, slightly lifted
      downTint: new THREE.Vector3(0.52, 0.48, 0.44),  // looking down into it: dark, warm-grey

      sunExponent: 2.6,        // broad forward-scatter lobe
      sunSharpExponent: 16.0,  // tight solar aureole
      sunBroadWeight: 0.62,
      sunSharpWeight: 0.55,

      upScale: 1.7,            // how quickly the zenith lobe takes over going up
      downScale: 2.4,          // ...and the ground lobe going down

      // Optical depth split. Both are multiplied by scene.fog.density so the Config
      // knob still steers the whole thing.
      aerialScale: 0.70,       // quadratic term — the long-range dissolve
      groundScale: 0.26,       // linear term — the low-lying haze layer
      heightFalloff: 0.11,     // 1/H for the ground layer, metres (H ~ 9m)
      aerialHeightFalloff: 0.028, // 1/H for the aerial term (H ~ 36m) — upper floors stay clear
      /**
       * Floor on the camera-height attenuation. Without it an elevated vantage sits
       * above the layer and sees *no* aerial perspective at all, so the distance reads
       * flatter than the foreground — the exact inversion the review measured from the
       * overwatch pose. Haze is direction-independent; only its colour is not.
       */
      camHeightFloor: 0.55,
      baseHeight: 0.0,         // altitude at which the ground layer is at full density
      densityScale: 1.0,

      maxOpacity: 0.985,
    };
  }

  setParams(p) { Object.assign(this.params, p); }

  install() {
    try {
      if (!this._original) {
        this._original = {};
        for (const k of CHUNK_KEYS) this._original[k] = THREE.ShaderChunk[k];
      }
      this._bake();
      this.installed = true;
    } catch (err) {
      console.error('[lighting] atmospheric fog patch failed, using stock fog:', err);
      this.uninstall();
    }
    return this.installed;
  }

  /** Re-bake constants and force fogged materials in `scene` to recompile. */
  refresh(scene) {
    if (!this.installed) return;
    try {
      this._bake();
      this.version++;
      const ver = this.version;
      const touched = new Set();
      scene?.traverse((obj) => {
        const m = obj.material;
        if (!m) return;
        const list = Array.isArray(m) ? m : [m];
        for (const mat of list) {
          if (!mat || mat.fog === false || touched.has(mat)) continue;
          touched.add(mat);
          if (!mat.__atmoBaseCacheKey) mat.__atmoBaseCacheKey = mat.customProgramCacheKey.bind(mat);
          const base = mat.__atmoBaseCacheKey;
          mat.customProgramCacheKey = () => `${base()}|atmo${ver}`;
          mat.needsUpdate = true;
        }
      });
    } catch (err) {
      console.error('[lighting] atmospheric fog refresh failed:', err);
    }
  }

  uninstall() {
    if (!this._original) return;
    for (const k of CHUNK_KEYS) THREE.ShaderChunk[k] = this._original[k];
    this._original = null;
    this.installed = false;
  }

  /**
   * Optical depth at a given horizontal distance, for a camera at `camY`. Mirrors the
   * shader exactly so the lighting system can assert the near field is actually clear
   * without a GPU readback.
   */
  opticalDepthAt(dist, camY = 1.75, density = 0.0085) {
    const p = this.params;
    const d = density * p.densityScale;
    const camA = Math.min(Math.max(Math.exp(-(camY - p.baseHeight) * p.aerialHeightFalloff), p.camHeightFloor), 4);
    const a = d * p.aerialScale * dist * camA;
    const camH = Math.min(Math.max(Math.exp(-(camY - p.baseHeight) * p.heightFalloff), p.camHeightFloor * 0.5), 4);
    return a * a + d * p.groundScale * dist * camH;
  }

  /** Convenience: the 0..1 fog blend factor a horizontal ray of `dist` metres reaches. */
  factorAt(dist, camY = 1.75, density = 0.0085) {
    return Math.min(1 - Math.exp(-this.opticalDepthAt(dist, camY, density)), this.params.maxOpacity);
  }

  _bake() {
    const p = this.params;
    const d = p.sunDir;

    THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
#endif`;

    // mvPosition is in scope in every stock shader that includes <fog_vertex>
    // (mesh, points and sprite alike). viewMatrix's upper 3x3 is orthonormal, so its
    // transpose is its inverse and world reconstruction costs one mat3 multiply.
    THREE.ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldPos = cameraPosition + transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
#endif`;

    THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif

  const vec3  ATMO_SUN_DIR     = ${v3(d.x, d.y, d.z)};
  const vec3  ATMO_SUN_TINT    = ${v3(p.sunTint.x, p.sunTint.y, p.sunTint.z)};
  const vec3  ATMO_ZENITH_TINT = ${v3(p.zenithTint.x, p.zenithTint.y, p.zenithTint.z)};
  const vec3  ATMO_DOWN_TINT   = ${v3(p.downTint.x, p.downTint.y, p.downTint.z)};
  const float ATMO_SUN_EXP     = ${f(p.sunExponent)};
  const float ATMO_SUN_EXP_T   = ${f(p.sunSharpExponent)};
  const float ATMO_SUN_BROAD   = ${f(p.sunBroadWeight)};
  const float ATMO_SUN_SHARP   = ${f(p.sunSharpWeight)};
  const float ATMO_UP_SCALE    = ${f(p.upScale)};
  const float ATMO_DOWN_SCALE  = ${f(p.downScale)};
  const float ATMO_AERIAL      = ${f(p.aerialScale)};
  const float ATMO_GROUND      = ${f(p.groundScale)};
  const float ATMO_H_FALLOFF   = ${f(p.heightFalloff)};
  const float ATMO_AH_FALLOFF  = ${f(p.aerialHeightFalloff)};
  const float ATMO_CAM_FLOOR   = ${f(p.camHeightFloor)};
  const float ATMO_BASE_Y      = ${f(p.baseHeight)};
  const float ATMO_DENS_SCALE  = ${f(p.densityScale)};
  const float ATMO_MAX_OPACITY = ${f(p.maxOpacity)};
#endif`;

    THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
  {
    vec3 fogRay = vFogWorldPos - cameraPosition;
    float fogDist = max( length( fogRay ), 1e-4 );
    vec3 fogDir = fogRay / fogDist;

    // ── directional inscatter ────────────────────────────────────────────
    // Vertical gradient first (ground lobe below, sky lobe above), then the solar
    // lobe on top of it — so looking up *toward* the sun still glows rather than
    // being flattened back to the cool zenith colour.
    float atmoUp = clamp( fogDir.y * ATMO_UP_SCALE, 0.0, 1.0 );
    float atmoDn = clamp( -fogDir.y * ATMO_DOWN_SCALE, 0.0, 1.0 );
    vec3 atmoCol = fogColor;
    atmoCol = mix( atmoCol, fogColor * ATMO_DOWN_TINT, atmoDn );
    atmoCol = mix( atmoCol, fogColor * ATMO_ZENITH_TINT, atmoUp );

    float atmoSunDot = max( dot( fogDir, ATMO_SUN_DIR ), 0.0 );
    float atmoSunAmt = clamp(
      pow( atmoSunDot, ATMO_SUN_EXP ) * ATMO_SUN_BROAD +
      pow( atmoSunDot, ATMO_SUN_EXP_T ) * ATMO_SUN_SHARP,
      0.0, 1.0 );
    atmoCol = mix( atmoCol, fogColor * ATMO_SUN_TINT, atmoSunAmt );

    #ifdef FOG_EXP2
      float atmoD = fogDensity * ATMO_DENS_SCALE;

      // (1) Aerial perspective. Quadratic in distance — this is FogExp2's actual
      //     signature and the reason it can be simultaneously invisible at 10m and
      //     total at 400m. A linear term here is what milks out a near field.
      //     Stratified too, but on a much taller scale height (H ~ 36m) so the top of
      //     a six-storey facade keeps its contrast while its base dissolves.
      float atmoCamA = clamp( exp( -( cameraPosition.y - ATMO_BASE_Y ) * ATMO_AH_FALLOFF ), ATMO_CAM_FLOOR, 4.0 );
      float atmoAY = fogDir.y * fogDist * ATMO_AH_FALLOFF;
      float atmoIntegA = ( abs( atmoAY ) > 1e-3 ) ? ( 1.0 - exp( -atmoAY ) ) / atmoAY : 1.0;
      float atmoA = atmoD * ATMO_AERIAL * fogDist * atmoCamA * clamp( atmoIntegA, 0.35, 2.5 );
      float atmoOptical = atmoA * atmoA;

      // (2) Ground haze. Linear, but stratified: density(h) = D * exp( -(h-y0)/H ),
      //     integrated analytically along the ray. Deliberately weak, so it reads as
      //     a layer you see *across* rather than a wash you sit inside.
      float atmoCamH = clamp( exp( -( cameraPosition.y - ATMO_BASE_Y ) * ATMO_H_FALLOFF ), ATMO_CAM_FLOOR * 0.5, 4.0 );
      float atmoDY = fogDir.y * fogDist * ATMO_H_FALLOFF;
      float atmoInteg = ( abs( atmoDY ) > 1e-3 ) ? ( 1.0 - exp( -atmoDY ) ) / atmoDY : 1.0;
      atmoOptical += atmoD * ATMO_GROUND * fogDist * atmoCamH * max( atmoInteg, 0.0 );

      float atmoFactor = clamp( 1.0 - exp( -atmoOptical ), 0.0, ATMO_MAX_OPACITY );
    #else
      float atmoFactor = smoothstep( fogNear, fogFar, vFogDepth ) * ATMO_MAX_OPACITY;
    #endif

    gl_FragColor.rgb = mix( gl_FragColor.rgb, atmoCol, atmoFactor );
  }
#endif`;
  }
}
