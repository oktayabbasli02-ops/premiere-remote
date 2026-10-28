// End-to-end protocol test against a real HTTP + WebSocket server on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { ClaimGuard } from '../src/ratelimit.js';
import { generateIdentityKey } from '@premiere-remote/shared/auth';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function startServer(extra = {}) {
  const app = createApp({ store: new Store(null), logger: quiet, waitTimeoutMs: 2000, turnSecret: 't', turnUrls: ['turn:turn.test:3478'], ...extra });
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  return { app, base, wsUrl: `ws://127.0.0.1:${addr.port}/v1/ws` };
}

const post = async (base, path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

/** WebSocket client with a message inbox. */
async function connect(wsUrl, hello) {
  const ws = new WebSocket(wsUrl);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  });
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const next = (t, timeout = 2000) => {
    const pred = typeof t === 'function' ? t : (m) => m.t === t;
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), timeout);
    });
  };
  const send = (m) => ws.send(JSON.stringify(m));
  send(hello);
  return { ws, next, send, closed };
}

async function pairDevice(base, wsUrl) {
  const reg = await post(base, '/v1/hosts/register', { name: 'Studio PC' });
  assert.equal(reg.status, 200);
  const host = await connect(wsUrl, { t: 'hello', role: 'host', hostId: reg.body.hostId, token: reg.body.hostToken });
  await host.next('welcome');
  host.send({ t: 'pairing.create' });
  const { code } = await host.next('pairing.code');
  assert.match(code, /^\d{8}$/);

  const devKey = generateIdentityKey();
  const claim = await post(base, '/v1/pair/claim', { code, deviceName: 'Pixel 9', devicePublicKey: devKey.publicKeySpki });
  assert.equal(claim.status, 200);
  const req = await host.next('pairing.request');
  assert.equal(req.deviceName, 'Pixel 9');
  assert.equal(req.devicePublicKey, devKey.publicKeySpki);

  const waitP = post(base, '/v1/pair/wait', claim.body);
  const hostKey = generateIdentityKey();
  host.send({ t: 'pairing.decision', pairingId: req.pairingId, approve: true, hostPublicKey: hostKey.publicKeySpki, hostName: 'Studio PC', permissions: { control: true } });
  const completed = await host.next('pairing.completed');
  const result = (await waitP).body;
  assert.equal(result.status, 'approved');
  assert.equal(result.deviceId, completed.deviceId);
  assert.equal(result.hostPublicKey, hostKey.publicKeySpki);
  assert.deepEqual(result.permissions, { view: true, control: true });
  return { host, reg: reg.body, device: result, code, claim: claim.body };
}

test('full pairing -> session -> signaling -> revoke flow', async () => {
  const { app, base, wsUrl } = await startServer();
  try {
    const { host, device, code, claim } = await pairDevice(base, wsUrl);

    // code is single-use
    const again = await post(base, '/v1/pair/claim', { code, deviceName: 'x', devicePublicKey: generateIdentityKey().publicKeySpki });
    assert.equal(again.status, 404);
    // credentials are delivered exactly once
    assert.equal((await post(base, '/v1/pair/wait', claim)).status, 404);

    const phone = await connect(wsUrl, { t: 'hello', role: 'device', deviceId: device.deviceId, token: device.deviceToken });
    const welcome = await phone.next('welcome');
    assert.equal(welcome.hostOnline, true);

    phone.send({ t: 'session.request', clientRef: 'r1' });
    const created = await phone.next('session.created');
    const sreq = await host.next('session.request');
    assert.equal(sreq.sessionId, created.sessionId);
    assert.equal(sreq.deviceId, device.deviceId);

    // signaling before accept is refused
    host.send({ t: 'signal', sessionId: sreq.sessionId, data: { sdp: 'early' } });
    assert.equal((await host.next('error')).code, 'forbidden');

    host.send({ t: 'session.accept', sessionId: sreq.sessionId });
    const acc = await phone.next('session.accept');
    assert.ok(acc.iceServers.some((s) => s.username && s.credential), 'phone receives TURN creds');

    host.send({ t: 'signal', sessionId: sreq.sessionId, data: { type: 'offer', sdp: 'v=0' } });
    assert.equal((await phone.next('signal')).data.type, 'offer');
    phone.send({ t: 'signal', sessionId: sreq.sessionId, data: { type: 'answer', sdp: 'v=0' } });
    assert.equal((await host.next('signal')).data.type, 'answer');

    // a session id belonging to someone else is rejected
    phone.send({ t: 'signal', sessionId: '00000000-0000-0000-0000-000000000000', data: {} });
    assert.equal((await phone.next('error')).code, 'not_found');

    // revoke: phone is kicked and its token stops working
    host.send({ t: 'device.revoke', deviceId: device.deviceId });
    await host.next('device.revoked');
    assert.equal(await phone.closed, 4003);
    const retry = await connect(wsUrl, { t: 'hello', role: 'device', deviceId: device.deviceId, token: device.deviceToken });
    assert.equal((await retry.next('error')).code, 'unauthorized');
    assert.equal(await retry.closed, 4001);
    host.ws.close();
  } finally {
    await app.close();
  }
});

