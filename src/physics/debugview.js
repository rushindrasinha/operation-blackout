import * as THREE from 'three';

/**
 * Wireframe view of the live Rapier world, driven by world.debugRender().
 *
 * Toggled by Config.debug.wireframe (polled every frame, so any agent can flip
 * it from the console at runtime: __ENGINE__.ctx.config.debug.wireframe = true).
 * Also exposed as ctx.physics.setDebugDraw(bool).
 *
 * OWNER: physics agent.
 */
export class PhysicsDebugView {
  constructor(physics) {
    this.physics = physics;
    this.ctx = physics.ctx;
    this.enabled = false;
    this.lines = null;
    this._capacity = 0;
    this._throttle = 0;
  }

  _ensure(vertexCount) {
    if (this.lines && this._capacity >= vertexCount) return;
    const capacity = Math.max(4096, THREE.MathUtils.ceilPowerOfTwo(vertexCount || 4096));

    if (!this.lines) {
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        depthTest: true,
        depthWrite: false,
        transparent: true,
        opacity: 0.85,
        toneMapped: false,
      });
      this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
      this.lines.name = 'physics:debug';
      this.lines.frustumCulled = false;
      this.lines.renderOrder = 9999;
      this.lines.matrixAutoUpdate = false;
    }

    this.lines.geometry?.dispose?.();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    geo.setDrawRange(0, 0);
    this.lines.geometry = geo;
    this._capacity = capacity;
  }

  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = !!on;
    if (!this.enabled && this.lines) {
      this.lines.visible = false;
      this.lines.parent?.remove(this.lines);
    }
  }

  update(dt) {
    const cfg = this.ctx.config?.debug;
    const want = !!(cfg && cfg.wireframe);
    if (want !== this.enabled) this.setEnabled(want);
    if (!this.enabled) return;

    // 30Hz is plenty for a debug overlay and halves the wasm->js copy cost.
    this._throttle += dt;
    if (this._throttle < 1 / 30 && this.lines?.visible) return;
    this._throttle = 0;

    const world = this.physics.world;
    if (!world) return;

    let buffers;
    try {
      buffers = world.debugRender();
    } catch (err) {
      console.warn('[physics] debugRender failed, disabling wireframe:', err);
      this.setEnabled(false);
      return;
    }
    if (!buffers) return;

    const verts = buffers.vertices;
    const cols = buffers.colors;
    const n = (verts.length / 3) | 0;
    this._ensure(n);

    const pos = this.lines.geometry.attributes.position;
    const col = this.lines.geometry.attributes.color;
    pos.array.set(verts.subarray(0, n * 3));
    // Rapier hands back RGBA; three's LineBasicMaterial wants RGB.
    for (let i = 0; i < n; i++) {
      col.array[i * 3] = cols[i * 4];
      col.array[i * 3 + 1] = cols[i * 4 + 1];
      col.array[i * 3 + 2] = cols[i * 4 + 2];
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, n);

    this.lines.visible = true;
    if (!this.lines.parent) {
      try { this.ctx.scene.add(this.lines); } catch { /* no scene */ }
    }
  }

  dispose() {
    if (!this.lines) return;
    this.lines.parent?.remove(this.lines);
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    this.lines = null;
  }
}

export default PhysicsDebugView;
