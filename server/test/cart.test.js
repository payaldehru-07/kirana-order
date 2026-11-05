import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, PHONES } from './helpers.js';

let s, sharma, desk, jain;
before(async () => {
  s = await startTestServer();
  sharma = await s.login(PHONES.sharma);
  jain = await s.login('9000000003');
  desk = await s.login(PHONES.desk);
});
after(() => s.close());

const price = (token, body) => s.call('POST', '/api/cart/price', { token, body });
const line = (r, code) => r.body.lines.find((l) => l.skuCode === code);

test('cart pricing needs a login', async () => {
  assert.equal((await price(undefined, { items: [{ sku: 'SKU-BS-075', qty: 1 }] })).status, 401);
});

test('no scheme yet: 5 biscuit cases + 2 detergent cases, totals checked by hand', async () => {
  const r = await price(sharma, { items: [{ sku: 'SKU-BS-075', qty: 5 }, { sku: 'SKU-DT-1KG', qty: 2 }] });
  assert.equal(r.status, 200);
  const bs = line(r, 'SKU-BS-075');
  assert.equal(bs.grossPaise, 388800);   // 5 x 777.60
  assert.equal(bs.freeCases, 0);
  assert.equal(bs.gstPaise, 69984);      // 18% of 3888.00
  assert.equal(bs.totalPaise, 458784);
  assert.deepEqual(bs.nudge, { type: 'free_goods', casesToAdd: 5, reward: '1 free case' });
  const dt = line(r, 'SKU-DT-1KG');
  assert.equal(dt.discountPaise, 0);
  assert.equal(dt.gstPaise, 73080);      // 18% of 4060.00
  assert.deepEqual(r.body.totals, { grossPaise: 794800, discountPaise: 0, netPaise: 794800, gstPaise: 143064, totalPaise: 937864 });
  assert.equal(r.body.stockOk, true);
});

test('buy 10 get 1: 10 cases ship 11, you pay for 10', async () => {
  const r = await price(sharma, { items: [{ sku: 'SKU-BS-075', qty: 10 }] });
  const l = line(r, 'SKU-BS-075');
  assert.equal(l.freeCases, 1);
  assert.equal(l.shippedCases, 11);
  assert.equal(l.grossPaise, 777600);
  assert.equal(l.totalPaise, 917568);    // 7776.00 + 18% (1399.68 -> 139968 paise)
  assert.match(l.appliedLabel, /1 free case/);
});

test('3% slab: 5 detergent cases get 3% off the line before GST', async () => {
  const r = await price(sharma, { items: [{ sku: 'SKU-DT-1KG', qty: 5 }] });
  const l = line(r, 'SKU-DT-1KG');
  assert.equal(l.grossPaise, 1015000);
  assert.equal(l.discountPaise, 30450);
  assert.equal(l.netPaise, 984550);
  assert.equal(l.gstPaise, 177219);
  assert.equal(l.totalPaise, 1161769);
  assert.equal(r.body.totals.discountPaise, 30450);
});

test("retailer-specific price flows into the cart: Jain's biscuit is 7.95/piece", async () => {
  const r = await price(jain, { items: [{ sku: 'SKU-BS-075', qty: 1 }] });
  const l = line(r, 'SKU-BS-075');
  assert.equal(l.casePricePaise, 76320);
  assert.equal(l.totalPaise, 90058);     // 763.20 + 18% (137.376 -> 137.38)
});

