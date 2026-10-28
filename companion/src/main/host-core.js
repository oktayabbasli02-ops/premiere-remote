// Host orchestrator: remote-access state, pairing, approvals, trusted devices, sessions,
// capture-source selection and status. Both the companion window and the Premiere panel are
// views onto `this.state`; either can approve/deny.

import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { Sig, Ctl, ErrorCode, QualityProfiles, DEFAULT_QUALITY, parseMessage } from '@premiere-remote/shared/protocol';
import { CommandJournal } from '@premiere-remote/shared/journal';
import { generateIdentityKey, extractFingerprint } from '@premiere-remote/shared/auth';
import { SignalingClient, registerHost } from './signaling.js';
import { RemoteSession } from './session.js';

const APPROVAL_TIMEOUT_MS = 90_000;

export function keyHash(spkiB64) {
  const h = createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
}

export class HostCore extends EventEmitter {
  /**
   * @param {{vault:any, settings:any, saveSettings:(s:any)=>void, profile:()=>any, desktop:any, plugin:any,
   *          executor:any, engine:any, capture:any, log:any, power:any}} deps
   */
  constructor(deps) {
    super();
    Object.assign(this, deps);
    this.journal = new CommandJournal();
    this.signaling = null;
    this.remoteEnabled = false;
    this.pairingCode = null;
    this.approvals = new Map(); // id -> {kind, ..., resolve}
    this.pendingPairings = new Map(); // pairingId -> {deviceName, devicePublicKey, control, unattended}
    this.session = null; // { id, deviceId, rs: RemoteSession, state, capture, stats, startedAt }
    this.lastSaveAt = null;
    this.premiereStatus = null;
    this.warnings = [];
  }

  // ------------------------------------------------------------------ state for UIs
  snapshotState() {
    const v = this.vault.data;
    const s = this.session;
    return {
      remoteEnabled: this.remoteEnabled,
      signaling: this.signaling?.state ?? 'offline',
      serverUrl: this.settings.serverUrl,
      configured: !!this.settings.serverUrl,
      pairing: this.pairingCode,
      approvals: [...this.approvals.values()].map(({ resolve, timer, ...a }) => a),
      devices: v.devices.map((d) => ({ deviceId: d.deviceId, name: d.name, canControl: d.canControl, unattended: d.unattended, pairedAt: d.pairedAt, lastSeen: d.lastSeen, keyHash: keyHash(d.publicKey) })),
      session: s ? {
        id: s.id, deviceId: s.deviceId, deviceName: this.vault.device(s.deviceId)?.name ?? '?', state: s.state, authed: s.rs?.authed ?? false,
        canControl: s.rs?.canControl ?? false, capture: s.capture ? { mode: s.capture.mode, width: s.capture.width, height: s.capture.height, title: s.capture.title } : null,
        stats: s.stats ?? null, quality: s.quality,
      } : null,
      premiere: this.premiereStatus,
      plugin: { connected: this.plugin.connected },
      settings: { quality: this.settings.quality, captureMode: this.settings.captureMode, allowInputOutsidePremiere: this.settings.allowInputOutsidePremiere, saveReminderMinutes: this.settings.saveReminderMinutes },
      warnings: this.warnings,
      profile: this.profile().name,
    };
  }

  changed() {
    const st = this.snapshotState();
    this.plugin.pushState(st);
    this.emit('state', st);
  }

  // ------------------------------------------------------------------ remote access on/off
  async ensureRegistered() {
    const v = this.vault.data;
    if (!v.hostKey) this.vault.update((d) => { d.hostKey = generateIdentityKey(); });
    if (v.hostId && v.hostToken && v.serverUrl === this.settings.serverUrl) return;
    const reg = await registerHost(this.settings.serverUrl, os.hostname(), this.settings.registrationKey || undefined);
    this.vault.update((d) => {
      d.hostId = reg.hostId;
      d.hostToken = reg.hostToken;
      d.serverUrl = this.settings.serverUrl;
      d.devices = []; // devices are bound to a server registration
    });
    this.log.info('registered with signaling server', { hostId: reg.hostId });
  }

