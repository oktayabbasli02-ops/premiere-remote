// End-to-end device/host authentication over the WebRTC data channel.
//
// The signaling server relays SDP, so a malicious server could try to MITM the DTLS session
// by substituting fingerprints. To defeat that, both sides sign a transcript containing the
// DTLS fingerprints they actually see, with long-term ECDSA P-256 keys pinned at pairing time
// (device key lives in Android Keystore; host key in DPAPI-protected storage).
// If the server swapped fingerprints, the transcripts differ and verification fails.

import { createPublicKey, createPrivateKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

export const AUTH_CONTEXT = 'PREMIERE-REMOTE-AUTH-V1';

/** Extract the sha-256 DTLS fingerprint from an SDP blob (session- or media-level). */
export function extractFingerprint(sdp) {
  if (typeof sdp !== 'string') return null;
  const m = sdp.match(/^a=fingerprint:sha-256 ([0-9A-Fa-f:]{95})\s*$/m);
  return m ? m[1].toUpperCase() : null;
}

export function buildTranscript({ role, sessionId, hostNonce, deviceNonce, hostFingerprint, deviceFingerprint, deviceId, hostId }) {
  for (const [k, v] of Object.entries({ role, sessionId, hostNonce, deviceNonce, hostFingerprint, deviceFingerprint, deviceId, hostId })) {
    if (typeof v !== 'string' || v.length === 0 || v.includes('|')) throw new Error(`invalid transcript field ${k}`);
  }
  return [AUTH_CONTEXT, role, hostId, deviceId, sessionId, hostNonce, deviceNonce, hostFingerprint, deviceFingerprint].join('|');
}

export function newNonce() {
  return randomBytes(24).toString('base64url');
}

export function generateIdentityKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKeyPkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/** Sign with SHA256withECDSA, DER-encoded signature (same encoding Android's Signature produces). */
export function signTranscript(privateKeyPkcs8B64, transcript) {
  const key = createPrivateKey({ key: Buffer.from(privateKeyPkcs8B64, 'base64'), format: 'der', type: 'pkcs8' });
  return sign('sha256', Buffer.from(transcript, 'utf8'), { key, dsaEncoding: 'der' }).toString('base64');
}

export function verifyTranscript(publicKeySpkiB64, transcript, signatureB64) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
    return verify('sha256', Buffer.from(transcript, 'utf8'), { key, dsaEncoding: 'der' }, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/** Validates that a base64 string is an EC P-256 SPKI public key. */
export function isValidP256Spki(b64) {
  try {
    if (typeof b64 !== 'string' || b64.length > 400) return false;
    const key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}
