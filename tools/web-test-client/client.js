// Browser implementation of the device side of the protocol, used to test the companion and
// signaling server end-to-end without an Android build. Keys live in memory only.

const $ = (id) => document.getElementById(id);
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  $('log').textContent += `${new Date().toISOString().slice(11, 23)} ${line}\n`;
  $('log').scrollTop = 1e9;
};

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---- ECDSA signature format conversion (WebCrypto uses raw r||s, the protocol uses DER like Android/Node)
function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = Uint8Array.from([0, ...v]);
    return [0x02, v.length, ...v];
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}
function derToRaw(der) {
  let i = 2;
  const read = () => {
    i++; // 0x02
    const len = der[i++];
    let v = der.slice(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = read();
  const s = read();
  return Uint8Array.from([...r, ...s]);
}

const transcript = (role, x) => ['PREMIERE-REMOTE-AUTH-V1', role, x.hostId, x.deviceId, x.sessionId, x.hostNonce, x.deviceNonce, x.hostFp, x.deviceFp].join('|');
const fingerprint = (sdp) => (sdp.match(/^a=fingerprint:sha-256 ([0-9A-Fa-f:]{95})\s*$/m) || [])[1]?.toUpperCase() ?? null;

let keys = null;
let spki = null;
let creds = null; // {hostId, deviceId, deviceToken, hostPublicKey}
let ws = null;
let pc = null;
let control = null;
let sessionId = null;
let fp = null;
let nonces = null;
let epoch = crypto.randomUUID();

async function ensureKeys() {
  if (keys) return;
  keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  spki = b64(await crypto.subtle.exportKey('spki', keys.publicKey));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', unb64(spki)));
  const hex = [...h].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  $('keyid').textContent = `key ID ${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

async function post(path, body) {
  // same-origin: serve.mjs forwards /v1/* to the signaling server
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

$('pair').onclick = async () => {
  await ensureKeys();
  const claim = await post('/v1/pair/claim', { code: $('code').value, deviceName: 'Browser test client', devicePublicKey: spki });
  log('claim ->', claim.status, claim.body.error ?? 'ok');
  if (claim.status !== 200) return;
  log('waiting for approval on the PC…');
  for (;;) {
    const r = await post('/v1/pair/wait', claim.body);
    if (r.status !== 200) return log('wait failed', r.status);
    if (r.body.status === 'pending') continue;
    if (r.body.status !== 'approved') return log('pairing', r.body.status, r.body.reason ?? '');
    creds = r.body;
    log('paired', { hostId: creds.hostId, deviceId: creds.deviceId, control: creds.permissions.control });
    return;
  }
};

$('connect').onclick = () => {
  if (!creds) return log('pair first');
  const url = $('server').value.replace(/^http/, 'ws').replace(/\/$/, '') + '/v1/ws';
  ws = new WebSocket(url);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', role: 'device', deviceId: creds.deviceId, token: creds.deviceToken }));
  ws.onmessage = (e) => onSignal(JSON.parse(e.data));
  ws.onclose = (e) => log('signaling closed', e.code);
};

const sig = (m) => ws.send(JSON.stringify(m));

async function onSignal(m) {
  if (m.t !== 'signal') log('sig <-', m.t, m.reason ?? m.code ?? '');
  if (m.t === 'welcome') { if (m.hostOnline) sig({ t: 'session.request' }); }
  else if (m.t === 'session.created') sessionId = m.sessionId;
  else if (m.t === 'session.accept') startPc(m.iceServers);
  else if (m.t === 'signal') {
    const d = m.data;
    if (d.type === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      sig({ t: 'signal', sessionId, data: { type: 'answer', sdp: pc.localDescription.sdp } });
      if (!fp) fp = { hostFp: fingerprint(d.sdp), deviceFp: fingerprint(pc.localDescription.sdp) };
    } else if (d.type === 'candidate') {
      await pc.addIceCandidate(d.candidate).catch((e) => log('cand err', e.message));
    }
  }
}

function startPc(iceServers) {
  // every session has new DTLS certificates: never reuse fingerprints/nonces from a previous one
  fp = null;
  nonces = null;
  epoch = crypto.randomUUID();
  pc?.close();
  $('video').srcObject = null;
  pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = (e) => { if (e.candidate) sig({ t: 'signal', sessionId, data: { type: 'candidate', candidate: e.candidate.toJSON() } }); };
  pc.ontrack = (e) => {
    const v = $('video');
    if (!v.srcObject) v.srcObject = new MediaStream();
    v.srcObject.addTrack(e.track);
    log('track', e.track.kind);
  };
  pc.onconnectionstatechange = () => log('pc', pc.connectionState);
  pc.ondatachannel = (e) => {
    const dc = e.channel;
    if (dc.label === 'control') {
      control = dc;
      dc.onmessage = (ev) => onControl(JSON.parse(ev.data));
    }
  };
}

async function onControl(m) {
  if (m.t === 'status') { window.lastStatus = m; return; }
  if (m.t === 'ping') return control.send(JSON.stringify({ t: 'pong', id: m.id, hostTs: m.hostTs, ts: Date.now() }));
  log('ctl <-', m.t === 'auth.ok' ? { t: 'auth.ok', permissions: m.permissions, caps: m.capabilities.length } : m);
  if (m.t === 'auth.challenge') {
    nonces = { hostNonce: m.hostNonce, deviceNonce: b64url(crypto.getRandomValues(new Uint8Array(24))) };
    const t = transcript('device', { ...fp, ...nonces, sessionId, hostId: creds.hostId, deviceId: creds.deviceId });
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(t)));
    control.send(JSON.stringify({ t: 'auth.response', deviceNonce: nonces.deviceNonce, sig: b64(rawToDer(raw)) }));
  }
  if (m.t === 'auth.ok') {
    const hostKey = await crypto.subtle.importKey('spki', unb64(creds.hostPublicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const t = transcript('host', { ...fp, ...nonces, sessionId, hostId: creds.hostId, deviceId: creds.deviceId });
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, hostKey, derToRaw(unb64(m.sig)), new TextEncoder().encode(t));
    log('host signature valid:', ok);
    window.hostVerified = ok;
    control.send(JSON.stringify({ t: 'epoch', epoch }));
  }
}

function cmd(action, args = {}, id = crypto.randomUUID()) {
  control.send(JSON.stringify({ t: 'cmd', id, action, args }));
  log('cmd ->', action, id.slice(0, 8));
  return id;
}

document.querySelectorAll('[data-cmd]').forEach((b) => {
  b.onclick = () => cmd(b.dataset.cmd, b.dataset.frames ? { frames: Number(b.dataset.frames) } : {});
});
$('dup').onclick = () => { const id = cmd('save'); setTimeout(() => cmd('save', {}, id), 300); };
$('click').onclick = () => control.send(JSON.stringify({ t: 'ptr', id: 'p1', kind: 'click', x: 0.5, y: 0.5, epoch }));
$('unmute').onclick = () => { $('video').muted = false; };
$('stats').onclick = async () => {
  const r = await pc.getStats();
  r.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') log('video in', { w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, decoder: s.decoderImplementation, bytes: s.bytesReceived });
    if (s.type === 'candidate-pair' && s.nominated) log('rtt ms', Math.round((s.currentRoundTripTime ?? 0) * 1000));
  });
  if (window.lastStatus) log('host status', { premiere: window.lastStatus.premiere?.running, capture: window.lastStatus.capture, stream: window.lastStatus.stream });
};
