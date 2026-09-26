/* ---------- AI brainstorm for new object lists ----------
   Documents/list-brainstorm.md is the design.

   Describe the list you want; a model on Runware (the same key as image
   generation) suggests three candidate lists in the object-list shape; you
   refine them in conversation, and "Use this" fills in the new list's editor,
   where the ordinary Save -- with all its checks -- makes it real.

   This module imports nothing from the rest of the app: objectLists.js, its
   only importer, hands in what it needs (the Runware text call, the key's
   storage name, the ordering/mnemonic vocabularies, existing list names, and
   what "Use this" does). One importer, one ?v= to keep in step.

   Output: asked for as schema-conforming JSON where the model supports it,
   and in every case parsed forgivingly (code fences, a stray sentence) and
   checked strictly. A reply that cannot be used gets one repair round -- the
   specific problems sent back in the same conversation -- before it is shown
   to you as a failure, raw text included, rather than silently dropped. */
import { modalBarHtml, wireModalBar } from './modalBar.js?v=20260804-5';

const BRAINSTORM_MODEL_LS = 'repchess.brainstormModel';
const BRAINSTORM_CUSTOM_LS = 'repchess.brainstormCustomModel';
/* The cheaper model is the default: suggesting a handful of ordered objects
   is not a demanding task. Runware names Claude models 'anthropic:claude@…'
   (e.g. anthropic:claude@opus-4.8); these two follow that pattern, and
   "Other model" takes any ID from runware.ai/models if one is renamed. */
export const BRAINSTORM_MODELS = [
  { id: 'anthropic:claude@haiku-4.5',  label: 'Claude Haiku 4.5 (fast, cheap)' },
  { id: 'anthropic:claude@sonnet-4.6', label: 'Claude Sonnet 4.6 (stronger)' },
  { id: 'custom',                      label: 'Other Runware model (enter its ID)…' },
];
export const BRAINSTORM_CANDIDATES = 3;
const MAX_TOKENS = 6000;
const MAX_TOKENS_CASTLE = 16000;   // a dozen lists is a long reply
export const CASTLE_MAX_LISTS = 12;

function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function lsGet(k){ try { return localStorage.getItem(k) || ''; } catch(_){ return ''; } }
function lsSet(k, v){ try { localStorage.setItem(k, v); } catch(_){} }

/* ---------- what the model is told ----------
   A condensed Documents/MnemonicListDesignPrinciples.md -- the app's own
   account of what makes a list memorable -- plus the output contract. Kept
   identical between requests. */
export function brainstormSystemPrompt(orderingTypes, mnemonicTypes){
  const list = (o) => Object.entries(o).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return `You help design ordered object lists for a chess memory palace. Each list is a set of objects placed, in order, along a wall of a room in a virtual castle; each object anchors one pair of chess moves, so the user must be able to recall the objects IN ORDER from the room and the rule alone.

What makes a list memorable -- prefer the highest tier that fits:
1. An existing cultural mnemonic already in long-term memory (planets, rainbow, musical scale).
2. A familiar phrase lightly adapted to cover the category.
3. A canonical sequence without a popular acronym (months, days of the week, taxonomic ranks).
4. A strong natural ordering inherent to the objects: size, weight, age, brightness, temperature, hardness, chronology, a life cycle, or a real process or workflow (e.g. food: store, prep, cook, clean).
5. Only when nothing above fits: an invented phrase whose initials match the objects.
Spatial orderings (left to right, clockwise, walking path) are the weakest: avoid them.

Rules:
- Never weaken a strong ordering to improve a mnemonic's initials; canonical sequences are never reordered.
- The objects must fit the room's theme, be concrete, and be easy to picture as a single image.
- Item names are short (one to three words) and unique within the list.
- Give each item brief image instructions: what it looks like, so a picture of it can be generated.
- Say why the order holds in one or two sentences, and state the ordering rule itself plainly.
- The mnemonic is optional support: leave initialism and phrase empty rather than force a weak one.

Ordering types (use one of these keys):
${list(orderingTypes)}

Mnemonic types (use one of these keys):
${list(mnemonicTypes)}

Reply with JSON only -- no prose, no code fences -- in exactly this shape:
{"candidates":[{"name":"","roomName":"","category":"","orderingType":"","orderingRule":"","whyThisOrder":"","items":[{"name":"","imagePrompt":""}],"mnemonic":{"type":"","initialism":"","phrase":""}}]}`;
}

