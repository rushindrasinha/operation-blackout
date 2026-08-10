import * as THREE from 'three';

/**
 * Minimal, allocation-free full-screen pass plumbing.
 *
 * We deliberately do NOT use EffectComposer's stock passes — every effect in this
 * pipeline is a hand-written shader. This file is only the plumbing: one shared
 * full-screen triangle, one ortho camera, and a tiny Pass wrapper.
 *
 * OWNER: render
 */

const FS_VERT = /* glsl */`
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

let _geo = null;
function fullscreenGeometry() {
  if (_geo) return _geo;
  // A single oversized triangle beats a quad: no diagonal seam, one fewer vertex,
  // and the GPU rasterises it in one go.
  _geo = new THREE.BufferGeometry();
  _geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0, 3, -1, 0, -1, 3, 0,
  ]), 3));
  _geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0, 2, 0, 0, 2,
  ]), 2));
  return _geo;
}

export class Pass {
  /**
   * @param {string} fragmentShader GLSL3 fragment source. Must declare its own outputs.
   * @param {object} uniforms       three-style uniform record.
   * @param {object} [defines]
   */
  constructor(fragmentShader, uniforms = {}, defines = {}) {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FS_VERT,
      fragmentShader,
      uniforms,
      defines,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.uniforms = this.material.uniforms;
    this.mesh = new THREE.Mesh(fullscreenGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
  }

  setDefine(name, value) {
    if (this.material.defines[name] === value) return;
    this.material.defines[name] = value;
    this.material.needsUpdate = true;
  }

  /** Render this pass into `target` (null = canvas). */
  render(renderer, target, camera, clear = true) {
    renderer.setRenderTarget(target ?? null);
    if (clear) renderer.clear(true, false, false);
    renderer.render(this.scene, camera);
  }

  dispose() {
    this.material.dispose();
  }
}

/** Shared ortho camera for every full-screen pass. */
export function makeQuadCamera() {
  return new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
}

/** HDR colour target. */
export function makeHDRTarget(w, h, opts = {}) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...opts,
  });
}

/** 8-bit LDR helper target (AO). */
export function makeLDRTarget(w, h, opts = {}) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...opts,
  });
}

export function disposeTarget(rt) {
  if (!rt) return;
  try {
    if (rt.depthTexture) rt.depthTexture.dispose();
    rt.dispose();
  } catch (e) { /* already gone */ }
}

export { FS_VERT };
