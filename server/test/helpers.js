import { once } from 'node:events';
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

  async function call(method, path, { token, body } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const login = async (phone) => (await call('POST', '/api/auth/verify', { body: { phone, otp: '123456' } })).body.token;
  const close = () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); };
  return { db, call, login, close, config };
}

// Demo phones from the seed
export const PHONES = {
  sharma: '9000000001', // retailer 1
  gupta: '9000000002',  // retailer 2
  desk: '9000000099',
};
