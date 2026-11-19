'use strict';
// The WhatsApp agent's settings, changed on the server by the account's owner only (the portal can only link and
// unlink WhatsApp). A change applies at the next message, without a restart. Run it as the app's user:
//
//   sudo -u agents env DB_FILE=/var/lib/agents-app/agents.db node /opt/agents/webservice/agents-app/scripts/whatsapp-settings.js
//       → shows the settings (never the key) and what the assistant spent today
//   (the daily spending limit is fixed at $0.5 by the app: it is not changed here)
//   … whatsapp-settings.js model gemini-3.1-flash-lite   (Gemini on your Google Cloud project; no key)
//   … whatsapp-settings.js replies on|off       customers on|off
//   … whatsapp-settings.js admins 0599000111,0599000222
//   … whatsapp-settings.js shop-url https://www.example.com/shop
//   … whatsapp-settings.js welcome "أهلين فيك"
//   … whatsapp-settings.js price-in 0.25        price-out 1.5   ($ per million tokens; "" = the model's list price)
//
// It loads the settings only (src/waconfig.js), never the WhatsApp link, so it does not disturb the running bot.
const WC = require('../src/waconfig');

const [cmd, ...rest] = process.argv.slice(2);
const value = rest.join(' ');
const onOff = (v) => {
  if (!/^(on|off|1|0|yes|no)$/i.test(v)) { console.error('اكتب on أو off'); process.exit(1); }
  return /^(on|1|yes)$/i.test(v);
};

function show() {
  const c = WC.config();
  const s = WC.spendToday();
  const p = WC.priceOf(c);
  const lines = [
    `الرد على الرسائل:   ${c.enabled ? 'on' : 'off'}`,
    `الرد على الزبائن:   ${c.customers ? 'on' : 'off'}`,
    `أرقام المدير:       ${c.admins.join(', ') || '—'}`,
    `رابط المتجر:        ${c.shopUrl || '—'}`,
    `رسالة الترحيب:      ${c.welcome || '—'}`,
    `الخدمة:             Google Cloud (Vertex AI) — بلا مفتاح`,
    `النموذج:            ${c.aiModel}`,
    `السعر لكل مليون:    $${p.in} / $${p.out}${p.listed ? '' : ' (غير مدرج: أغلى سعر)'}`,
    `حد الصرف اليومي:    $${c.aiDailyUsd}`,
    `صرف اليوم (${s.day}): $${Number(s.usd).toFixed(4)} · ${s.calls} سؤال`,
    `المساعد يعمل:       ${WC.aiReady(c) && c.aiDailyUsd > 0 ? 'نعم' : 'لا'}`,
  ];
  console.log(lines.join('\n'));
}

(async () => {
  try {
    const set = (body) => { WC.saveConfig(body); console.log('✔ تم الحفظ — يسري من الرسالة التالية.\n'); show(); };
    switch (cmd) {
      case undefined: case 'show': return show();
      case 'limit': console.error('حد الصرف اليومي ثابت: نص دولار ($0.5) في اليوم، ولا يتغيّر.'); process.exit(1); break;
      case 'model':
        if (!/^gemini[\w.-]*$/i.test(value)) { console.error(`نماذج: ${WC.AI_MODELS.map((m) => m.id).join(' | ')}`); process.exit(1); }
        return set({ aiModel: value });
      case 'replies': return set({ enabled: onOff(value) });
      case 'customers': return set({ customers: onOff(value) });
      case 'admins': return set({ admins: value });
      case 'shop-url': return set({ shopUrl: value });
      case 'welcome': return set({ welcome: value });
      case 'price-in': return set({ aiPriceIn: value });
      case 'price-out': return set({ aiPriceOut: value });
      default:
        console.error('أوامر: show | model | replies | customers | admins | shop-url | welcome | price-in | price-out');
        process.exit(1);
    }
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(1);
  }
})();
