// Phone-side connection controller for the web client — same protocol and safety rules as the
// Android RemoteController:
//  - every reconnect is a new WebRTC session with a new input epoch (stale input is discarded);
//  - unacknowledged commands are never re-sent; after reconnect the phone asks (cmd.query).

import { Sig, Ctl } from '../shared/protocol.js';
import { loadToken, signTranscript, verifyHost, newNonce, transcript, fingerprint } from './identity.js';

const DESTRUCTIVE = new Set(['setIn', 'setOut', 'addMarker', 'addEdit', 'deleteSelection', 'rippleDeleteSelection', 'trimPrevToPlayhead', 'trimNextToPlayhead', 'undo', 'redo']);

export const Phase = Object.freeze({
  CONNECTING: 'CONNECTING', HOST_OFFLINE: 'HOST_OFFLINE', WAITING_APPROVAL: 'WAITING_APPROVAL', CONNECTING_MEDIA: 'CONNECTING_MEDIA',
  AUTHENTICATING: 'AUTHENTICATING', LIVE: 'LIVE', RECONNECTING: 'RECONNECTING', REJECTED: 'REJECTED', REVOKED: 'REVOKED',
  SECURITY_ERROR: 'SECURITY_ERROR', ENDED: 'ENDED',
});

export class RemoteController {
  /** @param {{hostId,hostName,deviceId,hostPublicKey}} host @param {HTMLVideoElement} video @param {(s:object)=>void} onState */
  constructor(host, video, onState) {
    this.host = host;
    this.video = video;
    this.onState = onState;
    this.state = { phase: Phase.CONNECTING, message: '', canControl: false, capabilities: [], hostView: {}, stats: {}, appRttMs: null, pending: [], lastAck: null, notices: [] };
    this.ws = null;
    this.pc = null;
    this.control = null;
    this.pointer = null;
    this.sessionId = null;
    this.fp = null;
    this.nonces = null;
    this.epoch = crypto.randomUUID();
    this.seq = 0;
    this.pending = new Map();
    this.pings = new Map();
    this.userStopped = false;
    this.backoff = 1000;
    this.failedSince = null;
    this.timer = null;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  phase(p, message = '') {
    this.set({ phase: p, message });
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    this.userStopped = false;
    this.token = await loadToken(this.host.hostId);
    if (!this.token) return this.phase(Phase.REVOKED, 'Credentials for this PC are missing. Pair again.');
    this.connectSignaling();
    document.addEventListener('visibilitychange', this.onVisibility = () => {
      // iOS suspends WebRTC in the background; reconnect cleanly when the app comes back
      if (document.visibilityState === 'visible' && !this.userStopped && !this.ws) this.connectSignaling();
    });
    window.addEventListener('online', this.onOnline = () => { this.backoff = 500; if (!this.ws && !this.userStopped) this.connectSignaling(); });
    return undefined;
  }

  stop() {
    this.userStopped = true;
    this.sendControl({ t: Ctl.BYE });
    if (this.sessionId) this.sig({ t: Sig.SESSION_END, sessionId: this.sessionId });
    this.teardown();
    this.ws?.close();
    this.ws = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.onOnline);
    this.phase(Phase.ENDED, 'Disconnected.');
  }

