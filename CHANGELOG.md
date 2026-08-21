# Changelog

All notable changes to Operation Blackout.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project was built in a single intensive development run; entries below are grouped by
build phase rather than by calendar release.

---

## [1.0.1] — 2026-08-21

### Fixed

- **Physics could die permanently mid-session, silently.** Found by actually playing the
  game for a minute — no automated pass had caught it.

  A single non-finite float reaching Rapier panics the Rust side inside `world.step()`
  (`RuntimeError: unreachable`). That panic unwinds out of wasm **with the World still
  mutably borrowed**, so wasm-bindgen's `RefCell` is left locked and every subsequent
  Rapier call throws `recursive use of an object detected which would lead to unsafe
  aliasing in rust` for the rest of the session. Observed live: 1 panic → 13,445 raycast
  failures. The game kept rendering at full framerate while bullets stopped registering,
  the character controller fell back to raw integration, and bots went blind.

  Two pieces of code that looked like guards but could not catch the value they existed
  to catch:
  - `Ragdoll.clampVelocities()` tested `if (s > 16)` on `Math.hypot(...)`. **`NaN > 16` is
    `false`**, so a NaN velocity skipped the clamp and stayed in the body.
  - `PhysicsSystem.addBox()` used `Math.max(1e-3, sx * 0.5)`. **`Math.max(1e-3, NaN)` is
    `NaN`**, so a NaN extent passed straight through.
  - `_makeBody()` used `pos.x ?? 0`, and `??` only catches `null`/`undefined`, not `NaN`.

  Changes:
  - Added finite guards at the wasm boundary (`fnum`, `isFiniteVec3`, `safeVec3`,
    `safeQuat`, `safeExtent`) and applied them in `_makeBody`, `addBox`, and new safe
    setters `setLinvel` / `setAngvel` / `applyImpulse` / `setTranslation`
  - Added `_sweepNonFinite()`, run before every step, which quarantines any dynamic body
    whose position or velocity has diverged — the backstop for a NaN the solver itself
    produced rather than one we passed in
  - Fixed the NaN-permeable clamp and impulse path in `src/ai/Ragdoll.js`
  - Added poison detection: `physics.dead` latches, logs **once** with a plain-language
    diagnosis, and emits `physics:dead`. Previously the failure repeated 13,445 times,
    which was its own frame cost
  - Non-finite rejections warn once per call site instead of every frame

- Regression test added: `npm run test:physics` (`tools/test-physics-nan.mjs`) injects NaN
  into live dynamic bodies and asserts physics survives. **Verified to fail against the
  pre-fix tree**, so it genuinely discriminates rather than passing vacuously.

### Notes

- No performance change: 70 / 65 / 62 fps at spawn / warehouse / closeup, matching pre-fix.
- Two earlier hypotheses were wrong and are recorded here so nobody re-investigates them:
  the nested headshot-classification raycast in `ballistics.js` is **not** re-entrant
  (480 shots, 11,336 raycasts, zero failures), and no predicate callback throws.

---

## [1.0.0] — 2026-08-10

First complete build. Playable single-map arena FPS with bots, running at 59–72 fps at
1920×1080 on an Apple M4 Pro.

### Phase E — Defect repair

**Fixed**
- **Enemy soldiers rendered as incoherent dithered noise.** Root cause was neither
  transparency nor skinning (both falsified by ablation): normal maps were baked by
  differentiating height fields carrying most of their energy at or above texel Nyquist,
  with gains of 17–34. Measured median slope 5.34, p90 18.31 — at p90 the x channel lands on
  code 0 of 255, so the upper half of the distribution quantised onto ~2 codes. Mip-averaging
  normal *vectors* then produced specular aliasing static in surface space, which TAA agreed
  on every frame and never resolved.
  - Added `blurWrap()` band-limiting to every height field before differentiation
  - Normal gains 34/17/30 → 11.5/10.0/10.5 (median slope now 0.99, p90 3.32)
  - Added a per-vertex detail LOD resolving albedo to the map mean and normals to the
    geometric normal between 3.5 m and 12 m
  - Per-vertex mottle amplitude ±6% → ±2% (was baked per-pixel white noise at 3 verts/pixel)
  - Pouch tint 0.98 → 0.56 and carrier 0.90 → 0.78, so the kit reads as a dark band across
    the belly instead of dissolving into one pale symmetric slab — this is the front/back
    discriminator at distance
- **Double damage per round.** A single bullet registered two `hit:actor` events at identical
  distance. The penetration loop was re-entering the same rigid body, which carries both a
  1.72 m body capsule and a 0.135 m head ball sitting entirely inside it.

**Changed**
- Rifle buttstock rebuilt with butt-pad, cheek riser, sling point and bevelled edges
- Support hand rebuilt as one continuous hand wrapping the handguard, with thumb and knuckles

### Phase D — Consolidation

