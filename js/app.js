import { Engine } from './engine.js?v=20260724-5';
import cytoscape from 'https://esm.sh/cytoscape@3.28.1';
import cytoscapeDagre from 'https://esm.sh/cytoscape-dagre@2.5.0?deps=cytoscape@3.28.1';
import { openThreeTest, closeThreeTest, refreshAssetsLive, setForeignModalOpen, jumpToRoom } from './threeVR.js?v=20260724-112';
import { openAssetManager, closeAssetManager, cropImage, fileToDataUrl, webpEncodeSupported, toWebpDataUrl } from './assets.js?v=20260723-72';
import { openObjectListManager, closeObjectListManager, importObjectListsData, isObjectListFile } from './objectLists.js?v=20260723-42';
cytoscape.use(cytoscapeDagre);

// Reaching here means the module's static imports above all loaded; clears the
// boot watchdog in index.html so it doesn't show the "failed to load" message.
window.__APP_BOOTED = true;

// gzip capability flag (native CompressionStream/DecompressionStream) -- read
// by both the backup export/import gzip helpers below AND
// maybeOfferDefaultMnemonics (which fetches a gzipped bundle), the latter
// called from this module's own top-level boot code. Declared this early so
// every reader sees it initialized regardless of which runs first -- it
// previously lived down by the export helpers it was originally added for,
// which put it AFTER that boot-time call in file order and threw
// "Cannot access 'GZIP_OK' before initialization" on every real page load
// (masked in the test harness, which skips that call entirely under
// threeTestDebug).
const GZIP_OK = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

// Everything below is reachable from that same maybeOfferDefaultMnemonics()
// boot call (via importMnemonicsBundle) and was found the same way GZIP_OK
// was: each lived naturally alongside the code that normally uses it, further
// down the file than line ~4150's boot-time call -- fine for every OTHER
// caller (which only runs after the whole module has finished loading), but
// a "Cannot access '<name>' before initialization" TDZ error for this one
// synchronous top-level call, on every real (non-threeTestDebug) page load.
const MNEM_DEFAULT_URL = 'json/repchess-mnemonics-DEFAULT.json.gz';
const MNEM_DEFAULT_OFFERED_KEY = 'mnemDefaultOffered';
const MNEM_NOTES_KEY = 'mnemonicsNotes';
const MNEM_DISAMBIG_KEY = 'moveDisambiguatorImg';
const MNEM_PIECES = ['pawn','knight','bishop','rook','queen','king'];
let MNEMONICS = {};
// recognises a mnemonics-only bundle: explicitly tagged, or (defensively) a
// file that carries a `mnemonics` array but none of the other top-level
// stores a full backup / asset bundle would have.
const isMnemonicsBundle = d =>
  !!d && (d.repchessMnemonics != null ||
    (Array.isArray(d.mnemonics) && !Array.isArray(d.lines) &&
     !Array.isArray(d.assets) && d.repchessAssets == null));

/* cm-chessboard (the 2D board widget) is loaded DYNAMICALLY and tolerantly: it's
   only needed for the four board widgets (analysis board, hover preview, PV
   float, opening quiz). It's tried from unpkg first, then jsdelivr as a fallback
   (independent CDNs, so one provider's outage doesn't sink the board); if BOTH
   fail, the import fails but the rest of the app — home, import, mnemonics,
   assets, the VR world, the graph, FEN/move logic (chess.js, loaded
   separately) — keeps working. COLOR/INPUT_EVENT_TYPE get safe defaults so
   non-board code never trips on them. */
const CM_CHESSBOARD_HOSTS = ['https://unpkg.com', 'https://cdn.jsdelivr.net/npm'];
const PIECES_FILE = `${CM_CHESSBOARD_HOSTS[0]}/cm-chessboard@8/assets/pieces/standard.svg`;
let Chessboard = null;
let COLOR = { white: 'w', black: 'b' };
let INPUT_EVENT_TYPE = {};
for(const host of CM_CHESSBOARD_HOSTS){
  try {
    const cm = await import(`${host}/cm-chessboard@8/src/Chessboard.js`);
    Chessboard = cm.Chessboard; COLOR = cm.COLOR; INPUT_EVENT_TYPE = cm.INPUT_EVENT_TYPE;
    break;
  } catch(err){
    console.warn(`[repchess] chessboard load failed from ${host}`, err);
  }
}
if(!Chessboard) console.warn('[repchess] chessboard unavailable — board widgets disabled, rest of app still works');

/* ---------- version (injected at deploy time as UTC ISO, see workflow) ----------
   Displayed in the visitor's local timezone so it matches their wall clock. */
function formatBuildStamp(utcStamp){
  const d = new Date(utcStamp);
  if(isNaN(d)) return utcStamp;
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}@${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// manual build tag — bump alongside the app.js?v= cache-buster in index.html so
// the visible heading confirms exactly which build loaded, not just the deploy time.
const BUILD_TAG = '-213';
document.getElementById('buildStamp').textContent =
  `(${typeof APP_VERSION!=='undefined' ? formatBuildStamp(APP_VERSION) : 'dev'} ${BUILD_TAG})`;

/* ---------- helpers ---------- */
const $   = id => document.getElementById(id);
const log = (m,e=false)=>{ $('progress').textContent=m; $('progress').classList.toggle('error',e); };
const clr = ()=>{ $('progress').textContent='';$('progress').classList.remove('error'); };
const logDl = (m,e=false)=>{ $('downloadProgress').textContent=m; $('downloadProgress').classList.toggle('error',e); };

/* ---------- general-purpose spinner ----------
   showSpinner(label) shows the overlay and returns a handle; hideSpinner(handle)
   removes that handle and only hides the overlay once every handle issued so far
   has been cleared, so two unrelated long operations that overlap in time don't
   hide each other's spinner early. Each handle is a unique object (not reused),
   so calling hideSpinner with a stale/duplicate handle is a harmless no-op. */
const activeSpinners = new Set();
function showSpinner(label=''){
  const handle = {};
  activeSpinners.add(handle);
  $('spinnerLabel').textContent = label;
  $('spinnerLabel').style.display = label ? '' : 'none';
  $('spinnerOverlay').style.display = 'flex';
  return handle;
}
function hideSpinner(handle){
  activeSpinners.delete(handle);
  if(activeSpinners.size===0) $('spinnerOverlay').style.display='none';
}
/* lets the browser paint the just-shown spinner before a synchronous,
   CPU-heavy operation blocks the main thread */
function nextPaint(){
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/* the overlay starts visible in the static HTML (display:flex inline style) so
   it's on screen from the very first paint, covering the time this module spends
   fetching/parsing its CDN imports before any of its own code can run. Claim that
   visible state as a real spinner handle immediately so activeSpinners reflects
   reality, then hand off to renderHome()'s own showSpinner() call on its first run. */
const bootSpinner = showSpinner('Loading…');
let bootSpinnerHidden = false;
function hideBootSpinner(){
  if(bootSpinnerHidden) return;
  bootSpinnerHidden = true;
  hideSpinner(bootSpinner);
}

/* ---------- persistent prefs (small, stays in localStorage) ---------- */
const LS_ID='lichess_lastUser', LS_MAX='lichess_lastMax';
const LS_ID_CHESSCOM='chesscom_lastUser', LS_MONTHS='chesscom_lastMonths';
const LS_SOURCE='import_lastSource';
const LS_ENGINE_LINES='engine_lastLines', LS_ENGINE_DEPTH='engine_lastDepth', LS_ENGINE_THREADS='engine_lastThreads';
const LS_AQ_THREADS='aq_lastThreads';
const LS_COMPARE_DEPTH='compare_lastDepth';
const COMPARE_DEFAULT_DEPTH=20;
const LS_OQ_QUESTIONS='oq_lastQuestions', LS_OQ_MAXDEPTH='oq_lastMaxDepth', LS_OQ_COVERAGE='oq_lastCoverage', LS_OQ_ONLYMEM='oq_onlyMemorized';
const LS_SHOW_ALL_BRANCHES='repchess_showAllBranches';
const LS_COMPACT_MODE='repchess_compactMode';
$('userId').value  = localStorage.getItem(LS_ID)  || '';
$('maxGames').value= localStorage.getItem(LS_MAX)||300;

/* ---------- globals ---------- */
let GAMES=null, CURRENT_USER=localStorage.getItem(LS_ID)||'', PREFS={}, CURRENT_LINE=null;

// background analysis queue state (see the "background analysis queue"
// section below for the functions that use these) -- declared here, ahead
// of the boot-time refreshAnalysisQueue() call further down, so that call
// isn't reading these bindings before their own `let` would otherwise have run.
let ANALYSIS_QUEUE = [];         // mirrors the IDB store for CURRENT_USER, createdAt order
let AQ_LINE_NAMES = new Map();   // lineId -> line name, for the queue modal's Position column
let aqProcessing = false;        // true while processAnalysisQueueLoop's loop is actively running
let aqCurrentItem = null;        // the queue item currently being searched, or null
let aqCurrentProgress = null;    // {depth, lines} snapshot of the in-flight search, for the modal
let aqAddCtx = null;             // {lineId, seqs} pending in the "Add to Analysis Queue" modal
const AQ_DEFAULT_DEPTH = 40;
const AQ_DEFAULT_LINES = 4;

/* perf escape hatch: node/branch stats recompute the whole subtree on every
   render, which gets expensive on large systems. Flip to false to skip them
   entirely (both the per-row count and the whole-system total) while
   diagnosing slow renders, without touching the rest of the rendering code. */
let ENABLE_NODE_STATS = false;

/* ---------- fetch games from Lichess ---------- */
async function fetchLatest(user,max,onProgress){
  const url=`https://lichess.org/api/games/user/${encodeURIComponent(user)}?max=${max}&moves=true&opening=true`;
  console.log(`[fetchLatest] requesting ${url}`);
  const resp = await fetch(url,{headers:{Accept:'application/x-ndjson'}});
  if(!resp.ok) throw new Error(`lichess returned ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const games = [];
  let buf='', lastReport=Date.now();

  while(true){
    const {done,value} = await reader.read();
    if(value) buf += decoder.decode(value,{stream:true});

    let nl;
    while((nl=buf.indexOf('\n'))>=0){
      const line=buf.slice(0,nl).trim();
      buf=buf.slice(nl+1);
      if(!line) continue;
      try{ games.push(JSON.parse(line)); }catch{ /* skip malformed line */ }
    }

    const now=Date.now();
    if(onProgress && (now-lastReport>=15000 || done)){
      onProgress(games.length);
      lastReport=now;
    }
    if(done) break;
  }

  const tail=buf.trim();
  if(tail){ try{ games.push(JSON.parse(tail)); }catch{ /* skip malformed line */ } }

  console.log(`[fetchLatest] received ${games.length} games`);
  return games;
}

/* ---------- fetch games from Chess.com ----------
   The chess.com PubAPI is month-based: one archive per calendar month a
   player has games in, oldest first. There's no "give me the last N
   games" endpoint, so `months` picks how many of the most recent monthly
   archives to pull, each requested one at a time (chess.com only
   guarantees no rate-limiting for serial, non-parallel requests). Each
   game's PGN is parsed down to a bare space-separated SAN move list so
   the resulting objects have the same shape (`{moves}`) as Lichess's. */
async function ccFetch(url){
  let resp;
  try{ resp = await fetch(url); }
  catch(e){ throw new Error(`chess.com request failed, possibly blocked by CORS (${e.message})`); }
  if(!resp.ok) throw new Error(`chess.com returned ${resp.status} for ${url}`);
  return resp.json();
}
/* the human opening name out of a chess.com ECO URL, e.g.
   ".../openings/Caro-Kann-Defense-Advance-Variation-3.e5" -> "Caro-Kann
   Defense Advance Variation". Best-effort/optional -- returns null if the URL
   isn't in that shape. */
function openingNameFromEcoUrl(url){
  if(typeof url !== 'string') return null;
  const tail = url.split('/openings/')[1];
  if(!tail) return null;
  return decodeURIComponent(tail).replace(/-/g,' ').replace(/\s*\d.*$/,'').trim() || null;
}

/* Normalize one chess.com monthly-archive game object (+ its already-parsed
   SAN move string) into the SAME shape the app reads for Lichess games, so
   everything downstream (and any future "games with this position" view) can
   treat both sources uniformly. Tagged source:'chesscom' so re-imports can
   replace just these. The one field chess.com's public API never exposes is
   the per-game rating change (Lichess's ratingDiff) -- everything else maps.
   Pure (no network / no DOM) so it's unit-testable with a synthetic object. */
function normalizeChessComGame(g, moves){
  const idFromUrl = typeof g.url === 'string' ? g.url.split('/').filter(Boolean).pop() : null;
  const wRes = g.white && g.white.result, bRes = g.black && g.black.result;
  const winner = wRes === 'win' ? 'white' : bRes === 'win' ? 'black' : undefined;
  // the decisive reason lives on the losing side ('win' is the winner's code);
  // for a draw both sides carry the same draw reason, so either works.
  const reason = winner === 'white' ? bRes : winner === 'black' ? wRes : (wRes || bRes);
  const STATUS = {
    checkmated:'mate', resigned:'resign', timeout:'outoftime', abandoned:'aborted',
    stalemate:'stalemate', agreed:'draw', repetition:'draw', insufficient:'draw',
    '50move':'draw', timevsinsufficient:'draw',
  };
  const status = STATUS[reason] || (winner ? 'resign' : 'draw');
  const num = v => (typeof v === 'number' ? v : (v == null || v === '' ? undefined : Number(v) || undefined));
  const name = openingNameFromEcoUrl(g.eco);
  return {
    id: g.uuid || idFromUrl || null,
    source: 'chesscom',
    url: g.url || null,
    rated: !!g.rated,
    speed: g.time_class || null,                     // bullet / blitz / rapid / daily
    createdAt: g.end_time ? g.end_time * 1000 : undefined,
    winner,
    status,
    players: {
      white: { user: { name: (g.white && g.white.username) || null }, rating: num(g.white && g.white.rating) },
      black: { user: { name: (g.black && g.black.username) || null }, rating: num(g.black && g.black.rating) },
    },
    ...(name ? { opening: { name } } : {}),
    moves,
  };
}

async function fetchChessCom(user,months,onProgress){
  const archivesUrl = `https://api.chess.com/pub/player/${encodeURIComponent(user)}/games/archives`;
  console.log(`[fetchChessCom] requesting ${archivesUrl}`);
  const {archives} = await ccFetch(archivesUrl);
  if(!archives?.length) throw new Error('no archives found for this chess.com username');

  const chosen = archives.slice(-months);
  const games = [];
  for(let i=0;i<chosen.length;i++){
    const {games: monthGames} = await ccFetch(chosen[i]);
    for(const g of monthGames){
      if(!g.pgn) continue;
      const chess = new Chess();
      if(!chess.load_pgn(g.pgn)) continue;
      const moves = chess.history().join(' ');
      if(!moves) continue;
      games.push(normalizeChessComGame(g, moves));
    }
    onProgress?.(games.length, i+1, chosen.length);
  }

  console.log(`[fetchChessCom] received ${games.length} games`);
  return games;
}

/* ---------- compute reply frequencies ---------- */
/* ---------- games prefix index (perf) ----------
   replies() is the hot path of the whole tree: it runs once per rendered node,
   again for every step of compact-run detection, and again across the node-stats
   walk. The old implementation re-scanned every game and re-split its move string
   on each call -- O(nodes x games x depth) -- which is what made a 750+ move
   repertoire take ~30s to render (and worse as it grows). Instead we index the
   games once into a prefix trie keyed by lower-cased SAN: each node stores how
   many games pass through it plus the canonical (original-case) move, so
   replies(seq) becomes a depth-length walk that reads the children directly.

   The trie is cached against the GAMES array identity. Every place that loads or
   replaces the game set assigns a brand-new array, so a changed identity rebuilds
   the index automatically; nothing mutates a game's moves in place. */
// games where the user actually played `color` -- the SAME filter Find
// Games/Compare Games already apply (userColorInGame, defined further down,
// hoisted), but feeding the CORE move-frequency trie here, so a game
// reached by the same moves where the user was on the OTHER side (an
// opponent's choice, not theirs) doesn't shape the tree's own rows/
// percentages, node stats, or castle/VR generation either -- not just Find
// Games/Compare Games. Memoized per color (there are only ever two) against
// the `games` array's own identity, so gatherBuiltCastles -- which builds
// every opening system's castles, White and Black alike, in one pass --
// doesn't thrash a single-slot cache alternating between them.
let _gamesForColor = { games: null, byColor: new Map() };
function gamesForLineColor(games, color){
  if(_gamesForColor.games !== games) _gamesForColor = { games, byColor: new Map() };
  if(!_gamesForColor.byColor.has(color)){
    _gamesForColor.byColor.set(color, (games || []).filter(g => userColorInGame(g) === color));
  }
  return _gamesForColor.byColor.get(color);
}

let _gamesTrie = { games: null, root: null };
function buildGamesTrie(games){
  const root = { pass: 0, label: null, kids: new Map() };
  for(const g of games){
    let node = root;
    for(const m of g.moves.split(' ')){
      const key = m.toLowerCase();
      let child = node.kids.get(key);
      if(!child){ child = { pass: 0, label: m, kids: new Map() }; node.kids.set(key, child); }
      child.pass++;
      node = child;
    }
  }
  return root;
}
function gamesTrieRoot(games){
  if(_gamesTrie.games !== games) _gamesTrie = { games, root: buildGamesTrie(games) };
  return _gamesTrie.root;
}

function replies(games,seq){
  let node = gamesTrieRoot(games);
  for(const m of seq){
    node = node.kids.get(m.toLowerCase());
    if(!node) return {counts:{}, tot:0};
  }
  const counts={}; let tot=0;
  for(const child of node.kids.values()){ counts[child.label]=child.pass; tot+=child.pass; }
  return {counts,tot};
}
/* "N (M%)" occurrence stat for one specific opponent reply out of a room,
   against `tot` (that room's total recorded continuations) -- same data the
   move table's own .cnt span uses (renderBranch), just rounded to a whole
   percent since VR door plaques and the digraph have far less room to work
   with than a table row. */
function formatOccurrence(count, tot){
  return `${count||0} (${tot ? Math.round((count/tot)*100) : 0}%)`;
}

/* ---------- node statistics ----------
   A "node" is one move pair: an opponent move plus our chosen reply to it.
   Counts every node in the subtree rooted at `seq` (our move, the same kind
   of sequence renderBranch takes), and the largest branch factor (number of
   opponent move options) seen at any node in that subtree. Only nodes with
   an actual saved reply are counted/descended into — undecided branches
   don't contribute nodes of their own. Hidden branches (and everything
   nested under them) are excluded entirely, same as the eye-toggle filter. */
function computeNodeStats(games,seq){
  const counts = replies(games,seq).counts;
  const manualReplies = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
  manualReplies.forEach(m=>{ if(!(m in counts)) counts[m]=0; });

  const visibleOpps = Object.keys(counts).filter(opp=>
    !PREFS[prefKey(CURRENT_LINE.id,[...seq,opp])]?.hidden);

  let nodeCount = 0, maxBranchFactor = visibleOpps.length;
  // "complete to move N": the shallowest branch's move number, where a branch
  // is measured by OUR last move in it. Reaching our own move N is enough --
  // the opponent needn't have a reply to it. `seq` ends in our move, so its
  // final ply IS our last move here; ceil(ply/2) is that move's number (ply 1
  // & 2 = move 1, ply 3 & 4 = move 2, …), color-agnostic since the move number
  // is absolute. A branch STOPS at this node -- and so is complete only to our
  // move here -- when the opponent has no visible reply at all, or has a
  // visible reply we haven't answered; a fully-answered node keeps going.
  const ourMove = Math.ceil(seq.length / 2);
  const stopsHere = visibleOpps.length === 0 ||
    visibleOpps.some(opp => !PREFS[prefKey(CURRENT_LINE.id,[...seq,opp])]?.reply);
  let completeToMove = stopsHere ? ourMove : Infinity;
  for(const opp of visibleOpps){
    const lineSeq = [...seq,opp];
    const reply = PREFS[prefKey(CURRENT_LINE.id,lineSeq)]?.reply;
    if(!reply) continue;
    nodeCount++;
    const sub = computeNodeStats(games,[...lineSeq,reply]);
    nodeCount += sub.nodeCount;
    maxBranchFactor = Math.max(maxBranchFactor, sub.maxBranchFactor);
    completeToMove = Math.min(completeToMove, sub.completeToMove);
  }
  return {nodeCount, maxBranchFactor, completeToMove};
}

async function showNodeStats(games,seq){
  const spinner = showSpinner('Computing node statistics…');
  await nextPaint();
  let stats;
  try {
    stats = computeNodeStats(games,seq);
  } finally {
    hideSpinner(spinner);
  }
  const complete = Number.isFinite(stats.completeToMove)
    ? `\nComplete to move: ${stats.completeToMove}`
    : '';
  alert(`Nodes below this point: ${stats.nodeCount}\nMax branch factor: ${stats.maxBranchFactor}${complete}`);
}

function formatNodeStats({nodeCount,maxBranchFactor}){
  return `${nodeCount} node${nodeCount===1?'':'s'}, max branch ${maxBranchFactor}`;
}

/* whole-opening-system totals: sums computeNodeStats() across every root
   trigger (each "1. e4" / "1. d4" / etc heading), excluding hidden ones.
   For black lines the root row itself (the trigger) can be hidden and is
   itself a node (trigger + our reply), unlike white roots which start
   counting from the opponent's first reply to our trigger move. */
function computeSystemStats(games,line){
  const triggers = line.openingMoves || [];
  let nodeCount = 0, maxBranchFactor = 0;
  if(line.color==='black'){
    const visibleTriggers = triggers.filter(t=>!PREFS[prefKey(line.id,[t])]?.hidden);
    maxBranchFactor = visibleTriggers.length;
    for(const trigger of visibleTriggers){
      const reply = PREFS[prefKey(line.id,[trigger])]?.reply;
      if(!reply) continue;
      nodeCount++;
      const sub = computeNodeStats(games,[trigger,reply]);
      nodeCount += sub.nodeCount;
      maxBranchFactor = Math.max(maxBranchFactor, sub.maxBranchFactor);
    }
  } else {
    for(const trigger of triggers){
      const sub = computeNodeStats(games,[trigger]);
      nodeCount += sub.nodeCount;
      maxBranchFactor = Math.max(maxBranchFactor, sub.maxBranchFactor);
    }
  }
  return {nodeCount, maxBranchFactor};
}

function refreshSystemStats(){
  const span = $('systemStats');
  if(!span) return;
  if(!ENABLE_NODE_STATS){ span.textContent = ''; return; }
  if(!CURRENT_LINE || !GAMES){ span.textContent = ''; return; }
  span.textContent = formatNodeStats(computeSystemStats(gamesForLineColor(GAMES, CURRENT_LINE.color), CURRENT_LINE));
}

/* ---------- games with this position (three-dot menu → Games with this Position) ----------
   Lists the user's own games that reached a given position, with date / players
   / ratings / result and the move they played from it. Two match modes: any
   transposition (the exact position by any move order, anywhere in the DB --
   the default) or this line only (games that followed exactly this move
   sequence). Rich columns show for Lichess and (post-enrichment) chess.com
   games; legacy bare {moves} games still count but show moves only. */

// positionKey -> [{ key:gameIndexKey, move:SAN|null }] for EVERY position in
// every game (`move` is the one played FROM that position; null at game's
// end). Entries are keyed by a STABLE, CONTENT-based per-game key (see
// gameIndexKey below) rather than the game's position in any particular
// GAMES array, specifically so reindexAfterImport (below) can APPEND newly
// imported games onto an existing index without caring what order getGames()
// happens to return things in.
//
// Cached in memory against the GAMES array identity (so repeat queries within
// the same page load are instant, same pattern as the reply trie) AND
// persisted to IndexedDB (meta key POSITION_INDEX_CACHE_KEY, same pattern as
// BUILT_CASTLES_CACHE_KEY/gatherBuiltCastles) -- for a large game database
// (thousands of games) the chess.js replay is expensive enough to be worth
// surviving a browser refresh instead of paying that cost every session.
//
// Two ways the index gets updated:
//  - invalidatePositionIndexCache() drops it entirely -- used only by
//    importBackup's full restore, which can swap in a completely different
//    user's data, so there's nothing to sensibly diff/append against.
//  - reindexAfterImport() updates it AT IMPORT TIME for the two routine
//    import paths (chess.com/Lichess download, local file import): appends
//    just the games it hasn't seen before rather than rebuilding everything,
//    so a "check for new games" import stays fast even against a large
//    existing database, and the index is already current by the time the
//    import finishes (not deferred to the next "Games with this Position"
//    open).
// Neither is triggered by every GAMES reassignment -- GAMES is also
// reassigned on every ordinary page load via the lazy
// `if(!GAMES) GAMES = await getGames()` reads, which don't change content.
const POSITION_INDEX_CACHE_KEY = 'gamesPositionIndexCache';
let _posIndex = { games: null, map: null };
let _posIndexIdbChecked = false;   // have we tried loading the persisted copy yet this page load?
let _posIndexBuildCount = 0;       // real (non-cache-hit) FULL builds this page load -- test-only signal
function invalidatePositionIndexCache(){
  _posIndex = { games: null, map: null };
  _posIndexIdbChecked = true;   // no need to re-check IDB -- we just made the persisted copy stale too
  setMeta(POSITION_INDEX_CACHE_KEY, '');   // fire-and-forget, same pattern as invalidateBuiltCastlesCache
}
// A stable key for one game, independent of its position in any array --
// same scheme putGames (db.js) already uses to dedupe by id at the storage
// layer: the game's own id when present (every chess.com/Lichess game has
// one), falling back to a content hash for the legacy bare {moves}-only
// shape (pre-metadata-enrichment chess.com imports) that predates ids.
function gameIndexKey(game){
  return game.id || hashStr(JSON.stringify(game));
}
function indexOneGame(add, game){
  const key = gameIndexKey(game);
  const chess = new Chess();
  const sans = (game.moves || '').split(' ').filter(Boolean);
  for(let i=0;i<sans.length;i++){
    add(positionKey(chess.fen()), { key, move: sans[i] });
    if(!chess.move(sans[i], { sloppy:true })) return;   // corrupt game — stop indexing it
  }
  add(positionKey(chess.fen()), { key, move: null });   // final position, no move after
}
// Replays every game move-by-move through chess.js -- for a large game
// database (e.g. months of chess.com history) that's slow enough as one
// unbroken synchronous loop to trip the browser's "page unresponsive"
// warning. Yield to the event loop every CHUNK games so the "Indexing your
// games…" message the caller already shows stays live/responsive throughout.
const POSITION_INDEX_CHUNK = 100;
async function buildPositionIndex(games, onProgress){
  const map = new Map();
  const add = (key, entry) => { let a = map.get(key); if(!a){ a=[]; map.set(key,a); } a.push(entry); };
  for(let gi=0; gi<games.length; gi++){
    indexOneGame(add, games[gi]);
    if(gi % POSITION_INDEX_CHUNK === POSITION_INDEX_CHUNK - 1){
      onProgress?.(gi + 1, games.length);
      await nextPaint();
    }
  }
  return map;
}
// loads the persisted copy into _posIndex.map (at most once per page load,
// leaving _posIndex.games null -- the caller decides what games array the
// resulting map should be considered current for). Shared by positionIndex
// (the lazy, query-time path) and reindexAfterImport (the eager, import-time
// path) so both agree on when a persisted copy has already been checked.
async function loadPersistedIndexOnce(){
  if(_posIndex.map || _posIndexIdbChecked) return;
  _posIndexIdbChecked = true;
  try {
    const raw = await getMeta(POSITION_INDEX_CACHE_KEY);
    if(!raw) return;
    const map = new Map(JSON.parse(raw));
    // Sanity-check the entry shape before trusting it. The very first version
    // of this persisted format (before gameIndexKey existed) stored entries
    // as {g:arrayIndex, move} instead of {key:gameIndexKey, move} -- a blob
    // saved under that shape (e.g. still sitting in a browser's IndexedDB
    // from before this format changed) would otherwise load silently and
    // EVERY lookup would just quietly return zero matches (gamesAtPosition's
    // byKey.get(undefined) for every hit, since old entries have no .key) --
    // "Games with this Position" reporting no games for a position that
    // obviously has some, with no error anywhere. Bail out to a fresh
    // rebuild instead of trusting a shape that doesn't match what this
    // build's code actually reads.
    const [sample] = map.values();
    if(map.size && !(sample?.[0] && 'key' in sample[0])){
      console.warn('[games index] persisted index is in an old/incompatible format -- rebuilding');
      return;
    }
    _posIndex = { games: null, map };
  } catch(e){ console.warn('[games index] failed to read the persisted index, will rebuild', e); }
}
async function positionIndex(games, onProgress){
  if(_posIndex.games === games) return _posIndex.map;
  await loadPersistedIndexOnce();
  if(_posIndex.map){
    // a persisted (or already in-memory) copy exists -- there's no path in
    // this codebase that changes GAMES' content without going through
    // reindexAfterImport/invalidatePositionIndexCache, so it's safe to treat
    // it as current for `games` too.
    _posIndex.games = games;
    return _posIndex.map;
  }
  const map = await buildPositionIndex(games, onProgress);
  _posIndex = { games, map };
  _posIndexBuildCount++;
  setMeta(POSITION_INDEX_CACHE_KEY, JSON.stringify([...map]));   // fire-and-forget: persist across reloads
  return map;
}
// Called right after a ROUTINE import (chess.com/Lichess download, local file
// import) writes new/changed games. putGames upserts by a stable id, so
// `freshGames` (the full post-import array) typically still contains plenty
// of ALREADY-indexed games -- e.g. a chess.com re-import covering overlapping
// months -- diffed out here by the same content-based key gamesAtPosition
// uses, so a routine "check for new games" import only pays to index games it
// hasn't seen before, not the whole database. Falls back to a full build if
// there's no existing index anywhere yet (first import ever, or first import
// this page load with nothing persisted) -- there's no cheaper way to produce
// a first-ever index.
async function reindexAfterImport(freshGames, onProgress){
  await loadPersistedIndexOnce();
  if(!_posIndex.map){
    _posIndex = { games: freshGames, map: await buildPositionIndex(freshGames, onProgress) };
    _posIndexBuildCount++;
  } else {
    const already = new Set();
    for(const entries of _posIndex.map.values()) for(const e of entries) already.add(e.key);
    const toAdd = freshGames.filter(g => !already.has(gameIndexKey(g)));
    if(toAdd.length){
      const add = (key, entry) => { let a = _posIndex.map.get(key); if(!a){ a=[]; _posIndex.map.set(key,a); } a.push(entry); };
      for(let i=0;i<toAdd.length;i++){
        indexOneGame(add, toAdd[i]);
        if(i % POSITION_INDEX_CHUNK === POSITION_INDEX_CHUNK - 1){
          onProgress?.(i + 1, toAdd.length);
          await nextPaint();
        }
      }
    }
    _posIndex.games = freshGames;
  }
  setMeta(POSITION_INDEX_CACHE_KEY, JSON.stringify([..._posIndex.map]));   // fire-and-forget: persist across reloads
}
// key -> game lookup for the CURRENT games array, memoized against its
// identity (rebuilding it is cheap -- no chess.js involved -- but still O(n),
// no reason to redo it for every query against the same array).
let _posIndexByKey = { games: null, byKey: null };
function gamesByIndexKey(games){
  if(_posIndexByKey.games === games) return _posIndexByKey.byKey;
  const byKey = new Map();
  for(const g of games) byKey.set(gameIndexKey(g), g);
  _posIndexByKey = { games, byKey };
  return byKey;
}
// games (+ the move played from here) that reached `fen`'s position by ANY move order.
async function gamesAtPosition(games, fen, onProgress){
  const map = await positionIndex(games, onProgress);
  const hits = map.get(positionKey(fen)) || [];
  const byKey = gamesByIndexKey(games);
  // .filter(): a hit whose game no longer exists in `games` (deleted since
  // it was indexed -- not a path any current import/reindex code takes, but
  // cheap to guard against a stale entry silently) is dropped rather than
  // shown as a broken row.
  return hits.map(h => ({ game: byKey.get(h.key), move: h.move })).filter(x => x.game);
}
// games that followed EXACTLY `seq` (a prefix match on the SAN move list), with
// the move each played immediately after — the strict "this line only" view.
function gamesAlongLine(games, seq){
  const lower = seq.map(m => m.toLowerCase());
  const out = [];
  for(const game of games){
    const sans = (game.moves || '').split(' ').filter(Boolean);
    if(sans.length < lower.length) continue;
    let ok = true;
    for(let i=0;i<lower.length;i++){ if(sans[i].toLowerCase() !== lower[i]){ ok=false; break; } }
    if(ok) out.push({ game, move: sans[lower.length] || null });
  }
  return out;
}

/* ---------- "Compare Games" (three-dot menu) ----------
   Shown as commentary rows under a node, not a modal (unlike "Browse Games")
   -- one row per move YOU actually played from this exact position (exact-
   line match only, not any-transposition: this is about what happened down
   THIS specific prep path, not the position in general). The header row
   carries the node's own configured standard reply, boldfaced -- its eval
   (if any) is read straight from that child's own PREFS entry, since it's a
   real expanded tree branch with its own Analyse/queue affordances already.
   Every OTHER move actually played gets its own indented row below it,
   sorted by play count, with an "Analyze Others" icon on the header row to
   background-analyze all of them at once (see queueAlternatesForAnalysis). */
// Only games where the signed-in user was actually playing CURRENT_LINE's
// own color count here -- gamesAlongLine matches purely on the move text, so
// without this a game reached via the SAME move order but where the user was
// on the other side (an opponent's choice, not the user's own) would get
// counted as something the user "played." A game whose color can't be
// determined at all (a legacy bare chess.com import) is excluded the same
// way, for the same reason: it can't be confirmed to be the user's own move
// either. Uses userColorInGame/gameOutcomeForUser, the same helpers "Find
// Games"' own summary line does (defined further down, hoisted).
function actualMoveComparison(seq){
  const stats = {};
  for(const { game, move } of gamesAlongLine(GAMES || [], seq)){
    if(!move) continue;
    const userColor = userColorInGame(game);
    if(userColor !== CURRENT_LINE.color) continue;
    const rec = stats[move] ??= { move, count:0, win:0, loss:0, draw:0 };
    rec.count++;
    const outcome = gameOutcomeForUser(game, userColor);
    if(outcome) rec[outcome]++;
  }
  return Object.values(stats).sort((a,b) => b.count - a.count);
}

// "3." or "3..." -- the SAN move-number prefix for whichever ply comes right
// after `seq` (White to move on an even ply count, Black on an odd one).
function compareMoveNumberLabel(seq){
  const num = Math.floor(seq.length/2) + 1;
  return seq.length % 2 === 0 ? `${num}.` : `${num}...`;
}

// Eval tag for a played move at this node, read straight from PREFS -- the
// SAME per-seq store every other part of the app reads/writes, whether the
// seq is a real expanded tree branch (the standard reply) or a hypothetical
// one only ever reached through this panel's "Analyze Others" icon. A move
// with a matching entry in the background analysis queue also shows a small
// pending/processing indicator, so a still-running analysis is visible
// rather than just silently absent.
function actualEvalTagHtml(lineId, seq){
  const savedEval = PREFS[prefKey(lineId, seq)]?.eval;
  const evalHtml = savedEval
    ? `<span class="meta-actual-eval meta-pv-score ${evalClass(savedEval, CURRENT_LINE.color)}">${escapeHtml(formatEvalTag(savedEval))}</span>`
    : '';
  const queued = ANALYSIS_QUEUE.find(it => it.lineId === lineId && seqEq(it.seq, seq));
  if(!queued) return evalHtml;
  const processing = aqCurrentItem?.id === queued.id;
  return evalHtml + `<i class="fa-solid fa-hourglass-half meta-actual-pending${processing ? ' fa-fade' : ''}" ` +
    `title="${processing ? 'Analyzing…' : 'Queued for analysis'}"></i>`;
}

const ACTUAL_DISMISS_ICON = '<i class="fa-solid fa-code-compare meta-actual-dismiss" title="Hide this comparison"></i>';
const ACTUAL_ANALYZE_ALL_ICON = '<i class="fa-solid fa-bolt meta-actual-analyze-all" title="Analyze all other replies"></i>';

// A leading colour-coded NET score (wins minus losses, green/red/neutral),
// then the full "+W =D −L" breakdown uncoloured -- e.g. a 3-1-0 record shows
// "+2=+3 =1 −0". '' when none of this move's games have a determinable
// outcome (all legacy bare/unknown-color games), so it doesn't misleadingly
// print "0=+0 =0 −0" for a move that actually has games, just none with a
// known result.
function actualRecordHtml(rec){
  if(!rec.win && !rec.loss && !rec.draw) return '';
  const net = rec.win - rec.loss;
  const cls = net > 0 ? 'meta-actual-record-good' : net < 0 ? 'meta-actual-record-bad' : 'meta-actual-record-neutral';
  return `<span class="meta-actual-record" title="${rec.win}W ${rec.draw}D ${rec.loss}L from games with a determinable result">` +
    `<span class="${cls}">${net > 0 ? '+' : ''}${net}</span>=+${rec.win} =${rec.draw} −${rec.loss}</span>`;
}

// a mate score isn't linearly comparable to a centipawn one, but the
// weighted-average comparison below needs SOME number -- treat it as a
// decisively large pawn value (same convention formatEvalTag-adjacent code
// elsewhere uses when a rough magnitude, not the exact mate distance, is
// what matters).
const MATE_PAWNS_PROXY = 30;
function evalPawns(evalObj){
  return evalObj.type === 'mate' ? (evalObj.value >= 0 ? MATE_PAWNS_PROXY : -MATE_PAWNS_PROXY) : evalObj.value / 100;
}

// "Standard vs. other moves: +N.N" -- how much the standard reply's own eval
// beat (or, negative, lost to) the play-count-weighted average eval of every
// OTHER move actually played, from the line's own perspective (so a positive
// number always means the standard did better -- including a Black line
// where a lower White-relative eval is the good outcome). Only shown once
// every other move has actually been analyzed to at least the depth the user
// last asked "Analyze Others" for -- a partial average would be misleading,
// not just incomplete. null when there's nothing to compute yet.
function actualStandardSummary(lineId, seq, reply, others){
  const standardEval = reply && PREFS[prefKey(lineId, [...seq, reply])]?.eval;
  if(!standardEval || !others.length) return null;
  const requestedDepth = parseInt(localStorage.getItem(LS_COMPARE_DEPTH), 10) || COMPARE_DEFAULT_DEPTH;
  const otherEvals = others.map(({move,count}) => ({eval: PREFS[prefKey(lineId, [...seq, move])]?.eval, count}));
  if(otherEvals.some(({eval:ev}) => !ev || ev.depth < requestedDepth)) return null;
  const totalCount = otherEvals.reduce((sum,{count}) => sum + count, 0);
  const weightedAvgOther = otherEvals.reduce((sum,{eval:ev,count}) => sum + evalPawns(ev) * count, 0) / totalCount;
  const diffWhiteRelative = evalPawns(standardEval) - weightedAvgOther;
  return CURRENT_LINE.color === 'black' ? -diffWhiteRelative : diffWhiteRelative;
}

function actualMovesHtml(lineId, seq, reply){
  const alts = actualMoveComparison(seq);
  if(!alts.length){
    return `<div class="meta-actual meta-actual-none" title="No games in your own history reach this position">` +
      `<div class="meta-actual-row meta-actual-header">${ACTUAL_DISMISS_ICON} No games to compare</div></div>`;
  }
  const replyLower = (reply || '').toLowerCase();
  const others = alts.filter(({move}) => move.toLowerCase() !== replyLower);
  const moveChip = move => {
    const fenAfter = fenForSeq([...seq, move]);
    return `<span class="pv-move meta-actual-move" data-fen="${escapeHtml(fenAfter)}">${escapeHtml(move)}</span>`;
  };
  const moveNumberLabel = compareMoveNumberLabel(seq);
  const replyRec = alts.find(a => a.move.toLowerCase() === replyLower);
  const icons = ACTUAL_DISMISS_ICON + (others.length ? ACTUAL_ANALYZE_ALL_ICON : '');
  // the standard's own row lives in the SAME <table> as the "other moves"
  // rows below, in the same column order (move-number/move/count/record/
  // eval), so its record and eval line up with every other row's instead of
  // drifting off on its own (the originally-reported gap: only the "other"
  // rows were a real table, so the standard's win/loss and eval floated free).
  const headerRow = reply
    ? `<tr class="meta-actual-row meta-actual-header">` +
      `<td class="meta-actual-icons">${icons}</td>` +
      `<td class="meta-actual-move-number">${moveNumberLabel}</td>` +
      `<td><strong>${moveChip(reply)}</strong></td>` +
      `<td><em>(${replyRec?.count || 0}×)</em></td>` +
      `<td>${replyRec ? actualRecordHtml(replyRec) : ''}</td>` +
      `<td>${actualEvalTagHtml(lineId, [...seq, reply])}</td>` +
      `</tr>`
    : `<tr class="meta-actual-row meta-actual-header">` +
      `<td class="meta-actual-icons">${icons}</td>` +
      `<td class="meta-actual-move-number">${moveNumberLabel}</td>` +
      `<td colspan="4"><button type="button" class="meta-actual-use" data-move="${escapeHtml(alts[0].move)}">Use as Standard</button></td>` +
      `</tr>`;
  const altRows = others.map(rec =>
    `<tr class="meta-actual-alt-row">` +
    `<td></td>` +
    `<td class="meta-actual-move-number">${moveNumberLabel}</td>` +
    `<td>${moveChip(rec.move)}</td>` +
    `<td><em>(${rec.count}×)</em></td>` +
    `<td>${actualRecordHtml(rec)}</td>` +
    `<td>${actualEvalTagHtml(lineId, [...seq, rec.move])}</td>` +
    `</tr>`
  ).join('');
  const table = `<table class="meta-actual-alt-table"><tbody>${headerRow}${altRows}</tbody></table>`;
  const summary = actualStandardSummary(lineId, seq, reply, others);
  const summaryRow = summary === null ? '' :
    `<div class="meta-actual-row meta-actual-summary ${summary > 0.1 ? 'meta-actual-summary-good' : summary < -0.1 ? 'meta-actual-summary-bad' : 'meta-actual-summary-neutral'}">` +
    `Standard vs. other moves: <strong>${summary >= 0 ? '+' : ''}${summary.toFixed(1)}</strong></div>`;
  return `<div class="meta-actual" title="Moves you've actually played here, from your own games. Click a move for a mini board.">` +
    table + summaryRow + `</div>`;
}

// which side the signed-in user played, or null when unknown (a legacy bare
// {moves} game, or someone else's game). CURRENT_USER (the app's one overall
// identity) is only ever bootstrapped from whichever platform got imported
// FIRST (`if(!CURRENT_USER) CURRENT_USER = fetchUser;` in dlBtn) and never
// updated after that -- a LATER-imported platform's own handle can
// legitimately differ (e.g. a chess.com username that doesn't match an
// earlier Lichess import's), so also try the per-platform username
// remembered at import time (LS_ID_CHESSCOM / LS_ID, set alongside
// CURRENT_USER in dlBtn) before giving up. Without this fallback every game
// from that later platform would read as "someone else's game" despite the
// player data being right there.
function userColorInGame(game){
  const perPlatform = localStorage.getItem(game.source === 'chesscom' ? LS_ID_CHESSCOM : LS_ID);
  const candidates = [CURRENT_USER, perPlatform].filter(Boolean).map(s => s.toLowerCase());
  if(!candidates.length) return null;
  const w = game.players?.white?.user?.name?.toLowerCase();
  const b = game.players?.black?.user?.name?.toLowerCase();
  if(w && candidates.includes(w)) return 'white';
  if(b && candidates.includes(b)) return 'black';
  return null;
}
// win / loss / draw from the user's perspective, or null when the user's color
// in this game is unknown (bare games) — a known color plus no winner is a
// genuine draw.
function gameOutcomeForUser(game, color){
  if(!color) return null;
  if(game.winner === 'white' || game.winner === 'black') return game.winner === color ? 'win' : 'loss';
  return 'draw';
}
// the click-out URL for a game, if we have one (Lichess id → lichess.org/<id>;
// chess.com carries its own url). Null for bare games with nothing to link to.
function gameLink(game){
  if(game.url) return game.url;                               // chess.com (normalized) carries the full url
  if(game.source === 'chesscom') return null;
  if(typeof game.id === 'string' && game.id) return `https://lichess.org/${game.id}`;
  return null;
}
// a short, human "how it ended" from the (Lichess-style) status field.
const GAME_STATUS_LABEL = { mate:'checkmate', resign:'resignation', outoftime:'time', stalemate:'stalemate', draw:'draw', aborted:'aborted', timeout:'time' };
// which provider a game came from, for the games-list badge. Lichess games
// always carry `players`; chess.com games are either tagged source:'chesscom'
// (post-enrichment) or -- for legacy pre-enrichment imports -- bare {moves}
// objects with no players/id/createdAt at all. Nothing else produces that
// bare shape (manual file imports are always Lichess-shaped ndjson), so it's
// an unambiguous chess.com signal.
function gameSource(game){
  if(game.source === 'chesscom') return 'chesscom';
  if(game.players) return 'lichess';
  return 'chesscom';
}
const GAME_SOURCE_BADGE = {
  chesscom: '<i class="fa-solid fa-chess-pawn games-col-src cc" title="chess.com"></i>',
  lichess:  '<i class="fa-solid fa-chess-knight games-col-src lichess" title="Lichess"></i>',
};

// numbered SAN text for a move sequence, e.g. ['d4','Nf6','c4'] -> "1. d4 Nf6 2. c4"
// -- the format Browse Games' moves input is pre-filled with and re-parses
// via parseAlgebraicMoveList.
function movesToNumberedText(seq){
  const out = [];
  seq.forEach((mv, i) => { if(i % 2 === 0) out.push(`${i/2 + 1}.`); out.push(mv); });
  return out.join(' ');
}

// { mode, color } for the currently open Browse Games modal -- 'mode':
// 'pos'|'line'; 'color': 'white'|'black'|'either'. The move sequence itself
// is NOT stored here: it's always read live from #gamesListMovesInput, so
// editing it re-filters in place (this is what makes the modal usable both
// as a generic browser and as the three-dot menu's node-scoped view, which
// just pre-fills the input rather than fixing it).
let _gamesModalState = null;
function showGamesAtNode(seq){
  openBrowseGames({ seq, color: CURRENT_LINE ? CURRENT_LINE.color : 'either' });
}
// the shared opener: the three-dot "Browse Games" row action pre-fills the
// node's own move sequence and defaults the color filter to the opening
// system's own side (so it keeps its old scoped-to-my-prep behavior); the
// hamburger's "Browse Games" opens it blank with color 'either' for
// unscoped browsing. Lazy-loads GAMES itself (like openThreeTestAssets/
// computeMnemonicCoverage do) rather than just alerting when it's merely not
// loaded into memory yet -- the hamburger item can be the very first thing a
// user clicks this page load, before any line's openLine() has had a chance
// to populate GAMES, even though real imported games already exist in IDB.
async function openBrowseGames({ seq = [], color = 'either' } = {}){
  if(!GAMES && CURRENT_USER){ GAMES = await getGames(CURRENT_USER); }
  if(!GAMES || !GAMES.length){ alert('Import your games first (menu → Import Games) to see this.'); return; }
  _gamesModalState = { mode: 'pos', color };
  $('gamesListMovesInput').value = seq.length ? movesToNumberedText(seq) : '';
  $('gamesListMovesError').textContent = '';
  $('gamesModePos').classList.add('active');
  $('gamesModeLine').classList.remove('active');
  document.querySelectorAll('.games-color-btn').forEach(b => b.classList.toggle('active', b.dataset.color === color));
  $('gamesListOverlay').style.display = 'flex';
  renderGamesList();
}
async function renderGamesList(){
  if(!_gamesModalState) return;
  const { mode, color } = _gamesModalState;
  const text = $('gamesListMovesInput').value;
  let seq;
  try { seq = text.trim() ? parseAlgebraicMoveList(text) : []; }
  catch(err){ $('gamesListMovesError').textContent = err.message; return; }   // keep showing the last valid results
  $('gamesListMovesError').textContent = '';
  const fen = fenForSeq(seq);

  const body = $('gamesListBody');
  // the position index build can take a moment on a big DB — show a spinner the
  // first time (subsequent opens reuse the cache), with a running "N of M"
  // count so a large database (thousands of games) doesn't look stalled.
  const needsIndex = mode === 'pos' && _posIndex.games !== GAMES;
  const showIndexingProgress = (done, total) => {
    body.innerHTML = `<div class="games-list-empty">Indexing your games… ${done} of ${total}</div>`;
  };
  if(needsIndex){ body.innerHTML = '<div class="games-list-empty">Indexing your games…</div>'; await nextPaint(); }

  // only games where the user was actually playing the selected color count
  // as "my games" here -- gamesAtPosition/gamesAlongLine match purely on
  // position/move-text, so without this a game the user reached via the same
  // moves while playing the OTHER side (their opponent's choice, not theirs)
  // would get shown and counted as if it were their own practice. A game
  // whose color can't be determined at all (a legacy bare chess.com import)
  // is excluded even for "Either" -- it can't be confirmed to be the user's
  // own game at all, regardless of which side.
  const rawMatches = mode === 'pos' ? await gamesAtPosition(GAMES, fen, showIndexingProgress) : gamesAlongLine(GAMES, seq);
  const matches = rawMatches.filter(({game}) => {
    const gc = userColorInGame(game);
    return color === 'either' ? gc != null : gc === color;
  });
  const sideToMove = fen.split(' ')[1];   // 'w' | 'b' — whose move it is at this position

  // summary: count + result tally (from the user's perspective, where known) +
  // "played your repertoire move in X of Y" when a reply is configured here
  // (only meaningful when this position is a node in the currently open line).
  let win=0, loss=0, draw=0, known=0;
  const reply = CURRENT_LINE ? PREFS[prefKey(CURRENT_LINE.id, seq)]?.reply : null;
  let yourTurnGames=0, followedReply=0;
  for(const { game, move } of matches){
    const gc = userColorInGame(game);
    const oc = gameOutcomeForUser(game, gc);
    if(oc){ known++; if(oc==='win') win++; else if(oc==='loss') loss++; else draw++; }
    if(gc && gc[0] === sideToMove){   // it was the user's move from here
      yourTurnGames++;
      if(reply && move && move.toLowerCase() === reply.toLowerCase()) followedReply++;
    }
  }
  const pct = known ? Math.round((win + draw*0.5) / known * 100) : null;
  const bar = known ? `<span class="games-score-bar" title="${win}W ${draw}D ${loss}L">`+
      `<i class="gw" style="width:${win/known*100}%"></i><i class="gd" style="width:${draw/known*100}%"></i><i class="gl" style="width:${loss/known*100}%"></i></span>` : '';
  const colorLabel = color === 'black' ? 'Black' : color === 'white' ? 'White' : null;
  $('gamesListSummary').innerHTML =
    `<span><strong>${matches.length}</strong> of your game${matches.length===1?'':'s'}${colorLabel?` as ${colorLabel}`:''}</span>` +
    (known ? `<span>+${win} =${draw} −${loss}${pct!=null?` (${pct}%)`:''}</span>${bar}` : '') +
    (reply && yourTurnGames ? `<span>played your move <strong>${escapeHtml(reply)}</strong> in ${followedReply}/${yourTurnGames}</span>` : '');

  if(!matches.length){
    body.innerHTML = `<div class="games-list-empty">${mode==='line'
      ? 'None of your games followed exactly this line.'
      : 'None of your games reached this position.'}</div>`;
    return;
  }

  // newest first when we have dates; undated (bare) games sort to the end.
  matches.sort((a,b) => (b.game.createdAt||0) - (a.game.createdAt||0));
  const CAP = 200;
  const shown = matches.slice(0, CAP);

  body.innerHTML = shown.map(({ game, move }) => {
    const gc = userColorInGame(game);
    const oc = gameOutcomeForUser(game, gc);
    const date = game.createdAt ? new Date(game.createdAt).toLocaleDateString() : '—';
    const sideChip = gc === 'white' ? '<span class="games-col-side w" title="you played White">W</span>'
      : gc === 'black' ? '<span class="games-col-side b" title="you played Black">B</span>' : '<span class="games-col-side">·</span>';
    const oppColor = gc === 'white' ? 'black' : gc === 'black' ? 'white' : null;
    const opp = oppColor ? game.players?.[oppColor]?.user?.name : null;
    const oppRating = oppColor ? game.players?.[oppColor]?.rating : null;
    const oppHtml = opp ? `${escapeHtml(opp)}${oppRating?` <span class="grating">${oppRating}</span>`:''}`
      : (game.source === 'chesscom' || (!game.players) ? '<span class="grating">— no details —</span>' : '');
    const resTxt = oc==='win'?'1':oc==='loss'?'0':oc==='draw'?'½':'?';
    const resCls = oc || 'unk';
    const how = oc && game.status && GAME_STATUS_LABEL[game.status] ? `<span class="games-how">${GAME_STATUS_LABEL[game.status]}</span>` : '';
    const moveIsUsers = gc && gc[0] === sideToMove;
    const moveHtml = move
      ? `<span class="games-col-move">${moveIsUsers?'<span class="gyou">':''}${escapeHtml(move)}${moveIsUsers?'</span>':''}</span>`
      : '<span class="games-col-move">·</span>';
    const link = gameLink(game);
    return `<${link?`a class="games-row" href="${escapeHtml(link)}" target="_blank" rel="noopener"`:'div class="games-row no-link"'}>
      <span class="games-col-date">${date}</span>
      ${GAME_SOURCE_BADGE[gameSource(game)]}
      ${sideChip}
      <span class="games-col-opp">${oppHtml}</span>
      <span style="display:flex;align-items:center;gap:.4rem">${moveHtml}${how}</span>
      <span class="games-res ${resCls}">${resTxt}</span>
    </${link?'a':'div'}>`;
  }).join('') + (matches.length > CAP ? `<div class="games-list-more">showing ${CAP} of ${matches.length}</div>` : '');
}

/* ---------- FEN for a move sequence ---------- */
/* FEN for a move sequence, memoised and computed incrementally: a sequence's
   position is its parent's position with one more move applied, so we build on
   the cached parent FEN (one chess.js move) instead of replaying the whole line
   from move 1 every call. This is the hot path of the transposition graph /
   castle build, which asks for the same and adjacent positions thousands of
   times on a large repertoire. FENs depend only on the moves (never on PREFS or
   games), so the cache is valid for the life of the page across rebuilds.

   _FEN_BROKEN tracks sequences whose move failed to apply (corrupt data); once a
   move fails, every longer sequence resolves to the position *before* the bad
   move — identical to the old "break and return position-so-far" behaviour. */
const _FEN_CACHE = new Map();
const _FEN_BROKEN = new Set();
function fenForSeq(seq){
  const key = seq.join('\x1f');
  const cached = _FEN_CACHE.get(key);
  if(cached !== undefined) return cached;

  if(seq.length === 0){ const fen = new Chess().fen(); _FEN_CACHE.set(key, fen); return fen; }

  const parent = seq.slice(0, -1);
  const parentKey = parent.join('\x1f');
  const parentFen = fenForSeq(parent);

  // a broken ancestor "swallows" all further moves, exactly like the old loop's
  // break did — return the last good position unchanged.
  if(_FEN_BROKEN.has(parentKey)){ _FEN_BROKEN.add(key); _FEN_CACHE.set(key, parentFen); return parentFen; }

  const chess = new Chess(parentFen);
  const mv = seq[seq.length - 1];
  if(!chess.move(mv, {sloppy:true})){
    console.warn(`[fenForSeq] move ${seq.length}/${seq.length} "${mv}" failed to apply; ` +
      `returning position after move ${seq.length-1} instead. seq=${JSON.stringify(seq)} ` +
      `fen-before-failure=${parentFen}`);
    _FEN_BROKEN.add(key);
    _FEN_CACHE.set(key, parentFen);
    return parentFen;
  }
  const fen = chess.fen();
  _FEN_CACHE.set(key, fen);
  return fen;
}

/* ---------- transposition graph ----------
   Walks the currently open opening system the same way computeNodeStats does
   (same hidden-branch filtering, same manualReplies merge), but instead of
   counting nodes, builds a digraph keyed by position rather than by move
   sequence: each distinct (board, turn, castling, en-passant) reached along
   the way is one graph node, so two different move orders that transpose
   into the same position collapse into a single node with multiple
   incoming edges — exactly the merge a memory-castle "room" should map to. */
function positionKey(fen){
  return fen.split(' ').slice(0,4).join(' ');
}

/* Graph nodes are "rooms" (the position right after OUR move — same
   identity buildCastle uses), and graph edges are "exits" (the opponent's
   move out of a room). An opponent move with no configured Standard
   Response yet doesn't lead to a room: it dead-ends at a small red "?"
   leaf node, flagging that part of the tree as not yet built out. Leaf
   nodes are also merged by position so the same unbuilt opponent try
   reached via different transposing paths shows as one leaf. */
/* White moves are always numbered ("1. d4"), black moves never are — this
   matches standard notation and keeps the diagram uncluttered, regardless
   of which color is "ours" in this line. Ply 1 is White's first move. */
function plyLabel(seq){
  const ply = seq.length;
  const move = seq.at(-1);
  return ply%2===1 ? `${Math.ceil(ply/2)}. ${move}` : move;
}
/* the move-to-square memory-palace mnemonic word (set up in the Mnemonics
   screen) for the move that ends `seq` — looked up by destination square
   and piece type, same data used by the quiz. Disambiguation between two
   pieces of the same type that could reach the same square is ignored for
   now (rare in practice, e.g. doubled rooks/knights). */
const MNEM_WORD_FOR_PIECE = {p:'pawn',n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'};
function lastMoveInfo(seq){
  if(!seq || !seq.length) return null;
  // apply only the LAST move onto the (memoized, incremental) position after the
  // parent seq, instead of replaying the whole line from move 1 each call. This
  // is what the coverage walk calls per room/edge -- the old full replay made it
  // ~O(moves^2) over the tree and was the cause of the slow coverage load.
  const chess = new Chess(fenForSeq(seq.slice(0, -1)));
  const mv = chess.move(seq[seq.length - 1], { sloppy:true });
  // Castling mnemonic convention: the king "moves onto its rook", so key it by
  // the rook's square (Kh1/Ka1/Kh8/Ka8) rather than chess.js's g1/c1 king
  // landing square. chess.js flags: 'k' = kingside, 'q' = queenside.
  if(mv && (mv.flags.includes('k') || mv.flags.includes('q'))){
    mv.to = (mv.flags.includes('k') ? 'h' : 'a') + (mv.color === 'w' ? '1' : '8');
  }
  return mv;
}
function mnemonicWordForSeq(seq, mnemonicsBySquare){
  const info = lastMoveInfo(seq);
  if(!info) return '';
  return mnemonicsBySquare[info.to]?.[MNEM_WORD_FOR_PIECE[info.piece]] || '';
}
function mnemonicImgForSeq(seq, mnemonicsBySquare){
  const info = lastMoveInfo(seq);
  if(!info) return '';
  return mnemonicsBySquare[info.to]?.[MNEM_WORD_FOR_PIECE[info.piece]+'Img'] || '';
}

/* "age" of a piece on `square` for move disambiguation (Holden's rule): scan
   from the player's home corner filewise then rankwise -- the lower the age,
   the "younger" (closer to the back rank, then to the a-file) the piece.
   White measures from a1, black from a8. a=1..h=8. */
function pieceAge(square, color){
  const f = square.charCodeAt(0) - 96;   // 'a' -> 1
  const r = +square[1];
  return color === 'w' ? (r - 1) * 8 + f : (8 - r) * 8 + f;
}
/* number of disambiguator beards for the move that ends `seq`: when two or more
   same-type pieces could LEGALLY move to that square, the mover's 0-based age
   rank among them (youngest = 0 beards, next = 1, oldest = 2...). 0 when there's
   no ambiguity (or for castling). */
function moveDisambiguatorCount(seq){
  if(!seq || !seq.length) return 0;
  const parentFen = fenForSeq(seq.slice(0, -1));
  let mv;
  try { mv = new Chess(parentFen).move(seq[seq.length - 1], { sloppy:true }); } catch(_){ return 0; }
  if(!mv) return 0;
  if(mv.flags.includes('k') || mv.flags.includes('q')) return 0;   // castling is never ambiguous
  const candidates = new Chess(parentFen).moves({ verbose:true })
    .filter(m => m.to === mv.to && m.piece === mv.piece && m.color === mv.color);
  if(candidates.length < 2) return 0;
  const ages = candidates.map(m => pieceAge(m.from, mv.color)).sort((a, b) => a - b);
  return ages.indexOf(pieceAge(mv.from, mv.color));   // youngest -> 0, older -> more beards
}

/* leadIn (default true): when scoped to a rootSeq, also include the chain of
   ancestor rooms leading down to it (context for the network graph). Pass
   leadIn=false to begin exactly AT rootSeq with no ancestors — the castle
   generator wants the mansion to start at its own root room, not show the
   opening moves that lead into it as a corridor. */
function buildCastleGraph(line, games, rootSeq=null, leadIn=true, ownCastleName=null){
  const rooms = new Map();  // posKey -> {id, fen, label}
  const leaves = new Map(); // posKey -> {id, fen}
  const edges = [];
  let roomCounter = 0, leafCounter = 0;

  function getRoom(seq){
    const fen = fenForSeq(seq);
    const key = positionKey(fen);
    let r = rooms.get(key);
    if(!r){ r = {id:'room'+(roomCounter++), fen, label:plyLabel(seq), seq:seq.slice()}; rooms.set(key,r); }
    return r;
  }
  function getLeaf(seq){
    const fen = fenForSeq(seq);
    const key = positionKey(fen);
    let l = leaves.get(key);
    if(!l){ l = {id:'leaf'+(leafCounter++), fen}; leaves.set(key,l); }
    return l;
  }
  function addEdge(fromId,toId,exitSeq,destSeq,extra){
    edges.push({source:fromId,target:toId,label:plyLabel(exitSeq),fen:fenForSeq(exitSeq),seq:exitSeq.slice(),
                // the full move seq reaching the target room via THIS edge (ends
                // in our reply), so a door can show its own edge-specific move
                // pair even for a transposition target reached several ways.
                destSeq: destSeq ? destSeq.slice() : null,
                ...(extra||{})});
  }
  /* exitSeq ends in the opponent's move (one ply past `seq`, which ends in
     OUR move, or is the empty pre-game position at the very top of a black
     line); resolves to either an existing/new room, or a locked leaf. `count`
     is how many of our actual games saw this exact opponent reply out of
     `seq`, and `tot` that room's total recorded continuations -- carried onto
     the edge so a door/digraph label can show "how often has this actually
     been played against me" (0 = never, in real games). */
  function processExit(fromRoomId, seq, opp, count=0, tot=0){
    const exitSeq = [...seq,opp];
    const exitPref = PREFS[prefKey(line.id,exitSeq)];
    const reply = exitPref?.reply;
    if(!reply){
      const leaf = getLeaf(exitSeq);
      addEdge(fromRoomId,leaf.id,exitSeq,null,{count,tot});
      return;
    }
    const destSeq = [...exitSeq,reply];
    // a reply that starts ANOTHER castle's own root shouldn't be walked
    // inline into THIS castle's tree (that would rebuild it a second time
    // under this castle's own instance namespace, orphaning any objects/
    // names/stairs already configured against its canonical, own-front-door
    // instance). Redirect the edge to that castle's own room key instead --
    // computed the same way its own walk would compute it, so it's the exact
    // same key (a pure function of line.id + castle name + position), no
    // registry needed.
    const foreignName = ownCastleName && exitPref.isCastleRoot && exitPref.castleName?.trim();
    if(foreignName && foreignName !== ownCastleName){
      const foreignKey = castleRoomKey(castleInstanceId(line.id, foreignName), positionKey(fenForSeq(destSeq)));
      addEdge(fromRoomId, null, exitSeq, destSeq, { foreignCastle: foreignName, foreignKey, count, tot });
      return;
    }
    const destKey = positionKey(fenForSeq(destSeq));
    const alreadyExisted = rooms.has(destKey);
    const destRoom = getRoom(destSeq);
    addEdge(fromRoomId,destRoom.id,exitSeq,destSeq,{count,tot});
    if(!alreadyExisted) walk(destSeq,destRoom.id);
  }
  /* seq ends in OUR move; enumerate visible opponent replies and recurse */
  function walk(seq, roomId){
    const {counts, tot} = replies(games,seq);
    const manualReplies = PREFS[prefKey(line.id,seq)]?.manualReplies || [];
    manualReplies.forEach(m=>{ if(!(m in counts)) counts[m]=0; });
    const visibleOpps = Object.keys(counts).filter(opp=>
      !PREFS[prefKey(line.id,[...seq,opp])]?.hidden);
    for(const opp of visibleOpps) processExit(roomId,seq,opp,counts[opp],tot);
  }

  const entryRoomIds = [];
  if(rootSeq && !leadIn){
    /* generator mode: the mansion begins at its own root room. No ancestor
       chain, no start node — just this room and its subtree. */
    const room = getRoom(rootSeq);
    entryRoomIds.push(room.id);
    walk(rootSeq, room.id);
    return { rooms:[...rooms.values()], leaves:[...leaves.values()], edges, entryRoomIds, needsStartNode:false };
  }
  if(rootSeq){
    /* scoped to a focused room, but still show the chain of ancestor rooms
       (and the single move connecting each) leading down to it, so the
       focused branch's context is visible — just without the sibling
       branches that the whole-line view would otherwise include at each
       ancestor level. */
    const needsStartNode = line.color==='black';
    const step = 2;
    const start = needsStartNode ? 2 : 1;
    const chain = [];
    for(let l=start; l<=rootSeq.length; l+=step) chain.push(rootSeq.slice(0,l));

    let fromRoomId = needsStartNode ? 'start' : null;
    let fromSeq = [];
    let finalRoomId = null;
    chain.forEach((roomSeq,i)=>{
      const room = getRoom(roomSeq);
      if(i===0 && !needsStartNode){
        entryRoomIds.push(room.id);
      } else {
        const opp = roomSeq[fromSeq.length];
        const {counts: ancCounts, tot: ancTot} = replies(games, fromSeq);
        addEdge(fromRoomId, room.id, [...fromSeq,opp], null, {count: ancCounts[opp]||0, tot: ancTot});
        if(i===0) entryRoomIds.push(room.id);
      }
      fromRoomId = room.id;
      fromSeq = roomSeq;
      finalRoomId = room.id;
    });
    walk(rootSeq,finalRoomId);
    return { rooms:[...rooms.values()], leaves:[...leaves.values()], edges, entryRoomIds, needsStartNode };
  }

  const triggers = line.openingMoves || [];
  if(line.color==='black'){
    /* the opponent moves first, so the very first ply is itself an "exit"
       out of a virtual pre-game 'start' room rather than a room of ours */
    const {counts: rootCounts, tot: rootTot} = replies(games, []);
    for(const trigger of triggers){
      if(PREFS[prefKey(line.id,[trigger])]?.hidden) continue;
      processExit('start',[],trigger,rootCounts[trigger],rootTot);
    }
  } else {
    for(const trigger of triggers){
      const entryRoom = getRoom([trigger]);
      entryRoomIds.push(entryRoom.id);
      walk([trigger],entryRoom.id);
    }
  }

  if(line.color==='black'){
    edges.filter(e=>e.source==='start' && e.target.startsWith('room'))
      .forEach(e=>entryRoomIds.push(e.target));
  }

  return {
    rooms:[...rooms.values()], leaves:[...leaves.values()], edges,
    entryRoomIds, needsStartNode: line.color==='black'
  };
}

/* ---------- memory castle (stage 0: data model only, no rendering) ----------
   A "castle" is a subtree of the move tree, scoped to a single chosen row
   (rootSeq, which always ends in OUR move — same convention as childrenSeq
   throughout renderBranch/renderBlackRoot). A "room" is a distinct board
   position reached right after one of our moves, keyed by position (not by
   move sequence) so two move orders that transpose into the same position
   share one room — exactly the merge behaviour buildCastleGraph
   already gives us, reused here via positionKey/fenForSeq.

   An "exit" is one opponent reply option out of a room, keyed by the
   position right after that opponent move (before our reply). Exits are
   intentionally kept distinct from rooms: an exit's identity survives even
   if the standard response chosen for it changes later, so its eventual
   decoration (door/staircase/window/elevator/teleporter, added in a later
   stage) stays attached to "this specific opponent try" rather than to
   wherever it currently leads. An exit with no configured reply is "locked"
   (toRoomId stays null) — a dead end until the user picks a response. */
function buildCastle(line, games, rootSeq){
  const rooms = new Map(); // posKey -> room
  const exits = [];
  let roomCounter = 0, exitCounter = 0;

  function getRoom(seq, isEntry){
    const fen = fenForSeq(seq);
    const key = positionKey(fen);
    let room = rooms.get(key);
    if(!room){
      room = {
        id: 'room'+(roomCounter++), posKey: key, fen, seq: seq.slice(),
        mnemonic: PREFS[prefKey(line.id,seq)]?.mnemonic || '',
        isEntry: !!isEntry, transpositionCount: 0, exits: []
      };
      rooms.set(key, room);
    }
    return room;
  }

  function walk(seq, room){
    const {counts} = replies(games,seq);
    const manualReplies = PREFS[prefKey(line.id,seq)]?.manualReplies || [];
    manualReplies.forEach(m=>{ if(!(m in counts)) counts[m]=0; });
    const visibleOpps = Object.keys(counts).filter(opp=>
      !PREFS[prefKey(line.id,[...seq,opp])]?.hidden);

    for(const opp of visibleOpps){
      const exitSeq = [...seq,opp];
      const exitFen = fenForSeq(exitSeq);
      const reply = PREFS[prefKey(line.id,exitSeq)]?.reply;
      const exit = {
        id: 'exit'+(exitCounter++), posKey: positionKey(exitFen), fen: exitFen,
        oppMove: opp, fromRoomId: room.id, reply: reply||null,
        locked: !reply, toRoomId: null
      };
      room.exits.push(exit);
      exits.push(exit);
      if(!reply) continue;

      const destSeq = [...exitSeq,reply];
      const destKey = positionKey(fenForSeq(destSeq));
      const alreadyExisted = rooms.has(destKey);
      const destRoom = getRoom(destSeq,false);
      exit.toRoomId = destRoom.id;
      if(alreadyExisted) destRoom.transpositionCount++;
      else walk(destSeq, destRoom);
    }
  }

  const entryRoom = getRoom(rootSeq, true);
  walk(rootSeq, entryRoom);

  return {rootSeq, entryRoomId: entryRoom.id, rooms:[...rooms.values()], exits};
}

async function showCastleSummary(games, seq){
  if(!CURRENT_LINE) return;
  const spinner = showSpinner('Generating castle…');
  await nextPaint();
  let castle;
  try {
    castle = buildCastle(CURRENT_LINE, games, seq);
  } finally {
    hideSpinner(spinner);
  }
  const lockedExits = castle.exits.filter(e=>e.locked).length;
  const transpositionRooms = castle.rooms.filter(r=>r.transpositionCount>0).length;
  console.log('[castle]', castle);
  alert(
    `Castle preview (full data logged to console)\n\n` +
    `Rooms: ${castle.rooms.length}\n` +
    `Exits: ${castle.exits.length} (${lockedExits} locked)\n` +
    `Transposition rooms: ${transpositionRooms}`
  );
}

/* a room's name (and castle, if it's a castle root) lives on the opponent-move
   row that leads into it — keyed one ply back from the room's seq. `line`
   defaults to the open line but can be any line whose prefs are currently
   swapped in (see withLinePrefs), so castles from other systems build too. */
function genRoomMeta(seq, line = CURRENT_LINE){
  if(!seq || !seq.length || !line) return { name:'', castle:'' };
  const p = PREFS[prefKey(line.id, seq.slice(0,-1))];
  return { name: p?.name || '', castle: (p?.isCastleRoot && p.castleName) ? p.castleName : '' };
}

/* G1: turn a castle root's subtree into a room MODEL — corridors (linear runs),
   two-track rooms (head + left/right walls), and branch/standalone rooms — each
   with its contained moves and its exits (doors) to other rooms. Built on the
   shared analyzer so it matches the network graph exactly. Data-only; the VR
   rendering (G2) and decoration persistence (G3) come later. */
function buildGeneratedCastle(line, games, rootSeq, ownCastleName=null){
  // leadIn=false: start the mansion at its root room, not at the opening moves
  // that lead into it (those would otherwise show as a lead-in corridor).
  const graph = buildCastleGraph(line, games, rootSeq, false, ownCastleName);
  const a = analyzeCastleStructure(graph);
  const nodeById = new Map(graph.rooms.map(r=>[r.id, r]));
  const leafIds = new Set(graph.leaves.map(l=>l.id));
  const genIdOf = id => a.boxOf.get(id) || ('solo:' + id);

  const groups = new Map();   // genId -> { kind, members(ordered), head?, left?, right? }
  for(const box of a.boxes){
    if(box.kind === 'run'){
      groups.set(box.id, { kind:'corridor', members: box.nodes.slice() });
    } else {
      groups.set(box.id, { kind:'two-track', head: box.head,
        left: box.runs[0].slice(), right: box.runs[1].slice(),
        members: [box.head, ...box.runs[0], ...box.runs[1]] });
    }
  }
  for(const r of graph.rooms){
    if(a.boxOf.has(r.id)) continue;
    groups.set('solo:' + r.id, { kind: (a.outDeg.get(r.id)||0) >= 2 ? 'branch' : 'room', members: [r.id] });
  }

  // deterministic R1, R2, … numbering (entry room first)
  const order = [...groups.keys()].sort((x,y)=>{
    const ex = (graph.entryRoomIds||[]).some(id=>genIdOf(id)===x) ? 0 : 1;
    const ey = (graph.entryRoomIds||[]).some(id=>genIdOf(id)===y) ? 0 : 1;
    return ex - ey;
  });
  const labelOf = new Map(order.map((gid,i)=>[gid, 'R'+(i+1)]));
  const moveOf = id => nodeById.get(id)?.label || '?';
  // a STABLE identity per generated room, independent of R# numbering: the
  // position (positionKey) reached at the room's anchor. Used to key VR
  // decorations so they survive regeneration when the R# order shifts (G3).
  const anchorNode = gid => { const g = groups.get(gid); return nodeById.get(g.head || g.members[0]); };
  const posKeyByGid = new Map(order.map(gid => {
    const n = anchorNode(gid);
    return [gid, n && n.fen ? positionKey(n.fen) : ('R#' + labelOf.get(gid))];
  }));

  // a member room's move-pair for the VR billboards: the opponent move that led
  // in (the ply before) plus OUR reply (the room's own move). Both derived from
  // the room's seq via lastMoveInfo (which also remaps castling to the rook
  // square). Returns null when there's no preceding opponent ply (a ply-1 root).
  // `ply` is that move's ply counting from the true game start (1 = White's
  // first move, same convention as plyLabel) -- White's half of the pair gets
  // a moveNumber (Math.ceil(ply/2)) so the billboard can show "N." in its
  // corner; Black's half never does, matching standard notation.
  const CONV = (mv, ply) => {
    const out = { to: mv.to, piece: MNEM_WORD_FOR_PIECE[mv.piece] || 'pawn', san: mv.san };
    if(mv.color === 'w') out.moveNumber = Math.ceil(ply/2);
    return out;
  };
  const pairFor = (roomId, side, order) => {
    const node = nodeById.get(roomId);
    if(!node || !node.seq || node.seq.length < 2) return null;
    const resp = lastMoveInfo(node.seq);
    const opp = lastMoveInfo(node.seq.slice(0, -1));
    if(!resp || !opp) return null;
    const p = { side, order, opponent: CONV(opp, node.seq.length - 1), response: CONV(resp, node.seq.length) };
    const q = PREFS[prefKey(line.id, node.seq.slice(0, -1))]?.moveQuality;
    if(q) p.opponent.quality = q;
    const beards = moveDisambiguatorCount(node.seq);
    if(beards) p.response.disambig = beards;
    return p;
  };
  // the move pair for a specific EDGE, from the full seq reaching its target via
  // that edge (ends in our reply). Unlike pairFor (which reads a room's canonical
  // seq) this is edge-specific, so transposition doors into one room each show
  // their own last move. Returns { opponent, response } or null.
  const pairFromSeq = (seq) => {
    if(!seq || seq.length < 2) return null;
    const resp = lastMoveInfo(seq);
    const opp = lastMoveInfo(seq.slice(0, -1));
    if(!resp || !opp) return null;
    const p = { opponent: CONV(opp, seq.length - 1), response: CONV(resp, seq.length) };
    const q = PREFS[prefKey(line.id, seq.slice(0, -1))]?.moveQuality;
    if(q) p.opponent.quality = q;
    const beards = moveDisambiguatorCount(seq);
    if(beards) p.response.disambig = beards;
    return p;
  };

  const genRooms = order.map(gid => {
    const g = groups.get(gid);
    const anchor = nodeById.get(g.head || g.members[0]);
    const meta = genRoomMeta(anchor.seq, line);
    const memberSet = new Set(g.members);
    // for two-track rooms, tag each exit with the track (left/right) it leaves
    // from, so the VR can route its door into the matching lane of the half-wall.
    const leftSet = g.kind === 'two-track' ? new Set(g.left) : null;
    const rightSet = g.kind === 'two-track' ? new Set(g.right) : null;
    const trackOf = src => !leftSet ? undefined : (rightSet.has(src) ? 'right' : 'left');
    const exits = [];
    for(const e of graph.edges){
      if(!memberSet.has(e.source)) continue;
      const track = trackOf(e.source);
      // "N (M%)" -- how often this exact opponent reply has actually occurred
      // in the user's own games, out of this room's total recorded
      // continuations, so the VR door plaque / digraph edge can show it.
      const occurrence = formatOccurrence(e.count, e.tot);
      if(e.foreignKey){
        // this edge crosses into another castle's own room (see processExit's
        // redirect in buildCastleGraph) -- `to`/`toKey` stay null (nothing of
        // ours to point at); `foreignKey` is the real destination.
        exits.push({ opp: e.label, to: null, foreignCastle: e.foreignCastle, foreignKey: e.foreignKey,
                     pair: pairFromSeq(e.destSeq), track, occurrence });
        continue;
      }
      if(leafIds.has(e.target)){ exits.push({ opp: e.label, to: null, track, occurrence }); continue; }
      const tgt = genIdOf(e.target);
      if(tgt === gid) continue;   // internal link inside a corridor / two-track
      // `to` is the R# label (for the readable report); `toKey` is the stable
      // position identity the VR uses to wire doors + persist decorations.
      exits.push({ opp: e.label, to: labelOf.get(tgt) || null, toKey: posKeyByGid.get(tgt) || null,
                   // edge-specific move pair, shown beside this door in the VR walk
                   pair: pairFromSeq(e.destSeq), track, occurrence });
    }
    const walls = g.kind === 'two-track'
      ? { center: [moveOf(g.head)], left: g.left.map(moveOf), right: g.right.map(moveOf) }
      : { center: g.members.map(moveOf) };
    // move-pair billboards: the room's anchor move-pair (the head, or the first
    // member) sits front-and-center, the first thing you see on entering. The
    // rest file down the walls — two-track splits left (west) / right (east);
    // every other room files its remaining members down the west wall.
    const pairs = [];
    if(g.kind === 'two-track'){
      const hp = pairFor(g.head, 'center', 1); if(hp) pairs.push(hp);
      let lo = 1;
      for(const id of g.left){ const p = pairFor(id, 'left', lo); if(p){ pairs.push(p); lo++; } }
      let ro = 1;
      for(const id of g.right){ const p = pairFor(id, 'right', ro); if(p){ pairs.push(p); ro++; } }
    } else {
      const ap = pairFor(g.members[0], 'center', 1); if(ap) pairs.push(ap);
      let o = 1;
      for(let m = 1; m < g.members.length; m++){ const p = pairFor(g.members[m], 'left', o); if(p){ pairs.push(p); o++; } }
    }
    // the pref that stores this room's name lives one ply back from the anchor's
    // seq (see genRoomMeta) -- carried through so a VR rename can write the same
    // idb item the Attributes → Room Name field edits.
    const nameSeq = anchor.seq && anchor.seq.length ? anchor.seq.slice(0, -1) : null;
    // total individual "opponent played X, I respond Y" facts this room
    // represents -- every member's own out-degree, summed, not just the
    // doors that happen to cross into a different room. A corridor step is
    // still a move you have to know even though it doesn't leave the room.
    const moveCount = g.members.reduce((sum, id) => sum + (a.outDeg.get(id) || 0), 0);
    return { id: labelOf.get(gid), posKey: posKeyByGid.get(gid), type: g.kind, name: meta.name, castle: meta.castle,
             nameSeq, memberCount: g.members.length, moveCount, walls, exits, pairs };
  });

  return { genRooms, stats: a, graph };
}

/* ---------- generate-castle options modal ----------
   A pre-step before generating: assign/confirm the castle's street number
   (auto-filled when unset) and optionally wipe its prior VR decorations. */
let PENDING_CASTLE_GEN = null;
// VR room-key conventions — must match threeVR.js's registerOneCastle keyOf():
// 'cas:<instanceId>:<posKey>' with non-alphanumerics sanitized to '_'. The
// instance id namespaces a castle by line + castle name so two castles that
// transpose into the same position keep separate rooms/decorations.
const sanitizeKeyPart = s => String(s || '').replace(/[^a-zA-Z0-9]/g, '_');
const castleInstanceId = (lineId, castleName) =>
  castleName ? `${sanitizeKeyPart(lineId)}_${sanitizeKeyPart(castleName)}` : 'preview';
const castleRoomKey = (instanceId, posKey) => `cas:${instanceId}:${sanitizeKeyPart(posKey)}`;
// Map every VR room key to the pref that stores its name, so a rename done in
// the VR walk edits the SAME idb item as the node's Attributes → Room Name.
// castleList entries: { lineId, instanceId, genRooms }.
function buildRoomNameIndex(castleList){
  const index = {};
  for(const c of castleList || []){
    for(const r of (c && c.genRooms) || []){
      if(!r.nameSeq) continue;
      index[castleRoomKey(c.instanceId, r.posKey)] = { lineId: c.lineId, nameSeq: r.nameSeq };
    }
  }
  return index;
}
// A callback handed to the VR walk: persist a room rename onto its shared pref
// and keep the open line's in-memory PREFS in sync so the tree/Attributes
// modal reflect it live.
function makeRoomRenamer(index){
  return async (roomKey, name) => {
    const t = index[roomKey];
    if(!t || !t.nameSeq) return;
    invalidateBuiltCastlesCache();   // renamed rooms feed VR room labels
    await setPref(t.lineId, t.nameSeq, { name });
    if(CURRENT_LINE && t.lineId === CURRENT_LINE.id){
      const k = prefKey(t.lineId, t.nameSeq);
      (PREFS[k] ??= { key:k, lineId:t.lineId, seq:t.nameSeq, reply:'', note:'', mnemonic:'', hidden:false }).name = name;
    }
  };
}
function openCastleGenModal(games, seq){
  PENDING_CASTLE_GEN = { games, seq };
  $('castleGenWipe').checked = false;
  $('castleGenError').textContent = '';
  // street-number step: only when this node is a defined castle root (the flag
  // lives on the opponent-move pref one ply back from the room seq)
  const rootPref = (seq && seq.length >= 2) ? PREFS[prefKey(CURRENT_LINE.id, seq.slice(0,-1))] : null;
  const isRoot = !!(rootPref?.isCastleRoot && rootPref.castleName?.trim());
  PENDING_CASTLE_GEN.rootPref = isRoot ? rootPref : null;
  $('castleGenStreetField').style.display = isRoot ? '' : 'none';
  if(isRoot){
    const saved = parseInt(rootPref.castleStreetNumber, 10);
    $('castleGenStreetNumber').value = (Number.isFinite(saved) && saved >= 1)
      ? saved
      : nextStreetNumber(rootPref.castleName);
  }
  $('castleGenOverlay').style.display = 'flex';
}
// delete the persisted VR layout (object placements + surfaces) for every room of
// this castle, so a regenerate starts from a clean slate. Rooms are keyed by
// instance + position (G3); legacy un-namespaced keys are cleared too.
async function wipeCastleDecorations(games, seq){
  const ownCastleName = genRoomMeta(seq, CURRENT_LINE).castle;
  const castle = buildGeneratedCastle(CURRENT_LINE, games, seq, ownCastleName);
  const inst = castleInstanceId(CURRENT_LINE.id, castle.genRooms[0]?.castle || '');
  const raw = await getMeta('threeLayout');
  if(!raw) return 0;
  let layout;
  try { layout = JSON.parse(raw); } catch { return 0; }
  let removed = 0;
  for(const r of castle.genRooms){
    for(const k of [castleRoomKey(inst, r.posKey), 'cas:' + sanitizeKeyPart(r.posKey)]){
      if(k in layout){ delete layout[k]; removed++; }
    }
  }
  await setMeta('threeLayout', JSON.stringify(layout));
  return removed;
}
$('castleGenCancelBtn').onclick = () => { $('castleGenOverlay').style.display = 'none'; PENDING_CASTLE_GEN = null; };
$('castleGenGoBtn').onclick = async () => {
  const ctx = PENDING_CASTLE_GEN;
  if(!ctx){ $('castleGenOverlay').style.display = 'none'; return; }
  // street number: required for a castle root; must be unique among the other
  // castles in this opening system (validation errors keep the modal open)
  if(ctx.rootPref){
    const num = parseInt($('castleGenStreetNumber').value, 10);
    if(!Number.isFinite(num) || num < 1){
      $('castleGenError').textContent = 'Street number must be a positive whole number.';
      return;
    }
    const clash = streetNumberConflict(num, ctx.rootPref.castleName);
    if(clash){
      $('castleGenError').textContent = `Street number ${num} is already used by "${clash}" in this opening system.`;
      return;
    }
    if(parseInt(ctx.rootPref.castleStreetNumber, 10) !== num){
      invalidateBuiltCastlesCache();   // street position feeds street layout
      await savePrefField(ctx.seq.slice(0,-1), 'castleStreetNumber', num);
    }
  }
  $('castleGenOverlay').style.display = 'none';
  PENDING_CASTLE_GEN = null;
  if($('castleGenWipe').checked){
    const n = await wipeCastleDecorations(ctx.games, ctx.seq);
    log(`wiped VR decorations for ${n} room(s)`);
  }
  showGeneratedCastleReport(ctx.games, ctx.seq);
};

let LAST_GENERATED_CASTLE = null;   // stashed so "Walk in VR" can hand it to the VR engine
async function showGeneratedCastleReport(games, seq){
  if(!CURRENT_LINE) return;
  const spinner = showSpinner('Previewing castle…');
  await nextPaint();
  let castle;
  const ownCastleName = genRoomMeta(seq, CURRENT_LINE).castle;
  try { castle = buildGeneratedCastle(CURRENT_LINE, games, seq, ownCastleName); }
  finally { hideSpinner(spinner); }
  LAST_GENERATED_CASTLE = castle;
  console.log('[generated castle]', castle);

  const s = castle.stats;
  const typeCounts = {};
  castle.genRooms.forEach(r => typeCounts[r.type] = (typeCounts[r.type]||0)+1);
  $('castleReportSummary').textContent =
    `${castle.genRooms.length} rooms (` +
    Object.entries(typeCounts).map(([t,n])=>`${n} ${t}`).join(', ') + ') · ' +
    `graph: ${s.runs.length} run(s), ${s.twoTrackCount} two-track pair(s), ${s.mergeCount} transposition merge(s)`;

  $('castleReportBody').innerHTML = castle.genRooms.map(r => {
    const title = `<span class="cr-id">${r.id}</span> <span class="cr-type cr-type-${r.type}">${r.type}</span>` +
      (r.castle ? ` <span class="cr-castle">⟨${escapeHtml(r.castle)}⟩</span>` : '') +
      (r.name ? ` <span class="cr-name">${escapeHtml(r.name)}</span>` : '');
    const walls = r.type === 'two-track'
      ? `<div class="cr-wall"><b>center</b> ${escapeHtml(r.walls.center.join(' '))}</div>` +
        `<div class="cr-wall"><b>left</b> ${escapeHtml(r.walls.left.join(' · '))}</div>` +
        `<div class="cr-wall"><b>right</b> ${escapeHtml(r.walls.right.join(' · '))}</div>`
      : `<div class="cr-wall"><b>moves</b> ${escapeHtml(r.walls.center.join(' · '))}</div>`;
    const exits = r.exits.length
      ? `<div class="cr-exits"><b>exits</b> ${r.exits.map(x=>
          `${escapeHtml(x.opp)} → ${x.foreignCastle ? `⟨${escapeHtml(x.foreignCastle)}⟩` : (x.to || '(unbuilt)')}`
        ).join(' · ')}</div>`
      : `<div class="cr-exits cr-empty">terminal (no exits)</div>`;
    return `<div class="cr-room">${title}${walls}${exits}</div>`;
  }).join('');
  $('castleReportOverlay').style.display = 'flex';
}

/* ---------- shared castle-structure analysis ----------
   Given a buildCastleGraph result, detect linear runs and two-track rooms and
   assign every room node to a box (or leave it standalone). Used by both the
   network graph (boxing + collapsed-room stats) and the castle generator (G1),
   so the two always agree. See LinearSequencesAndRoomObjects.md. */
function analyzeCastleStructure(graph){
  const { rooms, edges } = graph;
  const indegree = new Map();
  edges.forEach(e=>indegree.set(e.target,(indegree.get(e.target)||0)+1));
  const mergeCount = [...indegree.values()].filter(c=>c>1).length;
  const roomIds = new Set(rooms.map(r=>r.id));
  const outDeg = new Map();
  edges.forEach(e=>outDeg.set(e.source,(outDeg.get(e.source)||0)+1));
  const outTargets = new Map();
  edges.forEach(e=>{ if(!outTargets.has(e.source)) outTargets.set(e.source, []); outTargets.get(e.source).push(e.target); });

  // forced-chain edges -> linear runs
  const chainNext = new Map(), chainTarget = new Set();
  for(const e of edges){
    if(!roomIds.has(e.source) || !roomIds.has(e.target)) continue;
    if(outDeg.get(e.source) !== 1) continue;
    if((indegree.get(e.target)||0) !== 1) continue;
    chainNext.set(e.source, e.target);
    chainTarget.add(e.target);
  }
  const runs = [];
  for(const head of chainNext.keys()){
    if(chainTarget.has(head)) continue;
    const run = [], seen = new Set(); let cur = head;
    while(cur !== undefined && !seen.has(cur)){ seen.add(cur); run.push(cur); cur = chainNext.get(cur); }
    if(run.length >= 2) runs.push(run);
  }
  const nodesInRuns = runs.reduce((a,r)=>a+r.length, 0);

  // two-track rooms: a node with exactly two children, each a non-merge run head
  const runByHead = new Map();
  runs.forEach(run => runByHead.set(run[0], run));
  // run-head -> its index in `runs`, so consuming a matched run below is a
  // lookup instead of an indexOf scan (runs.indexOf was O(runs.length) per
  // hit, making this loop O(rooms * runs) on a castle with many two-tracks).
  const runIndexByHead = new Map(runs.map((run, i) => [run[0], i]));
  const boxOf = new Map(), boxes = [], consumed = new Set();
  let twoTrackCount = 0;
  rooms.forEach(H => {
    if(outDeg.get(H.id) !== 2) return;
    const [t1, t2] = outTargets.get(H.id) || [];
    if(!runByHead.has(t1) || !runByHead.has(t2) || t1 === t2) return;
    if((indegree.get(t1)||0) !== 1 || (indegree.get(t2)||0) !== 1) return;
    const runA = runByHead.get(t1), runB = runByHead.get(t2);
    const bid = `tt${twoTrackCount++}`;
    boxes.push({ id: bid, kind: 'two-track', head: H.id, runs: [runA.slice(), runB.slice()],
      label: `2-track ×${1 + runA.length + runB.length}` });
    boxOf.set(H.id, bid);
    runA.forEach(id=>boxOf.set(id, bid));
    runB.forEach(id=>boxOf.set(id, bid));
    consumed.add(runIndexByHead.get(t1));
    consumed.add(runIndexByHead.get(t2));
  });
  runs.forEach((run, i) => {
    if(consumed.has(i)) return;
    const trimmed = run.filter(id => !boxOf.has(id));   // drop a tail that became a two-track head
    if(trimmed.length < 2) return;
    const bid = `run${i}`;
    boxes.push({ id: bid, kind: 'run', nodes: trimmed, label: `linear ×${trimmed.length}` });
    trimmed.forEach(id=>boxOf.set(id, bid));
  });

  return { indegree, outDeg, outTargets, runs, boxes, boxOf,
           mergeCount, nodesInRuns, twoTrackCount };
}

// Find the cycle-closing "back edges" in the position-merged graph. Draw-by-
// repetition variations produce real cycles (a position repeats), which dagre
// cannot lay out -- it throws "Cannot set 'order' of undefined" from inside its
// async scheduler, where a try/catch around .run() can't catch it. Removing a
// DFS's back edges always yields a DAG, so we exclude exactly those edges from
// the layout (drawing them dashed instead) and keep dagre's clean tree shape.
// Returns a Set of indices into the `edges` array.
function findBackEdges(rooms, edges){
  const adj = new Map(), nodes = new Set();
  rooms.forEach(r => nodes.add(r.id));
  edges.forEach((e, idx) => {
    nodes.add(e.source); nodes.add(e.target);
    if(!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source).push({to:e.target, idx});
  });
  const state = new Map();      // 0/undef=unvisited, 1=on-stack, 2=done
  const back = new Set();
  for(const start of nodes){
    if(state.get(start)) continue;
    const stack = [{node:start, i:0}];
    state.set(start, 1);
    while(stack.length){
      const top = stack[stack.length-1];
      const kids = adj.get(top.node) || [];
      if(top.i < kids.length){
        const {to, idx} = kids[top.i++];
        const s = state.get(to) || 0;
        if(s === 1) back.add(idx);          // edge into a node still on the stack -> closes a cycle
        else if(s === 0){ state.set(to, 1); stack.push({node:to, i:0}); }
      } else {
        state.set(top.node, 2);
        stack.pop();
      }
    }
  }
  return back;
}

// graph-local focus seq (set by right-click "Focus on this variation" inside the
// graph overlay); overrides the move-table FOCUSED_SEQ while the overlay is open.
let GRAPH_FOCUS_SEQ = null;
// whether the coverage-bars panel (#graphCoverage) is expanded -- reset to
// collapsed on each fresh open (graphCloseBtn), same as GRAPH_FOCUS_SEQ, but
// persists across in-place refreshes (Show Castle, Reset Layout, focus/clear
// focus) so toggling it open doesn't get clobbered by those.
let GRAPH_COVERAGE_OPEN = false;

/* ---------- graph node layout persistence ----------
   dagre reflows the whole graph fresh on every open, which is great for a new
   tree but throws away any manual de-overlap dragging. We save each dragged
   node's deviation from dagre's own placement (a DELTA, not an absolute
   coordinate) keyed by the node's own position -- not cytoscape's per-render
   node id, which is just a reassigned counter -- so a saved nudge survives
   both a tree edit elsewhere and reopening the same scope later. The delta
   design means a node whose neighborhood shifts a little still lands near
   where dagre naturally wants it, nudged the same relative amount, rather
   than being pinned to a stale absolute spot.
   Scoped per (line, focus root) since "whole tree" and "focused on the
   Chigorin" are different layouts with different node sets. Stored as one
   JSON blob (same convention as threeLayout/objectLists):
   { "<lineId>|<scopeKey>": { "<positionKey>": {dx, dy} } }. */
let GRAPH_LAYOUT = {};
async function loadGraphLayout(){
  try { GRAPH_LAYOUT = JSON.parse(await getMeta('graphLayout') || '{}'); }
  catch { GRAPH_LAYOUT = {}; }
}
// returns the write's promise (unlike threeVR.js's fire-and-forget
// persistLayout) because Reset Layout immediately triggers a reload that
// reads this same key back -- without awaiting, that reload can race the
// write and reload the stale pre-reset value.
function persistGraphLayout(){ return setMeta('graphLayout', JSON.stringify(GRAPH_LAYOUT)); }
// "memorized" room progress (see js/threeVR.js's own MEMORIZED, which this
// mirrors) -- read here too so the graph can badge memorized branches.
// Deliberately a small independent read rather than a shared module: this is
// the same pattern threeLayout itself already uses (read directly, with no
// shared helper, from both threeVR.js and app.js).
let MEMORIZED_ROOMS = {};
async function loadMemorizedRooms(){
  try { MEMORIZED_ROOMS = JSON.parse(await getMeta('threeMemorizedRooms') || '{}'); }
  catch { MEMORIZED_ROOMS = {}; }
}
// "fully decorated" room progress (see js/threeVR.js's own DECORATED, which
// this mirrors) -- same independent-read pattern as MEMORIZED_ROOMS above.
let DECORATED_ROOMS = {};
async function loadDecoratedRooms(){
  try { DECORATED_ROOMS = JSON.parse(await getMeta('threeDecoratedRooms') || '{}'); }
  catch { DECORATED_ROOMS = {}; }
}
function graphScopeKey(line, rootSeq){
  return line.id + '|' + (rootSeq && rootSeq.length ? positionKey(fenForSeq(rootSeq)) : '__all__');
}
// records (or clears, if the drag ended up negligibly close to dagre's own
// spot) one node's deviation from its dagre-computed base position.
function saveGraphNodeDelta(scopeKey, posKey, dx, dy){
  const scope = (GRAPH_LAYOUT[scopeKey] ??= {});
  if(Math.abs(dx) < 1 && Math.abs(dy) < 1) delete scope[posKey];
  else scope[posKey] = { dx: Math.round(dx), dy: Math.round(dy) };
  if(!Object.keys(scope).length) delete GRAPH_LAYOUT[scopeKey];
  persistGraphLayout();
}

async function showTranspositionGraph(){
  if(!CURRENT_LINE || !GAMES){ return; }
  $('graphOverlay').style.display='flex';
  $('graphContainer').innerHTML='';

  const spinner = showSpinner('Building graph…');
  await nextPaint();
  try {
    const rootSeq = GRAPH_FOCUS_SEQ || FOCUSED_SEQ;   // graph-local focus (right-click) overrides the move-table focus
    await loadGraphLayout();
    await loadMemorizedRooms();
    await loadDecoratedRooms();
    const scopeKey = graphScopeKey(CURRENT_LINE, rootSeq);
    const graph = buildCastleGraph(CURRENT_LINE, gamesForLineColor(GAMES, CURRENT_LINE.color), rootSeq);
    const {rooms, leaves, edges, entryRoomIds, needsStartNode} = graph;
    const { indegree, runs, boxes, boxOf, mergeCount, nodesInRuns, twoTrackCount }
      = analyzeCastleStructure(graph);

    // a room's VR key, for the node-label glyphs further down -- r.seq always
    // ends in OUR move, same convention threeVR.js's own MEMORIZED/DECORATED
    // maps key against.
    const roomKeyForRoom = r => {
      const ownCastle = inheritedCastle(r.seq);
      return ownCastle ? castleRoomKey(castleInstanceId(CURRENT_LINE.id, ownCastle), positionKey(r.fen)) : null;
    };

    // "castle rooms": the real VR room count, distinct from `rooms.length`
    // below (raw chess positions) -- a corridor or two-track room collapses
    // several positions into one physical room, so this is computed exactly
    // the way "Generate Castle" itself would (buildGeneratedCastle, built on
    // this same analyzer), per castle in the current scope -- one castle if
    // focused, every castle in the system otherwise -- and summed. A castle
    // marked but with no root reply chosen yet contributes 0 (nothing to
    // generate). Memorized/decorated/moves-memorized are counted against
    // these real rooms too, each keyed by its own anchor position (same as
    // threeVR.js's MEMORIZED_ROOMS/DECORATED_ROOMS) -- a corridor's non-anchor
    // positions aren't separately memorizable; they're part of whichever real
    // room they got collapsed into. "Moves memorized" counts every individual
    // "opponent played X, I respond Y" fact folded into a memorized room
    // (genRoom.moveCount -- every member's own out-degree, summed), not just
    // the doors that happen to cross into a different room: a step along a
    // linear-run hallway is still a move you have to know, even though
    // walking it doesn't cross a room boundary.
    const focusedName = focusedCastleName();
    const castleNames = focusedName ? [focusedName] : definedCastles();
    let totalCastleRooms = 0, totalCastleMoves = 0;
    let memorizedRoomCount = 0, decoratedRoomCount = 0, memorizedMoveCount = 0;
    for(const name of castleNames){
      const castleRootSeq = castleRootRoomSeq(name);
      if(!castleRootSeq) continue;
      const { genRooms } = buildGeneratedCastle(CURRENT_LINE, gamesForLineColor(GAMES, CURRENT_LINE.color), castleRootSeq, name);
      totalCastleRooms += genRooms.length;
      const instanceId = castleInstanceId(CURRENT_LINE.id, name);
      for(const gr of genRooms){
        totalCastleMoves += gr.moveCount;
        const roomKey = castleRoomKey(instanceId, gr.posKey);
        if(MEMORIZED_ROOMS[roomKey]){ memorizedRoomCount++; memorizedMoveCount += gr.moveCount; }
        if(DECORATED_ROOMS[roomKey]) decoratedRoomCount++;
      }
    }
    const pct = (n, d) => d ? Math.round(n / d * 100) : 0;

    $('graphStatus').textContent =
      (GRAPH_FOCUS_SEQ ? '🎯 focused (right-click → Clear focus) · ' : '') +
      `${totalCastleRooms} castle room(s) · ${rooms.length} position(s), ${edges.length} move(s), ${leaves.length} not yet built, ${mergeCount} transposition merge point(s)` +
      (runs.length ? ` · ${runs.length} linear run(s) covering ${nodesInRuns} node(s)` +
        (twoTrackCount ? `, ${twoTrackCount} two-track pair${twoTrackCount===1?'':'s'}` : '') : '');

    // coverage: one labeled, proportionally-filled bar per stat, on its own
    // line below the structural summary above -- clearer at a glance than
    // burying "N/M (P%)" fragments in a run-on sentence. The toggle button
    // AND the panel are hidden entirely when there's nothing to show (no
    // castles built yet in this scope); otherwise shown/hidden per
    // GRAPH_COVERAGE_OPEN (see updateGraphCoverageVisibility).
    const coverageBar = (label, color, n, d) => `
      <div class="graph-coverage-row">
        <span class="graph-coverage-label">${label}:</span>
        <span class="graph-coverage-value">${n}/${d} (${pct(n,d)}%)</span>
        <span class="graph-coverage-bar"><span class="graph-coverage-fill" style="width:${pct(n,d)}%;background:${color}"></span></span>
      </div>`;
    $('graphCoverage').innerHTML = !totalCastleRooms ? '' :
      coverageBar('Rooms memorized', '#1565c0', memorizedRoomCount, totalCastleRooms) +
      coverageBar('Moves memorized', '#2e7d32', memorizedMoveCount, totalCastleMoves) +
      coverageBar('Rooms decorated', '#4527a0', decoratedRoomCount, totalCastleRooms);
    $('graphCoverageToggle').style.display = totalCastleRooms ? '' : 'none';
    updateGraphCoverageVisibility();

    populateGraphCastleSelect();

    // a room's user-assigned name lives on the opponent-move row that leads into
    // it (room.seq ends in OUR reply, so the name is keyed one ply back);
    // truncate to 12 chars, which is almost always still unique. When the room
    // is a castle root, prefix its castle name → "CastleName: RoomName".
    const trunc12 = s => { const t = (s||'').trim(); return t.length > 12 ? t.slice(0,12) + '…' : t; };
    const graphNodeName = seq => {
      const meta = genRoomMeta(seq);            // {name, castle} keyed one ply back
      const nm = trunc12(meta.name), cn = trunc12(meta.castle);
      return cn ? (nm ? `${cn}: ${nm}` : cn) : nm;
    };
    // move label + how often this exact reply has occurred in the user's own
    // games (second line, same "N (M%)" stat the VR door plaque and the move
    // table's .cnt span show) -- helps prioritize which branches to memorize.
    const edgeLabel = e => `${e.label}\n${formatOccurrence(e.count, e.tot)}`;

    // dagre's compound-nesting layout intermittently throws "Cannot set 'order'
    // of undefined" on the run/two-track BOXES -- it's triggered by certain box
    // shapes (e.g. a short run-box with edges crossing its boundary to a start
    // node / dead-end leaf), not by cycles or disconnection as first suspected
    // (a fully connected, acyclic focused line crashes too). The only reliable
    // cure is to never hand dagre a compound graph: we ALWAYS lay out FLAT -- a
    // plain DAG, no boxes -- then re-wrap the boxes afterward with pure cytoscape
    // reparenting (no dagre involved, so it cannot crash).
    const backEdges = findBackEdges(rooms, edges);
    const cyclic = backEdges.size > 0;
    const flat = true;   // always flat -- see comment above

    console.log(`[graph] nodes=${rooms.length+leaves.length+(needsStartNode?1:0)} edges=${edges.length} boxes=${boxes.length} cyclic=${cyclic} → flat layout, boxes re-wrapped after`);

    // which rooms have a real forward continuation -- an edge to another ROOM
    // (built reply, incl. a transposition/back edge) or into another castle
    // (foreignKey). A room with NONE is a VR dead-end: in the walk its
    // doorway is a locked door you can't walk through (see threeVR.js's
    // isRoomEmpty). Used to hide "Jump to VR" for such rooms -- landing inside
    // a room you can only otherwise reach through a locked door is confusing
    // (the castle ROOT is exempt: it's empty until built out, but you reach it
    // from the street, never through a locked door).
    const roomsWithForwardExit = new Set(
      edges.filter(e => e.foreignKey || (typeof e.target === 'string' && e.target.startsWith('room')))
           .map(e => e.source)
    );
    // the roomKey of a castle's own entry room -- reached from the street (a
    // back door), so it's exempt from the locked-dead-end rule even when it's
    // empty (a freshly-rooted, not-yet-built-out castle). Memoized per castle.
    const _castleEntryKey = new Map();
    const castleEntryRoomKey = name => {
      if(_castleEntryKey.has(name)) return _castleEntryKey.get(name);
      const rootSeq = castleRootRoomSeq(name);
      const key = rootSeq ? castleRoomKey(castleInstanceId(CURRENT_LINE.id, name), positionKey(fenForSeq(rootSeq))) : null;
      _castleEntryKey.set(name, key);
      return key;
    };
    // a box member's position within its own box -- 'track' (two-track only:
    // head/left/right) + 'chainIdx' (order along its own run/track, 0-based)
    // -- carried on the room's own node data so a later right-click ("Arrange")
    // can recompute a clean layout for just that box purely from its current
    // children, with no need to keep `boxes`/`boxOf` alive past this render.
    const boxById = new Map(boxes.map(b => [b.id, b]));
    const boxMemberInfo = r => {
      const boxId = boxOf.get(r.id);
      if(!boxId) return null;
      const box = boxById.get(boxId);
      if(box.kind === 'run') return { chainIdx: box.nodes.indexOf(r.id) };
      if(r.id === box.head) return { track: 'head', chainIdx: 0 };
      const li = box.runs[0].indexOf(r.id);
      if(li >= 0) return { track: 'left', chainIdx: li };
      return { track: 'right', chainIdx: box.runs[1].indexOf(r.id) };
    };

    const elements = [
      ...(needsStartNode ? [{data:{id:'start', label:''}, classes:'start'}] : []),
      // box compound parents are NEVER given to dagre (they crash it); they are
      // added AFTER layout and children reparented into them (see flat re-wrap).
      ...(flat ? [] : boxes.map(b=>({ data:{id:b.id, label:b.label}, classes: b.kind === 'two-track' ? 'twotrack-box' : 'run-box' }))),
      ...rooms.map(r=>{
        const name = graphNodeName(r.seq);
        const roomKey = roomKeyForRoom(r);
        const ownCastle = inheritedCastle(r.seq);   // needed below for the locked-dead-end / castle-entry check
        const q = moveQualityFor(r.seq);                 // annotate the arriving (opponent) move
        const memorized = roomKey ? !!MEMORIZED_ROOMS[roomKey] : false;
        const decorated = roomKey ? !!DECORATED_ROOMS[roomKey] : false;
        // 🧠 (memorized) / 🎨 (decorated) glyphs read at normal zoom; the
        // "all done" border (below) is the zoomed-out signal, so both glyphs
        // still show even when it's also on.
        const moveLabel = r.label + (q ? ' ' + q : '') + (memorized ? ' 🧠' : '') + (decorated ? ' 🎨' : '');
        const data = {id:r.id, label: name ? `${moveLabel}\n${name}` : moveLabel, fen:r.fen, seq:r.seq};
        if(!flat && boxOf.has(r.id)) data.parent = boxOf.get(r.id);   // box this room into its run / two-track room
        Object.assign(data, boxMemberInfo(r));   // track/chainIdx for "Arrange" (no-op if not boxed)
        data.roomKey = roomKey;   // exposed for the test hook / room-info panel use
        // a VR dead-end reached through a locked door -- empty (no forward
        // continuation) and not its castle's own entry room (that one is
        // reached from the street, not a locked door). "Jump to VR" is hidden
        // for these, since landing inside a room you could otherwise only
        // reach through a locked door is confusing.
        const isCastleEntry = !!(roomKey && ownCastle && roomKey === castleEntryRoomKey(ownCastle));
        data.lockedDeadEnd = !isCastleEntry && !roomsWithForwardExit.has(r.id);
        const baseClass = entryRoomIds.includes(r.id) ? 'root' : (indegree.get(r.id)>1 ? 'transposition' : '');
        // thick green border: reserved for "all done" (both memorized AND
        // decorated) so it reads at a glance even zoomed out too far to make
        // out the glyphs -- memorized/decorated alone show only their glyph.
        return {
          data,
          classes: [baseClass, (memorized && decorated) ? 'all-done' : ''].filter(Boolean).join(' ')
        };
      }),
      ...leaves.map(l=>({ data:{id:l.id, label:'?', fen:l.fen}, classes:'locked' })),
      // NON-cycle edges only -- the cycle (back) edges are deliberately kept OUT
      // of the graph during layout and added back afterward (see below).
      ...edges.flatMap((e,i)=> backEdges.has(i) ? [] : [{
        data:{id:'e'+i, source:e.source, target:e.target, label:edgeLabel(e), fen:e.fen, seq:e.seq}
      }])
    ];
    // The dashed repetition edges, added to the graph only AFTER dagre has run.
    const deferredEdgeEls = edges.flatMap((e,i)=> backEdges.has(i) ? [{
      data:{id:'e'+i, source:e.source, target:e.target, label:edgeLabel(e), fen:e.fen, seq:e.seq},
      classes:'cycle-edge'
    }] : []);

    const cy = cytoscape({
      container: $('graphContainer'),
      elements,
      style: [
        { selector:'node', style:{
          'shape':'round-rectangle', 'width':'label', 'height':'label', 'padding':'6px',
          'background-color':'#1565c0', 'border-width':0,
          'label':'data(label)', 'color':'#fff', 'font-size':9, 'text-valign':'center',
          'text-halign':'center', 'text-wrap':'wrap', 'text-justification':'center'
        }},
        { selector:'node.start', style:{
          'shape':'ellipse', 'width':10, 'height':10, 'padding':0, 'background-color':'#555'
        }},
        { selector:'node.root', style:{ 'background-color':'#2e7d32' } },
        { selector:'node.transposition', style:{ 'background-color':'#e65100' } },
        // "all done" (memorized AND fully decorated -- see the 🧠/🎨 label
        // glyphs for either alone). A full dark-green fill rather than just a
        // border -- a border ring wasn't obvious enough zoomed out; a solid
        // fill reads at a glance at any zoom level. Listed after
        // .root/.transposition so it wins over their own background-color
        // for a node that's also a root or transposition room.
        { selector:'node.all-done', style:{ 'background-color':'#1b5e20' } },
        { selector:'node.run-box', style:{
          'shape':'round-rectangle', 'background-color':'#ffcc80', 'background-opacity':0.18,
          'border-width':1.5, 'border-style':'dashed', 'border-color':'#e69a3c',
          'label':'data(label)', 'font-size':8, 'color':'#b35e00',
          'text-valign':'top', 'text-halign':'center', 'text-margin-y':-2, 'padding':'12px'
        }},
        { selector:'node.twotrack-box', style:{
          'shape':'round-rectangle', 'background-color':'#b39ddb', 'background-opacity':0.22,
          'border-width':2, 'border-style':'solid', 'border-color':'#7e57c2',
          'label':'data(label)', 'font-size':8, 'color':'#4527a0',
          'text-valign':'top', 'text-halign':'center', 'text-margin-y':-2, 'padding':'14px'
        }},
        { selector:'node.locked', style:{
          'background-color':'#c62828', 'padding':'8px', 'font-size':11
        }},
        { selector:'edge', style:{
          'width':1.5, 'line-color':'#999', 'target-arrow-color':'#999',
          'target-arrow-shape':'triangle', 'curve-style':'bezier',
          'label':'data(label)', 'font-size':9, 'color':'#333', 'text-wrap':'wrap',
          'text-background-color':'#fff', 'text-background-opacity':0.8
        }},
        { selector:'edge.cycle-edge', style:{
          'line-color':'#8e24aa', 'target-arrow-color':'#8e24aa',
          'line-style':'dashed', 'width':1.5, 'opacity':0.7,
          'curve-style':'unbundled-bezier', 'control-point-distances':'40',
          'control-point-weights':'0.5', 'color':'#6a1b9a'
        }}
      ]
    });
    // dagre lays out the DAG (cycle edges absent; on a hard graph no compound
    // boxes either, so dagre only ever sees a plain, possibly-disconnected DAG).
    // generous nodeSep because the run/two-track boxes are added AFTER layout and
    // their padding/border extend past the bare nodes dagre spaced, so siblings
    // need lots of extra lateral room or adjacent boxes collide.
    cy.elements().layout({name:'dagre', rankDir:'TB', nodeSep:56, rankSep:60}).run();

    // Re-wrap boxes AFTER layout on hard graphs: add the box compound parents and
    // move each child into its box. Reparenting keeps each child at its laid-out
    // position; the compound parent just resizes to bound them. dagre never sees
    // the compounds, so it can't crash on them.
    if(flat && boxes.length){
      try {
        cy.add(boxes.map(b=>({ data:{id:b.id, label:b.label}, classes: b.kind === 'two-track' ? 'twotrack-box' : 'run-box' })));
        rooms.forEach(r=>{ if(boxOf.has(r.id)){ const n = cy.getElementById(r.id); if(n.nonempty()) n.move({parent: boxOf.get(r.id)}); } });
      } catch(err){ console.warn('[graph] box re-wrap skipped', err); }
    }
    // Snapshot dagre's own placement for every real (fen-bearing) node BEFORE
    // reapplying any saved deltas, so a later drag's delta is always measured
    // against dagre's fresh output -- never against a previously-nudged
    // position, which would double up the offset on every subsequent open.
    // Box/start nodes have no fen and aren't individually saved (v1 scope).
    cy.nodes().forEach(n => {
      const fen = n.data('fen');
      if(fen) n.scratch('_dagreBase', { x: n.position('x'), y: n.position('y') });
    });
    const savedDeltas = GRAPH_LAYOUT[scopeKey] || {};
    cy.nodes().forEach(n => {
      const fen = n.data('fen');
      if(!fen) return;
      const d = savedDeltas[positionKey(fen)];
      if(!d) return;
      const base = n.scratch('_dagreBase');
      n.position({ x: base.x + d.dx, y: base.y + d.dy });
    });
    // Drop the dashed repetition edges back in -- they connect already-positioned
    // nodes and never touch the layout.
    if(deferredEdgeEls.length){
      cy.add(deferredEdgeEls);
      $('graphStatus').textContent += ` · ⟳ ${backEdges.size} repetition move(s) drawn dashed`;
    }
    if(flat || deferredEdgeEls.length) cy.fit(cy.elements(), 30);
    attachGraphClickHandler(cy);
    attachGraphContextMenu(cy, scopeKey);

    // Save a manual de-overlap drag: delta from dagre's own placement, keyed
    // by the node's position (stable across a rebuild, unlike its cytoscape id).
    cy.on('dragfree', 'node', evt => {
      const n = evt.target;
      const fen = n.data('fen');
      if(!fen) return;   // box/start node -- not individually saved in v1
      const base = n.scratch('_dagreBase');
      if(!base) return;
      const p = n.position();
      saveGraphNodeDelta(scopeKey, positionKey(fen), p.x - base.x, p.y - base.y);
    });
    // test-only hook (mirrors threeVR.js's window.__threeTestEdit): drives a
    // "drag" programmatically (cytoscape nodes are canvas-rendered, not real
    // DOM elements a test can click-and-drag) by moving a node then emitting
    // the same event the real drag-release handler listens for.
    if(localStorage.getItem('threeTestDebug')){
      window.__graphTestHooks = {
        cy: () => cy,
        scopeKey: () => scopeKey,
        layout: () => GRAPH_LAYOUT,
        dragNodeBy: (fen, dx, dy) => {
          const n = cy.nodes().filter(x => x.data('fen') === fen);
          if(!n.nonempty()) return false;
          const p = n.position();
          n.position({ x: p.x + dx, y: p.y + dy });
          n.emit('dragfree');
          return true;
        },
        // writes straight to the same IDB key threeVR.js's memorized toggle
        // uses -- lets a test seed/clear a room's memorized flag without
        // driving the VR walk, then re-open the graph to see it reflected.
        setMemorized: async (roomKey, val) => {
          const map = JSON.parse(await getMeta('threeMemorizedRooms') || '{}');
          if(val) map[roomKey] = Date.now(); else delete map[roomKey];
          await setMeta('threeMemorizedRooms', JSON.stringify(map));
        },
        // same as setMemorized, for the "fully decorated" (Part A) flag.
        setDecorated: async (roomKey, val) => {
          const map = JSON.parse(await getMeta('threeDecoratedRooms') || '{}');
          if(val) map[roomKey] = Date.now(); else delete map[roomKey];
          await setMeta('threeDecoratedRooms', JSON.stringify(map));
        },
        // a node's rendered label (carries the moveQuality glyph and, once
        // decorated, the 🎨 glyph appended in showTranspositionGraph).
        labelOf: (fen) => {
          const n = cy.nodes().filter(x => x.data('fen') === fen);
          return n.nonempty() ? n.data('label') : null;
        },
        // the roomKey a node was classed against (null if it has no owning
        // castle), for asserting the memorized class landed on the right node.
        roomKeyOf: (fen) => {
          const n = cy.nodes().filter(x => x.data('fen') === fen);
          return n.nonempty() ? n.data('roomKey') : null;
        },
        // drives the real room-info click handler (cy.on('tap','node',...))
        // via a synthetic tap, same as dragNodeBy drives the drag handler --
        // exercises the actual showRoomInfoPanel code path, not a re-implementation.
        openRoomInfo: (fen) => {
          const n = cy.nodes().filter(x => x.data('fen') === fen);
          if(!n.nonempty()) return false;
          n.emit('tap');
          return true;
        },
        // drives the real right-click "Arrange" menu action directly (the box
        // itself is canvas-rendered, not a real DOM element a test can
        // right-click) -- boxIdOf resolves a member's box id first, same as a
        // test locates the box a member room belongs to.
        boxIdOf: (fen) => {
          const n = cy.nodes().filter(x => x.data('fen') === fen);
          return n.nonempty() ? (n.parent().nonempty() ? n.parent().id() : null) : null;
        },
        arrangeBox: (boxId) => {
          const box = cy.getElementById(boxId);
          if(!box.nonempty()) return false;
          arrangeBox(box, scopeKey);
          return true;
        },
      };
    }
  } finally {
    hideSpinner(spinner);
  }
}
$('buildGraphBtn').onclick = showTranspositionGraph;
$('graphResetLayoutBtn').onclick = async () => {
  if(!CURRENT_LINE) return;
  const rootSeq = GRAPH_FOCUS_SEQ || FOCUSED_SEQ;
  delete GRAPH_LAYOUT[graphScopeKey(CURRENT_LINE, rootSeq)];
  await persistGraphLayout();   // must land before showTranspositionGraph's own reload reads it back
  await showTranspositionGraph();
};
$('graphCloseBtn').onclick = () => {
  $('graphOverlay').style.display='none';
  hideGraphHoverPreview();
  hideGraphCtxMenu();
  GRAPH_FOCUS_SEQ = null;      // each fresh open starts at the move-table scope
  GRAPH_COVERAGE_OPEN = false;   // ...and with the coverage panel collapsed
};

// reflects GRAPH_COVERAGE_OPEN onto the toggle button's icon/title and the
// panel's own visibility -- called after every (re)render and on toggle.
function updateGraphCoverageVisibility(){
  $('graphCoverage').style.display = GRAPH_COVERAGE_OPEN ? 'flex' : 'none';
  $('graphCoverageToggle').innerHTML = `<i class="fa-solid fa-caret-${GRAPH_COVERAGE_OPEN ? 'down' : 'right'}"></i> Coverage`;
  $('graphCoverageToggle').title = GRAPH_COVERAGE_OPEN ? 'Hide coverage stats' : 'Show coverage stats';
}
$('graphCoverageToggle').onclick = () => {
  GRAPH_COVERAGE_OPEN = !GRAPH_COVERAGE_OPEN;
  updateGraphCoverageVisibility();
};

/* "Show Castle:" dropdown — fast-focus the graph on a defined castle's subtree
   without hunting through the tree. Hidden entirely when no castles are defined.
   Its value mirrors GRAPH_FOCUS_SEQ so right-click focus/clear keeps it in sync. */
function populateGraphCastleSelect(){
  const wrap = $('graphCastleWrap'), sel = $('graphCastleSelect');
  const castles = definedCastles();
  if(!castles.length){ wrap.style.display = 'none'; sel.innerHTML = ''; return; }
  wrap.style.display = '';
  sel.innerHTML = '<option value="">All</option>' +
    castles.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = focusedCastleName() || '';
}
$('graphCastleSelect').onchange = () => {
  const name = $('graphCastleSelect').value;
  if(!name){ GRAPH_FOCUS_SEQ = null; }
  else { const rs = castleRootRoomSeq(name); GRAPH_FOCUS_SEQ = rs || null; }
  showTranspositionGraph();
};

/* ---------- graph right-click context menu ----------
   Lets you re-scope the graph to a single variation's subtree without leaving
   the overlay: right-click a room → "Focus on this variation"; right-click
   anywhere → "Clear focus" when focused. Rebuilds the graph via GRAPH_FOCUS_SEQ. */
let graphCtxMenuEl = null;
function hideGraphCtxMenu(){ if(graphCtxMenuEl) graphCtxMenuEl.style.display='none'; }
function graphCtxMenu(){
  if(graphCtxMenuEl) return graphCtxMenuEl;
  const m = document.createElement('div');
  m.id = 'graphCtxMenu';
  m.style.cssText = 'position:fixed;z-index:10000;display:none;background:#fff;border:1px solid #bbb;'+
    'border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.25);font-size:.85rem;overflow:hidden';
  document.body.appendChild(m);
  document.addEventListener('click', hideGraphCtxMenu);
  document.addEventListener('scroll', hideGraphCtxMenu, true);
  graphCtxMenuEl = m;
  return m;
}
function showGraphCtxMenu(x, y, items){
  const m = graphCtxMenu();
  m.innerHTML = '';
  items.forEach(it=>{
    const b = document.createElement('div');
    b.textContent = it.label;
    b.style.cssText = 'padding:.45rem .85rem;cursor:pointer;white-space:nowrap';
    b.onmouseenter = ()=>{ b.style.background='#eef'; };
    b.onmouseleave = ()=>{ b.style.background=''; };
    b.onclick = e=>{ e.stopPropagation(); hideGraphCtxMenu(); it.onClick(); };
    m.appendChild(b);
  });
  m.style.left = x+'px'; m.style.top = y+'px'; m.style.display = 'block';
  const r = m.getBoundingClientRect();              // keep on-screen
  if(r.right > innerWidth)  m.style.left = Math.max(0, x - r.width)+'px';
  if(r.bottom > innerHeight) m.style.top  = Math.max(0, y - r.height)+'px';
}
// Recomputes a clean internal layout for a run/two-track box's members --
// a single straight column (run) or two parallel columns descending from a
// shared head (two-track), evenly spaced -- using the track/chainIdx tagged
// onto each member's node data at build time (see boxMemberInfo above).
// Saved through the same per-node delta mechanism a manual drag already
// uses (saveGraphNodeDelta persists immediately), so it survives a reopen
// and "Reset Layout" already knows how to undo it. The box itself needs no
// explicit resize -- a cytoscape compound parent auto-bounds its children.
// Only repositions THIS box's own members -- doesn't re-run the whole
// graph's layout, so it can occasionally leave the tidied box overlapping
// an untouched neighbor; Reset Layout is the fallback for that.
const ARRANGE_ROW_STEP = 60;   // vertical spacing between chain members, matches dagre's own rankSep
const ARRANGE_COL_STEP = 70;   // horizontal offset of two-track's left/right columns from center
function arrangeBox(boxEl, scopeKey){
  const bb = boxEl.boundingBox();
  const topY = bb.y1 + 24;
  const centerX = (bb.x1 + bb.x2) / 2;
  const place = (n, x, y) => {
    const fen = n.data('fen');
    if(!fen) return;
    const base = n.scratch('_dagreBase') || n.position();
    n.position({x, y});
    saveGraphNodeDelta(scopeKey, positionKey(fen), x - base.x, y - base.y);
  };
  if(boxEl.hasClass('twotrack-box')){
    const head = boxEl.children('[track = "head"]');
    if(head.nonempty()) place(head[0], centerX, topY);
    const left = boxEl.children('[track = "left"]').sort((a,b)=>a.data('chainIdx')-b.data('chainIdx'));
    const right = boxEl.children('[track = "right"]').sort((a,b)=>a.data('chainIdx')-b.data('chainIdx'));
    left.forEach((n,i) => place(n, centerX - ARRANGE_COL_STEP, topY + (i+1)*ARRANGE_ROW_STEP));
    right.forEach((n,i) => place(n, centerX + ARRANGE_COL_STEP, topY + (i+1)*ARRANGE_ROW_STEP));
  } else {
    const chain = boxEl.children().sort((a,b)=>a.data('chainIdx')-b.data('chainIdx'));
    chain.forEach((n,i) => place(n, centerX, topY + i*ARRANGE_ROW_STEP));
  }
}
// the menu items for a right-clicked / tapped node (shared by mouse cxttap and
// touch tap). Rooms get Focus + Show position + Room details; leaves get just
// Show position; a run/two-track box gets Arrange; Clear focus appears
// whenever the graph is focused.
function graphNodeMenuItems(cy, el, scopeKey){
  const seq = el.data('seq');
  const isBox = el.hasClass('run-box') || el.hasClass('twotrack-box');
  const focusable = seq && !el.hasClass('start') && !el.hasClass('locked') && !isBox;
  const items = [];
  if(isBox) items.push({ label:'🧹 Arrange',
    onClick:()=>arrangeBox(el, scopeKey) });
  if(focusable) items.push({ label:'🎯 Focus on this variation',
    onClick:()=>{ GRAPH_FOCUS_SEQ = seq.slice(); showTranspositionGraph(); } });
  if(el.data('fen')) items.push({ label:'♟ Show position',
    onClick:()=>showGraphNodePosition(cy, el) });
  if(focusable) items.push({ label:'🚪 Room details',
    onClick:()=>showRoomInfoPanel(el) });
  if(GRAPH_FOCUS_SEQ) items.push({ label:'⤺ Clear focus',
    onClick:()=>{ GRAPH_FOCUS_SEQ = null; showTranspositionGraph(); } });
  return items;
}
function attachGraphContextMenu(cy, scopeKey){
  cy.container().addEventListener('contextmenu', e=>e.preventDefault());
  cy.on('cxttap', 'node', evt=>{
    const items = graphNodeMenuItems(cy, evt.target, scopeKey);
    const oe = evt.originalEvent || {};
    if(items.length) showGraphCtxMenu(oe.clientX||0, oe.clientY||0, items);
  });
  cy.on('cxttap', evt=>{                    // background right-click: offer Clear when focused
    if(evt.target !== cy || !GRAPH_FOCUS_SEQ) return;
    const oe = evt.originalEvent || {};
    showGraphCtxMenu(oe.clientX||0, oe.clientY||0,
      [{ label:'⤺ Clear focus', onClick:()=>{ GRAPH_FOCUS_SEQ = null; showTranspositionGraph(); } }]);
  });
}

/* ---------- opening graph position preview ----------
   Shows the mini chessboard / #hoverPreview div (shared with attachHoverPreview's
   icon tooltips) for a node/edge on demand via the right-click / tap "Show
   position" menu item (hover was too easy to trigger by accident). The virtual
   'start' node has no fen and is skipped. Dismissed by tapping the board, tapping
   empty graph space, or closing the graph. */
function hideGraphHoverPreview(){
  $('hoverPreview').style.display = 'none';
}
function showGraphNodePosition(cy, el){
  const fen = el.data('fen');
  if(!fen) return;
  hoverPreviewBoard?.setPosition(fen);
  hoverPreviewBoard?.setOrientation(CURRENT_LINE?.color==='black' ? COLOR.black : COLOR.white);
  const containerRect = $('graphContainer').getBoundingClientRect();
  let pos;
  if(el.isEdge()){
    // edges have no renderedPosition() of their own — project their
    // model-space midpoint through the current pan/zoom by hand
    const mid = el.midpoint();
    const pan = cy.pan(), zoom = cy.zoom();
    pos = { x: mid.x*zoom + pan.x, y: mid.y*zoom + pan.y };
  } else {
    pos = el.renderedPosition();
  }
  const preview = $('hoverPreview');
  preview.style.display = 'block';
  preview.style.cursor = 'pointer';
  preview.onclick = hideGraphHoverPreview;       // tap the board to dismiss
  if($('roomInfoOverlay').style.display === 'flex'){
    positionHoverPreviewBesideRoomModal();
    return;
  }
  const cx = containerRect.left + pos.x;
  const cyy = containerRect.top + pos.y;
  const size = 252; // preview box incl. border/padding (240 board + padding/border)
  const left = Math.min(Math.max(8, cx - size/2), window.innerWidth - size - 8);
  const top = cyy + size + 20 <= window.innerHeight ? cyy + 20 : cyy - size - 20;
  preview.style.left = `${Math.round(left)}px`;
  preview.style.top = `${Math.round(Math.max(8,top))}px`;
}
/* keeps the hover-preview board from covering the room info modal: parks it
   just outside the modal's right edge (or left, if there's no room on the
   right) instead of next to the cursor */
function positionHoverPreviewBesideRoomModal(){
  const preview = $('hoverPreview');
  const modalRect = document.querySelector('#roomInfoOverlay .modal').getBoundingClientRect();
  const size = 252;
  const gap = 12;
  const left = modalRect.right + gap + size <= window.innerWidth
    ? modalRect.right + gap
    : Math.max(8, modalRect.left - gap - size);
  const top = Math.min(Math.max(8, modalRect.top), window.innerHeight - size - 8);
  preview.style.left = `${Math.round(left)}px`;
  preview.style.top = `${Math.round(top)}px`;
}

/* ---------- opening graph room info panel ----------
   Clicking a room node shows the move that leads into it, plus every
   reply ("exit") out of it, each annotated with its memory-palace word
   (looked up by destination square + piece type) when one is set. The
   virtual 'start' node and locked '?' leaves aren't rooms, so they're
   not clickable. */
function attachGraphClickHandler(cy){
  cy.on('tap', 'node', evt => {
    const el = evt.target;
    const oe = evt.originalEvent;
    // touch devices have no right-click, so a tap brings up the same menu the
    // desktop right-click shows; a mouse tap keeps the quick Room-details panel.
    const isTouch = oe && (oe.pointerType === 'touch'
      || (typeof TouchEvent !== 'undefined' && oe instanceof TouchEvent)
      || /^touch/.test(oe.type || ''));
    if(isTouch){
      const items = graphNodeMenuItems(cy, el);
      if(items.length){
        const t = (oe.touches && oe.touches[0]) || (oe.changedTouches && oe.changedTouches[0]) || oe;
        showGraphCtxMenu(t.clientX||0, t.clientY||0, items);
      }
      return;
    }
    if(el.hasClass('start') || el.hasClass('locked') || el.hasClass('run-box') || el.hasClass('twotrack-box')) return;
    showRoomInfoPanel(el);
  });
  cy.on('tap', evt => { if(evt.target === cy) hideGraphHoverPreview(); });  // tap empty space dismisses the position preview
}
// White's ply number ("N."), glued right onto the move's thumbnail image (in
// the same nowrap wrapper) so it can't end up visually separated from the
// icon it labels: the row already leads with plyLabel's "N. san" text, but on
// a narrow modal that text and the image can land on different wrapped
// lines, leaving the image with no number nearby. Only White's plies are
// numbered -- the same rule plyLabel already applies to that leading text.
const moveNumBadgeHtml = seq => (seq && seq.length % 2 === 1)
  ? `<b class="room-info-num">${Math.ceil(seq.length / 2)}.</b>` : '';
const mnemThumbHtml = (img, seq) => img
  ? `<span class="room-info-thumb">${moveNumBadgeHtml(seq)}<img class="room-info-img" src="${img}"></span>` : '';

/* ---------- mini board (from a FEN) ----------
   Renders a position's board field as an 8x8 grid using the SAME piece sprite
   (PIECES_FILE) the real boards (analysis, hover preview) render from, via SVG
   <use> -- pixel-identical artwork, not a Unicode-glyph approximation. Rank 8
   at top, or flipped for a black repertoire. Also used by the VR board icon
   (threeVR.js gets the same PIECES_FILE passed through openThreeTest) so every
   mini board in the app reads alike. Used in the graph room-info modal. */
// Browsers block an SVG <use> from referencing a document at a DIFFERENT
// origin outright, so the CDN sprite can't be used cross-origin in place --
// it has to be fetched and inlined into this document once, then referenced
// by a bare #id (a same-document reference). Same cache-div id/technique
// cm-chessboard's own board widget uses internally, so whichever runs first
// (a real Chessboard instance, or this) does the one fetch and the other
// reuses it -- this doesn't hard-depend on cm-chessboard's own DOM, though.
let pieceSpriteRequested = false;
function ensurePieceSprite(){
  if(pieceSpriteRequested || document.getElementById('cm-chessboard-sprite')) return;
  pieceSpriteRequested = true;
  const wrapper = document.createElement('div');
  wrapper.id = 'cm-chessboard-sprite';
  wrapper.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  wrapper.setAttribute('aria-hidden', 'true');
  document.body.appendChild(wrapper);
  fetch(PIECES_FILE).then(r => r.text()).then(svg => { wrapper.innerHTML = svg; }).catch(() => {});
}
function miniBoardGridHtml(fen, flip){
  ensurePieceSprite();
  const board = (fen || '').split(' ')[0];
  const ranks = board.split('/');                 // index 0 = rank 8
  const grid = [];
  for(let r = 0; r < 8; r++){
    const row = ranks[r] || '8';
    const cells = [];
    for(const ch of row){
      if(/\d/.test(ch)){ for(let k = 0; k < +ch; k++) cells.push(''); }
      else cells.push(ch);
    }
    while(cells.length < 8) cells.push('');
    grid.push(cells);
  }
  const order = flip ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
  let html = '';
  for(const r of order){
    for(const f of order){
      const ch = grid[r][f];
      // cm-chessboard's sprite ids are colour+piece, lowercase (e.g. 'wp','bn')
      const code = ch ? (ch === ch.toLowerCase() ? 'b' : 'w') + ch.toLowerCase() : '';
      const light = (r + f) % 2 === 0;            // parity by true square, so flip keeps colors right
      const bg = light ? '#e8ddc7' : '#9a7b53';
      // sprite pieces are drawn in a native 40x40 box (standard.svg's own
      // viewBox); matching viewBox here reproduces their original proportions.
      // Bare "#id" (not a full URL) -- see ensurePieceSprite for why.
      const piece = code
        ? `<svg viewBox="0 0 40 40" width="88%" height="88%"><use href="#${code}"></use></svg>`
        : '';
      html += `<div style="background:${bg}">${piece}</div>`;
    }
  }
  return html;
}
// test-only hook (mirrors threeVR.js's window.__threeTestEdit), so the graph's
// canvas-rendered room-info mini board can be checked without driving a real
// cytoscape node click.
if(localStorage.getItem('threeTestDebug')) window.__miniBoardGridHtml = miniBoardGridHtml;
// the roomKey of whatever node showRoomInfoPanel most recently rendered --
// read by roomInfoJumpBtn's click handler (kept as module state, same as
// GRAPH_FOCUS_SEQ etc., rather than threaded through the DOM).
let ROOM_INFO_ROOM_KEY = null;
async function showRoomInfoPanel(roomEl){
  const seq = roomEl.data('seq');
  ROOM_INFO_ROOM_KEY = roomEl.data('roomKey') || null;
  // Jump is offered only for a room you could actually reach by walking: it
  // needs a VR room (roomKey), and it must not be a locked-door dead end
  // (jumping inside a room whose only entrance is a locked door is confusing).
  const jumpable = ROOM_INFO_ROOM_KEY && !roomEl.data('lockedDeadEnd');
  $('roomInfoJumpBtn').style.display = jumpable ? '' : 'none';
  const mnemonicsBySquare = await getAllMnemonics();
  const whiteWord = mnemonicWordForSeq(seq, mnemonicsBySquare);
  const whiteImg = mnemonicImgForSeq(seq, mnemonicsBySquare);

  $('roomInfoTitle').innerHTML =
    `<i class="fa-solid fa-door-open"></i> ${escapeHtml(roomEl.data('label'))}` +
    (whiteWord ? ` <span class="room-info-word"><i class="fa-solid fa-brain"></i>${escapeHtml(whiteWord)}</span>` : '') +
    mnemThumbHtml(whiteImg);

  const rows = roomEl.outgoers('edge').map(edge => {
    const word = mnemonicWordForSeq(edge.data('seq'), mnemonicsBySquare);
    const img = mnemonicImgForSeq(edge.data('seq'), mnemonicsBySquare);
    return `<div class="room-info-exit">${escapeHtml(edge.data('label'))}` +
      (word ? ` <span class="room-info-word"><i class="fa-solid fa-brain"></i>${escapeHtml(word)}</span>` : '') +
      mnemThumbHtml(img, edge.data('seq')) +
      `</div>`;
  });
  $('roomInfoExits').innerHTML = rows.length ? rows.join('') :
    '<div class="room-info-exit room-info-empty">No replies yet</div>';

  // mini board of this node's position, below the move images
  const fen = roomEl.data('fen');
  const boardEl = $('roomInfoBoard'), capEl = $('roomInfoBoardCap');
  if(fen){
    boardEl.innerHTML = miniBoardGridHtml(fen, CURRENT_LINE?.color === 'black');
    boardEl.style.display = 'grid';
    capEl.textContent = (fen.split(' ')[1] === 'b' ? 'Black' : 'White') + ' to move';
    capEl.style.display = 'block';
  } else {
    boardEl.style.display = 'none';
    capEl.style.display = 'none';
  }

  $('roomInfoOverlay').style.display = 'flex';
  if($('hoverPreview').style.display === 'block') positionHoverPreviewBesideRoomModal();
}
$('roomInfoCloseBtn').onclick = () => { $('roomInfoOverlay').style.display='none'; };

// browse games modal wiring
$('gamesListCloseBtn').onclick = () => { $('gamesListOverlay').style.display='none'; _gamesModalState=null; };
$('gamesListOverlay').addEventListener('click', e => { if(e.target === $('gamesListOverlay')){ $('gamesListOverlay').style.display='none'; _gamesModalState=null; } });
$('gamesModePos').onclick = () => { _gamesModalState.mode = 'pos'; $('gamesModePos').classList.add('active'); $('gamesModeLine').classList.remove('active'); renderGamesList(); };
$('gamesModeLine').onclick = () => { _gamesModalState.mode = 'line'; $('gamesModeLine').classList.add('active'); $('gamesModePos').classList.remove('active'); renderGamesList(); };
document.querySelectorAll('.games-color-btn').forEach(btn => {
  btn.onclick = () => {
    _gamesModalState.color = btn.dataset.color;
    document.querySelectorAll('.games-color-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderGamesList();
  };
});
// live-filters as you type; a mid-token parse error (e.g. "1. d4 N") just
// leaves the last valid results showing rather than clearing the list.
let _gamesMovesDebounce = null;
$('gamesListMovesInput').addEventListener('input', () => {
  clearTimeout(_gamesMovesDebounce);
  _gamesMovesDebounce = setTimeout(() => renderGamesList(), 250);
});
// "Jump to VR" (Part B): try the fast path first -- VR already open and this
// room already registered in that session (jumpToRoom) -- and only fall back
// to (re)building the whole main world when that's not possible (VR closed,
// or open but missing this room's castle, e.g. a Preview-Castle session).
// The digraph overlay is deliberately left open underneath; only this modal
// closes (closing VR later returns to the still-open graph).
$('roomInfoJumpBtn').onclick = async () => {
  const roomKey = ROOM_INFO_ROOM_KEY;
  if(!roomKey) return;
  $('roomInfoOverlay').style.display = 'none';
  if(jumpToRoom(roomKey)) return;
  await openMainVRWorld(roomKey);
};
$('castleReportCloseBtn').onclick = () => { $('castleReportOverlay').style.display='none'; };
/* G2a: walk the generated castle in VR — hand its room/exit structure to the
   three.js engine, which synthesizes navigable rooms and spawns us at the entry. */
$('castleWalkBtn').onclick = async () => {
  if(!LAST_GENERATED_CASTLE){ return; }
  $('castleReportOverlay').style.display='none';
  $('threeTestOverlay').style.display='flex';
  const lines = CURRENT_USER ? await getLines(CURRENT_USER) : [];
  const systems = await systemsForWalk(lines);
  // same instance id the street flow uses, so decorations made during this
  // preview land in (and load from) the same per-castle rooms
  const castleName = LAST_GENERATED_CASTLE.genRooms[0]?.castle || '';
  const instanceId = castleInstanceId(CURRENT_LINE?.id, castleName);
  // any OTHER castle this one has a redirected door into -- built and
  // registered too so those doors resolve (see gatherLinkedCastles).
  const linkedCastles = gatherLinkedCastles(castleName, LAST_GENERATED_CASTLE.genRooms);
  const roomNameIndex = buildRoomNameIndex([
    { lineId: CURRENT_LINE?.id, instanceId, genRooms: LAST_GENERATED_CASTLE.genRooms },
    ...linkedCastles.map(c => ({ lineId: CURRENT_LINE?.id, instanceId: c.instanceId, genRooms: c.genRooms }))
  ]);
  openThreeTest($('threeTestCanvasWrap'), {
    systems,
    castle: LAST_GENERATED_CASTLE,
    castleInstanceId: instanceId,
    linkedCastles,
    piecesFile: PIECES_FILE,
    onRoomRename: makeRoomRenamer(roomNameIndex),
    onClose: ()=>{ $('threeTestOverlay').style.display='none'; closeThreeTest(); },
    onAssets: openThreeTestAssets
  });
};

/* ---------- toggle helper ----------
   `seq`, when given, is this row's own pref seq (ends in the opponent's
   move) — every manual expand/collapse click persists collapsed there too,
   so a single row's expand/collapse choice sticks across reloads the same
   way Collapse All's does, instead of only the bulk action being sticky. */
function makeToggle(btn, branchRow, startExpanded=true, seq=null){
  // the button renders by default as a greyed, non-clickable placeholder
  // (.toggle-empty) so every row reserves the triangle's width and moves stay
  // aligned; this row actually has a sub-tree, so promote it to a live triangle.
  btn.classList.remove('toggle-empty');
  btn.style.display='';
  if(!startExpanded) branchRow.style.display='none';
  btn.innerHTML = startExpanded            // reflects branchRow's actual initial state
    ? '<i class="fa-solid fa-caret-down"></i>'
    : '<i class="fa-solid fa-caret-right"></i>';
  btn.onclick=()=>{                              // rewired each call to target the current branchRow
    const shown = branchRow.style.display !== 'none';
    branchRow.style.display = shown ? 'none' : '';
    btn.innerHTML = shown
      ? '<i class="fa-solid fa-caret-right"></i>'
      : '<i class="fa-solid fa-caret-down"></i>';
    if(seq) savePrefField(seq,'collapsed',shown);
  };
}

/* ---------- escape free text before inserting into innerHTML ---------- */
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------- per-row "more" menu ---------- */
function closeAllRowMenus(){
  document.querySelectorAll('.row-menu.show').forEach(m=>m.classList.remove('show'));
  document.querySelectorAll('.row-menu-quality.expanded').forEach(q=>q.classList.remove('expanded'));
}
document.addEventListener('click', closeAllRowMenus);

/* ---------- canonicalize move-input case (castling + piece letters) ----------
   O/Q/N/K/R never collide with file letters (a-h), so they're safe to
   uppercase unconditionally; B is ambiguous with the b-file so left alone. */
const canonicalizeMoveCase = v => v.replace(/[oqnkr]/gi, c => c.toUpperCase());

/* ---------- mnemonic / response / rename modal ---------- */
let fieldModalSave = null, fieldModalValidate = null;
// `validate(rawInput)` is optional; return {ok:true, value} to accept (value
// is what gets passed to onSave, letting the caller normalize the input), or
// {ok:false, error} to reject and keep the modal open with the error shown.
function openFieldModal(field, currentValue, onSave, validate){
  const has = !!currentValue;
  $('fieldModalTitle').textContent =
    field==='mnemonic' ? (has ? 'Edit Mnemonic' : 'Add Mnemonic') :
    field==='lineName' ? 'Rename Opening System' :
    field==='streetName' ? 'Set Street Name' :
    field==='branchName' ? (has ? 'Edit Branch Name' : 'Add Branch Name') :
    field==='addMove' ? 'Add Opponent Response' :
    (has ? 'Edit Standard Response' : 'Set Standard Response');
  $('fieldModalInput').value = currentValue || '';
  $('fieldModalError').textContent = '';
  fieldModalSave = onSave;
  fieldModalValidate = validate || null;
  $('fieldOverlay').style.display='flex';
  $('fieldModalInput').focus();
}
$('fieldModalInput').addEventListener('input', () => { $('fieldModalError').textContent = ''; });
$('fieldModalCancelBtn').onclick = () => {
  $('fieldOverlay').style.display='none';
  fieldModalSave = null; fieldModalValidate = null;
};
$('fieldModalSaveBtn').onclick = () => {
  let v = $('fieldModalInput').value.trim();
  if(fieldModalValidate){
    const result = fieldModalValidate(v);
    if(!result.ok){ $('fieldModalError').textContent = result.error; return; }
    v = result.value;
  }
  $('fieldOverlay').style.display='none';
  if(fieldModalSave) fieldModalSave(v);
  fieldModalSave = null; fieldModalValidate = null;
};

/* ---------- node attributes modal ("Set Attributes" on a row) ----------
   Most room decoration now happens in the VR walkthrough, so this modal is
   down to the two things the castle generator needs: a Room name (relevant for
   every move — even a castle's first room, which might be "Foyer"), and, only
   when this node starts a new castle, the Castle name. Stored as plain pref
   fields (name / isCastleRoot / castleName). */
let attributesModalSave = null;
let attrModalLineSeq = null;
function openAttributesModal(saved, onSave, lineSeq){
  attrModalLineSeq = lineSeq;
  $('attrRoomName').value = saved?.name || '';
  $('attrIsCastleRoot').checked = !!saved?.isCastleRoot;
  $('attrCastleName').value = saved?.castleName || '';
  const savedNum = parseInt(saved?.castleStreetNumber, 10);
  $('attrStreetNumber').value = (Number.isFinite(savedNum) && savedNum >= 1) ? savedNum : '';
  $('attrNote').value = saved?.note || '';
  $('attrError').textContent = '';
  refreshCastleOwnerSelect(saved, lineSeq);
  refreshAttrFieldVisibility();
  attributesModalSave = onSave;
  $('attributesOverlay').style.display='flex';
}
function refreshAttrFieldVisibility(){
  const isRoot = $('attrIsCastleRoot').checked;
  $('attrCastleNameField').style.display = isRoot ? '' : 'none';
  $('attrStreetNumberField').style.display = isRoot ? '' : 'none';
  updateCastleOwnerAutoLabel(attrModalLineSeq);
}

/* every castle defined in this opening system (distinct castle names on
   isCastleRoot nodes) */
function definedCastles(){
  const set = new Set();
  for(const key in PREFS){
    const p = PREFS[key];
    if(p && p.isCastleRoot && p.castleName && p.castleName.trim()) set.add(p.castleName.trim());
  }
  return [...set].sort((a,b)=>a.localeCompare(b));
}
/* street numbers claimed by castles in this opening system (castleName ->
   number), excluding `exceptCastleName` (the castle being edited). Lower
   numbers sit closer to Main Street on the system's VR side street. */
function usedStreetNumbers(exceptCastleName){
  const used = new Map();
  const except = (exceptCastleName || '').trim();
  for(const key in PREFS){
    const p = PREFS[key];
    if(!p?.isCastleRoot || !p.castleName?.trim()) continue;
    const name = p.castleName.trim();
    if(name === except) continue;
    const n = parseInt(p.castleStreetNumber, 10);
    if(Number.isFinite(n) && n >= 1 && !used.has(name)) used.set(name, n);
  }
  return used;
}
/* the castle (if any) already holding this street number in this system */
function streetNumberConflict(num, exceptCastleName){
  for(const [name, n] of usedStreetNumbers(exceptCastleName)) if(n === num) return name;
  return null;
}
/* default for a new castle: one past the highest number in use */
function nextStreetNumber(exceptCastleName){
  let max = 0;
  for(const n of usedStreetNumbers(exceptCastleName).values()) max = Math.max(max, n);
  return max + 1;
}
/* the focusable ROOM seq (ends in OUR move) for a castle's root: the root flag
   lives on the opponent-move row (p.seq), so the room is one reply deeper. Picks
   the shallowest root if a name somehow tags more than one. */
function castleRootRoomSeq(castleName){
  let best = null;
  for(const key in PREFS){
    const p = PREFS[key];
    if(p?.isCastleRoot && p.castleName?.trim() === castleName && p.reply && Array.isArray(p.seq)){
      const roomSeq = [...p.seq, p.reply];
      if(!best || roomSeq.length < best.length) best = roomSeq;
    }
  }
  return best;
}
// resolves GRAPH_FOCUS_SEQ back to the castle name it belongs to (if any) --
// shared by the "Show Castle" dropdown's current selection and the
// castle-room stats in the digraph status line.
function focusedCastleName(){
  // same precedence showTranspositionGraph's own rootSeq uses: the digraph's
  // local right-click focus wins if set, otherwise fall back to whatever the
  // move table itself is focused on -- without this fallback, opening the
  // digraph while focused (in the move table) on a castle root correctly
  // scoped the DISPLAYED nodes to that castle (rootSeq already had this same
  // fallback) but left the stats/coverage totals computed against every
  // castle in the system instead of just the one being shown.
  const seq = GRAPH_FOCUS_SEQ || FOCUSED_SEQ;
  if(!seq) return null;
  const key = seq.join(',');
  return definedCastles().find(c => { const rs = castleRootRoomSeq(c); return rs && rs.join(',') === key; }) || null;
}
/* BFS out from a previewed castle to every OTHER castle its rooms have a
   redirected door into (see buildCastleGraph's foreign-exit redirect), so the
   ephemeral single-castle "Walk in VR" preview can register their rooms too --
   otherwise a door crossing into a foreign castle would point at a room that
   was never built for this session and fail to resolve. Not needed for the
   main "Run VR" world: gatherBuiltCastles already builds every castle in the
   opening system independently, so every foreign key resolves on its own.
   Returns [{name, instanceId, genRooms}, …] for every linked castle beyond
   `startCastleName` (the caller already has that one built). */
function gatherLinkedCastles(startCastleName, startGenRooms){
  const seen = new Set([startCastleName].filter(Boolean));
  const queue = [];
  const collectForeign = genRooms => {
    for(const r of genRooms) for(const ex of r.exits){
      if(ex.foreignCastle && !seen.has(ex.foreignCastle)){ seen.add(ex.foreignCastle); queue.push(ex.foreignCastle); }
    }
  };
  collectForeign(startGenRooms || []);
  const out = [];
  while(queue.length){
    const name = queue.shift();
    const rootSeq = castleRootRoomSeq(name);
    if(!rootSeq) continue;   // named but not built yet -- nothing to link to
    const genRooms = buildGeneratedCastle(CURRENT_LINE, gamesForLineColor(GAMES, CURRENT_LINE.color), rootSeq, name).genRooms;
    out.push({ name, instanceId: castleInstanceId(CURRENT_LINE.id, name), genRooms });
    collectForeign(genRooms);
  }
  return out;
}
/* nearest castle root on THIS seq's own lineage (the default/inherited owner).
   `lineId` defaults to CURRENT_LINE -- pass it explicitly when PREFS holds a
   DIFFERENT line's data (e.g. mid-quiz-session, where PREFS is swapped to the
   quizzed line, which can differ from whatever's open in the tree view). */
function inheritedCastle(lineSeq, lineId = CURRENT_LINE?.id){
  for(let s = (lineSeq||[]).slice(); s.length; s = s.slice(0,-1)){
    const p = PREFS[prefKey(lineId, s)];
    if(p?.isCastleRoot && p.castleName?.trim()) return p.castleName.trim();
  }
  return '';
}
/* resolves `seq` (the OPPONENT-move seq a row's own attributes pref is keyed
   on -- same convention genRoomMeta uses, one ply back from the room itself,
   which ends in OUR reply) to the CANONICAL seq that owns the resulting
   room's shared attributes (name, isCastleRoot, castleName, castleOwner,
   castleStreetNumber). buildCastleGraph merges transposing paths reaching
   the same position into one room object, keeping only whichever seq it
   first discovered; reading/writing "Set Attributes" via a DIFFERENT
   transposing path's own seq would silently miss that shared data (VR's
   door plaques, which read via genRoomMeta's own canonical seq, would never
   reflect it). Returns `seq` unchanged when there's no reply recorded yet
   (no room built here at all -- nothing to canonicalize) or it isn't part
   of any built castle (no room, no transposition to resolve). */
function canonicalRoomSeq(seq){
  const reply = PREFS[prefKey(CURRENT_LINE.id, seq)]?.reply;
  if(!reply) return seq;
  const roomSeq = [...seq, reply];
  const castle = inheritedCastle(roomSeq, CURRENT_LINE.id);
  if(!castle) return seq;
  const rootSeq = castleRootRoomSeq(castle);
  if(!rootSeq) return seq;
  const graph = buildCastleGraph(CURRENT_LINE, gamesForLineColor(GAMES, CURRENT_LINE.color), rootSeq, false, castle);
  const key = positionKey(fenForSeq(roomSeq));
  const room = graph.rooms.find(r => positionKey(r.fen) === key);
  return room ? room.seq.slice(0, -1) : seq;
}
/* Like inheritedCastle, but for THIS node uses the attributes modal's own
   live (unsaved) isCastleRoot/castleName fields instead of its last-saved
   PREFS value -- so checking "starts new castle" and typing a name updates
   the "Auto" option's label immediately, instead of only after Save. */
function liveInheritedCastle(lineSeq){
  const isRoot = $('attrIsCastleRoot').checked;
  const castleName = $('attrCastleName').value.trim();
  if(isRoot && castleName) return castleName;
  return inheritedCastle((lineSeq||[]).slice(0,-1));
}
function updateCastleOwnerAutoLabel(lineSeq){
  const opt = $('attrCastleOwner').querySelector('option[value=""]');
  if(!opt) return;
  const inherited = liveInheritedCastle(lineSeq);
  opt.textContent = `Auto${inherited ? ` (inherit: ${inherited})` : ' (no ancestor castle)'}`;
}
/* "Belongs to castle" override: Auto (inherit) + every defined castle. Only
   needed to resolve a transposition shared by two castles; hidden when no
   castles exist (and there's no stored override to preserve). */
function refreshCastleOwnerSelect(saved, lineSeq){
  const sel = $('attrCastleOwner');
  const inherited = liveInheritedCastle(lineSeq);
  const castles = definedCastles();
  sel.innerHTML =
    `<option value="">Auto${inherited ? ` (inherit: ${escapeHtml(inherited)})` : ' (no ancestor castle)'}</option>` +
    castles.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = saved?.castleOwner || '';
  $('attrCastleOwnerField').style.display = (castles.length || saved?.castleOwner) ? '' : 'none';
}
$('attrIsCastleRoot').addEventListener('change', refreshAttrFieldVisibility);
$('attrCastleName').addEventListener('input', () => updateCastleOwnerAutoLabel(attrModalLineSeq));
$('attributesCancelBtn').onclick = () => {
  $('attributesOverlay').style.display='none';
  attributesModalSave = null;
};
$('attributesSaveBtn').onclick = () => {
  const isRoot = $('attrIsCastleRoot').checked;
  const castleName = $('attrCastleName').value.trim();
  // street number: optional here (Generate Castle fills it in if left blank),
  // but when given it must be a positive integer unique among this system's
  // other castles — same rule Generate Castle enforces.
  let streetNumber = '';
  const rawNum = $('attrStreetNumber').value.trim();
  if(isRoot && rawNum !== ''){
    const num = parseInt(rawNum, 10);
    if(!Number.isFinite(num) || num < 1){
      $('attrError').textContent = 'Street number must be a positive whole number.';
      return;
    }
    const clash = streetNumberConflict(num, castleName);
    if(clash){
      $('attrError').textContent = `Street number ${num} is already used by "${clash}" in this opening system.`;
      return;
    }
    streetNumber = num;
  }
  const v = {
    roomName: $('attrRoomName').value.trim(),
    isCastleRoot: isRoot,
    castleName,
    castleOwner: $('attrCastleOwner').value,
    castleStreetNumber: streetNumber,
    note: $('attrNote').value.trim()
  };
  $('attributesOverlay').style.display='none';
  if(attributesModalSave) attributesModalSave(v);
  attributesModalSave = null;
};

/* ---------- focus on a single line, hiding sibling branches above it ----------
   Walks from the clicked row up through each ancestor table, hiding every
   other reply group at that depth; everything at or below the focused row
   is left exactly as rendered (untouched). */
let focusHidden = [];
/* the our-move seq (same convention as Generate Castle's childrenSeq) at
   the focused row, if its standard response is configured — lets Build
   Graph scope itself to just the focused subtree instead of the whole line */
let FOCUSED_SEQ = null;
/* stable identity (the focused row's data-seq) of the currently focused row, so
   focus can be re-applied after a full tree rebuild (compact/visibility toggle)
   instead of being silently orphaned when innerHTML is wiped. */
let FOCUSED_ROW_KEY = null;
function clearFocus(){
  focusHidden.forEach(el=>el.classList.remove('focus-hidden'));
  focusHidden = [];
  FOCUSED_SEQ = null;
  FOCUSED_ROW_KEY = null;
  $('unfocusBtn').style.display='none';
}
function rowGroup(tbody, dataRow){
  const rows = Array.from(tbody.children);
  const group = [dataRow];
  for(let i=rows.indexOf(dataRow)+1; i<rows.length; i++){
    if(rows[i].classList.contains('data-row')) break;
    group.push(rows[i]);
  }
  return group;
}
function focusOnLine(dataRow, seq=null){
  clearFocus();
  FOCUSED_SEQ = seq;
  FOCUSED_ROW_KEY = dataRow.dataset.seq || null;
  let node = dataRow;
  while(node){
    const tbody = node.parentElement;
    const keep = new Set(rowGroup(tbody, node));
    Array.from(tbody.children).forEach(row=>{
      if(row.classList.contains('context-row')) return; // "1. d4" header — always part of the lead-in, never a sibling option to hide
      if(!keep.has(row)){ row.classList.add('focus-hidden'); focusHidden.push(row); }
    });
    const branchRow = tbody.parentElement.closest('tr.branch-row');
    if(!branchRow) break;
    const metaRow = branchRow.previousElementSibling;
    node = metaRow ? metaRow.previousElementSibling : null;
  }
  $('unfocusBtn').style.display='inline-block';
}
$('unfocusBtn').onclick = clearFocus;

/* ---------- hidden-branch visibility toggle ----------
   showAllBranches=true (open eye): everything shown, hidden branches in red.
   showAllBranches=false (closed eye): hidden branches are not rendered. */
let showAllBranches = localStorage.getItem(LS_SHOW_ALL_BRANCHES) !== 'false';
function applyVisibilityMode(){
  $('tree').classList.toggle('filter-hidden', !showAllBranches);
  $('visibilityToggleBtn').innerHTML = showAllBranches
    ? '<i class="fa-solid fa-eye"></i>'
    : '<i class="fa-solid fa-eye-slash"></i>';
}
$('visibilityToggleBtn').onclick = () => {
  showAllBranches = !showAllBranches;
  localStorage.setItem(LS_SHOW_ALL_BRANCHES, showAllBranches);
  applyVisibilityMode();
  /* which opponent replies count as "visible" changes which rooms qualify
     as forced (single-reply) for compact-mode hoisting, so a full re-render
     (not just the CSS class toggle above) is needed whenever a line is open */
  if(CURRENT_LINE) renderTreeBody(CURRENT_LINE);
};

/* ---------- compact mode ----------
   Hoists forced (single visible reply) move sequences into one row instead
   of one row per ply-pair — see Documents/CastleBuildingNotes.md's
   "hallways vs. doors" note for the design rationale. A run breaks at any
   move that has been annotated (note/mnemonic/name/classification/etc) so
   those stay on their own interactive row even in compact mode. */
let compactMode = localStorage.getItem(LS_COMPACT_MODE) === 'true';
function applyCompactModeButton(){
  $('compactModeBtn').classList.toggle('active', compactMode);
  $('compactModeBtn').title = compactMode
    ? 'Compact mode on — click for full mode'
    : 'Toggle compact mode (hoist forced sequences into one row)';
}
applyCompactModeButton();
$('compactModeBtn').onclick = async () => {
  compactMode = !compactMode;
  localStorage.setItem(LS_COMPACT_MODE, compactMode);
  applyCompactModeButton();
  if(!CURRENT_LINE) return;
  // rebuilding the tree is CPU-heavy on large systems (~1500 nodes) and blocks
  // the main thread, so show a spinner and let it paint before we start.
  const spinner = showSpinner(compactMode ? 'Compacting tree…' : 'Expanding tree…');
  await nextPaint();
  try { renderTreeBody(CURRENT_LINE); }
  finally { hideSpinner(spinner); }
};

/* ---------- collapse all expanded branches ----------
   Each click below runs through makeToggle's onclick, which already
   persists collapsed:true for that row, so the collapse sticks across a
   page refresh instead of just being a one-off visual toggle. */
$('collapseAllBtn').onclick = () => {
  $('tree').querySelectorAll('.toggle:not(.toggle-empty)').forEach(btn=>{
    if(btn.querySelector('i')?.classList.contains('fa-caret-down')) btn.click();
  });
};
/* mirror of Collapse All — clicking each collapsed toggle expands it (and, like
   Collapse All, persists collapsed:false through makeToggle's onclick). Every
   branch row is rendered eagerly (just hidden when collapsed), so all toggles
   already exist in the DOM and a single pass expands the whole tree. */
$('expandAllBtn').onclick = () => {
  $('tree').querySelectorAll('.toggle:not(.toggle-empty)').forEach(btn=>{
    if(btn.querySelector('i')?.classList.contains('fa-caret-right')) btn.click();
  });
};

/* ---------- compact mode helpers ----------
   See Documents/CastleBuildingNotes.md's "hallways vs. doors" note: a forced
   (single-reply) sequence should read as one hallway, not a room per ply.
   `seq` always ends in OUR move here, same convention as renderBranch. */
function visibleOppsAt(games,seq){
  const {counts} = replies(games,seq);
  const manual = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
  manual.forEach(m=>{ if(!(m in counts)) counts[m]=0; });
  let keys = Object.keys(counts);
  if(!showAllBranches){
    keys = keys.filter(opp=>!PREFS[prefKey(CURRENT_LINE.id,[...seq,opp])]?.hidden);
  }
  return keys;
}

/* shows (or hides, for an unanswered row with nothing to report) a row's
   "complete to move N" badge -- the shallowest branch-move number below this
   row's own reply, per computeNodeStats's definition. Shared by renderBranch,
   renderBlackRoot, and renderCompactRunRow's own row, all of which display
   the completeToMove value returned by their own expandWith-style
   renderBranch call the same way. */
function updateCompleteBadge(span, completeToMove){
  if(!span) return;
  if(!Number.isFinite(completeToMove)){ span.style.display='none'; span.textContent=''; return; }
  span.textContent = `[${completeToMove}]`;
  span.title = `Complete through move ${completeToMove} — every branch below this point has a chosen reply at least this deep`;
  span.style.display='';
}

/* walks forward from `seq` while every position along the way has exactly
   one visible opponent reply *and* an already-chosen standard response with
   no annotations of its own — annotated moves (note/mnemonic/name/etc) keep
   their own full row even in compact mode, since a hoisted row has nowhere
   to show that detail. Stops (and returns null) below 2 hoisted moves, since
   a single forced pair isn't worth collapsing into a different row shape. */
const COMPACT_RUN_CAP = 80;
function computeCompactRun(games,seq,depth,flip){
  const runMoves = [];
  let curSeq = seq, curDepth = depth;
  while(runMoves.length < COMPACT_RUN_CAP){
    const opps = visibleOppsAt(games,curSeq);
    if(opps.length !== 1) break;
    const opp = opps[0];
    const lineSeq = [...curSeq,opp];
    const saved = PREFS[prefKey(CURRENT_LINE.id,lineSeq)];
    const reply = saved?.reply;
    if(!reply) break;
    const annotated = !!(saved.note || saved.mnemonic || saved.name || saved.classification ||
                          saved.exitType || saved.blunderTrap || saved.isCastleRoot || saved.castleName);
    if(annotated) break;
    runMoves.push({opp,reply,lineSeq,depth:curDepth});
    curSeq = [...lineSeq,reply];
    curDepth += 1;
  }
  if(runMoves.length < 2) return null;
  return {runMoves, endSeq:curSeq, endDepth:curDepth};
}

function compactRunLabel(runMoves,flip){
  return runMoves.map(({opp,reply,depth})=>
    flip ? `${depth+1}. ${opp} ${reply}` : `${opp} ${depth+2}. ${reply}`
  ).join(' ');
}

/* single row standing in for a whole hoisted run: one Analyse button (no
   per-move menu — switch to Full mode for per-move editing/notes), the
   collapsed move text, and a branch-row that resumes normal rendering from
   wherever the run ended. Always expanded — there's nothing to collapse,
   since the run itself is already the collapsed form. */
function renderCompactRunRow(tb,games,depth,flip,run,indentLevel){
  const {runMoves,endSeq,endDepth} = run;
  const tr = document.createElement('tr');
  tr.className = 'data-row compact-run';
  tr.innerHTML =
    `<td class="resp">
       <button class="iconbtn" title="Analyse"><i class="fa-solid fa-chess-board"></i></button>
     </td>
     <td class="move" style="padding-left:${indentLevel}em">
       <button class="iconbtn toggle toggle-empty"><i class="fa-solid fa-caret-right"></i></button>
       ${compactRunLabel(runMoves,flip)}
     </td>
     <td class="cnt-col"><span class="completeBadge"></span></td>
     <td class="eval-col"></td>
     <td class="name-col"></td>`;
  tb.appendChild(tr);
  tr.dataset.seq = endSeq.join(',');   // identity for search/focus: this row stands in for the whole run, ending at endSeq

  const btnEval = tr.querySelector('td.resp > button.iconbtn');
  attachHoverPreview(btnEval, endSeq);
  btnEval.onclick = () => showPosition(fenForSeq(endSeq), ()=>{}, ()=>{}, endSeq);

  const tr1 = document.createElement('tr'); tr1.className='branch-row'; tr.after(tr1);
  const td1 = document.createElement('td'); td1.colSpan=5; td1.style.padding='0'; tr1.appendChild(td1);
  const div = document.createElement('div'); div.className='branch'; td1.appendChild(div);
  const sub = renderBranch(div,games,endSeq,endDepth,flip);
  updateCompleteBadge(tr.querySelector('.completeBadge'), sub.completeToMove);
  return sub;
}

/* opponent-move quality annotations (chess glyphs). Kept in one place so the
   move table, the network graph and the VR walk all render the same glyph +
   colour. Class drives colour: good/interesting/dubious/bad. */
const MOVE_QUALITY_GLYPHS = ['!', '!!', '!?', '?!', '?', '??'];
const MOVE_QUALITY_CLASS = {
  '!': 'mq-good', '!!': 'mq-good', '!?': 'mq-interesting',
  '?!': 'mq-dubious', '?': 'mq-bad', '??': 'mq-bad',
};
const moveQualityFor = (seq) => PREFS[prefKey(CURRENT_LINE.id, seq)]?.moveQuality || '';

/* a "More" three-dot menu (mirrors the live engine panel's own pvMenu
   button/icon) offering "Import this variation" for one saved PV -- idx -1
   for the single-eval case, else its index into evalLines. Only rendered
   when there's a real UCI PV to import from (canImport's "line.pvUci"
   half) and an open opening system to import into (its "CURRENT_LINE"
   half) -- same two-part gate importEngineVariation's own caller uses,
   just checked per-line here since evalContinuationHtml can render several.
   wireEvalContinuationMenus (below) attaches the click handler after this
   HTML is inserted into the DOM. */
function pvImportMenuHtml(idx, pvUci){
  if(!CURRENT_LINE || !pvUci?.length) return '';
  return `<button class="iconbtn pvMenu meta-pv-menu" data-pv-idx="${idx}" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>`;
}
/* the saved eval's PV as tappable move chips: one line when only a
   single-line (MultiPV=1) analysis produced it (unchanged from before
   evalLines existed), or one row per line -- each with its own eval badge,
   since only the best one shows in the row's own eval tag -- when it came
   from a multi-line (MultiPV>1) run. "not available" covers evals saved
   before PV storage existed. Shared by renderBranch/renderBlackRoot's
   near-identical per-row continuation wiring. */
function evalContinuationHtml(saved, lineSeq){
  const ev = saved?.eval;
  if(!ev?.pv) return `<span class="meta-pv"><em>not available</em></span>`;
  const lines = (saved.evalLines && saved.evalLines.length > 1) ? saved.evalLines : null;
  if(!lines){
    const startFen = ev.pvFen || fenForSeq(lineSeq);
    const chips = (ev.pvUci?.length && pvChipsFromUci(startFen, ev.pvUci, ev.pvUci.length))
      || pvChipsFromSan(startFen, ev.pv);
    return `${pvImportMenuHtml(-1, ev.pvUci)}<span class="meta-pv">${chips || escapeHtml(ev.pv)}</span>`;
  }
  return lines.map((line, idx) => {
    const startFen = line.pvFen || fenForSeq(lineSeq);
    const chips = (line.pvUci?.length && pvChipsFromUci(startFen, line.pvUci, line.pvUci.length))
      || pvChipsFromSan(startFen, line.pv);
    const scoreTag = `<span class="meta-pv-score ${evalClass(line, CURRENT_LINE.color)}">${formatEvalTag(line)}</span>`;
    return `<div class="meta-pv-row">${pvImportMenuHtml(idx, line.pvUci)}${scoreTag}<span class="meta-pv">${chips || escapeHtml(line.pv)}</span></div>`;
  }).join('');
}
// Wires up the "Import this variation" menu(s) evalContinuationHtml just
// rendered into metaTd -- called right after metaTd.innerHTML is set,
// alongside the mnemEl/noteEl wiring both call sites already do the same
// way. Re-reads the line data fresh from currentSaved() rather than
// stashing it in the DOM (same reasoning saveField's re-fetch pattern
// uses elsewhere), so a rebuild between render and click can't hand a
// stale PV to the importer.
function wireEvalContinuationMenus(metaTd, lineSeq, currentSaved){
  metaTd.querySelectorAll('.meta-pv-menu').forEach(btn => {
    const idx = parseInt(btn.dataset.pvIdx, 10);
    btn.onclick = e => {
      e.stopPropagation();
      const saved = currentSaved();
      const line = idx < 0 ? saved?.eval : saved?.evalLines?.[idx];
      if(!line?.pvUci?.length) return;
      const startFen = line.pvFen || fenForSeq(lineSeq);
      showGraphCtxMenu(e.clientX || 0, e.clientY || 0, [
        { label: '⬇ Import this variation',
          onClick: () => importEngineVariation(lineSeq, startFen, line.pvUci, line.pvUci.length) },
      ]);
    };
  });
}

/* ---------- recursive branch renderer ----------
   flip=true is used for Black lines from move-pair 2 onward: the enumerated
   move (opp) is White's actual move (data), and "our" move is the standard
   reply we set, displayed after it once chosen (e.g. "2. e4 d5"). For White
   lines (flip=false) the enumerated move is the opponent's reply to our own
   already-known move, e.g. "1. e4 e5". */
function renderBranch(parent,games,seq,depth,flip=false){
  const {counts,tot}=replies(games,seq);
  const manualReplies = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
  manualReplies.forEach(m=>{ if(!(m in counts)) counts[m]=0; });

  // "complete to move N" for THIS position (seq, which ends in our move) --
  // same definition computeNodeStats uses (see its doc comment), computed as
  // a byproduct of this same recursive render pass instead of a second
  // full-tree walk, so an always-on per-row badge costs nothing beyond what
  // rendering already does. Only visible (non-hidden) opponent replies
  // count. Each row folds its own children's value (returned by
  // expandWith's/the compact-run row's renderBranch call) in below as it's
  // expanded; the aggregate is this function's return value, read by
  // whichever row owns this table (if any).
  const ourMove = Math.ceil(seq.length / 2);
  const visibleForComplete = Object.keys(counts).filter(opp=>
    !PREFS[prefKey(CURRENT_LINE.id,[...seq,opp])]?.hidden);
  const stopsHere = visibleForComplete.length === 0 ||
    visibleForComplete.some(opp => !PREFS[prefKey(CURRENT_LINE.id,[...seq,opp])]?.reply);
  let completeToMove = stopsHere ? ourMove : Infinity;

  const tbl=document.createElement('table');
  parent.appendChild(tbl);

  const tb=tbl.appendChild(document.createElement('tbody'));

  if(!Object.keys(counts).length){
    /* nested tables get an "Add Opponent Move" item in their owning row's
       three-dot menu instead (wired in that row's expandWith closure); only
       the absolute root table (depth 0, no owning row) needs this fallback */
    if(depth===0) appendAddMoveControl(tb,parent,games,seq,depth,flip);
    return {completeToMove};
  }

  if(!flip && depth===0){
    const ctxTr = document.createElement('tr');
    ctxTr.className = 'context-row';
    ctxTr.innerHTML =
      `<td class="resp"></td>
       <td class="move" style="padding-left:${depth}em">${depth+1}. ${pvChip(seq.at(-1), fenForSeq(seq))}</td>
       <td class="cnt-col"></td>
       <td class="eval-col"></td>
       <td class="name-col"></td>`;
    tb.appendChild(ctxTr);
  }

  const indentLevel = flip ? depth : depth+1;

  if(compactMode){
    const run = computeCompactRun(games,seq,depth,flip);
    if(run){
      const sub = renderCompactRunRow(tb,games,depth,flip,run,indentLevel);
      completeToMove = Math.min(completeToMove, sub.completeToMove);
      if(depth===0) appendAddMoveControl(tb,parent,games,seq,depth,flip);
      return {completeToMove};
    }
  }

  Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([opp,c])=>{
    const isManual = c===0 && manualReplies.includes(opp);
    const tr=document.createElement('tr');
    tr.className = 'data-row';
    tr.dataset.opp = opp;
    // clicking any move in the tree pops up a mini board, same as Compare
    // Games/PV moves -- the delegated .pv-move click handler (pvChip) is generic.
    const oppMoveHtml = pvChip(opp, fenForSeq([...seq,opp]));
    const moveHtml = flip
      ? `${depth+1}. ${oppMoveHtml}<span class="moveQual"></span> <span class="ourReply">...</span>`
      : `${oppMoveHtml}<span class="moveQual"></span> ${depth+2}. <span class="ourReply">...</span>`;
    tr.innerHTML=
      `<td class="resp">
         <button class="iconbtn" title="Analyse"><i class="fa-solid fa-chess-board"></i></button>
         <div class="row-menu-wrap">
           <button class="iconbtn rowMenuBtn" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>
           <div class="row-menu">
             <button type="button" data-act="focus"><i class="fa-solid fa-crosshairs"></i>Focus on this Variation</button>
             <button type="button" data-act="hide"><i class="fa-solid fa-eye-slash"></i>Hide this Variation</button>
             <hr class="row-menu-sep">
             <button type="button" data-act="addToAnalysisQueue"><i class="fa-solid fa-hourglass-half"></i>Add to Analysis Queue</button>
             <button type="button" data-act="analyzeChildren"><i class="fa-solid fa-chess-board"></i>Add Children to Analysis Queue</button>
             <hr class="row-menu-sep">
             <button type="button" data-act="response"><i class="fa-solid fa-check"></i>Set Standard Response</button>
             <button type="button" data-act="addMove"><i class="fa-solid fa-plus"></i>Add Opponent Move</button>
             <button type="button" data-act="removeManual" style="display:none"><i class="fa-solid fa-trash"></i>Remove This Move</button>
             <div class="row-menu-quality" title="Annotate this opponent move (chess quality glyphs)">
               <button type="button" class="row-menu-quality-toggle" data-act="qualityToggle"><i class="fa-solid fa-star-half-stroke"></i>Set Move Quality</button>
               <span class="rmq-strip">
                 <button type="button" class="rmq mq-good" data-q="!" title="good move">!</button>
                 <button type="button" class="rmq mq-good" data-q="!!" title="brilliant move">!!</button>
                 <button type="button" class="rmq mq-interesting" data-q="!?" title="interesting move">!?</button>
                 <button type="button" class="rmq mq-dubious" data-q="?!" title="dubious move">?!</button>
                 <button type="button" class="rmq mq-bad" data-q="?" title="weak move">?</button>
                 <button type="button" class="rmq mq-bad" data-q="??" title="blunder">??</button>
                 <button type="button" class="rmq rmq-clear" data-q="" title="clear annotation">✕</button>
               </span>
             </div>
             <hr class="row-menu-sep">
             <button type="button" data-act="gamesHere"><i class="fa-solid fa-database"></i>Browse Games</button>
             <button type="button" data-act="compareActual"><i class="fa-solid fa-code-compare"></i>Compare Games</button>
             <button type="button" data-act="openingQuiz"><i class="fa-solid fa-graduation-cap"></i>Quiz this Variation</button>
             <hr class="row-menu-sep">
             <button type="button" data-act="generateCastle"><i class="fa-solid fa-dungeon"></i>Preview Palace</button>
             <button type="button" data-act="nodeStats"><i class="fa-solid fa-diagram-project"></i>Node Statistics</button>
             <button type="button" data-act="attributes"><i class="fa-solid fa-sliders"></i>Set Attributes</button>
           </div>
         </div>
       </td>
       <td class="move" style="padding-left:${indentLevel}em">
         <button class="iconbtn toggle toggle-empty"><i class="fa-solid fa-caret-right"></i></button>
         ${moveHtml}
       </td>
       <td class="cnt-col" style="padding-left:${indentLevel}em">
         <span class="cnt">${c} (${tot ? ((c/tot)*100).toFixed(1) : '0.0'}%)</span>
         <span class="completeBadge" style="display:none"></span>
       </td>
       <td class="eval-col">
         <span class="aqQueuedIcon" style="display:none"><i class="fa-solid fa-hourglass-half"></i></span>
         <span class="evaltag" style="display:none"></span>
       </td>
       <td class="name-col">
         <span class="branchName" style="display:none"></span>
         <span class="branchStats" style="display:none"></span>
       </td>`;
    tb.appendChild(tr);

    const metaTr = document.createElement('tr');
    metaTr.className = 'meta-row';
    const metaSpacerTd = document.createElement('td');
    metaSpacerTd.className = 'resp';
    metaTr.appendChild(metaSpacerTd);
    const metaTd = document.createElement('td');
    metaTd.colSpan = 4;
    metaTr.appendChild(metaTd);
    tr.after(metaTr);

    /* element handles */
    const toggleBtn  = tr.querySelector('.toggle');
    const btnEval    = tr.querySelector('td.resp > button.iconbtn');
    const rowMenuBtn = tr.querySelector('.rowMenuBtn');
    const rowMenu    = tr.querySelector('.row-menu');
    const hideBtn    = rowMenu.querySelector('[data-act="hide"]');
    const evalSpan   = tr.querySelector('.evaltag');
    const nameSpan   = tr.querySelector('.branchName');
    const statsSpan  = tr.querySelector('.branchStats');
    const completeSpan = tr.querySelector('.completeBadge');

    const lineSeq = [...seq,opp];
    tr.dataset.seq = lineSeq.join(',');     // stable row identity for focus re-application across rebuilds
    attachHoverPreview(btnEval, lineSeq);
    const currentSaved = () => PREFS[prefKey(CURRENT_LINE.id,lineSeq)];

    /* continuation (PV) line, shown only while toggled open by tapping the
       eval tag; "not available" covers evals saved before PV storage existed */
    let showContinuation = false;
    function continuationHtml(){
      return showContinuation ? evalContinuationHtml(currentSaved(), lineSeq) : '';
    }
    // notes live on the room's CANONICAL seq (see canonicalRoomSeq / openRoomAttributes
    // below) -- they're a room attribute like name/castleName, shared across any
    // transposing path into the same room, not per literal lineSeq like mnemonic/eval.
    // "Compare Games" (saved?.compareGames) is PERSISTED, unlike showContinuation
    // above -- it needs to survive the full-tree rebuild that lands each background
    // analysis result (saveAnalysisQueueResult), so the panel stays open and its
    // eval columns visibly fill in as "Analyze Others" results arrive.
    function refreshMeta(){
      const saved = currentSaved();
      const mnem = saved?.mnemonic || '';
      const note = PREFS[prefKey(CURRENT_LINE.id, canonicalRoomSeq(lineSeq))]?.note || '';
      const pvHtml = continuationHtml();
      const actualHtml = saved?.compareGames ? actualMovesHtml(CURRENT_LINE.id, lineSeq, saved?.reply) : '';
      if(!mnem && !note && !pvHtml && !actualHtml){ metaTr.style.display='none'; return; }
      metaTd.innerHTML =
        (mnem ? `<span class="meta-mnem" title="Edit mnemonic"><i class="fa-solid fa-brain"></i>${escapeHtml(mnem)}</span>` : '') +
        (note ? `<span class="meta-note" title="Edit note (Set Attributes)"><i class="fa-solid fa-pen"></i>${escapeHtml(note)}</span>`       : '') +
        pvHtml + actualHtml;
      metaTr.style.display='';

      const mnemEl = metaTd.querySelector('.meta-mnem');
      if(mnemEl) mnemEl.onclick = () => openFieldModal('mnemonic', currentSaved()?.mnemonic, v=>saveField('mnemonic',v));
      const noteEl = metaTd.querySelector('.meta-note');
      if(noteEl) noteEl.onclick = () => openRoomAttributes();
      const dismissActualBtn = metaTd.querySelector('.meta-actual-dismiss');
      if(dismissActualBtn) dismissActualBtn.onclick = () => { savePrefField(lineSeq, 'compareGames', false); refreshMeta(); };
      const analyzeAllBtn = metaTd.querySelector('.meta-actual-analyze-all');
      if(analyzeAllBtn) analyzeAllBtn.onclick = () => {
        const replyLower = (saved?.reply || '').toLowerCase();
        const others = actualMoveComparison(lineSeq).filter(a => a.move.toLowerCase() !== replyLower).map(a => a.move);
        // the standard reply rides along too -- addToAnalysisQueue's own
        // "already sufficient" check silently skips it if its real tree
        // node already has an eval at least as deep as what's asked for.
        const moves = saved?.reply ? [...others, saved.reply] : others;
        if(moves.length) openCompareAnalyzeModal(CURRENT_LINE.id, lineSeq, moves, refreshMeta);
      };
      const useActualBtn = metaTd.querySelector('.meta-actual-use');
      if(useActualBtn) useActualBtn.onclick = () => { setStandardResponse(useActualBtn.dataset.move); refreshMeta(); };
      wireEvalContinuationMenus(metaTd, lineSeq, currentSaved);
    }
    refreshMeta();
    evalSpan.onclick = () => {
      if(!currentSaved()?.eval) return;
      showContinuation = !showContinuation;
      refreshMeta();
    };
    refreshRowMenuLabels(rowMenu, currentSaved());

    function saveField(field,value){
      savePrefField(lineSeq,field,value);
      refreshMeta();
      refreshHidden();
      refreshRowMenuLabels(rowMenu, currentSaved());
    }

    /* group of rows belonging to this entry: the data row, its meta row,
       and (if expanded) the branch row holding the nested table */
    function getGroupRows(){
      const rows=[tr, metaTr];
      const next = metaTr.nextElementSibling;
      if(next && next.classList.contains('branch-row')) rows.push(next);
      return rows;
    }
    const moveQualEl = tr.querySelector('.moveQual');
    function refreshMoveQuality(){
      const q = currentSaved()?.moveQuality || '';
      moveQualEl.textContent = q;
      moveQualEl.className = 'moveQual' + (q ? ' ' + MOVE_QUALITY_CLASS[q] : '');
      rowMenu.querySelectorAll('.rmq').forEach(b =>
        b.classList.toggle('rmq-active', q !== '' && b.dataset.q === q));
    }
    function refreshHidden(){
      const isHidden = !!currentSaved()?.hidden;
      getGroupRows().forEach(el=>el.classList.toggle('hidden-branch', isHidden));
      hideBtn.innerHTML = isHidden
        ? '<i class="fa-solid fa-eye"></i>Unhide this Variation'
        : '<i class="fa-solid fa-eye-slash"></i>Hide this Variation';
    }

    // room-level attributes live on the room's CANONICAL seq (see canonicalRoomSeq)
    // so a transposing path always reads/writes the same shared data VR itself
    // reads -- everything else on this row (mnemonic, eval, hidden, ...) still
    // keys off lineSeq as usual. Notes are folded in here too, as a room attribute.
    function openRoomAttributes(){
      const roomSeq = canonicalRoomSeq(lineSeq);
      const roomSaved = () => PREFS[prefKey(CURRENT_LINE.id, roomSeq)];
      openAttributesModal(roomSaved(), v=>{
        invalidateBuiltCastlesCache();
        savePrefField(roomSeq, 'isCastleRoot', v.isCastleRoot);
        savePrefField(roomSeq, 'castleName', v.castleName);
        savePrefField(roomSeq, 'castleOwner', v.castleOwner);
        savePrefField(roomSeq, 'castleStreetNumber', v.castleStreetNumber);
        savePrefField(roomSeq, 'name', v.roomName);
        savePrefField(roomSeq, 'note', v.note);
        refreshBranchName(nameSpan, roomSaved());
        refreshMeta();
      }, lineSeq);
    }

    /* expand the branch table under the chosen standard response */
    let childrenSeq = null, branchDiv = null;
    function expandWith(reply, startExpanded=true){
      const old = metaTr.nextSibling;
      if(old?.querySelector?.('.branch')) old.remove();

      const tr1=document.createElement('tr'); tr1.className='branch-row'; metaTr.after(tr1);
      const td1=document.createElement('td'); td1.colSpan=5; td1.style.padding='0'; tr1.appendChild(td1);
      const div=document.createElement('div'); div.className='branch'; td1.appendChild(div);
      childrenSeq = [...lineSeq,reply];
      branchDiv = div;
      const sub = renderBranch(div,games,childrenSeq,depth+1,flip);
      updateCompleteBadge(completeSpan, sub.completeToMove);
      // a hidden row's own badge still reflects its subtree, but it doesn't
      // count toward the OWNING seq's aggregate -- matches visibleForComplete
      // above (and computeNodeStats's visibleOpps) excluding hidden opponents.
      // a hidden row's own badge still reflects its subtree, but it doesn't
      // count toward the OWNING seq's aggregate -- matches visibleForComplete
      // above (and computeNodeStats's visibleOpps) excluding hidden opponents.
      if(!currentSaved()?.hidden) completeToMove = Math.min(completeToMove, sub.completeToMove);
      makeToggle(toggleBtn,tr1,startExpanded,lineSeq);
    }

    function setStandardResponse(reply){
      invalidateBuiltCastlesCache();   // a new/changed reply can add or move a room
      setPref(CURRENT_LINE.id,lineSeq,{reply});
      (PREFS[prefKey(CURRENT_LINE.id,lineSeq)] ??= {key:prefKey(CURRENT_LINE.id,lineSeq),lineId:CURRENT_LINE.id,seq:lineSeq,reply:'',note:'',mnemonic:'',hidden:false}).reply=reply;
      const replySpan = tr.querySelector('.ourReply');
      if(replySpan) replySpan.innerHTML = pvChip(reply, fenForSeq([...lineSeq,reply]));
      expandWith(reply);
      refreshRowMenuLabels(rowMenu, currentSaved());
      refreshBranchStats(statsSpan, games, childrenSeq);
      refreshSystemStats();
      queueChildrenForAnalysis(childrenSeq, branchDiv); // fill in sibling evals via the background analysis queue now that this branch is newly visible
    }

    /* restore reply from the preloaded PREFS map */
    const savedRep = currentSaved()?.reply;
    if(savedRep){
      const replySpan = tr.querySelector('.ourReply');
      if(replySpan) replySpan.innerHTML = pvChip(savedRep, fenForSeq([...lineSeq,savedRep]));
      expandWith(savedRep, !currentSaved()?.collapsed);
    }
    refreshHidden();
    refreshMoveQuality();
    refreshEvalSpan(evalSpan, currentSaved()?.eval, currentSaved()?.evalLines?.length);
    refreshBranchName(nameSpan, currentSaved());
    refreshBranchStats(statsSpan, games, childrenSeq);

    /* "more" menu: set standard response / add note / add mnemonic */
    rowMenuBtn.onclick = e => {
      e.stopPropagation();
      const showing = rowMenu.classList.contains('show');
      closeAllRowMenus();
      if(!showing) rowMenu.classList.add('show');
    };
    rowMenu.querySelector('[data-act="focus"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      focusOnLine(tr, childrenSeq);
    };
    hideBtn.onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      invalidateBuiltCastlesCache();   // hiding/unhiding changes which opponent replies are visible, i.e. which exits/rooms exist
      saveField('hidden', !currentSaved()?.hidden);
      refreshSystemStats();
    };
    rowMenu.querySelector('[data-act="response"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      openFieldModal('response', currentSaved()?.reply, v=>setStandardResponse(v), v=>{
        if(!v) return {ok:false, error:'enter a move'};
        v = canonicalizeMoveCase(v);
        const chess = new Chess(fenForSeq(lineSeq));
        const mv = chess.move(v,{sloppy:true});
        if(!mv) return {ok:false, error:`"${v}" is not a legal move here`};
        return {ok:true, value:mv.san};
      });
    };
    rowMenu.querySelector('[data-act="qualityToggle"]').onclick = e => {
      e.stopPropagation();
      rowMenu.querySelector('.row-menu-quality').classList.toggle('expanded');
    };
    rowMenu.querySelectorAll('.rmq').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        invalidateBuiltCastlesCache();   // baked into the room's move-pair billboard at build time
        savePrefField(lineSeq, 'moveQuality', btn.dataset.q);   // '' clears
        refreshMoveQuality();
        rowMenu.classList.remove('show');
      };
    });
    rowMenu.querySelector('[data-act="analyzeChildren"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      if(branchDiv) queueChildrenForAnalysis(childrenSeq, branchDiv);
    };
    rowMenu.querySelector('[data-act="addToAnalysisQueue"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      openAnalysisQueueAddModal(CURRENT_LINE.id, [lineSeq]);
    };
    rowMenu.querySelector('[data-act="nodeStats"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      if(childrenSeq) showNodeStats(games,childrenSeq);
    };
    rowMenu.querySelector('[data-act="gamesHere"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      showGamesAtNode(lineSeq);
    };
    rowMenu.querySelector('[data-act="compareActual"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      savePrefField(lineSeq, 'compareGames', !currentSaved()?.compareGames);
      refreshMeta();
    };
    rowMenu.querySelector('[data-act="openingQuiz"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      openOpeningQuiz(lineSeq);
    };
    rowMenu.querySelector('[data-act="generateCastle"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      if(childrenSeq) openCastleGenModal(games,childrenSeq);
    };
    rowMenu.querySelector('[data-act="addMove"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      if(!branchDiv) return;
      openFieldModal('addMove', '', v=>{
        addManualReply(childrenSeq,v);
        branchDiv.innerHTML='';
        const sub = renderBranch(branchDiv,games,childrenSeq,depth+1,flip);
        updateCompleteBadge(completeSpan, sub.completeToMove);
      }, v=>{
        if(!v) return {ok:false, error:'enter a move'};
        v = canonicalizeMoveCase(v);
        const chess = new Chess(fenForSeq(childrenSeq));
        const mv = chess.move(v,{sloppy:true});
        if(!mv) return {ok:false, error:`"${v}" is not a legal move here`};
        return {ok:true, value:mv.san};
      });
    };
    rowMenu.querySelector('[data-act="attributes"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      openRoomAttributes();
    };
    const removeManualBtn = rowMenu.querySelector('[data-act="removeManual"]');
    if(isManual){
      removeManualBtn.style.display='';
      removeManualBtn.onclick = e => {
        e.stopPropagation();
        rowMenu.classList.remove('show');
        removeManualReply(seq,opp);
        parent.innerHTML='';
        renderBranch(parent,games,seq,depth,flip);
      };
    }

    btnEval.onclick = () => {
      /* for white systems, the row's text shows the opponent's move plus our
         configured reply (e.g. "Nc6 3. Nf3"), so the board should reflect
         our reply too whenever one's been chosen, not stop one ply short.
         Black systems show the row the other way round (our reply already
         the next row's own move), so leave those keyed on lineSeq alone. */
      const posSeq = !flip && childrenSeq ? childrenSeq : lineSeq;
      const fen = fenForSeq(posSeq);
      markLiveEval(evalSpan, btnEval);
      showPosition(fen,
        (d,score,pv,lines)=>recordEvalIfDeeper(saveField,currentSaved,evalSpan,d,score,fen,pv,lines),
        ()=>clearLiveEval(evalSpan), posSeq);
    };
  });

  if(depth===0) appendAddMoveControl(tb,parent,games,seq,depth,flip);
  return {completeToMove};
}

/* lets the user record an opponent move that hasn't appeared in any imported
   game yet (e.g. a known theoretical try), so it shows up alongside the
   data-driven rows with a 0 count until games actually contain it.
   Appended as a row in the same table as the data rows (rather than a
   separate element) so its move column lines up with theirs — both share
   that table's column widths, regardless of the (empty) resp cell here. */
function appendAddMoveControl(tb,parent,games,seq,depth,flip){
  const tr=document.createElement('tr');
  tr.className='add-move';
  tr.innerHTML=
    `<td class="resp"></td>
     <td class="move" colspan="4" style="padding-left:${depth}em">
       <button class="iconbtn toggle toggle-empty"><i class="fa-solid fa-caret-right"></i></button>
       <button class="iconbtn addMoveBtn" title="Add an opponent response that doesn't occur in your games"><i class="fa-solid fa-plus"></i></button>
     </td>`;
  tb.appendChild(tr);
  tr.querySelector('.addMoveBtn').onclick = () => {
    openFieldModal('addMove', '', v=>{
      addManualReply(seq,v);
      parent.innerHTML='';
      renderBranch(parent,games,seq,depth,flip);
    }, v=>{
      if(!v) return {ok:false, error:'enter a move'};
      v = canonicalizeMoveCase(v);
      const chess = new Chess(fenForSeq(seq));
      const mv = chess.move(v,{sloppy:true});
      if(!mv) return {ok:false, error:`"${v}" is not a legal move here`};
      return {ok:true, value:mv.san};
    });
  };
}

/* ---------- Black-line root row ----------
   For a Black line, White's move 1 (trigger) is fixed by the line itself,
   not data-enumerated. There's nothing to pick from here — we just need to
   set our own standard reply directly. Once set, the regular renderBranch
   (flip=true) takes over from White's move 2 onward, since that's where
   actual data enumeration (White's choices) resumes. */
function renderBlackRoot(parent,games,trigger){
  const tbl=document.createElement('table');
  parent.appendChild(tbl);
  const tb=tbl.appendChild(document.createElement('tbody'));

  const tr=document.createElement('tr');
  tr.className='data-row';
  tr.innerHTML=
    `<td class="resp">
       <button class="iconbtn" title="Analyse"><i class="fa-solid fa-chess-board"></i></button>
       <div class="row-menu-wrap">
         <button class="iconbtn rowMenuBtn" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>
         <div class="row-menu">
           <button type="button" data-act="focus"><i class="fa-solid fa-crosshairs"></i>Focus on this Variation</button>
           <button type="button" data-act="hide"><i class="fa-solid fa-eye-slash"></i>Hide this Variation</button>
           <hr class="row-menu-sep">
           <button type="button" data-act="addToAnalysisQueue"><i class="fa-solid fa-hourglass-half"></i>Add to Analysis Queue</button>
           <button type="button" data-act="analyzeChildren"><i class="fa-solid fa-chess-board"></i>Add Children to Analysis Queue</button>
           <hr class="row-menu-sep">
           <button type="button" data-act="response"><i class="fa-solid fa-check"></i>Set Standard Response</button>
           <button type="button" data-act="addMove"><i class="fa-solid fa-plus"></i>Add Opponent Move</button>
           <hr class="row-menu-sep">
           <button type="button" data-act="gamesHere"><i class="fa-solid fa-database"></i>Browse Games</button>
           <button type="button" data-act="compareActual"><i class="fa-solid fa-code-compare"></i>Compare Games</button>
           <button type="button" data-act="openingQuiz"><i class="fa-solid fa-graduation-cap"></i>Quiz this Variation</button>
           <hr class="row-menu-sep">
           <button type="button" data-act="generateCastle"><i class="fa-solid fa-dungeon"></i>Preview Palace</button>
           <button type="button" data-act="nodeStats"><i class="fa-solid fa-diagram-project"></i>Node Statistics</button>
           <button type="button" data-act="attributes"><i class="fa-solid fa-sliders"></i>Set Attributes</button>
         </div>
       </div>
     </td>
     <td class="move">
       <button class="iconbtn toggle toggle-empty"><i class="fa-solid fa-caret-right"></i></button>
       1. ${pvChip(trigger, fenForSeq([trigger]))} <span class="ourReply">...</span>
     </td>
     <td class="cnt-col"><span class="completeBadge" style="display:none"></span></td>
     <td class="eval-col">
       <span class="aqQueuedIcon" style="display:none"><i class="fa-solid fa-hourglass-half"></i></span>
       <span class="evaltag" style="display:none"></span>
     </td>
     <td class="name-col">
       <span class="branchName" style="display:none"></span>
       <span class="branchStats" style="display:none"></span>
     </td>`;
  tb.appendChild(tr);

  const metaTr = document.createElement('tr');
  metaTr.className = 'meta-row';
  const metaSpacerTd = document.createElement('td');
  metaSpacerTd.className = 'resp';
  metaTr.appendChild(metaSpacerTd);
  const metaTd = document.createElement('td');
  metaTd.colSpan = 4;
  metaTr.appendChild(metaTd);
  tr.after(metaTr);

  const toggleBtn  = tr.querySelector('.toggle');
  const btnEval    = tr.querySelector('td.resp > button.iconbtn');
  const rowMenuBtn = tr.querySelector('.rowMenuBtn');
  const rowMenu    = tr.querySelector('.row-menu');
  const hideBtn    = rowMenu.querySelector('[data-act="hide"]');
  const evalSpan   = tr.querySelector('.evaltag');
  const nameSpan   = tr.querySelector('.branchName');
  const statsSpan  = tr.querySelector('.branchStats');
  const completeSpan = tr.querySelector('.completeBadge');

  const lineSeq = [trigger];
  tr.dataset.seq = lineSeq.join(',');       // stable row identity for focus re-application across rebuilds
  attachHoverPreview(btnEval, lineSeq);
  const currentSaved = () => PREFS[prefKey(CURRENT_LINE.id,lineSeq)];

  let showContinuation = false;
  function continuationHtml(){
    return showContinuation ? evalContinuationHtml(currentSaved(), lineSeq) : '';
  }
  // notes live on the room's CANONICAL seq (see canonicalRoomSeq / openRoomAttributes
  // below) -- they're a room attribute like name/castleName, shared across any
  // transposing path into the same room, not per literal lineSeq like mnemonic/eval.
  // "Compare Games" (saved?.compareGames) is PERSISTED, unlike showContinuation
  // above -- it needs to survive the full-tree rebuild that lands each background
  // analysis result (saveAnalysisQueueResult), so the panel stays open and its
  // eval columns visibly fill in as "Analyze Others" results arrive.
  function refreshMeta(){
    const saved = currentSaved();
    const mnem = saved?.mnemonic || '';
    const note = PREFS[prefKey(CURRENT_LINE.id, canonicalRoomSeq(lineSeq))]?.note || '';
    const pvHtml = continuationHtml();
    const actualHtml = saved?.compareGames ? actualMovesHtml(CURRENT_LINE.id, lineSeq, saved?.reply) : '';
    if(!mnem && !note && !pvHtml && !actualHtml){ metaTr.style.display='none'; return; }
    metaTd.innerHTML =
      (mnem ? `<span class="meta-mnem" title="Edit mnemonic"><i class="fa-solid fa-brain"></i>${escapeHtml(mnem)}</span>` : '') +
      (note ? `<span class="meta-note" title="Edit note (Set Attributes)"><i class="fa-solid fa-pen"></i>${escapeHtml(note)}</span>`       : '') +
      pvHtml + actualHtml;
    metaTr.style.display='';

    const mnemEl = metaTd.querySelector('.meta-mnem');
    if(mnemEl) mnemEl.onclick = () => openFieldModal('mnemonic', currentSaved()?.mnemonic, v=>saveField('mnemonic',v));
    const noteEl = metaTd.querySelector('.meta-note');
    if(noteEl) noteEl.onclick = () => openRoomAttributes();
    const dismissActualBtn = metaTd.querySelector('.meta-actual-dismiss');
    if(dismissActualBtn) dismissActualBtn.onclick = () => { savePrefField(lineSeq, 'compareGames', false); refreshMeta(); };
    const analyzeAllBtn = metaTd.querySelector('.meta-actual-analyze-all');
    if(analyzeAllBtn) analyzeAllBtn.onclick = () => {
      const replyLower = (saved?.reply || '').toLowerCase();
      const others = actualMoveComparison(lineSeq).filter(a => a.move.toLowerCase() !== replyLower).map(a => a.move);
      // the standard reply rides along too -- addToAnalysisQueue's own
      // "already sufficient" check silently skips it if its real tree
      // node already has an eval at least as deep as what's asked for.
      const moves = saved?.reply ? [...others, saved.reply] : others;
      if(moves.length) openCompareAnalyzeModal(CURRENT_LINE.id, lineSeq, moves, refreshMeta);
    };
    const useActualBtn = metaTd.querySelector('.meta-actual-use');
    if(useActualBtn) useActualBtn.onclick = () => { setStandardResponse(useActualBtn.dataset.move); refreshMeta(); };
    wireEvalContinuationMenus(metaTd, lineSeq, currentSaved);
  }
  refreshMeta();
  evalSpan.onclick = () => {
    if(!currentSaved()?.eval) return;
    showContinuation = !showContinuation;
    refreshMeta();
  };
  refreshRowMenuLabels(rowMenu, currentSaved());

  function saveField(field,value){
    savePrefField(lineSeq,field,value);
    refreshMeta();
    refreshHidden();
    refreshRowMenuLabels(rowMenu, currentSaved());
  }

  function getGroupRows(){
    const rows=[tr, metaTr];
    const next = metaTr.nextElementSibling;
    if(next && next.classList.contains('branch-row')) rows.push(next);
    return rows;
  }
  function refreshHidden(){
    const isHidden = !!currentSaved()?.hidden;
    getGroupRows().forEach(el=>el.classList.toggle('hidden-branch', isHidden));
    hideBtn.innerHTML = isHidden
      ? '<i class="fa-solid fa-eye"></i>Unhide this Variation'
      : '<i class="fa-solid fa-eye-slash"></i>Hide this Variation';
  }

  // room-level attributes live on the room's CANONICAL seq (see canonicalRoomSeq)
  // so a transposing path always reads/writes the same shared data VR itself
  // reads -- everything else on this row (mnemonic, eval, hidden, ...) still
  // keys off lineSeq as usual. Notes are folded in here too, as a room attribute.
  function openRoomAttributes(){
    const roomSeq = canonicalRoomSeq(lineSeq);
    const roomSaved = () => PREFS[prefKey(CURRENT_LINE.id, roomSeq)];
    openAttributesModal(roomSaved(), v=>{
      invalidateBuiltCastlesCache();
      savePrefField(roomSeq, 'isCastleRoot', v.isCastleRoot);
      savePrefField(roomSeq, 'castleName', v.castleName);
      savePrefField(roomSeq, 'castleOwner', v.castleOwner);
      savePrefField(roomSeq, 'castleStreetNumber', v.castleStreetNumber);
      savePrefField(roomSeq, 'name', v.roomName);
      savePrefField(roomSeq, 'note', v.note);
      refreshBranchName(nameSpan, roomSaved());
      refreshMeta();
    }, lineSeq);
  }

  let childrenSeq = null, branchDiv = null;
  function expandWith(reply, startExpanded=true){
    const old = metaTr.nextSibling;
    if(old?.querySelector?.('.branch')) old.remove();

    const tr1=document.createElement('tr'); tr1.className='branch-row'; metaTr.after(tr1);
    const td1=document.createElement('td'); td1.colSpan=5; td1.style.padding='0'; tr1.appendChild(td1);
    const div=document.createElement('div'); div.className='branch'; td1.appendChild(div);
    childrenSeq = [...lineSeq,reply];
    branchDiv = div;
    const sub = renderBranch(div,games,childrenSeq,1,true);
    updateCompleteBadge(completeSpan, sub.completeToMove);
    makeToggle(toggleBtn,tr1,startExpanded);
  }

  function setStandardResponse(reply){
    invalidateBuiltCastlesCache();   // a new/changed reply can add or move a room
    setPref(CURRENT_LINE.id,lineSeq,{reply});
    (PREFS[prefKey(CURRENT_LINE.id,lineSeq)] ??= {key:prefKey(CURRENT_LINE.id,lineSeq),lineId:CURRENT_LINE.id,seq:lineSeq,reply:'',note:'',mnemonic:'',hidden:false}).reply=reply;
    const replySpan = tr.querySelector('.ourReply');
    if(replySpan) replySpan.innerHTML = pvChip(reply, fenForSeq([...lineSeq,reply]));
    expandWith(reply);
    refreshRowMenuLabels(rowMenu, currentSaved());
    refreshBranchStats(statsSpan, games, childrenSeq);
    refreshSystemStats();
    queueChildrenForAnalysis(childrenSeq, branchDiv); // fill in sibling evals via the background analysis queue now that this branch is newly visible
  }

  const savedRep = currentSaved()?.reply;
  if(savedRep){
    const replySpan = tr.querySelector('.ourReply');
    if(replySpan) replySpan.innerHTML = pvChip(savedRep, fenForSeq([...lineSeq,savedRep]));
    expandWith(savedRep, !currentSaved()?.collapsed);
  }
  refreshHidden();
  refreshEvalSpan(evalSpan, currentSaved()?.eval, currentSaved()?.evalLines?.length);
  refreshBranchName(nameSpan, currentSaved());
  refreshBranchStats(statsSpan, games, childrenSeq);

  rowMenuBtn.onclick = e => {
    e.stopPropagation();
    const showing = rowMenu.classList.contains('show');
    closeAllRowMenus();
    if(!showing) rowMenu.classList.add('show');
  };
  rowMenu.querySelector('[data-act="focus"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    focusOnLine(tr);
  };
  hideBtn.onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    invalidateBuiltCastlesCache();   // hiding/unhiding changes which opponent replies are visible, i.e. which exits/rooms exist
    saveField('hidden', !currentSaved()?.hidden);
    refreshSystemStats();
  };
  rowMenu.querySelector('[data-act="response"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    openFieldModal('response', currentSaved()?.reply, v=>setStandardResponse(v), v=>{
      if(!v) return {ok:false, error:'enter a move'};
      v = canonicalizeMoveCase(v);
      const chess = new Chess(fenForSeq(lineSeq));
      const mv = chess.move(v,{sloppy:true});
      if(!mv) return {ok:false, error:`"${v}" is not a legal move here`};
      return {ok:true, value:mv.san};
    });
  };
  rowMenu.querySelector('[data-act="analyzeChildren"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    if(branchDiv) queueChildrenForAnalysis(childrenSeq, branchDiv);
  };
  rowMenu.querySelector('[data-act="addToAnalysisQueue"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    openAnalysisQueueAddModal(CURRENT_LINE.id, [lineSeq]);
  };
  rowMenu.querySelector('[data-act="nodeStats"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    if(childrenSeq) showNodeStats(games,childrenSeq);
  };
  rowMenu.querySelector('[data-act="gamesHere"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    showGamesAtNode(lineSeq);
  };
  rowMenu.querySelector('[data-act="compareActual"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    savePrefField(lineSeq, 'compareGames', !currentSaved()?.compareGames);
    refreshMeta();
  };
  rowMenu.querySelector('[data-act="openingQuiz"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    openOpeningQuiz(lineSeq);
  };
  rowMenu.querySelector('[data-act="generateCastle"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    if(childrenSeq) openCastleGenModal(games,childrenSeq);
  };
  rowMenu.querySelector('[data-act="addMove"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    if(!branchDiv) return;
    openFieldModal('addMove', '', v=>{
      addManualReply(childrenSeq,v);
      branchDiv.innerHTML='';
      const sub = renderBranch(branchDiv,games,childrenSeq,1,true);
      updateCompleteBadge(completeSpan, sub.completeToMove);
    }, v=>{
      if(!v) return {ok:false, error:'enter a move'};
      v = canonicalizeMoveCase(v);
      const chess = new Chess(fenForSeq(childrenSeq));
      const mv = chess.move(v,{sloppy:true});
      if(!mv) return {ok:false, error:`"${v}" is not a legal move here`};
      return {ok:true, value:mv.san};
    });
  };
  rowMenu.querySelector('[data-act="attributes"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    openRoomAttributes();
  };

  btnEval.onclick = () => {
    const fen = fenForSeq(lineSeq);
    markLiveEval(evalSpan, btnEval);
    showPosition(fen,
      (d,score,pv,lines)=>recordEvalIfDeeper(saveField,currentSaved,evalSpan,d,score,fen,pv,lines),
      ()=>clearLiveEval(evalSpan), lineSeq);
  };
}

/* ---------- local file import ---------- */
$('fileImport').addEventListener('change', async e=>{
  const f=e.target.files[0];
  if(!f) return;
  const txt=await f.text();
  GAMES = txt.trim().split(/\r?\n/).filter(Boolean)
    .map(l=>{ try{ return JSON.parse(l); }catch{ return null; } })
    .filter(Boolean);
  if(CURRENT_USER) await putGames(CURRENT_USER,GAMES);
  invalidateBuiltCastlesCache();   // a changed game set can change which opponent replies are frequent enough to be visible
  await reindexAfterImport(GAMES);
  clr();
  // renderTreeBody (not openLine) -- this re-renders the ALREADY-open line
  // from the freshly-updated GAMES; openLine would also call clearFocus(),
  // silently discarding whatever variation the user had focused.
  if(CURRENT_LINE) renderTreeBody(CURRENT_LINE);
});

/* ---------- home screen: list of lines ---------- */
async function renderHome(){
  hideBootSpinner();
  $('homeScreen').style.display='';
  $('lineScreen').style.display='none';
  CURRENT_LINE = null;
  clr();

  const list = $('linesList');
  list.innerHTML='';
  if(!CURRENT_USER){
    list.innerHTML = '<p>Import games via the menu &rarr; Import Games, then create an opening system.</p>';
    return;
  }

  const spinner = showSpinner('Loading opening systems…');
  await nextPaint();
  try {
    const lines = await getLines(CURRENT_USER);
    if(!lines.length){
      list.innerHTML = '<p>No opening systems yet &mdash; click + to create one.</p>';
      return;
    }

    lines.sort((a,b)=>a.name.localeCompare(b.name)).forEach(line=>{
      const row = document.createElement('div');
      row.className = 'line-row';
      row.innerHTML =
        `<span class="line-name">${escapeHtml(line.name)}</span>
         <span class="line-color">${escapeHtml(line.color)}</span>
         <span class="line-opening">${escapeHtml(summarizeMoves(line.openingMoves))}</span>
         <button class="iconbtn line-edit" title="Rename"><i class="fa-solid fa-pen"></i></button>
         <button class="iconbtn line-delete" title="Delete"><i class="fa-solid fa-trash"></i></button>`;
      row.onclick = () => openLine(line);
      row.querySelector('.line-edit').onclick = e => {
        e.stopPropagation();
        openFieldModal('lineName', line.name, async v=>{ await updateLine(line.id,{name:v}); renderHome(); });
      };
      row.querySelector('.line-delete').onclick = async e => {
        e.stopPropagation();
        if(!confirm(`Delete opening system "${line.name}"?`)) return;
        await deleteLine(line.id);
        renderHome();
      };
      list.appendChild(row);
    });
  } finally {
    hideSpinner(spinner);
  }
}

/* ---------- line screen: tree + engine for one line ---------- */
/* the street name for an opening's 3D world; falls back to the opening name */
function streetNameForLine(line){
  return (line && line.streetName && line.streetName.trim()) || (line && line.name) || '';
}
/* Map opening-system lines to the shape the VR walker wants, resolving each
   system's OPENING MOVE and its mnemonic image/word for the tile under the
   street sign. The opening move is openingMoves[0]: for a white system that's
   our own first move (e.g. d4); for a black system it's the first opponent move
   in the list we defend against. Image → word → SAN is the display fallback,
   resolved here (in threeVR the raw SAN is drawn until/unless an image loads). */
async function systemsForWalk(lines){
  const mnem = await getAllMnemonics();
  return lines.map(l => {
    const move = (l.openingMoves && l.openingMoves[0]) || '';
    return {
      id: l.id, name: l.name, streetName: streetNameForLine(l), color: l.color,
      openingMove: move,
      openingImg: move ? mnemonicImgForSeq([move], mnem) : '',
      openingWord: move ? mnemonicWordForSeq([move], mnem) : ''
    };
  });
}
function refreshLineStreetName(){
  $('lineStreetName').textContent = CURRENT_LINE ? streetNameForLine(CURRENT_LINE) : '';
}

/* navigates to (and fully loads) an opening system -- always clears any
   focused-variation view, appropriately, since this is a fresh navigation.
   To re-render the line that's ALREADY open after a background write
   (import, download), call renderTreeBody(CURRENT_LINE) directly instead --
   see its own doc comment. */
async function openLine(line){
  CURRENT_LINE = line;
  $('homeScreen').style.display='none';
  $('lineScreen').style.display='';
  $('lineTitle').textContent = `${line.name} (${line.color})`;
  refreshLineStreetName();

  clr();
  clearFocus();
  applyVisibilityMode();
  $('tree').innerHTML='';

  const spinner = showSpinner('Loading opening system…');
  await nextPaint();
  try {
    if(!GAMES && CURRENT_USER){
      GAMES = await getGames(CURRENT_USER);
      if(!GAMES.length) GAMES=null;
    }
    if(!GAMES){
      $('fileImport').click();
      return;
    }

    PREFS = await getAllPrefs(line.id);

    board?.setOrientation(line.color==='black' ? COLOR.black : COLOR.white);

    renderTreeBody(line);
  } finally {
    hideSpinner(spinner);
  }
}

/* (re)builds the move tree for `line` from the already-loaded GAMES/PREFS,
   without re-fetching either — used by openLine on first load, and again
   whenever a toggle (visibility, compact mode) changes which rows the tree
   should show, since GAMES/PREFS are already in memory at that point. Also
   the right call for re-rendering the ALREADY-open line after a background
   write (paste-import, engine-variation import, a local/downloaded game
   import) that already updated GAMES/PREFS in memory itself -- call this
   directly rather than openLine(CURRENT_LINE) for that, since openLine
   also unconditionally clears the focused-variation view, which would
   otherwise discard it for no reason on every one of those refreshes. */
function renderTreeBody(line){
  // wiping the tree orphans the focus DOM, so remember which row was focused and
  // re-apply it to the freshly-built row afterwards (keeps the focused view and
  // the Unfocus button in sync across compact/visibility rebuilds).
  const keepFocusKey = FOCUSED_ROW_KEY, keepFocusSeq = FOCUSED_SEQ;
  clearFocus();

  $('tree').innerHTML='';
  const triggers = line.openingMoves || [];
  if(!triggers.length){
    $('tree').innerHTML = '<p>This opening system has no opening move configured yet.</p>';
    return;
  }
  const lineGames = gamesForLineColor(GAMES, line.color);
  triggers.forEach(mv=>{
    const wrap = document.createElement('div');
    $('tree').appendChild(wrap);
    if(line.color==='black'){
      renderBlackRoot(wrap,lineGames,mv);
    } else {
      renderBranch(wrap,lineGames,[mv],0);
    }
  });
  refreshSystemStats();
  refreshAnalysisQueueRowMarkers();

  if(keepFocusKey) reapplyFocus(keepFocusKey, keepFocusSeq);
}

/* find the rebuilt row matching a saved focus identity and re-focus it. If the
   row no longer exists as a standalone data-row (e.g. it was hoisted into a
   compact run), stay cleanly unfocused — the Unfocus button is already hidden. */
function reapplyFocus(key, seq){
  const row = Array.from($('tree').querySelectorAll('.data-row'))
    .find(r => r.dataset.seq === key);
  if(row) focusOnLine(row, seq);
}

$('backBtn').onclick = renderHome;
$('lineStreetEditBtn').onclick = () => {
  if(!CURRENT_LINE) return;
  openFieldModal('streetName', CURRENT_LINE.streetName || '', async v=>{
    await updateLine(CURRENT_LINE.id, {streetName:v});
    CURRENT_LINE.streetName = v;
    refreshLineStreetName();
  });
};

/* ---------- import variations: bulk-set standard responses from pasted variations ----------
   Parses a full variation of algebraic notation (move numbers, "...", comments,
   result codes, and !/? annotations are all tolerated) and walks it down the
   currently-open opening system's tree, setting each of "our" moves as the
   standard response exactly as if it had been picked manually node by node.
   Opponent moves along the path are also recorded as manual replies so their
   branch row appears (at 0 games / 0%) even where no downloaded game matches. */
function parseAlgebraicMoveList(text){
  const cleaned = text
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d+\.(\.\.)?/g, ' ')
    .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, ' ');
  const tokens = cleaned.split(/\s+/).map(t=>t.replace(/[!?]+$/,'')).filter(Boolean);
  const chess = new Chess();
  const moves = [];
  for(const tok of tokens){
    const mv = chess.move(canonicalizeMoveCase(tok), {sloppy:true});
    if(!mv) throw new Error(`"${tok}" is not a legal move after ${moves.join(' ')||'the starting position'}`);
    moves.push(mv.san);
  }
  return moves;
}

/* imports one already-parsed move list (one variation, i.e. one line of the
   textarea) into the currently open opening system's tree, returning the
   number of "our" moves set. */
async function importParsedLine(moves){
  const color = CURRENT_LINE.color;
  const triggers = CURRENT_LINE.openingMoves || [];
  if(!triggers.includes(moves[0])){
    throw new Error(`this variation is for 1. ${triggers.join(' / ')}, but the pasted variation starts with 1. ${moves[0]}`);
  }

  /* for a White line we enumerate the opponent's reply, so opponent moves sit
     at odd indices (0=our trigger, 1=their reply, 2=our reply, ...); for a
     Black line White moves first, so opponent moves sit at even indices. */
  const oppParity = color==='black' ? 0 : 1;
  let count=0;
  for(let k=oppParity; k<moves.length; k+=2){
    const seq = moves.slice(0,k);
    const opp = moves[k];
    /* k===0 for a Black line is the line's own fixed trigger row, which isn't
       data-enumerated (no counts/manualReplies lookup happens there) */
    if(!(color==='black' && k===0)) await addManualReply(seq,opp);
    if(k+1 < moves.length){
      const lineSeq = [...seq,opp];
      const reply = moves[k+1];
      await savePrefField(lineSeq,'reply',reply);
      // deliberately NOT touching 'collapsed' here (unlike an earlier version
      // of this code, which force-collapsed every step) -- this can run over
      // an EXISTING path the user was already looking at (re-importing, or
      // "Import this variation" from an analysed position's own PV), and
      // stomping its expand/collapse state on every import was jarring. A
      // brand-new node just gets the same default "Set Standard Response"
      // (setStandardResponse) already uses: no explicit collapsed pref, which
      // reads as expanded (see expandWith's !currentSaved()?.collapsed).
      count++;
    }
  }
  return count;
}

async function importLine(text){
  if(!CURRENT_LINE){ $('importLineError').textContent = 'open an opening system first'; return; }
  const rawLines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  if(!rawLines.length){ $('importLineError').textContent = 'paste at least one variation to import'; return; }

  const errors = [];
  let totalCount = 0, importedLines = 0;
  for(let i=0;i<rawLines.length;i++){
    try{
      const moves = parseAlgebraicMoveList(rawLines[i]);
      if(!moves.length) continue;
      totalCount += await importParsedLine(moves);
      importedLines++;
    }catch(err){
      errors.push(rawLines.length>1 ? `variation ${i+1}: ${err.message}` : err.message);
    }
  }

  if(importedLines){
    invalidateBuiltCastlesCache();   // an imported variation writes standard responses, same as setting one by hand
    $('importLineOverlay').style.display='none';
    log(`imported ${totalCount} move(s) from ${importedLines} variation(s) into "${CURRENT_LINE.name}"`
      + (errors.length ? ` (${errors.length} variation(s) skipped, see console)` : ''));
    if(errors.length) console.warn('[importLine] skipped variations:\n' + errors.join('\n'));
    // renderTreeBody (not openLine) -- re-renders the ALREADY-open line from
    // the freshly-imported PREFS (already updated in memory by
    // importParsedLine); openLine would also call clearFocus(), silently
    // discarding whatever variation the user had focused before importing.
    renderTreeBody(CURRENT_LINE);
  } else {
    $('importLineError').textContent = errors.join('\n');
  }
}

$('menuImportLine').onclick = ()=>{
  $('menuList').style.display='none';
  if(!CURRENT_LINE){ log('open an opening system first (from the home screen) to import into it',true); return; }
  $('importLineInput').value='';
  $('importLineError').textContent='';
  $('importLineOverlay').style.display='flex';
  $('importLineInput').focus();
};
$('importLineCancelBtn').onclick = ()=>{ $('importLineOverlay').style.display='none'; };
$('importLineSaveBtn').onclick = ()=> importLine($('importLineInput').value);

/* ---------- search for a line: find an exact path and reveal it ----------
   Paste a move sequence starting from move 1; walks the currently-open
   opening system's data (counts/manualReplies/standard responses) — not the
   DOM, so it works the same whether compact mode is on or off — looking for
   an exact match. On a match, expands every node along the path and focuses
   on the deepest one found (reusing the same focus mechanism as a row's own
   "Focus on this Line" action), which hides every sibling branch. */

/* finds the branch-row that continues rendering after `row` (skipping its
   meta-row, if any) and expands it if currently collapsed. */
function expandRowBranch(row){
  let branchRow = row.nextElementSibling;
  if(branchRow && branchRow.classList.contains('meta-row')) branchRow = branchRow.nextElementSibling;
  if(branchRow && branchRow.classList.contains('branch-row') && branchRow.style.display==='none'){
    const toggle = row.querySelector('.toggle');
    if(toggle) toggle.click();
  }
}

/* the pasted line parsed fine but doesn't actually exist in this opening
   system's data -- as opposed to the input itself being unusable (no system
   open, unparseable text, empty box), which stays inline-only below since
   that's a problem with the search box, not "the variation wasn't found".
   Popped up (not just the small inline text, easy to miss) so it can't be
   mistaken for the tree having silently done something; the tree itself is
   never touched on this path -- every caller returns right after this. */
function reportVariationNotFound(reason){
  $('searchLineError').textContent = reason;
  alert(`Variation not found\n\n${reason}`);
}

async function searchForLine(text){
  if(!CURRENT_LINE){ $('searchLineError').textContent = 'open an opening system first'; return; }
  let moves;
  try{ moves = parseAlgebraicMoveList(text.trim()); }
  catch(err){ $('searchLineError').textContent = err.message; return; }
  if(!moves.length){ $('searchLineError').textContent = 'paste a move sequence to search for'; return; }

  const triggers = CURRENT_LINE.openingMoves || [];
  if(!triggers.includes(moves[0])){
    reportVariationNotFound(
      `this opening system starts with 1. ${triggers.join(' / ')}, but the pasted line starts with 1. ${moves[0]}`);
    return;
  }

  /* walk the data model: opponent moves sit at odd indices for a White line,
     even indices for a Black line (same convention as importParsedLine) */
  const color = CURRENT_LINE.color;
  const oppParity = color==='black' ? 0 : 1;
  const checkpoints = [];
  for(let k=oppParity; k<moves.length; k+=2){
    const seq = moves.slice(0,k);
    const opp = moves[k];
    if(!(color==='black' && k===0)){
      const {counts} = replies(gamesForLineColor(GAMES, color),seq);
      const manual = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
      if(!(opp in counts) && !manual.includes(opp)){
        reportVariationNotFound(`after ${seq.join(' ')||'the start'}, "${opp}" isn't a known reply in this opening system`);
        return;
      }
    }
    const lineSeq = moves.slice(0,k+1);
    checkpoints.push(lineSeq.join(','));
    if(k+1 < moves.length){
      const saved = PREFS[prefKey(CURRENT_LINE.id,lineSeq)];
      const expectedReply = moves[k+1];
      if(!saved?.reply){
        reportVariationNotFound(`no standard response is set after ${lineSeq.join(' ')} yet`);
        return;
      }
      if(saved.reply !== expectedReply){
        reportVariationNotFound(`standard response after ${lineSeq.join(' ')} is "${saved.reply}", not "${expectedReply}"`);
        return;
      }
    }
  }

  /* exact match found in the data — reveal it in the tree */
  $('searchLineOverlay').style.display='none';
  let lastRow = null;
  checkpoints.forEach(seqStr=>{
    const row = $('tree').querySelector(`.data-row[data-seq="${seqStr}"]`);
    if(!row) return; // collapsed into a compact run — nothing to individually expand here
    expandRowBranch(row);
    lastRow = row;
  });

  if(!lastRow){
    log(`found "${moves.join(' ')}" in your data, but compact mode is hiding the whole path inside a collapsed run — toggle compact mode off and search again to focus it`, true);
    return;
  }
  focusOnLine(lastRow);
  log(`found and focused: ${moves.join(' ')}`);
}

$('menuSearchLine').onclick = ()=>{
  $('menuList').style.display='none';
  if(!CURRENT_LINE){ log('open an opening system first (from the home screen) to search it',true); return; }
  $('searchLineInput').value='';
  $('searchLineError').textContent='';
  $('searchLineOverlay').style.display='flex';
  $('searchLineInput').focus();
};
$('searchLineCancelBtn').onclick = ()=>{ $('searchLineOverlay').style.display='none'; };
$('searchLineSaveBtn').onclick = ()=> searchForLine($('searchLineInput').value);
$('menuBrowseGames').onclick = async ()=>{
  $('menuList').style.display='none';
  await openBrowseGames();
  if($('gamesListOverlay').style.display === 'flex') $('gamesListMovesInput').focus();
};

/* ---------- new-line modal ---------- */
/* every legal White first move: 16 pawn pushes + 4 knight moves */
const ALL_FIRST_MOVES = ['a3','a4','b3','b4','c3','c4','d3','d4','e3','e4','f3','f4','g3','g4','h3','h4','Na3','Nc3','Nf3','Nh3'];

function summarizeMoves(moves){
  if(!moves || !moves.length) return '(not set)';
  if(moves.length<=3) return moves.join(', ');
  return `${moves.slice(0,3).join(', ')} (+${moves.length-3} more)`;
}

function updateLineModalFields(){
  const color = $('lineColorInput').value;
  $('lineOpeningField').style.display = color==='white' ? 'inline-flex' : 'none';
  $('lineTriggerModeField').style.display = color==='black' ? 'inline-flex' : 'none';
  $('lineTriggersField').style.display = (color==='black' && $('lineTriggerModeInput').value==='specific') ? 'inline-flex' : 'none';
}
$('lineColorInput').onchange = updateLineModalFields;
$('lineTriggerModeInput').onchange = updateLineModalFields;

$('newLineBtn').onclick = () => {
  $('lineNameInput').value='';
  $('lineColorInput').value='white';
  $('lineOpeningInput').value='';
  $('lineTriggerModeInput').value='specific';
  $('lineTriggersInput').value='';
  updateLineModalFields();
  $('lineModalError').textContent='';
  $('lineOverlay').style.display='flex';
  $('lineNameInput').focus();
};
$('lineCancelBtn').onclick = () => { $('lineOverlay').style.display='none'; };
$('lineSaveBtn').onclick = async () => {
  const name = $('lineNameInput').value.trim();
  const color = $('lineColorInput').value;
  if(!name){ $('lineModalError').textContent='enter a name'; return; }
  if(!CURRENT_USER){ $('lineModalError').textContent='import games first (menu → Import Games)'; return; }

  let openingMoves = [];
  if(color==='white'){
    let mv = canonicalizeMoveCase($('lineOpeningInput').value.trim());
    if(!mv){ $('lineModalError').textContent='enter an opening move'; return; }
    const parsed = new Chess().move(mv,{sloppy:true});
    if(!parsed){ $('lineModalError').textContent=`"${mv}" is not a legal move`; return; }
    openingMoves = [parsed.san];
  } else if($('lineTriggerModeInput').value==='any'){
    openingMoves = ALL_FIRST_MOVES;
  } else {
    const raw = $('lineTriggersInput').value.split(',').map(s=>s.trim()).filter(Boolean);
    if(!raw.length){ $('lineModalError').textContent='enter at least one White move'; return; }
    for(const r of raw){
      const mv = canonicalizeMoveCase(r);
      const parsed = new Chess().move(mv,{sloppy:true});
      if(!parsed){ $('lineModalError').textContent=`"${r}" is not a legal move`; return; }
      openingMoves.push(parsed.san);
    }
  }

  await createLine(CURRENT_USER, {name, color, openingMoves});
  $('lineOverlay').style.display='none';
  renderHome();
};

/* ---------- UI actions ---------- */
$('dlBtn').onclick = async ()=>{
  const source = $('importSourceInput').value;
  const fetchUser = $('userId').value.trim().toLowerCase();
  if(!fetchUser){ logDl('enter a username',true); return; }
  // CURRENT_USER is the stable identity that owns your lines/games in this
  // browser; only bootstrap it from the typed username the first time ever
  // (no identity yet). On later imports — even from a different platform
  // with a different handle — keep the existing identity so games get
  // ADDED to your existing repertoire instead of switching to a new,
  // empty-looking bucket of lines.
  if(!CURRENT_USER) CURRENT_USER = fetchUser;
  localStorage.setItem(LS_SOURCE,source);
  localStorage.setItem(source==='chesscom' ? LS_ID_CHESSCOM : LS_ID, fetchUser);

  try{
    let fetched;
    if(source==='chesscom'){
      const months=+$('monthsBack').value||12;
      localStorage.setItem(LS_MONTHS,months);
      logDl('fetching…');
      fetched = await fetchChessCom(fetchUser,months,
        (n,done,total)=>logDl(`fetching… archive ${done}/${total}, ${n} games so far`));
    } else {
      const max=+$('maxGames').value||300;
      localStorage.setItem(LS_MAX,max);
      logDl('fetching…');
      fetched = await fetchLatest(fetchUser,max,n=>logDl(`fetching… got ${n}`));
    }
    logDl(`fetched ${fetched.length}, writing to database…`);
    await putGames(CURRENT_USER,fetched);
    GAMES = await getGames(CURRENT_USER); // reload the full merged set, not just this batch
    invalidateBuiltCastlesCache();   // a changed game set can change which opponent replies are frequent enough to be visible
    logDl(`imported ${fetched.length}, indexing…`);
    await reindexAfterImport(GAMES, (done,total) => logDl(`indexing… ${done} of ${total}`));
    logDl(`imported ${fetched.length} (${GAMES.length} total)`);
    $('downloadOverlay').style.display='none';
    // renderTreeBody (not openLine) -- re-renders the ALREADY-open line from
    // the freshly-updated GAMES; openLine would also call clearFocus(),
    // silently discarding whatever variation the user had focused.
    if(CURRENT_LINE) renderTreeBody(CURRENT_LINE);
    else await renderHome();
  }catch(e){ console.error('[dlBtn] import failed',e); logDl(e.message,true); }
};

renderHome();

// auto-start the background analysis queue: load whatever's left over from a
// prior session and let it start chugging as soon as the engine is ready (see
// the engine.init().then(...) call below) -- no manual "start" step needed.
refreshAnalysisQueue().then(() => maybeResumeAnalysisQueue());

// offer the default mnemonics bundle when there's nothing in the mnemonics
// store yet (see maybeOfferDefaultMnemonics, defined below). Skipped under
// the test harness, whose dialog handler auto-accepts every confirm() --
// without this guard, any test that boots with an empty mnemonics store
// would silently trigger a real fetch+decompress+import of the (large)
// bundle. The dedicated test for this feature drives it explicitly via
// __mnemDefaultTestHooks instead.
if(!localStorage.getItem('threeTestDebug')) maybeOfferDefaultMnemonics();

/* ---------- hamburger menu ---------- */
function collapseMenuSubs(){
  document.querySelectorAll('#menuList .menu-sub.open').forEach(el=>el.classList.remove('open'));
  document.querySelectorAll('#menuList .menu-parent.open').forEach(el=>el.classList.remove('open'));
}
$('menuBtn').onclick = e=>{
  e.stopPropagation();
  const open = $('menuList').style.display==='flex';
  if(open){ $('menuList').style.display='none'; }
  else { collapseMenuSubs(); $('menuList').style.display='flex'; }   // start with all submenus collapsed
};
// .menu-parent rows expand/collapse their submenu in place instead of running an action
document.querySelectorAll('#menuList .menu-parent').forEach(parent=>{
  parent.onclick = e=>{
    e.stopPropagation();
    const sub = $(parent.dataset.sub);
    const willOpen = !sub.classList.contains('open');
    collapseMenuSubs();                 // accordion: only one submenu open at a time
    if(willOpen){ sub.classList.add('open'); parent.classList.add('open'); }
  };
});
document.addEventListener('click', e=>{
  if(!$('menuList').contains(e.target) && e.target!==$('menuBtn')) $('menuList').style.display='none';
});

/* ---------- import games modal ---------- */
function updateImportFieldsVisibility(){
  const isChesscom = $('importSourceInput').value==='chesscom';
  $('maxGamesField').style.display = isChesscom ? 'none' : 'inline-flex';
  $('monthsBackField').style.display = isChesscom ? 'inline-flex' : 'none';
}
$('importSourceInput').onchange = ()=>{
  const source = $('importSourceInput').value;
  $('userId').value = localStorage.getItem(source==='chesscom' ? LS_ID_CHESSCOM : LS_ID) || '';
  updateImportFieldsVisibility();
};
$('menuDownload').onclick = ()=>{
  $('menuList').style.display='none';
  logDl('');
  const source = localStorage.getItem(LS_SOURCE) || 'lichess';
  $('importSourceInput').value = source;
  $('userId').value = localStorage.getItem(source==='chesscom' ? LS_ID_CHESSCOM : LS_ID) || '';
  $('maxGames').value = localStorage.getItem(LS_MAX) || 300;
  $('monthsBack').value = localStorage.getItem(LS_MONTHS) || 12;
  updateImportFieldsVisibility();
  $('downloadOverlay').style.display='flex';
};
$('downloadCancelBtn').onclick = ()=>{ $('downloadOverlay').style.display='none'; };

/* ---------- gzip helpers for backups ----------
   Backups are dominated by base64 PNG data URLs (VR assets + move images),
   and base64 inflates binary by ~33%. gzip recovers almost all of that (plus
   near-total compression of the JSON keys/whitespace), shrinking a backup by
   ~30% with zero dependencies via the native CompressionStream API.
   Older browsers without CompressionStream fall back to plain JSON.
   (GZIP_OK itself is declared near the top of the file -- maybeOfferDefaultMnemonics
   also reads it, and is called from this module's own top-level boot code
   before this section would otherwise run.) */
async function gzipString(str){
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(stream).blob();
}
async function gunzipToText(blob){
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}
// Read an imported file as text, transparently gunzipping it if it carries the
// gzip magic bytes (0x1f 0x8b). Keeps old plain-.json backups working while
// accepting the new .json.gz ones — sniffed by content, not filename.
async function readMaybeGzipped(file){
  const buf = new Uint8Array(await file.arrayBuffer());
  if(buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b){
    if(!GZIP_OK) throw new Error('this browser cannot read gzipped backups');
    return await gunzipToText(new Blob([buf]));
  }
  return new TextDecoder().decode(buf);
}
// Serialize obj to JSON, gzip it when supported, and trigger a download.
// baseName omits the extension (.json.gz / .json is appended here). Returns
// the resulting byte size for logging.
async function downloadJsonBackup(obj, baseName){
  const json = JSON.stringify(obj);
  let blob, name;
  if(GZIP_OK){ blob = await gzipString(json); name = baseName + '.json.gz'; }
  else { blob = new Blob([json], {type:'application/json'}); name = baseName + '.json'; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
  return blob.size;
}

/* ---------- export / import backup ----------
   This is a *total* backup: everything stored locally (downloaded games,
   repertoire lines/prefs, mnemonics + images, mnemonics notes, and the
   Lichess user id) so that importing it into a brand-new browser/profile
   reproduces the exact prior state with no other setup required.
*/
async function exportBackup(){
  if(!CURRENT_USER){ log('import games first (menu → Import Games)',true); return; }
  const lines = await getLines(CURRENT_USER);
  const mnemonicsBySquare = await getAllMnemonics();
  const games = await getGames(CURRENT_USER);
  const data = {
    version: 6,   // v5 adds threeLayout (VR memory-palace layout); v6 adds objectLists
    user: CURRENT_USER,
    exportedAt: new Date().toISOString(),
    games,
    lines: await Promise.all(lines.map(async line=>({
      id: line.id,   // preserve the line id: VR decoration keys (cas:<instanceId>:…) embed it
      name: line.name, color: line.color, openingMoves: line.openingMoves, streetName: line.streetName || '',
      prefs: Object.values(await getAllPrefs(line.id)).map(p=>({
        seq:p.seq, reply:p.reply, note:p.note, mnemonic:p.mnemonic,
        hidden:p.hidden, manualReplies:p.manualReplies, eval:p.eval, evalLines:p.evalLines, name:p.name,
        collapsed:p.collapsed, moveQuality:p.moveQuality,
        isCastleRoot:p.isCastleRoot, castleName:p.castleName, castleOwner:p.castleOwner,
        castleStreetNumber:p.castleStreetNumber
      }))
    }))),
    mnemonics: Object.values(mnemonicsBySquare).map(entry=>{
      const out = {square: entry.square};
      for(const p of MNEM_PIECES){
        out[p] = entry[p] || '';
        out[p+'Desc'] = entry[p+'Desc'] || '';
        out[p+'Img'] = entry[p+'Img'] || '';
      }
      return out;
    }),
    mnemonicsNotes: await getMeta(MNEM_NOTES_KEY),
    moveDisambiguator: await getMeta(MNEM_DISAMBIG_KEY),
    threeLayout: await getMeta('threeLayout'),   // VR memory-palace layout: object placements, per-building style defaults & presets
    memorizedRooms: await getMeta('threeMemorizedRooms'),   // VR room progress: which rooms are marked memorized
    assets: await getAllAssets(),
    objectLists: await getAllObjectLists()       // ordered mnemonic object lists for castle room walls
  };
  const stamp = new Date().toISOString().slice(0,10);
  const size = await downloadJsonBackup(data, `repchess-backup-${CURRENT_USER}-${stamp}`);
  const mb = (size/1048576).toFixed(1);
  log(`exported ${lines.length} opening system(s), ${games.length} game(s) — ${mb}MB${GZIP_OK ? ' (gzipped)' : ''}`);
}

// test-only generation counter, bumped at the very end of importBackup (see
// below) -- CURRENT_USER/$('userId').value are set very early in the
// function, well before games/lines/mnemonics are actually written, so the
// test harness's seedBackup() polls this instead of userId to avoid racing
// a still-in-flight restore under load.
let _importBackupGen = 0;
if(localStorage.getItem('threeTestDebug')){
  window.__importBackupGen = () => _importBackupGen;
}

/* full restore: wipes every local store first, so the result matches the
   backup exactly rather than merging with (and possibly duplicating)
   whatever is already there. Caller is responsible for confirming with
   the user before calling this, since it is destructive. */
// `onMnemProgress`, if given, is called with the running count of mnemonic
// squares written so far -- restoring hundreds of squares (each its own
// get-then-put IndexedDB round trip) is slow enough that a caller showing a
// spinner wants to update its label, same as buildMnemonicsExportData's own
// onProgress on the export side.
async function importBackup(data, onMnemProgress){
  if(!data || !Array.isArray(data.lines)) throw new Error('not a valid backup file');
  if(!data.user) throw new Error('backup file has no user id');

  await clearAllData();
  // clearAllData wiped the analysisQueue store too -- drop the stale in-memory
  // mirror so a lingering background loop can't keep processing/saving
  // against lineIds this restore just replaced.
  ANALYSIS_QUEUE = [];
  // a restore replaces the whole repertoire (possibly under a different user
  // entirely) without a page reload -- drop the cached VR world-build result
  // so the next "Run VR" rebuilds against the restored data instead of
  // showing whatever was cached from before the restore.
  invalidateBuiltCastlesCache();
  invalidatePositionIndexCache();

  CURRENT_USER = data.user;
  localStorage.setItem(LS_ID, CURRENT_USER);
  $('userId').value = CURRENT_USER;

  if(Array.isArray(data.games) && data.games.length) await putGames(CURRENT_USER, data.games);
  GAMES = data.games || [];

  for(const lineData of data.lines){
    // reuse the original line id when present (older backups omit it) so VR
    // decoration keys that embed it — castle rooms, building facades/signs —
    // still resolve against the restored threeLayout.
    const line = await createLine(CURRENT_USER, {id:lineData.id, name:lineData.name, color:lineData.color, openingMoves:lineData.openingMoves});
    if(lineData.streetName) await updateLine(line.id, {streetName:lineData.streetName});
    for(const pref of (lineData.prefs||[])){
      await setPref(line.id, pref.seq, {
        reply:pref.reply||'', note:pref.note||'', mnemonic:pref.mnemonic||'',
        hidden:pref.hidden||false, manualReplies:pref.manualReplies||[],
        eval:pref.eval||null, evalLines:pref.evalLines||null, name:pref.name||'', collapsed:pref.collapsed||false,
        moveQuality:pref.moveQuality||'',
        isCastleRoot:pref.isCastleRoot||false, castleName:pref.castleName||'', castleOwner:pref.castleOwner||'',
        castleStreetNumber:pref.castleStreetNumber??''
      });
    }
  }
  let mnemCount = 0;
  for(const entry of (data.mnemonics||[])){
    const patch = {};
    for(const p of MNEM_PIECES){
      patch[p] = entry[p] || '';
      patch[p+'Desc'] = entry[p+'Desc'] || '';
      patch[p+'Img'] = entry[p+'Img'] || '';
    }
    await setMnemonicSquare(entry.square, patch);
    onMnemProgress?.(++mnemCount);
  }
  // keep the in-memory mirror in sync with what was just written -- mirrors
  // importMnemonicsBundle/compressAllImages's own refresh, and matters here
  // too since openMnemonicsEditor reads MNEMONICS directly rather than
  // re-fetching (renderMnemonicsGrid always re-fetches on its own, so this
  // is belt-and-suspenders rather than the actual fix for the reported bug
  // -- see the spinner added around this call, which is what actually
  // prevents the menu from being reachable mid-restore).
  MNEMONICS = await getAllMnemonics();
  if(typeof data.mnemonicsNotes === 'string') await setMeta(MNEM_NOTES_KEY, data.mnemonicsNotes);
  if(typeof data.moveDisambiguator === 'string') await setMeta(MNEM_DISAMBIG_KEY, data.moveDisambiguator);
  if(typeof data.threeLayout === 'string') await setMeta('threeLayout', data.threeLayout);
  if(typeof data.memorizedRooms === 'string') await setMeta('threeMemorizedRooms', data.memorizedRooms);
  for(const asset of (data.assets||[])) await setAsset(asset.id, asset);
  for(const list of (data.objectLists||[])) await setObjectList(list.id, list);
  log(`restored ${data.lines.length} opening system(s), ${(data.games||[]).length} game(s)`);
  await renderHome();
  _importBackupGen++;
}

/* A standalone asset bundle (from the asset manager's "Export All as JSON"),
   distinct from a full backup. A full backup carries an opening-systems `lines`
   array; an asset bundle is just the assets, tagged with `repchessAssets`. */
const isAssetBundle = d =>
  !!d && (d.repchessAssets != null || (Array.isArray(d.assets) && !Array.isArray(d.lines)));

/* asset-only REPLACE: clears the asset store and writes the bundle's assets,
   leaving games/lines/mnemonics untouched. Destructive; caller confirms first. */
async function importAssetBundle(data){
  if(!Array.isArray(data.assets)) throw new Error('not a valid asset export file');
  await clearAssets();
  for(const a of data.assets) await setAsset(a.id, a);
  log(`replaced assets — imported ${data.assets.length} asset(s)`);
}

/* ---------- mnemonics-only export / import ----------
   A standalone mnemonics bundle: every per-square word, description and image,
   plus the free-text mnemonics notes. Distinct from a full backup (which also
   carries `lines`/`games`) and from an asset bundle (`repchessAssets`); tagged
   with `repchessMnemonics` so the unified import handler can recognise it. */
// Export-only downscale cap, independent of MNEM_IMG_MAX_DIM (the 512px cap
// applied when an image is saved into local storage). A full 384-image set at
// 512px lands over GitHub's 25MB web-upload limit; shrinking further at
// export time -- without touching the locally-stored originals -- keeps the
// distributed "standard mnemonics" pack under that limit while leaving every
// user's own working copies untouched. Tune this number and re-export to
// compare quality/size (e.g. 450 still clears 25MB with less softening).
const MNEM_EXPORT_IMG_MAX_DIM = 400;
// builds the bundle (with export-downscaled images) without touching local
// storage or triggering a download -- split out so tests can inspect it directly.
// `onProgress`, if given, is called with the running count of images
// converted so far -- re-encoding hundreds of images (decode + canvas +
// WebP) is slow enough that a caller showing a spinner wants to update its
// label rather than sit on a single static message the whole time.
async function buildMnemonicsExportData(onProgress){
  const mnemonicsBySquare = await getAllMnemonics();
  const mnemonics = [];
  let converted = 0;
  for(const entry of Object.values(mnemonicsBySquare)){
    const out = {square: entry.square};
    for(const p of MNEM_PIECES){
      out[p] = entry[p] || '';
      out[p+'Desc'] = entry[p+'Desc'] || '';
      const img = entry[p+'Img'];
      if(img){
        out[p+'Img'] = await downscaleMnemImage(img, MNEM_EXPORT_IMG_MAX_DIM);
        onProgress?.(++converted);
      } else {
        out[p+'Img'] = '';
      }
    }
    mnemonics.push(out);
  }
  return {
    repchessMnemonics: true,
    version: 1,
    exportedAt: new Date().toISOString(),
    mnemonics,
    mnemonicsNotes: await getMeta(MNEM_NOTES_KEY),
    moveDisambiguator: await getMeta(MNEM_DISAMBIG_KEY)
  };
}
async function exportMnemonics(){
  const spinner = showSpinner('Exporting mnemonics…');
  await nextPaint();
  let data;
  try {
    data = await buildMnemonicsExportData(n => {
      $('spinnerLabel').textContent = `Exporting mnemonics… ${n} image${n===1?'':'s'} converted`;
    });
  } finally {
    hideSpinner(spinner);
  }
  const bytes = await downloadJsonBackup(data, `repchess-mnemonics-${new Date().toISOString().slice(0,10)}`);
  const mb = (bytes / 1048576).toFixed(1);
  log(`exported ${data.mnemonics.length} mnemonic square(s) — ${mb}MB (images capped at ${MNEM_EXPORT_IMG_MAX_DIM}px)`);
}

/* assets-only export: same bundle shape the asset manager's "Export All as
   JSON" produces (tagged `repchessAssets` so the unified importer recognises
   it), but callable straight from the hamburger menu without opening the asset
   manager. Reads assets from IndexedDB rather than the manager's in-memory list. */
async function exportAssets(){
  const assets = await getAllAssets();
  if(!assets.length){ log('no assets to export',true); return; }
  const bundle = { repchessAssets: 1, exportedAt: new Date().toISOString(), assets };
  await downloadJsonBackup(bundle, `repchess-assets-${new Date().toISOString().slice(0,10)}`);
  log(`exported ${assets.length} asset(s)`);
}

/* isMnemonicsBundle is declared near the top of the file now -- see the
   comment there (a boot-time TDZ fix).

   mnemonics-only REPLACE: wipes the mnemonics store (and notes) and writes the
   bundle's entries, leaving games/lines/assets untouched. No merge. Destructive;
   caller confirms first. `onProgress`, if given, is called with the running
   count of squares written so far -- same slow-write-loop rationale as
   importBackup's own onMnemProgress. */
async function importMnemonicsBundle(data, onProgress){
  if(!Array.isArray(data.mnemonics)) throw new Error('not a valid mnemonics export file');
  await clearMnemonics();
  let count = 0;
  for(const entry of data.mnemonics){
    const patch = {};
    for(const p of MNEM_PIECES){
      patch[p] = entry[p] || '';
      patch[p+'Desc'] = entry[p+'Desc'] || '';
      patch[p+'Img'] = entry[p+'Img'] || '';
    }
    await setMnemonicSquare(entry.square, patch);
    onProgress?.(++count);
  }
  if(typeof data.mnemonicsNotes === 'string') await setMeta(MNEM_NOTES_KEY, data.mnemonicsNotes);
  if(typeof data.moveDisambiguator === 'string') await setMeta(MNEM_DISAMBIG_KEY, data.moveDisambiguator);
  MNEMONICS = await getAllMnemonics();
  log(`replaced mnemonics — imported ${data.mnemonics.length} square(s)`);
}

/* ---------- default mnemonics bundle (offered on boot) ----------
   json/repchess-mnemonics-DEFAULT.json.gz is a standalone mnemonics bundle
   (same repchessMnemonics shape as an exported bundle) committed to the repo,
   so a brand-new user can start with a ready-made set of memory-palace
   words/images instead of a blank grid. Offered once: the decision (install
   or skip) is remembered in meta so it doesn't nag on every boot after that.
   MNEM_DEFAULT_URL/MNEM_DEFAULT_OFFERED_KEY are declared near the top of the
   file now (a boot-time TDZ fix). */
async function maybeOfferDefaultMnemonics(){
  if(!GZIP_OK) return;   // the bundle is gzipped; can't read it without DecompressionStream
  if(await getMeta(MNEM_DEFAULT_OFFERED_KEY)) return;
  const existing = await getAllMnemonics();
  if(Object.keys(existing).length){ await setMeta(MNEM_DEFAULT_OFFERED_KEY, '1'); return; }

  await setMeta(MNEM_DEFAULT_OFFERED_KEY, '1');
  if(!confirm(
    'INSTALL DEFAULT MNEMONICS?\n\n' +
    'You don\'t have any mnemonics (memory-palace words/images) set up yet. ' +
    'REPchess can install a ready-made set to get you started — you can edit ' +
    'or replace any of it later from Manage Mnemonics.\n\n' +
    'Install the default set now?'
  )) return;

  const spinner = showSpinner('Downloading default mnemonics…');
  await nextPaint();
  try{
    const resp = await fetch(MNEM_DEFAULT_URL);
    if(!resp.ok) throw new Error(`fetch failed (${resp.status})`);
    const text = await gunzipToText(await resp.blob());
    const data = JSON.parse(text);
    if(!isMnemonicsBundle(data)) throw new Error('default mnemonics file is not a valid bundle');
    $('spinnerLabel').textContent = 'Installing default mnemonics…';
    await importMnemonicsBundle(data, n => {
      $('spinnerLabel').textContent = `Installing default mnemonics… ${n} square${n===1?'':'s'}`;
    });
    if($('mnemonicsOverlay').style.display === 'flex'){
      await renderMnemonicsGrid();
      $('mnemonicsNotes').value = await getMeta(MNEM_NOTES_KEY);
    }
    log('installed default mnemonics');
  }catch(err){
    console.error('[default mnemonics] install failed',err);
    log('failed to install default mnemonics: '+err.message,true);
  }finally{
    hideSpinner(spinner);
  }
}

$('menuExport').onclick = ()=>{
  $('menuList').style.display='none';
  exportBackup();
};
$('menuExportMnemonics').onclick = ()=>{
  $('menuList').style.display='none';
  exportMnemonics();
};
$('menuExportAssets').onclick = ()=>{
  $('menuList').style.display='none';
  exportAssets();
};
$('menuImport').onclick = ()=>{
  $('menuList').style.display='none';
  $('backupImport').click();
};
/* estimate a data-URL's stored byte size from its base64 payload length. */
function dataUrlBytes(u){
  if(typeof u !== 'string') return 0;
  const i = u.indexOf(',');
  return i < 0 ? u.length : Math.floor((u.length - i - 1) * 3 / 4);
}

/* Re-encode every stored image (VR assets + per-square move images) to WebP,
   shrinking the backup while preserving transparency. Only replaces an image
   when the WebP is actually smaller, and skips already-WebP images, so it is
   safe to run repeatedly. Non-destructive to any other data. */
async function compressAllImages(){
  if(!webpEncodeSupported()){
    log('this browser cannot encode WebP — nothing to do', true);
    return;
  }
  const assets = await getAllAssets();
  const mnemonics = Object.values(await getAllMnemonics());
  let before = 0, after = 0, changed = 0;
  log('compressing images to WebP…');

  for(const a of assets){
    if(!a.image) continue;
    before += dataUrlBytes(a.image);
    const webp = await toWebpDataUrl(a.image);
    after += dataUrlBytes(webp);
    if(webp !== a.image){ await setAsset(a.id, { ...a, image: webp }); changed++; }
  }
  for(const entry of mnemonics){
    const patch = {};
    for(const p of MNEM_PIECES){
      const img = entry[p+'Img'];
      if(!img) continue;
      before += dataUrlBytes(img);
      const webp = await toWebpDataUrl(img);
      after += dataUrlBytes(webp);
      if(webp !== img){ patch[p+'Img'] = webp; changed++; }
    }
    if(Object.keys(patch).length) await setMnemonicSquare(entry.square, patch);
  }

  MNEMONICS = await getAllMnemonics();
  if(!changed){ log('images already compressed — nothing changed'); return; }
  const saved = ((before - after) / 1048576).toFixed(1);
  const pct = before ? Math.round((1 - after / before) * 100) : 0;
  log(`compressed ${changed} image(s) to WebP — saved ~${saved}MB (${pct}% smaller). Re-export your backup to keep it.`);
}
$('backupImport').addEventListener('change', async e=>{
  const f = e.target.files[0];
  e.target.value = '';
  if(!f) return;

  let data;
  try{ data = JSON.parse(await readMaybeGzipped(f)); }
  catch(err){
    console.error('[import] parse failed',err);
    log('import failed: not a valid backup file',true);
    return;
  }

  // An asset-only export gets a different, asset-scoped replace flow.
  if(isAssetBundle(data)){
    const n = Array.isArray(data.assets) ? data.assets.length : 0;
    if(!confirm(
      'IMPORT ASSETS (REPLACE)?\n\n' +
      `This file contains ${n} asset(s).\n\n` +
      'Importing assets is currently a REPLACE operation: every asset currently ' +
      'stored in this browser will be DELETED and replaced with the assets in this ' +
      'file. (Merge imports are not supported yet.) Your games, opening systems, and ' +
      'mnemonics are not affected.\n\n' +
      'This cannot be undone. Continue?'
    )) return;
    try{
      await importAssetBundle(data);
    }catch(err){
      console.error('[import] asset import failed',err);
      log('asset import failed: '+err.message,true);
    }
    return;
  }

  // A mnemonics-only export gets a mnemonics-scoped replace flow.
  if(isMnemonicsBundle(data)){
    const n = Array.isArray(data.mnemonics) ? data.mnemonics.length : 0;
    if(!confirm(
      'IMPORT MNEMONICS (REPLACE)?\n\n' +
      `This file contains ${n} mnemonic square(s).\n\n` +
      'Importing mnemonics is a REPLACE operation: every mnemonic currently ' +
      'stored in this browser (words, descriptions, images, and notes) will be ' +
      'DELETED and replaced with the contents of this file. (Merge imports are ' +
      'not supported.) Your games, opening systems, and assets are not affected.\n\n' +
      'This cannot be undone. Continue?'
    )) return;
    try{
      await importMnemonicsBundle(data);
      // if the manage-mnemonics screen is open, refresh it in place
      if($('mnemonicsOverlay').style.display === 'flex'){
        await renderMnemonicsGrid();
        $('mnemonicsNotes').value = await getMeta(MNEM_NOTES_KEY);
      }
    }catch(err){
      console.error('[import] mnemonics import failed',err);
      log('mnemonics import failed: '+err.message,true);
    }
    return;
  }

  // An object-list / room-database JSON (the memory_palace_room_database.json
  // shape, a standalone objectLists array, or a bare list array). Merge import:
  // lists are upserted and existing per-item image bindings are preserved, so it
  // is non-destructive to games / opening systems / assets / mnemonics.
  if(isObjectListFile(data)){
    try{
      const res = await importObjectListsData(data);
      if(!res.total){ log('no object lists found in that file', true); return; }
      log(`imported object lists: ${res.added} added, ${res.updated} updated (image bindings preserved)`);
      // if the Manage Object Lists modal is open, refresh it in place
      if($('objectListsOverlay').style.display === 'flex') openObjectListManager($('objectListsBodyWrap'));
    }catch(err){
      console.error('[import] object list import failed',err);
      log('object list import failed: '+err.message,true);
    }
    return;
  }

  // Otherwise treat it as a full backup restore.
  if(!confirm(
    'RESTORE FULL BACKUP?\n\n' +
    'This will permanently DELETE everything currently stored in this browser — ' +
    'all opening systems, notes, mnemonics (including images), and downloaded games — ' +
    'and replace it with the contents of this backup file.\n\n' +
    'Any changes made since this backup was taken WILL BE LOST. This cannot be undone.\n\n' +
    'Continue?'
  )) return;
  const spinner = showSpinner('Restoring backup…');
  await nextPaint();
  try{
    await importBackup(data, n => {
      $('spinnerLabel').textContent = `Restoring backup… ${n} mnemonic square${n===1?'':'s'} imported`;
    });
  }catch(err){
    console.error('[import] failed',err);
    log('import failed: '+err.message,true);
  }finally{
    hideSpinner(spinner);
  }
});

/* ---------- three.js prototype ---------- */
// The walking modal is chromeless — its Close and Assets controls are icon
// buttons overlaid on the canvas (built in threeVR.js); we hand it callbacks
// for those actions rather than wiring header buttons here.
let assetsOpenedFromThreeTest = false;
function openThreeTestAssets(){
  assetsOpenedFromThreeTest = true;
  setForeignModalOpen(true);
  $('assetsOverlay').style.display='flex';
  openAssetManager($('assetsBodyWrap'));
}
/* every BUILT castle across all opening systems (a castle is built once its
   root move has a configured reply — an entry room exists). Returns
   {lineId, castleName, streetNumber, instanceId, genRooms}[] for street layout.

   This rebuild is the dominant cost of opening VR, and it doesn't change
   between opens unless the repertoire itself does -- so the result is
   cached both in memory (for repeat opens within the same page load) and
   persisted to IndexedDB (meta key BUILT_CASTLES_CACHE_KEY, so it also
   survives a browser refresh -- previously the cache was memory-only and
   unconditionally lost on every reload). invalidateBuiltCastlesCache()
   clears both layers together and is called explicitly at every write path
   that can add, move, remove, or relabel a room:
     - setStandardResponse (both copies: renderBranch/renderBlackRoot)
     - importLine (paste-import) and importEngineVariation (the three-dot
       "Import this variation" menu on a saved eval's PV) -- both write
       standard responses via the same importParsedLine
     - addManualReply/removeManualReply (a manual opponent try can open or
       close an exit)
     - the Attributes modal's save (both copies) -- isCastleRoot/castleName/
       castleStreetNumber reshape street layout, and the room name feeds VR
       room labels
     - makeRoomRenamer (the in-VR rename callback -- same room-name field,
       written from inside the walk instead of the move table)
     - hideBtn's toggle (both copies) -- hidden/shown changes which opponent
       replies are visible, i.e. which exits/rooms exist
     - castleGenGoBtn's street-number save -- a second, separate write site
       for castleStreetNumber (the Generate Castle modal), bypassing the
       Attributes modal's own hook
     - the row-menu's move-quality buttons (.rmq) -- baked into the room's
       move-pair billboard data (pairFor's p.opponent.quality) at build
       time, so it's VR-visible even though it isn't structural
     - importing games (local file import, and Lichess/chess.com download)
       -- replies(games,seq)'s move-frequency counts decide which opponent
       tries are visible/built, so a changed game set can add or remove
       exits the same way a manual reply does
     - importBackup's full restore, which can swap in a different user's
       repertoire entirely
   Deliberately still NOT covering every PREFS write -- a note, an engine
   eval, castleOwner (display-only), collapsed (move-table UI state) etc.
   don't change castle structure or anything VR-visible, so they're left
   uncached-through. Mnemonic words/images on VR billboards are read through
   a separate cache that's unconditionally refreshed on every VR open, so
   they were never part of this staleness problem.

   IMPORTANT: because the cache now survives a refresh, a plain browser
   reload is NOT an escape hatch for a write path this list doesn't cover
   (it was, back when the cache was memory-only). The escape hatch is now
   the "Run VR" menu item itself: Shift+click or right-click it to force a
   fresh rebuild (see menuThreeTest's own wiring), which also re-persists
   the fresh result so subsequent opens/reloads pick it up too. */
const BUILT_CASTLES_CACHE_KEY = 'builtCastlesCacheV2';
// v1 (plain 'builtCastlesCache') predates filtering castle/room generation
// down to only the games the user actually played THIS line's own color in
// (see gamesForLineColor) -- a v1 blob would otherwise silently keep serving
// stale door/room counts computed under the old (unfiltered) rule forever,
// since nothing about a code-level rule change trips this cache's own
// write-path invalidation triggers, only a data write does. Renaming the key
// forces a fresh rebuild under the new rule on every user's first VR open
// this build; this one-time, fire-and-forget sweep just tidies up the now-
// abandoned v1 row rather than leaving it to sit in IDB forever unread.
deleteMeta('builtCastlesCache');
let _builtCastlesCache = null;
let _builtCastlesIdbChecked = false;   // have we tried loading the persisted copy yet this page load?
let _builtCastlesBuildCount = 0;       // real (non-cache-hit) builds this page load -- test-only signal
function invalidateBuiltCastlesCache(){
  _builtCastlesCache = null;
  _builtCastlesIdbChecked = true;   // no need to re-check IDB -- we just made the persisted copy stale too
  setMeta(BUILT_CASTLES_CACHE_KEY, '');   // fire-and-forget, same pattern as persistLayout/persistMemorized
  console.log('[VR cache] Cleared');
}
async function gatherBuiltCastles(lines){
  if(_builtCastlesCache){
    console.log('[VR] gatherBuiltCastles: cache hit (memory), 0ms');
    return _builtCastlesCache;
  }
  // the persisted copy is checked at most once per page load -- once we know
  // one way or the other, _builtCastlesCache itself (null or populated) is
  // authoritative and this branch is skipped from then on.
  if(!_builtCastlesIdbChecked){
    _builtCastlesIdbChecked = true;
    try {
      const raw = await getMeta(BUILT_CASTLES_CACHE_KEY);
      if(raw){
        _builtCastlesCache = JSON.parse(raw);
        console.log('[VR] gatherBuiltCastles: cache hit (persisted across reload), 0ms');
        return _builtCastlesCache;
      }
    } catch(e){ console.warn('[VR cache] failed to read the persisted cache, rebuilding', e); }
  }
  const t0 = performance.now();
  if(!GAMES && CURRENT_USER){ GAMES = await getGames(CURRENT_USER); }
  // one prefs swap per line, done concurrently rather than one-line-at-a-time:
  // withLinePrefs's fn is fully synchronous (buildGeneratedCastle never awaits),
  // so the "swap in this line's PREFS, run fn, restore" sequence for each line
  // always completes atomically once its getAllPrefs() resolves — no other
  // line's continuation can interleave in between, so running every line's
  // getAllPrefs() IDB read in parallel instead of serially is safe.
  const perLine = await Promise.all(lines.map(line => withLinePrefs(line, () => {
    const lineGames = gamesForLineColor(GAMES, line.color);
    return definedCastles().map(name => {
      const rootSeq = castleRootRoomSeq(name);
      if(!rootSeq) return null;   // named but not built yet — skip
      let streetNumber = null;
      for(const key in PREFS){
        const p = PREFS[key];
        if(p?.isCastleRoot && p.castleName?.trim() === name){
          const n = parseInt(p.castleStreetNumber, 10);
          if(Number.isFinite(n) && n >= 1){ streetNumber = n; break; }
        }
      }
      // how often this castle's own entry has actually occurred in the
      // user's games -- same "N (M%)" stat as a room's own doors, just
      // computed for the move that leads INTO the castle's root itself
      // (which buildGeneratedCastle's own genRooms never captures, since it
      // starts fresh AT the root with no incoming edge). rootSeq ends in OUR
      // move (the room convention everywhere else); the position right
      // before it is what a game "chose to enter this castle" out of.
      const { counts: entryCounts, tot: entryTot } = replies(lineGames, rootSeq.slice(0, -1));
      const entryOccurrence = formatOccurrence(entryCounts[rootSeq[rootSeq.length - 1]], entryTot);
      return { name, streetNumber, entryOccurrence, genRooms: buildGeneratedCastle(line, lineGames, rootSeq, name).genRooms };
    }).filter(Boolean);
  })));
  const out = [];
  lines.forEach((line, i) => {
    for(const c of perLine[i]){
      out.push({ lineId: line.id, castleName: c.name, streetNumber: c.streetNumber, entryOccurrence: c.entryOccurrence,
                 instanceId: castleInstanceId(line.id, c.name), genRooms: c.genRooms });
    }
  });
  _builtCastlesCache = out;
  _builtCastlesBuildCount++;
  setMeta(BUILT_CASTLES_CACHE_KEY, JSON.stringify(out));   // fire-and-forget: persist across reloads
  console.log(`[VR] gatherBuiltCastles: built ${out.length} castle(s) in ${Math.round(performance.now() - t0)}ms`);
  return out;
}

// Builds and opens the full main VR world (every built castle, one street per
// opening system). Extracted from menuThreeTest's handler (mirrors this
// codebase's oqStartSession precedent) so "Jump to VR" from the room-info
// modal can drive the same flow, landing directly on startRoomKey instead of
// Main Street, when the room wasn't already reachable via jumpToRoom's fast
// path (VR not open yet, or open but missing that room's castle).
// forceRebuild bypasses (and re-persists) the gatherBuiltCastles cache --
// menuThreeTest's own Shift+click/right-click gesture sets it; "Jump to VR"
// never does, so that path stays on the normal cache-aware behavior.
async function openMainVRWorld(startRoomKey, forceRebuild){
  // forceRebuild's spinner text says "Cache cleared" up front, not just
  // "Building world…" -- Shift+click/right-click's whole point is bypassing
  // a stale cache, and the identical spinner text otherwise gave no
  // confirmation the cache was actually cleared rather than just reused.
  const spinner = showSpinner(forceRebuild ? 'Cache cleared — rebuilding…' : 'Building world…');
  let systems = [], castles = [];
  try {
    await nextPaint();
    // feed the walker the opening systems so it can lay out one street per system
    // (white branches right off Main Street, black branches left), plus every
    // built castle so each one appears as a building on its system's street.
    const lines = CURRENT_USER ? await getLines(CURRENT_USER) : [];
    systems = await systemsForWalk(lines);
    if(forceRebuild) invalidateBuiltCastlesCache();
    castles = await gatherBuiltCastles(lines);
  } finally {
    hideSpinner(spinner);
  }
  $('threeTestOverlay').style.display='flex';
  openThreeTest($('threeTestCanvasWrap'), {
    systems,
    castles,
    piecesFile: PIECES_FILE,
    startRoomKey,
    onRoomRename: makeRoomRenamer(buildRoomNameIndex(castles)),
    onClose: ()=>{ $('threeTestOverlay').style.display='none'; closeThreeTest(); },
    onAssets: openThreeTestAssets
  });
}
// Shift+click or right-click forces a fresh rebuild even when a cached world
// (memory or persisted) already exists -- the escape hatch for any
// repertoire edit that isn't one of gatherBuiltCastles's known invalidation
// paths, now that the cache survives a plain browser refresh.
$('menuThreeTest').onclick = async (e)=>{
  $('menuList').style.display='none';
  await openMainVRWorld(undefined, e.shiftKey);
};
$('menuThreeTest').addEventListener('contextmenu', async (e)=>{
  e.preventDefault();
  $('menuList').style.display='none';
  await openMainVRWorld(undefined, true);
});

/* ---------- asset manager ---------- */
$('menuAssets').onclick = ()=>{
  $('menuList').style.display='none';
  assetsOpenedFromThreeTest = false;
  $('assetsOverlay').style.display='flex';
  openAssetManager($('assetsBodyWrap'));
};
$('assetsCloseBtn').onclick = ()=>{
  $('assetsOverlay').style.display='none';
  closeAssetManager();
  if(assetsOpenedFromThreeTest){
    assetsOpenedFromThreeTest = false;
    setForeignModalOpen(false);
    refreshAssetsLive();
  }
};

/* ---------- object list manager ---------- */
$('menuObjectLists').onclick = ()=>{
  $('menuList').style.display='none';
  $('objectListsOverlay').style.display='flex';
  openObjectListManager($('objectListsBodyWrap'));
};
$('objectListsCloseBtn').onclick = ()=>{
  $('objectListsOverlay').style.display='none';
  closeObjectListManager();
};

/* ---------- help modal ----------
   Topics come from help/topics.json: [{id, title, file}, ...]. Each topic's
   `file` is an HTML fragment (not a full document) under help/, fetched and
   injected straight into #helpContent so it inherits the app's own styles.
   See help/README.md for how to add a topic. */
let helpTopicsCache = null;   // fetched once per page load, not per open
async function loadHelpTopics(){
  if(helpTopicsCache) return helpTopicsCache;
  const res = await fetch('help/topics.json');
  if(!res.ok) throw new Error(`topics.json fetch failed (${res.status})`);
  helpTopicsCache = await res.json();
  return helpTopicsCache;
}
async function openHelpTopic(file, btn){
  $('helpTopics').querySelectorAll('.help-topic-btn').forEach(b => b.classList.toggle('active', b === btn));
  const content = $('helpContent');
  try {
    const res = await fetch(`help/${file}`);
    if(!res.ok) throw new Error(`${file} fetch failed (${res.status})`);
    content.innerHTML = await res.text();
  } catch(err){
    console.error('[help] topic load failed', err);
    content.innerHTML = `<p style="color:#c62828">Couldn't load this help topic (${escapeHtml(err.message)}).</p>`;
  }
}
async function openHelpModal(){
  const list = $('helpTopics');
  const content = $('helpContent');
  list.innerHTML = '';
  content.innerHTML = '';
  let topics;
  try {
    topics = await loadHelpTopics();
  } catch(err){
    console.error('[help] topics load failed', err);
    content.innerHTML = `<p style="color:#c62828">Couldn't load the help topic list (${escapeHtml(err.message)}).</p>`;
    $('helpOverlay').style.display = 'flex';
    return;
  }
  list.innerHTML = topics.map(t => `<button type="button" class="help-topic-btn" data-file="${escapeHtml(t.file)}">${escapeHtml(t.title)}</button>`).join('');
  list.querySelectorAll('.help-topic-btn').forEach(btn => {
    btn.onclick = () => openHelpTopic(btn.dataset.file, btn);
  });
  $('helpOverlay').style.display = 'flex';
  const first = list.querySelector('.help-topic-btn');
  if(first) await openHelpTopic(first.dataset.file, first);
}
$('menuHelp').onclick = ()=>{
  $('menuList').style.display='none';
  openHelpModal();
};
$('helpCloseBtn').onclick = ()=>{ $('helpOverlay').style.display='none'; };

/* ---------- about modal ---------- */
$('menuAbout').onclick = ()=>{
  $('menuList').style.display='none';
  $('aboutOverlay').style.display='flex';
};
$('aboutCloseBtn').onclick = ()=>{ $('aboutOverlay').style.display='none'; };

/* ---------- manage mnemonics ---------- */
// MNEM_PIECES/MNEMONICS are declared near the top of the file now (a
// boot-time TDZ fix).
const MNEM_PIECE_ICON = {pawn:'fa-chess-pawn',knight:'fa-chess-knight',bishop:'fa-chess-bishop',rook:'fa-chess-rook',queen:'fa-chess-queen',king:'fa-chess-king'};
let MNEM_EDIT_SQUARE = null;
let MNEM_VIEW_MODE = 'words';   // 'words' = show move words; else a piece name = show that piece's images

function squareName(col,row){ return 'abcdefgh'[col] + (8-row); }

/* ---------- repertoire coverage (which square+piece mnemonics are actually
   used by a given opening system) ----------
   A room's seq ends in OUR move; an edge's seq ends in the OPPONENT's move.
   Together they cover every move that appears anywhere in the line's full
   visible tree, so we feed both through lastMoveInfo() to collect the set of
   "destination square + piece" combos actually played. */
let MNEM_COVERAGE = null; // null = no system selected; else a Set of "sq|pieceField"

/* With no system selected there's no coverage Set to check against -- treat
   that as "every square+piece is needed" (as if a hypothetical system used
   every single move mnemonic) rather than "nothing is needed", so the grid's
   three-state coloring and missing-count doubles as a global completeness
   view of the whole mnemonic vocabulary. Shared by the grid and the
   per-square editor so they stay in sync. */
function mnemNeeded(sq, p){
  return MNEM_COVERAGE ? MNEM_COVERAGE.has(`${sq}|${p}`) : true;
}

/* buildCastleGraph/walk/processExit, definedCastles, and castleRootRoomSeq all
   read the global PREFS map keyed by line.id; PREFS only ever holds the prefs
   of whichever line is currently open in the main tree, which is often NOT the
   line picked in the coverage dropdown. Swap in the given line's prefs for the
   duration of fn(), then restore so the open line's in-memory state isn't
   disturbed. (Sequential use only -- concurrent calls would race on PREFS.) */
async function withLinePrefs(line, fn){
  const isOpenLine = CURRENT_LINE && line.id === CURRENT_LINE.id;
  const savedPrefs = PREFS;
  try {
    if(!isOpenLine) PREFS = await getAllPrefs(line.id);
    return fn();
  } finally {
    if(!isOpenLine) PREFS = savedPrefs;
  }
}
const castlesForLine = line => withLinePrefs(line, definedCastles);
const findCastleRootSeq = (line, castleName) => withLinePrefs(line, () => castleRootRoomSeq(castleName));

/* rootSeq, when given, scopes coverage to a single castle's subtree (leadIn:false
   so the lead-in moves above the castle root aren't counted as "in" the castle,
   matching the generator's own scoping — see buildGeneratedCastle). */
async function computeMnemonicCoverage(line, rootSeq=null){
  if(!GAMES && CURRENT_USER){ GAMES = await getGames(CURRENT_USER); }
  const graph = await withLinePrefs(line, () => buildCastleGraph(line, gamesForLineColor(GAMES, line.color), rootSeq, false));
  const seqs = [...graph.rooms.map(r=>r.seq), ...graph.edges.map(e=>e.seq)];
  const set = new Set();
  for(const seq of seqs){
    if(!seq || !seq.length) continue;
    const info = lastMoveInfo(seq);
    if(!info) continue;
    const pieceField = MNEM_WORD_FOR_PIECE[info.piece];
    if(!pieceField) continue;
    set.add(`${info.to}|${pieceField}`);
  }
  return set;
}

// castle options in the dropdown are addressed by index into this array (not by
// embedding lineId/castleName in the option value) since line ids themselves
// contain colons, which would make any colon-delimited encoding ambiguous.
// Shared by every coverage-style select (Manage Mnemonics, Quiz) since only one
// such select is ever open/read at a time -- each populate call rebuilds this
// array immediately before its own select's options, so the two stay in sync.
let MNEM_CASTLE_OPTIONS = []; // [{lineId, castleName}]

// fills `sel` with one optgroup per opening system, each offering "(whole
// system)" plus "↳ <castle>" for every castle defined under it -- the same
// system/castle breakdown Manage Mnemonics uses, so scoping a quiz or a
// coverage view means the same thing in either place. `noneOptionHtml` is the
// select's leading "nothing chosen" option (wording differs by context).
async function populateCoverageOptgroups(sel, noneOptionHtml){
  const prevValue = sel.value;
  const lines = CURRENT_USER ? await getLines(CURRENT_USER) : [];
  MNEM_CASTLE_OPTIONS = [];
  const groups = [];
  for(const line of lines){
    // sequential (not Promise.all): castlesForLine swaps the shared PREFS map
    const castles = await castlesForLine(line);
    const castleOpts = castles.map(c => {
      const idx = MNEM_CASTLE_OPTIONS.push({ lineId: line.id, castleName: c }) - 1;
      return `<option value="castle:${idx}">↳ ${escapeHtml(c)}</option>`;
    }).join('');
    groups.push(`<optgroup label="${escapeHtml(line.name)}">` +
      `<option value="${escapeHtml(line.id)}">(whole system)</option>` +
      castleOpts +
      `</optgroup>`);
  }
  sel.innerHTML = noneOptionHtml + groups.join('');
  if([...sel.options].some(o=>o.value===prevValue)) sel.value = prevValue;
}
async function populateMnemonicsCoverageSelect(){
  await populateCoverageOptgroups($('mnemonicsCoverageSelect'), '<option value="">(none selected)</option>');
}
// resolves a coverage select's value ("" | lineId | "castle:<idx>") to
// {line, rootSeq, isCastle} (or null for the blank option). isCastle
// distinguishes "whole system" (rootSeq always null, meaning "no subtree
// restriction") from a castle pick whose root simply has no reply yet
// (rootSeq null there means "nothing built" — an empty-coverage case, not
// "cover everything"). Shared by the Manage Mnemonics and Quiz coverage
// handlers so "what does this value mean" only lives in one place.
async function resolveCoverageSelection(val, lines){
  if(!val) return null;
  if(val.startsWith('castle:')){
    const opt = MNEM_CASTLE_OPTIONS[+val.slice('castle:'.length)];
    const line = opt && lines.find(l=>l.id===opt.lineId);
    if(!line) return null;
    const rootSeq = await findCastleRootSeq(line, opt.castleName);
    return { line, rootSeq, isCastle: true, castleName: opt.castleName };
  }
  const line = lines.find(l=>l.id===val);
  return line ? { line, rootSeq: null, isCastle: false } : null;
}
// {line, rootSeq, isCastle} -> the coverage Set (or empty Set for an
// unbuilt castle root) -- the terminal step resolveCoverageSelection feeds into.
function coverageSetFor(sel){
  if(!sel) return null;
  if(sel.isCastle) return sel.rootSeq ? computeMnemonicCoverage(sel.line, sel.rootSeq) : Promise.resolve(new Set());
  return computeMnemonicCoverage(sel.line);
}

async function renderMnemonicsGrid(){
  MNEMONICS = await getAllMnemonics();
  const grid = $('mnemonicsGrid');
  grid.innerHTML='';
  // image-review modes (MNEM_VIEW_MODE = a piece name) show one piece's picture
  // per square; coverage highlighting doesn't apply there.
  const imgMode = MNEM_VIEW_MODE !== 'words';
  let missingWords = 0, missingImages = 0;
  for(let row=0;row<8;row++){
    for(let col=0;col<8;col++){
      const sq = squareName(col,row);
      const isLight = (col+row)%2===0;
      const entry = MNEMONICS[sq] || {};
      let pieceHtml;
      if(imgMode){
        const p = MNEM_VIEW_MODE;
        pieceHtml = entry[p+'Img']
          ? `<img class="mnem-cell-img" src="${entry[p+'Img']}" alt="">`
          : `<div class="mnem-cell-empty"><i class="fa-solid ${MNEM_PIECE_ICON[p]}"></i></div>`;
      } else {
        // three-state coloring: not needed by the selected scope -> black
        // (default, no status class); needed and fully present (word AND
        // image) -> green; needed but missing either one -> red. With no
        // system selected, mnemNeeded() treats every square+piece as needed,
        // so this doubles as a global "what's still missing" view.
        pieceHtml = MNEM_PIECES
          .filter(p=>entry[p] || mnemNeeded(sq,p))
          .map(p=>{
            const occurs = mnemNeeded(sq,p);
            let statusCls = '';
            if(occurs){
              const missingWord = !entry[p], missingImg = !entry[p+'Img'];
              if(missingWord) missingWords++;
              if(missingImg) missingImages++;
              statusCls = (missingWord || missingImg) ? ' mnem-missing' : ' mnem-ok';
            }
            const cls = `mnem-word${statusCls}`;
            return entry[p]
              ? `<div class="${cls}"><i class="fa-solid ${MNEM_PIECE_ICON[p]}"></i>${escapeHtml(entry[p])}${entry[p+'Img']?'':'*'}</div>`
              : `<div class="mnem-icon-only${statusCls}"><i class="fa-solid ${MNEM_PIECE_ICON[p]}"></i>(none)</div>`;
          })
          .join('');
      }
      const div = document.createElement('div');
      div.className = `mnem-square ${isLight?'light':'dark'}${imgMode?' mnem-img-mode':''}`;
      div.dataset.square = sq;
      div.innerHTML =
        (row===7 ? `<span class="mnem-coord-file">${sq[0]}</span>` : '') +
        (col===0 ? `<span class="mnem-coord-rank">${sq[1]}</span>` : '') +
        pieceHtml;
      div.onclick = ()=> openMnemonicsEditor(sq);
      grid.appendChild(div);
    }
  }
  const counts = $('mnemonicsCoverageCounts');
  if(!imgMode){
    const usedCount = MNEM_COVERAGE ? MNEM_COVERAGE.size : 64 * MNEM_PIECES.length;
    counts.innerHTML = `${usedCount} used` +
      (missingWords ? ` · <span class="mc-missing">${missingWords} missing words</span>` : '') +
      (missingImages ? ` · <span class="mc-missing">${missingImages} missing images</span>` : '');
  } else {
    counts.textContent = '';
  }
}

const mnemCap = p => p[0].toUpperCase() + p.slice(1);
const mnemWordInput = p => $(`mnem${mnemCap(p)}Input`);
const mnemDescInput = p => $(`mnem${mnemCap(p)}DescInput`);
const mnemImgDrop = p => $(`mnem${mnemCap(p)}ImgDrop`);
const mnemImgPreview = p => $(`mnem${mnemCap(p)}ImgPreview`);
const mnemImgFile = p => $(`mnem${mnemCap(p)}ImgFile`);

/* images are staged in memory while the editor is open, committed on Save */
const MNEM_EDIT_IMAGES = {};
// full-res upload behind each staged image, kept only for this editor session so
// the Crop button can work from full quality instead of the already-downscaled
// stored copy -- there's no full-res original once a square's image was loaded
// from storage (only the 512px copy was ever saved), so cropping an existing,
// not-freshly-uploaded image just crops that smaller copy.
const MNEM_EDIT_IMAGES_ORIG = {};
const MNEM_IMG_MAX_DIM = 512;       // stored image is downscaled to fit within this box
                                    // (512 keeps the 3D move billboards crisp up close;
                                    //  the 2D grid only ever shows a 66px thumbnail)
const MNEM_IMG_MAX_FILE_BYTES = 8 * 1024 * 1024; // reject absurdly large source files outright

function renderMnemImgDrop(p){
  const drop = mnemImgDrop(p);
  const preview = mnemImgPreview(p);
  const dataUrl = MNEM_EDIT_IMAGES[p];
  if(dataUrl){
    preview.src = dataUrl;
    preview.style.display = '';
    drop.classList.add('has-img');
  } else {
    preview.src = '';
    preview.style.display = 'none';
    drop.classList.remove('has-img');
  }
}

/* downscale a data-URL to fit within MNEM_IMG_MAX_DIM x MNEM_IMG_MAX_DIM (no
   cropping). Images with any transparency are kept as PNG so cut-out
   backgrounds survive (JPEG has no alpha and would flatten transparent pixels
   to black); fully opaque images re-encode as JPEG to keep the stored size
   small. */
function downscaleMnemImage(dataUrl, maxDim){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / img.width, maxDim / img.height);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      let hasAlpha = false;
      try{
        const data = ctx.getImageData(0, 0, w, h).data;
        for(let i = 3; i < data.length; i += 4){ if(data[i] < 255){ hasAlpha = true; break; } }
      }catch(_){ /* tainted canvas — fall back to JPEG */ }
      // WebP keeps transparency and beats both PNG and JPEG; fall back to the
      // old alpha-aware PNG/JPEG split where WebP encoding isn't supported.
      if(webpEncodeSupported()) resolve(canvas.toDataURL('image/webp', 0.85));
      else resolve(hasAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = dataUrl;
  });
}

/* used by bulk import, which has no crop step -- read straight to the stored size */
async function resizeImageFile(file){
  return downscaleMnemImage(await fileToDataUrl(file), MNEM_IMG_MAX_DIM);
}

async function handleMnemImageFile(p, file){
  if(!file) return;
  if(!file.type.startsWith('image/')){ log('that file is not an image',true); return; }
  if(file.size > MNEM_IMG_MAX_FILE_BYTES){ log(`image too large (max ${MNEM_IMG_MAX_FILE_BYTES/1024/1024}MB)`,true); return; }
  try{
    // keep the full-res upload around for this editor session so Crop can work
    // from full quality, then store the downscaled copy as usual
    MNEM_EDIT_IMAGES_ORIG[p] = await fileToDataUrl(file);
    MNEM_EDIT_IMAGES[p] = await downscaleMnemImage(MNEM_EDIT_IMAGES_ORIG[p], MNEM_IMG_MAX_DIM);
    renderMnemImgDrop(p);
  }catch(err){
    console.error('[mnemonics] image resize failed',err);
    log('could not read that image',true);
  }
}

async function handleMnemImageCrop(p){
  const source = MNEM_EDIT_IMAGES_ORIG[p] || MNEM_EDIT_IMAGES[p];
  if(!source) return;
  const cropped = await cropImage(source);
  if(cropped == null) return;   // cancelled
  try{
    MNEM_EDIT_IMAGES_ORIG[p] = cropped;
    MNEM_EDIT_IMAGES[p] = await downscaleMnemImage(cropped, MNEM_IMG_MAX_DIM);
    renderMnemImgDrop(p);
  }catch(err){
    console.error('[mnemonics] crop failed',err);
    log('could not crop that image',true);
  }
}

for(const p of MNEM_PIECES){
  const drop = mnemImgDrop(p);
  drop.addEventListener('click', ()=> mnemImgFile(p).click());
  mnemImgFile(p).addEventListener('change', e=>{
    handleMnemImageFile(p, e.target.files[0]);
    e.target.value = '';
  });
  drop.addEventListener('dragover', e=>{ e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', ()=> drop.classList.remove('dragover'));
  drop.addEventListener('drop', e=>{
    e.preventDefault();
    drop.classList.remove('dragover');
    handleMnemImageFile(p, e.dataTransfer.files[0]);
  });
  drop.querySelector('.mnem-img-clear').addEventListener('click', e=>{
    e.stopPropagation();
    MNEM_EDIT_IMAGES[p] = '';
    MNEM_EDIT_IMAGES_ORIG[p] = '';
    renderMnemImgDrop(p);
  });
  drop.querySelector('.mnem-img-crop').addEventListener('click', e=>{
    e.stopPropagation();
    handleMnemImageCrop(p);
  });
}

/* ---------- bulk import: move images named like Nf6.png / a1.png ---------- */
const MNEM_LETTER_TO_PIECE = {n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'};

// "Nf6.png" -> {square:'f6', piece:'knight'}; "a1.png" (no letter) -> pawn.
// Returns null for anything that doesn't match a piece-letter + square stem.
function parseMoveImageFilename(filename){
  const stem = filename.replace(/\.[^.]+$/, '');
  const m = /^([nbrqk])?([a-h][1-8])$/i.exec(stem);
  if(!m) return null;
  const piece = m[1] ? MNEM_LETTER_TO_PIECE[m[1].toLowerCase()] : 'pawn';
  return { square: m[2].toLowerCase(), piece };
}

function logImportMoveImageRow(text, isError){
  const row = document.createElement('div');
  row.className = isError ? 'err' : 'ok';
  row.textContent = text;
  $('importMoveImagesResults').appendChild(row);
}

async function importMoveImageFiles(files){
  const list = Array.from(files).filter(f => f.type.startsWith('image/'));
  if(!list.length) return;
  for(const file of list){
    const parsed = parseMoveImageFilename(file.name);
    if(!parsed){
      logImportMoveImageRow(`${file.name} — skipped (name doesn't look like a move, e.g. Nf6.png or a1.png)`, true);
      continue;
    }
    if(file.size > MNEM_IMG_MAX_FILE_BYTES){
      logImportMoveImageRow(`${file.name} — skipped (image too large, max ${MNEM_IMG_MAX_FILE_BYTES/1024/1024}MB)`, true);
      continue;
    }
    try{
      const dataUrl = await resizeImageFile(file);
      await setMnemonicSquare(parsed.square, { [parsed.piece+'Img']: dataUrl });
      logImportMoveImageRow(`${file.name} -> ${parsed.square} (${parsed.piece}) ✓`, false);
    }catch(err){
      console.error('[import move images]', file.name, err);
      logImportMoveImageRow(`${file.name} — failed to read image`, true);
    }
  }
}

$('menuImportMoveImages').onclick = ()=>{
  $('menuList').style.display='none';
  $('importMoveImagesResults').innerHTML = '';
  $('importMoveImagesOverlay').style.display='flex';
};
$('importMoveImagesCloseBtn').onclick = ()=>{ $('importMoveImagesOverlay').style.display='none'; };
const importMoveImagesDrop = $('importMoveImagesDrop');
importMoveImagesDrop.addEventListener('click', ()=> $('importMoveImagesFile').click());
$('importMoveImagesFile').addEventListener('change', e=>{
  importMoveImageFiles(e.target.files);
  e.target.value = '';
});
importMoveImagesDrop.addEventListener('dragover', e=>{ e.preventDefault(); importMoveImagesDrop.classList.add('dragover'); });
importMoveImagesDrop.addEventListener('dragleave', ()=> importMoveImagesDrop.classList.remove('dragover'));
importMoveImagesDrop.addEventListener('drop', e=>{
  e.preventDefault();
  importMoveImagesDrop.classList.remove('dragover');
  importMoveImageFiles(e.dataTransfer.files);
});

function mnemPieceIconEl(p){
  return $(`mnem${p[0].toUpperCase()}${p.slice(1)}Icon`);
}

function openMnemonicsEditor(sq){
  MNEM_EDIT_SQUARE = sq;
  const entry = MNEMONICS[sq] || {};
  $('mnemonicsEditorTitle').textContent = `Edit Square ${sq}`;
  for(const p of MNEM_PIECES){
    mnemWordInput(p).value = entry[p] || '';
    mnemDescInput(p).value = entry[p+'Desc'] || '';
    MNEM_EDIT_IMAGES[p] = entry[p+'Img'] || '';
    MNEM_EDIT_IMAGES_ORIG[p] = '';   // no full-res original until a fresh upload this session
    renderMnemImgDrop(p);
    // match the grid's three-state coloring: needed by the selected scope and
    // fully present (word + image) = green, needed but missing either = red,
    // not needed = default gray.
    const needed = mnemNeeded(sq, p);
    const present = !!(entry[p] && entry[p+'Img']);
    const icon = mnemPieceIconEl(p);
    icon.classList.toggle('mnem-icon-needed-ok', needed && present);
    icon.classList.toggle('mnem-icon-needed-missing', needed && !present);
  }
  $('mnemonicsEditorOverlay').style.display='flex';
}

$('menuMnemonics').onclick = async ()=>{
  $('menuList').style.display='none';
  const spinner = showSpinner('Loading mnemonics…');
  try {
    await nextPaint();   // ensure the spinner actually renders before the sync graph walk blocks the thread
    await populateMnemonicsCoverageSelect();
    // default the coverage filter to the opening currently open in the main tree
    // (rather than "(none selected)"), so its coverage is shown without the user
    // having to re-pick and wait for the line they're already viewing.
    const sel = $('mnemonicsCoverageSelect');
    if(CURRENT_LINE && [...sel.options].some(o=>o.value===CURRENT_LINE.id)){
      sel.value = CURRENT_LINE.id;
      MNEM_COVERAGE = await computeMnemonicCoverage(CURRENT_LINE);
    }
    await renderMnemonicsGrid();
    $('mnemonicsNotes').value = await getMeta(MNEM_NOTES_KEY);
    renderDisambigPreview(await getMeta(MNEM_DISAMBIG_KEY));
    $('mnemonicsOverlay').style.display='flex';
  } finally {
    hideSpinner(spinner);
  }
};
$('mnemonicsCloseBtn').onclick = ()=>{ $('mnemonicsOverlay').style.display='none'; };
// view-mode toolbar: ABC (words) or a piece icon (that piece's images per square)
document.querySelectorAll('#mnemModeBar .mnem-mode-btn').forEach(btn=>{
  btn.onclick = ()=>{
    MNEM_VIEW_MODE = btn.dataset.mode;
    document.querySelectorAll('#mnemModeBar .mnem-mode-btn').forEach(b=>b.classList.toggle('active', b===btn));
    renderMnemonicsGrid();
  };
});
$('mnemonicsExportBtn').onclick = ()=> exportMnemonics();
// reuse the shared import file picker; its change handler auto-detects a
// mnemonics bundle and runs the mnemonics-only replace flow.
$('mnemonicsImportBtn').onclick = ()=> $('backupImport').click();
$('mnemonicsCoverageSelect').onchange = async (e)=>{
  const val = e.target.value;
  if(!val){ MNEM_COVERAGE = null; renderMnemonicsGrid(); return; }
  const spinner = showSpinner('Loading opening system…');
  try {
    const lines = await getLines(CURRENT_USER);
    const sel = await resolveCoverageSelection(val, lines);
    MNEM_COVERAGE = await coverageSetFor(sel);
  } finally {
    hideSpinner(spinner);
  }
  renderMnemonicsGrid();
};

/* ---------- mnemonics notes (autosave) ---------- */
// MNEM_NOTES_KEY is declared near the top of the file now (a boot-time TDZ fix).
let mnemNotesSaveTimer = null;
function saveMnemonicsNotes(){
  clearTimeout(mnemNotesSaveTimer);
  setMeta(MNEM_NOTES_KEY, $('mnemonicsNotes').value).then(()=>{
    const saved = $('mnemonicsNotesSaved');
    saved.textContent = 'Saved';
    saved.classList.add('show');
    clearTimeout(saved._hideTimer);
    saved._hideTimer = setTimeout(()=> saved.classList.remove('show'), 1500);
  });
}
$('mnemonicsNotes').addEventListener('input', ()=>{
  clearTimeout(mnemNotesSaveTimer);
  mnemNotesSaveTimer = setTimeout(saveMnemonicsNotes, 800);
});
$('mnemonicsNotes').addEventListener('blur', ()=>{
  clearTimeout(mnemNotesSaveTimer);
  saveMnemonicsNotes();
});

/* ---------- move disambiguator image (one global "older-piece beard") ---------- */
// MNEM_DISAMBIG_KEY is declared near the top of the file now (a boot-time TDZ fix).
function renderDisambigPreview(dataUrl){
  const img = $('mnemDisambigPreview'), drop = $('mnemDisambigDrop');
  if(dataUrl){ img.src = dataUrl; img.style.display=''; drop.classList.add('has-img'); }
  else { img.src=''; img.style.display='none'; drop.classList.remove('has-img'); }
}
async function setDisambigFromFile(file){
  if(!file) return;
  if(!file.type.startsWith('image/')){ log('that file is not an image',true); return; }
  if(file.size > MNEM_IMG_MAX_FILE_BYTES){ log(`image too large (max ${MNEM_IMG_MAX_FILE_BYTES/1024/1024}MB)`,true); return; }
  try{
    const scaled = await downscaleMnemImage(await fileToDataUrl(file), MNEM_IMG_MAX_DIM);
    await setMeta(MNEM_DISAMBIG_KEY, scaled);
    renderDisambigPreview(scaled);
  }catch(err){ console.error('[disambig] image failed',err); log('could not read that image',true); }
}
$('mnemDisambigDrop').addEventListener('click', e=>{
  if(e.target.closest('.mnem-img-clear') || e.target.closest('.mnem-img-crop')) return;
  $('mnemDisambigFile').click();
});
$('mnemDisambigFile').addEventListener('change', e=>{ setDisambigFromFile(e.target.files[0]); e.target.value=''; });
$('mnemDisambigDrop').addEventListener('dragover', e=>{ e.preventDefault(); $('mnemDisambigDrop').classList.add('dragover'); });
$('mnemDisambigDrop').addEventListener('dragleave', ()=> $('mnemDisambigDrop').classList.remove('dragover'));
$('mnemDisambigDrop').addEventListener('drop', e=>{ e.preventDefault(); $('mnemDisambigDrop').classList.remove('dragover'); setDisambigFromFile(e.dataTransfer.files[0]); });
$('mnemDisambigClear').addEventListener('click', async e=>{
  e.stopPropagation();
  await setMeta(MNEM_DISAMBIG_KEY, '');
  renderDisambigPreview('');
});
$('mnemDisambigCrop').addEventListener('click', async e=>{
  e.stopPropagation();
  const cur = await getMeta(MNEM_DISAMBIG_KEY);
  if(!cur) return;
  const cropped = await cropImage(cur);
  if(cropped == null) return;
  const scaled = await downscaleMnemImage(cropped, MNEM_IMG_MAX_DIM);
  await setMeta(MNEM_DISAMBIG_KEY, scaled);
  renderDisambigPreview(scaled);
});

$('mnemonicsEditorCancelBtn').onclick = ()=>{ $('mnemonicsEditorOverlay').style.display='none'; };
$('mnemonicsEditorSaveBtn').onclick = async ()=>{
  const patch = {};
  for(const p of MNEM_PIECES){
    patch[p] = mnemWordInput(p).value.trim();
    patch[p+'Desc'] = mnemDescInput(p).value.trim();
    patch[p+'Img'] = MNEM_EDIT_IMAGES[p] || '';
  }
  await setMnemonicSquare(MNEM_EDIT_SQUARE, patch);
  $('mnemonicsEditorOverlay').style.display='none';
  await renderMnemonicsGrid();
};

/* ---------- quiz mnemonics ---------- */
const QUIZ_DEFAULT_TRIALS = 10;
const MNEM_PIECE_LETTER = {pawn:'',knight:'n',bishop:'b',rook:'r',queen:'q',king:'k'};
let QUIZ = null; // {pool, results, idx, trials, mode, item, expected, startTime, timerInterval}
let QUIZ_FULL_POOL = [];          // every mnemonic entry, rebuilt when the setup screen opens
let QUIZ_CUSTOM = new Set();      // squares picked in the custom 8x8 grid

function buildMnemonicsPool(mnemMap){
  const pool = [];
  for(const sq of Object.keys(mnemMap)){
    const entry = mnemMap[sq];
    for(const p of MNEM_PIECES){
      if(entry[p]) pool.push({square:sq, piece:p, word:entry[p]});
    }
  }
  return pool;
}

/* keep only pool entries whose square matches the chosen scope:
   "all" | "file:<a-h>" | "rank:<1-8>" | "custom" (the picked-square set). */
function filterPoolByScope(pool, scope){
  if(scope === 'all') return pool;
  if(scope === 'custom') return pool.filter(it => QUIZ_CUSTOM.has(it.square));
  const [kind, val] = scope.split(':');
  if(kind === 'file') return pool.filter(it => it.square[0] === val);
  if(kind === 'rank') return pool.filter(it => it.square[1] === val);
  return pool;
}

function quizFormatClock(ms){
  const s = Math.floor(ms/1000);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

function quizTickClock(){
  $('quizClock').textContent = quizFormatClock(Date.now() - QUIZ.startTime);
}

function quizLoadTrial(){
  $('quizInput').value = '';
  $('quizFeedback').innerHTML = '';
  $('quizPromptArea').classList.remove('quiz-correct','quiz-wrong');
  $('quizTrialNum').textContent = `Trial ${QUIZ.idx+1} of ${QUIZ.trials}`;

  const item = QUIZ.pool[Math.floor(Math.random()*QUIZ.pool.length)];
  const mode = Math.random() < 0.5 ? 'word' : 'square';
  QUIZ.item = item;
  QUIZ.mode = mode;

  if(mode === 'word'){
    QUIZ.expected = (MNEM_PIECE_LETTER[item.piece] + item.square).toLowerCase();
    $('quizPrompt').textContent = item.word;
  } else {
    QUIZ.expected = item.word.toLowerCase();
    $('quizPrompt').innerHTML = `<i class="fa-solid ${MNEM_PIECE_ICON[item.piece]}"></i><span class="quiz-square">${escapeHtml(item.square)}</span>`;
  }
  $('quizInput').focus();
}

function quizAdvance(){
  QUIZ.idx++;
  if(QUIZ.idx >= QUIZ.trials) quizFinish();
  else quizLoadTrial();
}

function quizGiveUp(){
  if(!QUIZ || QUIZ.finished) return;
  QUIZ.results.push(false);
  $('quizPromptArea').classList.add('quiz-wrong');
  $('quizFeedback').textContent = `Answer: ${QUIZ.mode==='word' ? QUIZ.item.word : QUIZ.expected}`;
  $('quizInput').disabled = true;
  setTimeout(()=>{ $('quizInput').disabled = false; quizAdvance(); }, 1200);
}

function quizFinish(){
  QUIZ.finished = true;
  clearInterval(QUIZ.timerInterval);
  const elapsed = Date.now() - QUIZ.startTime;
  const correct = QUIZ.results.filter(Boolean).length;
  $('quizPlay').style.display = 'none';
  $('quizSummary').style.display = 'block';
  $('quizScorePct').textContent = `${correct}/${QUIZ.trials} correct (${Math.round(correct/QUIZ.trials*100)}%)`;
  $('quizScoreTime').textContent = `Time: ${quizFormatClock(elapsed)}`;
}

/* builds the clickable 8x8 custom-square grid once (rank 8 at top, like a board
   from White's view); cells toggle membership in QUIZ_CUSTOM. */
function quizBuildCustomGrid(){
  const grid = $('quizCustomGrid');
  grid.innerHTML = '';
  for(let row=0; row<8; row++){
    for(let col=0; col<8; col++){
      const sq = squareName(col, row);   // row 0 = rank 8
      const cell = document.createElement('div');
      cell.className = 'quiz-cell ' + ((row+col)%2===0 ? 'light' : 'dark');
      cell.textContent = sq;
      cell.dataset.sq = sq;
      if(QUIZ_CUSTOM.has(sq)) cell.classList.add('sel');
      cell.onclick = ()=>{
        if(QUIZ_CUSTOM.has(sq)){ QUIZ_CUSTOM.delete(sq); cell.classList.remove('sel'); }
        else { QUIZ_CUSTOM.add(sq); cell.classList.add('sel'); }
        quizUpdateCustomCount();
      };
      grid.appendChild(cell);
    }
  }
  quizUpdateCustomCount();
}
function quizUpdateCustomCount(){
  $('quizCustomCount').textContent = QUIZ_CUSTOM.size ? `${QUIZ_CUSTOM.size} selected` : '';
}

/* show the pre-quiz setup screen (question count + square scope). */
async function quizOpenSetup(){
  $('quizSummary').style.display = 'none';
  $('quizPlay').style.display = 'none';
  QUIZ_FULL_POOL = buildMnemonicsPool(await getAllMnemonics());
  if(QUIZ_FULL_POOL.length === 0){
    $('quizEmpty').style.display = 'block';
    $('quizSetup').style.display = 'none';
    return;
  }
  $('quizEmpty').style.display = 'none';
  $('quizSetupError').textContent = '';
  const custom = $('quizScopeSelect').value === 'custom';
  $('quizCustomWrap').style.display = custom ? 'block' : 'none';
  if(custom) quizBuildCustomGrid();
  await populateQuizCoverageSelect();
  $('quizSetup').style.display = 'block';
}

/* fill the "Restrict items to Opening Coverage" dropdown with the user's
   opening systems, each expandable to its individual castles -- same
   system/castle breakdown as Manage Mnemonics, since a user typically
   memorizes one castle at a time and wants to drill just that one. */
async function populateQuizCoverageSelect(){
  await populateCoverageOptgroups($('quizCoverageSelect'), '<option value="">None: All items quizzed</option>');
}

/* read the setup choices, filter the pool, and begin the trials. */
async function quizStart(){
  const scope = $('quizScopeSelect').value;
  let n = parseInt($('quizNumQuestions').value, 10);
  if(!Number.isFinite(n) || n < 1){ $('quizSetupError').textContent = 'Enter a question count of 1 or more.'; return; }
  let pool = filterPoolByScope(QUIZ_FULL_POOL, scope);
  // optional restriction to the square+piece combos actually played in a chosen
  // opening system or castle (its repertoire coverage).
  const coverageVal = $('quizCoverageSelect').value;
  if(coverageVal){
    const lines = CURRENT_USER ? await getLines(CURRENT_USER) : [];
    const sel = await resolveCoverageSelection(coverageVal, lines);
    const coverage = await coverageSetFor(sel);
    if(coverage) pool = pool.filter(it => coverage.has(`${it.square}|${it.piece}`));
  }
  if(pool.length === 0){
    $('quizSetupError').textContent = coverageVal
      ? 'No mnemonics match that opening’s coverage and square scope. Loosen one of them.'
      : (scope === 'custom'
        ? 'No mnemonics on the selected squares. Pick different squares.'
        : 'No mnemonics on the selected squares.');
    return;
  }
  $('quizSetupError').textContent = '';
  $('quizSetup').style.display = 'none';
  $('quizSummary').style.display = 'none';
  $('quizPlay').style.display = 'block';
  QUIZ = {pool, results:[], idx:0, trials:n, startTime: Date.now(), finished:false};
  QUIZ.timerInterval = setInterval(quizTickClock, 200);
  quizTickClock();
  quizLoadTrial();
}

$('menuQuiz').onclick = ()=>{
  $('menuList').style.display='none';
  $('quizOverlay').style.display='flex';
  quizOpenSetup();
};
$('menuTestChessboard').onclick = ()=>{
  $('menuList').style.display='none';
  openChessboardQuizSetup();
};
$('quizScopeSelect').onchange = ()=>{
  const custom = $('quizScopeSelect').value === 'custom';
  $('quizCustomWrap').style.display = custom ? 'block' : 'none';
  if(custom) quizBuildCustomGrid();
};
$('quizCustomAll').onclick = ()=>{
  for(let row=0; row<8; row++) for(let col=0; col<8; col++) QUIZ_CUSTOM.add(squareName(col,row));
  quizBuildCustomGrid();
};
$('quizCustomNone').onclick = ()=>{ QUIZ_CUSTOM.clear(); quizBuildCustomGrid(); };
$('quizStartBtn').onclick = ()=> quizStart();
$('quizCloseBtn').onclick = ()=>{
  if(QUIZ) clearInterval(QUIZ.timerInterval);
  $('quizOverlay').style.display='none';
};
$('quizDoneBtn').onclick = ()=>{ $('quizOverlay').style.display='none'; };
$('quizAgainBtn').onclick = ()=>{ quizOpenSetup(); };
$('quizGiveUpBtn').onclick = quizGiveUp;

$('quizInput').addEventListener('input', ()=>{
  if(!QUIZ || QUIZ.finished) return;
  const typed = $('quizInput').value.trim().toLowerCase();
  if(QUIZ.expected.startsWith(typed)){
    $('quizPromptArea').classList.remove('quiz-wrong');
    if(typed.length>0 && typed === QUIZ.expected){
      QUIZ.results.push(true);
      $('quizPromptArea').classList.add('quiz-correct');
      $('quizFeedback').innerHTML = '<i class="fa-solid fa-check"></i>';
      $('quizInput').disabled = true;
      setTimeout(()=>{ $('quizInput').disabled = false; quizAdvance(); }, 600);
    }
  } else {
    $('quizPromptArea').classList.add('quiz-wrong');
  }
});

/* ---------- opening quiz ----------
   Play a line forward from a chosen node: the user makes OUR standard response,
   then one of the opponent's replies is picked at random, repeating until the
   tree runs out (no stored response, or no opponent continuations). Each legal
   wrong move scores a miss; each correct move scores a hit. Final score is
   hits/(hits+misses). The opponent's random choices can be replayed verbatim
   ("same choices") or re-rolled ("new choices").

   The starting seq always ends in the OPPONENT's move (our turn to reply) — the
   same `lineSeq` convention every tree row uses. */
let OQ = null;     // {line, color, seq, expected, hits, misses, oppChoices, replay, replayIdx, busy, finished}
let oqBoard = null;

function oqVisibleOpps(seq){
  const {counts} = replies(gamesForLineColor(GAMES || [], OQ.line.color), seq);
  const manual = PREFS[prefKey(OQ.line.id, seq)]?.manualReplies || [];
  manual.forEach(m=>{ if(!(m in counts)) counts[m]=0; });
  return Object.keys(counts).filter(opp => !PREFS[prefKey(OQ.line.id, [...seq, opp])]?.hidden);
}

/* bounds a raw candidate list (opponent replies at seq, or a White line's own
   openingMoves triggers at seq=[]) to what the engine may randomly choose
   from, given a session quiz's coverage scope. Outside session mode, or once
   "(whole system)" coverage is picked (coverageRootSeq null), every candidate
   stays eligible. Scoped to one castle, there is only ever one move that
   stays on the path to its exact root sequence -- so before the walk reaches
   that sequence, eligibility collapses to that single forced move (still
   something the user has to find and play, same as any other move); normal
   branching resumes once inside the castle's own subtree. */
function oqCoverageEligible(seq, candidates){
  const root = OQ.coverageRootSeq;
  if(!root || seq.length >= root.length) return candidates;
  const forced = root[seq.length];
  return candidates.includes(forced) ? [forced] : [];
}

/* "only test memorized rooms" (VR toolbar toggle, see js/threeVR.js) support.
   There's no single place "our reply" is chosen from a candidate list -- it's
   always the deterministic PREFS[...].reply lookup in oqLoadStep. What IS
   chosen from a candidate list is which opponent branch to walk down next, at
   the three call sites that already wrap oqCoverageEligible -- so that's
   where this filters too. */

/* the room seq (ends in OUR move) that answering `candidate` from `seq`
   would complete, or null if that reply isn't taught yet (nothing to check
   memorized-status against). Two shapes, both driven by real call sites:
   - seq=[] and OQ.color isn't 'black': `candidate` IS our own first move
     (oqLoadStep's white-trigger branch) -- the room itself.
   - otherwise `candidate` is the OPPONENT's move; our reply is the
     deterministic PREFS lookup (oqPlayTrigger's black-trigger branch, and
     oqAfterCorrect's every-other-step branch both have this shape). */
function oqCandidateRoomSeq(seq, candidate){
  if(seq.length === 0 && OQ.color !== 'black') return [candidate];
  const reply = PREFS[prefKey(OQ.line.id, [...seq, candidate])]?.reply;
  return reply ? [...seq, candidate, reply] : null;
}
function oqRoomMemorized(roomSeq){
  // OQ.line.id, not CURRENT_LINE.id -- PREFS holds OQ.line's data for the
  // session's duration (a quiz can run against a line other than whatever's
  // open in the tree view), and inheritedCastle's PREFS lookups must match.
  const castle = OQ.castleName || inheritedCastle(roomSeq, OQ.line.id);
  if(!castle) return false;
  const key = castleRoomKey(castleInstanceId(OQ.line.id, castle), positionKey(fenForSeq(roomSeq)));
  return !!OQ.memorizedRooms[key];
}
function oqMemorizedFilter(seq, candidates){
  if(!OQ.onlyMemorized) return candidates;
  // castle-scoped session, still short of the castle's own root: every
  // candidate here is already forced down to one deterministic move by
  // oqCoverageEligible (there's no other way to reach the castle), so never
  // gate it by memorized status -- these lead-in rooms genuinely belong to
  // whatever castle/line came before this one (oqRoomMemorized's
  // OQ.castleName shortcut would wrongly check THIS castle's key instead),
  // some aren't independently markable rooms at all (the very first ply has
  // no room yet), and the user should still be tested on them regardless of
  // memorized status -- it's the same game, played in full, every time.
  // Only once seq reaches the root does memorized-gating (the whole point of
  // this feature) actually apply, and OQ.castleName is correct again there.
  const root = OQ.coverageRootSeq;
  if(root && seq.length < root.length) return candidates;
  if(seq.length === 0){
    // no room reached yet -- whole-system coverage's very first move (no
    // castle scope to force a lead-in through), or a black line's forced
    // opening trigger (oqPlayTrigger). There's nothing "current" to check
    // yet, so this is necessarily a lookahead: does choosing this candidate
    // land somewhere memorized?
    return candidates.filter(c => { const rs = oqCandidateRoomSeq(seq, c); return rs && oqRoomMemorized(rs); });
  }
  // `seq` is a room already reached (ends in OUR move) -- test every branch
  // out of it as long as THIS room itself is memorized (that's the room
  // whose content -- move pairs, mnemonics -- the memorized flag actually
  // represents). A branch whose own resulting room ISN'T memorized still
  // gets asked here (you're being tested FROM a room you know); it simply
  // won't continue past it -- the next oqAfterCorrect call for that deeper
  // seq finds it unmemorized and returns no candidates, ending the question
  // right there. Previously this looked ahead per-candidate instead (like
  // the seq.length===0 case above), which silently hid every branch except
  // the one leading to an already-memorized room -- so a room with several
  // taught replies only ever got quizzed on whichever ONE happened to lead
  // somewhere memorized, and a memorized room's OWN further branches never
  // got asked at all once you'd just arrived in it.
  return oqRoomMemorized(seq) ? candidates : [];
}

/* the engine's random pick from `candidates`, honoring a same-choices replay
   (OQ.replay) -- shared by every point where the engine (not the user)
   decides a move: the opponent's replies throughout, and (session mode only)
   a White line's own first move when a fresh question starts. */
function oqPickChoice(candidates){
  let choice;
  if(OQ.replay && OQ.replayIdx < OQ.oppChoices.length && candidates.includes(OQ.oppChoices[OQ.replayIdx])){
    choice = OQ.oppChoices[OQ.replayIdx];
  } else {
    choice = candidates[Math.floor(Math.random()*candidates.length)];
    OQ.oppChoices[OQ.replayIdx] = choice;
  }
  OQ.replayIdx++;
  return choice;
}

function oqEnsureBoard(){
  if(oqBoard) return;
  oqBoard = new Chessboard($('oqBoard'), {
    position: new Chess().fen(),
    orientation: COLOR.white,
    animationDuration: 375,   // ~25% slower than the 300ms default
    style: { pieces: { file: PIECES_FILE } }
  });
}

/* ---- square-highlight overlay ----
   borderType is 'none', so the 8x8 grid fills the board edge-to-edge and a
   square maps to a simple 12.5% cell. We overlay our own outline divs (rather
   than the marker sprite, whose colors are baked in) so FROM/TO can be tinted
   exactly: gray FROM, olive-green TO, for both the opponent's move and ours. */
function oqSquarePct(sq){
  const file = sq.charCodeAt(0) - 97;     // a..h -> 0..7
  const rank = +sq[1];                    // 1..8
  const col = OQ.color === 'black' ? 7 - file : file;
  const row = OQ.color === 'black' ? rank - 1 : 8 - rank;
  return { left: col * 12.5, top: row * 12.5 };
}
function oqClearHighlights(){
  $('oqBoardWrap').querySelectorAll('.oq-hl').forEach(el => el.remove());
}
function oqHighlight(sq, kind){   // kind: 'from' (gray) | 'to' (olive)
  const {left, top} = oqSquarePct(sq);
  const div = document.createElement('div');
  div.className = `oq-hl oq-hl-${kind}`;
  div.style.left = left + '%';
  div.style.top = top + '%';
  $('oqBoardWrap').appendChild(div);
}
/* from/to squares of the last move in `seq` (used to mark the opponent's move) */
function oqMoveSquares(seq){
  if(!seq.length) return null;
  const chess = new Chess(fenForSeq(seq.slice(0, -1)));
  const mv = chess.move(seq.at(-1), { sloppy:true });
  return mv ? { from: mv.from, to: mv.to } : null;
}
function oqMarkOpponentMove(seq){
  oqClearHighlights();
  const sq = oqMoveSquares(seq);
  if(sq){ oqHighlight(sq.from, 'from'); oqHighlight(sq.to, 'to'); }
}

function oqUpdateScore(){
  $('oqHits').textContent = `Hits ${OQ.hits}`;
  $('oqMisses').textContent = `Misses ${OQ.misses}`;
}
function oqSetStatus(text, cls){
  const el = $('oqStatus');
  el.textContent = text;
  el.className = cls || '';
}

// the PGN move number the ply about to be played belongs to, given how many
// plies have already been played (0 -> 1, 1 -> 1, 2 -> 2, 3 -> 2, ...).
function oqNextMoveNumber(playedPlies){ return Math.ceil((playedPlies + 1) / 2); }

/* advance OQ.seq to the next node where it is our turn, then arm the board for
   input. If there's no stored response, the tree has ended → finish.

   Session mode only: OQ.seq starts at [] (the real game start, not a tree
   node), so ply 0 has no PREFS entry to look up -- it's either our own
   line's first move (tested, sourced from openingMoves instead of PREFS) or
   the opponent's forced first move (auto-played, never something the user
   plays, same as every other opponent move -- see oqPlayTrigger). Session
   mode also enforces Max Depth: once the move we're about to ask for would
   exceed it, stop here instead of prompting for another. */
function oqLoadStep(){
  if(OQ.mode === 'session' && OQ.maxDepth != null){
    if(oqNextMoveNumber(OQ.seq.length) > OQ.maxDepth){ oqFinish(); return; }
  }
  if(OQ.mode === 'session' && OQ.seq.length === 0){
    if(OQ.color === 'black'){ oqPlayTrigger(); return; }
    const triggers = oqMemorizedFilter([], oqCoverageEligible([], OQ.line.openingMoves || []));
    if(!triggers.length){ oqFinish(); return; }
    OQ.expected = oqPickChoice(triggers);
    OQ.busy = false;
    oqClearHighlights();
    oqBoard.setPosition(fenForSeq([]), true);
    oqSetStatus('Your move');
    return;
  }
  const expected = PREFS[prefKey(OQ.line.id, OQ.seq)]?.reply;
  if(!expected){ oqFinish(); return; }
  OQ.expected = expected;
  OQ.busy = false;
  oqBoard.setPosition(fenForSeq(OQ.seq), true);
  oqSetStatus('Your move');
}

/* session mode only: a Black-color line's board always starts at the true
   game start, so ply 1 is White's forced first move -- something the engine
   plays for you (same as any opponent move), never something you're tested
   on. Mirrors oqAfterCorrect's play-then-pause-then-advance choreography. */
function oqPlayTrigger(){
  const triggers = oqMemorizedFilter([], oqCoverageEligible([], OQ.line.openingMoves || []));
  if(!triggers.length){ oqFinish(); return; }
  const trigger = oqPickChoice(triggers);
  const nextSeq = [trigger];
  oqClearHighlights();
  oqBoard.setPosition(fenForSeq([]), true);
  setTimeout(()=>{
    oqMarkOpponentMove(nextSeq);
    oqBoard.setPosition(fenForSeq(nextSeq), true);
    OQ.seq = nextSeq;
    setTimeout(oqLoadStep, 500);
  }, 500);
}

/* cm-chessboard move-input callback: validate the dragged move against the
   expected standard response. */
function oqInputHandler(event){
  if(event.type === INPUT_EVENT_TYPE.moveInputStarted){
    if(OQ.busy || OQ.finished) return false;
    // only let a piece be picked up if it actually has a legal move; on pickup,
    // clear the opponent's highlight and mark our FROM square gray.
    const fromSq = event.squareFrom || event.square;
    if(!fromSq) return true;                    // unknown pickup square — allow, skip highlight
    const legal = new Chess(fenForSeq(OQ.seq)).moves({ square: fromSq, verbose:true });
    if(!legal.length) return false;            // can't move this piece → no pickup, no highlight
    oqClearHighlights();
    oqHighlight(fromSq, 'from');
    return true;
  }
  if(event.type !== INPUT_EVENT_TYPE.validateMoveInput) return true;
  if(OQ.busy || OQ.finished) return false;

  const fen = fenForSeq(OQ.seq);
  const chess = new Chess(fen);
  // auto-queen any pawn reaching the last rank (underpromotion lines are rare)
  const moving = chess.get(event.squareFrom);
  const promo = (moving && moving.type === 'p' &&
                 (event.squareTo[1] === '8' || event.squareTo[1] === '1')) ? 'q' : undefined;
  const mv = chess.move({ from: event.squareFrom, to: event.squareTo, promotion: promo }, { sloppy:true });
  if(!mv){ oqClearHighlights(); return false; }   // illegal target — not scored, board snaps back

  const norm = s => s.replace(/[+#]/g,'');
  if(norm(mv.san) === norm(OQ.expected)){
    OQ.hits++; oqUpdateScore();
    OQ.busy = true;
    oqHighlight(event.squareTo, 'to');   // mark our TO square olive (FROM already marked)
    oqSetStatus('Correct', 'oq-hit');
    setTimeout(oqAfterCorrect, 200);   // run after this validate handler returns & the move settles
    return true;            // let the board show our move
  }
  // legal but wrong: score a miss and snap back; keep the FROM mark for the retry
  OQ.misses++; oqUpdateScore();
  oqSetStatus(`${mv.san} is not the move — try again`, 'oq-miss');
  return false;
}

/* after a correct reply: pick the opponent's next move (recorded or random),
   animate it, then load the following step — or finish if the line ends. */
function oqAfterCorrect(){
  const ourSeq = [...OQ.seq, OQ.expected];
  const opps = oqMemorizedFilter(ourSeq, oqCoverageEligible(ourSeq, oqVisibleOpps(ourSeq)));
  if(opps.length === 0){
    oqBoard.setPosition(fenForSeq(ourSeq), true);
    setTimeout(oqFinish, 500);
    return;
  }
  const oppMove = oqPickChoice(opps);
  const nextSeq = [...ourSeq, oppMove];
  // reconcile our move (castling/captures), keep our FROM/TO marks showing, then
  // after a 500ms pause play the opponent's reply (marking its FROM/TO) so it
  // isn't disconcertingly instant; finally arm the next step.
  oqBoard.setPosition(fenForSeq(ourSeq), true);
  setTimeout(()=>{
    oqMarkOpponentMove(nextSeq);
    oqBoard.setPosition(fenForSeq(nextSeq), true);
    OQ.seq = nextSeq;
    setTimeout(oqLoadStep, 500);
  }, 500);   // delay before the opponent moves
}

function oqFinish(){
  // session mode: this was one question of several -- move on to the next
  // one (fresh random path, aggregate score kept) instead of ending the run.
  // oqRun() re-enables move input unconditionally -- cm-chessboard throws if
  // it's already enabled, so it has to be disabled first (oqRun itself never
  // does this; the "real" finish below only gets away without a guard because
  // it's the last thing that runs before the summary screen).
  if(OQ.mode === 'session' && OQ.questionIndex < OQ.questionsTotal){
    OQ.questionIndex++;
    if(oqBoard) oqBoard.disableMoveInput();
    oqRun(false, true);
    return;
  }
  OQ.finished = true;
  if(oqBoard) oqBoard.disableMoveInput();
  oqClearHighlights();
  const total = OQ.hits + OQ.misses;
  const pct = total ? Math.round(OQ.hits / total * 100) : 0;
  $('oqScorePct').textContent = total ? `${pct}%` : 'No moves to test';
  $('oqScoreDetail').textContent = total
    ? `${OQ.hits} hit${OQ.hits===1?'':'s'}, ${OQ.misses} miss${OQ.misses===1?'':'es'}` +
      (OQ.mode === 'session' ? ` across ${OQ.questionsTotal} question${OQ.questionsTotal===1?'':'s'}` : '')
    : '';
  // "same choices" replay isn't tracked across a whole multi-question session
  // (only within one question) -- only offer it after a single row-quiz run.
  $('oqAgainSameBtn').style.display = OQ.mode === 'session' ? 'none' : '';
  $('oqPlay').style.display = 'none';
  $('oqSummary').style.display = 'block';
}

/* (re)start a run from OQ.startSeq. replaySame=true reuses the recorded
   opponent choices; otherwise they're re-rolled as play proceeds. keepScore
   (session mode only) skips zeroing hits/misses -- used when advancing to
   the next question of a session, whose score keeps accumulating. */
function oqRun(replaySame, keepScore){
  OQ.seq = OQ.startSeq.slice();
  if(!keepScore){ OQ.hits = 0; OQ.misses = 0; }
  OQ.replay = !!replaySame;
  OQ.replayIdx = 0;
  if(!replaySame) OQ.oppChoices = [];
  OQ.finished = false; OQ.busy = false;
  oqUpdateScore();
  $('oqSetup').style.display = 'none';
  $('oqSummary').style.display = 'none';
  $('oqPlay').style.display = 'block';
  if(OQ.mode === 'session'){
    $('oqQuestionLabel').textContent = `Question ${OQ.questionIndex} of ${OQ.questionsTotal}`;
    $('oqQuestionLabel').style.display = 'block';
  } else {
    $('oqQuestionLabel').style.display = 'none';
  }
  oqEnsureBoard();
  const col = OQ.color === 'black' ? COLOR.black : COLOR.white;
  oqBoard.setOrientation(col);
  oqBoard.enableMoveInput(oqInputHandler, col);
  oqLoadStep();
  oqMarkOpponentMove(OQ.startSeq);   // show the opponent move that led into the start position
}

function openOpeningQuiz(startSeq){
  if(!CURRENT_LINE) return;
  if(!Chessboard){
    alert('The chessboard could not be loaded (a CDN may be down), so the board-based quiz is unavailable. Reload to retry.');
    return;
  }
  if(!PREFS[prefKey(CURRENT_LINE.id, startSeq)]?.reply){
    alert('Set a standard response on this move first — there is nothing to quiz yet.');
    return;
  }
  OQ = { mode: 'row', line: CURRENT_LINE, color: CURRENT_LINE.color, startSeq: startSeq.slice(),
         oppChoices: [], hits:0, misses:0 };
  $('openingQuizOverlay').style.display = 'flex';
  oqRun(false);
}

/* ---------- chessboard test (Test > Chessboard): a multi-question board
   quiz, always starting each question at the true game start, scoped to an
   opening system or one of its castles and capped at a max move depth.
   Reuses the same overlay/board/gameplay machinery as the per-row Opening
   Quiz above (mode:'session' on OQ is what switches on the extra behavior:
   the ply-0 special case in oqLoadStep/oqPlayTrigger, coverage-bounded
   random choices, the depth cap, and oqFinish's next-question loop). */
async function openChessboardQuizSetup(){
  if(!Chessboard){
    alert('The chessboard could not be loaded (a CDN may be down), so the board-based quiz is unavailable. Reload to retry.');
    return;
  }
  $('openingQuizOverlay').style.display = 'flex';
  $('oqPlay').style.display = 'none';
  $('oqSummary').style.display = 'none';
  $('oqSetupError').textContent = '';
  await populateCoverageOptgroups($('oqCoverageSelect'), '<option value="">Choose a system…</option>');
  restoreOqSetupFields();
  $('oqSetup').style.display = 'block';
}
/* restore the last-used Number of Questions / Max Depth / Opening Coverage,
   since a user is likely to run several sessions in a row with the same
   settings. Coverage can't just restore the raw select value: "castle:N" is
   an index into MNEM_CASTLE_OPTIONS, which is rebuilt fresh (and can be
   reordered/resized) every time the select is populated -- so coverage is
   saved/restored by stable identity (lineId, + castleName when it's a
   castle) and re-resolved against the just-populated options instead. */
function restoreOqSetupFields(){
  const savedN = localStorage.getItem(LS_OQ_QUESTIONS);
  if(savedN) $('oqNumQuestions').value = savedN;
  const savedDepth = localStorage.getItem(LS_OQ_MAXDEPTH);
  if(savedDepth) $('oqMaxDepth').value = savedDepth;
  $('oqOnlyMemorized').checked = localStorage.getItem(LS_OQ_ONLYMEM) === '1';
  const savedCoverage = localStorage.getItem(LS_OQ_COVERAGE);
  if(!savedCoverage) return;
  let saved;
  try { saved = JSON.parse(savedCoverage); } catch { return; }
  const sel = $('oqCoverageSelect');
  const val = saved.castleName
    ? (() => { const idx = MNEM_CASTLE_OPTIONS.findIndex(o => o.lineId === saved.lineId && o.castleName === saved.castleName); return idx >= 0 ? `castle:${idx}` : null; })()
    : saved.lineId;
  if(val && [...sel.options].some(o => o.value === val)) sel.value = val;
}
/* the stable identity to persist for the coverage select's current value
   (see restoreOqSetupFields) -- {lineId} for "(whole system)", or
   {lineId, castleName} for a specific castle. null for the blank option. */
function oqCoverageIdentity(){
  const val = $('oqCoverageSelect').value;
  if(!val) return null;
  if(val.startsWith('castle:')){
    const opt = MNEM_CASTLE_OPTIONS[+val.slice('castle:'.length)];
    return opt ? { lineId: opt.lineId, castleName: opt.castleName } : null;
  }
  return { lineId: val };
}
/* resolves the setup form's coverage value, swaps PREFS to that line's real
   data, and builds a fresh session OQ (not yet run). Returns an error string
   on failure (leaving PREFS/OQ untouched), or null on success.

   PREFS is a single module-global holding whichever line's prefs are
   currently loaded (normally set by openLine() when its tree is opened) --
   but Test > Chessboard is reachable with no line open at all, or with a
   DIFFERENT line open than the one picked here. Every reply/coverage lookup
   for the rest of the session reads PREFS directly, so it has to actually
   hold the selected line's data first -- swapped in here for the session's
   duration and restored on close (oqRestorePrefsIfSwapped) so the tree view
   isn't left showing the wrong line's prefs afterwards.

   Split out from the START button's handler so __oqTestHooks can drive it
   without a live board. */
async function oqStartSession(coverageVal, n, depth, onlyMemorized){
  if(!Number.isFinite(n) || n < 1) return 'Enter a question count of 1 or more.';
  if(!Number.isFinite(depth) || depth < 1) return 'Enter a max depth of 1 or more.';
  if(!coverageVal) return 'Choose an opening system.';
  const lines = CURRENT_USER ? await getLines(CURRENT_USER) : [];
  const sel = await resolveCoverageSelection(coverageVal, lines);
  if(!sel) return 'That opening system could not be found — pick another.';
  if(sel.isCastle && !sel.rootSeq) return 'That castle has no content built yet — pick another.';
  if(!sel.line.openingMoves || !sel.line.openingMoves.length) return 'That opening system has no starting move configured yet.';
  const savedPrefs = PREFS;
  PREFS = await getAllPrefs(sel.line.id);
  OQ = {
    mode: 'session', line: sel.line, color: sel.line.color, startSeq: [],
    coverageRootSeq: sel.isCastle ? sel.rootSeq : null,
    maxDepth: depth, questionsTotal: n, questionIndex: 1,
    oppChoices: [], hits: 0, misses: 0, savedPrefs,
    // "only test memorized rooms": castleName is fixed for a castle-scoped
    // session (no per-node ancestor walk needed -- every question stays
    // inside that one castle's subtree, per oqCoverageEligible's own forced
    // path); null for whole-system coverage, where oqRoomMemorized resolves
    // each candidate's owning castle individually via inheritedCastle.
    castleName: sel.isCastle ? sel.castleName : null,
    onlyMemorized: !!onlyMemorized,
    memorizedRooms: onlyMemorized ? JSON.parse(await getMeta('threeMemorizedRooms') || '{}') : {},
  };
  return null;
}
$('oqStartBtn').onclick = async ()=>{
  const n = parseInt($('oqNumQuestions').value, 10);
  const depth = parseInt($('oqMaxDepth').value, 10);
  const coverageVal = $('oqCoverageSelect').value;
  const onlyMemorized = $('oqOnlyMemorized').checked;
  const coverageIdentity = oqCoverageIdentity();
  const err = await oqStartSession(coverageVal, n, depth, onlyMemorized);
  if(err){ $('oqSetupError').textContent = err; return; }
  $('oqSetupError').textContent = '';
  // remember these settings for next time -- only once they're known-valid
  // (oqStartSession succeeded), so a bad/incomplete attempt is never saved.
  localStorage.setItem(LS_OQ_QUESTIONS, String(n));
  localStorage.setItem(LS_OQ_MAXDEPTH, String(depth));
  localStorage.setItem(LS_OQ_ONLYMEM, onlyMemorized ? '1' : '0');
  if(coverageIdentity) localStorage.setItem(LS_OQ_COVERAGE, JSON.stringify(coverageIdentity));
  oqRun(false);
};

function oqRestorePrefsIfSwapped(){
  if(OQ && OQ.mode === 'session' && OQ.savedPrefs){
    PREFS = OQ.savedPrefs;
    OQ.savedPrefs = null;
  }
}
$('oqCloseBtn').onclick = ()=>{
  if(oqBoard) oqBoard.disableMoveInput();
  if(OQ) OQ.finished = true;
  oqRestorePrefsIfSwapped();
  oqClearHighlights();
  $('openingQuizOverlay').style.display='none';
};
$('oqExitBtn').onclick = ()=>{
  oqRestorePrefsIfSwapped();
  $('openingQuizOverlay').style.display='none';
};
$('oqAgainSameBtn').onclick = ()=> oqRun(true);
$('oqAgainNewBtn').onclick  = ()=>{
  if(OQ && OQ.mode === 'session') OQ.questionIndex = 1;
  oqRun(false);
};

// test-only hook (mirrors window.__threeTestEdit / __graphTestHooks): the
// offline harness runs with cm-chessboard un-mocked (Chessboard is null), so
// oqBoard-dependent flows can't be driven end-to-end there -- but the new
// coverage/depth logic below is plain data manipulation on OQ, independent
// of the board, and fully testable directly.
if(localStorage.getItem('threeTestDebug')){
  window.__oqTestHooks = {
    setOQ: (patch) => { OQ = Object.assign(OQ || {}, patch); },
    getOQ: () => OQ && JSON.parse(JSON.stringify(OQ)),
    coverageEligible: (seq, candidates) => oqCoverageEligible(seq, candidates),
    memorizedFilter: (seq, candidates) => oqMemorizedFilter(seq, candidates),
    roomMemorized: (seq) => oqRoomMemorized(seq),
    pickChoice: (candidates) => oqPickChoice(candidates),
    nextMoveNumber: (playedPlies) => oqNextMoveNumber(playedPlies),
    startSession: (coverageVal, n, depth, onlyMemorized) => oqStartSession(coverageVal, n, depth, onlyMemorized),
    restorePrefs: () => oqRestorePrefsIfSwapped(),
    getPrefs: () => JSON.parse(JSON.stringify(PREFS)),
    setPrefs: (p) => { PREFS = p; },
    // resolves a transposing row's own (opponent-move) seq to the room's
    // canonical one -- for testing "Set Attributes" always edits the same
    // shared pref regardless of which transposing path opened it.
    canonicalRoomSeq: (seq) => canonicalRoomSeq(seq),
    prefKey: (lineId, seq) => prefKey(lineId, seq),
    // a minimal stand-in for the real cm-chessboard instance (unavailable in
    // this harness) that mimics its one behavior this suite needs to catch a
    // regression on: throwing if enableMoveInput() is called while already
    // enabled. Lets oqRun/oqFinish/oqLoadStep run for real without a live board.
    installFakeBoard: () => {
      let enabled = false;
      const log = [];
      oqBoard = {
        setPosition: () => {},
        setOrientation: () => {},
        enableMoveInput: () => {
          if(enabled) throw new Error('moveInput already enabled');
          enabled = true;
          log.push('enable');
        },
        disableMoveInput: () => { enabled = false; log.push('disable'); },
        _log: log,
      };
    },
    getFakeBoardLog: () => (oqBoard && oqBoard._log) ? oqBoard._log.slice() : null,
    callFinish: () => oqFinish(),
    // setup-form persistence: populates the real coverage select (the
    // Chessboard-unavailable guard in openChessboardQuizSetup itself is
    // skipped here since that's just a DOM-visibility gate, not part of
    // what's being tested), and exposes the save/restore functions directly.
    populateCoverage: () => populateCoverageOptgroups($('oqCoverageSelect'), '<option value="">Choose a system…</option>'),
    coverageIdentity: () => oqCoverageIdentity(),
    restoreSetupFields: () => restoreOqSetupFields(),
    // deterministic stand-in for a real populate: sets MNEM_CASTLE_OPTIONS and
    // rebuilds the select's options to match, so a test can force a specific
    // castle:N ordering (e.g. to prove a saved coverage identity still
    // resolves correctly after the index it used to be at shifts).
    setCastleOptionsForTest: (opts) => {
      MNEM_CASTLE_OPTIONS = opts;
      $('oqCoverageSelect').innerHTML = '<option value="">Choose a system…</option>' +
        opts.map((o,i) => `<option value="castle:${i}">${o.castleName}</option>`).join('');
    },
  };
}

/* ---------- analysis board ----------
   null when the chessboard library failed to load; every call site uses ?. so
   the board features simply no-op in that (degraded) case. (PIECES_FILE is
   defined up top alongside the dynamic import.) */
const board = Chessboard ? new Chessboard($('board'), {
  position: new Chess().fen(),
  orientation: COLOR.white,
  style: { pieces: { file: PIECES_FILE } }
}) : null;

/* ---------- hover preview mini-board ---------- */
const hoverPreviewBoard = Chessboard ? new Chessboard($('hoverPreviewBoard'), {
  position: new Chess().fen(),
  orientation: COLOR.white,
  style: { pieces: { file: PIECES_FILE } }
}) : null;
let hoverPreviewTimer = null;
let hoverPreviewIcon = null;
function hideHoverPreview(){
  clearTimeout(hoverPreviewTimer);
  hoverPreviewTimer = null;
  $('hoverPreview').style.display = 'none';
  if(hoverPreviewIcon){
    hoverPreviewIcon.title = hoverPreviewIcon.dataset.savedTitle ?? '';
    hoverPreviewIcon = null;
  }
}
function attachHoverPreview(icon, seq){
  icon.addEventListener('mouseenter', () => {
    clearTimeout(hoverPreviewTimer);
    hoverPreviewTimer = setTimeout(() => {
      const fen = fenForSeq(seq);
      hoverPreviewBoard?.setPosition(fen);
      hoverPreviewBoard?.setOrientation(CURRENT_LINE?.color==='black' ? COLOR.black : COLOR.white);
      const r = icon.getBoundingClientRect();
      const preview = $('hoverPreview');
      preview.style.display = 'block';
      const size = 252; // preview box incl. border/padding (240 board + padding/border)
      const left = Math.min(r.left, window.innerWidth - size - 8);
      const top  = r.bottom + size + 6 <= window.innerHeight ? r.bottom + 6 : r.top - size - 6;
      preview.style.left = `${Math.round(Math.max(8,left))}px`;
      preview.style.top = `${Math.round(Math.max(8,top))}px`;
      icon.dataset.savedTitle = icon.title;
      icon.title = '';
      hoverPreviewIcon = icon;
    }, 1500);
  });
  icon.addEventListener('mouseleave', hideHoverPreview);
}

/* ---------- PV move float board (tap a move in a displayed line) ----------
   Shared by the saved-eval continuation lines in the move table and the live
   engine lines under the board; each rendered move chip carries the FEN of the
   position right after it (data-fen). */
const pvFloatBoard = Chessboard ? new Chessboard($('pvFloatBoard'), {
  position: new Chess().fen(),
  orientation: COLOR.white,
  style: { pieces: { file: PIECES_FILE } }
}) : null;
let pvFloatEl = null;
function hidePvFloat(){
  $('pvFloat').style.display = 'none';
  pvFloatEl?.classList.remove('pv-move-active');
  pvFloatEl = null;
}

/* on-demand analyses run from the pvFloat's own analyze button, keyed by fen,
   kept only for this page session (not persisted) -- lets reopening the float
   on the same position later show the result without re-running the engine. */
const PV_FLOAT_EVAL_CACHE = new Map();
const PV_FLOAT_SHORT_PLIES = 4;
let pvFloatAnalysisFen = null;

/* "known" analysis for a pvFloat position: either something we've already
   run from this widget this session, or -- by luck -- a position that's
   also a real node elsewhere in the currently open line, whose own saved
   eval (recordEvalIfDeeper anchors eval.pvFen to the node's own position)
   happens to match exactly. */
function findKnownPvFloatEval(fen){
  if(PV_FLOAT_EVAL_CACHE.has(fen)) return PV_FLOAT_EVAL_CACHE.get(fen);
  for(const saved of Object.values(PREFS)){
    if(saved?.eval?.pvFen === fen) return saved.eval;
  }
  return null;
}

function shortPvText(evalObj){
  if(evalObj.pvUci?.length) return pvToSan(evalObj.pvFen, evalObj.pvUci, PV_FLOAT_SHORT_PLIES);
  if(evalObj.pv) return evalObj.pv.trim().split(/\s+/).slice(0, PV_FLOAT_SHORT_PLIES).join(' ');
  return '';
}

function renderPvFloatAnalysisText(evalObj){
  const span = $('pvFloatAnalysisText');
  if(!evalObj){ span.innerHTML = ''; return; }
  const cls = evalClass(evalObj, CURRENT_LINE?.color || 'white');
  const lineText = shortPvText(evalObj);
  span.innerHTML = `<span class="pv-float-score ${cls}">${escapeHtml(formatEvalTag(evalObj))}</span>${lineText ? escapeHtml(lineText) : ''}`;
}

function showPvFloat(el){
  const fen = el.dataset.fen;
  if(!fen) return;
  const r = el.getBoundingClientRect();
  const f = $('pvFloat');
  f.style.display = 'block';
  try {
    pvFloatBoard?.setPosition(fen);
    pvFloatBoard?.setOrientation(CURRENT_LINE?.color==='black' ? COLOR.black : COLOR.white);
  } catch(err){
    console.warn('pvFloat: failed to render position', fen, err);
  }
  pvFloatAnalysisFen = fen;
  renderPvFloatAnalysisText(findKnownPvFloatEval(fen));
  // prefer above-and-to-the-right of the clicked move (its lower-left corner
  // offset from the move's upper-right corner) so the float doesn't cover the
  // lines below the one just tapped; fall back to below only if it wouldn't fit above.
  const fr = f.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right + 6, window.innerWidth - fr.width - 8));
  const top  = r.top - fr.height - 6 >= 8 ? r.top - fr.height - 6 : r.bottom + 6;
  f.style.left = `${Math.round(left)}px`;
  f.style.top  = `${Math.round(Math.max(8,top))}px`;
  pvFloatEl?.classList.remove('pv-move-active');
  el.classList.add('pv-move-active');
  pvFloatEl = el;
}

$('pvFloatAnalyzeBtn').onclick = () => {
  const fen = pvFloatAnalysisFen;
  if(!fen) return;
  if(liveEvalSpan) clearLiveEval(liveEvalSpan);
  $('pvFloatAnalysisText').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analyzing…';
  showPosition(fen,
    (depth, rawScore, pv) => {
      const evalObj = {...evalToWhiteRelative(rawScore,fen), depth, pv: pvToSan(fen,pv,EVAL_TAG_PV_PLIES), pvFen: fen, pvUci: pv?.slice(0, EVAL_TAG_PV_PLIES)};
      PV_FLOAT_EVAL_CACHE.set(fen, evalObj);
      if(fen === pvFloatAnalysisFen) renderPvFloatAnalysisText(evalObj);
    },
    () => {});
};
/* one delegated listener: tap a PV move to toggle its mini board; tap anywhere
   else (other than the float itself) dismisses it */
document.addEventListener('click', (e)=>{
  const moveEl = e.target.closest('.pv-move');
  if(moveEl){ moveEl === pvFloatEl ? hidePvFloat() : showPvFloat(moveEl); return; }
  if(!e.target.closest('#pvFloat')) hidePvFloat();
});

/* ---------- engine ---------- */
const ENGINE_PV_PLIES = 7;   // 7 (not 8) so a line never wraps regardless of move-text width; expand for the full line
const PV_COMPLETE_SLACK = 3; // expanded PV only shown in full once it's within this many plies of its reported depth
let expandedPvLines = new Set();
const engine = new Engine();
let engineRunId = 0;
let currentEngineFen = null;
// the repertoire move-path (from the trigger) to the position being analysed,
// when analysis was opened from a tree row — lets the engine panel's "Import
// this variation" build a full root-anchored line. null when the path is
// unknown (e.g. the initial start-position analysis), which hides that action.
let currentEngineSeq = null;

/* the one evaltag span (if any) currently tracking a live engine search, so its
   styling/tooltip can be reset once another row takes over or the search ends.
   liveEvalBtn is that row's analyse button, highlighted to show which move's
   position is the one currently loaded on the board. */
let liveEvalSpan = null, liveEvalBtn = null;

const engineMultiPV   = () => parseInt($('engineLinesSelect').value, 10);
const engineMaxDepth  = () => parseInt($('engineMaxDepthSelect').value, 10);
// undefined (not a number) when a threads select is hidden/empty (single-
// threaded build) -- analyze()'s own `threads = this.threads` default then
// applies, same as before either of these controls existed.
const threadsFrom = (selectId) => {
  const v = parseInt($(selectId).value, 10);
  return Number.isFinite(v) ? v : undefined;
};
const engineThreads = () => threadsFrom('engineThreadsSelect');
const aqThreads = () => threadsFrom('aqThreadsSelect');

/* restore last-used line count / max depth, if they're still valid options */
const savedLines = localStorage.getItem(LS_ENGINE_LINES);
if(savedLines && [...$('engineLinesSelect').options].some(o=>o.value===savedLines)){
  $('engineLinesSelect').value = savedLines;
}
const savedDepth = localStorage.getItem(LS_ENGINE_DEPTH);
if(savedDepth && [...$('engineMaxDepthSelect').options].some(o=>o.value===savedDepth)){
  $('engineMaxDepthSelect').value = savedDepth;
}

$('engineLinesSelect').onchange = () => {
  localStorage.setItem(LS_ENGINE_LINES, $('engineLinesSelect').value);
  if(currentEngineFen) runEngine(currentEngineFen);
};
$('engineMaxDepthSelect').onchange = () => {
  localStorage.setItem(LS_ENGINE_DEPTH, $('engineMaxDepthSelect').value);
  if(currentEngineFen) runEngine(currentEngineFen);
};
$('engineThreadsSelect').onchange = () => {
  // deliberately does NOT restart the current search like Lines/Depth do --
  // changing Threads means stop + a pthread-pool respawn + a fresh `go`
  // (see engine.js's analyze()), discarding the depth already reached on
  // whatever position is being watched right now for no real gain. The new
  // choice just gets persisted and takes effect the next time runEngine()
  // actually runs on its own (a newly-selected position, or an explicit
  // Stop/Resume) -- never forced.
  localStorage.setItem(LS_ENGINE_THREADS, $('engineThreadsSelect').value);
};
// same "persist, never force" rule as the live panel's selector above --
// the currently-processing queue item keeps whatever thread count it
// started with; the new choice is only read on the NEXT engine.analyze()
// call processAnalysisQueueLoop makes (the next item, or this one resumed).
$('aqThreadsSelect').onchange = () => {
  localStorage.setItem(LS_AQ_THREADS, $('aqThreadsSelect').value);
};
// 1..maxThreads (cores-1) -- only meaningful once the multi-threaded build is
// up, so this is called from engine.init().then() below, never at module
// load. Restores a saved choice only if it's still in range on THIS device.
// Shared by the live engine panel's selector and the Analysis Queue modal's
// -- same range/gate, independently persisted choices.
function populateThreadsSelect(fieldId, selectId, storageKey){
  if(!engine.multithreaded || engine.maxThreads <= 1){
    $(fieldId).style.display = 'none';
    return;
  }
  const sel = $(selectId);
  sel.innerHTML = Array.from({length: engine.maxThreads}, (_, i) => i + 1)
    .map(n => `<option value="${n}">${n}</option>`).join('');
  const saved = parseInt(localStorage.getItem(storageKey), 10);
  sel.value = (Number.isFinite(saved) && saved >= 1 && saved <= engine.maxThreads) ? saved : engine.threads;
  $(fieldId).style.display = '';
}
const populateEngineThreadsSelect = () => populateThreadsSelect('engineThreadsField', 'engineThreadsSelect', LS_ENGINE_THREADS);
const populateAqThreadsSelect = () => populateThreadsSelect('aqThreadsField', 'aqThreadsSelect', LS_AQ_THREADS);

/* short suffix telling the user how many threads are ACTUALLY configured
   right now (not just the default init() picked -- the threads selector
   above can override it per search), shown on the live engine status line
   so it's visible at a glance during analysis. */
const engineModeTag = () => !engine.ready ? ''
  : engine.multithreaded ? ` · ${engine._currentThreads} threads` : ' · 1 thread';

/* The STOP/PLAY button drives (and reflects) the live search state:
     'running' -> STOP (square): a search is in progress (it can peg several
                  cores), click to halt it without dropping the depth.
     'stopped' -> PLAY (triangle): halted by the user; the lines found so far
                  stay on screen and the status reads "Stopped — Depth N".
                  Click to resume analysis of the same position.
     'idle'    -> hidden: nothing to stop (no position, or it finished on its
                  own at the target depth).
   The status-line prefix ("Live" vs "Stopped") is derived from this state too,
   so a stray late `info` line or a PV-expand click can't flip the label back. */
let engineState = 'idle';
let lastOnEvalUpdate = null, lastOnComplete = null;
function setEngineUI(state){
  engineState = state;
  const btn = $('engineStopBtn');
  const icon = btn.querySelector('i');
  if(state === 'running'){
    btn.style.display = 'inline-flex';
    btn.title = 'Stop analysis';
    icon.className = 'fa-solid fa-stop';
    btn.classList.remove('engine-resume');
  } else if(state === 'stopped'){
    btn.style.display = 'inline-flex';
    btn.title = 'Resume analysis';
    icon.className = 'fa-solid fa-play';
    btn.classList.add('engine-resume');
  } else {
    btn.style.display = 'none';
    btn.classList.remove('engine-resume');
  }
  // the engine just freed up -- let the background analysis queue (if
  // anything's in it) claim it. No-op if nothing's queued or it's already running.
  if(state === 'idle' || state === 'stopped') maybeResumeAnalysisQueue();
}
$('engineStopBtn').onclick = () => {
  if(engineState === 'running'){
    // flip to 'stopped' *before* telling the engine, so any trailing info line
    // the engine emits as it winds down renders with the "Stopped" prefix.
    // Live analysis takes precedence over the queue while it's running, but an
    // explicit Stop hands the now-free engine straight back to the queue --
    // setEngineUI's hook above does that; the button stays on "Resume" (not
    // idle) so the user can still pick this exact search back up later, and
    // resuming it will transparently preempt the queue again (analyze()
    // always stops whatever's currently running first).
    setEngineUI('stopped');
    $('engineDepth').textContent = $('engineDepth').textContent.replace(/^Live — /, 'Stopped — ');
    engine.stop();
  } else if(engineState === 'stopped'){
    if(currentEngineFen) runEngine(currentEngineFen, lastOnEvalUpdate, lastOnComplete);
  }
};

engine.init().then(() => {
  // surface the engine mode as soon as it's ready, if nothing is analysing yet.
  // Without the board widget there's no live board to analyse on, so report the
  // engine as not available rather than "ready".
  if(!$('engineDepth').textContent){
    // the thread count used to be tacked on here too, but the Threads
    // selector right below already shows it -- redundant in the idle state.
    $('engineDepth').textContent = Chessboard ? 'Engine ready' : 'Engine not available';
  }
  populateEngineThreadsSelect();
  populateAqThreadsSelect();
  maybeResumeAnalysisQueue();
}).catch(err => {
  console.error('[engine] init failed', err);
  $('engineDepth').textContent = 'Engine unavailable';
});

function formatScore(score, turn){
  // engine scores are relative to the side to move; flip to a White-relative sign
  const sign = turn === 'w' ? 1 : -1;
  if(score.type === 'mate'){
    const m = score.value * sign;
    return (m >= 0 ? '#' : '-#') + Math.abs(m);
  }
  const cp = score.value * sign / 100;
  return (cp >= 0 ? '+' : '') + cp.toFixed(1);
}

/* ---------- persisted position evals (saved per move-sequence in prefs) ----------
   Engine scores are relative to the side to move; convert once to a fixed
   White-relative value so the saved number means the same thing regardless
   of who was on move when it was computed. */
function evalToWhiteRelative(score, fen){
  const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
  return { type: score.type, value: score.value * sign };
}

function formatEvalTag({type, value, depth}){
  const scoreText = type === 'mate'
    ? (value >= 0 ? `#${value}` : `-#${Math.abs(value)}`)
    : `${value >= 0 ? '+' : ''}${(value/100).toFixed(1)}`;
  return `${scoreText}/${depth}`;
}

/* favor is from the perspective of the line's own color: positive White-relative
   values are good for a White line, bad for a Black line, and vice versa. */
function evalClass({type, value}, lineColor){
  const favor = lineColor === 'black' ? -value : value;
  if(type === 'mate') return favor >= 0 ? 'eval-winning' : 'eval-losing';
  const pawns = favor / 100;
  if(Math.abs(pawns) <= 0.5) return 'eval-neutral';
  if(pawns > 1.25) return 'eval-winning';
  if(pawns > 0) return 'eval-superior';
  if(pawns < -1.25) return 'eval-losing';
  return 'eval-inferior';
}

function refreshEvalSpan(evalSpan, evalObj, lineCount){
  if(!evalObj){ evalSpan.style.display='none'; return; }
  evalSpan.textContent = formatEvalTag(evalObj);
  evalSpan.className = `evaltag ${evalClass(evalObj, CURRENT_LINE.color)}`;
  evalSpan.dataset.depth = evalObj.depth;
  evalSpan.dataset.pv = evalObj.pv || '';
  const linesNote = (lineCount > 1) ? ` (+${lineCount - 1} more line${lineCount - 1 === 1 ? '' : 's'} saved, click to view)` : '';
  const pvSuffix = evalObj.pv ? `\nBest line: ${evalObj.pv}${linesNote}` : '';
  if(evalSpan === liveEvalSpan){
    evalSpan.classList.add('evaltag-live');
    evalSpan.title = 'Live analysis in progress…' + pvSuffix;
  } else {
    evalSpan.title = `Saved eval, depth ${evalObj.depth} — click Analyse to refresh${pvSuffix}`;
  }
  evalSpan.style.display='';
}

/* marks `evalSpan` as tracking the in-progress live search (only one row at a
   time, since the engine is a single shared worker), clearing the previous
   row's marker so a cached tag never looks like it's still updating live */
function markLiveEval(evalSpan, btn){
  if(liveEvalSpan && liveEvalSpan !== evalSpan) clearLiveEval(liveEvalSpan);
  liveEvalSpan = evalSpan;
  liveEvalBtn = btn;
  evalSpan.classList.add('evaltag-live');
  evalSpan.title = 'Live analysis in progress…';
  btn.classList.add('btnEval-onBoard');
}

function clearLiveEval(evalSpan){
  if(liveEvalSpan !== evalSpan) return;
  liveEvalSpan = null;
  evalSpan.classList.remove('evaltag-live');
  const depth = evalSpan.dataset.depth;
  const pvSuffix = evalSpan.dataset.pv ? `\nBest line: ${evalSpan.dataset.pv}` : '';
  evalSpan.title = depth ? `Saved eval, depth ${depth} — click Analyse to refresh${pvSuffix}` : '';
  liveEvalBtn?.classList.remove('btnEval-onBoard');
  liveEvalBtn = null;
}

function refreshBranchName(nameSpan, saved){
  const name = (saved?.name || '').trim();
  // a node that starts a new castle shows "CastleName: RoomName"
  const castle = saved?.isCastleRoot ? (saved.castleName || '').trim() : '';
  const text = castle ? (name ? `${castle}: ${name}` : castle) : name;
  if(!text){ nameSpan.style.display='none'; return; }
  nameSpan.textContent = text;
  nameSpan.style.display='';
}

function refreshBranchStats(statsSpan, games, childrenSeq){
  if(!ENABLE_NODE_STATS || !childrenSeq){ statsSpan.style.display='none'; return; }
  statsSpan.textContent = ' (' + formatNodeStats(computeNodeStats(games,childrenSeq)) + ')';
  statsSpan.style.display='';
}

/* toggles row-menu item labels between their "Add"/"Set" and "Edit" wording
   depending on whether that field already has a saved value */
function refreshRowMenuLabels(rowMenu, saved){
  const responseBtn = rowMenu.querySelector('[data-act="response"]');
  if(responseBtn) responseBtn.lastChild.textContent = saved?.reply ? 'Edit Standard Response' : 'Set Standard Response';
}

/* transforms one engine.analyze() rank (score/pv/depth, still turn-relative
   and UCI) into the same White-relative, SAN+UCI-carrying shape eval/evalLines
   entries are saved in. */
const EVAL_TAG_PV_PLIES = 16;
function toEvalLine(score, depth, uciPv, fen){
  const pvSan = uciPv?.length ? pvToSan(fen, uciPv, EVAL_TAG_PV_PLIES) : '';
  return {...evalToWhiteRelative(score,fen), depth, pv: pvSan, pvFen: fen, pvUci: uciPv?.length ? uciPv.slice(0, EVAL_TAG_PV_PLIES) : undefined};
}
/* only overwrite a saved eval if the engine has now searched deeper than
   before. `lines`, when given, is the full MultiPV rank map from this same
   search -- saved alongside the single best eval as evalLines (one entry per
   rank) so a node analyzed with MultiPV>1 remembers every candidate line the
   engine considered, not just its top pick. A narrower single-line (MultiPV=1)
   re-analysis never touches evalLines, so it can't downgrade a previously
   captured richer multi-line set. */
function recordEvalIfDeeper(saveField, currentSaved, evalSpan, depth, rawScore, fen, pv, lines){
  const existing = currentSaved()?.eval;
  if(existing && existing.depth >= depth) return;
  const evalObj = toEvalLine(rawScore, depth, pv, fen);
  saveField('eval', evalObj);
  const ranks = lines && Object.keys(lines).map(Number).sort((a,b)=>a-b);
  let evalLines = null;
  if(ranks && ranks.length > 1){
    evalLines = ranks
      .map(idx => lines[idx])
      .filter(line => line?.score)
      .map(line => toEvalLine(line.score, line.depth, line.pv, fen));
    if(evalLines.length > 1) saveField('evalLines', evalLines);
    else evalLines = null;
  }
  refreshEvalSpan(evalSpan, evalObj, (evalLines || currentSaved()?.evalLines)?.length);
}

function savePrefField(seq,field,value){
  const key = prefKey(CURRENT_LINE.id,seq);
  (PREFS[key] ??= {key,lineId:CURRENT_LINE.id,seq,reply:'',note:'',mnemonic:'',hidden:false})[field]=value;
  return setPref(CURRENT_LINE.id,seq,{[field]:value});
}

/* manually-recorded opponent replies for the position `seq`, kept alongside
   that position's own prefs so a theoretical try can be added before any
   imported game actually contains it */
function addManualReply(seq,move){
  const existing = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
  if(existing.includes(move)) return Promise.resolve();
  invalidateBuiltCastlesCache();   // a new opponent try can open a new exit/room
  return savePrefField(seq,'manualReplies',[...existing,move]);
}

function removeManualReply(seq,move){
  const existing = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
  invalidateBuiltCastlesCache();   // symmetric with addManualReply -- removing a try can drop a room/exit too
  return savePrefField(seq,'manualReplies',existing.filter(m=>m!==move));
}

function sanToUci(fen, san){
  const chess = new Chess(fen);
  const mv = chess.move(san, {sloppy:true});
  return mv ? mv.from + mv.to + (mv.promotion || '') : null;
}

/* "Analyze Child Nodes": one multi-PV search on the parent position covers every
   sibling row in a single pass, since each PV's first move is itself a sibling's
   move. This also reuses Stockfish's transposition hash across all of them,
   which sequential one-at-a-time (or one-worker-per-child) searches would not.

   Each multipv rank advances at its own pace (the engine reports rank 1's
   deeper iterations well before rank 12's), so every line's update must be
   tagged with *its own* depth (line.depth) rather than whatever depth the
   most-recently-changed rank happens to be at — otherwise a lagging rank gets
   stamped with a depth it hasn't actually reached, which then blocks all of
   its real future updates (existing.depth >= d looks "already deep enough"). */
// every direct child row (opponent replies) of a just-expanded branch, each
// paired with its eval span and the legal UCI move for its SAN -- shared by
// every caller of queueChildrenForAnalysis below.
function collectChildEntries(parentSeq, branchDiv){
  const fen = fenForSeq(parentSeq);
  const rows = [...branchDiv.querySelectorAll(':scope > table > tbody > tr.data-row')];
  return rows
    .map(tr => ({ opp: tr.dataset.opp, evalSpan: tr.querySelector('.evaltag') }))
    .filter(e => e.opp && e.evalSpan)
    .map(e => ({ ...e, uci: sanToUci(fen, e.opp) }))
    .filter(e => e.uci);
}

/* Queues every child of this branch for background analysis -- same depth/
   lines prompt as adding a single node via openAnalysisQueueAddModal, just
   applied to every legal child move at once. Used both by the explicit
   "Analyze All Children" row-menu action and by setStandardResponse's
   passive auto-trigger (fills in sibling evals as soon as a branch becomes
   visible), so a fresh reply never kicks off a live search that ties up the
   engine -- it just joins the same background queue as everything else. */
function queueChildrenForAnalysis(parentSeq, branchDiv){
  const entries = collectChildEntries(parentSeq, branchDiv);
  if(!entries.length) return;
  const seqs = entries.map(e => [...parentSeq, e.opp]);
  openAnalysisQueueAddModal(CURRENT_LINE.id, seqs);
}

/* ---------- background analysis queue ----------
   Long-running engine analysis queued from a move row's ⋮ menu ("Add to
   Analysis Queue") or driven from the "Analysis Queue" hamburger item. Items
   live in IDB store `analysisQueue`; each names a (lineId, seq) node plus a
   target depth/multipv. Processed one at a time, in queue order (oldest
   first), whenever the interactive engine isn't actively running a live
   search -- see maybeResumeAnalysisQueue(), hooked from setEngineUI('idle'
   and 'stopped') and from engine.init(). A live search takes precedence
   while it runs, but stopping it explicitly hands the engine straight back
   to the queue. Runs at its OWN thread count (the Analysis Queue modal's own
   selector, independent of the live engine panel's), read fresh on every
   engine.analyze() call this loop makes -- a mid-session Threads change is
   safe now (see engine.js's analyze()), but a change while an item is
   mid-search never interrupts it, only applying once that item finishes (or
   the next one starts), at the cost of the queue competing for whatever
   cores it's currently using against analysis the user is actively watching.
   Any interactive engine.analyze() call still automatically preempts it for
   free (Engine._stopCurrent()) -- the queue just notices its search resolved
   short of the target depth and leaves the item queued to pick back up at
   the next idle transition. A finished item's result is written straight to
   PREFS via setPref() (not the CURRENT_LINE-coupled savePrefField(), since
   the node being processed is often not the line the user has open) and the
   item itself is then deleted from the queue -- the queue is a to-do list,
   not a history log. State variables live up near CURRENT_USER/PREFS (not
   here) since the boot-time auto-resume call runs before the module reaches
   this point in top-to-bottom evaluation. */

// `seqs`: one or more move sequences under `lineId` to queue once Depth/Lines
// are confirmed -- a single-element array for the per-node "Add to Analysis
// Queue" row-menu action, multi-element for "Analyze All Children".
function openAnalysisQueueAddModal(lineId, seqs){
  aqAddCtx = {lineId, seqs};
  $('analysisAddTitle').textContent = seqs.length > 1
    ? `Add ${seqs.length} Children to Analysis Queue` : 'Add to Analysis Queue';
  $('analysisAddDepth').value = AQ_DEFAULT_DEPTH;
  $('analysisAddLines').value = AQ_DEFAULT_LINES;
  $('analysisAddError').textContent = '';
  $('analysisAddOverlay').style.display='flex';
}
$('analysisAddCancelBtn').onclick = () => {
  $('analysisAddOverlay').style.display='none';
  aqAddCtx = null;
};
$('analysisAddGoBtn').onclick = async () => {
  if(!aqAddCtx) return;
  const depth = parseInt($('analysisAddDepth').value, 10);
  const multipv = parseInt($('analysisAddLines').value, 10);
  if(!Number.isFinite(depth) || depth < 1){ $('analysisAddError').textContent = 'enter a valid depth'; return; }
  if(!Number.isFinite(multipv) || multipv < 1){ $('analysisAddError').textContent = 'enter a valid number of lines'; return; }
  const {lineId, seqs} = aqAddCtx;
  $('analysisAddOverlay').style.display='none';
  aqAddCtx = null;
  if(seqs.length > 1) await addChildrenToAnalysisQueue(lineId, seqs, depth, multipv);
  else await addToAnalysisQueue(lineId, seqs[0], depth, multipv);
};

function seqEq(a,b){
  return a.length===b.length && a.every((m,i)=>m===b[i]);
}

/* de-dup: a still-queued/processing item for the same node is topped up in
   place (raised to the max of its old and new target) instead of being
   duplicated; a node already saved to at least this depth with at least
   this many lines is a silent no-op -- nothing to queue. Returns
   'topped-up' | 'skipped' | 'added' so a bulk caller can tally results
   without re-deriving this same logic. `silent`, when true, suppresses the
   per-item log() line (used by addChildrenToAnalysisQueue, which logs one
   combined summary instead of one message per child overwriting the last). */
async function addToAnalysisQueue(lineId, seq, depth, multipv, {silent=false}={}){
  const existing = ANALYSIS_QUEUE.find(it => it.lineId===lineId && seqEq(it.seq, seq));
  if(existing){
    const newDepth = Math.max(existing.depth, depth);
    const newLines = Math.max(existing.multipv, multipv);
    if(newDepth !== existing.depth || newLines !== existing.multipv){
      existing.depth = newDepth;
      existing.multipv = newLines;
      await putAnalysisQueueItem(existing);
    }
    if(!silent) log('already queued for background analysis — target updated');
    renderAnalysisQueueModalIfOpen();
    refreshAnalysisQueueRowMarkers();
    return 'topped-up';
  }
  const saved = await getPref(lineId, seq);
  const savedEval = saved?.eval;
  const savedLineCount = saved?.evalLines?.length || (savedEval ? 1 : 0);
  if(savedEval && savedEval.depth >= depth && savedLineCount >= multipv){
    if(!silent) log(`already analyzed to depth ${savedEval.depth} with ${savedLineCount} line(s) — nothing to queue`);
    return 'skipped';
  }
  const item = {
    id: `aq:${Date.now()}:${Math.random().toString(36).slice(2,8)}`,
    user: CURRENT_USER, lineId, seq: seq.slice(), depth, multipv,
    status: 'queued', createdAt: Date.now(),
  };
  await putAnalysisQueueItem(item);
  ANALYSIS_QUEUE.push(item);
  if(!silent) log('queued for background analysis');
  renderAnalysisQueueModalIfOpen();
  refreshAnalysisQueueRowMarkers();
  maybeResumeAnalysisQueue();
  return 'added';
}

/* "Analyze All Children" bulk variant: queues every given seq under lineId,
   suppressing addToAnalysisQueue's per-item log() (which would otherwise
   have each child's message overwrite the last) in favor of one combined
   summary line. */
async function addChildrenToAnalysisQueue(lineId, seqs, depth, multipv){
  let added=0, toppedUp=0, skipped=0;
  for(const seq of seqs){
    const status = await addToAnalysisQueue(lineId, seq, depth, multipv, {silent:true});
    if(status==='added') added++;
    else if(status==='topped-up') toppedUp++;
    else skipped++;
  }
  const bits = [];
  if(added) bits.push(`${added} queued`);
  if(toppedUp) bits.push(`${toppedUp} target updated`);
  if(skipped) bits.push(`${skipped} already sufficient`);
  log(`${seqs.length} child${seqs.length===1?'':'ren'}: ${bits.join(', ') || 'nothing to do'}`);
}

/* ---------- "Analyze Others" (Compare Games' analyze-all icon) ----------
   Queues every non-standard move actually played at a node for a quick,
   single-line background analysis. Deliberately separate from "Add to
   Analysis Queue"/"Add Children to Analysis Queue": its own (usually much
   shallower) depth default saved to its own localStorage key so it doesn't
   fight with the deeper default used for real children, always a single PV
   line (multipv 1 -- there's no need for alternatives on a position that's
   itself already an alternative), and run at the LIVE engine panel's own
   thread count rather than the queue's own independent setting, since the
   user is actively watching this row, not leaving it to churn in the
   background like a normal queue item. Every item queued this way also
   jumps to the very front of the queue, ahead of (and interrupting) whatever
   was already processing -- this is meant to be a fast "let me see" action,
   not a to-do added for later. */
let compareAnalyzeCtx = null;   // {lineId, seq, moves, onQueued} pending in the depth dialog
function openCompareAnalyzeModal(lineId, seq, moves, onQueued){
  compareAnalyzeCtx = {lineId, seq, moves, onQueued};
  $('compareAnalyzeDepth').value = localStorage.getItem(LS_COMPARE_DEPTH) || COMPARE_DEFAULT_DEPTH;
  $('compareAnalyzeError').textContent = '';
  $('compareAnalyzeOverlay').style.display='flex';
}
$('compareAnalyzeCancelBtn').onclick = () => {
  $('compareAnalyzeOverlay').style.display='none';
  compareAnalyzeCtx = null;
};
$('compareAnalyzeGoBtn').onclick = async () => {
  if(!compareAnalyzeCtx) return;
  const depth = parseInt($('compareAnalyzeDepth').value, 10);
  if(!Number.isFinite(depth) || depth < 1){ $('compareAnalyzeError').textContent = 'enter a valid depth'; return; }
  localStorage.setItem(LS_COMPARE_DEPTH, String(depth));
  const {lineId, seq, moves, onQueued} = compareAnalyzeCtx;
  $('compareAnalyzeOverlay').style.display='none';
  compareAnalyzeCtx = null;
  await queueAlternatesForAnalysis(lineId, moves.map(m => [...seq, m]), depth);
  onQueued?.();
};

async function queueAlternatesForAnalysis(lineId, seqs, depth){
  const orderOf = it => it.order ?? it.createdAt;
  for(const seq of seqs){
    const status = await addToAnalysisQueue(lineId, seq, depth, 1, {silent:true});
    if(status === 'skipped') continue;
    const item = ANALYSIS_QUEUE.find(it => it.lineId===lineId && seqEq(it.seq, seq));
    if(item) item.useLiveThreads = true;
  }
  // jump every item just touched to the front, ahead of anything already
  // queued -- including whatever's at index 0, which processAnalysisQueueLoop
  // treats as "currently processing". engine.stop() below interrupts it, and
  // processAnalysisQueueLoop's own "outranked" check (it's still queued, just
  // no longer at the front) resumes the loop immediately for the new front
  // item, rather than waiting for an external idle trigger.
  const minOrder = ANALYSIS_QUEUE.length ? Math.min(...ANALYSIS_QUEUE.map(orderOf)) : Date.now();
  let nextOrder = minOrder - 1;
  for(const seq of seqs){
    const item = ANALYSIS_QUEUE.find(it => it.lineId===lineId && seqEq(it.seq, seq));
    if(!item) continue;
    item.order = nextOrder--;
    await putAnalysisQueueItem(item);
  }
  ANALYSIS_QUEUE.sort((a,b) => orderOf(a) - orderOf(b));
  renderAnalysisQueueModalIfOpen();
  refreshAnalysisQueueRowMarkers();
  if(aqCurrentItem) engine.stop(); else maybeResumeAnalysisQueue();
}

async function cancelAnalysisQueueItem(id){
  const idx = ANALYSIS_QUEUE.findIndex(it => it.id === id);
  if(idx === -1) return;
  const wasProcessing = aqCurrentItem?.id === id;
  ANALYSIS_QUEUE.splice(idx, 1);
  await deleteAnalysisQueueItem(id);
  // if this is the item currently being searched, stop the in-flight search
  // right away instead of leaving it to run to its full target depth in the
  // background (which could stall the rest of the queue for minutes) --
  // processAnalysisQueueLoop re-checks the live array (by reference, not
  // index) before removing/requeuing, sees this item is gone, and moves
  // straight on to the next one rather than discarding/re-queuing it.
  if(wasProcessing) engine.stop();
  renderAnalysisQueueModal();
  refreshAnalysisQueueRowMarkers();
}

async function refreshAnalysisQueue(){
  if(!CURRENT_USER){ ANALYSIS_QUEUE = []; AQ_LINE_NAMES = new Map(); }
  else {
    ANALYSIS_QUEUE = await getAnalysisQueue(CURRENT_USER);
    const lines = await getLines(CURRENT_USER);
    AQ_LINE_NAMES = new Map(lines.map(l => [l.id, l.name]));
  }
  refreshAnalysisQueueRowMarkers();
}

/* toggles the small hourglass (⧗) marker on every currently-rendered move-tree
   row that's in the background analysis queue for CURRENT_LINE -- static
   while merely queued, pulsing (fa-fade) while it's the one actually being
   searched right now. Driven purely from tr.dataset.seq (the same stable row
   identity focus/search already rely on) against ANALYSIS_QUEUE/aqCurrentItem,
   so it needs no per-row state of its own and is cheap to call on every queue
   change. Rows for a different opening system than CURRENT_LINE simply aren't
   in the DOM, so nothing to do for them. */
function refreshAnalysisQueueRowMarkers(){
  if(!CURRENT_LINE) return;
  document.querySelectorAll('tr.data-row[data-seq]').forEach(tr => {
    const icon = tr.querySelector('.aqQueuedIcon');
    if(!icon) return;
    const item = ANALYSIS_QUEUE.find(it => it.lineId === CURRENT_LINE.id && it.seq.join(',') === tr.dataset.seq);
    if(!item){ icon.style.display = 'none'; return; }
    const processing = aqCurrentItem?.id === item.id;
    icon.style.display = '';
    icon.querySelector('i').classList.toggle('fa-fade', processing);
    icon.title = processing
      ? `Background analysis in progress — target depth ${item.depth}, ${item.multipv} line(s)`
      : `Queued for background analysis — target depth ${item.depth}, ${item.multipv} line(s)`;
  });
}

function seqToNotation(seq){
  if(!seq || !seq.length) return '(start)';
  return seq.map((san,i) => (i%2===0 ? `${Math.floor(i/2)+1}.${san}` : san)).join(' ');
}

function aqPositionLabel(item){
  const lineName = AQ_LINE_NAMES.get(item.lineId) || '(unknown opening)';
  return `${escapeHtml(lineName)}<br><span class="aq-pos">${escapeHtml(seqToNotation(item.seq))}</span>`;
}

function aqProgressHtml(item){
  if(!aqCurrentItem || aqCurrentItem.id !== item.id) return `<span class="aq-status-queued">queued</span>`;
  if(!aqCurrentProgress) return `<span class="aq-status-processing">starting…</span>`;
  const {depth, lines} = aqCurrentProgress;
  const ranks = Object.keys(lines).map(Number).sort((a,b)=>a-b);
  const fen = fenForSeq(item.seq);
  const turn = fen.split(' ')[1];
  // one row per PV rank, eval badge + the first few moves (same ply count and
  // tap-to-preview chips as the live engine panel), like evalContinuationHtml's
  // saved multi-line display.
  const pvRows = ranks.map(idx => {
    const line = lines[idx];
    const scoreTag = `<span class="meta-pv-score">${escapeHtml(formatScore(line.score, turn))}</span>`;
    const pvHtml = line.pv?.length ? pvChipsFromUci(fen, line.pv, ENGINE_PV_PLIES) : '';
    return `<div class="meta-pv-row">${scoreTag}<span class="meta-pv">${pvHtml}</span></div>`;
  }).join('');
  return `<div class="aq-status-processing">processing — depth ${depth}/${item.depth}</div>` +
    `<div class="aq-progress">${pvRows}</div>`;
}

function aqModalOpen(){ return $('analysisQueueOverlay').style.display === 'flex'; }
function renderAnalysisQueueModalIfOpen(){ if(aqModalOpen()) renderAnalysisQueueModal(); }

/* swaps the ORDER (see getAnalysisQueue's sort in db.js) of ANALYSIS_QUEUE[i]
   and its neighbor at i+dir, persists both, and re-renders. Index 0 is never
   touched either way -- it's the item currently being (or about to be)
   searched, so displacing it would waste in-progress engine work; the
   highest anything else can be raised to is index 1 (the second row). */
async function moveAnalysisQueueItem(id, dir){
  const i = ANALYSIS_QUEUE.findIndex(it => it.id === id);
  if(i === -1) return;
  const j = i + dir;
  if(i === 0 || j <= 0 || j >= ANALYSIS_QUEUE.length) return;
  const a = ANALYSIS_QUEUE[i], b = ANALYSIS_QUEUE[j];
  const orderOf = it => it.order ?? it.createdAt;
  const tmp = orderOf(a);
  a.order = orderOf(b);
  b.order = tmp;
  ANALYSIS_QUEUE[i] = b; ANALYSIS_QUEUE[j] = a;
  await Promise.all([putAnalysisQueueItem(a), putAnalysisQueueItem(b)]);
  renderAnalysisQueueModalIfOpen();
}

/* Jumps ANALYSIS_QUEUE[i] all the way to the top movable slot (index 1,
   dir<0) or all the way to the bottom (the last index, dir>0) -- same
   index-0 protection as moveAnalysisQueueItem. Only the moved item's own
   `order` changes (nobody else's is touched): moving to "top" sets it to
   the MIDPOINT between index 0's and index 1's order, rather than just
   index 1's order minus a fixed step, so it can never accidentally sort
   ahead of index 0 on a fresh IDB fetch even if the two were created only
   moments apart; moving to "bottom" just needs to clear the last item's
   order, so a fixed +1 step is safe there. */
async function jumpAnalysisQueueItem(id, dir){
  const i = ANALYSIS_QUEUE.findIndex(it => it.id === id);
  if(i === -1 || i === 0) return;
  const targetIndex = dir < 0 ? 1 : ANALYSIS_QUEUE.length - 1;
  if(i === targetIndex) return;
  const orderOf = it => it.order ?? it.createdAt;
  const item = ANALYSIS_QUEUE[i];
  item.order = dir < 0
    ? (orderOf(ANALYSIS_QUEUE[0]) + orderOf(ANALYSIS_QUEUE[1])) / 2
    : orderOf(ANALYSIS_QUEUE[ANALYSIS_QUEUE.length - 1]) + 1;
  ANALYSIS_QUEUE.splice(i, 1);
  ANALYSIS_QUEUE.splice(dir < 0 ? 1 : ANALYSIS_QUEUE.length, 0, item);
  await putAnalysisQueueItem(item);
  renderAnalysisQueueModalIfOpen();
}

function renderAnalysisQueueModal(){
  const empty = $('analysisQueueEmpty'), table = $('analysisQueueTable'), body = $('analysisQueueBody');
  if(!ANALYSIS_QUEUE.length){
    empty.style.display=''; table.style.display='none'; body.innerHTML='';
    return;
  }
  empty.style.display='none'; table.style.display='';
  const last = ANALYSIS_QUEUE.length - 1;
  body.innerHTML = ANALYSIS_QUEUE.map((item,i) => `
    <tr data-id="${escapeHtml(item.id)}">
      <td class="aq-reorder">
        ${i >= 2 ? `<button type="button" class="aq-top" title="Move to top"><i class="fa-solid fa-angles-up"></i></button>` : ''}
        ${i >= 2 ? `<button type="button" class="aq-up" title="Raise priority"><i class="fa-solid fa-arrow-up"></i></button>` : ''}
        ${i >= 1 && i < last ? `<button type="button" class="aq-down" title="Lower priority"><i class="fa-solid fa-arrow-down"></i></button>` : ''}
        ${i >= 1 && i < last ? `<button type="button" class="aq-bottom" title="Move to bottom"><i class="fa-solid fa-angles-down"></i></button>` : ''}
        <button type="button" class="aq-del" title="Cancel"><i class="fa-solid fa-trash"></i></button>
      </td>
      <td>${aqPositionLabel(item)}</td>
      <td>depth ${item.depth}, ${item.multipv} line${item.multipv===1?'':'s'}</td>
      <td>${aqProgressHtml(item)}</td>
    </tr>`).join('');
  body.querySelectorAll('.aq-del').forEach(btn => {
    btn.onclick = () => cancelAnalysisQueueItem(btn.closest('tr').dataset.id);
  });
  body.querySelectorAll('.aq-up').forEach(btn => {
    btn.onclick = () => moveAnalysisQueueItem(btn.closest('tr').dataset.id, -1);
  });
  body.querySelectorAll('.aq-down').forEach(btn => {
    btn.onclick = () => moveAnalysisQueueItem(btn.closest('tr').dataset.id, 1);
  });
  body.querySelectorAll('.aq-top').forEach(btn => {
    btn.onclick = () => jumpAnalysisQueueItem(btn.closest('tr').dataset.id, -1);
  });
  body.querySelectorAll('.aq-bottom').forEach(btn => {
    btn.onclick = () => jumpAnalysisQueueItem(btn.closest('tr').dataset.id, 1);
  });
}

$('menuAnalysisQueue').onclick = async () => {
  $('menuList').style.display='none';
  await refreshAnalysisQueue();
  renderAnalysisQueueModal();
  populateAqThreadsSelect();   // in case the modal opens before engine.init() resolves
  $('analysisQueueOverlay').style.display='flex';
};
$('analysisQueueCloseBtn').onclick = () => { $('analysisQueueOverlay').style.display='none'; };

/* writes a completed (or partially-completed, if interrupted) search result
   for one queue item straight to IDB, gated by the same "never regress"
   rule as recordEvalIfDeeper -- but also treating "same depth, strictly more
   lines saved than before" as an improvement, since a background item's
   whole point can be raising the saved line count at a depth already
   reached. If the node belongs to whatever line is currently open, patches
   the in-memory PREFS cache too and re-renders the tree so the result shows
   up immediately without waiting for the user to reopen the line. */
async function saveAnalysisQueueResult(item, fen, result){
  const {depth, lines} = result;
  const ranks = Object.keys(lines).map(Number).sort((a,b)=>a-b);
  if(!depth || !ranks.length) return;   // interrupted before anything was reported

  const existing = await getPref(item.lineId, item.seq);
  const existingEval = existing?.eval;
  const existingLineCount = existing?.evalLines?.length || (existingEval ? 1 : 0);
  const improves = !existingEval || depth > existingEval.depth ||
    (depth === existingEval.depth && ranks.length > existingLineCount);
  if(!improves) return;

  const best = lines[ranks[0]];
  const patch = { eval: toEvalLine(best.score, best.depth, best.pv, fen) };
  if(ranks.length > 1){
    patch.evalLines = ranks.map(idx => lines[idx]).filter(l => l?.score)
      .map(l => toEvalLine(l.score, l.depth, l.pv, fen));
  }
  await setPref(item.lineId, item.seq, patch);

  if(CURRENT_LINE && CURRENT_LINE.id === item.lineId){
    const key = prefKey(item.lineId, item.seq);
    PREFS[key] = {...(PREFS[key] ?? {key, lineId:item.lineId, seq:item.seq, reply:'', note:'', mnemonic:'', hidden:false}), ...patch};
    renderTreeBody(CURRENT_LINE);
  }
}

function maybeResumeAnalysisQueue(){
  if(aqProcessing) return;
  processAnalysisQueueLoop();
}

async function processAnalysisQueueLoop(){
  if(aqProcessing) return;
  aqProcessing = true;
  try {
    while(ANALYSIS_QUEUE.length){
      // 'running' means live analysis is actively using the engine (it takes
      // precedence); 'idle' and 'stopped' both mean it's free -- 'stopped' is
      // an explicit user Stop, which hands the engine straight back to the
      // queue (resuming that live search later will transparently preempt
      // the queue again via analyze()'s own _stopCurrent()).
      if(engineState === 'running' || !engine.ready) break;
      const item = ANALYSIS_QUEUE[0];
      aqCurrentItem = item;
      aqCurrentProgress = null;
      item.status = 'processing';
      renderAnalysisQueueModalIfOpen();
      refreshAnalysisQueueRowMarkers();

      const fen = fenForSeq(item.seq);
      const legalCount = new Chess(fen).moves().length;
      const multipv = Math.max(1, Math.min(item.multipv, legalCount || item.multipv));

      let result = null;
      try {
        // aqThreads() -- the Analysis Queue modal's OWN selector, independent
        // of the live panel's -- deliberately never forces a restart of the
        // item currently processing (same "persist, never force" rule the
        // live panel's own selector follows): it's just read fresh on each
        // engine.analyze() call this loop makes, so a change while an item
        // is mid-search only takes effect once that item finishes (or the
        // next item starts). This CAN trigger analyze()'s mid-session
        // Threads-change path -- if the live panel (or a prior queue item)
        // just ran at a different thread count, this request may no longer
        // match _currentThreads. That's fine (safe now -- see analyze()'s
        // own comment); it just means a handshake beat whenever control
        // passes between two different thread-count choices. An item queued
        // via "Analyze Others" (useLiveThreads) instead rides the live
        // engine panel's own thread count -- the user is actively watching
        // it, not leaving it to churn independently in the background.
        result = await engine.analyze(fen, {
          multipv,
          depth: item.depth,
          threads: item.useLiveThreads ? engineThreads() : aqThreads(),
          onInfo: (d, lines) => {
            aqCurrentProgress = {depth: d, lines};
            renderAnalysisQueueModalIfOpen();
          }
        });
        if(result.threadsFallback){
          const {requested, using} = result.threadsFallback;
          log(`Analysis queue: ${requested} threads didn't respond in time, fell back to ${using}`, true);
        }
      } catch(err){
        console.error('[analysisQueue] search failed', err);
        log(`Analysis queue: engine search failed (${err.message}) — it may need a page reload`, true);
      }

      if(result) await saveAnalysisQueueResult(item, fen, result);

      // finished (reached target depth) vs. interrupted -- look the item up
      // by reference rather than assuming index 0, since it may have been
      // cancelled out from under this very search while it ran. Gone from
      // the array (cancelled) is a different case from still-present-but-
      // interrupted (something else claimed the engine, e.g. interactive
      // analysis): a cancel only affects this one item and the queue should
      // carry straight on to the next; an external claim means the *engine*
      // isn't free, so every remaining item has to wait -- yield and let the
      // next idle transition resume the loop instead of spinning on a busy engine.
      const finished = !!result && result.depth >= item.depth;
      const idx = ANALYSIS_QUEUE.indexOf(item);
      const cancelled = idx === -1;
      if(finished){
        if(idx !== -1){ ANALYSIS_QUEUE.splice(idx,1); await deleteAnalysisQueueItem(item.id); }
      } else if(idx !== -1){
        item.status = 'queued';
      }
      aqCurrentItem = null;
      aqCurrentProgress = null;
      renderAnalysisQueueModalIfOpen();
      refreshAnalysisQueueRowMarkers();
      // an item merely OUTRANKED -- still present but no longer at the front,
      // e.g. "Analyze Others" jumping its own items ahead of it -- resumes
      // the loop immediately for that new front item, same as a cancellation:
      // the engine IS still free, only the to-do list's order changed. Only
      // an item preempted by something outside this loop's control (the live
      // engine panel claiming the engine) with nothing reordered ahead of it
      // actually needs to wait for an external idle transition.
      const outranked = !cancelled && !finished && ANALYSIS_QUEUE[0] !== item;
      if(!finished && !cancelled && !outranked) break;
    }
  } finally {
    aqProcessing = false;
    aqCurrentItem = null;
    aqCurrentProgress = null;
  }
}

function pvToSan(fen, uciMoves, maxPlies){
  const chess = new Chess(fen);
  let moveNum = parseInt(fen.split(' ')[5], 10) || 1;
  let turn = fen.split(' ')[1];
  const parts = [];
  let first = true;
  for(const uci of uciMoves.slice(0, maxPlies)){
    const from = uci.slice(0,2), to = uci.slice(2,4), promotion = uci.slice(4,5) || undefined;
    const mv = chess.move({from,to,promotion},{sloppy:true});
    if(!mv) break;
    if(turn === 'w'){
      parts.push(`${moveNum}.${mv.san}`);
    } else {
      if(first) parts.push(`${moveNum}...${mv.san}`);
      else parts.push(mv.san);
      moveNum++;
    }
    first = false;
    turn = turn === 'w' ? 'b' : 'w';
  }
  return parts.join(' ');
}

function pvChip(label, fenAfter){
  return `<span class="pv-move" data-fen="${escapeHtml(fenAfter)}">${escapeHtml(label)}</span>`;
}

/* Like pvToSan, but emits each move as a tappable chip carrying the FEN of the
   position right after it, so a tap can float a mini board there. */
function pvChipsFromUci(fen, uciMoves, maxPlies){
  const chess = new Chess(fen);
  let moveNum = parseInt(fen.split(' ')[5], 10) || 1;
  let turn = fen.split(' ')[1];
  const chips = [];
  let first = true;
  for(const uci of uciMoves.slice(0, maxPlies)){
    const from = uci.slice(0,2), to = uci.slice(2,4), promotion = uci.slice(4,5) || undefined;
    const mv = chess.move({from,to,promotion},{sloppy:true});
    if(!mv) break;
    let label;
    if(turn === 'w') label = `${moveNum}.${mv.san}`;
    else { label = first ? `${moveNum}...${mv.san}` : mv.san; moveNum++; }
    chips.push(pvChip(label, chess.fen()));
    first = false;
    turn = turn === 'w' ? 'b' : 'w';
  }
  return chips.join(' ');
}

/* Build tappable chips from a stored SAN string (eval.pv) replayed from
   startFen. Returns null if the line can't be replayed (caller then shows the
   raw, non-tappable text — e.g. legacy evals whose start FEN we can't recover). */
function pvChipsFromSan(startFen, sanStr){
  if(!startFen || !sanStr) return null;
  let chess;
  try { chess = new Chess(startFen); } catch(_){ return null; }
  const chips = [];
  for(const tok of sanStr.trim().split(/\s+/)){
    const san = tok.replace(/^\d+\.(\.\.)?/, '');   // strip "12." / "12..." prefix
    if(!san) continue;
    const mv = chess.move(san, {sloppy:true});
    if(!mv) return null;
    chips.push(pvChip(tok, chess.fen()));
  }
  return chips.length ? chips.join(' ') : null;
}

/* replay a UCI PV from startFen into clean SAN, up to maxPlies (stops early on
   any illegal/mismatched move). Used to import an engine line into the tree. */
function pvSanFromUci(startFen, uciMoves, maxPlies){
  const chess = new Chess(startFen);
  const out = [];
  for(const u of uciMoves.slice(0, maxPlies)){
    const mv = chess.move({ from: u.slice(0,2), to: u.slice(2,4), promotion: u.slice(4,5) || undefined });
    if(!mv) break;
    out.push(mv.san);
  }
  return out;
}

/* import a whole engine variation into the open system's tree: the path from
   the root to the analysed position (startSeq) plus the engine's PV from there,
   walked exactly like a pasted variation (our moves become standard responses,
   opponent moves become manual replies). */
async function importEngineVariation(startSeq, startFen, uciMoves, maxPlies){
  if(!CURRENT_LINE){ log('open an opening system first', true); return; }
  const pv = pvSanFromUci(startFen, uciMoves, maxPlies);
  if(!pv.length){ log('nothing to import from that engine line', true); return; }
  try {
    const count = await importParsedLine([...startSeq, ...pv]);
    if(count) invalidateBuiltCastlesCache();   // writes standard responses the same way importLine does
    log(`imported ${count} move(s) from the engine line into "${CURRENT_LINE.name}"`);
    // renderTreeBody (not openLine) -- re-renders the ALREADY-open line from
    // the freshly-imported PREFS (already updated in memory by
    // importParsedLine); openLine would also call clearFocus(), silently
    // discarding whatever variation the user had focused before importing --
    // exactly the reported bug (importing from analysis losing focus).
    renderTreeBody(CURRENT_LINE);
  } catch(err){
    console.error('[importEngineVariation]', err);
    log('import failed: ' + err.message, true);
  }
}

function renderEngineLines(fen, depth, lines, multipv){
  const prefix = engineState === 'stopped' ? 'Stopped' : 'Live';
  $('engineDepth').textContent = `${prefix} — Depth ${depth}${engineModeTag()}`;
  const turn = fen.split(' ')[1];
  const ol = $('engineLines');
  ol.innerHTML = '';
  for(let i=1;i<=multipv;i++){
    const line = lines[i];
    if(!line) continue;
    const expanded = expandedPvLines.has(i);
    const pvComplete = line.pv.length >= line.depth - PV_COMPLETE_SLACK;
    const showFull = expanded && pvComplete;
    // "Import this variation" is only offered when we know the path from the
    // root to the analysed position (analysis opened from a tree row).
    const canImport = !!(currentEngineSeq && CURRENT_LINE);
    const li = document.createElement('li');
    li.innerHTML =
      (canImport
        ? `<button class="iconbtn pvMenu" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>`
        : '') +
      `<button class="iconbtn pvToggle" title="${expanded ? 'Show fewer moves' : 'Show full line'}">` +
        `<i class="fa-solid fa-caret-${expanded ? 'down' : 'right'}"></i>` +
      `</button>` +
      `<span class="pvText">${escapeHtml(formatScore(line.score,turn))}  ${pvChipsFromUci(fen,line.pv,showFull ? Infinity : ENGINE_PV_PLIES)}` +
      (expanded && !pvComplete ? ' <i>(still calculating…)</i>' : '') +
      `</span>`;
    li.querySelector('.pvToggle').onclick = () => {
      if(expanded) expandedPvLines.delete(i); else expandedPvLines.add(i);
      renderEngineLines(fen, depth, lines, multipv);
    };
    if(canImport){
      // import what's shown for this line (respects the expand toggle), captured
      // now so the rapidly-re-rendering panel can't swap it out mid-click
      const seqCopy = currentEngineSeq.slice(), fenCopy = fen, pvCopy = line.pv.slice();
      const plies = showFull ? pvCopy.length : Math.min(pvCopy.length, ENGINE_PV_PLIES);
      li.querySelector('.pvMenu').onclick = e => {
        e.stopPropagation();
        showGraphCtxMenu(e.clientX || 0, e.clientY || 0, [
          { label: '⬇ Import this variation',
            onClick: () => importEngineVariation(seqCopy, fenCopy, pvCopy, plies) },
        ]);
      };
    }
    ol.appendChild(li);
  }
}

const STARTING_FEN = new Chess().fen();

async function runEngine(fen, onEvalUpdate, onComplete){
  currentEngineFen = fen;
  // remember the callbacks so the PLAY button can resume this exact analysis
  lastOnEvalUpdate = onEvalUpdate; lastOnComplete = onComplete;
  const runId = ++engineRunId;
  console.debug(`[runEngine] runId=${runId} fen=${fen}`);
  if(fen === STARTING_FEN){
    console.debug(`[runEngine] runId=${runId} starting position, skipping analysis to save cycles`);
    engine.stop();
    setEngineUI('idle');
    $('engineDepth').textContent = '';
    $('engineLines').innerHTML = '';
    onComplete?.();
    return;
  }
  if(!engine.ready) await engine.init().catch(()=>{});
  if(runId !== engineRunId){ console.debug(`[runEngine] runId=${runId} superseded before engine ready, dropping`); return; }
  if(!engine.ready){ console.warn(`[runEngine] runId=${runId} engine never became ready, aborting`); return; }
  $('engineDepth').textContent = `Live — Thinking…${engineModeTag()}`;
  $('engineLines').innerHTML = '';
  setEngineUI('running');
  expandedPvLines.clear();
  const multipv = engineMultiPV();
  const depth = engineMaxDepth();
  const threads = engineThreads();
  console.debug(`[runEngine] runId=${runId} starting analyze multipv=${multipv} depth=${depth} threads=${threads}`);
  const t0 = performance.now();
  engine.analyze(fen, {
    multipv,
    depth,
    threads,
    onInfo: (d,lines) => {
      if(runId !== engineRunId){ console.debug(`[runEngine] runId=${runId} stale onInfo (current=${engineRunId}) ignored at depth=${d}`); return; }
      // the user hit STOP; ignore any final lines the engine emits as it halts
      // so they can't overwrite the frozen "Stopped" snapshot/label.
      if(engineState === 'stopped') return;
      renderEngineLines(fen,d,lines,multipv);
      if(onEvalUpdate && lines[1]?.score) onEvalUpdate(lines[1].depth, lines[1].score, lines[1].pv, lines);
    }
  }).then(result => {
    console.debug(`[runEngine] runId=${runId} analyze resolved after ${(performance.now()-t0).toFixed(0)}ms`, result);
    if(result.threadsFallback){
      const {requested, using} = result.threadsFallback;
      log(`Engine: ${requested} threads didn't respond in time, fell back to ${using}`, true);
    }
    // only the current run owns the status UI -- a stale run resolving (because
    // a newer search superseded it) must not touch the button the new run owns.
    // A user-initiated stop leaves the PLAY button up; a natural finish hides it.
    if(runId === engineRunId){
      if(engineState !== 'stopped') setEngineUI('idle');
      onComplete?.();
    }
  }).catch(err => {
    console.error(`[runEngine] runId=${runId} analyze failed`, err);
    log(`Engine search failed (${err.message}) — it may need a page reload`, true);
  });
}

function showPosition(fen, onEvalUpdate, onComplete, seq){
  if(!Chessboard) return;   // no board widget -> live board analysis is unavailable
  console.debug(`[showPosition] fen=${fen}`);
  currentEngineSeq = seq ? seq.slice() : null;   // enables "Import this variation" when known
  board?.setPosition(fen);
  runEngine(fen, onEvalUpdate, onComplete);
}

showPosition(new Chess().fen());

// test-only hook (mirrors __oqTestHooks/__graphTestHooks/etc.): Stockfish is
// unavailable in the offline harness (no vendored mock, same as cm-chessboard),
// so a live multi-line search can't be driven end-to-end there -- but the
// save/display logic this feature actually added (evalLines: depth-gating,
// never letting a narrower single-line re-analysis downgrade a saved
// multi-line set, and rendering them) is plain data manipulation, independent
// of the engine, and fully testable directly against a throwaway pref bag.
if(localStorage.getItem('threeTestDebug')){
  window.__evalTestHooks = {
    toEvalLine: (score, depth, uciPv, fen) => toEvalLine(score, depth, uciPv, fen),
    evalContinuationHtml: (saved, lineSeq) => evalContinuationHtml(saved, lineSeq),
    // drives the real recordEvalIfDeeper against a throwaway {eval,evalLines}
    // bag (not real PREFS/IDB), returning the bag afterward so a test can
    // assert on exactly what it decided to save.
    recordEvalIfDeeper: (fen, depth, rawScore, pv, lines, priorSaved) => {
      const bag = Object.assign({}, priorSaved);
      const saveField = (field, value) => { bag[field] = value; };
      const currentSaved = () => bag;
      recordEvalIfDeeper(saveField, currentSaved, document.createElement('span'), depth, rawScore, fen, pv, lines);
      return bag;
    },
  };
}

// test-only hook for the crop/erase image editor (js/assets.js's cropImage):
// its promise only resolves once the user clicks Save/Cancel, and it's
// normally only reachable through the full asset-upload flow -- this opens
// it directly against a synthetic data-URL and stashes the pending promise,
// so a test can drive the real DOM (brush strokes, buttons) and then await
// the actual result without needing to upload a file through the UI first.
if(localStorage.getItem('threeTestDebug')){
  window.__cropTestHooks = {
    open: (dataUrl) => { window.__cropResult = cropImage(dataUrl); },
    result: () => window.__cropResult,
  };
}

// test-only hook for the background analysis queue: add/dedup, cancel, and
// the direct-IDB-write save/depth-gating path (saveAnalysisQueueResult) are
// all plain data manipulation against real IDB (unlike the engine search
// itself, IDB works fine in the offline harness) -- only the actual
// engine.analyze() call inside processAnalysisQueueLoop needs a live
// Stockfish, which this harness can't provide, so that loop stays untested
// here (covered by manual verification instead).
if(localStorage.getItem('threeTestDebug')){
  window.__aqTestHooks = {
    getQueue: () => ANALYSIS_QUEUE,
    getCurrentItem: () => aqCurrentItem,
    addToAnalysisQueue: (lineId, seq, depth, multipv) => addToAnalysisQueue(lineId, seq, depth, multipv),
    addChildrenToAnalysisQueue: (lineId, seqs, depth, multipv) => addChildrenToAnalysisQueue(lineId, seqs, depth, multipv),
    cancelAnalysisQueueItem: (id) => cancelAnalysisQueueItem(id),
    moveAnalysisQueueItem: (id, dir) => moveAnalysisQueueItem(id, dir),
    jumpAnalysisQueueItem: (id, dir) => jumpAnalysisQueueItem(id, dir),
    maybeResumeAnalysisQueue: () => maybeResumeAnalysisQueue(),
    // drives the real live-analysis state machine (setEngineUI) so a test can
    // simulate "live analysis started" / "explicitly stopped" without needing
    // the cm-chessboard widget this harness can't load.
    setEngineUI: (state) => setEngineUI(state),
    // real engine.init() always rejects here (no live Stockfish), so it never
    // reaches populateEngineThreadsSelect() on its own -- a test monkey-patches
    // engine.multithreaded/.maxThreads/.threads first, then calls this directly.
    populateEngineThreadsSelect: () => populateEngineThreadsSelect(),
    engineThreads: () => engineThreads(),
    populateAqThreadsSelect: () => populateAqThreadsSelect(),
    aqThreads: () => aqThreads(),
    // showPosition (the normal way currentEngineFen gets set) bails out
    // without the cm-chessboard widget this harness can't load -- lets a
    // test simulate "a live analysis is in progress" for the threads
    // selector's must-not-restart-it check.
    setCurrentEngineFen: (fen) => { currentEngineFen = fen; },
    // the real Engine singleton -- since Stockfish isn't available in this
    // harness, a test monkey-patches .ready/.threads/.analyze/.stop directly
    // to fake a search in progress (analyze() returns a controllable pending
    // promise; stop() resolves it), driving the real scheduler/cancel logic
    // instead of a throwaway re-implementation of it.
    engine,
    refreshAnalysisQueue: () => refreshAnalysisQueue(),
    seqToNotation: (seq) => seqToNotation(seq),
    saveAnalysisQueueResult: (item, fen, result) => saveAnalysisQueueResult(item, fen, result),
    getPref: (lineId, seq) => getPref(lineId, seq),
    // aqProgressHtml reads the module-scoped aqCurrentItem/aqCurrentProgress
    // rather than taking them as parameters (they're also what drives the
    // live modal), so drive it the same way recordEvalIfDeeper's hook drives
    // a throwaway bag: swap them in, render, restore.
    aqProgressHtml: (item, currentItem, progress) => {
      const savedItem = aqCurrentItem, savedProgress = aqCurrentProgress;
      aqCurrentItem = currentItem; aqCurrentProgress = progress;
      try { return aqProgressHtml(item); }
      finally { aqCurrentItem = savedItem; aqCurrentProgress = savedProgress; }
    },
  };
}

// test-only hook for the move-table node statistics (three-dot menu → Node
// Statistics), so the pure tree-walk math -- especially "complete to move N"
// -- can be checked directly against the seeded PREFS without driving the
// row menu and capturing an alert.
if(localStorage.getItem('threeTestDebug')){
  window.__statsTestHooks = {
    computeNodeStats: (seq) => computeNodeStats(GAMES, seq),
  };
}

// test-only hook for the gatherBuiltCastles in-memory + persisted cache, so
// a test can confirm a second "Run VR" reuses the cached result (no
// rebuild), that the cache survives a reload, and that importBackup's
// restore (and everything else) correctly drops it.
if(localStorage.getItem('threeTestDebug')){
  window.__vrCacheTestHooks = {
    isCached: () => _builtCastlesCache !== null,
    isPersisted: async () => !!(await getMeta(BUILT_CASTLES_CACHE_KEY)),
    buildCount: () => _builtCastlesBuildCount,
    invalidate: () => invalidateBuiltCastlesCache(),
    // direct calls into the manual-reply write path (same functions the
    // row menu's "Add opponent's move" / "Remove" actions call), so cache
    // invalidation there can be checked without choreographing the full
    // branch-expand UI.
    addManualReply: (seq, move) => addManualReply(seq, move),
    removeManualReply: (seq, move) => removeManualReply(seq, move),
  };
}

// test-only hook for the mnemonics export bundle-builder, so a test can
// inspect the export-downscaled images (MNEM_EXPORT_IMG_MAX_DIM) without
// driving a real file download, and confirm the locally-stored originals
// (MNEMONICS) are left untouched by the export.
if(localStorage.getItem('threeTestDebug')){
  window.__mnemExportTestHooks = {
    build: () => buildMnemonicsExportData(),
    getStored: () => getAllMnemonics(),
    maxDim: MNEM_EXPORT_IMG_MAX_DIM,
  };
}

// test-only hook for the boot-time "install default mnemonics?" offer, which
// is skipped from the real auto-run under threeTestDebug (see the guarded
// call up near renderHome()) so a test can drive it explicitly instead --
// exercises the real committed json/repchess-mnemonics-DEFAULT.json.gz file
// end to end (fetch, gunzip, parse, import).
if(localStorage.getItem('threeTestDebug')){
  window.__mnemDefaultTestHooks = {
    offer: () => maybeOfferDefaultMnemonics(),
    offeredKey: MNEM_DEFAULT_OFFERED_KEY,
    getOffered: () => getMeta(MNEM_DEFAULT_OFFERED_KEY),
  };
}

// test-only hook for the "Games with this Position" matching/perspective math
// (pure functions over the in-memory GAMES array, no DOM/network needed).
if(localStorage.getItem('threeTestDebug')){
  window.__gamesListHooks = {
    gamesAtPosition: async (fen) => (await gamesAtPosition(GAMES, fen)).map(m => ({ id: m.game.id || null, source: m.game.source || null, move: m.move })),
    gamesAlongLine: (seq) => gamesAlongLine(GAMES, seq).map(m => ({ id: m.game.id || null, move: m.move })),
    outcome: (game) => gameOutcomeForUser(game, userColorInGame(game)),
    color: (game) => userColorInGame(game),
    link: (game) => gameLink(game),
    fenForSeq: (seq) => fenForSeq(seq),
    provider: (game) => gameSource(game),
    // position-index persistence (Phase: persisted games index) -- so a test
    // can confirm the index survives a reload instead of rebuilding, and that
    // the three real games-content-changing write paths drop it.
    isIndexPersisted: async () => !!(await getMeta(POSITION_INDEX_CACHE_KEY)),
    isIndexCachedInMemory: () => _posIndex.games === GAMES,
    invalidateIndex: () => invalidatePositionIndexCache(),
    indexBuildCount: () => _posIndexBuildCount,
    // forces a fresh (uncached) build and captures every onProgress(done,total)
    // call -- deterministic alternative to polling the DOM for the
    // "Indexing your games… N of M" text mid-build, which for a build fast
    // enough to finish inside one Playwright poll interval would be flaky.
    buildIndexWithProgress: async () => {
      invalidatePositionIndexCache();
      const calls = [];
      await positionIndex(GAMES, (done, total) => calls.push([done, total]));
      return calls;
    },
    // import-time incremental reindexing -- so a test can drive it directly
    // against a controlled games array without needing a real chess.com/
    // Lichess fetch (not mocked in this harness).
    reindexAfterImport: async (freshGames) => {
      const calls = [];
      await reindexAfterImport(freshGames, (done, total) => calls.push([done, total]));
      return calls;
    },
    gameIndexKey: (game) => gameIndexKey(game),
    indexEntryCount: () => {
      if(!_posIndex.map) return 0;
      let n = 0;
      for(const entries of _posIndex.map.values()) n += entries.length;
      return n;
    },
  };
}

// test-only hook for the games importer -- the chess.com normalization is a
// pure function (unit-testable with synthetic archive objects, no network),
// and the source-selective clear is real IDB (works in the offline harness).
if(localStorage.getItem('threeTestDebug')){
  window.__importTestHooks = {
    normalizeChessComGame: (g, moves) => normalizeChessComGame(g, moves),
    putGames: (user, games) => putGames(user, games),
    getGames: (user) => getGames(user),
  };
}

