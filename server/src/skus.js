// The ONE place that decides "what does this retailer pay for this SKU, and how much is in stock".
// Catalogue, cart preview and order placement all read through here, so they cannot disagree.
import { casePricePaise, roundHalfUp } from './schemeEngine.js';

// ASSUMPTION A10: 1-10 cases left counts as "low stock". 0 is out of stock.
export const LOW_STOCK_CASES = 10;

export function stockStatus(cases) {
  if (cases <= 0) return 'out_of_stock';
  return cases <= LOW_STOCK_CASES ? 'low_stock' : 'in_stock';
}

/** Scheme text for the shopkeeper, in both languages. null when the SKU has no scheme. */
export function describeScheme(scheme) {
  if (!scheme) return null;
  if (scheme.type === 'free_goods') {
    return {
      en: `Buy ${scheme.buy} cases, get ${scheme.free} free`,
      hi: `${scheme.buy} केस खरीदें, ${scheme.free} केस मुफ़्त`,
    };
  }
  if (scheme.type === 'slab_discount') {
    return {
      en: `${scheme.percent}% off on ${scheme.minCases} or more cases`,
      hi: `${scheme.minCases} या अधिक केस पर ${scheme.percent}% छूट`,
    };
  }
  return null;
}

/** ASSUMPTION A2: dealer prices EXCLUDE GST. This label is shown next to every price. */
export function gstLabel(rate) {
  return rate === 0
    ? { en: 'No GST (0%)', hi: 'GST नहीं (0%)' }
    : { en: `Excl. ${rate}% GST`, hi: `GST ${rate}% अलग से` };
}

/** Case price with GST added, for display only. The real invoice GST comes from the scheme engine per line. */
export function casePriceInclGstPaise(casePrice, gstRate) {
  return casePrice + roundHalfUp((casePrice * gstRate) / 100);
}

function toSku(row) {
  const perPiece = row.price_per_piece; // rupees, retailer override already applied by the SQL
  return {
    code: row.code,
    name: row.name,
    nameHi: row.name_hi,
    brand: row.brand,
    image: row.image ?? null,
    piecesPerCase: row.pieces_per_case,
    gstRate: row.gst_rate,
    stockCases: row.stock_cases,
    scheme: row.scheme_json ? JSON.parse(row.scheme_json) : null,
    pricePerPiecePaise: roundHalfUp(perPiece * 100),
    casePricePaise: casePricePaise(perPiece, row.pieces_per_case), // ASSUMPTION A1: case price = piece price x pieces per case
  };
}

// A retailer's special rate (retailer_prices) wins over the standard dealer price.
const SELECT = `
  SELECT s.code, s.name, s.name_hi, s.brand, s.image, s.pieces_per_case, s.gst_rate, s.stock_cases, s.scheme_json,
         COALESCE(rp.price_per_piece, s.price_per_piece) AS price_per_piece
  FROM skus s
  LEFT JOIN retailer_prices rp ON rp.sku_code = s.code AND rp.retailer_id = ?`;

export function createSkuRepo(db) {
  const all = db.prepare(`${SELECT} ORDER BY s.brand, s.name`);
  return {
    /** Every SKU, priced for this retailer. */
    listForRetailer: (retailerId) => all.all(retailerId).map(toSku),

    /** Map of code -> SKU for the given codes (unknown codes are simply absent). Max ~50 codes per call. */
    byCodes(retailerId, codes) {
      if (codes.length === 0) return new Map();
      const marks = codes.map(() => '?').join(',');
      const rows = db.prepare(`${SELECT} WHERE s.code IN (${marks})`).all(retailerId, ...codes);
      return new Map(rows.map((r) => [r.code, toSku(r)]));
    },
  };
}
