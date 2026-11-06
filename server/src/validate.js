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

/** Optional numeric id in a query string (?retailerId=2). Returns null when absent. */
export function idQuery(v, name) {
  if (v === undefined) return null;
  if (typeof v !== 'string' || !/^[1-9]\d{0,8}$/.test(v)) {
    throw new HttpError(400, `invalid_${name}`, `${name} must be a positive whole number`);
  }
  return Number(v);
}

/** Optional numeric id in a JSON body. Must be a real number, not a string. Returns null when absent. */
export function idField(v, name) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < 1) {
    throw new HttpError(400, `invalid_${name}`, `${name} must be a positive whole number`);
  }
  return v;
}

export const MAX_CART_LINES = 50;
export const MAX_QTY_CASES = 9999;

/**
 * Validates a cart: [{ sku, qty }]. Used by cart pricing now and order placement next.
 * Collects EVERY line problem (with its position) so the screen can mark all bad lines at once.
 * Duplicate SKUs are rejected, not merged: schemes depend on the total per SKU, so one line per SKU.
 */
export function parseCartItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, 'invalid_items', 'items must be a non-empty list');
  }
  if (raw.length > MAX_CART_LINES) {
    throw new HttpError(400, 'invalid_items', `A cart can have at most ${MAX_CART_LINES} lines`);
  }
  const problems = [];
  const seen = new Set();
  const items = [];
  raw.forEach((it, index) => {
    const bad = (problem) => problems.push({ index, problem });
    if (it === null || typeof it !== 'object' || Array.isArray(it)) return bad('line must be an object');
    const sku = typeof it.sku === 'string' ? it.sku.trim() : '';
    if (!/^[A-Z0-9-]{3,30}$/.test(sku)) return bad('sku is missing or malformed');
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY_CASES) {
      return bad(`qty must be a whole number of cases from 1 to ${MAX_QTY_CASES}`);
    }
    if (seen.has(sku)) return bad(`duplicate sku ${sku}; use one line per product`);
    seen.add(sku);
    items.push({ sku, qty: it.qty });
  });
  if (problems.length) throw new HttpError(400, 'invalid_items', 'Some cart lines are not valid', problems);
  return items;
}

/** Required numeric id in a URL path (/orders/:id). */
export function idParam(v, name) {
  const id = idQuery(v, name);
  if (id === null) throw new HttpError(400, `invalid_${name}`, `${name} is required`);
  return id;
}

/**
 * Idempotency key for placing an order. The app makes one per cart and re-sends the SAME key on a retry
 * or double tap; the server then returns the first order instead of creating a duplicate.
 */
export function clientRefField(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) {
    throw new HttpError(400, 'invalid_client_ref', 'clientRef must be 8-64 letters, digits, dash or underscore');
  }
  return v;
}

/** ?limit= for lists: 1..max, default def. */
export function limitQuery(v, { def = 20, max = 100 } = {}) {
  if (v === undefined) return def;
  if (typeof v !== 'string' || !/^[1-9]\d{0,3}$/.test(v) || Number(v) > max) {
    throw new HttpError(400, 'invalid_limit', `limit must be a whole number from 1 to ${max}`);
  }
  return Number(v);
}
