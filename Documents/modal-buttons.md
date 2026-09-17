# Modal Button Bar — specification

**Status: proposed. Nothing below is implemented yet.** This is the contract
to build against, then to convert existing modals to one at a time. Update the
rollout checklist at the end as each one lands.

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
| **Save** | `Save` | Commits changes **and closes** | Editor modals |
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
`#assetsDeleteBtn` rule.

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
| **Confirm** — a single yes/no decision | Leave (`Cancel`) + the action verb as primary | No |
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

- [ ] **Manage Object Lists** (`#objectListsOverlay` + its editor) — Immediate
      index, Editor sub-view. The reported bug.
- [ ] **Manage VR Assets** (`#assetsOverlay` + asset editor) — same shape:
      header Close, `assets-editor-actions` at the bottom with SAVE/Delete.
- [ ] **Attributes** (`#attributesOverlay`, `.attr-modal`) — Editor, and
      currently `overflow:auto` on the modal itself.
- [ ] **Manage Mnemonics** (`#mnemonicsOverlay`) + the square editor
      (`#mnemonicsEditorOverlay`) — Immediate + Editor.
- [ ] **Surface Adjust** (`#surfaceAdjustOverlay`) — Editor. Its existing
      `Apply` already means commit-and-close, so it becomes `Save` outright;
      `Reset` and `Remove all` stay in the body (they edit the value, they
      don't destroy a record).
- [ ] **Room Geometry** (`#roomGeomOverlay`) — Editor + Destructive
      (`Reset Room…`).
- [ ] **Colour picker / swatch picker / crop editor** — Editor.
- [ ] **Castle Generate** (`#castleGenOverlay`), **Line** (`#lineOverlay`),
      **Import Line**, **Search Line**, **Field** — Editor or Confirm.
- [ ] **Analysis Queue / Add / Compare** — Immediate.
- [ ] **Graph**, **Help**, **About**, **Room Info**, **Castle Report**,
      **Games List**, **Transpositions** — Informational or Immediate;
      Done only.
- [ ] **Quizzes** (`#quizOverlay`, `#openingQuizOverlay`) — Flow; bar gets
      `Done` only, all the test-flow buttons stay in the body.
- [ ] **Reset-to-factory warn/confirm**, **Default content** — Confirm.

`#threeTestOverlay` (the VR walk) is **out of scope**: it is a full-screen
canvas with its own in-world toolbar, not a modal in this sense.

## Testing

Add one shared helper to `test/harness.mjs` that asserts the contract for a
given overlay id, so each conversion is one call plus its own specifics:

- the bar exists, is the first child of `.modal`, and contains every button
  that closes or commits;
- with the body scrolled to the bottom, the bar is still within the modal's
  visible box;
- for editors: Save starts disabled and the Leave button reads `Done`; a
  representative edit enables Save and flips the label to `Cancel`; reverting
  that edit by hand returns both to clean (which is what pins dirtiness to a
  real comparison rather than a keystroke flag); Cancel-while-dirty raises the
  confirm, and confirming it actually discards.

Phase M and the object-list / asset phases already drive these modals by
button id, so **converting a modal will break its existing tests** — that is
expected, and those assertions should be updated to the new ids rather than
worked around.

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
