import * as THREE from 'three';
import { buildMaterialMaps, RECIPE_NAMES } from './recipes.js';
import { MtlStandardMaterial, MtlPhysicalMaterial, packSurface } from './surface.js';

/**
 * OPERATION BLACKOUT — MaterialSystem (order 5, runs before everything).
 * OWNER: materials agent. Everything in the game renders on these surfaces.
 *
 * Each material ships albedo (sRGB) + normal + ORM (linear, R=AO G=roughness
 * B=metalness) generated procedurally at 1024² or 2048². Generation runs in a
 * worker pool so the boot bar stays alive; if workers are unavailable it falls
 * back to synchronous generation, and if a recipe throws the material degrades to
 * a plain grey standard material rather than taking the game down.
 *
 * Public API (contract — other agents depend on this):
 *   get(name)                        -> THREE.Material   (cached, shared)
 *   getTiled(name, repeatX, repeatY) -> THREE.Material   (cached variant)
 *   texture(name, opts)              -> THREE.Texture
 *   envMap                           -> THREE.Texture    (set by lighting)
 *   applyEnvMap(envTexture)          -> re-binds env on every cached material
 *   names                            -> string[]
 */

/* ─────────────────────────────── specs ─────────────────────────────── */

const SPEC = {
  // 2048 where the player's face will be pressed against it
  concrete: {
    size: 2048, seed: 0x51c0, normalScale: 1.0, env: 1.0,
    metersPerTile: 3.2, aoIntensity: 1.0,
  },
  asphalt: {
    size: 2048, seed: 0x0a5f, normalScale: 1.0, env: 0.9,
    metersPerTile: 3.0, aoIntensity: 1.0,
    physical: { clearcoat: 0.22, clearcoatRoughness: 0.58, sheen: 0 },
  },

  rustMetal: { size: 1024, seed: 0x1b57, normalScale: 1.15, env: 1.15, metersPerTile: 1.6 },
  paintedMetal: { size: 1024, seed: 0x2c11, normalScale: 0.85, env: 1.0, metersPerTile: 1.8 },
  corrugatedMetal: { size: 1024, seed: 0x3d92, normalScale: 1.0, env: 1.05, metersPerTile: 2.4 },

  /**
   * metersPerTile 0.38, not 0.85. The recipe lays 30 hessian threads across one tile;
   * at 0.85 m that is a 28 mm weave knot, and a 50 cm bag showed ~18 of them — the
   * review read the whole barricade as knitted wool. 0.38 m puts the knot at ~12.5 mm,
   * which is woven polypropylene at the right scale, and incidentally means adjacent
   * bags (which share one merged mesh and one box UV projection) land on different
   * parts of the recipe's bag-scale tone/hue/damp fields.
   */
  sandbags: { size: 1024, seed: 0x4e08, normalScale: 1.15, env: 0.7, metersPerTile: 0.38 },
  wood: { size: 1024, seed: 0x5f31, normalScale: 1.05, env: 0.8, metersPerTile: 2.2 },
  plaster: { size: 1024, seed: 0x6a44, normalScale: 0.9, env: 0.9, metersPerTile: 2.8 },
  brick: { size: 1024, seed: 0x7b19, normalScale: 1.1, env: 0.9, metersPerTile: 2.0 },
  gravel: { size: 1024, seed: 0x8c26, normalScale: 1.2, env: 0.8, metersPerTile: 1.4 },
  rubber: { size: 1024, seed: 0x9d73, normalScale: 1.0, env: 0.85, metersPerTile: 1.0 },

  fabric: {
    size: 1024, seed: 0xae55, normalScale: 1.1, env: 0.7, metersPerTile: 1.2,
    physical: { sheen: 0.45, sheenRoughness: 0.85, sheenColor: 0x6a6a58 },
  },
  tarp: {
    size: 1024, seed: 0xbf62, normalScale: 1.0, env: 0.9, metersPerTile: 2.6,
    physical: { sheen: 0.28, sheenRoughness: 0.6, sheenColor: 0x8a8f84, side: THREE.DoubleSide },
  },
  glass: {
    size: 512, seed: 0xc084, normalScale: 0.4, env: 1.3, metersPerTile: 2.0,
    physical: {
      transmission: 0.92, thickness: 0.06, ior: 1.52,
      clearcoat: 0.35, clearcoatRoughness: 0.08,
      side: THREE.DoubleSide, transparent: false, depthWrite: true,
      attenuationDistance: 3.5, attenuationColor: 0xdfe8e4,
    },
  },
};

