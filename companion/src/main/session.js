// One authenticated remote session with a phone, over the WebRTC data channels.
// Transport-agnostic (the engine renderer owns RTCPeerConnection); tested with fakes.

import { Ctl, AckStatus, ErrorCode, isUuid } from '@premiere-remote/shared/protocol';
import { COMMANDS, capabilityList } from '@premiere-remote/shared/commands';
import { SerialQueue, StaleFilter } from '@premiere-remote/shared/journal';
import { normalizedToScreen } from '@premiere-remote/shared/mapping';
import { buildTranscript, newNonce, signTranscript, verifyTranscript } from '@premiere-remote/shared/auth';
import { isAllowedDirectCombo } from './keys.js';

const AUTH_TIMEOUT_MS = 10_000;
const BUTTONS = new Set(['left', 'right', 'middle']);

export class RemoteSession {
  /**
   * @param {object} d
   * @param {string} d.sessionId
   * @param {string} d.hostId
   * @param {{deviceId:string, name:string, publicKey:string, canControl:boolean}} d.device
   * @param {{privateKeyPkcs8:string}} d.hostKey
   * @param {(channel:'control'|'pointer', msg:object) => void} d.send
   * @param {(reason:string) => void} d.end
   * @param {() => void} d.onAuthed
   * @param {any} d.executor
   * @param {any} d.desktop
   * @param {import('@premiere-remote/shared/journal').CommandJournal} d.journal
   * @param {() => ({rect:{x:number,y:number,width:number,height:number}|null})} d.getCapture
   * @param {() => {allowInputOutsidePremiere:boolean}} d.getSettings
   * @param {() => any} d.getProfile
   * @param {(req:object) => void} d.onHostRequest   capture/quality switches
   * @param {any} d.log
   */
  constructor(d) {
    Object.assign(this, d);
    this.authed = false;
    this.hostNonce = newNonce();
    this.fingerprints = null;
    this.controlOpen = false;
    this.queue = new SerialQueue();
    this.pointerFilter = new StaleFilter({ maxAgeMs: 350 });
    this.held = new Set();
    this.epoch = null;
    this.authTimer = setTimeout(() => { if (!this.authed) this.end('auth_timeout'); }, AUTH_TIMEOUT_MS);
    this.closed = false;
  }

  get canControl() {
    return this.authed && this.device.canControl === true;
  }

  /** Called by host core once both SDPs are known. */
  setFingerprints(fp) {
    this.fingerprints = fp;
    this.maybeChallenge();
  }

  onControlOpen() {
    this.controlOpen = true;
    this.maybeChallenge();
  }

  maybeChallenge() {
    if (this.controlOpen && this.fingerprints && !this.challenged) {
      this.challenged = true;
      this.send('control', { t: Ctl.AUTH_CHALLENGE, hostNonce: this.hostNonce, sessionId: this.sessionId, hostId: this.hostId });
    }
  }

  transcript(role, deviceNonce) {
    return buildTranscript({
      role,
      sessionId: this.sessionId,
      hostNonce: this.hostNonce,
      deviceNonce,
      hostFingerprint: this.fingerprints.host,
      deviceFingerprint: this.fingerprints.device,
      deviceId: this.device.deviceId,
      hostId: this.hostId,
    });
  }

  handleAuth(msg) {
    if (msg.t !== Ctl.AUTH_RESPONSE || !this.challenged || this.authed) return;
    let ok = false;
    try {
      ok = typeof msg.deviceNonce === 'string' && msg.deviceNonce.length >= 16 && msg.deviceNonce.length <= 64
        && verifyTranscript(this.device.publicKey, this.transcript('device', msg.deviceNonce), msg.sig);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.log.warn('device authentication failed', { deviceId: this.device.deviceId });
      this.send('control', { t: Ctl.AUTH_FAIL, reason: 'signature' });
      this.end('auth_failed');
      return;
    }
    clearTimeout(this.authTimer);
    this.authed = true;
    this.send('control', {
      t: Ctl.AUTH_OK,
      sig: signTranscript(this.hostKey.privateKeyPkcs8, this.transcript('host', msg.deviceNonce)),
      permissions: { view: true, control: this.device.canControl === true },
      capabilities: capabilityList(this.getProfile()),
      profile: this.getProfile().name,
    });
    this.log.info('device authenticated', { deviceId: this.device.deviceId, control: this.device.canControl });
    this.onAuthed();
  }

