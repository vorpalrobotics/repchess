import { Chessboard, COLOR } from 'https://cdn.jsdelivr.net/npm/cm-chessboard@8/src/Chessboard.js';
import { Engine } from './engine.js';

/* ---------- version (injected at deploy time, see workflow) ---------- */
document.title = `REPchess (${typeof APP_VERSION!=='undefined' ? APP_VERSION : 'dev'})`;

/* ---------- helpers ---------- */
const $   = id => document.getElementById(id);
const log = (m,e=false)=>{ $('progress').textContent=m; $('progress').classList.toggle('error',e); };
const clr = ()=>{ $('progress').textContent='';$('progress').classList.remove('error'); };

/* ---------- persistent prefs (small, stays in localStorage) ---------- */
const LS_ID='lichess_lastUser', LS_MAX='lichess_lastMax';
$('userId').value  = localStorage.getItem(LS_ID)  || '';
$('maxGames').value= localStorage.getItem(LS_MAX)||300;

/* ---------- globals ---------- */
let GAMES=null, CURRENT_USER='', PREFS={};

/* ---------- fetch games from Lichess ---------- */
async function fetchLatest(user,max,onProgress){
  const url=`https://lichess.org/api/games/user/${encodeURIComponent(user)}?max=${max}&moves=true&tags=false&opening=false`;
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

/* ---------- compute reply frequencies ---------- */
function replies(games,seq){
  const counts={}, n=seq.length; let tot=0;
  for(const g of games){
    const mv=g.moves.split(' ');
    if(mv.length<=n || !seq.every((m,i)=>mv[i].toLowerCase()===m.toLowerCase())) continue;
    const r=mv[n] || '(no reply)';
    counts[r]=(counts[r]||0)+1;
    tot++;
  }
  return {counts,tot};
}

/* ---------- FEN for a move sequence ---------- */
function fenForSeq(seq){
  const chess = new Chess();
  for(let i=0;i<seq.length;i++){
    const mv = seq[i];
    if(!chess.move(mv,{sloppy:true})){
      console.warn(`[fenForSeq] move ${i+1}/${seq.length} "${mv}" failed to apply; ` +
        `returning position after move ${i} instead. seq=${JSON.stringify(seq)} ` +
        `fen-before-failure=${chess.fen()}`);
      break;
    }
  }
  return chess.fen();
}

/* ---------- toggle helper ---------- */
function makeToggle(btn, branchRow){
  btn.style.visibility='visible';
  btn.textContent='⊖';                          // newly (re-)expanded, so shown
  btn.onclick=()=>{                              // rewired each call to target the current branchRow
    const shown = branchRow.style.display !== 'none';
    branchRow.style.display = shown ? 'none' : '';
    btn.textContent         = shown ? '⊕'   : '⊖';
  };
}

/* ---------- escape free text before inserting into innerHTML ---------- */
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------- per-row "more" menu ---------- */
function closeAllRowMenus(){
  document.querySelectorAll('.row-menu.show').forEach(m=>m.classList.remove('show'));
}
document.addEventListener('click', closeAllRowMenus);

/* ---------- add note / mnemonic modal ---------- */
let fieldModalSave = null;
function openFieldModal(field, currentValue, onSave){
  $('fieldModalTitle').textContent =
    field==='note' ? 'Add Note' : field==='mnemonic' ? 'Add Mnemonic' : 'Set Standard Response';
  $('fieldModalInput').value = currentValue || '';
  fieldModalSave = onSave;
  $('fieldOverlay').style.display='flex';
  $('fieldModalInput').focus();
}
$('fieldModalCancelBtn').onclick = () => { $('fieldOverlay').style.display='none'; fieldModalSave=null; };
$('fieldModalSaveBtn').onclick = () => {
  const v = $('fieldModalInput').value.trim();
  $('fieldOverlay').style.display='none';
  if(fieldModalSave) fieldModalSave(v);
  fieldModalSave = null;
};

/* ---------- recursive branch renderer ---------- */
function renderBranch(parent,games,seq,depth){
  const {counts,tot}=replies(games,seq);
  if(!tot){
    parent.insertAdjacentHTML('beforeend',
      `<p class="indent" style="margin-left:${depth}em">(no further games)</p>`);
    return;
  }

  const tbl=document.createElement('table');
  tbl.style.marginLeft=`${depth}em`;
  parent.appendChild(tbl);

  if(depth===0){
    tbl.innerHTML=
      `<thead><tr><th>Move</th><th>Count</th><th>Response</th></tr></thead>`;
  }
  const tb=tbl.appendChild(document.createElement('tbody'));

  Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([opp,c])=>{
    const tr=document.createElement('tr');
    tr.innerHTML=
      `<td class="move">
         <button class="iconbtn toggle" style="visibility:hidden">⊖</button>
         ${depth+1}. ${seq.at(-1)} ${opp}
       </td>
       <td class="cnt">${c} (${((c/tot)*100).toFixed(1)}%)</td>
       <td class="resp">
         <button class="iconbtn" title="Analyse">📈</button>
         <div class="row-menu-wrap">
           <button class="iconbtn rowMenuBtn" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>
           <div class="row-menu">
             <button type="button" data-act="response"><i class="fa-solid fa-check"></i>Set Standard Response</button>
             <button type="button" data-act="note"><i class="fa-solid fa-pen"></i>Add Note</button>
             <button type="button" data-act="mnemonic"><i class="fa-solid fa-brain"></i>Add Mnemonic</button>
           </div>
         </div>
       </td>`;
    tb.appendChild(tr);

    const metaTr = document.createElement('tr');
    metaTr.className = 'meta-row';
    const metaTd = document.createElement('td');
    metaTd.colSpan = 3;
    metaTr.appendChild(metaTd);
    tr.after(metaTr);

    /* element handles */
    const toggleBtn  = tr.querySelector('.toggle');
    const btnEval    = tr.querySelector('td.resp > button.iconbtn');
    const rowMenuBtn = tr.querySelector('.rowMenuBtn');
    const rowMenu    = tr.querySelector('.row-menu');

    const lineSeq = [...seq,opp];
    const currentSaved = () => PREFS[prefKey(CURRENT_USER,lineSeq)];

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

    function saveField(field,value){
      setPref(CURRENT_USER,lineSeq,{[field]:value});
      const key = prefKey(CURRENT_USER,lineSeq);
      (PREFS[key] ??= {key,user:CURRENT_USER,seq:lineSeq,reply:'',note:'',mnemonic:''})[field]=value;
      refreshMeta();
    }

    /* expand the branch table under the chosen standard response */
    function expandWith(reply){
      const old = metaTr.nextSibling;
      if(old?.querySelector?.('.branch')) old.remove();

      const tr1=document.createElement('tr'); metaTr.after(tr1);
      const td1=document.createElement('td'); td1.colSpan=3; tr1.appendChild(td1);
      const div=document.createElement('div'); div.className='branch'; td1.appendChild(div);
      renderBranch(div,games,[...lineSeq,reply],depth+1);
      makeToggle(toggleBtn,tr1);
    }

    function setStandardResponse(reply){
      setPref(CURRENT_USER,lineSeq,{reply});
      (PREFS[prefKey(CURRENT_USER,lineSeq)] ??= {key:prefKey(CURRENT_USER,lineSeq),user:CURRENT_USER,seq:lineSeq,reply:'',note:'',mnemonic:''}).reply=reply;
      expandWith(reply);
    }

    /* restore reply from the preloaded PREFS map */
    const savedRep = currentSaved()?.reply;
    if(savedRep) expandWith(savedRep);

    /* "more" menu: set standard response / add note / add mnemonic */
    rowMenuBtn.onclick = e => {
      e.stopPropagation();
      const showing = rowMenu.classList.contains('show');
      closeAllRowMenus();
      if(!showing) rowMenu.classList.add('show');
    };
    rowMenu.querySelector('[data-act="response"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      openFieldModal('response', currentSaved()?.reply, v=>{ v=v.trim(); if(v) setStandardResponse(v); });
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

    btnEval.onclick = () => showPosition(fenForSeq(lineSeq));
  });
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
  searchRoot();               // re-run automatically
});

