/**
 * CPU mirror of SkyShader.js (minus clouds and the sun disc).
 *
 * Why not read the GPU sky back? Because half-float readback is the flakiest thing in
 * WebGL and a fog colour is not worth a stall or a driver quirk. Evaluating the same
 * closed-form model on the CPU is exact, instant, and cannot fail — and it means the
 * fog, the hemisphere fill and the sky are literally the same function of sun angle.
 *
 * Everything returned is linear-Rec.709, matching the shader's pre-tonemap output.
 *
 * OWNER: lighting.
 */
import * as THREE from 'three';
import { SKY_DEFAULTS } from './SkyShader.js';

const PI = Math.PI;
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000.0;
const RAYLEIGH_ZENITH = 8.4e3;
const MIE_ZENITH = 1.25e3;
const THREE_OVER_SIXTEENPI = 0.05968310365946075;
const ONE_OVER_FOURPI = 0.07957747154594767;
const LUMA = [0.2126, 0.7152, 0.0722];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

function sunIntensity(zenithCos) {
  const z = clamp(zenithCos, -1, 1);
  return EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(z)) / STEEPNESS)));
}

function totalMie(turbidity) {
  const c = 0.2 * turbidity * 1e-17;
  return MIE_CONST.map((k) => 0.434 * c * k);
}

/**
 * Evaluate the graded sky radiance for a unit direction.
 *
 * @param {THREE.Vector3} dir       unit view direction
 * @param {THREE.Vector3} sunDir    unit direction toward the sun
 * @param {object} p                sky params (SKY_DEFAULTS shape)
 * @param {THREE.Color} [target]
 * @returns {THREE.Color} linear radiance
 */
export function evaluateSky(dir, sunDir, p = SKY_DEFAULTS, target = new THREE.Color()) {
  const par = p === SKY_DEFAULTS ? SKY_DEFAULTS : { ...SKY_DEFAULTS, ...p };

  const sunE = sunIntensity(sunDir.y);
  const betaM0 = totalMie(par.turbidity);
  const betaR = TOTAL_RAYLEIGH.map((v) => v * par.rayleigh);
  const betaM = betaM0.map((v) => v * par.mieCoefficient);

  const upDot = Math.max(0, dir.y);
  const zenithAngle = Math.acos(upDot);
  const denom = Math.cos(zenithAngle) + 0.15 * Math.pow(Math.max(93.885 - (zenithAngle * 180) / PI, 1e-3), -1.253);
  const inv = 1 / denom;
  const sR = RAYLEIGH_ZENITH * inv;
  const sM = MIE_ZENITH * inv;

  const cosTheta = dir.x * sunDir.x + dir.y * sunDir.y + dir.z * sunDir.z;
  const rPhaseArg = cosTheta * 0.5 + 0.5;
  const rPhase = THREE_OVER_SIXTEENPI * (1 + rPhaseArg * rPhaseArg);
  const g = par.mieDirectionalG;
  const g2 = g * g;
  const mPhase = ONE_OVER_FOURPI * ((1 - g2) / Math.pow(Math.max(1 - 2 * g * cosTheta + g2, 1e-4), 1.5));

  const sunUp = clamp(Math.pow(1 - sunDir.y, 5), 0, 1);

  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const Fex = Math.exp(-(betaR[i] * sR + betaM[i] * sM));
    const bSum = Math.max(betaR[i] + betaM[i], 1e-12);
    const bTheta = betaR[i] * rPhase + betaM[i] * mPhase;
    const base = sunE * (bTheta / bSum);
    let Lin = Math.pow(Math.max(base * (1 - Fex), 0), 1.5);
    Lin *= mix(1, Math.pow(Math.max(base * Fex, 0), 0.5), sunUp);
    const L0 = 0.1 * Fex;
    out[i] = (Lin + L0) * 0.04;
  }
  out[1] += 0.0003;
  out[2] += 0.00075;
  for (let i = 0; i < 3; i++) out[i] *= par.skyIntensity;

  // ── luminance-only highlight rolloff (mirrors the shader) ───────────────
  {
    const l = Math.max(out[0] * LUMA[0] + out[1] * LUMA[1] + out[2] * LUMA[2], 1e-6);
    const s = (l / (1 + l * par.highlightComp)) / l;
    for (let i = 0; i < 3; i++) out[i] *= s;
  }

  // ── horizon haze band ───────────────────────────────────────────────────
  const band = clamp(Math.exp(-Math.max(dir.y, 0) * par.hazeFalloff) * par.hazeStrength, 0, 1);
  const sunMix = Math.pow(Math.max(cosTheta, 0), 2.2);
  let lum = out[0] * LUMA[0] + out[1] * LUMA[1] + out[2] * LUMA[2];
  for (let i = 0; i < 3; i++) {
    const tint = mix(par.hazeCool[i], par.hazeWarm[i], sunMix);
    const hazed = tint * (lum * 0.72 + par.hazeLift * par.skyIntensity);
    out[i] = mix(out[i], hazed, band);
  }

  // ── desaturate ──────────────────────────────────────────────────────────
  lum = out[0] * LUMA[0] + out[1] * LUMA[1] + out[2] * LUMA[2];
  for (let i = 0; i < 3; i++) out[i] = mix(lum, out[i], par.saturation);

  // ── azimuthal warm/cool axis + zenith ramp (mirrors SkyShader) ──────────
  // This must stay in lockstep with the GLSL: the fog lobes and the hemisphere fill
  // are derived from these samples, so if the CPU model skips the grade the haze
  // ends up a different colour family from the dome it is supposed to dissolve into.
  {
    const az = Math.pow(clamp(cosTheta * 0.5 + 0.5, 0, 1), par.skyRampExp);
    const zen = mix(1, par.zenithScale, smoothstep(0, 0.62, dir.y));
    for (let i = 0; i < 3; i++) out[i] *= mix(par.skyCool[i], par.skyWarm[i], az) * zen;
  }

  // ── lower hemisphere ────────────────────────────────────────────────────
  const below = smoothstep(0, -0.18, dir.y);
  if (below > 0) {
    lum = out[0] * LUMA[0] + out[1] * LUMA[1] + out[2] * LUMA[2];
    for (let i = 0; i < 3; i++) {
      out[i] = mix(out[i], par.groundColor[i] * (0.55 + 1.9 * lum), below);
    }
  }

  return target.setRGB(
    Math.max(out[0], 0),
    Math.max(out[1], 0),
    Math.max(out[2], 0),
    THREE.LinearSRGBColorSpace,
  );
}

