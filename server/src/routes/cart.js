import { Router } from 'express';
import { authenticate, requireRole } from '../auth.js';
import { createRetailerScope } from '../scope.js';
import { bodyObject, idField, parseCartItems } from '../validate.js';
import { createSkuRepo } from '../skus.js';
import { quoteCart } from '../cart.js';

export function createCartRouter({ db, config }) {
  const router = Router();
  const repo = createSkuRepo(db);
  const scope = createRetailerScope(db);

  // POST /api/cart/price  { items: [{ sku, qty }], retailerId? (desk only) }
  // A preview only: nothing is saved and no stock is reserved.
  router.post('/cart/price', authenticate({ db, config }), requireRole('retailer', 'desk'), (req, res) => {
    const body = bodyObject(req);
    const retailerId = scope(req, idField(body.retailerId, 'retailerId'));
    const items = parseCartItems(body.items);
    res.json({ retailerId, ...quoteCart(repo, retailerId, items) });
  });

  return router;
}
