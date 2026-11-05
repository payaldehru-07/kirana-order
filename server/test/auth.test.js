import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, PHONES } from './helpers.js';
import { requireRole, resolveRetailerId } from '../src/auth.js';
import { HttpError } from '../src/errors.js';

let s;
before(async () => { s = await startTestServer(); });
after(() => s.close());

test('health check is public', async () => {
  const r = await s.call('GET', '/api/health');
  assert.equal(r.status, 200);
});

test('login with the right OTP returns a token and role', async () => {
  const r = await s.call('POST', '/api/auth/verify', { body: { phone: PHONES.sharma, otp: '123456' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'retailer');
  assert.equal(r.body.user.retailerId, 1);
  assert.ok(r.body.token);
});

test('desk login has no retailerId', async () => {
  const r = await s.call('POST', '/api/auth/verify', { body: { phone: PHONES.desk, otp: '123456' } });
  assert.equal(r.body.user.role, 'desk');
  assert.equal(r.body.user.retailerId, null);
});

test('wrong OTP and unknown phone give the SAME error (no number probing)', async () => {
  const wrong = await s.call('POST', '/api/auth/verify', { body: { phone: PHONES.sharma, otp: '000000' } });
  const unknown = await s.call('POST', '/api/auth/verify', { body: { phone: '9999999999', otp: '123456' } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test('input validation: bad phone, bad OTP, missing or non-object body', async () => {
  const cases = [
    [{ phone: '12345', otp: '123456' }, 'invalid_phone'],
    [{ phone: 12345678901, otp: '123456' }, 'invalid_phone'],
    [{ phone: PHONES.sharma, otp: '12' }, 'invalid_otp'],
    [{ phone: PHONES.sharma, otp: 123456 }, 'invalid_otp'], // number, not string
    [{}, 'invalid_phone'],
    [[1, 2], 'invalid_body'],
  ];
  for (const [body, code] of cases) {
    const r = await s.call('POST', '/api/auth/verify', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error.code, code);
  }
  const noBody = await s.call('POST', '/api/auth/verify');
  assert.equal(noBody.status, 400);
  const badJson = await s.call('POST', '/api/auth/verify', { body: '{not json' });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error.code, 'invalid_json');
});

test('5 wrong OTPs lock the phone, even for the right OTP afterwards', async () => {
  const phone = PHONES.gupta;
  for (let i = 0; i < 5; i++) {
    const r = await s.call('POST', '/api/auth/verify', { body: { phone, otp: '111111' } });
    assert.equal(r.status, 401);
  }
  const locked = await s.call('POST', '/api/auth/verify', { body: { phone, otp: '123456' } });
  assert.equal(locked.status, 429);
});

test('/api/me needs a valid token', async () => {
  assert.equal((await s.call('GET', '/api/me')).status, 401);
  assert.equal((await s.call('GET', '/api/me', { token: 'garbage' })).status, 401);
});

test('/api/me: a retailer sees only their own shop and credit', async () => {
  const token = await s.login(PHONES.sharma);
  const r = await s.call('GET', '/api/me', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.retailer.shopName, 'Sharma Kirana Store');
  assert.equal(r.body.retailer.creditLimitPaise, 6_000_000);
  assert.equal(r.body.retailer.outstandingPaise, 1_200_000);
});

test('/api/me: desk gets no retailer block', async () => {
  const token = await s.login(PHONES.desk);
  const r = await s.call('GET', '/api/me', { token });
  assert.equal(r.body.user.role, 'desk');
  assert.equal(r.body.retailer, undefined);
});

test('a token for a user that no longer exists is rejected', async () => {
  const token = await s.login(PHONES.sharma);
  s.db.exec('PRAGMA foreign_keys = OFF; DELETE FROM users WHERE phone = \'9000000001\'; PRAGMA foreign_keys = ON;');
  assert.equal((await s.call('GET', '/api/me', { token })).status, 401);
});

test('a token whose role no longer matches the DB is rejected', async () => {
  const token = await s.login(PHONES.desk);
  s.db.exec("UPDATE users SET role = 'retailer', retailer_id = 3 WHERE phone = '9000000099'");
  assert.equal((await s.call('GET', '/api/me', { token })).status, 401);
});

test('unknown API route returns JSON 404', async () => {
  const r = await s.call('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'not_found');
});

// ---- the isolation helpers, tested directly ----
const fake = (role, retailerId) => ({ user: { role, retailerId } });

test('requireRole lets the right role through and blocks others with 403', () => {
  let passed = false;
  requireRole('desk')(fake('desk', null), {}, () => { passed = true; });
  assert.ok(passed);
  assert.throws(() => requireRole('desk')(fake('retailer', 1), {}, () => {}), (e) => e instanceof HttpError && e.status === 403);
});

test('resolveRetailerId: retailer is pinned to their own id', () => {
  assert.equal(resolveRetailerId(fake('retailer', 1)), 1);
  assert.equal(resolveRetailerId(fake('retailer', 1), 1), 1);
  assert.throws(() => resolveRetailerId(fake('retailer', 1), 2), (e) => e.status === 403);
});

test('resolveRetailerId: desk may pick any retailer but must name one', () => {
  assert.equal(resolveRetailerId(fake('desk', null), 3), 3);
  assert.throws(() => resolveRetailerId(fake('desk', null)), (e) => e.status === 400);
});
