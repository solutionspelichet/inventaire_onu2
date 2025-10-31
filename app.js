/* ====== App Frontend — scanner hybride + HEIC + upload + export ====== */
/* Config backend (Apps Script WebApp) */
const API_BASE = "https://script.google.com/macros/s/AKfycbyy826nPPtVW-HpyUSqzhJ-Eoq42_-rXhYHW3WXi3rT9cZ61dW264c7DDnfagnrXjM7/exec"; // ← adapte si besoin
const APP_VERSION = "2.3.0";

/* ---------- Utils DOM ---------- */
const qs = (s,el=document)=>el.querySelector(s);
const qsa = (s,el=document)=>Array.from(el.querySelectorAll(s));
function loadScriptOnce(src){
  return new Promise((resolve,reject)=>{
    if ([...document.scripts].some(s => s.src && s.src.split('?')[0] === src.split('?')[0])) return resolve();
    const s=document.createElement('script'); s.src=src; s.async=true; s.crossOrigin='anonymous';
    s.onload=()=>resolve(); s.onerror=()=>reject(new Error('Échec chargement: '+src));
    document.head.appendChild(s);
  });
}
const todayISO = new Date().toISOString().slice(0,10);

/* ---------- Thème ---------- */
(function initTheme(){
  const t = localStorage.getItem('theme') || 'light';
  applyTheme(t);
})();
function applyTheme(theme){
  const root=document.documentElement;
  if (theme==='dark') root.setAttribute('data-theme','dark'); else root.removeAttribute('data-theme');
  const sun=qs('#icon-sun'), moon=qs('#icon-moon'), btn=qs('#btn-theme');
  const isDark = theme==='dark'; if (sun) sun.hidden=isDark; if(moon) moon.hidden=!isDark; if(btn) btn.setAttribute('aria-pressed', String(isDark));
  let meta=document.querySelector('meta[name="theme-color"]');
  if(!meta){ meta=document.createElement('meta'); meta.setAttribute('name','theme-color'); document.head.appendChild(meta); }
  meta.setAttribute('content', isDark ? '#121417' : '#f6f8fa');
}
qs('#btn-theme')?.addEventListener('click', ()=>{
  const cur=document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light';
  const nxt=cur==='dark'?'light':'dark';
  localStorage.setItem('theme',nxt); applyTheme(nxt);
});

/* ---------- Status / API msg / Loader / Flash ---------- */
function setStatus(msg){ const el=qs('#status'); if(el) el.textContent=msg; }
function setApiMsg(msg, err=false){ const el=qs('#api-msg'); if(!el) return; el.textContent=msg; el.style.color=err?'#ef4444':'#22c55e'; }
let _loader=0;
function showLoader(msg){ const M=qs('#globalLoader'); if(!M) return; qs('#loaderMsg').textContent=msg||'Chargement…'; M.style.display='flex'; _loader++; }
function hideLoader(){ const M=qs('#globalLoader'); if(!M) return; _loader=Math.max(0,_loader-1); if(!_loader) M.style.display='none'; }
function flash(){ const f=qs('#flash'); if(!f) return; f.classList.remove('active'); void f.offsetWidth; f.classList.add('active'); setTimeout(()=>f.classList.remove('active'),150); }
function vibrate(){ if(navigator.vibrate) navigator.vibrate(120); }
function beep(){ try{ const ctx=new (window.AudioContext||window.webkitAudioContext)(); const o=ctx.createOscillator(); const g=ctx.createGain(); o.type='sine'; o.frequency.value=1000; o.connect(g).connect(ctx.destination); g.gain.value=0.0001; o.start(); g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime+0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+0.18); o.stop(ctx.currentTime+0.2);}catch{} }

