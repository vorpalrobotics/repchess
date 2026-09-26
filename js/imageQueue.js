/* ---------- image generation: providers, and the background queue ----------
   Documents/image-queue.md is the design.

   Two halves in one module:
   - the PROVIDER layer (moved here from assets.js), which the Generate dialog
     and the queue both call;
   - the QUEUE: jobs persisted in the meta store, run in the background two
     at a time, finished images waiting in a review list until approved into
     assets.

   Only assets.js imports this module (app.js reaches it through assets.js's
   re-exports), so there is exactly one ?v= to keep in step. It does not
   import assets.js back: approving an image needs the asset editor, which
   assets.js hands in through setImageQueueApprover instead -- a circular
   import would need two cache-busters kept identical, or the browser loads
   two copies of the module with separate state. */
import { modalBarHtml, wireModalBar } from './modalBar.js?v=20260804-5';

function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ---------- AI image generation (OpenAI, or Runware's model catalogue) ----------
   A small modal launched from the editor's "Generate…" button: model, API key
   (per provider, kept in localStorage so it's typed once), prompt + standing
   instructions; calls the provider straight from the browser, previews the
   result, and on "Use this image" stages it into the editor exactly like a
   dropped file.

   Two providers, each one self-contained function, so a third (fal.ai was the
   runner-up when this was evaluated) is an entry in GEN_MODELS plus one
   request function:

   - OpenAI over plain fetch -- its images endpoint allows browser calls.
   - Runware over its WebSocket API. A WebSocket handshake is not a CORS
     request, so this works from a static page whether or not Runware's REST
     endpoint sends CORS headers (unverified when this was written).

   Transparency differs per model, and props need it: OpenAI's models and
   FLUX.1 [dev] (LayerDiffuse) produce it natively; every other Runware model
   gets a second removeBackground task on the image it just generated -- by
   the image's UUID, so nothing is uploaded back. */
export const OPENAI_KEY_LS = 'repchess.openaiApiKey';
export const RUNWARE_KEY_LS = 'repchess.runwareApiKey';
export const GEN_MODEL_LS = 'repchess.genModel';
export const GEN_CUSTOM_AIR_LS = 'repchess.genCustomAir';
export const GEN_QUALITY_LS = 'repchess.genQuality';
export const GEN_SIZE_LS = 'repchess.genSize';       // 'square' | 'portrait' | 'landscape'
export const GEN_QUALITY_DEFAULT = 'high';
export const OPENAI_STANDING_LS = 'repchess.genStandingInstructions';
const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';
const RUNWARE_WS_URL = 'wss://ws-api.runware.ai/v1';
const RUNWARE_BG_MODEL = 'runware:110@1';      // Bria RMBG 2.0 -- clean edges on illustrations
const RUNWARE_TASK_TIMEOUT_MS = 180000;

// Size choices are named, and each model maps them to dimensions it accepts:
// OpenAI has three fixed sizes; FLUX-family models want multiples of 64;
// Seedream is a 2K-native model. Unverified sizes surface Runware's own error.
const SIZES_OPENAI   = { square: [1024, 1024], portrait: [1024, 1536], landscape: [1536, 1024] };
const SIZES_64       = { square: [1024, 1024], portrait: [832, 1216],  landscape: [1216, 832] };
const SIZES_SEEDREAM = { square: [2048, 2048], portrait: [1728, 2304], landscape: [2304, 1728] };
// GPT Image 2 takes any size with sides in multiples of 16 and at least ~655k
// pixels, and is billed by size -- 848x848 costs about half of 1024x1024, and
// assets are scaled far below either, so the smallest sizes are the right ones.
const SIZES_GPT2     = { square: [848, 848],   portrait: [704, 1056],  landscape: [1056, 704] };
export const GEN_MODELS = [
  { id: 'openai:gpt-image-1',      group: 'OpenAI',  label: 'GPT Image 1',
    provider: 'openai', model: 'gpt-image-1', sizes: SIZES_OPENAI, alpha: 'native', quality: true },
  { id: 'openai:gpt-image-1-mini', group: 'OpenAI',  label: 'GPT Image 1 mini (cheaper)',
    provider: 'openai', model: 'gpt-image-1-mini', sizes: SIZES_OPENAI, alpha: 'native', quality: true },
  // alpha 'openaiNative': transparency asked of the model itself through
  // Runware's providerSettings.openai, falling back to removeBackground if the
  // provider refuses it (GPT Image 2's transparency was a preview at OpenAI)
  { id: 'runware:gpt-image-2',     group: 'Runware', label: 'GPT Image 2',
    provider: 'runware', air: 'openai:gpt-image@2', sizes: SIZES_GPT2, alpha: 'openaiNative', quality: true },
  // Mini is asked for the same small sizes; whether it takes them is
  // unconfirmed, so a size refusal retries at OpenAI's own fixed sizes
  { id: 'runware:gpt-image-1-mini', group: 'Runware', label: 'GPT Image 1 mini',
    provider: 'runware', air: 'openai:1@2', sizes: SIZES_GPT2, fallbackSizes: SIZES_OPENAI,
    alpha: 'openaiNative', quality: true },
  { id: 'runware:flux1-schnell',   group: 'Runware', label: 'FLUX.1 schnell (fastest, cheapest)',
    provider: 'runware', air: 'runware:100@1', sizes: SIZES_64, alpha: 'remove' },
  { id: 'runware:flux1-dev',       group: 'Runware', label: 'FLUX.1 dev',
    provider: 'runware', air: 'runware:101@1', sizes: SIZES_64, alpha: 'layerDiffuse' },
  { id: 'runware:flux2-dev',       group: 'Runware', label: 'FLUX.2 dev',
    provider: 'runware', air: 'runware:400@1', sizes: SIZES_64, alpha: 'remove' },
  { id: 'runware:seedream4',       group: 'Runware', label: 'Seedream 4.0',
    provider: 'runware', air: 'bytedance:5@0', sizes: SIZES_SEEDREAM, alpha: 'remove' },
  { id: 'runware:ideogram3',       group: 'Runware', label: 'Ideogram 3.0 (good with text)',
    provider: 'runware', air: 'ideogram:4@1', sizes: SIZES_64, alpha: 'remove' },
  { id: 'runware:custom',          group: 'Runware', label: 'Other Runware model (enter its ID)…',
    provider: 'runware', custom: true, sizes: SIZES_64, alpha: 'remove' },
];
export const GEN_PROVIDERS = {
  openai:  { name: 'OpenAI',  keyLs: OPENAI_KEY_LS,  placeholder: 'sk-…' },
  runware: { name: 'Runware', keyLs: RUNWARE_KEY_LS, placeholder: 'Runware API key' },
};
export function genModelById(id){ return GEN_MODELS.find(m => m.id === id) || GEN_MODELS[0]; }
export function lsGet(k){ try { return localStorage.getItem(k) || ''; } catch(_){ return ''; } }
export function lsSet(k, v){ try { localStorage.setItem(k, v); } catch(_){} }

/* OpenAI: one fetch, image back as base64. */
export async function generateOpenAI(key, spec, prompt, [w, h], transparent, quality){
  const body = { model: spec.model, prompt, n: 1, size: `${w}x${h}` };
  if(quality) body.quality = quality;
  if(transparent) body.background = 'transparent';   // png cutout, ideal for props
  const res = await fetch(OPENAI_IMAGES_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if(!res.ok) throw new Error((json && json.error && json.error.message) || ('HTTP ' + res.status));
  const b64 = json.data && json.data[0] && json.data[0].b64_json;
  if(!b64) throw new Error('No image returned.');
  return { dataUrl: 'data:image/png;base64,' + b64, cost: null };
}

/* A Runware WebSocket session: authenticate once, then run tasks one at a time
   (the background removal needs the generated image's UUID, so they cannot
   go in one batch). Messages are JSON; results arrive as { data: [...] } and
   failures as { errors: [...] } -- matched to their task by taskUUID. */
function runwareSession(key){
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(RUNWARE_WS_URL); } catch(err){ reject(err); return; }
    const pending = new Map();   // taskUUID -> { resolve, reject, timer }
    let authed = false;
    const failAll = (err) => {
      if(!authed){ authed = true; reject(err); }
      for(const p of pending.values()){ clearTimeout(p.timer); p.reject(err); }
      pending.clear();
    };
    const errText = (e) => (e && (e.message || e.errorMessage || e.code)) || 'Runware error';
    ws.onopen = () => ws.send(JSON.stringify([{ taskType: 'authentication', apiKey: key }]));
    ws.onerror = () => failAll(new Error('Could not reach Runware (network?)'));
    ws.onclose = () => failAll(new Error('Runware closed the connection'));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch(_){ return; }
      const errors = msg.errors || (msg.error ? [msg] : []);
      for(const e of errors){
        const p = e.taskUUID && pending.get(e.taskUUID);
        if(p){ clearTimeout(p.timer); pending.delete(e.taskUUID); p.reject(new Error(errText(e))); }
        else if(!authed){ authed = true; reject(new Error(errText(e))); try { ws.close(); } catch(_){} }
      }
      for(const d of (msg.data || [])){
        if(d.taskType === 'authentication'){
          if(!authed){ authed = true; resolve(session); }
          continue;
        }
        const p = d.taskUUID && pending.get(d.taskUUID);
        if(p){ clearTimeout(p.timer); pending.delete(d.taskUUID); p.resolve(d); }
      }
    };
    const session = {
      run(task){
        return new Promise((res, rej) => {
          const taskUUID = crypto.randomUUID();
          const timer = setTimeout(() => {
            pending.delete(taskUUID);
            rej(new Error('Runware took too long to answer'));
          }, RUNWARE_TASK_TIMEOUT_MS);
          pending.set(taskUUID, { resolve: res, reject: rej, timer });
          ws.send(JSON.stringify([{ ...task, taskUUID }]));
        });
      },
      close(){ ws.onclose = null; try { ws.close(); } catch(_){} },
    };
  });
}
function runwareImageDataUrl(d){
  if(d.imageDataURI) return d.imageDataURI;
  if(d.imageBase64Data) return 'data:image/png;base64,' + d.imageBase64Data;
  return null;
}
export async function generateRunware(key, spec, prompt, [w, h], transparent, onStatus, quality, sizeName){
  const session = await runwareSession(key);
  try {
    const task = { taskType: 'imageInference', model: spec.air, positivePrompt: prompt,
                   width: w, height: h, numberResults: 1,
                   outputType: 'base64Data', outputFormat: 'PNG', includeCost: true };
    let native = transparent && (spec.alpha === 'layerDiffuse' || spec.alpha === 'openaiNative');
    if(native && spec.alpha === 'layerDiffuse') task.advancedFeatures = { layerDiffuse: true };
    // OpenAI's own settings travel in providerSettings.openai
    if(spec.alpha === 'openaiNative' || (spec.quality && quality)){
      const openai = {};
      if(spec.quality && quality) openai.quality = quality;
      if(native && spec.alpha === 'openaiNative') openai.background = 'transparent';
      task.providerSettings = { openai };
    }
    let img, note = '';
    // One retry at the model's fallback size if the first size is refused --
    // for models whose accepted sizes could not be confirmed up front.
    const runSized = async () => {
      try {
        return await session.run(task);
      } catch(err){
        const fb = spec.fallbackSizes && spec.fallbackSizes[sizeName];
        if(!fb || !/width|height|dimension|size|resolution/i.test((err && err.message) || '')) throw err;
        console.warn('[assets] size refused, retrying at', fb, err);
        [task.width, task.height] = fb;
        note += ` (${w}×${h} was refused, so this is ${fb[0]}×${fb[1]}.)`;
        return await session.run(task);
      }
    };
    try {
      img = await runSized();
    } catch(err){
      // The provider refused native transparency: generate opaque instead and
      // let the removeBackground step below cut it out.
      const bgRefused = native && spec.alpha === 'openaiNative'
        && /background|transparen|providerSettings/i.test((err && err.message) || '');
      if(!bgRefused) throw err;
      console.warn('[assets] native transparency refused, falling back to removeBackground', err);
      delete task.providerSettings.openai.background;
      native = false;
      note += ' (Native transparency was refused.)';
      img = await runSized();
    }
    let dataUrl = runwareImageDataUrl(img);
    if(!dataUrl) throw new Error('No image returned.');
    let cost = typeof img.cost === 'number' ? img.cost : null;
    if(transparent && !native){
      onStatus && onStatus('Removing the background…');
      /* The generated image's UUID is the cheap way to point at it (nothing is
         sent back up), but Runware does not always accept it: in real use a
         second generation in the same dialog was refused with "Invalid value
         for 'inputImage'" -- plausibly because a base64Data result is not
         kept server-side, or not yet. So fall back to sending the image
         itself, as a data URI and then as bare base64, both of which that
         error lists as accepted. */
      const b64 = dataUrl.replace(/^data:[^,]*,/, '');
      const inputs = [img.imageUUID, dataUrl, b64].filter(Boolean);
      let cut = null, lastErr = null;
      for(const inputImage of inputs){
        try {
          const bg = await session.run({ taskType: 'removeBackground', model: RUNWARE_BG_MODEL,
            inputImage, outputType: 'base64Data', outputFormat: 'PNG', includeCost: true });
          cut = runwareImageDataUrl(bg);
          if(!cut){ lastErr = new Error('Background removal returned no image.'); continue; }
          if(typeof bg.cost === 'number') cost = (cost || 0) + bg.cost;
          break;
        } catch(err){
          lastErr = err;
          console.warn('[assets] removeBackground refused input', inputImage === img.imageUUID ? 'uuid' : inputImage === dataUrl ? 'dataURI' : 'base64', err);
        }
      }
      if(cut){
        dataUrl = cut;
        note += ' Background removed as a second step.';
      } else {
        // The generation succeeded and has been paid for: keep it, with its
        // background, rather than throwing it away over the second step.
        note += ` Background removal failed (${(lastErr && lastErr.message) || 'unknown error'}), so this still has`
          + ' its background -- Crop/Erase BG can remove it, or generate again.';
      }
    }
    return { dataUrl, cost, note };
  } finally {
    session.close();
  }
}


