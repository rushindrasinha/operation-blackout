import * as THREE from 'three';
import { PartBuilder, box, cyl, tube, lathe, at } from './geom.js';

/**
 * OPERATION BLACKOUT — procedural weapon models.
 *
 * Weapon space: +X right, +Y up, −Z down the bore. The bore axis is the line
 * x = 0, y = 0, and z = 0 is the rear face of the upper receiver. Every dimension
 * below is in metres and taken from the real weapon — an M4A1 is 838 mm with the
 * stock collapsed, and if you build it at any other scale the viewmodel FOV can
 * never be made to look right.
 *
 * OWNER: weapons.
 */

/* ────────────────────────── shared sub-assemblies ────────────────────────── */

/**
 * `lathe()` in geom.js builds about −Z: it rolls the profile onto +Z and then does
 * `scale(1,1,-1)` to get the winding right, so a profile point at z = +L lands at
 * world z = −L. Every asymmetric profile in this file was authored assuming the
 * opposite, and the result was a set of parts silently built backwards:
 *
 *   - the buffer tube ran 194 mm FORWARD from the receiver, through the magwell,
 *     leaving the collapsible stock attached to nothing;
 *   - the barrel started 115 mm in front of the gas block, so the muzzle device
 *     floated free with a visible gap where the barrel should be (and `muzzleZ`,
 *     which the flash and tracers spawn from, pointed at empty air);
 *   - the windage turret, the battery cap and the forward-assist head all extended
 *     INWARD into the part they were bolted to, so they were invisible;
 *   - on the MP5, the stamped receiver, the cocking tube and the handguard all ran
 *     forward instead of back.
 *
 * `laz` pre-rotates 180 degrees about Y so a profile running 0 → +L occupies world
 * z0 → z0 + L, which is what every dimension in this file actually means. It is a
 * pure rotation, so the face winding — and therefore the normals toCreasedNormals
 * derived from it — is preserved.
 */
function laz(profile, pos, rot = null, segments = 20, crease = 42) {
  const g = lathe(profile, segments, crease);
  at(g, null, [0, Math.PI, 0]);
  if (rot) at(g, null, rot);
  if (pos) at(g, pos);
  return g;
}

/**
 * MIL-STD-1913 Picatinny rail: a 21.2 mm base carrying 5.6 mm recoil lugs on
 * 10 mm centres. The slot pattern is the most recognisable piece of modern-weapon
 * detail there is, and it is what makes the top of the gun read as machined rather
 * than extruded. Lugs face +Y; pass `roll` to put the strip on a side or the
 * underside of the bore.
 */
function railStrip(b, {
  z0, z1, y, x = 0, roll = 0, mat = 'alloy', width = 0.0212,
  // MIL-STD-1913 for real: 21.2 mm across the tops, a 4.75 mm slot cut on 10 mm
  // centres leaving a 5.25 mm island, and the whole thing standing 5.0 mm off the
  // mounting face with a 45-degree dovetail under it.
  height = 0.0050, slotDepth = 0.0030, pitch = 0.0100, slotW = 0.0048,
  group = null, uv = 0.055, sink = 0.0010,
}) {
  const len = Math.abs(z1 - z0);
  const zc = (z0 + z1) / 2;
  const rot = roll ? [0, 0, roll] : null;

  const rollPlace = (g, pos) => {
    if (!roll) return at(g, pos);
    // Rotate the offset about the bore axis (Z) as well as the part itself.
    const c = Math.cos(roll), s = Math.sin(roll);
    const px = pos[0] * c - pos[1] * s;
    const py = pos[0] * s + pos[1] * c;
    return at(g, [px, py, pos[2]], rot);
  };

  // THE RAIL IS PART OF THE GUN, NOT A LADDER LYING ON IT. Two things were wrong
  // before: the lugs were raised bars sitting on a smooth bar (so it read as a comb,
  // never as slots milled into a rail), and the base floated ~0.7 mm proud of the
  // handguard with a visible dark gap under it. `sink` buries the base into the host
  // surface so the two are one solid; the slot FLOOR is what is modelled as a
  // separate part now, not the teeth.
  const baseY = y - sink;
  const webH = height - slotDepth - 0.0014;
  const floorY = baseY + webH + 0.0014;

  // 1. Dovetail web, narrower than the top face — the undercut that gives a
  //    Picatinny rail its silhouette instead of a plain rectangular bar.
  b.add(rollPlace(box(width * 0.78, webH + sink + 0.0010, len, 0.0007),
    [x, baseY + (webH + sink + 0.0010) * 0.5 - sink, zc]), mat, { group, uv });

  // 2. The slot FLOOR: continuous, full width, and in the dark barrel finish rather
  //    than the receiver anodise. This is the piece that makes the difference. The
  //    old rail put raised bars on a smooth bar, so it read as a comb — teeth ON the
  //    rail. Here the continuous element is the floor and the ISLANDS are what get
  //    broken up, so the gaps between them read as slots cut down INTO the rail, and
  //    the floor being a different, darker material sells the depth.
  b.add(rollPlace(box(width * 0.965, 0.0016, len, 0.0004), [x, floorY - 0.0008, zc]),
    'blued', { group, uv: 0.020, occlude: false, aoScale: 1.5, wear: 0.3 });

  // 3. Islands between the slots.
  const n = Math.max(1, Math.floor(len / pitch));
  const start = Math.min(z0, z1) + (len - (n - 1) * pitch) * 0.5;
  const islandL = Math.max(0.0022, pitch - slotW);
  for (let i = 0; i <= n; i++) {
    const z = start + (i - 0.5) * pitch;
    if (z < Math.min(z0, z1) - 0.001 || z > Math.max(z0, z1) + 0.001) continue;
    b.add(
      rollPlace(box(width, slotDepth + 0.0016, islandL, 0.00055),
        [x, floorY + slotDepth * 0.5 - 0.0008, z]),
      mat, { group, uv, occlude: false },
    );
  }
}

/**
 * Red-dot sight, Aimpoint T-2 pattern: 30 mm tube, killflash-free objective,
 * elevation turret on top, windage on the right, QD mount with two thumb nuts.
 * Returns the reticle mesh and the optical-axis Y so the rig can centre it.
 */
function redDot(b, surfaces, { railY, zc, opticY, mat = 'alloy' }) {
  const R = 0.0158;          // 30 mm tube, outer radius with the body wall
  const RI = 0.0124;         // internal bore of the tube
  const L = 0.068;
  const zFront = zc - L / 2;
  const zRear = zc + L / 2;

  /* ── mount ────────────────────────────────────────────────────────────────
   * Two bare struts is not a mount. A QD mount is a machined base with a recoil
   * lug that drops into a rail slot, a saddle that the tube CLAMPS into, and a
   * split ring with a visible pinch bolt. All three are silhouette detail.
   */
  const mountTop = opticY - R + 0.004;
  b.add(at(box(0.026, mountTop - railY, 0.040, 0.0014), [0, (railY + mountTop) / 2, zc + 0.004]), mat, { uv: 0.06 });
  // Rail-clamp foot, wider than the base and undercut for the rail dovetail.
  b.add(at(box(0.036, 0.0075, 0.034, 0.0012), [0, railY + 0.0037, zc + 0.004]), mat, { uv: 0.06 });
  // Recoil lug: the tab that actually drops into a Picatinny slot.
  b.add(at(box(0.020, 0.0040, 0.0046, 0.0006), [0, railY - 0.0015, zc + 0.017]), 'steel', { uv: 0.02, occlude: false });
  // Clamp ring around the tube with its pinch gap and bolt.
  b.add(laz([
    [R + 0.0004, 0], [R + 0.0042, 0], [R + 0.0042, 0.0130], [R + 0.0004, 0.0130],
  ], [0, opticY, zc + 0.004], null, 22), mat, { uv: 0.035 });
  b.add(at(cyl(0.0030, 0.0130, 0.0006, 10), [0.0142, opticY - R - 0.0026, zc + 0.017], [0, Math.PI / 2, 0]), 'steel', { uv: 0.014, occlude: false });
  // Two thumb nuts on the right of the mount.
  for (const zz of [zc - 0.010, zc + 0.017]) {
    b.add(laz([
      [0.0001, 0], [0.0064, 0], [0.0064, 0.0042], [0.0052, 0.0050],
      [0.0064, 0.0058], [0.0064, 0.0092], [0.0001, 0.0092],
    ], [0.019, railY + 0.005, zz], [0, Math.PI / 2, 0], 14), mat, { uv: 0.024 });
  }

  /* ── tube body ────────────────────────────────────────────────────────── */
  b.add(at(lathe([
    [RI, -L / 2], [R - 0.0012, -L / 2], [R, -L / 2 + 0.0016],
    [R, -L / 2 + 0.010], [R - 0.0016, -L / 2 + 0.011],
    [R - 0.0016, -0.012], [R + 0.0008, -0.010], [R + 0.0008, 0.010], [R - 0.0016, 0.012],
    [R - 0.0016, L / 2 - 0.011], [R, L / 2 - 0.010],
    [R, L / 2 - 0.0016], [R - 0.0012, L / 2], [RI, L / 2],
  ], 26), [0, opticY, zc]), mat, { uv: 0.10 });

  /* ── the interior ─────────────────────────────────────────────────────────
   * THIS is what was missing. The tube was a hollow pipe with two transparent
   * discs stuffed in the ends, so from any three-quarter angle you looked in one
   * hole, past both "lenses", and straight out of the other — you could read the
   * ground through the middle of the sight. A real optic is packed: an anodised
   * liner, then a stack of light baffles whose whole purpose is that no ray gets
   * from one end to the other unless it is within a few degrees of the axis.
   */
  // Flat-black liner, so what is behind the lens is a black cavity and not daylight.
  b.add(at(tube(RI - 0.0002, RI - 0.0016, L - 0.006, 0.0003, 24), [0, opticY, zc]),
    'baffle', { uv: 0.05, occlude: false, wear: 0 });
  // Baffle stack: three annular knife-edge rings on the objective side.
  for (let i = 0; i < 3; i++) {
    const bz = zFront + 0.012 + i * 0.011;
    const ap = 0.0086 + i * 0.0006;
    b.add(at(tube(RI - 0.0004, ap, 0.0013, 0.0002, 22), [0, opticY, bz]),
      'baffle', { uv: 0.03, occlude: false, wear: 0 });
  }
  // Emitter housing: the canted block a red dot's LED actually lives in, low in
  // the tube on the objective side, and the reason the dot exists at all.
  b.add(at(box(0.0070, 0.0060, 0.0100, 0.0010), [0, opticY - 0.0088, zc + 0.006], [0.30, 0, 0]),
    'baffle', { uv: 0.02, occlude: false, wear: 0 });

  /* ── turrets ──────────────────────────────────────────────────────────────
   * Knurling done as concentric lathe grooves rather than radial ridges: same
   * read at viewmodel distance for a twentieth of the triangles.
   */
  const turret = (h) => lathe([
    [0.0001, 0], [0.0076, 0], [0.0076, h * 0.30],
    [0.0068, h * 0.34], [0.0076, h * 0.42], [0.0068, h * 0.46],
    [0.0076, h * 0.54], [0.0068, h * 0.58], [0.0076, h * 0.66],
    [0.0076, h - 0.0016], [0.0062, h], [0.0001, h],
  ], 16);
  b.add(at(turret(0.0098), [0, opticY + R - 0.001, zc + 0.020], [Math.PI / 2, 0, 0]), mat, { uv: 0.024 });
  b.add(at(turret(0.0098), [R - 0.001, opticY, zc + 0.020], [0, -Math.PI / 2, 0]), mat, { uv: 0.024 });
  // Battery cap, left side.
  b.add(laz([
    [0.0001, 0], [0.0092, 0], [0.0092, 0.0030], [0.0084, 0.0036],
    [0.0092, 0.0042], [0.0092, 0.0062], [0.0078, 0.0074], [0.0001, 0.0074],
  ], [-(R - 0.001), opticY, zc - 0.012], [0, -Math.PI / 2, 0], 16), mat, { uv: 0.028 });
  // Objective shade / anti-glare hood.
  b.add(at(tube(R - 0.0002, R - 0.0026, 0.011, 0.0005, 24), [0, opticY, zFront - 0.0050]),
    mat, { uv: 0.04, occlude: false });

  /* ── killflash ────────────────────────────────────────────────────────────
   * An ARD sits in the shade and breaks the objective's mirror into a dark grid.
   * Modelled as three crossed vanes plus an inner ring rather than a real
   * honeycomb: at viewmodel distance the read is identical for 8 boxes instead of
   * 60, and the objective stops being a smooth chrome bulb — which is exactly the
   * complaint. Carbon, because an ARD is always the deadest black on the gun.
   */
  {
    const shadeZ = zFront - 0.0052;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI;
      b.add(at(box(0.0009, (RI - 0.0004) * 2, 0.0090, 0.0002), [0, opticY, shadeZ], [0, 0, a]),
        'carbon', { uv: 0.012, occlude: false, wear: 0 });
    }
    b.add(at(tube(RI * 0.60, RI * 0.60 - 0.0009, 0.0090, 0.0002, 16), [0, opticY, shadeZ]),
      'carbon', { uv: 0.012, occlude: false, wear: 0 });
  }

  /* ── rubber eyecup ────────────────────────────────────────────────────────
   * The one part that makes an ocular read as an eyepiece rather than an open
   * pipe: a soft flared collar standing proud of the tube's rear face, in a
   * material that is obviously NOT the aluminium body.
   */
  b.add(laz([
    [R - 0.0016, 0], [R + 0.0016, 0.0018], [R + 0.0022, 0.0068],
    [R + 0.0040, 0.0130], [R + 0.0020, 0.0142], [R + 0.0006, 0.0128],
    [R - 0.0012, 0.0070], [R - 0.0018, 0.0020],
  ], [0, opticY, zRear - 0.0030], null, 24), 'rubber', { uv: 0.030, aoScale: 1.2 });

  /* ── glass ────────────────────────────────────────────────────────────────
   * Objective and ocular are now DIFFERENT materials (see procgen: the alpha of
   * each is Fresnel-driven, so off-axis they go opaque and mirror the coating,
   * on-axis they clear up). renderOrder forces the objective to draw first so the
   * ocular's near-opaque grazing alpha covers it — no more interpenetrating
   * ellipses.
   */
  const lensGeo = (r) => at(cyl(r, 0.0016, 0.0003, 26), [0, 0, 0]);
  const lensFront = new THREE.Mesh(lensGeo(RI - 0.0004), surfaces.get('lens'));
  lensFront.position.set(0, opticY, zFront + 0.0042);
  lensFront.frustumCulled = false;
  lensFront.renderOrder = 10;
  const lensRear = new THREE.Mesh(lensGeo(RI - 0.0004), surfaces.get('lensRear'));
  lensRear.position.set(0, opticY, zRear - 0.0042);
  lensRear.frustumCulled = false;
  lensRear.renderOrder = 13;

  // The dot. Sits ON the optical axis, just inside the ocular so the tube wall
  // occludes it from every angle except down the sight line — and because the ADS
  // pose puts that axis exactly on the camera's −Z, it lands on the centre pixel.
  //
  // Size is chosen in ANGULAR terms, not model terms: at the ~134 mm eye relief the
  // ADS pose uses, a 7.6 mm card with the texture's 8.5%-radius core renders a dot
  // about 8 px across at 1080p. A physically-correct 2 MOA dot would be 0.65 px
  // and would simply disappear, which is why every shipped game cheats this number.
  const reticle = new THREE.Mesh(
    new THREE.PlaneGeometry(0.0076, 0.0076),
    surfaces.get('reticle'),
  );
  reticle.position.set(0, opticY, zRear - 0.0028);
  reticle.renderOrder = 20;
  reticle.frustumCulled = false;

  // Ghost of the dot reflected off the back of the objective — a small, real,
  // free detail that reads as "there is glass in there".
  const reticleGhost = new THREE.Mesh(
    new THREE.PlaneGeometry(0.0050, 0.0050),
    surfaces.get('reticle'),
  );
  reticleGhost.position.set(0.0006, opticY - 0.0006, zFront + 0.0056);
  reticleGhost.scale.setScalar(0.85);
  reticleGhost.renderOrder = 11;
  reticleGhost.frustumCulled = false;

  return { lensFront, lensRear, reticle, reticleGhost, zFront, zRear, radius: R };
}

