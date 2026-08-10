import * as THREE from 'three';

/**
 * G-buffer prepass.
 *
 * Renders the world once more with a single override material into a 2-attachment
 * MRT (r185 `count: 2`) plus a real depth texture:
 *
 *   attachment 0  RGBA16F   xyz = view-space normal (normal-mapped)   w = roughness
 *   attachment 1  RGBA16F   xy  = screen-space velocity (uv units)    z = metalness  w = mask
 *   depth         DEPTH24   nonlinear device depth
 *
 * Velocity is computed from unjittered current/previous view-projection matrices so
 * TAA's reprojection is free of the sub-pixel jitter. Static geometry gets exact
 * camera motion vectors; dynamic geometry gets camera-only vectors, which the TAA
 * neighbourhood clamp cleans up.
 *
 * Per-object roughness / metalness / normal map are pulled off the *real* material in
 * `Material.onBeforeRender`, which three calls immediately before each draw — that is
 * how one override material can still be material-aware.
 *
 * OWNER: render
 */

const GB_VERT = /* glsl */`
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>

uniform mat4 uCurrVP;
uniform mat4 uPrevVP;
uniform mat4 uViewInv;

out vec3 vViewNormal;
out vec3 vViewPos;
out vec2 vUvG;
out vec4 vCurrClip;
out vec4 vPrevClip;

void main() {
  #include <batching_vertex>

  #include <beginnormal_vertex>
  #include <morphinstance_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>

  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>

  vViewNormal = transformedNormal;
  vViewPos = mvPosition.xyz;
  vUvG = uv;

  vec4 worldPos = uViewInv * mvPosition;
  vCurrClip = uCurrVP * worldPos;
  vPrevClip = uPrevVP * worldPos;
}
`;

const GB_FRAG = /* glsl */`
precision highp float;

uniform float uRoughness;
uniform float uMetalness;
uniform float uHasNormalMap;
uniform float uNormalScale;
uniform vec2  uNormalRepeat;
uniform vec2  uNormalOffset;
uniform sampler2D uNormalMap;
uniform float uHasORM;
uniform vec2  uOrmRepeat;
uniform vec2  uOrmOffset;
uniform sampler2D uOrmMap;

in vec3 vViewNormal;
in vec3 vViewPos;
in vec2 vUvG;
in vec4 vCurrClip;
in vec4 vPrevClip;

layout(location = 0) out vec4 gNormalRough;
layout(location = 1) out vec4 gVelocity;

// Derivative-based tangent frame — works without a tangent attribute.
vec3 perturbNormal(vec3 N, vec3 V, vec2 uv, vec3 mapN) {
  vec3 q0 = dFdx(V);
  vec3 q1 = dFdy(V);
  vec2 st0 = dFdx(uv);
  vec2 st1 = dFdy(uv);
  vec3 T = q0 * st1.y - q1 * st0.y;
  float lenT = length(T);
  if (lenT < 1e-8) return N;
  T /= lenT;
  T = normalize(T - N * dot(N, T));
  vec3 B = normalize(cross(N, T));
  return normalize(mat3(T, B, N) * mapN);
}

void main() {
  vec3 N = normalize(vViewNormal);
  if (!gl_FrontFacing) N = -N;

  if (uHasNormalMap > 0.5) {
    vec2 nuv = vUvG * uNormalRepeat + uNormalOffset;
    vec3 mapN = texture(uNormalMap, nuv).xyz * 2.0 - 1.0;
    mapN.xy *= uNormalScale;
    N = perturbNormal(N, vViewPos, nuv, normalize(mapN));
  }

  vec2 curr = (vCurrClip.xy / max(vCurrClip.w, 1e-6)) * 0.5 + 0.5;
  vec2 prev = (vPrevClip.xy / max(vPrevClip.w, 1e-6)) * 0.5 + 0.5;

  // Roughness / metalness must come from the packed ORM (R=AO, G=rough, B=metal),
  // not from the scalar alone. The materials system ships every surface with
  // scalar 1.0 and puts the real values in the map, so reading only the scalar
  // told SSR that the concrete ground was a mirror-smooth pure metal.
  float rough = uRoughness;
  float metal = uMetalness;
  if (uHasORM > 0.5) {
    vec3 orm = texture(uOrmMap, vUvG * uOrmRepeat + uOrmOffset).rgb;
    rough *= orm.g;
    metal *= orm.b;
  }

  // Geometric specular anti-aliasing (Kaplanyan/Toksvig style). Where the shading
  // normal varies fast inside one pixel footprint — an aggregate normal on a
  // concrete barrier, corrugated ribs seen at a grazing angle — a mirror-sharp
  // roughness makes SSR march a different direction for every pixel and returns
  // sparkle. Folding that per-pixel normal variance into the effective roughness
  // is the standard fix, and it is nearly free here because dFdx/dFdy of a value
  // we already have costs one instruction each.
  float nv = max(length(dFdx(N)), length(dFdy(N)));
  rough = sqrt(clamp(rough * rough + nv * nv * 0.65, 0.0, 1.0));

  // Roughness floor. Nothing in a dusty industrial yard is a perfect mirror, and a
  // near-zero roughness is the input that turns every sub-pixel normal wobble into
  // a screen-space reflection firefly.
  gNormalRough = vec4(N, clamp(rough, 0.16, 1.0));
  gVelocity = vec4(curr - prev, clamp(metal, 0.0, 1.0), 1.0);
}
`;

