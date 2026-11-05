import test from 'node:test';
import assert from 'node:assert/strict';
import { casePricePaise, priceLine, priceCart } from '../src/schemeEngine.js';

const biscuit = { code: 'SKU-BS-075', casePricePaise: casePricePaise(8.1, 96), gstRate: 18,
  scheme: { type: 'free_goods', buy: 10, free: 1 } };
const detergent = { code: 'SKU-DT-1KG', casePricePaise: casePricePaise(101.5, 20), gstRate: 18,
  scheme: { type: 'slab_discount', minCases: 5, percent: 3 } };
const tea = { code: 'SKU-TE-250', casePricePaise: casePricePaise(118, 40), gstRate: 5, scheme: null };

test('case price from per-piece dealer price', () => {
  assert.equal(biscuit.casePricePaise, 77760);   // 8.10 x 96 = 777.60
  assert.equal(detergent.casePricePaise, 203000); // 101.50 x 20 = 2030.00
  assert.equal(tea.casePricePaise, 472000);       // 118 x 40 = 4720.00
});

test('buy 10 get 1: not applied at 5 cases, nudge asks for 5 more', () => {
  const l = priceLine(biscuit, 5);
  assert.equal(l.freeCases, 0);
  assert.equal(l.shippedCases, 5);
  assert.deepEqual(l.nudge, { type: 'free_goods', casesToAdd: 5, reward: '1 free case' });
});

test('buy 10 get 1: exactly 10 gives 1 free; price is for 10 only', () => {
  const l = priceLine(biscuit, 10);
  assert.equal(l.freeCases, 1);
  assert.equal(l.shippedCases, 11);
  assert.equal(l.grossPaise, 777600);
});

test('buy 10 get 1 repeats: 21 cases gives 2 free', () => {
  assert.equal(priceLine(biscuit, 21).freeCases, 2);
  assert.equal(priceLine(biscuit, 19).freeCases, 1);
  assert.equal(priceLine(biscuit, 20).freeCases, 2);
});

test('3% slab: 2 cases no discount, nudge to 5', () => {
  const l = priceLine(detergent, 2);
  assert.equal(l.discountPaise, 0);
  assert.equal(l.nudge.casesToAdd, 3);
});

test('3% slab: 5 cases gets 3% off the line', () => {
  const l = priceLine(detergent, 5);
  assert.equal(l.grossPaise, 1015000);
  assert.equal(l.discountPaise, 30450);
  assert.equal(l.netPaise, 984550);
  assert.equal(l.gstPaise, 177219); // 18% of 984550 = 177219.0
  assert.equal(l.totalPaise, 1161769);
});

test('no scheme: plain price, no nudge', () => {
  const l = priceLine(tea, 1);
  assert.equal(l.netPaise, 472000);
  assert.equal(l.nudge, null);
  assert.equal(l.appliedLabel, null);
});

test('rejects zero, negative and fractional quantities', () => {
  for (const bad of [0, -1, 1.5, NaN, '3']) {
    assert.throws(() => priceLine(biscuit, bad), RangeError);
  }
});

test('cart totals add up across lines', () => {
  const c = priceCart([{ sku: biscuit, qty: 10 }, { sku: detergent, qty: 5 }]);
  assert.equal(c.netPaise, 777600 + 984550);
  assert.equal(c.totalPaise, c.netPaise + c.gstPaise);
});
