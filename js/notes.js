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

   ---------- why Toast is SELF-HOSTED, unlike every other library here ------

   This is the one dependency the app serves from its own origin (js/vendor/,
   built by test/build-vendor.mjs). Three findings forced it, each costing a
   test run:

   1. @toast-ui/editor's npm dist/toastui-editor.js is NOT a browser bundle.
      Its UMD browser path passes `root[undefined]` for all eight externals,
      so ProseMirror arrives undefined and the script dies on `PluginKey`
      without ever defining its global. It cannot work from a <script> tag.
   2. The dist viewer and editor files publish DIFFERENT shapes under the same
      `toastui.Editor` global -- the editor class has a static .factory(), the
      viewer global IS the Viewer class and has none.
   3. Toast's working standalone build (toastui-editor-all) is not in the npm
      package at all; it exists only on their own CDN, which is unreachable
      from the test sandbox.

   Vendoring a self-built bundle for tests while production loaded a different
   artifact from a CDN would mean the tested path and the shipped path were
   never the same file -- the exact gap that let the asset manager ship with
   no way out. Serving one bundle from our own origin makes them identical,
   removes the CDN as a failure mode, and needs no harness interception.

   It is still LAZY: ~1.1MB, imported on first use and never at boot. Nothing
   on the default path renders a note -- the move table shows a glyph. One
   bundle now serves both roles (Editor.factory({viewer:true})); the separate
   433KB viewer build is gone along with the two-shapes problem it caused.

   The textarea fallback stays. A self-hosted file should always load, but a
   feature that degrades instead of breaking costs three lines. */

import { modalBarHtml, wireModalBar } from './modalBar.js?v=20260804-5';

// served from our own origin; the ?v= is the usual cache-buster discipline
const TOAST_MJS = './vendor/toastui-editor.mjs?v=20260804-1';
const TOAST_CSS = 'js/vendor/toastui-editor.css?v=20260804-1';

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

/* One promise, shared by every caller, so concurrent opens load once and a
   failure is remembered rather than retried on each keystroke. */
let toastLoad = null;
/* A missing stylesheet is ugly, not fatal, so this never rejects -- holding
   the whole feature back because a CSS file 404'd would turn a cosmetic
   failure into a functional one. */
function injectStyle(href){
  if(document.querySelector(`link[data-notes-css]`)) return;
  const el = document.createElement('link');
  el.rel = 'stylesheet';
  el.href = href;
  el.setAttribute('data-notes-css', '1');
  document.head.appendChild(el);
}
function ensureToast(){
  if(!toastLoad){
    toastLoad = (async () => {
      injectStyle(TOAST_CSS);
      const m = await import(TOAST_MJS);
      const T = m.default || m.Editor;
      if(!T || typeof T.factory !== 'function') throw new Error('toast bundle loaded but exports no Editor');
      return T;
    })();
  }
  return toastLoad;
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
let lastRenderError = null;
export async function renderNoteInto(el, md){
  if(!el) return null;
  const text = md || '';
  try {
    const T = await ensureToast();
    el.innerHTML = '';
    const v = T.factory({ el, viewer: true, initialValue: text, ...TOAST_COMMON });
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
  }
  /* Appended on EVERY open, not just the first. appendChild on an element that
     is already a child moves it to the end, and every .overlay in this app
     shares one z-index -- so DOM order is what decides which of two open
     overlays is on top. The editor is always opened ON TOP of whatever called
     it (Attributes, or the position/notes modal, which builds its own
     document.body overlay the same way), and that is only reliably true if it
     goes last each time. */
  document.body.appendChild(ov);
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
    const T = await ensureToast();
    host.innerHTML = '';
    const ed = T.factory({
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
        toastLoad = Promise.reject(new Error('forced by test'));
        toastLoad.catch(() => {});   // no unhandled rejection
      } else {
        toastLoad = null;
      }
    },
    isLoaded: () => !!toastLoad,
    /* Sets the open editor's content. Toast's editing surface is a ProseMirror
       contenteditable, so typing into it from a test is a fight with an
       implementation detail; what is worth testing is OUR plumbing -- that a
       value put in comes back out through Save. Routes to the textarea in
       fallback mode, so one test body covers both surfaces. */
    setValue: (md) => { if(liveSetValue) liveSetValue(md); return !!liveSetValue; },
    /* The editing surface is mounted and writable. The first open of a session
       imports ~1.1MB, so the bar appears well before the editor does; a test
       that setValue()s on the bar's arrival writes into nothing. */
    isReady: () => !!liveSetValue,
    lastRenderError: () => (lastRenderError && (lastRenderError.message || String(lastRenderError))) || null,
    lastMountError: () => (lastMountError && (lastMountError.message || String(lastMountError))) || null,
    // what the open editor currently holds -- for asserting that reopening on
    // an existing note really loads it rather than starting blank
    getValue: () => {
      if(liveEditor) return liveEditor.getMarkdown();
      const ta = document.getElementById('noteFallbackInput');
      return ta ? ta.value : null;
    },
    isFallback: () => !liveEditor && !!document.getElementById('noteFallbackInput'),
  };
}
