# OPERATION BLACKOUT — Build Contract

**Read this fully before writing a single line.** You are one of eleven agents building
one game in parallel. The only thing preventing you from destroying each other's work is
this document. Obey it exactly.

Target: a contemporary-military FPS in Three.js that looks like a *AAA* product — the
best-looking thing that has ever run in a browser tab. Art direction is **Modern Warfare
realism**: overcast dusk, low warm sun, cool desaturated shadows, heavy atmospheric
haze, sodium-vapour practicals, grounded and gritty. No neon. No stylisation. No "web
demo" pastel gradients.

---

## 1. Hard rules

1. **Only edit files inside the directory you own** (section 3). Touching another
   agent's file destroys their parallel work. There are zero exceptions.
2. **Never edit** `src/core/**`, `index.html`, `vite.config.js`, `ARCHITECTURE.md`.
   Those are fixed. Read them, build against them.
3. **The app must boot at all times.** If your module throws, the whole game is black
   and every other agent is blocked. Guard risky work in try/catch and degrade
   gracefully rather than throwing.
4. **No external asset downloads.** No CDN fetches, no `.glb`/`.hdr`/`.jpg` URLs, no
   npm installs. A strict-offline machine must run this. Everything is generated in
   code — procedural textures, procedural geometry, procedural audio. This is a
   constraint that *forces* quality: you will write real texture synthesis rather than
   pasting a placeholder.
5. **Only these dependencies exist**: `three` (r185), `@dimforge/rapier3d-compat`.
   Import three as `import * as THREE from 'three'`. Addons come from
   `three/examples/jsm/...` — verify the path exists in `node_modules` before relying
   on it.
6. **Performance budget: 60fps at 1920×1080 on an Apple M4 Pro.** Beautiful at 20fps
   is a failure. Measure, don't assume.
7. Write real code. No `// TODO: implement lighting later`. If it's in your scope, it
   ships finished.

## 2. The system contract

Every module exports one class from its `index.js`:

```js
export class MySystem {
  static id = 'mySystem';        // becomes ctx.mySystem
  static order = 50;             // update order band, see below
  constructor(ctx) { this.ctx = ctx; }
  async init(onProgress) {}      // await your setup; onProgress(0..1, 'label')
  fixedUpdate(fdt) {}            // optional — 60Hz fixed step
  update(dt, elapsed) {}         // per frame
  resize(w, h) {}                // optional
  dispose() {}
}
```

Update order bands (already assigned, do not change):

| order | system | id |
|---|---|---|
| 5  | materials | `materials` |
| 8  | level | `level` |
| 10 | physics | `physics` |
| 20 | player | `player` |
| 30 | ai | `ai` |
| 40 | weapons | `weapons` |
| 50 | fx | `fx` |
| 60 | audio | `audio` |
| 70 | lighting | `lighting` |
| 80 | hud | `hud` |
| 90 | render | `render` |

`ctx` gives you: `THREE, engine, config, renderer, scene, camera, viewmodelScene,
viewmodelCamera, events, input, systems`, plus every system by id once registered.
Because of the order table you may assume anything with a *lower* order is already
constructed and initialised when your `init()` runs.

## 3. File ownership — YOU OWN ONLY YOUR ROW

| agent | owns | must export |
|---|---|---|
| **materials** | `src/materials/**` | `MaterialSystem` |
| **level** | `src/level/**` | `LevelSystem` |
| **physics** | `src/physics/**` | `PhysicsSystem` |
| **player** | `src/player/**` | `PlayerSystem` |
| **ai** | `src/ai/**` | `AISystem` |
| **weapons** | `src/weapons/**` | `WeaponSystem` |
| **fx** | `src/fx/**` | `FXSystem` |
| **audio** | `src/audio/**` | `AudioSystem` |
| **hud** | `src/ui/**` | `HUDSystem` |
| **lighting** | `src/lighting/**` | `LightingSystem` |
| **render** | `src/render/**` | `RenderSystem` |

Each directory must have an `index.js` that exports the named class. Split into as many
internal files as you like *inside your own directory*.

## 4. Cross-system API you may rely on

These are guaranteed. Call them; do not reimplement them.

