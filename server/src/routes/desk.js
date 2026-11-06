import { Router } from 'express';
import { authenticate, requireRole } from '../auth.js';
import { bodyObject, idQuery, idParam, parseCartItems, limitQuery, enumQuery, noteField } from '../validate.js';
import { createOrderService } from '../orders.js';
import { createDeskService, STATUSES } from '../desk.js';
import { tallyXml, tallyCsv } from '../tally.js';

export function createDeskRouter({ db, config }) {
  const router = Router();
  const desk = createDeskService(db, createOrderService(db));
  // Every desk route: logged in AND role = desk. Retailers get 403 on all of them.
  const guard = [authenticate({ db, config }), requireRole('desk')];

  // GET /api/desk/orders?status=credit_hold&retailerId=2&limit=50   (status=credit_hold is the holds queue)
  router.get('/desk/orders', ...guard, (req, res) => {
    const status = enumQuery(req.query.status, 'status', STATUSES);
    const retailerId = idQuery(req.query.retailerId, 'retailerId');
    const limit = limitQuery(req.query.limit, { def: 50, max: 200 });
    res.json({ orders: desk.list({ status, retailerId, limit }) });
  });

  router.get('/desk/orders/:id', ...guard, (req, res) => {
    res.json(desk.detail(idParam(req.params.id, 'orderId')));
  });

  router.post('/desk/orders/:id/approve', ...guard, (req, res) => {
    res.json({ order: desk.approve(idParam(req.params.id, 'orderId')) });
  });

  // body: { reason? }
  router.post('/desk/orders/:id/reject', ...guard, (req, res) => {
    const reason = req.body === undefined ? null : noteField(bodyObject(req).reason);
    res.json({ order: desk.reject(idParam(req.params.id, 'orderId'), reason) });
  });

  // body: { items: [{ sku, qty, originalText? }] } replaces all lines. Response shows old and new totals.
  router.put('/desk/orders/:id/lines', ...guard, (req, res) => {
    const items = parseCartItems(bodyObject(req).items, { keepText: true });
    res.json(desk.editLines(idParam(req.params.id, 'orderId'), items));
  });

  // ---- Tally ----
  router.post('/desk/exports', ...guard, (req, res) => {
    res.status(201).json({ export: desk.createExport() });
  });

  router.get('/desk/exports', ...guard, (req, res) => {
    res.json({ exports: desk.listExports() });
  });

  // GET /api/desk/exports/3/file?format=xml|csv  (download; works again and again for the same batch)
  router.get('/desk/exports/:id/file', ...guard, (req, res) => {
    const id = idParam(req.params.id, 'exportId');
    const format = enumQuery(req.query.format, 'format', ['xml', 'csv']) ?? 'xml';
    const orders = desk.exportOrders(id);
    res.set('Content-Disposition', `attachment; filename="tally-export-${id}.${format}"`);
    if (format === 'csv') res.type('text/csv; charset=utf-8').send(tallyCsv(orders));
    else res.type('application/xml; charset=utf-8').send(tallyXml(orders));
  });

  return router;
}
