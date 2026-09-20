/* ---------- Markdown notes (Documents/notes-feature.md) ----------

   Two exports, both of which COMMIT NOTHING:

     renderNoteInto(el, md)   render a note into an element
     openNoteEditor(md)       edit one, resolving to the new Markdown or null

   The editor returning a value rather than writing one is the whole point of
   the design. `attrSnapshot` includes the note and the Attributes modal
   commits everything on one Save, so an editor that wrote through
   independently would leave that snapshot stale -- and Attributes' Cancel
   could then revert a note saved elsewhere. Returning a value closes that by
   construction, and matches the promise-returning sub-modal shape assets.js
   and objectLists.js already use.

   Toast UI is loaded LAZILY, in two pieces, and neither is fetched at boot:
   the viewer (433KB) only when a note is actually rendered, the full editor
   (940KB) only once the pencil is clicked. Nothing on the default path needs
   either -- the move table shows a glyph, not rendered text.

   That laziness also buys a failure mode the app's other CDN dependencies
   don't have. three.js or cytoscape failing to load stops the app booting; a
   failed Toast load degrades to plain text and a plain textarea, so the
   feature gets worse and nothing breaks. */

import { modalBarHtml, wireModalBar } from './modalBar.js?v=20260804-5';

const TOAST_VERSION = '3.2.2';
const TOAST_CDN = `https://unpkg.com/@toast-ui/editor@${TOAST_VERSION}/dist`;

/* GFM line breaks, i.e. `breaks: true`. Toast has no such option -- it follows
   CommonMark, where a single newline is a SOFT break rendered as a space. That
   would silently reflow every note written before this feature existed (the
   note field has always been a plain multi-line textarea) into one paragraph.

   Overriding the softbreak renderer is the supported way to change it: the
   default returns { type:'html', content: options.softbreak }, so returning a
   <br> instead is the same shape with a different string. */
const MD_RENDERER = {
  softbreak(){ return { type: 'html', content: '<br>\n' }; },
};

/* One promise per bundle: concurrent callers share a single load, and a
   failure is remembered rather than re-attempted on every render. */
const bundles = new Map();
// set once the FULL editor is in, so a session that has already paid for it
// never also fetches the viewer -- the editor can render too (viewer: true)
let EditorCtor = null;

function injectScript(src){
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(el);
  });
}
/* A missing stylesheet is ugly, not fatal, so it never rejects -- holding the
   whole feature back because a CSS file 404'd would turn a cosmetic failure
   into a functional one. */
function injectStyle(href){
  return new Promise((resolve) => {
    const el = document.createElement('link');
    el.rel = 'stylesheet';
    el.href = href;
    el.onload = el.onerror = () => resolve();
    document.head.appendChild(el);
  });
}

function loadBundle(base){
  if(!bundles.has(base)){
    bundles.set(base, (async () => {
      await Promise.all([injectStyle(`${TOAST_CDN}/${base}.css`), injectScript(`${TOAST_CDN}/${base}.js`)]);
      const T = window.toastui && window.toastui.Editor;
      if(!T) throw new Error('toastui.Editor missing after load');
      return T;
    })());
  }
  return bundles.get(base);
}
async function ensureEditor(){
  const T = await loadBundle('toastui-editor');
  EditorCtor = T;
  return T;
}
function ensureViewer(){
  if(EditorCtor) return Promise.resolve(EditorCtor);
  return loadBundle('toastui-editor-viewer');
}

/* Common options for every Toast instance.

   usageStatistics:false matters: Toast pings Google Analytics on startup by
   default. An opening-repertoire app has no business telling a third party
   when you opened a note, and the test harness aborts un-mocked outbound
   requests, so leaving it on would be both wrong and noisy. */
const TOAST_COMMON = { usageStatistics: false, customHTMLRenderer: MD_RENDERER };

/* Renders `md` into `el`. Returns the viewer instance, or null when it fell
   back to plain text.

   This is the ONLY path that turns a note into HTML, and it leans on Toast's
   own sanitizer. The fallback uses textContent rather than innerHTML for the
   same reason: a note is local data, but a restored backup is not necessarily
   a file this browser wrote. */
/* The two bundles expose DIFFERENT shapes under the same `toastui.Editor`
   global, which is not something their docs make obvious and cost a test run
   to find:

     toastui-editor.js         the Editor class, WITH a static .factory()
     toastui-editor-viewer.js  the Viewer class itself, with no .factory at all

   So construction has to branch on which one is in memory. Detecting the
   static rather than tracking which bundle loaded keeps the two callers below
   from having to know. */
function newToast(T, opts){
  return (typeof T.factory === 'function') ? T.factory(opts) : new T(opts);
}

let lastRenderError = null;
export async function renderNoteInto(el, md){
  if(!el) return null;
  const text = md || '';
  try {
    const T = await ensureViewer();
    el.innerHTML = '';
    const v = newToast(T, { el, viewer: true, initialValue: text, ...TOAST_COMMON });
    lastRenderError = null;
    return v;
  } catch(err){
    lastRenderError = err;
    console.warn('[notes] Markdown viewer unavailable — showing the note as plain text', err);
    el.textContent = text;
    return null;
  }
}

/* ---------- the editor modal ----------
   Built on document.body rather than inside the page's own modal stack, the
   same pattern the room-geometry dialog and the asset picker use, so it layers
   above the VR walk's full-screen modal regardless of which container hosts
   the canvas. */
let liveEditor = null;    // the Toast instance, so a close can destroy it
let liveSetValue = null;  // writes into whichever surface is mounted (test hook)

