// Scheme engine: pure functions, no I/O. All money is integer paise.
//
// Scheme shapes (stored as JSON on the SKU):
//   { type: 'free_goods',    buy: 10, free: 1 }        buy 10 cases, get 1 free (repeats)
//   { type: 'slab_discount', minCases: 5, percent: 3 } 3% off the line at 5+ cases
//   null                                               no scheme

export function roundHalfUp(n) {
  return Math.floor(n + 0.5);
}

/** Price of one case in paise. Dealer price is per piece (ASSUMPTION A1). */
export function casePricePaise(pricePerPiece, piecesPerCase) {
  return roundHalfUp(pricePerPiece * piecesPerCase * 100);
}

/**
 * Price one cart line.
 * @param {{casePricePaise:number, scheme:object|null, gstRate:number}} sku
 * @param {number} qty cases ordered (positive integer)
 */
export function priceLine(sku, qty) {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new RangeError('qty must be a positive whole number of cases');
  }
  const gross = sku.casePricePaise * qty;
  const scheme = sku.scheme ?? null;

  let freeCases = 0;
  let discount = 0;
  let appliedLabel = null;
  let nudge = null;

  if (scheme?.type === 'free_goods') {
    freeCases = Math.floor(qty / scheme.buy) * scheme.free;
    if (freeCases > 0) {
      appliedLabel = `${freeCases} free case${freeCases > 1 ? 's' : ''} (buy ${scheme.buy} get ${scheme.free})`;
    }
    const toNext = scheme.buy - (qty % scheme.buy);
    nudge = {
      type: 'free_goods',
      casesToAdd: toNext,
      reward: `${scheme.free} free case${scheme.free > 1 ? 's' : ''}`,
    };
  } else if (scheme?.type === 'slab_discount') {
    if (qty >= scheme.minCases) {
      discount = roundHalfUp((gross * scheme.percent) / 100);
      appliedLabel = `${scheme.percent}% off (${scheme.minCases}+ cases)`;
    } else {
      nudge = {
        type: 'slab_discount',
        casesToAdd: scheme.minCases - qty,
        reward: `${scheme.percent}% off`,
      };
    }
  }

  const net = gross - discount; // taxable value, before GST (ASSUMPTION A2)
  const gst = roundHalfUp((net * sku.gstRate) / 100);
  return {
    qty,
    freeCases,
    shippedCases: qty + freeCases,
    grossPaise: gross,
    discountPaise: discount,
    netPaise: net,
    gstPaise: gst,
    totalPaise: net + gst,
    appliedLabel,
    nudge,
  };
}

/** Price a whole cart: [{sku, qty}] -> lines + totals. */
export function priceCart(items) {
  const lines = items.map(({ sku, qty }) => ({ skuCode: sku.code, ...priceLine(sku, qty) }));
  const sum = (k) => lines.reduce((a, l) => a + l[k], 0);
  return {
    lines,
    netPaise: sum('netPaise'),
    gstPaise: sum('gstPaise'),
    totalPaise: sum('totalPaise'),
  };
}
