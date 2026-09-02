import { Engine } from './engine.js?v=20260804-8';
import cytoscape from 'https://esm.sh/cytoscape@3.28.1';
import cytoscapeDagre from 'https://esm.sh/cytoscape-dagre@2.5.0?deps=cytoscape@3.28.1';
import { openThreeTest, closeThreeTest, refreshAssetsLive, setForeignModalOpen, jumpToRoom } from './threeVR.js?v=20260804-273';
import { openAssetManager, closeAssetManager, cropImage, fileToDataUrl, webpEncodeSupported, toWebpDataUrl } from './assets.js?v=20260804-79';
import { openObjectListManager, closeObjectListManager, importObjectListsData, isObjectListFile, setCastleInfoProvider, openCastleQuizPicker } from './objectLists.js?v=20260804-55';
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
const ASSETS_DEFAULT_URL = 'json/repchess-assets-DEFAULT.json.gz';
const ASSETS_DEFAULT_OFFERED_KEY = 'assetsDefaultOffered';
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
const BUILD_TAG = '-347';
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
const LS_ENGINE_LINES='engine_lastLines', LS_ENGINE_DEPTH='engine_lastDepth', LS_ENGINE_THREADS='engine_lastThreads';
const LS_AQ_THREADS='aq_lastThreads';
const LS_COMPARE_DEPTH='compare_lastDepth';
const COMPARE_DEFAULT_DEPTH=20;
const LS_OQ_QUESTIONS='oq_lastQuestions', LS_OQ_MAXDEPTH='oq_lastMaxDepth', LS_OQ_COVERAGE='oq_lastCoverage', LS_OQ_ONLYMEM='oq_onlyMemorized';
const LS_SHOW_ALL_BRANCHES='repchess_showAllBranches';
const LS_COMPACT_MODE='repchess_compactMode';
$('userIdLichess').value  = localStorage.getItem(LS_ID)  || '';
$('userIdChesscom').value = localStorage.getItem(LS_ID_CHESSCOM) || '';
$('maxGames').value= localStorage.getItem(LS_MAX)||300;

/* ---------- globals ---------- */
// there's no UI to switch between identities and never has been -- games/
// lines/the analysis queue are namespaced by a "user" key in IndexedDB
// purely as a historical artifact, so every read/write of those three
// stores just uses this same fixed constant. Your ACTUAL Lichess/chess.com
// handle (for "which color did I play in this game") lives independently in
// LS_ID/LS_ID_CHESSCOM -- see userColorInGame.
const LOCAL_USER = 'local';
let GAMES=null, PREFS={}, CURRENT_LINE=null;

// background analysis queue state (see the "background analysis queue"
// section below for the functions that use these) -- declared here, ahead
// of the boot-time refreshAnalysisQueue() call further down, so that call
// isn't reading these bindings before their own `let` would otherwise have run.
let ANALYSIS_QUEUE = [];         // mirrors the IDB store, createdAt order
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
/* Every consumer of replies() immediately merges in manualReplies (adding
   any not already present, at count 0) before using `counts` -- call this
   right after that merge to additionally strip anything NOT in
   manualReplies, for a line that opted in (line.hideUnselectedGameMoves,
   currently just Perfect Opening's own generated line). A real opponent's
   move that the search itself didn't keep would otherwise clutter an
   "objectively best" tree and, since games sort ahead of 0-count manual
   replies, could even outrank the actually-recommended one. `tot` is
   recomputed from the surviving counts so percentages stay meaningful
   against what's actually shown, not the original (larger) total. A no-op
   for every other line. */
