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
    field==='lineName' ? 'Rename Line' :
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
    tb.insertAdjacentHTML('beforeend',
      `<tr><td class="resp"></td><td class="move" colspan="4" style="padding-left:${depth}em">(no further games)</td></tr>`);
    appendAddMoveControl(tb,parent,games,seq,depth,flip);
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
         <button class="iconbtn" title="Analyse">📈</button>
         <div class="row-menu-wrap">
           <button class="iconbtn rowMenuBtn" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>
           <div class="row-menu">
             <button type="button" data-act="response"><i class="fa-solid fa-check"></i>Set Standard Response</button>
             <button type="button" data-act="focus"><i class="fa-solid fa-crosshairs"></i>Focus on this Line</button>
             <button type="button" data-act="hide"><i class="fa-solid fa-eye-slash"></i>Hide This Branch</button>
             <button type="button" data-act="analyzeChildren"><i class="fa-solid fa-magnifying-glass-chart"></i>Analyze Child Nodes</button>
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
         <span class="analyzingIcon" style="display:none" title="Analyzing children — click to stop"><i class="fa-solid fa-calculator fa-fade"></i></span>
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
        (d,score)=>recordEvalIfDeeper(saveField,currentSaved,evalSpan,d,score,fen),
        ()=>clearLiveEval(evalSpan));
    };
  });

  appendAddMoveControl(tb,parent,games,seq,depth,flip);
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
       <button class="iconbtn" title="Analyse">📈</button>
       <div class="row-menu-wrap">
         <button class="iconbtn rowMenuBtn" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>
         <div class="row-menu">
           <button type="button" data-act="response"><i class="fa-solid fa-check"></i>Set Standard Response</button>
           <button type="button" data-act="focus"><i class="fa-solid fa-crosshairs"></i>Focus on this Line</button>
           <button type="button" data-act="hide"><i class="fa-solid fa-eye-slash"></i>Hide This Branch</button>
           <button type="button" data-act="analyzeChildren"><i class="fa-solid fa-magnifying-glass-chart"></i>Analyze Child Nodes</button>
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
       <span class="analyzingIcon" style="display:none" title="Analyzing children — click to stop"><i class="fa-solid fa-calculator fa-fade"></i></span>
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
      (d,score)=>recordEvalIfDeeper(saveField,currentSaved,evalSpan,d,score,fen),
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
    list.innerHTML = '<p>Set your Lichess ID via the menu &rarr; Download Games, then create a line.</p>';
    return;
  }

  const lines = await getLines(CURRENT_USER);
  if(!lines.length){
    list.innerHTML = '<p>No lines yet &mdash; click + to create one.</p>';
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
      if(!confirm(`Delete line "${line.name}"?`)) return;
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
    $('tree').innerHTML = '<p>This line has no opening move configured yet.</p>';
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
    if(CURRENT_LINE) await openLine(CURRENT_LINE);
    else await renderHome();
  }catch(e){ console.error('[dlBtn] download failed',e); log(e.message,true); }
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
  $('downloadOverlay').style.display='flex';
};
$('downloadCancelBtn').onclick = ()=>{ $('downloadOverlay').style.display='none'; };

