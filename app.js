/* Inventaire ONU — app.js (v2.3.0 hybride scanner)
 * - PWA install
 * - Thème Pelichet (clair/sombre)
 * - SCAN hybride :
 *     1) BarcodeDetector natif (iOS/Android récents)
 *     2) Quagga2 (si self-host libs/quagga.min.js)
 *     3) ZXing (CDN)
 * - Décodage photo upload (HEIC iPhone OK)
 * - POST Apps Script + compteur jour
 * - Export XLSX (col. C texte + largeur auto)
 */

const API_BASE = "https://script.google.com/macros/s/AKfycbwtFL1iaSSdkB7WjExdXYGbQQbhPeIi_7F61pQdUEJK8kSFznjEOU68Fh6U538PGZW2/exec"; // ← à toi
const APP_VERSION = "2.3.0";
const AUTO_RECAPTURE = true;

let canvasEl, statusEl, flashEl, previewEl;
let fileBlob = null;
let todayISO = new Date().toISOString().slice(0,10);
let todayCount = 0;

/* ================== Install PWA ================== */
let deferredPrompt = null;

function isIos() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isSafari() {
  const ua = navigator.userAgent || '';
  return /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
}
function isInStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.getElementById('btn-install');
  if (btn && !isInStandalone()) btn.hidden = false;
});
window.addEventListener('appinstalled', () => {
  const btn = document.getElementById('btn-install');
  if (btn) btn.hidden = true;
});

/* ================== Thème ================== */
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark') root.setAttribute('data-theme','dark'); else root.removeAttribute('data-theme');
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.setAttribute('name','theme-color'); document.head.appendChild(meta); }
  meta.setAttribute('content', theme === 'dark' ? '#121417' : '#f6f8fa');
  const sun = document.getElementById('icon-sun');
  const moon = document.getElementById('icon-moon');
  const btn = document.getElementById('btn-theme');
  if (sun && moon && btn) {
    const isDark = theme === 'dark';
    sun.hidden = isDark;
    moon.hidden = !isDark;
    btn.setAttribute('aria-pressed', String(isDark));
  }
}
function initTheme() {
  const stored = localStorage.getItem('theme');
  applyTheme(stored || 'light');
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = current === 'light' ? 'dark' : 'light';
  localStorage.setItem('theme', next);
  applyTheme(next);
}

/* ================== Valeurs persistées ================== */
const PERSIST_KEY = 'inventaire_defaults_v1';
function loadPersistentDefaults() {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      if (data.from) document.getElementById('from').value = data.from;
      if (data.to) document.getElementById('to').value = data.to;
      if (data.type) {
        const sel = document.getElementById('type');
        sel.value = data.type;
        sel.dispatchEvent(new Event('change'));
      }
    }
  } catch(_) {}
}
function savePersistentDefaults() {
  try {
    const from = (document.getElementById('from')?.value || '').trim();
    const to   = (document.getElementById('to')?.value || '').trim();
    const type = document.getElementById('type')?.value || '';
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ from, to, type }));
  } catch(_) {}
}
function clearPersistentDefaults() {
  try { localStorage.removeItem(PERSIST_KEY); } catch(_) {}
  const from = document.getElementById('from'); if (from) from.value = '';
  const to   = document.getElementById('to');   if (to) to.value   = '';
  const type = document.getElementById('type'); if (type) { type.value=''; type.dispatchEvent(new Event('change')); }
  setStatus('Valeurs par défaut effacées.');
}