function filterCountsForLine(counts, tot, manualReplies, line){
  if(!line?.hideUnselectedGameMoves) return {counts, tot};
  const filtered = {};
  for(const m of manualReplies) filtered[m] = counts[m] ?? 0;
  return {counts: filtered, tot: Object.values(filtered).reduce((a,b)=>a+b, 0)};
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
  let counts = replies(games,seq).counts;
  const manualReplies = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
  manualReplies.forEach(m=>{ if(!(m in counts)) counts[m]=0; });
  counts = filterCountsForLine(counts, 0, manualReplies, CURRENT_LINE).counts;

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
    const parsed = JSON.parse(raw);
    // Version-stamped, same as the built-castles cache: a persisted index built
    // by a DIFFERENT build (or the legacy bare-array format that predates the
    // stamp) is ignored and rebuilt. positionKey feeds this index, so a code
    // change to the position-identity rule -- e.g. the phantom-en-passant fix --
    // would otherwise leave "Games with this Position" matching a stale index
    // until the games array next changed, with no error anywhere.
    if(!parsed || parsed.version !== BUILD_TAG || !Array.isArray(parsed.data)){
      console.warn(`[games index] persisted index is from a different build (${parsed && parsed.version}, want ${BUILD_TAG}) -- rebuilding`);
      return;
    }
    const map = new Map(parsed.data);
    // Secondary shape check (belt-and-suspenders behind the version stamp): the
    // very first version of this format (before gameIndexKey existed) stored
    // entries as {g:arrayIndex, move} instead of {key:gameIndexKey, move}. A
    // blob in that shape would otherwise load silently and EVERY lookup would
    // quietly return zero matches (gamesAtPosition's byKey.get(undefined) for
    // every hit) -- "Games with this Position" reporting none for a position
    // that obviously has some. Bail to a fresh rebuild rather than trust a
    // shape this build's code doesn't read.
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
  setMeta(POSITION_INDEX_CACHE_KEY, JSON.stringify({ version: BUILD_TAG, data: [...map] }));   // fire-and-forget: persist across reloads (stamped so a new build rebuilds)
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
  setMeta(POSITION_INDEX_CACHE_KEY, JSON.stringify({ version: BUILD_TAG, data: [..._posIndex.map] }));   // fire-and-forget: persist across reloads (stamped so a new build rebuilds)
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
// {moves} game, or someone else's game). Matches against whichever handle is
// remembered for THIS game's own platform (LS_ID_CHESSCOM / LS_ID, kept
// current on every download in dlBtn and restored from a backup's own
// lichessUser/chesscomUser fields) -- each platform's identity is independent,
// so a chess.com game never matches against your Lichess handle or vice versa.
function userColorInGame(game){
  const mine = localStorage.getItem(game.source === 'chesscom' ? LS_ID_CHESSCOM : LS_ID);
  if(!mine) return null;
  const name = mine.toLowerCase();
  const w = game.players?.white?.user?.name?.toLowerCase();
  const b = game.players?.black?.user?.name?.toLowerCase();
  if(w === name) return 'white';
  if(b === name) return 'black';
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

/* ---------- auto-import sizing ----------
   Auto-import (see the daily-check phase, further down) needs to guess how
   far back to look for a platform it hasn't checked since some earlier day --
   "the last N months" for chess.com's month-archive API, "the last N games"
   for Lichess's count-based one. Both estimates are deliberately biased to
   overshoot: putGames upserts by id, so re-fetching a game already stored
   costs a little bandwidth and nothing else, while undershooting silently
   drops games until the NEXT daily check happens to cover them. Each has its
   own floor (a light day/short absence still gets fully covered) and cap (a
   multi-month absence doesn't balloon into one enormous request -- the next
   several days' checks catch up incrementally instead).
*/
const CHESSCOM_AUTO_MIN_MONTHS = 1, CHESSCOM_AUTO_MAX_MONTHS = 24, CHESSCOM_AUTO_DEFAULT_MONTHS = 12;
const LICHESS_AUTO_MIN_GAMES = 50, LICHESS_AUTO_MAX_GAMES = 1000, LICHESS_AUTO_DEFAULT_GAMES = 300;
const LICHESS_AUTO_GAMES_PER_DAY = 150;   // generous -- see file doc comment above

// epoch ms of the newest game from `source` in `games`, or null if there are
// none yet (a platform that's never been imported at all).
function lastGameDateForSource(games, source){
  let latest = null;
  for(const g of games){
    if(gameSource(g) !== source) continue;
    if(g.createdAt && (latest == null || g.createdAt > latest)) latest = g.createdAt;
  }
  return latest;
}
function daysSinceEpoch(epochMs){
  return Math.max(0, (Date.now() - epochMs) / 86400000);
}
// "the last N months" for a due chess.com auto-check, from how long it's
// been since the newest chess.com game already on file. No prior chess.com
// game at all (never imported from this platform before) falls back to the
// same default the manual download modal already offers.
function estimateChessComAutoMonths(games){
  const last = lastGameDateForSource(games, 'chesscom');
  if(last == null) return CHESSCOM_AUTO_DEFAULT_MONTHS;
  const months = Math.ceil(daysSinceEpoch(last) / 30) + 1;   // +1 month buffer past the exact boundary
  return Math.min(CHESSCOM_AUTO_MAX_MONTHS, Math.max(CHESSCOM_AUTO_MIN_MONTHS, months));
}
// "the last N games" for a due Lichess auto-check, same reasoning as above.
function estimateLichessAutoMaxGames(games){
  const last = lastGameDateForSource(games, 'lichess');
  if(last == null) return LICHESS_AUTO_DEFAULT_GAMES;
  const estimate = Math.ceil(daysSinceEpoch(last) * LICHESS_AUTO_GAMES_PER_DAY);
  return Math.min(LICHESS_AUTO_MAX_GAMES, Math.max(LICHESS_AUTO_MIN_GAMES, estimate));
}

/* ---------- auto-import daily gate ----------
   "Once a day, per platform" is tracked as a plain local-calendar-date
   string (toDateString(), e.g. "Mon Aug 04 2026") rather than a rolling
   24h window -- matches "the first time I refresh each day" literally, and
   is simpler to reason about than a timestamp diff. Stamped only on a
   SUCCESSFUL fetch+merge (see the boot-trigger phase), not on mere attempt,
   so a transient failure (offline, rate-limited, API hiccup) retries on the
   next refresh instead of waiting a full day.
*/
const LS_AUTO_IMPORT = 'autoImport_enabled';
const LS_AUTO_CHECK_LICHESS = 'autoImport_lastCheck_lichess';
const LS_AUTO_CHECK_CHESSCOM = 'autoImport_lastCheck_chesscom';
function autoCheckKeyFor(source){
  return source === 'chesscom' ? LS_AUTO_CHECK_CHESSCOM : LS_AUTO_CHECK_LICHESS;
}
// true when `source` is due for an auto-check right now: the feature is
// enabled, this platform actually has a remembered username (auto-import
// never fetches a platform you've never connected), and it hasn't
// successfully checked yet today.
function shouldAutoCheck(source){
  if(localStorage.getItem(LS_AUTO_IMPORT) !== '1') return false;
  const username = localStorage.getItem(source === 'chesscom' ? LS_ID_CHESSCOM : LS_ID);
  if(!username) return false;
  const lastCheck = localStorage.getItem(autoCheckKeyFor(source));
  return lastCheck !== new Date().toDateString();
}
function markAutoCheckSucceeded(source){
  localStorage.setItem(autoCheckKeyFor(source), new Date().toDateString());
}

// Console utility (always available, not gated behind threeTestDebug -- this
// is for real day-to-day use in an actual browser session, not just the
// offline test harness): clears one or both platforms' "already checked
// today" flag, so a manual sanity check ("play a few Lichess games, run
// this, refresh, confirm they show up") doesn't have to wait for the next
// real day to roll over. `source` is optional -- omit it to reset both.
window.autoImportResetToday = (source) => {
  const sources = source ? [source] : ['lichess', 'chesscom'];
  for(const s of sources) localStorage.removeItem(autoCheckKeyFor(s));
  console.log(`[auto-import] cleared today's check flag for: ${sources.join(', ')} -- the next refresh will re-check ${sources.length > 1 ? 'them' : 'it'} (if enabled and a username is remembered).`);
};

/* ---------- auto-import diagnostic logging ----------
   Detailed console logging (what fired, why, new-vs-duplicate game counts,
   the most recent game on file per platform) so the feature's behavior can
   be sanity-checked over the first several days of real use without any UI.
   Gated on a persisted flag, defaulting ON for that initial soak-testing
   period -- meant to be turned off via autoImportSetVerbose(false) once the
   feature's been trusted for a while, but left in the code for future
   debugging rather than removed outright.
*/
const LS_AUTO_IMPORT_VERBOSE = 'autoImport_verboseLogging';
function isAutoImportVerbose(){
  return localStorage.getItem(LS_AUTO_IMPORT_VERBOSE) !== '0';
}
function autoImportLog(...args){
  if(isAutoImportVerbose()) console.log('[auto-import]', ...args);
}
window.autoImportSetVerbose = (on) => {
  localStorage.setItem(LS_AUTO_IMPORT_VERBOSE, on ? '1' : '0');
  console.log(`[auto-import] verbose logging ${on ? 'enabled' : 'disabled'}.`);
};

// Fetches the latest games for one platform and merges them into local
// storage -- the shared core of BOTH the manual "Import Now" button (dlBtn)
// and the background auto-import trigger, so both stay on exactly one
// fetch/store/reindex code path instead of two that could drift apart.
// `sizeParam` is months-back for chess.com, max-games for Lichess (matching
// fetchChessCom/fetchLatest's own parameter) -- the CALLER decides what that
// number should be (a manual field's value, or an auto-sized estimate) and
// whether to persist it as a future default; this function only acts on it,
// and doesn't touch any UI (no modal-closing, no re-render) -- the caller's
// job, since a background auto-check must never disrupt whatever's on screen.
async function importGamesFromPlatform(source, username, sizeParam, { onFetchProgress, onIndexProgress } = {}){
  const fetched = source === 'chesscom'
    ? await fetchChessCom(username, sizeParam, onFetchProgress)
    : await fetchLatest(username, sizeParam, onFetchProgress);

  const existingKeys = new Set((GAMES || []).map(gameIndexKey));
  const newCount = fetched.filter(g => !existingKeys.has(gameIndexKey(g))).length;
  const duplicateCount = fetched.length - newCount;
  autoImportLog(`[${source}] fetched ${fetched.length} game(s): ${newCount} new, ${duplicateCount} already had`);

  await putGames(LOCAL_USER, fetched);
  GAMES = await getGames(LOCAL_USER);
  invalidateBuiltCastlesCache();   // a changed game set can change which opponent replies are frequent enough to be visible
  await reindexAfterImport(GAMES, onIndexProgress);

  const latest = lastGameDateForSource(GAMES, source);
  autoImportLog(`[${source}] most recent game on file: ${latest ? new Date(latest).toLocaleString() : '(none)'}`);

  return { fetchedCount: fetched.length, newCount, duplicateCount, totalGames: GAMES.length };
}

// The boot-time trigger: called fire-and-forget, once, right after the app's
// normal first render -- see its own call site's comment. MUST NOT throw
// uncaught (nothing awaits this) and MUST NOT force any re-render, open a
// modal, or alert(): a background daily check has to stay out of the way of
// whatever's already on screen, same principle as the Object List Manager's
// own background usage-scan fix. The one exception is the existing #progress
// status line (the same passive, easy-to-ignore banner boot-time recovery
// already uses) -- only touched when there's actually something to report
// (new games found), left completely alone otherwise. Checks both platforms
// independently; one platform's failure doesn't stop the other from being
// checked.
async function runAutoImportCheck(){
  if(!GAMES) GAMES = await getGames(LOCAL_USER);
  autoImportLog('daily check starting…');
  const newGamesBySource = [];
  for(const source of ['lichess', 'chesscom']){
    const username = localStorage.getItem(source === 'chesscom' ? LS_ID_CHESSCOM : LS_ID);
    if(!shouldAutoCheck(source)){
      const reason = localStorage.getItem(LS_AUTO_IMPORT) !== '1' ? 'feature disabled'
        : !username ? 'no remembered username'
        : 'already checked today';
      autoImportLog(`[${source}] skipped -- ${reason}`);
      continue;
    }
    const sizeParam = source === 'chesscom' ? estimateChessComAutoMonths(GAMES) : estimateLichessAutoMaxGames(GAMES);
    autoImportLog(`[${source}] due -- fetching as "${username}", requesting ${sizeParam} ${source === 'chesscom' ? 'month(s) back' : 'game(s) max'}`);
    try {
      const result = await importGamesFromPlatform(source, username, sizeParam);
      markAutoCheckSucceeded(source);
      autoImportLog(`[${source}] check succeeded: ${result.newCount} new game(s), ${result.duplicateCount} already had`);
      if(result.newCount > 0) newGamesBySource.push({ source, newCount: result.newCount });
    } catch(err){
      // deliberately NOT marking today's check done -- see markAutoCheckSucceeded's
      // own doc comment: a transient failure should retry on the next refresh,
      // not wait a full day. Console-only -- a transient hiccup that's about
      // to retry isn't worth alarming the user over.
      console.error(`[auto-import] [${source}] check failed`, err);
      autoImportLog(`[${source}] check FAILED: ${err.message} -- will retry on the next refresh`);
    }
  }
  if(newGamesBySource.length){
    const label = { lichess: 'Lichess', chesscom: 'chess.com' };
    const parts = newGamesBySource.map(r => `${r.newCount} from ${label[r.source]}`);
    log(`Auto-imported ${parts.join(', ')}`);
  }
}

if(localStorage.getItem('threeTestDebug')){
  window.__autoImportTestHooks = {
    lastGameDateForSource: (games, source) => lastGameDateForSource(games, source),
    estimateChessComAutoMonths: (games) => estimateChessComAutoMonths(games),
    estimateLichessAutoMaxGames: (games) => estimateLichessAutoMaxGames(games),
    defaults: {
      chesscomMin: CHESSCOM_AUTO_MIN_MONTHS, chesscomMax: CHESSCOM_AUTO_MAX_MONTHS, chesscomDefault: CHESSCOM_AUTO_DEFAULT_MONTHS,
      lichessMin: LICHESS_AUTO_MIN_GAMES, lichessMax: LICHESS_AUTO_MAX_GAMES, lichessDefault: LICHESS_AUTO_DEFAULT_GAMES,
      lichessPerDay: LICHESS_AUTO_GAMES_PER_DAY,
    },
    shouldAutoCheck: (source) => shouldAutoCheck(source),
    markAutoCheckSucceeded: (source) => markAutoCheckSucceeded(source),
    keys: { autoImport: LS_AUTO_IMPORT, lichessCheck: LS_AUTO_CHECK_LICHESS, chesscomCheck: LS_AUTO_CHECK_CHESSCOM },
    importGamesFromPlatform: (source, username, sizeParam) => importGamesFromPlatform(source, username, sizeParam),
    isAutoImportVerbose: () => isAutoImportVerbose(),
    runAutoImportCheck: () => runAutoImportCheck(),
    getGames: () => getGames(LOCAL_USER),
  };
}

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
// true while a position-index build is in flight -- typing (or clicking mode/
// color) during that window used to queue up another renderGamesList() per
// keystroke, each re-checking _posIndex.games (still stale until the FIRST
// build finishes) and kicking off its own redundant full rebuild concurrently
// with the others, compounding into many seconds of visible per-keystroke lag
// on a large game database. Locking the controls for the one-time build makes
// each keystroke's own render wait its turn instead of piling on.
let _gamesIndexBusy = false;
function setGamesControlsDisabled(disabled){
  $('gamesListMovesInput').disabled = disabled;
  $('gamesModePos').disabled = disabled;
  $('gamesModeLine').disabled = disabled;
  document.querySelectorAll('.games-color-btn').forEach(b => b.disabled = disabled);
}
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
  if(!GAMES){ GAMES = await getGames(LOCAL_USER); }
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
  if(_gamesIndexBusy) return;   // a build from an earlier call is already running -- its own completion re-renders
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
  if(needsIndex){
    _gamesIndexBusy = true;
    setGamesControlsDisabled(true);
    body.innerHTML = '<div class="games-list-empty">Indexing your games…</div>';
    await nextPaint();
  }

  // only games where the user was actually playing the selected color count
  // as "my games" here -- gamesAtPosition/gamesAlongLine match purely on
  // position/move-text, so without this a game the user reached via the same
  // moves while playing the OTHER side (their opponent's choice, not theirs)
  // would get shown and counted as if it were their own practice. A game
  // whose color can't be determined at all (a legacy bare chess.com import)
  // is excluded even for "Either" -- it can't be confirmed to be the user's
  // own game at all, regardless of which side.
  let rawMatches;
  try {
    rawMatches = mode === 'pos' ? await gamesAtPosition(GAMES, fen, showIndexingProgress) : gamesAlongLine(GAMES, seq);
  } finally {
    if(needsIndex){
      _gamesIndexBusy = false;
      setGamesControlsDisabled(false);
      $('gamesListMovesInput').focus();
    }
  }
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
  // (board, side-to-move, castling, en-passant) -- but the en-passant field
  // needs care. FEN records an en-passant target square after ANY pawn
  // double-push, even when no enemy pawn can actually capture there. So two
  // move orders that transpose into the byte-for-byte identical board can
  // still disagree on this one field: whichever order played the double-push
  // LAST carries the target square, the other (which pushed that pawn earlier)
  // does not. That "phantom" square never gets exercised -- the position plays
  // identically either way -- yet keying on it splits one true position into
  // two separate rooms, each with its own walls/floor/decorations/nudges
  // depending on which door you came through (exactly the reported bug). Strip
  // a phantom target so the key matches how the position really plays; a
  // genuinely capturable en-passant still distinguishes positions (it changes
  // the legal moves) and is kept.
  const parts = fen.split(' ');
  const ep = parts[3];
  if(ep && ep !== '-'){
    const file = ep.charCodeAt(0) - 97;   // 'a'..'h' -> 0..7
    const rank = ep.charCodeAt(1) - 48;   // 3 (a white pawn pushed) or 6 (black)
    const rows = parts[0].split('/');      // rows[0]=rank 8 .. rows[7]=rank 1
    const pieceAt = (r, f) => {            // piece char at board rank r (1-8), file f, or ''
      const row = rows[8 - r];
      if(!row) return '';
      let col = 0;
      for(const ch of row){
        if(ch >= '1' && ch <= '8') col += ch.charCodeAt(0) - 48;
        else { if(col === f) return ch; col++; }
        if(col > f) break;
      }
      return '';
    };
    // the only pawn that could capture en-passant sits beside the just-pushed
    // pawn: on rank 4 (a black pawn, if White pushed to the rank-3 target) or
    // rank 5 (a white pawn, if Black pushed to the rank-6 target).
    const capRank = rank === 3 ? 4 : 5;
    const capPawn = rank === 3 ? 'p' : 'P';
    const capturable = (file > 0 && pieceAt(capRank, file - 1) === capPawn)
                    || (file < 7 && pieceAt(capRank, file + 1) === capPawn);
    if(!capturable) parts[3] = '-';
  }
  return parts.slice(0, 4).join(' ');
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
    // a room the user has manually flagged "redirect to castle X" (Attributes
    // modal, see refreshRedirectField) is a DELIBERATE, user-declared
    // transposition -- same treatment as the automatic foreign-root case just
    // below (stop here, point at the target's own room instead of building a
    // duplicate), except the target can live in any line, not just this one,
    // so its instance id is built from the stored redirectTargetLineId rather
    // than always this castle's own line.id.
    if(exitPref.redirectToCastle){
      const targetLineId = exitPref.redirectTargetLineId || line.id;
      const foreignKey = castleRoomKey(castleInstanceId(targetLineId, exitPref.redirectToCastle), positionKey(fenForSeq(destSeq)));
      addEdge(fromRoomId, null, exitSeq, destSeq, { foreignCastle: exitPref.redirectToCastle, foreignKey, count, tot });
      return;
    }
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
    let {counts, tot} = replies(games,seq);
    const manualReplies = PREFS[prefKey(line.id,seq)]?.manualReplies || [];
    manualReplies.forEach(m=>{ if(!(m in counts)) counts[m]=0; });
    ({counts, tot} = filterCountsForLine(counts, tot, manualReplies, line));
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
    let {counts} = replies(games,seq);
    const manualReplies = PREFS[prefKey(line.id,seq)]?.manualReplies || [];
    manualReplies.forEach(m=>{ if(!(m in counts)) counts[m]=0; });
    counts = filterCountsForLine(counts, 0, manualReplies, line).counts;
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
// Builds the frozen-adjacency lookup Phase 3 of memorized-room-stability
// needs: for every memorized 'corridor'/'two-track' room belonging to this
// castle instance, which live edges still count as that room's ORIGINAL
// chain-forming links (so analyzeCastleStructure keeps treating them as such
// even once a node they pass through gains an extra live edge), and which
// live edges are new/"excess" and should fall out as ordinary exits instead.
// 'branch'/'room' snapshots are skipped -- they have no restructuring risk to
// protect against (Phase 2 already flags them via isRoomDirty, no regen
// change needed). Keyed off MEMORIZED_SHAPES (an app.js-local mirror of
// threeVR.js's own store, same independent-read convention as
// MEMORIZED_ROOMS/DECORATED_ROOMS) -- entries whose node posKeys no longer
// exist in the live graph (e.g. a deleted variation) are silently skipped
// rather than erroring; they simply can't protect anything anymore.
function buildFrozenAdjacency(instanceId, idByPosKey){
  const prefix = `cas:${instanceId}:`;
  const frozenChainEdge = new Map();     // live node id -> live node id (the one edge that still counts as a chain link)
  const frozenTwoTrackKids = new Map();  // live node id (head) -> Set of live node ids (its frozen two children)
  const chainLinks = arr => { for(let i=0;i<arr.length-1;i++){
    const a = idByPosKey.get(arr[i]), b = idByPosKey.get(arr[i+1]);
    if(a != null && b != null) frozenChainEdge.set(a, b);
  } };
  for(const roomKey in MEMORIZED_SHAPES){
    if(!roomKey.startsWith(prefix)) continue;
    const snap = MEMORIZED_SHAPES[roomKey];
    if(!snap || !snap.anchorPosKey) continue;
    if(snap.kind === 'two-track'){
      const headId = idByPosKey.get(snap.anchorPosKey);
      if(headId == null) continue;
      const kids = [];
      if(snap.left && snap.left.length){ const id = idByPosKey.get(snap.left[0]); if(id != null) kids.push(id); }
      if(snap.right && snap.right.length){ const id = idByPosKey.get(snap.right[0]); if(id != null) kids.push(id); }
      if(kids.length === 2) frozenTwoTrackKids.set(headId, new Set(kids));
      chainLinks(snap.left || []);
      chainLinks(snap.right || []);
    } else if(snap.kind === 'corridor'){
      chainLinks(snap.members || []);
    }
  }
  return { frozenChainEdge, frozenTwoTrackKids };
}

function buildGeneratedCastle(line, games, rootSeq, ownCastleName=null){
  // leadIn=false: start the mansion at its root room, not at the opening moves
  // that lead into it (those would otherwise show as a lead-in corridor).
  const graph = buildCastleGraph(line, games, rootSeq, false, ownCastleName);
  const idByPosKey = new Map(graph.rooms.map(r => [positionKey(r.fen), r.id]));
  const instanceId = castleInstanceId(line.id, ownCastleName || '');
  const frozen = buildFrozenAdjacency(instanceId, idByPosKey);
  const a = analyzeCastleStructure(graph, frozen);
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
    // which of THIS room's own wall slots (see the `pairs` loop below, whose
    // side/order assignment this mirrors) the exit's source member occupies --
    // 'center' for the anchor/head, otherwise 'left'/'right' with a 1-based
    // order matching mnemPairLayout's (side, order) lookup in threeVR.js. Lets
    // an interior side-door (memorized-room-stability Phase 3) get positioned
    // near its sibling member's own slot instead of the generic door-hash
    // placement, which only ever made sense when every door in a room
    // belonged to the same single anchor member. null for a member somehow
    // missing from this room's own arrays (shouldn't happen).
    const memberSideOrder = id => {
      if(g.kind === 'two-track'){
        if(id === g.head) return { side: 'center', order: 1 };
        const li = g.left.indexOf(id); if(li >= 0) return { side: 'left', order: li + 1 };
        const ri = g.right.indexOf(id); if(ri >= 0) return { side: 'right', order: ri + 1 };
        return null;
      }
      const mi = g.members.indexOf(id);
      if(mi < 0) return null;
      return mi === 0 ? { side: 'center', order: 1 } : { side: 'left', order: mi };
    };
    const exits = [];
    for(const e of graph.edges){
      if(!memberSet.has(e.source)) continue;
      const track = trackOf(e.source);
      const from = memberSideOrder(e.source);
      // "N (M%)" -- how often this exact opponent reply has actually occurred
      // in the user's own games, out of this room's total recorded
      // continuations, so the VR door plaque / digraph edge can show it.
      const occurrence = formatOccurrence(e.count, e.tot);
      if(e.foreignKey){
        // this edge crosses into another castle's own room (see processExit's
        // redirect in buildCastleGraph) -- `to`/`toKey` stay null (nothing of
        // ours to point at); `foreignKey` is the real destination.
        exits.push({ opp: e.label, to: null, foreignCastle: e.foreignCastle, foreignKey: e.foreignKey,
                     pair: pairFromSeq(e.destSeq), track, occurrence, fromSide: from?.side, fromOrder: from?.order });
        continue;
      }
      if(leafIds.has(e.target)){
        exits.push({ opp: e.label, to: null, track, occurrence, fromSide: from?.side, fromOrder: from?.order });
        continue;
      }
      const tgt = genIdOf(e.target);
      if(tgt === gid) continue;   // internal link inside a corridor / two-track
      // `to` is the R# label (for the readable report); `toKey` is the stable
      // position identity the VR uses to wire doors + persist decorations.
      exits.push({ opp: e.label, to: labelOf.get(tgt) || null, toKey: posKeyByGid.get(tgt) || null,
                   // edge-specific move pair, shown beside this door in the VR walk
                   pair: pairFromSeq(e.destSeq), track, occurrence, fromSide: from?.side, fromOrder: from?.order });
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
    // frozen-shape snapshot for the memorized-room-stability feature: captured
    // (by threeVR.js's toggleMemorized, into MEMORIZED_SHAPES) when the user
    // marks a room memorized, then consulted on a later regen both to detect
    // a new variation landing inside an already-memorized room (Phase 2,
    // non-linear rooms) and to keep a memorized linear room's shape intact
    // via a side-door instead of splitting it (Phase 3, see
    // buildFrozenAdjacency). members/left/right/anchorPosKey are position
    // keys, in walk order, so identity survives node-id churn across
    // regenerations the same way posKeyByGid already does. anchorPosKey is
    // this room's own posKey, stored explicitly because the sanitized
    // roomKey string it's normally embedded in isn't reliably reversible.
    const memberPosKey = id => positionKey(nodeById.get(id).fen);
    const shape = g.kind === 'two-track'
      ? { kind: 'two-track', left: g.left.map(memberPosKey), right: g.right.map(memberPosKey) }
      : { kind: g.kind, members: g.members.map(memberPosKey) };
    shape.anchorPosKey = posKeyByGid.get(gid);
    shape.exitPosKeys = exits.filter(e => e.toKey).map(e => e.toKey);
    return { id: labelOf.get(gid), posKey: posKeyByGid.get(gid), type: g.kind, name: meta.name, castle: meta.castle,
             // the room's own full seq (ending in OUR reply, one ply past
             // nameSeq) -- the same identity focusOnLine/FOCUSED_SEQ uses for
             // a row's "Focus on this Variation", so the move table's "Show
             // Castle" dropdown can jump straight to a named room's row.
             seq: anchor.seq, nameSeq, memberCount: g.members.length, moveCount, walls, exits, pairs, shape };
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
   so the two always agree. See LinearSequencesAndRoomObjects.md.
   `frozen` (optional, see buildFrozenAdjacency) is the memorized-room-
   stability Phase 3 hook: when a node's outgoing edge is protected by a
   memorized snapshot, that ONE edge participates in chain/two-track
   detection as if it were still the node's only edge, regardless of what its
   live out-degree actually is now -- any other live edge from that node
   falls through untouched as an ordinary edge, which the caller's own exits
   computation already turns into a ordinary door (a "side-door") for free,
   since it isn't internal to the box either. Only ever passed by
   buildGeneratedCastle, which knows a single castle instance; the network
   graph's own call (potentially spanning multiple castle instances at once)
   passes nothing and gets today's unprotected behavior. */
function analyzeCastleStructure(graph, frozen=null){
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
    const frozenTarget = frozen && frozen.frozenChainEdge.get(e.source);
    if(frozenTarget != null){
      if(e.target !== frozenTarget) continue;   // an extra edge beyond the frozen one -- not a chain link, falls through as a plain exit
    } else if(outDeg.get(e.source) !== 1) continue;
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
    const frozenKids = frozen && frozen.frozenTwoTrackKids.get(H.id);
    let t1, t2;
    if(frozenKids){
      // memorized two-track head: qualify on its ORIGINAL two children, no
      // matter how many live children H has now -- both must still actually
      // be live edges from H (a deleted variation could have removed one).
      const live = new Set(outTargets.get(H.id) || []);
      const kids = [...frozenKids].filter(id => live.has(id));
      if(kids.length !== 2) return;
      [t1, t2] = kids;
    } else {
      if(outDeg.get(H.id) !== 2) return;
      [t1, t2] = outTargets.get(H.id) || [];
    }
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
// re-reads memorized-room progress and, if the move table is the screen
// underneath, re-renders it so a room just memorized/unmemorized in VR shows
// its new green/plain state (refreshBranchName) the moment you close VR,
// rather than only after the digraph is next opened (which does its own
// independent loadMemorizedRooms call) or the line is reopened.
async function refreshMemorizedRoomsAndTree(){
  await loadMemorizedRooms();
  if(CURRENT_LINE) renderTreeBody(CURRENT_LINE);
}
// "fully decorated" room progress (see js/threeVR.js's own DECORATED, which
// this mirrors) -- same independent-read pattern as MEMORIZED_ROOMS above.
let DECORATED_ROOMS = {};
async function loadDecoratedRooms(){
  try { DECORATED_ROOMS = JSON.parse(await getMeta('threeDecoratedRooms') || '{}'); }
  catch { DECORATED_ROOMS = {}; }
}
// frozen shape snapshots for memorized rooms (see js/threeVR.js's own
// MEMORIZED_SHAPES, which this mirrors) -- same independent-read pattern.
// Used by isRoomDirty below to badge a memorized room whose live shape has
// picked up a new exit since it was last memorized.
let MEMORIZED_SHAPES = {};
async function loadMemorizedShapes(){
  try { MEMORIZED_SHAPES = JSON.parse(await getMeta('threeMemorizedShapes') || '{}'); }
  catch { MEMORIZED_SHAPES = {}; }
}
// Mirrors threeVR.js's own isRoomDirty (see its longer comment for the
// Phase-3-closed-the-gap reasoning behind covering linear rooms too).
// `liveShape` is the room's shape.exitPosKeys as computed by THIS regen
// (buildGeneratedCastle), passed in by the caller since it already has it in
// hand from the coverage-stats loop -- no need to recompute here.
// CAVEAT specific to this copy: this file's buildGeneratedCastle calls never
// pass the frozen-adjacency map (a single castle instance's worth doesn't
// apply cleanly to the network graph, which can span several at once -- see
// buildFrozenAdjacency's own comment), so a memorized linear room whose
// interior branch landed exactly on its own anchor can still show a KIND
// mismatch here (the unprotected view reclassifies it as 'branch') even
// though the protected VR view correctly keeps it 'corridor' and flags it
// dirty there. That specific case silently reads as not-dirty in the
// digraph; every other linear-room case (branch anywhere else in the room)
// is unaffected, since only an anchor-level branch changes kind.
function isRoomDirty(roomKey, liveShape){
  const snap = MEMORIZED_SHAPES[roomKey];
  if(!snap || !liveShape || snap.kind !== liveShape.kind) return false;
  const known = new Set(snap.exitPosKeys || []);
  return (liveShape.exitPosKeys || []).some(k => !known.has(k));
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
    await loadMemorizedShapes();
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
    // roomKey -> this regen's live shape, gathered while we're already
    // iterating every generated room below -- reused by isRoomDirty in the
    // node-labeling loop further down instead of a second buildGeneratedCastle
    // pass per castle.
    const liveShapeByRoomKey = new Map();
    for(const name of castleNames){
      const castleRootSeq = castleRootRoomSeq(name);
      if(!castleRootSeq) continue;
      const { genRooms } = buildGeneratedCastle(CURRENT_LINE, gamesForLineColor(GAMES, CURRENT_LINE.color), castleRootSeq, name);
      totalCastleRooms += genRooms.length;
      const instanceId = castleInstanceId(CURRENT_LINE.id, name);
      for(const gr of genRooms){
        totalCastleMoves += gr.moveCount;
        const roomKey = castleRoomKey(instanceId, gr.posKey);
        liveShapeByRoomKey.set(roomKey, gr.shape);
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
        // dirty (Phase 2 of memorized-room-stability): a memorized non-linear
        // room that's picked up a new door since it was last memorized -- see
        // isRoomDirty for why linear rooms aren't covered yet.
        const dirty = memorized && roomKey && isRoomDirty(roomKey, liveShapeByRoomKey.get(roomKey));
        // 🧠 (memorized) / 🎨 (decorated) / ⚠️ (dirty) glyphs read at normal
        // zoom; the "all done" border (below) is the zoomed-out signal, so
        // all glyphs still show even when it's also on.
        const moveLabel = r.label + (q ? ' ' + q : '') + (memorized ? ' 🧠' : '') + (decorated ? ' 🎨' : '') + (dirty ? ' ⚠️' : '');
        const data = {id:r.id, label: name ? `${moveLabel}\n${name}` : moveLabel, fen:r.fen, seq:r.seq};
        if(!flat && boxOf.has(r.id)) data.parent = boxOf.get(r.id);   // box this room into its run / two-track room
        Object.assign(data, boxMemberInfo(r));   // track/chainIdx for "Arrange" (no-op if not boxed)
        data.roomKey = roomKey;   // exposed for the test hook / room-info panel use
        data.dirty = dirty;      // exposed for the test hook, same reasoning as data.roomKey above
        // native browser tooltip text (see attachGraphHoverTooltip) -- only
        // the dirty glyph needs one; everything else on the node already
        // reads for itself (the move label, the room name).
        if(dirty) data.tooltip = 'This room changed since it was memorized -- a new door was added.';
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
    attachGraphHoverTooltip(cy);

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
// A native browser tooltip for the dirty (⚠️) glyph explaining what it means
// -- just the container's own `title` attribute, toggled on node hover, so
// it's the browser's standard hover-delay tooltip (no custom popup/position
// tracking needed, unlike showGraphNodePosition's board preview, which was
// deliberately moved OFF hover because a full interactive preview was too
// easy to trigger by accident -- plain text on the native tooltip doesn't
// have that problem). Only nodes carrying data('tooltip') (currently just
// dirty rooms) get one; every other node clears it back to empty on hover.
function attachGraphHoverTooltip(cy){
  cy.on('mouseover', 'node', evt => { cy.container().title = evt.target.data('tooltip') || ''; });
  cy.on('mouseout', 'node', () => { cy.container().title = ''; });
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
// Closing on a "click the dark backdrop" gesture misfires on an ordinary
// text-selection DRAG that starts inside the moves-filter input (sweep-
// selecting it to overtype) and ends with the mouse out over the backdrop:
// browsers fire the resulting "click" on the nearest common ancestor of the
// mousedown and mouseup targets, which IS the overlay itself once the drag
// has left the field, silently closing the modal. Only close when BOTH the
// mousedown and the click itself landed directly on the backdrop.
{
  let gamesListDownOnBackdrop = false;
  $('gamesListOverlay').addEventListener('mousedown', e => { gamesListDownOnBackdrop = e.target === $('gamesListOverlay'); });
  $('gamesListOverlay').addEventListener('click', e => {
    if(gamesListDownOnBackdrop && e.target === $('gamesListOverlay')){ $('gamesListOverlay').style.display='none'; _gamesModalState=null; }
  });
}
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
  const lines = await getLines(LOCAL_USER);
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
    onClose: ()=>{ $('threeTestOverlay').style.display='none'; closeThreeTest(); refreshMemorizedRoomsAndTree(); },
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
// the room's own CANONICAL seq (see canonicalRoomSeq) -- distinct from
// attrModalLineSeq (used only for the "Belongs to castle" inherit label),
// this is the seq the redirect fields themselves get read/written on, and
// what the room's real board position (roomSeq + saved.reply) is computed
// from for the "Redirect to castle" candidate lookup.
let attrModalRoomSeq = null;
let attrModalSaved = null;
function openAttributesModal(saved, onSave, lineSeq, roomSeq){
  attrModalLineSeq = lineSeq;
  attrModalRoomSeq = roomSeq || lineSeq;
  attrModalSaved = saved;
  $('attrRoomName').value = saved?.name || '';
  $('attrIsCastleRoot').checked = !!saved?.isCastleRoot;
  $('attrCastleName').value = saved?.castleName || '';
  const savedNum = parseInt(saved?.castleStreetNumber, 10);
  $('attrStreetNumber').value = (Number.isFinite(savedNum) && savedNum >= 1) ? savedNum : '';
  $('attrNote').value = saved?.note || '';
  $('attrError').textContent = '';
  refreshCastleOwnerSelect(saved, lineSeq);
  refreshAttrFieldVisibility();
  refreshRedirectField(saved, attrModalRoomSeq);
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
/* The VR room key a pref's own room (one ply past it, via its `reply`) maps
   to -- for badging a move-table row's room name green when memorized. Takes
   the pref record itself (not a bare seq) since it already carries both
   `seq` (every pref does, see db.js's setPref) and `reply`, so no separate
   lookup is needed. Unlike canonicalRoomSeq, this does NOT need
   buildCastleGraph's transposition-merge resolution: the room key is keyed
   on positionKey(fen), which is already transposition-safe on its own (two
   move orders reaching the identical position hash to the same key), so any
   seq that reaches the room resolves to the same key a canonical seq would.
   Returns null when there's no room here at all (no reply yet, or not part
   of any castle). */
function roomKeyForSaved(saved){
  if(!saved?.seq || !saved?.reply) return null;
  const roomSeq = [...saved.seq, saved.reply];
  const castle = inheritedCastle(roomSeq, CURRENT_LINE?.id);
  if(!castle) return null;
  return castleRoomKey(castleInstanceId(CURRENT_LINE.id, castle), positionKey(fenForSeq(roomSeq)));
}
/* Whether a pref's own room (same roomSeq roomKeyForSaved resolves) is a
   genuine dead end -- threeVR.js's isRoomEmpty: no forward exit AND no wall
   content of its own, which VR renders as a LOCKED door into it (see
   threeVR.js's own doc comment). A room behind a locked door can never
   actually be walked into, so it can never be memorized either -- badging it
   distinctly (blue, not the default color) in the move table flags it as
   structurally exempt rather than something that just hasn't been visited
   yet in VR.
   Mirrors isRoomEmpty's own logic against the PREFS/games tree directly
   (this is app.js, not threeVR.js -- no live DEMO_MNEMONICS/room registry to
   read) rather than needing a real castle-graph build: the room has a real
   forward exit or wall content the moment ANY of its own immediate opponent
   replies has an "our reply" chosen -- that reply either starts a new room
   (a forward exit) or continues this same corridor (a wall pair), and either
   way the room is not empty. An unbuilt opponent reply (games has the move,
   but no reply chosen yet) contributes neither, same as threeVR.js's own
   "unbuilt continuation never gets a real exit" rule -- so it does NOT save
   the room from reading as empty.
   A CASTLE ROOT is never locked regardless of its own continuation: it's
   reached directly from the street, not through a parent room's door, so
   there's no door to lock in the first place (same exemption Phase AS's
   "Jump to VR" visibility and threeVR.js's own isRoomEmpty callers give it --
   see the door-naming loop's own comment: "the castle root, which is also
   empty until built out yet is reached from the street, not a locked door"). */
function roomIsLockedForSaved(saved){
  if(!saved?.seq || !saved?.reply || saved.isCastleRoot) return false;
  const roomSeq = [...saved.seq, saved.reply];
  if(!inheritedCastle(roomSeq, CURRENT_LINE?.id)) return false;   // not part of any castle -- no real VR room to lock
  const {counts} = replies(gamesForLineColor(GAMES, CURRENT_LINE.color), roomSeq);
  const manualReplies = PREFS[prefKey(CURRENT_LINE.id, roomSeq)]?.manualReplies || [];
  manualReplies.forEach(m=>{ if(!(m in counts)) counts[m]=0; });
  return !Object.keys(counts).some(opp => !!PREFS[prefKey(CURRENT_LINE.id,[...roomSeq,opp])]?.reply);
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
/* every OTHER built castle (any line, own castle excluded) whose own room
   graph reaches the exact same position as `roomSeq`'s own room -- these are
   the candidates the "Redirect to castle" pulldown offers. Each entry's
   targetSeq is the target castle's own seq reaching that position, captured
   here so a chosen redirect can be re-based onto the target's own move order
   later (the port-responses action, and redirect-aware import) without
   re-deriving it from a stale/rebuilt graph. */
async function redirectCandidatesForRoom(roomFen, ownInstanceId){
  const posKey = positionKey(roomFen);
  const lines = await getLines(LOCAL_USER);
  const built = await gatherBuiltCastles(lines);
  const out = [];
  for(const c of built){
    if(c.instanceId === ownInstanceId) continue;
    const gr = c.genRooms.find(r => r.posKey === posKey);
    if(!gr) continue;
    const line = lines.find(l => l.id === c.lineId);
    out.push({ lineId: c.lineId, lineName: line ? line.name : c.lineId, castleName: c.castleName, targetSeq: gr.seq, roomName: gr.name || '' });
  }
  return out;
}
// bumped on every openAttributesModal/refreshRedirectField call so a slow
// gatherBuiltCastles resolving after the modal's moved on (closed, or
// reopened on a different row) doesn't clobber a since-changed select.
let attrRedirectGen = 0;
let attrRedirectCandidates = [];
async function refreshRedirectField(saved, roomSeq){
  const field = $('attrRedirectField');
  const sel = $('attrRedirectTo');
  const hint = $('attrRedirectHint');
  attrRedirectCandidates = [];
  const myGen = ++attrRedirectGen;
  // only a real, already-built room (an actual reply recorded) belonging to
  // some castle can be redirected -- nothing to transpose otherwise. A
  // castle ROOT is excluded too: it's the entry point of its own building on
  // the street (buildCastleGraph enters it directly, never via processExit),
  // so redirecting it wouldn't stop that castle from being built -- only an
  // interior room's incoming door can meaningfully be rerouted.
  const ownCastleName = inheritedCastle(roomSeq, CURRENT_LINE?.id);
  if(!saved?.reply || !ownCastleName || saved?.isCastleRoot){
    field.style.display = 'none';
    return;
  }
  field.style.display = '';
  sel.disabled = true;
  sel.innerHTML = '<option value="">(none)</option>';
  hint.textContent = 'Checking other castles for this exact position…';
  const ownInstanceId = castleInstanceId(CURRENT_LINE.id, ownCastleName);
  const roomFen = fenForSeq([...roomSeq, saved.reply]);
  let candidates;
  try { candidates = await redirectCandidatesForRoom(roomFen, ownInstanceId); }
  catch(e){ console.warn('[redirect] failed to gather candidates', e); candidates = []; }
  if(myGen !== attrRedirectGen) return;   // modal moved on while this was in flight
  attrRedirectCandidates = candidates;
  sel.disabled = false;
  let matchedIdx = -1;
  if(saved.redirectToCastle){
    matchedIdx = candidates.findIndex(c => c.lineId === saved.redirectTargetLineId && c.castleName === saved.redirectToCastle);
  }
  sel.innerHTML = '<option value="">(none)</option>' +
    candidates.map((c,i)=>`<option value="${i}">${escapeHtml(c.castleName)} (${escapeHtml(c.lineName)})</option>`).join('') +
    // the previously-saved target no longer resolves to a real room (stale
    // cache, or the position/target castle changed) -- offer it as a
    // distinct, pre-selected option instead of silently reverting to "(none)"
    // and risking an accidental clear on the next Save.
    (saved.redirectToCastle && matchedIdx < 0
      ? `<option value="__stale__" selected>${escapeHtml(saved.redirectToCastle)} (saved, but no longer matches this position)</option>` : '');
  if(matchedIdx >= 0) sel.value = String(matchedIdx);
  hint.textContent = candidates.length
    ? 'Doors that would open into this room instead route to the target castle\'s own room there.'
    : (saved.redirectToCastle ? '' : 'No other castle currently shares this exact position.');
}

/* true if `seq` is `prefix` itself or a genuine continuation of it -- element-
   wise, not a naive joined-string prefix (SAN moves never contain commas, but
   this is the same safe comparison seqEq/noCompactUntil's own prefix check use
   elsewhere in this file, rather than relying on that). */
function seqStartsWith(seq, prefix){
  return !!seq && seq.length >= prefix.length && prefix.every((m,i)=>seq[i]===m);
}

/* ---------- redirect: port responses to the target castle ----------
   A redirected room's own subtree (in ITS OWN line) is frozen the moment
   the redirect is set: buildCastleGraph's processExit routes VR doors past
   it entirely (see the redirect check ahead of the automatic foreign-root
   one), and "Add Opponent Move" is hidden on it (refreshRowMenuLabels) --
   but whatever was ALREADY recorded there before the redirect (or added to
   the source since, by an import that hasn't yet learned to redirect itself
   -- later phases) doesn't automatically show up at the target. This walks
   every pref below the redirected room, re-bases each one's seq onto the
   target's own move order (swap the redirected room's own full seq for the
   target's own, keep the tail of moves after it exactly as recorded -- the
   underlying position plays out identically from there regardless of which
   castle's address it's filed under), and writes it into the TARGET line.
   A merge, not an overwrite: a translated position the target already has
   its own reply for is left untouched, so this is safe to re-run (e.g.
   after adding more manual tries to the source branch) -- only ever fills
   in what's still missing. Returns how many prefs were newly written.
   sourceLineId is explicit (not always CURRENT_LINE) because this is also
   called from the Find Transpositions report, which can resolve a redirect
   whose source line isn't the one currently open, or with no line open at
   all. */
async function portRedirectedResponses(sourceLineId, roomSeq, saved){
  const reply = saved?.reply;
  const targetRoomSeq = saved?.redirectTargetSeq;
  const targetLineId = saved?.redirectTargetLineId;
  if(!reply || !targetRoomSeq || !targetLineId) return 0;
  const sourceRoomSeq = [...roomSeq, reply];   // the redirected room's own full seq (ends in OUR reply)

  const [sourcePrefs, targetPrefs] = await Promise.all([
    getAllPrefs(sourceLineId), getAllPrefs(targetLineId),
  ]);
  const entries = [];   // {seq, patch}, fed straight to setPrefsBatch

  const addPort = (translatedSeq, srcPref) => {
    const existing = targetPrefs[prefKey(targetLineId, translatedSeq)];
    if(existing?.reply) return;   // already answered at the target -- leave it alone
    const existingManual = existing?.manualReplies || [];
    const manualReplies = [...new Set([...existingManual, ...(srcPref.manualReplies||[])])];
    // a manual-try-only entry (no reply of its own, see the room-level port
    // just below) has nothing to gate a re-run on except its manualReplies
    // set actually growing -- without this check, re-running Port would
    // "port" the same already-merged set every time and never settle into a
    // true no-op.
    const gainsReply = !!srcPref.reply && !existing?.reply;
    const gainsManual = manualReplies.length !== existingManual.length;
    if(!gainsReply && !gainsManual) return;
    entries.push({ seq: translatedSeq, patch: {
      reply: srcPref.reply || existing?.reply || '', note: srcPref.note || existing?.note || '',
      mnemonic: srcPref.mnemonic || existing?.mnemonic || '',
      manualReplies, moveQuality: srcPref.moveQuality || existing?.moveQuality || '',
      hidden: existing?.hidden ?? srcPref.hidden ?? false,
    }});
  };

  // the room's own manually-recorded (not-yet-answered) opponent tries --
  // ported onto the target room's own manualReplies so it at least knows
  // they exist, even before anyone picks a response for them there.
  const srcRoomPref = sourcePrefs[prefKey(sourceLineId, sourceRoomSeq)];
  if(srcRoomPref?.manualReplies?.length) addPort(targetRoomSeq, srcRoomPref);

  // every descendant pref (a real response, strictly below the redirected
  // room) the target doesn't already have its own answer for.
  for(const key in sourcePrefs){
    const p = sourcePrefs[key];
    if(!p?.reply || !seqStartsWith(p.seq, sourceRoomSeq) || p.seq.length <= sourceRoomSeq.length) continue;
    const translatedSeq = [...targetRoomSeq, ...p.seq.slice(sourceRoomSeq.length)];
    addPort(translatedSeq, p);
  }

  if(entries.length){
    await setPrefsBatch(targetLineId, entries);
    invalidateBuiltCastlesCache();
    // the target IS the currently-open line (a redirect within one line,
    // just a different castle) -- the in-memory PREFS this whole screen
    // reads from needs the same refresh a real reload would give it. Guarded
    // on CURRENT_LINE existing at all: this can run with no line open (the
    // Find Transpositions report doesn't require one).
    if(CURRENT_LINE && targetLineId === CURRENT_LINE.id){
      PREFS = await getAllPrefs(CURRENT_LINE.id);
      renderTreeBody(CURRENT_LINE);
    }
  }
  return entries.length;
}

/* shared by the row menu's own "Port Responses to Target" and the
   Attributes modal's auto-offer right after setting a redirect -- ports one
   room and reports the result the same way both places. */
async function portAndReport(sourceLineId, roomSeq, saved){
  const n = await portRedirectedResponses(sourceLineId, roomSeq, saved);
  log(n ? `Ported ${n} response${n===1?'':'s'} to "${saved.redirectToCastle}"`
        : `Nothing new to port -- "${saved.redirectToCastle}" already has everything`);
  return n;
}

/* true when this Attributes save just turned a redirect ON, or repointed an
   already-redirected room at a DIFFERENT target -- the moment to port,
   not on every unrelated save (a note/name edit) that happens to leave an
   already-redirected room untouched. */
function redirectChanged(before, after){
  if(!after?.redirectToCastle) return false;
  return before?.redirectToCastle !== after.redirectToCastle
      || before?.redirectTargetLineId !== after.redirectTargetLineId;
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
  const redirVal = $('attrRedirectTo').value;
  let redirectToCastle = '', redirectTargetLineId = '', redirectTargetSeq = null, redirectTargetRoomName = '';
  if(redirVal === '__stale__'){
    // unchanged since the modal opened -- write back exactly what was
    // already saved rather than risk clearing it on a candidate-lookup miss.
    redirectToCastle = attrModalSaved?.redirectToCastle || '';
    redirectTargetLineId = attrModalSaved?.redirectTargetLineId || '';
    redirectTargetSeq = attrModalSaved?.redirectTargetSeq || null;
    redirectTargetRoomName = attrModalSaved?.redirectTargetRoomName || '';
  } else if(redirVal !== ''){
    const c = attrRedirectCandidates[parseInt(redirVal, 10)];
    if(c){ redirectToCastle = c.castleName; redirectTargetLineId = c.lineId; redirectTargetSeq = c.targetSeq; redirectTargetRoomName = c.roomName || ''; }
  }
  const v = {
    roomName: $('attrRoomName').value.trim(),
    isCastleRoot: isRoot,
    castleName,
    castleOwner: $('attrCastleOwner').value,
    castleStreetNumber: streetNumber,
    note: $('attrNote').value.trim(),
    redirectToCastle, redirectTargetLineId, redirectTargetSeq, redirectTargetRoomName,
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
  syncTableCastleSelect();
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
  syncTableCastleSelect();
}
$('unfocusBtn').onclick = clearFocus;

/* "Show Castle:" dropdown on the move-table toolbar -- same fast-focus
   shortcut as the digraph's own (see populateGraphCastleSelect), so the
   common "find a castle by name, then look for unfilled sub-branches"
   workflow is a single select instead of hunting through the tree for the
   right row's three-dot menu. Hidden entirely when no castles are defined.
   Each castle is an <optgroup>, indenting (for free, native <select>
   behavior) its own NAMED rooms underneath a "(whole castle)" entry --
   unnamed rooms are the vast majority in a typical castle and would just be
   noise here with no better label than a bare move pair, so they're left
   out; a named room is deliberate enough to be worth a menu entry. A room
   reached by more than one castle/sequence (a transposition) is listed
   under each one it belongs to -- harmless duplication, not a bug. */
let TABLE_ROOM_OPTIONS = [];   // [{ name, seq }] -- "room:<index>" option values index into this
// whether the (expensive) named-room listing has been loaded for the
// CURRENTLY built castle list -- see loadTableCastleRooms. Reset any time
// populateTableCastleSelect rebuilds the castle-only list fresh.
let tableRoomOptionsLoaded = false;
function populateTableCastleSelect(){
  const wrap = $('tableCastleWrap'), sel = $('tableCastleSelect');
  const castles = definedCastles();
  TABLE_ROOM_OPTIONS = [];
  tableRoomOptionsLoaded = false;
  if(!castles.length){ wrap.style.display = 'none'; sel.innerHTML = ''; return; }
  wrap.style.display = '';
  // cheap pass: castle names only, no rooms yet. Enumerating a castle's own
  // rooms (buildGeneratedCastle) is real graph analysis, not a quick PREFS
  // scan -- computing it for every castle on every renderTreeBody (i.e.
  // every import, every compact/visibility toggle) was measured costing
  // several SECONDS per render, for a dropdown that's opened far less often
  // than the tree re-renders. Named rooms are filled in lazily, only once
  // this dropdown is actually about to be opened -- see loadTableCastleRooms.
  sel.innerHTML = '<option value="">All</option>' + castles.map(name =>
    `<optgroup label="${escapeHtml(name)}"><option value="castle:${escapeHtml(name)}">(whole castle)</option></optgroup>`
  ).join('');
  syncTableCastleSelect();
}
// the expensive per-castle room enumeration, deferred until the dropdown is
// actually about to be opened (see the focus/mousedown listeners below)
// rather than paid on every tree render. Rebuilds the whole <select> (cheap
// castle-only markup included) in one pass rather than trying to splice
// room options into what populateTableCastleSelect already built.
function loadTableCastleRooms(){
  if(tableRoomOptionsLoaded) return;
  tableRoomOptionsLoaded = true;
  const sel = $('tableCastleSelect');
  const castles = definedCastles();
  if(!castles.length) return;
  TABLE_ROOM_OPTIONS = [];
  const lineGames = gamesForLineColor(GAMES, CURRENT_LINE.color);
  sel.innerHTML = '<option value="">All</option>' + castles.map(name => {
    const rootSeq = castleRootRoomSeq(name);
    let roomOptions = '';
    if(rootSeq){
      const { genRooms } = buildGeneratedCastle(CURRENT_LINE, lineGames, rootSeq, name);
      roomOptions = genRooms
        .filter(r => r.name && r.name.trim() && r.seq)
        .map(r => {
          const idx = TABLE_ROOM_OPTIONS.push({ name: r.name.trim(), seq: r.seq }) - 1;
          return `<option value="room:${idx}">${escapeHtml(r.name.trim())}</option>`;
        }).join('');
    }
    return `<optgroup label="${escapeHtml(name)}">` +
      `<option value="castle:${escapeHtml(name)}">(whole castle)</option>` + roomOptions +
      `</optgroup>`;
  }).join('');
  syncTableCastleSelect();
}
$('tableCastleSelect').addEventListener('mousedown', loadTableCastleRooms);
$('tableCastleSelect').addEventListener('focus', loadTableCastleRooms);
// resolves the currently active focus (however it got there) to the option
// value that represents it, or '' if it doesn't match any castle/named room
// in the current dropdown -- shared by populate (initial value) and sync
// (kept current afterward).
function focusedTableSelectValue(){
  const castleName = focusedCastleName();
  if(castleName) return 'castle:' + castleName;
  const seq = GRAPH_FOCUS_SEQ || FOCUSED_SEQ;
  if(!seq) return '';
  const key = seq.join(',');
  const idx = TABLE_ROOM_OPTIONS.findIndex(o => o.seq && o.seq.join(',') === key);
  return idx >= 0 ? 'room:' + idx : '';
}
// keeps the dropdown's own value in sync with whatever focus is actually
// active, however it got there -- picking it here (onchange below), or the
// old-fashioned way via a row's "Focus on this Variation" menu (focusOnLine)
// or "Unfocus" (clearFocus). Reading focusedTableSelectValue() (rather than
// just remembering our own last selection) is what makes the old-fashioned
// path detected automatically: it resolves whatever FOCUSED_SEQ actually is
// back to a matching option, with no special-casing of how it got set.
function syncTableCastleSelect(){
  const sel = $('tableCastleSelect');
  if(sel && sel.options.length) sel.value = focusedTableSelectValue();
}
// finds the data-row a given seq's own "Focus on this Variation" would have
// been clicked on -- the OPPONENT-move row one ply back from `seq` itself
// (see castleRootRoomSeq's/genRoomMeta's own comments on that convention) --
// and applies focus there. Shared by both branches of the dropdown's
// onchange, since a castle-root seq and a named room's own seq work exactly
// the same way once you have the full seq.
function focusOnSeqRow(seq){
  const rowSeq = seq.slice(0, -1);
  // isCastleRoot AND named rooms are both excluded from compact-run hoisting
  // (see computeCompactRun's own annotated-position check), so they always
  // have their own row here, expanded or not (collapsed just means
  // display:none, not absent -- see makeToggle).
  const row = Array.from($('tree').querySelectorAll('.data-row')).find(r => r.dataset.seq === rowSeq.join(','));
  if(row) focusOnLine(row, seq); else clearFocus();
}
$('tableCastleSelect').onchange = () => {
  const val = $('tableCastleSelect').value;
  if(!val){ clearFocus(); return; }
  if(val.startsWith('castle:')){
    const roomSeq = castleRootRoomSeq(val.slice('castle:'.length));
    if(roomSeq) focusOnSeqRow(roomSeq); else clearFocus();
    return;
  }
  const opt = TABLE_ROOM_OPTIONS[+val.slice('room:'.length)];
  if(opt) focusOnSeqRow(opt.seq); else clearFocus();
};

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
  let {counts} = replies(games,seq);
  const manual = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
  manual.forEach(m=>{ if(!(m in counts)) counts[m]=0; });
  counts = filterCountsForLine(counts, 0, manual, CURRENT_LINE).counts;
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

/* walks UP from `dataRow` to every ANCESTOR .data-row (nearest first), the
   same "climb via the owning branch-row's own preceding data-row" traversal
   focusOnLine uses -- but just collecting rows here instead of hiding
   siblings. Used by refreshAncestorCompleteBadges (a targeted re-render
   only rebuilds one row's own subtree, via that row's own expandWith, which
   already refreshes ITS OWN badge -- everything ABOVE it needs a separate,
   cheap pass since nothing rebuilt their DOM). */
function ancestorDataRows(dataRow){
  const rows = [];
  let node = dataRow;
  while(node){
    const tbody = node.parentElement;
    const branchRow = tbody.parentElement.closest('tr.branch-row');
    if(!branchRow) break;
    const metaRow = branchRow.previousElementSibling;
    node = metaRow ? metaRow.previousElementSibling : null;
    if(node) rows.push(node);
  }
  return rows;
}
/* refreshes every ancestor's own "complete to move" badge from CURRENT
   PREFS/games data (computeNodeStats, no DOM walk needed) after a targeted
   subtree re-render -- that only updates the row it was called on (via its
   own expandWith), leaving ancestors showing a stale pre-import value
   otherwise. Silently skips a row with no own reply/badge -- a compact-run
   summary row's own dataset.seq is ITS run's end (our-move-ending, not the
   opponent-ending convention a plain row's seq is), so it never matches a
   PREFS reply here and is left as a known, narrow staleness gap (compact
   mode's own toggle already force-refreshes everything if that's ever
   visibly wrong -- an acceptable trade for skipping a full tree rebuild on
   every targeted import). */
function refreshAncestorCompleteBadges(dataRow, lineGames){
  for(const ancestorRow of ancestorDataRows(dataRow)){
    const ancestorLineSeq = ancestorRow.dataset.seq ? ancestorRow.dataset.seq.split(',') : null;
    if(!ancestorLineSeq || !ancestorLineSeq.length) continue;
    const ancestorReply = PREFS[prefKey(CURRENT_LINE.id, ancestorLineSeq)]?.reply;
    if(!ancestorReply) continue;
    const badge = ancestorRow.querySelector('.completeBadge');
    if(!badge) continue;
    const stats = computeNodeStats(lineGames, [...ancestorLineSeq, ancestorReply]);
    updateCompleteBadge(badge, stats.completeToMove);
  }
}

/* Attempts a targeted re-render of just the subtree an import can actually
   affect, instead of a full renderTreeBody -- for importEngineVariation's
   own case (the row-menu "Import this variation" from a saved eval/PV),
   startSeq is ALWAYS an existing, already-rendered position (analysis only
   ever runs on a reachable position), and the import can only ever add
   content AT OR BELOW it, never touch anything else in the tree. A full
   rebuild's dominant cost turned out to be the DOM-heavy recursive tree
   build itself (measured at several SECONDS for a large repertoire), not
   the writes -- reusing the exact expandWith a manual "Set Standard
   Response" already calls rebuilds only the one row's own subtree.
   Deliberately does NOT touch focus DOM (clearFocus/reapplyFocus) -- since
   nothing OUTSIDE the touched subtree changes, whatever focus state already
   exists is untouched and needs no round-trip.
   Returns true on success; the caller falls back to a full renderTreeBody
   (still fully correct, just slower) whenever this can't find a clean
   target -- e.g. importing from move 1 itself (no owning row to re-expand)
   or a row hoisted somewhere renderBranch's own machinery doesn't expose an
   expandWith for. */
function targetedRenderAfterImport(startSeq){
  const color = CURRENT_LINE.color;
  // does startSeq's own last ply belong to OUR side or the opponent's? Same
  // parity convention importParsedLine's own oppParity encodes: for white,
  // an ODD-length seq ends in our move (ply 1,3,5.. = White); for black, an
  // EVEN-length seq ends in our move (ply 2,4,6.. = Black).
  const lastIsOurs = color === 'black' ? (startSeq.length % 2 === 0) : (startSeq.length % 2 === 1);
  const anchorLineSeq = lastIsOurs ? startSeq.slice(0, -1) : startSeq;
  if(!anchorLineSeq.length) return false;   // importing from move 1 itself -- no owning row to re-expand
  const row = Array.from($('tree').querySelectorAll('.data-row')).find(r => r.dataset.seq === anchorLineSeq.join(','));
  if(!row || !row.__expandWith) return false;
  const reply = PREFS[prefKey(CURRENT_LINE.id, anchorLineSeq)]?.reply;
  if(!reply) return false;
  // expandWith itself only rebuilds the descendant branch -- setStandardResponse
  // (the manual-edit path expandWith was written for) sets the row's own
  // "our reply" text separately, right before calling it; mirror that here.
  const replySpan = row.querySelector('.ourReply');
  if(replySpan) replySpan.innerHTML = pvChip(reply, fenForSeq([...anchorLineSeq, reply]));
  row.__expandWith(reply);
  refreshAncestorCompleteBadges(row, gamesForLineColor(GAMES, color));
  return true;
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
  // each move a tappable pv-move chip (carrying the FEN right after it) so a
  // click floats the mini board there, same as any other move in the tree --
  // a compacted line's moves used to be plain, unclickable text.
  return runMoves.map(({opp,reply,lineSeq,depth})=>{
    const oppChip = pvChip(opp, fenForSeq(lineSeq));                 // lineSeq ends in opp
    const replyChip = pvChip(reply, fenForSeq([...lineSeq,reply]));
    return flip ? `${depth+1}. ${oppChip} ${replyChip}` : `${oppChip} ${depth+2}. ${replyChip}`;
  }).join(' ');
}

/* single row standing in for a whole hoisted run: one Analyse button and the
   collapsed run as tappable move chips, plus a branch-row that resumes normal
   rendering from wherever the run ended. The row itself has no per-move menu
   (there's no single move to attach one to) -- but its triangle expands JUST
   this one line in place, lazily rendering the run's forced moves as normal
   per-move rows (each with its own full menu, for e.g. shortening the line)
   without leaving compact mode for the whole table. */
// parentDiv/outerNoCompactUntil are the CALLING renderBranch's own `parent`
// and `noCompactUntil` -- i.e. the context this compact run's position (seq)
// was reached under, kept around only for the full-rebuild fallback below
// (a compact run can only ever be invoked with !withinExpansion, so
// outerNoCompactUntil is always either null or an OUTER run's endSeq that
// doesn't cover this seq -- safe to just carry forward unchanged).
function renderCompactRunRow(tb,games,seq,depth,flip,run,indentLevel,parentDiv,outerNoCompactUntil){
  let {runMoves,endSeq,endDepth} = run;
  const tr = document.createElement('tr');
  tr.className = 'data-row compact-run';
  tr.innerHTML =
    `<td class="resp">
       <button class="iconbtn" title="Analyse"><i class="fa-solid fa-chess-board"></i></button>
     </td>
     <td class="move" style="padding-left:${indentLevel}em">
       <button class="iconbtn toggle" title="Expand just this line"><i class="fa-solid fa-caret-right"></i></button>
       <span class="compact-run-label">${compactRunLabel(runMoves,flip)}</span>
     </td>
     <td class="cnt-col"><span class="completeBadge"></span></td>
     <td class="eval-col"></td>
     <td class="name-col"></td>`;
  tb.appendChild(tr);
  tr.dataset.seq = endSeq.join(',');   // identity for search/focus: this row stands in for the whole run, ending at endSeq

  const labelSpan = tr.querySelector('.compact-run-label');
  const btnEval = tr.querySelector('td.resp > button.iconbtn');
  attachHoverPreview(btnEval, endSeq);
  btnEval.onclick = () => showPosition(fenForSeq(endSeq), ()=>{}, ()=>{}, endSeq);

  // collapsed view: resume normal rendering AFTER the run. Rebuilt whenever
  // rebuildSelf() below reconstructs it (endSeq/endDepth can shift).
  let tr1 = document.createElement('tr'); tr1.className='branch-row'; tr.after(tr1);
  function buildCollapsedContinuation(){
    const td1 = document.createElement('td'); td1.colSpan=5; td1.style.padding='0'; tr1.appendChild(td1);
    const div = document.createElement('div'); div.className='branch'; td1.appendChild(div);
    const sub = renderBranch(div,games,endSeq,endDepth,flip);
    updateCompleteBadge(tr.querySelector('.completeBadge'), sub.completeToMove);
    return sub;
  }
  let sub = buildCollapsedContinuation();

  // expand-this-line toggle: lazily render the run's FULL form (its forced
  // moves as normal rows, followed by the same continuation) into a hidden
  // branch-row, via renderBranch with compaction suppressed for this run's own
  // extent (noCompactUntil=endSeq) and notifyDirty=rebuildSelf so an edit
  // inside it (e.g. deleting one of the run's own moves) can refresh this
  // row's own summary, below. The triangle swaps which branch-row shows, so
  // one compacted line can be temporarily expanded (to shorten it, open a
  // move's menu, etc.) without toggling compact mode for the whole tree.
  const toggleBtn = tr.querySelector('button.toggle');
  let trFull = null;
  function buildFull(){
    trFull = document.createElement('tr'); trFull.className = 'branch-row';
    const tdF = document.createElement('td'); tdF.colSpan=5; tdF.style.padding='0'; trFull.appendChild(tdF);
    const divF = document.createElement('div'); divF.className='branch'; tdF.appendChild(divF);
    tr.after(trFull);   // directly under the handle, above the collapsed continuation
    renderBranch(divF,games,seq,depth,flip,endSeq,rebuildSelf);
  }
  toggleBtn.onclick = () => {
    const expanding = !trFull || trFull.style.display === 'none';
    if(expanding && !trFull) buildFull();
    trFull.style.display = expanding ? '' : 'none';
    tr1.style.display    = expanding ? 'none' : '';
    toggleBtn.innerHTML  = expanding ? '<i class="fa-solid fa-caret-down"></i>' : '<i class="fa-solid fa-caret-right"></i>';
    toggleBtn.title      = expanding ? 'Collapse this line' : 'Expand just this line';
  };

  // Called after an edit anywhere inside the expanded view (trFull) that can
  // change what THIS row itself should show -- e.g. deleting one of the run's
  // own forced moves. Re-derives the run fresh from current data: if it's
  // still a valid (>=2-pair) run, refreshes just the label/end-seq/collapsed-
  // continuation in place, leaving trFull's own (already self-updated)
  // content and current expanded/collapsed state untouched. If the run
  // dissolved entirely (e.g. a deletion dropped it below 2 pairs), there's no
  // clean partial update -- falls back to a full rebuild of this position,
  // same pattern the plain (non-compact) tree already uses elsewhere
  // (removeManualBtn's own onclick) for "something changed here, redo it".
  function rebuildSelf(){
    const fresh = computeCompactRun(games,seq,depth,flip);
    if(!fresh){
      parentDiv.innerHTML = '';
      renderBranch(parentDiv,games,seq,depth,flip,outerNoCompactUntil);
      return;
    }
    ({runMoves,endSeq,endDepth} = fresh);
    labelSpan.innerHTML = compactRunLabel(runMoves,flip);
    tr.dataset.seq = endSeq.join(',');
    const wasCollapsedShown = tr1.style.display !== 'none';
    tr1.remove();
    tr1 = document.createElement('tr'); tr1.className='branch-row';
    tr1.style.display = wasCollapsedShown ? '' : 'none';
    (trFull || tr).after(tr1);
    // (not reassigning the outer `sub`/completeToMove here -- rebuildSelf only
    // ever runs after renderCompactRunRow has already returned that value up
    // the call chain, so there'd be nothing left to propagate it to; matches
    // this codebase's existing precedent of not re-threading completeToMove
    // through a later local rebuild, e.g. removeManualBtn's own onclick.)
    buildCollapsedContinuation();
  }

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
// noCompactUntil (a seq) is set only while rendering a single compacted line's
// "expand this line" view: compaction is suppressed for every position strictly
// before that end seq (i.e. the run's own forced moves), then resumes normally
// at/after it. Null everywhere else, so the normal tree is unaffected.
// notifyDirty travels alongside it: also set only within that same expanded
// view, called after any edit that can change an ANCESTOR compact-run row's
// own displayed summary (its move labels, or whether it still forms a run at
// all) -- e.g. deleting one of the run's own forced moves. The compact-run
// row (renderCompactRunRow) refreshes itself in response; nothing outside an
// expansion ever sets this, so it's a no-op everywhere else.
function renderBranch(parent,games,seq,depth,flip=false,noCompactUntil=null,notifyDirty=null){
  let {counts,tot}=replies(games,seq);
  const manualReplies = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
  manualReplies.forEach(m=>{ if(!(m in counts)) counts[m]=0; });
  ({counts,tot} = filterCountsForLine(counts, tot, manualReplies, CURRENT_LINE));

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
    if(depth===0) appendAddMoveControl(tb,parent,games,seq,depth,flip,noCompactUntil,notifyDirty);
    return {completeToMove};
  }

  if(!flip && depth===0){
    const ctxTr = document.createElement('tr');
    ctxTr.className = 'context-row';
    ctxTr.innerHTML =
      `<td class="resp">
         <div class="row-menu-wrap">
           <button class="iconbtn rowMenuBtn" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>
           <div class="row-menu">
             <button type="button" data-act="analyzeChildren"><i class="fa-solid fa-chess-board"></i>Add Children to Analysis Queue</button>
             <hr class="row-menu-sep">
             <button type="button" data-act="addMove"><i class="fa-solid fa-plus"></i>Add Opponent Move</button>
             <hr class="row-menu-sep">
             <button type="button" data-act="gamesHere"><i class="fa-solid fa-database"></i>Browse Games</button>
             <hr class="row-menu-sep">
             <button type="button" data-act="nodeStats"><i class="fa-solid fa-diagram-project"></i>Node Statistics</button>
           </div>
         </div>
       </td>
       <td class="move" style="padding-left:${depth}em">${depth+1}. ${pvChip(seq.at(-1), fenForSeq(seq))}</td>
       <td class="cnt-col"></td>
       <td class="eval-col"></td>
       <td class="name-col"></td>`;
    tb.appendChild(ctxTr);
    // this row is a real node (white's own trigger move) but has no
    // opp/lineSeq structure like a data-row -- computeSystemStats already
    // treats a white root the same way (computeNodeStats(games,[trigger])),
    // so every action here just reuses that same seq directly. Most of the
    // full data-row menu doesn't apply (there's no "this variation" to
    // focus/hide, no standard-reply/quality/attributes on the trigger move
    // itself, etc.) -- only the handful of actions that make sense against a
    // real position with no opponent-reply framing are offered.
    const ctxRowMenuBtn = ctxTr.querySelector('.rowMenuBtn');
    const ctxRowMenu = ctxTr.querySelector('.row-menu');
    ctxRowMenuBtn.onclick = e => {
      e.stopPropagation();
      const showing = ctxRowMenu.classList.contains('show');
      closeAllRowMenus();
      if(!showing) ctxRowMenu.classList.add('show');
    };
    ctxRowMenu.querySelector('[data-act="nodeStats"]').onclick = e => {
      e.stopPropagation();
      ctxRowMenu.classList.remove('show');
      showNodeStats(games, seq);
    };
    ctxRowMenu.querySelector('[data-act="gamesHere"]').onclick = e => {
      e.stopPropagation();
      ctxRowMenu.classList.remove('show');
      showGamesAtNode(seq);
    };
    ctxRowMenu.querySelector('[data-act="analyzeChildren"]').onclick = e => {
      e.stopPropagation();
      ctxRowMenu.classList.remove('show');
      // move 1's own opponent replies are already rendered as this SAME
      // table's data-rows (no separate collapsed branchDiv the way a deeper
      // row's children have) -- `parent` is that table's direct parent, so
      // it matches collectChildEntries' own ":scope > table > tbody > tr.data-row" lookup.
      queueChildrenForAnalysis(seq, parent);
    };
    ctxRowMenu.querySelector('[data-act="addMove"]').onclick = e => {
      e.stopPropagation();
      ctxRowMenu.classList.remove('show');
      openFieldModal('addMove', '', v=>{
        addManualReply(seq,v);
        parent.innerHTML='';
        renderBranch(parent,games,seq,depth,flip,noCompactUntil,notifyDirty);
        notifyDirty?.();
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

  const indentLevel = flip ? depth : depth+1;

  // within a single-line expansion, this position's forced move renders in
  // FULL as long as we're still strictly before the expanded run's end seq.
  const withinExpansion = !!noCompactUntil && noCompactUntil.length > seq.length
    && noCompactUntil.slice(0, seq.length).join(',') === seq.join(',');
  if(compactMode && !withinExpansion){
    const run = computeCompactRun(games,seq,depth,flip);
    if(run){
      const sub = renderCompactRunRow(tb,games,seq,depth,flip,run,indentLevel,parent,noCompactUntil);
      completeToMove = Math.min(completeToMove, sub.completeToMove);
      if(depth===0) appendAddMoveControl(tb,parent,games,seq,depth,flip,noCompactUntil,notifyDirty);
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
             <button type="button" data-act="copyMoves"><i class="fa-solid fa-copy"></i>Copy Moves</button>
             <hr class="row-menu-sep">
             <button type="button" data-act="gamesHere"><i class="fa-solid fa-database"></i>Browse Games</button>
             <button type="button" data-act="compareActual"><i class="fa-solid fa-code-compare"></i>Compare Games</button>
             <button type="button" data-act="openingQuiz"><i class="fa-solid fa-graduation-cap"></i>Quiz this Variation</button>
             <hr class="row-menu-sep">
             <button type="button" data-act="generateCastle"><i class="fa-solid fa-dungeon"></i>Preview Palace</button>
             <button type="button" data-act="nodeStats"><i class="fa-solid fa-diagram-project"></i>Node Statistics</button>
             <button type="button" data-act="attributes"><i class="fa-solid fa-sliders"></i>Set Attributes</button>
             <button type="button" data-act="portRedirect" style="display:none"><i class="fa-solid fa-file-import"></i>Port Responses to Target</button>
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
      notifyDirty?.();   // e.g. hidden/mnemonic can change an ancestor compact-run's own shape/label
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
      const before = roomSaved();
      // a plain snapshot, NOT a reference to `before` -- savePrefField
      // mutates that same PREFS object in place below, so comparing against
      // `before` directly would always see it already-updated too.
      const beforeRedirect = { redirectToCastle: before?.redirectToCastle, redirectTargetLineId: before?.redirectTargetLineId };
      openAttributesModal(before, v=>{
        invalidateBuiltCastlesCache();
        savePrefField(roomSeq, 'isCastleRoot', v.isCastleRoot);
        savePrefField(roomSeq, 'castleName', v.castleName);
        savePrefField(roomSeq, 'castleOwner', v.castleOwner);
        savePrefField(roomSeq, 'castleStreetNumber', v.castleStreetNumber);
        savePrefField(roomSeq, 'name', v.roomName);
        savePrefField(roomSeq, 'note', v.note);
        savePrefField(roomSeq, 'redirectToCastle', v.redirectToCastle);
        savePrefField(roomSeq, 'redirectTargetLineId', v.redirectTargetLineId);
        savePrefField(roomSeq, 'redirectTargetSeq', v.redirectTargetSeq);
        savePrefField(roomSeq, 'redirectTargetRoomName', v.redirectTargetRoomName);
        refreshBranchName(nameSpan, roomSaved());
        refreshRowMenuLabels(rowMenu, roomSaved());
        // re-sync the visible children immediately on a redirect toggle --
        // otherwise turning it on leaves stale children on screen (or off,
        // leaves the toggle stuck empty) until the next full re-render.
        if(roomSaved().reply) expandWith(roomSaved().reply, !roomSaved()?.collapsed);
        refreshMeta();
        notifyDirty?.();   // note/castleName/isCastleRoot can change an ancestor compact-run's eligibility/shape
        if(redirectChanged(beforeRedirect, roomSaved())) portAndReport(CURRENT_LINE.id, roomSeq, roomSaved());
      }, lineSeq, roomSeq);
    }

    /* expand the branch table under the chosen standard response */
    let childrenSeq = null, branchDiv = null;
    function expandWith(reply, startExpanded=true){
      const old = metaTr.nextSibling;
      if(old?.querySelector?.('.branch')) old.remove();
      childrenSeq = [...lineSeq,reply];
      // a redirected room's own children are suppressed entirely -- leave the
      // toggle in its default "nothing to expand" state (see makeToggle),
      // same as a genuine leaf row with no reply at all.
      if(currentSaved()?.redirectToCastle){
        branchDiv = null;
        updateCompleteBadge(completeSpan);
        return;
      }

      const tr1=document.createElement('tr'); tr1.className='branch-row'; metaTr.after(tr1);
      const td1=document.createElement('td'); td1.colSpan=5; td1.style.padding='0'; tr1.appendChild(td1);
      const div=document.createElement('div'); div.className='branch'; td1.appendChild(div);
      branchDiv = div;
      // carry noCompactUntil/notifyDirty forward so a single-line expansion
      // keeps rendering the run's own forced moves in full (the prefix test
      // self-limits it to the run's extent) and any edit within them can still
      // reach the compact-run row's own summary; both null in the normal
      // tree, so this is a no-op there.
      const sub = renderBranch(div,games,childrenSeq,depth+1,flip,noCompactUntil,notifyDirty);
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
    // exposed so an out-of-band write that touches only this row's own
    // subtree (importEngineVariation's targeted re-render) can trigger the
    // exact same expansion a manual "Set Standard Response" would, without
    // needing a full renderTreeBody -- see importEngineVariation's own comment.
    tr.__expandWith = expandWith;

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
      notifyDirty?.();   // the new reply text can change an ancestor compact-run's own displayed label
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
    hideBtn.onclick = async e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      const hidingNow = !currentSaved()?.hidden;
      // only hiding (not unhiding, which only ever restores visibility) can
      // sever a redirect's target out from under it -- see
      // redirectsIntoSubtree's own doc comment.
      if(hidingNow){
        const incoming = await redirectsIntoSubtree(CURRENT_LINE.id, lineSeq);
        if(incoming.length && !confirmHideBreaksRedirects(incoming.length)) return;
      }
      invalidateBuiltCastlesCache();   // hiding/unhiding changes which opponent replies are visible, i.e. which exits/rooms exist
      saveField('hidden', hidingNow);
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
    rowMenu.querySelector('[data-act="copyMoves"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      navigator.clipboard.writeText(formatMoveListPgn(lineSeq)).then(
        () => log(`copied ${lineSeq.length} move(s) to the clipboard`),
        () => log('failed to copy to the clipboard', true));
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
        // pass noCompactUntil/notifyDirty through: adding an opponent try here
        // can add a 2nd visible opp, breaking a forced chain further down --
        // must stay un-compacted if this is still inside an expansion, and an
        // ancestor compact-run's own summary may need to reflect the new move.
        const sub = renderBranch(branchDiv,games,childrenSeq,depth+1,flip,noCompactUntil,notifyDirty);
        updateCompleteBadge(completeSpan, sub.completeToMove);
        notifyDirty?.();
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
    rowMenu.querySelector('[data-act="portRedirect"]').onclick = async e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      const roomSeq = canonicalRoomSeq(lineSeq);
      const saved = PREFS[prefKey(CURRENT_LINE.id, roomSeq)];
      if(!saved?.redirectToCastle) return;
      await portAndReport(CURRENT_LINE.id, roomSeq, saved);
    };
    const removeManualBtn = rowMenu.querySelector('[data-act="removeManual"]');
    if(isManual){
      removeManualBtn.style.display='';
      removeManualBtn.onclick = e => {
        e.stopPropagation();
        rowMenu.classList.remove('show');
        removeManualReply(seq,opp);
        parent.innerHTML='';
        // pass noCompactUntil/notifyDirty through -- same reasoning as
        // addMove's handler just above: this position stays un-compacted if
        // still inside an expansion, and removing a move (this IS "delete a
        // move from a compacted line") can shorten or dissolve an ancestor
        // compact-run, which needs to hear about it.
        renderBranch(parent,games,seq,depth,flip,noCompactUntil,notifyDirty);
        notifyDirty?.();
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

  if(depth===0) appendAddMoveControl(tb,parent,games,seq,depth,flip,noCompactUntil,notifyDirty);
  return {completeToMove};
}

/* lets the user record an opponent move that hasn't appeared in any imported
   game yet (e.g. a known theoretical try), so it shows up alongside the
   data-driven rows with a 0 count until games actually contain it.
   Appended as a row in the same table as the data rows (rather than a
   separate element) so its move column lines up with theirs — both share
   that table's column widths, regardless of the (empty) resp cell here. */
function appendAddMoveControl(tb,parent,games,seq,depth,flip,noCompactUntil=null,notifyDirty=null){
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
      // this control (depth 0 only) can be reached while INSIDE a root-level
      // compact run's own expansion -- thread noCompactUntil/notifyDirty
      // through the same as every other mutation site in the expanded view.
      renderBranch(parent,games,seq,depth,flip,noCompactUntil,notifyDirty);
      notifyDirty?.();
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
           <button type="button" data-act="portRedirect" style="display:none"><i class="fa-solid fa-file-import"></i>Port Responses to Target</button>
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
    const before = roomSaved();
    // a plain snapshot, NOT a reference to `before` -- savePrefField mutates
    // that same PREFS object in place below, so comparing against `before`
    // directly would always see it already-updated too.
    const beforeRedirect = { redirectToCastle: before?.redirectToCastle, redirectTargetLineId: before?.redirectTargetLineId };
    openAttributesModal(before, v=>{
      invalidateBuiltCastlesCache();
      savePrefField(roomSeq, 'isCastleRoot', v.isCastleRoot);
      savePrefField(roomSeq, 'castleName', v.castleName);
      savePrefField(roomSeq, 'castleOwner', v.castleOwner);
      savePrefField(roomSeq, 'castleStreetNumber', v.castleStreetNumber);
      savePrefField(roomSeq, 'name', v.roomName);
      savePrefField(roomSeq, 'note', v.note);
      savePrefField(roomSeq, 'redirectToCastle', v.redirectToCastle);
      savePrefField(roomSeq, 'redirectTargetLineId', v.redirectTargetLineId);
      savePrefField(roomSeq, 'redirectTargetSeq', v.redirectTargetSeq);
      savePrefField(roomSeq, 'redirectTargetRoomName', v.redirectTargetRoomName);
      refreshBranchName(nameSpan, roomSaved());
      refreshRowMenuLabels(rowMenu, roomSaved());
      // re-sync the visible children immediately on a redirect toggle --
      // otherwise turning it on leaves stale children on screen (or off,
      // leaves the toggle stuck empty) until the next full re-render.
      if(roomSaved().reply) expandWith(roomSaved().reply, !roomSaved()?.collapsed);
      refreshMeta();
      if(redirectChanged(beforeRedirect, roomSaved())) portAndReport(CURRENT_LINE.id, roomSeq, roomSaved());
    }, lineSeq, roomSeq);
  }

  let childrenSeq = null, branchDiv = null;
  function expandWith(reply, startExpanded=true){
    const old = metaTr.nextSibling;
    if(old?.querySelector?.('.branch')) old.remove();
    childrenSeq = [...lineSeq,reply];
    // a redirected room's own children are suppressed entirely -- leave the
    // toggle in its default "nothing to expand" state (see makeToggle), same
    // as a genuine leaf row with no reply at all.
    if(currentSaved()?.redirectToCastle){
      branchDiv = null;
      updateCompleteBadge(completeSpan);
      return;
    }

    const tr1=document.createElement('tr'); tr1.className='branch-row'; metaTr.after(tr1);
    const td1=document.createElement('td'); td1.colSpan=5; td1.style.padding='0'; tr1.appendChild(td1);
    const div=document.createElement('div'); div.className='branch'; td1.appendChild(div);
    branchDiv = div;
    const sub = renderBranch(div,games,childrenSeq,1,true);
    updateCompleteBadge(completeSpan, sub.completeToMove);
    makeToggle(toggleBtn,tr1,startExpanded);
  }
  // see renderBranch's own identical comment -- importEngineVariation's
  // targeted re-render needs this row's expand function too when the
  // imported PV starts right at a black line's own ply-1 root.
  tr.__expandWith = expandWith;

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
  hideBtn.onclick = async e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    const hidingNow = !currentSaved()?.hidden;
    if(hidingNow){
      const incoming = await redirectsIntoSubtree(CURRENT_LINE.id, lineSeq);
      if(incoming.length && !confirmHideBreaksRedirects(incoming.length)) return;
    }
    invalidateBuiltCastlesCache();   // hiding/unhiding changes which opponent replies are visible, i.e. which exits/rooms exist
    saveField('hidden', hidingNow);
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
  rowMenu.querySelector('[data-act="portRedirect"]').onclick = async e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    const roomSeq = canonicalRoomSeq(lineSeq);
    const saved = PREFS[prefKey(CURRENT_LINE.id, roomSeq)];
    if(!saved?.redirectToCastle) return;
    await portAndReport(CURRENT_LINE.id, roomSeq, saved);
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
  await putGames(LOCAL_USER,GAMES);
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

  const spinner = showSpinner('Loading opening systems…');
  await nextPaint();
  try {
    const lines = await getLines(LOCAL_USER);
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
        // deleteLine already dropped this line's rows from the analysisQueue
        // store -- prune the in-memory mirror too so a background loop
        // in-flight against this tab can't keep processing/saving against a
        // lineId that no longer exists (same reasoning as importBackup's
        // post-clearAllData reset).
        ANALYSIS_QUEUE = ANALYSIS_QUEUE.filter(it => it.lineId !== line.id);
        renderAnalysisQueueModalIfOpen();
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
// raw move descriptor for one ply of `seq` -- same shape CONV (buildGeneratedCastle)
// produces for a door pair's opponent/response, so a street tile that needs
// the pair-billboard treatment (see systemsForWalk below) can hand it
// straight to buildMnemPairSprite without a separate resolution path.
function moveDescForSeq(seq, moveNumber){
  const mv = lastMoveInfo(seq);
  if(!mv) return null;
  const out = { to: mv.to, piece: MNEM_WORD_FOR_PIECE[mv.piece] || 'pawn', san: mv.san };
  if(moveNumber != null) out.moveNumber = moveNumber;
  const beards = moveDisambiguatorCount(seq);
  if(beards) out.disambig = beards;
  return out;
}
async function systemsForWalk(lines){
  const mnem = await getAllMnemonics();
  return Promise.all(lines.map(async l => {
    const move = (l.openingMoves && l.openingMoves[0]) || '';
    // A Black system's trigger (openingMoves[0]) is the OPPONENT's move, so
    // its street tile also needs OUR prepared reply shown diagonally below
    // it -- the same opponent/response pair composite a door uses -- since
    // otherwise the sign alone can't convey what we actually play. A White
    // system's tile stays single-move: its own reply is what the door to
    // its first mansion already shows, so showing it twice would be
    // redundant. This is a deliberate asymmetry, not an oversight.
    // Read straight from IDB via getPref, NOT the shared PREFS global --
    // PREFS is scoped to whichever single line is currently open in the
    // tree view (or empty, e.g. "Run VR" straight from the home screen),
    // not to every line systemsForWalk is asked to lay out at once.
    let replyPair = null;
    if(l.color === 'black' && move){
      const reply = (await getPref(l.id, [move]))?.reply;
      if(reply){
        const opponent = moveDescForSeq([move], 1);
        const response = moveDescForSeq([move, reply]);
        if(opponent && response) replyPair = { opponent, response };
      }
    }
    return {
      id: l.id, name: l.name, streetName: streetNameForLine(l), color: l.color,
      openingMove: move,
      openingImg: move ? mnemonicImgForSeq([move], mnem) : '',
      openingWord: move ? mnemonicWordForSeq([move], mnem) : '',
      replyPair
    };
  }));
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
    if(!GAMES){
      GAMES = await getGames(LOCAL_USER);
      if(!GAMES.length) GAMES=null;
    }
    if(!GAMES){
      $('fileImport').click();
      return;
    }

    PREFS = await getAllPrefs(line.id);
    await loadMemorizedRooms();   // so a room's name shows green (refreshBranchName) from the very first render, not only after the digraph has separately loaded it

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
  populateTableCastleSelect();

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

// inverse of parseAlgebraicMoveList: a seq (plain SAN array, ply 1 = White's
// first move) -> a "1. d4 Nf6 2. c4 e6" string, for the row menu's Copy Moves
// action -- lets the user build an Import Line variation string by pasting
// this, editing/extending it, and pasting the result back in.
function formatMoveListPgn(seq){
  return seq.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + san).join(' ');
}

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
   textarea) into the currently open opening system's tree: updates the
   in-memory PREFS cache immediately (same shape/defaults savePrefField's own
   in-memory update uses, so a render right after already has everything it
   needs) and folds every pref write it needs into `batch` (a Map keyed by
   pref key, shared across every variation in one import) rather than
   writing to IndexedDB itself. The caller commits the whole import's writes
   in one transaction (see db.js's setPrefsBatch) instead of one setPref()
   round-trip per move -- each of those pays IndexedDB's full transaction-
   commit cost on its own (a real disk flush in most browsers), which is
   what made importing even a modest variation take several seconds.
   Keying `batch` by pref key (rather than just appending) is what keeps
   setPrefsBatch safe to call with no per-key ordering risk: two variations
   that both touch the same position (a shared prefix, or -- rarer -- two
   distinct opponent tries recorded into the same manualReplies list) fold
   into ONE combined patch per key here, reading the always-up-to-date
   in-memory PREFS (already updated by any earlier variation in this same
   import) rather than something setPrefsBatch would have to reconcile
   against stale IndexedDB reads mid-transaction.
   Synchronous now (no IDB round-trips happen here at all); returns the
   number of "our" moves set. */
/* ---------- redirect-aware writes for pasted/engine-imported variations ----------
   A paste (or an engine PV) can run straight through an already-redirected
   room and keep going -- without this, whatever it adds below that room
   would be written into the SOURCE castle's own dead/suppressed subtree
   (see refreshRowMenuLabels: "Add Opponent Move" is hidden there for exactly
   this reason) and never reach the target at all, the same "silently
   dropped" problem portRedirectedResponses (Phase 3) fixes for data that
   predates the redirect. This routes each write live, as the variation is
   walked, instead of needing a separate manual Port pass afterward. */

/* every distinct redirectTargetLineId named in `prefs` (a PREFS-shaped map),
   excluding `ownLineId` -- used to pre-fetch each target's own prefs ONCE,
   up front, before a redirect-aware import walk (see findActiveRedirect)
   needs them: the walk itself must stay synchronous (inline with chess.js
   parsing, mid-variation), so it can't await a DB read the moment it
   discovers a redirect. A same-line redirect (target === ownLineId) needs no
   separate snapshot -- PREFS itself already IS that line's own live copy. */
function redirectTargetLineIds(prefs, ownLineId){
  const ids = new Set();
  for(const key in prefs){
    const p = prefs[key];
    if(p?.redirectToCastle && p.reply && p.redirectTargetSeq && p.redirectTargetLineId && p.redirectTargetLineId !== ownLineId){
      ids.add(p.redirectTargetLineId);
    }
  }
  return [...ids];
}
async function fetchRedirectTargetSnapshots(prefs, ownLineId){
  const ids = redirectTargetLineIds(prefs, ownLineId);
  if(!ids.length) return new Map();
  return new Map(await Promise.all(ids.map(async id => [id, await getAllPrefs(id)])));
}
/* commits every target line's own batch (built up during the walk) in one
   setPrefsBatch call per line -- same "one commit, not one per move" reasoning
   importLine/importEngineVariation already apply to their own single-line batch. */
async function commitRedirectTargetBatches(targetBatches){
  await Promise.all([...targetBatches].map(([lineId, tb]) => setPrefsBatch(lineId, [...tb.values()])));
}

/* the deepest already-redirected room `seq` (any seq -- our-move-ending or
   opponent-ending, this is a pure prefix check) falls at or below, if any --
   same "the redirected room's own full seq is the swap point" reasoning
   portRedirectedResponses uses for the one-time Port action. `prefs` is
   PREFS itself (always CURRENT_LINE's own, which is where a redirect flag
   can only ever be read from -- the variation being walked is always
   relative to the line currently open). */
function findActiveRedirect(prefs, seq){
  let best = null;
  for(const key in prefs){
    const p = prefs[key];
    if(!p?.redirectToCastle || !p.reply || !p.redirectTargetSeq || !p.redirectTargetLineId) continue;
    const roomFullSeq = [...p.seq, p.reply];
    if(seqStartsWith(seq, roomFullSeq) && (!best || roomFullSeq.length > best.roomFullSeq.length)){
      best = { roomFullSeq, targetLineId: p.redirectTargetLineId, targetSeq: p.redirectTargetSeq };
    }
  }
  return best;
}

/* targetSnapshots: Map(lineId -> that line's own PREFS-shaped map), from
   fetchRedirectTargetSnapshots -- required (pass an empty Map if the caller
   knows there's nothing to redirect through) since the walk below can't
   fetch one on demand. targetBatches: Map(lineId -> Map(key -> {seq,patch})),
   mutated in place -- the caller commits it via commitRedirectTargetBatches
   after the whole paste (every raw line) has been walked. */
function importParsedLine(moves, batch, targetBatches, targetSnapshots){
  const color = CURRENT_LINE.color;
  const triggers = CURRENT_LINE.openingMoves || [];
  if(!triggers.includes(moves[0])){
    throw new Error(`this variation is for 1. ${triggers.join(' / ')}, but the pasted variation starts with 1. ${moves[0]}`);
  }

  // writes `field:value` at `rawSeq` -- to CURRENT_LINE's own PREFS/batch as
  // normal, or, once the walk has passed through an already-redirected room,
  // into the target castle's own batch instead, re-based onto its own move
  // order (the redirected room's own full seq swapped for the target's,
  // same tail of moves kept exactly as parsed). manualReplies are unioned
  // against whatever's already recorded there (PREFS for the source/a
  // same-line target, the pre-fetched snapshot for a cross-line target) so
  // an existing, unrelated try isn't lost; reply is a plain overwrite either
  // way, matching how a re-import already overwrites an existing reply at
  // the source (see this function's own doc comment above).
  const queue = (rawSeq, field, value) => {
    const redirect = findActiveRedirect(PREFS, rawSeq);
    const lineId = redirect ? redirect.targetLineId : CURRENT_LINE.id;
    const seq = redirect ? [...redirect.targetSeq, ...rawSeq.slice(redirect.roomFullSeq.length)] : rawSeq;
    const key = prefKey(lineId, seq);
    const sameLine = lineId === CURRENT_LINE.id;
    const existingPref = sameLine ? PREFS[key] : targetSnapshots.get(lineId)?.[key];
    const finalValue = field === 'manualReplies'
      ? [...new Set([...(existingPref?.manualReplies||[]), ...value])]
      : value;

    if(sameLine){
      (PREFS[key] ??= {key,lineId,seq,reply:'',note:'',mnemonic:'',hidden:false})[field] = finalValue;
      const entry = batch.get(key) || { seq, patch: {} };
      entry.patch[field] = finalValue;
      batch.set(key, entry);
    } else {
      let tb = targetBatches.get(lineId); if(!tb){ tb = new Map(); targetBatches.set(lineId, tb); }
      const entry = tb.get(key) || { seq, patch: {} };
      entry.patch[field] = finalValue;
      tb.set(key, entry);
    }
  };

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
    if(!(color==='black' && k===0)) queue(seq,'manualReplies',[opp]);
    if(k+1 < moves.length){
      const lineSeq = [...seq,opp];
      const reply = moves[k+1];
      queue(lineSeq,'reply',reply);
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

  // a big paste (many variations, or long ones) can still take a visible
  // moment even with the batched single-commit write below -- parsing every
  // line is itself synchronous chess.js work, and even one IndexedDB commit
  // isn't instant for a large batch. nextPaint() lets the spinner actually
  // paint before that blocking work starts.
  const spinner = showSpinner('Importing…');
  await nextPaint();
  try {
    // pre-fetch, once, every OTHER line a redirect already set in THIS line
    // points at -- see importParsedLine's own doc comment for why this can't
    // just happen on demand mid-walk.
    const targetSnapshots = await fetchRedirectTargetSnapshots(PREFS, CURRENT_LINE.id);
    const targetBatches = new Map();   // lineId -> Map(key -> {seq,patch})

    const errors = [];
    let totalCount = 0, importedLines = 0;
    const batch = new Map();   // pref key -> {seq,patch}, merged across every parsed variation, committed in ONE IndexedDB transaction below
    for(let i=0;i<rawLines.length;i++){
      try{
        const moves = parseAlgebraicMoveList(rawLines[i]);
        if(!moves.length) continue;
        totalCount += importParsedLine(moves, batch, targetBatches, targetSnapshots);
        importedLines++;
      }catch(err){
        errors.push(rawLines.length>1 ? `variation ${i+1}: ${err.message}` : err.message);
      }
    }

    if(importedLines){
      await setPrefsBatch(CURRENT_LINE.id, [...batch.values()]);   // one commit for the whole paste, not one per move
      await commitRedirectTargetBatches(targetBatches);
      invalidateBuiltCastlesCache();   // an imported variation writes standard responses, same as setting one by hand
      $('importLineOverlay').style.display='none';
      const routed = [...targetBatches.values()].reduce((sum,tb)=>sum+tb.size, 0);
      log(`imported ${totalCount} move(s) from ${importedLines} variation(s) into "${CURRENT_LINE.name}"`
        + (routed ? ` (${routed} routed to a redirected room's own target castle)` : '')
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
  } finally {
    hideSpinner(spinner);
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

  await createLine(LOCAL_USER, {name, color, openingMoves});
  $('lineOverlay').style.display='none';
  renderHome();
};

/* ---------- UI actions ---------- */
// "Import Now" fetches every platform with a non-empty username, one after
// another (not just whichever was last selected -- there's no more source
// dropdown, both platforms' fields are always on screen) -- lets the whole
// import portfolio be set up and run in one visit.
const IMPORT_PLATFORMS = [
  { source: 'lichess',  userField: 'userIdLichess',  userKey: LS_ID,          sizeField: 'maxGames',   sizeKey: LS_MAX,     sizeDefault: 300 },
  { source: 'chesscom', userField: 'userIdChesscom', userKey: LS_ID_CHESSCOM, sizeField: 'monthsBack', sizeKey: LS_MONTHS,  sizeDefault: 12 },
];
$('dlBtn').onclick = async ()=>{
  const platforms = IMPORT_PLATFORMS
    .map(p => ({ ...p, username: $(p.userField).value.trim().toLowerCase() }))
    .filter(p => p.username);
  if(!platforms.length){ logDl('enter a username for at least one platform',true); return; }

  try{
    const results = [];
    for(const p of platforms){
      localStorage.setItem(p.userKey, p.username);
      const sizeParam = +$(p.sizeField).value || p.sizeDefault;
      localStorage.setItem(p.sizeKey, sizeParam);
      logDl(`${p.source}: fetching…`);
      const onFetchProgress = p.source === 'chesscom'
        ? (n,done,total)=>logDl(`${p.source}: fetching… archive ${done}/${total}, ${n} games so far`)
        : n=>logDl(`${p.source}: fetching… got ${n}`);
      const result = await importGamesFromPlatform(p.source, p.username, sizeParam, {
        onFetchProgress,
        onIndexProgress: (done,total) => logDl(`${p.source}: indexing… ${done} of ${total}`),
      });
      results.push(result);
    }
    // totalGames is the full merged count as of the LAST platform processed --
    // each importGamesFromPlatform call reloads GAMES fresh from IDB, so it
    // already reflects every platform imported so far this run, not just its
    // own. Summed fetchedCount across a single platform matches the pre-
    // multi-platform "imported N (M total)" wording exactly.
    const fetchedTotal = results.reduce((sum, r) => sum + r.fetchedCount, 0);
    logDl(`imported ${fetchedTotal} (${results[results.length - 1].totalGames} total)`);
    $('downloadOverlay').style.display='none';
    // renderTreeBody (not openLine) -- re-renders the ALREADY-open line from
    // the freshly-updated GAMES; openLine would also call clearFocus(),
    // silently discarding whatever variation the user had focused.
    if(CURRENT_LINE) renderTreeBody(CURRENT_LINE);
    else await renderHome();
  }catch(e){ console.error('[dlBtn] import failed',e); logDl(e.message,true); }
};

// Recover from any restore an earlier (now-closed/crashed) session never
// finished confirming, before the first Home render -- see
// maybeRecoverFromInterruptedRestore's own doc comment. Deliberately NOT a
// top-level `await`: that would pause every remaining top-level statement in
// this module (including the __xTestHooks registrations much further down)
// until the recovery check's own IndexedDB round trip resolves, same
// fire-and-forget-via-.then() reasoning as refreshAnalysisQueue() below.
// migrateLegacyUserData FIRST, before any crash-recovery replay -- a
// recovery replay's own applyBackupData call does a clearAllData() wipe of
// games/lines/analysisQueue before restoring its snapshot, which would
// permanently destroy any not-yet-migrated legacy-keyed data if migration
// ran second. .catch() (not a try/catch inside the function) so a migration
// failure can never hang the rest of boot -- same "never blocks rendering"
// guarantee maybeRecoverFromInterruptedRestore already gives itself internally.
migrateLegacyUserData(LOCAL_USER)
  .catch(err => console.error('[migration] failed to migrate pre-CURRENT_USER-removal data', err))
  .then(() => maybeRecoverFromInterruptedRestore())
  .then(() => {
    renderHome();
    // The transposition reminder runs AFTER auto-import settles, not
    // racing it (.finally, not a bare call) -- auto-import's own writes can
    // themselves introduce a transposition (a freshly-imported game can
    // transpose into an existing castle), and checking beforehand would
    // miss that on the very session it happened. runAutoImportCheck never
    // actually rejects (each source's own fetch is try/caught internally),
    // but .finally guards the reminder from being silently skipped even if
    // that ever changes. Skipped under the test harness -- an unprompted
    // gatherBuiltCastles build at every boot would throw off the VR cache
    // tests' "clean slate" build-count assertions; Phase DO/DP's own tests
    // drive this explicitly instead (see checkTranspositionsAtBoot's own
    // doc comment).
    runAutoImportCheck().finally(() => {
      if(!localStorage.getItem('threeTestDebug')) checkTranspositionsAtBoot();
    });
  });

// auto-start the background analysis queue: load whatever's left over from a
// prior session and let it start chugging as soon as the engine is ready (see
// the engine.init().then(...) call below) -- no manual "start" step needed.
refreshAnalysisQueue().then(() => maybeResumeAnalysisQueue());

// Perfect Opening's own opportunistic boot kick, plus a periodic poll as the
// robust catch-all: unlike the manual queue, nothing calls maybeResumeAnalysisQueue's
// equivalent for it on every relevant state change (queue-drained, engine-idle,
// etc.), so a 5s poll picks up any missed transition cheaply -- this is a
// background research feature with no latency expectation. Deferred to a
// microtask (not called bare here) since `engine` -- a later `const` in this
// module -- isn't initialized yet at this point in top-to-bottom script
// evaluation.
Promise.resolve().then(() => maybeResumePerfectOpening());
setInterval(() => maybeResumePerfectOpening(), 5000);

// locking the screen (or just switching tabs/windows) backgrounds the page --
// Chrome (and the OS, for a locked session) throttles a hidden page hard to
// save power, so both background consumers can end up crawling or stalled
// between ticks of their own polling. Nothing can (or should) fight that
// throttling while genuinely hidden, but the moment the page is visible
// again, kick both immediately rather than waiting out whatever's left of
// the current poll interval (5s for Perfect Opening; the manual queue has
// no periodic poll of its own at all, so this is its only recovery path
// after a stall like this).
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState !== 'visible') return;
  maybeResumeAnalysisQueue();
  maybeResumePerfectOpening();
});

// offer the default mnemonics/assets bundles when there's nothing in their
// stores yet (see maybeOfferDefaultContent, defined below). Skipped under the
// test harness -- without this guard, any test that boots with an empty
// mnemonics/assets store would pop the (real, full-screen) offer modal over
// every other test's UI, and accepting it would trigger a real
// fetch+decompress+import of the (large) bundles. The dedicated tests for
// this feature drive it explicitly via __defaultContentTestHooks instead.
if(!localStorage.getItem('threeTestDebug')) maybeOfferDefaultContent();

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

/* ---------- import games modal ----------
   Both platforms shown at once (not a source dropdown picking one) so the
   whole import portfolio can be set up in a single visit; each has its own
   username + platform-specific size field, always visible. */
$('menuDownload').onclick = ()=>{
  $('menuList').style.display='none';
  logDl('');
  $('userIdLichess').value = localStorage.getItem(LS_ID) || '';
  $('userIdChesscom').value = localStorage.getItem(LS_ID_CHESSCOM) || '';
  $('maxGames').value = localStorage.getItem(LS_MAX) || 300;
  $('monthsBack').value = localStorage.getItem(LS_MONTHS) || 12;
  $('autoImportCheckbox').checked = localStorage.getItem(LS_AUTO_IMPORT) === '1';
  $('downloadOverlay').style.display='flex';
};
$('downloadCancelBtn').onclick = ()=>{ $('downloadOverlay').style.display='none'; };
$('autoImportCheckbox').onchange = ()=>{
  localStorage.setItem(LS_AUTO_IMPORT, $('autoImportCheckbox').checked ? '1' : '0');
};

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
   repertoire lines/prefs, mnemonics + images, mnemonics notes, and your
   remembered Lichess/chess.com handles) so that importing it into a
   brand-new browser/profile reproduces the exact prior state with no other
   setup required.
*/
// Builds the full backup object without touching the download machinery --
// split out (same rationale as buildMnemonicsExportData) so a test can
// inspect exactly what a backup would contain without capturing a real
// file download.
async function buildBackupData(){
  const lines = await getLines(LOCAL_USER);
  const mnemonicsBySquare = await getAllMnemonics();
  const games = await getGames(LOCAL_USER);
  return {
    version: 6,   // v5 adds threeLayout (VR memory-palace layout); v6 adds objectLists
    // per-platform handles (independent of each other -- see userColorInGame)
    // so restoring on a fresh browser/profile keeps matching "which color did
    // I play" for BOTH platforms, not just whichever one this app version
    // used to treat as "the" identity.
    lichessUser: localStorage.getItem(LS_ID) || '',
    chesscomUser: localStorage.getItem(LS_ID_CHESSCOM) || '',
    exportedAt: new Date().toISOString(),
    games,
    lines: await Promise.all(lines.map(async line=>({
      id: line.id,   // preserve the line id: VR decoration keys (cas:<instanceId>:…) embed it
      name: line.name, color: line.color, openingMoves: line.openingMoves, streetName: line.streetName || '',
      hideUnselectedGameMoves: !!line.hideUnselectedGameMoves,
      prefs: Object.values(await getAllPrefs(line.id)).map(p=>({
        seq:p.seq, reply:p.reply, note:p.note, mnemonic:p.mnemonic,
        hidden:p.hidden, manualReplies:p.manualReplies, eval:p.eval, evalLines:p.evalLines, name:p.name,
        collapsed:p.collapsed, moveQuality:p.moveQuality, compareGames:p.compareGames,
        isCastleRoot:p.isCastleRoot, castleName:p.castleName, castleOwner:p.castleOwner,
        castleStreetNumber:p.castleStreetNumber,
        redirectToCastle:p.redirectToCastle, redirectTargetLineId:p.redirectTargetLineId, redirectTargetSeq:p.redirectTargetSeq,
        redirectTargetRoomName:p.redirectTargetRoomName
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
    decoratedRooms: await getMeta('threeDecoratedRooms'),   // VR room progress: which rooms are flagged fully decorated
    memorizedShapes: await getMeta('threeMemorizedShapes'), // frozen room-shape snapshots for memorized rooms (anti-split heuristic)
    graphLayout: await getMeta('graphLayout'),   // manually-dragged node positions in the network/digraph view
    assets: await getAllAssets(),
    objectLists: await getAllObjectLists()       // ordered mnemonic object lists for castle room walls
  };
}
async function exportBackup(){
  const data = await buildBackupData();
  const stamp = new Date().toISOString().slice(0,10);
  const size = await downloadJsonBackup(data, `repchess-backup-${stamp}`);
  const mb = (size/1048576).toFixed(1);
  log(`exported ${data.lines.length} opening system(s), ${data.games.length} game(s) — ${mb}MB${GZIP_OK ? ' (gzipped)' : ''}`);
}

// test-only generation counter, bumped at the very end of applyBackupData
// (see below) -- the restored lichess/chesscom handles and the download
// modal's #userIdLichess/#userIdChesscom fields are set very early in that
// function, well before games/lines/mnemonics are actually written, so the
// test harness's seedBackup() polls this instead of racing a still-in-flight
// restore under load. Also ticks at the end of a rollback or boot-time
// recovery replay (both call applyBackupData too), which is exactly the
// "restore settled" signal a test waiting on either wants.
let _importBackupGen = 0;
if(localStorage.getItem('threeTestDebug')){
  window.__importBackupGen = () => _importBackupGen;
}

/* The actual wipe+write sequence: wipes every local store first, so the
   result matches `data` exactly rather than merging with (and possibly
   duplicating) whatever is already there. Reused for three different
   callers -- a real restore, an in-session rollback to a pre-restore
   snapshot, and a boot-time replay of a snapshot orphaned by a crash --
   since all three are "make the DB match this object" and nothing else.
   Deliberately does NO validation of `data` (that's importBackup's job,
   run once on the untrusted input file); a snapshot produced by
   buildBackupData() is always trusted shape by construction. */
// `onMnemProgress`, if given, is called with the running count of mnemonic
// squares written so far -- restoring hundreds of squares (each its own
// get-then-put IndexedDB round trip) is slow enough that a caller showing a
// spinner wants to update its label, same as buildMnemonicsExportData's own
// onProgress on the export side.
async function applyBackupData(data, onMnemProgress){
  await clearAllData();
  // clearAllData wiped the analysisQueue store too -- drop the stale in-memory
  // mirror so a lingering background loop can't keep processing/saving
  // against lineIds this restore just replaced.
  ANALYSIS_QUEUE = [];
  // a restore replaces the whole repertoire without a page reload -- drop the
  // cached VR world-build result so the next "Run VR" rebuilds against the
  // restored data instead of showing whatever was cached from before the
  // restore.
  invalidateBuiltCastlesCache();
  invalidatePositionIndexCache();

  // restore each platform's own remembered handle independently (see
  // userColorInGame) -- back-compat: a backup from before per-platform
  // handles were tracked separately only ever carried one ambiguous `user`
  // field (whichever platform happened to be imported first), so fall back
  // to treating that as the Lichess handle, matching this app's old behavior.
  const lichessUser = data.lichessUser ?? data.user ?? '';
  const chesscomUser = data.chesscomUser ?? '';
  localStorage.setItem(LS_ID, lichessUser);
  localStorage.setItem(LS_ID_CHESSCOM, chesscomUser);
  $('userIdLichess').value = lichessUser;
  $('userIdChesscom').value = chesscomUser;

  if(Array.isArray(data.games) && data.games.length) await putGames(LOCAL_USER, data.games);
  GAMES = data.games || [];

  for(const lineData of (data.lines||[])){
    // reuse the original line id when present (older backups omit it) so VR
    // decoration keys that embed it — castle rooms, building facades/signs —
    // still resolve against the restored threeLayout.
    const line = await createLine(LOCAL_USER, {id:lineData.id, name:lineData.name, color:lineData.color, openingMoves:lineData.openingMoves, hideUnselectedGameMoves:lineData.hideUnselectedGameMoves});
    if(lineData.streetName) await updateLine(line.id, {streetName:lineData.streetName});
    for(const pref of (lineData.prefs||[])){
      await setPref(line.id, pref.seq, {
        reply:pref.reply||'', note:pref.note||'', mnemonic:pref.mnemonic||'',
        hidden:pref.hidden||false, manualReplies:pref.manualReplies||[],
        eval:pref.eval||null, evalLines:pref.evalLines||null, name:pref.name||'', collapsed:pref.collapsed||false,
        moveQuality:pref.moveQuality||'', compareGames:pref.compareGames||false,
        isCastleRoot:pref.isCastleRoot||false, castleName:pref.castleName||'', castleOwner:pref.castleOwner||'',
        castleStreetNumber:pref.castleStreetNumber??'',
        redirectToCastle:pref.redirectToCastle||'', redirectTargetLineId:pref.redirectTargetLineId||'',
        redirectTargetSeq:pref.redirectTargetSeq||null, redirectTargetRoomName:pref.redirectTargetRoomName||''
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
  if(typeof data.decoratedRooms === 'string') await setMeta('threeDecoratedRooms', data.decoratedRooms);
  if(typeof data.memorizedShapes === 'string') await setMeta('threeMemorizedShapes', data.memorizedShapes);
  if(typeof data.graphLayout === 'string') await setMeta('graphLayout', data.graphLayout);
  for(const asset of (data.assets||[])) await setAsset(asset.id, asset);
  for(const list of (data.objectLists||[])) await setObjectList(list.id, list);
  log(`restored ${(data.lines||[]).length} opening system(s), ${(data.games||[]).length} game(s)`);
  await renderHome();
  _importBackupGen++;
}

/* ---------- safety backup (crash-surviving pre-restore snapshot) ----------
   Wraps a buildBackupData()-shaped snapshot the same way a real backup file
   is (gzip via CompressionStream when available, same as downloadJsonBackup)
   before handing it to db.js's single-row safetyBackup store -- keeps the
   extra storage/latency this adds to every restore down, without db.js
   needing to know anything about JSON or compression. */
async function persistSafetyBackup(snapshot){
  const json = JSON.stringify(snapshot);
  if(GZIP_OK) await setSafetyBackup({ compressed:true, blob: await gzipString(json) });
  else await setSafetyBackup({ compressed:false, json });
}
async function readSafetyBackup(){
  const row = await getSafetyBackup();
  if(!row) return null;
  const json = row.payload.compressed ? await gunzipToText(row.payload.blob) : row.payload.json;
  return JSON.parse(json);
}

/* full restore, with an automatic safety net: snapshots whatever's currently
   here (via buildBackupData) BEFORE wiping anything, persisting that
   snapshot to IDB so it survives even the tab being closed/crashing
   mid-restore, then applies the new data. A failure mid-apply triggers an
   immediate in-session rollback to the snapshot using the exact same apply
   logic; the persisted copy is cleared only once we're sure the DB actually
   matches either the new data or the rolled-back old data -- if even the
   rollback fails, it's deliberately left in place for
   maybeRecoverFromInterruptedRestore to retry on next boot.
   Caller is responsible for confirming with the user before calling this,
   since it is destructive. `onMnemProgress`, if given, is passed through to
   applyBackupData (see its own doc comment). */
async function importBackup(data, onMnemProgress){
  if(!data || !Array.isArray(data.lines)) throw new Error('not a valid backup file');

  const before = await buildBackupData();
  await persistSafetyBackup(before);
  try {
    await applyBackupData(data, onMnemProgress);
    await clearSafetyBackup();
  } catch(err){
    console.error('[import] restore failed, rolling back to the pre-restore snapshot', err);
    try {
      await applyBackupData(before);
      await clearSafetyBackup();
      log(`import failed (${err.message}) — automatically restored your previous data, nothing was lost`, true);
    } catch(rollbackErr){
      // Leave the persisted snapshot in place -- we can't be sure the DB
      // matches either `data` or `before` right now, so the boot-time
      // recovery check is the last resort, not a redundant safety net.
      console.error('[import] rollback ALSO failed', rollbackErr);
      alert(
        'Import failed, AND the automatic safety rollback also failed.\n\n' +
        'Your data may now be incomplete or inconsistent.\n\n' +
        `Original error: ${err.message}\n` +
        `Rollback error: ${rollbackErr.message}\n\n` +
        'A safety copy of your pre-restore data is still saved locally -- reloading ' +
        'the app should recover it automatically. If that also fails, please ' +
        're-import a backup file if you have one.'
      );
    }
    throw err;
  }
}

/* Boot-time recovery: if a safety-backup row is still here, the last restore
   attempt (in this tab or one that's since closed/crashed) never confirmed
   completion -- neither the real restore nor its own in-session rollback got
   as far as clearing it. Replays that same snapshot with the exact apply
   logic a live rollback would use, before the app renders anything
   data-dependent, so a crash mid-restore leaves the user back where they
   started instead of stuck on a half-written repertoire. Silent+automatic on
   success (consistent with the in-session rollback), matching this feature's
   whole point -- the app should recover itself, not make the user diagnose
   IndexedDB state before they can use it again. */
async function maybeRecoverFromInterruptedRestore(){
  let snapshot;
  try { snapshot = await readSafetyBackup(); }
  catch(err){ console.error('[import] failed to read safety backup at boot', err); return; }
  if(!snapshot) return;

  console.warn('[import] found data from an interrupted restore -- recovering automatically');
  try {
    await applyBackupData(snapshot);
    await clearSafetyBackup();
    log('recovered from an interrupted backup restore (a previous session ended mid-restore) — your data from just before that attempt has been restored', true);
  } catch(err){
    console.error('[import] boot-time recovery failed', err);
    alert(
      'REPchess found data from an interrupted backup restore, but automatic recovery failed.\n\n' +
      `Error: ${err.message}\n\n` +
      'Your data may be incomplete or inconsistent. If you have a backup file, please re-import it now.'
    );
  }
}

/* A standalone asset bundle (from the asset manager's "Export All as JSON"),
   distinct from a full backup. A full backup carries an opening-systems `lines`
   array; an asset bundle is just the assets (plus, now, object lists), tagged
   with `repchessAssets`. */
const isAssetBundle = d =>
  !!d && (d.repchessAssets != null || (Array.isArray(d.assets) && !Array.isArray(d.lines)));

/* asset-only REPLACE: clears the asset store and writes the bundle's assets,
   leaving games/lines/mnemonics untouched. Destructive; caller confirms first.
   Object lists replace the same way when the bundle carries them -- older
   asset-only exports (before object lists were bundled in) won't have the
   field, so an old file's import leaves existing object lists untouched
   rather than silently wiping them. */
async function importAssetBundle(data){
  if(!Array.isArray(data.assets)) throw new Error('not a valid asset export file');
  await clearAssets();
  for(const a of data.assets) await setAsset(a.id, a);
  let listMsg = '';
  if(Array.isArray(data.objectLists)){
    await clearObjectLists();
    for(const list of data.objectLists) await setObjectList(list.id, list);
    listMsg = `, ${data.objectLists.length} object list(s)`;
  }
  log(`replaced assets — imported ${data.assets.length} asset(s)${listMsg}`);
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
   manager. Reads assets and object lists from IndexedDB rather than the
   manager's in-memory list -- object lists ride along too since they're the
   room word-list assignments that bind back to these assets via assetId, and
   a bundle missing them would leave those bindings dangling on restore.
   Split into a pure data-assembly half (no download), mirroring
   buildBackupData/exportBackup, so a test can inspect the bundle directly. */
async function buildAssetsExportData(){
  return {
    repchessAssets: 1,
    exportedAt: new Date().toISOString(),
    assets: await getAllAssets(),
    objectLists: await getAllObjectLists()
  };
}
async function exportAssets(){
  const data = await buildAssetsExportData();
  if(!data.assets.length){ log('no assets to export',true); return; }
  await downloadJsonBackup(data, `repchess-assets-${new Date().toISOString().slice(0,10)}`);
  log(`exported ${data.assets.length} asset(s), ${data.objectLists.length} object list(s)`);
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

/* ---------- default mnemonics / assets bundles (offered on boot) ----------
   json/repchess-mnemonics-DEFAULT.json.gz and json/repchess-assets-DEFAULT.json.gz
   are standalone bundles (same shape an export produces) committed to the
   repo, so a brand-new user can start with a ready-made memory-palace
   word/image set and prop library instead of a blank slate. Each is offered
   independently -- only shown (and only checked by default) when its own
   store is still empty -- but through ONE combined modal with a checkbox per
   offered item, so installing both at once (the common case) is a single
   confirmation. Each is asked about at most once ever: the decision (install
   or skip) is remembered in meta so neither nags on a later boot, whether or
   not that particular checkbox was shown this time.
   MNEM_DEFAULT_URL/MNEM_DEFAULT_OFFERED_KEY/ASSETS_DEFAULT_URL/
   ASSETS_DEFAULT_OFFERED_KEY are declared near the top of the file now (a
   boot-time TDZ fix -- see the comment there). */
async function maybeOfferDefaultContent(){
  if(!GZIP_OK) return;   // both bundles are gzipped; can't read them without DecompressionStream
  const mnemAlreadyOffered = await getMeta(MNEM_DEFAULT_OFFERED_KEY);
  const assetsAlreadyOffered = await getMeta(ASSETS_DEFAULT_OFFERED_KEY);
  const offerMnem = !mnemAlreadyOffered && Object.keys(await getAllMnemonics()).length === 0;
  const offerAssets = !assetsAlreadyOffered && (await getAllAssets()).length === 0;

  // mark both as offered now, before showing anything -- a closed tab or
  // crash mid-modal can't cause either to re-nag on the next boot, and a
  // store that already has content (so its own checkbox won't be shown) is
  // marked done without ever asking, same as before.
  if(!mnemAlreadyOffered) await setMeta(MNEM_DEFAULT_OFFERED_KEY, '1');
  if(!assetsAlreadyOffered) await setMeta(ASSETS_DEFAULT_OFFERED_KEY, '1');
  if(!offerMnem && !offerAssets) return;

  $('defaultContentMnemRow').style.display = offerMnem ? '' : 'none';
  $('defaultContentAssetsRow').style.display = offerAssets ? '' : 'none';
  $('defaultContentMnemChk').checked = true;
  $('defaultContentAssetsChk').checked = true;
  $('defaultContentOverlay').style.display = 'flex';
  $('defaultContentSkipBtn').onclick = () => { $('defaultContentOverlay').style.display = 'none'; };
  $('defaultContentInstallBtn').onclick = async () => {
    $('defaultContentOverlay').style.display = 'none';
    if(offerMnem && $('defaultContentMnemChk').checked) await installDefaultMnemonics();
    if(offerAssets && $('defaultContentAssetsChk').checked) await installDefaultAssets();
  };
}

async function installDefaultMnemonics(){
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

async function installDefaultAssets(){
  const spinner = showSpinner('Downloading default assets…');
  await nextPaint();
  try{
    const resp = await fetch(ASSETS_DEFAULT_URL);
    if(!resp.ok) throw new Error(`fetch failed (${resp.status})`);
    const text = await gunzipToText(await resp.blob());
    const data = JSON.parse(text);
    if(!isAssetBundle(data)) throw new Error('default assets file is not a valid bundle');
    $('spinnerLabel').textContent = 'Installing default assets…';
    await importAssetBundle(data);
    log('installed default assets');
  }catch(err){
    console.error('[default assets] install failed',err);
    log('failed to install default assets: '+err.message,true);
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
    const hasLists = Array.isArray(data.objectLists);
    const listsClause = hasLists ? ` and ${data.objectLists.length} object list(s)` : '';
    const listsWipeClause = hasLists ? ' and object lists' : '';
    if(!confirm(
      'IMPORT ASSETS (REPLACE)?\n\n' +
      `This file contains ${n} asset(s)${listsClause}.\n\n` +
      `Importing assets is currently a REPLACE operation: every asset${listsWipeClause} currently ` +
      'stored in this browser will be DELETED and replaced with the contents of this ' +
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
      if(!res.total){
        log(res.skipped ? `no object lists imported -- ${res.skipped} entr${res.skipped===1?'y':'ies'} had no id and were skipped` : 'no object lists found in that file', true);
        return;
      }
      log(`imported object lists: ${res.added} added, ${res.updated} updated` +
        (res.skipped ? `, ${res.skipped} skipped (no id)` : '') + ` (image bindings preserved)`);
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
  // "new transpositions appearing" (Phase 2): every write path that could
  // add/change a room already calls this function, so it's the one place to
  // hook a debounced re-scan rather than threading a flag through every
  // individual call site -- see scheduleTranspositionScan's own doc comment.
  // Skipped under the test harness: this function is called constantly by
  // ordinary test setup (every pref write), and an unrelated background
  // gatherBuiltCastles build 1.5s later would corrupt the VR cache tests'
  // own build-count/cache-hit assertions -- Phase DO's own tests drive
  // detection directly via forceNewTranspositionsScan instead, same
  // reasoning as maybeOfferDefaultContent's own threeTestDebug guard.
  if(!localStorage.getItem('threeTestDebug')) scheduleTranspositionScan();
}
/* ---------- redirect-aware castle building: transposed GAME continuations ----------
   Phases 3/4 translate PREFS (a set standard response, a manually-recorded
   opponent try) across a redirect -- but a real imported game never writes a
   pref at all: replies()/buildCastleGraph's own "how often has each
   opponent move actually been played" reads GAMES directly, via a literal
   move-string trie (gamesTrieRoot) that has no idea two different move
   orders can reach the same position. So a game that transposes into a
   redirected room and keeps going stays correctly invisible on the SOURCE
   side (processExit stops there, same as every other redirected room) but
   was ALSO invisible at the TARGET, since the game's own recorded moves
   follow the source castle's order, not the target's -- a literal prefix
   search at the target's own position simply never finds it.
   Fixed by synthesizing, purely in memory and only for the duration of one
   gatherBuiltCastles build (never written to the real games store, never
   surfaced in Browse/Compare Games, which read GAMES directly and are
   untouched by this), a re-ordered copy of any such game: same tail of
   moves, re-based onto the target's own move order exactly like Port/import
   already do for prefs. Once spliced into the target castle's own games
   array, replies()'s ordinary literal trie finds it (and counts it toward
   occurrence stats) at the target's own position, same as any other game
   that was actually played in that order. */

/* every game in `sourceGames` whose own recorded move list literally passes
   through `roomFullSeq` (a redirected room's exact position, in its own
   castle's move order), re-based onto `targetSeq`. Case-insensitive move
   comparison, matching buildGamesTrie's own lookup (real game data isn't
   guaranteed consistent SAN casing). */
function synthesizeRedirectedGames(sourceGames, roomFullSeq, targetSeq){
  const roomFullSeqLower = roomFullSeq.map(m => m.toLowerCase());
  const out = [];
  for(const g of sourceGames){
    const moves = (g.moves || '').split(' ').filter(Boolean);
    if(moves.length <= roomFullSeq.length) continue;
    if(!roomFullSeqLower.every((m,i) => moves[i]?.toLowerCase() === m)) continue;
    out.push({ ...g, id: `${g.id||''}:redirect:${targetSeq.join(',')}`,
               moves: [...targetSeq, ...moves.slice(roomFullSeq.length)].join(' ') });
  }
  return out;
}

/* every OTHER line's own redirect declarations that point INTO `lines`,
   grouped by target line id -- a pure read (getAllPrefs per line), entirely
   independent of the withLinePrefs swap gatherBuiltCastles's own per-line
   build uses below, so it's safe to gather up front for every line at once. */
async function gatherRedirectsIntoLines(lines){
  const allPrefs = await Promise.all(lines.map(l => getAllPrefs(l.id)));
  const redirectsIntoLine = new Map();   // targetLineId -> [{ sourceLine, roomFullSeq, targetSeq }]
  lines.forEach((sourceLine, i) => {
    for(const key in allPrefs[i]){
      const p = allPrefs[i][key];
      if(!p?.redirectToCastle || !p.reply || !p.redirectTargetSeq || !p.redirectTargetLineId) continue;
      const arr = redirectsIntoLine.get(p.redirectTargetLineId) || [];
      arr.push({ sourceLine, roomFullSeq: [...p.seq, p.reply], targetSeq: p.redirectTargetSeq });
      redirectsIntoLine.set(p.redirectTargetLineId, arr);
    }
  });
  return redirectsIntoLine;
}

/* "disappearing transpositions" Phase 2: every currently-active redirect
   (any line) whose own target falls AT or BELOW `roomSeq` within `lineId`
   -- i.e. would be broken by hiding `roomSeq` (hiding cuts the graph walk
   there, taking the whole subtree with it, not just that one node). Reuses
   gatherRedirectsIntoLines (Phase 5's own reverse lookup) rather than a
   second db.js/PREFS scan -- same reasoning as Phase 1's on-demand
   findBrokenRedirects: the forward pointer on the SOURCE room is the only
   real source of truth, so there's nothing to precompute or keep in sync. */
async function redirectsIntoSubtree(lineId, roomSeq){
  const lines = await getLines(LOCAL_USER);
  const redirectsIntoLine = await gatherRedirectsIntoLines(lines);
  const incoming = redirectsIntoLine.get(lineId) || [];
  return incoming.filter(r => seqStartsWith(r.targetSeq, roomSeq));
}
// shared by both hideBtn handlers below (renderBranch's own row and the
// root-row renderer's) -- declining leaves the room, and every redirect
// pointing at it, exactly as they were; nothing is repaired proactively,
// only warned about, since the room might still get unhidden instead.
function confirmHideBreaksRedirects(count){
  return confirm(`Hiding this will break ${count} redirect${count===1?'':'s'} that currently point${count===1?'s':''} here as ${count===1?'its':'their'} transpose target -- `
    + `${count===1?'it will':'they will'} be automatically restored to a normal room afterward. Hide anyway?`);
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
        const parsed = JSON.parse(raw);
        // Version-stamped: only reuse a persisted copy built by THIS exact
        // build (BUILD_TAG). A code change to castle/room generation -- e.g.
        // the positionKey position-identity rule, or the room-size floor --
        // doesn't trip this cache's own data-write invalidation triggers, so
        // without the stamp a reload after a deploy keeps serving a castle
        // built under the OLD logic until a manual force-rebuild. A stamp
        // mismatch (or an old, unstamped array) falls through to a fresh
        // rebuild below, which re-persists under the current stamp.
        if(parsed && parsed.version === BUILD_TAG && Array.isArray(parsed.data)){
          _builtCastlesCache = parsed.data;
          console.log('[VR] gatherBuiltCastles: cache hit (persisted across reload), 0ms');
          return _builtCastlesCache;
        }
        console.log(`[VR cache] persisted copy is from a different build (${parsed && parsed.version}, want ${BUILD_TAG}) -- rebuilding`);
      }
    } catch(e){ console.warn('[VR cache] failed to read the persisted cache, rebuilding', e); }
  }
  const t0 = performance.now();
  if(!GAMES){ GAMES = await getGames(LOCAL_USER); }
  // memorized-room-stability Phase 3 needs this loaded BEFORE buildGeneratedCastle
  // runs below (it's synchronous, called from inside a Promise.all/map) -- a cache
  // hit above already returned without reaching here, so this only runs on an
  // actual rebuild, exactly when a fresh read matters.
  await loadMemorizedShapes();
  // every line's own outgoing redirects, indexed by which OTHER line they
  // target -- gathered once, up front (see its own doc comment for why this
  // is safe to do before/alongside the prefs-swap pass just below).
  const redirectsIntoLine = await gatherRedirectsIntoLines(lines);
  // one prefs swap per line, done concurrently rather than one-line-at-a-time:
  // withLinePrefs's fn is fully synchronous (buildGeneratedCastle never awaits),
  // so the "swap in this line's PREFS, run fn, restore" sequence for each line
  // always completes atomically once its getAllPrefs() resolves — no other
  // line's continuation can interleave in between, so running every line's
  // getAllPrefs() IDB read in parallel instead of serially is safe.
  const perLine = await Promise.all(lines.map(line => withLinePrefs(line, () => {
    let lineGames = gamesForLineColor(GAMES, line.color);
    // splice in a synthetic, re-ordered copy of any OTHER line's game that
    // transposes into one of THIS line's own rooms via a redirect (see
    // synthesizeRedirectedGames's own doc comment) -- so a transposed
    // continuation recorded only under the other castle's move order still
    // surfaces (and counts toward occurrence stats) here too.
    const incoming = redirectsIntoLine.get(line.id);
    if(incoming?.length){
      const synthetic = incoming.flatMap(r =>
        synthesizeRedirectedGames(gamesForLineColor(GAMES, r.sourceLine.color), r.roomFullSeq, r.targetSeq));
      if(synthetic.length) lineGames = [...lineGames, ...synthetic];
    }
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
  // stamped with the current build so a later build detects the mismatch and
  // rebuilds instead of serving this copy after castle-gen logic has changed.
  setMeta(BUILT_CASTLES_CACHE_KEY, JSON.stringify({ version: BUILD_TAG, data: out }));   // fire-and-forget: persist across reloads
  console.log(`[VR] gatherBuiltCastles: built ${out.length} castle(s) in ${Math.round(performance.now() - t0)}ms`);
  return out;
}

/* ---------- cross-castle transposition detector ----------
   Two different castles (different line and/or castle name) can each reach
   the exact same chess position via their own, independent move order --
   buildCastleGraph's room-merge (getRoom, keyed by positionKey) only ever
   runs within ONE castle's own walk, so a shared position is never detected
   or merged across castles automatically (castleInstanceId's own doc comment,
   above, confirms the per-castle namespacing is deliberate, not a bug).
   This is a read-only report: group every generated room's own posKey across
   every built castle and surface any position claimed by 2+ distinct castle
   instances, so the user can gauge how common this is before any
   merge/redirect feature gets designed. Scoped to room ANCHORS (gr.posKey)
   -- a multi-move corridor's own interior positions aren't checked
   separately, only the position each generated room is keyed/entered by.
   A pair the user HAS since redirected (Attributes > "Redirect to castle")
   drops out of this report on its own, with no special-casing needed here:
   buildCastleGraph's processExit stops at a redirected room before ever
   building it locally (see the redirect check ahead of the automatic
   foreign-root one), so that position simply never gets a genRoom entry on
   the source side any more -- only the target's own entry is left, which
   is exactly 1 distinct castle instance, below this function's own "2+"
   threshold. So the count here naturally reflects what's still unhandled. */
async function findTransposedRooms(lines){
  const built = await gatherBuiltCastles(lines);
  const byPosKey = new Map();   // posKey -> [{ lineId, lineName, castleName, instanceId, room }]
  for(const c of built){
    const line = lines.find(l => l.id === c.lineId);
    const lineName = line ? line.name : c.lineId;
    for(const gr of c.genRooms){
      if(!gr.posKey) continue;
      const arr = byPosKey.get(gr.posKey) || [];
      arr.push({ lineId: c.lineId, lineName, castleName: c.castleName, instanceId: c.instanceId, room: gr });
      byPosKey.set(gr.posKey, arr);
    }
  }
  const groups = [];
  for(const entries of byPosKey.values()){
    const distinct = new Set(entries.map(e => e.instanceId));
    if(distinct.size < 2) continue;
    groups.push(entries);
  }
  // biggest collisions first (most distinct castles sharing one position),
  // then alphabetically by the first entry's castle name for a stable order.
  groups.sort((a, b) => b.length - a.length || a[0].castleName.localeCompare(b[0].castleName));
  return groups;
}

function renderTranspositionsReport(groups){
  const summary = $('transpSummary');
  const body = $('transpBody');
  if(!groups.length){
    summary.textContent = 'No cross-castle transpositions found.';
    body.innerHTML = '';
    return;
  }
  const roomTotal = groups.reduce((sum, g) => sum + g.length, 0);
  summary.textContent = `${groups.length} position${groups.length===1?'':'s'} reached by 2+ castles (${roomTotal} rooms total).`;
  body.innerHTML = groups.map((entries, gi) => `
    <div class="transp-group">
      <h3>${entries.length} castles share this position</h3>
      ${entries.map((e, ei) => `
        <div class="transp-entry">
          <div>
            <strong>${escapeHtml(e.castleName)}</strong> <span style="color:#777">(${escapeHtml(e.lineName)})</span>
            — room ${escapeHtml(e.room.id)}${e.room.name ? ' "' + escapeHtml(e.room.name) + '"' : ''}<br>
            <span style="color:#555">${escapeHtml(seqToNotation(e.room.seq))}</span>
          </div>
          <button type="button" class="transp-keep-btn" data-group="${gi}" data-entry="${ei}"
            title="Redirect every other room in this group to this one">Keep this, redirect the rest</button>
        </div>
      `).join('')}
    </div>
  `).join('');
  // event delegation (not one listener per button) so a re-render never
  // leaks stale handlers -- innerHTML above already discarded the old ones.
  body.onclick = e => {
    const btn = e.target.closest('.transp-keep-btn');
    if(!btn) return;
    resolveTranspositionGroup(groups[parseInt(btn.dataset.group, 10)], parseInt(btn.dataset.entry, 10));
  };
}

/* Redirects every OTHER entry in this collision group to `entries[winnerIdx]`
   -- the same 3 pref fields (redirectToCastle/redirectTargetLineId/
   redirectTargetSeq) the Attributes modal's own "Redirect to castle" field
   writes (see refreshRedirectField), just applied to every loser in the
   group in one action instead of hunting down each row individually. A
   castle ROOT can't be redirected (same rule refreshRedirectField enforces
   by hiding its own field there) -- skipped here too, counted separately so
   the confirmation message explains why fewer than expected got redirected. */
async function resolveTranspositionGroup(entries, winnerIdx){
  const winner = entries[winnerIdx];
  const others = entries.filter((_, i) => i !== winnerIdx);
  if(!others.length) return;
  const label = `"${winner.castleName}" (${winner.lineName})`;
  if(!confirm(`Redirect every other room in this group to ${label}?\n\n`
    + `Each redirected room's own further responses are suppressed in favor of the target, `
    + `and any existing prep is automatically ported over to it.`)) return;

  const spinner = showSpinner('Redirecting…');
  await nextPaint();
  let skippedRoots = 0, touchedCurrentLine = false;
  // { lineId, roomSeq, saved } per room actually redirected -- reused below
  // to offer porting each one's existing responses, without re-fetching.
  const redirectedLosers = [];
  try {
    for(const loser of others){
      const roomSeq = loser.room.seq.slice(0, -1);
      const pref = await getPref(loser.lineId, roomSeq);
      if(pref?.isCastleRoot){ skippedRoots++; continue; }
      const redirectFields = {
        redirectToCastle: winner.castleName,
        redirectTargetLineId: winner.lineId,
        redirectTargetSeq: winner.room.seq,
        redirectTargetRoomName: winner.room.name || '',
      };
      await setPref(loser.lineId, roomSeq, redirectFields);
      if(loser.lineId === CURRENT_LINE?.id) touchedCurrentLine = true;
      redirectedLosers.push({ lineId: loser.lineId, roomSeq, saved: { ...pref, ...redirectFields } });
    }
    invalidateBuiltCastlesCache();
    if(touchedCurrentLine){
      PREFS = await getAllPrefs(CURRENT_LINE.id);
      renderTreeBody(CURRENT_LINE);
    }
  } finally {
    hideSpinner(spinner);
  }
  const redirected = redirectedLosers.length;
  log(`Redirected ${redirected} room(s) to ${label}`
    + (skippedRoots ? ` (${skippedRoots} skipped -- a castle root can't be redirected)` : ''));
  await refreshTranspositionsReport();

  // ported automatically, for the whole batch, right after -- same idea as
  // the Attributes modal's own redirectChanged/portAndReport pairing, just
  // aggregated since this action can redirect more than one room at once.
  if(redirected){
    let totalPorted = 0;
    for(const { lineId, roomSeq, saved } of redirectedLosers) totalPorted += await portRedirectedResponses(lineId, roomSeq, saved);
    log(totalPorted ? `Ported ${totalPorted} response${totalPorted===1?'':'s'} to ${label}` : `Nothing new to port to ${label}`);
  }
}

async function refreshTranspositionsReport(){
  $('transpSummary').textContent = 'Scanning castles…';
  $('transpBody').innerHTML = '';
  const lines = await getLines(LOCAL_USER);
  const groups = await findTransposedRooms(lines);
  renderTranspositionsReport(groups);
}

// shared by the hamburger menu item and the new-transposition toast's own
// "Show" button (Phase 1) so both open the exact same report the exact same
// way.
async function openTranspositionsReport(){
  $('menuList').style.display='none';
  $('transpOverlay').style.display='flex';
  await refreshTranspositionsReport();
}
$('menuFindTranspositions').onclick = openTranspositionsReport;
$('transpCloseBtn').onclick = ()=>{
  $('transpOverlay').style.display='none';
  // surface anything a background scan found (and suppressed) while the
  // report was open -- see maybeShowNewTranspositionsToast's own comment.
  maybeShowNewTranspositionsToast();
};

/* ---------- new-transposition toast ----------
   Phase 1 of "new transpositions appearing" (see the phasing plan): the
   toast widget itself -- showing/hiding it and wiring Show/dismiss.
   Deliberately persistent, not an auto-dismissing snackbar -- a newly
   created transposition doesn't go away on its own the way a one-off status
   message does, so it stays up until the user acts on it or dismisses it.
   Doesn't survive a reload (in-memory only) -- the boot-time reminder below
   is what covers that gap instead of trying to persist the toast itself.
   `label` distinguishes an edit-triggered scan ("N new transpositions
   found") from the boot-time reminder ("N unresolved transpositions") --
   same widget, different framing, since the boot check can't tell a
   collision that's been sitting unresolved for weeks apart from one an
   auto-import just created THIS load. */
function showNewTranspositionsToast(count, label = 'found'){
  const noun = `transposition${count===1?'':'s'}`;
  $('newTranspToastText').textContent = label === 'unresolved' ? `${count} unresolved ${noun}` : `${count} new ${noun} found`;
  $('newTranspToast').style.display = 'flex';
}
function hideNewTranspositionsToast(){
  $('newTranspToast').style.display = 'none';
}

/* ---------- new-transposition detection (Phase 2) ----------
   Hooked centrally into invalidateBuiltCastlesCache -- the one function
   every write path that could add/change a room already calls -- rather
   than threading a "this might create a new position" flag through the
   30+ call sites that invalidate the cache (renames/notes/hidden-toggles
   included). The cost is a handful of redundant scans after purely cosmetic
   edits, which cost nothing visible since they never turn up a new
   signature; the benefit is one hook instead of thirty.

   A collision GROUP (findTransposedRooms's own per-posKey entries array) is
   identified by its posKey plus the sorted set of distinct castle instance
   ids sharing it -- so a group whose membership actually changes (a third
   castle joins, or one member gets redirected away) counts as a different
   signature, but the exact same pair surviving an unrelated edit doesn't.

   transpSeenSignatures is EVERY signature already accounted for this
   session, whether by the boot-time reminder (see checkTranspositionsAtBoot)
   or by a scan that already toasted it once -- this is what prevents an
   unresolved pair from re-nagging on every subsequent edit. transpPendingSignatures
   is just the ones the toast is CURRENTLY showing (reset on dismiss/Show,
   unlike transpSeenSignatures) -- this is what lets the visible count grow
   if more than one new collision shows up before the user deals with the
   first one. */
const transpSeenSignatures = new Set();
const transpPendingSignatures = new Set();
// "disappearing transpositions" Phase 1: broken redirects fixed by the most
// recent scan(s), not yet shown -- reset on dismiss/Show same as
// transpPendingSignatures, but unlike it there's no "seen" counterpart:
// once a redirect's fields are cleared, it structurally can't be "broken"
// again (a future redirect set on that room would be a brand new act, not
// a re-detection of this one), so nothing needs deduping across scans.
let transpPendingRepairCount = 0;
function transpGroupSignature(entries){
  const posKey = entries[0]?.room?.posKey || '';
  const ids = [...new Set(entries.map(e => e.instanceId))].sort();
  return `${posKey}|${ids.join(',')}`;
}
/* every existing redirect (any pref with redirectToCastle set, across every
   line) whose target no longer resolves to a real room in the just-built
   castle set -- the target room's own reply got cleared/changed, the room
   (or its whole line) got deleted, the room got hidden, or its castle got
   renamed out from under the stored redirectToCastle snapshot. `built` is
   gatherBuiltCastles's own already-built result the caller already has from
   findTransposedRooms's own scan -- gatherBuiltCastles's memory cache makes
   asking for it again here free, this just avoids re-deriving `lines`. */
async function findBrokenRedirects(lines, built){
  const resolvable = new Set();
  for(const c of built) for(const gr of c.genRooms) resolvable.add(`${c.instanceId}|${gr.seq.join(',')}`);
  const broken = [];   // { lineId, roomSeq }
  for(const line of lines){
    const prefs = await getAllPrefs(line.id);
    for(const key in prefs){
      const p = prefs[key];
      if(!p?.redirectToCastle || !p.redirectTargetLineId || !p.redirectTargetSeq) continue;
      const targetKey = `${castleInstanceId(p.redirectTargetLineId, p.redirectToCastle)}|${p.redirectTargetSeq.join(',')}`;
      if(!resolvable.has(targetKey)) broken.push({ lineId: line.id, roomSeq: p.seq });
    }
  }
  return broken;
}
/* the repair: clears a broken redirect's own fields, restoring the room to
   a normal, independently-built one again -- exactly "the variations that
   point there... have their redirect flags removed so that they once again
   become unresolved transpositions". One setPrefsBatch call per source
   line (a redirect from a different line than the one that just triggered
   this scan is entirely possible). */
async function repairBrokenRedirects(broken){
  const byLine = new Map();
  for(const b of broken){
    const arr = byLine.get(b.lineId) || [];
    arr.push(b);
    byLine.set(b.lineId, arr);
  }
  for(const [lineId, items] of byLine){
    const entries = items.map(b => ({ seq: b.roomSeq, patch: {
      redirectToCastle: '', redirectTargetLineId: '', redirectTargetSeq: null, redirectTargetRoomName: '',
    }}));
    await setPrefsBatch(lineId, entries);
  }
  invalidateBuiltCastlesCache();   // the un-redirected room(s) need a real rebuild to show up again
  if(CURRENT_LINE && byLine.has(CURRENT_LINE.id)){
    PREFS = await getAllPrefs(CURRENT_LINE.id);
    renderTreeBody(CURRENT_LINE);
  }
}
/* shared by checkTranspositionsAtBoot and scanForNewTranspositions: finds
   both newly-unaccounted-for collision groups AND broken redirects, repairs
   the broken ones, and toasts whatever's newly pending. collisionLabel
   distinguishes the boot reminder's "unresolved" wording from a live scan's
   "new ... found" wording for the collision half; the repair half reads the
   same either way, since "just got fixed this scan" is equally true for
   both callers. */
async function runTranspositionScan(collisionLabel){
  const lines = await getLines(LOCAL_USER);
  const groups = await findTransposedRooms(lines);
  for(const entries of groups){
    const sig = transpGroupSignature(entries);
    if(transpSeenSignatures.has(sig)) continue;
    transpSeenSignatures.add(sig);
    transpPendingSignatures.add(sig);
  }
  const built = await gatherBuiltCastles(lines);
  const broken = await findBrokenRedirects(lines, built);
  if(broken.length){
    await repairBrokenRedirects(broken);
    transpPendingRepairCount += broken.length;
  }
  maybeShowNewTranspositionsToast(collisionLabel);
}
/* runs ONCE per page load, chained after runAutoImportCheck settles (see the
   boot call site) so it reflects any transposition that import itself just
   introduced, not a pre-import snapshot. A fresh load has no session memory
   of what was already dismissed, so this can't distinguish "just imported
   this boot" from "been sitting unresolved for weeks" -- it doesn't try to;
   it surfaces whatever's currently unresolved as a single reminder (worded
   "unresolved", not "new", since it may well not be), then marks those
   signatures seen the same way a normal scan does so they won't re-toast
   again later this session on their own. Memoized so both the boot-time
   kickoff below AND a scan that happens to race ahead of it (see
   scheduleTranspositionScan) always await the exact same run, and it only
   ever actually executes once. */
let transpBootCheckPromise = null;
function checkTranspositionsAtBoot(){
  if(!transpBootCheckPromise){
    transpBootCheckPromise = runTranspositionScan('unresolved')
      .catch(e => console.warn('[transp toast] boot check failed', e));
  }
  return transpBootCheckPromise;
}
async function scanForNewTranspositions(){
  try { await runTranspositionScan('found'); }
  catch(e){ console.warn('[transp toast] scan failed', e); }
}
// Phase 3: skip popping the toast while the user is already looking at the
// Find Transpositions report -- a second, redundant "N new transpositions
// found" over the report itself is just noise, not new information. Nothing
// found this scan is lost: transpPendingSignatures/transpPendingRepairCount
// still hold it, so this same check (re-run from transpCloseBtn) raises the
// toast the moment the report closes, whether or not the report's own
// (possibly now-stale) listing happened to include it.
function maybeShowNewTranspositionsToast(collisionLabel = 'found'){
  if($('transpOverlay').style.display === 'flex') return;
  const collisionCount = transpPendingSignatures.size;
  if(!collisionCount && !transpPendingRepairCount) return;
  // the common case (no repair pending) reuses showNewTranspositionsToast's
  // own count+label wording unchanged; a pending repair doesn't fit that
  // single count+label shape, so that combined case builds the text here
  // instead, appending the repair note to whatever collision wording (if
  // any) applies.
  if(!transpPendingRepairCount){
    showNewTranspositionsToast(collisionCount, collisionLabel);
    return;
  }
  const parts = [];
  if(collisionCount){
    const noun = `transposition${collisionCount===1?'':'s'}`;
    parts.push(collisionLabel === 'unresolved' ? `${collisionCount} unresolved ${noun}` : `${collisionCount} new ${noun} found`);
  }
  const repairNoun = `redirect${transpPendingRepairCount===1?'':'s'}`;
  parts.push(`${transpPendingRepairCount} ${repairNoun} restored -- target disappeared`);
  $('newTranspToastText').textContent = parts.join('; ');
  $('newTranspToast').style.display = 'flex';
}
const TRANSP_SCAN_DEBOUNCE_MS = 1500;
let transpScanDebounceHandle = null;
function scheduleTranspositionScan(){
  clearTimeout(transpScanDebounceHandle);
  transpScanDebounceHandle = setTimeout(async () => {
    await checkTranspositionsAtBoot();   // no-op once already run
    await scanForNewTranspositions();
  }, TRANSP_SCAN_DEBOUNCE_MS);
}

$('newTranspToastShowBtn').onclick = async () => {
  // dismiss first -- Show is the "I'm dealing with it now" action, so the
  // toast shouldn't still be sitting there once the report itself is open.
  transpPendingSignatures.clear();
  transpPendingRepairCount = 0;
  hideNewTranspositionsToast();
  await openTranspositionsReport();
};
$('newTranspToastDismissBtn').onclick = () => {
  transpPendingSignatures.clear();
  transpPendingRepairCount = 0;
  hideNewTranspositionsToast();
};

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
    const lines = await getLines(LOCAL_USER);
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
    onClose: ()=>{ $('threeTestOverlay').style.display='none'; closeThreeTest(); refreshMemorizedRoomsAndTree(); },
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

// "Quiz a Castle's Lists" and each list card/editor's "used in these
// castles" display (inside the Object List Manager) both need to know which
// castles exist, which are actually built, and which object lists are
// assigned to their rooms' walls -- all app.js-side concepts (LAYOUT
// persistence, castle/line enumeration) that objectLists.js otherwise has no
// reason to know about. Supplied once as a plain data-fetching callback
// object rather than an import, so objectLists.js stays as ignorant of
// "lines"/"castles" as ever -- same reasoning assets.js's openNewAssetModal
// gets imported the other way instead (no castle-shaped state to inject there).
setCastleInfoProvider({
  // every built castle that has at least one wall-list assignment anywhere
  // in it -- an unused castle isn't worth offering (nothing to quiz).
  async listOptions(){
    const lines = await getLines(LOCAL_USER);
    if(!lines.length) return [];
    const built = await gatherBuiltCastles(lines);
    let LAYOUT; try { LAYOUT = JSON.parse(await getMeta('threeLayout') || '{}'); } catch { LAYOUT = {}; }
    const out = [];
    for(const c of built){
      const used = c.genRooms.some(gr => {
        const wl = LAYOUT[castleRoomKey(c.instanceId, gr.posKey)]?.wallLists;
        return wl && Object.values(wl).some(b => b?.listId);
      });
      if(!used) continue;
      const line = lines.find(l => l.id === c.lineId);
      out.push({ lineId: c.lineId, lineName: line ? line.name : c.lineId, castleName: c.castleName });
    }
    return out;
  },
  // every item from every DISTINCT list assigned to any wall bucket anywhere
  // in the chosen castle, combined -- posLabel carries the source list's own
  // name since positions aren't comparable once lists are combined.
  async entriesForCastle(lineId, castleName){
    const lines = await getLines(LOCAL_USER);
    const built = await gatherBuiltCastles(lines);
    const castle = built.find(c => c.lineId === lineId && c.castleName === castleName);
    if(!castle) return [];
    let LAYOUT; try { LAYOUT = JSON.parse(await getMeta('threeLayout') || '{}'); } catch { LAYOUT = {}; }
    const listIds = new Set();
    for(const gr of castle.genRooms){
      const wl = LAYOUT[castleRoomKey(castle.instanceId, gr.posKey)]?.wallLists;
      if(wl) for(const b of Object.values(wl)) if(b?.listId) listIds.add(b.listId);
    }
    if(!listIds.size) return [];
    const lists = await getAllObjectLists();
    const entries = [];
    for(const id of [...listIds].sort()){
      const list = lists.find(l => l.id === id);
      if(!list) continue;
      list.items.forEach((it, i) => entries.push({ name: it.name, assetId: it.assetId, posLabel: `${list.name} #${i + 1}` }));
    }
    return entries;
  },
  // listId -> [{lineName, castleName}, ...], one entry per castle (deduped --
  // regardless of how many of ITS OWN rooms use the list) that has it
  // assigned to any wall bucket anywhere -- powers each list card's "Unused"
  // / "<castle>" / "<castle> + N more" line and the editor's own full "Used
  // in" section (see objectLists.js's LIST_USAGE/usageSummary).
  async usageByListId(){
    const lines = await getLines(LOCAL_USER);
    if(!lines.length) return {};
    const built = await gatherBuiltCastles(lines);
    let LAYOUT; try { LAYOUT = JSON.parse(await getMeta('threeLayout') || '{}'); } catch { LAYOUT = {}; }
    const usage = {};
    for(const c of built){
      const line = lines.find(l => l.id === c.lineId);
      const lineName = line ? line.name : c.lineId;
      const seenHere = new Set();   // dedupe multiple rooms of the SAME castle using the SAME list
      for(const gr of c.genRooms){
        const wl = LAYOUT[castleRoomKey(c.instanceId, gr.posKey)]?.wallLists;
        if(!wl) continue;
        for(const bucket of Object.values(wl)){
          if(!bucket?.listId || seenHere.has(bucket.listId)) continue;
          seenHere.add(bucket.listId);
          (usage[bucket.listId] ??= []).push({ lineName, castleName: c.castleName });
        }
      }
    }
    return usage;
  },
});

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

/* ---------- Reset to Factory ----------
   A hidden-in-plain-sight escape hatch (small link at the bottom of the
   About modal, past a scroll) for wiping a demo/test browser back to a
   clean install: the whole IndexedDB database plus every localStorage key
   this app has ever written, gone, then a hard reload so nothing from the
   old session lingers in memory. Two confirmation steps on the way there --
   a scary warning (with an escape hatch of its own, a one-click full
   backup) and then a typed "TOTAL DELETE" phrase -- since there is no undo
   once deleteEntireDatabase() runs. */
const RESET_FACTORY_PHRASE = 'TOTAL DELETE';
$('resetToFactoryLink').onclick = (e) => {
  e.preventDefault();
  $('aboutOverlay').style.display = 'none';
  $('resetFactoryWarnOverlay').style.display = 'flex';
};
$('resetFactoryBackupLink').onclick = (e) => {
  e.preventDefault();
  exportBackup();
};
$('resetFactoryWarnCancelBtn').onclick = () => { $('resetFactoryWarnOverlay').style.display = 'none'; };
$('resetFactoryWarnContinueBtn').onclick = () => {
  $('resetFactoryWarnOverlay').style.display = 'none';
  $('resetFactoryConfirmInput').value = '';
  $('resetFactoryConfirmError').style.display = 'none';
  $('resetFactoryConfirmDeleteBtn').disabled = true;
  $('resetFactoryConfirmOverlay').style.display = 'flex';
  $('resetFactoryConfirmInput').focus();
};
$('resetFactoryConfirmInput').addEventListener('input', () => {
  $('resetFactoryConfirmError').style.display = 'none';
  $('resetFactoryConfirmDeleteBtn').disabled = $('resetFactoryConfirmInput').value !== RESET_FACTORY_PHRASE;
});
$('resetFactoryConfirmCancelBtn').onclick = () => { $('resetFactoryConfirmOverlay').style.display = 'none'; };
$('resetFactoryConfirmDeleteBtn').onclick = async () => {
  if($('resetFactoryConfirmInput').value !== RESET_FACTORY_PHRASE){
    $('resetFactoryConfirmError').textContent = `Type exactly "${RESET_FACTORY_PHRASE}" to confirm.`;
    $('resetFactoryConfirmError').style.display = '';
    return;
  }
  $('resetFactoryConfirmDeleteBtn').disabled = true;
  await deleteEntireDatabase();
  localStorage.clear();
  location.reload();
};

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
  if(!GAMES){ GAMES = await getGames(LOCAL_USER); }
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
  const lines = await getLines(LOCAL_USER);
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
    const lines = await getLines(LOCAL_USER);
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
    const lines = await getLines(LOCAL_USER);
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
// jumps straight to "Quiz a Castle's Lists" (skipping the list grid) --
// opens the same Manage Object Lists modal the VR Object Lists menu item
// does, since that's where the quiz UI lives, but lands directly on the
// castle-scoped quiz picker instead of the list browser.
$('menuTestObjectLists').onclick = async ()=>{
  $('menuList').style.display='none';
  $('objectListsOverlay').style.display='flex';
  await openObjectListManager($('objectListsBodyWrap'));
  await openCastleQuizPicker();
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
  let {counts} = replies(gamesForLineColor(GAMES || [], OQ.line.color), seq);
  const manual = PREFS[prefKey(OQ.line.id, seq)]?.manualReplies || [];
  manual.forEach(m=>{ if(!(m in counts)) counts[m]=0; });
  counts = filterCountsForLine(counts, 0, manual, OQ.line).counts;
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
  const lines = await getLines(LOCAL_USER);
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
  if(state === 'idle' || state === 'stopped'){
    maybeResumeAnalysisQueue();
    maybeResumePerfectOpening();
  }
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
  maybeResumePerfectOpening();
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
  // a redirected room's badge must show even with no name/castle text of its
  // own -- it's the only visible signal this row's own children are
  // suppressed, so it can't be hidden away behind the "nothing to show" path
  // an unnamed, non-redirected row otherwise takes.
  const redirected = !!saved?.redirectToCastle;
  // clear stale content along with hiding -- otherwise a previous render's
  // name/icon lingers invisibly in the DOM (display:none, but still there
  // for anything that queries it directly rather than checking visibility).
  if(!text && !redirected){ nameSpan.style.display='none'; nameSpan.innerHTML=''; return; }
  const icon = redirected ? '<i class="fa-solid fa-right-left branchName-redirect-icon"></i>' : '';
  nameSpan.innerHTML = icon + escapeHtml(text);
  nameSpan.style.display='';
  // locked takes priority over memorized: a room behind a locked door can
  // never actually be walked into, so any memorized flag on it is stale
  // (e.g. its continuation existed, and was memorized, before getting
  // deleted back down to a dead end) rather than something still true.
  const locked = roomIsLockedForSaved(saved);
  const roomKey = roomKeyForSaved(saved);
  nameSpan.classList.toggle('branchName-locked', locked);
  nameSpan.classList.toggle('branchName-memorized', !locked && !!(roomKey && MEMORIZED_ROOMS[roomKey]));
  const targetRoomName = (saved?.redirectTargetRoomName || '').trim() || 'not yet named';
  nameSpan.title = redirected
    ? `Redirected to "${saved.redirectToCastle}" room "${targetRoomName}" -- this room's own further responses are suppressed; doors here lead to the target castle's room instead`
    : (locked ? 'Behind a locked door in VR (no further moves recorded here) -- can never be walked into or memorized' : '');
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
  // a redirected room's own further responses are suppressed -- adding a new
  // opponent try here would just create invisible, orphaned data.
  const addMoveBtn = rowMenu.querySelector('[data-act="addMove"]');
  if(addMoveBtn) addMoveBtn.style.display = saved?.redirectToCastle ? 'none' : '';
  // the reverse: porting only makes sense once there's somewhere to port TO.
  const portBtn = rowMenu.querySelector('[data-act="portRedirect"]');
  if(portBtn) portBtn.style.display = saved?.redirectToCastle ? '' : 'none';
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
   not a history log. State variables live up near PREFS (not here) since the
   boot-time auto-resume call runs before the module reaches this point in
   top-to-bottom evaluation. */

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
    user: LOCAL_USER, lineId, seq: seq.slice(), depth, multipv,
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
  ANALYSIS_QUEUE = await getAnalysisQueue(LOCAL_USER);
  const lines = await getLines(LOCAL_USER);
  AQ_LINE_NAMES = new Map(lines.map(l => [l.id, l.name]));
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
// suppressed while a drag is in progress (AQ_DRAG truthy) -- a background
// progress update rebuilding the table mid-drag would blow away the drag's
// indicator row and the dragged row's own DOM node out from under the
// pointer handlers still tracking them. reorderAnalysisQueue re-renders once
// the drag actually ends, so nothing is lost, just deferred.
function renderAnalysisQueueModalIfOpen(){ if(aqModalOpen() && !AQ_DRAG) renderAnalysisQueueModal(); }

/* Moves ANALYSIS_QUEUE[i] (found by id) to `targetIndex`, expressed as its
   index in the array AFTER it's been removed -- exactly what
   Array.prototype.splice's own insertion index means, which is also exactly
   what the drag handler below already computes. Index 0 can never be the
   source (it's the item currently being, or about to be, searched, so
   displacing it would waste in-progress engine work) nor a valid
   destination (the lowest a dragged item can land is index 1, right after
   it). Renumbers EVERY item's `order` field to match the new array order and
   persists all of them, rather than trying to compute a minimal-diff order
   value for just the moved item (as the old up/down/top/bottom buttons
   did) -- an arbitrary drop position can land anywhere, so there's no
   single neighbor-swap or midpoint/max+1 formula that covers every case;
   queues are small enough that a full rewrite per drag is cheap. */
async function reorderAnalysisQueue(id, targetIndex){
  const i = ANALYSIS_QUEUE.findIndex(it => it.id === id);
  if(i <= 0) return;
  const dest = Math.max(1, Math.min(targetIndex, ANALYSIS_QUEUE.length - 1));
  if(dest === i) return;
  const [item] = ANALYSIS_QUEUE.splice(i, 1);
  ANALYSIS_QUEUE.splice(dest, 0, item);
  ANALYSIS_QUEUE.forEach((it, idx) => { it.order = idx; });
  await Promise.all(ANALYSIS_QUEUE.map(it => putAnalysisQueueItem(it)));
  renderAnalysisQueueModalIfOpen();
}

// drag state while a grab handle is held: { id, indicator } -- targetIndex
// (below) is folded into this same object once a drag starts, tracked
// separately here only for clarity of what's read vs. written where.
let AQ_DRAG = null;

/* Pointer-based (mouse + touch, via Pointer Events) drag-to-reorder, driven
   from the grab handle's pointerdown. Deliberately not HTML5 drag-and-drop:
   that API has no touch support and gives much coarser control over the
   drop-line feedback than tracking pointer position against each row's own
   bounding rect. */
function aqGrabPointerDown(e){
  e.preventDefault();
  const tr = e.currentTarget.closest('tr');
  const id = tr.dataset.id;
  if(ANALYSIS_QUEUE.findIndex(it => it.id === id) <= 0) return;   // belt-and-suspenders; index 0 has no grab handle anyway
  const body = $('analysisQueueBody');
  const indicator = document.createElement('tr');
  indicator.className = 'aq-drop-indicator';
  indicator.innerHTML = `<td colspan="4"><div class="aq-drop-bar"></div></td>`;
  tr.classList.add('aq-dragging');
  body.insertBefore(indicator, tr.nextSibling);
  AQ_DRAG = { id, indicator, targetIndex: null };
  document.addEventListener('pointermove', aqGrabPointerMove);
  document.addEventListener('pointerup', aqGrabPointerUp, { once: true });
}

// Every row except the one being dragged, in their current (undisturbed)
// DOM order -- gap `k` (0-based) sits right before rows[k], so gap 0 is
// "before the first remaining row," which is always the processing item
// (index 0 is never the one being dragged) and is exactly the gap
// reorderAnalysisQueue also refuses as a destination. rows[target] doubles
// as the indicator's insertion reference: undefined (past the last row)
// correctly means "insertBefore(indicator, undefined)", i.e. append.
function aqGrabPointerMove(e){
  if(!AQ_DRAG) return;
  const body = $('analysisQueueBody');
  const rows = [...body.querySelectorAll('tr.aq-row')].filter(r => r.dataset.id !== AQ_DRAG.id);
  let target = 0;
  for(let k = 0; k < rows.length; k++){
    const rect = rows[k].getBoundingClientRect();
    if(e.clientY > rect.top + rect.height / 2) target = k + 1;
  }
  target = Math.max(1, Math.min(target, rows.length));
  if(target !== AQ_DRAG.targetIndex){
    AQ_DRAG.targetIndex = target;
    body.insertBefore(AQ_DRAG.indicator, rows[target] || null);
  }
}

async function aqGrabPointerUp(){
  document.removeEventListener('pointermove', aqGrabPointerMove);
  if(!AQ_DRAG) return;
  const { id, indicator, targetIndex } = AQ_DRAG;
  // clear the drag visuals synchronously, rather than waiting on
  // reorderAnalysisQueue's eventual re-render (an IDB write away) to do it
  // implicitly -- otherwise the dimmed row and drop bar can visibly linger
  // for a beat after the pointer is released.
  indicator.remove();
  $('analysisQueueBody').querySelector('tr.aq-dragging')?.classList.remove('aq-dragging');
  AQ_DRAG = null;
  if(targetIndex != null) await reorderAnalysisQueue(id, targetIndex);
}

function renderAnalysisQueueModal(){
  const empty = $('analysisQueueEmpty'), table = $('analysisQueueTable'), body = $('analysisQueueBody');
  if(!ANALYSIS_QUEUE.length){
    empty.style.display=''; table.style.display='none'; body.innerHTML='';
    return;
  }
  empty.style.display='none'; table.style.display='';
  body.innerHTML = ANALYSIS_QUEUE.map((item,i) => `
    <tr class="aq-row" data-id="${escapeHtml(item.id)}">
      <td class="aq-reorder">
        ${i >= 1 ? `<span class="aq-grab" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>` : ''}
        <button type="button" class="aq-del" title="Cancel"><i class="fa-solid fa-trash"></i></button>
      </td>
      <td>${aqPositionLabel(item)}</td>
      <td>depth ${item.depth}, ${item.multipv} line${item.multipv===1?'':'s'}</td>
      <td>${aqProgressHtml(item)}</td>
    </tr>`).join('');
  body.querySelectorAll('.aq-del').forEach(btn => {
    btn.onclick = () => cancelAnalysisQueueItem(btn.closest('tr').dataset.id);
  });
  body.querySelectorAll('.aq-grab').forEach(handle => {
    handle.addEventListener('pointerdown', aqGrabPointerDown);
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

/* ---------- Perfect Opening project control panel ----------
   Phase 2 of the Perfect Opening project (see db.js's own section for the
   data model): the control panel itself. Deliberately does NOT create the
   generated line here, even when enabling for the first time -- the line's
   openingMoves needs White's actual move 1, which isn't known until the
   engine determines it (a later phase's job); the line gets created lazily
   at that point instead of eagerly from a placeholder guess here. */
async function renderPerfectOpeningStatus(config){
  if(!config.lineId){
    $('poStatus').textContent = 'Not started yet -- enable and Save to begin.';
    return;
  }
  const pending = (await getPerfectOpeningQueue()).length;
  const variations = `${config.totalVariations} variation${config.totalVariations === 1 ? '' : 's'} generated so far.`;
  const queued = pending
    ? ` ${pending} position${pending === 1 ? '' : 's'} queued for expansion.`
    : (config.enabled ? ' Caught up -- waiting for the manual queue and live analysis to free up the engine.' : ' Paused (disabled).');
  $('poStatus').textContent = variations + queued;
}
function poModalOpen(){ return $('perfectOpeningOverlay').style.display === 'flex'; }
// mirrors renderAnalysisQueueModalIfOpen: called after every job the
// scheduler processes so a control panel left open shows live progress
// instead of only refreshing whenever it's next opened.
function renderPerfectOpeningStatusIfOpen(){
  if(!poModalOpen()) return;
  getPerfectOpeningConfig().then(config => renderPerfectOpeningStatus(config));
}
// mirrors populateThreadsSelect (the live panel's/Analysis Queue's own
// selectors), but sourced from Perfect Opening's own IDB-backed config
// instead of localStorage, and with an extra "Max available" choice (value
// 0) as the sensible default here -- see PERFECT_OPENING_DEFAULT_CONFIG's
// own comment on why maxing out is right for this one, unlike the other two.
function populatePoThreadsSelect(config){
  if(!engine.multithreaded || engine.maxThreads <= 1){
    $('poThreadsField').style.display = 'none';
    return;
  }
  const sel = $('poThreadsSelect');
  sel.innerHTML = [`<option value="0">Max available (${engine.maxThreads})</option>`]
    .concat(Array.from({length: engine.maxThreads}, (_, i) => i + 1).map(n => `<option value="${n}">${n}</option>`))
    .join('');
  sel.value = String(config.threads || 0);
  $('poThreadsField').style.display = '';
}
async function openPerfectOpeningPanel(){
  $('menuList').style.display = 'none';
  const config = await getPerfectOpeningConfig();
  $('poEnabledCheckbox').checked = config.enabled;
  $('poDepth1').value = config.depth[1];
  $('poDepth2').value = config.depth[2];
  $('poDepth3').value = config.depth[3];
  $('poDepth4').value = config.depth[4];
  $('poDepthDefault').value = config.depth.default;
  $('poTolerance').value = config.toleranceCp;
  $('poMaxVariations').value = config.maxTotalVariations;
  $('poMaxLines1').value = config.maxLines[1];
  $('poMaxLines2').value = config.maxLines[2];
  $('poMaxLines3').value = config.maxLines[3];
  $('poMaxLines4').value = config.maxLines[4];
  $('poMaxLinesDefault').value = config.maxLines.default;
  $('poHashMB').value = config.hashMB;
  populatePoThreadsSelect(config);
  $('poError').style.display = 'none';
  $('perfectOpeningOverlay').style.display = 'flex';
  await renderPerfectOpeningStatus(config);
}
$('menuPerfectOpeningManage').onclick = openPerfectOpeningPanel;
$('poCancelBtn').onclick = () => { $('perfectOpeningOverlay').style.display = 'none'; };

function poProgressRow(label, value){
  return `<div class="po-progress-row"><span class="po-progress-label">${escapeHtml(label)}</span><span class="po-progress-value">${escapeHtml(String(value))}</span></div>`;
}
// e.g. 232461000 -> "2d 16h 21m"; drops leading zero units (an estimate
// under an hour just reads "21m", not "0d 0h 21m"), and floors to whole
// minutes since anything finer isn't meaningful for a multi-job estimate.
function formatDurationEstimate(ms){
  const totalMin = Math.round(ms / 60000);
  if(totalMin < 1) return 'less than a minute';
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}
// e.g. 512400 -> "512k", 1420000 -> "1.4m" -- same shorthand lichess uses
// for engine search speed.
function formatEvalsPerSec(nps){
  if(nps >= 1e6) return `${(nps / 1e6).toFixed(1)}m`;
  if(nps >= 1e3) return `${Math.round(nps / 1e3)}k`;
  return String(Math.round(nps));
}
async function renderPerfectOpeningProgress(config){
  if(!config.lineId){
    $('poProgressBody').innerHTML = poProgressRow('Status', 'Not started yet');
    return;
  }
  const queue = await getPerfectOpeningQueue();
  const pending = queue.length;
  // enabled is checked FIRST -- hitting the variation cap auto-disables the
  // project but can still leave jobs queued (the batch that pushed it over
  // the cap spawns children right up to the moment it disables), so a
  // non-empty queue does not by itself mean the scheduler will touch it.
  const status = !config.enabled ? 'Paused (disabled)' : (pending ? 'Running' : 'Caught up (waiting for the engine to free up)');
  const rows = [
    poProgressRow('Status', status),
    poProgressRow('Variations generated', config.totalVariations),
    poProgressRow('Moves fully explored', config.deepestCompleteMove),
    poProgressRow('Positions queued for expansion', pending),
  ];
  if(config.avgNps) rows.push(poProgressRow('Search speed', `${formatEvalsPerSec(config.avgNps)} evals/sec`));
  // the CURRENT move-in-progress is always exactly deepestCompleteMove+1 --
  // deepestCompleteMove is defined as the largest N with nothing queued at
  // ply <= 2N-1, so the shallowest ply actually in the queue always belongs
  // to move deepestCompleteMove+1 (never anything shallower, by that same
  // definition). No projection of future branching needed: every job that
  // still has to run to finish this move already exists in the queue.
  const targetMove = config.deepestCompleteMove + 1;
  const pendingForTarget = queue.filter(j => poJobMoveNumber(j) === targetMove).length;
  if(pendingForTarget && config.avgJobMs){
    rows.push(poProgressRow(`Estimated time to complete move ${targetMove}`, formatDurationEstimate(pendingForTarget * config.avgJobMs)));
  }
  $('poProgressBody').innerHTML = rows.join('');
}
function poProgressModalOpen(){ return $('perfectOpeningProgressOverlay').style.display === 'flex'; }
// mirrors renderPerfectOpeningStatusIfOpen -- keeps the Progress view live
// while it's open instead of only refreshing whenever it's next opened.
function renderPerfectOpeningProgressIfOpen(){
  if(!poProgressModalOpen()) return;
  getPerfectOpeningConfig().then(config => renderPerfectOpeningProgress(config));
}
async function openPerfectOpeningProgressPanel(){
  $('menuList').style.display = 'none';
  const config = await getPerfectOpeningConfig();
  $('perfectOpeningProgressOverlay').style.display = 'flex';
  await renderPerfectOpeningProgress(config);
}
$('menuPerfectOpeningProgress').onclick = openPerfectOpeningProgressPanel;
$('poProgressCloseBtn').onclick = () => { $('perfectOpeningProgressOverlay').style.display = 'none'; };

$('poSaveBtn').onclick = async () => {
  const depth1 = +$('poDepth1').value;
  const depth2 = +$('poDepth2').value;
  const depth3 = +$('poDepth3').value;
  const depth4 = +$('poDepth4').value;
  const depthDefault = +$('poDepthDefault').value;
  const toleranceCp = +$('poTolerance').value;
  const maxTotalVariations = +$('poMaxVariations').value;
  const maxLines1 = +$('poMaxLines1').value;
  const maxLines2 = +$('poMaxLines2').value;
  const maxLines3 = +$('poMaxLines3').value;
  const maxLines4 = +$('poMaxLines4').value;
  const maxLinesDefault = +$('poMaxLinesDefault').value;
  const hashMB = +$('poHashMB').value;
  // hidden (single-threaded build, or maxThreads<=1) means "no real choice
  // to make" -- read whatever's already there so Save doesn't clobber a
  // previously-saved value with 0 just because the field wasn't shown.
  const threads = $('poThreadsField').style.display === 'none' ? undefined : +$('poThreadsSelect').value;

  const showError = (msg) => { $('poError').textContent = msg; $('poError').style.display = ''; };
  const positiveFields = { 'total variation cap': maxTotalVariations, 'hash (MB)': hashMB,
    'move 1 depth': depth1, 'move 2 depth': depth2, 'move 3 depth': depth3, 'move 4 depth': depth4, 'beyond-move-4 depth': depthDefault,
    'move 1 max lines': maxLines1, 'move 2 max lines': maxLines2, 'move 3 max lines': maxLines3,
    'move 4 max lines': maxLines4, 'beyond-move-4 max lines': maxLinesDefault };
  for(const [label, v] of Object.entries(positiveFields)){
    if(!Number.isFinite(v) || v < 1){ showError(`"${label}" must be a positive number.`); return; }
  }
  if(!Number.isFinite(toleranceCp) || toleranceCp < 0){ showError('Pruning tolerance must be zero or a positive number.'); return; }

  const config = await getPerfectOpeningConfig();
  config.enabled = $('poEnabledCheckbox').checked;
  config.depth = { 1: depth1, 2: depth2, 3: depth3, 4: depth4, default: depthDefault };
  config.toleranceCp = toleranceCp;
  config.maxTotalVariations = maxTotalVariations;
  config.maxLines = { 1: maxLines1, 2: maxLines2, 3: maxLines3, 4: maxLines4, default: maxLinesDefault };
  config.hashMB = hashMB;
  if(threads !== undefined) config.threads = threads;
  await setPerfectOpeningConfig(config);
  // a genuinely fresh enable (never built a line, nothing already queued)
  // needs its line and root job seeded -- every job after this one is
  // spawned reactively by processPerfectOpeningJob itself, but nothing else
  // ever creates the very first one. The line is created here (empty
  // openingMoves) rather than waiting for that first job to resolve, so it
  // shows up in the home list right away instead of only once the White
  // root move is actually found; processPerfectOpeningJob's own white-job
  // create branch is still what fires for a queue seeded some other way
  // (e.g. directly via test hooks), since it only takes the create path
  // when config.lineId is still unset by the time that job runs. Guarded on
  // an empty queue too so toggling enabled off and back on mid-run (queue
  // still has leftover jobs) doesn't inject a redundant duplicate root job
  // alongside them.
  if(config.enabled && !config.lineId){
    const line = await createLine(LOCAL_USER, { name: 'Perfect White Opening', color: 'white', openingMoves: [], hideUnselectedGameMoves: true });
    config.lineId = line.id;
    await setPerfectOpeningConfig(config);
    if($('homeScreen').style.display !== 'none') renderHome();
    const queue = await getPerfectOpeningQueue();
    if(!queue.length) await addPerfectOpeningQueueItems([{ id: poJobId('root'), kind: 'white', seq: [], createdAt: Date.now() }]);
  }
  $('perfectOpeningOverlay').style.display = 'none';
  maybeResumePerfectOpening();
};

$('poResetBtn').onclick = async () => {
  if(!confirm('This permanently deletes the generated "Perfect White Opening" line and all progress, and turns the project back off. This cannot be undone. Continue?')) return;
  await resetPerfectOpening();
  await openPerfectOpeningPanel();   // refreshes every field back to defaults, keeps the modal open
};

/* ---------- Perfect Opening project: core expansion logic (Phase 3) ----------
   processPerfectOpeningJob(job, config) does the actual work for ONE pending
   expansion job -- callable in isolation (no scheduler/loop yet, that's
   Phase 4). `job.seq` is a full move-SAN sequence from the game start; a
   White job's seq ends on Black's last move (or is empty, for the very
   first move); a Black job's seq ends on White's last move. Deliberately
   does NOT touch the job's own queue entry (dequeuing/deleting it is a
   scheduling concern, not a per-job-processing one) -- the caller removes
   it from perfectOpeningQueue once this resolves successfully.

   Reuses saveAnalysisQueueResult (the same eval/evalLines persistence the
   real background analysis queue uses) so every node this generates gets
   the same rich eval display as a manually-analyzed one, "improves over
   what's saved" gating included.
*/
function poJobId(tag){
  return `po:${Date.now()}:${Math.random().toString(36).slice(2,8)}:${tag}`;
}
// The move NUMBER a job belongs to -- a White job's seq ends on Black's last
// move (even length), a Black job's seq ends on White's last move (odd
// length); both conventions agree that the very next ply played is move
// floor(seq.length/2)+1.
function poJobMoveNumber(job){
  return Math.floor(job.seq.length / 2) + 1;
}
function poDepthForMove(config, moveNumber){
  return config.depth[moveNumber] ?? config.depth.default;
}
// { threads, hash } for every engine.analyze() call this job processor
// makes -- config.threads:0 means "use the hardware ceiling" (Perfect
// Opening never runs while anything else needs the engine, so unlike the
// live panel/analysis queue's own conservative selectors, maxing out is the
// right default here). engine.maxThreads is 1 on a single-threaded build,
// so this degrades to "no override" there without any special-casing.
function poEngineOptions(config){
  return { threads: config.threads || engine.maxThreads, hash: config.hashMB };
}
// A raw UCI move (e.g. "e2e4", "e7e8q") -> its SAN in `fen`, or null if it
// doesn't parse as a legal move there (shouldn't happen for a move the
// engine itself just reported, but a defensive null is cheap insurance
// against silently corrupting the tree with a bogus move string).
function uciMoveToSan(fen, uciMove){
  const chess = new Chess(fen);
  const from = uciMove.slice(0,2), to = uciMove.slice(2,4), promotion = uciMove.slice(4,5) || undefined;
  const mv = chess.move({from,to,promotion},{sloppy:true});
  return mv ? mv.san : null;
}
// A single comparable number for tolerance filtering, treating any mate
// score as more extreme than any realistic centipawn score (shorter mates
// ranking further from zero in the intuitive direction) -- opening-position
// mate scores are vanishingly rare at any real search depth, so this only
// needs to be reasonable, not exhaustively precise.
function scoreToComparable(score){
  if(score.type === 'mate') return score.value > 0 ? 100000 - score.value : -100000 - score.value;
  return score.value;
}
// Same shape/semantics as addManualReply (js/app.js, near savePrefField),
// but parameterized by lineId/seq instead of assuming CURRENT_LINE -- the
// Perfect Opening line is background-generated and not necessarily the
// line currently open in the UI.
async function addManualReplyTo(lineId, seq, move){
  const existing = (await getPref(lineId, seq))?.manualReplies || [];
  if(existing.includes(move)) return;
  const manualReplies = [...existing, move];
  await setPref(lineId, seq, { manualReplies });
  // if this line happens to be open right now, sync the in-memory PREFS
  // mirror and re-render -- unlike processPerfectOpeningJob's own reply
  // write (above), nothing runs after this call in the same job to trigger
  // that render, so without this a newly-discovered Black survivor would
  // stay invisible in the tree until some other job happens to touch this
  // same line, or the line is reopened.
  if(CURRENT_LINE && CURRENT_LINE.id === lineId){
    invalidateBuiltCastlesCache();   // a new opponent try can open a new exit/room, same as addManualReply
    const key = prefKey(lineId, seq);
    PREFS[key] = {...(PREFS[key] ?? {key, lineId, seq, reply:'', note:'', mnemonic:'', hidden:false}), manualReplies};
    renderTreeBody(CURRENT_LINE);
  }
}

async function processPerfectOpeningJob(job, config){
  const fen = fenForSeq(job.seq);

  if(job.kind === 'white'){
    const whiteDepth = poDepthForMove(config, poJobMoveNumber(job));
    const result = await engine.analyze(fen, { multipv: 1, depth: whiteDepth, ...poEngineOptions(config) });
    // a higher-priority caller (manual queue, live analysis) can preempt the
    // engine mid-search via its own internal _stopCurrent() -- that leaves a
    // shallow result we must not treat as authoritative. Bail out before any
    // persistence so the job stays queued for a later retry.
    if(result.depth < whiteDepth) return { ok: false, reason: 'interrupted before reaching target depth', preempted: true };
    const ranks = Object.keys(result.lines || {});
    if(!ranks.length) return { ok: false, reason: 'engine returned no line' };
    const best = result.lines[1] || result.lines[ranks[0]];
    if(!best?.pv?.length) return { ok: false, reason: 'engine line has no PV' };
    const san = uciMoveToSan(fen, best.pv[0]);
    if(!san) return { ok: false, reason: `unparseable move "${best.pv[0]}"` };

    let lineId = config.lineId;
    if(job.seq.length === 0){
      // the very first move: (re)creates the line, or -- resuming a project
      // that already has one -- just confirms/keeps it. Reset always clears
      // lineId first, so a fresh project always takes the create branch.
      if(!lineId){
        const line = await createLine(LOCAL_USER, { name: 'Perfect White Opening', color: 'white', openingMoves: [san], hideUnselectedGameMoves: true });
        lineId = line.id;
        config.lineId = lineId;
        await setPerfectOpeningConfig(config);
        // the line just appeared out of nowhere from the user's perspective
        // (this all runs in the background) -- if they're sitting on the
        // home screen's opening-systems list right now, refresh it so the
        // new line shows up without them needing to reload the page.
        if($('homeScreen').style.display !== 'none') renderHome();
      } else {
        await updateLine(lineId, { openingMoves: [san] });
        // this line's own openingMoves lives on CURRENT_LINE itself, not a
        // pref -- updateLine alone leaves the in-memory object (and the tree
        // rendered from it) showing the old value until the line is reopened,
        // same staleness saveAnalysisQueueResult's own PREFS sync (below)
        // exists to avoid for eval writes.
        if(CURRENT_LINE && CURRENT_LINE.id === lineId) CURRENT_LINE.openingMoves = [san];
      }
    } else {
      await setPref(lineId, job.seq, { reply: san });
      // setPref writes straight to IndexedDB, bypassing the in-memory PREFS
      // mirror the open tree actually renders from -- sync it here (like
      // savePrefField does for a manual edit) so this reply shows up on the
      // very next render rather than staying invisible until a reload.
      if(CURRENT_LINE && CURRENT_LINE.id === lineId){
        const key = prefKey(lineId, job.seq);
        PREFS[key] = {...(PREFS[key] ?? {key, lineId, seq: job.seq, reply:'', note:'', mnemonic:'', hidden:false}), reply: san};
      }
    }
    await saveAnalysisQueueResult({ lineId, seq: job.seq }, fen, result);

    const childSeq = [...job.seq, san];
    await addPerfectOpeningQueueItems([{ id: poJobId(san), kind: 'black', seq: childSeq, createdAt: Date.now() }]);
    return { ok: true, move: san, spawned: 1, nps: result.nps };
  }

  // Black job: multipv width comes from the move-number schedule (move
  // number = how many full moves have been played so far, including this
  // one -- a Black job's seq always ends on White's move, so seq.length is
  // always odd and (seq.length+1)/2 is an integer).
  const moveNumber = poJobMoveNumber(job);
  const maxLines = config.maxLines[moveNumber] ?? config.maxLines.default;
  const blackDepth = poDepthForMove(config, moveNumber);
  const result = await engine.analyze(fen, { multipv: maxLines, depth: blackDepth, ...poEngineOptions(config) });
  if(result.depth < blackDepth) return { ok: false, reason: 'interrupted before reaching target depth', preempted: true };
  await saveAnalysisQueueResult({ lineId: config.lineId, seq: job.seq }, fen, result);

  const ranks = Object.keys(result.lines || {}).map(Number).sort((a,b) => a-b);
  if(!ranks.length) return { ok: false, reason: 'engine returned no lines' };
  const bestScore = scoreToComparable(result.lines[ranks[0]].score);
  const survivors = [];
  for(const r of ranks){
    const line = result.lines[r];
    if(!line?.score || !line.pv?.length) continue;
    // ranks are engine-ordered best-first for the side to move, so once one
    // rank falls outside tolerance every rank after it is at least as far out.
    if(bestScore - scoreToComparable(line.score) > config.toleranceCp) break;
    const san = uciMoveToSan(fen, line.pv[0]);
    if(san) survivors.push(san);
  }

  const remainingBudget = Math.max(0, config.maxTotalVariations - config.totalVariations);
  const toSpawn = survivors.slice(0, remainingBudget);
  const newJobs = [];
  for(const san of toSpawn){
    await addManualReplyTo(config.lineId, job.seq, san);
    newJobs.push({ id: poJobId(san), kind: 'white', seq: [...job.seq, san], createdAt: Date.now() });
  }
  if(newJobs.length) await addPerfectOpeningQueueItems(newJobs);

  config.totalVariations += toSpawn.length;
  // capped this job (either by budget or the survivor list itself running
  // past budget) -- turn the project off so the scheduler stops attempting
  // further expansion against an exhausted budget, same "reset turns it
  // off too" spirit as resetPerfectOpening.
  if(config.totalVariations >= config.maxTotalVariations) config.enabled = false;
  await setPerfectOpeningConfig(config);

  return { ok: true, survivors: toSpawn, spawned: toSpawn.length, truncatedByBudget: toSpawn.length < survivors.length, nps: result.nps };
}

let poProcessing = false;   // true while maybeResumePerfectOpening's loop is actively running

// Perfect Opening's own scheduler, mirroring processAnalysisQueueLoop's idiom
// (reentrancy guard, re-check the gate every iteration, stop cleanly on the
// first thing that isn't a plain success). It only ever runs when there's
// truly nothing else for the engine to do: the manual analysis queue (any
// depth/multipv, any priority) and live interactive analysis both take
// precedence unconditionally, since Perfect Opening is a background research
// project the user is deliberately never waiting on. Preemption itself is
// free (engine.analyze() always stops whatever's running first) -- this loop
// just has to notice when that happened (processPerfectOpeningJob's own
// depth check) and back off instead of persisting a shallow result.
async function maybeResumePerfectOpening(){
  if(poProcessing) return;
  poProcessing = true;
  try {
    while(true){
      if(ANALYSIS_QUEUE.length || engineState === 'running' || !engine.ready) break;
      const config = await getPerfectOpeningConfig();
      if(!config.enabled) break;
      const queue = await getPerfectOpeningQueue();
      if(!queue.length) break;
      const job = queue[0];
      let result;
      const startedAt = Date.now();
      try {
        result = await processPerfectOpeningJob(job, config);
      } catch(err){
        console.error('[perfectOpening] job failed', err);
        break;
      }
      if(!result.ok){
        // interrupted (preempted) or some other non-fatal problem -- leave
        // the job queued for a later retry and stop for now rather than
        // spinning on the same failure. Not timed -- a preempted job
        // returns early by design, and folding that into the average would
        // skew it toward "faster than a real completed search."
        break;
      }
      await deletePerfectOpeningQueueItem(job.id);
      // recency-weighted (not a plain running average) so the ETA below
      // converges quickly after a move-number transition to a different
      // configured depth, rather than staying skewed by a slower/faster
      // earlier move for a long time.
      const elapsed = Date.now() - startedAt;
      config.avgJobMs = config.avgJobMs ? config.avgJobMs * 0.75 + elapsed * 0.25 : elapsed;
      if(result.nps) config.avgNps = config.avgNps ? config.avgNps * 0.75 + result.nps * 0.25 : result.nps;
      // "move N is fully complete" once nothing queued sits at ply <= 2N-1
      // (White's move N is ply 2N-2, Black's reply is ply 2N-1) -- the FIFO
      // queue processes strictly in ply order (each job's children are
      // appended after every already-queued same-ply sibling), so the
      // shallowest remaining ply is always a true floor on what's left.
      // Only ever moves forward (a momentarily-empty queue holds the last
      // known value, since there's nothing left to compute it from).
      const freshQueue = await getPerfectOpeningQueue();
      if(freshQueue.length){
        const deepest = Math.floor(Math.min(...freshQueue.map(j => j.seq.length)) / 2);
        if(deepest > config.deepestCompleteMove) config.deepestCompleteMove = deepest;
      }
      // one write covers avgJobMs (always updated above) plus deepestCompleteMove
      // (only sometimes) -- config.lineId/totalVariations/enabled may also have
      // just changed inside processPerfectOpeningJob itself; harmless to
      // re-save the same already-persisted values alongside these.
      await setPerfectOpeningConfig(config);
      renderPerfectOpeningStatusIfOpen();
      renderPerfectOpeningProgressIfOpen();
    }
  } finally {
    poProcessing = false;
    // covers the final state after the loop exits for a reason that didn't
    // itself follow a completed job (disabled, preempted, engine claimed
    // elsewhere) -- the per-job render above only fires after a SUCCESSFUL
    // job, so without this the panel could be left showing a stale "queued"
    // count from before the stopping condition was hit.
    renderPerfectOpeningStatusIfOpen();
    renderPerfectOpeningProgressIfOpen();
  }
}

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
  // the manual queue just drained (or yielded because nothing's left it can
  // do) -- give Perfect Opening an immediate chance instead of waiting for
  // its own poll. No-op if disabled/empty/engine unavailable.
  maybeResumePerfectOpening();
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
  // same spinner as importLine (the paste-import dialog) -- this is the
  // OTHER "Import this variation" entry point (the row menu's saved-eval/PV
  // import), which shares importParsedLine/setPrefsBatch but previously had
  // no feedback of its own at all.
  const spinner = showSpinner('Importing…');
  await nextPaint();
  try {
    const targetSnapshots = await fetchRedirectTargetSnapshots(PREFS, CURRENT_LINE.id);
    const targetBatches = new Map();
    const batch = new Map();
    const count = importParsedLine([...startSeq, ...pv], batch, targetBatches, targetSnapshots);
    if(batch.size){
      await setPrefsBatch(CURRENT_LINE.id, [...batch.values()]);   // one commit for the whole PV, same as importLine
      invalidateBuiltCastlesCache();   // writes standard responses the same way importLine does
    }
    await commitRedirectTargetBatches(targetBatches);
    const routed = [...targetBatches.values()].reduce((sum,tb)=>sum+tb.size, 0);
    log(`imported ${count} move(s) from the engine line into "${CURRENT_LINE.name}"`
      + (routed ? ` (${routed} routed to a redirected room's own target castle)` : ''));
    // Targeted re-render (just startSeq's own subtree) instead of a full
    // renderTreeBody whenever possible -- see targetedRenderAfterImport's
    // own comment for why. Falling back to the full rebuild keeps this
    // fully correct (and still avoids the reported focus-loss bug: neither
    // path calls openLine, which is the one that would clearFocus()).
    if(!targetedRenderAfterImport(startSeq)){
      renderTreeBody(CURRENT_LINE);
    } else {
      refreshSystemStats();
      refreshAnalysisQueueRowMarkers();
      populateTableCastleSelect();
    }
  } catch(err){
    console.error('[importEngineVariation]', err);
    log('import failed: ' + err.message, true);
  } finally {
    hideSpinner(spinner);
  }
}

// test-only hook for importEngineVariation: both its real callers (the saved-eval
// PV menu and the live engine panel's PV menu) only reach it after a real engine
// analysis, which the offline harness can't produce (no real Stockfish) -- exposes
// the same function directly so a test can drive its persistence/render logic
// against a synthetic PV, in particular the manual-only-import batch-commit case.
if(localStorage.getItem('threeTestDebug')){
  window.__engineImportTestHooks = {
    importEngineVariation: (startSeq, startFen, uciMoves, maxPlies) => importEngineVariation(startSeq, startFen, uciMoves, maxPlies),
  };
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

// test-only hook for the position identity used by the digraph, castle
// builder, and VR room keys -- so a test can assert the phantom-en-passant
// normalization directly without reconstructing it.
if(localStorage.getItem('threeTestDebug')){
  window.__positionKey = (fen) => positionKey(fen);
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
    reorderAnalysisQueue: (id, targetIndex) => reorderAnalysisQueue(id, targetIndex),
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
    // rewrites the persisted cache's build stamp to a bogus value, so a test
    // can simulate "this persisted copy was built by a different build" without
    // editing BUILD_TAG -- the next open should detect the mismatch and rebuild.
    stalePersistedVersion: async () => {
      const raw = await getMeta(BUILT_CASTLES_CACHE_KEY);
      if(!raw) return false;
      let parsed; try { parsed = JSON.parse(raw); } catch { return false; }
      parsed.version = '__stale_build__';
      await setMeta(BUILT_CASTLES_CACHE_KEY, JSON.stringify(parsed));
      return true;
    },
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

// test-only hook for the boot-time "install starter content?" offer (default
// mnemonics + default assets, one combined modal), skipped from the real
// auto-run under threeTestDebug (see the guarded call up near renderHome())
// so a test can drive it explicitly instead. offer() only shows the modal and
// wires its buttons -- it resolves as soon as that's done, WITHOUT waiting for
// a click, so a test must await it, then interact with the real
// #defaultContentOverlay checkboxes/buttons itself (exactly like a real user),
// then wait on whatever effect it expects (store contents, log line, etc).
// Exercises the real committed json/repchess-*-DEFAULT.json.gz files end to
// end (fetch, gunzip, parse, import) when a checkbox is left checked.
if(localStorage.getItem('threeTestDebug')){
  window.__defaultContentTestHooks = {
    offer: () => maybeOfferDefaultContent(),
    mnemOfferedKey: MNEM_DEFAULT_OFFERED_KEY,
    assetsOfferedKey: ASSETS_DEFAULT_OFFERED_KEY,
    getMnemOffered: () => getMeta(MNEM_DEFAULT_OFFERED_KEY),
    getAssetsOffered: () => getMeta(ASSETS_DEFAULT_OFFERED_KEY),
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
    // rewrites the persisted index's build stamp to a bogus value, so a test
    // can simulate a persisted copy left by a different build -- the next query
    // should detect the mismatch and rebuild rather than trust a stale index.
    stalePersistedIndexVersion: async () => {
      const raw = await getMeta(POSITION_INDEX_CACHE_KEY);
      if(!raw) return false;
      let parsed; try { parsed = JSON.parse(raw); } catch { return false; }
      parsed.version = '__stale_build__';
      await setMeta(POSITION_INDEX_CACHE_KEY, JSON.stringify(parsed));
      return true;
    },
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

// test-only hook for migrateLegacyUserData (db.js) -- lets a test seed a
// record under an arbitrary OLD user key (simulating pre-CURRENT_USER-
// removal data) via the same createLine/putGames/putAnalysisQueueItem the
// real pre-removal code path used, run the migration, then verify by
// reading back under both the old key (should be empty after) and
// LOCAL_USER (should have it). resetFlag lets one test instance run the
// migration more than once (the real flag is one-time-ever).
if(localStorage.getItem('threeTestDebug')){
  window.__migrationTestHooks = {
    localUser: LOCAL_USER,
    migrate: () => migrateLegacyUserData(LOCAL_USER),
    resetFlag: () => localStorage.removeItem('repchess-legacy-user-migration-v1'),
    seedLegacyLine: (user, opts) => createLine(user, opts),
    seedLegacyAnalysisQueueItem: (item) => putAnalysisQueueItem(item),
    getLines: (user) => getLines(user),
    getGames: (user) => getGames(user),
    getAnalysisQueue: (user) => getAnalysisQueue(user),
  };
}

// test-only hook for the Perfect Opening project's data layer (db.js) --
// Phase 1: config storage + the expansion-job queue + reset. Phase 3 adds
// the actual per-job processor, driven against `engine` -- monkey-patch
// engine.analyze via window.__aqTestHooks.engine (the same real Engine
// instance the analysis queue's own tests already fake out) before calling
// processJob, for a fast/deterministic result instead of a real WASM search.
if(localStorage.getItem('threeTestDebug')){
  window.__perfectOpeningTestHooks = {
    defaultConfig: () => JSON.parse(JSON.stringify({
      enabled: false, lineId: null,
      depth: { 1: 20, 2: 20, 3: 20, 4: 20, default: 20 }, toleranceCp: 50,
      maxLines: { 1: 10, 2: 8, 3: 6, 4: 6, default: 6 },
      maxTotalVariations: 50000, totalVariations: 0, deepestCompleteMove: 0, avgJobMs: 0, avgNps: 0,
      threads: 0, hashMB: 512,
    })),
    getConfig: () => getPerfectOpeningConfig(),
    setConfig: (config) => setPerfectOpeningConfig(config),
    getQueue: () => getPerfectOpeningQueue(),
    addQueueItems: (items) => addPerfectOpeningQueueItems(items),
    deleteQueueItem: (id) => deletePerfectOpeningQueueItem(id),
    clearQueueStore: () => clearPerfectOpeningQueueStore(),
    reset: () => resetPerfectOpening(),
    // reuses the exact same real line/pref helpers a genuinely-generated
    // tree would, so tests can seed a stand-in "Perfect White Opening" line
    // without needing Phase 3's actual engine-driven expansion logic yet.
    seedLine: (opts) => createLine(LOCAL_USER, opts),
    getLines: () => getLines(LOCAL_USER),
    processJob: (job, config) => processPerfectOpeningJob(job, config),
    getPref: (lineId, seq) => getPref(lineId, seq),
    // drives the real scheduler directly, bypassing the 5s poll timer, so
    // tests can deterministically resume/drain the queue. Same engine-stub
    // pattern as __aqTestHooks.engine -- Perfect Opening's own engine.analyze()
    // calls are stubbed by the test, so unlike processAnalysisQueueLoop this
    // scheduler CAN run end-to-end in the offline harness.
    maybeResume: () => maybeResumePerfectOpening(),
    isProcessing: () => poProcessing,
    // exposes the real formatter/move-number formula so a test can recompute
    // the expected ETA string from the real persisted avgJobMs/queue rather
    // than duplicating (and risking drift from) this logic itself.
    moveNumberOfJob: (job) => poJobMoveNumber(job),
    formatDurationEstimate: (ms) => formatDurationEstimate(ms),
    formatEvalsPerSec: (nps) => formatEvalsPerSec(nps),
  };
}

// test-only hook for db.js's line CRUD -- plain IDB manipulation, works fine
// in the offline harness. updateLine resolves `true`/`false` depending on
// whether `id` actually matched a stored line, so a test can check that
// signal directly instead of only inferring it from a re-fetch. getLines()
// takes no argument -- every line lives under the one fixed LOCAL_USER key
// (there's no per-identity partitioning to select between), so it always
// returns everything currently stored.
if(localStorage.getItem('threeTestDebug')){
  window.__linesTestHooks = {
    updateLine: (id, patch) => updateLine(id, patch),
    getLines: () => getLines(LOCAL_USER),
  };
}

// test-only hook for reading a SPECIFIC line's own persisted prefs directly --
// the in-memory PREFS global only ever mirrors whichever one line is
// currently open, so a redirect-porting test (which writes into the TARGET
// line, not necessarily the one open in the UI) has no other way to verify
// what actually landed in IndexedDB.
if(localStorage.getItem('threeTestDebug')){
  window.__redirectTestHooks = {
    getAllPrefs: (lineId) => getAllPrefs(lineId),
    // forces a fresh (non-cached) gatherBuiltCastles build across every line,
    // for asserting directly on genRooms/exits -- the layer
    // synthesizeRedirectedGames/gatherRedirectsIntoLines feed into, without
    // needing to navigate the full VR room-registration pipeline just to
    // check an occurrence stat or an exit's presence.
    gatherBuiltCastles: async () => {
      invalidateBuiltCastlesCache();
      return gatherBuiltCastles(await getLines(LOCAL_USER));
    },
    // new-transposition toast (Phase 1): exercised directly since nothing
    // drives it automatically yet -- later phases wire real detection in.
    showNewTranspositionsToast: (count) => showNewTranspositionsToast(count),
    hideNewTranspositionsToast: () => hideNewTranspositionsToast(),
    // computed, not inline, style: the element starts with an EMPTY inline
    // style (hidden only via the stylesheet's own display:none default)
    // until the first real show/hide call ever touches it, so checking
    // .style.display alone would misreport "visible" on that untouched
    // starting state.
    isNewTranspositionsToastVisible: () => getComputedStyle($('newTranspToast')).display !== 'none',
    newTranspositionsToastText: () => $('newTranspToastText').textContent,
    // Phase 2: bypasses scheduleTranspositionScan's own debounce timer so a
    // test doesn't have to sit through the real 1.5s wait -- runs the boot
    // check first (a no-op once it's already run) so the scan always runs
    // against a fully-seeded "seen" set, same as real use.
    forceNewTranspositionsScan: async () => { await checkTranspositionsAtBoot(); await scanForNewTranspositions(); },
    // separated out from forceNewTranspositionsScan so a test can run the
    // boot check explicitly, BEFORE seeding any data -- boot's own
    // automatic call (chained after runAutoImportCheck) is skipped under
    // threeTestDebug (see checkTranspositionsAtBoot's own doc comment), so
    // without this a test's first forceNewTranspositionsScan call would run
    // the boot check against whatever the test had ALREADY seeded by that
    // point, toasting it as "unresolved" instead of leaving it for a later
    // scan to correctly report as "new".
    checkTranspositionsAtBoot: () => checkTranspositionsAtBoot(),
    // Phase 3: the REAL debounced scheduler (setTimeout, TRANSP_SCAN_DEBOUNCE_MS),
    // not the forced-immediate scan above -- for testing that several rapid
    // calls (mirroring several invalidateBuiltCastlesCache calls during one
    // import) collapse into exactly one scan/toast update rather than one
    // per call. Calls the function directly, bypassing
    // invalidateBuiltCastlesCache's own threeTestDebug gate on it (see that
    // gate's doc comment for why the gate exists).
    scheduleNewTranspositionsScan: () => scheduleTranspositionScan(),
    // adds a second, independent castle-root line WITHOUT wiping whatever's
    // already there -- unlike seedBackup (a full-backup restore, which
    // clearAllData()s first), so a test can introduce a genuinely new
    // collision partway through, on top of state earlier assertions in the
    // same test already depend on.
    createLineWithCastleRoot: async ({ id, name, color, openingMoves, rootSeq, reply, castleName }) => {
      const line = await createLine(LOCAL_USER, { id, name, color, openingMoves });
      await setPref(line.id, rootSeq, { reply, isCastleRoot: true, castleName, castleStreetNumber: 1 });
      invalidateBuiltCastlesCache();
      return line.id;
    },
    // "disappearing transpositions" Phase 1: a direct pref write + real
    // cache invalidation, for simulating the edit that breaks a redirect's
    // target -- e.g. changing the target room's own reply to a different
    // move, so its old position no longer exists in that castle's graph.
    setPrefField: async (lineId, seq, patch) => {
      await setPref(lineId, seq, patch);
      invalidateBuiltCastlesCache();
    },
  };
}

// test-only hook for the full-backup export/import round trip -- buildBackupData
// is the pure data-assembly half of exportBackup (no download involved), so a
// test can inspect exactly what a backup would contain after seeding one
// through the real importBackup path (seedBackup drives the actual file-input
// change handler), closing the loop on whether a field survives both directions.
if(localStorage.getItem('threeTestDebug')){
  window.__backupTestHooks = {
    buildBackupData: () => buildBackupData(),
    getMeta: (key) => getMeta(key),
    // Seeds a pending safety-backup row directly, without a real restore --
    // simulates "a previous session crashed mid-restore" so a test can drive
    // maybeRecoverFromInterruptedRestore (normally only run once, at boot)
    // by calling it again rather than needing an actual page reload.
    persistSafetyBackup: (snapshot) => persistSafetyBackup(snapshot),
    hasSafetyBackup: async () => !!(await getSafetyBackup()),
    maybeRecoverFromInterruptedRestore: () => maybeRecoverFromInterruptedRestore(),
  };
}

// test-only hook for the assets-only export/import round trip (the
// hamburger-menu shortcut and the asset manager's "Export All as JSON" share
// this same bundle shape) -- buildAssetsExportData is the pure data-assembly
// half of exportAssets (no download involved), and importAssetBundle is the
// real REPLACE path the file-input handler calls after its confirm() dialog.
if(localStorage.getItem('threeTestDebug')){
  window.__assetsTestHooks = {
    buildExportData: () => buildAssetsExportData(),
    importBundle: (data) => importAssetBundle(data),
    isAssetBundle: (data) => isAssetBundle(data),
    getAllAssets: () => getAllAssets(),
    setAsset: (id, patch) => setAsset(id, patch),
    getAllObjectLists: () => getAllObjectLists(),
    setObjectList: (id, patch) => setObjectList(id, patch),
  };
}

