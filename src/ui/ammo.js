/**
 * Ammunition readout, lower right.
 *
 * Understated in normal play: 84%-white condensed numerals, no box, no rule.
 * The magazine rail is a hairline whose fill is scaled on the compositor and cut
 * into round-sized divisions by a repeating mask, so firing 30 rounds costs 30
 * transform writes and zero layout.
 *
 * OWNER: hud (src/ui/**).
 */

import { el, text, anim, clamp, setText, setClass, setStyle } from './dom.js';

const MAG_W = 98;

export class AmmoReadout {
  constructor(parent) {
    this.root = el('div', 'ammo', parent);

    const row = el('div', 'ammo-row', this.root);
    this.mag = text('span', 'ammo-mag', '30', row);
    text('span', 'ammo-sep', '/', row);
    this.res = text('span', 'ammo-res', '180', row);

    this.rail = el('div', 'mag', this.root);
    el('div', 'mag-rail', this.rail);
    this.fill = el('div', 'mag-fill', this.rail);
    this.div = el('div', 'mag-div', this.rail);

    const meta = el('div', 'ammo-meta', this.root);
    this.mode = text('span', 'mode', 'AUTO', meta);
    this.name = text('span', 'wname', 'M4A1', meta);

    this.state = text('div', 'ammo-state', 'RELOADING', this.root);

    // Weapon-switch flash, sits just above the counter and vanishes.
    this.sw = el('div', 'wswitch', parent);
    this.swName = text('div', 'n', 'M4A1', this.sw);
    this.swSub = text('div', 's', 'PRIMARY · 5.56×45', this.sw);

    this._magSize = -1;
    this._fill = -1;
    this._low = false;
    this._reloadUntil = 0;
  }

  /**
   * @param {object} w   weapon descriptor: { name, ammo, magSize, reserve, mode }
   * @param {boolean} reloading
   */
  update(w, reloading) {
    const magSize = Math.max(1, w.magSize | 0 || 30);
    const ammo = clamp(w.ammo | 0, 0, magSize);
    const reserve = Math.max(0, w.reserve | 0);

    setText(this.mag, ammo < 10 ? '0' + ammo : String(ammo));
    setText(this.res, String(reserve));
    setText(this.name, String(w.name ?? 'WEAPON').toUpperCase());
    // The weapon system publishes `fireMode` as 'auto' | 'burst' | 'semi'.
    const mode = w.fireMode ?? w.mode ?? (w.rpm > 500 ? 'auto' : 'semi');
    setText(this.mode, mode === 'burst' ? '3RB' : String(mode).toUpperCase());

    // Division mask only rebuilds when the magazine capacity changes. Rounds are
    // grouped in fives above a 12-round mag — one division per round on a 30-round
    // rifle mag is a barcode, and nobody reads a barcode mid-firefight.
    if (magSize !== this._magSize) {
      this._magSize = magSize;
      const groups = magSize > 12 ? Math.max(3, Math.round(magSize / 5)) : magSize;
      const pitch = MAG_W / groups;
      this.div.style.setProperty('--divp', pitch.toFixed(3) + 'px');
      this.div.style.setProperty('--divw', '1px');
    }

    const f = ammo / magSize;
    if (Math.abs(f - this._fill) > 0.001) {
      this._fill = f;
      this.fill.style.transform = `scaleX(${f.toFixed(4)})`;
    }

    const low = ammo === 0 || f <= 0.3;
    if (low !== this._low) { this._low = low; setClass(this.root, 'low', low); }

    const showState = reloading || (ammo === 0 && reserve > 0);
    setText(this.state, reloading ? 'RELOADING' : 'RELOAD');
    setClass(this.state, 'on', showState);
  }

  /** Brief punch on the counter when a round leaves the gun. */
  fireTick() {
    anim(this.mag, [
      { transform: 'translate3d(0,0,0) scale(1.06)' },
      { transform: 'translate3d(0,0,0) scale(1)' },
    ], { duration: 110, easing: 'ease-out', fill: 'none' });
  }

  /** Red slap when the trigger clicks on an empty chamber. */
  emptyTick() {
    anim(this.root, [
      { transform: 'translate3d(0,0,0)', opacity: 1 },
      { transform: 'translate3d(-4px,0,0)', opacity: .55, offset: .2 },
      { transform: 'translate3d(3px,0,0)', opacity: 1, offset: .55 },
      { transform: 'translate3d(0,0,0)', opacity: 1 },
    ], { duration: 220, easing: 'ease-out', fill: 'none' });
  }

  showSwitch(name, sub) {
    setText(this.swName, String(name ?? '').toUpperCase());
    setText(this.swSub, String(sub ?? '').toUpperCase());
    anim(this.sw, [
      { opacity: 0, transform: 'translate3d(14px,0,0)' },
      { opacity: 1, transform: 'translate3d(0,0,0)', offset: 0.12 },
      { opacity: 1, transform: 'translate3d(0,0,0)', offset: 0.66 },
      { opacity: 0, transform: 'translate3d(0,-6px,0)' },
    ], { duration: 1600, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'none' });

    anim(this.root, [
      { opacity: 0.25, transform: 'translate3d(0,7px,0)' },
      { opacity: 1, transform: 'translate3d(0,0,0)' },
    ], { duration: 260, easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'none' });
  }

  setVisible(v) { setStyle(this.root, 'opacity', v ? '' : '0'); }
}
