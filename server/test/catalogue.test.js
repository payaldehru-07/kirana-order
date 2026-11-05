import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, PHONES } from './helpers.js';

let s, sharma, gupta, desk;
before(async () => {
  s = await startTestServer();
  sharma = await s.login(PHONES.sharma); // retailer 1
  gupta = await s.login(PHONES.gupta);   // retailer 2
  desk = await s.login(PHONES.desk);
  s.jain = await s.login('9000000003');  // retailer 3, has negotiated prices
});
after(() => s.close());

const find = (body, code) => body.items.find((i) => i.code === code);

test('catalogue needs a login', async () => {
  assert.equal((await s.call('GET', '/api/catalogue')).status, 401);
});

test('retailer gets all 20 SKUs with case price in paise, GST label and Hindi names', async () => {
  const r = await s.call('GET', '/api/catalogue', { token: gupta });
  assert.equal(r.status, 200);
  assert.equal(r.body.retailerId, 2);
  assert.equal(r.body.items.length, 20);
  const bs = find(r.body, 'SKU-BS-075');
  assert.equal(bs.casePricePaise, 77760);        // 8.10 x 96 = 777.60
  assert.equal(bs.pricePerPiecePaise, 810);
  assert.equal(bs.piecesPerCase, 96);
  assert.equal(bs.priceIncludesGst, false);
  assert.equal(bs.gstRate, 18);
  assert.equal(bs.gstLabel.en, 'Excl. 18% GST');
  assert.ok(bs.gstLabel.hi.includes('GST'));
  assert.equal(bs.casePriceInclGstPaise, 91757); // 77760 + round(13996.8)
  assert.match(bs.nameHi, /बिस्किट/);
});

test('zero-GST item is labelled as no GST', async () => {
  const r = await s.call('GET', '/api/catalogue', { token: gupta });
  const salt = find(r.body, 'SKU-SL-1KG');
  assert.equal(salt.gstRate, 0);
  assert.equal(salt.gstLabel.en, 'No GST (0%)');
  assert.equal(salt.casePriceInclGstPaise, salt.casePricePaise);
});

test("each retailer sees their OWN price: Jain's special rates are not visible to others", async () => {
  const jain = await s.call('GET', '/api/catalogue', { token: s.jain });
  const other = await s.call('GET', '/api/catalogue', { token: sharma });
  assert.equal(find(jain.body, 'SKU-BS-075').casePricePaise, 76320);   // 7.95 x 96
  assert.equal(find(jain.body, 'SKU-DT-1KG').casePricePaise, 200000);  // 100.00 x 20
  assert.equal(find(other.body, 'SKU-BS-075').casePricePaise, 77760);  // standard price
  assert.equal(find(other.body, 'SKU-DT-1KG').casePricePaise, 203000);
  assert.equal(find(other.body, 'SKU-TE-250').casePricePaise, 466000); // Sharma's own special tea rate 116.50 x 40
});

test('scheme text in English and Hindi, plus the raw scheme', async () => {
  const r = await s.call('GET', '/api/catalogue', { token: sharma });
  const bs = find(r.body, 'SKU-BS-075');
  assert.equal(bs.schemeText.en, 'Buy 10 cases, get 1 free');
  assert.match(bs.schemeText.hi, /मुफ़्त/);
  assert.deepEqual(bs.scheme, { type: 'free_goods', buy: 10, free: 1 });
  assert.equal(find(r.body, 'SKU-DT-1KG').schemeText.en, '3% off on 5 or more cases');
  assert.equal(find(r.body, 'SKU-TE-250').schemeText, null);
  assert.equal(find(r.body, 'SKU-TE-250').scheme, null);
});

test('stock status for retailers: out / low / in, and no exact stock numbers', async () => {
  const r = await s.call('GET', '/api/catalogue', { token: sharma });
  assert.equal(find(r.body, 'SKU-TE-250').stockStatus, 'out_of_stock'); // 0 cases
  assert.equal(find(r.body, 'SKU-TE-500').stockStatus, 'low_stock');    // 8 cases
  assert.equal(find(r.body, 'SKU-BS-075').stockStatus, 'in_stock');     // 340 cases
  for (const item of r.body.items) assert.equal('stockCases' in item, false);
});

test('a retailer never receives credit or balance data from the catalogue', async () => {
  const raw = JSON.stringify((await s.call('GET', '/api/catalogue', { token: sharma })).body).toLowerCase();
  for (const word of ['credit', 'outstanding', 'limit']) assert.equal(raw.includes(word), false, word);
});

test('retailer cannot ask for another retailer; own id is fine', async () => {
  assert.equal((await s.call('GET', '/api/catalogue?retailerId=2', { token: sharma })).status, 403);
  assert.equal((await s.call('GET', '/api/catalogue?retailerId=1', { token: sharma })).status, 200);
});

test('desk must name a retailer, gets exact stock, and sees that retailer\'s prices', async () => {
  assert.equal((await s.call('GET', '/api/catalogue', { token: desk })).status, 400);
  const r = await s.call('GET', '/api/catalogue?retailerId=3', { token: desk });
  assert.equal(r.status, 200);
  assert.equal(find(r.body, 'SKU-BS-075').casePricePaise, 76320);
  assert.equal(find(r.body, 'SKU-BS-075').stockCases, 340);
});

test('desk: unknown or malformed retailerId is rejected', async () => {
  assert.equal((await s.call('GET', '/api/catalogue?retailerId=999', { token: desk })).status, 404);
  for (const bad of ['abc', '0', '-1', '1.5', '1e3']) {
    assert.equal((await s.call('GET', `/api/catalogue?retailerId=${bad}`, { token: desk })).status, 400, bad);
  }
  assert.equal((await s.call('GET', '/api/catalogue?retailerId=1&retailerId=2', { token: desk })).status, 400); // repeated param
});

test('revalidation: ETag + private,no-cache; unchanged catalogue returns 304 with no body', async () => {
  const first = await s.call('GET', '/api/catalogue', { token: sharma });
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const conditional = { authorization: `Bearer ${sharma}`, 'if-none-match': etag };
  const again = await s.rawGet('/api/catalogue', conditional);
  assert.equal(again.status, 304);
  // stock changes -> content changes -> full response again
  s.db.exec("UPDATE skus SET stock_cases = 5 WHERE code = 'SKU-BS-075'");
  const changed = await s.rawGet('/api/catalogue', conditional);
  assert.equal(changed.status, 200);
  const fresh = await s.call('GET', '/api/catalogue', { token: sharma });
  assert.equal(find(fresh.body, 'SKU-BS-075').stockStatus, 'low_stock');
  s.db.exec("UPDATE skus SET stock_cases = 340 WHERE code = 'SKU-BS-075'");
});
