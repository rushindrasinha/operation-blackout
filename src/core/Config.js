/**
 * Global tunables. Every system reads from here rather than hard-coding numbers,
 * so the critic loop can retune the whole game from one file.
 *
 * OWNER: core (do not add system-specific state here — only shared constants).
 */

export const Config = {
  render: {
    // Internal render scale. 1.0 = native. TAA lets us sit at 1.0 on desktop.
    resolutionScale: 1.0,
    maxPixelRatio: 2.0,
    exposure: 1.05,
    // Filmic look. Modern Warfare sits cool-shadowed / warm-highlighted.
    tonemap: 'agx',            // 'agx' | 'aces' | 'reinhard'
    shadowMapSize: 2048,
    csmCascades: 4,
    csmMaxDistance: 140,
    taa: true,
    ssao: true,
    ssr: true,
    volumetrics: true,
    bloom: true,
    motionBlur: true,
    filmGrain: 0.028,
    chromaticAberration: 0.0016,
    vignette: 0.34,
  },

  // Art direction: contemporary military, overcast dusk, cool ambient / warm practicals.
  art: {
    sunColor: 0xffd7a8,
    sunIntensity: 3.1,
    sunElevation: 11.5,        // degrees above horizon — low sun = long dramatic shadows
    sunAzimuth: 118,
    skyTurbidity: 6.2,
    fogColor: 0x9aa4ad,
    fogDensity: 0.0085,
    ambientTint: 0x4a5a68,
    practicalColor: 0xffb257,  // sodium-vapour interior lights
  },

  player: {
    height: 1.75,
    crouchHeight: 1.05,
    eyeOffset: -0.14,          // eye sits below top of capsule
    radius: 0.34,
    walkSpeed: 3.6,
    sprintSpeed: 6.3,
    crouchSpeed: 1.9,
    adsSpeedMul: 0.55,
    accelGround: 58,
    accelAir: 9,
    friction: 11.5,
    jumpVelocity: 5.0,
    gravity: -18.5,
    stepHeight: 0.42,
    mouseSensitivity: 0.0021,
    adsSensitivityMul: 0.62,
    maxPitch: 1.53,
  },

  camera: {
    fov: 78,
    adsFov: 52,
    sprintFov: 84,
    near: 0.02,
    far: 900,
    viewmodelFov: 55,          // separate FOV for the weapon layer — critical for AAA feel
  },

  audio: {
    master: 0.85,
    sfx: 1.0,
    music: 0.35,
  },

  gameplay: {
    botCount: 7,
    playerHealth: 100,
    healthRegenDelay: 4.2,
    healthRegenRate: 22,
  },

  debug: {
    showStats: false,
    freeCam: false,
    wireframe: false,
  },
};

export default Config;
