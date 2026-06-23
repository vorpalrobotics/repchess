/* ---------- Three.js integration prototype ----------
   "Feel test" for a loci-style memory layout: an outdoor street/courtyard
   containing one building you can walk up to and enter. The building's
   interior is the same two-doorway, three-room layout from the earlier
   iteration of this prototype, now reached by walking through its front
   door instead of just spawning inside it.
*/
let THREE = null;

const ROOMS = {
  street: {
    outdoor: true,
    size: { w: 30, d: 18, h: 7 },
    exits: [],
    buildings: [
      { target: 'start', sign: 'Chigoren Mansion', frontTexture: 'assets/three/textures/chigorin_mansion_front.jpg',
        color: 0x6f8fb0, size: { w: 10, d: 10, h: 4 }, origin: { x: 0, z: -4 }, doorWall: 'south', doorOffset: 0 }
    ]
  },
  start: {
    color: 0x6f8fb0,
    size: { w: 10, d: 10, h: 4 },
    label: { wall: 'west', text: '1' },
    furniture: { type: 'table', x: -3.2, z: 3.2, yaw: 0 },
    exits: [
      { wall: 'north', offset: 0, target: 'roomB' },
      { wall: 'east',  offset: 0, target: 'roomC' },
      { wall: 'south', offset: 0, target: 'street' }
    ]
  },
  roomB: {
    color: 0xb07070,
    size: { w: 10, d: 10, h: 4 },
    label: { wall: 'north', text: '2' },
    furniture: { type: 'chair', x: 3.2, z: -3.2, yaw: Math.PI },
    exits: [
      { wall: 'south', offset: 0, target: 'start' }
    ]
  },
  roomC: {
    color: 0x70b078,
    size: { w: 10, d: 10, h: 4 },
    label: { wall: 'east', text: '3' },
    furniture: { type: 'chest', x: 3.2, z: 3.2, yaw: Math.PI/4 },
    exits: [
      { wall: 'west', offset: 0, target: 'start' }
    ]
  }
};

const DOOR_W = 2.2;
const DOOR_H = 2.6;
const WALL_THICK = 0.25;
const EYE_HEIGHT = 1.6;
const MOVE_SPEED = 4.2;   // m/s
const TURN_SPEED = 1.8;   // rad/s

let renderer=null, scene=null, camera=null, clock=null;
let container=null, animHandle=null, resizeObs=null;
let keys = {};
let yaw = 0;
let pos = { x:0, z:0 };
let currentRoomKey = 'start';
let exitMeta = [];       // [{box:{minX,maxX,minZ,maxZ}, target, spawn:{x,z,yaw}}]
let currentExitsByWall = {};
let teleportLockUntil = 0;
const PLAYER_RADIUS = 0.4;
let textureLoader = null;
let buildGeneration = 0;

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

function makeGroundTexture(){
  return makeCanvasTexture((ctx, size) => {
    ctx.fillStyle = '#7d8a78';
    ctx.fillRect(0, 0, size, size);
    const cols = 5, tile = size/cols;
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 3;
    for(let i=0; i<=cols; i++){
      ctx.beginPath(); ctx.moveTo(i*tile, 0); ctx.lineTo(i*tile, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i*tile); ctx.lineTo(size, i*tile); ctx.stroke();
    }
  }, 256);
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
  mesh.position.set(room.furniture.x, 0, room.furniture.z);
  mesh.rotation.y = room.furniture.yaw || 0;
  return mesh;
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

function buildWallGroup(size, wall, hasDoor, doorOffset, wallTexture, origin){
  origin = origin || { x:0, z:0 };
  const group = new THREE.Group();
  const { axis, fixed, half } = wallSpan(size, wall);
  const h = size.h;
  const tex = wallTexture.clone();
  tex.needsUpdate = true;
  tex.repeat.set(Math.max(1, Math.round(half*2/2.5)), Math.max(1, Math.round(h/2)));
  const mat = new THREE.MeshStandardMaterial({ map: tex });

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
    group.add(lintel);
  }
  return group;
}

