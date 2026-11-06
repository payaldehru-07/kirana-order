import { DatabaseSync } from 'node:sqlite';

export function openDb(file = process.env.DB_FILE || 'kirana.db') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Run fn() as ONE all-or-nothing database transaction.
 * BEGIN IMMEDIATE takes the write lock up front, so nobody else can change stock or credit between
 * our checks and our inserts. If fn throws, everything it did is rolled back.
 */
export function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Upgrades a database created by an earlier step, so an existing kirana.db keeps working (no re-seed needed). */
export function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!cols.includes('client_ref')) db.exec('ALTER TABLE orders ADD COLUMN client_ref TEXT');
  // One client_ref per retailer: a repeated tap with the same ref returns the first order instead of creating a second.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_ref
           ON orders(retailer_id, client_ref) WHERE client_ref IS NOT NULL`);
}

// Money is integer paise everywhere. Quantities are whole cases.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS retailers (
  id INTEGER PRIMARY KEY,
  shop_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  area TEXT NOT NULL,
  salesman TEXT NOT NULL,
  credit_limit_paise INTEGER NOT NULL CHECK (credit_limit_paise >= 0),
  outstanding_paise INTEGER NOT NULL DEFAULT 0 CHECK (outstanding_paise >= 0)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('retailer','desk')),
  retailer_id INTEGER REFERENCES retailers(id),
  CHECK ((role = 'retailer') = (retailer_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS skus (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_hi TEXT NOT NULL,
  brand TEXT NOT NULL,
  pieces_per_case INTEGER NOT NULL CHECK (pieces_per_case > 0),
  price_per_piece REAL NOT NULL CHECK (price_per_piece > 0),
  gst_rate INTEGER NOT NULL,
  stock_cases INTEGER NOT NULL CHECK (stock_cases >= 0),
  scheme_json TEXT,
  image TEXT
);

-- Retailer-specific price overrides (per piece). Falls back to skus.price_per_piece.
CREATE TABLE IF NOT EXISTS retailer_prices (
  retailer_id INTEGER NOT NULL REFERENCES retailers(id),
  sku_code TEXT NOT NULL REFERENCES skus(code),
  price_per_piece REAL NOT NULL,
  PRIMARY KEY (retailer_id, sku_code)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  retailer_id INTEGER NOT NULL REFERENCES retailers(id),
  source TEXT NOT NULL CHECK (source IN ('app','ai_text')),
  status TEXT NOT NULL CHECK (status IN ('placed','credit_hold','approved','rejected','exported')),
  net_paise INTEGER NOT NULL,
  gst_paise INTEGER NOT NULL,
  total_paise INTEGER NOT NULL,
  hold_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  client_ref TEXT
);

CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku_code TEXT NOT NULL REFERENCES skus(code),
  qty_cases INTEGER NOT NULL CHECK (qty_cases > 0),
  free_cases INTEGER NOT NULL DEFAULT 0,
  case_price_paise INTEGER NOT NULL,
  discount_paise INTEGER NOT NULL DEFAULT 0,
  net_paise INTEGER NOT NULL,
  gst_paise INTEGER NOT NULL,
  original_text TEXT
);

-- Per-retailer learned phrases ("chhota biscuit" -> SKU). Created from desk corrections.
CREATE TABLE IF NOT EXISTS aliases (
  retailer_id INTEGER NOT NULL REFERENCES retailers(id),
  phrase TEXT NOT NULL,
  sku_code TEXT NOT NULL REFERENCES skus(code),
  PRIMARY KEY (retailer_id, phrase)
);

CREATE INDEX IF NOT EXISTS idx_orders_retailer ON orders(retailer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
`;
