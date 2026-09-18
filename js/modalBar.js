/* ---------- shared modal button bar ----------

   The implementation of Documents/modal-buttons.md. Read that first; this
   file is the mechanism, the spec is the reasoning.

   The short version: every modal gets ONE button bar, pinned at the top of
   the modal so it never scrolls, title on the left and buttons on the right.
   Two roles plus a destructive one:

     [ Delete… ]  ←1.5rem→  [ Done | Cancel ]  ←1rem→  [ Save ]

   The Leave button is ONE button whose label depends on state -- `Done` when
   there is nothing to lose, `Cancel` when there is. Save is disabled and flat
   until something is actually unsaved, then fills in solid blue. Those two
   changes plus the "Unsaved changes" text are the whole warning system, which
   is why none of them is optional.

   CONFIRM modals (kind:'confirm') are the one exception to all of that: their
   primary is a decision rather than a commit, so it is live from the moment
   the modal opens and can carry its own verb (`Preview`, `Import`). See
   isConfirm below.

   Why this exists at all: buttons used to sit in five different places, and
   several modals had them in two at once -- Manage Object Lists had `Close`
   in the header and `SAVE` at the bottom of a scrolling body, so on a long
   list the only button you could see was the one that threw your edits away.
*/

/* Dirtiness is a COMPARISON against a snapshot taken when the modal opened,
   never a flag set by a keystroke -- so typing a character and deleting it
   again reads as clean, which is what makes "Cancel" trustworthy enough to
   confirm on. JSON is the comparison because every editor's staged state in
   this app is already a plain serializable object. */
function snap(fn){
  try { return JSON.stringify(fn()); }
  catch { return null; }   // never let a bad snapshot break the bar
}

/* The markup. `save` and `destructive` are opt-in: a modal with nothing
   staged (an index, a help page) gets a bare `Done` rather than a Save that
   is disabled forever -- see the spec's "Modal categories".

   `saveLabel` renames the primary button without adding a fourth ROLE. The
   spec's Confirm category asks for "the action verb as primary", and there
   are modals whose primary genuinely isn't a save: Import Variations imports,
   Search for a Variation searches, Preview Castle generates. Calling all
   three `Save` would be the same vagueness the vocabulary exists to kill.
   The role, the class and the position are unchanged -- only the word is. */
export function modalBarHtml({ title, save = false, saveLabel = 'Save', destructive = null, prefix = 'mb' }){
  return `
    <div class="modal-bar">
      <h2 class="modal-bar-title" id="${prefix}Title">${title || ''}</h2>
      <div class="modal-bar-state" id="${prefix}State"></div>
      <div class="modal-bar-buttons">
        ${destructive ? `<button type="button" class="mb-destructive" id="${prefix}Destroy">${destructive}</button>` : ''}
        <button type="button" class="mb-leave" id="${prefix}Leave">Done</button>
        ${save ? `<button type="button" class="mb-save" id="${prefix}Save" disabled>${saveLabel}</button>` : ''}
      </div>
    </div>`;
}

/* Wires a bar rendered from modalBarHtml.

   opts:
     snapshot      () => serializable staged state, or null for a view that
                   can never be dirty (an index, a flow, a help page)
     onLeave       () => void   -- called once it's safe to leave
     onSave        () => void|Promise
     onDestructive () => void
     watch         element whose input/change events mean "something changed"
     validate      optional () => message|null; a message holds Save back and
                   becomes its tooltip
     thing         name for the discard prompt ("this list")
     kind          'editor' (default) or 'confirm' -- see below
     saveLabel     must match the one passed to modalBarHtml
     busyLabel     shown while onSave runs (default 'Saving…')

   Returns a controller: refresh() after any programmatic mutation the watch
   element's events won't catch (adding a row, reordering), setInvalid(msg) to
   hold Save back while validation fails, leave() for Escape. */