function buildRoof(size, origin, color){
  const mat = new THREE.MeshStandardMaterial({ color });
  const roof = new THREE.Mesh(new THREE.BoxGeometry(size.w + 0.6, 0.3, size.d + 0.6), mat);
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

function placeLabelOnWall(size, wall, text, origin){
  origin = origin || { x:0, z:0 };
  const { fixed } = wallSpan(size, wall);
  const mesh = makeLabelMesh(text);
  const clearance = WALL_THICK/2 + 0.02;
  const y = size.h/2;
  if(wall === 'north'){ mesh.position.set(origin.x, y, fixed + clearance + origin.z); mesh.rotation.y = 0; }
  if(wall === 'south'){ mesh.position.set(origin.x, y, fixed - clearance + origin.z); mesh.rotation.y = Math.PI; }
  if(wall === 'west'){  mesh.position.set(fixed + clearance + origin.x, y, origin.z); mesh.rotation.y = Math.PI/2; }
  if(wall === 'east'){  mesh.position.set(fixed - clearance + origin.x, y, origin.z); mesh.rotation.y = -Math.PI/2; }
  return mesh;
}

function makeSignMesh(text){
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#caa46a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#4a3320';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
  ctx.fillStyle = '#2b1d10';
  ctx.font = 'bold 54px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width/2, canvas.height/2 + 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex });
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

  scene.add(new THREE.AmbientLight(0xffffff, room.outdoor ? 0.75 : 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, room.outdoor ? 0.9 : 0.7);
  sun.position.set(4, 8, 3);
  scene.add(sun);

  scene.background = new THREE.Color(room.outdoor ? 0x8fb8d8 : 0x111317);

  const { w, d, h } = room.size;
  const groundTex = room.outdoor ? makeGroundTexture() : makeFloorTexture();
  groundTex.repeat.set(w/2, d/2);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ map: groundTex })
  );
  floor.rotation.x = -Math.PI/2;
  scene.add(floor);

  if(!room.outdoor){
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ color: 0x888888 })
    );
    ceiling.rotation.x = Math.PI/2;
    ceiling.position.y = h;
    scene.add(ceiling);
  }

  currentExitsByWall = {};
  for(const ex of room.exits) currentExitsByWall[ex.wall] = ex;

  exitMeta = [];

  if(!room.outdoor){
    const wallTex = makeBrickTexture(room.color);
    for(const wall of ['north','south','east','west']){
      const ex = currentExitsByWall[wall];
      const group = buildWallGroup(room.size, wall, !!ex, ex ? ex.offset : 0, wallTex);
      scene.add(group);
      if(ex){
        const spawn = computeSpawnForExit(roomKey, room, ex);
        exitMeta.push({ box: doorTriggerBox(room.size, wall, ex.offset), target: ex.target, spawn });
      }
    }
    if(room.label) scene.add(placeLabelOnWall(room.size, room.label.wall, room.label.text));
    const furniture = placeFurniture(room);
    if(furniture) scene.add(furniture);
  } else {
    // surrounding courtyard wall (no doors of its own — exploring further
    // up/down the street is a later step, this just bounds the area)
    const courtyardTex = makeBrickTexture(0x9aa0a6);
    for(const wall of ['north','south','east','west']){
      scene.add(buildWallGroup(room.size, wall, false, 0, courtyardTex));
    }
    // every building on this street gets its own exterior, door and sign
    for(const b of room.buildings){
      const targetRoom = ROOMS[b.target];
      const buildingTex = makeBrickTexture(b.color);
      for(const wall of ['north','south','east','west']){
        const hasDoor = wall === b.doorWall;
        scene.add(buildWallGroup(b.size, wall, hasDoor, hasDoor ? b.doorOffset : 0, buildingTex, b.origin));
      }
      scene.add(buildRoof(b.size, b.origin, 0x3a3a3a));
      if(b.sign){
        const signMesh = makeSignMesh(b.sign);
        const signY = b.size.h - 0.6;
        scene.add(mountOutward(b.size, b.doorWall, b.doorOffset, b.origin, signMesh, signY, WALL_THICK/2 + 0.09));
      }
      if(b.frontTexture && textureLoader){
        // Movie-set facade: once the image loads, lay it flat over the whole
        // face (a single un-tiled plane, no door-shaped cutout) so the front
        // reads as one painted board -- the actual walk-through trigger
        // below is independent of this geometry either way. Until/unless the
        // file exists, the procedural brick-with-doorway wall built above is
        // what's visible -- no broken texture, just the existing fallback.
        const { axis, fixed } = wallSpan(b.size, b.doorWall);
        const facadeWidth = axis === 'x' ? b.size.w : b.size.d;
        const doorWall = b.doorWall, origin = b.origin, h = b.size.h;
        textureLoader.load(b.frontTexture, (tex) => {
          if(buildGeneration !== myGeneration || !scene) return;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          const mat = new THREE.MeshStandardMaterial({ map: tex });
          const facade = new THREE.Mesh(new THREE.PlaneGeometry(facadeWidth, h), mat);
          mountOutward(b.size, doorWall, 0, origin, facade, h/2, WALL_THICK/2 + 0.05);
          scene.add(facade);
        }, undefined, () => { /* file not supplied yet -- keep the procedural brick fallback */ });
      }

      const spawn = doorSpawn(targetRoom.size, b.doorWall, b.doorOffset, null, true);
      exitMeta.push({
        box: doorTriggerBox(b.size, b.doorWall, b.doorOffset, b.origin),
        target: b.target,
        spawn
      });
    }
  }

  currentRoomKey = roomKey;
}

