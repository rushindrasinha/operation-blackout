import * as THREE from 'three';

/**
 * Pooled, instanced, depth-soft particle batch.
 *
 * One batch == one draw call, no matter how many particles are alive. Every
 * particle in the game lives in one of three batches (lit / additive world /
 * additive viewmodel), so the entire FX layer costs three draws.
 *
 * Why hand-written instead of Points or Sprites:
 *
 *  - the render pipeline excludes Points/Sprites/transparent meshes from the
 *    G-buffer, so they get no TAA reprojection. Anything thin and bright will
 *    crawl. Soft, wide, low-contrast quads are the only shape that survives.
 *  - **soft particles**: a quad that intersects geometry along a hard line is
 *    the loudest amateur tell there is. We sample the G-buffer depth texture
 *    (one frame stale — imperceptible) and fade the particle out as it
 *    approaches the surface behind it.
 *  - stretched billboards: sparks and tracers are oriented and elongated along
 *    their own screen-space motion, so a 300 m/s tracer reads as a streak
 *    rather than a dot, and a bouncing spark leaves a real trail.
 *
 * Simulation is CPU-side over parallel Float32Arrays with a free list — zero
 * allocation per particle, ever. `update()` writes straight into the instanced
 * attribute buffers.
 *
 * OWNER: fx
 */

/* Behaviour ids. */
export const K = {
  SMOKE: 0,     // buoyant, expands, drag-dominated
  DUST: 1,      // like smoke but heavier and it settles
  SPARK: 2,     // ballistic, bounces off its birth plane, cools as it flies
  EMBER: 3,     // rises with turbulence, flickers
  MOTE: 4,      // near-static brownian drift (ambient life)
  FLASH: 5,     // no motion, sub-frame lifetime
  TRACER: 6,    // linear travel at speed
  CHIP: 7,      // ballistic + tumble, no bounce (splinters, glass, blood)
  ORIENTED: 8,  // world-oriented quad glued to a surface (light pools)
};

const ATLAS_GRID = 4;