Performance had regressed from 82 fps / 4.7M triangles to 52 fps / 6.5M over three critic
rounds. This phase added no content.

**Performance**
- Triangles **6.5M → 4.4M**; draw calls **506 → ~350**; worst pose **52 → 59 fps**
- Level: LOD on distant structures, per-instance frustum and distance culling on 2,247
  scatter instances, static merging, small casters restricted to cascade 0
- Render: deleted the redundant full-screen viewmodel composite pass (folded into the
  bloom bright-pass and tonemapper inline); tight bloom lobe half → quarter res; SSR
  early-out rewritten to match the composite's own blend weight exactly; exact empty-kernel
  skip in the SSR bilateral blur; viewmodel MSAA 4× → 2× at `high`; G-buffer override
  material no longer re-uploads 14 uniforms per draw call
- Stopped jittering the viewmodel camera — it was being Halton-jittered then composited over
  an already-resolved image, so the sub-pixel positions never integrated and it read as edge
  crawl on hard silhouettes

**Added**
- `src/render/GpuProfiler.js` — `EXT_disjoint_timer_query_webgl2` instrumentation across all
  12 frame-graph stages. Ships disabled: on this ANGLE/Metal driver, instrumenting each
  region splits the frame into separate command buffers and adds a ~6 ms submission floor
  inside every measured span, making it unusable here.

**Fixed**
- CSM peter-panning: `normalBias` 0.052/0.118 on near cascades was detaching shadows 5–12 cm
  from sub-metre props
- Added screen-space contact shadows on the **direct** sun term. Ambient occlusion physically
  cannot darken under a crate lit by the sun, which is why `contact` scored 3.7 → 3.3 → 2.7
  across three rounds while everyone kept "fixing" the AO term
- AO strength now artistically exaggerated beyond physical correctness — a physically-correct
  GTAO visibility integral is effectively invisible here, since a 1 m crate removes only
  ~11% of the hemisphere

**Notes**
- Profiling established that the post stack is **3.10 ms of a 17.40 ms frame**; the HDR
  forward scene render is ~10–11 ms. Optimising post could not have reached the target.

### Phase C — Critic loop (3 rounds)

Three independent critics (surfaces / light / composition) graded five poses against
`VISUAL_BAR.md`; findings were deduplicated, severity-weighted, and routed to owning systems.

Scores: **4.29 → 4.43 → 4.33**. Plateaued, and the loop was stopped in favour of Phase D.

**Fixed**
- Ground concrete had albedo-only detail with single-constant roughness — added authored
  roughness spread, pushed crack and aggregate layers into the normal channel, and broke
  Voronoi crack loops so cracks terminate and branch
- 2,247 ground-level prop instances had `castShadow=false` while structures cast — flipped
- Corrugated siding read as canvas/corduroy
- Cable spool, hero crate and sandbags rebuilt from primitives into real objects (per-bag
  fill skew, sewn seam ridges, per-bag UV frames)
- Key/fill ratio rebalanced: `ENV_INTENSITY` 0.345 → 0.195, `HEMI` 0.12 →, sun raised to
  compensate; shadow chroma forced to sky blue instead of a darker copy of the lit colour
- Antialiasing on silhouettes against sky; TAA sub-pixel rescue window widened
- Filmic shoulder clipping to saturated yellow — added a highlight gamut ramp walking chroma
  to neutral between display luminance 0.70 and 1.02
- Volumetric vertical smear traced to the resolve pass, not the volumetric buffer (captured
  directly: its frame mean was 1/255 and zero everywhere the streaks appeared)
- Vignette rectangular banding replaced with a cos⁴ illumination falloff

**Fixed (weapons)**
- **Double sRGB encoding on every weapon albedo.** `new THREE.Color(hex)` decodes to linear
  under `ColorManagement`; that linear value was packed into a byte handed to an sRGB
  texture, so a tint authored at 0.157 reached the shader at 0.021 — 7× too dark. The
  viewmodel key had been cranked to 2.1× the world sun to compensate.
- **Gloved hands were invisible, not missing.** Modelled and animated all along, but the
  support hand's roll of +2.34 rad put it on the far side of the receiver from a camera
  sitting above and left. Corrected to +1.05.
- **Magazine teleported through the magwell after every reload.** `_resetParts()` restored
  pivots to the origin rather than their rest pose — a 56 mm / 70 mm jump. Invisible to the
  screenshot harness because it never reloads; the whole reload animation is now rest-relative.
- Optic lens was opaque cream (roughness 0.02 + clearcoat 1.0 + `envMapIntensity` 2.6 = a
  2.6×-amplified mirror aimed at a bright sky probe)
- Added geometric specular antialiasing (Kaplanyan/Tokuyoshi normal-variance into roughness)
- Viewmodel resized 225 mm → 272 mm to clear two frame edges

### Phase B — Content systems

