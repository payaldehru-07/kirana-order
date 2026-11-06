import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, PHONES } from './helpers.js';

let s, sharma, gupta, jain, desk;
beforeEach(async () => {
  s = await startTestServer();
  sharma = await s.login(PHONES.sharma);
  gupta = await s.login(PHONES.gupta);
  jain = await s.login('9000000003');
  desk = await s.login(PHONES.desk);
});
afterEach(() => s.close());

const BS = (qty, originalText) => ({ sku: 'SKU-BS-075', qty, ...(originalText ? { originalText } : {}) });
const place = async (token, items) => (await s.call('POST', '/api/orders', { token, body: { items } })).body.order;
const stock = (code) => s.db.prepare('SELECT stock_cases FROM skus WHERE code = ?').get(code).stock_cases;
const approve = (id) => s.call('POST', `/api/desk/orders/${id}/approve`, { token: desk });
const reject = (id, body) => s.call('POST', `/api/desk/orders/${id}/reject`, { token: desk, body });
// Put the customer's own words on an order's line (normally done by AI capture), so these tests do not depend on it.
const placeWithText = async (token, sku, qty, text) => {
  const o = await place(token, [{ sku, qty }]);
  s.db.prepare('UPDATE order_lines SET original_text = ? WHERE order_id = ?').run(text, o.id);
  return o;
};
const edit = (id, items, token = desk) => s.call('PUT', `/api/desk/orders/${id}/lines`, { token, body: { items } });

// ---------- access ----------
test('every desk route is desk-only: retailers get 403, anonymous gets 401', async () => {
  const routes = [
    ['GET', '/api/desk/orders'], ['GET', '/api/desk/orders/1'], ['POST', '/api/desk/orders/1/approve'],
    ['POST', '/api/desk/orders/1/reject', {}], ['PUT', '/api/desk/orders/1/lines', { items: [BS(1)] }],
    ['POST', '/api/desk/exports', {}], ['GET', '/api/desk/exports'], ['GET', '/api/desk/exports/1/file'],
  ];
  for (const [method, path, body] of routes) {
    assert.equal((await s.call(method, path, { token: sharma, body })).status, 403, `${method} ${path} as retailer`);
    assert.equal((await s.call(method, path, { body })).status, 401, `${method} ${path} anonymous`);
  }
});

// ---------- listing ----------
test('desk lists all orders with shop names; status filter gives the holds queue', async () => {
  await place(gupta, [BS(5)]); // credit_hold
  await place(sharma, [BS(1)]); // placed
  const all = await s.call('GET', '/api/desk/orders', { token: desk });
  assert.equal(all.status, 200);
  assert.equal(all.body.orders.length, 7); // 5 seeded + 2
  assert.ok(all.body.orders[0].shopName);
  const holds = await s.call('GET', '/api/desk/orders?status=credit_hold', { token: desk });
  assert.deepEqual(holds.body.orders.map((o) => o.shopName), ['Gupta General Store']);
  assert.match(holds.body.orders[0].holdReason, /credit limit/);
  const one = await s.call('GET', '/api/desk/orders?retailerId=1&status=exported', { token: desk });
  assert.equal(one.body.orders.length, 2);
});

test('list validation: bad status, retailerId or limit are 400', async () => {
  for (const q of ['status=nope', 'status=placed&status=credit_hold', 'retailerId=x', 'limit=0', 'limit=201']) {
    assert.equal((await s.call('GET', `/api/desk/orders?${q}`, { token: desk })).status, 400, q);
  }
});

test('detail shows retailer, credit position and whether the order breaks the limit', async () => {
  const o = await place(gupta, [BS(5)]);
  const d = await s.call('GET', `/api/desk/orders/${o.id}`, { token: desk });
  assert.equal(d.body.retailer.shopName, 'Gupta General Store');
  assert.deepEqual(d.body.credit, { limitPaise: 4_000_000, outstandingPaise: 3_650_000, pendingPaise: 0 });
  assert.equal(d.body.creditCheck.exceedsLimit, true);
  assert.equal(d.body.creditCheck.overByPaise, 108_784);
  const fits = await place(sharma, [BS(1)]); // placed orders must not be double counted in their own check
  assert.equal((await s.call('GET', `/api/desk/orders/${fits.id}`, { token: desk })).body.creditCheck.exceedsLimit, false);
  assert.equal((await s.call('GET', '/api/desk/orders/99999', { token: desk })).status, 404);
  assert.equal((await s.call('GET', '/api/desk/orders/abc', { token: desk })).status, 400);
});

