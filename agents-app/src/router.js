'use strict';
const { q } = require('./db');
const { ApiError, fail, now } = require('./util');
const { sha } = require('./passwords');
const { getUser } = require('./domain');

const routes = [];
const ADMIN = ['admin'];
const ANY = ['admin', 'agent'];

// roles: null = public; maxBody in bytes (images need more than the default).
function route(method, pattern, roles, handler, { maxBody = 64 * 1024 } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, roles, handler, maxBody });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError(413, 'الطلب كبير جداً'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(body && typeof body === 'object' ? body : {});
      } catch {
        reject(new ApiError(400, 'بيانات غير صالحة'));
      }
    });
    req.on('error', reject);
  });
}

function sessionUser(token) {
  if (!token) return null;
  const s = q('SELECT * FROM sessions WHERE token_hash = ?').get(sha(token));
  if (!s || s.expires_at < now()) return null;
  const user = getUser(s.user_id);
  return user && user.active ? user : null;
}

// Returns { status, body } or { raw } for handlers that stream their own response.
async function dispatch(req, res, url) {
  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) fail(404, 'غير موجود');
  const m = url.pathname.match(r.re);
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  let user = null;
  let token = null;
  if (r.roles) {
    token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    user = sessionUser(token);
    if (!user) fail(401, 'انتهت الجلسة. سجّل الدخول مرة أخرى.');
    if (!r.roles.includes(user.role)) fail(403, 'ليست لديك صلاحية لهذه العملية');
  }
  const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req, r.maxBody) : {};
  return r.handler({
    req, res, user, token, params, body,
    query: Object.fromEntries(url.searchParams),
    ip: req.socket.remoteAddress || '',
  });
}

module.exports = { route, dispatch, ADMIN, ANY };