export function brainstormSchema(orderingKeys, mnemonicKeys){
  const str = { type: 'string' };
  return {
    name: 'object_list_candidates', strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['candidates'],
      properties: {
        candidates: { type: 'array', items: {
          type: 'object', additionalProperties: false,
          required: ['name', 'roomName', 'category', 'orderingType', 'orderingRule', 'whyThisOrder', 'items', 'mnemonic'],
          properties: {
            name: str, roomName: str, category: str,
            orderingType: { type: 'string', enum: orderingKeys },
            orderingRule: str, whyThisOrder: str,
            items: { type: 'array', items: {
              type: 'object', additionalProperties: false, required: ['name', 'imagePrompt'],
              properties: { name: str, imagePrompt: str } } },
            mnemonic: { type: 'object', additionalProperties: false, required: ['type', 'initialism', 'phrase'],
              properties: { type: { type: 'string', enum: mnemonicKeys }, initialism: str, phrase: str } },
          } } },
      },
    },
  };
}

/* ---------- reading the reply ----------
   Forgiving about the wrapping, strict about the content. */
export function extractJson(text){
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if(a < 0 || b <= a) throw new Error('the reply contained no JSON object');
  try { return JSON.parse(t.slice(a, b + 1)); }
  catch(err){ throw new Error('the reply was not valid JSON (' + err.message + ')'); }
}
/* Hard problems (unusable) drop a candidate; soft ones (a list longer than
   asked, a name you already use) travel with it as warnings, since you may
   well want it anyway. Zero usable candidates is what triggers the repair. */
export function validateCandidates(obj, { orderingKeys, mnemonicKeys, minItems = 0, maxItems = Infinity, existingNames = [] } = {}){
  const errors = [];
  const out = [];
  const cands = obj && Array.isArray(obj.candidates) ? obj.candidates : null;
  if(!cands) return { candidates: [], errors: ['the reply has no "candidates" array'] };
  const taken = new Set(existingNames.map(n => String(n).trim().toLowerCase()));
  cands.forEach((c, i) => {
    const label = `candidate ${i + 1}`;
    if(!c || typeof c !== 'object'){ errors.push(`${label} is not an object`); return; }
    const s = (v) => (typeof v === 'string' ? v.trim() : '');
    const name = s(c.name);
    if(!name){ errors.push(`${label} has no name`); return; }
    if(!orderingKeys.includes(c.orderingType)){
      errors.push(`${label} ("${name}") has orderingType "${c.orderingType}", which is not one of: ${orderingKeys.join(', ')}`);
      return;
    }
    const warnings = [];
    const seen = new Set();
    const items = [];
    for(const it of (Array.isArray(c.items) ? c.items : [])){
      const n = s(it && it.name);
      if(!n) continue;
      if(seen.has(n.toLowerCase())){ warnings.push(`duplicate item "${n}" left out`); continue; }
      seen.add(n.toLowerCase());
      items.push({ name: n, imagePrompt: s(it.imagePrompt) });
    }
    if(items.length < 2){ errors.push(`${label} ("${name}") has fewer than two usable items`); return; }
    if(items.length < minItems || items.length > maxItems){
      warnings.push(`${items.length} items, outside the ${minItems}–${maxItems} asked for`);
    }
    if(taken.has(name.toLowerCase())) warnings.push('you already have a list with this name');
    const m = c.mnemonic && typeof c.mnemonic === 'object' ? c.mnemonic : {};
    let mType = m.type;
    if(!mnemonicKeys.includes(mType)){ mType = 'generated_phrase'; if(s(m.phrase)) warnings.push('mnemonic type was not recognised'); }
    out.push({
      name, roomName: s(c.roomName), category: s(c.category), orderingType: c.orderingType,
      orderingRule: s(c.orderingRule), whyThisOrder: s(c.whyThisOrder), items,
      mnemonic: { type: mType, initialism: s(m.initialism), phrase: s(m.phrase) }, warnings,
    });
  });
  // Within one set of suggestions -- which matters most for a castle's set --
  // a repeated list name or a repeated object is worth knowing about: the
  // point of a castle is that each room is distinct.
  const nameCount = {}, itemOwners = {};
  for(const c of out){
    const k = c.name.toLowerCase();
    nameCount[k] = (nameCount[k] || 0) + 1;
    for(const it of c.items) (itemOwners[it.name.toLowerCase()] ||= new Set()).add(c.name);
  }
  for(const c of out){
    if(nameCount[c.name.toLowerCase()] > 1) c.warnings.push('same name as another suggestion');
    const shared = c.items.filter(it => itemOwners[it.name.toLowerCase()].size > 1).map(it => it.name);
    if(shared.length) c.warnings.push(`also in another suggestion: ${shared.join(', ')}`);
  }
  if(!out.length && !errors.length) errors.push('the reply had no candidates');
  return { candidates: out, errors: out.length ? [] : errors };
}