/* ---------- Champs par défaut ---------- */
document.addEventListener('DOMContentLoaded', ()=>{
  qs('#date_mvt')?.setAttribute('value', todayISO);
  qs('#export_from')?.setAttribute('value', todayISO);
  qs('#export_to')?.setAttribute('value', todayISO);

  const typeSel=qs('#type'), typeOther=qs('#field-type-autre');
  typeSel?.addEventListener('change', ()=>{ if(typeOther) typeOther.hidden=(typeSel.value!=='Autre'); });

  qs('#btn-capture')?.addEventListener('click', ()=> qs('#photoInput')?.click());
  qs('#photoInput')?.addEventListener('change', onPhotoPicked);

  qs('#btn-scan-live')?.addEventListener('click', startScanner);
  qs('#scannerStop')?.addEventListener('click', stopScanner);
  qs('#scannerClose')?.addEventListener('click', closeScanner);

  qs('#form')?.addEventListener('submit', onSubmit);
  qs('#btn-test')?.addEventListener('click', onTest);

  qs('#btn-download-xls')?.addEventListener('click', onDownloadXls);

  refreshTodayCount();
});

/* ---------- Compteur jour (GET) ---------- */
async function refreshTodayCount(){
  try{
    const r=await fetch(`${API_BASE}?route=/stats&day=${todayISO}`);
    const j=await r.json().catch(()=> ({}));
    const n=(j && j.status===200 && typeof j.data?.count==='number') ? j.data.count : 0;
    qs('#count-today').textContent=String(n);
  }catch{ qs('#count-today').textContent='0'; }
}

