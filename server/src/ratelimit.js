// Brute-force protection for pairing-code claims.
//
// Three layers:
//  1. per-IP token bucket on all claim attempts (default 10/min burst 5)
//  2. per-IP failure counter with exponential lockout
//  3. global failure ceiling: if the whole service sees too many wrong codes per minute,
//     claims are refused for everyone for a short time (defeats distributed enumeration).
// With a 10^8 code space, a 2-minute TTL and these limits, the chance of guessing an active
// code is negligible (see docs/SECURITY.md for the arithmetic).

export class TokenBucket {
  constructor({ capacity, refillPerSec, now = Date.now }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.buckets = new Map();
  }

  take(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    if (this.buckets.size > 50_000) this.gc();
    return true;
  }

  gc() {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.at > 3_600_000) this.buckets.delete(k);
  }
}

export class ClaimGuard {
  constructor({ now = Date.now, perIpPerMin = 10, burst = 5, globalFailPerMin = 300 } = {}) {
    this.now = now;
    this.bucket = new TokenBucket({ capacity: burst, refillPerSec: perIpPerMin / 60, now });
    this.failures = new Map(); // ip -> { count, lockedUntil }
    this.globalFailPerMin = globalFailPerMin;
    this.globalWindow = { start: now(), count: 0 };
    this.globalLockedUntil = 0;
  }

  /** @returns {{ok:true} | {ok:false, retryAfterSec:number}} */
  check(ip) {
    const t = this.now();
    if (t < this.globalLockedUntil) return { ok: false, retryAfterSec: Math.ceil((this.globalLockedUntil - t) / 1000) };
    const f = this.failures.get(ip);
    if (f && t < f.lockedUntil) return { ok: false, retryAfterSec: Math.ceil((f.lockedUntil - t) / 1000) };
    if (!this.bucket.take(ip)) return { ok: false, retryAfterSec: 6 };
    return { ok: true };
  }

  recordFailure(ip) {
    const t = this.now();
    const f = this.failures.get(ip) ?? { count: 0, lockedUntil: 0 };
    f.count += 1;
    if (f.count >= 5) {
      // 5 wrong -> 1 min, 10 -> 2 min, 15 -> 4 min ... capped at 1 h
      const steps = Math.floor(f.count / 5) - 1;
      f.lockedUntil = t + Math.min(3_600_000, 60_000 * 2 ** steps);
    }
    this.failures.set(ip, f);

    if (t - this.globalWindow.start > 60_000) this.globalWindow = { start: t, count: 0 };
    this.globalWindow.count += 1;
    if (this.globalWindow.count > this.globalFailPerMin) this.globalLockedUntil = t + 60_000;
  }

  recordSuccess(ip) {
    this.failures.delete(ip);
  }
}