/* ================== Chargement libs ================== */
function loadScriptOnce(src){
  return new Promise((resolve,reject)=>{
    if ([...document.scripts].some(s => s.src && s.src.split('?')[0] === src.split('?')[0])) return resolve();
    const s=document.createElement('script');
    s.src=src; s.async=true; s.crossOrigin='anonymous';
    s.onload=()=>resolve(); s.onerror=()=>reject(new Error('Échec chargement: '+src));
    document.head.appendChild(s);
  });
}
// ZXing pour fallback
async function ensureZXing(){
  if (window.ZXing) return;
  await loadScriptOnce('https://unpkg.com/@zxing/library@0.20.0');
}
// jsQR (déjà importé par index.html chez toi)
function ensureJsQR(){ return Promise.resolve(); }
// HEIC → JPEG
async function ensureHeic2Any(){
  if(window.heic2any) return;
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js');
}
// Quagga2 (si tu le self-host)
async function ensureQuagga(){
  if (window.Quagga) return;
  const base = location.origin + location.pathname.replace(/\/[^/]*$/,'/');
  await loadScriptOnce(base + 'libs/quagga.min.js').catch(()=>{});
}
// BarcodeDetector natif
function hasBarcodeDetector(){ return 'BarcodeDetector' in window; }
async function createBarcodeDetector(){
  if (!hasBarcodeDetector()) throw new Error('BD non supporté');
  try{
    const sup = await window.BarcodeDetector.getSupportedFormats?.();
    const wanted = ['qr_code','ean_13','code_128','code_39','itf','upc_e','upc_a','ean_8'];
    const fmts = sup ? wanted.filter(f => sup.includes(f)) : wanted;
    return new window.BarcodeDetector({ formats: fmts });
  }catch(_){ return new window.BarcodeDetector(); }
}

/* ================== Scan helpers (canvas) ================== */
const ZX_HINTS = (function(){
  try {
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.QR_CODE,
      ZXing.BarcodeFormat.CODE_128,
      ZXing.BarcodeFormat.EAN_13,
      ZXing.BarcodeFormat.CODE_39,
      ZXing.BarcodeFormat.ITF,
      ZXing.BarcodeFormat.UPC_A,
      ZXing.BarcodeFormat.UPC_E,
    ]);
    return hints;
  } catch(_) { return null; }
})();
function preprocessCanvas(ctx, w, h) {
  const img = ctx.getImageData(0,0,w,h);
  const d = img.data;
  const gamma = 0.9, contrast = 1.15, mid = 128;
  for (let i=0; i<d.length; i+=4) {
    let r=d[i], g=d[i+1], b=d[i+2];
    r = 255*Math.pow(r/255, gamma);
    g = 255*Math.pow(g/255, gamma);
    b = 255*Math.pow(b/255, gamma);
    r = (r - mid)*contrast + mid;
    g = (g - mid)*contrast + mid;
    b = (b - mid)*contrast + mid;
    d[i]   = Math.max(0, Math.min(255, r));
    d[i+1] = Math.max(0, Math.min(255, g));
    d[i+2] = Math.max(0, Math.min(255, b));
  }
  ctx.putImageData(img, 0, 0);
}
async function tryBarcodeDetectorOn(canvas){
  if (!hasBarcodeDetector()) return null;
  try{
    const det = await createBarcodeDetector();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png', 0.92));
    const bmp = await createImageBitmap(blob);
    const res = await det.detect(bmp);
    if (res && res[0]?.rawValue) return res[0].rawValue;
  }catch(_){}
  return null;
}
function tryZXingOn(canvas){
  try{
    const luminance = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    const bin = new ZXing.HybridBinarizer(luminance);
    const bmp = new ZXing.BinaryBitmap(bin);
    const reader = new ZXing.MultiFormatReader();
    if (ZX_HINTS) reader.setHints(ZX_HINTS);
    const res = reader.decode(bmp);
    if (res && res.getText) return res.getText();
  }catch(_){}
  return null;
}
function tryJsQROn(ctx,w,h){
  try{
    const data = ctx.getImageData(0,0,w,h);
    const code = jsQR(data.data,w,h);
    if (code?.data) return code.data;
  }catch(_){}
  return null;
}

