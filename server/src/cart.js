import { HttpError } from './errors.js';
import { priceCart } from './schemeEngine.js';

/**
 * Prices a validated cart for one retailer using the scheme engine, and flags stock problems.
 * Shared by POST /cart/price (preview) and order placement, so a preview and a real order always match.
 *
 * Stock rule: free goods leave the warehouse too, so what must be in stock is shippedCases (bought + free).
 */
export function quoteCart(repo, retailerId, items) {
  const skus = repo.byCodes(retailerId, items.map((i) => i.sku));

  const unknown = items
    .map((it, index) => ({ it, index }))
    .filter(({ it }) => !skus.has(it.sku))
    .map(({ it, index }) => ({ index, problem: `unknown sku ${it.sku}` }));
  if (unknown.length) throw new HttpError(400, 'unknown_sku', 'Some products do not exist', unknown);

  const priced = priceCart(items.map((it) => ({ sku: skus.get(it.sku), qty: it.qty })));

  const lines = priced.lines.map((l) => {
    const s = skus.get(l.skuCode);
    let stockIssue = null;
    if (s.stockCases <= 0) stockIssue = { type: 'out_of_stock', availableCases: 0 };
    else if (l.shippedCases > s.stockCases) stockIssue = { type: 'insufficient_stock', availableCases: s.stockCases };
    return {
      skuCode: l.skuCode,
      name: s.name,
      nameHi: s.nameHi,
      piecesPerCase: s.piecesPerCase,
      gstRate: s.gstRate,
      casePricePaise: s.casePricePaise,
      qty: l.qty,
      freeCases: l.freeCases,
      shippedCases: l.shippedCases,
      grossPaise: l.grossPaise,
      discountPaise: l.discountPaise,
      netPaise: l.netPaise,
      gstPaise: l.gstPaise,
      totalPaise: l.totalPaise,
      appliedLabel: l.appliedLabel, // what the scheme gave on this line (English)
      nudge: l.nudge,               // "add N more cases to get ..." (structured; the screen words it in Hindi or English)
      stockIssue,
    };
  });

  const sum = (k) => lines.reduce((a, l) => a + l[k], 0);
  return {
    lines,
    totals: {
      grossPaise: sum('grossPaise'),
      discountPaise: sum('discountPaise'),
      netPaise: priced.netPaise,   // taxable value, before GST
      gstPaise: priced.gstPaise,
      totalPaise: priced.totalPaise, // GST-inclusive amount payable
    },
    stockOk: lines.every((l) => l.stockIssue === null),
  };
}
