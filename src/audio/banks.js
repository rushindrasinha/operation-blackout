/**
 * The sound bank. Every id the game can play is synthesised here, offline, into
 * a Float32Array. No sample files exist anywhere in this project.
 *
 * Design notes on the weapon report, because it is the sound that matters most:
 *
 *   layer 1  transient crack   0.3ms attack, ~4ms decay, band-limited noise.
 *                              This is the part your ear localises.
 *   layer 2  supersonic snap   HP-filtered noise, 2ms. The N-wave of the round
 *                              leaving the muzzle faster than sound.
 *   layer 3  blast body        pitch-swept sine (300→70Hz) + LP noise. The
 *                              expanding gas column. Gives it weight.
 *   layer 4  sub               45→30Hz sine, only audible up close.
 *   layer 5  mechanical action bolt unlocking, travelling back, slamming home.
 *                              Three separate metallic events over ~70ms.
 *
 * The TAIL is not in the buffer — it comes from the ConvolverNode, so the same
 * shot sounds different in a warehouse and on open ground. See impulses.js.
 *
 * OWNER: audio.
 */

import {
  Rng, buf, white, pink, biquad, svfSweep, onePoleSweep, envAD, applyEnv,
  mixInto, scale, decaySine, noiseBurst, normalizePeak, softClip, fadeEdges,
  dcBlock,
} from './dsp.js';

/* ─────────────────────────────── weapons ──────────────────────────────── */

function mechAction(out, sr, rng, t0, gain, bright) {
  // Bolt unlock — a small, tight metallic tick.
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.02, attack: 0.00015, tau: 0.0028, bp: 2600 * bright, bpQ: 1.1, hp: 900,
  }), Math.round(t0 * sr), 0.30 * gain);

  // Carrier travelling rearward — a short burst of rail friction.
  const trav = noiseBurst(sr, rng, {
    dur: 0.035, attack: 0.004, tau: 0.012, bp: 1500 * bright, bpQ: 0.9, hp: 600,
  });
  mixInto(out, trav, Math.round((t0 + 0.006) * sr), 0.13 * gain);

  // Bolt bottoming out, then slamming forward: two hard clacks with ring.
  const clacks = [
    { t: t0 + 0.028, g: 0.55, f: 3100 },
    { t: t0 + 0.055, g: 0.85, f: 2400 },
  ];
  for (const c of clacks) {
    const off = Math.round(c.t * sr);
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.03, attack: 0.0001, tau: 0.0022, tau2: 0.010, amp2: 0.35,
      hp: 700, bp: c.f * bright, bpQ: 0.8,
    }), off, c.g * gain);
    // Inharmonic ring of the receiver.
    decaySine(out, sr, { freq: c.f * bright * 1.02, tau: 0.014, amp: 0.10 * c.g * gain, offset: off, glide: 0 });
    decaySine(out, sr, { freq: c.f * bright * 1.63, tau: 0.009, amp: 0.06 * c.g * gain, offset: off, glide: 0 });
    decaySine(out, sr, { freq: c.f * bright * 0.47, tau: 0.020, amp: 0.07 * c.g * gain, offset: off, glide: 0 });
  }
  // Recoil spring — the faint twang that reads as "AR-15".
  decaySine(out, sr, {
    freq: 780, freqEnd: 640, tau: 0.055, amp: 0.045 * gain,
    offset: Math.round((t0 + 0.03) * sr), glide: 0.03, fm: 0.06, fmHz: 90,
  });
  return out;
}

