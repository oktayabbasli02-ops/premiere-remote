// Short-lived 8-digit pairing codes. The code only bootstraps a pairing request that the host
// must approve; it is never a long-term credential.

import { randomInt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const CODE_DIGITS = 8;
const CODE_SPACE = 10 ** CODE_DIGITS;

/** Cryptographically uniform 8-digit code; leading zeros preserved (it is a string). */
export function generateCode() {
  return String(randomInt(0, CODE_SPACE)).padStart(CODE_DIGITS, '0');
}

/** Accepts "0123 4567", "0123-4567" etc. Returns the 8-digit string or null. */
export function normalizeCode(input) {
  if (typeof input !== 'string' || input.length > 32) return null;
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

export function sha256(s) {
  return createHash('sha256').update(s).digest();
}

export function safeEqualHash(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export class PairingRegistry {
  /** @param {{ttlMs?:number, now?:() => number, codeGen?:() => string}} opts */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.now = opts.now ?? Date.now;
    this.codeGen = opts.codeGen ?? generateCode;
    /** active codes, keyed by sha256(code) hex so raw codes are not kept in memory longer than needed */
    this.codes = new Map(); // codeHash -> { hostId, expiresAt }
    this.byHost = new Map(); // hostId -> codeHash
    /** claimed pairing requests waiting for host decision */
    this.pending = new Map(); // pairingId -> { hostId, secretHash, deviceName, devicePublicKey, expiresAt, result, waiters:Set }
  }

  /** Creates (or replaces) the host's active code. Guarantees no collision with other active codes. */
  create(hostId) {
    this.sweep();
    this.cancel(hostId);
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = this.codeGen();
      const h = sha256(code).toString('hex');
      if (this.codes.has(h)) continue;
      const expiresAt = this.now() + this.ttlMs;
      this.codes.set(h, { hostId, expiresAt });
      this.byHost.set(hostId, h);
      return { code, expiresAt };
    }
    throw new Error('could not allocate a unique pairing code');
  }

  cancel(hostId) {
    const h = this.byHost.get(hostId);
    if (h) this.codes.delete(h);
    this.byHost.delete(hostId);
  }

  /**
   * Consumes a code (single-use) and opens a pending pairing request.
   * @returns {{pairingId:string, pairingSecret:string, hostId:string} | null}
   */
  claim(rawCode, { deviceName, devicePublicKey }) {
    this.sweep();
    const code = normalizeCode(rawCode);
    if (!code) return null;
    const h = sha256(code).toString('hex');
    const entry = this.codes.get(h);
    if (!entry || entry.expiresAt <= this.now()) return null;
    // single use: the code dies the moment it is claimed, whatever the host decides
    this.codes.delete(h);
    this.byHost.delete(entry.hostId);
    const pairingId = randomBytes(16).toString('hex');
    const pairingSecret = randomBytes(32).toString('base64url');
    this.pending.set(pairingId, {
      hostId: entry.hostId,
      secretHash: sha256(pairingSecret),
      deviceName,
      devicePublicKey,
      expiresAt: this.now() + 5 * 60_000, // host has 5 minutes to approve
      result: null,
      waiters: new Set(),
    });
    return { pairingId, pairingSecret, hostId: entry.hostId };
  }

  getPending(pairingId, pairingSecret) {
    const p = this.pending.get(pairingId);
    if (!p || typeof pairingSecret !== 'string') return null;
    if (!safeEqualHash(sha256(pairingSecret), p.secretHash)) return null;
    return p;
  }

  /** Records the host decision and wakes up long-polling phones. */
  resolve(pairingId, hostId, result) {
    const p = this.pending.get(pairingId);
    if (!p || p.hostId !== hostId || p.result) return false;
    p.result = result;
    p.expiresAt = this.now() + 60_000; // keep result long enough for the phone to fetch it once
    for (const w of p.waiters) w(result);
    p.waiters.clear();
    return true;
  }

  /** Phone fetched the result; delete so credentials are delivered exactly once. */
  consume(pairingId) {
    this.pending.delete(pairingId);
  }

  activeCodeCount() {
    this.sweep();
    return this.codes.size;
  }

  sweep() {
    const t = this.now();
    for (const [h, e] of this.codes) {
      if (e.expiresAt <= t) {
        this.codes.delete(h);
        if (this.byHost.get(e.hostId) === h) this.byHost.delete(e.hostId);
      }
    }
    for (const [id, p] of this.pending) {
      if (p.expiresAt <= t) {
        for (const w of p.waiters) w({ status: 'expired' });
        this.pending.delete(id);
      }
    }
  }
}