/* ---------- saved ideas ----------
   Every brainstorm's suggestions are kept, so closing the dialog loses
   nothing: they wait under Saved ideas until used, saved as a list, or
   discarded. Stored in the meta store, which -- like the image queue's jobs
   -- is left out of backups (app.js's BACKUP_EXCLUDED_META) and emptied by
   every restore. Read fresh on each open, so a restore needs no reset here.

   An idea: { id, batchId, createdAt, request, mode, model, candidate }.
   A batch is one Brainstorm press; Refine replaces its own batch rather than
   piling up the suggestions it was asked to improve on. */
const LIST_IDEAS_KEY = 'listIdeas';
let IDEAS = [];
async function loadIdeas(){
  try {
    const v = JSON.parse(await getMeta(LIST_IDEAS_KEY) || '[]');
    IDEAS = Array.isArray(v) ? v : [];
  } catch(_){ IDEAS = []; }
  return IDEAS;
}
async function saveIdeas(){
  try { await setMeta(LIST_IDEAS_KEY, JSON.stringify(IDEAS)); }
  catch(err){ console.error('[listBrainstorm] could not save ideas', err); }
}
// used by objectLists.js once an idea has become a saved list
export async function removeListIdea(id){
  if(!id) return;
  await loadIdeas();
  IDEAS = IDEAS.filter(i => i.id !== id);
  await saveIdeas();
  if(document.getElementById('listBrainstormOverlay')?.style.display === 'flex') renderAll();
}

/* ---------- the dialog ---------- */
let DEPS = null;           // what objectLists.js handed in
let HISTORY = [];          // the conversation so far, for Refine
let BATCH = null;          // { batchId, request, mode } of the suggestions on screen
let SPENT = 0;
let BUSY = false;
let TAB = 'brainstorm';

/* deps: { runwareText, keyLs, orderingTypes, mnemonicTypes, existingNames,
           onUse(candidate, ideaId), saveAsList(candidate) => Promise<savedId>,
           tab: 'brainstorm' | 'ideas' } */