function gunshot(sr, rng, cfg) {
  const {
    dur = 0.42, crackHz = 3100, crackTau = 0.0042, bodyF0 = 300, bodyF1 = 72,
    bodyTau = 0.038, subF0 = 48, subTau = 0.10, snapAmp = 0.5, bodyAmp = 0.85,
    mechT = 0.022, mechGain = 1, bright = 1, punchHz = 620, drive = 1.9,
  } = cfg;
  const n = Math.round(dur * sr);
  const out = buf(n);

  // ── 1. transient crack ────────────────────────────────────────────────
  {
    const b = noiseBurst(sr, rng, {
      dur: 0.055, attack: 0.00018, tau: crackTau, tau2: crackTau * 4.5, amp2: 0.34,
      hp: 620,
    });
    biquad(b, 'peaking', crackHz, 0.9, sr, 8.5);
    biquad(b, 'peaking', crackHz * 2.1, 1.4, sr, 4.0);
    biquad(b, 'lowpass', 12500, 0.6, sr, 0, 2);
    mixInto(out, b, 0, 1.0);
  }

  // ── 2. supersonic snap ────────────────────────────────────────────────
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.014, attack: 0.00008, tau: 0.0019, hp: 4600 * bright,
  }), 0, snapAmp);

  // ── 3. blast body: gas column + LP noise ──────────────────────────────
  decaySine(out, sr, {
    freq: bodyF0, freqEnd: bodyF1, tau: bodyTau, amp: 0.62 * bodyAmp,
    glide: 0.016, attack: 0.0006,
  });
  {
    const b = noiseBurst(sr, rng, {
      dur: 0.20, attack: 0.0009, tau: bodyTau * 1.7, tau2: bodyTau * 5, amp2: 0.22,
      lp: 320,
    });
    mixInto(out, b, 0, 1.15 * bodyAmp);
  }
  // Mid punch — the chest-hit band that makes it feel loud rather than bright.
  {
    const b = noiseBurst(sr, rng, {
      dur: 0.09, attack: 0.0005, tau: 0.016, tau2: 0.05, amp2: 0.25,
      bp: punchHz, bpQ: 0.75,
    });
    mixInto(out, b, 0, 0.75 * bodyAmp);
  }

  // ── 4. sub ────────────────────────────────────────────────────────────
  decaySine(out, sr, {
    freq: subF0, freqEnd: subF0 * 0.68, tau: subTau, amp: 0.34,
    glide: 0.05, attack: 0.0015,
  });

  // ── 5. mechanical action ──────────────────────────────────────────────
  mechAction(out, sr, rng, mechT, mechGain, bright);

  dcBlock(out, sr);
  softClip(out, drive);
  normalizePeak(out, 0.97);
  fadeEdges(out, sr, 0.15, 10);
  return out;
}

/** A shot heard from hundreds of metres: no crack, all boom and echo. */
function distantShot(sr, rng) {
  const dur = 0.9;
  const n = Math.round(dur * sr);
  const out = buf(n);
  decaySine(out, sr, { freq: 170, freqEnd: 58, tau: 0.055, amp: 0.7, glide: 0.02 });
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.5, attack: 0.004, tau: 0.07, tau2: 0.22, amp2: 0.3, lp: 700,
  }), 0, 0.9);
  // Return echoes off distant structures.
  for (let i = 0; i < 4; i++) {
    const t = 0.06 + i * rng.range(0.055, 0.14) + i * i * 0.02;
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.22, attack: 0.006, tau: 0.05 + i * 0.02, lp: 520 - i * 90, hp: 90,
    }), Math.round(t * sr), 0.34 * Math.exp(-i * 0.5));
  }
  onePoleSweep(out, 900, 320, sr);
  dcBlock(out, sr);
  normalizePeak(out, 0.82);
  fadeEdges(out, sr, 2, 60);
  return out;
}

/* ────────────────────────────── reloading ─────────────────────────────── */

function magOut(sr, rng) {
  const n = Math.round(0.5 * sr);
  const out = buf(n);
  // Magazine catch — a firm sprung button.
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.03, attack: 0.0002, tau: 0.004, tau2: 0.014, amp2: 0.3, bp: 2200, bpQ: 0.9, hp: 700,
  }), 0, 0.75);
  decaySine(out, sr, { freq: 1850, tau: 0.012, amp: 0.10, glide: 0 });
  // Magazine sliding free of the well — rising friction, then release.
  {
    const d = 0.13, m = Math.round(d * sr);
    const b = white(m, rng);
    svfSweep(b, 900, 2100, 1.5, sr, 'band');
    const e = buf(m);
    for (let i = 0; i < m; i++) {
      const t = i / m;
      e[i] = Math.sin(Math.PI * Math.pow(t, 0.75)) * (0.55 + 0.45 * Math.sin(t * 40));
    }
    applyEnv(b, e);
    mixInto(out, b, Math.round(0.05 * sr), 0.30);
  }
  // Polymer body knocking the trigger guard on its way past.
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.05, attack: 0.0004, tau: 0.008, tau2: 0.03, amp2: 0.4, bp: 1100, bpQ: 0.7, hp: 300,
  }), Math.round(rng.range(0.19, 0.24) * sr), 0.42);
  decaySine(out, sr, { freq: 430, tau: 0.03, amp: 0.09, offset: Math.round(0.20 * sr), glide: 0 });
  // Gear/sling rustle underneath.
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.3, attack: 0.02, tau: 0.09, bp: 3400, bpQ: 0.5, hp: 1200,
  }), Math.round(0.08 * sr), 0.10);
  dcBlock(out, sr); normalizePeak(out, 0.8); fadeEdges(out, sr, 0.5, 14);
  return out;
}

