'use strict';
const { q, tx } = require('../db');
const { fail, now, normalizeIccid } = require('../util');
const D = require('../domain');
const { route, ADMIN, ANY } = require('../router');

const simView = (s) => ({
  id: s.id, iccid: s.iccid, companyId: s.company_id, companyName: s.company_name || '', companyColor: s.company_color || '',
  agentId: s.agent_id, agentName: s.agent_name || '', status: s.status, lineId: s.line_id, lineNumber: s.line_number || '',
  createdAt: s.created_at, usedAt: s.used_at,
});

// Agents see their own stock. The manager sees everything; forAgent = that agent's SIMs plus the manager's own stock.
route('GET', '/api/sims', ANY, ({ user, query }) => {
  const args = [];
  let where = '1=1';
  if (user.role === 'agent') { where += ' AND s.agent_id = ?'; args.push(user.id); }
  else if (query.forAgent) { where += ' AND (s.agent_id = ? OR s.agent_id IS NULL)'; args.push(Number(query.forAgent)); }
  else if (query.agentId === 'stock') where += ' AND s.agent_id IS NULL';
  else if (query.agentId) { where += ' AND s.agent_id = ?'; args.push(Number(query.agentId)); }
  if (query.status) { where += ' AND s.status = ?'; args.push(String(query.status)); }
  if (query.companyId) { where += ' AND s.company_id = ?'; args.push(Number(query.companyId)); }
  return q(`SELECT s.*, c.name AS company_name, c.color AS company_color, u.name AS agent_name, l.number AS line_number
            FROM sims s LEFT JOIN companies c ON c.id = s.company_id LEFT JOIN users u ON u.id = s.agent_id
            LEFT JOIN lines l ON l.id = s.line_id
            WHERE ${where} ORDER BY s.status, s.created_at DESC, s.id DESC LIMIT 5000`).all(...args).map(simView);
});

// Bulk add (typed, pasted or scanned). The company comes from the ICCID prefix when it is known.
route('POST', '/api/sims', ANY, ({ user, body }) => tx(() => {
  const agentId = user.role === 'agent' ? user.id : body.agentId ? D.getAgent(body.agentId).id : null;
  const fallbackCompany = body.companyId ? q('SELECT id FROM companies WHERE id = ?').get(Number(body.companyId))?.id ?? null : null;
  const list = [].concat(body.iccids || []).map(normalizeIccid).filter(Boolean);
  if (!list.length) fail(400, 'أدخل رقم شريحة واحداً على الأقل');
  if (list.length > 500) fail(400, 'الحد الأقصى 500 شريحة في المرة الواحدة');
  const added = [];
  const duplicates = [];
  const invalid = [];
  const seen = new Set();
  for (const iccid of list) {
    if (seen.has(iccid)) continue;
    seen.add(iccid);
    if (!/^\d{18,22}$/.test(iccid)) { invalid.push(iccid); continue; }
    if (q('SELECT 1 FROM sims WHERE iccid = ?').get(iccid) || q("SELECT 1 FROM lines WHERE sim = ? AND status != 'disconnected'").get(iccid)) {
      duplicates.push(iccid);
      continue;
    }
    const detected = D.companyForIccid(iccid);
    const companyId = detected?.id ?? fallbackCompany;
    q('INSERT INTO sims (iccid, company_id, agent_id, created_at) VALUES (?, ?, ?, ?)').run(iccid, companyId, agentId, now());
    if (!detected && companyId) D.learnPrefix(companyId, iccid);
    added.push({ iccid, companyId });
  }
  return { added, duplicates, invalid };
}));

route('PUT', '/api/sims/assign', ADMIN, ({ body }) => {
  const ids = [].concat(body.ids || []).map(Number).filter(Boolean).slice(0, 1000);
  if (!ids.length) fail(400, 'اختر شريحة واحدة على الأقل');
  const agentId = body.agentId ? D.getAgent(body.agentId).id : null;
  const r = q(`UPDATE sims SET agent_id = ? WHERE status = 'available' AND id IN (${ids.map(() => '?').join(',')})`).run(agentId, ...ids);
  return { moved: Number(r.changes) };
});

route('DELETE', '/api/sims/:id', ANY, ({ user, params }) => {
  const s = q('SELECT * FROM sims WHERE id = ?').get(Number(params.id));
  if (!s || (user.role === 'agent' && s.agent_id !== user.id)) fail(404, 'الشريحة غير موجودة');
  if (s.status !== 'available') fail(400, 'لا يمكن حذف شريحة مستعملة');
  q('DELETE FROM sims WHERE id = ?').run(s.id);
  return { ok: true };
});
