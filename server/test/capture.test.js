import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, PHONES } from './helpers.js';
import { parseMessage, itemPhrase, phraseKey } from '../src/capture/text.js';
import { createLlmExtractor, validateLlmLines } from '../src/capture/llm.js';

const SAMPLE = 'bhaiya 5 peti biscuit chhota, 2 peti washing powder 1 kilo, chai patti 250 wala 1 peti'; // from the client brief

// ---------- the parser, directly ----------
test('parser reads the brief\'s sample message into 3 lines with the shopkeeper\'s own words', () => {
  assert.deepEqual(parseMessage(SAMPLE), [
    { original: 'bhaiya 5 peti biscuit chhota', item: 'biscuit chhota', qty: 5, unit: 'case' },
    { original: '2 peti washing powder 1 kilo', item: 'washing powder 1000g', qty: 2, unit: 'case' },
    { original: 'chai patti 250 wala 1 peti', item: 'chai patti 250', qty: 1, unit: 'case' },
  ]);
});

test('parser: number words, "de do" is not the number 2, Devanagari, pieces, no unit, no quantity', () => {
  assert.deepEqual(parseMessage('do peti surf'), [{ original: 'do peti surf', item: 'surf', qty: 2, unit: 'case' }]);
  assert.equal(parseMessage('surf 2 peti de do')[0].qty, 2);
  assert.deepEqual(parseMessage('३ पेटी चीनी 1 किलो')[0], { original: '३ पेटी चीनी 1 किलो', item: 'sugar 1000g', qty: 3, unit: 'case' });
  assert.equal(parseMessage('96 pcs glucose biscuit 75')[0].unit, 'piece');
  assert.equal(parseMessage('5 biscuit')[0].unit, null);        // unit not written: stays null, never guessed
  assert.equal(parseMessage('tea 250')[0].qty, null);           // 250 is a pack size, not a quantity
  assert.deepEqual(parseMessage('hello bhaiya, thanks'), []);   // greeting only
});

test('alias phrases: quantity and unit removed, word order ignored', () => {
  assert.equal(itemPhrase('2 peti meetha biscuit'), 'meetha biscuit');
  assert.equal(phraseKey('biscuit chhota'), phraseKey('chhota biscuit'));
  assert.notEqual(phraseKey('tea 250'), phraseKey('tea 500'));
});

// ---------- the endpoint ----------
let s, sharma, gupta, jain, desk;
beforeEach(async () => {
  s = await startTestServer();
  sharma = await s.login(PHONES.sharma);
  gupta = await s.login(PHONES.gupta);
  jain = await s.login('9000000003');
  desk = await s.login(PHONES.desk);
});
afterEach(() => s.close());

const capture = (token, text, extra = {}) => s.call('POST', '/api/capture', { token, body: { text, ...extra } });
const orderCount = () => s.db.prepare('SELECT COUNT(*) c FROM orders').get().c;
const stock = (code) => s.db.prepare('SELECT stock_cases FROM skus WHERE code = ?').get(code).stock_cases;

test('the brief\'s message for Sharma: items, quantities, original words, confidence, 2 alternatives each', async () => {
  const r = await capture(sharma, SAMPLE);
  assert.equal(r.status, 200);
  assert.equal(r.body.extractedBy, 'local');
  assert.equal(r.body.fallbackReason, 'no_api_key');
  const [bs, dt, tea] = r.body.lines;
  assert.equal(bs.originalText, 'bhaiya 5 peti biscuit chhota');
  assert.equal(bs.sku, 'SKU-BS-075');
  assert.equal(bs.source, 'alias');                // Sharma has an alias for "biscuit chhota"
  assert.equal(bs.confidence, 'high');
  assert.equal(bs.qtyCases, 5);
  assert.equal(dt.sku, 'SKU-DT-1KG');              // "washing powder 1 kilo": size picks 1 kg over 500 g
  assert.equal(dt.confidence, 'high');
  assert.equal(dt.qtyCases, 2);
  assert.equal(tea.sku, 'SKU-TE-250');             // "250 wala" picks the 250 g tea
  assert.equal(tea.qtyCases, 1);
  for (const l of r.body.lines) {
    assert.equal(l.status, 'ready');
    assert.equal(l.alternatives.length, 2);
    assert.ok(l.alternatives.every((a) => a.sku !== l.sku));
  }
});

