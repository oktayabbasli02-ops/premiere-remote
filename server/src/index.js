// Entry point. Configuration via environment variables only (see .env.example).
// TLS is terminated by a reverse proxy (Caddy, see deploy/); this process listens on loopback by default.

import { createApp } from './app.js';
import { createLogger } from '@premiere-remote/shared/redact';

const log = createLogger('signal');
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const cfg = {
  dataFile: process.env.PR_DATA_FILE ?? './data/store.json',
  pairingTtlMs: Number(process.env.PR_PAIRING_TTL_SEC ?? 120) * 1000,
  registrationKey: process.env.PR_REGISTRATION_KEY || undefined,
  trustProxy: process.env.PR_TRUST_PROXY === '1',
  turnSecret: process.env.PR_TURN_SECRET || undefined,
  turnUrls: list(process.env.PR_TURN_URLS),
  stunUrls: list(process.env.PR_STUN_URLS ?? 'stun:stun.l.google.com:19302'),
  turnTtlSec: Number(process.env.PR_TURN_TTL_SEC ?? 6 * 3600),
  logger: log,
};

if (!cfg.turnSecret || cfg.turnUrls.length === 0) {
  log.warn('TURN not configured: phones on symmetric-NAT mobile networks will fail to connect');
}

const app = createApp(cfg);
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const addr = await app.listen(port, host);
log.info('listening', { host: addr.address, port: addr.port });

const shutdown = () => app.close().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
