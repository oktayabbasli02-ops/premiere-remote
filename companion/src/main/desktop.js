// Desktop facade: Premiere window discovery, focus verification and input injection.
// The executor and session code talk to this interface only, so tests can substitute a fake.

import * as w from './win32.js';
import { parseCombo, comboToEvents, EXTENDED } from './keys.js';
import { ErrorCode } from '@premiere-remote/shared/protocol';

export const PREMIERE_EXE = 'Adobe Premiere Pro.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DesktopError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class Desktop {
  constructor({ exeName = PREMIERE_EXE } = {}) {
    this.exeName = exeName;
    this.cache = { at: 0, main: null };
    this.locked = false; // set from powerMonitor lock/unlock events
  }

  /** Main Premiere window: visible, unowned, largest. Cached for 1 s. */
  premiereMain() {
    if (Date.now() - this.cache.at < 1000 && this.cache.main && w.isWindow(this.cache.main.hwnd)) return this.cache.main;
    const wins = w.windowsOfProcess(this.exeName).filter((x) => !x.owner && x.rect && x.rect.width > 200);
    wins.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
    this.cache = { at: Date.now(), main: wins[0] ?? null };
    return this.cache.main;
  }

  premierePids() {
    const m = this.premiereMain();
    return m ? new Set([m.pid]) : new Set();
  }

  isPremiereHwnd(hwnd) {
    if (!hwnd) return false;
    const img = w.processImage(w.windowPid(hwnd));
    return !!img && img.toLowerCase().endsWith(`\\${this.exeName.toLowerCase()}`);
  }

  /** Snapshot used for status reporting and pre-input checks. */
  snapshot() {
    const main = this.premiereMain();
    const fg = w.foregroundWindow();
    const fgIsPremiere = this.isPremiereHwnd(fg);
    return {
      running: !!main,
      locked: this.locked,
      minimized: main ? w.isIconic(main.hwnd) : false,
      // a modal dialog disables its owner: the reliable signal that shortcuts would go to the dialog
      modal: main ? !w.isEnabled(main.hwnd) : false,
      foreground: {
        isPremiere: fgIsPremiere,
        isMain: !!main && fg === main.hwnd,
        title: fg ? w.windowTitle(fg).slice(0, 120) : '',
      },
      mainRect: main ? w.windowRect(main.hwnd) : null,
      mainHwnd: main?.hwnd ?? null,
    };
  }

  /**
   * Ensures Premiere's main window is the foreground window and not blocked by a modal dialog.
   * Never reports success unless the post-condition is observed.
   */
  async ensurePremiereFocused() {
    if (this.locked) throw new DesktopError(ErrorCode.INPUT_BLOCKED, 'Windows is locked; input is not possible until it is unlocked at the PC.');
    const main = this.premiereMain();
    if (!main) throw new DesktopError(ErrorCode.PREMIERE_NOT_RUNNING, 'Premiere Pro is not running.');
    if (!w.isEnabled(main.hwnd)) {
      const fg = w.foregroundWindow();
      throw new DesktopError(ErrorCode.MODAL_DIALOG, 'A Premiere dialog is open. Close it first (use the full-interface view).', { title: fg ? w.windowTitle(fg) : '' });
    }
    let fg = w.foregroundWindow();
    if (this.isPremiereHwnd(fg)) return; // main window or one of its floating panels
    w.restore(main.hwnd);
    w.setForeground(main.hwnd);
    await sleep(120);
    fg = w.foregroundWindow();
    if (!this.isPremiereHwnd(fg)) {
      throw new DesktopError(ErrorCode.FOCUS_LOST, 'Could not bring Premiere to the foreground. Another window has focus.', { title: fg ? w.windowTitle(fg) : '' });
    }
  }

  async sendCombo(combo) {
    const events = comboToEvents(parseCombo(combo));
    for (const e of events) w.keyEvent(e.vk, e.up, EXTENDED.has(e.vk));
  }

  typeText(text) {
    w.typeUnicode(text);
  }

  /** Returns true when the root window under (x,y) belongs to Premiere. */
  pointIsPremiere(x, y) {
    return this.isPremiereHwnd(w.rootWindowAt(x, y));
  }

  moveTo(x, y) { w.moveCursor(x, y); }
  cursor() { return w.cursorPos(); }
  button(button, up) { w.mouseButton(button, up); }
  wheel(dy, dx) { w.mouseWheel(dy, dx); }
  restorePremiere() {
    const m = this.premiereMain();
    if (!m) return false;
    w.restore(m.hwnd);
    return w.setForeground(m.hwnd);
  }
}