  async enableRemote() {
    if (this.remoteEnabled) return;
    if (!this.settings.serverUrl) throw new Error('Set the signaling server URL in the companion first.');
    await this.ensureRegistered();
    const v = this.vault.data;
    this.signaling = new SignalingClient({ baseUrl: this.settings.serverUrl, hostId: v.hostId, hostToken: v.hostToken, log: this.log });
    this.signaling.on('state', (st) => {
      if (st === 'online') {
        this.signaling.send({ t: Sig.DEVICES_SYNC, deviceIds: this.vault.data.devices.map((d) => d.deviceId) });
        if (this.wantCode) this.signaling.send({ t: Sig.PAIRING_CREATE });
      }
      this.changed();
    });
    this.signaling.on('authFailed', () => {
      // host credentials were rejected (server reset?) -> re-register on next enable
      this.vault.update((d) => { d.hostToken = null; });
      this.warn('The signaling server rejected this PC. Disable and enable remote access to re-register (phones must pair again).');
    });
    this.signaling.on('message', (m) => this.onSignal(m));
    this.remoteEnabled = true;
    this.wantCode = this.vault.data.devices.length === 0; // first run: show a code right away
    this.signaling.start();
    if (this.settings.preventSleepWhileEnabled) this.power.preventSleep(true);
    this.log.info('remote access enabled');
    this.changed();
  }

  disableRemote(reason = 'disabled_on_host') {
    this.endSession(reason);
    this.signaling?.stop();
    this.signaling = null;
    this.remoteEnabled = false;
    this.pairingCode = null;
    this.wantCode = false;
    for (const a of this.approvals.values()) a.resolve(false);
    this.approvals.clear();
    this.power.preventSleep(false);
    this.log.info('remote access disabled');
    this.changed();
  }

  newPairingCode() {
    if (!this.remoteEnabled) throw new Error('Enable remote access first.');
    this.wantCode = true;
    this.signaling.send({ t: Sig.PAIRING_CREATE });
  }

  cancelPairingCode() {
    this.wantCode = false;
    this.pairingCode = null;
    this.signaling?.send({ t: Sig.PAIRING_CANCEL });
    this.changed();
  }

  // ------------------------------------------------------------------ approvals
  requestApproval(entry) {
    return new Promise((resolve) => {
      const id = entry.id;
      const timer = setTimeout(() => this.decide(id, { approve: false, reason: 'timeout' }), APPROVAL_TIMEOUT_MS);
      this.approvals.set(id, { ...entry, expiresAt: Date.now() + APPROVAL_TIMEOUT_MS, resolve, timer });
      this.emit('attention', entry);
      this.changed();
    });
  }

  /** Called from the companion window or the Premiere panel. */
  decide(id, decision) {
    const a = this.approvals.get(id);
    if (!a) return false;
    clearTimeout(a.timer);
    this.approvals.delete(id);
    a.resolve(decision);
    this.changed();
    return true;
  }

  // ------------------------------------------------------------------ signaling messages
  async onSignal(m) {
    switch (m.t) {
      case Sig.PAIRING_CODE:
        this.pairingCode = { code: m.code, expiresAt: Date.now() + (m.ttlMs ?? 120_000) };
        clearTimeout(this.codeTimer);
        this.codeTimer = setTimeout(() => { this.pairingCode = null; this.wantCode = false; this.changed(); }, m.ttlMs ?? 120_000);
        return this.changed();
      case Sig.PAIRING_REQUEST:
        return this.onPairingRequest(m);
      case Sig.PAIRING_COMPLETED: {
        const p = this.pendingPairings.get(m.pairingId);
        if (!p) return undefined;
        this.pendingPairings.delete(m.pairingId);
        this.vault.update((d) => {
          d.devices.push({ deviceId: m.deviceId, name: p.deviceName, publicKey: p.devicePublicKey, canControl: p.control, unattended: p.unattended, pairedAt: Date.now(), lastSeen: null });
        });
        this.log.info('device paired', { deviceId: m.deviceId });
        return this.changed();
      }
      case Sig.DEVICE_REVOKED:
        return this.changed();
      case Sig.SESSION_REQUEST:
        return this.onSessionRequest(m);
      case Sig.SIGNAL:
        if (this.session?.id === m.sessionId) {
          this.engine.signal(m.sessionId, m.data);
          if (m.data?.type === 'answer') this.session.remoteSdp = m.data.sdp;
          this.tryFingerprints();
        }
        return undefined;
      case Sig.SESSION_END:
        if (this.session?.id === m.sessionId) this.endSession(m.reason ?? 'ended_by_peer', false);
        return undefined;
      case Sig.ERROR:
        this.log.warn('signaling error', { code: m.code });
        return undefined;
      default:
        return undefined;
    }
  }

