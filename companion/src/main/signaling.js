// Host-side signaling client: registers the host once, keeps an authenticated WSS connection with
// exponential backoff, and exposes typed events. Only connects while remote access is enabled.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { Sig, parseMessage } from '@premiere-remote/shared/protocol';

export async function registerHost(baseUrl, name, registrationKey) {
  const r = await fetch(new URL('/v1/hosts/register', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, registrationKey }),
  });
  if (!r.ok) throw new Error(`host registration failed: HTTP ${r.status}`);
  return r.json();
}

export function wsUrlFor(baseUrl) {
  const u = new URL('/v1/ws', baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

export class SignalingClient extends EventEmitter {
  constructor({ baseUrl, hostId, hostToken, log }) {
    super();
    this.baseUrl = baseUrl;
    this.hostId = hostId;
    this.hostToken = hostToken;
    this.log = log;
    this.ws = null;
    this.wanted = false;
    this.backoff = 1000;
    this.state = 'offline'; // offline | connecting | online | auth_failed
  }

  start() {
    this.wanted = true;
    this.connect();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close(1000, 'stopped');
    this.ws = null;
    this.setState('offline');
  }

  setState(s) {
    if (this.state !== s) {
      this.state = s;
      this.emit('state', s);
    }
  }

  connect() {
    if (!this.wanted) return;
    this.setState('connecting');
    const url = wsUrlFor(this.baseUrl);
    if (!url.startsWith('wss:') && !/^ws:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
      this.log.error('refusing unencrypted signaling to a non-loopback server; use https://');
      this.setState('auth_failed');
      return;
    }
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: Sig.HELLO, role: 'host', hostId: this.hostId, token: this.hostToken }));
    });
    ws.on('message', (raw) => {
      const msg = parseMessage(raw);
      if (!msg) return;
      if (msg.t === Sig.WELCOME) {
        this.backoff = 1000;
        this.setState('online');
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send({ t: Sig.PING, ts: Date.now() }), 20_000);
        return;
      }
      if (msg.t === Sig.ERROR && msg.code === 'unauthorized') {
        this.setState('auth_failed');
        this.wanted = false;
        this.emit('authFailed');
        return;
      }
      this.emit('message', msg);
    });
    ws.on('close', () => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.wanted) return;
      this.setState('connecting');
      const jitter = Math.random() * 500;
      this.retryTimer = setTimeout(() => this.connect(), this.backoff + jitter);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
    ws.on('error', (e) => this.log.warn('signaling socket error', { err: e.message }));
  }

  send(msg) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }
}
