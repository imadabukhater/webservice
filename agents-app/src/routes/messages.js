'use strict';
// Messages between the manager and each agent: one conversation per agent.
const { q } = require('../db');
const { fail, now, str } = require('../util');
const D = require('../domain');
const { route, ADMIN, ANY } = require('../router');

const msgView = (m) => ({ id: m.id, fromAdmin: !!m.from_admin, senderName: m.sender_name, body: m.body, ts: m.ts, read: !!m.read_at });

// Messages the user has not read yet: from the manager for an agent, from any agent for the manager.
function unreadCount(user) {
  return user.role === 'agent'
    ? q('SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND from_admin = 1 AND read_at IS NULL').get(user.id).n
    : q('SELECT COUNT(*) AS n FROM messages WHERE from_admin = 0 AND read_at IS NULL').get().n;
}

// Manager: every agent with the last message and the unread count; agents without messages come last.
route('GET', '/api/messages/threads', ADMIN, () => q(`
  SELECT u.id, u.name, u.username, u.active, m.body AS last_body, m.from_admin AS last_from_admin, m.ts AS last_ts,
    (SELECT COUNT(*) FROM messages x WHERE x.agent_id = u.id AND x.from_admin = 0 AND x.read_at IS NULL) AS unread
  FROM users u
  LEFT JOIN messages m ON m.id = (SELECT MAX(id) FROM messages WHERE agent_id = u.id)
  WHERE u.role = 'agent'
  ORDER BY m.id IS NULL, m.id DESC, u.name`).all().map((r) => ({
  agentId: r.id, name: r.name, username: r.username, active: !!r.active,
  last: r.last_ts ? { body: r.last_body, fromAdmin: !!r.last_from_admin, ts: r.last_ts } : null, unread: r.unread,
})));

// One conversation (the agent's own, or ?agentId= for the manager). ?after=<id> returns only newer messages.
// Reading marks the other side's messages as read.
route('GET', '/api/messages', ANY, ({ user, query }) => {
  const agentId = user.role === 'agent' ? user.id : D.getAgent(query.agentId).id;
  const after = Number(query.after) || 0;
  const rows = after
    ? q('SELECT * FROM messages WHERE agent_id = ? AND id > ? ORDER BY id').all(agentId, after)
    : q('SELECT * FROM (SELECT * FROM messages WHERE agent_id = ? ORDER BY id DESC LIMIT 300) ORDER BY id').all(agentId);
  q('UPDATE messages SET read_at = ? WHERE agent_id = ? AND from_admin = ? AND read_at IS NULL')
    .run(now(), agentId, user.role === 'agent' ? 1 : 0);
  return rows.map(msgView);
});

route('POST', '/api/messages', ANY, ({ user, body }) => {
  const admin = user.role === 'admin';
  const agentId = admin ? D.getAgent(body.agentId).id : user.id;
  const text = str(body.body, 2000);
  if (!text) fail(400, 'اكتب الرسالة');
  const id = Number(q('INSERT INTO messages (agent_id, from_admin, sender_name, body, ts) VALUES (?, ?, ?, ?, ?)')
    .run(agentId, admin ? 1 : 0, user.name, text, now()).lastInsertRowid);
  return msgView(q('SELECT * FROM messages WHERE id = ?').get(id));
});

module.exports = { unreadCount };
