/**
 * Pointer-lock mouse + keyboard input. Accumulates mouse delta between frames
 * so the player controller reads a clean per-frame value regardless of how many
 * mousemove events the OS delivered.
 *
 * OWNER: core. Do not edit from system agents.
 */

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.buttons = new Set();
    this.locked = false;
    this.wheel = 0;

    // Edge-triggered sets, cleared at end of each frame by endFrame().
    this._pressedThisFrame = new Set();
    this._releasedThisFrame = new Set();
    this._buttonsPressedThisFrame = new Set();

    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const c = e.code;
      this.keys.add(c);
      this._pressedThisFrame.add(c);
      // Stop the browser scrolling / quick-find while playing.
      if (['Space', 'Tab', 'KeyR', 'ControlLeft', 'Slash'].includes(c) && this.locked) e.preventDefault();
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this._releasedThisFrame.add(e.code);
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });

    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.buttons.add(e.button);
      this._buttonsPressedThisFrame.add(e.button);
    });

    document.addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    document.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });
    document.addEventListener('wheel', (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) {
        // Never leave a key stuck down when focus is lost.
        this.keys.clear();
        this.buttons.clear();
      }
      this.onLockChange?.(this.locked);
    });

    window.addEventListener('blur', () => { this.keys.clear(); this.buttons.clear(); });
  }

  requestLock() { this.dom.requestPointerLock?.(); }

  isDown(code) { return this.keys.has(code); }
  wasPressed(code) { return this._pressedThisFrame.has(code); }
  wasReleased(code) { return this._releasedThisFrame.has(code); }
  isMouseDown(btn) { return this.buttons.has(btn); }
  wasMousePressed(btn) { return this._buttonsPressedThisFrame.has(btn); }

  /** Movement intent in local space: x = strafe (+right), z = forward (+forward). */
  moveAxis() {
    let x = 0, z = 0;
    if (this.isDown('KeyW')) z += 1;
    if (this.isDown('KeyS')) z -= 1;
    if (this.isDown('KeyD')) x += 1;
    if (this.isDown('KeyA')) x -= 1;
    // Normalise so diagonals aren't faster.
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    return { x, z };
  }

  /** Consume accumulated mouse delta. Call exactly once per frame. */
  consumeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  endFrame() {
    this._pressedThisFrame.clear();
    this._releasedThisFrame.clear();
    this._buttonsPressedThisFrame.clear();
    this.wheel = 0;
  }
}

export default Input;