/* ================== UI helpers ================== */
function setStatus(msg){ if (statusEl) statusEl.textContent = msg; }
function setApiMsg(msg, isError=false) {
  const el = document.getElementById('api-msg');
  if (!el) return; el.textContent = msg; el.style.color = isError ? '#ef4444' : '#22c55e';
}
function vibrate(){ if (navigator.vibrate) navigator.vibrate(200); }
function flash(){ if (!flashEl) return; flashEl.classList.remove('active'); void flashEl.offsetWidth; flashEl.classList.add('active'); }
function beep(){
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type='sine'; o.frequency.setValueAtTime(1000, ctx.currentTime);
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    o.connect(g).connect(ctx.destination); o.start();
    g.gain.exponentialRampToValueAtTime(0.1, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
    o.stop(ctx.currentTime + 0.2);
  } catch(_) {}
}
function onCodeDetected(text){
  flash(); beep(); vibrate();
  setStatus(`Code détecté: ${text}`);
  const codeInput = document.getElementById('code');
  if (codeInput) { codeInput.value = text; codeInput.focus(); }
}

/* ================== Compteur jour (GET) ================== */
async function refreshTodayCount() {
  try {
    const res = await fetch(`${API_BASE}?route=/stats&day=${todayISO}`, { method:'GET', mode:'cors', credentials:'omit' });
    const data = await res.json().catch(()=> ({}));
    if (data && data.status === 200 && typeof data.data?.count === 'number') {
      document.getElementById('count-today').textContent = String(data.data.count);
      return;
    }
  } catch(_) {}
  const el = document.getElementById('count-today');
  if (el) el.textContent = String(todayCount);
}

