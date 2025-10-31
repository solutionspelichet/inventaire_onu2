/* ====== App Frontend — scanner hybride + HEIC + upload + export ====== */
/* Config backend (Apps Script WebApp) */
const API_BASE = "https://script.google.com/macros/s/AKfycbyy826nPPtVW-HpyUSqzhJ-Eoq42_-rXhYHW3WXi3rT9cZ61dW264c7DDnfagnrXjM7/exec";
const APP_VERSION = "2.3.1";

/* ---------- Utils DOM ---------- */
function qs(sel, el) { return (el || document).querySelector(sel); }
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some(s => s.src && s.src.split('?')[0] === src.split('?')[0])) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = () => resolve(); s.onerror = () => reject(new Error('Erreur chargement: ' + src));
    document.head.appendChild(s);
  });
}
const todayISO = new Date().toISOString().slice(0, 10);

/* ---------- Thème ---------- */
(function initTheme() {
  const t = localStorage.getItem('theme') || 'light';
  applyTheme(t);
})();
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark') root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
  const sun = qs('#icon-sun'), moon = qs('#icon-moon'), btn = qs('#btn-theme');
  const isDark = theme === 'dark';
  if (sun) sun.hidden = isDark;
  if (moon) moon.hidden = !isDark;
  if (btn) btn.setAttribute('aria-pressed', String(isDark));
}
qs('#btn-theme') && qs('#btn-theme').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const nxt = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', nxt);
  applyTheme(nxt);
});

/* ---------- Loader + Flash ---------- */
let loaderCount = 0;
function showLoader(msg) {
  const M = qs('#globalLoader');
  if (!M) return;
  qs('#loaderMsg').textContent = msg || 'Chargement…';
  M.style.display = 'flex';
  loaderCount++;
}
function hideLoader() {
  const M = qs('#globalLoader');
  if (!M) return;
  loaderCount = Math.max(0, loaderCount - 1);
  if (!loaderCount) M.style.display = 'none';
}
function flash() {
  const f = qs('#flash'); if (!f) return;
  f.classList.remove('active'); void f.offsetWidth;
  f.classList.add('active');
  setTimeout(() => f.classList.remove('active'), 150);
}
function vibrate() { if (navigator.vibrate) navigator.vibrate(120); }

/* ---------- Initialisation ---------- */
document.addEventListener('DOMContentLoaded', () => {
  const dateEl = qs('#date_mvt');
  if (dateEl) dateEl.value = todayISO;
  const fromEl = qs('#export_from'), toEl = qs('#export_to');
  if (fromEl) fromEl.value = todayISO;
  if (toEl) toEl.value = todayISO;

  const typeSel = qs('#type'), typeOther = qs('#field-type-autre');
  if (typeSel) typeSel.addEventListener('change', () => {
    if (typeOther) typeOther.hidden = (typeSel.value !== 'Autre');
  });

  const captureBtn = qs('#btn-capture'), photoInput = qs('#photoInput');
  if (captureBtn && photoInput) captureBtn.addEventListener('click', () => photoInput.click());
  if (photoInput) photoInput.addEventListener('change', onPhotoPicked);

  const scanLive = qs('#btn-scan-live');
  if (scanLive) scanLive.addEventListener('click', startScanner);
  const stopBtn = qs('#scannerStop'), closeBtn = qs('#scannerClose');
  if (stopBtn) stopBtn.addEventListener('click', stopScanner);
  if (closeBtn) closeBtn.addEventListener('click', closeScanner);

  const form = qs('#form');
  if (form) form.addEventListener('submit', onSubmit);

  const testBtn = qs('#btn-test');
  if (testBtn) testBtn.addEventListener('click', onTest);

  const xlsBtn = qs('#btn-download-xls');
  if (xlsBtn) xlsBtn.addEventListener('click', onDownloadXls);

  refreshTodayCount();
});

/* ---------- KPI ---------- */
async function refreshTodayCount() {
  try {
    const r = await fetch(`${API_BASE}?route=/stats&day=${todayISO}`);
    const j = await r.json().catch(() => ({}));
    const n = (j && j.status === 200 && j.data && typeof j.data.count === 'number') ? j.data.count : 0;
    qs('#count-today').textContent = String(n);
  } catch {
    qs('#count-today').textContent = '0';
  }
}

