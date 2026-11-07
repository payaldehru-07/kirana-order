import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, PHONES } from './helpers.js';
import { tallyXml, tallyCsv, rs } from '../src/tally.js';

let s, sharma, gupta, jain, desk;
beforeEach(async () => {
  s = await startTestServer();
  sharma = await s.login(PHONES.sharma);
  gupta = await s.login(PHONES.gupta);
  jain = await s.login('9000000003');
  desk = await s.login(PHONES.desk);
});
afterEach(() => s.close());

const item = (sku, qty) => ({ sku, qty });
const place = async (token, items) => (await s.call('POST', '/api/orders', { token, body: { items } })).body.order;
const approve = (id) => s.call('POST', `/api/desk/orders/${id}/approve`, { token: desk });
const exportAll = () => s.call('POST', '/api/desk/exports', { token: desk, body: {} });
const me = async (token) => (await s.call('GET', '/api/me', { token })).body.retailer;

async function twoApprovedOneWaiting() {
  const a = await place(sharma, [item('SKU-BS-075', 5), item('SKU-DT-1KG', 2)]); // 937,864
  const b = await place(jain, [item('SKU-BS-075', 1)]);                          // 90,058
  const waiting = await place(gupta, [item('SKU-BS-075', 1)]);                   // stays placed
  await approve(a.id); await approve(b.id);
  return { a, b, waiting };
}

test('export takes ONLY approved orders and marks them exported', async () => {
  const { a, b, waiting } = await twoApprovedOneWaiting();
  const r = await exportAll();
  assert.equal(r.status, 201);
  assert.equal(r.body.export.orderCount, 2);
  assert.equal(r.body.export.totalPaise, 937864 + 90058);
  const status = async (id) => (await s.call('GET', `/api/desk/orders/${id}`, { token: desk })).body.order;
  assert.equal((await status(a.id)).status, 'exported');
  assert.equal((await status(a.id)).exportId, r.body.export.id);
  assert.equal((await status(b.id)).status, 'exported');
  assert.equal((await status(waiting.id)).status, 'placed');
});

test('A9: export moves the total from pending into outstanding; available credit does not change (no double count)', async () => {
  await twoApprovedOneWaiting();
  const before = await me(sharma);
  assert.equal(before.outstandingPaise, 1_200_000);
  assert.equal(before.pendingPaise, 937_864);
  await exportAll();
  const after = await me(sharma);
  assert.equal(after.outstandingPaise, 1_200_000 + 937_864);
  assert.equal(after.pendingPaise, 0);
  assert.equal(after.availableCreditPaise, before.availableCreditPaise);
  assert.equal((await me(jain)).outstandingPaise, 2_000_000 + 90_058);
});

test('exporting again with nothing approved is 409, and nothing is exported twice', async () => {
  await twoApprovedOneWaiting();
  await exportAll();
  const again = await exportAll();
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'nothing_to_export');
  assert.equal((await me(sharma)).outstandingPaise, 1_200_000 + 937_864);
});

test('only approved orders go to Tally: an edited-then-approved order uses its NEW total, a held order stays out', async () => {
  const o = await place(sharma, [item('SKU-BS-075', 5)]);
  await s.call('PUT', `/api/desk/orders/${o.id}/lines`, { token: desk, body: { items: [item('SKU-BS-075', 2)] } });
  await approve(o.id);
  const held = await place(gupta, [item('SKU-BS-075', 5)]); // credit_hold, not approved
  const r = await exportAll();
  assert.equal(r.body.export.orderCount, 1);
  assert.equal(r.body.export.totalPaise, 183_514); // 2 biscuit cases: 155,520 + 27,994 GST
  assert.equal((await s.call('GET', `/api/desk/orders/${held.id}`, { token: desk })).body.order.status, 'credit_hold');
});

