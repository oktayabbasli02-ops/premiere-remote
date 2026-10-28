import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCombo, comboToEvents, VK, isAllowedDirectCombo } from '../src/main/keys.js';

test('parses default Premiere shortcuts', () => {
  assert.deepEqual(parseCombo('Space'), { modifiers: [], key: VK.SPACE });
  assert.deepEqual(parseCombo('Ctrl+K'), { modifiers: [VK.CONTROL], key: 0x4b });
  assert.deepEqual(parseCombo('Ctrl+Shift+Z'), { modifiers: [VK.CONTROL, VK.SHIFT], key: 0x5a });
  assert.deepEqual(parseCombo('Shift+3'), { modifiers: [VK.SHIFT], key: 0x33 });
  assert.deepEqual(parseCombo('='), { modifiers: [], key: VK.OEM_PLUS });
  assert.deepEqual(parseCombo('-'), { modifiers: [], key: VK.OEM_MINUS });
  assert.deepEqual(parseCombo('Ctrl++'), { modifiers: [VK.CONTROL], key: VK.OEM_PLUS });
  assert.deepEqual(parseCombo('F12'), { modifiers: [], key: 0x7b });
  assert.deepEqual(parseCombo('Num+'), { modifiers: [], key: VK.ADD });
  assert.deepEqual(parseCombo('alt+left'), { modifiers: [VK.MENU], key: VK.LEFT });
});

test('refuses Win-key combos, Ctrl+Alt+Del and garbage', () => {
  assert.throws(() => parseCombo('Win+R'), /Windows-key/);
  assert.throws(() => parseCombo('Meta+R'), /Windows-key/);
  assert.throws(() => parseCombo('Ctrl+Alt+Delete'));
  assert.throws(() => parseCombo('Ctrl+Shift'), /no key/);
  assert.throws(() => parseCombo('A+B'), /more than one/);
  assert.throws(() => parseCombo('powershell'), /unknown key/);
  assert.equal(isAllowedDirectCombo('Win+R'), false);
  assert.equal(isAllowedDirectCombo('Enter'), true);
});

test('expands to balanced down/up sequence with modifiers released in reverse', () => {
  assert.deepEqual(comboToEvents(parseCombo('Ctrl+Shift+Z')), [
    { vk: VK.CONTROL, up: false }, { vk: VK.SHIFT, up: false }, { vk: 0x5a, up: false },
    { vk: 0x5a, up: true }, { vk: VK.SHIFT, up: true }, { vk: VK.CONTROL, up: true },
  ]);
});
