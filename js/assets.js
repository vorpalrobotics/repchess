/* ---------- Asset Manager ----------
   Staging registry for three.js art assets (PNG + JSON pairs) — see
   Documents/three-assets.md for the authoritative file-pair schema this
   mirrors. Assets live in IndexedDB (the 'assets' store, see js/db.js)
   while being authored; "Export" turns each one into a real
   <id>.png + <id>.json download pair to commit under assets/three/.

   This module owns its own DOM (built once into the container element
   handed to openAssetManager, same pattern as js/threeVR.js) so it
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
  const grid = $('assetsGrid');
  if(!grid) return;   // standalone (grid-less) editor context, e.g. the New Asset modal opened from the asset picker
  grid.style.display = '';
  $('assetsEditor').style.display = 'none';
}

async function refreshGrid(){
  ASSETS = await getAllAssets();
  renderGrid();
}

function renderGrid(){
  const grid = $('assetsGrid');
  if(!grid) return;   // standalone (grid-less) editor context -- nothing to render
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
function openEditor(id, initialType, allowTypes){
  EDIT_ID = id;
  const a = id ? ASSETS.find(x => x.id === id) : null;
  EDIT_IMAGE = (a && a.image) || '';
  EDIT_IMAGE_ORIG = '';                 // no original until a fresh upload this session
  EDIT_RESOLUTION = (a && a.resolution) || RESOLUTION_DEFAULT;
  EDIT_IMG_W = EDIT_IMG_H = 0;
  renderEditor(a, initialType, allowTypes);
  const grid = $('assetsGrid');
  if(grid) grid.style.display = 'none';
  $('assetsEditor').style.display = '';
  updateImgInfo();   // measure the staged image → fills the dims note (no size snap on open)
}

function renderEditor(a, initialType, allowTypes){
  const type = (a && a.type) || initialType || 'extruded';
  // when opened for a specific slot (e.g. the picker's "New Asset…" button),
  // restrict the type choices to what that slot actually accepts -- picking
  // something outside that set would save fine but then never show up back
  // in the picker (its grid filters by the same allow list), with nothing
  // telling the user why.
  const typeEntries = (allowTypes && allowTypes.length)
    ? Object.entries(ASSET_TYPES).filter(([t]) => allowTypes.includes(t))
    : Object.entries(ASSET_TYPES);
  const editor = $('assetsEditor');
  editor.innerHTML = `
    <div class="field">
      <label>Asset id (filename, lowercase-with-dashes)</label>
      <input type="text" id="assetIdInput" placeholder="grandfather-clock-style-1" value="${esc((a && a.id) || '')}" ${a ? 'disabled' : ''}>
    </div>
    <div class="field">
      <label>Type</label>
      <select id="assetTypeInput">
        ${typeEntries.map(([t,info]) => `<option value="${t}" ${t===type?'selected':''}>${esc(info.label)}</option>`).join('')}
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
            <button type="button" id="assetGenBtn"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate…</button>
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

  $('assetGenBtn').onclick = openGenerateModal;
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
      is stretched to fill the opening and is visible from both sides. Every door skin
      already renders 3% larger than the opening so a normal rectangular door hides its
      own seam; if this asset has art (columns, a base) that extends past its own plain
      rectangle and still shows a gap, add extra oversize here on top of that.</p>
      <div class="field"><label>Extra oversize (%)</label><input type="number" step="1" min="0" id="assetOversizePct" value="${(a && a.oversizePct) || 0}"></div>
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

/* Whether this browser can *encode* WebP from a canvas. Decoding is universal
   (Safari 14+), but canvas encoding only landed in Safari 17 -- older Safari
   silently returns a PNG from toDataURL('image/webp'), so we sniff the result.
   Cached after the first check. */
let _webpEncodeOk = null;
export function webpEncodeSupported(){
  if(_webpEncodeOk !== null) return _webpEncodeOk;
  try{
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    _webpEncodeOk = c.toDataURL('image/webp').startsWith('data:image/webp');
  }catch(_){ _webpEncodeOk = false; }
  return _webpEncodeOk;
}

/* Re-encode a data-URL as WebP, preserving alpha (WebP keeps transparency,
   which is why JPEG can't be used for cutout props/signs). Returns the input
   unchanged when WebP encoding isn't supported, when it's already WebP, or when
   the re-encode wouldn't actually be smaller. quality applies to the lossy
   colour channels; the alpha channel is preserved regardless. */
export function toWebpDataUrl(dataUrl, quality = 0.85){
  return new Promise((resolve, reject) => {
    if(!dataUrl || !webpEncodeSupported() || /^data:image\/webp/i.test(dataUrl)){ resolve(dataUrl); return; }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      let out;
      try{ out = c.toDataURL('image/webp', quality); }
      catch(_){ resolve(dataUrl); return; }
      // base64 length is proportional to byte size; keep whichever is smaller
      resolve(out && out.length < dataUrl.length ? out : dataUrl);
    };
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = dataUrl;
  });
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

