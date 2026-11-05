import { HttpError } from './errors.js';

// Small hand-written validators. Every route calls these BEFORE touching the database.

export function bodyObject(req) {
  const b = req.body;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    throw new HttpError(400, 'invalid_body', 'Request body must be a JSON object');
  }
  return b;
}

/** Indian mobile number: 10 digits starting 6-9. Returned trimmed. */
export function phoneField(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^[6-9]\d{9}$/.test(s)) throw new HttpError(400, 'invalid_phone', 'Enter a 10-digit mobile number');
  return s;
}

export function otpField(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^\d{6}$/.test(s)) throw new HttpError(400, 'invalid_otp', 'OTP must be 6 digits');
  return s;
}
