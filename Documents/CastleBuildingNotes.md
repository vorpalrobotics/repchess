# Castle Building Notes

Design considerations for how "rooms" in the Opening Graph / memory-palace
castle should be structured, captured from discussion so they can be
revisited when building room-decoration features.

The **room model** below (hallways vs. doors, feature-vs-door classification,
blunder marking) is still *intent* — the castle-graph generator that would
apply it is not built yet. However, a set of room-decoration and navigation
features **are now built and shipped** in the standalone Three.js walking
prototype (`js/threeTest.js`); those are documented in
"[Implemented in the walking prototype](#implemented-in-the-walking-prototype-jsthreetestjs)"
near the end of this file.

## The core idea

Each room in the castle corresponds to a position reached by one of our
own moves. The room's **exits** are the opponent's possible replies from
that position. Today, every exit is rendered as a graph edge leading to
either another room or a locked "?" leaf.

The memory-palace technique this is built on associates a *locus*
(a place or feature within an imagined room) with a *thing to remember*.
A room with many doors and a few features lets you walk through it and
recall a sequence of moves by recalling the features in order.

## Hallways vs. doors: when to make a new room

Not every opponent reply should spawn a new room. The graph today creates
one room per position regardless of branching factor, but for memory-palace
purposes that's wasteful when a sequence is **forced** (the opponent has
essentially only one reasonable reply, our reply follows, and this repeats
for several plies with no real decision point).

- **Forced/no-branch sequences** ("only-moves" on both sides for several
  plies) should be collapsed into a single room imagined as a **long
  hallway**. Each forced ply-pair (their move, our reply) hangs on a
  *room feature* placed along the hallway — a picture, a statue, a piece
  of furniture — rather than getting its own room.
  - Classic example: a hallway with a lion picture, then a tiger picture,
    then a bear picture, recalling "lions and tigers and bears, oh my"
    (Wizard of Oz) as a mnemonic chain for three forced replies in a row.
- **Doors are reserved for real branch points** — i.e. when a room has
  more than one meaningfully different opponent reply (more than one
  outgoing edge that actually needs a different room/leaf on the other
  side). Each such branch gets its own door out of the room.
- So the general rule: **one room per real decision point**, with forced
  in-between plies absorbed into that room's hallway/features instead of
  becoming rooms of their own.

## Opponent blunders / deep traps

Normally, obvious opponent blunders are excluded from the repertoire
entirely — there's no need to prepare for a move nobody would play. But
sometimes a *non-obvious* blunder leads into a real trap line that's worth
preparing, because the punishing reply isn't intuitive and we want to be
sure we find it.

- In these cases we usually only need to record the **immediate** punishing
  reply — once the opponent has fallen into the trap, the rest of the
  sequence tends to be forced/obvious and doesn't need its own room or
  detailed memorization.
- This shallow-branch case (one normal reasonable reply + one trap-inducing
  blunder, nothing else worth tracking) doesn't necessarily need a door
  for the blunder branch. It can still live as a **feature within the same
  room** as the main line, to avoid spawning a whole extra room for a
  single throwaway reply.

## Example: shallow two-branch room without doors

A room with exactly two outgoing branches — one main, reasonable reply and
one trap-triggering blunder — can be built entirely out of room features
instead of doors, e.g.:

- **Right side of the room**: a feature for the main, correct opponent
  reply (e.g. a coat of arms) — placed on the right because it's the
  *right* move.
- **Left side of the room**: a feature for the blunder/trap reply (e.g. a
  fireplace, because the opponent is "about to get burned").

Only once the position is past this point — i.e. once there are
multiple further continuations that themselves need real branching — do
actual exit doors appear, leading to the next room(s).

## Marking a move as a blunder visually

When a room feature represents a known blunder/trap-trigger rather than a
normal reply, the associated image/feature should be visually flagged as
such — e.g. a "dunce cap" added to the image associated with that move —
so it's immediately recognizable as the blunder branch rather than a
normal line.

## Implemented in the walking prototype (`js/threeTest.js`)

Unlike the room-model *intent* above, the following room-decoration and
navigation features are **built and shipped** in the standalone walking
prototype. It uses a hand-authored `ROOMS` table for structure plus a
persisted `LAYOUT` override store (IndexedDB) for every per-room edit; the
eventual generator will emit the same kinds of data.

