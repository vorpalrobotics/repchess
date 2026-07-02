/* ---------- Three.js integration prototype ----------
   "Feel test" for a loci-style memory layout: an outdoor street/courtyard
   containing one building you can walk up to and enter. The building's
   interior is the same two-doorway, three-room layout from the earlier
   iteration of this prototype, now reached by walking through its front
   door instead of just spawning inside it.
*/
import { openAssetPicker } from './assets.js';

let THREE = null;

/* asset types that can sit in a slot (props, not surfaces) */
const PROP_TYPES = ['extruded', 'billboard-cylindrical', 'billboard-sprite'];

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
const WALL_THICK = 0.25;
const EYE_HEIGHT = 1.6;
const STAIR_STEP_RISE = 0.2;  // a stair-exit corridor's climbing steps, in meters
const STAIR_STEP_RUN = 0.3;
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
  const BW = 14, BD = 8, BH = 9, BGAP = 6, FIRST_X = 6;   // castle-building slots along a side street
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
      x: side * (MAIN_W / 2 + 1.2),
      z: z + SIDE_W / 2 + 1.2
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
        doorWall: 'south', doorOffset: 0
      });
    });
  });

  ROOMS.mainStreet = { outdoor: true, size: { w: width, d: depth, h: 7 }, exits: [], roads, streetSigns, buildings };
  START_SPAWN.x = 0; START_SPAWN.z = depth / 2 - 4; START_SPAWN.yaw = 0;   // spawn at the south end, facing up the street
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
  (a.opp || '').localeCompare(b.opp || '') || String(a.toKey || '').localeCompare(String(b.toKey || ''));
