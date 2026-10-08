// Camera barcode scanning for SIM cards (ICCID barcodes and QR codes) using the browser's BarcodeDetector.
import { esc, icon, fmtIccid, toast } from './core.js';

export const scanSupported = () => 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;

// ICCIDs are 18–22 digits; anything else on the card (PUK, phone number) is ignored.
const iccidFrom = (raw) => {
  const m = String(raw).replace(/\s/g, '').match(/\d{18,22}/);
  return m ? m[0] : null;
};

/**
 * multiple: keep scanning and collect several SIMs (stock entry); otherwise resolve with the first ICCID.
 * Resolves with an array of ICCIDs (possibly empty when the user closes the scanner).
 */
export async function scanIccids({ multiple = false, title = 'امسح باركود الشريحة' } = {}) {
  if (!scanSupported()) {
    toast('المسح بالكاميرا غير مدعوم في هذا المتصفح. استعمل Chrome على أندرويد أو اكتب الرقم.', { error: true });
    return [];
  }
  const wanted = ['code_128', 'code_39', 'ean_13', 'itf', 'qr_code', 'data_matrix', 'pdf417', 'codabar'];
  let formats = wanted;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    formats = wanted.filter((f) => supported.includes(f));
  } catch { /* use the defaults */ }
  const detector = new window.BarcodeDetector({ formats });

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } }, audio: false });
  } catch {
    toast('لم يُسمح باستعمال الكاميرا. فعّلها من إعدادات المتصفح.', { error: true });
    return [];
  }

  return new Promise((resolve) => {
    const found = [];
    const ui = document.createElement('div');
    ui.className = 'scanner';
    ui.innerHTML = `<video playsinline muted></video>
      <div class="bar"><button class="icon-btn" data-x aria-label="إغلاق">${icon('x')}</button><b class="grow">${esc(title)}</b>
        <button class="icon-btn" data-torch aria-label="الإضاءة" hidden>${icon('bolt')}</button></div>
      <div class="frame"></div>
      <div class="foot"><div class="codes"></div><span class="small">${multiple ? 'وجّه الكاميرا إلى كل شريحة بالتتابع، ثم اضغط «تم».' : 'وجّه الكاميرا إلى باركود الشريحة.'}</span>
        ${multiple ? '<button class="btn btn-primary btn-lg" data-done>تم</button>' : ''}</div>`;
    document.body.appendChild(ui);
    const video = ui.querySelector('video');
    video.srcObject = stream;
    video.play().catch(() => {});
    let stopped = false;
    const track = stream.getVideoTracks()[0];
    try {
      if (track.getCapabilities?.().torch) {
        const btn = ui.querySelector('[data-torch]');
        let on = false;
        btn.hidden = false;
        btn.onclick = () => { on = !on; track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {}); };
      }
    } catch { /* no torch */ }

    const finish = () => {
      if (stopped) return;
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      ui.remove();
      resolve(found);
    };
    ui.querySelector('[data-x]').onclick = finish;
    const doneBtn = ui.querySelector('[data-done]');
    if (doneBtn) doneBtn.onclick = finish;

    const codesBox = ui.querySelector('.codes');
    const tick = async () => {
      if (stopped) return;
      if (video.readyState >= 2) {
        try {
          for (const code of await detector.detect(video)) {
            const iccid = iccidFrom(code.rawValue);
            if (!iccid || found.includes(iccid)) continue;
            found.push(iccid);
            try { navigator.vibrate?.(60); } catch { /* not supported */ }
            if (!multiple) return finish();
            const tag = document.createElement('span');
            tag.textContent = fmtIccid(iccid);
            codesBox.prepend(tag);
            doneBtn.textContent = `تم (${found.length})`;
          }
        } catch { /* frame not ready */ }
      }
      setTimeout(() => requestAnimationFrame(tick), 120);
    };
    tick();
  });
}
