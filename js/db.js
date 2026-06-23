/* ---------- IndexedDB layer ----------
   Replaces localStorage for data that can grow large: downloaded game
   history and per-line repertoire preferences (reply / note / mnemonic).
*/
const DB_NAME = 'repchess-db';
const DB_VERSION = 4;

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
    };
    req.onsuccess = () => { console.log('[db] opened', DB_NAME); resolve(req.result); };
    req.onerror   = () => { console.error('[db] open failed',req.error); reject(req.error); };
  }));
  return dbPromise;
}
/* simple non-cryptographic hash, used only when a game has no id */
function hashStr(s){
  let h=0;
  for(let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))|0; }
  return h.toString(36);
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
      store.put({ id:`${user}:${gameId}`, user, gameId, moves:g.moves, raw:g });
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
async function createLine(user, {name, color, openingMoves}){
  const db = await openDB();
  const id = `${user}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;
  const line = {id, user, name, color, openingMoves: openingMoves || [], createdAt: Date.now()};
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

async function updateLine(id, patch){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('lines','readwrite');
    const store = txn.objectStore('lines');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      if(!getReq.result) return;
      store.put({...getReq.result, ...patch});
    };
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

async function deleteLine(id){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction(['lines','prefs'],'readwrite');
    txn.objectStore('lines').delete(id);
    const prefStore = txn.objectStore('prefs');
    const idxReq = prefStore.index('lineId').getAllKeys(id);
    idxReq.onsuccess = () => { for(const k of idxReq.result) prefStore.delete(k); };
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
  id:'', type:'box', image:'',
  size:{w:0.5,h:1,d:0.5}, skinFace:'front', sideColor:'#888888',
  repeatPerMeter:0.5, rotation:0, tint:null, roughness:0.85, metalness:0,
  createdAt:0, updatedAt:0
};

async function getAllAssets(){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const req = db.transaction('assets','readonly').objectStore('assets').getAll();
    req.onsuccess = () => resolve(req.result);
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

/* ---------- full wipe, used before restoring a complete backup ---------- */
async function clearAllData(){
  const db = await openDB();
  const stores = ['games','lines','prefs','mnemonics','meta','assets'];
  return new Promise((resolve,reject)=>{
    const txn = db.transaction(stores,'readwrite');
    for(const s of stores) txn.objectStore(s).clear();
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}