test('host rejection is relayed and burns the code', async () => {
  const { app, base, wsUrl } = await startServer();
  try {
    const reg = (await post(base, '/v1/hosts/register', { name: 'PC' })).body;
    const host = await connect(wsUrl, { t: 'hello', role: 'host', hostId: reg.hostId, token: reg.hostToken });
    await host.next('welcome');
    host.send({ t: 'pairing.create' });
    const { code } = await host.next('pairing.code');
    const claim = (await post(base, '/v1/pair/claim', { code, deviceName: 'Phone', devicePublicKey: generateIdentityKey().publicKeySpki })).body;
    const req = await host.next('pairing.request');
    host.send({ t: 'pairing.decision', pairingId: req.pairingId, approve: false });
    const res = (await post(base, '/v1/pair/wait', claim)).body;
    assert.equal(res.status, 'rejected');
    assert.equal(res.deviceToken, undefined);
    host.ws.close();
  } finally {
    await app.close();
  }
});

test('wrong host token and wrong device token are refused', async () => {
  const { app, base, wsUrl } = await startServer();
  try {
    const reg = (await post(base, '/v1/hosts/register', { name: 'PC' })).body;
    const bad = await connect(wsUrl, { t: 'hello', role: 'host', hostId: reg.hostId, token: 'nope' });
    assert.equal((await bad.next('error')).code, 'unauthorized');
    const badDev = await connect(wsUrl, { t: 'hello', role: 'device', deviceId: 'd_x', token: 'nope' });
    assert.equal((await badDev.next('error')).code, 'unauthorized');
  } finally {
    await app.close();
  }
});

test('brute-forcing pairing codes gets rate limited', async () => {
  const { app, base } = await startServer({ claimGuard: new ClaimGuard({ perIpPerMin: 600, burst: 50 }) });
  try {
    const key = generateIdentityKey().publicKeySpki;
    const statuses = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await post(base, '/v1/pair/claim', { code: String(i).padStart(8, '0'), deviceName: 'atk', devicePublicKey: key })).status);
    }
    assert.deepEqual(statuses.slice(0, 5), [404, 404, 404, 404, 404]);
    assert.ok(statuses.slice(5).every((s) => s === 429), `got ${statuses}`);
  } finally {
    await app.close();
  }
});

test('registration key is enforced when configured', async () => {
  const { app, base } = await startServer({ registrationKey: 'family-only' });
  try {
    assert.equal((await post(base, '/v1/hosts/register', { name: 'PC' })).status, 401);
    assert.equal((await post(base, '/v1/hosts/register', { name: 'PC', registrationKey: 'family-only' })).status, 200);
  } finally {
    await app.close();
  }
});
