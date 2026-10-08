// Activity line chart: one series at a time (the title names it), monotone curve so counts never dip below zero,
// hairline grid, end dot with a surface ring, crosshair + tooltip on hover/tap/keyboard.
import { esc, fmtDayMonth, weekday } from './core.js';

const NS = 'http://www.w3.org/2000/svg';

function niceMax(v) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 4, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

// Fritsch–Carlson monotone cubic interpolation.
function monotonePath(pts) {
  const n = pts.length;
  if (n < 2) return n ? `M${pts[0].x},${pts[0].y}` : '';
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    m[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }
  const t = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(pts[i].x + h).toFixed(1)},${(pts[i].y + t[i] * h).toFixed(1)} ${(pts[i + 1].x - h).toFixed(1)},${(pts[i + 1].y - t[i + 1] * h).toFixed(1)} ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}

const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/**
 * days: [{ ts, total, activate, renew, swap_sim, other }]; key: series shown; labels: { key: 'Arabic name' } for the tooltip.
 */
export function drawActivity(container, days, key, labels) {
  container.innerHTML = '';
  const width = Math.max(280, container.clientWidth || 600);
  const height = width < 520 ? 210 : 250;
  const pad = { t: 14, r: 14, b: 30, l: 34 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const values = days.map((d) => d[key] || 0);
  const max = niceMax(Math.max(...values, 1));
  const x = (i) => pad.l + (days.length === 1 ? iw / 2 : (i * iw) / (days.length - 1));
  const y = (v) => pad.t + ih - (v / max) * ih;

  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': `${labels[key]}: آخر ${days.length} يوماً`, direction: 'ltr' });
  svg.style.direction = 'ltr';
  const grid = el('g', { class: 'grid' });
  const axis = el('g', { class: 'axis' });
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    const yy = y(v);
    grid.appendChild(el('line', { x1: pad.l, x2: width - pad.r, y1: yy, y2: yy }));
    const t = el('text', { x: pad.l - 8, y: yy + 4, 'text-anchor': 'end' });
    t.textContent = Number.isInteger(v) ? v : v.toFixed(1);
    axis.appendChild(t);
  }
  const step = Math.max(1, Math.ceil(days.length / (width < 520 ? 5 : 8)));
  days.forEach((d, i) => {
    if ((days.length - 1 - i) % step !== 0) return;
    const t = el('text', { x: x(i), y: height - 8, 'text-anchor': i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle' });
    t.textContent = fmtDayMonth(d.ts);
    axis.appendChild(t);
  });
  svg.append(grid, axis);

  const pts = values.map((v, i) => ({ x: x(i), y: y(v) }));
  const line = monotonePath(pts);
  const base = y(0);
  svg.appendChild(el('path', { d: `${line} L${pts.at(-1).x},${base} L${pts[0].x},${base} Z`, fill: 'currentColor', 'fill-opacity': '0.1', stroke: 'none' }));
  svg.appendChild(el('path', { d: line, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const last = pts.at(-1);
  svg.appendChild(el('circle', { cx: last.x, cy: last.y, r: 5, fill: 'currentColor', stroke: 'var(--surface)', 'stroke-width': 2 }));

  const cross = el('line', { class: 'cross', y1: pad.t, y2: pad.t + ih, x1: 0, x2: 0, opacity: 0 });
  const focus = el('circle', { r: 5.5, fill: 'currentColor', stroke: 'var(--surface)', 'stroke-width': 2, cx: 0, cy: 0, opacity: 0 });
  const hit = el('rect', { x: pad.l - 10, y: 0, width: iw + 20, height, fill: 'transparent' });
  svg.append(cross, focus, hit);
  container.appendChild(svg);

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.appendChild(tip);

  let current = -1;
  const show = (i) => {
    current = Math.max(0, Math.min(days.length - 1, i));
    const d = days[current];
    cross.setAttribute('x1', x(current)); cross.setAttribute('x2', x(current)); cross.setAttribute('opacity', 1);
    focus.setAttribute('cx', x(current)); focus.setAttribute('cy', y(d[key] || 0)); focus.setAttribute('opacity', 1);
    tip.innerHTML = `<div class="tip-date">${esc(weekday(d.ts))} ${esc(fmtDayMonth(d.ts))}</div>` +
      Object.keys(labels).map((k) => `<div class="tip-row"><span class="key ${k === key ? '' : 'dim'}"></span><b>${d[k] || 0}</b><span>${esc(labels[k])}</span></div>`).join('');
    tip.hidden = false;
    const scale = container.clientWidth / width;
    const px = x(current) * scale;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(0, px + 14 + tw > container.clientWidth ? px - tw - 14 : px + 14), container.clientWidth - tw)}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute('opacity', 0); focus.setAttribute('opacity', 0); current = -1; };
  const indexAt = (clientX) => {
    const r = svg.getBoundingClientRect();
    const sx = ((clientX - r.left) / r.width) * width;
    return Math.round(((sx - pad.l) / iw) * (days.length - 1));
  };
  hit.addEventListener('pointermove', (e) => show(indexAt(e.clientX)));
  hit.addEventListener('pointerdown', (e) => show(indexAt(e.clientX)));
  hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  container.tabIndex = 0;
  container.onkeydown = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      show((current < 0 ? days.length - 1 : current) + (e.key === 'ArrowRight' ? 1 : -1));
    } else if (e.key === 'Escape') hide();
  };
  container.onblur = hide;
}
