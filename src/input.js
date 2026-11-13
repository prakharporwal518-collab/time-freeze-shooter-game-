// ---------------------------------------------------------------------------
// input.js — keyboard, mouse and Pointer Lock.
//
// Two styles of input are exposed:
//   * "state"  — is a key held down right now?   input.isDown('KeyW')
//   * "events" — something happened once.         input.on('fire', fn)
//
// Pointer Lock is the browser feature that hides the cursor and gives us raw
// mouse movement (movementX / movementY) so the player can turn forever
// without the cursor hitting the edge of the screen.
// ---------------------------------------------------------------------------

export class Input {
  /** @param {HTMLElement} element the element that captures the mouse (our canvas) */
  constructor(element) {
    this.element = element;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;
    // Automated tests cannot grab the pointer, so they switch this off.
    this.requireLock = true;
    this.handlers = {};

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.emit('key', e.code);
      if (e.code === 'KeyE') this.emit('interact');
      if (e.code === 'KeyR') this.emit('restart');
      if (e.code === 'KeyM') this.emit('mute');
      // Stop the page from scrolling when the game uses these keys.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // If the tab loses focus we never get the keyup events — release everything.
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      // Some browsers occasionally report one absurd jump; ignore those.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    document.addEventListener('mousedown', (e) => {
      this.emit('anyclick', e);
      if (!this.active) return;
      if (e.button === 0) this.emit('fire');
      if (e.button === 2) this.emit('throw');
    });
    // Right-click is "throw", so never show the browser's context menu.
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      this.keys.clear();
      this.emit('lockchange', this.locked);
    });
    document.addEventListener('pointerlockerror', () => this.emit('lockchange', false));
  }

  /** True when mouse input should control the game. */
  get active() {
    return this.locked || !this.requireLock;
  }

  /** Ask the browser to capture the mouse. Must be called from a click/key handler. */
  lock() {
    if (!this.requireLock) { this.emit('lockchange', true); return; }
    if (this.locked) return;
    try {
      // Newer browsers return a Promise that rejects if the lock is refused
      // (e.g. asking again too quickly after pressing Esc).
      const result = this.element.requestPointerLock();
      if (result && result.catch) result.catch(() => {});
    } catch {
      /* ignore — the player can simply click again */
    }
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(code) {
    return this.keys.has(code);
  }

  /** Mouse movement since the last call, then reset to zero. */
  consumeMouse() {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  // --- minimal event emitter -------------------------------------------------
  on(name, fn) {
    (this.handlers[name] ||= []).push(fn);
  }
  emit(name, data) {
    for (const fn of this.handlers[name] || []) fn(data);
  }
}