test('out-of-stock item is flagged on its line and on the quote', async () => {
  const r = await capture(sharma, SAMPLE);
  const tea = r.body.lines[2];
  assert.equal(tea.stock.status, 'out_of_stock');
  assert.equal(tea.stock.issue, 'out_of_stock');
  assert.equal(r.body.lines[0].stock.issue, null);
  assert.equal(r.body.quote.stockOk, false);
  assert.equal(r.body.quote.totals.totalPaise, 458784 + 479080 + 489300);
  assert.equal(r.body.allReady, true);             // parsed fine; the stock problem is for the person to resolve
  assert.equal(r.body.credit.exceedsLimit, false);
});

test('NOTHING is placed by capturing: no order, no stock change, no alias', async () => {
  const aliases = s.db.prepare('SELECT COUNT(*) c FROM aliases').get().c;
  await capture(sharma, SAMPLE);
  assert.equal(orderCount(), 5);
  assert.equal(stock('SKU-BS-075'), 340);
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM aliases').get().c, aliases);
});

test('a retailer without an alias: "biscuit chhota" is a medium-confidence guess with alternatives to pick from', async () => {
  const r = await capture(gupta, '5 peti biscuit chhota');
  const l = r.body.lines[0];
  assert.equal(l.sku, 'SKU-BS-075');               // smallest biscuit pack
  assert.equal(l.source, 'fuzzy');
  assert.equal(l.confidence, 'medium');            // chhota is a hint, not certainty
  assert.deepEqual(l.alternatives.map((a) => a.sku).sort(), ['SKU-BS-150', 'SKU-BS-CR']);
});

test('unit not written: the line asks (case or piece) and is not guessed or priced', async () => {
  const r = await capture(sharma, '5 biscuit chhota');
  const l = r.body.lines[0];
  assert.equal(l.status, 'needs_unit');
  assert.equal(l.qtyCases, null);
  assert.equal(l.quantityWritten, 5);
  assert.equal(l.unitWritten, null);
  assert.match(l.unitQuestion.en, /cases \(peti\) or pieces/);
  assert.match(l.unitQuestion.hi, /पेटी/);
  assert.equal(r.body.quote, null);
  assert.equal(r.body.allReady, false);
});

test('pieces: an exact number of cases is converted; anything else is asked', async () => {
  const ok = (await capture(sharma, '96 pcs glucose biscuit 75')).body.lines[0];
  assert.equal(ok.status, 'ready');
  assert.equal(ok.qtyCases, 1);                    // 96 pieces = 1 case of 96
  assert.equal(ok.note, 'converted_from_pieces');
  const odd = (await capture(sharma, '10 piece glucose biscuit 75')).body.lines[0];
  assert.equal(odd.status, 'needs_unit');
  assert.match(odd.unitQuestion.en, /not a whole number of cases/);
});

test('quantity not written, or not a whole number: asked', async () => {
  assert.equal((await capture(sharma, 'tea 250')).body.lines[0].status, 'needs_quantity');
  assert.equal((await capture(sharma, '1.5 peti sugar 1 kg')).body.lines[0].status, 'needs_quantity');
});

test('gibberish is unmatched (no SKU) and a greeting alone finds no items', async () => {
  const r = await capture(sharma, '2 peti asdfgh qwerty');
  assert.equal(r.body.lines[0].status, 'unmatched');
  assert.equal(r.body.lines[0].sku, null);
  const hi = await capture(sharma, 'hello bhaiya');
  assert.deepEqual(hi.body.lines, []);
  assert.equal(hi.body.warning, 'no_items_found');
  assert.equal(hi.body.allReady, false);
});

test('Hindi (Devanagari) and typo input', async () => {
  const hindi = (await capture(sharma, '3 पेटी चीनी 1 किलो')).body.lines[0];
  assert.equal(hindi.sku, 'SKU-SG-1KG');
  assert.equal(hindi.qtyCases, 3);
  const typo = (await capture(sharma, '2 peti detergnt powder 500 g')).body.lines[0];
  assert.equal(typo.sku, 'SKU-DT-500');
});

test('past orders break ties: same words, the retailer\'s usual product wins', async () => {
  // Gupta bought SKU-DT-500 before, Sharma did not. "detergent powder" fits both sizes equally.
  const g = (await capture(gupta, '1 peti detergent powder')).body.lines[0];
  assert.equal(g.sku, 'SKU-DT-500');
});

test('the quote uses the retailer\'s own price', async () => {
  const r = await capture(jain, '1 peti glucose biscuit 75');
  assert.equal(r.body.quote.lines[0].casePricePaise, 76320);
});

test('two lines for the same SKU are added together in the quote and marked as duplicates', async () => {
  const r = await capture(sharma, '2 peti glucose biscuit 75, 3 peti glucose biscuit 75');
  assert.equal(r.body.lines[1].duplicateOf, 0);
  assert.equal(r.body.quote.lines.length, 1);
  assert.equal(r.body.quote.lines[0].qty, 5);
});

