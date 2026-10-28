import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript, extractFingerprint, generateIdentityKey, signTranscript, verifyTranscript, isValidP256Spki, newNonce } from '../src/auth.js';
import { redact } from '../src/redact.js';
import { capabilityList, validateCommandArgs, COMMANDS } from '../src/commands.js';

const FP_A = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
const FP_B = Array.from({ length: 32 }, (_, i) => (255 - i).toString(16).padStart(2, '0').toUpperCase()).join(':');

const base = {
  sessionId: 's1', hostNonce: newNonce(), deviceNonce: newNonce(),
  hostFingerprint: FP_A, deviceFingerprint: FP_B, deviceId: 'dev1', hostId: 'host1',
};

test('extractFingerprint reads the sha-256 DTLS fingerprint from SDP', () => {
  const sdp = `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${FP_A.toLowerCase()}\r\na=setup:actpass\r\n`;
  assert.equal(extractFingerprint(sdp), FP_A);
  assert.equal(extractFingerprint('v=0\r\n'), null);
});

test('device signature verifies only with matching transcript and key', () => {
  const dev = generateIdentityKey();
  const other = generateIdentityKey();
  const t = buildTranscript({ role: 'device', ...base });
  const sig = signTranscript(dev.privateKeyPkcs8, t);
  assert.equal(verifyTranscript(dev.publicKeySpki, t, sig), true);
  assert.equal(verifyTranscript(other.publicKeySpki, t, sig), false, 'wrong key');
  // a signaling-server MITM that swapped the host fingerprint changes the transcript
  const mitm = buildTranscript({ role: 'device', ...base, hostFingerprint: FP_B });
  assert.equal(verifyTranscript(dev.publicKeySpki, mitm, sig), false);
  // a device signature cannot be replayed as the host's
  const asHost = buildTranscript({ role: 'host', ...base });
  assert.equal(verifyTranscript(dev.publicKeySpki, asHost, sig), false);
  assert.equal(verifyTranscript(dev.publicKeySpki, t, 'garbage'), false);
});

test('transcript refuses ambiguous fields', () => {
  assert.throws(() => buildTranscript({ role: 'device', ...base, sessionId: 'a|b' }));
  assert.throws(() => buildTranscript({ role: 'device', ...base, hostNonce: '' }));
});

test('isValidP256Spki accepts P-256 SPKI only', () => {
  assert.equal(isValidP256Spki(generateIdentityKey().publicKeySpki), true);
  assert.equal(isValidP256Spki('AAAA'), false);
  assert.equal(isValidP256Spki(42), false);
});

test('redact removes codes, tokens and SDP from log fields', () => {
  const out = redact({ code: '01234567', nested: { deviceToken: 'abc', sdp: 'v=0' }, msg: 'code 00012345 entered', ok: 1 });
  assert.equal(out.code, '[redacted]');
  assert.equal(out.nested.deviceToken, '[redacted]');
  assert.equal(out.nested.sdp, '[redacted]');
  assert.equal(out.msg, 'code [8-digit redacted] entered');
  assert.equal(out.ok, 1);
});

test('command catalogue: every keyboard command names a shortcut, unsupported ones are reported as such', () => {
  for (const [name, d] of Object.entries(COMMANDS)) {
    if (d.impl === 'keyboard') assert.ok(d.shortcut, `${name} lacks shortcut key`);
    if (d.impl === 'api') assert.ok(d.api || name === 'status' || d.api === undefined, name);
  }
  const caps = capabilityList({ shortcuts: { playPause: 'Space' } });
  assert.equal(caps.find((c) => c.action === 'playPause').impl, 'keyboard');
  assert.equal(caps.find((c) => c.action === 'undo').impl, 'unsupported', 'missing shortcut -> unsupported, not a stub');
  assert.equal(caps.find((c) => c.action === 'trackSolo').impl, 'unsupported');
});

test('validateCommandArgs rejects bad input', () => {
  assert.equal(validateCommandArgs('stepFrames', { frames: 1 }), null);
  assert.ok(validateCommandArgs('stepFrames', { frames: 0 }));
  assert.ok(validateCommandArgs('stepFrames', { frames: 1.5 }));
  assert.ok(validateCommandArgs('stepFrames', { frames: 10_000 }));
  assert.ok(validateCommandArgs('rm -rf', {}));
  assert.ok(validateCommandArgs('trackMute', { kind: 'audio', index: -1, mute: true }));
});
