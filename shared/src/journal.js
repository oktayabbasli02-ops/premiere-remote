// Command journal: deduplicates discrete editing commands by (deviceId, commandId) and
// remembers their outcome so a reconnecting phone can ASK what happened instead of re-sending.
// Survives WebRTC reconnects (lives in the companion process, not the session).

export class CommandJournal {
  /** @param {{ttlMs?:number, maxEntries?:number, now?:() => number}} [opts] */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.maxEntries = opts.maxEntries ?? 2000;
    this.now = opts.now ?? Date.now;
    /** @type {Map<string, {state:'inflight'|'done', result?:any, at:number}>} */
    this.entries = new Map();
  }

  key(deviceId, id) {
    return `${deviceId}\u0000${id}`;
  }

  /**
   * Register a command. Returns:
   *   {state:'new'}                  -> caller must execute it
   *   {state:'inflight'}             -> duplicate of a running command; do not execute
   *   {state:'done', result}         -> duplicate of a finished command; reply with cached result
   */
  begin(deviceId, id) {
    this.prune();
    const k = this.key(deviceId, id);
    const e = this.entries.get(k);
    if (e) return e.state === 'done' ? { state: 'done', result: e.result } : { state: 'inflight' };
    this.entries.set(k, { state: 'inflight', at: this.now() });
    return { state: 'new' };
  }

  complete(deviceId, id, result) {
    this.entries.set(this.key(deviceId, id), { state: 'done', result, at: this.now() });
    this.prune();
  }

  /** @returns {{state:'unknown'}|{state:'inflight'}|{state:'done', result:any}} */
  lookup(deviceId, id) {
    this.prune();
    const e = this.entries.get(this.key(deviceId, id));
    if (!e) return { state: 'unknown' };
    return e.state === 'done' ? { state: 'done', result: e.result } : { state: 'inflight' };
  }

  forgetDevice(deviceId) {
    for (const k of this.entries.keys()) if (k.startsWith(`${deviceId}\u0000`)) this.entries.delete(k);
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, e] of this.entries) {
      // in-flight entries are never pruned by age: their outcome is still pending
      if (e.state === 'done' && e.at < cutoff) this.entries.delete(k);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }
}

/** Serial executor: commands run strictly in arrival order, one at a time. */
export class SerialQueue {
  constructor() {
    this.tail = Promise.resolve();
    this.length = 0;
  }

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  push(fn) {
    this.length++;
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => { this.length--; },
      () => { this.length--; },
    );
    return run;
  }
}

/**
 * Drops stale or out-of-order continuous events (pointer moves, scrubs).
 * Events carry a monotonically increasing `seq` per epoch and the sender's timestamp `ts`.
 * `clockOffsetMs` = senderClock - receiverClock, estimated from ping/pong.
 */
export class StaleFilter {
  constructor({ maxAgeMs = 400, now = Date.now } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.epoch = null;
    this.lastSeq = -1;
    this.clockOffsetMs = 0;
  }

  reset(epoch) {
    this.epoch = epoch;
    this.lastSeq = -1;
  }

  accept(ev) {
    if (ev.epoch !== this.epoch) return false;
    if (!Number.isInteger(ev.seq) || ev.seq <= this.lastSeq) return false;
    if (Number.isFinite(ev.ts)) {
      const age = this.now() - (ev.ts - this.clockOffsetMs);
      if (age > this.maxAgeMs) {
        this.lastSeq = ev.seq;
        return false;
      }
    }
    this.lastSeq = ev.seq;
    return true;
  }
}
