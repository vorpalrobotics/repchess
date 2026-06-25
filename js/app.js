import { Chessboard, COLOR } from 'https://cdn.jsdelivr.net/npm/cm-chessboard@8/src/Chessboard.js';
import { Engine } from './engine.js';
import cytoscape from 'https://esm.sh/cytoscape@3.28.1';
import cytoscapeDagre from 'https://esm.sh/cytoscape-dagre@2.5.0?deps=cytoscape@3.28.1';
import { openThreeTest, closeThreeTest, refreshAssetsLive, setForeignModalOpen } from './threeTest.js';
import { openAssetManager, closeAssetManager } from './assets.js';
cytoscape.use(cytoscapeDagre);

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
  const chess = new Chess();
  let info = null;
  for(const mv of seq) info = chess.move(mv,{sloppy:true});
  return info;
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
    $('graphStatus').textContent =
      `${rooms.length} room(s), ${edges.length} move(s), ${leaves.length} not yet built, ${mergeCount} transposition merge point(s)`;

    const elements = [
      ...(needsStartNode ? [{data:{id:'start', label:''}, classes:'start'}] : []),
      ...rooms.map(r=>({
        data:{id:r.id, label:r.label, fen:r.fen, seq:r.seq},
        classes: entryRoomIds.includes(r.id) ? 'root' : (indegree.get(r.id)>1 ? 'transposition' : '')
      })),
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
          'text-halign':'center'
        }},
        { selector:'node.start', style:{
          'shape':'ellipse', 'width':10, 'height':10, 'padding':0, 'background-color':'#555'
        }},
        { selector:'node.root', style:{ 'background-color':'#2e7d32' } },
        { selector:'node.transposition', style:{ 'background-color':'#e65100' } },
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
      hoverPreviewBoard.setPosition(fen);
      hoverPreviewBoard.setOrientation(CURRENT_LINE?.color==='black' ? COLOR.black : COLOR.white);
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
    if(el.hasClass('start') || el.hasClass('locked')) return;
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
  btn.style.visibility='visible';
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
   Sketch of the room/castle decoration attributes from CastleDataModel.md:
   the opponent's reply (lineSeq, top half) gets feature-vs-exit
   classification/exit-type/blunder flag, the room we end up in after our
   own reply (bottom half) gets a name and optional castle-root naming.
   Everything is stored as plain pref fields for now (no real asset
   catalog exists yet) — the "..." asset-browse buttons are placeholders. */