export function wireModalBar(barEl, opts){
  const q = sel => barEl.querySelector(sel);
  const leaveBtn = q('.mb-leave');
  const saveBtn = q('.mb-save');
  const destroyBtn = q('.mb-destructive');
  const stateEl = q('.modal-bar-state');

  /* A CONFIRM modal is a decision, not an edit, and that changes two things.

     Its primary is not gated on dirtiness: you open Preview Castle, agree
     with every default it filled in, and press Preview. Under the editor
     rule that press is impossible, because nothing changed. So a confirm's
     primary is live whenever validation passes.

     And its Leave stays `Cancel` throughout, because there is always a
     pending decision to decline -- `Done` would imply something was settled.
     For the same reason it never asks you to confirm the discard: declining
     IS the discard, and a confirm-on-cancel would just be a second prompt
     about the prompt. */
  const isConfirm = opts.kind === 'confirm';
  const saveLabel = opts.saveLabel || 'Save';
  const busyLabel = opts.busyLabel || 'Saving…';

  let baseline = opts.snapshot ? snap(opts.snapshot) : null;
  let invalid = null;
  let busy = false;
  // has the user touched anything in here yet? Only used to make a LATE
  // re-baseline safe -- a modal with an asynchronously-populated field wants
  // to re-take its baseline once that field lands, but must not do so over
  // an edit the user already made in the meantime.
  let touched = false;

  const isDirty = () => !!opts.snapshot && !busy && snap(opts.snapshot) !== baseline;

  function paint(){
    // Re-checked on every repaint, so Save is never live when it would fail:
    // the spec's "Invalid" state. Runs on each keystroke, so a validate() must
    // be cheap -- an expensive check belongs at save time with its error in
    // the body instead.
    if(opts.validate) invalid = opts.validate() || null;
    const dirty = isDirty();
    leaveBtn.textContent = (isConfirm || dirty) ? 'Cancel' : 'Done';
    leaveBtn.disabled = busy;
    // a confirm has nothing staged to be "unsaved" -- the pending thing is
    // the decision itself, and the primary button already says what it is
    if(stateEl) stateEl.textContent = (dirty && !isConfirm) ? 'Unsaved changes' : '';
    if(saveBtn){
      const live = isConfirm ? true : dirty;
      saveBtn.disabled = busy || !live || !!invalid;
      saveBtn.classList.toggle('is-dirty', live && !invalid && !busy);
      saveBtn.textContent = busy ? busyLabel : saveLabel;
      // a Save you can't use says why, rather than looking broken
      if(invalid) saveBtn.title = invalid; else saveBtn.removeAttribute('title');
    }
    if(destroyBtn) destroyBtn.disabled = busy;
  }

  /* Leaving with unsaved work confirms; leaving with nothing to lose never
     does. A confirm you see every time is a confirm you stop reading, and
     this one has to still be worth reading the day it matters. */
  function leave(){
    if(busy) return;
    // a confirm's Cancel IS the discard -- see isConfirm above
    if(!isConfirm && isDirty() && !confirm(`Discard your changes to ${opts.thing || 'this'}?`)) return;
    opts.onLeave && opts.onLeave();
  }

  leaveBtn.onclick = leave;
  if(saveBtn) saveBtn.onclick = async () => {
    if(saveBtn.disabled) return;
    busy = true; paint();
    try { await opts.onSave(); }
    finally { busy = false; paint(); }
  };
  if(destroyBtn) destroyBtn.onclick = () => { if(!busy) opts.onDestructive && opts.onDestructive(); };

  /* One live edit-watcher per watched element, ever.

     Both the elements bars get watched are PERSISTENT: a manager's body wrap
     is built once and reused for every open, and the standalone New Asset /
     New List overlays are singletons (`getElementById(id) || createElement`).
     Bars, meanwhile, are re-mounted constantly -- an editor re-renders on
     every item added or reordered, and the standalone modals deliberately
     wire a second controller over the one openEditor just mounted, to
     re-point Leave/Save at their promise.

     Without removing the previous handler first, every one of those stacked
     another pair of listeners on an element that outlives them all, each
     closing over a dead controller that goes on painting a bar detached from
     the document. Nothing visibly broke, which is exactly why it would have
     sat there growing. Same store-and-remove shape objectLists.js already
     uses for wireBackdropClose, and for the same reason. */
  if(opts.watch){
    const w = opts.watch;
    if(w._modalBarOnEdit){
      w.removeEventListener('input', w._modalBarOnEdit);
      w.removeEventListener('change', w._modalBarOnEdit);
    }
    w._modalBarOnEdit = () => { touched = true; paint(); };
    w.addEventListener('input', w._modalBarOnEdit);
    w.addEventListener('change', w._modalBarOnEdit);
  }

  /* Escape is the Leave button, including its confirm. Bound to the bar's own
     modal rather than the window, and stopped there: modals opened from
     inside the VR walk would otherwise have their Escape read as a VR command
     too (threeVR.js's own key handler). */
  const modalEl = barEl.closest('.modal') || barEl.parentElement;
  if(modalEl){
    modalEl.onkeydown = (e) => {
      if(e.key === 'Escape'){ e.stopPropagation(); e.preventDefault(); leave(); }
      else if(e.key === 'Enter' && (e.ctrlKey || e.metaKey) && saveBtn && !saveBtn.disabled){
        e.stopPropagation(); e.preventDefault(); saveBtn.click();
      }
    };
    if(!modalEl.hasAttribute('tabindex')) modalEl.setAttribute('tabindex', '-1');
  }

  paint();
  return {
    refresh: paint,
    leave,
    isDirty,
    // re-baseline to the CURRENT state -- for a save that stays on the view,
    // or for a modal whose async field has only just finished populating
    markClean(){ baseline = opts.snapshot ? snap(opts.snapshot) : null; touched = false; paint(); },
    // false until the user has actually typed/picked something. See `touched`.
    touched: () => touched,
    /* re-baseline to a state captured elsewhere. Needed by any editor that
       re-renders (and so re-mounts its bar) while editing: without it, every
       re-render would take the current, already-dirty state as the new
       baseline and silently reset the bar to clean. Pass the JSON.stringify
       of the staged object as it stood when the editor OPENED. */
    rebase(json){ baseline = json; paint(); },
    setInvalid(msg){ invalid = msg || null; paint(); },
    setTitle(t){ const el = q('.modal-bar-title'); if(el) el.textContent = t; },
  };
}
