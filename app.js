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
/* Inventaire ONU — app.js (v3.5.0 focus/Tap-to-aim fix)
   - Overlay ROI lié au <video>, ROI visible (cadre + réticule rouge)
   - Tap-to-aim sur l’OVERLAY (pas sur la vidéo)
   - Décodage ROI + fallback plein cadre
   - Export XLSX, toasts, loader, compteur du jour
*/

const APP_VERSION = "3.5.0";
const todayISO = new Date().toISOString().slice(0,10);

/* -------- Utils DOM -------- */
const qs = (s, el) => (el||document).querySelector(s);
function loadScriptOnce(src){
  return new Promise((res,rej)=>{
    if ([...document.scripts].some(s=> (s.src||"").split("?")[0]===src.split("?")[0])) return res();
    const tag=document.createElement("script");
    tag.src=src; tag.async=true; tag.crossOrigin="anonymous";
    tag.onload=()=>res(); tag.onerror=()=>rej(new Error("load "+src));
    document.head.appendChild(tag);
  });
}

/* -------- Thème -------- */
function applyTheme(theme){
  const root=document.documentElement;
  if (theme==="dark") root.setAttribute("data-theme","dark"); else root.removeAttribute("data-theme");
  let meta=document.querySelector('meta[name="theme-color"]'); if(!meta){meta=document.createElement('meta'); meta.name="theme-color"; document.head.appendChild(meta);}
  meta.content = theme==="dark" ? "#121417" : "#f6f8fa";
}
function initTheme(){ applyTheme(localStorage.getItem("theme")||"light"); }
function toggleTheme(){ const cur=document.documentElement.getAttribute("data-theme")==="dark"?"dark":"light"; const nxt=cur==="dark"?"light":"dark"; localStorage.setItem("theme",nxt); applyTheme(nxt); }

/* -------- UI feedback -------- */
let loaderEl, toastEl, submitBtn, statusEl, flashEl, previewEl, canvasEl;
function showLoader(msg="Envoi en cours…"){ if(loaderEl){const t=loaderEl.querySelector(".loader-text"); if(t) t.textContent=msg; loaderEl.hidden=false;} if(submitBtn) submitBtn.disabled=true; }
function hideLoader(){ if(loaderEl) loaderEl.hidden=true; if(submitBtn) submitBtn.disabled=false; }
function showToast(message, type="success"){
  if(!toastEl) return;
  toastEl.textContent=message;
  toastEl.className="toast "+(type==="error"?"toast-error":"toast-success");
  toastEl.hidden=false; requestAnimationFrame(()=>toastEl.classList.remove("hide"));
  setTimeout(()=>{ toastEl.classList.add("hide"); setTimeout(()=>{ toastEl.hidden=true; toastEl.className="toast"; },220); },3000);
}
function setStatus(msg){ if(statusEl) statusEl.textContent=msg; }
function vibrate(){ if(navigator.vibrate) navigator.vibrate(100); }
function flash(){ if(!flashEl) return; flashEl.classList.remove("active"); void flashEl.offsetWidth; flashEl.classList.add("active"); setTimeout(()=>flashEl.classList.remove("active"),150); }
function beep(){
  try{ const ctx=new (window.AudioContext||window.webkitAudioContext)(); const o=ctx.createOscillator(), g=ctx.createGain();
    o.type="sine"; o.frequency.value=1000; g.gain.value=0.001; o.connect(g).connect(ctx.destination); o.start();
    g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + .01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + .15); o.stop(ctx.currentTime + .18);
  }catch(_){}
}
function onCodeDetected(text){
  flash(); vibrate(); beep();
  const codeInput=qs("#code"); if(codeInput){codeInput.value=text; codeInput.focus();}
  setStatus("Code détecté : "+text);
}

/* -------- Compteur -------- */
async function refreshTodayCount(){
  try{
    const r=await fetch(`${API_BASE}?route=/stats&day=${todayISO}`, {mode:"cors", credentials:"omit"});
    const j=await r.json().catch(()=> ({}));
    const n=(j && j.status===200 && j.data && typeof j.data.count==="number") ? j.data.count : 0;
    const el=qs("#count-today"); if(el) el.textContent=String(n);
  }catch{ const el=qs("#count-today"); if(el) el.textContent="0"; }
}

