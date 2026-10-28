// Premiere Remote web client (iPhone/iPad Safari, installable as a PWA).
import { publicKeySpki, keyHash, saveHost, listHosts, forgetHost } from './lib/identity.js';
import { RemoteController, Phase } from './lib/session.js';
import { RemoteSurface } from './lib/surface.js';
import { createJog } from './lib/jog.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

const screens = ['home', 'pair', 'session'];
function show(name) {
  for (const s of screens) $(s).classList.toggle('hidden', s !== name);
}

let controller = null;
let myKey = '';

// ------------------------------------------------------------------ startup
async function boot() {
  if (!window.isSecureContext || !crypto.subtle) {
    document.body.textContent = 'Premiere Remote needs HTTPS (secure context). Open it via https://';
    return;
  }
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  myKey = await keyHash(await publicKeySpki());
  $('homeKey').textContent = myKey;
  $('pairKey').textContent = myKey;
  $('devName').value = guessDeviceName();
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('installHint').classList.toggle('hidden', !!standalone);

  const m = location.hash.match(/pair=(\d{4}\s?\d{4})/);
  if (m) {
    const code = m[1].replace(/\s/g, '');
    $('code').value = code;
    history.replaceState(null, '', location.pathname + location.search); // keep the code out of history/bookmarks
    if (/Android/.test(navigator.userAgent)) {
      const b = $('openAndroid');
      b.classList.remove('hidden');
      b.onclick = () => { location.href = `premiereremote://pair?s=${encodeURIComponent(location.origin)}&c=${code}`; };
    }
    show('pair');
  } else if ((await listHosts()).length === 0) {
    show('pair');
  } else {
    await renderHome();
  }
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad (Safari)';
  if (/iPhone/.test(ua)) return 'iPhone (Safari)';
  if (/Android/.test(ua)) return 'Android (browser)';
  return 'Browser';
}

async function renderHome() {
  const hosts = await listHosts();
  $('hostList').replaceChildren(...hosts.map((h) => el('div', { className: 'card' },
    el('div', { className: 'name', textContent: h.hostName || 'PC' }),
    el('div', { className: 'muted', textContent: h.canControl ? 'view + control' : 'view only' }),
    el('div', { className: 'row' },
      el('button', { className: 'primary', textContent: 'Connect', onclick: () => startSession(h) }),
      el('button', { className: 'text', textContent: 'Forget', onclick: async () => { await forgetHost(h.hostId); renderHome(); } })),
  )));
  show('home');
}

$('toPair').onclick = () => show('pair');
$('cancelPair').onclick = async () => ((await listHosts()).length ? renderHome() : show('pair'));

// ------------------------------------------------------------------ pairing
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json = {};
  try { json = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: json };
}

$('code').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 8); });

$('doPair').onclick = async () => {
  const code = $('code').value.replace(/\D/g, '');
  const status = $('pairStatus');
  if (code.length !== 8) { status.textContent = 'Enter all 8 digits.'; return; }
  $('doPair').disabled = true;
  try {
    status.textContent = 'Sending code…';
    const claim = await post('/v1/pair/claim', { code, deviceName: $('devName').value.trim() || guessDeviceName(), devicePublicKey: await publicKeySpki() });
    if (claim.status === 404) { status.textContent = 'Code is wrong, expired or already used. Generate a new code on the PC.'; $('code').value = ''; return; }
    if (claim.status === 429) { status.textContent = `Too many attempts. Wait ${claim.body.retryAfterSec ?? 60} s.`; return; }
    if (claim.status !== 200) { status.textContent = `Server error (${claim.status})`; return; }
    status.textContent = 'Waiting for approval on the PC…';
    for (let i = 0; i < 16; i++) {
      const r = await post('/v1/pair/wait', claim.body);
      if (r.status !== 200) { status.textContent = 'Pairing request expired.'; return; }
      if (r.body.status === 'pending') continue;
      if (r.body.status !== 'approved') { status.textContent = r.body.reason === 'host_offline' ? 'The PC is offline.' : 'The PC owner rejected the request.'; return; }
      const b = r.body;
      await saveHost({ hostId: b.hostId, hostName: b.hostName, deviceId: b.deviceId, hostPublicKey: b.hostPublicKey, canControl: !!b.permissions?.control }, b.deviceToken);
      status.textContent = '';
      $('code').value = '';
      await renderHome();
      return;
    }
    status.textContent = 'No decision from the PC.';
  } catch (e) {
    status.textContent = `Cannot reach server: ${e.message}`;
  } finally {
    $('doPair').disabled = false;
  }
};