/* ---------- Export XLSX ---------- */
async function onDownloadXls(e){
  e.preventDefault();
  const from=qs('#export_from')?.value, to=qs('#export_to')?.value;
  if(!from||!to) return setStatus('Sélectionnez une période complète.');
  if(from>to) return setStatus('La date de début doit précéder la date de fin.');
  try{
    showLoader('Préparation export…');
    const url=`${API_BASE}?route=/export&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const r=await fetch(url); const ct=r.headers.get('content-type')||''; const text=await r.text();
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    if(ct.includes('application/json')){ setStatus(JSON.parse(text).message||'Réponse JSON'); return; }
    if(typeof XLSX==='undefined') throw new Error('Librairie XLSX indisponible');
    const wb=XLSX.read(text,{type:'string',raw:true}); const first=wb.SheetNames[0]; if(first!=='Export'){ wb.Sheets['Export']=wb.Sheets[first]; delete wb.Sheets[first]; const i=wb.SheetNames.indexOf(first); if(i>-1) wb.SheetNames[i]='Export'; }
    const ws=wb.Sheets['Export']; if(ws && ws['!ref']){ const range=XLSX.utils.decode_range(ws['!ref']); const c=2; let max='code_scanné'.length; for(let r=range.s.r+1;r<=range.e.r;r++){ const addr=XLSX.utils.encode_cell({r,c}); const cell=ws[addr]; if(!cell) continue; const v=(cell.v==null)?'':String(cell.v); cell.t='s'; cell.v=v; cell.w=v; cell.z='@'; if(v.length>max) max=v.length; } const wch=Math.max(18,Math.min(40,max+2)); const cols=ws['!cols']||[]; while(cols.length<=c) cols.push({}); cols[c]={wch}; ws['!cols']=cols; }
    XLSX.writeFile(wb, `export_${from}_au_${to}.xlsx`);
    setStatus('Export généré ✅');
  }catch(err){ setStatus('Erreur export : '+(err?.message||err)); }
  finally{ hideLoader(); }
}

/* ---------- Scan hybride (live caméra) ---------- */
let _stream=null, _nativeDetector=null, _loopId=null, _zxingReader=null;

async function ensureZXing(){
  if(window.ZXing) return;
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js');
}
async function ensureQuagga(){
  if(window.Quagga) return;
  const base=location.origin+location.pathname.replace(/\/[^/]*$/,'/');
  await loadScriptOnce(base+'libs/quagga.min.js').catch(()=>{});
}
function hasBarcodeDetector(){ return 'BarcodeDetector' in window; }
async function createBarcodeDetector(){
  if(!hasBarcodeDetector()) throw new Error('BD non supporté');
  try{
    const sup=await window.BarcodeDetector.getSupportedFormats?.(); const wanted=['qr_code','ean_13','code_128','code_39','upc_a','upc_e','ean_8'];
    const fmts=sup?wanted.filter(f=>sup.includes(f)):wanted;
    return new window.BarcodeDetector({formats:fmts});
  }catch{ return new window.BarcodeDetector(); }
}
async function ensureCameraAccess(videoEl){
  const constraints={audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}};
  if(!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia indisponible');
  const s=await navigator.mediaDevices.getUserMedia(constraints);
  _stream=s; videoEl.srcObject=s; videoEl.setAttribute('playsinline','true'); await videoEl.play(); return s;
}
function releaseCamera(){ try{_stream?.getTracks()?.forEach(t=>t.stop());}catch{} _stream=null; }
function startNativeLoop(videoEl,onCode){
  const canvas=document.createElement('canvas'); const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const loop=async()=>{
    const w=videoEl.videoWidth||1280,h=videoEl.videoHeight||720;
    if(!w||!h){ _loopId=requestAnimationFrame(loop); return; }
    canvas.width=w; canvas.height=h; ctx.drawImage(videoEl,0,0,w,h);
    try{
      const det=_nativeDetector; if(det){
        const blob=await new Promise(r=>canvas.toBlob(r,'image/png',0.9));
        const bmp=await createImageBitmap(blob);
        const res=await det.detect(bmp);
        if(res && res[0]?.rawValue){ onCode(String(res[0].rawValue).trim()); return; }
      }
    }catch{}
    _loopId=requestAnimationFrame(loop);
  };
  cancelAnimationFrame(_loopId); _loopId=requestAnimationFrame(loop);
}
function stopNativeLoop(){ try{cancelAnimationFrame(_loopId);}catch{} _loopId=null; _nativeDetector=null; }
function openScanner(){ qs('#scannerModal').style.display='grid'; }
function closeScanner(){ stopScanner(); qs('#scannerModal').style.display='none'; }
function stopScanner(){ stopNativeLoop(); try{ _zxingReader?.reset(); }catch{} _zxingReader=null; releaseCamera(); }
async function startScanner(){
  const video=qs('#scannerVideo'); if(!video){ alert("Zone scanner absente dans l'HTML."); return; }
  openScanner();
  try{ await ensureCameraAccess(video); }catch{ alert("Caméra refusée. Autorisez l'accès appareil photo."); return; }

  // 1) natif
  try{ _nativeDetector=await createBarcodeDetector(); startNativeLoop(video,(code)=>{ if(code){ onCodeDetected(code); closeScanner(); }}); return; }catch{}

  // 2) quagga (self-host)
  try{
    await ensureQuagga();
    if(window.Quagga){
      try{Quagga.stop();}catch{}
      Quagga.init({
        inputStream:{name:'Live',type:'LiveStream',target:video,constraints:{facingMode:'environment'}},
        decoder:{readers:['ean_reader','code_128_reader','code_39_reader']},locate:true,locator:{halfSample:true,patchSize:'medium'}
      },(err)=>{ if(err) throw err; Quagga.start(); });
      Quagga.offDetected?.();
      Quagga.onDetected((res)=>{ const code=res?.codeResult?.code?String(res.codeResult.code).trim():''; if(code){ onCodeDetected(code); closeScanner(); }});
      return;
    }
  }catch{}

  // 3) zxing
  try{
    await ensureZXing();
    _zxingReader=new ZXingBrowser.BrowserMultiFormatReader();
    const devices=await ZXingBrowser.BrowserCodeReader.listVideoInputDevices();
    const back=devices.find(d=>/back|rear|environment/i.test(d.label))?.deviceId||devices[0]?.deviceId;
    await _zxingReader.decodeFromVideoDevice(back, video, (result,err,controls)=>{
      if(result?.getText){ onCodeDetected(String(result.getText()).trim()); controls.stop(); closeScanner(); }
    });
  }catch{ alert("Impossible de démarrer le scan. Utilisez l’upload photo."); }
}
function onCodeDetected(code){
  flash(); vibrate(); beep();
  const input=qs('#code'); if(input){ input.value=code; input.focus(); }
  setStatus('Code détecté : '+code);
}

/* ---------- Décodage via photo (HEIC OK) ---------- */
async function ensureHeic2Any(){
  if(window.heic2any) return;
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js');
}
function readAsDataURL(blob){ return new Promise((ok,ko)=>{ const fr=new FileReader(); fr.onload=()=>ok(fr.result); fr.onerror=ko; fr.readAsDataURL(blob); }); }
function preprocessCanvas(ctx,w,h){
  const img=ctx.getImageData(0,0,w,h), d=img.data, gamma=0.9, contrast=1.15, mid=128;
  for(let i=0;i<d.length;i+=4){ let r=d[i],g=d[i+1],b=d[i+2];
    r=255*Math.pow(r/255,gamma); g=255*Math.pow(g/255,gamma); b=255*Math.pow(b/255,gamma);
    r=(r-mid)*contrast+mid; g=(g-mid)*contrast+mid; b=(b-mid)*contrast+mid;
    d[i]=Math.max(0,Math.min(255,r)); d[i+1]=Math.max(0,Math.min(255,g)); d[i+2]=Math.max(0,Math.min(255,b));
  }
  ctx.putImageData(img,0,0);
}
async function tryBarcodeDetectorOn(canvas){
  if(!hasBarcodeDetector()) return null;
  try{
    const det=await createBarcodeDetector();
    const blob=await new Promise(r=>canvas.toBlob(r,'image/png',0.92));
    const bmp=await createImageBitmap(blob);
    const res=await det.detect(bmp);
    if(res && res[0]?.rawValue) return res[0].rawValue;
  }catch{}
  return null;
}
function tryZXingOn(canvas){
  try{
    const lum=new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    const bin=new ZXing.HybridBinarizer(lum);
    const bmp=new ZXing.BinaryBitmap(bin);
    const reader=new ZXing.MultiFormatReader();
    const hints=new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER,true);
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,[ZXing.BarcodeFormat.QR_CODE,ZXing.BarcodeFormat.CODE_128,ZXing.BarcodeFormat.EAN_13,ZXing.BarcodeFormat.CODE_39,ZXing.BarcodeFormat.ITF,ZXing.BarcodeFormat.UPC_A,ZXing.BarcodeFormat.UPC_E]);
    reader.setHints(hints);
    const res=reader.decode(bmp);
    if(res?.getText) return res.getText();
  }catch{}
  return null;
}
function tryJsQROn(ctx,w,h){
  try{
    const data=ctx.getImageData(0,0,w,h);
    const code=jsQR(data.data,w,h);
    if(code?.data) return code.data;
  }catch{}
  return null;
}
async function onPhotoPicked(ev){
  const file=ev.target.files?.[0];
  if(!file){ qs('#preview').style.display='none'; setStatus('Aucune photo.'); return; }
  setStatus('Décodage en cours…');
  let blob=file;
  if(/image\/heic|image\/heif/i.test(file.type)||/\.heic$/i.test(file.name||'')){
    try{ await ensureHeic2Any(); blob=await heic2any({blob:file,toType:'image/jpeg',quality:0.95}); }catch{}
  }
  let bmp;
  try{ bmp=await createImageBitmap(blob,{imageOrientation:'from-image'}); }
  catch{
    const img=await new Promise((res,rej)=>{const u=URL.createObjectURL(blob); const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=u;});
    const c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight; c.getContext('2d').drawImage(img,0,0); bmp=c;
  }
  const W=bmp.width||bmp.canvas?.width, H=bmp.height||bmp.canvas?.height;
  const canvas=qs('#canvas'); const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const scales=[1.0,0.8,0.6,0.45], rots=[0,90,180,270];
  for(const s of scales){
    for(const r of rots){
      const tw=Math.max(240,Math.round(W*s)); const th=Math.max(240,Math.round(H*s));
      const cw=(r%180===0)?tw:th, ch=(r%180===0)?th:tw;
      canvas.width=cw; canvas.height=ch; ctx.save(); ctx.translate(cw/2,ch/2); ctx.rotate(r*Math.PI/180); ctx.drawImage(bmp,-tw/2,-th/2,tw,th); ctx.restore();
      preprocessCanvas(ctx,cw,ch);
      const n=await tryBarcodeDetectorOn(canvas); if(n){ showPreview(canvas); onCodeDetected(String(n).trim()); ev.target.value=''; return; }
      await ensureZXing(); const zx=tryZXingOn(canvas); if(zx){ showPreview(canvas); onCodeDetected(String(zx).trim()); ev.target.value=''; return; }
      const jq=tryJsQROn(ctx,cw,ch); if(jq){ showPreview(canvas); onCodeDetected(String(jq).trim()); ev.target.value=''; return; }
    }
  }
  showPreview(canvas);
  setStatus('Aucun code détecté. Reprenez la photo (plus net/proche).');
  ev.target.value='';
}
function showPreview(canvas){
  try{ const url=canvas.toDataURL('image/png'); const img=qs('#preview'); img.src=url; img.style.display='block'; }catch{}
}

/* ---------- Envoi au backend ---------- */
async function onSubmit(e){
  e.preventDefault();
  const code=qs('#code')?.value.trim(); const from=qs('#from')?.value.trim(); const to=qs('#to')?.value.trim();
  const type=qs('#type')?.value; const type_autre=qs('#type_autre')?.value?.trim()||''; const date=qs('#date_mvt')?.value;
  if(!code||!from||!to||!type) return setApiMsg('Veuillez remplir tous les champs.', true);

  const form=new URLSearchParams();
  form.set('action','create'); form.set('code_scanné',code); form.set('emplacement_depart',from);
  form.set('emplacement_destination',to); form.set('type_mobilier',type); form.set('type_mobilier_autre', (type==='Autre'?type_autre:''));
  form.set('date_mouvement',date); form.set('source_app_version',APP_VERSION);

  showLoader('Enregistrement…');
  try{
    const r=await fetch(`${API_BASE}?route=/items`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:form.toString()});
    const j=await r.json().catch(()=> ({}));
   if (j && j.status >= 200 && j.status < 300) {
  setApiMsg('Écrit dans Google Sheets ✅');

  const el = qs('#count-today');
  if (el && date === todayISO) {
    const current = parseInt(el.textContent, 10) || 0;
    el.textContent = String(current + 1);
  } else {
    refreshTodayCount();
  }

  resetFormUI();
} else {
  setApiMsg('Erreur API : ' + ((j && j.message) ? j.message : 'inconnue'), true);
}
} catch (err) {
  setApiMsg('Erreur réseau/API', true);
} finally {
  hideLoader();
}

function resetFormUI() {
  const codeEl = qs('#code');
  if (codeEl) codeEl.value = '';

  const type = qs('#type');
  if (type && type.options && type.options.length) {
    type.value = type.options[0].value;
  }

  const wrap = qs('#field-type-autre');
  if (wrap) wrap.hidden = true;

  const other = qs('#type_autre');
  if (other) other.value = '';

  const dateEl = qs('#date_mvt');
  if (dateEl) dateEl.value = todayISO; // plus robuste que setAttribute
}


/* ---------- Bouton test ---------- */
function onTest(){
  if(qs('#code')) qs('#code').value='TEST-1234567890123';
  if(qs('#from') && !qs('#from').value) qs('#from').value='Voie Creuse';
  if(qs('#to') && !qs('#to').value) qs('#to').value='Bibliothèque';
  if(qs('#type') && !qs('#type').value){ qs('#type').value='Bureau'; qs('#type').dispatchEvent(new Event('change')); }
  if(qs('#date_mvt')) qs('#date_mvt').value=todayISO;
  setStatus('Champs de test remplis. Enregistrez pour simuler.');
}
