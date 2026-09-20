# Notes — design and phasing plan

**Status: designed, nothing built. Phase 1 is the enabling change.**

## What it is for

Today a note is a few sentences of unformatted text on a move, reachable only
through the move table's three-dot **Set Attributes** modal, and shown back as
a single escaped line in the row's meta strip.

This makes it a real document: **Markdown, multi-line, WYSIWYG-editable, and
readable in the VR next to the position it describes.** The cases that motivate
it are notes that are worth more than a sentence — a threat to watch for, the
plan for both sides in this structure, how the game tends to continue once the
prepared line runs out.

The last of those is why the VR half matters. A note about "what happens from
here" is nearly useless in a table and genuinely useful standing at the end of
a line looking at the board.

## What it is NOT

Not a new data store, not a second note field, and not a second editor. One
note per position, one place it is edited, reachable from three surfaces.

---

# Storage and identity

## The field is unchanged

Notes stay on the pref's existing `note` field. No new store, no new key, **no
backup change** — prefs are already copied field-by-field into a backup with a
drift test (phase BGx, test 302) guarding exactly that. Adding a store here
would be work for nothing.

## A note belongs to a POSITION, not a path

The move table reads notes through `canonicalRoomSeq(seq)` (`js/app.js`), which
resolves a row's sequence to the castle graph's canonical representative for the
resulting *position*. Two transposing rows therefore share one note.

**The VR must resolve the same note the move table does.** That is a decision,
not an accident of implementation: a note describes a position, and reaching
that position by a different move order does not make it a different note. VR
room keys are already position-derived (`positionKey(fenForSeq(...))`), so the
two should agree naturally — but "should" is not "does", and there is a test for
it in Phase 1 rather than an assumption.

## Every note is Markdown, rendered with `breaks: true`

No format flag and no migration pass. The one thing that makes this safe is GFM
line breaks: **without `breaks: true`, an existing multi-line plain-text note
collapses into a single paragraph** and silently changes appearance for every
note the user has already written. With it, every existing note renders exactly
as it reads today, and new ones get the full formatting vocabulary.

---

# The editor is a component, not a self-saving modal

`openNoteEditor(markdown) -> Promise<string|null>` — it returns a value and
commits nothing. The caller decides what to do with the result:

| Opened from | Commits by |
|---|---|
| Three-dot **Notes…** | writing the pref directly |
| **Set Attributes** | staging into the modal, committed by its own Save |
| VR | a `threeOpts.onNoteSave(seq, md)` callback into `app.js` |

**This is the part not to get wrong.** `attrSnapshot` includes the note, and the
Attributes modal commits everything on one Save (`Documents/modal-buttons.md` —
it is an Editor). If a Notes modal wrote through independently while Attributes
was open, that snapshot would go stale, and Attributes' **Cancel could then
revert a note saved elsewhere**. That is a live data-loss path, and returning a
value instead of writing one closes it by construction.

It also matches the promise-returning sub-modal precedent already in this
codebase: `cropImage`, `openNewAssetModal`, the object-list asset picker.

VR does **not** touch `PREFS` directly — it does not today, and
`threeOpts.onRoomRename` is the established pattern for writing a pref back out
of the walk.

## The Attributes textarea goes away

`#attrNote` is replaced by a rendered preview plus an **`Edit note…`** button
that opens the same editor. One editor over one field, which removes any
question of a plain textarea mangling structure, and any need to stop two
editors being open at once.

`attrSnapshot` keeps the note — staged, not committed — so dirty tracking and
the discard prompt keep working unchanged.

---

# Toast UI Editor: split the viewer from the editor

The honest cost, stated up front: **it is roughly 1MB, and it is a new CDN
dependency.** `test/build-vendor.mjs` vendors every CDN library so the offline
harness can boot, so it has to be added to that `VERSIONS` map and vendored, or
the whole test suite stops working.

Two things make that acceptable rather than merely survivable:

**Ship the viewer and the editor separately.** Rendering is needed on every
surface — the move table's preview, the VR note panel — but *editing* is needed
only after the pencil is clicked. Toast publishes `toastui-editor-viewer` as its
own, much smaller bundle. Load the viewer with the app; load the editor lazily,
on first pencil click.

**Lazy loading means this degrades where the existing CDN deps do not.** three.js
and cytoscape failing to load stops the app booting. A failed editor load can
fall back to a plain textarea over the raw Markdown — the feature gets worse, and
nothing breaks. That is a strictly better posture than the app's current one.

## Sanitize, always

Rendering a note means generating HTML from user text. Toast's viewer sanitizes
(DOMPurify) by default. **Rely on that; never hand raw converted output to
`innerHTML`.** Notes are local and single-user, but a note can arrive from a
restored backup, which is not necessarily a file this browser wrote.

---

# What the VR side actually requires

Four findings from the code that shape the implementation more than the spec
does.

## 1. The move-pair billboard does not know which move it is

`pairFor` (`js/app.js`) has `node.seq` in hand and **drops it** — the pair
carries only rendered move text (`opponent`, `response`, quality, disambig).
`pairFromSeq` does the same for edge-specific pairs. So today a VR sprite cannot
resolve to a pref at all.

This is the same shape of gap `moveCount` was before the grade log: the
information exists at build time and is discarded on the way out. Threading it
is Phase 1, and everything else depends on it.

## 2. The billboard is a camera-facing Sprite

`placeMnemonicSlot` builds a `THREE.Sprite` whose texture is a canvas
(`buildMnemPairSprite` / `renderMnemPairCanvas`). It always faces the camera,
which is what leaves the upper-right corner reliably blank — but it also means
**"the upper-right corner of the rectangle" is screen-relative, not
world-relative.**