/* ---------- export / import backup ---------- */
async function exportBackup(){
  if(!CURRENT_USER){ log('set your Lichess ID first (menu → Download Games)',true); return; }
  const lines = await getLines(CURRENT_USER);
  const data = {
    version: 1,
    user: CURRENT_USER,
    exportedAt: new Date().toISOString(),
    lines: await Promise.all(lines.map(async line=>({
      name: line.name, color: line.color, openingMoves: line.openingMoves,
      prefs: Object.values(await getAllPrefs(line.id)).map(p=>({seq:p.seq, reply:p.reply, note:p.note, mnemonic:p.mnemonic}))
    })))
  };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `repchess-backup-${CURRENT_USER}-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  log(`exported ${lines.length} line(s)`);
}

async function importBackup(data){
  if(!CURRENT_USER){ log('set your Lichess ID first (menu → Download Games)',true); return; }
  if(!data || !Array.isArray(data.lines)) throw new Error('not a valid backup file');
  for(const lineData of data.lines){
    const line = await createLine(CURRENT_USER, {name:lineData.name, color:lineData.color, openingMoves:lineData.openingMoves});
    for(const pref of (lineData.prefs||[])){
      await setPref(line.id, pref.seq, {reply:pref.reply||'', note:pref.note||'', mnemonic:pref.mnemonic||''});
    }
  }
  log(`imported ${data.lines.length} line(s)`);
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
function hideHoverPreview(){
  clearTimeout(hoverPreviewTimer);
  hoverPreviewTimer = null;
  $('hoverPreview').style.display = 'none';
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
      const size = 168; // preview box incl. border/padding
      const left = Math.min(r.left, window.innerWidth - size - 8);
      const top  = r.bottom + size + 6 <= window.innerHeight ? r.bottom + 6 : r.top - size - 6;
      preview.style.left = `${Math.round(Math.max(8,left))}px`;
      preview.style.top = `${Math.round(Math.max(8,top))}px`;
    }, 2000);
  });
  icon.addEventListener('mouseleave', hideHoverPreview);
}

/* ---------- engine ---------- */
const ENGINE_PV_PLIES = 8;
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
  if(evalSpan === liveEvalSpan){
    evalSpan.classList.add('evaltag-live');
    evalSpan.title = 'Live analysis in progress…';
  } else {
    evalSpan.title = `Saved eval, depth ${evalObj.depth} — click 📈 to refresh`;
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
  evalSpan.title = depth ? `Saved eval, depth ${depth} — click 📈 to refresh` : '';
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
function recordEvalIfDeeper(saveField, currentSaved, evalSpan, depth, rawScore, fen){
  const existing = currentSaved()?.eval;
  if(existing && existing.depth >= depth) return;
  const evalObj = {...evalToWhiteRelative(rawScore,fen), depth};
  saveField('eval', evalObj);
  refreshEvalSpan(evalSpan, evalObj);
}

function savePrefField(seq,field,value){
  setPref(CURRENT_LINE.id,seq,{[field]:value});
  const key = prefKey(CURRENT_LINE.id,seq);
  (PREFS[key] ??= {key,lineId:CURRENT_LINE.id,seq,reply:'',note:'',mnemonic:'',hidden:false})[field]=value;
}

/* manually-recorded opponent replies for the position `seq`, kept alongside
   that position's own prefs so a theoretical try can be added before any
   imported game actually contains it */
function addManualReply(seq,move){
  const existing = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
  if(existing.includes(move)) return;
  savePrefField(seq,'manualReplies',[...existing,move]);
}

function removeManualReply(seq,move){
  const existing = PREFS[prefKey(CURRENT_LINE.id,seq)]?.manualReplies || [];
  savePrefField(seq,'manualReplies',existing.filter(m=>m!==move));
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

  try {
    await engine.analyze(fen, {
      multipv: entries.length,
      depth: targetDepth,
      searchmoves: entries.map(e => e.uci),
      onInfo: (d, lines) => {
        for(const line of Object.values(lines)){
          const uci = line.pv[0];
          if(!uci) continue;
          const entry = entries.find(e => e.uci === uci);
          if(!entry) continue;
          const childSeq = [...parentSeq, entry.opp];
          const existing = PREFS[prefKey(CURRENT_LINE.id, childSeq)]?.eval;
          if(existing && existing.depth >= line.depth) continue;
          const evalObj = {...evalToWhiteRelative(line.score, fen), depth: line.depth};
          savePrefField(childSeq, 'eval', evalObj);
          refreshEvalSpan(entry.evalSpan, evalObj);
        }
      }
    });
  } finally {
    if(activeChildAnalysisIcon === icon) activeChildAnalysisIcon = null;
    icon.style.display = 'none';
    icon.onclick = null;
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
    const li = document.createElement('li');
    li.textContent = `${formatScore(line.score,turn)}  ${pvToSan(fen,line.pv,ENGINE_PV_PLIES)}`;
    ol.appendChild(li);
  }
}

async function runEngine(fen, onEvalUpdate, onComplete){
  currentEngineFen = fen;
  const runId = ++engineRunId;
  console.debug(`[runEngine] runId=${runId} fen=${fen}`);
  if(!engine.ready) await engine.init().catch(()=>{});
  if(runId !== engineRunId){ console.debug(`[runEngine] runId=${runId} superseded before engine ready, dropping`); return; }
  if(!engine.ready){ console.warn(`[runEngine] runId=${runId} engine never became ready, aborting`); return; }
  $('engineDepth').textContent = 'Live — Thinking…';
  $('engineLines').innerHTML = '';
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
      if(onEvalUpdate && lines[1]?.score) onEvalUpdate(lines[1].depth, lines[1].score);
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