/* ================= the queue ================= */

/* Storage: the job list (no images) under one meta key, each finished image
   under its own key -- rewriting a list of megabyte data-URLs on every status
   change would be the whole cost of the feature. The meta store is exactly
   the right home: clearAllData() empties it on every restore, which is the
   agreed behaviour (unreviewed images are not backed up, and a restore
   discards them), and app.js lists the key in BACKUP_EXCLUDED_META. */
const IMAGE_QUEUE_KEY = 'imageQueue';
const IMAGE_QUEUE_IMG_PREFIX = 'imageQueueImg:';
const IMAGE_QUEUE_SPENT_LS = 'repchess.imageQueueSpent';
const IQ_CONCURRENCY = 2;
const IQ_POLL_MS = 30000;        // re-check for newly entered API keys
// worth one automatic retry; anything else (a refused key, an invalid
// parameter) fails straight away rather than being charged for twice
const IQ_TRANSIENT_RE = /could not reach|closed the connection|took too long|failed to fetch|network|timeout|HTTP 5\d\d|HTTP 429|rate limit|overloaded/i;

let JOBS = null;                 // in-memory mirror of the stored list
let jobsLoading = null;
let QUEUE_GEN = 0;               // bumped by a restore, so in-flight jobs from before it are dropped
const running = new Set();
let saveChain = Promise.resolve();
let approver = null;