export class GBufferPass {
  constructor(ctx) {
    this.ctx = ctx;
    this.target = null;
    this._excluded = [];
    this._excludedVisible = [];
    this._scanCountdown = 0;

    // 1x1 flat normal so the sampler is never left unbound.
    const data = new Uint8Array([128, 128, 255, 255]);
    this._blankNormal = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    this._blankNormal.needsUpdate = true;

    // Last source material seen by onBeforeRender; see the note there.
    this._lastMat = null;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: GB_VERT,
      fragmentShader: GB_FRAG,
      uniforms: {
        uCurrVP: { value: new THREE.Matrix4() },
        uPrevVP: { value: new THREE.Matrix4() },
        uViewInv: { value: new THREE.Matrix4() },
        uRoughness: { value: 0.8 },
        uMetalness: { value: 0.0 },
        uHasNormalMap: { value: 0.0 },
        uNormalScale: { value: 1.0 },
        uNormalRepeat: { value: new THREE.Vector2(1, 1) },
        uNormalOffset: { value: new THREE.Vector2(0, 0) },
        uNormalMap: { value: this._blankNormal },
        uHasORM: { value: 0.0 },
        uOrmRepeat: { value: new THREE.Vector2(1, 1) },
        uOrmOffset: { value: new THREE.Vector2(0, 0) },
        uOrmMap: { value: this._blankNormal },
      },
      side: THREE.FrontSide,
    });

    const u = this.material.uniforms;
    const blank = this._blankNormal;
    // Called by WebGLRenderer immediately before each draw, with the *object* whose
    // real material we want to sample properties from.
    this.material.onBeforeRender = (renderer, scene, camera, geometry, object) => {
      const src = object && object.material;
      const m = Array.isArray(src) ? src[0] : src;

      /* WebGLRenderer only re-uploads a ShaderMaterial's uniforms when the material
       * *id* changes or `uniformsNeedUpdate` is set. One override material drawing
       * many objects means the id never changes, so the flag has to be raised or
       * every pixel in the G-buffer would carry whichever object uploaded first.
       *
       * But raising it unconditionally re-uploaded ALL fourteen uniforms — three of
       * them mat4s that are constant for the whole pass — once per draw call, and
       * this scene issues 400-650 of them. Three.js sorts opaque geometry by
       * program and then by material, so consecutive draws very often share the
       * same source material and the entire upload is redundant. Skipping it when
       * the source material has not changed since the last draw is exact: the
       * uniforms already hold that material's values, and a run of draws sharing a
       * material is precisely when nothing needs to change.
       *
       * The cache is invalidated at the top of every render() — the uniform block
       * survives between frames, but the *matrices* do not, and they are written
       * outside this callback. */
      if (m && m === this._lastMat) return;
      this._lastMat = m || null;
      this.material.uniformsNeedUpdate = true;

      if (!m) {
        u.uRoughness.value = 0.85; u.uMetalness.value = 0.0; u.uHasNormalMap.value = 0.0;
        u.uNormalMap.value = blank; u.uHasORM.value = 0.0; u.uOrmMap.value = blank;
        return;
      }
      u.uRoughness.value = (typeof m.roughness === 'number') ? m.roughness : 0.85;
      u.uMetalness.value = (typeof m.metalness === 'number') ? m.metalness : 0.0;
      const nm = m.normalMap;
      if (nm && nm.image) {
        u.uHasNormalMap.value = 1.0;
        u.uNormalMap.value = nm;
        u.uNormalScale.value = m.normalScale ? Math.min(2.0, Math.abs(m.normalScale.x)) : 1.0;
        u.uNormalRepeat.value.copy(nm.repeat);
        u.uNormalOffset.value.copy(nm.offset);
      } else {
        u.uHasNormalMap.value = 0.0;
        u.uNormalMap.value = blank;
      }
      // roughnessMap / metalnessMap / aoMap all point at the same packed ORM
      // texture by contract, so either one is a valid handle on it.
      const orm = m.roughnessMap || m.metalnessMap;
      if (orm && orm.image) {
        u.uHasORM.value = 1.0;
        u.uOrmMap.value = orm;
        u.uOrmRepeat.value.copy(orm.repeat);
        u.uOrmOffset.value.copy(orm.offset);
      } else {
        u.uHasORM.value = 0.0;
        u.uOrmMap.value = blank;
      }
    };
  }

  setSize(w, h) {
    if (this.target) {
      if (this.target.width === w && this.target.height === h) return;
      try { this.target.depthTexture?.dispose(); this.target.dispose(); } catch (e) { /* noop */ }
      this.target = null;
    }
    const depth = new THREE.DepthTexture(w, h);
    depth.format = THREE.DepthFormat;
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;

    const rt = new THREE.WebGLRenderTarget(w, h, {
      count: 2,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      depthTexture: depth,
    });
    // Normals want nearest (no interpolation across silhouettes); velocity likewise.
    for (const t of rt.textures) {
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
    }
    this.target = rt;
    return rt;
  }

  get normalTexture() { return this.target?.textures?.[0] ?? null; }
  get velocityTexture() { return this.target?.textures?.[1] ?? null; }
  get depthTexture() { return this.target?.depthTexture ?? null; }

  /**
   * Objects that would poison the G-buffer (particles, decals, glass, sprites,
   * lines) are hidden for the duration of the prepass and restored right after.
   * The list is rebuilt periodically so systems can spawn objects at any time.
   */
  _rescan(scene) {
    const out = this._excluded;
    out.length = 0;
    scene.traverse((o) => {
      if (o.isPoints || o.isLine || o.isSprite) { out.push(o); return; }
      if (!o.isMesh && !o.isInstancedMesh && !o.isBatchedMesh && !o.isSkinnedMesh) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m) return;
      if (m.transparent === true || m.depthWrite === false || m.colorWrite === false) out.push(o);
    });
  }

  render(renderer, scene, camera, currVP, prevVP) {
    if (!this.target) return false;

    if (this._scanCountdown-- <= 0) {
      this._scanCountdown = 15;
      try { this._rescan(scene); } catch (e) { this._excluded.length = 0; }
    }

    const u = this.material.uniforms;
    u.uCurrVP.value.copy(currVP);
    u.uPrevVP.value.copy(prevVP);
    u.uViewInv.value.copy(camera.matrixWorld);
    // The three matrices above changed, so the first draw of this frame must
    // upload regardless of which material it happens to use.
    this._lastMat = null;
    this.material.uniformsNeedUpdate = true;

    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;
    const prevFog = scene.fog;
    scene.background = null;
    scene.fog = null;
    scene.overrideMaterial = this.material;

    // Hide G-buffer-poisoning objects for the duration of the prepass. The saved
    // flags live in our own array — we never write to another system's userData.
    const hidden = this._excluded;
    const flags = this._excludedVisible;
    flags.length = hidden.length;
    for (let i = 0; i < hidden.length; i++) {
      flags[i] = hidden[i].visible;
      hidden[i].visible = false;
    }

    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    for (let i = 0; i < hidden.length; i++) hidden[i].visible = flags[i];

    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
    scene.fog = prevFog;
    return true;
  }

  dispose() {
    try { this.material.dispose(); } catch (e) { /* noop */ }
    try { this._blankNormal.dispose(); } catch (e) { /* noop */ }
    try { this.target?.depthTexture?.dispose(); this.target?.dispose(); } catch (e) { /* noop */ }
  }
}

export default GBufferPass;
