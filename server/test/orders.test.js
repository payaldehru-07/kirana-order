import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, PHONES } from './helpers.js';

// A fresh server + seeded DB for EVERY test, so tests cannot affect each other through stock or credit.
let s, sharma, gupta, jain, desk;
beforeEach(async () => {
  s = await startTestServer();
  sharma = await s.login(PHONES.sharma);
  gupta = await s.login(PHONES.gupta);
  jain = await s.login('9000000003');
  desk = await s.login(PHONES.desk);
});
afterEach(() => s.close());

const place = (token, body) => s.call('POST', '/api/orders', { token, body });
const stock = (code) => s.db.prepare('SELECT stock_cases FROM skus WHERE code = ?').get(code).stock_cases;
const orderCount = () => s.db.prepare('SELECT COUNT(*) c FROM orders').get().c;
const BS = (qty) => ({ sku: 'SKU-BS-075', qty });
const DT = (qty) => ({ sku: 'SKU-DT-1KG', qty });

// ---------- placing ----------
test('placing needs a login, and only a retailer may place', async () => {
  assert.equal((await place(undefined, { items: [BS(1)] })).status, 401);
  assert.equal((await place(desk, { items: [BS(1)] })).status, 403);
  assert.equal(orderCount(), 5); // only the 5 seeded orders
});

