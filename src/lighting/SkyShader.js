/**
 * OPERATION BLACKOUT — physical sky.
 *
 * A Preetham analytic daylight model (the same core as three/examples/jsm/objects/Sky.js)
 * extended substantially for our art direction:
 *
 *   - a horizon haze band with a directional (warm toward the sun / cool away) tint,
 *     which is what actually sells aerial perspective;
 *   - a global desaturation + filmic lift so it reads as overcast dusk rather than the
 *     stock model's clean tropical blue;
 *   - a procedural stratus cloud deck with sun-side silver lining and cool undersides,
 *     projected onto a virtual plane so it has real perspective compression at the horizon;
 *   - a proper lower hemisphere (Preetham is undefined below the horizon and the stock
 *     shader just smears the horizon colour downward, which poisons the IBL with far too
 *     much upwelling light). We blend to a dark, slightly warm ground radiance instead —
 *     this is what makes PMREM-derived ambient look like a real overcast street.
 *   - an explicit sun disc with a tight Mie forward-scattering halo and a broader glow,
 *     scaled so the post-stack bloom has something real to grab.
 *
 * The CPU-side mirror of this model lives in SkyModel.js and MUST be kept in sync — it
 * is what the fog colour and the hemisphere fill are derived from.
 *
 * OWNER: lighting.
 */
import * as THREE from 'three';

/**
 * The dusk plate.
 *
 * Two of these numbers do almost all of the art-directional work and both were wrong in
 * the first pass:
 *
 *   `saturation` — Preetham's zenith at a low sun is a deeply saturated Rayleigh blue
 *   (r/b ≈ 0.25). Rendered, that reads as a *clear midday* sky no matter how dim you
 *   make it, because hue says "noon" louder than luminance says "dusk". An overcast
 *   dusk zenith is a cool neutral grey with only a hint of blue in it, so the global
 *   desaturation has to be aggressive.
 *
 *   `cloudCoverage` — "overcast" is not 62% cover. A broken deck lets the blue through
 *   between the cells, which again reads as a nice afternoon. Closing the deck up is
 *   what puts the ceiling on the scene.
 *
 * Luminance is left roughly where it was on purpose: the sky *should* be much brighter
 * than the ground at dusk (that contrast is the whole look — dark silhouettes against a
 * luminous ceiling). The over-bright frame was never the sky's fault, it was the fog.
 */
