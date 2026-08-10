import * as THREE from 'three';

/**
 * TracerBeams — world-space, perspective-correct tracer rounds.
 *
 * WHY THIS EXISTS (it replaces two stretched billboards in the additive batch).
 *
 * The original tracer was a screen-space stretched quad: the vertex shader took
 * the particle's previous and current view-space position and elongated a quad
 * between them. That has three defects no amount of texture authoring can hide:
 *
 *  1. **Its length was a function of framerate.** The streak spanned
 *     `speed * dt`, so a 620 m/s round drew 7.5 m at 82fps and 23 m at 27fps.
 *  2. **No perspective foreshortening.** One quad lives at one depth, so its
 *     width was constant along a length that covered 20 m of Z.
 *  3. **No core/glow separation.** One atlas tile cannot be simultaneously a
 *     2-pixel near-white core and an 8-pixel amber halo, so it was neither.
 *
 * A tracer is not a particle, it is a *segment*. Each instance stores a
 * world-space head and tail; the vertex shader builds a camera-facing ribbon
 * between them, subdivided along its length so it twists correctly when it
 * passes close to the lens. Both endpoints go through the projection
 * independently, so foreshortening, taper and depth are free and correct.
 *
 * ── SECOND PASS (this revision) ────────────────────────────────────────────
 * The first version fixed the topology but still read as "a flat orange bar":
 *
 *  a. **The ribbon was floored at 3 px of half-width.** Inside 80 m that floor
 *     never engaged, but past it every tracer stayed 6 px wide at full
 *     brightness — a round 150 m out looked exactly as thick and as bright as
 *     one at 20 m. There was distance *scaling* but no distance *falloff*.
 *     Now the floor is 1.6 px and, crucially, whenever the clamp widens the
 *     ribbon the fragment brightness is divided by the same factor. Total
 *     emitted energy is conserved, so a distant round thins AND dims into the
 *     haze instead of sitting on top of it, while never becoming a sub-pixel
 *     line that crawls (transparents get no TAA in this pipeline).
 *
 *  b. **The glow radius was 16.5 cm — a third of a metre of saturated amber.**
 *     At 25 m that is a 15-pixel band, and a 15-pixel band whose halo carries
 *     most of the energy is a painted stripe, not a round in flight. The glow
 *     is now 9 cm with the energy pushed into a ~3 cm near-white core that
 *     clips through the tonemapper and clears the bloom prefilter. The halo is
 *     demoted to a dim amber skirt around it. That ratio — tiny hot core, wide
 *     dim glow — is the entire difference between phosphor and a highlighter.
 *
 *  c. **The ends were flat.** The ribbon stopped dead at the endpoints, so the
 *     "rounded cap" was a fade along the quad's own length rather than a real
 *     round end. The ribbon is now padded by one glow radius past each endpoint
 *     and the fragment shader evaluates a true capsule distance field in units
 *     of the local glow radius, so both ends are genuinely circular in world
 *     space at every distance and every angle.
 *
 *  d. **The trail was 8.4 m at rifle velocity.** Physically defensible for a
 *     1/60 s exposure, visually a bar that crosses a third of the frame — and
 *     with a tracer on *every* round, consecutive streaks joined end to end
 *     into one continuous line with no emitter at either end. The trail is now
 *     ~3.7 m and FXSystem only makes every third round a tracer.
 *
 * The fragment shader does what a real round in flight does: a tight near-white
 * core plus a wide dim amber halo, an exponential brightness taper toward the
 * tail, round caps, a soft-particle fade against the G-buffer depth so it is
 * occluded by and dissolves into geometry, and the same exp(-od²) haze
 * attenuation the additive particle batch uses.
 *
 * Cost: one extra draw call, only when at least one round is in flight.
 *
 * OWNER: fx
 */

const SEGMENTS = 8;