/**
 * STANAG / PMAG-pattern magazine built as a stack of slightly rotated shells, which
 * is how you get the real 7-degree banana curve without a swept surface.
 */
function magazine(b, {
  group = 'mag', mat = 'magPolymer', topY, topZ, w = 0.0250, d = 0.0385,
  length = 0.185, curve = 0.055, tilt = 0.10, segments = 6, ribs = true,
}) {
  const segLen = length / segments;
  let y = topY;
  let z = topZ;
  let ang = tilt;

  for (let i = 0; i < segments; i++) {
    const t = i / (segments - 1);
    // Taper: magazine bodies narrow very slightly toward the floorplate.
    const ww = w * (1 - t * 0.05);
    const dd = d * (1 - t * 0.09);
    const cy = y - Math.cos(ang) * segLen * 0.5;
    const cz = z + Math.sin(ang) * segLen * 0.5;
    b.add(
      // Heavy overlap. At 1.06 the corners of consecutive shells stepped visibly
      // and the magazine read as a staircase rather than a curve.
      at(box(ww, segLen * 1.34, dd, 0.0022), [0, cy, cz], [ang, 0, 0]),
      mat, { group, uv: 0.05, aoScale: 0.8 },
    );
    if (ribs && i > 0 && i < segments - 1) {
      // Anti-tilt ribs down the flanks.
      for (const sx of [-1, 1]) {
        b.add(
          at(box(0.0011, segLen * 1.10, dd * 0.86, 0.0003), [sx * ww * 0.5, cy, cz], [ang, 0, 0]),
          mat, { group, uv: 0.02, occlude: false },
        );
      }
    }
    y -= Math.cos(ang) * segLen;
    z += Math.sin(ang) * segLen;
    ang += curve / segments;
  }

  // Floorplate + rubber base pad.
  const fy = y - 0.006;
  b.add(at(box(w * 1.10, 0.012, d * 0.98, 0.0016), [0, fy, z + 0.004], [ang, 0, 0]), mat, { group, uv: 0.04 });
  b.add(at(box(w * 1.14, 0.009, d * 1.02, 0.0018), [0, fy - 0.009, z + 0.005], [ang, 0, 0]), 'rubber', { group, uv: 0.03 });
  // Witness-hole dimples.
  for (let i = 0; i < 3; i++) {
    b.add(
      at(cyl(0.0022, 0.0016, 0.0004, 10), [w * 0.52, topY - 0.045 - i * 0.032, topZ + 0.010 + i * 0.004], [0, Math.PI / 2, 0]),
      mat, { group, uv: 0.014, occlude: false },
    );
  }
  return { bottomY: fy - 0.012, bottomZ: z };
}

/**
 * Trigger group: guard, trigger blade, pin bosses.
 *
 * The guard has to be a THIN LOOP with daylight inside it. The old one used the
 * receiver's own width (30 mm) for the bow and the struts, so it was a solid slab
 * hanging under the gun with no hole in it — which is why "no trigger guard" came
 * back from three separate reviewers who were looking straight at one. A real AR
 * guard is about 8 mm across.
 */
function triggerGroup(b, { zFront, zBack, yTop, yBot, mat = 'alloy', width = 0.0086 }) {
  const zc = (zFront + zBack) / 2;
  const len = Math.abs(zBack - zFront);
  // Bottom bow.
  b.add(at(box(width, 0.0072, len * 0.86, 0.0022), [0, yBot, zc + 0.001]), mat, { uv: 0.03 });
  // Front strut, raked forward the way an AR guard is.
  b.add(at(box(width, 0.0300, 0.0090, 0.0022), [0, yBot + 0.0140, zFront + 0.0052], [0.30, 0, 0]), mat, { uv: 0.03 });
  // Rear strut into the receiver.
  b.add(at(box(width, 0.0250, 0.0090, 0.0022), [0, yBot + 0.0118, zBack - 0.0030], [-0.14, 0, 0]), mat, { uv: 0.03 });
  // Corner fillets, so the loop reads as one bent part rather than three sticks.
  b.add(at(box(width, 0.0110, 0.0110, 0.0026), [0, yBot + 0.0032, zFront + 0.0086], [0.55, 0, 0]), mat, { uv: 0.02, occlude: false });
  b.add(at(box(width, 0.0100, 0.0100, 0.0026), [0, yBot + 0.0028, zBack - 0.0072], [-0.5, 0, 0]), mat, { uv: 0.02, occlude: false });
  // Pivot-pin boss at the front of the guard.
  b.add(at(cyl(0.0034, width * 1.5, 0.0006, 10), [0, yBot + 0.0040, zFront + 0.0030], [0, Math.PI / 2, 0]), 'steel', { uv: 0.012, occlude: false });
  return { triggerZ: zc + 0.006, triggerY: yTop - 0.012 };
}

/**
 * A gloved hand, built by actually WRAPPING it around the thing it is holding.
 *
 * The previous version placed finger boxes at fixed offsets with no rotation, so
 * they stuck straight forward off a slab and the whole assembly read as a mitten
 * lying next to the weapon rather than a hand gripping it. Silhouette is the entire
 * job here: nobody counts knuckles at viewmodel distance, but everybody instantly
 * clocks whether the fingers close around the grip.
 *
 * Canonical build frame: the gripped cylinder's axis is +Y, its rear face is +Z,
 * and azimuth is measured from +Z rotating toward `side * +X`. Every segment is
 * placed TANGENTIALLY on that circle, which is what makes the fingers curl.
 * `axisRot` then rotates the whole canonical frame onto whatever the real part's
 * axis is — vertical for a pistol grip, along the bore for a handguard.
 */
