'use strict';
// Vertex AI (Google Cloud): the WhatsApp assistant asks Gemini by the server's own Google identity, with no key kept.
process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'admin-pass';
process.env.VERTEX_RETRY_MS = '0';
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
    if (seen.busy > 0) { seen.busy--; res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Resource exhausted. Please try again later.' } })); }
    if (req.headers.authorization !== 'Bearer tok-1') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'bad token' } })); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ intro: 'أهلين فيك' }) }] } }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50 } }));
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
  const saved = wa.saveConfig({ aiModel: '' });
  assert.equal(saved.aiProvider, 'vertex', 'the only service: no key is needed or kept');
  assert.equal(saved.aiModel, 'gemini-3.1-flash-lite');
  const v = await wa._test.askModel('تعليمات', 'بيانات');
  assert.deepEqual(v, { intro: 'أهلين فيك' });
  const call = seen.calls.at(-1);
  assert.equal(call.url, '/v1/projects/agents-portal-test/locations/global/publishers/google/models/gemini-3.1-flash-lite:generateContent');
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
  // Only Gemini models; anything else falls back to the cheapest.
  assert.equal(wa.saveConfig({ aiModel: 'openai/gpt-oss-20b' }).aiModel, 'gemini-3.1-flash-lite');
  assert.equal(wa.saveConfig({ aiModel: 'gemini-3.8-flash' }).aiModel, 'gemini-3.8-flash');
});

test('the spend of the day is counted from what each answer used; the assistant stops at the manager limit', async () => {
  const wa = require('../src/whatsapp');
  const { q } = require('../src/db');
  q("DELETE FROM settings WHERE key = 'wa_ai_spend'").run();
  process.env.WA_AI_DAILY_USD = '0.0015'; wa.saveConfig({ aiModel: 'gemini-3.1-flash-lite', aiPriceIn: '', aiPriceOut: '' });
  vertexReset(wa);
  // 1000 tokens in at $0.25, 150 out (thinking included) at $1.50 a million: $0.000475 a question.
  assert.ok(await wa._test.askModel('تعليمات', 'بيانات'));
  assert.ok(await wa._test.askModel('تعليمات', 'بيانات'));
  const s = wa._test.spendToday();
  assert.deepEqual([s.calls, s.tokensIn, s.tokensOut, s.usd], [2, 2000, 300, 0.00095]);
  // The next one would pass $0.0015 (counted before it is asked, at a long answer): not asked; the manager is told once.
  const before = seen.calls.length;
  assert.equal(await wa._test.askModel('تعليمات', 'بيانات'), null);
  assert.equal(await wa._test.askModel('تعليمات', 'بيانات'), null);
  assert.equal(seen.calls.length, before, 'nothing sent past the limit');
  assert.match(wa.status().aiError, /حد الصرف اليومي/);
  assert.equal(q("SELECT COUNT(*) AS n FROM notifications WHERE title = 'حد صرف المساعد الذكي'").get().n, 1);
  // What the settings screen shows.
  const view = wa.configView();
  assert.equal(view.aiSpend.calls, 2);
  assert.ok(view.aiModels.some((m) => m.id === 'gemini-3.1-flash-lite' && m.in === 0.25));
  // A higher limit lets it go on; 0 pauses it.
  process.env.WA_AI_DAILY_USD = '0.6';
  assert.ok(await wa._test.askModel('تعليمات', 'بيانات'));
  process.env.WA_AI_DAILY_USD = '0';
  assert.equal(await wa._test.askModel('تعليمات', 'بيانات'), null);
  assert.match(wa.status().aiError, /موقوف/);
  // A model not on the list is counted at the dearest price; the manager's own prices win.
  process.env.WA_AI_DAILY_USD = '0.6'; wa.saveConfig({ aiModel: 'gemini-9-experimental' });
  assert.deepEqual(wa._test.priceOf(), { in: 1.5, out: 9, listed: false });
  wa.saveConfig({ aiPriceIn: 0.1, aiPriceOut: 0.4 });
  assert.deepEqual(wa._test.priceOf(), { in: 0.1, out: 0.4, listed: false });
  // The limit is the server's: a value given in the settings is not kept.
  delete process.env.WA_AI_DAILY_USD;
  wa.saveConfig({ aiDailyUsd: 50 });
  assert.equal(wa.config().aiDailyUsd, 0.5);
});
function vertexReset(wa) { wa._test.vertexAuth.token = ''; seen.tokens = 0; }

test('Google busy (429): asked again a moment later, then on the fallback model, then the menus', async () => {
  const wa = require('../src/whatsapp');
  process.env.WA_AI_DAILY_USD = '0.6'; wa.saveConfig({ aiModel: 'gemini-3.1-flash-lite', aiPriceIn: '', aiPriceOut: '' });
  wa._test.vertexAuth.token = '';
  seen.tokens = 0;
  // Busy once: the same model, again.
  let from = seen.calls.length;
  seen.busy = 1;
  assert.ok(await wa._test.askModel('تعليمات', 'بيانات'));
  assert.deepEqual(seen.calls.slice(from).map((c) => c.url.split('/models/')[1]), ['gemini-3.1-flash-lite:generateContent', 'gemini-3.1-flash-lite:generateContent']);
  // Busy twice: the fallback model answers.
  from = seen.calls.length;
  seen.busy = 2;
  assert.ok(await wa._test.askModel('تعليمات', 'بيانات'));
  assert.equal(seen.calls.at(-1).url.split('/models/')[1], 'gemini-3.5-flash-lite:generateContent');
  assert.equal(seen.calls.length - from, 3);
  // Busy every time: nothing made up; the error shows, and the menus answer.
  seen.busy = 4;
  assert.equal(await wa._test.askModel('تعليمات', 'بيانات'), null);
  assert.match(wa.status().aiError, /Vertex AI 429/);
  seen.busy = 0;
});
