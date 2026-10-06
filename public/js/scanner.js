// Leitura de QR pela câmera: usa BarcodeDetector nativo quando disponível e
// jsQR como alternativa. Exige HTTPS (ou localhost) e permissão de câmera.
import { sheet, icon } from './ui.js';

let jsQRPromise;
const loadJsQR = () => (jsQRPromise ||= new Promise((res, rej) => {
  if (window.jsQR) return res(window.jsQR);
  const s = document.createElement('script');
  s.src = '/vendor/jsQR.js';
  s.onload = () => res(window.jsQR);
  s.onerror = rej;
  document.head.appendChild(s);
}));

export function extractCode(text) {
  const t = String(text || '').trim();
  const m = /[?&]qr=([^&#]+)/.exec(t);
  return decodeURIComponent(m ? m[1] : t).toUpperCase();
}

export const cameraSupported = () => !!(navigator.mediaDevices?.getUserMedia) && (window.isSecureContext || location.hostname === 'localhost');

export function scanQR() {
  return new Promise((resolve) => {
    let stream, raf, done = false;
    const finish = (val, api) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      api?.close();
      resolve(val);
    };
    sheet(`
      <h2>Escanear QR da máquina ou setor</h2>
      <p class="muted small">Aponte a câmera para a etiqueta</p>
      <div class="scanner" style="margin-top:12px"><video playsinline muted></video><div class="frame"></div><div class="laser"></div></div>
      <div class="error-box hidden" id="scan-err" style="margin-top:12px"></div>
      <div class="sheet-actions"><button class="btn" data-close>${icon('keyboard', 18)} Digitar código</button></div>
    `, {
      async onMount(el, api) {
        api.onClose = () => finish(null);
        const video = el.querySelector('video');
        const err = (m) => { const b = el.querySelector('#scan-err'); b.textContent = m; b.classList.remove('hidden'); };
        if (!cameraSupported()) return err('Câmera indisponível neste navegador/conexão (requer HTTPS). Digite o código impresso na etiqueta.');
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        } catch {
          return err('Permissão de câmera negada ou câmera indisponível. Digite o código.');
        }
        video.srcObject = stream;
        await video.play().catch(() => {});
        let detector = null;
        if ('BarcodeDetector' in window) {
          try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch {}
        }
        let jsQR = null;
        if (!detector) {
          try { jsQR = await loadJsQR(); } catch { return err('Leitor de QR não carregou. Digite o código.'); }
        }
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        let last = 0;
        const tick = async (t) => {
          if (done) return;
          if (t - last > 180 && video.readyState >= 2) {
            last = t;
            try {
              if (detector) {
                const codes = await detector.detect(video);
                if (codes[0]) return finish(extractCode(codes[0].rawValue), api);
              } else {
                const w = 480, h = Math.round((video.videoHeight / video.videoWidth) * 480) || 480;
                canvas.width = w; canvas.height = h;
                ctx.drawImage(video, 0, 0, w, h);
                const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
                if (r?.data) return finish(extractCode(r.data), api);
              }
            } catch {}
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
    });
  });
}