/* ---------- main search action ---------- */
async function searchRoot(){
  clr();
  $('tree').innerHTML='';

  const first=$('firstMove').value.trim();
  if(!first){ log('enter first move',true); return; }

  if(!CURRENT_USER){
    CURRENT_USER = $('userId').value.trim().toLowerCase();
  }

  if(!GAMES && CURRENT_USER){
    GAMES = await getGames(CURRENT_USER);
    if(!GAMES.length) GAMES=null;
  }

  /* prompt for NDJSON if nothing is loaded yet */
  if(!GAMES){
    $('fileImport').click();
    return;
  }

  if(CURRENT_USER){
    PREFS = await getAllPrefs(CURRENT_USER);
  }

  renderBranch($('tree'),GAMES,[first],0);
}

/* ---------- UI actions ---------- */
$('dlBtn').onclick = async ()=>{
  CURRENT_USER=$('userId').value.trim().toLowerCase();
  if(!CURRENT_USER){ log('enter id',true); return; }
  localStorage.setItem(LS_ID,CURRENT_USER);

  const max=+$('maxGames').value||300;
  localStorage.setItem(LS_MAX,max);

  try{
    log('fetching…');
    GAMES = await fetchLatest(CURRENT_USER,max,n=>log(`fetching… got ${n}`));
    log(`fetched ${GAMES.length}, writing to database…`);
    await putGames(CURRENT_USER,GAMES);
    log(`downloaded ${GAMES.length}`);
    $('downloadOverlay').style.display='none';
  }catch(e){ console.error('[dlBtn] download failed',e); log(e.message,true); }
};

