# Handoff Notes — Operation Blackout

Orientation for a new agent session picking this project up cold. Read this, then
`ARCHITECTURE.md`, before touching code.

---

## Coordinates

| | |
|---|---|
| **Local path** | `/Users/rushindrasinha/threejs-fps` |
| **Repo** | `https://github.com/rushindrasinha/operation-blackout` (**private**) |
| **Clone** | `gh repo clone rushindrasinha/operation-blackout` |
| **Branch** | `master` (not `main`) |
| **Machine** | Apple M4 Pro, Metal 4, macOS. All perf numbers are from this box. |

```bash
cd /Users/rushindrasinha/threejs-fps
npm install
npm run dev            # http://localhost:5173 — click Deploy to lock pointer
```

---

## State as of handoff

Complete and playable. Three commits. Nothing in flight, no half-finished work.

- **~44,000 lines**, 11 systems, 2 runtime dependencies (`three` r185, `@dimforge/rapier3d-compat`)
- **59–72 fps** at 1920×1080 on a quiet machine, ~350 draw calls, 4.4M triangles
- **Zero external assets** — no images, models, audio files, or network calls. Boots offline.
- **Graded 6.2/10 (56/90)** against `VISUAL_BAR.md`, which it fails (needs every axis ≥7;
  geometry and viewmodel sit at 5)
- Audit clean: no secrets, 0 TODOs, 0 `debugger`, 1 `console.log`, build passes
- `npm run test:physics` guards the one bug that ever killed a live session (see `CHANGELOG.md` 1.0.1)
- Verified self-contained: cloned fresh, `npm ci`, built, and ran at 64 fps

---

## The four things that will waste your time if you don't know them

These are real landmines discovered during the build. Each one cost hours.

### 1. Register every lit material with CSM
```js
ctx.lighting.registerMaterial(mesh.material);
```
A lit material that skips this takes the non-CSM shader branch and receives **all four
cascade lights at full intensity — 4× overexposed**. If you create a mesh at runtime and it
comes out blown white, this is why. There is a self-healing sweep but do not rely on it.

### 2. Never call bare `materials.get()` on a large surface
`get(name)` returns a **1:1 tiling** variant. On a 24 m wall it stretches one texture tile
across the whole thing and looks catastrophic.
```js
ctx.materials.getForSize('concrete', widthMetres, heightMetres);   // use this
ctx.materials.getTiled('concrete', repeatX, repeatY);
```
Also: `roughnessMap`, `metalnessMap` and `aoMap` all point at the **same packed ORM texture**
(R=AO, G=roughness, B=metalness). Swap all three or none.

### 3. The HUD must be DOM, not Three.js
The render system composites **only** `ctx.scene` and `ctx.viewmodelScene`. Anything drawn
through a third `THREE.Scene` will silently never appear.

### 4. Never let a non-finite float reach Rapier
One NaN in a position, velocity or impulse panics Rust inside `world.step()`. The panic
unwinds out of wasm still holding the World's borrow, so **every later Rapier call throws
forever** — the game keeps rendering at full framerate while bullets stop registering and
bots go blind. Use the safe setters (`physics.setLinvel` / `setAngvel` / `applyImpulse` /
`setTranslation`), never the raw body methods.

Watch for guards that cannot catch what they guard against: `NaN > 16` is `false` and
`Math.max(1e-3, NaN)` is `NaN`, so magnitude tests and clamps both let NaN through. Test
`Number.isFinite` explicitly. Verify with `npm run test:physics`.

### 5. Rapier colliders are invisible to raycasts until the next `step()`
Rapier only rebuilds query structures inside `world.step()`. Spawn, wait a tick, then
raycast. Also `addCapsule(halfHeight, radius)` — `halfHeight` **excludes** the caps, so total
height is `2 * (halfHeight + radius)`.

---

## Testing and verification

```bash
node tools/shoot.mjs --out shot.png --pose warehouse --wait 32000
```

Poses: `spawn`, `overwatch`, `warehouse`, `lane`, `closeup`.

**Rules for the harness, learned the hard way:**

- **Do not pass `--port`.** It starts a private, cold, `--force` Vite server per invocation
  and kills it after. This exists because reusing a shared server served **stale module
  transforms** — an agent once spent an hour tuning against code that was no longer running.
- **Exit code matters.** Non-zero means the page threw; it prints the errors. A screenshot
  alone is not proof the build works.
- **Read the PNG back and look at it.** "It screenshotted" ≠ "it looks right".
- **Never trust fps measured while other work is running.** GPU contention swings the same
  code between 4 and 76 fps. Check `uptime` first; if load average is above ~5, the number is
  meaningless. The sampler already excludes the ~3 s shader-compile warmup and reports
  `p5Fps`, `warmupMs` and `measuredFrames` alongside `fps`.

