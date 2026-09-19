# Modal Button Bar — specification

**Status: the mechanism is built (`js/modalBar.js`) and twenty-five modals are
converted.** Everything below is the contract; the rollout checklist at the
end tracks which modals actually follow it yet. Update it as each one lands.

## The problem this solves

Buttons are in five different places depending on which modal you opened:

| Convention | Where | Used by |
|---|---|---|
| `.modal-actions` | bottom, right-aligned | ~14 small modals |
| `.assets-editor-actions` | bottom, split left/right | asset editor, object-list editor, surface adjust |
| `.assets-header` | top right | Manage VR Assets, Manage Object Lists |
| `.cp-header` / `.crop-header` | top right | colour picker, crop editor |
| `.mnem-header` / `.quiz-header` | top right | Manage Mnemonics, quizzes |

Several modals have buttons in **both** places at once. **Manage Object Lists
is the worst case and the one that caused real data loss:** its editor has
`Close` in the header and `SAVE` at the bottom of a scrolling body, so if the
list is long enough to scroll, the only button you can see is the one that
throws your edits away.

Two further gaps found while surveying:

- **There is no `:disabled` button styling anywhere in the app.** A disabled
  button currently looks identical to an enabled one.
- **No modal tracks whether it has unsaved changes**, and **no modal handles
  Escape**. Both are new behaviour, not just a re-layout.

## The rule

> Every modal has exactly one button bar. It sits at the **top of the modal**,
> pinned so it never scrolls, with the title on the left and the buttons on
> the right. No modal has buttons anywhere else that close it, commit it, or
> discard it.

## Anatomy

```html
<div class="modal">
  <div class="modal-bar">
    <h2>Edit Object List</h2>
    <div class="modal-bar-state"><!-- "Unsaved changes" when dirty --></div>
    <div class="modal-bar-buttons">
      <button class="mb-destructive">Delete…</button>
      <button class="mb-leave">Done</button>
      <button class="mb-save">Save</button>
    </div>
  </div>
  <div class="modal-body"><!-- everything else; this is what scrolls --></div>
</div>
```

The bar must be pinned by **flex layout**, not `position:sticky`:

```css
.modal        { display:flex; flex-direction:column; }
.modal-bar    { flex:0 0 auto; }
.modal-body   { flex:1 1 auto; overflow:auto; min-height:0; }
```

`min-height:0` is not optional — without it a flex child refuses to shrink
below its content and the modal grows past the viewport instead of scrolling.

Modals that currently put `overflow:auto` on `.modal` itself (`.attr-modal`,
`#colorSwatchPickerOverlay .modal`) must move it to `.modal-body`, or the bar
scrolls away with everything else. `position:sticky` is rejected because it
leaves the bar transparent over scrolling content and needs a background
patch, whereas the flex version is structurally correct.

## Button vocabulary

Three roles. A modal uses the subset it needs, and **never invents a fourth**.

| Role | Label | Does | Present when |
|---|---|---|---|
| **Leave** | `Done` / `Cancel` | Closes the modal | Always |
| **Save** | `Save`, or the action verb | Commits changes **and closes** | Editor and Confirm modals |
| **Destructive** | `Delete…`, `Reset…` | Removes the thing the modal is editing | Where it applies |

**There is deliberately no `Apply`** (commit and stay open). Only a handful of
modals had a meaningful "keep working after committing", and at phone width
every button competes with the title for a bar that must not wrap. If a
specific modal turns out to need it, add it back there rather than to the
vocabulary — a button that is disabled forever in twenty modals to serve one
is worse than the trip through Save and reopen.

The consequence to keep in mind while converting: **Save is the only thing
that commits.** A long editing session in one modal is all-or-nothing, so
validation has to be good enough that Save rarely fails, and the discard
confirm below has to be reliable.

The **Leave** button is one button whose label depends on state, not two
buttons:

- **Clean** (no unsaved changes) → reads **`Done`**, enabled.
- **Dirty** (unsaved changes) → reads **`Cancel`**, enabled.

