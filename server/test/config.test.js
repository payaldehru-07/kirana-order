import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

// Render deployment rules: the server must listen on the PORT it is given and must not start in production without a secret.
test('production refuses to start without SESSION_SECRET', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: '' }), /SESSION_SECRET/);
});

test('production starts when SESSION_SECRET is set, and uses the PORT from the environment', () => {
  const c = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), PORT: '10000' });
  assert.equal(c.production, true);
  assert.equal(c.port, 10000);
  assert.equal(c.sessionSecret, 'x'.repeat(32));
});

test('PORT must be a valid port', () => {
  assert.throws(() => loadConfig({ SESSION_SECRET: 's', PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ SESSION_SECRET: 's', PORT: '70000' }), /PORT/);
});