/* Aliases so a typo'd or legacy name still returns something sane. */
const ALIAS = {
  metal: 'rustMetal',
  steel: 'rustMetal',
  paintedmetal: 'paintedMetal',
  corrugated: 'corrugatedMetal',
  dirt: 'gravel',
  sand: 'gravel',
  canvas: 'fabric',
  burlap: 'sandbags',
  window: 'glass',
  stucco: 'plaster',
  wall: 'concrete',
  floor: 'concrete',
  road: 'asphalt',
  tarpaulin: 'tarp',
};

const FALLBACK_COLOR = {
  concrete: 0x8b8880, asphalt: 0x1c1d1f, rustMetal: 0x6a4a32, paintedMetal: 0x39402e,
  corrugatedMetal: 0x7d838a, sandbags: 0x8b7a55, wood: 0x574434, plaster: 0x9d9689,
  brick: 0x7a4034, gravel: 0x59544b, rubber: 0x151516, fabric: 0x3a3d30,
  tarp: 0x3b423a, glass: 0xa9b6b4,
};

/* ─────────────────────────────── system ─────────────────────────────── */

export class MaterialSystem {
  static id = 'materials';
  static order = 5;

  constructor(ctx) {
    this.ctx = ctx;
    this.envMap = null;
    this.envIntensityScale = 1.0;

    this._maps = new Map();      // name -> { albedo, normal, orm } THREE.Textures
    this._mats = new Map();      // cacheKey -> THREE.Material
    this._raw = new Map();       // name -> { width, height } bookkeeping
    this._bytes = 0;
    this._workers = [];
    this._disposed = false;

    this.names = Object.keys(SPEC);
  }

  /* ───────────────────────────── init ───────────────────────────── */

  async init(onProgress = () => {}) {
    const renderer = this.ctx.renderer;
    this.maxAnisotropy = 8;
    try {
      this.maxAnisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy() || 8);
    } catch (e) { /* keep default */ }
    this.detailAnisotropy = Math.max(2, Math.min(8, this.maxAnisotropy));

    const jobs = this.names.map((name) => ({
      name, size: SPEC[name].size, seed: SPEC[name].seed,
    }));

    const total = jobs.length;
    let done = 0;
    const t0 = performance.now();

    const workers = this._spawnWorkers(Math.min(6, total));
    const queue = jobs.slice();

    const runner = async (worker) => {
      while (queue.length && !this._disposed) {
        const job = queue.shift();
        let res = null;
        if (worker) {
          try {
            res = await this._dispatch(worker, job);
          } catch (err) {
            console.warn(`[materials] worker build failed for "${job.name}" — falling back:`, err);
            res = null;
          }
        }
        if (!res) {
          try {
            res = buildMaterialMaps(job.name, job.size, job.seed);
          } catch (err) {
            console.error(`[materials] recipe "${job.name}" threw:`, err);
          }
        }
        try {
          if (res) this._install(job.name, res);
          else this._installFallback(job.name);
        } catch (err) {
          console.error(`[materials] install "${job.name}" failed:`, err);
          this._installFallback(job.name);
        }
        done++;
        onProgress(done / total, `materials · ${job.name}`);
        // Yield so the loading bar repaints and the browser never blocks.
        await new Promise((r) => setTimeout(r));
      }
    };

    const workerCount = workers.length;
    const lanes = workers.length ? workers.slice() : [null];
    try {
      await Promise.all(lanes.map(runner));
    } catch (err) {
      console.error('[materials] generation pipeline error:', err);
    }

    // Anything left over (disposed mid-flight, or a lane died) gets a fallback so
    // get() never returns undefined.
    for (const name of this.names) {
      if (!this._maps.has(name)) this._installFallback(name);
    }

    this._terminateWorkers();

