import { readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { gzipSync } from 'node:zlib';

// Serves the front-end files from public/, gzipped. Gzip makes the text files about 4x smaller, which matters on slow 3G.
// Each file is compressed once and kept in memory until the file changes on disk. The ETag lets the phone re-check
// with a tiny 304 answer instead of downloading the file again.
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

export function gzipStatic(dir) {
  const cache = new Map(); // file name -> { mtime, gz, etag }
  return (req, res, next) => {
    if (req.method !== 'GET' || !/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) return next();
    const name = req.path === '/' ? 'index.html' : req.path.slice(1);
    const type = TYPES[extname(name)];
    // Only plain file names (no "/" and no "..") so a request can never walk out of public/.
    if (!type || !/^[\w.-]+$/.test(name) || name.startsWith('.')) return next();
    let st;
    try { st = statSync(join(dir, name)); } catch { return next(); }
    if (!st.isFile()) return next();

    let hit = cache.get(name);
    if (!hit || hit.mtime !== st.mtimeMs) {
      const gz = gzipSync(readFileSync(join(dir, name)), { level: 9 });
      hit = { mtime: st.mtimeMs, gz, etag: `"${st.mtimeMs}-${gz.length}"` };
      cache.set(name, hit);
    }
    res.set({ 'Content-Type': type, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', ETag: hit.etag, 'Cache-Control': 'no-cache' });
    if (req.headers['if-none-match'] === hit.etag) return res.status(304).end();
    return res.send(hit.gz);
  };
}