test('a normal order is saved as placed, with lines, totals and reserved stock', async () => {
  const r = await place(sharma, { items: [BS(5), DT(2)] });
  assert.equal(r.status, 201);
  assert.equal(r.body.duplicate, false);
  const o = r.body.order;
  assert.equal(o.status, 'placed');
  assert.equal(o.source, 'app');
  assert.equal(o.retailerId, 1);
  assert.equal(o.holdReason, null);
  assert.deepEqual(o.totals, { netPaise: 794800, gstPaise: 143064, totalPaise: 937864 });
  assert.equal(o.lines.length, 2);
  assert.equal(o.lines[0].skuCode, 'SKU-BS-075');
  assert.equal(o.lines[0].totalPaise, 458784);
  assert.match(o.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(stock('SKU-BS-075'), 335); // 340 - 5
  assert.equal(stock('SKU-DT-1KG'), 83);  // 85 - 2
});

test('free goods: 10 cases bought ships 11, stock drops by 11, you pay for 10', async () => {
  const r = await place(sharma, { items: [BS(10)] });
  const l = r.body.order.lines[0];
  assert.equal(l.qty, 10);
  assert.equal(l.freeCases, 1);
  assert.equal(l.shippedCases, 11);
  assert.equal(r.body.order.totals.totalPaise, 917568);
  assert.equal(stock('SKU-BS-075'), 329);
});

test('slab discount is stored on the line: 5 detergent cases', async () => {
  const r = await place(sharma, { items: [DT(5)] });
  const l = r.body.order.lines[0];
  assert.equal(l.discountPaise, 30450);
  assert.equal(l.netPaise, 984550);
  assert.equal(r.body.order.totals.totalPaise, 1161769);
});

test("the order uses the retailer's own price (Jain's biscuit 7.95/piece)", async () => {
  const r = await place(jain, { items: [BS(1)] });
  assert.equal(r.body.order.lines[0].casePricePaise, 76320);
  assert.equal(r.body.order.totals.totalPaise, 90058);
});

// ---------- credit (A9) ----------
test('over the credit limit: order is saved as credit_hold with a reason, and stock is still reserved', async () => {
  const r = await place(gupta, { items: [BS(5)] }); // total 458,784 > 350,000 available
  assert.equal(r.status, 201);
  assert.equal(r.body.order.status, 'credit_hold');
  assert.match(r.body.order.holdReason, /above credit limit Rs 40000\.00/);
  assert.match(r.body.order.holdReason, /Rs 4587\.84/);
  assert.equal(stock('SKU-BS-075'), 335);
});

test('a held order does NOT use up credit until approved (not counted as pending)', async () => {
  await place(gupta, { items: [BS(5)] }); // goes on hold
  const me = await s.call('GET', '/api/me', { token: gupta });
  assert.equal(me.body.retailer.pendingPaise, 0);
  assert.equal(me.body.retailer.availableCreditPaise, 350_000);
});

test('credit check uses the GST-inclusive total: 4 cases is under the limit before GST, over after', async () => {
  const r = await place(gupta, { items: [BS(4)] }); // net 311,040 < 350,000, total 367,027 > 350,000
  assert.equal(r.body.order.status, 'credit_hold');
});

test('exactly at the limit is allowed; one paisa over is held', async () => {
  // Sharma: 5 biscuit cases = 458,784. Put the limit exactly at outstanding + 458,784.
  s.db.exec('UPDATE retailers SET credit_limit_paise = 1200000 + 458784 WHERE id = 1');
  assert.equal((await place(sharma, { items: [BS(5)] })).body.order.status, 'placed');

  // fresh state: limit one paisa short (use a different server state via a second retailer)
  s.db.exec('UPDATE retailers SET credit_limit_paise = 0 + 458783 WHERE id = 4'); // Khan owes 0
  const khan = await s.login('9000000004');
  assert.equal((await place(khan, { items: [BS(5)] })).body.order.status, 'credit_hold');
});

test('A9: pending orders count. Gupta has 350,000 free: a 275,270 order fits, then a 91,757 order (which alone would fit) is held', async () => {
  const first = await place(gupta, { items: [BS(3)] });
  assert.equal(first.body.order.totals.totalPaise, 275270);
  assert.equal(first.body.order.status, 'placed');
  const second = await place(gupta, { items: [BS(1)] });
  assert.equal(second.body.order.totals.totalPaise, 91757);
  assert.equal(second.body.order.status, 'credit_hold'); // 3,650,000 + 275,270 + 91,757 = 4,017,027 > 4,000,000
});

test('/api/me shows pending and available credit after an order is placed', async () => {
  await place(sharma, { items: [BS(5), DT(2)] });
  const me = await s.call('GET', '/api/me', { token: sharma });
  assert.equal(me.body.retailer.outstandingPaise, 1_200_000);
  assert.equal(me.body.retailer.pendingPaise, 937_864);
  assert.equal(me.body.retailer.availableCreditPaise, 6_000_000 - 1_200_000 - 937_864);
});

test('exported orders are NOT counted again as pending (already in outstanding)', async () => {
  // Sharma has two seeded exported orders; pending must stay 0 for them.
  const me = await s.call('GET', '/api/me', { token: sharma });
  assert.equal(me.body.retailer.pendingPaise, 0);
});

// ---------- stock ----------
test('out-of-stock line: 409, whole order refused, nothing saved, valid lines untouched', async () => {
  const r = await place(sharma, { items: [BS(1), { sku: 'SKU-TE-250', qty: 1 }] });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'stock_unavailable');
  assert.deepEqual(r.body.error.details, [{ index: 1, skuCode: 'SKU-TE-250', problem: 'out_of_stock', availableCases: 0 }]);
  assert.equal(orderCount(), 5);
  assert.equal(stock('SKU-BS-075'), 340);
});

test('stock check counts free cases: tea 500 g has 8, buying 8 ships 9', async () => {
  const r = await place(sharma, { items: [{ sku: 'SKU-TE-500', qty: 8 }] });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.details[0].problem, 'insufficient_stock');
  assert.equal(r.body.error.details[0].availableCases, 8);
  assert.equal((await place(sharma, { items: [{ sku: 'SKU-TE-500', qty: 7 }] })).status, 201); // 7 + 1 free = 8, exactly all
  assert.equal(stock('SKU-TE-500'), 0);
});

test('two orders cannot both take the last stock', async () => {
  s.db.exec("UPDATE skus SET stock_cases = 5 WHERE code = 'SKU-BS-075'");
  assert.equal((await place(sharma, { items: [BS(4)] })).status, 201); // 1 left
  const second = await place(jain, { items: [BS(4)] });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.details[0].availableCases, 1);
  assert.equal(stock('SKU-BS-075'), 1);
});

