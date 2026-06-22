# Castle Building Notes

Design considerations for how "rooms" in the Opening Graph / memory-palace
castle should be structured, captured from discussion so they can be
revisited when building room-decoration features. These are notes on
*intent*, not a spec for already-built features — nothing here has been
implemented yet.

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
