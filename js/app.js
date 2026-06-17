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

/* ---------- toggle helper ---------- */
function makeToggle(btn, branchRow){
  if(btn.dataset.ready) return;                 // only wire once
  btn.dataset.ready='1';
  btn.style.visibility='visible';
  btn.textContent='⊖';
  btn.onclick=()=>{
    const shown = branchRow.style.display !== 'none';
    branchRow.style.display = shown ? 'none' : '';
    btn.textContent         = shown ? '⊕'   : '⊖';
  };
}

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
      `<thead><tr><th>Move</th><th>Notes</th><th>Mnemonic</th><th>Count</th><th>Response</th></tr></thead>`;
  }
  const tb=tbl.appendChild(document.createElement('tbody'));

  Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([opp,c])=>{
    const tr=document.createElement('tr');
    tr.innerHTML=
      `<td class="move">
         <button class="iconbtn toggle" style="visibility:hidden">⊖</button>
         ${depth+1}. ${seq.at(-1)} ${opp}
       </td>
       <td class="note"><input data-note size="4" style="width:4em"></td>
       <td class="mnem"><input data-mnemonic size="6" style="width:6em"></td>
       <td class="cnt">${c} (${((c/tot)*100).toFixed(1)}%)</td>
       <td class="resp">
         <input data-reply size="4">
         <button class="iconbtn" title="Expand">🔍</button>
         <button class="iconbtn" title="Analyse">📈</button>
       </td>`;
    tb.appendChild(tr);

    /* element handles */
    const toggleBtn = tr.querySelector('.toggle');
    const inpNote   = tr.querySelector('[data-note]');
    const inpMnem   = tr.querySelector('[data-mnemonic]');
    const inpRep    = tr.querySelector('[data-reply]');
    const [btnGo,btnEval] = tr.querySelectorAll('button.iconbtn:not(.toggle)');

    /* restore note, mnemonic & reply from the preloaded PREFS map */
    const lineSeq = [...seq,opp];
    const saved = PREFS[prefKey(CURRENT_USER,lineSeq)];
    inpNote.value = saved?.note || '';
    inpMnem.value = saved?.mnemonic || '';
    const savedRep = saved?.reply;
    if(savedRep){
      inpRep.value = savedRep;
      const tr1=document.createElement('tr'); tr.after(tr1);
      const td1=document.createElement('td'); td1.colSpan=5; tr1.appendChild(td1);
      const div=document.createElement('div'); div.className='branch'; td1.appendChild(div);
      renderBranch(div,games,[...lineSeq,savedRep],depth+1);
      makeToggle(toggleBtn,tr1);
    }

    /* save note / mnemonic on blur */
    inpNote.onblur = () => {
      const v=inpNote.value.trim();
      setPref(CURRENT_USER,lineSeq,{note:v});
      (PREFS[prefKey(CURRENT_USER,lineSeq)] ??= {key:prefKey(CURRENT_USER,lineSeq),user:CURRENT_USER,seq:lineSeq,reply:'',note:'',mnemonic:''}).note=v;
    };
    inpMnem.onblur = () => {
      const v=inpMnem.value.trim();
      setPref(CURRENT_USER,lineSeq,{mnemonic:v});
      (PREFS[prefKey(CURRENT_USER,lineSeq)] ??= {key:prefKey(CURRENT_USER,lineSeq),user:CURRENT_USER,seq:lineSeq,reply:'',note:'',mnemonic:''}).mnemonic=v;
    };

    /* expand under chosen reply */
    btnGo.onclick = () => {
      const reply = inpRep.value.trim();
      if(!reply){ log('enter move',true); return; }
      setPref(CURRENT_USER,lineSeq,{reply});
      (PREFS[prefKey(CURRENT_USER,lineSeq)] ??= {key:prefKey(CURRENT_USER,lineSeq),user:CURRENT_USER,seq:lineSeq,reply:'',note:'',mnemonic:''}).reply=reply;

      if(tr.nextSibling?.querySelector?.('.branch')) return; // already expanded

      const tr1=document.createElement('tr'); tr.after(tr1);
      const td1=document.createElement('td'); td1.colSpan=5; tr1.appendChild(td1);
      const div=document.createElement('div'); div.className='branch'; td1.appendChild(div);
      renderBranch(div,games,[...lineSeq,reply],depth+1);
      makeToggle(toggleBtn,tr1);
    };

    btnEval.onclick = () => alert('analysis coming soon');
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
  }catch(e){ console.error('[dlBtn] download failed',e); log(e.message,true); }
};

$('rootBtn').onclick = searchRoot;