**The primary may carry its own verb** (`modalBarHtml({ saveLabel })`). Some
modals' primary genuinely isn't a save: Import Variations imports, Search for
a Variation searches, Preview Castle generates. Calling all three `Save` would
be the same vagueness this vocabulary exists to kill. The role, the class, the
position and the colour are unchanged — only the word is, so this is not a
fourth role. Use the plain `Save` unless a specific verb is *more* precise,
and give it a matching `busyLabel` (`Importing…`, not `Saving…`).

Labels are Title Case. Not `SAVE`, not `CLOSE`. The app currently has both
`SAVE` and `Save`, and 18 `Close` against 26 `Cancel` used interchangeably;
that ends here. `Close` as a label is retired entirely — a modal you leave
without losing anything says `Done`.

A destructive button's label ends in `…` when it will ask for confirmation,
which it always should.

## States

| | Leave | Save |
|---|---|---|
| **Clean** | `Done`, enabled, neutral | disabled |
| **Dirty** | `Cancel`, enabled, neutral | enabled, **primary** |
| **Committing** | disabled | disabled, label `Saving…` |
| **Invalid** (dirty but fails validation) | `Cancel`, enabled | disabled, `title` explains why |

**Invalid** matters: a modal with a validation error must not present an
enabled Save that will fail. Disable it and put the reason in the `title`, and
show the error in the body where it belongs.

### Confirm modals are the exception (`kind: 'confirm'`)

A Confirm's primary is a **decision, not a commit**, and that changes two rows
of the table above:

| | Leave | Primary |
|---|---|---|
| **Confirm, any state** | `Cancel`, enabled | **enabled**, primary, its own verb |

- **It is not gated on dirtiness.** You open Preview Castle, agree with the
  street number it filled in for you, and press `Preview` without having
  changed a thing. Under the editor rule that press is impossible. This is
  easy to get wrong and hard to notice, because the modal looks fine — the
  button is simply dead. The test that caught it presses `Preview` on an
  untouched dialog, which is the normal way to use it.
- **Its Leave stays `Cancel` throughout**, because there is always a pending
  decision to decline; `Done` would imply something had been settled.
- **It never asks you to confirm the discard.** Declining *is* the discard,
  and a confirm-on-cancel would just be a second prompt about the prompt.
- **It shows no "Unsaved changes".** Nothing is staged; the pending thing is
  the decision, and the primary button already names it.

Reach for this only when the modal really is a decision. A modal with a field
you must fill in before the action means anything — Import Variations, Search
for a Variation — is an ordinary **Editor** that happens to have a verb on its
primary, and should stay dirty-gated so the button is dead until there is
something to act on.

## Colours

Built on the existing base rule (`button{padding:.35rem .75rem;font-weight:600;
border:1px solid #888;border-radius:4px;background:#f5f5f5}`), which stays as
the neutral style.

| Class | Background | Border | Text | Notes |
|---|---|---|---|---|
| neutral (default) | `#f5f5f5` | `#888` | inherit | Done, Cancel |
| `.mb-save.is-dirty` | `#1565c0` | `#1565c0` | `#fff` | the primary action |
| `.mb-destructive` | `#c62828` | `#c62828` | `#fff` | already the app's red |
| `:disabled` (any) | `#f0f0f0` | `#ccc` | `#aaa` | `opacity:.55; cursor:default` |

Blue `#1565c0` for the primary, not green: the app already reads green
(`#2e7d32`) as "complete / up to date" in the graph lenses and the memorized
state, and a Save button is not a completion state. `#1565c0` is already the
app's selection/action accent.