function gripHand(b, {
  origin, axisRot = null, rot = null, side = 1, mat = 'glove', group = null,
  radius = 0.019, startAz = 1.62, fingerPitch = 0.0205, wrap = 1.0,
  palmAz = 0.42, thumbAz = -0.80, thumbRise = 0.014, cuff = true, indexOut = 0,
  thumbLen = 1.0, thumbSweep = 1.0,
  // Radial bias for the wrist cuff only. `radius` is the radius the FINGERS close
  // on, so pressing the hand into the part it holds (which is what stops the
  // fingers orbiting it with a visible air gap) also drags the cuff inward — and
  // the cuff sits off the end of the part, where there is nothing to press into.
  // This puts it back without loosening the grip.
  cuffOut = 0,
}) {
  const parts = [];
  const push = (g) => { parts.push(g); return g; };

  /**
   * A box laid tangentially on the grip circle: local X runs along the wrap, Y is
   * along the grip axis, Z is radial. The yaw that makes local +X point down the
   * tangent is atan2(sin a, side*cos a) — that single line is the whole trick.
   */
  const tang = (len, h, thick, a, r, y, bevel = 0.0032) => {
    const phi = Math.atan2(Math.sin(a), side * Math.cos(a));
    const g = box(len, h, thick, bevel, 2);
    return push(at(g, [side * Math.sin(a) * r, y, Math.cos(a) * r], [0, phi, 0]));
  };

  /**
   * A phalanx placed on a STRAIGHT tangent line off the grip circle rather than
   * on the circle itself. This is how the trigger finger gets indexed: it leaves
   * the hand at the same azimuth as the others, then runs straight instead of
   * curling, which — at the pistol grip's canonical azimuth — points it forward
   * along the bore, i.e. along the outside of the trigger guard. That is the
   * single most-recognisable thing about how a trained shooter holds a rifle, and
   * a hand with all four fingers curled reads as a fist on a stick.
   */
  const straight = (len, h, thick, a, r0, y, along, bevel = 0.0032) => {
    const phi = Math.atan2(Math.sin(a), side * Math.cos(a));
    // Unit tangent at azimuth a, in the canonical XZ plane.
    const tx = side * Math.cos(a), tz = -Math.sin(a);
    const px = side * Math.sin(a) * r0 + tx * along;
    const pz = Math.cos(a) * r0 + tz * along;
    return push(at(box(len, h, thick, bevel, 2), [px, y, pz], [0, phi, 0]));
  };

  /* ── four fingers, three phalanges each, closing around the grip ──────────
   * Per-finger length and azimuth variation matters more than it sounds. With all
   * four the same length, leaving at the same azimuth, the row renders as four
   * identical rounded pips in an even line — a comb, not a hand. Real digits differ
   * by ~15% end to end (index and middle longest, little shortest) and each one
   * wraps to a slightly different depth, so the fingertips describe a curve rather
   * than a straight edge. That curve is the read.
   */
  const FL = [0.0268, 0.0224, 0.0176];
  const FSCALE = [1.00, 1.02, 0.94, 0.84];   // index, middle, ring, little
  const FAZ = [0.00, 0.06, 0.14, 0.24];      // staggered wrap start per finger
  for (let f = 0; f < 4; f++) {
    const t = f / 3;
    const y = -f * fingerPitch;
    const w = 0.0172 - t * 0.0024;
    // The index finger runs straight along the guard; the rest close on the grip.
    if (f === 0 && indexOut > 0) {
      let along = 0;
      for (let k = 0; k < 3; k++) {
        const len = FL[k] * indexOut;
        // A real indexed finger is not perfectly rigid — it droops slightly at the
        // distal joint, so lift each segment a touch off the tangent line.
        straight(len * 0.99, w * (1 - k * 0.05), w * (1 - k * 0.07),
          startAz - 0.10, radius + w * 0.5 + k * 0.0016, y + k * 0.0011, along + len * 0.5, 0.0034);
        along += len * 0.94;
      }
      continue;
    }
    let a = startAz + FAZ[f];
    for (let k = 0; k < 3; k++) {
      const len = FL[k] * FSCALE[f] * wrap;
      const r = radius + w * 0.5 - k * 0.0008;
      const da = len / r;
      tang(len * 0.99, w * (1 - k * 0.05), w * (1 - k * 0.07), a + da * 0.5, r, y, 0.0034);
      // Overlap slightly at the joints so the chain never shows a gap.
      a += da * 0.93;
    }
  }

  /* ── knuckle ridge, palm, heel ──────────────────────────────────────────── */
  const spanY = 3 * fingerPitch;
  tang(0.0150, spanY + 0.0180, 0.0104, startAz + 0.16, radius + 0.0132, -spanY * 0.5, 0.0038);
  tang(0.0260, spanY + 0.0140, 0.0230, palmAz, radius + 0.0128, -spanY * 0.42, 0.0060);
  tang(0.0230, 0.0300, 0.0210, palmAz - 0.16, radius + 0.0120, -spanY - 0.0180, 0.0060);

  /* ── dorsum: the back of the hand, and the reason a hand reads as a HAND ───
   *
   * This is the defect the last three passes kept missing. The knuckle ridge sat
   * at azimuth startAz+0.16 and the palm at palmAz — for the support hand that is
   * 1.72 rad and 0.42 rad, seventy-five degrees of grip circumference APART with
   * nothing in between. So the model was: four curled digits, a floating knuckle
   * bar, a void, then a palm block on the far side of the handguard. From the
   * shooter's eye the void is exactly the part of the hand you look at, which is
   * why the certifier's words were "four detached dark rounded blocks that do not
   * wrap the grip … no continuous hand". They were detached. There was no hand
   * between them.
   *
   * A band of overlapping tangential slabs across that whole arc, at the same
   * radial depth as the knuckle ridge, closes it into one continuous mass that
   * visibly wraps the part. It also tapers — a real hand is deepest across the
   * metacarpals and thins toward the wrist — which keeps it from reading as a
   * sleeve. Six segments, because the arc is ~40 mm long and any fewer leaves
   * facet steps you can see at 4x.
   */
  {
    const a0 = palmAz + 0.10;
    const a1 = startAz + 0.18;
    const N = 7;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const a = a0 + (a1 - a0) * t;
      // Deepest across the knuckles, thinner toward the heel of the hand.
      const thick = 0.0092 + 0.0026 * t;
      const h = spanY + 0.0120 + 0.0062 * t;
      const yc = -spanY * 0.5 - 0.0028 * (1 - t);
      // Segments overlap by ~30%: any less and the band shows facet steps at 4x.
      tang(0.0152, h, thick, a, radius + 0.0104 + 0.0022 * t, yc, 0.0040);
    }
  }

  /* ── inter-digit webbing across the proximal row ───────────────────────────
   * Four separately-modelled fingers leave four slots you can see daylight
   * through, and backlit slots are what turn digits into "pips". One slab spanning
   * all four proximal phalanges, recessed ~3 mm from the finger backs, fills the
   * slots while leaving the shadow grooves that separate the digits.
   */
  if (indexOut <= 0) {
    tang(0.0170, spanY + 0.0128, 0.0126, startAz + 0.32, radius + 0.0072, -spanY * 0.5, 0.0034);
    tang(0.0150, spanY + 0.0112, 0.0112, startAz + 0.66, radius + 0.0064, -spanY * 0.5 - 0.0010, 0.0032);
  }

  /* ── thenar: the wedge of muscle that bridges the palm to the thumb ────────
   * Without it the thumb is a separate sausage parked near the hand. Two blocks
   * interpolated along the palm→thumb arc is enough to make the join read.
   */
  {
    const daz = thumbAz - palmAz;
    tang(0.0210, 0.0290, 0.0186, palmAz + daz * 0.34, radius + 0.0112, -spanY * 0.16, 0.0056);
    tang(0.0190, 0.0250, 0.0176, palmAz + daz * 0.70, radius + 0.0104, thumbRise - 0.0090, 0.0052);
  }

  /* ── knuckle armour ───────────────────────────────────────────────────────
   * Four moulded TPR caps standing proud over the first knuckle, plus the strap
   * across the back of the hand. Two reasons this earns its triangles: it is the
   * one silhouette feature that says "tactical glove" rather than "mitten", and it
   * puts a hard, dark, obviously-different material next to the soft fabric, which
   * is what stops a hand reading as one undifferentiated lump of foreground.
   * Returned separately so the caller can hand them to the rubber material.
   */
  const armour = [];
  {
    const save = parts.length;
    // Caps stand PROUD. From the shooter's own eye a C-clamp support hand is seen
    // mostly from the back, so the four knuckles are the only place finger
    // separation can read at all — the digits themselves curl away on the far side.
    // At 4.4 mm thick and flush with the finger backs they disappeared into the
    // glove; 6.6 mm with a gap between them gives four distinct bumps and a shadow
    // line between each, which is what makes the mass parse as a hand.
    for (let f = 0; f < 4; f++) {
      const t = f / 3;
      const y = -f * fingerPitch;
      const w = 0.0172 - t * 0.0024;
      tang(0.0126 - t * 0.0014, w * 0.72, 0.0066, startAz + FAZ[f] + 0.20, radius + w * 0.5 + 0.0052, y, 0.0022);
    }
    // Back-of-hand strap.
    tang(0.0186, 0.0072, 0.0052, startAz + 0.30, radius + 0.0142, -spanY * 0.5 - 0.0060, 0.0018);
    // Second strap further back over the metacarpals. With the dorsum now filled
    // in, one strap on a 40 mm span left the middle of the hand blank; two put a
    // hard dark line at each end of the mass, which is what stops a continuous
    // back-of-hand from reading as a mitten.
    tang(0.0210, 0.0064, 0.0046, startAz - 0.42, radius + 0.0136, -spanY * 0.5 - 0.0040, 0.0016);
    while (parts.length > save) armour.push(parts.pop());
  }

  /* ── thumb ────────────────────────────────────────────────────────────────
   * Rebuilt as three tapering phalanges running ALONG the grip axis rather than
   * two blocks laid across the wrap. On a C-clamp support hand the thumb points
   * down the handguard toward the muzzle, and that forward run is the single most
   * recognisable thing in the hand's silhouette — it is the feature that tells you
   * which way round the hand is. `thumbSweep` lets the caller curl it slightly
   * around the grip as it goes; `thumbLen` scales the whole digit.
   */
  {
    const seg = [
      // [alongWrap, alongAxis, radialThick, azOffset, radialOffset, yOffset, bevel]
      [0.0212, 0.0230, 0.0196, 0.00, 0.0122, -0.0060, 0.0048],
      [0.0184, 0.0208, 0.0170, 0.36, 0.0116, 0.0152, 0.0044],
      [0.0160, 0.0176, 0.0146, 0.66, 0.0106, 0.0334, 0.0040],
    ];
    for (const [lw, la, th, ao_, ro, yo, bv] of seg) {
      tang(lw, la * thumbLen, th, thumbAz + side * ao_ * thumbSweep,
        radius + ro, thumbRise + yo * thumbLen, bv);
    }
    // Rubber knuckle cap over the thumb's first joint, plus a reinforcement strake
    // down the back of the digit. The strake is what actually makes the thumb read:
    // a long unbroken specular line running along one axis is the cue the eye uses
    // to separate a finger from the mass behind it, and the thumb lies flat on the
    // handguard where it has no silhouette edge to do that job for it.
    const save = parts.length;
    tang(0.0128, 0.0092, 0.0062, thumbAz + side * 0.20 * thumbSweep,
      radius + 0.0180, thumbRise + 0.0056 * thumbLen, 0.0022);
    tang(0.0074, 0.0210 * thumbLen, 0.0044, thumbAz + side * 0.06 * thumbSweep,
      radius + 0.0198, thumbRise - 0.0050 * thumbLen, 0.0016);
    tang(0.0064, 0.0230 * thumbLen, 0.0040, thumbAz + side * 0.48 * thumbSweep,
      radius + 0.0182, thumbRise + 0.0230 * thumbLen, 0.0014);
    while (parts.length > save) armour.push(parts.pop());
  }

  /* ── wrist cuff: the elastic band that says "glove", not "hand" ─────────── */
  if (cuff) {
    tang(0.0400, 0.0230, 0.0380, palmAz - 0.05, radius + 0.0060 + cuffOut, -spanY - 0.0400, 0.0075);
    tang(0.0420, 0.0090, 0.0400, palmAz - 0.05, radius + 0.0055 + cuffOut, -spanY - 0.0530, 0.0035);
  }

  // Canonical -> weapon space.
  const place = (g) => {
    if (axisRot) at(g, null, axisRot);
    if (rot) at(g, null, rot);
    at(g, origin);
    return g;
  };
  // aoScale WAS held at 0.38 because "the hands are the least-lit thing on the
  // weapon because none of their surfaces face the key", so a correct cavity bake
  // drove them black. That premise no longer holds: the support hand is now rolled
  // so its knuckles face the key (see the roll derivation at the M4A1 call site),
  // and the firing hand always caught the bounce lane. What the low value costs is
  // the thing the hand is now being judged on — with the crevices between the
  // phalanges and between adjacent fingers lifted almost flat, four wrapped digits
  // integrate into one smooth lozenge, which is why raising the albedo made the
  // hand read MUSHIER rather than clearer. Occlusion is what carves finger
  // segmentation, and segmentation is the whole read. 0.62 is the value that
  // separates the digits without reintroducing the black-mitten failure; it costs
  // nothing at runtime because the term is a vertex attribute that is already
  // interpolated for the lighting.
  for (const g of parts) b.add(place(g), mat, { group, uv: 0.042, wear: 0.35, aoScale: 0.62 });
  for (const g of armour) b.add(place(g), 'rubber', { group, uv: 0.022, wear: 0.5, aoScale: 0.55, occlude: false });
}

/**
 * Forearm running from a wrist point out toward the shoulder. Placed directly in
 * weapon space because that is the frame the constraint lives in: the firing hand
 * sits ~170 mm from the eye, and a forearm behind it long enough to look right
 * reaches straight through the 5 mm near plane and renders as a wall of glove.
 * The firing arm therefore gets a short stub; the support arm, 300 mm further down
 * the barrel, keeps its length.
 */
function forearm(b, { from, dir, length, r0 = 0.0250, r1 = 0.0330, mat = 'sleeve', group = null }) {
  const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
  // Aim a +Z-built lathe down `d`. laz() already normalised the axis to +Z, and
  // three's XYZ Euler composes as Rx·Ry·Rz, so (0,0,1) -> (sin y, -cos y sin p, cos y cos p).
  const yaw = Math.asin(THREE.MathUtils.clamp(d.x, -1, 1));
  const pitch = Math.atan2(-d.y, d.z);
  // The forearm is FATIGUE SLEEVE, not glove. Running it in the glove material made
  // it the palest object on the whole weapon — a bare, fat, tapered cylinder with an
  // open bright end cap, which reads as a length of pipe rather than an arm.
  // Fabric, not a pipe: a couple of gathered folds where the sleeve bunches at the
  // wrist and inside the elbow, so the silhouette has some incident in it.
  // TESSELLATION AND CREASE, both of which were wrong. At 12 segments a 33 mm
  // sleeve 200 mm from the eye showed a visibly faceted silhouette, and the
  // default 42-degree crease threshold split the profile's gather folds into hard
  // bands — so the arm shaded in flat horizontal stripes down its length, which is
  // exactly the "low tessellation with unsmoothed normals on a curved form" note.
  // 20 segments and a 70-degree crease: the barrel of the sleeve is now one smooth
  // surface and only the deliberate cuff steps stay sharp. The fold amplitudes are
  // halved too — cloth gathers, it does not corrugate.
  b.add(laz([
    [0.0001, 0], [r0, 0], [r0 * 1.03, length * 0.14], [r0 * 0.99, length * 0.20],
    [r0 * 1.05, length * 0.34], [r0 * 1.01, length * 0.40],
    [r1 * 0.96, length * 0.66], [r1 * 0.92, length * 0.72],
    [r1, length * 0.90], [r1 * 0.94, length], [0.0001, length],
  ], from, [pitch, yaw, 0], 20, 70), mat, { group, uv: 0.075, wear: 0.2, aoScale: 0.35 });
  // Glove gauntlet over the wrist, and the elastic band that closes it.
  b.add(laz([
    [r0 * 0.86, 0], [r0 * 1.06, 0.0030], [r0 * 1.10, 0.0300], [r0 * 0.90, 0.0330],
  ], from, [pitch, yaw, 0], 20, 70), 'glove', { group, uv: 0.035, wear: 0.25, occlude: false });
  b.add(laz([
    [r0 * 1.02, 0], [r0 * 1.16, 0.0020], [r0 * 1.16, 0.0120], [r0 * 1.02, 0.0140],
  ], [from[0] + d.x * 0.030, from[1] + d.y * 0.030, from[2] + d.z * 0.030],
  [pitch, yaw, 0], 20, 70), 'rubber', { group, uv: 0.03, wear: 0.2, occlude: false });
}