test('unknown SKU: 400 and nothing saved', async () => {
  const r = await place(sharma, { items: [{ sku: 'SKU-NOPE-1', qty: 1 }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'unknown_sku');
  assert.equal(orderCount(), 5);
});

// ---------- all-or-nothing ----------
test('a failure half-way through saving rolls EVERYTHING back (no order, no stock lost), and the DB stays usable', async () => {
  s.db.exec("CREATE TRIGGER boom BEFORE INSERT ON order_lines BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  const r = await place(sharma, { items: [BS(5), DT(2)] });
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, 'internal');
  assert.equal(orderCount(), 5);
  assert.equal(stock('SKU-BS-075'), 340);
  assert.equal(stock('SKU-DT-1KG'), 85);
  s.db.exec('DROP TRIGGER boom');
  assert.equal((await place(sharma, { items: [BS(1)] })).status, 201); // proves the rollback released the lock
});

// ---------- idempotency (double tap on slow 3G) ----------
test('same clientRef twice: second call returns the SAME order, stock taken once', async () => {
  const body = { items: [BS(5)], clientRef: 'cart-abc-12345' };
  const a = await place(sharma, body);
  const b = await place(sharma, body);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.duplicate, true);
  assert.equal(b.body.order.id, a.body.order.id);
  assert.equal(stock('SKU-BS-075'), 335);
  assert.equal(orderCount(), 6);
});

test('clientRef is per retailer: another shop can use the same string', async () => {
  const a = await place(sharma, { items: [BS(1)], clientRef: 'cart-shared-ref' });
  const b = await place(jain, { items: [BS(1)], clientRef: 'cart-shared-ref' });
  assert.equal(b.status, 201);
  assert.notEqual(a.body.order.id, b.body.order.id);
});

// ---------- validation ----------
test('validation: bad bodies are 400 and save nothing', async () => {
  const bad = [
    {}, { items: [] }, { items: [BS(0)] }, { items: [{ sku: 'SKU-BS-075', qty: '5' }] }, { items: [BS(1), BS(2)] },
    { items: [BS(1)], clientRef: 'short' },
    { items: [BS(1)], clientRef: 12345678 },
    { items: [BS(1)], clientRef: 'has spaces in it' },
    { items: [BS(1)], retailerId: 'x' },
  ];
  for (const body of bad) assert.equal((await place(sharma, body)).status, 400, JSON.stringify(body));
  assert.equal(orderCount(), 5);
  assert.equal(stock('SKU-BS-075'), 340);
});

test('a retailer cannot place an order for another retailer', async () => {
  assert.equal((await place(sharma, { items: [BS(1)], retailerId: 3 })).status, 403);
  assert.equal(orderCount(), 5);
});

test('client cannot set status, total or source: those fields are ignored', async () => {
  const r = await place(sharma, { items: [BS(1)], status: 'approved', totalPaise: 1, source: 'ai_text' });
  assert.equal(r.body.order.status, 'placed');
  assert.equal(r.body.order.source, 'app');
  assert.equal(r.body.order.totals.totalPaise, 91757);
});

// ---------- reading orders ----------
test('history: a retailer lists only their own orders, newest first', async () => {
  await place(sharma, { items: [BS(1)] });
  const mine = await s.call('GET', '/api/orders', { token: sharma });
  assert.equal(mine.status, 200);
  // new order, then seeded 3-days-ago (id 1), then 17-days-ago (id 2)
  assert.deepEqual(mine.body.orders.map((o) => o.id), [6, 1, 2]);
  assert.equal(mine.body.orders[0].lineCount, 1);
  const g = await s.call('GET', '/api/orders', { token: gupta });
  assert.deepEqual(g.body.orders.map((o) => o.id), [3]);
});

test('history: limit is validated and applied; desk must name a retailer', async () => {
  assert.equal((await s.call('GET', '/api/orders?limit=1', { token: sharma })).body.orders.length, 1);
  for (const bad of ['0', 'abc', '101', '-1', '1.5']) {
    assert.equal((await s.call('GET', `/api/orders?limit=${bad}`, { token: sharma })).status, 400, bad);
  }
  assert.equal((await s.call('GET', '/api/orders', { token: desk })).status, 400);
  assert.equal((await s.call('GET', '/api/orders?retailerId=3', { token: desk })).body.orders.length, 1);
  assert.equal((await s.call('GET', '/api/orders?retailerId=2', { token: sharma })).status, 403);
});

test('order detail: owner and desk can read it; another retailer gets 404 (not 403)', async () => {
  const id = (await place(sharma, { items: [BS(1)] })).body.order.id;
  assert.equal((await s.call('GET', `/api/orders/${id}`, { token: sharma })).status, 200);
  assert.equal((await s.call('GET', `/api/orders/${id}`, { token: desk })).status, 200);
  assert.equal((await s.call('GET', `/api/orders/${id}`, { token: gupta })).status, 404);
  assert.equal((await s.call('GET', '/api/orders/99999', { token: sharma })).status, 404);
  assert.equal((await s.call('GET', '/api/orders/abc', { token: sharma })).status, 400);
  assert.equal((await s.call('GET', `/api/orders/${id}`)).status, 401);
});

// ---------- repeat order ----------
test('repeat order: same items and quantities, priced at TODAY\'s prices, tea flagged out of stock', async () => {
  // seeded order 1 for Sharma: 4 biscuit, 2 detergent, 1 tea 250 g
  const r = await s.call('GET', '/api/orders/1/repeat', { token: sharma });
  assert.equal(r.status, 200);
  assert.equal(r.body.sourceOrderId, 1);
  assert.deepEqual(r.body.items, [{ sku: 'SKU-BS-075', qty: 4 }, { sku: 'SKU-DT-1KG', qty: 2 }, { sku: 'SKU-TE-250', qty: 1 }]);
  assert.equal(r.body.stockOk, false);
  assert.equal(r.body.lines.find((l) => l.skuCode === 'SKU-TE-250').stockIssue.type, 'out_of_stock');
  assert.equal(r.body.credit.exceedsLimit, false);
});

test('repeat order is repriced: a changed price shows up, the old price does not', async () => {
  s.db.exec("UPDATE retailer_prices SET price_per_piece = 120 WHERE retailer_id = 1 AND sku_code = 'SKU-TE-250'");
  const r = await s.call('GET', '/api/orders/1/repeat', { token: sharma });
  assert.equal(r.body.lines.find((l) => l.skuCode === 'SKU-TE-250').casePricePaise, 480000); // 120 x 40 pieces
});

test('repeat order copies what was BOUGHT, not the free cases', async () => {
  const id = (await place(sharma, { items: [BS(10)] })).body.order.id; // ships 11
  const r = await s.call('GET', `/api/orders/${id}/repeat`, { token: sharma });
  assert.deepEqual(r.body.items, [{ sku: 'SKU-BS-075', qty: 10 }]);
  assert.equal(r.body.lines[0].freeCases, 1); // re-earned by the scheme
});

test('repeat order: saves nothing; only own orders; desk not allowed; bad id', async () => {
  const before = orderCount();
  await s.call('GET', '/api/orders/1/repeat', { token: sharma });
  assert.equal(orderCount(), before);
  assert.equal(stock('SKU-BS-075'), 340);
  assert.equal((await s.call('GET', '/api/orders/1/repeat', { token: gupta })).status, 404); // Sharma's order
  assert.equal((await s.call('GET', '/api/orders/1/repeat', { token: desk })).status, 403);
  assert.equal((await s.call('GET', '/api/orders/abc/repeat', { token: sharma })).status, 400);
  assert.equal((await s.call('GET', '/api/orders/1/repeat')).status, 401);
});
