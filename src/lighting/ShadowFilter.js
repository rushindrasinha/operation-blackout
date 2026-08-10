/**
 * Wide-kernel PCF.
 *
 * ── THE PROBLEM ───────────────────────────────────────────────────────────────
 *
 * r185's stock PCF filter is five Vogel-disk taps whose pattern is rotated per pixel
 * by interleaved-gradient noise, at a radius given in texels. That is an excellent
 * default: at a radius of one or two texels the rotation hides the low tap count and
 * the hardware's own 2x2 comparison filtering does the rest.
 *
 * It falls apart the moment you ask for a *wide* kernel, and a wide kernel is exactly
 * what a soft distant shadow is. Five samples spread over four texels is not a blur,
 * it is a dither: a 20% quantised penumbra with a rotating noise pattern, which TAA
 * then smears into a crawling mush. That ceiling is why the far cascades in this
 * project were pinned to ~3 texels of radius, and why a shadow eighty metres away had
 * the same knife edge as one at arm's length — three separate reviews scored it.
 *
 * ── THE FIX ───────────────────────────────────────────────────────────────────
 *
 * Swap `shadowmap_pars_fragment`'s PCF `getShadow()` for one that picks its tap count
 * from the radius it was handed:
 *
 *     radius <= 3.2 texels  ->  5 taps   (identical to stock; cascades 0-2 pay nothing)
 *     radius  > 3.2 texels  -> 12 taps   (cascade 3 only)
 *
 * `shadowRadius` is a *uniform*, so that branch is uniform across the whole draw for a
 * given cascade — no warp divergence, and the near cascades (which cover the majority
 * of on-screen pixels) execute the exact same instruction stream they did before. Only
 * the far cascades, which resolve fewer pixels and are already fogged, pay for the
 * extra taps.
 *
 * Everything else in the chunk — VSM, BASIC, the point-light path — is left byte-for-byte
 * alone: we do a targeted string replacement on the five-tap block and *verify it hit*.
 * If three ever restructures that block the replacement silently no-ops and the engine
 * keeps the stock filter, which is the correct failure mode for something this global.
 *
 * Must be installed before any material compiles. LightingSystem does that at the top
 * of init(), before CSM is constructed.
 *
 * OWNER: lighting.
 */
import * as THREE from 'three';

/**
 * Whitespace-tolerant matcher for the stock five-tap block. Written as a regex rather
 * than a literal because the exact indentation of the shipped chunk is tabs in the
 * bundle and this file must not depend on that surviving an editor round-trip.
 */
const NEEDLE = new RegExp(
  'shadow\\s*=\\s*\\(' +
  '(?:\\s*texture\\(\\s*shadowMap,\\s*vec3\\(\\s*shadowCoord\\.xy\\s*\\+\\s*vogelDiskSample\\(\\s*[0-4],\\s*5,\\s*phi\\s*\\)\\s*\\*\\s*radius,\\s*shadowCoord\\.z\\s*\\)\\s*\\)\\s*\\+?){5}' +
  '\\s*\\)\\s*\\*\\s*0\\.2\\s*;',
);

/**
 * Both branches are fully unrolled straight-line code.
 *
 * The first version of this used a bounded `for` loop with an early `break` and a
 * runtime tap count. Measured, it cost roughly 2x the frame time of the stock filter
 * — far more than the seven extra fetches can account for. Dynamic loop bounds in a
 * fragment shader defeat the compiler's ability to batch the texture fetches and, on
 * this driver, appear to spill. Unrolled, the extra cost is the fetches and nothing
 * else, and the branch itself is uniform so one side is dead code per draw call.
 */
const REPLACEMENT = /* glsl */`
				// Adaptive tap count — see ShadowFilter.js. shadowRadius is a uniform, so
				// this branch is coherent across the entire draw call and one side of it
				// is never executed for a given cascade.
				if ( shadowRadius > 3.2 ) {

					shadow = (
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 0, 12, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 1, 12, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 2, 12, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 3, 12, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 4, 12, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 5, 12, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 6, 12, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 7, 12, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 8, 12, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 9, 12, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 10, 12, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 11, 12, phi ) * radius, shadowCoord.z ) )
					) * 0.08333333;

				} else {

					shadow = (
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 0, 5, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 1, 5, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 2, 5, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 3, 5, phi ) * radius, shadowCoord.z ) ) +
						texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 4, 5, phi ) * radius, shadowCoord.z ) )
					) * 0.2;

				}`;

let _original = null;
let _installed = false;

/**
 * @returns {boolean} true if the wide filter is live, false if the engine kept stock PCF.
 */
export function installWideShadowFilter() {
  if (_installed) return true;
  try {
    const src = THREE.ShaderChunk.shadowmap_pars_fragment;
    if (typeof src !== 'string' || !NEEDLE.test(src)) {
      console.warn('[lighting] wide shadow filter: stock PCF block not found, keeping three\'s default');
      return false;
    }
    _original = src;
    THREE.ShaderChunk.shadowmap_pars_fragment = src.replace(NEEDLE, REPLACEMENT);
    _installed = true;
    return true;
  } catch (err) {
    console.error('[lighting] wide shadow filter install failed:', err);
    if (_original) THREE.ShaderChunk.shadowmap_pars_fragment = _original;
    _installed = false;
    return false;
  }
}

export function uninstallWideShadowFilter() {
  if (!_installed || !_original) return;
  THREE.ShaderChunk.shadowmap_pars_fragment = _original;
  _original = null;
  _installed = false;
}

export function wideShadowFilterInstalled() { return _installed; }
