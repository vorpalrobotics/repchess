# Linear Sequences & Room Objects

Design notes for two tightly-related ideas that came out of actually
memorizing a real sequence (Shakespeare's plays, in a single room of a house):

1. **Linear sequences** — long un-branching stretches of a repertoire can each
   live along *one wall of a single room*, drastically reducing room count.
2. **Direct move-pair ↔ object association** — every move-pair (opponent move +
   our response) is pegged to a specific object in the room, not just floated
   near a billboard.

Status: **design intent, not yet built.** This refines, and should be read
alongside, `CastleBuildingNotes.md` (the "hallways vs. doors" room model) and
`CastleDataModel.md` (the position-keyed persistence plan). Nothing here is
shipped yet; the run-boxing in the network graph and the object-association
edit UX are both designed-and-ready, not coded.

---

## 1. Linear sequences (runs)

A **linear sequence** (a "run") is a maximal chain of rooms `r0 → r1 → … → rk`
where every step is *forced*:

- **`r_i` has out-degree exactly 1** — a single opponent reply. This must count
  *all* outgoing edges, **including edges to unbuilt `?` leaves**: a room with
  one real continuation *plus* one unbuilt branch has two replies and is a
  junction, not linear.
- That single edge targets a **room, not a leaf** (a leaf = no standard
  response yet, so the chain just ends there).
- The target **`r_{i+1}` has in-degree 1** — i.e. it is *not* a transposition
  merge point. (The graph already computes the in-degree map; it's what colors
  the orange transposition nodes.)

Runs are as short as **2 nodes** and often **5–8**. Eyeballing the London
System graph, a large fraction of nodes sit inside runs.

### Settled design choices

- **A merge node may be a run's *head*.** A transposition node (in-degree > 1)
  can never sit in the *middle* of a run — the in-degree-1 rule stops the chain
  before it — but it *can* be the first node, if it then proceeds linearly.
- **This is intentionally looser than the move-table's "compact mode."** The
  table's `computeCompactRun` also requires *no annotations* on the hoisted
  moves; the graph's run definition is **purely structural** and drops that
  condition (a named node mid-line is still part of the run — naming the
  objects along the wall is the whole point). The two definitions are kept
  separate on purpose.
- **A run that dead-ends into a `?` leaf** is still boxed up to its last real
  room (the built portion).

### Boxing runs in the network graph

Mark each run by enclosing its members in a box, using a cytoscape **compound
(parent) node** (`data.parent = 'run_k'` on each member + a styled parent node).
`cytoscape-dagre` understands compound graphs, so each run lays out as a unit.

Implementation notes:
- The hover-preview and click handlers bind to `'node'`; **exclude parent
  boxes** (e.g. filter on "has a `fen`") so hovering the box background doesn't
  fire a board preview.
- Members keep their own colors (root green, transposition orange); the box is
  just an enclosure.

### Room-count stats

With `R` room nodes today, `C` = total nodes contained in runs across `numRuns`
runs, the remaining `R − C` nodes are genuine junctions that each still need
their own room. The **collapsed estimate** (each run lives in one room) is:

```
rooms after collapsing runs ≈ (R − C) + numRuns
```

i.e. a run of `k` nodes drops from `k` rooms to `1`. Status line, e.g.:

> 38 rooms, 52 moves, 6 not yet built, 3 transposition merges
> 9 linear runs covering 27 nodes → ≈ 20 rooms after collapsing

**The further halving** from packing *two* runs per room (left/right walls) is
**deliberately not quantified yet** — it depends on which two runs can actually
share a room (a branch spawning three runs can't fit them all on two walls), so
a naive `ceil(numRuns/2)` would understate the real count. That number waits
until the packing generator can report a true count.

---

## 2. Rooms hold linear sequences (the packing idea)

A single room is naturally divided **left side / right side**. Objects placed
along a side host a linear sequence in order. So:

- **One run per wall**, **up to two runs per room** (left + right).
- Each run's terminal node — wherever it finally branches or hits a leaf — is
  where the **door(s) out** go. Two runs that happen to converge to the same
  transposed position could even share a single door (set aside for now).
- **Mid-wall doors are fine.** A long run needs a long, corridor-like room
  anyway, so there's room for a door here and there along a wall — needed both
  for late-breaking trap edits (below) and for transpositions that land
  mid-corridor.

### Layout, first cut (refine after getting a feel)

- **Room length scales with run length** at some fixed per-move stride/scale, so
  longer sequences make longer corridors.
- **Differing side lengths are OK for now.** If the left run is much longer than
  the right, just let the short side be a long empty walk while the long side is
  busy; or drop the short side's door right after its sequence ends. Don't
  optimize this yet.
- Branch points become **doors**; runs become **walls**. One room per real
  decision point still holds (see `CastleBuildingNotes.md`).

---

## 3. Identity: two layers (refines `CastleDataModel.md`)

The plan of record keys rooms by the **condensed FEN** of the position. That's
still right, but runs force splitting "position identity" from "room identity":
under the old one-position-per-room model they were the same; a run-room spans
*many* positions.

- **Position identity = condensed FEN.** Unchanged, still the atomic stable key.
  Every position in a corridor keeps its own FEN key; object decorations and
  transposition targets hang off *that*, not off the room.
  - **Fidelity matters more with runs.** A corridor packs many positions close
    together, so an over-aggressive condense bites harder. The key must retain
    **side-to-move, castling rights, and en passant** and only drop the
    half-move clock and full-move number — otherwise two genuinely different
    mid-corridor positions could collide and either spuriously merge rooms or
    inject a fake transposition (in-degree > 1) that **breaks a run that
    shouldn't break**. Audit how the condense is computed before leaning on long
    runs.
- **Room identity = an anchor (entrance) FEN + an ordered span of member FENs.**
  A corridor room is keyed by its entrance position's FEN and owns an ordered
  list of the member positions along its walls.
- **Once built, the persisted room is authoritative; run detection is
  advisory.** Detection drives *initial* generation and *proposes* changes
  ("add a door at member p3"); it does **not** get to redefine or re-split an
  existing room. This is what protects an already-memorized corridor.
- **Persist the packing decision**, not just the positions — which run is on the
  left wall vs. right, in which room — keyed by the anchor FEN, so a regenerate
  never reshuffles which wall your plays live on.
- **Transpositions can land mid-corridor.** The position→location map must
  resolve to **(room, slot)**, not just (room); the arriving edge becomes a door
  midway down that wall.

---

## 4. Maintenance: when a new reply breaks a run

You play a game, the opponent tries something trappy, you add their new reply —
splitting a run. This is handleable:

- **Detection is derived, so there's nothing to maintain about the runs
  themselves.** Adding the reply takes a node from out-degree 1 to 2; the
  detector stops there and re-boxes automatically. The maintenance cost is
  entirely in the **decorated castle and your memory of it**, not the data.
- **Mid-wall door is acceptable.** In the awkward "break in the middle of a wall"
  case, just add a door midway down the corridor — a long run is a long room, so
  there's space. The remainder of the run continues past it; the new line goes
  through the new door.
- **Two edit modes** for the generator:
  - **Re-flow** — regenerate freely. Fine *before* you've memorized a castle.
  - **Pin-and-annex** — lock existing (memorized) rooms; attach new branches via
    a new door/portal to fresh annex rooms, leaving memorized walls intact.
- **Teleport/portal isn't really "worst case."** For anything already memorized,
  a portal door to a small annex is the *preferred* move precisely because it
  leaves the existing room byte-for-byte intact. The in-place mid-wall split is
  for rooms not yet committed to memory.
- **Guiding principle: late edits are additive and locally contained, never a
  global re-layout of memorized rooms.**

---

## 5. Move-pair ↔ object association (edit UX)

Even a single-move-pair room couples the move-pair to a specific object — in the
prototype that coupling is only spatial (an object dragged near the floating
billboard), with no data link. Make it real.

### The model: numbered placeholders that you fill

- **Billboards stay full-size** whether or not an object is associated, laid out
  **in order along a side** of the room (and possibly both sides, for two runs).
- Each move-pair that has no object yet shows a **placeholder**: a *cylindrical
  sprite* (always faces you) labeled with a generic id — **`L1`, `L2`, `L3`…**
  on the left wall, **`R1`, `R2`, `R3`…** on the right (per-side numbering).
- In **edit mode**, clicking a placeholder opens the **asset picker**. On
  returning, the placeholder is **gone, replaced by the chosen object**.
- The object can be **nudged relative to its billboard** but is **leashed** —
  clamped to a generous radius so the pairing can't drift apart (keep it
  generous, maybe soft/snap-back).
- The object can be **rotated** to face well as you walk down the corridor
  (reuses the existing prop rotation).

### Rules

- **Every move-pair has an object** (no "no object" state for now). If it turns
  out to be needed, add a *"suppress this object"* feature later.
- **Hints-off (self-test) hides billboards *and* placeholders, but keeps filled
  objects** — the object alone must trigger the recall. Same hints toggle that
  already exists, extended to placeholders.

### Why this UX (vs. an explicit "link" gesture)

- **No linking step.** The placeholder *is* the slot, pre-bound to its
  move-pair; filling it *is* the association. The binding is structural ("this
  slot belongs to move-pair N"), so there's no cross-reference that can dangle.
- **Self-documenting to-do list.** An empty `L3` sprite is a visible "not done."
  Walk the corridor filling 1-2-3; the room shows when it's complete.
- **Order is baked in** via the numbers — exactly what a memorized line needs.

### Implementation sketch (mostly existing pieces)

- **Numbered placeholder** = a `billboard-sprite` (already a supported prop
  type) with a canvas-drawn `L1`/`R2` label (same text-to-canvas used for street
  signs / move tags).
- **Click-to-fill / replace / clear** = the existing edit-mode slot-marker →
  `openAssetPicker` → place-accessory flow; clearing brings the placeholder
  back for free.
- **Rotate / nudge** = the existing prop transform pad.
- **New work, small and contained:**
  1. **Move-anchored slots** — each slot's id is derived from the **move's
     position key** (not an index), so the placed object survives regeneration
     and corridor re-packing. (Slots are room-scoped today; these are
     position-scoped.) The placed asset + transform is the decoration record.
  2. **Leash clamp** — clamp a move-anchored object's offset to a radius around
     its billboard anchor.
  3. **Hints-toggle extension** — hide placeholders alongside billboards.
- **Dependency:** this presupposes the generator lays a run out as an ordered
  row of billboards-with-slots along a wall, which doesn't exist yet. **Derisk
  on the current demo room first** — give the existing billboards a numbered
  placeholder + slot and wire the fill/leash/rotate loop — then drive it from
  real runs once the packing generator lands.

---

## Open items / to refine after a feel test

- True room count under two-runs-per-room packing (and the constraint that a
  branch spawning 3+ runs can't fit them all on two walls of its room).
- Spacing/scale of billboards + objects in long corridors so objects don't
  overlap.
- Leash radius tuning; soft vs. hard clamp.
- Whether two converging runs should ever share a single exit door.
- Re-flow vs. pin-and-annex selection (per-castle "locked" flag, or implicit via
  stable decoration keys).