  connectSignaling() {
    this.phase(this.state.phase === Phase.LIVE ? Phase.RECONNECTING : Phase.CONNECTING, 'Connecting to server…');
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: Sig.HELLO, role: 'device', deviceId: this.host.deviceId, token: this.token }));
    ws.onmessage = (e) => { try { this.onSignal(JSON.parse(e.data)); } catch { /* ignore */ } };
    ws.onclose = (e) => { if (this.ws === ws) this.onSignalingClosed(e.code); };
  }

  sig(m) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  onSignalingClosed(code) {
    this.teardown();
    this.ws = null;
    if (this.userStopped) return;
    if (code === 4003 || code === 4001) return this.phase(Phase.REVOKED, "This phone's access was revoked on the PC. Pair again.");
    this.phase(Phase.RECONNECTING, 'Connection lost. Reconnecting…');
    setTimeout(() => { if (!this.userStopped && !this.ws) this.connectSignaling(); }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15000);
    return undefined;
  }

  // ------------------------------------------------------------------ signaling
  onSignal(m) {
    switch (m.t) {
      case Sig.WELCOME:
        this.backoff = 1000;
        if (m.hostOnline) this.requestSession(); else this.phase(Phase.HOST_OFFLINE, 'The PC is offline or remote access is off. Waiting…');
        break;
      case Sig.HOST_STATUS:
        if (m.online && !this.sessionId) this.requestSession();
        if (!m.online) { this.teardown(); this.phase(Phase.HOST_OFFLINE, 'The PC went offline. Waiting…'); }
        break;
      case 'session.created':
        this.sessionId = m.sessionId;
        this.phase(Phase.WAITING_APPROVAL, 'Waiting for the PC to accept (approve on the PC if this device is not trusted for unattended access)…');
        break;
      case Sig.SESSION_ACCEPT:
        if (m.sessionId === this.sessionId) this.startRtc(m.iceServers ?? []);
        break;
      case Sig.SESSION_REJECT: {
        this.teardown();
        const r = m.reason;
        if (r === 'host_offline') this.phase(Phase.HOST_OFFLINE, 'The PC is offline. Waiting…');
        else if (r === 'busy') this.phase(Phase.REJECTED, 'Another phone is connected to this PC.');
        else if (r === 'unauthorized') this.phase(Phase.REVOKED, 'This device is no longer trusted by the PC. Pair again.');
        else this.phase(Phase.REJECTED, 'The PC declined the connection.');
        break;
      }
      case Sig.SESSION_END:
        if (m.sessionId !== this.sessionId) break;
        this.teardown();
        if (m.reason === 'revoked') this.phase(Phase.REVOKED, 'Access revoked on the PC.');
        else if (!this.userStopped) {
          this.phase(Phase.RECONNECTING, `Session ended (${m.reason}). Reconnecting…`);
          setTimeout(() => { if (!this.sessionId && !this.userStopped) this.requestSession(); }, 1500);
        }
        break;
      case Sig.SIGNAL:
        if (m.sessionId === this.sessionId) this.onRemoteSignal(m.data);
        break;
      case Sig.ERROR:
        if (m.code === 'unauthorized') this.phase(Phase.REVOKED, m.reason === 'revoked' ? "This device's access was revoked on the PC. Pair again." : 'Server rejected this device. Pair again.');
        break;
      default:
        break;
    }
  }

  requestSession() {
    if (this.sessionId) return;
    this.sig({ t: Sig.SESSION_REQUEST, clientRef: crypto.randomUUID() });
  }

  startRtc(iceServers) {
    this.phase(Phase.CONNECTING_MEDIA, 'Connecting media (direct or via TURN)…');
    this.fp = null;
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    const sid = this.sessionId;
    pc.onicecandidate = (e) => { if (e.candidate) this.sig({ t: Sig.SIGNAL, sessionId: sid, data: { type: 'candidate', candidate: e.candidate.toJSON() } }); };
    pc.ontrack = (e) => {
      if (!this.video.srcObject) this.video.srcObject = new MediaStream();
      this.video.srcObject.addTrack(e.track);
      this.video.play().catch(() => {}); // muted autoplay is always allowed; sound needs a tap (iOS rule)
    };
    pc.onconnectionstatechange = () => this.onPcState(pc.connectionState);
    pc.ondatachannel = (e) => {
      const dc = e.channel;
      if (dc.label === 'control') this.control = dc;
      if (dc.label === 'pointer') this.pointer = dc;
      dc.onmessage = (ev) => { if (typeof ev.data === 'string') { try { this.onControl(JSON.parse(ev.data)); } catch { /* ignore */ } } };
    };
    this.startTimers();
  }

  async onRemoteSignal(d) {
    if (!this.pc || !d) return;
    try {
      if (d.type === 'offer') {
        await this.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.sig({ t: Sig.SIGNAL, sessionId: this.sessionId, data: { type: 'answer', sdp: this.pc.localDescription.sdp } });
        if (!this.fp) {
          const hostFp = fingerprint(d.sdp);
          const deviceFp = fingerprint(this.pc.localDescription.sdp);
          if (!hostFp || !deviceFp) return this.securityError('Missing DTLS fingerprint');
          this.fp = { hostFp, deviceFp };
        }
      } else if (d.type === 'candidate' && d.candidate?.candidate) {
        await this.pc.addIceCandidate(d.candidate);
      }
    } catch (e) {
      this.notice(`WebRTC: ${e.message}`);
    }
    return undefined;
  }

  onPcState(s) {
    if (s === 'connected') {
      this.failedSince = null;
      if (this.state.phase === Phase.RECONNECTING) this.phase(Phase.LIVE);
    } else if (s === 'disconnected' || s === 'failed') {
      this.failedSince ??= Date.now();
      if (this.state.phase === Phase.LIVE) this.phase(Phase.RECONNECTING, 'Network interrupted. Waiting for the PC to restart ICE…');
    }
  }

  teardown() {
    clearInterval(this.timer);
    this.timer = null;
    try { this.pc?.close(); } catch { /* ignore */ }
    this.pc = null;
    this.control = null;
    this.pointer = null;
    this.sessionId = null;
    this.fp = null;
    this.nonces = null;
    this.failedSince = null;
    if (this.video.srcObject) { this.video.srcObject.getTracks().forEach((t) => t.stop()); this.video.srcObject = null; }
  }

  securityError(msg) {
    if (this.sessionId) this.sig({ t: Sig.SESSION_END, sessionId: this.sessionId, reason: 'security' });
    this.teardown();
    this.userStopped = true;
    this.ws?.close();
    this.phase(Phase.SECURITY_ERROR, `Security check failed: ${msg}. Not reconnecting. If this persists, revoke and pair again.`);
  }

  // ------------------------------------------------------------------ data channel protocol
  async onControl(m) {
    switch (m.t) {
      case Ctl.AUTH_CHALLENGE: return this.onChallenge(m);
      case Ctl.AUTH_OK: return this.onAuthOk(m);
      case Ctl.AUTH_FAIL: return this.securityError("the PC rejected this device's signature");
      case Ctl.ACK: return this.onAck(m);
      case Ctl.CMD_STATUS: return this.onCmdStatus(m);
      case Ctl.STATUS: return this.onStatus(m);
      case Ctl.NOTICE: return this.notice(m.message);
      case Ctl.PING: return this.sendControl({ t: Ctl.PONG, id: m.id, hostTs: m.hostTs, ts: Date.now() });
      case Ctl.PONG: {
        const sent = this.pings.get(m.id);
        if (sent) { this.pings.delete(m.id); this.set({ appRttMs: Date.now() - sent }); }
        return undefined;
      }
      default: return undefined;
    }
  }

  async onChallenge(m) {
    if (!this.fp) return this.securityError('challenge before DTLS fingerprints were known');
    if (m.sessionId !== this.sessionId || m.hostId !== this.host.hostId) return this.securityError('challenge for a different session/host');
    this.nonces = { hostNonce: m.hostNonce, deviceNonce: newNonce() };
    const t = transcript('device', { ...this.fp, ...this.nonces, sessionId: this.sessionId, hostId: this.host.hostId, deviceId: this.host.deviceId });
    this.sendControl({ t: Ctl.AUTH_RESPONSE, deviceNonce: this.nonces.deviceNonce, sig: await signTranscript(t) });
    this.phase(Phase.AUTHENTICATING, "Verifying the PC's identity…");
    return undefined;
  }

  async onAuthOk(m) {
    if (!this.fp || !this.nonces) return undefined;
    const t = transcript('host', { ...this.fp, ...this.nonces, sessionId: this.sessionId, hostId: this.host.hostId, deviceId: this.host.deviceId });
    if (!(await verifyHost(this.host.hostPublicKey, t, m.sig))) return this.securityError("the PC's identity key does not match the one pinned at pairing");
    this.epoch = crypto.randomUUID();
    this.seq = 0;
    this.sendControl({ t: Ctl.EPOCH, epoch: this.epoch });
    this.set({ canControl: m.permissions?.control === true, capabilities: m.capabilities ?? [] });
    this.phase(Phase.LIVE);
    this.backoff = 1000;
    if (this.pending.size) this.sendControl({ t: Ctl.CMD_QUERY, ids: [...this.pending.keys()] });
    return undefined;
  }

  onAck(m) {
    const p = this.pending.get(m.id);
    if (!p || m.status === 'in_progress') return;
    this.pending.delete(m.id);
    const err = m.error;
    let msg;
    if (m.status === 'ok') msg = m.verified ? `${p.label}: done` : `${p.label}: sent${m.note ? ` — ${m.note}` : ' (cannot be verified)'}`;
    else if (m.status === 'unsupported') msg = `${p.label}: not supported (${err?.message ?? ''})`;
    else if (m.status === 'forbidden') msg = `${p.label}: this device is view-only`;
    else msg = `${p.label} failed: ${err?.message ?? m.status}`;
    this.set({ pending: [...this.pending.values()], lastAck: { action: p.action, status: m.status, verified: !!m.verified, message: msg, at: Date.now() } });
  }

  onCmdStatus(m) {
    for (const r of m.results ?? []) {
      const p = this.pending.get(r.id);
      if (!p) continue;
      if (r.state === 'done') this.onAck({ ...(r.result ?? {}), id: r.id });
      else if (r.state === 'unknown') {
        this.pending.delete(r.id);
        this.set({ lastAck: { action: p.action, status: 'lost', verified: false, message: `${p.label} never reached the PC and was NOT re-sent. Check the timeline, then repeat it if needed.`, at: Date.now() } });
      }
    }
    this.set({ pending: [...this.pending.values()] });
  }

  onStatus(m) {
    const pr = m.premiere ?? {};
    const proj = pr.project ?? {};
    const seq = proj.sequence;
    this.set({
      hostView: {
        premiereRunning: !!pr.running, minimized: !!pr.minimized, modal: !!pr.modal, locked: !!pr.locked,
        foregroundTitle: pr.foreground?.title ?? '', foregroundIsPremiere: pr.foreground?.isPremiere !== false,
        projectName: proj.project?.name, sequenceName: seq?.name, sequenceGuid: seq?.guid, fps: seq?.fps,
        captureMode: m.capture?.mode, captureW: m.capture?.width, captureH: m.capture?.height,
        quality: m.quality, autoQuality: !!m.auto, pluginConnected: !!m.plugin, hostEncoder: m.stream?.encoder,
      },
    });
  }

  notice(text) {
    if (!text) return;
    this.set({ notices: [...this.state.notices.filter((n) => n !== text), text].slice(-3) });
    setTimeout(() => this.set({ notices: this.state.notices.filter((n) => n !== text) }), 8000);
  }

  dismissNotices() { this.set({ notices: [] }); }

  startTimers() {
    clearInterval(this.timer);
    let lastBytes = null;
    this.timer = setInterval(async () => {
      if (this.pc) {
        const report = await this.pc.getStats();
        const s = {};
        let pairId = null;
        const byId = new Map();
        report.forEach((r) => byId.set(r.id, r));
        report.forEach((r) => {
          if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
          if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pairId ??= r.id;
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            Object.assign(s, { width: r.frameWidth, height: r.frameHeight, fps: r.framesPerSecond, packetsLost: r.packetsLost, jitterMs: r.jitter != null ? r.jitter * 1000 : null, decoder: r.decoderImplementation });
            if (lastBytes) s.bitrateKbps = Math.round(((r.bytesReceived - lastBytes.b) * 8) / (r.timestamp - lastBytes.t));
            lastBytes = { b: r.bytesReceived, t: r.timestamp };
            s.codec = byId.get(r.codecId)?.mimeType;
          }
        });
        const pair = pairId ? byId.get(pairId) : null;
        if (pair) {
          const lc = byId.get(pair.localCandidateId)?.candidateType;
          const rc = byId.get(pair.remoteCandidateId)?.candidateType;
          Object.assign(s, { rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null, relayed: lc === 'relay' || rc === 'relay', candidates: `${lc}/${rc}` });
        }
        this.set({ stats: s });
      }
      if (this.state.phase === Phase.LIVE) {
        const id = crypto.randomUUID();
        this.pings.set(id, Date.now());
        if (this.pings.size > 10) this.pings.delete(this.pings.keys().next().value);
        this.sendControl({ t: Ctl.PING, id, ts: Date.now() });
        const stale = [...this.pending.values()].filter((p) => Date.now() - p.sentAt > 8000).map((p) => p.id);
        if (stale.length) this.sendControl({ t: Ctl.CMD_QUERY, ids: stale });
      }
      if (this.failedSince && Date.now() - this.failedSince > 12000) {
        // the PC could not restart ICE: start a fresh session (new epoch)
        if (this.sessionId) this.sig({ t: Sig.SESSION_END, sessionId: this.sessionId, reason: 'media_failed' });
        this.teardown();
        this.phase(Phase.RECONNECTING, 'Re-establishing the stream…');
        this.requestSession();
      }
    }, 2000);
  }

  sendControl(m) {
    if (this.control?.readyState !== 'open') return false;
    this.control.send(JSON.stringify(m));
    return true;
  }

  // ------------------------------------------------------------------ public actions
  command(action, label, args = {}) {
    if (this.state.phase !== Phase.LIVE) {
      this.set({ lastAck: { action, status: 'offline', verified: false, message: `${label} not sent: not connected.`, at: Date.now() } });
      return;
    }
    const id = crypto.randomUUID();
    const msg = { t: Ctl.CMD, id, action, args };
    const guid = this.state.hostView.sequenceGuid;
    if (DESTRUCTIVE.has(action) && guid) msg.expect = { sequenceGuid: guid };
    if (this.sendControl(msg)) {
      this.pending.set(id, { id, action, label, sentAt: Date.now() });
      this.set({ pending: [...this.pending.values()] });
    }
  }

  move(x, y) {
    if (this.pointer?.readyState !== 'open' || this.pointer.bufferedAmount > 16384) return;
    this.pointer.send(JSON.stringify({ t: 'move', x, y, seq: ++this.seq, ts: Date.now(), epoch: this.epoch }));
  }

  rel(dx, dy) {
    if (this.pointer?.readyState !== 'open' || this.pointer.bufferedAmount > 16384) return;
    this.pointer.send(JSON.stringify({ t: 'rel', dx, dy, seq: ++this.seq, ts: Date.now(), epoch: this.epoch }));
  }

  ptr(kind, p, button = 'left', dy = 0) {
    const m = { t: Ctl.POINTER, kind, button, epoch: this.epoch };
    if (p) { m.x = p.x; m.y = p.y; }
    if (kind === 'scroll') m.dy = dy;
    this.sendControl(m);
  }

  key(combo) {
    const id = crypto.randomUUID();
    if (this.sendControl({ t: Ctl.KEY, id, combo })) this.pending.set(id, { id, action: 'key', label: combo, sentAt: Date.now() });
  }

  text(s) {
    if (!s) return;
    const id = crypto.randomUUID();
    if (this.sendControl({ t: Ctl.TEXT, id, text: s.slice(0, 500) })) this.pending.set(id, { id, action: 'text', label: 'Typing', sentAt: Date.now() });
  }

  setCapture(mode) { this.sendControl({ t: Ctl.CAPTURE_SET, mode }); }
  setQuality(profile) { this.sendControl({ t: Ctl.QUALITY_SET, profile }); }
}
