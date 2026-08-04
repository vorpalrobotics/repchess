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
   db.js's IndexedDB helpers (getAllAssets, getAllObjectLists, ...) are a
   classic <script> global (see index.html), not an import, like every other
   module here -- but assets.js IS a real ES module, so its own standalone
   New Asset modal needs an actual import.
*/
import { openNewAssetModal } from './assets.js?v=20260804-78';

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

// Every full-screen overlay here closes on a "click the dark backdrop"
// gesture -- but a plain `ov.onclick = e => e.target === ov` check misfires
// on an ordinary text-selection DRAG that starts inside a field (e.g.
// sweep-selecting a name to overtype it) and ends with the mouse out over
// the backdrop: browsers fire the resulting "click" on the nearest common
// ancestor of the mousedown and mouseup targets, which IS the overlay itself
// once the drag has left the field, silently closing the modal and
// discarding all in-progress work. Only close when BOTH the mousedown and
// the click itself landed directly on the backdrop, not just the click.
// This overlay is a PERSISTENT singleton (document.getElementById(id) ||
// createElement, reused across many opens) -- re-wiring on every open would
// otherwise stack a fresh listener pair each time, each closing over that
// invocation's own `onClose`; storing the current pair on the element and
// removing it first keeps repeated calls idempotent.
function wireBackdropClose(ov, onClose){
  if(ov._backdropMousedown) ov.removeEventListener('mousedown', ov._backdropMousedown);
  if(ov._backdropClick) ov.removeEventListener('click', ov._backdropClick);
  let downOnBackdrop = false;
  ov._backdropMousedown = e => { downOnBackdrop = e.target === ov; };
  ov._backdropClick = e => { if(downOnBackdrop && e.target === ov) onClose(); };
  ov.addEventListener('mousedown', ov._backdropMousedown);
  ov.addEventListener('click', ov._backdropClick);
}

export async function openObjectListManager(container){
  containerEl = container;
  if(!containerEl.dataset.built){
    buildShell();
    containerEl.dataset.built = '1';
  }
  EDIT = null;
  SELECTED_CATEGORY = null;
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
      <button id="objlistCastleQuizBtn" title="Quiz every object list assigned anywhere in a chosen castle"><i class="fa-solid fa-graduation-cap"></i> Quiz a Castle…</button>
      <input type="file" id="objlistImportFile" accept="application/json,.json" style="display:none">
    </div>
    <div class="assets-body">
      <div id="objlistBreadcrumb" style="display:none;margin-bottom:.5rem"></div>
      <div class="assets-grid" id="objlistGrid"></div>
      <div class="assets-editor" id="objlistEditor" style="display:none"></div>
      <div class="assets-editor" id="objlistQuiz" style="display:none"></div>
    </div>
    <div id="objlistPickOverlay" class="objlist-pick-overlay" style="display:none">
      <div class="objlist-pick-modal">
        <div class="objlist-pick-head">
          <strong>Pick an image asset</strong>
          <input type="text" id="objlistPickFilter" class="assets-search" placeholder="Search assets…">
          <button id="objlistPickNewAsset"><i class="fa-solid fa-plus"></i> New Asset…</button>
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
  $('objlistCastleQuizBtn').onclick = () => openCastleQuizPicker();
  $('objlistImportFile').addEventListener('change', onImportFile);
  $('objlistPickCancel').onclick = () => closePicker(undefined);
  $('objlistPickNone').onclick = () => closePicker(null);
  $('objlistPickFilter').oninput = () => renderPickGrid($('objlistPickFilter').value.trim().toLowerCase());
  // "escape out" to the full New Asset editor without leaving the list
  // manager first -- previously the only way to get an image for a list
  // item was to cancel out, go to menu -> Manage VR Assets, create it
  // there, then come back and re-open this same picker. Reuses assets.js's
  // own standalone New Asset modal (already built for exactly this kind of
  // cross-module "just get me an id" reuse -- see its own doc comment).
  // Assigns the freshly-created asset straight to the item being picked for
  // and closes the picker, rather than just refreshing the grid for another
  // click -- it was made for this one slot, there's nothing left to decide.
  $('objlistPickNewAsset').onclick = async () => {
    const newId = await openNewAssetModal();
    if(newId){ ASSETS = await getAllAssets(); closePicker(newId); }
  };
}

