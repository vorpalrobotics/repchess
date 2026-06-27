# Castle Data Model — Design Proposal

Status: **proposal for the generated-castle data model — not yet implemented
here**. This document specifies the data shapes for turning the Opening Graph
into a navigable, decorated memory-palace castle (see `CastleBuildingNotes.md`
for the underlying mnemonic-design considerations this builds on). Nothing here
changes `buildCastleGraph`, the room-info click panel, or any other shipped
behavior yet — this is the target schema to implement against.

> **Note:** the standalone Three.js walking prototype (`js/threeTest.js`)
> already implements several of these concepts — room names, per-building
> surface defaults, named presets, elevators, stairs/door skinning, and a
> hints/self-test toggle — against its own `ROOMS`/`LAYOUT` structures. Their
> concrete shapes are recorded in
> "[Already implemented in the walking prototype](#already-implemented-in-the-walking-prototype-jsthreetestjs)"
> below so the mapping into this model is explicit.

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

## Already implemented in the walking prototype (`js/threeTest.js`)

The standalone walking prototype implements several concepts above ahead of the
generator, but against its own structures — a hand-authored `ROOMS` table
(geometry + exits) plus a persisted `LAYOUT` override store (one IndexedDB JSON
blob) — rather than the generated `castle`/`rooms` schema. When the generator
lands these should fold into Layer 2; they're recorded here so the mapping is
explicit. See `CastleBuildingNotes.md` → "Implemented in the walking prototype"
for the user-facing behavior.

- **Room name** — `ROOMS[key].name` (e.g. `"Study"`), shown on door hints. Maps
  to Layer 2's `rooms[<roomKey>].name`.
- **Per-room surface overrides** — `LAYOUT[roomKey]` holds `floor`, `ceiling`,
  `stairSurface`, `walls[wall]` (keyed by absolute compass wall), and
  `doors[doorKey]`, each an asset id. Map to `floorTexture` / `wallTexture` /
  `ceilingTexture` plus new `stairSurface` / per-door-skin fields in Layer 2.
- **Per-building surface defaults** — `LAYOUT.__defaults[buildingId]`:

  ```js
  {
    floor: assetId|null, ceiling: assetId|null, stairSurface: assetId|null,
    door: assetId|null,      // style for ordinary doors
    exitDoor: assetId|null,  // style for the back/exit door, so exits can stand out
    walls: { entrance, opposite, left, right }  // each assetId|null, stored
                                                // RELATIVE to the entrance door
  }
  ```

  Resolution everywhere is layered: **room override → building default →
  procedural fallback**. Walls are entrance-relative so a default rotates
  correctly into a room whose door is on a different wall. Building identity in
  the prototype is `ROOMS[key].building` or a single shared `_default` bucket;
  in the generated model the "building" is the castle.
- **Named presets** — `LAYOUT.__presets[name]`: the same style-set shape as a
  default ("Formal", "Rustic", …). Made from the current room; applied either as
  a building's defaults or stamped onto one room.
- **Elevator** — already one of the Layer 2 exit `type`s. In the prototype a
  `type:'elevator'` exit's target room renders in *car mode* (plain walls, a
  floor-button panel, popup floor selection); the car's own exits are the floor
  buttons, and it's a normal node with its own move pair. Used to represent a
  high-branch position compactly (see `CastleBuildingNotes.md` for the
  branch-count discussion and the still-open auto-vs-manual question).
- **Hints / self-test** — runtime *view* state, not castle data: a toggle that
  shows/hides door name placards, the ~0.3 m door-side move decoration of the
  room-beyond's opponent move, and the in-room move-pair billboards, so the
  palace can be walked as a recall test.

## Explicitly deferred (not part of this proposal)

- Actual Three.js scene construction, asset loading, and rendering.
- The real contents of the asset catalog (specific textures/models).
- Reworking `buildCastleGraph` / the room-info click panel to actually
  walk `feature`-classified edges into multi-ply hallways instead of
  one-room-per-position. Today every position still gets its own room;
  this document defines the target shape that change will produce.
- UI for editing/overriding `classification`, assigning features to
  slots, or picking assets by hand.