function loadJobs(){
  if(JOBS) return Promise.resolve(JOBS);
  if(!jobsLoading){
    jobsLoading = (async () => {
      let arr = [];
      try { arr = JSON.parse(await getMeta(IMAGE_QUEUE_KEY) || '[]'); } catch(_){ arr = []; }
      if(!Array.isArray(arr)) arr = [];
      // a job the last tab was running when it closed never finished: run it again
      for(const j of arr) if(j.status === 'running') j.status = 'queued';
      JOBS = arr;
      jobsLoading = null;
      return JOBS;
    })();
  }
  return jobsLoading;
}
function saveJobs(){
  const snapshot = JSON.stringify(JOBS || []);
  saveChain = saveChain.then(() => setMeta(IMAGE_QUEUE_KEY, snapshot))
    .catch(err => console.error('[imageQueue] save failed', err));
  return saveChain;
}
export function imageQueueCounts(){
  const c = { queued: 0, running: 0, failed: 0, review: 0 };
  for(const j of (JOBS || [])) if(c[j.status] !== undefined) c[j.status]++;
  return c;
}
function emit(){
  window.dispatchEvent(new CustomEvent('imagequeue:change', { detail: imageQueueCounts() }));
  if(iqOverlayOpen()) renderImageQueue();
}
function spentTotal(){ return parseFloat(lsGet(IMAGE_QUEUE_SPENT_LS)) || 0; }
function addSpent(cost){ if(typeof cost === 'number' && cost > 0) lsSet(IMAGE_QUEUE_SPENT_LS, String(spentTotal() + cost)); }

