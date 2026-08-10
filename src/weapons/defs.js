/**
 * Weapon data. Everything that makes one gun feel different from another lives
 * here, not in the code — rate of fire, recoil PATTERN (not noise), spread state
 * machine constants, handling times, and the two viewmodel poses.
 *
 * The recoil pattern is the important one. A learnable pattern is what separates a
 * shooter that rewards practice from one that just shakes the screen: the first
 * seven rounds of the M4 climb almost straight, then the muzzle walks left, then it
 * snaps back right and settles into a slow drift. A small random component is added
 * on top so it is never mechanical, but the shape is fixed.
 *
 * OWNER: weapons.
 */

/** Pattern entries are [yaw, pitch] in "recoil units"; scaled by recoil.pitch/yaw. */
const M4_PATTERN = [
  [0.00, 1.00], [0.05, 0.98], [-0.04, 0.96], [0.08, 0.94],
  [-0.10, 0.92], [0.06, 0.90], [-0.14, 0.86], [-0.26, 0.80],
  [-0.40, 0.74], [-0.52, 0.68], [-0.58, 0.62], [-0.50, 0.58],
  [-0.34, 0.54], [-0.10, 0.52], [0.20, 0.50], [0.46, 0.48],
  [0.62, 0.46], [0.66, 0.45], [0.58, 0.44], [0.40, 0.44],
  [0.16, 0.43], [-0.08, 0.43], [-0.28, 0.42], [-0.40, 0.42],
  [-0.42, 0.42], [-0.34, 0.41], [-0.18, 0.41], [0.02, 0.40],
  [0.20, 0.40], [0.30, 0.40],
];

const MP5_PATTERN = [
  [0.00, 1.00], [-0.06, 0.94], [0.10, 0.90], [0.18, 0.86],
  [0.26, 0.82], [0.30, 0.78], [0.26, 0.74], [0.14, 0.72],
  [-0.04, 0.70], [-0.22, 0.68], [-0.36, 0.66], [-0.42, 0.65],
  [-0.38, 0.64], [-0.24, 0.63], [-0.06, 0.62], [0.14, 0.62],
  [0.28, 0.61], [0.34, 0.61], [0.30, 0.60], [0.18, 0.60],
  [0.02, 0.60], [-0.14, 0.59], [-0.24, 0.59], [-0.28, 0.58],
  [-0.22, 0.58], [-0.08, 0.58], [0.08, 0.57], [0.20, 0.57],
  [0.26, 0.57], [0.24, 0.56],
];

