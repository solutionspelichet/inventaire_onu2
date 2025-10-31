/* Inventaire ONU — app.js (v2.3.0)
 * - API_BASE pointé sur ton nouveau déploiement Apps Script
 * - Option PROXY_BASE (facultatif) pour contourner CORS si besoin
 * - Envoi POST x-www-form-urlencoded (évite preflight)
 * - GET /stats et /export
 * - Export Excel (colonne C texte, largeur auto)
 * - Scan photo (BarcodeDetector → ZXing → jsQR)
 * - Thème Pelichet light/dark + bascule
 * - Persistance from/to/type + bouton effacer
 */

////////////////////////////////////////
// CONFIG API
////////////////////////////////////////

// 👉 Mets ici TON NOUVEAU déploiement Apps Script
const API_BASE = "https://script.google.com/macros/s/AKfycbwtFL1iaSSdkB7WjExdXYGbQQbhPeIi_7F61pQdUEJK8kSFznjEOU68Fh6U538PGZW2/exec";
/* Inventaire ONU — app.js (v2.7.0)
   - Scanner live : BarcodeDetector → ZXing
   - Scanner via photo : HEIC→JPEG, orientation, redimensionnement, multi-échelles/rotations
   - Compteur du jour, export XLSX (colonne code en texte)
   - Thème Pelichet light/dark, loader + toast
*/

const APP_VERSION = "2.7.0";
const todayISO = new Date().toISOString().slice(0, 10);

/* ---------- Utils DOM ---------- */
const qs = (sel, el) => (el || document).querySelector(sel);
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some(s => (s.src || "").split("?")[0] === src.split("?")[0])) return resolve();
    const s = document.createElement("script");
    s.src = src; s.async = true; s.crossOrigin = "anonymous";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Erreur chargement: " + src));
    document.head.appendChild(s);
  });
}

/* ---------- Thème Pelichet ---------- */
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "dark") root.setAttribute("data-theme", "dark"); else root.removeAttribute("data-theme");
  const sun = qs("#icon-sun"), moon = qs("#icon-moon"), btn = qs("#btn-theme");
  const isDark = theme === "dark";
  if (sun) sun.hidden = isDark; if (moon) moon.hidden = !isDark; if (btn) btn.setAttribute("aria-pressed", String(isDark));
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = "theme-color"; document.head.appendChild(meta); }
  meta.content = isDark ? "#121417" : "#f6f8fa";
}
function initTheme(){ applyTheme(localStorage.getItem("theme") || "light"); }
function toggleTheme(){
  const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const nxt = cur === "dark" ? "light" : "dark";
  localStorage.setItem("theme", nxt); applyTheme(nxt);
}

/* ---------- Loader + Toast + Feedback ---------- */
let loaderEl, toastEl, submitBtn, statusEl, flashEl, previewEl, canvasEl;
function showLoader(msg="Envoi en cours…"){
  if (loaderEl) { const t=loaderEl.querySelector(".loader-text"); if (t) t.textContent = msg; loaderEl.hidden = false; }
  if (submitBtn) submitBtn.disabled = true;
}
function hideLoader(){ if (loaderEl) loaderEl.hidden = true; if (submitBtn) submitBtn.disabled = false; }
function showToast(message, type="success"){
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.className = "toast " + (type === "error" ? "toast-error" : "toast-success");
  toastEl.hidden = false;
  requestAnimationFrame(()=> toastEl.classList.remove("hide"));
  setTimeout(()=>{ toastEl.classList.add("hide"); setTimeout(()=>{ toastEl.hidden = true; toastEl.className = "toast"; },220); }, 3000);
}
function setStatus(msg){ if (statusEl) statusEl.textContent = msg; }
function vibrate(){ if (navigator.vibrate) navigator.vibrate(120); }
function flash(){
  if (!flashEl) return;
  flashEl.classList.remove("active"); void flashEl.offsetWidth; flashEl.classList.add("active");
  setTimeout(()=>flashEl.classList.remove("active"),150);
}
function beep(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type="sine"; o.frequency.setValueAtTime(1000, ctx.currentTime);
    g.gain.value = 0.001; o.connect(g).connect(ctx.destination); o.start();
    g.gain.exponentialRampToValueAtTime(0.1, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
    o.stop(ctx.currentTime + 0.2);
  }catch(_){}
}
function onCodeDetected(text){
  flash(); vibrate(); beep();
  const codeInput = qs("#code"); if (codeInput) { codeInput.value = text; codeInput.focus(); }
  setStatus(`Code détecté : ${text}`);
}

