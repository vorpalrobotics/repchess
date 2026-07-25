/* ---------- Object List Manager ----------
   Manages named, ordered "object lists" — the memory-palace mnemonic lists
   (Kitchen Fixtures, Planets, Solfège…) that get applied to castle room walls.
   See Documents/ObjectListsAndRoomAssignment.md for the design and
   Documents/MnemonicListDesignPrinciples.html for the ordering philosophy.

   This module owns the list database itself: JSON import, per-item asset
   binding, and the manager UI. VR room-assignment (picking which list skins
   a room's walls) is a separate later layer built on top of this data --
   see js/threeVR.js's openWallListsDialog/moveObjectListResolved/OBJECT_LISTS.

   Lists live in the 'objectLists' IndexedDB store (see js/db.js). Each item
   has an immutable `name` (the stable key an asset binding hangs off) and an
   optional `assetId` referencing the 'assets' store; null => text-label
   fallback in VR.

   Self-contained DOM (built once into the container handed to
   openObjectListManager), same pattern as js/assets.js and js/threeVR.js.
*/

const ORDERING_TYPES = {
  'canonical_sequence': 'Canonical sequence (culturally fixed — planets, scale, HOMES)',
  'adapted_cultural':   'Adapted cultural (a familiar phrase lightly modified)',
  'procedural':         'Procedural (process / workflow order)',
  'natural_ordering':   'Natural ordering (size, age, distance, …)',
  'generated_mnemonic': 'Generated mnemonic (order chosen to make an acronym — last resort)',
};

const MNEMONIC_TYPES = {
  'existing_phrase':        'Existing phrase (widely known sentence mnemonic)',
  'existing_acronym':       'Existing acronym (HOMES, ROYGBIV, FACE)',
  'existing_song':          'Existing song (Do-Re-Mi)',
  'adapted_existing_phrase':'Adapted phrase (familiar phrase, minimally changed)',
  'generated_phrase':       'Generated phrase (newly invented — weakest)',
};

let containerEl = null;
let LISTS = [];        // cached array of all objectLists records
let ASSETS = [];       // cached array of all asset records (for the picker + thumbnails)
let EDIT = null;       // working copy of the list being edited, or null when showing the index
let EDIT_IS_NEW = false;
let PICK_CB = null;    // pending asset-picker callback
let FILTER_TEXT = '';

function $(id){ return containerEl.querySelector(`#${id}`); }
function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function slug(s){ return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''); }
function assetById(id){ return id ? ASSETS.find(a => a.id === id) : null; }

export async function openObjectListManager(container){
  containerEl = container;
  if(!containerEl.dataset.built){
    buildShell();
    containerEl.dataset.built = '1';
  }
  EDIT = null;
  await refresh();
}

export function closeObjectListManager(){
  // nothing running outside containerEl to tear down
}

/* ---------- shell ---------- */
function buildShell(){
  containerEl.innerHTML = `
    <div class="assets-toolbar">
      <input type="text" id="objlistFilterText" class="assets-search" placeholder="Search name / room / category…">
      <span class="assets-count" id="objlistCount"></span>
      <span class="assets-spacer"></span>
      <button id="objlistNewBtn"><i class="fa-solid fa-plus"></i> New List</button>
      <button id="objlistImportBtn" title="Import a room-database JSON (preserves existing image bindings by item name)"><i class="fa-solid fa-file-import"></i> Import JSON</button>
      <input type="file" id="objlistImportFile" accept="application/json,.json" style="display:none">
    </div>
    <div class="assets-body">
      <div class="assets-grid" id="objlistGrid"></div>
      <div class="assets-editor" id="objlistEditor" style="display:none"></div>
    </div>
    <div id="objlistPickOverlay" class="objlist-pick-overlay" style="display:none">
      <div class="objlist-pick-modal">
        <div class="objlist-pick-head">
          <strong>Pick an image asset</strong>
          <input type="text" id="objlistPickFilter" class="assets-search" placeholder="Search assets…">
          <button id="objlistPickNone">Use word only (no image)</button>
          <button id="objlistPickCancel">Cancel</button>
        </div>
        <div class="assets-grid" id="objlistPickGrid"></div>
      </div>
    </div>
  `;
  $('objlistFilterText').oninput = e => { FILTER_TEXT = e.target.value.trim().toLowerCase(); renderGrid(); };
  $('objlistNewBtn').onclick = () => openEditor(null);
  $('objlistImportBtn').onclick = () => $('objlistImportFile').click();
  $('objlistImportFile').addEventListener('change', onImportFile);
  $('objlistPickCancel').onclick = () => closePicker(undefined);
  $('objlistPickNone').onclick = () => closePicker(null);
  $('objlistPickFilter').oninput = () => renderPickGrid($('objlistPickFilter').value.trim().toLowerCase());
}