export const SKY_DEFAULTS = {
  turbidity: 7.4,             // more particulate: warmer, softer, hazier sun side
  rayleigh: 1.55,             // less clean-air blue
  mieCoefficient: 0.0092,
  mieDirectionalG: 0.815,
  skyIntensity: 1.46,
  // Preetham explodes near a low sun — 28 nits of luminance at the solar horizon.
  // Compress on luminance only (never per channel) so the glow keeps its hue.
  highlightComp: 0.62,
  saturation: 0.38,           // see above — this is the "not midday" knob
  hazeFalloff: 2.55,          // taller murk band = heavier air
  hazeStrength: 0.96,
  hazeLift: 0.058,
  hazeCool: [0.395, 0.450, 0.545],
  hazeWarm: [1.000, 0.660, 0.372],
  groundColor: [0.040, 0.037, 0.033],
  cloudCoverage: 0.82,        // closed stratus deck
  cloudDensity: 0.94,
  cloudSharpness: 0.30,       // stratus has soft edges; cumulus has hard ones
  cloudScale: 2.85,
  cloudSpeed: 0.010,
  cloudShadow: [0.245, 0.268, 0.320],
  cloudLit: [1.000, 0.690, 0.420],
  cloudRim: [1.000, 0.720, 0.420],
  sunDiscIntensity: 34.0,
  sunDiscColor: [1.000, 0.610, 0.285],   // low sun, thick air — deep amber
  /**
   * How much of the disc the stratus deck is allowed to eat. At 82% coverage the deck
   * closes over the sun's own altitude, so the previous 0.88 removed the light source
   * from a frame that is full of hard low-sun shadows — the single most disorienting
   * thing a dusk exterior can do. A real sun behind thin stratus is a bright, soft,
   * unmistakable hotspot; it does not disappear.
   */
  cloudOcclusion: 0.42,
  /** Broad "sun through the murk" hotspot — this is what actually reads at 8-11 deg. */
  sunGlowIntensity: 1.15,
  sunGlowExponent: 34.0,
  sunHaloIntensity: 0.30,
  sunHaloExponent: 6.5,
  /**
   * ── VEILING GLARE ─────────────────────────────────────────────────────────
   *
   * The disc was a small crisp-edged blob sitting on the sky gradient — "a hard flat
   * white circle with no veiling glare", in a composition built entirely around a low
   * sun at the end of a lane. Real low-sun glare is a *very* wide, very low-intensity
   * wash: several degrees of it eat the silhouettes in front of the sun and lift the
   * whole solar quadrant before the tight Mie aureole ever starts.
   *
   * The three existing lobes are all too tight for that (exponent 420 / 34 / 6.5 —
   * half-power at 2.3, 8 and 19 degrees). This is a fourth, at exponent 1.6, which is
   * half-power at 50 degrees and still contributing at 90. Kept deliberately dim: it
   * is a veil, and the moment it reads as a shape it has failed. Like the other solar
   * lobes it is multiplied by `uShowSunDisc`, so the IBL probe never sees it and the
   * key light is not double-counted.
   */
  sunVeilIntensity: 0.115,
  sunVeilExponent: 1.6,

  /**
   * ── AZIMUTHAL WARM/COOL AXIS ──────────────────────────────────────────────
   *
   * Preetham at a low sun plus our aggressive global desaturation produces a dome
   * that is the *same* warm cream in every direction: measured 150 degrees off the
   * sun the sky came back rgb 127/117/107 (B/R 0.85) at almost exactly the luminance
   * of the sunlit ground below it. A frame with no warm/cool axis reads as an
   * overcast diorama no matter how good the shadows are, and the anti-sun poses are
   * where that shows.
   *
   * So the axis is imposed explicitly, *after* the desaturation (before it, the
   * `saturation` knob would immediately crush it back out). It is a multiplicative
   * tint, so it costs nothing and cannot change the dome's structure — only where on
   * the warm/cool line each direction sits.
   *
   *   skyWarm  — within ~60 degrees of the sun. Barely warmer than neutral; the sun
   *              side already gets its colour from the Mie lobe and the haze band,
   *              and the spawn/lane framings are calibrated against it.
   *   skyCool  — the anti-solar hemisphere. B/R 1.75 as a *tint*, which lands the
   *              rendered anti-sun sky near B/R 1.3 once the dome's own warm bias
   *              is folded in.
   *   skyRampExp — how fast the ramp turns over. 2.2 keeps the whole solar quadrant
   *              warm and puts the transition out past 60 degrees.
   *
   * `zenithScale` is the other half of the same problem: a real dusk sky is
   * *brighter at the horizon than overhead*. A flat vertical value makes a skyline
   * impossible to read.
   */
  /**
   * ── REVISED: THE ANTI-SOLAR HALF WAS NOT DARK, ONLY BLUE ──────────────────
   *
   * `skyCool` at [0.62, 0.86, 1.36] has a *luminance* of 0.85 — it changes the hue of
   * the anti-solar hemisphere and leaves its value almost untouched. The review caught
   * the consequence in the one pose that faces away from the sun: the closeup "does
   * not read as dusk… clean saturated mid-blue with white cumulus, ground at
   * 129/114/91, reads as mid-afternoon in a desert". Four of five poses hold the dusk
   * read and that one breaks it, which is exactly the signature of a dome with a hue
   * axis but no value axis.
   *
   * A low sun means the sky opposite it is genuinely dark — two to three stops under
   * the solar side, not the same brightness in a cooler hue. `skyCool` therefore drops
   * to luminance ~0.44 while keeping (in fact deepening) its blue bias, and the ramp
   * exponent comes down so the darkening starts inside the solar quadrant instead of
   * waiting until 60 degrees off axis.
   */
  skyWarm: [1.10, 1.00, 0.86],
  skyCool: [0.30, 0.45, 0.78],
  skyRampExp: 1.55,
  zenithScale: 0.80,

  // ── IBL probe overrides (only active while PMREM captures the dome) ────────
  /**
   * The probe is not a photograph of the sky, it is the scene's *fill*. Two things
   * have to change for it to behave like one:
   *
   *   `probeTint`  — the fill has to be cooler than the key or there is no warm/cool
   *   axis at all. Preetham's low sun drags the whole dome amber, and the PMREM
   *   average inherits that, so shadows came out neutral-to-warm and the frame had a
   *   ~0.3 R/B span end to end where the reference has ~1.2.
   *
   *   ⚠ GREEN MUST SIT ON THE R-B LINE. The previous value, [0.58, 0.93, 1.72],
   *   put green 19% *below* the midpoint of red and blue. That is not a blue tint,
   *   it is a **magenta** one, and it is exactly what three independent reviews
   *   measured coming back out of the renderer: shadowed concrete at rgb
   *   64.8/58.2/65.6 — green the lowest channel, hue 288 degrees, every ground
   *   shadow in the game reading violet-lavender. A sky tint is Rayleigh-shaped:
   *   red low, blue high, and green *between* them (if anything slightly above the
   *   line, since 550 nm scatters more than the geometric mean suggests). Any tint
   *   whose green dips under (R+B)/2 will paint mauve shadows no matter what the
   *   rest of the system does. Keep `G >= (R + B) / 2`.
   *
   *   `probeGround` — the lower hemisphere of the *visible* dome is correctly a dark
   *   ground radiance, but the lower hemisphere of the *probe* stands in for bounce
   *   off a sunlit sand yard, which is roughly three times brighter and much warmer.
   *   Without it every vertical shadow-side face is lit only from above and goes flat.
   *   Raised here because the sky term was cut hard to buy back the key/fill ratio,
   *   and the bounce is the half of the fill that is *allowed* to stay strong — it
   *   lands on soffits and the lower halves of shaded verticals, not on the open
   *   ground where cast shadows have to read.
   */
  probeTint: [0.46, 1.10, 1.40],
  probeGround: [0.178, 0.118, 0.061],
  probeClamp: 0.85,
};

