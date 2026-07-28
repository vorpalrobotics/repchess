# Alternate Standard Replies

Design exploration for supporting **more than one standard response** to a single
opponent move. Read alongside `CastleDataModel.md` (position-keyed persistence),
`CastleBuildingNotes.md` (castle/graph generation), and
`LinearSequencesAndRoomObjects.md` (the move-pair ↔ room-object model the VR uses).

Status: **exploration only — not built, no code written.** This captures the
intersection points with the current code and the open decisions, so the work
can be scoped and phased later.

---

## Concept

Today the repertoire assumes **one opponent move → exactly one reply → one
resulting position**. `pref.reply` is a single move string, and it is the pivot
that defines what "answered/built" means, generates the child position that
becomes a castle room, is the single correct quiz answer, and supplies the "our
move" half of every VR move-pair billboard.

The goal is to let a single opponent move carry **several standard replies that
are played situationally**. For example, against one opponent try you might keep
both a *drawish* line and a *sharper* line: in a tournament where a safe draw
secures a prize you take the solid one; when you need a win you take the sharp
one. Both are genuinely part of the repertoire and both must be memorized — this
is **not** "either move is equally fine and interchangeable," and it is **not** a
primary-plus-fallback ranking. Each alternate is a first-class, independently
studied line.

### Situational characterization

