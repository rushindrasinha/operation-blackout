/**
 * Per-pass GPU timing via EXT_disjoint_timer_query_webgl2.
 *
 * Why this exists: "the post pipeline is slow" is not actionable. Which pass, in
 * milliseconds, is. A/B-ing passes by toggling Config flags and watching fps works
 * but conflates GPU cost with the CPU-side cost of the toggle and with whatever else
 * the machine is doing; a timer query measures the GPU span for one region of one
 * frame and nothing else.
 *
 * Contract of the extension: only ONE TIME_ELAPSED_EXT query may be active at a
 * time, so the regions are strictly sequential — begin(name) … end(). Results are
 * asynchronous (typically 1-3 frames of latency) and must be discarded wholesale if
 * the driver raises GPU_DISJOINT_EXT, which means the GPU was preempted mid-query
 * and every outstanding timing is garbage.
 *
 * Disabled by default and a boolean check when off, so it costs nothing in a
 * shipping frame. Turn it on from the console with `__RENDER__.profileStart()`.
 *
 * On some drivers (notably ANGLE/Metal in headless Chrome) the extension is simply
 * absent. `available === false` then, and the caller must fall back to A/B timing.
 *
 * OWNER: render
 */
export class GpuProfiler {
  constructor(renderer) {
    this.enabled = false;
    this.available = false;
    this.gl = null;
    this.ext = null;
    this._pending = [];
    this._active = null;
    this._acc = new Map();      // name -> { sum, n }
    this._frames = 0;
    try {
      this.gl = renderer.getContext();
      this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2')
        || this.gl.getExtension('EXT_disjoint_timer_query');
      this.available = !!(this.ext && this.gl.createQuery);
    } catch (e) {
      this.available = false;
    }
  }

  /**
   * Start accumulating.
   *
   * `only` restricts instrumentation to a single named region, and that is the mode
   * you should trust. Timing all twelve regions at once splits the frame into twelve
   * command buffers, and on ANGLE/Metal each split carries several milliseconds of
   * submission latency that lands *inside* the measured span — every region then
   * reports a ~6 ms floor and the frame itself halves in rate, so neither the
   * absolute nor the relative numbers mean anything. One region per run costs one
   * split and measures what it says it measures.
   */
  start(only = null) {
    if (!this.available) return false;
    this._acc.clear();
    this._only = only || null;
    this._frames = 0;
    this.enabled = true;
    return true;
  }

  stop() { this.enabled = false; this._endActive(); }

  begin(name) {
    if (!this.enabled) return;
    if (this._only && name !== this._only) return;
    const gl = this.gl;
    this._endActive();
    try {
      const q = gl.createQuery();
      gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
      this._active = { name, q };
    } catch (e) { this._active = null; }
  }

  end() { if (this.enabled) this._endActive(); }

  _endActive() {
    if (!this._active) return;
    try {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this._pending.push(this._active);
    } catch (e) { /* query never started */ }
    this._active = null;
  }

  /** Call once per frame, after the last pass. Drains whatever the driver has ready. */
  poll() {
    if (!this.available || this._pending.length === 0) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    if (disjoint) {
      // The GPU was preempted; every outstanding result is meaningless.
      for (const p of this._pending) { try { gl.deleteQuery(p.q); } catch (e) {} }
      this._pending.length = 0;
      return;
    }
    let i = 0;
    while (i < this._pending.length) {
      const p = this._pending[i];
      let ready = false;
      try { ready = gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE); }
      catch (e) { ready = true; }
      if (!ready) { i++; continue; }
      let ns = 0;
      try { ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT); } catch (e) { ns = 0; }
      try { gl.deleteQuery(p.q); } catch (e) {}
      // Keep every sample, not a running mean: this machine shares its GPU and a
      // single preempted frame can be 10x the median, which a mean cannot survive.
      const rec = this._acc.get(p.name) || { s: [] };
      rec.s.push(ns / 1e6);
      if (rec.s.length > 600) rec.s.shift();
      this._acc.set(p.name, rec);
      this._pending.splice(i, 1);
    }
    this._frames++;
  }

  /** { pass: medianMs, ... } sorted descending, plus `_total` and `_p10`. */
  report() {
    const out = {};
    let total = 0;
    const q = (a, p) => a[Math.max(0, Math.min(a.length - 1, Math.floor(a.length * p)))];
    const rows = [...this._acc.entries()]
      .map(([k, v]) => {
        const s = v.s.slice().sort((a, b) => a - b);
        return [k, s.length ? q(s, 0.5) : 0, s.length, s.length ? q(s, 0.1) : 0];
      })
      .sort((a, b) => b[1] - a[1]);
    for (const [k, ms] of rows) { out[k] = Number(ms.toFixed(3)); total += ms; }
    out._total = Number(total.toFixed(3));
    out._samples = rows.length ? rows[0][2] : 0;
    // p10 is the cleanest estimate of the un-contended cost on a shared GPU.
    out._p10 = rows.length ? Number(rows[0][3].toFixed(3)) : 0;
    return out;
  }

  dispose() {
    this.stop();
    for (const p of this._pending) { try { this.gl.deleteQuery(p.q); } catch (e) {} }
    this._pending.length = 0;
  }
}

export default GpuProfiler;
