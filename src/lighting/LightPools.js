/**
 * Projected light pools.
 *
 * A practical is eight point lights fighting over a budget, and three.js windows a
 * point light to zero at `light.distance`. Both facts are correct and both produce the
 * same defect: a sodium head 30 m down the street is a bright emissive lens attached to
 * a pole that is not lit, standing over ground that is not lit. It reads as a sticker.
 * At dusk a lit sodium lamp is visible as a warm pool from sixty metres and further.
 *
 * The fix is the same one shipped games use: the point light does the *near* work
 * (surface normals, falloff on the pole and the wall behind it) and a cheap projected
 * pool does the *far* work, because at that distance nothing about the pool is
 * view-dependent — it is a warm ellipse on the floor.
 *
 * Implementation notes that matter:
 *   - one InstancedMesh, one draw call, additive, no depth write, so it composites over
 *     whatever the ground is without touching the G-buffer (which would poison normals);
 *   - the ground height under each fixture is found once with a physics raycast, not
 *     assumed to be y=0 — this map has walkways, catwalks and a raised yard;
 *   - the pool tracks the practical's flicker gain, so a failing ballast flickers on the
 *     floor as well as in the lens;
 *   - it is refreshed on a slow timer against the camera, never per frame.
 *
 * OWNER: lighting.
 */
import * as THREE from 'three';

const DOWN = new THREE.Vector3(0, -1, 0);

const MAX_POOLS = 16;
const REFRESH_INTERVAL = 0.35;   // seconds between re-selections
const MAX_RANGE = 110;           // metres — beyond this a pool is sub-pixel anyway

