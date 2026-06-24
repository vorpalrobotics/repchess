/* ---------- Asset Manager ----------
   Staging registry for three.js art assets (PNG + JSON pairs) — see
   Documents/three-assets.md for the authoritative file-pair schema this
   mirrors. Assets live in IndexedDB (the 'assets' store, see js/db.js)
   while being authored; "Export" turns each one into a real
   <id>.png + <id>.json download pair to commit under assets/three/.

   This module owns its own DOM (built once into the container element
   handed to openAssetManager, same pattern as js/threeTest.js) so it
   never needs to reach into app.js's module scope.
*/

const ASSET_TYPES = {
  'box':                   { label: 'Prop: Box',                      kind: 'prop' },
  'billboard-cylindrical': { label: 'Prop: Billboard (cylindrical)',  kind: 'prop' },
  'billboard-sprite':      { label: 'Prop: Billboard (sprite)',       kind: 'prop' },
  'surface':               { label: 'Surface (floor / wall texture)', kind: 'surface' },
  'facade':                { label: 'Surface: Facade (large, non-tiled)', kind: 'facade' },
};

/* ---------- import resolution ----------
   Uploaded PNGs are down-converted on import so we never carry more pixels
   than a room-scale (~10m) demo can show. The user picks a tier (Low/Normal/
   High); the tier + the asset's category pick the actual long-edge pixel cap.
   Aspect ratio is always preserved (fit within a maxDim box, never cropped or
   squashed), so a 2.5:1 facade at the 2048 cap becomes 2048x819. 4096 is the
   hard ceiling — the WebGL2 max-texture-size guaranteed safe on ~all hardware.

   Categories:
     tiled  — surfaces repeat across a wall, so detail-per-tile is enough → least
     object — props/billboards, viewed at object scale (1-3m) in the room
     large  — facades: one-shot texture spanning a whole building, up to ~50m
*/
const RESOLUTION_TIERS = ['low', 'normal', 'high'];
const RESOLUTION_DEFAULT = 'normal';
const RESOLUTION_CAPS = {
  tiled:  { low: 256,  normal: 512,  high: 1024 },
  object: { low: 256,  normal: 512,  high: 1024 },
  large:  { low: 1024, normal: 2048, high: 4096 },
};
function resolutionCategory(type){
  if(type === 'facade')  return 'large';
  if(type === 'surface') return 'tiled';
  return 'object';                       // box, billboard-cylindrical, billboard-sprite
}
function resolutionCap(type, tier){
  const cat = RESOLUTION_CAPS[resolutionCategory(type)] || RESOLUTION_CAPS.object;
  return cat[tier] || cat[RESOLUTION_DEFAULT];
}

const IMG_MAX_FILE_BYTES = 15 * 1024 * 1024;
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/* auto-crop: a pixel counts as "content" when its alpha is strictly above this.
   0 means any non-fully-transparent pixel keeps its row/column — the literal
   "smallest box with no all-transparent edges". Bump it if GPT exports leave a
   faint near-transparent halo you also want trimmed. */
const AUTO_CROP_ALPHA = 0;

let containerEl = null;
let ASSETS = [];          // cached array of all asset records
let EDIT_ID = null;       // id of the asset currently open in the editor, or null = creating new
let EDIT_IMAGE = '';      // staged (down-converted) data-URL for the editor — this is what gets saved
let EDIT_IMAGE_ORIG = ''; // full-res data-URL of a fresh upload, kept in memory only so changing the
                          // tier/type re-derives EDIT_IMAGE without re-reading the file. '' when editing
                          // an existing asset (we can't recover pixels already discarded on import).
let EDIT_RESOLUTION = RESOLUTION_DEFAULT;
let EDIT_IMG_W = 0;       // intrinsic px width/height of the staged image — the source of the
let EDIT_IMG_H = 0;       // aspect ratio shown in the note and used by the size lock
let SIZE_LOCK = true;     // when on, editing width (m) auto-sets height (m) to match the
                          // image's pixel aspect ratio, and vice versa. Depth stays manual.
let FILTER_TYPE = 'all';

function $(id){ return containerEl.querySelector(`#${id}`); }
function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

