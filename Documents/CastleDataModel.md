# Castle Data Model — Design Proposal

Status: **proposal, not yet implemented**. This document specifies the data
shapes for turning the Opening Graph into a navigable, decorated
memory-palace castle (see `CastleBuildingNotes.md` for the underlying
mnemonic-design considerations this builds on). Nothing here changes
`buildCastleGraph`, the room-info click panel, or any other shipped
behavior yet — this is the target schema to implement against.

## Three layers

1. **Structural layer** (already exists, unchanged): the move-tree-derived
   room/edge graph built by `buildCastleGraph(line, games, rootSeq)` in
   `js/app.js`. Rooms and edges are recomputed every time from the line's
   standard responses + imported games; nothing about them is persisted.
2. **Decoration layer** (new): per-castle annotations — room names,
   textures, features, exit types/targets, and classification overrides —
   stored keyed by stable position/move identifiers so they survive
   re-running the structural builder (new games imported, lines edited,
   etc.), the same way the existing `prefs`/`mnemonics` IndexedDB stores
   already survive rebuilds.
3. **Asset catalog** (new): a shared, app-wide library of taggable,
   reusable visual assets (textures, picture/statue/rug/furniture/window
   variants, door/staircase/elevator/portal variants). Not per-castle data
   — castles draw from this shared pool, which is what makes ~300 rooms
   across ~10 castles avoid feeling repetitive.

## Layer 1 recap: where rooms/edges come from

No changes proposed here. `buildCastleGraph` already produces, per room,
the position (`fen`), the move that leads into it (`seq`/`label`), and its
outgoing edges (each an opponent reply, `exitSeq`/`fen`/`label`). The
decoration layer below references these by `seq`/position key rather than
by the ephemeral `room0`/`room1`/`leaf0` ids the builder assigns at render
time.

## Layer 2: classification — door vs. hallway feature

The central design decision: **whether an opponent reply becomes a real
exit (door/staircase/elevator/portal) or gets absorbed as a feature inside
the current room is a property of the edge (the reply), not the room.**

A room's feature list is built by walking forward through a chain of
edges classified `feature`, merging each forced reply into the current
room, until hitting an edge classified `exit`, a leaf, or the end of the
line. This is how a 5-ply forced sequence becomes one hallway with five
features hung along it instead of five separate rooms.

```js
classification: "auto" | "feature" | "exit"
```

- `"auto"` (default): the program decides, using a heuristic on branch
  count — roughly: 1 outgoing edge → `feature`; 2 edges where one is a
  flagged non-obvious blunder/trap with no further branching for several
  plies → both `feature`; 3+ edges, or structurally significant
  continuations → `exit`.
- `"feature"` / `"exit"`: explicit user override, pinned regardless of
  what the heuristic would otherwise pick.

This lives on the edge/exit object, not the room, since the room itself
doesn't "decide" anything — each of its replies decides independently
whether it stays in-room or opens a door.

## Layer 2: schema

```js
const castle = {
  id: "castle_qgd",
  lineId: "abc123",            // ties back to the existing repertoire line
  name: "Queen's Gambit Castle",
  theme: "medieval",            // default theme tag used when auto-picking assets
  entrySeq: ["d4","d5","c4"],   // position where this castle's geography starts

  rooms: {
    // keyed by positionKey(fen) of the room's entry position — stable
    // across rebuilds, unlike the structural layer's room0/room1 ids
    "<roomKey>": {
      seq: ["d4","d5","c4"],          // our move that put us in this room
      name: "Throne Room",
      wallTexture: "wall_stone_grey_01",
      floorTexture: "floor_marble_blue_02",
      ceilingTexture: null,

      // one entry per forced ply-pair absorbed into this room as a
      // hallway feature, in walk order
      features: [
        {
          id: "feat1",
          type: "picture",                       // picture | statue | rug | furniture | window
          assetId: "pic_lion",
          slot: "north-wall",                     // freeform position hint
          exitSeq: ["d4","d5","c4","dxc4"],       // opponent reply this feature represents
          replySeq: ["d4","d5","c4","dxc4","e4"], // our forced follow-up, if any
          overlays: []                            // e.g. ["dunceCap"] to flag a blunder/trap
        }
        // ...chained lion -> tiger -> bear for a 3-ply forced sequence
      ],

      // real branch points: each becomes a door/staircase/elevator/portal
      exits: [
        {
          id: "exit1",
          type: "door",                  // door | stairsUp | stairsDown | elevator | portal
          assetId: "door_oak_01",
          exitSeq: ["d4","d5","c4","e6"],
          classification: "auto",
          target: { kind: "room", castleId: "castle_qgd", roomKey: "<roomKey2>" }
        },
        {
          id: "exit2",
          type: "portal",                 // cross-castle transposition
          assetId: "portal_arcane_01",
          exitSeq: ["d4","d5","c4","c5"],
          classification: "exit",
          target: { kind: "portal", castleId: "castle_slav", roomKey: "<otherRoomKey>" }
        }
      ]
    }
  }
};
```