async function refresh(){
  [LISTS, ASSETS] = await Promise.all([getAllObjectLists(), getAllAssets()]);
  if(EDIT) renderEditor(); else showIndex();
}

function showIndex(){
  const grid = $('objlistGrid');
  if(!grid) return;   // standalone (grid-less) editor context, e.g. the New List modal -- nothing to show
  grid.style.display = '';
  $('objlistEditor').style.display = 'none';
  renderGrid();
}

/* ---------- index ----------
   Two-level browse: a category grid (Home, Zoo, Art Museum, ...) at the top,
   drilling into one category's own list-cards on click -- the room database
   is large enough now (40+ lists across 8 categories) that one flat
   alphabetical grid buried everything together. SELECTED_CATEGORY (null =
   top-level) is module state so it survives a round-trip through the editor
   (Save/Cancel both funnel back through showIndex -> renderGrid). Typing in
   the filter box always searches ALL lists regardless of the current
   category -- search deliberately escapes browsing rather than being scoped
   to whatever category happens to be open. */
let SELECTED_CATEGORY = null;
function categoryOf(l){ return l.category || '(Uncategorized)'; }

function renderGrid(){
  const grid = $('objlistGrid');
  if(!grid) return;   // standalone (grid-less) editor context -- nothing to render
  const crumb = $('objlistBreadcrumb');
  if(FILTER_TEXT){
    crumb.style.display = 'none';
    const visible = LISTS.filter(l =>
      `${l.name} ${l.roomName} ${l.category}`.toLowerCase().includes(FILTER_TEXT));
    renderListCards(grid, visible);
    return;
  }
  const categoryCount = new Set(LISTS.map(categoryOf)).size;
  // 0 or 1 category total: nothing meaningful to choose between, so skip
  // straight to the list grid rather than showing a category picker with a
  // single (or no) option -- also keeps a single-category collection (a
  // fresh install with just Kitchen, say) exactly as simple as before.
  if(categoryCount <= 1){
    crumb.style.display = 'none';
    renderListCards(grid, LISTS);
    return;
  }
  if(SELECTED_CATEGORY === null){
    crumb.style.display = 'none';
    renderCategoryGrid(grid);
    return;
  }
  crumb.style.display = '';
  crumb.innerHTML = '';
  const back = document.createElement('button');
  back.innerHTML = '&larr; All Categories';
  back.onclick = () => { SELECTED_CATEGORY = null; renderGrid(); };
  crumb.appendChild(back);
  const label = document.createElement('strong');
  label.style.marginLeft = '.6rem';
  label.textContent = SELECTED_CATEGORY;
  crumb.appendChild(label);
  renderListCards(grid, LISTS.filter(l => categoryOf(l) === SELECTED_CATEGORY));
}

// one card per distinct category, alphabetical ((Uncategorized) last) --
// only ever called with 2+ categories (renderGrid skips straight to the
// list grid otherwise), so there's always at least one card to show.
function renderCategoryGrid(grid){
  const counts = new Map();
  for(const l of LISTS) counts.set(categoryOf(l), (counts.get(categoryOf(l)) || 0) + 1);
  const categories = [...counts.keys()].sort((a, b) => {
    if(a === '(Uncategorized)') return 1;
    if(b === '(Uncategorized)') return -1;
    return a.localeCompare(b);
  });
  $('objlistCount').textContent = `${categories.length} categories`;
  grid.innerHTML = '';
  for(const cat of categories){
    const n = counts.get(cat);
    const card = document.createElement('div');
    card.className = 'asset-card objlist-category-card';
    card.innerHTML = `
      <div class="objlist-category-name">${esc(cat)}</div>
      <div class="objlist-card-count">${n} list${n === 1 ? '' : 's'}</div>
    `;
    card.onclick = () => { SELECTED_CATEGORY = cat; renderGrid(); };
    grid.appendChild(card);
  }
}

