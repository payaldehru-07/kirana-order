import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, inTransaction, migrate } from '../src/db.js';

test('inTransaction commits when fn succeeds', () => {
  const db = openDb(':memory:');
  inTransaction(db, () => db.exec("INSERT INTO retailers (shop_name,owner_name,area,salesman,credit_limit_paise) VALUES ('A','B','C','D',1)"));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM retailers').get().c, 1);
});

test('inTransaction rolls everything back when fn throws, and the DB stays usable', () => {
  const db = openDb(':memory:');
  assert.throws(() => inTransaction(db, () => {
    db.exec("INSERT INTO retailers (shop_name,owner_name,area,salesman,credit_limit_paise) VALUES ('A','B','C','D',1)");
    throw new Error('boom');
  }), /boom/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM retailers').get().c, 0);
  // a stuck transaction would make this next BEGIN fail
  inTransaction(db, () => db.exec("INSERT INTO retailers (shop_name,owner_name,area,salesman,credit_limit_paise) VALUES ('A','B','C','D',1)"));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM retailers').get().c, 1);
});

test('migrate upgrades an orders table that predates client_ref, and is safe to run twice', () => {
  const db = openDb(':memory:');
  db.exec('DROP INDEX idx_orders_client_ref');
  db.exec('ALTER TABLE orders DROP COLUMN client_ref'); // simulate a DB from Step 1 or 2
  migrate(db);
  migrate(db);
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  assert.ok(cols.includes('client_ref'));
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orders_client_ref'").get();
  assert.ok(idx);
});
