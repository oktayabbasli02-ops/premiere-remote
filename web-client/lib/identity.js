// Device identity and credentials for the web client.
// Browser equivalent of Android Keystore: a non-extractable ECDSA P-256 key and a non-extractable
// AES-GCM key, both kept as CryptoKey objects in IndexedDB. Weaker than Secure Enclave/Keychain
// (any script on this origin could *use* them), which is why the page ships a strict CSP and
// loads no third-party code.

import { get, set, del } from './idb.js';

export const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (s) => new TextEncoder().encode(s);

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

async function deviceKey() {
  let k = await get('deviceKey');
  if (!k) {
    k = await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']);
    await set('deviceKey', k);
  }
  return k;
}

export async function publicKeySpki() {
  const k = await deviceKey();
  return b64(await crypto.subtle.exportKey('spki', k.publicKey));
}

/** Same short key ID the PC shows (SHA-256 of SPKI, first 8 hex). */
export async function keyHash(spkiB64) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', unb64(spkiB64)));
  const hex = [...h].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

// WebCrypto ECDSA uses raw r||s; the protocol (Node, Android, iOS CryptoKit) uses DER.
export function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = Uint8Array.from([0, ...v]);
    return [0x02, v.length, ...v];
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

export function derToRaw(der) {
  if (der[0] !== 0x30) throw new Error('bad DER');
  let i = 2;
  const read = () => {
    if (der[i++] !== 0x02) throw new Error('bad DER');
    const len = der[i++];
    let v = der.slice(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = read();
  const s = read();
  return Uint8Array.from([...r, ...s]);
}

export async function signTranscript(t) {
  const k = await deviceKey();
  const raw = new Uint8Array(await crypto.subtle.sign(SIGN, k.privateKey, enc(t)));
  return b64(rawToDer(raw));
}

export async function verifyHost(hostSpkiB64, t, sigDerB64) {
  try {
    const key = await crypto.subtle.importKey('spki', unb64(hostSpkiB64), ECDSA, false, ['verify']);
    return await crypto.subtle.verify(SIGN, key, derToRaw(unb64(sigDerB64)), enc(t));
  } catch {
    return false;
  }
}

export function newNonce() {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}

export const transcript = (role, x) => {
  const f = [role, x.hostId, x.deviceId, x.sessionId, x.hostNonce, x.deviceNonce, x.hostFp, x.deviceFp];
  if (f.some((v) => typeof v !== 'string' || !v || v.includes('|'))) throw new Error('invalid transcript field');
  return ['PREMIERE-REMOTE-AUTH-V1', ...f].join('|');
};

export const fingerprint = (sdp) => (sdp.match(/^a=fingerprint:sha-256 ([0-9A-Fa-f:]{95})\s*$/m) || [])[1]?.toUpperCase() ?? null;

// ---- encrypted token storage
async function tokenKey() {
  let k = await get('tokenKey');
  if (!k) {
    k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await set('tokenKey', k);
  }
  return k;
}

export async function saveHost(host, deviceToken) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await tokenKey(), enc(deviceToken));
  await set(`token:${host.hostId}`, { iv, data });
  const hosts = (await listHosts()).filter((h) => h.hostId !== host.hostId);
  await set('hosts', [...hosts, host]);
}

export async function loadToken(hostId) {
  const t = await get(`token:${hostId}`);
  if (!t) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: t.iv }, await tokenKey(), t.data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export async function listHosts() {
  return (await get('hosts')) ?? [];
}

export async function forgetHost(hostId) {
  await del(`token:${hostId}`);
  await set('hosts', (await listHosts()).filter((h) => h.hostId !== hostId));
}