**Added**
- `level` — ~90×70 m three-lane industrial yard: warehouse with collapsed roof, catwalk and
  second floor; container stacks, barriers, sandbags, drums, pallets, chain-link, rubble;
  perimeter structures. Instanced props with per-instance variation, chamfered edges.
- `player` — Source-style acceleration, interpolated stance, figure-eight view bob, landing
  dip, strafe roll, partial-recovery spring recoil, named camera poses for the harness
- `weapons` — procedural M4A1 and MP5 at real scale, spring-damper look sway, ADS with sight
  centring, multi-stage reloads with a physical dropped magazine, shell ejection, hitscan
  ballistics with dynamic spread and penetration
- `ai` — procedural soldier rigs, walk/run cycles with foot IK and independent torso aim,
  ragdoll death, A\* over a raycast-built navigation grid, 8-state behaviour machine
- `fx` — material-correct impacts, conforming projected decals, travelling tracers,
  multi-plane muzzle flash, depth-aware soft particles, ambient dust
- `audio` — fully synthesised weapon and environment audio with procedural convolution
  reverb, HRTF spatialisation, distance low-pass, per-shot randomisation
- `hud` — DOM overlay: dynamic crosshair, hitmarkers, ammo, directional damage indicators,
  kill feed, no health bar

**Fixed (art direction)**
- Scene rendered as bright milky midday rather than overcast dusk. `scene.fog.color` resolved
  to 0.46 linear against lit ground at ~0.05, applying 7% wash at 10 m and 29% at 40 m and
  drowning shadows that were already correct.
  - Optical depth rebuilt as quadratic-dominant with a height-stratified ground layer
    (scale height ~9 m); profile now 2.2% at 10 m / 21% at 60 m
  - Fog inscatter became a four-lobe directional evaluation replacing one flat constant
  - Fog colour now takes the *hue* of the sky and renormalises onto absolute radiance
    targets — inheriting the sky's magnitude was the actual defect
  - `SUN_CALIBRATION` 1.8 → 2.45, `ENV_INTENSITY` 0.68 → 0.17, `HEMI` 0.28 → 0.045
  - Sky saturation 0.66 → 0.38, cloud coverage 0.62 → 0.82
- Chromatic aberration was amplifying grazing-angle shimmer into rainbow speckle. Ramp
  changed to `smoothstep(0.62,1.0,r)^3` — zero across the inner 62% of frame radius, a 500×
  reduction at the artifact location while preserving corner CA.

### Phase A — Foundation

**Added**
- `core` — `Engine` (fixed-timestep accumulator, system registry, manual `renderer.info`
  control), `Config`, `EventBus`, `Input`
- `materials` — 14 procedural PBR materials across a 6-worker pool with transferable buffers
  and two-level graceful degradation. Sobel-filtered normals from separately authored height
  fields, decorrelated roughness, multi-scale cavity terms, gravity-following streaks,
  ORM channel packing.
- `lighting` — custom Preetham sky mirrored exactly on the CPU, PMREM IBL, 4-cascade CSM with
  texel snapping and per-cascade normal-offset bias, importance-ranked practicals capped at 8
- `render` — MRT HDR pipeline: GTAO, SSR with binary-search refinement, TAA with YCoCg
  neighbourhood clipping, dual-filter bloom, raymarched volumetrics, motion blur, AgX
- `physics` — Rapier world at fixed 60 Hz, collider→actor registry, collision groups,
  kinematic character controller, debris pool
- `tools/shoot.mjs` — headless Playwright capture harness

**Fixed**
- `PCFSoftShadowMap` is deprecated in r185 and silently downgrades to `PCFShadowMap` while
  forcing a full material recompile — set explicitly

### Tooling

**Fixed**
- Perf sampler counted the ~3 s shader-compile warmup as gameplay frames, reporting
  `worstFps` ~20 while the game ran at 80+. Three critics filed phantom framerate
  instant-fails against this artifact. Now reports steady state only, plus `p5Fps`,
  `warmupMs` and `measuredFrames`.
- `drawCalls` always reported `1` — Three resets `renderer.info` on every internal render
  call and the pipeline issues many. Now under manual control, reset once per frame.
- `tools/shoot.mjs` reused a running Vite server. Vite caches module transforms server-side,
  so agents were served stale JavaScript after editing files — one fixer spent an hour tuning
  against code that was no longer running. Now starts a private cold `--force` server on its
  own port per invocation and tears it down after.
- The click-to-deploy overlay was a full-screen `rgba(4,6,8,.72)` scrim shown whenever pointer
  lock was absent — which is always, in a headless capture. Every screenshot was being graded
  through a 72%-opaque black wash. The harness now hides the overlay before capture.

---

## Known issues

See [README § Known issues](README.md#known-issues). Summary: distant buildings lack window
reveals, mid-distance shadow resolution runs out at 2048px × 4 cascades, `overwatch` sits
1 fps under the 60 target, bot focus-fire is unbalanced, and viewmodel-vs-wall clipping is
untested because headless Chromium refuses pointer lock.
