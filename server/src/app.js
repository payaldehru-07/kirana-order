import express from 'express';
import { fileURLToPath } from 'node:url';
import { gzipStatic } from './staticFiles.js';
import { errorHandler, HttpError } from './errors.js';
import { createAuthRouter } from './routes/auth.js';
import { createCatalogueRouter } from './routes/catalogue.js';
import { createCartRouter } from './routes/cart.js';
import { createOrdersRouter } from './routes/orders.js';
import { createDeskRouter } from './routes/desk.js';
import { createCaptureRouter } from './routes/capture.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url)); // the front-end files (server/public)

/**
 * Builds the Express app. Takes db + config (+ an optional LLM extractor) as arguments, with no globals,
 * so tests can inject an in-memory DB and a fake LLM.
 */
export function createApp({ db, config, extractor = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // Front end: static files with a strict content-security policy (only our own scripts, styles and data: images).
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) {
      res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      res.set('X-Content-Type-Options', 'nosniff');
    }
    next();
  });
  app.use(gzipStatic(PUBLIC_DIR));
  app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.set('Cache-Control', 'no-cache') })); // fallback for browsers without gzip

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');        // prices and credit are private: never cache in shared proxies
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', createAuthRouter({ db, config }));
  app.use('/api', createCatalogueRouter({ db, config }));
  app.use('/api', createCartRouter({ db, config }));
  app.use('/api', createOrdersRouter({ db, config }));
  app.use('/api', createDeskRouter({ db, config }));
  app.use('/api', createCaptureRouter({ db, config, extractor }));

  app.use('/api', () => { throw new HttpError(404, 'not_found', 'No such endpoint'); });
  app.use(errorHandler);
  return app;
}
