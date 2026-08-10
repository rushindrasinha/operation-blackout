/**
 * Kill feed (top right) and the Tab scoreboard.
 *
 * The feed is deliberately quiet: 12px condensed caps, killer at 78% white,
 * victim at 40%, a hairline weapon glyph between them, no plates, no team
 * colours. Entries slide 10px and fade; nothing pops.
 *
 * OWNER: hud (src/ui/**).
 */

import { el, text, anim, setClass, setText } from './dom.js';

const MAX_ENTRIES = 5;
const HOLD_MS = 5200;
const OUT_MS = 700;

export class KillFeed {
  constructor(parent) {
    this.root = el('div', 'killfeed', parent);
    this.entries = [];
  }

  /**
   * @param {string} killer
   * @param {string} victim
   * @param {object} o { byPlayer, againstPlayer, headshot, weapon }
   */
  push(killer, victim, o = {}) {
    const row = el('div', 'kf');
    const a = text('span', 'who' + (o.byPlayer ? ' me' : ''), String(killer || 'UNKNOWN').toUpperCase(), row);
    if (o.headshot) text('span', 'hs', '◆', row);
    text('span', 'verb', String(o.weapon || '–').toUpperCase(), row);
    const b = text('span', 'whom' + (o.againstPlayer ? ' me' : ''), String(victim || 'UNKNOWN').toUpperCase(), row);
    void a; void b;

    this.root.appendChild(row);
    const rec = { node: row, born: performance.now() };
    this.entries.push(rec);

    anim(row, [
      { opacity: 0, transform: 'translate3d(12px,0,0)' },
      { opacity: 1, transform: 'translate3d(0,0,0)' },
    ], { duration: 200, easing: 'cubic-bezier(.2,.85,.3,1)', fill: 'forwards' });

    while (this.entries.length > MAX_ENTRIES) this._retire(this.entries.shift(), 220);
  }

  _retire(rec, dur = OUT_MS) {
    if (!rec || rec.dying) return;
    rec.dying = true;
    const a = anim(rec.node, [
      { opacity: 1, transform: 'translate3d(0,0,0)' },
      { opacity: 0, transform: 'translate3d(0,-4px,0)' },
    ], { duration: dur, easing: 'ease-in', fill: 'forwards' });
    const drop = () => { try { rec.node.remove(); } catch { /* already gone */ } };
    if (a) a.onfinish = drop; else setTimeout(drop, dur);
  }

  update() {
    const now = performance.now();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!e.dying && now - e.born > HOLD_MS) {
        this._retire(e);
        this.entries.splice(i, 1);
      }
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */

const CALLSIGNS = [
  'VULTURE', 'HALVARD', 'REAPER-2', 'KESTREL', 'BOAR', 'SANDMAN',
  'IRONSIDE', 'MAGPIE', 'CRUCIBLE', 'DELTA-9', 'ROOK', 'ASHFORD',
];

export class Scoreboard {
  constructor(parent) {
    this.root = el('div', 'board', parent);
    const inner = el('div', 'board-inner', this.root);

    const head = el('div', 'board-head', inner);
    text('div', 't', 'Operation Blackout', head);
    this.mode = text('div', 'm', 'Team Deathmatch · Kharkiv Yard', head);

    const cols = el('div', 'board-cols', inner);
    text('div', null, '', cols);
    text('div', null, 'Operator', cols);
    text('div', 'n', 'K', cols);
    text('div', 'n', 'D', cols);
    text('div', 'n', 'MS', cols);

    this.rowsHost = el('div', 'board-rows', inner);
    this.foot = text('div', 'board-foot', 'Hold Tab · Scoreboard', inner);

    this.rows = [];
    this._sig = '';
    this._on = false;
  }

  setOpen(on) {
    if (on === this._on) return;
    this._on = on;
    setClass(this.root, 'on', on);
  }

  /**
   * @param {Array} roster  [{ name, kills, deaths, ping, you }]
   */
  render(roster) {
    // Cheap signature so a held Tab does not rebuild the DOM every frame.
    let sig = '';
    for (const r of roster) sig += r.name + r.kills + ',' + r.deaths + ',' + r.ping + ';';
    if (sig === this._sig) return;
    this._sig = sig;

    while (this.rows.length < roster.length) {
      const row = el('div', 'board-row', this.rowsHost);
      const cells = {
        rank: text('div', 'rk', '', row),
        name: text('div', 'nm', '', row),
        k: text('div', 'n', '', row),
        d: text('div', 'n', '', row),
        p: text('div', 'n', '', row),
      };
      this.rows.push({ row, cells });
    }
    for (let i = roster.length; i < this.rows.length; i++) {
      this.rows[i].row.style.display = 'none';
    }

    for (let i = 0; i < roster.length; i++) {
      const r = roster[i];
      const { row, cells } = this.rows[i];
      row.style.display = '';
      setClass(row, 'you', !!r.you);
      setText(cells.rank, String(i + 1));
      setText(cells.name, String(r.name).toUpperCase());
      setText(cells.k, String(r.kills));
      setText(cells.d, String(r.deaths));
      setText(cells.p, String(r.ping));
    }
  }

  /** Stable synthetic roster used until the AI system publishes real actors. */
  static fallbackRoster(seed = 7) {
    const out = [];
    let s = seed * 2654435761 >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 7; i++) {
      out.push({
        name: CALLSIGNS[i % CALLSIGNS.length],
        kills: Math.floor(rnd() * 12),
        deaths: Math.floor(rnd() * 12),
        ping: 18 + Math.floor(rnd() * 46),
      });
    }
    return out;
  }
}
