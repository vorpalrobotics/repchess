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
  'extruded':              { label: 'Prop: Extruded (silhouette)',    kind: 'prop' },
  'billboard-cylindrical': { label: 'Prop: Billboard (cylindrical)',  kind: 'prop' },
  'billboard-sprite':      { label: 'Prop: Billboard (sprite)',       kind: 'prop' },
  'surface':               { label: 'Surface (floor / wall texture)', kind: 'surface' },
  'facade':                { label: 'Surface: Facade (large, non-tiled)', kind: 'facade' },
  'sign':                  { label: 'Surface: Sign skin', kind: 'sign' },
  'door':                  { label: 'Surface: Door skin', kind: 'door' },
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
  return 'object';                       // extruded, billboard-cylindrical, billboard-sprite, sign
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
let FILTER_TEXT = '';

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
      <input type="text" id="assetsFilterText" class="assets-search" placeholder="Search name / keywords…">
      <span class="assets-count" id="assetsCount"></span>
      <span class="assets-spacer"></span>
      <button id="assetsNewBtn"><i class="fa-solid fa-plus"></i> New Asset</button>
      <button id="assetsExportJsonBtn"><i class="fa-solid fa-file-export"></i> Export All as JSON</button>
      <button id="assetsExportBtn"><i class="fa-solid fa-file-export"></i> Export All as Files</button>
    </div>
    <div class="assets-body">
      <div class="assets-grid" id="assetsGrid"></div>
      <div class="assets-editor" id="assetsEditor" style="display:none"></div>
    </div>
  `;
  $('assetsFilterType').onchange = e => { FILTER_TYPE = e.target.value; renderGrid(); };
  $('assetsFilterText').oninput = e => { FILTER_TEXT = e.target.value.trim().toLowerCase(); renderGrid(); };
  $('assetsNewBtn').onclick = () => openEditor(null);
  $('assetsExportJsonBtn').onclick = exportAllAsJson;
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
  let visible = FILTER_TYPE === 'all' ? ASSETS : ASSETS.filter(a => a.type === FILTER_TYPE);
  if(FILTER_TEXT) visible = visible.filter(a => `${a.id} ${a.keywords || ''}`.toLowerCase().includes(FILTER_TEXT));
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
  const type = (a && a.type) || 'extruded';
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
      <label>Keywords (optional, space- or comma-separated; searchable alongside the id)</label>
      <input type="text" id="assetKeywords" placeholder="e.g. nautical ocean blue" value="${esc((a && a.keywords) || '')}">
    </div>
    <div class="field">
      <label>Resolution</label>
      <select id="assetResolution">
        ${RESOLUTION_TIERS.map(t => `<option value="${t}" ${t===EDIT_RESOLUTION?'selected':''}>${t[0].toUpperCase()+t.slice(1)}</option>`).join('')}
      </select>
      <span class="assets-res-hint" id="assetResHint"></span>
    </div>
    <div class="field">
      <label>Image</label>
      <div class="asset-img-row">
        <div class="asset-img-drop" id="assetImgDrop">
          ${EDIT_IMAGE ? `<img id="assetImgPreview" src="${EDIT_IMAGE}">` : '<i class="fa-solid fa-image"></i>'}
        </div>
        <div class="asset-img-side">
          <div class="asset-img-info" id="assetImgInfo"></div>
          <div class="asset-img-tools">
            <button type="button" id="assetCropBtn"><i class="fa-solid fa-crop-simple"></i> Crop / Erase BG…</button>
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

  $('assetCropBtn').onclick = openCropModal;
  $('assetsSaveBtn').onclick = saveEditor;
  $('assetsCancelBtn').onclick = () => { showList(); };
  if(a) $('assetsDeleteBtn').onclick = () => deleteEditor(a.id);
}

function renderTypeFields(type, a){
  const kind = (ASSET_TYPES[type] || {}).kind;
  const box = $('assetTypeFields');
  const size = (a && a.size) || {};
  if(type === 'extruded'){
    box.innerHTML = `
      <div class="assets-size-row">
        <div class="field"><label>Width (m)</label><input type="number" step="0.01" id="assetSizeW" value="${size.w ?? 0.5}"></div>
        <button type="button" class="size-lock" id="sizeLockBtn" title="Lock width:height to the image's aspect ratio"></button>
        <div class="field"><label>Height (m)</label><input type="number" step="0.01" id="assetSizeH" value="${size.h ?? 1}"></div>
        <div class="field"><label>Depth (m)</label><input type="number" step="0.01" id="assetSizeD" value="${size.d ?? 0.2}"></div>
      </div>
      <div class="field">
        <label>Side color</label>
        <div class="side-color-row">
          <input type="text" id="assetSideColor" placeholder="auto" value="${esc((a && a.sideColor && a.sideColor !== 'auto') ? a.sideColor : '')}">
          <div class="side-color-swatch" id="assetSideColorSwatch"></div>
          <button type="button" class="eyedropper-btn" id="assetEyedropperBtn" title="Pick side color from the image"><i class="fa-solid fa-eye-dropper"></i></button>
        </div>
      </div>
      <div class="field">
        <label>Orientation</label>
        <select id="assetOrientation">
          <option value="standing" ${(!a || a.orientation !== 'flat') ? 'selected' : ''}>Standing (cutout)</option>
          <option value="flat" ${(a && a.orientation === 'flat') ? 'selected' : ''}>Floor covering (lies flat)</option>
        </select>
      </div>
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
    // one-shot texture stretched over a whole building front. Carries its
    // real-world face size in meters so the in-world editor can snap a building's
    // front face straight to it. With a Depth > 0 the facade is extruded from its
    // silhouette into a slab (side walls take the Side color); the walkable box
    // behind it is buried inside that depth. Depth 0 = the old flat board.
    box.innerHTML = `
      <div class="assets-size-row">
        <div class="field"><label>Width (m)</label><input type="number" step="0.01" id="assetSizeW" value="${size.w ?? 8}"></div>
        <button type="button" class="size-lock" id="sizeLockBtn" title="Lock width:height to the image's aspect ratio"></button>
        <div class="field"><label>Height (m)</label><input type="number" step="0.01" id="assetSizeH" value="${size.h ?? 10}"></div>
        <div class="field"><label>Depth (m)</label><input type="number" step="0.01" id="assetSizeD" value="${size.d ?? 2}"></div>
      </div>
      <div class="field">
        <label>Side color</label>
        <div class="side-color-row">
          <input type="text" id="assetSideColor" placeholder="auto" value="${esc((a && a.sideColor && a.sideColor !== 'auto') ? a.sideColor : '')}">
          <div class="side-color-swatch" id="assetSideColorSwatch"></div>
          <button type="button" class="eyedropper-btn" id="assetEyedropperBtn" title="Pick side color from the image"><i class="fa-solid fa-eye-dropper"></i></button>
        </div>
      </div>
      <div class="field"><label>Tint (hex, optional)</label><input type="text" id="assetTint" value="${esc((a && a.tint) || '')}"></div>
      <div class="field"><label>Roughness</label><input type="number" step="0.01" min="0" max="1" id="assetRoughness" value="${(a && a.roughness) ?? 0.9}"></div>
      <div class="field"><label>Metalness</label><input type="number" step="0.01" min="0" max="1" id="assetMetalness" value="${(a && a.metalness) ?? 0}"></div>
    `;
  } else if(kind === 'sign'){
    const size = (a && a.size) || {};
    box.innerHTML = `
      <p class="asset-hint">Skins the whole freestanding sign at the size below — the
      image replaces the entire sign (posts included), so draw the legs/stand into the
      art. The name text is drawn over the upper third (to clear the legs), so leave a
      clear, readable band across the top.</p>
      <div class="assets-size-row">
        <div class="field"><label>Width (m)</label><input type="number" step="0.01" id="assetSizeW" value="${size.w ?? 3.4}"></div>
        <button type="button" class="size-lock" id="sizeLockBtn" title="Lock width:height to the image's aspect ratio"></button>
        <div class="field"><label>Height (m)</label><input type="number" step="0.01" id="assetSizeH" value="${size.h ?? 2}"></div>
      </div>
    `;
  } else if(kind === 'door'){
    box.innerHTML = `
      <p class="asset-hint">Skins an interior doorway panel (2.2m × 2.6m). The image
      is stretched to fill the opening and is visible from both sides.</p>
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
  wireSideColorPicker();
}

/* ---------- side-color eyedropper ----------
   Only present on the 'extruded' type's fields. The swatch mirrors whatever's
   in the text input (so a hand-typed hex shows up too); the eyedropper opens a
   full-viewport picker over the staged image and writes the sampled hex back
   into the same input. */
function wireSideColorPicker(){
  const input = $('assetSideColor'), swatch = $('assetSideColorSwatch'), btn = $('assetEyedropperBtn');
  if(!input || !swatch || !btn) return; // not the extruded type's fields
  const paintSwatch = () => { swatch.style.background = input.value.trim() || ''; };
  paintSwatch();
  input.oninput = paintSwatch;
  btn.onclick = () => openColorPicker(EDIT_IMAGE, input.value.trim(), (hex) => {
    input.value = hex;
    paintSwatch();
  });
}

/* full-viewport "click the image to sample a color" modal. Builds its own
   overlay on document.body (same pattern as the asset picker), so it works
   regardless of which editor/container is open underneath it. */
function openColorPicker(imageDataUrl, initialColor, onSave){
  let ov = document.getElementById('colorPickerOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'colorPickerOverlay';
    ov.className = 'overlay';
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';
  let picked = initialColor || null;
  ov.innerHTML = `
    <div class="modal">
      <div class="cp-header">
        <h2>Pick side color — click anywhere on the image</h2>
        <div class="cp-current">
          <span>Selected:</span>
          <div class="side-color-swatch" id="cpSwatch"></div>
          <span id="cpHex"></span>
        </div>
      </div>
      <div class="cp-stage"><img id="cpImg" src="${imageDataUrl}" alt=""></div>
      <div class="cp-actions">
        <button id="cpCancelBtn">Cancel</button>
        <button id="cpSaveBtn">SAVE</button>
      </div>
    </div>
  `;
  const cpSwatch = ov.querySelector('#cpSwatch');
  const cpHex = ov.querySelector('#cpHex');
  const cpSave = ov.querySelector('#cpSaveBtn');
  const paint = () => {
    cpSwatch.style.background = picked || '';
    cpHex.textContent = picked || 'none yet';
    cpSave.disabled = !picked;
  };
  paint();

  const img = ov.querySelector('#cpImg');
  const sampleCanvas = document.createElement('canvas');
  img.onload = () => {
    sampleCanvas.width = img.naturalWidth;
    sampleCanvas.height = img.naturalHeight;
    sampleCanvas.getContext('2d').drawImage(img, 0, 0);
  };
  img.onclick = (e) => {
    const rect = img.getBoundingClientRect();
    const px = Math.min(sampleCanvas.width - 1, Math.max(0, Math.floor((e.clientX - rect.left) / rect.width * sampleCanvas.width)));
    const py = Math.min(sampleCanvas.height - 1, Math.max(0, Math.floor((e.clientY - rect.top) / rect.height * sampleCanvas.height)));
    const [r, g, b, a] = sampleCanvas.getContext('2d').getImageData(px, py, 1, 1).data;
    if(a < 10) return; // clicked a transparent pixel -- nothing there to sample
    picked = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    paint();
  };
  const close = () => { ov.style.display = 'none'; };
  ov.querySelector('#cpCancelBtn').onclick = close;
  cpSave.onclick = () => { if(picked){ onSave(picked); close(); } };
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
export function measureDataUrl(dataUrl){
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
export function fileToDataUrl(file){
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
export function downscaleDataUrl(dataUrl, maxDim){
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

/* Flood-fill from (sx,sy) across all 4-connected pixels whose colour is within
   `tol` (Euclidean RGB distance) of the seed, setting their alpha to 0. Mutates
   `data` (a Uint8ClampedArray of RGBA) in place; returns how many pixels were
   cleared. Used by the Erase-BG tool to knock a flat/near-flat background out to
   real transparency. */
function floodFillTransparent(data, W, H, sx, sy, tol){
  const seed = sy*W + sx, si = seed*4;
  if(data[si+3] === 0) return 0;                 // already transparent
  const r0 = data[si], g0 = data[si+1], b0 = data[si+2];
  const tol2 = tol*tol;
  const matches = (i) => {
    if(data[i+3] === 0) return false;
    const dr = data[i]-r0, dg = data[i+1]-g0, db = data[i+2]-b0;
    return dr*dr + dg*dg + db*db <= tol2;
  };
  const seen = new Uint8Array(W*H);
  const stack = [seed];
  seen[seed] = 1;
  let count = 0;
  while(stack.length){
    const p = stack.pop();
    data[p*4+3] = 0;
    count++;
    const x = p % W, y = (p - x) / W;
    if(x > 0   && !seen[p-1] && matches((p-1)*4)){ seen[p-1] = 1; stack.push(p-1); }
    if(x < W-1 && !seen[p+1] && matches((p+1)*4)){ seen[p+1] = 1; stack.push(p+1); }
    if(y > 0   && !seen[p-W] && matches((p-W)*4)){ seen[p-W] = 1; stack.push(p-W); }
    if(y < H-1 && !seen[p+W] && matches((p+W)*4)){ seen[p+W] = 1; stack.push(p+W); }
  }
  return count;
}

/* crop a data-URL to a fractional rectangle {l,t,r,b} (each 0..1 of the image).
   Returns a fresh PNG data-URL of just that region. */
function cropDataUrl(dataUrl, { l, t, r, b }){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    img.onload = () => {
      const W = img.width, H = img.height;
      const sx = Math.round(l*W), sy = Math.round(t*H);
      const sw = Math.max(1, Math.round((r-l)*W)), sh = Math.max(1, Math.round((b-t)*H));
      const c = document.createElement('canvas');
      c.width = sw; c.height = sh;
      c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = dataUrl;
  });
}

/* tightest box (as fractions {l,t,r,b}) that still contains every pixel whose
   alpha is above AUTO_CROP_ALPHA — i.e. the auto-crop bounds. null when the
   image is fully transparent. Reads pixels via getImageData (safe: every image
   is a same-origin data-URL). */
function alphaBoundsFrac(dataUrl){
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
      if(maxX < 0){ resolve(null); return; }   // fully transparent — nothing to bound
      resolve({ l:minX/w, t:minY/h, r:(maxX+1)/w, b:(maxY+1)/h });
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

const editorType = () => { const el = $('assetTypeInput'); return el ? el.value : 'extruded'; };

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
    if(!EDIT_ID){
      const idInput = $('assetIdInput');
      if(idInput && !idInput.value.trim()){
        let base = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        if(!ID_RE.test(base)) base = 'asset';
        idInput.value = base;
      }
    }
  }catch(err){
    console.error('[assets] image import failed', err);
    setError('could not read that image');
  }
}

function setError(msg){ $('assetsError').textContent = msg || ''; }
function setCropHint(msg){ const el = $('assetCropHint'); if(el) el.textContent = msg || ''; }

/* Generic crop modal: shows `sourceDataUrl` full-viewport with four draggable
   edge bars defining a crop rectangle, an Auto-crop button that snaps the bars
   to the transparent-margin bounds, and a Crop button that cuts the working
   image down to the current bars (repeatable). Resolves to the final cropped
   data-URL on Save, or null on Cancel (caller's image is left untouched).
   Shared by the asset editor's own openCropModal below and by the mnemonics
   move-image editor in app.js. */
export function cropImage(sourceDataUrl){
  let ov = document.getElementById('cropOverlay');
  if(!ov){ ov = document.createElement('div'); ov.id = 'cropOverlay'; ov.className = 'overlay'; document.body.appendChild(ov); }
  ov.style.display = 'flex';

  let work = sourceDataUrl;             // current working data-URL (full-res when caller passed one)
  let sel = { l:0, t:0, r:1, b:1 };     // crop rectangle as fractions of `work`
  let natW = 0, natH = 0;

  let eraseMode = false;

  ov.innerHTML = `
    <div class="modal">
      <div class="crop-header">
        <h2>Edit image</h2>
        <span class="crop-dims" id="cropDims"></span>
      </div>
      <div class="crop-stage">
        <div class="crop-wrap" id="cropWrap">
          <img id="cropImg" src="${work}" alt="">
          <div class="crop-sel" id="cropSel"></div>
          <div class="crop-bar l" data-edge="l"></div>
          <div class="crop-bar r" data-edge="r"></div>
          <div class="crop-bar t" data-edge="t"></div>
          <div class="crop-bar b" data-edge="b"></div>
        </div>
      </div>
      <div class="crop-actions">
        <button id="cropAutoBtn"><i class="fa-solid fa-wand-magic-sparkles"></i> Auto-crop</button>
        <button id="cropApplyBtn"><i class="fa-solid fa-scissors"></i> Crop</button>
        <button id="cropEraseBtn"><i class="fa-solid fa-eraser"></i> Erase BG</button>
        <span id="cropEraseTools" style="display:none;align-items:center;gap:.4rem;font-size:.85rem;color:#444">
          fuzz <input type="range" id="cropTol" min="0" max="120" value="32" style="width:120px">
          <span id="cropTolVal" style="font-family:ui-monospace,monospace;min-width:2.2em">32</span>
        </span>
        <span class="spacer"></span>
        <button id="cropCancelBtn">Cancel</button>
        <button id="cropSaveBtn">SAVE</button>
      </div>
    </div>`;

  const stage = ov.querySelector('.crop-stage');
  const wrap  = ov.querySelector('#cropWrap');
  const img   = ov.querySelector('#cropImg');
  const selEl = ov.querySelector('#cropSel');
  const dims  = ov.querySelector('#cropDims');
  const bars  = { l: ov.querySelector('.crop-bar.l'), r: ov.querySelector('.crop-bar.r'),
                  t: ov.querySelector('.crop-bar.t'), b: ov.querySelector('.crop-bar.b') };

  function fitWrap(){
    if(!natW || !natH) return;
    const scale = Math.min(stage.clientWidth / natW, stage.clientHeight / natH) || 1;
    wrap.style.width  = Math.max(1, Math.round(natW * scale)) + 'px';
    wrap.style.height = Math.max(1, Math.round(natH * scale)) + 'px';
  }
  function paint(){
    selEl.style.left   = (sel.l*100) + '%';
    selEl.style.top    = (sel.t*100) + '%';
    selEl.style.width  = ((sel.r-sel.l)*100) + '%';
    selEl.style.height = ((sel.b-sel.t)*100) + '%';
    bars.l.style.left = (sel.l*100) + '%';
    bars.r.style.left = (sel.r*100) + '%';
    bars.t.style.top  = (sel.t*100) + '%';
    bars.b.style.top  = (sel.b*100) + '%';
    const cw = Math.max(1, Math.round((sel.r-sel.l)*natW));
    const ch = Math.max(1, Math.round((sel.b-sel.t)*natH));
    if(!eraseMode) dims.textContent = `${natW}×${natH}  →  ${cw}×${ch}`;   // erase mode shows its own status
  }
  function onImgReady(){ natW = img.naturalWidth; natH = img.naturalHeight; fitWrap(); paint(); }
  img.onload = onImgReady;
  if(img.complete && img.naturalWidth) onImgReady();

  // each bar captures the pointer on grab, so its own pointermove/up fire even
  // when the cursor leaves the image -- and because the bars are rebuilt with the
  // modal each open, no listeners accumulate on the persistent overlay element.
  for(const k of ['l','r','t','b']){
    const bar = bars[k];
    bar.addEventListener('pointerdown', e => { bar.setPointerCapture?.(e.pointerId); e.preventDefault(); });
    bar.addEventListener('pointermove', e => {
      if(e.buttons === 0) return;        // not dragging
      const r = wrap.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const fy = Math.min(1, Math.max(0, (e.clientY - r.top)  / r.height));
      const MIN = 0.02;
      if(k === 'l') sel.l = Math.min(fx, sel.r - MIN);
      if(k === 'r') sel.r = Math.max(fx, sel.l + MIN);
      if(k === 't') sel.t = Math.min(fy, sel.b - MIN);
      if(k === 'b') sel.b = Math.max(fy, sel.t + MIN);
      paint();
    });
  }

  async function applyCrop(){
    if(sel.l <= 0 && sel.t <= 0 && sel.r >= 1 && sel.b >= 1) return;   // full image — nothing to cut
    work = await cropDataUrl(work, sel);
    sel = { l:0, t:0, r:1, b:1 };
    img.src = work;        // onload → recompute natW/H, refit, repaint
  }

  // Erase-background mode: clicking the image samples that pixel and flood-fills
  // the connected region of near-matching colour to full transparency (handles
  // the "looks transparent but is actually a flat/near-white fill" exports).
  // The crop bars stay visible and usable throughout -- a click on the image
  // interior erases, a grab of a (thin, edge) crop bar still crops -- so
  // toggling erase on never makes the crop handles disappear.
  const eraseBtn = ov.querySelector('#cropEraseBtn');
  const eraseTools = ov.querySelector('#cropEraseTools');
  const tolEl = ov.querySelector('#cropTol');
  const tolVal = ov.querySelector('#cropTolVal');
  function setEraseMode(on){
    eraseMode = on;
    eraseTools.style.display = on ? 'inline-flex' : 'none';
    img.style.cursor = on ? 'crosshair' : '';
    eraseBtn.style.background = on ? '#1565c0' : '';
    eraseBtn.style.color = on ? '#fff' : '';
    if(on) dims.textContent = 'click a background area to erase it';
    else paint();   // restore the dimensions readout
  }
  tolEl.oninput = () => { tolVal.textContent = tolEl.value; };
  img.addEventListener('pointerdown', (e) => {
    if(!eraseMode || !natW) return;
    const r = img.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * natW);
    const y = Math.floor((e.clientY - r.top) / r.height * natH);
    if(x < 0 || y < 0 || x >= natW || y >= natH) return;
    const c = document.createElement('canvas');
    c.width = natW; c.height = natH;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, natW, natH);
    let id;
    try{ id = cx.getImageData(0, 0, natW, natH); }
    catch(err){ console.error('[crop] erase read failed', err); return; }
    const n = floodFillTransparent(id.data, natW, natH, x, y, Number(tolEl.value));
    if(!n){ dims.textContent = 'that spot is already transparent'; return; }
    cx.putImageData(id, 0, 0);
    work = c.toDataURL('image/png');
    img.src = work;
    dims.textContent = `erased ${n.toLocaleString()} px — click more or SAVE`;
  });

  return new Promise((resolve) => {
    ov.querySelector('#cropApplyBtn').onclick = () => applyCrop().catch(err => { console.error('[crop] crop failed', err); });
    ov.querySelector('#cropAutoBtn').onclick = async () => {
      try{
        const b = await alphaBoundsFrac(work);
        if(!b){ dims.textContent = 'image is fully transparent — nothing to bound'; return; }
        sel = b; paint();
      }catch(err){ console.error('[crop] auto-crop bounds failed', err); }
    };
    eraseBtn.onclick = async () => {
      if(!eraseMode){ await applyCrop().catch(err => console.error('[crop] crop failed', err)); }  // bake in any pending crop before erasing
      setEraseMode(!eraseMode);
    };
    ov.querySelector('#cropCancelBtn').onclick = () => { ov.style.display = 'none'; resolve(null); };
    ov.querySelector('#cropSaveBtn').onclick = async () => {
      try{
        await applyCrop();                 // commit any pending bar selection first (no-op if full)
        ov.style.display = 'none';
        resolve(work);
      }catch(err){
        console.error('[crop] crop save failed', err);
        dims.textContent = 'could not crop that image';
      }
    };
  });
}

/* Asset editor's own crop entry point: feeds the kept full-res original when
   there is one (a fresh upload this session) so quality is preserved, then
   re-down-converts on save; otherwise it crops the already-staged image in
   place (cropping only removes pixels, so the result still fits the
   resolution cap). Cancel (cropImage resolving null) leaves the editor as-is. */
async function openCropModal(){
  const source = EDIT_IMAGE_ORIG || EDIT_IMAGE;
  if(!source){ setError('upload an image first'); return; }
  setError('');
  const work = await cropImage(source);
  if(work == null) return;   // cancelled
  try{
    if(EDIT_IMAGE_ORIG){
      EDIT_IMAGE_ORIG = work;
      EDIT_IMAGE = await downscaleDataUrl(EDIT_IMAGE_ORIG, resolutionCap(editorType(), EDIT_RESOLUTION));
    } else {
      EDIT_IMAGE = work;
    }
    const drop = $('assetImgDrop');
    if(drop) drop.innerHTML = `<img id="assetImgPreview" src="${EDIT_IMAGE}">`;
    const m = await measureDataUrl(EDIT_IMAGE);
    setCropHint(`updated — ${m.w}×${m.h}`);
    await updateImgInfo();             // aspect ratio changed…
    snapHeightFromWidth();             // …so re-pull height if the size lock is on
  }catch(err){
    console.error('[assets] crop save failed', err);
    setError('could not crop that image');
  }
}

function readTypeFields(type){
  if(type === 'extruded'){
    return {
      size: { w: Number($('assetSizeW').value)||0, h: Number($('assetSizeH').value)||0, d: Number($('assetSizeD').value)||0 },
      sideColor: $('assetSideColor').value.trim() || 'auto',
      orientation: $('assetOrientation').value === 'flat' ? 'flat' : 'standing',
    };
  }
  if(type === 'billboard-cylindrical' || type === 'billboard-sprite'){
    return { size: { w: Number($('assetSizeW').value)||0, h: Number($('assetSizeH').value)||0 } };
  }
  if(type === 'facade'){
    return {
      size: { w: Number($('assetSizeW').value)||0, h: Number($('assetSizeH').value)||0, d: Number($('assetSizeD').value)||0 },
      sideColor: $('assetSideColor').value.trim() || 'auto',
      tint: $('assetTint').value.trim() || null,
      roughness: Number($('assetRoughness').value),
      metalness: Number($('assetMetalness').value),
    };
  }
  if(type === 'sign') return { size: { w: Number($('assetSizeW').value)||0, h: Number($('assetSizeH').value)||0 } };
  if(type === 'door') return {};
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
  const keywords = $('assetKeywords').value.trim();
  const patch = { type, keywords, image: EDIT_IMAGE, resolution: EDIT_RESOLUTION, ...readTypeFields(type) };
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
  if(a.keywords) json.keywords = a.keywords;
  if(a.type === 'extruded'){
    Object.assign(json, { size: a.size, sideColor: a.sideColor, orientation: a.orientation || 'standing' });
  } else if(a.type === 'billboard-cylindrical' || a.type === 'billboard-sprite'){
    Object.assign(json, { size: a.size });
  } else if(a.type === 'facade'){
    Object.assign(json, { size: a.size, sideColor: a.sideColor, tint: a.tint, roughness: a.roughness, metalness: a.metalness });
  } else if(a.type === 'sign'){
    Object.assign(json, { size: a.size });
  } else if(a.type === 'door'){
    // no extra fields — fixed-size panel, image is the whole skin
  } else {
    Object.assign(json, { repeatPerMeter: a.repeatPerMeter, rotation: a.rotation, tint: a.tint, roughness: a.roughness, metalness: a.metalness });
  }
  return json;
}

// Bundles every asset (full records, base64 images included) into a single
// JSON file. The `repchessAssets` marker lets the hamburger-menu importer
// recognize it as an asset bundle (vs a full backup) and offer a replace.
function exportAllAsJson(){
  if(!ASSETS.length){ alert('no assets to export'); return; }
  const bundle = { repchessAssets: 1, exportedAt: new Date().toISOString(), assets: ASSETS };
  const stamp = new Date().toISOString().slice(0,10);
  downloadBlob(new Blob([JSON.stringify(bundle, null, 2)], {type:'application/json'}),
    `repchess-assets-${stamp}.json`);
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
let pickerUploadType = 'extruded';
let pickerResolution = RESOLUTION_DEFAULT;

export function openAssetPicker(opts){
  pickerOpts = opts || {};
  pickerUploadType = (pickerOpts.allow && pickerOpts.allow[0]) || 'extruded';
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
  // current selection + where it comes from (a per-room override vs an inherited
  // building default), so the user can tell custom from inherited at a glance.
  const curId = pickerOpts.currentId || null;
  const curSrc = pickerOpts.currentSource || null;     // 'room' | 'default' | null
  const curLine = curId
    ? `Current: <strong>${esc(curId)}</strong>${curSrc === 'default' ? ' <em>(inherited from building default)</em>' : curSrc === 'room' ? ' <em>(set for this room)</em>' : ''}`
    : 'Current: <em>none (procedural default)</em>';
  const removeLabel = pickerOpts.defaultExists ? 'Remove (revert to default)' : 'Remove';
  ov.innerHTML = `
    <div class="modal" style="width:min(52em,92vw);max-height:88vh;display:flex;flex-direction:column">
      <div class="assets-header">
        <h2>Choose Asset</h2>
        <button id="pickerCloseBtn">Cancel</button>
      </div>
      <p style="margin:.2rem 0 .2rem;font-size:.8rem;color:#666">Showing: ${esc(typeLabel)}</p>
      <p style="margin:0 0 .6rem;font-size:.8rem;color:#666">${curLine}</p>
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
        ${pickerOpts.allowRemove ? `<button id="pickerRemoveBtn" style="background:#c62828;color:#fff">${removeLabel}</button>` : ''}
      </div>
    </div>
  `;
  const grid = ov.querySelector('#pickerGrid');
  if(!list.length){
    grid.innerHTML = '<p class="assets-empty">No matching assets yet. Use "Upload new…" or add some via menu → Manage VR Assets.</p>';
  } else {
    for(const a of list){
      const card = document.createElement('div');
      card.className = 'asset-card' + (a.id === curId ? ' asset-card-current' : '');
      card.innerHTML = `
        <div class="asset-thumb">${a.image ? `<img src="${a.image}" alt="">` : ''}</div>
        <div class="asset-id">${esc(a.id)}${a.id === curId ? ' ✓' : ''}</div>
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