  async onPairingRequest(m) {
    // the code was consumed; the panel/companion should no longer show it
    this.pairingCode = null;
    this.wantCode = false;
    const decision = await this.requestApproval({ kind: 'pairing', id: m.pairingId, deviceName: m.deviceName, keyHash: keyHash(m.devicePublicKey) });
    if (!decision?.approve) {
      this.signaling?.send({ t: Sig.PAIRING_DECISION, pairingId: m.pairingId, approve: false });
      return;
    }
    this.pendingPairings.set(m.pairingId, { deviceName: m.deviceName, devicePublicKey: m.devicePublicKey, control: decision.control !== false, unattended: decision.unattended === true });
    this.signaling?.send({
      t: Sig.PAIRING_DECISION, pairingId: m.pairingId, approve: true, hostName: os.hostname(),
      hostPublicKey: this.vault.data.hostKey.publicKeySpki, permissions: { control: decision.control !== false },
    });
  }

  async onSessionRequest(m) {
    const reject = (reason) => this.signaling?.send({ t: Sig.SESSION_REJECT, sessionId: m.sessionId, reason });
    const device = this.vault.device(m.deviceId);
    if (!device) return reject(ErrorCode.UNAUTHORIZED); // revoked locally: host is the source of truth
    if (this.session && this.session.deviceId !== m.deviceId) return reject('busy');
    if (!device.unattended) {
      const d = await this.requestApproval({ kind: 'session', id: m.sessionId, deviceName: device.name, keyHash: keyHash(device.publicKey) });
      if (!d?.approve) return reject(ErrorCode.HOST_REJECTED);
    }
    if (!this.remoteEnabled) return undefined;
    if (this.session) this.endSession('superseded');
    this.vault.update((x) => { const dd = x.devices.find((y) => y.deviceId === device.deviceId); if (dd) dd.lastSeen = Date.now(); });
    this.startSession(m.sessionId, device, m.iceServers ?? []);
    this.signaling.send({ t: Sig.SESSION_ACCEPT, sessionId: m.sessionId });
    return undefined;
  }

  // ------------------------------------------------------------------ sessions
  startSession(sessionId, device, iceServers) {
    const quality = this.settings.quality === 'auto' ? DEFAULT_QUALITY : this.settings.quality;
    const s = { id: sessionId, deviceId: device.deviceId, state: 'connecting', capture: null, stats: null, quality, auto: this.settings.quality === 'auto', startedAt: Date.now() };
    this.session = s;
    s.rs = new RemoteSession({
      sessionId,
      hostId: this.vault.data.hostId,
      device,
      hostKey: this.vault.data.hostKey,
      send: (channel, msg) => this.engine.dcSend(sessionId, channel, msg),
      end: (reason) => this.endSession(reason),
      onAuthed: () => {
        s.state = 'streaming';
        this.engine.enableMedia(sessionId);
        this.changed();
      },
      executor: this.executor,
      desktop: this.desktop,
      journal: this.journal,
      getCapture: () => this.session?.capture ?? null,
      getSettings: () => this.settings,
      getProfile: () => this.profile(),
      onHostRequest: (req) => this.onSessionRequestFromPhone(req),
      log: this.log,
    });
    this.selectCaptureSource(this.settings.captureMode);
    this.engine.start(sessionId, { iceServers, quality: QualityProfiles[quality] });
    this.log.info('session started', { deviceId: device.deviceId });
    this.changed();
  }

  tryFingerprints() {
    const s = this.session;
    if (!s || !s.localSdp || !s.remoteSdp || s.fpSet) return;
    const host = extractFingerprint(s.localSdp);
    const device = extractFingerprint(s.remoteSdp);
    if (!host || !device) {
      this.log.warn('missing DTLS fingerprint in SDP');
      this.endSession('bad_sdp');
      return;
    }
    s.fpSet = true;
    s.rs.setFingerprints({ host, device });
  }