const vertexShader = /* glsl */`
  uniform vec3 uSunDirection;
  uniform float uRayleigh;
  uniform float uTurbidity;
  uniform float uMieCoefficient;

  varying vec3 vWorldPosition;
  varying vec3 vBetaR;
  varying vec3 vBetaM;
  varying float vSunE;

  const vec3 UP = vec3( 0.0, 1.0, 0.0 );
  const float PI = 3.141592653589793;

  // Precomputed Rayleigh scattering for 680/550/450nm primaries (Preetham).
  const vec3 totalRayleigh = vec3( 5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5 );
  // MieConst = pi * pow( ( 2 * pi ) / lambda, v - 2 ) * K
  const vec3 MieConst = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );

  const float cutoffAngle = 1.6110731556870734;   // pi / 1.95
  const float steepness = 1.5;
  const float EE = 1000.0;

  float sunIntensity( float zenithAngleCos ) {
    zenithAngleCos = clamp( zenithAngleCos, -1.0, 1.0 );
    return EE * max( 0.0, 1.0 - exp( -( ( cutoffAngle - acos( zenithAngleCos ) ) / steepness ) ) );
  }

  vec3 totalMie( float T ) {
    float c = ( 0.2 * T ) * 10E-18;
    return 0.434 * c * MieConst;
  }

  void main() {
    vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
    vWorldPosition = worldPosition.xyz;

    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    gl_Position.z = gl_Position.w;  // pin to the far plane, always behind everything

    vSunE = sunIntensity( dot( uSunDirection, UP ) );
    vBetaR = totalRayleigh * uRayleigh;
    vBetaM = totalMie( uTurbidity ) * uMieCoefficient;
  }
`;

