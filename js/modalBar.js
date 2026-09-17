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
   is disabled forever -- see the spec's "Modal categories". */
export function modalBarHtml({ title, save = false, destructive = null, prefix = 'mb' }){
  return `
    <div class="modal-bar">
      <h2 class="modal-bar-title" id="${prefix}Title">${title || ''}</h2>
      <div class="modal-bar-state" id="${prefix}State"></div>
      <div class="modal-bar-buttons">
        ${destructive ? `<button type="button" class="mb-destructive" id="${prefix}Destroy">${destructive}</button>` : ''}
        <button type="button" class="mb-leave" id="${prefix}Leave">Done</button>
        ${save ? `<button type="button" class="mb-save" id="${prefix}Save" disabled>Save</button>` : ''}
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
     thing         name for the discard prompt ("this list")

   Returns a controller: refresh() after any programmatic mutation the watch
   element's events won't catch (adding a row, reordering), setInvalid(msg) to
   hold Save back while validation fails, leave() for Escape. */
export function wireModalBar(barEl, opts){
  const q = sel => barEl.querySelector(sel);
  const leaveBtn = q('.mb-leave');
  const saveBtn = q('.mb-save');
  const destroyBtn = q('.mb-destructive');
  const stateEl = q('.modal-bar-state');

  let baseline = opts.snapshot ? snap(opts.snapshot) : null;
  let invalid = null;
  let busy = false;

  const isDirty = () => !!opts.snapshot && !busy && snap(opts.snapshot) !== baseline;

  function paint(){
    const dirty = isDirty();
    leaveBtn.textContent = dirty ? 'Cancel' : 'Done';
    leaveBtn.disabled = busy;
    if(stateEl) stateEl.textContent = dirty ? 'Unsaved changes' : '';
    if(saveBtn){
      saveBtn.disabled = busy || !dirty || !!invalid;
      saveBtn.classList.toggle('is-dirty', dirty && !invalid && !busy);
      saveBtn.textContent = busy ? 'Saving…' : 'Save';
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
    if(isDirty() && !confirm(`Discard your changes to ${opts.thing || 'this'}?`)) return;
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

  if(opts.watch){
    const onEdit = () => paint();
    opts.watch.addEventListener('input', onEdit);
    opts.watch.addEventListener('change', onEdit);
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
    // re-baseline to the CURRENT state -- for a save that stays on the view
    markClean(){ baseline = opts.snapshot ? snap(opts.snapshot) : null; paint(); },
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
