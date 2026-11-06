import { randomBytes } from 'node:crypto';

// ASSUMPTION A7: OTP is mocked. Every login uses this fixed code; no SMS is sent.
export const MOCK_OTP = '123456';

/** Read settings from environment variables. Secrets are NEVER hard-coded or committed. */
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';

  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    if (production) throw new Error('SESSION_SECRET must be set when NODE_ENV=production');
    sessionSecret = randomBytes(32).toString('hex');
    console.warn('[config] SESSION_SECRET not set: using a random one, so logins reset on every restart');
  }

  const port = Number(env.PORT ?? 3000);
  const ttlHours = Number(env.TOKEN_TTL_HOURS ?? 12);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid port number');
  if (!(ttlHours > 0)) throw new Error('TOKEN_TTL_HOURS must be a positive number');

  return {
    production,
    port,
    dbFile: env.DB_FILE || 'kirana.db',
    sessionSecret,
    tokenTtlSeconds: Math.round(ttlHours * 3600),
    anthropicApiKey: env.ANTHROPIC_API_KEY || null, // optional: without it, capture uses the local parser
    llmModel: env.LLM_MODEL || 'claude-haiku-5-5',
  };
}