/* Register ONE generated castle's rooms under a namespace. instanceId is a
   stable id derived from lineId+castleName (or 'preview' for the report's
   ephemeral Walk in VR), so two castles that transpose into the same chess
   position still get separate rooms/decorations — cross-castle sharing is a
   deliberate future choice, not an accident. opts.backToStreet gives the entry
   room a south back door out to mainStreet (used when a matching street
   building exists to spawn in front of). Returns {entryKey, spawn}. */
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
  const DOOR_SPACING = 3.6;      // center-to-center; DOOR_W is 2.2, leaves a clear gap + room for hints
  const EDGE_MARGIN = 1.6;       // keep a door's half-width off the wall corners
  const EW_SETBACK = 2;          // east/west door groups sit this far north of center
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
    const fwd = r.exits.filter(ex => ex.to);
    const span = c => (c > 1 ? (c - 1) * DOOR_SPACING : 0);
    const base = r.type === 'corridor'
      ? { w: 8, d: Math.max(12, Math.min(44, (r.memberCount || 1) * 5)), h: 6 }
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
      sz = { w: Math.max(base.w, 2 * maxSpan + 8), d: Math.max(base.d, pairDepth), h: base.h };
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
      const byWall = { north: [], east: [], west: [] };
      for(const ex of fwd) byWall[doorWallFor(ex.toKey || ex.opp)].push(ex);
      for(const w of ['north', 'east', 'west']) byWall[w].sort(doorCmp);
      sz = {
        w: Math.max(base.w, span(byWall.north.length) + 2 * EDGE_MARGIN),
        d: Math.max(base.d, pairDepth, 2 * EW_SETBACK + span(Math.max(byWall.east.length, byWall.west.length)) + 2 * EDGE_MARGIN),
        h: base.h
      };
      const place = (wall, list, center) => list.forEach((ex, j) =>
        doorPlacements.push({ wall, offset: center + (j - (list.length - 1) / 2) * DOOR_SPACING, ex }));
      place('north', byWall.north, 0);
      place('east', byWall.east, -EW_SETBACK);
      place('west', byWall.west, -EW_SETBACK);
    }
    const exits = [];
    // back door (south) → parent room. The entry room instead exits to the
    // street when a matching street building exists (opts.backToStreet); in the
    // ephemeral report-preview walk there is no building, so no back door
    // (leave via the Close button).
    if(parent[r.posKey]) exits.push({ wall: 'south', offset: 0, target: keyOf(parent[r.posKey]), back: true });
    else if(r === entry && opts.backToStreet) exits.push({ wall: 'south', offset: 0, target: 'mainStreet', back: true });
    for(const dp of doorPlacements) exits.push({ wall: dp.wall, offset: dp.offset, target: keyOf(dp.ex.toKey), label: dp.ex.opp });
    const key = roomKeyFor(r);
    // move-pair billboards + numbered object slots: reuse the existing mnemonic
    // machinery by registering the room's pairs under its key. When present, the
    // sign drops its (now redundant) move list and just carries the name/exits.
    const hasPairs = r.pairs && r.pairs.length;
    if(hasPairs) DEMO_MNEMONICS[key] = { pairs: r.pairs };
    const moves = hasPairs ? [] : (r.walls.center || []).slice()
      .concat((r.walls.left || []).map(m => '⟸ ' + m))
      .concat((r.walls.right || []).map(m => '⟹ ' + m));
    const doors = fwd.map(ex => `${ex.opp} → ${ex.to}`);
    const unbuilt = r.exits.filter(ex => !ex.to).map(ex => ex.opp);
    ROOMS[key] = {
      size: sz, color: 0x6f5f8e, exits, twoTrack: isTwoTrack,
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
let pos = { x:0, z:0 };
let currentRoomKey = 'start';
// where the player last walked in (spawn point just inside the entry door).
// Floor-standing box props are turned to face this so their image side greets
// you as you enter -- the only viewpoint that matters for a memory walk.
let entryPoint = null;
let exitMeta = [];       // [{box:{minX,maxX,minZ,maxZ}, target, spawn:{x,z,yaw}}]
// elevator-car doors, popup-triggered instead of instant on contact:
// [{box, kind:'forward', floors:[{label,target,spawn}]} | {box, kind:'back', target, spawn}]
let elevatorMeta = [];
let activeElevatorDoor = null;  // the elevatorMeta entry whose popup is currently open
let currentExitsByWall = {};
let currentStairCorridors = {}; // wall -> {rise, depth, outSign}, for ex.type === 'stair'
let currentBuildingColliders = []; // outdoor only: [{origin,size,doorWall,doorOffset}]
let teleportLockUntil = 0;
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
let ASSET_BY_ID = {};
let raycaster = null;
let pointer = null;
let billboards = [];           // cylindrical billboards needing per-frame facing
let editHud = null;

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
let hintsBtn = null, editBtn = null, roomGeomBtn = null, assetsBtn = null, closeBtn = null, infoBtn = null;
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

// surface getters resolve in layers: this room's own override -> the building's
// default (set via the Room dialog's "make default" checkbox) -> null, which
// leaves the procedural brick/wood fallback. See buildingDefaults() below.
function floorAssetFor(roomKey){
  const id = (LAYOUT[roomKey] && LAYOUT[roomKey].floor) || defaultFieldId(roomKey, 'floor');
  return id ? ASSET_BY_ID[id] : null;
}
function wallAssetFor(roomKey, wall){
  let id = LAYOUT[roomKey] && LAYOUT[roomKey].walls && LAYOUT[roomKey].walls[wall];
  if(!id){
    const d = buildingDefaults(roomKey);
    if(d && d.walls){
      // defaults store walls relative to the entrance, so they rotate correctly
      // into rooms whose entrance door is on a different wall
      id = d.walls[wallRelative(entranceWall(mergedRoom(roomKey)), wall)] || null;
    }
  }
  return id ? ASSET_BY_ID[id] : null;
}
function slotAssetFor(roomKey, slotId){
  const id = LAYOUT[roomKey] && LAYOUT[roomKey].slots && LAYOUT[roomKey].slots[slotId];
  return id ? ASSET_BY_ID[id] : null;
}
function ceilingAssetFor(roomKey){
  const id = (LAYOUT[roomKey] && LAYOUT[roomKey].ceiling) || defaultFieldId(roomKey, 'ceiling');
  return id ? ASSET_BY_ID[id] : null;
}
function stairAssetFor(roomKey){
  const id = (LAYOUT[roomKey] && LAYOUT[roomKey].stairSurface) || defaultFieldId(roomKey, 'stairSurface');
  return id ? ASSET_BY_ID[id] : null;
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
  const size = L.geom ? Object.assign({}, room.size, L.geom) : room.size;
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
function setRoomGeom(roomKey, geom){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    r.geom = geom;
  });
}
// commits a room-geometry-dialog session in one rebuild: the width/depth/
// height patch plus any door moves and/or type changes (keyed by target
// room). `exitMoves` is a { [target]: {wall, offset, type} } map of the
// dialog's full staged state -- entries matching the static position and
// type ('door') are omitted so a drag-then-drag-back doesn't leave a no-op
// override behind. Any door skin saved under the old wall@offset key
// migrates to the new one.
function commitRoomGeomDialog(roomKey, geom, exitMoves){
  applyEdit(() => {
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
    }
  });
}
// wipe a room's styling and placed objects back to nothing -- floors, walls,
// ceiling, stairs and door skins, plus every placed prop and its nudge/scale.
// The room then falls back to the building defaults (or procedural). The room's
// size and doorway positions (geom/exits) are deliberately kept -- this clears
// look-and-contents, not structure. It never touches LAYOUT.__defaults, so a
// building default previously captured from this room survives the wipe.
function clearRoomStyles(roomKey){
  if(selectedProp && selectedProp.roomKey === roomKey) deselectProp();
  applyEdit(() => {
    const r = LAYOUT[roomKey];
    if(!r) return;
    delete r.floor; delete r.ceiling; delete r.stairSurface;
    r.walls = {}; r.doors = {}; r.slots = {}; r.slotXform = {};
    r.buildings = {}; r.signs = {}; r.signPos = {}; r.yards = {};   // outdoor maps; no-ops indoors
  });
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
async function loadLayout(){
  const raw = await getMeta(LAYOUT_KEY);
  try { LAYOUT = raw ? JSON.parse(raw) : {}; }
  catch { LAYOUT = {}; }
}
function persistLayout(){ setMeta(LAYOUT_KEY, JSON.stringify(LAYOUT)); }

function ensureRoomLayout(roomKey){
  if(!LAYOUT[roomKey]) LAYOUT[roomKey] = {};
  const r = LAYOUT[roomKey];
  if(!r.walls) r.walls = {};
  if(!r.slots) r.slots = {};
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
  });
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
  const r = ensureRoomLayout(roomKey);
  r.slotXform[slotId] = xform;
  persistLayout();
  const obj = findAccessoryObject(slotId);
  if(!obj){ buildRoom(currentRoomKey); return; }   // fallback if it wasn't found
  const room = mergedRoom(roomKey);
  const slot = slotById(room, roomKey, slotId);
  if(!slot) return;
  if(slot.kind === 'mnemonic'){
    obj.position.set(slot.x + (xform.dx || 0), slot.y + (xform.dy || 0), slot.z + (xform.dz || 0));
    obj.userData.userScale = xform.scale || 1;
    applySpriteContentScale(obj);
  } else {
    const asset = slotAssetFor(roomKey, slotId);
    if(asset) applyAccessoryTransform(obj, room, slot, asset, xform);
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
  });
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
    const ex = currentExitsByWall['north'];
    const c = ex && currentStairCorridors['north'];
    if(c && x > ex.offset-dHalf && x < ex.offset+dHalf){
      x = Math.max(ex.offset-dHalf+PLAYER_RADIUS, Math.min(ex.offset+dHalf-PLAYER_RADIUS, x));
      z = Math.max(z, -halfD - c.depth);
    } else z = -halfD;
  }
  if(z > halfD){
    const ex = currentExitsByWall['south'];
    const c = ex && currentStairCorridors['south'];
    if(c && x > ex.offset-dHalf && x < ex.offset+dHalf){
      x = Math.max(ex.offset-dHalf+PLAYER_RADIUS, Math.min(ex.offset+dHalf-PLAYER_RADIUS, x));
      z = Math.min(z, halfD + c.depth);
    } else z = halfD;
  }
  if(x < -halfW){
    const ex = currentExitsByWall['west'];
    const c = ex && currentStairCorridors['west'];
    if(c && z > ex.offset-dHalf && z < ex.offset+dHalf){
      z = Math.max(ex.offset-dHalf+PLAYER_RADIUS, Math.min(ex.offset+dHalf-PLAYER_RADIUS, z));
      x = Math.max(x, -halfW - c.depth);
    } else x = -halfW;
  }
  if(x > halfW){
    const ex = currentExitsByWall['east'];
    const c = ex && currentStairCorridors['east'];
    if(c && z > ex.offset-dHalf && z < ex.offset+dHalf){
      z = Math.max(ex.offset-dHalf+PLAYER_RADIUS, Math.min(ex.offset+dHalf-PLAYER_RADIUS, z));
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
    const c = currentStairCorridors[wall];
    const { axis, fixed } = wallSpan(room.size, wall);
    const along = (axis === 'x' ? z - fixed : x - fixed) * c.outSign;
    if(along > 0) return c.rise * Math.min(1, along / c.depth);
  }
  return floorHeightAt(room, z);
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

function makeBrickTexture(tintHex){
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

function buildBillboardAsset(asset){
  const { w, h } = asset.size;
  if(asset.type === 'billboard-sprite'){
    // alphaTest cutout so the PNG's transparent background is discarded instead
    // of rendering opaque (a SpriteMaterial defaults to transparent:false, which
    // ignores the alpha channel and shows the background's baked RGB -- white,
    // in the reported case). Same hard-cutout the cylindrical billboard uses, so
    // it also avoids the dark/halo fringe that alpha *blending* would give.
    const mat = new THREE.SpriteMaterial({ color: 0xffffff, alphaTest: 0.5 });
    const myGen = buildGeneration;
    textureLoader.load(asset.image, (tex) => {
      if(buildGeneration !== myGen) return;
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex; mat.needsUpdate = true;
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(w, h, 1);
    return sprite;
  }
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
  return buildBillboardAsset(asset); // cylindrical or sprite
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
// snapshot a room's *effective* surfaces into a style set (the shape shared by
// building defaults and named presets): floor/ceiling/stairs, walls stored
// relative to the entrance door, and two door styles (exit vs ordinary).
function snapshotRoomStyle(roomKey){
  const room = mergedRoom(roomKey);
  const ent = entranceWall(room);
  const idOf = (a) => (a && a.id) || null;
  const d = {
    floor: idOf(floorAssetFor(roomKey)),
    ceiling: idOf(ceilingAssetFor(roomKey)),
    stairSurface: idOf(stairAssetFor(roomKey)),
    door: null,
    exitDoor: null,
    walls: { entrance:null, opposite:null, left:null, right:null }
  };
  for(const wall of ['north','south','east','west']){
    const a = wallAssetFor(roomKey, wall);
    if(a) d.walls[wallRelative(ent, wall)] = a.id;
  }
  // first back:true door -> exitDoor, first ordinary door -> door
  for(const ex of (room.exits || [])){
    if(ex.type && ex.type !== 'door') continue;          // stairs/elevator have no door panel
    const a = doorAssetFor(roomKey, doorKey(ex.wall, ex.offset)) || defaultDoorAsset(roomKey, !!ex.back);
    if(!a) continue;
    if(ex.back){ if(!d.exitDoor) d.exitDoor = a.id; }
    else if(!d.door) d.door = a.id;
  }
  return d;
}
function captureBuildingDefaults(roomKey){
  if(!LAYOUT.__defaults) LAYOUT.__defaults = {};
  LAYOUT.__defaults[buildingIdFor(roomKey)] = snapshotRoomStyle(roomKey);
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
// rotated from relative back to this room's absolute walls, the exit-door style
// goes on the back:true door and the ordinary style on the rest. Replaces the
// room's current surface styling (props are left alone). A preset entry of null
// means "no override" (so it falls back to the building default / procedural).
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
      const id = ex.back ? p.exitDoor : p.door;
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
    // hangs from the ceiling centre; a billboard turns to face the camera, so
    // only its height matters -- drop it so its top is flush with the ceiling.
    const h = ((asset.size && asset.size.h) || 1) * scale;
    obj.position.set(slot.x, room.size.h - h/2 - 0.05, slot.z);
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
    if(!(asset.type === 'billboard-cylindrical' || asset.type === 'billboard-sprite')){
      obj.rotation.y = WALL_INWARD_YAW[slot.wall] || 0;
    }
  } else {
    // extruded / plane / sprite are all centred on their geometry, so sitting
    // one on the floor means raising it by half its height
    const x = slot.x + (xform.dx || 0), z = slot.z + (xform.dz || 0);
    const floorY = floorHeightAt(room, z);
    const flat = asset.type === 'extruded' && asset.orientation === 'flat';
    if(flat){
      // a flat floor covering rests on its thickness, not its (now-horizontal) height
      const d = ((asset.size && asset.size.d) || 0.3) * scale;
      obj.position.set(x, floorY + d/2, z);
    } else {
      const h = ((asset.size && asset.size.h) || 1) * scale;
      obj.position.set(x, floorY + h/2, z);
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
    slotMarkerMat = new THREE.MeshBasicMaterial({ color: 0x21d4d4, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  }
  return slotMarkerMat;
}
function buildSlotMarker(room, slot){
  let mesh;
  if(slot.kind === 'ceiling'){
    mesh = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), slotMarkerMaterial());
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
    facadeMarkerMat = new THREE.MeshBasicMaterial({ color: 0xff9800, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
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
    signMarkerMat = new THREE.MeshBasicMaterial({ color: 0xab47bc, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
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
    yardMarkerMat = new THREE.MeshBasicMaterial({ color: 0x7ad17a, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
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
    if(slot.kind === 'mnemonic'){
      if(hintsOn) scene.add(placeMnemonicSlot(roomKey, slot));   // hidden during self-test
      continue;
    }
    if(slot.kind === 'moveObject'){
      // the object pegged to a move-pair: its chosen prop if filled, else a
      // ghostly numbered placeholder. Both stay visible with hints off (the
      // object is a memory hook, and the empty placeholder stands in for it).
      const asset = slotAssetFor(roomKey, slot.id);
      if(asset){
        scene.add(placeSlotAccessory(room, slot, asset, slotXformFor(roomKey, slot.id)));
      } else {
        scene.add(buildMoveObjectPlaceholder(slot));
      }
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
function buildMoveObjectPlaceholder(slot){
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
  sprite.position.set(slot.x, slot.y, slot.z);
  // route an edit-mode click through the existing slot picker (onCanvasClick
  // only fires in edit mode, so this is inert during a normal walk)
  sprite.userData = { kind: 'slot', slotId: slot.id, allow: PROP_TYPES };
  return sprite;
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
// floor panel sits on the left), at eye height -- mirrors buildElevatorPanel.
function elevatorBillboardPos(room, wall, offset){
  const { axis, fixed } = wallSpan(room.size, wall);
  const dcx = axis === 'x' ? offset : fixed;          // door centre on the wall plane
  const dcz = axis === 'x' ? fixed : offset;
  // player's right (facing the wall) and the inward normal, per wall
  const V = {
    north: { rx: 1, rz: 0, ix: 0, iz: 1 }, south: { rx:-1, rz: 0, ix: 0, iz:-1 },
    west:  { rx: 0, rz:-1, ix: 1, iz: 0 }, east:  { rx: 0, rz: 1, ix:-1, iz: 0 }
  }[wall];
  const side = DOOR_W/2 + 0.2, inset = 0.6;
  return { x: dcx + V.rx*side + V.ix*inset, y: 1.5, z: dcz + V.rz*side + V.iz*inset };
}
// the opponent (upper) move of a room's pair, used by door hints / elevator
// floor labels. Handles both the single-pair shape and a multi-pair room (falls
// back to the first pair).
function mnemOpponentMove(roomKey){
  const e = DEMO_MNEMONICS[roomKey];
  if(!e) return null;
  if(e.opponent) return e.opponent;
  if(e.pairs && e.pairs[0]) return e.pairs[0].opponent;
  return null;
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
  // panel sits to the left of the door -- mount its pair to the right of that
  // door instead of the usual centre-of-room spot.
  if(isElevatorCar(roomKey)){
    const room = mergedRoom(roomKey);
    const fwd = (room.exits || []).find(e => !e.back);   // floors share one wall
    if(fwd) pos = elevatorBillboardPos(room, fwd.wall, fwd.offset);
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
// the response laps over it in the shared corner.
function renderMnemPairCanvas(sprite, oppContent, respContent, beardImg){
  const canvas = document.createElement('canvas');
  canvas.width = MNEM_PAIR_SIZE;
  canvas.height = MNEM_PAIR_SIZE;
  const ctx = canvas.getContext('2d');
  const far = MNEM_PAIR_SIZE - MNEM_QUADRANT;     // bottom-right box origin (256)
  drawMnemQuadrant(ctx, 0, 0, oppContent, beardImg);        // opponent pegged top-left
  drawMnemQuadrant(ctx, far, far, respContent, beardImg);   // response pegged bottom-right
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  sprite.material.map = tex;
  // hard alpha-cutout (vs. blended) avoids dark edge-fringing on photo/PNG
  // art; only needed when a quadrant actually holds an image.
  sprite.material.alphaTest = (oppContent.image || respContent.image) ? 0.5 : 0;
  sprite.material.color.set(0xffffff);
  sprite.material.needsUpdate = true;
  sprite.userData.baseH = MNEM_PAIR_UNITS;
  sprite.userData.baseAspect = 1;
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
  if(!imgSrc) return Promise.resolve({ text: wordFallback, beards });
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ image: img, beards });
    img.onerror = () => resolve({ text: wordFallback, beards });
    img.src = imgSrc;
  });
}

// builds the movable sprite for one mnemonic slot: position/scale come from
// the slot's base placement plus any saved nudge/scale xform (same pattern as
// placeSlotAccessory). Both moves of the pair are composited onto a single
// 1.5m x 1.5m billboard -- see DEMO_MNEMONICS comment above for why this
// replaced two independently camera-facing sprites.
function placeMnemonicSlot(roomKey, slot){
  const xform = slotXformFor(roomKey, slot.id) || {};
  const pair = slot.pair;
  const mat = new THREE.SpriteMaterial({ color: 0xffffff, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.userData = { kind: 'accessory', slotId: slot.id, userScale: xform.scale || 1 };
  sprite.position.set(slot.x + (xform.dx || 0), slot.y + (xform.dy || 0), slot.z + (xform.dz || 0));
  // immediate fallback (algebraic notation in both quadrants) while mnemonic data loads
  renderMnemPairCanvas(sprite, { text: pair.opponent.san }, { text: pair.response.san });
  const myGen = buildGeneration;
  Promise.all([getAllMnemonics(), loadBeardImage()]).then(([mnemonicsBySquare, beardImg]) => {
    if(buildGeneration !== myGen) return;
    Promise.all([
      resolveMoveContent(pair.opponent, mnemonicsBySquare),
      resolveMoveContent(pair.response, mnemonicsBySquare)
    ]).then(([oppContent, respContent]) => {
      if(buildGeneration !== myGen) return;
      renderMnemPairCanvas(sprite, oppContent, respContent, beardImg);
    });
  });
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
// as its own square decoration).
function makeNameSignMesh(name){
  const cw = 300, ch = 110;
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(240,236,226,0.95)';
  ctx.fillRect(4, 4, cw - 8, ch - 8);
  ctx.strokeStyle = '#caa46a';
  ctx.lineWidth = 4;
  ctx.strokeRect(7, 7, cw - 14, ch - 14);
  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let font = 56;
  ctx.font = `bold ${font}px serif`;
  while(font > 16 && ctx.measureText(name).width > cw - 36){ font -= 2; ctx.font = `bold ${font}px serif`; }
  ctx.fillText(name, cw/2, ch/2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.33), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
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
  getAllMnemonics().then((mn) => {
    if(buildGeneration !== myGen || !scene) return;
    resolveMoveContent(move, mn).then((c) => {
      if(buildGeneration !== myGen || !scene) return;
      draw(c); tex.needsUpdate = true;
    });
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(sizeM, sizeM), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
}

// Hint over a forward door: a name placard for the room beyond, and -- when that
// room has an opponent move -- a ~0.3m square decoration of that move mounted
// beside the sign, flat on the wall facing into the room. Hidden by the hints
// toggle for self-test.
function buildDoorHint(size, wall, offset, targetKey){
  const group = new THREE.Group();
  const name = (ROOMS[targetKey] && ROOMS[targetKey].name) || '';
  const move = mnemOpponentMove(targetKey);
  const { fixed } = wallSpan(size, wall);
  const clearance = WALL_THICK/2 + 0.03;
  const y = DOOR_H + 1.25;   // raised to clear the now-~4x-larger signs
  // mount a mesh flat on this wall at `along` (the wall-axis coordinate), facing in
  const mount = (mesh, along) => {
    if(wall === 'north'){ mesh.position.set(along, y, fixed + clearance); mesh.rotation.y = 0; }
    if(wall === 'south'){ mesh.position.set(along, y, fixed - clearance); mesh.rotation.y = Math.PI; }
    if(wall === 'west'){  mesh.position.set(fixed + clearance, y, along); mesh.rotation.y = Math.PI/2; }
    if(wall === 'east'){  mesh.position.set(fixed - clearance, y, along); mesh.rotation.y = -Math.PI/2; }
    group.add(mesh);
  };
  // ~4x larger (another 30% over the previous 3x) so door hints read from afar
  if(name){ const m = makeNameSignMesh(name); m.scale.set(3.9, 3.9, 1); mount(m, offset - (move ? 1.0 : 0)); }
  if(move) mount(makeMoveDecorationMesh(move, 1.17), offset + (name ? 2.15 : 0));
  return group;
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

// spelled-out ordinal for the elevator floor labels ("First Floor:", ...),
// falling back to the numeric ordinal past the named range.
const ORDINAL_WORDS = ['First','Second','Third','Fourth','Fifth','Sixth','Seventh',
  'Eighth','Ninth','Tenth','Eleventh','Twelfth'];
function ordinalWord(n){
  return ORDINAL_WORDS[n - 1] || ordinal(n);
}

// draws one floor list onto a canvas: "<Nth> Floor:" then the move's content
// per row -- the mnemonic image thumbnail when one has resolved, else the
// move's word, else its algebraic notation. contents[i] holds {image} or
// {text}, the same shape resolveMoveContent returns.
function makeElevatorPanelTexture(floors, contents){
  const cw = 380, rowH = 76;
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = Math.max(rowH, rowH * floors.length + 16);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 3;
  ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
  ctx.textBaseline = 'middle';
  floors.forEach((f, i) => {
    const rowTop = 16 + rowH * i;
    const cy = rowTop + rowH/2;
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 2;
    ctx.strokeRect(14, rowTop + 8, canvas.width - 28, rowH - 16);
    const content = contents && contents[i];
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'left';
    const label = `${ordinalWord(f.ordinal)} Floor:`;
    ctx.fillText(label, 22, cy);
    const contentX = 22 + ctx.measureText(label).width + 12;
    if(content && content.image){
      const thumb = rowH - 24;
      const im = content.image;
      const scale = Math.min(thumb / im.width, thumb / im.height);
      const w = im.width * scale, h = im.height * scale;
      ctx.drawImage(im, contentX, cy - h / 2, w, h);
    } else {
      ctx.fillText(content && content.text ? content.text : f.label, contentX, cy);
    }
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// elevator car only: a canvas-textured panel listing the floor buttons,
// mounted to the left of the forward door (mirrors buildExitSign's
// lintel-mount convention, but at chest height and offset along the wall
// rather than centred over the doorway). Built first with the plain
// algebraic-notation fallback (instant), then re-textured in place once
// each floor's mnemonic image resolves -- same async-then-upgrade pattern
// placeMnemonicSlot uses for the room billboards.
function buildElevatorPanel(size, wall, doorOffset, floors){
  const { fixed, half } = wallSpan(size, wall);
  const margin = 0.1;
  const avail = half - DOOR_W/2 - margin * 2;
  const panelW = Math.max(0.3, Math.min(0.7, avail));
  const panelH = Math.min(1.1, 0.28 * floors.length + 0.16);
  // physical size is dictated by the wall's clear space beside the door, not
  // the canvas's own pixel aspect -- the texture stretches slightly, an
  // acceptable tradeoff for fitting a multi-row panel into a narrow flank.
  const mat = new THREE.MeshBasicMaterial({ map: makeElevatorPanelTexture(floors, floors.map(f => ({ text: f.label }))) });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(panelW, panelH), mat);
  const clearance = WALL_THICK/2 + 0.02;
  const along = doorOffset - DOOR_W/2 - margin - panelW/2;
  const y = 1.5;
  if(wall === 'north'){ mesh.position.set(along, y, fixed + clearance); mesh.rotation.y = 0; }
  if(wall === 'south'){ mesh.position.set(along, y, fixed - clearance); mesh.rotation.y = Math.PI; }
  if(wall === 'west'){  mesh.position.set(fixed + clearance, y, along); mesh.rotation.y = Math.PI/2; }
  if(wall === 'east'){  mesh.position.set(fixed - clearance, y, along); mesh.rotation.y = -Math.PI/2; }

  const myGen = buildGeneration;
  getAllMnemonics().then((mnemonicsBySquare) => {
    if(buildGeneration !== myGen) return;
    Promise.all(floors.map(f => f.move ? resolveMoveContent(f.move, mnemonicsBySquare, true) : Promise.resolve({ text: f.label })))
      .then((contents) => {
        if(buildGeneration !== myGen) return;
        mat.map.dispose();
        mat.map = makeElevatorPanelTexture(floors, contents);
        mat.needsUpdate = true;
      });
  });
  return mesh;
}

// A cosmetic textured panel filling a doorway opening (DOOR_W x DOOR_H),
// double-sided since the same opening is approached from both rooms it
// connects. Only built when a door asset is assigned -- otherwise the
// doorway stays the open gap it always was.
function makeDoorPanelMesh(asset){
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W, DOOR_H), mat);
  const myGeneration = buildGeneration;
  textureLoader.load(asset.image, (tex) => {
    if(buildGeneration !== myGeneration) return;
    tex.colorSpace = THREE.SRGBColorSpace;
    mat.map = tex;
    mat.needsUpdate = true;
  });
  return mesh;
}
function buildDoorPanel(size, wall, offset, asset){
  const mesh = makeDoorPanelMesh(asset);
  const { fixed } = wallSpan(size, wall);
  const y = DOOR_H/2;
  if(wall === 'north'){ mesh.position.set(offset, y, fixed); mesh.rotation.y = 0; }
  if(wall === 'south'){ mesh.position.set(offset, y, fixed); mesh.rotation.y = Math.PI; }
  if(wall === 'west'){  mesh.position.set(fixed, y, offset); mesh.rotation.y = Math.PI/2; }
  if(wall === 'east'){  mesh.position.set(fixed, y, offset); mesh.rotation.y = -Math.PI/2; }
  return mesh;
}
let doorMarkerMat = null;
function doorMarkerMaterial(){
  if(!doorMarkerMat){
    doorMarkerMat = new THREE.MeshBasicMaterial({ color: 0xffeb3b, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false });
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

// A 'stair'-type exit gets a real protruding corridor instead of an ordinary
// doorway gap: the room's geometry grows a DOOR_W-wide hallway out through
// the wall, with stairs climbing from the room's own floor (0) up to its
// own ceiling height (room.size.h) by the far end. clampToRoom lets the
// player walk into this footprint, and floorHeightAtPos ramps their eye
// height to match as they climb (mirroring the decorative-steps-on-top-of-
// a-continuous-ramp split that buildStairs already uses for room.stairs).
// The far end is left open -- like an ordinary door, the "next room" is an
// illusion stitched together by enterRoom's teleport, not real geometry.
function buildStairCorridor(room, wall, offset, surfaceAsset, roomKey){
  const { axis, fixed } = wallSpan(room.size, wall);
  const outSign = fixed >= 0 ? 1 : -1;
  const { rise, steps, depth } = stairCorridorGeom(room);
  const dHalf = DOOR_W/2;
  const ceilingH = rise + EYE_HEIGHT + 1.0; // generous headroom above the highest step
  const group = new THREE.Group();
  // The corridor's side walls and ceiling can't be individually clicked (the
  // doorway's marker sits in front of them), so they always inherit whatever
  // skin the parent wall is wearing -- skin that wall and the corridor follows.
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
    if(axis === 'x'){ geo = new THREE.BoxGeometry(WALL_THICK, ceilingH, depth); x = across; z = fixed + outSign*depth/2; }
    else { geo = new THREE.BoxGeometry(depth, ceilingH, WALL_THICK); x = fixed + outSign*depth/2; z = across; }
    const sideWall = new THREE.Mesh(geo, wallMatFor(depth, ceilingH));
    sideWall.position.set(x, ceilingH/2, z);
    group.add(sideWall);
  }

  {
    let geo, x, z;
    if(axis === 'x'){ geo = new THREE.BoxGeometry(DOOR_W, WALL_THICK, depth); x = offset; z = fixed + outSign*depth/2; }
    else { geo = new THREE.BoxGeometry(depth, WALL_THICK, DOOR_W); x = fixed + outSign*depth/2; z = offset; }
    const ceiling = new THREE.Mesh(geo, wallMatFor(depth, DOOR_W));
    ceiling.position.set(x, ceilingH + WALL_THICK/2, z);
    group.add(ceiling);
  }

  const stepMat = stairMaterial(roomKey, DOOR_W);
  const stepTag = { kind: 'stair-surface', roomKey };
  const stepRise = rise / steps;
  for(let i = 0; i < steps; i++){
    const stepH = stepRise * (i+1);
    const along = (i + 0.5) * STAIR_STEP_RUN;
    let geo, x, z;
    if(axis === 'x'){ geo = new THREE.BoxGeometry(DOOR_W*0.96, stepH, STAIR_STEP_RUN); x = offset; z = fixed + outSign*along; }
    else { geo = new THREE.BoxGeometry(STAIR_STEP_RUN, stepH, DOOR_W*0.96); x = fixed + outSign*along; z = offset; }
    const step = new THREE.Mesh(geo, stepMat);
    step.position.set(x, stepH/2, z);
    step.userData = stepTag;
    group.add(step);
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
  const c = currentStairCorridors[wall];
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
  const inset = Math.min(2.5, Math.max(0.6, depthDim/2 - 0.3));
  let x, z, yaw;
  if(wall === 'north'){ x = offset; z = inside ? fixed+inset : fixed-inset; yaw = inside ? Math.PI : 0; }
  if(wall === 'south'){ x = offset; z = inside ? fixed-inset : fixed+inset; yaw = inside ? 0 : Math.PI; }
  if(wall === 'west'){  z = offset; x = inside ? fixed+inset : fixed-inset; yaw = inside ? -Math.PI/2 : Math.PI/2; }
  if(wall === 'east'){  z = offset; x = inside ? fixed-inset : fixed+inset; yaw = inside ? Math.PI/2 : -Math.PI/2; }
  return { x: x + origin.x, z: z + origin.z, yaw };
}

function computeSpawnForExit(fromKey, room, ex){
  const targetRoom = mergedRoom(ex.target);
  if(targetRoom.outdoor){
    // walking out of a building's front door onto the street
    const building = targetRoom.buildings.find(b => b.target === fromKey);
    return doorSpawn(room.size, ex.wall, ex.offset, building.origin, false);
  }
  // ordinary interior-to-interior transition: spawn just inside whichever
  // of the target room's own exits leads back to the room we're leaving
  const returning = targetRoom.exits.find(e => e.target === fromKey) || targetRoom.exits[0];
  return doorSpawn(targetRoom.size, returning.wall, returning.offset, null, true);
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
  const tex = makeBrickTexture(0x8a7f6a);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(Math.max(1, len / 2), 1);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(DIVIDER_THICK, wallH, len),
    new THREE.MeshStandardMaterial({ map: tex }));
  mesh.position.set(0, wallH / 2, (b.zMax + b.zMin) / 2);
  mesh.userData = { kind: 'divider' };
  return mesh;
}
function buildRoom(roomKey){
  const room = mergedRoom(roomKey);
  buildGeneration++;
  const myGeneration = buildGeneration;
  scene.clear();
  billboards = [];

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
  if(room.twoTrack) scene.add(buildTwoTrackDivider(room));

  currentExitsByWall = {};
  currentStairCorridors = {};
  for(const ex of room.exits){
    currentExitsByWall[ex.wall] = ex;
    if(ex.type === 'stair'){
      const { fixed } = wallSpan(room.size, ex.wall);
      const { rise, depth } = stairCorridorGeom(room);
      currentStairCorridors[ex.wall] = { rise, depth, outSign: fixed >= 0 ? 1 : -1 };
    }
  }

  exitMeta = [];
  elevatorMeta = [];
  closeElevatorPopup();
  currentBuildingColliders = [];

  if(!room.outdoor){
    const wallTex = carMode ? makePlainWallTexture(room.color) : makeBrickTexture(room.color);
    for(const wall of ['north','south','east','west']){
      // gather EVERY exit on this wall. Car rooms put a floor's worth of buttons
      // behind a single door; ordinary rooms can also now carry several doors on
      // one wall (e.g. the user moved two exits to the same side), so each one
      // needs its own gap + panel + trigger -- not just whichever the
      // currentExitsByWall map last saw.
      const wallExits = room.exits.filter(e => e.wall === wall);
      const ex0 = wallExits[0];
      // a car's floor buttons all share ONE physical door; ordinary rooms cut a
      // gap per exit.
      const doorOffsets = carMode ? (ex0 ? [ex0.offset] : []) : wallExits.map(e => e.offset);
      const group = buildWallGroup(room.size, wall, !!ex0, ex0 ? ex0.offset : 0, wallTex, null,
        { editable: true, surfaceAsset: wallAssetFor(roomKey, wall), doorOffsets });
      scene.add(group);

      if(carMode){
        if(ex0){
          const dKey = doorKey(wall, ex0.offset);
          const doorAsset = doorAssetFor(roomKey, dKey) || defaultDoorAsset(roomKey, !!ex0.back);
          const box = doorTriggerBox(room.size, wall, ex0.offset);
          const thru = WALL_OUT_NORMAL[wall];
          if(ex0.back){
            elevatorMeta.push({ box, thru, kind: 'back', target: ex0.target, spawn: computeSpawnForExit(roomKey, room, ex0) });
            scene.add(buildExitSign(room.size, wall, ex0.offset));
          } else {
            const floors = wallExits.map((fe, i) => ({
              ordinal: i + 1,
              label: fe.label || fe.target,
              move: mnemOpponentMove(fe.target),
              target: fe.target,
              spawn: computeSpawnForExit(roomKey, room, fe)
            }));
            elevatorMeta.push({ box, thru, kind: 'forward', floors });
            scene.add(buildElevatorPanel(room.size, wall, ex0.offset, floors));
          }
          if(doorAsset) scene.add(buildDoorPanel(room.size, wall, ex0.offset, doorAsset));
          if(editMode) scene.add(buildDoorMarker(room.size, wall, ex0.offset, roomKey, dKey));
        }
      } else {
        for(const ex of wallExits){
          const isStair = ex.type === 'stair';
          const dKey = doorKey(wall, ex.offset);
          // room override wins, else the building's exit-door / ordinary-door default
          const doorAsset = doorAssetFor(roomKey, dKey) || defaultDoorAsset(roomKey, !!ex.back);
          const spawn = computeSpawnForExit(roomKey, room, ex);
          const box = isStair ? stairTriggerBox(room, wall, ex.offset) : doorTriggerBox(room.size, wall, ex.offset);
          exitMeta.push({ box, thru: WALL_OUT_NORMAL[wall], target: ex.target, spawn });
          if(ex.back) scene.add(buildExitSign(room.size, wall, ex.offset));
          if(doorAsset && !isStair) scene.add(buildDoorPanel(room.size, wall, ex.offset, doorAsset));
          if(isStair) scene.add(buildStairCorridor(room, wall, ex.offset, wallAssetFor(roomKey, wall), roomKey));
          // forward-door hint: name (and move thumbnail) of the room beyond
          if(hintsOn && !ex.back) scene.add(buildDoorHint(room.size, wall, ex.offset, ex.target));
          if(editMode) scene.add(buildDoorMarker(room.size, wall, ex.offset, roomKey, dKey));
        }
      }
    }
    if(room.stairs) scene.add(buildStairs(room, roomKey));
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
        // Out on the lawn to the right of the front door (as seen walking
        // up to it), like a museum or apartment-complex entrance sign --
        // not mounted on the facade itself. The skin (if any) is an
        // override image stretched behind the name text -- see signAssetFor.
        const signAsset = signAssetFor(roomKey, buildingKey);
        const off = signPosFor(roomKey, buildingKey) || {};
        const signBase = { x: b.origin.x + 6, z: b.origin.z + size.d/2 + 1.6 };
        const signPos = { x: signBase.x + (off.dx || 0), z: signBase.z + (off.dz || 0) };
        const signGroup = buildGroundSign(b.sign, signAsset);
        signGroup.position.set(signPos.x, 0, signPos.z);
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
}

// Called after the asset manager is closed while the walking tour is still
// open (e.g. opened on top via the in-world Assets button), so any
// added/edited assets show up immediately without re-entering the room by hand.
export async function refreshAssetsLive(){
  if(!scene) return; // tour isn't open
  await refreshAssetMap();
  buildRoom(currentRoomKey);
}

function enterRoom(roomKey, spawn, preserveYaw){
  // remember where we came in *before* building, so floor props can face it
  entryPoint = { x: spawn.x, z: spawn.z };
  const keepYaw = preserveYaw ? yaw : spawn.yaw;
  buildRoom(roomKey);
  pos.x = spawn.x; pos.z = spawn.z; yaw = keepYaw;
  teleportLockUntil = clock.getElapsedTime() + 0.6;
}

// elevator-car doors don't teleport on contact like a normal exit -- they
// pop up a choice instead (a floor list for the forward door, a single
// confirm for the back one), reusing inputLocked the same way the asset
// picker does to freeze movement while it's open. Lightweight prototype
// interaction per spec: no animated door-slide, just the popup.
function openElevatorPopup(meta){
  activeElevatorDoor = meta;
  inputLocked = true;
  let ov = document.getElementById('elevatorOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'elevatorOverlay';
    ov.className = 'overlay';
    ov.style.zIndex = '70';
    document.body.appendChild(ov);
  }
  // text-only fallback shows instantly; thumbnails patch in once the
  // mnemonic image data resolves (same image-or-text priority as the
  // wall panel/billboards), as long as the popup hasn't moved on by then.
  renderElevatorPopup(ov, meta, null);
  if(meta.kind === 'forward'){
    getAllMnemonics().then((mnemonicsBySquare) => {
      if(activeElevatorDoor === meta) renderElevatorPopup(ov, meta, mnemonicsBySquare);
    });
  }
}
function renderElevatorPopup(ov, meta, mnemonicsBySquare){
  const floorRow = (f) => {
    const entry = f.move && mnemonicsBySquare && mnemonicsBySquare[f.move.to];
    const imgSrc = entry && entry[f.move.piece + 'Img'];
    const word = entry && entry[f.move.piece];
    // content priority: image -> word -> move notation (thumbnails doubled to 4.4em)
    const content = imgSrc
      ? `<img data-elevator-thumb src="${imgSrc}" style="width:4.4em;height:4.4em;object-fit:contain;border-radius:3px">`
      : `<span>${(word && word.trim()) ? word.trim() : f.label}</span>`;
    return `<button data-elevator-target="${f.target}" style="display:flex;align-items:center;gap:.5em"><span>${ordinalWord(f.ordinal)} Floor:</span>${content}</button>`;
  };
  const buttonsHtml = meta.kind === 'back'
    ? `<button data-elevator-target="${meta.target}">Go back</button>`
    : meta.floors.map(floorRow).join('');
  ov.innerHTML = `
    <div class="modal" style="width:min(18em,86vw)">
      <h2>${meta.kind === 'back' ? 'Elevator' : 'Choose a floor'}</h2>
      <div style="display:flex;flex-direction:column;gap:.4rem">${buttonsHtml}</div>
      <div class="modal-actions"><button data-elevator-cancel="1">Cancel</button></div>
    </div>
  `;
  ov.style.display = 'flex';
  ov.querySelectorAll('img[data-elevator-thumb]').forEach(img => {
    img.addEventListener('error', () => img.remove());
  });
  ov.querySelectorAll('[data-elevator-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-elevator-target');
      const dest = meta.kind === 'back' ? meta : meta.floors.find(f => f.target === target);
      closeElevatorPopup();
      enterRoom(dest.target, dest.spawn, false);
    });
  });
  ov.querySelector('[data-elevator-cancel]').addEventListener('click', () => closeElevatorPopup());
}
function closeElevatorPopup(){
  const ov = document.getElementById('elevatorOverlay');
  if(ov) ov.style.display = 'none';
  inputLocked = false;
  activeElevatorDoor = null;
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

  // touch joystick (mobile): x turns, y walks -- same axes as the keys above
  if(!inputLocked){ turn -= joyVec.x; move += joyVec.y; }
  turn = Math.max(-1, Math.min(1, turn));
  move = Math.max(-1, Math.min(1, move));

  yaw += turn * TURN_SPEED * dt;
  if(move !== 0 && !inputLocked){
    const room = mergedRoom(currentRoomKey);
    // outdoors covers much more ground, so walk 50% faster out there; interiors
    // keep the base speed.
    const speed = room.outdoor ? MOVE_SPEED * 1.5 : MOVE_SPEED;
    // camera forward vector for rotation.y = yaw is (-sin(yaw), -cos(yaw))
    pos.x += -Math.sin(yaw) * move * speed * dt;
    pos.z += -Math.cos(yaw) * move * speed * dt;
    let clamped = clampToRoom(room.size, pos.x, pos.z);
    if(room.outdoor) clamped = clampBuildings(clamped.x, clamped.z);
    if(room.twoTrack) clamped = clampOutOfDivider(room, clamped.x, clamped.z);
    pos.x = clamped.x; pos.z = clamped.z;
  }

  const eyeY = EYE_HEIGHT + floorHeightAtPos(mergedRoom(currentRoomKey), pos.x, pos.z);
  camera.position.set(pos.x, eyeY, pos.z);
  camera.rotation.set(0, yaw, 0);
  window.__threeTestState = { room: currentRoomKey, x: pos.x, z: pos.z, y: eyeY, yaw, editMode };

  // cylindrical billboards: rotate to face the camera horizontally each frame
  for(const b of billboards){
    b.rotation.y = Math.atan2(camera.position.x - b.position.x, camera.position.z - b.position.z);
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

  // door teleports are suppressed in edit mode so you can stand in a doorway
  // and edit the wall beside it without being yanked into the next room.
  // Only trigger when actually heading OUT through the door: forward movement
  // (move > 0) whose facing has a positive component along the door's through
  // direction. Without the facing check, backing up to a wall (which leaves you
  // parked inside the trigger box) and then nudging forward into the room would
  // fire the exit even though you're walking away from the door.
  if(!editMode && move > 0 && clock.getElapsedTime() > teleportLockUntil){
    const fwd = cameraForwardVec();
    for(const m of exitMeta){
      if(pos.x >= m.box.minX && pos.x <= m.box.maxX && pos.z >= m.box.minZ && pos.z <= m.box.maxZ
         && (!m.thru || fwd.x*m.thru.x + fwd.z*m.thru.z > 0)){
        enterRoom(m.target, m.spawn, false);
        break;
      }
    }
  }

  // elevator doors pop up a choice instead of teleporting on contact --
  // open it on forward approach, and auto-close if the player steps back
  // out of the doorway without picking anything.
  if(!editMode){
    if(activeElevatorDoor){
      const b = activeElevatorDoor.box;
      const stillIn = pos.x >= b.minX && pos.x <= b.maxX && pos.z >= b.minZ && pos.z <= b.maxZ;
      if(!stillIn) closeElevatorPopup();
    } else if(move > 0 && clock.getElapsedTime() > teleportLockUntil){
      const fwd = cameraForwardVec();
      for(const m of elevatorMeta){
        if(pos.x >= m.box.minX && pos.x <= m.box.maxX && pos.z >= m.box.minZ && pos.z <= m.box.maxZ
           && (!m.thru || fwd.x*m.thru.x + fwd.z*m.thru.z > 0)){
          openElevatorPopup(m);
          break;
        }
      }
    }
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
  if(!gearMat) gearMat = new THREE.SpriteMaterial({ map: gearTexture, depthTest: false });
  const sprite = new THREE.Sprite(gearMat);
  sprite.scale.set(0.35, 0.35, 1);
  return sprite;
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
  const box = new THREE.Box3().setFromObject(found);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);

  const outline = new THREE.Mesh(
    new THREE.BoxGeometry(size.x + 0.04, size.y + 0.04, size.z + 0.04),
    new THREE.MeshBasicMaterial({ color: 0xffd400, wireframe: true, depthTest: false })
  );
  outline.position.copy(center);
  scene.add(outline);
  selectionOutline = outline;

  // mnemonic billboards aren't asset-based, so there's nothing for the gear
  // icon's picker to do -- skip it, the outline alone shows the selection.
  if(selectedProp.kind !== 'mnemonic'){
    const gear = buildGearSprite();
    gear.userData = isSign
      ? { kind: 'sign-gear', buildingKey: selectedProp.buildingKey }
      : { kind: 'prop-gear', slotId: selectedProp.slotId };
    scene.add(gear);
    selectionGear = gear;
    selectionAnchor = { center: center.clone(), halfW: size.x/2, halfH: size.y/2 };
  }
}

// explicit teardown for deselecting without a full room rebuild (buildRoom's
// scene.clear() already wipes these when a rebuild happens instead).
function removeSelectionVisuals(){
  if(selectionOutline){ scene.remove(selectionOutline); selectionOutline = null; }
  if(selectionGear){ scene.remove(selectionGear); selectionGear = null; }
  selectionAnchor = null;
}

function selectProp(roomKey, slotId){
  const slot = slotById(mergedRoom(roomKey), roomKey, slotId);
  if(!slot) return;
  selectedProp = { roomKey, slotId, kind: slot.kind, ground: !!slot.ground };
  attachSelectionVisuals();
  updateEditHud();
}
function selectSign(roomKey, buildingKey){
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
    onClose: () => { inputLocked = false; },
    onPick: id => setSlotOverride(roomKey, slotId, id),
    onRemove: () => { deselectProp(); setSlotOverride(roomKey, slotId, null); }
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
  else openPropManager(selectedProp.roomKey, selectedProp.slotId);
}

// arrows nudge the selected prop 0.1m per press. Floor props move along the
// camera's current forward/right (so "right" always means the player's
// right); wall props move along the wall's own axes instead, since you're
// normally facing the wall you're editing -- up/down is true vertical, not
// camera-relative, and ground (low) wall props only get left/right.
function nudgeSelected(key){
  if(!selectedProp) return;
  const { roomKey, slotId, kind, ground, buildingKey } = selectedProp;
  const room = mergedRoom(roomKey);

  // A building sign moves freely on the lawn (camera-relative, same convention
  // as floor props), clamped to the room bounds. Its offset persists in
  // r.signPos rather than the slot-xform store.
  if(kind === 'sign'){
    const fwd = cameraForwardVec(), right = cameraRightVec();
    const cur = signPosFor(roomKey, buildingKey) || {};
    let dx = cur.dx || 0, dz = cur.dz || 0;
    if(key === 'ArrowRight'){ dx += right.x * NUDGE_STEP; dz += right.z * NUDGE_STEP; }
    if(key === 'ArrowLeft'){  dx -= right.x * NUDGE_STEP; dz -= right.z * NUDGE_STEP; }
    if(key === 'ArrowUp'){    dx += fwd.x * NUDGE_STEP;   dz += fwd.z * NUDGE_STEP; }
    if(key === 'ArrowDown'){  dx -= fwd.x * NUDGE_STEP;   dz -= fwd.z * NUDGE_STEP; }
    setSignPosLive(roomKey, buildingKey, { dx, dz });
    return;
  }

  const slot = slotById(room, roomKey, slotId);
  if(!slot) return;
  const xform = Object.assign({}, slotXformFor(roomKey, slotId));

  if(kind === 'floor' || kind === 'moveObject'){
    // a move-object rests on the floor like a floor prop and nudges the same way
    // (camera-relative); a future leash will clamp it near its billboard.
    const fwd = cameraForwardVec(), right = cameraRightVec();
    let dx = xform.dx || 0, dz = xform.dz || 0;
    if(key === 'ArrowRight'){ dx += right.x * NUDGE_STEP; dz += right.z * NUDGE_STEP; }
    if(key === 'ArrowLeft'){  dx -= right.x * NUDGE_STEP; dz -= right.z * NUDGE_STEP; }
    if(key === 'ArrowUp'){    dx += fwd.x * NUDGE_STEP;   dz += fwd.z * NUDGE_STEP; }
    if(key === 'ArrowDown'){  dx -= fwd.x * NUDGE_STEP;   dz -= fwd.z * NUDGE_STEP; }
    const clamped = clampFloorXZ(room.size, slot.x + dx, slot.z + dz);
    xform.dx = clamped.x - slot.x;
    xform.dz = clamped.z - slot.z;
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
    // it horizontally (camera-relative, same convention as floor props) and
    // PageUp/PageDown (or h/l, for keyboards without dedicated Page keys)
    // move it vertically -- a pure position change, the graphic itself isn't
    // stretched.
    const fwd = cameraForwardVec(), right = cameraRightVec();
    let dx = xform.dx || 0, dz = xform.dz || 0, dy = xform.dy || 0;
    if(key === 'ArrowRight'){ dx += right.x * NUDGE_STEP; dz += right.z * NUDGE_STEP; }
    if(key === 'ArrowLeft'){  dx -= right.x * NUDGE_STEP; dz -= right.z * NUDGE_STEP; }
    if(key === 'ArrowUp'){    dx += fwd.x * NUDGE_STEP;   dz += fwd.z * NUDGE_STEP; }
    if(key === 'ArrowDown'){  dx -= fwd.x * NUDGE_STEP;   dz -= fwd.z * NUDGE_STEP; }
    if(key === 'PageUp'   || key === 'h' || key === 'H') dy += NUDGE_STEP;
    if(key === 'PageDown' || key === 'l' || key === 'L') dy -= NUDGE_STEP;
    xform.dx = dx; xform.dz = dz; xform.dy = dy;
  } else {
    return; // ceiling slot: only scaling applies, no nudge
  }
  setSlotXformLive(roomKey, slotId, xform);
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
  const asset = slotAssetFor(roomKey, slotId);
  if(!asset || asset.type !== 'extruded') return;
  const xform = Object.assign({}, slotXformFor(roomKey, slotId));
  xform.dYaw = (xform.dYaw || 0) - dir * ROT_STEP;   // clockwise from above = negative yaw
  setSlotXformLive(roomKey, slotId, xform);
}

/* ---------- in-world layout editor: click handling ---------- */
function findInteractive(obj){
  while(obj){
    if(obj.userData && obj.userData.kind) return obj.userData;
    obj = obj.parent;
  }
  return null;
}

function onCanvasClick(e){
  if(!editMode || inputLocked || !raycaster) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  // The selection gear renders on top (depthTest off), so a click anywhere over
  // it should hit it even when a prop or move billboard sits in front -- scan
  // all hits and let a gear win over the nearest ordinary target.
  let gearUd = null, firstUd = null;
  for(const hit of hits){
    const ud = findInteractive(hit.object);
    if(!ud) continue;
    if(!firstUd) firstUd = ud;
    if(ud.kind === 'prop-gear' || ud.kind === 'sign-gear'){ gearUd = ud; break; }
  }
  const ud = gearUd || firstUd;
  if(ud){ handleEditTarget(ud); return; }
  // clicked nothing interactive (e.g. open floor/sky past everything) --
  // treat it as "click away" and drop the current selection, if any
  if(selectedProp) deselectProp();
}

function handleEditTarget(ud){
  const roomKey = currentRoomKey;

  if(ud.kind === 'prop-gear'){
    inputLocked = true;
    openPropManager(roomKey, ud.slotId);
    return;
  }
  if(ud.kind === 'accessory'){
    if(selectedProp && selectedProp.slotId === ud.slotId) deselectProp();
    else selectProp(roomKey, ud.slotId);
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
      allow: ['surface'], onClose, ...surfacePickerExtras(roomKey, 'floor', null, floorAssetFor(roomKey)),
      onPick: id => setFloorOverride(roomKey, id),
      onRemove: () => setFloorOverride(roomKey, null)
    });
  } else if(ud.kind === 'wall'){
    openAssetPicker({
      allow: ['surface'], onClose, ...surfacePickerExtras(roomKey, 'wall', ud.wall, wallAssetFor(roomKey, ud.wall)),
      onPick: id => setWallOverride(roomKey, ud.wall, id),
      onRemove: () => setWallOverride(roomKey, ud.wall, null)
    });
  } else if(ud.kind === 'ceiling-surface'){
    openAssetPicker({
      allow: ['surface'], onClose, ...surfacePickerExtras(roomKey, 'ceiling', null, ceilingAssetFor(roomKey)),
      onPick: id => setCeilingOverride(roomKey, id),
      onRemove: () => setCeilingOverride(roomKey, null)
    });
  } else if(ud.kind === 'stair-surface'){
    openAssetPicker({
      allow: ['surface'], onClose, ...surfacePickerExtras(roomKey, 'stair', null, stairAssetFor(roomKey)),
      onPick: id => setStairOverride(roomKey, id),
      onRemove: () => setStairOverride(roomKey, null)
    });
  } else if(ud.kind === 'slot'){
    openAssetPicker({
      allow: ud.allow, onClose,
      onPick: id => setSlotOverride(roomKey, ud.slotId, id)
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
    const override = doorAssetFor(ud.roomKey, ud.doorKey);     // raw override (asset or null)
    const def = defaultDoorAsset(ud.roomKey, isExit);
    const eff = override || def;
    openAssetPicker({
      allow: ['door'], onClose,
      allowRemove: !!override,
      currentId: (eff && eff.id) || null,
      currentSource: override ? 'room' : (eff ? 'default' : null),
      defaultExists: !!def,
      onPick: id => setDoorOverride(ud.roomKey, ud.doorKey, id),
      onRemove: () => setDoorOverride(ud.roomKey, ud.doorKey, null)
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
    defaultExists: !!def
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
  editMode = on;
  if(!on) deselectProp();
  if(renderer) renderer.domElement.style.cursor = on ? 'crosshair' : 'default';
  updateEditHud();
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
// icon controls overlaid on the canvas: a flush-left group (hints, edit, and
// the edit-only room/asset buttons, then help) plus the close (✕) pushed flush
// right. The bar spans the top width with the empty middle clicking through.
function buildTopToolbar(){
  const bar = document.createElement('div');
  bar.style.cssText = 'position:absolute;top:8px;left:8px;right:8px;display:flex;'
    + 'justify-content:space-between;align-items:flex-start;z-index:6;pointer-events:none;';
  const left = document.createElement('div');
  left.style.cssText = 'display:flex;gap:6px;pointer-events:none;';
  hintsBtn    = makeIconBtn('fa-lightbulb',      'Show/hide hints (room names, door hints, move billboards)', () => setHintsOn(!hintsOn));
  editBtn     = makeIconBtn('fa-pencil',         'Edit mode',     () => setEditMode(!editMode));
  roomGeomBtn = makeIconBtn('fa-ruler-combined', 'Room geometry', () => openRoomGeomDialog(currentRoomKey));
  assetsBtn   = makeIconBtn('fa-cubes',          'Asset library', () => { if(threeOpts.onAssets) threeOpts.onAssets(); });
  infoBtn     = makeIconBtn('fa-circle-info',    'Help',          () => toggleHelp());
  closeBtn    = makeIconBtn('fa-circle-xmark',   'Close',         () => { if(threeOpts.onClose) threeOpts.onClose(); });
  left.append(hintsBtn, editBtn, roomGeomBtn, assetsBtn, infoBtn);
  bar.append(left, closeBtn);
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
      <p style="margin:.4rem 0"><strong>Move:</strong> arrows or W/A/S/D. Walk forward through a doorway to enter the room beyond. Press R to return to the start.</p>
      <p style="margin:.4rem 0"><strong><i class="fa-solid fa-lightbulb"></i> Hints:</strong> show/hide room names, the move hint beside each door, and the in-room move billboards — turn them off to self-test your recall.</p>
      <p style="margin:.4rem 0"><strong><i class="fa-solid fa-pencil"></i> Edit mode:</strong> click the floor, a wall, stairs, a slot, or a doorway to skin/assign it. With an item selected, arrows nudge it, &lt; &gt; rotate, +/− scale. <i class="fa-solid fa-ruler-combined"></i> opens room geometry, <i class="fa-solid fa-cubes"></i> the asset library. Press Esc (or the pencil) to leave edit mode.</p>
      <p style="margin:.4rem 0"><strong>Touch:</strong> use the on-screen joystick to walk; in edit mode an on-screen pad moves/scales the selected item.</p>
      <div style="text-align:right;margin-top:.9rem"><button id="threeHelpCloseBtn">Close</button></div>
    </div>`;
  ov.addEventListener('click', (e) => { if(e.target === ov) toggleHelp(false); });
  ov.querySelector('#threeHelpCloseBtn').addEventListener('click', () => toggleHelp(false));
  return ov;
}
function toggleHelp(show){
  if(!helpOverlay) return;
  const on = show === undefined ? helpOverlay.style.display === 'none' : show;
  helpOverlay.style.display = on ? 'flex' : 'none';
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

  // left cluster: scale, height (mnemonic only), change (assets only), done
  const col = document.createElement('div');
  col.style.cssText = 'position:absolute;left:10px;bottom:14px;display:flex;flex-direction:column;gap:6px;';
  const rowOf = (...els) => { const r = document.createElement('div'); r.style.cssText = 'display:flex;gap:6px'; r.append(...els); return r; };
  if(!sign) col.appendChild(rowOf(            // signs are fixed-size, no scaling
    makeTouchBtn('Bigger', () => scaleSelected(SCALE_STEP)),
    makeTouchBtn('Smaller', () => scaleSelected(1 / SCALE_STEP))
  ));
  if(mnem) col.appendChild(rowOf(
    makeTouchBtn('Higher', () => nudgeSelected('PageUp')),
    makeTouchBtn('Lower', () => nudgeSelected('PageDown'))
  ));
  else col.appendChild(rowOf(
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
        doors: exit ${m(d.exitDoor)}, std ${m(d.door)}
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
function renderRoomGeomDialog(ov, roomKey){
  const room = mergedRoom(roomKey);
  const { w, d, h } = room.size;
  // read straight off the static ROOMS config: exits, stairs and (outdoor)
  // building footprints don't move when the room is resized, so the live
  // preview overlays them on whatever width/depth the user is typing.
  const staticRoom = ROOMS[roomKey] || {};
  const staticExits = staticRoom.exits || [];
  const stairs = staticRoom.stairs || null;
  const buildings = staticRoom.buildings || [];

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
  const exitTypeRows = staticExits.map(ex => `
    <label style="display:flex;align-items:center;justify-content:space-between;font-size:.78rem;gap:.5rem;padding:.15rem 0">
      <span>${ex.target}${ex.back ? ' ↩' : ''}</span>
      <select data-exit-type-for="${ex.target}" style="font-size:.78rem">
        <option value="door" ${stagedExits[ex.target].type === 'door' ? 'selected' : ''}>Door</option>
        <option value="stair" ${stagedExits[ex.target].type === 'stair' ? 'selected' : ''}>Staircase</option>
        <option value="elevator" ${stagedExits[ex.target].type === 'elevator' ? 'selected' : ''}>Elevator</option>
      </select>
    </label>
  `).join('');
  ov.innerHTML = `
    <div class="modal" style="width:min(28em,92vw);max-height:92vh;overflow:auto">
      <h2>Room Geometry — ${roomKey}</h2>
      <div style="display:flex;gap:.7rem;flex-wrap:wrap;margin-bottom:.7rem">
        <label style="display:flex;flex-direction:column;font-size:.8rem;gap:.2rem">Width (m)
          <input type="number" step="0.1" min="${ROOM_GEOM_MIN}" id="roomGeomW" value="${w}" style="width:6em">
        </label>
        <label style="display:flex;flex-direction:column;font-size:.8rem;gap:.2rem">Depth (m)
          <input type="number" step="0.1" min="${ROOM_GEOM_MIN}" id="roomGeomD" value="${d}" style="width:6em">
        </label>
        <label style="display:flex;flex-direction:column;font-size:.8rem;gap:.2rem">Height (m)
          <input type="number" step="0.1" min="${ROOM_GEOM_MIN}" id="roomGeomH" value="${h}" style="width:6em">
        </label>
      </div>
      <canvas id="roomGeomPlan" width="300" height="300" style="background:#eee;border-radius:4px;display:block;margin:0 auto .4rem;cursor:grab;touch-action:none"></canvas>
      <p style="margin:0 0 .5rem;font-size:.72rem;color:#888;text-align:center">Top-down plan. Drag a doorway to nudge it or move it to another wall. Hatched = stairs platform.</p>
      ${exitTypeRows ? `<div style="border-top:1px solid #e0e0e0;padding-top:.4rem;margin-bottom:.7rem">${exitTypeRows}</div>` : ''}
      <div id="roomGeomDefaultsBox" style="border:1px solid #e0e0e0;border-radius:4px;padding:.4rem .5rem;margin-bottom:.5rem">${defaultsBoxHtml(roomKey)}</div>
      <div id="roomGeomPresetsBox" style="border:1px solid #e0e0e0;border-radius:4px;padding:.4rem .5rem;margin-bottom:.6rem">${presetsBoxHtml(roomKey)}</div>
      <label style="display:flex;align-items:flex-start;gap:.45rem;font-size:.76rem;color:#555;margin-bottom:.6rem;line-height:1.3">
        <input type="checkbox" id="roomGeomMakeDefault" style="margin-top:.15rem">
        <span>On Apply, make this room's floor / walls / ceiling / stairs / doors the default for new rooms in this building (walls are anchored to the entrance door; the exit door keeps its own style).</span>
      </label>
      <div class="modal-actions" style="display:flex;justify-content:space-between;align-items:center">
        <div style="display:flex;gap:.4rem">
          <button id="roomGeomResetBtn">Reset size/doors</button>
          <button id="roomGeomClearBtn" style="background:#c62828;color:#fff">Clear styles…</button>
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
  for(const sel of ov.querySelectorAll('[data-exit-type-for]')){
    sel.addEventListener('change', () => {
      stagedExits[sel.dataset.exitTypeFor].type = sel.value;
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
        if(pos.type !== 'stair') continue;
        ctx.strokeStyle = '#8d6e63'; ctx.lineWidth = 1.5; ctx.setLineDash([3,2]);
        ctx.fillStyle = 'rgba(141,110,99,.12)';
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
      const isStair = pos.type === 'stair';
      const baseColor = isStair ? '#8d6e63' : '#2e7d32';
      const labelColor = isStair ? '#4e342e' : '#1b5e20';
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
      const label = ex.target + (ex.back ? ' ↩' : '') + (isStair ? ' ⌐' : '');
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
      `Clear ALL styling and placed objects in "${roomKey}"?\n\n` +
      `The floor, walls, ceiling, stairs, door skins and every placed prop in this ` +
      `room will be permanently removed and the room will revert to the building ` +
      `defaults. The room's size and doorways are kept.\n\nThis cannot be undone.`
    )) return;
    closeRoomGeomDialog();
    clearRoomStyles(roomKey);     // wipes this room only; LAYOUT.__defaults is untouched
  };
  ov.querySelector('#roomGeomApplyBtn').onclick = () => {
    const w2 = Math.max(ROOM_GEOM_MIN, Number(wEl.value) || room.size.w);
    const d2 = Math.max(ROOM_GEOM_MIN, Number(dEl.value) || room.size.d);
    const h2 = Math.max(ROOM_GEOM_MIN, Number(hEl.value) || room.size.h);
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
  if(activeElevatorDoor){
    if(e.key === 'Escape') closeElevatorPopup();
    return; // swallow everything else while the elevator popup is open
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
    if(selectedProp.kind === 'mnemonic' &&
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
  // 'e' is intentionally NOT an edit-mode shortcut (too close to 'w'); use the
  // pencil toolbar button. Esc still exits edit mode.
  if(e.key === 'Escape' && editMode){ setEditMode(false); return; }
  if(e.key === 'r' || e.key === 'R'){ enterRoom(START_ROOM, START_SPAWN); return; }
  keys[e.key] = true;
}
function onKeyUp(e){ keys[e.key] = false; }

export async function openThreeTest(containerEl, opts){
  container = containerEl;
  threeOpts = opts || {};
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

  editMode = false;
  inputLocked = false;
  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  await loadLayout();
  await refreshAssetMap();

  container.innerHTML = '';
  renderer = new THREE.WebGLRenderer({ antialias:true });
  container.appendChild(renderer.domElement);

  // editor HUD overlay (hidden until edit mode is on)
  editHud = document.createElement('div');
  // sits just below the top-left icon toolbar so the two don't overlap
  editHud.style.cssText = 'position:absolute;top:62px;left:8px;padding:.35rem .6rem;'
    + 'background:rgba(21,101,192,.85);color:#fff;font:600 .8rem sans-serif;'
    + 'border-radius:4px;pointer-events:none;display:none;z-index:2;max-width:calc(100% - 16px)';
  editHud.textContent = 'EDIT MODE — click floor / wall / stairs / slot / doorway to set; [Esc] to exit';
  container.appendChild(editHud);

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

  // a single generated castle (the report's Walk in VR): register its rooms and
  // spawn straight into the entry; otherwise start on Main Street as usual.
  const cas = threeOpts.castle
    ? registerOneCastle(threeOpts.castle, threeOpts.castleInstanceId, {})
    : null;
  if(cas) enterRoom(cas.entryKey, cas.spawn);
  else enterRoom(START_ROOM, START_SPAWN);
  tick();

  // test-only hook (off unless the debug flag is set) so the layout editor can
  // be driven deterministically without scripting the walk into a room
  if(localStorage.getItem('threeTestDebug')){
    window.__threeTestEdit = {
      enter: (k) => enterRoom(k, { x:0, z:0, yaw:0 }),
      toggle: () => setEditMode(!editMode),
      target: (ud) => handleEditTarget(ud),
      room: () => currentRoomKey,
      scan: () => { const out=[]; scene.traverse(o=>{ if(o.userData&&o.userData.kind) out.push({ kind:o.userData.kind, slotId:o.userData.slotId, wall:o.userData.wall, roomKey:o.userData.roomKey, buildingKey:o.userData.buildingKey, w:o.userData.w, h:o.userData.h }); }); return out; },
      meshes: () => { const out=[]; scene.traverse(o=>{ if(o.isMesh&&o.geometry&&o.geometry.parameters){ const wp=new THREE.Vector3(); o.getWorldPosition(wp); out.push({ type:o.geometry.type, params:o.geometry.parameters, x:wp.x, y:wp.y, z:wp.z, ry:o.rotation.y, kind:o.userData&&o.userData.kind, slotId:o.userData&&o.userData.slotId }); } }); return out; },
      entry: () => entryPoint,
      teleport: (x, z, yawVal) => { pos.x = x; pos.z = z; if(yawVal != null) yaw = yawVal; },
      pos: () => ({ x: pos.x, z: pos.z, yaw })
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
  billboards = [];
  selectedProp = null;
  selectionOutline = null;
  selectionGear = null;
  selectionAnchor = null;
  editHud = null;
  joystickEl = null; joyKnob = null; joyPointerId = null;
  joyVec = { x: 0, y: 0 };
  editTouchEl = null;
  toolbarEl = null; helpOverlay = null;
  hintsBtn = editBtn = roomGeomBtn = assetsBtn = closeBtn = infoBtn = null;
  threeOpts = {};
  closeRoomGeomDialog();
  scene = null; camera = null; clock = null; container = null;
}