/* ---------- Compteur ---------- */
async function refreshTodayCount(){
  try{
    const r = await fetch(`${API_BASE}?route=/stats&day=${todayISO}`, { mode: "cors", credentials: "omit" });
    const j = await r.json().catch(()=> ({}));
    const n = (j && j.status === 200 && j.data && typeof j.data.count === "number") ? j.data.count : 0;
    const el = qs("#count-today"); if (el) el.textContent = String(n);
  }catch{
    const el = qs("#count-today"); if (el) el.textContent = "0";
  }
}

/* ---------- Export XLSX ---------- */
async function onDownloadXls(e){
  e.preventDefault();
  const from = qs("#export_from")?.value, to = qs("#export_to")?.value;
  if (!from || !to) return showToast("Sélectionnez une période complète.", "error");
  if (from > to)     return showToast("La date de début doit précéder la date de fin.", "error");
  try{
    showLoader("Préparation de l’export…");
    const r = await fetch(`${API_BASE}?route=/export&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { mode:"cors", credentials:"omit" });
    const text = await r.text(); hideLoader();
    if (!r.ok) { showToast(`Erreur export (${r.status})`, "error"); return; }
    if (typeof XLSX === "undefined"){ showToast("Librairie Excel indisponible.", "error"); return; }

    const wb = XLSX.read(text, { type: "string", raw: true, cellText: false, cellDates: false });
    const first = wb.SheetNames[0];
    if (first !== "Export") {
      if (wb.Sheets["Export"]) { delete wb.Sheets["Export"]; const i = wb.SheetNames.indexOf("Export"); if (i>-1) wb.SheetNames.splice(i,1); }
      wb.Sheets["Export"] = wb.Sheets[first]; delete wb.Sheets[first];
      const idxFirst = wb.SheetNames.indexOf(first); if (idxFirst>-1) wb.SheetNames[idxFirst] = "Export";
    }
    const ws = wb.Sheets["Export"];
    const ref = ws["!ref"];
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      const colIdx = 2; // C = code_scanné
      let maxLen = "code_scanné".length;
      for (let R = range.s.r + 1; R <= range.e.r; R++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: colIdx });
        const cell = ws[addr]; if (!cell) continue;
        const val = (cell.v == null) ? "" : String(cell.v);
        cell.t = "s"; cell.v = val; cell.w = val; cell.z = "@";
        if (val.length > maxLen) maxLen = val.length;
      }
      const wch = Math.max(18, Math.min(40, maxLen + 2));
      const cols = ws["!cols"] || []; while (cols.length <= colIdx) cols.push({});
      cols[colIdx] = { wch, hidden: false }; ws["!cols"] = cols;
    }
    XLSX.writeFile(wb, `inventaire_${from}_au_${to}.xlsx`);
    showToast("Fichier Excel téléchargé ✅", "success");
  }catch(err){
    hideLoader(); console.error(err); showToast("Erreur export", "error");
  }
}

/* ---------- Scanner LIVE : BarcodeDetector → ZXing ---------- */
let _stream = null, _nativeDetector = null, _zxingReader = null, _loop = null;
function hasBarcodeDetector(){ return "BarcodeDetector" in window; }
async function createBarcodeDetector(){
  const fmts = ["qr_code","ean_13","code_128","code_39","upc_a","ean_8","upc_e","itf"];
  return new window.BarcodeDetector({ formats: fmts });
}
async function ensureZXing(){
  if (window.ZXingBrowser || window.ZXing) return;
  await loadScriptOnce("https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js");
}
async function ensureCamera(video){
  const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio:false });
  _stream = s; video.srcObject = s; await video.play();
}
function releaseCamera(){ if (_stream) _stream.getTracks().forEach(t => t.stop()); _stream = null; }
async function startScanner(){
  const video = qs("#scannerVideo"); const modal = qs("#scannerModal");
  if (!video || !modal) return;
  modal.style.display = "grid";
  try { await ensureCamera(video); } catch { showToast("Caméra refusée (permissions)", "error"); modal.style.display="none"; return; }

  // 1) Natif
  try {
    _nativeDetector = await createBarcodeDetector();
    const c = document.createElement("canvas"), ctx = c.getContext("2d", { willReadFrequently: true });
    const loop = async () => {
      if (!_nativeDetector) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        c.width = video.videoWidth; c.height = video.videoHeight;
        ctx.drawImage(video,0,0,c.width,c.height);
        const bmp = await createImageBitmap(c);
        const r = await _nativeDetector.detect(bmp);
        if (r && r[0] && r[0].rawValue) { onCodeDetected(r[0].rawValue); closeScanner(); return; }
      }
      _loop = requestAnimationFrame(loop);
    };
    _loop = requestAnimationFrame(loop);
    return;
  } catch { /* fallback */ }

  // 2) ZXing
  try {
    await ensureZXing();
    const Reader = (window.ZXingBrowser && ZXingBrowser.BrowserMultiFormatReader) || (window.ZXing && ZXing.BrowserMultiFormatReader);
    const CodeReader = (window.ZXingBrowser && ZXingBrowser.BrowserCodeReader) || (window.ZXing && ZXing.BrowserCodeReader);
    _zxingReader = new Reader();
    const devices = await CodeReader.listVideoInputDevices();
    const back = devices && devices.length ? devices[0].deviceId : null;
    await _zxingReader.decodeFromVideoDevice(back, video, (res, err, controls) => {
      if (res && res.getText) { onCodeDetected(res.getText()); controls.stop(); closeScanner(); }
    });
  } catch {
    showToast("Aucun mode de scan disponible sur cet appareil.", "error");
  }
}
function stopScanner(){
  if (_loop) cancelAnimationFrame(_loop);
  _loop = null; _nativeDetector = null;
  if (_zxingReader && _zxingReader.reset) _zxingReader.reset();
  releaseCamera();
}
function closeScanner(){ stopScanner(); const m = qs("#scannerModal"); if (m) m.style.display = "none"; }

/* ---------- Scanner PHOTO : HEIC→JPEG, orientation, multi-échelles ---------- */
let fileBlob = null;

async function ensureHeic2Any(){
  if (window.heic2any) return;
  await loadScriptOnce("https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js");
}

/** Lis un File/Blob en ImageBitmap ou <img> (fallback iOS) */
async function blobToBitmapOrImage(blob){
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(blob);
    const img = await new Promise((resolve, reject) => {
      const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url;
    });
    URL.revokeObjectURL(url);
    return img;
  }
}

/** Redimensionne pour éviter canvas géant (perf mobile) */
function drawResizedToCanvas(source, maxW = 1600, maxH = 1600){
  const srcW = source.width || source.videoWidth || source.naturalWidth || source.canvas?.width || 0;
  const srcH = source.height || source.videoHeight || source.naturalHeight || source.canvas?.height || 0;
  if (!srcW || !srcH) throw new Error('Image invalide');

  const ratio = Math.min(maxW / srcW, maxH / srcH, 1);
  const w = Math.max(1, Math.round(srcW * ratio));
  const h = Math.max(1, Math.round(srcH * ratio));

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return c;
}

/** Boost léger contraste/luminance pour aider la lecture des barres */
function preprocessCanvas(ctx, w, h) {
  const img = ctx.getImageData(0,0,w,h);
  const d = img.data;
  const gamma = 0.9, contrast = 1.2, mid = 128;
  for (let i=0; i<d.length; i+=4) {
    let r=d[i], g=d[i+1], b=d[i+2];
    r = 255*Math.pow(r/255, gamma);
    g = 255*Math.pow(g/255, gamma);
    b = 255*Math.pow(b/255, gamma);
    r = (r - mid)*contrast + mid;
    g = (g - mid)*contrast + mid;
    b = (b - mid)*contrast + mid;
    d[i]   = r < 0 ? 0 : r > 255 ? 255 : r;
    d[i+1] = g < 0 ? 0 : g > 255 ? 255 : g;
    d[i+2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
  ctx.putImageData(img, 0, 0);
}

/** Déclenché après choix/prise de photo */
async function onPhotoPicked(ev){
  const file = ev.target.files && ev.target.files[0];
  previewEl && (previewEl.style.display = 'none');

  if (!file) { setStatus('Aucune photo choisie.'); return; }

  // Conversion HEIC/HEIF → JPEG si besoin (iOS surtout)
  let blob = file;
  if (/heic|heif/i.test(file.type) || /\.heic$/i.test(file.name)) {
    try { await ensureHeic2Any(); blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 }); }
    catch { /* on tente quand même sans conversion */ }
  }

  try {
    setStatus('Préparation de l’image…');
    const bmpOrImg = await blobToBitmapOrImage(blob);
    const baseCanvas = drawResizedToCanvas(bmpOrImg, 1600, 1600);

    // aperçu instantané
    showPreview(baseCanvas);

    setStatus('Décodage en cours…');
    await ensureZXing(); // on aura ZXing prêt

    const scales = [1.0, 0.8, 0.6, 0.45];
    const rotations = [0, 90, 180, 270];

    for (const scale of scales) {
      const scaled = drawResizedToCanvas(baseCanvas, Math.round(baseCanvas.width * scale), Math.round(baseCanvas.height * scale));
      const ctxBase = scaled.getContext('2d', { willReadFrequently: true });
      preprocessCanvas(ctxBase, scaled.width, scaled.height);

      for (const rot of rotations) {
        const w = (rot % 180 === 0) ? scaled.width : scaled.height;
        const h = (rot % 180 === 0) ? scaled.height : scaled.width;

        canvasEl.width = w; canvasEl.height = h;
        const ctx = canvasEl.getContext('2d', { willReadFrequently: true });

        ctx.save();
        ctx.translate(w/2, h/2);
        ctx.rotate(rot * Math.PI/180);
        ctx.drawImage(scaled, -scaled.width/2, -scaled.height/2);
        ctx.restore();

        // 1) Natif BarcodeDetector si dispo
        if ('BarcodeDetector' in window) {
          try {
            const det = new window.BarcodeDetector({
              formats: ['qr_code','ean_13','code_128','code_39','upc_a','ean_8','upc_e','itf']
            });
            const bmp = await createImageBitmap(canvasEl);
            const r = await det.detect(bmp);
            if (r && r[0] && r[0].rawValue) {
              onCodeDetected(r[0].rawValue); showPreview(canvasEl); setStatus('Code détecté ✅'); return;
            }
          } catch {}
        }

        // 2) ZXing (canvas)
        try {
          const luminance = new ZXing.HTMLCanvasElementLuminanceSource(canvasEl);
          const bin = new ZXing.HybridBinarizer(luminance);
          const bmp = new ZXing.BinaryBitmap(bin);
          const reader = new ZXing.MultiFormatReader();
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
          reader.setHints(hints);
          const res = reader.decode(bmp);
          if (res && res.getText) { onCodeDetected(res.getText()); showPreview(canvasEl); setStatus('Code détecté ✅'); return; }
        } catch {}

        // 3) jsQR (QR uniquement)
        if (window.jsQR) {
          try {
            const img = ctx.getImageData(0,0,w,h);
            const qr = jsQR(img.data, w, h);
            if (qr && qr.data) { onCodeDetected(qr.data); showPreview(canvasEl); setStatus('Code détecté (QR) ✅'); return; }
          } catch {}
        }
      }
    }

    showPreview(baseCanvas);
    setStatus('Aucun code détecté. Reprenez une photo (plus proche, nette, bonne lumière).');

  } catch (err) {
    console.error(err);
    setStatus('Erreur lors du traitement de la photo.');
    showToast('Échec décodage photo', 'error');
  } finally {
    const input = document.getElementById('photoInput');
    if (input) input.value = '';
  }
}

/** Affiche l’aperçu (image finale ou canvas) */
function showPreview(canvasOrImg) {
  try {
    let url = null;
    if (canvasOrImg instanceof HTMLCanvasElement) {
      url = canvasOrImg.toDataURL('image/jpeg', 0.9);
    } else if (canvasOrImg instanceof HTMLImageElement) {
      const c = document.createElement('canvas');
      c.width = canvasOrImg.naturalWidth || canvasOrImg.width;
      c.height = canvasOrImg.naturalHeight || canvasOrImg.height;
      c.getContext('2d').drawImage(canvasOrImg, 0, 0);
      url = c.toDataURL('image/jpeg', 0.9);
    }
    if (url && previewEl) { previewEl.src = url; previewEl.style.display = 'block'; }
  } catch (_) {}
}

/* ---------- Envoi backend ---------- */
function setApiMsg(msg, isError=false){
  const el = qs("#api-msg"); if (!el) return;
  el.textContent = msg; el.style.color = isError ? "#ef4444" : "#22c55e";
}
async function onSubmit(e){
  e.preventDefault();
  const code = qs("#code")?.value.trim();
  const from = qs("#from")?.value.trim();
  const to   = qs("#to")?.value.trim();
  const type = qs("#type")?.value;
  const typeAutre = qs("#type_autre")?.value.trim();
  const date_mvt  = qs("#date_mvt")?.value;
  if (!code || !from || !to || !type) { showToast("Veuillez remplir tous les champs.", "error"); return; }

  const body = new URLSearchParams();
  body.set("route","/items");
  body.set("action","create");
  body.set("code_scanné", code);
  body.set("emplacement_depart", from);
  body.set("emplacement_destination", to);
  body.set("type_mobilier", type);
  body.set("type_mobilier_autre", (type === "Autre") ? (typeAutre || "") : "");
  body.set("date_mouvement", date_mvt);
  body.set("source_app_version", APP_VERSION);

  showLoader("Envoi en cours…"); setApiMsg("", false);
  try{
    const r = await fetch(`${API_BASE}?route=/items`, {
      method: "POST",
      headers: { "Content-Type":"application/x-www-form-urlencoded;charset=UTF-8" },
      body: body.toString(),
      mode: "cors",
      credentials: "omit"
    });
    const j = await r.json().catch(()=> ({}));
    hideLoader();
    if (j && j.status >= 200 && j.status < 300) {
      setApiMsg("Écrit dans Google Sheets ✅", false);
      showToast("Saisie enregistrée ✅", "success");
      if (qs("#date_mvt")?.value === todayISO) {
        const el = qs("#count-today"); if (el) el.textContent = String((parseInt(el.textContent,10)||0)+1);
      } else { refreshTodayCount(); }
      resetFormUI();
    } else {
      const msg = (j && j.message) ? j.message : "Erreur inconnue";
      setApiMsg("Erreur API: " + msg, true); showToast("Erreur API: " + msg, "error");
    }
  }catch(err){
    hideLoader(); console.error(err);
    setApiMsg("Erreur réseau/API.", true); showToast("Erreur réseau/API.", "error");
  }
}
function resetFormUI(){
  const codeEl = qs("#code"); if (codeEl) codeEl.value = "";
  const typeOtherWrap = qs("#field-type-autre"); const typeAutre = qs("#type_autre");
  if (typeOtherWrap) typeOtherWrap.hidden = (qs("#type")?.value !== "Autre");
  if (typeAutre) typeAutre.value = "";
  const dateInput = qs("#date_mvt"); if (dateInput) dateInput.value = todayISO;

  const preview = qs("#preview"); if (preview) { preview.src = ""; preview.style.display = "none"; }
  const photoInput = qs("#photoInput"); if (photoInput) { photoInput.value = ""; }
  fileBlob = null;

  setStatus("Saisie enregistrée ✅. Nouvelle photo possible.");
  if (navigator.vibrate) navigator.vibrate(50);
}

/* ---------- DOM Ready ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  qs("#btn-theme")?.addEventListener("click", toggleTheme);

  statusEl = qs("#status"); flashEl = qs("#flash"); previewEl = qs("#preview"); canvasEl = qs("#canvas");
  loaderEl = qs("#loader"); toastEl = qs("#toast"); submitBtn = qs("#btn-submit");

  const dateEl = qs("#date_mvt"); if (dateEl) dateEl.value = todayISO;
  const fromEl = qs("#export_from"), toEl = qs("#export_to");
  if (fromEl) fromEl.value = todayISO; if (toEl) toEl.value = todayISO;

  const typeSel = qs("#type"), typeOther = qs("#field-type-autre");
  if (typeSel) typeSel.addEventListener("change", () => { if (typeOther) typeOther.hidden = (typeSel.value !== "Autre"); });

  const captureBtn = qs("#btn-capture"), photoInput = qs("#photoInput");
  if (captureBtn && photoInput) captureBtn.addEventListener("click", () => photoInput.click());
  if (photoInput) photoInput.addEventListener("change", onPhotoPicked);

  const scanLive = qs("#btn-scan-live"); if (scanLive) scanLive.addEventListener("click", startScanner);
  qs("#scannerStop")?.addEventListener("click", stopScanner);
  qs("#scannerClose")?.addEventListener("click", closeScanner);

  qs("#form")?.addEventListener("submit", onSubmit);
  qs("#btn-test")?.addEventListener("click", () => {
    const codeEl = qs("#code"); if (codeEl) codeEl.value = "TEST-QR-123";
    const fromEl2 = qs("#from"); if (fromEl2 && !fromEl2.value) fromEl2.value = "Voie Creuse";
    const toEl2 = qs("#to"); if (toEl2 && !toEl2.value) toEl2.value = "Bibliothèque";
    const typeEl = qs("#type"); if (typeEl && !typeEl.value) { typeEl.value = "Bureau"; typeEl.dispatchEvent(new Event("change")); }
    const dateEl2 = qs("#date_mvt"); if (dateEl2) dateEl2.value = todayISO;
    setStatus("Champs de test remplis. Appuyez sur “Enregistrer”.");
  });

  qs("#btn-download-xls")?.addEventListener("click", onDownloadXls);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js").catch(()=>{});

  refreshTodayCount();
});
