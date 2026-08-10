/**
 * Procedural noise → data-URL PNG.
 *
 * The HUD needs grit: a blood vignette that is a clean radial gradient reads as a
 * web demo, a blood vignette broken up by fractal spatter reads as a hit. We are
 * strictly offline so the texture is synthesised once at init into a 256² canvas
 * and handed to CSS as a mask-image. Cost: ~2ms once, zero per frame.
 *
 * OWNER: hud (src/ui/**).
 */

const hash2 = (x, y, seed) => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 362437);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

const smooth = (t) => t * t * (3 - 2 * t);

/** Tileable value noise on a lattice of `period` cells. */
function valueNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const w = (v) => ((v % period) + period) % period;
  const x0 = w(xi), x1 = w(xi + 1), y0 = w(yi), y1 = w(yi + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const u = smooth(xf), v = smooth(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/**
 * @param {object} o
 * @param {number} o.size        texture edge in px
 * @param {number} o.baseCells   lattice cells at octave 0 (must divide size cleanly for tiling)
 * @param {number} o.octaves
 * @param {number} o.gain
 * @param {number} o.contrast    >1 pushes toward blobs, <1 flattens
 * @param {number} o.bias        added before contrast
 * @param {number} o.seed
 * @returns {string} data:image/png URL, or '' if canvas is unavailable
 */
export function makeNoiseURL(o = {}) {
  const size = o.size ?? 256;
  const baseCells = o.baseCells ?? 4;
  const octaves = o.octaves ?? 5;
  const gain = o.gain ?? 0.52;
  const contrast = o.contrast ?? 1.0;
  const bias = o.bias ?? 0.0;
  const seed = o.seed ?? 1337;

  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d', { willReadFrequently: false });
    if (!g) return '';
    const img = g.createImageData(size, size);
    const px = img.data;

    // Normalisation constant so fbm lands in 0..1 regardless of octave count.
    let norm = 0;
    for (let oi = 0, amp = 1; oi < octaves; oi++, amp *= gain) norm += amp;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let amp = 1, cells = baseCells, sum = 0;
        for (let oi = 0; oi < octaves; oi++) {
          const nx = (x / size) * cells;
          const ny = (y / size) * cells;
          sum += valueNoise(nx, ny, cells, seed + oi * 91) * amp;
          amp *= gain;
          cells *= 2;
        }
        let v = sum / norm;
        v = Math.min(1, Math.max(0, (v - 0.5) * contrast + 0.5 + bias));
        const i = (y * size + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = 255;
        px[i + 3] = (v * 255) | 0;
      }
    }
    g.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  } catch (err) {
    console.warn('[hud] noise synthesis failed, falling back to flat masks:', err);
    return '';
  }
}

/**
 * Droplet spatter mask for the incoming-damage blood wash.
 *
 * Deliberately *non*-directional and tileable: direction is supplied by the CSS
 * radial gradient underneath, and the mask only has to break the gradient's clean
 * falloff into wet, uneven spatter. Making the mask itself directional would mean
 * rotating the element, which would drag the gradient origin around with it.
 */
export function makeSpatterURL(size = 256, seed = 4211) {
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    if (!g) return '';
    const img = g.createImageData(size, size);
    const px = img.data;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let amp = 1, cells = 4, sum = 0, norm = 0;
        for (let oi = 0; oi < 5; oi++) {
          sum += valueNoise((x / size) * cells, (y / size) * cells, cells, seed + oi * 57) * amp;
          norm += amp;
          amp *= 0.55;
          cells *= 2;
        }
        let v = sum / norm;
        // Sharpen into droplets: most of the field goes to zero, the peaks stay.
        v = Math.min(1, Math.max(0, (v - 0.46) * 2.6));
        v = 0.24 + v * 0.76;   // keep a thin base wash so the mask never punches holes
        const i = (y * size + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = 255;
        px[i + 3] = (Math.min(1, v) * 255) | 0;
      }
    }
    g.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  } catch (err) {
    console.warn('[hud] spatter synthesis failed:', err);
    return '';
  }
}