function magIn(sr, rng) {
  const n = Math.round(0.46 * sr);
  const out = buf(n);
  // Approach — fabric and a fresh mag being lifted into the well.
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.16, attack: 0.05, tau: 0.05, bp: 2600, bpQ: 0.55, hp: 900,
  }), 0, 0.13);
  // Feed lips scraping the magwell.
  {
    const d = 0.06, m = Math.round(d * sr);
    const b = white(m, rng);
    svfSweep(b, 2600, 1300, 1.8, sr, 'band');
    applyEnv(b, envAD(m, sr, 0.006, 0.02));
    mixInto(out, b, Math.round(0.13 * sr), 0.22);
  }
  // The seat — a hard, heavy, deeply satisfying CLACK.
  {
    const off = Math.round(0.19 * sr);
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.05, attack: 0.0001, tau: 0.0028, tau2: 0.016, amp2: 0.35, hp: 420, lp: 8000,
    }), off, 1.0);
    decaySine(out, sr, { freq: 148, freqEnd: 110, tau: 0.035, amp: 0.40, offset: off, glide: 0.01 });
    decaySine(out, sr, { freq: 1240, tau: 0.020, amp: 0.14, offset: off, glide: 0 });
    decaySine(out, sr, { freq: 2810, tau: 0.011, amp: 0.09, offset: off, glide: 0 });
    decaySine(out, sr, { freq: 4630, tau: 0.007, amp: 0.05, offset: off, glide: 0 });
  }
  // Palm slap confirming the seat.
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.07, attack: 0.0006, tau: 0.011, tau2: 0.035, amp2: 0.3, lp: 1500, hp: 160,
  }), Math.round(0.245 * sr), 0.34);
  dcBlock(out, sr); softClip(out, 1.3); normalizePeak(out, 0.9); fadeEdges(out, sr, 0.5, 16);
  return out;
}

function chargeHandle(sr, rng) {
  const n = Math.round(0.38 * sr);
  const out = buf(n);
  // Handle drawn back against the spring — swept resonance, rising.
  {
    const d = 0.085, m = Math.round(d * sr);
    const b = white(m, rng);
    svfSweep(b, 780, 2050, 2.4, sr, 'band');
    const e = envAD(m, sr, 0.008, 0.055);
    for (let i = 0; i < m; i++) e[i] *= 0.7 + 0.3 * Math.sin(i * 0.07);
    applyEnv(b, e);
    mixInto(out, b, 0, 0.45);
  }
  decaySine(out, sr, { freq: 640, freqEnd: 980, tau: 0.07, amp: 0.07, glide: 0.05 });
  // Bolt released — hard slam, big ring.
  {
    const off = Math.round(0.115 * sr);
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.06, attack: 0.0001, tau: 0.0026, tau2: 0.018, amp2: 0.4, hp: 500,
    }), off, 1.0);
    decaySine(out, sr, { freq: 205, freqEnd: 160, tau: 0.03, amp: 0.30, offset: off, glide: 0.01 });
    decaySine(out, sr, { freq: 1680, tau: 0.028, amp: 0.16, offset: off, glide: 0 });
    decaySine(out, sr, { freq: 3120, tau: 0.016, amp: 0.10, offset: off, glide: 0 });
    decaySine(out, sr, { freq: 5240, tau: 0.009, amp: 0.06, offset: off, glide: 0 });
    // Spring resonance singing behind the clack.
    decaySine(out, sr, {
      freq: 890, freqEnd: 730, tau: 0.11, amp: 0.075, offset: off,
      glide: 0.06, fm: 0.09, fmHz: 74,
    });
  }
  dcBlock(out, sr); softClip(out, 1.35); normalizePeak(out, 0.92); fadeEdges(out, sr, 0.5, 20);
  return out;
}

function weaponSwap(sr, rng) {
  const n = Math.round(0.4 * sr);
  const out = buf(n);
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.26, attack: 0.03, tau: 0.10, bp: 2900, bpQ: 0.5, hp: 800,
  }), 0, 0.22);
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.04, attack: 0.0003, tau: 0.006, tau2: 0.02, amp2: 0.3, bp: 1800, bpQ: 0.8, hp: 500,
  }), Math.round(0.12 * sr), 0.45);
  decaySine(out, sr, { freq: 1320, tau: 0.02, amp: 0.09, offset: Math.round(0.12 * sr), glide: 0 });
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.05, attack: 0.0003, tau: 0.007, tau2: 0.024, amp2: 0.3, bp: 900, bpQ: 0.7, hp: 260,
  }), Math.round(0.22 * sr), 0.38);
  dcBlock(out, sr); normalizePeak(out, 0.62); fadeEdges(out, sr, 0.5, 16);
  return out;
}

