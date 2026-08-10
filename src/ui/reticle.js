/**
 * Reticle: dynamic four-tick crosshair, hitmarker, damage-direction arcs.
 *
 * The crosshair is driven by the weapon's real cone angle, projected onto the
 * screen with the actual camera FOV — so a 1.4° cone puts the ticks exactly where
 * a 1.4° cone lands, and the reticle stays honest when the FOV changes on ADS.
 *
 * Everything animates via transform/opacity only.
 *
 * OWNER: hud (src/ui/**).
 */

import { el, anim, clamp, damp, setStyle } from './dom.js';

const DEG = Math.PI / 180;

const ARC_SVG = (r, half) => {
  const a = half * DEG;
  const x0 = (-r * Math.sin(a)).toFixed(2), y0 = (-r * Math.cos(a)).toFixed(2);
  const x1 = ( r * Math.sin(a)).toFixed(2), y1 = (-r * Math.cos(a)).toFixed(2);
  const d = `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
  // Two coincident strokes: a soft dark backing for legibility, a thin desaturated
  // brick core on top. Anything heavier than this and the arc becomes the loudest
  // thing in the frame, which is exactly what the HUD must not be.
  return `<svg viewBox="-110 -110 220 220" xmlns="http://www.w3.org/2000/svg">
    <path d="${d}" fill="none" stroke="rgba(0,0,0,.42)" stroke-width="4.6" stroke-linecap="round"/>
    <path d="${d}" fill="none" stroke="rgba(202,92,70,.88)" stroke-width="1.9" stroke-linecap="round"/>
  </svg>`;
};

export class Reticle {
  constructor(parent) {
    this.root = el('div', 'reticle', parent);

    this.ticks = [
      el('div', 'tick t', this.root),
      el('div', 'tick b', this.root),
      el('div', 'tick l', this.root),
      el('div', 'tick r', this.root),
    ];
    this.cdot = el('div', 'cdot', this.root);

    // Hitmarker: 4 inner strokes (hit), 4 outer strokes (kill), 1 ring (headshot).
    this.hm = el('div', 'hitmark', this.root);
    for (const c of ['a', 'b', 'c', 'd']) el('i', c, this.hm);
    for (const c of ['a', 'b', 'c', 'd']) el('u', c, this.hm);
    el('s', null, this.hm);

    // Pool of damage-direction arcs.
    this.arcs = [];
    for (let i = 0; i < 6; i++) {
      const a = el('div', 'dmgarc', this.root);
      a.innerHTML = ARC_SVG(84, 19);
      this.arcs.push({ node: a, until: 0 });
    }
    this._arcIdx = 0;

    // State
    this.gapPx = 14;      // smoothed
    this.targetGap = 14;
    this.lenPx = 7;
    this.opacity = 1;
    this._opacity = -1;
    this.fireKick = 0;
    this._lastGap = -1;
    this._lastLen = -1;
    this._h = window.innerHeight || 1080;
  }

  resize(w, h) { this._h = h || 1; }

  /**
   * @param {number} spreadRad  half-angle of the weapon cone, radians
   * @param {number} fovDeg     vertical FOV currently in use
   * @param {number} adsHide    0..1, 1 = fully behind the optic (crosshair gone)
   * @param {number} dt
   */
  update(spreadRad, fovDeg, adsHide, dt) {
    // Pixels per unit tangent at the current FOV.
    const halfFov = Math.max(1, fovDeg) * 0.5 * DEG;
    const pxPerTan = (this._h * 0.5) / Math.tan(halfFov);
    const conePx = Math.tan(clamp(spreadRad, 0, 0.5)) * pxPerTan;

    this.fireKick = Math.max(0, this.fireKick - dt * 6.5);

    // 8px minimum gap. Below that the four ticks close into a plus sign and both
    // occlude the point of impact and stop reading as a spread indicator at all.
    this.targetGap = clamp(8 + conePx * 0.92 + this.fireKick * 5, 8, 118);
    // Tighten faster than it blooms — same asymmetry the guns use.
    const rate = this.targetGap > this.gapPx ? 26 : 13;
    this.gapPx = damp(this.gapPx, this.targetGap, rate, dt);

    // Ticks lengthen a little as the cone opens, so a tight reticle is a small
    // precise mark and a blooming one reads as four long strokes, not four dots.
    const len = clamp(7.5 + this.gapPx * 0.085, 7.5, 13);

    const g = Math.round(this.gapPx * 2) * 0.5; // half-pixel snap: no shimmer
    if (g !== this._lastGap || len !== this._lastLen) {
      this._lastGap = g; this._lastLen = len;
      const h = len.toFixed(1) + 'px';
      const m = (-len * 0.5).toFixed(2) + 'px 0 0 -1px';
      for (const t of this.ticks) { t.style.height = h; t.style.margin = m; }
      this.ticks[0].style.transform = `translate3d(0,${-g}px,0)`;
      this.ticks[1].style.transform = `translate3d(0,${g}px,0)`;
      this.ticks[2].style.transform = `translate3d(${-g}px,0,0) rotate(90deg)`;
      this.ticks[3].style.transform = `translate3d(${g}px,0,0) rotate(90deg)`;
    }

    // Fade out behind the optic; also fade the ticks a little as they bloom so a
    // huge hipfire cone does not become four bright bars in the frame.
    const bloomFade = 1 - clamp((this.gapPx - 40) / 110, 0, 0.32);
    const o = clamp((1 - adsHide) * bloomFade * this.opacity, 0, 1);
    if (Math.abs(o - this._opacity) > 0.004) {
      this._opacity = o;
      const s = o.toFixed(3);
      for (const t of this.ticks) t.style.opacity = s;
      // Centre dot only reads when the reticle is tight — once the cone opens it
      // is a lie about where the round is going, so it goes away.
      this.cdot.style.opacity = (o * (1 - clamp((this.gapPx - 9) / 14, 0, 1)) * 0.8).toFixed(3);
    }

    // Retire finished arcs.
    const now = performance.now();
    for (const a of this.arcs) {
      if (a.until && now > a.until) { a.until = 0; a.node.style.opacity = '0'; }
    }
  }

  /** Small outward puff on every shot; reads as recoil bloom. */
  kick(amount = 1) { this.fireKick = Math.min(2.2, this.fireKick + amount); }

  /**
   * @param {'hit'|'head'|'kill'} kind
   */
  hitmarker(kind = 'hit') {
    const n = this.hm;
    n.classList.toggle('kill', kind === 'kill');
    n.classList.toggle('head', kind === 'head');
    n.style.setProperty('--hm',
      kind === 'kill' ? 'rgba(208,78,56,.97)'
        : kind === 'head' ? 'rgba(255,205,124,.97)'
          : 'rgba(244,247,249,.97)');

    const dur = kind === 'kill' ? 430 : kind === 'head' ? 330 : 250;
    const s0 = kind === 'kill' ? 1.5 : 1.32;
    anim(n, [
      { opacity: 0, transform: `scale(${s0})` },
      { opacity: 1, transform: 'scale(1)', offset: 0.14 },
      { opacity: 1, transform: 'scale(1)', offset: 0.38 },
      { opacity: 0, transform: 'scale(0.9)' },
    ], { duration: dur, easing: 'cubic-bezier(.15,.85,.3,1)', fill: 'none' });

    if (kind === 'head') {
      const ring = n.querySelector('s');
      if (ring) {
        anim(ring, [
          { opacity: 1, transform: 'scale(.4)' },
          { opacity: 0.85, transform: 'scale(.92)', offset: 0.35 },
          { opacity: 0, transform: 'scale(1.35)' },
        ], { duration: 380, easing: 'cubic-bezier(.1,.8,.3,1)', fill: 'none' });
      }
    }
  }

  /**
   * @param {number} angleRad  0 = attacker dead ahead, +ve = to the right
   * @param {number} severity  0..1
   */
  damageArc(angleRad, severity = 0.5) {
    const slot = this.arcs[this._arcIdx];
    this._arcIdx = (this._arcIdx + 1) % this.arcs.length;
    const deg = (angleRad * 180) / Math.PI;
    const dur = 900 + severity * 900;
    slot.until = performance.now() + dur + 40;
    slot.node.style.opacity = '0';
    anim(slot.node, [
      { opacity: 0, transform: `rotate(${deg}deg) scale(.78)` },
      { opacity: clamp(0.42 + severity * 0.38, 0.4, 0.82), transform: `rotate(${deg}deg) scale(1.02)`, offset: 0.12 },
      { opacity: clamp(0.34 + severity * 0.32, 0.3, 0.7), transform: `rotate(${deg}deg) scale(1)`, offset: 0.45 },
      { opacity: 0, transform: `rotate(${deg}deg) scale(1.06)` },
    ], { duration: dur, easing: 'cubic-bezier(.2,.7,.35,1)', fill: 'none' });
  }

  setVisible(v) { setStyle(this.root, 'display', v ? '' : 'none'); }
}
