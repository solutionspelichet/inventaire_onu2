/* ================== App Frontend — QC ================== */
/* Backend (Apps Script WebApp /exec) */
const API_BASE = "https://script.google.com/macros/s/AKfycbwtFL1iaSSdkB7WjExdXYGbQQbhPeIi_7F61pQdUEJK8kSFznjEOU68Fh6U538PGZW2/exec";
const APP_VERSION = "2.3.2";

/* ---------- Helpers DOM ---------- */
function qs(sel, el) { return (el || document).querySelector(sel); }
function qsa(sel, el) { return Array.from((el || document).querySelectorAll(sel)); }
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some(s => (s.src || "").split("?")[0] === src.split("?")[0])) return resolve();
    const sc = document.createElement("script");
    sc.src = src; sc.async = true; sc.crossOrigin = "anonymous";
    sc.onload = () => resolve();
    sc.onerror = () => reject(new Error("Échec chargement: " + src));
    document.head.appendChild(sc);
  });
}
const todayISO = new Date().toISOString().slice(0, 10);

/* ---------- Thème ---------- */
(function initTheme() {
  const t = localStorage.getItem("theme") || "light";
  applyTheme(t);
})();
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "dark") root.setAttribute("data-theme", "dark"); else root.removeAttribute("data-theme");
  const sun = qs("#icon-sun"), moon = qs("#icon-moon"), btn = qs("#btn-theme");
  const isDark = theme === "dark";
  if (sun) sun.hidden = isDark;
  if (moon) moon.hidden = !isDark;
  if (btn) btn.setAttribute("aria-pressed", String(isDark));
}
const btnTheme = qs("#btn-theme");
if (btnTheme) btnTheme.addEventListener("click", function () {
  const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const nxt = cur === "dark" ? "light" : "dark";
  localStorage.setItem("theme", nxt);
  applyTheme(nxt);
});

/* ---------- Status / Loader / Flash ---------- */
function setStatus(msg) { const el = qs("#status"); if (el) el.textContent = msg; }
function setApiMsg(msg, isErr) { const el = qs("#api-msg"); if (!el) return; el.textContent = msg; el.style.color = isErr ? "#ef4444" : "#22c55e"; }

let loaderCount = 0;
function showLoader(msg) {
  const M = qs("#globalLoader"); if (!M) return;
  const lab = qs("#loaderMsg"); if (lab) lab.textContent = msg || "Chargement…";
  M.style.display = "flex"; loaderCount++;
}
function hideLoader() {
  const M = qs("#globalLoader"); if (!M) return;
  loaderCount = Math.max(0, loaderCount - 1);
  if (!loaderCount) M.style.display = "none";
}
function flash() { const f = qs("#flash"); if (!f) return; f.classList.remove("active"); void f.offsetWidth; f.classList.add("active"); setTimeout(() => f.classList.remove("active"), 150); }
function vibrate() { if (navigator.vibrate) navigator.vibrate(120); }

/* ---------- Init champs ---------- */
document.addEventListener("DOMContentLoaded", function () {
  const d = qs("#date_mvt"); if (d) d.value = todayISO;
  const d1 = qs("#export_from"); if (d1) d1.value = todayISO;
  const d2 = qs("#export_to"); if (d2) d2.value = todayISO;

  const typeSel = qs("#type"), typeAutreWrap = qs("#field-type-autre");
  if (typeSel) typeSel.addEventListener("change", function () {
    if (typeAutreWrap) typeAutreWrap.hidden = (typeSel.value !== "Autre");
  });

  const btnCapture = qs("#btn-capture"), photoInput = qs("#photoInput");
  if (btnCapture && photoInput) btnCapture.addEventListener("click", function () { photoInput.click(); });
  if (photoInput) photoInput.addEventListener("change", onPhotoPicked);

  const btnLive = qs("#btn-scan-live");
  if (btnLive) btnLive.addEventListener("click", startScanner);
  const btnStop = qs("#scannerStop"), btnClose = qs("#scannerClose");
  if (btnStop) btnStop.addEventListener("click", stopScanner);
  if (btnClose) btnClose.addEventListener("click", closeScanner);

  const form = qs("#form"); if (form) form.addEventListener("submit", onSubmit);
  const btnTest = qs("#btn-test"); if (btnTest) btnTest.addEventListener("click", onTest);

  const btnXls = qs("#btn-download-xls"); if (btnXls) btnXls.addEventListener("click", onDownloadXls);

  refreshTodayCount();
});

