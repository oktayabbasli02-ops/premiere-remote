// Minimal static server for the browser test client (loopback only). It also forwards the
// pairing HTTP calls to the signaling server so the page stays same-origin (the signaling
// server deliberately sends no CORS headers). WebSockets go to the signaling server directly.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const port = Number(process.env.PORT ?? 8790);
const signal = process.env.SIGNAL_URL ?? 'http://127.0.0.1:8787';

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/v1/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await fetch(signal + req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
    res.writeHead(r.status, { 'content-type': 'application/json' });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  const name = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (!['index.html', 'client.js'].includes(name)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[name.slice(name.lastIndexOf('.'))] });
  return res.end(await readFile(join(here, name)));
}).listen(port, '127.0.0.1', () => console.log(`test client on http://127.0.0.1:${port} -> ${signal}`));