// the list-card grid itself -- shared by the filtered (flat, cross-category)
// view and a single category's drilled-in view.
function renderListCards(grid, visible){
  $('objlistCount').textContent = `${visible.length} list${visible.length === 1 ? '' : 's'}`;
  if(!visible.length){
    grid.innerHTML = LISTS.length
      ? '<p class="assets-empty">No object lists match.</p>'
      : '<p class="assets-empty">No object lists yet. Click "New List", or "Import JSON" to load a room database.</p>';
    return;
  }
  grid.innerHTML = '';
  for(const l of visible.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))){
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
  const grid = $('objlistGrid');
  if(grid) grid.style.display = 'none';
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
    <p class="objlist-hint">Item names are immutable binding keys: to “rename”, remove and re-add (the image binding is dropped on purpose). Drag the grip icon to reorder.</p>
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
        ${l.items.length ? '<button id="ol_quiz"><i class="fa-solid fa-graduation-cap"></i> Quiz this list</button>' : ''}
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
  if(l.items.length) $('ol_quiz').onclick = () => openListQuiz(l);
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
    tr.className = 'objlist-row';
    tr.dataset.name = it.name;   // stable drag identity -- item names are already enforced unique
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
        <span class="objlist-grab" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
        <button class="objlist-mini objlist-del" data-remove="${i}">✕</button>
      </td>
    `;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => openPicker(+b.dataset.pick));
  tb.querySelectorAll('[data-clear]').forEach(b => b.onclick = () => { EDIT.items[+b.dataset.clear].assetId = null; renderItems(); });
  tb.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => { EDIT.items.splice(+b.dataset.remove,1); renderItems(); });
  tb.querySelectorAll('.objlist-grab').forEach(handle => handle.addEventListener('pointerdown', olGrabPointerDown));
}

/* ---------- list quiz ----------
   Recall drill over a set of items, in their own natural order (or shuffled,
   for a harder re-test) -- mirrors js/app.js's Opening Quiz shape (sequential
   questions, hit/miss tally, summary screen with a replay option) but tests
   raw list memorization rather than chess moves. Generalized over `entries`
   ({name, assetId, posLabel}) rather than one list's own items, so the SAME
   engine serves both "Quiz this list" (one list, EDIT's own possibly-unsaved
   working copy) and "Quiz a castle's lists" (every list actually assigned
   somewhere in a chosen castle, see openCastleQuiz below) -- `title` and
   `returnTo` (called on close) are the only things that differ between them.
   Answers are matched case-insensitively/trimmed, with a 3+ letter prefix
   also accepted (typing "hamp" for "Hamper") -- full typing rigor without
   making a long or oddly-spelled name tedious to answer. */
let QUIZ = null;   // { title, entries:[{name,assetId,posLabel}], order, idx, hits, misses, revealed, returnTo }

function shuffledOrder(n){
  const order = Array.from({length:n}, (_, i) => i);
  for(let i = order.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function startQuiz(title, entries, shuffled, returnTo){
  if(!entries.length) return;
  const order = shuffled ? shuffledOrder(entries.length) : entries.map((_, i) => i);
  QUIZ = { title, entries, order, idx: 0, hits: 0, misses: 0, revealed: false, returnTo };
  $('objlistGrid').style.display = 'none';
  $('objlistEditor').style.display = 'none';
  $('objlistQuiz').style.display = '';
  renderQuizStep();
}

// "Quiz this list": quizzes EDIT's own (possibly unsaved) working copy,
// since that's what's on screen -- each item's posLabel is just its own
// 1-based position in the list, matching the "position N" cue an unillustrated
// item shows.
function openListQuiz(list, shuffled=false){
  const entries = list.items.map((it, i) => ({ name: it.name, assetId: it.assetId, posLabel: '#' + (i + 1) }));
  startQuiz(list.name, entries, shuffled, () => {
    if(EDIT) $('objlistEditor').style.display = '';
    else showIndex();
  });
}

function closeQuiz(){
  const returnTo = QUIZ && QUIZ.returnTo;
  QUIZ = null;
  $('objlistQuiz').style.display = 'none';
  if(returnTo) returnTo(); else showIndex();
}

function renderQuizStep(){
  if(QUIZ.idx >= QUIZ.order.length){ renderQuizSummary(); return; }
  const entry = QUIZ.entries[QUIZ.order[QUIZ.idx]];
  const asset = assetById(entry.assetId);
  const el = $('objlistQuiz');
  el.innerHTML = `
    <h3 class="objlist-h3">Quiz: ${esc(QUIZ.title)}</h3>
    <div class="objlist-quiz-progress">Item ${QUIZ.idx + 1} of ${QUIZ.order.length} &middot; ${QUIZ.hits} correct, ${QUIZ.misses} missed</div>
    <div class="objlist-quiz-card">
      ${asset && asset.image
        ? `<img class="objlist-quiz-img" src="${esc(asset.image)}" alt="">`
        : `<div class="objlist-quiz-slot">${esc(entry.posLabel)}</div>`}
      <div class="objlist-quiz-prompt">${asset && asset.image ? 'What object is this?' : `What belongs at ${esc(entry.posLabel)}?`}</div>
      <input type="text" id="olq_answer" autocomplete="off" placeholder="Type your answer…">
      <div class="objlist-quiz-feedback" id="olq_feedback"></div>
      <div class="assets-editor-actions">
        <div class="left">
          <button id="olq_submit">Check</button>
          <button id="olq_skip">Skip</button>
        </div>
        <button id="olq_quit">Quit quiz</button>
      </div>
    </div>
  `;
  const input = $('olq_answer');
  input.focus();
  $('olq_submit').onclick = () => checkQuizAnswer(entry.name);
  $('olq_skip').onclick = () => { QUIZ.misses++; revealAnswer(false, entry.name); };
  $('olq_quit').onclick = closeQuiz;
  input.onkeydown = e => {
    if(e.key !== 'Enter') return;
    e.preventDefault();
    if(QUIZ.revealed) advanceQuiz(); else checkQuizAnswer(entry.name);
  };
}

// exact match always counts; a case-insensitive PREFIX of at least 3 letters
// also counts (typing "hamp" for "Hamper", "iron" for "Ironing Board") -- full
// typing rigor without making a long or oddly-spelled name tedious to answer.
// Below 3 letters only an exact match counts, so a short real name (e.g. "Ox")
// isn't trivially satisfied by an even-shorter guess.
function quizAnswerMatches(input, correctName){
  const val = input.trim().toLowerCase();
  const correct = correctName.trim().toLowerCase();
  if(!val) return false;
  if(val === correct) return true;
  return val.length >= 3 && correct.startsWith(val);
}

function checkQuizAnswer(correctName){
  const val = $('olq_answer').value.trim();
  const correct = quizAnswerMatches(val, correctName);
  if(correct) QUIZ.hits++; else QUIZ.misses++;
  // a PARTIAL match (e.g. "hamp" for "Hamper") reveals the full name even on
  // a hit, so the user actually sees/confirms the whole word, not just their
  // own shorthand; an exact match already IS the full name, nothing to add.
  const exact = val.toLowerCase() === correctName.trim().toLowerCase();
  revealAnswer(correct, correctName, correct && !exact);
}

function revealAnswer(correct, correctName, showFullOnHit=false){
  QUIZ.revealed = true;
  $('olq_feedback').innerHTML = correct
    ? (showFullOnHit
        ? `<span class="objlist-quiz-hit">&#10003; Correct — &ldquo;${esc(correctName)}&rdquo;</span>`
        : '<span class="objlist-quiz-hit">&#10003; Correct</span>')
    : `<span class="objlist-quiz-miss">&#10007; It was &ldquo;${esc(correctName)}&rdquo;</span>`;
  $('olq_answer').disabled = true;
  $('olq_skip').style.display = 'none';
  const submitBtn = $('olq_submit');
  submitBtn.textContent = (QUIZ.idx + 1 < QUIZ.order.length) ? 'Next' : 'Finish';
  submitBtn.onclick = advanceQuiz;
}

