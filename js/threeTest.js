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
      { target: 'start', sign: 'Chigoren Mansion', frontTexture: 'assets/three/textures/chigorin_mansion_front.jpg',
        color: 0x6f8fb0, size: { w: 25, d: 10, h: 10 }, origin: { x: 20, z: -14 }, doorWall: 'south', doorOffset: 0 }
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
      { wall: 'north', offset: 0, target: 'roomB' },
      { wall: 'east',  offset: 0, target: 'roomC' },
      { wall: 'south', offset: 0, target: 'mainStreet', back: true }
    ]
  },
  roomB: {
    color: 0xb07070,
    size: { w: 10, d: 10, h: 4 },
    label: { wall: 'north', text: '2' },
    furniture: { type: 'chair', x: 3.2, z: -3.2, yaw: Math.PI },
    stairs: { fromZ: 2.0, toZ: -1.0, rise: 1.3 },
    slots: [
      { id: 'w-east', kind: 'wall', wall: 'east', offset: 0, y: 1.6 },
      { id: 'w-west', kind: 'wall', wall: 'west', offset: 0, y: 1.6 }
    ],
    exits: [
      { wall: 'south', offset: 0, target: 'start', back: true }
    ]
  },
  roomC: {
    color: 0x70b078,
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
const MOVE_SPEED = 4.2;   // m/s
const TURN_SPEED = 1.8;   // rad/s

// where you start, and where pressing R returns you
const START_ROOM = 'mainStreet';
const START_SPAWN = { x:0, z:18, yaw:0 };

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
let currentExitsByWall = {};
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
let LAYOUT = {};
let ASSET_BY_ID = {};
let raycaster = null;
let pointer = null;
let billboards = [];           // cylindrical billboards needing per-frame facing
let editHud = null;

function floorAssetFor(roomKey){
  const id = LAYOUT[roomKey] && LAYOUT[roomKey].floor;
  return id ? ASSET_BY_ID[id] : null;
}
function wallAssetFor(roomKey, wall){
  const id = LAYOUT[roomKey] && LAYOUT[roomKey].walls && LAYOUT[roomKey].walls[wall];
  return id ? ASSET_BY_ID[id] : null;
}
function slotAssetFor(roomKey, slotId){
  const id = LAYOUT[roomKey] && LAYOUT[roomKey].slots && LAYOUT[roomKey].slots[slotId];
  return id ? ASSET_BY_ID[id] : null;
}
function ceilingAssetFor(roomKey){
  const id = LAYOUT[roomKey] && LAYOUT[roomKey].ceiling;
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
function yardAssetFor(roomKey, buildingKey){
  const id = LAYOUT[roomKey] && LAYOUT[roomKey].yards && LAYOUT[roomKey].yards[buildingKey];
  return id ? ASSET_BY_ID[id] : null;
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
const YARD_SLOT_DEPTH = 3;
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
function roomSlots(room){
  return [
    ...floorGridSlots(room),
    ...doorFlankSlots(room),
    ...doorFlankFloorSlots(room),
    ...lowWallSlots(room),
    ...ceilingSlots(room),
    ...(room.slots || [])
  ];
}
function slotById(room, slotId){
  const found = roomSlots(room).find(s => s.id === slotId);
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
  if(!r.buildings) r.buildings = {};
  if(!r.signs) r.signs = {};
  if(!r.yards) r.yards = {};
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
function setSlotOverride(roomKey, slotId, assetId){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    if(assetId) r.slots[slotId] = assetId; else delete r.slots[slotId];
  });
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
function setYardOverride(roomKey, buildingKey, assetId){
  applyEdit(() => {
    const r = ensureRoomLayout(roomKey);
    if(assetId) r.yards[buildingKey] = assetId; else delete r.yards[buildingKey];
  });
}

function clampToRoom(size, x, z){
  const { w, d } = size;
  const halfW = w/2 - PLAYER_RADIUS, halfD = d/2 - PLAYER_RADIUS;
  const dHalf = DOOR_W/2;

  if(z < -halfD){
    const ex = currentExitsByWall['north'];
    if(!(ex && x > ex.offset-dHalf && x < ex.offset+dHalf)) z = -halfD;
  }
  if(z > halfD){
    const ex = currentExitsByWall['south'];
    if(!(ex && x > ex.offset-dHalf && x < ex.offset+dHalf)) z = halfD;
  }
  if(x < -halfW){
    const ex = currentExitsByWall['west'];
    if(!(ex && z > ex.offset-dHalf && z < ex.offset+dHalf)) x = -halfW;
  }
  if(x > halfW){
    const ex = currentExitsByWall['east'];
    if(!(ex && z > ex.offset-dHalf && z < ex.offset+dHalf)) x = halfW;
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

    const toUV = (X, Y) => new THREE.Vector2(X / w + 0.5, Y / h + 0.5);
    const uvGen = {
      generateTopUV(g, v, a, b, c){
        return [ toUV(v[a*3], v[a*3+1]), toUV(v[b*3], v[b*3+1]), toUV(v[c*3], v[c*3+1]) ];
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

// rotation.y that aims a prop's front (local -z) at world point `target` from
// (x,z). Derived so the wall cases above fall out exactly (e.g. a prop south of
// a target gets yaw 0). With no target, default to facing -z (north).
function yawFacing(x, z, target){
  if(!target) return 0;
  return Math.atan2(x - target.x, z - target.z);
}

// places a built prop into a slot (floor or wall), tags it for the editor,
// and registers cylindrical billboards for per-frame facing.
function placeSlotAccessory(room, slot, asset){
  const obj = buildPropAsset(asset);
  if(slot.kind === 'ceiling'){
    // hangs from the ceiling centre; a billboard turns to face the camera, so
    // only its height matters -- drop it so its top is flush with the ceiling.
    const h = (asset.size && asset.size.h) || 1;
    obj.position.set(slot.x, room.size.h - h/2 - 0.05, slot.z);
  } else if(slot.kind === 'wall'){
    const { axis, fixed } = wallSpan(room.size, slot.wall);
    const depth = (asset.type === 'extruded') ? (asset.size.d || 0.3) : 0.05;
    const clearance = WALL_THICK/2 + depth/2 + 0.02;
    let x, z;
    if(axis === 'x'){ x = slot.offset; z = slot.wall === 'north' ? fixed + clearance : fixed - clearance; }
    else { z = slot.offset; x = slot.wall === 'west' ? fixed + clearance : fixed - clearance; }
    // "ground" wall slots sit a floor-standing piece against the wall (bottom on
    // the floor); ordinary wall slots centre the piece at the slot's y.
    let y = slot.y;
    if(slot.ground){ const h = (asset.size && asset.size.h) || 1; y = floorHeightAt(room, z) + h/2; }
    obj.position.set(x, y, z);
    if(!(asset.type === 'billboard-cylindrical' || asset.type === 'billboard-sprite')){
      obj.rotation.y = WALL_INWARD_YAW[slot.wall] || 0;
    }
  } else {
    // extruded / plane / sprite are all centred on their geometry, so sitting
    // one on the floor means raising it by half its height
    const floorY = floorHeightAt(room, slot.z);
    const h = (asset.size && asset.size.h) || 1;
    obj.position.set(slot.x, floorY + h/2, slot.z);
    // Extruded props turn to face the door you walked in through (its image
    // side is local -z). An explicit slot.yaw still wins if one is authored;
    // otherwise aim the front at the entry point. Billboards always face the
    // camera, so they're left alone.
    if(asset.type === 'extruded'){
      obj.rotation.y = slot.yaw != null ? slot.yaw : yawFacing(slot.x, slot.z, entryPoint);
    }
  }
  obj.userData = { kind: 'accessory', slotId: slot.id };
  if(asset.type === 'billboard-cylindrical') billboards.push(obj);
  return obj;
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
function buildSignMarker(signPos, roomKey, buildingKey){
  const postH = 1.1;
  const marker = new THREE.Mesh(new THREE.PlaneGeometry(3.4 * 1.1, 0.85 * 1.4), signMarkerMaterial());
  marker.position.set(signPos.x, postH + 0.85/2, signPos.z);
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
const YARD_PATCH_MARGIN = 1.0;     // extra lawn past the outermost slots, each side
const YARD_PATCH_OUTSET = 1.8;     // extra depth past the slots, away from the wall
function buildYardPatch(b, roomKey, buildingKey){
  const asset = yardAssetFor(roomKey, buildingKey);
  if(!asset && !editMode) return null;     // nothing to draw -> base lawn shows through

  const { axis, fixed, half } = wallSpan(b.size, b.doorWall);
  const outSign = (b.doorWall === 'south' || b.doorWall === 'east') ? 1 : -1;
  const halfAlong = Math.max(half, YARD_SLOT_START + (YARD_SLOT_COUNT - 1) * YARD_SLOT_SPACING + YARD_PATCH_MARGIN);
  const depth = YARD_SLOT_DEPTH + YARD_PATCH_OUTSET;
  const alongSize = 2 * halfAlong;
  const extentX = axis === 'x' ? alongSize : depth;
  const extentZ = axis === 'x' ? depth : alongSize;

  let mat;
  if(asset){
    const rpm = asset.repeatPerMeter || 0.5;
    mat = assetSurfaceMaterial(asset, extentX * rpm, extentZ * rpm);
  } else {
    mat = yardMarkerMaterial();
  }
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(extentX, extentZ), mat);
  patch.rotation.x = -Math.PI/2;
  const cx = (axis === 'x' ? b.doorOffset : fixed + outSign * depth/2) + b.origin.x;
  const cz = (axis === 'x' ? fixed + outSign * depth/2 : b.doorOffset) + b.origin.z;
  patch.position.set(cx, 0.012, cz);       // above base lawn (0), below slot markers (0.02)
  patch.userData = { kind: 'yard', roomKey, buildingKey };
  return patch;
}

// renders a list of slots: placed accessory if one is assigned, else a
// marker (only in edit mode, so normal walking is unchanged).
function buildSlots(room, roomKey, slots){
  for(const slot of slots){
    const asset = slotAssetFor(roomKey, slot.id);
    if(asset){
      scene.add(placeSlotAccessory(room, slot, asset));
    } else if(editMode){
      scene.add(buildSlotMarker(room, slot));
    }
  }
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
  let mat;
  if(opts.surfaceAsset){
    // surface override from the layout editor: repeat density driven by the
    // asset's repeatPerMeter across this wall's real dimensions
    const rpm = opts.surfaceAsset.repeatPerMeter || 0.5;
    mat = assetSurfaceMaterial(opts.surfaceAsset, half*2 * rpm, h * rpm);
  } else {
    const tex = wallTexture.clone();
    tex.needsUpdate = true;
    tex.repeat.set(Math.max(1, Math.round(half*2/2.5)), Math.max(1, Math.round(h/2)));
    mat = new THREE.MeshStandardMaterial({ map: tex });
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
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, h/2, z);
    if(opts.editable) mesh.userData = { kind: 'wall', wall };
    group.add(mesh);
  }

  if(!hasDoor){
    segment(-half, half);
  } else {
    const dHalf = DOOR_W/2;
    segment(-half, doorOffset - dHalf);
    segment(doorOffset + dHalf, half);
    // lintel above the doorway
    let geo, x, z;
    const lintelH = h - DOOR_H;
    if(axis === 'x'){
      geo = new THREE.BoxGeometry(DOOR_W, lintelH, WALL_THICK);
      x = doorOffset + origin.x; z = fixed + origin.z;
    } else {
      geo = new THREE.BoxGeometry(WALL_THICK, lintelH, DOOR_W);
      x = fixed + origin.x; z = doorOffset + origin.z;
    }
    const lintel = new THREE.Mesh(geo, mat);
    lintel.position.set(x, DOOR_H + lintelH/2, z);
    if(opts.editable) lintel.userData = { kind: 'wall', wall };
    group.add(lintel);
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

function drawSignBase(ctx, w, h){
  ctx.fillStyle = '#caa46a';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#4a3320';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, w - 10, h - 10);
}
function drawSignText(ctx, w, h, text){
  ctx.fillStyle = '#2b1d10';
  ctx.font = 'bold 54px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w/2, h/2 + 4);
}
// Builds the sign panel mesh. Draws the flat tan background + text
// immediately (so the panel is never blank), then if a skin image is
// supplied, loads it asynchronously and redraws the skin as the
// background with the name text layered on top once it's ready.
function makeSignMesh(text, skinSrc){
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  drawSignBase(ctx, canvas.width, canvas.height);
  drawSignText(ctx, canvas.width, canvas.height, text);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  if(skinSrc){
    const myGeneration = buildGeneration;
    const img = new Image();
    img.onload = () => {
      if(buildGeneration !== myGeneration || !scene) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      drawSignText(ctx, canvas.width, canvas.height, text);
      tex.needsUpdate = true;
    };
    img.src = skinSrc;
  }
  return new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.85), mat);
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

// Builds a raised platform (reached by a staircase) within a room's
// existing walls/ceiling -- the platform spans from `toZ` back to the
// room's far wall, and the steps climb the gap between `fromZ` and `toZ`.
function buildStairs(room){
  const { fromZ, toZ, rise } = room.stairs;
  const { w, d } = room.size;

  const group = new THREE.Group();

  const platformDepth = toZ - (-d/2);
  const platformZ = (toZ + (-d/2)) / 2;
  const platform = new THREE.Mesh(
    new THREE.BoxGeometry(w, rise, platformDepth),
    new THREE.MeshStandardMaterial({ color: 0x7a7a7a })
  );
  platform.position.set(0, rise/2, platformZ);
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
  const stepMat = new THREE.MeshStandardMaterial({ color: 0x8a8a8a });
  for(let i=0; i<steps; i++){
    const stepH = stepRise * (i+1);
    const zCenter = fromZ - stepRun*i - stepRun/2;
    const step = new THREE.Mesh(new THREE.BoxGeometry(w, stepH, stepRun), stepMat);
    step.position.set(0, stepH/2, zCenter);
    group.add(step);
  }

  return group;
}

// A freestanding ground-level sign on two posts, like a museum or
// apartment-complex sign out on the lawn -- not mounted on the building
// wall. Faces +z (south, toward the street) by default, same orientation
// convention as mountOutward's south case.
function buildGroundSign(text, skinSrc){
  const group = new THREE.Group();
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

function doorSpawn(size, wall, offset, origin, inside){
  // "inside" spawns a couple meters in from the doorway, facing further
  // into the room; the mirrored "outside" spawn faces away from the
  // doorway instead — both use this camera's forward vector convention
  // of (-sin(yaw), -cos(yaw)).
  origin = origin || { x:0, z:0 };
  const { fixed } = wallSpan(size, wall);
  const inset = 2.5;
  let x, z, yaw;
  if(wall === 'north'){ x = offset; z = inside ? fixed+inset : fixed-inset; yaw = inside ? Math.PI : 0; }
  if(wall === 'south'){ x = offset; z = inside ? fixed-inset : fixed+inset; yaw = inside ? 0 : Math.PI; }
  if(wall === 'west'){  z = offset; x = inside ? fixed+inset : fixed-inset; yaw = inside ? -Math.PI/2 : Math.PI/2; }
  if(wall === 'east'){  z = offset; x = inside ? fixed-inset : fixed+inset; yaw = inside ? Math.PI/2 : -Math.PI/2; }
  return { x: x + origin.x, z: z + origin.z, yaw };
}

function computeSpawnForExit(fromKey, room, ex){
  const targetRoom = ROOMS[ex.target];
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

function buildRoom(roomKey){
  const room = ROOMS[roomKey];
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

  currentExitsByWall = {};
  for(const ex of room.exits) currentExitsByWall[ex.wall] = ex;

  exitMeta = [];

  if(!room.outdoor){
    const wallTex = makeBrickTexture(room.color);
    for(const wall of ['north','south','east','west']){
      const ex = currentExitsByWall[wall];
      const group = buildWallGroup(room.size, wall, !!ex, ex ? ex.offset : 0, wallTex, null,
        { editable: true, surfaceAsset: wallAssetFor(roomKey, wall) });
      scene.add(group);
      if(ex){
        const spawn = computeSpawnForExit(roomKey, room, ex);
        exitMeta.push({ box: doorTriggerBox(room.size, wall, ex.offset), target: ex.target, spawn });
        if(ex.back) scene.add(buildExitSign(room.size, wall, ex.offset));
      }
    }
    if(room.stairs) scene.add(buildStairs(room));
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
    buildSlots(room, roomKey, roomSlots(room));
  } else {
    // No surrounding wall: the outdoor area is open so multiple buildings can
    // sit on the street without a brick box hemming them in. Movement is still
    // bounded by clampToRoom (an invisible limit at the room's edges).
    for(const s of room.streetSigns || []){
      const signGroup = buildGroundSign(s.text);
      signGroup.position.set(s.x, 0, s.z);
      scene.add(signGroup);
    }
    // every building on this street gets its own exterior, door and sign
    for(const b of room.buildings){
      const targetRoom = ROOMS[b.target];
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
        const signPos = { x: b.origin.x + 6, z: b.origin.z + size.d/2 + 2.5 };
        const signGroup = buildGroundSign(b.sign, signAsset ? signAsset.image : null);
        signGroup.position.set(signPos.x, 0, signPos.z);
        scene.add(signGroup);
        // edit-mode hotspot: click the sign to set / replace / remove its skin
        if(editMode) scene.add(buildSignMarker(signPos, roomKey, buildingKey));
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
      exitMeta.push({
        box: doorTriggerBox(size, b.doorWall, b.doorOffset, b.origin),
        target: b.target,
        spawn
      });
    }
  }

  currentRoomKey = roomKey;
}

function enterRoom(roomKey, spawn){
  // remember where we came in *before* building, so floor props can face it
  entryPoint = { x: spawn.x, z: spawn.z };
  buildRoom(roomKey);
  pos.x = spawn.x; pos.z = spawn.z; yaw = spawn.yaw;
  teleportLockUntil = clock.getElapsedTime() + 0.6;
}

function tick(){
  animHandle = requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);

  if(keys['ArrowLeft']  || keys['a'] || keys['A']) yaw += TURN_SPEED*dt;
  if(keys['ArrowRight'] || keys['d'] || keys['D']) yaw -= TURN_SPEED*dt;

  let move = 0;
  if(keys['ArrowUp']   || keys['w'] || keys['W']) move += 1;
  if(keys['ArrowDown'] || keys['s'] || keys['S']) move -= 1;
  if(move !== 0 && !inputLocked){
    // camera forward vector for rotation.y = yaw is (-sin(yaw), -cos(yaw))
    pos.x += -Math.sin(yaw) * move * MOVE_SPEED * dt;
    pos.z += -Math.cos(yaw) * move * MOVE_SPEED * dt;
    const clamped = clampToRoom(ROOMS[currentRoomKey].size, pos.x, pos.z);
    pos.x = clamped.x; pos.z = clamped.z;
  }

  const eyeY = EYE_HEIGHT + floorHeightAt(ROOMS[currentRoomKey], pos.z);
  camera.position.set(pos.x, eyeY, pos.z);
  camera.rotation.set(0, yaw, 0);
  window.__threeTestState = { room: currentRoomKey, x: pos.x, z: pos.z, y: eyeY, yaw, editMode };

  // cylindrical billboards: rotate to face the camera horizontally each frame
  for(const b of billboards){
    b.rotation.y = Math.atan2(camera.position.x - b.position.x, camera.position.z - b.position.z);
  }

  // door teleports are suppressed in edit mode so you can stand in a doorway
  // and edit the wall beside it without being yanked into the next room
  if(!editMode && clock.getElapsedTime() > teleportLockUntil){
    for(const m of exitMeta){
      if(pos.x >= m.box.minX && pos.x <= m.box.maxX && pos.z >= m.box.minZ && pos.z <= m.box.maxZ){
        enterRoom(m.target, m.spawn);
        break;
      }
    }
  }

  renderer.render(scene, camera);
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
  for(const hit of hits){
    const ud = findInteractive(hit.object);
    if(ud){ handleEditTarget(ud); return; }
  }
}

function handleEditTarget(ud){
  const roomKey = currentRoomKey;
  inputLocked = true;
  const onClose = () => { inputLocked = false; };
  if(ud.kind === 'floor'){
    openAssetPicker({
      allow: ['surface'], allowRemove: !!floorAssetFor(roomKey), onClose,
      onPick: id => setFloorOverride(roomKey, id),
      onRemove: () => setFloorOverride(roomKey, null)
    });
  } else if(ud.kind === 'wall'){
    openAssetPicker({
      allow: ['surface'], allowRemove: !!wallAssetFor(roomKey, ud.wall), onClose,
      onPick: id => setWallOverride(roomKey, ud.wall, id),
      onRemove: () => setWallOverride(roomKey, ud.wall, null)
    });
  } else if(ud.kind === 'ceiling-surface'){
    openAssetPicker({
      allow: ['surface'], allowRemove: !!ceilingAssetFor(roomKey), onClose,
      onPick: id => setCeilingOverride(roomKey, id),
      onRemove: () => setCeilingOverride(roomKey, null)
    });
  } else if(ud.kind === 'slot'){
    openAssetPicker({
      allow: ud.allow, onClose,
      onPick: id => setSlotOverride(roomKey, ud.slotId, id)
    });
  } else if(ud.kind === 'accessory'){
    const slot = slotById(ROOMS[roomKey], ud.slotId);
    openAssetPicker({
      allow: (slot && slot.allow) || PROP_TYPES, allowRemove: true, onClose,
      onPick: id => setSlotOverride(roomKey, ud.slotId, id),
      onRemove: () => setSlotOverride(roomKey, ud.slotId, null)
    });
  } else if(ud.kind === 'facade'){
    const current = buildingFacadeFor(ud.roomKey, ud.buildingKey);
    openAssetPicker({
      allow: ['facade'], allowRemove: !!current, onClose,
      onPick: id => setBuildingFacadeOverride(ud.roomKey, ud.buildingKey, id),
      onRemove: () => setBuildingFacadeOverride(ud.roomKey, ud.buildingKey, null)
    });
  } else if(ud.kind === 'sign'){
    const current = signAssetFor(ud.roomKey, ud.buildingKey);
    openAssetPicker({
      allow: ['sign'], allowRemove: !!current, onClose,
      onPick: id => setSignOverride(ud.roomKey, ud.buildingKey, id),
      onRemove: () => setSignOverride(ud.roomKey, ud.buildingKey, null)
    });
  } else if(ud.kind === 'yard'){
    const current = yardAssetFor(ud.roomKey, ud.buildingKey);
    openAssetPicker({
      allow: ['surface'], allowRemove: !!current, onClose,
      onPick: id => setYardOverride(ud.roomKey, ud.buildingKey, id),
      onRemove: () => setYardOverride(ud.roomKey, ud.buildingKey, null)
    });
  }
}

function setEditMode(on){
  editMode = on;
  if(renderer) renderer.domElement.style.cursor = on ? 'crosshair' : 'default';
  if(editHud){
    // outdoors you edit building facades; indoors floors/walls/slots
    const outdoor = ROOMS[currentRoomKey] && ROOMS[currentRoomKey].outdoor;
    editHud.textContent = outdoor
      ? 'EDIT MODE — click a building’s facade, its lawn, a yard spot, or its sign to edit; [E] or [Esc] to exit'
      : 'EDIT MODE — click floor / wall / slot to set; [E] or [Esc] to exit';
    editHud.style.display = on ? 'block' : 'none';
  }
  buildRoom(currentRoomKey);
}

function onResize(){
  if(!container || !renderer || !camera) return;
  const w = container.clientWidth, h = container.clientHeight;
  if(w===0 || h===0) return;
  renderer.setSize(w, h);
  camera.aspect = w/h;
  camera.updateProjectionMatrix();
}

function onKeyDown(e){
  if(e.key === 'e' || e.key === 'E'){ setEditMode(!editMode); return; }
  if(e.key === 'Escape' && editMode){ setEditMode(false); return; }
  if(e.key === 'r' || e.key === 'R'){ enterRoom(START_ROOM, START_SPAWN); return; }
  keys[e.key] = true;
}
function onKeyUp(e){ keys[e.key] = false; }

export async function openThreeTest(containerEl){
  container = containerEl;
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
  editHud.style.cssText = 'position:absolute;top:8px;left:8px;padding:.35rem .6rem;'
    + 'background:rgba(21,101,192,.85);color:#fff;font:600 .8rem sans-serif;'
    + 'border-radius:4px;pointer-events:none;display:none;z-index:2';
  editHud.textContent = 'EDIT MODE — click floor / wall / slot to set; [E] or [Esc] to exit';
  container.appendChild(editHud);

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

  enterRoom(START_ROOM, START_SPAWN);
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
  editMode = false;
  inputLocked = false;
  billboards = [];
  editHud = null;
  scene = null; camera = null; clock = null; container = null;
}