test('out-of-stock line is priced but flagged, and stockOk is false', async () => {
  const r = await price(sharma, { items: [{ sku: 'SKU-TE-250', qty: 1 }, { sku: 'SKU-BS-075', qty: 1 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(line(r, 'SKU-TE-250').stockIssue, { type: 'out_of_stock', availableCases: 0 });
  assert.equal(line(r, 'SKU-TE-250').totalPaise, 489300); // 4660.00 + 5% GST
  assert.equal(line(r, 'SKU-BS-075').stockIssue, null);
  assert.equal(r.body.stockOk, false);
});

test('stock check counts FREE cases too (tea 500 g: 8 in stock, buy 5 get 1)', async () => {
  const ok = await price(sharma, { items: [{ sku: 'SKU-TE-500', qty: 7 }] });   // 7 + 1 free = 8
  assert.equal(line(ok, 'SKU-TE-500').stockIssue, null);
  const over = await price(sharma, { items: [{ sku: 'SKU-TE-500', qty: 8 }] }); // 8 + 1 free = 9 > 8
  assert.deepEqual(line(over, 'SKU-TE-500').stockIssue, { type: 'insufficient_stock', availableCases: 8 });
});

test('retailer cannot price as another retailer; desk must name one', async () => {
  const items = [{ sku: 'SKU-BS-075', qty: 1 }];
  assert.equal((await price(sharma, { items, retailerId: 3 })).status, 403);
  assert.equal((await price(sharma, { items, retailerId: 1 })).status, 200);
  assert.equal((await price(desk, { items })).status, 400);
  assert.equal((await price(desk, { items, retailerId: 999 })).status, 404);
  const d = await price(desk, { items, retailerId: 3 });
  assert.equal(line(d, 'SKU-BS-075').casePricePaise, 76320);
});

test('validation: every bad cart is a 400 with the line number', async () => {
  const good = { sku: 'SKU-BS-075', qty: 1 };
  const bad = [
    {},                                          // no items
    { items: [] },
    { items: 'SKU-BS-075' },
    { items: [good, { sku: 'SKU-DT-1KG', qty: 0 }] },
    { items: [{ sku: 'SKU-DT-1KG', qty: 1.5 }] },
    { items: [{ sku: 'SKU-DT-1KG', qty: '3' }] }, // string, not number
    { items: [{ sku: 'SKU-DT-1KG', qty: -2 }] },
    { items: [{ sku: 'SKU-DT-1KG', qty: 10000 }] },
    { items: [{ sku: 42, qty: 1 }] },
    { items: [{ sku: 'sku-dt-1kg', qty: 1 }] },   // wrong case, malformed
    { items: [null] },
    { items: [good, good] },                      // duplicate SKU
    { items: Array.from({ length: 51 }, (_, i) => ({ sku: `SKU-X-${i}`, qty: 1 })) },
  ];
  for (const body of bad) {
    const r = await price(sharma, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.body.error.code, 'invalid_items');
  }
  const r = await price(sharma, { items: [good, { sku: 'SKU-DT-1KG', qty: 0 }] });
  assert.equal(r.body.error.details[0].index, 1);
});

test('invalid retailerId in the body is rejected', async () => {
  const items = [{ sku: 'SKU-BS-075', qty: 1 }];
  for (const retailerId of ['2', 1.5, 0, -1, true]) {
    assert.equal((await price(desk, { items, retailerId })).status, 400, String(retailerId));
  }
});

test('unknown SKU code: 400 listing every unknown line', async () => {
  const r = await price(sharma, { items: [{ sku: 'SKU-NOPE-1', qty: 1 }, { sku: 'SKU-BS-075', qty: 1 }, { sku: 'SKU-NOPE-2', qty: 1 }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'unknown_sku');
  assert.deepEqual(r.body.error.details.map((d) => d.index), [0, 2]);
});

test('pricing is a preview: stock and orders are untouched', async () => {
  const before = s.db.prepare('SELECT stock_cases FROM skus WHERE code = ?').get('SKU-BS-075').stock_cases;
  const orders = s.db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  await price(sharma, { items: [{ sku: 'SKU-BS-075', qty: 10 }] });
  assert.equal(s.db.prepare('SELECT stock_cases FROM skus WHERE code = ?').get('SKU-BS-075').stock_cases, before);
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM orders').get().c, orders);
});