function emptyClick(sr, rng) {
  const n = Math.round(0.09 * sr);
  const out = buf(n);
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.014, attack: 0.00008, tau: 0.0016, hp: 1400, bp: 3800, bpQ: 1.0,
  }), 0, 1.0);
  decaySine(out, sr, { freq: 3450, tau: 0.006, amp: 0.22, glide: 0 });
  decaySine(out, sr, { freq: 5900, tau: 0.0035, amp: 0.12, glide: 0 });
  decaySine(out, sr, { freq: 1150, tau: 0.010, amp: 0.10, glide: 0 });
  // Hammer following through onto the frame.
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.02, attack: 0.0002, tau: 0.004, lp: 900, hp: 200,
  }), Math.round(0.004 * sr), 0.30);
  dcBlock(out, sr); normalizePeak(out, 0.72); fadeEdges(out, sr, 0.3, 8);
  return out;
}

/* ─────────────────────────────── impacts ──────────────────────────────── */

function impactConcrete(sr, rng) {
  const n = Math.round(0.42 * sr);
  const out = buf(n);
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.06, attack: 0.00012, tau: 0.0045, tau2: 0.022, amp2: 0.3, bp: 1900, bpQ: 0.55, hp: 320,
  }), 0, 1.0);
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.02, attack: 0.00008, tau: 0.0022, hp: 5200,
  }), 0, 0.34);
  decaySine(out, sr, { freq: 165, freqEnd: 108, tau: 0.028, amp: 0.34, glide: 0.012 });
  // Spalled grit raining down — a scatter of tiny grains.
  for (let i = 0; i < 11; i++) {
    const t = rng.range(0.02, 0.30);
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.012, attack: 0.0002, tau: rng.range(0.0012, 0.004),
      bp: rng.range(2600, 7200), bpQ: 1.4, hp: 1600,
    }), Math.round(t * sr), rng.range(0.03, 0.11) * Math.exp(-t * 4));
  }
  dcBlock(out, sr); softClip(out, 1.3); normalizePeak(out, 0.9); fadeEdges(out, sr, 0.2, 20);
  return out;
}

function impactMetal(sr, rng) {
  const n = Math.round(0.55 * sr);
  const out = buf(n);
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.03, attack: 0.00008, tau: 0.0022, tau2: 0.010, amp2: 0.25, hp: 1500,
  }), 0, 0.9);
  // Inharmonic plate partials — this is what makes metal read as metal.
  const base = rng.range(1500, 2100);
  const ratios = [1, 1.53, 2.31, 3.17, 4.42, 5.86];
  for (let i = 0; i < ratios.length; i++) {
    const f = base * ratios[i] * rng.range(0.97, 1.03);
    decaySine(out, sr, {
      freq: f, freqEnd: f * 0.995, tau: 0.11 / (1 + i * 0.55), amp: 0.30 / (1 + i * 0.7),
      glide: 0.2, fm: 0.004, fmHz: 6 + i * 3,
    });
  }
  // Ricochet whine — the round leaving with a spin.
  {
    const d = 0.22, m = Math.round(d * sr);
    const b = white(m, rng);
    svfSweep(b, 3400, 1150, 6, sr, 'band', 0.8);
    applyEnv(b, envAD(m, sr, 0.004, 0.05, 1, 0.12, 0.2));
    mixInto(out, b, Math.round(0.006 * sr), 0.30);
  }
  decaySine(out, sr, { freq: 240, freqEnd: 180, tau: 0.02, amp: 0.16, glide: 0.01 });
  dcBlock(out, sr); softClip(out, 1.2); normalizePeak(out, 0.88); fadeEdges(out, sr, 0.2, 24);
  return out;
}

function impactDirt(sr, rng) {
  const n = Math.round(0.3 * sr);
  const out = buf(n);
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.14, attack: 0.0016, tau: 0.018, tau2: 0.06, amp2: 0.3, lp: 480, hp: 90,
  }), 0, 1.0);
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.05, attack: 0.0004, tau: 0.008, bp: 1400, bpQ: 0.6, hp: 300,
  }), 0, 0.30);
  decaySine(out, sr, { freq: 110, freqEnd: 74, tau: 0.035, amp: 0.30, glide: 0.014 });
  for (let i = 0; i < 7; i++) {
    const t = rng.range(0.03, 0.2);
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.014, attack: 0.0004, tau: rng.range(0.002, 0.006), bp: rng.range(900, 2600), bpQ: 1.1,
    }), Math.round(t * sr), rng.range(0.03, 0.09));
  }
  dcBlock(out, sr); normalizePeak(out, 0.85); fadeEdges(out, sr, 0.3, 20);
  return out;
}

