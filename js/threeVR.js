/* ---------- Three.js integration prototype ----------
   "Feel test" for a loci-style memory layout: an outdoor street/courtyard
   containing one building you can walk up to and enter. The building's
   interior is the same two-doorway, three-room layout from the earlier
   iteration of this prototype, now reached by walking through its front
   door instead of just spawning inside it.
*/
import { openAssetPicker } from './assets.js?v=20260804-79';
import { openNewObjectListModal } from './objectLists.js?v=20260804-55';

let THREE = null;

// Every full-screen overlay here (help, room geometry, wall lists, ...)
// closes on a "click the dark backdrop" gesture -- but a plain
// `ov.onclick = e => e.target === ov` check misfires on an ordinary
// text-selection DRAG that starts inside the modal's own content (a size
// field, a paragraph of text) and ends with the mouse out over the backdrop:
// browsers fire the resulting "click" on the nearest common ancestor of the
// mousedown and mouseup targets, which IS the overlay itself once the drag
// has left the content, silently closing the modal (reported live, from the
// New Asset modal: sweep-selecting a size field to overtype it made the
// whole modal vanish, no console error). Only close when BOTH the mousedown
// and the click itself landed directly on the backdrop, not just the click.
// Re-wiring a PERSISTENT singleton overlay (most of these -- created once via
// document.getElementById(id) || createElement, then reused across many
// opens) would otherwise stack a fresh pair of listeners on every open, each
// closing over that invocation's own `onClose`; only the two most recent
// ever get removed automatically (on an actual backdrop click), so a dialog
// reopened many times via its Close button/Escape instead would leak one
// stale pair per open. Storing the current pair on the element and removing
// it first makes repeated calls idempotent regardless of how it was closed.
function wireBackdropClose(ov, onClose, opts){
  if(ov._backdropMousedown) ov.removeEventListener('mousedown', ov._backdropMousedown);
  if(ov._backdropClick) ov.removeEventListener('click', ov._backdropClick);
  let downOnBackdrop = false;
  ov._backdropMousedown = e => { downOnBackdrop = e.target === ov; };
  ov._backdropClick = e => { if(downOnBackdrop && e.target === ov) onClose(); };
  ov.addEventListener('mousedown', ov._backdropMousedown);
  ov.addEventListener('click', ov._backdropClick, opts);
}

/* asset types that can sit in a slot (props, not surfaces). Cylindrical
   listed first -- it's the right choice for almost everything (see
   buildBillboardAsset), and callers that default a new asset's type to
   allow[0] (e.g. assets.js's picker "+ New Asset" button) should land there
   instead of "extruded". 'billboard-sprite' (a full always-faces-camera
   sprite) was removed as choosable -- db.js's getAllAssets normalizes any
   already-saved asset of that type to 'billboard-cylindrical' on read, so
   it keeps rendering the same way instead of breaking. */
const PROP_TYPES = ['billboard-cylindrical', 'extruded'];

const ROOMS = {
  mainStreet: {
    outdoor: true,
    size: { w: 90, d: 50, h: 7 },
    exits: [],
    // flat-color asphalt strips over the grass base -- Main St runs the
    // full depth of the room, London Avenue branches off it to the east
    roads: [
      { x: 0, z: 0, sx: 8, sz: 50 },
      { x: 21, z: -5, sx: 34, sz: 8 }
    ],
    streetSigns: [
      { text: 'London Avenue', x: 6, z: -6 }
    ],
    buildings: [
      // sits just north of London Avenue, so walking up the avenue and
      // turning to face north brings you right up to its front door
      { target: 'start', sign: 'Chigorin Mansion', frontTexture: 'assets/three/textures/chigorin_mansion_front.jpg',
        color: 0x6f8fb0, size: { w: 25, d: 10, h: 10 }, origin: { x: 20, z: -19 }, doorWall: 'south', doorOffset: 0 }
    ]
  },
  start: {
    color: 0x6f8fb0,
    size: { w: 10, d: 10, h: 4 },
    label: { wall: 'west', text: '1' },
    furniture: { type: 'table', x: -3.2, z: 3.2, yaw: 0 },
    // extra hand-placed wall mount, beyond the procedural floor grid and
    // door-flanking wall slots (see roomSlots()) -- a spot with no door nearby.
    slots: [
      { id: 'w-west', kind: 'wall', wall: 'west', offset: 0, y: 1.6 }
    ],
    exits: [
      { wall: 'north', offset: 0, target: 'roomB', type: 'elevator' },
      { wall: 'east',  offset: 0, target: 'roomC' },
      { wall: 'south', offset: 0, target: 'mainStreet', back: true }
    ]
  },
  // the elevator car for start's north exit (marked type:'elevator' below) --
  // a real, decoratable room, just sized like a (generously roomy) freight
  // elevator. Its own exits become floor buttons on the forward wall instead
  // of separate doors (see isElevatorCar/buildRoom), except the back:true
  // exit, which gets a single physical door directly opposite the one you
  // walked in through.
  roomB: {
    color: 0xb07070,
    name: 'Kitchen',           // hard-coded demo room name (will be data-driven)
    size: { w: 4, d: 4, h: 3 },
    slots: [
      { id: 'w-east', kind: 'wall', wall: 'east', offset: 0, y: 1.6 },
      { id: 'w-west', kind: 'wall', wall: 'west', offset: 0, y: 1.6 }
    ],
    exits: [
      { wall: 'south', offset: 0, target: 'start', back: true },
      { wall: 'north', offset: 0, target: 'roomB1', label: 'e6' },
      { wall: 'north', offset: 0, target: 'roomB2', label: 'f6' },
      { wall: 'north', offset: 0, target: 'roomB3', label: 'Nf6' }
    ]
  },
  roomB1: {
    color: 0x9a7a50,
    size: { w: 10, d: 10, h: 4 },
    label: { wall: 'north', text: '4' },
    furniture: { type: 'chest', x: -3.2, z: -3.2, yaw: 0 },
    exits: [
      { wall: 'south', offset: 0, target: 'roomB', back: true }
    ]
  },
  roomB2: {
    color: 0x6f9a7a,
    size: { w: 10, d: 10, h: 4 },
    label: { wall: 'north', text: '5' },
    furniture: { type: 'chair', x: 3.2, z: -3.2, yaw: Math.PI },
    exits: [
      { wall: 'south', offset: 0, target: 'roomB', back: true }
    ]
  },
  roomB3: {
    color: 0x7a7a9a,
    size: { w: 10, d: 10, h: 4 },
    label: { wall: 'north', text: '6' },
    furniture: { type: 'table', x: 3.2, z: 3.2, yaw: 0 },
    exits: [
      { wall: 'south', offset: 0, target: 'roomB', back: true }
    ]
  },
  roomC: {
    color: 0x70b078,
    name: 'Study',             // hard-coded demo room name (will be data-driven)
    size: { w: 10, d: 10, h: 4 },
    label: { wall: 'east', text: '3' },
    furniture: { type: 'chest', x: 3.2, z: 3.2, yaw: Math.PI/4 },
    slots: [
      { id: 'w-north', kind: 'wall', wall: 'north', offset: 0, y: 1.6 }
    ],
    exits: [
      { wall: 'west', offset: 0, target: 'start', back: true }
    ]
  }
};

const DOOR_W = 2.2;
const DOOR_H = 2.6;
// Door skin art often isn't a perfectly rectangular door leaf -- columns,
// bases, or a frame can extend past the plain-rectangle bounding box the
// wall's opening is cut to. A door panel textured at exactly DOOR_W x DOOR_H
// then leaves any transparent margin inside the image sitting INSIDE the
// opening, showing the wall/bricks behind it through the gap. Rendering the
// panel slightly larger than the opening lets that margin (if any) bleed
// onto the surrounding wall instead, hiding the seam -- harmless for a
// perfectly-rectangular asset (reads as a normal door casing/trim) and a
// real fix for one that isn't. DOOR_SKIN_BASE_OVERSIZE is a small default
// applied to every door; a per-asset `oversizePct` (Asset Manager, door
// skins only) adds on top for assets that need more.
const DOOR_SKIN_BASE_OVERSIZE = 0.03;   // 3%, applied to every door skin
const WALL_THICK = 0.25;
const EYE_HEIGHT = 1.6;
const STAIR_STEP_RISE = 0.2;  // a stair-exit corridor's climbing steps, in meters
const STAIR_STEP_RUN = 0.3;
// When the player gets within this distance of a down-staircase doorway, the
// camera pitches down so the descending steps come into view (real stairs go
// straight down, so a level gaze would otherwise miss them).
const STAIR_DOWN_PEEK_DIST = 1.0;   // meters from the doorway
const STAIR_DOWN_PEEK_PITCH = -Math.PI/6;   // 30 degrees down
// When a gizmo-eligible prop (see GIZMO_KINDS) is selected in edit mode, the
// camera eases up and tilts (down, or up for a ceiling prop -- see tick())
// slightly. This keeps the horizontal drag arrows (see roomAxes' own comment)
// from ever appearing edge-on: edit mode otherwise holds pitch dead level,
// and a purely horizontal arrow viewed from a purely horizontal line of
// sight foreshortens to a sliver right where the arrows already share their
// common origin.
const EDIT_TILT_PITCH = -Math.PI/18;   // 10 degrees down, for floor/moveObject/mnemonic
const EDIT_TILT_LIFT = 1.0;            // meters
// a ceiling prop's up-tilt is aimed at the actual hang-point instead of
// this fixed a magnitude (see tick()) -- these just bound how shallow/steep
// that aim is allowed to end up.
const EDIT_TILT_UP_MIN = Math.PI/18;   // 10 degrees -- same floor as the down-tilt case
const EDIT_TILT_UP_MAX = Math.PI/3;    // 60 degrees -- generous, but short of a disorienting near-vertical look
// stair exits come in two directions: 'stair' climbs up, 'stair-down' descends.
// stairDir gives +1 / -1 (0 for non-stairs); isStairType tests either.
const isStairType = t => t === 'stair' || t === 'stair-down';
const stairDir = t => t === 'stair' ? 1 : (t === 'stair-down' ? -1 : 0);
const MOVE_SPEED = 4.2;   // m/s
const TURN_SPEED = 1.8;   // rad/s

// where you start, and where pressing R returns you
const START_ROOM = 'mainStreet';
const START_SPAWN = { x:0, z:18, yaw:0 };

// the opening systems handed in by the app (id/name/streetName/color), used to
// lay out Main Street and its branching side streets.
let OPENING_SYSTEMS = [];

/* Rebuild ROOMS.mainStreet from the opening systems: Main Street runs N-S, and
   each system gets a perpendicular side street branching off it -- white (and
   anything non-black) to the right/east (+x), black to the left/west (-x), each
   at its own point as you walk up the street. Each branch gets a green street
   sign. For now the test palace (the existing 'start' interior) is parked on the
   first white street so there's something to walk into. */
/* streetCastles: [{lineId, castleName, streetNumber, entryKey}] — every BUILT
   castle (root move has a reply), already registered as cas:* rooms. Each one
   becomes a building on its opening system's side street, ordered by street
   number (lower = closer to Main Street; unnumbered follow, alphabetical). */
function generateMainStreet(systems, streetCastles){
  const MAIN_W = 8, SIDE_W = 7, SPACING = 24, MARGIN = 10;
  const BW = 14, BD = 8, BH = 9, BGAP = 15, FIRST_X = 6;   // castle-building slots along a side street (BGAP: gap between buildings; wide so skinned facades don't touch)
  const WORLD_PAD = 50;   // grass beyond the built content on every side, so there's always comfortable room to walk/build without immediately running out again
  const list = (systems && systems.length)
    ? systems
    : [{ name:'Main', streetName:'Main Street', color:'white' }];
  const n = list.length;
  const startZ = -((n - 1) * SPACING) / 2;
  const depth = (n - 1) * SPACING + 2 * MARGIN + SIDE_W + 8;

  // group built castles by system, ordered by street number
  const bySystem = new Map();
  for(const c of (streetCastles || [])){
    if(!bySystem.has(c.lineId)) bySystem.set(c.lineId, []);
    bySystem.get(c.lineId).push(c);
  }
  for(const arr of bySystem.values()){
    arr.sort((a, b) => {
      const an = a.streetNumber ?? Infinity, bn = b.streetNumber ?? Infinity;
      return (an - bn) || String(a.castleName).localeCompare(String(b.castleName));
    });
  }

  // every side street is long enough for the biggest street's buildings
  let sideLen = 32;
  for(const arr of bySystem.values()){
    sideLen = Math.max(sideLen, FIRST_X + arr.length * (BW + BGAP) + MARGIN);
  }
  const width = 2 * (MAIN_W / 2 + sideLen) + 2 * MARGIN;

  const roads = [{ x: 0, z: 0, sx: MAIN_W, sz: depth }];   // Main Street, full depth
  const streetSigns = [];
  const buildings = [];

  list.forEach((sys, i) => {
    const east = sys.color !== 'black';     // white / unspecified branch right (east)
    const side = east ? 1 : -1;
    const z = startZ + i * SPACING;
    roads.push({ x: side * (MAIN_W / 2 + sideLen / 2), z, sx: sideLen, sz: SIDE_W });
    streetSigns.push({
      streetSign: true,
      text: sys.streetName || sys.name,
      cross: 'Main Street',
      axis: east ? 'east' : 'west',
      side,
      x: side * (MAIN_W / 2 + 1.2),
      z: z + SIDE_W / 2 + 1.2,
      // the opening move for this system, shown as an editable tile under the sign
      lineId: sys.id,
      openingMove: sys.openingMove || '',
      openingImg: sys.openingImg || '',
      openingWord: sys.openingWord || '',
      // Black systems only: our prepared reply to the opening move, shown as
      // a door-style opponent/response pair composite instead of the plain
      // single-move tile (see systemsForWalk in app.js for why).
      replyPair: sys.replyPair || null
    });
    // this system's built castles: one building each on the north side of its
    // street, door facing south onto it; lower street number = closer to Main St.
    (bySystem.get(sys.id) || []).forEach((c, k) => {
      const xInner = MAIN_W / 2 + FIRST_X + k * (BW + BGAP) + BW / 2;
      buildings.push({
        target: c.entryKey,
        sign: c.castleName,
        color: 0x6f8fb0,
        size: { w: BW, d: BD, h: BH },
        origin: { x: side * xInner, z: z - (SIDE_W / 2 + BD / 2 + 1) },
        doorWall: 'south', doorOffset: 0,
        entryOccurrence: c.entryOccurrence
      });
    });
  });

  // width/depth above are a sensible ESTIMATE from counts and spacing, sized
  // to comfortably contain the street network. As a hard guarantee against a
  // castle ever ending up floating outside the grass -- whether from an edge
  // case in that estimate, or (mainStreet being fully procedural) a stale
  // LAYOUT.mainStreet.geom override left over from a manual resize back when
  // there was less content -- measure the REAL bounding box of everything
  // just placed and never let the final ground size be smaller than that,
  // plus WORLD_PAD of breathing room on every side. (The stale-override half
  // of this guarantee is enforced in mergedRoom(), which never lets a saved
  // override shrink mainStreet below this freshly-computed minimum.)
  let maxX = width / 2, maxZ = depth / 2;
  for(const r of roads){
    maxX = Math.max(maxX, Math.abs(r.x) + r.sx / 2);
    maxZ = Math.max(maxZ, Math.abs(r.z) + r.sz / 2);
  }
  for(const b of buildings){
    maxX = Math.max(maxX, Math.abs(b.origin.x) + b.size.w / 2);
    maxZ = Math.max(maxZ, Math.abs(b.origin.z) + b.size.d / 2);
  }
  const finalWidth = 2 * maxX + 2 * WORLD_PAD;
  const finalDepth = 2 * maxZ + 2 * WORLD_PAD;

  ROOMS.mainStreet = { outdoor: true, size: { w: finalWidth, d: finalDepth, h: 7 }, exits: [], roads, streetSigns, buildings };
  START_SPAWN.x = 0; START_SPAWN.z = depth / 2 - 4; START_SPAWN.yaw = 0;   // spawn at the south end of the paved street itself, not the padded grass beyond it
}

/* ---------- G2a: walk a GENERATED castle ----------
   Turn the app's buildGeneratedCastle output (genRooms with walls + exits) into
   navigable ROOMS, one per generated room, wired room-to-room by doors. This is
   the structural skeleton: doors + back-links + a wall sign listing each room's
   moves. Rich move-pair billboards, two-track object slots, and per-position
   decoration persistence come in later phases. Returns {entryKey, spawn}. */
let CASTLE_ENTRY = null;
function clearGeneratedCastle(){
  for(const k of Object.keys(ROOMS)) if(k.startsWith('cas:')) delete ROOMS[k];
  for(const k of Object.keys(DEMO_MNEMONICS)) if(k.startsWith('cas:')) delete DEMO_MNEMONICS[k];
  CASTLE_ENTRY = null;
}
// shared layout metrics for generated-castle rooms, used both to size a room's
// depth and to place its move-pair billboards, so the two always agree. z is
// measured from room center; the south entrance is at +d/2, north wall at -d/2.
const CAS_LAYOUT = {
  entrySetback: 1.5,   // spawn/viewpoint this far in from the south wall
  centerAhead:  4.5,   // center (anchor) pair this far north of the viewpoint — a few meters of runway from the door
  sideFirst:    2.0,   // first left/right pair this far north of the center pair
  sideStride:   3.0,   // each subsequent side pair this much farther north
  northMargin:  2.0    // clearance kept between the farthest pair and the north wall
};
// door/pair spacing metrics -- module-level (not just local to
// registerOneCastle) so renderRoomGeomDialog's relaxedContentMin can reuse
// the exact same formula against a room's LIVE content when computing how
// far a room can be manually shrunk, without duplicating the numbers.
const DOOR_SPACING = 5.6;      // center-to-center; DOOR_W is 2.2. Wide enough to
                               // clear the move-pair + object sitting to the LEFT
                               // of each door (was 3.6 before they moved there)
const EDGE_MARGIN = 1.6;       // keep a door's half-width off the wall corners
// the move-pair + object sit to the LEFT of each door -- ~1.7 m off the door
// centre (doorSideXZ) plus ~0.6 m for half the billboard. The edge door needs
// this much clear to the side wall so its pair doesn't poke through.
const PAIR_MARGIN = 2.8;
const EW_BEHIND_HEAD = 3;      // closest left/right door sits this far north of the head mnemonic (center anchor pair)
// how far past its sibling member's wall slot a member-anchored side-door's
// DOOR sits (memorized-room-stability's side-doors) -- set to exactly cancel
// out doorSideXZ's own "pair sits DOOR_W/2+0.6 before the door" shift, so a
// member-anchored door's pair billboard lands ON its sibling's own z (lines
// up with it) while the door itself ends up that same distance past it.
const MEMBER_DOOR_OFFSET = DOOR_W / 2 + 0.6;
// Stable door ordering (navigation memory): a door's wall is derived from its
// own target position, not its index among the current doors, so adding/removing
// a variation never makes an existing door jump walls. `doorCmp` then orders the
// doors on a wall by move, an intrinsic, regeneration-invariant key.
function doorWallFor(key){
  let h = 0; const s = String(key || '');
  for(let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return ['north', 'east', 'west'][((h % 3) + 3) % 3];
}
const doorCmp = (a, b) =>
  (a.opp || '').localeCompare(b.opp || '') ||
  String(a.toKey || a.foreignKey || '').localeCompare(String(b.toKey || b.foreignKey || ''));
/* Register ONE generated castle's rooms under a namespace. instanceId is a
   stable id derived from lineId+castleName (or 'preview' for the report's
   ephemeral Walk in VR), so two castles that independently transpose into the
   same chess position still get separate rooms/decorations. A nested castle
   reached from within another's own tree is different: buildCastleGraph
   redirects that edge to the nested castle's own room key up front (see its
   foreign-exit handling), so this function never has to special-case it --
   the exit just targets whatever key it's given, local or foreign. opts.
   backToStreet gives the entry room a south back door out to mainStreet (used
   when a matching street building exists to spawn in front of). Returns
   {entryKey, spawn}. */
function registerOneCastle(castle, instanceId, opts = {}){
  const genRooms = (castle && castle.genRooms) || [];
  if(!genRooms.length) return null;
  // key each room by instance + its STABLE position (posKey), not the R# order,
  // so LAYOUT decorations persist across regeneration (G3). Doors target the
  // same stable key (ex.toKey). Sanitize to a safe id; fall back to R#.
  const inst = String(instanceId || 'preview').replace(/[^a-zA-Z0-9_]/g, '_');
  const keyOf = posKey => `cas:${inst}:` + String(posKey || '').replace(/[^a-zA-Z0-9]/g, '_');
  const roomKeyFor = r => keyOf(r.posKey || r.id);
  // back-link: the room that holds a built forward exit to this one is its parent
  const parent = {};   // child posKey -> parent posKey
  for(const r of genRooms) for(const ex of r.exits) if(ex.toKey && !(ex.toKey in parent)) parent[ex.toKey] = r.posKey;
  const entry = genRooms[0];                 // R1 is the entry (numbering is entry-first)
  const entryKey = roomKeyFor(entry);
  CASTLE_ENTRY = entryKey;
  // the castle these rooms belong to (its entry/root room carries the name).
  // A room whose OWN castle-root name differs from this is a boundary into a
  // different castle -- its door gets the two-line castle plaque.
  const ownerCastle = (genRooms[0] && genRooms[0].castle) || '';
  for(const r of genRooms){
    // depth needed for the wall move-pairs: the center pair sits near the
    // entrance and each left/right pair marches ~3 m farther north, so the room
    // grows ~3 m per side pair (of whichever wall has the most). See CAS_LAYOUT.
    const sideMax = Math.max(
      (r.pairs || []).filter(p => p.side === 'left').length,
      (r.pairs || []).filter(p => p.side === 'right').length);
    const pairDepth = sideMax >= 1
      ? CAS_LAYOUT.entrySetback + CAS_LAYOUT.centerAhead + CAS_LAYOUT.sideFirst
        + (sideMax - 1) * CAS_LAYOUT.sideStride + CAS_LAYOUT.northMargin
      : 0;
    // a foreign-castle exit (see buildCastleGraph's redirect) has no local
    // `to`/toKey but still needs a real door -- ex.foreignKey is its target.
    const fwd = r.exits.filter(ex => ex.to || ex.foreignKey);
    const span = c => (c > 1 ? (c - 1) * DOOR_SPACING : 0);
    // base.d is just a comfortable minimum floor -- the real depth for a
    // corridor comes from pairDepth above (it already scales with member
    // count via sideMax, using the same CAS_LAYOUT spacing the pairs are
    // actually placed with). A member-count-scaled floor here used to
    // override pairDepth with a cruder estimate, leaving the room several
    // meters longer than its last item needed (worst around 7 members: a
    // 35m floor vs. an actual ~25m pairDepth).
    const base = r.type === 'corridor'
      ? { w: 8, d: 12, h: 6 }
      : { w: 11, d: 13, h: 6 };
    const isTwoTrack = r.type === 'two-track';
    let sz;
    const doorPlacements = [];   // {wall, offset, ex}
    if(isTwoTrack){
      // two-track: a half-wall splits the room into a left and right lane, so each
      // track's exits leave through doors on the NORTH wall within its own half,
      // ordered by move so their relative order is stable across regenerations.
      const leftDoors = fwd.filter(ex => ex.track !== 'right').sort(doorCmp);
      const rightDoors = fwd.filter(ex => ex.track === 'right').sort(doorCmp);
      const maxSpan = Math.max(span(leftDoors.length), span(rightDoors.length));
      // each half's edge door needs PAIR_MARGIN to its side (wall on the outer
      // half, the centre divider on the inner half): 4*PAIR_MARGIN across the room.
      sz = { w: Math.max(base.w, 2 * maxSpan + 4 * PAIR_MARGIN), d: Math.max(base.d, pairDepth), h: base.h };
      const quarter = sz.w / 4;   // center of each half of the north wall
      const placeHalf = (list, cx) => list.forEach((ex, j) =>
        doorPlacements.push({ wall: 'north', offset: cx + (j - (list.length - 1) / 2) * DOOR_SPACING, ex }));
      placeHalf(leftDoors, -quarter);
      placeHalf(rightDoors, quarter);
    } else {
      // STABLE door layout for navigation memory: a door's wall is a hash of its
      // target position (intrinsic, so it never migrates when other doors are
      // added or removed), and doors on a wall are sorted by move — so existing
      // doors keep their wall AND relative order across regenerations; only a
      // genuinely new variation slots in. Room grows so doors never collide.
      // EXCEPTION: an exit whose source is an INTERIOR member of this room's
      // own wall sequence (fromSide/fromOrder -- memorized-room-stability's
      // side-doors, the only way that happens today) skips the hash entirely
      // and instead rides along with that member's own slot -- the generic
      // hash+hallway-entrance placement only ever made sense when every door
      // in the room belonged to the single anchor member, which an interior
      // side-door isn't.
      const byWall = { north: [], east: [], west: [] };
      const memberAnchored = [];   // {wall, ex} -- positioned near their own sibling member's slot, not hashed
      for(const ex of fwd){
        if((ex.fromSide === 'left' || ex.fromSide === 'right') && typeof ex.fromOrder === 'number'){
          memberAnchored.push({ wall: ex.fromSide === 'left' ? 'west' : 'east', ex });
        } else if(fwd.length === 1){
          // the room's only forward door -- opposite the entrance (south,
          // see this room's own back-door push below), same as a two-track's
          // pair always does. The hash exists to spread MULTIPLE doors
          // across walls without collisions; with only one door there's
          // nothing to spread, and landing it straight ahead as you walk in
          // is simplest to navigate.
          byWall.north.push(ex);
        } else {
          byWall[doorWallFor(ex.toKey || ex.foreignKey || ex.opp)].push(ex);
        }
      }
      for(const w of ['north', 'east', 'west']) byWall[w].sort(doorCmp);
      // more than one door can branch from the SAME sibling member -- a plain
      // branch at a corridor's own tail (the room's last member has 2+ opponent
      // continuations), not a two-track. Grouped here (keyed by which member
      // they're anchored to) so both the depth calc below and the actual
      // placement loop further down stagger a group's doors along the wall
      // instead of stacking them all on the exact same spot (previously: every
      // door in a group computed the identical siblingZ, so they collided).
      const memberGroups = new Map();   // 'side:order' -> [{wall, ex}, ...], insertion order
      for(const m of memberAnchored){
        const key = m.ex.fromSide + ':' + m.ex.fromOrder;
        if(!memberGroups.has(key)) memberGroups.set(key, []);
        memberGroups.get(key).push(m);
      }
      for(const group of memberGroups.values()) group.sort((a, b) => doorCmp(a.ex, b.ex));
      const maxMemberGroupSize = memberGroups.size ? Math.max(...[...memberGroups.values()].map(g => g.length)) : 0;
      // east/west ("left/right") doors sit at least EW_BEHIND_HEAD metres north
      // of the head mnemonic (center anchor pair) so it's clearly the first
      // thing you look at; grow the room deep enough to fit them behind it.
      const maxEW = Math.max(byWall.east.length, byWall.west.length);
      const ewDepth = maxEW >= 1
        ? CAS_LAYOUT.entrySetback + CAS_LAYOUT.centerAhead + EW_BEHIND_HEAD
          + (maxEW - 1) * DOOR_SPACING + EDGE_MARGIN
        : 0;
      // a member-anchored door's pair billboard lands on its SIBLING member's
      // own z (fromOrder+1 -- the member that already occupies "this branch
      // point," which the new option is an alternate to), same as the depth
      // calc below needs. Falls back to fromOrder itself when there's no
      // such sibling (the branch is past the room's current last member, not
      // interior to it) -- nothing to align with there, so it just extends
      // past the tail like an ordinary new door would.
      const siblingOrderFor = ex => {
        const has = (r.pairs || []).some(p => (p.side || 'left') === ex.fromSide && p.order === ex.fromOrder + 1);
        return has ? ex.fromOrder + 1 : ex.fromOrder;
      };
      // a member-anchored door rides MEMBER_DOOR_OFFSET past its sibling's
      // own slot -- only matters for room depth when that sibling is the
      // DEEPEST member on its wall (sideMax), since anywhere earlier is
      // already comfortably inside pairDepth's own margin. Plus however far
      // the largest same-sibling group's own stagger reaches beyond that.
      const memberDoorDepth = memberAnchored.length
        ? CAS_LAYOUT.entrySetback + CAS_LAYOUT.centerAhead + CAS_LAYOUT.sideFirst
          + (Math.max(...memberAnchored.map(m => siblingOrderFor(m.ex))) - 1) * CAS_LAYOUT.sideStride
          + MEMBER_DOOR_OFFSET + (maxMemberGroupSize - 1) * DOOR_SPACING + CAS_LAYOUT.northMargin
        : 0;
      sz = {
        // PAIR_MARGIN (not EDGE_MARGIN) each side so the leftmost north door's
        // pair, which overhangs ~2.3 m to its left, clears the west wall.
        w: Math.max(base.w, span(byWall.north.length) + 2 * PAIR_MARGIN),
        d: Math.max(base.d, pairDepth, ewDepth, memberDoorDepth),
        h: base.h
      };
      const centerZ = sz.d / 2 - CAS_LAYOUT.entrySetback - CAS_LAYOUT.centerAhead;   // head mnemonic z
      const ewSouth = centerZ - EW_BEHIND_HEAD;   // closest (southernmost) left/right door
      // north doors centered on the wall (x); east/west doors march north from
      // ewSouth (sorted[0] closest to the entrance, then farther in)
      byWall.north.forEach((ex, j) =>
        doorPlacements.push({ wall: 'north', offset: (j - (byWall.north.length - 1) / 2) * DOOR_SPACING, ex }));
      for(const wall of ['east', 'west'])
        byWall[wall].forEach((ex, j) => doorPlacements.push({ wall, offset: ewSouth - j * DOOR_SPACING, ex }));
      // member-anchored doors: MEMBER_DOOR_OFFSET (= doorSideXZ's own
      // DOOR_W/2+0.6 "pair sits before the door" shift) exactly cancels out,
      // so the pair billboard lands ON the sibling's own z (lines up with
      // it, as requested) while the door itself sits MEMBER_DOOR_OFFSET
      // beyond it -- past the sibling, farther from the entrance. When a
      // sibling has more than one such door (a branch at the room's own
      // tail), they fan out from that same base point by DOOR_SPACING --
      // group[0] (closest to the entrance) sits right at MEMBER_DOOR_OFFSET,
      // each later one marches one more DOOR_SPACING north, same convention
      // the plain byWall east/west doors already use.
      for(const group of memberGroups.values()){
        const siblingZ = centerZ - CAS_LAYOUT.sideFirst - (siblingOrderFor(group[0].ex) - 1) * CAS_LAYOUT.sideStride;
        group.forEach(({ wall, ex }, j) =>
          doorPlacements.push({ wall, offset: siblingZ - MEMBER_DOOR_OFFSET - j * DOOR_SPACING, ex }));
      }
    }
    const exits = [];
    // back door (south) → parent room. The entry room instead exits to the
    // street when a matching street building exists (opts.backToStreet); in the
    // ephemeral report-preview walk there is no building, so no back door
    // (leave via the Close button).
    if(parent[r.posKey]) exits.push({ wall: 'south', offset: 0, target: keyOf(parent[r.posKey]), back: true });
    else if(r === entry && opts.backToStreet) exits.push({ wall: 'south', offset: 0, target: 'mainStreet', back: true });
    for(const dp of doorPlacements) exits.push({ wall: dp.wall, offset: dp.offset,
                                                 // a foreign exit's key is already the OTHER castle's own
                                                 // room key (computed the same way its own walk would) --
                                                 // use it directly instead of forging THIS instance's prefix.
                                                 target: dp.ex.foreignKey || keyOf(dp.ex.toKey),
                                                 label: dp.ex.opp, pair: dp.ex.pair,
                                                 occurrence: dp.ex.occurrence,
                                                 // which two-track lane this door belongs to (undefined
                                                 // outside a two-track room) -- lets a two-track room's
                                                 // per-lane chain (buildMoveObjectChain) fan out to only
                                                 // ITS OWN lane's doors, not the other lane's.
                                                 track: dp.ex.track,
                                                 // which member (side/order) this door originates FROM --
                                                 // carried through so continuationListItem can tell whether
                                                 // this is a lane's ONE AND ONLY door and, if so, which list
                                                 // index comes right after that lane's own last member.
                                                 fromSide: dp.ex.fromSide, fromOrder: dp.ex.fromOrder });
    const key = roomKeyFor(r);
    // move-pair billboards + numbered object slots: reuse the existing mnemonic
    // machinery by registering the room's pairs under its key. When present, the
    // sign drops its (now redundant) move list and just carries the name/exits.
    const hasPairs = r.pairs && r.pairs.length;
    if(hasPairs) DEMO_MNEMONICS[key] = { pairs: r.pairs };
    const moves = hasPairs ? [] : (r.walls.center || []).slice()
      .concat((r.walls.left || []).map(m => '⟸ ' + m))
      .concat((r.walls.right || []).map(m => '⟹ ' + m));
    const doors = fwd.map(ex => `${ex.opp} → ${ex.to || (ex.foreignCastle ? `⟨${ex.foreignCastle}⟩` : '?')}`);
    const unbuilt = r.exits.filter(ex => !ex.to && !ex.foreignKey).map(ex => ex.opp);
    // per-lane "genuinely nothing beyond it" check for a two-track room's own
    // dead-end sign (buildRoom): true when that lane has NEITHER a real
    // forward door NOR an unbuilt (leaf, no-reply-yet) exit -- computed here,
    // not re-derived in buildRoom, since an unbuilt exit never makes it into
    // this room's own `exits` array below (only `fwd` ones do).
    const deadTracks = isTwoTrack
      ? { left: !r.exits.some(ex => ex.track !== 'right'), right: !r.exits.some(ex => ex.track === 'right') }
      : null;
    ROOMS[key] = {
      size: sz, color: 0x6f5f8e, exits, twoTrack: isTwoTrack, deadTracks,
      // the node's "Room Name" attribute (r.name), the same value edited in the
      // tree's Attributes modal -- seeded here so the VR walk shows it and, when
      // renamed in-world, writes back to that same pref via threeOpts.onRoomRename.
      name: r.name || '',
      // r.castle: this room's OWN castle-root name (set only when the room is a
      // castle root, e.g. a nested castle's entry embedded in this generation).
      // ownerCastle: the castle these rooms were generated for. buildDoorHint
      // shows the two-line plaque when a door's target has a different `castle`.
      castle: r.castle || '',
      ownerCastle,
      // the entry room's centre pair moves out to the mansion's street door
      // (buildStreetEntryPair). Only a street-less entry -- the report's single-
      // castle "Walk in VR" preview, which spawns straight inside with no
      // building -- keeps its centre pair in-room (nowhere else to show it).
      entryNoStreet: r === entry && !opts.backToStreet,
      posKey: r.posKey,   // first-4-FEN-fields for this room's position (mini-board icon)
      // this generation's live shape snapshot (member/exit position keys) --
      // see MEMORIZED_SHAPES for what captures it and why.
      shape: r.shape,
      castleSign: { title: (r.castle ? r.castle + ': ' : '') + (r.name || r.id), type: r.type, moves, doors, unbuilt }
    };
  }
  const s = ROOMS[entryKey].size;
  // spawn close to the south wall so you face the whole room and can take it
  // in at a glance.
  return { entryKey, spawn: { x: 0, z: s.d / 2 - CAS_LAYOUT.entrySetback, yaw: 0 } };
}

let renderer=null, scene=null, camera=null, clock=null;
let container=null, animHandle=null, resizeObs=null;
let keys = {};
let yaw = 0;
let lookPitch = 0;   // eased camera pitch; only non-zero when peeking down a down-staircase or gizmo-editing (see tick())
let editLift = 0;    // eased camera height boost while gizmo-editing (see tick())
let pos = { x:0, z:0 };
let currentRoomKey = 'start';
// where the player last walked in (spawn point just inside the entry door).
// Floor-standing box props are turned to face this so their image side greets
// you as you enter -- the only viewpoint that matters for a memory walk.
let entryPoint = null;
let exitMeta = [];       // [{box:{minX,maxX,minZ,maxZ}, target, spawn:{x,z,yaw}}]
// elevator-car doors: teleport on forward contact like any other door (see
// tick()) -- the back door unconditionally, the forward door once a floor
// has been picked (elevatorSelectedFloor below):
// [{box, kind:'forward', floors:[{label,target,spawn}]} | {box, kind:'back', target, spawn}]
let elevatorMeta = [];
// per-car floor selection, keyed by the car's roomKey: which floor's row was
// last clicked on the panel (its ordinal), highlighted there and consulted
// by tick() when the player then walks through the forward door. Survives a
// same-visit rebuild (e.g. right after the click that set it) but is reset
// on every fresh entry into the car (enterRoom) -- like a real elevator, you
// pick again each time you get in. Also validated against the car's current
// floors wherever it's read, since editing can change what's on the panel.
let elevatorSelectedFloor = {};
// latches true once the "select a floor first" toast has fired for the
// CURRENT approach to a forward door with nothing picked yet -- stops it
// re-firing every frame while the player holds forward at the door, reset
// to false the moment they leave the door's trigger box (see tick()) so a
// fresh approach prompts again.
let elevatorBlockedToastShown = false;
// wall -> [{rise, depth, outSign, dir, offset}], one entry per stair exit on that
// wall. An array (not one-per-wall) so a staircase sharing a wall with another
// door still has its own walkable gap keyed to its own offset.
let currentStairCorridors = {};
let currentBuildingColliders = []; // outdoor only: [{origin,size,doorWall,doorOffset}]
let teleportLockUntil = 0;
// roomKey -> the room the player most recently walked in FROM, for an
// ordinary (non-elevator) door crossing -- session-only, not persisted. A
// transposition room (reached from more than one parent) still has exactly
// one physical back door (registerOneCastle only ever wires one -- the wall
// space for a second doesn't reliably exist), but which room that one door
// actually leads back to shouldn't be permanently frozen to whichever parent
// the castle-builder happened to discover first: walking IN from a
// non-canonical parent and then walking back OUT should return you there,
// not silently redirect to the canonical one. Set in fireDoorTrigger right
// before the room-change; read in buildRoom while placing the back exit's
// trigger/spawn. The room's own CONTENT (walls/floor/ceiling/objects/move
// objects, and the door's own skin) stays exactly what it always was --
// this only ever changes which room the one back door's trigger points at.
let roomEnteredFrom = {};
const PLAYER_RADIUS = 0.4;
let textureLoader = null;
let buildGeneration = 0;

/* ---------- in-world layout editor state ----------
   editMode is toggled with the E key. LAYOUT holds per-room overrides
   (floor/wall surfaces and per-slot accessories) keyed by asset id; it's
   persisted to the IndexedDB 'meta' store under LAYOUT_KEY and merged onto
   the static ROOMS config at build time, so the demo always has a working
   fallback. ASSET_BY_ID is a cache of all asset records (from the 'assets'
   store) so buildRoom can turn an id into geometry without an async lookup.
*/
const LAYOUT_KEY = 'threeLayout';
let editMode = false;
let inputLocked = false;       // true while a picker is open (suppresses movement)
let foreignModalOpen = false;  // true while a modal outside threeTest (e.g. the asset manager) covers the canvas
let LAYOUT = {};
// Edit-mode undo/redo: whole-LAYOUT snapshots (JSON strings, cheap enough --
// LAYOUT is small hand-authored override data, not scene geometry), taken
// BEFORE a change is applied. This covers every kind of edit for free since
// they all funnel through either applyEdit (structural: skins, assets, room
// geometry, wall lists) or the two *Live setters (continuous transform drags:
// nudge/scale/rotate/height) -- see snapshotLayoutForUndo/snapshotForXformEdit.
const EDIT_UNDO_MAX = 50;
let editUndoStack = [], editRedoStack = [];
// A continuous drag (holding an arrow key) fires setSlotXformLive/
// setSignPosLive many times a second -- coalesce those into ONE undo step
// per "session" (same slot, no >XFORM_UNDO_COALESCE_MS gap) rather than one
// per frame, which would make undo useless (dozens of presses to unwind a
// single drag).
const XFORM_UNDO_COALESCE_MS = 800;
let lastXformUndoKey = null, lastXformUndoTime = 0;
function snapshotLayoutForUndo(){
  editUndoStack.push(JSON.stringify(LAYOUT));
  if(editUndoStack.length > EDIT_UNDO_MAX) editUndoStack.shift();
  editRedoStack = [];   // a fresh edit invalidates whatever redo history existed
}
function snapshotForXformEdit(sessionKey){
  const now = performance.now();
  if(sessionKey === lastXformUndoKey && now - lastXformUndoTime < XFORM_UNDO_COALESCE_MS){
    lastXformUndoTime = now;   // still the same drag -- extend the window, no new snapshot
    return;
  }
  snapshotLayoutForUndo();
  lastXformUndoKey = sessionKey;
  lastXformUndoTime = now;
}
function undoEdit(){
  if(!editUndoStack.length) return;
  editRedoStack.push(JSON.stringify(LAYOUT));
  LAYOUT = JSON.parse(editUndoStack.pop());
  lastXformUndoKey = null;
  persistLayout();
  refreshAssetMap().then(() => buildRoom(currentRoomKey));
  updateToolbar();
  showToast('Undid last edit');
}
function redoEdit(){
  if(!editRedoStack.length) return;
  editUndoStack.push(JSON.stringify(LAYOUT));
  LAYOUT = JSON.parse(editRedoStack.pop());
  lastXformUndoKey = null;
  persistLayout();
  refreshAssetMap().then(() => buildRoom(currentRoomKey));
  updateToolbar();
  showToast('Redid edit');
}
let ASSET_BY_ID = {};
// "memorized" room tracking (progress, not decoration): { [roomKey]: msEpochWhenMarked }.
// Persisted the same way as LAYOUT -- a flat 'meta' key, room keys are the
// same cas:<instanceId>:<posKey> strings, so it survives regeneration and is
// shared across nested/linked castles for free, exactly like LAYOUT already is.
const MEMORIZED_KEY = 'threeMemorizedRooms';
let MEMORIZED = {};
// "fully decorated" room tracking: every move-object slot has a real asset and
// every forward door's target room is named. Unlike MEMORIZED (a manual user
// toggle), this is COMPUTED -- persisted the same way, but only ever
// (re)evaluated at one checkpoint (exiting edit mode, see setEditMode) rather
// than kept continuously live, so it can go briefly stale if a room's target
// gets renamed elsewhere later. { [roomKey]: msEpochWhenLastFlaggedComplete }.
const DECORATED_KEY = 'threeDecoratedRooms';
let DECORATED = {};
// frozen shape snapshot for every currently-memorized room, captured at the
// moment MEMORIZED is set (and dropped when it's cleared) -- see the room's
// live `shape` (registerOneCastle) for what gets copied in. This is the data
// a later regeneration will diff against to detect a new variation landing
// inside an already-memorized room, and to preserve the room's layout instead
// of letting it split. Not consulted for anything yet in this phase --
// capture-only. { [roomKey]: { kind, members?|left?/right?, exitPosKeys } }.
const MEMORIZED_SHAPE_KEY = 'threeMemorizedShapes';
let MEMORIZED_SHAPES = {};
let raycaster = null;
let pointer = null;
let billboards = [];           // cylindrical billboards needing per-frame facing
let floorLabels = [];          // room-name floor labels: lie flat, spin per-frame to face the camera
let editHud = null;
let toastEl = null;
let toastTimer = null;

/* ---------- on-screen touch joystick (mobile) ----------
   A virtual stick near the bottom-center drives the same walk the WASD/arrow
   keys do: x turns (left/right), y walks (forward/back). joyVec holds the
   current normalized tilt [-1..1] each axis; tick() folds it into the movement
   the same frame. Only built on coarse-pointer (touch) devices. */
let joystickEl = null, joyKnob = null, joyPointerId = null;
let joyVec = { x: 0, y: 0 };

/* ---------- chromeless overlay controls ----------
   The walking modal is full-viewport with no header/footer; every control is an
   icon button in a flush-left toolbar overlaid on the canvas (built in
   buildTopToolbar). `threeOpts` carries app-level callbacks (onClose/onAssets)
   since closing the modal and opening the asset manager live in app.js. */
let threeOpts = {};
let toolbarEl = null, helpOverlay = null;
let hintsBtn = null, editBtn = null, boardBtn = null, roomGeomBtn = null, wallListsBtn = null, assetsBtn = null, closeBtn = null, infoBtn = null, memBtn = null, decoratedBadge = null, dirtyBadge = null, editGroup = null;
let undoBtn = null, redoBtn = null;
let editTouchEl = null;   // mobile move/scale pad shown while a prop is selected
// hints: when on, doors show the name of (and a move thumbnail for) the room
// beyond, and the in-room move-pair billboard is shown. Off hides all of those
// so the layout can be walked as a self-test.
let hintsOn = true;

/* ---------- in-world layout editor: prop selection (nudge/scale) ----------
   Clicking an existing accessory selects it instead of opening the picker.
   While selected, arrow keys nudge its position and +/- scale it; a gear
   icon (and Enter) reopens the asset picker to swap/remove it. Position/scale
   deltas live in LAYOUT[roomKey].slotXform[slotId], separate from the plain
   asset-id map in `slots`, so existing saved layouts need no migration. */
let selectedProp = null;       // { roomKey, slotId, kind, ground }
let selectionOutline = null;
let selectionGear = null;
let selectionAnchor = null;    // { center:Vector3, halfW, halfH } for gear placement
let gearTexture = null;
const NUDGE_STEP = 0.1;
const SCALE_STEP = 1.02;
const SCALE_MIN = 0.4, SCALE_MAX = 2.5;

/* ---------- in-world layout editor: translate gizmo (mouse/touch drag) ----------
   A drag-to-move alternative to arrow-key nudging: draggable arrows (x/z --
   wall-relative, see roomAxes below -- and up, true vertical) appear on
   a selected prop; grabbing one and dragging moves the prop along just that
   axis, writing through the exact same setSlotXformLive path the keyboard
   already uses, so both input methods stay interchangeable moment to moment.
   Which axes show up matches each kind's actual degrees of freedom (see
   attachSelectionVisuals): floor/sign get x/z only (no vertical lift at
   all); moveObject/mnemonic get all three (free-floating); ceiling gets x/z
   only (slides in the ceiling's own plane, but its height is always
   room.size.h-derived, never nudgeable); wall gets exactly ONE horizontal
   arrow (along the wall -- whichever of x/z that wall runs on, see
   wallSpan) plus up, unless `ground` (a floor-standing wall piece, height
   fixed at 0). This covers every kind nudgeSelected itself handles --
   see its own kind branches -- so every keyboard-nudgeable kind also has a
   drag gizmo. */
const GIZMO_KINDS = new Set(['floor', 'moveObject', 'mnemonic', 'wall', 'ceiling', 'sign']);
// sized to stand out against a noisy/colorful room -- thicker and a bit
// longer than a "minimal" gizmo would need, since these compete visually
// with real scenery, not a neutral CAD viewport.
const GIZMO_LEN = 1.0, GIZMO_SHAFT_R = 0.035, GIZMO_HEAD_R = 0.11, GIZMO_HEAD_LEN = 0.22;
const GIZMO_COLORS = { x: 0xe53935, z: 0x1e88e5, up: 0x43a047 };
// how far the gizmo's shared origin is pulled from the object's own center,
// toward the entrance (GIZMO_FRONT_OFFSET) and down (GIZMO_DROP) -- a
// mnemonic/floor/moveObject prop is often a camera-facing billboard
// occupying most of the screen space right around its own center, which
// otherwise puts the arrows right where the billboard's own body is.
// "In front of" the object means between the entrance and the object (the
// direction most editing actually happens from, walking a room in from its
// own door) -- i.e. toward the entrance from the object's own position, the
// reverse of roomAxes' own "z" (which points away from the entrance, into
// the room). The added drop still matters here even though this is a fixed
// room direction rather than a camera-relative one: standing right at the
// entrance facing the object -- exactly the vantage roomAxes is oriented
// around -- puts this offset directly along the view axis, which (see the
// gizmo's own history: this was the original bug with a plain
// toward-the-camera offset) doesn't create any screen-space separation by
// itself; the drop's vertical separation doesn't depend on viewing angle
// the way a horizontal offset does, so it still gets the arrows clear of
// the object's own silhouette even from that exact spot.
const GIZMO_FRONT_OFFSET = 1.0, GIZMO_DROP = 0.5;
let selectionGizmo = [];   // the arrow Groups currently shown, or [] when none (see attachSelectionVisuals)
// { axis, roomKey, slotId, kind, room, slot, startXform, axisDir, axisOrigin,
//   plane } while an arrow is being dragged; null otherwise.
let gizmoDrag = null;
// set the instant a gizmo drag starts, so the native 'click' that follows
// the eventual mouseup doesn't ALSO fall through to onCanvasClick's own
// raycast (which would otherwise reselect/deselect based on whatever is
// behind the arrow).
let suppressNextCanvasClick = false;
// Wall-relative horizontal nudge/drag axes -- fixed per-room directions, NOT
// tied to the camera's current facing (a key press or drag direction used
// to move a prop a different way depending on which way you'd wandered in
// facing, and made the horizontal arrows visually collide whenever yaw
// pointed straight at the object -- see the gizmo's own design notes). But
// also not a single fixed world direction either: oriented to each room's
// OWN entrance (its back:true exit -- the door you walked in through) --
// "z" points away from it (into the room), "x" points right from the
// perspective of STANDING AT the entrance facing in, since that's the
// vantage most editing happens from (laying a room out member by member,
// starting at the door you enter through). Every room's own geometry
// (walls, clampFloorXZ's size.w/size.d) is built directly in the same
// (x,z) frame with no rotation (see enterRoom/buildRoom: pos.x/pos.z ARE
// the room-local coordinates), so these two vectors are always exactly
// parallel to one wall pair each, for every room -- just which PHYSICAL
// wall pair "x" vs "z" resolves to varies by the room's own entrance wall.
// Structurally can't coincide with the view direction once edit mode also
// tilts the camera when a gizmo-eligible prop is selected (see tick()'s
// EDIT_TILT_PITCH).
function roomAxes(room){
  const out = WALL_OUT_NORMAL[entranceWall(room)];
  const z = { x: -out.x, z: -out.z };   // away from the entrance, into the room (ArrowUp)
  // "right" as seen facing `z` -- same -90-degree rotation cameraRightVec
  // derives from cameraForwardVec, just applied to this fixed room
  // direction instead of the live camera yaw (ArrowRight).
  const x = { x: -z.z, z: z.x };
  return { x, z };
}

// a surface slot (LAYOUT[roomKey].floor/ceiling/stairSurface/walls[w], and the
// same fields inside a building default/preset) holds one of three shapes:
// a real asset id, a flat "#rrggbb" color (colors can't collide with an asset
// id -- ID_RE forbids '#'), or { id, tint } -- a real asset with a per-
// placement tint layered on top of (or replacing) its own baked-in tint,
// without touching the shared asset definition or any other placement of it.
// This resolves any of the three into the same "asset record" shape the
// renderer expects, so callers never need to know which one they got.
function isColorId(id){ return typeof id === 'string' && id[0] === '#'; }
function assetOrColorFor(id){
  if(!id) return null;
  if(typeof id === 'object'){
    const base = ASSET_BY_ID[id.id];
    return base ? (id.tint ? Object.assign({}, base, { tint: id.tint }) : base) : null;
  }
  if(isColorId(id)) return { id, color: id, isColor: true };
  return ASSET_BY_ID[id] || null;
}
// the raw stored/inherited value for a surface slot (room override -> the
// building default), untouched -- a plain id, a "#hex" color, or {id,tint} --
// unlike the *AssetFor() getters below, which resolve it into an asset record.
// Shared by them and by snapshotRoomStyle(), so a tint override survives
// being captured into a building default or a named preset instead of
// collapsing down to just its base asset id.
function rawSurfaceId(roomKey, field){
  return (LAYOUT[roomKey] && LAYOUT[roomKey][field]) || defaultFieldId(roomKey, field) || null;
}
function rawWallId(roomKey, wall){
  let id = LAYOUT[roomKey] && LAYOUT[roomKey].walls && LAYOUT[roomKey].walls[wall];
  if(!id){
    const d = buildingDefaults(roomKey);
    if(d && d.walls){
      // defaults store walls relative to the entrance, so they rotate correctly
      // into rooms whose entrance door is on a different wall
      id = d.walls[wallRelative(entranceWall(mergedRoom(roomKey)), wall)] || null;
    }
  }
  return id || null;
}
// surface getters resolve in layers: this room's own override -> the building's
// default (set via the Room dialog's "make default" checkbox) -> null, which
// leaves the procedural brick/wood fallback. See buildingDefaults() below.
function floorAssetFor(roomKey){ return assetOrColorFor(rawSurfaceId(roomKey, 'floor')); }
function wallAssetFor(roomKey, wall){ return assetOrColorFor(rawWallId(roomKey, wall)); }
function slotAssetFor(roomKey, slotId){
  const id = LAYOUT[roomKey] && LAYOUT[roomKey].slots && LAYOUT[roomKey].slots[slotId];
  return id ? ASSET_BY_ID[id] : null;
}
function ceilingAssetFor(roomKey){ return assetOrColorFor(rawSurfaceId(roomKey, 'ceiling')); }
function stairAssetFor(roomKey){ return assetOrColorFor(rawSurfaceId(roomKey, 'stairSurface')); }
// layers (or clears) a per-placement tint on top of whatever real asset is
// currently assigned to a surface -- the base asset id is preserved either
// way; only the stored value's shape changes (plain id <-> {id,tint}). A
// no-op if the surface currently holds a flat color (allowTint's own picker
// gating already keeps this unreachable then; this is just a safety net).
function setSurfaceTint(roomKey, kind, wall, tint){
  const rawId = kind === 'wall' ? rawWallId(roomKey, wall) : rawSurfaceId(roomKey, kind === 'stair' ? 'stairSurface' : kind);
  const baseId = (rawId && typeof rawId === 'object') ? rawId.id : rawId;
  if(!baseId || isColorId(baseId)) return;
  const value = tint ? { id: baseId, tint } : baseId;
  if(kind === 'floor') setFloorOverride(roomKey, value);
  else if(kind === 'ceiling') setCeilingOverride(roomKey, value);
  else if(kind === 'stair') setStairOverride(roomKey, value);
  else if(kind === 'wall') setWallOverride(roomKey, wall, value);
}
function buildingFacadeFor(roomKey, buildingKey){
  const id = LAYOUT[roomKey] && LAYOUT[roomKey].buildings && LAYOUT[roomKey].buildings[buildingKey];
  return id ? ASSET_BY_ID[id] : null;
}
function signAssetFor(roomKey, buildingKey){
  const id = LAYOUT[roomKey] && LAYOUT[roomKey].signs && LAYOUT[roomKey].signs[buildingKey];
  return id ? ASSET_BY_ID[id] : null;
}
// A building sign's persisted position nudge ({dx, dz} from its default lawn
// spot). Kept separate from the skin override (r.signs, a plain asset id) so
// the two are independent -- you can move a sign without skinning it and vice
// versa.
function signPosFor(roomKey, buildingKey){
  const r = LAYOUT[roomKey];
  return (r && r.signPos && r.signPos[buildingKey]) || null;
}
function yardAssetFor(roomKey, buildingKey){
  const id = LAYOUT[roomKey] && LAYOUT[roomKey].yards && LAYOUT[roomKey].yards[buildingKey];
  return id ? ASSET_BY_ID[id] : null;
}
function doorKey(wall, offset){
  return `${wall}@${offset}`;
}
function clampNum(v, lo, hi){
  return Math.min(hi, Math.max(lo, v));
}
// projects a world-space point (meters, room-local) onto the nearest wall,
// returning {wall, offset} clamped away from corners by the doorway's own
// half-width so a dragged door never overhangs the end of a wall.
function nearestWallPoint(rw, rd, wx, wz){
  const marginW = DOOR_W/2 + 0.3;
  const xLo = -rw/2 + marginW, xHi = rw/2 - marginW;
  const zLo = -rd/2 + marginW, zHi = rd/2 - marginW;
  const candidates = [
    { wall: 'north', dist: Math.abs(wz - (-rd/2)), offset: clampNum(wx, xLo, xHi) },
    { wall: 'south', dist: Math.abs(wz - (rd/2)),  offset: clampNum(wx, xLo, xHi) },
    { wall: 'west',  dist: Math.abs(wx - (-rw/2)), offset: clampNum(wz, zLo, zHi) },
    { wall: 'east',  dist: Math.abs(wx - (rw/2)),  offset: clampNum(wz, zLo, zHi) }
  ];
  candidates.sort((a, b) => a.dist - b.dist);
  return { wall: candidates[0].wall, offset: candidates[0].offset };
}
function doorAssetFor(roomKey, dKey){
  const id = LAYOUT[roomKey] && LAYOUT[roomKey].doors && LAYOUT[roomKey].doors[dKey];
  return id ? ASSET_BY_ID[id] : null;
}
// a room with no forward exit at all gets a skinnable "no continuation" sign
// on the wall a forward door would have used (see buildRoom's dead-end hook)
// -- a separate storage field from r.doors (not a doorKey lookup) so a stale
// override can't silently reappear as a real door's skin if the room later
// gains an actual continuation and a real door lands on that same wall spot.
// A two-track room can dead-end independently on EITHER lane, so it needs two
// independent overrides -- `track` ('left'/'right') routes to r.deadEndTracks
// instead of the single-lane r.deadEnd a corridor/plain room uses. Omitting
// track keeps the original single-value behavior untouched.
function deadEndAssetFor(roomKey, track){
  const r = LAYOUT[roomKey];
  const id = track ? (r && r.deadEndTracks && r.deadEndTracks[track]) : (r && r.deadEnd);
  return id ? ASSET_BY_ID[id] : null;
}
function setDeadEndOverride(roomKey, assetId, track){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    if(track){
      r.deadEndTracks = r.deadEndTracks || {};
      if(assetId) r.deadEndTracks[track] = assetId; else delete r.deadEndTracks[track];
      if(!Object.keys(r.deadEndTracks).length) delete r.deadEndTracks;
    } else if(assetId) r.deadEnd = assetId; else delete r.deadEnd;
  });
}
// the static ROOMS table with any LAYOUT[roomKey].geom (w/d/h) override and
// any LAYOUT[roomKey].exits (per-target wall/offset) override folded in --
// the single accessor every size- or exit-dependent read should use, so a
// saved room-dimension or door-position edit takes effect everywhere without
// touching the dozens of call sites that already take a `room` object as a
// parameter. Exit overrides are keyed by target room (the stable identity an
// exit resolves by), not by wall/offset, and only ever touch the room they're
// stored under -- door moves are single-sided by construction: moving
// roomA's door to roomB doesn't move roomB's door back to roomA.
function mergedRoom(roomKey){
  const room = ROOMS[roomKey];
  if(!room) return room;
  const L = LAYOUT[roomKey];
  if(!L || (!L.geom && !L.exits)) return room;
  let size = L.geom ? Object.assign({}, room.size, L.geom) : room.size;
  // mainStreet is fully procedural: buildings/roads are placed by formula
  // every load, not stored props, and its own freshly-computed size (see
  // generateMainStreet) is already the true minimum needed to contain
  // everything just placed. A saved override -- e.g. a manual resize from
  // back when there was less content -- must never be allowed to shrink it
  // below that and strand a castle outside the grass; a *larger* override
  // still wins, for anyone who wants extra room to walk around.
  if(roomKey === 'mainStreet' && L.geom){
    size = { w: Math.max(size.w, room.size.w), d: Math.max(size.d, room.size.d), h: Math.max(size.h, room.size.h) };
  }
  let exits = room.exits;
  if(L.exits && room.exits){
    exits = room.exits.map(ex => {
      const ov = L.exits[ex.target];
      return ov ? Object.assign({}, ex, ov) : ex;
    });
  }
  return Object.assign({}, room, { size, exits });
}
// a room is an "elevator car" if any other room has an exit targeting it
// with type 'elevator' -- checked via mergedRoom so an editor-applied type
// change (commitRoomGeomDialog) takes effect immediately. This is intrinsic
// to the room, not the door you happened to walk in through: re-entering a
// car room via one of its own floor's back doors still finds it in car mode.
function isElevatorCar(roomKey){
  for(const srcKey of Object.keys(ROOMS)){
    const src = mergedRoom(srcKey);
    for(const ex of (src && src.exits) || []){
      if(ex.target === roomKey && ex.type === 'elevator') return true;
    }
  }
  return false;
}
// An elevator car collapses ALL of its forward exits behind ONE door -- each
// becomes a floor button in the panel beside that door -- with the back exit
// (if any) its own separate door. This synthesizes the two door placements,
// deliberately IGNORING the per-exit wall/offset layout the room carries for
// its non-elevator form: those exits are spread across north/east/west so the
// room doesn't fit an elevator's "one door, many buttons" shape. The forward
// door goes on the wall opposite the back door (north when there's no back),
// so the two never share a wall regardless of the original layout.
//   Returns { back, floors, fwdWall, fwdOffset } -- floors is every non-back
//   exit (in the room's own exit order), back is the single back exit or null.
function elevatorCarLayout(room){
  const exits = (room && room.exits) || [];
  const back = exits.find(e => e.back) || null;
  const floors = exits.filter(e => !e.back);
  return { back, floors, fwdWall: back ? WALL_OPPOSITE[back.wall] : 'north', fwdOffset: 0 };
}
// Why a room can't be made an elevator, or null if it can. An elevator only
// makes sense for a room that BRANCHES into several separate rooms (each a
// "floor"); a linear sequence of moves (a corridor, or a two-track's parallel
// lanes) has no floors to pick between. Checked when the user picks "Elevator"
// for a door in the Room Geometry editor (renderRoomGeomDialog).
function elevatorRejectReason(targetKey){
  const t = mergedRoom(targetKey);
  if(!t) return null;   // unknown target -- don't block (shouldn't happen)
  const type = t.castleSign && t.castleSign.type;
  if(t.twoTrack || type === 'two-track')
    return 'That room is a two-track room (two parallel sequences of moves). An elevator is only for a room that branches into several separate rooms — not tracks of moves.';
  if(type === 'corridor')
    return 'That room is a corridor (a single linear sequence of moves). An elevator is only for a room that branches into several separate rooms — not a sequence.';
  const fwd = t.exits ? t.exits.filter(e => !e.back).length : 0;
  if(fwd < 2)
    return `An elevator needs at least two floors to choose between; that room has ${fwd === 0 ? 'no' : 'only one'} forward door.`;
  if(fwd > ELEV_MAX_FLOORS)
    return `An elevator can have at most ${ELEV_MAX_FLOORS} floors (two panels of ${ELEV_PANEL_MAX_ROWS}); that room has ${fwd} forward doors.`;
  return null;
}
function setRoomGeom(roomKey, geom){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    r.geom = geom;
  });
}
// A room's display name: the node's "Room Name" attribute, held live on
// ROOMS[key].name (seeded from r.name at registration, updated in place on an
// in-world rename). '' means unnamed -- callers fall back to the move/title.
function roomNameFor(roomKey){
  const n = ROOMS[roomKey] && ROOMS[roomKey].name;
  return (n && String(n).trim()) || '';
}
// Name (or rename) a room from the VR walk. This edits the SAME item as the
// tree's Attributes → Room Name: we update the live ROOMS entry and hand the
// change to threeOpts.onRoomRename (wired by app.js) to persist it onto the
// room's pref. Then rebuild the current room so its forward-door nameplates
// (buildDoorHint reads the beyond-room's name) update immediately.
function setRoomName(roomKey, name){
  name = (name || '').trim();
  if(ROOMS[roomKey]) ROOMS[roomKey].name = name;
  if(typeof threeOpts.onRoomRename === 'function') threeOpts.onRoomRename(roomKey, name);
  if(scene) buildRoom(currentRoomKey);
}
// commits a room-geometry-dialog session in one rebuild: the width/depth/
// height patch plus any door moves and/or type changes (keyed by target
// room). `exitMoves` is a { [target]: {wall, offset, type} } map of the
// dialog's full staged state -- entries matching the static position and
// type ('door') are omitted so a drag-then-drag-back doesn't leave a no-op
// override behind. Any door skin saved under the old wall@offset key
// migrates to the new one.
function commitRoomGeomDialog(roomKey, geom, exitMoves){
  // a resize can leave the player outside the new bounds or facing a wall
  // (whatever spot they were standing at may no longer make sense against
  // the new geometry) -- once the rebuild lands, drop them back at the
  // room's own entrance, same as if they'd just walked in.
  return applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    r.geom = geom;
    const staticExits = ROOMS[roomKey].exits || [];
    for(const ex of staticExits){
      const oldOv = r.exits[ex.target];
      const oldWall = oldOv ? oldOv.wall : ex.wall;
      const oldOffset = oldOv ? oldOv.offset : ex.offset;
      const move = exitMoves[ex.target];
      if(!move){ continue; }
      const moveType = move.type || 'door';
      const sameType = moveType === (ex.type || 'door');
      if(move.wall === ex.wall && Math.abs(move.offset - ex.offset) < 0.001 && sameType){
        delete r.exits[ex.target];
      } else {
        const newOv = { wall: move.wall, offset: move.offset };
        if(!sameType) newOv.type = moveType;
        r.exits[ex.target] = newOv;
      }
      const oldKey = doorKey(oldWall, oldOffset);
      const newKey = doorKey(move.wall, move.offset);
      if(oldKey !== newKey && r.doors[oldKey] != null){
        r.doors[newKey] = r.doors[oldKey];
        delete r.doors[oldKey];
      }
      // reciprocal stair linking: an up-stair to B implies a down-stair back from
      // B (and vice versa); turning a stair back into a plain door unlinks the
      // other side too. Writes B's own exit-to-here override (a cross-room edit).
      const oldType = (oldOv && oldOv.type) || ex.type || 'door';
      if(isStairType(moveType)) setReciprocalStairType(ex.target, roomKey, moveType === 'stair' ? 'stair-down' : 'stair');
      else if(isStairType(oldType)) setReciprocalStairType(ex.target, roomKey, 'door');
    }
  }).then(() => respawnAtEntry(roomKey));
}
// Set room B's exit-back-to-A to `type` (used to mirror a stair on the far side).
// Preserves B's current wall/offset for that door; a plain 'door' at the static
// position drops the override entirely. No-op if B has no exit back to A.
function setReciprocalStairType(bKey, aKey, type){
  const bRoom = ROOMS[bKey];
  const back = bRoom && bRoom.exits && bRoom.exits.find(e => e.target === aKey);
  if(!back) return;
  const rb = ensureRoomLayout(bKey);
  const ov = rb.exits[aKey] || {};
  const wall = ov.wall != null ? ov.wall : back.wall;
  const offset = ov.offset != null ? ov.offset : back.offset;
  const staticType = back.type || 'door';
  if(type === staticType && wall === back.wall && Math.abs(offset - back.offset) < 0.001){
    delete rb.exits[aKey];
  } else {
    rb.exits[aKey] = { wall, offset };
    if(type !== staticType) rb.exits[aKey].type = type;
  }
}
// wipe a room's ENTIRE LAYOUT entry back to nothing -- as if it had never
// been walked into or customized at all: floors, walls, ceiling, stairs and
// door skins, every placed prop and its nudge/scale, wall-list (object-list)
// assignments, and -- unlike the old narrower wipe -- the room's size, its
// doors' positions/types, and any stray auto-reconciled nudge, all of which
// used to be deliberately kept. Those turned out to be exactly what could go
// stale after a resize (a manually-shrunk/regenerated room's stored geom no
// longer matching its current move-pairs) and leave a room's contents
// permanently scrambled with nothing short of this to put it back. The room
// then falls back to the building defaults (or procedural) for floor/wall/
// ceiling/door skins, same as a genuinely new room would. Never touches
// LAYOUT.__defaults, so a building default previously captured from this
// room survives the wipe.
function clearRoomStyles(roomKey){
  if(selectedProp && selectedProp.roomKey === roomKey) deselectProp();
  applyEdit(() => {
    const r = LAYOUT[roomKey];
    if(!r) return;
    delete r.floor; delete r.ceiling; delete r.stairSurface; delete r.geom; delete r.deadEnd; delete r.deadEndTracks;
    r.walls = {}; r.doors = {}; r.slots = {}; r.slotWords = {}; r.slotXform = {}; r.exits = {}; r.wallLists = {};
    r.buildings = {}; r.signs = {}; r.signPos = {}; r.yards = {};   // outdoor maps; no-ops indoors
  });
  evaluateDecorated(roomKey);   // every slot just emptied out -- refresh the cached flag now, not just on next edit-mode exit
}
// 3x3 grid of floor-standing spots, equally spaced, using the same compass
// ids the four hand-placed corners already used (so existing layout
// overrides for fl-nw/fl-ne/fl-sw/fl-se keep working). A cell is dropped if
// the room's single static furniture piece sits there, or if it falls right
// in the doorway of one of the room's exits.
const FLOOR_GRID_OFFSET = 3.2;
const FLOOR_GRID_IDS = [
  ['nw', 'n', 'ne'],
  ['w',  'c', 'e'],
  ['sw', 's', 'se']
];
function floorGridSlots(room){
  const slots = [];
  const coords = [-FLOOR_GRID_OFFSET, 0, FLOOR_GRID_OFFSET];
  for(let r = 0; r < 3; r++){
    for(let c = 0; c < 3; c++){
      const x = coords[c], z = coords[r];
      if(room.furniture && Math.abs(room.furniture.x - x) < 0.1 && Math.abs(room.furniture.z - z) < 0.1) continue;
      if(blocksDoorway(room, x, z)) continue;
      slots.push({ id: 'fl-' + FLOOR_GRID_IDS[r][c], kind: 'floor', x, z });
    }
  }
  return slots;
}
function blocksDoorway(room, x, z){
  for(const ex of room.exits || []){
    const { axis, fixed } = wallSpan(room.size, ex.wall);
    const nearEdge = fixed > 0 ? FLOOR_GRID_OFFSET : -FLOOR_GRID_OFFSET;
    if(axis === 'x'){
      if(Math.abs(z - nearEdge) < 0.1 && Math.abs(x - ex.offset) < DOOR_W/2 + 0.4) return true;
    } else {
      if(Math.abs(x - nearEdge) < 0.1 && Math.abs(z - ex.offset) < DOOR_W/2 + 0.4) return true;
    }
  }
  return false;
}

// wall-hanging spots flanking each door (for framed pictures, sconces,
// shelves) -- two per exit, clear of the doorway itself.
const DOOR_FLANK_OFFSET = DOOR_W/2 + 0.9;
function doorFlankSlots(room){
  const slots = [];
  for(const ex of room.exits || []){
    for(const side of [-1, 1]){
      slots.push({
        id: `wh-${ex.wall}-${side < 0 ? 'l' : 'r'}`,
        kind: 'wall', wall: ex.wall, offset: ex.offset + side * DOOR_FLANK_OFFSET, y: 1.7
      });
    }
  }
  return slots;
}

// floor spots directly under each eye-level door-flank wall spot, a short step
// in from the wall -- for a piece that pairs with whatever hangs above it.
const DOOR_FLANK_FLOOR_INSET = 0.8;
function doorFlankFloorSlots(room){
  const slots = [];
  for(const ex of room.exits || []){
    const { axis, fixed } = wallSpan(room.size, ex.wall);
    const inSign = fixed > 0 ? -1 : 1;            // step inward, away from the wall
    for(const side of [-1, 1]){
      const along = ex.offset + side * DOOR_FLANK_OFFSET;
      const x = axis === 'x' ? along : fixed + inSign * DOOR_FLANK_FLOOR_INSET;
      const z = axis === 'x' ? fixed + inSign * DOOR_FLANK_FLOOR_INSET : along;
      if(room.furniture && Math.abs(room.furniture.x - x) < 0.6 && Math.abs(room.furniture.z - z) < 0.6) continue;
      slots.push({ id: `wf-${ex.wall}-${side < 0 ? 'l' : 'r'}`, kind: 'floor', x, z });
    }
  }
  return slots;
}

// "low" wall spot centred on each wall at ground level, for floor-standing
// against-the-wall pieces (fireplace, columns, a suit of armor) -- the
// counterpart to the eye-level door-flank spots. Skipped on a wall whose door
// sits near the centre (the piece would land in the doorway).
function lowWallSlots(room){
  const slots = [];
  for(const wall of ['north', 'south', 'east', 'west']){
    if(wallHasCenteredDoor(room, wall)) continue;
    slots.push({ id: `wl-${wall}`, kind: 'wall', wall, offset: 0, y: 0, ground: true });
  }
  return slots;
}
function wallHasCenteredDoor(room, wall){
  for(const ex of room.exits || []){
    if(ex.wall === wall && Math.abs(ex.offset) < DOOR_W/2 + 0.6) return true;
  }
  return false;
}

// single hang-point in the centre of the ceiling, for a chandelier (typically a
// billboard so it always faces the camera).
function ceilingSlots(room){
  return [{ id: 'ceil-c', kind: 'ceiling', x: 0, z: 0 }];
}

// rotation.y that points a prop's front (local -z) away from a building, out
// into the street -- the outdoor counterpart to WALL_INWARD_YAW.
const FRONT_OUTWARD_YAW = { north: 0, south: Math.PI, west: Math.PI/2, east: -Math.PI/2 };

// yard ground spots flanking a building's front door, symmetric left/right,
// for landscaping (trees, bushes, flowers, a bird bath) -- the outdoor
// counterpart to doorFlankFloorSlots. Three per side, spaced out along the
// door wall starting clear of the doorway itself, all at the same distance
// out into the yard. Ids are scoped to the building so multiple buildings on
// the same outdoor room don't collide.
const YARD_SLOT_COUNT = 3;
const YARD_SLOT_SPACING = 2.2;
const YARD_SLOT_START = DOOR_W/2 + 1.4;
const YARD_SLOT_DEPTH = 1.5;
function yardSlots(b, buildingKey){
  const slots = [];
  const { axis, fixed } = wallSpan(b.size, b.doorWall);
  const outSign = (b.doorWall === 'south' || b.doorWall === 'east') ? 1 : -1;
  const out = fixed + outSign * YARD_SLOT_DEPTH;
  for(const side of [-1, 1]){
    for(let i = 0; i < YARD_SLOT_COUNT; i++){
      const along = b.doorOffset + side * (YARD_SLOT_START + i * YARD_SLOT_SPACING);
      const x = (axis === 'x' ? along : out) + b.origin.x;
      const z = (axis === 'x' ? out : along) + b.origin.z;
      slots.push({
        id: `yard-${buildingKey}-${side < 0 ? 'l' : 'r'}-${i+1}`,
        kind: 'floor', x, z, yaw: FRONT_OUTWARD_YAW[b.doorWall]
      });
    }
  }
  return slots;
}

// full set of placement slots for a room: the procedural floor grid, door-
// flanking and low wall spots, the ceiling hang-point, plus any one-off hand-
// authored slots in ROOMS (e.g. a wall mount with no door nearby).
function roomSlots(room, roomKey){
  // the procedural floor grid and door-flanking spots are tuned for ~10m
  // rooms and would clip/collide/duplicate in a small elevator car -- car
  // rooms keep only the ceiling hang-point, the mnemonic billboard slot
  // (already generic) and whatever one-off slots ROOMS hand-places (the
  // single east/west wall mounts).
  const carMode = isElevatorCar(roomKey);
  return [
    ...(carMode ? [] : floorGridSlots(room)),
    ...(carMode ? [] : doorFlankSlots(room)),
    ...(carMode ? [] : doorFlankFloorSlots(room)),
    ...(carMode ? [] : lowWallSlots(room)),
    ...ceilingSlots(room),
    ...mnemonicSlots(roomKey),
    ...moveObjectSlots(roomKey),
    ...(room.slots || [])
  ];
}
function slotById(room, roomKey, slotId){
  const found = roomSlots(room, roomKey).find(s => s.id === slotId);
  if(found) return found;
  for(const b of room.buildings || []){
    const ys = yardSlots(b, b.target).find(s => s.id === slotId);
    if(ys) return ys;
  }
  return null;
}

async function refreshAssetMap(){
  ASSET_BY_ID = {};
  for(const a of await getAllAssets()) ASSET_BY_ID[a.id] = a;
}

// Phase 2: cache of every object list (id -> record from the 'objectLists'
// store) so a room's wall-list assignment can be resolved synchronously while
// building slots. Loaded alongside the asset map at tour open and refreshed
// live when the asset library / lists change.
let OBJECT_LISTS = {};
async function refreshObjectLists(){
  OBJECT_LISTS = {};
  for(const l of await getAllObjectLists()) OBJECT_LISTS[l.id] = l;
}
async function loadLayout(){
  const raw = await getMeta(LAYOUT_KEY);
  try { LAYOUT = raw ? JSON.parse(raw) : {}; }
  catch { LAYOUT = {}; }
}
function persistLayout(){ setMeta(LAYOUT_KEY, JSON.stringify(LAYOUT)); }

async function loadMemorized(){
  const raw = await getMeta(MEMORIZED_KEY);
  try { MEMORIZED = raw ? JSON.parse(raw) : {}; }
  catch { MEMORIZED = {}; }
}
// returns the write's promise (was fire-and-forget) -- toggleMemorized below
// awaits both this and persistMemorizedShapes together so a caller that
// awaits the toggle can rely on the write having actually landed, not just
// been kicked off. Matters more now that two persists race the same IDB
// database instead of one; a genuinely-fire-and-forget pair narrowly worked
// before but wasn't correct.
function persistMemorized(){ return setMeta(MEMORIZED_KEY, JSON.stringify(MEMORIZED)); }

async function loadMemorizedShapes(){
  const raw = await getMeta(MEMORIZED_SHAPE_KEY);
  try { MEMORIZED_SHAPES = raw ? JSON.parse(raw) : {}; }
  catch { MEMORIZED_SHAPES = {}; }
}
function persistMemorizedShapes(){ return setMeta(MEMORIZED_SHAPE_KEY, JSON.stringify(MEMORIZED_SHAPES)); }

// Toggles the CURRENT room's memorized flag. No-op outside a real castle room
// (currentRoomFen() is null on mainStreet/buildings) -- the toolbar icon that
// calls this is hidden there for the same reason. No scene rebuild needed:
// nothing in the 3D scene itself depends on this flag, only the toolbar icon.
// Marking memorized also snapshots the room's current shape (see
// MEMORIZED_SHAPES) -- captured here rather than kept continuously live, same
// checkpoint discipline as DECORATED's evaluate-on-exit-edit-mode. Clearing
// memorized drops the snapshot too: a shape is only meaningful while the room
// is actually memorized. async so both callers (a fire-and-forget button
// click, and a test that DOES await it) get correct behavior either way --
// the toolbar itself still updates immediately, before the writes settle.
async function toggleMemorized(){
  if(!currentRoomFen()) return;
  if(MEMORIZED[currentRoomKey]){
    delete MEMORIZED[currentRoomKey];
    delete MEMORIZED_SHAPES[currentRoomKey];
  } else {
    MEMORIZED[currentRoomKey] = Date.now();
    const shape = ROOMS[currentRoomKey] && ROOMS[currentRoomKey].shape;
    if(shape) MEMORIZED_SHAPES[currentRoomKey] = shape;
  }
  updateToolbar();
  await Promise.all([persistMemorized(), persistMemorizedShapes()]);
}

async function loadDecorated(){
  const raw = await getMeta(DECORATED_KEY);
  try { DECORATED = raw ? JSON.parse(raw) : {}; }
  catch { DECORATED = {}; }
}
function persistDecorated(){ setMeta(DECORATED_KEY, JSON.stringify(DECORATED)); }
// A room is fully decorated when every move-object slot has EITHER a real
// image asset OR at least a label (a manual placeholder word -- LAYOUT.slotWords,
// set via the picker's text field -- or a WALL-LIST item's own name, image
// bound or not) AND every forward (non-back) door leads to a named room --
// EXCEPT a
// locked door (see isRoomEmpty): its target is a genuine dead end with
// nothing built past it, so there's nothing there worth naming or
// remembering, and requiring a name would just block "decorated" on rooms
// deliberately left as plain passageways. Door SKIN is never checked here --
// only naming and slot art/labeling matter for whether a room can be
// memorized. The shared center/anchor pair is excluded unless this room
// hosts it in-room (entryNoStreet) -- normally it's decorated at the street
// building's entry instead (see buildSlots' matching skip). A door whose
// target isn't registered this session (e.g. an unlinked foreign castle in a
// single-castle preview) is skipped rather than counted as a failure --
// that's session state, not missing work. A room with nothing to fill is
// vacuously true.
function computeFullyDecorated(roomKey){
  const room = mergedRoom(roomKey);
  if(!room) return false;
  for(const slot of moveObjectSlots(roomKey)){
    if(slot.side === 'center' && !room.entryNoStreet) continue;
    const listResolved = moveObjectListResolved(roomKey, slot);
    const filled = slotAssetFor(roomKey, slot.id) || slotWordFor(roomKey, slot.id) || listResolved?.asset || listResolved?.word;
    if(!filled) return false;
  }
  for(const ex of (room.exits || [])){
    if(ex.back) continue;
    if(!ROOMS[ex.target]) continue;
    if(isRoomEmpty(ex.target)) continue;
    if(!roomNameFor(ex.target)) return false;
  }
  return true;
}
// (Re)computes and persists roomKey's decorated flag. Skips mainStreet/
// buildings (no posKey -- nothing to decorate there), same gate toggleMemorized
// uses for the same reason.
function evaluateDecorated(roomKey){
  const pk = ROOMS[roomKey] && ROOMS[roomKey].posKey;
  if(!pk || !pk.includes('/')) return;
  if(computeFullyDecorated(roomKey)) DECORATED[roomKey] = Date.now();
  else delete DECORATED[roomKey];
  persistDecorated();
}

// Whether a memorized room has picked up a new forward exit since it was last
// memorized -- Phase 2 of the memorized-room-stability design (see
// MEMORIZED_SHAPES). Originally scoped to non-linear rooms only, because a
// linear room's ('corridor'/'two-track') snapshot didn't stay meaningfully
// comparable once a mid-sequence branch restructured it -- Phase 3's
// side-door mechanism closed exactly that gap: a memorized linear room's
// `kind` and `members`/`left`/`right` now stay stable across a regen even
// after an interior branch lands (that's the whole point of the side-door),
// so its exitPosKeys are just as diffable as a non-linear room's. The
// `snap.kind !== live.kind` guard below still protects the one remaining
// case a side-door doesn't cover: a room whose memorized shape didn't
// survive at all (e.g. the anchor itself vanished, or the room fell outside
// what the side-door mechanism could preserve) -- that shows as NOT dirty
// here, on the theory that a room this drastically different from its own
// memory isn't well-served by a "new door" framing; MEMORIZED simply stays
// stale until the user notices in VR and either re-memorizes or resets it.
function isRoomDirty(roomKey){
  const snap = MEMORIZED_SHAPES[roomKey];
  const live = ROOMS[roomKey] && ROOMS[roomKey].shape;
  if(!snap || !live || snap.kind !== live.kind) return false;
  const known = new Set(snap.exitPosKeys || []);
  return (live.exitPosKeys || []).some(k => !known.has(k));
}

// A room is "empty" when it has no forward (non-back) exits AND no wall
// content of its own -- a genuine dead end, nothing further has been built
// past it (an UNBUILT continuation never gets a real exit -- see
// registerOneCastle's `fwd` filter -- so a room whose only further move is
// still undecided reads as empty too, same as one with no further move at
// all; either way there's nothing to walk into). The exits check alone
// isn't enough: a corridor/two-track room (registerOneCastle's box merging)
// can hold a whole chain of real moves as wall-pair billboards
// (DEMO_MNEMONICS[roomKey].pairs, NOT room.exits -- those pairs never leave
// the room) and still legitimately have zero forward doors if its own chain
// simply hasn't been continued yet -- that room is not "nothing to walk
// into" the way a truly bare room is (the reported bug: a whole 10-move
// corridor read as a locked door because it happened to dead-end).
// Specifically checks for a pair with side !== 'center': EVERY room, even a
// genuine single-move leaf, gets its own 'center' anchor pair (order 1) --
// but that one is never rendered in-room at all, it shows at the PARENT's
// door instead (see buildSlots' side==='center' skip) -- so a bare leaf room
// has a pairs array of length 1 that still represents zero in-room content.
// A corridor's SECOND and later members (its actual continuation) get
// side:'left'; a two-track's branch members get 'left'/'right' -- either
// shape means real wall content sits in this room. Computed live like
// DECORATED, not stored, so a locked door unlocks itself automatically the
// moment that continuation gets built. Ordinary (ROOMS-registered) rooms
// only -- an unregistered foreign-castle target (single-castle preview) is
// never treated as empty, since we can't know its real structure this
// session.
function isRoomEmpty(roomKey){
  const room = mergedRoom(roomKey);
  if(!room) return false;
  if((room.exits || []).some(ex => !ex.back)) return false;
  const pairs = DEMO_MNEMONICS[roomKey]?.pairs;
  return !(pairs && pairs.some(p => p.side !== 'center'));
}

function ensureRoomLayout(roomKey){
  if(!LAYOUT[roomKey]) LAYOUT[roomKey] = {};
  const r = LAYOUT[roomKey];
  if(!r.walls) r.walls = {};
  if(!r.slots) r.slots = {};
  if(!r.slotWords) r.slotWords = {};
  if(!r.slotXform) r.slotXform = {};
  if(!r.buildings) r.buildings = {};
  if(!r.signs) r.signs = {};
  if(!r.signPos) r.signPos = {};
  if(!r.yards) r.yards = {};
  if(!r.doors) r.doors = {};
  if(!r.exits) r.exits = {};
  return r;
}

/* apply an edit (mutate LAYOUT), persist, refresh assets, and rebuild the
   current room in place (keeps the player's position/orientation). */
async function applyEdit(mutator){
  snapshotLayoutForUndo();
  mutator();
  persistLayout();
  await refreshAssetMap();
  buildRoom(currentRoomKey);
}

function setFloorOverride(roomKey, assetId){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    if(assetId) r.floor = assetId; else delete r.floor;
  });
}
function setWallOverride(roomKey, wall, assetId){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    if(assetId) r.walls[wall] = assetId; else delete r.walls[wall];
  });
}
function setCeilingOverride(roomKey, assetId){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    if(assetId) r.ceiling = assetId; else delete r.ceiling;
  });
}
function setStairOverride(roomKey, assetId){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    if(assetId) r.stairSurface = assetId; else delete r.stairSurface;
  });
}
function setSlotOverride(roomKey, slotId, assetId){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    if(assetId) r.slots[slotId] = assetId; else delete r.slots[slotId];
    if(!assetId) delete r.slotXform[slotId];   // removed prop loses its nudge/scale too
    delete r.slotWords[slotId];   // a real image replaces any placeholder label, and "Remove" (assetId null) must clear a label-only override too, or it lingers forever unremovable
  });
}
// a manually-typed placeholder label for a move-object slot -- a lightweight
// stand-in ("just the name of the thing") for when making a real image asset
// isn't worth the time yet. Renders via the same word-plaque builder a wall-
// list item's word-only entry already uses (buildMoveObjectWordLabel), and --
// same as that wall-list case -- counts as filled for "fully decorated"
// purposes (see computeFullyDecorated), since the user is explicitly saying
// "this is decorated, just not with an image yet." Mutually exclusive with a
// real asset override: setting one clears the other.
function setSlotWordOverride(roomKey, slotId, word){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    if(word) r.slotWords[slotId] = word; else delete r.slotWords[slotId];
    if(word) delete r.slots[slotId];
  });
}
function slotWordFor(roomKey, slotId){
  const r = LAYOUT[roomKey];
  return (r && r.slotWords && r.slotWords[slotId]) || null;
}
function slotXformFor(roomKey, slotId){
  const r = LAYOUT[roomKey];
  return (r && r.slotXform && r.slotXform[slotId]) || null;
}
// Transform-only edit (nudge/scale/rotate): persist the new xform and move the
// existing object in place, skipping the full applyEdit -> buildRoom rebuild
// that would tear down and reload every mesh/texture in the room (the cause of
// the edit-time flashing). Geometry/assets are unchanged, so re-placing the one
// object is enough.
function setSlotXformLive(roomKey, slotId, xform){
  snapshotForXformEdit(roomKey + ':' + slotId);
  const r = ensureRoomLayout(roomKey);
  r.slotXform[slotId] = xform;
  persistLayout();
  const obj = findAccessoryObject(slotId);
  if(!obj){ buildRoom(currentRoomKey); return; }   // fallback if it wasn't found
  const room = mergedRoom(roomKey);
  // a door object has no roomSlots entry -- its base pos + asset ride on userData,
  // so re-place it from those rather than looking the slot up.
  if(obj.userData.doorObj){
    applyAccessoryTransform(obj, room, { kind: 'moveObject', x: obj.userData.base.x, z: obj.userData.base.z },
                            obj.userData.asset || { size: {} }, xform);
    refreshSelectionVisuals();
    rebuildMoveObjectChainLive(roomKey);   // a door object is the chain's own final endpoint
    return;
  }
  if(obj.userData.doorBill){
    const b = obj.userData.base;
    obj.position.set(b.x + (xform.dx || 0), b.y + (xform.dy || 0), b.z + (xform.dz || 0));
    obj.userData.userScale = xform.scale || 1;
    applySpriteContentScale(obj);
    refreshSelectionVisuals();
    return;
  }
  const slot = slotById(room, roomKey, slotId);
  if(!slot) return;
  if(slot.kind === 'mnemonic'){
    obj.position.set(slot.x + (xform.dx || 0), slot.y + (xform.dy || 0), slot.z + (xform.dz || 0));
    obj.userData.userScale = xform.scale || 1;
    applySpriteContentScale(obj);
  } else {
    const asset = slotAssetFor(roomKey, slotId);
    if(asset){
      applyAccessoryTransform(obj, room, slot, asset, xform);
    } else {
      // a word-only plaque (no image asset bound yet) -- reposition/rescale it
      // directly, mirroring buildMoveObjectWordLabel's own placement formula.
      const p = moveObjectWordLabelPos(slot, xform);
      const s = xform.scale || 1;
      obj.position.set(p.x, p.y, p.z);
      obj.scale.set(1.1 * s, 0.55 * s, 1);
    }
    // an image-backed move-object (hints on) has a decorative word caption that
    // isn't the 'accessory' mesh above; drag it along so it doesn't lag the
    // picture during a live nudge (it otherwise only catches up on a rebuild).
    const cap = findSubtitleObject(slotId);
    if(cap){ const p = moveObjectSubtitlePos(slot, xform); cap.position.set(p.x, p.y, p.z); }
    if(slot.kind === 'moveObject') rebuildMoveObjectChainLive(roomKey);   // this slot's own position is a chain endpoint (not for a plain 'floor' prop)
  }
  refreshSelectionVisuals();
}
function findAccessoryObject(slotId){
  let obj = null;
  if(scene) scene.traverse(o => {
    if(!obj && o.userData && o.userData.kind === 'accessory' && o.userData.slotId === slotId) obj = o;
  });
  return obj;
}
function findSubtitleObject(slotId){
  let obj = null;
  if(scene) scene.traverse(o => {
    if(!obj && o.userData && o.userData.subtitleFor === slotId) obj = o;
  });
  return obj;
}
// rebuilds just the selection outline/gear around the (possibly moved) object --
// cheap, no textures, so no flash.
function refreshSelectionVisuals(){
  removeSelectionVisuals();
  attachSelectionVisuals();
}
function setBuildingFacadeOverride(roomKey, buildingKey, assetId){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    if(assetId) r.buildings[buildingKey] = assetId; else delete r.buildings[buildingKey];
  });
}
function setSignOverride(roomKey, buildingKey, assetId){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    if(assetId) r.signs[buildingKey] = assetId; else delete r.signs[buildingKey];
  });
}
// persist a sign's lawn offset and slide the existing sign group in place, no
// room rebuild (same anti-flash idea as setSlotXformLive).
function setSignPosLive(roomKey, buildingKey, pos){
  snapshotForXformEdit(roomKey + ':sign:' + buildingKey);
  const r = ensureRoomLayout(roomKey);
  if(pos && (pos.dx || pos.dz)) r.signPos[buildingKey] = pos; else delete r.signPos[buildingKey];
  persistLayout();
  let obj = null;
  if(scene) scene.traverse(o => {
    if(!obj && o.userData && o.userData.kind === 'sign' && o.userData.buildingKey === buildingKey) obj = o;
  });
  if(!obj || !obj.userData.basePos){ buildRoom(currentRoomKey); return; }
  obj.position.set(obj.userData.basePos.x + (pos.dx || 0), 0, obj.userData.basePos.z + (pos.dz || 0));
  refreshSelectionVisuals();
}
function setYardOverride(roomKey, buildingKey, assetId){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    if(assetId) r.yards[buildingKey] = assetId; else delete r.yards[buildingKey];
  });
}
function setDoorOverride(roomKey, dKey, assetId){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    if(assetId) r.doors[dKey] = assetId; else delete r.doors[dKey];
    // An entrance door's skin also becomes its destination room's own exit
    // (back) door skin, so walking out through it looks like walking back
    // through the same door you came in. Only an ordinary forward door
    // resolves to a single destination here -- an elevator's shared floor
    // door has no exit matching its collapsed doorKey, so it's naturally
    // excluded (nothing else needs special-casing: propagating to a locked
    // door's dead-end target is harmless, just an unused stored value).
    // Last write wins if more than one room leads to the same target (a
    // transposition): whichever entrance door was styled most recently sets
    // that room's exit door. Folded into this same mutator (rather than a
    // second setDoorOverride/applyEdit call) so it's one
    // persistLayout+refreshAssetMap+buildRoom cycle, not two racing ones
    // (see setAllDoorAssets's test-hook comment for why that matters).
    const room = mergedRoom(roomKey);
    const ex = room && (room.exits || []).find(e => doorKey(e.wall, e.offset) === dKey);
    if(ex && !ex.back){
      const target = mergedRoom(ex.target);
      const backExit = target && (target.exits || []).find(e => e.back);
      if(backExit){
        const r2 = ensureRoomLayout(ex.target);
        const backKey = doorKey(backExit.wall, backExit.offset);
        if(assetId) r2.doors[backKey] = assetId; else delete r2.doors[backKey];
      }
    }
  });
}

// the stair corridor (if any) on `wall` whose doorway gap spans `across` (the
// coordinate along the wall: x for north/south, z for west/east). Keyed to each
// stair's own offset, so a staircase sharing a wall with other doors is still
// found -- fixes being blocked at the base when an import adds a door there.
function stairGapAt(wall, across){
  const cs = currentStairCorridors[wall];
  if(!cs) return null;
  const dHalf = DOOR_W/2;
  return cs.find(c => across > c.offset - dHalf && across < c.offset + dHalf) || null;
}

// A stair exit's doorway opens onto a real protruding corridor (built by
// buildStairCorridor) rather than the usual "step through and teleport
// almost immediately" gap, so once the player is in the gap we let them
// keep walking past the wall plane -- clamped to the corridor's own width
// and depth -- instead of snapping straight back to the wall.
function clampToRoom(size, x, z){
  const { w, d } = size;
  const halfW = w/2 - PLAYER_RADIUS, halfD = d/2 - PLAYER_RADIUS;
  const dHalf = DOOR_W/2;

  // An ordinary doorway is only ever crossed by the forward teleport (which
  // fires a metre inside the wall), so the wall plane stays SOLID even across
  // the gap -- otherwise backing up through the opening walks you out the back
  // of the room into the void. Only a stair corridor's gap is walkable, and
  // then only within the corridor's own footprint.
  if(z < -halfD){
    const c = stairGapAt('north', x);
    if(c){
      x = Math.max(c.offset-dHalf+PLAYER_RADIUS, Math.min(c.offset+dHalf-PLAYER_RADIUS, x));
      z = Math.max(z, -halfD - c.depth);
    } else z = -halfD;
  }
  if(z > halfD){
    const c = stairGapAt('south', x);
    if(c){
      x = Math.max(c.offset-dHalf+PLAYER_RADIUS, Math.min(c.offset+dHalf-PLAYER_RADIUS, x));
      z = Math.min(z, halfD + c.depth);
    } else z = halfD;
  }
  if(x < -halfW){
    const c = stairGapAt('west', z);
    if(c){
      z = Math.max(c.offset-dHalf+PLAYER_RADIUS, Math.min(c.offset+dHalf-PLAYER_RADIUS, z));
      x = Math.max(x, -halfW - c.depth);
    } else x = -halfW;
  }
  if(x > halfW){
    const c = stairGapAt('east', z);
    if(c){
      z = Math.max(c.offset-dHalf+PLAYER_RADIUS, Math.min(c.offset+dHalf-PLAYER_RADIUS, z));
      x = Math.min(x, halfW + c.depth);
    } else x = halfW;
  }
  return { x, z };
}

// Outdoor streets have no surrounding wall (clampToRoom only bounds the
// overall street edges), so each building needs its own collision against
// its brick box -- otherwise you can walk straight through it anywhere but
// the door. No door-window exception is needed here: a building's door
// teleport trigger (doorTriggerBox, built with a 1m pad) reaches a meter
// outside the wall, well before this box would block you, so a legitimate
// approach through the door always teleports you before collision engages.
// Extends a building's collision box rearward (away from its door wall) until
// its back face meets the room boundary, so the hollow back of this movie-set
// box can never be reached -- the player can stand in front of it and to either
// side, but the strip behind it (where the fakery shows) is walled off. The
// front face (and thus the door and its trigger) is left exactly where it was.
function sealBehindBuilding(collider, roomSize){
  const { origin, size, doorWall, doorOffset } = collider;
  const o = { x: origin.x, z: origin.z };
  const s = { w: size.w, d: size.d, h: size.h };
  // seal a few meters behind the box rather than clear to the room edge: with
  // castles on several parallel side streets, an edge-length seal from one
  // street's buildings would wall off the streets behind them.
  const BACK_PAD = 4;
  const clampBack = (back, edge) => (edge < 0 ? Math.max(back, edge) : Math.min(back, edge));
  if(doorWall === 'south' || doorWall === 'north'){
    const front = doorWall === 'south' ? origin.z + size.d/2 : origin.z - size.d/2;
    const back  = doorWall === 'south'
      ? clampBack(origin.z - size.d/2 - BACK_PAD, -roomSize.d/2)
      : clampBack(origin.z + size.d/2 + BACK_PAD, roomSize.d/2);
    s.d = Math.abs(front - back);
    o.z = (front + back) / 2;
  } else {
    const front = doorWall === 'east' ? origin.x + size.w/2 : origin.x - size.w/2;
    const back  = doorWall === 'east'
      ? clampBack(origin.x - size.w/2 - BACK_PAD, -roomSize.w/2)
      : clampBack(origin.x + size.w/2 + BACK_PAD, roomSize.w/2);
    s.w = Math.abs(front - back);
    o.x = (front + back) / 2;
  }
  return { origin: o, size: s, doorWall, doorOffset };
}

function clampBuildings(x, z){
  for(const c of currentBuildingColliders){
    const halfW = c.size.w/2 + PLAYER_RADIUS, halfD = c.size.d/2 + PLAYER_RADIUS;
    const lx = x - c.origin.x, lz = z - c.origin.z;
    if(lx <= -halfW || lx >= halfW || lz <= -halfD || lz >= halfD) continue;
    const distLeft = lx + halfW, distRight = halfW - lx;
    const distNear = lz + halfD, distFar = halfD - lz;
    const min = Math.min(distLeft, distRight, distNear, distFar);
    if(min === distLeft) x = c.origin.x - halfW;
    else if(min === distRight) x = c.origin.x + halfW;
    else if(min === distNear) z = c.origin.z - halfD;
    else z = c.origin.z + halfD;
  }
  return { x, z };
}

// Maps a z-position inside a room to the local floor height there.
// Rooms with no `stairs` config are flat (height 0 everywhere). A room
// with stairs ramps from 0 at/after fromZ down to `rise` at/before toZ
// (toward the back wall), giving a raised platform reached by a staircase
// without requiring a second story (the room's walls/ceiling/door are
// unchanged -- only the floor height under the player's feet varies).
function floorHeightAt(room, z){
  if(!room.stairs) return 0;
  const { fromZ, toZ, rise } = room.stairs;
  if(z >= fromZ) return 0;
  if(z <= toZ) return rise;
  const t = (fromZ - z) / (fromZ - toZ);
  return rise * t;
}

// A stair exit's corridor geometry, derived from the room's own ceiling
// height so the climb always reaches exactly ceiling height by the far end.
function stairCorridorGeom(room){
  const rise = room.size.h;
  const steps = Math.max(4, Math.ceil(rise / STAIR_STEP_RISE));
  const depth = steps * STAIR_STEP_RUN;
  return { rise, steps, depth };
}

// Like floorHeightAt, but also accounts for any stair-exit corridor the
// player may have walked into (clampToRoom is what keeps x/z inside the
// corridor's actual footprint once they're past the wall plane). Falls
// back to the legacy single-room stairs platform when not in a corridor.
function floorHeightAtPos(room, x, z){
  for(const wall in currentStairCorridors){
    const { axis, fixed } = wallSpan(room.size, wall);
    const across = axis === 'x' ? x : z;    // coordinate along the wall
    for(const c of currentStairCorridors[wall]){
      if(Math.abs(across - c.offset) > DOOR_W/2) continue;   // not in this stair's gap
      const along = (axis === 'x' ? z - fixed : x - fixed) * c.outSign;
      if(along > 0) return (c.dir || 1) * c.rise * Math.min(1, along / c.depth);
    }
  }
  return floorHeightAt(room, z);
}

// Desired camera pitch for the current position: level (0) everywhere except
// when approaching or standing on a down-staircase, where it ramps to
// STAIR_DOWN_PEEK_PITCH so the descending steps come into view. The ramp keys
// off proximity to the doorway threshold (real stairs drop straight down, so a
// level gaze would otherwise sail right over them).
function downStairPeekPitch(room, x, z){
  for(const wall in currentStairCorridors){
    const { axis, fixed } = wallSpan(room.size, wall);
    for(const c of currentStairCorridors[wall]){
      if(c.dir >= 0) continue;   // only down-staircases
      // must be roughly lined up with this stair's doorway, not off to the side
      const lateral = (axis === 'x' ? x : z) - c.offset;
      if(Math.abs(lateral) > DOOR_W/2 + 0.3) continue;
      const along = (axis === 'x' ? z - fixed : x - fixed) * c.outSign;
      if(along >= 0) return STAIR_DOWN_PEEK_PITCH;              // on the descent
      if(along > -STAIR_DOWN_PEEK_DIST)                          // approaching
        return STAIR_DOWN_PEEK_PITCH * (1 + along / STAIR_DOWN_PEEK_DIST);
    }
  }
  return 0;
}

/* ---------- procedural textures & furniture ----------
   No build step and no reachable CDN for real CC0 texture/furniture
   assets in this environment, so wall/floor surface detail and the
   one piece of furniture per room are generated at runtime: textures
   via offscreen <canvas> (same technique as the wall number labels),
   furniture as small groups of primitive geometry.
*/
function makeCanvasTexture(draw, size){
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Pure function of tintHex -- callers always .clone() before setting .repeat
// (see buildWallGroup's materialFor), so the base texture returned here is
// never mutated in place and is safe to hand out from a cache. Main Street
// hands every castle building the same tint, so without this cache each one
// redraws and re-uploads an identical canvas texture from scratch.
const _brickTexCache = new Map();
function makeBrickTexture(tintHex){
  const cached = _brickTexCache.get(tintHex);
  if(cached) return cached;
  const tex = makeBrickTextureUncached(tintHex);
  _brickTexCache.set(tintHex, tex);
  return tex;
}
function makeBrickTextureUncached(tintHex){
  return makeCanvasTexture((ctx, size) => {
    const tint = new THREE.Color(tintHex);
    ctx.fillStyle = `rgb(${tint.r*255},${tint.g*255},${tint.b*255})`;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 3;
    const rows = 6, brickH = size/rows, cols = 4, brickW = size/cols;
    for(let r=0; r<rows; r++){
      const y = r*brickH;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
      const offset = (r%2===0) ? 0 : brickW/2;
      for(let x=-offset; x<size; x+=brickW){
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y+brickH); ctx.stroke();
      }
    }
  }, 256);
}

// Thin gray metal chain-link tile: one "vertical" link stacked over one
// "horizontal" link (real chain links alternate orientation since each is
// threaded through its neighbor) -- tiling this along a strip's length
// (see buildMoveObjectChain) reads as a continuous chain whose apparent
// link count scales with the strip's length, not a fixed sprite count.
// Transparent background (canvas alpha, un-drawn = un-drawn) so only the
// link outlines show against the floor, not a solid rectangle.
let _chainTexture = null;
function makeChainTexture(){
  if(_chainTexture) return _chainTexture;
  _chainTexture = makeCanvasTexture((ctx, size) => {
    const drawLink = (cx, cy, rx, ry) => {
      ctx.lineWidth = size * 0.11;
      ctx.strokeStyle = '#7d8489';
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = size * 0.035;
      ctx.strokeStyle = '#dfe3e6';
      ctx.beginPath();
      ctx.ellipse(cx - rx * 0.15, cy - ry * 0.15, rx * 0.78, ry * 0.78, 0, 0, Math.PI * 2);
      ctx.stroke();
    };
    // Each link is drawn three times (at its true v-position, and one tile
    // height above/below) so a link whose reach spills past the canvas edge
    // still shows its wrapped portion at the opposite edge -- a plain
    // canvas draw just clips at 0/size, it doesn't wrap on its own, so
    // without this an overlapping link would be cut off rather than
    // reappearing where RepeatWrapping needs it to.
    const drawLinkTiled = (cyFrac, rx, ry) => {
      for(const k of [-1, 0, 1]) drawLink(size / 2, size * (cyFrac + k), rx, ry);
    };
    // Two alternating-orientation links per tile, centers exactly half a
    // period apart (0.25/0.75 -- the previous 0.27/0.73 was off-center by
    // 0.04, which made the within-tile gap and the across-the-seam gap
    // different sizes) with vertical reaches (ry) summing to slightly OVER
    // half a period so neighbors overlap a touch instead of leaving a
    // hairline gap to anti-aliasing -- with evenly-spaced centers, that one
    // sum governs both the within-tile gap and the wrap-seam gap at once.
    drawLinkTiled(0.25, size * 0.15, size * 0.30);   // vertical-oriented link
    drawLinkTiled(0.75, size * 0.26, size * 0.22);   // horizontal-oriented link
  }, 128);
  return _chainTexture;
}

// flat, unadorned wall surface for elevator car interiors -- brick reads
// as un-elevator-like; just the room's tint with a faint panel seam so it
// doesn't look like an untextured void.
function makePlainWallTexture(tintHex){
  return makeCanvasTexture((ctx, size) => {
    const tint = new THREE.Color(tintHex);
    ctx.fillStyle = `rgb(${tint.r*255},${tint.g*255},${tint.b*255})`;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 2;
    ctx.strokeRect(size*0.04, size*0.04, size*0.92, size*0.92);
  }, 256);
}

function makeFloorTexture(){
  return makeCanvasTexture((ctx, size) => {
    const planks = 8, plankW = size/planks;
    for(let i=0; i<planks; i++){
      const shade = (i*37) % 30;
      ctx.fillStyle = `rgb(${118+shade},${84+shade*0.6},${50+shade*0.4})`;
      ctx.fillRect(i*plankW, 0, plankW-2, size);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 2;
    for(let i=0; i<=planks; i++){
      ctx.beginPath(); ctx.moveTo(i*plankW, 0); ctx.lineTo(i*plankW, size); ctx.stroke();
    }
  }, 256);
}

// Flat-color grass base for the whole outdoor room, with one flat-color
// asphalt plane laid over it per `room.roads` entry (slightly raised to
// avoid z-fighting with the grass).
function buildOutdoorGround(room){
  const group = new THREE.Group();
  const { w, d } = room.size;
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ color: 0x4a8f4a })
  );
  grass.rotation.x = -Math.PI/2;
  group.add(grass);

  const asphaltMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a });
  for(const r of room.roads || []){
    const road = new THREE.Mesh(new THREE.PlaneGeometry(r.sx, r.sz), asphaltMat);
    road.rotation.x = -Math.PI/2;
    road.position.set(r.x, 0.01, r.z);
    group.add(road);
  }
  return group;
}

// Fluffy clouds drifting over an outdoor scene: each cloud is a cluster of
// flattened white spheres, scattered high across the room. Purely decorative
// (no collision); count scales with the street's footprint.
function buildClouds(room){
  const group = new THREE.Group();
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0, emissive: 0x223044, emissiveIntensity: 0.18
  });
  const { w, d } = room.size;
  const n = Math.max(6, Math.round((w * d) / 800));
  for(let i = 0; i < n; i++){
    const cloud = new THREE.Group();
    const puffs = 3 + Math.floor(Math.random() * 4);
    for(let p = 0; p < puffs; p++){
      const r = 1.6 + Math.random() * 2.4;
      const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), cloudMat);
      puff.position.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 3.5);
      puff.scale.y = 0.6;
      cloud.add(puff);
    }
    cloud.position.set((Math.random() - 0.5) * w, 13 + Math.random() * 7, (Math.random() - 0.5) * d);
    group.add(cloud);
  }
  return group;
}

function makeTable(){
  const group = new THREE.Group();
  const topMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b });
  const legMat = new THREE.MeshStandardMaterial({ color: 0x5e3a1a });
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.8), topMat);
  top.position.y = 0.72;
  group.add(top);
  const legGeo = new THREE.BoxGeometry(0.08, 0.7, 0.08);
  for(const [x, z] of [[-0.6,-0.32],[0.6,-0.32],[-0.6,0.32],[0.6,0.32]]){
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(x, 0.35, z);
    group.add(leg);
  }
  return group;
}

function makeChair(){
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x5b3a22 });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.5), mat);
  seat.position.y = 0.45;
  group.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.06), mat);
  back.position.set(0, 0.72, -0.22);
  group.add(back);
  const legGeo = new THREE.BoxGeometry(0.06, 0.45, 0.06);
  for(const [x, z] of [[-0.2,-0.2],[0.2,-0.2],[-0.2,0.2],[0.2,0.2]]){
    const leg = new THREE.Mesh(legGeo, mat);
    leg.position.set(x, 0.225, z);
    group.add(leg);
  }
  return group;
}

function makeChest(){
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a3320 });
  const bandMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.55, 0.55), bodyMat);
  body.position.y = 0.275;
  group.add(body);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.1, 0.57), bodyMat);
  lid.position.y = 0.58;
  group.add(lid);
  const band = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.08, 0.59), bandMat);
  band.position.y = 0.275;
  group.add(band);
  return group;
}

const FURNITURE_BUILDERS = { table: makeTable, chair: makeChair, chest: makeChest };

function placeFurniture(room){
  if(!room.furniture) return null;
  const builder = FURNITURE_BUILDERS[room.furniture.type];
  if(!builder) return null;
  const mesh = builder();
  const floorY = floorHeightAt(room, room.furniture.z);
  mesh.position.set(room.furniture.x, floorY, room.furniture.z);
  mesh.rotation.y = room.furniture.yaw || 0;
  return mesh;
}

/* ---------- asset → geometry (in-world layout editor) ----------
   Turns an asset record from the 'assets' store into three.js geometry:
   surfaces become tiled MeshStandardMaterials, props become boxes,
   billboards or sprites per Documents/three-assets.md. Textures load from
   the asset's base64 data-URL (TextureLoader handles data URLs fine), with
   the same buildGeneration guard the facade loader uses so a texture that
   finishes loading after a room change is discarded.
*/
function assetSurfaceMaterial(asset, repeatX, repeatY){
  if(asset.isColor){
    return new THREE.MeshStandardMaterial({ color: new THREE.Color(asset.color), roughness: 0.85, metalness: 0 });
  }
  const mat = new THREE.MeshStandardMaterial({
    color: asset.tint ? new THREE.Color(asset.tint) : 0xffffff,
    roughness: asset.roughness ?? 0.85,
    metalness: asset.metalness ?? 0
  });
  const myGen = buildGeneration;
  textureLoader.load(asset.image, (tex) => {
    if(buildGeneration !== myGen) return;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.repeat.set(Math.max(0.01, repeatX), Math.max(0.01, repeatY));
    if(asset.rotation){ tex.center.set(0.5, 0.5); tex.rotation = asset.rotation * Math.PI/180; }
    mat.map = tex;
    mat.needsUpdate = true;
  });
  return mat;
}

// a cylindrical billboard: a flat plane, rotated to face the camera's
// horizontal angle each frame (see the `billboards` array/update loop) but
// never tilting up/down -- the right choice for anything meant to stand in
// the room (see PROP_TYPES' own comment). Also built for a legacy
// 'billboard-sprite' asset (normalized to 'billboard-cylindrical' on read by
// db.js's getAllAssets), so this function itself no longer needs to know
// that type ever existed.
function buildBillboardAsset(asset){
  const { w, h } = asset.size;
  // alphaTest-only cutout (no `transparent` blending): semi-transparent
  // anti-aliased edge pixels in the source PNG carry near-black RGB once
  // alpha-blended, which read as a dark halo around the cutout shape.
  // Hard-discarding below the threshold instead of blending avoids that.
  const mat = new THREE.MeshStandardMaterial({ transparent: false, alphaTest: 0.5, side: THREE.DoubleSide });
  const myGen = buildGeneration;
  textureLoader.load(asset.image, (tex) => {
    if(buildGeneration !== myGen) return;
    tex.colorSpace = THREE.SRGBColorSpace;
    mat.map = tex; mat.needsUpdate = true;
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
}

/* ---------- extruded prop ----------
   Trace the image's opaque silhouette and extrude it into a slab: the front
   (and back) cap shows the image, the side walls get a flat color sampled from
   the silhouette's edge pixels. Gives a box-style prop real depth that follows
   the picture's contour instead of a rectangular block.

   The silhouette trace + edge-color sample need raw pixels, which only arrive
   once the image decodes, so this returns an empty Group up front and fills in
   the real mesh asynchronously (guarded by buildGeneration, like the loaders). */
function buildExtrudedAsset(asset){
  const group = new THREE.Group();
  const { w, h } = asset.size;
  const depth = asset.size.d || 0.3;
  const myGen = buildGeneration;
  const img = new Image();
  img.onload = () => {
    if(buildGeneration !== myGen) return;
    // sample the alpha mask at a capped resolution -- contour detail past a
    // couple hundred px buys nothing once it's simplified, and keeps the trace
    // cheap even for a 1024px source.
    const TRACE_MAX = 220;
    const scale = Math.min(1, TRACE_MAX / Math.max(img.width, img.height));
    const cw = Math.max(1, Math.round(img.width * scale));
    const ch = Math.max(1, Math.round(img.height * scale));
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch).data;
    const opaque = (x, y) => x >= 0 && y >= 0 && x < cw && y < ch && data[(y * cw + x) * 4 + 3] > 128;

    let contour = traceSilhouette(opaque, cw, ch);
    if(contour.length < 3){ return; } // nothing opaque -> leave the group empty
    contour = simplifyPath(contour, Math.max(1, Math.min(cw, ch) * 0.012));
    if(contour.length < 3){ return; }

    // pixel coords (x right, y down) -> centred world coords spanning w x h,
    // y flipped so the picture stands upright.
    const shape = new THREE.Shape();
    contour.forEach(([px, py], i) => {
      const X = (px / cw - 0.5) * w;
      const Y = (0.5 - py / ch) * h;
      i === 0 ? shape.moveTo(X, Y) : shape.lineTo(X, Y);
    });
    shape.closePath();

    // map a cap vertex to UV; `flip` mirrors U so the back cap reads the same
    // way round as the front instead of mirror-imaged (the two caps face
    // opposite directions, so one of them must flip to look right from its side)
    const capUV = (X, Y, flip) => new THREE.Vector2((flip ? -X : X) / w + 0.5, Y / h + 0.5);
    const uvGen = {
      generateTopUV(g, v, a, b, c){
        // the z~0 cap becomes the -z (back) face after the centring translate
        const back = v[a*3+2] <= depth * 0.5;
        return [ capUV(v[a*3], v[a*3+1], back), capUV(v[b*3], v[b*3+1], back), capUV(v[c*3], v[c*3+1], back) ];
      },
      generateSideWallUV(){
        return [ new THREE.Vector2(0,0), new THREE.Vector2(1,0), new THREE.Vector2(1,1), new THREE.Vector2(0,1) ];
      }
    };
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, UVGenerator: uvGen });
    geo.translate(0, 0, -depth / 2); // centre in z so -z stays the front face

    const sideColor = asset.sideColor && asset.sideColor !== 'auto'
      ? asset.sideColor : edgeColor(data, cw, ch);
    const sideMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(sideColor) });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    textureLoader.load(asset.image, (tex) => {
      if(buildGeneration !== myGen) return;
      tex.colorSpace = THREE.SRGBColorSpace;
      capMat.map = tex; capMat.needsUpdate = true;
    });
    // ExtrudeGeometry groups material 0 = front/back caps, 1 = side walls.
    const mesh = new THREE.Mesh(geo, [capMat, sideMat]);
    if(asset.orientation === 'flat'){
      // tip the standing cutout onto its back so the cap (was facing -z) now
      // faces +y -- a rug/floor-covering lying flat with its image up.
      mesh.rotation.x = Math.PI / 2;
    }
    group.add(mesh);
  };
  img.src = asset.image;
  return group;
}

// Moore-neighbour boundary trace of the largest opaque region's outer contour.
// `opaque(x,y)` is a bounds-safe predicate. Returns pixel-space points in order.
function traceSilhouette(opaque, W, H){
  let sx = -1, sy = -1;
  outer: for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){ if(opaque(x, y)){ sx = x; sy = y; break outer; } }
  if(sx < 0) return [];
  // 8 neighbours, clockwise from east
  const N = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  const contour = [[sx, sy]];
  let p = [sx, sy];
  let back = [sx - 1, sy];           // we reached the start from the west (its left is background)
  const maxSteps = W * H * 8;
  for(let steps = 0; steps < maxSteps; steps++){
    let dir = N.findIndex(d => p[0] + d[0] === back[0] && p[1] + d[1] === back[1]);
    if(dir < 0) dir = 0;
    let found = false;
    for(let i = 1; i <= 8; i++){
      const idx = (dir + i) % 8;
      const cx = p[0] + N[idx][0], cy = p[1] + N[idx][1];
      if(opaque(cx, cy)){
        back = [ p[0] + N[(idx + 7) % 8][0], p[1] + N[(idx + 7) % 8][1] ];
        p = [cx, cy];
        contour.push(p);
        found = true;
        break;
      }
    }
    if(!found) break;                // isolated pixel
    if(p[0] === sx && p[1] === sy){ contour.pop(); break; } // closed the loop
  }
  return contour;
}

// Ramer-Douglas-Peucker: drop points that lie within `eps` of the chord.
function simplifyPath(pts, eps){
  if(pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while(stack.length){
    const [a, b] = stack.pop();
    let maxD = -1, maxI = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    for(let i = a + 1; i < b; i++){
      const [px, py] = pts[i];
      const d = Math.abs((px - ax) * dy - (py - ay) * dx) / len;
      if(d > maxD){ maxD = d; maxI = i; }
    }
    if(maxD > eps && maxI > 0){ keep[maxI] = true; stack.push([a, maxI], [maxI, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Average colour of opaque pixels that border a transparent one -- the colours
// that "wrap around" the silhouette edge, so the extruded sides read as a
// natural continuation of the picture rather than a clashing flat slab.
function edgeColor(data, W, H){
  const op = (x, y) => x >= 0 && y >= 0 && x < W && y < H && data[(y * W + x) * 4 + 3] > 128;
  let r = 0, g = 0, b = 0, n = 0, ar = 0, ag = 0, ab = 0, an = 0;
  for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){
    const i = (y * W + x) * 4;
    if(data[i + 3] <= 128) continue;
    ar += data[i]; ag += data[i+1]; ab += data[i+2]; an++;
    if(!op(x-1,y) || !op(x+1,y) || !op(x,y-1) || !op(x,y+1)){
      r += data[i]; g += data[i+1]; b += data[i+2]; n++;
    }
  }
  if(n) return new THREE.Color(r/n/255, g/n/255, b/n/255);          // border pixels
  if(an) return new THREE.Color(ar/an/255, ag/an/255, ab/an/255);   // fully-opaque image: whole-image avg
  return new THREE.Color('#888888');
}

function buildPropAsset(asset){
  if(asset.type === 'extruded') return buildExtrudedAsset(asset);
  return buildBillboardAsset(asset); // cylindrical (or a legacy 'billboard-sprite' asset, normalized to it on read)
}

// rotation.y so a prop's front (local -z) points into the room off a wall
const WALL_INWARD_YAW = { north: Math.PI, south: 0, west: -Math.PI/2, east: Math.PI/2 };

// unit ground-plane normal pointing OUT of a room through each wall (away from
// room centre). Used to confirm the player is actually heading through a
// doorway before teleporting -- not just pressing forward while standing in
// the trigger box facing back into the room.
const WALL_OUT_NORMAL = { north:{x:0,z:-1}, south:{x:0,z:1}, west:{x:-1,z:0}, east:{x:1,z:0} };

// rotation.y that aims a prop's front (local -z) at world point `target` from
// (x,z). Derived so the wall cases above fall out exactly (e.g. a prop south of
// a target gets yaw 0). With no target, default to facing -z (north).
function yawFacing(x, z, target){
  if(!target) return 0;
  return Math.atan2(x - target.x, z - target.z);
}

// The wall a room is normally entered through: its `back:true` exit leads back
// the way you came, so that's the entrance. Rooms with no back exit (the
// outdoor root) fall back to south.
function entranceWall(room){
  const back = (room.exits || []).find(e => e.back);
  return (back && back.wall) || 'south';
}

/* ---------- per-building surface defaults ----------
   A building's default floor/ceiling/stairs/walls/doors, stored in
   LAYOUT.__defaults keyed by building id, so a freshly-generated castle room
   inherits a consistent look without per-room styling. Walls are stored
   relative to the entrance door (the back:true exit) so a default rotates
   correctly into rooms whose door is on a different wall. Two door styles are
   kept: `exitDoor` for the back:true door (lets you make exits stand out) and
   `door` for every other door. Resolution everywhere is: room override ->
   building default -> procedural fallback. */
const WALL_OPPOSITE = { north:'south', south:'north', east:'west', west:'east' };
// the wall on your right / left when standing in the entrance facing into the room
const WALL_RIGHT_OF = { south:'east', north:'west', west:'south', east:'north' };
const WALL_LEFT_OF  = { south:'west', north:'east', west:'north', east:'south' };
function wallRelative(entrance, wall){
  if(wall === entrance) return 'entrance';
  if(wall === WALL_OPPOSITE[entrance]) return 'opposite';
  if(wall === WALL_RIGHT_OF[entrance]) return 'right';
  return 'left';
}
function wallForRelative(entrance, rel){
  if(rel === 'entrance') return entrance;
  if(rel === 'opposite') return WALL_OPPOSITE[entrance];
  if(rel === 'right') return WALL_RIGHT_OF[entrance];
  return WALL_LEFT_OF[entrance];
}
// the building a room belongs to (the generator stamps `building`; the demo's
// rooms have none, so they share one '_default' bucket -- exactly what we want
// for styling the one prototype castle).
function buildingIdFor(roomKey){
  const r = ROOMS[roomKey];
  return (r && r.building) || '_default';
}
function buildingDefaults(roomKey){
  return (LAYOUT.__defaults && LAYOUT.__defaults[buildingIdFor(roomKey)]) || null;
}
function defaultFieldId(roomKey, field){
  const d = buildingDefaults(roomKey);
  return (d && d[field]) || null;
}
// the building-default door asset for a door, choosing the exit-door style when
// the door sits on the back:true exit. Returns an asset record or null.
function defaultDoorAsset(roomKey, isExit){
  const id = defaultFieldId(roomKey, isExit ? 'exitDoor' : 'door');
  return id ? ASSET_BY_ID[id] : null;
}
// the building-default skin for a LOCKED door (see isRoomEmpty) -- a distinct
// category from the ordinary/exit door defaults so a castle's dead-end doors
// (e.g. a "bank vault" skin) don't silently inherit its normal door style.
// Deliberately does NOT fall back to defaultDoorAsset: an unset locked-door
// default means the door stays an open, unskinned gap (with its lock icon),
// not a normal-looking door.
function defaultLockedDoorAsset(roomKey){
  const id = defaultFieldId(roomKey, 'lockedDoor');
  return id ? ASSET_BY_ID[id] : null;
}
// snapshot a room's *effective* surfaces into a style set (the shape shared by
// building defaults and named presets): floor/ceiling/stairs, walls stored
// relative to the entrance door, and three door styles (exit / locked / ordinary).
function snapshotRoomStyle(roomKey){
  const room = mergedRoom(roomKey);
  const ent = entranceWall(room);
  // raw values (not the resolved *AssetFor() records), so a tint override
  // survives the snapshot verbatim instead of collapsing to its base asset id.
  const d = {
    floor: rawSurfaceId(roomKey, 'floor'),
    ceiling: rawSurfaceId(roomKey, 'ceiling'),
    stairSurface: rawSurfaceId(roomKey, 'stairSurface'),
    door: null,
    exitDoor: null,
    lockedDoor: null,
    walls: { entrance:null, opposite:null, left:null, right:null }
  };
  for(const wall of ['north','south','east','west']){
    const id = rawWallId(roomKey, wall);
    if(id) d.walls[wallRelative(ent, wall)] = id;
  }
  // first back:true door -> exitDoor, first locked door -> lockedDoor, first
  // ordinary door -> door
  for(const ex of (room.exits || [])){
    if(ex.type && ex.type !== 'door') continue;          // stairs/elevator have no door panel
    const locked = !ex.back && isRoomEmpty(ex.target);
    const a = doorAssetFor(roomKey, doorKey(ex.wall, ex.offset))
      || (locked ? defaultLockedDoorAsset(roomKey) : defaultDoorAsset(roomKey, !!ex.back));
    if(!a) continue;
    if(ex.back){ if(!d.exitDoor) d.exitDoor = a.id; }
    else if(locked){ if(!d.lockedDoor) d.lockedDoor = a.id; }
    else if(!d.door) d.door = a.id;
  }
  return d;
}
function captureBuildingDefaults(roomKey){
  if(!LAYOUT.__defaults) LAYOUT.__defaults = {};
  LAYOUT.__defaults[buildingIdFor(roomKey)] = snapshotRoomStyle(roomKey);
}
// sets just the lockedDoor field of this room's building defaults (leaving
// every other captured style untouched, or creating a blank default set if
// none exists yet) -- the lightweight counterpart to captureBuildingDefaults'
// full-room snapshot, for the "make this the locked door default for this
// building?" prompt offered right after skinning a locked door (see the
// door-click handler below).
function setLockedDoorBuildingDefault(roomKey, assetId){
  if(!LAYOUT.__defaults) LAYOUT.__defaults = {};
  const id = buildingIdFor(roomKey);
  if(!LAYOUT.__defaults[id]){
    LAYOUT.__defaults[id] = { floor:null, ceiling:null, stairSurface:null, door:null, exitDoor:null, lockedDoor:null,
      walls:{ entrance:null, opposite:null, left:null, right:null } };
  }
  LAYOUT.__defaults[id].lockedDoor = assetId;
}

/* ---------- named presets ----------
   Reusable, named style sets ("Formal", "Rustic", ...) stored in
   LAYOUT.__presets, the same shape as a building default. Made from the current
   room, applied by stamping into a building's defaults (reusing all the
   resolution machinery above), so one click styles a whole castle. */
function listPresetNames(){
  return (LAYOUT.__presets && Object.keys(LAYOUT.__presets)) || [];
}
function savePreset(name, roomKey){
  if(!LAYOUT.__presets) LAYOUT.__presets = {};
  LAYOUT.__presets[name] = snapshotRoomStyle(roomKey);
  persistLayout();
}
function deletePreset(name){
  if(LAYOUT.__presets) delete LAYOUT.__presets[name];
  persistLayout();
}
function applyPresetToBuilding(name, roomKey){
  const p = LAYOUT.__presets && LAYOUT.__presets[name];
  if(!p) return;
  applyEdit(() => {
    if(!LAYOUT.__defaults) LAYOUT.__defaults = {};
    LAYOUT.__defaults[buildingIdFor(roomKey)] = JSON.parse(JSON.stringify(p));   // own copy
  });
}
// stamp a preset directly onto one room as per-room overrides -- walls are
// rotated from relative back to this room's absolute walls, the exit-door
// style goes on the back:true door, the locked-door style on a door leading
// to an empty room, and the ordinary style on the rest. Replaces the room's
// current surface styling (props are left alone). A preset entry of null
// means "no override" (so it falls back to the building default / procedural
// -- for a locked door with no p.lockedDoor, that's an unskinned gap + lock
// icon, deliberately not p.door; see defaultLockedDoorAsset).
function applyPresetToRoom(name, roomKey){
  const p = LAYOUT.__presets && LAYOUT.__presets[name];
  if(!p) return;
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    const room = mergedRoom(roomKey);
    const ent = entranceWall(room);
    if(p.floor) r.floor = p.floor; else delete r.floor;
    if(p.ceiling) r.ceiling = p.ceiling; else delete r.ceiling;
    if(p.stairSurface) r.stairSurface = p.stairSurface; else delete r.stairSurface;
    r.walls = {};
    for(const rel of ['entrance','opposite','left','right']){
      const id = p.walls && p.walls[rel];
      if(id) r.walls[wallForRelative(ent, rel)] = id;
    }
    r.doors = {};
    for(const ex of (room.exits || [])){
      if(ex.type && ex.type !== 'door') continue;
      const locked = !ex.back && isRoomEmpty(ex.target);
      const id = ex.back ? p.exitDoor : (locked ? p.lockedDoor : p.door);
      if(id) r.doors[doorKey(ex.wall, ex.offset)] = id;
    }
  });
}
function escHtml(s){
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
// the raw per-room override id for a surface (no default fallback), so the
// editor can tell a real override from an inherited default -- used to decide
// whether "Remove" is meaningful and to label the picker's source line.
function surfaceOverrideId(roomKey, kind, wall){
  const r = LAYOUT[roomKey];
  if(!r) return null;
  if(kind === 'floor') return r.floor || null;
  if(kind === 'ceiling') return r.ceiling || null;
  if(kind === 'stair') return r.stairSurface || null;
  if(kind === 'wall') return (r.walls && r.walls[wall]) || null;
  return null;
}
// wipe this building's captured defaults; rooms relying on them revert to the
// procedural fallback. Per-room overrides are untouched.
function clearBuildingDefaults(roomKey){
  applyEdit(() => {
    if(LAYOUT.__defaults) delete LAYOUT.__defaults[buildingIdFor(roomKey)];
  });
}
// Default yaw for a free-standing extruded floor prop: its front (local -z)
// points TOWARD the entrance wall (the opposite of WALL_INWARD_YAW, which faces
// a wall-mounted prop *into* the room) so the image side greets you as you walk
// in. Fixed per room -- unlike the old behavior, it no longer swings to track
// whichever door you happened to use.
function defaultFloorYaw(room){
  return (WALL_INWARD_YAW[entranceWall(room)] || 0) + Math.PI;
}

// places a built prop into a slot (floor or wall), tags it for the editor,
// and registers cylindrical billboards for per-frame facing. `xform` is the
// optional per-instance nudge/scale override from LAYOUT[roomKey].slotXform.
function placeSlotAccessory(room, slot, asset, xform){
  xform = xform || {};
  const obj = buildPropAsset(asset);
  applyAccessoryTransform(obj, room, slot, asset, xform);
  obj.userData = { kind: 'accessory', slotId: slot.id };
  if(asset.type === 'billboard-cylindrical') billboards.push(obj);
  return obj;
}

// positions/rotates/scales a built accessory in its slot from the saved xform.
// Split out of placeSlotAccessory so the editor can re-apply a changed xform to
// the existing object in place (no full room rebuild -> no texture-reload flash).
function applyAccessoryTransform(obj, room, slot, asset, xform){
  xform = xform || {};
  const scale = xform.scale || 1;
  if(slot.kind === 'ceiling'){
    // hangs at a fixed drop from the ceiling (a billboard turns to face the
    // camera, so only height matters there -- never nudgeable) but can slide
    // around in the ceiling's own horizontal plane, same dx/dz convention as
    // a floor prop; the caller (nudgeSelected/onGizmoPointerMove) is what
    // actually clamps dx/dz to the room footprint before this ever persists.
    const h = ((asset.size && asset.size.h) || 1) * scale;
    const x = slot.x + (xform.dx || 0), z = slot.z + (xform.dz || 0);
    obj.position.set(x, room.size.h - h/2 - 0.05, z);
  } else if(slot.kind === 'wall'){
    const { axis, fixed } = wallSpan(room.size, slot.wall);
    const depth = (asset.type === 'extruded') ? (asset.size.d || 0.3) : 0.05;
    const clearance = WALL_THICK/2 + depth/2 + 0.02;
    const offset = slot.offset + (xform.dOffset || 0);
    let x, z;
    if(axis === 'x'){ x = offset; z = slot.wall === 'north' ? fixed + clearance : fixed - clearance; }
    else { z = offset; x = slot.wall === 'west' ? fixed + clearance : fixed - clearance; }
    // "ground" wall slots sit a floor-standing piece against the wall (bottom on
    // the floor); ordinary wall slots centre the piece at the slot's y plus any
    // nudge (ground slots ignore dY -- their height is always floor-derived).
    let y = slot.y + (xform.dY || 0);
    if(slot.ground){ const h = ((asset.size && asset.size.h) || 1) * scale; y = floorHeightAt(room, z) + h/2; }
    obj.position.set(x, y, z);
    if(asset.type !== 'billboard-cylindrical'){
      obj.rotation.y = WALL_INWARD_YAW[slot.wall] || 0;
    }
  } else {
    // extruded / plane / sprite are all centred on their geometry, so sitting
    // one on the floor means raising it by half its height
    const x = slot.x + (xform.dx || 0), z = slot.z + (xform.dz || 0);
    const floorY = floorHeightAt(room, z);
    // a move-object can be lifted off the floor (xform.dy); ordinary floor props
    // rest on the floor and simply carry dy === 0.
    const lift = xform.dy || 0;
    const flat = asset.type === 'extruded' && asset.orientation === 'flat';
    if(flat){
      // a flat floor covering rests on its thickness, not its (now-horizontal) height
      const d = ((asset.size && asset.size.d) || 0.3) * scale;
      obj.position.set(x, floorY + d/2 + lift, z);
    } else {
      const h = ((asset.size && asset.size.h) || 1) * scale;
      obj.position.set(x, floorY + h/2 + lift, z);
    }
    // Extruded props face a FIXED default -- the entrance wall (image side is
    // local -z), so they greet you on the way in without swinging to track
    // whichever door you used. An explicit authored slot.yaw still wins; the
    // editor's per-instance rotation is added on top as xform.dYaw. Billboards
    // always face the camera, so they're left alone. Flat floor coverings have
    // no "front", so their base is 0 (still rotatable via dYaw).
    if(asset.type === 'extruded'){
      const base = slot.yaw != null ? slot.yaw : (flat ? 0 : defaultFloorYaw(room));
      obj.rotation.y = base + (xform.dYaw || 0);
    }
  }
  obj.scale.setScalar(scale);
}

/* faint editor-only marker shown at an empty slot. Floor slots get a flat
   disc on the ground; wall slots get a small square flush to the wall. */
let slotMarkerMat = null;
function slotMarkerMaterial(){
  if(!slotMarkerMat){
    slotMarkerMat = tagShared(new THREE.MeshBasicMaterial({ color: 0x21d4d4, transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
  }
  return slotMarkerMat;
}
function buildSlotMarker(room, slot){
  let mesh;
  if(slot.kind === 'ceiling'){
    // tripled from a plain 0.5 -- on a low/small room the camera's default
    // pitch often doesn't bring a marker this size into view at all, so it's
    // easy to miss there's a ceiling slot (for a chandelier/skylight) to click.
    mesh = new THREE.Mesh(new THREE.CircleGeometry(1.5, 24), slotMarkerMaterial());
    mesh.rotation.x = Math.PI/2;                  // disc on the ceiling, facing down
    mesh.position.set(slot.x, room.size.h - 0.02, slot.z);
  } else if(slot.kind === 'wall'){
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), slotMarkerMaterial());
    const { axis, fixed } = wallSpan(room.size, slot.wall);
    const clearance = WALL_THICK/2 + 0.03;
    let x, z;
    if(axis === 'x'){ x = slot.offset; z = slot.wall === 'north' ? fixed + clearance : fixed - clearance; mesh.rotation.y = slot.wall === 'north' ? 0 : Math.PI; }
    else { z = slot.offset; x = slot.wall === 'west' ? fixed + clearance : fixed - clearance; mesh.rotation.y = slot.wall === 'west' ? Math.PI/2 : -Math.PI/2; }
    // ground markers sit at the base of the wall; eye-level ones at slot.y
    mesh.position.set(x, slot.ground ? floorHeightAt(room, z) + 0.4 : slot.y, z);
  } else {
    mesh = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), slotMarkerMaterial());
    mesh.rotation.x = -Math.PI/2;
    mesh.position.set(slot.x, floorHeightAt(room, slot.z) + 0.02, slot.z);
  }
  mesh.userData = { kind: 'slot', slotId: slot.id, allow: slot.allow || PROP_TYPES };
  return mesh;
}

/* editor-only hotspot covering a building's front (door) face. Tinted distinct
   from the cyan slot markers so it reads as a different kind of target; clicking
   it opens the facade picker. Carries the face's current dimensions so tests (and
   future HUD readouts) can see what size the face is. */
let facadeMarkerMat = null;
function facadeMarkerMaterial(){
  if(!facadeMarkerMat){
    facadeMarkerMat = tagShared(new THREE.MeshBasicMaterial({ color: 0xff9800, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
  }
  return facadeMarkerMat;
}
function buildFacadeMarker(size, b, roomKey, buildingKey, faceWidth, faceHeight){
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(faceWidth * 0.96, faceHeight * 0.96), facadeMarkerMaterial());
  mountOutward(size, b.doorWall, 0, b.origin, panel, faceHeight/2, WALL_THICK/2 + 0.10);
  panel.userData = { kind: 'facade', roomKey, buildingKey, w: faceWidth, h: faceHeight };
  return panel;
}

// editor-only hotspot covering a building's ground sign panel, tinted distinct
// from both the facade marker (orange) and yard-slot markers (cyan); clicking
// it opens the sign-skin picker. Sized/positioned to match the sign panel
// built by buildGroundSign (3.4 x 0.85, mounted at postH + 0.85/2).
let signMarkerMat = null;
function signMarkerMaterial(){
  if(!signMarkerMat){
    signMarkerMat = tagShared(new THREE.MeshBasicMaterial({ color: 0xab47bc, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
  }
  return signMarkerMat;
}
function buildSignMarker(signPos, roomKey, buildingKey, size){
  // A full-board skin covers its own footprint; the legacy panel-on-posts needs
  // a slightly oversized hotspot floating where the panel sits.
  const w = size ? size.w : 3.4 * 1.1;
  const h = size ? size.h : 0.85 * 1.4;
  const cy = size ? size.h / 2 : 1.1 + 0.85/2;
  const marker = new THREE.Mesh(new THREE.PlaneGeometry(w, h), signMarkerMaterial());
  marker.position.set(signPos.x, cy, signPos.z);
  marker.userData = { kind: 'sign', roomKey, buildingKey };
  return marker;
}

// The front-yard turf patch for one building: the rectangle of lawn between the
// door wall and the yard slots, wide enough to span the building's front face
// plus the flanking slots. With a surface asset assigned it's a tiled grass
// (or dead-grass, etc.) plane laid just above the base lawn; with none it's an
// editor-only faint marker so the ground is clickable to re-turf it. Either way
// it's tagged kind:'yard' so a click opens the surface picker in edit mode.
let yardMarkerMat = null;
function yardMarkerMaterial(){
  if(!yardMarkerMat){
    yardMarkerMat = tagShared(new THREE.MeshBasicMaterial({ color: 0x7ad17a, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
  }
  return yardMarkerMat;
}
const YARD_PLOT_GROW = 9;     // max lawn grown out past the footprint on a side with no road
const YARD_PLOT_GAP  = 0.4;   // stop the lawn this far short of a bounding road

// The building's lawn plot: its footprint grown outward on each side until it
// meets the nearest road that crosses that side (so the grass fills the whole
// fenced front/side lawn bounded by the streets), or YARD_PLOT_GROW when no
// road blocks. Returns world-space {minX,maxX,minZ,maxZ}.
function buildingPlotRect(room, b){
  const fX0 = b.origin.x - b.size.w/2, fX1 = b.origin.x + b.size.w/2;
  const fZ0 = b.origin.z - b.size.d/2, fZ1 = b.origin.z + b.size.d/2;
  const roads = (room && room.roads) || [];
  const overlap = (a0,a1,c0,c1) => a1 > c0 && c1 > a0;
  // each road's world extents
  const ext = r => ({ x0: r.x - r.sx/2, x1: r.x + r.sx/2, z0: r.z - r.sz/2, z1: r.z + r.sz/2 });
  let maxX = fX1 + YARD_PLOT_GROW, minX = fX0 - YARD_PLOT_GROW;
  let maxZ = fZ1 + YARD_PLOT_GROW, minZ = fZ0 - YARD_PLOT_GROW;
  for(const r of roads){
    const e = ext(r);
    if(overlap(fZ0, fZ1, e.z0, e.z1)){          // road spans the building's z-range -> bounds east/west
      if(e.x0 >= fX1) maxX = Math.min(maxX, e.x0 - YARD_PLOT_GAP);
      if(e.x1 <= fX0) minX = Math.max(minX, e.x1 + YARD_PLOT_GAP);
    }
    if(overlap(fX0, fX1, e.x0, e.x1)){          // road spans the building's x-range -> bounds north/south
      if(e.z0 >= fZ1) maxZ = Math.min(maxZ, e.z0 - YARD_PLOT_GAP);
      if(e.z1 <= fZ0) minZ = Math.max(minZ, e.z1 + YARD_PLOT_GAP);
    }
  }
  // never spill past the outdoor ground plane itself
  const RW = (room && room.size ? room.size.w : 1e4) / 2;
  const RD = (room && room.size ? room.size.d : 1e4) / 2;
  return {
    minX: Math.max(minX, -RW), maxX: Math.min(maxX, RW),
    minZ: Math.max(minZ, -RD), maxZ: Math.min(maxZ, RD)
  };
}
function buildYardPatch(b, roomKey, buildingKey){
  const asset = yardAssetFor(roomKey, buildingKey);
  if(!asset && !editMode) return null;     // nothing to draw -> base lawn shows through

  const plot = buildingPlotRect(ROOMS[roomKey], b);
  const extentX = Math.max(0.5, plot.maxX - plot.minX);
  const extentZ = Math.max(0.5, plot.maxZ - plot.minZ);

  let mat;
  if(asset){
    const rpm = asset.repeatPerMeter || 0.5;
    mat = assetSurfaceMaterial(asset, extentX * rpm, extentZ * rpm);
  } else {
    mat = yardMarkerMaterial();
  }
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(extentX, extentZ), mat);
  patch.rotation.x = -Math.PI/2;
  patch.position.set((plot.minX + plot.maxX)/2, 0.012, (plot.minZ + plot.maxZ)/2); // above base lawn (0), below slot markers (0.02)
  patch.userData = { kind: 'yard', roomKey, buildingKey };
  return patch;
}

// renders a list of slots: placed accessory if one is assigned, else a
// marker (only in edit mode, so normal walking is unchanged).
function buildSlots(room, roomKey, slots){
  for(const slot of slots){
    // the room's centre/anchor pair no longer renders in-room -- it now lives at
    // the door(s) leading INTO this room (buildDoorPair, drawn from the parent).
    // Left/right run pairs still line the walls. (Kept in roomSlots so slot ids
    // and object-list indexing are unchanged.)
    if((slot.kind === 'mnemonic' || slot.kind === 'moveObject') && slot.side === 'center' && !room.entryNoStreet) continue;
    if(slot.kind === 'mnemonic'){
      if(hintsOn) scene.add(placeMnemonicSlot(roomKey, slot));   // hidden during self-test
      continue;
    }
    if(slot.kind === 'moveObject'){
      // the object pegged to a move-pair. Resolution order:
      //  1. a manual per-slot asset override (LAYOUT.slots[slotId]) — wins so a
      //     single item can be overridden without touching the list;
      //  2. a manual placeholder label (LAYOUT.slotWords[slotId], set via the
      //     picker's text field) — a "not worth making an image for yet" stand-in;
      //  3. the wall list assigned to this slot's bucket (Phase 2): its item's
      //     image if bound, else the item's word as a text label;
      //  4. a ghostly numbered L#/R# placeholder when nothing else applies.
      // All stay visible with hints off — the object is the memory hook.
      const override = slotAssetFor(roomKey, slot.id);
      if(override){
        scene.add(placeSlotAccessory(room, slot, override, slotXformFor(roomKey, slot.id)));
        continue;
      }
      const manualWord = slotWordFor(roomKey, slot.id);
      if(manualWord){
        scene.add(buildMoveObjectWordLabel(slot, manualWord, slotXformFor(roomKey, slot.id)));
        continue;
      }
      const resolved = moveObjectListResolved(roomKey, slot);
      if(resolved){
        if(resolved.asset){
          scene.add(placeSlotAccessory(room, slot, resolved.asset, slotXformFor(roomKey, slot.id)));
          // caption the image with its word (hint-gated) so picture ↔ concept read together
          if(hintsOn) scene.add(buildMoveObjectSubtitle(slot, resolved.word, slotXformFor(roomKey, slot.id)));
        } else {
          scene.add(buildMoveObjectWordLabel(slot, resolved.word, slotXformFor(roomKey, slot.id)));
        }
        continue;
      }
      scene.add(buildMoveObjectPlaceholder(slot, slotXformFor(roomKey, slot.id)));
      continue;
    }
    const asset = slotAssetFor(roomKey, slot.id);
    if(asset){
      scene.add(placeSlotAccessory(room, slot, asset, slotXformFor(roomKey, slot.id)));
    } else if(editMode){
      scene.add(buildSlotMarker(room, slot));
    }
  }
}

// ghostly numbered placeholder sprite (L1/R2/...) for an unfilled move-object
// slot. Clickable in edit mode (kind 'slot'): opens the asset picker and fills
// the slot, replacing the placeholder with the chosen prop.
function buildMoveObjectPlaceholder(slot, xform){
  xform = xform || {};
  const px = 256;
  const canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, px, px);
  ctx.beginPath();
  ctx.arc(px / 2, px / 2, px / 2 - 14, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(120,140,170,0.32)';
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.setLineDash([18, 12]);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 104px sans-serif';
  ctx.fillText(slot.tag, px / 2, px / 2 + 6);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(0.9, 0.9, 1);
  sprite.position.set(slot.x + (xform.dx || 0), slot.y + (xform.dy || 0), slot.z + (xform.dz || 0));
  // route an edit-mode click through the existing slot picker (onCanvasClick
  // only fires in edit mode, so this is inert during a normal walk)
  sprite.userData = { kind: 'slot', slotId: slot.id, allow: PROP_TYPES };
  return sprite;
}

// Phase 2: a move-object slot driven by a wall list but whose list item has no
// image asset yet shows the item's WORD (e.g. "Oven") as a solid plaque — the
// stand-in object until an image is bound. Unlike the ghostly placeholder
// (nothing assigned at all) this IS a real, decorated stand-in, so it's
// selectable/movable exactly like an image accessory (kind 'accessory') --
// clicking selects it for nudging, and the gear icon (not a direct click)
// opens the asset picker to swap in an image or edit the word. Stays visible
// with hints off (the word is the memory hook, not the move).
function buildMoveObjectWordLabel(slot, word, xform){
  xform = xform || {};
  const scale = xform.scale || 1;
  const W = 512, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  // rounded plaque
  const pad = 16, r = 34;
  const x0 = pad, y0 = pad, x1 = W - pad, y1 = H - pad;
  ctx.beginPath();
  ctx.moveTo(x0 + r, y0);
  ctx.arcTo(x1, y0, x1, y1, r);
  ctx.arcTo(x1, y1, x0, y1, r);
  ctx.arcTo(x0, y1, x0, y0, r);
  ctx.arcTo(x0, y0, x1, y0, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(24,28,38,0.9)';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(127,176,255,0.95)';
  ctx.stroke();
  // word text, shrunk to fit
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let font = 96;
  const maxW = (x1 - x0) - 40;
  ctx.font = `bold ${font}px sans-serif`;
  while(font > 24 && ctx.measureText(word).width > maxW){ font -= 4; ctx.font = `bold ${font}px sans-serif`; }
  ctx.fillText(word, W / 2, H / 2 + 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  // 2:1 canvas -> keep aspect; ~1.1 m wide plaque hovering at the object spot
  sprite.scale.set(1.1 * scale, 0.55 * scale, 1);
  const p = moveObjectWordLabelPos(slot, xform);
  sprite.position.set(p.x, p.y, p.z);
  sprite.userData = { kind: 'accessory', slotId: slot.id };
  return sprite;
}
// Word-plaque position, shared by the builder and the live nudge path
// (setSlotXformLive) so the two never drift -- mirrors moveObjectSubtitlePos's
// own split for the same reason.
function moveObjectWordLabelPos(slot, xform){
  xform = xform || {};
  return { x: slot.x + (xform.dx || 0), y: slot.y + 0.15 + (xform.dy || 0), z: slot.z + (xform.dz || 0) };
}

// Phase 3: a small caption sprite with the list item's word, sat at the base of
// an image-backed move object so the picture and the concept it stands for read
// together. Shown only with hints on (a learning aid); with hints off you get
// the bare image and must recall the word/move yourself. Follows the object's
// nudge (xform dx/dz) so the caption stays under it. Not a click target — the
// object above it owns the edit-mode picker.
// depthTest is deliberately off: the caption sits at the SAME x/z as the
// object above it (moveObjectSubtitlePos), just lower, which usually falls
// well within that object's own opaque, alphaTest-cut image plane -- an
// opaque surface and a same-depth transparent sprite competing for the same
// pixels z-fights, occluding a different slice of the text as the viewing
// angle (and each pixel's exact depth comparison) shifts while walking past
// it. Skipping the depth test entirely makes the caption always draw on top
// of the image it names, which is the whole point of it being there.
function buildMoveObjectSubtitle(slot, word, xform){
  xform = xform || {};
  const W = 512, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let font = 74;
  ctx.font = `600 ${font}px sans-serif`;
  while(font > 20 && ctx.measureText(word).width > W - 40){ font -= 4; ctx.font = `600 ${font}px sans-serif`; }
  // soft dark outline for legibility over any backdrop, then white fill
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(10,12,18,0.85)';
  ctx.strokeText(word, W / 2, H / 2 + 2);
  ctx.fillStyle = '#f2f6ff';
  ctx.fillText(word, W / 2, H / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  sprite.scale.set(0.95, 0.24, 1);
  const p = moveObjectSubtitlePos(slot, xform);
  sprite.position.set(p.x, p.y, p.z);
  // no userData.kind -> findInteractive() skips it, so it never intercepts an
  // edit-mode click meant for the object above it (purely decorative caption).
  // subtitleFor lets setSlotXformLive re-place it live during a nudge (it isn't
  // the 'accessory' mesh, so findAccessoryObject wouldn't catch it).
  sprite.userData = { decorative: true, subtitleFor: slot.id };
  return sprite;
}
// Caption sits a fixed gap beneath the move-object's spot, following the
// object's horizontal nudge (dx/dz) and any lift (dy) so picture and word stay
// paired even when raised off the floor. Shared by the builder and the live
// nudge path so the two never drift.
function moveObjectSubtitlePos(slot, xform){
  xform = xform || {};
  return { x: slot.x + (xform.dx || 0), y: 0.28 + (xform.dy || 0), z: slot.z + (xform.dz || 0) };
}

function wallSpan(size, wall){
  // returns the wall's run axis ('x' or 'z'), fixed coordinate, and half-length
  const {w,d} = size;
  switch(wall){
    case 'north': return { axis:'x', fixed:-d/2, half:w/2 };
    case 'south': return { axis:'x', fixed: d/2, half:w/2 };
    case 'west':  return { axis:'z', fixed:-w/2, half:d/2 };
    case 'east':  return { axis:'z', fixed: w/2, half:d/2 };
  }
}

function buildWallGroup(size, wall, hasDoor, doorOffset, wallTexture, origin, opts){
  origin = origin || { x:0, z:0 };
  opts = opts || {};
  const group = new THREE.Group();
  const { axis, fixed, half } = wallSpan(size, wall);
  const h = size.h;

  // Each slab gets its own material sized to ITS OWN real-world width/height,
  // not the whole wall's -- otherwise a narrow piece (like the lintel above a
  // doorway) inherits a tile repeat meant for the full wall and ends up
  // looking densely shrunken next to the full-height side panels.
  function materialFor(segW, segH){
    if(opts.surfaceAsset){
      const rpm = opts.surfaceAsset.repeatPerMeter || 0.5;
      return assetSurfaceMaterial(opts.surfaceAsset, segW * rpm, segH * rpm);
    }
    const tex = wallTexture.clone();
    tex.needsUpdate = true;
    tex.repeat.set(Math.max(1, Math.round(segW/2.5)), Math.max(1, Math.round(segH/2)));
    return new THREE.MeshStandardMaterial({ map: tex });
  }

  function segment(start, end){
    const len = end - start;
    if(len <= 0.01) return;
    const mid = start + len/2;
    let geo, x, z;
    if(axis === 'x'){
      geo = new THREE.BoxGeometry(len, h, WALL_THICK);
      x = mid + origin.x; z = fixed + origin.z;
    } else {
      geo = new THREE.BoxGeometry(WALL_THICK, h, len);
      x = fixed + origin.x; z = mid + origin.z;
    }
    const mesh = new THREE.Mesh(geo, materialFor(len, h));
    mesh.position.set(x, h/2, z);
    if(opts.editable) mesh.userData = { kind: 'wall', wall };
    group.add(mesh);
  }

  // lintel above one doorway centered at `off`
  function lintelAt(off){
    const lintelH = h - DOOR_H;
    let geo, x, z;
    if(axis === 'x'){
      geo = new THREE.BoxGeometry(DOOR_W, lintelH, WALL_THICK);
      x = off + origin.x; z = fixed + origin.z;
    } else {
      geo = new THREE.BoxGeometry(WALL_THICK, lintelH, DOOR_W);
      x = fixed + origin.x; z = off + origin.z;
    }
    const lintel = new THREE.Mesh(geo, materialFor(DOOR_W, lintelH));
    lintel.position.set(x, DOOR_H + lintelH/2, z);
    if(opts.editable) lintel.userData = { kind: 'wall', wall };
    group.add(lintel);
  }

  // a wall can carry several doorways (multiple exits moved onto the same wall);
  // cut a gap + lintel for each, with wall segments filling the runs between.
  const offsets = (opts.doorOffsets && opts.doorOffsets.length)
    ? opts.doorOffsets.slice().sort((a, b) => a - b)
    : (hasDoor ? [doorOffset] : []);
  if(offsets.length === 0){
    segment(-half, half);
  } else {
    const dHalf = DOOR_W/2;
    let cursor = -half;
    for(const off of offsets){
      segment(cursor, off - dHalf);
      lintelAt(off);
      cursor = Math.max(cursor, off + dHalf);
    }
    segment(cursor, half);
  }
  return group;
}

function buildRoof(size, origin, color){
  // a flat cap flush with the walls -- no overhang. The old version oversized
  // the cap (w+0.6, d+0.6) to read as an eaved roof, but behind a movie-set
  // facade that lip just bled out past the facade's edges, so we keep it
  // flush to the box footprint.
  const mat = new THREE.MeshStandardMaterial({ color });
  const roof = new THREE.Mesh(new THREE.BoxGeometry(size.w, 0.3, size.d), mat);
  roof.position.set(origin.x, size.h + 0.15, origin.z);
  return roof;
}

/* ---------- in-room move mnemonics (hard-coded demo) ----------
   In the finished castle these billboards get placed automatically from the
   repertoire walk; for now we hand-place the first move pair of the line
   reached through the front door (the `start` room) so we can see how the
   loci memory cues read in-world.

   Both moves of the pair live on ONE composite billboard (a single square
   sprite, 1m x 1m by default) instead of two independently camera-facing
   sprites -- two separate billboards each turning to face the camera lost
   their spatial relationship to each other as you moved around (each one
   rotates to face you, so neither stays "above-left of" the other on
   screen the way two fixed objects would). A single shared billboard
   divided into quadrants keeps the opponent's move fixed in the upper-left
   and our response fixed in the lower-right, matching the on-paper
   memory-palace convention, with no relative drift.

   Display priority per move, matching the Mnemonics screen data
   (mnemonicsBySquare[destSquare][piece] / [piece+'Img']):
     1. graphic, if one was set  -> drawn into that move's quadrant
     2. else the mnemonic word, if set
     3. else the move's algebraic notation
   The pair is placed ~2/3 of the way into the room from the entry door (not
   dead center, so you aren't right on top of it as you walk in), about eye
   level. You enter `start` from the south (door at z=+5) facing north, so
   left is -x and deeper into the room is -z. */
const DEMO_MNEMONICS = {
  // multi-pair demo room: a hard-coded stand-in for two linear sequences sharing
  // one room -- 3 move-pairs along the LEFT (west) wall, 2 along the RIGHT
  // (east) wall, in walk order. Each pair will get a paired numbered object slot
  // (Phase 2). Real data will come from detected runs; see
  // LinearSequencesAndRoomObjects.md.
  start: {
    pairs: [
      { side: 'left',  order: 1, opponent: { to: 'd5', piece: 'pawn',   san: 'd5'  }, response: { to: 'f4', piece: 'bishop', san: 'Bf4' } },
      { side: 'left',  order: 2, opponent: { to: 'f6', piece: 'knight', san: 'Nf6' }, response: { to: 'e3', piece: 'pawn',   san: 'e3', disambig: 1 } },
      { side: 'left',  order: 3, opponent: { to: 'e6', piece: 'pawn',   san: 'e6'  }, response: { to: 'f3', piece: 'knight', san: 'Nf3' } },
      { side: 'right', order: 1, opponent: { to: 'c5', piece: 'pawn',   san: 'c5'  }, response: { to: 'c3', piece: 'pawn',   san: 'c3'  } },
      { side: 'right', order: 2, opponent: { to: 'c6', piece: 'knight', san: 'Nc6' }, response: { to: 'd3', piece: 'bishop', san: 'Bd3' } }
    ]
  },
  // the elevator car is its own tree node (placeholder demo pair, distinct from
  // start's so it's clearly the elevator's own -- real data will come from the
  // opening tree); its pair shows to the right of the floor-button door.
  roomB: {
    opponent: { to: 'e5', piece: 'pawn', san: 'e5' },
    response: { to: 'f3', piece: 'knight', san: 'Nf3' },
    pos: { x: -0.1, y: 1.6, z: -1.7 }
  },
  // the three rooms behind roomB's elevator floor buttons -- each one's
  // pair is the opponent reply that floor's button is labelled with, plus
  // the response that room is built around.
  roomB1: {
    opponent: { to: 'e6', piece: 'pawn', san: 'e6' },
    response: { to: 'c3', piece: 'knight', san: 'Nc3' },
    pos: { x: -0.1, y: 1.6, z: -1.7 }
  },
  roomB2: {
    opponent: { to: 'f6', piece: 'pawn', san: 'f6' },
    response: { to: 'c4', piece: 'pawn', san: 'c4' },
    pos: { x: -0.1, y: 1.6, z: -1.7 }
  },
  roomB3: {
    opponent: { to: 'f6', piece: 'knight', san: 'Nf6' },
    response: { to: 'e3', piece: 'pawn', san: 'e3' },
    pos: { x: -0.1, y: 1.6, z: -1.7 }
  },
  // demo move pair for the Study (roomC) so the door into it shows a move
  // decoration; real data will come from the opening tree.
  roomC: {
    opponent: { to: 'd5', piece: 'pawn', san: 'd5' },
    response: { to: 'e4', piece: 'pawn', san: 'e4' },
    pos: { x: -0.1, y: 1.6, z: -1.7 }
  }
};

// mnemonic billboards are positioned/sized like any other accessory: a
// synthetic floor-less "slot" (kind 'mnemonic') folded into roomSlots() so
// the existing select/nudge/scale/persist machinery (LAYOUT[roomKey].slotXform,
// keyed by slot id) just works for them with no changes elsewhere. One slot
// per room now (the composite pair billboard), not one per move -- the pair
// moves/scales as a single unit.
// a spot just in front of the floor-button wall, to the RIGHT of the door (the
// floor panel sits on the left), at eye height -- mirrors buildElevatorPanels.
// twoPanel (floors.length > ELEV_PANEL_MAX_ROWS): a SECOND panel now sits on
// the right too (see buildElevatorPanels), so there's no side left clear --
// mount on the lintel above the doorway instead, centered and clear of both.
function elevatorBillboardPos(room, wall, offset, twoPanel){
  const { axis, fixed } = wallSpan(room.size, wall);
  const dcx = axis === 'x' ? offset : fixed;          // door centre on the wall plane
  const dcz = axis === 'x' ? fixed : offset;
  // player's right (facing the wall) and the inward normal, per wall
  const V = {
    north: { rx: 1, rz: 0, ix: 0, iz: 1 }, south: { rx:-1, rz: 0, ix: 0, iz:-1 },
    west:  { rx: 0, rz:-1, ix: 1, iz: 0 }, east:  { rx: 0, rz: 1, ix:-1, iz: 0 }
  }[wall];
  if(twoPanel){
    const inset = 0.5;
    return { x: dcx + V.ix*inset, y: DOOR_H + 0.5, z: dcz + V.iz*inset };
  }
  const side = DOOR_W/2 + 0.2, inset = 0.6;
  return { x: dcx + V.rx*side + V.ix*inset, y: 1.5, z: dcz + V.rz*side + V.iz*inset };
}
// a spot just to one side of a doorway and a little into the room, for the
// door-side move-pair. sideSign -1 = the player's left as they face the door
// (where the pair goes), +1 = right. Mirrors elevatorBillboardPos' wall math.
function doorSideXZ(room, wall, offset, sideSign){
  const { axis, fixed } = wallSpan(room.size, wall);
  const dcx = axis === 'x' ? offset : fixed;
  const dcz = axis === 'x' ? fixed : offset;
  const V = {
    north: { rx: 1, rz: 0, ix: 0, iz: 1 }, south: { rx:-1, rz: 0, ix: 0, iz:-1 },
    west:  { rx: 0, rz:-1, ix: 1, iz: 0 }, east:  { rx: 0, rz: 1, ix:-1, iz: 0 }
  }[wall];
  const side = (DOOR_W/2 + 0.6) * sideSign, inset = 0.7;
  return { x: dcx + V.rx*side + V.ix*inset, z: dcz + V.rz*side + V.iz*inset };
}
// layout tuning for multi-pair rooms (Phase 1): billboards stride down the
// left/right walls at eye height, order 1 nearest the (south) entrance. The
// paired object sits on the floor (MNEM_OBJ_Y) directly below its billboard.
const MNEM_WALL_INSET = 1.5, MNEM_WALL_STRIDE = 3.0, MNEM_EYE_Y = 1.6, MNEM_OBJ_Y = 0.8;

// shared wall layout for a multi-pair room: one entry per move-pair with its
// wall position and L#/R# tag, in walk order. Both the billboard slots and the
// paired object slots are derived from this so they always line up.
function mnemPairLayout(roomKey){
  const entry = DEMO_MNEMONICS[roomKey];
  if(!entry || !entry.pairs) return [];
  const room = mergedRoom(roomKey);
  const out = [];
  // generated-castle rooms use the depth-aware scheme: viewpoint near the south
  // entrance, the center (anchor) pair just ahead of it (closest to you), and
  // each left/right pair marching farther north so center reads as nearer than
  // the first side item. The hard-coded demo room keeps its original centered
  // layout (it's only 10 m deep and would push billboards through the wall).
  const isCastle = roomKey.startsWith('cas:');
  const viewZ = room.size.d / 2 - CAS_LAYOUT.entrySetback;
  const centerZ = viewZ - CAS_LAYOUT.centerAhead;
  for(const side of ['left', 'right']){
    const wall = side === 'left' ? 'west' : 'east';
    const { fixed } = wallSpan(room.size, wall);   // x of the wall plane
    const x = wall === 'west' ? fixed + MNEM_WALL_INSET : fixed - MNEM_WALL_INSET;
    const sidePairs = entry.pairs.filter(p => (p.side || 'left') === side)
                                 .sort((a, b) => (a.order || 0) - (b.order || 0));
    const k = sidePairs.length;
    sidePairs.forEach((pair, i) => {
      const z = isCastle
        ? centerZ - CAS_LAYOUT.sideFirst - i * CAS_LAYOUT.sideStride   // first side pair ~2 m north of center, then march north
        : ((k - 1) / 2 - i) * MNEM_WALL_STRIDE;                        // demo: centered on the wall
      out.push({ tag: (side === 'left' ? 'L' : 'R') + (i + 1), side, order: i + 1, x, z, pair });
    });
  }
  const centerPairs = entry.pairs.filter(p => p.side === 'center')
                                 .sort((a, b) => (a.order || 0) - (b.order || 0));
  centerPairs.forEach((pair, i) => {
    out.push({ tag: 'C' + (i + 1), side: 'center', order: i + 1, x: 0, z: centerZ - i * CAS_LAYOUT.sideStride, pair });
  });
  return out;
}

// the numbered object slot paired with each move-pair (Phase 2): empty -> a
// ghostly L#/R# placeholder; filled -> the chosen prop (Phase 3).
function moveObjectSlots(roomKey){
  return mnemPairLayout(roomKey).map(L => ({
    id: `obj-${L.tag}`, kind: 'moveObject', x: L.x, y: MNEM_OBJ_Y, z: L.z,
    tag: L.tag, side: L.side, order: L.order
  }));
}

/* ---------- Phase 2: applying object lists to room walls ----------
   A room exposes one or two "wall buckets": a two-track (divided) room has a
   'left' and 'right' bucket; every other room has a single 'all' bucket. An
   object list assigned to a bucket fills that wall's move-object slots in order
   — item[0] on the first pair, item[1] on the second, and so on. If the item
   has an image asset it renders as a prop; otherwise its word shows as a text
   label until an asset is assigned. See Documents/ObjectListsAndRoomAssignment.md.
*/
function roomWallBuckets(roomKey){
  const room = mergedRoom(roomKey);
  return (room && room.twoTrack) ? ['left', 'right'] : ['all'];
}
function wallListId(roomKey, bucket){
  const wl = LAYOUT[roomKey] && LAYOUT[roomKey].wallLists;
  return (wl && wl[bucket] && wl[bucket].listId) || null;
}
// how many move-object slots a bucket holds — the "run length" a list is
// matched against in the assignment dialog. The center (anchor) slot is
// excluded from the 'all' bucket -- its pair is the move that walking in
// through the door already represents (the SAME pair the previous room's
// own door-object shows, via doorPairContent reusing this room's own
// center slot), not a step of walking THIS room's own sequence -- UNLESS
// room.entryNoStreet: the castle's own entry room, walked with no street
// building to show its entry pair on instead (a report-preview/standalone
// walk), has nowhere else that pair is shown at all, so it's decorated
// (and here, list-drivable) in-room, same exception computeFullyDecorated
// and buildSlots' render-skip already carve out for it.
function bucketSlotCount(roomKey, bucket){
  // an elevator car's own move-object slots are just its center anchor (it's
  // reached by one move, same as any room) -- its FLOORS are a separate
  // concept entirely (each one is a forward exit into a DIFFERENT room, not
  // a slot of this one), so they need their own count here rather than
  // falling through to the moveObjectSlots-based count below, which would
  // report 0 and make a list assigned here look entirely unused (see
  // elevatorFloorListItem/wallListPreviewHtml).
  if(isElevatorCar(roomKey)){
    return bucket === 'all' ? elevatorCarLayout(mergedRoom(roomKey)).floors.length : 0;
  }
  const room = mergedRoom(roomKey);
  const centerCounts = !!(room && room.entryNoStreet);
  const slots = moveObjectSlots(roomKey);
  if(bucket === 'left')  return slots.filter(s => s.side === 'left').length;
  if(bucket === 'right') return slots.filter(s => s.side === 'right').length;
  return slots.filter(s => s.side !== 'center' || centerCounts).length;   // 'all'
}
// which (bucket, index) a given move-object slot maps to, or null if the slot
// is not list-driven -- the center/anchor slot, in EVERY room kind, not just
// a two-track's shared head, EXCEPT room.entryNoStreet (see bucketSlotCount).
// Its pair is the move that walking in through the door already represents
// (the same pair the previous room's own door object shows, via
// doorPairContent reusing this room's own center slot), not a step of
// walking this room's own sequence -- assigning it list item[0] was pairing
// the SAME move twice while quietly shifting the room's own L1..Ln down by
// one and reporting one slot too many (bucketSlotCount).
const SIDE_WALK_RANK = { center: 0, left: 1, right: 2 };
function slotListContext(roomKey, slot){
  const room = mergedRoom(roomKey);
  const centerDrivable = !!(room && room.entryNoStreet);
  if(slot.side === 'center' && !centerDrivable) return null;   // arrival pair — not part of any wall list
  if(room && room.twoTrack){
    const bucket = slot.side === 'right' ? 'right' : 'left';
    return { bucket, index: (slot.order || 1) - 1 };
  }
  // single 'all' bucket: index = position in the room's own walk order
  // (left then right, each by order — center excluded unless entryNoStreet).
  // Computed from the actual slot set so a room with any mix of sides gets
  // a unique, collision-free index.
  const ordered = moveObjectSlots(roomKey).filter(s => s.side !== 'center' || centerDrivable).sort((a, b) =>
    ((SIDE_WALK_RANK[a.side] ?? 3) - (SIDE_WALK_RANK[b.side] ?? 3)) || ((a.order || 0) - (b.order || 0)));
  const index = ordered.findIndex(s => s.id === slot.id);
  return { bucket: 'all', index: index < 0 ? 0 : index };
}
// resolve a move-object slot to its list-driven content: { word, asset } where
// asset may be null (render the word), or null if no list drives this slot.
function moveObjectListResolved(roomKey, slot){
  const ctx = slotListContext(roomKey, slot);
  if(!ctx) return null;
  const id = wallListId(roomKey, ctx.bucket);
  if(!id) return null;
  const list = OBJECT_LISTS[id];
  if(!list || !Array.isArray(list.items) || ctx.index >= list.items.length) return null;
  const item = list.items[ctx.index];
  if(!item) return null;
  const asset = item.assetId ? (ASSET_BY_ID[item.assetId] || null) : null;
  return { word: item.name, asset };
}
// resolves floor index `i` (0-based, in the car's own exit order -- the SAME
// order elevatorCarLayout/buildElevatorPanels already walk) of an elevator
// car's single 'all' bucket to its list-driven content -- an elevator's
// floor-drivable equivalent of moveObjectListResolved. A floor's TARGET room
// center slot is never itself list-drivable (slotListContext excludes every
// center slot outside room.entryNoStreet, same as any ordinary door's
// target), so without this an elevator car's own assigned list had no route
// to actually reach the panel at all -- see doorPairContent's listFallback,
// the same mechanism an ordinary door's source lane already gets via
// continuationListItem.
function elevatorFloorListItem(carRoomKey, i){
  const id = wallListId(carRoomKey, 'all');
  if(!id) return null;
  const list = OBJECT_LISTS[id];
  if(!list || !Array.isArray(list.items) || i >= list.items.length) return null;
  const item = list.items[i];
  if(!item) return null;
  const asset = item.assetId ? (ASSET_BY_ID[item.assetId] || null) : null;
  return { word: item.name, asset };
}
// every (ownerRoomKey, slotId) pair a bucket's list actually drives, in list-
// index order -- shared by clearBucketSlotOverrides (wipe every override in
// the bucket) and bucketOverrideFlags (report which ones currently have one,
// for the wall-lists dialog preview). An ordinary room's bucket drives its
// own moveObjectSlots; an elevator car's single 'all' bucket instead drives
// each of its FLOOR TARGETS' own center slot -- a different room's LAYOUT
// entry per floor (see elevatorFloorListItem/doorPairContent's listFallback)
// that moveObjectSlots(roomKey) itself can never reach, since those slots
// don't belong to the car room at all.
function bucketSlotOwners(roomKey, bucket){
  if(isElevatorCar(roomKey)){
    if(bucket !== 'all') return [];
    return elevatorCarLayout(mergedRoom(roomKey)).floors.map(fe => {
      const headSlot = moveObjectSlots(fe.target).find(s => s.side === 'center');
      return { roomKey: fe.target, slotId: headSlot ? headSlot.id : 'obj-C1' };
    });
  }
  return moveObjectSlots(roomKey)
    .map(slot => ({ slot, ctx: slotListContext(roomKey, slot) }))
    .filter(x => x.ctx && x.ctx.bucket === bucket)
    .sort((a, b) => a.ctx.index - b.ctx.index)
    .map(x => ({ roomKey, slotId: x.slot.id }));
}
// clears every per-slot manual override (asset, word, nudge/scale) on a
// bucket's own driven slots (see bucketSlotOwners) -- called whenever that
// bucket's wall list is freshly assigned or swapped, so the pick actually
// takes effect immediately instead of being silently blocked by stale
// per-slot overrides left over from before the list existed (e.g. test props
// hand-placed on individual slots, or -- for an elevator -- floor objects
// hand-assigned before any list existed). moveObjectListResolved /
// elevatorFloorListItem are still checked LAST in the render order, so a
// slot you deliberately override AFTER this point continues to win over the
// list, same as always. Also exposed directly as the wall-lists dialog's own
// "Clear overrides" button, for wiping stale overrides WITHOUT needing to
// (re)assign a different list id first -- reported live: replacing an
// existing list's own ITEMS in place, rather than swapping to a different
// list, never changes the assigned id, so the automatic sweep above never
// ran and old per-slot overrides stayed stuck with no other way to bulk-clear
// them (Room Geometry's per-floor picker only clears one floor at a time).
function clearBucketSlotOverrides(roomKey, bucket){
  for(const {roomKey: ownerKey, slotId} of bucketSlotOwners(roomKey, bucket)){
    const r = ensureRoomLayout(ownerKey);
    delete r.slots[slotId];
    delete r.slotWords[slotId];
    delete r.slotXform[slotId];
  }
}
// which of a bucket's driven slots currently have a manual override
// shadowing the list -- powers the wall-lists dialog preview's "overridden"
// flag, so it's visible AT A GLANCE why a slot isn't showing its list item,
// instead of only discoverable by noticing the panel doesn't match.
function bucketOverrideFlags(roomKey, bucket){
  return bucketSlotOwners(roomKey, bucket).map(({roomKey: ownerKey, slotId}) =>
    !!(slotAssetFor(ownerKey, slotId) || slotWordFor(ownerKey, slotId)));
}

function mnemonicSlots(roomKey){
  const entry = DEMO_MNEMONICS[roomKey];
  if(!entry) return [];

  // multi-pair room: one billboard per move-pair, laid out in walk order along
  // the LEFT (west) and RIGHT (east) walls. Slot ids are L1/L2.../R1/R2... so
  // they read as the eventual numbered objects.
  if(entry.pairs){
    return mnemPairLayout(roomKey).map(L => ({
      id: `mnem-${L.tag}`, kind: 'mnemonic', x: L.x, y: MNEM_EYE_Y, z: L.z,
      pair: L.pair, side: L.side, order: L.order
    }));
  }

  // single-pair room (existing behavior)
  let pos = entry.pos;
  // an elevator car is a room with its own pair, but it's small and its floor
  // panel(s) sit beside the door -- mount its pair beside/above that door
  // instead of the usual centre-of-room spot (see elevatorBillboardPos).
  if(isElevatorCar(roomKey)){
    const room = mergedRoom(roomKey);
    const car = elevatorCarLayout(room);   // the single forward door all floors share
    if(car.floors.length){
      pos = elevatorBillboardPos(room, car.fwdWall, car.fwdOffset, car.floors.length > ELEV_PANEL_MAX_ROWS);
    }
  }
  return [{ id: 'mnem-0', kind: 'mnemonic', x: pos.x, y: pos.y, z: pos.z, pair: entry }];
}

function applySpriteContentScale(sprite){
  const userScale = sprite.userData.userScale || 1;
  const H = sprite.userData.baseH || 1;
  const aspect = sprite.userData.baseAspect || 1;
  sprite.scale.set(H * aspect * userScale, H * userScale, 1);
}

// Each move box is 1x1 unit (512px); the billboard surface is 1.5x1.5 units, so
// the opponent box pegged to the top-left and the response box pegged to the
// bottom-right overlap by half a unit in each axis -- tight but still diagonal.
const MNEM_QUADRANT = 512;
const MNEM_PAIR_SIZE = Math.round(MNEM_QUADRANT * 1.5);   // 768
const MNEM_PAIR_UNITS = 1.2;                              // world size of the billboard, in meters
                                                         // (overlap ratio is fixed by the canvas geometry
                                                         //  above, so this only changes the overall size)

// draws one move's content into a QUADRANT x QUADRANT box of the shared
// canvas, top-left corner at (qx, qy) -- image (clipped/letterboxed to fit)
// if one was set, else a boxed/bordered text label (mirrors the styling the
// old per-move text sprites used).
// one global "older-piece beard" image, loaded once per build from the meta
// store. undefined = not yet loaded, null = none set, Image = loaded.
let _beardImg = undefined;
function loadBeardImage(){
  if(_beardImg !== undefined) return Promise.resolve(_beardImg);
  return getMeta('moveDisambiguatorImg').then(src => {
    if(!src){ _beardImg = null; return null; }
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => { _beardImg = img; resolve(img); };
      img.onerror = () => { _beardImg = null; resolve(null); };
      img.src = src;
    });
  });
}

function drawMnemQuadrant(ctx, qx, qy, content, beardImg){
  const s = MNEM_QUADRANT;
  ctx.save();
  ctx.beginPath();
  ctx.rect(qx, qy, s, s);
  ctx.clip();
  if(content.image){
    const im = content.image;
    const scale = Math.min(s / im.width, s / im.height);
    const w = im.width * scale, h = im.height * scale;
    ctx.drawImage(im, qx + (s - w) / 2, qy + (s - h) / 2, w, h);
  } else {
    const pad = 22;
    ctx.fillStyle = 'rgba(18,20,26,0.82)';
    ctx.fillRect(qx + pad / 2, qy + pad / 2, s - pad, s - pad);
    ctx.strokeStyle = '#7fb0ff';
    ctx.lineWidth = 4;
    ctx.strokeRect(qx + pad / 2 + 2, qy + pad / 2 + 2, s - pad - 4, s - pad - 4);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = content.text;
    let font = 64;
    ctx.font = `bold ${font}px sans-serif`;
    const maxW = s - pad * 2;
    while(font > 20 && ctx.measureText(text).width > maxW){
      font -= 4;
      ctx.font = `bold ${font}px sans-serif`;
    }
    ctx.fillText(text, qx + s / 2, qy + s / 2 + 4);
  }
  // disambiguation beard(s) along the bottom of the move image: one per the
  // mover's age rank (older piece = more beards).
  const n = content.beards || 0;
  if(n > 0 && beardImg){
    const bh = s * 0.30;
    const bw = bh * (beardImg.width / beardImg.height || 1);
    const gap = bw * 0.15;
    const totalW = n * bw + (n - 1) * gap;
    let bx = qx + (s - totalW) / 2;
    const by = qy + s - bh - s * 0.04;
    for(let i = 0; i < n; i++){ ctx.drawImage(beardImg, bx, by, bw, bh); bx += bw + gap; }
  }
  ctx.restore();
}

// composites both moves of the pair onto one 1.5x1.5-unit canvas -- the
// opponent box (1x1) pegged to the top-left corner, the response box (1x1)
// pegged to the bottom-right corner -- so the two overlap by half a unit each
// way and sit close instead of a full quadrant apart. Drawn opponent-first so
// The mnemonics store (square -> per-piece words + image data-URLs) is large and
// getAllMnemonics() re-reads + deserializes all of it from IndexedDB on every
// call. Rendering a room fires one call PER billboard, which piled up into a
// ~1s stall where billboards showed their dark notation fallback before the real
// images swapped in. Cache it once per walk (cleared when the walk (re)opens or
// assets change) so every billboard shares a single read.
let _mnemCache = null, _mnemPromise = null;
function getMnemonicsCached(){
  if(_mnemCache) return Promise.resolve(_mnemCache);
  if(!_mnemPromise) _mnemPromise = Promise.resolve(getAllMnemonics()).then(m => { _mnemCache = m; return m; });
  return _mnemPromise;
}
function clearMnemonicsCache(){ _mnemCache = null; _mnemPromise = null; }
// Decode each move image once and reuse it (across billboards and rebuilds)
// rather than newing an Image per render.
const _moveImgCache = new Map();   // src -> Promise<Image|null>
function loadImageCached(src){
  if(_moveImgCache.has(src)) return _moveImgCache.get(src);
  const p = new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  _moveImgCache.set(src, p);
  return p;
}
// opponent-move quality glyph colours — mirror the move table / graph (css
// .mq-good/.mq-interesting/.mq-dubious/.mq-bad).
const MOVE_QUALITY_COLOR = {
  '!': '#2e7d32', '!!': '#2e7d32', '!?': '#1565c0',
  '?!': '#e07b00', '?': '#c62828', '??': '#c62828',
};
// a small pill badge showing an opponent move's quality glyph, pinned to the
// top-left corner of the pair billboard (the opponent quadrant).
function drawQualityBadge(ctx, q){
  const color = MOVE_QUALITY_COLOR[q];
  if(!color) return;
  ctx.font = 'bold 96px sans-serif';
  const pad = 20, x = 12, y = 12, h = 116;
  const w = ctx.measureText(q).width + pad * 2;
  ctx.beginPath();
  if(ctx.roundRect) ctx.roundRect(x, y, w, h, 18); else ctx.rect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill();
  ctx.lineWidth = 7; ctx.strokeStyle = color; ctx.stroke();
  ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(q, x + pad, y + h / 2 + 4);
}
// White's move number ("5."), vertically centered on the left edge of
// whichever quadrant (qx,qy) is White's half of the pair -- outlined text
// rather than the quality pill's filled badge, so it reads over both
// photo/PNG art and the dark text-fallback box without needing its own
// background plate. Centered (rather than pinned to the top-left corner)
// keeps it out of the diagonal overlap with the other quadrant's image --
// worst-case overlap is the top half of a quadrant's own box, so sitting at
// the vertical middle clears it -- and naturally staying clear of the
// opponent quadrant's quality pill (which lives up near the top) without
// needing a special-case offset for that.
// `boxSize` is the side length of the square box this badge is centered in
// (MNEM_QUADRANT for a pair quadrant, the opening-move tile's own px for
// that single-move tile) -- kept explicit rather than assumed so this is
// safely reusable outside the pair billboard even though both happen to be
// 512 today.
function drawMoveNumberBadge(ctx, qx, qy, boxSize, moveNumber){
  const text = `${moveNumber}.`;
  ctx.save();
  ctx.font = 'bold 116px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 15;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  // flush left, sitting a third of the box's height up from the bottom edge
  // (lower than dead-center, but clear of the bottom edge itself).
  const x = qx + 20, y = qy + boxSize - boxSize / 3;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x, y);
  ctx.restore();
}
// the response laps over it in the shared corner. `occurrence` ("N (M%)",
// only ever passed for a castle's street-level entry pair -- see
// buildStreetEntryPair) adds a small muted strip below the two quadrants, so
// castles can be compared at a glance for which to prioritize memorizing.
function renderMnemPairCanvas(sprite, oppContent, respContent, beardImg, oppQuality, occurrence){
  const stripH = occurrence ? 90 : 0;
  const canvas = document.createElement('canvas');
  canvas.width = MNEM_PAIR_SIZE;
  canvas.height = MNEM_PAIR_SIZE + stripH;
  const ctx = canvas.getContext('2d');
  const far = MNEM_PAIR_SIZE - MNEM_QUADRANT;     // bottom-right box origin (256)
  drawMnemQuadrant(ctx, 0, 0, oppContent, beardImg);        // opponent pegged top-left
  drawMnemQuadrant(ctx, far, far, respContent, beardImg);   // response pegged bottom-right
  if(oppQuality) drawQualityBadge(ctx, oppQuality);         // annotate the opponent move
  if(oppContent.moveNumber != null) drawMoveNumberBadge(ctx, 0, 0, MNEM_QUADRANT, oppContent.moveNumber);
  if(respContent.moveNumber != null) drawMoveNumberBadge(ctx, far, far, MNEM_QUADRANT, respContent.moveNumber);
  if(occurrence){
    ctx.fillStyle = 'rgba(15,15,20,0.75)';
    ctx.fillRect(0, MNEM_PAIR_SIZE, MNEM_PAIR_SIZE, stripH);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let font = 56; ctx.font = `bold ${font}px sans-serif`;
    while(font > 20 && ctx.measureText(occurrence).width > MNEM_PAIR_SIZE - 40){ font -= 4; ctx.font = `bold ${font}px sans-serif`; }
    ctx.fillText(occurrence, MNEM_PAIR_SIZE / 2, MNEM_PAIR_SIZE + stripH / 2 + 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  sprite.material.map = tex;
  // hard alpha-cutout (vs. blended) avoids dark edge-fringing on photo/PNG
  // art; only needed when a quadrant actually holds an image.
  sprite.material.alphaTest = (oppContent.image || respContent.image) ? 0.5 : 0;
  sprite.material.color.set(0xffffff);
  sprite.material.needsUpdate = true;
  // keep the same world WIDTH (and the same px-per-meter density as the
  // square case) when a strip is added -- only the height grows to fit it.
  sprite.userData.baseH = MNEM_PAIR_UNITS * (canvas.height / MNEM_PAIR_SIZE);
  sprite.userData.baseAspect = MNEM_PAIR_SIZE / canvas.height;
  applySpriteContentScale(sprite);
}

// resolves one move to its display content, preferring graphic -> word ->
// algebraic notation, same priority the Mnemonics screen itself uses. With
// wordOnly the text fallback is the bare word (or notation), without the
// "(san)" suffix -- used by the elevator's compact floor labels.
function resolveMoveContent(move, mnemonicsBySquare, wordOnly){
  const entry = mnemonicsBySquare && mnemonicsBySquare[move.to];
  const imgSrc = entry && entry[move.piece + 'Img'];
  const word = entry && entry[move.piece];
  const wordTrim = word && word.trim();
  const wordFallback = wordOnly
    ? (wordTrim || move.san)
    : (wordTrim ? `${wordTrim} (${move.san})` : move.san);
  const beards = move.disambig || 0;
  const moveNumber = move.moveNumber;
  if(!imgSrc) return Promise.resolve({ text: wordFallback, beards, moveNumber });
  return loadImageCached(imgSrc).then(img => img ? { image: img, beards, moveNumber } : { text: wordFallback, beards, moveNumber });
}

// builds the movable sprite for one mnemonic slot: position/scale come from
// the slot's base placement plus any saved nudge/scale xform (same pattern as
// placeSlotAccessory). Both moves of the pair are composited onto a single
// 1.5m x 1.5m billboard -- see DEMO_MNEMONICS comment above for why this
// replaced two independently camera-facing sprites.
// builds just the composite move-pair billboard sprite (opponent + response),
// with the immediate notation fallback plus the async graphic/word resolve.
// Position and interactive userData are the caller's job -- shared by the
// in-room mnemonic slots and the new door-side pairs.
function buildMnemPairSprite(pair, userScale, occurrence){
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff, transparent: true }));
  sprite.userData.userScale = userScale || 1;
  const oppQ = pair.opponent.quality;
  renderMnemPairCanvas(sprite,
    { text: pair.opponent.san, moveNumber: pair.opponent.moveNumber },
    { text: pair.response.san, moveNumber: pair.response.moveNumber },
    null, oppQ, occurrence);
  const myGen = buildGeneration;
  Promise.all([getMnemonicsCached(), loadBeardImage()]).then(([mnemonicsBySquare, beardImg]) => {
    if(buildGeneration !== myGen) return;
    Promise.all([
      resolveMoveContent(pair.opponent, mnemonicsBySquare),
      resolveMoveContent(pair.response, mnemonicsBySquare)
    ]).then(([oppContent, respContent]) => {
      if(buildGeneration !== myGen) return;
      renderMnemPairCanvas(sprite, oppContent, respContent, beardImg, oppQ, occurrence);
    });
  });
  return sprite;
}
function placeMnemonicSlot(roomKey, slot){
  const xform = slotXformFor(roomKey, slot.id) || {};
  const sprite = buildMnemPairSprite(slot.pair, xform.scale || 1);
  sprite.userData.kind = 'accessory';
  sprite.userData.slotId = slot.id;
  sprite.position.set(slot.x + (xform.dx || 0), slot.y + (xform.dy || 0), slot.z + (xform.dz || 0));
  return sprite;
}

function makeLabelMesh(text){
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 180px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 138);
  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
  return new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), mat);
}

function placeLabelOnWall(size, wall, text, origin, yOverride){
  origin = origin || { x:0, z:0 };
  const { fixed } = wallSpan(size, wall);
  const mesh = makeLabelMesh(text);
  const clearance = WALL_THICK/2 + 0.02;
  const y = yOverride != null ? yOverride : size.h/2;
  if(wall === 'north'){ mesh.position.set(origin.x, y, fixed + clearance + origin.z); mesh.rotation.y = 0; }
  if(wall === 'south'){ mesh.position.set(origin.x, y, fixed - clearance + origin.z); mesh.rotation.y = Math.PI; }
  if(wall === 'west'){  mesh.position.set(fixed + clearance + origin.x, y, origin.z); mesh.rotation.y = Math.PI/2; }
  if(wall === 'east'){  mesh.position.set(fixed - clearance + origin.x, y, origin.z); mesh.rotation.y = -Math.PI/2; }
  return mesh;
}

function makeExitSignMesh(){
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#7a1414';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 5;
  ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 56px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('EXIT', canvas.width/2, canvas.height/2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  return new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.375), mat);
}

// "EXIT" placard above a door whose exit leads back the way the player
// came in, rather than deeper into the layout -- mounted on the lintel,
// same inward-facing convention as placeLabelOnWall.
function buildExitSign(size, wall, offset){
  const mesh = makeExitSignMesh();
  const { fixed } = wallSpan(size, wall);
  const clearance = WALL_THICK/2 + 0.02;
  const y = DOOR_H + 0.3;
  if(wall === 'north'){ mesh.position.set(offset, y, fixed + clearance); mesh.rotation.y = 0; }
  if(wall === 'south'){ mesh.position.set(offset, y, fixed - clearance); mesh.rotation.y = Math.PI; }
  if(wall === 'west'){  mesh.position.set(fixed + clearance, y, offset); mesh.rotation.y = Math.PI/2; }
  if(wall === 'east'){  mesh.position.set(fixed - clearance, y, offset); mesh.rotation.y = -Math.PI/2; }
  return mesh;
}

// name placard for the room beyond a door (text only -- the move sits beside it
// as its own square decoration). `occurrence`, when given, is a small muted
// second line -- "N (M%)": how often this exact door has actually been taken
// in the user's own games, out of the room's total recorded continuations
// (0 = never played against them). Grows the plaque a bit taller to fit it;
// with no occurrence (or no name -- an as-yet-unnamed room can still show
// just the stat) it renders exactly as before.
function makeNameSignMesh(name, occurrence){
  const hasName = !!name, hasOcc = !!occurrence;
  const cw = 300, ch = (hasName && hasOcc) ? 140 : 110;
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(240,236,226,0.95)';
  ctx.fillRect(4, 4, cw - 8, ch - 8);
  ctx.strokeStyle = '#caa46a';
  ctx.lineWidth = 4;
  ctx.strokeRect(7, 7, cw - 14, ch - 14);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if(hasName){
    ctx.fillStyle = '#1a1a1a';
    let font = 56; ctx.font = `bold ${font}px serif`;
    while(font > 16 && ctx.measureText(name).width > cw - 36){ font -= 2; ctx.font = `bold ${font}px serif`; }
    ctx.fillText(name, cw/2, hasOcc ? ch * 0.36 : ch/2 + 2);
  }
  if(hasOcc){
    const weight = hasName ? '' : 'bold ';
    ctx.fillStyle = hasName ? '#5a5148' : '#1a1a1a';
    let font2 = hasName ? 30 : 44; ctx.font = `${weight}${font2}px serif`;
    while(font2 > 12 && ctx.measureText(occurrence).width > cw - 36){ font2 -= 2; ctx.font = `${weight}${font2}px serif`; }
    ctx.fillText(occurrence, cw/2, hasName ? ch * 0.76 : ch/2 + 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9 * ch / cw), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
}
// A taller two-line plaque for a door that crosses into another castle: the
// destination castle name (top, larger) over the room within it (below,
// smaller/muted). Same off-white + gold-frame styling as makeNameSignMesh; the
// 0.9-wide plane keeps buildDoorHint's uniform scaling working. `occurrence`
// (see makeNameSignMesh) is an optional third, even smaller/muted line.
function makeCastleDoorSignMesh(castleName, roomName, occurrence){
  const hasRoom = !!roomName, hasOcc = !!occurrence;
  const cw = 300, ch = (hasRoom && hasOcc) ? 190 : 150;
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(240,236,226,0.95)';
  ctx.fillRect(4, 4, cw - 8, ch - 8);
  ctx.strokeStyle = '#caa46a';
  ctx.lineWidth = 4;
  ctx.strokeRect(7, 7, cw - 14, ch - 14);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // castle name (top, larger, auto-shrunk to fit)
  ctx.fillStyle = '#1a1a1a';
  let f1 = 52; ctx.font = `bold ${f1}px serif`;
  while(f1 > 16 && ctx.measureText(castleName).width > cw - 30){ f1 -= 2; ctx.font = `bold ${f1}px serif`; }
  ctx.fillText(castleName, cw/2, (hasRoom || hasOcc) ? ch * (hasRoom && hasOcc ? 0.27 : 0.35) : ch / 2);
  // room within the castle (below, smaller, muted)
  if(hasRoom){
    ctx.fillStyle = '#5a5148';
    let f2 = 34; ctx.font = `${f2}px serif`;
    while(f2 > 12 && ctx.measureText(roomName).width > cw - 36){ f2 -= 2; ctx.font = `${f2}px serif`; }
    ctx.fillText(roomName, cw/2, hasOcc ? ch * 0.55 : ch * 0.72);
  }
  // occurrence stat (bottom, even smaller/muted -- or in the room-name slot
  // when this door has no room name yet)
  if(hasOcc){
    ctx.fillStyle = '#6b6258';
    let f3 = hasRoom ? 26 : 34; ctx.font = `${f3}px serif`;
    while(f3 > 12 && ctx.measureText(occurrence).width > cw - 36){ f3 -= 2; ctx.font = `${f3}px serif`; }
    ctx.fillText(occurrence, cw/2, hasRoom ? ch * 0.83 : ch * 0.72);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9 * ch / cw), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
}
// a small framed square showing one move's image (or its notation if no image
// has been set), used as a door-side decoration cueing the room beyond.
function makeMoveDecorationMesh(move, sizeM){
  const px = 256;
  const canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext('2d');
  const draw = (content) => {
    ctx.clearRect(0, 0, px, px);
    // image hints keep the dark frame; word/notation hints use an off-white
    // placard with black lettering to match the door name signs.
    ctx.fillStyle = (content && content.image) ? 'rgba(24,26,32,0.92)' : 'rgba(240,236,226,0.95)';
    ctx.fillRect(0, 0, px, px);
    ctx.strokeStyle = '#caa46a';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, px - 10, px - 10);
    if(content && content.image){
      const im = content.image, box = px - 36;
      const sc = Math.min(box / im.width, box / im.height);
      const w = im.width * sc, h = im.height * sc;
      ctx.drawImage(im, (px - w) / 2, (px - h) / 2, w, h);
    } else {
      ctx.fillStyle = '#1a1a1a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const t = (content && content.text) || move.san;
      let font = 90;
      ctx.font = `bold ${font}px sans-serif`;
      while(font > 20 && ctx.measureText(t).width > px - 40){ font -= 4; ctx.font = `bold ${font}px sans-serif`; }
      ctx.fillText(t, px/2, px/2 + 4);
    }
  };
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  draw({ text: move.san });
  const myGen = buildGeneration;
  getMnemonicsCached().then((mn) => {
    if(buildGeneration !== myGen || !scene) return;
    resolveMoveContent(move, mn).then((c) => {
      if(buildGeneration !== myGen || !scene) return;
      draw(c); tex.needsUpdate = true;
    });
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(sizeM, sizeM), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
}

// A room's OWN name, floating just above the floor a little way in from the
// entrance, so it reads naturally as you first walk in -- doors already show
// the name of the room BEYOND them (buildDoorHint), but nothing inside a
// room showed its own name until now. Semi-transparent dark backdrop so the
// text stays legible against any floor texture/color.
function makeRoomNameFloorTexture(name){
  const cw = 640, ch = 220;
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  const r = 28;
  ctx.fillStyle = 'rgba(15,15,20,0.6)';
  ctx.beginPath();
  ctx.moveTo(r, 4);
  ctx.lineTo(cw - r, 4);
  ctx.quadraticCurveTo(cw - 4, 4, cw - 4, r);
  ctx.lineTo(cw - 4, ch - r);
  ctx.quadraticCurveTo(cw - 4, ch - 4, cw - r, ch - 4);
  ctx.lineTo(r, ch - 4);
  ctx.quadraticCurveTo(4, ch - 4, 4, ch - r);
  ctx.lineTo(4, r);
  ctx.quadraticCurveTo(4, 4, r, 4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let font = 96;
  ctx.font = `bold ${font}px sans-serif`;
  while(font > 24 && ctx.measureText(name).width > cw - 56){ font -= 4; ctx.font = `bold ${font}px sans-serif`; }
  ctx.fillText(name, cw / 2, ch / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
// how far into the room (from the entrance wall) the floor label sits: 4m
// when the room is deep enough, otherwise clamped so it never crowds the far
// wall -- a small room (ROOM_GEOM_MIN is 2m) still gets a sensibly-placed
// label instead of one sitting on top of (or past) the opposite wall.
const ROOM_NAME_FLOOR_DIST = 4;
const ROOM_NAME_FLOOR_FAR_MARGIN = 0.6;
function roomNameFloorPos(size, wall){
  const along = (wall === 'north' || wall === 'south') ? size.d : size.w;
  const dist = Math.min(ROOM_NAME_FLOOR_DIST, Math.max(0.5, along - ROOM_NAME_FLOOR_FAR_MARGIN));
  if(wall === 'north') return { x: 0, z: -size.d / 2 + dist };
  if(wall === 'south') return { x: 0, z: size.d / 2 - dist };
  if(wall === 'west')  return { x: -size.w / 2 + dist, z: 0 };
  return { x: size.w / 2 - dist, z: 0 };   // east
}
// Builds the flat floor-plane mesh (unrotated -- floorLabels' per-frame tick
// keeps it lying flat and turning to face the camera, same "always readable"
// idea as the cylindrical billboards, just spinning in the ground plane
// instead of standing upright). Returns null if the room has no name.
function buildRoomNameFloorLabel(room, roomKey){
  const name = roomNameFor(roomKey);
  if(!name) return null;
  const tex = makeRoomNameFloorTexture(name);
  const w = 2.4, h = w * 220 / 640;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  const wall = entranceWall(room);
  const p = roomNameFloorPos(room.size, wall);
  const floorY = floorHeightAt(room, p.z);
  mesh.position.set(p.x, floorY + 0.015, p.z);
  mesh.userData = { kind: 'room-name-floor-label' };
  return mesh;
}

// Hint over a forward door: just the small name plaque for the room beyond,
// immediately above the lintel, centered on the doorway. (The opponent-move icon
// that used to sit above it is gone -- the move now lives in the door-side pair,
// buildDoorPair, so it'd be redundant.) Hidden by the hints toggle for self-test.
// `occurrence` ("N (M%)", see makeNameSignMesh) is shown as a small second line
// so an as-yet-unnamed room still gets a plaque when there's a stat to show --
// this is exactly the case ("should I bother memorizing this?") the stat is for.
function buildDoorHint(size, wall, offset, targetKey, roomKey, occurrence){
  const group = new THREE.Group();
  const name = roomNameFor(targetKey);
  // a door crossing into another castle shows that castle's name (over the room
  // within it); an ordinary in-castle door just shows the room name. The target
  // is a boundary into another castle when its OWN castle-root name differs from
  // the castle we're currently walking in (its owner). (targetKey may be that
  // other castle's own room key -- a genuinely different instance prefix, see
  // buildCastleGraph's foreign-exit redirect -- so this always checks the
  // castle NAME, never assumes anything about the key shape.)
  const destCastle = (ROOMS[targetKey] && ROOMS[targetKey].castle) || '';
  const ownerCastle = (ROOMS[roomKey] && ROOMS[roomKey].ownerCastle) || '';
  const crossCastle = !!destCastle && destCastle !== ownerCastle;
  if(!name && !crossCastle && !occurrence) return group;
  const { fixed } = wallSpan(size, wall);
  const clearance = WALL_THICK/2 + 0.03;
  const NAME_W = 1.8;                     // plaque width, <= door width (2.2)
  const m = crossCastle ? makeCastleDoorSignMesh(destCastle, name, occurrence) : makeNameSignMesh(name, occurrence);
  const NAME_H = NAME_W * m.geometry.parameters.height / 0.9;   // keep the plane's aspect
  const GAP = 0.12;                       // gap between the door top and the plaque
  const nameY = DOOR_H + GAP + NAME_H / 2;
  const s = NAME_W / 0.9;                 // scale the 0.9-wide plane to NAME_W wide
  m.scale.set(s, s, 1);
  if(wall === 'north'){ m.position.set(offset, nameY, fixed + clearance); m.rotation.y = 0; }
  if(wall === 'south'){ m.position.set(offset, nameY, fixed - clearance); m.rotation.y = Math.PI; }
  if(wall === 'west'){  m.position.set(fixed + clearance, nameY, offset); m.rotation.y = Math.PI/2; }
  if(wall === 'east'){  m.position.set(fixed - clearance, nameY, offset); m.rotation.y = -Math.PI/2; }
  group.add(m);
  return group;
}
// when a lane ends in exactly one forward door (no branch), the destination
// room's own head object can continue the SAME wall list this lane's own
// interior members already draw from, picking up right where the lane left
// off -- so filling one list just naturally carries across the doorway
// instead of stopping dead at the last in-room slot, with no separate
// assignment needed. Purely a read-time fallback (nothing persisted): it
// stays live as the list or the lane's own length changes, and a deliberate
// manual override on the destination's own head slot (or the destination's
// own wall list, on an entryNoStreet room) still wins over it, same as any
// other override. `ex` is the room's own exit record for this door (see
// buildCastleGraph's fromSide/fromOrder tagging in app.js) -- null for the
// street-entry pair, which has no lane to continue.
function continuationListItem(roomKey, room, ex){
  if(!ex || (ex.fromSide !== 'left' && ex.fromSide !== 'right') || !ex.fromOrder) return null;
  const bucket = room.twoTrack ? ex.fromSide : 'all';
  // more than one forward door sharing this same lane (a branch at the tail,
  // or a memorized-room-stability side-door) -- no single "next" item to
  // continue with, so leave it to the placeholder/manual-override path.
  const siblingCount = (room.exits || []).filter(e => !e.back && e.fromSide === ex.fromSide).length;
  if(siblingCount !== 1) return null;
  const id = wallListId(roomKey, bucket);
  if(!id) return null;
  const list = OBJECT_LISTS[id];
  if(!list || !Array.isArray(list.items)) return null;
  const item = list.items[ex.fromOrder];   // 0-based: one past this lane's own last member
  if(!item) return null;
  const asset = item.assetId ? (ASSET_BY_ID[item.assetId] || null) : null;
  return { word: item.name, asset };
}
// resolves the move-pair billboard + head-object content for the room BEYOND a
// door/entrance. exPair (edge-specific) wins for the billboard; else the target's
// canonical head pair. The object is the target's head object (obj-C1): a manual
// override, else the target room's assigned list item, else (listFallback) the
// SOURCE lane's own list continuing onto this door (see continuationListItem).
function doorPairContent(target, exPair, listFallback){
  const pair = exPair
    || (DEMO_MNEMONICS[target] && DEMO_MNEMONICS[target].pairs
        && DEMO_MNEMONICS[target].pairs.find(p => p.side === 'center'))
    || null;
  const headSlot = moveObjectSlots(target).find(s => s.side === 'center');
  const slotId = headSlot ? headSlot.id : 'obj-C1';
  let asset = slotAssetFor(target, slotId), word = null;
  if(!asset) word = slotWordFor(target, slotId);
  if(!asset && !word && headSlot){
    const r = moveObjectListResolved(target, headSlot);
    if(r){ asset = r.asset; word = r.word; }
  }
  if(!asset && !word && listFallback){ asset = listFallback.asset; word = listFallback.word; }
  return { pair, asset, word, slotId };
}
// builds the move-pair billboard (eye height) + head object for a room beyond a
// door, at base world (x,z) within `room` (rendered under `roomKey`). The
// billboard is hint-gated; a filled object stays for self-test. The object is
// editable in place: its per-door position/rotation/scale live in THIS room's
// slotXform under `dobj-<target>`, while its (shared) image edits on the target
// room. Base pos + resolved asset ride on userData so the editor can re-place it
// without a roomSlots entry. `occurrence` (only ever passed by
// buildStreetEntryPair -- "which castles should I prioritize memorizing?" is a
// street-level, not per-door, question) is a small line drawn under the pair.
function buildPairAt(roomKey, room, x, z, target, exPair, occurrence, listFallback){
  const group = new THREE.Group();
  const { pair, asset, word, slotId } = doorPairContent(target, exPair, listFallback);
  if(hintsOn && pair){
    // the pair billboard is selectable + movable like the old in-room one: its
    // per-door position/height/scale live in this room's slotXform under
    // `dbb-<target>`, base pos on userData (no roomSlots entry).
    const bbId = 'dbb-' + target;
    const xf = slotXformFor(roomKey, bbId) || {};
    const bb = buildMnemPairSprite(pair, xf.scale || 1, occurrence);
    bb.userData.kind = 'accessory';
    bb.userData.slotId = bbId;
    bb.userData.doorBill = true;
    bb.userData.roomKey = roomKey;
    bb.userData.base = { x, y: MNEM_EYE_Y, z };
    bb.position.set(x + (xf.dx || 0), MNEM_EYE_Y + (xf.dy || 0), z + (xf.dz || 0));
    group.add(bb);
  }
  const doorId = 'dobj-' + target;                        // per-door transform key in this room
  // empty slot: a clickable stand-in that assigns the shared image (on the target)
  const emptyUd = { kind: 'door-obj', ownerRoomKey: target, slotId, allow: PROP_TYPES };
  if(asset){
    const xform = slotXformFor(roomKey, doorId) || {};
    const obj = buildPropAsset(asset);
    applyAccessoryTransform(obj, room, { kind: 'moveObject', x, z }, asset, xform);
    obj.userData = { kind: 'accessory', slotId: doorId, doorObj: true, roomKey,
                     base: { x, z }, asset, assetRoomKey: target, assetSlotId: slotId };
    if(asset.type === 'billboard-cylindrical') billboards.push(obj);   // faces the camera each frame
    group.add(obj);
  } else if(word && hintsOn){
    const label = buildMoveObjectWordLabel({ x, y: MNEM_OBJ_Y, z, id: slotId }, word, slotXformFor(roomKey, doorId));
    label.userData = emptyUd;
    group.add(label);
  } else if(editMode){                                   // empty slot: a clickable stand-in to fill
    const ph = buildMoveObjectPlaceholder({ x, y: MNEM_OBJ_Y, z, tag: '?', id: slotId }, slotXformFor(roomKey, doorId));
    ph.userData = emptyUd;
    group.add(ph);
  }
  return group;
}
// Phase 1: the pair/object for the room BEYOND a forward interior door. It sits
// on the side of the door the player reaches FIRST walking in from the (south)
// entrance, so the images read before the door. On the two SIDE walls that means
// the entrance (south) side: west already lands there with -1, east needs +1
// (which also keeps the top east door's pair off the north wall). The north
// (opposite) wall keeps its left placement.
function buildDoorPair(roomKey, room, wall, offset, ex){
  const sideSign = wall === 'east' ? 1 : -1;
  const { x, z } = doorSideXZ(room, wall, offset, sideSign);
  return buildPairAt(roomKey, room, x, z, ex.target, ex.pair, undefined, continuationListItem(roomKey, room, ex));
}
// Phase 2: the entry (mansion-root) room's pair/object out on the street, beside
// the building's front door -- that room's centre pair now lives here rather than
// inside the foyer. Placed to one side of the door and a bit out onto the street.
function buildStreetEntryPair(roomKey, room, b, size){
  const { axis, fixed } = wallSpan(size, b.doorWall);    // `size` = the door-bearing box
  const along = b.doorOffset - (DOOR_W/2 + 0.9);         // just to one side of the door
  const out = WALL_OUT_NORMAL[b.doorWall];
  const clear = 1.8;                                     // out onto the street, past the facade
  let x, z;
  if(axis === 'x'){ x = b.origin.x + along;               z = b.origin.z + fixed + out.z * clear; }
  else            { z = b.origin.z + along;               x = b.origin.x + fixed + out.x * clear; }
  return buildPairAt(roomKey, room, x, z, b.target, null, b.entryOccurrence);
}

// Phase 4: a wall-mounted parchment plaque showing an applied list's mnemonic
// phrase (large) with its ordering rule beneath (small italic) — the seventh
// retrieval cue (see Documents/MnemonicListDesignPrinciples.html) made visible
// in the room. Hint-gated by the caller.
function drawWrappedCentered(ctx, text, cx, top, maxW, lineH){
  const words = String(text).split(/\s+/);
  let line = '', y = top;
  for(const w of words){
    const test = line ? line + ' ' + w : w;
    if(ctx.measureText(test).width > maxW && line){ ctx.fillText(line, cx, y); y += lineH; line = w; }
    else line = test;
  }
  if(line){ ctx.fillText(line, cx, y); y += lineH; }
  return y;
}
function makeMnemonicPlaqueMesh(list){
  const cw = 560, ch = 320;
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  // parchment board + frame (matches the door name signs)
  ctx.fillStyle = 'rgba(240,236,226,0.96)';
  ctx.fillRect(6, 6, cw - 12, ch - 12);
  ctx.strokeStyle = '#caa46a';
  ctx.lineWidth = 6;
  ctx.strokeRect(12, 12, cw - 24, ch - 24);
  const cx = cw / 2, maxW = cw - 72;
  // list name (small header)
  ctx.fillStyle = '#6a5a3a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 26px serif';
  let y = 34;
  y = drawWrappedCentered(ctx, list.name || '', cx, y, maxW, 30) + 8;
  // the mnemonic phrase (main text)
  ctx.fillStyle = '#1a1a1a';
  const phrase = (list.mnemonic && list.mnemonic.phrase) || '';
  let font = 46;
  ctx.font = `bold ${font}px serif`;
  // shrink so the phrase fits in at most ~3 lines
  while(font > 24){
    ctx.font = `bold ${font}px serif`;
    // rough line-count estimate
    const words = phrase.split(/\s+/); let line = '', lines = 1;
    for(const w of words){ const t = line ? line+' '+w : w; if(ctx.measureText(t).width > maxW && line){ lines++; line = w; } else line = t; }
    if(lines <= 3) break;
    font -= 3;
  }
  y = drawWrappedCentered(ctx, phrase, cx, y, maxW, font + 8) + 10;
  // ordering rule (small italic footer)
  if(list.orderingRule){
    ctx.fillStyle = '#5a5348';
    ctx.font = 'italic 22px serif';
    drawWrappedCentered(ctx, list.orderingRule, cx, Math.min(y, ch - 74), maxW, 26);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const wM = 1.7, hM = wM * ch / cw;
  return new THREE.Mesh(new THREE.PlaneGeometry(wM, hM), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
}
// mount a mnemonic plaque on each assigned wall bucket, near the (south)
// entrance end so it greets you as you enter and reads while you face the wall's
// objects. left/all -> west wall, right -> east wall.
function buildWallListPlaques(room, roomKey){
  for(const bucket of roomWallBuckets(roomKey)){
    const id = wallListId(roomKey, bucket);
    if(!id) continue;
    const list = OBJECT_LISTS[id];
    // a plaque is worth mounting whenever it has EITHER the phrase or the
    // ordering rule to show -- makeMnemonicPlaqueMesh already draws each
    // independently (an empty phrase just draws nothing there, the
    // ordering rule is its own `if(list.orderingRule)` footer), but this
    // gate used to require a phrase even when only an ordering rule was
    // set, silently dropping the plaque instead of showing just the rule.
    if(!list || !((list.mnemonic && list.mnemonic.phrase) || list.orderingRule)) continue;
    const wall = bucket === 'right' ? 'east' : 'west';
    const { fixed, half } = wallSpan(room.size, wall);
    const clearance = WALL_THICK / 2 + 0.03;
    const along = half - 1.3;                 // near the south (entrance) end
    const y = 2.15;
    const mesh = makeMnemonicPlaqueMesh(list);
    if(wall === 'west'){ mesh.position.set(fixed + clearance, y, along); mesh.rotation.y = Math.PI / 2; }
    else               { mesh.position.set(fixed - clearance, y, along); mesh.rotation.y = -Math.PI / 2; }
    mesh.userData = { kind: 'wall-list-plaque', decorative: true };
    scene.add(mesh);
  }
}

// "1st", "2nd", "3rd", "4th"... for floor button labels.
function ordinal(n){
  const v = n % 100;
  if(v >= 11 && v <= 13) return n + 'th';
  switch(n % 10){
    case 1: return n + 'st';
    case 2: return n + 'nd';
    case 3: return n + 'rd';
    default: return n + 'th';
  }
}

// panel canvas geometry (px). One row per floor, laid out left-to-right as
// [numbered button] [room name] [move pair: opponent raised / response lowered]
// [head object]. ELEV_ROW_PX maps to ELEV_ROW_M metres, fixing the whole
// panel's real size (see buildElevatorPanels) at ~0.375 m/row -- every pixel
// size below (button/images/text) is a fraction of this same row, so bumping
// just ELEV_ROW_M scales the whole row, images included, uniformly bigger
// without touching layout proportions.
const ELEV_ROW_PX = 140, ELEV_PAD_PX = 12;
// the pair column is narrow because the two move images OVERLAP (like the
// in-room pair billboard), which also makes the panel read like a normal room.
const ELEV_COL = { btn: 132, name: 300, pair: 150, obj: 176 };   // per-column widths (px)
const ELEV_CANVAS_W = ELEV_PAD_PX * 2 + ELEV_COL.btn + ELEV_COL.name + ELEV_COL.pair + ELEV_COL.obj;
const ELEV_ROW_M = 0.46875;   // 0.375 * 1.25 -- requested 25% bigger (both dimensions: this scales panelW/panelH together, see buildOneElevatorPanel)
// past ELEV_PANEL_MAX_ROWS floors, a second panel mounts to the right of the
// door carrying the rest (see buildElevatorPanels) -- real elevators don't
// split buttons like this, but it's the simplest practical fix for the rare
// wide branch. Hard-capped at ELEV_MAX_FLOORS (two full panels) for now; see
// elevatorRejectReason.
const ELEV_PANEL_MAX_ROWS = 7;
const ELEV_MAX_FLOORS = ELEV_PANEL_MAX_ROWS * 2;
// An elevator car has ONE physical door (its floor panel), not one per reply,
// so the door-count-driven width/depth a branch room was sized for is
// irrelevant -- renderRoomGeomDialog floors a car's resize minimum at this
// instead (keeping height, which the tall floor panel still needs).
const ELEV_MIN_WD = 6;
// draw an image "contain"-fitted into the box (bx,by,bw,bh), centred.
function drawContain(ctx, im, bx, by, bw, bh){
  const s = Math.min(bw / im.width, bh / im.height);
  const w = im.width * s, h = im.height * s;
  ctx.drawImage(im, bx + (bw - w) / 2, by + (bh - h) / 2, w, h);
}
// wrapped/truncated single-line text that fits maxW, appending an ellipsis.
function fitText(ctx, text, maxW){
  if(ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while(t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
// Draws the floor directory onto a canvas. contents[i] holds the resolved
// row content: { oppImg?, oppText?, respImg?, respText?, objImg?, objText? }
// (images are decoded HTMLImageElements; text is the algebraic/word fallback).
// selectedOrdinal (if set) highlights that floor's row -- the click-to-select
// UX: clicking a row picks it (see selectElevatorFloor), and walking through
// the forward door then teleports there (see tick()).
function makeElevatorPanelTexture(floors, contents, selectedOrdinal){
  const rowH = ELEV_ROW_PX;
  const canvas = document.createElement('canvas');
  canvas.width = ELEV_CANVAS_W;
  canvas.height = Math.max(rowH, rowH * floors.length + ELEV_PAD_PX * 2);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 3;
  ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
  ctx.textBaseline = 'middle';
  floors.forEach((f, i) => {
    const rowTop = ELEV_PAD_PX + rowH * i;
    const cy = rowTop + rowH / 2;
    const c = (contents && contents[i]) || {};
    const selected = f.ordinal === selectedOrdinal;
    let x = ELEV_PAD_PX + 8;

    if(selected){
      ctx.fillStyle = 'rgba(70,200,110,0.28)';
      ctx.fillRect(ELEV_PAD_PX, rowTop, canvas.width - ELEV_PAD_PX * 2, rowH);
    }

    // numbered button (lit green once selected, like a real elevator button)
    const btnR = rowH * 0.30;
    const btnCx = x + ELEV_COL.btn / 2, btnCy = cy;
    ctx.beginPath(); ctx.arc(btnCx, btnCy, btnR, 0, Math.PI * 2);
    ctx.fillStyle = selected ? '#2a9d4f' : '#333'; ctx.fill();
    ctx.strokeStyle = '#ddd'; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(btnR * 1.1)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(String(f.ordinal), btnCx, btnCy + 1);
    x += ELEV_COL.btn;

    // room name (or a faint "(unnamed)" so the row still reads), followed by
    // its occurrence stat -- "(M%)", how often this exact floor has actually
    // been taken in the user's own games -- in a smaller, muted style right
    // after the name, same info an ordinary door's own hint shows
    // (buildDoorHint) but an elevator floor never otherwise gets.
    ctx.textAlign = 'left';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillStyle = f.name ? '#fff' : '#888';
    const nameText = fitText(ctx, f.name || '(unnamed)', ELEV_COL.name - 12);
    ctx.fillText(nameText, x + 6, cy);
    if(f.occurrence){
      const nameW = ctx.measureText(nameText).width;
      const pct = f.occurrence.slice(f.occurrence.indexOf('('));   // "N (M%)" -> "(M%)"
      ctx.font = '20px sans-serif';
      ctx.fillStyle = '#999';
      ctx.fillText(pct, x + 6 + nameW + 8, cy);
    }
    x += ELEV_COL.name;

    // move pair: opponent raised (upper-left), response lowered (lower-right),
    // OVERLAPPING like the room's own pair billboard -- saves horizontal space
    // and reads the same as a normal room's move images. Response drawn on top.
    const cell = rowH - 20;
    const pairImgSz = cell * 0.74;
    const step = pairImgSz * 0.5;                 // 50% diagonal overlap
    const oppX = x + 6, oppY = rowTop + (rowH - (pairImgSz + step)) / 2;
    const respX = oppX + step, respY = oppY + step;
    const drawMove = (img, text, bx, by) => {
      if(img) drawContain(ctx, img, bx, by, pairImgSz, pairImgSz);
      else { ctx.fillStyle = '#ddd'; ctx.font = '22px sans-serif'; ctx.textAlign = 'left';
             ctx.fillText(fitText(ctx, text || '', pairImgSz + 14), bx, by + pairImgSz / 2); }
    };
    drawMove(c.oppImg, c.oppText, oppX, oppY);      // opponent behind
    drawMove(c.respImg, c.respText, respX, respY);  // response in front, lower-right
    x += ELEV_COL.pair;

    // head object
    if(c.objImg) drawContain(ctx, c.objImg, x + 6, rowTop + 12, ELEV_COL.obj - 12, cell);
    else if(c.objText){ ctx.fillStyle = '#bbb'; ctx.font = 'italic 24px sans-serif'; ctx.textAlign = 'left';
                        ctx.fillText(fitText(ctx, c.objText, ELEV_COL.obj - 12), x + 6, cy); }

    // row divider
    if(i < floors.length - 1){
      ctx.strokeStyle = '#444'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ELEV_PAD_PX, rowTop + rowH); ctx.lineTo(canvas.width - ELEV_PAD_PX, rowTop + rowH); ctx.stroke();
    }
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// the currently-selected floor's ordinal for this car, or null -- validated
// against its CURRENT floors each time (editing can change what's on the
// panel, stranding a stale ordinal from before).
function selectedElevatorOrdinal(roomKey, floors){
  const ord = elevatorSelectedFloor[roomKey];
  return (ord != null && floors.some(f => f.ordinal === ord)) ? ord : null;
}

// elevator car only: the floor-button panel(s) beside the forward door. Up
// to ELEV_PANEL_MAX_ROWS floors fit one panel, mounted to the left of the
// door as before; beyond that a SECOND panel mounts to the right, carrying
// the rest (hard-capped at ELEV_MAX_FLOORS total -- see
// elevatorRejectReason). Each panel is independently laid out/shrunk to fit
// its own side's available wall flank, so splitting doesn't change a
// single-panel car's appearance at all.
function buildElevatorPanels(size, wall, doorOffset, floors, roomKey){
  if(floors.length <= ELEV_PANEL_MAX_ROWS){
    return [buildOneElevatorPanel(size, wall, doorOffset, floors, roomKey, -1)];
  }
  return [
    buildOneElevatorPanel(size, wall, doorOffset, floors.slice(0, ELEV_PANEL_MAX_ROWS), roomKey, -1),
    buildOneElevatorPanel(size, wall, doorOffset, floors.slice(ELEV_PANEL_MAX_ROWS), roomKey, 1),
  ];
}
// a canvas-textured panel listing one side's floor buttons (mirrors
// buildExitSign's lintel-mount convention, but at chest height and offset
// along the wall rather than centred over the doorway). side -1 mounts left
// of the door (the original single-panel position), +1 mounts right
// (mirrored) -- fwdOffset is always 0 (elevatorCarLayout), so both sides
// have identical available space. Built first with the plain
// algebraic-notation fallback (instant), then re-textured in place once
// each floor's mnemonic image resolves -- same async-then-upgrade pattern
// placeMnemonicSlot uses for the room billboards. Tagged 'elevator-panel' so
// a walk-mode click (see handleWalkClick) can hit-test it and pick a row.
function buildOneElevatorPanel(size, wall, doorOffset, floors, roomKey, side){
  const { fixed, half } = wallSpan(size, wall);
  const margin = 0.1;
  const avail = half - DOOR_W/2 - margin * 2;
  // Real size follows the canvas aspect at ELEV_ROW_M (~0.375 m) per row, so the
  // move/object images stay undistorted. If that's wider than the door's flank
  // (a small hand-authored car), scale the whole panel down uniformly to fit.
  const canvasH = ELEV_PAD_PX * 2 + ELEV_ROW_PX * floors.length;
  const mpp = ELEV_ROW_M / ELEV_ROW_PX;
  let panelW = ELEV_CANVAS_W * mpp, panelH = canvasH * mpp;
  if(panelW > avail && avail > 0.2){ const k = avail / panelW; panelW *= k; panelH *= k; }
  const selectedOrdinal = selectedElevatorOrdinal(roomKey, floors);
  const mat = new THREE.MeshBasicMaterial({ map: makeElevatorPanelTexture(floors, elevatorRowFallback(floors), selectedOrdinal) });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(panelW, panelH), mat);
  mesh.userData = { kind: 'elevator-panel', roomKey, floors };
  const clearance = WALL_THICK/2 + 0.02;
  const along = doorOffset + side * (DOOR_W/2 + margin + panelW/2);
  const y = 1.75;   // raised 0.25m from the original 1.5 -- the panel grew 25% taller (ELEV_ROW_M) and its bottom edge started touching the floor
  if(wall === 'north'){ mesh.position.set(along, y, fixed + clearance); mesh.rotation.y = 0; }
  if(wall === 'south'){ mesh.position.set(along, y, fixed - clearance); mesh.rotation.y = Math.PI; }
  if(wall === 'west'){  mesh.position.set(fixed + clearance, y, along); mesh.rotation.y = Math.PI/2; }
  if(wall === 'east'){  mesh.position.set(fixed - clearance, y, along); mesh.rotation.y = -Math.PI/2; }

  const myGen = buildGeneration;
  getMnemonicsCached().then((mnemonicsBySquare) => {
    if(buildGeneration !== myGen) return;
    Promise.all(floors.map(f => resolveElevatorRow(f, mnemonicsBySquare)))
      .then((contents) => {
        if(buildGeneration !== myGen) return;
        mat.map.dispose();
        mat.map = makeElevatorPanelTexture(floors, contents, selectedElevatorOrdinal(roomKey, floors));
        mat.needsUpdate = true;
      });
  });
  return mesh;
}
// the instant text-only row content (drawn before images resolve).
function elevatorRowFallback(floors){
  return floors.map(f => ({
    oppText: f.pair ? f.pair.opponent.san : f.label,
    respText: f.pair ? f.pair.response.san : '',
    objText: f.objWord || '',
  }));
}
// resolves one floor row to its drawable content: opponent + response move
// images (falling back to notation), and the head-object image (falling back
// to its placeholder word). Mirrors doorPairContent -> resolveMoveContent for
// the moves, plus a decoded object image.
function resolveElevatorRow(f, mnemonicsBySquare){
  const moveOf = m => m ? resolveMoveContent(m, mnemonicsBySquare, true) : Promise.resolve({ text: '' });
  const objOf = f.objAsset && f.objAsset.image
    ? loadImageCached(f.objAsset.image).then(img => img ? { image: img } : { text: f.objWord || '' })
    : Promise.resolve({ text: f.objWord || '' });
  return Promise.all([
    moveOf(f.pair && f.pair.opponent),
    moveOf(f.pair && f.pair.response),
    objOf,
  ]).then(([opp, resp, obj]) => ({
    oppImg: opp.image, oppText: opp.text,
    respImg: resp.image, respText: resp.text,
    objImg: obj.image, objText: obj.text,
  }));
}

// A cosmetic textured panel filling a doorway opening (DOOR_W x DOOR_H, plus
// the oversize margin -- see DOOR_SKIN_BASE_OVERSIZE), double-sided since the
// same opening is approached from both rooms it connects. Only built when a
// door asset is assigned -- otherwise the doorway stays the open gap it
// always was.
function makeDoorPanelMesh(asset){
  const oversize = DOOR_SKIN_BASE_OVERSIZE + (Number(asset.oversizePct) || 0) / 100;
  // transparent:true is required for the PNG's own alpha channel to actually
  // be honored -- without it three.js ignores alpha and paints whatever RGB
  // is stored in "transparent" pixels (often black), so a non-rectangular
  // door skin's margin renders as solid black instead of see-through. Since
  // oversize scales the WHOLE plane up, that black margin grows right along
  // with it -- the bigger the oversize, the more black shows.
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W * (1 + oversize), DOOR_H * (1 + oversize)), mat);
  const myGeneration = buildGeneration;
  textureLoader.load(asset.image, (tex) => {
    if(buildGeneration !== myGeneration) return;
    tex.colorSpace = THREE.SRGBColorSpace;
    mat.map = tex;
    mat.needsUpdate = true;
  });
  return mesh;
}
// A door skin sitting exactly flush with the wall's own face plane
// z-fights with the wall material at every point the oversize margin
// overlaps solid wall (see DOOR_SKIN_BASE_OVERSIZE) -- the two coplanar
// surfaces flicker/clip against each other there instead of the door
// skin cleanly covering it, which reads as the door being "sunk into"
// the wall. Standing it 1cm proud of the wall face (toward the room,
// same direction/sign convention buildDoorMarker's clearance already
// uses) puts the whole panel unambiguously in front, so every detail
// -- including the oversized edges -- renders cleanly. `fixed` (wallSpan)
// is the wall's CENTERLINE, not its visible face -- the face is
// WALL_THICK/2 further out, same as buildDoorMarker's own clearance --
// so the offset must clear the half-thickness too, or the panel ends up
// buried ~(WALL_THICK/2 - offset) inside the wall instead of in front of it.
const DOOR_SKIN_FORWARD_OFFSET = 0.01;
function buildDoorPanel(size, wall, offset, asset){
  const mesh = makeDoorPanelMesh(asset);
  mesh.userData = { kind: 'door-panel', wall };
  const { fixed } = wallSpan(size, wall);
  const y = DOOR_H/2;
  const f = WALL_THICK/2 + DOOR_SKIN_FORWARD_OFFSET;
  if(wall === 'north'){ mesh.position.set(offset, y, fixed + f); mesh.rotation.y = 0; }
  if(wall === 'south'){ mesh.position.set(offset, y, fixed - f); mesh.rotation.y = Math.PI; }
  if(wall === 'west'){  mesh.position.set(fixed + f, y, offset); mesh.rotation.y = Math.PI/2; }
  if(wall === 'east'){  mesh.position.set(fixed - f, y, offset); mesh.rotation.y = -Math.PI/2; }
  return mesh;
}
// a simple vector-drawn padlock (shackle arc + body + keyhole) rather than a
// font glyph -- guaranteed to render identically everywhere, no dependence on
// an emoji/webfont being available (Font Awesome is CDN-blocked in the
// offline test harness, same class of gap as cm-chessboard). Drawn once and
// cached; every locked-door instance reuses the same texture/material.
function makeLockIconTexture(){
  const px = 256;
  const canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#f2c14e';
  ctx.lineWidth = px * 0.11;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(px / 2, px * 0.42, px * 0.2, Math.PI, 0, false);
  ctx.stroke();
  const bodyW = px * 0.62, bodyH = px * 0.42, bodyX = (px - bodyW) / 2, bodyY = px * 0.4, r = px * 0.06;
  ctx.fillStyle = '#f2c14e';
  ctx.beginPath();
  ctx.moveTo(bodyX + r, bodyY);
  ctx.lineTo(bodyX + bodyW - r, bodyY);
  ctx.quadraticCurveTo(bodyX + bodyW, bodyY, bodyX + bodyW, bodyY + r);
  ctx.lineTo(bodyX + bodyW, bodyY + bodyH - r);
  ctx.quadraticCurveTo(bodyX + bodyW, bodyY + bodyH, bodyX + bodyW - r, bodyY + bodyH);
  ctx.lineTo(bodyX + r, bodyY + bodyH);
  ctx.quadraticCurveTo(bodyX, bodyY + bodyH, bodyX, bodyY + bodyH - r);
  ctx.lineTo(bodyX, bodyY + r);
  ctx.quadraticCurveTo(bodyX, bodyY, bodyX + r, bodyY);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#2b2410';
  ctx.beginPath();
  ctx.arc(px / 2, bodyY + bodyH * 0.4, px * 0.045, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(px / 2 - px * 0.018, bodyY + bodyH * 0.4, px * 0.036, bodyH * 0.34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
let lockIconMat = null;
function lockIconMaterial(){
  if(!lockIconMat){
    lockIconMat = tagShared(new THREE.MeshBasicMaterial({ map: makeLockIconTexture(), transparent: true, side: THREE.DoubleSide }));
  }
  return lockIconMat;
}
// floats a padlock in an unskinned locked door's open gap -- only built when
// there's no assigned skin (see the wallExits loop): once a skin (e.g. a
// vault image) covers the gap, the icon isn't needed to signal "locked".
// Same wall-face-proud positioning convention as buildDoorPanel, sized well
// inside the DOOR_W x DOOR_H opening so it doesn't crowd the door frame.
function buildLockedDoorIcon(size, wall, offset){
  const iconSize = 0.9;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(iconSize, iconSize), lockIconMaterial());
  mesh.userData = { kind: 'locked-door-icon', wall };
  const { fixed } = wallSpan(size, wall);
  const y = DOOR_H / 2;
  const f = WALL_THICK/2 + DOOR_SKIN_FORWARD_OFFSET;
  if(wall === 'north'){ mesh.position.set(offset, y, fixed + f); mesh.rotation.y = 0; }
  if(wall === 'south'){ mesh.position.set(offset, y, fixed - f); mesh.rotation.y = Math.PI; }
  if(wall === 'west'){  mesh.position.set(fixed + f, y, offset); mesh.rotation.y = Math.PI/2; }
  if(wall === 'east'){  mesh.position.set(fixed - f, y, offset); mesh.rotation.y = -Math.PI/2; }
  return mesh;
}
let doorMarkerMat = null;
function doorMarkerMaterial(){
  if(!doorMarkerMat){
    doorMarkerMat = tagShared(new THREE.MeshBasicMaterial({ color: 0xffeb3b, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }));
  }
  return doorMarkerMat;
}
// Editor-only hotspot at the center of a passageway's opening -- a vertical
// overlay slightly proud of the wall plane (same convention as the facade
// marker), so it stays visible and clickable even once a door skin is
// assigned, instead of being hidden behind the panel.
function buildDoorMarker(size, wall, offset, roomKey, dKey){
  const { fixed } = wallSpan(size, wall);
  const marker = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W * 0.9, DOOR_H * 0.9), doorMarkerMaterial());
  const y = DOOR_H/2;
  const clearance = WALL_THICK/2 + 0.08;
  if(wall === 'north'){ marker.position.set(offset, y, fixed + clearance); marker.rotation.y = 0; }
  if(wall === 'south'){ marker.position.set(offset, y, fixed - clearance); marker.rotation.y = Math.PI; }
  if(wall === 'west'){  marker.position.set(fixed + clearance, y, offset); marker.rotation.y = Math.PI/2; }
  if(wall === 'east'){  marker.position.set(fixed - clearance, y, offset); marker.rotation.y = -Math.PI/2; }
  marker.userData = { kind: 'door', roomKey, doorKey: dKey };
  return marker;
}
// standard red circle-slash "no entry" glyph -- the built-in look for a
// room's dead-end sign (see buildRoom's dead-end hook) before it's been
// given a custom skin. Vector-drawn, same reasoning as makeLockIconTexture:
// guaranteed to render identically everywhere, no external image/font.
let noContinuationTex = null;
function makeNoContinuationTexture(){
  if(noContinuationTex) return noContinuationTex;
  const px = 256;
  const canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext('2d');
  const cx = px / 2, cy = px / 2, r = px * 0.42, ringW = px * 0.16;
  ctx.strokeStyle = '#e21b1b';
  ctx.lineWidth = ringW;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 4);
  ctx.fillStyle = '#e21b1b';
  ctx.fillRect(-r, -ringW / 2, r * 2, ringW);
  ctx.restore();
  noContinuationTex = new THREE.CanvasTexture(canvas);
  noContinuationTex.colorSpace = THREE.SRGBColorSpace;
  return noContinuationTex;
}
let noContinuationMat = null;
function noContinuationMaterial(){
  if(!noContinuationMat){
    noContinuationMat = tagShared(new THREE.MeshBasicMaterial({ map: makeNoContinuationTexture(), transparent: true, side: THREE.DoubleSide }));
  }
  return noContinuationMat;
}
// the visible sign itself, mounted flush on the SOLID wall (there's no
// doorway cut here -- the room has no forward exit to make one for).
function buildNoContinuationIcon(size, wall, offset){
  const iconSize = 1.4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(iconSize, iconSize), noContinuationMaterial());
  mesh.userData = { kind: 'no-continuation-icon', wall };
  const { fixed } = wallSpan(size, wall);
  const y = DOOR_H / 2;
  const f = WALL_THICK/2 + DOOR_SKIN_FORWARD_OFFSET;
  if(wall === 'north'){ mesh.position.set(offset, y, fixed + f); mesh.rotation.y = 0; }
  if(wall === 'south'){ mesh.position.set(offset, y, fixed - f); mesh.rotation.y = Math.PI; }
  if(wall === 'west'){  mesh.position.set(fixed + f, y, offset); mesh.rotation.y = Math.PI/2; }
  if(wall === 'east'){  mesh.position.set(fixed - f, y, offset); mesh.rotation.y = -Math.PI/2; }
  return mesh;
}
// editor-only click target for the dead-end sign, same hotspot convention as
// buildDoorMarker (a real door's own click target). track ('left'/'right'),
// when given, tags which two-track lane this sign belongs to so a click
// routes to that lane's own override (see deadEndAssetFor/setDeadEndOverride).
function buildDeadEndMarker(size, wall, offset, roomKey, track){
  const { fixed } = wallSpan(size, wall);
  const marker = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W * 0.9, DOOR_H * 0.9), doorMarkerMaterial());
  const y = DOOR_H / 2;
  const clearance = WALL_THICK/2 + 0.08;
  if(wall === 'north'){ marker.position.set(offset, y, fixed + clearance); marker.rotation.y = 0; }
  if(wall === 'south'){ marker.position.set(offset, y, fixed - clearance); marker.rotation.y = Math.PI; }
  if(wall === 'west'){  marker.position.set(fixed + clearance, y, offset); marker.rotation.y = Math.PI/2; }
  if(wall === 'east'){  marker.position.set(fixed - clearance, y, offset); marker.rotation.y = -Math.PI/2; }
  marker.userData = { kind: 'dead-end', roomKey, track: track || null };
  return marker;
}
function drawSignBase(ctx, w, h){
  ctx.fillStyle = '#caa46a';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#4a3320';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, w - 10, h - 10);
}
function drawSignText(ctx, w, h, text, textY, fontPx){
  textY = (textY != null) ? textY : h/2 + 4;
  fontPx = fontPx || 54;
  ctx.fillStyle = '#2b1d10';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // shrink long names so they never overrun the board's printable width
  let size = fontPx;
  ctx.font = `bold ${size}px serif`;
  while(size > 12 && ctx.measureText(text).width > w * 0.9){ size -= 2; ctx.font = `bold ${size}px serif`; }
  ctx.fillText(text, w/2, textY);
}
// Builds the sign panel mesh. Draws the flat tan background + text
// immediately (so the panel is never blank), then if a skin image is
// supplied, loads it asynchronously and redraws the skin as the
// background with the name text layered on top once it's ready.
// `board` (optional {w,h} in meters) switches from the small panel-on-posts
// look to a full freestanding sign: the canvas aspect matches the board so the
// skin isn't distorted, and the name is drawn across the upper third to clear
// the legs that the skin art paints in. Without `board` it's the legacy
// 3.4m × 0.85m panel with the name centered. Built as a thin slab (not a flat
// plane) so the board reads as a real object from the side, not a paper cutout.
const SIGN_DEPTH = 0.1;
function makeSignMesh(text, skinSrc, board){
  const px = 150;
  const meshW = board ? board.w : 3.4;
  const meshH = board ? board.h : 0.85;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(64, Math.round(meshW * px));
  canvas.height = Math.max(32, Math.round(meshH * px));
  const cw = canvas.width, ch = canvas.height;
  const textY = board ? Math.round(ch * 0.17) : ch/2 + 4;
  const fontPx = board ? Math.round(ch * 0.13) : 54;
  const ctx = canvas.getContext('2d');
  drawSignBase(ctx, cw, ch);
  drawSignText(ctx, cw, ch, text, textY, fontPx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // alphaTest-only cutout (no `transparent` blending) -- same fix as the
  // billboard assets use: a plain MeshBasicMaterial ignores the canvas's
  // alpha channel entirely and shows the transparent pixels' baked RGB
  // (often black), which is the reported bug. Hard-discarding below the
  // threshold also avoids the dark anti-aliased-edge halo blending would give.
  const faceMat = new THREE.MeshBasicMaterial({ map: tex, transparent: false, alphaTest: 0.5 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x4a3320 });
  if(skinSrc){
    const myGeneration = buildGeneration;
    const img = new Image();
    img.onload = () => {
      if(buildGeneration !== myGeneration || !scene) return;
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      drawSignText(ctx, cw, ch, text, textY, fontPx);
      tex.needsUpdate = true;
    };
    img.src = skinSrc;
  }
  // BoxGeometry material order: +x, -x, +y, -y, +z, -z. The artwork sits on
  // the +z face (the side facing the street). For a SKINNED sign the image's
  // silhouette rarely fills the whole board, so the dark edge faces would poke
  // out past the art's transparent margin as a detached bar -- give every face
  // the same alpha-tested skin so the cutout applies all around and no edge
  // floats (opaque parts of the board still show a thin textured thickness).
  // The legacy un-skinned tan panel fills its board, so it keeps solid edges.
  return new THREE.Mesh(
    new THREE.BoxGeometry(meshW, meshH, SIGN_DEPTH),
    skinSrc ? faceMat : [edgeMat, edgeMat, edgeMat, edgeMat, faceMat, edgeMat]
  );
}

// A skinned sign as a real silhouette extrusion (the same path the grandfather
// clock and the mansion facade use), so the board's depth follows the skin's
// outline instead of a flat rectangular slab. The name text is composited onto
// the skin first, then the whole thing is traced/extruded by buildExtrudedAsset.
// Returns a group that fills in once the skin decodes (guarded by buildGeneration).
function makeExtrudedSignMesh(text, skinSrc, board, sideColor){
  const group = new THREE.Group();
  const myGen = buildGeneration;
  const img = new Image();
  img.onload = () => {
    if(buildGeneration !== myGen || !scene) return;
    // composite the skin + name onto a board-aspect canvas; the text lands
    // inside the opaque artwork, so it rides along without changing the
    // silhouette that gets traced.
    const px = 150;
    const cw = Math.max(64, Math.round(board.w * px));
    const ch = Math.max(32, Math.round(board.h * px));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, cw, ch);
    drawSignText(ctx, cw, ch, text, Math.round(ch * 0.17), Math.round(ch * 0.13));
    const ex = buildExtrudedAsset({ image: canvas.toDataURL(), size: { w: board.w, h: board.h, d: SIGN_DEPTH }, sideColor });
    // No Y-flip needed: the +z cap faces the street, and buildExtrudedAsset now
    // flips the back cap's UVs so the sign reads correctly from both sides.
    ex.position.y = board.h / 2;    // stand the board on the ground
    group.add(ex);
  };
  img.src = skinSrc;
  return group;
}

// Mounts a mesh flush against a wall facing *outward* (away from the
// room/building it belongs to) -- the mirror image of placeLabelOnWall,
// which faces inward. Used for exterior signage on building facades.
function mountOutward(size, wall, offset, origin, mesh, y, clearance){
  origin = origin || { x:0, z:0 };
  const { axis, fixed } = wallSpan(size, wall);
  clearance = (clearance == null ? WALL_THICK/2 + 0.06 : clearance);
  let x, z;
  if(axis === 'x'){ x = offset; z = (wall === 'north') ? fixed - clearance : fixed + clearance; }
  else { z = offset; x = (wall === 'west') ? fixed - clearance : fixed + clearance; }
  mesh.position.set(x + origin.x, y, z + origin.z);
  if(wall === 'north') mesh.rotation.y = Math.PI;
  if(wall === 'south') mesh.rotation.y = 0;
  if(wall === 'west') mesh.rotation.y = -Math.PI/2;
  if(wall === 'east') mesh.rotation.y = Math.PI/2;
  return mesh;
}

// Positions an extruded facade slab (built by buildExtrudedAsset, front = local
// -z, centred on its own geometry) on a building's door wall: front cap sits
// `frontClear` proud of the wall facing the street, and the slab runs backward
// over the (smaller) brick box. Rotation turns local -z to point outward.
function mountFacadeExtrusion(group, size, wall, origin, depth, height, frontClear){
  origin = origin || { x:0, z:0 };
  const { axis, fixed } = wallSpan(size, wall);
  const outSign = (wall === 'south' || wall === 'east') ? 1 : -1;
  const along = fixed + outSign * (frontClear - depth / 2);   // slab centre, depth/2 behind the front cap
  if(axis === 'x'){ group.position.set(origin.x, height / 2, origin.z + along); }
  else { group.position.set(origin.x + along, height / 2, origin.z); }
  group.rotation.y = FRONT_OUTWARD_YAW[wall];
  return group;
}

// Material for a staircase's steps/risers: the room's assigned stair surface
// asset if one was picked, else a warm wood plank default (gray steps read as
// unfinished concrete). `spanW` is the run width, used to tile the texture so
// the planks aren't stretched. Tagged-as-clickable by the caller.
function stairMaterial(roomKey, spanW){
  const asset = stairAssetFor(roomKey);
  if(asset){
    const rpm = asset.repeatPerMeter || 0.5;
    return assetSurfaceMaterial(asset, Math.max(1, spanW * rpm), 1);
  }
  const tex = makeFloorTexture();          // already a wood-plank canvas texture
  tex.repeat.set(Math.max(1, Math.round(spanW / 1.2)), 1);
  return new THREE.MeshStandardMaterial({ map: tex });
}

// Builds a raised platform (reached by a staircase) within a room's
// existing walls/ceiling -- the platform spans from `toZ` back to the
// room's far wall, and the steps climb the gap between `fromZ` and `toZ`.
function buildStairs(room, roomKey){
  const { fromZ, toZ, rise } = room.stairs;
  const { w, d } = room.size;

  const group = new THREE.Group();
  const mat = stairMaterial(roomKey, w);
  const tag = { kind: 'stair-surface', roomKey };

  const platformDepth = toZ - (-d/2);
  const platformZ = (toZ + (-d/2)) / 2;
  const platform = new THREE.Mesh(new THREE.BoxGeometry(w, rise, platformDepth), mat);
  platform.position.set(0, rise/2, platformZ);
  platform.userData = tag;
  group.add(platform);

  const topTex = makeFloorTexture();
  topTex.repeat.set(w/2, platformDepth/2);
  const platformTop = new THREE.Mesh(
    new THREE.PlaneGeometry(w, platformDepth),
    new THREE.MeshStandardMaterial({ map: topTex })
  );
  platformTop.rotation.x = -Math.PI/2;
  platformTop.position.set(0, rise + 0.001, platformZ);
  group.add(platformTop);

  const steps = 8;
  const stepRun = (fromZ - toZ) / steps;
  const stepRise = rise / steps;
  for(let i=0; i<steps; i++){
    const stepH = stepRise * (i+1);
    const zCenter = fromZ - stepRun*i - stepRun/2;
    const step = new THREE.Mesh(new THREE.BoxGeometry(w, stepH, stepRun), mat);
    step.position.set(0, stepH/2, zCenter);
    step.userData = tag;
    group.add(step);
  }

  return group;
}

// A freestanding ground-level sign on two posts, like a museum or
// apartment-complex sign out on the lawn -- not mounted on the building
// wall. Faces +z (south, toward the street) by default, same orientation
// convention as mountOutward's south case.
function buildGroundSign(text, asset){
  const group = new THREE.Group();
  const skinSrc = asset && asset.image ? asset.image : null;
  const size = (asset && asset.size && asset.size.w > 0 && asset.size.h > 0) ? asset.size : null;
  if(skinSrc && size){
    // Full-board skin: the image IS the whole sign (legs painted into the art),
    // so there are no separate posts. It's extruded from its own silhouette so
    // the sides follow the outline (not a flat slab); the board stands on the
    // ground and the name prints across its upper third, clearing the legs.
    group.add(makeExtrudedSignMesh(text, skinSrc, size, asset.sideColor));
    return group;
  }
  // Legacy look: a small panel held up on two wooden posts (no skin, or a
  // pre-size skin with no authored dimensions).
  const postMat = new THREE.MeshStandardMaterial({ color: 0x4a3320 });
  const postH = 1.1;
  const postGeo = new THREE.BoxGeometry(0.15, postH, 0.15);
  for(const dx of [-0.9, 0.9]){
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(dx, postH/2, 0);
    group.add(post);
  }
  const panel = makeSignMesh(text, skinSrc);
  panel.position.y = postH + 0.85/2;
  group.add(panel);
  return group;
}

// One green street-name blade: a thin green slab running along its local x with
// white-bordered white text on both faces. Returned oriented length-along-x,
// readable faces toward ±z; rotate the group to aim it down another street.
function makeStreetBlade(text){
  const L = 3.4, H = 0.55, T = 0.06;
  const blade = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(L, H, T),
    new THREE.MeshStandardMaterial({ color: 0x1b6b2e, roughness: 0.6 }));
  blade.add(body);
  // text + border drawn transparent so the green body shows through
  const cw = 512, ch = 96;
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, cw - 12, ch - 12);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let font = 58;
  ctx.font = `bold ${font}px sans-serif`;
  while(font > 18 && ctx.measureText(text).width > cw - 48){ font -= 2; ctx.font = `bold ${font}px sans-serif`; }
  ctx.fillText(text, cw / 2, ch / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  for(const sign of [1, -1]){
    const face = new THREE.Mesh(new THREE.PlaneGeometry(L * 0.94, H * 0.82),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    face.position.z = sign * (T / 2 + 0.006);
    if(sign < 0) face.rotation.y = Math.PI;
    blade.add(face);
  }
  return blade;
}

// A typical street sign: one gray post with two perpendicular green blades near
// the top -- the side-street name (running along the side street) and the cross
// street ("Main Street", running along Main Street) at 90 degrees.
function buildStreetNameSign(s){
  const group = new THREE.Group();
  const BLADE_H = 0.55;            // must match makeStreetBlade's H
  const crossY = 2.3;              // lower blade (Main Street) center height
  const nameY = crossY + BLADE_H + 0.05;   // upper blade (side street) stacked above
  const postTop = crossY - BLADE_H / 2;    // stop the post at the bottom of the lower blade

  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, postTop, 10),
    new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.4, roughness: 0.5 }));
  post.position.y = postTop / 2;
  group.add(post);

  const nameBlade = makeStreetBlade(s.text);          // runs along x (the side street)
  nameBlade.position.y = nameY;
  group.add(nameBlade);

  const crossBlade = makeStreetBlade(s.cross || 'Main Street');
  crossBlade.rotation.y = Math.PI / 2;                 // runs along z (Main Street)
  crossBlade.position.y = crossY;
  group.add(crossBlade);
  return group;
}

const OPEN_TILE_UNITS = 1.3;              // world size (m) of an opening-move tile
const OPEN_TILE_HALF = OPEN_TILE_UNITS / 2;
// A camera-facing tile showing a system's OPENING MOVE, sat at ground level
// under its street sign. Fallback chain: the move's mnemonic image, else its
// word, else the SAN notation. Reuses the movable-sprite ('doorBill') machinery
// so it selects/nudges/scales/persists like the door-side pair billboards.
function buildOpeningMoveSprite(s, userScale){
  const px = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.userData.baseH = OPEN_TILE_UNITS;
  sprite.userData.baseAspect = 1;
  sprite.userData.userScale = userScale || 1;

  // this tile always shows the game's very first move (ply 1), which is
  // always White's -- whether that move is "ours" (a White system) or the
  // opponent's (a Black system's trigger), so it always gets the "1." badge.
  const drawText = (t) => {
    ctx.clearRect(0, 0, px, px);
    ctx.fillStyle = 'rgba(240,236,226,0.95)';
    ctx.fillRect(0, 0, px, px);
    ctx.strokeStyle = '#caa46a'; ctx.lineWidth = 14; ctx.strokeRect(7, 7, px - 14, px - 14);
    ctx.fillStyle = '#1a1a1a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let font = 150; ctx.font = `bold ${font}px sans-serif`;
    while(font > 24 && ctx.measureText(t).width > px - 48){ font -= 6; ctx.font = `bold ${font}px sans-serif`; }
    ctx.fillText(t, px / 2, px / 2 + 6);
    drawMoveNumberBadge(ctx, 0, 0, px, 1);
    tex.needsUpdate = true;
  };
  const drawImage = (img) => {
    ctx.clearRect(0, 0, px, px);
    const sc = Math.min(px / img.width, px / img.height);
    const w = img.width * sc, h = img.height * sc;
    ctx.drawImage(img, (px - w) / 2, (px - h) / 2, w, h);
    drawMoveNumberBadge(ctx, 0, 0, px, 1);
    tex.needsUpdate = true;
  };

  drawText(s.openingWord || s.openingMove || '?');   // immediate; swapped for the image if one loads
  if(s.openingImg){
    const myGen = buildGeneration;
    loadImageCached(s.openingImg).then(img => {
      if(buildGeneration !== myGen || !scene || !img) return;
      drawImage(img);
    });
  }
  applySpriteContentScale(sprite);
  return sprite;
}

// A 'stair'-type exit gets a real protruding corridor instead of an ordinary
// doorway gap: the room's geometry grows a DOOR_W-wide hallway out through
// the wall, with stairs climbing from the room's own floor (0) up to its
// own ceiling height (room.size.h) by the far end. clampToRoom lets the
// player walk into this footprint, and floorHeightAtPos ramps their eye
// height to match as they climb (mirroring the decorative-steps-on-top-of-
// a-continuous-ramp split that buildStairs already uses for room.stairs).
// The far end is left open -- like an ordinary door, the "next room" is an
// illusion stitched together by enterRoom's teleport, not real geometry.
function buildStairCorridor(room, wall, offset, surfaceAsset, roomKey, dir){
  dir = dir || 1;
  const down = dir < 0;
  const { axis, fixed } = wallSpan(room.size, wall);
  const outSign = fixed >= 0 ? 1 : -1;
  const { rise, steps, depth } = stairCorridorGeom(room);
  const dHalf = DOOR_W/2;
  const stepRise = rise / steps;
  // vertical extent of the shaft. UP: floor (0) to ceilingH. DOWN: descends
  // straight into a pit (-rise) under a floor-level ceiling. The camera tilts
  // down near the doorway (see STAIR_DOWN_PEEK) so the descent is visible.
  const topY = down ? (EYE_HEIGHT + 1.0) : (rise + EYE_HEIGHT + 1.0);
  const botY = down ? -rise : 0;
  const shaftH = topY - botY;
  const group = new THREE.Group();
  // Both UP and DOWN corridors inherit the parent wall's skin so they can be
  // skinned the same way (down-stairs used to be gray, which also made them
  // unskinnable -- reverted per feedback).
  const wallTex = surfaceAsset ? null : makeBrickTexture(room.color);
  const wallMatFor = (segW, segH) => {
    if(surfaceAsset){
      const rpm = surfaceAsset.repeatPerMeter || 0.5;
      return assetSurfaceMaterial(surfaceAsset, segW * rpm, segH * rpm);
    }
    const tex = wallTex.clone();
    tex.needsUpdate = true;
    tex.repeat.set(Math.max(1, Math.round(segW/2.5)), Math.max(1, Math.round(segH/2)));
    return new THREE.MeshStandardMaterial({ map: tex });
  };

  for(const side of [-1, 1]){
    const across = offset + side*dHalf;
    let geo, x, z;
    if(axis === 'x'){ geo = new THREE.BoxGeometry(WALL_THICK, shaftH, depth); x = across; z = fixed + outSign*depth/2; }
    else { geo = new THREE.BoxGeometry(depth, shaftH, WALL_THICK); x = fixed + outSign*depth/2; z = across; }
    const sideWall = new THREE.Mesh(geo, wallMatFor(depth, shaftH));
    sideWall.position.set(x, botY + shaftH/2, z);
    group.add(sideWall);
  }

  {
    let geo, x, z;
    if(axis === 'x'){ geo = new THREE.BoxGeometry(DOOR_W, WALL_THICK, depth); x = offset; z = fixed + outSign*depth/2; }
    else { geo = new THREE.BoxGeometry(depth, WALL_THICK, DOOR_W); x = fixed + outSign*depth/2; z = offset; }
    const ceiling = new THREE.Mesh(geo, wallMatFor(depth, DOOR_W));
    ceiling.position.set(x, topY + WALL_THICK/2, z);
    group.add(ceiling);
  }

  const stepMat = stairMaterial(roomKey, DOOR_W);
  const stepTag = { kind: 'stair-surface', roomKey };
  // Build one solid step block whose top is at treadTop (down to botY).
  const addStep = (treadTop, along) => {
    const stepH = treadTop - botY;   // block height from the shaft floor up
    if(stepH <= 0.001) return;
    let geo, x, z;
    if(axis === 'x'){ geo = new THREE.BoxGeometry(DOOR_W*0.96, stepH, STAIR_STEP_RUN); x = offset; z = fixed + outSign*along; }
    else { geo = new THREE.BoxGeometry(STAIR_STEP_RUN, stepH, DOOR_W*0.96); x = fixed + outSign*along; z = offset; }
    const step = new THREE.Mesh(geo, stepMat);
    step.position.set(x, treadTop - stepH/2, z);   // top of the block at treadTop
    step.userData = stepTag;
    group.add(step);
  };

  for(let i = 0; i < steps; i++){
    // UP: tread tops climb 0 → rise. DOWN: tread tops step down 0 → -rise, so
    // each block runs from the pit floor up to its (descending) tread top.
    const treadTop = down ? -stepRise * (i + 1) : stepRise * (i + 1);
    addStep(treadTop, (i + 0.5) * STAIR_STEP_RUN);
  }

  return group;
}

function doorTriggerBox(size, wall, offset, origin){
  origin = origin || { x:0, z:0 };
  const { axis, fixed, half } = wallSpan(size, wall);
  const dHalf = DOOR_W/2;
  const pad = 1.0; // how far into/past the doorway the trigger reaches
  let box;
  if(axis === 'x'){
    box = { minX: offset-dHalf, maxX: offset+dHalf, minZ: fixed-pad, maxZ: fixed+pad };
  } else {
    box = { minX: fixed-pad, maxX: fixed+pad, minZ: offset-dHalf, maxZ: offset+dHalf };
  }
  return {
    minX: box.minX + origin.x, maxX: box.maxX + origin.x,
    minZ: box.minZ + origin.z, maxZ: box.maxZ + origin.z
  };
}

// A stair exit's trigger sits at the top of its corridor (the far end of the
// climb) rather than the wall plane -- the player has to actually walk the
// corridor and climb the steps before the room transition fires.
function stairTriggerBox(room, wall, offset){
  const { axis, fixed } = wallSpan(room.size, wall);
  const cs = currentStairCorridors[wall] || [];
  const c = cs.find(cc => Math.abs(cc.offset - offset) < 0.001) || cs[0];
  const dHalf = DOOR_W/2;
  const pad = 0.8;
  const farEdge = fixed + c.outSign*c.depth;
  const nearEdge = fixed + c.outSign*(c.depth - pad);
  const lo = Math.min(farEdge, nearEdge), hi = Math.max(farEdge, nearEdge);
  if(axis === 'x') return { minX: offset-dHalf, maxX: offset+dHalf, minZ: lo, maxZ: hi };
  return { minX: lo, maxX: hi, minZ: offset-dHalf, maxZ: offset+dHalf };
}

function doorSpawn(size, wall, offset, origin, inside){
  // "inside" spawns a couple meters in from the doorway, facing further
  // into the room; the mirrored "outside" spawn faces away from the
  // doorway instead — both use this camera's forward vector convention
  // of (-sin(yaw), -cos(yaw)).
  origin = origin || { x:0, z:0 };
  const { fixed } = wallSpan(size, wall);
  // how far in from the door to stand -- capped by the room's own depth
  // along this wall's inward axis, so a small elevator car doesn't spawn
  // you out past its opposite wall (normal 10m rooms are unaffected: their
  // half-depth comfortably clears the 2.5m default).
  const depthDim = (wall === 'north' || wall === 'south') ? size.d : size.w;
  // stand just inside the doorway you came through -- close enough that the door
  // is right behind you (the old 2.5 m left you marooned mid-room). Backing into
  // the door never teleports (backward motion isn't an exit), and the forward-
  // only trigger + 0.6 s spawn grace mean sitting in its box here is harmless.
  // The mirrored "outside" spawn keeps the larger step-back onto the street.
  const cap = inside ? 0.8 : 2.5;
  const inset = Math.min(cap, Math.max(0.6, depthDim/2 - 0.3));
  let x, z, yaw;
  if(wall === 'north'){ x = offset; z = inside ? fixed+inset : fixed-inset; yaw = inside ? Math.PI : 0; }
  if(wall === 'south'){ x = offset; z = inside ? fixed-inset : fixed+inset; yaw = inside ? 0 : Math.PI; }
  if(wall === 'west'){  z = offset; x = inside ? fixed+inset : fixed-inset; yaw = inside ? -Math.PI/2 : Math.PI/2; }
  if(wall === 'east'){  z = offset; x = inside ? fixed-inset : fixed+inset; yaw = inside ? Math.PI/2 : -Math.PI/2; }
  return { x: x + origin.x, z: z + origin.z, yaw };
}

// "just inside the entrance" spot a room with no matching exit to spawn
// against falls back to -- mainStreet, or a linked foreign castle's entry
// (see gatherLinkedCastles) with no exits built yet. Matches
// registerOneCastle's own entry `spawn`. Shared by computeSpawnForExit and
// entrySpawnFor below, which otherwise pick their "returning" exit
// differently (see each's own comment for why).
function defaultEntrySpawn(room){
  return { x: 0, z: room.size.d / 2 - CAS_LAYOUT.entrySetback, yaw: 0 };
}

function computeSpawnForExit(fromKey, room, ex){
  const targetRoom = mergedRoom(ex.target);
  // a dangling target -- e.g. a cross-castle redirect whose target room
  // disappeared out from under it (app.js's own repair/warning for this is
  // best-effort, not airtight: there's a window before its debounced scan
  // catches up) -- degrades to "stay put" instead of crashing here. This
  // exit still gets a live trigger built around it (see the "locked" check
  // this same doc comment is echoed at, in buildRoom's own wall/exit loop,
  // which skips registering one in the first place whenever possible), so
  // reaching this fallback at all should be rare.
  if(!targetRoom){
    console.warn(`[VR] computeSpawnForExit: target room "${ex.target}" doesn't exist -- degrading to a same-room spawn instead of crashing`);
    return defaultEntrySpawn(room);
  }
  if(targetRoom.outdoor){
    // walking out of a building's front door onto the street
    const building = targetRoom.buildings.find(b => b.target === fromKey);
    return doorSpawn(room.size, ex.wall, ex.offset, building.origin, false);
  }
  // ordinary interior-to-interior transition: spawn just inside whichever of
  // the target room's own exits leads back to fromKey SPECIFICALLY -- a
  // transposed room can have more than one parent, and the one just walked
  // in from isn't necessarily its single canonical back:true exit (that's
  // entrySpawnFor's job, not this one). Falls back to its first exit if none
  // matches at all -- a linked foreign castle's entry can have no exits of
  // its own at all -- no forward doors built yet and not on a street.
  const returning = targetRoom.exits.find(e => e.target === fromKey) || targetRoom.exits[0];
  return returning
    ? doorSpawn(targetRoom.size, returning.wall, returning.offset, null, true)
    : defaultEntrySpawn(targetRoom);
}

// the spawn just inside roomKey's OWN canonical entrance (its back:true
// exit, same spawn a normal walk-in through that door would use) -- unlike
// computeSpawnForExit, not relative to any particular room arrived FROM,
// since there isn't one here (used after a resize, not a real walk-through).
// Falls back to defaultEntrySpawn for a room with no back exit (mainStreet,
// a linked foreign castle's entry). null if roomKey isn't registered.
function entrySpawnFor(roomKey){
  const room = mergedRoom(roomKey);
  if(!room) return null;
  const backEx = (room.exits || []).find(e => e.back);
  return backEx ? doorSpawn(room.size, backEx.wall, backEx.offset, null, true) : defaultEntrySpawn(room);
}
// stands the player at roomKey's entrySpawnFor(). Used after a resize --
// resizing can otherwise leave the player outside the new bounds (clamped to
// some arbitrary edge) or facing straight into a wall.
function respawnAtEntry(roomKey){
  const spawn = entrySpawnFor(roomKey);
  if(!spawn) return;
  pos.x = spawn.x; pos.z = spawn.z; yaw = spawn.yaw;
  teleportLockUntil = clock.getElapsedTime() + 0.6;
}

/* G2a: a freestanding placard in a generated-castle room, listing the room's
   moves (and any unbuilt exits). Faces south, toward the entering player. The
   rich move-pair billboards replace this in a later phase. */
function buildCastleRoomSign(room){
  const sign = room.castleSign;
  const cw = 512, ch = 440;
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(244,240,230,0.96)'; ctx.fillRect(0, 0, cw, ch);
  ctx.strokeStyle = '#8a6d3b'; ctx.lineWidth = 8; ctx.strokeRect(6, 6, cw - 12, ch - 12);
  ctx.fillStyle = '#3a2c12'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  let tf = 42; ctx.font = `bold ${tf}px serif`;
  while(tf > 18 && ctx.measureText(sign.title).width > cw - 48){ tf -= 2; ctx.font = `bold ${tf}px serif`; }
  ctx.fillText(sign.title, cw / 2, 18);
  let y = 18 + tf + 8;
  ctx.fillStyle = '#6a5a3a'; ctx.font = 'italic 22px serif';
  ctx.fillText(sign.type, cw / 2, y); y += 38;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#1a1a1a'; ctx.font = '26px sans-serif';
  for(const m of (sign.moves || [])){ if(y > ch - 96) break; ctx.fillText('• ' + m, 40, y); y += 32; }
  if(sign.doors && sign.doors.length){
    ctx.fillStyle = '#2c5a3b'; ctx.font = '22px sans-serif';
    for(const d of sign.doors){ if(y > ch - 64) break; ctx.fillText('🚪 ' + d, 40, y); y += 28; }
  }
  if(sign.unbuilt && sign.unbuilt.length && y <= ch - 40){
    ctx.fillStyle = '#9a3b2c'; ctx.font = 'italic 22px sans-serif';
    ctx.fillText('unbuilt: ' + sign.unbuilt.join(' '), 40, y);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const W = 2.2, H = W * (ch / cw);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }));
  mesh.position.set(0, 1.7, -room.size.d * 0.18);
  return mesh;
}
/* the two-track half-wall's footprint (x/z axis-aligned box), shared by the
   geometry and the collision test so they always agree. Runs down the central
   axis (x=0) from just north of the center pair to (nearly) the north wall. */
const DIVIDER_THICK = 0.3;
function twoTrackDividerBox(room){
  const d = room.size.d;
  const centerZ = d / 2 - CAS_LAYOUT.entrySetback - CAS_LAYOUT.centerAhead;
  return {
    xMin: -DIVIDER_THICK / 2, xMax: DIVIDER_THICK / 2,
    zMin: -d / 2 + 0.3,          // to (nearly) the north wall
    zMax: centerZ - 1.0          // start just north of the center pair
  };
}
// push the player out of the half-wall (inflated by their radius), along the
// shallowest axis, so they can't walk through it. South of the wall's south end
// stays open, so you can still cross between lanes near the entrance.
function clampOutOfDivider(room, x, z){
  const b = twoTrackDividerBox(room), r = PLAYER_RADIUS;
  const xMin = b.xMin - r, xMax = b.xMax + r, zMin = b.zMin - r, zMax = b.zMax + r;
  if(x <= xMin || x >= xMax || z <= zMin || z >= zMax) return { x, z };   // clear of the wall
  const dLeft = x - xMin, dRight = xMax - x, dSouth = zMax - z, dNorth = z - zMin;
  const m = Math.min(dLeft, dRight, dSouth, dNorth);
  if(m === dLeft) x = xMin; else if(m === dRight) x = xMax;
  else if(m === dSouth) z = zMax; else z = zMin;
  return { x, z };
}
/* two-track castle room: a chest-high half-wall down the central axis, from just
   north of the center (anchor) pair to the north wall, dividing the room into a
   left lane and a right lane so the two run-tracks read as separate paths. Low
   enough (1.4 m) to see over and take in both tracks at a glance. */
function buildTwoTrackDivider(room){
  const b = twoTrackDividerBox(room);
  const len = Math.max(1, b.zMax - b.zMin);
  const wallH = Math.min(1.4, room.size.h - 0.2);
  // .clone() before mutating -- makeBrickTexture hands out a SHARED, cached
  // base texture per tint (see _brickTexCache); wrapS/wrapT/repeat set
  // directly on it would leak into every other room sharing this same tint.
  const tex = makeBrickTexture(0x8a7f6a).clone();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(Math.max(1, len / 2), 1);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(DIVIDER_THICK, wallH, len),
    new THREE.MeshStandardMaterial({ map: tex }));
  mesh.position.set(0, wallH / 2, (b.zMax + b.zMin) / 2);
  mesh.userData = { kind: 'divider' };
  return mesh;
}
// how long (world units) one chain-link tile reads as, so the texture's
// repeat count -- and thus the apparent link count -- scales with the
// actual gap between two consecutive move-object slots, not a fixed count.
// stays below the room-name floor label (floorY + 0.015) so the chain never
// draws on top of the name text where their paths cross near the entrance.
const CHAIN_LINK_SIZE = 0.75, CHAIN_WIDTH = 0.32, CHAIN_Y = 0.01;
// Grammar, not decoration (see the memorization-strategy discussion this
// implements): a plain (non-two-track) corridor room's move-object slots
// are a forced sequence, and there's otherwise nothing distinguishing that
// from a room with the same slot count but a separate door per slot -- no
// half-wall divider the way a two-track room gets. A floor-laid chain
// strip between each CONSECUTIVE slot (in true walk order, not raw array
// order -- see SIDE_WALK_RANK) signals "these are linked" without being a
// discrete object to remember: it can repeat identically in every corridor
// room forever, the way a road sign repeats, because recognizing it is
// meant to be instant rather than recalled per room. Never drawn for a
// two-track room (already has its own divider) or a solo branch/room kind
// (a single slot has nothing to connect to). Returns null (nothing to add)
// when the room has fewer than 2 links worth of position to draw.
function addChainSegment(group, a, b){
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if(len < 0.05) return;   // endpoints on top of each other -- nothing to draw
  const geo = new THREE.PlaneGeometry(CHAIN_WIDTH, len);
  geo.rotateX(-Math.PI / 2);   // lie flat, "length" now along local Z
  // .clone() before mutating -- makeChainTexture hands out a single
  // shared, cached texture (see _chainTexture); wrapS/wrapT/repeat set
  // directly on it would leak into every other chain segment/room.
  const tex = makeChainTexture().clone();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, Math.max(1, len / CHAIN_LINK_SIZE));
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial(
    { map: tex, transparent: true, roughness: 0.4, metalness: 0.6 }));
  mesh.position.set((a.x + b.x) / 2, CHAIN_Y, (a.z + b.z) / 2);
  mesh.rotation.y = Math.atan2(dx, dz);
  mesh.userData = { kind: 'moveObjectChain' };
  group.add(mesh);
}
// track ('left'/'right'), when given, builds just THAT two-track lane's own
// chain -- its own slots in order, fanning out to its own forward door(s)
// only -- instead of the whole room. Omit it for a plain corridor (all
// slots, one shared sequence), which is the original/default behavior.
function buildMoveObjectChain(room, roomKey, track){
  // resolve each slot's ACTUAL position, not just its default computed one --
  // a moveObject slot can be individually nudged in edit mode (slotXformFor,
  // applied the same way applyAccessoryTransform places the real prop: base
  // x/z + xform.dx/dz), and the chain needs to end up where the props
  // actually are, not where they'd sit before any nudging.
  const resolved = s => {
    const xf = slotXformFor(roomKey, s.id);
    return { x: s.x + (xf?.dx || 0), z: s.z + (xf?.dz || 0) };
  };
  // a lane's own slots already exclude the shared center/anchor pair (it has
  // side 'left'/'right', never 'center'), so no slice(1) needed there; the
  // whole-room (track omitted) case still walks center-then-left-then-right
  // in SIDE_WALK_RANK order and drops the first (center) entry the same way
  // it always has.
  const ordered = track
    ? moveObjectSlots(roomKey).filter(s => s.side === track).sort((a, b) => (a.order || 0) - (b.order || 0))
    : moveObjectSlots(roomKey).slice().sort((a, b) =>
        ((SIDE_WALK_RANK[a.side] ?? 3) - (SIDE_WALK_RANK[b.side] ?? 3)) || ((a.order || 0) - (b.order || 0)));
  if(!ordered.length) return null;
  const group = new THREE.Group();
  // the walk starts at the room's own name floor-label spot near the entrance,
  // not at the first slot's (usually the center/anchor pair's) own position --
  // that slot is often bare (its move is already shown via the previous room's
  // door pair) so anchoring the chain there pointed at nothing memorable; the
  // name label is an always-present, meaningful floor marker to start from.
  // Also the natural shared starting point for a two-track room's own pair of
  // lane chains -- both lanes fan out from the same entrance, same as their
  // real doors do.
  const entryPos = roomNameFloorPos(room.size, entranceWall(room));
  const path = [entryPos, ...(track ? ordered.map(resolved) : ordered.slice(1).map(resolved))];
  for(let i = 0; i < path.length - 1; i++) addChainSegment(group, path[i], path[i + 1]);
  // final link(s): every forward door carries its OWN pair/object preview of
  // the room beyond (buildDoorPair, keyed 'dobj-<target>' in this room's
  // slotXform) -- a wholly separate object from this room's own
  // moveObjectSlots, but the last thing you see walking the sequence before
  // stepping through, so the chain should end there rather than stopping
  // short at the room's own last internal slot (the real bug report: a
  // corridor's chain stopped at its last slot and never reached the door's
  // own horse-statue pair-object beyond it). A plain corridor's tail can
  // branch into more than one forward door (a branch that didn't qualify as a
  // two-track) -- every one of them is a real possible continuation from the
  // same last slot, so each gets its own link fanning out from there, not
  // just the first. A two-track lane only fans out to ITS OWN doors (ex.track),
  // never the other lane's -- each lane's own exits array already carries that.
  const allFwd = room.exits ? room.exits.filter(e => !e.back && (!track || e.track === track)) : [];
  for(const fwd of allFwd){
    const sideSign = fwd.wall === 'east' ? 1 : -1;
    const base = doorSideXZ(room, fwd.wall, fwd.offset, sideSign);
    const xf = slotXformFor(roomKey, 'dobj-' + fwd.target);
    const doorPos = { x: base.x + (xf?.dx || 0), z: base.z + (xf?.dz || 0) };
    addChainSegment(group, path[path.length - 1], doorPos);
  }
  if(!group.children.length) return null;
  // tagged so a live nudge (setSlotXformLive) can find and rebuild just this
  // group in place, without a full buildRoom -- see rebuildMoveObjectChainLive.
  // track carried along too so a two-track lane's chain can be told apart
  // from its sibling lane's when both exist in the scene at once.
  group.userData = { kind: 'moveObjectChainGroup', track: track || null };
  return group;
}
// A move-object or door-object nudge (setSlotXformLive) moves the real prop
// live without a full buildRoom (avoids the flash a rebuild would cause), but
// the chain's segments were computed once at the last full build and don't
// follow -- they'd visibly point at the object's old, default position until
// the room was next entered. The chain is cheap to rebuild (a handful of
// synchronous plane meshes sharing one cached texture, no async asset loads),
// so just swap it out in place on every relevant nudge instead. A no-op if
// this room has no chain at all (not a corridor/two-track, or nothing to
// link). A two-track room carries TWO chain groups (one per lane) -- both are
// removed and rebuilt together since either lane's nudge should leave the
// other lane's chain untouched but still correctly redrawn in place.
function rebuildMoveObjectChainLive(roomKey){
  if(!scene) return;
  const room = mergedRoom(roomKey);
  if(!room) return;
  const old = [];
  scene.traverse(o => { if(o.userData && o.userData.kind === 'moveObjectChainGroup') old.push(o); });
  for(const o of old){ disposeSceneContents(o); scene.remove(o); }
  if(room.twoTrack){
    for(const track of ['left', 'right']){
      const chain = buildMoveObjectChain(room, roomKey, track);
      if(chain) scene.add(chain);
    }
  } else if((room.castleSign && room.castleSign.type) === 'corridor'){
    // matches buildRoom's own gate exactly (see its "two-track castle rooms
    // get..." comment) -- a room that's neither two-track nor a corridor
    // (e.g. a junction with no forced sequence at all) gets no chain on a
    // full build, but this function had no such check: nudging a
    // move-object there would spuriously conjure one into the live scene
    // (gone again on the next full rebuild, e.g. leaving edit mode) since
    // buildMoveObjectChain itself doesn't know or care what kind of room
    // it's being asked to chain.
    const chain = buildMoveObjectChain(room, roomKey);
    if(chain) scene.add(chain);
  }
}
// briefly shows a status message top-center (e.g. the bounds-auto-fix notice)
// so a silent data correction isn't invisible to the user; fades after ~3.5s.
function showToast(msg){
  if(!toastEl) return;
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  toastEl.style.opacity = '1';
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.style.opacity = '0';
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 400);
  }, 3500);
}

// Re-validate every stored slot transform for `roomKey` against the room's
// CURRENT geometry, snapping anything that now pokes outside the room back in
// bounds. A stored nudge (dx/dz for a floor/move-object/billboard item, or
// dOffset/dY for a wall item) was only ever validated against the room size AT
// THE TIME the nudge was made -- shrinking the room afterward (via the room
// geometry dialog) can leave it clipping through a wall or sitting outside
// entirely, and it stays broken until someone notices and re-nudges it by hand.
// Runs at the top of every buildRoom, so it's a standing check on every room
// entry AND every geometry edit, not a one-time migration -- and it mirrors the
// exact clamp math nudgeSelected already uses live, so a reconciled item ends
// up exactly where a manual nudge to the same spot would have put it. Returns
// the number of items it corrected (0 = nothing needed fixing).
function reconcileRoomBounds(roomKey){
  let room = mergedRoom(roomKey);
  if(!room || room.outdoor) return 0;   // streets/lawns aren't resizable "rooms"
  // Size self-heal (before the per-item checks below, so they run against the
  // corrected size). A stored size override (LAYOUT[roomKey].geom) that's
  // smaller than the room's own content minimum would trap move-pair
  // billboards and doors in the walls -- and the per-item nudge fixes below
  // can only cram them against a too-small wall, not actually make room. This
  // happens when an override outlives the content it was sized for: saved when
  // the room held fewer pairs/doors, or -- the case that motivated this -- kept
  // under a room's key after the phantom-en-passant canonicalization MERGED
  // another transposing path into it, folding in that path's onward doors.
  // Grow the saved geometry up to relaxedContentMin (the exact floor the Room
  // Geometry dialog clamps to on Apply), so the room self-heals on the next
  // walk-in instead of needing a manual Reset. Only ever GROWS, and only a
  // sub-floor override, so a legitimate size (always >= the floor, since the
  // dialog enforces it) is never touched. relaxedContentMin returns null for
  // elevator cars and outdoor rooms -- those size themselves and a car
  // legitimately shrinks below this, so they're left alone.
  if(LAYOUT[roomKey] && LAYOUT[roomKey].geom){
    const floor = relaxedContentMin(room, roomKey);
    if(floor){
      const g = LAYOUT[roomKey].geom;
      const nw = Math.max(g.w, floor.w), nd = Math.max(g.d, floor.d);
      if(nw > g.w + 1e-6 || nd > g.d + 1e-6){
        LAYOUT[roomKey].geom = { ...g, w: nw, d: nd };
        persistLayout();
        room = mergedRoom(roomKey);   // re-read so the item checks below see the grown size
      }
    }
  }
  const layoutRoom = LAYOUT[roomKey];
  const xforms = (layoutRoom && layoutRoom.slotXform) || {};
  let fixed = 0;
  for(const slotId of Object.keys(xforms)){
    const xform = xforms[slotId];
    if(!xform) continue;
    let kind, baseX, baseZ, baseY, wall, offset;
    const slot = slotById(room, roomKey, slotId);
    if(slot){
      kind = slot.kind; baseX = slot.x; baseZ = slot.z; baseY = slot.y; wall = slot.wall; offset = slot.offset;
    } else if(slotId.startsWith('dobj-') || slotId.startsWith('dbb-')){
      // a door-anchored object/billboard (buildPairAt) -- not in roomSlots; its
      // base tracks the target door's CURRENT wall/offset instead of a fixed slot.
      const target = slotId.slice(slotId.indexOf('-') + 1);
      const ex = (room.exits || []).find(e => e.target === target && !e.back);
      if(!ex) continue;   // that door doesn't exist on this room anymore -- nothing to reconcile
      const pos = doorSideXZ(room, ex.wall, ex.offset, ex.wall === 'east' ? 1 : -1);
      baseX = pos.x; baseZ = pos.z;
      kind = slotId.startsWith('dobj-') ? 'moveObject' : 'mnemonic';
    } else {
      continue;   // stale/unknown slot id -- nothing safe to reconcile against
    }

    const next = { ...xform };
    let changed = false;
    if(kind === 'floor' || kind === 'moveObject' || kind === 'mnemonic'){
      // same clamp nudgeSelected applies live for these kinds (clampFloorXZ)
      const clamped = clampFloorXZ(room.size, baseX + (xform.dx || 0), baseZ + (xform.dz || 0));
      const dx = clamped.x - baseX, dz = clamped.z - baseZ;
      if(dx !== (xform.dx || 0) || dz !== (xform.dz || 0)){ next.dx = dx; next.dz = dz; changed = true; }
    } else if(kind === 'wall'){
      const { half } = wallSpan(room.size, wall);
      const maxOffset = half - 0.4;
      const wantOffset = offset + (xform.dOffset || 0);
      const clampedOffset = Math.max(-maxOffset, Math.min(maxOffset, wantOffset));
      const dOffset = clampedOffset - offset;
      if(dOffset !== (xform.dOffset || 0)){ next.dOffset = dOffset; changed = true; }
      if(baseY != null){
        const minDY = 0.3 - baseY, maxDY = room.size.h - 0.3 - baseY;
        const dY = Math.max(minDY, Math.min(maxDY, xform.dY || 0));
        if(dY !== (xform.dY || 0)){ next.dY = dY; changed = true; }
      }
    }
    if(changed){ xforms[slotId] = next; fixed++; }
  }
  // Base (never-nudged) move-object/mnemonic slots: their position is purely
  // computed from the room's CURRENT size (mnemPairLayout), so in the common
  // case a resize moves them automatically -- but a STALE, too-small saved
  // room geometry (LAYOUT[roomKey].geom left over from before a later move-
  // pair was added, or a manual shrink after the fact) can leave a later
  // pair's computed position sitting behind a wall with no nudge involved at
  // all, so the loop above never sees it (nothing in xforms to re-check yet).
  // Check every such slot's base position directly and synthesize a
  // corrective dx/dz -- the same effect an auto-applied nudge would have --
  // so it becomes visible/reachable again instead of silently staying lost.
  // (buildMoveObjectPlaceholder/buildMoveObjectWordLabel/placeMnemonicSlot
  // all apply slotXformFor, so this correction actually shows up even for a
  // still-unfilled slot -- not just once something is placed in it.)
  for(const slot of roomSlots(room, roomKey)){
    if(slot.kind !== 'moveObject' && slot.kind !== 'mnemonic') continue;
    if(xforms[slot.id]) continue;   // already covered by the loop above
    const clamped = clampFloorXZ(room.size, slot.x, slot.z);
    if(clamped.x !== slot.x || clamped.z !== slot.z){
      ensureRoomLayout(roomKey).slotXform[slot.id] = { dx: clamped.x - slot.x, dz: clamped.z - slot.z };
      fixed++;
    }
  }
  if(fixed) persistLayout();
  return fixed;
}

// tags a material/texture as a permanent, session-lifetime SINGLETON (a
// lazily-created-once-and-reused module-level resource, e.g. the selection
// gear icon or an edit-mode marker material shared by every room) so
// disposeSceneContents below skips it instead of disposing something every
// OTHER room still needs.
function tagShared(resource){
  resource.userData = resource.userData || {};
  resource.userData.shared = true;
  return resource;
}

// Frees GPU resources (geometry, materials, and their texture maps) for
// everything currently in `root`, before buildRoom's scene.clear() detaches
// it all. Object3D.clear()/Scene.clear() only unlinks children from the
// scene graph -- it never calls .dispose() on anything -- so without this,
// every single edit (buildRoom runs on nearly all of them: drags, clicks,
// door skin/floor picks, resizes...) leaks the previous scene's geometries,
// materials and textures. Two things are deliberately left alone:
//   - THREE.Sprite geometry: every Sprite in three.js shares ONE static
//     built-in geometry (created once, lazily, internal to the Sprite
//     class itself) -- disposing it here would silently break every
//     sprite in the app (billboards, gear icons, exit signs...) from that
//     point on, not just this room's.
//   - anything tagged tagShared() (gearMat, the edit-mode marker
//     materials, etc.) -- session-lifetime singletons reused across every
//     room, not rebuilt per room, so disposing one breaks it for every
//     OTHER room too.
function disposeSceneContents(root){
  root.traverse(obj => {
    if(obj.geometry && !obj.isSprite) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
    for(const mat of mats){
      if(mat.userData && mat.userData.shared) continue;
      for(const key of ['map', 'alphaMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'bumpMap']){
        if(mat[key] && mat[key].dispose) mat[key].dispose();
      }
      mat.dispose();
    }
  });
}

function buildRoom(roomKey){
  const boundsFixed = reconcileRoomBounds(roomKey);
  if(boundsFixed) showToast(`Moved ${boundsFixed} item${boundsFixed === 1 ? '' : 's'} back inside the room`);
  const room = mergedRoom(roomKey);
  buildGeneration++;
  const myGeneration = buildGeneration;
  disposeSceneContents(scene);
  scene.clear();
  billboards = [];
  floorLabels = [];

  scene.add(new THREE.AmbientLight(0xffffff, room.outdoor ? 0.75 : 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, room.outdoor ? 0.9 : 0.7);
  sun.position.set(4, 8, 3);
  scene.add(sun);

  scene.background = new THREE.Color(room.outdoor ? 0x8fb8d8 : 0x111317);

  const { w, d, h } = room.size;
  if(room.outdoor){
    scene.add(buildOutdoorGround(room));
    scene.add(buildClouds(room));
  } else {
    let floorMat;
    const floorAsset = floorAssetFor(roomKey);
    if(floorAsset){
      const rpm = floorAsset.repeatPerMeter || 0.5;
      floorMat = assetSurfaceMaterial(floorAsset, w * rpm, d * rpm);
    } else {
      const groundTex = makeFloorTexture();
      groundTex.repeat.set(w/2, d/2);
      floorMat = new THREE.MeshStandardMaterial({ map: groundTex });
    }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
    floor.rotation.x = -Math.PI/2;
    floor.userData = { kind: 'floor' };
    scene.add(floor);
  }

  if(!room.outdoor){
    let ceilMat;
    const ceilingAsset = ceilingAssetFor(roomKey);
    if(ceilingAsset){
      const rpm = ceilingAsset.repeatPerMeter || 0.5;
      ceilMat = assetSurfaceMaterial(ceilingAsset, w * rpm, d * rpm);
    } else {
      ceilMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    }
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, d), ceilMat);
    ceiling.rotation.x = Math.PI/2;
    ceiling.position.y = h;
    ceiling.userData = { kind: 'ceiling-surface' };
    scene.add(ceiling);
  }

  const carMode = isElevatorCar(roomKey);

  // two-track castle rooms get a half-wall dividing the left and right lanes
  // PLUS a floor chain per lane (each is its own forced sequence, same as a
  // corridor's single chain, just two of them fanning out from the shared
  // entrance); a plain corridor's move-object slots get the one shared chain
  // instead (see buildMoveObjectChain).
  if(room.twoTrack){
    scene.add(buildTwoTrackDivider(room));
    for(const track of ['left', 'right']){
      const chain = buildMoveObjectChain(room, roomKey, track);
      if(chain) scene.add(chain);
    }
  } else if((room.castleSign && room.castleSign.type) === 'corridor'){
    const chain = buildMoveObjectChain(room, roomKey);
    if(chain) scene.add(chain);
  }

  // a room with no forward exit at all -- the sequence genuinely ends here,
  // as opposed to a locked door (a real, if unbuilt, reply) -- gets a
  // skinnable "no entry" sign where a forward door would have gone, so its
  // absence reads as intentional rather than "not built yet" (see
  // deadEndAssetFor/buildNoContinuationIcon). Skipped when castleSign.unbuilt
  // is non-empty: those are opponent replies actually seen in the user's
  // games with no prepared response yet (registerOneCastle's leaf exits,
  // shown on the room's own sign as "unbuilt: ..."), which is exactly the
  // "known opponent move, no reply built" case a locked door already
  // represents -- the sequence does NOT genuinely end here, so the no-entry
  // sign would be actively misleading.
  const hasUnbuilt = !!(room.castleSign && room.castleSign.unbuilt && room.castleSign.unbuilt.length);
  if(room.castleSign && !room.twoTrack && !hasUnbuilt && !room.exits.some(e => !e.back)){
    const back = room.exits.find(e => e.back);
    const deadEndWall = back ? WALL_OPPOSITE[back.wall] : 'north';
    const deadEndAsset = deadEndAssetFor(roomKey);
    scene.add(deadEndAsset ? buildDoorPanel(room.size, deadEndWall, 0, deadEndAsset) : buildNoContinuationIcon(room.size, deadEndWall, 0));
    if(editMode) scene.add(buildDeadEndMarker(room.size, deadEndWall, 0, roomKey));
  }
  // a two-track room's two lanes dead-end independently -- each gets its OWN
  // sign, centered in its own half of the north wall (the same quarter-width
  // spot registerOneCastle placed that lane's real doors around), when THAT
  // lane (not the room as a whole) has neither a real door nor an unbuilt
  // leaf exit (see registerOneCastle's deadTracks). Recomputed from the
  // room's CURRENT size (not the generation-time value) so a later resize
  // keeps each sign centered in its half.
  if(room.twoTrack && room.deadTracks){
    const quarter = room.size.w / 4;
    for(const track of ['left', 'right']){
      if(!room.deadTracks[track]) continue;
      const offset = track === 'right' ? quarter : -quarter;
      const deadEndAsset = deadEndAssetFor(roomKey, track);
      scene.add(deadEndAsset ? buildDoorPanel(room.size, 'north', offset, deadEndAsset) : buildNoContinuationIcon(room.size, 'north', offset));
      if(editMode) scene.add(buildDeadEndMarker(room.size, 'north', offset, roomKey, track));
    }
  }

  currentStairCorridors = {};
  for(const ex of room.exits){
    if(isStairType(ex.type)){
      const { fixed } = wallSpan(room.size, ex.wall);
      const { rise, depth } = stairCorridorGeom(room);
      (currentStairCorridors[ex.wall] ||= []).push(
        { rise, depth, outSign: fixed >= 0 ? 1 : -1, dir: stairDir(ex.type), offset: ex.offset });
    }
  }

  exitMeta = [];
  elevatorMeta = [];
  currentBuildingColliders = [];

  if(!room.outdoor){
    const wallTex = carMode ? makePlainWallTexture(room.color) : makeBrickTexture(room.color);
    // A car's two doors (one forward, panel of floor buttons; one back) are
    // placed by elevatorCarLayout, NOT by the exits' own per-wall layout --
    // otherwise exits spread across several walls each grow their own door +
    // panel (the reported bug: a 5-exit room became 3 doors). Computed once
    // here and consulted per wall below.
    const carLayout = carMode ? elevatorCarLayout(room) : null;
    for(const wall of ['north','south','east','west']){
      if(carMode){
        const back = carLayout.back;
        const isFwd = wall === carLayout.fwdWall && carLayout.floors.length > 0;
        const isBack = !!back && wall === back.wall;
        const doorOffset = isFwd ? carLayout.fwdOffset : isBack ? back.offset : null;
        const group = buildWallGroup(room.size, wall, doorOffset != null, doorOffset || 0, wallTex, null,
          { editable: true, surfaceAsset: wallAssetFor(roomKey, wall), doorOffsets: doorOffset != null ? [doorOffset] : [] });
        scene.add(group);
        if(doorOffset == null) continue;   // a plain wall (no door on it)
        const dKey = doorKey(wall, doorOffset);
        const doorAsset = doorAssetFor(roomKey, dKey) || defaultDoorAsset(roomKey, isBack);
        const box = doorTriggerBox(room.size, wall, doorOffset);
        const thru = WALL_OUT_NORMAL[wall];
        if(isFwd){
          const floors = carLayout.floors.map((fe, i) => {
            // each floor row carries the same "in front of a door" content a
            // normal door shows (doorPairContent): the destination room's name,
            // the move pair (opponent raised / response lowered), and that
            // room's signature head object -- so the panel reads like a
            // directory of doors, not a bare move list. The head object's own
            // listFallback is this car's own assigned list, indexed by floor
            // position -- an ordinary door gets the SOURCE lane's own list
            // this same way (continuationListItem); an elevator floor has no
            // lane, so it's this car's list directly (elevatorFloorListItem).
            const dc = doorPairContent(fe.target, fe.pair, elevatorFloorListItem(roomKey, i));
            return {
              ordinal: i + 1,
              label: fe.label || fe.target,
              name: roomNameFor(fe.target) || '',
              pair: dc.pair,                        // { opponent, response } move descriptors, or null
              objAsset: dc.asset || null,           // the room's head-object asset (has .image), or null
              objWord: dc.word || null,             // its placeholder word, if no image
              // "N (M%)" -- how often this exact floor has actually been taken
              // in the user's own games, same stat an ordinary door's own hint
              // shows (buildDoorHint) but an elevator floor never otherwise
              // gets, since it has no door hint of its own (the panel replaces
              // it). Only the "(M%)" tail is drawn (see makeElevatorPanelTexture).
              occurrence: fe.occurrence || null,
              target: fe.target,
              spawn: computeSpawnForExit(roomKey, room, fe)
            };
          });
          elevatorMeta.push({ box, thru, kind: 'forward', floors });
          for(const panel of buildElevatorPanels(room.size, wall, doorOffset, floors, roomKey)) scene.add(panel);
        } else {   // isBack
          elevatorMeta.push({ box, thru, kind: 'back', target: back.target, spawn: computeSpawnForExit(roomKey, room, back) });
          scene.add(buildExitSign(room.size, wall, doorOffset));
        }
        if(doorAsset) scene.add(buildDoorPanel(room.size, wall, doorOffset, doorAsset));
        if(editMode) scene.add(buildDoorMarker(room.size, wall, doorOffset, roomKey, dKey));
      } else {
        // gather EVERY exit on this wall. Ordinary rooms can carry several
        // doors on one wall (e.g. the user moved two exits to the same side,
        // or an import added one), so each one needs its own gap + panel +
        // trigger, and each stair its own walkable corridor (see stairGapAt).
        const wallExits = room.exits.filter(e => e.wall === wall);
        const ex0 = wallExits[0];
        const doorOffsets = wallExits.map(e => e.offset);
        const group = buildWallGroup(room.size, wall, !!ex0, ex0 ? ex0.offset : 0, wallTex, null,
          { editable: true, surfaceAsset: wallAssetFor(roomKey, wall), doorOffsets });
        scene.add(group);

        for(const ex of wallExits){
          const isStair = isStairType(ex.type);
          const dKey = doorKey(wall, ex.offset);
          // a locked door: a forward, ordinary (not stair/elevator) door whose
          // target has nothing further built past it -- see isRoomEmpty --
          // OR whose target doesn't exist AT ALL (!mergedRoom(ex.target)),
          // e.g. a cross-castle redirect whose target disappeared out from
          // under it (app.js's own repair for this is debounced, not
          // instant -- see computeSpawnForExit's matching doc comment).
          // isRoomEmpty itself deliberately does NOT treat a missing room
          // this way (an unregistered single-castle-preview target is
          // real, just not built THIS session) -- this is the other,
          // genuinely-gone case, checked separately rather than folded into
          // isRoomEmpty's own meaning. Room override wins, else the
          // locked-door building default (never the ordinary-door default
          // -- an unset locked default stays an open, unskinned gap rather
          // than silently looking like a normal door).
          const locked = !ex.back && !isStair && ex.type !== 'elevator' && (isRoomEmpty(ex.target) || !mergedRoom(ex.target));
          const doorAsset = doorAssetFor(roomKey, dKey)
            || (locked ? defaultLockedDoorAsset(roomKey) : defaultDoorAsset(roomKey, !!ex.back));
          // the back door's own physical slot (wall/offset/skin) is always
          // this room's static one, but a transposition room only ever gets
          // ONE such slot for however many real entrances it has -- where it
          // actually leads is the room the player walked in from THIS visit
          // (roomEnteredFrom), falling back to the static canonical parent
          // when there's no recorded visit yet (a fresh page load, a direct
          // "Jump to VR", etc). Forward doors are unaffected -- their target
          // is intrinsic to the door, never ambiguous.
          const navTarget = (ex.back && ROOMS[roomEnteredFrom[roomKey]]) ? roomEnteredFrom[roomKey] : ex.target;
          const spawn = computeSpawnForExit(roomKey, room, navTarget === ex.target ? ex : { ...ex, target: navTarget });
          const box = isStair ? stairTriggerBox(room, wall, ex.offset) : doorTriggerBox(room.size, wall, ex.offset);
          // a locked door gets no teleport trigger -- clampToRoom already keeps
          // an ordinary doorway solid right up to the wall plane (the trigger is
          // what normally lets you cross it before you'd hit that boundary), so
          // simply not registering one is enough to make it impassable.
          if(!locked) exitMeta.push({ box, thru: WALL_OUT_NORMAL[wall], target: navTarget, back: !!ex.back, spawn });
          if(ex.back) scene.add(buildExitSign(room.size, wall, ex.offset));
          if(doorAsset && !isStair) scene.add(buildDoorPanel(room.size, wall, ex.offset, doorAsset));
          // unskinned locked door: a floating lock icon in the open gap so it
          // still reads as locked before you've assigned (or defaulted) a skin
          // like a vault image -- once skinned, the icon steps aside for it.
          else if(locked) scene.add(buildLockedDoorIcon(room.size, wall, ex.offset));
          if(isStair) scene.add(buildStairCorridor(room, wall, ex.offset, wallAssetFor(roomKey, wall), roomKey, stairDir(ex.type)));
          // forward-door hint: name plaque above the door, and the move-pair +
          // object for the room beyond, to the left of the door. The pair is
          // hint-gated inside buildDoorPair; a filled object stays for self-test.
          if(hintsOn && !ex.back) scene.add(buildDoorHint(room.size, wall, ex.offset, ex.target, roomKey, ex.occurrence));
          if(!ex.back) scene.add(buildDoorPair(roomKey, room, wall, ex.offset, ex));
          if(editMode) scene.add(buildDoorMarker(room.size, wall, ex.offset, roomKey, dKey));
        }
      }
    }
    if(room.stairs) scene.add(buildStairs(room, roomKey));
    // this room's OWN name on the floor a little way in from the entrance --
    // hint-gated (same toggle as door hints/wall-list plaques) since it's a
    // memory-aid, not part of the room's permanent decor.
    if(hintsOn){
      const nameLabel = buildRoomNameFloorLabel(room, roomKey);
      if(nameLabel){ scene.add(nameLabel); floorLabels.push(nameLabel); }
    }
    if(room.label){
      let labelY;
      if(room.stairs){
        const { fixed } = wallSpan(room.size, room.label.wall);
        const floorY = floorHeightAt(room, fixed);
        labelY = floorY + (room.size.h - floorY) / 2;
      }
      scene.add(placeLabelOnWall(room.size, room.label.wall, room.label.text, null, labelY));
    }
    const furniture = placeFurniture(room);
    if(furniture) scene.add(furniture);
    buildSlots(room, roomKey, roomSlots(room, roomKey));
    if(hintsOn) buildWallListPlaques(room, roomKey);   // Phase 4: mnemonic-phrase plaques
  } else {
    // No surrounding wall: the outdoor area is open so multiple buildings can
    // sit on the street without a brick box hemming them in. Movement is still
    // bounded by clampToRoom (an invisible limit at the room's edges).
    (room.streetSigns || []).forEach((s, i) => {
      // Generated branch-street signs: a real green street sign on a post with
      // the cross street at 90 degrees. Not skinnable/movable (auto-laid-out).
      if(s.streetSign){
        const sign = buildStreetNameSign(s);
        sign.position.set(s.x, 0, s.z);
        scene.add(sign);
        // the system's opening-move tile, at ground level under the sign. Its
        // move/height/scale nudges persist in this room's slotXform, keyed per
        // system; base sits a touch into the side street so it clears the post.
        if(s.openingMove || s.openingImg || s.openingWord){
          const bbId = 'open-' + (s.lineId || i);
          const xf = slotXformFor(roomKey, bbId) || {};
          const base = { x: s.x + (s.side || 1) * 0.9, y: OPEN_TILE_HALF, z: s.z };
          // Black system with a prepared reply: the door-style opponent/response
          // pair composite (same billboard doors use) instead of the plain
          // single-move tile -- see systemsForWalk (app.js) for the asymmetry.
          const tile = s.replyPair ? buildMnemPairSprite(s.replyPair, xf.scale || 1) : buildOpeningMoveSprite(s, xf.scale || 1);
          tile.userData = { kind: 'accessory', slotId: bbId, doorBill: true, roomKey, base };
          tile.position.set(base.x + (xf.dx || 0), base.y + (xf.dy || 0), base.z + (xf.dz || 0));
          scene.add(tile);
        }
        return;
      }
      // Standalone street-name signs (not tied to any building) share the same
      // movable/skinnable 'sign' machinery as building lawn signs -- they just
      // need their own id namespace so they never collide with a buildingKey.
      const signId = `street:${i}`;
      const signAsset = signAssetFor(roomKey, signId);
      const off = signPosFor(roomKey, signId) || {};
      const signPos = { x: s.x + (off.dx || 0), z: s.z + (off.dz || 0) };
      const signGroup = buildGroundSign(s.text, signAsset);
      signGroup.position.set(signPos.x, 0, signPos.z);
      signGroup.userData = { kind: 'sign', roomKey, buildingKey: signId, basePos: { x: s.x, z: s.z } };
      scene.add(signGroup);
      if(editMode) scene.add(buildSignMarker(signPos, roomKey, signId, signAsset && signAsset.size));
    });
    // every building on this street gets its own exterior, door and sign
    for(const b of room.buildings){
      const targetRoom = mergedRoom(b.target);
      const buildingKey = b.target;
      const facadeAsset = buildingFacadeFor(roomKey, buildingKey);

      // A placed facade asset carries its own real-world size in meters; the
      // facade plane is built at that full size. The block behind it (brick
      // walls + roof) is deliberately built *smaller* -- 90% of the facade's
      // width and half its height -- like a movie-set flat: from the front
      // the facade fully covers the box (the box's roofline never peeks out
      // past the facade's edges, top or sides), so no separate "see-through"
      // alignment between the two shapes is needed. Side-on, the size
      // mismatch is visible, which is an accepted tradeoff for this loci
      // memory trainer (not a first-person walkthrough). With no override,
      // width and height both fall back to the static config size. Min
      // clamps keep the doorway from being squeezed out of the box (door is
      // DOOR_W wide, DOOR_H tall).
      const { axis: doorAxis } = wallSpan(b.size, b.doorWall);
      let size = b.size;
      let facadeWidth = doorAxis === 'x' ? b.size.w : b.size.d;
      let facadeHeight = b.size.h;
      let facadeDepth = 0;
      if(facadeAsset && facadeAsset.size){
        const fw = Math.max(facadeAsset.size.w || 0, DOOR_W + 0.4);
        const fh = Math.max(facadeAsset.size.h || 0, DOOR_H + 0.4);
        facadeDepth = facadeAsset.size.d || 0;
        // The walkable box (brick walls + door) is half the facade in every
        // dimension and buried inside the extruded slab -- it exists only to host
        // the door/trigger, not to be seen. Depth falls back to the static config
        // for a legacy flat facade (no extrusion depth authored).
        const boxW = Math.max(fw * 0.5, DOOR_W + 0.4);
        const boxH = Math.max(fh * 0.5, DOOR_H + 0.4);
        const boxD = Math.max((facadeDepth || b.size.d) * 0.5, 0.8);
        size = doorAxis === 'x' ? { w: boxW, d: boxD, h: boxH } : { w: boxD, d: boxW, h: boxH };
        facadeWidth = fw;
        facadeHeight = fh;
      }

      // block movement through this building's walls from the street -- only
      // its own door opening lets you through (the door's teleport trigger,
      // below, has a wider catch zone than this box so it always fires first).
      // The collider is also extended back to the room edge so you can't walk
      // around behind the building, where the movie-set box gives the fake away.
      currentBuildingColliders.push(
        sealBehindBuilding({ origin: b.origin, size, doorWall: b.doorWall, doorOffset: b.doorOffset }, room.size));

      const buildingTex = makeBrickTexture(b.color);
      for(const wall of ['north','south','east','west']){
        const hasDoor = wall === b.doorWall;
        scene.add(buildWallGroup(size, wall, hasDoor, hasDoor ? b.doorOffset : 0, buildingTex, b.origin));
      }
      scene.add(buildRoof(size, b.origin, 0x3a3a3a));
      if(b.sign){
        // Out on the lawn by the front door, like a museum / apartment-complex
        // entrance sign -- not mounted on the facade. Placed on the building's
        // Main-Street-facing side (toward x=0) so you reach it first walking up
        // the side street, and yawed partway toward Main so it greets you as you
        // approach. bSide: +1 white (east of Main), -1 black (west). The skin (if
        // any) is an override image stretched behind the name text -- see signAssetFor.
        const signAsset = signAssetFor(roomKey, buildingKey);
        const off = signPosFor(roomKey, buildingKey) || {};
        const bSide = Math.sign(b.origin.x) || 1;
        const signBase = { x: b.origin.x - bSide * (size.w/2 + 1.5), z: b.origin.z + size.d/2 + 1.6 };
        const signPos = { x: signBase.x + (off.dx || 0), z: signBase.z + (off.dz || 0) };
        const signGroup = buildGroundSign(b.sign, signAsset);
        signGroup.position.set(signPos.x, 0, signPos.z);
        signGroup.rotation.y = -bSide * Math.PI / 6;   // ~30°, partially facing Main Street
        // tag the whole sign so clicking any part of it selects the sign for
        // nudging (arrows) -- the gear icon then opens the skin picker.
        signGroup.userData = { kind: 'sign', roomKey, buildingKey, basePos: signBase };
        scene.add(signGroup);
        // edit-mode hotspot: a translucent panel over the sign so it reads as
        // editable even before it's clicked (same kind, so it routes the same).
        if(editMode) scene.add(buildSignMarker(signPos, roomKey, buildingKey, signAsset && signAsset.size));
      }

      // Movie-set facade: lay the image flat over the whole face (a single
      // un-tiled plane, no door-shaped cutout) so the front reads as one painted
      // board. Source is the placed facade asset's image, else the static
      // frontTexture file; until either resolves the procedural brick-with-
      // doorway wall above stays visible (no broken texture, just the fallback).
      const facadeSrc = facadeAsset ? facadeAsset.image : (b.frontTexture || null);
      if(facadeSrc && textureLoader){
        const doorWall = b.doorWall, origin = b.origin;
        const sizeForMount = size, mountW = facadeWidth, mountH = facadeHeight;
        if(facadeDepth > 0){
          // Extruded facade: the image's silhouette extruded into a slab, front
          // cap facing the street, side walls a flat sampled/picked color. The
          // brick box above is half-size and hidden inside this slab's depth.
          const group = buildExtrudedAsset({
            image: facadeSrc,
            size: { w: mountW, h: mountH, d: facadeDepth },
            sideColor: facadeAsset.sideColor
          });
          mountFacadeExtrusion(group, sizeForMount, doorWall, origin, facadeDepth, mountH, WALL_THICK/2 + 0.12);
          group.userData = { kind: 'facade', roomKey, buildingKey };
          scene.add(group);
        } else {
          // Legacy flat facade: a single un-tiled board over the whole face.
          const hasTransparency = !!(facadeAsset && facadeAsset.size);
          textureLoader.load(facadeSrc, (tex) => {
            if(buildGeneration !== myGeneration || !scene) return;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
            const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: hasTransparency });
            const facade = new THREE.Mesh(new THREE.PlaneGeometry(mountW, mountH), mat);
            mountOutward(sizeForMount, doorWall, 0, origin, facade, mountH/2, WALL_THICK/2 + 0.12);
            facade.userData = { kind: 'facade', roomKey, buildingKey };
            scene.add(facade);
          }, undefined, () => { /* source not available yet -- keep the procedural brick fallback */ });
        }
      }

      // edit-mode hotspot: click the front face to set / replace / remove its facade
      if(editMode) scene.add(buildFacadeMarker(size, b, roomKey, buildingKey, facadeWidth, facadeHeight));

      // front-yard turf: a tiled grass (or dead-grass) patch in front of the door
      const yardPatch = buildYardPatch(b, roomKey, buildingKey);
      if(yardPatch) scene.add(yardPatch);

      // yard landscaping: trees / bushes / flowers / bird baths flanking the door
      buildSlots(room, roomKey, yardSlots(b, buildingKey));
      // the entry room's move-pair + object, out here by the front door instead
      // of inside the foyer (its centre pair is suppressed in-room, below).
      scene.add(buildStreetEntryPair(roomKey, room, b, size));

      const spawn = doorSpawn(targetRoom.size, b.doorWall, b.doorOffset, null, true);
      // entering a building means walking TOWARD it -- the opposite of a room's
      // outward exit normal, so the player heads in through the front door.
      const bout = WALL_OUT_NORMAL[b.doorWall];
      exitMeta.push({
        box: doorTriggerBox(size, b.doorWall, b.doorOffset, b.origin),
        thru: { x: -bout.x, z: -bout.z },
        target: b.target,
        spawn
      });
    }
  }

  currentRoomKey = roomKey;
  if(selectedProp && selectedProp.roomKey === roomKey) attachSelectionVisuals();
  updateToolbar();   // wall-lists button visibility depends on the room having pairs
  refreshMiniBoard();   // update/hide the mini board if it's open and the room changed
}

// Called after the asset manager is closed while the walking tour is still
// open (e.g. opened on top via the in-world Assets button), so any
// added/edited assets show up immediately without re-entering the room by hand.
export async function refreshAssetsLive(){
  if(!scene) return; // tour isn't open
  await refreshAssetMap();
  await refreshObjectLists();
  clearMnemonicsCache(); _moveImgCache.clear();   // pick up any edited move images
  buildRoom(currentRoomKey);
}

// Jumps straight to roomKey in an ALREADY-OPEN VR session (e.g. "Jump to VR"
// from the digraph's room-info modal). Returns false -- without doing
// anything -- if VR isn't open, or if this session never registered the
// room (e.g. a Preview-Castle session that doesn't include the target
// castle); the caller falls back to (re)opening the main world with
// openThreeTest's startRoomKey opt in that case.
export function jumpToRoom(roomKey){
  if(!scene || !ROOMS[roomKey]) return false;
  enterRoom(roomKey, { x:0, z:0, yaw:0 });
  return true;
}

function enterRoom(roomKey, spawn, preserveYaw){
  // remember where we came in *before* building, so floor props can face it
  entryPoint = { x: spawn.x, z: spawn.z };
  const keepYaw = preserveYaw ? yaw : spawn.yaw;
  // each visit to an elevator car starts with no floor picked (like a real
  // elevator) -- clear any leftover selection from a previous visit before
  // rebuilding, so the panel doesn't show a stale button lit. A rebuild
  // that's NOT an entry (selectElevatorFloor's own buildRoom call, or any
  // other live-edit refresh) goes straight to buildRoom and skips this.
  delete elevatorSelectedFloor[roomKey];
  // a selected prop belongs to the room being LEFT -- since doors/elevators
  // now teleport in edit mode too (not just on foot to a fresh "Run VR"),
  // carrying it over would silently hijack arrow-key input into nudging an
  // object back in the old room instead of walking (nudgeSelected writes via
  // selectedProp.roomKey with no check it matches where you are), and leave
  // the gear-icon visuals pointing at now-disposed geometry.
  deselectProp();
  buildRoom(roomKey);
  pos.x = spawn.x; pos.z = spawn.z; yaw = keepYaw;
  teleportLockUntil = clock.getElapsedTime() + 0.6;
  // refresh the edit HUD/toolbar for the new room (indoor/outdoor wording,
  // room-geometry/wall-lists/memorize/decorated buttons) -- buildRoom itself
  // doesn't call this, and deselectProp only does when there was actually a
  // selection to clear.
  updateEditHud();
}

// finds the exit/elevator trigger (if any) whose box contains (x,z). `fwd`,
// when given, restricts an ordinary exit to firing only while facing enough
// into it (thru dot product > 0) -- the same distinction that stops backing
// up to a wall from immediately firing the door you just backed away from.
// Pass null for a deliberate action (a click, a jump landing) where facing
// doesn't matter -- tapping or jumping into a door already unambiguously
// means "go through", whichever way you happen to be looking.
function findDoorTrigger(x, z, fwd){
  const inBox = m => x >= m.box.minX && x <= m.box.maxX && z >= m.box.minZ && z <= m.box.maxZ
    && (!fwd || !m.thru || fwd.x*m.thru.x + fwd.z*m.thru.z > 0);
  return exitMeta.find(inBox) || elevatorMeta.find(inBox) || null;
}
// fires the room-change (or, for an elevator forward door with no floor
// picked yet, the "select a floor" toast) for a trigger findDoorTrigger
// matched -- shared by walking into a door, jumping into one, and clicking
// one. Returns true if it actually moved you into a new room.
function fireDoorTrigger(m){
  if(m.kind !== 'forward'){
    // an ordinary (non-elevator) FORWARD door crossing -- remember where the
    // player walked in from, so if the target has more than one real entrance
    // (a transposition), its own back door can send them back here
    // specifically rather than to whichever parent happened to be canonical.
    // Only a forward crossing counts: walking a BACK door (e.g. returning
    // from a room's own further child) must NOT overwrite the room being
    // returned TO with "entered from" the child just left -- that would hijack
    // its back door into leading somewhere nobody asked for. Elevators
    // (m.kind === 'back') keep their fixed single link -- not a transposition.
    if(m.kind == null && !m.back) roomEnteredFrom[m.target] = currentRoomKey;
    enterRoom(m.target, m.spawn, false); return true;
  }
  const ordinal = selectedElevatorOrdinal(currentRoomKey, m.floors);
  const dest = ordinal != null ? m.floors.find(f => f.ordinal === ordinal) : null;
  if(dest){ enterRoom(dest.target, dest.spawn, false); return true; }
  if(!elevatorBlockedToastShown){ showToast('Select a floor first'); elevatorBlockedToastShown = true; }
  return false;
}
// Jumping forward (spacebar) covers ground fast while testing/decorating --
// 10 m outdoors, 2 m indoors (mirrors the outdoor/indoor walk-speed split
// below), advanced in small steps rather than one leap straight to the
// target point so it can't skip clean over a door's trigger box (only ~2 m
// deep) or land inside a wall. Landing behavior matches a physical walk:
// stepping into a door's trigger box ends the jump AT that door's own
// destination spawn point, discarding whatever jump distance was left --
// not some arbitrary distance further into the new room -- and stepping
// into a wall (or a two-track divider, or a building outdoors) stops the
// jump right there, same as clampToRoom/clampBuildings/clampOutOfDivider
// would stop ordinary walking.
const JUMP_DIST_INDOOR = 2, JUMP_DIST_OUTDOOR = 10, JUMP_STEP = 0.25;
function jumpForward(){
  const room = mergedRoom(currentRoomKey);
  const dist = room.outdoor ? JUMP_DIST_OUTDOOR : JUMP_DIST_INDOOR;
  const fwd = cameraForwardVec();
  const steps = Math.max(1, Math.round(dist / JUMP_STEP));
  const stepDist = dist / steps;
  for(let i = 0; i < steps; i++){
    const nx = pos.x + fwd.x * stepDist, nz = pos.z + fwd.z * stepDist;
    let clamped = clampToRoom(room.size, nx, nz);
    if(room.outdoor) clamped = clampBuildings(clamped.x, clamped.z);
    if(room.twoTrack) clamped = clampOutOfDivider(room, clamped.x, clamped.z);
    const blocked = Math.abs(clamped.x - nx) > 1e-6 || Math.abs(clamped.z - nz) > 1e-6;
    pos.x = clamped.x; pos.z = clamped.z;
    if(clock.getElapsedTime() > teleportLockUntil){
      const m = findDoorTrigger(pos.x, pos.z, fwd);
      if(m){ fireDoorTrigger(m); return; }
    }
    if(blocked) return;
  }
}
function tick(){
  animHandle = requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);

  let turn = 0;
  if(keys['ArrowLeft']  || keys['a'] || keys['A']) turn += 1;
  if(keys['ArrowRight'] || keys['d'] || keys['D']) turn -= 1;

  let move = 0;
  if(keys['ArrowUp']   || keys['w'] || keys['W']) move += 1;
  if(keys['ArrowDown'] || keys['s'] || keys['S']) move -= 1;

  // strafe (sidestep without turning): q left, e right
  let strafe = 0;
  if(keys['q'] || keys['Q']) strafe -= 1;
  if(keys['e'] || keys['E']) strafe += 1;

  // touch joystick (mobile): x turns, y walks -- same axes as the keys above
  if(!inputLocked){ turn -= joyVec.x; move += joyVec.y; }
  turn = Math.max(-1, Math.min(1, turn));
  move = Math.max(-1, Math.min(1, move));
  strafe = Math.max(-1, Math.min(1, strafe));

  if(turn !== 0 && !inputLocked) yaw += turn * TURN_SPEED * dt;
  if((move !== 0 || strafe !== 0) && !inputLocked){
    const room = mergedRoom(currentRoomKey);
    // outdoors covers much more ground, so walk 50% faster out there; interiors
    // keep the base speed.
    const speed = room.outdoor ? MOVE_SPEED * 1.5 : MOVE_SPEED;
    // camera forward vector for rotation.y = yaw is (-sin(yaw), -cos(yaw)); the
    // right vector (for q/e strafing) is (cos(yaw), -sin(yaw)).
    pos.x += (-Math.sin(yaw) * move + Math.cos(yaw) * strafe) * speed * dt;
    pos.z += (-Math.cos(yaw) * move - Math.sin(yaw) * strafe) * speed * dt;
    let clamped = clampToRoom(room.size, pos.x, pos.z);
    if(room.outdoor) clamped = clampBuildings(clamped.x, clamped.z);
    if(room.twoTrack) clamped = clampOutOfDivider(room, clamped.x, clamped.z);
    pos.x = clamped.x; pos.z = clamped.z;
  }

  const curRoom = mergedRoom(currentRoomKey);
  // while a gizmo-eligible prop is selected, ease the camera up and tilt it
  // (see EDIT_TILT_PITCH/EDIT_TILT_LIFT's own comment) so the two horizontal
  // drag arrows are never viewed edge-on. Down for floor/moveObject/mnemonic
  // (eye-level-ish props); UP for ceiling instead, since those arrows sit
  // overhead -- tilting down would still view them edge-on from below. Wall
  // props are excluded: they only ever show ONE horizontal arrow (along the
  // wall), and facing a wall to select something on it already keeps that
  // arrow perpendicular to your sightline, so the degenerate case this tilt
  // exists for doesn't arise there. Lift is capped to whatever headroom the
  // current room's ceiling actually has, so a short room doesn't push the
  // camera through it.
  const gizmoTiltActive = editMode && !!selectedProp && GIZMO_KINDS.has(selectedProp.kind) && selectedProp.kind !== 'wall';
  const maxLift = Math.max(0, curRoom.size.h - EYE_HEIGHT - 0.3);
  const targetLift = gizmoTiltActive ? Math.min(EDIT_TILT_LIFT, maxLift) : 0;
  editLift += (targetLift - editLift) * Math.min(1, dt * 8);
  const eyeY = EYE_HEIGHT + floorHeightAtPos(curRoom, pos.x, pos.z) + editLift;
  camera.position.set(pos.x, eyeY, pos.z);
  // ease the pitch toward its target so peeking down a down-staircase (or
  // tilting for the gizmo) is smooth, not an instant snap. YXZ order keeps
  // this a clean yaw-then-pitch (FPS) look. Ceiling is a fixed angle up
  // rather than the same magnitude as the down-tilt: this app's generated
  // rooms commonly run 5-6m tall, so a modest 10 degrees (which works fine
  // for an eye-level/floor-ish prop only ~1-2m from the lifted eye height)
  // can leave a ceiling prop's gizmo well above the top of the screen
  // instead of just "a bit edge-on" -- aim toward the ceiling hang-point
  // itself (ceilingSlots always places it at the room's local (0,0)) and
  // clamp to a generous range so standing very close doesn't demand a
  // near-vertical, disorienting look.
  let targetPitch;
  if(!editMode){
    targetPitch = downStairPeekPitch(curRoom, pos.x, pos.z);
  } else if(gizmoTiltActive && selectedProp.kind === 'ceiling'){
    const horizDist = Math.max(1, Math.hypot(pos.x, pos.z));
    const upToCeiling = Math.atan2((curRoom.size.h - 0.3) - eyeY, horizDist);
    targetPitch = Math.max(EDIT_TILT_UP_MIN, Math.min(EDIT_TILT_UP_MAX, upToCeiling));
  } else if(gizmoTiltActive){
    targetPitch = EDIT_TILT_PITCH;
  } else {
    targetPitch = 0;
  }
  lookPitch += (targetPitch - lookPitch) * Math.min(1, dt * 8);
  camera.rotation.set(lookPitch, yaw, 0, 'YXZ');
  window.__threeTestState = { room: currentRoomKey, x: pos.x, z: pos.z, y: eyeY, yaw, pitch: lookPitch, editMode };

  // cylindrical billboards: rotate to face the camera horizontally each frame
  for(const b of billboards){
    b.rotation.y = Math.atan2(camera.position.x - b.position.x, camera.position.z - b.position.z);
  }

  // room-name floor labels: lie flat (local normal = world up) and spin
  // around that normal so they read right-side-up to the camera's CURRENT
  // position -- the floor-bound counterpart to the cylindrical billboards
  // above. Like a floor decal/rug read by someone standing over it and
  // looking down-and-forward, the text's "up" edge points AWAY from the
  // viewer (the far edge reads last), not toward them -- otherwise it's
  // upside down from the viewer's own vantage.
  for(const f of floorLabels){
    const awayFromCam = new THREE.Vector3(f.position.x - camera.position.x, 0, f.position.z - camera.position.z);
    if(awayFromCam.lengthSq() < 1e-6) continue;   // directly overhead -- keep the previous facing rather than divide by zero
    awayFromCam.normalize();
    const normal = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(awayFromCam, normal);
    f.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, awayFromCam, normal));
  }

  // gear icon tracks the selected prop's upper-right corner from the
  // camera's current viewing angle, so it reads as "upper right" from
  // wherever the player is standing
  if(selectionGear && selectionAnchor){
    const right = cameraRightVec();
    const margin = 0.18;
    selectionGear.position.set(
      selectionAnchor.center.x + right.x * (selectionAnchor.halfW + margin),
      selectionAnchor.center.y + selectionAnchor.halfH + margin,
      selectionAnchor.center.z + right.z * (selectionAnchor.halfW + margin)
    );
  }

  // Doors (and elevators) teleport in edit mode too -- staying blocked there
  // just confused users with no way to reach the next room short of exiting
  // edit mode first. Standing in a doorway to edit the wall beside it is
  // still safe: findDoorTrigger only fires on actually heading OUT through
  // the door, forward movement (move > 0) whose facing has a positive
  // component along the door's through direction -- not just standing in
  // the box. Without the facing check, backing up to a wall (which leaves
  // you parked inside the trigger box) and then nudging forward into the
  // room would fire the exit even though you're walking away from the door.
  // enterRoom clears any selected prop and refreshes the edit HUD, so edit
  // mode carries over cleanly into the new room instead of leaving stale
  // state behind.
  //
  // The reset below (the toast latch, once you're not in a forward
  // elevator door's box at all) runs every frame regardless of move
  // direction, so backing off and re-approaching prompts again.
  const inFwdBox = elevatorMeta.some(m => m.kind === 'forward'
    && pos.x >= m.box.minX && pos.x <= m.box.maxX && pos.z >= m.box.minZ && pos.z <= m.box.maxZ);
  if(!inFwdBox) elevatorBlockedToastShown = false;
  if(move > 0 && clock.getElapsedTime() > teleportLockUntil){
    const m = findDoorTrigger(pos.x, pos.z, cameraForwardVec());
    if(m) fireDoorTrigger(m);
  }

  renderer.render(scene, camera);
}

/* ---------- in-world layout editor: prop selection, nudge & scale ---------- */

// camera-relative unit vectors in the x/z ground plane, derived from `yaw`
// the same way tick()'s movement code does -- used so floor-prop nudges move
// "forward"/"right" from the player's current viewpoint.
function cameraForwardVec(){ return { x: -Math.sin(yaw), z: -Math.cos(yaw) }; }
function cameraRightVec(){ return { x: Math.cos(yaw), z: -Math.sin(yaw) }; }

function clampFloorXZ(size, x, z){
  const halfW = size.w/2 - 0.3, halfD = size.d/2 - 0.3;
  return { x: Math.max(-halfW, Math.min(halfW, x)), z: Math.max(-halfD, Math.min(halfD, z)) };
}

let gearMat = null;
function buildGearSprite(){
  if(!gearTexture){
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(20,20,20,0.85)';
    ctx.beginPath(); ctx.arc(32, 32, 30, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ffd400';
    for(let i = 0; i < 8; i++){
      ctx.save();
      ctx.translate(32, 32);
      ctx.rotate(i/8 * Math.PI*2);
      ctx.fillRect(-3, -30, 6, 11);
      ctx.restore();
    }
    ctx.beginPath(); ctx.arc(32, 32, 18, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath(); ctx.arc(32, 32, 9, 0, Math.PI*2); ctx.fill();
    gearTexture = new THREE.CanvasTexture(c);
  }
  if(!gearMat) gearMat = tagShared(new THREE.SpriteMaterial({ map: gearTexture, depthTest: false }));
  const sprite = new THREE.Sprite(gearMat);
  sprite.scale.set(0.35, 0.35, 1);
  return sprite;
}

// One draggable translate-gizmo arrow from `origin` along `dir` (a
// normalized world-space Vector3), tagged so onGizmoPointerDown recognizes
// it and knows which axis to drag along. Builds fresh geometry/material
// every call, same as the selection outline just below -- NOT cached/shared
// the way gearMat is (via tagShared): disposeSceneContents disposes every
// object's geometry unconditionally on a full room rebuild (tagShared only
// exempts materials), so a cached geometry instance still attached to a
// scene child when that runs would be left pointing at disposed GPU
// resources the next time a prop gets selected.
function buildGizmoArrow(origin, dir, axis){
  // transparent:true (even though fully opaque-colored) is required for
  // depthTest:false/renderOrder to actually win against something like a
  // door skin: three.js renders the ENTIRE opaque queue before the ENTIRE
  // transparent queue, regardless of renderOrder, and a door skin's own
  // material (makeDoorPanelMesh) IS transparent -- so an arrow left in the
  // (default) opaque bucket, even at renderOrder 999, still drew before the
  // door skin and was then painted over by it. Moving the arrow into the
  // transparent bucket too is what lets renderOrder actually decide who
  // draws last within it.
  const mat = new THREE.MeshBasicMaterial({ color: GIZMO_COLORS[axis], depthTest: false, transparent: true });
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(GIZMO_SHAFT_R, GIZMO_SHAFT_R, GIZMO_LEN - GIZMO_HEAD_LEN, 8), mat);
  shaft.position.y = (GIZMO_LEN - GIZMO_HEAD_LEN) / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(GIZMO_HEAD_R, GIZMO_HEAD_LEN, 10), mat);
  head.position.y = GIZMO_LEN - GIZMO_HEAD_LEN / 2;
  shaft.renderOrder = head.renderOrder = 999;   // draw last among transparent objects too, not just opaque ones
  group.add(shaft, head);
  // the geometry above is built pointing along +Y; rotate the group to point along `dir` instead
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  group.position.copy(origin);
  group.userData = { kind: 'xform-gizmo', axis, origin: origin.clone(), dir: dir.clone() };
  return group;
}

// finds the freshly-built accessory mesh for the current selection (buildRoom
// rebuilds the whole scene from scratch on every edit) and (re)adds its
// highlight outline + gear icon. Clears the selection if the prop is gone
// (e.g. it was just removed via the picker).
function attachSelectionVisuals(){
  if(!selectedProp) return;
  const isSign = selectedProp.kind === 'sign';
  let found = null;
  scene.traverse(o => {
    if(found || !o.userData) return;
    if(isSign){
      if(o.userData.kind === 'sign' && o.userData.buildingKey === selectedProp.buildingKey) found = o;
    } else if(o.userData.kind === 'accessory' && o.userData.slotId === selectedProp.slotId){
      found = o;
    }
  });
  if(!found){ selectedProp = null; updateEditHud(); return; }
  // a rebuilt door object gets fresh userData -- keep the selection's base/asset
  // in sync so rotation and re-placement use the current values.
  if(found.userData.doorObj){ selectedProp.base = found.userData.base; selectedProp.asset = found.userData.asset; }
  else if(found.userData.doorBill){ selectedProp.base = found.userData.base; }
  // a cylindrical billboard's mesh has its rotation.y driven every frame by
  // tick()'s own billboards loop (to face whichever way the camera currently
  // is), independent of the editor -- measuring its box AS-ROTATED gives a
  // diagonal, viewing-angle-dependent AABB (both x and z sides puffed out to
  // cover the rotated plane) instead of the card's own true w x h footprint,
  // which is what made the outline look "rotated wrong" from most angles.
  // Measuring with rotation zeroed (its stable, never-authored resting
  // orientation -- applyAccessoryTransform deliberately never sets rotation.y
  // on a billboard) gives the true footprint instead; a true THREE.Sprite
  // (mnemonic pair labels/plaques) never has its own rotation touched at
  // all, so this is a no-op for those.
  const isCylBillboard = billboards.includes(found);
  let box;
  if(isCylBillboard){
    const savedRotY = found.rotation.y;
    found.rotation.y = 0;
    found.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(found);
    found.rotation.y = savedRotY;
    found.updateMatrixWorld(true);
  } else {
    box = new THREE.Box3().setFromObject(found);
  }
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);

  const outline = new THREE.Mesh(
    new THREE.BoxGeometry(size.x + 0.04, size.y + 0.04, size.z + 0.04),
    // transparent:true so this competes in the transparent render queue
    // (where renderOrder actually applies) rather than the opaque one, which
    // three.js always draws first regardless of renderOrder -- see
    // buildGizmoArrow's own comment; a door skin's material is transparent,
    // so without this the outline could end up painted over by one too.
    new THREE.MeshBasicMaterial({ color: 0xffd400, wireframe: true, depthTest: false, transparent: true })
  );
  outline.renderOrder = 999;
  outline.position.copy(center);
  scene.add(outline);
  selectionOutline = outline;

  // mnemonic billboards aren't asset-based, so there's nothing for the gear
  // icon's picker to do -- skip it, the outline alone shows the selection.
  if(selectedProp.kind !== 'mnemonic'){
    const gear = buildGearSprite();
    gear.userData = isSign
      ? { kind: 'sign-gear', buildingKey: selectedProp.buildingKey }
      : { kind: 'prop-gear', slotId: selectedProp.slotId,
          // a door object's image lives on the target room, not this slot
          assetRoomKey: selectedProp.assetRoomKey, assetSlotId: selectedProp.assetSlotId };
    scene.add(gear);
    selectionGear = gear;
    selectionAnchor = { center: center.clone(), halfW: size.x/2, halfH: size.y/2 };
  }

  // phase-1 translate gizmo -- only the free-floating kinds (see GIZMO_KINDS'
  // own comment). Wall-relative (roomAxes), not camera-relative, so the
  // arrows don't move as you turn to look at the object from a different
  // angle -- see roomAxes' own comment for why. The whole gizmo is offset
  // toward the entrance and down (see GIZMO_FRONT_OFFSET/GIZMO_DROP's own
  // comment) so the object itself doesn't sit on top of the arrows.
  if(GIZMO_KINDS.has(selectedProp.kind)){
    const room = mergedRoom(selectedProp.roomKey);
    const { x: AX, z: AZ } = roomAxes(room);
    const origin = center.clone()
      .addScaledVector(new THREE.Vector3(-AZ.x, 0, -AZ.z), GIZMO_FRONT_OFFSET)
      .add(new THREE.Vector3(0, -GIZMO_DROP, 0));
    const arrows = [];
    if(selectedProp.kind === 'wall'){
      // exactly one horizontal DOF -- along the wall itself, whichever of
      // roomAxes' x/z that wall's own span runs on (wallSpan), matching
      // nudgeSelected's ArrowRight/Left exactly, no separate wall-facing
      // math needed. Tagged 'x'/'z' (not a distinct name) so
      // onGizmoPointerMove's generic axis math needs no wall-specific case
      // beyond branching on `kind` for dOffset vs dx/dz.
      const wallSlot = slotById(room, selectedProp.roomKey, selectedProp.slotId);
      if(wallSlot){
        const { axis } = wallSpan(room.size, wallSlot.wall);
        const dir = axis === 'x' ? new THREE.Vector3(AX.x, 0, AX.z) : new THREE.Vector3(AZ.x, 0, AZ.z);
        arrows.push(buildGizmoArrow(origin, dir, axis));
        // a "ground" wall piece (floor-standing, back against the wall) has
        // its height pinned at 0 -- see nudgeSelected's own `if(!ground)`
        // guard on ArrowUp/Down.
        if(!selectedProp.ground) arrows.push(buildGizmoArrow(origin, new THREE.Vector3(0, 1, 0), 'up'));
      }
    } else {
      arrows.push(
        buildGizmoArrow(origin, new THREE.Vector3(AX.x, 0, AX.z), 'x'),
        buildGizmoArrow(origin, new THREE.Vector3(AZ.x, 0, AZ.z), 'z'),
      );
      // 'floor'/'ceiling'/'sign' props have no vertical lift at all (see
      // onKeyDown's own h/l/PageUp/PageDown guard, and nudgeSelected's
      // ceiling/sign branches) -- keep the gizmo's degrees of freedom
      // exactly matching the keyboard's, rather than offering a drag the
      // keyboard can't do too.
      if(!['floor', 'ceiling', 'sign'].includes(selectedProp.kind)){
        arrows.push(buildGizmoArrow(origin, new THREE.Vector3(0, 1, 0), 'up'));
      }
    }
    arrows.forEach(a => scene.add(a));
    selectionGizmo = arrows;
  }
}

// explicit teardown for deselecting without a full room rebuild (buildRoom's
// scene.clear() already wipes these when a rebuild happens instead).
function removeSelectionVisuals(){
  if(selectionOutline){ scene.remove(selectionOutline); selectionOutline = null; }
  if(selectionGear){ scene.remove(selectionGear); selectionGear = null; }
  selectionGizmo.forEach(a => scene.remove(a));
  selectionGizmo = [];
  selectionAnchor = null;
}

function selectProp(roomKey, slotId){
  const slot = slotById(mergedRoom(roomKey), roomKey, slotId);
  if(!slot) return;
  removeSelectionVisuals();   // clear a prior selection's outline/gear before re-highlighting
  selectedProp = { roomKey, slotId, kind: slot.kind, ground: !!slot.ground };
  attachSelectionVisuals();
  updateEditHud();
}
// selects a door object for transform editing. Unlike selectProp it takes its
// base pos + shared-asset owner off the clicked mesh's userData (door objects
// live outside roomSlots). kind 'moveObject' so nudge/rotate/scale/height apply.
function selectDoorObj(ud){
  removeSelectionVisuals();
  selectedProp = { roomKey: ud.roomKey, slotId: ud.slotId, kind: 'moveObject', doorObj: true,
                   base: ud.base, asset: ud.asset, assetRoomKey: ud.assetRoomKey, assetSlotId: ud.assetSlotId };
  attachSelectionVisuals();
  updateEditHud();
}
// selects a door-side move-pair billboard for move/height/scale (kind 'mnemonic',
// so it floats free and has no asset gear -- same as the old in-room billboard).
function selectDoorBill(ud){
  removeSelectionVisuals();
  selectedProp = { roomKey: ud.roomKey, slotId: ud.slotId, kind: 'mnemonic', doorBill: true, base: ud.base };
  attachSelectionVisuals();
  updateEditHud();
}
function selectSign(roomKey, buildingKey){
  removeSelectionVisuals();   // clear a prior selection's outline/gear before re-highlighting
  selectedProp = { roomKey, kind: 'sign', buildingKey };
  attachSelectionVisuals();
  updateEditHud();
}
function deselectProp(){
  if(!selectedProp) return;
  selectedProp = null;
  removeSelectionVisuals();
  updateEditHud();
}

function openPropManager(roomKey, slotId){
  const slot = slotById(mergedRoom(roomKey), roomKey, slotId);
  openAssetPicker({
    allow: (slot && slot.allow) || PROP_TYPES, allowRemove: true,
    allowWord: true, currentWord: slotWordFor(roomKey, slotId),
    onClose: () => { inputLocked = false; },
    onPick: id => setSlotOverride(roomKey, slotId, id),
    onRemove: () => { deselectProp(); setSlotOverride(roomKey, slotId, null); },
    onWordApply: word => { deselectProp(); setSlotWordOverride(roomKey, slotId, word); }
  });
}

function openSignManager(roomKey, buildingKey){
  const current = signAssetFor(roomKey, buildingKey);
  openAssetPicker({
    allow: ['sign'], allowRemove: !!current,
    onClose: () => { inputLocked = false; },
    onPick: id => setSignOverride(roomKey, buildingKey, id),
    onRemove: () => setSignOverride(roomKey, buildingKey, null)
  });
}

// Opens the asset picker appropriate to the current selection (sign skin for a
// selected sign, prop asset otherwise). Shared by the gear icon, the Enter key
// and the touch "Change" button so all three stay in sync.
function openManagerForSelection(){
  if(!selectedProp) return;
  inputLocked = true;
  if(selectedProp.kind === 'sign') openSignManager(selectedProp.roomKey, selectedProp.buildingKey);
  else if(selectedProp.doorObj) openPropManager(selectedProp.assetRoomKey, selectedProp.assetSlotId);
  else openPropManager(selectedProp.roomKey, selectedProp.slotId);
}

// arrows nudge the selected prop 0.1m per press. Floor/mnemonic/sign props
// move along the room's own roomAxes (wall-relative, entrance-oriented --
// see roomAxes' own comment: ArrowRight/Left/Up/Down always mean the same
// physical direction relative to the room's entrance, regardless of which
// way you're facing); wall props move along the wall's own axes instead,
// since you're normally facing the wall you're editing -- up/down is true
// vertical either way, and ground (low) wall props only get left/right.
function nudgeSelected(key){
  if(!selectedProp) return;
  const { roomKey, slotId, kind, ground, buildingKey } = selectedProp;
  const room = mergedRoom(roomKey);
  const { x: AX, z: AZ } = roomAxes(room);

  // A building sign moves freely on the lawn (wall-relative, same convention
  // as floor props), clamped to the room bounds. Its offset persists in
  // r.signPos rather than the slot-xform store.
  if(kind === 'sign'){
    const cur = signPosFor(roomKey, buildingKey) || {};
    let dx = cur.dx || 0, dz = cur.dz || 0;
    if(key === 'ArrowRight'){ dx += AX.x * NUDGE_STEP; dz += AX.z * NUDGE_STEP; }
    if(key === 'ArrowLeft'){  dx -= AX.x * NUDGE_STEP; dz -= AX.z * NUDGE_STEP; }
    if(key === 'ArrowUp'){    dx += AZ.x * NUDGE_STEP; dz += AZ.z * NUDGE_STEP; }
    if(key === 'ArrowDown'){  dx -= AZ.x * NUDGE_STEP; dz -= AZ.z * NUDGE_STEP; }
    setSignPosLive(roomKey, buildingKey, { dx, dz });
    return;
  }

  // door objects/billboards aren't in roomSlots -- their base pos lives on
  // selectedProp instead, carried through here so the floor/mnemonic branches
  // below can bounds-clamp them exactly like a regular slot.
  const slot = selectedProp.doorObj
    ? { x: selectedProp.base.x, z: selectedProp.base.z, kind: 'moveObject' }
    : selectedProp.doorBill
      ? { x: selectedProp.base.x, z: selectedProp.base.z, kind: 'mnemonic' }
      : slotById(room, roomKey, slotId);
  if(!slot) return;
  const xform = Object.assign({}, slotXformFor(roomKey, slotId));

  if(kind === 'floor' || kind === 'moveObject'){
    // a move-object rests on the floor like a floor prop and nudges the same way
    // (wall-relative); a future leash will clamp it near its billboard.
    // A move-object can also be lifted off the floor with h/l (or PageUp/PageDown)
    // -- same vertical convention as a mnemonic billboard.
    let dx = xform.dx || 0, dz = xform.dz || 0, dy = xform.dy || 0;
    if(key === 'ArrowRight'){ dx += AX.x * NUDGE_STEP; dz += AX.z * NUDGE_STEP; }
    if(key === 'ArrowLeft'){  dx -= AX.x * NUDGE_STEP; dz -= AX.z * NUDGE_STEP; }
    if(key === 'ArrowUp'){    dx += AZ.x * NUDGE_STEP; dz += AZ.z * NUDGE_STEP; }
    if(key === 'ArrowDown'){  dx -= AZ.x * NUDGE_STEP; dz -= AZ.z * NUDGE_STEP; }
    if(key === 'PageUp'   || key === 'h' || key === 'H') dy += NUDGE_STEP;
    if(key === 'PageDown' || key === 'l' || key === 'L') dy -= NUDGE_STEP;
    const clamped = clampFloorXZ(room.size, slot.x + dx, slot.z + dz);
    xform.dx = clamped.x - slot.x;
    xform.dz = clamped.z - slot.z;
    xform.dy = Math.max(0, dy);   // can't sink below the floor
  } else if(kind === 'wall'){
    let dOffset = xform.dOffset || 0, dY = xform.dY || 0;
    if(key === 'ArrowRight') dOffset += NUDGE_STEP;
    if(key === 'ArrowLeft')  dOffset -= NUDGE_STEP;
    if(!ground){
      if(key === 'ArrowUp')   dY += NUDGE_STEP;
      if(key === 'ArrowDown') dY -= NUDGE_STEP;
    }
    const { half } = wallSpan(room.size, slot.wall);
    const maxOffset = half - 0.4;
    dOffset = Math.max(-maxOffset - slot.offset, Math.min(maxOffset - slot.offset, dOffset));
    xform.dOffset = dOffset;
    xform.dY = ground ? 0 : Math.max(0.3 - slot.y, Math.min(room.size.h - 0.3 - slot.y, dY));
  } else if(kind === 'mnemonic'){
    // floats free in the room rather than resting on the floor, so arrows move
    // it horizontally (wall-relative, same convention as floor props) and
    // PageUp/PageDown (or h/l, for keyboards without dedicated Page keys)
    // move it vertically -- a pure position change, the graphic itself isn't
    // stretched. Horizontally clamped to the room footprint (clampFloorXZ) so
    // it can't be nudged out through a wall -- same bound reconcileRoomBounds
    // enforces on room entry, kept consistent here too.
    let dx = xform.dx || 0, dz = xform.dz || 0, dy = xform.dy || 0;
    if(key === 'ArrowRight'){ dx += AX.x * NUDGE_STEP; dz += AX.z * NUDGE_STEP; }
    if(key === 'ArrowLeft'){  dx -= AX.x * NUDGE_STEP; dz -= AX.z * NUDGE_STEP; }
    if(key === 'ArrowUp'){    dx += AZ.x * NUDGE_STEP; dz += AZ.z * NUDGE_STEP; }
    if(key === 'ArrowDown'){  dx -= AZ.x * NUDGE_STEP; dz -= AZ.z * NUDGE_STEP; }
    if(key === 'PageUp'   || key === 'h' || key === 'H') dy += NUDGE_STEP;
    if(key === 'PageDown' || key === 'l' || key === 'L') dy -= NUDGE_STEP;
    const clamped = clampFloorXZ(room.size, slot.x + dx, slot.z + dz);
    xform.dx = clamped.x - slot.x;
    xform.dz = clamped.z - slot.z;
    xform.dy = dy;
  } else if(kind === 'ceiling'){
    // hangs at a fixed drop from the ceiling -- no vertical nudge at all
    // (height is always room.size.h-derived) -- but slides in the ceiling's
    // own horizontal plane just like a floor prop (wall-relative).
    let dx = xform.dx || 0, dz = xform.dz || 0;
    if(key === 'ArrowRight'){ dx += AX.x * NUDGE_STEP; dz += AX.z * NUDGE_STEP; }
    if(key === 'ArrowLeft'){  dx -= AX.x * NUDGE_STEP; dz -= AX.z * NUDGE_STEP; }
    if(key === 'ArrowUp'){    dx += AZ.x * NUDGE_STEP; dz += AZ.z * NUDGE_STEP; }
    if(key === 'ArrowDown'){  dx -= AZ.x * NUDGE_STEP; dz -= AZ.z * NUDGE_STEP; }
    const clamped = clampFloorXZ(room.size, slot.x + dx, slot.z + dz);
    xform.dx = clamped.x - slot.x;
    xform.dz = clamped.z - slot.z;
  } else {
    return; // stair surface or other non-nudgeable kind
  }
  setSlotXformLive(roomKey, slotId, xform);
}

// ---------- translate gizmo: mouse/touch drag along one axis ----------
// The plane a drag along `axisDir` (through `origin`) projects the mouse
// onto: contains the axis line, oriented to face the camera as directly as
// possible (normal = the camera-to-origin vector with its along-axis
// component removed). Facing the camera keeps the camera's ray as far from
// parallel-to-the-plane as the geometry allows, which matters because a
// *purely horizontal* plane (the naive choice for the x/z axes)
// degenerates whenever the camera's eye height happens to match the plane's
// height exactly -- edit-mode walking keeps the camera level and props are
// routinely placed at that same eye height, so that coincidence is common,
// not rare, and it isn't just "no intersection": THREE.Ray.intersectPlane's
// zero-denominator branch returns distance 0 (the ray already lies in the
// plane), which silently pins the drag to the camera's own position every
// frame regardless of mouse movement. A camera-facing plane sidesteps this
// for any axis, including the vertical one the old vertical-only version of
// this function handled.
function axisDragPlane(origin, axisDir){
  const eye = camera.position.clone().sub(origin);
  const normal = eye.sub(axisDir.clone().multiplyScalar(eye.dot(axisDir)));
  if(normal.lengthSq() < 1e-6){
    // camera sits (almost) exactly on the axis line through origin -- any
    // plane containing the axis works equally badly/well, so just pick one
    // via an arbitrary companion vector not parallel to the axis.
    const helper = Math.abs(axisDir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    normal.copy(helper).sub(axisDir.clone().multiplyScalar(helper.dot(axisDir)));
  }
  normal.normalize();
  return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
}

// Starts a drag if the pointerdown landed on one of the current selection's
// gizmo arrows. Captures everything nudgeSelected would also need (room,
// slot, starting xform) plus the axis/plane the drag will project the mouse
// onto, so onGizmoPointerMove never has to re-resolve any of it mid-drag.
function onGizmoPointerDown(e){
  if(inputLocked || !raycaster || !editMode || !selectedProp || !selectionGizmo.length) return;
  // belt-and-braces: a previous drag should always have ended itself via
  // onGizmoPointerEnd (pointerup or pointercancel), but force it closed here
  // too rather than let a fresh drag start on top of stale state if it
  // somehow didn't.
  if(gizmoDrag) onGizmoPointerEnd({ pointerId: gizmoDrag.pointerId });
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(selectionGizmo, true);
  if(!hits.length) return;
  const ud = findInteractive(hits[0].object);
  if(!ud || ud.kind !== 'xform-gizmo') return;
  e.preventDefault();
  e.stopPropagation();
  // whatever mouseup eventually follows this must NOT also reach
  // onCanvasClick's own raycast -- it would reselect/deselect based on
  // whatever's behind the arrow the user actually meant to grab.
  suppressNextCanvasClick = true;

  const { roomKey, slotId, kind, buildingKey } = selectedProp;
  const room = mergedRoom(roomKey);
  let slot;
  if(kind === 'sign'){
    // a sign has no roomSlots entry at all -- its base pos rides on the
    // built mesh's own userData (see selectSign/setSignPosLive), keyed by
    // buildingKey rather than a slotId.
    let signObj = null;
    scene.traverse(o => { if(!signObj && o.userData && o.userData.kind === 'sign' && o.userData.buildingKey === buildingKey) signObj = o; });
    slot = (signObj && signObj.userData.basePos) ? { x: signObj.userData.basePos.x, z: signObj.userData.basePos.z } : null;
  } else {
    slot = (selectedProp.doorObj || selectedProp.doorBill)
      ? { x: selectedProp.base.x, z: selectedProp.base.z }
      : slotById(room, roomKey, slotId);
  }
  if(!room || !slot) return;
  const cur = (kind === 'sign' ? signPosFor(roomKey, buildingKey) : slotXformFor(roomKey, slotId)) || {};
  // a wall prop's position is dOffset (along the wall)/dY (height), not
  // dx/dz/dy -- see nudgeSelected's own 'wall' branch.
  const startXform = kind === 'wall'
    ? { dOffset: cur.dOffset || 0, dY: cur.dY || 0 }
    : { dx: cur.dx || 0, dz: cur.dz || 0, dy: cur.dy || 0 };
  const axisDir = ud.dir.clone();
  const axisOrigin = ud.origin.clone();
  const plane = axisDragPlane(axisOrigin, axisDir);

  // pointer capture pins this pointer's future events to the canvas (and thus
  // still bubbling up to these window listeners) even if the finger drifts
  // off the canvas mid-drag -- without it, a touch drag can lose tracking
  // partway through with no pointerup ever firing at all. pointerId is kept
  // so a second, unrelated touch (e.g. a stray finger) during the drag can't
  // be mistaken for this one's move/end.
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch(_){}
  gizmoDrag = { axis: ud.axis, roomKey, slotId, kind, buildingKey, room, slot, startXform, axisDir, axisOrigin, plane, pointerId: e.pointerId };
  window.addEventListener('pointermove', onGizmoPointerMove);
  window.addEventListener('pointerup', onGizmoPointerEnd);
  // a touch drag that the OS decides to interrupt (e.g. an incoming
  // notification, or -- pre touch-action:none -- a scroll takeover) fires
  // pointercancel instead of pointerup; without also ending the drag here,
  // gizmoDrag is left stuck non-null and the still-registered pointermove
  // listener keeps applying every subsequent pointer move anywhere on the
  // page (window-level) to this now-stale room/slot, including after
  // walking away to a different room -- the reported "arrows throw me clean
  // out of VR" bug traced back to exactly this leak.
  window.addEventListener('pointercancel', onGizmoPointerEnd);
}

// Re-raycasts the CURRENT mouse position against the axis's plane (captured
// at drag start) and reads off how far the intersection has moved along the
// axis from where the drag began -- i.e. the object's new position is
// wherever the axis line comes closest to the cursor, the same "attached to
// the cursor" feel a real gizmo drag is supposed to have, not an incremental
// delta that could drift from the pointer over a long drag.
function onGizmoPointerMove(e){
  if(!gizmoDrag || e.pointerId !== gizmoDrag.pointerId) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const { axis, roomKey, slotId, kind, buildingKey, room, slot, startXform, axisDir, axisOrigin, plane } = gizmoDrag;
  const hitPoint = new THREE.Vector3();
  if(!raycaster.ray.intersectPlane(plane, hitPoint)) return;   // ray parallel to the plane this frame -- leave position as-is
  const t = hitPoint.clone().sub(axisOrigin).dot(axisDir);

  if(kind === 'sign'){
    // signs persist via signPosFor/setSignPosLive (dx/dz only, keyed by
    // buildingKey), not the slotXform store -- see nudgeSelected's own
    // 'sign' branch. No 'up' arrow ever exists for a sign (see
    // attachSelectionVisuals), so axis is always 'x' or 'z' here.
    const dx = startXform.dx + axisDir.x * t, dz = startXform.dz + axisDir.z * t;
    const clamped = clampFloorXZ(room.size, slot.x + dx, slot.z + dz);
    setSignPosLive(roomKey, buildingKey, { dx: clamped.x - slot.x, dz: clamped.z - slot.z });
    return;
  }

  const xform = Object.assign({}, slotXformFor(roomKey, slotId));
  if(kind === 'wall'){
    // dOffset (along the wall)/dY (height), not dx/dz/dy -- see
    // nudgeSelected's own 'wall' branch, whose clamps this mirrors exactly.
    if(axis === 'up'){
      const dY = startXform.dY + t;
      xform.dY = Math.max(0.3 - slot.y, Math.min(room.size.h - 0.3 - slot.y, dY));
    } else {
      const { half } = wallSpan(room.size, slot.wall);
      const maxOffset = half - 0.4;
      const dOffset = Math.max(-maxOffset - slot.offset, Math.min(maxOffset - slot.offset, startXform.dOffset + t));
      xform.dOffset = dOffset;
    }
  } else if(axis === 'up'){
    let dy = startXform.dy + t;
    if(kind === 'moveObject') dy = Math.max(0, dy);   // can't sink below the floor -- same rule as nudgeSelected's PageDown
    xform.dy = dy;
  } else {
    const dx = startXform.dx + axisDir.x * t, dz = startXform.dz + axisDir.z * t;
    const clamped = clampFloorXZ(room.size, slot.x + dx, slot.z + dz);
    xform.dx = clamped.x - slot.x;
    xform.dz = clamped.z - slot.z;
  }
  setSlotXformLive(roomKey, slotId, xform);
}

// Shared cleanup for both a normal release (pointerup) and an OS-interrupted
// drag (pointercancel, e.g. an incoming touch gesture the browser decides to
// take over despite touch-action:none) -- either one must fully end the drag
// so gizmoDrag never outlives its pointer (see onGizmoPointerDown's own
// comment on the leak that caused).
function onGizmoPointerEnd(e){
  if(gizmoDrag && e.pointerId !== gizmoDrag.pointerId) return;
  window.removeEventListener('pointermove', onGizmoPointerMove);
  window.removeEventListener('pointerup', onGizmoPointerEnd);
  window.removeEventListener('pointercancel', onGizmoPointerEnd);
  if(gizmoDrag){
    try { renderer.domElement.releasePointerCapture(gizmoDrag.pointerId); } catch(_){}
  }
  gizmoDrag = null;
}

// the selected prop's current resize as a whole-number percent of its default
// size (100%), or null for signs (fixed-size, no scaling).
function selectionScalePct(){
  if(!selectedProp || selectedProp.kind === 'sign') return null;
  const x = slotXformFor(selectedProp.roomKey, selectedProp.slotId);
  return Math.round(((x && x.scale) || 1) * 100);
}
function scaleSelected(factor){
  if(!selectedProp || selectedProp.kind === 'sign') return; // signs are fixed-size
  const { roomKey, slotId } = selectedProp;
  const xform = Object.assign({}, slotXformFor(roomKey, slotId));
  xform.scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, (xform.scale || 1) * factor));
  setSlotXformLive(roomKey, slotId, xform);
  updateEditHud();   // refresh the "Resize: NN%" readout live as it changes
}

// rotate a free-standing extruded floor prop about the vertical axis, dir = +1
// clockwise (viewed from above) / -1 counter-clockwise. Persisted as a delta
// off the fixed default orientation. Wall-mounted props face their wall and
// billboards face the camera, so neither rotates.
const ROT_STEP = Math.PI / 12;   // 15 degrees per press
function rotateSelected(dir){
  if(!selectedProp || (selectedProp.kind !== 'floor' && selectedProp.kind !== 'moveObject')) return;
  const { roomKey, slotId } = selectedProp;
  const asset = selectedProp.doorObj ? selectedProp.asset : slotAssetFor(roomKey, slotId);
  if(!asset || asset.type !== 'extruded') return;
  const xform = Object.assign({}, slotXformFor(roomKey, slotId));
  xform.dYaw = (xform.dYaw || 0) - dir * ROT_STEP;   // clockwise from above = negative yaw
  setSlotXformLive(roomKey, slotId, xform);
}

/* ---------- in-world layout editor: click handling ---------- */
// "background" click targets (a room/building surface): a foreground prop sitting
// on one of these should win a near-tied click (see onCanvasClick).
const SURFACE_KINDS = new Set(['floor', 'wall', 'ceiling-surface', 'stair-surface', 'yard', 'facade']);
function findInteractive(obj){
  while(obj){
    if(obj.userData && obj.userData.kind) return obj.userData;
    obj = obj.parent;
  }
  return null;
}

// walk-mode click: the only interactive thing while walking (not editing) is
// an elevator car's floor panel -- clicking a row selects it (highlighted on
// the panel), so walking through the forward door then teleports straight
// there (see tick()'s elevator block). Anything else is a plain look/no-op.
function handleWalkClick(e){
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  const hit = hits[0];
  if(!hit) return;
  if(hit.uv && hit.object.userData && hit.object.userData.kind === 'elevator-panel'){
    selectElevatorFloor(hit.object.userData, hit.uv);
    return;
  }
  // tapping a door (its skin, frame, name plaque, or locked-door icon --
  // anything at/near the doorway) walks straight through it, landing at the
  // same destination spawn a physical walk-up would reach. Matched by the
  // click's own WORLD point falling inside that door's trigger box (the
  // same boxes tick()'s forward-walk check uses) rather than by hit-testing
  // a specific mesh kind, and with no facing requirement (fwd=null) -- a
  // deliberate click already means "go through", whichever way you're
  // currently looking.
  if(clock.getElapsedTime() > teleportLockUntil){
    const m = findDoorTrigger(hit.point.x, hit.point.z, null);
    if(m) fireDoorTrigger(m);
  }
}

// maps the click's UV (three.js PlaneGeometry: v=1 at top) to the row it
// landed in, using the same canvas geometry makeElevatorPanelTexture draws
// with (ELEV_PAD_PX/ELEV_ROW_PX) -- then records the pick and rebuilds the
// room so the panel redraws highlighted. A full buildRoom is heavier than a
// bare texture patch, but this fires on a single discrete click (not a drag),
// and matches every other live-edit path in this file.
function selectElevatorFloor(panelUd, uv){
  const { roomKey, floors } = panelUd;
  const canvasH = Math.max(ELEV_ROW_PX, ELEV_ROW_PX * floors.length + ELEV_PAD_PX * 2);
  const yFromTop = (1 - uv.y) * canvasH;
  const idx = Math.floor((yFromTop - ELEV_PAD_PX) / ELEV_ROW_PX);
  if(idx < 0 || idx >= floors.length) return;   // clicked the panel's border/margin
  elevatorSelectedFloor[roomKey] = floors[idx].ordinal;
  buildRoom(roomKey);
}

function onCanvasClick(e){
  // a click that just finished a gizmo-arrow drag (or a plain click on one
  // with no movement) already did its job in onGizmoPointerDown/End -- don't
  // also reselect/deselect based on whatever's behind the arrow.
  if(suppressNextCanvasClick){ suppressNextCanvasClick = false; return; }
  if(inputLocked || !raycaster) return;
  if(!editMode){ handleWalkClick(e); return; }
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  // Pick priority: a selection gear (renders on top, depthTest off) wins from
  // anywhere; otherwise a prop/object beats a background SURFACE it's sitting on
  // when they're at the same spot -- a flat prop like a rug is ~coplanar with the
  // floor/yard, so the nearest hit alone would grab the grass instead of the rug.
  // A prop only wins if it's within a small tolerance of the nearest hit, so
  // clicking open ground (with some distant prop farther along the ray) still
  // targets the ground.
  const PICK_TOL = 0.6;
  let gearUd = null, firstUd = null, firstDist = 0, propUd = null, propDist = 0;
  for(const hit of hits){
    const ud = findInteractive(hit.object);
    if(!ud) continue;
    if(ud.kind === 'prop-gear' || ud.kind === 'sign-gear'){ gearUd = ud; break; }
    if(!firstUd){ firstUd = ud; firstDist = hit.distance; }
    if(!propUd && !SURFACE_KINDS.has(ud.kind)){ propUd = ud; propDist = hit.distance; }
  }
  const ud = gearUd
    || (propUd && propDist <= firstDist + PICK_TOL ? propUd : firstUd);
  if(ud){ handleEditTarget(ud); return; }
  // clicked nothing interactive (e.g. open floor/sky past everything) --
  // treat it as "click away" and drop the current selection, if any
  if(selectedProp) deselectProp();
}

function handleEditTarget(ud){
  const roomKey = currentRoomKey;

  if(ud.kind === 'prop-gear'){
    inputLocked = true;
    // a door object's image lives on the target room (ud.assetRoomKey), not this slot
    if(ud.assetRoomKey) openPropManager(ud.assetRoomKey, ud.assetSlotId);
    else openPropManager(roomKey, ud.slotId);
    return;
  }
  if(ud.kind === 'accessory'){
    // door object / door billboard route to their own selection (base pos on
    // userData -- they have no roomSlots entry to look up)
    if(ud.doorObj || ud.doorBill){
      if(selectedProp && selectedProp.slotId === ud.slotId) deselectProp();
      else (ud.doorObj ? selectDoorObj : selectDoorBill)(ud);
      return;
    }
    if(selectedProp && selectedProp.slotId === ud.slotId) deselectProp();
    else selectProp(roomKey, ud.slotId);
    return;
  }
  // an EMPTY door object belongs to the room BEYOND it (ud.ownerRoomKey); clicking
  // assigns its shared image there. (A filled one is an 'accessory' + doorObj,
  // handled above, and is selectable for position/rotation/scale/height.)
  if(ud.kind === 'door-obj'){
    inputLocked = true;
    const owner = ud.ownerRoomKey;
    const current = slotAssetFor(owner, ud.slotId);
    // allowRemove must also cover a label-only override (no asset), or Remove
    // never shows and a manually-typed word can't be cleared at all.
    openAssetPicker({
      allow: ud.allow || PROP_TYPES, allowRemove: !!(current || slotWordFor(owner, ud.slotId)),
      allowWord: true, currentWord: slotWordFor(owner, ud.slotId),
      onClose: () => { inputLocked = false; },
      onPick: id => setSlotOverride(owner, ud.slotId, id),
      onRemove: () => setSlotOverride(owner, ud.slotId, null),
      onWordApply: word => setSlotWordOverride(owner, ud.slotId, word)
    });
    return;
  }
  if(ud.kind === 'sign'){
    if(selectedProp && selectedProp.kind === 'sign' && selectedProp.buildingKey === ud.buildingKey) deselectProp();
    else selectSign(ud.roomKey, ud.buildingKey);
    return;
  }
  if(ud.kind === 'sign-gear'){
    inputLocked = true;
    openSignManager(roomKey, ud.buildingKey);
    return;
  }
  if(selectedProp){ deselectProp(); return; }

  inputLocked = true;
  const onClose = () => { inputLocked = false; };
  if(ud.kind === 'floor'){
    openAssetPicker({
      allow: ['surface'], allowColor: true, onClose, ...surfacePickerExtras(roomKey, 'floor', null, floorAssetFor(roomKey)),
      onPick: id => setFloorOverride(roomKey, id),
      onRemove: () => setFloorOverride(roomKey, null),
      onTintPick: hex => setSurfaceTint(roomKey, 'floor', null, hex),
      onTintRemove: () => setSurfaceTint(roomKey, 'floor', null, null)
    });
  } else if(ud.kind === 'wall'){
    openAssetPicker({
      allow: ['surface'], allowColor: true, onClose, ...surfacePickerExtras(roomKey, 'wall', ud.wall, wallAssetFor(roomKey, ud.wall)),
      onPick: id => setWallOverride(roomKey, ud.wall, id),
      onRemove: () => setWallOverride(roomKey, ud.wall, null),
      onTintPick: hex => setSurfaceTint(roomKey, 'wall', ud.wall, hex),
      onTintRemove: () => setSurfaceTint(roomKey, 'wall', ud.wall, null)
    });
  } else if(ud.kind === 'ceiling-surface'){
    openAssetPicker({
      allow: ['surface'], allowColor: true, onClose, ...surfacePickerExtras(roomKey, 'ceiling', null, ceilingAssetFor(roomKey)),
      onPick: id => setCeilingOverride(roomKey, id),
      onRemove: () => setCeilingOverride(roomKey, null),
      onTintPick: hex => setSurfaceTint(roomKey, 'ceiling', null, hex),
      onTintRemove: () => setSurfaceTint(roomKey, 'ceiling', null, null)
    });
  } else if(ud.kind === 'stair-surface'){
    openAssetPicker({
      allow: ['surface'], allowColor: true, onClose, ...surfacePickerExtras(roomKey, 'stair', null, stairAssetFor(roomKey)),
      onPick: id => setStairOverride(roomKey, id),
      onRemove: () => setStairOverride(roomKey, null),
      onTintPick: hex => setSurfaceTint(roomKey, 'stair', null, hex),
      onTintRemove: () => setSurfaceTint(roomKey, 'stair', null, null)
    });
  } else if(ud.kind === 'slot'){
    openAssetPicker({
      allow: ud.allow, onClose,
      allowWord: true, currentWord: slotWordFor(roomKey, ud.slotId),
      onPick: id => setSlotOverride(roomKey, ud.slotId, id),
      onWordApply: word => setSlotWordOverride(roomKey, ud.slotId, word)
    });
  } else if(ud.kind === 'facade'){
    const current = buildingFacadeFor(ud.roomKey, ud.buildingKey);
    openAssetPicker({
      allow: ['facade'], allowRemove: !!current, onClose,
      onPick: id => setBuildingFacadeOverride(ud.roomKey, ud.buildingKey, id),
      onRemove: () => setBuildingFacadeOverride(ud.roomKey, ud.buildingKey, null)
    });
  } else if(ud.kind === 'yard'){
    const current = yardAssetFor(ud.roomKey, ud.buildingKey);
    openAssetPicker({
      allow: ['surface'], allowRemove: !!current, onClose,
      onPick: id => setYardOverride(ud.roomKey, ud.buildingKey, id),
      onRemove: () => setYardOverride(ud.roomKey, ud.buildingKey, null)
    });
  } else if(ud.kind === 'door'){
    const room = mergedRoom(ud.roomKey);
    const ex = (room.exits || []).find(e => doorKey(e.wall, e.offset) === ud.doorKey);
    const isExit = !!(ex && ex.back);
    const locked = !!(ex && !ex.back && isRoomEmpty(ex.target));
    const override = doorAssetFor(ud.roomKey, ud.doorKey);     // raw override (asset or null)
    const def = locked ? defaultLockedDoorAsset(ud.roomKey) : defaultDoorAsset(ud.roomKey, isExit);
    const eff = override || def;
    openAssetPicker({
      allow: ['door'], onClose,
      allowRemove: !!override,
      currentId: (eff && eff.id) || null,
      currentSource: override ? 'room' : (eff ? 'default' : null),
      defaultExists: !!def,
      // a locked door's skin is offered as this castle's locked-door default
      // right away (confirm), rather than requiring the separate Room
      // Geometry "make default" step every other door category needs --
      // dead-end doors are usually meant to share one look (e.g. a vault)
      // castle-wide, so this is the common case, not the exception.
      onPick: id => {
        setDoorOverride(ud.roomKey, ud.doorKey, id);
        if(locked && id && confirm('Make this the locked door default for this building?')){
          setLockedDoorBuildingDefault(ud.roomKey, id);
          persistLayout();
          buildRoom(currentRoomKey);
        }
      },
      onRemove: () => setDoorOverride(ud.roomKey, ud.doorKey, null)
    });
  } else if(ud.kind === 'dead-end'){
    // the "no continuation" sign on a room with no forward exit at all --
    // see deadEndAssetFor. No building-level default tier (unlike ordinary/
    // locked doors): this is meant for occasional per-room custom skins to
    // make a specific dead end more memorable, not a castle-wide restyle.
    const override = deadEndAssetFor(ud.roomKey, ud.track);
    openAssetPicker({
      allow: ['door'], onClose,
      allowRemove: !!override,
      currentId: (override && override.id) || null,
      currentSource: override ? 'room' : null,
      onPick: id => setDeadEndOverride(ud.roomKey, id, ud.track),
      onRemove: () => setDeadEndOverride(ud.roomKey, null, ud.track)
    });
  }
}

// picker extras for a room surface: whether a real per-room override exists
// (so Remove is meaningful), the currently-shown asset and whether it comes
// from this room or the inherited building default, for the picker's labels.
function surfacePickerExtras(roomKey, kind, wall, effAsset){
  const override = surfaceOverrideId(roomKey, kind, wall);
  let def;
  if(kind === 'wall'){
    const d = buildingDefaults(roomKey);
    def = d && d.walls ? (d.walls[wallRelative(entranceWall(mergedRoom(roomKey)), wall)] || null) : null;
  } else {
    def = defaultFieldId(roomKey, kind === 'stair' ? 'stairSurface' : kind);
  }
  return {
    allowRemove: !!override,
    currentId: (effAsset && effAsset.id) || null,
    currentSource: override ? 'room' : (effAsset ? 'default' : null),
    defaultExists: !!def,
    allowTint: true,
    currentTint: (effAsset && effAsset.tint) || null
  };
}

function updateEditHud(){
  updateToolbar();
  updateEditTouchControls();
  if(!editHud) return;
  if(selectedProp){
    // current resize relative to the prop's default (100%), shown so the user
    // can read off where they are; signs are fixed-size so they have none.
    const pct = selectionScalePct();
    const resize = pct != null ? `  ·  Resize: ${pct}%` : '';
    editHud.textContent = (selectedProp.kind === 'mnemonic'
      ? 'SELECTED — arrows: move · h/l or PageUp/PageDown: height · +/-: scale · Esc: deselect'
      : selectedProp.kind === 'moveObject'
        ? 'SELECTED — arrows: nudge · h/l or PageUp/PageDown: height · < >: rotate · +/-: scale · Enter or gear icon: change/remove · Esc: deselect'
        : selectedProp.kind === 'sign'
          ? 'SIGN SELECTED — arrows: move · Enter or gear icon: change/remove skin · Esc: deselect'
          : 'SELECTED — arrows: nudge · < >: rotate · +/-: scale · Enter or gear icon: change/remove · Esc: deselect') + resize;
    editHud.style.display = 'block';
    return;
  }
  if(!editMode){ editHud.style.display = 'none'; return; }
  // outdoors you edit building facades; indoors floors/walls/slots
  const outdoor = ROOMS[currentRoomKey] && ROOMS[currentRoomKey].outdoor;
  editHud.textContent = outdoor
    ? 'EDIT MODE — click a building’s facade, its lawn, a yard spot, or its sign to edit; [Esc] to exit'
    : 'EDIT MODE — click floor / wall / stairs / slot / doorway to set; [Esc] to exit';
  editHud.style.display = 'block';
}

function setEditMode(on){
  const wasOn = editMode;
  editMode = on;
  if(!on) deselectProp();
  if(renderer) renderer.domElement.style.cursor = on ? 'crosshair' : 'default';
  updateEditHud();
  // "fully decorated" is only (re)computed on the edit-mode-on -> off
  // transition -- a simple, well-defined checkpoint (see DECORATED above).
  if(wasOn && !on) evaluateDecorated(currentRoomKey);
  buildRoom(currentRoomKey);
}

/* ---------- on-screen touch joystick ----------
   Built into the container (a positioned ancestor, like editHud) on coarse-
   pointer devices only, so desktop keeps its clean canvas. Drives joyVec,
   which tick() reads. Pointer events cover both touch and stylus; the knob is
   captured so a drag that slides off the base keeps tracking. */
function buildJoystick(){
  if(!isCoarsePointer()) return null;
  const R = 58;                       // max knob travel from center (px)
  const base = document.createElement('div');
  base.style.cssText =
    'position:absolute;left:50%;bottom:20px;transform:translateX(-50%);'
    + `width:${R*2}px;height:${R*2}px;border-radius:50%;`
    + 'background:rgba(255,255,255,.10);border:2px solid rgba(255,255,255,.35);'
    + 'touch-action:none;z-index:3;';
  const knob = document.createElement('div');
  knob.style.cssText =
    'position:absolute;left:50%;top:50%;width:54px;height:54px;margin:-27px 0 0 -27px;'
    + 'border-radius:50%;background:rgba(255,255,255,.55);'
    + 'border:2px solid rgba(255,255,255,.85);pointer-events:none;';
  base.appendChild(knob);
  joyKnob = knob;

  const setFromEvent = (e) => {
    const rect = base.getBoundingClientRect();
    let dx = e.clientX - (rect.left + rect.width/2);
    let dy = e.clientY - (rect.top + rect.height/2);
    const dist = Math.hypot(dx, dy);
    if(dist > R){ dx = dx/dist*R; dy = dy/dist*R; }
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    joyVec.x = dx / R;
    joyVec.y = -dy / R;               // screen y is down-positive; push up = forward
  };
  const reset = () => {
    joyVec.x = 0; joyVec.y = 0;
    knob.style.transform = 'translate(0px,0px)';
    joyPointerId = null;
  };
  base.addEventListener('pointerdown', (e) => {
    joyPointerId = e.pointerId;
    base.setPointerCapture(e.pointerId);
    setFromEvent(e);
    e.preventDefault();
  });
  base.addEventListener('pointermove', (e) => {
    if(e.pointerId === joyPointerId) setFromEvent(e);
  });
  const end = (e) => { if(e.pointerId === joyPointerId) reset(); };
  base.addEventListener('pointerup', end);
  base.addEventListener('pointercancel', end);
  return base;
}

const isCoarsePointer = () => !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

const TOUCH_BTN_CSS =
  'min-width:48px;height:46px;padding:0 .55rem;border-radius:8px;'
  + 'border:1px solid rgba(255,255,255,.5);background:rgba(28,38,58,.78);color:#fff;'
  + 'font:600 1rem sans-serif;line-height:1;touch-action:manipulation;'
  + '-webkit-user-select:none;user-select:none;pointer-events:auto;';

// a tap button that won't bubble into the canvas click/selection handler
function makeTouchBtn(label, onTap){
  const b = document.createElement('button');
  b.innerHTML = label;
  b.style.cssText = TOUCH_BTN_CSS;
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onTap(); });
  return b;
}

// ---------- top-left icon toolbar ----------
// icon-only tap button (still won't bubble into the canvas selection handler)
function makeIconBtn(faClass, title, onTap){
  const b = makeTouchBtn(`<i class="fa-solid ${faClass}"></i>`, onTap);
  b.title = title;
  return b;
}
// icon controls overlaid on the canvas: a flush-left group (hints, edit, the
// edit-only room/asset buttons, board, then help) and a flush-right group --
// the room-status badges (decorated, memorized) immediately left of the
// close (✕), so status indicators read together at the right edge instead of
// scattered through the left cluster. The bar spans the top width with the
// empty middle clicking through.
function buildTopToolbar(){
  const bar = document.createElement('div');
  // marks the toolbar so tests can scope icon-order assertions to it alone --
  // the VR pane also holds the Help overlay, whose text documents each button
  // with the same inline Font Awesome icons, which a bare pane-wide selector
  // would otherwise count as extra "toolbar" icons.
  bar.dataset.threeToolbar = '1';
  bar.style.cssText = 'position:absolute;top:8px;left:8px;right:8px;display:flex;'
    + 'justify-content:space-between;align-items:flex-start;z-index:6;pointer-events:none;';
  const left = document.createElement('div');
  left.style.cssText = 'display:flex;gap:6px;pointer-events:none;';
  const right = document.createElement('div');
  right.style.cssText = 'display:flex;gap:6px;pointer-events:none;';
  hintsBtn    = makeIconBtn('fa-lightbulb',      'Show/hide hints (room names, door hints, move billboards)', () => setHintsOn(!hintsOn));
  editBtn     = makeIconBtn('fa-pencil',         'Edit mode',     () => setEditMode(!editMode));
  undoBtn     = makeIconBtn('fa-rotate-left',    'Undo (Ctrl+Z)', () => undoEdit());
  redoBtn     = makeIconBtn('fa-rotate-right',   'Redo (Ctrl+Shift+Z)', () => redoEdit());
  boardBtn    = makeIconBtn('fa-chess-board',    'Show this room’s board position', () => toggleMiniBoard());
  roomGeomBtn = makeIconBtn('fa-ruler-combined', 'Room geometry', () => openRoomGeomDialog(currentRoomKey));
  wallListsBtn = makeIconBtn('fa-list-ol',        'Wall object lists', () => openWallListsDialog(currentRoomKey));
  assetsBtn   = makeIconBtn('fa-cubes',          'Asset library', () => { if(threeOpts.onAssets) threeOpts.onAssets(); });
  infoBtn     = makeIconBtn('fa-circle-info',    'Help',          () => toggleHelp());
  decoratedBadge = makeIconBtn('fa-palette',     'This room is fully decorated', () => showToast('This room is fully decorated!'));
  dirtyBadge  = makeIconBtn('fa-triangle-exclamation', 'A new variation added a door here since you memorized this room',
                             () => showToast('New door since you memorized this room -- give it a look!'));
  memBtn      = makeIconBtn('fa-brain',          'Mark this room memorized', () => toggleMemorized());
  closeBtn    = makeIconBtn('fa-circle-xmark',   'Close',         () => { if(threeOpts.onClose) threeOpts.onClose(); });
  // Edit + its edit-only buttons (roomGeom/wallLists/assets) wrapped in one
  // bordered "chip" so they read as a single grouped tool cluster, distinct
  // from the standalone hints/board/info icons around them. The wrapper's
  // own visibility never changes -- individual buttons inside it still show/
  // hide via updateToolbar() same as before, so it simply grows/shrinks
  // around whichever of them are currently visible.
  editGroup = document.createElement('div');
  editGroup.style.cssText = 'display:flex;gap:6px;padding:4px;border-radius:10px;'
    + 'border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.06);pointer-events:none;';
  editGroup.append(editBtn, undoBtn, redoBtn, roomGeomBtn, wallListsBtn, assetsBtn);
  left.append(hintsBtn, editGroup, boardBtn, infoBtn);
  // memorize is the rightmost status badge (right next to Close); decorated,
  // when shown, sits immediately to its left; dirty (when shown) sits between
  // decorated and memorize -- it's specifically about the memorized state.
  right.append(decoratedBadge, dirtyBadge, memBtn, closeBtn);
  bar.append(left, right);
  return bar;
}
// reflect hints/edit state; show the edit-only buttons only while editing
function updateToolbar(){
  if(hintsBtn){
    hintsBtn.style.background = hintsOn ? 'rgba(245,193,7,.92)' : 'rgba(28,38,58,.78)';
    hintsBtn.style.color = hintsOn ? '#1a1a1a' : '#fff';
  }
  if(editBtn){
    editBtn.style.background = editMode ? 'rgba(21,101,192,.92)' : 'rgba(28,38,58,.78)';
    editBtn.title = editMode ? 'Exit edit mode (Esc)' : 'Edit mode';
  }
  if(roomGeomBtn) roomGeomBtn.style.display = editMode ? '' : 'none';
  // dimmed (not hidden) rather than disabled outright, so their availability
  // is visible at a glance without the icon jumping around as it comes and goes
  if(undoBtn){
    undoBtn.style.display = editMode ? '' : 'none';
    undoBtn.style.opacity = editUndoStack.length ? '1' : '.35';
  }
  if(redoBtn){
    redoBtn.style.display = editMode ? '' : 'none';
    redoBtn.style.opacity = editRedoStack.length ? '1' : '.35';
  }
  // wall-lists button only when this room actually has move-object slots to fill
  if(wallListsBtn){
    const hasPairs = moveObjectSlots(currentRoomKey).length > 0;
    wallListsBtn.style.display = (editMode && hasPairs) ? '' : 'none';
  }
  // board button whenever the current room carries a chess position (castle rooms);
  // hidden for the street / start where there is none. Highlights while open.
  if(boardBtn){
    boardBtn.style.display = currentRoomFen() ? '' : 'none';
    const open = !!document.getElementById('miniBoardOverlay') && document.getElementById('miniBoardOverlay').style.display === 'flex';
    boardBtn.style.background = open ? 'rgba(21,101,192,.92)' : 'rgba(28,38,58,.78)';
  }
  // same gate boardBtn uses -- only real castle rooms have a position to memorize
  if(memBtn){
    memBtn.style.display = currentRoomFen() ? '' : 'none';
    const on = !!MEMORIZED[currentRoomKey];
    memBtn.style.background = on ? 'rgba(56,142,60,.92)' : 'rgba(28,38,58,.78)';
    memBtn.title = on ? 'Memorized -- click to unmark' : 'Mark this room memorized';
  }
  // decorated is a computed, read-only badge (see evaluateDecorated) -- shown
  // only when true, so it never competes with memorize's on/off toggle look.
  if(decoratedBadge) decoratedBadge.style.display = DECORATED[currentRoomKey] ? '' : 'none';
  // dirty (see isRoomDirty) only ever applies to an already-memorized room --
  // computed live (cheap: a couple of array lookups) rather than cached like
  // DECORATED, so it can't go stale between updateToolbar() calls.
  if(dirtyBadge) dirtyBadge.style.display = (MEMORIZED[currentRoomKey] && isRoomDirty(currentRoomKey)) ? '' : 'none';
  if(assetsBtn)   assetsBtn.style.display   = editMode ? '' : 'none';
}
function setHintsOn(on){
  hintsOn = on;
  try{ localStorage.setItem('threeHintsOn', on ? '1' : '0'); }catch(_){}
  updateToolbar();
  if(scene) buildRoom(currentRoomKey);
}

// help overlay -- the walking/editing instructions that used to sit under the
// canvas, now shown only on demand via the ⓘ button.
function buildHelpOverlay(){
  const ov = document.createElement('div');
  ov.style.cssText = 'position:absolute;inset:0;z-index:8;display:none;'
    + 'background:rgba(0,0,0,.55);align-items:center;justify-content:center;';
  ov.innerHTML = `
    <div style="background:#fff;color:#222;max-width:32em;width:88%;max-height:84%;overflow:auto;
                border-radius:8px;padding:1rem 1.2rem;font:400 .9rem/1.45 sans-serif">
      <h2 style="margin:.1rem 0 .7rem;font-size:1.1rem">Walking the memory palace</h2>
      <p style="margin:.4rem 0"><strong>Move:</strong> arrows or W/A/S/D. Q/E strafe (sidestep) left and right. Walk forward through a doorway to enter the room beyond. Press R to reset to this room's own entrance, H to return all the way to Main Street, B to instantly take the room's own back door.</p>
      <p style="margin:.4rem 0"><strong><i class="fa-solid fa-lightbulb"></i> Hints:</strong> show/hide room names, the move hint beside each door, and the in-room move billboards — turn them off to self-test your recall.</p>
      <p style="margin:.4rem 0"><strong><i class="fa-solid fa-chess-board"></i> Board:</strong> show a mini board of the current room's position (castle rooms only).</p>
      <p style="margin:.4rem 0"><strong><i class="fa-solid fa-pencil"></i> Edit mode:</strong> click the floor, a wall, stairs, a slot, or a doorway to skin/assign it. With an item selected, arrows nudge it, &lt; &gt; rotate, +/− scale. <i class="fa-solid fa-ruler-combined"></i> opens room geometry, <i class="fa-solid fa-list-ol"></i> assigns object lists to the walls, <i class="fa-solid fa-cubes"></i> the asset library. Press Esc (or the pencil) to leave edit mode. Ctrl+Z (or <i class="fa-solid fa-rotate-left"></i>) undoes the last edit, Ctrl+Shift+Z (or <i class="fa-solid fa-rotate-right"></i>) redoes it.</p>
      <p style="margin:.4rem 0"><strong>Touch:</strong> use the on-screen joystick to walk; in edit mode an on-screen pad moves/scales the selected item.</p>
      <div style="text-align:right;margin-top:.9rem"><button id="threeHelpCloseBtn">Close</button></div>
    </div>`;
  wireBackdropClose(ov, () => toggleHelp(false));
  ov.querySelector('#threeHelpCloseBtn').addEventListener('click', () => toggleHelp(false));
  return ov;
}
function toggleHelp(show){
  if(!helpOverlay) return;
  const on = show === undefined ? helpOverlay.style.display === 'none' : show;
  helpOverlay.style.display = on ? 'flex' : 'none';
}

/* ---------- mini board (current room's position) ----------
   The current castle room's position, drawn as a small 2D board from the stored
   posKey (first-4-FEN-fields; its first token is the piece placement). A quick
   reference while walking — toggled from the board icon in the top toolbar. */
// the position string for the current room, or null when the room has none
// (the street / start) or it's a non-FEN fallback id.
function currentRoomFen(){
  const pk = ROOMS[currentRoomKey] && ROOMS[currentRoomKey].posKey;
  return (pk && pk.includes('/')) ? pk : null;
}
// the same cm-chessboard piece sprite the app's real boards (analysis, hover
// preview) use, so the VR mini board's pieces are pixel-identical artwork, not
// a Unicode-glyph approximation. app.js passes its own PIECES_FILE constant in
// via threeOpts.piecesFile (see openThreeTest) so there's one source of truth;
// this literal is only a fallback for the rare caller that omits it.
let PIECES_FILE_URL = 'https://unpkg.com/cm-chessboard@8/assets/pieces/standard.svg';
// Browsers block an SVG <use> from referencing a document at a different
// origin outright ("Unsafe attempt to load URL ... Domains, protocols and
// ports must match") -- so the sprite can't be used cross-origin in place.
// cm-chessboard's own board widget works around exactly this by fetching the
// raw SVG once and inlining it into the page, then referencing pieces by a
// bare #id (a same-document, same-origin reference). This mirrors that same
// technique (same cache-div id too, so if a real Chessboard instance is also
// on the page, whichever runs first does the one fetch and the other reuses
// it) rather than depending on cm-chessboard's own internal DOM as a hidden
// dependency of this module.
let pieceSpriteRequested = false;
function ensurePieceSprite(){
  if(pieceSpriteRequested || document.getElementById('cm-chessboard-sprite')) return;
  pieceSpriteRequested = true;
  const wrapper = document.createElement('div');
  wrapper.id = 'cm-chessboard-sprite';
  wrapper.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  wrapper.setAttribute('aria-hidden', 'true');
  document.body.appendChild(wrapper);
  fetch(PIECES_FILE_URL).then(r => r.text()).then(svg => { wrapper.innerHTML = svg; }).catch(() => {});
}
// side to move from the posKey's 2nd field ('w'/'b'), for the caption
function fenSideToMove(fen){ const parts = fen.split(' '); return parts[1] === 'b' ? 'Black' : 'White'; }
// build an 8x8 grid (rank 8 at top) from the board field of a FEN/posKey
function miniBoardGridHtml(fen){
  ensurePieceSprite();
  const board = fen.split(' ')[0];
  const ranks = board.split('/');
  let cells = '';
  for(let r = 0; r < 8; r++){
    const row = ranks[r] || '8';
    let file = 0;
    for(const ch of row){
      if(/\d/.test(ch)){
        const n = +ch;
        for(let k = 0; k < n; k++){ cells += miniCell(r, file, ''); file++; }
      } else {
        // cm-chessboard's sprite ids are colour+piece, lowercase (e.g. 'wp','bn')
        const code = (ch === ch.toLowerCase() ? 'b' : 'w') + ch.toLowerCase();
        cells += miniCell(r, file, code);
        file++;
      }
    }
    while(file < 8){ cells += miniCell(r, file, ''); file++; }   // pad short/absent ranks
  }
  return cells;
}
function miniCell(rank, file, pieceCode){
  const light = (rank + file) % 2 === 0;
  const bg = light ? '#e8ddc7' : '#9a7b53';
  // sprite pieces are drawn in a native 40x40 box (standard.svg's own viewBox);
  // matching viewBox here reproduces their original proportions/positioning.
  // Bare "#id" (not a full URL) -- see ensurePieceSprite for why.
  const piece = pieceCode
    ? `<svg viewBox="0 0 40 40" width="88%" height="88%"><use href="#${pieceCode}"></use></svg>`
    : '';
  return `<div style="background:${bg};display:flex;align-items:center;justify-content:center">${piece}</div>`;
}
function toggleMiniBoard(show){
  let ov = document.getElementById('miniBoardOverlay');
  const fen = currentRoomFen();
  const want = show === undefined ? !(ov && ov.style.display === 'flex') : show;
  if(!want || !fen){ if(ov) ov.style.display = 'none'; updateToolbar(); return; }
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'miniBoardOverlay';
    ov.style.cssText = 'position:absolute;left:8px;top:56px;z-index:7;display:none;';
    (container || document.body).appendChild(ov);
  }
  const name = (ROOMS[currentRoomKey] && ROOMS[currentRoomKey].castleSign && ROOMS[currentRoomKey].castleSign.title) || 'Position';
  ov.innerHTML = `
    <div style="background:rgba(20,24,34,.92);border:1px solid #556;border-radius:8px;padding:.5rem;box-shadow:0 4px 16px rgba(0,0,0,.4);width:236px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;margin-bottom:.35rem">
        <span style="color:#eee;font:600 .78rem/1.2 sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(name)}</span>
        <button id="miniBoardClose" style="flex:0 0 auto;font-size:.7rem;padding:.1rem .4rem;cursor:pointer">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(8,1fr);grid-template-rows:repeat(8,1fr);width:220px;height:220px;border:2px solid #333;border-radius:3px;overflow:hidden">
        ${miniBoardGridHtml(fen)}
      </div>
      <div style="color:#aab;font:400 .72rem/1.3 sans-serif;margin-top:.35rem">${fenSideToMove(fen)} to move</div>
    </div>`;
  ov.style.display = 'flex';
  ov.querySelector('#miniBoardClose').onclick = () => toggleMiniBoard(false);
  updateToolbar();
}
// keep the board in sync when the room changes: refresh if open, hide if the new
// room has no position.
function refreshMiniBoard(){
  const ov = document.getElementById('miniBoardOverlay');
  if(ov && ov.style.display === 'flex') toggleMiniBoard(true);
}

// move/scale pad shown while a prop is selected. Buttons drive the same
// nudgeSelected/scaleSelected paths the keyboard does, so behavior matches.
function buildEditTouch(){
  if(!isCoarsePointer()) return null;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;left:0;right:0;bottom:0;top:0;'
    + 'pointer-events:none;z-index:4;display:none;';
  return wrap;
}
function updateEditTouchControls(){
  if(!editTouchEl) return;
  // the move/scale pad and the walk joystick would overlap on a phone, so the
  // joystick steps aside while a prop is being edited (it returns on deselect)
  if(joystickEl){
    joystickEl.style.display = selectedProp ? 'none' : 'block';
    if(selectedProp){ joyVec.x = 0; joyVec.y = 0; joyPointerId = null; if(joyKnob) joyKnob.style.transform = 'translate(0px,0px)'; }
  }
  if(!selectedProp){ editTouchEl.style.display = 'none'; editTouchEl.innerHTML = ''; return; }
  editTouchEl.innerHTML = '';
  editTouchEl.style.display = 'block';
  const mnem = selectedProp.kind === 'mnemonic';
  const sign = selectedProp.kind === 'sign';
  const moveObj = selectedProp.kind === 'moveObject';

  // directional pad, bottom-right (a + arrangement with empty corners)
  const pad = document.createElement('div');
  pad.style.cssText = 'position:absolute;right:10px;bottom:14px;display:grid;'
    + 'grid-template-columns:repeat(3,48px);grid-template-rows:repeat(3,46px);gap:6px;';
  const blank = () => document.createElement('div');
  pad.append(
    blank(), makeTouchBtn('▲', () => nudgeSelected('ArrowUp')), blank(),
    makeTouchBtn('◀', () => nudgeSelected('ArrowLeft')), blank(), makeTouchBtn('▶', () => nudgeSelected('ArrowRight')),
    blank(), makeTouchBtn('▼', () => nudgeSelected('ArrowDown')), blank()
  );
  editTouchEl.appendChild(pad);

  // left cluster: scale, height (mnemonic + move-object), change (assets), done
  const col = document.createElement('div');
  col.style.cssText = 'position:absolute;left:10px;bottom:14px;display:flex;flex-direction:column;gap:6px;';
  const rowOf = (...els) => { const r = document.createElement('div'); r.style.cssText = 'display:flex;gap:6px'; r.append(...els); return r; };
  if(!sign) col.appendChild(rowOf(            // signs are fixed-size, no scaling
    makeTouchBtn('Bigger', () => scaleSelected(SCALE_STEP)),
    makeTouchBtn('Smaller', () => scaleSelected(1 / SCALE_STEP))
  ));
  // height controls: mnemonic billboards and move-objects can both be raised/lowered
  if(mnem || moveObj) col.appendChild(rowOf(
    makeTouchBtn('Higher', () => nudgeSelected('PageUp')),
    makeTouchBtn('Lower', () => nudgeSelected('PageDown'))
  ));
  // "Change" swaps the asset/skin -- available for everything except the
  // asset-less mnemonic billboard (move-objects and signs included).
  if(!mnem) col.appendChild(rowOf(
    makeTouchBtn('Change', () => openManagerForSelection())
  ));
  // rotate controls for a free-standing extruded floor prop (only this kind has
  // a steerable front; wall props face their wall, billboards face the camera)
  if(selectedProp.kind === 'floor'){
    const fa = slotAssetFor(selectedProp.roomKey, selectedProp.slotId);
    if(fa && fa.type === 'extruded') col.appendChild(rowOf(
      makeTouchBtn('‹', () => rotateSelected(-1)),
      makeTouchBtn('›', () => rotateSelected(1))
    ));
  }
  col.appendChild(rowOf(makeTouchBtn('Done', () => deselectProp())));
  editTouchEl.appendChild(col);
}

/* ---------- room geometry dialog ----------
   A separate typed-attribute dialog (not another in-world click target) for
   resizing the current room -- width/depth/height in meters -- with a live
   2D top-down preview. Builds its own overlay on document.body (same pattern
   as the asset picker in assets.js) so it layers above the threeTest modal
   regardless of which container hosts the canvas. Saved as
   LAYOUT[roomKey].geom and folded onto the static size by mergedRoom() at
   every read site, so existing rooms with no override are unaffected. */
function openRoomGeomDialog(roomKey){
  setForeignModalOpen(true);
  let ov = document.getElementById('roomGeomOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'roomGeomOverlay';
    ov.className = 'overlay';
    ov.style.zIndex = '70';
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';
  renderRoomGeomDialog(ov, roomKey);
}
function closeRoomGeomDialog(){
  const ov = document.getElementById('roomGeomOverlay');
  if(ov) ov.style.display = 'none';
  setForeignModalOpen(false);
}

/* ---------- wall object-list dialog (Phase 2) ----------
   Assigns an object list to each of the current room's wall buckets (left/right
   for a two-track room, else a single 'all' bucket). Stored as
   LAYOUT[roomKey].wallLists[bucket] = { listId } and folded in at render time by
   moveObjectListResolved(). Same document.body overlay pattern as the room
   geometry dialog. */
function openWallListsDialog(roomKey){
  setForeignModalOpen(true);
  let ov = document.getElementById('wallListsOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'wallListsOverlay';
    ov.className = 'overlay';
    ov.style.zIndex = '70';
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';
  renderWallListsDialog(ov, roomKey);
}
function closeWallListsDialog(){
  const ov = document.getElementById('wallListsOverlay');
  if(ov) ov.style.display = 'none';
  setForeignModalOpen(false);
}
const WALL_BUCKET_LABEL = { left: 'Left wall', right: 'Right wall', all: 'Room (single sequence)' };
// list <option>s for a bucket, best run-length match first (exact match flagged).
// two-level menu -- Category, then list name within it (optgroup is a native
// <select> feature, so this needs no custom dropdown/picker) -- lists within
// a category still sort best-run-length-match first; categories themselves
// sort alphabetically ("(Uncategorized)" last), independent of fit.
function wallListOptionsHtml(roomKey, bucket){
  const need = bucketSlotCount(roomKey, bucket);
  const cur = wallListId(roomKey, bucket);
  const byCategory = new Map();
  for(const l of Object.values(OBJECT_LISTS)){
    const cat = l.category || '(Uncategorized)';
    if(!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(l);
  }
  const categories = [...byCategory.keys()].sort((a, b) => {
    if(a === '(Uncategorized)') return 1;
    if(b === '(Uncategorized)') return -1;
    return a.localeCompare(b);
  });
  const optionHtml = l => {
    const n = (l.items || []).length;
    const fit = n === need ? ' ✓ exact' : ` (${n} item${n === 1 ? '' : 's'})`;
    return `<option value="${escHtml(l.id)}" ${l.id === cur ? 'selected' : ''}>${escHtml(l.name)}${fit}</option>`;
  };
  const groups = categories.map(cat => {
    const lists = byCategory.get(cat).slice().sort((a, b) => {
      const na = (a.items || []).length, nb = (b.items || []).length;
      const da = Math.abs(na - need), db = Math.abs(nb - need);
      return (da - db) || (na - nb) || String(a.name).localeCompare(String(b.name));
    });
    return `<optgroup label="${escHtml(cat)}">${lists.map(optionHtml).join('')}</optgroup>`;
  });
  return `<option value="">— none —</option>` + groups.join('');
}
// preview of how the chosen list's items land on this bucket's slots, in
// order -- a slot with a manual override shadowing the list is struck
// through and flagged (bucketOverrideFlags), so it's clear AT A GLANCE why
// that slot isn't showing its list item instead of only discoverable by
// noticing the panel doesn't match (the reported "still see the old
// hard-coded items" confusion).
function wallListPreviewHtml(roomKey, bucket){
  const id = wallListId(roomKey, bucket);
  const need = bucketSlotCount(roomKey, bucket);
  if(!id) return `<span style="color:#999">No list — slots show numbered placeholders.</span>`;
  const list = OBJECT_LISTS[id];
  if(!list) return `<span style="color:#c62828">List no longer exists.</span>`;
  const items = list.items || [];
  const overridden = bucketOverrideFlags(roomKey, bucket);
  const rows = [];
  let anyOverridden = false;
  for(let i = 0; i < need; i++){
    const it = items[i];
    const label = it ? (it.assetId && ASSET_BY_ID[it.assetId] ? `🖼 ${escHtml(it.name)}` : escHtml(it.name)) : '<span style="color:#c62828">(list too short)</span>';
    if(overridden[i]){
      anyOverridden = true;
      rows.push(`<div style="color:#999">${i + 1}. <s>${label}</s> — hidden by a manual object</div>`);
    } else {
      rows.push(`<div>${i + 1}. ${label}</div>`);
    }
  }
  let extra = '';
  if(items.length > need) extra = `<div style="color:#999">+${items.length - need} more item(s) unused here</div>`;
  if(anyOverridden) extra += `<div style="color:#c62828">Some slots are hidden by a manual object override — use "Clear overrides" below to remove them and show the list instead.</div>`;
  if(list.mnemonic && list.mnemonic.phrase) extra += `<div style="margin-top:.3rem;font-style:italic;color:#1565c0">“${escHtml(list.mnemonic.phrase)}”</div>`;
  return rows.join('') + extra;
}
function renderWallListsDialog(ov, roomKey){
  const room = mergedRoom(roomKey);
  const roomName = (room && room.name) || 'Room';
  const buckets = roomWallBuckets(roomKey);
  const nLists = Object.keys(OBJECT_LISTS).length;
  const bucketBlocks = buckets.map(bucket => {
    const need = bucketSlotCount(roomKey, bucket);
    return `
      <div class="wl-bucket" data-bucket="${bucket}" style="margin:.7rem 0;padding:.6rem .7rem;border:1px solid #ddd;border-radius:6px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap">
          <strong>${WALL_BUCKET_LABEL[bucket] || bucket}</strong>
          <span style="font-size:.78rem;color:#666">${need} move-pair slot${need === 1 ? '' : 's'}</span>
        </div>
        <div style="display:flex;gap:.4rem;align-items:center;margin-top:.4rem;flex-wrap:wrap">
          <select class="wl-select" data-bucket="${bucket}" style="flex:1;font-size:.85rem;padding:.3rem">
            ${wallListOptionsHtml(roomKey, bucket)}
          </select>
          <button class="wl-newlist" data-bucket="${bucket}" style="font-size:.78rem;white-space:nowrap" title="Create a new object list and assign it here">+ New…</button>
          ${need > 0 ? `<button class="wl-clearoverrides" data-bucket="${bucket}" style="font-size:.78rem;white-space:nowrap" title="Wipe every manual object override in this bucket, so its slots show the assigned list's items (or numbered placeholders, if none) instead">Clear overrides</button>` : ''}
        </div>
        <div class="wl-preview" data-bucket="${bucket}" style="margin-top:.45rem;font-size:.8rem;line-height:1.5">
          ${wallListPreviewHtml(roomKey, bucket)}
        </div>
      </div>`;
  }).join('');
  ov.innerHTML = `
    <div class="modal" style="max-width:30em;width:92%;max-height:86vh;overflow:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.3rem">
        <h2 style="margin:0;font-size:1.15rem">Wall object lists</h2>
        <button id="wlCloseBtn">Close</button>
      </div>
      <p style="margin:.2rem 0 .6rem;font-size:.82rem;color:#555">
        Assign an ordered object list to <strong>${escHtml(roomName)}</strong>. Each item fills one
        move-pair in order; items with no image show their word until you assign one.
      </p>
      ${nLists === 0
        ? `<p style="color:#c62828;font-size:.85rem">No object lists yet.</p>
           <button id="wlEmptyNewBtn">+ New List…</button>`
        : bucketBlocks}
    </div>`;
  ov.querySelector('#wlCloseBtn').onclick = closeWallListsDialog;
  wireBackdropClose(ov, closeWallListsDialog, { once: true });
  ov.querySelectorAll('.wl-select').forEach(sel => {
    sel.onchange = () => {
      const bucket = sel.dataset.bucket;
      const val = sel.value;
      const r = ensureRoomLayout(roomKey);
      if(!r.wallLists) r.wallLists = {};
      if(val){
        r.wallLists[bucket] = { listId: val };
        // a freshly (re)assigned list must actually take effect, not stay
        // silently blocked by stale per-slot overrides left over from before
        // (e.g. hand-placed test props) -- see clearBucketSlotOverrides.
        clearBucketSlotOverrides(roomKey, bucket);
      } else {
        delete r.wallLists[bucket];
      }
      persistLayout();
      // refresh this bucket's preview and rebuild the room live
      const pv = ov.querySelector(`.wl-preview[data-bucket="${bucket}"]`);
      if(pv) pv.innerHTML = wallListPreviewHtml(roomKey, bucket);
      buildRoom(currentRoomKey);
    };
  });
  // "+ New..." (per bucket, and the empty-state "+ New List…") -- same
  // "escape out to the standalone create-and-assign editor without leaving
  // this dialog first" pattern as the asset picker's own "+ New Asset"
  // button (see objectLists.js's openNewObjectListModal doc comment). A
  // freshly-created list is auto-assigned to the bucket that spawned it
  // (there's nothing left to decide, same reasoning as the asset picker);
  // the empty-state button has no bucket to assign to, so it just gets the
  // list created and reopens the dialog with the now-populated bucket rows.
  const afterNewList = async (bucket) => {
    const newId = await openNewObjectListModal();
    if(!newId) return;
    await refreshObjectLists();
    if(bucket){
      const r = ensureRoomLayout(roomKey);
      if(!r.wallLists) r.wallLists = {};
      r.wallLists[bucket] = { listId: newId };
      clearBucketSlotOverrides(roomKey, bucket);
      persistLayout();
      buildRoom(currentRoomKey);
    }
    renderWallListsDialog(ov, roomKey);   // full re-render: the new list is now an option everywhere
  };
  ov.querySelectorAll('.wl-newlist').forEach(btn => { btn.onclick = () => afterNewList(btn.dataset.bucket); });
  const emptyBtn = ov.querySelector('#wlEmptyNewBtn');
  if(emptyBtn) emptyBtn.onclick = () => afterNewList(null);
  // explicit bulk-clear, independent of (re)assigning a list -- the same
  // sweep clearBucketSlotOverrides already runs automatically on a fresh
  // pick, but reached directly rather than only as an assignment side
  // effect. Needed when the assigned list's own ITEMS change in place
  // (editing an existing list, not swapping to a different one) -- the
  // bucket's assigned id never changes in that case, so the automatic sweep
  // never fires, and stale per-slot/per-floor overrides (an elevator's
  // hand-assigned floor objects, say) had no other way to be bulk-cleared.
  ov.querySelectorAll('.wl-clearoverrides').forEach(btn => {
    btn.onclick = () => {
      const bucket = btn.dataset.bucket;
      if(!confirm('Clear every manual object override in this bucket?\n\nEach of its slots will fall back to the assigned list\'s own item (or a numbered placeholder, if no list is assigned) instead. This cannot be undone.')) return;
      clearBucketSlotOverrides(roomKey, bucket);
      persistLayout();
      const pv = ov.querySelector(`.wl-preview[data-bucket="${bucket}"]`);
      if(pv) pv.innerHTML = wallListPreviewHtml(roomKey, bucket);
      buildRoom(currentRoomKey);
    };
  });
}

const ROOM_GEOM_MIN = 2;
// summary of the building's captured defaults, shown in the Room dialog, with a
// Clear control when any are set.
function defaultsBoxHtml(roomKey){
  const d = buildingDefaults(roomKey);
  if(!d){
    return `<span style="font-size:.74rem;color:#999">No building defaults set yet — tick the box below and Apply to make this room's look the default for the building.</span>`;
  }
  const m = (on) => on ? '✓' : '—';
  return `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
      <div style="font-size:.74rem;color:#555;line-height:1.45">
        <strong>Building defaults</strong> — floor ${m(d.floor)} · ceiling ${m(d.ceiling)} · stairs ${m(d.stairSurface)}<br>
        walls: ent ${m(d.walls&&d.walls.entrance)}, opp ${m(d.walls&&d.walls.opposite)}, L ${m(d.walls&&d.walls.left)}, R ${m(d.walls&&d.walls.right)} ·
        doors: exit ${m(d.exitDoor)}, std ${m(d.door)}, locked ${m(d.lockedDoor)}
      </div>
      <button id="roomGeomClearDefaultsBtn" style="font-size:.68rem;white-space:nowrap;align-self:center">Clear defaults</button>
    </div>`;
}
function wireDefaultsBox(ov, roomKey){
  const btn = ov.querySelector('#roomGeomClearDefaultsBtn');
  if(!btn) return;
  btn.onclick = () => {
    if(!confirm(
      'Clear the building defaults for this castle?\n\n' +
      'Rooms that rely on these defaults will revert to plain procedural surfaces. ' +
      "Each room's own custom styling is NOT affected.\n\nThis cannot be undone."
    )) return;
    clearBuildingDefaults(roomKey);
    refreshDefaultsBox(ov, roomKey);
  };
}
function refreshDefaultsBox(ov, roomKey){
  const box = ov.querySelector('#roomGeomDefaultsBox');
  if(box){ box.innerHTML = defaultsBoxHtml(roomKey); wireDefaultsBox(ov, roomKey); }
}
// reusable named-preset controls in the Room dialog: save the current room as a
// named preset, or apply a preset as this building's defaults.
function presetsBoxHtml(roomKey){
  const names = listPresetNames();
  const picker = names.length ? `
    <div style="display:flex;gap:.3rem;align-items:center;margin-top:.35rem;flex-wrap:wrap">
      <select id="roomGeomPresetSelect" style="font-size:.74rem;max-width:10em">
        ${names.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('')}
      </select>
      <button id="roomGeomApplyPresetBtn" style="font-size:.7rem">Apply to building</button>
      <button id="roomGeomApplyPresetRoomBtn" style="font-size:.7rem">Apply to this room</button>
      <button id="roomGeomDeletePresetBtn" style="font-size:.7rem">Delete</button>
    </div>` : `<div style="font-size:.72rem;color:#999;margin-top:.3rem">No presets yet.</div>`;
  return `
    <div style="font-size:.74rem;color:#555">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem">
        <strong>Presets</strong>
        <button id="roomGeomSavePresetBtn" style="font-size:.68rem;white-space:nowrap">Save this room as preset…</button>
      </div>
      ${picker}
    </div>`;
}
function wirePresetsBox(ov, roomKey){
  const refresh = () => {
    const box = ov.querySelector('#roomGeomPresetsBox');
    if(box){ box.innerHTML = presetsBoxHtml(roomKey); wirePresetsBox(ov, roomKey); }
  };
  const saveBtn = ov.querySelector('#roomGeomSavePresetBtn');
  if(saveBtn) saveBtn.onclick = () => {
    let name = prompt('Name this preset (e.g. Formal, Rustic):');
    if(name == null) return;
    name = name.trim();
    if(!name) return;
    if(LAYOUT.__presets && LAYOUT.__presets[name] &&
       !confirm(`A preset named "${name}" already exists. Overwrite it?`)) return;
    savePreset(name, roomKey);
    refresh();
  };
  const applyBtn = ov.querySelector('#roomGeomApplyPresetBtn');
  if(applyBtn) applyBtn.onclick = () => {
    const name = ov.querySelector('#roomGeomPresetSelect').value;
    if(!name) return;
    if(!confirm(`Apply preset "${name}" as the default for this building?\n\nUn-customized rooms will take on this look. Per-room overrides are kept.`)) return;
    applyPresetToBuilding(name, roomKey);
    refreshDefaultsBox(ov, roomKey);   // defaults just changed
  };
  const applyRoomBtn = ov.querySelector('#roomGeomApplyPresetRoomBtn');
  if(applyRoomBtn) applyRoomBtn.onclick = () => {
    const name = ov.querySelector('#roomGeomPresetSelect').value;
    if(!name) return;
    if(!confirm(`Apply preset "${name}" to THIS room only?\n\nIts floor, walls, ceiling, stairs and doors will be set to the preset, replacing this room's current surface styling. Placed props are kept.`)) return;
    applyPresetToRoom(name, roomKey);
    closeRoomGeomDialog();   // surfaces changed -- close so the result is visible
  };
  const delBtn = ov.querySelector('#roomGeomDeletePresetBtn');
  if(delBtn) delBtn.onclick = () => {
    const name = ov.querySelector('#roomGeomPresetSelect').value;
    if(!name) return;
    if(!confirm(`Delete preset "${name}"? This cannot be undone.`)) return;
    deletePreset(name);
    refresh();
  };
}
// A room's true structural minimum width/depth -- reusing registerOneCastle's
// own door/pair-spacing formula, but against the room's CURRENT live doors
// and move-pairs (not the size it happened to be generated at), and with
// SMALL_ROOM_MIN as its floor instead of the generous 11x13 castle-generation
// default. A genuinely simple room -- one door, no side move-pairs -- can
// shrink well below its original generated size this way; a room that
// actually needs more (several side pairs, or 2+ doors sharing a wall) still
// floors out at whatever that content really requires, same as generation
// does. Elevator cars and outdoor rooms are handled elsewhere (ELEV_MIN_WD,
// not resizable at all) -- null here means "no relaxed floor, use the room's
// own generated size as-is".
const SMALL_ROOM_MIN = 8;
function relaxedContentMin(room, roomKey){
  if(room.outdoor || isElevatorCar(roomKey)) return null;
  const fwd = (room.exits || []).filter(ex => !ex.back);
  const byWallCount = { north: 0, east: 0, west: 0 };
  for(const ex of fwd) byWallCount[ex.wall] = (byWallCount[ex.wall] || 0) + 1;
  const span = c => c > 1 ? (c - 1) * DOOR_SPACING : 0;
  const slots = moveObjectSlots(roomKey);
  const sideMax = Math.max(
    slots.filter(s => s.side === 'left').length,
    slots.filter(s => s.side === 'right').length);
  const pairDepth = sideMax >= 1
    ? CAS_LAYOUT.entrySetback + CAS_LAYOUT.centerAhead + CAS_LAYOUT.sideFirst
      + (sideMax - 1) * CAS_LAYOUT.sideStride + CAS_LAYOUT.northMargin
    : 0;
  const maxEW = Math.max(byWallCount.east, byWallCount.west);
  const ewDepth = maxEW >= 1
    ? CAS_LAYOUT.entrySetback + CAS_LAYOUT.centerAhead + EW_BEHIND_HEAD
      + (maxEW - 1) * DOOR_SPACING + EDGE_MARGIN
    : 0;
  return {
    w: Math.max(SMALL_ROOM_MIN, span(byWallCount.north) + 2 * PAIR_MARGIN),
    d: Math.max(SMALL_ROOM_MIN, pairDepth, ewDepth),
  };
}
function renderRoomGeomDialog(ov, roomKey){
  const room = mergedRoom(roomKey);
  const { w, d, h } = room.size;
  // the room's own freshly-computed size (ROOMS[roomKey].size, NOT the merged/
  // overridden one) already reflects the true minimum needed to fit its actual
  // content -- move-pairs marching along the walls and doors spread across
  // the front -- so the dialog uses it as a per-room floor on top of the flat
  // ROOM_GEOM_MIN, keeping a shrink from clipping something in the first
  // place (the reconciler still catches anything that slips through, e.g.
  // already-saved data from before this floor existed).
  let contentMin = (ROOMS[roomKey] && ROOMS[roomKey].size) || room.size;
  // Without this a 7-floor car is forced gigantic even though only the
  // single elevator door is ever built -- see ELEV_MIN_WD.
  if(isElevatorCar(roomKey)){
    contentMin = { w: Math.min(contentMin.w, ELEV_MIN_WD), d: Math.min(contentMin.d, ELEV_MIN_WD), h: contentMin.h };
  } else {
    const relaxed = relaxedContentMin(room, roomKey);
    if(relaxed) contentMin = { w: Math.min(contentMin.w, relaxed.w), d: Math.min(contentMin.d, relaxed.d), h: contentMin.h };
  }
  // read straight off the static ROOMS config: exits, stairs and (outdoor)
  // building footprints don't move when the room is resized, so the live
  // preview overlays them on whatever width/depth the user is typing.
  const staticRoom = ROOMS[roomKey] || {};
  const staticExits = staticRoom.exits || [];
  const stairs = staticRoom.stairs || null;
  const buildings = staticRoom.buildings || [];

  // The compound room keys (cas:<instance>:<FEN>) are far too long to read as a
  // title or as door labels -- they overran the plan and the exit list. Collapse
  // them to something human: the modal title uses the room's own sign title, and
  // a doorway is labelled by the move that opens it (ex.label = the opponent
  // reply), falling back to the target room's title or a truncated tail.
  const roomTitle = roomNameFor(roomKey) || (ROOMS[roomKey] && ROOMS[roomKey].castleSign && ROOMS[roomKey].castleSign.title) || roomKey;
  const exitShortLabel = ex => {
    const named = roomNameFor(ex.target);
    if(named) return named;                           // a name the user gave the room
    if(ex.label) return ex.label;                     // else the move behind this door
    if(ex.target === 'mainStreet') return 'Street';
    if(ex.back) return 'Back';
    const t = ROOMS[ex.target] && ROOMS[ex.target].castleSign && ROOMS[ex.target].castleSign.title;
    if(t) return t;
    const tail = String(ex.target).split(':').pop();
    return tail.length > 12 ? tail.slice(0, 12) + '…' : tail;
  };

  // staged door state: target room -> {wall, offset, type}, seeded from any
  // existing override (or the static position/type) and only committed on
  // Apply. Single-sided by construction -- this only ever edits roomKey's
  // own exits. `type` defaults to 'door'; 'stair' grows a real protruding
  // corridor with climbing stairs through that wall (buildStairCorridor),
  // reaching ceiling height by the far end where the room transition fires.
  const stagedExits = {};
  for(const ex of staticExits){
    const ov2 = LAYOUT[roomKey] && LAYOUT[roomKey].exits && LAYOUT[roomKey].exits[ex.target];
    stagedExits[ex.target] = {
      wall: ov2 ? ov2.wall : ex.wall,
      offset: ov2 ? ov2.offset : ex.offset,
      type: (ov2 && ov2.type) || ex.type || 'door'
    };
  }
  // The current room's own exit controls. A normal room shows a door-type
  // dropdown per exit. An ELEVATOR CAR's exits aren't doors -- each forward
  // exit is a floor -- so the (meaningless) dropdown is replaced by a button
  // that assigns that floor's signature object (its destination room's head
  // object, obj-C1), the same object the panel shows and a normal door shows
  // beside it. The back exit gets nothing.
  const carMode = isElevatorCar(roomKey);
  const headObjSlotId = target => {
    const s = moveObjectSlots(target).find(sl => sl.side === 'center');
    return s ? s.id : 'obj-C1';
  };
  const objBtnLabel = target => {
    const slotId = headObjSlotId(target);
    // read the raw assigned asset id straight from LAYOUT (set synchronously
    // by setSlotOverride) rather than via slotAssetFor -> ASSET_BY_ID, which
    // is only repopulated by applyEdit's awaited refreshAssetMap() -- so the
    // label refreshes immediately after a pick instead of only on reopen.
    const rawId = LAYOUT[target] && LAYOUT[target].slots && LAYOUT[target].slots[slotId];
    if(rawId) return rawId;
    const word = slotWordFor(target, slotId);
    if(word && word.trim()) return word.trim();
    // no manual override -- this floor may still be showing something real,
    // supplied by the car's own assigned list (elevatorFloorListItem). Say so
    // rather than a flat "none", which previously read as "nothing is here"
    // even while the panel was actually showing a list item.
    if(carMode){
      const i = elevatorCarLayout(room).floors.findIndex(fe => fe.target === target);
      const r = i >= 0 ? elevatorFloorListItem(roomKey, i) : null;
      if(r) return (r.asset ? r.asset.id : r.word) + ' (from list)';
    }
    return 'none';
  };
  const exitTypeRows = staticExits.map(ex => {
    if(carMode){
      const right = ex.back
        ? `<span style="color:#888;font-size:.72rem">exit door</span>`
        : `<button type="button" data-elev-obj-for="${escHtml(ex.target)}" style="font-size:.72rem;max-width:11em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Object: ${escHtml(objBtnLabel(ex.target))}</button>`;
      return `
        <label style="display:flex;align-items:center;justify-content:space-between;font-size:.78rem;gap:.5rem;padding:.15rem 0">
          <span title="${escHtml(ex.target)}">${escHtml(exitShortLabel(ex))}${ex.back ? ' ↩' : ''}</span>
          ${right}
        </label>`;
    }
    return `
    <label style="display:flex;align-items:center;justify-content:space-between;font-size:.78rem;gap:.5rem;padding:.15rem 0">
      <span title="${escHtml(ex.target)}">${escHtml(exitShortLabel(ex))}${ex.back ? ' ↩' : ''}</span>
      <select data-exit-type-for="${ex.target}" style="font-size:.78rem">
        <option value="door" ${stagedExits[ex.target].type === 'door' ? 'selected' : ''}>Door</option>
        <option value="stair" ${stagedExits[ex.target].type === 'stair' ? 'selected' : ''}>Staircase (up)</option>
        <option value="stair-down" ${stagedExits[ex.target].type === 'stair-down' ? 'selected' : ''}>Staircase (down)</option>
        <option value="elevator" ${stagedExits[ex.target].type === 'elevator' ? 'selected' : ''}>Elevator</option>
      </select>
    </label>
  `;
  }).join('');
  const exitRowsCaption = carMode
    ? `<div style="font-size:.7rem;color:#888;margin-bottom:.15rem">Elevator floors — set each floor's object (its room's signature item shown on the panel).</div>`
    : '';
  // "Room names" section: name THIS room and, more usefully, the room behind
  // each forward door (back/exit doors are excluded). Naming a room edits the
  // same "Room Name" pref the tree's Attributes modal does (via setRoomName ->
  // onRoomRename), and surfaces as the door's in-world nameplate (buildDoorHint),
  // on the plan, and as that room's own title -- so the walk can be laid out
  // logically and each room themed to its name.
  const nameRow = (target, chip, chipColor) => `
    <label style="display:flex;align-items:center;gap:.5rem;font-size:.78rem;padding:.15rem 0">
      <span title="${escHtml(target)}" style="min-width:3.6em;color:${chipColor};font-weight:600;text-align:right">${escHtml(chip)}</span>
      <input type="text" data-room-name-for="${escHtml(target)}" value="${escHtml(roomNameFor(target))}" placeholder="name this room" style="flex:1;min-width:0;font-size:.78rem">
    </label>`;
  const forwardExits = staticExits.filter(ex => !ex.back);
  const roomNameRows = nameRow(roomKey, 'This', '#555')
    + forwardExits.map(ex => nameRow(ex.target, ex.label || 'door', '#2e7d32')).join('');
  ov.innerHTML = `
    <div class="modal" style="width:min(28em,92vw);max-height:92vh;overflow:auto">
      <h2 title="${escHtml(roomKey)}">Room Geometry — ${escHtml(roomTitle)}</h2>
      <div style="display:flex;gap:.7rem;flex-wrap:wrap;margin-bottom:.2rem">
        <label style="display:flex;flex-direction:column;font-size:.8rem;gap:.2rem">Width (m)
          <input type="number" step="0.1" min="${Math.max(ROOM_GEOM_MIN, contentMin.w)}" id="roomGeomW" value="${w}" style="width:6em">
        </label>
        <label style="display:flex;flex-direction:column;font-size:.8rem;gap:.2rem">Depth (m)
          <input type="number" step="0.1" min="${Math.max(ROOM_GEOM_MIN, contentMin.d)}" id="roomGeomD" value="${d}" style="width:6em">
        </label>
        <label style="display:flex;flex-direction:column;font-size:.8rem;gap:.2rem">Height (m)
          <input type="number" step="0.1" min="${Math.max(ROOM_GEOM_MIN, contentMin.h)}" id="roomGeomH" value="${h}" style="width:6em">
        </label>
      </div>
      <p style="margin:0 0 .5rem;font-size:.68rem;color:#888">Won't go below ${contentMin.w.toFixed(1)}×${contentMin.d.toFixed(1)}×${contentMin.h.toFixed(1)}m -- the size this room's own moves and doors need to fit without crowding.</p>
      <canvas id="roomGeomPlan" width="300" height="300" style="background:#eee;border-radius:4px;display:block;margin:0 auto .4rem;cursor:grab;touch-action:none"></canvas>
      <p style="margin:0 0 .5rem;font-size:.72rem;color:#888;text-align:center">Top-down plan. Drag a doorway to nudge it or move it to another wall. Hatched = stairs platform.</p>
      ${exitTypeRows ? `<div style="border-top:1px solid #e0e0e0;padding-top:.4rem;margin-bottom:.7rem">${exitRowsCaption}${exitTypeRows}<div id="roomGeomExitError" style="color:#c62828;font-size:.72rem;line-height:1.3;margin-top:.2rem"></div></div>` : ''}
      <div style="border-top:1px solid #e0e0e0;padding-top:.4rem;margin-bottom:.7rem">
        <div style="font-size:.72rem;color:#888;margin-bottom:.15rem">Room names — label the room behind each door to plan the walk and theme its decor.</div>
        ${roomNameRows}
      </div>
      <div id="roomGeomDefaultsBox" style="border:1px solid #e0e0e0;border-radius:4px;padding:.4rem .5rem;margin-bottom:.5rem">${defaultsBoxHtml(roomKey)}</div>
      <div id="roomGeomPresetsBox" style="border:1px solid #e0e0e0;border-radius:4px;padding:.4rem .5rem;margin-bottom:.6rem">${presetsBoxHtml(roomKey)}</div>
      <label style="display:flex;align-items:flex-start;gap:.45rem;font-size:.76rem;color:#555;margin-bottom:.6rem;line-height:1.3">
        <input type="checkbox" id="roomGeomMakeDefault" style="margin-top:.15rem">
        <span>On Apply, make this room's floor / walls / ceiling / stairs / doors the default for new rooms in this building (walls are anchored to the entrance door; the exit door and locked doors each keep their own style).</span>
      </label>
      <div class="modal-actions" style="display:flex;justify-content:space-between;align-items:center">
        <div style="display:flex;gap:.4rem">
          <button id="roomGeomResetBtn">Reset size/doors</button>
          <button id="roomGeomClearBtn" style="background:#c62828;color:#fff">Reset Room…</button>
        </div>
        <div>
          <button id="roomGeomCancelBtn">Cancel</button>
          <button id="roomGeomApplyBtn">Apply</button>
        </div>
      </div>
    </div>
  `;
  const wEl = ov.querySelector('#roomGeomW'), dEl = ov.querySelector('#roomGeomD'), hEl = ov.querySelector('#roomGeomH');
  const canvas = ov.querySelector('#roomGeomPlan');
  const exitErrEl = ov.querySelector('#roomGeomExitError');
  for(const sel of ov.querySelectorAll('[data-exit-type-for]')){
    sel.addEventListener('change', () => {
      const target = sel.dataset.exitTypeFor;
      // "Elevator" only makes sense for a door into a room that branches into
      // several separate rooms; reject a corridor/two-track/too-few-doors
      // target and revert the dropdown rather than build a nonsensical car.
      if(sel.value === 'elevator'){
        const reason = elevatorRejectReason(target);
        if(reason){
          if(exitErrEl) exitErrEl.textContent = reason;
          sel.value = stagedExits[target].type;   // revert to the last valid choice
          return;
        }
      }
      if(exitErrEl) exitErrEl.textContent = '';
      stagedExits[target].type = sel.value;
      drawPlan();
    });
  }
  // elevator-floor object buttons: open the asset picker for that floor's
  // destination-room head object (the same slot a normal door's object
  // assigns). The picker (z 60) sits below this dialog (z 70), so hide the
  // dialog while it's open and restore on close; the object label refreshes
  // once something is actually picked/removed (onClose fires first, before
  // onPick, so the refresh rides on the pick/remove/word callbacks).
  for(const btn of ov.querySelectorAll('[data-elev-obj-for]')){
    btn.addEventListener('click', () => {
      const target = btn.dataset.elevObjFor;
      const slotId = headObjSlotId(target);
      const refresh = () => { btn.textContent = 'Object: ' + objBtnLabel(target); };
      ov.style.display = 'none';
      openAssetPicker({
        allow: PROP_TYPES, allowRemove: !!(slotAssetFor(target, slotId) || slotWordFor(target, slotId)),
        allowWord: true, currentWord: slotWordFor(target, slotId),
        onPick: id => { setSlotOverride(target, slotId, id); refresh(); },
        onRemove: () => { setSlotOverride(target, slotId, null); refresh(); },
        onWordApply: word => { setSlotWordOverride(target, slotId, word); refresh(); },
        onClose: () => { ov.style.display = 'flex'; },
      });
    });
  }
  // room-name inputs: persist on commit (blur/Enter) and redraw the plan so the
  // door's label updates to the new name straight away. setRoomName rebuilds the
  // current room too, refreshing the in-world door nameplates.
  for(const inp of ov.querySelectorAll('[data-room-name-for]')){
    inp.addEventListener('change', () => {
      setRoomName(inp.dataset.roomNameFor, inp.value);
      drawPlan();
    });
  }
  let dragTarget = null;     // staticExits[i].target currently being dragged
  let dragStartWall = null;  // wall the drag began on, used as the fallback when the candidate wall is occupied

  // top-down plan: world +x is east (right), +z is south (down), so north is
  // at the top of the canvas -- matches walking in facing north. planGeom()
  // is shared by drawPlan and the pointer handlers below so drag math uses
  // exactly the same projection as the render.
  const planGeom = () => {
    const W = canvas.width, H = canvas.height;
    const rw = Math.max(0.1, Number(wEl.value) || 0), rd = Math.max(0.1, Number(dEl.value) || 0);
    const margin = 30;
    const scale = Math.min((W - margin*2) / rw, (H - margin*2) / rd);
    const pw = rw * scale, pd = rd * scale;
    const ox = (W - pw) / 2, oy = (H - pd) / 2;
    return {
      W, H, rw, rd, scale, pw, pd, ox, oy,
      px: (x) => ox + pw/2 + x*scale,
      pz: (z) => oy + pd/2 + z*scale,
      worldX: (cx) => (cx - ox - pw/2) / scale,
      worldZ: (cz) => (cz - oy - pd/2) / scale
    };
  };

  const drawPlan = () => {
    const ctx = canvas.getContext('2d');
    const { W, H, rw, rd, scale, pw, pd, ox, oy, px, pz } = planGeom();
    ctx.clearRect(0, 0, W, H);

    // stair footprint: full width, from its south edge (fromZ) up to the north
    // wall, drawn as a diagonal hatch with an arrow toward the high (north) end.
    if(stairs){
      const z0 = pz(Math.max(stairs.fromZ, -rd/2)), z1 = pz(-rd/2);
      const top = Math.min(z0, z1), bot = Math.max(z0, z1);
      ctx.save();
      ctx.beginPath(); ctx.rect(ox, top, pw, bot - top); ctx.clip();
      ctx.fillStyle = 'rgba(120,120,120,.18)';
      ctx.fillRect(ox, top, pw, bot - top);
      ctx.strokeStyle = 'rgba(80,80,80,.5)'; ctx.lineWidth = 1;
      for(let x = ox - pd; x < ox + pw; x += 8){
        ctx.beginPath(); ctx.moveTo(x, bot); ctx.lineTo(x + (bot - top), top); ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = '#555'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('stairs ↑', ox + pw/2, (top + bot)/2 + 3);
    }

    // outdoor street: sketch each building footprint so the plan isn't empty
    for(const b of buildings){
      const bw = b.size.w*scale, bd = b.size.d*scale;
      ctx.fillStyle = 'rgba(21,101,192,.12)';
      ctx.fillRect(px(b.origin.x) - bw/2, pz(b.origin.z) - bd/2, bw, bd);
      ctx.strokeStyle = 'rgba(21,101,192,.6)'; ctx.lineWidth = 1;
      ctx.strokeRect(px(b.origin.x) - bw/2, pz(b.origin.z) - bd/2, bw, bd);
    }

    // room outline
    ctx.fillStyle = 'rgba(255,255,255,.0)';
    ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, pw, pd);

    // stair-exit corridors: a real protrusion through the wall (see
    // buildStairCorridor), previewed here as an outlined box poking outward
    // from the doorway so the geometry change reads on the plan, not just
    // in-world. Depth mirrors stairCorridorGeom's formula against the
    // height field currently typed into the dialog.
    {
      const rise = Math.max(0.1, Number(hEl.value) || 0);
      const steps = Math.max(4, Math.ceil(rise / STAIR_STEP_RISE));
      const corridorDepthPx = steps * STAIR_STEP_RUN * scale;
      const doorPxC = DOOR_W * scale;
      for(const ex of staticExits){
        const pos = stagedExits[ex.target];
        if(!isStairType(pos.type)) continue;
        const isDown = pos.type === 'stair-down';
        ctx.strokeStyle = isDown ? '#9e9e9e' : '#8d6e63'; ctx.lineWidth = 1.5; ctx.setLineDash([3,2]);
        ctx.fillStyle = isDown ? 'rgba(158,158,158,.16)' : 'rgba(141,110,99,.12)';
        let rx, ry, rw2, rh2;
        if(pos.wall === 'north'){ rx = px(pos.offset)-doorPxC/2; ry = oy - corridorDepthPx; rw2 = doorPxC; rh2 = corridorDepthPx; }
        if(pos.wall === 'south'){ rx = px(pos.offset)-doorPxC/2; ry = oy + pd; rw2 = doorPxC; rh2 = corridorDepthPx; }
        if(pos.wall === 'west'){  rx = ox - corridorDepthPx; ry = pz(pos.offset)-doorPxC/2; rw2 = corridorDepthPx; rh2 = doorPxC; }
        if(pos.wall === 'east'){  rx = ox + pw; ry = pz(pos.offset)-doorPxC/2; rw2 = corridorDepthPx; rh2 = doorPxC; }
        ctx.fillRect(rx, ry, rw2, rh2);
        ctx.strokeRect(rx, ry, rw2, rh2);
        ctx.setLineDash([]);
      }
    }

    // doorways: a green segment laid over the wall at the exit's offset, plus
    // the target room name just inside the opening.
    const doorPx = DOOR_W * scale;
    ctx.font = '9px sans-serif';
    for(const ex of staticExits){
      const pos = stagedExits[ex.target];
      const dragging = dragTarget === ex.target;
      const isStair = isStairType(pos.type);
      const isDown = pos.type === 'stair-down';
      const baseColor = isDown ? '#9e9e9e' : isStair ? '#8d6e63' : '#2e7d32';
      const labelColor = isDown ? '#616161' : isStair ? '#4e342e' : '#1b5e20';
      ctx.fillStyle = dragging ? '#f9a825' : baseColor;
      ctx.strokeStyle = dragging ? '#f9a825' : baseColor; ctx.lineWidth = dragging ? 6 : 4;
      ctx.setLineDash(isStair && !dragging ? [4, 3] : []);
      let lx, ly;                              // label anchor, just inside the wall
      ctx.beginPath();
      if(pos.wall === 'north'){ const cx = px(pos.offset); ctx.moveTo(cx - doorPx/2, oy); ctx.lineTo(cx + doorPx/2, oy); lx = cx; ly = oy + 11; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; }
      if(pos.wall === 'south'){ const cx = px(pos.offset); ctx.moveTo(cx - doorPx/2, oy+pd); ctx.lineTo(cx + doorPx/2, oy+pd); lx = cx; ly = oy + pd - 4; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; }
      if(pos.wall === 'west'){  const cz = pz(pos.offset); ctx.moveTo(ox, cz - doorPx/2); ctx.lineTo(ox, cz + doorPx/2); lx = ox + 3; ly = cz; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; }
      if(pos.wall === 'east'){  const cz = pz(pos.offset); ctx.moveTo(ox+pw, cz - doorPx/2); ctx.lineTo(ox+pw, cz + doorPx/2); lx = ox + pw - 3; ly = cz; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; }
      ctx.stroke();
      ctx.setLineDash([]);
      const label = exitShortLabel(ex) + (ex.back ? ' ↩' : '') + (isDown ? ' ⌐↓' : isStair ? ' ⌐↑' : '');
      ctx.fillStyle = dragging ? '#7a4a00' : labelColor;
      ctx.fillText(label, lx, ly);
    }
    ctx.textBaseline = 'alphabetic';

    // compass letters just outside each wall
    ctx.fillStyle = '#999'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('N', ox + pw/2, oy - 6);
    ctx.fillText('S', ox + pw/2, oy + pd + 16);
    ctx.fillText('W', ox - 14, oy + pd/2 + 4);
    ctx.fillText('E', ox + pw + 14, oy + pd/2 + 4);

    // dimensions caption
    ctx.fillStyle = '#666'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    const hv = Number(hEl.value) || 0;
    ctx.fillText(`${rw.toFixed(1)} × ${rd.toFixed(1)} m  (height ${hv.toFixed(1)} m)`, W/2, H - 6);
  };
  [wEl, dEl, hEl].forEach(el => el.addEventListener('input', drawPlan));

  // hit-tests a canvas-space point against each staged doorway segment,
  // returning the target room of the closest one within the pick radius.
  const hitTestDoor = (cx, cz, pad) => {
    const { px, pz, scale } = planGeom();
    const doorPx = DOOR_W * scale;
    pad = pad || 8;
    let best = null, bestDist = Infinity;
    for(const ex of staticExits){
      const pos = stagedExits[ex.target];
      let dist;
      let segX0, segY0, segX1, segY1;
      if(pos.wall === 'north'){ const cxp = px(pos.offset); const { oy } = planGeom(); segX0 = cxp - doorPx/2; segY0 = oy; segX1 = cxp + doorPx/2; segY1 = oy; }
      else if(pos.wall === 'south'){ const cxp = px(pos.offset); const { oy, pd } = planGeom(); segX0 = cxp - doorPx/2; segY0 = oy + pd; segX1 = cxp + doorPx/2; segY1 = oy + pd; }
      else if(pos.wall === 'west'){ const czp = pz(pos.offset); const { ox } = planGeom(); segX0 = ox; segY0 = czp - doorPx/2; segX1 = ox; segY1 = czp + doorPx/2; }
      else { const czp = pz(pos.offset); const { ox, pw } = planGeom(); segX0 = ox + pw; segY0 = czp - doorPx/2; segX1 = ox + pw; segY1 = czp + doorPx/2; }
      const midX = (segX0 + segX1)/2, midY = (segY0 + segY1)/2;
      const along = pos.wall === 'north' || pos.wall === 'south' ? Math.abs(cx - midX) : Math.abs(cz - midY);
      const across = pos.wall === 'north' || pos.wall === 'south' ? Math.abs(cz - midY) : Math.abs(cx - midX);
      if(along <= doorPx/2 + pad && across <= pad){
        dist = along + across;
        if(dist < bestDist){ bestDist = dist; best = ex.target; }
      }
    }
    return best;
  };

  // returns true if `wall`/`offset` would overlap another exit already
  // staged on that wall (excluding `exceptTarget`, the one being dragged).
  const wallOccupied = (wall, offset, exceptTarget) => {
    for(const target in stagedExits){
      if(target === exceptTarget) continue;
      const pos = stagedExits[target];
      if(pos.wall === wall && Math.abs(pos.offset - offset) < DOOR_W + 0.2) return true;
    }
    return false;
  };

  // touch-action:none (set on the canvas above) keeps the browser from ever
  // claiming the gesture as a page scroll/pan, which is what was causing the
  // drag to spontaneously cancel after a few pixels of movement on mobile --
  // without it, the OS would intermittently decide mid-drag that this was a
  // scroll and hand off to native scrolling, firing pointercancel. Touch
  // points also get a larger hit pad since a fingertip is far less precise
  // than a mouse cursor.
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const cz = (e.clientY - rect.top) * (canvas.height / rect.height);
    const pad = e.pointerType === 'touch' ? 18 : 8;
    const hit = hitTestDoor(cx, cz, pad);
    if(!hit) return;
    dragTarget = hit;
    dragStartWall = stagedExits[hit].wall;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    drawPlan();
  });
  canvas.addEventListener('pointermove', (e) => {
    if(!dragTarget) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const cz = (e.clientY - rect.top) * (canvas.height / rect.height);
    const { rw, rd, worldX, worldZ } = planGeom();
    const wx = worldX(cx), wz = worldZ(cz);
    let candidate = nearestWallPoint(rw, rd, wx, wz);
    if(candidate.wall !== dragStartWall && wallOccupied(candidate.wall, candidate.offset, dragTarget)){
      // candidate wall is taken -- fall back to sliding along the wall the drag started on
      const marginW = DOOR_W/2 + 0.3;
      if(dragStartWall === 'north' || dragStartWall === 'south'){
        candidate = { wall: dragStartWall, offset: clampNum(wx, -rw/2 + marginW, rw/2 - marginW) };
      } else {
        candidate = { wall: dragStartWall, offset: clampNum(wz, -rd/2 + marginW, rd/2 - marginW) };
      }
    }
    if(!wallOccupied(candidate.wall, candidate.offset, dragTarget)){
      stagedExits[dragTarget] = { wall: candidate.wall, offset: candidate.offset, type: stagedExits[dragTarget].type };
    }
    drawPlan();
  });
  const endDrag = (e) => {
    if(e) e.preventDefault();
    dragTarget = null;
    dragStartWall = null;
    canvas.style.cursor = 'grab';
    drawPlan();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  drawPlan();
  wireDefaultsBox(ov, roomKey);
  wirePresetsBox(ov, roomKey);
  ov.querySelector('#roomGeomCancelBtn').onclick = closeRoomGeomDialog;
  ov.querySelector('#roomGeomResetBtn').onclick = () => {
    const base = ROOMS[roomKey].size;
    wEl.value = base.w; dEl.value = base.d; hEl.value = base.h;
    for(const ex of staticExits){
      stagedExits[ex.target] = { wall: ex.wall, offset: ex.offset, type: ex.type || 'door' };
      const sel = ov.querySelector(`[data-exit-type-for="${ex.target}"]`);
      if(sel) sel.value = stagedExits[ex.target].type;
    }
    // resetting the geometry to the just-cleared/base room shouldn't then push it
    // out as the building default
    ov.querySelector('#roomGeomMakeDefault').checked = false;
    drawPlan();
  };
  ov.querySelector('#roomGeomClearBtn').onclick = () => {
    // a wiped room must never be captured as the default, so drop the checkbox first
    ov.querySelector('#roomGeomMakeDefault').checked = false;
    if(!confirm(
      `Reset "${roomKey}" back to a brand-new, never-customized room?\n\n` +
      `The floor, walls, ceiling, stairs, door skins, every placed prop and its ` +
      `nudge, object-list wall assignments, the room's size, and its doors' ` +
      `positions/types will ALL be permanently reset. The room falls back to the ` +
      `building defaults (floor/wall/ceiling/door skins), same as a genuinely new ` +
      `room. Room names and building defaults are kept.\n\nThis cannot be undone.`
    )) return;
    closeRoomGeomDialog();
    clearRoomStyles(roomKey);     // wipes this room only; LAYOUT.__defaults is untouched
  };
  ov.querySelector('#roomGeomApplyBtn').onclick = () => {
    const w2 = Math.max(ROOM_GEOM_MIN, contentMin.w, Number(wEl.value) || room.size.w);
    const d2 = Math.max(ROOM_GEOM_MIN, contentMin.d, Number(dEl.value) || room.size.d);
    const h2 = Math.max(ROOM_GEOM_MIN, contentMin.h, Number(hEl.value) || room.size.h);
    const makeDefault = ov.querySelector('#roomGeomMakeDefault').checked;
    closeRoomGeomDialog();
    if(makeDefault) captureBuildingDefaults(roomKey);   // snapshot before the rebuild so the readout/rooms pick it up
    commitRoomGeomDialog(roomKey, { w: w2, d: d2, h: h2 }, stagedExits);
  };
}

function onResize(){
  if(!container || !renderer || !camera) return;
  const w = container.clientWidth, h = container.clientHeight;
  if(w===0 || h===0) return;
  renderer.setSize(w, h);
  camera.aspect = w/h;
  camera.updateProjectionMatrix();
}

// Called when a modal outside threeTest (the asset manager) is opened on top
// of the canvas, so stray keystrokes meant for its text fields don't walk the
// player or toggle edit mode behind it; also drops any keys held at the
// moment it opens so the player doesn't keep walking once it's covered.
export function setForeignModalOpen(open){
  foreignModalOpen = open;
  if(open){
    for(const k in keys) keys[k] = false;
    // drop any in-progress joystick tilt so the player doesn't keep walking
    joyVec.x = 0; joyVec.y = 0; joyPointerId = null;
    if(joyKnob) joyKnob.style.transform = 'translate(0px,0px)';
  }
}

function onKeyDown(e){
  if(foreignModalOpen) return;
  // Undo/redo -- ahead of the selectedProp branch below so it works whether
  // or not something is currently selected. Ctrl+Z / Cmd+Z undoes; adding
  // Shift, or Ctrl+Y, redoes (Ctrl+Y is the common Windows-only alt binding).
  if(editMode && !inputLocked && (e.ctrlKey || e.metaKey)){
    const k = e.key.toLowerCase();
    if(k === 'z'){ e.preventDefault(); if(e.shiftKey) redoEdit(); else undoEdit(); return; }
    if(k === 'y'){ e.preventDefault(); redoEdit(); return; }
  }
  if(selectedProp && !inputLocked){
    if(e.key === 'Escape'){ deselectProp(); return; }
    // mnemonic billboards aren't asset-based -- there's nothing for the
    // picker to swap, so Enter is a no-op for them.
    if(e.key === 'Enter' && selectedProp.kind !== 'mnemonic'){
      openManagerForSelection(); return;
    }
    if(e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
      nudgeSelected(e.key);
      return;
    }
    // h/l (or PageUp/PageDown) raise/lower the height: mnemonic billboards float
    // free, and a move-object can be lifted off the floor the same way.
    if((selectedProp.kind === 'mnemonic' || selectedProp.kind === 'moveObject') &&
       (e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'h' || e.key === 'H' || e.key === 'l' || e.key === 'L')){
      nudgeSelected(e.key);
      return;
    }
    if(e.key === '+' || e.key === '='){ scaleSelected(SCALE_STEP); return; }
    if(e.key === '-' || e.key === '_'){ scaleSelected(1/SCALE_STEP); return; }
    // < / > rotate a floor prop (the unshifted , / . on the same keys work too)
    if(e.key === '<' || e.key === ','){ rotateSelected(-1); return; }
    if(e.key === '>' || e.key === '.'){ rotateSelected(1); return; }
    return; // swallow everything else while a prop is selected (no walking/turning)
  }
  // 'e' strafes right (q/e sidestep, handled via the keys map in tick), so it's
  // deliberately NOT an edit-mode shortcut; use the pencil toolbar button. Esc
  // still exits edit mode.
  if(e.key === 'Escape' && editMode){ setEditMode(false); return; }
  // R resets to THIS room's own entrance (handy after wandering off while
  // decorating); H is the "go all the way back" shortcut, to Main Street.
  // On Main Street itself there's no separate "entrance" to distinguish --
  // entrySpawnFor's generic room fallback isn't sized for the street's own
  // (much larger, differently-computed) footprint, so R just matches H there.
  if(e.key === 'r' || e.key === 'R'){
    if(currentRoomKey === START_ROOM) enterRoom(START_ROOM, START_SPAWN);
    else respawnAtEntry(currentRoomKey);
    return;
  }
  if(e.key === 'h' || e.key === 'H'){ enterRoom(START_ROOM, START_SPAWN); return; }
  // B instantly takes the room's own back door -- same target/spawn the
  // physical walk-through would use (reuses exitMeta, which already has the
  // CURRENT, possibly-dynamic target -- see roomEnteredFrom), just without
  // needing to actually walk there first. Routed through fireDoorTrigger (not
  // a direct enterRoom call) so it records roomEnteredFrom the same as a real
  // walk-through would. No-op where there's no back exit at all (Main Street).
  if(e.key === 'b' || e.key === 'B'){
    const m = exitMeta.find(m => m.back);
    if(m) fireDoorTrigger(m);
    return;
  }
  // Space jumps forward -- covers ground fast while testing/decorating
  // without leaving the keyboard. e.preventDefault() so it doesn't also
  // scroll the page or "click" a focused button, the browser's default
  // behavior for a bare spacebar press.
  if(e.key === ' '){ e.preventDefault(); jumpForward(); return; }
  keys[e.key] = true;
}
function onKeyUp(e){ keys[e.key] = false; }

export async function openThreeTest(containerEl, opts){
  container = containerEl;
  threeOpts = opts || {};
  if(threeOpts.piecesFile) PIECES_FILE_URL = threeOpts.piecesFile;
  OPENING_SYSTEMS = threeOpts.systems || [];
  _beardImg = undefined;                 // re-read the disambiguator image each time the walk opens
  // register every BUILT castle's rooms first (each namespaced by its instance
  // id), then lay out the streets with a building per castle wired to its entry
  // room — walking in the front door enters the castle, and its entry room's
  // back door leads back out to the street.
  clearGeneratedCastle();
  const streetCastles = [];
  for(const c of (threeOpts.castles || [])){
    const reg = registerOneCastle({ genRooms: c.genRooms }, c.instanceId, { backToStreet: true });
    if(reg) streetCastles.push({ ...c, entryKey: reg.entryKey });
  }
  generateMainStreet(OPENING_SYSTEMS, streetCastles);   // Main Street + one side street per opening system
  if(!THREE) THREE = await import('https://esm.sh/three@0.160.0');
  if(!textureLoader) textureLoader = new THREE.TextureLoader();
  THREE.Cache.enabled = true;   // reuse decoded prop textures across rebuilds
  // start each walk from fresh mnemonic/image caches (they may have been edited
  // since last time), then warm the mnemonics read so the first room's billboards
  // resolve their images without the per-billboard IndexedDB stall.
  clearMnemonicsCache(); _moveImgCache.clear();
  getMnemonicsCached();

  editMode = false;
  inputLocked = false;
  editUndoStack = []; editRedoStack = []; lastXformUndoKey = null;
  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  // five independent IDB reads, each populating its own module global with no
  // cross-dependency on the others' results -- run concurrently rather than
  // one round-trip after another.
  await Promise.all([loadLayout(), loadMemorized(), loadMemorizedShapes(), loadDecorated(), refreshAssetMap(), refreshObjectLists()]);

  container.innerHTML = '';
  renderer = new THREE.WebGLRenderer({ antialias:true });
  // without this, the OS can decide mid-gesture that a touch-drag on the
  // gizmo arrows (onGizmoPointerDown/Move below) is actually a page scroll
  // and hand off to native scrolling, firing pointercancel a few pixels in --
  // the exact "drag stops working after a short distance" mobile bug this
  // was added for. Same fix already applied to the room-geometry dialog's
  // own door-drag canvas -- see its "touch-action:none" comment.
  renderer.domElement.style.touchAction = 'none';
  container.appendChild(renderer.domElement);

  // editor HUD overlay (hidden until edit mode is on)
  editHud = document.createElement('div');
  // sits just below the top-left icon toolbar so the two don't overlap
  editHud.style.cssText = 'position:absolute;top:62px;left:8px;padding:.35rem .6rem;'
    + 'background:rgba(21,101,192,.85);color:#fff;font:600 .8rem sans-serif;'
    + 'border-radius:4px;pointer-events:none;display:none;z-index:2;max-width:calc(100% - 16px)';
  editHud.textContent = 'EDIT MODE — click floor / wall / stairs / slot / doorway to set; [Esc] to exit';
  container.appendChild(editHud);

  // transient top-center toast (e.g. the room-bounds auto-fix notice) — hidden
  // until showToast() is called, fades itself back out after a few seconds.
  toastEl = document.createElement('div');
  toastEl.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);'
    + 'padding:.4rem .8rem;background:rgba(21,101,192,.9);color:#fff;font:600 .8rem sans-serif;'
    + 'border-radius:4px;pointer-events:none;display:none;z-index:3;max-width:calc(100% - 16px);'
    + 'text-align:center;transition:opacity .4s';
  container.appendChild(toastEl);

  // top-left icon toolbar (hints / edit / room / assets / close / help)
  hintsOn = (() => { try{ return localStorage.getItem('threeHintsOn') !== '0'; }catch(_){ return true; } })();
  toolbarEl = buildTopToolbar();
  container.appendChild(toolbarEl);
  helpOverlay = buildHelpOverlay();
  container.appendChild(helpOverlay);
  updateToolbar();

  // mobile controls (touch devices only): walk joystick + the move/scale pad
  // shown while a prop is selected
  joystickEl = buildJoystick();
  if(joystickEl) container.appendChild(joystickEl);
  editTouchEl = buildEditTouch();
  if(editTouchEl) container.appendChild(editTouchEl);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111317);
  camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  clock = new THREE.Clock();
  keys = {};

  onResize();
  resizeObs = new ResizeObserver(onResize);
  resizeObs.observe(container);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  renderer.domElement.addEventListener('click', onCanvasClick);
  renderer.domElement.addEventListener('pointerdown', onGizmoPointerDown);

  // linked castles: any OTHER castle the previewed one has a redirected door
  // into (see gatherLinkedCastles in app.js) -- registered so those doors
  // resolve to the real, canonically-decorated room instead of dead-ending.
  // No street/back-door wiring (they're not on a street in preview mode);
  // Close remains the way out once you've walked into one.
  for(const c of (threeOpts.linkedCastles || [])){
    registerOneCastle({ genRooms: c.genRooms }, c.instanceId, {});
  }
  // a single generated castle (the report's Walk in VR): register its rooms and
  // spawn straight into the entry; otherwise start on Main Street as usual.
  const cas = threeOpts.castle
    ? registerOneCastle(threeOpts.castle, threeOpts.castleInstanceId, {})
    : null;
  // an explicit start room (e.g. "Jump to VR" from the digraph) wins over both
  // -- it lands the freshly-opened world directly on the target room instead
  // of the street or a castle's own entry.
  if(threeOpts.startRoomKey && ROOMS[threeOpts.startRoomKey]) enterRoom(threeOpts.startRoomKey, { x:0, z:0, yaw:0 });
  else if(cas) enterRoom(cas.entryKey, cas.spawn);
  else enterRoom(START_ROOM, START_SPAWN);
  tick();

  // test-only hook (off unless the debug flag is set) so the layout editor can
  // be driven deterministically without scripting the walk into a room
  if(localStorage.getItem('threeTestDebug')){
    window.__threeTestEdit = {
      enter: (k) => enterRoom(k, { x:0, z:0, yaw:0 }),
      toggle: () => setEditMode(!editMode),
      editMode: () => editMode,
      target: (ud) => handleEditTarget(ud),
      // the currently selected prop (null if none) -- for testing that a
      // room transition clears it instead of carrying it over (see enterRoom).
      selected: () => selectedProp,
      // translate gizmo (phase 1): which axes are currently shown (e.g.
      // asserting a 'floor' prop gets only x/z, no 'up'), and a
      // screen-space point on a given arrow so a test can dispatch REAL
      // pointerdown/pointermove/pointerup at that spot -- exercising the
      // actual raycast/plane-projection math onGizmoPointerDown/Move use,
      // rather than bypassing it with a hook that just calls
      // setSlotXformLive directly.
      gizmoAxes: () => selectionGizmo.map(a => a.userData.axis),
      // render-queue info for the outline/gizmo materials -- a door skin's
      // own material is transparent, and three.js always draws the WHOLE
      // opaque queue before the WHOLE transparent queue regardless of
      // renderOrder, so both need transparent:true too (see buildGizmoArrow's
      // own comment) or a door skin drawn later just paints over them.
      selectionRenderInfo: () => ({
        outline: selectionOutline
          ? { transparent: selectionOutline.material.transparent, depthTest: selectionOutline.material.depthTest, renderOrder: selectionOutline.renderOrder }
          : null,
        gizmo: selectionGizmo.length
          ? (() => { const shaft = selectionGizmo[0].children[0]; return { transparent: shaft.material.transparent, depthTest: shaft.material.depthTest, renderOrder: shaft.renderOrder }; })()
          : null,
      }),
      gizmoArrowScreenPoint: (axis) => {
        const arrow = selectionGizmo.find(a => a.userData.axis === axis);
        if(!arrow || !renderer) return null;
        const tip = arrow.userData.origin.clone().addScaledVector(arrow.userData.dir, GIZMO_LEN * 0.85);
        tip.project(camera);
        const rect = renderer.domElement.getBoundingClientRect();
        return { x: rect.left + (tip.x + 1) / 2 * rect.width, y: rect.top + (1 - tip.y) / 2 * rect.height };
      },
      // whether a gizmo-arrow drag is currently in progress (onGizmoPointerDown
      // set gizmoDrag, no matching pointerup/pointercancel/new-drag has ended
      // it yet) -- for testing that an OS-interrupted touch drag (pointercancel,
      // simulated here since Playwright's mouse API has no touch-cancel of its
      // own) actually clears this rather than leaking it forever.
      gizmoDragActive: () => !!gizmoDrag,
      // edit-mode undo/redo (see snapshotLayoutForUndo/snapshotForXformEdit):
      // stack depths for asserting availability, plus direct triggers so a
      // test can invoke them without needing real key focus, and a snapshot
      // of LAYOUT for asserting exactly what got reverted/restored.
      undoDepth: () => editUndoStack.length,
      redoDepth: () => editRedoStack.length,
      undo: () => undoEdit(),
      redo: () => redoEdit(),
      layoutSnapshot: () => JSON.parse(JSON.stringify(LAYOUT)),
      room: () => currentRoomKey,
      // occurrence stats ("N (M%)") on the current (or a given) room's
      // exits -- how often that exact opponent reply has actually occurred
      // in the user's own games, threaded through buildGeneratedCastle ->
      // registerOneCastle -> ROOMS[key].exits. wall/offset added for testing
      // the member-anchored side-door placement (memorized-room-stability).
      exits: (roomKeyArg) => (mergedRoom(roomKeyArg || currentRoomKey)?.exits || [])
        .map(e => ({ target: e.target, back: !!e.back, occurrence: e.occurrence || null, wall: e.wall, offset: e.offset })),
      // "disappearing transpositions" Phase 3: whether the CURRENT room has
      // an actual live, walkable trigger to `targetKey` -- exits() above
      // reflects the static castle graph (still lists a locked/broken
      // door's own edge), this reflects exitMeta/elevatorMeta, the RUNTIME
      // list buildRoom actually wires up triggers from. A door whose target
      // doesn't resolve to a real room gets excluded from this (see
      // buildRoom's own "locked" check) even though exits() above still
      // shows it.
      hasLiveDoorTo: (targetKey) => exitMeta.some(m => m.target === targetKey)
        || elevatorMeta.some(m => m.target === targetKey || (m.floors || []).some(f => f.target === targetKey)),
      // "memorized" toggle (Phase 1): drives the real toggleMemorized()/toolbar
      // state so a test doesn't need to click the actual button DOM element.
      memorized: () => MEMORIZED[currentRoomKey] || null,
      toggleMemorized: () => toggleMemorized(),
      setMemorized: (key, val) => {
        if(val) MEMORIZED[key] = Date.now(); else delete MEMORIZED[key];
        persistMemorized();
        updateToolbar();
      },
      // memorized-room-stability Phase 1: the live shape this generation
      // computed for a room (independent of whether it's memorized), and the
      // snapshot actually captured for a memorized room -- for testing that
      // toggleMemorized snapshots/drops the right thing.
      roomShape: (roomKeyArg) => (ROOMS[roomKeyArg || currentRoomKey] || {}).shape || null,
      memorizedShape: (roomKeyArg) => MEMORIZED_SHAPES[roomKeyArg || currentRoomKey] || null,
      memBtnStyle: () => memBtn ? { display: memBtn.style.display, background: memBtn.style.background } : null,
      decoratedBadgeStyle: () => decoratedBadge ? { display: decoratedBadge.style.display } : null,
      // memorized-room-stability Phase 2: the dirty badge's visibility, and
      // the underlying computed flag directly (roomKeyArg optional, defaults
      // to the current room) -- mirrors decoratedBadgeStyle/decorated above.
      dirtyBadgeStyle: () => dirtyBadge ? { display: dirtyBadge.style.display } : null,
      isRoomDirty: (roomKeyArg) => isRoomDirty(roomKeyArg || currentRoomKey),
      // the fading toast's current text (null if not currently shown) --
      // showToast() has no DOM id, so this is the only way to check it fired
      // without scraping the whole container for an untagged div.
      toastText: () => (toastEl && toastEl.style.display !== 'none') ? toastEl.textContent : null,
      // live WebGL resource counts (renderer.info.memory), incremented on
      // GPU upload and decremented on .dispose() -- for testing that
      // repeated rebuilds (buildRoom runs on nearly every edit) actually
      // free the PREVIOUS scene's geometries/textures via
      // disposeSceneContents, rather than leaking them on every edit.
      rendererMemory: () => renderer ? { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures } : null,
      // the bordered "chip" wrapping Edit + its edit-only buttons -- whether
      // it actually has a visible border, and which icons it contains (in
      // order), for testing the grouping without depending on exact colors.
      editGroupInfo: () => editGroup ? {
        hasBorder: editGroup.style.border !== '' && editGroup.style.border !== 'none',
        icons: [...editGroup.querySelectorAll('i.fa-solid')].map(i => [...i.classList].find(c => c !== 'fa-solid')),
      } : null,
      // "fully decorated" (Part A): read the computed flag, force a
      // recompute of the current room without going through the real
      // edit-mode-exit UI, or seed/clear a specific room's flag directly --
      // mirrors the memorized/toggleMemorized/setMemorized hooks above.
      decorated: () => DECORATED[currentRoomKey] || null,
      evaluateDecorated: () => evaluateDecorated(currentRoomKey),
      setDecorated: (key, val) => {
        if(val) DECORATED[key] = Date.now(); else delete DECORATED[key];
        persistDecorated();
      },
      // dumps everything computeFullyDecorated looks at for one room, straight
      // to the console with a "[Debug]" prefix so it's easy to filter/copy --
      // for diagnosing a "won't decorate" report against real (non-test) data
      // without needing to add print statements and re-deploy. Safe to run in
      // production once threeTestDebug is set (see the hooks above/below).
      debugDecoration: (roomKeyArg) => {
        const roomKey = roomKeyArg || currentRoomKey;
        console.log('[Debug] room key:', roomKey);
        const room = mergedRoom(roomKey);
        if(!room){ console.log('[Debug] mergedRoom(roomKey) is null/undefined -- not a registered room this session'); return; }
        console.log('[Debug] entryNoStreet:', !!room.entryNoStreet, '  posKey:', ROOMS[roomKey] && ROOMS[roomKey].posKey);
        const slots = moveObjectSlots(roomKey);
        console.log('[Debug] move-object slots:', slots.length ? slots.map(s => `${s.id}(${s.side})`).join(', ') : '(none)');
        for(const slot of slots){
          const exempt = slot.side === 'center' && !room.entryNoStreet;
          const overrideId = LAYOUT[roomKey] && LAYOUT[roomKey].slots && LAYOUT[roomKey].slots[slot.id];
          const override = slotAssetFor(roomKey, slot.id);
          const manualWord = slotWordFor(roomKey, slot.id);
          const listResolved = (!override && !manualWord) ? moveObjectListResolved(roomKey, slot) : null;
          const asset = override || (listResolved && listResolved.asset);
          const listWord = listResolved && listResolved.word;
          const filled = override || manualWord || asset || listWord;
          console.log(`[Debug]   slot ${slot.id}: exempt=${exempt}, overrideAssetId=${overrideId || null}` +
            (override === null && overrideId ? ' (!! set but does not resolve in ASSET_BY_ID !!)' : '') +
            `, manualWord=${JSON.stringify(manualWord)}, listWord=${listResolved ? JSON.stringify(listResolved.word) : null}, resolvedAsset=${asset ? asset.id : null}` +
            `, COUNTS_AS_FILLED=${exempt ? 'N/A (exempt)' : !!filled}`);
        }
        const exits = room.exits || [];
        console.log('[Debug] exits:', exits.length ? exits.map(e => `${e.wall}@${e.offset}->${e.target}${e.back?' [back]':''}${e.type?' type='+e.type:''}`).join(' | ') : '(none)');
        for(const ex of exits){
          if(ex.back) continue;
          const registered = !!ROOMS[ex.target];
          const empty = registered ? isRoomEmpty(ex.target) : null;
          const name = registered ? roomNameFor(ex.target) : null;
          const verdict = !registered ? 'skipped (target not registered this session)'
            : empty ? 'skipped (target isRoomEmpty)'
            : name ? 'OK (named)' : '!! BLOCKS decoration (unnamed) !!';
          console.log(`[Debug]   forward exit -> ${ex.target}: registered=${registered}, isRoomEmpty=${empty}, targetName=${JSON.stringify(name)} -- ${verdict}`);
        }
        console.log('[Debug] computeFullyDecorated(roomKey) =', computeFullyDecorated(roomKey));
        console.log('[Debug] cached DECORATED[roomKey] =', DECORATED[roomKey] || null, '(stale until evaluateDecorated() re-runs, e.g. on edit-mode exit)');
      },
      // jumps to roomKey via the exported jumpToRoom fast path, for testing
      // Part B ("Jump to VR") without going through the app's modal/button.
      jumpToRoom: (key) => jumpToRoom(key),
      // locked-door rooms: the computed "nothing built past here" flag, and
      // whether a given target currently has a live teleport trigger (i.e. is
      // actually walkable) -- the real signal a locked door removes, checked
      // directly rather than driving a full WASD walk-into-the-wall simulation.
      isRoomEmpty: (key) => isRoomEmpty(key),
      // the room-name floor label currently in the scene (null if hints are
      // off, the room has no name, or -- normally -- there's more than
      // zero): position, and its local normal/"up" (text-top direction) in
      // world space, so a test can confirm it lies flat (normal ~ (0,1,0))
      // and spins to face wherever the camera currently is.
      roomNameFloorLabel: () => {
        const f = floorLabels[0];
        if(!f) return null;
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(f.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(f.quaternion);
        return {
          x: f.position.x, y: f.position.y, z: f.position.z,
          normal: { x: normal.x, y: normal.y, z: normal.z },
          up: { x: up.x, y: up.y, z: up.z },
          count: floorLabels.length,
        };
      },
      canWalkTo: (targetKey) => exitMeta.some(m => m.target === targetKey),
      // the live forward-exit trigger boxes for the CURRENT room (same data
      // tick() checks pos/facing against) -- lets a test drive a real walk
      // through a specific door deterministically (teleport to the box
      // center, face along `thru`) instead of guessing which wall a door
      // landed on.
      exitInfo: () => exitMeta.map(m => ({ target: m.target, box: m.box, thru: m.thru })),
      // the wall-lists <select>'s option/optgroup HTML for a bucket, exactly
      // as the real Wall Object Lists dialog builds it -- for testing the
      // category grouping without needing to open edit mode, click the
      // toolbar icon, and navigate the real dialog.
      wallListOptionsHtml: (roomKey, bucket) => wallListOptionsHtml(roomKey, bucket),
      // a room's exits (wall/offset/target/back), each with its doorKey()
      // pre-computed -- for driving target({kind:'door', roomKey, doorKey})
      // against a specific exit by target without reaching into internals.
      exitsOf: (roomKey) => {
        const r = mergedRoom(roomKey);
        return r ? (r.exits || []).map(e => ({ wall: e.wall, offset: e.offset, target: e.target, back: !!e.back, doorKey: doorKey(e.wall, e.offset) })) : null;
      },
      // elevator car: the built door/floor structure (elevatorMeta) for the
      // CURRENT room -- forward is a list of floor-target lists (one per
      // forward door), back a list of back-door targets. A correctly-built
      // car has exactly ONE forward entry (all exits as its floors) + one
      // back, no matter how many walls the exits were spread across.
      elevatorInfo: () => ({
        forward: elevatorMeta.filter(m => m.kind === 'forward').map(m => (m.floors || []).map(f => ({
          target: f.target,
          ordinal: f.ordinal,
          name: f.name || '',
          hasPair: !!f.pair,
          objAssetId: f.objAsset ? f.objAsset.id : null,
          objWord: f.objWord || null,
          occurrence: f.occurrence || null,
        }))),
        back: elevatorMeta.filter(m => m.kind === 'back').map(m => m.target),
      }),
      // the built panel mesh's own real-world width/height (PlaneGeometry
      // params) and mount height -- for testing that ELEV_ROW_M actually
      // scales the physical panel (images included), not just the canvas
      // pixel layout, and that it's mounted clear of the floor.
      elevatorPanelSize: () => {
        let found = null;
        scene.traverse(o => { if(!found && o.userData && o.userData.kind === 'elevator-panel') found = o; });
        return found ? { w: found.geometry.parameters.width, h: found.geometry.parameters.height, y: found.position.y } : null;
      },
      // click-to-select-floor UX: the currently-selected floor's ordinal for
      // the CURRENT room's car (null if nothing picked, or the pick is stale
      // against its current floors) -- read back after clickElevatorFloor
      // below, or after a real teleport to confirm the right one was used.
      elevatorSelected: () => {
        const fwd = elevatorMeta.find(m => m.kind === 'forward');
        return fwd ? selectedElevatorOrdinal(currentRoomKey, fwd.floors) : null;
      },
      // drives the SAME row-selection logic a real panel click does
      // (selectElevatorFloor), given v = the uv.y a raycaster hit would
      // report (0 = bottom of the panel texture, 1 = top, matching
      // three.js's PlaneGeometry UVs) -- exercises the actual pixel/row
      // mapping math without needing to land a real screen-space raycast on
      // the canvas-textured panel mesh. Mirrors this file's established
      // pattern of dispatching edit-mode clicks straight to
      // handleEditTarget() via target() above, bypassing raycasting there too.
      // panelIndex (0 or 1) picks which panel the click lands on -- only
      // matters once there are more than ELEV_PANEL_MAX_ROWS floors and a
      // second panel exists (buildElevatorPanels); ignored otherwise.
      // Returns the resulting selection (elevatorSelected()'s value).
      clickElevatorFloor: (v, panelIndex) => {
        const fwd = elevatorMeta.find(m => m.kind === 'forward');
        if(!fwd) return null;
        const floors = fwd.floors.length > ELEV_PANEL_MAX_ROWS
          ? (panelIndex === 1 ? fwd.floors.slice(ELEV_PANEL_MAX_ROWS) : fwd.floors.slice(0, ELEV_PANEL_MAX_ROWS))
          : fwd.floors;
        selectElevatorFloor({ roomKey: currentRoomKey, floors }, { y: v });
        return selectedElevatorOrdinal(currentRoomKey, fwd.floors);
      },
      // the exact uv.y a raycaster hit on a panel row's CENTER would report,
      // at 1-based position `row` (its position WITHIN that panel -- e.g.
      // floor 10 is row 3 on the second panel, not row 10) out of that
      // panel's own `floorCount` rows -- so a test can drive
      // clickElevatorFloor() with a value that matches the real click math
      // exactly, instead of re-deriving/duplicating ELEV_PAD_PX/ELEV_ROW_PX.
      elevatorRowCenterUV: (row, floorCount) => {
        const canvasH = Math.max(ELEV_ROW_PX, ELEV_ROW_PX * floorCount + ELEV_PAD_PX * 2);
        const rowCenterFromTop = ELEV_PAD_PX + ELEV_ROW_PX * (row - 0.5);
        return 1 - rowCenterFromTop / canvasH;
      },
      // each elevator door's trigger box + through-direction (mirrors what
      // tick() itself checks) plus, for the back door, its target -- for
      // positioning/facing the player exactly at a car's forward or back
      // door in a test (same box/thru shape the normal-door walk-teleport
      // tests already position against for staircases).
      elevatorDoorGeom: () => elevatorMeta.map(m => ({
        kind: m.kind, box: Object.assign({}, m.box), thru: Object.assign({}, m.thru),
        target: m.kind === 'back' ? m.target : null,
      })),
      // the "can this door be an elevator?" rule the Room Geometry editor
      // enforces (null = allowed, else the rejection message shown inline).
      elevatorRejectReason: (targetKey) => elevatorRejectReason(targetKey),
      // writes the same LAYOUT exit-type override the Room Geometry editor's
      // Apply commits (commitRoomGeomDialog), so a test can mark a door
      // 'elevator' (making its target a car) without driving the dialog DOM.
      setExitType: (roomKey, targetKey, type) => {
        const ex = (ROOMS[roomKey] && ROOMS[roomKey].exits || []).find(e => e.target === targetKey);
        if(!ex) return false;
        applyEdit(() => {
          const r = ensureRoomLayout(roomKey);
          const prev = r.exits[targetKey] || { wall: ex.wall, offset: ex.offset };
          r.exits[targetKey] = Object.assign({}, prev, { type });
        });
        return true;
      },
      // assigns a per-door override keyed by which TARGET the door leads to,
      // rather than requiring the caller to hand-compute its wall/offset via
      // doorKey() -- for testing locked-vs-ordinary door skin resolution.
      setDoorAssetForTarget: (roomKey, targetKey, assetId) => {
        const r = mergedRoom(roomKey);
        const ex = r && r.exits && r.exits.find(e => e.target === targetKey);
        if(!ex) return false;
        setDoorOverride(roomKey, doorKey(ex.wall, ex.offset), assetId);
        return true;
      },
      // the raw per-room door-skin OVERRIDE id (or null if unset -- doesn't
      // fall back to a building default/procedural pick), keyed by doorKey
      // -- for testing entrance->exit door-skin sync (setDoorOverride)
      // without scraping the door panel mesh's texture out of the scene.
      doorOverrideId: (roomKey, dKey) => (LAYOUT[roomKey] && LAYOUT[roomKey].doors && LAYOUT[roomKey].doors[dKey]) || null,
      deadEndOverrideId: (roomKey, track) => track
        ? (LAYOUT[roomKey] && LAYOUT[roomKey].deadEndTracks && LAYOUT[roomKey].deadEndTracks[track]) || null
        : (LAYOUT[roomKey] && LAYOUT[roomKey].deadEnd) || null,
      // drives the real "make default" capture the Room Geometry dialog's
      // Apply button does (captureBuildingDefaults), persisted + rebuilt the
      // same way that flow's commitRoomGeomDialog does right after -- for
      // testing a castle-wide locked-door default without opening the dialog.
      captureBuildingDefaults: (roomKey) => {
        captureBuildingDefaults(roomKey);
        persistLayout();
        buildRoom(currentRoomKey);
      },
      scan: () => { const out=[]; scene.traverse(o=>{ if(o.userData&&o.userData.kind) out.push({ kind:o.userData.kind, slotId:o.userData.slotId, wall:o.userData.wall, roomKey:o.userData.roomKey, buildingKey:o.userData.buildingKey, w:o.userData.w, h:o.userData.h, doorKey:o.userData.doorKey }); }); return out; },
      // buildMoveObjectSubtitle's caption sprite has no userData.kind (so scan()
      // above and findInteractive() both skip it -- purely decorative, not a
      // click target), so it needs its own lookup by userData.subtitleFor. Its
      // material must render on top of the (opaque) image it captions -- see
      // that function's own comment on why depthTest is off -- so a test can
      // confirm the render-queue settings directly, same pattern as
      // selectionRenderInfo above.
      moveObjectSubtitleRenderInfo: (slotId) => {
        let found = null;
        scene.traverse(o => { if(!found && o.userData && o.userData.subtitleFor === slotId) found = o; });
        return found ? { transparent: found.material.transparent, depthWrite: found.material.depthWrite, depthTest: found.material.depthTest } : null;
      },
      // a room's own resolved exits, incl. the fromSide/fromOrder tagging
      // (which member each door originates from) that continuationListItem
      // relies on -- for pinning that the graph-generation -> render-time
      // exits.push threading actually carries those fields through, without
      // scraping door meshes out of the scene by hand.
      exitsFor: (roomKey) => (mergedRoom(roomKey || currentRoomKey).exits || []).map(e =>
        ({ wall: e.wall, target: e.target, back: !!e.back, track: e.track || null,
           fromSide: e.fromSide || null, fromOrder: e.fromOrder || null })),
      // the pure resolution logic behind "a lane ending in exactly one door
      // continues its own wall list onto that door's head object" -- called
      // directly against a real roomKey (so wallListId/OBJECT_LISTS reads are
      // real) but a caller-supplied room/ex shape, so a test can exercise the
      // single-door / branch / no-list cases without needing to coax the real
      // castle generator into producing each exact graph shape.
      continuationListItem: (roomKey, room, ex) => continuationListItem(roomKey, room, ex),
      // same resolution, but against a door's REAL exit record (found by its
      // target room key) instead of a synthetic one -- confirms the graph-
      // generation -> render-time fromSide/fromOrder threading (see exitsFor)
      // actually drives a genuine castle-generated single door's own
      // continuation, not just the pure-logic synthetic cases above.
      continuationListItemForRealDoor: (roomKey, targetRoomKey) => {
        const room = mergedRoom(roomKey);
        const ex = room && (room.exits || []).find(e => e.target === targetRoomKey);
        return ex ? continuationListItem(roomKey, room, ex) : null;
      },
      meshes: () => { const out=[]; scene.traverse(o=>{ if(o.isMesh&&o.geometry&&o.geometry.parameters){ const wp=new THREE.Vector3(); o.getWorldPosition(wp); out.push({ type:o.geometry.type, params:o.geometry.parameters, x:wp.x, y:wp.y, z:wp.z, ry:o.rotation.y, kind:o.userData&&o.userData.kind, slotId:o.userData&&o.userData.slotId, wall:o.userData&&o.userData.wall, color:(o.material&&o.material.color)?('#'+o.material.color.getHexString()):null, hasMap:!!(o.material&&o.material.map), transparent:!!(o.material&&o.material.transparent) }); } }); return out; },
      entry: () => entryPoint,
      teleport: (x, z, yawVal) => { pos.x = x; pos.z = z; if(yawVal != null) yaw = yawVal; },
      pos: () => ({ x: pos.x, z: pos.z, yaw }),
      // the spawn a resize (commitRoomGeomDialog) drops the player at
      // (respawnAtEntry) -- for testing that a resize actually lands you
      // back at the entrance rather than wherever you happened to be
      // standing, without duplicating the doorSpawn math in the test itself.
      entrySpawnFor: (roomKey) => entrySpawnFor(roomKey),
      // the VR's true starting point (Main Street) -- for testing that the H
      // key lands exactly there, distinct from R's per-room entrySpawnFor.
      startSpawn: () => ({ room: START_ROOM, ...START_SPAWN }),
      // world position of whichever scene object carries this slotId, regardless
      // of whether it's a Mesh or a Sprite (meshes() only sees the former) --
      // needed to check e.g. a placeholder billboard's position after a resize.
      posOf: (slotId) => {
        let found = null;
        scene.traverse(o => { if(!found && o.userData && o.userData.slotId === slotId) found = o; });
        if(!found) return null;
        const wp = new THREE.Vector3();
        found.getWorldPosition(wp);
        return { x: +wp.x.toFixed(3), y: +wp.y.toFixed(3), z: +wp.z.toFixed(3) };
      },
      // a sign (street or building lawn) has no slotId at all -- it's keyed
      // by buildingKey instead (see selectSign/setSignPosLive) -- so posOf
      // can't find it. Same world-position lookup, keyed the way a sign
      // actually is.
      signWorldPos: (buildingKey) => {
        let found = null;
        scene.traverse(o => { if(!found && o.userData && o.userData.kind === 'sign' && o.userData.buildingKey === buildingKey) found = o; });
        if(!found) return null;
        const wp = new THREE.Vector3();
        found.getWorldPosition(wp);
        return { x: +wp.x.toFixed(3), y: +wp.y.toFixed(3), z: +wp.z.toFixed(3) };
      },
      // userData.kind of whichever scene object carries this slotId -- for
      // testing that a word-only plaque (buildMoveObjectWordLabel) is really
      // tagged 'accessory' (selectable/movable) and not 'slot' (opens the
      // picker directly on click, correct only for a genuinely empty slot).
      kindOf: (slotId) => {
        let found = null;
        scene.traverse(o => { if(!found && o.userData && o.userData.slotId === slotId) found = o; });
        return found ? found.userData.kind : null;
      },
      // the canvas pixel size of a Sprite's texture (mnemonic pair billboards
      // aren't Meshes, so meshes() can't see them) -- for testing that a
      // street entry pair's occurrence strip actually grows the canvas
      // (renderMnemPairCanvas), keyed the same way posOf finds any object.
      spriteCanvasSize: (slotId) => {
        let found = null;
        scene.traverse(o => { if(!found && o.userData && o.userData.slotId === slotId) found = o; });
        const img = found && found.material && found.material.map && found.material.map.image;
        return img ? { width: img.width, height: img.height } : null;
      },
      // apply a room geometry resize exactly as the room-geometry dialog's Apply
      // button does (same setRoomGeom call), for testing the bounds auto-fix.
      resize: (roomKey, geom) => setRoomGeom(roomKey, geom),
      // assigns `assetId` to EVERY door in `roomKey` and rebuilds it -- for
      // testing door skin oversizing without needing to compute a specific
      // door's exact wall/offset key by hand. Mutates LAYOUT directly and
      // does a single refreshAssetMap()+buildRoom() pass (rather than calling
      // setDoorOverride per door, each of which fires its own applyEdit ->
      // refreshAssetMap that SYNCHRONOUSLY empties ASSET_BY_ID before its
      // async re-populate resolves): with more than one door, those calls'
      // empty windows can overlap a rebuild and drop every door's asset.
      setAllDoorAssets: async (roomKey, assetId) => {
        const r = mergedRoom(roomKey);
        if(!r || !r.exits || !r.exits.length) return false;
        const layout = ensureRoomLayout(roomKey);
        for(const ex of r.exits) layout.doors[doorKey(ex.wall, ex.offset)] = assetId;
        persistLayout();
        await refreshAssetMap();
        buildRoom(currentRoomKey);
        return true;
      },
      // the move-object slot ids a room resolves to (moveObjectSlots' own ids,
      // e.g. "obj-L1") -- for testing Part A's "fully decorated" slot check
      // without scraping placeholder sprites out of the scene by hand.
      moveObjectSlotIds: (roomKey) => moveObjectSlots(roomKey).map(s => s.id),
      // full slot geometry (id/side/order/x/z) -- for testing that a new
      // side-door's position (see exits() above) lands near its sibling
      // member's own slot rather than the generic door-hash placement.
      moveObjectSlotsFull: (roomKeyArg) => moveObjectSlots(roomKeyArg || currentRoomKey)
        .map(s => ({ id: s.id, side: s.side, order: s.order, x: s.x, z: s.z })),
      // a wall bucket's slot count (bucketSlotCount) and a specific slot's
      // list-driven word, if any (moveObjectListResolved) -- for testing
      // that the center/anchor slot is excluded from both (it's the
      // arrival-move pair, not a step of this room's own walk sequence).
      wallBucketSlotCount: (roomKeyArg, bucket) => bucketSlotCount(roomKeyArg || currentRoomKey, bucket),
      slotListWord: (roomKeyArg, slotId) => {
        const rk = roomKeyArg || currentRoomKey;
        const slot = moveObjectSlots(rk).find(s => s.id === slotId);
        if(!slot) return undefined;
        const r = moveObjectListResolved(rk, slot);
        return r ? r.word : null;
      },
      // assigns (or clears, if listId is falsy) a wall bucket's list -- the
      // same mutation the real Wall Object Lists dialog's <select> makes
      // (see openWallListsDialog), for testing without driving that dialog.
      setWallList: (roomKeyArg, bucket, listId) => {
        const rk = roomKeyArg || currentRoomKey;
        const r = ensureRoomLayout(rk);
        if(!r.wallLists) r.wallLists = {};
        if(listId){
          r.wallLists[bucket] = { listId };
          clearBucketSlotOverrides(rk, bucket);
        } else {
          delete r.wallLists[bucket];
        }
        persistLayout();
        buildRoom(currentRoomKey);
      },
      // whether a wall-list mnemonic plaque (buildWallListPlaques) is
      // currently in the scene -- for testing that it shows whenever the
      // assigned list has EITHER a phrase or an ordering rule, not only
      // when both/a phrase specifically is set.
      hasWallListPlaque: () => {
        let found = false;
        scene && scene.traverse(o => { if(o.userData && o.userData.kind === 'wall-list-plaque') found = true; });
        return found;
      },
      // the current room's rendered chain segments (buildMoveObjectChain) --
      // count + midpoint position of each, for testing that a corridor gets
      // exactly (slot count - 1) segments and a non-corridor gets none.
      chainSegments: () => {
        const found = [];
        scene && scene.traverse(o => { if(o.userData && o.userData.kind === 'moveObjectChain') found.push(o); });
        return found.map(m => ({ x: m.position.x, z: m.position.z }));
      },
      // a room's forward door-pair object's BASE (unnudged) floor position,
      // via the same doorSideXZ a real door pair renders at -- lets a test
      // compute the expected terminal chain-link endpoint independently of
      // buildMoveObjectChain's own internals.
      doorObjBasePos: (roomKeyArg, target) => {
        const r = mergedRoom(roomKeyArg || currentRoomKey);
        const ex = (r.exits || []).find(e => !e.back && e.target === target);
        if(!ex) return null;
        return doorSideXZ(r, ex.wall, ex.offset, ex.wall === 'east' ? 1 : -1);
      },
      // the chain's own walk-start point (the room-name floor-label spot near
      // the entrance) -- lets a test compute the expected first segment's
      // midpoint independently of buildMoveObjectChain's own internals.
      chainEntryPos: (roomKeyArg) => {
        const r = mergedRoom(roomKeyArg || currentRoomKey);
        return roomNameFloorPos(r.size, entranceWall(r));
      },
      // the current room's dead-end sign (see buildRoom's dead-end hook):
      // which wall it's on, and whether the built-in icon or a custom-skin
      // panel is what's actually in the scene right now (mutually exclusive).
      deadEndSign: (roomKeyArg) => {
        const r = mergedRoom(roomKeyArg || currentRoomKey);
        const back = (r.exits || []).find(e => e.back);
        const wall = back ? WALL_OPPOSITE[back.wall] : 'north';
        let icon = false, panel = false;
        scene && scene.traverse(o => {
          if(!o.userData) return;
          if(o.userData.kind === 'no-continuation-icon' && o.userData.wall === wall) icon = true;
          if(o.userData.kind === 'door-panel' && o.userData.wall === wall) panel = true;
        });
        return { wall, icon, panel };
      },
      // assigns (or clears, if assetId is falsy) the dead-end sign's per-room
      // skin override -- the same mutation setDeadEndOverride makes, but
      // AWAITED end-to-end (setDeadEndOverride itself fires its applyEdit
      // and returns immediately, same reason setSlotAsset above doesn't
      // reuse setSlotOverride) so a test isn't racing refreshAssetMap.
      setDeadEndAsset: async (roomKey, assetId, track) => {
        const r = ensureRoomLayout(roomKey);
        if(track){
          r.deadEndTracks = r.deadEndTracks || {};
          if(assetId) r.deadEndTracks[track] = assetId; else delete r.deadEndTracks[track];
        } else if(assetId) r.deadEnd = assetId; else delete r.deadEnd;
        persistLayout();
        await refreshAssetMap();
        buildRoom(currentRoomKey);
      },
      // nudges a moveObject slot's stored xform directly (bypassing the real
      // arrow-key drag flow) and rebuilds -- for testing that dependents
      // (the chain) follow a slot's ACTUAL nudged position, not its default.
      nudgeSlot: (roomKey, slotId, dx, dz) => {
        const r = ensureRoomLayout(roomKey);
        r.slotXform[slotId] = { ...(r.slotXform[slotId] || {}), dx, dz };
        persistLayout();
        buildRoom(currentRoomKey);
      },
      // assigns (or clears, if assetId is falsy) a manual per-slot asset
      // override -- the same mutation the real prop picker makes
      // (setSlotOverride), but AWAITED end-to-end (setSlotOverride itself
      // fires its applyEdit and returns immediately, same reason
      // setAllDoorAssets above doesn't reuse the per-field setters) -- for
      // testing Part A's "every slot has a real asset" check without a race
      // against refreshAssetMap's async ASSET_BY_ID repopulate.
      setSlotAsset: async (roomKey, slotId, assetId) => {
        const r = ensureRoomLayout(roomKey);
        if(assetId) r.slots[slotId] = assetId; else delete r.slots[slotId];
        if(!assetId) delete r.slotXform[slotId];
        persistLayout();
        await refreshAssetMap();
        buildRoom(currentRoomKey);
      },
      // sets (or clears) a manual placeholder-label override on a move-object
      // slot -- the same mutation the picker's "type a label" field makes
      // (setSlotWordOverride), for testing the label-only-override path
      // (fully-decorated's "word counts as filled" rule, and the wall-list
      // stale-override-clearing / Remove-must-clear-the-word regressions)
      // without driving the real picker dialog.
      setSlotWord: (roomKey, slotId, word) => setSlotWordOverride(roomKey, slotId, word),
      // opens the real per-slot asset/word picker exactly as the gear icon /
      // Enter key would (openPropManager) -- for testing the Remove/word-apply
      // flow (setSlotOverride's word-clearing in particular) end-to-end
      // through the actual dialog, without needing a real raycasting click.
      openPropManager: (roomKey, slotId) => openPropManager(roomKey, slotId),
      // names (or clears) a room the same way the Room Geometry dialog's
      // "Room names" fields do (setRoomName) -- for testing Part A's "every
      // forward door's target is named" check without driving that dialog.
      setRoomName: (roomKey, name) => { setRoomName(roomKey, name); },
      // the room's EFFECTIVE size (static + any LAYOUT.geom override folded
      // in, same accessor every real read site uses) -- for testing that
      // mainStreet's auto-computed minimum can't be shrunk by a stale override.
      roomSize: (roomKey) => { const r = mergedRoom(roomKey || currentRoomKey); return r ? { w: r.size.w, d: r.size.d, h: r.size.h } : null; },
      // moves the player to an arbitrary (x,z,yaw) without walking there --
      // for testing jumpForward/click-to-walk from a known starting point
      // and facing, since enter() always spawns at a fixed (0,0,yaw:0).
      setPlayerPos: (x, z, yawVal) => { pos.x = x; pos.z = z; if(yawVal != null) yaw = yawVal; },
      playerPos: () => ({ x: pos.x, z: pos.z, yaw, room: currentRoomKey }),
      // fires the real spacebar jump (see onKeyDown/jumpForward) directly,
      // bypassing keyboard-event plumbing.
      jump: () => jumpForward(),
      // the current room's exit/elevator triggers -- for testing that a jump
      // or click lands EXACTLY at a door's own recorded spawn (the same one
      // a physical walk-through would use), not some other point.
      exitMetaList: () => exitMeta.map(m => ({ target: m.target, spawn: { ...m.spawn } }))
        .concat(elevatorMeta.map(m => ({ target: m.target || null, kind: m.kind, spawn: m.spawn ? { ...m.spawn } : null }))),
      // fires the real click-to-walk-through-a-door logic (see
      // handleWalkClick) for a given WORLD point, bypassing the
      // raycast/screen-coordinate plumbing a simulated mouse click would
      // otherwise need. Returns true if it actually moved you into a new
      // room (or resolved an elevator floor).
      walkClickAt: (x, z) => {
        if(clock.getElapsedTime() <= teleportLockUntil) return false;
        const m = findDoorTrigger(x, z, null);
        return m ? fireDoorTrigger(m) : false;
      },
      jumpDistances: () => ({ indoor: JUMP_DIST_INDOOR, outdoor: JUMP_DIST_OUTDOOR }),
      // the raw (un-merged) LAYOUT entry for a room -- for testing that
      // clearRoomStyles actually empties every field it claims to, not just
      // the ones a real read-site would notice missing.
      roomLayout: (roomKey) => LAYOUT[roomKey] ? JSON.parse(JSON.stringify(LAYOUT[roomKey])) : null,
      // drives the real "Reset Room…" wipe (Room Geometry dialog's Clear
      // button) without needing to click through the dialog/confirm() -- for
      // testing clearRoomStyles's full scope directly.
      clearRoomStyles: (roomKey) => clearRoomStyles(roomKey),
      // the raw buildings array mainStreet was generated with (positions/sizes
      // as placed, before any size guarantee) -- for checking every building
      // footprint actually fits inside roomSize('mainStreet').
      buildings: () => (ROOMS.mainStreet && ROOMS.mainStreet.buildings) ? JSON.parse(JSON.stringify(ROOMS.mainStreet.buildings)) : [],
      // builds a move-pair billboard sprite from a synthetic pair (same shape
      // CONV in app.js produces -- {opponent,response}, each optionally
      // carrying moveNumber) and reports whether its canvas has the
      // move-number badge's white ink in each quadrant's corner -- verifies
      // "N." lands in the correct (White's) quadrant without needing full
      // pixel-level OCR of the glyph. Reads the synchronous immediate-
      // fallback render (before the async mnemonics/beard-image resolve),
      // which already carries moveNumber, so no waiting on IDB is needed.
      buildMnemPairInk: (pair) => {
        const sprite = buildMnemPairSprite(pair, 1);
        const canvas = sprite.material.map.image;
        const ctx = canvas.getContext('2d');
        const hasWhiteInk = (x0, y0, w, h) => {
          const d = ctx.getImageData(x0, y0, w, h).data;
          for(let i = 0; i < d.length; i += 4){
            if(d[i] > 220 && d[i+1] > 220 && d[i+2] > 220 && d[i+3] > 200) return true;
          }
          return false;
        };
        const far = MNEM_PAIR_SIZE - MNEM_QUADRANT;
        // sample a box tight enough around the badge's actual ink (measured:
        // y 292-373 at this font/position, vs. 207-288 at the old centered
        // position -- a real gap, not just "lower") to actually distinguish
        // "moved to the lower third" from "just got bigger in place".
        const lowY = 300;
        return {
          oppCorner: hasWhiteInk(14, lowY, 110, 70),
          respCorner: hasWhiteInk(far + 14, far + lowY, 110, 70),
        };
      },
      // locates a real placed scene sprite by slotId and reports whether its
      // canvas has ink of the given `kind` in the given region -- the
      // real-sprite counterpart to buildMnemPairInk (which only builds
      // synthetic, unplaced pairs), needed for sprites like the street-sign
      // opening-move tile that aren't reachable that way. 'white' is the
      // move-number badge's fill; on a tile whose own background is already
      // near-white (e.g. the opening-move tile's cream fill), that's not
      // discriminating, so 'dark' checks for the badge's black stroke
      // instead, which the plain background never has.
      spriteHasWhiteInk: (slotId, x0, y0, w, h, kind) => {
        let found = null;
        scene.traverse(o => { if(!found && o.userData && o.userData.slotId === slotId) found = o; });
        const canvas = found && found.material && found.material.map && found.material.map.image;
        if(!canvas) return null;
        const d = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
        for(let i = 0; i < d.length; i += 4){
          if(kind === 'dark'){
            if(d[i] < 60 && d[i+1] < 60 && d[i+2] < 60 && d[i+3] > 150) return true;
          } else if(d[i] > 220 && d[i+1] > 220 && d[i+2] > 220 && d[i+3] > 200) return true;
        }
        return false;
      },
    };
  }
}

export function closeThreeTest(){
  if(animHandle) cancelAnimationFrame(animHandle);
  animHandle = null;
  if(resizeObs) resizeObs.disconnect();
  resizeObs = null;
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  if(renderer){
    renderer.domElement.removeEventListener('click', onCanvasClick);
    renderer.dispose();
    renderer = null;
  }
  if(container){ container.innerHTML = ''; }
  clearGeneratedCastle();   // drop synthesized cas:* rooms so a later normal walk is clean
  editMode = false;
  inputLocked = false;
  editUndoStack = []; editRedoStack = []; lastXformUndoKey = null;
  billboards = [];
  floorLabels = [];
  selectedProp = null;
  selectionOutline = null;
  selectionGear = null;
  selectionAnchor = null;
  editHud = null;
  if(toastTimer){ clearTimeout(toastTimer); toastTimer = null; }
  toastEl = null;
  joystickEl = null; joyKnob = null; joyPointerId = null;
  joyVec = { x: 0, y: 0 };
  editTouchEl = null;
  toolbarEl = null; helpOverlay = null;
  hintsBtn = editBtn = roomGeomBtn = assetsBtn = closeBtn = infoBtn = memBtn = dirtyBadge = editGroup = undoBtn = redoBtn = null;
  threeOpts = {};
  closeRoomGeomDialog();
  scene = null; camera = null; clock = null; container = null;
}