    const mb = (this._bytes / (1024 * 1024)).toFixed(1);
    console.log(
      `[materials] ${total} materials · ${mb} MB texture memory (incl. mips) · ` +
      `${Math.round(performance.now() - t0)} ms · aniso ${this.maxAnisotropy}/${this.detailAnisotropy} · ` +
      `${workerCount} worker${workerCount === 1 ? '' : 's'}`,
    );
    onProgress(1, 'materials');
  }

  _spawnWorkers(n) {
    const out = [];
    let want = n;
    try {
      const hc = navigator.hardwareConcurrency || 4;
      want = Math.max(1, Math.min(n, hc - 1));
    } catch (e) { want = Math.min(n, 3); }
    for (let i = 0; i < want; i++) {
      try {
        const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        out.push(w);
      } catch (err) {
        if (i === 0) console.warn('[materials] worker pool unavailable, building on main thread:', err);
        break;
      }
    }
    this._workers = out;
    return out;
  }

  _terminateWorkers() {
    for (const w of this._workers) { try { w.terminate(); } catch (e) { /* ignore */ } }
    this._workers.length = 0;
  }

  _dispatch(worker, job) {
    return new Promise((resolve, reject) => {
      const jobId = `${job.name}:${Math.random().toString(36).slice(2)}`;
      let settled = false;
      const cleanup = () => {
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
        clearTimeout(timer);
      };
      const onMsg = (e) => {
        const d = e.data;
        if (!d || d.jobId !== jobId) return;
        settled = true; cleanup();
        if (d.ok) resolve(d); else reject(new Error(d.error || 'worker error'));
      };
      const onErr = (e) => {
        if (settled) return;
        settled = true; cleanup();
        reject(new Error(e.message || 'worker crashed'));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true; cleanup();
        reject(new Error('worker timeout'));
      }, 25000);
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', onErr);
      worker.postMessage({ jobId, name: job.name, size: job.size, seed: job.seed });
    });
  }

  /* ───────────────────────── texture plumbing ───────────────────────── */

  /**
   * `aniso` is per-map on purpose.
   *
   * Anisotropic filtering costs up to N taps per fetch, and the yard is viewed at
   * a grazing angle across most of the frame, so every map runs at the maximum tap
   * count for most of the screen. The surface layer in surface.js re-fetches the
   * NORMAL map a second time for its detail band, which made the normal map the
   * single most expensive texture in the frame at 16x.
   *
   * Albedo keeps the full 16 — that is where a grazing-angle blur is actually
   * visible as mush. Normal and ORM drop to 8: at a grazing angle their content is
   * sub-pixel anyway, the difference is invisible on inspection, and it halves the
   * tap count on two thirds of the fetches (four of them once the detail layer is
   * counted). Measured: ~4 fps back at 1080p in the overwatch framing.
   */
  _makeTexture(data, w, h, srgb, aniso) {
    const tex = new THREE.DataTexture(
      data instanceof Uint8Array ? data : new Uint8Array(data),
      w, h, THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = aniso ?? this.maxAnisotropy;
    tex.channel = 0;                 // aoMap must read uv0, not uv1
    tex.needsUpdate = true;
    this._bytes += w * h * 4 * 1.34;
    return tex;
  }

  _install(name, res) {
    const w = res.width, h = res.height;
    const maps = {
      albedo: this._makeTexture(res.albedo, w, h, true),
      normal: this._makeTexture(res.normal, w, h, false, this.detailAnisotropy),
      orm: this._makeTexture(res.orm, w, h, false, this.detailAnisotropy),
    };
    maps.albedo.name = `${name}_albedo`;
    maps.normal.name = `${name}_normal`;
    maps.orm.name = `${name}_orm`;
    this._maps.set(name, maps);
    this._raw.set(name, { width: w, height: h });
    // Build (and cache) the 1:1 material eagerly so order-8 level construction
    // never pays a hitch.
    this._buildMaterial(name, 1, 1);
  }

  _installFallback(name) {
    if (this._maps.has(name)) return;
    this._maps.set(name, null);
    const key = `${name}@1x1`;
    if (this._mats.has(key)) return;
    const mat = new THREE.MeshStandardMaterial({
      color: FALLBACK_COLOR[name] ?? 0x8a8a8a,
      roughness: 0.85,
      metalness: name === 'rustMetal' || name === 'corrugatedMetal' ? 0.6 : 0.0,
    });
    mat.name = `${name}_fallback`;
    if (this.envMap) { mat.envMap = this.envMap; mat.envMapIntensity = 1; }
    this._mats.set(key, mat);
  }

  _cloneFor(name, rx, ry) {
    const maps = this._maps.get(name);
    if (!maps) return null;
    if (rx === 1 && ry === 1) {
      maps.albedo.repeat.set(1, 1);
      maps.normal.repeat.set(1, 1);
      maps.orm.repeat.set(1, 1);
      return maps;
    }
    // clone() shares Texture.source, so the GPU upload is shared — only the
    // repeat uniform differs. Tiled variants are effectively free.
    const a = maps.albedo.clone();
    const n = maps.normal.clone();
    const o = maps.orm.clone();
    for (const t of [a, n, o]) {
      t.repeat.set(rx, ry);
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.channel = 0;
      t.needsUpdate = true;
    }
    // preserve the per-map anisotropy split — clone() copies it, but be explicit
    a.anisotropy = this.maxAnisotropy;
    n.anisotropy = this.detailAnisotropy;
    o.anisotropy = this.detailAnisotropy;
    a.colorSpace = THREE.SRGBColorSpace;
    n.colorSpace = THREE.NoColorSpace;
    o.colorSpace = THREE.NoColorSpace;
    return { albedo: a, normal: n, orm: o };
  }

  _buildMaterial(name, rx, ry) {
    const key = `${name}@${rx}x${ry}`;
    const cached = this._mats.get(key);
    if (cached) return cached;

    const spec = SPEC[name] ?? {};
    const maps = this._cloneFor(name, rx, ry);
    if (!maps) {
      this._installFallback(name);
      const fb = this._mats.get(`${name}@1x1`);
      if (rx !== 1 || ry !== 1) {
        const c = fb.clone();
        this._mats.set(key, c);
        return c;
      }
      return fb;
    }

    const common = {
      map: maps.albedo,
      normalMap: maps.normal,
      normalScale: new THREE.Vector2(spec.normalScale ?? 1, spec.normalScale ?? 1),
      roughnessMap: maps.orm,
      metalnessMap: maps.orm,
      aoMap: maps.orm,
      aoMapIntensity: spec.aoIntensity ?? 1.0,
      // maps are authoritative — keep the scalar multipliers at 1
      roughness: 1.0,
      metalness: 1.0,
      color: 0xffffff,
      dithering: true,
    };

    let mat;
    if (spec.physical) {
      mat = new MtlPhysicalMaterial({ ...common, ...spec.physical });
    } else {
      mat = new MtlStandardMaterial(common);
    }
    mat.name = `${name}@${rx}x${ry}`;
    mat.envMapIntensity = (spec.env ?? 1.0) * this.envIntensityScale;
    if (this.envMap) mat.envMap = this.envMap;
    mat.userData.materialName = name;
    mat.userData.repeat = [rx, ry];
    mat.userData.metersPerTile = spec.metersPerTile ?? 2.0;
    /**
     * The surface-response config rides in userData because `Material.copy()` deep-
     * copies userData and does NOT copy `onBeforeCompile` — see the long note at the
     * top of surface.js. Every consumer of this library clones, so anything the
     * shader stage needs has to survive a clone or it silently does not ship.
     */
    mat.userData.mtl = packSurface(name);

    this._mats.set(key, mat);
    return mat;
  }

  /* ─────────────────────────── public API ─────────────────────────── */

  _resolve(name) {
    if (SPEC[name]) return name;
    const a = ALIAS[name] ?? ALIAS[String(name).toLowerCase()];
    if (a) return a;
    return 'concrete';
  }

  /** Cached, shared material at 1:1 tiling. */
  get(name) {
    const n = this._resolve(name);
    return this._mats.get(`${n}@1x1`) ?? this._buildMaterial(n, 1, 1);
  }

  /** Cached variant with a different UV repeat. Texture memory is shared. */
  getTiled(name, repeatX = 1, repeatY = repeatX) {
    const n = this._resolve(name);
    const rx = Math.max(0.01, Math.round(repeatX * 100) / 100);
    const ry = Math.max(0.01, Math.round(repeatY * 100) / 100);
    return this._buildMaterial(n, rx, ry);
  }

  /**
   * Convenience for surfaces authored in metres: returns a material whose texture
   * repeats at its natural real-world scale over a `wide × high` metre face.
   */
  getForSize(name, wide, high) {
    const n = this._resolve(name);
    const mpt = SPEC[n]?.metersPerTile ?? 2.0;
    return this.getTiled(n, Math.max(0.25, wide / mpt), Math.max(0.25, high / mpt));
  }

  /**
   * texture(name, { map:'albedo'|'normal'|'orm', repeat:[x,y]|number, anisotropy })
   */
  texture(name, opts = {}) {
    const n = this._resolve(name);
    const maps = this._maps.get(n);
    if (!maps) return null;
    const which = opts.map ?? opts.type ?? 'albedo';
    const base = maps[which] ?? maps.albedo;
    let rx = 1, ry = 1;
    if (Array.isArray(opts.repeat)) { rx = opts.repeat[0]; ry = opts.repeat[1]; }
    else if (typeof opts.repeat === 'number') { rx = ry = opts.repeat; }
    if (rx === 1 && ry === 1 && opts.anisotropy == null) return base;
    const t = base.clone();
    t.repeat.set(rx, ry);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = base.colorSpace;
    t.anisotropy = opts.anisotropy ?? this.maxAnisotropy;
    t.channel = 0;
    t.needsUpdate = true;
    return t;
  }

  /** Metadata other systems can query (impact decals, footstep audio, etc). */
  info(name) {
    const n = this._resolve(name);
    const spec = SPEC[n] ?? {};
    const raw = this._raw.get(n);
    return {
      name: n,
      size: raw ? raw.width : (spec.size ?? 0),
      metersPerTile: spec.metersPerTile ?? 2.0,
      physical: !!spec.physical,
      ok: !!this._maps.get(n),
    };
  }

  /**
   * Called by the lighting system once the PMREM environment exists. Walks every
   * cached material (including tiled variants and fallbacks) and re-binds it.
   */
  applyEnvMap(envTexture, intensityScale = 1.0) {
    this.envMap = envTexture ?? null;
    this.envIntensityScale = intensityScale;
    let n = 0;
    for (const mat of this._mats.values()) {
      if (!mat) continue;
      try {
        const name = mat.userData?.materialName;
        const spec = name ? SPEC[name] : null;
        mat.envMap = this.envMap;
        mat.envMapIntensity = (spec?.env ?? 1.0) * intensityScale;
        mat.needsUpdate = true;
        n++;
      } catch (err) {
        console.warn('[materials] applyEnvMap failed on', mat?.name, err);
      }
    }
    return n;
  }

  /**
   * Debug/critic helper: a grid of lit quads showing every material. Not used by
   * the game — add it to a scene manually if you want to eyeball the library.
   */
  debugPreview(tileSize = 1.6, cols = 5) {
    const group = new THREE.Group();
    const geo = new THREE.PlaneGeometry(tileSize, tileSize, 1, 1);
    this.names.forEach((name, i) => {
      const m = new THREE.Mesh(geo, this.get(name));
      m.position.set(
        (i % cols) * tileSize * 1.08,
        -Math.floor(i / cols) * tileSize * 1.08,
        0,
      );
      m.name = `preview_${name}`;
      group.add(m);
    });
    return group;
  }

  update() { /* materials are static — nothing per-frame */ }

  dispose() {
    this._disposed = true;
    this._terminateWorkers();
    for (const mat of this._mats.values()) { try { mat.dispose(); } catch (e) { /* ignore */ } }
    for (const maps of this._maps.values()) {
      if (!maps) continue;
      for (const t of Object.values(maps)) { try { t.dispose(); } catch (e) { /* ignore */ } }
    }
    this._mats.clear();
    this._maps.clear();
  }
}

export { RECIPE_NAMES };
export default MaterialSystem;
