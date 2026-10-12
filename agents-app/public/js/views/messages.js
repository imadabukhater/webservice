// Messages between the manager and the agents. An agent has one conversation with the manager;
// the manager picks an agent from the list (#/messages) and opens that conversation (#/messages/<agentId>).
import { S, api, esc, icon, isAdmin, relTime, fmtDate, fmtTime, initials, empty, changed, toast } from '../core.js';

const POLL_MS = 8000;
const D = { threads: [], agent: null, items: [], filter: '' };
let poll = null;

const agentId = (ctx) => (isAdmin() ? Number(ctx.params[0]) || null : S.user.id);
const lastId = () => D.items.at(-1)?.id || 0;
const mine = (m) => m.fromAdmin === isAdmin();

function bubbles(items) {
  let day = '';
  return items.map((m) => {
    const d = fmtDate(m.ts);
    const sep = d !== day ? `<div class="chat-day"><span>${d === fmtDate(Date.now()) ? 'اليوم' : d}</span></div>` : '';
    day = d;
    return `${sep}<div class="bubble ${mine(m) ? 'mine' : ''}"><p>${esc(m.body)}</p>
      <span class="meta">${fmtTime(m.ts)}${mine(m) ? `<span class="ticks ${m.read ? 'read' : ''}" aria-label="${m.read ? 'مقروءة' : 'أُرسلت'}">${icon('check')}${m.read ? icon('check') : ''}</span>` : ''}</span></div>`;
  }).join('');
}

function threadList() {
  const term = D.filter.trim().toLowerCase();
  const rows = D.threads.filter((t) => !term || t.name.toLowerCase().includes(term) || t.username.toLowerCase().includes(term));
  return `<div class="search-box">${icon('search', 'i lead')}<input class="input" id="msg-filter" type="search" placeholder="ابحث عن وكيل…" value="${esc(D.filter)}" aria-label="ابحث عن وكيل"></div>
    ${D.threads.length ? `<div class="list" id="thread-list">${rows.map((t) => `<a class="item clickable thread ${t.unread ? 'unread' : ''}" href="#/messages/${t.agentId}">
      <div class="item-top"><span class="avatar">${esc(initials(t.name))}</span>
        <div class="grow"><div class="thread-head"><b class="item-title">${esc(t.name)}</b>${t.last ? `<time>${relTime(t.last.ts)}</time>` : ''}</div>
          <div class="thread-last">${t.last ? `${t.last.fromAdmin ? '<span class="muted">أنت: </span>' : ''}${esc(t.last.body)}` : '<span class="muted">لا رسائل بعد — اضغط لبدء محادثة</span>'}</div></div>
        ${t.unread ? `<span class="badge">${t.unread}</span>` : ''}</div></a>`).join('') || '<p class="muted">لا نتائج</p>'}</div>`
      : empty('users', 'لا يوجد وكلاء بعد', 'أضف وكيلاً من صفحة «الوكلاء» لتراسله.')}`;
}

function chat() {
  const who = isAdmin() ? D.agent.name : 'المدير';
  return `<section class="card chat">
    <header class="chat-head">${isAdmin() ? `<a class="icon-btn plain" href="#/messages" aria-label="كل المحادثات">${icon('arrowR')}</a>` : ''}
      <span class="avatar">${esc(initials(who))}</span><div class="grow"><b>${esc(who)}</b><small>${isAdmin() ? `<span class="ltr">@${esc(D.agent.username)}</span>` : 'اسأل، اطلب شرائح أو أبلغ عن مشكلة'}</small></div></header>
    <div class="chat-log" id="chat-log" aria-live="polite">${D.items.length ? bubbles(D.items)
      : `<div class="chat-empty">${icon('msg')}<span>${isAdmin() ? `ابدأ المحادثة مع ${esc(D.agent.name)}.` : 'اكتب رسالتك للمدير وسيردّ عليك هنا.'}</span></div>`}</div>
    <form class="chat-form" id="chat-form" autocomplete="off">
      <textarea class="input" id="chat-input" name="body" rows="1" maxlength="2000" placeholder="اكتب رسالة…" aria-label="الرسالة"></textarea>
      <button class="btn btn-primary chat-send" type="submit" aria-label="إرسال">${icon('send')}</button>
    </form>
  </section>`;
}

function scrollToEnd() {
  const log = document.getElementById('chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

function appendNew(items) {
  const fresh = items.filter((m) => m.id > lastId());
  if (!fresh.length) return;
  const log = document.getElementById('chat-log');
  const atEnd = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  D.items.push(...fresh);
  if (log) log.innerHTML = bubbles(D.items);
  if (atEnd || fresh.some(mine)) scrollToEnd();
}

function startPolling(ctx) {
  clearInterval(poll);
  poll = setInterval(async () => {
    const log = document.getElementById('chat-log');
    if (!log) { clearInterval(poll); return; }
    if (document.visibilityState !== 'visible') return;
    try {
      const id = agentId(ctx);
      const items = await api.get(`/api/messages?${isAdmin() ? `agentId=${id}&` : ''}after=${lastId()}`);
      if (items.length) { appendNew(items); changed({ keepView: true }); }
    } catch { /* offline: try again on the next tick */ }
  }, POLL_MS);
}

export default {
  title: (ctx) => (isAdmin() && agentId(ctx) && D.agent
    ? { title: D.agent.name, subtitle: 'محادثة' }
    : { title: 'الرسائل', subtitle: isAdmin() ? 'محادثات الوكلاء' : 'محادثة مع المدير' }),
  async load(ctx) {
    clearInterval(poll);
    const id = agentId(ctx);
    if (isAdmin() && !id) {
      D.threads = await api.get('/api/messages/threads');
      D.agent = null;
      return;
    }
    const [items, threads] = await Promise.all([
      api.get(`/api/messages${isAdmin() ? `?agentId=${id}` : ''}`),
      isAdmin() ? api.get('/api/messages/threads') : null,
    ]);
    D.items = items;
    if (isAdmin()) {
      D.threads = threads;
      D.agent = threads.find((t) => t.agentId === id);
      if (!D.agent) throw new Error('الوكيل غير موجود');
    }
    changed({ keepView: true }); // opening the conversation marked it read: refresh the badges
  },
  render(ctx) {
    return isAdmin() && !agentId(ctx) ? threadList() : chat();
  },
  mount(root, ctx) {
    const filter = root.querySelector('#msg-filter');
    if (filter) {
      filter.addEventListener('input', () => {
        D.filter = filter.value;
        const pos = filter.selectionStart;
        ctx.rerender();
        const f = document.getElementById('msg-filter');
        f.focus();
        f.setSelectionRange(pos, pos);
      });
      return;
    }
    const form = root.querySelector('#chat-form');
    const input = root.querySelector('#chat-input');
    const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; };
    input.addEventListener('input', grow);
    // Enter sends on a keyboard; Shift+Enter adds a new line. Phones keep Enter for new lines.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const m = await api.post('/api/messages', isAdmin() ? { agentId: agentId(ctx), body } : { body });
        input.value = '';
        grow();
        appendNew([m]);
      } catch (err) {
        toast(err.message, { error: true });
      } finally {
        btn.disabled = false;
        input.focus();
      }
    });
    scrollToEnd();
    startPolling(ctx);
  },
};
