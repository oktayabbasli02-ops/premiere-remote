// Pure key-combo parsing (no native deps, unit-tested). Converts "Ctrl+Shift+Z" into
// virtual-key sequences for SendInput. Win-key combos are refused: the phone must never be
// able to open Run/PowerShell via Win+R etc.

export const VK = Object.freeze({
  BACK: 0x08, TAB: 0x09, RETURN: 0x0d, SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, PAUSE: 0x13,
  ESCAPE: 0x1b, SPACE: 0x20, PRIOR: 0x21, NEXT: 0x22, END: 0x23, HOME: 0x24,
  LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, INSERT: 0x2d, DELETE: 0x2e,
  OEM_1: 0xba, OEM_PLUS: 0xbb, OEM_COMMA: 0xbc, OEM_MINUS: 0xbd, OEM_PERIOD: 0xbe, OEM_2: 0xbf,
  OEM_3: 0xc0, OEM_4: 0xdb, OEM_5: 0xdc, OEM_6: 0xdd, OEM_7: 0xde,
  NUMPAD0: 0x60, MULTIPLY: 0x6a, ADD: 0x6b, SUBTRACT: 0x6d, DECIMAL: 0x6e, DIVIDE: 0x6f, F1: 0x70,
});

/** Keys that need KEYEVENTF_EXTENDEDKEY. */
export const EXTENDED = new Set([VK.PRIOR, VK.NEXT, VK.END, VK.HOME, VK.LEFT, VK.UP, VK.RIGHT, VK.DOWN, VK.INSERT, VK.DELETE, VK.DIVIDE]);

const NAMED = {
  backspace: VK.BACK, tab: VK.TAB, enter: VK.RETURN, return: VK.RETURN, escape: VK.ESCAPE, esc: VK.ESCAPE,
  space: VK.SPACE, pageup: VK.PRIOR, pagedown: VK.NEXT, end: VK.END, home: VK.HOME,
  left: VK.LEFT, up: VK.UP, right: VK.RIGHT, down: VK.DOWN, insert: VK.INSERT, delete: VK.DELETE, del: VK.DELETE,
  ';': VK.OEM_1, '=': VK.OEM_PLUS, ',': VK.OEM_COMMA, '-': VK.OEM_MINUS, '.': VK.OEM_PERIOD, '/': VK.OEM_2,
  '`': VK.OEM_3, '[': VK.OEM_4, '\\': VK.OEM_5, ']': VK.OEM_6, "'": VK.OEM_7,
  'num+': VK.ADD, 'num-': VK.SUBTRACT, 'num*': VK.MULTIPLY, 'num/': VK.DIVIDE, 'num.': VK.DECIMAL,
  pause: VK.PAUSE,
};

const MODIFIERS = { ctrl: VK.CONTROL, control: VK.CONTROL, shift: VK.SHIFT, alt: VK.MENU };
const FORBIDDEN_MODIFIERS = new Set(['win', 'meta', 'cmd', 'super']);

/**
 * @param {string} combo e.g. "Ctrl+Shift+Z", "Space", "Shift+3", "=", "F5", "Num+"
 * @returns {{modifiers:number[], key:number}}
 */
export function parseCombo(combo) {
  if (typeof combo !== 'string' || combo.length === 0 || combo.length > 40) throw new Error('invalid combo');
  // split on "+" but allow a trailing "+" key ("Ctrl++") and the "Num+" name
  const parts = combo.match(/(?:num\+|[^+]+|\+(?=$))/gi);
  if (!parts) throw new Error('invalid combo');
  const modifiers = [];
  let key = null;
  for (const raw of parts) {
    const p = raw.trim().toLowerCase();
    if (FORBIDDEN_MODIFIERS.has(p)) throw new Error('Windows-key combinations are not allowed');
    if (MODIFIERS[p] !== undefined) {
      if (!modifiers.includes(MODIFIERS[p])) modifiers.push(MODIFIERS[p]);
      continue;
    }
    if (key !== null) throw new Error(`more than one non-modifier key in "${combo}"`);
    key = keyCode(p);
  }
  if (key === null) throw new Error('combo has no key');
  if (modifiers.includes(VK.CONTROL) && modifiers.includes(VK.MENU) && key === VK.DELETE) throw new Error('Ctrl+Alt+Del is not allowed');
  return { modifiers, key };
}

function keyCode(p) {
  if (NAMED[p] !== undefined) return NAMED[p];
  if (p === '+') return VK.OEM_PLUS;
  if (/^[a-z]$/.test(p)) return p.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(p)) return p.charCodeAt(0);
  if (/^num[0-9]$/.test(p)) return VK.NUMPAD0 + Number(p[3]);
  const f = p.match(/^f([1-9]|1[0-9]|2[0-4])$/);
  if (f) return VK.F1 + Number(f[1]) - 1;
  throw new Error(`unknown key "${p}"`);
}

/** Expands a parsed combo into an ordered down/up event list. */
export function comboToEvents({ modifiers, key }) {
  const ev = [];
  for (const m of modifiers) ev.push({ vk: m, up: false });
  ev.push({ vk: key, up: false });
  ev.push({ vk: key, up: true });
  for (const m of [...modifiers].reverse()) ev.push({ vk: m, up: true });
  return ev;
}

/** Keys the phone's virtual keyboard bar may send directly (besides text and profile shortcuts). */
export function isAllowedDirectCombo(combo) {
  try {
    parseCombo(combo);
    return true;
  } catch {
    return false;
  }
}
