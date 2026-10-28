// Loopback-only WebSocket server for the Premiere UXP panel.
// Security:
//   - binds 127.0.0.1 only
//   - rejects browser-originated connections (any http/https Origin) so web pages can't reach it
//   - caller process must match an allowlist (default: Adobe Premiere Pro.exe)
//   - first connection requires explicit approval on the PC; afterwards a random plugin token
//     (stored hashed on our side, in UXP secureStorage on the panel side) authenticates the panel

import { EventEmitter } from 'node:events';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { parseMessage, ErrorCode } from '@premiere-remote/shared/protocol';
import { processForLoopbackClient, matchesAllowlist } from './caller-check.js';

export const PLUGIN_PORT = 47631;
const REQ_TIMEOUT_MS = 6000;

const hash = (s) => createHash('sha256').update(s).digest('hex');

export class PluginBridge extends EventEmitter {
  /**
   * @param {{port?:number, log:any, getTokenHashes:() => string[], addTokenHash:(h:string)=>void,
   *          approveConnection:(info:{process:string})=>Promise<boolean>, callerAllowlist:string[], checkCaller?:boolean}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.port = opts.port ?? PLUGIN_PORT;
    this.log = opts.log;
    this.client = null;
    this.pending = new Map();
    this.nextId = 1;
    this.lastState = null;
  }

  get connected() {
    return !!this.client && this.client.readyState === 1;
  }

  start() {
    this.wss = new WebSocketServer({
      host: '127.0.0.1',
      port: this.port,
      maxPayload: 256 * 1024,
      verifyClient: (info, cb) => {
        const origin = info.origin ?? info.req.headers.origin;
        if (origin && /^https?:/i.test(origin)) {
          this.log.warn('plugin bridge: rejected browser origin', { origin });
          return cb(false, 403);
        }
        const ra = info.req.socket.remoteAddress;
        if (ra !== '127.0.0.1' && ra !== '::ffff:127.0.0.1' && ra !== '::1') return cb(false, 403);
        return cb(true);
      },
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.wss.on('error', (e) => this.log.error('plugin bridge error', { err: e.message }));
    this.log.info('plugin bridge listening', { port: this.port });
  }

  async onConnection(ws, req) {
    let authed = false;
    const remotePort = req.socket.remotePort;
    const callerP = this.opts.checkCaller === false ? Promise.resolve(null) : processForLoopbackClient(remotePort, this.port);

    ws.on('message', async (raw) => {
      const msg = parseMessage(raw, 256 * 1024);
      if (!msg) return;
      if (!authed) {
        if (msg.t !== 'hello') return ws.close(4001, 'hello first');
        const caller = await callerP;
        const procName = caller?.path?.split('\\').pop() ?? 'unknown';
        if (this.opts.checkCaller !== false && !matchesAllowlist(caller?.path, this.opts.callerAllowlist)) {
          this.log.warn('plugin bridge: caller not allowed', { process: procName });
          this.emit('rejectedCaller', procName);
          ws.send(JSON.stringify({ t: 'denied', reason: `process ${procName} is not in the allowlist` }));
          return ws.close(4003, 'caller');
        }
        let issued;
        const token = typeof msg.pluginToken === 'string' ? msg.pluginToken : '';
        const h = Buffer.from(hash(token), 'hex');
        const known = token && this.opts.getTokenHashes().some((k) => timingSafeEqual(Buffer.from(k, 'hex'), h));
        if (!known) {
          const ok = await this.opts.approveConnection({ process: procName });
          if (!ok) {
            ws.send(JSON.stringify({ t: 'denied', reason: 'rejected on host' }));
            return ws.close(4003, 'rejected');
          }
          issued = randomBytes(32).toString('base64url');
          this.opts.addTokenHash(hash(issued));
        }
        authed = true;
        if (this.client && this.client !== ws) this.client.close(4002, 'replaced');
        this.client = ws;
        ws.send(JSON.stringify({ t: 'welcome', pluginToken: issued }));
        if (this.lastState) ws.send(JSON.stringify({ t: 'state', state: this.lastState }));
        this.log.info('plugin connected', { process: procName, version: String(msg.pluginVersion ?? '') });
        this.emit('connected');
        return undefined;
      }
      if (msg.t === 'res') {
        const p = this.pending.get(msg.id);
        if (!p) return undefined;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.error?.message ?? 'plugin error'), { code: msg.error?.code ?? ErrorCode.INTERNAL }));
        return undefined;
      }
      if (msg.t === 'ui') return this.emit('ui', msg);
      return undefined;
    });

    ws.on('close', () => {
      if (this.client === ws) {
        this.client = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(Object.assign(new Error('Premiere panel disconnected'), { code: ErrorCode.PLUGIN_NOT_CONNECTED }));
          this.pending.delete(id);
        }
        this.emit('disconnected');
      }
    });
  }

  /** Calls a Premiere API operation implemented in the panel. */
  request(op, args = {}, timeoutMs = REQ_TIMEOUT_MS) {
    if (!this.connected) {
      return Promise.reject(Object.assign(new Error('The Premiere Remote panel is not open in Premiere.'), { code: ErrorCode.PLUGIN_NOT_CONNECTED }));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`Premiere did not answer "${op}" in time`), { code: ErrorCode.TIMEOUT }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.client.send(JSON.stringify({ t: 'req', id, op, args }));
    });
  }

  pushState(state) {
    this.lastState = state;
    if (this.connected) this.client.send(JSON.stringify({ t: 'state', state }));
  }

  stop() {
    this.wss?.close();
  }
}