const VERT = /* glsl */`
precision highp float;

attribute vec3 aPos;
attribute vec3 aPrev;
attribute vec4 aMisc;    // x size  y rotation  z stretch  w atlas tile
attribute vec4 aColor;   // rgb premultiplied by emissive gain, a alpha
// xyz surface normal. w packs two things: the integer part is the mode
// (0 billboard, 2 world-oriented) and the fraction is sun visibility at the
// spawn point, so smoke born in shadow never picks up a direct-sun rim.
attribute vec4 aOrient;

uniform float uAtlasInv;
uniform float uAtlasCols;
uniform float uSoftScale;

varying vec2 vUv;
varying vec2 vLocal;
varying vec4 vColor;
varying float vViewZ;
varying float vSoft;
varying float vMode;
varying float vSunVis;
varying vec3 vNrmView;

#include <common>
#include <fog_pars_vertex>

void main() {
  vec2 corner = position.xy;              // unit plane, -0.5 .. 0.5
  float size    = aMisc.x;
  float rot     = aMisc.y;
  float stretch = aMisc.z;
  float tile    = aMisc.w;

  float packed = aOrient.w;
  float oriented = step( 1.5, packed );
  vSunVis = packed - oriented * 2.0;

  vec4 mvPosition;

  if ( oriented > 0.5 ) {
    // Glued to a surface: build an orthonormal frame around the normal so the
    // quad lies flat on the geometry instead of facing the camera.
    vec3 n = normalize( aOrient.xyz );
    vec3 up = abs( n.y ) > 0.9 ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 1.0, 0.0 );
    vec3 t = normalize( cross( up, n ) );
    vec3 b = cross( n, t );
    float cr = cos( rot ), sr = sin( rot );
    vec2 rc = vec2( corner.x * cr - corner.y * sr, corner.x * sr + corner.y * cr ) * size;
    vec3 worldP = aPos + t * rc.x + b * rc.y;
    mvPosition = viewMatrix * vec4( worldP, 1.0 );
    vNrmView = normalize( ( viewMatrix * vec4( n, 0.0 ) ).xyz );
    vMode = 1.0;
  } else {
    vec4 c = viewMatrix * vec4( aPos, 1.0 );
    vec2 off;
    if ( stretch > 0.001 ) {
      vec4 p = viewMatrix * vec4( aPrev, 1.0 );
      vec2 d = c.xy - p.xy;
      float dl = length( d );
      if ( dl > 1e-5 ) {
        vec2 ax = d / dl;
        vec2 pe = vec2( -ax.y, ax.x );
        float halfLen = size * 0.5 + dl * stretch * 0.5;
        off = ax * ( corner.y * 2.0 * halfLen ) + pe * ( corner.x * size );
        off -= ax * ( dl * stretch * 0.5 );   // centre the quad on prev..curr
      } else {
        float cr = cos( rot ), sr = sin( rot );
        off = vec2( corner.x * cr - corner.y * sr, corner.x * sr + corner.y * cr ) * size;
      }
    } else {
      float cr = cos( rot ), sr = sin( rot );
      off = vec2( corner.x * cr - corner.y * sr, corner.x * sr + corner.y * cr ) * size;
    }
    mvPosition = c + vec4( off, 0.0, 0.0 );
    vNrmView = vec3( 0.0, 0.0, 1.0 );
    vMode = 0.0;
  }

  vViewZ = -mvPosition.z;
  // A surface-glued quad is *deliberately* coplanar with geometry, so the soft
  // fade would erase it entirely. Negative softness disables the test.
  vSoft = vMode > 0.5 ? -1.0 : max( size * uSoftScale, 0.05 );
  gl_Position = projectionMatrix * mvPosition;

  float col = mod( tile, uAtlasCols );
  float row = floor( tile / uAtlasCols );
  vUv = ( vec2( col, row ) + uv ) * uAtlasInv;
  vLocal = uv;
  vColor = aColor;

  #include <fog_vertex>
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform sampler2D uAtlas;
uniform sampler2D tDepth;
uniform vec2 uInvRes;
uniform float uNear;
uniform float uFar;
uniform float uSoftEnabled;
uniform float uLit;
uniform vec3 uSunDirView;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uUpView;
uniform float uNearFade;
uniform float uFogAtten;   // additive path only: exp2 attenuation strength

varying vec2 vUv;
varying vec2 vLocal;
varying vec4 vColor;
varying float vViewZ;
varying float vSoft;
varying float vMode;
varying float vSunVis;
varying vec3 vNrmView;

#include <common>
#include <packing>
#include <fog_pars_fragment>

void main() {
  vec4 tex = texture2D( uAtlas, vUv );
  float a = tex.a * vColor.a;
  if ( a < 0.0035 ) discard;

  vec3 c = tex.rgb * vColor.rgb;

  if ( uLit > 0.5 ) {
    vec3 n;
    if ( vMode > 0.5 ) {
      n = normalize( vNrmView );
    } else {
      n.xy = vLocal * 2.0 - 1.0;
      float r2 = min( dot( n.xy, n.xy ), 1.0 );
      n.z = sqrt( max( 0.06, 1.0 - r2 ) );
      n = normalize( n );
    }
    float ndl = dot( n, uSunDirView );
    // Participating media: most of the energy scatters forward, so smoke lit
    // from behind is *brighter* than smoke lit from the front. Skipping the
    // back-scatter lobe is what makes browser smoke read as grey cardboard.
    float front = clamp( ndl, 0.0, 1.0 );
    float back  = pow( clamp( -ndl, 0.0, 1.0 ), 1.6 );
    vec3 sun = uSunColor * ( front * 0.42 + back * 0.80 + 0.07 ) * vSunVis;
    float up = clamp( dot( n, uUpView ) * 0.5 + 0.5, 0.0, 1.0 );
    vec3 amb = mix( uGroundColor, uSkyColor, up );
    c *= sun + amb;
  }

  if ( uSoftEnabled > 0.5 && vSoft > 0.0 ) {
    float dRaw = texture2D( tDepth, gl_FragCoord.xy * uInvRes ).x;
    float sceneZ = -perspectiveDepthToViewZ( dRaw, uNear, uFar );
    a *= clamp( ( sceneZ - vViewZ ) / vSoft, 0.0, 1.0 );
  }

  // Never let a particle slap the lens.
  a *= clamp( ( vViewZ - uNearFade ) * 5.0, 0.0, 1.0 );

  if ( uFogAtten > 0.0 ) {
    // Additive path: haze must *attenuate* an emitter, not tint it.
    float od = uFogAtten * vViewZ;
    c *= exp( -od * od );
  }

  gl_FragColor = vec4( c, a );

  #include <fog_fragment>
}
`;

