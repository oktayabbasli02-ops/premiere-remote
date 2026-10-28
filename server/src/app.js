// Pairing + signaling service.
//
// What this server can observe (also documented in docs/SECURITY.md):
//   - host/device ids, device names, connection IPs and timing
//   - SDP and ICE candidates (IP addresses, codecs, DTLS fingerprints)
// What it cannot observe:
//   - audio/video or data-channel content (DTLS-SRTP / SCTP-over-DTLS end-to-end between host and phone)
//   - it cannot impersonate a paired device to the host: the host verifies an ECDSA signature over the
//     DTLS fingerprints with the device key pinned at pairing (see shared/src/auth.js).

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Sig, ErrorCode, parseMessage, isId, PROTOCOL_VERSION } from '@premiere-remote/shared/protocol';
import { isValidP256Spki } from '@premiere-remote/shared/auth';
import { createLogger } from '@premiere-remote/shared/redact';
import { PairingRegistry } from './pairing.js';
import { ClaimGuard, TokenBucket } from './ratelimit.js';
import { Store } from './store.js';
import { turnCredentials } from './turn.js';
import { createStaticHandler } from './static.js';

const MAX_BODY = 8 * 1024;
const WAIT_TIMEOUT_MS = 25_000;

export function createApp(cfg) {
  const log = cfg.logger ?? createLogger('signal');
  const now = cfg.now ?? Date.now;
  const store = cfg.store ?? new Store(cfg.dataFile);
  const pairing = new PairingRegistry({ ttlMs: cfg.pairingTtlMs ?? 120_000, now, codeGen: cfg.codeGen });
  const guard = cfg.claimGuard ?? new ClaimGuard({ now });
  const registerBucket = new TokenBucket({ capacity: 3, refillPerSec: 3 / 3600, now });
  const serveStatic = createStaticHandler({ webRoot: cfg.webRoot });

  /** @type {Map<string, import('ws').WebSocket>} */ const hosts = new Map();
  /** @type {Map<string, import('ws').WebSocket>} */ const devices = new Map();
  /** @type {Map<string, {hostId:string, deviceId:string, accepted:boolean, createdAt:number}>} */ const sessions = new Map();

  const iceFor = (subject) => turnCredentials({
    secret: cfg.turnSecret, urls: cfg.turnUrls ?? [], stunUrls: cfg.stunUrls ?? [], ttlSec: cfg.turnTtlSec ?? 6 * 3600, subject, now,
  });

  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const xf = req.headers['x-forwarded-for'];
      if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const send = (ws, msg) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  // ---------------------------------------------------------------- HTTP
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, v: PROTOCOL_VERSION });
    if (await serveStatic(req, res, url)) return undefined;
    if (req.method !== 'POST') return json(res, 404, { error: ErrorCode.NOT_FOUND });

    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: ErrorCode.BAD_REQUEST }); }
    const ip = clientIp(req);

    if (url.pathname === '/v1/hosts/register') {
      if (cfg.registrationKey && body.registrationKey !== cfg.registrationKey) return json(res, 401, { error: ErrorCode.UNAUTHORIZED });
      if (!registerBucket.take(ip)) return json(res, 429, { error: ErrorCode.RATE_LIMITED });
      const { hostId, hostToken } = store.createHost(body.name);
      log.info('host registered', { hostId });
      return json(res, 200, { hostId, hostToken });
    }

    if (url.pathname === '/v1/pair/claim') {
      const g = guard.check(ip);
      if (!g.ok) return json(res, 429, { error: ErrorCode.RATE_LIMITED, retryAfterSec: g.retryAfterSec }, { 'retry-after': String(g.retryAfterSec) });
      const deviceName = typeof body.deviceName === 'string' ? body.deviceName.slice(0, 64) : '';
      if (!deviceName || !isValidP256Spki(body.devicePublicKey)) return json(res, 400, { error: ErrorCode.BAD_REQUEST });
      const claimed = pairing.claim(body.code, { deviceName, devicePublicKey: body.devicePublicKey });
      if (!claimed) {
        guard.recordFailure(ip);
        // identical response for wrong / expired / used codes: no oracle for enumeration
        return json(res, 404, { error: ErrorCode.EXPIRED });
      }
      guard.recordSuccess(ip);
      const hostWs = hosts.get(claimed.hostId);
      if (!hostWs) {
        pairing.resolve(claimed.pairingId, claimed.hostId, { status: 'rejected', reason: ErrorCode.HOST_OFFLINE });
      } else {
        send(hostWs, { t: Sig.PAIRING_REQUEST, pairingId: claimed.pairingId, deviceName, devicePublicKey: body.devicePublicKey });
      }
      log.info('pairing claimed', { hostId: claimed.hostId });
      return json(res, 200, { pairingId: claimed.pairingId, pairingSecret: claimed.pairingSecret });
    }

    if (url.pathname === '/v1/pair/wait') {
      const p = pairing.getPending(body.pairingId, body.pairingSecret);
      if (!p) return json(res, 404, { error: ErrorCode.NOT_FOUND });
      const finish = (result) => {
        if (res.writableEnded) return;
        if (result.status !== 'pending') pairing.consume(body.pairingId);
        json(res, 200, result);
      };
      if (p.result) return finish(p.result);
      const timer = setTimeout(() => { p.waiters.delete(waiter); finish({ status: 'pending' }); }, cfg.waitTimeoutMs ?? WAIT_TIMEOUT_MS);
      const waiter = (result) => { clearTimeout(timer); finish(result); };
      p.waiters.add(waiter);
      req.on('close', () => { clearTimeout(timer); p.waiters.delete(waiter); });
      return undefined;
    }

    return json(res, 404, { error: ErrorCode.NOT_FOUND });
  }

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((e) => {
      log.error('http handler failed', { err: e.message });
      if (!res.headersSent) json(res, 500, { error: ErrorCode.INTERNAL });
    });
  });

  // ---------------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({ server, path: '/v1/ws', maxPayload: 64 * 1024 });

  function endSession(sessionId, reason, notify = true) {
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    if (notify) {
      send(hosts.get(s.hostId), { t: Sig.SESSION_END, sessionId, reason });
      send(devices.get(s.deviceId), { t: Sig.SESSION_END, sessionId, reason });
    }
  }

  function notifyHostStatus(hostId, online) {
    for (const [deviceId, ws] of devices) if (store.deviceHost(deviceId) === hostId) send(ws, { t: Sig.HOST_STATUS, hostId, online });
  }

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    const msgBucket = new TokenBucket({ capacity: 200, refillPerSec: 50, now });
    let ident = null; // { role:'host', hostId } | { role:'device', deviceId, hostId }
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const helloTimer = setTimeout(() => { if (!ident) ws.close(4001, 'hello timeout'); }, 10_000);

    const fail = (code, closeCode) => {
      send(ws, { t: Sig.ERROR, code });
      if (closeCode) ws.close(closeCode, code);
    };

    ws.on('message', (raw) => {
      if (!msgBucket.take('m')) return fail(ErrorCode.RATE_LIMITED, 4029);
      const msg = parseMessage(raw);
      if (!msg) return fail(ErrorCode.BAD_REQUEST);

      if (!ident) {
        if (msg.t !== Sig.HELLO) return fail(ErrorCode.UNAUTHORIZED, 4001);
        if (msg.role === 'host' && isId(msg.hostId) && store.authHost(msg.hostId, msg.token)) {
          ident = { role: 'host', hostId: msg.hostId };
          const prev = hosts.get(msg.hostId);
          if (prev && prev !== ws) prev.close(4002, 'replaced');
          hosts.set(msg.hostId, ws);
          clearTimeout(helloTimer);
          send(ws, { t: Sig.WELCOME, role: 'host', v: PROTOCOL_VERSION });
          notifyHostStatus(msg.hostId, true);
          log.info('host online', { hostId: msg.hostId });
          return undefined;
        }
        if (msg.role === 'device' && isId(msg.deviceId)) {
          const auth = store.authDevice(msg.deviceId, msg.token);
          if (auth) {
            ident = { role: 'device', deviceId: msg.deviceId, hostId: auth.hostId };
            const prev = devices.get(msg.deviceId);
            if (prev && prev !== ws) prev.close(4002, 'replaced');
            devices.set(msg.deviceId, ws);
            clearTimeout(helloTimer);
            send(ws, { t: Sig.WELCOME, role: 'device', v: PROTOCOL_VERSION, hostId: auth.hostId, hostOnline: hosts.has(auth.hostId) });
            log.info('device online', { deviceId: msg.deviceId });
            return undefined;
          }
        }
        log.warn('ws auth failed', { ip, role: msg.role });
        return fail(ErrorCode.UNAUTHORIZED, 4001);
      }

      if (msg.t === Sig.PING) return send(ws, { t: Sig.PONG, ts: msg.ts });
      return ident.role === 'host' ? onHost(ident, ws, msg) : onDevice(ident, ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!ident) return;
      if (ident.role === 'host' && hosts.get(ident.hostId) === ws) {
        hosts.delete(ident.hostId);
        pairing.cancel(ident.hostId);
        for (const [sid, s] of sessions) if (s.hostId === ident.hostId) endSession(sid, 'host_disconnected');
        notifyHostStatus(ident.hostId, false);
        log.info('host offline', { hostId: ident.hostId });
      }
      if (ident.role === 'device' && devices.get(ident.deviceId) === ws) {
        devices.delete(ident.deviceId);
        for (const [sid, s] of sessions) if (s.deviceId === ident.deviceId) endSession(sid, 'device_disconnected');
      }
    });
  });

  function onHost(ident, ws, msg) {
    const { hostId } = ident;
    switch (msg.t) {
      case Sig.PAIRING_CREATE: {
        const { code, expiresAt } = pairing.create(hostId);
        log.info('pairing code issued', { hostId });
        return send(ws, { t: Sig.PAIRING_CODE, code, expiresAt, ttlMs: expiresAt - now() });
      }
      case Sig.PAIRING_CANCEL:
        pairing.cancel(hostId);
        return undefined;
      case Sig.PAIRING_DECISION: {
        const p = pairing.pending.get(msg.pairingId);
        if (!p || p.hostId !== hostId || p.result) return fail(ws, ErrorCode.NOT_FOUND);
        if (!msg.approve) {
          pairing.resolve(msg.pairingId, hostId, { status: 'rejected', reason: ErrorCode.HOST_REJECTED });
          return undefined;
        }
        if (!isValidP256Spki(msg.hostPublicKey)) return fail(ws, ErrorCode.BAD_REQUEST);
        const { deviceId, deviceToken } = store.createDevice(hostId, p.deviceName);
        pairing.resolve(msg.pairingId, hostId, {
          status: 'approved',
          hostId,
          hostName: typeof msg.hostName === 'string' ? msg.hostName.slice(0, 64) : '',
          hostPublicKey: msg.hostPublicKey,
          deviceId,
          deviceToken,
          permissions: { view: true, control: msg.permissions?.control === true },
        });
        log.info('pairing approved', { hostId, deviceId });
        return send(ws, { t: Sig.PAIRING_COMPLETED, pairingId: msg.pairingId, deviceId });
      }
      case Sig.DEVICE_REVOKE: {
        if (!isId(msg.deviceId)) return fail(ws, ErrorCode.BAD_REQUEST);
        store.revokeDevice(hostId, msg.deviceId);
        for (const [sid, s] of sessions) if (s.deviceId === msg.deviceId) endSession(sid, 'revoked');
        const dws = devices.get(msg.deviceId);
        if (dws) { send(dws, { t: Sig.ERROR, code: ErrorCode.UNAUTHORIZED, reason: 'revoked' }); dws.close(4003, 'revoked'); }
        log.info('device revoked', { hostId, deviceId: msg.deviceId });
        return send(ws, { t: Sig.DEVICE_REVOKED, deviceId: msg.deviceId });
      }
      case Sig.DEVICES_SYNC: {
        if (!Array.isArray(msg.deviceIds)) return fail(ws, ErrorCode.BAD_REQUEST);
        const removed = store.syncDevices(hostId, msg.deviceIds.filter((d) => isId(d)));
        for (const id of removed) devices.get(id)?.close(4003, 'revoked');
        return undefined;
      }
      case Sig.SESSION_ACCEPT:
      case Sig.SESSION_REJECT:
      case Sig.SIGNAL:
      case Sig.SESSION_END: {
        const s = sessions.get(msg.sessionId);
        if (!s || s.hostId !== hostId) return fail(ws, ErrorCode.NOT_FOUND);
        if (msg.t === Sig.SESSION_END) return endSession(msg.sessionId, msg.reason ?? 'host_ended');
        if (msg.t === Sig.SESSION_REJECT) {
          send(devices.get(s.deviceId), { t: Sig.SESSION_REJECT, sessionId: msg.sessionId, reason: String(msg.reason ?? 'rejected').slice(0, 64) });
          sessions.delete(msg.sessionId);
          return undefined;
        }
        if (msg.t === Sig.SESSION_ACCEPT) {
          s.accepted = true;
          return send(devices.get(s.deviceId), { t: Sig.SESSION_ACCEPT, sessionId: msg.sessionId, iceServers: iceFor(s.deviceId) });
        }
        if (!s.accepted) return fail(ws, ErrorCode.FORBIDDEN);
        return send(devices.get(s.deviceId), { t: Sig.SIGNAL, sessionId: msg.sessionId, data: msg.data });
      }
      default:
        return fail(ws, ErrorCode.BAD_REQUEST);
    }
  }

  function onDevice(ident, ws, msg) {
    const { deviceId, hostId } = ident;
    // re-check on every message so a revoke takes effect immediately
    if (store.deviceHost(deviceId) !== hostId) { ws.close(4003, 'revoked'); return undefined; }
    switch (msg.t) {
      case Sig.SESSION_REQUEST: {
        const hostWs = hosts.get(hostId);
        if (!hostWs) return send(ws, { t: Sig.SESSION_REJECT, sessionId: msg.sessionId, reason: ErrorCode.HOST_OFFLINE });
        for (const [sid, s] of sessions) if (s.deviceId === deviceId) endSession(sid, 'superseded');
        const sessionId = randomUUID();
        sessions.set(sessionId, { hostId, deviceId, accepted: false, createdAt: now() });
        send(ws, { t: 'session.created', sessionId, clientRef: typeof msg.clientRef === 'string' ? msg.clientRef.slice(0, 64) : undefined });
        return send(hostWs, { t: Sig.SESSION_REQUEST, sessionId, deviceId, iceServers: iceFor(hostId) });
      }
      case Sig.SIGNAL:
      case Sig.SESSION_END: {
        const s = sessions.get(msg.sessionId);
        if (!s || s.deviceId !== deviceId) return fail(ws, ErrorCode.NOT_FOUND);
        if (msg.t === Sig.SESSION_END) return endSession(msg.sessionId, 'device_ended');
        if (!s.accepted) return fail(ws, ErrorCode.FORBIDDEN);
        return send(hosts.get(hostId), { t: Sig.SIGNAL, sessionId: msg.sessionId, data: msg.data });
      }
      default:
        return fail(ws, ErrorCode.BAD_REQUEST);
    }
  }

  function fail(ws, code) {
    send(ws, { t: Sig.ERROR, code });
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
    pairing.sweep();
    for (const [sid, s] of sessions) if (!s.accepted && now() - s.createdAt > 120_000) endSession(sid, 'not_accepted');
  }, cfg.heartbeatMs ?? 25_000);

  return {
    server,
    store,
    pairing,
    listen: (port, host) => new Promise((r) => server.listen(port, host, () => r(server.address()))),
    close: () => new Promise((r) => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(() => r());
    }),
  };
}