test('learned alias: after a desk correction the same words map correctly for that retailer only', async () => {
  const placed = await s.call('POST', '/api/capture/confirm', { token: jain, body: { items: [{ sku: 'SKU-BS-CR', qty: 2, originalText: '2 peti meetha biscuit' }] } });
  await s.call('PUT', `/api/desk/orders/${placed.body.order.id}/lines`, {
    token: desk, body: { items: [{ sku: 'SKU-BS-075', qty: 2, originalText: '2 peti meetha biscuit' }] },
  });
  const j = (await capture(jain, '3 peti meetha biscuit')).body.lines[0];
  assert.equal(j.sku, 'SKU-BS-075');
  assert.equal(j.source, 'alias');
  assert.equal(j.confidence, 'high');
  const other = (await capture(sharma, '3 peti meetha biscuit')).body.lines[0];
  assert.notEqual(other.source, 'alias');
});

// ---------- permissions and validation ----------
test('capture needs login; desk must name a retailer; a retailer cannot capture for another', async () => {
  assert.equal((await capture(undefined, SAMPLE)).status, 401);
  assert.equal((await capture(desk, SAMPLE)).status, 400);
  assert.equal((await capture(desk, SAMPLE, { retailerId: 2 })).body.retailerId, 2);
  assert.equal((await capture(desk, SAMPLE, { retailerId: 999 })).status, 404);
  assert.equal((await capture(sharma, SAMPLE, { retailerId: 2 })).status, 403);
});

test('text validation: missing, empty, not text, too long', async () => {
  for (const text of [undefined, '', '   ', 5, ['a'], 'x'.repeat(2001)]) {
    assert.equal((await capture(sharma, text)).status, 400, String(text).slice(0, 20));
  }
  assert.equal((await capture(sharma, 'x'.repeat(2000))).status, 200);
});

// ---------- confirm ----------
test('confirm places the order (source ai_text) with the original words kept on each line', async () => {
  const draft = (await capture(sharma, '5 peti biscuit chhota, 2 peti washing powder 1 kilo')).body;
  const items = draft.lines.map((l) => ({ sku: l.sku, qty: l.qtyCases, originalText: l.originalText }));
  const r = await s.call('POST', '/api/capture/confirm', { token: sharma, body: { items } });
  assert.equal(r.status, 201);
  assert.equal(r.body.order.source, 'ai_text');
  assert.equal(r.body.order.status, 'placed');
  assert.equal(r.body.order.lines[0].originalText, '5 peti biscuit chhota');
  assert.equal(r.body.order.totals.totalPaise, draft.quote.totals.totalPaise);   // confirm matches the draft quote
  assert.equal(stock('SKU-BS-075'), 335);
});

test('confirm merges repeated SKUs, applies stock and credit rules, and is idempotent', async () => {
  const merged = await s.call('POST', '/api/capture/confirm', {
    token: sharma, body: { items: [{ sku: 'SKU-BS-075', qty: 3, originalText: 'a' }, { sku: 'SKU-BS-075', qty: 2, originalText: 'b' }] },
  });
  assert.equal(merged.body.order.lines.length, 1);
  assert.equal(merged.body.order.lines[0].qty, 5);
  assert.equal(merged.body.order.lines[0].originalText, 'a + b');

  const oos = await s.call('POST', '/api/capture/confirm', { token: sharma, body: { items: [{ sku: 'SKU-TE-250', qty: 1 }] } });
  assert.equal(oos.status, 409);

  const held = await s.call('POST', '/api/capture/confirm', { token: gupta, body: { items: [{ sku: 'SKU-BS-075', qty: 5 }], clientRef: 'capture-ref-0001' } });
  assert.equal(held.body.order.status, 'credit_hold');
  const again = await s.call('POST', '/api/capture/confirm', { token: gupta, body: { items: [{ sku: 'SKU-BS-075', qty: 5 }], clientRef: 'capture-ref-0001' } });
  assert.equal(again.status, 200);
  assert.equal(again.body.order.id, held.body.order.id);
});

test('confirm permissions and validation', async () => {
  const items = [{ sku: 'SKU-BS-075', qty: 1 }];
  assert.equal((await s.call('POST', '/api/capture/confirm', { body: { items } })).status, 401);
  assert.equal((await s.call('POST', '/api/capture/confirm', { token: sharma, body: { items, retailerId: 2 } })).status, 403);
  assert.equal((await s.call('POST', '/api/capture/confirm', { token: desk, body: { items } })).status, 400);
  const byDesk = await s.call('POST', '/api/capture/confirm', { token: desk, body: { items, retailerId: 2 } });
  assert.equal(byDesk.status, 201);
  assert.equal(byDesk.body.order.retailerId, 2);
  for (const bad of [[], [{ sku: 'SKU-BS-075', qty: 0 }], [{ sku: 'SKU-NOPE-1', qty: 1 }], [{ sku: 'SKU-BS-075', qty: 1, originalText: 'x'.repeat(201) }]]) {
    assert.equal((await s.call('POST', '/api/capture/confirm', { token: sharma, body: { items: bad } })).status, 400);
  }
});