function enterRoom(roomKey, spawn){
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
  if(move !== 0){
    // camera forward vector for rotation.y = yaw is (-sin(yaw), -cos(yaw))
    pos.x += -Math.sin(yaw) * move * MOVE_SPEED * dt;
    pos.z += -Math.cos(yaw) * move * MOVE_SPEED * dt;
    const clamped = clampToRoom(ROOMS[currentRoomKey].size, pos.x, pos.z);
    pos.x = clamped.x; pos.z = clamped.z;
  }

  camera.position.set(pos.x, EYE_HEIGHT, pos.z);
  camera.rotation.set(0, yaw, 0);
  window.__threeTestState = { room: currentRoomKey, x: pos.x, z: pos.z, yaw };

  if(clock.getElapsedTime() > teleportLockUntil){
    for(const m of exitMeta){
      if(pos.x >= m.box.minX && pos.x <= m.box.maxX && pos.z >= m.box.minZ && pos.z <= m.box.maxZ){
        enterRoom(m.target, m.spawn);
        break;
      }
    }
  }

  renderer.render(scene, camera);
}

function onResize(){
  if(!container || !renderer || !camera) return;
  const w = container.clientWidth, h = container.clientHeight;
  if(w===0 || h===0) return;
  renderer.setSize(w, h);
  camera.aspect = w/h;
  camera.updateProjectionMatrix();
}

function onKeyDown(e){ keys[e.key] = true; }
function onKeyUp(e){ keys[e.key] = false; }

export async function openThreeTest(containerEl){
  container = containerEl;
  if(!THREE) THREE = await import('https://esm.sh/three@0.160.0');
  if(!textureLoader) textureLoader = new THREE.TextureLoader();

  container.innerHTML = '';
  renderer = new THREE.WebGLRenderer({ antialias:true });
  container.appendChild(renderer.domElement);

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

  enterRoom('street', { x:0, z:8, yaw:0 });
  tick();
}

export function closeThreeTest(){
  if(animHandle) cancelAnimationFrame(animHandle);
  animHandle = null;
  if(resizeObs) resizeObs.disconnect();
  resizeObs = null;
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  if(renderer){
    renderer.dispose();
    renderer = null;
  }
  if(container){ container.innerHTML = ''; }
  scene = null; camera = null; clock = null; container = null;
}
