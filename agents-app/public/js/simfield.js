// SIM (ICCID) input shared by the wizard, SIM swap and stock entry: typing, camera scan, or a tap on a stocked SIM.
// It recognises the company from the ICCID prefix and warns before the server would refuse a mismatch.
import { esc, icon, digits, detectCompany, companyById } from './core.js';
import { scanSupported, scanIccids } from './scan.js';

export function simFieldHtml({ id = 'sim', label = 'رقم الشريحة (ICCID)', value = '', stock = [] } = {}) {
  return `<div class="field">
    <label for="${id}">${label}</label>
    <div class="input-group">
      <input class="input ltr big" id="${id}" name="${id}" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="8997 20…" value="${esc(value)}">
      ${scanSupported() ? `<button type="button" class="icon-btn" data-scan="${id}" aria-label="مسح باركود الشريحة">${icon('scan')}</button>` : ''}
    </div>
    <div class="hint" id="${id}-hint"></div>
    ${stock.length ? `<span class="small muted">من مخزونك (${stock.length}) — اضغط لاختيار شريحة</span>
      <div class="sim-stock" id="${id}-stock">${stock.slice(0, 40).map((s) => `<button type="button" data-pick-sim="${s.id}" data-iccid="${esc(s.iccid)}">
        <span>${esc(s.companyName || 'شريحة')}</span><b>…${esc(s.iccid.slice(-7))}</b></button>`).join('')}</div>` : ''}
  </div>`;
}

/**
 * companyId: the company the SIM must belong to (null = any). onChange({ iccid, simId, valid, detected }).
 */
export function bindSimField(root, { id = 'sim', companyId = null, stock = [], onChange = () => {} } = {}) {
  const input = root.querySelector(`#${id}`);
  const hint = root.querySelector(`#${id}-hint`);
  if (!input) return;
  const update = () => {
    const d = digits(input.value);
    const inStock = stock.find((s) => s.iccid === d) || null;
    const detected = detectCompany(d);
    const target = companyId ? companyById(companyId) : null;
    let state = { iccid: d, simId: inStock?.id ?? null, valid: false, detected };
    let cls = '';
    let text = 'اكتب الرقم المطبوع على الشريحة أو امسح الباركود بالكاميرا';
    if (d.length && d.length < 18) {
      cls = 'warn';
      text = `${d.length} رقماً — رقم الشريحة من 18 إلى 22 رقماً`;
    } else if (d.length > 22) {
      cls = 'bad';
      text = 'الرقم أطول من رقم شريحة صالح';
    } else if (d.length) {
      if (detected && target && detected.id !== target.id) {
        cls = 'bad';
        text = `هذه الشريحة تابعة لـ${detected.name} وليست ${target.name}`;
      } else {
        cls = 'ok';
        state.valid = true;
        text = detected ? `شريحة ${detected.name}` : 'رقم شريحة صالح';
        if (inStock) text += ' · من مخزونك';
      }
    }
    hint.className = `hint ${cls}`;
    hint.innerHTML = `${icon(cls === 'ok' ? 'checkCircle' : cls ? 'alert' : 'info')}<span>${esc(text)}</span>`;
    root.querySelectorAll(`#${id}-stock [data-pick-sim]`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.iccid === d)));
    onChange(state);
  };
  input.addEventListener('input', update);
  root.querySelector(`[data-scan="${id}"]`)?.addEventListener('click', async () => {
    const [code] = await scanIccids();
    if (code) { input.value = code; update(); }
  });
  root.querySelectorAll(`#${id}-stock [data-pick-sim]`).forEach((b) => b.addEventListener('click', () => {
    input.value = b.dataset.iccid;
    update();
  }));
  update();
}
