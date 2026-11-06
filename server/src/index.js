import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createLlmExtractor } from './capture/llm.js';

// Local development: read server/.env if present (never committed). Real env vars always win in production.
if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const db = openDb(config.dbFile);
if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  console.warn('[db] database is empty. Run "npm run seed" first.');
}

const extractor = config.anthropicApiKey
  ? createLlmExtractor({ apiKey: config.anthropicApiKey, model: config.llmModel })
  : null;
console.log(extractor ? `[capture] LLM extraction on (${config.llmModel}), local parser as fallback` : '[capture] no ANTHROPIC_API_KEY: local parser only');

createApp({ db, config, extractor }).listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});
