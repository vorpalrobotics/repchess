# Micro-Environments — Design Notes

Status: **early-stage notes for future reference, still not implemented and
not scheduled**. This document captures a memory-palace extension concept
so it doesn't get lost, and offers an initial evaluation. This was written
when regular room-based castles (the generator, hallways-vs-doors, linear
runs, move-object slots) were still unbuilt prerequisite work; that part
has since substantially shipped (see the updated status notes in
`CastleBuildingNotes.md`, `CastleDataModel.md`, and
`LinearSequencesAndRoomObjects.md`), but this micro-environment extension
itself remains unbuilt and unscheduled — nothing here changes
`buildCastleGraph`, the exit/feature schema, or any shipped behavior.

## The concept

In classical memory-palace technique, a single physical object inside a
room can itself be used to hold a chain of loci, instead of always
spawning a new room for the next association. The canonical example: a
desk in a study. Rather than every continuation opening a new door to a
new room, the desk itself becomes a compact navigable space — a
**micro-environment** — with its own internal loci:

- **Top surface**: an ordered, left-to-right row of objects sitting on the
  desk (stapler, lamp, blotter, fountain pen, notebook). Each object is its
  own locus/"room" for one association, just like a room in the main
  castle holds one position's mnemonic.
- **Front face**: additional structured loci, e.g. two stacks of four
  drawers each (left stack, right stack). Each drawer is also a locus.

Today, an `exit` (see `CastleDataModel.md`) is one of `door | stairsUp |
stairsDown | elevator | portal`, and every exit's `target` is either
another room, a leaf, or (for `portal`) another castle. The proposal is to
add a new exit type — tentatively `microEnvironment` — whose target is not
a single room but a **small internal graph of loci embedded in one
object**. Entering it (by clicking/running into the desk) always starts at
a fixed entry locus: the leftmost object on the top surface. From there,
the user can:

1. continue rightward across the top surface (stapler → lamp → blotter →
   fountain pen → notebook), or
2. branch downward into the left drawer stack (top drawer first), or
3. branch downward into the right drawer stack (top drawer first).

In the worked example this gives **3 branches** from the entry locus, even
though the whole thing visually reads as "one piece of furniture" rather
than three separate rooms — which is exactly the compression memory-palace
practitioners use micro-environments for in the first place.

## Why this is appealing

- **Density without door-spam.** A position with a wide branch count today
  would need many separate rooms/doors, which both (a) is expensive to
  build out visually and (b) dilutes the "one room = one decision point"
  intuition `CastleBuildingNotes.md` already establishes for *small*
  branch counts. A micro-environment gives a place to put a *cluster* of
  closely related branches (e.g. several minor sidelines off one common
  reply) without minting a whole new room per sideline.
- **It reuses existing vocabulary almost for free.** Each locus inside a
  micro-environment is conceptually identical to a room: it has a position
  (or position range, for hallway-like loci), it can hold mnemonic
  decoration, and it can itself have exits (continue forward, or — in
  principle — open a full door back out into the main castle graph).
- **Tractability constraint is good engineering instinct.** Modeling the
  micro-environment as a plain box with exactly two skinnable faces (top,
  front), each populated by an ordered list of placeable objects, avoids
  the otherwise-unbounded problem of "arbitrary 3D object with arbitrary
  navigable surfaces." A box with two ordered object-rows is a small,
  closed schema — closer to "a room with two shelves" than to a general
  3D scene-graph problem.

## Open questions / risks (the evaluation the user asked for)

1. **Move-to-locus mapping is the hard part, and it's still unsolved.**
   The user already flagged this ("for further study"). In the main
   castle, the mapping is unambiguous: one room = one position reached by
   our move, one exit = one opponent reply. Inside a micro-environment,
   it's not obvious whether:
   - each locus = one ply (so the desk row is itself a forced hallway,
     like the existing `feature` chain mechanism), or
   - each locus = one *branch option* at a single position (so the desk
     row is more like a wide single-position branch menu — three top-row
     items could be three different opponent replies at the *same* FEN,
     not three sequential plies), or
   - some mix: top surface = sequential (hallway-like), drawer stacks =
     parallel branch choices at one point in that sequence.
   This needs to be pinned down before any data shape is final, because it
   changes whether a locus carries one `seq`/`fen` (sequential model) or a
   `parentSeq` + sibling index (branch-menu model). The drawer-stack
   example in the prompt (two parallel stacks branching off the top row)
   suggests the *mixed* model is the intended one, which is also the most
   general but the most schema work.