  onControl(msg) {
    if (this.closed) return;
    if (!this.authed) return this.handleAuth(msg);
    switch (msg.t) {
      case Ctl.CMD: return this.onCommand(msg);
      case Ctl.CMD_QUERY: return this.onQuery(msg);
      case Ctl.POINTER: return this.onPointerDiscrete(msg);
      case Ctl.KEY: return this.onKey(msg);
      case Ctl.TEXT: return this.onText(msg);
      case Ctl.PING: return this.send('control', { t: Ctl.PONG, id: msg.id, ts: msg.ts, hostTs: Date.now() });
      case Ctl.PONG: return this.onPong(msg);
      case Ctl.CAPTURE_SET:
      case Ctl.QUALITY_SET:
        return this.onHostRequest({ ...msg, deviceId: this.device.deviceId });
      case Ctl.EPOCH:
        // phone starts a new input epoch on every (re)connect; old in-flight events are dropped
        if (typeof msg.epoch === 'string' && msg.epoch.length <= 64) {
          this.epoch = msg.epoch;
          this.pointerFilter.reset(msg.epoch);
        }
        return undefined;
      case Ctl.BYE: return this.end('device_bye');
      default: return undefined;
    }
  }

  ack(id, result) {
    this.send('control', { t: Ctl.ACK, id, ...result });
  }

  onCommand(msg) {
    const { id, action } = msg;
    if (!isUuid(id)) return undefined;
    const def = COMMANDS[action];
    if (!def) return this.ack(id, { status: AckStatus.ERROR, error: { code: ErrorCode.BAD_REQUEST, message: 'unknown action' } });
    // view-only devices may only query status
    if (!this.canControl && action !== 'status') {
      return this.ack(id, { status: AckStatus.FORBIDDEN, error: { code: ErrorCode.FORBIDDEN, message: 'This device has view-only permission.' } });
    }
    const j = this.journal.begin(this.device.deviceId, id);
    if (j.state === 'done') return this.ack(id, { ...j.result, duplicate: true });
    if (j.state === 'inflight') return this.ack(id, { status: AckStatus.IN_PROGRESS, duplicate: true });
    const args = msg.args && typeof msg.args === 'object' ? msg.args : {};
    const expect = msg.expect && typeof msg.expect.sequenceGuid === 'string' ? { sequenceGuid: msg.expect.sequenceGuid } : undefined;
    this.queue.push(async () => {
      const result = await this.executor.execute(action, args, { expect });
      this.journal.complete(this.device.deviceId, id, result);
      if (!this.closed) this.ack(id, result);
    });
    return undefined;
  }

  onQuery(msg) {
    const ids = Array.isArray(msg.ids) ? msg.ids.filter(isUuid).slice(0, 100) : [];
    const results = ids.map((id) => ({ id, ...this.journal.lookup(this.device.deviceId, id) }));
    this.send('control', { t: Ctl.CMD_STATUS, results });
  }

  // ------------------------------------------------------------- input
  mapPoint(x, y) {
    const cap = this.getCapture();
    if (!cap?.rect) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return normalizedToScreen(x, y, cap.rect);
  }

  inputAllowedAt(p) {
    if (this.desktop.locked) return { ok: false, code: ErrorCode.INPUT_BLOCKED, message: 'Windows is locked.' };
    if (this.getSettings().allowInputOutsidePremiere) return { ok: true };
    if (this.desktop.pointIsPremiere(p.x, p.y)) return { ok: true };
    return { ok: false, code: ErrorCode.INPUT_BLOCKED, message: 'Target is outside Premiere. Enable "allow input outside Premiere" on the PC to control other windows.' };
  }

  notice(code, message) {
    this.send('control', { t: Ctl.NOTICE, code, message });
  }

  /** Continuous moves on the unreliable channel. */
  onPointer(msg) {
    if (this.closed || !this.canControl) return;
    if (!this.pointerFilter.accept(msg)) return;
    try {
      if (msg.t === 'move') {
        const p = this.mapPoint(msg.x, msg.y);
        if (!p) return;
        if (this.held.size === 0 && !this.inputAllowedAt(p).ok) return;
        this.desktop.moveTo(p.x, p.y);
      } else if (msg.t === 'rel') {
        const cap = this.getCapture();
        if (!cap?.rect || !Number.isFinite(msg.dx) || !Number.isFinite(msg.dy)) return;
        // dx/dy are fractions of the captured width/height
        const c = this.desktop.cursor();
        const nx = Math.min(cap.rect.x + cap.rect.width - 1, Math.max(cap.rect.x, c.x + msg.dx * cap.rect.width));
        const ny = Math.min(cap.rect.y + cap.rect.height - 1, Math.max(cap.rect.y, c.y + msg.dy * cap.rect.height));
        this.desktop.moveTo(nx, ny);
      }
    } catch (e) {
      this.log.warn('pointer move failed', { err: e.message });
    }
  }

