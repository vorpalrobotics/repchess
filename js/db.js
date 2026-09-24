/* ---------- IndexedDB layer ----------
   Replaces localStorage for data that can grow large: downloaded game
   history and per-line repertoire preferences (reply / note / mnemonic).
*/
const DB_NAME = 'repchess-db';
const DB_VERSION = 8;   // v7 adds safetyBackup (crash-surviving pre-restore snapshot); v8 adds perfectOpeningQueue

/* ---------- one-time wipe of pre-release test data ----------
   No legacy data is worth preserving; localStorage is no longer read
   at all going forward, and any IndexedDB data from earlier testing
   is wiped once so everyone starts fresh.
*/
const FRESH_START_FLAG = 'repchess-fresh-start-v3';
let freshStartPromise = null;
function ensureFreshStart(){
  if(freshStartPromise) return freshStartPromise;
  freshStartPromise = new Promise(resolve=>{
    if(localStorage.getItem(FRESH_START_FLAG)){ resolve(); return; }

    const toRemove=[];
    for(let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      if(k && k.startsWith('lichess-')) toRemove.push(k);
    }
    for(const k of toRemove) localStorage.removeItem(k);

    console.log('[db] fresh start: wiping legacy localStorage keys and old IndexedDB');
    const req = indexedDB.deleteDatabase(DB_NAME);
    const done = () => { localStorage.setItem(FRESH_START_FLAG,'1'); resolve(); };
    req.onsuccess = done;
    req.onerror   = done;
    // onblocked means the delete has NOT happened yet -- another open tab is
    // still holding a connection to the old database -- so it must NOT set
    // the flag (that would permanently claim the wipe finished when it may
    // never actually complete). The request stays alive and still fires
    // onsuccess for real once every blocking connection closes; just wait.
    req.onblocked = () => console.warn('[db] fresh start: delete blocked by another open tab, waiting for it to close');
  });
  return freshStartPromise;
}

let dbPromise = null;
function openDB(){
  if(dbPromise) return dbPromise;
  dbPromise = ensureFreshStart().then(()=> new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains('games')){
        const gs = db.createObjectStore('games', {keyPath:'id'});
        gs.createIndex('user','user');
      }
      if(!db.objectStoreNames.contains('lines')){
        const ls = db.createObjectStore('lines', {keyPath:'id'});
        ls.createIndex('user','user');
      }
      if(!db.objectStoreNames.contains('prefs')){
        const ps = db.createObjectStore('prefs', {keyPath:'key'});
        ps.createIndex('lineId','lineId');
      }
      if(!db.objectStoreNames.contains('mnemonics')){
        db.createObjectStore('mnemonics', {keyPath:'square'});
      }
      if(!db.objectStoreNames.contains('meta')){
        db.createObjectStore('meta', {keyPath:'key'});
      }
      if(!db.objectStoreNames.contains('assets')){
        db.createObjectStore('assets', {keyPath:'id'});
      }
      if(!db.objectStoreNames.contains('objectLists')){
        db.createObjectStore('objectLists', {keyPath:'id'});
      }
      if(!db.objectStoreNames.contains('analysisQueue')){
        const aq = db.createObjectStore('analysisQueue', {keyPath:'id'});
        aq.createIndex('status','status');
        aq.createIndex('user','user');
      }
      // Perfect Opening project's own pending-expansion-job queue -- kept
      // separate from analysisQueue (see app.js's Perfect Opening section):
      // its jobs are reactively self-spawning (one result creates several
      // more), a different processing model than analysisQueue's flat,
      // user-curated list, and mixing thousands of these into that queue's
      // own UI would bury the user's own manually-added items.
      if(!db.objectStoreNames.contains('perfectOpeningQueue')){
        db.createObjectStore('perfectOpeningQueue', {keyPath:'id'});
      }
      // Deliberately NOT in clearAllData()'s store list -- its whole purpose
      // is a pre-restore snapshot that survives the exact wipe that store
      // list performs. See setSafetyBackup/getSafetyBackup/clearSafetyBackup.
      if(!db.objectStoreNames.contains('safetyBackup')){
        db.createObjectStore('safetyBackup', {keyPath:'id'});
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // If a later tab (e.g. after a deploy bumps DB_VERSION) needs to upgrade
      // the schema, it blocks until every open connection closes. Without this,
      // this tab would sit on the old connection forever and the other tab's
      // open request would hang with no visible cause.
      db.onversionchange = () => {
        console.warn('[db] newer version requested elsewhere -- closing this connection');
        db.close();
        dbPromise = null;
      };
      console.log('[db] opened', DB_NAME);
      resolve(db);
    };
    req.onerror   = () => { console.error('[db] open failed',req.error); reject(req.error); };
    req.onblocked = () => console.warn('[db] open blocked by another open connection (likely another tab) -- it will proceed once that tab closes or reloads');
  }));
  return dbPromise;
}
/* simple non-cryptographic hash, used only when a game has no id */
function hashStr(s){
  let h=0;
  for(let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))|0; }
  return h.toString(36);
}

/* ---------- one-time migration: pre-CURRENT_USER-removal data ----------
   Before CURRENT_USER was removed as an identity concept (see app.js),
   games/lines/analysisQueue were stored keyed by whatever real username had
   been bootstrapped as the app's one overall "identity" (e.g. a Lichess
   handle) -- every read now always queries one fixed constant instead
   (app.js's LOCAL_USER), so a record left over under the OLD key becomes
   invisible to the app (still sitting in IndexedDB, just never found by any
   getGames/getLines/getAnalysisQueue call) rather than actually lost. This
   finds any such orphaned record and re-keys it to `localUser`, once.
   Gated on its own flag -- NOT FRESH_START_FLAG's, which is for wiping
   pre-release test data; this one exists specifically to PRESERVE real user
   data -- so a full games/lines/analysisQueue scan doesn't run on every
   single boot forever once there's nothing left to migrate. */
const LEGACY_USER_MIGRATION_FLAG = 'repchess-legacy-user-migration-v1';
async function migrateLegacyUserData(localUser){
  if(localStorage.getItem(LEGACY_USER_MIGRATION_FLAG)) return;
  const db = await openDB();

  // lines + analysisQueue: an in-place put() under the SAME id, with the
  // corrected user field, is enough to make the record findable again --
  // `id` is treated as an opaque string everywhere else in the app (no code
  // parses or reconstructs one), so it doesn't matter that it isn't fully
  // corrected too. analysisQueue's own id (app.js's aqJobId-style
  // `aq:<timestamp>:<random>`) never embedded the old user at all, but a
  // line's id DOES: createLine() mints a fresh one as `${user}:${timestamp}:
  // ${random}` when none is supplied, so a migrated line's id permanently
  // keeps the PRE-migration username as its own first segment even after
  // this fixes its `user` field -- a cosmetic wart, not a correctness bug,
  // since nothing ever splits a line id back apart.
  for(const storeName of ['lines', 'analysisQueue']){
    await new Promise((resolve, reject) => {
      const txn = db.transaction(storeName, 'readwrite');
      const store = txn.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => {
        for(const record of req.result){
          if(record.user !== localUser) store.put({ ...record, user: localUser });
        }
      };
      txn.oncomplete = () => resolve();
      txn.onerror    = () => reject(txn.error);
    });
  }

  // games: `user` IS embedded in the primary key (`${user}:${gameId}`), so
  // re-keying means writing a new record under the corrected id and
  // deleting the old one -- a put() under the same id would just leave a
  // stale duplicate sitting under the old key.
  await new Promise((resolve, reject) => {
    const txn = db.transaction('games', 'readwrite');
    const store = txn.objectStore('games');
    const req = store.getAll();
    req.onsuccess = () => {
      for(const record of req.result){
        if(record.user !== localUser){
          store.delete(record.id);
          store.put({ ...record, id: `${localUser}:${record.gameId}`, user: localUser });
        }
      }
    };
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });

  localStorage.setItem(LEGACY_USER_MIGRATION_FLAG, '1');
}