`.mb-destructive` replaces the four ad-hoc
`style="background:#c62828;color:#fff"` inlines and the one-off
`#assetsDeleteBtn` rule. It is the app's destructive-button styling wherever
such a button lives — three of those four (`Remove color`, `Remove all`,
the picker's own remove) are BODY actions that edit a value rather than
destroying a record, so they keep the look without moving to the bar.

**The clean→dirty transition must be unmissable**, since it is the signal
that something is now at stake — and with `Apply` gone there are only two
buttons carrying it. Both change at once: Save goes from flat grey and
disabled to solid blue and live, and the Leave button's label changes from
`Done` to `Cancel`. Together with the state text below, those three signals
are the whole warning system, so none of them is optional.

## Ordering

Left to right within `.modal-bar-buttons`:

```
[ Destructive ]   ←1.5rem→   [ Leave ]  ←1rem→  [ Save ]
```

- **Save is rightmost.** It is the primary action and the one most often
  wanted.
- **Destructive is leftmost, separated by a `1.5rem` gap** from the rest, so
  it can never be hit by a misjudged click aimed at Leave.
- **`1rem` between Leave and Save**, wider than the usual `.6rem`. With
  `Apply` gone they are adjacent, and they are the two whose consequences
  differ most: one discards the session's work, the other keeps it. That gap
  is doing real work — don't tighten it to line up with other button rows.

## Unsaved-change behaviour

This is the part that prevents the reported failure, and the re-layout alone
does not.

1. **Every editor modal tracks dirtiness.** Dirty means "the staged state
   differs from what is committed" — compare against a snapshot taken when the
   modal opened, not a boolean set by any keystroke, so typing a character and
   deleting it again returns to clean.
2. **`Cancel` on a dirty modal confirms before discarding.** Wording:
   *"Discard your changes to <thing>?"* with `Discard` / `Keep editing`.
   A clean `Done` never confirms — a confirm you see every time is a confirm
   you stop reading.
3. **The bar shows `Unsaved changes` in `.modal-bar-state`** while dirty
   (`#8a6d1f`, `.8rem`). Cheap, and it removes all doubt about which state
   you are in.
4. **Only `Save` clears dirtiness**, and it closes as it does so. There is no
   way to bank progress without leaving, which is the cost of dropping
   `Apply` — see the note under *Button vocabulary*.

## Keyboard

- **Escape** → the Leave button. Clean: closes. Dirty: runs the same confirm.
- **Ctrl/Cmd+Enter** → Save, when Save is enabled. Never when disabled.
- **Enter** inside a single-line text field → Save if the modal has one,
  otherwise nothing. Never Leave.

Escape handling is new — no modal currently has it. **Carve-out:** modals
opened from inside the VR walk set `foreignModalOpen` (see `threeVR.js`), and
VR's own key handler bails while that is set. A modal's Escape handler must be
bound to the modal, not the window, and must `stopPropagation`, so it cannot
also be read as a VR command.

## What does NOT go in the bar

The bar is for **modal lifecycle** only: leaving, committing, and destroying
the thing being edited. Everything else stays in the body where it is, near
what it acts on.

So these stay in the body: the quiz's `Test again (same choices)` /
`Test with new choices`, the quiz's `Give up on this move` /
`Uncertain about next move`, the picker's `Remove color` / `Remove all` (they
edit a value, they do not destroy the record), `Quiz this list`, `Select all`,
`Redirect Selected`, `Import` / `Export`, `Reset size/doors`, wizard `Back` /
`Skip` / `Next`.

A body button that *closes* the modal is the one thing that must be
reconsidered on a case-by-case basis during rollout — either move it to the
bar as the Leave button, or make it not close.

## Modal categories

Not every modal is an editor, and forcing a Save onto a modal that has no
staged state would be worse than what we have now — a Save that is disabled
forever teaches you to ignore the disabled state everywhere else.

| Category | Bar contains | Dirty concept |
|---|---|---|
| **Editor** — stages changes, commits on Save | Leave + Save (+ Destructive) | Yes |
| **Immediate** — every action takes effect at once | Leave only (`Done`) | No, never dirty |
| **Confirm** — a single yes/no decision | Leave (`Cancel`) + the action verb as primary | No — and the primary is **not** dirty-gated; see *States* |
| **Informational** — nothing to change | Leave only (`Done`) | No |
| **Flow** — a multi-step run (quiz, import) | Leave only (`Done`/`Exit`); step buttons stay in the body | No |

An **Immediate** modal must genuinely be immediate. Manage Object Lists' index
is immediate (creating and deleting lists writes straight through); its
**editor** is not, which is exactly why mixing the two conventions in one
overlay caused the bug.

