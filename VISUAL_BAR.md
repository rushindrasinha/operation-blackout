# Visual Quality Rubric — how the critic grades

The critic agent scores a screenshot on nine axes, 0–10 each. This document is the
standard. It exists so "looks good" is never the judgement — a specific, falsifiable
defect is.

**Passing bar: every axis ≥ 7, total ≥ 68/90, and zero items from the Instant Fail list.**

A screenshot that a knowledgeable player would guess came from a browser is a fail even
if it scores well, so the critic must also answer: *"if I saw this frame with no context,
would I assume it was a shipped console game?"*

---

## The nine axes

**1. Material believability (0–10)**
Do surfaces read as real substances with physical properties, or as coloured polygons?
Look specifically for roughness variation across a single surface — the single most
reliable amateur/professional tell. A concrete wall with one uniform roughness is a 3
regardless of how nice the albedo is.

**2. Lighting and shadow (0–10)**
Directional key with believable colour temperature, soft-edged shadows with correct
penumbra growth over distance, no acne, no peter-panning, no shimmer/crawl on movement.
Ambient must be directional (sky above, bounce below), never flat.

**3. Contact and grounding (0–10)**
Every object must look like it is *resting on* the surface beneath it. Ambient occlusion
darkening in crevices and at object/ground junctions. Floating objects are the fastest
way to destroy realism.

**4. Atmosphere and depth (0–10)**
Aerial perspective — distant geometry desaturating and lifting toward the horizon colour.
Volumetric light where the sun is visible. Without this, scenes look like a diorama.

**5. Composition and art direction (0–10)**
Is the frame *designed*? Leading lines, foreground/midground/background layering, a clear
focal point, deliberate silhouettes. A technically perfect render of a boring grey box is
still a fail.

**6. Colour grade (0–10)**
Filmic response. Shadows retain detail and lean cool; highlights roll off warm and never
clip to flat white. Desaturated military palette with warm practicals as the only
saturated accent. No crushed blacks, no blown highlights, no video-game oversaturation.

**7. Geometric detail and silhouette (0–10)**
Bevelled edges that catch light. Asymmetry, wear, sag, damage. Enough polygonal density
that silhouettes read as solid objects rather than as boxes.

**8. Weapon / viewmodel quality (0–10)**
The gun occupies a large fraction of every frame and gets disproportionate scrutiny.
Correct viewmodel FOV, no clipping into geometry, believable materials, proper hand
position, visible mechanical detail.

**9. Post-processing discipline (0–10)**
Effects present but *invisible as effects*. Bloom subtle and wide, not haloed. Grain
present but fine. Chromatic aberration only at frame edges. TAA clean with no ghosting
trails behind moving objects. Over-application scores as badly as absence.

---

## Instant Fail list

Any one of these fails the whole screenshot regardless of score:

- Untextured / flat-colour surfaces anywhere in frame
- Pure black (0,0,0) shadow regions or clipped-white blowouts
- Visible texture tiling repetition
- Shadow acne, or shadows visibly detached from their caster
- Objects floating with no contact shadow
- Z-fighting or visible geometry seams
- Viewmodel clipping through world geometry
- TAA ghosting trails
- Aliased jaggies on high-contrast edges
- Anything that reads as a default Three.js material (that specific plastic grey)
- Framerate under 55fps at 1080p

---

## Reference calibration

The critic must hold in mind actual *Call of Duty: Modern Warfare* frames as the
comparison — specifically the low-sun urban and industrial environments. Concretely, that
reference has:

- Heavy fine-grain surface detail visible even at 3+ metres
- Shadow penumbra that visibly softens with distance from the contact point
- Every metal surface showing distinct specular response to the key light
- Practical lights with real falloff and warm colour bleed onto nearby surfaces
- Air that is never perfectly clear — always some haze, dust, or particulate
- Colour that sits in a narrow, desaturated, deliberately-graded band

The honest framing: we are not going to beat that reference, and the critic should not
pretend otherwise. The question the critic answers is **"what is the single largest
remaining gap, and what specific change closes it?"** — not "is this better than CoD".
Every review must end with a concrete, actionable, prioritised fix list aimed at the
lowest-scoring axis.