/* ─────────────────────────────── M4A1 ────────────────────────────────────── */

export function buildM4(surfaces) {
  const b = new PartBuilder(surfaces);

  // ONE UNBROKEN PLANE. On a real flat-top AR the upper receiver's top face and the
  // free-float handguard's top face are the same surface, and the rail runs across
  // both without a step. Before, the receiver top sat at 29.5 mm, the handguard top
  // at 26.5 mm, and the rail base was floated at 27.2 mm — so the rail was buried in
  // the receiver at one end and hovering over a 0.7 mm gap at the other, which reads
  // exactly as "the rail is beside the gun, not on it". These three constants now
  // derive from each other so that can never drift again.
  const DECK_Y = 0.0290;         // the shared top face of receiver + handguard
  const RAIL_H = 0.0062;         // rail stack height above the deck
  const RAIL_Y = DECK_Y + 0.0052; // top of the rail's islands — what sights sit on
  const OPTIC_Y = 0.0645;        // optical axis, ~64 mm over bore — lower 1/3 mount
  const UPPER_Z0 = 0.004;
  const UPPER_Z1 = -0.212;
  const HG_Z0 = -0.214;
  const HG_Z1 = -0.400;
  const HG_Y = DECK_Y - 0.0235;  // handguard axis, so its top face lands on the deck

  /* ── upper receiver ───────────────────────────────────────────────────── */
  b.add(at(box(0.0380, 0.0490, 0.208, 0.0030), [0, DECK_Y - 0.0245, (UPPER_Z0 + UPPER_Z1) / 2]), 'alloy', { uv: 0.075 });
  // Charging-handle shroud / rear ring.
  b.add(at(box(0.0400, 0.0455, 0.020, 0.0032), [0, DECK_Y - 0.02275, 0.010]), 'alloy', { uv: 0.06 });
  // Brass deflector — the raised wedge behind the ejection port. Steel, not alloy:
  // it is a separate hardened part on the real gun and reading it as a different
  // material is the point of modelling it at all.
  b.add(at(box(0.0100, 0.0190, 0.021, 0.0028), [0.0212, 0.0062, -0.0290], [0, 0, -0.26]), 'steel', { uv: 0.026 });
  // Forward assist.
  b.add(at(cyl(0.0072, 0.020, 0.0012, 14), [0.0225, -0.0055, -0.020], [0, Math.PI / 2, 0]), 'alloy', { uv: 0.028 });
  b.add(laz([
    [0.0001, 0], [0.0050, 0], [0.0050, 0.0090], [0.0038, 0.0104], [0.0001, 0.0104],
  ], [0.0295, -0.0055, -0.020], [0, Math.PI / 2, 0], 12), 'steel', { uv: 0.022 });

  // Ejection port: a recessed cavity, a raised port lip, and the hinged dust cover
  // hanging under it. Carbon-fouled — this is where the gas and the brass come out,
  // and on a used rifle it is the single dirtiest spot on the receiver.
  b.add(at(box(0.0035, 0.0225, 0.062, 0.0012), [0.0186, 0.0035, -0.062]), 'carbon', { uv: 0.035, aoScale: 1.5 });
  b.add(at(box(0.0055, 0.0038, 0.066, 0.0010), [0.0202, 0.0158, -0.062]), 'alloy', { uv: 0.03, occlude: false });
  b.add(at(box(0.0060, 0.0245, 0.068, 0.0016), [0.0210, -0.0125, -0.062], [0, 0, 0]), 'alloy', { group: 'dust', uv: 0.04 });
  // Bolt carrier visible in the port.
  b.add(at(cyl(0.0110, 0.070, 0.0010, 16), [0, 0.0035, -0.055], [0, 0, 0]), 'carbon', { group: 'bolt', uv: 0.03 });

  // Flat-top rail across the whole upper — same deck, same height, same profile as
  // the handguard rail, so the two form one continuous plane.
  railStrip(b, { z0: UPPER_Z0 + 0.002, z1: UPPER_Z1 + 0.004, y: DECK_Y, height: RAIL_H, mat: 'alloy' });

  /* ── charging handle ──────────────────────────────────────────────────────
   * Sits ~140 mm from the eye at the hip pose, which makes it one of the largest
   * things on screen — a single 48 x 9 mm plate for the latch wing therefore read
   * as a bare slab hanging off the back of the receiver. Built properly: a narrow
   * shaft in the receiver's channel, a raised centre body, two swept ears, and the
   * ambidextrous latch on the left.
   */
  // Shaft, sunk into the receiver's charging-handle channel.
  b.add(at(box(0.0196, 0.0058, 0.0450, 0.0010), [0, 0.0234, 0.0205]), 'alloy', { group: 'charge', uv: 0.035 });
  // Latch body — ONE tapered block, raked so its top face is not parallel to the
  // receiver deck. The previous build stacked a 47 mm wing, a 21 mm spine and the
  // shaft at three near-identical heights, all axis-aligned: at the ~140 mm this
  // part sits from the eye that is three parallel rectangular slabs cantilevered
  // off the back of the gun, which is precisely what came back from every critic.
  // Nothing here is coplanar with anything else now.
  // Rake kept shallow: at -0.10 rad this face sat almost normal to a very low sun
  // and returned a clipped white rectangle on an otherwise dark receiver.
  b.add(at(box(0.0232, 0.0118, 0.0250, 0.0030, 2), [0, 0.0214, 0.0372], [-0.035, 0, 0]),
    'alloy', { group: 'charge', uv: 0.026 });
  // Serrated thumb pad on top of the latch — breaks the flat face up so it can
  // never return one unbroken specular plate again, and it is real hardware.
  for (let i = 0; i < 4; i++) {
    b.add(at(box(0.0180, 0.0016, 0.0022, 0.0004), [0, 0.0274, 0.0318 + i * 0.0042], [-0.035, 0, 0]),
      'alloy', { group: 'charge', uv: 0.008, occlude: false });
  }
  // Two SEPARATE swept arms with rolled-up lips, not one slab across the back.
  for (const sx of [-1, 1]) {
    b.add(at(box(0.0150, 0.0058, 0.0180, 0.0022, 2), [sx * 0.0164, 0.0206, 0.0402], [0, 0, sx * -0.12]),
      'alloy', { group: 'charge', uv: 0.020 });
    b.add(at(box(0.0056, 0.0104, 0.0164, 0.0024, 2), [sx * 0.0238, 0.0218, 0.0402], [0, 0, sx * -0.22]),
      'alloy', { group: 'charge', uv: 0.018 });
  }
  // Ambi latch: a thumb tab on the left, the only part that stands proud.
  b.add(at(box(0.0058, 0.0104, 0.0132, 0.0016), [-0.0262, 0.0244, 0.0396], [0, 0, 0.22]), 'steel', { group: 'charge', uv: 0.018 });
  // Roll-pin head through the latch pivot.
  b.add(at(cyl(0.0018, 0.0210, 0.0004, 8), [-0.0150, 0.0230, 0.0372], [0, Math.PI / 2, 0]), 'steel', { group: 'charge', uv: 0.010, occlude: false });

  /* ── lower receiver ───────────────────────────────────────────────────── */
  b.add(at(box(0.0362, 0.0330, 0.200, 0.0028), [0, -0.0370, -0.098]), 'alloy', { uv: 0.075 });
  // Magazine well: flared, and deeper than the receiver body.
  b.add(at(box(0.0400, 0.0480, 0.0480, 0.0030), [0, -0.0420, -0.0790]), 'alloy', { uv: 0.06, aoScale: 1.2 });
  b.add(at(box(0.0430, 0.0110, 0.0530, 0.0026), [0, -0.0640, -0.0790]), 'alloy', { uv: 0.05, aoScale: 1.3 });
  // Takedown pin bosses.
  for (const z of [-0.010, -0.190]) {
    b.add(at(cyl(0.0060, 0.0400, 0.0010, 12), [0, -0.0300, z], [0, Math.PI / 2, 0]), 'alloy', { uv: 0.025 });
    b.add(at(cyl(0.0042, 0.0430, 0.0008, 10), [0, -0.0300, z], [0, Math.PI / 2, 0]), 'steel', { uv: 0.02, occlude: false });
  }

  // Controls: selector (left), mag release (right), bolt catch (left).
  b.add(at(box(0.0110, 0.0090, 0.0280, 0.0016), [-0.0225, -0.0300, -0.0230], [0, 0, 0.35]), 'steel', { group: 'selector', uv: 0.022 });
  b.add(at(cyl(0.0075, 0.0120, 0.0010, 12), [-0.0195, -0.0300, -0.0230], [0, Math.PI / 2, 0]), 'steel', { group: 'selector', uv: 0.02 });
  b.add(at(cyl(0.0058, 0.0110, 0.0010, 12), [0.0200, -0.0330, -0.0640], [0, Math.PI / 2, 0]), 'steel', { uv: 0.02 });
  b.add(at(box(0.0075, 0.0130, 0.0300, 0.0012), [-0.0205, -0.0350, -0.0540]), 'steel', { uv: 0.022 });
  b.add(at(box(0.0060, 0.0180, 0.0110, 0.0012), [-0.0205, -0.0300, -0.0670]), 'steel', { uv: 0.02 });

  // width: the docstring on triggerGroup() records that a 30 mm bow — the receiver's
  // own width — is what made the guard a solid slab with no daylight in it, and is
  // why three reviewers reported "no trigger guard" while looking straight at one.
  // That fix was applied to the DEFAULT PARAMETER only; both call sites kept passing
  // the broken value straight back in, so neither weapon ever received it. An AR
  // guard is ~9 mm across. This also restores the read the indexed trigger finger
  // depends on: the finger sits at x = +26.5 mm, and against a 30 mm bow spanning
  // +/-15 mm it had no visible loop to be indexed ALONGSIDE — it just floated next
  // to a block. Against a 9 mm bow the daylight inside the loop is what makes
  // "finger outside the guard" legible as a deliberate trigger discipline pose.
  const tg = triggerGroup(b, { zFront: -0.070, zBack: -0.030, yTop: -0.0520, yBot: -0.0810, width: 0.0092 });
  b.add(at(box(0.0075, 0.0230, 0.0075, 0.0010), [0, -0.0620, -0.0480], [0.22, 0, 0]), 'steel', { group: 'trigger', uv: 0.018 });

  /* ── pistol grip ──────────────────────────────────────────────────────── */
  {
    const gx = 0, gy = -0.0520, gz = -0.0125;
    const tilt = -0.42;
    b.add(at(box(0.0330, 0.1000, 0.0430, 0.0075, 2), [gx, gy - 0.048, gz], [tilt, 0, 0]), 'polymer', { uv: 0.05 });
    b.add(at(box(0.0350, 0.0180, 0.0460, 0.0060, 2), [gx, gy - 0.098, gz + 0.041], [tilt, 0, 0]), 'polymer', { uv: 0.04 });
    // Finger swells and the beavertail.
    for (let i = 0; i < 3; i++) {
      b.add(at(box(0.0342, 0.0110, 0.0090, 0.0035, 2),
        [gx, gy - 0.030 - i * 0.021, gz - 0.021 + i * 0.0092], [tilt, 0, 0]), 'polymer', { uv: 0.02, occlude: false });
    }
    b.add(at(box(0.0300, 0.0230, 0.0180, 0.0050, 2), [gx, gy - 0.006, gz + 0.026], [tilt + 0.5, 0, 0]), 'polymer', { uv: 0.03 });
  }

  /* ── buffer tube + stock ──────────────────────────────────────────────── */
  b.add(laz([
    [0.0001, 0], [0.0175, 0], [0.0175, 0.010], [0.0163, 0.012],
    [0.0163, 0.190], [0.0150, 0.194], [0.0001, 0.194],
  ], [0, -0.0075, 0.010], null, 20), 'alloy', { uv: 0.05 });
  // Castle nut + endplate.
  b.add(laz([
    [0.0165, 0], [0.0215, 0], [0.0215, 0.010], [0.0165, 0.010],
  ], [0, -0.0075, 0.012], null, 14), 'steel', { uv: 0.025 });
  // BUFFER-TUBE DETENTS. Six positions cut into the underside of the tube, which is
  // the one feature that says "collapsible stock" at a glance and the one the stock
  // rides on. Without them the tube is a smooth cylinder and the whole assembly
  // reads as a moulded bolster rather than a mechanism.
  for (let i = 0; i < 6; i++) {
    const z = 0.052 + i * 0.0225;
    b.add(at(box(0.0092, 0.0052, 0.0072, 0.0012), [0, -0.0232, z]), 'carbon',
      { uv: 0.014, occlude: false, aoScale: 1.5 });
  }

  // Collapsible stock. Built as an A-frame around the buffer tube rather than one
  // slab: a slim carrier body, an open gap under the comb, a raked butt and a toe
  // that drops below the tube. The slab version read as a brick from every angle.
  //
  // BEVELS. These shipped at 5.5 mm on a 30 mm-tall body — an 18% corner radius,
  // which is a foam bolster, not a glass-filled polymer moulding. Every critic who
  // looked at the lower-right quadrant used the same word for it. Real stock
  // furniture has a 1-2 mm break on its arrises: enough to catch the key, not
  // enough to eat the form. Dropping these is the single biggest change to the
  // silhouette in that corner of the frame.
  b.add(at(box(0.0420, 0.0300, 0.0880, 0.0022, 2), [0, -0.0060, 0.1170]), 'polymer', { uv: 0.06 });

  /* ── stock detailing ──────────────────────────────────────────────────────
   * THE LARGEST SINGLE SURFACE IN THE VIEWMODEL, and it used to be two boxes.
   *
   * The pose parks the stock across the bottom-right corner of every frame, so
   * what the player actually sees is the span z = 0.07..0.165 — its top face and
   * its LEFT flank — while the butt pad, the sling loops and the adjustment lever
   * all sat behind z = 0.17, i.e. off the bottom-right edge of the screen. All the
   * detail that existed was detail nobody could see, and the two boxes that WERE
   * on screen carried a single 2.2 mm corner break and nothing else: no parting
   * line, no second material, no hole in the silhouette, no hard chamfer facet.
   * A certifier called it "the largest single surface in the viewmodel and the
   * least detailed" and that was a fair reading of exactly this span.
   *
   * Everything below is placed to land INSIDE that span. The rule used: any
   * feature worth modelling on a stock is worth modelling at z < 0.165.
   */

  // 1. RISER BASE RAIL + POSTS. An adjustable comb does not sit flush on the stock
  //    body — it rides two posts with daylight under it. That gap is a hard shadow
  //    line running the whole length of the visible span, which is the single
  //    cheapest way to stop the top of the stock reading as one extrusion.
  b.add(at(box(0.0248, 0.0034, 0.0800, 0.0008, 2), [0, 0.0058, 0.1140]), 'alloy', { uv: 0.03 });
  for (const z of [0.0840, 0.1450]) {
    b.add(at(box(0.0104, 0.0120, 0.0118, 0.0012), [0, 0.0098, z]), 'steel', { uv: 0.018, aoScale: 1.25 });
  }
  // Height-index notches machined into the front post, left flank — the marks you
  // set the comb against. Tiny, but they say "mechanism" at magnification.
  for (let i = 0; i < 4; i++) {
    b.add(at(box(0.0016, 0.0014, 0.0090, 0.0003), [-0.0056, 0.0062 + i * 0.0026, 0.0840]), 'carbon',
      { uv: 0.008, occlude: false, aoScale: 1.4 });
  }

  // 2. CHEEK RISER. Narrower than the base rail so the rail's shoulders show, with
  //    a scalloped relief down each flank and a moulded parting line.
  b.add(at(box(0.0296, 0.0132, 0.0788, 0.0016, 2), [0, 0.0142, 0.1140]), 'polymer', { uv: 0.04 });
  for (const sx of [-1, 1]) {
    // Relief scallop: a recessed dark channel, not a painted line.
    b.add(at(box(0.0032, 0.0072, 0.0600, 0.0010), [sx * 0.0146, 0.0146, 0.1140]), 'carbon',
      { uv: 0.016, occlude: false, aoScale: 1.35 });
    // Moulding parting line along the bottom arris of the riser.
    b.add(at(box(0.0024, 0.0020, 0.0780, 0.0004), [sx * 0.0142, 0.0084, 0.1140]), 'polymer',
      { uv: 0.012, occlude: false });
  }

  // 3. CHEEK PAD — RUBBER. The comb is where a face goes, and every real one is
  //    faced in something softer and darker than the stock shell. This is the
  //    material break the visible span never had: matte, low-value rubber sitting
  //    on satin polymer, right where the eye lands.
  // NARROWER than the riser it sits on, on purpose: pad, polymer shoulder and
  // alloy base rail then read as three stacked materials down the visible edge of
  // the stock instead of one dark plane capping one light one.
  b.add(at(box(0.0244, 0.0062, 0.0760, 0.0012, 2), [0, 0.0228, 0.1145]), 'rubber', { uv: 0.024 });
  // Cross ribs moulded into the pad. Horizontal ribs on a horizontal face catch the
  // low key as a row of highlights, which is what makes the pad read as textured
  // rubber rather than a dark painted slab.
  for (let i = 0; i < 8; i++) {
    b.add(at(box(0.0230, 0.0026, 0.0038, 0.0006), [0, 0.0254, 0.0830 + i * 0.0088]), 'rubber',
      { uv: 0.010, occlude: false, aoScale: 1.30 });
  }
  // Stitched border, front and rear — a 1.4 mm welt around the pad edge.
  for (const z of [0.0774, 0.1516]) {
    b.add(at(box(0.0248, 0.0058, 0.0026, 0.0005), [0, 0.0230, z]), 'rubber',
      { uv: 0.009, occlude: false, aoScale: 1.25 });
  }
  // Riser lock lever on the left flank, where the camera is.
  b.add(at(box(0.0044, 0.0092, 0.0210, 0.0012, 2), [-0.0166, 0.0132, 0.0930], [0, 0, -0.24]), 'steel', { uv: 0.016 });
  b.add(at(cyl(0.0026, 0.0074, 0.0005, 10), [-0.0166, 0.0126, 0.1010], [0, Math.PI / 2, 0]), 'blued',
    { uv: 0.012, occlude: false });

  // 4. HARD CHAMFER FACETS ON THE BODY ARRISES. A rounded-box corner radius reads
  //    as soft at any magnification because its normal sweeps continuously; a real
  //    moulding has a FLAT 45-degree land whose normal is constant, and that land
  //    fires as one bright line under a low key. Both top arrises get one, and the
  //    two lower arrises get a shallower one so the flank has a bottom edge.
  for (const sx of [-1, 1]) {
    b.add(at(box(0.0046, 0.0046, 0.0876, 0.0005), [sx * 0.0190, 0.0072, 0.1170], [0, 0, Math.PI / 4]),
      'polymer', { uv: 0.026, occlude: false });
    b.add(at(box(0.0032, 0.0032, 0.0876, 0.0004), [sx * 0.0196, -0.0192, 0.1170], [0, 0, Math.PI / 4]),
      'polymer', { uv: 0.022, occlude: false });
  }

  // 5. FLANK PANEL + LIGHTENING CUTS. The body flank is the second-largest surface
  //    in the corner of the frame. A recessed carbon panel inside a raised polymer
  //    bezel gives it a value break and a real depth cue; the three slots below it
  //    are the lightening cuts every polymer stock has.
  for (const sx of [-1, 1]) {
    b.add(at(box(0.0030, 0.0180, 0.0560, 0.0010), [sx * 0.0206, -0.0052, 0.1150]), 'carbon',
      { uv: 0.018, occlude: false, aoScale: 1.40 });
    for (let i = 0; i < 3; i++) {
      b.add(at(box(0.0024, 0.0044, 0.0128, 0.0006), [sx * 0.0208, -0.0166, 0.0930 + i * 0.0225]), 'carbon',
        { uv: 0.012, occlude: false, aoScale: 1.45 });
    }
  }

  // 6. SLING LOOP — a real loop with a real hole through it. A hole in the
  //    silhouette is worth more than any amount of surface detail: it is the one
  //    thing that cannot be faked by a texture, and it sits at z = 0.098, inside
  //    the visible span, instead of at 0.088 UNDER the body where the old pair of
  //    solid tabs were invisible.
  for (const sx of [-1, 1]) {
    // Mounting lug the loop pivots in.
    b.add(at(box(0.0052, 0.0128, 0.0150, 0.0014), [sx * 0.0218, -0.0058, 0.0980]), 'steel', { uv: 0.016 });
    try {
      const ring = new THREE.TorusGeometry(0.0082, 0.0019, 6, 16);
      ring.rotateY(Math.PI / 2);
      at(ring, [sx * 0.0250, -0.0130, 0.0980]);
      b.add(ring, 'steel', { uv: 0.014, aoScale: 1.2 });
    } catch (err) { /* torus is optional detail, never fatal */ }
  }
  // Webbing tail through the left loop, folded and stitched back on itself. Two
  // centimetres of strap is all it takes to say "this weapon belongs to somebody".
  b.add(at(box(0.0038, 0.0250, 0.0148, 0.0008, 2), [-0.0262, -0.0250, 0.0980], [0.10, 0, 0.18]), 'glove',
    { uv: 0.014, wear: 0.5, aoScale: 0.9 });
  b.add(at(box(0.0030, 0.0044, 0.0152, 0.0005), [-0.0268, -0.0338, 0.0982], [0.10, 0, 0.18]), 'glove',
    { uv: 0.010, wear: 0.5, occlude: false });

  // 7. ADJUSTMENT LATCH. The release paddle wraps up onto the flank so the shooter
  //    can reach it from a firing grip — and, not incidentally, so it is on screen.
  //    Knurled front edge, visible pivot pin, and a raked body.
  b.add(at(box(0.0052, 0.0250, 0.0330, 0.0014, 2), [-0.0212, -0.0088, 0.1400], [0.16, 0, 0]), 'polymer', { uv: 0.024 });
  for (let i = 0; i < 5; i++) {
    b.add(at(box(0.0026, 0.0210, 0.0022, 0.0004), [-0.0234, -0.0086, 0.1300 + i * 0.0044], [0.16, 0, 0]), 'carbon',
      { uv: 0.009, occlude: false, aoScale: 1.4 });
  }
  b.add(at(cyl(0.0030, 0.0090, 0.0006, 10), [-0.0218, -0.0016, 0.1518], [0, Math.PI / 2, 0]), 'steel',
    { uv: 0.012, occlude: false });

  // Lower strut running back to the toe — this is the open A-frame.
  b.add(at(box(0.0300, 0.0150, 0.0680, 0.0018, 2), [0, -0.0320, 0.1420], [0.22, 0, 0]), 'polymer', { uv: 0.04 });
  // Butt plate carrier, raked back the way a collapsible stock is.
  b.add(at(box(0.0400, 0.0740, 0.0220, 0.0022, 2), [0, -0.0180, 0.1740], [-0.10, 0, 0]), 'polymer', { uv: 0.05 });
  // QD sling socket in the butt, opposite side to the loop.
  b.add(at(cyl(0.0068, 0.0055, 0.0010, 12), [-0.0205, -0.0250, 0.1660], [0, Math.PI / 2, 0]), 'steel', { uv: 0.018 });
  b.add(at(cyl(0.0036, 0.0075, 0.0008, 10), [-0.0212, -0.0250, 0.1660], [0, Math.PI / 2, 0]), 'blued',
    { uv: 0.014, occlude: false });
  // Butt pad. RUBBER, and it has to READ as rubber — this is the one place on the
  // stock where a distinctly darker, matte material meets the polymer, and that
  // value break is most of what stops the butt reading as one moulded lump. Given
  // its own horizontal ribs, which is what a recoil pad actually has, plus a heel
  // and a toe that stand proud of the pad face the way a moulded recoil pad does.
  b.add(at(box(0.0400, 0.0780, 0.0140, 0.0018, 2), [0, -0.0180, 0.1890], [-0.10, 0, 0]), 'rubber', { uv: 0.035 });
  for (let i = 0; i < 4; i++) {
    b.add(at(box(0.0404, 0.0044, 0.0038, 0.0008), [0, -0.0440 + i * 0.0175, 0.1948 + i * 0.0018], [-0.10, 0, 0]),
      'rubber', { uv: 0.012, occlude: false, aoScale: 1.3 });
  }
  // Heel (top) and toe (bottom) caps: a recoil pad is thickest at its ends.
  b.add(at(box(0.0392, 0.0110, 0.0192, 0.0022, 2), [0, 0.0176, 0.1902], [-0.10, 0, 0]), 'rubber', { uv: 0.016 });
  b.add(at(box(0.0380, 0.0120, 0.0206, 0.0026, 2), [0, -0.0544, 0.1924], [-0.10, 0, 0]), 'rubber', { uv: 0.016 });
  // Adjustment detent rail under the tube.
  b.add(at(box(0.0090, 0.0060, 0.1500, 0.0012), [0, -0.0270, 0.1100]), 'alloy', { uv: 0.03, occlude: false });

  /* ── free-float handguard ─────────────────────────────────────────────── */
  {
    const zc = (HG_Z0 + HG_Z1) / 2;
    const len = Math.abs(HG_Z1 - HG_Z0);
    // Octagonal body: a square core plus four chamfer flanks. HG_Y is derived from
    // the deck, so the top face is exactly the receiver's top face.
    b.add(at(box(0.0470, 0.0470, len, 0.0060, 2), [0, HG_Y, zc]), 'alloy', { uv: 0.075 });
    b.add(at(box(0.0330, 0.0330, len * 0.995, 0.0040, 2), [0, HG_Y, zc], [0, 0, Math.PI / 4]), 'alloy', { uv: 0.06, occlude: false });
    // Barrel-nut collar at the rear.
    b.add(laz([
      [0.0210, 0], [0.0272, 0], [0.0272, 0.020], [0.0210, 0.020],
    ], [0, HG_Y, HG_Z0 - 0.020], null, 20), 'alloy', { uv: 0.04 });
    // M-LOK slot rows: three per flank, cut as recessed inserts.
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const z = HG_Z0 - 0.024 - i * 0.030;
        b.add(at(box(0.0022, 0.0105, 0.0220, 0.0006), [sx * 0.0240, HG_Y, z]), 'carbon', { uv: 0.02, occlude: false, aoScale: 1.4 });
      }
    }
    for (let i = 0; i < 5; i++) {
      const z = HG_Z0 - 0.024 - i * 0.030;
      b.add(at(box(0.0105, 0.0022, 0.0220, 0.0006), [0, HG_Y - 0.0236, z]), 'carbon', { uv: 0.02, occlude: false, aoScale: 1.4 });
    }
    // Continuous top rail, co-planar with the receiver rail.
    railStrip(b, { z0: HG_Z0 + 0.002, z1: HG_Z1, y: DECK_Y, height: RAIL_H, mat: 'alloy' });
    // Short bottom rail at the front for a grip/light.
    railStrip(b, { z0: HG_Z1 + 0.004, z1: HG_Z1 + 0.052, y: -(HG_Y - 0.0235), height: RAIL_H, roll: Math.PI, mat: 'alloy' });
    // QD sling socket.
    b.add(at(cyl(0.0070, 0.0060, 0.0010, 12), [-0.0245, HG_Y - 0.0090, HG_Z1 + 0.030], [0, Math.PI / 2, 0]), 'steel', { uv: 0.02 });
    b.add(at(cyl(0.0038, 0.0080, 0.0008, 10), [-0.0250, HG_Y - 0.0090, HG_Z1 + 0.030], [0, Math.PI / 2, 0]), 'blued', { uv: 0.015, occlude: false });
  }

  /* ── gas block, barrel, muzzle device ─────────────────────────────────── */
  // Everything from the gas block forward runs hot and sooty. Splitting the
  // materials here — parkerised steel under, carbon over the ports and the crown —
  // is the cheapest wear story on the gun and the most legible.
  b.add(at(box(0.0230, 0.0245, 0.0330, 0.0022), [0, 0.0010, HG_Z1 - 0.020]), 'blued', { uv: 0.035 });
  b.add(at(box(0.0236, 0.0100, 0.0150, 0.0016), [0, 0.0090, HG_Z1 - 0.020]), 'carbon', { uv: 0.02, occlude: false });
  b.add(at(cyl(0.0042, 0.150, 0.0006, 12), [0, 0.0125, HG_Z1 + 0.070]), 'blued', { uv: 0.02, occlude: false });
  // Barrel: profile step from the gas journal down to the muzzle threads.
  // Barrel: profile runs REARWARD from the crown, so the breech end butts into the
  // gas block instead of leaving a 115 mm hole where the barrel should be.
  b.add(laz([
    [0.0001, 0], [0.0113, 0], [0.0113, 0.006], [0.0096, 0.010],
    [0.0096, 0.086], [0.0088, 0.090], [0.0088, 0.116], [0.0001, 0.116],
  ], [0, 0, HG_Z1 - 0.152], null, 20), 'blued', { uv: 0.04 });

  // A2 birdcage flash hider with its slots and the crush washer.
  const MUZZLE_Z = HG_Z1 - 0.152 + 0.004;
  b.add(laz([
    [0.0088, 0], [0.0125, 0], [0.0125, 0.006], [0.0110, 0.008],
    [0.0110, 0.030], [0.0122, 0.032], [0.0122, 0.046], [0.0104, 0.050],
    [0.0072, 0.050], [0.0072, 0.046], [0.0072, 0],
  ], [0, 0, MUZZLE_Z - 0.050], null, 20), 'carbon', { uv: 0.03 });
  // Prongs / port cuts.
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI * 0.5 + (i - 2) * 0.62;
    b.add(at(box(0.0038, 0.0090, 0.0180, 0.0006),
      [Math.cos(a) * 0.0118, Math.sin(a) * 0.0118, MUZZLE_Z - 0.028],
      [0, 0, a + Math.PI / 2]), 'carbon', { uv: 0.014, occlude: false });
  }
  // Crush washer — bare steel, and it stays bare because it is behind the blast.
  b.add(laz([
    [0.0090, 0], [0.0126, 0], [0.0126, 0.0030], [0.0090, 0.0034],
  ], [0, 0, MUZZLE_Z - 0.0034], null, 18), 'steel', { uv: 0.018, occlude: false });
  const muzzleTipZ = MUZZLE_Z - 0.050;

  /* ── back-up iron sights, FOLDED ──────────────────────────────────────────
   * Both BUIS are modelled deployed-flat, which is the only correct configuration
   * with an optic on the rail — and it is also the only one that works visually:
   * a standing rear aperture sits at 59 mm over bore, the optic's tube floor is at
   * 49 mm, so an upright blade parks itself squarely in the middle of the sight
   * picture. Verified by screenshot; the folded package clears the tube by 6 mm.
   */
  // Rear: hinge base plus the aperture leaf lying back along the rail.
  b.add(at(box(0.0210, 0.0055, 0.0280, 0.0010), [0, RAIL_Y + 0.0028, -0.0120]), 'steel', { uv: 0.025 });
  b.add(at(box(0.0170, 0.0048, 0.0225, 0.0010), [0, RAIL_Y + 0.0076, -0.0040], [0.06, 0, 0]), 'steel', { uv: 0.022 });
  b.add(at(box(0.0064, 0.0038, 0.0070, 0.0008), [0, RAIL_Y + 0.0106, 0.0028]), 'blued', { uv: 0.012, occlude: false });
  b.add(at(box(0.0044, 0.0090, 0.0044, 0.0008), [-0.0118, RAIL_Y + 0.0058, -0.0180]), 'steel', { uv: 0.012, occlude: false });
  // Front: folded post tower on the handguard rail.
  b.add(at(box(0.0200, 0.0060, 0.0230, 0.0010), [0, RAIL_Y + 0.0030, HG_Z1 + 0.0240]), 'steel', { uv: 0.025 });
  b.add(at(box(0.0165, 0.0052, 0.0210, 0.0010), [0, RAIL_Y + 0.0082, HG_Z1 + 0.0330], [-0.05, 0, 0]), 'steel', { uv: 0.02 });
  b.add(at(box(0.0032, 0.0034, 0.0180, 0.0006), [0, RAIL_Y + 0.0116, HG_Z1 + 0.0330]), 'blued', { uv: 0.014, occlude: false });

  /* ── optic ────────────────────────────────────────────────────────────── */
  const optic = redDot(b, surfaces, { railY: RAIL_Y, zc: -0.070, opticY: OPTIC_Y });

  /* ── magazine ─────────────────────────────────────────────────────────── */
  const mag = magazine(b, {
    group: 'mag', topY: -0.0640, topZ: -0.0790,
    w: 0.0250, d: 0.0385, length: 0.180, curve: 0.16, tilt: 0.055, segments: 9,
  });

  /* ── hands ────────────────────────────────────────────────────────────────
   * The single highest-value thing in this file. A rifle with no hands on it reads
   * as a tech demo in under a second, and no amount of shader work buys that back.
   *
   * Firing hand: wrapped around the pistol grip, canonical frame tilted onto the
   * grip's own axis, trigger finger reaching around the front of the grip to the
   * blade. Short wrist stub only — see forearm() for why.
   */
  gripHand(b, {
    origin: [0, -0.0665, -0.0255], axisRot: [-0.42, 0, 0], side: 1, group: 'handR',
    // The grip is a 33 x 43 mm section, so its surface sits between 0.0165 (flanks)
    // and 0.0215 (front/back). 0.0182 wraps inside the flanks and just proud of the
    // front, which is a hand squeezing a grip rather than resting a ring on it.
    radius: 0.0182, startAz: 1.52, fingerPitch: 0.0198, wrap: 1.0,
    palmAz: 0.40, thumbAz: -0.88, thumbRise: 0.012, cuffOut: 0.0016,
    // The firing thumb WRAPS the grip, it does not run up it: negative sweep and a
    // short length reproduce the two-block shape this hand shipped with while the
    // rebuilt thumb gives it a third phalanx and a knuckle cap. Running it forward
    // like the support thumb would drive the tip into the receiver.
    thumbLen: 0.55, thumbSweep: -1.9,
    // Trigger finger indexed along the outside of the guard, not on the trigger.
    indexOut: 0.92,
  });
  forearm(b, {
    from: [0.0093, -0.1600, 0.0430], dir: [0.26, -0.52, 0.81], length: 0.048,
    r0: 0.0272, r1: 0.0316, group: 'handR',
  });

  // Support hand: C-clamp on the handguard. The canonical frame is rotated so the
  // grip axis lies along the bore, then rolled so the palm is under-left and the
  // fingers come up the right flank — clear of the top rail, which is where a real
  // support hand has to be for the optic to be usable.
  // ROLL MATTERS MORE THAN ANYTHING ELSE ON THIS HAND. After axisRot the canonical
  // azimuth origin is straight up, and side = -1 starts the fingers on the weapon's
  // left flank; the old +2.34 rad then carried them round to the lower RIGHT, which
  // parks the entire hand — knuckles, thumb, cuff — on the far side of the receiver
  // from a camera that sits above and to the left. The hand was modelled, wrapped
  // and lit, and none of it was ever on screen. At +1.05 the knuckle ridge and the
  // armour caps face up-left into the camera and the fingers close away from it,
  // which is both the correct C-clamp and the one orientation that reads.
  // CLOSE THE GRIP. `radius` is where the fingers' inner faces land, and it shipped
  // at 0.0266 against a handguard whose surface is at 0.0235 (a 47 mm octagon) — so
  // every finger orbited the tube with a 3 mm air gap under it and an 11.7 mm gap
  // from the tube axis to the fingertip centreline. At native resolution that gap
  // let sunlit background through the slots between the digits, which is why the
  // hand read as four detached pips floating near the gun rather than holding it.
  // 0.0207 buries each distal phalanx ~2.8 mm into the handguard, so the glove
  // deforms around it and the contact is visible. `cuffOut` keeps the wrist band
  // out at its original radius, since it hangs off the end of the handguard and has
  // nothing to press into.
  // ROLL, SOLVED RATHER THAN SWEPT. Every previous value here was picked by looking
  // at a render and guessing which way to nudge, which is why it has been 2.34, then
  // 1.05, then 0.45, and read as "a dark low-contrast mass" at all three. The frame
  // is small enough to just solve.
  //
  // With side = -1 and the canonical frame rotated by axisRot, a part at azimuth `a`
  // radians lands at screen-plane bearing THETA = 90 deg + a, measured CCW from
  // weapon-up. That one identity makes the whole hand predictable:
  //
  //     thumb   a=-0.92 -> 37 deg (up-right)      heel    a= 0.26 -> 105 deg
  //     cuff    a= 0.37 -> 111 deg                palm    a= 0.42 -> 114 deg
  //     fingers a= 1.56 -> 179 deg, wrapping to ~273 deg (left, round the bottom)
  //     knuckle ridge and armour caps: a = 1.72..2.00 -> 188..205 deg
  //
  // `rot[2]` adds directly to THETA. The camera sits above and to the LEFT, so the
  // readable quadrant is roughly 110-160 deg. At the shipped +0.45 (+26 deg) the
  // knuckles sat at 214 deg and the armour at 216-230 — squarely UNDER the handguard,
  // occluded by the very part the hand is holding — and the only things left in the
  // readable quadrant were the palm (140) and the cuff (137). A palm and a wrist band
  // with no knuckles and no fingers between them is precisely "a featureless rounded
  // mass", and that is what three critics in a row reported.
  //
  // -0.85 rad (-49 deg) puts the knuckle ridge at 140 deg and the four armour caps at
  // 142-156, dead centre of the readable quadrant, with the finger chain running from
  // 130 deg down across the near flank to 224 — so the digits are seen along their
  // length instead of end-on. Palm, thumb and cuff go to 66/-11/63 deg, behind the
  // handguard from this camera, which is where the hollow end of the cuff belongs.
  //
  // SECOND, LARGER WIN: the viewmodel key sits at (-0.62, 0.90, 0.34) in camera space,
  // i.e. it lights surfaces facing up-and-left. The knuckles were previously not just
  // hidden but facing 214 deg — directly away from the key, lit only by the bounce
  // lane. Rolling them to 140 deg turns them to face the key. The hands come out of
  // the shadow floor because they are now ORIENTED INTO THE LIGHT, which costs nothing,
  // rather than because a light or an albedo was pushed up, which costs contrast
  // everywhere else.
  //
  // THIRD PASS — THE THUMB. The roll solve above put the knuckles and the finger
  // chain into the readable quadrant and left the thumb at THETA = -11 deg, i.e.
  // behind the handguard, invisible. Since the same identity that placed the
  // knuckles also places the thumb, it can be solved rather than nudged:
  //
  //     THETA = 90 deg + a + rot[2],  rot[2] = -0.85 rad = -49 deg
  //     want THETA ~ 112 deg (near side, just ahead of the 140 deg knuckle ridge)
  //     ->  a = 112 - 90 + 49 = 71 deg = 1.234 rad
  //
  // On a C-clamp the thumb lies ALONG the handguard pointing at the muzzle, and
  // after axisRot the canonical +Y axis is exactly that direction, so a longer
  // thumb (thumbLen 1.18) started further forward (thumbRise 0.020) runs down the
  // near flank toward the muzzle. That forward run is what tells the eye which way
  // round the hand is, and it is the feature the certifier reported missing.
  gripHand(b, {
    origin: [0, HG_Y, -0.2760], axisRot: [-Math.PI / 2, 0, 0], rot: [0, 0, -0.85],
    side: -1, group: 'handL', radius: 0.0207, startAz: 1.56, fingerPitch: 0.0210,
    // thumbRise 0.030 starts the digit 30 mm forward of the metacarpal band so it
    // clears the back of the hand instead of merging into it; at thumbLen 1.18 the
    // 72 mm thumb reaches z = -0.355, still 45 mm short of the handguard's front
    // face at -0.400. It lies ON the handguard pointing at the muzzle.
    wrap: 1.0, palmAz: 0.42, thumbAz: 1.234, thumbRise: 0.030, cuffOut: 0.0059,
    thumbLen: 1.18, thumbSweep: 0.55,
  });
  // The support arm has to LEAVE the frame, not cross it. Raked steeply down-left,
  // it exits past the bottom edge at ~80% instead of filling the lower-left third
  // with a featureless tube of fabric.
  // Raked steeply down-left so it exits the bottom edge instead of crossing the
  // frame. The old aim carried 0.60 of its length REARWARD, i.e. straight at the
  // lens, which presented the sleeve's near end disc to the camera as a hollow
  // ellipse — you could see into the tube. Dropping the +Z component and steepening
  // the descent puts that cap below the frame edge and leaves only the barrel of
  // the sleeve in shot, which is what an arm looks like from inside a helmet.
  // Wrist junction follows the hand. With the grip rolled to -0.85 the cuff now sits
  // at ~63 deg (up-right), i.e. on the FAR side of the handguard from the camera, so
  // the sleeve has to arrive there from underneath and disappear behind the tube
  // rather than stopping short of it in open air. Lifting the start 11 mm and moving
  // it 4.5 mm inboard puts the sleeve's near end INSIDE the handguard's 23.5 mm
  // radius, so the arm reads as passing behind the weapon and the hand reads as
  // sitting on top of it. Same rake, so it still exits the bottom frame edge instead
  // of crossing the shot.
  forearm(b, {
    from: [-0.0120, HG_Y - 0.0165, -0.2080], dir: [-0.30, -0.88, 0.37], length: 0.205,
    r0: 0.0262, r1: 0.0344, group: 'handL',
  });

  /* ── markings ─────────────────────────────────────────────────────────── */
  const marks = surfaces.markings([
    'COLT DEFENSE LLC',
    'M4A1 CARBINE',
    'CAL 5.56 MM  W1042871',
  ], 512, 128);

  const built = b.build('M4A1', { radius: 0.075, strength: 1.40, minAo: 0.11 });
  const root = built.root;

  if (marks) {
    // On the LEFT flank of the upper receiver, not the magwell: at the hip pose the
    // camera sits above and to the left of the weapon, and the magwell is below the
    // bottom of the frame. Roll marks nobody can see are not detail.
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.070, 0.0170), marks);
    plane.position.set(-0.0194, 0.0035, -0.1080);
    plane.rotation.y = -Math.PI / 2;
    plane.frustumCulled = false;
    root.add(plane);
  }

  root.add(optic.lensFront, optic.lensRear, optic.reticle);
  if (optic.reticleGhost) root.add(optic.reticleGhost);

  return finish({
    id: 'rifle',
    root,
    groups: built.groups,
    optic,
    opticY: OPTIC_Y,
    muzzleZ: muzzleTipZ,
    ejectPort: [0.0230, 0.0040, -0.0620],
    magPivot: [0, -0.0560, -0.0700],
    magTop: [0, -0.0640, -0.0790],
    magSize: [0.026, 0.190, 0.040],
    chargePivot: [0, 0.0225, 0.030],
    // Support-hand wrist, on the handguard axis where gripHand() built it.
    handLPivot: [0, HG_Y, -0.2860],
    // Where that wrist has to arrive to strip and seat a magazine, and to run the
    // charging handle on an empty reload. Weapon space, both read by index.js.
    handLMag: [0.010, -0.0940, -0.0840],
    handLCharge: [-0.020, 0.0180, 0.0340],
    triangles: b.stats?.triangles ?? 0,
  });
}

