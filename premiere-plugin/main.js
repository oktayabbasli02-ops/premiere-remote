/* global qrcode */
// Premiere Remote UXP panel.
//  1. UI for remote access (code, approvals, devices, stop) — mirrors the companion's state.
//  2. Executes Premiere operations through the DOCUMENTED UXP DOM API (premierepro module) on
//     request from the companion over a loopback WebSocket. No undocumented calls.
// Verified against @adobe/premierepro 26.5.0 type declarations; manifest minVersion 26.3.0
// (create*Action calls are wrapped in project.lockedAccess() as required since 26.3).

const ppro = require('premierepro');
const { storage } = require('uxp');

const COMPANION_URL = 'ws://127.0.0.1:47631';
const TOKEN_KEY = 'premiereRemote.pluginToken';
const PLUGIN_VERSION = '0.1.0';

let ws = null;
let state = null;
let reconnectDelay = 1000;

// ------------------------------------------------------------------ helpers
function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function bytesToString(b) {
  if (!b) return '';
  if (typeof b === 'string') return b;
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

async function loadToken() {
  try {
    return bytesToString(await storage.secureStorage.getItem(TOKEN_KEY));
  } catch (e) {
    return '';
  }
}

async function saveToken(t) {
  await storage.secureStorage.setItem(TOKEN_KEY, t);
}

const tickInfo = (t) => (t ? { seconds: t.seconds, ticks: t.ticks } : null);

async function context(expect) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw fail('no_project', 'No project is open in Premiere.');
  const sequence = await project.getActiveSequence();
  if (!sequence) throw fail('no_sequence', 'No active sequence. Open a sequence in the Timeline.');
  if (expect && expect.sequenceGuid && sequence.guid.toString() !== expect.sequenceGuid) {
    throw fail('sequence_changed', `The active sequence is now "${sequence.name}". Refresh on the phone before editing.`);
  }
  return { project, sequence };
}

/** Undoable edit: actions are created and executed inside lockedAccess, as required since 26.3. */
function transact(project, label, build) {
  let ok = false;
  let buildError = null;
  project.lockedAccess(() => {
    ok = project.executeTransaction((compound) => {
      try {
        build(compound);
      } catch (e) {
        buildError = e;
      }
    }, label);
  });
  if (buildError) throw buildError;
  if (!ok) throw fail('edit_failed', `Premiere rejected "${label}".`);
}

async function frameRate(sequence) {
  const settings = await sequence.getSettings();
  return settings.getVideoFrameRate();
}

async function readPosition(sequence) {
  return sequence.getPlayerPosition();
}

async function movePlayhead(sequence, target) {
  const ok = await sequence.setPlayerPosition(target);
  if (!ok) throw fail('edit_failed', 'Premiere refused to move the playhead.');
  const after = await readPosition(sequence);
  return { position: tickInfo(after) };
}