export async function openAssetManager(container){
  containerEl = container;
  if(!containerEl.dataset.built){
    buildShell();
    containerEl.dataset.built = '1';
  }
  showList();
  await refreshGrid();
}

export function closeAssetManager(){
  // no running loop / listeners outside containerEl to tear down
}

/* ---------- shell ---------- */
function buildShell(){
  containerEl.innerHTML = `
    <div class="assets-toolbar">
      <select id="assetsFilterType">
        <option value="all">All types</option>
        ${Object.entries(ASSET_TYPES).map(([t,info]) => `<option value="${t}">${esc(info.label)}</option>`).join('')}
      </select>
      <span class="assets-count" id="assetsCount"></span>
      <span class="assets-spacer"></span>
      <button id="assetsNewBtn"><i class="fa-solid fa-plus"></i> New Asset</button>
      <button id="assetsExportBtn"><i class="fa-solid fa-file-export"></i> Export All as Files</button>
    </div>
    <div class="assets-body">
      <div class="assets-grid" id="assetsGrid"></div>
      <div class="assets-editor" id="assetsEditor" style="display:none"></div>
    </div>
  `;
  $('assetsFilterType').onchange = e => { FILTER_TYPE = e.target.value; renderGrid(); };
  $('assetsNewBtn').onclick = () => openEditor(null);
  $('assetsExportBtn').onclick = exportAllAsFiles;
}

function showList(){
  $('assetsGrid').style.display = '';
  $('assetsEditor').style.display = 'none';
}

async function refreshGrid(){
  ASSETS = await getAllAssets();
  renderGrid();
}

function renderGrid(){
  const grid = $('assetsGrid');
  const visible = FILTER_TYPE === 'all' ? ASSETS : ASSETS.filter(a => a.type === FILTER_TYPE);
  $('assetsCount').textContent = `${visible.length} asset${visible.length===1?'':'s'}`;
  if(!visible.length){
    grid.innerHTML = '<p class="assets-empty">No assets yet. Click "New Asset" to upload one.</p>';
    return;
  }
  grid.innerHTML = '';
  for(const a of visible.sort((x,y) => x.id.localeCompare(y.id))){
    const card = document.createElement('div');
    card.className = 'asset-card';
    card.innerHTML = `
      <div class="asset-thumb">${a.image ? `<img src="${a.image}" alt="">` : ''}</div>
      <div class="asset-id">${esc(a.id)}</div>
      <div class="asset-type">${esc((ASSET_TYPES[a.type]||{}).label || a.type)}</div>
    `;
    card.onclick = () => openEditor(a.id);
    grid.appendChild(card);
  }
}

/* ---------- editor ---------- */
function openEditor(id){
  EDIT_ID = id;
  const a = id ? ASSETS.find(x => x.id === id) : null;
  EDIT_IMAGE = (a && a.image) || '';
  EDIT_IMAGE_ORIG = '';                 // no original until a fresh upload this session
  EDIT_RESOLUTION = (a && a.resolution) || RESOLUTION_DEFAULT;
  EDIT_IMG_W = EDIT_IMG_H = 0;
  renderEditor(a);
  $('assetsGrid').style.display = 'none';
  $('assetsEditor').style.display = '';
  updateImgInfo();   // measure the staged image → fills the dims note (no size snap on open)
}

