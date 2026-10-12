// Camera barcode scanning for SIM cards (ICCID barcodes and QR codes). Uses the browser's BarcodeDetector where it
// exists (Chrome on Android) and otherwise the bundled ZXing decoder (Safari on iPhone, desktop browsers).
import { esc, icon, fmtIccid, toast } from './core.js';

export const scanSupported = () => !!navigator.mediaDevices?.getUserMedia;

let zxing = null;
function loadZxing() {
  zxing ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/js/vendor/zxing.min.js';
    s.onload = () => resolve(window.ZXing);
    s.onerror = () => { zxing = null; s.remove(); reject(new Error('zxing')); };
    document.head.appendChild(s);
  });
  return zxing;
}

// Same detect(video) contract as BarcodeDetector, decoding one downscaled video frame with ZXing.
async function zxingDetector() {
  const Z = await loadZxing();
  const F = Z.BarcodeFormat;
  const hints = new Map([
    [Z.DecodeHintType.POSSIBLE_FORMATS, [F.CODE_128, F.CODE_39, F.EAN_13, F.ITF, F.QR_CODE, F.DATA_MATRIX, F.PDF_417, F.CODABAR]],
    [Z.DecodeHintType.TRY_HARDER, true],
  ]);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    async detect(video) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return [];
      const scale = Math.min(1, 1280 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
        return [{ rawValue: reader.decodeWithState(bitmap).getText() }];
      } catch {
        return []; // nothing readable in this frame
      }
    },
  };
}

async function nativeDetector() {
  const wanted = ['code_128', 'code_39', 'ean_13', 'itf', 'qr_code', 'data_matrix', 'pdf417', 'codabar'];
  let formats = wanted;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    formats = wanted.filter((f) => supported.includes(f));
  } catch { /* use the defaults */ }
  return new window.BarcodeDetector({ formats });
}

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
    toast('المسح بالكاميرا غير مدعوم في هذا المتصفح. اكتب رقم الشريحة.', { error: true });
    return [];
  }
  let detector;
  try {
    detector = 'BarcodeDetector' in window ? await nativeDetector() : await zxingDetector();
  } catch {
    toast('تعذّر تشغيل الماسح. تأكد من الاتصال بالإنترنت أو اكتب رقم الشريحة.', { error: true });
    return [];
  }

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
