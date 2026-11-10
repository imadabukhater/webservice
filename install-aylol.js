'use strict';
// Aylol Telecom (أيلول) setup for the agents portal — safe to run at any time, as many times as needed.
//
// It never touches git (no reset, no clean, no checkout) and never rewrites the app's code: the customer shop and
// every other change stay exactly as deployed. The Aylol integration is part of the code itself (agents-app/src/aylol.js
// and src/routes/aylol.js), so `sudo agents-update` keeps it. This script only:
//   1. checks this server's code includes Aylol (if not, it says how to update, and changes nothing);
//   2. saves the Aylol account in the settings (from environment variables, never written in any file);
//   3. runs a first sync of Aylol's cards and new lines.
// The account can also be entered later from the portal: الإعدادات ← أيلول, and synced from الشركات والرزم ← أيلول.
//
// On the server (from the repository folder, e.g. /opt/agents/webservice):
//   sudo AYLOL_USER='you@example.com' AYLOL_PASS='your-password' node install-aylol.js
//   sudo node install-aylol.js            (no account: only checks; enter it in الإعدادات ← أيلول)
//   sudo node install-aylol.js --no-sync  (save the account, sync later)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const args = new Set(process.argv.slice(2));
const say = (msg) => console.log(msg);
const stop = (msg, code = 1) => { console.error(`✖ ${msg}`); process.exit(code); };

// ---------- 1. the app and its code ----------
function findApp() {
  for (const dir of [process.cwd(), path.join(process.cwd(), 'agents-app'), path.join(__dirname, 'agents-app'), __dirname]) {
    if (fs.existsSync(path.join(dir, 'server.js')) && fs.existsSync(path.join(dir, 'src', 'db.js'))) return dir;
  }
  return null;
}
const APP = findApp();
if (!APP) stop('لم أجد مجلد التطبيق (agents-app). شغّل السكربت من مجلد المستودع، مثل: cd /opt/agents/webservice');

const has = (file, text) => {
  try { return fs.readFileSync(path.join(APP, file), 'utf8').includes(text); } catch { return false; }
};
const integrated = fs.existsSync(path.join(APP, 'src', 'aylol.js')) && fs.existsSync(path.join(APP, 'src', 'routes', 'aylol.js'))
  && has('server.js', "require('./src/routes/aylol')") && has('src/db.js', 'aylolCredentials') && has('src/autoexec.js', 'sendAy');
if (!integrated) {
  stop([
    'كود هذا الخادم لا يتضمن أيلول بعد. لم أغيّر أي شيء.',
    '  حدّث الخادم إلى الفرع الذي يتضمن أيلول ومتجر الزبائن، ثم أعد تشغيل هذا السكربت:',
    '    sudo agents-update',
  ].join('\n'));
}

// ---------- the database the running service uses ----------
function serviceDbFile() {
  if (process.env.DB_FILE) return process.env.DB_FILE;
  try {
    const unit = fs.readFileSync('/etc/systemd/system/agents-app.service', 'utf8');
    const m = /DB_FILE=(\S+)/.exec(unit);
    if (m) return m[1];
  } catch {}
  if (fs.existsSync('/var/lib/agents-app/agents.db')) return '/var/lib/agents-app/agents.db';
  return path.join(APP, 'data', 'agents.db');
}
const DB_FILE = serviceDbFile();
if (!fs.existsSync(DB_FILE)) stop(`قاعدة البيانات غير موجودة: ${DB_FILE} — شغّل التطبيق مرة أولاً.`);
const AYLOL_DATA = process.env.AYLOL_DATA || path.join(path.dirname(DB_FILE), 'aylol');

// As root, carry on as the service's own user, so the database and Aylol's files keep their owner.
if (typeof process.getuid === 'function' && process.getuid() === 0 && !args.has('--as-service-user')) {
  const owner = fs.statSync(DB_FILE).uid;
  if (owner !== 0) {
    let name = '';
    try { name = execFileSync('id', ['-nu', String(owner)], { encoding: 'utf8' }).trim(); } catch {}
    if (!name) stop(`لم أجد مستخدم الخدمة (uid ${owner}) مالك ${DB_FILE}`);
    const r = spawnSync('runuser', ['-u', name, '--', process.execPath, __filename, ...process.argv.slice(2), '--as-service-user'], {
      stdio: 'inherit', env: { ...process.env, DB_FILE, AYLOL_DATA },
    });
    if (r.error) stop(`تعذّر التشغيل كمستخدم الخدمة: ${r.error.message}`);
    process.exit(r.status ?? 1);
  }
}

// ---------- 2. the account ----------
process.env.DB_FILE = DB_FILE;
process.env.AYLOL_DATA = AYLOL_DATA;
process.chdir(APP);
const { getSettings, setSetting } = require(path.join(APP, 'src', 'db'));

say(`✔ التطبيق: ${APP}`);
say(`✔ قاعدة البيانات: ${DB_FILE}`);
say('✔ أيلول مدمج في كود هذا الخادم (لم يُلمس git ولا أي ملف من ملفات التطبيق)');

try { execFileSync('curl', ['--version'], { stdio: 'ignore' }); } catch {
  stop('برنامج curl غير مثبت، وأيلول يحتاجه. ثبّته ثم أعد التشغيل: sudo apt-get install -y curl');
}

const user = String(process.env.AYLOL_USER || process.env.AYLOL_EMAIL || '').trim();
const pass = String(process.env.AYLOL_PASS || '');
if (user || pass) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) stop('AYLOL_USER يجب أن يكون بريد حساب أيلول');
  if (!pass) stop('AYLOL_PASS فارغ');
  setSetting('aylol_user', user.slice(0, 120));
  setSetting('aylol_pass', pass.slice(0, 200));
  say(`✔ حُفظ حساب أيلول: ${user}`);
}
if (!getSettings().aylolConfigured) {
  say('ℹ لم يُضبط حساب أيلول بعد: أدخله من البوابة (الإعدادات ← أيلول)، أو أعد التشغيل مع AYLOL_USER و AYLOL_PASS.');
  process.exit(0);
}

// ---------- 3. first sync ----------
if (args.has('--no-sync')) {
  say('ℹ تخطّيت المزامنة (--no-sync). زامن من البوابة: الشركات والرزم ← أيلول.');
  process.exit(0);
}
(async () => {
  const { aylolCredentials } = require(path.join(APP, 'src', 'db'));
  const { syncKind } = require(path.join(APP, 'src', 'routes', 'aylol'));
  let failed = 0;
  for (const [kind, label] of [['card', 'الكروت'], ['invoice', 'الخطوط الجديدة و eSIM']]) {
    try {
      const r = await syncKind(aylolCredentials(), kind);
      say(`✔ مزامنة ${label}: ${r.total} رزمة (جديدة ${r.added}، محدّثة ${r.updated}، أسعار تنتظر اعتمادك ${r.pending})`);
    } catch (e) {
      failed++;
      console.error(`⚠ مزامنة ${label}: ${e.message}`);
    }
  }
  say(failed ? 'ℹ راجع البريد وكلمة المرور، ثم زامن من البوابة.' : '✔ تم. الموقع يقرأ الإعدادات مباشرة: لا حاجة لإعادة تشغيله.');
  process.exit(failed === 2 ? 1 : 0);
})();
