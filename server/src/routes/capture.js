import { Router } from 'express';
import { authenticate, requireRole } from '../auth.js';
import { createRetailerScope } from '../scope.js';
import { bodyObject, idField, parseCartItems, clientRefField, textField } from '../validate.js';
import { createOrderService } from '../orders.js';
import { createCaptureService } from '../capture/service.js';

export function createCaptureRouter({ db, config, extractor }) {
  const router = Router();
  const capture = createCaptureService(db, extractor);
  const orders = createOrderService(db);
  const scope = createRetailerScope(db);
  const guard = [authenticate({ db, config }), requireRole('retailer', 'desk')];

  // POST /api/capture { text, retailerId? (desk) }  -> a DRAFT. Saves nothing.
  router.post('/capture', ...guard, async (req, res) => {
    const body = bodyObject(req);
    const retailerId = scope(req, idField(body.retailerId, 'retailerId'));
    res.json(await capture.draft(retailerId, textField(body.text)));
  });

  // POST /api/capture/confirm { items: [{ sku, qty, originalText? }], clientRef?, retailerId? (desk) }
  // The person reviewed the draft and confirmed: only NOW is an order created (source 'ai_text'), through the same
  // transaction as any order (stock, credit hold). The desk still checks and approves it.
  router.post('/capture/confirm', ...guard, (req, res) => {
    const body = bodyObject(req);
    const retailerId = scope(req, idField(body.retailerId, 'retailerId'));
    const items = parseCartItems(body.items, { keepText: true, mergeDuplicates: true });
    const clientRef = clientRefField(body.clientRef);
    const { order, duplicate } = orders.place({ retailerId, items, source: 'ai_text', clientRef });
    res.status(duplicate ? 200 : 201).json({ order, duplicate });
  });

  return router;
}
