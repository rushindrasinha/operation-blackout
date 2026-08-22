#!/usr/bin/env node
/**
 * Records a gameplay demo reel.
 *
 *   npm run demo                              # 15s, 1280x720 -> docs/demo.mp4
 *   node tools/record-demo.mjs --seconds 18 --w 1920 --h 1080
 *
 * Two things make this work:
 *
 * 1. INPUT SYNTHESIS, not a camera path. Headless Chromium refuses pointer
 *    lock, so we write into ctx.input (keys / buttons / mouse deltas) and let
 *    the real movement, weapon, recoil and animation code run untouched. The
 *    footage is genuine gameplay with a scripted player, not a flythrough.
 *
 * 2. SLOW-MOTION CAPTURE. CDP screencast tops out near 18 frames/sec no matter
 *    how fast the engine runs (209 fps measured), which is far too choppy. So
 *    game time is scaled down by SLOWMO while recording and ffmpeg speeds the
 *    result back up — 18 captured frames per real second becomes ~45 frames per
 *    second of finished video.
 *
 * Structured as a four-shot montage anchored on the named camera poses. A single
 * continuous walk kept ending with the player's face in a wall; hard cuts are
 * also just better for a 15-second reel.
 */
import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, c, i, arr) => {
    if (c.startsWith('--')) a.push([c.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
    return a;
  }, []),
);

const SECONDS = Number(args.seconds ?? 15);
const W = Number(args.w ?? 1280);
const H = Number(args.h ?? 720);
const FPS = Number(args.fps ?? 30);
const SLOWMO = Number(args.slowmo ?? 2.5);
const OUT = args.out ?? path.join(ROOT, 'docs', 'demo.mp4');
const FRAMES = '/tmp/blackout-frames';

function portOpen(p) {
  return new Promise((r) => {
    const s = net.createConnection({ port: p, host: '127.0.0.1' }, () => { s.end(); r(true); });
    s.on('error', () => r(false));
    s.setTimeout(600, () => { s.destroy(); r(false); });
  });
}

async function server() {
  const port = 5600 + (process.pid % 300);
  if (await portOpen(port)) return { proc: null, port };
  const proc = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 70; i++) { await sleep(500); if (await portOpen(port)) return { proc, port }; }
  throw new Error('vite failed to start');
}

const { proc, port } = await server();
if (existsSync(FRAMES)) rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
         '--use-gl=angle', '--disable-frame-rate-limit', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

console.log('booting…');
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__READY__ === true, { timeout: 90000 });
await sleep(4000);                       // TAA convergence + shader compilation

