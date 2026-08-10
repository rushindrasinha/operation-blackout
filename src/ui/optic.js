/**
 * Optic overlay for ADS.
 *
 * Three layers, all masked to a circle so nothing squares off:
 *   optic-blur — backdrop blur outside the objective, i.e. peripheral defocus
 *   optic-vig  — the tube darkening toward the edge
 *   optic-rim  — a single hairline for the objective lens, plus inner falloff
 * and a red dot that carries a little residual sway so it is not welded to the
 * pixel grid.
 *
 * The whole thing is display:none unless ADS is actually in progress, so the
 * backdrop-filter never runs during hipfire.
 *
 * OWNER: hud (src/ui/**).
 */

import { el, clamp, setStyle } from './dom.js';

export class Optic {
  constructor(parent) {
    this.root = el('div', 'optic', parent);
    this.blur = el('div', 'optic-blur', this.root);
    this.vig = el('div', 'optic-vig', this.root);
    this.rim = el('div', 'optic-rim', this.root);
    this.dot = el('div', 'optic-dot', this.root);

    this._on = false;
    this._a = -1;
    this._blurQ = -1;
    this._t = 0;
    this._sx = 0; this._sy = 0;
  }

  /**
   * @param {number} ads    0..1 aim progress
   * @param {boolean} hasOptic
   * @param {number} dt
   * @param {number} breath 0..1 extra sway from being hurt / winded
   */
  update(ads, hasOptic, dt, breath = 0) {
    const a = hasOptic ? clamp(ads, 0, 1) : 0;
    const on = a > 0.015;

    if (on !== this._on) {
      this._on = on;
      setStyle(this.root, 'display', on ? 'block' : 'none');
      if (!on) {
        this.blur.style.backdropFilter = '';
        this.blur.style.webkitBackdropFilter = '';
        this._blurQ = -1;
      }
    }
    if (!on) return;

    // Cubic ease-in so the tube arrives late in the aim, like a real transition.
    const e = a * a * (3 - 2 * a);
    if (Math.abs(e - this._a) > 0.004) {
      this._a = e;
      this.root.style.opacity = e.toFixed(3);
    }

    const q = Math.round(e * 8) / 8;
    if (q !== this._blurQ) {
      this._blurQ = q;
      const f = `blur(${(q * 2.1).toFixed(2)}px)`;
      this.blur.style.backdropFilter = f;
      this.blur.style.webkitBackdropFilter = f;
    }

    // Residual dot sway: tiny, sub-pixel-ish, two incommensurate frequencies so
    // it never reads as a loop.
    this._t += dt;
    const amp = (0.55 + breath * 3.4) * e;
    const x = (Math.sin(this._t * 1.31) * 0.6 + Math.sin(this._t * 0.47) * 0.4) * amp;
    const y = (Math.sin(this._t * 1.07 + 1.7) * 0.6 + Math.sin(this._t * 0.61 + .3) * 0.4) * amp;
    if (Math.abs(x - this._sx) > 0.05 || Math.abs(y - this._sy) > 0.05) {
      this._sx = x; this._sy = y;
      this.dot.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`;
    }
  }
}
