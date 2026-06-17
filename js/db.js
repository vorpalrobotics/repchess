/* ---------- IndexedDB layer ----------
   Replaces localStorage for data that can grow large: downloaded game
   history and per-line repertoire preferences (reply / note / mnemonic).
*/
const DB_NAME = 'repchess-db';
const DB_VERSION = 1;

/* ---------- one-time wipe of pre-release test data ----------
   No legacy data is worth preserving; localStorage is no longer read
   at all going forward, and any IndexedDB data from earlier testing
   is wiped once so everyone starts fresh.
*/
const FRESH_START_FLAG = 'repchess-fresh-start-v1';
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
      if(!db.objectStoreNames.contains('prefs')){
        const ps = db.createObjectStore('prefs', {keyPath:'key'});
        ps.createIndex('user','user');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
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
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('games','readwrite');
    const store = txn.objectStore('games');
    for(const g of games){
      const gameId = g.id || hashStr(JSON.stringify(g));
      store.put({ id:`${user}:${gameId}`, user, gameId, moves:g.moves, raw:g });
    }
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}

async function getGames(user){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const store = db.transaction('games','readonly').objectStore('games');
    const req = store.index('user').getAll(user);
    req.onsuccess = () => resolve(req.result.map(r=>r.raw));
    req.onerror   = () => reject(req.error);
  });
}

/* ---------- prefs (reply / note / mnemonic per move sequence) ---------- */
const prefKey = (user,seq) => `${user}|${seq.join(',')}`;

async function getAllPrefs(user){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const store = db.transaction('prefs','readonly').objectStore('prefs');
    const req = store.index('user').getAll(user);
    req.onsuccess = () => {
      const map = {};
      for(const r of req.result) map[r.key] = r;
      resolve(map);
    };
    req.onerror = () => reject(req.error);
  });
}

async function setPref(user, seq, patch){
  const db = await openDB();
  const key = prefKey(user,seq);
  return new Promise((resolve,reject)=>{
    const txn = db.transaction('prefs','readwrite');
    const store = txn.objectStore('prefs');
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const existing = getReq.result || {key,user,seq,reply:'',note:'',mnemonic:''};
      store.put({...existing, ...patch});
    };
    txn.oncomplete = () => resolve();
    txn.onerror    = () => reject(txn.error);
  });
}
