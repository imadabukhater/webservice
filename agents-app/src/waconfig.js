'use strict';
// The WhatsApp agent's settings: who it answers, the assistant (Gemini on the owner's Google Cloud project, by the
// server's own identity: no key anywhere) and its daily spending limit.
// Changed only on the server, by the account's owner (scripts/whatsapp-settings.js); never from the portal, where the
// manager can only link and unlink WhatsApp. Read at every message, so a change applies at once, without a restart.
const { q, setSetting } = require('./db');
const { normalizePhone, str, fail } = require('./util');

const get = (k, d = '') => q('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? d;
const phoneList = (v) => [...new Set(String(v || '').split(/[\s,،;]+/).map(normalizePhone).filter((p) => /^\d{9,13}$/.test(p)))];

// The models the owner picks from (Gemini on Vertex AI), with list prices in $ per million tokens (input / output;
// thinking counts as output). Prices change: the owner can set the ones they pay; a model not listed counts at the dearest.
const AI_MODELS = [
  { id: 'gemini-3.1-flash-lite', providers: ['vertex'], in: 0.25, out: 1.5, label: 'Gemini 3.1 Flash-Lite — الأرخص' },
  { id: 'gemini-3.5-flash-lite', providers: ['vertex'], in: 0.3, out: 2.5, label: 'Gemini 3.5 Flash-Lite' },
  { id: 'gemini-3.5-flash', providers: ['vertex'], in: 1.5, out: 9, label: 'Gemini 3.5 Flash — الأقوى والأغلى' },
];
const UNLISTED_PRICE = { in: 1.5, out: 9 };
const DEFAULT_DAILY_USD = 0.5;
// Only Gemini models; anything else falls back to the cheapest.
function modelFor(model) {
  return model && /^gemini[\w.-]*$/i.test(model) ? model : 'gemini-3.1-flash-lite';
}
// The assistant answers whenever the day's limit is above 0 (Vertex AI needs no key).
const aiReady = (c) => c.aiDailyUsd > 0;

function config() {
  return {
    enabled: get('wa_enabled', '1') !== '0',
    customers: get('wa_customers', '1') !== '0',
    admins: phoneList(get('wa_admins')),
    shopUrl: get('wa_shop_url'),
    aiProvider: 'vertex',
    aiModel: modelFor(get('wa_ai_model')),
    welcome: get('wa_welcome'),
    // At most this much spent on the assistant a day ($); 0 pauses it. Prices: the manager's, else the model's list price.
    aiDailyUsd: get('wa_ai_daily_usd') === '' ? DEFAULT_DAILY_USD : Math.max(0, Number(get('wa_ai_daily_usd')) || 0),
    aiPriceIn: get('wa_ai_price_in') === '' ? null : Number(get('wa_ai_price_in')),
    aiPriceOut: get('wa_ai_price_out') === '' ? null : Number(get('wa_ai_price_out')),
    // What the manager tells the assistant (opening hours, delivery, policies…): part of every question it answers.
    knowledge: get('wa_knowledge'),
  };
}

function saveConfig(body = {}) {
  if (body.enabled !== undefined) setSetting('wa_enabled', body.enabled ? '1' : '0');
  if (body.customers !== undefined) setSetting('wa_customers', body.customers ? '1' : '0');
  if (body.admins !== undefined) setSetting('wa_admins', phoneList(body.admins).join(','));
  if (body.shopUrl !== undefined) {
    const u = str(body.shopUrl, 200);
    if (u && !/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(u)) fail(400, 'رابط المتجر يبدأ بـ https://');
    setSetting('wa_shop_url', u.replace(/[#?].*$/, '').replace(/\/+$/, ''));
  }
  if (body.aiModel !== undefined) setSetting('wa_ai_model', /^[\w./:-]{3,80}$/.test(String(body.aiModel)) ? String(body.aiModel) : '');
  if (body.welcome !== undefined) setSetting('wa_welcome', str(body.welcome, 300));
  if (body.knowledge !== undefined) setSetting('wa_knowledge', str(body.knowledge, 2000));
  const money = (v, label, max) => {
    if (v === undefined) return undefined;
    if (v === '' || v === null) return '';
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max) fail(400, `${label}: رقم من 0 إلى ${max}`);
    return String(Math.round(n * 10000) / 10000);
  };
  for (const [field, key, label, max] of [['aiDailyUsd', 'wa_ai_daily_usd', 'حد الصرف اليومي', 100],
    ['aiPriceIn', 'wa_ai_price_in', 'سعر الإدخال', 100], ['aiPriceOut', 'wa_ai_price_out', 'سعر الإخراج', 100]]) {
    const v = money(body[field], label, max);
    if (v !== undefined) setSetting(key, v);
  }
  return config();
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Gaza', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function priceOf(c = config()) {
  const listed = AI_MODELS.find((m) => m.id === c.aiModel && m.providers.includes(c.aiProvider));
  const base = listed || UNLISTED_PRICE;
  return { in: c.aiPriceIn ?? base.in, out: c.aiPriceOut ?? base.out, listed: !!listed };
}
function spendToday() {
  let s = null;
  try { s = JSON.parse(get('wa_ai_spend') || 'null'); } catch {}
  return s && s.day === today() ? s : { day: today(), usd: 0, calls: 0, tokensIn: 0, tokensOut: 0, stoppedAt: 0 };
}
const costOf = (tokensIn, tokensOut, p) => (tokensIn * p.in + tokensOut * p.out) / 1e6;

module.exports = { get, config, saveConfig, priceOf, spendToday, today, costOf, AI_MODELS, modelFor, aiReady, DEFAULT_DAILY_USD };
