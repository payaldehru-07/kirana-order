import { once } from 'node:events';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { seedDb } from '../src/seed.js';
import { createApp } from '../src/app.js';

/** Boots the real app on a random port with a fresh seeded in-memory DB. Each test file gets its own. */
export async function startTestServer(configOverrides = {}) {
  const db = openDb(':memory:');
  seedDb(db);
  const config = { sessionSecret: 'test-secret', tokenTtlSeconds: 3600, ...configOverrides };
  const server = createApp({ db, config }).listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { token, body, headers: extra } = {}) {
    const headers = { ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  // fetch() secretly adds "Cache-Control: no-cache" when If-None-Match is set (Fetch spec), which makes Express
  // skip the 304. node:http sends exactly the headers given, like a browser's normal revalidation.
  const rawGet = (path, headers) => new Promise((resolve, reject) => {
    http.get(base + path, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject);
  });

  const login = async (phone) => (await call('POST', '/api/auth/verify', { body: { phone, otp: '123456' } })).body.token;
  const close = () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); };
  return { db, call, rawGet, login, close, config };
}

// Demo phones from the seed
export const PHONES = {
  sharma: '9000000001', // retailer 1
  gupta: '9000000002',  // retailer 2
  desk: '9000000099',
};