2. **Re-entry and partial state.** Rooms in the main castle are stateless
   to revisit — walking back through a door just shows the room again.
   A micro-environment with branching internal paths needs to decide
   whether re-entering it always restarts at the leftmost top-surface
   object (simplest, matches "entering a room" framing) or resumes wherever
   you left off (more stateful, more like a sub-castle). The prompt's
   phrasing ("entering a micro-environment always starts at the first
   scene") suggests always-restart, which is simpler and probably right.
3. **Exit-from-micro-environment.** Every locus presumably needs a way
   back to the main castle graph (even if only "the last locus in a chain
   has a normal exit"), otherwise micro-environments become dead ends.
   This likely reuses the existing `exits[]` shape per-locus rather than
   needing anything new.
4. **Editor burden.** This is real new authoring surface: defining the box,
   skinning two faces, placing/ordering objects per face, and wiring each
   object to a position/branch. That's a meaningfully bigger lift than
   picking a `featureType`/`assetId` for a hallway feature today. Worth
   sizing the editor work, not just the data model, before committing.
5. **Does it need to be box-shaped specifically, or is "two ordered
   object-rows" the actual reusable primitive?** If the real reusable unit
   is "an object with an ordered list of sub-loci," the box/desk framing
   may just be the first skin; a kitchen counter, a bookshelf, or a wall of
   cubbyholes are all the same primitive with different visual skins. Worth
   keeping the data model skin-agnostic (object → ordered loci) even though
   the box is the concrete first example, so future skins don't need a
   schema change.

## Sketch of a possible future shape (illustrative only, not proposed schema)

Loosely extending `CastleDataModel.md`'s exit shape — **not** a commitment,
just to make the size of the addition concrete:

```js
// a new exit type, alongside door | stairsUp | stairsDown | elevator | portal
{
  id: "exit3",
  type: "microEnvironment",
  assetId: "desk_oak_01",          // the box skin (top + front textures bundled)
  exitSeq: [...],                   // same as any other exit
  classification: "exit",
  target: {
    kind: "microEnvironment",
    microEnvId: "desk_oak_01_instance_7"
  }
},

// the micro-environment's own internal structure — shape TBD pending
// open question #1 above; sketched here only to size the problem
const microEnvironment = {
  id: "desk_oak_01_instance_7",
  box: { topSkin: "desk_wood_01", frontSkin: "desk_drawers_01" },
  topLoci: [           // ordered, left-to-right; entry point = topLoci[0]
    { id: "loci1", assetId: "obj_stapler", /* seq or parentSeq+branch, TBD */ },
    { id: "loci2", assetId: "obj_lamp" },
    { id: "loci3", assetId: "obj_blotter" },
    { id: "loci4", assetId: "obj_pen" },
    { id: "loci5", assetId: "obj_notebook" }
  ],
  frontLoci: {
    left:  [ /* top-to-bottom drawer stack, 4 loci */ ],
    right: [ /* top-to-bottom drawer stack, 4 loci */ ]
  }
};
```

## Follow-up thinking: fit and authoring model

A clarification on where micro-environments actually fit, refining open
question #1: they're a good match specifically for **mostly-linear
sequences with a small amount of branching** — not a general replacement
for wide branch points. In the desk example: the four-drawer stacks are
each a straight run of forced moves with no branching at all (exactly the
kind of sequence `CastleBuildingNotes.md` already collapses into hallway
`feature` chains within an ordinary room), while the top-of-desk row is
where the real decision lives — an initial 3-way branch. So a
micro-environment isn't "a denser way to do branchy rooms" so much as "a
single object that can hold one shallow branch point plus two-or-three
short linear tails," which is a narrower and more tractable target than
the original framing suggested.

That reframing raises a more fundamental open question, still unresolved
and flagged by the user as needing more thought before going further:

- **Pre-defined template library, matched by the software.** We'd design
  a fixed catalog of micro-environment "shapes" up front (desk with N
  top-row slots and two M-drawer stacks; bookshelf with K shelves; etc.),
  each shape declaring what branch/sequence-length pattern it's good for
  (e.g. "1 branch point with 2-4 short linear tails of length L"). When
  building a castle, the software inspects the upcoming move-tree shape at
  each room and picks the best-fitting template from the catalog, the same
  way `classification: "auto"` already picks `feature` vs `exit` from
  branch count today. This keeps authoring purely declarative (catalog of
  shapes + a fitting heuristic) but means the catalog has to anticipate
  every shape of branch pattern that shows up across real repertoires,
  which could be a long tail.
- **On-the-fly collapsing of existing rooms.** Instead of (or alongside) a
  template catalog, the builder could look at an already-built run of
  ordinary rooms/exits and, when it spots a candidate pattern (a short
  forced run feeding 2-4 parallel short forced runs), offer to "suck" that
  whole cluster into a single micro-environment object, replacing several
  rooms+doors with one furniture piece. This is more general — no
  pre-anticipated shape catalog needed — but pushes more complexity into
  the builder (detecting candidate clusters, and reversibly converting a
  room subgraph into a micro-environment's locus list and back).
- These aren't necessarily exclusive: a small template catalog could cover
  the common shapes, with on-the-fly collapsing as a fallback or manual
  override for everything else. Which to start with — or whether to do
  either yet — is exactly the kind of decision the user wants to defer
  until there's been more time to think it through.

## Trimmed-down variant: single-run-only, no branching inside

Everything above is the original, general concept (a box with an internal
branch point plus multiple loci-rows) and remains unimplemented/unscheduled
as a whole. This section documents a much smaller, separately-evaluated
slice that was sized specifically to be buildable: a micro-environment with
**no internal branching at all** — it only ever holds a single already-linear
run of loci, one after another. This directly sidesteps open question #1
(move-to-locus mapping) because there is no branch-vs-sequence ambiguity to
resolve: a single run is unambiguously sequential, exactly like a corridor
room today.

### Terminal-only starting point

- Restrict eligibility to exactly the case already characterized in the
  linear-sequence-configuration enumeration: the exit's target room's shape
  is a single run (`kind: 'run'` from `analyzeCastleStructure`) with no
  forward exit at its tail (a "single linear terminal room").
- New option in the Room Geometry modal's per-exit door-type menu, alongside
  `door | stairsUp | stairsDown | elevator`: **micro-environment**, offered
  only when the exit's target qualifies as above.
- When selected, the exit no longer renders as a door/wall-gap at all.
  Instead an assignable object image target appears — reusing the existing
  `L1`/`R1`/`C1`-style slot-tagging convention, tagged e.g. `M1` — that the
  user assigns exactly like any other move-object slot.
- The assigned object gets a small distinguishing visual cue marking it as a
  micro-environment entry rather than an ordinary decoration — a glowing
  sphere hovering near/on it, meaning "walk into me to shrink down." Running
  into the sphere transitions the user into the micro-environment the same
  way running through a door transitions into a new room.
- Inside, the destination is a compact "top surface" rendering of the target
  room's linear run: each move-pair in that run becomes one locus laid out
  left-to-right on the shrunk surface, reusing the existing per-slot
  object/asset rendering used in ordinary rooms today — just at a smaller
  physical scale and without needing the room's own walls/floor/doorway
  geometry at all, since the run being terminal means there's nothing past
  the last locus to connect back out to.
- This resolves open question #3 (exit-from-micro-environment) trivially for
  the terminal case: there is no exit to model, because the underlying room
  had none either. It does not need a wall gap, hallway feature-chain
  reuse, or any new per-locus exit schema.

### Extension: any single-run room, not just terminal ones

The terminal-only restriction was the main limitation of the first cut — it
excludes the common non-terminal single-run and two-track-with-one-open-tail
configurations identified in the linear-sequence enumeration. Extending to
those only requires handling "there's a door at the far end":

- If the target run's tail *does* have a forward exit (or exits, for the
  two-track case where one or both tracks continue), place a **de-shrinker**
  teleporter billboard at the far end of the shrunk top-surface sequence —
  one per forward branch that existed at the tail. Running into it expands
  the user back out through that original exit, exactly where the door would
  otherwise have taken them.
- Symmetrically, place a de-shrinker at the *start* of the shrunk sequence
  that always leads back into the parent room the micro-environment object
  sits in — mirroring the existing `buildExitSign` "EXIT" placard convention
  used for return trips elsewhere in the app.
- Both the entry sphere and the de-shrinker billboards are skinnable (a
  choice of visual treatment), not fixed to one asset.
- With this extension, the eligibility rule simplifies: **the target room's
  `kind` is a single run** (plain corridor or a two-track box), full stop.
  "Terminal" no longer needs to be a separate qualifier — a terminal run is
  just the special case with zero de-shrinkers at the far end.

### Why the extension also helps the stale-memorized/room-split problem

The Study-room investigation earlier in this session showed that adding a
branch mid-way through a linear room causes the room to split into two
pieces, with only one half keeping the original identity/name/decorations —
the other half becomes a fresh, undecorated room. A terminal-only
micro-environment would inherit that exact same fragility: shrinking a
7-locus run down, then later adding a branch at locus 3, would split the
underlying run and leave the micro-environment's shrunk rendering stale or
partially orphaned in the same way. The extended (de-shrinker) version
doesn't eliminate this — the underlying room-splitting mechanics are
unchanged — but because a micro-environment is now valid for *any*
single-run shape (not just terminal ones), a post-split remainder that is
still a qualifying single run (which, per the earlier enumeration, is the
common outcome — the peeled-off two-track piece is usually what's new, while
the original corridor's surviving prefix stays a run) keeps being a valid
micro-environment target and simply gains a de-shrinker at its new, shorter
tail. This narrows the staleness gap to the same content-drift case that
already exists for ordinary decorated rooms today (the stale-memorized
question raised separately, and explicitly deferred), rather than adding an
extra, micro-environment-specific failure mode on top of it.

### Remaining open items for this slice specifically

- **Multi-de-shrinker wall layout.** When a tail has more than one forward
  branch, the far end of the shrunk surface needs the same kind of
  multi-door spacing logic the app already uses for rooms with several
  doors on one wall — this is reuse, not new design, but still a concrete
  implementation dependency to account for when sizing the work.
- **Stairs/elevator-typed tail exits.** Recommend excluding these from
  eligibility for v1 — a de-shrinker that dumps the user into a stairwell
  transition feels like a worse fit than a plain door target, and it's a
  small enough case to defer rather than design for up front.
- **Pre-existing identity-loss edge case.** When a run gets absorbed into a
  *new* two-track at its own head's parent (an existing, already-accepted
  system characteristic, not something this feature introduces), it loses
  its own identity entirely. A micro-environment anchored to that run would
  be subject to the same loss. Not a new problem, just worth flagging as
  inherited risk.
- **New eligibility predicate needed at build time.** The Room Geometry
  modal needs a small helper — mirroring the existing style of
  `isStairType`/`isRoomEmpty` — that checks "is this exit's target room a
  single run" to decide whether to offer the micro-environment option at
  all. Not yet written; sized here only.

This slice is still unimplemented and unscheduled, same as the general
concept above — it's recorded here because it was fully evaluated and judged
buildable, not because it's next in line.

## Explicitly deferred

- Resolving the template-catalog vs. on-the-fly-collapsing question above,
  and pinning down the move-to-locus mapping (open question #1) — needs
  more thought before any schema is final.
- Any editor UI for placing/ordering objects on a micro-environment's
  faces.
- Any Three.js scene work, asset list, or rendering.
- Whether micro-environments are reusable templates (like asset-catalog
  entries) or always one-off per castle.
- All of `CastleBuildingNotes.md` / `CastleDataModel.md`'s deferred items,
  which this depends on being finished first per the user's stated
  priority.
