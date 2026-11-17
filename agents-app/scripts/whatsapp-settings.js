'use strict';
// The WhatsApp agent's settings, changed on the server by the account's owner only (the portal can only link and
// unlink WhatsApp). A change applies at the next message, without a restart. Run it as the app's user:
//
//   sudo -u agents env DB_FILE=/var/lib/agents-app/agents.db node /opt/agents/webservice/agents-app/scripts/whatsapp-settings.js
//       → shows the settings (never the key) and what the assistant spent today
//   … whatsapp-settings.js limit 0.5            daily spending limit in $ (0 pauses the assistant)
//   … whatsapp-settings.js provider groq        gemini | groq | vertex (Google Cloud, no key)
//   … whatsapp-settings.js model gemini-3.1-flash-lite
//   … whatsapp-settings.js key                  reads the key from the keyboard (not shown, never on the command line)
//   … whatsapp-settings.js key-clear
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
    `الخدمة:             ${c.aiProvider}${c.aiProvider === 'vertex' ? ' (بلا مفتاح)' : ''}`,
    `المفتاح:            ${c.aiKey ? `محفوظ (…${c.aiKey.slice(-4)}, ${c.aiKey.length} حرفاً)` : 'لا يوجد'}`,
    `النموذج:            ${c.aiModel}`,
    `السعر لكل مليون:    $${p.in} / $${p.out}${p.listed ? '' : ' (غير مدرج: أغلى سعر)'}`,
    `حد الصرف اليومي:    $${c.aiDailyUsd}`,
    `صرف اليوم (${s.day}): $${Number(s.usd).toFixed(4)} · ${s.calls} سؤال`,
    `المساعد يعمل:       ${WC.aiReady(c) && c.aiDailyUsd > 0 ? 'نعم' : 'لا'}`,
  ];
  console.log(lines.join('\n'));
}

function readSecret(prompt) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) { // piped: the first line
      let data = '';
      stdin.on('data', (d) => { data += d; }).on('end', () => resolve(data.split(/\r?\n/)[0].trim()));
      return;
    }
    stdout.write(prompt);
    stdin.setRawMode(true);
    let s = '';
    stdin.on('data', function onData(buf) {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); return resolve(s.trim()); }
        if (ch === '\u0003') { stdout.write('\n'); process.exit(1); }
        if (ch === '\u007f') s = s.slice(0, -1); else s += ch;
      }
    });
  });
}

(async () => {
  try {
    const set = (body) => { WC.saveConfig(body); console.log('✔ تم الحفظ — يسري من الرسالة التالية.\n'); show(); };
    switch (cmd) {
      case undefined: case 'show': return show();
      case 'limit': return set({ aiDailyUsd: value });
      case 'provider':
        if (!WC.PROVIDERS.includes(value)) { console.error(`اختر: ${WC.PROVIDERS.join(' | ')}`); process.exit(1); }
        return set({ aiProvider: value });
      case 'model': return set({ aiModel: value });
      case 'key': {
        const k = await readSecret('الصق المفتاح ثم Enter (لا يظهر): ');
        if (!k) { console.error('لم يُدخل مفتاح'); process.exit(1); }
        return set({ aiKey: k });
      }
      case 'key-clear': return set({ aiKeyClear: true });
      case 'replies': return set({ enabled: onOff(value) });
      case 'customers': return set({ customers: onOff(value) });
      case 'admins': return set({ admins: value });
      case 'shop-url': return set({ shopUrl: value });
      case 'welcome': return set({ welcome: value });
      case 'price-in': return set({ aiPriceIn: value });
      case 'price-out': return set({ aiPriceOut: value });
      default:
        console.error('أوامر: show | limit | provider | model | key | key-clear | replies | customers | admins | shop-url | welcome | price-in | price-out');
        process.exit(1);
    }
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(1);
  }
})();
