// Serves the iPhone/iPad web client (PWA) at /app/ from the same origin as the API, so the page needs
// no CORS, gets a secure context (HTTPS behind Caddy) for WebCrypto/service worker, and never has to
// ask the user for a server URL. Pure browser-safe shared modules are exposed under /app/shared/.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const SHARED_FILES = new Set(['protocol.js', 'mapping.js', 'commands.js']);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  // same-origin signaling WebSocket (explicit for Safari, which does not map 'self' to ws/wss)
  "connect-src 'self' wss: ws://127.0.0.1:* ws://localhost:*",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

export function createStaticHandler({ webRoot } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = webRoot ?? join(here, '..', '..', 'web-client');
  const sharedRoot = dirname(fileURLToPath(import.meta.resolve('@premiere-remote/shared/protocol')));

  /** @returns {Promise<boolean>} true when the request was handled */
  return async function serve(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (url.pathname === '/app') {
      res.writeHead(301, { location: '/app/' });
      res.end();
      return true;
    }
    if (!url.pathname.startsWith('/app/')) return false;

    let rel = decodeURIComponent(url.pathname.slice('/app/'.length)) || 'index.html';
    let base = root;
    if (rel.startsWith('shared/')) {
      const name = rel.slice('shared/'.length);
      if (!SHARED_FILES.has(name)) return notFound(res);
      base = sharedRoot;
      rel = name;
    }
    const file = normalize(join(base, rel));
    if (!file.startsWith(base + sep) || !TYPES[extname(file)]) return notFound(res);
    let body;
    try {
      body = await readFile(file);
    } catch {
      return notFound(res);
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)],
      'cache-control': 'no-cache', // the service worker handles offline caching
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // the pairing code travels in the URL fragment, which is never sent to the server
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
  return true;
}
