# Notes — design and phasing plan

**Status: Phases 1-3 built. Phases 4-5 designed.**

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
| VR | the position/notes modal, which lives in `app.js` and commits directly |

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

The plan was an `onNoteSave(seq, md)` callback. It turned out not to be needed:
the **whole position/notes modal** lives in `app.js` (Phase 3), so VR's entire
share of the feature is handing a pair's seq outward through one `threeOpts`
callback and letting `app.js` do the rest. Fewer moving parts, same property.

## The Attributes textarea goes away

`#attrNote` is replaced by a rendered preview plus an **`Edit note…`** button
that opens the same editor. One editor over one field, which removes any
question of a plain textarea mangling structure, and any need to stop two
editors being open at once.

`attrSnapshot` keeps the note — staged, not committed — so dirty tracking and
the discard prompt keep working unchanged.

---

# Toast UI Editor is SELF-HOSTED, unlike every other library here

This is the one dependency the app serves from its own origin (`js/vendor/`,
built by `test/build-vendor.mjs`). That was not the plan — the plan was a CDN
with a vendored copy for tests, like everything else. **Three findings forced
it, each costing a test run**, and they are worth recording because the next
person to add a browser library here will hit at least the first:

1. **`@toast-ui/editor`'s npm `dist/toastui-editor.js` is not a browser
   bundle.** Its UMD browser path passes `root[undefined]` for all eight of its
   externals, so ProseMirror arrives `undefined` and the script dies on
   `PluginKey` without ever defining its global. `<script src=…>` can never
   work. The symptom is maximally unhelpful: the script's `onload` fires
   normally and the global is simply missing.
2. **The viewer and editor dist files publish different shapes under the same
   `toastui.Editor` global.** The editor class has a static `.factory()`; the
   viewer global *is* the Viewer class and has none. Code written against one
   fails against the other with `T.factory is not a function`.
3. **Toast's working standalone build (`toastui-editor-all`) is not in the npm
   package at all.** It exists only on their own CDN, which the test sandbox
   cannot reach — so it could not have been vendored even if we wanted it.

Vendoring a self-built bundle for tests while production loaded a *different*
artifact from a CDN would mean the tested path and the shipped path were never
the same file. That is the exact gap that let the asset manager ship with no
way out. Serving one bundle from our own origin makes them identical, removes
the CDN as a failure mode, and needs no harness interception at all.

It is built with esbuild from the package's ESM entry, which inlines the
dependencies and gives a clean default export — the same treatment
`build-vendor.mjs` already applies to `cytoscape-dagre`.

## One bundle, not two

The original plan split the viewer (433KB) from the editor (940KB) to keep the
render-only path light. That is gone. Finding 2 was a direct consequence of
running two artifacts, and with the row showing a **glyph** rather than
rendered text, nothing on the default path renders a note anyway — so the
split was buying a saving on a path that does not exist. `Editor.factory({viewer:true})`
serves both roles from one ~1.1MB file.

**Still lazy**: dynamically imported on first use, never at boot.

## The fallback stays

A self-hosted file should always load, so the textarea fallback is now
belt-and-braces rather than load-bearing. It costs three lines and it means a
feature that degrades instead of breaking. Keep it.

## Sanitize, always

Rendering a note means generating HTML from user text. Toast's viewer sanitizes
(DOMPurify) by default. **Rely on that; never hand raw converted output to
`innerHTML`.** The plain-text fallback uses `textContent` for the same reason.
Notes are local and single-user, but a note can arrive from a restored backup,
which is not necessarily a file this browser wrote.

---

# What the VR side actually requires

Five findings from the code that shape the implementation more than the spec
does. The fourth was found by a failing test, not by reading.

## 1. The move-pair billboard does not know which move it is

`pairFor` (`js/app.js`) had `node.seq` in hand and **dropped it** — the pair
carried only rendered move text (`opponent`, `response`, quality, disambig), so
a VR sprite could not resolve to a pref at all.

The same shape of gap `moveCount` was before the grade log: the information
exists at build time and was discarded on the way out. Fixed in Phase 1;
everything else here depends on it.

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

## 4. The ANCHOR pair is on the door, not in the room

Found by a failing test rather than by reading: `buildRoom` skips a room's
centre/anchor move-pair slot entirely (`slot.side === 'center' && !room.entryNoStreet`).
That pair lives on the **door leading into the room**, drawn from the parent
(`buildDoorPair`); only the left/right run pairs line the walls.

This has a consequence for Phase 4 that is easy to miss: the room's *own* move
pair — the one a note about "this position" most obviously belongs to — is a
**door billboard**, and door pairs are built by `pairFromSeq`, which
deliberately carries no seq because its own sequence is edge-specific.

So the pair icon cannot simply ride on `userData.pairSeq` for every pair. Door
billboards need the **destination room's canonical seq** attached instead, which
is available where the edge is built (`addEdge` knows `destRoom`) but is not
threaded today. That is a Phase 4 task, not a Phase 1 one, but it is a second
threading job rather than a detail — worth knowing before estimating it.

## 5. The dead-end sign already renders in walk mode

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
the text comes out of the strip entirely and is replaced by **a note glyph on
the row**: there is a note here, click to read or edit it.

Showing a truncated first line was the other option and is worse. A truncation
length is a number nobody can pick correctly, the first line of a Markdown
document is often a heading rather than a summary, and a half-sentence invites
reading the strip instead of the note. A glyph says the one thing the strip can
usefully say.

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