// stage a full-resolution image data-URL into the editor (kept as the original,
// down-converted for the working copy), refresh the preview/dims, and seed the
// id from `nameHint` when creating a new asset. Shared by the file drop and the
// AI generate flow.
async function stageFullImage(fullDataUrl, nameHint){
  EDIT_IMAGE_ORIG = fullDataUrl;
  EDIT_IMAGE = await downscaleDataUrl(EDIT_IMAGE_ORIG, resolutionCap(editorType(), EDIT_RESOLUTION));
  setError('');
  const drop = $('assetImgDrop');
  if(drop) drop.innerHTML = `<img id="assetImgPreview" src="${EDIT_IMAGE}">`;
  await updateImgInfo();      // refresh dims/aspect note for the new image…
  snapHeightFromWidth();      // …and pull height to match it if the lock is on
  if(!EDIT_ID && nameHint){
    const idInput = $('assetIdInput');
    if(idInput && !idInput.value.trim()){
      let base = String(nameHint).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
      if(!ID_RE.test(base)) base = 'asset';
      idInput.value = base;
    }
  }
}

async function handleImageFile(file){
  if(!file) return;
  if(!file.type.startsWith('image/')){ setError('that file is not an image'); return; }
  if(file.size > IMG_MAX_FILE_BYTES){ setError(`image too large (max ${IMG_MAX_FILE_BYTES/1024/1024}MB)`); return; }
  try{
    await stageFullImage(await fileToDataUrl(file), file.name.replace(/\.[^.]+$/, ''));
  }catch(err){
    console.error('[assets] image import failed', err);
    setError('could not read that image');
  }
}

function setError(msg){ $('assetsError').textContent = msg || ''; }
function setCropHint(msg){ const el = $('assetCropHint'); if(el) el.textContent = msg || ''; }

/* ---------- AI image generation (OpenAI gpt-image-1) ----------
   A small modal launched from the editor's "Generate…" button: prompt + API key
   (kept in localStorage so it's typed once), calls OpenAI's images endpoint from
   the browser, previews the result, and on "Use this image" stages it into the
   editor exactly like a dropped file. GPT only for now. */
