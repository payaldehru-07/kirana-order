import { verifyToken } from './token.js';
import { HttpError } from './errors.js';

/**
 * Middleware: who is calling? Checks the Bearer token, then loads the user from the DATABASE.
 * We trust the DB for role and retailer, not the token: if a user is removed or their role changes,
 * old tokens stop working immediately. The role inside the token is only a convenience for the client UI.
 */
export function authenticate({ db, config }) {
  const getUser = db.prepare('SELECT id, name, role, retailer_id FROM users WHERE id = ?');
  return (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const payload = m ? verifyToken(m[1], config.sessionSecret) : null;
    if (!payload) throw new HttpError(401, 'unauthenticated', 'Please log in');

    const u = getUser.get(payload.uid);
    if (!u || u.role !== payload.role) throw new HttpError(401, 'unauthenticated', 'Please log in again');

    req.user = { id: u.id, name: u.name, role: u.role, retailerId: u.retailer_id };
    next();
  };
}

/** Middleware factory: only the listed roles may continue. Used on every non-public route. */
export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    throw new HttpError(403, 'forbidden', 'You do not have access to this');
  }
  next();
};

/**
 * THE data-isolation rule, in one place. Which retailer's data may this request touch?
 *  - retailer: always their own. Asking for another retailer's id is refused.
 *  - desk: any retailer, but must say which one.
 * Every route that reads prices, credit or orders by retailer goes through this.
 */
export function resolveRetailerId(req, requestedId = null) {
  if (req.user.role === 'retailer') {
    if (requestedId !== null && requestedId !== req.user.retailerId) {
      throw new HttpError(403, 'forbidden', 'You can only see your own shop');
    }
    return req.user.retailerId;
  }
  if (requestedId === null) throw new HttpError(400, 'retailer_required', 'retailerId is required');
  return requestedId;
}