/* ─────────────────────────────── MP5A3 ───────────────────────────────────── */

export function buildMP5(surfaces) {
  const b = new PartBuilder(surfaces);

  // Same deck discipline as the M4: the claw-mount adapter's top face IS the rail
  // mounting plane, and RAIL_Y is derived from it rather than guessed at.
  const DECK_Y = 0.0255;
  const RAIL_Y = DECK_Y + 0.0052;
  const OPTIC_Y = 0.0610;
  const REC_Z0 = 0.010;
  const REC_Z1 = -0.190;

  /* ── stamped receiver: rounded, not slab-sided ────────────────────────── */
  b.add(laz([
    [0.0001, 0], [0.0185, 0], [0.0185, 0.200], [0.0001, 0.200],
  ], [0, 0.0020, REC_Z1], null, 22), 'steel', { uv: 0.07 });
  b.add(at(box(0.0372, 0.0300, 0.200, 0.0035, 2), [0, -0.0010, (REC_Z0 + REC_Z1) / 2]), 'steel', { uv: 0.07 });
  // The three signature receiver ribs.
  for (const z of [-0.040, -0.088, -0.136]) {
    b.add(at(lathe([
      [0.0180, 0], [0.0206, 0.0016], [0.0206, 0.0080], [0.0180, 0.0096],
    ], 20), [0, 0.0020, z]), 'steel', { uv: 0.02, occlude: false });
  }
  // Ejection port, right side, with the deflector lip.
  b.add(at(box(0.0035, 0.0210, 0.052, 0.0012), [0.0176, 0.0055, -0.0500]), 'carbon', { uv: 0.03, aoScale: 1.5 });
  b.add(at(box(0.0075, 0.0110, 0.0140, 0.0022), [0.0195, 0.0170, -0.0260], [0, 0, -0.30]), 'steel', { uv: 0.024 });
  b.add(at(cyl(0.0100, 0.060, 0.0010, 16), [0, 0.0055, -0.050]), 'carbon', { group: 'bolt', uv: 0.03 });

  // Rail over the receiver (claw-mount adapter).
  b.add(at(box(0.0280, 0.0080, 0.150, 0.0016), [0, 0.0215, -0.0800]), 'alloy', { uv: 0.05 });
  railStrip(b, { z0: -0.010, z1: -0.150, y: DECK_Y, height: 0.0062, mat: 'alloy' });

  /* ── cocking-handle tube along the top-left of the barrel ─────────────── */
  b.add(laz([
    [0.0001, 0], [0.0130, 0], [0.0130, 0.150], [0.0001, 0.150],
  ], [-0.0125, 0.0180, -0.345], null, 18), 'steel', { uv: 0.045 });
  // Cocking handle itself.
  b.add(at(box(0.0140, 0.0130, 0.0480, 0.0022), [-0.0250, 0.0180, -0.3060], [0, 0, -0.20]), 'steel', { group: 'charge', uv: 0.03 });
  b.add(at(box(0.0170, 0.0150, 0.0170, 0.0030), [-0.0330, 0.0170, -0.3280]), 'steel', { group: 'charge', uv: 0.026 });

  /* ── handguard ────────────────────────────────────────────────────────── */
  {
    const z0 = -0.204, z1 = -0.352;
    const zc = (z0 + z1) / 2;
    b.add(laz([
      [0.0001, 0], [0.0210, 0], [0.0230, 0.010], [0.0230, 0.128],
      [0.0205, 0.140], [0.0180, 0.148], [0.0001, 0.148],
    ], [0, -0.0020, z1], null, 22), 'polymer', { uv: 0.06 });
    // Finger grooves.
    for (let i = 0; i < 4; i++) {
      b.add(at(lathe([
        [0.0206, 0], [0.0230, 0.0020], [0.0230, 0.0090], [0.0206, 0.0110],
      ], 20), [0, -0.0020, z0 - 0.020 - i * 0.028]), 'polymer', { uv: 0.02, occlude: false });
    }
    // Sling swivel.
    b.add(at(cyl(0.0060, 0.0070, 0.0010, 12), [-0.0225, -0.0060, z1 + 0.020], [0, Math.PI / 2, 0]), 'steel', { uv: 0.018 });
  }

  /* ── barrel, front sight ring, muzzle ─────────────────────────────────── */
  b.add(at(lathe([
    [0.0001, 0], [0.0090, 0], [0.0090, 0.052], [0.0078, 0.056],
    [0.0078, 0.070], [0.0001, 0.070],
  ], 18), [0, 0, -0.424]), 'blued', { uv: 0.03 });
  // Hooded front sight.
  b.add(at(lathe([
    [0.0100, 0], [0.0175, 0], [0.0175, 0.0180], [0.0100, 0.0180],
  ], 20), [0, 0, -0.3900]), 'steel', { uv: 0.03 });
  b.add(at(box(0.0030, 0.0165, 0.0032, 0.0006), [0, 0.0100, -0.3810]), 'blued', { uv: 0.012, occlude: false });
  // Three-lug muzzle.
  b.add(at(lathe([
    [0.0072, 0], [0.0104, 0], [0.0104, 0.014], [0.0088, 0.016],
    [0.0088, 0.024], [0.0068, 0.024],
  ], 18), [0, 0, -0.4480]), 'carbon', { uv: 0.024 });
  for (let i = 0; i < 3; i++) {
    const a = i * (Math.PI * 2 / 3) + 0.4;
    b.add(at(box(0.0060, 0.0035, 0.0110, 0.0006),
      [Math.cos(a) * 0.0100, Math.sin(a) * 0.0100, -0.4400], [0, 0, a]), 'blued', { uv: 0.012, occlude: false });
  }
  const muzzleTipZ = -0.4720;

  /* ── drum rear sight ──────────────────────────────────────────────────────
   * Sits ahead of and below the optic. The tube floor is at 45 mm over bore, so
   * the drum's crown is deliberately capped at 43 mm — an HK rotary drum at its
   * real height would bisect the sight picture.
   */
  b.add(at(lathe([
    [0.0001, 0], [0.0092, 0], [0.0092, 0.0094], [0.0080, 0.0108], [0.0001, 0.0108],
  ], 18), [0, RAIL_Y + 0.0016, -0.1620], [0, 0, 0]), 'steel', { uv: 0.022 });
  b.add(at(box(0.0210, 0.0110, 0.0105, 0.0014), [0, RAIL_Y + 0.0006, -0.1620]), 'steel', { uv: 0.022 });

  /* ── lower / trigger group ────────────────────────────────────────────── */
  b.add(at(box(0.0350, 0.0330, 0.130, 0.0035, 2), [0, -0.0300, -0.0500]), 'polymer', { uv: 0.06 });
  b.add(at(box(0.0380, 0.0230, 0.0480, 0.0035, 2), [0, -0.0240, -0.1180]), 'polymer', { uv: 0.05, aoScale: 1.2 });
  // Same slab bug as the M4A1 call site above — see the note there. An MP5 guard is
  // a touch narrower than an AR's.
  triggerGroup(b, { zFront: -0.055, zBack: -0.018, yTop: -0.0440, yBot: -0.0700, width: 0.0088 });
  b.add(at(box(0.0075, 0.0210, 0.0075, 0.0010), [0, -0.0520, -0.0340], [0.22, 0, 0]), 'steel', { group: 'trigger', uv: 0.018 });
  // Ambi selector paddle.
  b.add(at(box(0.0130, 0.0085, 0.0300, 0.0016), [-0.0195, -0.0230, -0.0170], [0, 0, 0.28]), 'polymer', { group: 'selector', uv: 0.022 });
  b.add(at(cyl(0.0080, 0.0110, 0.0010, 12), [-0.0180, -0.0230, -0.0170], [0, Math.PI / 2, 0]), 'polymer', { group: 'selector', uv: 0.02 });
  // Mag release paddle behind the well.
  b.add(at(box(0.0110, 0.0180, 0.0090, 0.0016), [-0.0190, -0.0300, -0.0900]), 'steel', { uv: 0.02 });

  /* ── pistol grip ──────────────────────────────────────────────────────── */
  {
    const gy = -0.0430, gz = -0.0060, tilt = -0.38;
    b.add(at(box(0.0330, 0.0960, 0.0430, 0.0075, 2), [0, gy - 0.048, gz], [tilt, 0, 0]), 'polymer', { uv: 0.05 });
    b.add(at(box(0.0350, 0.0170, 0.0460, 0.0060, 2), [0, gy - 0.094, gz + 0.038], [tilt, 0, 0]), 'polymer', { uv: 0.04 });
    for (let i = 0; i < 3; i++) {
      b.add(at(box(0.0342, 0.0110, 0.0090, 0.0035, 2),
        [0, gy - 0.028 - i * 0.021, gz - 0.020 + i * 0.0090], [tilt, 0, 0]), 'polymer', { uv: 0.02, occlude: false });
    }
  }

  /* ── retractable stock ────────────────────────────────────────────────── */
  b.add(laz([
    [0.0001, 0], [0.0150, 0], [0.0150, 0.030], [0.0135, 0.034], [0.0001, 0.034],
  ], [0, 0.0020, 0.010], null, 18), 'steel', { uv: 0.03 });
  for (const sx of [-1, 1]) {
    b.add(at(cyl(0.0072, 0.150, 0.0010, 14), [sx * 0.0180, -0.0060, 0.100]), 'steel', { uv: 0.03 });
  }
  b.add(at(box(0.0480, 0.0300, 0.0180, 0.0035, 2), [0, -0.0070, 0.1720]), 'steel', { uv: 0.03 });
  b.add(at(box(0.0440, 0.0600, 0.0180, 0.0045, 2), [0, -0.0130, 0.1830]), 'rubber', { uv: 0.03 });
  // Butt-pad ribs and a proud heel/toe, so the plate reads as moulded rubber
  // rather than a painted block — same treatment as the M4A1's pad.
  for (let i = 0; i < 4; i++) {
    b.add(at(box(0.0446, 0.0042, 0.0038, 0.0008), [0, -0.0355 + i * 0.0150, 0.1900]), 'rubber',
      { uv: 0.012, occlude: false, aoScale: 1.3 });
  }
  b.add(at(box(0.0432, 0.0100, 0.0206, 0.0024, 2), [0, 0.0128, 0.1912]), 'rubber', { uv: 0.016 });
  b.add(at(box(0.0420, 0.0106, 0.0212, 0.0026, 2), [0, -0.0388, 0.1916]), 'rubber', { uv: 0.016 });
  // Sling loop on the butt block with a real hole through it.
  b.add(at(box(0.0090, 0.0210, 0.0100, 0.0022), [-0.0230, -0.0160, 0.0400]), 'steel', { uv: 0.02 });
  b.add(at(box(0.0048, 0.0110, 0.0130, 0.0014), [-0.0248, -0.0080, 0.1700]), 'steel', { uv: 0.016 });
  try {
    const ring = new THREE.TorusGeometry(0.0078, 0.0018, 6, 16);
    ring.rotateY(Math.PI / 2);
    at(ring, [-0.0276, -0.0146, 0.1700]);
    b.add(ring, 'steel', { uv: 0.014, aoScale: 1.2 });
  } catch (err) { /* optional detail */ }

  /* ── optic ────────────────────────────────────────────────────────────── */
  const optic = redDot(b, surfaces, { railY: RAIL_Y + 0.0026, zc: -0.078, opticY: OPTIC_Y });

  /* ── curved 9 mm magazine ─────────────────────────────────────────────── */
  const mag = magazine(b, {
    group: 'mag', topY: -0.0470, topZ: -0.1180,
    w: 0.0225, d: 0.0330, length: 0.200, curve: 0.62, tilt: 0.06, segments: 10,
  });

  /* ── hands ────────────────────────────────────────────────────────────── */
  gripHand(b, {
    origin: [0, -0.0625, -0.0165], axisRot: [-0.38, 0, 0], side: 1, group: 'handR',
    radius: 0.0182, startAz: 1.56, fingerPitch: 0.0198, wrap: 1.0,
    palmAz: 0.40, thumbAz: -0.86, thumbRise: 0.008, indexOut: 0.92, cuffOut: 0.0016,
    // Wraps the grip rather than running up it — see the M4A1 firing hand.
    thumbLen: 0.55, thumbSweep: -1.9,
  });
  forearm(b, {
    from: [0.0093, -0.1570, 0.0500], dir: [0.26, -0.52, 0.81], length: 0.048,
    r0: 0.0272, r1: 0.0316, group: 'handR',
  });

  // Same two corrections as the M4's support hand, for the same reasons. The 2.30
  // roll parks the whole hand on the far side of the weapon from a camera sitting
  // above and to the left, so only the sleeve is ever on screen; and at radius
  // 0.0252 against this handguard's 0.0230 lathe the fingers orbited it with a
  // 2 mm air gap instead of closing on it.
  // ROLL: same derivation as the M4A1's support hand, which is worth applying here
  // rather than leaving the SMG a weapon whose support hand is still invisible. This
  // frame is identical (axisRot -PI/2, side -1), so bearing is again THETA = 90 deg
  // + a. startAz is 1.62 rather than 1.56, so the knuckle ridge sits at a = 1.78 ->
  // THETA = 192 deg, and at the shipped +0.45 it landed at 218 — under the handguard,
  // exactly as on the rifle. -0.90 brings it to 140 deg, into the readable quadrant
  // and facing the viewmodel key.
  gripHand(b, {
    origin: [0, -0.0020, -0.2960], axisRot: [-Math.PI / 2, 0, 0], rot: [0, 0, -0.90],
    side: -1, group: 'handL', radius: 0.0205, startAz: 1.62, fingerPitch: 0.0205,
    // Same thumb solve as the M4A1 support hand. rot[2] = -0.90 rad = -51.6 deg,
    // so THETA = 90 + a - 51.6; a = 1.285 rad puts the thumb at 112 deg, on the
    // near side just ahead of the knuckles. The MP5's handguard ends at z = -0.39
    // and a 61 mm thumb started 26 mm forward reaches -0.364, so it stays on the
    // furniture instead of running out over the barrel.
    wrap: 0.80, palmAz: 0.42, thumbAz: 1.285, thumbRise: 0.026, cuffOut: 0.0047,
    thumbSweep: 0.55,
  });
  // Wrist follows the hand onto the far side of the handguard, so the sleeve's near
  // end tucks behind the tube instead of stopping short of it — see the M4A1's.
  forearm(b, {
    from: [-0.0105, -0.0225, -0.1840], dir: [-0.26, -0.76, 0.60], length: 0.165,
    r0: 0.0268, r1: 0.0342, group: 'handL',
  });

  const marks = surfaces.markings([
    'HECKLER & KOCH GMBH',
    'MP5  KAL. 9 mm x 19',
    'Made in W-Germany  C 87241',
  ], 512, 128);

  const built = b.build('MP5A3', { radius: 0.070, strength: 1.40, minAo: 0.11 });
  const root = built.root;

  if (marks) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.062, 0.0150), marks);
    plane.position.set(-0.0189, 0.0020, -0.1020);
    plane.rotation.y = -Math.PI / 2;
    plane.frustumCulled = false;
    root.add(plane);
  }

  root.add(optic.lensFront, optic.lensRear, optic.reticle);
  if (optic.reticleGhost) root.add(optic.reticleGhost);

  return finish({
    id: 'smg',
    root,
    groups: built.groups,
    optic,
    opticY: OPTIC_Y,
    muzzleZ: muzzleTipZ,
    ejectPort: [0.0215, 0.0060, -0.0500],
    magPivot: [0, -0.0420, -0.1080],
    magTop: [0, -0.0470, -0.1180],
    magSize: [0.023, 0.200, 0.034],
    chargePivot: [-0.0290, 0.0180, -0.3150],
    handLPivot: [0, -0.0020, -0.2960],
    handLMag: [0.010, -0.0800, -0.1230],
    handLCharge: [-0.0380, 0.0140, -0.3160],
    triangles: b.stats?.triangles ?? 0,
  });
}