Being *on* `document.body` is only half of it: with one shared `z-index`, DOM
order decides which of the two is on top, so both re-append themselves on every
open. See Phase 3.

---

# Phasing plan

Each phase is independently useful and independently testable. The riskiest 3D
work lands last, after the modal it opens already works.

## Phase 1 — thread the sequence ✅ BUILT

`pairFor` carries the pair's `seq` through `genRooms[].pairs[]` →
`DEMO_MNEMONICS[roomKey].pairs` → `mnemPairLayout` → `sprite.userData.pairSeq`.
No UI.

**`pairFromSeq` deliberately does not.** Its seq is edge-specific — that is the
point of it, so transposition doors each show their own last move — which makes
it unusable as a note key: two doors into one room would resolve to two prefs
for a position that has one note. A door pair needing a note must resolve
through its destination room's own pair.

The thing that made this cheap: **the seq `pairFor` already has is the canonical
one.** `node` is a castle-graph room, the graph dedupes by position, and
`canonicalRoomSeq` resolves to exactly that value through a `buildCastleGraph`
call with the same arguments. So the VR gets the move table's key for free —
which matters twice, because `canonicalRoomSeq` builds a whole castle graph per
call (far too expensive per pair) and reads the `CURRENT_LINE` global, which is
the move table's open line rather than whichever line the VR is walking.

Three tests (phase EM): the two move orders really do transpose to one key; a
billboard's seq survives into the scene (checked at the layout AND on the built
sprite, since those fail differently); and the payoff — **a note written under
the move table's key is found by a DIRECT lookup with the seq the VR carries**,
no re-canonicalising, whichever order the graph happened to walk first.

One cost worth knowing: `pairs` ride in `builtCastlesCacheV2`, so every pair now
stores its sequence there. The cache is derived, excluded from backups, and
stamped with `BUILD_TAG`, so the bump that ships this invalidates it — no stale
shape to migrate.

Independently useful beyond notes: any future per-pair feature needs this.

## Phase 2 — the editor, and the move-table surfaces

`openNoteEditor()` as a promise-returning component with the textarea fallback;
Toast vendored and split viewer/editor; the `Notes…` menu item; Attributes
converted from textarea to preview + launcher; `breaks: true` rendering; meta-row
truncation.

**Ships real value with no VR work at all** — this alone gives formatted,
multi-line notes everywhere they exist today.

## Phase 3 — the position/notes modal ✅ BUILT

`openPositionNote(seq, { lineId, flip })` in `js/app.js`: the board at that
pair's position, the note rendered beside it, a pencil, and a bare `Done`.
Opened from a **test hook**, so the modal was proven before any in-world
affordance existed to open it — the same reasoning that put
`buildReviewForecast` ahead of its renderer: all the risk in one testable unit.

Three things it settled that the design had left open:

- **It takes the pair's own seq and does not re-canonicalise it.** The seq
  Phase 1 threaded onto the sprite is already canonical (see `pairFor`), and
  running it back through `canonicalRoomSeq` would rebuild a whole castle graph
  per open *and* read `CURRENT_LINE`. The note's key is one ply back,
  `seq.slice(0,-1)` — the move table row's own key.
- **`lineId` and `flip` are parameters, not globals.** The main world walks
  every line's castles at once, so a note opened from someone else's castle
  must be written onto *that* line. `savePrefField` grew a lineId-explicit form
  (`savePrefFieldOn`) for exactly this; the old spelling is a one-line wrapper
  and no existing call site moved. Both parameters default to the move table's
  open line, which is right for every non-VR caller.
- **Overlay stacking is DOM order, not z-index.** Every `.overlay` in this app
  is `z-index:20`, so two overlays built lazily on `document.body` stack by
  whichever was *created* first — which is not the same as whichever was
  *opened* last. Both this modal and the editor now re-`appendChild` themselves
  on every open, which makes "the editor opens on top of its caller" true by
  construction rather than by luck. Without it, opening the editor from
  Attributes early in a session and the position modal later would have buried
  the editor.

Five tests (phase EN3, 419–423): the board is the right position the right way
up and the caption names the pair in notation; the modal renders the **move
table's own note** for that position; the pencil commits directly (no enclosing
Save) and the modal repaints in place; a position with no note still opens and
says so; and the orientation really is a parameter.

## Phase 4 — the in-world pair icon

Proximity and angle gating, per-frame corner placement, walk-click handling
**ordered ahead of the door-trigger fallback**, and the note-exists glyph.

Also the second threading job finding 4 describes: door billboards carry their
DESTINATION room's canonical seq, so the anchor pair — which renders on the door
rather than on a wall — can carry a note like any other.

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
- **The pair icon appears whenever the pair appears.** It follows its
  billboard, which means it is absent with hints off — self-test mode hides the
  move billboards, so there is nothing for it to anchor to and nothing it could
  usefully label. The dead-end scroll is unaffected: it hangs on a wall, not on
  a hidden sprite.
- **The move table shows a note GLYPH, not truncated text.** See the move-table
  surface above.

# Open questions

- **Truncation length** in the meta strip, and whether it renders inline
  Markdown (bold, code) or strips to plain text. Plain is simpler and probably
  right for one line.
(none outstanding)
