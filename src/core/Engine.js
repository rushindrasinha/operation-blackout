import * as THREE from 'three';
import { Config } from './Config.js';
import { EventBus } from './EventBus.js';
import { Input } from './Input.js';

/**
 * Engine owns the frame. Systems are plain objects registered with a name and
 * an update order; Engine never reaches into their internals.
 *
 * OWNER: core. System agents MUST NOT edit this file — if you need something
 * from the engine, take it off `ctx` or emit an event.
 *
 * ── SYSTEM CONTRACT ─────────────────────────────────────────────────────────
 * Every system is a class shaped like:
 *
 *   export class MySystem {
 *     static id = 'mySystem';          // key it appears under on ctx
 *     static order = 50;               // update order, low runs first
 *     constructor(ctx) { this.ctx = ctx; }
 *     async init(onProgress) {}        // async setup; call onProgress(0..1, 'label')
 *     fixedUpdate(fdt) {}              // optional, 60Hz, for physics-coupled logic
 *     update(dt, elapsed) {}           // per rendered frame
 *     resize(w, h) {}                  // optional
 *     dispose() {}
 *   }
 *
 * ── UPDATE ORDER BANDS ──────────────────────────────────────────────────────
 *   10  physics        20  player      30  ai        40  weapons
 *   50  fx             60  audio       70  lighting  80  hud
 *   90  renderPipeline (renders last, owns the final composite)
 * ────────────────────────────────────────────────────────────────────────────
 */
export class Engine {
  constructor(container) {
    this.container = container;
    this.systems = [];
    this._running = false;
    this._accumulator = 0;
    this.fixedStep = 1 / 60;
    this.maxSubSteps = 5;

    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.frame = 0;

    this._initRenderer();
    this._initScene();

    this.ctx = {
      THREE,
      engine: this,
      config: Config,
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      // Weapon viewmodel lives in its own scene rendered with a tighter FOV so
      // the gun doesn't distort at the wide world FOV. Standard AAA practice.
      viewmodelScene: this.viewmodelScene,
      viewmodelCamera: this.viewmodelCamera,
      events: new EventBus(),
      input: new Input(this.renderer.domElement),
      // Systems self-register here under their static id.
      systems: {},
    };

    window.addEventListener('resize', () => this._onResize());
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,          // TAA handles AA; MSAA would fight the post stack
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, Config.render.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated in r185 — WebGLShadowMap silently downgrades it
    // to PCFShadowMap and forces a full material recompile. Set it explicitly.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping; // post stack tonemaps instead
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    // The post pipeline issues many render() calls per frame, and renderer.info resets on
    // each one — so the reported draw-call count was always just the last pass (1). Take
    // manual control and reset once per frame so the number reflects the whole frame.
    this.renderer.info.autoReset = false;
    this.container.appendChild(this.renderer.domElement);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      Config.camera.fov,
      window.innerWidth / window.innerHeight,
      Config.camera.near,
      Config.camera.far,
    );
    this.camera.position.set(0, Config.player.height, 0);

    this.viewmodelScene = new THREE.Scene();
    this.viewmodelCamera = new THREE.PerspectiveCamera(
      Config.camera.viewmodelFov,
      window.innerWidth / window.innerHeight,
      0.005,
      12,
    );
  }

  register(SystemClass) {
    const sys = new SystemClass(this.ctx);
    sys._id = SystemClass.id ?? SystemClass.name;
    sys._order = SystemClass.order ?? 50;
    this.systems.push(sys);
    this.ctx.systems[sys._id] = sys;
    this.ctx[sys._id] = sys; // convenience: ctx.physics, ctx.player, ...
    return sys;
  }

  async initAll(onProgress = () => {}) {
    this.systems.sort((a, b) => a._order - b._order);
    const n = this.systems.length;
    for (let i = 0; i < n; i++) {
      const sys = this.systems[i];
      const base = i / n;
      onProgress(base, sys._id);
      if (sys.init) {
        await sys.init((p, label) => onProgress(base + (p / n), label ?? sys._id));
      }
    }
    onProgress(1, 'ready');
    this._onResize();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.clock.start();
    this._loop();
  }

  stop() { this._running = false; }

  _loop = () => {
    if (!this._running) return;
    requestAnimationFrame(this._loop);

    // Clamp dt so an alt-tab doesn't teleport everything through walls.
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += dt;
    this.frame++;
    this.renderer.info.reset();

    // Fixed-step band for anything physics-coupled.
    this._accumulator += dt;
    let steps = 0;
    while (this._accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      for (const s of this.systems) s.fixedUpdate?.(this.fixedStep);
      this._accumulator -= this.fixedStep;
      steps++;
    }
    if (steps === this.maxSubSteps) this._accumulator = 0; // shed backlog

    for (const s of this.systems) s.update?.(dt, this.elapsed);

    this.ctx.input.endFrame();
  };

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewmodelCamera.aspect = w / h;
    this.viewmodelCamera.updateProjectionMatrix();
    for (const s of this.systems) s.resize?.(w, h);
  }

  dispose() {
    this.stop();
    for (const s of this.systems) s.dispose?.();
    this.renderer.dispose();
  }
}

export default Engine;
