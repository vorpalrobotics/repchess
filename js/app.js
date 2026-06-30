import { Engine } from './engine.js';
import cytoscape from 'https://esm.sh/cytoscape@3.28.1';
import cytoscapeDagre from 'https://esm.sh/cytoscape-dagre@2.5.0?deps=cytoscape@3.28.1';
import { openThreeTest, closeThreeTest, refreshAssetsLive, setForeignModalOpen } from './threeTest.js';
import { openAssetManager, closeAssetManager, cropImage, fileToDataUrl } from './assets.js';
cytoscape.use(cytoscapeDagre);

// Reaching here means the module's static imports above all loaded; clears the
// boot watchdog in index.html so it doesn't show the "failed to load" message.
window.__APP_BOOTED = true;

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
document.getElementById('buildStamp').textContent =
  `(${typeof APP_VERSION!=='undefined' ? formatBuildStamp(APP_VERSION) : 'dev'})`;

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
const LS_ENGINE_LINES='engine_lastLines', LS_ENGINE_DEPTH='engine_lastDepth';
const LS_SHOW_ALL_BRANCHES='repchess_showAllBranches';
const LS_COMPACT_MODE='repchess_compactMode';
$('userId').value  = localStorage.getItem(LS_ID)  || '';
$('maxGames').value= localStorage.getItem(LS_MAX)||300;

/* ---------- globals ---------- */
let GAMES=null, CURRENT_USER=localStorage.getItem(LS_ID)||'', PREFS={}, CURRENT_LINE=null;

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
      if(moves) games.push({moves});
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
  for(const opp of visibleOpps){
    const lineSeq = [...seq,opp];
    const reply = PREFS[prefKey(CURRENT_LINE.id,lineSeq)]?.reply;
    if(!reply) continue;
    nodeCount++;
    const sub = computeNodeStats(games,[...lineSeq,reply]);
    nodeCount += sub.nodeCount;
    maxBranchFactor = Math.max(maxBranchFactor, sub.maxBranchFactor);
  }
  return {nodeCount, maxBranchFactor};
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
  alert(`Nodes below this point: ${stats.nodeCount}\nMax branch factor: ${stats.maxBranchFactor}`);
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
  span.textContent = formatNodeStats(computeSystemStats(GAMES, CURRENT_LINE));
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

function buildCastleGraph(line, games, rootSeq=null){
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
  function addEdge(fromId,toId,exitSeq){
    edges.push({source:fromId,target:toId,label:plyLabel(exitSeq),fen:fenForSeq(exitSeq),seq:exitSeq.slice()});
  }
  /* exitSeq ends in the opponent's move (one ply past `seq`, which ends in
     OUR move, or is the empty pre-game position at the very top of a black
     line); resolves to either an existing/new room, or a locked leaf. */
  function processExit(fromRoomId, seq, opp){
    const exitSeq = [...seq,opp];
    const reply = PREFS[prefKey(line.id,exitSeq)]?.reply;
    if(!reply){
      const leaf = getLeaf(exitSeq);
      addEdge(fromRoomId,leaf.id,exitSeq);
      return;
    }
    const destSeq = [...exitSeq,reply];
    const destKey = positionKey(fenForSeq(destSeq));
    const alreadyExisted = rooms.has(destKey);
    const destRoom = getRoom(destSeq);
    addEdge(fromRoomId,destRoom.id,exitSeq);
    if(!alreadyExisted) walk(destSeq,destRoom.id);
  }
  /* seq ends in OUR move; enumerate visible opponent replies and recurse */
  function walk(seq, roomId){
    const {counts} = replies(games,seq);
    const manualReplies = PREFS[prefKey(line.id,seq)]?.manualReplies || [];
    manualReplies.forEach(m=>{ if(!(m in counts)) counts[m]=0; });
    const visibleOpps = Object.keys(counts).filter(opp=>
      !PREFS[prefKey(line.id,[...seq,opp])]?.hidden);
    for(const opp of visibleOpps) processExit(roomId,seq,opp);
  }

  const entryRoomIds = [];
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
        addEdge(fromRoomId, room.id, [...fromSeq,opp]);
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
    for(const trigger of triggers){
      if(PREFS[prefKey(line.id,[trigger])]?.hidden) continue;
      processExit('start',[],trigger);
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

async function showTranspositionGraph(){
  if(!CURRENT_LINE || !GAMES){ return; }
  $('graphOverlay').style.display='flex';
  $('graphContainer').innerHTML='';

  const spinner = showSpinner('Building graph…');
  await nextPaint();
  try {
    const {rooms, leaves, edges, entryRoomIds, needsStartNode} = buildCastleGraph(CURRENT_LINE, GAMES, FOCUSED_SEQ);

    const indegree = new Map();
    edges.forEach(e=>indegree.set(e.target,(indegree.get(e.target)||0)+1));
    const mergeCount = [...indegree.values()].filter(c=>c>1).length;

    // ---- linear-run detection ----
    // A run is a maximal chain of rooms joined by "forced" edges: the source
    // room has exactly ONE outgoing edge (counting leaf edges too), that edge
    // targets another room (not a leaf), and the target has in-degree 1 (not a
    // transposition merge). A merge node may be a run's HEAD (in-degree>1) but
    // never a mid/tail member. Runs of >=2 nodes get boxed.
    const roomIds = new Set(rooms.map(r=>r.id));
    const outDeg = new Map();
    edges.forEach(e=>outDeg.set(e.source,(outDeg.get(e.source)||0)+1));
    const chainNext = new Map();     // forced edge: source room id -> target room id
    const chainTarget = new Set();   // rooms that are the target of a forced edge
    for(const e of edges){
      if(!roomIds.has(e.source) || !roomIds.has(e.target)) continue;  // both ends rooms
      if(outDeg.get(e.source) !== 1) continue;                         // source forced
      if((indegree.get(e.target)||0) !== 1) continue;                  // target not a merge
      chainNext.set(e.source, e.target);
      chainTarget.add(e.target);
    }
    const runs = [];
    for(const head of chainNext.keys()){
      if(chainTarget.has(head)) continue;   // walk only from a chain head
      const run = [];
      const seen = new Set();
      let cur = head;
      while(cur !== undefined && !seen.has(cur)){ seen.add(cur); run.push(cur); cur = chainNext.get(cur); }
      if(run.length >= 2) runs.push(run);
    }
    const nodesInRuns = runs.reduce((a,r)=>a+r.length, 0);
    const singleCollapsed = rooms.length - nodesInRuns + runs.length;

    // ---- two-track rooms ----
    // A node H with exactly two outgoing edges, each leading to a (non-merge) run
    // head, can host both runs as the left/right walls of ONE room: H's pair on a
    // central billboard, then a half-wall splitting the two linear branches. So H
    // + run A + run B collapse to a single room.
    const runByHead = new Map();
    runs.forEach(run => runByHead.set(run[0], run));
    const outTargets = new Map();
    edges.forEach(e=>{ if(!outTargets.has(e.source)) outTargets.set(e.source, []); outTargets.get(e.source).push(e.target); });
    const boxOf = new Map();           // room id -> box id
    const boxes = [];                  // {id, label, kind}
    const consumed = new Set();        // run indices folded into a two-track box
    let twoTrackCount = 0;
    rooms.forEach(H => {
      if(outDeg.get(H.id) !== 2) return;
      const [t1, t2] = outTargets.get(H.id) || [];
      if(!runByHead.has(t1) || !runByHead.has(t2) || t1 === t2) return;
      if((indegree.get(t1)||0) !== 1 || (indegree.get(t2)||0) !== 1) return;   // both runs solely owned by H (no transposition head)
      const runA = runByHead.get(t1), runB = runByHead.get(t2);
      const bid = `tt${twoTrackCount++}`;
      boxes.push({ id: bid, label: `2-track ×${1 + runA.length + runB.length}`, kind: 'two-track' });
      boxOf.set(H.id, bid);
      runA.forEach(id=>boxOf.set(id, bid));
      runB.forEach(id=>boxOf.set(id, bid));
      consumed.add(runs.indexOf(runA));
      consumed.add(runs.indexOf(runB));
    });
    runs.forEach((run, i) => {
      if(consumed.has(i)) return;      // already inside a two-track box
      // a run can END on a two-track head (out-degree 2); that head belongs to
      // the two-track room, so drop it from this run. (Already-boxed = the head.)
      const trimmed = run.filter(id => !boxOf.has(id));
      if(trimmed.length < 2) return;   // only a singleton left -> its own unboxed room
      const bid = `run${i}`;
      boxes.push({ id: bid, label: `linear ×${trimmed.length}`, kind: 'run' });
      trimmed.forEach(id=>boxOf.set(id, bid));
    });
    // collapsed = one room per box + one per still-unboxed room
    const twoTrackCollapsed = boxes.length + (rooms.length - boxOf.size);

    $('graphStatus').textContent =
      `${rooms.length} room(s), ${edges.length} move(s), ${leaves.length} not yet built, ${mergeCount} transposition merge point(s)` +
      (runs.length ? ` · ${runs.length} linear run(s) covering ${nodesInRuns} node(s) → ≈ ${singleCollapsed} rooms single-track` +
        (twoTrackCount ? `, ≈ ${twoTrackCollapsed} two-track (${twoTrackCount} pair${twoTrackCount===1?'':'s'})` : '') : '');

    // a room's user-assigned name lives on the opponent-move row that leads into
    // it (room.seq ends in OUR reply, so the name is keyed one ply back);
    // truncate to 12 chars, which is almost always still unique.
    const graphNodeName = seq => {
      const n = (seq && seq.length) ? PREFS[prefKey(CURRENT_LINE.id, seq.slice(0,-1))]?.name : '';
      if(!n) return '';
      const t = n.trim();
      return t.length > 12 ? t.slice(0,12) + '…' : t;
    };

    const elements = [
      ...(needsStartNode ? [{data:{id:'start', label:''}, classes:'start'}] : []),
      ...boxes.map(b=>({ data:{id:b.id, label:b.label}, classes: b.kind === 'two-track' ? 'twotrack-box' : 'run-box' })),
      ...rooms.map(r=>{
        const name = graphNodeName(r.seq);
        const data = {id:r.id, label: name ? `${r.label}\n${name}` : r.label, fen:r.fen, seq:r.seq};
        if(boxOf.has(r.id)) data.parent = boxOf.get(r.id);   // box this room into its run / two-track room
        return {
          data,
          classes: entryRoomIds.includes(r.id) ? 'root' : (indegree.get(r.id)>1 ? 'transposition' : '')
        };
      }),
      ...leaves.map(l=>({ data:{id:l.id, label:'?', fen:l.fen}, classes:'locked' })),
      ...edges.map(e=>({data:{source:e.source,target:e.target,label:e.label,fen:e.fen,seq:e.seq}}))
    ];

    const cy = cytoscape({
      container: $('graphContainer'),
      elements,
      layout: {name:'dagre', rankDir:'TB', nodeSep:18, rankSep:55},
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
          'label':'data(label)', 'font-size':9, 'color':'#333',
          'text-background-color':'#fff', 'text-background-opacity':0.8
        }}
      ]
    });
    attachGraphHoverPreview(cy);
    attachGraphClickHandler(cy);
  } finally {
    hideSpinner(spinner);
  }
}
$('buildGraphBtn').onclick = showTranspositionGraph;
$('graphCloseBtn').onclick = () => {
  $('graphOverlay').style.display='none';
  hideGraphHoverPreview();
};

