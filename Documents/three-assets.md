# Three.js Asset Pipeline (PNG skin + JSON spec)

Design for how art assets get into the Three.js walking prototype
(`js/threeTest.js`) without hand-coding primitive geometry per object, the
way `FURNITURE_BUILDERS` (table/chair/chest) does today. Nothing in this
file is implemented yet — it's the agreed plan so a future agent can pick
it up without re-deriving it.

## The core idea

Every visual asset is a pair of files with a shared name:

```
grandfather-clock-style-1.png
grandfather-clock-style-1.json
```

The PNG is generated with AI image tools (no in-house art pipeline). The
JSON tells the engine how to turn that flat image into a 3D thing: what
shape to put it on, how big that shape is in real-world meters, and what
color the parts of the shape the image doesn't cover should be.

This keeps geometry code generic and pushes all the per-object decisions
(size, which faces are visible, billboard vs. solid) into data, so adding
a new prop or texture never requires touching `threeTest.js` itself.

## Two asset categories

Don't use one schema for everything — "a grandfather clock" and "a brick
wall texture" are different shapes of problem:

- **Props** (`type: "box"`, `"billboard-cylindrical"`, `"billboard-sprite"`)
  — a discrete object placed at a specific `(x, z, yaw)` in a room, with an
  explicit size in meters. Furniture, signs, trees, birdbaths.
- **Surfaces** (`type: "surface"`) — a tileable material applied across
  geometry the room-builder already constructs (floors, walls, stair
  tops). These don't have a fixed size — they need a *repeat density*
  instead, since the same texture has to look right whether it's applied
  to a 10m room or the 90m Main Street.

Mixing these into one schema means most fields are meaningless for most
assets (a floor texture has no "yaw", a chest has no "repeat density").
Keep them separate.

## Prop types

### `box`

A rectangular box with one face skinned by the PNG and the rest given a
flat color. This is the workhorse type — covers furniture, signs, crates,
anything that's basically a rectangular solid viewed mostly from one side.

```json
{
  "id": "grandfather-clock-style-1",
  "type": "box",
  "texture": "grandfather-clock-style-1.png",
  "size": { "w": 0.5, "h": 1.5, "d": 0.5 },
  "skinFace": "front",
  "sideColor": "#5e3a1a"
}
```

- **`size`** — width / height / depth in meters. This is the field that
  makes AI-generated art workable at all: the image itself carries no
  sense of scale, so the JSON is the single source of truth for how big
  the object is in the world.
- **`skinFace`** — which face gets the texture. `"front"` is the default
  and covers anything meant to go against a wall (back face never seen,
  top usually not seen either). Freestanding objects viewable from more
  than one side can use `"front+top"` or a per-face map — not needed for
  the common case, so keep it as an escape hatch rather than the default.
- **`sideColor`** — flat color (hex) applied to every face except the
  skinned one(s). Should be picked to roughly match the dominant edge
  color of the PNG so the box doesn't look like a sticker slapped on a
  mismatched block.
- **Front convention** — an asset's "front" always faces local `-z`
  before any instance rotation is applied. This matches the yaw
  convention already used for furniture placement (`room.furniture.yaw`),
  so a prop and a piece of hand-coded furniture rotate the same way.
- **Aspect ratio** — generate the PNG at the same aspect ratio as the
  face it's skinning (e.g. a 0.5w × 1.5h face → a tall image), so the
  texture isn't stretched. This is a generation-discipline rule, not
  something the engine corrects for; add a `fit` field later only if a
  mismatch actually comes up in practice.

### `billboard-cylindrical`

A flat plane that rotates around the Y axis to always face the camera's
horizontal angle, but never tilts up/down. This is the right choice for
anything planted in the ground and viewed from a roughly-eye-level camera
— trees, lampposts, a birdbath — because a full always-face-camera sprite
would visibly lean as the camera looks up or down at it.

```json
{
  "id": "birdbath-style-1",
  "type": "billboard-cylindrical",
  "texture": "birdbath-style-1.png",
  "size": { "w": 0.8, "h": 1.0 }
}
```

- **`size`** — width/height only; there's no depth for a flat plane.
- PNG should have a transparent background. The loader applies
  `alphaTest` (hard cutout) rather than alpha blending by default —
  blending causes draw-order artifacts when billboards overlap, a known
  three.js sprite pitfall. This isn't a per-asset JSON field; it's just
  how the billboard loader works, so asset authors don't need to
  remember to set it.

### `billboard-sprite`

A full always-faces-camera sprite (`THREE.Sprite`), tilts in every axis to
fully front the camera. Rare — appropriate for something like a distant
flat icon or a particle-style effect, not for anything meant to look
planted in the world. Same fields as `billboard-cylindrical`.

## Surface type

### `surface`

A tileable material applied to floors, walls, or stair tops by the room
builder. Replaces the current procedural canvas textures
(`makeFloorTexture()`, `makeBrickTexture()`) once real PNG assets exist.