**The harness cannot test gameplay.** Headless Chromium refuses pointer lock, and input is
gated on `input.locked`. For gameplay QA, drive the page with Playwright directly and call
engine APIs via `window.__ENGINE__`. Note the aiming convention is `Math.atan2(-dx, -dz)` —
one QA agent used `atan2(dx, dz)`, fired 180° away from every target, and nearly filed a
false "damage does not register" P0.

**Useful runtime hooks** (all on `window`):
- `__ENGINE__` — the live Engine; `__ENGINE__.ctx.<systemId>` reaches any system
- `__PERF__()` — fps, p5Fps, drawCalls, triangles, warmupMs
- `__POSE__('warehouse')` — teleport the camera to a named pose
- `__READY__` — true once init completes

---

## Where to work

Directory ownership is strict — it is what let 11 agents build in parallel. Keep it.

| edit this | for |
|---|---|
| `src/materials/` | textures, PBR material definitions |
| `src/level/` | map geometry, props, spawn points, tiling choices |
| `src/physics/` | Rapier, colliders, raycasts, debris |
| `src/player/` | movement, camera, stance, recoil response |
| `src/ai/` | soldier rigs, animation, navigation, behaviour |
| `src/weapons/` | viewmodel, ballistics, recoil, hands |
| `src/fx/` | impacts, decals, particles, tracers |
| `src/audio/` | procedural synthesis, spatialisation |
| `src/lighting/` | sky, IBL, CSM, fog, practicals |
| `src/ui/` | DOM HUD |
| `src/render/` | G-buffer, post stack, tonemapping |

**Do not edit** `src/core/**` (Engine, Config, EventBus, Input), `index.html`,
`vite.config.js`, or `src/main.js` without a specific reason — everything is built against
them and they are treated as fixed.

Cross-system communication is `ctx.<systemId>` plus the event bus. Canonical event names are
documented at the top of `src/core/EventBus.js` — use them exactly. Emitting `weapon:fired`
instead of `weapon:fire` silently breaks three systems.

---

## Highest-value next work

Ranked. The first two are what the certification pass identified as the remaining gap.

1. **Geometry detail (scored 5/10).** Distant buildings are boxes with punched window
   openings — no reveals, no sills, no interiors. This is the largest visual deficit and it
   is straightforward, bounded work in `src/level/`.
2. **Viewmodel (scored 5/10).** The rifle buttstock is a plain prism occupying the
   bottom-right of every single frame — the least-detailed large surface in the game. The
   support hand reads as detached blocks rather than a hand wrapping the handguard.
3. **Shadow resolution.** 2048px across 4 cascades runs out at mid distance; warehouse
   roof-slat shadows read as smudges. Either raise the map size or retune the cascade splits.
4. **Bot balance.** Focus-fire kills a stationary player in ~2 s. Tune reaction delay,
   accuracy falloff, and how many bots may engage the same target simultaneously.
5. **`overwatch` at 59 fps** — 1 fps under target. The forward scene render dominates the
   frame (~10–11 ms of 17.4 ms); the entire post stack is only 3.1 ms, so **do not try to
   optimise post** — that was measured and it is not where the time goes.
6. **Code splitting.** One 3.74 MB chunk (1.29 MB gzipped).

Do **not** restart a broad "make it look better" critic loop. That was run for three rounds;
scores went 4.29 → 4.43 → 4.33 while triangles grew 4.7M → 6.5M and fps fell 82 → 52. It
plateaued and actively traded performance for detail. Targeted, named fixes worked; open-ended
critique did not.

---

## Context worth having

The project was built by parallel AI agents coordinated through `ARCHITECTURE.md` as a
written contract, then graded by adversarial critic agents against `VISUAL_BAR.md`. Both
files are in the repo and still accurate.

`ARCHITECTURE.md` has an **Integration Notes** section at the bottom capturing what the
foundation agents learned — read it before writing anything that touches lighting, materials
or physics.

`CHANGELOG.md` records root causes with measurements, not just "fixed lighting". If something
looks deliberately odd, check there first — several strange-looking constants are deliberate
corrections for measured defects. Two examples:

- Weapon albedos were being **sRGB-encoded twice** (`new THREE.Color(hex)` decodes to linear
  under ColorManagement, then that linear value was packed into a byte handed to an sRGB
  texture — 0.157 arrived as 0.021). Someone had compensated by cranking the viewmodel key to
  2.1× the world sun. Both the bug and the compensation are now gone.
- AO is **deliberately exaggerated beyond physical correctness**. A physically-correct GTAO
  integral is effectively invisible here — a 1 m crate removes only ~11% of the hemisphere.
  There is also a separate screen-space contact-shadow raymarch on the **direct** sun term,
  because ambient occlusion cannot darken under a crate that is lit by the sun.
