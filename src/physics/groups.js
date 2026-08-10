/**
 * Collision filtering for OPERATION BLACKOUT.
 *
 * Rapier encodes an "interaction group" as a single u32:
 *
 *     bits 16..31  membership  — which groups this collider *belongs to*
 *     bits  0..15  filter      — which groups this collider *interacts with*
 *
 * Two colliders A and B interact only if BOTH directions agree:
 *
 *     (A.membership & B.filter) !== 0   &&   (B.membership & A.filter) !== 0
 *
 * That symmetry is the whole trick: to make bullets pass through debris it is
 * enough for DEBRIS to omit PROJECTILE from its filter — we do it on both sides
 * anyway so the intent is readable from either row.
 *
 * OWNER: physics agent.
 */

/** Membership bits. 16-bit space; keep them powers of two. */
export const GROUPS = Object.freeze({
  WORLD: 0x0001,      // static level geometry, props that never move
  PLAYER: 0x0002,      // the local player capsule
  ENEMY: 0x0004,      // bot capsules + hitboxes
  DEBRIS: 0x0008,      // dynamic junk — never blocks a bullet
  PROJECTILE: 0x0010,      // bullet raycasts / grenades
  TRIGGER: 0x0020,      // sensors: zones, pickups
  RAGDOLL: 0x0040,      // corpse bodies — collide with world, ignored by bullets
  NONE: 0x0000,
  ALL: 0xffff,
});

/**
 * Default "what do I interact with" masks, keyed by the same names as GROUPS.
 * Note DEBRIS ⊅ PROJECTILE and PROJECTILE ⊅ DEBRIS — debris never eats a shot.
 */
export const FILTERS = Object.freeze({
  WORLD: GROUPS.WORLD | GROUPS.PLAYER | GROUPS.ENEMY | GROUPS.DEBRIS | GROUPS.PROJECTILE | GROUPS.RAGDOLL,
  PLAYER: GROUPS.WORLD | GROUPS.ENEMY | GROUPS.DEBRIS | GROUPS.PROJECTILE | GROUPS.TRIGGER,
  ENEMY: GROUPS.WORLD | GROUPS.PLAYER | GROUPS.ENEMY | GROUPS.DEBRIS | GROUPS.PROJECTILE | GROUPS.TRIGGER,
  DEBRIS: GROUPS.WORLD | GROUPS.PLAYER | GROUPS.ENEMY | GROUPS.DEBRIS,
  PROJECTILE: GROUPS.WORLD | GROUPS.PLAYER | GROUPS.ENEMY,
  TRIGGER: GROUPS.PLAYER | GROUPS.ENEMY,
  RAGDOLL: GROUPS.WORLD | GROUPS.DEBRIS | GROUPS.RAGDOLL,
  NONE: GROUPS.NONE,
  ALL: GROUPS.ALL,
});

/**
 * Pack membership + filter into Rapier's u32 interaction-group encoding.
 * `>>> 0` matters: `0xffff << 16` is negative as a signed int32 and Rapier
 * expects an unsigned value.
 */
export function encodeGroups(membership, filter) {
  const m = (membership & 0xffff) >>> 0;
  const f = (filter & 0xffff) >>> 0;
  return (((m << 16) >>> 0) | f) >>> 0;
}

/** Resolve a group name ('PLAYER') or raw bitmask (0x0002) to a bitmask. */
export function groupBits(nameOrBits, fallback = GROUPS.WORLD) {
  if (typeof nameOrBits === 'number' && Number.isFinite(nameOrBits)) return nameOrBits & 0xffff;
  if (typeof nameOrBits === 'string') {
    const key = nameOrBits.toUpperCase();
    if (key in GROUPS) return GROUPS[key];
  }
  return fallback;
}

/** Default filter mask for a membership name/bits. */
export function defaultFilterFor(nameOrBits) {
  if (typeof nameOrBits === 'string') {
    const key = nameOrBits.toUpperCase();
    if (key in FILTERS) return FILTERS[key];
  }
  const bits = groupBits(nameOrBits, GROUPS.WORLD);
  for (const key of Object.keys(GROUPS)) {
    if (GROUPS[key] === bits && key in FILTERS) return FILTERS[key];
  }
  return GROUPS.ALL;
}

/**
 * Build the interaction group for a collider from an options bag.
 *   { group: 'ENEMY' }                        -> ENEMY / default ENEMY mask
 *   { group: 'ENEMY', mask: GROUPS.WORLD }    -> ENEMY / WORLD only
 *   { collisionGroups: 0x000700ff }           -> passed straight through
 */
export function resolveInteractionGroups(opts = {}, fallbackGroup = 'WORLD') {
  if (typeof opts.collisionGroups === 'number') return opts.collisionGroups >>> 0;
  const nameOrBits = opts.group ?? fallbackGroup;
  const membership = groupBits(nameOrBits, groupBits(fallbackGroup));
  const filter = typeof opts.mask === 'number' ? opts.mask : defaultFilterFor(nameOrBits);
  return encodeGroups(membership, filter);
}

/** Interaction group to use for a query (raycast/shapecast) issued *as* a group. */
export function queryGroups(membership = GROUPS.PROJECTILE, filter = null) {
  const m = groupBits(membership, GROUPS.PROJECTILE);
  const f = filter === null ? defaultFilterFor(membership) : filter;
  return encodeGroups(m, f);
}

export default GROUPS;