const _d = new THREE.Vector3();

/**
 * Average sky radiance over a cone of directions around `axis`. Used for fog / fill
 * colours, where a single sample is too noisy a representation of "what the sky looks
 * like over there".
 */
export function averageSky(axis, sunDir, p, coneDeg = 16, samples = 9, target = new THREE.Color()) {
  const r = 0, g = 1, b = 2;
  const acc = [0, 0, 0];
  const tmp = new THREE.Color();
  const cone = (coneDeg * PI) / 180;

  // build an orthonormal basis around the axis
  const a = _d.set(0, 1, 0);
  if (Math.abs(axis.dot(a)) > 0.95) a.set(1, 0, 0);
  const t1 = new THREE.Vector3().crossVectors(axis, a).normalize();
  const t2 = new THREE.Vector3().crossVectors(axis, t1).normalize();
  const dir = new THREE.Vector3();

  for (let i = 0; i < samples; i++) {
    // golden-angle spiral inside the cone
    const k = (i + 0.5) / samples;
    const rad = Math.sqrt(k) * cone;
    const ang = i * 2.399963229728653;
    dir.copy(axis)
      .addScaledVector(t1, Math.sin(rad) * Math.cos(ang))
      .addScaledVector(t2, Math.sin(rad) * Math.sin(ang))
      .multiplyScalar(1)
      .normalize();
    evaluateSky(dir, sunDir, p, tmp);
    acc[r] += tmp.r; acc[g] += tmp.g; acc[b] += tmp.b;
  }
  return target.setRGB(acc[r] / samples, acc[g] / samples, acc[b] / samples, THREE.LinearSRGBColorSpace);
}

/** Direction toward the sun for elevation/azimuth in degrees. */
export function sunDirectionFrom(elevationDeg, azimuthDeg, target = new THREE.Vector3()) {
  const el = (elevationDeg * PI) / 180;
  const az = (azimuthDeg * PI) / 180;
  const h = Math.cos(el);
  return target.set(h * Math.cos(az), Math.sin(el), h * Math.sin(az)).normalize();
}