/* ---------- KPI jour ---------- */
async function refreshTodayCount() {
  try {
    const r = await fetch(API_BASE + "?route=stats&day=" + encodeURIComponent(todayISO));
    const ct = r.headers.get("content-type") || "";
    let j = null;
    if (ct.indexOf("application/json") > -1) j = await r.json(); else await r.text();
    const n = (j && j.status === 200 && j.data && typeof j.data.count === "number") ? j.data.count : 0;
    const el = qs("#count-today"); if (el) el.textContent = String(n);
  } catch (e) {
    const el = qs("#count-today"); if (el) el.textContent = "0";
  }
}

/* ---------- Export XLSX ---------- */
async function onDownloadXls(ev) {
  ev.preventDefault();
  const from = qs("#export_from") ? qs("#export_from").value : "";
  const to = qs("#export_to") ? qs("#export_to").value : "";
  if (!from || !to) { setStatus("Sélectionnez une période complète."); return; }
  if (from > to) { setStatus("La date de début doit précéder la date de fin."); return; }

  try {
    showLoader("Préparation export…");
    const url = API_BASE + "?route=export&from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
    const r = await fetch(url);
    const text = await r.text();
    if (!r.ok) throw new Error("HTTP " + r.status);
    if (typeof XLSX === "undefined") throw new Error("Lib XLSX indisponible");
    const wb = XLSX.read(text, { type: "string", raw: true });
    XLSX.writeFile(wb, "export_" + from + "_au_" + to + ".xlsx");
    setStatus("Export généré ✅");
  } catch (err) {
    setStatus("Erreur export : " + (err && err.message ? err.message : err));
  } finally { hideLoader(); }
}

/* ---------- Scanner (live) ---------- */
let _stream = null, _detector = null, _zxingReader = null, _rafId = null;

function hasBarcodeDetector() { return typeof window.BarcodeDetector !== "undefined"; }
async function createBarcodeDetector() {
  try { return new window.BarcodeDetector({ formats: ["qr_code", "ean_13", "code_128", "code_39", "ean_8", "upc_a", "upc_e"] }); }
  catch (e) { return new window.BarcodeDetector(); }
}
async function ensureZXing() {
  if (window.ZXingBrowser) return;
  await loadScriptOnce("https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js");
}
async function ensureQuagga() {
  if (window.Quagga) return;
  const base = location.origin + location.pathname.replace(/\/[^/]*$/, "/");
  await loadScriptOnce(base + "libs/quagga.min.js").catch(function () { /* silencieux */ });
}
async function ensureCamera(videoEl) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("getUserMedia indisponible");
  const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  _stream = s; videoEl.srcObject = s; videoEl.setAttribute("playsinline", "true"); await videoEl.play();
}
function releaseCamera() { try { if (_stream) _stream.getTracks().forEach(t => t.stop()); } catch (e) {} _stream = null; }
function openScanner() { const m = qs("#scannerModal"); if (m) m.style.display = "grid"; }
function closeScanner() { stopScanner(); const m = qs("#scannerModal"); if (m) m.style.display = "none"; }
function stopScanner() {
  try { if (_rafId) cancelAnimationFrame(_rafId); } catch (e) {}
  _rafId = null; _detector = null;
  try { if (_zxingReader) _zxingReader.reset(); } catch (e) {}
  _zxingReader = null; releaseCamera();
}