// ------------------------------------------------------------------ operations (names = command catalogue actions)
const ops = {
  async status() {
    const project = await ppro.Project.getActiveProject();
    if (!project) return { project: null, sequence: null };
    const out = { project: { name: project.name, path: project.path, guid: project.guid.toString() }, sequence: null };
    const sequence = await project.getActiveSequence();
    if (sequence) {
      const [pos, end, fr] = await Promise.all([readPosition(sequence), sequence.getEndTime(), frameRate(sequence)]);
      out.sequence = { name: sequence.name, guid: sequence.guid.toString(), position: tickInfo(pos), end: tickInfo(end), fps: fr ? fr.value : null };
    }
    return out;
  },

  async playerPosition() {
    const { sequence } = await context();
    return tickInfo(await readPosition(sequence));
  },

  async stepFrames({ frames, expect }) {
    const { sequence } = await context(expect);
    const fr = await frameRate(sequence);
    const pos = await readPosition(sequence);
    const delta = ppro.TickTime.createWithFrameAndFrameRate(Math.abs(frames), fr);
    let next = frames > 0 ? pos.add(delta) : pos.subtract(delta);
    const end = await sequence.getEndTime();
    if (next.ticksNumber < 0) next = ppro.TickTime.TIME_ZERO;
    if (next.ticksNumber > end.ticksNumber) next = end;
    return movePlayhead(sequence, next.alignToNearestFrame(fr));
  },

  async goToStart({ expect }) {
    const { sequence } = await context(expect);
    return movePlayhead(sequence, ppro.TickTime.TIME_ZERO);
  },

  async goToEnd({ expect }) {
    const { sequence } = await context(expect);
    return movePlayhead(sequence, await sequence.getEndTime());
  },

  async setIn({ expect }) {
    const { project, sequence } = await context(expect);
    const pos = await readPosition(sequence);
    transact(project, 'Remote: Set In', (c) => c.addAction(sequence.createSetInPointAction(pos)));
    return { inPoint: tickInfo(await sequence.getInPoint()) };
  },

  async setOut({ expect }) {
    const { project, sequence } = await context(expect);
    const pos = await readPosition(sequence);
    transact(project, 'Remote: Set Out', (c) => c.addAction(sequence.createSetOutPointAction(pos)));
    return { outPoint: tickInfo(await sequence.getOutPoint()) };
  },

  async addMarker({ name, expect }) {
    const { project, sequence } = await context(expect);
    const pos = await readPosition(sequence);
    const markers = await ppro.Markers.getMarkers(sequence);
    const label = typeof name === 'string' && name ? name.slice(0, 64) : 'Remote marker';
    transact(project, 'Remote: Add Marker', (c) => c.addAction(markers.createAddMarkerAction(label, ppro.Marker.MARKER_TYPE_COMMENT, pos, ppro.TickTime.TIME_ZERO, '')));
    return { at: tickInfo(pos) };
  },

  async deleteSelection({ expect }) {
    return removeSelection(false, expect);
  },

  async rippleDeleteSelection({ expect }) {
    return removeSelection(true, expect);
  },

  async save() {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw fail('no_project', 'No project is open.');
    const ok = await project.save();
    if (!ok) throw fail('save_failed', 'Premiere reported that the project was not saved.');
    return { saved: true, name: project.name };
  },

  async trackMute({ kind, index, mute, expect }) {
    const { sequence } = await context(expect);
    const count = kind === 'audio' ? await sequence.getAudioTrackCount() : await sequence.getVideoTrackCount();
    if (index >= count) throw fail('bad_request', `Track ${index + 1} does not exist.`);
    const track = kind === 'audio' ? await sequence.getAudioTrack(index) : await sequence.getVideoTrack(index);
    await track.setMute(mute);
    const now = await track.isMuted();
    if (now !== mute) throw fail('edit_failed', 'Premiere did not change the mute state.');
    return { kind, index, muted: now };
  },

  /** Used by the companion to verify keyboard-driven edits (e.g. Add Edit). */
  async countTrackItems() {
    const { sequence } = await context();
    const CLIP = ppro.Constants.TrackItemType.CLIP;
    let total = 0;
    const v = await sequence.getVideoTrackCount();
    for (let i = 0; i < v; i++) total += (await sequence.getVideoTrack(i)).getTrackItems(CLIP, false).length;
    const a = await sequence.getAudioTrackCount();
    for (let i = 0; i < a; i++) total += (await sequence.getAudioTrack(i)).getTrackItems(CLIP, false).length;
    return { total };
  },
};

async function removeSelection(ripple, expect) {
  const { project, sequence } = await context(expect);
  const selection = await sequence.getSelection();
  const items = await selection.getTrackItems();
  if (!items || items.length === 0) throw fail('no_selection', 'No clips are selected in the timeline.');
  const editor = ppro.SequenceEditor.getEditor(sequence);
  transact(project, ripple ? 'Remote: Ripple Delete' : 'Remote: Delete', (c) => c.addAction(editor.createRemoveItemsAction(selection, ripple, ppro.Constants.MediaType.ANY)));
  return { removed: items.length, ripple };
}