function advanceQuiz(){
  QUIZ.idx++;
  QUIZ.revealed = false;
  renderQuizStep();
}

function renderQuizSummary(){
  const total = QUIZ.hits + QUIZ.misses;
  const pct = total ? Math.round(QUIZ.hits / total * 100) : 0;
  const { title, entries, returnTo } = QUIZ;
  $('objlistQuiz').innerHTML = `
    <h3 class="objlist-h3">Quiz: ${esc(title)} — Results</h3>
    <div class="objlist-quiz-score">${pct}%</div>
    <div>${QUIZ.hits} hit${QUIZ.hits === 1 ? '' : 's'}, ${QUIZ.misses} miss${QUIZ.misses === 1 ? '' : 'es'}</div>
    <div class="assets-editor-actions">
      <div class="left">
        <button id="olq_again">Quiz again</button>
        <button id="olq_again_shuffled">Quiz again (shuffled)</button>
      </div>
      <button id="olq_done">Done</button>
    </div>
  `;
  $('olq_again').onclick = () => startQuiz(title, entries, false, returnTo);
  $('olq_again_shuffled').onclick = () => startQuiz(title, entries, true, returnTo);
  $('olq_done').onclick = closeQuiz;
}

/* ---------- castle-scoped quiz ----------
   "Quiz a castle's lists": every DISTINCT object list actually assigned to
   any wall bucket anywhere in a chosen castle, combined into one quiz --
   requested live as the natural companion to "Quiz this list", for studying
   exactly what a given memory palace actually uses instead of one list in
   isolation. Castle/line enumeration is app.js's domain (LAYOUT persistence,
   which castles exist, which are actually built) -- CASTLE_QUIZ_PROVIDER is
   supplied once from there (see setCastleQuizProvider), keeping this module
   as ignorant of "lines"/"castles" as it's ever been. Each entry's posLabel
   is "<list name> #<position in that list>" since positions aren't
   comparable across different lists once combined. */
