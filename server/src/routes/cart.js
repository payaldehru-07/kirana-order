import { Router } from 'express';
import { authenticate, requireRole } from '../auth.js';
import { createRetailerScope } from '../scope.js';
import { bodyObject, idField, parseCartItems } from '../validate.js';
import { createSkuRepo } from '../skus.js';
import { quoteCart } from '../cart.js';
import { createCreditRepo, creditPreview } from '../credit.js';

export function createCartRouter({ db, config }) {
  const router = Router();
  const repo = createSkuRepo(db);
  const scope = createRetailerScope(db);
  const creditRepo = createCreditRepo(db);

  // POST /api/cart/price  { items: [{ sku, qty }], retailerId? (desk only) }
  // A preview only: nothing is saved and no stock is reserved.
  router.post('/cart/price', authenticate({ db, config }), requireRole('retailer', 'desk'), (req, res) => {
    const body = bodyObject(req);
    const retailerId = scope(req, idField(body.retailerId, 'retailerId'));
    const items = parseCartItems(body.items);
    const quote = quoteCart(repo, retailerId, items);

    // Credit preview so the cart screen can warn BEFORE the retailer places the order (same rule as placement, A9).
    const credit = creditPreview(creditRepo.snapshot(retailerId), quote.totals.totalPaise);
    res.json({ retailerId, ...quote, credit });
  });

  return router;
}
