/* ---------- Three.js integration prototype ----------
   Minimal "feel test" for walking between rooms in a 3D castle: a box
   room with two doorways, each leading to its own plain box room. No
   decorations/furniture/textures — just walls, floor, ceiling, and the
   doorway-crossing transition mechanism this is meant to prove out.
*/
let THREE = null;

const ROOMS = {
  start: {
    color: 0x6f8fb0,
    size: { w: 10, d: 10, h: 4 },
    label: { wall: 'south', text: '1' },
    exits: [
      { wall: 'north', offset: 0, target: 'roomB' },
      { wall: 'east',  offset: 0, target: 'roomC' }
    ]
  },
  roomB: {
    color: 0xb07070,
    size: { w: 10, d: 10, h: 4 },
    label: { wall: 'north', text: '2' },
    exits: [
      { wall: 'south', offset: 0, target: 'start' }
    ]
  },
  roomC: {
    color: 0x70b078,
    size: { w: 10, d: 10, h: 4 },
    label: { wall: 'east', text: '3' },
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
let exitMeta = [];       // [{box:{minX,maxX,minZ,maxZ}, target}]
let currentExitsByWall = {};
let teleportLockUntil = 0;
const PLAYER_RADIUS = 0.4;

function clampToRoom(room, x, z){
  const { w, d } = room.size;
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

function wallSpan(room, wall){
  // returns the wall's run axis ('x' or 'z'), fixed coordinate, and half-length
  const {w,d} = room.size;
  switch(wall){
    case 'north': return { axis:'x', fixed:-d/2, half:w/2 };
    case 'south': return { axis:'x', fixed: d/2, half:w/2 };
    case 'west':  return { axis:'z', fixed:-w/2, half:d/2 };
    case 'east':  return { axis:'z', fixed: w/2, half:d/2 };
  }
}

function buildWallGroup(room, wall, hasDoor, doorOffset, color){
  const group = new THREE.Group();
  const { axis, fixed, half } = wallSpan(room, wall);
  const h = room.size.h;
  const mat = new THREE.MeshStandardMaterial({ color });

  function segment(start, end){
    const len = end - start;
    if(len <= 0.01) return;
    const mid = start + len/2;
    let geo, x, z;
    if(axis === 'x'){
      geo = new THREE.BoxGeometry(len, h, WALL_THICK);
      x = mid; z = fixed;
    } else {
      geo = new THREE.BoxGeometry(WALL_THICK, h, len);
      x = fixed; z = mid;
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
      x = doorOffset; z = fixed;
    } else {
      geo = new THREE.BoxGeometry(WALL_THICK, lintelH, DOOR_W);
      x = fixed; z = doorOffset;
    }
    const lintel = new THREE.Mesh(geo, mat);
    lintel.position.set(x, DOOR_H + lintelH/2, z);
    group.add(lintel);
  }
  return group;
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

function placeLabelOnWall(room, wall, text){
  const { fixed } = wallSpan(room, wall);
  const mesh = makeLabelMesh(text);
  const clearance = WALL_THICK/2 + 0.02;
  const y = room.size.h/2;
  if(wall === 'north'){ mesh.position.set(0, y, fixed + clearance); mesh.rotation.y = 0; }
  if(wall === 'south'){ mesh.position.set(0, y, fixed - clearance); mesh.rotation.y = Math.PI; }
  if(wall === 'west'){  mesh.position.set(fixed + clearance, y, 0); mesh.rotation.y = Math.PI/2; }
  if(wall === 'east'){  mesh.position.set(fixed - clearance, y, 0); mesh.rotation.y = -Math.PI/2; }
  return mesh;
}

function doorTriggerBox(room, wall, offset){
  const { axis, fixed, half } = wallSpan(room, wall);
  const dHalf = DOOR_W/2;
  const pad = 1.0; // how far into/past the doorway the trigger reaches
  if(axis === 'x'){
    return {
      minX: offset - dHalf, maxX: offset + dHalf,
      minZ: fixed - pad,    maxZ: fixed + pad
    };
  }
  return {
    minX: fixed - pad,    maxX: fixed + pad,
    minZ: offset - dHalf, maxZ: offset + dHalf
  };
}

function spawnPointFor(room, wall, offset){
  // step a couple meters in from the doorway, facing *into* the room (away
  // from the wall just entered through) — yaw values use this camera's
  // forward vector of (-sin(yaw), -cos(yaw)).
  const { fixed } = wallSpan(room, wall);
  const inset = 2.5;
  if(wall === 'north') return { x: offset, z: fixed + inset, yaw: Math.PI };
  if(wall === 'south') return { x: offset, z: fixed - inset, yaw: 0 };
  if(wall === 'west')  return { x: fixed + inset, z: offset, yaw: -Math.PI/2 };
  return { x: fixed - inset, z: offset, yaw: Math.PI/2 }; // east
}

function buildRoom(roomKey){
  const room = ROOMS[roomKey];
  scene.clear();

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(4, 8, 3);
  scene.add(sun);

  const { w, d, h } = room.size;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ color: 0x444444 })
  );
  floor.rotation.x = -Math.PI/2;
  scene.add(floor);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  ceiling.rotation.x = Math.PI/2;
  ceiling.position.y = h;
  scene.add(ceiling);

  currentExitsByWall = {};
  for(const ex of room.exits) currentExitsByWall[ex.wall] = ex;

  exitMeta = [];
  for(const wall of ['north','south','east','west']){
    const ex = currentExitsByWall[wall];
    const group = buildWallGroup(room, wall, !!ex, ex ? ex.offset : 0, room.color);
    scene.add(group);
    if(ex) exitMeta.push({ box: doorTriggerBox(room, wall, ex.offset), target: ex.target });
  }

  if(room.label) scene.add(placeLabelOnWall(room, room.label.wall, room.label.text));

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
    const clamped = clampToRoom(ROOMS[currentRoomKey], pos.x, pos.z);
    pos.x = clamped.x; pos.z = clamped.z;
  }

  camera.position.set(pos.x, EYE_HEIGHT, pos.z);
  camera.rotation.set(0, yaw, 0);

  if(clock.getElapsedTime() > teleportLockUntil){
    for(const m of exitMeta){
      if(pos.x >= m.box.minX && pos.x <= m.box.maxX && pos.z >= m.box.minZ && pos.z <= m.box.maxZ){
        const targetRoom = ROOMS[m.target];
        // spawn at the wall in the target room whose exit leads back to the
        // room we're leaving, facing into the new room
        const returning = targetRoom.exits.find(e => e.target === currentRoomKey) || targetRoom.exits[0];
        enterRoom(m.target, spawnPointFor(targetRoom, returning.wall, returning.offset));
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

  enterRoom('start', { x:0, z:2, yaw:0 });
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
