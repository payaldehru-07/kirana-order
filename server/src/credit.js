// ASSUMPTION A9 - how credit is counted. This file is the ONLY place the rule lives.
//
//   exposure = outstanding balance (already in Tally)
//            + pending orders (status 'placed' or 'approved': committed, but not yet exported to Tally)
//
// An order is held when  exposure + this order's GST-INCLUSIVE total  >  credit limit.
// Exactly equal to the limit is allowed.
//  - 'credit_hold' orders are NOT counted until the desk approves them (they are not committed yet).
//  - 'exported' orders are already inside outstanding, so counting them again would double count.
//    (Step 5: exporting an order moves its total from pending into outstanding.)
//  - 'rejected' orders count for nothing.

export function createCreditRepo(db) {
  const getRetailer = db.prepare('SELECT credit_limit_paise, outstanding_paise FROM retailers WHERE id = ?');
  const getPending = db.prepare(
    "SELECT COALESCE(SUM(total_paise), 0) AS p FROM orders WHERE retailer_id = ? AND status IN ('placed','approved')",
  );
  return {
    /** The retailer's credit position right now. Call inside the order transaction when placing an order. */
    snapshot(retailerId) {
      const r = getRetailer.get(retailerId);
      const pendingPaise = getPending.get(retailerId).p;
      const exposurePaise = r.outstanding_paise + pendingPaise;
      return {
        limitPaise: r.credit_limit_paise,
        outstandingPaise: r.outstanding_paise,
        pendingPaise,
        exposurePaise,
        availablePaise: Math.max(0, r.credit_limit_paise - exposurePaise),
      };
    },
  };
}

/** Would an order of this GST-inclusive total push the retailer over the limit? */
export function checkCredit(snapshot, orderTotalPaise) {
  const afterOrderPaise = snapshot.exposurePaise + orderTotalPaise;
  return {
    afterOrderPaise,
    exceeds: afterOrderPaise > snapshot.limitPaise,
    overByPaise: Math.max(0, afterOrderPaise - snapshot.limitPaise),
  };
}

/** The credit block shown on the cart screen: position now, and what this order would do to it. */
export function creditPreview(snapshot, orderTotalPaise) {
  const check = checkCredit(snapshot, orderTotalPaise);
  return {
    limitPaise: snapshot.limitPaise,
    outstandingPaise: snapshot.outstandingPaise,
    pendingPaise: snapshot.pendingPaise,
    availablePaise: snapshot.availablePaise,
    orderTotalPaise,
    afterOrderPaise: check.afterOrderPaise,
    exceedsLimit: check.exceeds, // true => this order will go to the desk as a credit hold
    overByPaise: check.overByPaise,
  };
}

const rupees = (paise) => `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;

export function holdReasonText(totalPaise, afterOrderPaise, limitPaise) {
  return `Order total Rs ${rupees(totalPaise)} would take exposure to Rs ${rupees(afterOrderPaise)}, above credit limit Rs ${rupees(limitPaise)}`;
}