function renderEditor(a){
  const type = (a && a.type) || 'box';
  const editor = $('assetsEditor');
  editor.innerHTML = `
    <div class="field">
      <label>Asset id (filename, lowercase-with-dashes)</label>
      <input type="text" id="assetIdInput" placeholder="grandfather-clock-style-1" value="${esc((a && a.id) || '')}" ${a ? 'disabled' : ''}>
    </div>
    <div class="field">
      <label>Type</label>
      <select id="assetTypeInput">
        ${Object.entries(ASSET_TYPES).map(([t,info]) => `<option value="${t}" ${t===type?'selected':''}>${esc(info.label)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>Resolution (down-converted on import)</label>
      <select id="assetResolution">
        ${RESOLUTION_TIERS.map(t => `<option value="${t}" ${t===EDIT_RESOLUTION?'selected':''}>${t[0].toUpperCase()+t.slice(1)}</option>`).join('')}
      </select>
      <span class="assets-res-hint" id="assetResHint"></span>
    </div>
    <div class="field">
      <label>Image (PNG, transparent background for props)</label>
      <div class="asset-img-row">
        <div class="asset-img-drop" id="assetImgDrop">
          ${EDIT_IMAGE ? `<img id="assetImgPreview" src="${EDIT_IMAGE}">` : '<i class="fa-solid fa-image"></i>'}
        </div>
        <div class="asset-img-side">
          <div class="asset-img-info" id="assetImgInfo"></div>
          <div class="asset-img-tools">
            <button type="button" id="assetAutoCropBtn"><i class="fa-solid fa-crop-simple"></i> Auto-crop transparent edges</button>
            <span class="assets-res-hint" id="assetCropHint"></span>
          </div>
        </div>
      </div>
      <input type="file" id="assetImgFile" accept="image/*" style="display:none">
    </div>
    <div id="assetTypeFields"></div>
    <div class="assets-error" id="assetsError"></div>
    <div class="assets-editor-actions">
      <div class="left">
        <button id="assetsSaveBtn">SAVE</button>
        <button id="assetsCancelBtn">Cancel</button>
      </div>
      ${a ? '<button id="assetsDeleteBtn">Delete</button>' : ''}
    </div>
  `;
  renderTypeFields(type, a);
  updateResHint();

  $('assetTypeInput').onchange = async e => {
    renderTypeFields(e.target.value, a);
    updateResHint();
    await rederiveImage();              // category may change → re-down-convert the staged upload
  };
  $('assetResolution').onchange = async e => {
    EDIT_RESOLUTION = e.target.value;
    updateResHint();
    await rederiveImage();
  };

  const drop = $('assetImgDrop');
  drop.onclick = () => $('assetImgFile').click();
  $('assetImgFile').onchange = e => { handleImageFile(e.target.files[0]); e.target.value = ''; };
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('dragover');
    handleImageFile(e.dataTransfer.files[0]);
  });

  $('assetAutoCropBtn').onclick = autoCropImage;
  $('assetsSaveBtn').onclick = saveEditor;
  $('assetsCancelBtn').onclick = () => { showList(); };
  if(a) $('assetsDeleteBtn').onclick = () => deleteEditor(a.id);
}

function renderTypeFields(type, a){
  const kind = (ASSET_TYPES[type] || {}).kind;
  const box = $('assetTypeFields');
  const size = (a && a.size) || {};
  if(kind === 'prop' && type === 'box'){
    box.innerHTML = `
      <div class="assets-size-row">
        <div class="field"><label>Width (m)</label><input type="number" step="0.01" id="assetSizeW" value="${size.w ?? 0.5}"></div>
        <button type="button" class="size-lock" id="sizeLockBtn" title="Lock width:height to the image's aspect ratio"></button>
        <div class="field"><label>Height (m)</label><input type="number" step="0.01" id="assetSizeH" value="${size.h ?? 1}"></div>
        <div class="field"><label>Depth (m)</label><input type="number" step="0.01" id="assetSizeD" value="${size.d ?? 0.5}"></div>
      </div>
      <div class="field">
        <label>Skin face</label>
        <select id="assetSkinFace">
          <option value="front" ${(!a || a.skinFace==='front') ? 'selected' : ''}>front</option>
          <option value="front+top" ${(a && a.skinFace==='front+top') ? 'selected' : ''}>front+top</option>
        </select>
      </div>
      <div class="field"><label>Side color</label><input type="text" id="assetSideColor" value="${esc((a && a.sideColor) || '#888888')}"></div>
    `;
  } else if(kind === 'prop'){
    box.innerHTML = `
      <div class="assets-size-row">
        <div class="field"><label>Width (m)</label><input type="number" step="0.01" id="assetSizeW" value="${size.w ?? 0.8}"></div>
        <button type="button" class="size-lock" id="sizeLockBtn" title="Lock width:height to the image's aspect ratio"></button>
        <div class="field"><label>Height (m)</label><input type="number" step="0.01" id="assetSizeH" value="${size.h ?? 1}"></div>
      </div>
    `;
  } else if(kind === 'facade'){
    // one-shot texture stretched over a whole building front (non-tiled); no
    // repeat/rotation. Carries its real-world face size in meters so the in-world
    // editor can snap a building's front face straight to it. Flat board → no depth.
    box.innerHTML = `
      <div class="assets-size-row">
        <div class="field"><label>Width (m)</label><input type="number" step="0.01" id="assetSizeW" value="${size.w ?? 8}"></div>
        <button type="button" class="size-lock" id="sizeLockBtn" title="Lock width:height to the image's aspect ratio"></button>
        <div class="field"><label>Height (m)</label><input type="number" step="0.01" id="assetSizeH" value="${size.h ?? 10}"></div>
      </div>
      <div class="field"><label>Tint (hex, optional)</label><input type="text" id="assetTint" value="${esc((a && a.tint) || '')}"></div>
      <div class="field"><label>Roughness</label><input type="number" step="0.01" min="0" max="1" id="assetRoughness" value="${(a && a.roughness) ?? 0.9}"></div>
      <div class="field"><label>Metalness</label><input type="number" step="0.01" min="0" max="1" id="assetMetalness" value="${(a && a.metalness) ?? 0}"></div>
    `;
  } else {
    box.innerHTML = `
      <div class="field"><label>Repeat per meter</label><input type="number" step="0.01" id="assetRepeatPerMeter" value="${(a && a.repeatPerMeter) ?? 0.5}"></div>
      <div class="field">
        <label>Rotation</label>
        <select id="assetRotation">
          <option value="0" ${(!a || a.rotation===0) ? 'selected' : ''}>0</option>
          <option value="90" ${(a && a.rotation===90) ? 'selected' : ''}>90</option>
        </select>
      </div>
      <div class="field"><label>Tint (hex, optional)</label><input type="text" id="assetTint" value="${esc((a && a.tint) || '')}"></div>
      <div class="field"><label>Roughness</label><input type="number" step="0.01" min="0" max="1" id="assetRoughness" value="${(a && a.roughness) ?? 0.85}"></div>
      <div class="field"><label>Metalness</label><input type="number" step="0.01" min="0" max="1" id="assetMetalness" value="${(a && a.metalness) ?? 0}"></div>
    `;
  }
  wireSizeLock();
}

/* ---------- size lock ----------
   Ties width:height (meters) to the image's pixel aspect ratio for box/billboard
   props. Editing one dimension fills the other; depth is left untouched. Aspect is
   derived from the staged image (EDIT_IMG_W/H), so it stays correct after auto-crop. */
function aspectRatio(){ return (EDIT_IMG_W && EDIT_IMG_H) ? EDIT_IMG_W / EDIT_IMG_H : 0; }
function trimNum(v){ return String(Math.round(v * 1000) / 1000); }

/* derive height from the current width when the lock is on (used on upload/crop and
   when the lock is switched on, so the pair snaps to the image without a manual edit) */
function snapHeightFromWidth(){
  const w = $('assetSizeW'), h = $('assetSizeH'), a = aspectRatio();
  if(!w || !h || !SIZE_LOCK || !a) return;
  const wv = Number(w.value) || 0;
  if(wv) h.value = trimNum(wv / a);
}

function wireSizeLock(){
  const lockBtn = $('sizeLockBtn');
  const w = $('assetSizeW'), h = $('assetSizeH');
  if(!lockBtn || !w || !h) return;          // surface/facade have no width/height fields
  const paint = () => {
    lockBtn.innerHTML = `<i class="fa-solid ${SIZE_LOCK ? 'fa-lock' : 'fa-lock-open'}"></i>`;
    lockBtn.classList.toggle('on', SIZE_LOCK);
    lockBtn.title = SIZE_LOCK
      ? 'Width:height locked to the image aspect ratio — click to unlock'
      : 'Width and height independent — click to lock to the image aspect ratio';
  };
  paint();
  lockBtn.onclick = () => { SIZE_LOCK = !SIZE_LOCK; paint(); snapHeightFromWidth(); };
  w.oninput = () => { const a = aspectRatio(); if(SIZE_LOCK && a){ const v = Number(w.value)||0; h.value = trimNum(v / a); } };
  h.oninput = () => { const a = aspectRatio(); if(SIZE_LOCK && a){ const v = Number(h.value)||0; w.value = trimNum(v * a); } };
}

/* measure the staged image and refresh the "(width: … height: … aspect: …)" note */
function measureDataUrl(dataUrl){
  return new Promise(resolve => {
    if(!dataUrl){ resolve({ w:0, h:0 }); return; }
    const img = new Image();
    img.onload  = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w:0, h:0 });
    img.src = dataUrl;
  });
}
function renderImgNote(){
  const el = $('assetImgInfo');
  if(!el) return;
  if(!EDIT_IMG_W || !EDIT_IMG_H){ el.textContent = ''; return; }
  const aspect = (EDIT_IMG_W / EDIT_IMG_H).toFixed(3).replace(/0+$/,'').replace(/\.$/,'.0');
  el.textContent = `(width: ${EDIT_IMG_W}  height: ${EDIT_IMG_H}  aspect: ${aspect})`;
}
async function updateImgInfo(){
  const { w, h } = await measureDataUrl(EDIT_IMAGE);
  EDIT_IMG_W = w; EDIT_IMG_H = h;
  renderImgNote();
}

/* read a file to a full-resolution PNG data-URL (no scaling) */
function fileToDataUrl(file){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not decode image')); };
    img.src = url;
  });
}

/* down-convert a data-URL to fit within maxDim x maxDim (aspect preserved, no
   cropping); PNG keeps alpha so billboard/sprite cutouts and box transparency
   survive. Returns the source unchanged when it already fits. */
function downscaleDataUrl(dataUrl, maxDim){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / img.width, maxDim / img.height);
      if(scale >= 1){ resolve(dataUrl); return; }   // already within the cap — keep as-is
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = dataUrl;
  });
}

/* crop a data-URL down to the smallest box that still contains every pixel whose
   alpha is above AUTO_CROP_ALPHA — i.e. trim away fully-transparent margins.
   Resolves { cropped, dataUrl, w, h, origW, origH }: cropped=false (and no dataUrl)
   when there's nothing to trim (already tight, or fully transparent). Reads pixels
   via getImageData — safe here because every image is a same-origin data-URL. */
function autoCropDataUrl(dataUrl){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    img.onload = () => {
      const w = img.width, h = img.height;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      let data;
      try{ data = ctx.getImageData(0,0,w,h).data; }
      catch(err){ reject(err); return; }
      let minX=w, minY=h, maxX=-1, maxY=-1;
      for(let y=0;y<h;y++){
        for(let x=0;x<w;x++){
          if(data[(y*w+x)*4+3] > AUTO_CROP_ALPHA){
            if(x<minX) minX=x;
            if(x>maxX) maxX=x;
            if(y<minY) minY=y;
            if(y>maxY) maxY=y;
          }
        }
      }
      if(maxX < 0){ resolve({ cropped:false, origW:w, origH:h }); return; }            // fully transparent — leave as-is
      if(minX===0 && minY===0 && maxX===w-1 && maxY===h-1){ resolve({ cropped:false, origW:w, origH:h }); return; }  // already tight
      const cw = maxX-minX+1, ch = maxY-minY+1;
      const out = document.createElement('canvas');
      out.width = cw; out.height = ch;
      out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
      resolve({ cropped:true, dataUrl: out.toDataURL('image/png'), w:cw, h:ch, origW:w, origH:h });
    };
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = dataUrl;
  });
}

/* convenience for the picker's quick upload: file -> down-converted data-URL
   for the given (type, tier) in one step. */
async function importImageFile(file, type, tier){
  const full = await fileToDataUrl(file);
  return downscaleDataUrl(full, resolutionCap(type, tier));
}

const editorType = () => { const el = $('assetTypeInput'); return el ? el.value : 'box'; };

/* recompute the displayed pixel cap for the current type + tier */
function updateResHint(){
  const hint = $('assetResHint');
  if(!hint) return;
  hint.textContent = `→ ${resolutionCap(editorType(), EDIT_RESOLUTION)}px long edge`;
}

/* re-derive the staged (saved) image from the kept original after the user
   changes type or tier. No original (editing an existing asset, or no upload
   yet) → nothing to do; we never upscale already-discarded pixels. */
async function rederiveImage(){
  if(!EDIT_IMAGE_ORIG) return;
  try{
    EDIT_IMAGE = await downscaleDataUrl(EDIT_IMAGE_ORIG, resolutionCap(editorType(), EDIT_RESOLUTION));
    const drop = $('assetImgDrop');
    if(drop) drop.innerHTML = `<img id="assetImgPreview" src="${EDIT_IMAGE}">`;
    await updateImgInfo();   // aspect unchanged, but the px dims in the note do change with the tier
  }catch(err){
    console.error('[assets] re-derive failed', err);
  }
}

async function handleImageFile(file){
  if(!file) return;
  if(!file.type.startsWith('image/')){ setError('that file is not an image'); return; }
  if(file.size > IMG_MAX_FILE_BYTES){ setError(`image too large (max ${IMG_MAX_FILE_BYTES/1024/1024}MB)`); return; }
  try{
    EDIT_IMAGE_ORIG = await fileToDataUrl(file);
    EDIT_IMAGE = await downscaleDataUrl(EDIT_IMAGE_ORIG, resolutionCap(editorType(), EDIT_RESOLUTION));
    setError('');
    const drop = $('assetImgDrop');
    drop.innerHTML = `<img id="assetImgPreview" src="${EDIT_IMAGE}">`;
    await updateImgInfo();      // refresh dims/aspect note for the new image…
    snapHeightFromWidth();      // …and pull height to match it if the lock is on
  }catch(err){
    console.error('[assets] image import failed', err);
    setError('could not read that image');
  }
}

function setError(msg){ $('assetsError').textContent = msg || ''; }
function setCropHint(msg){ const el = $('assetCropHint'); if(el) el.textContent = msg || ''; }

/* trim fully-transparent margins off the current image. Operates on the kept
   full-res original when there is one (a fresh upload this session) so quality is
   preserved, then re-down-converts; otherwise (editing an existing asset) it crops
   the already-staged image in place — cropping only removes pixels, so the result
   still fits within the resolution cap. */
async function autoCropImage(){
  const source = EDIT_IMAGE_ORIG || EDIT_IMAGE;
  if(!source){ setError('upload an image first'); return; }
  setError('');
  try{
    const res = await autoCropDataUrl(source);
    if(!res.cropped){ setCropHint('nothing to trim — no transparent margin found'); return; }
    if(EDIT_IMAGE_ORIG){
      EDIT_IMAGE_ORIG = res.dataUrl;
      EDIT_IMAGE = await downscaleDataUrl(EDIT_IMAGE_ORIG, resolutionCap(editorType(), EDIT_RESOLUTION));
    } else {
      EDIT_IMAGE = res.dataUrl;
    }
    const drop = $('assetImgDrop');
    if(drop) drop.innerHTML = `<img id="assetImgPreview" src="${EDIT_IMAGE}">`;
    setCropHint(`cropped ${res.origW}×${res.origH} → ${res.w}×${res.h}`);
    await updateImgInfo();      // cropping changes the aspect ratio…
    snapHeightFromWidth();      // …so re-pull height to match it if the lock is on
  }catch(err){
    console.error('[assets] auto-crop failed', err);
    setError('could not crop that image');
  }
}

function readTypeFields(type){
  if(type === 'box'){
    return {
      size: { w: Number($('assetSizeW').value)||0, h: Number($('assetSizeH').value)||0, d: Number($('assetSizeD').value)||0 },
      skinFace: $('assetSkinFace').value,
      sideColor: $('assetSideColor').value.trim() || '#888888',
    };
  }
  if(type === 'billboard-cylindrical' || type === 'billboard-sprite'){
    return { size: { w: Number($('assetSizeW').value)||0, h: Number($('assetSizeH').value)||0 } };
  }
  if(type === 'facade'){
    return {
      size: { w: Number($('assetSizeW').value)||0, h: Number($('assetSizeH').value)||0 },
      tint: $('assetTint').value.trim() || null,
      roughness: Number($('assetRoughness').value),
      metalness: Number($('assetMetalness').value),
    };
  }
  return {
    repeatPerMeter: Number($('assetRepeatPerMeter').value)||0,
    rotation: Number($('assetRotation').value)||0,
    tint: $('assetTint').value.trim() || null,
    roughness: Number($('assetRoughness').value),
    metalness: Number($('assetMetalness').value),
  };
}

async function saveEditor(){
  const id = (EDIT_ID || $('assetIdInput').value.trim().toLowerCase());
  if(!ID_RE.test(id)){ setError('id must be lowercase letters/numbers separated by single dashes, e.g. floor-planks-oak-1'); return; }
  if(!EDIT_ID && ASSETS.some(a => a.id === id)){ setError('an asset with that id already exists'); return; }
  if(!EDIT_IMAGE){ setError('please choose an image'); return; }
  const type = $('assetTypeInput').value;
  const patch = { type, image: EDIT_IMAGE, resolution: EDIT_RESOLUTION, ...readTypeFields(type) };
  await setAsset(id, patch);
  await refreshGrid();
  showList();
}

async function deleteEditor(id){
  if(!confirm(`Delete asset "${id}"? This cannot be undone.`)) return;
  await deleteAsset(id);
  await refreshGrid();
  showList();
}

/* ---------- export ----------
   No real filesystem access from a static site, so "export" downloads
   each asset as a <id>.png + <id>.json pair for the developer to commit
   under assets/three/props/ or assets/three/surfaces/ per
   Documents/three-assets.md. */
function dataUrlToBlob(dataUrl){
  const [, meta, b64] = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for(let i=0;i<bytes.length;i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: meta });
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function assetToJson(a){
  const json = { id: a.id, type: a.type, texture: `${a.id}.png` };
  if(a.type === 'box'){
    Object.assign(json, { size: a.size, skinFace: a.skinFace, sideColor: a.sideColor });
  } else if(a.type === 'billboard-cylindrical' || a.type === 'billboard-sprite'){
    Object.assign(json, { size: a.size });
  } else if(a.type === 'facade'){
    Object.assign(json, { size: a.size, tint: a.tint, roughness: a.roughness, metalness: a.metalness });
  } else {
    Object.assign(json, { repeatPerMeter: a.repeatPerMeter, rotation: a.rotation, tint: a.tint, roughness: a.roughness, metalness: a.metalness });
  }
  return json;
}

async function exportAllAsFiles(){
  if(!ASSETS.length){ alert('no assets to export'); return; }
  if(!confirm(`Export ${ASSETS.length} asset(s) as ${ASSETS.length*2} files (PNG + JSON pairs)? Your browser will prompt for each download.`)) return;
  for(const a of ASSETS){
    downloadBlob(dataUrlToBlob(a.image), `${a.id}.png`);
    downloadBlob(new Blob([JSON.stringify(assetToJson(a), null, 2)], {type:'application/json'}), `${a.id}.json`);
  }
}

/* ---------- asset picker ----------
   A lightweight modal for choosing an existing asset (filtered to a set of
   types) from somewhere other than the full manager — e.g. the in-world
   layout editor in threeTest.js. Builds its own overlay on document.body
   (above whatever is open) so it has no static-markup dependency.

   opts = {
     allow:       array of asset types to show (null = all),
     allowRemove: show a "Remove" button (e.g. to clear a surface/slot),
     onPick:      fn(assetId)  — chosen an asset,
     onRemove:    fn()         — clicked Remove,
     onClose:     fn()         — always called once the picker closes
   }
*/
let pickerOpts = null;
let pickerUploadType = 'box';
let pickerResolution = RESOLUTION_DEFAULT;

export function openAssetPicker(opts){
  pickerOpts = opts || {};
  pickerUploadType = (pickerOpts.allow && pickerOpts.allow[0]) || 'box';
  pickerResolution = RESOLUTION_DEFAULT;
  let ov = document.getElementById('assetPickerOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'assetPickerOverlay';
    ov.className = 'overlay';
    ov.style.zIndex = '60';
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';
  renderPicker(ov);
}

function closePicker(){
  const ov = document.getElementById('assetPickerOverlay');
  if(ov) ov.style.display = 'none';
  const cb = pickerOpts && pickerOpts.onClose;
  pickerOpts = null;
  if(cb) cb();
}

async function renderPicker(ov){
  const all = await getAllAssets();
  const allow = pickerOpts.allow;
  const list = allow ? all.filter(a => allow.includes(a.type)) : all;
  list.sort((a,b) => a.id.localeCompare(b.id));
  const typeLabel = allow ? allow.map(t => (ASSET_TYPES[t]||{}).label || t).join(' / ') : 'any';
  ov.innerHTML = `
    <div class="modal" style="width:min(52em,92vw);max-height:88vh;display:flex;flex-direction:column">
      <div class="assets-header">
        <h2>Choose Asset</h2>
        <button id="pickerCloseBtn">Cancel</button>
      </div>
      <p style="margin:.2rem 0 .6rem;font-size:.8rem;color:#666">Showing: ${esc(typeLabel)}</p>
      <div class="assets-body" style="overflow:auto">
        <div class="assets-grid" id="pickerGrid"></div>
      </div>
      <div class="assets-editor-actions">
        <div class="left">
          <button id="pickerUploadBtn"><i class="fa-solid fa-upload"></i> Upload new…</button>
          <select id="pickerResolution" title="Import resolution">
            ${RESOLUTION_TIERS.map(t => `<option value="${t}" ${t===pickerResolution?'selected':''}>${t[0].toUpperCase()+t.slice(1)}</option>`).join('')}
          </select>
          <input type="file" id="pickerUploadFile" accept="image/*" style="display:none">
        </div>
        ${pickerOpts.allowRemove ? '<button id="pickerRemoveBtn" style="background:#c62828;color:#fff">Remove</button>' : ''}
      </div>
    </div>
  `;
  const grid = ov.querySelector('#pickerGrid');
  if(!list.length){
    grid.innerHTML = '<p class="assets-empty">No matching assets yet. Use "Upload new…" or add some via menu → Manage Assets.</p>';
  } else {
    for(const a of list){
      const card = document.createElement('div');
      card.className = 'asset-card';
      card.innerHTML = `
        <div class="asset-thumb">${a.image ? `<img src="${a.image}" alt="">` : ''}</div>
        <div class="asset-id">${esc(a.id)}</div>
        <div class="asset-type">${esc((ASSET_TYPES[a.type]||{}).label || a.type)}</div>
      `;
      card.onclick = () => { const cb = pickerOpts.onPick; closePicker(); if(cb) cb(a.id); };
      grid.appendChild(card);
    }
  }
  ov.querySelector('#pickerCloseBtn').onclick = () => closePicker();
  ov.querySelector('#pickerResolution').onchange = e => { pickerResolution = e.target.value; };
  ov.querySelector('#pickerUploadBtn').onclick = () => ov.querySelector('#pickerUploadFile').click();
  ov.querySelector('#pickerUploadFile').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    await pickerUpload(file, ov);
  };
  if(pickerOpts.allowRemove){
    ov.querySelector('#pickerRemoveBtn').onclick = () => { const cb = pickerOpts.onRemove; closePicker(); if(cb) cb(); };
  }
}

/* upload straight from the picker: derive an id from the filename, encode the
   image, and stage it with default metadata for the first allowed type, then
   re-render so it shows up in the grid for the user to place. */
async function pickerUpload(file, ov){
  if(!file) return;
  if(!file.type.startsWith('image/')){ alert('that file is not an image'); return; }
  if(file.size > IMG_MAX_FILE_BYTES){ alert(`image too large (max ${IMG_MAX_FILE_BYTES/1024/1024}MB)`); return; }
  let base = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if(!ID_RE.test(base)) base = 'asset';
  const existing = await getAllAssets();
  let id = base, n = 2;
  while(existing.some(a => a.id === id)){ id = `${base}-${n++}`; }
  try{
    const image = await importImageFile(file, pickerUploadType, pickerResolution);
    await setAsset(id, { type: pickerUploadType, image, resolution: pickerResolution });
    await renderPicker(ov);
  }catch(err){
    console.error('[assets] picker upload failed', err);
    alert('could not read that image');
  }
}
