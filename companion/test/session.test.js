import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RemoteSession } from '../src/main/session.js';
import { CommandJournal } from '@premiere-remote/shared/journal';
import { buildTranscript, generateIdentityKey, signTranscript, verifyTranscript, newNonce } from '@premiere-remote/shared/auth';
import { DEFAULT_SHORTCUT_PROFILE } from '@premiere-remote/shared/commands';
import { FakeDesktop } from './fakes.js';

const FP_H = Array(32).fill('AA').join(':');
const FP_D = Array(32).fill('BB').join(':');
const quiet = { info() {}, warn() {}, error() {} };
const tick = () => new Promise((r) => setImmediate(r));

function makeSession({ canControl = true, journal = new CommandJournal(), executor } = {}) {
  const devKey = generateIdentityKey();
  const hostKey = generateIdentityKey();
  const sent = [];
  const ended = [];
  const desktop = new FakeDesktop();
  let executed = 0;
  const rs = new RemoteSession({
    sessionId: 'sess-1',
    hostId: 'h_1',
    device: { deviceId: 'd_1', name: 'Pixel', publicKey: devKey.publicKeySpki, canControl },
    hostKey,
    send: (ch, m) => sent.push({ ch, m }),
    end: (r) => ended.push(r),
    onAuthed: () => {},
    executor: executor ?? { execute: async () => { executed++; return { status: 'ok', via: 'api', verified: true }; } },
    desktop,
    journal,
    getCapture: () => ({ rect: { x: 100, y: 50, width: 1000, height: 500 } }),
    getSettings: () => ({ allowInputOutsidePremiere: false }),
    getProfile: () => DEFAULT_SHORTCUT_PROFILE,
    onHostRequest: () => {},
    log: quiet,
  });
  desktop.premiereRect = { x: 100, y: 50, width: 1000, height: 500 };
  return { rs, sent, ended, devKey, hostKey, desktop, journal, executedCount: () => executed };
}

function authenticate(ctx, { fp = { host: FP_H, device: FP_D }, key = ctx.devKey } = {}) {
  ctx.rs.setFingerprints({ host: FP_H, device: FP_D });
  ctx.rs.onControlOpen();
  const ch = ctx.sent.find((s) => s.m.t === 'auth.challenge').m;
  const deviceNonce = newNonce();
  const t = buildTranscript({ role: 'device', sessionId: ch.sessionId, hostNonce: ch.hostNonce, deviceNonce, hostFingerprint: fp.host, deviceFingerprint: fp.device, deviceId: 'd_1', hostId: ch.hostId });
  ctx.rs.onControl({ t: 'auth.response', deviceNonce, sig: signTranscript(key.privateKeyPkcs8, t) });
  return { ch, deviceNonce };
}

test('mutual auth: host verifies device signature and returns a verifiable host signature', () => {
  const ctx = makeSession();
  const { ch, deviceNonce } = authenticate(ctx);
  assert.equal(ctx.rs.authed, true);
  const ok = ctx.sent.find((s) => s.m.t === 'auth.ok').m;
  const hostT = buildTranscript({ role: 'host', sessionId: 'sess-1', hostNonce: ch.hostNonce, deviceNonce, hostFingerprint: FP_H, deviceFingerprint: FP_D, deviceId: 'd_1', hostId: 'h_1' });
  assert.equal(verifyTranscript(ctx.hostKey.publicKeySpki, hostT, ok.sig), true);
  assert.deepEqual(ok.permissions, { view: true, control: true });
  assert.ok(ok.capabilities.some((c) => c.action === 'addEdit' && c.impl === 'keyboard'));
});

test('auth fails for a wrong key or a MITM-substituted fingerprint', () => {
  const a = makeSession();
  authenticate(a, { key: generateIdentityKey() });
  assert.equal(a.rs.authed, false);
  assert.deepEqual(a.ended, ['auth_failed']);

  const b = makeSession();
  authenticate(b, { fp: { host: Array(32).fill('CC').join(':'), device: FP_D } });
  assert.equal(b.rs.authed, false);
  assert.deepEqual(b.ended, ['auth_failed']);
});

test('no command or input is processed before authentication', async () => {
  const ctx = makeSession();
  ctx.rs.onControl({ t: 'cmd', id: randomUUID(), action: 'save' });
  ctx.rs.onControl({ t: 'ptr', kind: 'click', x: 0.5, y: 0.5, epoch: 'e' });
  await tick();
  assert.equal(ctx.executedCount(), 0);
  assert.deepEqual(ctx.desktop.log, []);
});

