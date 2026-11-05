import express from 'express';
import { errorHandler, HttpError } from './errors.js';
import { createAuthRouter } from './routes/auth.js';

/** Builds the Express app. Takes db + config as arguments (no globals) so tests can inject an in-memory DB. */
export function createApp({ db, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');        // prices and credit are private: never cache in shared proxies
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', createAuthRouter({ db, config }));

  app.use('/api', () => { throw new HttpError(404, 'not_found', 'No such endpoint'); });
  app.use(errorHandler);
  return app;
}