// ------------------------------------------------------------------ companion connection
async function connect() {
  setBanner('warn', 'Connecting to the Premiere Remote companion…');
  const token = await loadToken();
  let sock;
  try {
    sock = new WebSocket(COMPANION_URL);
  } catch (e) {
    // typically a missing network permission in manifest.json — show it instead of hiding it
    return scheduleReconnect(`Cannot open ${COMPANION_URL}: ${e.message || e}`);
  }
  ws = sock;
  sock.onopen = () => {
    reconnectDelay = 1000;
    sock.send(JSON.stringify({ t: 'hello', pluginVersion: PLUGIN_VERSION, pluginToken: token || undefined }));
    setBanner('warn', 'Waiting for approval in the companion window…');
  };
  sock.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.t === 'welcome') {
      if (msg.pluginToken) await saveToken(msg.pluginToken);
      setBanner('ok', 'Connected to companion');
    } else if (msg.t === 'denied') {
      setBanner('warn', `Companion refused the panel: ${msg.reason}`);
    } else if (msg.t === 'state') {
      state = msg.state;
      render();
    } else if (msg.t === 'req') {
      handleRequest(sock, msg);
    }
  };
  let lastError = '';
  sock.onclose = (ev) => {
    if (ws === sock) ws = null;
    state = null;
    render();
    scheduleReconnect(lastError || (ev && ev.code ? `connection closed (${ev.code})` : ''));
  };
  sock.onerror = (/** @type {any} */ ev) => {
    lastError = (ev && (ev.message || (ev.error && ev.error.message))) || 'connection error';
  };
  return undefined;
}

function scheduleReconnect(detail) {
  setBanner('warn', `Companion not reachable. Start "Premiere Remote" on this PC.${detail ? ` (${detail})` : ''}`);
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

async function handleRequest(sock, msg) {
  const op = ops[msg.op];
  const reply = (body) => { if (sock.readyState === 1) sock.send(JSON.stringify(Object.assign({ t: 'res', id: msg.id }, body))); };
  if (!op) return reply({ ok: false, error: { code: 'unsupported', message: `Unknown operation ${msg.op}` } });
  try {
    const result = await op(msg.args || {});
    return reply({ ok: true, result });
  } catch (e) {
    return reply({ ok: false, error: { code: e.code || 'premiere_error', message: e.message || String(e) } });
  }
}

function ui(action, args) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ui', action, args: args || {} }));
}

// ------------------------------------------------------------------ rendering
const $ = (id) => document.getElementById(id);

function setBanner(kind, text) {
  const b = $('conn');
  b.className = `banner ${kind}`;
  b.textContent = text;
}