// ---------- approve / reject ----------
test('approve: placed and credit_hold become approved (desk may override a hold); approving twice is 409', async () => {
  const placed = await place(sharma, [BS(1)]);
  const held = await place(gupta, [BS(5)]);
  assert.equal((await approve(placed.id)).body.order.status, 'approved');
  assert.equal((await approve(held.id)).body.order.status, 'approved');
  assert.equal((await approve(placed.id)).status, 409);
  assert.equal((await approve(1)).status, 409); // seeded order 1 is already exported
});

test('an approved order now counts as pending credit', async () => {
  const held = await place(gupta, [BS(1)]);
  await approve(held.id);
  const me = await s.call('GET', '/api/me', { token: gupta });
  assert.equal(me.body.retailer.pendingPaise, 91757);
});

test('reject returns ALL reserved stock including free cases, and keeps the reason', async () => {
  const o = await place(sharma, [BS(10)]); // ships 11
  assert.equal(stock('SKU-BS-075'), 329);
  const r = await reject(o.id, { reason: 'Duplicate of an earlier order' });
  assert.equal(r.status, 200);
  assert.equal(r.body.order.status, 'rejected');
  assert.equal(r.body.order.deskNote, 'Duplicate of an earlier order');
  assert.equal(stock('SKU-BS-075'), 340);
  assert.equal((await reject(o.id, {})).status, 409);      // cannot reject twice, so stock cannot be returned twice
  assert.equal(stock('SKU-BS-075'), 340);
});

test('reject works on a credit_hold and on an approved order; exported orders cannot be rejected', async () => {
  const held = await place(gupta, [BS(5)]);
  assert.equal((await reject(held.id)).status, 200);
  assert.equal(stock('SKU-BS-075'), 340);
  const ok = await place(sharma, [BS(2)]);
  await approve(ok.id);
  assert.equal((await reject(ok.id)).status, 200);
  assert.equal((await reject(1)).status, 409);
  assert.equal((await reject(ok.id)).status, 409);        // already rejected
});

test('reject reason must be short text', async () => {
  const o = await place(sharma, [BS(1)]);
  assert.equal((await reject(o.id, { reason: 'x'.repeat(201) })).status, 400);
  assert.equal((await reject(o.id, { reason: 5 })).status, 400);
});

// ---------- edit lines ----------
test('edit changes lines and stock, and shows old and new totals', async () => {
  const o = await place(sharma, [BS(5)]);                 // total 458,784, stock 335
  const r = await edit(o.id, [BS(2), { sku: 'SKU-DT-1KG', qty: 1 }]);
  assert.equal(r.status, 200);
  assert.equal(r.body.previousTotalPaise, 458784);
  assert.equal(r.body.newTotalPaise, 183514 + 239540);    // 2 biscuit: 155,520 + 27,994 (GST 27,993.6) ; 1 detergent: 203,000 + 36,540
  assert.equal(r.body.order.totals.totalPaise, r.body.newTotalPaise);
  assert.equal(r.body.order.originalTotalPaise, 458784);
  assert.equal(r.body.order.lines.length, 2);
  assert.equal(stock('SKU-BS-075'), 338);                 // 340 - 2
  assert.equal(stock('SKU-DT-1KG'), 84);
  const again = await edit(o.id, [BS(1)]);                // second edit keeps the FIRST original total
  assert.equal(again.body.order.originalTotalPaise, 458784);
});

test('edit to a short quantity: 409, and NOTHING changes (lines, stock, totals)', async () => {
  s.db.exec("UPDATE skus SET stock_cases = 5 WHERE code = 'SKU-BS-075'");
  const o = await place(sharma, [BS(4)]);                 // stock 1
  const r = await edit(o.id, [BS(6)]);                    // only 5 could be available
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'stock_unavailable');
  assert.equal(stock('SKU-BS-075'), 1);
  const d = await s.call('GET', `/api/desk/orders/${o.id}`, { token: desk });
  assert.equal(d.body.order.lines[0].qty, 4);
  assert.equal(d.body.order.originalTotalPaise, null);
});

