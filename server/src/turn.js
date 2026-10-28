// Time-limited TURN credentials (coturn "use-auth-secret" / TURN REST API draft).
// The static shared secret stays on the server; clients receive an HMAC credential that
// expires, so a leaked credential cannot be used to run an open relay indefinitely.

import { createHmac } from 'node:crypto';

export function turnCredentials({ secret, urls, stunUrls = [], ttlSec = 6 * 3600, subject, now = Date.now }) {
  const iceServers = [];
  if (stunUrls.length) iceServers.push({ urls: stunUrls });
  if (secret && urls.length) {
    const expiry = Math.floor(now() / 1000) + ttlSec;
    const username = `${expiry}:${subject}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    iceServers.push({ urls, username, credential });
  }
  return iceServers;
}