/* ================== Export XLSX (GET) ================== */
async function onDownloadXls() {
  const from = document.getElementById('export_from')?.value;
  const to   = document.getElementById('export_to')?.value;
  if (!from || !to) { setStatus('Choisissez une période complète (du… au…).'); return; }
  if (from > to)     { setStatus('La date de début doit être antérieure à la date de fin.'); return; }

  try {
    setStatus('Préparation de l’export…');

    const url = `${API_BASE}?route=/export&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const res = await fetch(url, { method:'GET', mode:'cors', credentials:'omit' });

    const ct = res.headers.get('content-type') || '';
    const csvText = await res.text();

    if (!res.ok) { setStatus(`Erreur export (${res.status}).`); return; }
    if (ct.includes('application/json')) {
      try { const j = JSON.parse(csvText); setStatus(`Export: ${j.message || 'réponse JSON'}`); }
      catch { setStatus('Export: réponse JSON inattendue.'); }
      return;
    }

    const nonEmpty = csvText.trim();
    const lineCount = nonEmpty ? nonEmpty.split(/\r?\n/).length : 0;
    if (lineCount <= 1) { setStatus('Aucune donnée dans la période choisie.'); return; }

    if (typeof XLSX === 'undefined') { setStatus('Librairie Excel indisponible.'); return; }

    const wb = XLSX.read(csvText, { type: 'string', raw: true, cellText: false, cellDates: false });
    const first = wb.SheetNames[0];
    if (first !== 'Export') {
      if (wb.Sheets['Export']) { delete wb.Sheets['Export']; const i = wb.SheetNames.indexOf('Export'); if (i>-1) wb.SheetNames.splice(i,1); }
      wb.Sheets['Export'] = wb.Sheets[first];
      delete wb.Sheets[first];
      const idxFirst = wb.SheetNames.indexOf(first);
      if (idxFirst > -1) wb.SheetNames[idxFirst] = 'Export';
    }
    const ws = wb.Sheets['Export'];

    // Forcer colonne C (code_scanné) en texte + largeur auto
    const ref = ws['!ref'];
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      const colIdx = 2; // C
      let maxLen = 'code_scanné'.length;

      for (let R = range.s.r + 1; R <= range.e.r; R++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: colIdx });
        const cell = ws[addr];
        if (!cell) continue;
        const val = (cell.v == null) ? '' : String(cell.v);
        cell.t = 's'; cell.v = val; cell.w = val; cell.z = '@';
        if (val.length > maxLen) maxLen = val.length;
      }

      const wch = Math.max(18, Math.min(40, maxLen + 2));
      const cols = ws['!cols'] || [];
      while (cols.length <= colIdx) cols.push({});
      cols[colIdx] = { wch, hidden: false };
      ws['!cols'] = cols;
    }

    XLSX.writeFile(wb, `inventaire_${from}_au_${to}.xlsx`);
    setStatus('Fichier Excel téléchargé ✅ (colonne C en texte)');
  } catch (err) {
    console.error(err);
    setStatus('Erreur export. Vérifiez la période et réessayez.');
  }
}

/* ================== Photo → décodage ================== */
function onPhotoPicked(ev){
  const file = ev.target.files && ev.target.files[0];
  if (!file) {
    fileBlob = null; if (previewEl) previewEl.style.display = 'none';
    setStatus('Aucune photo choisie.'); return;
  }
  fileBlob = file;
  const url = URL.createObjectURL(file);
  if (previewEl) { previewEl.src = url; previewEl.style.display = 'block'; }

  setStatus('Décodage en cours…');
  setTimeout(decodePhoto, 0);
}

async function decodePhoto(){
  if (!fileBlob) return;

  // HEIC/HEIF → JPEG (iPhone)
  let blob = fileBlob;
  if (/image\/heic|image\/heif/i.test(blob.type) || /\.heic$/i.test(blob.name||'')) {
    try {
      await ensureHeic2Any();
      blob = await heic2any({ blob, toType: 'image/jpeg', quality: 0.95 });
    } catch(_) {}
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    const img = await new Promise((res,rej)=>{
      const u = URL.createObjectURL(blob);
      const i = new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=u;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img,0,0);
    bitmap = c;
  }

  const width = bitmap.width || bitmap.canvas?.width;
  const height = bitmap.height || bitmap.canvas?.height;
  const scales    = [1.0, 0.8, 0.6, 0.45];
  const rotations = [0, 90, 180, 270];

  const canvas = canvasEl;
  for (const scale of scales) {
    for (const rot of rotations) {
      const targetW = Math.max(240, Math.round(width * scale));
      const targetH = Math.max(240, Math.round(height * scale));
      const w = (rot % 180 === 0) ? targetW : targetH;
      const h = (rot % 180 === 0) ? targetH : targetW;
      canvas.width = w; canvas.height = h;

      const ctx2 = canvas.getContext('2d', { willReadFrequently: true });
      ctx2.save();
      ctx2.translate(w/2, h/2);
      ctx2.rotate(rot * Math.PI/180);
      ctx2.drawImage(bitmap, -targetW/2, -targetH/2, targetW, targetH);
      ctx2.restore();

      preprocessCanvas(ctx2, w, h);

      // 1) Natif
      const bd = await tryBarcodeDetectorOn(canvas);
      if (bd) { showPreview(canvas); onCodeDetected(String(bd).trim()); return; }

      // 2) ZXing
      await ensureZXing();
      const zx = tryZXingOn(canvas);
      if (zx) { showPreview(canvas); onCodeDetected(String(zx).trim()); return; }

      // 3) jsQR (QR only)
      await ensureJsQR();
      const jq = tryJsQROn(ctx2, w, h);
      if (jq) { showPreview(canvas); onCodeDetected(String(jq).trim()); return; }
    }
  }

  showPreview(canvas);
  setStatus('Aucun code détecté. Reprenez la photo (plus net, plus proche, meilleure lumière).');
}

function showPreview(canvas) {
  try {
    const url = canvas.toDataURL('image/png');
    if (previewEl) { previewEl.src = url; previewEl.style.display = 'block'; }
  } catch(_) {}
}

/* ================== Scan live (caméra) ================== */
let _cameraStream=null, _nativeLoopId=null, _nativeDetector=null, _zxingReader=null;

async function ensureCameraAccess(videoEl){
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal:'environment' },
      width: { ideal: 1280 },
      height:{ ideal: 720 }
    }
  };
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("getUserMedia indisponible");
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  _cameraStream = stream;
  videoEl.srcObject = stream;
  videoEl.setAttribute('playsinline','true');
  await videoEl.play();
  return stream;
}
function releaseCamera(){
  try{ _cameraStream?.getTracks()?.forEach(t=>t.stop()); }catch(_){}
  _cameraStream=null;
}

function openScanner(){
  const modal = document.getElementById('scannerModal');
  if (modal) modal.style.display='grid';
}
function closeScanner(){
  stopScanner();
  const modal = document.getElementById('scannerModal');
  if (modal) modal.style.display='none';
}
function stopScanner(){
  // natif
  try{ cancelAnimationFrame(_nativeLoopId);}catch(_){}
  _nativeLoopId=null; _nativeDetector=null;
  // zxing
  try{ _zxingReader && _zxingReader.reset(); }catch(_){}
  _zxingReader=null;
  // caméra
  releaseCamera();
}

async function startScanner(){
  const videoEl = document.getElementById('scannerVideo');
  if (!videoEl) { alert("Section scanner manquante dans l'HTML."); return; }

  openScanner();

  try{ await ensureCameraAccess(videoEl); }
  catch(_){ alert("Caméra refusée. Autorisez l'accès à l'appareil photo."); return; }

  // 1) natif
  try{
    _nativeDetector = await createBarcodeDetector();
    startNativeLoop(videoEl, (code)=>{ if(code){ onCodeDetected(code); closeScanner(); } });
    return;
  }catch(_){}

  // 2) Quagga (si self-hosté)
  try{
    await ensureQuagga();
    if (window.Quagga){
      try{ Quagga.stop(); }catch(_){}
      Quagga.init({
        inputStream:{ name:'Live', type:'LiveStream', target: videoEl, constraints:{ facingMode:'environment' } },
        decoder:{ readers:['ean_reader','code_128_reader','code_39_reader'] },
        locate:true, locator:{ halfSample:true, patchSize:'medium' }
      }, (err)=>{ if(err) throw err; Quagga.start(); });
      Quagga.offDetected?.();
      Quagga.onDetected((res)=>{
        const code = res?.codeResult?.code ? String(res.codeResult.code).trim() : '';
        if (code){ onCodeDetected(code); closeScanner(); }
      });
      return;
    }
  }catch(_){}

  // 3) ZXing
  try{
    await ensureZXing();
    _zxingReader = new ZXing.BrowserMultiFormatReader();
    const devices = await ZXing.BrowserCodeReader.listVideoInputDevices();
    const back = devices.find(d=>/back|rear|environment/i.test(d.label))?.deviceId || devices[0]?.deviceId;
    await _zxingReader.decodeFromVideoDevice(back, videoEl, (result, err, controls)=>{
      if(result?.getText){
        onCodeDetected(String(result.getText()).trim());
        controls.stop(); closeScanner();
      }
    });
  }catch(_){
    alert("Impossible de démarrer le scan. Utilisez l’upload photo.");
  }
}
function startNativeLoop(videoEl, onCode){
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently:true });
  const loop = async ()=>{
    const vw = videoEl.videoWidth||1280, vh = videoEl.videoHeight||720;
    if (!vw || !vh){ _nativeLoopId=requestAnimationFrame(loop); return; }
    canvas.width = vw; canvas.height = vh;
    ctx.drawImage(videoEl,0,0,vw,vh);
    try{
      const det = _nativeDetector;
      if (det){
        const blob = await new Promise(r=>canvas.toBlob(r,'image/png',0.9));
        const bmp = await createImageBitmap(blob);
        const res = await det.detect(bmp);
        if (res && res[0]?.rawValue){
          onCode(String(res[0].rawValue).trim()); return;
        }
      }
    }catch(_){}
    _nativeLoopId=requestAnimationFrame(loop);
  };
  cancelAnimationFrame(_nativeLoopId);
  _nativeLoopId=requestAnimationFrame(loop);
}

/* ================== Envoi backend (POST) ================== */
async function onSubmit(ev) {
  ev.preventDefault();
  const code = (document.getElementById('code')?.value || '').trim();
  const from = (document.getElementById('from')?.value || '').trim();
  const to = (document.getElementById('to')?.value || '').trim();
  const type = document.getElementById('type')?.value;
  const typeAutre = (document.getElementById('type_autre')?.value || '').trim();
  const date_mvt = document.getElementById('date_mvt')?.value;

  if (!code || !from || !to || !type) return setApiMsg('Veuillez remplir tous les champs.', true);

  const form = new URLSearchParams();
  form.set('action', 'create');
  form.set('code_scanné', code);
  form.set('emplacement_depart', from);
  form.set('emplacement_destination', to);
  form.set('type_mobilier', type);
  form.set('type_mobilier_autre', (type === 'Autre') ? typeAutre : '');
  form.set('date_mouvement', date_mvt);
  form.set('source_app_version', APP_VERSION);

  try {
    const res = await fetch(`${API_BASE}?route=/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString(),
      mode: 'cors',
      credentials: 'omit'
    });
    const data = await res.json().catch(()=> ({}));
    if (data && data.status >= 200 && data.status < 300) {
      setApiMsg('Écrit dans Google Sheets ✅', false);
      savePersistentDefaults();
      if (document.getElementById('date_mvt')?.value === todayISO) {
        const el = document.getElementById('count-today');
        if (el) el.textContent = String((parseInt(el.textContent,10)||0)+1);
      } else {
        refreshTodayCount();
      }
      resetFormUI();
    } else {
      setApiMsg(`Erreur API: ${data && data.message ? data.message : 'Inconnue'}`, true);
    }
  } catch (err) {
    console.error(err);
    setApiMsg('Erreur réseau/API. Vérifiez la Web App.', true);
  }
}