/* ────────────────────────── assembly / pivots ────────────────────────────── */

/**
 * Wrap the merged group meshes in pivot nodes so the rig can rotate a magazine
 * about its catch rather than about the bore, and hang the reference nodes the
 * animation and ballistics code needs off the model.
 */
function finish(spec) {
  const { root, groups } = spec;

  const makePivot = (name, p) => {
    const g = groups[name];
    const pivot = new THREE.Group();
    pivot.name = `${name}_pivot`;
    pivot.position.set(p[0], p[1], p[2]);
    root.add(pivot);
    if (g) {
      root.remove(g);
      g.position.set(-p[0], -p[1], -p[2]);
      pivot.add(g);
    }
    return pivot;
  };

  const mag = makePivot('mag', spec.magPivot);
  const charge = makePivot('charge', spec.chargePivot);
  const bolt = groups.bolt ?? new THREE.Group();
  if (!groups.bolt) root.add(bolt);
  const trigger = makePivot('trigger', [0, -0.0500, -0.0400]);
  const selector = makePivot('selector', [-0.0200, -0.0290, -0.0210]);
  const dust = makePivot('dust', [0.0190, -0.0010, -0.0620]);
  const handR = groups.handR ?? null;
  // The support hand gets a real pivot at the wrist so the reload can take it OFF
  // the handguard. Without one, `handL` is a merged mesh whose origin is the
  // weapon origin, and any rotation swings the hand around the receiver instead
  // of around the wrist — so the only animation available was translation, and a
  // hand that slides to the magwell without rotating reads as a floating prop.
  const handL = spec.handLPivot ? makePivot('handL', spec.handLPivot) : (groups.handL ?? null);

  const node = (name, p) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(p[0], p[1], p[2]);
    root.add(o);
    return o;
  };

  // The sight node is the OPTICAL AXIS reference. The rig aligns this node with
  // the camera's −Z, which is what makes the dot land on the screen centre.
  const sight = node('sight', [0, spec.opticY, spec.optic.zRear]);
  const muzzle = node('muzzle', [0, 0, spec.muzzleZ]);
  const eject = node('eject', spec.ejectPort);
  const magMouth = node('magMouth', spec.magTop);

  return {
    id: spec.id,
    root,
    sight,
    muzzle,
    eject,
    magMouth,
    opticY: spec.opticY,
    reticle: spec.optic.reticle,
    magSize: spec.magSize,
    parts: { mag, charge, bolt, trigger, selector, dust, handR, handL },
    // Reload targets for the support hand, in the pivot's own parent space, so
    // index.js can drive it without knowing anything about the model's layout.
    handL: spec.handLPivot ? {
      rest: new THREE.Vector3(...spec.handLPivot),
      mag: new THREE.Vector3(...(spec.handLMag ?? spec.handLPivot)),
      charge: new THREE.Vector3(...(spec.handLCharge ?? spec.handLPivot)),
    } : null,
    rest: {
      mag: mag.position.clone(),
      charge: charge.position.clone(),
      bolt: bolt.position.clone(),
    },
    triangles: spec.triangles,
  };
}

export default { buildM4, buildMP5 };
