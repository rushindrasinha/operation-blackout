/**
 * Near-field particulate.
 *
 * "Air that is never perfectly clear" is on the reference calibration list, and the
 * cheap way to get it is distance fog — which is exactly the trap: fog dense enough to
 * *read* in the first fifteen metres is fog dense enough to erase the midground, which
 * is how a scene ends up using haze as an LOD system. The reference frames get their
 * depth from something else entirely: suspended dust catching the key light within a
 * few metres of the camera, moving slowly, brightest when you look toward the sun.
 *
 * So this is a small, self-contained, additive point field that follows the camera and
 * wraps around it. It costs one draw call and no CPU work per frame (all motion is in
 * the vertex shader), and it deliberately never gets bright enough to read as an
 * effect — it reads as air.
 *
 * It is excluded from the G-buffer by the render contract (Points), so it takes no AO,
 * no SSR and no motion vectors. That is fine for something this dim and this slow;
 * anything faster would ghost through TAA.
 *
 * OWNER: lighting.
 */
import * as THREE from 'three';

const COUNT = 640;
const EXTENT = 15.0;      // half-size of the wrapping box, metres

const vertexShader = /* glsl */`
  uniform float uTime;
  uniform vec3  uCam;
  uniform float uExtent;
  uniform float uSize;
  uniform vec3  uSunDir;
  attribute float aSeed;
  attribute float aScale;
  varying float vAlpha;
  varying float vWarm;

  void main() {
    vec3 p = position;

    // Slow convective drift — each mote has its own phase and speed from its seed.
    float t = uTime * ( 0.28 + fract( aSeed * 7.13 ) * 0.5 );
    p.x += sin( t * 0.7 + aSeed * 6.28 ) * 0.55;
    p.y += sin( t * 0.41 + aSeed * 11.7 ) * 0.42 + uTime * 0.055 * ( 0.4 + fract( aSeed * 3.1 ) );
    p.z += cos( t * 0.63 + aSeed * 9.4 ) * 0.55;

    // Wrap the field around the camera so it is always populated and never streams.
    vec3 rel = p - uCam;
    rel = mod( rel + uExtent, 2.0 * uExtent ) - uExtent;
    vec3 world = uCam + rel;

    vec4 mv = modelViewMatrix * vec4( world, 1.0 );
    float d = -mv.z;

    // Fade in past the near plane (motes on the lens are distracting) and out with
    // distance, so this is unambiguously a *near-field* cue.
    float near = smoothstep( 0.9, 2.6, d );
    float far = 1.0 - smoothstep( uExtent * 0.55, uExtent * 1.25, d );

    // Backlit: a dust mote is a forward scatterer, so it is many times brighter when
    // the sun is behind it. This is the whole reason the effect reads as light.
    vec3 vdir = normalize( world - uCam );
    float fwd = max( dot( vdir, uSunDir ), 0.0 );
    vWarm = pow( fwd, 3.0 );
    vAlpha = near * far * ( 0.24 + 0.90 * pow( fwd, 2.2 ) );

    gl_PointSize = uSize * aScale * ( 1.0 + vWarm * 0.8 ) * ( 12.0 / max( d, 0.6 ) );
    gl_PointSize = clamp( gl_PointSize, 1.0, 7.0 );
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */`
  uniform vec3 uCool;
  uniform vec3 uWarmCol;
  uniform float uIntensity;
  varying float vAlpha;
  varying float vWarm;

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r2 = dot( p, p ) * 4.0;
    if ( r2 > 1.0 ) discard;
    float a = pow( max( 1.0 - r2, 0.0 ), 1.6 );
    vec3 col = mix( uCool, uWarmCol, vWarm );
    gl_FragColor = vec4( col * a * vAlpha * uIntensity, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class DustMotes {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.points = null;
    this.enabled = false;
    this._cam = new THREE.Vector3();

    try {
      const n = opts.count ?? COUNT;
      const extent = opts.extent ?? EXTENT;
      const pos = new Float32Array(n * 3);
      const seed = new Float32Array(n);
      const scale = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = (Math.random() * 2 - 1) * extent;
        pos[i * 3 + 1] = (Math.random() * 2 - 1) * extent;
        pos[i * 3 + 2] = (Math.random() * 2 - 1) * extent;
        seed[i] = Math.random();
        // A few larger, brighter motes read as real grit rather than as noise.
        scale[i] = 0.55 + Math.pow(Math.random(), 3) * 1.6;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

      this.material = new THREE.ShaderMaterial({
        name: 'DustMotes',
        uniforms: {
          uTime: { value: 0 },
          uCam: { value: new THREE.Vector3() },
          uExtent: { value: extent },
          uSize: { value: opts.size ?? 1.0 },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uCool: { value: new THREE.Vector3(0.30, 0.34, 0.42) },
          uWarmCol: { value: new THREE.Vector3(1.0, 0.72, 0.42) },
          uIntensity: { value: opts.intensity ?? 0.19 },
        },
        vertexShader,
        fragmentShader,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        fog: false,
      });

      this.points = new THREE.Points(geo, this.material);
      this.points.name = 'DustMotes';
      this.points.frustumCulled = false;
      this.points.renderOrder = 8;
      ctx.scene.add(this.points);
      this.enabled = true;
    } catch (err) {
      console.error('[lighting] dust motes unavailable:', err);
      this.enabled = false;
    }
  }

  setSunDirection(dir) {
    try { this.material?.uniforms.uSunDir.value.copy(dir); } catch { /* ignore */ }
  }

  update(elapsed, cameraPos) {
    if (!this.enabled) return;
    const u = this.material.uniforms;
    u.uTime.value = elapsed;
    u.uCam.value.copy(cameraPos);
  }

  dispose() {
    try {
      this.points?.parent?.remove(this.points);
      this.points?.geometry.dispose();
      this.material?.dispose();
    } catch { /* ignore */ }
    this.points = null;
    this.enabled = false;
  }
}

export default DustMotes;