/* -------- Export XLSX -------- */
async function onDownloadXls(e){
  e.preventDefault();
  const from=qs("#export_from")?.value, to=qs("#export_to")?.value;
  if(!from || !to) return showToast("Sélectionnez une période complète.","error");
  if(from>to) return showToast("La date de début doit précéder la date de fin.","error");
  try{
    showLoader("Préparation de l’export…");
    const r=await fetch(`${API_BASE}?route=/export&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {mode:"cors", credentials:"omit"});
    const text=await r.text(); hideLoader();
    if(!r.ok) return showToast(`Erreur export (${r.status})`,"error");
    if(typeof XLSX==="undefined") return showToast("Librairie Excel indisponible.","error");

    const wb=XLSX.read(text, {type:"string", raw:true, cellText:false, cellDates:false});
    const first=wb.SheetNames[0];
    if(first!=="Export"){
      if(wb.Sheets["Export"]){ delete wb.Sheets["Export"]; const i=wb.SheetNames.indexOf("Export"); if(i>-1) wb.SheetNames.splice(i,1); }
      wb.Sheets["Export"]=wb.Sheets[first]; delete wb.Sheets[first];
      const idx=wb.SheetNames.indexOf(first); if(idx>-1) wb.SheetNames[idx]="Export";
    }
    const ws=wb.Sheets["Export"];
    const ref=ws["!ref"];
    if(ref){
      const range=XLSX.utils.decode_range(ref);
      const colIdx=2; // C = code_scanné
      let maxLen="code_scanné".length;
      for(let R=range.s.r+1; R<=range.e.r; R++){
        const addr=XLSX.utils.encode_cell({r:R,c:colIdx});
        const cell=ws[addr]; if(!cell) continue;
        const val=(cell.v==null)?"":String(cell.v);
        cell.t="s"; cell.v=val; cell.w=val; cell.z="@";
        if(val.length>maxLen) maxLen=val.length;
      }
      const wch=Math.max(18, Math.min(40, maxLen+2));
      const cols=ws["!cols"]||[]; while(cols.length<=colIdx) cols.push({});
      cols[colIdx]={ wch, hidden:false }; ws["!cols"]=cols;
    }
    XLSX.writeFile(wb, `inventaire_${from}_au_${to}.xlsx`);
    showToast("Fichier Excel téléchargé ✅");
  }catch(err){ hideLoader(); console.error(err); showToast("Erreur export","error"); }
}

/* =========================================================
   SCANNER LIVE (Tap-to-aim sur OVERLAY)
   ========================================================= */
let _stream=null, _track=null, _caps={};
let _zoomSupported=false;

const ROI_DEFAULT = { x:.10, y:.20, w:.80, h:.60 };
const ROI_MACRO   = { x:.28, y:.32, w:.44, h:.36 };
const ROI_TAP     = { w:.48, h:.34 };

let _roi={...ROI_DEFAULT};
let _roiDyn=null;
let _useMacro=false;
let _noHit=0, _frame=0;

function hasBarcodeDetector(){ return "BarcodeDetector" in window; }
async function ensureZXing(){
  if(window.ZXingBrowser || window.ZXing) return;
  await loadScriptOnce("https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js");
}
async function ensureJsQR(){
  if(window.jsQR) return;
  await loadScriptOnce("https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js");
}

async function ensureCamera(video){
  const constraints={
    audio:false,
    video:{
      facingMode:{ ideal:"environment" },
      width:{ ideal:2560 }, height:{ ideal:1440 },
      frameRate:{ ideal:30, max:30 }
    }
  };
  const s=await navigator.mediaDevices.getUserMedia(constraints);
  _stream=s; video.srcObject=s; await video.play();
  _track=s.getVideoTracks()[0]; _caps=_track.getCapabilities?.()||{};
  _zoomSupported=!!_caps.zoom;
}

function releaseCamera(){ if(_stream){ _stream.getTracks().forEach(t=>t.stop()); } _stream=null; _track=null; }

/* --- Overlay sizing & ROI box drawing --- */
function fitOverlayToVideo(){
  const video=qs("#scannerVideo"), overlay=qs("#scanOverlay");
  if(!video || !overlay) return;
  const rect=video.getBoundingClientRect();
  overlay.style.width=rect.width+"px";
  overlay.style.height=rect.height+"px";
  overlay.style.left=rect.left+"px";
  overlay.style.top=rect.top+"px";
  overlay.style.position="fixed"; /* pour caler précisément au viewport */
}

function updateRoiBox(){
  const video=qs("#scannerVideo"), roiBox=qs("#roiBox");
  if(!video || !roiBox || !video.videoWidth) return;
  const vw=video.videoWidth, vh=video.videoHeight;

  const base=_useMacro?ROI_MACRO:ROI_DEFAULT;
  const r=_roiDyn || base;

  // dimensions du cadre en pixels VIDEO
  const rw=r.w*vw, rh=r.h*vh, rx=r.x*vw, ry=r.y*vh;

  // conversion en pixels ECRAN selon taille affichée
  const rect=video.getBoundingClientRect();
  const sx=rect.width/vw, sy=rect.height/vh;

  const pxw=rw*sx, pxh=rh*sy, pxx=rect.left + rx*sx, pxy=rect.top + ry*sy;

  const overlay=qs("#scanOverlay");
  if(!overlay) return;

  // on place #roiBox à l'intérieur de l'overlay (overlay en fixed aux mêmes coords que la video)
  roiBox.style.width = pxw+"px";
  roiBox.style.height= pxh+"px";
  roiBox.style.transform = `translate(${(pxx - overlay.getBoundingClientRect().left)}px, ${(pxy - overlay.getBoundingClientRect().top)}px)`;
}

/* ripple visuel au tap */
function showTapDot(x,y){
  const overlay=qs("#scanOverlay"); const dot=qs("#tapDot");
  if(!overlay || !dot) return;
  dot.style.left=x+"px"; dot.style.top=y+"px";
  dot.style.opacity="1"; dot.style.transform="translate(-50%,-50%) scale(1)";
  setTimeout(()=>{ dot.style.opacity=".0"; dot.style.transform="translate(-50%,-50%) scale(.6)"; }, 220);
}

/* Tap-to-aim sur l’OVERLAY (calcul en coord. vidéo) */
function installTapToAim(){
  const overlay=qs("#scanOverlay"), video=qs("#scannerVideo");
  if(!overlay || !video) return;

  overlay.addEventListener("click", async (ev)=>{
    if(!video.videoWidth) return;
    const vrect=video.getBoundingClientRect();
    const nx=(ev.clientX - vrect.left)/vrect.width;
    const ny=(ev.clientY - vrect.top )/vrect.height;

    // ROI centrée sur le tap
    let rx=nx - ROI_TAP.w/2, ry=ny - ROI_TAP.h/2;
    rx=Math.max(0, Math.min(1-ROI_TAP.w, rx));
    ry=Math.max(0, Math.min(1-ROI_TAP.h, ry));
    _roiDyn={ x:rx, y:ry, w:ROI_TAP.w, h:ROI_TAP.h };
    _useMacro=true; _noHit=0;

    // feedback visuel
    showTapDot(ev.clientX, ev.clientY);
    updateRoiBox();
  });
}

/* Dessins pixels */
function drawROIFromVideo(video, canvas, roi){
  const vw=video.videoWidth, vh=video.videoHeight;
  if(!vw || !vh) return false;
  const active=_roiDyn || (_useMacro?ROI_MACRO:ROI_DEFAULT);
  const rx=Math.round(active.x*vw), ry=Math.round(active.y*vh);
  const rw=Math.round(active.w*vw), rh=Math.round(active.h*vh);
  canvas.width=rw*2; canvas.height=rh*2;
  const ctx=canvas.getContext("2d",{ willReadFrequently:true });
  ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality="high";
  ctx.drawImage(video, rx,ry,rw,rh, 0,0,rw*2,rh*2);
  return true;
}
function drawFullFromVideo(video, canvas){
  const vw=video.videoWidth, vh=video.videoHeight;
  if(!vw || !vh) return false;
  const max=1280, scale=Math.min(max/vw, max/vh, 1);
  const w=Math.round(vw*scale), h=Math.round(vh*scale);
  canvas.width=w; canvas.height=h;
  const ctx=canvas.getContext("2d",{ willReadFrequently:true });
  ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality="high";
  ctx.drawImage(video, 0,0,w,h);
  return true;
}

/* Décodage */
async function ensureDetectors(){ await Promise.allSettled([ensureZXing(), ensureJsQR()]); }
async function tryDecode(canvas){
  // 1) Natif
  if(hasBarcodeDetector()){
    try{
      const det=new window.BarcodeDetector({ formats:["qr_code","ean_13","code_128","code_39","upc_a","ean_8","upc_e","itf"] });
      const bmp=await createImageBitmap(canvas);
      const arr=await det.detect(bmp);
      if(arr && arr[0]?.rawValue) return { text: arr[0].rawValue, engine:"native" };
    }catch(_) {}
  }
  // 2) ZXing
  try{
    const luminance=new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    const bin=new ZXing.HybridBinarizer(luminance);
    const bmp=new ZXing.BinaryBitmap(bin);
    const reader=new ZXing.MultiFormatReader();
    const hints=new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.QR_CODE, ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.EAN_13,
      ZXing.BarcodeFormat.CODE_39, ZXing.BarcodeFormat.ITF, ZXing.BarcodeFormat.UPC_A,
      ZXing.BarcodeFormat.UPC_E, ZXing.BarcodeFormat.EAN_8
    ]);
    reader.setHints(hints);
    const res=reader.decode(bmp);
    if(res?.getText) return { text: res.getText(), engine:"zxing" };
  }catch(_){}
  // 3) jsQR (QR only)
  try{
    const ctx=canvas.getContext('2d', { willReadFrequently:true });
    const w=canvas.width, h=canvas.height;
    const img=ctx.getImageData(0,0,w,h);
    const qr=window.jsQR && jsQR(img.data, w, h);
    if(qr?.data) return { text: qr.data, engine:"jsqr" };
  }catch(_){}
  return null;
}

let _lastText=""; let _streak=0;
function stableAccept(text){
  if(!text) return null;
  if(text===_lastText) _streak++; else { _lastText=text; _streak=1; }
  if(_streak>=2){ _lastText=""; _streak=0; return text; }
  return null;
}

async function startScanner(){
  const modal=qs("#scannerModal"), video=qs("#scannerVideo");
  const overlay=qs("#scanOverlay"), roiBox=qs("#roiBox"), tapDot=qs("#tapDot");
  if(!modal || !video || !overlay || !roiBox || !tapDot) return;

  modal.style.display="grid";
  _roiDyn=null; _useMacro=false; _noHit=0; _frame=0;

  try{ await ensureCamera(video); }
  catch{ showToast("Caméra refusée (permissions)", "error"); modal.style.display="none"; return; }

  // caler overlay sur la vidéo (et suivre le resize)
  const fit=()=>{ fitOverlayToVideo(); updateRoiBox(); };
  fit();
  const ro = new ResizeObserver(fit); ro.observe(document.body); // suit les rotations/resize viewport
  overlay._ro = ro; // pour cleanup

  installTapToAim();
  await ensureDetectors();

  const roiCanvas=document.createElement("canvas");
  const fullCanvas=document.createElement("canvas");

  const loop = async () => {
    if(!_stream) return;
    _frame++;
    let decoded=null;

    // ROI d'abord
    if(drawROIFromVideo(video, roiCanvas, _roi)){
      decoded = await tryDecode(roiCanvas);
      if(decoded){
        const ok=stableAccept(decoded.text);
        if(ok){ onCodeDetected(ok); closeScanner(); return; }
      } else { _noHit++; }
    }

    // Plein cadre toutes les 8 frames (sécurise)
    if(!decoded && _frame % 8 === 0){
      if(drawFullFromVideo(video, fullCanvas)){
        const res=await tryDecode(fullCanvas);
        if(res){
          const ok=stableAccept(res.text);
          if(ok){ onCodeDetected(ok); closeScanner(); return; }
        } else { _noHit++; }
      }
    }

    // Macro si besoin
    if(!_useMacro && _noHit>28){ _useMacro=true; updateRoiBox(); _noHit=0; }

    // boucle
    if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
      video.requestVideoFrameCallback(()=> setTimeout(loop, 66));
    } else {
      setTimeout(loop, 66);
    }
  };
  loop();
}

function stopScanner(){
  const overlay=qs("#scanOverlay");
  if(overlay && overlay._ro){ overlay._ro.disconnect(); overlay._ro=null; }
  releaseCamera();
  _roiDyn=null; _useMacro=false; _noHit=0; _frame=0; _lastText=""; _streak=0;
}
function closeScanner(){ stopScanner(); const m=qs("#scannerModal"); if(m) m.style.display="none"; }

/* =========================================================
   SCAN PHOTO (identique version stable précédente)
   ========================================================= */
let fileBlob=null;
async function ensureHeic2Any(){ if(window.heic2any) return; await loadScriptOnce("https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js"); }
async function blobToBitmapOrImage(blob){
  try{ return await createImageBitmap(blob, { imageOrientation:'from-image' }); }
  catch{
    const url=URL.createObjectURL(blob);
    const img=await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=url; });
    URL.revokeObjectURL(url); return img;
  }
}
function drawResizedToCanvas(source, maxW=1600, maxH=1600){
  const w0=source.width||source.videoWidth||source.naturalWidth||source.canvas?.width||0;
  const h0=source.height||source.videoHeight||source.naturalHeight||source.canvas?.height||0;
  const ratio=Math.min(maxW/w0, maxH/h0, 1), w=Math.max(1,Math.round(w0*ratio)), h=Math.max(1,Math.round(h0*ratio));
  const c=document.createElement('canvas'); c.width=w; c.height=h; c.getContext('2d',{willReadFrequently:true}).drawImage(source,0,0,w,h); return c;
}
async function onPhotoPicked(ev){
  const file=ev.target.files?.[0]; if(!file){ setStatus("Aucune photo."); return; }
  let blob=file;
  if (/heic|heif/i.test(file.type) || /\.heic$/i.test(file.name)) {
    try{ await ensureHeic2Any(); blob=await heic2any({ blob:file, toType:'image/jpeg', quality:.95 }); }catch{}
  }
  try{
    setStatus("Préparation photo…");
    const src=await blobToBitmapOrImage(blob);
    const base=drawResizedToCanvas(src, 1600,1600);
    showPreview(base); setStatus("Décodage…");
    await ensureDetectors();

    const scales=[1.0, .8, .6, .45], rots=[0,90,180,270];
    for(const s of scales){
      const scaled=drawResizedToCanvas(base, Math.round(base.width*s), Math.round(base.height*s));
      for(const rot of rots){
        const w=(rot%180===0)?scaled.width:scaled.height;
        const h=(rot%180===0)?scaled.height:scaled.width;
        canvasEl.width=w; canvasEl.height=h;
        const ctx=canvasEl.getContext('2d',{willReadFrequently:true});
        ctx.save(); ctx.translate(w/2,h/2); ctx.rotate(rot*Math.PI/180);
        ctx.drawImage(scaled, -scaled.width/2, -scaled.height/2); ctx.restore();

        const r=await tryDecode(canvasEl);
        if(r?.text){ onCodeDetected(r.text); showPreview(canvasEl); setStatus("Code détecté ✅"); return; }
      }
    }
    setStatus("Aucun code détecté. Reprenez une photo (plus proche, nette, bonne lumière).");
  }catch(err){ console.error(err); setStatus("Erreur décodage photo."); showToast("Échec décodage photo","error"); }
  finally{ const input=qs("#photoInput"); if(input) input.value=""; }
}
function showPreview(canvasOrImg){
  let url=null;
  if(canvasOrImg instanceof HTMLCanvasElement){ url=canvasOrImg.toDataURL("image/jpeg", .9); }
  else if(canvasOrImg instanceof HTMLImageElement){
    const c=document.createElement('canvas'); c.width=canvasOrImg.naturalWidth||canvasOrImg.width; c.height=canvasOrImg.naturalHeight||canvasOrImg.height;
    c.getContext('2d').drawImage(canvasOrImg,0,0); url=c.toDataURL("image/jpeg", .9);
  }
  if(url && previewEl){ previewEl.src=url; previewEl.style.display="block"; }
}

/* -------- Envoi backend -------- */
function setApiMsg(msg,isError=false){ const el=qs("#api-msg"); if(!el) return; el.textContent=msg; el.style.color=isError?"#ef4444":"#22c55e"; }
async function onSubmit(e){
  e.preventDefault();
  const code=qs("#code")?.value.trim();
  const from=qs("#from")?.value.trim();
  const to  =qs("#to")?.value.trim();
  const type=qs("#type")?.value;
  const autre=qs("#type_autre")?.value.trim();
  const date=qs("#date_mvt")?.value;
  if(!code || !from || !to || !