async function refresh(){
  [LISTS, ASSETS] = await Promise.all([getAllObjectLists(), getAllAssets()]);
  if(EDIT) renderEditor(); else showIndex();
}

function showIndex(){
  $('objlistGrid').style.display = '';
  $('objlistEditor').style.display = 'none';
  renderGrid();
}

/* ---------- index ---------- */
function renderGrid(){
  const grid = $('objlistGrid');
  let visible = LISTS.slice();
  if(FILTER_TEXT){
    visible = visible.filter(l =>
      `${l.name} ${l.roomName} ${l.category}`.toLowerCase().includes(FILTER_TEXT));
  }
  $('objlistCount').textContent = `${visible.length} list${visible.length===1?'':'s'}`;
  if(!visible.length){
    grid.innerHTML = '<p class="assets-empty">No object lists yet. Click "New List", or "Import JSON" to load a room database.</p>';
    return;
  }
  grid.innerHTML = '';
  for(const l of visible.sort((a,b)=>(a.name||'').localeCompare(b.name||''))){
    const items = l.items || [];
    const bound = items.filter(it => it.assetId).length;
    const card = document.createElement('div');
    card.className = 'asset-card objlist-card';
    card.innerHTML = `
      <div class="objlist-card-name">${esc(l.name || '(unnamed)')}</div>
      <div class="objlist-card-meta">${esc(l.roomName || '')}${l.category ? ' · '+esc(l.category) : ''}</div>
      <div class="objlist-card-items">${items.map(it => esc(it.name)).join(' · ') || '(no items)'}</div>
      ${l.mnemonic && l.mnemonic.phrase ? `<div class="objlist-card-mnem">“${esc(l.mnemonic.phrase)}”</div>` : ''}
      <div class="objlist-card-count">${items.length} item${items.length===1?'':'s'} · ${bound}/${items.length} image${items.length===1?'':'s'}</div>
    `;
    card.onclick = () => openEditor(l.id);
    grid.appendChild(card);
  }
}

/* ---------- editor ---------- */
function openEditor(id){
  const src = id ? LISTS.find(l => l.id === id) : null;
  EDIT_IS_NEW = !src;
  // deep-ish clone so edits are staged until Save
  EDIT = src ? JSON.parse(JSON.stringify(src)) : {
    id:'', name:'', roomName:'', category:'',
    orderingType:'generated_mnemonic', orderingRule:'',
    items:[],
    mnemonic:{ type:'generated_phrase', initialism:'', phrase:'', source:'' }
  };
  if(!EDIT.mnemonic) EDIT.mnemonic = { type:'generated_phrase', initialism:'', phrase:'', source:'' };
  if(!Array.isArray(EDIT.items)) EDIT.items = [];
  // defensive string coercion: a record written straight to IDB outside this
  // editor (e.g. js/app.js's backup-restore path, which upserts a backup's
  // objectLists entries with no shaping) can have any of these fields
  // missing or explicitly null. Left unguarded, that shows as the literal
  // text "undefined"/"null" in the field here, and throws an uncaught
  // TypeError from .trim() the moment Save is clicked.
  for(const f of ['id','name','roomName','category','orderingRule']) EDIT[f] = EDIT[f] || '';
  $('objlistGrid').style.display = 'none';
  $('objlistEditor').style.display = '';
  renderEditor();
}