/* draft: { prompt, standing, model, customAir, quality, size, transparent,
            asset: { id, type, keywords, resolution }, target } */
export async function enqueueImageJob(draft){
  await loadJobs();
  const job = {
    id: crypto.randomUUID(), createdAt: Date.now(), status: 'queued', attempts: 0,
    prompt: draft.prompt, standing: draft.standing || '',
    model: draft.model, customAir: draft.customAir || '',
    quality: draft.quality || null, size: draft.size || 'square', transparent: !!draft.transparent,
    asset: { id: '', type: 'billboard-cylindrical', keywords: '', resolution: '', ...(draft.asset || {}) },
    target: draft.target || { kind: 'asset' },
    cost: null, note: '', error: null,
  };
  JOBS.push(job);
  await saveJobs();
  emit();
  pumpImageQueue();
  return job.id;
}

function findJob(id){ return (JOBS || []).find(j => j.id === id) || null; }

export async function pumpImageQueue(){
  await loadJobs();
  let changed = false;
  for(const job of JOBS){
    if(running.size >= IQ_CONCURRENCY) break;
    if(job.status !== 'queued' || running.has(job.id)) continue;
    const spec = genModelById(job.model);
    const key = lsGet(GEN_PROVIDERS[spec.provider].keyLs);
    const waiting = !key;
    if(!!job.waitingForKey !== waiting){ job.waitingForKey = waiting; changed = true; }
    if(waiting) continue;       // the queue waits for the key rather than failing every job
    runJob(job, key);
  }
  if(changed){ saveJobs(); emit(); }
}