  endSession(reason, notifyServer = true) {
    const s = this.session;
    if (!s) return;
    this.session = null;
    s.rs?.close();
    this.engine.stop(s.id);
    if (notifyServer) this.signaling?.send({ t: Sig.SESSION_END, sessionId: s.id, reason });
    this.log.info('session ended', { reason });
    this.changed();
  }

  onSessionRequestFromPhone(req) {
    const s = this.session;
    if (!s) return;
    if (req.t === Ctl.CAPTURE_SET && (req.mode === 'window' || req.mode === 'display')) {
      this.selectCaptureSource(req.mode, req.displayId);
      this.engine.switchSource(s.id);
    }
    if (req.t === Ctl.QUALITY_SET) {
      if (req.profile === 'auto') { s.auto = true; return; }
      if (QualityProfiles[req.profile]) {
        s.auto = false;
        this.setQuality(req.profile);
      }
    }
  }

  setQuality(profileId) {
    const s = this.session;
    if (!s || s.quality === profileId) return;
    s.quality = profileId;
    this.engine.setQuality(s.id, QualityProfiles[profileId]);
    this.changed();
  }

  /** Decides which desktopCapturer source the engine's getDisplayMedia call receives. */
  selectCaptureSource(mode, displayId) {
    const s = this.session;
    if (!s) return;
    if (mode === 'window') {
      const main = this.desktop.premiereMain();
      if (!main) {
        s.rs?.notice(ErrorCode.PREMIERE_NOT_RUNNING, 'Premiere window not found; streaming the display instead.');
        return this.selectCaptureSource('display', displayId);
      }
      s.capture = { mode: 'window', hwnd: main.hwnd, sourceId: `window:${main.hwnd}:0`, rect: main.rect, title: main.title };
    } else {
      const d = this.capture.displayFor(displayId ?? this.premiereDisplayId());
      s.capture = { mode: 'display', displayId: d.id, sourceId: null, rect: d.physicalRect, title: d.label };
    }
    this.capture.setPending(s.capture);
    return undefined;
  }

  premiereDisplayId() {
    const main = this.desktop.premiereMain();
    return main ? this.capture.displayIdForPhysicalRect(main.rect) : null;
  }

  // ------------------------------------------------------------------ engine events
  onEngine(evt, p) {
    const s = this.session;
    if (!s || p.sessionId !== s.id) return;
    switch (evt) {
      case 'signal':
        if (p.data?.type === 'offer') s.localSdp = p.data.sdp;
        this.signaling?.send({ t: Sig.SIGNAL, sessionId: s.id, data: p.data });
        this.tryFingerprints();
        break;
      case 'dc-open':
        if (p.channel === 'control') s.rs.onControlOpen();
        break;
      case 'dc-message': {
        const msg = parseMessage(p.msg);
        if (!msg) break;
        if (p.channel === 'control') s.rs.onControl(msg); else s.rs.onPointer(msg);
        break;
      }
      case 'state':
        s.pcState = p.state;
        if (p.state === 'failed') s.rs.notice('network', 'Connection lost; trying to restore…');
        if (p.state === 'closed') this.endSession('peer_closed');
        this.changed();
        break;
      case 'capture':
        if (s.capture) { s.capture.width = p.width; s.capture.height = p.height; }
        this.checkCaptureAspect();
        this.changed();
        break;
      case 'stats':
        s.stats = p.stats;
        this.autoQuality(p.stats);
        break;
      case 'error':
        this.log.error('engine error', { err: p.message });
        s.rs.notice('capture', p.message);
        break;
      default:
        break;
    }
  }

  /** Warn if the captured frame's aspect does not match the rect we map input into. */
  checkCaptureAspect() {
    const c = this.session?.capture;
    if (!c?.rect || !c.width || !c.height) return;
    const a = c.width / c.height;
    const b = c.rect.width / c.rect.height;
    if (Math.abs(a - b) / b > 0.02) {
      this.session.rs.notice('mapping', 'Captured frame and window bounds differ; clicks may be offset. Switch to display capture for exact mapping.');
      this.log.warn('capture aspect mismatch', { frame: `${c.width}x${c.height}`, rect: `${c.rect.width}x${c.rect.height}` });
    }
  }