Because the choice between alternates is situational, each alternate reply likely
wants a short **characterization** the user assigns — e.g. "solid / drawish",
"sharp / must-win", "avoids theory". This is new metadata with no analog today
(the single `reply` needs no label because there's nothing to choose between). It
would surface in the tree, the digraph edge, and (per the ladder metaphor below)
as a rung label in VR.

---

## VR representation: ladders

In the Holder memory-palace tradition, alternate moves are represented as
**ladders**, and that maps onto this VR cleanly — importantly, a ladder is a
*vertical* branch at one floor location, so it does **not** consume scarce
back-wall door space (the same constraint that makes a second back door for a
two-parent transposition room impractical — see `CastleDataModel.md`).

Proposed:

- An opponent move with a **single** reply stays an ordinary door (unchanged).
- An opponent move with **alternate** replies becomes a **door with a ladder**:
  the doorway opens onto a small landing/shaft, and **each rung is one alternate
  reply**, its move-pair billboard (and its situational characterization label)
  beside the rung. Climbing a rung enters that alternate's own room.
- Each rung's room is a normal, fully-decoratable room **keyed by its own
  position** — no new keying scheme is needed; they are simply several rooms
  reached through one ladder-door instead of one room through a plain door.
- **Return** composes with the dynamic back-door work already shipped
  (`roomEnteredFrom`, see `CastleDataModel.md`): the ladder's base is the single
  shared return point, and each alternate room's back door returns to the room
  that holds the ladder.

The ladder is therefore *additive* to the existing VR vocabulary (door / stair /
elevator / teleporter), gated on `exit.altReplies.length > 1`.

---

## Intersection points with current code

The change is fundamentally "make one field a list" propagated through a known
set of choke points, not a rearchitecture. The choke points:

### 1. Data model — `pref.reply`

- Written in `setStandardResponse` and friends: `js/app.js:3581`, `:3959`,
  `:7275`.
- **Precedent to mirror:** `manualReplies` is already a multi-valued **array**
  pref field (`js/app.js:1224`, `:1340`) that serializes the same way `reply`
  does. An additive `altReplies: []` (or promoting `reply` to `replies: []`)
  should follow that exact pattern.
- Backup serialization enumerates pref fields explicitly (`js/app.js:4760`,
  `:4839`) — alternates must be added there. Additive field ⇒ old backups load
  unchanged; new field simply absent.

### 2. Tree model & rendering

- `setStandardResponse` → `expandWith(reply)` expands **one** bold child branch
  (`js/app.js:3578-3588`). Alternates need N bold children under one opponent
  move. The tree already renders multiple children for opponent moves — the only
  asymmetry is that *our* reply is currently singular.
- `computeNodeStats` descends into the single reply (`js/app.js:393-400`,
  `:439-442`) and defines **"complete to move N"** (`:385-393`). With alternates
  this needs a rule: since both lines must be known, "complete" should require
  **all** alternates built to that depth (the min across them), not just one.

### 3. Castle data model & digraph

- `buildCastle` (`js/app.js:1348-1364`) and `buildCastleGraph`'s `processExit`
  (`js/app.js:1191-1219`) each take the one `reply`, compute one `destSeq`, and
  add one edge to one destination room. **Alternates ⇒ one exit spawns multiple
  destination rooms/edges.** This is the structural heart of the change.
- `buildGeneratedCastle` builds one move-pair per member (`pairFor`,
  `js/app.js:1508-1644`); room naming is keyed one ply back from the anchor seq
  (`genRoomMeta` `:2843`, `canonicalRoomSeq` `:2914`). Alternate replies from one
  opponent move produce sibling rooms sharing a parent opponent-move but
  diverging — the naming/keying model currently assumes a single canonical path
  in and will need to accommodate the fork.

### 4. VR (`js/threeVR.js`)

- `registerOneCastle` wires each exit to exactly one target room (`:474-480`);
  `DEMO_MNEMONICS[key].pairs` carries one `response` per pair (`:486`);
  `buildMnemPairSprite` renders `resolveMoveContent(pair.response)`
  (`:3447-3466`). Every door is one opponent-move → one room.
- The room key is the position *after our reply*, so alternates inherently mean
  several rooms behind one opponent try — which is exactly what the ladder
  structure renders (see above). New ladder geometry/triggers/decoration
  persistence sit alongside the existing door machinery.

### 5. Training / quiz

- `oqLoadStep` sets `OQ.expected = pref.reply` (one answer, `js/app.js:6458`);
  `oqInputHandler` accepts only an exact SAN match (`:6513`). Alternates ⇒
  accept **any-of**, then decide which continuation to walk. Because the choice
  is situational, quiz likely wants a mode switch: *accept any alternate as
  correct*, and either follow whichever the user played, or (drill mode) prompt
  for a specific characterization ("play the solid line here").
- Stats: "played your move in X of Y games" (`:958-976`) and the actual-vs-
  standard eval summary (`:759-816`) both assume one standard move and must fold
  over the set.

---

## Suggested phasing

Each phase is independently shippable and testable.

1. **Data model + tree** (medium). `altReplies` pref field with situational
   characterization, tree renders/edits multiple bold children, backup
   round-trip, migration. No VR/castle dependency.
2. **Castle graph + digraph** (medium-large). `processExit`/`buildCastle` fork to
   multiple edges; digraph shows the fork; naming/keying handles multi-in.
   Highest risk for the memorized-room and canonical-seq machinery.
3. **VR ladders** (large). New ladder structure, geometry, triggers, decoration
   persistence — the most new code, but self-contained and built on top of 1–2.
4. **Quiz semantics** (small-medium). Accept any-of; optional
   characterization-targeted drill mode.

---

## Open questions to resolve before phase 2+

- **"Complete to move N" with alternates.** Confirmed intent: both lines must be
  known, so completeness should require *all* alternates built (min depth across
  them). Worth confirming this doesn't make existing systems read as suddenly
  "incomplete" in a surprising way.
- **Characterization vocabulary.** Free-text label per alternate, or a small
  fixed set (solid / sharp / sideline …), or both? Drives the tree/digraph/rung
  UI.
- **Quiz default behavior.** Accept any alternate silently, vs. explicitly drill
  a named alternate ("give me the drawish line"). Probably a mode toggle.
- **Migration/field shape.** Additive `altReplies: []` beside `reply` (keeps
  `reply` as the "first" line, minimal churn) vs. promoting to `replies: []`
  (cleaner model, touches every read site). The additive form is lower-risk for
  a first pass.
- **Downstream duplication.** Each alternate has an independent downstream tree
  and its own rooms/decorations. That is the intended power (parallel
  repertoires) but also multiplies the memorization surface — worth a UI cue for
  how much a given fork expands the castle.
