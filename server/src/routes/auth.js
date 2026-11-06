import { Router } from 'express';
import { MOCK_OTP } from '../config.js';
import { HttpError } from '../errors.js';
import { signToken } from '../token.js';
import { authenticate } from '../auth.js';
import { createCreditRepo } from '../credit.js';
import { bodyObject, phoneField, otpField } from '../validate.js';

/**
 * Brute-force guard: 5 wrong OTPs for a phone locks that phone for 5 minutes.
 * In memory, per process (fine for one server). Trade-off: someone can lock out a known number.
 * Production would use a real SMS OTP that expires, plus per-IP limits.
 */
function createAttemptLimiter({ max = 5, lockMs = 5 * 60_000, now = () => Date.now() } = {}) {
  const fails = new Map(); // phone -> { count, lockedUntil }
  return {
    isLocked(key) {
      const e = fails.get(key);
      if (!e) return false;
      if (e.lockedUntil && e.lockedUntil <= now()) { fails.delete(key); return false; }
      return Boolean(e.lockedUntil);
    },
    fail(key) {
      const e = fails.get(key) ?? { count: 0, lockedUntil: 0 };
      e.count += 1;
      if (e.count >= max) e.lockedUntil = now() + lockMs;
      fails.set(key, e);
    },
    clear(key) { fails.delete(key); },
  };
}

export function createAuthRouter({ db, config }) {
  const router = Router();
  const limiter = createAttemptLimiter();
  const credit = createCreditRepo(db);
  const findUser = db.prepare('SELECT id, name, role, retailer_id FROM users WHERE phone = ?');
  const getRetailer = db.prepare(
    'SELECT shop_name, owner_name, area, salesman FROM retailers WHERE id = ?',
  );

  // Step 1 of login. Mock: nothing is sent. Same answer for known and unknown numbers (no user enumeration).
  router.post('/auth/request-otp', (req, res) => {
    phoneField(bodyObject(req).phone);
    res.json({ ok: true, message: 'OTP sent' });
  });

  // Step 2 of login: phone + OTP -> session token.
  router.post('/auth/verify', (req, res) => {
    const body = bodyObject(req);
    const phone = phoneField(body.phone);
    const otp = otpField(body.otp);

    if (limiter.isLocked(phone)) {
      throw new HttpError(429, 'too_many_attempts', 'Too many wrong attempts. Try again in a few minutes.');
    }
    const user = findUser.get(phone);
    // Same error for "unknown number" and "wrong OTP" so an attacker cannot probe which numbers exist.
    if (!user || otp !== MOCK_OTP) {
      limiter.fail(phone);
      throw new HttpError(401, 'invalid_credentials', 'Wrong phone number or OTP');
    }
    limiter.clear(phone);

    const token = signToken({ uid: user.id, role: user.role, rid: user.retailer_id }, config.sessionSecret, config.tokenTtlSeconds);
    res.json({
      token,
      expiresInSeconds: config.tokenTtlSeconds,
      user: { id: user.id, name: user.name, role: user.role, retailerId: user.retailer_id },
    });
  });

  // Who am I? A retailer also gets their own shop and credit. Nobody else's.
  router.get('/me', authenticate({ db, config }), (req, res) => {
    const { id, name, role, retailerId } = req.user;
    const out = { user: { id, name, role, retailerId } };
    if (role === 'retailer') {
      const r = getRetailer.get(retailerId);
      const c = credit.snapshot(retailerId);
      out.retailer = {
        shopName: r.shop_name,
        ownerName: r.owner_name,
        area: r.area,
        salesman: r.salesman,
        creditLimitPaise: c.limitPaise,
        outstandingPaise: c.outstandingPaise,
        pendingPaise: c.pendingPaise,           // orders placed/approved, not yet in Tally (A9)
        availableCreditPaise: c.availablePaise, // what they can still order on credit right now
      };
    }
    res.json(out);
  });

  return router;
}