async function startScanner() {
  const video = qs("#scannerVideo");
  if (!video) { alert("Zone vidéo absente."); return; }
  openScanner();
  try { await ensureCamera(video); } catch (e) { alert("Caméra refusée. Autorisez l'accès."); return; }

  // 1) Natif
  if (hasBarcodeDetector()) {
    try {
      _detector = await createBarcodeDetector();
      const c = document.createElement("canvas"), ctx = c.getContext("2d", { willReadFrequently: true });
      const loop = async function () {
        if (!_detector) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          c.width = video.videoWidth; c.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, c.width, c.height);
          try {
            const bmp = await createImageBitmap(c);
            const res = await _detector.detect(bmp);
            if (res && res[0] && res[0].rawValue) { onCodeDetected(String(res[0].rawValue).trim()); closeScanner(); return; }
          } catch (e) {}
        }
        _rafId = requestAnimationFrame(loop);
      };
      _rafId = requestAnimationFrame(loop);
      return;
    } catch (e) {}
  }

  // 2) Quagga local si dispo
  try {
    await ensureQuagga();
    if (window.Quagga) {
      try { Quagga.stop(); } catch (e) {}
      Quagga.init({
        inputStream: { name: "Live", type: "LiveStream", target: video, constraints: { facingMode: "environment" } },
        decoder: { readers: ["ean_reader", "code_128_reader", "code_39_reader"] },
        locate: true, locator: { halfSample: true, patchSize: "medium" }
      }, function (err) { if (err) console.error(err); else Quagga.start(); });
      Quagga.onDetected(function (res) {
        const code = res && res.codeResult && res.codeResult.code ? String(res.codeResult.code).trim() : "";
        if (code) { onCodeDetected(code); closeScanner(); }
      });
      return;
    }
  } catch (e) {}

  // 3) ZXing CDN
  try {
    await ensureZXing();
    _zxingReader = new ZXingBrowser.BrowserMultiFormatReader();
    const devices = await ZXingBrowser.BrowserCodeReader.listVideoInputDevices();
    const back = devices && devices.length ? (devices.find(d => /back|rear|environment/i.test(d.label)) || devices[0]).deviceId : undefined;
    await _zxingReader.decodeFromVideoDevice(back, video, function (result, err, controls) {
      if (result && result.getText) { onCodeDetected(String(result.getText()).trim()); controls.stop(); closeScanner(); }
    });
  } catch (e) {
    alert("Impossible de démarrer le scan. Utilisez le mode photo.");
  }
}
function onCodeDetected(code) {
  flash(); vibrate();
  const input = qs("#code"); if (input) input.value = code;
  setStatus("Code détecté : " + code);
}

/* ---------- Décodage via photo (HEIC OK) ---------- */
async function ensureHeic2Any() {
  if (window.heic2any) return;
  await loadScriptOnce("https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js");
}
async function onPhotoPicked(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) { const p = qs("#preview"); if (p) { p.style.display = "none"; p.src = ""; } setStatus("Aucune photo."); return; }
  setStatus("Décodage en cours…");

  let blob = file;
  if ((file.type && /image\/heic|image\/heif/i.test(file.type)) || /\.heic$/i.test(file.name || "")) {
    try { await ensureHeic2Any(); blob = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.95 }); } catch (e) {}
  }
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }); }
  catch (e) {
    const img = await new Promise(function (res, rej) {
      const u = URL.createObjectURL(blob);
      const i = new Image();
      i.onload = function () { URL.revokeObjectURL(u); res(i); };
      i.onerror = rej; i.src = u;
    });
    const cTmp = document.createElement("canvas"); cTmp.width = img.naturalWidth; cTmp.height = img.naturalHeight;
    cTmp.getContext("2d").drawImage(img, 0, 0); bmp = cTmp;
  }

  const W = bmp.width || (bmp.canvas && bmp.canvas.width) || 640;
  const H = bmp.height || (bmp.canvas && bmp.canvas.height) || 480;
  const canvas = qs("#canvas"); const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const scales = [1.0, 0.8, 0.6, 0.45], rots = [0, 90, 180, 270];

  for (var sIdx = 0; sIdx < scales.length; sIdx++) {
    for (var rIdx = 0; rIdx < rots.length; rIdx++) {
      var s = scales[sIdx], r = rots[rIdx];
      var tw = Math.max(240, Math.round(W * s)), th = Math.max(240, Math.round(H * s));
      var cw = (r % 180 === 0) ? tw : th, ch = (r % 180 === 0) ? th : tw;
      canvas.width = cw; canvas.height = ch;
      ctx.save(); ctx.translate(cw / 2, ch / 2); ctx.rotate(r * Math.PI / 180); ctx.drawImage(bmp, -tw / 2, -th / 2, tw, th); ctx.restore();

      // Détection native
      var n = await tryBarcodeDetectorOn(canvas);
      if (n) { showPreview(canvas); onCodeDetected(String(n).trim()); ev.target.value = ""; return; }

      // ZXing
      var zx = await tryZXingOn(canvas);
      if (zx) { showPreview(canvas); onCodeDetected(String(zx).trim()); ev.target.value = ""; return; }
    }
  }
  showPreview(canvas);
  setStatus("Aucun code détecté. Réessayez (plus net/proche).");
  ev.target.value = "";
}
function showPreview(canvas) {
  try { const url = canvas.toDataURL("image/png"); const img = qs("#preview"); if (img) { img.src = url; img.style.display = "block"; } } catch (e) {}
}
async function tryBarcodeDetectorOn(canvas) {
  if (!hasBarcodeDetector()) return null;
  try {
    const det = await createBarcodeDetector();
    const bmp = await createImageBitmap(canvas);
    const res = await det.detect(bmp);
    return (res && res[0] && res[0].rawValue) ? res[0].rawValue : null;
  } catch (e) { return null; }
}
async function tryZXingOn(canvas) {
  try {
    await ensureZXing();
    // ZXing UMD expose ZXingBrowser.* pour la lecture camera.
    // Pour image fixe, on peut utiliser le lecteur binaire via BrowserBarcodeReader:
    const reader = new ZXingBrowser.BrowserMultiFormatReader();
    const luminanceSource = new ZXingBrowser.HTMLCanvasElementLuminanceSource(canvas);
    const binarizer = new ZXingBrowser.HybridBinarizer(luminanceSource);
    const bitmap = new ZXingBrowser.BinaryBitmap(binarizer);
    const result = reader.decodeBitmap(bitmap);
    if (result && result.getText) return result.getText();
  } catch (e) { /* ignore */ }
  return null;
}