await page.evaluate((slowmo) => {
  const eng = window.__ENGINE__;
  const ctx = eng.ctx;
  const I = ctx.input;
  const P = ctx.player;

  for (const id of ['enter', 'boot']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  // Scale game time. The engine reads clock.getDelta() once per frame, so this
  // is the single point that makes everything — movement, animation, physics
  // accumulation, recoil springs — run in consistent slow motion.
  const clock = eng.clock;
  const realGetDelta = clock.getDelta.bind(clock);
  clock.getDelta = () => realGetDelta() / slowmo;

  I.locked = true;
  const down = (k) => I.keys.add(k);
  const up = (k) => I.keys.delete(k);
  const tap = (k) => { I.keys.add(k); I._pressedThisFrame.add(k); setTimeout(() => I.keys.delete(k), 80); };
  const mouse = (b, on) => { on ? I.buttons.add(b) : I.buttons.delete(b); if (on) I._buttonsPressedThisFrame.add(b); };
  const clearKeys = () => { I.keys.clear(); I.buttons.clear(); };

  // Cut to a named pose and let the renderer know the camera teleported, so TAA
  // and motion blur do not smear across the cut.
  const cut = (pose) => {
    clearKeys();
    try { P.setPose(pose); } catch (e) {}
    try { ctx.render.setVelocityDirty(); } catch (e) {}
  };

  // Yaw toward the nearest living bot that is roughly in front of us, so the
  // firing beats point at something instead of at a wall.
  const faceNearestBot = () => {
    const bots = (ctx.ai?.bots ?? []).filter(b => b && b.alive !== false && !b.dead);
    if (!bots.length) return false;
    const eye = P.eyePosition;
    let best = null, bestD = 1e9;
    for (const b of bots) {
      const p = b.position ?? b.pos;
      if (!p) continue;
      const d = Math.hypot(p.x - eye.x, p.z - eye.z);
      if (d > 4 && d < 45 && d < bestD) { bestD = d; best = p; }
    }
    if (!best) return false;
    P.yaw = Math.atan2(-(best.x - eye.x), -(best.z - eye.z));
    P.pitch = Math.atan2((best.y + 1.1) - eye.y, bestD) * 0.6;
    try { ctx.render.setVelocityDirty(); } catch (e) {}
    return true;
  };

  // ── Storyboard, in GAME seconds ──────────────────────────────────────────
  const beats = [
    // SHOT 1 — the yard at dusk. Drift forward, slow pan across raking shadows.
    { at: 0.00, do: () => { cut('spawn'); down('KeyW'); } },
    { at: 0.00, pan: [0.42, 0], until: 3.30 },

    // SHOT 2 — long lane, into the sun. Aim down sights, burst on a target.
    { at: 3.60, do: () => { cut('lane'); faceNearestBot(); } },
    { at: 3.95, do: () => { mouse(2, true); } },              // ADS
    { at: 4.70, do: () => { faceNearestBot(); mouse(0, true); } },
    { at: 4.70, pan: [0.06, -0.03], until: 6.10 },            // human drift
    { at: 6.10, do: () => { mouse(0, false); } },
    { at: 6.60, do: () => { mouse(2, false); } },

    // SHOT 3 — close quarters. Reload on the move: the full magazine animation.
    { at: 7.00, do: () => { cut('closeup'); tap('KeyR'); } },
    { at: 7.30, do: () => { down('KeyW'); down('KeyD'); } },
    { at: 7.30, pan: [-0.34, 0], until: 10.20 },
    { at: 10.20, do: () => { up('KeyW'); up('KeyD'); } },

    // SHOT 4 — warehouse interior. Volumetric shafts, then a muzzle flash.
    { at: 10.60, do: () => { cut('warehouse'); } },
    { at: 10.90, pan: [0.30, -0.22], until: 12.60 },
    { at: 12.90, do: () => { faceNearestBot(); } },
    { at: 13.10, do: () => { mouse(0, true); } },
    { at: 13.55, do: () => { mouse(0, false); } },
    { at: 13.70, pan: [0.22, 0.16], until: 99 },
  ];

  let t = 0, last = performance.now();
  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05) / slowmo;   // game seconds
    last = now; t += dt;
    for (const b of beats) {
      if (!b.fired && b.do && t >= b.at) { b.fired = true; try { b.do(); } catch (e) {} }
      if (b.pan && t >= b.at && t <= (b.until ?? 1e9)) {
        I.mouseDX += b.pan[0] * dt * 60;
        I.mouseDY += b.pan[1] * dt * 60;
      }
    }
    window.__DEMO_T__ = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, SLOWMO);

const cdp = await page.context().newCDPSession(page);
let n = 0;
cdp.on('Page.screencastFrame', async (f) => {
  writeFileSync(path.join(FRAMES, String(n++).padStart(5, '0') + '.jpg'), Buffer.from(f.data, 'base64'));
  try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
});

const realSeconds = SECONDS * SLOWMO;
console.log(`recording ${SECONDS}s of game time (${realSeconds.toFixed(0)}s wall clock at ${SLOWMO}x slow-mo)…`);
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H });
await sleep(realSeconds * 1000 + 600);
await cdp.send('Page.stopScreencast');
await sleep(400);

const perf = await page.evaluate(() => window.__PERF__?.());
await browser.close();
if (proc) { try { proc.kill('SIGTERM'); } catch {} }

const count = readdirSync(FRAMES).filter((f) => f.endsWith('.jpg')).length;
const effectiveFps = count / SECONDS;
console.log(`captured ${count} frames → ${effectiveFps.toFixed(1)} fps of finished video (engine ${perf?.fps ?? '?'} fps)`);
if (errors.length) console.log('page errors:', errors.slice(0, 3));
if (count < 60) { console.error('too few frames — aborting'); process.exit(1); }

mkdirSync(path.dirname(OUT), { recursive: true });
const ff = [
  '-y', '-framerate', effectiveFps.toFixed(3),
  '-i', path.join(FRAMES, '%05d.jpg'),
  // The source JPEGs are full-range (yuvj). Convert explicitly to limited-range
  // BT.709 and tag it, or strict players and social-media re-encoders misread the
  // levels and the result comes back washed out or with crushed blacks.
  '-vf', `scale=${W}:${H}:flags=lanczos:in_range=full:out_range=tv,fps=${FPS},format=yuv420p`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
  '-color_range', 'tv', '-colorspace', 'bt709',
  '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-movflags', '+faststart',
  OUT,
];
await new Promise((res, rej) => {
  const p = spawn('ffmpeg', ff, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (c) => (c === 0 ? res() : rej(new Error(err.slice(-1500)))));
});

rmSync(FRAMES, { recursive: true, force: true });
console.log('wrote ' + OUT);