function impactWood(sr, rng) {
  const n = Math.round(0.34 * sr);
  const out = buf(n);
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.05, attack: 0.0001, tau: 0.0035, tau2: 0.016, amp2: 0.3, bp: 1100, bpQ: 0.6, hp: 200,
  }), 0, 1.0);
  const base = rng.range(320, 470);
  for (const r of [1, 2.76, 5.4]) {
    decaySine(out, sr, { freq: base * r * rng.range(0.97, 1.03), tau: 0.06 / r, amp: 0.22 / r, glide: 0 });
  }
  // Splintering.
  for (let i = 0; i < 6; i++) {
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.02, attack: 0.0003, tau: rng.range(0.002, 0.007), bp: rng.range(1800, 5200), bpQ: 1.3,
    }), Math.round(rng.range(0.005, 0.12) * sr), rng.range(0.04, 0.12));
  }
  dcBlock(out, sr); normalizePeak(out, 0.85); fadeEdges(out, sr, 0.2, 18);
  return out;
}

function impactGlass(sr, rng) {
  const n = Math.round(0.6 * sr);
  const out = buf(n);
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.02, attack: 0.00006, tau: 0.0016, hp: 3000,
  }), 0, 0.7);
  for (let i = 0; i < 14; i++) {
    const f = rng.range(2200, 9000);
    decaySine(out, sr, {
      freq: f, tau: rng.range(0.02, 0.1), amp: rng.range(0.05, 0.16),
      offset: Math.round(rng.range(0, 0.04) * sr), glide: 0,
    });
  }
  // Shards falling.
  for (let i = 0; i < 16; i++) {
    const t = rng.range(0.04, 0.45);
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.012, attack: 0.0001, tau: rng.range(0.001, 0.004), bp: rng.range(3500, 9500), bpQ: 2,
    }), Math.round(t * sr), rng.range(0.04, 0.14) * Math.exp(-t * 3));
  }
  dcBlock(out, sr); normalizePeak(out, 0.8); fadeEdges(out, sr, 0.2, 30);
  return out;
}

function impactFlesh(sr, rng) {
  const n = Math.round(0.26 * sr);
  const out = buf(n);
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.09, attack: 0.0008, tau: 0.012, tau2: 0.045, amp2: 0.25, lp: 620, hp: 70,
  }), 0, 1.0);
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.035, attack: 0.0003, tau: 0.006, bp: 1500, bpQ: 0.7, hp: 400,
  }), 0, 0.28);
  decaySine(out, sr, { freq: 128, freqEnd: 82, tau: 0.03, amp: 0.36, glide: 0.012 });
  // Plate carrier / webbing snapping.
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.05, attack: 0.001, tau: 0.014, bp: 2800, bpQ: 0.6, hp: 1200,
  }), Math.round(0.004 * sr), 0.16);
  dcBlock(out, sr); softClip(out, 1.2); normalizePeak(out, 0.85); fadeEdges(out, sr, 0.3, 16);
  return out;
}

/* ─────────────────────────────── footsteps ────────────────────────────── */

const STEP_PROFILES = {
  concrete: { thud: 92, thudTau: 0.028, scuffBp: 2400, scuffQ: 0.5, scuffTau: 0.030, grit: 7, gritHz: [2400, 7000], lp: 0, amp: 1.0 },
  metal:    { thud: 130, thudTau: 0.022, scuffBp: 3200, scuffQ: 0.6, scuffTau: 0.026, grit: 4, gritHz: [3000, 8000], lp: 0, amp: 1.05, ring: true },
  dirt:     { thud: 74, thudTau: 0.034, scuffBp: 900,  scuffQ: 0.45, scuffTau: 0.050, grit: 14, gritHz: [700, 3200], lp: 3400, amp: 0.92 },
  wood:     { thud: 160, thudTau: 0.030, scuffBp: 1500, scuffQ: 0.55, scuffTau: 0.030, grit: 4, gritHz: [1200, 4200], lp: 6000, amp: 0.98, woodRing: true },
  soft:     { thud: 66, thudTau: 0.040, scuffBp: 620,  scuffQ: 0.4, scuffTau: 0.060, grit: 5, gritHz: [500, 1800], lp: 1800, amp: 0.75 },
};

