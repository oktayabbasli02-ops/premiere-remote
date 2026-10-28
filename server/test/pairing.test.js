import test from 'node:test';
import assert from 'node:assert/strict';
import { PairingRegistry, generateCode, normalizeCode } from '../src/pairing.js';
import { ClaimGuard } from '../src/ratelimit.js';
import { turnCredentials } from '../src/turn.js';
import { createHmac } from 'node:crypto';

const dev = { deviceName: 'Pixel', devicePublicKey: 'k' };

test('codes are 8 digits and keep leading zeros', () => {
  for (let i = 0; i < 2000; i++) assert.match(generateCode(), /^\d{8}$/);
  const r = new PairingRegistry({ codeGen: () => '00000042' });
  assert.equal(r.create('h1').code, '00000042');
  assert.ok(r.claim('00000042', dev), 'claimed with leading zeros intact');
});

test('normalizeCode tolerates spaces/dashes but nothing else', () => {
  assert.equal(normalizeCode('0012 3456'), '00123456');
  assert.equal(normalizeCode('0012-3456'), '00123456');
  assert.equal(normalizeCode('123456'), null);
  assert.equal(normalizeCode('1234567a'), null);
  assert.equal(normalizeCode(12345678), null);
});

test('codes expire after the configured TTL', () => {
  let now = 0;
  const r = new PairingRegistry({ ttlMs: 60_000, now: () => now });
  const { code } = r.create('h1');
  now = 59_999;
  assert.ok(r.claim(code, dev), 'valid 1 ms before expiry');
  now = 0;
  const c2 = r.create('h1').code;
  now = 60_000;
  assert.equal(r.claim(c2, dev), null, 'expired exactly at TTL');
  assert.equal(r.activeCodeCount(), 0);
});

test('codes are single-use', () => {
  const r = new PairingRegistry();
  const { code } = r.create('h1');
  assert.ok(r.claim(code, dev));
  assert.equal(r.claim(code, dev), null);
});

test('a new code for the same host invalidates the previous one', () => {
  const r = new PairingRegistry();
  const a = r.create('h1').code;
  const b = r.create('h1').code;
  if (a !== b) assert.equal(r.claim(a, dev), null);
  assert.ok(r.claim(b, dev));
});

test('no collisions among active codes even when the generator repeats', () => {
  const seq = ['11111111', '11111111', '11111111', '22222222'];
  const r = new PairingRegistry({ codeGen: () => seq.shift() });
  assert.equal(r.create('h1').code, '11111111');
  assert.equal(r.create('h2').code, '22222222');
  assert.equal(r.claim('11111111', dev).hostId, 'h1');
  assert.equal(r.claim('22222222', dev).hostId, 'h2');
});

test('pairing secret is required to read the result and results are delivered once', () => {
  const r = new PairingRegistry();
  const { code } = r.create('h1');
  const c = r.claim(code, dev);
  assert.equal(r.getPending(c.pairingId, 'wrong'), null);
  assert.ok(r.getPending(c.pairingId, c.pairingSecret));
  assert.equal(r.resolve(c.pairingId, 'other-host', { status: 'approved' }), false, 'other host cannot decide');
  assert.equal(r.resolve(c.pairingId, 'h1', { status: 'approved' }), true);
  assert.equal(r.resolve(c.pairingId, 'h1', { status: 'rejected' }), false, 'decision is final');
  r.consume(c.pairingId);
  assert.equal(r.getPending(c.pairingId, c.pairingSecret), null);
});

test('ClaimGuard: per-IP lockout after repeated failures', () => {
  let now = 0;
  const g = new ClaimGuard({ now: () => now, perIpPerMin: 600, burst: 100 });
  for (let i = 0; i < 5; i++) { assert.ok(g.check('1.1.1.1').ok); g.recordFailure('1.1.1.1'); }
  const locked = g.check('1.1.1.1');
  assert.equal(locked.ok, false);
  assert.ok(locked.retryAfterSec >= 59);
  assert.ok(g.check('2.2.2.2').ok, 'other IPs unaffected');
  now = 61_000;
  assert.ok(g.check('1.1.1.1').ok, 'lock expires');
});

test('ClaimGuard: token bucket limits request rate per IP', () => {
  const now = 0;
  const g = new ClaimGuard({ now: () => now, perIpPerMin: 10, burst: 5 });
  for (let i = 0; i < 5; i++) assert.ok(g.check('ip').ok);
  assert.equal(g.check('ip').ok, false);
});

test('ClaimGuard: global ceiling stops distributed enumeration', () => {
  const now = 0;
  const g = new ClaimGuard({ now: () => now, perIpPerMin: 600, burst: 100, globalFailPerMin: 20 });
  for (let i = 0; i < 21; i++) g.recordFailure(`10.0.0.${i}`);
  assert.equal(g.check('192.168.1.1').ok, false);
});

test('TURN credentials are time-limited HMACs of the username', () => {
  const ice = turnCredentials({ secret: 's3cret', urls: ['turn:t.example:3478'], stunUrls: ['stun:s'], ttlSec: 100, subject: 'd1', now: () => 1_000_000 });
  assert.equal(ice.length, 2);
  assert.equal(ice[1].username, `${1000 + 100}:d1`);
  assert.equal(ice[1].credential, createHmac('sha1', 's3cret').update(ice[1].username).digest('base64'));
  assert.equal(turnCredentials({ urls: ['turn:x'], subject: 'd' }).length, 0, 'no secret -> no TURN entry');
});