async function runJob(job, key){
  const gen = QUEUE_GEN;
  running.add(job.id);
  job.status = 'running';
  job.error = null;
  saveJobs();
  emit();
  try {
    const spec = { ...genModelById(job.model) };
    if(spec.custom) spec.air = job.customAir;
    const sizeName = spec.sizes[job.size] ? job.size : 'square';
    const dims = spec.sizes[sizeName];
    const prompt = job.standing ? `${job.prompt}\n\n${job.standing}` : job.prompt;
    const quality = spec.quality ? (job.quality || GEN_QUALITY_DEFAULT) : null;
    const out = spec.provider === 'openai'
      ? await generateOpenAI(key, spec, prompt, dims, job.transparent, quality)
      : await generateRunware(key, spec, prompt, dims, job.transparent, null, quality, sizeName);
    // a restore since this started, or the job was removed while it ran
    if(gen !== QUEUE_GEN || !findJob(job.id)) return;
    await setMeta(IMAGE_QUEUE_IMG_PREFIX + job.id, out.dataUrl);
    job.status = 'review';
    job.cost = typeof out.cost === 'number' ? out.cost : null;
    job.note = out.note || '';
    job.finishedAt = Date.now();
    addSpent(job.cost);
  } catch(err){
    if(gen !== QUEUE_GEN || !findJob(job.id)) return;
    const msg = (err && err.message) || String(err);
    job.attempts = (job.attempts || 0) + 1;
    if(job.attempts < 2 && IQ_TRANSIENT_RE.test(msg)){
      console.warn('[imageQueue] transient failure, retrying once', msg);
      job.status = 'queued';
    } else {
      job.status = 'failed';
      job.error = msg;
    }
  } finally {
    running.delete(job.id);
    if(gen === QUEUE_GEN){
      saveJobs();
      emit();
      setTimeout(pumpImageQueue, 0);
    }
  }
}

export async function retryImageJob(id){
  await loadJobs();
  const job = findJob(id);
  if(!job || job.status !== 'failed') return;
  Object.assign(job, { status: 'queued', attempts: 0, error: null });
  await saveJobs(); emit(); pumpImageQueue();
}
// back to the queue with the same settings -- and optionally a new prompt
export async function redoImageJob(id, prompt){
  await loadJobs();
  const job = findJob(id);
  if(!job || job.status !== 'review') return;
  if(prompt && prompt.trim()) job.prompt = prompt.trim();
  try { await deleteMeta(IMAGE_QUEUE_IMG_PREFIX + id); } catch(_){}
  Object.assign(job, { status: 'queued', attempts: 0, error: null, cost: null, note: '' });
  await saveJobs(); emit(); pumpImageQueue();
}
export async function removeImageJob(id){
  await loadJobs();
  const i = JOBS.findIndex(j => j.id === id);
  if(i < 0) return;
  JOBS.splice(i, 1);          // a running job's result is dropped when it lands (see runJob)
  try { await deleteMeta(IMAGE_QUEUE_IMG_PREFIX + id); } catch(_){}
  await saveJobs(); emit();
}
export async function getImageJobImage(id){
  try { return await getMeta(IMAGE_QUEUE_IMG_PREFIX + id); } catch(_){ return null; }
}
/* A restore just emptied the meta store: forget the in-memory list too, and
   orphan anything still running so its result is not written back into the
   restored database. */
