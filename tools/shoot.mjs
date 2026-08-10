#!/usr/bin/env node
/**
 * Headless screenshot harness.
 *
 *   node tools/shoot.mjs --out /tmp/shot.png --wait 8000
 *   node tools/shoot.mjs --out /tmp/a.png --pose overwatch --w 1920 --h 1080
 *
 * Boots a vite dev server if one isn't already up, loads the game, waits for the
 * engine to report ready, optionally drives the camera to a named pose, then
 * screenshots. Forwards every console error and page exception to stdout so an
 * agent can debug without a GUI.
 *
 * Exit code 1 if the page threw — "it screenshotted" is not the same as "it works".
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
    return acc;
  }, []),
);

const OUT   = args.out   ?? '/tmp/blackout.png';
const WAIT  = Number(args.wait ?? 9000);
const W     = Number(args.w ?? 1920);
const H     = Number(args.h ?? 1080);
const PORT  = Number(args.port ?? 5173);
const POSE  = args.pose ?? null;
const FULL  = args.sequence ?? null;

function portOpen(port) {
  return new Promise((res) => {
    const s = net.createConnection({ port, host: '127.0.0.1' }, () => { s.end(); res(true); });
    s.on('error', () => res(false));
    s.setTimeout(700, () => { s.destroy(); res(false); });
  });
}

/**
 * Always start a PRIVATE, COLD vite server for this capture, and tear it down after.
 *
 * Reusing an already-running server was a correctness bug, not an optimisation: vite
 * caches module transforms server-side, so a long-lived shared server kept serving stale
 * JS after files on disk had changed. An agent tuning against that is editing blind — one
 * reported losing an hour to it. `--force` clears the dep cache; a private port means
 * concurrent agents can never share (and therefore never poison) each other's server.
 *
 * Returns { proc, port }.
 */
async function ensureServer() {
  // Derive a per-process port so parallel agents never collide, unless one was pinned.
  let port = PORT;
  if (!args.port) port = 5500 + (process.pid % 2000);

  for (let attempt = 0; attempt < 12; attempt++) {
    if (await portOpen(port)) { port++; continue; }

    const proc = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--force'], {
      cwd: ROOT, stdio: 'ignore', detached: false,
    });

    let up = false;
    for (let i = 0; i < 70; i++) {
      await sleep(500);
      if (await portOpen(port)) { up = true; break; }
      if (proc.exitCode !== null) break; // died (almost always: port taken)
    }
    if (up) return { proc, port };
    try { proc.kill('SIGKILL'); } catch {}
    port++;
  }
  throw new Error('could not start a private vite server after 12 attempts');
}

const errors = [];
const logs = [];

(async () => {
  const { proc: server, port: PORT_ACTUAL } = await ensureServer();
  const browser = await chromium.launch({
    args: [
      // Force real GPU rasterisation in headless so WebGL2 + float targets behave
      // like they do on the user's screen.
      '--use-angle=metal',
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--use-gl=angle',
      '--disable-frame-rate-limit',
    ],
  });

  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  page.on('console', (m) => {
    const t = m.type();
    const txt = `[${t}] ${m.text()}`;
    logs.push(txt);
    if (t === 'error') errors.push(txt);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

  try {
    await page.goto(`http://127.0.0.1:${PORT_ACTUAL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the engine to signal readiness (main.js sets window.__READY__).
    await page.waitForFunction(() => window.__READY__ === true, { timeout: WAIT }).catch(() => {
      errors.push('[harness] window.__READY__ never became true — engine did not finish init');
    });

    // Let TAA converge and streaming settle.
    await sleep(2200);

    if (POSE) {
      await page.evaluate((p) => window.__POSE__?.(p), POSE);
      await sleep(1400); // re-converge TAA after the jump
    }

    // The deploy prompt sits dead centre of frame. A critic grading composition must
    // see the rendered image, not our own UI on top of it. Hide the whole overlay for
    // the capture; the HUD (a separate layer) stays, since that IS part of the product.
    await page.evaluate(() => {
      const el = document.getElementById('enter');
      if (el) el.style.display = 'none';
      const boot = document.getElementById('boot');
      if (boot) boot.style.display = 'none';
    });
    await sleep(250);

    await page.screenshot({ path: OUT, type: 'png' });

    // Grab a perf sample so the critic can weigh beauty against framerate.
    const perf = await page.evaluate(() => window.__PERF__?.() ?? null);
    if (perf) console.log('PERF ' + JSON.stringify(perf));
  } catch (e) {
    errors.push(`[harness] ${e.message}`);
  }

  await browser.close();
  if (server) { try { server.kill('SIGTERM'); } catch {} try { server.kill('SIGKILL'); } catch {} }

  if (errors.length) {
    console.log('\n===== PAGE ERRORS =====');
    for (const e of errors.slice(0, 40)) console.log(e);
    console.log(`\nScreenshot still written to ${OUT}`);
    process.exit(1);
  }
  console.log(`OK ${OUT}`);
  process.exit(0);
})();
