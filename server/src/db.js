import { DatabaseSync } from 'node:sqlite';

export function openDb(file = process.env.DB_FILE || 'kirana.db') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
