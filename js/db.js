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
    req.onblocked = done;
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

  // lines + analysisQueue: `user` is a plain attribute, not part of the
  // primary key -- an in-place put() under the SAME id, with the corrected
  // user field, is enough.
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
    const txn = db.transaction(['lines','prefs','analysisQueue'],'readwrite');
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

async function setPref(lineId, seq, patch){
  const db = await openDB();
  const key = prefKey(lineId,seq);
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('prefs','readwrite');
    const store = txn.objectStore('prefs');
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const existing = getReq.result || {key,lineId,seq,reply:'',note:'',mnemonic:''};
      store.put({...existing, ...patch});
    };
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
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
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const existing = getReq.result || {key,lineId,seq,reply:'',note:'',mnemonic:''};
        store.put({...existing, ...patch});
      };
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
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('mnemonics','readwrite');
    const store = txn.objectStore('mnemonics');
    const getReq = store.get(square);
    getReq.onsuccess = () => {
      const existing = getReq.result || {square, ...BLANK_MNEMONIC_SQUARE};
      store.put({...existing, ...patch});
    };
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
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
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('assets','readwrite');
    const store = txn.objectStore('assets');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const now = Date.now();
      const existing = getReq.result || {...BLANK_ASSET, id, createdAt:now};
      store.put({...existing, ...patch, id, updatedAt:now});
    };
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
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
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('objectLists','readwrite');
    const store = txn.objectStore('objectLists');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const now = Date.now();
      const existing = getReq.result || {...BLANK_OBJECT_LIST, id, createdAt:now};
      store.put({...existing, ...patch, id, updatedAt:now});
    };
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
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