## Rollout

One modal per change, each with a test, converting the highest-risk first.
A modal is done when its buttons are all in the bar, the bar does not scroll,
labels match the vocabulary above, and — for editors — dirty tracking and the
discard confirm work.

Order, worst first:

- [x] **Manage Object Lists** (`#objectListsOverlay` + its editor) — Immediate
      index, Editor sub-view. The reported bug. Also converted the standalone
      **New List** modal (`openNewObjectListModal`), which had the same shape.
      It surfaced something the spec hadn't considered — see *Sub-views*.
- [x] **Manage VR Assets** (`#assetsOverlay` + asset editor) — same shape:
      header Close, `assets-editor-actions` at the bottom with SAVE/Delete.
      Also the standalone **New Asset** modal. Its editor is the first whose
      staged state is SPLIT across module vars (the down-converted image, the
      resolution tier) and live form fields, so `editorSnapshot()` reads both
      and reuses `readTypeFields()` — a field that matters to Save is then
      automatically a field that counts as a change.
- [x] **Attributes** (`#attributesOverlay`, `.attr-modal`) — Editor. First
      with no destructive action, first whose body had to be split out of a
      `.modal` that was scrolling itself, and first to use `validate` (its
      street-number rules are one PREFS scan, cheap enough to run live). Also
      the first with an ASYNCHRONOUSLY-populated field — see below.
- [x] **Manage Mnemonics** (`#mnemonicsOverlay`) + the square editor
      (`#mnemonicsEditorOverlay`) — Immediate + Editor, but in two SEPARATE
      overlays rather than two views of one, so each simply gets its own bar.
      The manager is immediate on its own terms (notes autosave, the grid
      writes through), so a bare `Done` and Export/Import left in the body.