export const WEAPON_DEFS = {
  rifle: {
    id: 'rifle',
    name: 'M4A1',
    caliber: '5.56×45mm',
    slot: 1,
    magSize: 30,
    reserve: 210,
    reserveMax: 300,
    rpm: 780,
    damage: 26,
    headshotMul: 2.15,
    // Damage falloff: full damage to 34 m, then a linear roll to 55% at 90 m.
    falloffNear: 34,
    falloffFar: 90,
    falloffMin: 0.55,
    range: 320,
    penetration: 0.62,          // budget consumed by each surface it punches through
    fireModes: ['auto', 'burst', 'semi'],
    burstCount: 3,
    burstGapMs: 60,

    recoil: {
      pitch: 0.0125,            // radians of camera kick on the first shot
      yaw: 0.0060,
      randomPitch: 0.0022,
      randomYaw: 0.0034,
      // Viewmodel kick — larger than the camera kick, that contrast is the "punch".
      vmPitch: 0.055,
      vmRoll: 0.030,
      vmPunch: 0.0165,          // metres of rearward travel
      vmStiffness: 190,
      vmDamping: 21,
      recovery: 0.86,           // fraction of camera kick that returns
      pattern: M4_PATTERN,
      adsMul: 0.68,
      crouchMul: 0.86,
    },

    spread: {
      base: 0.0022,             // radians, standing still, hip fire
      ads: 0.0006,
      crouch: 0.72,             // multiplier
      moving: 0.0075,           // added at full walk speed
      sprint: 0.030,
      air: 0.020,
      perShot: 0.0021,
      max: 0.052,
      recovery: 0.055,          // radians per second decay
      recoveryDelay: 0.09,
    },

    handling: {
      drawTime: 0.52,
      holsterTime: 0.30,
      reloadTactical: 2.05,
      reloadEmpty: 2.85,
      adsTime: 0.20,
      sprintTime: 0.18,
    },

    audio: { fire: 'rifle_fire', pitch: 1.0 },

    ejection: {
      speed: 3.1,
      spread: 0.55,
      dir: [1.0, 0.42, 0.20],
      shell: { radius: 0.0049, length: 0.0455 },
    },

    // Viewmodel poses, in viewmodel-camera space, applied to the node whose origin
    // is the weapon's optical axis reference (see models.js `finish`).
    poses: {
      // Re-framed against the 66-degree viewmodel FOV (see WeaponSystem.vmFov).
      //
      // The old framing put the optic at (1300, 760) with the weapon 200 mm from the
      // eye at a 55-degree viewmodel FOV. Two things were wrong with it. It ate ~22%
      // of a 1080p frame, so the gun read as oversized and barely foreshortened; and
      // because the model is 838 mm long and only its front third fitted, the
      // magwell, grip, stock and firing hand were all outside the frame — which is
      // exactly why three separate reviewers reported them as "missing from the
      // model" when they were in fact modelled and simply off-screen.
      //
      // Pulled back to 205 mm and widened to 66 degrees, the weapon covers ~14% of
      // the frame, the bore converges toward screen centre, the optic sits below and
      // right of the crosshair at roughly (1230, 675), and the support hand, magwell
      // flare and receiver flank are all inside the frame. The yaw is what turns a
      // heavily foreshortened barrel-on view into a readable three-quarter
      // silhouette; the roll is deliberately small (3 degrees) because apparent roll
      // in the frame comes mostly from that yaw plus perspective.
      //
      // SECOND PASS. 205 mm still measured ~22-24% of a 1080p frame with the
      // silhouette clipped by BOTH the right and bottom edges at once, and the
      // optic body crowding to within ~150 px of the reticle — the exact patch of
      // screen a player watches for movement. Pushed to 272 mm (the model shrinks
      // as 1/z, so that is a linear 0.83 and an area 0.68) and dropped 14 mm, with
      // x scaled by the same factor so the weapon keeps its angular position in
      // the lower right rather than sliding inboard. 292 mm was tried and rejected:
      // it clears the frame edges but takes the pistol grip and firing hand out of
      // shot with it, and a viewmodel with no visible hands is a worse failure
      // than a slightly large one.
      //
      // Roll is halved to 0.026 and pitch relaxed to 0.044: apparent roll at this
      // distance comes almost entirely from the yaw plus near-field perspective,
      // and the extra 3 degrees was tipping the receiver's top plane fully into
      // view — the "floating prop rotated into frame" read. The top deck is now a
      // grazing sliver, which is what a rifle held at the hip actually shows.
      hip: {
        pos: [0.0920, -0.0380, -0.2720],
        rot: [0.0550, 0.1500, 0.0300],
      },
      ads: {
        // x/y are FORCED to zero at runtime: the sight has to be on the camera axis.
        // z is eye relief; it is multiplied by the viewmodel scale, and it is the
        // number that sets how much of the frame the optic tube eats.
        pos: [0.0, 0.0, -0.1720],
        rot: [0, 0, 0],
      },
      sprint: {
        pos: [0.1180, -0.1080, -0.2450],
        rot: [-0.3200, 0.5600, 0.4000],
      },
      inspect: {
        pos: [0.0700, -0.0860, -0.2480],
        rot: [0.1600, 0.7200, 0.2000],
      },
    },
    fovMul: 1.0,
  },

  smg: {
    id: 'smg',
    name: 'MP5A3',
    caliber: '9×19mm',
    slot: 2,
    magSize: 30,
    reserve: 240,
    reserveMax: 330,
    rpm: 800,
    damage: 19,
    headshotMul: 1.95,
    falloffNear: 16,
    falloffFar: 46,
    falloffMin: 0.42,
    range: 200,
    penetration: 0.34,
    fireModes: ['auto', 'burst', 'semi'],
    burstCount: 3,
    burstGapMs: 55,

    recoil: {
      pitch: 0.0084,
      yaw: 0.0044,
      randomPitch: 0.0016,
      randomYaw: 0.0026,
      vmPitch: 0.038,
      vmRoll: 0.024,
      vmPunch: 0.0118,
      vmStiffness: 215,
      vmDamping: 22,
      recovery: 0.90,
      pattern: MP5_PATTERN,
      adsMul: 0.72,
      crouchMul: 0.88,
    },

    spread: {
      base: 0.0031,
      ads: 0.0011,
      crouch: 0.75,
      moving: 0.0060,
      sprint: 0.026,
      air: 0.018,
      perShot: 0.0016,
      max: 0.044,
      recovery: 0.070,
      recoveryDelay: 0.07,
    },

    handling: {
      drawTime: 0.44,
      holsterTime: 0.26,
      reloadTactical: 1.85,
      reloadEmpty: 2.70,
      adsTime: 0.165,
      sprintTime: 0.15,
    },

    audio: { fire: 'smg_fire', pitch: 1.0 },

    ejection: {
      speed: 2.7,
      spread: 0.5,
      dir: [1.0, 0.50, 0.14],
      shell: { radius: 0.0048, length: 0.0195 },
    },

    poses: {
      hip: {
        pos: [0.0900, -0.0370, -0.2660],
        rot: [0.0570, 0.1520, 0.0320],
      },
      ads: {
        pos: [0.0, 0.0, -0.1620],
        rot: [0, 0, 0],
      },
      sprint: {
        pos: [0.1160, -0.1040, -0.2390],
        rot: [-0.3000, 0.5400, 0.3800],
      },
      inspect: {
        pos: [0.0690, -0.0840, -0.2420],
        rot: [0.1500, 0.7000, 0.1800],
      },
    },
    fovMul: 1.0,
  },
};

export const WEAPON_ORDER = ['rifle', 'smg'];

/** Materials a bullet will punch through, and how much of the budget each costs. */
export const PENETRABLE = {
  wood: 0.32,
  glass: 0.10,
  fabric: 0.16,
  tarp: 0.10,
  sandbags: 0.72,
  corrugatedMetal: 0.38,
  plaster: 0.42,
  rubber: 0.30,
  paintedMetal: 0.58,
};

export default WEAPON_DEFS;