// ---------- LLM path (fake API: no network, no key) ----------
function fakeApi(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return responder(); };
  return { calls, fetchImpl };
}
const textReply = (obj) => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: `Here you go:\n${JSON.stringify(obj)}` }] }) });

test('with an LLM configured: it extracts the lines, the local matcher still picks the SKUs, the key is never exposed', async (t) => {
  const api = fakeApi(() => textReply({ lines: [{ original: '2 peti sabun', item: 'sabun', qty: 2, unit: 'case' }] }));
  const extractor = createLlmExtractor({ apiKey: 'sk-test-secret', model: 'test-model', fetchImpl: api.fetchImpl });
  const s2 = await startTestServer({}, { extractor });
  t.after(() => s2.close());
  const token = await s2.login(PHONES.sharma);
  const r = await s2.call('POST', '/api/capture', { token, body: { text: 'bhaiya 2 peti sabun bhej do' } });
  assert.equal(r.body.extractedBy, 'llm');
  assert.equal(r.body.fallbackReason, null);
  assert.equal(r.body.lines[0].sku, 'SKU-SP-100');            // sabun -> bath soap, chosen by the local matcher
  assert.equal(r.body.lines[0].qtyCases, 2);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(api.calls[0].init.headers['x-api-key'], 'sk-test-secret');
  assert.equal(api.calls[0].body.model, 'test-model');
  assert.ok(api.calls[0].body.messages[0].content.includes('bhaiya 2 peti sabun bhej do'));
  assert.equal(JSON.stringify(r.body).includes('sk-test-secret'), false);
});

test('LLM failures never break capture: HTTP error, timeout-like throw, bad JSON, invented lines all fall back to local', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const failures = {
    http500: () => ({ ok: false, status: 500, json: async () => ({}) }),
    thrown: () => { throw new Error('network down'); },
    notJson: () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'sorry, cannot help' }] }) }),
    invented: () => textReply({ lines: [{ original: '9 peti kaju katli', item: 'kaju katli', qty: 9, unit: 'case' }] }), // not in the message
    badQty: () => textReply({ lines: [{ original: '2 peti surf', item: 'surf', qty: -2, unit: 'case' }] }),
    badUnit: () => textReply({ lines: [{ original: '2 peti surf', item: 'surf', qty: 2, unit: 'dozen' }] }),
    empty: () => textReply({ lines: [] }),
  };
  for (const [name, responder] of Object.entries(failures)) {
    const extractor = createLlmExtractor({ apiKey: 'k', model: 'm', fetchImpl: fakeApi(responder).fetchImpl });
    const s2 = await startTestServer({}, { extractor });
    const token = await s2.login(PHONES.sharma);
    const r = await s2.call('POST', '/api/capture', { token, body: { text: '2 peti surf' } });
    assert.equal(r.status, 200, name);
    assert.equal(r.body.extractedBy, 'local', name);
    assert.match(r.body.fallbackReason, /llm_/, name);
    assert.match(r.body.lines[0].sku, /^SKU-DT-/, name);                 // local parser still finds the detergent family
    assert.equal(r.body.lines[0].qtyCases, 2, name);
    assert.equal(r.body.lines[0].originalText, '2 peti surf', name);
    await s2.close();
  }
});

test('LLM output validation: strict shape, and "original" must be the shopkeeper\'s own words', () => {
  const ok = { lines: [{ original: '2 PETI  surf', item: 'surf', qty: 2, unit: 'case' }] };
  assert.equal(validateLlmLines(ok, 'bhaiya 2 peti surf bhejna')[0].item, 'surf');   // case and spacing tolerated
  assert.deepEqual(validateLlmLines({ lines: [{ original: 'surf', item: 'surf' }] }, 'surf')[0], { original: 'surf', item: 'surf', qty: null, unit: null });
  for (const bad of [null, {}, { lines: 'x' }, { lines: [null] }, { lines: [{ original: 'surf', item: '' }] },
    { lines: [{ original: 'not there', item: 'surf' }] }, { lines: [{ original: 'surf', item: 'surf', qty: '2' }] }]) {
    assert.throws(() => validateLlmLines(bad, 'surf'), /llm_invalid_output/);
  }
});