```json
{
  "id": "floor-planks-oak-1",
  "type": "surface",
  "texture": "floor-planks-oak-1.png",
  "repeatPerMeter": 0.5,
  "rotation": 0,
  "tint": null,
  "roughness": 0.85,
  "metalness": 0.0
}
```

- **`texture`** — a small tileable square image (e.g. 512×512), unlike
  prop textures which are one-shot, non-repeating images.
- **`repeatPerMeter`** — how many texture tiles per meter of the surface
  it's applied to. The room builder computes
  `repeat = (surfaceWidthMeters * repeatPerMeter, surfaceDepthMeters * repeatPerMeter)`
  itself, so the same asset looks consistent at any room size — fixes the
  current code's wart of hand-picking `repeat.set(w/2, d/2)` per call,
  which only looks right because every room today happens to be ~10m.
- **`rotation`** — `0` or `90` degrees, for grain-direction textures
  (planks) that need to run along either room axis without a second
  image. Optional, defaults to `0`.
- **`tint`** — optional hex color, multiplied over the texture. Lets one
  neutral stone/plank/brick texture be reused across rooms with different
  palettes (the way `roomB`/`roomC` today get reddish/greenish walls from
  a single brick-texture function) without generating a separate PNG per
  color. `null`/omitted = no tint.
- **`roughness` / `metalness`** — passed straight through to
  `MeshStandardMaterial`. Optional with sane defaults so most assets can
  omit them.
- **Walls keep their door cutouts as real geometry.** `surface` only
  controls the *texture* applied across whatever wall segments
  `buildWallGroup()` already builds (segments split around the doorway
  gap) — it has no opinion about doors, which stay a geometry concern.

### `facade`

A one-shot (non-tiling) texture stretched across a whole building front,
the way `b.frontTexture` already works in `buildRoom()`. Unlike `surface`
it has no `repeatPerMeter` — the image maps once over the entire facade, so
it carries the building's actual proportions (e.g. a ~2.5:1 image for a
50m-wide, 20m-tall front).

```json
{
  "id": "townhouse-front-1",
  "type": "facade",
  "texture": "townhouse-front-1.png",
  "tint": null,
  "roughness": 0.9,
  "metalness": 0.0
}
```

Facade assets are authored and **exported** in the Asset Manager but are not
slot-placeable in the in-world editor — they're wired into a room's building
config by hand (same as the existing `frontTexture`), because a facade's
placement is the building, not a furniture slot.

## Import resolution

The Asset Manager down-converts every uploaded PNG on import (it never
stores more pixels than a ~10m room can show). The author picks a tier
(**Low / Normal / High**, default Normal); the tier plus the asset's
category set the **long-edge** pixel cap. Aspect ratio is always preserved
(fit-within-box, never cropped or squashed), and `4096` is the hard ceiling
(the WebGL2 max-texture-size safe on essentially all hardware).

| Category | Types | Low | **Normal** | High |
|---|---|---|---|---|
| tiled  | `surface` (repeats across a wall — least needed)        | 256  | **512**  | 1024 |
| object | `box`, `billboard-*` (viewed at object scale, 1–3m)    | 256  | **512**  | 1024 |
| large  | `facade` (one-shot, spans a whole ~50m building front) | 1024 | **2048** | 4096 |

The chosen tier is stored on the asset record (`resolution`) so a soft-looking
asset can be re-imported at a higher tier later without guessing. Only the
down-converted image is persisted — the original full-res upload is discarded
once import completes.

## How rooms reference assets

Instance placement (where a prop sits, what surface a room uses) stays in
the existing `ROOMS` config — the JSON files only describe the asset
itself, never its position:

```js
roomB: {
  floor: 'floor-planks-oak-1',
  wallSurface: 'brick-blue-1',
  furniture: { asset: 'grandfather-clock-style-1', x: 3.2, z: -3.2, yaw: Math.PI },
  ...
}
```

`FURNITURE_BUILDERS` (today: three hand-coded functions keyed by
`type: 'table' | 'chair' | 'chest'`) becomes one generic loader keyed by
`asset` id instead, and the procedural `makeFloorTexture()` /
`makeBrickTexture()` functions go away once real surface assets replace
them.

## Loading mechanics

Same pattern the prototype already uses for `frontTexture` on building
facades (see `b.frontTexture` handling in `buildRoom()`): fetch the JSON,
fetch the PNG via `THREE.TextureLoader` (already cached by default), and
build a small factory function from the result. No new loading
infrastructure needed — this is an extension of an existing code path,
not a new one.

## Open items (decide when actually implementing)

- Where asset files live — likely `assets/three/props/` and
  `assets/three/surfaces/`, mirroring the existing
  `assets/three/textures/` used for facade images.
- Whether `box` needs a per-face color/skin map beyond `"front"` /
  `"front+top"` before any real multi-sided prop is authored, or whether
  to wait until one is actually needed.
- Whether `fit: "stretch" | "contain"` is worth adding to `box`/billboard
  types, or whether aspect-ratio discipline at image-generation time is
  sufficient (current bet: discipline is sufficient until proven
  otherwise).
