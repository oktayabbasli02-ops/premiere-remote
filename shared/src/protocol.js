// Wire protocol constants for Premiere Remote.
// The full message reference lives in docs/PROTOCOL.md; Kotlin mirrors these names in
// android/app/src/main/java/com/premiereremote/app/protocol/Protocol.kt.

export const PROTOCOL_VERSION = 1;

/** Messages on the signaling WebSocket (server <-> host / device). */
export const Sig = Object.freeze({
  HELLO: 'hello',
  WELCOME: 'welcome',
  ERROR: 'error',
  PING: 'ping',
  PONG: 'pong',

  // host only
  PAIRING_CREATE: 'pairing.create',
  PAIRING_CODE: 'pairing.code',
  PAIRING_CANCEL: 'pairing.cancel',
  PAIRING_EXPIRED: 'pairing.expired',
  PAIRING_REQUEST: 'pairing.request',
  PAIRING_DECISION: 'pairing.decision',
  PAIRING_COMPLETED: 'pairing.completed',
  DEVICE_REVOKE: 'device.revoke',
  DEVICE_REVOKED: 'device.revoked',
  DEVICES_SYNC: 'devices.sync',

  // both
  SESSION_REQUEST: 'session.request',
  SESSION_ACCEPT: 'session.accept',
  SESSION_REJECT: 'session.reject',
  SESSION_END: 'session.end',
  SIGNAL: 'signal',
  HOST_STATUS: 'host.status',
});

/** Messages on the WebRTC "control" data channel (reliable, ordered). */
export const Ctl = Object.freeze({
  AUTH_CHALLENGE: 'auth.challenge',
  AUTH_RESPONSE: 'auth.response',
  AUTH_OK: 'auth.ok',
  AUTH_FAIL: 'auth.fail',
  CMD: 'cmd',
  ACK: 'ack',
  CMD_QUERY: 'cmd.query',
  CMD_STATUS: 'cmd.status',
  POINTER: 'ptr',        // discrete pointer events: down/up/click/scroll (reliable)
  KEY: 'key',
  TEXT: 'text',
  STATUS: 'status',
  CAPTURE_SET: 'capture.set',
  QUALITY_SET: 'quality.set',
  PING: 'ping',
  PONG: 'pong',
  NOTICE: 'notice',
  EPOCH: 'epoch',        // phone announces a fresh input epoch after every (re)connect
  BYE: 'bye',
});

/** Messages on the WebRTC "pointer" data channel (unordered, maxRetransmits 0). */
export const Ptr = Object.freeze({
  MOVE: 'move',
  REL: 'rel',
});

export const DataChannels = Object.freeze({
  CONTROL: 'control',
  POINTER: 'pointer',
});

/** Ack statuses for discrete commands. */
export const AckStatus = Object.freeze({
  OK: 'ok',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported',
  FORBIDDEN: 'forbidden',
  IN_PROGRESS: 'in_progress',
});

/** Machine-readable error codes surfaced to the phone (never contain secrets). */
export const ErrorCode = Object.freeze({
  BAD_REQUEST: 'bad_request',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  RATE_LIMITED: 'rate_limited',
  EXPIRED: 'expired',
  HOST_OFFLINE: 'host_offline',
  HOST_REJECTED: 'host_rejected',
  REMOTE_DISABLED: 'remote_disabled',
  PREMIERE_NOT_RUNNING: 'premiere_not_running',
  PLUGIN_NOT_CONNECTED: 'plugin_not_connected',
  NO_PROJECT: 'no_project',
  NO_SEQUENCE: 'no_sequence',
  NO_SELECTION: 'no_selection',
  FOCUS_LOST: 'focus_lost',
  MODAL_DIALOG: 'modal_dialog',
  INPUT_BLOCKED: 'input_blocked',
  SHORTCUT_NOT_CONFIGURED: 'shortcut_not_configured',
  TIMEOUT: 'timeout',
  STALE: 'stale',
  INTERNAL: 'internal',
});

export const QualityProfiles = Object.freeze({
  responsive: { id: 'responsive', label: '720p · 30 fps', maxWidth: 1280, maxHeight: 720, maxFps: 30, maxBitrate: 2_500_000 },
  balanced: { id: 'balanced', label: '1080p · 30 fps', maxWidth: 1920, maxHeight: 1080, maxFps: 30, maxBitrate: 5_000_000 },
  quality: { id: 'quality', label: '1080p · 60 fps', maxWidth: 1920, maxHeight: 1080, maxFps: 60, maxBitrate: 10_000_000 },
  saver: { id: 'saver', label: '540p · 24 fps (mobile data)', maxWidth: 960, maxHeight: 540, maxFps: 24, maxBitrate: 900_000 },
});

export const DEFAULT_QUALITY = 'responsive';

/** Parse a JSON message, returning null instead of throwing on garbage input. */
export function parseMessage(raw, maxBytes = 64 * 1024) {
  if (typeof raw !== 'string') raw = raw?.toString?.('utf8') ?? '';
  if (raw.length === 0 || raw.length > maxBytes) return null;
  try {
    const msg = JSON.parse(raw);
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return null;
    return msg;
  } catch {
    return null;
  }
}

export function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export function isId(v, max = 64) {
  return typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
}
