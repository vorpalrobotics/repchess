import { Chessboard, COLOR } from 'https://cdn.jsdelivr.net/npm/cm-chessboard@8/src/Chessboard.js';
import { Engine } from './engine.js';

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

/* ---------- persistent prefs (small, stays in localStorage) ---------- */
const LS_ID='lichess_lastUser', LS_MAX='lichess_lastMax';
const LS_ENGINE_LINES='engine_lastLines', LS_ENGINE_DEPTH='engine_lastDepth';
const LS_SHOW_ALL_BRANCHES='repchess_showAllBranches';
$('userId').value  = localStorage.getItem(LS_ID)  || '';
$('maxGames').value= localStorage.getItem(LS_MAX)||300;

/* ---------- globals ---------- */
let GAMES=null, CURRENT_USER=localStorage.getItem(LS_ID)||'', PREFS={}, CURRENT_LINE=null;

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

/* ---------- node statistics ----------
   A "node" is one move pair: an opponent move plus our chosen reply to it.
   Counts every node in the subtree rooted at `seq` (our move, the same kind
   of sequence renderBranch takes), and the largest branch factor (number of
   opponent move options) seen at any node in that subtree. Only nodes with
   an actual saved reply are counted/descended into — undecided branches
   don't contribute nodes of their own. */