/* ---------- Envoi Backend ---------- */
async function onSubmit(e) {
  e.preventDefault();
  const code = qs("#code") ? qs("#code").value.trim() : "";
  const from = qs("#from") ? qs("#from").value.trim() : "";
  const to = qs("#to") ? qs("#to").value.trim() : "";
  const type = qs("#type") ? qs("#type").value.trim() : "";
  const type_autre = qs("#type_autre") ? qs("#type_autre").value.trim() : "";
  const date = qs("#date_mvt") ? qs("#date_mvt").value : todayISO;
  if (!code || !from || !to || !type) { setApiMsg("Veuillez remplir tous les champs.", true); return; }

  const form = new URLSearchParams();
  form.set("action", "create");
  form.set("code_scanné", code);  // avec accent
  form.set("code_scanne", code);  // fallback sans accent
  form.set("emplacement_depart", from);
  form.set("emplacement_destination", to);
  form.set("type_mobilier", type);
  form.set("type_mobilier_autre", (type === "Autre" ? type_autre : ""));
  form.set("date_mouvement", date);
  form.set("source_app_version", APP_VERSION);

  showLoader("Enregistrement…");
  try {
    // Si ton backend attend /items avec slash, remets-le ici.
    const url = API_BASE + "?route=items";
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: form.toString()
    });

    const ct = r.headers.get("content-type") || "";
    let payload = null, bodyText = "";
    if (ct.indexOf("application/json") > -1) {
      payload = await r.json().catch(function () { return {}; });
    } else {
      bodyText = await r.text().catch(function () { return ""; });
    }

    if (r.ok && payload && payload.status >= 200 && payload.status < 300) {
      setApiMsg("Écrit dans Google Sheets ✅", false);
      const el = qs("#count-today");
      if (el && date === todayISO) {
        const current = parseInt(el.textContent, 10) || 0;
        el.textContent = String(current + 1);
      } else {
        refreshTodayCount();
      }
      resetFormUI();
    } else {
      const msg = (payload && (payload.error || payload.message)) || (bodyText ? ("Réponse non-JSON:\n" + bodyText.slice(0, 400)) : ("HTTP " + r.status));
      setApiMsg("Erreur API : " + msg, true);
      alert("Erreur API : " + msg);
    }
  } catch (err) {
    setApiMsg("Erreur réseau/API : " + (err && err.message ? err.message : err), true);
    alert("Erreur réseau/API : " + (err && err.message ? err.message : err));
  } finally {
    hideLoader();
  }
}

function resetFormUI() {
  const codeEl = qs("#code"); if (codeEl) codeEl.value = "";
  const typeSel = qs("#type"); if (typeSel && typeSel.options && typeSel.options.length) typeSel.value = typeSel.options[0].value;
  const wrap = qs("#field-type-autre"); if (wrap) wrap.hidden = true;
  const other = qs("#type_autre"); if (other) other.value = "";
  const dateEl = qs("#date_mvt"); if (dateEl) dateEl.value = todayISO;
  const prev = qs("#preview"); if (prev) { prev.src = ""; prev.style.display = "none"; }
  setStatus("Saisie enregistrée ✅");
}

/* ---------- Bouton test ---------- */
function onTest() {
  const codeEl = qs("#code"); if (codeEl) codeEl.value = "TEST-1234567890123";
  const fromEl = qs("#from"); if (fromEl && !fromEl.value) fromEl.value = "Voie Creuse";
  const toEl = qs("#to"); if (toEl && !toEl.value) toEl.value = "Bibliothèque";
  const typeEl = qs("#type"); if (typeEl && !typeEl.value) typeEl.value = "Bureau";
  const dateEl = qs("#date_mvt"); if (dateEl) dateEl.value = todayISO;
  setStatus("Champs de test remplis.");
}
