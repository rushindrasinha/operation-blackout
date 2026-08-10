/**
 * Critically-tunable spring-damper integrators.
 *
 * Every piece of weapon motion in this game goes through one of these — nothing
 * uses a linear lerp, because a lerp has no momentum and momentum is the entire
 * reason a weapon reads as a heavy object attached to a body rather than a decal
 * stuck to the camera.
 *
 * Integration is semi-implicit Euler with a sub-stepped inner loop: at 60 Hz a
 * stiffness of 200+ is right on the edge of explicit-Euler stability, and a single
 * dropped frame would otherwise make the gun detonate off-screen.
 *
 * OWNER: weapons.
 */

const MAX_SUB_DT = 1 / 180;

/** Scalar spring. */
export class Spring {
  constructor(stiffness = 120, damping = 18, value = 0) {
    this.k = stiffness;
    this.d = damping;
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  set(v) { this.value = v; this.target = v; this.velocity = 0; return this; }
  impulse(v) { this.velocity += v; return this; }

  update(dt) {
    if (!(dt > 0)) return this.value;
    let remaining = Math.min(dt, 0.1);
    while (remaining > 1e-6) {
      const h = Math.min(MAX_SUB_DT, remaining);
      const a = (this.target - this.value) * this.k - this.velocity * this.d;
      this.velocity += a * h;
      this.value += this.velocity * h;
      remaining -= h;
    }
    return this.value;
  }
}

/** Three-component spring sharing one set of constants. Avoids per-axis objects. */
export class Spring3 {
  constructor(stiffness = 120, damping = 18) {
    this.k = stiffness;
    this.d = damping;
    this.x = 0; this.y = 0; this.z = 0;
    this.tx = 0; this.ty = 0; this.tz = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
  }

  setTarget(x, y, z) { this.tx = x; this.ty = y; this.tz = z; return this; }
  set(x, y, z) {
    this.x = this.tx = x; this.y = this.ty = y; this.z = this.tz = z;
    this.vx = this.vy = this.vz = 0;
    return this;
  }

  impulse(x, y, z) { this.vx += x; this.vy += y; this.vz += z; return this; }

  update(dt) {
    if (!(dt > 0)) return this;
    let remaining = Math.min(dt, 0.1);
    const k = this.k, d = this.d;
    while (remaining > 1e-6) {
      const h = Math.min(MAX_SUB_DT, remaining);
      this.vx += ((this.tx - this.x) * k - this.vx * d) * h;
      this.vy += ((this.ty - this.y) * k - this.vy * d) * h;
      this.vz += ((this.tz - this.z) * k - this.vz * d) * h;
      this.x += this.vx * h;
      this.y += this.vy * h;
      this.z += this.vz * h;
      remaining -= h;
    }
    return this;
  }

  /** Hard clamp so a pathological dt can never fling the viewmodel out of frame. */
  clamp(limit) {
    const l = Math.abs(limit);
    if (this.x > l) { this.x = l; this.vx = 0; } else if (this.x < -l) { this.x = -l; this.vx = 0; }
    if (this.y > l) { this.y = l; this.vy = 0; } else if (this.y < -l) { this.y = -l; this.vy = 0; }
    if (this.z > l) { this.z = l; this.vz = 0; } else if (this.z < -l) { this.z = -l; this.vz = 0; }
    return this;
  }
}

/**
 * Fast-out / slow-in easing for the ADS transition. A linear or a symmetric
 * smoothstep both read as sluggish: what a real shoulder-and-cheek weld does is
 * cover most of the travel immediately and then settle. This is the exponential
 * approach shape, normalised so f(0)=0 and f(1)=1.
 */
export function easeOutExpo(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.pow(2, -9.2 * t);
}

/** Slightly softer variant used for the un-ADS direction. */
export function easeOutCubic(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const u = 1 - t;
  return 1 - u * u * u;
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function damp(current, target, lambda, dt) {
  return target + (current - target) * Math.exp(-lambda * dt);
}

export default Spring;