function resetFormUI() {
  const codeEl = document.getElementById('code'); if (codeEl) codeEl.value = '';
  const typeOtherWrap = document.getElementById('field-type-autre');
  const typeAutre = document.getElementById('type_autre');
  if (typeOtherWrap) typeOtherWrap.hidden = (document.getElementById('type')?.value !== 'Autre');
  if (typeAutre) typeAutre.value = '';
  const dateInput = document.getElementById('date_mvt'); if (dateInput) dateInput.value = todayISO;

  const preview = document.getElementById('preview'); if (preview) { preview.src = ''; preview.style.display = 'none'; }
  const photoInput = document.getElementById('photoInput'); if (photoInput) { photoInput.value = ''; }
  fileBlob = null;

  setStatus('Saisie enregistrée ✅. Nouvelle photo possible.');
  if (navigator.vibrate) navigator.vibrate(50);
}

/* ================== DOM Ready ================== */
document.addEventListener('DOMContentLoaded', () => {
  // Thème
  initTheme();
  const btnTheme = document.getElementById('btn-theme');
  if (btnTheme) btnTheme.addEventListener('click', toggleTheme);

  // Installer PWA
  const btnInstall = document.getElementById('btn-install');
  const iosPanel   = document.getElementById('ios-a2hs');
  const iosClose   = document.getElementById('ios-a2hs-close');
  const iosCard    = document.querySelector('#ios-a2hs .ios-a2hs-card');

  if (btnInstall && isIos() && isSafari() && !isInStandalone()) { btnInstall.hidden = false; }
  if (btnInstall) {
    btnInstall.addEventListener('click', async () => {
      if (isIos() && isSafari() && !isInStandalone()) { if (iosPanel) iosPanel.hidden = false; if (iosClose) setTimeout(()=>iosClose.focus(), 0); return; }
      if (deferredPrompt) { try { deferredPrompt.prompt(); await deferredPrompt.userChoice; } catch(_) {} deferredPrompt = null; }
      else { alert('Sur Android : ouvrez le menu ⋮ puis “Ajouter à l’écran d’accueil”.'); }
    });
  }
  if (iosClose) iosClose.addEventListener('click', () => { iosPanel.hidden = true; });
  if (iosPanel) {
    iosPanel.addEventListener('click', (ev) => { if (ev.target === iosPanel) iosPanel.hidden = true; });
    window.addEventListener('keydown', (ev) => { if (!iosPanel.hidden && ev.key === 'Escape') iosPanel.hidden = true; });
  }
  if (iosCard) iosCard.addEventListener('click', (e) => e.stopPropagation());

  // Réfs UI
  canvasEl = document.getElementById('canvas');
  statusEl = document.getElementById('status');
  flashEl = document.getElementById('flash');
  previewEl = document.getElementById('preview');

  // Capture photo (upload)
  const btnCapture = document.getElementById('btn-capture');
  const photoInput = document.getElementById('photoInput');
  if (btnCapture && photoInput) {
    btnCapture.addEventListener('click', () => { photoInput.click(); });
    photoInput.addEventListener('change', onPhotoPicked);
  }

  // Bouton scan live (optionnel si présent dans l’HTML)
  const btnScan = document.getElementById('btn-scan-live');
  if (btnScan) btnScan.addEventListener('click', startScanner);
  const btnScanStop  = document.getElementById('scannerStop');  if (btnScanStop)  btnScanStop.addEventListener('click', stopScanner);
  const btnScanClose = document.getElementById('scannerClose'); if (btnScanClose) btnScanClose.addEventListener('click', closeScanner);

  // Formulaire
  const typeSel = document.getElementById('type');
  const typeOtherWrap = document.getElementById('field-type-autre');
  if (typeSel && typeOtherWrap) typeSel.addEventListener('change', () => { typeOtherWrap.hidden = (typeSel.value !== 'Autre'); });
  const dateInput = document.getElementById('date_mvt');
  if (dateInput) dateInput.value = todayISO;

  const form = document.getElementById('form');
  if (form) form.addEventListener('submit', onSubmit);

  const btnTest = document.getElementById('btn-test');
  if (btnTest) btnTest.addEventListener('click', onTest);

  const btnClearDefaults = document.getElementById('btn-clear-defaults');
  if (btnClearDefaults) btnClearDefaults.addEventListener('click', clearPersistentDefaults);

  // Export XLS
  const exportFrom = document.getElementById('export_from');
  const exportTo = document.getElementById('export_to');
  const btnXls = document.getElementById('btn-download-xls');
  if (exportFrom) exportFrom.value = todayISO;
  if (exportTo) exportTo.value = todayISO;
  if (btnXls) btnXls.addEventListener('click', onDownloadXls);

  // Service Worker
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');

  // Compteur + valeurs persistées
  refreshTodayCount();
  loadPersistentDefaults();
});

/* ================== Bouton Test ================== */
function onTest() {
  const codeEl = document.getElementById('code');
  const fromEl = document.getElementById('from');
  const toEl = document.getElementById('to');
  const typeEl = document.getElementById('type');
  const dateEl = document.getElementById('date_mvt');

  if (codeEl) codeEl.value = 'TEST-QR-123';
  if (fromEl && !fromEl.value) fromEl.value = 'Voie Creuse';
  if (toEl && !toEl.value) toEl.value = 'Bibliothèque';
  if (typeEl && !typeEl.value) { typeEl.value = 'Bureau'; typeEl.dispatchEvent(new Event('change')); }
  if (dateEl) dateEl.value = todayISO;

  setStatus('Champs de test remplis. Appuyez sur “Enregistrer”.');
}
