// Test doubles for the desktop and the Premiere panel bridge.

export class FakeDesktop {
  constructor() {
    this.log = [];
    this.locked = false;
    this.focusError = null;
    this.premiereRect = { x: 0, y: 0, width: 1000, height: 500 };
    this.cursorAt = { x: 0, y: 0 };
  }
  async ensurePremiereFocused() {
    this.log.push('focus');
    if (this.focusError) throw this.focusError;
  }
  async sendCombo(c) { this.log.push(`key:${c}`); if (this.onCombo) this.onCombo(c); }
  typeText(t) { this.log.push(`text:${t}`); }
  pointIsPremiere(x, y) {
    const r = this.premiereRect;
    return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
  }
  moveTo(x, y) { this.cursorAt = { x, y }; this.log.push(`move:${x},${y}`); }
  cursor() { return this.cursorAt; }
  button(b, up) { this.log.push(`${b}:${up ? 'up' : 'down'}`); }
  wheel(dy, dx) { this.log.push(`wheel:${dy},${dx}`); }
}

export class FakePlugin {
  constructor(handlers = {}) {
    this.connected = true;
    this.calls = [];
    this.handlers = handlers;
  }
  async request(op, args) {
    this.calls.push({ op, args });
    if (!this.connected) throw Object.assign(new Error('not connected'), { code: 'plugin_not_connected' });
    const h = this.handlers[op];
    if (!h) return { ok: true };
    return h(args);
  }
}