export function resetImageQueue(){
  QUEUE_GEN++;
  JOBS = [];
  running.clear();
  emit();
}
// (job, imageDataUrl) => Promise<savedAssetId|null> -- supplied by assets.js
export function setImageQueueApprover(fn){ approver = fn; }

async function approveImageJob(id){
  const job = findJob(id);
  if(!job || !approver) return;
  const image = await getImageJobImage(id);
  if(!image) return;
  const saved = await approver(job, image);
  if(saved) await removeImageJob(id);
}

/* ---------- the Image Queue modal ---------- */
let iqTab = 'queue';
let iqRedoId = null;       // the review card whose prompt is being edited for a redo
function iqOverlayOpen(){
  const ov = document.getElementById('imageQueueOverlay');
  return !!(ov && ov.style.display === 'flex');
}
export async function openImageQueue(tab){
  await loadJobs();
  let ov = document.getElementById('imageQueueOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'imageQueueOverlay';
    ov.className = 'overlay';
    // above the main page's own overlays (20); below the New Asset modal
    // (162) that Approve opens on top of it
    ov.style.zIndex = '40';
    ov.innerHTML = `
      <div class="modal" style="width:min(46em,94vw);max-height:90vh;display:flex;flex-direction:column">
        <div id="imageQueueBar" class="modal-bar-host">${modalBarHtml({ title: 'Image Queue', prefix: 'iq' })}</div>
        <div class="modal-body">
          <div class="iq-head">
            <div class="iq-tabs">
              <button type="button" class="iq-tab" data-tab="queue">Queue <span id="iqQueueCount"></span></button>
              <button type="button" class="iq-tab" data-tab="review">Review <span id="iqReviewCount"></span></button>
            </div>
            <span class="iq-spent" id="iqSpent"></span>
          </div>
          <div id="iqBody"></div>
        </div>
      </div>`;
    document.body.appendChild(ov);
    wireModalBar(ov.querySelector('.modal-bar'), { onLeave: () => { ov.style.display = 'none'; iqRedoId = null; } });
    ov.querySelectorAll('.iq-tab').forEach(b => b.onclick = () => { iqTab = b.dataset.tab; iqRedoId = null; renderImageQueue(); });
    ov.addEventListener('click', onIqClick);
  }
  if(tab) iqTab = tab;
  else if(imageQueueCounts().review) iqTab = 'review';   // what is waiting on you comes first
  ov.style.display = 'flex';
  renderImageQueue();
  pumpImageQueue();
}