The icon's position has to be recomputed every frame:

    iconPos = pairPos + camRight * (w/2 - pad) + camUp * (h/2 - pad)

`tick()` already runs a per-frame billboard loop, so there is a home for this,
but the icon cannot be a static child object of the sprite.

## 3. Walk mode has almost no click surface, and its fallback is greedy

`handleWalkClick` handles exactly two things: elevator floor panels, and a
**catch-all door-trigger fallback** that teleports you on any click whose world
point lands inside a door's trigger box — deliberately with no facing
requirement.

**A note icon near a doorway would be swallowed by that fallback.** The icon
must be hit-tested *before* the door check, not after. This is the single most
likely bug in the whole feature.

## 4. The dead-end sign already renders in walk mode

`buildNoContinuationIcon` is drawn for a room with no forward exit; only the
edit-mode `buildDeadEndMarker` is gated on `editMode`. So the scroll beside it
is a wall-mounted **Mesh** at a known wall and offset — easier to place and
easier to raycast than a sprite.

**Two-track rooms dead-end per lane** and get two signs, one centered in each
half of the north wall (`room.deadTracks`). Each lane needs its own scroll,
resolving to its own lane's last pair. A single-scroll implementation will look
correct until the first divided room.

---

# The three surfaces

## Move table

A new **`Notes…`** item in the three-dot menu, opening the editor directly.

The row's meta strip currently renders the note escaped, inline, on one line —
in **two** renderers (`refreshMeta`, twice). Multi-line Markdown breaks that, so
it becomes a truncated first line plus a note glyph that opens the editor. This
is a consequence of going multi-line that is easy to overlook until it looks
wrong.

## The VR pair icon

Per frame, for each pair sprite: show the icon when **distance ≤ 2 m** and the
angle between the camera's forward vector and the direction to the sprite is
**≤ 30°**. A room holds at most a handful of pairs, so this is a distance check
and a dot product per pair per frame — negligible beside what `tick()` already
does.

Clicking it opens the **position/notes modal**: the board at that pair's
position (`fenForSeq`), the note rendered to its right, and a pencil.

**Beyond the original spec: a distinct glyph when a note exists.** The icon
opens the position whether or not there is a note, which is right — but without
a visual difference you would have to click every pair to find out which ones
have anything to read. Notes that cannot be found are notes that do not get
read.

## The VR dead-end scroll

A scroll icon on the wall beside the "no continuation" sign, shown only when the
lane's last move pair has a note. Clicking it opens the same position/notes
modal.

Worth being deliberate about: **the scroll and that pair's own chessboard icon
open the same note.** There is no separate end-of-line note field. The scroll is
a *discoverability* affordance — "there is something to read at the end of this
line", visible from across the room — not a second datum.

## Modal layering

The position/notes modal and the editor both build their overlay on
`document.body`, the same pattern the room-geometry dialog and the asset picker
use, so they layer above the VR modal regardless of which container hosts the
canvas. `setForeignModalOpen(true)` while either is open, so VR key handling
does not read keystrokes meant for the editor.

---

# Phasing plan

Each phase is independently useful and independently testable. The riskiest 3D
work lands last, after the modal it opens already works.

## Phase 1 — thread the sequence

`pairFor` and `pairFromSeq` carry the pair's `seq` through `genRooms[].pairs[]`
→ `DEMO_MNEMONICS[roomKey].pairs` → `mnemPairLayout` → the sprite's `userData`.
No UI.

Tests: a pair's seq survives the trip into the scene, and — the one that matters
— **a transposing row resolves to the same note in the VR as in the move table**,
through `canonicalRoomSeq`. That is the decision above, pinned rather than
assumed.

Independently useful beyond notes: any future per-pair feature needs this, and
the grade and quiz logs could reference specific pairs with it.

## Phase 2 — the editor, and the move-table surfaces

`openNoteEditor()` as a promise-returning component with the textarea fallback;
Toast vendored and split viewer/editor; the `Notes…` menu item; Attributes
converted from textarea to preview + launcher; `breaks: true` rendering; meta-row
truncation.

**Ships real value with no VR work at all** — this alone gives formatted,
multi-line notes everywhere they exist today.

## Phase 3 — the position/notes modal

Board + rendered note + pencil, opened from a **test hook first**, so the modal
is proven before any in-world affordance exists to open it. Same reasoning that
put `buildReviewForecast` ahead of its renderer: all the risk in one testable
unit.

## Phase 4 — the in-world pair icon

Proximity and angle gating, per-frame corner placement, walk-click handling
**ordered ahead of the door-trigger fallback**, and the note-exists glyph.

Tests drive the camera to known positions and assert icon visibility, the same
way the gizmo tests already drive the editor.

## Phase 5 — the dead-end scroll

Wall-mounted beside the no-continuation sign, two-track aware, resolving each
lane's own last pair.

---

# Decisions already made

- **The VR resolves the same note as the move table** — via `canonicalRoomSeq`,
  tested in Phase 1.
- **The Attributes textarea goes away**, replaced by a preview and a launcher.
  One editor over one field.

# Open questions

- **Truncation length** in the meta strip, and whether it renders inline
  Markdown (bold, code) or strips to plain text. Plain is simpler and probably
  right for one line.
- **Whether the pair icon should appear with hints off.** Hints off is
  self-test mode, where the move billboards themselves are hidden
  (`placeMnemonicSlot` is gated on `hintsOn`) — so there may be nothing to
  anchor the icon to. Likely answer: the pair icon follows its billboard and
  disappears, while the dead-end scroll stays, since it is on a wall rather
  than on a hidden sprite.
