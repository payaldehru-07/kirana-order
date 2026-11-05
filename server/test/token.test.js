import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../src/token.js';

const SECRET = 's3cret';

test('a fresh token verifies and carries its payload', () => {
  const t = signToken({ uid: 7, role: 'desk' }, SECRET, 60);
  const p = verifyToken(t, SECRET);
  assert.equal(p.uid, 7);
  assert.equal(p.role, 'desk');
});

test('token signed with another secret is rejected', () => {
  assert.equal(verifyToken(signToken({ uid: 1 }, 'other', 60), SECRET), null);
});

test('tampering with the payload is rejected (role escalation attempt)', () => {
  const t = signToken({ uid: 1, role: 'retailer' }, SECRET, 60);
  const [, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 1, role: 'desk', exp: 9999999999 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${sig}`, SECRET), null);
});

test('expired token is rejected', () => {
  const t = signToken({ uid: 1 }, SECRET, 60, 1_000_000);
  assert.notEqual(verifyToken(t, SECRET, 1_000_000 + 59_000), null);
  assert.equal(verifyToken(t, SECRET, 1_000_000 + 61_000), null);
});

test('garbage input returns null and never throws', () => {
  for (const bad of [undefined, null, 42, '', 'abc', 'a.b.c', '.', 'x.y']) {
    assert.equal(verifyToken(bad, SECRET), null);
  }
});