- [x] **Surface Adjust** (`#surfaceAdjustOverlay`) — Editor. Its existing
      `Apply` already meant commit-and-close, so it became `Save` outright;
      `Reset` and `Remove all` stayed in the body (they edit the value, they
      don't destroy a record). One real behaviour change: Save is dead until
      something changes, where `Apply` was pressable on an untouched dialog
      for a no-op write.
- [x] **Room Geometry** (`#roomGeomOverlay`) — Editor + Destructive
      (`Reset Room…`). The first **mixed** modal, and the one that made the
      rule explicit: the size fields, the doors dragged on the plan and the
      make-default checkbox are staged until Save, but the room-name inputs,
      the building-defaults box and the presets box all write straight
      through the moment you touch them. **The snapshot covers the staged
      half only.** Including the write-through controls would arm Save over
      work already on disk, and offer to discard a rename that cannot be
      discarded. `Reset size/doors` stayed in the body — it restores *staged*
      values, so it commits nothing and destroys nothing. `drawPlan()` is the
      choke point (a dragged door fires no `input` event on the overlay), so
      `let barCtl = null` is declared above it and the first draw is guarded.
- [x] **Colour picker / swatch picker / crop editor** — the first bars built
      inside modals a module creates at runtime rather than static markup, so
      `modalBarHtml()` is interpolated straight into the `innerHTML` template
      and the bar is the `.modal`'s literal first child. Three findings:

      - **The swatch picker is Immediate, not an Editor** — this list guessed
        wrong. Nothing in it is staged: clicking any swatch commits that
        colour and closes, and the `Apply` beside the hex field is the same
        immediate commit for the one value you cannot click. So it gets a
        bare `Done`, and its old header `Cancel` was already the wrong word.
        `Apply` and `Remove color` stay in the body; the retired-`Apply` rule
        governs the BAR's vocabulary, not a body button that commits one
        field.
      - **A snapshot does not have to be the staged value — for a large one
        it must not be.** `snap()` runs `JSON.stringify` on every repaint,
        which in the crop editor means every mousemove of a crop-bar drag,
        and its staged value is a multi-megabyte data URL. Its snapshot is a
        cheap *identity* for that value instead: `{ step: historyIndex, sel }`
        — exactly the two things Save would commit. Undoing back to step 0
        with a full rectangle correctly reads clean again, because
        `history[0]` is always the original. **Any editor staging an image,
        a file or a big blob should do the same.**

        The catch that comes with it: an identity has to cover *every* piece
        of pending work, and one was easy to miss. A brush stroke is not
        pushed to the crop editor's history until you leave brush mode, so
        between the first stamp and that commit `historyIndex` reports clean
        over work Save would really have committed — a dead Save, and a
        `Done` that would bin the strokes without a confirm. The snapshot's
        third component (`brushDirty`) exists for exactly that window, and
        `eraseCircle` refreshes the bar once per stroke, on the transition,
        not once per circle stamped along a drag. **When you swap a value for
        an identity, enumerate the uncommitted states, not just the
        committed ones.**
      - **Save being dead when clean is a real behaviour change, not just a
        styling one.** Undo your way back to the original in the crop editor
        and there is nothing to commit, so `Save` greys out and `Done` is the
        way out — it resolves `null`, which callers already treat as "leave
        the image alone", the same net effect the old no-op `SAVE` had. Two
        tests had been reading the *resolved* value to prove undo worked;
        they now probe the editor's live `#cropImg`, which tests undo without
        routing through the save path at all.

      The crop editor's discard confirm is new and the point of converting
      it: the old `Cancel` threw away every erase stroke and crop in the
      session without a word. Its choke points are `paint()` (a dragged crop
      bar) and `updateHistoryButtons()` (every committed mutation and every
      undo/redo); the colour picker's is `paint()`, since a colour is sampled
      by clicking the image and fires no input event.
- [x] **Castle Generate** (`#castleGenOverlay`), **Line** (`#lineOverlay`),
      **Import Line**, **Search Line**, **Field** — the batch that grew the
      mechanism, because it holds the first real **Confirm**.

      - **Preview Castle** is that Confirm, and the reason `kind:'confirm'`
        exists. Its primary is a decision: you agree with the street number
        it filled in and press `Preview` having changed nothing. Under the
        editor rule that press is impossible. See *States* for the full
        shape.
      - **Import Line** and **Search Line** look like Confirms and are not.
        Each has a field you must fill in before the action means anything,
        so they are ordinary Editors that happen to carry a verb on the
        primary (`Import`, `Search`) — and staying dirty-gated is an
        improvement: `IMPORT` used to be pressable on an empty textarea and
        simply raised an error.
      - **Field** (`#fieldOverlay`) is ONE overlay reused for every
        single-field prompt in the app — standard response, mnemonic, branch
        name, street name — with its title rewritten per use. So it is the
        first bar that must **re-take its baseline on every open**
        (`markClean()` after the input is filled), or a value belonging to
        the previous prompt reads as an edit the user just made. It keeps
        the `#fieldModalTitle` id via `prefix:'fieldModal'`.
      - **Line** (`#lineOverlay`) is create-only (renames go through the
        field modal) and `newLineBtn` blanks every field before showing it,
        so one baseline taken at mount stays correct for every open.

      Validation in all five stays press-time with its message in the body,
      not the bar's live `validate`: parsing candidate moves through chess.js
      on every keystroke, or scanning PREFS for a street-number clash on a
      modal that is dismissed far more often than submitted, is not a live
      check.
- [x] **Analysis Queue / Add / Compare** — and **two of the three are
      Confirms, not Immediate** as this list had them. That is now twice the
      checklist has guessed the category wrong (the swatch picker was the
      other), both times in the same direction: **assuming a modal with
      fields in it stages something.**

      "Add to Analysis Queue" and "Analyze Other Replies" both arrive with
      their depth (and line count) pre-filled, and the normal use is to press
      the verb without touching either — which is impossible under the editor
      rule, because a clean modal's primary is dead. The existing tests prove
      it: they press Add and Analyze on untouched dialogs. **The test for the
      Compare confirm had to go BEFORE the fill that follows it**, or a live
      primary would have proved nothing.

      Only the **queue list itself** is Immediate: rows cancel and reorder
      themselves and the thread count applies at once, so a bare `Done`. Its
      `Threads` selector came out of the old header row into the body — a
      setting for the work, not this modal's lifecycle, same call as the
      graph's Reset Layout.

      The rule of thumb this leaves: **pre-filled fields you would normally
      accept mean Confirm; fields you must fill in before the action means
      anything mean Editor.** Import Variations is the Editor side of that
      line, Add to Analysis Queue the Confirm side, and they look nearly
      identical until you ask which one you would press unchanged.
- [x] **Graph**, **Help**, **About**, **Room Info**, **Castle Preview**,
      **Browse Games**, **Transpositions** — Informational or Immediate;
      Done only. Converted as one batch, since the contract is identical for
      all seven: they share a `mountInfoBar()` helper in app.js and one
      `assertInfoBar()` assertion in the tests rather than seven copies of
      each. Four things this batch settled:

      - **`onLeave` is the old close handler, verbatim.** Several do real
        teardown — the graph drops its cytoscape instance and resets its
        lenses, the Transposition report re-raises a toast it suppressed
        while open, Browse Games clears its state. A conversion that
        "just closes the overlay" would have lost all of it.
      - **A body button that closes still isn't the Leave button.** Room
        Info's `Jump to VR` and Castle Preview's `Walk in VR` both close, but
        they leave *for somewhere else*; Leave has to keep meaning "put this
        back the way it was", so they stayed in the body.
      - **A destructive-looking link isn't a Destructive button.** About's
        `Reset to Factory` is a small grey link, findable only if you go
        looking, and About edits nothing for a destructive action to destroy.
        Promoting it to the bar's red slot would advertise it on every visit.
        It stays a body link.
      - **Not every converted modal needs a `.modal-body`.** Five of these
        were already flex columns with their own designated scroller
        (`.help-body`, `.room-info-exits`, `#castleReportBody`,
        `.games-list-body`, `#transpBody`), so the bar just slots in above as
        another non-flexing row. The graph scrolls nothing at all — it is
        full-screen with `overflow:hidden` and a sized `#graphContainer` that
        cytoscape pans inside, so wrapping it would fight that sizing. Only
        **About** needed the split, since it had `overflow:auto` on `.modal`
        itself. `modalBarState` reports `visibleWhenScrolled: null` when
        there is no `.modal-body`, so the shared assertion accepts null and
        only rejects an actual `false`.

      The graph also lost its old header row: `Reset Layout` and
      `Show Castle` are view controls, not lifecycle, so they moved down to
      join the `View` / `Coverage` row in the body.
- [x] **Quizzes** (`#quizOverlay`, `#openingQuizOverlay`) — Flow; bar gets
      `Done` only, all the test-flow buttons stay in the body. The first
      modals where the bar is the same across **every** sub-view, so one bar
      mounted once covers setup, play and summary — unlike the Object Lists
      and Assets managers, whose views want different bars.

      What this batch turned up: **each quiz had TWO ways out that did
      different teardown.** The header's `Close` was the full version; the
      summary's own `Close` / `Exit test mode` were subsets — the mnemonics
      one never cleared the running clock's interval, and the opening one
      skipped `disableMoveInput` and `oqClearHighlights`. Consolidating on
      one bar Leave running the superset closes that gap rather than
      preserving two exits that left different state behind.

      **Generalise it:** when a modal has more than one way out, they are
      worth diffing before you pick which becomes the bar's Leave. The bar
      enforces one exit, which is only an improvement if it is the *complete*
      one. Neither quiz's discrepancy was a reported bug; both were found by
      reading the two handlers side by side during the conversion.

      No discard confirm: a Flow has no dirty concept, and leaving mid-quiz
      loses a score rather than unsaved work (the opening quiz writes its
      grades as it goes, which is what its own undo list is for).
- [ ] **Reset-to-factory warn/confirm**, **Default content** — Confirm.
- [x] **Import Games** (`#downloadOverlay`) — **Confirm**, by the pre-filled
      test above: every field is restored from localStorage on open, which is
      the whole point of it remembering your handles, so the normal use is to
      press `Import Now` unchanged. A first-time user with nothing remembered
      still gets a live primary and the existing press-time "enter a
      username" message in the body.

      It is also **the first converted modal whose action is genuinely
      long-running** — a network fetch per platform plus an indexing pass —
      and the busy state earns its keep there. The old `Cancel` merely hid
      the overlay while the import carried on invisibly, with `logDl` writing
      progress into a hidden element; the bar disables Leave for the
      duration, so you watch it finish. `busyLabel: 'Importing…'` rather than
      the default `Saving…`, which over a minutes-long fetch is the
      difference between a label and an explanation.

      Its auto-import checkbox writes through on tick, which needs no special
      handling here: a Confirm dirty-tracks nothing, so a body control that
      takes effect at once is simply a body control.

- [x] **Import Move Images** (`#importMoveImagesOverlay`) — **Immediate**,
      and the simplest conversion in the whole rollout: dropping or choosing
      files files each one into its square's mnemonic on the spot, so there
      is nothing to commit and a bare `Done`. The drop zone *is* the action
      and stays in the body. No `.modal-body` wrapper either — its results
      list already caps itself at 240px and scrolls on its own, so the modal
      cannot grow past the viewport and the bar cannot scroll away.

      Worth recording: this modal had **no test coverage at all** before the
      conversion — not the bar, not the import. The bar contract is now
      tested; **the import flow itself still is not.**

- [x] **Object-list asset picker** (`#objlistPickOverlay`) — **Immediate**,
      the same shape as the colour swatch picker: clicking an asset card
      commits that pick and closes, so nothing is staged and the bar is a
      bare `Done`. Its old `Cancel` was already the wrong word. `Use word
      only (no image)` and `New Asset…` stay in the body — both are *picks*,
      not ways out; the first commits "no image" exactly as a card commits an
      asset.

      **The rollout's most deeply nested bar, and the one structural lesson
      here:** this is a sub-overlay living *inside* the manager's own modal,
      so its `.objlist-pick-modal` had to take the `modal` class as well.
      Without it, `wireModalBar`'s `closest('.modal')` walks straight past the
      picker and binds Escape onto the **manager's** modal — silently
      clobbering the handler the manager's own bar installed there, because
      that binding is an `onkeydown` assignment rather than a listener.
      Adding the class is safe only because `.objlist-pick-modal` overrides
      every property `.modal` sets and comes later in source order; check
      that before doing the same elsewhere.

      Its markup exists **twice** — once in the manager's shell, once in the
      standalone New List overlay — so the bar is wired through a shared
      `wirePickerBar()` scoped to `containerEl`, not `getElementById`, which
      would find whichever copy landed in the document first.

- [ ] **Perfect Opening** (`#perfectOpeningOverlay`) and its progress panel
      (`#perfectOpeningProgressOverlay`). Added late: these existed in the app
      but were missing from this list, which made the remaining work look
      smaller than it is. Categorise each against the pre-filled-vs-must-fill
      test rather than by its label — that test has now caught three modals
      this list had filed wrong.

`#threeTestOverlay` (the VR walk) is **out of scope**: it is a full-screen
canvas with its own in-world toolbar, not a modal in this sense.

## Sub-views

Learned converting the first modal, and it generalises: **one overlay can hold
several views, and the bar belongs to the view, not the overlay.** Manage
Object Lists holds three — the list index, a list editor, and a running quiz.

Each view's Leave button means "leave THIS view":

| View | Leave | Save | Destructive |
|---|---|---|---|
| index | closes the manager | — | — |
| editor | back to the index (confirms if dirty) | writes, back to the index | `Delete…` |
| quiz | ends the quiz, back where it started | — | — |

The consequence is the good part: **while you are editing there is no
one-click way to close the whole overlay.** You leave the editor first, and
that asks. A single button that can close everything from inside an editor is
exactly the shape of the original bug, so a converted multi-view modal must
not have one.

Two mechanical notes for the next such conversion:

- An editor that **re-renders while editing** (adding a row, reordering)
  re-mounts its bar, and a freshly mounted bar takes the current state as its
  baseline — silently resetting "unsaved" back to clean. Capture the baseline
  when the editor OPENS and hand it back with `rebase()`. `js/objectLists.js`
  does this via `EDIT_BASELINE`.
- Programmatic mutations fire no `input`/`change` event, so the bar's watcher
  never sees them. Call `refresh()` at whatever choke point they all funnel
  through (`renderItems()` there) rather than at each call site.
- **An asynchronously-populated field will make a modal claim changes nobody
  made.** Attributes' redirect select fills in from a lookup, so its baseline
  was taken while that field was still empty — and the moment the saved value
  landed, the modal read dirty and offered a discard confirm on the way out of
  a node you had only looked at. That is precisely the false positive that
  teaches you to click through the confirm that matters. Re-baseline with
  `markClean()` once the field lands, guarded by `touched()` so it can never
  wipe out an edit the user made while the lookup was in flight.
- **The watched element outlives the bar.** A manager's body wrap is built
  once and reused for every open; the standalone New Asset / New List
  overlays are singletons. Bars are re-mounted constantly against them -- an
  editor re-mounts on every item added, and a standalone modal deliberately
  wires a second controller over the one `openEditor` just mounted. So
  `wireModalBar` stores its edit handler on the watched element and removes
  the previous one first. Without that, a long editing session stacked a pair
  of listeners per re-mount, each closing over a dead controller still
  painting a detached bar -- nothing visibly broken, which is exactly why it
  would have sat there growing.

## Testing

`modalBarState(page, overlayId)` in `test/harness.mjs` asserts the contract for
any converted overlay, so each conversion is one call plus its own specifics.
It reports the title, each button's label / disabled / primary state, the
unsaved-changes text, whether the bar is the first thing in the modal, and:

- **`visibleWhenScrolled`** — scrolls the body to the bottom and checks the
  bar is still inside the modal's visible box. This is the one that pins the
  actual bug.
- **`strayIds`** — any Save/Cancel/Close/Done button outside the bar. Buttons
  inside a NESTED overlay (an item picker, say) don't count; they close that
  sub-surface, not this modal.

Per-modal, an editor should also cover: Save starts disabled and Leave reads
`Done`; an edit enables Save, fills it in, and flips Leave to `Cancel`;
**undoing that edit by hand returns both to clean** (which is what pins
dirtiness to a real comparison rather than a keystroke flag); and
Cancel-while-dirty raises the confirm.

Phase M and the object-list / asset phases drive these modals by button id, so
**converting a modal breaks its existing tests** — expected, and those
assertions should move to the bar rather than be worked around.

**Scope every bar selector to its overlay.** `page.click('.modal-bar .mb-save')`
matches the FIRST bar in DOM order, which is not necessarily the modal on top
— and once two modals are converted, stacked ones are normal (the New Asset
modal opens over the object-list item picker, which is over the manager).
A bare selector then clicks the bar UNDERNEATH, leaving the top modal open to
swallow everything after it. Always
`page.click('#thatOverlay .modal-bar .mb-save')`. This cost two debugging
rounds on the second conversion; it will cost more as the stack deepens.

Two things the first conversion hit, both likely to recur:

- The harness **auto-accepts `confirm()`**, so a test that leaves a dirty
  editor silently discards. A test reading a *different* dialog's message must
  leave the editor BEFORE registering its listener, or it captures the discard
  prompt instead.
- A test that opens an editor and immediately clicks Save now does nothing,
  because Save is correctly disabled on a clean editor. Such a test has to
  make a real edit first — which is a better test anyway.

## Open questions

- **Mobile width.** Two buttons plus a title should fit, and three with a
  destructive one probably does too — but `Delete…` plus a long title
  (`Edit Object List`) is the case to check. Likely answer: the title
  truncates with an ellipsis and the buttons never shrink or wrap, since the
  bar not wrapping is the reason `Apply` was dropped. Confirm on a real phone
  during the first conversion rather than guessing now.
- **Does anything actually miss `Apply`?** Dropped on the judgement that
  little would use it. If a long editor (the object-list editor is the
  candidate) turns out to want progress banked mid-session, add it back to
  that one modal only — not to the vocabulary.