**materials** (`ctx.materials`)
```js
get(name) -> THREE.Material    // 'concrete','rustMetal','asphalt','sandbags','wood',
                               // 'glass','rubber','paintedMetal','fabric','plaster'
texture(name, opts) -> THREE.Texture
envMap -> THREE.Texture        // PMREM environment, set by lighting, read by all
```

**physics** (`ctx.physics`)
```js
world                           // RAPIER.World
addStaticMesh(mesh)             // trimesh collider from a THREE.Mesh
addBox(size, pos, quat, opts)   // -> { body, collider }
addCapsule(halfHeight, radius, pos, opts)
raycast(origin, dir, maxDist, filter) -> { point, normal, distance, collider, actor } | null
addDynamicFromMesh(mesh, opts)  // debris, physicalised props
step(dt)                        // called by the system itself, do not call
```

**player** (`ctx.player`)
```js
position -> THREE.Vector3       // feet position
eyePosition -> THREE.Vector3
velocity -> THREE.Vector3
isSprinting, isCrouching, isADS, isGrounded -> boolean
health -> number
applyDamage(amount, fromPosition)
addRecoil(pitch, yaw)           // weapons call this — camera-space kick
```

**weapons** (`ctx.weapons`)
```js
current -> { id, name, ammo, magSize, reserve, rpm, damage, ... }
isFiring, isReloading -> boolean
```

**fx** (`ctx.fx`)
```js
spawnImpact(point, normal, materialName)
spawnTracer(from, to, speed)
spawnMuzzleFlash(matrix, scale)
spawnBloodHit(point, normal)
addDecal(point, normal, size, type)
```

**audio** (`ctx.audio`)
```js
play(id, { position, volume, pitch }) // ids: 'rifle_fire','smg_fire','reload_mag_out',
                                      // 'reload_mag_in','reload_charge','impact_concrete',
                                      // 'impact_metal','impact_dirt','footstep','bullet_whiz',
                                      // 'hitmarker','death','empty_click'
```

**lighting** (`ctx.lighting`)
```js
sun -> THREE.DirectionalLight
csm -> cascaded shadow controller (has .update(camera))
addPractical(position, color, intensity, radius)   // register a local light
```

**render** (`ctx.render`)
```js
// Owns the final composite. Reads scene + camera + viewmodelScene each frame.
// Other systems may set: ctx.render.setVelocityDirty() when teleporting the camera
// (prevents TAA/motion-blur smearing on respawn).
```

**Events** — canonical names are documented in `src/core/EventBus.js`. Use exactly
those names and payload shapes. Emitting `'weapon:fired'` instead of `'weapon:fire'`
silently breaks three other systems.

## 5. Visual quality bar

You are being reviewed by a deliberately harsh critic agent that screenshots the game
and compares it against real Modern Warfare reference. Things that get you sent back:

- Flat, evenly-lit surfaces. Real environments have **light falloff, occlusion contact
  darkening, and directional bias**.
- Untextured or single-colour materials. Everything needs albedo variation, normal
  detail, and roughness variation. **Roughness variation is the single biggest tell**
  between amateur and AAA rendering — real surfaces are never uniformly rough.
- Perfectly straight, perfectly clean geometry. Add wear, edge damage, sag, asymmetry.
- Objects that look like they're floating — every prop needs contact shadow / AO
  grounding.
- Pure black shadows or blown-out white highlights. Keep it in filmic range.
- Saturated primary colours. The palette is desaturated: greys, olive, tan, rust,
  with warm practicals as the only saturated accent.
- 90° corners everywhere with no bevel. Bevelled edges catch light and read as solid.

## 6. Verify before you claim done

Run the dev server and confirm your module works:

```bash
cd ~/threejs-fps && npx vite --port 5173
```

There is a headless screenshot harness at `tools/shoot.mjs`:

```bash
node tools/shoot.mjs --out /tmp/shot.png --wait 6000
```

If it errors, read the console output it prints — it forwards page errors. **A module
that logs an error to the browser console is not done.**

---

# INTEGRATION NOTES FROM PHASE A — READ THIS, IT WILL SAVE YOU HOURS

The materials / lighting / render / physics systems are **built and working**. These are
the hard-won facts they discovered. Violating any of them causes silent, hard-to-debug
breakage.