### Elevators

An **elevator** is a special exit (`type: 'elevator'`) on a room. It targets a
room like any exit, but that target room is rendered in **car mode**: plain
tinted walls (not brick), a floor-button panel on the wall, and popup-based
floor selection instead of walk-through doors.

- **Purpose: compactly represent many branches.** Rather than putting, say, 7
  doors on one room's walls, a single elevator leads to a car whose own exits
  become floor buttons ("First Floor: …", etc.), each one an opponent reply.
- **Reserved for high-branching positions.** In the current repertoire branches
  are usually ≤ 4 but can be larger; the biggest is **13**, right at the start
  where play fans out into separate buildings. Whether a node *automatically*
  becomes an elevator past some branch-count N is **still undecided** — it may
  remain a manual authoring choice.
- The car is still a real **tree node/room**: it has its own move-pair
  billboard (read from the car room's own mnemonic data, like any room),
  mounted to the **right** of the floor-button door — the floor panel sits on
  the left.
- **Naming is the user's job.** The user names rooms; an elevator car would
  typically be named "Elevator" (or "North Elevator", etc. in a large castle).
  The app does not auto-name it.

### Hints & self-test

A **hints** toggle — a lightbulb button at the top-center of the walking modal,
its on/off state persisted in `localStorage` — shows/hides memory cues so the
palace can be walked as a recall **self-test**:

- **Door hints** (forward doors only; back/exit doors keep their "EXIT" sign and
  get none): a **name placard** for the room beyond, and — when that room has an
  opponent move — a separate **~0.3 m square "move decoration"** of that move
  (the higher/opponent move of the room's pair) mounted flat on the wall beside
  the sign, facing into the room. It shows the move's image, or its algebraic
  notation when no image has been set.
- **Move-pair billboards**: the in-room composite billboard showing a room's
  opponent + response move pair (including the elevator's, see above).
- Turning hints **off** hides *both* the door hints and the move-pair
  billboards, leaving only structure — so the user can try to recall each
  room's moves, then toggle hints back on to check themselves.

### Room names, surface defaults & presets

- **Room names**: each room can carry a `name` (e.g. "Study", "Kitchen"),
  surfaced on door hints. Data-driven (hard-coded in the demo, generator-
  supplied later).
- **Per-building surface defaults** (`LAYOUT.__defaults`, keyed by building id):
  default floor / ceiling / stairs / walls / doors so un-styled rooms inherit a
  consistent look. Resolution is layered — **room override → building default →
  procedural fallback**. Walls are stored **relative to the entrance door** so a
  default rotates correctly into rooms whose door is on a different wall. Two
  door styles are kept: **`exitDoor`** (the back/exit door, so exits can be made
  to stand out) and **`door`** (all others). Captured via a checkbox in the Room
  dialog; a readout there shows what's set, with a Clear control.
- **Named presets** (`LAYOUT.__presets`): reusable named style sets ("Formal",
  "Rustic", …), made from the current room and applied either as a building's
  defaults *or* stamped directly onto a single room.

### Stairs & door skinning

- **Stairs** (both in-room platform staircases and stair-exit corridors) default
  to a wood texture and are **skinnable per room** (`stairSurface`) by clicking
  the steps in edit mode.
- **Doors** are skinnable per doorway, and inherit the building's
  `door`/`exitDoor` default when not individually overridden.

(See `CastleDataModel.md` for how these same concepts are expected to be keyed
in the eventual generated-castle data model.)

## Summary of the room model (target, not yet built)

| Situation | Representation |
|---|---|
| Forced sequence, no real choice for several plies | One room = a hallway; each forced ply-pair hangs on a room feature (picture/statue/furniture) in sequence |
| Real branch point (room has 2+ meaningfully different replies that lead to different sub-trees) | One door per branch, each door leading out to its own room/leaf |
| Shallow branch: one main reply + one non-obvious blunder/trap reply, nothing else | Both can be room features instead of doors (e.g. right-side coat of arms for the right move, left-side fireplace for the blunder) — avoids spawning a room just for a single throwaway reply |
| A move that is a known blunder/trap-trigger | Its feature's image gets a visual marker (e.g. dunce cap) to flag it as a blunder rather than a normal line |

No features for any of this are being requested yet — this file exists so
these considerations can be re-read later when actually designing the
room-decoration/editing UI.