/* ---------- opening graph hover preview ----------
   Reuses the mini chessboard / #hoverPreview div defined later in this
   file (shared with attachHoverPreview's icon tooltips) to show the
   board position for whichever node or edge the mouse is currently over.
   The virtual 'start' node has no fen and is skipped. */
let graphHoverTimer = null;
function hideGraphHoverPreview(){
  clearTimeout(graphHoverTimer);
  graphHoverTimer = null;
  $('hoverPreview').style.display = 'none';
}
function attachGraphHoverPreview(cy){
  cy.on('mouseover', 'node, edge', evt => {
    const el = evt.target;
    const fen = el.data('fen');
    if(!fen) return;
    clearTimeout(graphHoverTimer);
    graphHoverTimer = setTimeout(() => {
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
    }, 300);
  });
  cy.on('mouseout', 'node, edge', hideGraphHoverPreview);
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
    if(el.hasClass('start') || el.hasClass('locked') || el.hasClass('run-box') || el.hasClass('twotrack-box')) return;
    showRoomInfoPanel(el);
  });
}
const mnemThumbHtml = img => img ? `<img class="room-info-img" src="${img}">` : '';
async function showRoomInfoPanel(roomEl){
  const seq = roomEl.data('seq');
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
      mnemThumbHtml(img) +
      `</div>`;
  });
  $('roomInfoExits').innerHTML = rows.length ? rows.join('') :
    '<div class="room-info-exit room-info-empty">No replies yet</div>';
  $('roomInfoOverlay').style.display = 'flex';
  if($('hoverPreview').style.display === 'block') positionHoverPreviewBesideRoomModal();
}
$('roomInfoCloseBtn').onclick = () => { $('roomInfoOverlay').style.display='none'; };

/* ---------- toggle helper ----------
   `seq`, when given, is this row's own pref seq (ends in the opponent's
   move) — every manual expand/collapse click persists collapsed there too,
   so a single row's expand/collapse choice sticks across reloads the same
   way Collapse All's does, instead of only the bulk action being sticky. */
function makeToggle(btn, branchRow, startExpanded=true, seq=null){
  // the placeholder starts display:none (so leaf rows don't reserve the toggle's
  // width and their move aligns under tree siblings' triangles); reveal it now
  // that this row actually has a sub-tree.
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
}
document.addEventListener('click', closeAllRowMenus);

/* ---------- canonicalize move-input case (castling + piece letters) ----------
   O/Q/N/K/R never collide with file letters (a-h), so they're safe to
   uppercase unconditionally; B is ambiguous with the b-file so left alone. */
const canonicalizeMoveCase = v => v.replace(/[oqnkr]/gi, c => c.toUpperCase());