const VERT = /* glsl */`
precision highp float;

attribute vec3 aTail;    // world-space trailing end
attribute vec3 aHead;    // world-space leading end (the round itself)
attribute vec4 aShape;   // x head glow radius  y tail glow radius  z alpha  w intensity
attribute vec4 aTint;    // rgb halo tint, w flicker phase

uniform float uPixelWorld;   // world units per pixel, per metre of view depth
uniform float uMinPx;        // never let the ribbon fall below this many pixels
uniform float uCoreFrac;     // core radius as a fraction of the glow radius
uniform float uMinCorePx;    // ...but the core must still cover this many pixels

varying float vX;            // lateral coordinate, in units of the local glow radius
varying float vSRaw;         // 0 at the tail, 1 at the head; overshoots into the caps
varying float vScale;        // segment length expressed in local glow radii
varying float vViewZ;
varying float vAlpha;
varying float vIntensity;
varying float vEnergy;       // <=1 when the pixel-width floor widened the ribbon
varying vec3  vTint;
varying float vSoft;
varying float vCoreSigma;

void main() {
  vec3 seg = aHead - aTail;
  float segLen = length( seg );
  vec3 axis = segLen > 1e-5 ? seg / segLen : vec3( 0.0, 1.0, 0.0 );

  // Round caps need the ribbon to overhang its endpoints by one glow radius.
  // Resolve that overhang once, at the segment's midpoint, so the padded quad
  // has a single well-defined parameterisation.
  // The overhang is sized off the HEAD radius, the larger of the two: pad it by
  // the tail radius instead and the head's cap gets clipped at 72% of its own
  // radius, leaving a faint straight edge exactly where the round is brightest.
  vec3  mid      = ( aHead + aTail ) * 0.5;
  float midDist  = max( length( cameraPosition - mid ), 1e-4 );
  float pad      = max( aShape.x, uMinPx * uPixelWorld * midDist );
  float padFrac  = pad / max( segLen + 2.0 * pad, 1e-4 );

  // s runs 0..1 over the real segment and overshoots into the caps. mix()
  // extrapolates, which is exactly the overhang we want.
  float s = ( uv.y - padFrac ) / max( 1.0 - 2.0 * padFrac, 1e-4 );
  vec3  P = mix( aTail, aHead, s );

  vec3 toCam = cameraPosition - P;
  float camDist = length( toCam );
  toCam = camDist > 1e-5 ? toCam / camDist : vec3( 0.0, 0.0, 1.0 );

  vec3 side = cross( axis, toCam );
  float sl = length( side );
  // Looking straight down the barrel of the round: the ribbon degenerates, so
  // fall back to any vector perpendicular to the axis rather than to NaN.
  side = sl > 1e-4 ? side / sl
                   : normalize( abs( axis.y ) > 0.9 ? cross( axis, vec3( 1.0, 0.0, 0.0 ) )
                                                    : cross( axis, vec3( 0.0, 1.0, 0.0 ) ) );

  float hwWorld = mix( aShape.y, aShape.x, clamp( s, 0.0, 1.0 ) );
  float pxWorld = uPixelWorld * camDist;     // one pixel, in metres, at this depth

  // A bright line thinner than a pixel crawls badly, and transparents get no TAA
  // in this pipeline (ARCHITECTURE.md). Floor the ribbon's screen width — but
  // pay for the widening in brightness, or the floor turns into "every tracer is
  // the same thickness and the same brightness at every range", which is the
  // "no perspective taper, no falloff" the critics kept seeing.
  float hw     = max( hwWorld, uMinPx * pxWorld );
  float widen  = hwWorld / hw;               // 1 when unclamped, <1 when floored
  vEnergy = clamp( widen, 0.06, 1.0 );

  // THE thing that made the first attempt invisible: the hot core is a couple of
  // centimetres wide, which at 40 m is a fraction of a pixel — the rasteriser
  // samples pixel centres, so it simply never landed on the bright part and the
  // whole tracer read as a dim hairline. Carry the core's width to the fragment
  // shader as a fraction of the ribbon, floored so it always covers real pixels.
  vCoreSigma = clamp(
    max( uCoreFrac * widen, uMinCorePx * pxWorld / hw ), 0.10, 0.85 );

  vec3 worldP = P + side * ( ( uv.x - 0.5 ) * 2.0 * hw );

  vec4 mv = viewMatrix * vec4( worldP, 1.0 );
  vViewZ = -mv.z;
  vSoft  = max( hw * 3.0, 0.10 );
  gl_Position = projectionMatrix * mv;

  // Capsule distance field, expressed in units of the LOCAL glow radius so the
  // fragment shader's gaussians are resolution- and distance-independent.
  //
  // The cap term is deliberately NOT folded here. The ribbon carries 9 vertex
  // rows, so the overhang — 9 cm on a 3.7 m segment, 2% of the quad — falls
  // entirely between the first two rows. Interpolating a finished cap value
  // across that gap smears a 9 cm rounded end into a 46 cm fade and, far worse,
  // kills the head hotspot: the brightest 12% of the round is exactly where the
  // smeared cap term is still suppressing it. Ship the raw parameter and let the
  // fragment shader do the max(), which is exact at any tessellation.
  vX     = ( uv.x - 0.5 ) * 2.0;
  vSRaw  = s;
  vScale = segLen / max( hw, 1e-5 );

  vAlpha     = aShape.z;
  vIntensity = aShape.w;
  vTint      = aTint.xyz;
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform sampler2D tDepth;
uniform vec2  uInvRes;
uniform float uNear;
uniform float uFar;
uniform float uSoftEnabled;
uniform float uFogAtten;
uniform float uNearFade;
uniform vec3  uCore;
uniform float uCoreGain;
uniform float uTaper;
uniform float uHaloSigma;
uniform float uHaloGain;

varying float vX;
varying float vSRaw;
varying float vScale;
varying float vViewZ;
varying float vAlpha;
varying float vIntensity;
varying float vEnergy;
varying vec3  vTint;
varying float vSoft;
varying float vCoreSigma;

#include <common>
#include <packing>

void main() {
  // True capsule field: |lateral| inside the segment, radial distance to the
  // endpoint outside it. Both ends are therefore round in WORLD space at every
  // distance and every viewing angle — a tracer that stops at a straight edge is
  // the single thing that makes one read as a rectangle.
  float over = max( max( vSRaw - 1.0, -vSRaw ), 0.0 ) * vScale;
  float vS   = clamp( vSRaw, 0.0, 1.0 );
  float r2   = vX * vX + over * over;

  // Two lobes: a tight, almost-white core (the phosphor) and a wide, dim amber
  // halo (its glow in the haze). This separation is the whole difference between
  // "round of glowing phosphor" and "orange line".
  float cs   = vCoreSigma;
  float core = exp( -r2 / ( cs * cs ) );
  float halo = exp( -r2 / ( uHaloSigma * uHaloSigma ) );

  // Exponential falloff along the length — brightest at the round, dying out
  // behind it. Plus a tight extra hotspot right at the head.
  float along = exp( -( 1.0 - vS ) * uTaper );
  float hot   = exp( -( 1.0 - vS ) * 26.0 );

  // The core dies faster along the length than the halo does, so the head is
  // white-hot and the trail behind it grades into amber rather than staying one
  // flat saturated colour the whole way down.
  float coreE = core * ( 1.0 + hot * 1.7 ) * pow( along, 0.40 );
  float haloE = halo * ( 0.50 + 0.50 * along );

  // vEnergy conserves total emitted light when the pixel-width floor widened the
  // ribbon: distance now costs brightness as well as thickness.
  float fade = along * vAlpha * vEnergy;

  if ( uSoftEnabled > 0.5 ) {
    float dRaw = texture2D( tDepth, gl_FragCoord.xy * uInvRes ).x;
    float sceneZ = -perspectiveDepthToViewZ( dRaw, uNear, uFar );
    fade *= clamp( ( sceneZ - vViewZ ) / vSoft, 0.0, 1.0 );
  }

  // Never slap the lens with the player's own round as it leaves the muzzle.
  fade *= clamp( ( vViewZ - uNearFade ) * 3.2, 0.0, 1.0 );

  // An additive emitter must be *attenuated* by haze, not tinted by it.
  float od = uFogAtten * vViewZ;
  fade *= exp( -od * od );

  // Emission is written straight out and the blend factor is One — no alpha
  // multiply — so core and halo brightness are independently controllable
  // instead of being tangled together through a shared coverage term. The core
  // deliberately sits well over white so it clips through the tonemapper and
  // clears the bloom prefilter; the halo deliberately does not, so the tracer
  // blooms from a point rather than glowing along its whole length.
  vec3 E = ( uCore * ( coreE * uCoreGain ) + vTint * ( haloE * uHaloGain ) )
           * vIntensity * fade;

  if ( max( E.r, max( E.g, E.b ) ) < 0.0016 ) discard;
  gl_FragColor = vec4( E, 1.0 );
}
`;