function footstep(sr, rng, surface) {
  const p = STEP_PROFILES[surface] || STEP_PROFILES.concrete;
  const n = Math.round(0.3 * sr);
  const out = buf(n);
  // Heel strike.
  decaySine(out, sr, {
    freq: p.thud * rng.range(0.92, 1.08), freqEnd: p.thud * 0.65,
    tau: p.thudTau, amp: 0.5, glide: 0.012, attack: 0.0012,
  });
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.09, attack: 0.0011, tau: p.thudTau * 0.8, tau2: p.thudTau * 2.4, amp2: 0.25,
    lp: 380, hp: 55,
  }), 0, 0.7);
  // Sole scuff / roll onto the ball of the foot.
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.16, attack: 0.0022, tau: p.scuffTau, tau2: p.scuffTau * 3, amp2: 0.2,
    bp: p.scuffBp * rng.range(0.9, 1.12), bpQ: p.scuffQ, hp: 260,
  }), Math.round(0.004 * sr), 0.5);
  // Loose material displaced under the boot.
  for (let i = 0; i < p.grit; i++) {
    const t = rng.range(0.001, 0.10);
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.01, attack: 0.0002, tau: rng.range(0.0008, 0.003),
      bp: rng.range(p.gritHz[0], p.gritHz[1]), bpQ: 1.6,
    }), Math.round(t * sr), rng.range(0.02, 0.085));
  }
  if (p.ring) {
    // Sheet metal / grating flexing.
    const b0 = rng.range(280, 420);
    for (const r of [1, 2.4, 3.9, 6.1]) {
      decaySine(out, sr, { freq: b0 * r, tau: 0.09 / r, amp: 0.10 / r, glide: 0, fm: 0.01, fmHz: 9 });
    }
  }
  if (p.woodRing) {
    const b0 = rng.range(180, 260);
    for (const r of [1, 2.9]) decaySine(out, sr, { freq: b0 * r, tau: 0.05 / r, amp: 0.12 / r, glide: 0 });
  }
  if (p.lp) biquad(out, 'lowpass', p.lp, 0.7, sr);
  dcBlock(out, sr);
  normalizePeak(out, 0.62 * p.amp);
  fadeEdges(out, sr, 0.4, 18);
  return out;
}

function landing(sr, rng) {
  const n = Math.round(0.45 * sr);
  const out = buf(n);
  decaySine(out, sr, { freq: 88, freqEnd: 48, tau: 0.055, amp: 0.72, glide: 0.018, attack: 0.001 });
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.18, attack: 0.0009, tau: 0.03, tau2: 0.09, amp2: 0.28, lp: 700, hp: 50,
  }), 0, 0.85);
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.1, attack: 0.0006, tau: 0.018, bp: 2100, bpQ: 0.5, hp: 500,
  }), 0, 0.32);
  // Kit and slung gear landing a beat later.
  for (let i = 0; i < 6; i++) {
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.03, attack: 0.0003, tau: rng.range(0.003, 0.010),
      bp: rng.range(1400, 4600), bpQ: 1.2, hp: 700,
    }), Math.round(rng.range(0.03, 0.17) * sr), rng.range(0.05, 0.15));
  }
  dcBlock(out, sr); softClip(out, 1.2); normalizePeak(out, 0.9); fadeEdges(out, sr, 0.4, 24);
  return out;
}

/* ──────────────────────── whiz / shells / feedback ────────────────────── */

/**
 * Bullet whiz-by. The doppler is baked in as a frequency sweep — the panner is
 * additionally flown along the round's trajectory at play time, which is what
 * sells the "it went past my left ear" read.
 */
function bulletWhiz(sr, rng) {
  const dur = 0.30;
  const n = Math.round(dur * sr);
  const out = buf(n);
  const b = white(n, rng);
  const f0 = rng.range(2600, 3600), f1 = rng.range(700, 1050);
  svfSweep(b, f0, f1, rng.range(2.4, 4.2), sr, 'band', 0.85);
  // Approach swell then rapid recede.
  const e = buf(n);
  const peak = 0.36;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    e[i] = t < peak
      ? Math.pow(t / peak, 2.4)
      : Math.exp(-(t - peak) * 7.5);
  }
  applyEnv(b, e);
  mixInto(out, b, 0, 1.0);
  // Supersonic crack at closest approach.
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.02, attack: 0.00008, tau: 0.0022, hp: 3200,
  }), Math.round(peak * n), 0.55);
  // Low wake behind it.
  decaySine(out, sr, {
    freq: 420, freqEnd: 190, tau: 0.05, amp: 0.10,
    offset: Math.round(peak * n), glide: 0.03,
  });
  dcBlock(out, sr); normalizePeak(out, 0.82); fadeEdges(out, sr, 1, 24);
  return out;
}

