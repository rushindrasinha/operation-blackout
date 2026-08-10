/**
 * Tiny deterministic gradient-noise generator for camera shake.
 *
 * Camera shake driven by Math.random() per frame is white noise — it reads as a
 * high-frequency buzz and TAA turns it into a smear. Real shake is band-limited:
 * a low-frequency wander with a little detail on top. That is what Perlin noise
 * gives us, and sampling one 1D lane per axis (with a large per-axis offset so
 * the lanes never correlate) costs almost nothing.
 *
 * OWNER: player agent.
 */

/** Perlin-style 1D gradient noise. Output is in roughly [-1, 1]. */
export class Perlin1D {
  constructor(seed = 0x9e3779b9) {
    const p = new Uint8Array(512);
    const base = new Uint8Array(256);
    for (let i = 0; i < 256; i++) base[i] = i;

    // xorshift32 — deterministic, no dependency on Math.random ordering.
    let s = (seed | 0) || 1;
    const rnd = () => {
      s ^= s << 13; s |= 0;
      s ^= s >>> 17;
      s ^= s << 5; s |= 0;
      return (s >>> 0) / 4294967296;
    };
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = base[i]; base[i] = base[j]; base[j] = t;
    }
    for (let i = 0; i < 512; i++) p[i] = base[i & 255];
    this._p = p;
  }

  /** @param {number} x @returns {number} smooth noise in ~[-1,1] */
  noise(x) {
    const xi = Math.floor(x);
    const xf = x - xi;
    const i = xi & 255;
    // Quintic fade — C2 continuous, so the derivative (perceived jerk) is smooth.
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const g0 = (this._p[i] & 15) / 7.5 - 1;
    const g1 = (this._p[i + 1] & 15) / 7.5 - 1;
    const n0 = g0 * xf;
    const n1 = g1 * (xf - 1);
    return (n0 + (n1 - n0) * u) * 2.2;
  }

  /** Two-octave fBm: a slow body with a fine tremor riding on it. */
  fbm(x) {
    return this.noise(x) * 0.72 + this.noise(x * 2.37 + 31.7) * 0.28;
  }
}

export default Perlin1D;