/* ---------- Export XLSX ---------- */
async function onDownloadXls(e) {
  e.preventDefault();
  const from = qs('#export_from') ? qs('#export_from').value : '';
  const to = qs('#export_to') ? qs('#export_to').value : '';
  if (!from || !to) return alert('Sélectionnez une période complète.');
  if (from > to) return alert('La date de début doit précéder la date de fin.');

  try {
    showLoader('Préparation export…');
    const url = `${API_BASE}?route=/export&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const r = await fetch(url);
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const wb = XLSX.read(text, { type: 'string', raw: true });
    XLSX.writeFile(wb, `export_${from}_au_${to}.xlsx`);
  } catch (err) {
    alert('Erreur export : ' + err.message);
  } finally { hideLoader(); }
}

/* ---------- Scanner hybride ---------- */
let _stream = null, _nativeDetector = null, _zxingReader = null, _loop = null;
async function ensureZXing() {
  if (window.ZXingBrowser) return;
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js');
}
async function ensureQuagga() {
  if (window.Quagga) return;
  await loadScriptOnce(location.origin + location.pathname.replace(/\/[^/]*$/, '/') + 'libs/quagga.min.js');
}
function hasBarcodeDetector() { return 'BarcodeDetector' in window; }
async function createBarcodeDetector() {
  const fmts = ['qr_code', 'ean_13', 'code_128', 'code_39', 'upc_a', 'ean_8'];
  return new window.BarcodeDetector({ formats: fmts });
}
async function ensureCamera(video) {
  const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  _stream = s; video.srcObject = s; await video.play();
}
function releaseCamera() { if (_stream) _stream.getTracks().forEach(t => t.stop()); _stream = null; }

async function startScanner() {
  const video = qs('#scannerVideo');
  if (!video) return;
  qs('#scannerModal').style.display = 'grid';
  try { await ensureCamera(video); } catch { alert('Caméra refusée'); return; }

  try {
    _nativeDetector = await createBarcodeDetector();
    const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
    const loop = async () => {
      if (!_nativeDetector) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        c.width = video.videoWidth; c.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, c.width, c.height);
        const bmp = await createImageBitmap(c);
        const r = await _nativeDetector.detect(bmp);
        if (r && r[0] && r[0].rawValue) { onCodeDetected(r[0].rawValue); closeScanner(); return; }
      }
      _loop = requestAnimationFrame(loop);
    };
    _loop = requestAnimationFrame(loop);
    return;
  } catch { }

  try {
    await ensureQuagga();
    if (window.Quagga) {
      Quagga.init({
        inputStream: { type: 'LiveStream', target: video },
        decoder: { readers: ['ean_reader', 'code_128_reader', 'code_39_reader'] }
      }, err => { if (err) console.error(err); else Quagga.start(); });
      Quagga.onDetected(res => {
        const code = res.codeResult && res.codeResult.code ? res.codeResult.code : '';
        if (code) { onCodeDetected(code); closeScanner(); }
      });
      return;
    }
  } catch { }

  try {
    await ensureZXing();
    _zxingReader = new ZXingBrowser.BrowserMultiFormatReader();
    const devices = await ZXingBrowser.BrowserCodeReader.listVideoInputDevices();
    const back = devices[0] ? devices[0].deviceId : null;
    await _zxingReader.decodeFromVideoDevice(back, video, (res, err, controls) => {
      if (res && res.getText) { onCodeDetected(res.getText()); controls.stop(); closeScanner(); }
    });
  } catch { alert("Aucun mode de scan disponible."); }
}

function stopScanner() {
  if (_loop) cancelAnimationFrame(_loop);
  _loop = null; _nativeDetector = null;
  if (_zxingReader) _zxingReader.reset();
  releaseCamera();
}
function closeScanner() {
  stopScanner();
  qs('#scannerModal').style.display = 'none';
}
function onCodeDetected(code) {
  flash(); vibrate();
  const el = qs('#code'); if (el) el.value = code;
  const status = qs('#status'); if (status) status.textContent = 'Code détecté : ' + code;
}

/* ---------- Décodage via photo ---------- */
async function ensureHeic2Any() {
  if (window.heic2any) return;
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js');
}
async function onPhotoPicked(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  let blob = file;
  if (/heic|heif/i.test(file.type) || /\.heic$/i.test(file.name)) {
    try { await ensureHeic2Any(); blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 }); } catch {}
  }
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const c = qs('#canvas'); const ctx = c.getContext('2d', { willReadFrequently: true });
  c.width = bmp.width; c.height = bmp.height; ctx.drawImage(bmp, 0, 0);
  const det = await tryBarcodeDetectorOn(c) || await tryZXingOn(c);
  if (det) onCodeDetected(det); else alert('Aucun code détecté.');
  const url = c.toDataURL(); const img = qs('#preview');
  img.src = url; img.style.display = 'block';
  ev.target.value = '';
}
async function tryBarcodeDetectorOn(canvas) {
  if (!hasBarcodeDetector()) return null;
  try {
    const det = await createBarcodeDetector();
    const bmp = await createImageBitmap(canvas);
    const r = await det.detect(bmp);
    return (r && r[0] && r[0].rawValue) ? r[0].rawValue : null;
  } catch { return null; }
}
async function tryZXingOn(canvas) {
  try {
    await ensureZXing();
    const lum = new ZXing.LuminanceSource(canvas);
    return null;
  } catch { return null; }
}

/* ---------- Envoi backend ---------- */
async function onSubmit(e) {
  e.preventDefault();
  const code = qs('#code') ? qs('#code').value.trim() : '';
  const from = qs('#from') ? qs('#from').value.trim() : '';
  const to = qs('#to') ? qs('#to').value.trim() : '';
  const type = qs('#type') ? qs('#type').value.trim() : '';
  const type_autre = qs('#type_autre') ? qs('#type_autre').value.trim() : '';
  const date = qs('#date_mvt') ? qs('#date_mvt').value : todayISO;
  if (!code || !from || !to || !type) return alert('Veuillez remplir tous les champs.');

  const form = new URLSearchParams();
  form.set('action', 'create');
  form.set('code_scanné', code);
  form.set('emplacement_depart', from);
  form.set('emplacement_destination', to);
  form.set('type_mobilier', type);
  form.set('type_mobilier_autre', (type === 'Autre' ? type_autre : ''));
  form.set('date_mouvement', date);
  form.set('source_app_version', APP_VERSION);

  showLoader('Enregistrement…');
  try {
    const r = await fetch(`${API_BASE}?route=/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString()
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.status >= 200 && j.status < 300) {
      alert('Écrit dans Google Sheets ✅');
      const el = qs('#count-today');
      if (el && date === todayISO) {
        const current = parseInt(el.textContent, 10) || 0;
        el.textContent = String(current + 1);
      } else {
        refreshTodayCount();
      }
      resetFormUI();
    } else {
      alert('Erreur API : ' + ((j && j.message) ? j.message : 'inconnue'));
    }
  } catch (err) {
    alert('Erreur réseau/API');
  } finally {
    hideLoader();
  }
}

function resetFormUI() {
  const codeEl = qs('#code'); if (codeEl) codeEl.value = '';
  const type = qs('#type'); if (type && type.options && type.options.length) type.value = type.options[0].value;
  const wrap = qs('#field-type-autre'); if (wrap) wrap.hidden = true;
  const other = qs('#type_autre'); if (other) other.value = '';
  const dateEl = qs('#date_mvt'); if (dateEl) dateEl.value = todayISO;
}

/* ---------- Test ---------- */
function onTest() {
  const codeEl = qs('#code'); if (codeEl) codeEl.value = 'TEST123456';
  const fromEl = qs('#from'); if (fromEl) fromEl.value = 'Voie Creuse';
  const toEl = qs('#to'); if (toEl) toEl.value = 'Bibliothèque';
  const typeEl = qs('#type'); if (typeEl) typeEl.value = 'Bureau';
  const dateEl = qs('#date_mvt'); if (dateEl) dateEl.value = todayISO;
  alert('Champs remplis pour test.');
}