export async function openListBrainstorm(deps){
  DEPS = deps;
  HISTORY = []; BATCH = null; SPENT = 0; BUSY = false;
  await loadIdeas();
  TAB = deps.tab === 'ideas' && IDEAS.length ? 'ideas' : 'brainstorm';
  let ov = document.getElementById('listBrainstormOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'listBrainstormOverlay';
    ov.className = 'overlay';
    // above the Object List Manager (30), its standalone New List modal (72)
    // and the Image Queue (90); below the asset editor (162)
    ov.style.zIndex = '95';
    document.body.appendChild(ov);
  }
  const savedModel = lsGet(BRAINSTORM_MODEL_LS) || BRAINSTORM_MODELS[0].id;
  const orderingOpts = Object.entries(deps.orderingTypes)
    .map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
  ov.innerHTML = `
    <div class="modal" style="width:min(48em,94vw);max-height:90vh;display:flex;flex-direction:column">
      <div class="modal-bar-host">${modalBarHtml({ title: 'Brainstorm a list', prefix: 'lb' })}</div>
      <div class="modal-body lb-body">
        <div class="iq-tabs">
          <button type="button" class="iq-tab" data-tab="brainstorm">Brainstorm</button>
          <button type="button" class="iq-tab" data-tab="ideas">Saved ideas <span id="lbIdeaCount"></span></button>
        </div>
        <div id="lbNotice" class="iq-hint"></div>
        <div id="lbBrainstormView" class="lb-body">
          <div class="lb-mode">
            <label><input type="radio" name="lbMode" value="one" checked> One list (${BRAINSTORM_CANDIDATES} suggestions)</label>
            <label><input type="radio" name="lbMode" value="castle"> A set of lists for a castle</label>
          </div>
          <label class="iq-f"><span id="lbDescLabel">What is the list for?</span>
            <textarea id="lbDesc" rows="3"></textarea></label>
          <div class="iq-grid">
            <label class="iq-f lb-castle-only">How many lists <input type="number" id="lbCount" min="2" max="${CASTLE_MAX_LISTS}" value="6"></label>
            <label class="iq-f lb-castle-only" style="grid-column:span 2">Rooms (optional, comma-separated)
              <input type="text" id="lbRooms" placeholder="e.g. Kitchen, Armory, Chapel" autocomplete="off"></label>
            <label class="iq-f">Preferred ordering <select id="lbOrdering"><option value="">Any (the strongest that fits)</option>${orderingOpts}</select></label>
            <label class="iq-f">Items, from <input type="number" id="lbMin" min="2" max="20" value="5"></label>
            <label class="iq-f">to <input type="number" id="lbMax" min="2" max="20" value="9"></label>
            <label class="iq-f lb-one-only">Room (optional) <input type="text" id="lbRoom" autocomplete="off"></label>
            <label class="iq-f lb-one-only">Category (optional) <input type="text" id="lbCategory" autocomplete="off"></label>
            <label class="iq-f">Model <select id="lbModel">${BRAINSTORM_MODELS.map(m =>
              `<option value="${esc(m.id)}"${m.id === savedModel ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
            <label class="iq-f" id="lbCustomWrap">Runware model ID <input type="text" id="lbCustom" value="${esc(lsGet(BRAINSTORM_CUSTOM_LS))}" autocomplete="off"></label>
          </div>
          <label class="iq-f">Runware API key (the same one as image generation)
            <input type="password" id="lbKey" value="${esc(lsGet(deps.keyLs))}" autocomplete="off"></label>
          <div class="iq-actions"><button type="button" id="lbGo"></button></div>
          <div id="lbStatus" class="iq-hint"></div>
          <div id="lbResults"></div>
          <div id="lbRefineWrap" class="lb-refine" style="display:none">
            <label class="iq-f">Not quite? Say what to change
              <textarea id="lbRefineText" rows="2" placeholder="e.g. fewer items, more tools and fewer furnishings"></textarea></label>
            <div class="iq-actions"><button type="button" id="lbRefine">Refine</button></div>
          </div>
        </div>
        <div id="lbIdeasView"></div>
      </div>
    </div>`;
  ov.style.display = 'flex';
  const q = (id) => ov.querySelector('#' + id);
  // suggestions are kept as Saved ideas, so closing never loses them
  wireModalBar(ov.querySelector('.modal-bar'), { onLeave: () => { if(!BUSY) hide(); } });
  const syncModel = () => {
    q('lbCustomWrap').style.display = q('lbModel').value === 'custom' ? '' : 'none';
    lsSet(BRAINSTORM_MODEL_LS, q('lbModel').value);
  };
  q('lbModel').onchange = syncModel;
  syncModel();
  ov.querySelectorAll('input[name="lbMode"]').forEach(r => r.onchange = syncMode);
  syncMode();
  q('lbGo').onclick = () => brainstorm(false);
  q('lbRefine').onclick = () => brainstorm(true);
  ov.querySelectorAll('.iq-tab').forEach(b => b.onclick = () => { TAB = b.dataset.tab; renderAll(); });
  ov.addEventListener('click', onCardClick);
  renderAll();
}
function mode(){
  const r = document.querySelector('#listBrainstormOverlay input[name="lbMode"]:checked');
  return r ? r.value : 'one';
}
function syncMode(){
  const ov = document.getElementById('listBrainstormOverlay');
  if(!ov) return;
  const castle = mode() === 'castle';
  ov.querySelectorAll('.lb-castle-only').forEach(el => { el.style.display = castle ? '' : 'none'; });
  ov.querySelectorAll('.lb-one-only').forEach(el => { el.style.display = castle ? 'none' : ''; });
  ov.querySelector('#lbDescLabel').textContent = castle ? "What is the castle's theme?" : 'What is the list for?';
  ov.querySelector('#lbDesc').placeholder = castle
    ? 'e.g. a medieval castle with working rooms; or: a haunted Victorian mansion'
    : "e.g. things in a blacksmith's forge, for a medieval castle; or: the stages of making bread";
  ov.querySelector('#lbGo').textContent = castle ? 'Brainstorm the set' : `Brainstorm ${BRAINSTORM_CANDIDATES} lists`;
}
function hide(){
  const ov = document.getElementById('listBrainstormOverlay');
  if(ov){ ov.style.display = 'none'; ov.innerHTML = ''; }
}

function modelId(q){
  const v = q('lbModel').value;
  if(v !== 'custom') return v;
  const c = q('lbCustom').value.trim();
  if(c) lsSet(BRAINSTORM_CUSTOM_LS, c);
  return c;
}

async function brainstorm(refine){
  const ov = document.getElementById('listBrainstormOverlay');
  if(!ov || BUSY) return;
  const q = (id) => ov.querySelector('#' + id);
  const status = (t) => { q('lbStatus').textContent = t; };
  const key = q('lbKey').value.trim();
  const model = modelId(q);
  const orderingKeys = Object.keys(DEPS.orderingTypes);
  const mnemonicKeys = Object.keys(DEPS.mnemonicTypes);
  const min = Math.max(2, parseInt(q('lbMin').value, 10) || 5);
  const max = Math.max(min, parseInt(q('lbMax').value, 10) || 9);
  const castle = refine ? (BATCH && BATCH.mode === 'castle') : mode() === 'castle';
  const count = castle ? Math.min(CASTLE_MAX_LISTS, Math.max(2, parseInt(q('lbCount').value, 10) || 6)) : BRAINSTORM_CANDIDATES;
  if(!key) return status('Enter your Runware API key.');
  if(!model) return status('Enter the Runware model ID.');
  lsSet(DEPS.keyLs, key);
  const ord = q('lbOrdering').value;
  const ordLine = `Preferred ordering: ${ord ? `${ord} (${DEPS.orderingTypes[ord]})` : 'any -- choose the strongest that fits'}`;
  const have = `Lists the user already has (do not duplicate these): ${(DEPS.existingNames || []).slice(0, 60).join('; ') || 'none'}`;
  let userMsg, request;
  if(refine){
    const fb = q('lbRefineText').value.trim();
    if(!fb) return status('Say what to change first.');
    if(!HISTORY.length || !BATCH) return status('Brainstorm first, then refine.');
    userMsg = `Feedback on those candidates: ${fb}\nReply with ${count} new candidates in the same JSON shape.`;
    request = BATCH.request;
  } else {
    const desc = q('lbDesc').value.trim();
    if(!desc) return status(castle ? "Describe the castle's theme." : 'Describe the list you want.');
    request = desc;
    if(castle){
      const rooms = q('lbRooms').value.split(',').map(r => r.trim()).filter(Boolean).slice(0, CASTLE_MAX_LISTS);
      userMsg = [
        `Suggest ${rooms.length || count} object lists for one castle.`,
        `The castle's theme: ${desc}`,
        'Each list belongs to a different room of the castle. Together they should feel like one building, and no object should appear in more than one list.',
        rooms.length ? `Rooms to cover, one list each, in this order: ${rooms.join('; ')}` : `Choose ${count} distinct rooms that suit the theme.`,
        ordLine, `Number of items in each list: between ${min} and ${max}.`, have,
      ].join('\n');
    } else {
      userMsg = [
        `Suggest ${BRAINSTORM_CANDIDATES} candidate object lists.`, `What the list is for: ${desc}`, ordLine,
        `Number of items: between ${min} and ${max}.`,
        `Room: ${q('lbRoom').value.trim() || '(your choice)'}`,
        `Category: ${q('lbCategory').value.trim() || '(your choice)'}`, have,
      ].join('\n');
    }
    HISTORY = [];
  }
  const systemPrompt = brainstormSystemPrompt(DEPS.orderingTypes, DEPS.mnemonicTypes);
  const jsonSchema = brainstormSchema(orderingKeys, mnemonicKeys);
  const check = (text) => {
    try {
      return validateCandidates(extractJson(text), { orderingKeys, mnemonicKeys, minItems: min, maxItems: max,
        existingNames: DEPS.existingNames || [] });
    } catch(err){ return { candidates: [], errors: [err.message] }; }
  };
  const ask = async (messages) => {
    const res = await DEPS.runwareText(key, { model, systemPrompt, messages,
      maxTokens: castle ? MAX_TOKENS_CASTLE : MAX_TOKENS, jsonSchema });
    if(typeof res.cost === 'number') SPENT += res.cost;
    if(res.finishReason === 'length') throw new Error('the reply was cut off before it finished -- ask for fewer lists or items, or try a stronger model');
    return res;
  };
  BUSY = true;
  q('lbGo').disabled = true; q('lbRefine').disabled = true;
  status(refine ? 'Refining…' : 'Brainstorming…');
  try {
    let conv = [...HISTORY, { role: 'user', content: userMsg }];
    let res = await ask(conv);
    let got = check(res.text);
    if(got.errors.length){
      // one repair round: the specific problems, back in the same conversation
      status('The reply needed fixing; asking again…');
      conv = [...conv, { role: 'assistant', content: res.text },
        { role: 'user', content: `That reply could not be used: ${got.errors.join('; ')}. Reply with the corrected JSON only.` }];
      res = await ask(conv);
      got = check(res.text);
    }
    if(got.errors.length){
      status('');
      q('lbResults').innerHTML = `<div class="lb-fail">The model's reply could not be used: ${esc(got.errors.join('; '))}.
        Try again, or pick a stronger model.<details><summary>What it replied</summary><pre>${esc(res.text)}</pre></details></div>`;
      return;
    }
    HISTORY = [...conv, { role: 'assistant', content: res.text }];
    // keep them as ideas; a refine replaces the batch it improved on
    await loadIdeas();
    if(refine && BATCH) IDEAS = IDEAS.filter(i => i.batchId !== BATCH.batchId);
    else BATCH = { batchId: crypto.randomUUID(), request, mode: castle ? 'castle' : 'one' };
    const now = Date.now();
    for(const c of got.candidates){
      IDEAS.push({ id: crypto.randomUUID(), batchId: BATCH.batchId, createdAt: now, request: BATCH.request,
                   mode: BATCH.mode, model, candidate: c });
    }
    await saveIdeas();
    q('lbRefineWrap').style.display = '';
    q('lbRefineText').value = '';
    renderAll();
    status(SPENT ? `Cost so far: $${SPENT.toFixed(4)}` : '');
  } catch(err){
    console.error('[listBrainstorm] failed', err);
    status('Error: ' + ((err && err.message) || err));
  } finally {
    BUSY = false;
    q('lbGo').disabled = false; q('lbRefine').disabled = false;
  }
}

