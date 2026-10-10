#!/usr/bin/env node
/**
 * REGRESSION TEST — physics NaN guards.
 *
 *   npm run dev                    # in another shell
 *   node tools/test-physics-nan.mjs
 *
 * Exits 0 if physics survives NaN injection, 1 if it dies.
 *
 * Guards against a live incident: a single non-finite velocity reached
 * world.step(), Rust panicked ("RuntimeError: unreachable"), and the panic
 * unwound out of wasm still holding the World's borrow. Every subsequent Rapier
 * call then threw "recursive use of an object detected which would lead to
 * unsafe aliasing in rust" — 13,445 of them in one session. The game kept
 * rendering at full framerate while bullets stopped registering and bots went
 * blind, so nothing surfaced it until someone actually played for a minute.
 *
 * Verified to FAIL against the pre-fix tree, so it genuinely discriminates.
 */
import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';

// Configurable so CI can point at `vite preview` on any port. Named TARGET, not
// URL, because `const URL = ...` shadows the global URL constructor — a mistake
// that already cost one debugging round in this repo.
const TARGET = process.env.BLACKOUT_URL ?? process.argv[2] ?? 'http://127.0.0.1:5173/';
const browser = await chromium.launch({
  // ANGLE's Metal backend only exists on macOS; CI runners are Linux and need
  // SwiftShader. This test is about the physics solver, not the renderer, so a
  // software GL backend is entirely adequate there.
  args: process.platform === 'darwin'
    ? ['--use-angle=metal', '--ignore-gpu-blocklist', '--use-gl=angle']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const lines = [];
page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`));

await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
// waitForFunction(fn, arg, options): options is the THIRD argument. Passing it
// second silently fell back to the 30s default, which a software-GL CI boot can exceed.
try {
  await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 120000 });
} catch (err) {
  console.error('Game never reported __READY__. Page log:\n' + lines.slice(-40).join('\n'));
  throw err;
}
await sleep(2500);

const result = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const phys = window.__ENGINE__.ctx.physics;
  const out = { injected: 0, before: {}, after: {} };

  const probe = () => {
    const o = window.__ENGINE__.ctx.player.eyePosition.clone();
    const d = { x: 0, y: -1, z: 0 };
    let ok = 0;
    for (let i = 0; i < 25; i++) if (phys.raycast(o, d, 50)) ok++;
    return { hits: ok, dead: !!phys.dead, ready: !!phys.ready };
  };

  out.before = probe();

  // Find live dynamic bodies and poison them with NaN — the exact shape of the
  // original failure (a velocity that no magnitude test can catch).
  let n = 0;
  for (const body of phys._bodies) {
    try {
      if (!body.isDynamic?.()) continue;
      body.setLinvel({ x: NaN, y: NaN, z: NaN }, true);
      body.setAngvel({ x: Infinity, y: NaN, z: 0 }, true);
      n++;
      if (n >= 12) break;
    } catch { /* freed */ }
  }
  // Also drive a NaN through the public write paths.
  try { phys.setLinvel?.([...phys._bodies][0], { x: NaN, y: 0, z: 0 }); } catch {}
  try { phys.addBox?.({ x: NaN, y: 1, z: 1 }, { x: 0, y: NaN, z: 0 }, null, { type: 'dynamic' }); } catch {}
  out.injected = n;

  // Let several fixed steps run over the poisoned state.
  await sleep(1500);
  out.after = probe();

  // And confirm the sim is still doing real work afterwards.
  await sleep(800);
  out.final = probe();
  out.stepCount = phys._stepCount;
  out.nonFinite = phys.stats?.nonFinite ?? 0;
  return out;
});

const poisoned = lines.filter((l) => /recursive use|unsafe aliasing|SIMULATION DEAD|unreachable/.test(l));
const swept = lines.filter((l) => /non-finite/.test(l));

console.log('===== FAULT INJECTION =====');
console.log(JSON.stringify(result, null, 2));
console.log('\nnon-finite guard messages:', swept.length);
for (const s of swept.slice(0, 4)) console.log('  ' + s.slice(0, 220));
console.log('\nPOISON/DEATH lines:', poisoned.length);
for (const p of poisoned.slice(0, 3)) console.log('  ' + p.slice(0, 300));

const survived = result.after.hits > 0 && result.final.hits > 0 && !result.after.dead;
console.log('\nRESULT: ' + (survived ? 'SURVIVED — physics still live after NaN injection'
                                     : 'FAILED — physics died'));
await browser.close();
process.exit(survived ? 0 : 1);
