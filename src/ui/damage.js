/**
 * Health as a full-screen state, never a bar.
 *
 * Four stacked, independently-driven layers:
 *   grade  — backdrop desaturation + contrast crush that tracks missing health
 *   lowhp  — red edge vignette, same driver, slower to release
 *   pulse  — heartbeat throb, only below the critical threshold
 *   blood  — pooled directional washes fired by 'player:damage'
 *
 * Only `opacity`, `transform` and (rarely) `backdrop-filter` are written, and the
 * two expensive layers are display:none whenever they would be a no-op — a player
 * at full health pays nothing.
 *
 * OWNER: hud (src/ui/**).
 */

import { el, anim, clamp, damp, setStyle, setClass } from './dom.js';
import { makeSpatterURL } from './noise.js';

const BLOOD_SLOTS = 4;

export class DamageFX {
  constructor(parent) {
    this.layer = el('div', 'fx-layer', parent);

    this.grade = el('div', 'fx-grade', this.layer);
    this.lowhp = el('div', 'fx-lowhp', this.layer);
    this.pulse = el('div', 'fx-pulse', this.layer);

    this.blood = [];
    for (let i = 0; i < BLOOD_SLOTS; i++) {
      const b = el('div', 'fx-blood', this.layer);
      el('b', null, b);
      el('i', null, b);
      this.blood.push(b);
    }
    this._bloodIdx = 0;

    this.death = el('div', 'fx-death', this.layer);

    // Procedural spatter mask — synthesised once, shared by every blood slot.
    const url = makeSpatterURL(256, 9137);
    if (url) {
      for (const b of this.blood) {
        const i = b.querySelector('i');
        i.style.webkitMaskImage = `url(${url})`;
        i.style.maskImage = `url(${url})`;
      }
    } else {
      for (const b of this.blood) b.querySelector('i').style.display = 'none';
    }

    this.hurt = 0;        // 0..1 smoothed "how hurt do I look"
    this._grade = -1;
    this._low = -1;
    this._beating = false;
    this._gradeOn = false;
    this._deathO = 0;
  }

  /**
   * @param {number} health01  0..1
   * @param {boolean} dead
   * @param {number} dt
   */
  update(health01, dead, dt) {
    const h = clamp(health01, 0, 1);
    // A squared response on *missing* health, with a small deadzone. A smoothstep
    // here saturates far too early — it hit full intensity at 20% health and the
    // frame drowned in red with nothing left in reserve for actually dying.
    // This curve is ~0.24 at half health, ~0.6 at a quarter, 1.0 only at zero.
    const miss = clamp(1 - h, 0, 1);
    const target = Math.pow(clamp((miss - 0.06) / 0.94, 0, 1), 1.9);
    // Damage lands instantly, regeneration releases slowly.
    this.hurt = damp(this.hurt, target, target > this.hurt ? 26 : 2.2, dt);
    const k = this.hurt;

    // ── grade: desaturate + crush. Only mounted when it would be visible.
    const gradeOn = k > 0.02;
    if (gradeOn !== this._gradeOn) {
      this._gradeOn = gradeOn;
      setStyle(this.grade, 'display', gradeOn ? 'block' : 'none');
      if (!gradeOn) {
        this.grade.style.backdropFilter = '';
        this.grade.style.webkitBackdropFilter = '';
        this._grade = -1;
      }
    }
    if (gradeOn) {
      const q = Math.round(k * 24) / 24;    // quantise: avoids a filter rebuild every frame
      if (q !== this._grade) {
        this._grade = q;
        const sat = (1 - q * 0.68).toFixed(3);
        const con = (1 + q * 0.12).toFixed(3);
        const bri = (1 - q * 0.09).toFixed(3);
        const f = `saturate(${sat}) contrast(${con}) brightness(${bri})`;
        this.grade.style.backdropFilter = f;
        this.grade.style.webkitBackdropFilter = f;
      }
    }

    // ── red edge vignette
    const lo = clamp(k * 0.62, 0, 1);
    if (Math.abs(lo - this._low) > 0.005) {
      this._low = lo;
      this.lowhp.style.opacity = lo.toFixed(3);
    }

    // ── heartbeat, critical only
    const beating = !dead && h > 0 && h < 0.3;
    if (beating !== this._beating) {
      this._beating = beating;
      setClass(this.pulse, 'beating', beating);
      if (!beating) this.pulse.style.opacity = '0';
    }

    // ── death wash
    const dTarget = dead ? 1 : 0;
    this._deathO = damp(this._deathO, dTarget, dead ? 5 : 2.4, dt);
    setStyle(this.death, 'opacity', this._deathO < 0.004 ? '0' : this._deathO.toFixed(3));
  }

  /**
   * @param {number} angleRad  0 = hit came from dead ahead, +ve = from the right
   * @param {number} severity  0..1
   * @param {boolean} omni     no usable direction — flash from every edge instead
   */
  hit(angleRad, severity = 0.5, omni = false) {
    const b = this.blood[this._bloodIdx];
    this._bloodIdx = (this._bloodIdx + 1) % BLOOD_SLOTS;

    // Place the wash origin on the viewport edge in the incoming direction.
    const s = Math.sin(angleRad), c = Math.cos(angleRad);
    const bx = omni ? '50%' : (50 + s * 58).toFixed(1) + '%';
    const by = omni ? '50%' : (50 - c * 62).toFixed(1) + '%';
    b.style.setProperty('--bx', bx);
    b.style.setProperty('--by', by);
    b.classList.toggle('omni', !!omni);

    // Reseat the tiled droplet mask so two consecutive hits from the same bearing
    // do not produce the identical spatter. The mask is tileable, so any offset
    // is seamless.
    const spat = b.querySelector('i');
    if (spat) {
      spat.style.webkitMaskPosition = `${(Math.random() * 430) | 0}px ${(Math.random() * 430) | 0}px`;
      spat.style.maskPosition = spat.style.webkitMaskPosition;
    }

    const peak = clamp(0.38 + severity * 0.46, 0.34, 0.86);
    const dur = 560 + severity * 700;
    anim(b, [
      { opacity: 0, transform: 'scale(1.05)' },
      { opacity: peak, transform: 'scale(1)', offset: 0.06 },
      { opacity: peak * 0.5, transform: 'scale(1)', offset: 0.3 },
      { opacity: 0, transform: 'scale(1.02)' },
    ], { duration: dur, easing: 'cubic-bezier(.15,.75,.3,1)', fill: 'none' });
  }

  /** Immediate, unsmoothed slam — used on death so the cut is not damped. */
  slam() {
    this.hurt = 1;
  }
}
