// Tiny persistent store (JSON file, atomic writes). Only token HASHES are stored.
// Adequate for a personal deployment; swap for SQLite/Postgres if you host many users.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256, safeEqualHash } from './pairing.js';

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { hosts: {}, devices: {} };
    if (file && existsSync(file)) this.data = JSON.parse(readFileSync(file, 'utf8'));
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  createHost(name) {
    const hostId = `h_${randomBytes(12).toString('hex')}`;
    const hostToken = randomBytes(32).toString('base64url');
    this.data.hosts[hostId] = { tokenHash: sha256(hostToken).toString('hex'), name: String(name ?? '').slice(0, 64), createdAt: Date.now() };
    this.save();
    return { hostId, hostToken };
  }

  authHost(hostId, token) {
    const h = this.data.hosts[hostId];
    if (!h || typeof token !== 'string') return false;
    return safeEqualHash(sha256(token), Buffer.from(h.tokenHash, 'hex'));
  }

  createDevice(hostId, name) {
    const deviceId = `d_${randomBytes(12).toString('hex')}`;
    const deviceToken = randomBytes(32).toString('base64url');
    this.data.devices[deviceId] = { hostId, tokenHash: sha256(deviceToken).toString('hex'), name: String(name ?? '').slice(0, 64), createdAt: Date.now() };
    this.save();
    return { deviceId, deviceToken };
  }

  /** @returns {null | {hostId:string}} */
  authDevice(deviceId, token) {
    const d = this.data.devices[deviceId];
    if (!d || typeof token !== 'string') return null;
    return safeEqualHash(sha256(token), Buffer.from(d.tokenHash, 'hex')) ? { hostId: d.hostId } : null;
  }

  deviceHost(deviceId) {
    return this.data.devices[deviceId]?.hostId ?? null;
  }

  revokeDevice(hostId, deviceId) {
    const d = this.data.devices[deviceId];
    if (!d || d.hostId !== hostId) return false;
    delete this.data.devices[deviceId];
    this.save();
    return true;
  }

  /** Host is the source of truth for its trusted devices; drop server records it no longer knows. */
  syncDevices(hostId, keepIds) {
    const keep = new Set(keepIds);
    const removed = [];
    for (const [id, d] of Object.entries(this.data.devices)) {
      if (d.hostId === hostId && !keep.has(id)) {
        delete this.data.devices[id];
        removed.push(id);
      }
    }
    if (removed.length) this.save();
    return removed;
  }
}
