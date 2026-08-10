/**
 * Texture synthesis worker. Keeps ~4 seconds of tight numeric loops off the main
 * thread so the boot bar keeps animating and the browser never jank-stalls.
 *
 * Protocol: { jobId, name, size, seed } in → transferable buffers out.
 * If anything throws, the main thread silently falls back to synchronous
 * generation for that material — the game must always boot.
 */
import { buildMaterialMaps } from './recipes.js';

self.onmessage = (e) => {
  const msg = e.data || {};
  const { jobId, name, size, seed } = msg;
  try {
    const r = buildMaterialMaps(name, size, seed);
    self.postMessage(
      {
        jobId, name, ok: true,
        width: r.width, height: r.height,
        albedo: r.albedo, normal: r.normal, orm: r.orm,
      },
      [r.albedo.buffer, r.normal.buffer, r.orm.buffer],
    );
  } catch (err) {
    self.postMessage({ jobId, name, ok: false, error: String((err && err.message) || err) });
  }
};
