// Turns exported orders into files for Tally. Input: [{ ...order, shopName }] (order shape from orders.js).
// ASSUMPTION A11: this is a simplified Tally-style import of SALES ORDERS (not invoices; GST e-invoicing stays in Tally).
// Ledger names ("Output GST") and the XML shape follow Tally's usual import format but were NOT tested against a
// real Tally installation. The CSV is the safe fallback: columns a Tally operator can map or paste.

/** 937864 -> "9378.64". Integer maths only, no floating point. */
export const rs = (paise) => `${paise < 0 ? '-' : ''}${Math.floor(Math.abs(paise) / 100)}.${String(Math.abs(paise) % 100).padStart(2, '0')}`;

const xmlEscape = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Voucher date = the order's date in India (UTC+5:30), as YYYYMMDD. */
const tallyDate = (iso) => new Date(Date.parse(iso) + 19_800_000).toISOString().slice(0, 10).replace(/-/g, '');

export function tallyXml(orders) {
  const vouchers = orders.map((o) => {
    const inventory = o.lines.map((l) => {
      const paid = `
          <ALLINVENTORYENTRIES.LIST>
            <STOCKITEMNAME>${xmlEscape(l.name)}</STOCKITEMNAME>
            <RATE>${rs(l.casePricePaise)}/case</RATE>
            <ACTUALQTY>${l.qty} case</ACTUALQTY>
            <BILLEDQTY>${l.qty} case</BILLEDQTY>
            <AMOUNT>${rs(l.netPaise)}</AMOUNT>
          </ALLINVENTORYENTRIES.LIST>`;
      // Free goods go out too: a second line at rate 0 so Tally stock stays right.
      const free = l.freeCases > 0 ? `
          <ALLINVENTORYENTRIES.LIST>
            <STOCKITEMNAME>${xmlEscape(l.name)}</STOCKITEMNAME>
            <RATE>0.00/case</RATE>
            <ACTUALQTY>${l.freeCases} case</ACTUALQTY>
            <BILLEDQTY>${l.freeCases} case</BILLEDQTY>
            <AMOUNT>0.00</AMOUNT>
          </ALLINVENTORYENTRIES.LIST>` : '';
      return paid + free;
    }).join('');
    return `
        <VOUCHER VCHTYPE="Sales Order" ACTION="Create">
          <DATE>${tallyDate(o.createdAt)}</DATE>
          <VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME>
          <VOUCHERNUMBER>ORD-${o.id}</VOUCHERNUMBER>
          <PARTYLEDGERNAME>${xmlEscape(o.shopName)}</PARTYLEDGERNAME>
          <NARRATION>Kirana app order ${o.id} (${o.source})</NARRATION>${inventory}
          <LEDGERENTRIES.LIST>
            <LEDGERNAME>${xmlEscape(o.shopName)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>-${rs(o.totals.totalPaise)}</AMOUNT>
          </LEDGERENTRIES.LIST>
          <LEDGERENTRIES.LIST>
            <LEDGERNAME>Output GST</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>${rs(o.totals.gstPaise)}</AMOUNT>
          </LEDGERENTRIES.LIST>
        </VOUCHER>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">${vouchers}
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;
}

// A cell starting with = + - @ would run as a formula when opened in Excel (CSV injection), so it gets a leading '.
const csvCell = (v) => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function tallyCsv(orders) {
  const header = ['voucher_no', 'date', 'party', 'sku_code', 'item', 'qty_cases', 'free_cases', 'shipped_cases',
    'case_price', 'discount', 'taxable_value', 'gst_amount', 'line_total', 'order_total', 'source'];
  const rows = orders.flatMap((o) => o.lines.map((l) => [
    `ORD-${o.id}`, tallyDate(o.createdAt), o.shopName, l.skuCode, l.name, l.qty, l.freeCases, l.shippedCases,
    rs(l.casePricePaise), rs(l.discountPaise), rs(l.netPaise), rs(l.gstPaise), rs(l.totalPaise), rs(o.totals.totalPaise), o.source,
  ]));
  return `${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