$('rootBtn').onclick = searchRoot;

/* ---------- hamburger menu ---------- */
$('menuBtn').onclick = e=>{
  e.stopPropagation();
  $('menuList').style.display = $('menuList').style.display==='flex' ? 'none' : 'flex';
};
document.addEventListener('click', e=>{
  if(!$('menuList').contains(e.target) && e.target!==$('menuBtn')) $('menuList').style.display='none';
});

/* ---------- download modal ---------- */
$('menuDownload').onclick = ()=>{
  $('menuList').style.display='none';
  $('downloadOverlay').style.display='flex';
};
$('downloadCancelBtn').onclick = ()=>{ $('downloadOverlay').style.display='none'; };

/* ---------- about modal ---------- */
$('menuAbout').onclick = ()=>{
  $('menuList').style.display='none';
  $('aboutOverlay').style.display='flex';
};
$('aboutCloseBtn').onclick = ()=>{ $('aboutOverlay').style.display='none'; };

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

/* ---------- engine ---------- */
const ENGINE_PV_PLIES = 8;
const engine = new Engine();
let engineRunId = 0;
let currentEngineFen = null;

const engineMultiPV   = () => parseInt($('engineLinesSelect').value, 10);
const engineMaxDepth  = () => {
  const v = $('engineMaxDepthSelect').value;
  return v === 'infinity' ? Infinity : parseInt(v, 10);
};

$('engineLinesSelect').onchange = () => { if(currentEngineFen) runEngine(currentEngineFen); };
$('engineMaxDepthSelect').onchange = () => { if(currentEngineFen) runEngine(currentEngineFen); };

engine.init().catch(err => {
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
  $('engineDepth').textContent = `Depth ${depth}`;
  const turn = fen.split(' ')[1];
  const ol = $('engineLines');
  ol.innerHTML = '';
  for(let i=1;i<=multipv;i++){
    const line = lines[i];
    if(!line) continue;
    const li = document.createElement('li');
    li.textContent = `${formatScore(line.score,turn)}  ${pvToSan(fen,line.pv,ENGINE_PV_PLIES)}`;
    ol.appendChild(li);
  }
}

async function runEngine(fen){
  currentEngineFen = fen;
  const runId = ++engineRunId;
  console.debug(`[runEngine] runId=${runId} fen=${fen}`);
  if(!engine.ready) await engine.init().catch(()=>{});
  if(runId !== engineRunId){ console.debug(`[runEngine] runId=${runId} superseded before engine ready, dropping`); return; }
  if(!engine.ready){ console.warn(`[runEngine] runId=${runId} engine never became ready, aborting`); return; }
  $('engineDepth').textContent = 'Thinking…';
  $('engineLines').innerHTML = '';
  const multipv = engineMultiPV();
  const depth = engineMaxDepth();
  console.debug(`[runEngine] runId=${runId} starting analyze multipv=${multipv} depth=${depth}`);
  const t0 = performance.now();
  // runs until maxDepth is reached, or forever ("infinity") until superseded
  engine.analyze(fen, {
    multipv,
    depth,
    onInfo: (d,lines) => {
      if(runId !== engineRunId){ console.debug(`[runEngine] runId=${runId} stale onInfo (current=${engineRunId}) ignored at depth=${d}`); return; }
      renderEngineLines(fen,d,lines,multipv);
    }
  }).then(result => {
    console.debug(`[runEngine] runId=${runId} analyze resolved after ${(performance.now()-t0).toFixed(0)}ms`, result);
  }).catch(err => console.error(`[runEngine] runId=${runId} analyze failed`, err));
}

function showPosition(fen){
  console.debug(`[showPosition] fen=${fen}`);
  board.setPosition(fen);
  runEngine(fen);
}

showPosition(new Chess().fen());