  /** Discrete pointer events on the reliable channel (down/up/click/scroll) — never dropped as stale. */
  onPointerDiscrete(msg) {
    const fail = (code, message) => msg.id && this.send('control', { t: Ctl.ACK, id: msg.id, status: AckStatus.ERROR, error: { code, message } });
    if (!this.canControl) return fail(ErrorCode.FORBIDDEN, 'view-only');
    if (msg.epoch !== this.epoch) return undefined; // from a previous connection
    const button = msg.button ?? 'left';
    if (!BUTTONS.has(button)) return fail(ErrorCode.BAD_REQUEST, 'bad button');
    try {
      let p;
      if (msg.x !== undefined) {
        p = this.mapPoint(msg.x, msg.y);
        if (!p) return fail(ErrorCode.BAD_REQUEST, 'no capture');
      } else {
        p = this.desktop.cursor();
      }
      if (msg.kind === 'up') {
        // always release a held button, even outside Premiere, so nothing stays stuck
        if (this.held.has(button)) {
          this.desktop.moveTo(p.x, p.y);
          this.desktop.button(button, true);
          this.held.delete(button);
        }
        return undefined;
      }
      const allowed = this.inputAllowedAt(p);
      if (!allowed.ok) {
        this.notice(allowed.code, allowed.message);
        return fail(allowed.code, allowed.message);
      }
      this.desktop.moveTo(p.x, p.y);
      switch (msg.kind) {
        case 'down':
          this.desktop.button(button, false);
          this.held.add(button);
          break;
        case 'click':
          this.desktop.button(button, false);
          this.desktop.button(button, true);
          break;
        case 'dblclick':
          for (let i = 0; i < 2; i++) { this.desktop.button(button, false); this.desktop.button(button, true); }
          break;
        case 'scroll':
          this.desktop.wheel(Math.max(-1200, Math.min(1200, Math.round(msg.dy ?? 0))), Math.max(-1200, Math.min(1200, Math.round(msg.dx ?? 0))));
          break;
        default:
          return fail(ErrorCode.BAD_REQUEST, 'bad kind');
      }
    } catch (e) {
      return fail(e.code ?? ErrorCode.INTERNAL, e.message);
    }
    return undefined;
  }

  onKey(msg) {
    if (!isUuid(msg.id)) return undefined;
    if (!this.canControl) return this.ack(msg.id, { status: AckStatus.FORBIDDEN, error: { code: ErrorCode.FORBIDDEN, message: 'view-only' } });
    if (!isAllowedDirectCombo(msg.combo)) return this.ack(msg.id, { status: AckStatus.ERROR, error: { code: ErrorCode.BAD_REQUEST, message: 'key combination not allowed' } });
    this.queue.push(async () => {
      try {
        if (!this.getSettings().allowInputOutsidePremiere) await this.desktop.ensurePremiereFocused();
        await this.desktop.sendCombo(msg.combo);
        this.ack(msg.id, { status: AckStatus.OK, via: 'keyboard', verified: false });
      } catch (e) {
        this.ack(msg.id, { status: AckStatus.ERROR, error: { code: e.code ?? ErrorCode.INTERNAL, message: e.message } });
      }
    });
    return undefined;
  }

  onText(msg) {
    if (!isUuid(msg.id) || typeof msg.text !== 'string' || msg.text.length === 0 || msg.text.length > 500) return undefined;
    if (!this.canControl) return this.ack(msg.id, { status: AckStatus.FORBIDDEN, error: { code: ErrorCode.FORBIDDEN, message: 'view-only' } });
    this.queue.push(async () => {
      try {
        if (!this.getSettings().allowInputOutsidePremiere) await this.desktop.ensurePremiereFocused();
        this.desktop.typeText(msg.text);
        this.ack(msg.id, { status: AckStatus.OK, via: 'keyboard', verified: false });
      } catch (e) {
        this.ack(msg.id, { status: AckStatus.ERROR, error: { code: e.code ?? ErrorCode.INTERNAL, message: e.message } });
      }
    });
    return undefined;
  }

  // ------------------------------------------------------------- clock / status
  sendClockPing() {
    if (this.authed) this.send('control', { t: Ctl.PING, id: 'clk', hostTs: Date.now() });
  }

  onPong(msg) {
    if (msg.id !== 'clk' || !Number.isFinite(msg.hostTs) || !Number.isFinite(msg.ts)) return;
    const rtt = Date.now() - msg.hostTs;
    if (rtt < 0 || rtt > 10_000) return;
    this.pointerFilter.clockOffsetMs = msg.ts - (msg.hostTs + rtt / 2);
    this.appRttMs = rtt;
  }

  pushStatus(status) {
    if (this.authed && !this.closed) this.send('control', { t: Ctl.STATUS, ...status, appRttMs: this.appRttMs ?? null });
  }

  /** Release anything held and stop processing. */
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.authTimer);
    for (const b of this.held) {
      try { this.desktop.button(b, true); } catch { /* ignore */ }
    }
    this.held.clear();
  }
}
