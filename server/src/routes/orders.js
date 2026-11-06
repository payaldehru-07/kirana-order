import { Router } from 'express';
import { authenticate, requireRole } from '../auth.js';
import { createRetailerScope } from '../scope.js';
import { bodyObject, idField, idQuery, idParam, parseCartItems, clientRefField, limitQuery } from '../validate.js';
import { createOrderService } from '../orders.js';

export function createOrdersRouter({ db, config }) {
  const router = Router();
  const orders = createOrderService(db);
  const scope = createRetailerScope(db);
  const auth = authenticate({ db, config });

  // POST /api/orders  { items: [{ sku, qty }], clientRef? }   -> retailers only
  // 201 = new order ('placed' or 'credit_hold'). 200 + duplicate:true = this clientRef was already used.
  // 409 stock_unavailable = nothing saved; details say which lines are short.
  router.post('/orders', auth, requireRole('retailer'), (req, res) => {
    const body = bodyObject(req);
    const retailerId = scope(req, idField(body.retailerId, 'retailerId')); // a retailer can only ever order for themselves
    const items = parseCartItems(body.items);
    const clientRef = clientRefField(body.clientRef);
    const { order, duplicate } = orders.place({ retailerId, items, source: 'app', clientRef });
    res.status(duplicate ? 200 : 201).json({ order, duplicate });
  });

  // GET /api/orders?limit=20            (retailer: own history; desk: add ?retailerId=)
  router.get('/orders', auth, requireRole('retailer', 'desk'), (req, res) => {
    const retailerId = scope(req, idQuery(req.query.retailerId, 'retailerId'));
    const limit = limitQuery(req.query.limit);
    res.json({ retailerId, orders: orders.listForRetailer(retailerId, limit) });
  });

  // GET /api/orders/:id   (retailer: only their own, else 404; desk: any)
  router.get('/orders/:id', auth, requireRole('retailer', 'desk'), (req, res) => {
    res.json({ order: orders.getForUser(req.user, idParam(req.params.id, 'orderId')) });
  });

  // GET /api/orders/:id/repeat   (retailers, own orders only)
  // Today's prices, schemes and stock for the same items. Saves nothing; place it via POST /api/orders.
  router.get('/orders/:id/repeat', auth, requireRole('retailer'), (req, res) => {
    const order = orders.getForUser(req.user, idParam(req.params.id, 'orderId'));
    const { items, quote, credit } = orders.repeatQuote(req.user.retailerId, order);
    res.json({ sourceOrderId: order.id, retailerId: req.user.retailerId, items, ...quote, credit });
  });

  return router;
}
