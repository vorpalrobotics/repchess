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
};

const IMG_MAX_DIM = 1024;               // staged image is downscaled to fit within this box
const IMG_MAX_FILE_BYTES = 15 * 1024 * 1024;
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

let containerEl = null;
let ASSETS = [];          // cached array of all asset records
let EDIT_ID = null;       // id of the asset currently open in the editor, or null = creating new
let EDIT_IMAGE = '';      // staged data-URL for the editor (kept separate so Cancel discards it)
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
  renderEditor(a);
  $('assetsGrid').style.display = 'none';
  $('assetsEditor').style.display = '';
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
      <label>Image (PNG, transparent background for props)</label>
      <div class="asset-img-drop" id="assetImgDrop">
        ${EDIT_IMAGE ? `<img id="assetImgPreview" src="${EDIT_IMAGE}">` : '<i class="fa-solid fa-image"></i>'}
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

  $('assetTypeInput').onchange = e => renderTypeFields(e.target.value, a);

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
        <div class="field"><label>Height (m)</label><input type="number" step="0.01" id="assetSizeH" value="${size.h ?? 1}"></div>
      </div>
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
}

/* downscale to fit within IMG_MAX_DIM x IMG_MAX_DIM (no cropping); PNG keeps
   alpha so billboard/sprite cutouts and box transparency survive. */
function resizeImageFile(file){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, IMG_MAX_DIM / img.width, IMG_MAX_DIM / img.height);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not decode image')); };
    img.src = url;
  });
}

async function handleImageFile(file){
  if(!file) return;
  if(!file.type.startsWith('image/')){ setError('that file is not an image'); return; }
  if(file.size > IMG_MAX_FILE_BYTES){ setError(`image too large (max ${IMG_MAX_FILE_BYTES/1024/1024}MB)`); return; }
  try{
    EDIT_IMAGE = await resizeImageFile(file);
    setError('');
    const drop = $('assetImgDrop');
    drop.innerHTML = `<img id="assetImgPreview" src="${EDIT_IMAGE}">`;
  }catch(err){
    console.error('[assets] image resize failed', err);
    setError('could not read that image');
  }
}

function setError(msg){ $('assetsError').textContent = msg || ''; }

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
  const patch = { type, image: EDIT_IMAGE, ...readTypeFields(type) };
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

export function openAssetPicker(opts){
  pickerOpts = opts || {};
  pickerUploadType = (pickerOpts.allow && pickerOpts.allow[0]) || 'box';
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
    const image = await resizeImageFile(file);
    await setAsset(id, { type: pickerUploadType, image });
    await renderPicker(ov);
  }catch(err){
    console.error('[assets] picker upload failed', err);
    alert('could not read that image');
  }
}
