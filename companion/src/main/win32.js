// Thin Win32 layer via koffi (prebuilt N-API FFI, no compiler needed).
// Everything here works in PHYSICAL pixels: Electron/Chromium processes are per-monitor-DPI-aware (v2).
//
// Deliberate limits (see docs/LIMITATIONS.md):
//  - SendInput cannot reach elevated windows (UIPI) or the secure desktop (UAC, lock screen). We don't try.
//  - SetForegroundWindow is subject to Windows foreground rules; when refused we report FOCUS_LOST.

import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');

const POINT = koffi.struct('PR_POINT', { x: 'int32', y: 'int32' });
const RECT = koffi.struct('PR_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const MOUSEINPUT = koffi.struct('PR_MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
const KEYBDINPUT = koffi.struct('PR_KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
const HARDWAREINPUT = koffi.struct('PR_HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
const INPUT = koffi.struct('PR_INPUT', { type: 'uint32', u: koffi.union('PR_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }) });
const EnumWindowsProc = koffi.proto('bool __stdcall PR_EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');

const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, PR_INPUT *pInputs, int cbSize)');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ PR_POINT *p)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
const IsWindowEnabled = user32.func('bool __stdcall IsWindowEnabled(intptr_t hwnd)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hwnd)');
const GetWindow = user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32 cmd)');
const GetAncestor = user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32 flags)');
const WindowFromPoint = user32.func('intptr_t __stdcall WindowFromPoint(PR_POINT p)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint8_t *buf, int max)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ PR_RECT *r)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(PR_EnumWindowsProc *cb, intptr_t lParam)');
const OpenProcess = kernel32.func('intptr_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t h)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint32 flags, _Out_ uint8_t *buf, _Inout_ uint32 *size)');
const DwmGetWindowAttribute = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ PR_RECT *r, uint32 size)');

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF = { MOVE: 0x1, LEFTDOWN: 0x2, LEFTUP: 0x4, RIGHTDOWN: 0x8, RIGHTUP: 0x10, MIDDLEDOWN: 0x20, MIDDLEUP: 0x40, WHEEL: 0x800, HWHEEL: 0x1000 };
const KEYEVENTF = { EXTENDEDKEY: 0x1, KEYUP: 0x2, UNICODE: 0x4 };
const GW_OWNER = 4;
const GA_ROOT = 2;
const SW_RESTORE = 9;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const INPUT_SIZE = koffi.sizeof(INPUT);
// marker so our own injected events can be recognised in diagnostics
const EXTRA_INFO = 0x50524d54; // 'PRMT'

function sendOne(input) {
  const n = SendInput(1, input, INPUT_SIZE);
  if (n !== 1) throw Object.assign(new Error('SendInput was blocked (UIPI / secure desktop?)'), { code: 'input_blocked' });
}

export function mouseButton(button, up) {
  const map = {
    left: up ? MOUSEEVENTF.LEFTUP : MOUSEEVENTF.LEFTDOWN,
    right: up ? MOUSEEVENTF.RIGHTUP : MOUSEEVENTF.RIGHTDOWN,
    middle: up ? MOUSEEVENTF.MIDDLEUP : MOUSEEVENTF.MIDDLEDOWN,
  };
  const flags = map[button];
  if (!flags) throw new Error('bad button');
  sendOne({ type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: EXTRA_INFO } } });
}

export function mouseWheel(deltaY, deltaX = 0) {
  if (deltaY) sendOne({ type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: (Math.round(deltaY) >>> 0), dwFlags: MOUSEEVENTF.WHEEL, time: 0, dwExtraInfo: EXTRA_INFO } } });
  if (deltaX) sendOne({ type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: (Math.round(deltaX) >>> 0), dwFlags: MOUSEEVENTF.HWHEEL, time: 0, dwExtraInfo: EXTRA_INFO } } });
}

export function moveCursor(x, y) {
  if (!SetCursorPos(Math.round(x), Math.round(y))) throw Object.assign(new Error('SetCursorPos failed'), { code: 'input_blocked' });
}

export function cursorPos() {
  const p = {};
  GetCursorPos(p);
  return { x: p.x, y: p.y };
}

export function keyEvent(vk, up, extended) {
  let flags = up ? KEYEVENTF.KEYUP : 0;
  if (extended) flags |= KEYEVENTF.EXTENDEDKEY;
  sendOne({ type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: EXTRA_INFO } } });
}

/** Types text with KEYEVENTF_UNICODE (layout-independent). */
export function typeUnicode(text) {
  for (const ch of text) {
    for (let i = 0; i < ch.length; i++) {
      const code = ch.charCodeAt(i);
      for (const up of [false, true]) {
        sendOne({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF.UNICODE | (up ? KEYEVENTF.KEYUP : 0), time: 0, dwExtraInfo: EXTRA_INFO } } });
      }
    }
  }
}

export function foregroundWindow() {
  return GetForegroundWindow();
}

export function windowPid(hwnd) {
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  return pid[0];
}

const imageCache = new Map();
export function processImage(pid) {
  if (!pid) return null;
  const cached = imageCache.get(pid);
  if (cached && Date.now() - cached.at < 10_000) return cached.path;
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h) return null;
  try {
    const buf = Buffer.alloc(2048);
    const size = [1024];
    if (!QueryFullProcessImageNameW(h, 0, buf, size)) return null;
    const path = buf.toString('utf16le', 0, size[0] * 2);
    imageCache.set(pid, { path, at: Date.now() });
    return path;
  } finally {
    CloseHandle(h);
  }
}

export function windowTitle(hwnd) {
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  return buf.toString('utf16le', 0, n * 2);
}

/** Visible window bounds (excludes the invisible resize border / drop shadow). Physical px. */
export function windowRect(hwnd) {
  const r = {};
  if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, koffi.sizeof(RECT)) !== 0) {
    if (!GetWindowRect(hwnd, r)) return null;
  }
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

export function rootWindowAt(x, y) {
  const h = WindowFromPoint({ x: Math.round(x), y: Math.round(y) });
  return h ? GetAncestor(h, GA_ROOT) : 0;
}

export function isWindow(hwnd) { return !!hwnd && IsWindow(hwnd); }
export function isIconic(hwnd) { return IsIconic(hwnd); }
export function isEnabled(hwnd) { return IsWindowEnabled(hwnd); }
export function owner(hwnd) { return GetWindow(hwnd, GW_OWNER); }

export function restore(hwnd) {
  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
}

export function setForeground(hwnd) {
  return SetForegroundWindow(hwnd);
}

/** Top-level visible windows of processes whose image file name matches `exeName` (case-insensitive). */
export function windowsOfProcess(exeName) {
  const want = exeName.toLowerCase();
  const out = [];
  EnumWindows((hwnd) => {
    if (!IsWindowVisible(hwnd)) return true;
    const pid = windowPid(hwnd);
    const img = processImage(pid);
    if (img && img.toLowerCase().endsWith(`\\${want}`)) {
      out.push({ hwnd, pid, owner: GetWindow(hwnd, GW_OWNER), title: windowTitle(hwnd), rect: windowRect(hwnd), iconic: IsIconic(hwnd) });
    }
    return true;
  }, 0);
  return out;
}