## Materials — tiling is not optional

`ctx.materials.get(name)` returns a **1:1 tiling** variant. Calling it on anything larger
than ~2m stretches a single texture tile across the whole surface and looks catastrophic.

```js
ctx.materials.getForSize('concrete', widthMetres, heightMetres)  // ← use this
ctx.materials.getTiled('concrete', repeatX, repeatY)
ctx.materials.info('concrete').metersPerTile
```

- `roughnessMap`, `metalnessMap` and `aoMap` all point at the **same packed ORM texture**
  (R=AO, G=roughness, B=metalness). Swap all three or none.
- Unknown names fall back to `concrete` with a console warning rather than throwing.
- Do not promote materials to 2048² — only concrete and asphalt are, and texture memory
  is already 309MB of a ~450MB budget.

## Lighting — CSM registration is mandatory for every new lit material

**This is the single most dangerous gotcha in the project.** A lit material that has not
been through CSM setup takes the non-CSM shader branch and receives **all four cascade
lights at full intensity — 4× overexposed.**

After creating any mesh with a lit material, register it:

```js
ctx.lighting.registerMaterial(mesh.material);   // or ctx.lighting.csm.setupMaterial(mat)
```

The lighting system runs a self-healing registry that sweeps the scene, but register
explicitly — do not rely on the sweep for materials you create at runtime.

Also:
- `renderer.shadowMap.autoUpdate` is **false**. Lighting sets `needsUpdate` once per frame
  at order 70. Do not render the scene before that or you get a stale shadow map.
- Lighting **globally replaces the fog ShaderChunks** at init. Do not patch fog chunks and
  do not assume stock `FogExp2` maths.
- Practicals are **shadowless** by design (8 cube shadow maps is unaffordable). Do not
  expect local lights to cast.
- Never set `PCFSoftShadowMap` anywhere — deprecated in r185, silently downgrades and
  forces a full recompile.

## Physics — three conventions that will bite you

1. **Colliders are invisible to `raycast()` until the next `world.step()`.** Rapier only
   rebuilds query structures inside `step()`. Spawn, then wait a tick, then raycast.
2. **`addCapsule(halfHeight, radius)` — `halfHeight` excludes the caps.** Total height is
   `2 * (halfHeight + radius)`. For a 1.75m player at radius 0.34, halfHeight ≈ 0.535.
3. **AI doing many line-of-sight checks must pass `{ reuse: true }`** to `raycast()` to get
   a shared result object and avoid allocating hundreds of objects per frame. Use
   `ctx.physics.hasLineOfSight(a, b)` where it fits.

`spawnDebris()` caps at 190 global / 56 per material and **returns the actual count**
spawned — do not assume every requested chunk exists.

## Render — what the pipeline will and will not composite

- The render system composites **`ctx.scene` and `ctx.viewmodelScene` only**, and renders
  last to the canvas. **HUD must be DOM/CSS**, not a THREE.Scene. If you render HUD through
  Three it will not appear at all.
- Objects that are `transparent`, `depthWrite:false`, or `Points`/`Line`/`Sprite` are
  **excluded from the G-buffer** (correct — they would poison normals and velocity). They
  therefore receive **no AO, no SSR, no motion vectors, and are not TAA-reprojected**.
  Particles and decals will alias more than opaque geometry. Design around it: prefer
  opaque alpha-tested decals over transparent ones where it matters.
- Dynamic objects get **camera-only motion vectors**. Very fast local motion (a sprinting
  bot crossing frame) may ghost slightly. Keep bot movement smooth.
- Call `ctx.render.setVelocityDirty()` on any camera teleport (respawn, pose change) or TAA
  will smear across the cut.

## Known open defects (Phase A agents flagged these; fixes are in flight)

- Scene is over-bright / milky rather than dusk — fog colour resolving too high.
- Cast shadows are *functionally correct* (proven by HDR readback: occluder drops ground
  radiance 0.39 → 0.17) but visually washed out by the above.
- Chromatic aberration amplifies sub-pixel shimmer at grazing angles along the near ground
  edge.

**Do not "fix" these yourself** — the lighting and render agents are correcting them in the
same batch you are running in. Build your content assuming a properly-exposed dusk scene.
