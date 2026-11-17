'use strict';
// Vertex AI (Google Cloud): the WhatsApp assistant asks Gemini by the server's own Google identity, with no key kept.
process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'admin-pass';
process.env.WA_DATA = require('node:path').join(require('node:os').tmpdir(), `wa-vertex-${process.pid}`);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const seen = { tokens: 0, calls: [] };
// The Compute Engine metadata server and Vertex AI, as they answer.
const google = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url.startsWith('/computeMetadata/')) {
      if (req.headers['metadata-flavor'] !== 'Google') { res.writeHead(403); return res.end(); }
      if (req.url.endsWith('/project/project-id')) return res.end('agents-portal-test');
      if (req.url.endsWith('/service-accounts/default/token')) {
        seen.tokens++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ access_token: `tok-${seen.tokens}`, expires_in: 3599, token_type: 'Bearer' }));
      }
    }
    seen.calls.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    if (req.headers.authorization !== 'Bearer tok-1') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'bad token' } })); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ intro: 'أهلين فيك' }) }] } }] }));
  });
});

test.before(async () => {
  await new Promise((r) => google.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${google.address().port}`;
  process.env.METADATA_BASE = base;
  process.env.VERTEX_BASE = base;
});
test.after(() => google.close());

test('Vertex AI: no key, the server\'s token and project; the instructions apart from the data', async () => {
  const wa = require('../src/whatsapp');
  const saved = wa.saveConfig({ aiProvider: 'vertex', aiModel: '' });
  assert.equal(saved.aiProvider, 'vertex');
  assert.equal(saved.hasAiKey, false, 'no key is needed or kept');
  assert.equal(saved.aiModel, 'gemini-2.5-flash');
  const v = await wa._test.askModel('تعليمات', 'بيانات');
  assert.deepEqual(v, { intro: 'أهلين فيك' });
  const call = seen.calls.at(-1);
  assert.equal(call.url, '/v1/projects/agents-portal-test/locations/global/publishers/google/models/gemini-2.5-flash:generateContent');
  assert.equal(call.auth, 'Bearer tok-1');
  assert.equal(call.body.systemInstruction.parts[0].text, 'تعليمات');
  assert.equal(call.body.contents[0].parts[0].text, 'بيانات');
  // The token is kept until it expires: one token for many questions.
  await wa._test.askModel('تعليمات', 'بيانات');
  assert.equal(seen.tokens, 1);
  // Refused (an expired token): asked for a new one the next time; meanwhile nothing is made up.
  wa._test.vertexAuth.token = 'tok-old';
  assert.equal(await wa._test.askModel('تعليمات', 'بيانات'), null);
  assert.match(wa.status().aiError, /Vertex AI 401/);
  assert.equal(wa._test.vertexAuth.token, '');
  // A model of another service left over falls back to Gemini's.
  assert.equal(wa.saveConfig({ aiModel: 'openai/gpt-oss-20b' }).aiModel, 'gemini-2.5-flash');
  assert.equal(wa.saveConfig({ aiModel: 'gemini-3.8-flash' }).aiModel, 'gemini-3.8-flash');
});