export class ParticleBatch {
  /**
   * @param {object} opts
   *   capacity, atlas (THREE.Texture), additive (bool), lit (bool),
   *   scene (THREE.Scene), renderOrder, soft (bool), name
   */
  constructor(opts) {
    const n = this.capacity = Math.max(8, opts.capacity | 0 || 256);
    this.lit = !!opts.lit;
    this.additive = !!opts.additive;
    this.soft = opts.soft !== false;
    this.name = opts.name || 'fx:particles';

    /* ── simulation state (SoA, zero runtime allocation) ── */
    const F = (k = 1) => new Float32Array(n * k);
    this.px = F(); this.py = F(); this.pz = F();
    this.vx = F(); this.vy = F(); this.vz = F();
    this.ox = F(); this.oy = F(); this.oz = F();
    this.age = F(); this.life = F();
    this.s0 = F(); this.s1 = F();
    this.rot = F(); this.rotv = F();
    this.tile = F();
    this.cr = F(); this.cg = F(); this.cb = F();
    this.er = F(); this.eg = F(); this.eb = F();
    this.a0 = F(); this.fi = F(); this.fe = F();
    this.drag = F(); this.grav = F();
    this.kind = F(); this.stretch = F();
    this.nx = F(); this.ny = F(); this.nz = F();
    this.pd = F(); this.bounce = F();
    this.e0 = F(); this.e1 = F();
    this.turb = F(); this.seed = F();
    this.sunv = F();

    this.alive = new Uint8Array(n);
    this.free = new Int32Array(n);
    for (let i = 0; i < n; i++) this.free[i] = n - 1 - i;
    this.freeCount = n;
    this.liveCount = 0;

    /* ── GPU side ── */
    const base = new THREE.PlaneGeometry(1, 1, 1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    base.dispose();

    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aPrev = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aMisc = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aOrient = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    for (const a of [this.aPos, this.aPrev, this.aMisc, this.aColor, this.aOrient]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aPrev', this.aPrev);
    geo.setAttribute('aMisc', this.aMisc);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aOrient', this.aOrient);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uAtlas: { value: opts.atlas ?? null },
        tDepth: { value: null },
        uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uNear: { value: 0.02 },
        uFar: { value: 900 },
        uSoftEnabled: { value: 0 },
        uLit: { value: this.lit ? 1 : 0 },
        uSunDirView: { value: new THREE.Vector3(0, 0, -1) },
        uSunColor: { value: new THREE.Vector3(1.0, 0.86, 0.68) },
        uSkyColor: { value: new THREE.Vector3(0.16, 0.19, 0.24) },
        uGroundColor: { value: new THREE.Vector3(0.055, 0.048, 0.042) },
        uUpView: { value: new THREE.Vector3(0, 1, 0) },
        uAtlasInv: { value: 1 / ATLAS_GRID },
        uAtlasCols: { value: ATLAS_GRID },
        uSoftScale: { value: 0.85 },
        uNearFade: { value: 0.18 },
        uFogAtten: { value: this.additive ? 0.0068 : 0.0 },
      },
    ]);
    uniforms.uAtlas.value = opts.atlas ?? null;

    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: this.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      fog: !this.additive,   // additive does its own attenuation, see uFogAtten
      toneMapped: false,
    });
    this.material.name = this.name;

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = this.name;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = opts.renderOrder ?? 10;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Never let anything raycast against a particle cloud.
    this.mesh.raycast = () => {};

    if (opts.scene) opts.scene.add(this.mesh);

    /* sort scratch for the alpha-blended batch */
    this._order = new Int32Array(n);
    this._depth = new Float32Array(n);
    this._sortAcc = 0;
  }

  get count() { return this.liveCount; }

  /**
   * Spawn one particle. `o` is a plain options object; every field has a
   * default, and the caller reuses one object, so this never allocates.
   * Returns the slot index or -1 when the pool is saturated.
   */
  spawn(o) {
    if (this.freeCount === 0) return -1;
    const i = this.free[--this.freeCount];
    this.alive[i] = 1;
    this.liveCount++;

    const px = o.x ?? 0, py = o.y ?? 0, pz = o.z ?? 0;
    this.px[i] = px; this.py[i] = py; this.pz[i] = pz;
    this.ox[i] = px; this.oy[i] = py; this.oz[i] = pz;
    this.vx[i] = o.vx ?? 0; this.vy[i] = o.vy ?? 0; this.vz[i] = o.vz ?? 0;
    this.age[i] = 0;
    this.life[i] = Math.max(0.016, o.life ?? 1);
    this.s0[i] = o.size ?? 0.2;
    this.s1[i] = o.endSize ?? (o.size ?? 0.2);
    this.rot[i] = o.rot ?? 0;
    this.rotv[i] = o.rotv ?? 0;
    this.tile[i] = o.tile ?? 0;
    this.cr[i] = o.r ?? 1; this.cg[i] = o.g ?? 1; this.cb[i] = o.b ?? 1;
    this.er[i] = o.r2 ?? (o.r ?? 1); this.eg[i] = o.g2 ?? (o.g ?? 1); this.eb[i] = o.b2 ?? (o.b ?? 1);
    this.a0[i] = o.alpha ?? 1;
    this.fi[i] = Math.max(1e-4, o.fadeIn ?? 0.04);
    this.fe[i] = o.fadeExp ?? 1.6;
    this.drag[i] = o.drag ?? 0.6;
    this.grav[i] = o.gravity ?? 0;
    this.kind[i] = o.kind ?? K.SMOKE;
    this.stretch[i] = o.stretch ?? 0;
    this.nx[i] = o.nx ?? 0; this.ny[i] = o.ny ?? 1; this.nz[i] = o.nz ?? 0;
    this.pd[i] = o.planeD ?? -1e9;
    this.bounce[i] = o.bounce ?? 0;
    this.e0[i] = o.emissive ?? 1;
    this.e1[i] = o.endEmissive ?? (o.emissive ?? 1);
    this.turb[i] = o.turbulence ?? 0;
    this.seed[i] = o.seed ?? (Math.random() * 1000);
    // 0 = fully shadowed, 1 = in direct sun. Sampled once per burst by the FX
    // system with a single ray, then shared by every particle in that burst.
    this.sunv[i] = o.sunVis === undefined ? 1 : Math.max(0, Math.min(1, o.sunVis));
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
  }

  /**
   * Integrate + write instance buffers.
   * @param {number} dt
   * @param {number} elapsed
   * @param {THREE.Matrix4} viewMatrix used to depth-sort the alpha batch
   */
  update(dt, elapsed, viewMatrix) {
    const n = this.capacity;
    const d = Math.min(dt, 0.05);

    const px = this.px, py = this.py, pz = this.pz;
    const vx = this.vx, vy = this.vy, vz = this.vz;
    const ox = this.ox, oy = this.oy, oz = this.oz;

    for (let i = 0; i < n; i++) {
      if (!this.alive[i]) continue;
      this.age[i] += d;
      if (this.age[i] >= this.life[i]) { this.kill(i); continue; }

      ox[i] = px[i]; oy[i] = py[i]; oz[i] = pz[i];

      const kind = this.kind[i];
      const t = this.age[i] / this.life[i];

      if (kind === K.FLASH || kind === K.ORIENTED) {
        // Static. Position never moves; only size and alpha animate.
      } else if (kind === K.MOTE) {
        const s = this.seed[i];
        const w = elapsed * 0.35 + s;
        // Slow brownian sway. Cheap trig beats a noise lookup here.
        vx[i] += (Math.sin(w * 1.31) * 0.9 + Math.sin(w * 0.47 + 2.1) * 0.5) * 0.014 * d * 60;
        vy[i] += (Math.sin(w * 0.83 + 1.7) * 0.7 - 0.28) * 0.010 * d * 60;
        vz[i] += (Math.cos(w * 1.07 + 0.4) * 0.9 + Math.cos(w * 0.61 + 3.3) * 0.5) * 0.014 * d * 60;
        const k = Math.max(0, 1 - 2.6 * d);
        vx[i] *= k; vy[i] *= k; vz[i] *= k;
        px[i] += vx[i] * d; py[i] += vy[i] * d; pz[i] += vz[i] * d;
      } else {
        // Ballistic core, shared by everything that actually travels.
        const dragK = Math.max(0, 1 - this.drag[i] * d);
        vy[i] += this.grav[i] * d;

        const turb = this.turb[i];
        if (turb > 0) {
          const w = elapsed * 2.3 + this.seed[i];
          vx[i] += Math.sin(w * 1.7) * turb * d;
          vy[i] += (Math.sin(w * 1.13 + 1.2) * 0.5 + 0.5) * turb * d;
          vz[i] += Math.cos(w * 1.41 + 2.4) * turb * d;
        }

        vx[i] *= dragK; vy[i] *= dragK; vz[i] *= dragK;
        px[i] += vx[i] * d; py[i] += vy[i] * d; pz[i] += vz[i] * d;

        // Half-space bounce against the surface the particle was born on.
        // A real raycast per spark per frame is unaffordable; the birth plane
        // catches the case that actually reads on screen — sparks skittering
        // away from the wall they came out of.
        const b = this.bounce[i];
        if (b > 0) {
          const dist = px[i] * this.nx[i] + py[i] * this.ny[i] + pz[i] * this.nz[i] - this.pd[i];
          if (dist < 0) {
            const vn = vx[i] * this.nx[i] + vy[i] * this.ny[i] + vz[i] * this.nz[i];
            if (vn < 0) {
              const j = -(1 + b) * vn;
              vx[i] += this.nx[i] * j; vy[i] += this.ny[i] * j; vz[i] += this.nz[i] * j;
              // Tangential scrub so bounces lose energy and spread.
              vx[i] *= 0.72; vy[i] *= 0.72; vz[i] *= 0.72;
            }
            px[i] -= this.nx[i] * dist;
            py[i] -= this.ny[i] * dist;
            pz[i] -= this.nz[i] * dist;
          }
        }
      }

      this.rot[i] += this.rotv[i] * d;
      void t;
    }

    this._writeBuffers(elapsed, viewMatrix);
  }

  _writeBuffers(elapsed, viewMatrix) {
    const n = this.capacity;
    const order = this._order;
    let live = 0;

    if (!this.additive && viewMatrix) {
      // Depth-sort back-to-front. With depthWrite off and one instanced draw,
      // this is the only way overlapping smoke composites correctly.
      const e = viewMatrix.elements;
      const dep = this._depth;
      for (let i = 0; i < n; i++) {
        if (!this.alive[i]) continue;
        dep[live] = -(e[2] * this.px[i] + e[6] * this.py[i] + e[10] * this.pz[i] + e[14]);
        order[live] = i;
        live++;
      }
      // Insertion sort: the array is near-sorted frame to frame, so this is
      // effectively O(n) and never allocates a comparator closure.
      for (let a = 1; a < live; a++) {
        const ki = order[a], kd = dep[a];
        let b = a - 1;
        while (b >= 0 && dep[b] < kd) { dep[b + 1] = dep[b]; order[b + 1] = order[b]; b--; }
        dep[b + 1] = kd; order[b + 1] = ki;
      }
    } else {
      for (let i = 0; i < n; i++) {
        if (!this.alive[i]) continue;
        order[live++] = i;
      }
    }

    const AP = this.aPos.array, AV = this.aPrev.array;
    const AM = this.aMisc.array, AC = this.aColor.array, AO = this.aOrient.array;

    for (let k = 0; k < live; k++) {
      const i = order[k];
      const t = Math.min(1, this.age[i] / this.life[i]);

      // Size: fast initial expansion, then it eases out. Linear growth looks
      // like an inflating balloon; this looks like a pressure release.
      const ease = 1 - (1 - t) * (1 - t);
      const size = this.s0[i] + (this.s1[i] - this.s0[i]) * ease;

      const fadeIn = Math.min(1, this.age[i] / this.fi[i]);
      const rem = 1 - t;
      let alpha = this.a0[i] * fadeIn * Math.pow(rem, this.fe[i]);

      if (this.kind[i] === K.MOTE) {
        // Twinkle: motes catching the light are never steady.
        alpha = this.a0[i] * (0.42 + 0.58 * (0.5 + 0.5 * Math.sin(elapsed * 2.1 + this.seed[i] * 6.3)));
      }

      const emis = this.e0[i] + (this.e1[i] - this.e0[i]) * t;
      const cr = (this.cr[i] + (this.er[i] - this.cr[i]) * t) * emis;
      const cg = (this.cg[i] + (this.eg[i] - this.cg[i]) * t) * emis;
      const cb = (this.cb[i] + (this.eb[i] - this.cb[i]) * t) * emis;

      const i3 = k * 3, i4 = k * 4;
      AP[i3] = this.px[i]; AP[i3 + 1] = this.py[i]; AP[i3 + 2] = this.pz[i];
      AV[i3] = this.ox[i]; AV[i3 + 1] = this.oy[i]; AV[i3 + 2] = this.oz[i];
      AM[i4] = size; AM[i4 + 1] = this.rot[i]; AM[i4 + 2] = this.stretch[i]; AM[i4 + 3] = this.tile[i];
      AC[i4] = cr; AC[i4 + 1] = cg; AC[i4 + 2] = cb; AC[i4 + 3] = alpha;
      const oriented = this.kind[i] === K.ORIENTED ? 2 : 0;
      AO[i4] = this.nx[i]; AO[i4 + 1] = this.ny[i]; AO[i4 + 2] = this.nz[i];
      AO[i4 + 3] = oriented + this.sunv[i] * 0.999;
    }

    this.geometry.instanceCount = live;
    if (live > 0) {
      this.aPos.needsUpdate = true;
      this.aPrev.needsUpdate = true;
      this.aMisc.needsUpdate = true;
      this.aColor.needsUpdate = true;
      this.aOrient.needsUpdate = true;
    }
    this.mesh.visible = live > 0;
  }

  /** Bind the (previous frame's) scene depth so the soft-particle fade works. */
  setDepth(depthTexture, invResX, invResY, near, far) {
    const u = this.material.uniforms;
    if (this.soft && depthTexture) {
      u.tDepth.value = depthTexture;
      u.uInvRes.value.set(invResX, invResY);
      u.uNear.value = near;
      u.uFar.value = far;
      u.uSoftEnabled.value = 1;
    } else {
      u.uSoftEnabled.value = 0;
    }
  }

  setLighting(sunDirView, sunColor, skyColor, groundColor, upView) {
    const u = this.material.uniforms;
    u.uSunDirView.value.copy(sunDirView);
    u.uSunColor.value.copy(sunColor);
    u.uSkyColor.value.copy(skyColor);
    u.uGroundColor.value.copy(groundColor);
    u.uUpView.value.copy(upView);
  }

  dispose() {
    try { this.mesh.parent?.remove(this.mesh); } catch { /* already detached */ }
    try { this.geometry.dispose(); } catch { /* noop */ }
    try { this.material.dispose(); } catch { /* noop */ }
  }
}

export default ParticleBatch;