test('only placed and credit_hold orders can be edited', async () => {
  const o = await place(sharma, [BS(1)]);
  await approve(o.id);
  assert.equal((await edit(o.id, [BS(2)])).status, 409);
  assert.equal((await edit(1, [BS(2)])).status, 409);     // exported
  const rej = await place(sharma, [BS(1)]);
  await reject(rej.id);
  assert.equal((await edit(rej.id, [BS(2)])).status, 409);
});

test('edit re-runs the credit check: a placed order that grows past the limit becomes credit_hold', async () => {
  const o = await place(gupta, [BS(1)]);                  // placed, 91,757
  const r = await edit(o.id, [BS(5)]);                    // 458,784; others 3,650,000 -> 4,108,784 > 4,000,000
  assert.equal(r.body.order.status, 'credit_hold');
  assert.equal(r.body.creditCheck.exceedsLimit, true);
  assert.equal(r.body.creditCheck.overByPaise, 108784);
  assert.match(r.body.order.holdReason, /above credit limit/);
});

test('a held order that now fits STAYS on hold (desk approves manually) and says so', async () => {
  const o = await place(gupta, [BS(5)]);                  // credit_hold
  const r = await edit(o.id, [BS(1)]);
  assert.equal(r.body.creditCheck.exceedsLimit, false);
  assert.equal(r.body.order.status, 'credit_hold');
  assert.match(r.body.order.holdReason, /approve to release/);
  assert.equal((await approve(o.id)).body.order.status, 'approved');
});

test('edit does not double count the order itself when it was placed', async () => {
  const o = await place(sharma, [BS(5)]);
  const r = await edit(o.id, [BS(5)]);                    // identical edit: must stay placed
  assert.equal(r.body.order.status, 'placed');
});

test('edit validation: bad items 400, unknown sku 400, unknown order 404', async () => {
  const o = await place(sharma, [BS(1)]);
  assert.equal((await edit(o.id, [])).status, 400);
  assert.equal((await edit(o.id, [BS(0)])).status, 400);
  assert.equal((await edit(o.id, [BS(1), BS(2)])).status, 400); // desk edit rejects duplicates
  assert.equal((await edit(o.id, [{ sku: 'SKU-NOPE-1', qty: 1 }])).status, 400);
  assert.equal((await edit(o.id, [{ ...BS(1), originalText: 5 }])).status, 400);
  assert.equal((await edit(99999, [BS(1)])).status, 404);
  assert.equal(stock('SKU-BS-075'), 339); // failed edits left the reservation as it was
});

// ---------- corrections become aliases ----------
test('desk correction creates an alias for THAT retailer only', async () => {
  const id = (await placeWithText(jain, 'SKU-BS-CR', 2, '2 peti meetha biscuit')).id;
  const r = await edit(id, [BS(2, '2 peti meetha biscuit')]);   // desk fixes the SKU
  assert.deepEqual(r.body.aliasesLearned, [{ phrase: 'meetha biscuit', sku: 'SKU-BS-075' }]);
  const row = s.db.prepare("SELECT sku_code FROM aliases WHERE retailer_id = 3 AND phrase = 'meetha biscuit'").get();
  assert.equal(row.sku_code, 'SKU-BS-075');
  assert.equal(s.db.prepare("SELECT COUNT(*) c FROM aliases WHERE phrase = 'meetha biscuit'").get().c, 1);
});

test('no alias when the sku is unchanged or the line has no original words', async () => {
  const placed = await placeWithText(jain, 'SKU-BS-CR', 2, '2 peti meetha biscuit');
  const same = await edit(placed.id, [{ sku: 'SKU-BS-CR', qty: 3, originalText: '2 peti meetha biscuit' }]);
  assert.deepEqual(same.body.aliasesLearned, []);
  const plain = await place(sharma, [BS(1)]);
  assert.deepEqual((await edit(plain.id, [{ sku: 'SKU-DT-1KG', qty: 1 }])).body.aliasesLearned, []);
});