/** Brass on concrete: a bright inharmonic tink, bouncing 3–4 times. */
function shellCasing(sr, rng) {
  const n = Math.round(0.9 * sr);
  const out = buf(n);
  let t = 0;
  let amp = 1;
  let gap = rng.range(0.10, 0.16);
  const partials = [];
  const base = rng.range(3600, 5200);
  for (const r of [1, 1.41, 1.87, 2.53, 3.31, 4.17]) partials.push(base * r * rng.range(0.97, 1.03));
  for (let bounce = 0; bounce < 5 && t < 0.8; bounce++) {
    const off = Math.round(t * sr);
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.012, attack: 0.00006, tau: 0.0012, hp: 2600,
    }), off, 0.35 * amp);
    for (let i = 0; i < partials.length; i++) {
      decaySine(out, sr, {
        freq: partials[i] * rng.range(0.995, 1.005),
        tau: (0.055 / (1 + i * 0.6)) * (0.6 + 0.4 * amp),
        amp: (0.30 / (1 + i * 0.85)) * amp,
        offset: off, glide: 0, fm: 0.006, fmHz: 11 + i * 5,
      });
    }
    t += gap;
    gap *= rng.range(0.5, 0.66);
    amp *= rng.range(0.42, 0.6);
  }
  // Final roll/settle.
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.16, attack: 0.01, tau: 0.05, bp: rng.range(4500, 7000), bpQ: 1.4, hp: 2500,
  }), Math.round(Math.min(0.6, t) * sr), 0.07);
  dcBlock(out, sr); normalizePeak(out, 0.5); fadeEdges(out, sr, 0.2, 30);
  return out;
}

function hitmarker(sr, rng, headshot = false) {
  const n = Math.round(0.09 * sr);
  const out = buf(n);
  const f = headshot ? 2350 : 1780;
  decaySine(out, sr, { freq: f, tau: 0.013, amp: 0.5, glide: 0, attack: 0.0004 });
  decaySine(out, sr, { freq: f * 1.5, tau: 0.009, amp: 0.28, glide: 0, attack: 0.0004 });
  if (headshot) decaySine(out, sr, { freq: f * 2.25, tau: 0.02, amp: 0.22, offset: Math.round(0.022 * sr), glide: 0, attack: 0.0004 });
  mixInto(out, noiseBurst(sr, rng, { dur: 0.008, attack: 0.00008, tau: 0.0011, hp: 2600 }), 0, 0.30);
  dcBlock(out, sr); normalizePeak(out, 0.55); fadeEdges(out, sr, 0.3, 12);
  return out;
}

function death(sr, rng) {
  const n = Math.round(1.35 * sr);
  const out = buf(n);
  // Involuntary exhale — two noise formants, no vocal cords.
  {
    const d = 0.42, m = Math.round(d * sr);
    const b = white(m, rng);
    const f1 = white(m, rng);
    biquad(b, 'bandpass', rng.range(360, 470), 3.2, sr);
    biquad(f1, 'bandpass', rng.range(950, 1250), 2.6, sr);
    for (let i = 0; i < m; i++) b[i] = b[i] * 0.75 + f1[i] * 0.45;
    const e = buf(m);
    for (let i = 0; i < m; i++) {
      const t = i / m;
      e[i] = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.6)), 1.6) * (1 - t * 0.3);
    }
    applyEnv(b, e);
    biquad(b, 'lowpass', 2400, 0.7, sr);
    mixInto(out, b, 0, 0.45);
  }
  // Knees, then torso.
  const thuds = [
    { t: 0.30, f: 96, g: 0.5 },
    { t: 0.47, f: 66, g: 0.95 },
  ];
  for (const th of thuds) {
    const off = Math.round(th.t * sr);
    decaySine(out, sr, { freq: th.f, freqEnd: th.f * 0.62, tau: 0.06, amp: 0.6 * th.g, offset: off, glide: 0.02 });
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.22, attack: 0.0012, tau: 0.035, tau2: 0.11, amp2: 0.25, lp: 560, hp: 55,
    }), off, 0.7 * th.g);
  }
  // Kit, sling, magazines settling.
  for (let i = 0; i < 14; i++) {
    const t = rng.range(0.30, 0.95);
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.04, attack: 0.0003, tau: rng.range(0.003, 0.012),
      bp: rng.range(1200, 5200), bpQ: 1.3, hp: 600,
    }), Math.round(t * sr), rng.range(0.03, 0.14) * Math.exp(-(t - 0.3) * 1.6));
  }
  // Rifle hitting the deck.
  {
    const off = Math.round(rng.range(0.55, 0.75) * sr);
    mixInto(out, noiseBurst(sr, rng, {
      dur: 0.05, attack: 0.0002, tau: 0.005, tau2: 0.02, amp2: 0.3, bp: 1500, bpQ: 0.7, hp: 400,
    }), off, 0.30);
    decaySine(out, sr, { freq: 2100, tau: 0.03, amp: 0.08, offset: off, glide: 0 });
    decaySine(out, sr, { freq: 210, tau: 0.04, amp: 0.14, offset: off, glide: 0 });
  }
  dcBlock(out, sr); softClip(out, 1.15); normalizePeak(out, 0.85); fadeEdges(out, sr, 1, 60);
  return out;
}