/* ---------- games ---------- */
/* games: array of parsed Lichess game objects (already JSON.parse'd) */
async function putGames(user, games){
  console.log(`[db] writing ${games.length} games for ${user}…`);
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('games','readwrite');
    const store = txn.objectStore('games');
    for(const g of games){
      const gameId = g.id || hashStr(JSON.stringify(g));
      store.put({ id:`${user}:${gameId}`, user, gameId, raw:g });
    }
    txn.oncomplete = () => { console.log(`[db] wrote ${games.length} games for ${user}`); resolve(); };
    txn.onerror    = () => { console.error('[db] putGames failed',txn.error); reject(txn.error); };
  });
}

async function getGames(user){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const store = db.transaction('games','readonly').objectStore('games');
    const req = store.index('user').getAll(user);
    req.onsuccess = () => { console.log(`[db] loaded ${req.result.length} games for ${user}`); resolve(req.result.map(r=>r.raw)); };
    req.onerror   = () => { console.error('[db] getGames failed',req.error); reject(req.error); };
  });
}

/* ---------- lines (named repertoire roots) ---------- */
// `id` may be supplied to recreate a line under its original id (e.g. restoring
// a backup) — VR decoration keys embed the line id via castleInstanceId(), so a
// regenerated id would orphan every castle room + building facade/sign in
// threeLayout. Left unset, a fresh unique id is minted as before.
async function createLine(user, {name, color, openingMoves, id, hideUnselectedGameMoves}){
  const db = await openDB();
  const lineId = id || `${user}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;
  const line = {id: lineId, user, name, color, openingMoves: openingMoves || [], createdAt: Date.now()};
  // opt-in only -- Perfect Opening sets this on its own generated line so a
  // real opponent's move that the search itself didn't keep never shows up
  // (and, since games sort first, never outranks an actually-recommended
  // reply); every other line keeps showing real game moves as normal, since
  // that's how a repertoire gets built from actual play.
  if(hideUnselectedGameMoves) line.hideUnselectedGameMoves = true;
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('lines','readwrite');
    txn.objectStore('lines').put(line);
    txn.oncomplete = () => resolve(line);
    txn.onerror    = () => reject(txn.error);
  });
}

async function getLines(user){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const store = db.transaction('lines','readonly').objectStore('lines');
    const req = store.index('user').getAll(user);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// Resolves `true` if the patch was actually applied, `false` if `id` didn't
// match any stored line (a silent no-op otherwise -- callers that don't care
// can ignore the return value, same as before).
async function updateLine(id, patch){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('lines','readwrite');
    const store = txn.objectStore('lines');
    let applied = false;
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      if(!getReq.result){ console.warn(`[db] updateLine: no line found for id ${id}`); return; }
      store.put({...getReq.result, ...patch});
      applied = true;
    };
    txn.oncomplete = () => resolve(applied);
    txn.onerror    = () => reject(txn.error);
  });
}

async function deleteLine(id){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction(['lines','prefs','analysisQueue','perfectOpeningQueue','meta'],'readwrite');
    txn.objectStore('lines').delete(id);
    const prefStore = txn.objectStore('prefs');
    const idxReq = prefStore.index('lineId').getAllKeys(id);
    idxReq.onsuccess = () => { for(const k of idxReq.result) prefStore.delete(k); };
    // analysisQueue rows aren't indexed by lineId (it's a small to-do list, not
    // worth a schema bump for) -- a cursor sweep drops any queued/processing
    // items for this line so they don't keep running against a deleted line
    // and resurrecting orphaned prefs rows after the fact.
    const aqStore = txn.objectStore('analysisQueue');
    const aqCursorReq = aqStore.openCursor();
    aqCursorReq.onsuccess = () => {
      const cursor = aqCursorReq.result;
      if(!cursor) return;
      if(cursor.value.lineId === id) cursor.delete();
      cursor.continue();
    };
    // The Home screen's ordinary delete flow has no special case for Perfect
    // Opening's own generated line -- deleting it that way (instead of via
    // "Reset Perfect Opening", which already does this cleanup in the other
    // order: deleteLine() THEN clear the queue/config) would otherwise leave
    // config.enabled true and the queue untouched, so the scheduler keeps
    // running jobs against a deleted line indefinitely, resurrecting orphaned
    // prefs rows just like an un-swept analysisQueue item would. Read/write
    // 'meta' directly (not via getMeta/setMeta, which each open their own
    // transaction) so this stays part of the SAME atomic delete.
    const metaStore = txn.objectStore('meta');
    const metaReq = metaStore.get('perfectOpeningConfig');
    metaReq.onsuccess = () => {
      const raw = metaReq.result && metaReq.result.value;
      if(!raw) return;
      let config;
      try { config = JSON.parse(raw); } catch { return; }
      if(config.lineId !== id) return;
      txn.objectStore('perfectOpeningQueue').clear();
      metaStore.put({ key:'perfectOpeningConfig', value: JSON.stringify(cloneDefaultPerfectOpeningConfig()) });
    };
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

/* ---------- shared "one row per key, patch-merged over a blank default"
   write idiom -- every store below (prefs, mnemonics, assets, objectLists)
   is read-existing-or-default, merge `patch` on top, put it back. `extra`
   (e.g. a freshly stamped id/updatedAt) is merged in AFTER patch, so it
   always wins even if patch happens to carry the same field. ---------- */
// operates on an ALREADY-OPEN store (mid-transaction) so a caller merging
// many keys in one transaction (setPrefsBatch) can call this once per key
// without paying for a separate transaction per write.
function mergeAndPut(store, key, blank, patch, extra){
  const getReq = store.get(key);
  getReq.onsuccess = () => {
    const existing = getReq.result || blank;
    store.put({...existing, ...patch, ...(extra || {})});
  };
}
// same idiom, opening its own single-key transaction -- the common case for
// every store here except setPrefsBatch's own multi-key transaction.
async function putMerged(storeName, key, blank, patch, extra){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction(storeName,'readwrite');
    mergeAndPut(txn.objectStore(storeName), key, blank, patch, extra);
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

/* ---------- prefs (reply / note / mnemonic per move sequence, scoped to a line) ---------- */
const prefKey = (lineId,seq) => `${lineId}|${seq.join(',')}`;

async function getAllPrefs(lineId){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const store = db.transaction('prefs','readonly').objectStore('prefs');
    const req = store.index('lineId').getAll(lineId);
    req.onsuccess = () => {
      const map = {};
      for(const r of req.result) map[r.key] = r;
      resolve(map);
    };
    req.onerror = () => reject(req.error);
  });
}

async function getPref(lineId, seq){
  const db = await openDB();
  const key = prefKey(lineId,seq);
  return new Promise((resolve,reject)=>{
    const req = db.transaction('prefs','readonly').objectStore('prefs').get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

const blankPref = (key,lineId,seq) => ({key,lineId,seq,reply:'',note:'',mnemonic:''});

async function setPref(lineId, seq, patch){
  const key = prefKey(lineId,seq);
  return putMerged('prefs', key, blankPref(key,lineId,seq), patch);
}

/* Writes many pref patches (each { seq, patch }) in ONE transaction instead
   of one setPref() round-trip per entry. Importing even a modest pasted
   variation (app.js's importLine/importEngineVariation) means one
   manualReplies write plus one reply write per "our" move -- each setPref()
   call pays IndexedDB's full transaction-commit cost on its own (a real
   disk flush in most browsers), which is what made a multi-move import
   visibly slow (several seconds). Batching every write from the whole
   import into one transaction/commit fixes that at the root, independent of
   variation length.
   REQUIRES `entries` to carry at most one entry per seq (the caller merges
   any same-seq writes into one combined patch first -- see importLine's own
   batch, a Map keyed by seq). Two entries for the same seq here would race:
   each issues its own store.get() before either's callback can run, so the
   second would build its merge from a get() that doesn't yet reflect the
   first's still-in-flight put() and clobber it. */
async function setPrefsBatch(lineId, entries){
  if(!entries.length) return;
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('prefs','readwrite');
    const store = txn.objectStore('prefs');
    for(const {seq, patch} of entries){
      const key = prefKey(lineId,seq);
      mergeAndPut(store, key, blankPref(key,lineId,seq), patch);
    }
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

/* ---------- mnemonics (memory-palace words, per destination square per piece) ---------- */
const BLANK_MNEMONIC_SQUARE = {
  pawn:'', pawnDesc:'', pawnImg:'', knight:'', knightDesc:'', knightImg:'',
  bishop:'', bishopDesc:'', bishopImg:'', rook:'', rookDesc:'', rookImg:'',
  queen:'', queenDesc:'', queenImg:'', king:'', kingDesc:'', kingImg:''
};

async function getAllMnemonics(){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const store = db.transaction('mnemonics','readonly').objectStore('mnemonics');
    const req = store.getAll();
    req.onsuccess = () => {
      const map = {};
      for(const r of req.result) map[r.square] = r;
      resolve(map);
    };
    req.onerror = () => reject(req.error);
  });
}

async function setMnemonicSquare(square, patch){
  return putMerged('mnemonics', square, {square, ...BLANK_MNEMONIC_SQUARE}, patch);
}

/* ---------- assets (three.js prop/surface staging registry) ----------
   Mirrors the PNG+JSON file-pair schema in Documents/three-assets.md; the
   `image` field holds a base64 PNG data-URL while an asset lives only in
   IndexedDB, before being exported to real files under assets/three/.
*/
const BLANK_ASSET = {
  id:'', type:'extruded', image:'', resolution:'normal',
  size:{w:0.5,h:1,d:0.5}, sideColor:'#888888', orientation:'standing',
  repeatPerMeter:0.5, rotation:0, tint:null, roughness:0.85, metalness:0,
  createdAt:0, updatedAt:0
};

// 'billboard-sprite' (a full always-faces-camera sprite, tilting on every
// axis) was removed as a choosable asset type -- 'billboard-cylindrical'
// (Y-axis-only rotation, so it stays upright as you look up/down at it)
// covers the same "flat PNG prop" need correctly in virtually every case.
// Read-time fallback so an asset saved under the old type before this change
// keeps rendering/editing/labeling exactly like a cylindrical one instead of
// silently breaking, with no destructive rewrite of the stored record and no
// migration step needed -- every consumer reads assets through this one
// function, so normalizing here alone is enough.
function normalizeAssetType(asset){
  return asset && asset.type === 'billboard-sprite' ? { ...asset, type: 'billboard-cylindrical' } : asset;
}

async function getAllAssets(){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const req = db.transaction('assets','readonly').objectStore('assets').getAll();
    req.onsuccess = () => resolve(req.result.map(normalizeAssetType));
    req.onerror   = () => reject(req.error);
  });
}

async function setAsset(id, patch){
  const now = Date.now();
  return putMerged('assets', id, {...BLANK_ASSET, id, createdAt:now}, patch, {id, updatedAt:now});
}

async function deleteAsset(id){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('assets','readwrite');
    txn.objectStore('assets').delete(id);
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

/* ---------- object lists (ordered mnemonic object lists for castle room walls) ----------
   See Documents/ObjectListsAndRoomAssignment.md. Each list is a named, ordered
   set of items with a justified ordering rule and an optional mnemonic. Each
   item has an immutable `name` (the stable key an asset binding hangs off) and
   an optional `assetId` referencing the 'assets' store — null means the item
   shows just its word as a text label in VR until an asset is bound.
*/
const BLANK_OBJECT_LIST = {
  id:'', name:'', roomName:'', category:'',
  orderingType:'generated_mnemonic', orderingRule:'',
  items:[],   // [{ name, assetId }] — name is the immutable binding key
  mnemonic:{ type:'generated_phrase', initialism:'', phrase:'', source:'' },
  createdAt:0, updatedAt:0
};

async function getAllObjectLists(){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const req = db.transaction('objectLists','readonly').objectStore('objectLists').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function setObjectList(id, patch){
  const now = Date.now();
  return putMerged('objectLists', id, {...BLANK_OBJECT_LIST, id, createdAt:now}, patch, {id, updatedAt:now});
}

async function deleteObjectList(id){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('objectLists','readwrite');
    txn.objectStore('objectLists').delete(id);
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

async function clearObjectLists(){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('objectLists','readwrite');
    txn.objectStore('objectLists').clear();
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

/* ---------- analysis queue (background multi-line engine analysis) ----------
   One row per node the user asked to be deep-analyzed: {id, user, lineId, seq,
   depth, multipv, status:'queued'|'processing', createdAt, progressDepth,
   progressLines}. A finished item is deleted outright (its result lives in
   PREFS[key].eval/evalLines on the node itself, not here) -- this store is a
   to-do list, not a history log. */
async function getAnalysisQueue(user){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const store = db.transaction('analysisQueue','readonly').objectStore('analysisQueue');
    const req = store.index('user').getAll(user);
    // `order` (added for manual drag-to-reorder) wins when present; an item
    // saved before that feature existed has no `order` yet, so falls back to
    // its createdAt -- preserving today's FIFO order for old data untouched
    // until the user actually drags it (reorderAnalysisQueue then gives it a
    // real `order` going forward).
    const orderOf = it => it.order ?? it.createdAt;
    req.onsuccess = () => resolve(req.result.sort((a,b)=>orderOf(a)-orderOf(b)));
    req.onerror   = () => reject(req.error);
  });
}

async function putAnalysisQueueItem(item){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('analysisQueue','readwrite');
    txn.objectStore('analysisQueue').put(item);
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

async function deleteAnalysisQueueItem(id){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('analysisQueue','readwrite');
    txn.objectStore('analysisQueue').delete(id);
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

/* ---------- meta (small flat key/value settings, e.g. mnemonics notes) ---------- */
async function getMeta(key){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const req = db.transaction('meta','readonly').objectStore('meta').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : '');
    req.onerror   = () => reject(req.error);
  });
}

async function setMeta(key, value){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('meta','readwrite');
    txn.objectStore('meta').put({key, value});
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

// true removal (not just blanking the value with setMeta(key,'')) -- for
// cleaning up a row under a since-abandoned key entirely, e.g. a cache key
// renamed across a breaking format/logic change.
async function deleteMeta(key){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('meta','readwrite');
    txn.objectStore('meta').delete(key);
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

/* wipes just the assets store -- used by the "import assets (replace)" flow,
   which swaps the whole asset set without touching games/lines/mnemonics. */
async function clearAssets(){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('assets','readwrite');
    txn.objectStore('assets').clear();
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

/* wipes just the mnemonics store -- used by the "import mnemonics (replace)"
   flow, which swaps the whole mnemonic set (words + images + notes are handled
   separately) without touching games/lines/assets. */
async function clearMnemonics(){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('mnemonics','readwrite');
    txn.objectStore('mnemonics').clear();
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

/* ---------- full wipe, used before restoring a complete backup ---------- */
async function clearAllData(){
  const db = await openDB();
  const stores = ['games','lines','prefs','mnemonics','meta','assets','objectLists','analysisQueue','perfectOpeningQueue'];
  return new Promise((resolve,reject)=>{
    const txn = db.transaction(stores,'readwrite');
    for(const s of stores) txn.objectStore(s).clear();
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

/* ---------- Reset to Factory: delete the whole database outright ----------
   Unlike clearAllData() above (which deliberately spares safetyBackup so an
   interrupted restore can recover), this is the opposite: an explicit,
   user-confirmed "erase everything", including safetyBackup and any store
   added in a future version that this list doesn't yet know about. Closes
   the cached connection first -- indexedDB.deleteDatabase() otherwise sits
   in "blocked" state behind this tab's own still-open handle and never
   resolves. Best-effort on the delete itself (resolves either way) since the
   caller clears localStorage and reloads immediately after regardless. */
async function deleteEntireDatabase(){
  if(dbPromise){
    try { (await dbPromise).close(); } catch(e){}
  }
  dbPromise = null;
  return new Promise(resolve => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror = resolve;
    req.onblocked = resolve;
  });
}

/* ---------- Perfect Opening project ----------
   Settings + progress live as one JSON blob in the existing meta store
   (small, rewritten wholesale on every save -- same pattern as threeLayout/
   graphLayout); pending expansion jobs get their own real object store
   (perfectOpeningQueue) since that can grow into the thousands, where a
   single-blob approach would mean rewriting the whole thing on every job
   processed.
*/
const PERFECT_OPENING_DEFAULT_CONFIG = {
  enabled: false,
  lineId: null,            // the generated "Perfect White Opening" line's id, once created
  // search depth per move NUMBER (not ply -- same convention as maxLines
  // below), falling back to `default` beyond the ones explicitly listed --
  // lets a real run start deep (e.g. 50) and be dialed down for later moves
  // as the tree's branching makes that no longer time-feasible.
  depth: { 1: 20, 2: 20, 3: 20, 4: 20, default: 20 },
  toleranceCp: 50,
  // max candidate replies kept per move NUMBER (not ply -- move 1 covers
  // both the White and Black half-move at that number), falling back to
  // `default` for any move beyond the ones explicitly listed here.
  maxLines: { 1: 10, 2: 8, 3: 6, 4: 6, default: 6 },
  maxTotalVariations: 50000,
  totalVariations: 0,      // running count of surviving leaf lines so far
  // highest move NUMBER with no queued job at or before it -- i.e. every
  // White move and every kept Black reply up through this move number has
  // already been searched. Maintained by the scheduler (maybeResumePerfectOpening
  // in app.js) as a running high-water mark, not recomputed from scratch,
  // since the queue alone can't answer this once it's fully drained (either
  // paused mid-run or genuinely finished).
  deepestCompleteMove: 0,
  // recency-weighted average wall-clock ms per completed job, maintained by
  // the scheduler -- feeds the Progress view's "estimated time to complete
  // move N" readout. Fast-adapting (see maybeResumePerfectOpening's own
  // comment) so it converges quickly after a depth/move-number transition
  // rather than staying skewed by a much slower or faster earlier move.
  avgJobMs: 0,
  // recency-weighted average nodes/sec (Stockfish's own reported `nps`),
  // same fast-adapting smoothing as avgJobMs -- feeds the Progress view's
  // search-speed readout ("512k evals/sec" etc., same idea as lichess's).
  avgNps: 0,
  // 0 means "use whatever the engine reports as its own cores-1 ceiling"
  // (engine.maxThreads), resolved at analyze()-call time rather than baked
  // in here, since the right number is a property of whatever device is
  // actually running the search, not something that should travel as a
  // fixed number across a backup restored onto a different machine. Perfect
  // Opening never runs while anything else needs the engine, so unlike the
  // live panel/analysis queue's own (conservative, shared-with-the-user)
  // thread selectors, defaulting to the hardware ceiling is the right
  // default here, not just an option.
  threads: 0,
  // MB -- see engine.js's own Hash-related comments for why bigger helps a
  // long unattended run (the transposition table stays warm across every
  // job) and why this should be treated as a "set once" value: changing it
  // reallocates (and therefore empties) the table.
  hashMB: 512,
};
function cloneDefaultPerfectOpeningConfig(){
  return { ...PERFECT_OPENING_DEFAULT_CONFIG, maxLines: { ...PERFECT_OPENING_DEFAULT_CONFIG.maxLines }, depth: { ...PERFECT_OPENING_DEFAULT_CONFIG.depth } };
}
async function getPerfectOpeningConfig(){
  const raw = await getMeta('perfectOpeningConfig');
  if(!raw) return cloneDefaultPerfectOpeningConfig();
  try {
    const parsed = JSON.parse(raw);
    // a config saved before depth became a per-move schedule has a plain
    // number here -- treat it as "every move searches this deep", same
    // effective behavior as before this change.
    const parsedDepth = typeof parsed.depth === 'number'
      ? { 1: parsed.depth, 2: parsed.depth, 3: parsed.depth, 4: parsed.depth, default: parsed.depth }
      : (parsed.depth || {});
    // merge over the defaults (not just trust what's stored) so a field
    // added to this shape in a later version doesn't come back undefined
    // for a config saved before that field existed.
    return { ...cloneDefaultPerfectOpeningConfig(), ...parsed,
      maxLines: { ...PERFECT_OPENING_DEFAULT_CONFIG.maxLines, ...(parsed.maxLines || {}) },
      depth: { ...PERFECT_OPENING_DEFAULT_CONFIG.depth, ...parsedDepth } };
  } catch(e){
    console.warn('[db] perfectOpeningConfig was corrupt JSON, using defaults', e);
    return cloneDefaultPerfectOpeningConfig();
  }
}
async function setPerfectOpeningConfig(config){
  await setMeta('perfectOpeningConfig', JSON.stringify(config));
}

async function getPerfectOpeningQueue(){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const req = db.transaction('perfectOpeningQueue','readonly').objectStore('perfectOpeningQueue').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
async function addPerfectOpeningQueueItems(items){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('perfectOpeningQueue','readwrite');
    const store = txn.objectStore('perfectOpeningQueue');
    for(const item of items) store.put(item);
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}
async function deletePerfectOpeningQueueItem(id){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('perfectOpeningQueue','readwrite');
    txn.objectStore('perfectOpeningQueue').delete(id);
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}
async function clearPerfectOpeningQueueStore(){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('perfectOpeningQueue','readwrite');
    txn.objectStore('perfectOpeningQueue').clear();
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

// Wipes the Perfect Opening project back to a clean slate: deletes the
// generated line (and its prefs/analysisQueue rows, via the exact same
// deleteLine every manual line-delete already goes through), clears every
// pending expansion job, and resets settings to their defaults -- including
// turning the project back off, since a reset mid-run should stop it rather
// than silently keep going against a now-empty tree.
async function resetPerfectOpening(){
  const config = await getPerfectOpeningConfig();
  if(config.lineId) await deleteLine(config.lineId);
  await clearPerfectOpeningQueueStore();
  await setPerfectOpeningConfig(cloneDefaultPerfectOpeningConfig());
}

/* ---------- safety backup (crash-surviving pre-restore snapshot) ----------
   A single row (fixed id 'current') holding whatever a caller wants to
   recover if a destructive operation is interrupted -- app.js's importBackup
   writes a full pre-restore snapshot here right before wiping everything via
   clearAllData(), and clears this row again once the restore (or its own
   in-session rollback) completes. If the row is still here on next boot,
   nothing ever confirmed completion -- the tab was closed/crashed mid-restore
   -- so app.js's boot-time check replays it. The payload shape (plain object
   vs. gzip Blob) is entirely app.js's business; this is just a mechanical
   single-row store, deliberately excluded from clearAllData()'s store list
   above so it survives the exact wipe it exists to recover from. */
async function getSafetyBackup(){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const req = db.transaction('safetyBackup','readonly').objectStore('safetyBackup').get('current');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}
async function setSafetyBackup(payload){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('safetyBackup','readwrite');
    txn.objectStore('safetyBackup').put({ id:'current', payload, createdAt: Date.now() });
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}
async function clearSafetyBackup(){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('safetyBackup','readwrite');
    txn.objectStore('safetyBackup').delete('current');
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

/* ---------- room review scheduling (spaced repetition) ----------
   Per-room review history, so a memorized room can be resurfaced on a
   widening schedule instead of relying on noticing it's gone stale. Lives in
   the meta store as one JSON blob keyed by roomKey (small, rewritten
   wholesale), the same shape and persistence pattern as threeMemorizedRooms
   / threeDecoratedRooms -- and keyed the same way, so a record survives
   castle regeneration exactly as decorations do.

   These functions live in db.js rather than either module because BOTH need
   them: grading happens in the VR walk (threeVR.js) and the due-state
   colouring in the opening graph (app.js), and neither module imports the
   other. db.js is a classic <script>, so its functions are plain globals
   both can call.

   A fixed LADDER rather than SM-2's ease factor. SM-2 tunes a per-item ease
   from many repetitions; with a few hundred rooms reviewed by one person it
   would never converge, and "step 4 of 6, next in 21 days" is inspectable in
   a way an opaque ease of 2.36 is not. The stored shape leaves room to add
   an ease later without discarding history.
*/
/* ---------- surface tint adjustment ----------

   A tint is applied as `material.color`, which three.js MULTIPLIES the
   texture by -- so every tint except pure white darkens, and the more
   saturated the hue you want the darker you are forced to go. There is no
   tint value that brightens. Brightness/contrast are the other half of that
   operation, applied to the texture itself before it ever reaches the
   material.

   The formula lives here, as a single string, precisely so the 2D preview in
   the picker and the 3D surface in the world cannot drift apart: both hand
   this exact string to `ctx.filter`. A preview that computes its own version
   of "the same" adjustment is a preview that eventually lies.

   Deliberately NOT applied to the tint itself. `material.color` multiplies in
   LINEAR space inside the shader, while a canvas filter works on sRGB bytes,
   so folding the tint into the canvas would silently change the look of every
   surface already tinted -- no error, nothing in the diff to suggest it. The
   tint stays exactly where it was; only brightness/contrast are new. */
const SURFACE_ADJUST_MIN = 0.25;
const SURFACE_ADJUST_MAX = 2.5;
const SURFACE_ADJUST_STEP = 0.05;

function clampSurfaceAdjust(v){
  // Number(null) is 0, NOT NaN -- so an absent value has to be caught before
  // the isFinite check, or a surface nobody has adjusted clamps to the floor
  // and reads as fully dark. That is the opposite of this feature's purpose,
  // and it is silent: 0.25 is a perfectly valid value.
  const n = (v === null || v === undefined || v === '') ? NaN : Number(v);
  if(!isFinite(n)) return 1;
  return Math.min(SURFACE_ADJUST_MAX, Math.max(SURFACE_ADJUST_MIN, n));
}
/* The ctx.filter string, or null when there is nothing to do. Callers use the
   null to skip the canvas pass entirely, so a surface nobody has adjusted
   renders through exactly the path it always did. */
function surfaceAdjustFilter(brightness, contrast){
  const b = clampSurfaceAdjust(brightness ?? 1);
  const c = clampSurfaceAdjust(contrast ?? 1);
  if(b === 1 && c === 1) return null;
  return `brightness(${b}) contrast(${c})`;
}
function isSurfaceAdjusted(adjust){
  return !!(adjust && surfaceAdjustFilter(adjust.brightness, adjust.contrast));
}

const ROOM_REVIEWS_KEY = 'threeRoomReviews';
const ROOM_REVIEW_LADDER = [1, 3, 7, 21, 60, 180];   // days until the next review, by step
// ±15%, so a wing memorized in one sitting doesn't come due all on the same
// day for the rest of time -- the pile-up every spaced-repetition tool ends
// up having to defuse.
//
// Note this has NO effect below roughly a week: 15% of 3 days is ±11 hours,
// and due dates snap to local midnight (see startOfLocalDay), so short
// intervals absorb their own fuzz and stay clumped. That's deliberate --
// a pile-up only really hurts at long intervals, where a whole wing coming
// due on one distant day is a genuine wall; at 1-3 days you're reviewing
// more or less continuously anyway.
const ROOM_REVIEW_FUZZ = 0.15;
const DAY_MS = 86400000;

/* ---------- the learning step ----------

   A same-day review BEFORE a room joins the ladder. Without it the 1-day
   review was the first time a room was ever retrieved -- everything before it
   was encoding -- and a first retrieval is effortful almost by definition:
   rung 0 ran mostly B's. A few hours after memorizing, one recall turns
   tomorrow's review into the SECOND retrieval. Anki's learning steps and
   Pimsleur's sub-day intervals are the same idea.

   A PHASE, flagged on the record, rather than a new rung at the front of the
   ladder, for three reasons:
   1. Due dates snap to local midnight (startOfLocalDay), and a 6-hour rung
      would snap to either "already due" or "tomorrow" depending on the time
      of day -- never actually six hours. A learning record keeps a real
      timestamp instead.
   2. Rungs are indexes. Inserting one at the front would renumber `step` on
      every stored review, every key in the grade tally and `r` on every log
      entry.
   3. A record without the flag reads as already graduated, so nothing needs
      migrating: rooms memorized before this existed keep their schedule.

   It also gives a failure somewhere to go that is not where a B goes. At
   rung 0 a C used to reset to rung 0 -- exactly where a B holds -- so the two
   scheduled identically. A C at any rung now returns the room to learning. */
const ROOM_LEARNING_MS = 6 * 3600 * 1000;
// the tally/log key for a review taken during learning, so it never shares a
// row with rung 0 and the report can show whether the step is earning its keep
const LEARNING_RUNG = 'L';
function learningRecord(prev, now = Date.now(), grade = null){
  const out = {
    // null until a learning review actually happens, the same "never reviewed"
    // meaning bootstrapRoomReview gives it -- see gradeCurrentRoom's `since`
    last: grade ? now : null,
    due: now + ROOM_LEARNING_MS,     // a REAL timestamp: see (1) above
    step: 0,
    lapses: ((prev && prev.lapses) || 0) + (grade === 'C' ? 1 : 0),
    lastGrade: grade,
    learning: true,
  };
  if(prev && prev.dirtySeen) out.dirtySeen = prev.dirtySeen;
  return out;
}

// Due dates are snapped to local midnight so "due today" means the whole day
// regardless of what time the last review happened -- without this, grading
// at 9pm makes the next one silently not-due until 9pm.
function startOfLocalDay(ms){
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function fuzzedDays(days, rand = Math.random){
  const spread = days * ROOM_REVIEW_FUZZ;
  return days + (rand() * 2 - 1) * spread;
}

/* The grade -> step rule. 'A' perfect, 'B' mostly right, 'C' failed.

   B HOLDS rather than demoting, but a SECOND consecutive B demotes. For a
   room holding several move-pairs, one miss is likely the ordinary outcome
   rather than the exception -- demoting on every B would make the ladder
   unclimbable and pin everything at short intervals. Holding forever is
   wrong too, though: a room never quite mastered shouldn't keep drifting out
   to 180 days. Two B's in a row is the signal that the interval itself is
   too long, where one is just noise. (This is SM-2's ease factor in spirit
   -- intervals growing more slowly when you're shaky -- expressed so it can
   be read off rather than inferred.) */
function nextReviewStep(step, grade, lastGrade){
  if(grade === 'C') return 0;
  if(grade === 'B') return (lastGrade === 'B') ? Math.max(0, step - 1) : step;
  return Math.min(ROOM_REVIEW_LADDER.length - 1, step + 1);   // 'A'
}

/* Applies one grade to a room's record, returning the NEW record (never
   mutates the old one). `now` and `rand` are injectable so tests can be
   deterministic about both the clock and the fuzz. A room with no record yet
   starts at step 0 -- see bootstrapRoomReview for where that first record
   comes from. */
function applyRoomReviewGrade(record, grade, now = Date.now(), rand = Math.random){
  const prev = record || { step: 0, lapses: 0, lastGrade: null };
  // a failure, from anywhere, means relearning it today rather than tomorrow
  if(grade === 'C') return learningRecord(prev, now, 'C');
  // passing the learning review -- A or B -- graduates to the ladder's first
  // rung; B still counts as a recall, it just doesn't skip ahead
  const step = prev.learning ? 0 : nextReviewStep(prev.step || 0, grade, prev.lastGrade);
  const days = fuzzedDays(ROOM_REVIEW_LADDER[step], rand);
  const out = {
    last: now,
    due: startOfLocalDay(now + days * DAY_MS),
    step,
    lapses: (prev.lapses || 0) + (grade === 'C' ? 1 : 0),
    lastGrade: grade,
  };
  // Structural bookkeeping, not grade state -- which doors this room has
  // already been docked a step for (see threeVR.js applyStructuralDemotions).
  // Carried through a grade rather than reset by it: grading says you've
  // reviewed the room as it now stands, so the SAME door shouldn't cost it
  // another step, while a genuinely new one still should.
  if(prev.dirtySeen) out.dirtySeen = prev.dirtySeen;
  return out;
}

/* A room marked memorized but never reviewed still needs a due date, and the
   memorized flag already stores WHEN (threeVR.js writes Date.now()), so the
   first review falls due a day after it was memorized. This means an existing
   repertoire joins the schedule with no migration step and no backfill. */
function bootstrapRoomReview(memorizedAt){
  if(!memorizedAt) return null;
  return { last: null, due: startOfLocalDay(memorizedAt + DAY_MS), step: 0, lapses: 0, lastGrade: null };
}

/* One step back down the ladder, re-dated from the LAST ACTUAL REVIEW.

   This is the operation that means "something other than your own judgement
   says look at this sooner": the room changed shape under you (threeVR.js's
   applyStructuralDemotions), or you missed one of its moves in the board
   quiz. Deliberately not a grade. Grading is self-assessment and a C resets
   to the bottom of the ladder, which is too large a claim to make from one
   piece of external evidence -- a step says "sooner" and lets a genuinely
   rotten room be demoted again next time.

   Dated from `last`, not from now: the point is to pull the room forward,
   and dating it from today would push a room FURTHER out for having just
   given you trouble. Returns null for a room with no record -- nothing to
   demote, and inventing a schedule from a miss isn't this function's call. */
function demoteRoomReview(record, now = Date.now()){
  if(!record) return null;
  // already below the ladder, and its due date is a real timestamp: re-dating
  // it from the ladder would push a same-day review out to a whole day
  if(record.learning) return record;
  const step = Math.max(0, (record.step || 0) - 1);
  return {
    ...record,
    step,
    due: startOfLocalDay((record.last || now) + ROOM_REVIEW_LADDER[step] * DAY_MS),
  };
}

/* "I got it, but I was guessing." Pulls the next review FORWARD to halfway
   through the current interval, leaving the ladder step alone.

   The step is demonstrated mastery and you did demonstrate it -- you
   produced the move -- so you keep it. What you've reported is that the
   interval is currently too long for this room, which is a statement about
   WHEN, not about how well you know it. That's the gradation against a
   miss: a miss costs you a rung, being unsure just brings the next review
   forward.

   Never pushes a review OUT. An uncertain recall is not evidence that a
   room is safe for longer, and a rule that could delay a review would let a
   shaky room drift -- so a room already due (or nearly) is returned
   unchanged, with nothing to write. */
function softenRoomReview(record, now = Date.now()){
  if(!record || !record.due) return record || null;
  if(record.learning) return record;   // a same-day review is as soon as it gets
  const interval = ROOM_REVIEW_LADDER[record.step || 0] * DAY_MS;
  const pulled = startOfLocalDay(now + interval / 2);
  return pulled < record.due ? { ...record, due: pulled } : record;
}

/* The record a room is EFFECTIVELY on -- the stored one, or a bootstrapped
   one for a room marked memorized but never graded. Both callers want exactly
   this (threeVR.js to grade and tint the brain, app.js to colour the opening
   graph), so the "stored, else bootstrapped, else nothing" rule lives here
   once instead of being written twice and drifting. Takes the two maps rather
   than reading them, since each module keeps its own copy. */
function effectiveRoomReview(reviews, memorized, roomKey){
  if(!roomKey) return null;
  return (reviews && reviews[roomKey]) || bootstrapRoomReview(memorized && memorized[roomKey]);
}

/* Four states, not three: "not memorized at all" has to read differently
   from "memorized and not due yet", or an untouched castle and a
   fully-reviewed one look identical.

   The soon/overdue windows are PROPORTIONAL to the interval rather than
   fixed: a 2-day item should read overdue almost immediately, where a
   180-day one deserves weeks of slack. "due soon" exists because reaching a
   room costs a walk -- unlike a flashcard, where there's no reason to
   review early since coming back is free. */
function roomReviewState(record, now = Date.now()){
  if(!record || !record.due) return 'none';
  const interval = record.learning ? ROOM_LEARNING_MS : ROOM_REVIEW_LADDER[record.step || 0] * DAY_MS;
  if(now >= record.due + Math.max(DAY_MS, interval * 0.5)) return 'overdue';
  if(now >= record.due) return 'due';
  if(now >= record.due - interval * 0.2) return 'soon';
  return 'notdue';
}

/* ---------- forecast buckets (Documents/review-forecast.md) ----------

   Which horizon a room falls into. Bucketed by WHEN IT FALLS DUE, never by
   which rung of the ladder it is on: those are intervals, not dates, and a
   room at step 5 (a 180-day interval) that happens to fall due in four days
   belongs under "this week". Bucketing by step files it under 180 and gets
   the forecast wrong in exactly the case a forecast is for.

   The first two delegate to roomReviewState() rather than re-deriving
   "overdue" from the due date, so this and the digraph's Review lens can
   never disagree about the same room -- its windows are proportional to the
   interval, which is a rule worth not reinventing.

   Ordered soonest-first; a renderer can iterate this and get a sensible
   left-to-right or top-to-bottom order for free. `none` is deliberately last
   and deliberately present: without it a barely-started castle and a
   fully-reviewed one look identical, which is the same reason
   roomReviewState has four states rather than three. */
const REVIEW_FORECAST_BUCKETS = [
  { id: 'overdue',  label: 'Overdue',          color: '#c62828' },
  { id: 'due',      label: 'Due now',          color: '#ef6c00' },
  { id: 'tomorrow', label: 'Tomorrow',         color: '#f9a825' },
  { id: 'week',     label: 'In 2-7 days',      color: '#827717' },
  { id: 'month',    label: 'In 8-30 days',     color: '#2e7d32' },
  { id: 'quarter',  label: 'In 31-90 days',    color: '#00695c' },
  { id: 'later',    label: 'In 90+ days',      color: '#1565c0' },
  { id: 'none',     label: 'Not memorized yet', color: '#9e9e9e' },
];
function reviewForecastBucket(record, now = Date.now()){
  if(!record || !record.due) return 'none';
  const state = roomReviewState(record, now);
  if(state === 'overdue') return 'overdue';
  if(state === 'due') return 'due';
  // A learning review due later today is the one exception to the comment
  // below: its due date is a real timestamp, not a midnight. It is today's
  // work, and the forecast is day-granular, so it counts with today's.
  if(record.learning) return 'due';
  // not due yet, so due dates are midnight-snapped into the future and
  // dueInDays is >= 1 here -- no zero case to worry about
  const d = dueInDays(record, now);
  if(d <= 1) return 'tomorrow';
  if(d <= 7) return 'week';
  if(d <= 30) return 'month';
  if(d <= 90) return 'quarter';
  return 'later';
}

/* "tomorrow" / "in 7 days" -- measured from the START of today, since due
   dates are midnight-snapped (see startOfLocalDay above); a raw now-to-due
   subtraction would report a 1-day interval as 0 days from any afternoon.
   Here rather than in threeVR.js (its original home) because app.js needs
   the same phrasing for the quiz's end-of-session change list, and the two
   modules can't import each other -- same reason demoteRoomReview lives
   here. */
function dueInDays(rec, now = Date.now()){
  return Math.max(0, Math.round((rec.due - startOfLocalDay(now)) / DAY_MS));
}
function duePhrase(rec, now = Date.now()){
  // a learning review is hours away, not days, and its time of day matters --
  // "in 6 hours" alone would leave you working out when that is
  if(rec && rec.learning){
    const ms = rec.due - now;
    if(ms <= 0) return 'now';
    const at = new Date(rec.due).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const h = Math.round(ms / 3600000);
    return h <= 1 ? `within the hour (around ${at})` : `in ${h} hours (around ${at})`;
  }
  const d = dueInDays(rec, now);
  if(d <= 0) return 'today';
  if(d === 1) return 'tomorrow';
  return `in ${d} days`;
}

/* Has anything touched this room's schedule since we wrote `written`?

   Only asked by the quiz's undo, which restores a record it replaced -- and
   must not clobber a VR grade made in another tab in the meantime. Compares
   the fields any operation actually moves rather than deep-equalling the
   object: a grade changes all of these, and both demotion and softening
   change `due`, so nothing that matters slips past. */
function roomReviewMatches(current, written){
  if(!current || !written) return current === written;
  return current.due === written.due && (current.step || 0) === (written.step || 0)
      && (current.last || null) === (written.last || null)
      && (current.lastGrade || null) === (written.lastGrade || null);
}

async function getRoomReviews(){
  const raw = await getMeta(ROOM_REVIEWS_KEY);
  try { return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}
async function setRoomReviews(map){
  return setMeta(ROOM_REVIEWS_KEY, JSON.stringify(map || {}));
}

/* ---------- per-rung grade statistics (Documents/review-forecast.md) ----------

   How each rung of the ladder actually performs for THIS user:
   { step: {A, B, C} }. Collected now, ahead of any UI that reads it, because
   the data is worthless until it has been accumulating for a while. What it
   is for: the forecast currently shows each room's NEXT review only, which
   understates the near future badly -- a room at step 0 reviewed successfully
   appears three times in thirty days, and the calendar shows one. Projecting
   the repeats forward needs a success rate per rung, and a rate invented from
   nothing would be worse than not projecting at all.

   Keyed by the step the review was ON, never the one it moved to. The grade
   judges the interval you just finished sitting out, so an A at step 2 is
   evidence about the 7-day rung -- filing it under the 21-day rung it
   promotes you to would measure the wrong interval, and would do it in the
   direction that makes long rungs look better than they are.

   Only self-assessed GRADES count. A structural demotion or a board-quiz miss
   (demoteRoomReview) changes a schedule without being a verdict on whether
   the interval was right, and softenRoomReview ("I got it, but I was
   guessing") is a statement about timing rather than recall. Folding either
   in would bias the rates with evidence about something else. */
const REVIEW_GRADE_STATS_KEY = 'threeReviewGradeStats';
const REVIEW_GRADES = ['A', 'B', 'C'];
function emptyGradeRow(){ return { A: 0, B: 0, C: 0 }; }

/* Folds one graded review into the tally, returning a NEW object (never
   mutates the old one, same contract as applyRoomReviewGrade).

   `replacing` un-counts a grade this same review already contributed.
   Re-grading a room within one visit REPLACES rather than compounds (see
   threeVR.js's preGradeRecord -- a mis-press is meant to be recoverable), and
   the tally has to follow that or a fumbled grade menu quietly inflates the
   very statistics the projection will lean on. The rung is unchanged across a
   re-grade, since it comes from the visit's frozen pre-grade record, so the
   decrement always lands in the row the increment does.

   Floored at zero rather than trusted: the caller's memory of what it last
   wrote is not a strong enough claim to let it drive a counter negative. */
function tallyReviewGrade(stats, step, grade, replacing = null){
  const out = {};
  for(const [k, v] of Object.entries(stats || {})) out[k] = { ...emptyGradeRow(), ...v };
  const n = Math.trunc(Number(step)) || 0;
  const rung = step === LEARNING_RUNG ? LEARNING_RUNG
    : String(Math.max(0, Math.min(ROOM_REVIEW_LADDER.length - 1, n)));
  const row = out[rung] || (out[rung] = emptyGradeRow());
  if(REVIEW_GRADES.includes(replacing)) row[replacing] = Math.max(0, row[replacing] - 1);
  if(REVIEW_GRADES.includes(grade)) row[grade] = row[grade] + 1;
  return out;
}

async function getReviewGradeStats(){
  const raw = await getMeta(REVIEW_GRADE_STATS_KEY);
  try { return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}
async function setReviewGradeStats(stats){
  return setMeta(REVIEW_GRADE_STATS_KEY, JSON.stringify(stats || {}));
}
/* ---------- the grade event log ----------

   One row per graded review: { t, r, n, d, g } -- when, the rung it was
   reviewed AT, how many moves the room held at that moment, how many days had
   actually elapsed, and the grade.

   Why a log as well as the tally above. The tally answers "how does rung 3
   perform" and nothing else. It cannot answer "do big rooms grade worse",
   because room size is not in it and CANNOT BE ADDED AFTERWARDS: moveCount is
   recomputed from the current repertoire on every render, so how big a room
   was when you graded it in March is not something the app can reconstruct.
   Rooms grow as replies are added, and they split.

   `d` exists for the same reason, and fixes a bias in the tally: a grade is
   filed under its NOMINAL rung, but a rung-2 room reviewed 25 days late is
   evidence about 25 days, not 7. Late reviews fail more, and charging those
   failures to an interval that was never actually tested makes the rung look
   worse than it is -- worst for someone working through an overdue backlog,
   which is exactly when the report is most wanted.

   Both are kept because they lose different things: the tally holds LIFETIME
   totals and never forgets, the log holds the joint distribution for as far
   back as the cap allows. The tally is derivable from the log and not the
   reverse, which is why the log had to exist before the data started arriving
   rather than after. */
const REVIEW_GRADE_LOG_KEY = 'threeReviewGradeLog';
/* ~145 bytes an event now that each carries a room key, so ~1.5MB when full --
   the same footprint as the quiz log, whose rows are the same shape. Halved
   from 20k when `k` was added rather than letting the store triple. A few
   hundred mature rooms generate maybe 1-2k grades a year, so 10k is still
   decades of detail, and the tally above carries the lifetime totals past the
   rollover regardless. */
const REVIEW_GRADE_LOG_CAP = 10000;

/* Appends one event, returning a NEW array. `replacePrev` drops the entry this
   same review already wrote -- the log follows the same "a correction replaces"
   rule as tallyReviewGrade, or a re-graded room lands in the data twice.

   Popping the tail is safe because this log has exactly one writer and every
   write goes through recordReviewGrade's queue below, so "the last entry" is
   unambiguous. The rung check is a cheap guard against that ceasing to be
   true: a mismatch means something else appended in between, and dropping a
   stranger's row would be worse than leaving a duplicate. */
function appendGradeEvent(log, event, replacePrev = false){
  const out = Array.isArray(log) ? log.slice() : [];
  const prev = out.length ? out[out.length - 1] : null;
  // the same review means the same ROOM at the same rung. Matching on the room
  // too is the sharper guard the key bought: before it, two rooms graded in
  // succession from the same rung looked alike to this check. A row written
  // before the log carried a key reads as a non-match and is left alone, which
  // is the safe direction -- a duplicate beats dropping a stranger's row.
  if(replacePrev && prev && prev.r === event.r && (prev.k || null) === (event.k || null)) out.pop();
  out.push(event);
  return out.length > REVIEW_GRADE_LOG_CAP ? out.slice(out.length - REVIEW_GRADE_LOG_CAP) : out;
}

async function getReviewGradeLog(){
  const raw = await getMeta(REVIEW_GRADE_LOG_KEY);
  try { const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; }
  catch { return []; }
}
async function setReviewGradeLog(log){
  return setMeta(REVIEW_GRADE_LOG_KEY, JSON.stringify(Array.isArray(log) ? log : []));
}

/* ---------- the quiz step log ----------

   One row per move ASKED by the board quiz: { t, k, o, p, r, d } -- when, the
   room the move lives in, the outcome, how deep into the line it sat, and the
   room's ladder rung and actual elapsed days at that moment.

   Why this exists ALONGSIDE the grade log rather than inside it. The VR grade
   is self-assessed, room-level, and taken with the move objects in view; the
   quiz is objectively scored, move-level, and cues you one move at a time --
   which is also how a real game tests you. For CALIBRATION the quiz is the
   better instrument, and deliberately not folded into the grade tally, which
   measures how you GRADE and would be corrupted by mixing in a different
   instrument's verdicts (the same reason demoteRoomReview is excluded there).

   `k` is the room key, which the grade log does not carry -- so this is the
   log that can be joined against anything room-shaped later: occurrence
   frequency, castle, how much new material was memorized during the interval.

   Outcomes are one per step, mutually exclusive, written when the step
   resolves rather than when it is attempted:
     hit     correct first try
     unsure  correct, but flagged as guessing before committing
     miss    wrong at least once, then eventually produced
     reveal  gave up and was shown the move */
const QUIZ_LOG_KEY = 'threeQuizLog';

/* THREE quizzes write here, and they are not three versions of the same test
   -- they are three LAYERS, which is why one log rather than three:

     mnem     square+piece <-> word/image   the alphabet every room is built on
     list     an object list's items        the wall content rooms are filled with
     opening  position -> move              the repertoire itself

   A miss in the opening quiz has at least three causes: you don't know the
   line, you don't reliably know what (say) knight-on-e4 looks like, or you
   know both and the wrong image surfaced. Those need completely different
   fixes, and only a log that spans the layers -- in one time order -- can tell
   them apart. Both lower-layer failures are ones the user has actually hit.

   `k` is the subject tested, typed by `q`: a room key, a "square|piece", or an
   item name. The rest are kind-specific and simply absent where they have no
   meaning (JSON omits them), so a row costs only what it carries. */
const QUIZ_KINDS = ['opening', 'mnem', 'list'];
/* PER-KIND caps, not one shared budget -- the part that would otherwise bite.
   A mnemonics drill runs a few hundred trials in a sitting where an opening
   session runs a few dozen, so under one cap the alphabet layer would steadily
   evict the repertoire layer, which is the most valuable of the three. Rows
   carrying a room key run ~145 bytes; the shorter kinds about 90. */
const QUIZ_LOG_CAPS = { opening: 10000, mnem: 10000, list: 5000 };
// a kind added later is still BOUNDED rather than dropped: silently discarding
// real answers would be a worse failure than an oddly-sized bucket
const QUIZ_LOG_CAP_DEFAULT = 5000;
const QUIZ_OUTCOMES = ['hit', 'unsure', 'miss', 'reveal'];
// 'reveal' covers the mnemonics quiz's Give up and the list quiz's Skip alike:
// both mean "I stopped and was shown it", which is one fact, not two.
function quizEventKind(e){ return (e && e.q) || 'opening'; }

/* Appends one step, returning a NEW array. No replacement rule, unlike the
   grade log: a quiz step resolves exactly once and there is no correcting it
   afterwards, so every call is a fresh row.

   Trimming is within the event's own kind, so a long drill of one kind can
   never shorten another's history. */
function appendQuizEvent(log, event){
  if(!event || !QUIZ_OUTCOMES.includes(event.o)) return Array.isArray(log) ? log.slice() : [];
  const out = (Array.isArray(log) ? log : []).slice();
  out.push(event);
  const kind = quizEventKind(event);
  const cap = QUIZ_LOG_CAPS[kind] || QUIZ_LOG_CAP_DEFAULT;
  let over = out.reduce((n, e) => n + (quizEventKind(e) === kind ? 1 : 0), 0) - cap;
  if(over <= 0) return out;
  const kept = [];
  for(const e of out){
    if(over > 0 && quizEventKind(e) === kind){ over--; continue; }   // oldest of THIS kind
    kept.push(e);
  }
  return kept;
}

async function getQuizLog(){
  const raw = await getMeta(QUIZ_LOG_KEY);
  try { const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; }
  catch { return []; }
}
async function setQuizLog(log){
  return setMeta(QUIZ_LOG_KEY, JSON.stringify(Array.isArray(log) ? log : []));
}
/* Serialized for the same reason the grade log is: the quiz's own writes are
   fire-and-forget from the move handler, and a fast session can resolve two
   steps inside one read-modify-write. */
let quizLogQueue = Promise.resolve();
function recordQuizStep(event){
  const next = quizLogQueue.then(async () => {
    const log = appendQuizEvent(await getQuizLog(), event);
    await setQuizLog(log);
    return log;
  });
  quizLogQueue = next.catch(() => {});
  return next;
}

/* SERIALIZED read-modify-write, for both the tally and the log. The keyboard
   grade path does not await gradeCurrentRoom (threeVR.js's onKeyDown fires and
   forgets), so pressing 1 then 2 to correct a mis-press can overlap: without a
   queue the second write can be computed from a read taken before the first
   one landed, and one of them is silently lost. A record meant to accumulate
   over months should not depend on how fast somebody changes their mind.

   opts: { replacing, moves, elapsedDays, now } -- `replacing` is the grade this
   same review already contributed (see tallyReviewGrade), `moves` the room's
   size at this moment, `elapsedDays` how long the interval actually ran. */
let gradeStatsQueue = Promise.resolve();
function recordReviewGrade(step, grade, opts = {}){
  const { replacing = null, moves = 0, elapsedDays = null, roomKey = null, now = Date.now() } = opts;
  const next = gradeStatsQueue.then(async () => {
    const [prevStats, prevLog] = await Promise.all([getReviewGradeStats(), getReviewGradeLog()]);
    const stats = tallyReviewGrade(prevStats, step, grade, replacing);
    const rung = step === LEARNING_RUNG ? LEARNING_RUNG
      : Math.max(0, Math.min(ROOM_REVIEW_LADDER.length - 1, Math.trunc(Number(step)) || 0));
    const log = appendGradeEvent(prevLog,
      { t: now, k: roomKey, r: rung, n: moves || 0, d: elapsedDays, g: grade }, !!replacing);
    await Promise.all([setReviewGradeStats(stats), setReviewGradeLog(log)]);
    return { stats, log };
  });
  // the chain survives a failed write rather than poisoning every later grade
  // with the same rejection
  gradeStatsQueue = next.catch(() => {});
  return next;
}
