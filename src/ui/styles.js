/**
 * HUD stylesheet.
 *
 * Rules the whole file obeys:
 *  - every element is pointer-events:none so the pointer-lock canvas is never blocked
 *  - only `transform` and `opacity` are ever animated (compositor-only, zero layout)
 *  - no panels, no borders, no rounded corners, no drop shadows on containers;
 *    the only shadows are text/stroke shadows that buy legibility over any background
 *  - condensed uppercase type at 70–85% white, tracked out
 *
 * OWNER: hud (src/ui/**).
 */

export const HUD_CSS = /* css */`
#hud-root {
  position: fixed;
  inset: 0;
  z-index: 60;
  pointer-events: none;
  overflow: hidden;
  contain: layout style paint;
  -webkit-font-smoothing: antialiased;

  --f: "Barlow Condensed","Oswald","Roboto Condensed","Arial Narrow",
       "HelveticaNeue-CondensedBold","Helvetica Neue",Helvetica,Arial,sans-serif;
  --ink:      rgba(232,235,237,.84);
  --ink-dim:  rgba(226,231,234,.44);
  --ink-ghost:rgba(220,226,230,.24);
  --warn:     rgba(198,90,66,.92);
  --warn-dim: rgba(198,90,66,.5);
  --head:     rgba(255,224,176,.95);
  --sh: 0 1px 2px rgba(0,0,0,.92), 0 0 9px rgba(0,0,0,.55);

  font-family: var(--f);
  font-stretch: 75%;
  text-transform: uppercase;
  color: var(--ink);
}
#hud-root * { pointer-events: none; }

/* ────────────────────────────────────────────────────────────── full-screen fx */

#hud-root .fx-layer { position: absolute; inset: 0; }

/* Desaturation + contrast crush as health drops. Enabled only below full health;
   backdrop-filter is expensive enough that it should not run at 100hp. */
#hud-root .fx-grade {
  position: absolute; inset: 0;
  display: none;
}

/* Red edge vignette, opacity driven by missing health. */
#hud-root .fx-lowhp {
  position: absolute; inset: 0;
  opacity: 0;
  /* closest-side puts the final stop exactly on the frame edge — with the default
     farthest-corner sizing the darkest stop lands off-screen and the vignette
     reads as an overall pink wash instead of a rim. */
  background:
    radial-gradient(ellipse closest-side at 50% 50%,
      rgba(0,0,0,0) 50%,
      rgba(84,14,11,.15) 76%,
      rgba(50,7,6,.62) 100%);
  will-change: opacity;
}

/* Heartbeat / breathing throb, only while critical. */
#hud-root .fx-pulse {
  position: absolute; inset: -6%;
  opacity: 0;
  background:
    radial-gradient(ellipse closest-side at 50% 50%,
      rgba(0,0,0,0) 44%,
      rgba(112,17,13,.20) 74%,
      rgba(92,12,10,.66) 100%);
  transform: scale(1);
  will-change: opacity, transform;
}
#hud-root .fx-pulse.beating { animation: hud-heart 1.32s cubic-bezier(.3,.7,.4,1) infinite; }
@keyframes hud-heart {
  0%   { opacity: .30; transform: scale(1.00); }
  8%   { opacity: .86; transform: scale(.972); }
  20%  { opacity: .42; transform: scale(.995); }
  30%  { opacity: .70; transform: scale(.980); }
  52%  { opacity: .26; transform: scale(1.005); }
  100% { opacity: .30; transform: scale(1.00); }
}

/* Directional blood wash. Pooled; the gradient origin is placed on the viewport
   edge in the direction the shot came from. */
#hud-root .fx-blood {
  position: absolute; inset: 0;
  opacity: 0;
  will-change: opacity, transform;
}
#hud-root .fx-blood > b {
  position: absolute; inset: 0;
  display: block;
  background: radial-gradient(ellipse 48% 62% at var(--bx,50%) var(--by,0%),
    rgba(138,18,13,.86) 0%,
    rgba(108,13,10,.50) 28%,
    rgba(58,6,6,.16) 56%,
    rgba(0,0,0,0) 80%);
}
#hud-root .fx-blood > i {
  position: absolute; inset: 0;
  display: block;
  background: radial-gradient(ellipse 34% 46% at var(--bx,50%) var(--by,0%),
    rgba(150,21,15,.95) 0%,
    rgba(96,10,8,.72) 36%,
    rgba(0,0,0,0) 68%);
  -webkit-mask-size: 430px 430px;
  mask-size: 430px 430px;
  -webkit-mask-repeat: repeat;
  mask-repeat: repeat;
}

/* Sourceless damage: an all-round rim flash rather than a directional wash. */
#hud-root .fx-blood.omni > b {
  background: radial-gradient(ellipse closest-side at 50% 50%,
    rgba(0,0,0,0) 30%, rgba(104,12,10,.40) 72%, rgba(126,16,12,.84) 100%);
}
#hud-root .fx-blood.omni > i {
  background: radial-gradient(ellipse closest-side at 50% 50%,
    rgba(0,0,0,0) 44%, rgba(146,19,13,.72) 100%);
}

/* Death wash. */
#hud-root .fx-death {
  position: absolute; inset: 0;
  opacity: 0;
  background:
    radial-gradient(ellipse 90% 80% at 50% 52%,
      rgba(48,4,4,.42) 0%, rgba(26,2,2,.86) 100%);
  will-change: opacity;
}

/* ─────────────────────────────────────────────────────────────── optic / ADS */

#hud-root .optic {
  position: absolute; inset: 0;
  opacity: 0;
  display: none;
  will-change: opacity;
}
/* Peripheral defocus ring — the world outside the objective goes soft. */
/* All three optic layers size against closest-side so the tube is keyed to the
   frame height, not to the corner distance — otherwise on a 16:9 frame every stop
   lands ~30% further out than intended and the optic effectively disappears.
   (No backticks in this file below the opening template literal.) */
#hud-root .optic-blur {
  position: absolute; inset: 0;
  /* A wide, gentle ramp. A tight ramp draws a visible circle on the frame, which
     immediately reads as a CSS overlay rather than as depth of field. */
  -webkit-mask-image: radial-gradient(circle closest-side at 50% 50%,
    rgba(0,0,0,0) 34%, rgba(0,0,0,.28) 54%, rgba(0,0,0,.7) 76%, #000 100%);
  mask-image: radial-gradient(circle closest-side at 50% 50%,
    rgba(0,0,0,0) 34%, rgba(0,0,0,.28) 54%, rgba(0,0,0,.7) 76%, #000 100%);
}
#hud-root .optic-vig {
  position: absolute; inset: 0;
  background:
    radial-gradient(circle closest-side at 50% 50%,
      rgba(0,0,0,0) 40%,
      rgba(5,7,9,.13) 60%,
      rgba(4,5,7,.40) 82%,
      rgba(2,3,4,.66) 100%);
}
/* The objective-lens housing is real 3D geometry on the viewmodel. Drawing a
   second one in CSS would be skeuomorphic and would not track the weapon, so the
   rim element is kept in the tree (for layout stability) but paints nothing. */
#hud-root .optic-rim { display: none; }
#hud-root .optic-dot {
  position: absolute; left: 50%; top: 50%;
  width: 4px; height: 4px;
  margin: -2px 0 0 -2px;
  border-radius: 50%;
  background: rgba(255,64,44,.96);
  box-shadow:
    0 0 4px 1.5px rgba(255,58,38,.55),
    0 0 14px 5px rgba(240,40,24,.22);
  transform: translate3d(0,0,0);
  will-change: transform;
}

/* ────────────────────────────────────────────────────────────────── reticle */

#hud-root .reticle {
  position: absolute; left: 50%; top: 50%;
  width: 0; height: 0;
}

#hud-root .tick {
  position: absolute; left: 0; top: 0;
  width: 2px; height: 9px;
  margin: -4.5px 0 0 -1px;
  background: rgba(240,243,245,.9);
  /* 1px dark ring rather than a blur: the reticle has to survive a white sky and
     a black doorway without ever looking like it is glowing. */
  box-shadow: 0 0 0 1px rgba(0,0,0,.55);
  transform: translate3d(0,-12px,0);
  will-change: transform, opacity;
}
#hud-root .tick.l { transform: translate3d(-12px,0,0) rotate(90deg); }
#hud-root .tick.r { transform: translate3d(12px,0,0) rotate(90deg); }

#hud-root .cdot {
  position: absolute; left: 0; top: 0;
  width: 2px; height: 2px;
  margin: -1px 0 0 -1px;
  background: rgba(242,245,247,.85);
  box-shadow: 0 0 0 1px rgba(0,0,0,.5);
  opacity: 0;
  will-change: opacity;
}

/* ──────────────────────────────────────────────────────────────── hitmarker */

#hud-root .hitmark {
  position: absolute; left: 0; top: 0;
  opacity: 0;
  --hm: rgba(240,243,245,.95);
  will-change: transform, opacity;
}
/* The X sits *outside* the crosshair ticks. At ±9px it landed on top of them and
   the two marks visually cancelled — you could not tell a hit had registered. */
#hud-root .hitmark i {
  position: absolute; left: 0; top: 0;
  display: block;
  width: 2px; height: 11px;
  margin: -5.5px 0 0 -1px;
  background: var(--hm);
  box-shadow: 0 0 0 1px rgba(0,0,0,.65);
}
#hud-root .hitmark i.a { transform: translate3d(-13px,-13px,0) rotate(45deg); }
#hud-root .hitmark i.b { transform: translate3d( 13px,-13px,0) rotate(-45deg); }
#hud-root .hitmark i.c { transform: translate3d(-13px, 13px,0) rotate(-45deg); }
#hud-root .hitmark i.d { transform: translate3d( 13px, 13px,0) rotate(45deg); }

/* kill: a second, wider set of strokes */
#hud-root .hitmark u {
  position: absolute; left: 0; top: 0;
  display: none;
  width: 2px; height: 6px;
  margin: -3px 0 0 -1px;
  background: var(--hm);
  box-shadow: 0 0 0 1px rgba(0,0,0,.6);
}
#hud-root .hitmark.kill u { display: block; }
#hud-root .hitmark u.a { transform: translate3d(-23px,-23px,0) rotate(45deg); }
#hud-root .hitmark u.b { transform: translate3d( 23px,-23px,0) rotate(-45deg); }
#hud-root .hitmark u.c { transform: translate3d(-23px, 23px,0) rotate(-45deg); }
#hud-root .hitmark u.d { transform: translate3d( 23px, 23px,0) rotate(45deg); }

/* headshot: an expanding ring, thick enough to actually read at 340ms */
#hud-root .hitmark s {
  position: absolute; left: 0; top: 0;
  display: none;
  width: 40px; height: 40px;
  margin: -20px 0 0 -20px;
  border-radius: 50%;
  box-shadow: 0 0 0 1.5px var(--hm), 0 0 0 3px rgba(0,0,0,.45);
}
#hud-root .hitmark.head s { display: block; }

/* ───────────────────────────────────────────────── damage direction arcs */

#hud-root .dmgarc {
  position: absolute; left: 0; top: 0;
  width: 0; height: 0;
  opacity: 0;
  will-change: transform, opacity;
}
#hud-root .dmgarc svg {
  position: absolute; left: -110px; top: -110px;
  width: 220px; height: 220px;
  overflow: visible;
}

/* ───────────────────────────────────────────────────────────────── ammo */

#hud-root .ammo {
  position: absolute;
  right: 3.4vw; bottom: 6vh;
  text-align: right;
  line-height: 1;
  transform: translate3d(0,0,0);
  will-change: transform, opacity;
}
#hud-root .ammo-row {
  display: flex; align-items: baseline; justify-content: flex-end;
  text-shadow: var(--sh);
}
#hud-root .ammo-mag {
  font-size: 46px; font-weight: 600;
  letter-spacing: .01em;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  transform: translate3d(0,0,0);
  will-change: transform, color;
}
#hud-root .ammo-sep {
  font-size: 21px; font-weight: 300;
  margin: 0 6px 0 8px;
  color: var(--ink-ghost);
}
#hud-root .ammo-res {
  font-size: 21px; font-weight: 400;
  letter-spacing: .06em;
  color: var(--ink-dim);
  font-variant-numeric: tabular-nums;
}
#hud-root .ammo.low .ammo-mag { color: var(--warn); }
#hud-root .ammo.low .mag-fill { background: var(--warn); }
#hud-root .ammo.low { animation: hud-lowammo 1.4s ease-in-out infinite; }
@keyframes hud-lowammo {
  0%,100% { opacity: 1; }
  50%     { opacity: .7; }
}

/* Magazine state: a hairline rail whose fill is scaled on the compositor, cut into
   five-round groups by a mask. Grouping rather than per-round division keeps it a
   glanceable state graphic instead of a barcode. */
#hud-root .mag {
  position: relative;
  width: 98px; height: 2px;
  margin: 11px 0 0 auto;
  overflow: hidden;
}
#hud-root .mag-rail {
  position: absolute; inset: 0;
  background: rgba(224,230,234,.11);
}
#hud-root .mag-fill {
  position: absolute; inset: 0;
  background: rgba(232,236,238,.62);
  transform-origin: 100% 50%;
  transform: scaleX(1);
  will-change: transform;
}
#hud-root .mag-div {
  position: absolute; inset: 0;
  background: rgba(6,8,10,.8);
  -webkit-mask-image: repeating-linear-gradient(to right,
    #000 0 var(--divw,1px), rgba(0,0,0,0) var(--divw,1px) var(--divp,16px));
  mask-image: repeating-linear-gradient(to right,
    #000 0 var(--divw,1px), rgba(0,0,0,0) var(--divw,1px) var(--divp,16px));
}

#hud-root .ammo-meta {
  display: flex; align-items: baseline; justify-content: flex-end;
  gap: 12px;
  margin-top: 9px;
  font-size: 11px; letter-spacing: .26em;
  color: rgba(228,233,236,.56);
  text-shadow: var(--sh);
}
#hud-root .ammo-meta .mode { color: rgba(226,231,234,.32); letter-spacing: .3em; }

#hud-root .ammo-state {
  margin-top: 7px;
  font-size: 11px; letter-spacing: .34em;
  color: rgba(228,233,236,.62);
  text-shadow: var(--sh);
  opacity: 0;
  will-change: opacity;
}
#hud-root .ammo-state.on { opacity: 1; }

/* ──────────────────────────────────────────────────────── weapon switch */

#hud-root .wswitch {
  position: absolute;
  right: 3.4vw; bottom: calc(6vh + 122px);
  text-align: right;
  opacity: 0;
  will-change: transform, opacity;
}
#hud-root .wswitch .n {
  font-size: 17px; font-weight: 600; letter-spacing: .3em;
  color: var(--ink);
  text-shadow: var(--sh);
}
#hud-root .wswitch .s {
  margin-top: 5px;
  font-size: 10px; letter-spacing: .32em;
  color: rgba(226,231,234,.36);
  text-shadow: var(--sh);
}

/* Dead: the readouts are about a weapon you are not currently holding. */
#hud-root.dead .ammo,
#hud-root.dead .objective,
#hud-root.dead .wswitch {
  opacity: 0;
  transition: opacity .5s ease-out;
}
#hud-root .ammo, #hud-root .objective { transition: opacity .8s ease-in .4s; }

/* ─────────────────────────────────────────────────────────────── kill feed */

#hud-root .killfeed {
  position: absolute;
  right: 3.4vw; top: 4vh;
  display: flex; flex-direction: column; align-items: flex-end;
  gap: 6px;
}
#hud-root .kf {
  display: flex; align-items: center; gap: 9px;
  font-size: 12px; letter-spacing: .2em;
  white-space: nowrap;
  /* The feed sits top-right, which on this map is open sky — it needs a harder
     shadow than the rest of the HUD to survive a blown-out background. */
  text-shadow: 0 1px 2px rgba(0,0,0,.95), 0 0 4px rgba(0,0,0,.9), 0 0 12px rgba(0,0,0,.6);
  opacity: 0;
  will-change: transform, opacity;
}
#hud-root .kf .who   { color: rgba(234,237,239,.86); }
#hud-root .kf .whom  { color: rgba(226,231,234,.5); }
#hud-root .kf .me    { color: rgba(255,228,178,.92); }
#hud-root .kf .verb  { color: rgba(226,231,234,.38); font-size: 10px; letter-spacing: .16em; }
#hud-root .kf .hs    { color: var(--head); font-size: 11px; letter-spacing: 0; }

/* ─────────────────────────────────────────────────────────────── objective */

#hud-root .objective {
  position: absolute;
  left: 3.4vw; bottom: 6vh;
  font-size: 11px; letter-spacing: .28em;
  color: rgba(226,231,234,.34);
  text-shadow: var(--sh);
  line-height: 2;
}
#hud-root .objective .hi { color: rgba(228,233,236,.6); }

/* ────────────────────────────────────────────────────────────── scoreboard */

#hud-root .board {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  opacity: 0;
  visibility: hidden;
  background: rgba(5,7,9,.52);
  will-change: opacity;
  transition: opacity .11s linear, visibility 0s linear .11s;
}
#hud-root .board.on {
  opacity: 1; visibility: visible;
  transition: opacity .11s linear, visibility 0s linear 0s;
}
#hud-root .board-inner { width: min(600px, 62vw); transform: translateY(-2vh); }
#hud-root .board-head {
  display: flex; align-items: baseline; justify-content: space-between;
  padding-bottom: 9px;
  border-bottom: 1px solid rgba(232,235,237,.10);
  font-size: 12px; letter-spacing: .34em;
  color: var(--ink-dim);
}
#hud-root .board-head .t { font-size: 15px; color: var(--ink); letter-spacing: .3em; }
#hud-root .board-cols,
#hud-root .board-row {
  display: grid;
  grid-template-columns: 26px minmax(0,1fr) 46px 46px 56px;
  align-items: center;
  font-size: 13px; letter-spacing: .16em;
}
#hud-root .board-cols {
  margin-top: 12px; padding-bottom: 6px;
  font-size: 10px; letter-spacing: .3em;
  color: rgba(226,231,234,.42);
}
#hud-root .board-row {
  padding: 7px 0;
  border-top: 1px solid rgba(232,235,237,.055);
  color: var(--ink-dim);
}
#hud-root .board-row .nm { color: var(--ink); letter-spacing: .18em; }
#hud-root .board-row.you .nm { color: rgba(255,228,178,.95); }
#hud-root .board-row.you { color: rgba(240,236,226,.66); }
#hud-root .board-row .n,
#hud-root .board-cols .n { text-align: right; font-variant-numeric: tabular-nums; }
#hud-root .board-foot {
  margin-top: 14px;
  font-size: 10px; letter-spacing: .3em;
  color: var(--ink-ghost);
}

/* ────────────────────────────────────────────────────────────────── death */

#hud-root .kia {
  position: absolute; left: 0; right: 0; top: 44%;
  text-align: center;
  font-size: 15px; letter-spacing: .55em;
  color: rgba(226,208,196,.72);
  text-shadow: var(--sh);
  opacity: 0;
  will-change: opacity;
}
`;

export function injectStyles(doc = document) {
  let el = doc.getElementById('hud-style');
  if (!el) {
    el = doc.createElement('style');
    el.id = 'hud-style';
    doc.head.appendChild(el);
  }
  el.textContent = HUD_CSS;
  return el;
}
