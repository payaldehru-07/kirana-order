import { resolveRetailerId } from './auth.js';
import { HttpError } from './errors.js';

/**
 * Returns a function (req, requestedId) -> retailerId that
 *  1) applies the isolation rule (retailer = own shop only; desk must name one), then
 *  2) makes sure that retailer really exists, so desk typos give 404 instead of an empty or wrongly priced result.
 */
export function createRetailerScope(db) {
  const exists = db.prepare('SELECT 1 FROM retailers WHERE id = ?');
  return (req, requestedId = null) => {
    const id = resolveRetailerId(req, requestedId);
    if (!exists.get(id)) throw new HttpError(404, 'retailer_not_found', 'No such retailer');
    return id;
  };
}