function computeNodeStats(games,seq){
  const counts = replies(games,seq).counts;
  const manualReplies = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
  manualReplies.forEach(m=>{ if(!(m in counts)) counts[m]=0; });

  const branchFactor = Object.keys(counts).length;
  let nodeCount = 0, maxBranchFactor = branchFactor;
  for(const opp of Object.keys(counts)){
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

function showNodeStats(games,seq){
  const {nodeCount,maxBranchFactor} = computeNodeStats(games,seq);
  alert(`Nodes below this point: ${nodeCount}\nMax branch factor: ${maxBranchFactor}`);
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
  btn.innerHTML='<i class="fa-solid fa-caret-down"></i>';   // newly (re-)expanded, so shown
  btn.onclick=()=>{                              // rewired each call to target the current branchRow
    const shown = branchRow.style.display !== 'none';
    branchRow.style.display = shown ? 'none' : '';
    btn.innerHTML = shown
      ? '<i class="fa-solid fa-caret-right"></i>'
      : '<i class="fa-solid fa-caret-down"></i>';
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

/* ---------- focus on a single line, hiding sibling branches above it ----------
   Walks from the clicked row up through each ancestor table, hiding every
   other reply group at that depth; everything at or below the focused row
   is left exactly as rendered (untouched). */
let focusHidden = [];
function clearFocus(){
  focusHidden.forEach(el=>el.classList.remove('focus-hidden'));
  focusHidden = [];
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
function focusOnLine(dataRow){
  clearFocus();
  let node = dataRow;
  while(node){
    const tbody = node.parentElement;
    const keep = new Set(rowGroup(tbody, node));
    Array.from(tbody.children).forEach(row=>{
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
};

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

  Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([opp,c])=>{
    const isManual = c===0 && manualReplies.includes(opp);
    const tr=document.createElement('tr');
    tr.className = 'data-row';
    tr.dataset.opp = opp;
    const moveHtml = flip
      ? `${depth+1}. ${opp} <span class="ourReply">...</span>`
      : `${depth+1}. ${seq.at(-1)} ${opp}`;
    tr.innerHTML=
      `<td class="resp">
         <button class="iconbtn" title="Analyse"><i class="fa-solid fa-chess-board"></i></button>
         <div class="row-menu-wrap">
           <button class="iconbtn rowMenuBtn" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>
           <div class="row-menu">
             <button type="button" data-act="response"><i class="fa-solid fa-check"></i>Set Standard Response</button>
             <button type="button" data-act="focus"><i class="fa-solid fa-crosshairs"></i>Focus on this Line</button>
             <button type="button" data-act="hide"><i class="fa-solid fa-eye-slash"></i>Hide This Branch</button>
             <button type="button" data-act="analyzeChildren"><i class="fa-solid fa-magnifying-glass-chart"></i>Analyze Child Nodes</button>
             <button type="button" data-act="nodeStats"><i class="fa-solid fa-diagram-project"></i>Node Statistics</button>
             <button type="button" data-act="addMove"><i class="fa-solid fa-plus"></i>Add Opponent Move</button>
             <hr class="row-menu-sep">
             <button type="button" data-act="note"><i class="fa-solid fa-pen"></i>Add Note</button>
             <button type="button" data-act="mnemonic"><i class="fa-solid fa-brain"></i>Add Mnemonic</button>
             <button type="button" data-act="branchName"><i class="fa-solid fa-tag"></i>Add Branch Name</button>
             <button type="button" data-act="removeManual" style="display:none"><i class="fa-solid fa-trash"></i>Remove This Move</button>
           </div>
         </div>
       </td>
       <td class="move" style="padding-left:${depth}em">
         <button class="iconbtn toggle" style="visibility:hidden"><i class="fa-solid fa-caret-right"></i></button>
         ${moveHtml}
       </td>
       <td class="cnt-col" style="padding-left:${depth}em">
         <span class="cnt">${c} (${tot ? ((c/tot)*100).toFixed(1) : '0.0'}%)</span>
       </td>
       <td class="eval-col">
         <span class="analyzingIcon" style="display:none" title="Analyzing children — click to stop"><i class="fa-solid fa-calculator fa-fade"></i><span class="analyzingDepth"></span></span>
         <span class="evaltag" style="display:none"></span>
       </td>
       <td class="name-col">
         <span class="branchName" style="display:none"></span>
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
    const analyzingIcon = tr.querySelector('.analyzingIcon');

    const lineSeq = [...seq,opp];
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
    function expandWith(reply){
      const old = metaTr.nextSibling;
      if(old?.querySelector?.('.branch')) old.remove();

      const tr1=document.createElement('tr'); tr1.className='branch-row'; metaTr.after(tr1);
      const td1=document.createElement('td'); td1.colSpan=5; td1.style.padding='0'; tr1.appendChild(td1);
      const div=document.createElement('div'); div.className='branch'; td1.appendChild(div);
      childrenSeq = [...lineSeq,reply];
      branchDiv = div;
      renderBranch(div,games,childrenSeq,depth+1,flip);
      makeToggle(toggleBtn,tr1);
    }

    function setStandardResponse(reply){
      setPref(CURRENT_LINE.id,lineSeq,{reply});
      (PREFS[prefKey(CURRENT_LINE.id,lineSeq)] ??= {key:prefKey(CURRENT_LINE.id,lineSeq),lineId:CURRENT_LINE.id,seq:lineSeq,reply:'',note:'',mnemonic:'',hidden:false}).reply=reply;
      const replySpan = tr.querySelector('.ourReply');
      if(replySpan) replySpan.textContent = reply;
      expandWith(reply);
      refreshRowMenuLabels(rowMenu, currentSaved());
      analyzeChildNodes(childrenSeq, branchDiv, analyzingIcon); // passive: fill in sibling evals now that this branch is newly visible
    }

    /* restore reply from the preloaded PREFS map */
    const savedRep = currentSaved()?.reply;
    if(savedRep){
      const replySpan = tr.querySelector('.ourReply');
      if(replySpan) replySpan.textContent = savedRep;
      expandWith(savedRep);
    }
    refreshHidden();
    refreshEvalSpan(evalSpan, currentSaved()?.eval);
    refreshBranchName(nameSpan, currentSaved()?.name);

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
      focusOnLine(tr);
    };
    hideBtn.onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      saveField('hidden', !currentSaved()?.hidden);
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
    rowMenu.querySelector('[data-act="branchName"]').onclick = e => {
      e.stopPropagation();
      rowMenu.classList.remove('show');
      openFieldModal('branchName', currentSaved()?.name, v=>{
        saveField('name', v);
        refreshBranchName(nameSpan, v);
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
      const fen = fenForSeq(lineSeq);
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
           <button type="button" data-act="analyzeChildren"><i class="fa-solid fa-magnifying-glass-chart"></i>Analyze Child Nodes</button>
           <button type="button" data-act="nodeStats"><i class="fa-solid fa-diagram-project"></i>Node Statistics</button>
           <button type="button" data-act="addMove"><i class="fa-solid fa-plus"></i>Add Opponent Move</button>
           <hr class="row-menu-sep">
           <button type="button" data-act="note"><i class="fa-solid fa-pen"></i>Add Note</button>
           <button type="button" data-act="mnemonic"><i class="fa-solid fa-brain"></i>Add Mnemonic</button>
           <button type="button" data-act="branchName"><i class="fa-solid fa-tag"></i>Add Branch Name</button>
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
  const analyzingIcon = tr.querySelector('.analyzingIcon');

  const lineSeq = [trigger];
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
  function expandWith(reply){
    const old = metaTr.nextSibling;
    if(old?.querySelector?.('.branch')) old.remove();

    const tr1=document.createElement('tr'); tr1.className='branch-row'; metaTr.after(tr1);
    const td1=document.createElement('td'); td1.colSpan=5; td1.style.padding='0'; tr1.appendChild(td1);
    const div=document.createElement('div'); div.className='branch'; td1.appendChild(div);
    childrenSeq = [...lineSeq,reply];
    branchDiv = div;
    renderBranch(div,games,childrenSeq,1,true);
    makeToggle(toggleBtn,tr1);
  }

  function setStandardResponse(reply){
    setPref(CURRENT_LINE.id,lineSeq,{reply});
    (PREFS[prefKey(CURRENT_LINE.id,lineSeq)] ??= {key:prefKey(CURRENT_LINE.id,lineSeq),lineId:CURRENT_LINE.id,seq:lineSeq,reply:'',note:'',mnemonic:'',hidden:false}).reply=reply;
    const replySpan = tr.querySelector('.ourReply');
    if(replySpan) replySpan.textContent = reply;
    expandWith(reply);
    refreshRowMenuLabels(rowMenu, currentSaved());
    analyzeChildNodes(childrenSeq, branchDiv, analyzingIcon); // passive: fill in sibling evals now that this branch is newly visible
  }

  const savedRep = currentSaved()?.reply;
  if(savedRep){
    const replySpan = tr.querySelector('.ourReply');
    if(replySpan) replySpan.textContent = savedRep;
    expandWith(savedRep);
  }
  refreshHidden();
  refreshEvalSpan(evalSpan, currentSaved()?.eval);
  refreshBranchName(nameSpan, currentSaved()?.name);

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
  rowMenu.querySelector('[data-act="branchName"]').onclick = e => {
    e.stopPropagation();
    rowMenu.classList.remove('show');
    openFieldModal('branchName', currentSaved()?.name, v=>{
      saveField('name', v);
      refreshBranchName(nameSpan, v);
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
  $('homeScreen').style.display='';
  $('lineScreen').style.display='none';
  CURRENT_LINE = null;
  clr();

  const list = $('linesList');
  list.innerHTML='';
  if(!CURRENT_USER){
    list.innerHTML = '<p>Set your Lichess ID via the menu &rarr; Download Games, then create an opening system.</p>';
    return;
  }

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
}

/* ---------- line screen: tree + engine for one line ---------- */
async function openLine(line){
  CURRENT_LINE = line;
  $('homeScreen').style.display='none';
  $('lineScreen').style.display='';
  $('lineTitle').textContent = `${line.name} (${line.color})`;

  clr();
  focusHidden = [];
  $('unfocusBtn').style.display='none';
  applyVisibilityMode();
  $('tree').innerHTML='';

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

  const triggers = line.openingMoves || [];
  if(!triggers.length){
    $('tree').innerHTML = '<p>This opening system has no opening move configured yet.</p>';
    return;
  }
  triggers.forEach(mv=>{
    const heading = line.color==='black' ? 'Against' : 'Playing';
    $('tree').insertAdjacentHTML('beforeend', `<h3 class="trigger-heading">${heading} 1. ${escapeHtml(mv)}</h3>`);
    const wrap = document.createElement('div');
    $('tree').appendChild(wrap);
    if(line.color==='black'){
      renderBlackRoot(wrap,GAMES,mv);
    } else {
      renderBranch(wrap,GAMES,[mv],0);
    }
  });
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
  if(!CURRENT_USER){ $('lineModalError').textContent='set your Lichess ID first (menu → Download Games)'; return; }

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
  CURRENT_USER=$('userId').value.trim().toLowerCase();
  if(!CURRENT_USER){ logDl('enter id',true); return; }
  localStorage.setItem(LS_ID,CURRENT_USER);

  const max=+$('maxGames').value||300;
  localStorage.setItem(LS_MAX,max);

  try{
    logDl('fetching…');
    GAMES = await fetchLatest(CURRENT_USER,max,n=>logDl(`fetching… got ${n}`));
    logDl(`fetched ${GAMES.length}, writing to database…`);
    await putGames(CURRENT_USER,GAMES);
    logDl(`downloaded ${GAMES.length}`);
    $('downloadOverlay').style.display='none';
    if(CURRENT_LINE) await openLine(CURRENT_LINE);
    else await renderHome();
  }catch(e){ console.error('[dlBtn] download failed',e); logDl(e.message,true); }
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

/* ---------- download modal ---------- */
$('menuDownload').onclick = ()=>{
  $('menuList').style.display='none';
  logDl('');
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
  if(!CURRENT_USER){ log('set your Lichess ID first (menu → Download Games)',true); return; }
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
        hidden:p.hidden, manualReplies:p.manualReplies, eval:p.eval, name:p.name
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
    mnemonicsNotes: await getMeta(MNEM_NOTES_KEY)
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
        eval:pref.eval||null, name:pref.name||''
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
        .map(p=>`<div class="mnem-word"><i class="fa-solid ${MNEM_PIECE_ICON[p]}"></i>${escapeHtml(entry[p])}</div>`)
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

/* toggles row-menu item labels between their "Add"/"Set" and "Edit" wording
   depending on whether that field already has a saved value */
function refreshRowMenuLabels(rowMenu, saved){
  const responseBtn = rowMenu.querySelector('[data-act="response"]');
  if(responseBtn) responseBtn.lastChild.textContent = saved?.reply ? 'Edit Standard Response' : 'Set Standard Response';
  const noteBtn = rowMenu.querySelector('[data-act="note"]');
  if(noteBtn) noteBtn.lastChild.textContent = saved?.note ? 'Edit Note' : 'Add Note';
  const mnemonicBtn = rowMenu.querySelector('[data-act="mnemonic"]');
  if(mnemonicBtn) mnemonicBtn.lastChild.textContent = saved?.mnemonic ? 'Edit Mnemonic' : 'Add Mnemonic';
  const branchNameBtn = rowMenu.querySelector('[data-act="branchName"]');
  if(branchNameBtn) branchNameBtn.lastChild.textContent = saved?.name ? 'Edit Branch Name' : 'Add Branch Name';
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
  $('engineDepth').textContent = `Live — Depth ${depth}`;
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
    $('engineDepth').textContent = 'Starting position — analysis skipped';
    $('engineLines').innerHTML = '';
    onComplete?.();
    return;
  }
  if(!engine.ready) await engine.init().catch(()=>{});
  if(runId !== engineRunId){ console.debug(`[runEngine] runId=${runId} superseded before engine ready, dropping`); return; }
  if(!engine.ready){ console.warn(`[runEngine] runId=${runId} engine never became ready, aborting`); return; }
  $('engineDepth').textContent = 'Live — Thinking…';
  $('engineLines').innerHTML = '';
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
    if(runId === engineRunId) onComplete?.();
  }).catch(err => console.error(`[runEngine] runId=${runId} analyze failed`, err));
}

function showPosition(fen, onEvalUpdate, onComplete){
  console.debug(`[showPosition] fen=${fen}`);
  board.setPosition(fen);
  runEngine(fen, onEvalUpdate, onComplete);
}

showPosition(new Chess().fen());
