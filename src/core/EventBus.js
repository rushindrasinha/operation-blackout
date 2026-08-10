/**
 * Minimal synchronous pub/sub. Systems communicate through this rather than
 * holding direct references to each other — that is what lets separate agents
 * own separate files without import cycles.
 *
 * OWNER: core. Systems may emit/subscribe freely but must not edit this file.
 *
 * CANONICAL EVENT NAMES (the contract — do not invent variants):
 *   'weapon:fire'      { origin:Vector3, dir:Vector3, weapon:string, spread:number }
 *   'weapon:reload'    { weapon:string, duration:number }
 *   'weapon:switch'    { from:string, to:string }
 *   'weapon:empty'     { weapon:string }
 *   'hit:world'        { point:Vector3, normal:Vector3, material:string, impulse:number }
 *   'hit:actor'        { actor:object, point:Vector3, normal:Vector3, damage:number, isHeadshot:boolean }
 *   'actor:death'      { actor:object, killer:object }
 *   'player:damage'    { amount:number, from:Vector3 }
 *   'player:death'     { }
 *   'camera:shake'     { amplitude:number, duration:number, frequency:number }
 *   'audio:play'       { id:string, position:Vector3|null, volume:number, pitch:number }
 */

export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const off = this.on(event, (payload) => { off(); fn(payload); });
    return off;
  }

  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
  }

  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set) return;
    // Iterate a copy so handlers may unsubscribe during dispatch.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${event}" threw:`, err);
      }
    }
  }

  clear() { this._handlers.clear(); }
}

export default EventBus;