let CASTLE_QUIZ_PROVIDER = null;   // { listOptions(): Promise<{lineId,lineName,castleName}[]>, entriesForCastle(lineId,castleName): Promise<entry[]> }
export function setCastleQuizProvider(provider){ CASTLE_QUIZ_PROVIDER = provider; }

export async function openCastleQuizPicker(){
  if(!CASTLE_QUIZ_PROVIDER) return;
  const grid = $('objlistGrid');
  if(grid) grid.style.display = 'none';
  $('objlistEditor').style.display = 'none';
  const el = $('objlistQuiz');
  el.style.display = '';
  el.innerHTML = `<p class="objlist-hint">Loading castles…</p>`;
  const options = await CASTLE_QUIZ_PROVIDER.listOptions();
  if(!options.length){
    el.innerHTML = `
      <h3 class="objlist-h3">Quiz a Castle's Lists</h3>
      <p class="objlist-hint">No built castle has any object list assigned to a wall yet -- assign one via a room's Wall Object Lists dialog first.</p>
      <div class="assets-editor-actions"><div class="left"><button id="olcq_back">Back</button></div></div>
    `;
    $('olcq_back').onclick = () => { $('objlistQuiz').style.display = 'none'; showIndex(); };
    return;
  }
  const byLine = new Map();
  options.forEach((o, i) => { if(!byLine.has(o.lineId)) byLine.set(o.lineId, { lineName: o.lineName, castles: [] }); byLine.get(o.lineId).castles.push({ ...o, idx: i }); });
  const optionsHtml = [...byLine.values()].map(g =>
    `<optgroup label="${esc(g.lineName)}">${g.castles.map(c => `<option value="${c.idx}">${esc(c.castleName)}</option>`).join('')}</optgroup>`
  ).join('');
  el.innerHTML = `
    <h3 class="objlist-h3">Quiz a Castle's Lists</h3>
    <p class="objlist-hint">Combines every object list assigned anywhere in the chosen castle into one quiz.</p>
    <div class="field">
      <label>Castle</label>
      <select id="olcq_select">${optionsHtml}</select>
    </div>
    <div class="assets-editor-actions">
      <div class="left">
        <button id="olcq_start">Start Quiz</button>
        <button id="olcq_back">Back</button>
      </div>
    </div>
    <div class="objlist-hint" id="olcq_error"></div>
  `;
  $('olcq_back').onclick = () => { $('objlistQuiz').style.display = 'none'; showIndex(); };
  $('olcq_start').onclick = async () => {
    const opt = options[+$('olcq_select').value];
    const entries = await CASTLE_QUIZ_PROVIDER.entriesForCastle(opt.lineId, opt.castleName);
    if(!entries.length){
      $('olcq_error').textContent = 'That castle has no object lists assigned after all -- pick another.';
      return;
    }
    startQuiz(`${opt.lineName} — ${opt.castleName}`, entries, false, () => { $('objlistQuiz').style.display = 'none'; showIndex(); });
  };
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

/* Moves the item named `name` to `targetIndex` (splice-insertion-index
   semantics, same convention as the analysis queue's reorderAnalysisQueue).
   No persistence here -- items live only in the working EDIT copy until
   Save writes the whole record. Unlike the analysis queue, every index is a
   valid source/destination: there's no "currently processing" item to
   protect, so nothing is ever off-limits. */
function reorderItems(name, targetIndex){
  const i = EDIT.items.findIndex(it => it.name === name);
  if(i === -1) return;
  const dest = Math.max(0, Math.min(targetIndex, EDIT.items.length - 1));
  if(dest === i) return;
  const [item] = EDIT.items.splice(i, 1);
  EDIT.items.splice(dest, 0, item);
  renderItems();
}

// Pointer-based (mouse + touch) drag-to-reorder -- same strategy as the
// analysis queue's grab handle (js/app.js's aqGrabPointerDown and friends):
// a horizontal indicator row tracks which gap the pointer is currently over,
// and release commits the move via reorderItems.
let OL_DRAG = null;   // { name, indicator, targetIndex } while a drag is in progress

function olGrabPointerDown(e){
  e.preventDefault();
  const tr = e.currentTarget.closest('tr');
  const name = tr.dataset.name;
  const tb = $('ol_items');
  const indicator = document.createElement('tr');
  indicator.className = 'objlist-drop-indicator';
  indicator.innerHTML = `<td colspan="4"><div class="objlist-drop-bar"></div></td>`;
  tr.classList.add('objlist-dragging');
  tb.insertBefore(indicator, tr.nextSibling);
  OL_DRAG = { name, indicator, targetIndex: null };
  document.addEventListener('pointermove', olGrabPointerMove);
  document.addEventListener('pointerup', olGrabPointerUp, { once: true });
}

// Every row except the one being dragged, in current DOM order -- gap `k`
// (0-based) sits right before rows[k]. rows[target] doubles as the
// indicator's insertion reference: undefined (past the last row) correctly
// means "insertBefore(indicator, undefined)", i.e. append.
function olGrabPointerMove(e){
  if(!OL_DRAG) return;
  const tb = $('ol_items');
  const rows = [...tb.querySelectorAll('tr.objlist-row')].filter(r => r.dataset.name !== OL_DRAG.name);
  let target = 0;
  for(let k = 0; k < rows.length; k++){
    const rect = rows[k].getBoundingClientRect();
    if(e.clientY > rect.top + rect.height / 2) target = k + 1;
  }
  target = Math.max(0, Math.min(target, rows.length));
  if(target !== OL_DRAG.targetIndex){
    OL_DRAG.targetIndex = target;
    tb.insertBefore(OL_DRAG.indicator, rows[target] || null);
  }
}

function olGrabPointerUp(){
  document.removeEventListener('pointermove', olGrabPointerMove);
  if(!OL_DRAG) return;
  const { name, indicator, targetIndex } = OL_DRAG;
  // clear the drag visuals synchronously rather than relying on
  // reorderItems' re-render to do it implicitly (matches the analysis
  // queue's own fix for the same "state visibly lingers for a beat" issue).
  indicator.remove();
  $('ol_items').querySelector('tr.objlist-dragging')?.classList.remove('objlist-dragging');
  OL_DRAG = null;
  if(targetIndex != null) reorderItems(name, targetIndex);
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
  const savedId = l.id;
  EDIT = null;
  await refresh();
  return savedId;   // lets a standalone caller (e.g. openNewObjectListModal) know the save succeeded
}

async function deleteEditor(){
  if(!EDIT || EDIT_IS_NEW) return;
  if(!confirm(`Delete the list "${EDIT.name || EDIT.id}"? This cannot be undone.`)) return;
  await deleteObjectList(EDIT.id);
  EDIT = null;
  await refresh();
}

/* Standalone "New List" modal: the same id/name/room/category/ordering/items/
   mnemonic editor as the full Object List Manager, but in its own focused
   overlay with no grid alongside it -- for callers (the VR "Wall object
   lists" dialog's own "+ New List" button) that just need to create one list
   and get back its id, without detouring through the full manager. Mirrors
   assets.js's openNewAssetModal: reuses openEditor/renderEditor/saveEditor
   unchanged by temporarily repointing containerEl (and thus every $() lookup
   they make) at this overlay's own #objlistEditor host; showIndex()/
   renderGrid() are guarded to no-op when there's no #objlistGrid in the
   current container, so saveEditor's normal post-save calls stay harmless
   here. The item editor's own "pick an image" sub-flow needs its own copy of
   the picker overlay's markup (same as buildShell's), since it's a sibling
   of #objlistEditor rather than something renderEditor builds itself.
   Resolves the new list's id on Save, or null on Cancel. */
export async function openNewObjectListModal(){
  // saveEditor's duplicate-id check reads the module-level LISTS cache, which
  // is only populated by openObjectListManager -- a caller reaching this
  // modal without the full manager having been opened this session (e.g.
  // straight from the VR wall-lists dialog) would otherwise check against a
  // stale/empty cache and let a typed-in id that already exists silently
  // overwrite that list via setObjectList.
  [LISTS, ASSETS] = await Promise.all([getAllObjectLists(), getAllAssets()]);
  return new Promise((resolve) => {
    const prevContainer = containerEl;
    let ov = document.getElementById('objlistNewOverlay');
    if(!ov){
      ov = document.createElement('div');
      ov.id = 'objlistNewOverlay';
      ov.className = 'overlay';
      // above the wall-lists dialog (70) that opens it; below the item
      // picker's own overlay (80), which can be opened from within this editor.
      ov.style.zIndex = '72';
      document.body.appendChild(ov);
    }
    ov.innerHTML = `
      <div class="modal" style="width:min(42em,92vw);max-height:90vh;overflow:auto">
        <div class="assets-header">
          <h2>New Object List</h2>
          <button id="objlistNewCloseBtn">Cancel</button>
        </div>
        <div id="objlistEditor" class="assets-editor"></div>
      </div>
      <div id="objlistPickOverlay" class="objlist-pick-overlay" style="display:none">
        <div class="objlist-pick-modal">
          <div class="objlist-pick-head">
            <strong>Pick an image asset</strong>
            <input type="text" id="objlistPickFilter" class="assets-search" placeholder="Search assets…">
            <button id="objlistPickNewAsset"><i class="fa-solid fa-plus"></i> New Asset…</button>
            <button id="objlistPickNone">Use word only (no image)</button>
            <button id="objlistPickCancel">Cancel</button>
          </div>
          <div class="assets-grid" id="objlistPickGrid"></div>
        </div>
      </div>`;
    ov.style.display = 'flex';
    containerEl = ov;

    $('objlistPickCancel').onclick = () => closePicker(undefined);
    $('objlistPickNone').onclick = () => closePicker(null);
    $('objlistPickFilter').oninput = () => renderPickGrid($('objlistPickFilter').value.trim().toLowerCase());
    $('objlistPickNewAsset').onclick = async () => {
      const newId = await openNewAssetModal();
      if(newId){ ASSETS = await getAllAssets(); closePicker(newId); }
    };

    let settled = false;
    const finish = (id) => {
      if(settled) return;
      settled = true;
      ov.style.display = 'none';
      ov.innerHTML = '';
      containerEl = prevContainer;
      resolve(id || null);
    };

    openEditor(null);
    // renderEditor (inside openEditor) already wired Save/Cancel to
    // saveEditor()/showIndex() for the full-manager flow -- rewire both here
    // so this standalone modal resolves instead of just sitting there.
    ov.querySelector('#ol_save').onclick = async () => {
      const id = await saveEditor();
      if(id) finish(id);
    };
    ov.querySelector('#ol_cancel').onclick = () => finish(null);
    ov.querySelector('#objlistNewCloseBtn').onclick = () => finish(null);
    wireBackdropClose(ov, () => finish(null));
  });
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