function iqMeta(job){
  const spec = genModelById(job.model);
  const bits = [job.asset.id || '(no ID yet)', spec.custom ? job.customAir : spec.label];
  if(spec.quality && job.quality) bits.push(job.quality);
  bits.push(job.size);
  return bits.map(esc).join(' · ');
}
function iqStatus(job){
  if(job.status === 'running') return '<span class="iq-st iq-st-run">Generating…</span>';
  if(job.status === 'failed') return `<span class="iq-st iq-st-fail">Failed: ${esc(job.error || 'unknown error')}</span>`;
  if(job.waitingForKey){
    const prov = GEN_PROVIDERS[genModelById(job.model).provider];
    return `<span class="iq-st iq-st-wait">Waiting for your ${esc(prov.name)} API key (enter it in the Generate dialog)</span>`;
  }
  return '<span class="iq-st">Queued</span>';
}
function renderImageQueue(){
  const ov = document.getElementById('imageQueueOverlay');
  if(!ov) return;
  const c = imageQueueCounts();
  const pending = c.queued + c.running + c.failed;
  ov.querySelector('#iqQueueCount').textContent = pending ? `(${pending})` : '';
  ov.querySelector('#iqReviewCount').textContent = c.review ? `(${c.review})` : '';
  ov.querySelectorAll('.iq-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === iqTab));
  const spent = spentTotal();
  ov.querySelector('#iqSpent').innerHTML = spent
    ? `Spent so far: $${spent.toFixed(4)} <button type="button" class="iq-link" data-act="reset-spent">reset</button>` : '';
  const body = ov.querySelector('#iqBody');
  if(iqRedoId && findJob(iqRedoId) && iqTab === 'review') return;   // don't wipe a prompt being edited
  if(iqTab === 'queue'){
    const jobs = JOBS.filter(j => j.status !== 'review');
    body.innerHTML = jobs.length ? jobs.map(j => `
      <div class="iq-row" data-id="${esc(j.id)}">
        <div class="iq-row-main">
          <div class="iq-prompt">${esc(j.prompt)}</div>
          <div class="iq-meta">${iqMeta(j)}</div>
          <div>${iqStatus(j)}</div>
        </div>
        <div class="iq-actions">
          ${j.status === 'failed' ? '<button type="button" data-act="retry">Retry</button>' : ''}
          <button type="button" data-act="remove">Remove</button>
        </div>
      </div>`).join('')
      : `<p class="iq-empty">Nothing waiting to be generated. In VR Assets, open New Asset &rarr;
         Generate&hellip; and use <strong>Add to queue</strong>.</p>`;
  } else {
    const jobs = JOBS.filter(j => j.status === 'review');
    body.innerHTML = jobs.length ? jobs.map(j => `
      <div class="iq-card" data-id="${esc(j.id)}">
        <div class="iq-thumb"><img alt="" data-img="${esc(j.id)}"></div>
        <div class="iq-card-info">
          <div class="iq-prompt">${esc(j.prompt)}</div>
          <div class="iq-meta">${iqMeta(j)}${typeof j.cost === 'number' ? ` · $${j.cost.toFixed(4)}` : ''}</div>
          ${j.note ? `<div class="iq-note">${esc(j.note.trim())}</div>` : ''}
          <div class="iq-actions">
            <button type="button" data-act="approve">Approve…</button>
            <button type="button" data-act="redo">Redo…</button>
            <button type="button" data-act="discard">Discard</button>
          </div>
        </div>
      </div>`).join('')
      : '<p class="iq-empty">No images waiting for review.</p>';
    for(const img of body.querySelectorAll('img[data-img]')){
      getImageJobImage(img.dataset.img).then(src => { if(src) img.src = src; });
    }
  }
}
async function onIqClick(e){
  const btn = e.target.closest('button[data-act]');
  if(!btn) return;
  const act = btn.dataset.act;
  if(act === 'reset-spent'){ lsSet(IMAGE_QUEUE_SPENT_LS, '0'); renderImageQueue(); return; }
  const card = btn.closest('[data-id]');
  const id = card && card.dataset.id;
  if(!id) return;
  if(act === 'retry') return retryImageJob(id);
  if(act === 'remove' || act === 'discard') return removeImageJob(id);
  if(act === 'approve') return approveImageJob(id);
  if(act === 'redo'){
    const job = findJob(id);
    if(!job) return;
    iqRedoId = id;
    const promptEl = card.querySelector('.iq-prompt');
    promptEl.innerHTML = `<textarea class="iq-redo-text" rows="3">${esc(job.prompt)}</textarea>
      <div class="iq-actions"><button type="button" data-act="redo-go">Queue again</button>
      <button type="button" data-act="redo-cancel">Cancel</button></div>`;
    promptEl.querySelector('textarea').focus();
    return;
  }
  if(act === 'redo-go'){
    const text = card.querySelector('.iq-redo-text').value;
    iqRedoId = null;
    return redoImageJob(id, text);
  }
  if(act === 'redo-cancel'){ iqRedoId = null; renderImageQueue(); }
}

// resume whatever an earlier visit left queued, once the page has settled,
// and keep checking for an API key that has since been entered
setTimeout(pumpImageQueue, 1500);
setInterval(pumpImageQueue, IQ_POLL_MS);

if(localStorage.getItem('threeTestDebug')) window.__imageQueueTestHooks = {
  jobs: async () => (await loadJobs()).map(j => ({ ...j })),
  pump: () => pumpImageQueue(),
  enqueue: (draft) => enqueueImageJob(draft),
  open: (tab) => openImageQueue(tab),
  counts: () => imageQueueCounts(),
  running: () => running.size,
};
