import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('web client is served same-origin with a strict CSP; traversal and unknown files are refused', async () => {
  const app = createApp({ store: new Store(null), logger: quiet });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const index = await fetch(`${base}/app/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await index.text(), /Premiere Remote/);

    const redirect = await fetch(`${base}/app`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);

    const shared = await fetch(`${base}/app/shared/mapping.js`);
    assert.equal(shared.status, 200);
    assert.match(await shared.text(), /viewToNormalized/);

    // auth.js uses node:crypto and is not exposed; neither is anything outside the web root
    assert.equal((await fetch(`${base}/app/shared/auth.js`)).status, 404);
    assert.equal((await fetch(`${base}/app/%2e%2e/server/src/app.js`)).status, 404);
    assert.equal((await fetch(`${base}/app/..%5c..%5cserver%5csrc%5capp.js`)).status, 404);
    assert.equal((await fetch(`${base}/app/missing.js`)).status, 404);
  } finally {
    await app.close();
  }
});
