import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// The front end is served from server/public. These tests cover the delivery, not the screens:
// gzip (slow 3G), the content-security policy, the shell files, and that /api and path tricks still behave.

async function get(base, path, headers = {}) {
  const res = await fetch(base + path, { headers });
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
}

test('home page is served gzipped with a strict content-security policy', async () => {
  const s = await startTestServer();
  const { res, buf } = await get(s.base, '/', { 'accept-encoding': 'gzip' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  // fetch() un-gzips the body for us, so buf is already the HTML; the headers above prove it travelled compressed.
  assert.match(buf.toString(), /<main id="main">/);
  await s.close();
});

test('every shell file exists and the whole front end stays under 100 KB', async () => {
  const s = await startTestServer();
  let total = 0;
  for (const f of ['/', '/style.css', '/i18n.js', '/app.js', '/sw.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png']) {
    const { res, buf } = await get(s.base, f, { 'accept-encoding': 'identity' });
    assert.equal(res.status, 200, f);
    total += buf.length;
  }
  assert.ok(total < 100 * 1024, `front end is ${total} bytes`);
  await s.close();
});

test('the browser can re-check a file with an ETag and get a tiny 304', async () => {
  const s = await startTestServer();
  const first = await get(s.base, '/app.js', { 'accept-encoding': 'gzip' });
  const again = await s.rawGet('/app.js', { 'accept-encoding': 'gzip', 'if-none-match': first.res.headers.get('etag') });
  assert.equal(again.status, 304);
  await s.close();
});

test('API responses are not given the page policy, and unknown API paths are still JSON 404s', async () => {
  const s = await startTestServer();
  const r = await s.call('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'not_found');
  assert.equal(r.headers.get('content-security-policy'), null);
  await s.close();
});

test('path tricks cannot read files outside public/', async () => {
  const s = await startTestServer();
  for (const p of ['/..%2fsrc%2fconfig.js', '/%2e%2e/src/config.js', '/.env', '/../package.json']) {
    const { res } = await get(s.base, p, { 'accept-encoding': 'gzip' });
    assert.notEqual(res.status, 200, p);
  }
  await s.close();
});
