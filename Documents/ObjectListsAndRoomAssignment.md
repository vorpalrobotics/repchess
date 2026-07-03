# Object Lists & Room Assignment

Design for incorporating **ordered object lists** (the memory-palace mnemonic
lists — see `MnemonicListDesignPrinciples.html` and
`json/memory_palace_room_database.json`) into the castle VR app.

Status: **Phases 1–3 built; Phase 4 (plaque) and true cross-room extension
pending.** Read alongside `LinearSequencesAndRoomObjects.md` (the run/corridor +
move-pair↔object model this builds on) and `CastleDataModel.md` (position-keyed
persistence).

---

## Concept

An **object list** is a named, ordered set of objects (Kitchen Fixtures, Planets,
Solfège…) with a justified ordering rule and an optional mnemonic phrase. Each
item can have an image **asset** (from the existing Manage Assets library) bound
to it.

You **apply a list to a wall** of a castle room (left, right, or whole room for a
single-run room). Each move-pair slot on that wall then shows the corresponding
list item — its **image asset** if one is bound, otherwise just the item's
**word** (e.g. "Oven") as a text label until an asset is assigned.

This turns a long forced line into a culturally-ordered walk (Refrigerator →
Countertop → Oven → Sink → Dishwasher) whose order is self-recovering.

---

## Resolved design decisions

1. **Implicit extension across rooms.** A wall list flows across consecutive
   rooms of a forced line. If a run spans 3 rooms, they share ONE list and ONE
   set of asset bindings; each room's wall picks up where the previous room's
   items ran out. `startIndex` is *computed* from the slot's position in the run,
   not hand-authored. Growing the line later automatically consumes more of the
   list.
2. **Item names are immutable keys.** The item name IS the stable binding key
   (`itemName → assetId`). No separate per-item IDs. Editing a list means
   add / remove / reorder items — never rename. (To "rename", remove and re-add;
   the binding is intentionally dropped.)
3. **Per-list-item asset binding; no global concept registry.** The same
   real-world object may use different images in different lists/houses (a
   different refrigerator style per castle). Bindings live on the list item, not
   on a shared concept.
4. **Apply-list lives in the in-VR room decoration panel.** Immersive, in-room.
   No separate outside-VR castle-management screen for this.

---

## Data model

### New IDB store: `objectLists`

```json
{
  "id": "kitchen_major_fixtures",
  "name": "Kitchen Major Fixtures",
  "roomName": "Kitchen",
  "category": "Home",
  "orderingType": "procedural",
  "orderingRule": "Food lifecycle: retrieve → prep → cook → hand-wash → machine-clean",
  "items": [
    { "name": "Refrigerator", "assetId": null },
    { "name": "Countertop",   "assetId": null },
    { "name": "Oven",         "assetId": null },
    { "name": "Sink",         "assetId": null },
    { "name": "Dishwasher",   "assetId": null }
  ],
  "mnemonic": {
    "type": "generated_phrase",
    "initialism": "RCOSD",
    "phrase": "Raw Chicken, Oven-baked. Soapy Dish.",
    "source": "Project mnemonic"
  }
}
```

- `assetId` references a record in the existing `assets` store. `null` → text-label fallback.
- `name` (item) is the immutable binding key.

### Room decoration gains `wallLists`

```json
{
  "wallLists": {
    "left":  { "listId": "kitchen_major_fixtures" },
    "right": { "listId": "music_room_solfege" },
    "all":   null
  }
}
```

- `"all"` for single-run undivided rooms; `"left"` / `"right"` for two-track rooms.
- No `startIndex` stored — it is derived from the slot's ordinal position within
  the run at render time (decision 1).

### Import

The `json/memory_palace_room_database.json` format maps directly: each `list`
inside each `room` becomes an `objectLists` record. Re-import **preserves
existing `assetId` bindings** by matching on immutable item `name`.

---

## Integration with existing systems

| System | Change |
|---|---|
| Manage Assets modal | Unchanged. Still the source of VR object images. |
| **New:** Manage Object Lists modal | Owns `objectLists`. Reuses the asset picker to bind assetId per item. |
| Castle VR room (`threeTest.js`) | Reads `wallLists`; per slot renders asset, or text-label prop if `assetId` null. |
| Room decoration edit mode | New "Apply list to this wall" picker (decision 4). |
| Full Backup | `objectLists` added (backup version bump). |
| Hints toggle | Mnemonic-phrase plaque hidden in self-test, shown when hints on. |

---

## Phasing

### Phase 1 — List database (no VR)  ✅ built
- **Manage Object Lists** modal: list index (left) + selected-list detail (right).
- Item table: position · object name · assigned asset thumbnail / "None" · [Pick Asset].
- **[Import JSON]**: parse the room-database JSON, upsert into `objectLists`,
  preserve existing `assetId` bindings by item name.
- [New List] / [Edit] / [Delete] manual authoring; asset picker reused.
- Fully independent; immediately useful. No VR changes.

### Phase 2 — Apply lists to walls (text labels in VR)  ✅ built
- Wall-list picker in room decoration (in-VR 📋 toolbar button → Wall object
  lists dialog): Left / Right for two-track rooms, else a single Room bucket;
  lists sorted by how well item count matches the run length (exact match flagged).
- Store `wallLists` in room decoration (`LAYOUT[roomKey].wallLists`, carried by
  the existing threeLayout backup).
- VR: for each slot on an assigned wall, if `assetId` null render a **word plaque**
  (canvas-text). Walkable immediately. A slot's item index is its position in the
  room's walk order (center → left → right); the two-track shared head is not
  list-driven.

### Phase 3 — Image assets render in VR  ✅ built
- `assetId` non-null → render the bound asset as a prop at the slot (reuses the
  existing placement / nudge / scale). The item's word shows as a **hint-gated
  subtitle** at the object's base (hidden with hints off for pure self-test).
- Editing a binding in Manage Object Lists propagates on the next tour open
  (rendering resolves from the live OBJECT_LISTS cache); asset-image edits made
  from the in-VR asset library propagate immediately via refreshAssetsLive.
- A manual per-slot asset override still wins over the list, letting a single
  item be swapped without touching the shared list.

### Phase 4 — Mnemonic phrase plaque  (pending)
- Wall-mounted plaque near entrance shows the applied list's mnemonic phrase
  (one per wall if two lists). Ordering rule in smaller text beneath.
- Respects hints toggle.

---

## Notes / deferred

- **Recommended start:** Phase 1 (independent, no VR risk). Phases 2 and 3 differ
  only by a null check on `assetId` and can ship together.
- **Run-length matching** in the wall picker is a convenience sort, not a
  constraint — a list may be longer (extra items dormant, decision 1) or shorter
  (wall slots past the list end fall back to whatever they had).
- **Immutable-name consequence:** the Manage Object Lists editor should not offer
  a rename control — only add / remove / reorder — to avoid silently orphaning
  asset bindings.
- **Cross-room implicit extension (decision 1) not yet built.** Phases 2–3 apply
  a list per room (a wall's slots, in order, `startIndex` 0). A list flowing
  across a multi-room forced line — room 2 picking up where room 1's items ran
  out — waits on the run-chaining infrastructure that lays a run out across
  rooms (see `LinearSequencesAndRoomObjects.md`), which doesn't exist yet. A
  single room already holds a multi-pair sequence (up to ~7 deep), so per-room
  application is the useful shippable piece.