export class TracerBeams {
  /**
   * @param {object} opts capacity, scene, renderOrder
   */
  constructor(opts = {}) {
    const n = this.capacity = Math.max(4, opts.capacity | 0 || 40);

    /* ── pooled simulation state, zero runtime allocation ── */
    const F = () => new Float32Array(n);
    this.ox = F(); this.oy = F(); this.oz = F();
    this.dx = F(); this.dy = F(); this.dz = F();
    this.dist = F(); this.speed = F(); this.len = F();
    this.age = F(); this.life = F();
    this.hw0 = F(); this.hw1 = F();
    this.tr = F(); this.tg = F(); this.tb = F();
    this.gain = F(); this.seed = F();

    this.alive = new Uint8Array(n);
    this.free = new Int32Array(n);
    for (let i = 0; i < n; i++) this.free[i] = n - 1 - i;
    this.freeCount = n;
    this.liveCount = 0;

    /* ── GPU side ── */
    // Subdivided along its length so a ribbon that passes close to the camera
    // twists to face it instead of shearing.
    const base = new THREE.PlaneGeometry(1, 1, 1, SEGMENTS);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    base.dispose();

    this.aTail = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aHead = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aShape = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    for (const a of [this.aTail, this.aHead, this.aShape, this.aTint]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geo.setAttribute('aTail', this.aTail);
    geo.setAttribute('aHead', this.aHead);
    geo.setAttribute('aShape', this.aShape);
    geo.setAttribute('aTint', this.aTint);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uNear: { value: 0.02 },
        uFar: { value: 900 },
        uSoftEnabled: { value: 0 },
        uFogAtten: { value: 0.0068 },
        uNearFade: { value: 0.42 },
        // Warm near-white. The core must not be the most saturated thing in a
        // deliberately desaturated frame — the *halo* carries the amber.
        uCore: { value: new THREE.Vector3(1.0, 0.93, 0.80) },
        // Over-white on purpose: the composite tonemaps hard, so a core that
        // peaks at 1.0 in HDR arrives as mid-grey.
        uCoreGain: { value: 2.1 },
        uTaper: { value: 4.2 },
        uHaloSigma: { value: 0.62 },
        // Deliberately an order of magnitude under the core. The halo is the
        // round's glow in the air, not the round.
        uHaloGain: { value: 0.40 },
        uPixelWorld: { value: 2 * Math.tan(THREE.MathUtils.degToRad(60) * 0.5) / 1080 },
        // 1.6 px half-width: wide enough not to crawl without TAA, narrow enough
        // that a round 150 m out is visibly finer than one at 20 m.
        uMinPx: { value: 1.6 },
        uCoreFrac: { value: 0.34 },
        uMinCorePx: { value: 1.0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Straight additive with a One source factor: the fragment shader writes
      // emission directly, so the core can be 10x over white while the halo sits
      // at a tenth of that. THREE.AdditiveBlending scales by alpha, which forces
      // the two lobes to share one coverage term.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    this.material.name = 'fx:tracer';

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'fx:tracer';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = opts.renderOrder ?? 13;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};

    if (opts.scene) opts.scene.add(this.mesh);
  }

  get count() { return this.liveCount; }

  /**
   * @param {THREE.Vector3} from muzzle position
   * @param {THREE.Vector3} dirUnit normalised direction of travel
   * @param {number} dist metres to the impact point (or to the far cull)
   * @param {number} speed metres per second
   * @param {object} o { len, width, gain, r, g, b }
   */
  spawn(from, dirUnit, dist, speed, o = {}) {
    if (this.freeCount === 0) return -1;
    // Degenerate rounds are the source of "orphan streaks with no falloff" —
    // a zero-length segment renders as whatever the vertex shader's fallback
    // basis happens to produce. Refuse them outright.
    if (!(dist > 0.6) || !Number.isFinite(dist)) return -1;
    if (!Number.isFinite(from.x + from.y + from.z)) return -1;
    const dl = Math.hypot(dirUnit.x, dirUnit.y, dirUnit.z);
    if (!(dl > 1e-4)) return -1;

    const i = this.free[--this.freeCount];
    this.alive[i] = 1;
    this.liveCount++;

    const inv = 1 / dl;
    this.ox[i] = from.x; this.oy[i] = from.y; this.oz[i] = from.z;
    this.dx[i] = dirUnit.x * inv; this.dy[i] = dirUnit.y * inv; this.dz[i] = dirUnit.z * inv;

    const sp = Math.max(60, speed || 330);
    // A *fixed metre* trail — framerate can no longer change how long a round
    // looks. 6 ms of travel rather than the 13.5 ms a 1/60 s exposure would
    // smear: physically that exposure is right, but at rifle velocity it draws a
    // 8.4 m bar, and consecutive bars butt together into one continuous line
    // with no visible emitter at either end. 3.7 m reads as a round.
    const len = Math.min(o.len ?? (sp * 0.0060), dist * 0.85, 6.0);

    this.dist[i] = Math.min(dist, 260);
    this.speed[i] = sp;
    this.len[i] = Math.max(1.1, len);
    this.age[i] = 0;
    // Hard lifetime ceiling: travel time plus the time the trail needs to catch
    // up, and never more than 1.1 s no matter what a caller asks for.
    this.life[i] = Math.min(1.1, (this.dist[i] + this.len[i]) / sp + 0.02);

    // This is the *glow* radius (the halo). The hot core sits at uCoreFrac of it,
    // so a 9 cm glow carries a ~3 cm phosphor core — which is what a tracer round
    // actually looks like through a camera.
    const w = o.width ?? 0.09;
    this.hw0[i] = w;             // head
    this.hw1[i] = w * 0.40;      // tail tapers in as well as fading out
    this.tr[i] = o.r ?? 1.0; this.tg[i] = o.g ?? 0.64; this.tb[i] = o.b ?? 0.34;
    this.gain[i] = o.gain ?? 1.0;
    this.seed[i] = Math.random() * 6.283;
    return i;
  }

  kill(i) {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.liveCount--;
    this.free[this.freeCount++] = i;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) if (this.alive[i]) this.kill(i);
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  update(dt, elapsed) {
    const n = this.capacity;
    const d = Math.min(dt, 0.05);
    const TA = this.aTail.array, HA = this.aHead.array;
    const SA = this.aShape.array, CA = this.aTint.array;
    let live = 0;

    for (let i = 0; i < n; i++) {
      if (!this.alive[i]) continue;
      this.age[i] += d;
      if (this.age[i] >= this.life[i]) { this.kill(i); continue; }

      const sp = this.speed[i];
      const dist = this.dist[i];
      const len = this.len[i];
      const travelled = sp * this.age[i];

      const headS = travelled < dist ? travelled : dist;
      let tailS = travelled - len;
      if (tailS < 0) tailS = 0;
      if (tailS >= dist) { this.kill(i); continue; }

      // A ribbon shorter than a couple of glow radii is a blob with an arbitrary
      // orientation, not a tracer. Hold it out of the draw rather than emitting
      // a degenerate quad.
      const span = headS - tailS;
      if (span <= this.hw0[i] * 0.5) continue;

      const ox = this.ox[i], oy = this.oy[i], oz = this.oz[i];
      const dx = this.dx[i], dy = this.dy[i], dz = this.dz[i];

      const i3 = live * 3, i4 = live * 4;
      TA[i3] = ox + dx * tailS; TA[i3 + 1] = oy + dy * tailS; TA[i3 + 2] = oz + dz * tailS;
      HA[i3] = ox + dx * headS; HA[i3 + 1] = oy + dy * headS; HA[i3 + 2] = oz + dz * headS;

      // Fade as the trail contracts into the impact point, and ease in over the
      // first metre so the round does not pop into existence at the muzzle.
      const remain = dist - tailS;
      let alpha = this.gain[i];
      if (remain < len) alpha *= remain / len;
      if (span < len) alpha *= 0.35 + 0.65 * (span / len);
      // Tracers are burning propellant; they are never perfectly steady.
      const flick = 0.90 + 0.10 * Math.sin(elapsed * 47.0 + this.seed[i]);

      SA[i4] = this.hw0[i]; SA[i4 + 1] = this.hw1[i];
      SA[i4 + 2] = alpha; SA[i4 + 3] = 2.4 * flick;
      CA[i4] = this.tr[i]; CA[i4 + 1] = this.tg[i]; CA[i4 + 2] = this.tb[i]; CA[i4 + 3] = this.seed[i];
      live++;
    }

    this.geometry.instanceCount = live;
    if (live > 0) {
      this.aTail.needsUpdate = true;
      this.aHead.needsUpdate = true;
      this.aShape.needsUpdate = true;
      this.aTint.needsUpdate = true;
    }
    this.mesh.visible = live > 0;
  }

  /** Screen metrics so the pixel-width floor is correct for the live camera. */
  setCamera(camera, height) {
    if (!camera || !camera.isPerspectiveCamera) return;
    const h = height > 1 ? height : 1080;
    this.material.uniforms.uPixelWorld.value =
      2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) / h;
  }

  setDepth(depthTexture, invResX, invResY, near, far) {
    const u = this.material.uniforms;
    if (depthTexture) {
      u.tDepth.value = depthTexture;
      u.uInvRes.value.set(invResX, invResY);
      u.uNear.value = near;
      u.uFar.value = far;
      u.uSoftEnabled.value = 1;
    } else {
      u.uSoftEnabled.value = 0;
    }
  }

  dispose() {
    try { this.mesh.parent?.remove(this.mesh); } catch { /* already detached */ }
    try { this.geometry.dispose(); } catch { /* noop */ }
    try { this.material.dispose(); } catch { /* noop */ }
  }
}

export default TracerBeams;
