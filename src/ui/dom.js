/**
 * Tiny DOM helpers. Deliberately not a framework — the HUD is ~40 nodes and every
 * one of them is written by hand so we control exactly which properties are
 * touched per frame.
 *
 * OWNER: hud (src/ui/**).
 */

export function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

export function text(tag, cls, str, parent) {
  const n = el(tag, cls, parent);
  n.textContent = str;
  return n;
}

/** Set textContent only when it actually changed — avoids needless layout. */
export function setText(node, str) {
  const s = String(str);
  if (node._t !== s) { node._t = s; node.textContent = s; }
}

/** Set an arbitrary style property only when the value changed. */
export function setStyle(node, prop, val) {
  const k = '_s_' + prop;
  if (node[k] !== val) { node[k] = val; node.style[prop] = val; }
}

export function setClass(node, cls, on) {
  const k = '_c_' + cls;
  if (node[k] !== on) { node[k] = on; node.classList.toggle(cls, !!on); }
}

/**
 * Restartable WAAPI animation. Cancels anything already running on the node so a
 * rapid re-trigger (four hitmarkers in half a second) always restarts crisply
 * instead of being swallowed. Runs on the compositor for transform/opacity.
 */
export function anim(node, keyframes, options) {
  try {
    for (const a of node.getAnimations()) a.cancel();
    const a = node.animate(keyframes, options);
    return a;
  } catch {
    return null;
  }
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Frame-rate independent exponential approach. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