function button(label, variant, onClick) {
  const b = document.createElement('sp-button');
  b.setAttribute('variant', variant);
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function div(cls, text) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderQr(text) {
  const box = $('qr');
  if (box.dataset.text === text) return;
  box.dataset.text = text;
  clear(box);
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  for (let r = 0; r < n; r++) {
    const row = div('qrrow');
    for (let c = 0; c < n; c++) row.appendChild(div(q.isDark(r, c) ? 'qrcell d' : 'qrcell'));
    box.appendChild(row);
  }
}

function render() {
  const s = state;
  if (!s) {
    $('sig').textContent = '—';
    return;
  }
  if (s.session && s.session.authed) setBanner('live', `● ${s.session.deviceName} is connected${s.session.canControl ? ' and can control Premiere' : ' (view only)'}`);
  else if (s.remoteEnabled) setBanner('ok', 'Remote access is ON');
  else setBanner('ok', 'Connected to companion · remote access is off');

  $('toggle').textContent = s.remoteEnabled ? 'Stop remote access' : 'Enable remote access';
  $('toggle').setAttribute('variant', s.remoteEnabled ? 'warning' : 'cta');
  $('sig').textContent = !s.configured ? 'Set the server URL in the companion window first.' : s.remoteEnabled ? `Signaling: ${s.signaling}` : 'Off';
  $('newCode').classList.toggle('hidden', !s.remoteEnabled || !!s.pairing);

  const p = s.pairing;
  $('pairing').classList.toggle('hidden', !p);
  if (p) {
    $('code').textContent = `${p.code.slice(0, 4)} ${p.code.slice(4)}`;
    $('exp').textContent = `Expires in ${Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000))} s · single use`;
    // https link: iPhone camera opens the web app; on Android the page offers the native app
    renderQr(`${s.serverUrl}/app/#pair=${p.code}`);
  }

  const ap = $('approvals');
  clear(ap);
  for (const a of s.approvals) {
    const box = div('approval');
    box.appendChild(div('', a.kind === 'pairing' ? `New phone wants to pair: ${a.deviceName}` : `${a.deviceName} wants to connect`));
    box.appendChild(div('muted', `Key ID shown on the phone must be: ${a.keyHash}`));
    const btns = div('buttons');
    if (a.kind === 'pairing') {
      const chk = /** @type {any} */ (document.createElement('sp-checkbox'));
      chk.textContent = 'Trust for unattended access';
      box.appendChild(chk);
      btns.appendChild(button('Approve: control', 'cta', () => ui('decide', { id: a.id, approve: true, control: true, unattended: !!chk.checked })));
      btns.appendChild(button('View only', 'secondary', () => ui('decide', { id: a.id, approve: true, control: false, unattended: !!chk.checked })));
      btns.appendChild(button('Reject', 'warning', () => ui('decide', { id: a.id, approve: false })));
    } else {
      btns.appendChild(button('Allow', 'cta', () => ui('decide', { id: a.id, approve: true })));
      btns.appendChild(button('Deny', 'warning', () => ui('decide', { id: a.id, approve: false })));
    }
    box.appendChild(btns);
    ap.appendChild(box);
  }

  const ss = s.session;
  $('disconnect').classList.toggle('hidden', !ss);
  if (!ss) $('session').textContent = 'No phone connected.';
  else {
    const st = ss.stats || {};
    const parts = [`${ss.deviceName}: ${ss.authed ? 'streaming' : ss.state}`];
    if (st.frameWidth) parts.push(`${st.frameWidth}×${st.frameHeight} @ ${Math.round(st.fps || 0)} fps`);
    if (st.rttMs != null) parts.push(`RTT ${st.rttMs} ms`);
    if (st.relayed) parts.push('TURN relay');
    $('session').textContent = parts.join(' · ');
  }

  const dv = $('devices');
  clear(dv);
  if (!s.devices.length) dv.textContent = 'No paired phones.';
  for (const d of s.devices) {
    const row = div('device');
    row.appendChild(div('', `${d.name} (${d.keyHash}) · ${d.canControl ? 'control' : 'view only'}${d.unattended ? ' · unattended' : ''}`));
    const btns = div('buttons');
    btns.appendChild(button(d.canControl ? 'View only' : 'Allow control', 'secondary', () => ui('updateDevice', { deviceId: d.deviceId, canControl: !d.canControl })));
    btns.appendChild(button(d.unattended ? 'Require approval' : 'Unattended', 'secondary', () => ui('updateDevice', { deviceId: d.deviceId, unattended: !d.unattended })));
    btns.appendChild(button('Revoke', 'warning', () => ui('revokeDevice', { deviceId: d.deviceId })));
    row.appendChild(btns);
    dv.appendChild(row);
  }

  const wn = $('warnings');
  clear(wn);
  for (const w of s.warnings || []) wn.appendChild(div('banner warn', w.msg));
}

$('toggle').addEventListener('click', () => ui(state && state.remoteEnabled ? 'disableRemote' : 'enableRemote'));
$('newCode').addEventListener('click', () => ui('newCode'));
$('hideCode').addEventListener('click', () => ui('cancelCode'));
$('disconnect').addEventListener('click', () => ui('endSession'));
setInterval(() => { if (state && state.pairing) render(); }, 1000);

connect();
