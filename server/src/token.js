import { createHmac, timingSafeEqual } from 'node:crypto';

// A tiny signed session token: base64url(JSON payload) + "." + HMAC-SHA256 signature.
// Stateless: the server only needs the secret to check one. Same idea as a JWT, without the dependency.

const sign = (body, secret) => createHmac('sha256', secret).update(body).digest('base64url');

export function signToken(payload, secret, ttlSeconds, nowMs = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(nowMs / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/** Returns the payload, or null for anything wrong (malformed, tampered, expired). Never throws. */
export function verifyToken(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null; // constant-time compare

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return null;
  return payload;
}
