'use strict';
// Agents portal server: zero dependencies (node:http + node:sqlite + node:crypto). Requires Node 22.13+.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

require('./src/db');
require('./src/routes/auth');
require('./src/routes/catalog');
require('./src/routes/lines');
require('./src/routes/sims');
require('./src/routes/tasks');
require('./src/routes/agents');
require('./src/routes/dashboard');
require('./src/routes/reports');
const { dispatch } = require('./src/router');
const { ApiError } = require('./src/util');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "connect-src 'self'", "media-src 'self' blob:",
  "worker-src 'self'", "manifest-src 'self'", "frame-src 'self' blob: data:", "object-src 'none'", "base-uri 'self'",
  "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  const ext = path.extname(file);
  const shell = ext === '.html' || file.endsWith('sw.js');
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // Code and styles revalidate on every load so an update reaches phones right away.
    'Cache-Control': shell || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400',
    ...SECURITY_HEADERS,
    ...(ext === '.html' ? { 'Content-Security-Policy': CSP } : {}),
  });
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    return serveStatic(req, res, decodeURIComponent(url.pathname));
  }
  try {
    const out = await dispatch(req, res, url);
    if (!out?.raw) sendJson(res, 200, out);
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (e instanceof ApiError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'حدث خطأ في الخادم' });
  }
}

const server = http.createServer(handle);
if (require.main === module) {
  server.listen(PORT, () => console.log(`Agents portal running on http://localhost:${PORT}`));
}
module.exports = { server };