function renderEditor(){
  const l = EDIT;
  const editor = $('objlistEditor');
  editor.innerHTML = `
    <div class="field">
      <label>List id</label>
      <input type="text" id="ol_id" placeholder="kitchen_major_fixtures (lowercase, unique)" value="${esc(l.id)}" ${EDIT_IS_NEW ? '' : 'disabled'}>
    </div>
    <div class="field">
      <label>List name</label>
      <input type="text" id="ol_name" placeholder="Major Fixtures" value="${esc(l.name)}">
    </div>
    <div class="field">
      <label>Room name</label>
      <input type="text" id="ol_room" placeholder="Kitchen" value="${esc(l.roomName)}">
    </div>
    <div class="field">
      <label>Category</label>
      <input type="text" id="ol_cat" placeholder="Home" value="${esc(l.category)}">
    </div>
    <div class="field">
      <label>Ordering type</label>
      <select id="ol_otype">
        ${Object.entries(ORDERING_TYPES).map(([t,lab]) => `<option value="${t}" ${t===l.orderingType?'selected':''}>${esc(lab)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>Ordering rule</label>
      <input type="text" id="ol_orule" placeholder="Food lifecycle: retrieve → prep → cook → clean" value="${esc(l.orderingRule)}">
    </div>

    <h3 class="objlist-h3">Items (in order — each anchors one move-pair)</h3>
    <p class="objlist-hint">Item names are immutable binding keys: to “rename”, remove and re-add (the image binding is dropped on purpose). Reorder with the arrows.</p>
    <table class="objlist-items">
      <thead><tr><th>#</th><th>Object</th><th>Image asset</th><th></th></tr></thead>
      <tbody id="ol_items"></tbody>
    </table>
    <div class="objlist-additem">
      <input type="text" id="ol_newitem" placeholder="Add an object (e.g. Oven)…">
      <button id="ol_additembtn"><i class="fa-solid fa-plus"></i> Add item</button>
    </div>

    <h3 class="objlist-h3">Mnemonic (optional)</h3>
    <div class="field">
      <label>Type</label>
      <select id="ol_mtype">
        ${Object.entries(MNEMONIC_TYPES).map(([t,lab]) => `<option value="${t}" ${t===l.mnemonic.type?'selected':''}>${esc(lab)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>Initialism</label>
      <input type="text" id="ol_minit" placeholder="RCOSD" value="${esc(l.mnemonic.initialism||'')}">
    </div>
    <div class="field">
      <label>Phrase</label>
      <input type="text" id="ol_mphrase" placeholder="Raw Chicken, Oven-baked. Soapy Dish." value="${esc(l.mnemonic.phrase||'')}">
    </div>
    <div class="field">
      <label>Source</label>
      <input type="text" id="ol_msource" placeholder="Project mnemonic" value="${esc(l.mnemonic.source||'')}">
    </div>

    <div class="assets-error" id="ol_error"></div>
    <div class="assets-editor-actions">
      <div class="left">
        <button id="ol_save">SAVE</button>
        <button id="ol_cancel">Cancel</button>
      </div>
      ${EDIT_IS_NEW ? '' : '<button id="ol_delete">Delete</button>'}
    </div>
  `;
  renderItems();

  // bind top-level fields into EDIT as they change
  $('ol_id').oninput      = e => { EDIT.id = e.target.value.trim(); };
  $('ol_name').oninput    = e => { EDIT.name = e.target.value; };
  $('ol_room').oninput    = e => { EDIT.roomName = e.target.value; };
  $('ol_cat').oninput     = e => { EDIT.category = e.target.value; };
  $('ol_otype').onchange  = e => { EDIT.orderingType = e.target.value; };
  $('ol_orule').oninput   = e => { EDIT.orderingRule = e.target.value; };
  $('ol_mtype').onchange  = e => { EDIT.mnemonic.type = e.target.value; };
  $('ol_minit').oninput   = e => { EDIT.mnemonic.initialism = e.target.value; };
  $('ol_mphrase').oninput = e => { EDIT.mnemonic.phrase = e.target.value; };
  $('ol_msource').oninput = e => { EDIT.mnemonic.source = e.target.value; };

  $('ol_additembtn').onclick = addItem;
  $('ol_newitem').onkeydown = e => { if(e.key === 'Enter'){ e.preventDefault(); addItem(); } };
  $('ol_save').onclick = saveEditor;
  $('ol_cancel').onclick = () => { EDIT = null; showIndex(); };
  if(!EDIT_IS_NEW) $('ol_delete').onclick = deleteEditor;
}

function renderItems(){
  const tb = $('ol_items');
  const items = EDIT.items;
  if(!items.length){
    tb.innerHTML = '<tr><td colspan="4" class="objlist-empty-row">No items yet — add objects below.</td></tr>';
    return;
  }
  tb.innerHTML = '';
  items.forEach((it, i) => {
    const a = assetById(it.assetId);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="objlist-num">${i+1}</td>
      <td class="objlist-name">${esc(it.name)}</td>
      <td class="objlist-asset">
        <div class="objlist-asset-cell">
          <span class="objlist-thumb">${a && a.image ? `<img src="${esc(a.image)}" alt="">` : '<span class="objlist-noimg">word only</span>'}</span>
          <span class="objlist-asset-id">${a ? esc(a.id) : (it.assetId ? `<em>missing: ${esc(it.assetId)}</em>` : '')}</span>
          <button class="objlist-mini" data-pick="${i}">${it.assetId ? 'Change' : 'Pick image'}</button>
          ${it.assetId ? `<button class="objlist-mini" data-clear="${i}">Clear</button>` : ''}
        </div>
      </td>
      <td class="objlist-rowtools">
        <button class="objlist-mini" data-up="${i}" ${i===0?'disabled':''}>↑</button>
        <button class="objlist-mini" data-down="${i}" ${i===items.length-1?'disabled':''}>↓</button>
        <button class="objlist-mini objlist-del" data-remove="${i}">✕</button>
      </td>
    `;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => openPicker(+b.dataset.pick));
  tb.querySelectorAll('[data-clear]').forEach(b => b.onclick = () => { EDIT.items[+b.dataset.clear].assetId = null; renderItems(); });
  tb.querySelectorAll('[data-up]').forEach(b => b.onclick = () => moveItem(+b.dataset.up, -1));
  tb.querySelectorAll('[data-down]').forEach(b => b.onclick = () => moveItem(+b.dataset.down, +1));
  tb.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => { EDIT.items.splice(+b.dataset.remove,1); renderItems(); });
}

function addItem(){
  const inp = $('ol_newitem');
  const name = inp.value.trim();
  if(!name) return;
  if(EDIT.items.some(it => it.name.toLowerCase() === name.toLowerCase())){
    setError(`"${name}" is already in this list (item names must be unique).`);
    return;
  }
  setError('');
  EDIT.items.push({ name, assetId:null });
  inp.value = '';
  renderItems();
  inp.focus();
}

function moveItem(i, dir){
  const j = i + dir;
  if(j < 0 || j >= EDIT.items.length) return;
  const t = EDIT.items[i]; EDIT.items[i] = EDIT.items[j]; EDIT.items[j] = t;
  renderItems();
}

/* ---------- asset picker (sub-overlay) ---------- */
function openPicker(itemIndex){
  PICK_CB = (assetId) => {
    if(assetId !== undefined){ EDIT.items[itemIndex].assetId = assetId; renderItems(); }
  };
  $('objlistPickFilter').value = '';
  renderPickGrid('');
  $('objlistPickOverlay').style.display = 'flex';
}

function closePicker(result){
  $('objlistPickOverlay').style.display = 'none';
  const cb = PICK_CB; PICK_CB = null;
  if(cb) cb(result);
}

function renderPickGrid(filter){
  const grid = $('objlistPickGrid');
  let visible = ASSETS.slice();
  if(filter) visible = visible.filter(a => `${a.id} ${a.keywords||''}`.toLowerCase().includes(filter));
  if(!visible.length){
    grid.innerHTML = '<p class="assets-empty">No matching assets. Add images in Manage VR Assets first.</p>';
    return;
  }
  grid.innerHTML = '';
  for(const a of visible.sort((x,y)=>x.id.localeCompare(y.id))){
    const card = document.createElement('div');
    card.className = 'asset-card';
    card.innerHTML = `
      <div class="asset-thumb">${a.image ? `<img src="${esc(a.image)}" alt="">` : ''}</div>
      <div class="asset-id">${esc(a.id)}</div>
    `;
    card.onclick = () => closePicker(a.id);
    grid.appendChild(card);
  }
}

/* ---------- save / delete ---------- */
function setError(msg){ const e = $('ol_error'); if(e) e.textContent = msg || ''; }

async function saveEditor(){
  const l = EDIT;
  l.id = (l.id||'').trim();
  if(!l.id){ setError('List id is required.'); return; }
  // lowercase alnum + underscores and/or dashes; double underscore is allowed
  // (import uses it as the room__list namespace separator). Must start with an
  // alphanumeric.
  if(!/^[a-z0-9][a-z0-9_-]*$/.test(l.id)){ setError('List id must be lowercase letters, numbers, underscores and dashes, starting with a letter or number.'); return; }
  if(EDIT_IS_NEW && LISTS.some(x => x.id === l.id)){ setError(`A list with id "${l.id}" already exists.`); return; }
  if(!l.name.trim()){ setError('List name is required.'); return; }
  // addItem already blocks a duplicate at entry time, but re-check here too --
  // item names are the immutable binding key everything else hangs off, so a
  // silent duplicate slipping through some other path (a future edit feature,
  // a bug) would be worse saved than caught.
  const seenNames = new Set();
  for(const it of l.items){
    const key = it.name.toLowerCase();
    if(seenNames.has(key)){ setError(`"${it.name}" appears more than once (item names must be unique).`); return; }
    seenNames.add(key);
  }
  setError('');
  await setObjectList(l.id, {
    name: l.name.trim(), roomName: l.roomName.trim(), category: l.category.trim(),
    orderingType: l.orderingType, orderingRule: l.orderingRule.trim(),
    items: l.items.map(it => ({ name: it.name, assetId: it.assetId || null })),
    mnemonic: {
      type: l.mnemonic.type,
      initialism: (l.mnemonic.initialism||'').trim(),
      phrase: (l.mnemonic.phrase||'').trim(),
      source: (l.mnemonic.source||'').trim()
    }
  });
  EDIT = null;
  await refresh();
}

async function deleteEditor(){
  if(!EDIT || EDIT_IS_NEW) return;
  if(!confirm(`Delete the list "${EDIT.name || EDIT.id}"? This cannot be undone.`)) return;
  await deleteObjectList(EDIT.id);
  EDIT = null;
  await refresh();
}

/* ---------- JSON import ----------
   Accepts the room-database format (see json/memory_palace_room_database.json):
   { rooms:[ { id, name, category, lists:[ { name, orderingType, orderingRule,
   items:[strings], mnemonic:{...} } ] } ] }. Also accepts a bare array of
   already-shaped objectLists records (our own export shape). Each list is
   upserted; existing per-item assetId bindings are preserved by matching the
   immutable item name. */

// True if `data` looks like an importable object-list file (room-database, a
// standalone objectLists array, or a bare array of list records). Deliberately
// false for a FULL backup (which carries `lines` + its own objectLists and is
// restored by the backup path) so the auto-detecting importer routes correctly.
export function isObjectListFile(data){
  if(!data || typeof data !== 'object') return false;
  if(Array.isArray(data.rooms)) return true;
  if(Array.isArray(data.objectLists) && !Array.isArray(data.lines)) return true;
  if(Array.isArray(data) && data.length &&
     data.every(l => l && typeof l === 'object' && l.id && Array.isArray(l.items))) return true;
  return false;
}

// Upserts the file's lists into the objectLists store, preserving existing
// per-item asset bindings by immutable item name. Reads the store directly (not
// the module cache) so it works whether or not the manager UI is open — the
// menu-level importer in app.js reuses this. Returns {added, updated, total, skipped}.
export async function importObjectListsData(data){
  const { lists: incoming, skipped } = normalizeImport(data);
  if(!incoming.length) return { added: 0, updated: 0, total: 0, skipped };
  const existingById = {};
  for(const l of await getAllObjectLists()) existingById[l.id] = l;

  let added = 0, updated = 0;
  for(const inc of incoming){
    const prev = existingById[inc.id];
    if(prev) updated++; else added++;
    const prevAssetByName = {};
    // keyed lower-case: item-name identity is case-insensitive everywhere
    // else in this file (addItem's dup check, saveEditor's dup check,
    // normalizeImport's own pushList dedup below) -- an exact-case lookup
    // here would silently drop an existing binding whenever a re-imported
    // item's name differs only in case from what was previously saved.
    if(prev) for(const it of (prev.items || [])) if(it.assetId) prevAssetByName[it.name.toLowerCase()] = it.assetId;
    const items = inc.items.map(it => ({
      name: it.name,
      assetId: (it.assetId || prevAssetByName[it.name.toLowerCase()] || null)
    }));
    await setObjectList(inc.id, {
      name: inc.name, roomName: inc.roomName, category: inc.category,
      orderingType: inc.orderingType, orderingRule: inc.orderingRule,
      items, mnemonic: inc.mnemonic
    });
  }
  return { added, updated, total: incoming.length, skipped };
}

async function onImportFile(e){
  const file = e.target.files[0];
  e.target.value = '';
  if(!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch(err){ alert('Could not parse JSON: ' + err.message); return; }

  const res = await importObjectListsData(data);
  if(!res.total){
    alert(res.skipped
      ? `No lists imported -- ${res.skipped} entr${res.skipped===1?'y':'ies'} had no id and were skipped.`
      : 'No lists found in that file.');
    return;
  }
  await refresh();
  alert(`Import complete: ${res.added} added, ${res.updated} updated` +
    (res.skipped ? `, ${res.skipped} skipped (no id)` : '') +
    `.\nExisting image bindings were preserved by item name.`);
}

function normalizeImport(data){
  const out = [];
  // auto-generated ids (list.id absent -- the room-database branch below) are
  // disambiguated against every id already produced THIS import, so two
  // different rooms that happen to slugify to the same room-name/list-name
  // pair (e.g. both missing room.id) don't silently clobber each other via
  // setObjectList's upsert. Explicit ids are left as-is -- a file explicitly
  // repeating one is the source data saying they're the same list.
  const usedAutoIds = new Set();
  const uniqueAutoId = (id) => {
    let candidate = id, n = 2;
    while(usedAutoIds.has(candidate)) candidate = `${id}-${n++}`;
    usedAutoIds.add(candidate);
    return candidate;
  };
  const pushList = (id, name, roomName, category, list) => {
    // item names are immutable binding keys -- a duplicate within one list
    // would be ambiguous to bind an image to, so keep the first occurrence
    // and drop later duplicates rather than importing something the editor's
    // own addItem() would never let you create by hand.
    const items = [];
    const seenNames = new Set();
    for(const it of (list.items||[])){
      const shaped = typeof it === 'string' ? { name: it, assetId: null }
                                             : { name: it.name, assetId: it.assetId || null };
      const key = shaped.name.toLowerCase();
      if(seenNames.has(key)) continue;
      seenNames.add(key);
      items.push(shaped);
    }
    out.push({
      id,
      name: name || list.name || id,
      roomName: roomName || '',
      category: category || '',
      orderingType: list.orderingType || 'generated_mnemonic',
      orderingRule: list.orderingRule || '',
      items,
      mnemonic: {
        type: (list.mnemonic && list.mnemonic.type) || 'generated_phrase',
        initialism: (list.mnemonic && list.mnemonic.initialism) || '',
        phrase: (list.mnemonic && list.mnemonic.phrase) || '',
        source: (list.mnemonic && list.mnemonic.source) || ''
      }
    });
  };

  // entries with no id (the only two branches where one isn't auto-generated)
  // are unusable -- setObjectList needs a key -- but dropping them with zero
  // indication looked like a clean import even when part of the file didn't
  // make it in, so the caller surfaces this count too.
  let skipped = 0;
  if(Array.isArray(data)){
    // bare array of already-shaped objectLists records
    for(const l of data){ if(l && l.id) pushList(l.id, l.name, l.roomName, l.category, l); else skipped++; }
  } else if(data && Array.isArray(data.rooms)){
    for(const room of data.rooms){
      const lists = room.lists || [];
      for(const list of lists){
        const id = list.id || uniqueAutoId(`${slug(room.id||room.name)}__${slug(list.name)}`);
        pushList(id, `${room.name || room.id}: ${list.name}`, room.name || room.id, room.category, list);
      }
    }
  } else if(data && Array.isArray(data.objectLists)){
    for(const l of data.objectLists){ if(l && l.id) pushList(l.id, l.name, l.roomName, l.category, l); else skipped++; }
  }
  return { lists: out, skipped };
}