function cardHtml(idea){
  const c = idea.candidate;
  return `
    <div class="lb-card" data-idea="${esc(idea.id)}">
      <div class="lb-card-head"><strong>${esc(c.name)}</strong>
        <span class="iq-meta">${esc([c.roomName, c.category].filter(Boolean).join(' · '))}</span></div>
      <div class="lb-order"><span class="lb-tag">${esc(DEPS.orderingTypes[c.orderingType] || c.orderingType)}</span>
        ${esc(c.orderingRule)}</div>
      ${c.whyThisOrder ? `<div class="iq-hint">${esc(c.whyThisOrder)}</div>` : ''}
      <ol class="lb-items">${c.items.map(it => `<li><strong>${esc(it.name)}</strong>${it.imagePrompt
        ? ` <span class="iq-hint">— ${esc(it.imagePrompt)}</span>` : ''}</li>`).join('')}</ol>
      ${c.mnemonic.phrase ? `<div class="lb-mnem">Mnemonic: “${esc(c.mnemonic.phrase)}”${c.mnemonic.initialism
        ? ` (${esc(c.mnemonic.initialism)})` : ''}</div>` : ''}
      ${c.warnings && c.warnings.length ? `<div class="lb-warn">${c.warnings.map(esc).join(' · ')}</div>` : ''}
      <div class="iq-actions">
        <button type="button" data-act="use" title="Fill in a new list's editor with it, to adjust before saving">Use this</button>
        <button type="button" data-act="save" title="Save it as a list now, as it stands">Save as list</button>
        <button type="button" data-act="discard">Discard</button>
      </div>
    </div>`;
}
function renderAll(){
  const ov = document.getElementById('listBrainstormOverlay');
  if(!ov || !ov.querySelector('#lbIdeasView')) return;
  ov.querySelectorAll('.iq-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === TAB));
  ov.querySelector('#lbIdeaCount').textContent = IDEAS.length ? `(${IDEAS.length})` : '';
  ov.querySelector('#lbBrainstormView').style.display = TAB === 'brainstorm' ? '' : 'none';
  ov.querySelector('#lbIdeasView').style.display = TAB === 'ideas' ? '' : 'none';
  // this brainstorm's own suggestions, still waiting
  const mine = BATCH ? IDEAS.filter(i => i.batchId === BATCH.batchId) : [];
  const results = ov.querySelector('#lbResults');
  if(BATCH) results.innerHTML = mine.length ? mine.map(cardHtml).join('')
    : '<p class="iq-hint">All of these have been used or discarded.</p>';
  // every saved idea, newest brainstorm first
  const batches = [];
  for(const i of [...IDEAS].sort((a, b) => b.createdAt - a.createdAt)){
    let bt = batches.find(x => x.batchId === i.batchId);
    if(!bt) batches.push(bt = { batchId: i.batchId, request: i.request, mode: i.mode, createdAt: i.createdAt, ideas: [] });
    bt.ideas.push(i);
  }
  ov.querySelector('#lbIdeasView').innerHTML = batches.length ? batches.map(bt => `
    <div class="lb-batch" data-batch="${esc(bt.batchId)}">
      <div class="lb-batch-head"><span><strong>${esc(bt.request)}</strong>
        <span class="iq-meta">${bt.mode === 'castle' ? 'castle set · ' : ''}${new Date(bt.createdAt).toLocaleDateString()}</span></span>
        <button type="button" data-act="discard-batch">Discard all</button></div>
      ${bt.ideas.map(cardHtml).join('')}
    </div>`).join('')
    : '<p class="iq-empty">No saved ideas. Brainstorm some, and any you don\'t use straight away wait here.</p>';
}

async function onCardClick(e){
  const btn = e.target.closest('button[data-act]');
  if(!btn || BUSY) return;
  const act = btn.dataset.act;
  if(act === 'discard-batch'){
    const bid = btn.closest('[data-batch]').dataset.batch;
    await loadIdeas();
    IDEAS = IDEAS.filter(i => i.batchId !== bid);
    await saveIdeas();
    return renderAll();
  }
  const card = btn.closest('[data-idea]');
  const idea = card && IDEAS.find(i => i.id === card.dataset.idea);
  if(!idea) return;
  if(act === 'discard'){
    IDEAS = IDEAS.filter(i => i.id !== idea.id);
    await saveIdeas();
    return renderAll();
  }
  if(act === 'use'){
    // removed once the list it fills is actually saved (objectLists.js calls
    // removeListIdea) -- cancelling that editor keeps the idea
    hide();
    return DEPS.onUse(idea.candidate, idea.id);
  }
  if(act === 'save'){
    const status = document.querySelector('#listBrainstormOverlay #lbNotice');   // seen from either tab
    try {
      const res = await DEPS.saveAsList(idea.candidate);
      const id = res && typeof res === 'object' ? res.id : res;
      if(!id) return;
      const queued = (res && res.queued) || 0;
      await removeListIdea(idea.id);
      if(status) status.textContent = `Saved "${idea.candidate.name}" as a list`
        + (queued ? `, and queued ${queued} image${queued === 1 ? '' : 's'} (Menu → Image Queue).` : '.');
    } catch(err){
      if(status) status.textContent = 'Could not save it: ' + ((err && err.message) || err);
    }
  }
}

if(localStorage.getItem('threeTestDebug')) window.__listBrainstormTestHooks = {
  extractJson: (t) => extractJson(t),
  validate: (obj, opts) => validateCandidates(obj, opts),
  systemPrompt: (o, m) => brainstormSystemPrompt(o, m),
  schema: (o, m) => brainstormSchema(o, m),
  ideas: async () => (await loadIdeas()).map(i => ({ ...i })),
};