function playerHurt(sr, rng) {
  const n = Math.round(0.55 * sr);
  const out = buf(n);
  // Round on plate — felt more than heard.
  decaySine(out, sr, { freq: 74, freqEnd: 44, tau: 0.07, amp: 0.7, glide: 0.02 });
  mixInto(out, noiseBurst(sr, rng, {
    dur: 0.12, attack: 0.0006, tau: 0.018, tau2: 0.05, amp2: 0.3, lp: 900, hp: 60,
  }), 0, 0.7);
  // Short breath response.
  {
    const d = 0.26, m = Math.round(d * sr);
    const b = white(m, rng);
    biquad(b, 'bandpass', rng.range(420, 560), 2.4, sr);
    applyEnv(b, envAD(m, sr, 0.012, 0.07, 1, 0.16, 0.25));
    mixInto(out, b, Math.round(0.05 * sr), 0.22);
  }
  dcBlock(out, sr); normalizePeak(out, 0.8); fadeEdges(out, sr, 0.5, 30);
  return out;
}

/* ─────────────────────────── bank assembly ────────────────────────────── */

/**
 * Builds every buffer. Yields between groups so the loading bar keeps moving
 * and the main thread never blocks long enough to be noticed.
 */
export async function buildBank(sr, onProgress = () => {}) {
  const bank = {};
  const rng = new Rng(0x5eed1);
  const yieldNow = () => new Promise((r) => setTimeout(r, 0));

  const groups = [
    ['rifle_fire', 5, () => gunshot(sr, rng, {
      crackHz: rng.range(2850, 3350), crackTau: rng.range(0.0038, 0.0048),
      bodyF0: rng.range(280, 330), bodyF1: rng.range(66, 80),
      bodyTau: rng.range(0.034, 0.043), subF0: rng.range(45, 52),
      snapAmp: rng.range(0.42, 0.58), mechT: rng.range(0.019, 0.026),
      bright: rng.range(0.95, 1.06), punchHz: rng.range(560, 690),
    })],
    ['smg_fire', 4, () => gunshot(sr, rng, {
      dur: 0.34, crackHz: rng.range(3500, 4200), crackTau: rng.range(0.0028, 0.0036),
      bodyF0: rng.range(230, 275), bodyF1: rng.range(84, 100),
      bodyTau: rng.range(0.022, 0.030), subF0: rng.range(56, 64), subTau: 0.07,
      snapAmp: rng.range(0.30, 0.42), bodyAmp: 0.66, mechT: rng.range(0.014, 0.019),
      mechGain: 1.15, bright: rng.range(1.10, 1.22), punchHz: rng.range(700, 840),
      drive: 1.7,
    })],
    ['fire_distant', 3, () => distantShot(sr, rng)],
    ['reload_mag_out', 3, () => magOut(sr, rng)],
    ['reload_mag_in', 3, () => magIn(sr, rng)],
    ['reload_charge', 3, () => chargeHandle(sr, rng)],
    ['weapon_swap', 2, () => weaponSwap(sr, rng)],
    ['empty_click', 3, () => emptyClick(sr, rng)],
    ['impact_concrete', 4, () => impactConcrete(sr, rng)],
    ['impact_metal', 4, () => impactMetal(sr, rng)],
    ['impact_dirt', 4, () => impactDirt(sr, rng)],
    ['impact_wood', 3, () => impactWood(sr, rng)],
    ['impact_glass', 3, () => impactGlass(sr, rng)],
    ['impact_flesh', 4, () => impactFlesh(sr, rng)],
    ['footstep_concrete', 4, () => footstep(sr, rng, 'concrete')],
    ['footstep_metal', 3, () => footstep(sr, rng, 'metal')],
    ['footstep_dirt', 4, () => footstep(sr, rng, 'dirt')],
    ['footstep_wood', 3, () => footstep(sr, rng, 'wood')],
    ['footstep_soft', 3, () => footstep(sr, rng, 'soft')],
    ['land', 3, () => landing(sr, rng)],
    ['bullet_whiz', 5, () => bulletWhiz(sr, rng)],
    ['shell_casing', 5, () => shellCasing(sr, rng)],
    ['hitmarker', 2, () => hitmarker(sr, rng, false)],
    ['hitmarker_head', 1, () => hitmarker(sr, rng, true)],
    ['death', 3, () => death(sr, rng)],
    ['player_hurt', 3, () => playerHurt(sr, rng)],
  ];

  for (let g = 0; g < groups.length; g++) {
    const [id, count, make] = groups[g];
    const list = [];
    for (let i = 0; i < count; i++) {
      try {
        list.push(make());
      } catch (err) {
        console.warn(`[audio] failed to synthesise ${id}#${i}:`, err);
      }
    }
    if (list.length) bank[id] = list;
    onProgress((g + 1) / groups.length, `audio: ${id}`);
    if ((g & 3) === 3) await yieldNow();
  }
  return bank;
}