  /** Simple profile ladder on top of WebRTC's own congestion control. */
  autoQuality(st) {
    const s = this.session;
    if (!s?.auto || !st) return;
    const now = Date.now();
    const avail = st.availableOutgoingBitrate ?? null;
    if (avail === null) return;
    const order = ['saver', 'responsive', 'balanced'];
    const i = order.indexOf(s.quality);
    s.autoHist = (s.autoHist ?? []).filter((x) => now - x.t < 12_000);
    s.autoHist.push({ t: now, avail, limited: st.qualityLimitationReason });
    if (s.autoHist.length < 5 || now - (s.lastAutoSwitch ?? 0) < 15_000) return;
    const min = Math.min(...s.autoHist.map((x) => x.avail));
    const cur = QualityProfiles[s.quality];
    if (i > 0 && min < cur.maxBitrate * 0.5) {
      s.lastAutoSwitch = now;
      this.setQuality(order[i - 1]);
    } else if (i >= 0 && i < order.length - 1 && min > QualityProfiles[order[i + 1]].maxBitrate * 1.3 && !s.autoHist.some((x) => x.limited === 'cpu')) {
      s.lastAutoSwitch = now;
      this.setQuality(order[i + 1]);
    }
  }

  // ------------------------------------------------------------------ devices
  revokeDevice(deviceId) {
    if (this.session?.deviceId === deviceId) this.endSession('revoked');
    this.vault.update((d) => { d.devices = d.devices.filter((x) => x.deviceId !== deviceId); });
    this.journal.forgetDevice(deviceId);
    this.signaling?.send({ t: Sig.DEVICE_REVOKE, deviceId });
    this.log.info('device revoked locally', { deviceId });
    this.changed();
  }

  updateDevice(deviceId, patch) {
    this.vault.update((d) => {
      const x = d.devices.find((y) => y.deviceId === deviceId);
      if (!x) return;
      if (typeof patch.canControl === 'boolean') x.canControl = patch.canControl;
      if (typeof patch.unattended === 'boolean') x.unattended = patch.unattended;
    });
    // permission changes apply to a live session immediately
    if (this.session?.deviceId === deviceId && this.session.rs) this.session.rs.device = this.vault.device(deviceId);
    this.changed();
  }

  warn(msg) {
    this.warnings = [...this.warnings.slice(-4), { at: Date.now(), msg }];
    this.changed();
  }

  // ------------------------------------------------------------------ periodic status
  async tick() {
    let snap;
    try {
      snap = this.desktop.snapshot();
    } catch (e) {
      snap = { running: false, error: e.message };
    }
    let project = null;
    if (this.plugin.connected) {
      try {
        project = await this.plugin.request('status', {}, 2000);
      } catch (e) {
        project = { error: e.code ?? 'error' };
      }
    }
    this.premiereStatus = { ...snap, mainHwnd: undefined, project };

    const s = this.session;
    if (s?.capture?.mode === 'window' && snap.mainRect) {
      // track window moves/resizes so input mapping stays correct
      if (s.capture.hwnd === snap.mainHwnd) s.capture.rect = snap.mainRect;
      else if (snap.mainHwnd) { this.selectCaptureSource('window'); this.engine.switchSource(s.id); }
    }
    if (s?.rs?.authed) {
      s.rs.sendClockPing();
      s.rs.pushStatus({
        premiere: { running: snap.running, minimized: snap.minimized, modal: snap.modal, locked: snap.locked, foreground: snap.foreground, project },
        capture: s.capture ? { mode: s.capture.mode, width: s.capture.width, height: s.capture.height, title: s.capture.title } : null,
        stream: s.stats ?? null,
        quality: s.quality,
        auto: s.auto,
        plugin: this.plugin.connected,
      });
      const mins = this.settings.saveReminderMinutes;
      const since = this.lastSaveAt ?? s.startedAt;
      if (mins > 0 && Date.now() - since > mins * 60_000 && Date.now() - (s.lastReminder ?? 0) > mins * 60_000) {
        s.lastReminder = Date.now();
        s.rs.notice('save_reminder', `No save from this phone in the last ${mins} minutes. Premiere's own auto-save settings are unchanged.`);
      }
    }
    this.changed();
  }

  noteCommandResult(action, result) {
    if (action === 'save' && result.status === 'ok') this.lastSaveAt = Date.now();
  }
}

export { randomUUID };
