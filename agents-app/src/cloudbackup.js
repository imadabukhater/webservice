'use strict';
// A daily copy of the whole database in Google Cloud Storage, so the data outlives the server.
// On Google Compute Engine it signs in as the VM's own service account (through the metadata server), and the bucket
// comes from BACKUP_BUCKET or the instance metadata attribute «backup-bucket»; without a bucket it does nothing.
// Each copy is a consistent snapshot (VACUUM INTO), gzipped, under a new name, and is only ever created: the server
// can neither overwrite nor delete a copy (ifGenerationMatch=0, and the bucket grants it object creation only).
// Old copies are removed by the bucket's own lifecycle rule.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { db, setSetting, getSettings } = require('./db');
const { now } = require('./util');
const D = require('./domain');

const META = process.env.GCE_METADATA_URL || 'http://metadata.google.internal/computeMetadata/v1';
const STORAGE = process.env.GCS_URL || 'https://storage.googleapis.com';
const EVERY_MS = 24 * 60 * 60_000;
const CHECK_MS = Number(process.env.BACKUP_CHECK_MS) || 60 * 60_000; // how often it looks whether a copy is due

async function meta(p) {
  const r = await fetch(`${META}/${p}`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`metadata ${p}: ${r.status}`);
  return r.text();
}

// The bucket, looked up every time so adding the metadata attribute later needs no restart.
async function bucket() {
  if (process.env.BACKUP_BUCKET) return process.env.BACKUP_BUCKET;
  try { return (await meta('instance/attributes/backup-bucket')).trim(); } catch { return ''; }
}

let running = null;
// Makes one copy now. Returns { bucket, name, bytes }; throws with a message for the manager.
function backupNow() {
  running ??= (async () => {
    const b = await bucket();
    if (!b) throw new Error('لم يُحدَّد مكان النسخ السحابي بعد (backup-bucket)');
    const file = path.join(os.tmpdir(), `agents-cloud-${process.pid}-${now()}.db`);
    try {
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      const body = zlib.gzipSync(fs.readFileSync(file));
      let token;
      try {
        token = JSON.parse(await meta('instance/service-accounts/default/token')).access_token;
      } catch (e) {
        throw new Error(`تعذّر الحصول على صلاحية Google Cloud (${e.message})`);
      }
      const name = `agents-${new Date().toISOString().replace(/[:.]/g, '-')}.db.gz`;
      let r;
      try {
        r = await fetch(`${STORAGE}/upload/storage/v1/b/${encodeURIComponent(b)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/gzip' },
          body,
          signal: AbortSignal.timeout(120_000),
        });
      } catch (e) {
        throw new Error(`تعذّر الاتصال بـ Cloud Storage (${e.message})`);
      }
      if (!r.ok) {
        const why = (await r.text()).slice(0, 200);
        throw new Error(r.status === 403 ? `لا صلاحية للكتابة في ${b} — راجع صلاحيات السيرفر (${why})` : `رفض Cloud Storage النسخة (${r.status}) ${why}`);
      }
      setSetting('backup_bucket', b);
      setSetting('backup_last_at', now());
      setSetting('backup_last_name', name);
      setSetting('backup_last_bytes', body.length);
      setSetting('backup_error', '');
      return { bucket: b, name, bytes: body.length };
    } finally {
      fs.rm(file, { force: true }, () => {});
    }
  })().finally(() => { running = null; });
  return running;
}

// The schedule: a copy when the last good one is a day old. A failure is recorded and tried again within the hour;
// the manager is told when copies start failing (not every hour after).
async function tick() {
  if (!(await bucket())) return;
  const s = getSettings();
  if (s.backupLastAt && now() - s.backupLastAt < EVERY_MS - CHECK_MS / 2) return;
  try {
    await backupNow();
  } catch (e) {
    if (!s.backupError) {
      D.notify({ role: 'admin', kind: 'task', title: 'تعذّر النسخ الاحتياطي السحابي', body: e.message, link: '#/settings' });
    }
    setSetting('backup_error', e.message.slice(0, 300) || 'خطأ غير معروف');
  }
}

// Only where it runs for real (the production server, or a bucket given explicitly).
if (process.env.NODE_ENV === 'production' || process.env.BACKUP_BUCKET) {
  setTimeout(() => tick().catch((e) => console.error('cloud backup', e)), 60_000).unref();
  setInterval(() => tick().catch((e) => console.error('cloud backup', e)), CHECK_MS).unref();
}

module.exports = { backupNow, tick, bucket };