test('duplicate command ids are executed once and answered from the journal', async () => {
  const ctx = makeSession();
  authenticate(ctx);
  const id = randomUUID();
  ctx.rs.onControl({ t: 'cmd', id, action: 'save' });
  await tick(); await tick();
  ctx.rs.onControl({ t: 'cmd', id, action: 'save' });
  await tick();
  assert.equal(ctx.executedCount(), 1);
  const acks = ctx.sent.filter((s) => s.m.t === 'ack' && s.m.id === id).map((s) => s.m);
  assert.equal(acks.length, 2);
  assert.equal(acks[1].duplicate, true);
  assert.equal(acks[1].status, 'ok');
});

test('after reconnect (new session, same journal) the phone can query instead of re-sending', async () => {
  const journal = new CommandJournal();
  const first = makeSession({ journal });
  authenticate(first);
  const id = randomUUID();
  first.rs.onControl({ t: 'cmd', id, action: 'rippleDeleteSelection' });
  await tick(); await tick();
  first.rs.close();

  const second = makeSession({ journal });
  second.devKey = first.devKey;
  second.rs.device.publicKey = first.devKey.publicKeySpki;
  authenticate(second);
  second.rs.onControl({ t: 'cmd.query', ids: [id, randomUUID()] });
  const st = second.sent.find((s) => s.m.t === 'cmd.status').m;
  assert.equal(st.results[0].state, 'done');
  assert.equal(st.results[0].result.status, 'ok');
  assert.equal(st.results[1].state, 'unknown');
  // even if the phone does resend, it is not executed again
  second.rs.onControl({ t: 'cmd', id, action: 'rippleDeleteSelection' });
  await tick();
  assert.equal(second.executedCount(), 0);
});

test('view-only devices cannot edit or click', async () => {
  const ctx = makeSession({ canControl: false });
  authenticate(ctx);
  const id = randomUUID();
  ctx.rs.onControl({ t: 'cmd', id, action: 'addEdit' });
  ctx.rs.onControl({ t: 'epoch', epoch: 'e1' });
  ctx.rs.onControl({ t: 'ptr', id: 'p1', kind: 'click', x: 0.5, y: 0.5, epoch: 'e1' });
  ctx.rs.onPointer({ t: 'move', x: 0.5, y: 0.5, seq: 1, ts: Date.now(), epoch: 'e1' });
  await tick();
  assert.equal(ctx.executedCount(), 0);
  assert.equal(ctx.sent.find((s) => s.m.id === id).m.status, 'forbidden');
  assert.deepEqual(ctx.desktop.log, []);
});

test('pointer events are mapped to physical screen pixels of the capture rect', () => {
  const ctx = makeSession();
  authenticate(ctx);
  ctx.rs.onControl({ t: 'epoch', epoch: 'e1' });
  ctx.rs.onControl({ t: 'ptr', kind: 'click', x: 0.5, y: 0.5, epoch: 'e1' });
  assert.deepEqual(ctx.desktop.log, ['move:600,300', 'left:down', 'left:up']);
});

test('stale-epoch pointer events from a previous connection are ignored', () => {
  const ctx = makeSession();
  authenticate(ctx);
  ctx.rs.onControl({ t: 'epoch', epoch: 'new' });
  ctx.rs.onControl({ t: 'ptr', kind: 'click', x: 0.5, y: 0.5, epoch: 'old' });
  ctx.rs.onPointer({ t: 'move', x: 0.1, y: 0.1, seq: 99, ts: Date.now(), epoch: 'old' });
  assert.deepEqual(ctx.desktop.log, []);
});

test('held buttons are released when the session closes (no stuck drag)', () => {
  const ctx = makeSession();
  authenticate(ctx);
  ctx.rs.onControl({ t: 'epoch', epoch: 'e1' });
  ctx.rs.onControl({ t: 'ptr', kind: 'down', x: 0.2, y: 0.2, epoch: 'e1' });
  ctx.rs.close();
  assert.equal(ctx.desktop.log.at(-1), 'left:up');
});

test('Win-key combos from the phone are refused', async () => {
  const ctx = makeSession();
  authenticate(ctx);
  const id = randomUUID();
  ctx.rs.onControl({ t: 'key', id, combo: 'Win+R' });
  await tick();
  assert.equal(ctx.sent.find((s) => s.m.id === id).m.status, 'error');
  assert.ok(!ctx.desktop.log.some((l) => l.startsWith('key:')));
});
