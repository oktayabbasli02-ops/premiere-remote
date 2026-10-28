/* global hostApi, qrcode */
// Companion status window: mirrors HostCore state; every control maps to one host action.

const $ = (id) => document.getElementById(id);
let state = null;
let settingsLoaded = false;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

const act = (name, args) => hostApi.action(name, args).catch((e) => alert(e.message));

function fmtCode(c) {
  return `${c.slice(0, 4)} ${c.slice(4)}`;
}

function render() {
  const s = state;
  if (!s) return;
  const badge = $('badge');
  badge.className = `badge ${s.session?.authed ? 'live' : s.remoteEnabled ? 'on' : 'off'}`;
  badge.textContent = s.session?.authed ? 'PHONE CONNECTED' : s.remoteEnabled ? 'ON' : 'OFF';

  $('toggle').textContent = s.remoteEnabled ? 'Stop remote access' : 'Enable remote access';
  $('toggle').className = s.remoteEnabled ? 'danger' : 'primary';
  $('sigState').textContent = s.remoteEnabled ? `Signaling: ${s.signaling}` : s.configured ? 'Disabled' : 'Set the signaling server URL below first.';
  $('newCode').classList.toggle('hidden', !s.remoteEnabled || !!s.pairing);

  const p = s.pairing;
  $('pairing').classList.toggle('hidden', !p);
  if (p) {
    $('code').textContent = fmtCode(p.code);
    const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
    $('codeExp').textContent = `Expires in ${left}s`;
    if ($('qr').dataset.code !== p.code) {
      const qr = qrcode(0, 'M');
      // https link: iPhone camera opens the web app; on Android the page offers the native app
      qr.addData(`${s.serverUrl}/app/#pair=${p.code}`);
      qr.make();
      $('qr').innerHTML = qr.createImgTag(4, 8);
      $('qr').dataset.code = p.code;
    }
  }

  const ap = $('approvals');
  ap.replaceChildren(...s.approvals.map((a) => {
    const title = a.kind === 'pairing' ? `New phone wants to pair: ${a.deviceName}` : `${a.deviceName} wants to connect`;
    const buttons = a.kind === 'pairing'
      ? [
        el('button', { class: 'ok', onclick: () => act('decide', { id: a.id, approve: true, control: true, unattended: $(`un-${a.id}`).checked }) }, 'Approve: view + control'),
        el('button', { onclick: () => act('decide', { id: a.id, approve: true, control: false, unattended: $(`un-${a.id}`).checked }) }, 'Approve: view only'),
        el('button', { class: 'danger', onclick: () => act('decide', { id: a.id, approve: false }) }, 'Reject'),
      ]
      : [
        el('button', { class: 'ok', onclick: () => act('decide', { id: a.id, approve: true }) }, 'Allow'),
        el('button', { class: 'danger', onclick: () => act('decide', { id: a.id, approve: false }) }, 'Deny'),
      ];
    const box = el('div', { class: 'approval' },
      el('div', {}, el('strong', {}, title)),
      el('div', {}, 'Check the phone shows the same key ID: ', el('span', { class: 'keyhash' }, a.keyHash)),
    );
    if (a.kind === 'pairing') {
      box.append(el('label', { class: 'check' }, el('input', { type: 'checkbox', id: `un-${a.id}` }), 'Trust for unattended access (no approval on each connect)'));
    }
    box.append(el('div', { class: 'buttons' }, ...buttons));
    return box;
  }));

  const ss = s.session;
  $('endSession').classList.toggle('hidden', !ss);
  if (!ss) $('session').textContent = 'No phone connected.';
  else {
    const st = ss.stats ?? {};
    $('session').replaceChildren(
      el('div', {}, `${ss.deviceName} — ${ss.authed ? 'streaming' : ss.state}${ss.canControl ? ' (control)' : ' (view only)'}`),
      el('div', { class: 'stats' }, [
        ss.capture ? `capture ${ss.capture.mode} ${ss.capture.width ?? '?'}×${ss.capture.height ?? '?'}` : '',
        st.frameWidth ? `sent ${st.frameWidth}×${st.frameHeight} @ ${Math.round(st.fps ?? 0)} fps` : '',
        st.videoBitrate ? `${(st.videoBitrate / 1e6).toFixed(2)} Mbit/s` : '',
        st.rttMs != null ? `network RTT ${st.rttMs} ms` : '',
        st.encoder ? `encoder ${st.encoder}${st.powerEfficientEncoder ? ' (HW)' : ''}` : '',
        st.relayed ? 'via TURN relay' : st.localCandidate ? `direct (${st.localCandidate}/${st.remoteCandidate})` : '',
        `profile ${ss.quality}`,
      ].filter(Boolean).join(' · ')),
    );
  }

  const pr = s.premiere;
  $('premiere').replaceChildren(el('div', {}, !pr ? '…' : [
    pr.running ? 'Premiere running' : 'Premiere NOT running',
    s.plugin.connected ? 'panel connected' : 'panel NOT connected (open Window › Extensions › Premiere Remote)',
    pr.project?.project ? `project “${pr.project.project.name}”` : '',
    pr.project?.sequence ? `sequence “${pr.project.sequence.name}”` : '',
    pr.modal ? 'MODAL DIALOG OPEN' : '',
    pr.locked ? 'WINDOWS LOCKED' : '',
  ].filter(Boolean).join(' · ')));

  $('devices').replaceChildren(...(s.devices.length ? s.devices.map((d) => el('div', { class: 'device' },
    el('div', {}, el('strong', {}, d.name), ' ', el('span', { class: 'muted' }, `${d.keyHash} · ${d.canControl ? 'control' : 'view only'}${d.unattended ? ' · unattended' : ''}`)),
    el('div', {},
      el('button', { onclick: () => act('updateDevice', { deviceId: d.deviceId, canControl: !d.canControl }) }, d.canControl ? 'Make view-only' : 'Allow control'),
      ' ',
      el('button', { onclick: () => act('updateDevice', { deviceId: d.deviceId, unattended: !d.unattended }) }, d.unattended ? 'Require approval' : 'Trust unattended'),
      ' ',
      el('button', { class: 'danger', onclick: () => { if (confirm(`Revoke ${d.name}? It will have to pair again.`)) act('revokeDevice', { deviceId: d.deviceId }); } }, 'Revoke'),
    ),
  )) : [el('div', { class: 'muted' }, 'No paired phones.')]));

  if (!settingsLoaded) {
    $('serverUrl').value = s.serverUrl ?? '';
    $('quality').value = s.settings.quality;
    $('captureMode').value = s.settings.captureMode;
    $('allowOutside').checked = s.settings.allowInputOutsidePremiere;
    $('saveReminder').value = s.settings.saveReminderMinutes;
    settingsLoaded = true;
  }

  $('warnings').replaceChildren(...s.warnings.map((w) => el('div', { class: 'card warn' }, w.msg)));
}

$('toggle').addEventListener('click', () => act(state?.remoteEnabled ? 'disableRemote' : 'enableRemote'));
$('newCode').addEventListener('click', () => act('newCode'));
$('cancelCode').addEventListener('click', () => act('cancelCode'));
$('endSession').addEventListener('click', () => act('endSession'));
$('openConfig').addEventListener('click', () => act('openConfigFolder'));
$('saveSettings').addEventListener('click', () => act('saveSettings', {
  serverUrl: $('serverUrl').value.trim(),
  registrationKey: $('registrationKey').value,
  quality: $('quality').value,
  captureMode: $('captureMode').value,
  allowInputOutsidePremiere: $('allowOutside').checked,
  saveReminderMinutes: Number($('saveReminder').value) || 0,
}).then(() => { $('registrationKey').value = ''; }));

hostApi.onState((s) => { state = s; render(); });
setInterval(render, 1000); // code countdown
hostApi.ready();
