import { HttpError } from './errors.js';
import { inTransaction } from './db.js';
import { createSkuRepo } from './skus.js';
import { createCreditRepo, checkCredit, holdReasonText } from './credit.js';
import { quoteCart } from './cart.js';
import { itemPhrase, phraseKey } from './capture/text.js';

export const STATUSES = ['placed', 'credit_hold', 'approved', 'rejected', 'exported'];

/**
 * Everything the order desk does. Order life cycle:
 *   placed / credit_hold  --approve-->  approved  --export-->  exported
 *   placed / credit_hold / approved  --reject-->  rejected  (reserved stock goes back)
 *   placed / credit_hold  --edit lines-->  same status (a placed order that now breaks the limit becomes credit_hold)
 * Every change runs in one transaction and checks the current status INSIDE it.
 */
/** Short summary of a set of orders for the Tally screen: count, total, and one small row per order. */
const brief = (rows) => ({
  orderCount: rows.length,
  totalPaise: rows.reduce((a, r) => a + r.total_paise, 0),
  orders: rows.map((r) => ({ id: r.id, shopName: r.shop_name, totalPaise: r.total_paise })),
});

export function createDeskService(db, orders) {
  const skuRepo = createSkuRepo(db);
  const credit = createCreditRepo(db);

  const getRow = db.prepare('SELECT * FROM orders WHERE id = ?');
  const rawLines = db.prepare('SELECT sku_code, qty_cases, free_cases, original_text FROM order_lines WHERE order_id = ? ORDER BY id');
  const giveBack = db.prepare('UPDATE skus SET stock_cases = stock_cases + ? WHERE code = ?');
  const takeStock = db.prepare('UPDATE skus SET stock_cases = stock_cases - ? WHERE code = ?');
  const delLines = db.prepare('DELETE FROM order_lines WHERE order_id = ?');
  const insLine = db.prepare(
    `INSERT INTO order_lines (order_id, sku_code, qty_cases, free_cases, case_price_paise, discount_paise, net_paise, gst_paise, original_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertAlias = db.prepare(
    `INSERT INTO aliases (retailer_id, phrase, sku_code) VALUES (?, ?, ?)
     ON CONFLICT(retailer_id, phrase) DO UPDATE SET sku_code = excluded.sku_code`,
  );
  const getRetailer = db.prepare('SELECT id, shop_name, owner_name, area, salesman FROM retailers WHERE id = ?');

  const must = (id) => {
    const row = getRow.get(id);
    if (!row) throw new HttpError(404, 'order_not_found', 'No such order');
    return row;
  };
  const wrongStatus = (row, action) =>
    new HttpError(409, 'invalid_status', `Cannot ${action} an order that is ${row.status}`);

  const iso = (t) => `${t.replace(' ', 'T')}Z`;
  const listStmt = db.prepare(
    `SELECT o.id, o.retailer_id, r.shop_name, o.status, o.source, o.total_paise, o.hold_reason, o.created_at,
            (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id) AS line_count
     FROM orders o JOIN retailers r ON r.id = o.retailer_id
     WHERE (?1 IS NULL OR o.status = ?1) AND (?2 IS NULL OR o.retailer_id = ?2)
     ORDER BY o.created_at DESC, o.id DESC LIMIT ?3`,
  );

  /** Credit position as if THIS order were not yet counted (a 'placed' order is already inside pending). */
  function creditCheckFor(row, totalPaise) {
    const snap = credit.snapshot(row.retailer_id);
    const others = snap.exposurePaise - (row.status === 'placed' ? row.total_paise : 0);
    const check = checkCredit({ ...snap, exposurePaise: others }, totalPaise);
    return { snap, check };
  }

  return {
    list({ status, retailerId, limit }) {
      return listStmt.all(status, retailerId, limit).map((r) => ({
        id: r.id, retailerId: r.retailer_id, shopName: r.shop_name, status: r.status, source: r.source,
        totalPaise: r.total_paise, holdReason: r.hold_reason, lineCount: r.line_count, createdAt: iso(r.created_at),
      }));
    },

    /** Order + who ordered + their credit position + would it break the limit right now. */
    detail(id) {
      const row = must(id);
      const { snap, check } = creditCheckFor(row, row.total_paise);
      const r = getRetailer.get(row.retailer_id);
      return {
        order: orders.load(id),
        retailer: { id: r.id, shopName: r.shop_name, ownerName: r.owner_name, area: r.area, salesman: r.salesman },
        credit: { limitPaise: snap.limitPaise, outstandingPaise: snap.outstandingPaise, pendingPaise: snap.pendingPaise },
        creditCheck: { exceedsLimit: check.exceeds, afterOrderPaise: check.afterOrderPaise, overByPaise: check.overByPaise },
      };
    },

    /** The desk decides: a credit_hold can be approved even over the limit (manual override). */
    approve(id) {
      return inTransaction(db, () => {
        const row = must(id);
        if (row.status !== 'placed' && row.status !== 'credit_hold') throw wrongStatus(row, 'approve');
        db.prepare("UPDATE orders SET status = 'approved' WHERE id = ?").run(id);
        return orders.load(id);
      });
    },

    /** Reject gives the reserved stock (bought + free cases) back. */
    reject(id, reason) {
      return inTransaction(db, () => {
        const row = must(id);
        if (!['placed', 'credit_hold', 'approved'].includes(row.status)) throw wrongStatus(row, 'reject');
        for (const l of rawLines.all(id)) giveBack.run(l.qty_cases + l.free_cases, l.sku_code);
        db.prepare("UPDATE orders SET status = 'rejected', desk_note = ? WHERE id = ?").run(reason, id);
        return orders.load(id);
      });
    },

    /**
     * Replace an order's lines. Steps: give old stock back -> reprice with today's schemes -> refuse if stock is short
     * (the rollback restores everything) -> save lines, reserve stock -> re-run the credit check.
     * The desk still approves manually: a held order stays held even if it now fits.
     * A line that carries originalText and now points to a DIFFERENT sku than before is a correction:
     * it becomes an alias for that retailer, so the next message with those words maps correctly.
     */
    editLines(id, items) {
      return inTransaction(db, () => {
        const row = must(id);
        if (row.status !== 'placed' && row.status !== 'credit_hold') {
          throw new HttpError(409, 'order_not_editable', `An order that is ${row.status} cannot be edited`);
        }
        const old = rawLines.all(id);
        const previousSku = new Map();
        for (const l of old) if (l.original_text) previousSku.set(phraseKey(itemPhrase(l.original_text)), l.sku_code);
        for (const l of old) giveBack.run(l.qty_cases + l.free_cases, l.sku_code);

        const quote = quoteCart(skuRepo, row.retailer_id, items); // 400 on unknown sku
        const short = quote.lines.filter((l) => l.stockIssue).map((l) => ({
          index: items.findIndex((i) => i.sku === l.skuCode), skuCode: l.skuCode,
          problem: l.stockIssue.type, availableCases: l.stockIssue.availableCases,
        }));
        if (short.length) throw new HttpError(409, 'stock_unavailable', 'Some items are out of stock or short', short);

        const { snap, check } = creditCheckFor(row, quote.totals.totalPaise);
        delLines.run(id);
        quote.lines.forEach((l, i) => {
          insLine.run(id, l.skuCode, l.qty, l.freeCases, l.casePricePaise, l.discountPaise, l.netPaise, l.gstPaise, items[i].originalText ?? null);
          takeStock.run(l.shippedCases, l.skuCode);
        });

        const status = check.exceeds ? 'credit_hold' : row.status;
        let holdReason = null;
        if (check.exceeds) holdReason = holdReasonText(quote.totals.totalPaise, check.afterOrderPaise, snap.limitPaise);
        else if (status === 'credit_hold') holdReason = 'Within the credit limit after the desk edit; approve to release.';
        db.prepare(
          `UPDATE orders SET net_paise = ?, gst_paise = ?, total_paise = ?, status = ?, hold_reason = ?,
                  original_total_paise = COALESCE(original_total_paise, ?) WHERE id = ?`,
        ).run(quote.totals.netPaise, quote.totals.gstPaise, quote.totals.totalPaise, status, holdReason, row.total_paise, id);

        const aliasesLearned = [];
        for (const it of items) {
          if (!it.originalText) continue;
          const phrase = itemPhrase(it.originalText);
          const before = previousSku.get(phraseKey(phrase));
          if (phrase && before && before !== it.sku) {
            upsertAlias.run(row.retailer_id, phrase, it.sku);
            aliasesLearned.push({ phrase, sku: it.sku });
          }
        }
        return {
          order: orders.load(id),
          previousTotalPaise: row.total_paise,
          newTotalPaise: quote.totals.totalPaise,
          creditCheck: { exceedsLimit: check.exceeds, afterOrderPaise: check.afterOrderPaise, overByPaise: check.overByPaise },
          aliasesLearned,
        };
      });
    },

    // ---------- Tally export ----------
    /**
     * Hand ALL approved orders to Tally as one batch. Each order becomes 'exported' and its GST-inclusive total moves
     * from pending into outstanding (A9), so total exposure does not change and nothing is counted twice.
     */
    createExport() {
      return inTransaction(db, () => {
        const approved = db.prepare("SELECT id, retailer_id, total_paise FROM orders WHERE status = 'approved' ORDER BY id").all();
        if (approved.length === 0) throw new HttpError(409, 'nothing_to_export', 'There are no approved orders to export');
        const total = approved.reduce((a, o) => a + o.total_paise, 0);
        const exportId = Number(db.prepare('INSERT INTO exports (order_count, total_paise) VALUES (?, ?)').run(approved.length, total).lastInsertRowid);
        const mark = db.prepare("UPDATE orders SET status = 'exported', export_id = ? WHERE id = ?");
        const addOutstanding = db.prepare('UPDATE retailers SET outstanding_paise = outstanding_paise + ? WHERE id = ?');
        for (const o of approved) {
          mark.run(exportId, o.id);
          addOutstanding.run(o.total_paise, o.retailer_id);
        }
        return this.getExport(exportId);
      });
    },

    /** Approved orders waiting for the next export. Read-only; the Tally screen shows this before the desk presses Export. */
    waitingExport() {
      return brief(db.prepare("SELECT o.id, r.shop_name, o.total_paise FROM orders o JOIN retailers r ON r.id = o.retailer_id WHERE o.status = 'approved' ORDER BY o.id").all());
    },

    /** The orders inside one export batch (short form), so the screen can show what was just exported. */
    exportBrief(exportId) {
      return brief(db.prepare('SELECT o.id, r.shop_name, o.total_paise FROM orders o JOIN retailers r ON r.id = o.retailer_id WHERE o.export_id = ? ORDER BY o.id').all(exportId));
    },

    getExport(exportId) {
      const e = db.prepare('SELECT id, created_at, order_count, total_paise FROM exports WHERE id = ?').get(exportId);
      if (!e) throw new HttpError(404, 'export_not_found', 'No such export');
      return { id: e.id, createdAt: iso(e.created_at), orderCount: e.order_count, totalPaise: e.total_paise };
    },

    listExports() {
      return db.prepare('SELECT id FROM exports ORDER BY id DESC LIMIT 50').all().map((e) => this.getExport(e.id));
    },

    /** The orders of one export batch, with shop names, ready for tally.js. The same file can be downloaded again any time. */
    exportOrders(exportId) {
      this.getExport(exportId);
      return db.prepare('SELECT o.id, r.shop_name FROM orders o JOIN retailers r ON r.id = o.retailer_id WHERE o.export_id = ? ORDER BY o.id')
        .all(exportId).map((o) => ({ ...orders.load(o.id), shopName: o.shop_name }));
    },
  };
}