// ------------------------------------------------------------------ session
const surface = new RemoteSurface($('stage'), $('video'));
const jog = createJog($('jog'), (n) => controller?.command('stepFrames', `Jog ${n > 0 ? '+' : ''}${n}`, { frames: n }));
let showStats = false;
let precision = false;
let lastAckAt = 0;

const BUTTON_ROWS = [
  [['goToStart', '|◀'], ['stepFrames', '◀1', { frames: -1 }], ['playPause', '▶/❚❚'], ['stepFrames', '1▶', { frames: 1 }], ['goToEnd', '▶|']],
  [['setIn', 'In'], ['setOut', 'Out'], ['addMarker', 'Marker'], ['addEdit', 'Split'], ['selectClipAtPlayhead', 'Select']],
  [['deleteSelection', 'Lift (gap)'], ['rippleDeleteSelection', 'Ripple delete (hold)', {}, 'hold'], ['trimPrevToPlayhead', 'Trim ◀'], ['trimNextToPlayhead', 'Trim ▶']],
  [['zoomOut', 'Zoom −'], ['zoomIn', 'Zoom +'], ['undo', 'Undo'], ['redo', 'Redo'], ['save', 'Save']],
];

function renderButtons(state) {
  const caps = new Map(state.capabilities.map((c) => [c.action, c]));
  const live = state.phase === Phase.LIVE && state.canControl;
  const box = $('buttons');
  const key = JSON.stringify([state.capabilities, live]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const btns = [];
  for (const row of BUTTON_ROWS) {
    for (const [action, label, args = {}, kind] of row) {
      const c = caps.get(action);
      if (!c || c.impl === 'unsupported') continue; // never show a button backed by nothing
      const b = el('button', { textContent: label + (c.impl === 'keyboard' ? ' ⌨' : ''), disabled: !live });
      if (kind === 'hold') {
        b.className = 'danger';
        let t = null;
        const startHold = (e) => { e.preventDefault(); t = setTimeout(() => { t = null; navigator.vibrate?.(30); controller.command(action, 'Ripple delete', args); }, 600); };
        const cancel = () => { clearTimeout(t); t = null; };
        b.addEventListener('touchstart', startHold, { passive: false });
        b.addEventListener('mousedown', startHold);
        for (const ev of ['touchend', 'touchcancel', 'mouseup', 'mouseleave']) b.addEventListener(ev, cancel);
      } else {
        b.onclick = () => controller.command(action, label, args);
      }
      btns.push(b);
    }
  }
  if (caps.get('trackMute')?.impl === 'api') btns.push(el('button', { className: 'secondary', textContent: 'Mute…', disabled: !live, onclick: () => $('mute').classList.remove('hidden') }));
  btns.push(el('div', { className: 'note', textContent: '⌨ = sent as a keyboard shortcut (result may be unverifiable)' }));
  box.replaceChildren(...btns);
}

function chip(state) {
  const c = $('chip');
  const map = { LIVE: ['LIVE', 'live'], RECONNECTING: ['RECONNECTING', 'recon'], HOST_OFFLINE: ['PC OFFLINE', 'off'], REVOKED: ['REVOKED', 'bad'], SECURITY_ERROR: ['SECURITY', 'bad'], REJECTED: ['REJECTED', 'bad'] };
  const [label, cls] = map[state.phase] ?? ['CONNECTING', ''];
  c.textContent = label;
  c.className = `chip ${cls}`;
}

function render(state) {
  chip(state);
  $('title').textContent = state.hostView.sequenceName || controller.host.hostName || 'PC';
  $('overlay').textContent = state.phase === Phase.LIVE ? '' : (state.message || state.phase);
  surface.enabled = state.phase === Phase.LIVE && state.canControl;
  jog.setEnabled(surface.enabled && !!state.capabilities.find((c) => c.action === 'stepFrames'));
  renderButtons(state);

  const hv = state.hostView;
  const banners = [];
  if (state.phase === Phase.LIVE) {
    if (hv.premiereRunning === false) banners.push('Premiere is not running on the PC.');
    else if (hv.modal) banners.push("A dialog is open in Premiere. Switch capture to the whole display if you can't see it.");
    else if (!hv.foregroundIsPremiere && hv.foregroundTitle) banners.push(`Another window is in front: ${hv.foregroundTitle}`);
    if (hv.premiereRunning && !hv.pluginConnected) banners.push('Premiere panel not open on the PC: API commands unavailable.');
    if (hv.locked) banners.push('Windows is locked on the PC. Input is paused.');
    if (!state.canControl) banners.push('View-only access.');
  }
  banners.push(...state.notices);
  const nodes = banners.map((t) => el('div', { className: 'b', textContent: t }));
  if (state.notices.length) nodes.push(el('button', { textContent: 'Dismiss', onclick: () => controller.dismissNotices() }));
  $('banners').replaceChildren(...nodes);

  const s = state.stats;
  $('stats').classList.toggle('hidden', !showStats);
  if (showStats) {
    $('stats').textContent = [
      `Network RTT (ICE): ${s.rttMs ?? '—'} ms`,
      `App command RTT: ${state.appRttMs ?? '—'} ms (data channel + PC processing)`,
      'End-to-end (glass-to-glass): not measured automatically',
      `Video: ${s.width ?? '?'}×${s.height ?? '?'} @ ${s.fps != null ? Math.round(s.fps) : '?'} fps · ${s.bitrateKbps ?? '—'} kbit/s`,
      `Codec: ${s.codec ?? '?'} · decoder ${s.decoder ?? '?'} · PC encoder ${hv.hostEncoder ?? '?'}`,
      `Loss: ${s.packetsLost ?? 0} pkts · jitter ${s.jitterMs != null ? Math.round(s.jitterMs) : '—'} ms`,
      `Path: ${s.relayed ? 'TURN relay' : 'direct'} (${s.candidates ?? '?'})`,
      `Capture: ${hv.captureMode ?? '?'} ${hv.captureW ?? '?'}×${hv.captureH ?? '?'} · profile ${hv.quality ?? '?'}${hv.autoQuality ? ' (auto)' : ''}`,
    ].join('\n');
  }

  const a = state.lastAck;
  if (a && a.at !== lastAckAt) {
    lastAckAt = a.at;
    const box = $('ack');
    box.textContent = a.message;
    box.className = `ack ${a.status === 'ok' ? (a.verified ? 'ok' : 'sent') : 'err'}`;
    clearTimeout(box.timer);
    box.timer = setTimeout(() => box.classList.add('hidden'), 4000);
  }

  if ((state.phase === Phase.REVOKED || state.phase === Phase.SECURITY_ERROR) && !$('dialog').dataset.shown) {
    $('dialog').dataset.shown = '1';
    $('dialogText').textContent = state.message;
    $('dialog').classList.remove('hidden');
  }
}

async function startSession(host) {
  if (typeof RTCPeerConnection === 'undefined') {
    // e.g. WebKit builds without WebRTC, some in-app browsers: say so instead of failing silently
    $('dialog').dataset.shown = '1';
    $('dialogText').textContent = 'This browser does not support WebRTC, which is needed for the live view. Open the page in Safari (iPhone/iPad) or Chrome.';
    $('dialog').classList.remove('hidden');
    $('dialogOk').onclick = () => $('dialog').classList.add('hidden');
    return;
  }
  $('dialogOk').onclick = () => { $('dialog').classList.add('hidden'); endSession(); };
  show('session');
  $('dialog').dataset.shown = '';
  controller = new RemoteController(host, $('video'), render);
  surface.input = {
    move: (p) => controller.move(p.x, p.y),
    rel: (dx, dy) => controller.rel(dx, dy),
    ptr: (kind, p, button, dy) => controller.ptr(kind, p, button, dy),
  };
  if (new URLSearchParams(location.search).has('debug')) window.__pr = { controller, surface };
  await controller.start();
}

function endSession() {
  controller?.stop();
  controller = null;
  renderHome();
}

$('mode').onclick = () => { surface.trackpad = !surface.trackpad; $('mode').textContent = surface.trackpad ? 'Trackpad' : 'Touch'; };
$('statsBtn').onclick = () => { showStats = !showStats; if (controller) render(controller.state); };
$('precision').onclick = () => { precision = !precision; jog.setPrecision(precision); $('precision').textContent = precision ? 'Precision ✓' : 'Precision'; };
$('sound').onclick = () => { const v = $('video'); v.muted = !v.muted; v.play().catch(() => {}); $('sound').textContent = v.muted ? '🔇 Tap for sound' : '🔊 Sound on'; };
$('menuBtn').onclick = () => $('menu').classList.remove('hidden');
$('closeMenu').onclick = () => $('menu').classList.add('hidden');
document.querySelectorAll('[data-capture]').forEach((b) => { b.onclick = () => { controller?.setCapture(b.dataset.capture); $('menu').classList.add('hidden'); }; });
document.querySelectorAll('[data-quality]').forEach((b) => { b.onclick = () => { controller?.setQuality(b.dataset.quality); $('menu').classList.add('hidden'); }; });
$('resetZoom').onclick = () => { surface.resetZoom(); $('menu').classList.add('hidden'); };
$('toggleControls').onclick = () => {
  const hidden = $('controls').classList.toggle('hidden');
  $('toggleControls').textContent = hidden ? 'Show edit controls' : 'Hide edit controls';
  $('menu').classList.add('hidden');
};
$('openKeyboard').onclick = () => { $('menu').classList.add('hidden'); $('keyboard').classList.remove('hidden'); };
$('disconnect').onclick = () => { $('menu').classList.add('hidden'); endSession(); };
$('kbClose').onclick = () => $('keyboard').classList.add('hidden');
$('kbSend').onclick = () => { controller?.text($('kbText').value); $('kbText').value = ''; };
document.querySelectorAll('[data-combo]').forEach((b) => { b.onclick = () => controller?.key(b.dataset.combo); });

// track mute sheet
let muteKind = 'audio';
let muteIndex = 0;
function renderMute() {
  $('muteTracks').replaceChildren(...Array.from({ length: 8 }, (_, i) => el('button', {
    textContent: `${muteKind === 'audio' ? 'A' : 'V'}${i + 1}`, className: i === muteIndex ? 'on' : '', onclick: () => { muteIndex = i; renderMute(); },
  })));
  document.querySelectorAll('#muteKind button').forEach((b) => b.classList.toggle('on', b.dataset.kind === muteKind));
}
document.querySelectorAll('#muteKind button').forEach((b) => { b.onclick = () => { muteKind = b.dataset.kind; renderMute(); }; });
const sendMute = (mute) => {
  const name = `${muteKind === 'audio' ? 'A' : 'V'}${muteIndex + 1}`;
  controller?.command('trackMute', `${mute ? 'Mute' : 'Unmute'} ${name}`, { kind: muteKind, index: muteIndex, mute });
  $('mute').classList.add('hidden');
};
$('muteOn').onclick = () => sendMute(true);
$('muteOff').onclick = () => sendMute(false);
$('muteClose').onclick = () => $('mute').classList.add('hidden');
renderMute();

boot();