/* ---------- add note / mnemonic / response modal ---------- */
let fieldModalSave = null, fieldModalValidate = null;
// `validate(rawInput)` is optional; return {ok:true, value} to accept (value
// is what gets passed to onSave, letting the caller normalize the input), or
// {ok:false, error} to reject and keep the modal open with the error shown.
function openFieldModal(field, currentValue, onSave, validate){
  const has = !!currentValue;
  $('fieldModalTitle').textContent =
    field==='note' ? (has ? 'Edit Note' : 'Add Note') :
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
function openAttributesModal(saved, onSave, lineSeq){
  $('attrRoomName').value = saved?.name || '';
  $('attrIsCastleRoot').checked = !!saved?.isCastleRoot;
  $('attrCastleName').value = saved?.castleName || '';
  refreshCastleOwnerSelect(saved, lineSeq);
  refreshAttrFieldVisibility();
  attributesModalSave = onSave;
  $('attributesOverlay').style.display='flex';
}
function refreshAttrFieldVisibility(){
  $('attrCastleNameField').style.display = $('attrIsCastleRoot').checked ? '' : 'none';
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
/* nearest castle root on THIS seq's own lineage (the default/inherited owner) */
function inheritedCastle(lineSeq){
  for(let s = (lineSeq||[]).slice(); s.length; s = s.slice(0,-1)){
    const p = PREFS[prefKey(CURRENT_LINE.id, s)];
    if(p?.isCastleRoot && p.castleName?.trim()) return p.castleName.trim();
  }
  return '';
}
/* "Belongs to castle" override: Auto (inherit) + every defined castle. Only
   needed to resolve a transposition shared by two castles; hidden when no
   castles exist (and there's no stored override to preserve). */
function refreshCastleOwnerSelect(saved, lineSeq){
  const sel = $('attrCastleOwner');
  const inherited = inheritedCastle(lineSeq);
  const castles = definedCastles();
  sel.innerHTML =
    `<option value="">Auto${inherited ? ` (inherit: ${escapeHtml(inherited)})` : ' (no ancestor castle)'}</option>` +
    castles.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = saved?.castleOwner || '';
  $('attrCastleOwnerField').style.display = (castles.length || saved?.castleOwner) ? '' : 'none';
}
$('attrIsCastleRoot').addEventListener('change', refreshAttrFieldVisibility);
$('attributesCancelBtn').onclick = () => {
  $('attributesOverlay').style.display='none';
  attributesModalSave = null;
};
$('attributesSaveBtn').onclick = () => {
  const v = {
    roomName: $('attrRoomName').value.trim(),
    isCastleRoot: $('attrIsCastleRoot').checked,
    castleName: $('attrCastleName').value.trim(),
    castleOwner: $('attrCastleOwner').value
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
  $('tree').querySelectorAll('.toggle').forEach(btn=>{
    if(btn.querySelector('i')?.classList.contains('fa-caret-down')) btn.click();
  });
};
/* mirror of Collapse All — clicking each collapsed toggle expands it (and, like
   Collapse All, persists collapsed:false through makeToggle's onclick). Every
   branch row is rendered eagerly (just hidden when collapsed), so all toggles
   already exist in the DOM and a single pass expands the whole tree. */
$('expandAllBtn').onclick = () => {
  $('tree').querySelectorAll('.toggle').forEach(btn=>{
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
       <button class="iconbtn toggle" style="display:none"><i class="fa-solid fa-caret-right"></i></button>
       ${compactRunLabel(runMoves,flip)}
     </td>
     <td class="cnt-col"></td>
     <td class="eval-col"></td>
     <td class="name-col"></td>`;
  tb.appendChild(tr);
  tr.dataset.seq = endSeq.join(',');   // identity for search/focus: this row stands in for the whole run, ending at endSeq

  const btnEval = tr.querySelector('td.resp > button.iconbtn');
  attachHoverPreview(btnEval, endSeq);
  btnEval.onclick = () => showPosition(fenForSeq(endSeq), ()=>{}, ()=>{});

  const tr1 = document.createElement('tr'); tr1.className='branch-row'; tr.after(tr1);
  const td1 = document.createElement('td'); td1.colSpan=5; td1.style.padding='0'; tr1.appendChild(td1);
  const div = document.createElement('div'); div.className='branch'; td1.appendChild(div);
  renderBranch(div,games,endSeq,endDepth,flip);
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

  const tbl=document.createElement('table');
  parent.appendChild(tbl);

  const tb=tbl.appendChild(document.createElement('tbody'));

  if(!Object.keys(counts).length){
    /* nested tables get an "Add Opponent Move" item in their owning row's
       three-dot menu instead (wired in that row's expandWith closure); only
       the absolute root table (depth 0, no owning row) needs this fallback */
    if(depth===0) appendAddMoveControl(tb,parent,games,seq,depth,flip);
    return;
  }

  if(!flip && depth===0){
    const ctxTr = document.createElement('tr');
    ctxTr.className = 'context-row';
    ctxTr.innerHTML =
      `<td class="resp"></td>
       <td class="move" style="padding-left:${depth}em">${depth+1}. ${seq.at(-1)}</td>
       <td class="cnt-col"></td>
       <td class="eval-col"></td>
       <td class="name-col"></td>`;
    tb.appendChild(ctxTr);
  }

  const indentLevel = flip ? depth : depth+1;

  if(compactMode){
    const run = computeCompactRun(games,seq,depth,flip);
    if(run){
      renderCompactRunRow(tb,games,depth,flip,run,indentLevel);
      if(depth===0) appendAddMoveControl(tb,parent,games,seq,depth,flip);
      return;
    }
  }

  Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([opp,c])=>{
    const isManual = c===0 && manualReplies.includes(opp);
    const tr=document.createElement('tr');
    tr.className = 'data-row';
    tr.dataset.opp = opp;
    const moveHtml = flip
      ? `${depth+1}. ${opp} <span class="ourReply">...</span>`
      : `${opp} ${depth+2}. <span class="ourReply">...</span>`;
    tr.innerHTML=
      `<td class="resp">
         <button class="iconbtn" title="Analyse"><i class="fa-solid fa-chess-board"></i></button>
         <div class="row-menu-wrap">
           <button class="iconbtn rowMenuBtn" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>
           <div class="row-menu">
             <button type="button" data-act="focus"><i class="fa-solid fa-crosshairs"></i>Focus on this Variation</button>
             <button type="button" data-act="hide"><i class="fa-solid fa-eye-slash"></i>Hide This Branch</button>
             <hr class="row-menu-sep">
             <button type="button" data-act="response"><i class="fa-solid fa-check"></i>Set Standard Response</button>
             <button type="button" data-act="analyzeChildren"><i class="fa-solid fa-chess-board"></i>Analyze All Children</button>
             <button type="button" data-act="addMove"><i class="fa-solid fa-plus"></i>Add Opponent Move</button>
             <hr class="row-menu-sep">
             <button type="button" data-act="generateCastle"><i class="fa-solid fa-dungeon"></i>Generate Castle</button>
             <button type="button" data-act="attributes"><i class="fa-solid fa-sliders"></i>Set Attributes</button>
             <button type="button" data-act="nodeStats"><i class="fa-solid fa-diagram-project"></i>Node Statistics</button>
             <button type="button" data-act="note"><i class="fa-solid fa-pen"></i>Add Note</button>
             <hr class="row-menu-sep">
             <button type="button" data-act="openingQuiz"><i class="fa-solid fa-graduation-cap"></i>Opening Quiz</button>
             <button type="button" data-act="removeManual" style="display:none"><i class="fa-solid fa-trash"></i>Remove This Move</button>
           </div>
         </div>
       </td>
       <td class="move" style="padding-left:${indentLevel}em">
         <button class="iconbtn toggle" style="display:none"><i class="fa-solid fa-caret-right"></i></button>
         ${moveHtml}
       </td>
       <td class="cnt-col" style="padding-left:${indentLevel}em">
         <span class="cnt">${c} (${tot ? ((c/tot)*100).toFixed(1) : '0.0'}%)</span>
       </td>
       <td class="eval-col">
         <span class="analyzingIcon" style="display:none" title="Analyzing children — click to stop"><i class="fa-solid fa-calculator fa-fade"></i><span class="analyzingDepth"></span></span>
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
    const analyzingIcon = tr.querySelector('.analyzingIcon');

    const lineSeq = [...seq,opp];
    tr.dataset.seq = lineSeq.join(',');     // stable row identity for focus re-application across rebuilds
    attachHoverPreview(btnEval, lineSeq);
    const currentSaved = () => PREFS[prefKey(CURRENT_LINE.id,lineSeq)];

    /* continuation (PV) line, shown only while toggled open by tapping the
       eval tag; "not available" covers evals saved before PV storage existed */
    let showContinuation = false;
    function continuationHtml(){
      if(!showContinuation) return '';
      const ev = currentSaved()?.eval;
      if(!ev?.pv) return `<span class="meta-pv"><em>not available</em></span>`;
      const startFen = ev.pvFen || fenForSeq(lineSeq);
      const chips = (ev.pvUci?.length && pvChipsFromUci(startFen, ev.pvUci, ev.pvUci.length))
        || pvChipsFromSan(startFen, ev.pv);
      return `<span class="meta-pv">${chips || escapeHtml(ev.pv)}</span>`;
    }
    function refreshMeta(){
      const saved = currentSaved();
      const mnem = saved?.mnemonic || '';
      const note = saved?.note || '';
      const pvHtml = continuationHtml();
      if(!mnem && !note && !pvHtml){ metaTr.style.display='none'; return; }
      metaTd.innerHTML =
        (mnem ? `<span class="meta-mnem" title="Edit mnemonic"><i class="fa-solid fa-brain"></i>${escapeHtml(mnem)}</span>` : '') +
        (note ? `<span class="meta-note" title="Edit note"><i class="fa-solid fa-pen"></i>${escapeHtml(note)}</span>`       : '') +
        pvHtml;
      metaTr.style.display='';

      const mnemEl = metaTd.querySelector('.meta-mnem');
      if(mnemEl) mnemEl.onclick = () => openFieldModal('mnemonic', currentSaved()?.mnemonic, v=>saveField('mnemonic',v));
      const noteEl = metaTd.querySelector('.meta-note');
      if(noteEl) noteEl.onclick = () => openFieldModal('note', currentSaved()?.note, v=>saveField('note',v));
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
    function refreshHidden(){
      const isHidden = !!currentSaved()?.hidden;
      getGroupRows().forEach(el=>el.classList.toggle('hidden-branch', isHidden));
      hideBtn.innerHTML = isHidden
        ? '<i class="fa-solid fa-eye"></i>Unhide This Branch'
        : '<i class="fa-solid fa-eye-slash"></i>Hide This Branch';
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
      renderBranch(div,games,childrenSeq,depth+1,flip);
      makeToggle(toggleBtn,tr1,startExpanded,lineSeq);
    }

    function setStandardResponse(reply){
      setPref(CURRENT_LINE.id,lineSeq,{reply});
      (PREFS[prefKey(CURRENT_LINE.id,lineSeq)] ??= {key:prefKey(CURRENT_LINE.id,lineSeq),lineId:CURRENT_LINE.id,seq:lineSeq,reply:'',note:'',mnemonic:'',hidden:false}).reply=reply;
      const replySpan = tr.querySelector('.ourReply');
      if(replySpan) replySpan.textContent = reply;
      expandWith(reply);
      refreshRowMenuLabels(rowMenu, currentSaved());
      refreshBranchStats(statsSpan, games, childrenSeq);
      refreshSystemStats();
      analyzeChildNodes(childrenSeq, branchDiv, analyzingIcon); // passive: fill in sibling evals now that this branch is newly visible
    }

    /* restore reply from the preloaded PREFS map */
    const savedRep = currentSaved()?.reply;
    if(savedRep){
      const replySpan = tr.querySelector('.ourReply');
      if(replySpan) replySpan.textContent = savedRep;
      expandWith(savedRep, !currentSaved()?.collapsed);
    }
    refreshHidden();
    refreshEvalSpan(evalSpan, currentSaved()?.eval);
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
    rowMenu.querySelector('[data-act="note"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      openFieldModal('note', currentSaved()?.note, v=>saveField('note',v));
    };
    rowMenu.querySelector('[data-act="analyzeChildren"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      if(branchDiv) analyzeChildNodes(childrenSeq, branchDiv, analyzingIcon);
    };
    rowMenu.querySelector('[data-act="nodeStats"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      if(childrenSeq) showNodeStats(games,childrenSeq);
    };
    rowMenu.querySelector('[data-act="openingQuiz"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      openOpeningQuiz(lineSeq);
    };
    rowMenu.querySelector('[data-act="generateCastle"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      if(childrenSeq) showCastleSummary(games,childrenSeq);
    };
    rowMenu.querySelector('[data-act="addMove"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      if(!branchDiv) return;
      openFieldModal('addMove', '', v=>{
        addManualReply(childrenSeq,v);
        branchDiv.innerHTML='';
        renderBranch(branchDiv,games,childrenSeq,depth+1,flip);
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
      openAttributesModal(currentSaved(), v=>{
        saveField('isCastleRoot', v.isCastleRoot);
        saveField('castleName', v.castleName);
        saveField('castleOwner', v.castleOwner);
        saveField('name', v.roomName);
        refreshBranchName(nameSpan, currentSaved());
      }, lineSeq);
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
      const fen = fenForSeq(!flip && childrenSeq ? childrenSeq : lineSeq);
      markLiveEval(evalSpan, btnEval);
      showPosition(fen,
        (d,score,pv)=>recordEvalIfDeeper(saveField,currentSaved,evalSpan,d,score,fen,pv),
        ()=>clearLiveEval(evalSpan));
    };
  });

  if(depth===0) appendAddMoveControl(tb,parent,games,seq,depth,flip);
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
       <button class="iconbtn toggle" style="display:none"><i class="fa-solid fa-caret-right"></i></button>
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
           <button type="button" data-act="hide"><i class="fa-solid fa-eye-slash"></i>Hide This Branch</button>
           <hr class="row-menu-sep">
           <button type="button" data-act="response"><i class="fa-solid fa-check"></i>Set Standard Response</button>
           <button type="button" data-act="analyzeChildren"><i class="fa-solid fa-chess-board"></i>Analyze All Children</button>
           <button type="button" data-act="addMove"><i class="fa-solid fa-plus"></i>Add Opponent Move</button>
           <hr class="row-menu-sep">
           <button type="button" data-act="generateCastle"><i class="fa-solid fa-dungeon"></i>Generate Castle</button>
           <button type="button" data-act="attributes"><i class="fa-solid fa-sliders"></i>Set Attributes</button>
           <button type="button" data-act="nodeStats"><i class="fa-solid fa-diagram-project"></i>Node Statistics</button>
           <button type="button" data-act="note"><i class="fa-solid fa-pen"></i>Add Note</button>
           <hr class="row-menu-sep">
           <button type="button" data-act="openingQuiz"><i class="fa-solid fa-graduation-cap"></i>Opening Quiz</button>
         </div>
       </div>
     </td>
     <td class="move">
       <button class="iconbtn toggle" style="display:none"><i class="fa-solid fa-caret-right"></i></button>
       1. ${trigger} <span class="ourReply">...</span>
     </td>
     <td class="cnt-col"></td>
     <td class="eval-col">
       <span class="analyzingIcon" style="display:none" title="Analyzing children — click to stop"><i class="fa-solid fa-calculator fa-fade"></i><span class="analyzingDepth"></span></span>
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
  const analyzingIcon = tr.querySelector('.analyzingIcon');

  const lineSeq = [trigger];
  tr.dataset.seq = lineSeq.join(',');       // stable row identity for focus re-application across rebuilds
  attachHoverPreview(btnEval, lineSeq);
  const currentSaved = () => PREFS[prefKey(CURRENT_LINE.id,lineSeq)];

  let showContinuation = false;
  function continuationHtml(){
    if(!showContinuation) return '';
    const ev = currentSaved()?.eval;
    if(!ev?.pv) return `<span class="meta-pv"><em>not available</em></span>`;
    const startFen = ev.pvFen || fenForSeq(lineSeq);
    const chips = (ev.pvUci?.length && pvChipsFromUci(startFen, ev.pvUci, ev.pvUci.length))
      || pvChipsFromSan(startFen, ev.pv);
    return `<span class="meta-pv">${chips || escapeHtml(ev.pv)}</span>`;
  }
  function refreshMeta(){
    const saved = currentSaved();
    const mnem = saved?.mnemonic || '';
    const note = saved?.note || '';
    const pvHtml = continuationHtml();
    if(!mnem && !note && !pvHtml){ metaTr.style.display='none'; return; }
    metaTd.innerHTML =
      (mnem ? `<span class="meta-mnem" title="Edit mnemonic"><i class="fa-solid fa-brain"></i>${escapeHtml(mnem)}</span>` : '') +
      (note ? `<span class="meta-note" title="Edit note"><i class="fa-solid fa-pen"></i>${escapeHtml(note)}</span>`       : '') +
      pvHtml;
    metaTr.style.display='';

    const mnemEl = metaTd.querySelector('.meta-mnem');
    if(mnemEl) mnemEl.onclick = () => openFieldModal('mnemonic', currentSaved()?.mnemonic, v=>saveField('mnemonic',v));
    const noteEl = metaTd.querySelector('.meta-note');
    if(noteEl) noteEl.onclick = () => openFieldModal('note', currentSaved()?.note, v=>saveField('note',v));
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
      ? '<i class="fa-solid fa-eye"></i>Unhide This Branch'
      : '<i class="fa-solid fa-eye-slash"></i>Hide This Branch';
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
    renderBranch(div,games,childrenSeq,1,true);
    makeToggle(toggleBtn,tr1,startExpanded);
  }

  function setStandardResponse(reply){
    setPref(CURRENT_LINE.id,lineSeq,{reply});
    (PREFS[prefKey(CURRENT_LINE.id,lineSeq)] ??= {key:prefKey(CURRENT_LINE.id,lineSeq),lineId:CURRENT_LINE.id,seq:lineSeq,reply:'',note:'',mnemonic:'',hidden:false}).reply=reply;
    const replySpan = tr.querySelector('.ourReply');
    if(replySpan) replySpan.textContent = reply;
    expandWith(reply);
    refreshRowMenuLabels(rowMenu, currentSaved());
    refreshBranchStats(statsSpan, games, childrenSeq);
    refreshSystemStats();
    analyzeChildNodes(childrenSeq, branchDiv, analyzingIcon); // passive: fill in sibling evals now that this branch is newly visible
  }

  const savedRep = currentSaved()?.reply;
  if(savedRep){
    const replySpan = tr.querySelector('.ourReply');
    if(replySpan) replySpan.textContent = savedRep;
    expandWith(savedRep, !currentSaved()?.collapsed);
  }
  refreshHidden();
  refreshEvalSpan(evalSpan, currentSaved()?.eval);
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
  rowMenu.querySelector('[data-act="note"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    openFieldModal('note', currentSaved()?.note, v=>saveField('note',v));
  };
  rowMenu.querySelector('[data-act="analyzeChildren"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    if(branchDiv) analyzeChildNodes(childrenSeq, branchDiv, analyzingIcon);
  };
  rowMenu.querySelector('[data-act="nodeStats"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    if(childrenSeq) showNodeStats(games,childrenSeq);
  };
  rowMenu.querySelector('[data-act="openingQuiz"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    openOpeningQuiz(lineSeq);
  };
  rowMenu.querySelector('[data-act="generateCastle"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    if(childrenSeq) showCastleSummary(games,childrenSeq);
  };
  rowMenu.querySelector('[data-act="addMove"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    if(!branchDiv) return;
    openFieldModal('addMove', '', v=>{
      addManualReply(childrenSeq,v);
      branchDiv.innerHTML='';
      renderBranch(branchDiv,games,childrenSeq,1,true);
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
    openAttributesModal(currentSaved(), v=>{
      saveField('isCastleRoot', v.isCastleRoot);
      saveField('castleName', v.castleName);
      saveField('castleOwner', v.castleOwner);
      saveField('name', v.roomName);
      refreshBranchName(nameSpan, currentSaved());
    }, lineSeq);
  };

  btnEval.onclick = () => {
    const fen = fenForSeq(lineSeq);
    markLiveEval(evalSpan, btnEval);
    showPosition(fen,
      (d,score,pv)=>recordEvalIfDeeper(saveField,currentSaved,evalSpan,d,score,fen,pv),
      ()=>clearLiveEval(evalSpan));
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
  clr();
  if(CURRENT_LINE) openLine(CURRENT_LINE);  // re-run automatically
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
function refreshLineStreetName(){
  $('lineStreetName').textContent = CURRENT_LINE ? streetNameForLine(CURRENT_LINE) : '';
}

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
   should show, since GAMES/PREFS are already in memory at that point. */
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
  triggers.forEach(mv=>{
    const wrap = document.createElement('div');
    $('tree').appendChild(wrap);
    if(line.color==='black'){
      renderBlackRoot(wrap,GAMES,mv);
    } else {
      renderBranch(wrap,GAMES,[mv],0);
    }
  });
  refreshSystemStats();

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
      await savePrefField(lineSeq,'collapsed',true);
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
    $('importLineOverlay').style.display='none';
    log(`imported ${totalCount} move(s) from ${importedLines} variation(s) into "${CURRENT_LINE.name}"`
      + (errors.length ? ` (${errors.length} variation(s) skipped, see console)` : ''));
    if(errors.length) console.warn('[importLine] skipped variations:\n' + errors.join('\n'));
    await openLine(CURRENT_LINE);
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

async function searchForLine(text){
  if(!CURRENT_LINE){ $('searchLineError').textContent = 'open an opening system first'; return; }
  let moves;
  try{ moves = parseAlgebraicMoveList(text.trim()); }
  catch(err){ $('searchLineError').textContent = err.message; return; }
  if(!moves.length){ $('searchLineError').textContent = 'paste a move sequence to search for'; return; }

  const triggers = CURRENT_LINE.openingMoves || [];
  if(!triggers.includes(moves[0])){
    $('searchLineError').textContent =
      `this opening system starts with 1. ${triggers.join(' / ')}, but the pasted line starts with 1. ${moves[0]}`;
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
      const {counts} = replies(GAMES,seq);
      const manual = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
      if(!(opp in counts) && !manual.includes(opp)){
        $('searchLineError').textContent =
          `no exact match: after ${seq.join(' ')||'the start'}, "${opp}" isn't a known reply in this opening system`;
        return;
      }
    }
    const lineSeq = moves.slice(0,k+1);
    checkpoints.push(lineSeq.join(','));
    if(k+1 < moves.length){
      const saved = PREFS[prefKey(CURRENT_LINE.id,lineSeq)];
      const expectedReply = moves[k+1];
      if(!saved?.reply){
        $('searchLineError').textContent =
          `no exact match: no standard response is set after ${lineSeq.join(' ')} yet`;
        return;
      }
      if(saved.reply !== expectedReply){
        $('searchLineError').textContent =
          `no exact match: standard response after ${lineSeq.join(' ')} is "${saved.reply}", not "${expectedReply}"`;
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
    logDl(`imported ${fetched.length} (${GAMES.length} total)`);
    $('downloadOverlay').style.display='none';
    if(CURRENT_LINE) await openLine(CURRENT_LINE);
    else await renderHome();
  }catch(e){ console.error('[dlBtn] import failed',e); logDl(e.message,true); }
};

renderHome();

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
    version: 4,
    user: CURRENT_USER,
    exportedAt: new Date().toISOString(),
    games,
    lines: await Promise.all(lines.map(async line=>({
      name: line.name, color: line.color, openingMoves: line.openingMoves, streetName: line.streetName || '',
      prefs: Object.values(await getAllPrefs(line.id)).map(p=>({
        seq:p.seq, reply:p.reply, note:p.note, mnemonic:p.mnemonic,
        hidden:p.hidden, manualReplies:p.manualReplies, eval:p.eval, name:p.name,
        collapsed:p.collapsed,
        isCastleRoot:p.isCastleRoot, castleName:p.castleName, castleOwner:p.castleOwner
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
    assets: await getAllAssets()
  };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `repchess-backup-${CURRENT_USER}-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  log(`exported ${lines.length} opening system(s), ${games.length} game(s)`);
}

/* full restore: wipes every local store first, so the result matches the
   backup exactly rather than merging with (and possibly duplicating)
   whatever is already there. Caller is responsible for confirming with
   the user before calling this, since it is destructive. */
async function importBackup(data){
  if(!data || !Array.isArray(data.lines)) throw new Error('not a valid backup file');
  if(!data.user) throw new Error('backup file has no user id');

  await clearAllData();

  CURRENT_USER = data.user;
  localStorage.setItem(LS_ID, CURRENT_USER);
  $('userId').value = CURRENT_USER;

  if(Array.isArray(data.games) && data.games.length) await putGames(CURRENT_USER, data.games);
  GAMES = data.games || [];

  for(const lineData of data.lines){
    const line = await createLine(CURRENT_USER, {name:lineData.name, color:lineData.color, openingMoves:lineData.openingMoves});
    if(lineData.streetName) await updateLine(line.id, {streetName:lineData.streetName});
    for(const pref of (lineData.prefs||[])){
      await setPref(line.id, pref.seq, {
        reply:pref.reply||'', note:pref.note||'', mnemonic:pref.mnemonic||'',
        hidden:pref.hidden||false, manualReplies:pref.manualReplies||[],
        eval:pref.eval||null, name:pref.name||'', collapsed:pref.collapsed||false,
        isCastleRoot:pref.isCastleRoot||false, castleName:pref.castleName||'', castleOwner:pref.castleOwner||''
      });
    }
  }
  for(const entry of (data.mnemonics||[])){
    const patch = {};
    for(const p of MNEM_PIECES){
      patch[p] = entry[p] || '';
      patch[p+'Desc'] = entry[p+'Desc'] || '';
      patch[p+'Img'] = entry[p+'Img'] || '';
    }
    await setMnemonicSquare(entry.square, patch);
  }
  if(typeof data.mnemonicsNotes === 'string') await setMeta(MNEM_NOTES_KEY, data.mnemonicsNotes);
  if(typeof data.moveDisambiguator === 'string') await setMeta(MNEM_DISAMBIG_KEY, data.moveDisambiguator);
  for(const asset of (data.assets||[])) await setAsset(asset.id, asset);
  log(`restored ${data.lines.length} opening system(s), ${(data.games||[]).length} game(s)`);
  await renderHome();
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
async function exportMnemonics(){
  const mnemonicsBySquare = await getAllMnemonics();
  const data = {
    repchessMnemonics: true,
    version: 1,
    exportedAt: new Date().toISOString(),
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
    moveDisambiguator: await getMeta(MNEM_DISAMBIG_KEY)
  };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `repchess-mnemonics-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  log(`exported ${data.mnemonics.length} mnemonic square(s)`);
}

/* assets-only export: same bundle shape the asset manager's "Export All as
   JSON" produces (tagged `repchessAssets` so the unified importer recognises
   it), but callable straight from the hamburger menu without opening the asset
   manager. Reads assets from IndexedDB rather than the manager's in-memory list. */
async function exportAssets(){
  const assets = await getAllAssets();
  if(!assets.length){ log('no assets to export',true); return; }
  const bundle = { repchessAssets: 1, exportedAt: new Date().toISOString(), assets };
  const blob = new Blob([JSON.stringify(bundle,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `repchess-assets-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  log(`exported ${assets.length} asset(s)`);
}

/* recognises a mnemonics-only bundle: explicitly tagged, or (defensively) a
   file that carries a `mnemonics` array but none of the other top-level stores
   a full backup / asset bundle would have. */
const isMnemonicsBundle = d =>
  !!d && (d.repchessMnemonics != null ||
    (Array.isArray(d.mnemonics) && !Array.isArray(d.lines) &&
     !Array.isArray(d.assets) && d.repchessAssets == null));

/* mnemonics-only REPLACE: wipes the mnemonics store (and notes) and writes the
   bundle's entries, leaving games/lines/assets untouched. No merge. Destructive;
   caller confirms first. */
async function importMnemonicsBundle(data){
  if(!Array.isArray(data.mnemonics)) throw new Error('not a valid mnemonics export file');
  await clearMnemonics();
  for(const entry of data.mnemonics){
    const patch = {};
    for(const p of MNEM_PIECES){
      patch[p] = entry[p] || '';
      patch[p+'Desc'] = entry[p+'Desc'] || '';
      patch[p+'Img'] = entry[p+'Img'] || '';
    }
    await setMnemonicSquare(entry.square, patch);
  }
  if(typeof data.mnemonicsNotes === 'string') await setMeta(MNEM_NOTES_KEY, data.mnemonicsNotes);
  if(typeof data.moveDisambiguator === 'string') await setMeta(MNEM_DISAMBIG_KEY, data.moveDisambiguator);
  MNEMONICS = await getAllMnemonics();
  log(`replaced mnemonics — imported ${data.mnemonics.length} square(s)`);
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
$('backupImport').addEventListener('change', async e=>{
  const f = e.target.files[0];
  e.target.value = '';
  if(!f) return;

  let data;
  try{ data = JSON.parse(await f.text()); }
  catch(err){
    console.error('[import] parse failed',err);
    log('import failed: not a valid JSON file',true);
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

  // Otherwise treat it as a full backup restore.
  if(!confirm(
    'RESTORE FULL BACKUP?\n\n' +
    'This will permanently DELETE everything currently stored in this browser — ' +
    'all opening systems, notes, mnemonics (including images), and downloaded games — ' +
    'and replace it with the contents of this backup file.\n\n' +
    'Any changes made since this backup was taken WILL BE LOST. This cannot be undone.\n\n' +
    'Continue?'
  )) return;
  try{
    await importBackup(data);
  }catch(err){
    console.error('[import] failed',err);
    log('import failed: '+err.message,true);
  }
});

/* ---------- three.js prototype ---------- */
// The walking modal is chromeless — its Close and Assets controls are icon
// buttons overlaid on the canvas (built in threeTest.js); we hand it callbacks
// for those actions rather than wiring header buttons here.
let assetsOpenedFromThreeTest = false;
function openThreeTestAssets(){
  assetsOpenedFromThreeTest = true;
  setForeignModalOpen(true);
  $('assetsOverlay').style.display='flex';
  openAssetManager($('assetsBodyWrap'));
}
$('menuThreeTest').onclick = async ()=>{
  $('menuList').style.display='none';
  $('threeTestOverlay').style.display='flex';
  // feed the walker the opening systems so it can lay out one street per system
  // (white branches right off Main Street, black branches left)
  const lines = CURRENT_USER ? await getLines(CURRENT_USER) : [];
  const systems = lines.map(l=>({ id:l.id, name:l.name, streetName:streetNameForLine(l), color:l.color }));
  openThreeTest($('threeTestCanvasWrap'), {
    systems,
    onClose: ()=>{ $('threeTestOverlay').style.display='none'; closeThreeTest(); },
    onAssets: openThreeTestAssets
  });
};

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

/* ---------- about modal ---------- */
$('menuAbout').onclick = ()=>{
  $('menuList').style.display='none';
  $('aboutOverlay').style.display='flex';
};
$('aboutCloseBtn').onclick = ()=>{ $('aboutOverlay').style.display='none'; };

/* ---------- manage mnemonics ---------- */
const MNEM_PIECES = ['pawn','knight','bishop','rook','queen','king'];
const MNEM_PIECE_ICON = {pawn:'fa-chess-pawn',knight:'fa-chess-knight',bishop:'fa-chess-bishop',rook:'fa-chess-rook',queen:'fa-chess-queen',king:'fa-chess-king'};
let MNEMONICS = {};
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

async function computeMnemonicCoverage(line){
  if(!GAMES && CURRENT_USER){ GAMES = await getGames(CURRENT_USER); }
  /* buildCastleGraph/walk/processExit all read the global PREFS map keyed by
     line.id to find each branch's saved reply; PREFS only ever holds the
     prefs of whichever line is currently open in the main tree, which is
     often NOT the line picked in this dropdown. Swap in the right line's
     prefs for the traversal, then restore so the open line's in-memory
     state isn't disturbed. */
  // PREFS already holds the open line's prefs; only swap in another line's
  // prefs when computing coverage for a line that isn't the one open in the
  // main tree (avoids a redundant getAllPrefs read for the common case).
  const isOpenLine = CURRENT_LINE && line.id === CURRENT_LINE.id;
  const savedPrefs = PREFS;
  let graph;
  try {
    if(!isOpenLine) PREFS = await getAllPrefs(line.id);
    graph = buildCastleGraph(line, GAMES);
  } finally {
    if(!isOpenLine) PREFS = savedPrefs;
  }
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

async function populateMnemonicsCoverageSelect(){
  const sel = $('mnemonicsCoverageSelect');
  const prevValue = sel.value;
  const lines = CURRENT_USER ? await getLines(CURRENT_USER) : [];
  sel.innerHTML = '<option value="">(none selected)</option>' +
    lines.map(l=>`<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('');
  if(lines.some(l=>l.id===prevValue)) sel.value = prevValue;
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
      let pieceHtml, squareIncomplete = false;
      if(imgMode){
        const p = MNEM_VIEW_MODE;
        pieceHtml = entry[p+'Img']
          ? `<img class="mnem-cell-img" src="${entry[p+'Img']}" alt="">`
          : `<div class="mnem-cell-empty"><i class="fa-solid ${MNEM_PIECE_ICON[p]}"></i></div>`;
      } else if(MNEM_COVERAGE){
        pieceHtml = MNEM_PIECES
          .filter(p=>entry[p] || MNEM_COVERAGE.has(`${sq}|${p}`))
          .map(p=>{
            const occurs = MNEM_COVERAGE.has(`${sq}|${p}`);
            if(occurs){
              const missingWord = !entry[p], missingImg = !entry[p+'Img'];
              if(missingWord) missingWords++;
              if(missingImg) missingImages++;
              if(missingWord || missingImg) squareIncomplete = true;
            }
            const cls = `mnem-word${occurs?' mnem-occurs':''}`;
            return entry[p]
              ? `<div class="${cls}"><i class="fa-solid ${MNEM_PIECE_ICON[p]}"></i>${escapeHtml(entry[p])}${entry[p+'Img']?'':'*'}</div>`
              : `<div class="mnem-icon-only${occurs?' mnem-occurs':''}"><i class="fa-solid ${MNEM_PIECE_ICON[p]}"></i>(none)</div>`;
          })
          .join('');
      } else {
        pieceHtml = MNEM_PIECES
          .filter(p=>entry[p])
          .map(p=>`<div class="mnem-word"><i class="fa-solid ${MNEM_PIECE_ICON[p]}"></i>${escapeHtml(entry[p])}${entry[p+'Img']?'':'*'}</div>`)
          .join('');
      }
      const div = document.createElement('div');
      div.className = `mnem-square ${isLight?'light':'dark'}${squareIncomplete?' mnem-incomplete':''}${imgMode?' mnem-img-mode':''}`;
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
  if(MNEM_COVERAGE && !imgMode){
    counts.innerHTML = `${MNEM_COVERAGE.size} used` +
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
      resolve(hasAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85));
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
    const inCoverage = !!MNEM_COVERAGE?.has(`${sq}|${p}`);
    mnemPieceIconEl(p).classList.toggle('mnem-icon-in-coverage', inCoverage);
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
  const id = e.target.value;
  if(!id){ MNEM_COVERAGE = null; renderMnemonicsGrid(); return; }
  const lines = await getLines(CURRENT_USER);
  const line = lines.find(l=>l.id===id);
  if(!line){ MNEM_COVERAGE = null; renderMnemonicsGrid(); return; }
  const spinner = showSpinner('Loading opening system…');
  try {
    MNEM_COVERAGE = await computeMnemonicCoverage(line);
  } finally {
    hideSpinner(spinner);
  }
  renderMnemonicsGrid();
};

/* ---------- mnemonics notes (autosave) ---------- */
const MNEM_NOTES_KEY = 'mnemonicsNotes';
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
const MNEM_DISAMBIG_KEY = 'moveDisambiguatorImg';
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
  $('quizSetup').style.display = 'block';
}

/* read the setup choices, filter the pool, and begin the trials. */
function quizStart(){
  const scope = $('quizScopeSelect').value;
  let n = parseInt($('quizNumQuestions').value, 10);
  if(!Number.isFinite(n) || n < 1){ $('quizSetupError').textContent = 'Enter a question count of 1 or more.'; return; }
  const pool = filterPoolByScope(QUIZ_FULL_POOL, scope);
  if(pool.length === 0){
    $('quizSetupError').textContent = scope === 'custom'
      ? 'No mnemonics on the selected squares. Pick different squares.'
      : 'No mnemonics on the selected squares.';
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
  const {counts} = replies(GAMES || [], seq);
  const manual = PREFS[prefKey(OQ.line.id, seq)]?.manualReplies || [];
  manual.forEach(m=>{ if(!(m in counts)) counts[m]=0; });
  return Object.keys(counts).filter(opp => !PREFS[prefKey(OQ.line.id, [...seq, opp])]?.hidden);
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

/* advance OQ.seq to the next node where it is our turn, then arm the board for
   input. If there's no stored response, the tree has ended → finish. */
function oqLoadStep(){
  const expected = PREFS[prefKey(OQ.line.id, OQ.seq)]?.reply;
  if(!expected){ oqFinish(); return; }
  OQ.expected = expected;
  OQ.busy = false;
  oqBoard.setPosition(fenForSeq(OQ.seq), true);
  oqSetStatus('Your move');
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
  const opps = oqVisibleOpps(ourSeq);
  if(opps.length === 0){
    oqBoard.setPosition(fenForSeq(ourSeq), true);
    setTimeout(oqFinish, 500);
    return;
  }
  let oppMove;
  if(OQ.replay && OQ.replayIdx < OQ.oppChoices.length && opps.includes(OQ.oppChoices[OQ.replayIdx])){
    oppMove = OQ.oppChoices[OQ.replayIdx];
  } else {
    oppMove = opps[Math.floor(Math.random()*opps.length)];
    OQ.oppChoices[OQ.replayIdx] = oppMove;   // (re)record for same-choices replay
  }
  OQ.replayIdx++;
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
  OQ.finished = true;
  if(oqBoard) oqBoard.disableMoveInput();
  oqClearHighlights();
  const total = OQ.hits + OQ.misses;
  const pct = total ? Math.round(OQ.hits / total * 100) : 0;
  $('oqScorePct').textContent = total ? `${pct}%` : 'No moves to test';
  $('oqScoreDetail').textContent = total ? `${OQ.hits} hit${OQ.hits===1?'':'s'}, ${OQ.misses} miss${OQ.misses===1?'':'es'}` : '';
  $('oqPlay').style.display = 'none';
  $('oqSummary').style.display = 'block';
}

/* (re)start a run from OQ.startSeq. replaySame=true reuses the recorded
   opponent choices; otherwise they're re-rolled as play proceeds. */
function oqRun(replaySame){
  OQ.seq = OQ.startSeq.slice();
  OQ.hits = 0; OQ.misses = 0;
  OQ.replay = !!replaySame;
  OQ.replayIdx = 0;
  if(!replaySame) OQ.oppChoices = [];
  OQ.finished = false; OQ.busy = false;
  oqUpdateScore();
  $('oqSummary').style.display = 'none';
  $('oqPlay').style.display = 'block';
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
  OQ = { line: CURRENT_LINE, color: CURRENT_LINE.color, startSeq: startSeq.slice(),
         oppChoices: [], hits:0, misses:0 };
  $('openingQuizOverlay').style.display = 'flex';
  oqRun(false);
}

$('oqCloseBtn').onclick = ()=>{
  if(oqBoard) oqBoard.disableMoveInput();
  if(OQ) OQ.finished = true;
  oqClearHighlights();
  $('openingQuizOverlay').style.display='none';
};
$('oqExitBtn').onclick = ()=>{ $('openingQuizOverlay').style.display='none'; };
$('oqAgainSameBtn').onclick = ()=> oqRun(true);
$('oqAgainNewBtn').onclick  = ()=> oqRun(false);

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
  const fr = f.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - fr.width - 8);
  const top  = r.bottom + fr.height + 6 <= window.innerHeight ? r.bottom + 6 : r.top - fr.height - 6;
  f.style.left = `${Math.round(Math.max(8,left))}px`;
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

/* the one evaltag span (if any) currently tracking a live engine search, so its
   styling/tooltip can be reset once another row takes over or the search ends.
   liveEvalBtn is that row's analyse button, highlighted to show which move's
   position is the one currently loaded on the board. */
let liveEvalSpan = null, liveEvalBtn = null;

const engineMultiPV   = () => parseInt($('engineLinesSelect').value, 10);
const engineMaxDepth  = () => parseInt($('engineMaxDepthSelect').value, 10);

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

/* short suffix telling the user whether multi-threading kicked in (it only does
   on cross-origin-isolated browsers, see js/engine.js) -- shown on the live
   engine status line so it's visible at a glance during analysis. */
const engineModeTag = () => !engine.ready ? ''
  : engine.multithreaded ? ` · ${engine.threads} threads` : ' · 1 thread';

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
}
$('engineStopBtn').onclick = () => {
  if(engineState === 'running'){
    // flip to 'stopped' *before* telling the engine, so any trailing info line
    // the engine emits as it winds down renders with the "Stopped" prefix.
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
    $('engineDepth').textContent = Chessboard ? `Engine ready${engineModeTag()}` : 'Engine not available';
  }
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

function refreshEvalSpan(evalSpan, evalObj){
  if(!evalObj){ evalSpan.style.display='none'; return; }
  evalSpan.textContent = formatEvalTag(evalObj);
  evalSpan.className = `evaltag ${evalClass(evalObj, CURRENT_LINE.color)}`;
  evalSpan.dataset.depth = evalObj.depth;
  evalSpan.dataset.pv = evalObj.pv || '';
  const pvSuffix = evalObj.pv ? `\nBest line: ${evalObj.pv}` : '';
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
  const noteBtn = rowMenu.querySelector('[data-act="note"]');
  if(noteBtn) noteBtn.lastChild.textContent = saved?.note ? 'Edit Note' : 'Add Note';
}

/* only overwrite a saved eval if the engine has now searched deeper than before */
const EVAL_TAG_PV_PLIES = 16;
function recordEvalIfDeeper(saveField, currentSaved, evalSpan, depth, rawScore, fen, pv){
  const existing = currentSaved()?.eval;
  if(existing && existing.depth >= depth) return;
  const pvSan = pv?.length ? pvToSan(fen, pv, EVAL_TAG_PV_PLIES) : '';
  const evalObj = {...evalToWhiteRelative(rawScore,fen), depth, pv: pvSan, pvFen: fen, pvUci: pv?.length ? pv.slice(0, EVAL_TAG_PV_PLIES) : undefined};
  saveField('eval', evalObj);
  refreshEvalSpan(evalSpan, evalObj);
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
  return savePrefField(seq,'manualReplies',[...existing,move]);
}

function removeManualReply(seq,move){
  const existing = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
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
let analyzeChildrenResolve = null;
function openAnalyzeChildrenModal(defaultDepth){
  return new Promise(resolve => {
    const select = $('analyzeChildrenDepthInput');
    const opts = [...select.options].map(o=>o.value);
    select.value = opts.includes(String(defaultDepth)) ? String(defaultDepth) : opts[opts.length-1];
    $('analyzeChildrenOverlay').style.display='flex';
    analyzeChildrenResolve = resolve;
  });
}
$('analyzeChildrenCancelBtn').onclick = () => {
  $('analyzeChildrenOverlay').style.display='none';
  analyzeChildrenResolve?.(null);
  analyzeChildrenResolve = null;
};
$('analyzeChildrenGoBtn').onclick = () => {
  const depth = parseInt($('analyzeChildrenDepthInput').value, 10);
  $('analyzeChildrenOverlay').style.display='none';
  analyzeChildrenResolve?.(depth);
  analyzeChildrenResolve = null;
};

let activeChildAnalysisIcon = null;
async function analyzeChildNodes(parentSeq, branchDiv, icon){
  const fen = fenForSeq(parentSeq);
  const rows = [...branchDiv.querySelectorAll(':scope > table > tbody > tr.data-row')];
  const entries = rows
    .map(tr => ({ opp: tr.dataset.opp, evalSpan: tr.querySelector('.evaltag') }))
    .filter(e => e.opp && e.evalSpan)
    .map(e => ({ ...e, uci: sanToUci(fen, e.opp) }))
    .filter(e => e.uci);
  if(!entries.length) return;

  const targetDepth = await openAnalyzeChildrenModal(engineMaxDepth());
  if(!targetDepth) return;
  const pending = entries.filter(({opp}) => {
    const existing = PREFS[prefKey(CURRENT_LINE.id, [...parentSeq,opp])]?.eval;
    return !existing || existing.depth < targetDepth;
  });
  if(!pending.length) return; // every child already analyzed to at least this depth

  pending.forEach(({evalSpan}) => {
    evalSpan.textContent = '…';
    evalSpan.className = 'evaltag eval-neutral';
    evalSpan.style.display = '';
  });

  if(activeChildAnalysisIcon && activeChildAnalysisIcon !== icon){
    activeChildAnalysisIcon.style.display = 'none';
  }
  activeChildAnalysisIcon = icon;
  icon.style.display = '';
  icon.onclick = e => { e.stopPropagation(); engine.stop(); };
  const depthSpan = icon.querySelector('.analyzingDepth');
  depthSpan.textContent = '';

  try {
    await engine.analyze(fen, {
      multipv: entries.length,
      depth: targetDepth,
      searchmoves: entries.map(e => e.uci),
      onInfo: (d, lines) => {
        // the slowest-deepening rank is the bottleneck for finishing the whole
        // batch, so surface its depth (not the deepest, and not just `d`,
        // which is only whichever rank most recently reported in)
        const minDepth = Math.min(...Object.values(lines).map(l => l.depth));
        depthSpan.textContent = ` ${minDepth}/${targetDepth}`;
        for(const line of Object.values(lines)){
          const uci = line.pv[0];
          if(!uci) continue;
          const entry = entries.find(e => e.uci === uci);
          if(!entry) continue;
          const childSeq = [...parentSeq, entry.opp];
          const existing = PREFS[prefKey(CURRENT_LINE.id, childSeq)]?.eval;
          if(existing && existing.depth >= line.depth) continue;
          const pvSan = line.pv?.length ? pvToSan(fen, line.pv, EVAL_TAG_PV_PLIES) : '';
          const evalObj = {...evalToWhiteRelative(line.score, fen), depth: line.depth, pv: pvSan};
          savePrefField(childSeq, 'eval', evalObj);
          refreshEvalSpan(entry.evalSpan, evalObj);
        }
      }
    });
  } finally {
    if(activeChildAnalysisIcon === icon) activeChildAnalysisIcon = null;
    icon.style.display = 'none';
    icon.onclick = null;
    depthSpan.textContent = '';
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
    const li = document.createElement('li');
    li.innerHTML =
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
  console.debug(`[runEngine] runId=${runId} starting analyze multipv=${multipv} depth=${depth}`);
  const t0 = performance.now();
  engine.analyze(fen, {
    multipv,
    depth,
    onInfo: (d,lines) => {
      if(runId !== engineRunId){ console.debug(`[runEngine] runId=${runId} stale onInfo (current=${engineRunId}) ignored at depth=${d}`); return; }
      // the user hit STOP; ignore any final lines the engine emits as it halts
      // so they can't overwrite the frozen "Stopped" snapshot/label.
      if(engineState === 'stopped') return;
      renderEngineLines(fen,d,lines,multipv);
      if(onEvalUpdate && lines[1]?.score) onEvalUpdate(lines[1].depth, lines[1].score, lines[1].pv);
    }
  }).then(result => {
    console.debug(`[runEngine] runId=${runId} analyze resolved after ${(performance.now()-t0).toFixed(0)}ms`, result);
    // only the current run owns the status UI -- a stale run resolving (because
    // a newer search superseded it) must not touch the button the new run owns.
    // A user-initiated stop leaves the PLAY button up; a natural finish hides it.
    if(runId === engineRunId){
      if(engineState !== 'stopped') setEngineUI('idle');
      onComplete?.();
    }
  }).catch(err => console.error(`[runEngine] runId=${runId} analyze failed`, err));
}

function showPosition(fen, onEvalUpdate, onComplete){
  if(!Chessboard) return;   // no board widget -> live board analysis is unavailable
  console.debug(`[showPosition] fen=${fen}`);
  board?.setPosition(fen);
  runEngine(fen, onEvalUpdate, onComplete);
}

showPosition(new Chess().fen());