### Exit type semantics

- **`portal` is functionally special**: it's the only exit type that
  represents a transposition *out of the current castle* into a different
  one, and its `target.kind` is always `"portal"` pointing at another
  castle's `id`/`roomKey`.
- **`door` / `stairsUp` / `stairsDown` / `elevator` are functionally
  interchangeable** — all represent a same-castle continuation
  (`target.kind: "room"` or `"leaf"`). They exist purely for visual
  variety; the asset-picking logic should rotate through them rather than
  defaulting to `door` every time, so a room with three exits doesn't show
  three identical doors.

### Shallow trap-branch example

A room with exactly two branches — one normal reply, one non-obvious
blunder that starts a trap — gets `classification: "feature"` on *both*
edges instead of becoming exits: one feature (e.g. a coat of arms) for the
correct reply, one feature with `overlays: ["dunceCap"]` (e.g. a
fireplace, "the opponent is about to get burned") for the blunder. No
extra room or door is spawned for either. This falls naturally out of the
classification rule above — no special-cased data shape is needed.

## Layer 3: asset catalog

Shared, app-wide, **not** part of any individual castle's data. Flat lists
per asset type, each variant taggable by theme so a castle can draw from a
themed subset while still avoiding exact repeats across rooms/castles.

```js
const assetCatalog = {
  wallTextures: [
    { id: "wall_stone_grey_01", name: "Grey Stone",   themes: ["medieval","castle"], thumb: "...", asset: "..." },
    { id: "wall_oak_panel_01",  name: "Oak Panelling", themes: ["medieval","study"],  thumb: "...", asset: "..." }
  ],
  floorTextures: [
    { id: "floor_marble_blue_02", name: "Blue Marble", themes: ["medieval","throne"], thumb: "...", asset: "..." }
  ],
  featureTypes: {
    picture:   { variants: [ { id:"pic_lion", name:"Lion Portrait", themes:["animal","wizardofoz"], asset:"..." },
                              { id:"pic_tiger", name:"Tiger Portrait", themes:["animal","wizardofoz"], asset:"..." },
                              { id:"pic_bear",  name:"Bear Portrait",  themes:["animal","wizardofoz"], asset:"..." } ] },
    statue:    { variants: [ /* ... */ ] },
    rug:       { variants: [ /* ... */ ] },
    furniture: { variants: [ /* ... */ ] },
    window:    { variants: [ /* ... */ ] }
  },
  exitTypes: {
    door:       { variants: [ /* ... */ ] },
    stairsUp:   { variants: [ /* ... */ ] },
    stairsDown: { variants: [ /* ... */ ] },
    elevator:   { variants: [ /* ... */ ] },
    portal:     { variants: [ /* ... */ ] }   // still has visual variants, despite being functionally special
  },
  overlays: {
    dunceCap: { asset: "..." }   // attachable to a feature to flag a known blunder/trap
  }
};
```

### Repeat avoidance

A lightweight usage ledger — e.g. `{ assetId: count }`, or a set of
`{castleId, roomKey, assetId}` triples — lets the asset-picker prefer
never-used assets first, then least-recently-used. Whether "no repeats" is
enforced per-castle or globally across all castles is an open tuning
choice; either way the ledger is derived data (rebuildable from the
decoration layer by scanning all `assetId` references), not a separate
source of truth.

## Persistence and rebuild safety

Decoration-layer data is keyed by `seq`/position-derived keys
(`roomKey = positionKey(fen)`, edges keyed by `exitSeq`), never by the
structural layer's `room0`/`room1`/`leaf0` ids, which are reassigned every
time `buildCastleGraph` runs. This mirrors how `prefs` (keyed by
`prefKey(lineId, seq)`) and the per-square `mnemonics` store already
survive line edits and new game imports — the decoration layer should live
in IndexedDB alongside them, not be recomputed.

## Explicitly deferred (not part of this proposal)

- Actual Three.js scene construction, asset loading, and rendering.
- The real contents of the asset catalog (specific textures/models).
- Reworking `buildCastleGraph` / the room-info click panel to actually
  walk `feature`-classified edges into multi-ply hallways instead of
  one-room-per-position. Today every position still gets its own room;
  this document defines the target shape that change will produce.
- UI for editing/overriding `classification`, assigning features to
  slots, or picking assets by hand.
