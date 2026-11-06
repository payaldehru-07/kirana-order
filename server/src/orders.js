import { HttpError } from './errors.js';
import { inTransaction } from './db.js';
import { createSkuRepo } from './skus.js';
import { createCreditRepo, checkCredit, creditPreview, holdReasonText } from './credit.js';
import { quoteCart } from './cart.js';

// SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. Clients get proper ISO 8601.
const iso = (sqliteTime) => `${sqliteTime.replace(' ', 'T')}Z`;

export function createOrderService(db) {
  const skuRepo = createSkuRepo(db);
  const credit = createCreditRepo(db);

  const insOrder = db.prepare(
    `INSERT INTO orders (retailer_id, source, status, net_paise, gst_paise, total_paise, hold_reason, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insLine = db.prepare(
    `INSERT INTO order_lines (order_id, sku_code, qty_cases, free_cases, case_price_paise, discount_paise, net_paise, gst_paise, original_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const takeStock = db.prepare('UPDATE skus SET stock_cases = stock_cases - ? WHERE code = ?');
  const findByRef = db.prepare('SELECT id FROM orders WHERE retailer_id = ? AND client_ref = ?');
  const getOrder = db.prepare('SELECT * FROM orders WHERE id = ?');
  const getLines = db.prepare(
    `SELECT l.*, s.name, s.name_hi FROM order_lines l JOIN skus s ON s.code = l.sku_code WHERE l.order_id = ? ORDER BY l.id`,
  );
  const listStmt = db.prepare(
    `SELECT o.id, o.status, o.source, o.total_paise, o.created_at,
            (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id) AS line_count
     FROM orders o WHERE o.retailer_id = ? ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
  );

  function toOrder(row) {
    const lines = getLines.all(row.id).map((l) => ({
      id: l.id,
      skuCode: l.sku_code,
      name: l.name,
      nameHi: l.name_hi,
      qty: l.qty_cases,
      freeCases: l.free_cases,
      shippedCases: l.qty_cases + l.free_cases,
      casePricePaise: l.case_price_paise,
      discountPaise: l.discount_paise,
      netPaise: l.net_paise,
      gstPaise: l.gst_paise,
      totalPaise: l.net_paise + l.gst_paise,
      originalText: l.original_text,
    }));
    return {
      id: row.id,
      retailerId: row.retailer_id,
      source: row.source,
      status: row.status,
      holdReason: row.hold_reason,
      deskNote: row.desk_note,
      originalTotalPaise: row.original_total_paise, // set once the desk has edited the order
      exportId: row.export_id,
      createdAt: iso(row.created_at),
      totals: { netPaise: row.net_paise, gstPaise: row.gst_paise, totalPaise: row.total_paise },
      lines,
    };
  }

  return {
    /** Any order by id, no permission check. Only for server-side callers (desk service); routes use getForUser. */
    load(orderId) {
      const row = getOrder.get(orderId);
      if (!row) throw new HttpError(404, 'order_not_found', 'No such order');
      return toOrder(row);
    },

    /**
     * Place an order. Everything below happens in ONE transaction (all-or-nothing):
     *   1. same clientRef already used? -> return that order (double tap / retry)
     *   2. price the cart (scheme engine) from CURRENT prices and stock
     *   3. any line out of stock or short?  -> reject the WHOLE order (409), nothing saved
     *   4. credit check on the GST-inclusive total (A9) -> 'placed' or 'credit_hold'
     *   5. insert order + lines, and reserve the stock (bought + free cases)
     * Credit and stock are read inside the transaction, so two orders can never both use the last stock or
     * the last of the credit.
     * Used by POST /api/orders (source 'app') and later by confirmed AI orders (source 'ai_text').
     */
    place({ retailerId, items, source, clientRef = null }) {
      return inTransaction(db, () => {
        if (clientRef) {
          const existing = findByRef.get(retailerId, clientRef);
          if (existing) return { order: toOrder(getOrder.get(existing.id)), duplicate: true };
        }

        const quote = quoteCart(skuRepo, retailerId, items); // throws 400 unknown_sku

        const short = quote.lines
          .filter((l) => l.stockIssue)
          .map((l) => ({
            index: items.findIndex((i) => i.sku === l.skuCode),
            skuCode: l.skuCode,
            problem: l.stockIssue.type, // 'out_of_stock' | 'insufficient_stock'
            availableCases: l.stockIssue.availableCases,
          }));
        if (short.length) throw new HttpError(409, 'stock_unavailable', 'Some items are out of stock or short', short);

        const snap = credit.snapshot(retailerId);
        const check = checkCredit(snap, quote.totals.totalPaise);
        const status = check.exceeds ? 'credit_hold' : 'placed';
        const holdReason = check.exceeds ? holdReasonText(quote.totals.totalPaise, check.afterOrderPaise, snap.limitPaise) : null;

        const { lastInsertRowid } = insOrder.run(
          retailerId, source, status,
          quote.totals.netPaise, quote.totals.gstPaise, quote.totals.totalPaise,
          holdReason, clientRef,
        );
        const orderId = Number(lastInsertRowid);
        quote.lines.forEach((l, i) => {
          insLine.run(orderId, l.skuCode, l.qty, l.freeCases, l.casePricePaise, l.discountPaise, l.netPaise, l.gstPaise,
            items[i].originalText ?? null);
          takeStock.run(l.shippedCases, l.skuCode); // reserve stock; a held order reserves too (restored if rejected)
        });
        return { order: toOrder(getOrder.get(orderId)), duplicate: false };
      });
    },

    /** One order, if this user may see it. Another retailer's order looks exactly like a missing one (404). */
    getForUser(user, orderId) {
      const row = getOrder.get(orderId);
      if (!row || (user.role === 'retailer' && row.retailer_id !== user.retailerId)) {
        throw new HttpError(404, 'order_not_found', 'No such order');
      }
      return toOrder(row);
    },

    /** Newest first. Summary only; open one order for its lines. */
    listForRetailer(retailerId, limit) {
      return listStmt.all(retailerId, limit).map((r) => ({
        id: r.id,
        status: r.status,
        source: r.source,
        totalPaise: r.total_paise,
        lineCount: r.line_count,
        createdAt: iso(r.created_at),
      }));
    },

    /**
     * "Repeat order": the cart a retailer would get by reordering an old order, priced at TODAY's prices,
     * schemes and stock. Quantities are what was BOUGHT (free cases are not copied; the scheme re-earns them).
     * Nothing is saved. The retailer reviews it, then places it with POST /api/orders.
     */
    repeatQuote(retailerId, order) {
      const qtyBySku = new Map();
      for (const l of order.lines) qtyBySku.set(l.skuCode, (qtyBySku.get(l.skuCode) ?? 0) + l.qty);
      const items = [...qtyBySku].map(([sku, qty]) => ({ sku, qty: Math.min(qty, 9999) }));
      const quote = quoteCart(skuRepo, retailerId, items);
      return { items, quote, credit: creditPreview(credit.snapshot(retailerId), quote.totals.totalPaise) };
    },
  };
}