const fragmentShader = /* glsl */`
  varying vec3 vWorldPosition;
  varying vec3 vBetaR;
  varying vec3 vBetaM;
  varying float vSunE;

  uniform vec3  uSunDirection;
  uniform float uMieDirectionalG;
  uniform float uSkyIntensity;
  uniform float uHighlightComp;
  uniform float uSaturation;

  uniform float uHazeFalloff;
  uniform float uHazeStrength;
  uniform float uHazeLift;
  uniform vec3  uHazeCool;
  uniform vec3  uHazeWarm;

  uniform vec3  uGroundColor;

  uniform float uCloudCoverage;
  uniform float uCloudDensity;
  uniform float uCloudSharpness;
  uniform float uCloudScale;
  uniform float uCloudSpeed;
  uniform vec3  uCloudShadow;
  uniform vec3  uCloudLit;
  uniform vec3  uCloudRim;

  uniform float uSunDiscIntensity;
  uniform vec3  uSunDiscColor;
  uniform float uShowSunDisc;
  uniform float uCloudOcclusion;
  uniform float uSunGlowIntensity;
  uniform float uSunGlowExponent;
  uniform float uSunHaloIntensity;
  uniform float uSunHaloExponent;
  uniform float uSunVeilIntensity;
  uniform float uSunVeilExponent;
  uniform vec3  uSkyWarm;
  uniform vec3  uSkyCool;
  uniform float uSkyRampExp;
  uniform float uZenithScale;
  uniform float uTime;

  uniform float uProbe;        // 1 only while the PMREM probe is being captured
  uniform vec3  uProbeTint;
  uniform vec3  uProbeGround;
  uniform float uProbeClamp;

  const vec3 UP = vec3( 0.0, 1.0, 0.0 );
  const float PI = 3.141592653589793;

  const float rayleighZenithLength = 8.4E3;
  const float mieZenithLength = 1.25E3;
  const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
  const float ONE_OVER_FOURPI = 0.07957747154594767;

  const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );

  float rayleighPhase( float cosTheta ) {
    return THREE_OVER_SIXTEENPI * ( 1.0 + cosTheta * cosTheta );
  }

  float hgPhase( float cosTheta, float g ) {
    float g2 = g * g;
    float inv = 1.0 / pow( max( 1.0 - 2.0 * g * cosTheta + g2, 1e-4 ), 1.5 );
    return ONE_OVER_FOURPI * ( ( 1.0 - g2 ) * inv );
  }

  // ── cheap value-noise fbm for the cloud deck ──────────────────────────────
  float hash21( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }

  float vnoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    float a = hash21( i );
    float b = hash21( i + vec2( 1.0, 0.0 ) );
    float c = hash21( i + vec2( 0.0, 1.0 ) );
    float d = hash21( i + vec2( 1.0, 1.0 ) );
    return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
  }

  float fbm( vec2 p ) {
    float v = 0.0;
    float a = 0.5;
    mat2 m = mat2( 1.62, 1.18, -1.18, 1.62 );
    for ( int i = 0; i < 5; i ++ ) {
      v += a * vnoise( p );
      p = m * p;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 direction = normalize( vWorldPosition - cameraPosition );
    float cosTheta = dot( direction, uSunDirection );

    // ── Preetham in-scattering ────────────────────────────────────────────
    float zenithAngle = acos( max( 0.0, dot( UP, direction ) ) );
    float inv = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( max( 93.885 - ( ( zenithAngle * 180.0 ) / PI ), 1e-3 ), -1.253 ) );
    float sR = rayleighZenithLength * inv;
    float sM = mieZenithLength * inv;

    vec3 Fex = exp( -( vBetaR * sR + vBetaM * sM ) );

    vec3 betaRTheta = vBetaR * rayleighPhase( cosTheta * 0.5 + 0.5 );
    vec3 betaMTheta = vBetaM * hgPhase( cosTheta, uMieDirectionalG );
    vec3 betaSum = max( vBetaR + vBetaM, vec3( 1e-12 ) );

    vec3 Lin = pow( vSunE * ( ( betaRTheta + betaMTheta ) / betaSum ) * ( 1.0 - Fex ), vec3( 1.5 ) );
    Lin *= mix(
      vec3( 1.0 ),
      pow( vSunE * ( ( betaRTheta + betaMTheta ) / betaSum ) * Fex, vec3( 0.5 ) ),
      clamp( pow( 1.0 - dot( UP, uSunDirection ), 5.0 ), 0.0, 1.0 )
    );

    vec3 L0 = vec3( 0.1 ) * Fex;
    vec3 col = ( Lin + L0 ) * 0.04 + vec3( 0.0, 0.0003, 0.00075 );
    col *= uSkyIntensity;

    // Luminance-only highlight rolloff. Per-channel compression would bleach the
    // solar glow to white; this keeps the hue and only tames the magnitude.
    {
      float l = max( dot( col, LUMA ), 1e-6 );
      col *= ( l / ( 1.0 + l * uHighlightComp ) ) / l;
    }
    float skyLum = dot( col, LUMA );

    // ── procedural stratus deck ───────────────────────────────────────────
    float cloudMask = 0.0;
    vec3 cloudCol = vec3( 0.0 );
    if ( direction.y > 0.0 && uCloudDensity > 0.0 ) {
      float dy = max( direction.y, 0.028 );
      vec2 cuv = ( direction.xz / dy ) * uCloudScale;
      cuv += vec2( uTime * uCloudSpeed, uTime * uCloudSpeed * 0.62 );

      // domain warp so the deck breaks up into believable cells rather than blobs
      float w = fbm( cuv * 0.55 + 7.31 );
      float n = fbm( cuv + vec2( w * 0.9, -w * 0.6 ) );
      float detail = fbm( cuv * 3.1 - 4.7 );
      float d = n * 0.78 + detail * 0.22;

      float edge0 = 1.0 - uCloudCoverage;
      cloudMask = smoothstep( edge0, edge0 + uCloudSharpness, d );
      cloudMask *= smoothstep( 0.0, 0.135, direction.y );   // compress into the horizon
      cloudMask *= uCloudDensity;

      // lighting: cool from above, warm scatter through the deck toward the sun
      float sunAmt = pow( max( cosTheta, 0.0 ), 4.0 );
      float grazing = pow( 1.0 - clamp( direction.y, 0.0, 1.0 ), 2.0 );
      cloudCol = mix( uCloudShadow, uCloudLit, clamp( sunAmt * 0.9 + grazing * 0.18, 0.0, 1.0 ) );

      // silver lining: the rim of a cloud transmits far more than its core
      float rim = clamp( ( d - edge0 ) / max( uCloudSharpness, 1e-3 ), 0.0, 1.0 );
      rim = rim * ( 1.0 - rim ) * 4.0;
      cloudCol += uCloudRim * rim * pow( max( cosTheta, 0.0 ), 3.0 ) * 0.9;

      // Track the sky's own brightness so the deck sits *in* the scene rather than
      // being an unrelated grey card pasted over it.
      // Saturating, not linear. A linear tie to sky luminance sends the deck to
      // (3.5, 2.4, 1.5) where the sun is behind it, which clips to flat white and
      // throws away every bit of amber in the brightest part of the frame.
      cloudCol *= ( 0.32 + 1.15 * skyLum / ( 1.0 + 0.55 * skyLum ) );
      col = mix( col, cloudCol, cloudMask );
    }

    // ── sun disc + Mie halo ───────────────────────────────────────────────
    // The deck dims the sun, it does not delete it. Occlusion used to reach 0.12 under
    // a closed stratus deck, which at 82% coverage means the light source is missing
    // from a frame that is full of hard low-sun shadows.
    float occl = 1.0 - cloudMask * uCloudOcclusion;
    float sd = max( cosTheta, 0.0 );
    float disc = smoothstep( 0.99955, 0.99988, cosTheta );
    col += uSunDiscColor * uSunDiscIntensity * disc * uShowSunDisc * occl;
    // Bright core bleeding through the murk, then the broad Mie halo around it. Both
    // are suppressed in the probe: the key light already carries this energy, and
    // leaving it in the IBL double-counts the sun and bakes a hot spot into reflections.
    col += uSunDiscColor * 0.34 * pow( sd, 420.0 ) * occl * uShowSunDisc;
    col += uSunDiscColor * uSunGlowIntensity * pow( sd, uSunGlowExponent ) * occl * uShowSunDisc;
    col += uSunDiscColor * uSunHaloIntensity * pow( sd, uSunHaloExponent ) * occl * uShowSunDisc;
    // Veiling glare — a wash several tens of degrees wide. Not occluded by the deck:
    // veiling glare is scattering in the air between the sun and the eye, so a cloud
    // in front of the sun sits *inside* it rather than switching it off.
    col += uSunDiscColor * uSunVeilIntensity * pow( sd, uSunVeilExponent ) * uShowSunDisc;

    // ── horizon haze band (aerial perspective in the sky itself) ──────────
    float band = exp( -max( direction.y, 0.0 ) * uHazeFalloff );
    vec3 hazeTint = mix( uHazeCool, uHazeWarm, pow( max( cosTheta, 0.0 ), 2.2 ) );
    float lum = dot( col, LUMA );
    vec3 hazed = hazeTint * ( lum * 0.72 + uHazeLift * uSkyIntensity );
    col = mix( col, hazed, clamp( band * uHazeStrength, 0.0, 1.0 ) );

    // ── grade: desaturate, keep it gritty ─────────────────────────────────
    lum = dot( col, LUMA );
    col = mix( vec3( lum ), col, uSaturation );

    // ── azimuthal warm/cool axis + zenith value ramp ──────────────────────
    // Applied AFTER the desaturation on purpose: this is the one hue decision in
    // the dome that must survive the uSaturation knob, because without it the sky
    // is the same cream in every direction and the frame has no warm/cool axis at
    // all. See SKY_DEFAULTS.skyWarm.
    {
      float az = pow( clamp( cosTheta * 0.5 + 0.5, 0.0, 1.0 ), uSkyRampExp );
      col *= mix( uSkyCool, uSkyWarm, az );
      // A dusk sky is brighter at the horizon than overhead. A flat vertical value
      // is what makes a roofline impossible to separate from the sky behind it.
      col *= mix( 1.0, uZenithScale, smoothstep( 0.0, 0.62, direction.y ) );
    }

    // ── probe-only conditioning ───────────────────────────────────────────
    if ( uProbe > 0.5 ) {
      // Soft luminance roll-off, so the solar quadrant of the dome cannot dominate
      // the diffuse convolution, and a cool chroma push so the fill is a *fill*.
      float pl = max( dot( col, LUMA ), 1e-6 );
      col *= ( pl / ( 1.0 + pl / uProbeClamp ) ) / pl;
      col *= uProbeTint;
    }

    // ── lower hemisphere: real ground radiance, not smeared horizon ───────
    // In the probe this lobe is the yard's bounce, not the dome's underside.
    float below = smoothstep( 0.0, -0.18, direction.y );
    vec3 groundLum = mix( uGroundColor * ( 0.55 + 1.9 * dot( col, LUMA ) ), uProbeGround, uProbe );
    col = mix( col, groundLum, below );

    gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );

    // ShaderMaterial gets no automatic output encoding — without these the dome would
    // be the only thing in the frame not converted to the active output colour space.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Build the sky ShaderMaterial. Uniform values are seeded from SKY_DEFAULTS and
 * overridden by anything in `params`.
 */
export function createSkyMaterial(params = {}) {
  const p = { ...SKY_DEFAULTS, ...params };
  const c = (a) => new THREE.Vector3(a[0], a[1], a[2]);

  return new THREE.ShaderMaterial({
    name: 'BlackoutSky',
    uniforms: {
      uSunDirection: { value: new THREE.Vector3(0, 0.2, 1).normalize() },
      uRayleigh: { value: p.rayleigh },
      uTurbidity: { value: p.turbidity },
      uMieCoefficient: { value: p.mieCoefficient },
      uMieDirectionalG: { value: p.mieDirectionalG },
      uSkyIntensity: { value: p.skyIntensity },
      uHighlightComp: { value: p.highlightComp },
      uSaturation: { value: p.saturation },
      uHazeFalloff: { value: p.hazeFalloff },
      uHazeStrength: { value: p.hazeStrength },
      uHazeLift: { value: p.hazeLift },
      uHazeCool: { value: c(p.hazeCool) },
      uHazeWarm: { value: c(p.hazeWarm) },
      uGroundColor: { value: c(p.groundColor) },
      uCloudCoverage: { value: p.cloudCoverage },
      uCloudDensity: { value: p.cloudDensity },
      uCloudSharpness: { value: p.cloudSharpness },
      uCloudScale: { value: p.cloudScale },
      uCloudSpeed: { value: p.cloudSpeed },
      uCloudShadow: { value: c(p.cloudShadow) },
      uCloudLit: { value: c(p.cloudLit) },
      uCloudRim: { value: c(p.cloudRim) },
      uSunDiscIntensity: { value: p.sunDiscIntensity },
      uSunDiscColor: { value: c(p.sunDiscColor) },
      uShowSunDisc: { value: 1 },
      uCloudOcclusion: { value: p.cloudOcclusion },
      uSunGlowIntensity: { value: p.sunGlowIntensity },
      uSunGlowExponent: { value: p.sunGlowExponent },
      uSunHaloIntensity: { value: p.sunHaloIntensity },
      uSunHaloExponent: { value: p.sunHaloExponent },
      uSunVeilIntensity: { value: p.sunVeilIntensity },
      uSunVeilExponent: { value: p.sunVeilExponent },
      uSkyWarm: { value: c(p.skyWarm) },
      uSkyCool: { value: c(p.skyCool) },
      uSkyRampExp: { value: p.skyRampExp },
      uZenithScale: { value: p.zenithScale },
      uTime: { value: 0 },
      uProbe: { value: 0 },
      uProbeTint: { value: c(p.probeTint) },
      uProbeGround: { value: c(p.probeGround) },
      uProbeClamp: { value: p.probeClamp },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    // Drawn first (renderOrder -1000) with depth entirely out of the picture: it can
    // never occlude anything, and it does not care what the depth buffer was
    // initialised to — which matters because PMREM renders it without clearing.
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
  });
}

/** A sky dome that always sits on the far plane. */
export function createSkyMesh(material, scale = 12000) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.scale.setScalar(scale);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.name = 'SkyDome';
  return mesh;
}
