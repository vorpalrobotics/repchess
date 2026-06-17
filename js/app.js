/* ---------- helpers ---------- */
const $   = id => document.getElementById(id);
const log = (m,e=false)=>{ $('progress').textContent=m; $('progress').classList.toggle('error',e); };
const clr = ()=>{ $('progress').textContent='';$('progress').classList.remove('error'); };

/* ---------- persistent prefs ---------- */
const LS_ID='lichess_lastUser', LS_MAX='lichess_lastMax';
$('userId').value  = localStorage.getItem(LS_ID)  || '';
$('maxGames').value= localStorage.getItem(LS_MAX)||300;

/* ---------- globals ---------- */
let GAMES=null, CURRENT_USER='';

/* ---------- storage helpers ---------- */
const prefKey  = seq => `lichess-${CURRENT_USER}-${seq.join(',')}`;          // reply
const noteKey  = seq => `lichess-note-${CURRENT_USER}-${seq.join(',')}`;     // note
const savePref = (seq,v)=> localStorage.setItem(prefKey(seq),v);
const loadPref = seq   => localStorage.getItem(prefKey(seq));
const saveNote = (seq,v)=> localStorage.setItem(noteKey(seq),v);
const loadNote = seq   => localStorage.getItem(noteKey(seq))||'';

/* ---------- fetch games from Lichess ---------- */
async function fetchLatest(user,max){
  const url=`https://lichess.org/api/games/user/${encodeURIComponent(user)}?max=${max}&moves=true&tags=false&opening=false`;
  const txt=await (await fetch(url,{headers:{Accept:'application/x-ndjson'}})).text();
  return txt.trim().split(/\r?\n/).filter(Boolean);
}

/* ---------- compute reply frequencies ---------- */
function replies(lines,seq){
  const counts={}, n=seq.length; let tot=0;
  for(const l of lines){
    let g;try{g=JSON.parse(l);}catch{continue;}
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
function renderBranch(parent,lines,seq,depth){
  const {counts,tot}=replies(lines,seq);
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
      `<thead><tr><th>Move</th><th>Notes</th><th>Count</th><th>Response</th></tr></thead>`;
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
    const inpRep    = tr.querySelector('[data-reply]');
    const [btnGo,btnEval] = tr.querySelectorAll('button.iconbtn:not(.toggle)');

    /* restore note & reply */
    inpNote.value = loadNote([...seq,opp]);
    const savedRep = loadPref([...seq,opp]);
    if(savedRep){
      inpRep.value = savedRep;
      const tr1=document.createElement('tr'); tr.after(tr1);
      const td1=document.createElement('td'); td1.colSpan=5; tr1.appendChild(td1);
      const div=document.createElement('div'); div.className='branch'; td1.appendChild(div);
      renderBranch(div,lines,[...seq,opp,savedRep],depth+1);
      makeToggle(toggleBtn,tr1);
    }

    /* save note on blur */
    inpNote.onblur = () => saveNote([...seq,opp],inpNote.value.trim());

    /* expand under chosen reply */
    btnGo.onclick = () => {
      const reply = inpRep.value.trim();
      if(!reply){ log('enter move',true); return; }
      savePref([...seq,opp],reply);

      if(tr.nextSibling?.querySelector?.('.branch')) return; // already expanded

      const tr1=document.createElement('tr'); tr.after(tr1);
      const td1=document.createElement('td'); td1.colSpan=5; tr1.appendChild(td1);
      const div=document.createElement('div'); div.className='branch'; td1.appendChild(div);
      renderBranch(div,lines,[...seq,opp,reply],depth+1);
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
  GAMES = txt.trim().split(/\r?\n/).filter(Boolean);
  clr();
  searchRoot();               // re-run automatically
});

/* ---------- main search action ---------- */
function searchRoot(){
  clr();
  $('tree').innerHTML='';

  const first=$('firstMove').value.trim();
  if(!first){ log('enter first move',true); return; }

  /* prompt for NDJSON if nothing is loaded yet */
  if(!GAMES){
    $('fileImport').click();
    return;
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
    GAMES = await fetchLatest(CURRENT_USER,max);
    log(`downloaded ${GAMES.length}`);
  }catch(e){ log(e.message,true); }
};

$('rootBtn').onclick = searchRoot;
