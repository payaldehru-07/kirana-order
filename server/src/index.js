import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

// Local development: read server/.env if present (never committed). Real env vars always win in production.
if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const db = openDb(config.dbFile);
if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  console.warn('[db] database is empty. Run "npm run seed" first.');
}

createApp({ db, config }).listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});