const OPENAI_KEY_LS = 'repchess.openaiApiKey';
const OPENAI_STANDING_LS = 'repchess.genStandingInstructions';
const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';
function openGenerateModal(){
  let ov = document.getElementById('assetGenOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'assetGenOverlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:130;display:flex;align-items:center;'
      + 'justify-content:center;background:rgba(0,0,0,.6)';
    document.body.appendChild(ov);
  }
  let savedKey = '', savedStanding = '';
  try { savedKey = localStorage.getItem(OPENAI_KEY_LS) || ''; } catch(_){}
  try { savedStanding = localStorage.getItem(OPENAI_STANDING_LS) || ''; } catch(_){}
  ov.innerHTML = `
    <div style="background:#1c1f26;color:#eee;width:min(34em,94vw);max-height:92vh;overflow:auto;
                border-radius:8px;padding:1rem 1.1rem;font:400 .9rem/1.4 sans-serif;box-shadow:0 8px 40px rgba(0,0,0,.5)">
      <h2 style="margin:.1rem 0 .7rem;font-size:1.1rem">Generate image with GPT</h2>
      <label style="display:block;font-size:.78rem;margin:0 0 .15rem">OpenAI API key</label>
      <input type="password" id="genApiKey" value="${esc(savedKey)}" placeholder="sk-…" autocomplete="off"
             style="width:100%;box-sizing:border-box">
      <div style="font-size:.68rem;color:#9aa;margin:.15rem 0 .6rem">Stored only in this browser (localStorage) and sent straight to OpenAI.</div>
      <label style="display:block;font-size:.78rem;margin:0 0 .15rem">Prompt</label>
      <textarea id="genPrompt" rows="3" placeholder="e.g. a friendly cartoon grandfather clock, front view, simple, centered"
                style="width:100%;box-sizing:border-box;resize:vertical"></textarea>
      <label style="display:block;font-size:.78rem;margin:.5rem 0 .15rem">Standing instructions
        <span style="color:#9aa;font-weight:400">— style applied to every generation</span></label>
      <textarea id="genStanding" rows="2" placeholder="e.g. flat cartoon style, thick outlines, bright colors, no text"
                style="width:100%;box-sizing:border-box;resize:vertical">${esc(savedStanding)}</textarea>
      <div style="font-size:.68rem;color:#9aa;margin:.15rem 0 0">Saved in this browser and appended to every prompt.</div>
      <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin:.5rem 0 .6rem;font-size:.78rem">
        <label><input type="checkbox" id="genTransparent" checked> Transparent background</label>
        <label>Size
          <select id="genSize" style="font-size:.78rem">
            <option value="1024x1024" selected>Square</option>
            <option value="1024x1536">Portrait</option>
            <option value="1536x1024">Landscape</option>
          </select>
        </label>
      </div>
      <div style="display:flex;gap:.4rem">
        <button type="button" id="genRunBtn">Generate</button>
        <button type="button" id="genCloseBtn">Cancel</button>
      </div>
      <div id="genStatus" style="font-size:.78rem;color:#9aa;min-height:1.1em;margin-top:.5rem"></div>
      <div id="genResultWrap" style="display:none;margin-top:.4rem">
        <div style="background:repeating-conic-gradient(#3a3a3a 0 25%, #2a2a2a 0 50%) 50%/22px 22px;
                    border-radius:4px;padding:.4rem;text-align:center">
          <img id="genResultImg" alt="" style="max-width:100%;max-height:44vh;border-radius:2px">
        </div>
        <div style="display:flex;gap:.5rem;align-items:center;margin-top:.5rem">
          <button type="button" id="genUseBtn">Use this image</button>
          <span style="font-size:.72rem;color:#9aa">or tweak the prompt and Generate again</span>
        </div>
      </div>
    </div>`;
  ov.style.display = 'flex';
  const q = id => ov.querySelector('#' + id);
  let lastDataUrl = null;
  const close = () => { ov.style.display = 'none'; ov.innerHTML = ''; };
  q('genCloseBtn').onclick = close;
  ov.onclick = e => { if(e.target === ov) close(); };

  q('genRunBtn').onclick = async () => {
    const key = q('genApiKey').value.trim();
    const prompt = q('genPrompt').value.trim();
    const standing = q('genStanding').value.trim();
    if(!key){ q('genStatus').textContent = 'Enter your OpenAI API key.'; return; }
    if(!prompt){ q('genStatus').textContent = 'Enter a prompt.'; return; }
    try { localStorage.setItem(OPENAI_KEY_LS, key); } catch(_){}
    try { localStorage.setItem(OPENAI_STANDING_LS, standing); } catch(_){}
    const fullPrompt = standing ? `${prompt}\n\n${standing}` : prompt;   // per-image subject + standing style
    q('genRunBtn').disabled = true;
    q('genStatus').textContent = 'Generating… (usually 10–30s)';
    try {
      const body = { model: 'gpt-image-1', prompt: fullPrompt, n: 1, size: q('genSize').value };
      if(q('genTransparent').checked) body.background = 'transparent';   // png cutout, ideal for props
      const res = await fetch(OPENAI_IMAGES_URL, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(() => ({}));
      if(!res.ok){
        const msg = (json && json.error && json.error.message) || ('HTTP ' + res.status);
        q('genStatus').textContent = 'Error: ' + msg;
        return;
      }
      const b64 = json.data && json.data[0] && json.data[0].b64_json;
      if(!b64){ q('genStatus').textContent = 'No image returned.'; return; }
      lastDataUrl = 'data:image/png;base64,' + b64;
      q('genResultImg').src = lastDataUrl;
      q('genResultWrap').style.display = '';
      q('genStatus').textContent = 'Done — use it, or edit the prompt and generate again.';
    } catch(err){
      console.error('[assets] generate failed', err);
      q('genStatus').textContent = 'Request failed: ' + ((err && err.message) || err) + ' (network or CORS?)';
    } finally {
      q('genRunBtn').disabled = false;
    }
  };

  q('genUseBtn').onclick = async () => {
    if(!lastDataUrl) return;
    const hint = q('genPrompt').value.trim().split(/\s+/).slice(0, 5).join(' ');
    await stageFullImage(lastDataUrl, hint || 'generated');
    close();
  };
}

/* Generic crop modal: shows `sourceDataUrl` full-viewport with four draggable
   edge bars defining a crop rectangle, an Auto-crop button that snaps the bars
   to the transparent-margin bounds, and a Crop button that cuts the working
   image down to the current bars (repeatable). Resolves to the final cropped
   data-URL on Save, or null on Cancel (caller's image is left untouched).
   Shared by the asset editor's own openCropModal below and by the mnemonics
   move-image editor in app.js. */
const CROP_TOL_KEY = 'cropEraseTol';
const CROP_BRUSH_SIZE_KEY = 'cropBrushSize';

export function cropImage(sourceDataUrl){
  let ov = document.getElementById('cropOverlay');
  if(!ov){ ov = document.createElement('div'); ov.id = 'cropOverlay'; ov.className = 'overlay'; document.body.appendChild(ov); }
  ov.style.display = 'flex';

  let work = sourceDataUrl;             // current working data-URL (full-res when caller passed one)
  let sel = { l:0, t:0, r:1, b:1 };     // crop rectangle as fractions of `work`
  let natW = 0, natH = 0;

  let eraseMode = false;
  let brushMode = false;

  // undo/redo: one entry per real committed mutation (crop, a bucket-erase
  // click, or a batch of brush strokes) -- see pushHistory below.
  let history = [work];
  let historyIndex = 0;

  let savedTol = 32, savedBrushSize = 30;
  try{ const raw = localStorage.getItem(CROP_TOL_KEY); const t = raw == null ? NaN : Number(raw); if(Number.isFinite(t) && t >= 0 && t <= 120) savedTol = t; }catch(_){}
  try{ const raw = localStorage.getItem(CROP_BRUSH_SIZE_KEY); const b = raw == null ? NaN : Number(raw); if(Number.isFinite(b) && b >= 4 && b <= 200) savedBrushSize = b; }catch(_){}

  ov.innerHTML = `
    <div class="modal">
      <div class="crop-header">
        <h2>Edit image</h2>
        <span class="crop-dims" id="cropDims"></span>
      </div>
      <div class="crop-stage">
        <div class="crop-wrap" id="cropWrap">
          <img id="cropImg" src="${work}" alt="">
          <canvas id="cropBrushCanvas" class="crop-brush-canvas"></canvas>
          <div class="crop-sel" id="cropSel"></div>
          <div class="crop-bar l" data-edge="l"></div>
          <div class="crop-bar r" data-edge="r"></div>
          <div class="crop-bar t" data-edge="t"></div>
          <div class="crop-bar b" data-edge="b"></div>
          <div class="crop-brush-cursor" id="cropBrushCursor"></div>
        </div>
      </div>
      <div class="crop-actions">
        <button id="cropUndoBtn" title="Undo"><i class="fa-solid fa-rotate-left"></i></button>
        <button id="cropRedoBtn" title="Redo"><i class="fa-solid fa-rotate-right"></i></button>
        <button id="cropAutoBtn"><i class="fa-solid fa-wand-magic-sparkles"></i> Auto-crop</button>
        <button id="cropApplyBtn"><i class="fa-solid fa-scissors"></i> Crop</button>
        <button id="cropEraseBtn"><i class="fa-solid fa-eraser"></i> Erase BG</button>
        <span id="cropEraseTools" style="display:none;align-items:center;gap:.4rem;font-size:.85rem;color:#444">
          fuzz <input type="range" id="cropTol" min="0" max="120" value="${savedTol}" style="width:120px">
          <span id="cropTolVal" style="font-family:ui-monospace,monospace;min-width:2.2em">${savedTol}</span>
        </span>
        <button id="cropBrushBtn"><i class="fa-solid fa-paintbrush"></i> Brush erase</button>
        <span id="cropBrushTools" style="display:none;align-items:center;gap:.4rem;font-size:.85rem;color:#444">
          size <input type="range" id="cropBrushSizeInput" min="4" max="200" value="${savedBrushSize}" style="width:120px">
          <span id="cropBrushSizeVal" style="font-family:ui-monospace,monospace;min-width:2.6em">${savedBrushSize}px</span>
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
  const undoBtn = ov.querySelector('#cropUndoBtn');
  const redoBtn = ov.querySelector('#cropRedoBtn');

  function updateHistoryButtons(){
    undoBtn.disabled = historyIndex <= 0;
    redoBtn.disabled = historyIndex >= history.length - 1;
  }
  // records a new committed mutation as the next undo step, discarding any
  // "future" redo entries once the user has branched off from an undone
  // state by making a fresh edit (standard undo-stack behaviour).
  function pushHistory(newWork){
    if(newWork === history[historyIndex]) return;   // nothing actually changed
    history = history.slice(0, historyIndex + 1);
    history.push(newWork);
    historyIndex = history.length - 1;
    updateHistoryButtons();
  }
  async function gotoHistory(idx){
    if(idx < 0 || idx >= history.length) return;
    exitToolModesForHistoryNav();   // discard any uncommitted strokes/mode state first
    historyIndex = idx;
    work = history[historyIndex];
    sel = { l:0, t:0, r:1, b:1 };
    await new Promise(resolve => { img.addEventListener('load', resolve, { once:true }); img.src = work; });
    updateHistoryButtons();
  }

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
    if(brushMode) commitBrushCanvas();   // flush any pending strokes into `work` first
    if(sel.l <= 0 && sel.t <= 0 && sel.r >= 1 && sel.b >= 1) return;   // full image — nothing to cut
    work = await cropDataUrl(work, sel);
    sel = { l:0, t:0, r:1, b:1 };
    // wait for the reload (not just the assignment) -- callers that read natW/
    // natH or draw from `img` right after (brush mode's initBrushCanvas) need
    // them already updated to the post-crop size, not whatever they were a
    // moment ago. The persistent onload=onImgReady handler still fires too.
    await new Promise(resolve => { img.addEventListener('load', resolve, { once:true }); img.src = work; });
    pushHistory(work);
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
  tolEl.oninput = () => { tolVal.textContent = tolEl.value; try{ localStorage.setItem(CROP_TOL_KEY, tolEl.value); }catch(_){} };
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
    pushHistory(work);
    dims.textContent = `erased ${n.toLocaleString()} px — click more or SAVE`;
  });

  // Brush erase: a manual round eraser for the little artifacts flood-fill
  // can't reach (an isolated fleck not colour-connected to wherever you'd
  // click, or one that doesn't match the sampled colour within tolerance).
  // Draws directly onto a same-resolution canvas overlaid on the image (fast,
  // GPU-composited circles -- no per-pixel JS loop, unlike floodFillTransparent
  // -- so it stays smooth while dragging), using 'destination-out' to punch
  // the stroke to full transparency. The canvas is only synced back into
  // `work`/`img` (commitBrushCanvas) when something else needs the current
  // pixels -- leaving brush mode, Crop, Auto-crop, or SAVE -- not on every
  // stroke, which would mean an expensive PNG re-encode per mouse-move.
  const brushCanvas = ov.querySelector('#cropBrushCanvas');
  const brushCursor = ov.querySelector('#cropBrushCursor');
  const brushBtn = ov.querySelector('#cropBrushBtn');
  const brushTools = ov.querySelector('#cropBrushTools');
  const brushSizeInput = ov.querySelector('#cropBrushSizeInput');
  const brushSizeVal = ov.querySelector('#cropBrushSizeVal');
  let brushCtx = null;
  let brushDrawing = false;
  let brushLast = null;   // {x,y} in natural-pixel space, for gap-free interpolation between samples
  let brushDirty = false; // any stroke drawn since initBrushCanvas -- guards against pushing a no-op history entry

  const brushDiameter = () => Number(brushSizeInput.value) || 30;
  function initBrushCanvas(){
    brushCanvas.width = natW;
    brushCanvas.height = natH;
    brushCtx = brushCanvas.getContext('2d');
    brushCtx.clearRect(0, 0, natW, natH);
    brushCtx.drawImage(img, 0, 0, natW, natH);
    brushDirty = false;
  }
  // batches every stroke drawn during one brush-mode session into a single
  // undo step (pushHistory only fires when at least one stroke actually
  // happened, via brushDirty -- exiting brush mode without drawing anything
  // must not push a no-op history entry).
  function commitBrushCanvas(){
    if(!brushCtx) return;
    work = brushCanvas.toDataURL('image/png');
    img.src = work;   // hidden behind the still-visible brush canvas; harmless
    if(brushDirty){ pushHistory(work); brushDirty = false; }
  }
  // exits brush/erase mode for an undo/redo navigation WITHOUT committing --
  // any in-progress, uncommitted brush strokes are discarded rather than
  // baked into `work` as a side effect of navigating history.
  function exitToolModesForHistoryNav(){
    if(brushMode){
      brushMode = false;
      brushCtx = null;
      brushDirty = false;
      brushCanvas.style.display = 'none';
      brushCursor.style.display = 'none';
      img.style.visibility = '';
      img.style.cursor = '';
      brushTools.style.display = 'none';
      brushBtn.style.background = '';
      brushBtn.style.color = '';
    }
    if(eraseMode) setEraseMode(false);   // erase clicks are already atomic/committed, so this has no pending state to discard
  }
  function setBrushMode(on){
    if(on === brushMode) return;
    if(on){
      if(eraseMode) setEraseMode(false);   // mutually exclusive tool modes
      initBrushCanvas();
      brushCanvas.style.display = 'block';
      // the still-unmodified <img> sits directly behind the canvas -- a
      // punched-out (transparent) hole in the canvas would otherwise just
      // reveal the SAME un-erased pixel from the img underneath, so nothing
      // visibly changes until commitBrushCanvas() later updates img itself.
      // Hiding it lets a hole reveal the checkered stage background instead,
      // live, the same way the flood-fill bucket tool already shows erasure.
      img.style.visibility = 'hidden';
      img.style.cursor = 'none';
    } else {
      commitBrushCanvas();
      brushCanvas.style.display = 'none';
      brushCursor.style.display = 'none';
      img.style.visibility = '';
      img.style.cursor = '';
    }
    brushMode = on;
    brushTools.style.display = on ? 'inline-flex' : 'none';
    brushBtn.style.background = on ? '#1565c0' : '';
    brushBtn.style.color = on ? '#fff' : '';
    if(on) dims.textContent = 'drag over the image to erase';
    else paint();
  }
  brushSizeInput.oninput = () => { brushSizeVal.textContent = brushSizeInput.value + 'px'; try{ localStorage.setItem(CROP_BRUSH_SIZE_KEY, brushSizeInput.value); }catch(_){} };

  function naturalPointFromEvent(e){
    const r = wrap.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * natW, y: (e.clientY - r.top) / r.height * natH };
  }
  function updateBrushCursor(e){
    const r = wrap.getBoundingClientRect();
    const dia = brushDiameter() * (r.width / natW);   // natural px -> display px
    brushCursor.style.width = dia + 'px';
    brushCursor.style.height = dia + 'px';
    brushCursor.style.left = (e.clientX - r.left) + 'px';
    brushCursor.style.top = (e.clientY - r.top) + 'px';
  }
  function eraseCircle(x, y, radius){
    brushDirty = true;
    brushCtx.globalCompositeOperation = 'destination-out';
    brushCtx.beginPath();
    brushCtx.arc(x, y, radius, 0, Math.PI * 2);
    brushCtx.fill();
    brushCtx.globalCompositeOperation = 'source-over';
  }
  // stamps circles along the segment from `from` to `to` (a raw jump between
  // pointermove samples would otherwise leave gaps in a fast drag).
  function eraseStroke(from, to, radius){
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius / 3)));
    for(let i = 0; i <= steps; i++){
      const t = i / steps;
      eraseCircle(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius);
    }
  }
  wrap.addEventListener('pointermove', (e) => {
    if(!brushMode || !natW) return;
    brushCursor.style.display = 'block';
    updateBrushCursor(e);
    if(!brushDrawing || e.buttons !== 1) return;
    const p = naturalPointFromEvent(e);
    eraseStroke(brushLast || p, p, brushDiameter() / 2);
    brushLast = p;
  });
  wrap.addEventListener('pointerdown', (e) => {
    if(!brushMode || !natW || e.button !== 0) return;
    try{ wrap.setPointerCapture?.(e.pointerId); }catch(_){}
    brushDrawing = true;
    const p = naturalPointFromEvent(e);
    eraseCircle(p.x, p.y, brushDiameter() / 2);
    brushLast = p;
    e.preventDefault();
  });
  const endBrushStroke = () => { brushDrawing = false; brushLast = null; };
  wrap.addEventListener('pointerup', endBrushStroke);
  wrap.addEventListener('pointercancel', endBrushStroke);
  wrap.addEventListener('pointerleave', () => { brushCursor.style.display = 'none'; });

  updateHistoryButtons();

  return new Promise((resolve) => {
    undoBtn.onclick = () => gotoHistory(historyIndex - 1);
    redoBtn.onclick = () => gotoHistory(historyIndex + 1);
    ov.querySelector('#cropApplyBtn').onclick = () => applyCrop().catch(err => { console.error('[crop] crop failed', err); });
    ov.querySelector('#cropAutoBtn').onclick = async () => {
      try{
        if(brushMode) commitBrushCanvas();   // read the up-to-date pixels, not a stale pre-brush copy
        const b = await alphaBoundsFrac(work);
        if(!b){ dims.textContent = 'image is fully transparent — nothing to bound'; return; }
        sel = b; paint();
      }catch(err){ console.error('[crop] auto-crop bounds failed', err); }
    };
    eraseBtn.onclick = async () => {
      if(!eraseMode){
        if(brushMode) setBrushMode(false);   // mutually exclusive tool modes
        await applyCrop().catch(err => console.error('[crop] crop failed', err));  // bake in any pending crop before erasing
      }
      setEraseMode(!eraseMode);
    };
    brushBtn.onclick = async () => {
      if(!brushMode){ await applyCrop().catch(err => console.error('[crop] crop failed', err)); }  // bake in any pending crop before erasing
      setBrushMode(!brushMode);
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
  if(type === 'door') return { oversizePct: Number($('assetOversizePct').value) || 0 };
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
  const image = await toWebpDataUrl(EDIT_IMAGE);   // shrink on save, alpha preserved
  const patch = { type, keywords, image, resolution: EDIT_RESOLUTION, ...readTypeFields(type) };
  await setAsset(id, patch);
  await refreshGrid();
  showList();
  return id;   // lets a standalone caller (e.g. openNewAssetModal) know the save succeeded
}

async function deleteEditor(id){
  if(!confirm(`Delete asset "${id}"? This cannot be undone.`)) return;
  await deleteAsset(id);
  await refreshGrid();
  showList();
}

/* Standalone "New Asset" modal: the same id/type/keywords/resolution/image
   (upload, Generate…, Crop/Erase BG…) /size-fields editor as the full Asset
   Manager, but in its own focused overlay with no grid alongside it -- for
   callers (the asset picker's "New Asset" button) that just need to create
   one asset and get back its id, without detouring through the full manager.
   Reuses openEditor/renderEditor/saveEditor unchanged by temporarily
   repointing containerEl (and thus every $() lookup they make) at this
   overlay's own #assetsEditor host; showList()/renderGrid() are guarded to
   no-op when there's no #assetsGrid in the current container, so saveEditor's
   normal post-save calls stay harmless here. Resolves the new asset's id on
   Save, or null on Cancel. */
function openNewAssetModal(initialType, allowTypes){
  return new Promise((resolve) => {
    const prevContainer = containerEl;
    let ov = document.getElementById('assetNewOverlay');
    if(!ov){
      ov = document.createElement('div');
      ov.id = 'assetNewOverlay';
      ov.className = 'overlay';
      // above the asset picker (60) that opens it; below Crop/Erase (70) and
      // Generate… (130), both of which can be opened from within this editor.
      ov.style.zIndex = '62';
      document.body.appendChild(ov);
    }
    ov.innerHTML = `
      <div class="modal" style="width:min(38em,92vw);max-height:90vh;overflow:auto">
        <div class="assets-header">
          <h2>New Asset</h2>
          <button id="assetNewCloseBtn">Cancel</button>
        </div>
        <div id="assetsEditor" class="assets-editor"></div>
      </div>`;
    ov.style.display = 'flex';
    containerEl = ov;

    let settled = false;
    const finish = (id) => {
      if(settled) return;
      settled = true;
      ov.style.display = 'none';
      ov.innerHTML = '';
      containerEl = prevContainer;
      resolve(id || null);
    };

    openEditor(null, initialType, allowTypes);
    // renderEditor (inside openEditor) already wired Save/Cancel to
    // saveEditor()/showList() for the full-manager flow -- rewire both here
    // so this standalone modal resolves instead of just sitting there.
    ov.querySelector('#assetsSaveBtn').onclick = async () => {
      const id = await saveEditor();
      if(id) finish(id);
    };
    ov.querySelector('#assetsCancelBtn').onclick = () => finish(null);
    ov.querySelector('#assetNewCloseBtn').onclick = () => finish(null);
    ov.onclick = e => { if(e.target === ov) finish(null); };
  });
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
    // fixed-size panel, image is the whole skin -- oversizePct only when set
    if(a.oversizePct) json.oversizePct = a.oversizePct;
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
   layout editor in threeVR.js. Builds its own overlay on document.body
   (above whatever is open) so it has no static-markup dependency.

   opts = {
     allow:       array of asset types to show (null = all),
     allowRemove: show a "Remove" button (e.g. to clear a surface/slot),
     allowWord:   show a text-label field (move-object slots only) -- a
                  lightweight placeholder ("just the name of the thing") for
                  when making a real image isn't worth the time yet,
     currentWord: the slot's current manual label, if any (prefills the field),
     onPick:      fn(assetId)  — chosen an asset,
     onRemove:    fn()         — clicked Remove,
     onWordApply: fn(word)     — typed a label and clicked Apply (word may be
                  '' to clear it back to unfilled),
     onClose:     fn()         — always called once the picker closes
   }
*/
let pickerOpts = null;
let pickerSearchText = '';   // persists across re-renders within one open picker session, reset on each fresh open

export function openAssetPicker(opts){
  pickerOpts = opts || {};
  pickerSearchText = '';
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

let pickerAllAssets = [];   // cached from the current picker session's getAllAssets() call, so the search filter doesn't re-hit IDB per keystroke

async function renderPicker(ov){
  pickerAllAssets = await getAllAssets();
  const allow = pickerOpts.allow;
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
      <p style="margin:0 0 .4rem;font-size:.8rem;color:#666">${curLine}</p>
      <input type="text" id="pickerSearchInput" class="assets-search" placeholder="Search name / keywords…" value="${esc(pickerSearchText)}" style="width:100%;box-sizing:border-box;margin-bottom:.5rem">
      <div class="assets-body" style="overflow:auto">
        <div class="assets-grid" id="pickerGrid"></div>
      </div>
      ${pickerOpts.allowWord ? `
      <div style="display:flex;align-items:center;gap:.4rem;margin-top:.6rem">
        <input type="text" id="pickerWordInput" placeholder="…or just type a placeholder label (no image)" value="${esc(pickerOpts.currentWord || '')}" style="flex:1 1 auto;min-width:0">
        <button id="pickerWordApplyBtn">Apply</button>
      </div>` : ''}
      <div class="assets-editor-actions">
        <div class="left">
          <button id="pickerNewAssetBtn"><i class="fa-solid fa-plus"></i> New Asset…</button>
        </div>
        ${pickerOpts.allowRemove ? `<button id="pickerRemoveBtn" style="background:#c62828;color:#fff">${removeLabel}</button>` : ''}
      </div>
    </div>
  `;

  // rebuilds just #pickerGrid's contents from the current search text --
  // split out so typing in the search box doesn't tear down and rebuild the
  // whole modal (which would drop focus/cursor position every keystroke).
  function renderGridBody(){
    const grid = ov.querySelector('#pickerGrid');
    grid.innerHTML = '';
    let list = allow ? pickerAllAssets.filter(a => allow.includes(a.type)) : pickerAllAssets;
    if(pickerSearchText) list = list.filter(a => `${a.id} ${a.keywords || ''}`.toLowerCase().includes(pickerSearchText));
    list.sort((a,b) => a.id.localeCompare(b.id));
    if(pickerOpts.allowColor){
      const curIsColor = curId && curId[0] === '#';
      const card = document.createElement('div');
      card.className = 'asset-card asset-card-color' + (curIsColor ? ' asset-card-current' : '');
      card.innerHTML = `
        <div class="asset-thumb color-tile-thumb">${curIsColor ? `<div class="color-tile-current" style="background:${esc(curId)}"></div>` : '<i class="fa-solid fa-palette"></i>'}</div>
        <div class="asset-id">Color…${curIsColor ? ` ${esc(curId)} ✓` : ''}</div>
        <div class="asset-type">Flat color</div>
      `;
      card.onclick = () => {
        const { onPick, onRemove, allowRemove } = pickerOpts;
        closePicker();
        openColorSwatchPicker({
          current: curIsColor ? curId : null,
          onPick: hex => { if(onPick) onPick(hex); },
          onRemove: allowRemove ? () => { if(onRemove) onRemove(); } : null,
        });
      };
      grid.appendChild(card);
    }
    // "Tint…" recolors whatever real asset is already assigned, in place, as a
    // per-placement override -- distinct from "Color…" above, which replaces
    // the surface with a flat color outright. Only offered once a real asset
    // (not a flat color, not empty) is actually assigned to recolor.
    if(pickerOpts.allowTint && curId && curId[0] !== '#'){
      const curTint = pickerOpts.currentTint || null;
      const card = document.createElement('div');
      card.className = 'asset-card asset-card-tint' + (curTint ? ' asset-card-current' : '');
      card.innerHTML = `
        <div class="asset-thumb color-tile-thumb">${curTint ? `<div class="color-tile-current" style="background:${esc(curTint)}"></div>` : '<i class="fa-solid fa-fill-drip"></i>'}</div>
        <div class="asset-id">Tint…${curTint ? ` ${esc(curTint)} ✓` : ''}</div>
        <div class="asset-type">Recolor this asset</div>
      `;
      card.onclick = () => {
        const { onTintPick, onTintRemove } = pickerOpts;
        closePicker();
        openColorSwatchPicker({
          current: curTint,
          onPick: hex => { if(onTintPick) onTintPick(hex); },
          onRemove: curTint ? () => { if(onTintRemove) onTintRemove(); } : null,
        });
      };
      grid.appendChild(card);
    }
    if(!list.length){
      const p = document.createElement('p');
      p.className = 'assets-empty';
      p.textContent = pickerSearchText
        ? `No assets match "${pickerSearchText}".`
        : 'No matching assets yet. Use "New Asset…" or add some via menu → Manage VR Assets.';
      grid.appendChild(p);
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
  }
  renderGridBody();

  ov.querySelector('#pickerSearchInput').oninput = e => {
    pickerSearchText = e.target.value.trim().toLowerCase();
    renderGridBody();
  };
  ov.querySelector('#pickerCloseBtn').onclick = () => closePicker();
  ov.querySelector('#pickerNewAssetBtn').onclick = async () => {
    const initialType = (pickerOpts.allow && pickerOpts.allow[0]) || 'extruded';
    const newId = await openNewAssetModal(initialType, pickerOpts.allow);
    if(newId) await renderPicker(ov);   // refresh so the new asset shows up for the user to pick
  };
  if(pickerOpts.allowRemove){
    ov.querySelector('#pickerRemoveBtn').onclick = () => { const cb = pickerOpts.onRemove; closePicker(); if(cb) cb(); };
  }
  if(pickerOpts.allowWord){
    ov.querySelector('#pickerWordApplyBtn').onclick = () => {
      const word = ov.querySelector('#pickerWordInput').value.trim();
      const cb = pickerOpts.onWordApply;
      closePicker();
      if(cb) cb(word);
    };
  }
}

/* ---------- surface color picker ----------
   A flat-color alternative to picking an image asset, reached via the "Color…"
   tile the asset picker prepends when opened with allowColor:true (floor/wall/
   ceiling/stair surfaces in threeVR.js). The chosen hex is handed back through
   the SAME onPick(id) callback the picker itself would have used -- threeVR
   stores it in the identical LAYOUT slot an asset id goes in, distinguishing
   the two by the leading '#' (never valid in an asset id, see ID_RE). */
const HEX_RE = /^#[0-9a-f]{6}$/i;
const RECENT_COLORS_KEY = 'recentSurfaceColors';
const RECENT_COLORS_MAX = 8;

// Curated for walls/ceilings: mostly pale/muted (pastel-leaning), with a
// handful of bolder accents mixed in for rooms that want more punch.
const PRESET_SURFACE_COLORS = [
  '#f5f0e8', '#eee8dd', '#e8e0d0', '#ded4c0', '#e0e0d8', '#e8e8e8', '#d8dcdc', '#c8ccd0',
  '#e3d5c8', '#f0e0d0', '#e8d5d0', '#e8c8c8', '#d8c5c8', '#dcd0e0', '#d0c8e0', '#d5d8e8',
  '#d0dce8', '#c8dce0', '#d0e0d5', '#c0d8d0', '#d8e0c8', '#e5e0c0',
  '#7d9db5', '#8fae7d', '#b57d7d', '#a58dc0', '#c9a55c',
];

async function getRecentColors(){
  try { return JSON.parse(await getMeta(RECENT_COLORS_KEY) || '[]'); }
  catch { return []; }
}
async function addRecentColor(hex){
  const list = (await getRecentColors()).filter(c => c.toLowerCase() !== hex.toLowerCase());
  list.unshift(hex);
  await setMeta(RECENT_COLORS_KEY, JSON.stringify(list.slice(0, RECENT_COLORS_MAX)));
}

/* opts = { current: '#hex'|null, onPick: fn(hex), onRemove: fn()|null } */
async function openColorSwatchPicker(opts){
  let ov = document.getElementById('colorSwatchPickerOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'colorSwatchPickerOverlay';
    ov.className = 'overlay';
    ov.style.zIndex = '65';
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';
  const recent = await getRecentColors();
  const swatchRow = (colors) => colors.map(hex => `
    <div class="color-swatch${opts.current && opts.current.toLowerCase()===hex.toLowerCase() ? ' color-swatch-current' : ''}"
         style="background:${esc(hex)}" data-hex="${esc(hex)}" title="${esc(hex)}"></div>
  `).join('');
  ov.innerHTML = `
    <div class="modal" style="width:min(34em,92vw);max-height:88vh;display:flex;flex-direction:column">
      <div class="cp-header">
        <h2>Choose Color</h2>
        <button id="cswCancelBtn">Cancel</button>
      </div>
      ${recent.length ? `
        <p class="color-swatch-label">Recently used</p>
        <div class="color-swatch-grid">${swatchRow(recent)}</div>
      ` : ''}
      <p class="color-swatch-label">Presets</p>
      <div class="color-swatch-grid">${swatchRow(PRESET_SURFACE_COLORS)}</div>
      <div class="side-color-row" style="margin-top:.7rem">
        <div class="side-color-swatch" id="cswCustomSwatch"></div>
        <input type="text" id="cswHexInput" placeholder="#rrggbb" value="${esc(opts.current || '')}">
        <input type="color" id="cswNativeInput" value="${esc(opts.current || '#cccccc')}">
        <button id="cswApplyBtn">Apply</button>
      </div>
      <div class="assets-editor-actions">
        <div class="left"></div>
        ${opts.onRemove ? `<button id="cswRemoveBtn" style="background:#c62828;color:#fff">Remove color</button>` : ''}
      </div>
    </div>
  `;
  const close = () => { ov.style.display = 'none'; };
  const choose = (hex) => { addRecentColor(hex); close(); opts.onPick(hex); };
  ov.querySelectorAll('.color-swatch').forEach(el => {
    el.onclick = () => choose(el.dataset.hex);
  });
  const hexInput = ov.querySelector('#cswHexInput');
  const nativeInput = ov.querySelector('#cswNativeInput');
  const customSwatch = ov.querySelector('#cswCustomSwatch');
  const paintCustom = () => { customSwatch.style.background = HEX_RE.test(hexInput.value.trim()) ? hexInput.value.trim() : ''; };
  paintCustom();
  hexInput.oninput = () => { paintCustom(); if(HEX_RE.test(hexInput.value.trim())) nativeInput.value = hexInput.value.trim(); };
  nativeInput.oninput = () => { hexInput.value = nativeInput.value; paintCustom(); };
  ov.querySelector('#cswApplyBtn').onclick = () => {
    const hex = hexInput.value.trim();
    if(!HEX_RE.test(hex)){ alert('enter a color as #rrggbb'); return; }
    choose(hex);
  };
  ov.querySelector('#cswCancelBtn').onclick = close;
  if(opts.onRemove){
    ov.querySelector('#cswRemoveBtn').onclick = () => { close(); opts.onRemove(); };
  }
}