function buildOverlay(title){
  let ov = document.getElementById('noteEditorOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'noteEditorOverlay';
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal note-editor-modal">
        <div class="modal-bar-host"></div>
        <div class="note-editor-host"></div>
      </div>`;
    document.body.appendChild(ov);
  }
  // re-rendered per open so each open wires a fresh controller over fresh
  // buttons -- the same reason assets.js re-mounts its bar per view
  ov.querySelector('.modal-bar-host').innerHTML =
    modalBarHtml({ title: title || 'Note', save: true, prefix: 'noteEd' });
  return ov;
}

/* Mounts the real editor, or a textarea if it can't be had. Resolves to a
   getter for the current Markdown, so the caller never needs to know which one
   it got. */
let lastMountError = null;
async function mountEditor(host, initial, onChange){
  try {
    const T = await ensureEditor();
    host.innerHTML = '';
    const ed = newToast(T, {
      el: host,
      viewer: false,
      height: '100%',
      initialEditType: 'wysiwyg',
      previewStyle: 'vertical',
      initialValue: initial,
      ...TOAST_COMMON,
      // Toast's own change event, not the bar's `watch`: the editing surface is
      // a contenteditable driven by ProseMirror, so there is no reliable input
      // event for the bar to listen to. Same choke-point rule as everywhere
      // else -- refresh where the mutations funnel.
      events: { change: onChange },
    });
    liveEditor = ed;
    lastMountError = null;
    // onChange called explicitly: setMarkdown does not reliably fire Toast's
    // own change event, and a test that set a value the bar never noticed
    // would find Save still disabled
    liveSetValue = (md) => { ed.setMarkdown(md || ''); onChange(); };
    return () => ed.getMarkdown();
  } catch(err){
    lastMountError = err;
    console.warn('[notes] the Markdown editor could not load — falling back to a plain text box', err);
    host.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.id = 'noteFallbackInput';
    ta.className = 'note-fallback';
    ta.value = initial;
    ta.addEventListener('input', onChange);
    host.appendChild(ta);
    ta.focus();
    liveSetValue = (md) => { ta.value = md || ''; onChange(); };
    return () => ta.value;
  }
}

function teardown(ov){
  if(liveEditor){
    try { liveEditor.destroy(); } catch(_){}
    liveEditor = null;
  }
  liveSetValue = null;
  ov.style.display = 'none';
  const host = ov.querySelector('.note-editor-host');
  if(host) host.innerHTML = '';
}

/* Opens the editor on `markdown`. Resolves to the edited Markdown on Save, or
   null on leaving -- never writes anything anywhere. */
export function openNoteEditor(markdown, opts = {}){
  const initial = markdown || '';
  return new Promise(resolve => {
    const ov = buildOverlay(opts.title);
    const host = ov.querySelector('.note-editor-host');
    let getValue = () => initial;
    let settled = false;
    const finish = (value) => {
      if(settled) return;
      settled = true;
      teardown(ov);
      resolve(value);
    };

    const barCtl = wireModalBar(ov.querySelector('.modal-bar'), {
      snapshot: () => ({ md: getValue() }),
      thing: 'this note',
      onLeave: () => finish(null),
      onSave: () => finish(getValue()),
    });

    ov.style.display = 'flex';

    mountEditor(host, initial, () => barCtl.refresh()).then(fn => {
      getValue = fn;
      /* Re-baseline once the editor is really up. Toast normalises Markdown on
         load (trailing newlines, list markers), so the value it reports back
         can differ from the string handed in through no act of the user --
         exactly the asynchronously-populated field wireModalBar's markClean()
         exists for. Without it a note could open already claiming changes. */
      barCtl.markClean();
    });
  });
}

/* Test-only: lets a test force the fallback path without breaking the CDN for
   everything else, so the textarea a failed load leaves behind is covered
   rather than assumed. */
if(typeof localStorage !== 'undefined' && localStorage.getItem('threeTestDebug')){
  window.__notesEditorTestHooks = {
    forceFallback: (on) => {
      if(on){
        bundles.set('toastui-editor', Promise.reject(new Error('forced by test')));
        bundles.get('toastui-editor').catch(() => {});   // no unhandled rejection
        EditorCtor = null;
      } else {
        bundles.delete('toastui-editor');
      }
    },
    loadedBundles: () => [...bundles.keys()],
    /* Sets the open editor's content. Toast's editing surface is a ProseMirror
       contenteditable, so typing into it from a test is a fight with an
       implementation detail; what is worth testing is OUR plumbing -- that a
       value put in comes back out through Save. Routes to the textarea in
       fallback mode, so one test body covers both surfaces. */
    setValue: (md) => { if(liveSetValue) liveSetValue(md); return !!liveSetValue; },
    // what the open editor currently holds -- for asserting that reopening on
    // an existing note really loads it rather than starting blank
    // the editing surface is mounted and writable. The first open of a session
    // downloads ~940KB, so the bar appears well before the editor does; a test
    // that setValue()s on the bar's arrival writes into nothing.
    isReady: () => !!liveSetValue,
    lastRenderError: () => (lastRenderError && (lastRenderError.message || String(lastRenderError))) || null,
    lastMountError: () => (lastMountError && (lastMountError.message || String(lastMountError))) || null,
    getValue: () => {
      if(liveEditor) return liveEditor.getMarkdown();
      const ta = document.getElementById('noteFallbackInput');
      return ta ? ta.value : null;
    },
    isFallback: () => !liveEditor && !!document.getElementById('noteFallbackInput'),
  };
}
