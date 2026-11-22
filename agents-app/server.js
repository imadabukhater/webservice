'use strict';
// eSIM shop server: the customer shop and the manager's portal (node:http + node:sqlite). Requires Node 22.13+.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

require('./src/db');
require('./src/routes/auth');
require('./src/routes/catalog');
require('./src/routes/tasks');
require('./src/routes/dashboard');
require('./src/routes/reports');
require('./src/routes/buyers');
require('./src/routes/quickline');
require('./src/routes/layan');
require('./src/routes/telecom');
require('./src/routes/aylol');
require('./src/routes/whatsapp');
require('./src/routes/shop');
require('./src/routes/health');
require('./src/autoexec');
require('./src/cloudbackup');
require('./src/autosync');
const { dispatch } = require('./src/router');
const { ApiError } = require('./src/util');
const seo = require('./src/seo');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "connect-src 'self'", "media-src 'self' blob:",
  "worker-src 'self'", "manifest-src 'self'", "frame-src 'self' blob: data:", "object-src 'none'", "base-uri 'self'",
  "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res, pathname, url) {
  if (pathname.split('/').some((seg) => seg.startsWith('.') && seg !== '.')) {
    res.writeHead(403);
    return res.end();
  }
  // Canonical host redirect for Google Search Console: apex hotesim.shop -> https://www.hotesim.shop
  const reqHost = String(req.headers.host || '').trim();
  if (/^hotesim\.shop(?::\d+)?$/i.test(reqHost)) {
    res.writeHead(301, { Location: `https://www.hotesim.shop${req.url}`, ...SECURITY_HEADERS });
    return res.end();
  }
  // Duplicate homepage URLs (/shop, /shop/, /shop.html) -> 301 to canonical /
  if (/^\/shop\/?$/i.test(pathname) || pathname.toLowerCase() === '/shop.html') {
    res.writeHead(301, { Location: `/${url.search || ''}`, ...SECURITY_HEADERS });
    return res.end();
  }
  // Dynamic XML sitemap with live /package/:id entries for Google Search.
  if (pathname === '/sitemap.xml') {
    const xml = seo.renderSitemapXml({ siteUrl: seo.siteOrigin(req) });
    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
      ...SECURITY_HEADERS,
    });
    return res.end(req.method === 'HEAD' ? undefined : xml);
  }
  // Dynamic server-rendered homepage (/) with live packages, prices, hreflang & Google Search Console schemas.
  if (pathname === '/') {
    const html = seo.renderHomeHtml({ siteUrl: seo.siteOrigin(req) });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
      ...SECURITY_HEADERS,
    });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }
  // Server-rendered SEO package pages (/package/:id) with tailored meta, JSON-LD & pre-rendered Arabic/English content.
  const pkgMatch = pathname.match(/^\/package\/(\d+)(?:\/.*)?$/);
  if (pkgMatch) {
    const { status, html } = seo.renderPackageHtml(pkgMatch[1], { siteUrl: seo.siteOrigin(req) });
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
      ...(status === 404 ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
      ...SECURITY_HEADERS,
    });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }
  // The manager's portal is served on /portal, /admin, /agent, /agents, or /index.html (never indexed by Google).
  const isPortal = /^\/(portal|admin|agent|agents)(\/|$)/i.test(pathname) || pathname === '/index.html';
  const page = isPortal ? 'index.html' : pathname;
  let file = path.normalize(path.join(PUBLIC_DIR, page));
  // Inside public/ only (with the separator, so a sibling folder whose name starts with "public" is not inside).
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (isPortal) {
      file = path.join(PUBLIC_DIR, 'index.html');
    } else {
      // Return a genuine HTTP 404 for unknown URLs so Google Search Console never flags Soft 404s.
      const { html } = seo.renderNotFoundHtml(seo.siteOrigin(req));
      res.writeHead(404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Robots-Tag': 'noindex, nofollow',
        'Content-Security-Policy': CSP,
        ...SECURITY_HEADERS,
      });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
  }
  const ext = path.extname(file);
  const shell = ext === '.html' || file.endsWith('sw.js');
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // Code and styles revalidate on every load so an update reaches phones right away.
    'Cache-Control': shell || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400',
    ...SECURITY_HEADERS,
    ...(isPortal ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
    ...(ext === '.html' ? { 'Content-Security-Policy': CSP } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

async function handle(req, res) {
  // Nothing a request carries may take the server down: an unhandled error here would end the whole process.
  let url;
  try {
    url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        return res.end();
      }
      return serveStatic(req, res, decodeURIComponent(url.pathname), url);
    }
  } catch {
    // A malformed address (e.g. a broken %-escape).
    if (res.headersSent) return res.destroy();
    res.writeHead(400);
    return res.end();
  }
  try {
    const out = await dispatch(req, res, url);
    if (!out?.raw) sendJson(res, 200, out);
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (e instanceof ApiError) return sendJson(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    sendJson(res, 500, { error: 'حدث خطأ في الخادم' });
  }
}

const server = http.createServer(handle);
if (require.main === module) {
  server.listen(PORT, () => console.log(`eSIM shop running on http://localhost:${PORT}`));
}
module.exports = { server };
