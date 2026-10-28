import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandExecutor } from '../src/main/executor.js';
import { DEFAULT_SHORTCUT_PROFILE } from '@premiere-remote/shared/commands';
import { FakeDesktop, FakePlugin } from './fakes.js';

const noSleep = async () => {};

function setup(handlers, profile = DEFAULT_SHORTCUT_PROFILE) {
  const desktop = new FakeDesktop();
  const plugin = new FakePlugin(handlers);
  const ex = new CommandExecutor({ desktop, plugin, getProfile: () => profile, sleep: noSleep });
  return { desktop, plugin, ex };
}

test('API commands go to the panel, never to the keyboard', async () => {
  const { desktop, plugin, ex } = setup({ save: () => ({ saved: true }) });
  const r = await ex.execute('save', {});
  assert.equal(r.status, 'ok');
  assert.equal(r.via, 'api');
  assert.equal(r.verified, true);
  assert.equal(plugin.calls[0].op, 'save');
  assert.deepEqual(desktop.log, []);
});

test('API failure is reported, not masked', async () => {
  const { ex } = setup({ rippleDeleteSelection: () => { throw Object.assign(new Error('Nothing selected'), { code: 'no_selection' }); } });
  const r = await ex.execute('rippleDeleteSelection', {});
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'no_selection');
});

test('addEdit: focus check, timeline focus, shortcut, then verified by clip count', async () => {
  let clips = 3;
  const { desktop, ex } = setup({ countTrackItems: () => ({ total: clips }) });
  desktop.onCombo = (c) => { if (c === 'Ctrl+K') clips = 5; };
  const r = await ex.execute('addEdit', {});
  assert.deepEqual(desktop.log, ['focus', 'key:Shift+3', 'key:Ctrl+K']);
  assert.equal(r.status, 'ok');
  assert.equal(r.verified, true);
  assert.deepEqual(r.data, { clipsBefore: 3, clipsAfter: 5 });
});

test('addEdit with no effect is an error, not a false success', async () => {
  const { ex } = setup({ countTrackItems: () => ({ total: 3 }) });
  const r = await ex.execute('addEdit', {});
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'no_effect');
});

test('keyboard command refuses when Premiere is behind a modal dialog', async () => {
  const { desktop, ex } = setup({});
  desktop.focusError = Object.assign(new Error('A Premiere dialog is open.'), { code: 'modal_dialog' });
  const r = await ex.execute('undo', {});
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'modal_dialog');
  assert.ok(!desktop.log.includes('key:Ctrl+Z'), 'no keystroke was sent');
});

test('undo is honest about being unverifiable', async () => {
  const { desktop, ex } = setup({});
  const r = await ex.execute('undo', {});
  assert.equal(r.status, 'ok');
  assert.equal(r.verified, false);
  assert.ok(desktop.log.includes('key:Ctrl+Z'));
});

test('a missing shortcut makes the command unsupported instead of guessing a key', async () => {
  const { desktop, ex } = setup({}, { id: 'x', name: 'Custom', shortcuts: { focusTimeline: 'Shift+3' } });
  const r = await ex.execute('playPause', {});
  assert.equal(r.status, 'unsupported');
  assert.equal(r.error.code, 'shortcut_not_configured');
  assert.deepEqual(desktop.log, []);
});

test('custom shortcut profiles are honoured', async () => {
  const { desktop, ex } = setup({}, { id: 'x', name: 'Mine', shortcuts: { undo: 'Ctrl+Alt+Z' } });
  await ex.execute('undo', {});
  assert.ok(desktop.log.includes('key:Ctrl+Alt+Z'));
});

test('destructive keyboard command refuses when the active sequence changed', async () => {
  const { desktop, ex } = setup({ status: () => ({ sequence: { guid: 'other', name: 'Seq 2' } }), countTrackItems: () => ({ total: 1 }) });
  const r = await ex.execute('addEdit', {}, { expect: { sequenceGuid: 'seq-1' } });
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'sequence_changed');
  assert.deepEqual(desktop.log, []);
});

test('unsupported and invalid commands', async () => {
  const { ex } = setup({});
  assert.equal((await ex.execute('trackSolo', {})).status, 'unsupported');
  assert.equal((await ex.execute('stepFrames', { frames: 0 })).error.code, 'bad_request');
});

test('playPause verified through playhead movement', async () => {
  let ticks = 0;
  let playing = false;
  const { desktop, ex } = setup({ playerPosition: () => { if (playing) ticks += 100; return { ticks: String(ticks) }; } });
  desktop.onCombo = (c) => { if (c === 'Space') playing = !playing; };
  const r = await ex.execute('playPause', {});
  assert.equal(r.verified, true);
  assert.equal(r.data.playing, true);
});