test('download CSV and XML: right type, attachment header, correct money, re-downloadable', async () => {
  const { a } = await twoApprovedOneWaiting();
  const id = (await exportAll()).body.export.id;
  const base = `/api/desk/exports/${id}/file`;
  const call = async (q) => {
    const res = await fetch(`${s.base}${base}${q}`, { headers: { authorization: `Bearer ${desk}` } });
    return { status: res.status, type: res.headers.get('content-type'), disp: res.headers.get('content-disposition'), text: await res.text() };
  };
  const csv = await call('?format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.type, /text\/csv/);
  assert.match(csv.disp, /attachment; filename="tally-export-\d+\.csv"/);
  assert.ok(csv.text.startsWith('voucher_no,date,party,sku_code'));
  assert.ok(csv.text.includes(`ORD-${a.id},`));
  assert.ok(csv.text.includes('Sharma Kirana Store,SKU-BS-075,"Glucose biscuit 75 g, case of 96",5,0,5,'));
  assert.ok(csv.text.includes('3888.00,699.84,4587.84,9378.64'));   // taxable, GST, line total, order total
  const xml = await call('?format=xml');
  assert.match(xml.type, /application\/xml/);
  assert.ok(xml.text.includes('<VOUCHERNUMBER>ORD-' + a.id + '</VOUCHERNUMBER>'));
  assert.ok(xml.text.includes('<PARTYLEDGERNAME>Sharma Kirana Store</PARTYLEDGERNAME>'));
  assert.ok(xml.text.includes('<AMOUNT>-9378.64</AMOUNT>'));       // party ledger = GST-inclusive total
  assert.ok(xml.text.includes('<AMOUNT>1430.64</AMOUNT>'));        // GST ledger
  assert.equal((await call('')).text, xml.text);                   // default format is xml, same file again
});

test('free goods appear as a zero-rate line in the Tally file', async () => {
  const o = await place(sharma, [item('SKU-BS-075', 10)]);
  await approve(o.id);
  const id = (await exportAll()).body.export.id;
  const res = await fetch(`${s.base}/api/desk/exports/${id}/file?format=xml`, { headers: { authorization: `Bearer ${desk}` } });
  const xml = await res.text();
  assert.ok(xml.includes('<ACTUALQTY>10 case</ACTUALQTY>'));
  assert.ok(xml.includes('<RATE>0.00/case</RATE>') && xml.includes('<ACTUALQTY>1 case</ACTUALQTY>'));
});

test('export file validation: bad format 400, unknown or malformed id', async () => {
  await twoApprovedOneWaiting();
  const id = (await exportAll()).body.export.id;
  assert.equal((await s.call('GET', `/api/desk/exports/${id}/file?format=pdf`, { token: desk })).status, 400);
  assert.equal((await s.call('GET', '/api/desk/exports/999/file', { token: desk })).status, 404);
  assert.equal((await s.call('GET', '/api/desk/exports/abc/file', { token: desk })).status, 400);
  const list = await s.call('GET', '/api/desk/exports', { token: desk });
  assert.equal(list.body.exports[0].id, id);
});

// ---------- file formatting, directly ----------
const sample = (shopName) => [{
  id: 7, source: 'app', createdAt: '2026-11-06T20:00:00Z', shopName,
  totals: { netPaise: 100, gstPaise: 18, totalPaise: 118 },
  lines: [{ skuCode: 'SKU-X', name: 'Item', qty: 1, freeCases: 0, shippedCases: 1, casePricePaise: 100, discountPaise: 0, netPaise: 100, gstPaise: 18, totalPaise: 118 }],
}];

test('money formatting uses integers only', () => {
  assert.equal(rs(5), '0.05');
  assert.equal(rs(100), '1.00');
  assert.equal(rs(937864), '9378.64');
  assert.equal(rs(-250), '-2.50');
});

test('XML escapes special characters in names', () => {
  const xml = tallyXml(sample('A & B <Traders> "Best"'));
  assert.ok(xml.includes('A &amp; B &lt;Traders&gt; &quot;Best&quot;'));
  assert.equal(xml.includes('<Traders>'), false);
});

test('voucher date is the Indian date: 20:00 UTC on 6 Nov is already 7 Nov in India', () => {
  assert.ok(tallyXml(sample('Shop')).includes('<DATE>20261107</DATE>'));
});

test('CSV neutralises spreadsheet formulas and quotes commas', () => {
  const csv = tallyCsv(sample('=HYPERLINK("http://evil")'));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`));
  assert.ok(tallyCsv(sample('Gupta, Sons')).includes('"Gupta, Sons"'));
});

test('waiting endpoint: counts only approved orders, and POST export returns the orders it took', async () => {
  const waitingNow = async () => (await s.call('GET', '/api/desk/exports/waiting', { token: desk })).body;
  assert.deepEqual(await waitingNow(), { orderCount: 0, totalPaise: 0, orders: [] });

  const { a, b } = await twoApprovedOneWaiting(); // third order stays 'placed' and must not be counted
  const w = await waitingNow();
  assert.equal(w.orderCount, 2);
  assert.equal(w.totalPaise, 937864 + 90058);
  assert.deepEqual(w.orders.map((o) => [o.id, o.shopName, o.totalPaise]), [
    [a.id, 'Sharma Kirana Store', 937864], [b.id, 'Jain Provision', 90058],
  ]);

  const r = await exportAll();
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.orders.map((o) => o.id), [a.id, b.id]);
  assert.deepEqual(await waitingNow(), { orderCount: 0, totalPaise: 0, orders: [] }); // nothing waiting after export
});