let attributesModalSave = null;
function openAttributesModal(oppMove, saved, onSave){
  $('attrOppMoveLabel').textContent = oppMove ? `(${oppMove})` : '';
  $('attrRoomMoveLabel').textContent = saved?.reply ? `(after ...${saved.reply})` : '(no standard response set yet)';
  $('attrClassification').value = saved?.classification || 'auto';
  $('attrExitType').value = saved?.exitType || 'door';
  $('attrBlunder').checked = !!saved?.blunderTrap;
  $('attrRoomName').value = saved?.name || '';
  $('attrIsCastleRoot').checked = !!saved?.isCastleRoot;
  $('attrCastleName').value = saved?.castleName || '';
  refreshAttrFieldVisibility();
  attributesModalSave = onSave;
  $('attributesOverlay').style.display='flex';
}
function refreshAttrFieldVisibility(){
  $('attrExitTypeField').style.display = $('attrClassification').value==='exit' ? '' : 'none';
  $('attrCastleNameField').style.display = $('attrIsCastleRoot').checked ? '' : 'none';
}
$('attrClassification').addEventListener('change', refreshAttrFieldVisibility);
$('attrIsCastleRoot').addEventListener('change', refreshAttrFieldVisibility);
document.querySelectorAll('#attributesOverlay .asset-browse-btn[data-asset-target]').forEach(btn=>{
  btn.onclick = () => log('asset catalog coming soon');
});
$('attrAddFeatureBtn').onclick = () => log('asset catalog coming soon');
$('attributesCancelBtn').onclick = () => {
  $('attributesOverlay').style.display='none';
  attributesModalSave = null;
};
$('attributesSaveBtn').onclick = () => {
  const v = {
    classification: $('attrClassification').value,
    exitType: $('attrExitType').value,
    blunderTrap: $('attrBlunder').checked,
    roomName: $('attrRoomName').value.trim(),
    isCastleRoot: $('attrIsCastleRoot').checked,
    castleName: $('attrCastleName').value.trim()
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
       <button class="iconbtn toggle" style="visibility:hidden"><i class="fa-solid fa-caret-right"></i></button>
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
             <button type="button" data-act="response"><i class="fa-solid fa-check"></i>Set Standard Response</button>
             <button type="button" data-act="focus"><i class="fa-solid fa-crosshairs"></i>Focus on this Line</button>
             <button type="button" data-act="hide"><i class="fa-solid fa-eye-slash"></i>Hide This Branch</button>
             <button type="button" data-act="analyzeChildren"><i class="fa-solid fa-chess-board"></i>Analyze all children</button>
             <button type="button" data-act="nodeStats"><i class="fa-solid fa-diagram-project"></i>Node Statistics</button>
             <button type="button" data-act="generateCastle"><i class="fa-solid fa-dungeon"></i>Generate Castle</button>
             <button type="button" data-act="addMove"><i class="fa-solid fa-plus"></i>Add Opponent Move</button>
             <hr class="row-menu-sep">
             <button type="button" data-act="note"><i class="fa-solid fa-pen"></i>Add Note</button>
             <button type="button" data-act="mnemonic"><i class="fa-solid fa-brain"></i>Add Mnemonic</button>
             <button type="button" data-act="attributes"><i class="fa-solid fa-sliders"></i>Set Attributes</button>
             <button type="button" data-act="removeManual" style="display:none"><i class="fa-solid fa-trash"></i>Remove This Move</button>
           </div>
         </div>
       </td>
       <td class="move" style="padding-left:${indentLevel}em">
         <button class="iconbtn toggle" style="visibility:hidden"><i class="fa-solid fa-caret-right"></i></button>
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
    const metaTd = document.createElement('td');
    metaTd.colSpan = 5;
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

    function refreshMeta(){
      const saved = currentSaved();
      const mnem = saved?.mnemonic || '';
      const note = saved?.note || '';
      if(!mnem && !note){ metaTr.style.display='none'; return; }
      metaTd.innerHTML =
        (mnem ? `<span class="meta-mnem" title="Edit mnemonic"><i class="fa-solid fa-brain"></i>${escapeHtml(mnem)}</span>` : '') +
        (note ? `<span class="meta-note" title="Edit note"><i class="fa-solid fa-pen"></i>${escapeHtml(note)}</span>`       : '');
      metaTr.style.display='';

      const mnemEl = metaTd.querySelector('.meta-mnem');
      if(mnemEl) mnemEl.onclick = () => openFieldModal('mnemonic', currentSaved()?.mnemonic, v=>saveField('mnemonic',v));
      const noteEl = metaTd.querySelector('.meta-note');
      if(noteEl) noteEl.onclick = () => openFieldModal('note', currentSaved()?.note, v=>saveField('note',v));
    }
    refreshMeta();
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
    refreshBranchName(nameSpan, currentSaved()?.name);
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
    rowMenu.querySelector('[data-act="mnemonic"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      openFieldModal('mnemonic', currentSaved()?.mnemonic, v=>saveField('mnemonic',v));
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
      openAttributesModal(opp, currentSaved(), v=>{
        saveField('classification', v.classification);
        saveField('exitType', v.exitType);
        saveField('blunderTrap', v.blunderTrap);
        saveField('isCastleRoot', v.isCastleRoot);
        saveField('castleName', v.castleName);
        saveField('name', v.roomName);
        refreshBranchName(nameSpan, v.roomName);
      });
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
       <button class="iconbtn toggle" style="visibility:hidden"><i class="fa-solid fa-caret-right"></i></button>
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
           <button type="button" data-act="response"><i class="fa-solid fa-check"></i>Set Standard Response</button>
           <button type="button" data-act="focus"><i class="fa-solid fa-crosshairs"></i>Focus on this Line</button>
           <button type="button" data-act="hide"><i class="fa-solid fa-eye-slash"></i>Hide This Branch</button>
           <button type="button" data-act="analyzeChildren"><i class="fa-solid fa-chess-board"></i>Analyze all children</button>
           <button type="button" data-act="nodeStats"><i class="fa-solid fa-diagram-project"></i>Node Statistics</button>
           <button type="button" data-act="generateCastle"><i class="fa-solid fa-dungeon"></i>Generate Castle</button>
           <button type="button" data-act="addMove"><i class="fa-solid fa-plus"></i>Add Opponent Move</button>
           <hr class="row-menu-sep">
           <button type="button" data-act="note"><i class="fa-solid fa-pen"></i>Add Note</button>
           <button type="button" data-act="mnemonic"><i class="fa-solid fa-brain"></i>Add Mnemonic</button>
           <button type="button" data-act="attributes"><i class="fa-solid fa-sliders"></i>Set Attributes</button>
         </div>
       </div>
     </td>
     <td class="move">
       <button class="iconbtn toggle" style="visibility:hidden"><i class="fa-solid fa-caret-right"></i></button>
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
  const metaTd = document.createElement('td');
  metaTd.colSpan = 5;
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

  function refreshMeta(){
    const saved = currentSaved();
    const mnem = saved?.mnemonic || '';
    const note = saved?.note || '';
    if(!mnem && !note){ metaTr.style.display='none'; return; }
    metaTd.innerHTML =
      (mnem ? `<span class="meta-mnem" title="Edit mnemonic"><i class="fa-solid fa-brain"></i>${escapeHtml(mnem)}</span>` : '') +
      (note ? `<span class="meta-note" title="Edit note"><i class="fa-solid fa-pen"></i>${escapeHtml(note)}</span>`       : '');
    metaTr.style.display='';

    const mnemEl = metaTd.querySelector('.meta-mnem');
    if(mnemEl) mnemEl.onclick = () => openFieldModal('mnemonic', currentSaved()?.mnemonic, v=>saveField('mnemonic',v));
    const noteEl = metaTd.querySelector('.meta-note');
    if(noteEl) noteEl.onclick = () => openFieldModal('note', currentSaved()?.note, v=>saveField('note',v));
  }
  refreshMeta();
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
  refreshBranchName(nameSpan, currentSaved()?.name);
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
  rowMenu.querySelector('[data-act="mnemonic"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    openFieldModal('mnemonic', currentSaved()?.mnemonic, v=>saveField('mnemonic',v));
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
    openAttributesModal(trigger, currentSaved(), v=>{
      saveField('classification', v.classification);
      saveField('exitType', v.exitType);
      saveField('blunderTrap', v.blunderTrap);
      saveField('isCastleRoot', v.isCastleRoot);
      saveField('castleName', v.castleName);
      saveField('name', v.roomName);
      refreshBranchName(nameSpan, v.roomName);
    });
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
async function openLine(line){
  CURRENT_LINE = line;
  $('homeScreen').style.display='none';
  $('lineScreen').style.display='';
  $('lineTitle').textContent = `${line.name} (${line.color})`;

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

    board.setOrientation(line.color==='black' ? COLOR.black : COLOR.white);

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
$('menuBtn').onclick = e=>{
  e.stopPropagation();
  $('menuList').style.display = $('menuList').style.display==='flex' ? 'none' : 'flex';
};
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
      name: line.name, color: line.color, openingMoves: line.openingMoves,
      prefs: Object.values(await getAllPrefs(line.id)).map(p=>({
        seq:p.seq, reply:p.reply, note:p.note, mnemonic:p.mnemonic,
        hidden:p.hidden, manualReplies:p.manualReplies, eval:p.eval, name:p.name,
        collapsed:p.collapsed
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
    for(const pref of (lineData.prefs||[])){
      await setPref(line.id, pref.seq, {
        reply:pref.reply||'', note:pref.note||'', mnemonic:pref.mnemonic||'',
        hidden:pref.hidden||false, manualReplies:pref.manualReplies||[],
        eval:pref.eval||null, name:pref.name||'', collapsed:pref.collapsed||false
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
  for(const asset of (data.assets||[])) await setAsset(asset.id, asset);
  log(`restored ${data.lines.length} opening system(s), ${(data.games||[]).length} game(s)`);
  await renderHome();
}

$('menuExport').onclick = ()=>{
  $('menuList').style.display='none';
  exportBackup();
};
$('menuImport').onclick = ()=>{
  $('menuList').style.display='none';
  $('backupImport').click();
};
$('backupImport').addEventListener('change', async e=>{
  const f = e.target.files[0];
  e.target.value = '';
  if(!f) return;
  if(!confirm(
    'RESTORE FULL BACKUP?\n\n' +
    'This will permanently DELETE everything currently stored in this browser — ' +
    'all opening systems, notes, mnemonics (including images), and downloaded games — ' +
    'and replace it with the contents of this backup file.\n\n' +
    'Any changes made since this backup was taken WILL BE LOST. This cannot be undone.\n\n' +
    'Continue?'
  )) return;
  try{
    const data = JSON.parse(await f.text());
    await importBackup(data);
  }catch(err){
    console.error('[import] failed',err);
    log('import failed: '+err.message,true);
  }
});

/* ---------- three.js prototype ---------- */
$('menuThreeTest').onclick = ()=>{
  $('menuList').style.display='none';
  $('threeTestOverlay').style.display='flex';
  openThreeTest($('threeTestCanvasWrap'));
};
$('threeTestCloseBtn').onclick = ()=>{
  $('threeTestOverlay').style.display='none';
  closeThreeTest();
};

// Opening the asset manager from inside the walking tour: the assets modal
// stacks on top (it sits later in the DOM and has a higher z-index) without
// closing threeTest, so dismissing it just drops back into the tour.
let assetsOpenedFromThreeTest = false;
$('threeTestAssetsBtn').onclick = ()=>{
  assetsOpenedFromThreeTest = true;
  setForeignModalOpen(true);
  $('assetsOverlay').style.display='flex';
  openAssetManager($('assetsBodyWrap'));
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

function squareName(col,row){ return 'abcdefgh'[col] + (8-row); }

async function renderMnemonicsGrid(){
  MNEMONICS = await getAllMnemonics();
  const grid = $('mnemonicsGrid');
  grid.innerHTML='';
  for(let row=0;row<8;row++){
    for(let col=0;col<8;col++){
      const sq = squareName(col,row);
      const isLight = (col+row)%2===0;
      const entry = MNEMONICS[sq] || {};
      const words = MNEM_PIECES
        .filter(p=>entry[p])
        .map(p=>`<div class="mnem-word"><i class="fa-solid ${MNEM_PIECE_ICON[p]}"></i>${escapeHtml(entry[p])}${entry[p+'Img']?'':'*'}</div>`)
        .join('');
      const div = document.createElement('div');
      div.className = `mnem-square ${isLight?'light':'dark'}`;
      div.dataset.square = sq;
      div.innerHTML =
        (row===7 ? `<span class="mnem-coord-file">${sq[0]}</span>` : '') +
        (col===0 ? `<span class="mnem-coord-rank">${sq[1]}</span>` : '') +
        words;
      div.onclick = ()=> openMnemonicsEditor(sq);
      grid.appendChild(div);
    }
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
const MNEM_IMG_MAX_DIM = 250;       // stored image is downscaled to fit within this box
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

/* downscale to fit within MNEM_IMG_MAX_DIM x MNEM_IMG_MAX_DIM (no cropping) and re-encode as JPEG to keep stored size small */
function resizeImageFile(file){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MNEM_IMG_MAX_DIM / img.width, MNEM_IMG_MAX_DIM / img.height);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not decode image')); };
    img.src = url;
  });
}

async function handleMnemImageFile(p, file){
  if(!file) return;
  if(!file.type.startsWith('image/')){ log('that file is not an image',true); return; }
  if(file.size > MNEM_IMG_MAX_FILE_BYTES){ log(`image too large (max ${MNEM_IMG_MAX_FILE_BYTES/1024/1024}MB)`,true); return; }
  try{
    MNEM_EDIT_IMAGES[p] = await resizeImageFile(file);
    renderMnemImgDrop(p);
  }catch(err){
    console.error('[mnemonics] image resize failed',err);
    log('could not read that image',true);
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
    renderMnemImgDrop(p);
  });
}

function openMnemonicsEditor(sq){
  MNEM_EDIT_SQUARE = sq;
  const entry = MNEMONICS[sq] || {};
  $('mnemonicsEditorTitle').textContent = `Edit Square ${sq}`;
  for(const p of MNEM_PIECES){
    mnemWordInput(p).value = entry[p] || '';
    mnemDescInput(p).value = entry[p+'Desc'] || '';
    MNEM_EDIT_IMAGES[p] = entry[p+'Img'] || '';
    renderMnemImgDrop(p);
  }
  $('mnemonicsEditorOverlay').style.display='flex';
}

$('menuMnemonics').onclick = async ()=>{
  $('menuList').style.display='none';
  renderMnemonicsGrid();
  $('mnemonicsNotes').value = await getMeta(MNEM_NOTES_KEY);
  $('mnemonicsOverlay').style.display='flex';
};
$('mnemonicsCloseBtn').onclick = ()=>{ $('mnemonicsOverlay').style.display='none'; };

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
const QUIZ_TRIALS = 10;
const MNEM_PIECE_LETTER = {pawn:'',knight:'n',bishop:'b',rook:'r',queen:'q',king:'k'};
let QUIZ = null; // {pool, results, idx, mode, item, expected, startTime, timerInterval}

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
  $('quizTrialNum').textContent = `Trial ${QUIZ.idx+1} of ${QUIZ_TRIALS}`;

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
  if(QUIZ.idx >= QUIZ_TRIALS) quizFinish();
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
  $('quizScorePct').textContent = `${correct}/${QUIZ_TRIALS} correct (${Math.round(correct/QUIZ_TRIALS*100)}%)`;
  $('quizScoreTime').textContent = `Time: ${quizFormatClock(elapsed)}`;
}

async function quizStart(){
  $('quizSummary').style.display = 'none';
  const pool = buildMnemonicsPool(await getAllMnemonics());
  if(pool.length === 0){
    $('quizEmpty').style.display = 'block';
    $('quizPlay').style.display = 'none';
    return;
  }
  $('quizEmpty').style.display = 'none';
  $('quizPlay').style.display = 'block';
  QUIZ = {pool, results:[], idx:0, startTime: Date.now(), finished:false};
  QUIZ.timerInterval = setInterval(quizTickClock, 200);
  quizTickClock();
  quizLoadTrial();
}

$('menuQuiz').onclick = ()=>{
  $('menuList').style.display='none';
  $('quizOverlay').style.display='flex';
  quizStart();
};
$('quizCloseBtn').onclick = ()=>{
  if(QUIZ) clearInterval(QUIZ.timerInterval);
  $('quizOverlay').style.display='none';
};
$('quizDoneBtn').onclick = ()=>{ $('quizOverlay').style.display='none'; };
$('quizAgainBtn').onclick = ()=>{ quizStart(); };
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

/* ---------- analysis board ---------- */
const board = new Chessboard($('board'), {
  position: new Chess().fen(),
  orientation: COLOR.white,
  style: {
    pieces: {
      file: 'https://cdn.jsdelivr.net/npm/cm-chessboard@8/assets/pieces/standard.svg'
    }
  }
});

/* ---------- hover preview mini-board ---------- */
const hoverPreviewBoard = new Chessboard($('hoverPreviewBoard'), {
  position: new Chess().fen(),
  orientation: COLOR.white,
  style: {
    pieces: {
      file: 'https://cdn.jsdelivr.net/npm/cm-chessboard@8/assets/pieces/standard.svg'
    }
  }
});
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
      hoverPreviewBoard.setPosition(fen);
      hoverPreviewBoard.setOrientation(CURRENT_LINE?.color==='black' ? COLOR.black : COLOR.white);
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

/* ---------- engine ---------- */
const ENGINE_PV_PLIES = 8;
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

/* the STOP button only appears while a live search is actually running (it can
   peg several cores), so the user can halt it without resorting to dropping the
   depth. Stopping just lets the current search finish early -- whatever lines
   were found so far stay on screen. */
const showEngineStop = on => { $('engineStopBtn').style.display = on ? 'inline-flex' : 'none'; };
$('engineStopBtn').onclick = () => {
  engine.stop();
  showEngineStop(false);
  $('engineDepth').textContent = $('engineDepth').textContent.replace(/^Live — /, 'Stopped — ');
};

engine.init().then(() => {
  // surface the engine mode as soon as it's ready, if nothing is analysing yet
  if(!$('engineDepth').textContent){
    $('engineDepth').textContent = `Engine ready${engineModeTag()}`;
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

function refreshBranchName(nameSpan, name){
  if(!name){ nameSpan.style.display='none'; return; }
  nameSpan.textContent = name;
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
  const mnemonicBtn = rowMenu.querySelector('[data-act="mnemonic"]');
  if(mnemonicBtn) mnemonicBtn.lastChild.textContent = saved?.mnemonic ? 'Edit Mnemonic' : 'Add Mnemonic';
}

/* only overwrite a saved eval if the engine has now searched deeper than before */
const EVAL_TAG_PV_PLIES = 16;
function recordEvalIfDeeper(saveField, currentSaved, evalSpan, depth, rawScore, fen, pv){
  const existing = currentSaved()?.eval;
  if(existing && existing.depth >= depth) return;
  const pvSan = pv?.length ? pvToSan(fen, pv, EVAL_TAG_PV_PLIES) : '';
  const evalObj = {...evalToWhiteRelative(rawScore,fen), depth, pv: pvSan};
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

function renderEngineLines(fen, depth, lines, multipv){
  $('engineDepth').textContent = `Live — Depth ${depth}${engineModeTag()}`;
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
      `<span class="pvText">${escapeHtml(formatScore(line.score,turn))}  ${escapeHtml(pvToSan(fen,line.pv,showFull ? Infinity : ENGINE_PV_PLIES))}` +
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
  const runId = ++engineRunId;
  console.debug(`[runEngine] runId=${runId} fen=${fen}`);
  if(fen === STARTING_FEN){
    console.debug(`[runEngine] runId=${runId} starting position, skipping analysis to save cycles`);
    engine.stop();
    showEngineStop(false);
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
  showEngineStop(true);
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
      renderEngineLines(fen,d,lines,multipv);
      if(onEvalUpdate && lines[1]?.score) onEvalUpdate(lines[1].depth, lines[1].score, lines[1].pv);
    }
  }).then(result => {
    console.debug(`[runEngine] runId=${runId} analyze resolved after ${(performance.now()-t0).toFixed(0)}ms`, result);
    // only the current run owns the status UI -- a stale run resolving (because
    // a newer search superseded it) must not hide the button the new run lit.
    if(runId === engineRunId){ showEngineStop(false); onComplete?.(); }
  }).catch(err => console.error(`[runEngine] runId=${runId} analyze failed`, err));
}

function showPosition(fen, onEvalUpdate, onComplete){
  console.debug(`[showPosition] fen=${fen}`);
  board.setPosition(fen);
  runEngine(fen, onEvalUpdate, onComplete);
}

showPosition(new Chess().fen());