const vertexShader = /* glsl */`
  attribute vec3 aColor;
  varying vec2 vUvP;
  varying vec3 vColor;
  varying float vFade;
  void main() {
    vUvP = uv;
    vColor = aColor;
    mat4 mvi = modelViewMatrix * instanceMatrix;
    vec4 mv = mvi * vec4( position, 1.0 );
    // Fade the pool out as it approaches the camera: up close the real point light is
    // doing the work and a flat decal would double it.
    float d = -mv.z;
    vFade = smoothstep( 2.5, 7.0, d ) * ( 1.0 - smoothstep( ${MAX_RANGE.toFixed(1)}, ${(MAX_RANGE * 1.4).toFixed(1)}, d ) );
    // Grazing fade. A pool is a flat quad lying on the floor; seen from within a few
    // degrees of its own plane it collapses to a bright horizontal smear hanging in
    // mid-air, which is the most obvious decal tell there is. Physically the answer is
    // the same as the artefact: a Lambertian pool seen edge-on subtends nothing, so
    // fold the cosine in and it disappears on its own.
    vec3 pn = normalize( mat3( mvi ) * vec3( 0.0, 0.0, 1.0 ) );
    float ndv = abs( dot( pn, normalize( mv.xyz ) ) );
    vFade *= smoothstep( 0.06, 0.34, ndv );
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */`
  varying vec2 vUvP;
  varying vec3 vColor;
  varying float vFade;
  void main() {
    vec2 p = ( vUvP - 0.5 ) * 2.0;
    float r2 = dot( p, p );
    if ( r2 > 1.0 ) discard;
    // Inverse-square-ish core with a long feathered edge. A hard-edged disc is the
    // single most obvious tell that a light pool is a decal.
    float core = 1.0 / ( 1.0 + 7.0 * r2 ) - 0.125;
    float feather = pow( max( 1.0 - r2, 0.0 ), 2.2 );
    float a = max( core, 0.0 ) * 1.15 + feather * 0.30;
    gl_FragColor = vec4( vColor * a * vFade, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class LightPools {
  /**
   * @param {object} ctx engine context
   * @param {Practicals} practicals pool owner
   */
  constructor(ctx, practicals) {
    this.ctx = ctx;
    this.practicals = practicals;
    this.mesh = null;
    this.enabled = false;
    this._timer = 0;
    this._active = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();

    try {
      const geo = new THREE.PlaneGeometry(1, 1);
      const colors = new Float32Array(MAX_POOLS * 3);
      geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));

      const mat = new THREE.ShaderMaterial({
        name: 'LightPool',
        vertexShader,
        fragmentShader,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        fog: false,
        side: THREE.DoubleSide,
      });

      this.mesh = new THREE.InstancedMesh(geo, mat, MAX_POOLS);
      this.mesh.name = 'LightPools';
      this.mesh.frustumCulled = false;
      this.mesh.count = 0;
      this.mesh.renderOrder = 6;
      this.mesh.castShadow = false;
      this.mesh.receiveShadow = false;
      // Excluded from the G-buffer by the render contract (transparent + depthWrite
      // false), which is exactly right: this is inscattered light, not a surface.
      this.mesh.userData.noGBuffer = true;
      ctx.scene.add(this.mesh);
      this.colors = geo.getAttribute('aColor');
      this.enabled = true;
    } catch (err) {
      console.error('[lighting] light pools unavailable:', err);
      this.enabled = false;
    }
  }

  /** Ground height under a fixture. Cached on the entry; retried a few times. */
  _groundY(entry) {
    if (entry.poolY !== undefined) return entry.poolY;
    if ((entry._poolTries ?? 0) > 3) return (entry.poolY = entry.position.y - 4.2);
    entry._poolTries = (entry._poolTries ?? 0) + 1;
    try {
      const phys = this.ctx.physics ?? this.ctx.systems?.physics;
      const hit = phys?.raycast?.(
        this._p.copy(entry.position).addScaledVector(DOWN, 0.15),
        DOWN, 30,
      );
      if (hit && hit.point) {
        entry.poolY = hit.point.y + 0.035;
        return entry.poolY;
      }
    } catch { /* physics not ready yet — try again next refresh */ }
    return entry.position.y - 4.2;
  }

  /**
   * How far the pool can spread before it runs into something.
   *
   * A flat additive quad that intersects a wall shows a hard straight-edged wedge on
   * that wall — the classic decal/geometry intersection artifact, and an instant fail
   * on "visible geometry seams". Rather than solve it in the shader (which would need
   * the depth buffer this material has no access to), we simply do not let the pool
   * reach the wall: eight rays from the *fixture* out and down to the rim of the
   * intended pool. Casting from the fixture rather than from the floor is deliberate —
   * a ray leaving the lamp head passes over its own pole and over low clutter, so a
   * street lamp does not shrink its own pool to nothing.
   */
  _clearRadius(entry, want, groundY) {
    if (entry._poolR !== undefined) return entry._poolR;
    const phys = this.ctx.physics ?? this.ctx.systems?.physics;
    if (!phys?.raycast) return want;
    let min = want;
    try {
      const origin = entry.position;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.19;
        const tx = origin.x + Math.cos(a) * want;
        const tz = origin.z + Math.sin(a) * want;
        this._p.set(tx - origin.x, groundY - origin.y, tz - origin.z);
        const len = this._p.length();
        if (len < 1e-3) continue;
        const hit = phys.raycast(origin, this._p, len * 0.98);
        if (hit && hit.distance < len) {
          // Horizontal reach of the obstruction, with a margin so the feathered rim
          // stops short of the surface rather than grazing it.
          const frac = hit.distance / len;
          min = Math.min(min, Math.max(1.1, want * frac - 0.35));
        }
      }
    } catch { /* physics not ready — retry next refresh */ return want; }
    entry._poolR = min;
    return min;
  }

  update(dt, cameraPos) {
    if (!this.enabled || !this.mesh) return;
    this._timer -= dt;
    if (this._timer > 0) { this._drive(); return; }
    this._timer = REFRESH_INTERVAL;

    try {
      const entries = this.practicals?.entries ?? [];
      const picked = this._active;
      picked.length = 0;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.pool === false) continue;
        const d2 = e.position.distanceToSquared(cameraPos);
        if (d2 > MAX_RANGE * MAX_RANGE * 1.96) continue;
        e._poolScore = e.intensity / (1 + d2 * 0.02);
        picked.push(e);
      }
      picked.sort((a, b) => b._poolScore - a._poolScore);
      if (picked.length > MAX_POOLS) picked.length = MAX_POOLS;

      for (let i = 0; i < picked.length; i++) {
        const e = picked[i];
        const y = this._groundY(e);
        const drop = Math.max(0.6, e.position.y - y);
        // A lamp mounted higher throws a wider, softer pool; the radius is the point
        // where the inverse-square term has fallen to roughly a tenth of its peak.
        const want = THREE.MathUtils.clamp(
          Math.min(e.radius * 0.55, drop * 1.5 + 1.4), 1.4, 9.5,
        );
        const radius = this._clearRadius(e, want, y);
        this._p.set(e.position.x, y, e.position.z);
        this._s.set(radius * 2, radius * 2, 1);
        this._m.compose(this._p, this._q, this._s);
        this.mesh.setMatrixAt(i, this._m);
      }
      this.mesh.count = picked.length;
      this.mesh.instanceMatrix.needsUpdate = true;
      this._drive();
    } catch (err) {
      if (!this._logged) { this._logged = true; console.error('[lighting] light pool update failed:', err); }
    }
  }

  /** Per-frame colour/gain refresh — cheap, no matrix work. */
  _drive() {
    const picked = this._active;
    if (!picked.length || !this.colors) return;
    const arr = this.colors.array;
    for (let i = 0; i < picked.length; i++) {
      const e = picked[i];
      // Peak radiance of the pool: the lamp's own intensity attenuated over the drop,
      // so a 42 cd street head reads brighter than a 12 cd shop lamp, as it should.
      const drop = Math.max(1.2, e.position.y - (e.poolY ?? e.position.y - 4.2));
      // Cross-fade against the real point light. A slotted lamp is already lighting
      // its own floor with correct falloff and normals; painting a decal on top of
      // that doubles the energy, washes the near field and costs fill rate for
      // nothing. The pool is the *stand-in* for lamps outside the light budget.
      const handoff = 1 - THREE.MathUtils.clamp(e._live ?? 0, 0, 1);
      // Must use the *same* falloff exponent as the real point light, or a lamp
      // crossing the budget boundary visibly changes brightness as its pool takes
      // over. See PRACTICAL_DECAY in Practicals.js.
      const decay = this.practicals?.decay ?? 2;
      const k = (e.intensity * (e._decayComp ?? 1) / Math.pow(drop, decay)) * 0.55 * (e._gain ?? 1) * handoff;
      const g = THREE.MathUtils.clamp(k, 0, 2.4);
      arr[i * 3] = e.color.r * g;
      arr[i * 3 + 1] = e.color.g * g;
      arr[i * 3 + 2] = e.color.b * g;
    }
    this.colors.needsUpdate = true;
  }

  dispose() {
    try {
      if (this.mesh) {
        this.mesh.parent?.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
      }
    } catch { /* ignore */ }
    this.mesh = null;
    this.enabled = false;
  }
}

export default LightPools;
