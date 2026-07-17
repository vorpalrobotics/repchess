// Headless tests for the VR world, run against the offline harness.
//   cd test && npm install && npm test
import { launchApp, seedBackup, openVR } from './harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// a tiny (1x1, red, opaque) real PNG file on disk -- for tests that drive a
// real <input type=file> upload (setInputFiles needs an actual file, unlike
// the crop editor's tests which can hand a data-URL straight to a JS hook).
const FIXTURE_PNG_PATH = path.join(os.tmpdir(), 'repchess-test-fixture.png');
fs.writeFileSync(FIXTURE_PNG_PATH, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==',
  'base64'));

let passed = 0, failed = 0;
const ok  = (name) => { passed++; console.log(`  ✓ ${name}`); };
const bad = (name, e) => { failed++; console.log(`  ✗ ${name}\n      ${e}`); };
function assert(cond, msg){ if(!cond) throw new Error(msg); }

// console errors we expect and ignore. The un-mocked CDNs (cm-chessboard, web
// fonts, Chart.js, Stockfish) are intentionally aborted and the app degrades
// gracefully; blocking the COOP/COEP service worker makes its index.html
// registration shim throw a harmless "scope" error. None of these indicate a
// missing core dependency (which is what this assertion guards against).
const BENIGN = /Failed to load resource|net::ERR_|cm-chessboard|chessboard|favicon|stockfish|engine|reading 'scope'|serviceworker|COOP|COEP/i;
const realErrors = errs => errs.filter(e => !BENIGN.test(e));

const app = await launchApp();
try {
  // 1. The app boots — proving cytoscape/cytoscape-dagre/chess.js resolved
  //    from the vendored builds (otherwise app.js never evaluates).
  try {
    const stamp = await app.page.textContent('#buildStamp');
    assert(stamp && /-\d+/.test(stamp), `buildStamp missing/blank: "${stamp}"`);
    assert(realErrors(app.consoleErrors).length === 0,
      'unexpected console errors:\n' + realErrors(app.consoleErrors).join('\n'));
    ok(`app boots offline (buildStamp ${stamp.trim()})`);
  } catch(e){ bad('app boots offline', e); }

  // 2. Seed a white system opening 1.d4, then open the VR "Build world" flow —
  //    proving three.js loaded from the vendored build and the world rendered.
  try {
    await seedBackup(app.page, {
      version: 6, user: 'tester',
      lines: [{ id: 'L1', name: 'London', color: 'white', openingMoves: ['d4'], prefs: [] }],
    });
    await openVR(app.page);
    const state = await app.page.evaluate(() => window.__threeTestState);
    assert(state && state.room === 'mainStreet', `expected to spawn on mainStreet, got ${state && state.room}`);
    ok('VR world renders (three.js loaded, render loop live)');
  } catch(e){ bad('VR world renders', e); }

  // 3. The opening-move tile (PR #27) exists in the generated street, keyed to
  //    the system's line id — the retroactive verification of that feature.
  try {
    const scan = await app.page.evaluate(() => window.__threeTestEdit.scan());
    const tile = scan.find(o => o.slotId === 'open-L1');
    assert(tile, `no opening-move tile found; accessory slots: ${
      JSON.stringify(scan.filter(o => o.kind === 'accessory').map(o => o.slotId))}`);
    assert(tile.kind === 'accessory', `tile has wrong kind: ${tile.kind}`);
    ok(`opening-move tile present under the sign (slotId ${tile.slotId})`);
  } catch(e){ bad('opening-move tile present', e); }

  // 4. The tile is editable: enter edit mode, select + nudge it through the real
  //    edit path, force a room rebuild, and confirm the tile survives — i.e. its
  //    transform persisted into the layout and re-renders without error.
  try {
    const r = await app.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      dbg.toggle();                                          // edit mode on
      await new Promise(res => setTimeout(res, 40));
      const edit = window.__threeTestState.editMode;
      dbg.target({ kind: 'accessory', doorBill: true, slotId: 'open-L1',
                   roomKey: 'mainStreet', base: { x: 0, y: 0.65, z: 0 } });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));   // nudge
      await new Promise(res => setTimeout(res, 60));
      dbg.enter('mainStreet');                               // full rebuild from persisted layout
      await new Promise(res => setTimeout(res, 60));
      const still = dbg.scan().some(o => o.slotId === 'open-L1');
      return { edit, still };
    });
    assert(r.edit, 'edit mode did not engage');
    assert(r.still, 'tile did not survive select→nudge→rebuild');
    ok('opening-move tile is editable (select→nudge→rebuild persists)');
  } catch(e){ bad('opening-move tile editable', e); }

  if(app.blockedCdn.length){
    const hosts = [...new Set(app.blockedCdn.map(u => new URL(u).host))];
    console.log(`\n  (intentionally un-mocked CDNs, app degrades gracefully: ${hosts.join(', ')})`);
  }
} finally {
  await app.close();
}

// --- Phase B: opponent move-quality annotation (move table) ---
const app2 = await launchApp();
try {
  // seed a white 1.d4 line plus a game so the opponent reply (Nf6) appears as a row
  await seedBackup(app2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'London', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
  });
  await app2.page.click('.line-row');                                   // open the move table
  await app2.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  const rowSel = 'tr.data-row[data-opp="Nf6"]';

  // 5. Setting a glyph from the ⋮ strip renders it (colour-coded) on the move.
  //    (Click via evaluate: the ⋮ icon button has zero size because Font Awesome
  //    is CDN-blocked here, so Playwright deems it "not visible" — the real
  //    onclick handlers still fire.)
  try {
    await app2.page.evaluate(s => document.querySelector(`${s} .rowMenuBtn`).click(), rowSel);
    await app2.page.evaluate(s => document.querySelector(`${s} .rmq[data-q="?"]`).click(), rowSel);
    const glyph = (await app2.page.textContent(`${rowSel} .moveQual`)).trim();
    const cls = await app2.page.getAttribute(`${rowSel} .moveQual`, 'class');
    assert(glyph === '?', `expected '?' on the move, got '${glyph}'`);
    assert(/mq-bad/.test(cls), `expected mq-bad colour class, got '${cls}'`);
    ok("move-quality glyph set from the ⋮ strip renders on the move (Nf6?)");
  } catch(e){ bad('move-quality glyph set', e); }

  // 6. It persists: reload the app from IDB and reopen the line — glyph is back.
  try {
    await app2.page.reload({ waitUntil: 'domcontentloaded' });
    await app2.page.waitForFunction(() => {
      const el = document.getElementById('buildStamp');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    await app2.page.click('.line-row');
    await app2.page.waitForSelector(rowSel, { timeout: 10000 });
    const glyph = (await app2.page.textContent(`${rowSel} .moveQual`)).trim();
    assert(glyph === '?', `glyph did not persist across reload, got '${glyph}'`);
    ok('move-quality glyph persists across reload (IDB)');
  } catch(e){ bad('move-quality glyph persists', e); }

  // 7. Importing a whole variation writes the standard responses along it. This
  //    is the shared core the engine panel's "Import this variation" delegates
  //    to (importParsedLine on [...pathToPosition, ...pv]). The engine panel
  //    itself can't be driven here — Stockfish is CDN-blocked in the sandbox —
  //    so we verify the tree-writing core through the paste-import UI.
  try {
    await app2.page.evaluate(() => document.getElementById('menuImportLine').click());
    await app2.page.fill('#importLineInput', '1. d4 Nf6 2. c4 e6 3. Nc3');
    await app2.page.evaluate(() => document.getElementById('importLineSaveBtn').click());
    await app2.page.waitForFunction(() => {
      const row = document.querySelector('tr.data-row[data-opp="Nf6"]');
      return row && row.querySelector('.ourReply')?.textContent?.trim() === 'c4';
    }, { timeout: 10000 });
    ok('import-variation writes standard responses into the tree (engine-import core)');
  } catch(e){ bad('import-variation core', e); }
} finally {
  await app2.close();
}

// --- Phase C: cross-castle door plaque (two-line: castle name over room) ---
const app3 = await launchApp();
try {
  // seed a line whose "Alpha" castle contains a nested "Beta" castle root, so
  // Alpha's generation has a door crossing into Beta.
  await seedBackup(app3.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      // the entry branches (e6 / g6) so it's a junction with real doors; the e6
      // door leads into the nested Beta castle, the g6 door stays in Alpha.
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3', isCastleRoot: true, castleName: 'Beta', castleStreetNumber: 2, name: 'Beta Foyer' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6 Nc3 Bg7', white: 'a', black: 'b', result: '*' },
    ],
  });
  await app3.page.click('.line-row');
  await app3.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });

  // 8. Generate Alpha's castle and walk it; a door into Beta shows the taller
  //    two-line castle plaque (PlaneGeometry height 0.45 vs 0.33 for room-only).
  try {
    // open the Nf6 row's ⋮ and Generate Castle (icon buttons have zero size
    // without Font Awesome, so click through evaluate)
    await app3.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
    await app3.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
    await app3.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
    await app3.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
    await app3.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
    await app3.page.evaluate(() => document.getElementById('castleWalkBtn').click());
    await app3.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
    // let the async move-image/plaque builds settle
    await app3.page.waitForTimeout(500);
    const found = await app3.page.evaluate(() => {
      const meshes = window.__threeTestEdit.meshes();
      const planes = meshes.filter(m => m.type === 'PlaneGeometry');
      const twoLine = planes.filter(m => m.params && Math.abs(m.params.height - 0.45) < 0.02);
      const oneLine = planes.filter(m => m.params && Math.abs(m.params.height - 0.33) < 0.02);
      return { twoLine: twoLine.length, oneLine: oneLine.length };
    });
    assert(found.twoLine >= 1,
      `expected a two-line cross-castle plaque (0.45-high plane); planes found: ${JSON.stringify(found)}`);
    ok(`cross-castle door shows the two-line castle plaque (${found.twoLine} found)`);
  } catch(e){ bad('cross-castle door plaque', e); }
} finally {
  await app3.close();
}

// --- Phase C2: a nested castle's door redirects to the OTHER castle's own
// canonical room, so decorations configured there (e.g. a staircase) show up
// from the nested door too, instead of a duplicate/undecorated inline copy. ---
const appC2 = await launchApp();
try {
  const keys = await appC2.page.evaluate(() => {
    const pk = mv => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_'); };
    return {
      alphaEntry: 'cas:L1_Alpha:' + pk(['d4','Nf6','c4']),
      betaEntry: 'cas:L1_Beta:' + pk(['d4','Nf6','c4','e6','Nc3']),
    };
  });
  // same nested Alpha/Beta shape as Phase C, but with a threeLayout override
  // making Alpha's door into Beta a staircase -- keyed on Beta's OWN canonical
  // room key (as if the user had set this while standing in Alpha's entry,
  // looking at the door that the app already labels "Beta Mansion, Foyer").
  await seedBackup(appC2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3', isCastleRoot: true, castleName: 'Beta', castleStreetNumber: 2, name: 'Beta Foyer' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6 Nc3 Bg7', white: 'a', black: 'b', result: '*' },
    ],
    threeLayout: JSON.stringify({ [keys.alphaEntry]: { exits: { [keys.betaEntry]: { type: 'stair' } } } }),
  });
  await appC2.page.click('.line-row');
  await appC2.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await appC2.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await appC2.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await appC2.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await appC2.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await appC2.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await appC2.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await appC2.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await appC2.page.waitForTimeout(500);

  try {
    // a staircase saved against Beta's own canonical key renders on Alpha's
    // nested door into Beta -- proving that door's target is the same stable
    // key Beta's own front door would use, not a per-Alpha inline duplicate.
    const stairCount = await appC2.page.evaluate(() =>
      window.__threeTestEdit.meshes().filter(m => m.kind === 'stair-surface').length);
    assert(stairCount > 0, `expected a staircase into the shared room, found none (meshes with kind stair-surface: ${stairCount})`);
    ok(`nested door honors a staircase saved on the other castle's own room (${stairCount} step(s))`);
  } catch(e){ bad('nested door renders foreign-room staircase', e); }

  try {
    // walking straight to Beta's own canonical key (the same one Alpha's door
    // targets) must land in a real, registered room -- confirming it's the
    // SAME room object, not a blank/unregistered stand-in.
    const entered = await appC2.page.evaluate(async (betaKey) => {
      window.__threeTestEdit.enter(betaKey);
      // __threeTestState is only refreshed by the render tick, not synchronously
      // by enter() -- give it a frame or two before reading it back.
      await new Promise(r => setTimeout(r, 150));
      return window.__threeTestState.room;
    }, keys.betaEntry);
    assert(entered === keys.betaEntry, `expected to land in Beta's own canonical room ${keys.betaEntry}, got ${entered}`);
    ok(`Beta's canonical room is the same one reachable through Alpha's nested door (${entered})`);
  } catch(e){ bad('shared room reachable by its canonical key', e); }
} finally {
  await appC2.close();
}

// --- Phase D: walk UP a staircase that shares its wall with other doors ---
// (regression: a variation import added a door to a stair's wall, and the clamp
// only allowed ONE door per wall as walkable, blocking the stair at its base.)
const app4 = await launchApp();
try {
  const keys = await app4.page.evaluate(() => {
    const pk = mv => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_'); };
    return { alpha: pk(['d4','Nf6','c4']), r2: pk(['d4','Nf6','c4','e6','Nc3']) };
  });
  // a castle entry with FIVE forward branches (so doors share walls) + the e6
  // door made an up-staircase via a threeLayout override
  await seedBackup(app4.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','c5'], reply: 'd5' },
      { seq: ['d4','Nf6','c4','d6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e5'], reply: 'dxe5' },
    ]}],
    games: [
      { id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' },
      { id:'g2', moves:'d4 Nf6 c4 g6 Nc3 Bg7', white:'a', black:'b', result:'*' },
      { id:'g3', moves:'d4 Nf6 c4 c5 d5 b5',   white:'a', black:'b', result:'*' },
      { id:'g4', moves:'d4 Nf6 c4 d6 Nc3 g6',  white:'a', black:'b', result:'*' },
      { id:'g5', moves:'d4 Nf6 c4 e5 dxe5 Ng4',white:'a', black:'b', result:'*' },
    ],
    threeLayout: JSON.stringify({ [keys.alpha]: { exits: { [keys.r2]: { type: 'stair' } } } }),
  });
  await app4.page.click('.line-row');
  await app4.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await app4.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await app4.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await app4.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await app4.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await app4.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await app4.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await app4.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await app4.page.waitForTimeout(400);

  // 9. Walk up the staircase from its base; the player should climb the corridor
  //    and teleport into the room above (not be blocked at the doorway).
  try {
    const r = await app4.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      const steps = dbg.meshes().filter(m => m.kind === 'stair-surface');
      if(!steps.length) return { err: 'no staircase built' };
      let near = steps[0], far = steps[0];
      for(const s of steps){
        if(s.x*s.x+s.z*s.z < near.x*near.x+near.z*near.z) near = s;
        if(s.x*s.x+s.z*s.z > far.x*far.x+far.z*far.z) far = s;
      }
      const len = Math.hypot(far.x, far.z) || 1, dirx = far.x/len, dirz = far.z/len;
      const yaw = Math.atan2(-dirx, -dirz);
      const roomBefore = window.__threeTestState.room;
      dbg.teleport(near.x - dirx*1.5, near.z - dirz*1.5, yaw);   // just inside, facing up
      await new Promise(r => setTimeout(r, 700));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      // poll for the room change rather than a fixed hold -- headless frame
      // timing varies with machine load (this is the 4th browser launched in
      // the run), and a real climb can take longer than any single fixed delay.
      const deadline = Date.now() + 12000;
      while(Date.now() < deadline && window.__threeTestState.room === roomBefore){
        await new Promise(r => setTimeout(r, 150));
      }
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
      return { roomBefore, roomAfter: window.__threeTestState.room };
    });
    assert(!r.err, r.err);
    assert(r.roomAfter && r.roomAfter !== r.roomBefore,
      `blocked on the staircase — room did not change (before/after ${r.roomBefore} / ${r.roomAfter})`);
    ok('walk UP a wall-sharing staircase reaches the room above');
  } catch(e){ bad('walk up shared-wall staircase', e); }
} finally {
  await app4.close();
}

// --- Phase E: room-bounds auto-fix (a nudged item survives a later downsize) ---
const app5 = await launchApp();
try {
  await seedBackup(app5.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
    ]}],
    games: [
      { id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' },
      { id:'g2', moves:'d4 Nf6 c4 g6 Nc3 Bg7', white:'a', black:'b', result:'*' },
    ],
  });
  await app5.page.click('.line-row');
  await app5.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await app5.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await app5.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await app5.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await app5.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await app5.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await app5.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await app5.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await app5.page.waitForTimeout(400);

  // 10. Nudge the entry room's own move-pair billboard (mnem-C1 -- always
  //     present, unlike the move-object prop which needs an asset assigned)
  //     far toward a wall while the room is still full-size, then shrink the
  //     room well below that position. It should already be back inside the
  //     new footprint immediately (buildRoom runs the reconciler on every
  //     rebuild, not just on room entry) -- and stay fixed after a re-entry.
  try {
    const room = await app5.page.evaluate(() => window.__threeTestEdit.room());
    const nudged = await app5.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      dbg.toggle();
      await new Promise(r => setTimeout(r, 60));
      dbg.target({ kind: 'accessory', slotId: 'mnem-C1' });
      await new Promise(r => setTimeout(r, 60));
      for(let i = 0; i < 60; i++){
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
        await new Promise(r => setTimeout(r, 20));
      }
      await new Promise(r => setTimeout(r, 100));
      return dbg.posOf('mnem-C1');
    });
    assert(nudged && nudged.x > 3, `nudge didn't move the billboard far enough to test with (x=${nudged && nudged.x})`);

    // dbg.resize() -> setRoomGeom() doesn't return a promise the caller can
    // await (applyEdit's persistLayout/refreshAssetMap/buildRoom chain runs
    // async), so poll for the reconciled position rather than trust a fixed
    // delay -- under load (this is the 5th browser launched in the run) a
    // single guessed wait was occasionally too short, flaking the assertion
    // even though the fix itself had already landed correctly.
    const tolerance = 4/2 - 0.3 + 0.02;   // room half-width (w=d=4) plus a small margin
    const afterResize = await app5.page.evaluate(async ({ rk, bound }) => {
      const dbg = window.__threeTestEdit;
      dbg.resize(rk, { w: 4, d: 4, h: 3 });
      let pos = null;
      const deadline = Date.now() + 8000;
      while(Date.now() < deadline){
        pos = dbg.posOf('mnem-C1');
        if(pos && Math.abs(pos.x) <= bound && Math.abs(pos.z) <= bound) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return pos;
    }, { rk: room, bound: tolerance });
    const inBounds = p => p && Math.abs(p.x) <= tolerance && Math.abs(p.z) <= tolerance;
    assert(inBounds(afterResize),
      `billboard stayed outside the shrunk room after resize: ${JSON.stringify(afterResize)} (bound ±${tolerance})`);

    const afterReentry = await app5.page.evaluate(async (rk) => {
      const dbg = window.__threeTestEdit;
      dbg.enter('mainStreet');
      await new Promise(r => setTimeout(r, 150));
      dbg.enter(rk);
      await new Promise(r => setTimeout(r, 150));
      return dbg.posOf('mnem-C1');
    }, room);
    assert(inBounds(afterReentry),
      `billboard drifted back out after a re-entry: ${JSON.stringify(afterReentry)} (bound ±${tolerance})`);

    ok('a nudged billboard is auto-clamped back inside a room that was made smaller');
  } catch(e){ bad('room-bounds auto-fix', e); }
} finally {
  await app5.close();
}

// 11. The top-toolbar board icon shows a mini board of the current room's
//     position. Generate a castle, walk in, and confirm the board button is
//     present for a castle room and toggles an 8x8 (64-cell) overlay.
const app6 = await launchApp();
try {
  await seedBackup(app6.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
    ]}],
    games: [ { id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' } ],
  });
  await app6.page.click('.line-row');
  await app6.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await app6.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await app6.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await app6.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await app6.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await app6.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await app6.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await app6.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await app6.page.waitForTimeout(400);
  try {
    // the current room is a castle room, so it carries a position
    const room = await app6.page.evaluate(() => window.__threeTestEdit.room());
    assert(/^cas:/.test(room), `expected to spawn in a castle room, got '${room}'`);
    // the board button is the toolbar icon whose title mentions the board position
    const btnVisible = await app6.page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /board position/i.test(x.title || ''));
      return b ? b.offsetParent !== null : false;
    });
    assert(btnVisible, 'board toolbar button not visible in a castle room');
    // click it and confirm a 64-cell mini board appears with a side-to-move caption
    const board = await app6.page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /board position/i.test(x.title || ''));
      b.click();
      const ov = document.getElementById('miniBoardOverlay');
      if(!ov || ov.style.display !== 'flex') return { open: false };
      const cells = ov.querySelectorAll('div[style*="grid-template-columns"] > div').length;
      const cap = /to move/.test(ov.textContent);
      return { open: true, cells, cap };
    });
    assert(board.open, 'clicking the board icon did not open the mini board');
    assert(board.cells === 64, `mini board should have 64 cells, got ${board.cells}`);
    assert(board.cap, 'mini board missing the side-to-move caption');
    assert(realErrors(app6.consoleErrors).length === 0,
      'unexpected console errors:\n' + realErrors(app6.consoleErrors).join('\n'));
    ok('toolbar board icon shows a 64-cell mini board of the room position');
  } catch(e){ bad('VR board icon', e); }
} finally {
  await app6.close();
}

// --- Phase G: mnemonic quiz "Restrict to Opening Coverage" scoped to a castle ---
const app7 = await launchApp();
try {
  // Alpha's castle root sits at ['d4','Nf6','c4'] (the room after 1.d4 Nf6 2.c4).
  // computeMnemonicCoverage(line, rootSeq) only covers that room's OWN subtree,
  // not the lead-in moves above it -- so a mnemonic on d4 (the line's own first
  // move, pawn->d4) is covered by "(whole system)" but NOT by "castle:Alpha".
  // That gap is exactly what proves castle-scoping is narrower than the old
  // system-only restriction, not just cosmetically different.
  await seedBackup(app7.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id:'g1', moves:'d4 Nf6 c4 e6', white:'a', black:'b', result:'*' }],
    mnemonics: [{ square: 'd4', pawn: 'Deer' }],
  });

  // wrapped (unlike the rest of this file's per-test try/catches, this one
  // guards *setup* used by tests 12-14): quizOpenSetup awaits an IDB read
  // before showing, and under the accumulated load of a full suite run with
  // many sequential browser launches this has been observed to occasionally
  // exceed even a generous timeout (confirmed: resolves in ~100ms standalone).
  // Uncaught, that would crash the whole run instead of just this phase.
  try {
    await app7.page.evaluate(() => document.getElementById('menuQuiz').click());
    await app7.page.waitForSelector('#quizSetup', { state: 'visible', timeout: 50000 });
  } catch(e){ bad('quiz setup opened', e); }

  // 12. The coverage select is broken out into per-system optgroups with a
  //     "(whole system)" option plus one "↳ <castle>" option per castle --
  //     the same structure Manage Mnemonics already uses.
  try {
    const struct = await app7.page.evaluate(() => {
      const sel = document.getElementById('quizCoverageSelect');
      const group = [...sel.querySelectorAll('optgroup')].find(g => g.label === 'Test');
      if(!group) return { found: false };
      const opts = [...group.querySelectorAll('option')].map(o => ({ value: o.value, text: o.textContent }));
      return { found: true, opts };
    });
    assert(struct.found, 'no optgroup for the "Test" system in the quiz coverage select');
    assert(struct.opts.some(o => o.text === '(whole system)'), `missing "(whole system)" option: ${JSON.stringify(struct.opts)}`);
    assert(struct.opts.some(o => o.value.startsWith('castle:') && o.text === '↳ Alpha'),
      `missing "↳ Alpha" castle option: ${JSON.stringify(struct.opts)}`);
    ok('quiz coverage select breaks the system out into its castles');
  } catch(e){ bad('quiz coverage select structure', e); }

  // 13. Selecting the CASTLE scope excludes the d4 mnemonic (outside the
  //     castle's own subtree) -- START should refuse with the coverage error.
  try {
    const castleVal = await app7.page.evaluate(() => {
      const sel = document.getElementById('quizCoverageSelect');
      const opt = [...sel.options].find(o => o.value.startsWith('castle:'));
      sel.value = opt.value;
      return opt.value;
    });
    assert(castleVal, 'could not find a castle: option to select');
    await app7.page.evaluate(() => document.getElementById('quizStartBtn').click());
    await app7.page.waitForTimeout(300);
    const err = await app7.page.textContent('#quizSetupError');
    const playShown = await app7.page.evaluate(() => document.getElementById('quizPlay').style.display === 'block');
    assert(!playShown, 'quiz started despite the d4 mnemonic being outside the castle\'s coverage');
    assert(/coverage/i.test(err), `expected a coverage-mismatch error, got: "${err}"`);
    ok('castle-scoped coverage correctly excludes a mnemonic outside that castle\'s subtree');
  } catch(e){ bad('castle coverage excludes out-of-subtree item', e); }

  // 14. Selecting "(whole system)" for the same line includes it -- START succeeds.
  try {
    await app7.page.evaluate(() => {
      const sel = document.getElementById('quizCoverageSelect');
      const opt = [...sel.options].find(o => o.value === 'L1');
      sel.value = opt.value;
    });
    await app7.page.evaluate(() => document.getElementById('quizStartBtn').click());
    await app7.page.waitForTimeout(300);
    const playShown = await app7.page.evaluate(() => document.getElementById('quizPlay').style.display === 'block');
    assert(playShown, 'whole-system coverage failed to start despite covering the d4 mnemonic');
    ok('whole-system coverage still includes the lead-in move a castle subtree excludes');
  } catch(e){ bad('whole-system coverage includes lead-in item', e); }
} finally {
  await app7.close();
}

// --- Phase H: the VR mini board and the room-info mini board render identical,
//     real piece artwork (same cm-chessboard sprite as the main analysis boards) ---
const app8 = await launchApp();
try {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // 15. app.js's miniBoardGridHtml (the room-info modal's renderer): every one
  //     of the 32 starting pieces resolves to real, non-empty SVG artwork from
  //     the vendored sprite -- not just a plausible-looking <use> reference.
  //     The sprite is fetched asynchronously and inlined (see ensurePieceSprite
  //     -- a cross-origin <use> is blocked outright, so this is the actual
  //     production mechanism, not a test-only shortcut), so poll rather than
  //     check immediately.
  try {
    const res = await app8.page.evaluate(async (fen) => {
      const div = document.createElement('div');
      div.innerHTML = window.__miniBoardGridHtml(fen, false);
      document.body.appendChild(div);
      const svgs = [...div.querySelectorAll('svg')];
      const uses = svgs.map(s => s.querySelector('use'));
      let allResolved = false;
      for(let i = 0; i < 30 && !allResolved; i++){
        if(i > 0) await new Promise(r => setTimeout(r, 100));
        allResolved = uses.every(u => { const b = u.getBBox(); return b.width > 0 && b.height > 0; });
      }
      div.remove();
      return { svgCount: svgs.length, allResolved };
    }, startFen);
    assert(res.svgCount === 32, `expected 32 piece SVGs on the starting position, got ${res.svgCount}`);
    assert(res.allResolved, 'some room-info mini-board pieces did not resolve to real artwork (dangling <use>)');
    ok('room-info mini board renders real piece artwork for all 32 starting pieces');
  } catch(e){ bad('room-info mini board renders real artwork', e); }

  // seed + generate a castle so the VR mini board has a real room position to show
  await seedBackup(app8.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id:'g1', moves:'d4 Nf6 c4 e6', white:'a', black:'b', result:'*' }],
  });
  await app8.page.click('.line-row');
  await app8.page.waitForSelector('.data-row', { timeout: 10000 });
  await app8.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await app8.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await app8.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await app8.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await app8.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await app8.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await app8.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await app8.page.waitForTimeout(500);

  // 16. threeVR.js's mini board (the actual toolbar board icon, real UI path,
  //     not just its renderer function): opens with real piece artwork too,
  //     referencing the sprite by a bare "#id" fragment -- a full cross-origin
  //     URL there is exactly what browsers block (see ensurePieceSprite), so a
  //     bare fragment is the correct/expected form, not a fallback.
  try {
    const btn = await app8.page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /board position/i.test(x.title || ''));
      if(!b) return false;
      b.click();
      return true;
    });
    assert(btn, 'VR board toolbar icon not found');
    const res = await app8.page.evaluate(async () => {
      const ov = document.getElementById('miniBoardOverlay');
      if(!ov || ov.style.display !== 'flex') return { open: false };
      const svgs = [...ov.querySelectorAll('svg')];
      const useEls = svgs.map(s => s.querySelector('use'));
      let allResolved = false;
      for(let i = 0; i < 30 && !allResolved; i++){
        if(i > 0) await new Promise(r => setTimeout(r, 100));
        allResolved = useEls.every(u => { const b = u.getBBox(); return b.width > 0 && b.height > 0; });
      }
      const hrefs = useEls.map(u => u.getAttribute('href'));
      return { open: true, svgCount: svgs.length, allResolved, sampleHref: hrefs[0] };
    });
    assert(res.open, 'VR mini board did not open');
    assert(res.svgCount > 0, 'VR mini board shows no piece artwork');
    assert(res.allResolved, 'some VR mini-board pieces did not resolve to real artwork (dangling <use>)');
    assert(/^#[wb][pnbrqk]$/.test(res.sampleHref || ''),
      `VR mini board should reference the piece by a bare #id, got: ${res.sampleHref}`);
    ok('VR mini board renders real piece artwork, same sprite technique as the room-info board');
  } catch(e){ bad('VR mini board renders real artwork', e); }
} finally {
  await app8.close();
}

// --- Phase I: graph node layout (manual de-overlap dragging) persists ---
const app9 = await launchApp();
try {
  await seedBackup(app9.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
      { seq: ['d4','Nf6','c4'], reply: 'e6' },
    ]}],
    games: [{ id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' }],
  });
  await app9.page.click('.line-row');
  await app9.page.waitForSelector('.data-row', { timeout: 10000 });
  await app9.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
  await app9.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });

  // 17. Drag a node, close and reopen the graph (fresh dagre relayout): the
  //     node should land back at dagre's own spot PLUS the saved delta, not
  //     at dagre's raw spot (the fix wouldn't be doing anything) and not
  //     pinned to a stale absolute coordinate.
  let targetFen, posBefore, dragDx = 41, dragDy = -27;
  try {
    targetFen = await app9.page.evaluate(() => {
      const n = window.__graphTestHooks.cy().nodes().filter(x => !!x.data('fen'))[0];
      return n ? n.data('fen') : null;
    });
    assert(targetFen, 'no fen-bearing graph node found to drag');
    posBefore = await app9.page.evaluate((fen) => {
      const n = window.__graphTestHooks.cy().nodes().filter(x => x.data('fen') === fen);
      return n.position();
    }, targetFen);
    const dragged = await app9.page.evaluate(({ fen, dx, dy }) => window.__graphTestHooks.dragNodeBy(fen, dx, dy),
      { fen: targetFen, dx: dragDx, dy: dragDy });
    assert(dragged, 'dragNodeBy could not find the target node');

    // reopen: close, then rebuild the graph fresh (new cy instance, fresh dagre run)
    await app9.page.evaluate(() => document.getElementById('graphCloseBtn').click());
    await app9.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
    await app9.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });
    const posAfter = await app9.page.evaluate((fen) => {
      const n = window.__graphTestHooks.cy().nodes().filter(x => x.data('fen') === fen);
      return n.nonempty() ? n.position() : null;
    }, targetFen);
    assert(posAfter, 'dragged node not found after reopening the graph');
    const dx = posAfter.x - posBefore.x, dy = posAfter.y - posBefore.y;
    assert(Math.abs(dx - dragDx) < 2 && Math.abs(dy - dragDy) < 2,
      `expected the reopened node offset by ~(${dragDx},${dragDy}) from dagre's base, got (${dx.toFixed(1)},${dy.toFixed(1)})`);
    ok('dragged graph node keeps its manual offset across a same-session reopen');
  } catch(e){ bad('graph layout persists across reopen', e); }

  // 18. Persists across a full reload too (real IndexedDB round-trip, not just
  //     the in-memory GRAPH_LAYOUT surviving a re-render).
  try {
    await app9.page.reload({ waitUntil: 'domcontentloaded' });
    await app9.page.waitForFunction(() => {
      const el = document.getElementById('buildStamp');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    await app9.page.click('.line-row');
    await app9.page.waitForSelector('.data-row', { timeout: 10000 });
    await app9.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
    await app9.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });
    const posReload = await app9.page.evaluate((fen) => {
      const n = window.__graphTestHooks.cy().nodes().filter(x => x.data('fen') === fen);
      return n.nonempty() ? n.position() : null;
    }, targetFen);
    assert(posReload, 'dragged node not found after a full page reload');
    const dx = posReload.x - posBefore.x, dy = posReload.y - posBefore.y;
    assert(Math.abs(dx - dragDx) < 2 && Math.abs(dy - dragDy) < 2,
      `expected the offset to survive a reload: ~(${dragDx},${dragDy}), got (${dx.toFixed(1)},${dy.toFixed(1)})`);
    ok('graph layout survives a full page reload (real IndexedDB persistence)');
  } catch(e){ bad('graph layout persists across reload', e); }

  // 19. "Reset Layout" clears the saved delta -- the node goes back to
  //     dagre's raw position (matching posBefore).
  try {
    await app9.page.evaluate(() => document.getElementById('graphResetLayoutBtn').onclick());
    await app9.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });
    const posReset = await app9.page.evaluate((fen) => {
      const n = window.__graphTestHooks.cy().nodes().filter(x => x.data('fen') === fen);
      return n.nonempty() ? n.position() : null;
    }, targetFen);
    assert(posReset, 'node not found after Reset Layout');
    const dx = posReset.x - posBefore.x, dy = posReset.y - posBefore.y;
    assert(Math.abs(dx) < 2 && Math.abs(dy) < 2,
      `Reset Layout should return the node to dagre's raw spot; drifted by (${dx.toFixed(1)},${dy.toFixed(1)})`);
    ok('Reset Layout clears the saved offset');
  } catch(e){ bad('Reset Layout clears offset', e); }
} finally {
  await app9.close();
}

// --- Phase J: surface color picker (flat color as an alternative to an image asset) ---
const app10 = await launchApp();
try {
  await seedBackup(app10.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' }],
  });
  await app10.page.click('.line-row');
  await app10.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await app10.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await app10.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await app10.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await app10.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await app10.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await app10.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await app10.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await app10.page.waitForTimeout(400);
  await app10.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on, once, for the whole phase
  await app10.page.waitForTimeout(60);

  // 20. Clicking the picker's "Color…" tile, then a preset swatch, flat-colors
  //     the wall (no texture map) and the tile shows that color as current on reopen.
  let presetHex;
  try {
    await app10.page.evaluate(() => window.__threeTestEdit.target({ kind: 'wall', wall: 'north' }));
    await app10.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await app10.page.click('#pickerGrid .asset-card-color');
    await app10.page.waitForSelector('#colorSwatchPickerOverlay', { state: 'visible', timeout: 5000 });
    presetHex = await app10.page.evaluate(() => document.querySelector('#colorSwatchPickerOverlay .color-swatch').dataset.hex);
    await app10.page.click('#colorSwatchPickerOverlay .color-swatch');
    await app10.page.waitForSelector('#colorSwatchPickerOverlay', { state: 'hidden', timeout: 5000 });
    await app10.page.waitForTimeout(150);   // room rebuild after applyEdit

    const wallMeshes = await app10.page.evaluate(() =>
      window.__threeTestEdit.meshes().filter(m => m.kind === 'wall' && m.wall === 'north'));
    assert(wallMeshes.length, 'no north wall meshes found after coloring');
    assert(wallMeshes.every(m => m.color === presetHex && !m.hasMap),
      `wall did not render as flat color ${presetHex}: ${JSON.stringify(wallMeshes)}`);

    await app10.page.evaluate(() => window.__threeTestEdit.target({ kind: 'wall', wall: 'north' }));
    await app10.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    const tile = await app10.page.evaluate(() => {
      const el = document.querySelector('#pickerGrid .asset-card-color');
      return { current: el.classList.contains('asset-card-current'), text: el.textContent };
    });
    assert(tile.current && tile.text.includes(presetHex), `color tile not marked current: ${JSON.stringify(tile)}`);
    await app10.page.click('#pickerCloseBtn');
    await app10.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
    ok(`picking a preset swatch flat-colors the wall (${presetHex}, no texture map) and reopens as "current"`);
  } catch(e){ bad('surface color picker: preset swatch on a wall', e); }

  // 21. Custom hex entry via the text input + Apply, on the floor this time.
  try {
    await app10.page.evaluate(() => window.__threeTestEdit.target({ kind: 'floor' }));
    await app10.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await app10.page.click('#pickerGrid .asset-card-color');
    await app10.page.waitForSelector('#colorSwatchPickerOverlay', { state: 'visible', timeout: 5000 });
    await app10.page.fill('#cswHexInput', '#336699');
    await app10.page.click('#cswApplyBtn');
    await app10.page.waitForSelector('#colorSwatchPickerOverlay', { state: 'hidden', timeout: 5000 });
    await app10.page.waitForTimeout(150);

    const floorMeshes = await app10.page.evaluate(() =>
      window.__threeTestEdit.meshes().filter(m => m.kind === 'floor'));
    assert(floorMeshes.length && floorMeshes.every(m => m.color === '#336699' && !m.hasMap),
      `floor did not take the custom hex: ${JSON.stringify(floorMeshes)}`);
    ok('custom hex entry (+ Apply) flat-colors the floor');
  } catch(e){ bad('surface color picker: custom hex on the floor', e); }

  // 22. Remove clears the color override back to the procedural default.
  try {
    await app10.page.evaluate(() => window.__threeTestEdit.target({ kind: 'floor' }));
    await app10.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await app10.page.click('#pickerGrid .asset-card-color');
    await app10.page.waitForSelector('#colorSwatchPickerOverlay', { state: 'visible', timeout: 5000 });
    await app10.page.click('#cswRemoveBtn');
    await app10.page.waitForSelector('#colorSwatchPickerOverlay', { state: 'hidden', timeout: 5000 });
    await app10.page.waitForTimeout(150);

    const floorMeshes = await app10.page.evaluate(() =>
      window.__threeTestEdit.meshes().filter(m => m.kind === 'floor'));
    assert(floorMeshes.length && floorMeshes.every(m => m.color !== '#336699'),
      `floor still shows the removed color: ${JSON.stringify(floorMeshes)}`);
    ok('Remove clears a surface color override back to the procedural default');
  } catch(e){ bad('surface color picker: remove', e); }
} finally {
  await app10.close();
}

// --- Phase K: Chessboard test (Test > Chessboard) -- coverage/depth logic ---
// cm-chessboard is intentionally un-mocked in this harness (Chessboard is
// null), so the actual board-driven quiz play can't be exercised end-to-end
// here -- same structural gap the pre-existing per-row Opening Quiz already
// has zero coverage for. What's new and testable in isolation is the plain
// data logic added for the session quiz (coverage-bounded eligibility, the
// same-choices replay picker, and the move-number/depth math), exercised
// directly through the real production functions via __oqTestHooks.
const app11 = await launchApp();
try {
  // 23. Menu wiring: clicking Test > Chessboard reaches the real feature (not
  //     a "Coming Soon" stub anymore) and degrades gracefully, same as the
  //     existing row-based Opening Quiz, when the board library is unavailable.
  try {
    let alertMsg = null;
    app11.page.once('dialog', d => { alertMsg = d.message(); });
    await app11.page.evaluate(() => document.getElementById('menuTestChessboard').click());
    await app11.page.waitForTimeout(200);
    assert(alertMsg && /could not be loaded/i.test(alertMsg), `expected the chessboard-unavailable alert, got: ${alertMsg}`);
    const setupVisible = await app11.page.evaluate(() =>
      getComputedStyle(document.getElementById('oqSetup')).display !== 'none');
    assert(!setupVisible, 'setup screen should not show when the chessboard library failed to load');
    ok('Test > Chessboard reaches the real feature (degrades gracefully without cm-chessboard)');
  } catch(e){ bad('chessboard test menu wiring', e); }

  // 24. oqCoverageEligible: before a castle's root sequence is reached there is
  //     only ever one move that stays on the path to it (forced); at/past the
  //     root, normal branching resumes; outside session/coverage, unrestricted.
  try {
    const root = ['d4', 'Nf6', 'c4'];
    await app11.page.evaluate((coverageRootSeq) => window.__oqTestHooks.setOQ({ coverageRootSeq }), root);
    const r = await app11.page.evaluate(() => {
      const h = window.__oqTestHooks;
      return {
        atStart: h.coverageEligible([], ['d4', 'e4']),
        afterD4: h.coverageEligible(['d4'], ['Nf6', 'Nc6']),
        afterNf6: h.coverageEligible(['d4', 'Nf6'], ['c4', 'Nf3']),
        atRoot: h.coverageEligible(['d4', 'Nf6', 'c4'], ['e6', 'g6']),
        offPath: h.coverageEligible(['d4'], ['g6']),
      };
    });
    assert(JSON.stringify(r.atStart) === JSON.stringify(['d4']), `expected the forced trigger ['d4'], got ${JSON.stringify(r.atStart)}`);
    assert(JSON.stringify(r.afterD4) === JSON.stringify(['Nf6']), `expected the forced reply ['Nf6'], got ${JSON.stringify(r.afterD4)}`);
    assert(JSON.stringify(r.afterNf6) === JSON.stringify(['c4']), `expected the forced reply ['c4'], got ${JSON.stringify(r.afterNf6)}`);
    assert(JSON.stringify(r.atRoot) === JSON.stringify(['e6', 'g6']), `expected unrestricted branching at the root, got ${JSON.stringify(r.atRoot)}`);
    assert(JSON.stringify(r.offPath) === JSON.stringify([]), `forced move not among candidates should yield no eligible moves, got ${JSON.stringify(r.offPath)}`);

    await app11.page.evaluate(() => window.__oqTestHooks.setOQ({ coverageRootSeq: null }));
    const whole = await app11.page.evaluate(() => window.__oqTestHooks.coverageEligible(['d4', 'Nf6'], ['e6', 'g6', 'a6']));
    assert(JSON.stringify(whole) === JSON.stringify(['e6', 'g6', 'a6']), `whole-system coverage should leave every candidate eligible, got ${JSON.stringify(whole)}`);
    ok('oqCoverageEligible forces the single path to a castle root, then opens up branching past it');
  } catch(e){ bad('oqCoverageEligible', e); }

  // 25. oqPickChoice: fresh picks get recorded for later replay; a "same
  //     choices" replay reproduces a still-valid recorded pick deterministically,
  //     and falls back to a fresh random pick when the recorded one no longer applies.
  try {
    await app11.page.evaluate(() => window.__oqTestHooks.setOQ({ replay: false, replayIdx: 0, oppChoices: [] }));
    const first = await app11.page.evaluate(() => window.__oqTestHooks.pickChoice(['a']));
    const afterFirst = await app11.page.evaluate(() => window.__oqTestHooks.getOQ());
    assert(first === 'a', `expected the only candidate 'a', got ${first}`);
    assert(JSON.stringify(afterFirst.oppChoices) === JSON.stringify(['a']) && afterFirst.replayIdx === 1,
      `pick was not recorded correctly: ${JSON.stringify(afterFirst)}`);

    // replay=true, the recorded choice ('a') is still a valid candidate -> reproduced exactly
    await app11.page.evaluate(() => window.__oqTestHooks.setOQ({ replay: true, replayIdx: 0 }));
    const replayed = await app11.page.evaluate(() => window.__oqTestHooks.pickChoice(['a', 'z']));
    assert(replayed === 'a', `same-choices replay should reproduce the recorded pick 'a', got ${replayed}`);

    // recorded choice ('a') no longer among candidates -> falls back to a fresh random pick
    const fallback = await app11.page.evaluate(() => window.__oqTestHooks.pickChoice(['x', 'y']));
    assert(['x', 'y'].includes(fallback), `expected a fresh pick from ['x','y'] when the recorded choice no longer applies, got ${fallback}`);
    ok('oqPickChoice records fresh picks and replays a still-valid recorded choice deterministically');
  } catch(e){ bad('oqPickChoice', e); }

  // 26. oqNextMoveNumber: the PGN move number the next ply belongs to, given
  //     how many plies have already been played -- what Max Depth is checked against.
  try {
    const cases = await app11.page.evaluate(() =>
      [0, 1, 2, 3, 11, 12].map(n => [n, window.__oqTestHooks.nextMoveNumber(n)]));
    const expected = [[0,1],[1,1],[2,2],[3,2],[11,6],[12,7]];
    assert(JSON.stringify(cases) === JSON.stringify(expected), `move-number mapping wrong: ${JSON.stringify(cases)}`);
    ok('oqNextMoveNumber matches PGN move numbering (the Max Depth check)');
  } catch(e){ bad('oqNextMoveNumber', e); }

  // 27. Regression: starting a chessboard-quiz session must load the QUIZZED
  //     line's real PREFS -- Test > Chessboard is reachable with no line open
  //     (CURRENT_LINE null, PREFS whatever was last there), and every reply
  //     lookup for the rest of the session reads the module-global PREFS
  //     directly. Before this fix PREFS was never actually swapped in, so
  //     every lookup after the first (openingMoves-sourced) move silently
  //     failed -- exactly the reported bug ("black never replies, then every
  //     move is wrong"). Also checks the swap is undone on close, so the
  //     tree view isn't left showing the wrong line's prefs afterwards.
  try {
    await seedBackup(app11.page, {
      version: 6, user: 'tester',
      lines: [{ id: 'L1', name: 'WhiteSys', color: 'white', openingMoves: ['d4'], prefs: [
        { seq: ['d4', 'Nf6'], reply: 'c4' },
      ]}],
    });
    // no .line-row click here -- CURRENT_LINE stays null, exactly the "went
    // straight from the hamburger menu" path that triggered the bug.
    await app11.page.evaluate(() => window.__oqTestHooks.setPrefs({ sentinel: 'before' }));
    const err = await app11.page.evaluate(() => window.__oqTestHooks.startSession('L1', 5, 10));
    assert(err === null, `startSession should succeed for a valid whole-system pick, got error: ${err}`);

    const prefsAfterStart = await app11.page.evaluate(() => window.__oqTestHooks.getPrefs());
    assert(Object.values(prefsAfterStart).some(p => p.reply === 'c4'),
      `PREFS was not swapped to the quizzed line's real data: ${JSON.stringify(prefsAfterStart)}`);
    const oqAfterStart = await app11.page.evaluate(() => window.__oqTestHooks.getOQ());
    assert(JSON.stringify(oqAfterStart.savedPrefs) === JSON.stringify({ sentinel: 'before' }),
      `savedPrefs should capture the pre-session PREFS, got ${JSON.stringify(oqAfterStart.savedPrefs)}`);

    await app11.page.evaluate(() => window.__oqTestHooks.restorePrefs());
    const prefsAfterRestore = await app11.page.evaluate(() => window.__oqTestHooks.getPrefs());
    assert(JSON.stringify(prefsAfterRestore) === JSON.stringify({ sentinel: 'before' }),
      `restorePrefs did not put back the pre-session PREFS, got ${JSON.stringify(prefsAfterRestore)}`);
    const oqAfterRestore = await app11.page.evaluate(() => window.__oqTestHooks.getOQ());
    assert(oqAfterRestore.savedPrefs === null,
      `savedPrefs should be cleared after restoring, got ${JSON.stringify(oqAfterRestore.savedPrefs)}`);
    ok('starting a chessboard-quiz session loads the quizzed line\'s real PREFS and restores the previous PREFS on close');
  } catch(e){ bad('chessboard quiz PREFS swap', e); }

  // 28. Regression: advancing from one session question to the next must not
  //     re-enable board input without disabling it first. cm-chessboard
  //     throws if enableMoveInput() is called while already enabled; oqRun()
  //     (called again for every subsequent question) always re-enables it,
  //     so oqFinish()'s auto-advance has to disable first -- exactly the bug
  //     reported after shipping the feature ("Question 2 of 10" appeared but
  //     the board never reset, because the enable call threw and aborted the
  //     rest of oqRun before it reached oqLoadStep/oqMarkOpponentMove).
  try {
    await app11.page.evaluate(() => {
      window.__oqTestHooks.setOQ({
        mode: 'session', questionIndex: 1, questionsTotal: 2, startSeq: [], color: 'white',
        hits: 3, misses: 1, oppChoices: [], line: { openingMoves: ['d4'] }, maxDepth: 20,
        coverageRootSeq: null,
      });
      window.__oqTestHooks.installFakeBoard();
    });
    let threw = null;
    try { await app11.page.evaluate(() => window.__oqTestHooks.callFinish()); }
    catch(e){ threw = e; }
    assert(!threw, `oqFinish should not throw when advancing to the next question: ${threw}`);

    const oqAfter = await app11.page.evaluate(() => window.__oqTestHooks.getOQ());
    assert(oqAfter.questionIndex === 2, `should have advanced to question 2, got ${oqAfter.questionIndex}`);
    assert(oqAfter.hits === 3 && oqAfter.misses === 1,
      `aggregate score should be kept across questions, got hits=${oqAfter.hits} misses=${oqAfter.misses}`);

    const log = await app11.page.evaluate(() => window.__oqTestHooks.getFakeBoardLog());
    assert(JSON.stringify(log) === JSON.stringify(['disable', 'enable']),
      `expected the board to be disabled before being re-enabled for the next question, got ${JSON.stringify(log)}`);
    ok('advancing to the next session question resets the board (disables input before re-enabling it)');
  } catch(e){ bad('chessboard quiz next-question board reset', e); }
} finally {
  await app11.close();
}

// --- Phase L: outdoor world (Main Street) sizing never strands a castle
//     outside the grass ---
const app12 = await launchApp();
try {
  await seedBackup(app12.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' }],
  });
  await app12.page.click('.line-row');
  await app12.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await app12.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await app12.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await app12.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await app12.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await app12.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await app12.page.evaluate(() => document.getElementById('castleReportCloseBtn').click());
  // "Run VR" (not the report's single-castle "Walk in VR"), so Main Street is
  // built with every real castle on it, same as generateMainStreet always does.
  await openVR(app12.page);
  await app12.page.waitForTimeout(400);

  // 29. Every castle building's footprint must fit inside the auto-sized grass.
  try {
    const size = await app12.page.evaluate(() => window.__threeTestEdit.roomSize('mainStreet'));
    const buildings = await app12.page.evaluate(() => window.__threeTestEdit.buildings());
    assert(size && size.w > 0 && size.d > 0, `mainStreet has no size: ${JSON.stringify(size)}`);
    assert(buildings.length > 0, 'expected at least one castle building on the street');
    const outside = buildings.filter(b =>
      Math.abs(b.origin.x) + b.size.w / 2 > size.w / 2 || Math.abs(b.origin.z) + b.size.d / 2 > size.d / 2);
    assert(outside.length === 0,
      `${outside.length} building(s) fall outside the ground plane: ${JSON.stringify(outside)} (room size ${JSON.stringify(size)})`);
    ok(`every castle building fits inside the auto-sized grass (${buildings.length} building(s), room ${size.w}x${size.d})`);
  } catch(e){ bad('mainStreet auto-sizes to fit all castles', e); }

  // 30. Regression: a stale saved mainStreet size (e.g. a manual resize from
  //     back when there was less content -- mainStreet is fully procedural, so
  //     nothing else ever corrects it) must never be allowed to shrink the
  //     ground below what current content actually needs and strand a castle
  //     outside it. A LARGER manual override should still be honored.
  try {
    const before = await app12.page.evaluate(() => window.__threeTestEdit.roomSize('mainStreet'));
    await app12.page.evaluate(() => window.__threeTestEdit.resize('mainStreet', { w: 5, d: 5, h: 7 }));
    await app12.page.waitForTimeout(100);
    const afterShrink = await app12.page.evaluate(() => window.__threeTestEdit.roomSize('mainStreet'));
    assert(afterShrink.w >= before.w && afterShrink.d >= before.d,
      `a stale small override should not shrink mainStreet below its computed minimum: before=${JSON.stringify(before)} after=${JSON.stringify(afterShrink)}`);

    const bigger = { w: before.w + 200, d: before.d + 200, h: 7 };
    await app12.page.evaluate((g) => window.__threeTestEdit.resize('mainStreet', g), bigger);
    await app12.page.waitForTimeout(100);
    const afterGrow = await app12.page.evaluate(() => window.__threeTestEdit.roomSize('mainStreet'));
    assert(afterGrow.w === bigger.w && afterGrow.d === bigger.d,
      `a larger manual override should still be honored, got ${JSON.stringify(afterGrow)} vs requested ${JSON.stringify(bigger)}`);
    ok('a stale/small saved mainStreet size can never shrink below the auto-computed minimum, but a larger one still wins');
  } catch(e){ bad('mainStreet size override guard', e); }
} finally {
  await app12.close();
}

// --- Phase M: tint-at-assign-time (per-placement recolor of an assigned
//     asset, distinct from the flat "Color…" replace) ---
const app13 = await launchApp();
try {
  await seedBackup(app13.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' }],
    assets: [{ id: 'wallpaper-1', type: 'surface',
      image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      repeatPerMeter: 0.5 }],
  });
  await app13.page.click('.line-row');
  await app13.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await app13.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await app13.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await app13.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await app13.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await app13.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await app13.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await app13.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await app13.page.waitForTimeout(400);
  await app13.page.evaluate(() => window.__threeTestEdit.toggle());
  await app13.page.waitForTimeout(60);

  // 31. Assigning a real asset to a wall: no "Tint…" tile yet (nothing to
  //     recolor), the wall gets the real texture (hasMap, no forced color).
  try {
    await app13.page.evaluate(() => window.__threeTestEdit.target({ kind: 'wall', wall: 'north' }));
    await app13.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    const tintTileBefore = await app13.page.evaluate(() => !!document.querySelector('#pickerGrid .asset-card-tint'));
    assert(!tintTileBefore, 'Tint… tile should not show before any real asset is assigned');

    await app13.page.evaluate(() => {
      const card = [...document.querySelectorAll('#pickerGrid .asset-card')]
        .find(c => !c.classList.contains('asset-card-color') && c.textContent.includes('wallpaper-1'));
      card.click();
    });
    await app13.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
    await app13.page.waitForTimeout(150);

    const afterAssign = await app13.page.evaluate(() =>
      window.__threeTestEdit.meshes().filter(m => m.kind === 'wall' && m.wall === 'north'));
    assert(afterAssign.length && afterAssign.every(m => m.hasMap && m.color === '#ffffff'),
      `wall should show the real (untinted) texture after assigning the asset: ${JSON.stringify(afterAssign)}`);
    ok('assigning a real asset shows its texture untinted, with no Tint… option yet');
  } catch(e){ bad('tint: assign real asset baseline', e); }

  // 32. Reopening now offers "Tint…"; picking a color recolors the wall
  //     WHILE KEEPING the real texture (hasMap stays true -- the key
  //     difference from "Color…", which replaces the texture outright).
  let tintHex;
  try {
    await app13.page.evaluate(() => window.__threeTestEdit.target({ kind: 'wall', wall: 'north' }));
    await app13.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await app13.page.click('#pickerGrid .asset-card-tint');
    await app13.page.waitForSelector('#colorSwatchPickerOverlay', { state: 'visible', timeout: 5000 });
    tintHex = await app13.page.evaluate(() => document.querySelector('#colorSwatchPickerOverlay .color-swatch').dataset.hex);
    await app13.page.click('#colorSwatchPickerOverlay .color-swatch');
    await app13.page.waitForSelector('#colorSwatchPickerOverlay', { state: 'hidden', timeout: 5000 });
    await app13.page.waitForTimeout(150);

    const tinted = await app13.page.evaluate(() =>
      window.__threeTestEdit.meshes().filter(m => m.kind === 'wall' && m.wall === 'north'));
    assert(tinted.length && tinted.every(m => m.hasMap && m.color === tintHex),
      `wall should keep its texture (hasMap) while showing the tint color ${tintHex}: ${JSON.stringify(tinted)}`);

    await app13.page.evaluate(() => window.__threeTestEdit.target({ kind: 'wall', wall: 'north' }));
    await app13.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    const tile = await app13.page.evaluate(() => {
      const el = document.querySelector('#pickerGrid .asset-card-tint');
      return el ? { current: el.classList.contains('asset-card-current'), text: el.textContent } : null;
    });
    assert(tile && tile.current && tile.text.includes(tintHex), `tint tile not marked current: ${JSON.stringify(tile)}`);
    ok(`Tint… recolors the wall (${tintHex}) while keeping its real texture (hasMap)`);
  } catch(e){ bad('tint: apply tint keeps the texture', e); }

  // 33. Removing the tint reverts to the asset's own (untinted) look while
  //     the real asset stays assigned -- distinct from "Remove" on the
  //     surface itself, which would drop back to the procedural default.
  try {
    await app13.page.evaluate(() => document.querySelector('#pickerGrid .asset-card-tint').click());
    await app13.page.waitForSelector('#colorSwatchPickerOverlay', { state: 'visible', timeout: 5000 });
    await app13.page.click('#cswRemoveBtn');
    await app13.page.waitForSelector('#colorSwatchPickerOverlay', { state: 'hidden', timeout: 5000 });
    await app13.page.waitForTimeout(150);

    const untinted = await app13.page.evaluate(() =>
      window.__threeTestEdit.meshes().filter(m => m.kind === 'wall' && m.wall === 'north'));
    assert(untinted.length && untinted.every(m => m.hasMap && m.color === '#ffffff'),
      `removing the tint should keep the real texture but drop the recolor: ${JSON.stringify(untinted)}`);
    ok('removing the tint reverts to the untinted asset while keeping it assigned');
  } catch(e){ bad('tint: remove tint keeps the asset', e); }
} finally {
  await app13.close();
}

// --- Phase N: multi-line ("MultiPV") engine eval saved per node ---
// Stockfish has no vendored mock in this harness (same class of gap as
// cm-chessboard), so a live search can't be driven end-to-end here -- the
// save/display logic this feature added is plain data manipulation,
// independent of the engine, and fully testable via __evalTestHooks against
// a throwaway pref bag instead of real PREFS/IDB.
const app14 = await launchApp();
try {
  await seedBackup(app14.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  });
  await app14.page.click('.line-row');   // sets CURRENT_LINE, needed by refreshEvalSpan's color-coding
  await app14.page.waitForSelector('.data-row', { timeout: 10000 });

  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // 34. A single-line (MultiPV=1) analysis saves eval only -- no evalLines.
  let single;
  try {
    single = await app14.page.evaluate((fen) =>
      window.__evalTestHooks.recordEvalIfDeeper(fen, 20, { type: 'cp', value: 50 }, ['d2d4', 'd7d5'], null, null),
      startFen);
    assert(single.eval && single.eval.depth === 20 && single.eval.pv.includes('d4'),
      `expected a depth-20 eval mentioning d4, got ${JSON.stringify(single.eval)}`);
    assert(!single.evalLines, `single-line analysis should not create evalLines: ${JSON.stringify(single.evalLines)}`);
    ok('single-line analysis saves eval only (no evalLines)');
  } catch(e){ bad('eval: single-line save', e); }

  // 35. A multi-line (MultiPV=3) analysis saves eval (the best line, as
  //     before) AND evalLines (every rank, each with its own score/PV).
  let multi;
  try {
    const lines = {
      1: { score: { type: 'cp', value: 60 }, depth: 22, pv: ['d2d4', 'd7d5'] },
      2: { score: { type: 'cp', value: 40 }, depth: 22, pv: ['e2e4', 'e7e5'] },
      3: { score: { type: 'cp', value: 10 }, depth: 22, pv: ['c2c4', 'c7c5'] },
    };
    multi = await app14.page.evaluate(({ fen, lines, prior }) =>
      window.__evalTestHooks.recordEvalIfDeeper(fen, 22, lines[1].score, lines[1].pv, lines, prior),
      { fen: startFen, lines, prior: single });
    assert(multi.eval.depth === 22, `expected the best line's depth 22, got ${multi.eval.depth}`);
    assert(multi.evalLines && multi.evalLines.length === 3, `expected 3 saved lines, got ${JSON.stringify(multi.evalLines)}`);
    assert(multi.evalLines[0].value === 60 && multi.evalLines[1].value === 40 && multi.evalLines[2].value === 10,
      `evalLines should keep rank order with each rank's own score: ${JSON.stringify(multi.evalLines)}`);
    assert(multi.evalLines[0].pv.includes('d4') && multi.evalLines[1].pv.includes('e4') && multi.evalLines[2].pv.includes('c4'),
      `each line's own PV should be preserved: ${JSON.stringify(multi.evalLines.map(l => l.pv))}`);
    ok('multi-line analysis saves every rank (eval = best, evalLines = all 3)');
  } catch(e){ bad('eval: multi-line save', e); }

  // 36. Depth-gating still applies to the whole set: a SHALLOWER re-analysis
  //     (even with a different multi-line result) must not overwrite anything.
  try {
    const shallowerLines = {
      1: { score: { type: 'cp', value: 5 }, depth: 18, pv: ['g1f3'] },
      2: { score: { type: 'cp', value: 1 }, depth: 18, pv: ['b1c3'] },
    };
    const afterShallow = await app14.page.evaluate(({ fen, lines, prior }) =>
      window.__evalTestHooks.recordEvalIfDeeper(fen, 18, lines[1].score, lines[1].pv, lines, prior),
      { fen: startFen, lines: shallowerLines, prior: multi });
    assert(JSON.stringify(afterShallow) === JSON.stringify(multi),
      `a shallower analysis should not change the saved eval/evalLines: before=${JSON.stringify(multi)} after=${JSON.stringify(afterShallow)}`);
    ok('a shallower re-analysis never overwrites a deeper saved eval/evalLines');
  } catch(e){ bad('eval: depth-gating', e); }

  // 37. Regression: a DEEPER but single-line (MultiPV=1) re-analysis must
  //     still update the best-line eval, but must NOT downgrade a
  //     previously-saved multi-line set down to nothing.
  try {
    const afterDeeper = await app14.page.evaluate(({ fen, prior }) =>
      window.__evalTestHooks.recordEvalIfDeeper(fen, 25, { type: 'cp', value: 65 }, ['d2d4', 'd7d5'], null, prior),
      { fen: startFen, prior: multi });
    assert(afterDeeper.eval.depth === 25, `expected the deeper single-line eval to win, got depth ${afterDeeper.eval.depth}`);
    assert(afterDeeper.evalLines && afterDeeper.evalLines.length === 3,
      `a deeper single-line re-analysis should not drop the previously-saved multi-line set: ${JSON.stringify(afterDeeper.evalLines)}`);
    ok('a deeper single-line re-analysis updates the best eval without downgrading a saved multi-line set');
  } catch(e){ bad('eval: single-line never downgrades evalLines', e); }

  // 38. Display: evalContinuationHtml renders one row per saved line (each
  //     with its own score badge) when evalLines exists, the original
  //     single-span format when it doesn't (unchanged for old saved evals),
  //     and "not available" when there's nothing to show.
  try {
    const multiHtml = await app14.page.evaluate((saved) =>
      window.__evalTestHooks.evalContinuationHtml(saved, []), multi);
    const rowCount = (multiHtml.match(/class="meta-pv-row"/g) || []).length;
    const scoreCount = (multiHtml.match(/class="meta-pv-score/g) || []).length;
    assert(rowCount === 3 && scoreCount === 3, `expected 3 line rows each with a score badge, got rows=${rowCount} scores=${scoreCount} in: ${multiHtml}`);

    const singleHtml = await app14.page.evaluate((saved) =>
      window.__evalTestHooks.evalContinuationHtml(saved, []), { eval: multi.eval });
    assert(!singleHtml.includes('meta-pv-row') && singleHtml.includes('class="meta-pv"'),
      `a single saved eval (no evalLines) should render the original single-span format, got: ${singleHtml}`);

    const emptyHtml = await app14.page.evaluate(() => window.__evalTestHooks.evalContinuationHtml({}, []));
    assert(emptyHtml.includes('not available'), `expected "not available" for a node with no saved eval, got: ${emptyHtml}`);
    ok('evalContinuationHtml renders all saved lines, falls back for a single eval, and handles none saved');
  } catch(e){ bad('eval: continuation display', e); }

  // 38b. Each rendered variation (both the multi-line rows and the single-eval
  //      span) gets its own "Import this variation" menu button, indexed so
  //      the click handler can re-fetch the right saved line -- but only when
  //      it actually carries a UCI PV to import from (a legacy pv-only eval,
  //      saved before pvUci existed, gets no button since there'd be nothing
  //      for the importer to replay).
  try {
    const multiHtml = await app14.page.evaluate((saved) =>
      window.__evalTestHooks.evalContinuationHtml(saved, []), multi);
    const idxs = [...multiHtml.matchAll(/data-pv-idx="(-?\d+)"/g)].map(m => m[0]);
    assert(idxs.length === 3, `expected an import menu button beside each of the 3 saved lines, got ${idxs.length} in: ${multiHtml}`);
    assert(multiHtml.includes('data-pv-idx="0"') && multiHtml.includes('data-pv-idx="1"') && multiHtml.includes('data-pv-idx="2"'),
      `expected menu buttons indexed 0/1/2 matching evalLines order, got: ${multiHtml}`);

    const singleHtml = await app14.page.evaluate((saved) =>
      window.__evalTestHooks.evalContinuationHtml(saved, []), { eval: multi.eval });
    assert((singleHtml.match(/meta-pv-menu/g) || []).length === 1 && singleHtml.includes('data-pv-idx="-1"'),
      `expected exactly one import menu button (idx -1) for the single-eval case, got: ${singleHtml}`);

    // legacy: an eval with a saved SAN pv but no pvUci (predates PV-UCI
    // storage) still displays via pvChipsFromSan, but must NOT offer an
    // import menu -- there's no UCI to replay.
    const legacyHtml = await app14.page.evaluate((saved) =>
      window.__evalTestHooks.evalContinuationHtml(saved, []),
      { eval: { type: 'cp', value: 10, depth: 20, pv: '1.d4 d5' } });
    assert(!legacyHtml.includes('meta-pv-menu'),
      `expected no import menu for a legacy eval with no pvUci, got: ${legacyHtml}`);
    ok('evalContinuationHtml offers an "Import this variation" menu per line, only when a UCI PV is available');
  } catch(e){ bad('eval: continuation import menu buttons', e); }
} finally {
  await app14.close();
}

// --- Phase O: Chessboard test setup fields (Number of Questions / Max Depth /
//     Opening Coverage) persist to localStorage and restore next time ---
const app15 = await launchApp();
try {
  await seedBackup(app15.page, {
    version: 6, user: 'tester',
    lines: [
      { id: 'L1', name: 'WhiteSys', color: 'white', openingMoves: ['d4'], prefs: [
        { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      ]},
      { id: 'L2', name: 'BlackSys', color: 'black', openingMoves: ['e4'], prefs: [
        { seq: ['e4'], reply: 'c5', isCastleRoot: true, castleName: 'Bravo', castleStreetNumber: 1 },
      ]},
    ],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'e4 c5 Nf3 d6', white: 'a', black: 'b', result: '*' },
    ],
  });
  await app15.page.click('.line-row');
  await app15.page.waitForSelector('.data-row', { timeout: 10000 });

  // 39. Whole-system coverage: saved/restored by lineId, a stable value that
  //     doesn't depend on castle indices at all.
  try {
    await app15.page.evaluate(() => {
      window.__oqTestHooks.setCastleOptionsForTest([]);
      document.getElementById('oqCoverageSelect').innerHTML += '<option value="L1">WhiteSys</option>';
      document.getElementById('oqCoverageSelect').value = 'L1';
    });
    const identity = await app15.page.evaluate(() => window.__oqTestHooks.coverageIdentity());
    assert(JSON.stringify(identity) === JSON.stringify({ lineId: 'L1' }), `expected {lineId:'L1'}, got ${JSON.stringify(identity)}`);

    await app15.page.evaluate((id) => {
      localStorage.setItem('oq_lastCoverage', JSON.stringify(id));
      localStorage.setItem('oq_lastQuestions', '7');
      localStorage.setItem('oq_lastMaxDepth', '12');
      // reset the form to prove restore actually changes it, not a no-op
      document.getElementById('oqCoverageSelect').value = '';
      document.getElementById('oqNumQuestions').value = '3';
      document.getElementById('oqMaxDepth').value = '5';
    }, identity);
    await app15.page.evaluate(() => window.__oqTestHooks.restoreSetupFields());
    const restored = await app15.page.evaluate(() => ({
      coverage: document.getElementById('oqCoverageSelect').value,
      n: document.getElementById('oqNumQuestions').value,
      depth: document.getElementById('oqMaxDepth').value,
    }));
    assert(restored.coverage === 'L1' && restored.n === '7' && restored.depth === '12',
      `expected restored {coverage:'L1',n:'7',depth:'12'}, got ${JSON.stringify(restored)}`);
    ok('Number of Questions / Max Depth / whole-system Coverage restore from localStorage');
  } catch(e){ bad('chessboard quiz setup: whole-system restore', e); }

  // 40. Regression: a saved castle coverage identity must still resolve
  //     correctly even if that castle's castle:N index has since shifted
  //     (new content populated ahead of it) -- proving the restore is keyed
  //     by stable identity {lineId,castleName}, not the raw select value.
  try {
    await app15.page.evaluate(() => {
      window.__oqTestHooks.setCastleOptionsForTest([
        { lineId: 'L1', castleName: 'Alpha' },
        { lineId: 'L2', castleName: 'Bravo' },
      ]);
      document.getElementById('oqCoverageSelect').value = 'castle:1';   // Bravo, at index 1
    });
    const identity = await app15.page.evaluate(() => window.__oqTestHooks.coverageIdentity());
    assert(JSON.stringify(identity) === JSON.stringify({ lineId: 'L2', castleName: 'Bravo' }),
      `expected {lineId:'L2',castleName:'Bravo'}, got ${JSON.stringify(identity)}`);
    await app15.page.evaluate((id) => localStorage.setItem('oq_lastCoverage', JSON.stringify(id)), identity);

    // simulate content added ahead of Bravo -- its index shifts from 1 to 2
    await app15.page.evaluate(() => {
      window.__oqTestHooks.setCastleOptionsForTest([
        { lineId: 'L0', castleName: 'Aardvark' },
        { lineId: 'L1', castleName: 'Alpha' },
        { lineId: 'L2', castleName: 'Bravo' },
      ]);
      document.getElementById('oqCoverageSelect').value = '';
    });
    await app15.page.evaluate(() => window.__oqTestHooks.restoreSetupFields());
    const restoredVal = await app15.page.evaluate(() => document.getElementById('oqCoverageSelect').value);
    assert(restoredVal === 'castle:2', `expected the shifted index castle:2 (Bravo), got ${restoredVal}`);
    ok('a saved castle coverage selection still resolves correctly after its castle:N index shifts');
  } catch(e){ bad('chessboard quiz setup: castle coverage survives index shift', e); }

  // 41. Sanity check against the real populate path (not just the synthetic
  //     hook above): restoring against actual populateCoverageOptgroups output.
  try {
    await app15.page.evaluate(() => window.__oqTestHooks.populateCoverage());
    const realIdx = await app15.page.evaluate(() => {
      const opts = [...document.getElementById('oqCoverageSelect').options];
      const castleOpt = opts.find(o => o.value.startsWith('castle:') && o.textContent.includes('Bravo'));
      return castleOpt ? castleOpt.value : null;
    });
    assert(realIdx, 'expected a real "↳ Bravo" castle option in the populated select');
    await app15.page.evaluate((val) => { document.getElementById('oqCoverageSelect').value = val; }, realIdx);
    const identity = await app15.page.evaluate(() => window.__oqTestHooks.coverageIdentity());
    assert(identity && identity.lineId === 'L2' && identity.castleName === 'Bravo',
      `expected the real Bravo castle's identity, got ${JSON.stringify(identity)}`);
    await app15.page.evaluate((id) => {
      localStorage.setItem('oq_lastCoverage', JSON.stringify(id));
      document.getElementById('oqCoverageSelect').value = '';
    }, identity);
    await app15.page.evaluate(() => window.__oqTestHooks.populateCoverage());   // repopulate fresh, like a real reopen
    await app15.page.evaluate(() => window.__oqTestHooks.restoreSetupFields());
    const restoredReal = await app15.page.evaluate(() => document.getElementById('oqCoverageSelect').value);
    assert(restoredReal === realIdx, `expected the real castle option ${realIdx} restored, got ${restoredReal}`);
    ok('restoring against the real populateCoverageOptgroups output selects the right castle again');
  } catch(e){ bad('chessboard quiz setup: real coverage populate/restore', e); }
} finally {
  await app15.close();
}

// --- Phase P: background analysis queue ("Add to Analysis List" / "Analysis
//     Queue") -- add/dedup, cancel, and the depth-gated direct-IDB-write save
//     path are plain data manipulation against real IDB (unlike the eval
//     feature above, no engine search is involved in any of this), so they're
//     fully testable via __aqTestHooks. Only the live engine.analyze() call
//     inside processAnalysisQueueLoop needs real Stockfish and stays outside
//     this harness's reach -- covered by manual verification instead. ---
const app16 = await launchApp();
try {
  await seedBackup(app16.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6','c4'], eval: { type:'cp', value:60, depth:20, pv:'1.d4 Nf6 2.c4' } },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4', white: 'a', black: 'b', result: '*' }],
  });
  await app16.page.click('.line-row');
  await app16.page.waitForSelector('.data-row', { timeout: 10000 });

  // 42. Adding a fresh node queues it with the requested depth/lines.
  try {
    await app16.page.evaluate(() => window.__aqTestHooks.addToAnalysisQueue('L1', ['d4'], 40, 4));
    const q = await app16.page.evaluate(() => window.__aqTestHooks.getQueue());
    assert(q.length === 1 && q[0].lineId === 'L1' && q[0].depth === 40 && q[0].multipv === 4,
      `expected one queued item depth=40 multipv=4, got ${JSON.stringify(q)}`);
    ok('adding a node queues it with the requested depth/lines');
  } catch(e){ bad('analysis queue: add', e); }

  // 43. Adding the SAME node again with a higher target tops the existing
  //     entry up in place rather than duplicating it.
  try {
    await app16.page.evaluate(() => window.__aqTestHooks.addToAnalysisQueue('L1', ['d4'], 45, 3));
    const q = await app16.page.evaluate(() => window.__aqTestHooks.getQueue());
    assert(q.length === 1, `expected the duplicate to be merged, not appended: ${JSON.stringify(q)}`);
    assert(q[0].depth === 45 && q[0].multipv === 4,
      `expected the higher of each target to win (depth 45, multipv 4), got ${JSON.stringify(q[0])}`);
    ok('re-adding a queued node tops up its target instead of duplicating it');
  } catch(e){ bad('analysis queue: dedup tops up target', e); }

  // 44. Adding a node already saved to at least the requested depth/lines is
  //     a silent no-op -- nothing new queued.
  try {
    await app16.page.evaluate(() => window.__aqTestHooks.addToAnalysisQueue('L1', ['d4','Nf6','c4'], 20, 1));
    const q = await app16.page.evaluate(() => window.__aqTestHooks.getQueue());
    assert(q.length === 1, `already-sufficiently-analyzed node should not be queued: ${JSON.stringify(q)}`);
    ok('a node already analyzed to the target depth/lines is not queued');
  } catch(e){ bad('analysis queue: no-op when already analyzed', e); }

  // 45. Cancelling removes the item, and it stays gone after a fresh reload
  //     from IDB (proving the cancel actually persisted, not just in-memory).
  try {
    const before = await app16.page.evaluate(() => window.__aqTestHooks.getQueue());
    await app16.page.evaluate((id) => window.__aqTestHooks.cancelAnalysisQueueItem(id), before[0].id);
    const afterCancel = await app16.page.evaluate(() => window.__aqTestHooks.getQueue());
    assert(afterCancel.length === 0, `expected the queue empty after cancel, got ${JSON.stringify(afterCancel)}`);
    await app16.page.evaluate(() => window.__aqTestHooks.refreshAnalysisQueue());
    const afterReload = await app16.page.evaluate(() => window.__aqTestHooks.getQueue());
    assert(afterReload.length === 0, `cancelled item reappeared after reload from IDB: ${JSON.stringify(afterReload)}`);
    ok('cancelling a queue item deletes it persistently');
  } catch(e){ bad('analysis queue: cancel', e); }

  // 46. seqToNotation numbers White moves, leaves Black moves bare.
  try {
    const label = await app16.page.evaluate(() => window.__aqTestHooks.seqToNotation(['d4','Nf6','c4']));
    assert(label === '1.d4 Nf6 2.c4', `expected "1.d4 Nf6 2.c4", got "${label}"`);
    ok('seqToNotation formats a move sequence with move numbers');
  } catch(e){ bad('analysis queue: seqToNotation', e); }

  // 47. saveAnalysisQueueResult: a fresh node with no saved eval writes both
  //     eval (best line) and evalLines (every rank).
  const fen = 'rnbqkbnr/ppp1pppp/5n2/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3';
  let firstSave;
  try {
    const result = { depth: 30, lines: {
      1: { score:{type:'cp',value:35}, depth:30, pv:['b1c3','g8f6'] },
      2: { score:{type:'cp',value:20}, depth:30, pv:['g1f3','e7e6'] },
    }};
    await app16.page.evaluate(({item,fen,result}) => window.__aqTestHooks.saveAnalysisQueueResult(item,fen,result),
      { item: { lineId:'L1', seq:['d4','Nf6','c4','e6'] }, fen, result });
    firstSave = await app16.page.evaluate((seq) => window.__aqTestHooks.getPref('L1', seq), ['d4','Nf6','c4','e6']);
    assert(firstSave?.eval?.depth === 30 && firstSave?.evalLines?.length === 2,
      `expected a depth-30 eval with 2 saved lines, got ${JSON.stringify(firstSave)}`);
    ok('saveAnalysisQueueResult saves eval + evalLines for a fresh node');
  } catch(e){ bad('analysis queue: save fresh result', e); }

  // 48. A SHALLOWER result with the SAME line count must not overwrite it.
  try {
    const shallower = { depth: 25, lines: {
      1: { score:{type:'cp',value:5}, depth:25, pv:['e2e4'] },
      2: { score:{type:'cp',value:1}, depth:25, pv:['c2c4'] },
    }};
    await app16.page.evaluate(({item,fen,result}) => window.__aqTestHooks.saveAnalysisQueueResult(item,fen,result),
      { item: { lineId:'L1', seq:['d4','Nf6','c4','e6'] }, fen, result: shallower });
    const after = await app16.page.evaluate((seq) => window.__aqTestHooks.getPref('L1', seq), ['d4','Nf6','c4','e6']);
    assert(after.eval.depth === 30, `a shallower result should not overwrite the depth-30 save, got depth ${after.eval.depth}`);
    ok('a shallower saveAnalysisQueueResult never overwrites a deeper saved eval');
  } catch(e){ bad('analysis queue: shallower save is a no-op', e); }

  // 49. SAME depth but MORE lines than before counts as an improvement (the
  //     refinement over recordEvalIfDeeper's plain depth-only gate).
  try {
    const sameDepthMoreLines = { depth: 30, lines: {
      1: { score:{type:'cp',value:35}, depth:30, pv:['b1c3','g8f6'] },
      2: { score:{type:'cp',value:20}, depth:30, pv:['g1f3','e7e6'] },
      3: { score:{type:'cp',value:15}, depth:30, pv:['e2e3','b8c6'] },
    }};
    await app16.page.evaluate(({item,fen,result}) => window.__aqTestHooks.saveAnalysisQueueResult(item,fen,result),
      { item: { lineId:'L1', seq:['d4','Nf6','c4','e6'] }, fen, result: sameDepthMoreLines });
    const after = await app16.page.evaluate((seq) => window.__aqTestHooks.getPref('L1', seq), ['d4','Nf6','c4','e6']);
    assert(after.evalLines.length === 3, `expected the same-depth-more-lines result to save 3 lines, got ${JSON.stringify(after.evalLines)}`);
    ok('same-depth-but-more-lines counts as an improvement and is saved');
  } catch(e){ bad('analysis queue: same-depth more-lines improves', e); }

  // 50. Move-table row marker: queuing a node shows the hourglass icon on its
  //     row; cancelling makes it disappear again.
  try {
    const iconVisible = () => app16.page.evaluate(() => {
      const icon = document.querySelector('tr.data-row[data-seq="d4,Nf6"] .aqQueuedIcon');
      return !!icon && icon.style.display !== 'none';
    });
    assert(!(await iconVisible()), 'expected no queue marker before queuing');

    await app16.page.evaluate(() => window.__aqTestHooks.addToAnalysisQueue('L1', ['d4','Nf6'], 40, 4));
    assert(await iconVisible(), 'expected the queue marker to appear on the row after queuing');

    const q = await app16.page.evaluate(() => window.__aqTestHooks.getQueue());
    const item = q.find(it => it.seq.join(',') === 'd4,Nf6');
    assert(item, 'expected the queued item to be findable in the queue');
    await app16.page.evaluate((id) => window.__aqTestHooks.cancelAnalysisQueueItem(id), item.id);
    assert(!(await iconVisible()), 'expected the queue marker to disappear after cancelling');
    ok('the move table shows/hides an hourglass marker as a node is queued/cancelled');
  } catch(e){ bad('analysis queue: row marker reflects queue state', e); }

  // 51. Analysis Queue modal shows the first few PV moves (not just the eval
  //     score), one row per rank, for whichever item is being processed.
  try {
    const item = { id: 'aq:test', lineId: 'L1', seq: ['d4','Nf6'], depth: 40, multipv: 2 };
    const progress = {
      depth: 32,
      lines: {
        1: { score: { type:'cp', value: 180 }, depth: 32, pv: ['c2c4','e7e6','b1c3','f8b4'] },
        2: { score: { type:'cp', value: 50 },  depth: 32, pv: ['g1f3','d7d5'] },
      },
    };
    const html = await app16.page.evaluate(({item,progress}) =>
      window.__aqTestHooks.aqProgressHtml(item, item, progress), { item, progress });
    assert(html.includes('processing — depth 32/40'), `expected the depth readout, got: ${html}`);
    const rowCount = (html.match(/class="meta-pv-row"/g) || []).length;
    assert(rowCount === 2, `expected one row per PV rank (2), got ${rowCount} in: ${html}`);
    assert(html.includes('+1.8'), `expected rank 1's eval score +1.8, got: ${html}`);
    assert(html.includes('2.c4') && html.includes('3.Nc3'), `expected the first few PV moves numbered, got: ${html}`);

    const queuedHtml = await app16.page.evaluate(({item}) =>
      window.__aqTestHooks.aqProgressHtml(item, null, null), { item });
    assert(queuedHtml.includes('aq-status-queued'), `expected the plain "queued" state when not the current item, got: ${queuedHtml}`);
    ok('the queue modal shows eval + the first few PV moves per rank for the item being processed');
  } catch(e){ bad('analysis queue: progress display shows PV moves', e); }
} finally {
  await app16.close();
}

// --- Phase Q: Manage Mnemonics with no system selected treats every
//     square+piece as "needed" (as if a hypothetical system used every move
//     mnemonic), so the missing counts and red/green coloring show up
//     globally instead of only when a real coverage scope is picked. ---
const app17 = await launchApp();
try {
  await seedBackup(app17.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    mnemonics: [
      { square: 'd4', pawn: 'dolphin', pawnImg: 'data:image/png;base64,iVBORw0KGgo=' },
    ],
  });
  // Manage Mnemonics is reachable straight from the home screen; no line is
  // opened here on purpose, so CURRENT_LINE stays null and the coverage
  // select defaults to "(none selected)" -- the exact case under test.
  await app17.page.evaluate(() => document.getElementById('menuMnemonics').click());
  await app17.page.waitForFunction(
    () => document.getElementById('mnemonicsOverlay').style.display === 'flex', { timeout: 15000 });

  // 51. With no system selected, the counts line reports all 384 (64 squares
  //     x 6 pieces) square+piece slots as "used" and surfaces the missing
  //     totals, exactly as if a hypothetical system used every mnemonic.
  try {
    const coverageVal = await app17.page.evaluate(() => document.getElementById('mnemonicsCoverageSelect').value);
    assert(coverageVal === '', `expected no coverage system selected, got "${coverageVal}"`);
    const countsText = await app17.page.evaluate(() => document.getElementById('mnemonicsCoverageCounts').textContent);
    assert(countsText.includes('384 used'), `expected "384 used" (64 squares x 6 pieces), got: "${countsText}"`);
    assert(/\d+ missing words/.test(countsText) && /\d+ missing images/.test(countsText),
      `expected missing words/images counts to be surfaced with no system selected, got: "${countsText}"`);
    ok('with no system selected, Manage Mnemonics shows counts as if every mnemonic slot were needed');
  } catch(e){ bad('mnemonics: no-selection counts treat everything as needed', e); }

  // 52. The one square+piece that IS fully filled in (d4 pawn: word+image)
  //     renders green (mnem-ok); an empty one (d4 knight) renders red
  //     (mnem-missing, "(none)" icon) instead of being blank as before.
  try {
    const classes = await app17.page.evaluate(() => {
      const sq = document.querySelector('.mnem-square[data-square="d4"]');
      return {
        pawnOk: !!sq.querySelector('.mnem-word.mnem-ok'),
        knightMissing: !!sq.querySelector('.mnem-icon-only.mnem-missing'),
      };
    });
    assert(classes.pawnOk, 'expected the filled-in d4 pawn mnemonic to render green (mnem-ok)');
    assert(classes.knightMissing, 'expected an unfilled d4 knight slot to render red (mnem-missing) instead of blank');
    ok('filled slots render green, unfilled ones render red, with no system selected');
  } catch(e){ bad('mnemonics: no-selection three-state coloring', e); }
} finally {
  await app17.close();
}

// --- Phase R: "Analyze All Children" now queues every child for background
//     analysis (same Depth/Lines modal as "Add to Analysis Queue") instead of
//     running an instant in-page search. ---
const app18 = await launchApp();
try {
  await seedBackup(app18.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
      { seq: ['d4','c4'], eval: { type:'cp', value:15, depth:25, pv:'1.d4 c4' } },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6', white: 'a', black: 'b', result: '*' },
    ],
  });
  await app18.page.click('.line-row');
  await app18.page.waitForSelector('.data-row', { timeout: 10000 });

  // 53. Clicking "Analyze All Children" opens the Add-to-Queue modal (Depth +
  //     Lines, titled with the child count) instead of starting a live search.
  try {
    // icon buttons have zero size (Font Awesome), so click via evaluate like
    // every other row-menu test in this suite.
    await app18.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await app18.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="analyzeChildren"]').click());
    const display = await app18.page.evaluate(() => document.getElementById('analysisAddOverlay').style.display);
    assert(display === 'flex', `expected the Add-to-Queue modal to open, got display="${display}"`);
    const title = await app18.page.evaluate(() => document.getElementById('analysisAddTitle').textContent);
    assert(title === 'Add 2 Children to Analysis Queue', `expected a child-count title, got "${title}"`);
    const depthVal = await app18.page.evaluate(() => document.getElementById('analysisAddDepth').value);
    const linesVal = await app18.page.evaluate(() => document.getElementById('analysisAddLines').value);
    assert(depthVal === '40' && linesVal === '4', `expected the usual defaults (40/4), got ${depthVal}/${linesVal}`);
    ok('"Analyze All Children" opens the Depth/Lines modal titled with the child count');
  } catch(e){ bad('analyze all children: opens queue modal', e); }

  // 54. Confirming queues every child (not an instant search); the move
  //     table's hourglass markers appear on all of them and one combined
  //     summary is logged (not one message per child overwriting the last).
  try {
    await app18.page.evaluate(() => document.getElementById('analysisAddGoBtn').click());
    await app18.page.waitForFunction(() => window.__aqTestHooks.getQueue().length === 2, { timeout: 5000 });
    const q = await app18.page.evaluate(() => window.__aqTestHooks.getQueue());
    const seqs = q.map(it => it.seq.join(',')).sort();
    assert(JSON.stringify(seqs) === JSON.stringify(['d4,Nf6,c4,e6','d4,Nf6,c4,g6']),
      `expected both children queued, got ${JSON.stringify(seqs)}`);
    assert(q.every(it => it.depth === 40 && it.multipv === 4), `expected the chosen depth/lines on both items, got ${JSON.stringify(q)}`);

    const markers = await app18.page.evaluate(() => {
      const vis = sel => { const i = document.querySelector(sel); return !!i && i.style.display !== 'none'; };
      return {
        e6: vis('tr.data-row[data-seq="d4,Nf6,c4,e6"] .aqQueuedIcon'),
        g6: vis('tr.data-row[data-seq="d4,Nf6,c4,g6"] .aqQueuedIcon'),
      };
    });
    assert(markers.e6 && markers.g6, `expected both children's row markers to show, got ${JSON.stringify(markers)}`);

    const progressText = await app18.page.evaluate(() => document.getElementById('progress').textContent);
    assert(progressText.includes('2 children') && progressText.includes('2 queued'),
      `expected a combined summary log, got "${progressText}"`);
    ok('"Analyze All Children" queues every child instead of running an instant search');
  } catch(e){ bad('analyze all children: queues every child', e); }

  // 55. addChildrenToAnalysisQueue's summary tallies added/topped-up/skipped
  //     separately: d5 is brand new (added), Nf6/c4/e6 is already queued from
  //     test 54 (topped-up), and d4,c4 is pre-seeded with a sufficient saved
  //     eval (depth 25/1 line, meeting the requested depth 20/multipv 1).
  try {
    await app18.page.evaluate(() =>
      window.__aqTestHooks.addChildrenToAnalysisQueue('L1',
        [['d4','d5'], ['d4','Nf6','c4','e6'], ['d4','c4']], 20, 1));
    const progressText = await app18.page.evaluate(() => document.getElementById('progress').textContent);
    assert(progressText.includes('3 children') && progressText.includes('1 queued') &&
      progressText.includes('1 target updated') && progressText.includes('1 already sufficient'),
      `expected a tallied summary (1 added, 1 topped-up, 1 skipped), got "${progressText}"`);
    ok('addChildrenToAnalysisQueue tallies added/topped-up/skipped into one summary line');
  } catch(e){ bad('analyze all children: bulk summary tallies results', e); }
} finally {
  await app18.close();
}

// --- Phase S: "Search for a Variation" -- a not-found result pops up a
//     clear "Variation not found" alert (in addition to the existing inline
//     modal text) instead of silently doing nothing, and never touches the
//     tree/focus state. ---
const app19 = await launchApp();
try {
  await seedBackup(app19.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
  });
  await app19.page.click('.line-row');
  await app19.page.waitForSelector('.data-row', { timeout: 10000 });

  // 56. A variation whose first move isn't even this system's opening pops
  //     up "Variation not found" (with the specific reason) and leaves the
  //     tree's focus state and DOM completely untouched.
  try {
    const treeHtmlBefore = await app19.page.evaluate(() => document.getElementById('tree').innerHTML);
    const unfocusVisibleBefore = await app19.page.evaluate(() => document.getElementById('unfocusBtn').style.display);

    await app19.page.evaluate(() => document.getElementById('menuSearchLine').click());
    await app19.page.waitForFunction(
      () => document.getElementById('searchLineOverlay').style.display === 'flex', { timeout: 5000 });
    await app19.page.fill('#searchLineInput', '1. e4 e5');

    let dialogMessage = null;
    app19.page.once('dialog', d => { dialogMessage = d.message(); });
    await app19.page.evaluate(() => document.getElementById('searchLineSaveBtn').click());
    await app19.page.waitForFunction(() => document.getElementById('searchLineError').textContent.length > 0, { timeout: 5000 });

    assert(dialogMessage && dialogMessage.startsWith('Variation not found'),
      `expected a "Variation not found" popup, got: ${JSON.stringify(dialogMessage)}`);
    assert(dialogMessage.includes('starts with 1. d4') && dialogMessage.includes('starts with 1. e4'),
      `expected the popup to explain the mismatch, got: ${dialogMessage}`);

    const overlayDisplay = await app19.page.evaluate(() => document.getElementById('searchLineOverlay').style.display);
    assert(overlayDisplay === 'flex', `expected the search modal to stay open for an easy retry, got display="${overlayDisplay}"`);

    const treeHtmlAfter = await app19.page.evaluate(() => document.getElementById('tree').innerHTML);
    const unfocusVisibleAfter = await app19.page.evaluate(() => document.getElementById('unfocusBtn').style.display);
    assert(treeHtmlAfter === treeHtmlBefore, 'expected the tree DOM to be completely untouched by a failed search');
    assert(unfocusVisibleAfter === unfocusVisibleBefore, 'expected focus state to be untouched by a failed search');
    ok('a not-found variation pops up a clear message and leaves the tree/focus state untouched');
  } catch(e){ bad('search variation: not-found pops up a message, tree untouched', e); }
} finally {
  await app19.close();
}

// --- Phase T: cancelling the CURRENTLY PROCESSING analysis-queue item must
//     stop its in-flight search immediately and move straight on to the next
//     item -- not stall the whole queue waiting for the abandoned search to
//     reach its full target depth on its own. No live Stockfish is available
//     in this harness, so engine.analyze()/stop() are monkey-patched with a
//     controllable fake (via __aqTestHooks.engine) that only resolves when
//     stop() is called, driving the real scheduler/cancel logic against it. ---
const app20 = await launchApp();
try {
  await seedBackup(app20.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  });
  await app20.page.click('.line-row');
  await app20.page.waitForSelector('.data-row', { timeout: 10000 });

  await app20.page.evaluate(() => {
    window.__aqFakeEngine = { pending: null, callCount: 0 };
    const { engine } = window.__aqTestHooks;
    engine.ready = true;
    engine.threads = 4;
    engine.analyze = () => {
      window.__aqFakeEngine.callCount++;
      // never resolves on its own -- only engine.stop() (below) resolves it,
      // exactly like a real search that's still short of its target depth.
      return new Promise(resolve => {
        window.__aqFakeEngine.pending = () =>
          resolve({ depth: 10, lines: { 1: { score: { type:'cp', value:5 }, depth:10, pv:['e2e4'] } } });
      });
    };
    engine.stop = () => {
      if(window.__aqFakeEngine.pending){
        const p = window.__aqFakeEngine.pending;
        window.__aqFakeEngine.pending = null;
        p();
      }
    };
  });

  // 57. Cancelling the item currently being searched stops that search right
  //     away (via engine.stop()) and the scheduler picks up the next queued
  //     item immediately, without waiting for an unrelated idle-transition event.
  try {
    await app20.page.evaluate(() => window.__aqTestHooks.addToAnalysisQueue('L1', ['d4','Nf6'], 40, 1));
    await app20.page.evaluate(() => window.__aqTestHooks.addToAnalysisQueue('L1', ['d4','d5'], 40, 1));
    await app20.page.evaluate(() => window.__aqTestHooks.maybeResumeAnalysisQueue());
    await app20.page.waitForFunction(() => window.__aqFakeEngine.callCount === 1, { timeout: 5000 });

    const firstItem = await app20.page.evaluate(() => window.__aqTestHooks.getCurrentItem());
    assert(firstItem && firstItem.seq.join(',') === 'd4,Nf6',
      `expected the first queued item (d4,Nf6) to start processing, got ${JSON.stringify(firstItem)}`);

    await app20.page.evaluate((id) => window.__aqTestHooks.cancelAnalysisQueueItem(id), firstItem.id);

    // if the fix works, the abandoned search is stopped and the second item
    // starts right away (a second engine.analyze() call); if the old bug is
    // back, callCount stays at 1 forever and this times out.
    await app20.page.waitForFunction(() => window.__aqFakeEngine.callCount === 2, { timeout: 5000 });
    const secondItem = await app20.page.evaluate(() => window.__aqTestHooks.getCurrentItem());
    assert(secondItem && secondItem.seq.join(',') === 'd4,d5',
      `expected the second queued item (d4,d5) to start processing next, got ${JSON.stringify(secondItem)}`);

    const q = await app20.page.evaluate(() => window.__aqTestHooks.getQueue());
    assert(q.length === 1 && q[0].seq.join(',') === 'd4,d5',
      `expected only the still-processing second item left in the queue, got ${JSON.stringify(q)}`);

    // let the second (still fake, still pending) search resolve too, so the
    // background loop doesn't leave a dangling pending promise behind it.
    await app20.page.evaluate(() => window.__aqTestHooks.engine.stop());

    ok('cancelling the currently-processing item stops it and the queue moves on to the next item immediately');
  } catch(e){ bad('analysis queue: cancelling the processing item does not stall the queue', e); }

  // 58. Live analysis takes precedence over the queue while it's running, but
  //     an explicit Stop hands the engine straight back to the queue (rather
  //     than leaving it stalled until something else happens to go idle --
  //     the originally-reported bug: stopping a live search never restarted
  //     the queue). One item ('d4,d5') is still queued from the previous
  //     test, left un-processed (aqProcessing is false, nothing has asked the
  //     scheduler to resume it since it was preempted).
  try {
    const callsBefore = await app20.page.evaluate(() => window.__aqFakeEngine.callCount);

    // simulating "live analysis started" must NOT by itself wake the queue --
    // only setEngineUI's own explicit triggers ('idle'/'stopped') do.
    await app20.page.evaluate(() => window.__aqTestHooks.setEngineUI('running'));
    await new Promise(r => setTimeout(r, 200));
    const callsWhileRunning = await app20.page.evaluate(() => window.__aqFakeEngine.callCount);
    assert(callsWhileRunning === callsBefore,
      `queue should stay put while live analysis is 'running' (calls ${callsBefore} -> ${callsWhileRunning})`);

    // now the user clicks Stop -- this is the fix under test.
    await app20.page.evaluate(() => window.__aqTestHooks.setEngineUI('stopped'));
    await app20.page.waitForFunction(
      (before) => window.__aqFakeEngine.callCount === before + 1, callsBefore, { timeout: 5000 });
    const resumedItem = await app20.page.evaluate(() => window.__aqTestHooks.getCurrentItem());
    assert(resumedItem && resumedItem.seq.join(',') === 'd4,d5',
      `expected the queue to resume the still-queued item after Stop, got ${JSON.stringify(resumedItem)}`);

    // let the fake search resolve so nothing dangles past this test.
    await app20.page.evaluate(() => window.__aqTestHooks.engine.stop());

    ok("stopping live analysis ('stopped') resumes the queue; 'running' alone does not");
  } catch(e){ bad('analysis queue resumes when live analysis is explicitly stopped', e); }
} finally {
  await app20.close();
}

// --- Phase U: move-pair VR billboards show the move number ("N."), flush
//     left and a third of the way up from the bottom of whichever quadrant
//     is White's move; the street-sign opening-move tile (always White's
//     move 1) gets the same badge. ---
const app21 = await launchApp();
try {
  await seedBackup(app21.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'London', color: 'white', openingMoves: ['d4'], prefs: [] }],
  });
  await openVR(app21.page);

  // 59. White's move (moveNumber set) gets the badge in ITS quadrant; Black's
  //     half (no moveNumber) never does -- checked both ways round
  //     (opponent-is-White and response-is-White) since the pair's two
  //     halves swap quadrants depending on which color the opponent is.
  try {
    const oppWhite = await app21.page.evaluate(() => window.__threeTestEdit.buildMnemPairInk({
      opponent: { to:'f3', piece:'knight', san:'Nf3', moveNumber: 5 },
      response: { to:'c6', piece:'knight', san:'Nc6' },
    }));
    assert(oppWhite.oppCorner === true, `expected the move-number badge in the opponent quadrant, got ${JSON.stringify(oppWhite)}`);
    assert(oppWhite.respCorner === false, `expected no badge in the response quadrant (Black, no moveNumber), got ${JSON.stringify(oppWhite)}`);

    const respWhite = await app21.page.evaluate(() => window.__threeTestEdit.buildMnemPairInk({
      opponent: { to:'c6', piece:'knight', san:'Nc6' },
      response: { to:'f3', piece:'knight', san:'Nf3', moveNumber: 6 },
    }));
    assert(respWhite.respCorner === true, `expected the move-number badge in the response quadrant, got ${JSON.stringify(respWhite)}`);
    assert(respWhite.oppCorner === false, `expected no badge in the opponent quadrant (Black, no moveNumber), got ${JSON.stringify(respWhite)}`);

    ok('the move-pair billboard shows "N." flush left, a third up from the bottom, in whichever quadrant is White\'s move');
  } catch(e){ bad('VR billboard: move-number badge in the correct quadrant', e); }

  // 60. The street-sign opening-move tile (a single-move tile, not a pair --
  //     e.g. "open-L1" for a White system's own first move) also shows its
  //     "1." badge, in the same flush-left, lower-third position/style as
  //     the pair badges.
  try {
    // 'dark' (the badge's black stroke), not 'white' -- the tile's own
    // background is already near-white, so a white-ink check can't tell
    // "the badge is here" from "this is just the tile's background".
    const hasInk = await app21.page.evaluate(() => window.__threeTestEdit.spriteHasWhiteInk('open-L1', 14, 300, 110, 70, 'dark'));
    assert(hasInk === true, `expected the opening-move tile to show a "1." badge, got ${hasInk}`);
    ok('the street-sign opening-move tile also shows the "1." move-number badge');
  } catch(e){ bad('VR billboard: opening-move tile shows move number', e); }
} finally {
  await app21.close();
}

// --- Phase V: Engine.analyze() must sync via isready/readyok after changing
//     the multi-threaded build's Threads option, before issuing the next
//     `go` -- changing Threads makes the WASM build respawn its pthread pool
//     in the background, and searching before that settles can wedge the
//     whole worker so it never responds to anything again. This was a real
//     bug: the background analysis queue's reduced ("low priority") thread
//     count was the first thing in the app to ever change Threads after
//     init, with no such sync, and could hang the engine on its very first
//     search. No live Stockfish is available in this harness, so
//     engine._send/_listener are faked to simulate the UCI handshake and
//     drive the real analyze() logic against it. ---
const app22 = await launchApp();
try {
  await seedBackup(app22.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  });
  await app22.page.click('.line-row');
  await app22.page.waitForSelector('.data-row', { timeout: 10000 });

  const setup = () => {
    const { engine } = window.__aqTestHooks;
    engine.multithreaded = true;
    engine.ready = true;
    engine.threads = 8;
    engine._currentThreads = 8;
    window.__engineFake = { sentCommands: [], isreadyPending: false, orderViolated: false };
    engine._send = (cmd) => {
      const f = window.__engineFake;
      f.sentCommands.push(cmd);
      if (cmd === 'isready') {
        f.isreadyPending = true;
        setTimeout(() => { f.isreadyPending = false; engine._listener?.('readyok'); }, 30);
      } else if (/^go /.test(cmd)) {
        if (f.isreadyPending) f.orderViolated = true;   // go sent while still waiting for readyok
        setTimeout(() => engine._listener?.('bestmove e2e4'), 10);
      } else if (cmd === 'stop') {
        setTimeout(() => engine._listener?.('bestmove e2e4'), 10);
      }
    };
  };
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // 61. Changing Threads (background queue's reduced count) syncs via
  //     isready/readyok before the next `go` -- `go` must never be sent while
  //     an isready reply is still pending.
  try {
    await app22.page.evaluate(setup);
    await app22.page.evaluate((fen) => window.__aqTestHooks.engine.analyze(fen, { multipv:1, depth:5, threads:4 }), START_FEN);
    const f = await app22.page.evaluate(() => window.__engineFake);
    assert(f.sentCommands.includes('isready'), `expected an isready sync after the Threads change, got: ${JSON.stringify(f.sentCommands)}`);
    assert(f.sentCommands.includes('setoption name Threads value 4'), `expected the reduced Threads value to be sent, got: ${JSON.stringify(f.sentCommands)}`);
    assert(f.orderViolated === false, `"go" was sent while still waiting for readyok -- the exact bug that could hang the engine`);
    const goIdx = f.sentCommands.findIndex(c => c.startsWith('go '));
    const readyIdx = f.sentCommands.indexOf('isready');
    assert(readyIdx !== -1 && readyIdx < goIdx, `expected isready before go, got: ${JSON.stringify(f.sentCommands)}`);
    ok('changing Threads syncs via isready/readyok before the next go command');
  } catch(e){ bad('engine: Threads change syncs before next search', e); }

  // 62. Calling analyze() again with the SAME (already-configured) thread
  //     count must NOT resend setoption/isready -- the common case (every
  //     caller except the background queue always asks for the full count)
  //     should never pay for this sync.
  try {
    await app22.page.evaluate(setup);
    await app22.page.evaluate((fen) => window.__aqTestHooks.engine.analyze(fen, { multipv:1, depth:5, threads:8 }), START_FEN);
    const f = await app22.page.evaluate(() => window.__engineFake);
    assert(!f.sentCommands.some(c => c.startsWith('setoption name Threads')), `expected no Threads change when already at that count, got: ${JSON.stringify(f.sentCommands)}`);
    assert(!f.sentCommands.includes('isready'), `expected no isready sync when Threads didn't change, got: ${JSON.stringify(f.sentCommands)}`);
    ok('analyze() skips the Threads/isready sync when the thread count is already correct');
  } catch(e){ bad('engine: no redundant Threads sync when unchanged', e); }
} finally {
  await app22.close();
}

// --- Phase W: room-info modal (click a graph node) -- move-number badge on
//     the exit rows' thumbnails, and the exits list scrolls independently so
//     a long list of replies can never push the Close button off-screen. ---
const appW1 = await launchApp();
try {
  await seedBackup(appW1.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
    mnemonics: [{ square: 'f6', knight: 'foxtrot', knightImg: 'data:image/png;base64,iVBORw0KGgo=' }],
  });
  await appW1.page.click('.line-row');
  await appW1.page.waitForSelector('.data-row', { timeout: 10000 });
  await appW1.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
  await appW1.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });

  // 63. A White-repertoire room's exit rows are the OPPONENT's (Black's)
  //     replies -- never numbered, same rule plyLabel already applies to
  //     Black moves everywhere else. This room's Nf6 exit has an image.
  try {
    const rootFen = await appW1.page.evaluate(() => {
      const c = new Chess(); c.move('d4', { sloppy: true });
      return c.fen();
    });
    const opened = await appW1.page.evaluate((fen) => window.__graphTestHooks.openRoomInfo(fen), rootFen);
    assert(opened, 'could not open room info for the d4 room');
    await appW1.page.waitForFunction(() => document.getElementById('roomInfoOverlay').style.display === 'flex', { timeout: 5000 });
    const hasImg = await appW1.page.evaluate(() => !!document.querySelector('#roomInfoExits .room-info-img'));
    const hasBadge = await appW1.page.evaluate(() => !!document.querySelector('#roomInfoExits .room-info-num'));
    assert(hasImg, 'expected the Nf6 exit row to render its mnemonic image (test setup issue if not)');
    assert(hasBadge === false, `a Black-move exit row should never show the "N." badge, but found one`);
    ok('room-info exits: a White line\'s Black-move replies never show the move-number badge');
  } catch(e){ bad('room-info exits: no badge on Black-move replies', e); }
} finally {
  await appW1.close();
}

const appW2 = await launchApp();
try {
  // a Black-repertoire room's exit rows are the OPPONENT's (White's) replies
  // -- these DO get numbered. Twenty distinct replies from 1...e5, so the
  // exits list is long enough to actually overflow a constrained modal.
  const whiteReplies = ['Nf3','Nc3','Bc4','Bb5','d4','f4','c3','d3','Qh5','Qf3',
                         'Ne2','Na3','Nh3','g3','g4','h3','h4','a3','a4','b3'];
  const games = whiteReplies.map((m, i) => ({ id: `g${i}`, moves: `e4 e5 ${m} Nc6`, white: 'a', black: 'b', result: '*' }));
  await seedBackup(appW2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L2', name: 'Black Test', color: 'black', openingMoves: ['e4'], prefs: [
      { seq: ['e4'], reply: 'e5' },
    ]}],
    games,
    mnemonics: [{ square: 'f3', knight: 'foxtrot', knightImg: 'data:image/png;base64,iVBORw0KGgo=' }],
  });
  await appW2.page.click('.line-row');
  await appW2.page.waitForSelector('.data-row', { timeout: 10000 });
  await appW2.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
  await appW2.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });

  let roomFen;
  try {
    roomFen = await appW2.page.evaluate(() => {
      const c = new Chess(); c.move('e4', { sloppy: true }); c.move('e5', { sloppy: true });
      return c.fen();
    });
    const opened = await appW2.page.evaluate((fen) => window.__graphTestHooks.openRoomInfo(fen), roomFen);
    assert(opened, 'could not open room info for the e4 e5 room');
    await appW2.page.waitForFunction(() => document.getElementById('roomInfoOverlay').style.display === 'flex', { timeout: 5000 });

    // 64. White's reply (2.Nf3, the one with an image) shows a "2." badge
    //     glued to its thumbnail.
    const badgeText = await appW2.page.evaluate(() => {
      const el = document.querySelector('#roomInfoExits .room-info-num');
      return el ? el.textContent : null;
    });
    assert(badgeText === '2.', `expected a "2." badge on the White reply, got ${JSON.stringify(badgeText)}`);
    ok('room-info exits: a Black line\'s White-move replies show the "N." badge on the thumbnail');
  } catch(e){ bad('room-info exits: numbered badge on White-move replies', e); }

  // 65. Twenty exit rows overflow the constrained modal -- the exits list
  //     scrolls independently (overflow-y) and the Close button stays fully
  //     on-screen instead of being pushed past the viewport (the originally-
  //     reported bug: an unconstrained modal could grow past the fold,
  //     leaving no way to close it without scrolling the whole page).
  try {
    const layout = await appW2.page.evaluate(() => {
      const exits = document.getElementById('roomInfoExits');
      const closeBtn = document.getElementById('roomInfoCloseBtn');
      const r = closeBtn.getBoundingClientRect();
      return {
        overflowY: getComputedStyle(exits).overflowY,
        overflowing: exits.scrollHeight > exits.clientHeight,
        closeTop: r.top, closeBottom: r.bottom, innerHeight: window.innerHeight,
      };
    });
    assert(layout.overflowY === 'auto' || layout.overflowY === 'scroll',
      `expected the exits list to be independently scrollable, got overflow-y=${layout.overflowY}`);
    assert(layout.overflowing,
      `expected 20 exit rows to overflow the constrained exits list (test setup issue if not): ${JSON.stringify(layout)}`);
    assert(layout.closeTop >= 0 && layout.closeBottom <= layout.innerHeight,
      `Close button was pushed outside the viewport: ${JSON.stringify(layout)}`);
    ok('room-info modal: a long exits list scrolls independently, keeping the Close button on-screen');
  } catch(e){ bad('room-info modal: exits list scrolls, Close button stays visible', e); }
} finally {
  await appW2.close();
}

// --- Phase X: door skin oversizing -- every door renders slightly larger
//     than its opening (hides a non-rectangular asset's transparent margin
//     from showing the wall behind it), and a per-asset "extra oversize %"
//     adds on top of that baseline. ---
const appX = await launchApp();
try {
  // the entry branches (e6 / g6) so it's a real junction with a rendered door --
  // a single reply collapses into a doorless "corridor" room (an internal link,
  // no separate door mesh), same reason Phase C's nested-castle test branches.
  await seedBackup(appX.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6 Nc3 Bg7', white: 'a', black: 'b', result: '*' },
    ],
    assets: [
      { id: 'door-plain', type: 'door', image: 'data:image/png;base64,iVBORw0KGgo=' },
      { id: 'door-columns', type: 'door', image: 'data:image/png;base64,iVBORw0KGgo=', oversizePct: 20 },
    ],
  });
  await appX.page.click('.line-row');
  await appX.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await appX.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await appX.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await appX.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await appX.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await appX.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await appX.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await appX.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await appX.page.waitForTimeout(400);

  const DOOR_W = 2.2, DOOR_H = 2.6;

  // 66. A plain door skin (no oversizePct) still renders larger than the
  //     opening -- the 3% baseline applied to every door.
  try {
    const roomKey = await appX.page.evaluate(() => window.__threeTestEdit.room());
    const assigned = await appX.page.evaluate(
      ({ rk, id }) => window.__threeTestEdit.setAllDoorAssets(rk, id), { rk: roomKey, id: 'door-plain' });
    assert(assigned, 'setAllDoorAssets could not find a door in the entry room (test setup issue if not)');
    await appX.page.waitForTimeout(300);
    const w = DOOR_W * 1.03, h = DOOR_H * 1.03;
    const found = await appX.page.evaluate(({ w, h }) => {
      const m = window.__threeTestEdit.meshes().find(m =>
        m.type === 'PlaneGeometry' && Math.abs(m.params.width - w) < 0.01 && Math.abs(m.params.height - h) < 0.01);
      return !!m;
    }, { w, h });
    assert(found, `expected a door panel at the 3% baseline size (${w.toFixed(3)} x ${h.toFixed(3)}), none found`);
    ok('a plain (perfectly-rectangular) door skin still renders at the 3% baseline oversize');
  } catch(e){ bad('door skin: baseline oversize applied by default', e); }

  // 67. A door skin with a per-asset oversizePct adds on top of the baseline.
  try {
    const roomKey = await appX.page.evaluate(() => window.__threeTestEdit.room());
    await appX.page.evaluate(
      ({ rk, id }) => window.__threeTestEdit.setAllDoorAssets(rk, id), { rk: roomKey, id: 'door-columns' });
    await appX.page.waitForTimeout(300);
    const w = DOOR_W * 1.23, h = DOOR_H * 1.23;   // 3% baseline + 20% asset override
    const found = await appX.page.evaluate(({ w, h }) => {
      const m = window.__threeTestEdit.meshes().find(m =>
        m.type === 'PlaneGeometry' && Math.abs(m.params.width - w) < 0.01 && Math.abs(m.params.height - h) < 0.01);
      return !!m;
    }, { w, h });
    assert(found, `expected a door panel oversized by baseline+20% (${w.toFixed(3)} x ${h.toFixed(3)}), none found`);
    ok('a door skin with a per-asset oversize % adds on top of the baseline');
  } catch(e){ bad('door skin: per-asset oversize adds to baseline', e); }

  // 77. The door skin panel sits ~1cm proud of the wall's own face (not
  //     coplanar with it) -- avoids z-fighting with the wall material where
  //     an oversized/non-rectangular skin's edges would otherwise overlap
  //     solid wall at the exact same depth, which read as the door being
  //     "sunk into" the wall.
  try {
    const roomKey = await appX.page.evaluate(() => window.__threeTestEdit.room());
    const size = await appX.page.evaluate((rk) => window.__threeTestEdit.roomSize(rk), roomKey);
    const doorPanel = await appX.page.evaluate(() => {
      const m = window.__threeTestEdit.meshes().find(m => m.kind === 'door-panel');
      return m ? { x: m.x, y: m.y, z: m.z, wall: m.wall } : null;
    });
    assert(doorPanel, 'expected to find a door panel mesh (test setup issue if not)');
    // wallSpan's "fixed" is the wall's CENTERLINE, not its visible face -- the
    // face is WALL_THICK/2 further out (matches threeVR.js's own WALL_THICK).
    const WALL_THICK = 0.25;
    const centerlineFor = { north: -size.d/2, south: size.d/2, west: -size.w/2, east: size.w/2 }[doorPanel.wall];
    const faceFor = centerlineFor + { north: 1, south: -1, west: 1, east: -1 }[doorPanel.wall] * (WALL_THICK/2);
    const along = (doorPanel.wall === 'north' || doorPanel.wall === 'south') ? doorPanel.z : doorPanel.x;
    const offset = (doorPanel.wall === 'north' || doorPanel.wall === 'west') ? along - faceFor : faceFor - along;
    assert(Math.abs(offset - 0.01) < 0.001,
      `expected the door panel ~1cm proud of the wall's visible face (${doorPanel.wall}), got offset ${offset.toFixed(4)} (raw mesh z/x ${along.toFixed(4)}, wall face ${faceFor.toFixed(4)})`);
    ok('door skin panel sits 1cm proud of the wall\'s visible face, not buried inside its thickness');
  } catch(e){ bad('door skin: forward offset off the wall face', e); }

  // 98. Regression: a large per-asset oversize must NOT widen the wall's own
  //     cut opening (the gap two solid wall segments leave for the door) --
  //     only the cosmetic skin panel grows. Confirmed by checking the actual
  //     solid wall segment meshes flanking the door still meet at the fixed
  //     DOOR_W/DOOR_H boundary regardless of a huge oversizePct.
  try {
    const roomKey = await appX.page.evaluate(() => window.__threeTestEdit.room());
    await appX.page.evaluate(
      ({ rk, id }) => window.__threeTestEdit.setAllDoorAssets(rk, id), { rk: roomKey, id: 'door-columns' });   // 20% oversizePct
    await appX.page.waitForTimeout(300);
    // the wall's own opening half-width is baked into every solid segment/
    // lintel box via the constant DOOR_W (2.2), completely independent of
    // any asset's oversizePct -- so a BoxGeometry wall segment whose width
    // or depth is exactly DOOR_W confirms the cut is still at the fixed
    // size, not the 20%-oversized 2.64 a widened-opening regression would
    // produce instead.
    const fixedWidthWallBox = await appX.page.evaluate((w) => {
      const m = window.__threeTestEdit.meshes().find(m => m.kind === 'wall' && m.type === 'BoxGeometry' &&
        (Math.abs(m.params.width - w) < 0.01 || Math.abs(m.params.depth - w) < 0.01));
      return !!m;
    }, DOOR_W);
    assert(fixedWidthWallBox, `expected a solid wall/lintel box still cut at the fixed DOOR_W (${DOOR_W}) even with a 20% oversized skin assigned`);
    ok('door skin oversize does not widen the wall\'s own cut opening, only the cosmetic panel');
  } catch(e){ bad('door skin: oversize does not affect the wall opening', e); }

  // 99. Regression: the door panel's material must be transparent -- without
  //     it, three.js ignores the PNG's alpha channel and paints whatever RGB
  //     sits in "transparent" pixels (often black) as solid opaque color.
  //     Since oversize scales the WHOLE plane up, that black margin would
  //     grow right along with it -- exactly the reported symptom ("black
  //     artifacts coming off the sides" as the oversize % increases).
  try {
    const roomKey = await appX.page.evaluate(() => window.__threeTestEdit.room());
    const doorPanel = await appX.page.evaluate(() => {
      const m = window.__threeTestEdit.meshes().find(m => m.kind === 'door-panel');
      return m ? { transparent: m.transparent } : null;
    });
    assert(doorPanel, 'expected to find a door panel mesh (test setup issue if not)');
    assert(doorPanel.transparent === true,
      'expected the door panel material to be transparent, so an oversized non-rectangular skin\'s alpha margin is honored instead of rendering as opaque black');
    ok('door skin panel material is transparent (honors the PNG\'s alpha channel instead of rendering it as black)');
  } catch(e){ bad('door skin: panel material is transparent', e); }
} finally {
  await appX.close();
}

// --- Phase Y: "memorized" room toggle (VR toolbar icon) -- hidden outside
//     real castle rooms, persisted to IDB per room, survives a full reload. ---
const appY = await launchApp();
try {
  const keys = await appY.page.evaluate(() => {
    const pk = mv => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_'); };
    return { alpha: pk(['d4','Nf6','c4']) };
  });
  await seedBackup(appY.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
  });
  await openVR(appY.page);

  // 68. mainStreet has no chess position -- the memorized icon is hidden there
  //     (same gate the board-position icon already uses).
  try {
    const style = await appY.page.evaluate(() => window.__threeTestEdit.memBtnStyle());
    assert(style && style.display === 'none', `expected the memorized icon hidden on mainStreet, got ${JSON.stringify(style)}`);
    ok('memorized icon is hidden outside real castle rooms (mainStreet)');
  } catch(e){ bad('memorized icon hidden on mainStreet', e); }

  // 69. Toggling in a real castle room shows/persists the flag and restyles
  //     the icon; toggling again clears it.
  try {
    await appY.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.alpha);
    await appY.page.waitForTimeout(200);
    const styleBefore = await appY.page.evaluate(() => window.__threeTestEdit.memBtnStyle());
    assert(styleBefore && styleBefore.display !== 'none', 'expected the memorized icon visible in a real castle room');
    const before = await appY.page.evaluate(() => window.__threeTestEdit.memorized());
    assert(!before, `expected the room to start unmemorized, got ${JSON.stringify(before)}`);

    await appY.page.evaluate(() => window.__threeTestEdit.toggleMemorized());
    const after = await appY.page.evaluate(() => window.__threeTestEdit.memorized());
    assert(after, 'expected the room to be memorized after toggling');
    const styleOn = await appY.page.evaluate(() => window.__threeTestEdit.memBtnStyle());
    assert(styleOn.background !== styleBefore.background, "expected the icon's background to change once memorized");

    await appY.page.evaluate(() => window.__threeTestEdit.toggleMemorized());
    const cleared = await appY.page.evaluate(() => window.__threeTestEdit.memorized());
    assert(!cleared, `expected toggling again to clear it, got ${JSON.stringify(cleared)}`);
    ok('memorized toggle sets/clears per room and restyles the icon');
  } catch(e){ bad('memorized toggle sets/clears per room', e); }

  // 70. Marking a room memorized round-trips through real IndexedDB and
  //     survives a full page reload (not just the in-memory MEMORIZED map).
  try {
    await appY.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.alpha);
    await appY.page.waitForTimeout(200);
    await appY.page.evaluate(() => window.__threeTestEdit.toggleMemorized());
    assert(await appY.page.evaluate(() => window.__threeTestEdit.memorized()), 'setup: room not memorized before reload');

    await appY.page.reload({ waitUntil: 'domcontentloaded' });
    await appY.page.waitForFunction(() => {
      const el = document.getElementById('buildStamp');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    await openVR(appY.page);
    await appY.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.alpha);
    await appY.page.waitForTimeout(200);
    const survived = await appY.page.evaluate(() => window.__threeTestEdit.memorized());
    assert(survived, `expected the memorized flag to survive a reload, got ${JSON.stringify(survived)}`);
    ok('memorized flag persists in IndexedDB and survives a full reload');
  } catch(e){ bad('memorized flag survives reload (real IDB round-trip)', e); }
} finally {
  await appY.close();
}

// --- Phase Z: "memorized" rooms (Phase 2) get a 🧠 label glyph in the
//     network digraph (mirroring the VR toolbar's fa-brain icon), and the
//     thick green border is reserved for "all done" -- memorized AND fully
//     decorated -- so it reads at a glance even too zoomed out for glyphs. ---
const appZ = await launchApp();
try {
  await seedBackup(appZ.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4', white: 'a', black: 'b', result: '*' }],
  });
  await appZ.page.click('.line-row');
  await appZ.page.waitForSelector('.data-row', { timeout: 10000 });
  await appZ.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
  await appZ.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });

  const roomFen = await appZ.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return c.fen();
  });
  const hasClass = (fen, cls) => appZ.page.evaluate(({ fen, cls }) => {
    const n = window.__graphTestHooks.cy().nodes().filter(x => x.data('fen') === fen);
    return n.nonempty() ? n.hasClass(cls) : null;
  }, { fen, cls });

  // 71. No glyph or "all done" border by default.
  try {
    const label = await appZ.page.evaluate((fen) => window.__graphTestHooks.labelOf(fen), roomFen);
    assert(!/🧠/.test(label || ''), `expected no memorized glyph by default, got ${JSON.stringify(label)}`);
    assert(await hasClass(roomFen, 'all-done') === false, 'expected no "all done" border by default');
    ok('a graph node has no memorized glyph or "all done" border by default');
  } catch(e){ bad('graph: no memorized glyph/border by default', e); }

  // 72. Marking the room memorized ALONE (same IDB key the VR toolbar toggle
  //     writes) shows the 🧠 glyph but NOT the "all done" border -- decorated
  //     is still false.
  try {
    const roomKey = await appZ.page.evaluate((fen) => window.__graphTestHooks.roomKeyOf(fen), roomFen);
    assert(roomKey, `expected the room to resolve a VR room key, got ${JSON.stringify(roomKey)}`);
    await appZ.page.evaluate((rk) => window.__graphTestHooks.setMemorized(rk, true), roomKey);
    await appZ.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
    await appZ.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });
    const label = await appZ.page.evaluate((fen) => window.__graphTestHooks.labelOf(fen), roomFen);
    assert(/🧠/.test(label || ''), `expected the memorized glyph after marking + reopening the graph, got ${JSON.stringify(label)}`);
    assert(await hasClass(roomFen, 'all-done') === false,
      'expected NO "all done" border for memorized-only (not also decorated)');
    ok('a memorized-only room shows the 🧠 glyph, not the "all done" border');
  } catch(e){ bad('graph: memorized glyph reflects a marked room, no border alone', e); }

  // 73. Also marking it decorated flips on the "all done" border (both
  //     glyphs still show alongside it).
  try {
    const roomKey = await appZ.page.evaluate((fen) => window.__graphTestHooks.roomKeyOf(fen), roomFen);
    await appZ.page.evaluate((rk) => window.__graphTestHooks.setDecorated(rk, true), roomKey);
    await appZ.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
    await appZ.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });
    const label = await appZ.page.evaluate((fen) => window.__graphTestHooks.labelOf(fen), roomFen);
    assert(/🧠/.test(label || '') && /🎨/.test(label || ''),
      `expected both glyphs once memorized AND decorated, got ${JSON.stringify(label)}`);
    assert(await hasClass(roomFen, 'all-done') === true,
      'expected the "all done" border once the room is both memorized and decorated');
    ok('a room that is both memorized and decorated shows the "all done" border plus both glyphs');
  } catch(e){ bad('graph: "all done" border once both memorized and decorated', e); }
} finally {
  await appZ.close();
}

// --- Phase AA: "only test memorized rooms" (Phase 3) -- a castle-scoped quiz
//     session filters candidates down to only replies whose resulting room is
//     marked memorized; off, it's a pure passthrough. ---
const appAA = await launchApp();
try {
  const keys = await appAA.page.evaluate(() => {
    const pk = mv => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_'); };
    return { e6Room: pk(['d4','Nf6','c4','e6','Nc3']), g6Room: pk(['d4','Nf6','c4','g6','Nc3']) };
  });
  await seedBackup(appAA.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6 Nc3 Bg7', white: 'a', black: 'b', result: '*' },
    ],
  });
  // mark only the e6 branch's room memorized, via the same IDB key the VR
  // toolbar toggle writes (setMeta is a bare global, same as getMeta elsewhere).
  await appAA.page.evaluate((k) => setMeta('threeMemorizedRooms', JSON.stringify({ [k]: Date.now() })), keys.e6Room);

  await appAA.page.click('.line-row');
  await appAA.page.waitForSelector('.data-row', { timeout: 10000 });
  await appAA.page.evaluate(() => window.__oqTestHooks.populateCoverage());
  const castleVal = await appAA.page.evaluate(() => {
    const opt = [...document.getElementById('oqCoverageSelect').options]
      .find(o => o.value.startsWith('castle:') && o.textContent.includes('Alpha'));
    return opt ? opt.value : null;
  });
  assert(castleVal, 'expected a real "↳ Alpha" castle option in the populated select (test setup issue if not)');

  // 73. Starting a castle-scoped session with the checkbox on threads
  //     castleName/onlyMemorized/memorizedRooms onto OQ correctly.
  try {
    const err = await appAA.page.evaluate((val) => window.__oqTestHooks.startSession(val, 5, 10, true), castleVal);
    assert(err === null, `startSession should succeed, got error: ${err}`);
    const oq = await appAA.page.evaluate(() => window.__oqTestHooks.getOQ());
    assert(oq.castleName === 'Alpha', `expected OQ.castleName 'Alpha', got ${JSON.stringify(oq.castleName)}`);
    assert(oq.onlyMemorized === true, `expected OQ.onlyMemorized true, got ${oq.onlyMemorized}`);
    assert(oq.memorizedRooms && oq.memorizedRooms[keys.e6Room], `expected OQ.memorizedRooms to contain the e6 room, got ${JSON.stringify(oq.memorizedRooms)}`);
    ok('starting a session with "only memorized" checked loads castleName + the memorized-rooms map onto OQ');
  } catch(e){ bad('oqStartSession: castleName/onlyMemorized/memorizedRooms', e); }

  // 74. roomMemorized reflects exactly the one seeded room.
  try {
    const r = await appAA.page.evaluate(() => ({
      e6: window.__oqTestHooks.roomMemorized(['d4','Nf6','c4','e6','Nc3']),
      g6: window.__oqTestHooks.roomMemorized(['d4','Nf6','c4','g6','Nc3']),
    }));
    assert(r.e6 === true, `expected the e6 room to read as memorized, got ${r.e6}`);
    assert(r.g6 === false, `expected the g6 room to read as NOT memorized, got ${r.g6}`);
    ok('oqRoomMemorized reflects exactly the rooms marked in threeMemorizedRooms');
  } catch(e){ bad('oqRoomMemorized', e); }

  // 75. memorizedFilter narrows candidates to only the memorized branch, at
  //     the castle root (the real call shape oqAfterCorrect uses).
  try {
    const filtered = await appAA.page.evaluate(() =>
      window.__oqTestHooks.memorizedFilter(['d4','Nf6','c4'], ['e6','g6']));
    assert(JSON.stringify(filtered) === JSON.stringify(['e6']), `expected only ['e6'], got ${JSON.stringify(filtered)}`);
    ok('memorizedFilter narrows candidates to only the branch leading to a memorized room');
  } catch(e){ bad('oqMemorizedFilter narrows to memorized branch', e); }

  // 76. With the checkbox off, the filter is a pure passthrough -- existing
  //     (pre-feature) behavior is unchanged byte-for-byte.
  try {
    await appAA.page.evaluate(() => window.__oqTestHooks.setOQ({ onlyMemorized: false }));
    const passthrough = await appAA.page.evaluate(() =>
      window.__oqTestHooks.memorizedFilter(['d4','Nf6','c4'], ['e6','g6']));
    assert(JSON.stringify(passthrough) === JSON.stringify(['e6','g6']), `expected an unfiltered passthrough, got ${JSON.stringify(passthrough)}`);
    ok('memorizedFilter is a no-op passthrough when "only memorized" is unchecked');
  } catch(e){ bad('oqMemorizedFilter passthrough when off', e); }
} finally {
  await appAA.close();
}

// --- Phase AB: crop/erase image editor -- brush erase (freehand round
//     eraser, size slider) for cleaning up artifacts flood-fill can't reach. ---
const appAB = await launchApp();
try {
  // a synthetic, fully-opaque 100x100 red square -- no file upload needed,
  // the crop tool is driven directly via __cropTestHooks.open().
  const srcUrl = await appAB.page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 100; c.height = 100;
    const cx = c.getContext('2d');
    cx.fillStyle = '#ff0000';
    cx.fillRect(0, 0, 100, 100);
    return c.toDataURL('image/png');
  });
  const alphaProbe = async (dataUrl, points) => appAB.page.evaluate(async ({ dataUrl, points }) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    const id = cx.getImageData(0, 0, c.width, c.height).data;
    return { w: c.width, h: c.height, alphas: points.map(([x, y]) => id[(y * c.width + x) * 4 + 3]) };
  }, { dataUrl, points });

  // 77. Clicking (a zero-length drag) with the brush erases a circle of the
  //     slider's diameter, centered on the cursor, leaving everything outside
  //     that radius untouched.
  try {
    await appAB.page.evaluate((url) => window.__cropTestHooks.open(url), srcUrl);
    await appAB.page.waitForFunction(() => {
      const img = document.getElementById('cropImg');
      return img && img.naturalWidth > 0 && document.getElementById('cropOverlay').style.display === 'flex';
    }, { timeout: 5000 });
    await appAB.page.evaluate(() => document.getElementById('cropBrushBtn').click());
    assert(await appAB.page.evaluate(() => document.getElementById('cropBrushCanvas').style.display === 'block'),
      'expected the brush canvas visible after entering brush mode');

    // default slider is 30px diameter (15px radius) in natural pixels; stamp
    // a single click at the natural point (50,50).
    await appAB.page.evaluate(() => {
      const wrap = document.getElementById('cropWrap');
      const r = wrap.getBoundingClientRect();
      const clientX = r.left + (50/100) * r.width, clientY = r.top + (50/100) * r.height;
      wrap.dispatchEvent(new PointerEvent('pointerdown', { clientX, clientY, buttons: 1, bubbles: true }));
      wrap.dispatchEvent(new PointerEvent('pointerup', { clientX, clientY, bubbles: true }));
    });
    await appAB.page.evaluate(() => document.getElementById('cropSaveBtn').click());
    const result = await appAB.page.evaluate(() => window.__cropTestHooks.result());
    assert(typeof result === 'string' && result.startsWith('data:image/png'), `expected a saved PNG data-URL, got ${JSON.stringify(result)}`);

    const probe = await alphaProbe(result, [[50,50], [50,62], [50,70], [5,5]]);
    assert(probe.w === 100 && probe.h === 100, `expected the image to stay 100x100 (no accidental crop), got ${probe.w}x${probe.h}`);
    const [center, within, outside, corner] = probe.alphas;
    assert(center === 0, `expected the click center fully erased (alpha 0), got ${center}`);
    assert(within === 0, `expected a point 12px from center (inside the 15px radius) erased, got alpha ${within}`);
    assert(outside === 255, `expected a point 20px from center (outside the 15px radius) untouched, got alpha ${outside}`);
    assert(corner === 255, `expected the far corner untouched, got alpha ${corner}`);
    ok('brush erase: a click punches a transparent circle of the slider\'s diameter, nothing more');
  } catch(e){ bad('crop editor: brush erase punches the correct-radius circle', e); }

  // 78b. Regression: erasing must be visible AS you drag, not only after
  //      committing (Crop/Save). The still-unmodified <img> sits directly
  //      behind the brush canvas -- a punched hole in the canvas used to just
  //      reveal the SAME un-erased pixel from the img underneath, so nothing
  //      appeared to happen until commitBrushCanvas() later updated the img
  //      itself. The fix hides the img for the duration of brush mode so a
  //      hole reveals the checkered stage backdrop live instead.
  try {
    await appAB.page.evaluate((url) => window.__cropTestHooks.open(url), srcUrl);
    await appAB.page.waitForFunction(() => {
      const img = document.getElementById('cropImg');
      return img && img.naturalWidth > 0 && document.getElementById('cropOverlay').style.display === 'flex';
    }, { timeout: 5000 });
    const beforeBrush = await appAB.page.evaluate(() => document.getElementById('cropImg').style.visibility);
    await appAB.page.evaluate(() => document.getElementById('cropBrushBtn').click());
    const duringBrush = await appAB.page.evaluate(() => document.getElementById('cropImg').style.visibility);
    await appAB.page.evaluate(() => document.getElementById('cropBrushBtn').click());   // toggle back off
    const afterBrush = await appAB.page.evaluate(() => document.getElementById('cropImg').style.visibility);
    assert(beforeBrush !== 'hidden', `expected the image visible before entering brush mode, got visibility=${beforeBrush}`);
    assert(duringBrush === 'hidden', `expected the image hidden WHILE brush mode is active (so a hole shows the checkered backdrop, not the stale image), got visibility=${duringBrush}`);
    assert(afterBrush !== 'hidden', `expected the image visible again after leaving brush mode, got visibility=${afterBrush}`);
    ok('brush erase gives live visual feedback: the stale image is hidden behind the canvas while brushing');
    await appAB.page.evaluate(() => document.getElementById('cropCancelBtn').click());
    await appAB.page.evaluate(() => window.__cropTestHooks.result());
  } catch(e){ bad('crop editor: brush erase shows live feedback while dragging', e); }

  // 78. The round cursor indicator tracks the pointer and is sized to the
  //     CURRENT slider value (scaled to display pixels), so the user can see
  //     the brush's real footprint before clicking.
  try {
    await appAB.page.evaluate((url) => window.__cropTestHooks.open(url), srcUrl);
    await appAB.page.waitForFunction(() => {
      const img = document.getElementById('cropImg');
      return img && img.naturalWidth > 0 && document.getElementById('cropOverlay').style.display === 'flex';
    }, { timeout: 5000 });
    await appAB.page.evaluate(() => document.getElementById('cropBrushBtn').click());
    await appAB.page.evaluate(() => { document.getElementById('cropBrushSizeInput').value = '60'; document.getElementById('cropBrushSizeInput').dispatchEvent(new Event('input')); });
    const cursor = await appAB.page.evaluate(() => {
      const wrap = document.getElementById('cropWrap');
      const r = wrap.getBoundingClientRect();
      const clientX = r.left + (50/100) * r.width, clientY = r.top + (50/100) * r.height;
      wrap.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY, buttons: 0, bubbles: true }));
      const c = document.getElementById('cropBrushCursor');
      const expectedDia = 60 * (r.width / 100);
      return { display: c.style.display, w: parseFloat(c.style.width), h: parseFloat(c.style.height), expectedDia, sizeLabel: document.getElementById('cropBrushSizeVal').textContent };
    });
    assert(cursor.display === 'block', `expected the cursor indicator visible on hover, got display=${cursor.display}`);
    assert(Math.abs(cursor.w - cursor.expectedDia) < 0.5 && Math.abs(cursor.h - cursor.expectedDia) < 0.5,
      `expected the cursor sized to the 60px slider value (${cursor.expectedDia.toFixed(1)} display px), got ${cursor.w}x${cursor.h}`);
    assert(cursor.sizeLabel === '60px', `expected the size readout to show "60px", got ${JSON.stringify(cursor.sizeLabel)}`);
    ok('brush erase: round cursor indicator tracks the pointer, sized to the current slider value');
    await appAB.page.evaluate(() => document.getElementById('cropCancelBtn').click());
    await appAB.page.evaluate(() => window.__cropTestHooks.result());   // let the cancelled promise settle
  } catch(e){ bad('crop editor: brush cursor size follows the slider', e); }

  // 79. Brush and bucket (flood-fill) erase are mutually exclusive tools --
  //     turning one on turns the other off.
  try {
    await appAB.page.evaluate((url) => window.__cropTestHooks.open(url), srcUrl);
    await appAB.page.waitForFunction(() => {
      const img = document.getElementById('cropImg');
      return img && img.naturalWidth > 0 && document.getElementById('cropOverlay').style.display === 'flex';
    }, { timeout: 5000 });
    await appAB.page.evaluate(() => document.getElementById('cropBrushBtn').click());
    assert(await appAB.page.evaluate(() => document.getElementById('cropBrushCanvas').style.display === 'block'),
      'expected brush mode on after clicking Brush erase');
    await appAB.page.evaluate(() => document.getElementById('cropEraseBtn').click());
    const state = await appAB.page.evaluate(() => ({
      brushCanvasOn: document.getElementById('cropBrushCanvas').style.display === 'block',
      eraseToolsOn: document.getElementById('cropEraseTools').style.display === 'inline-flex',
    }));
    assert(state.brushCanvasOn === false, 'expected brush mode to turn off when Erase BG (bucket) is turned on');
    assert(state.eraseToolsOn === true, 'expected Erase BG (bucket) mode to be on');
    ok('brush erase and bucket (flood-fill) erase are mutually exclusive');
    await appAB.page.evaluate(() => document.getElementById('cropCancelBtn').click());
    await appAB.page.evaluate(() => window.__cropTestHooks.result());
  } catch(e){ bad('crop editor: brush and bucket erase are mutually exclusive', e); }
} finally {
  await appAB.close();
}

// --- Phase AC: "fully decorated" room flag -- computed on the edit-mode-on ->
//     off transition (E key / Esc / toolbar pencil): every move-object slot
//     has a real asset AND every forward door's target room is named. ---
const appAC = await launchApp();
try {
  // a single (non-branching) reply chain collapses into ONE corridor room
  // with 2 LEFT wall move-object slots (obj-L1/obj-L2) and no forward door
  // (its own next reply, Qe7, is unbuilt) -- isolates the slot-fill half of
  // the check from the door-naming half.
  await seedBackup(appAC.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Bd2' },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Bd2 Qe7', white: 'a', black: 'b', result: '*' }],
    assets: [{ id: 'testProp1', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w: 0.3, h: 0.3, d: 0.3 } }],
  });
  await openVR(appAC.page);
  const roomKey = await appAC.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  });
  await appAC.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
  await appAC.page.waitForTimeout(300);
  const slotIds = await appAC.page.evaluate((k) => window.__threeTestEdit.moveObjectSlotIds(k), roomKey);
  const leftSlots = slotIds.filter(id => id !== 'obj-C1');
  const exitEditMode = async (page) => {
    await page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode ON
    await page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode OFF -> evaluateDecorated fires
  };

  // 80. Both slots unfilled, no forward door -> not decorated on edit-exit.
  try {
    assert(leftSlots.length === 2, `test setup issue: expected 2 non-center move-object slots, got ${JSON.stringify(slotIds)}`);
    await exitEditMode(appAC.page);
    const dec = await appAC.page.evaluate(() => window.__threeTestEdit.decorated());
    assert(!dec, `expected the room NOT decorated with both slots empty, got ${JSON.stringify(dec)}`);
    ok('fully-decorated: a room with unfilled move-object slots is not decorated on edit-mode exit');
  } catch(e){ bad('decorated: false with unfilled slots', e); }

  // 81. Filling only ONE of two slots still isn't fully decorated.
  try {
    await appAC.page.evaluate(({ rk, sid, aid }) => window.__threeTestEdit.setSlotAsset(rk, sid, aid),
      { rk: roomKey, sid: leftSlots[0], aid: 'testProp1' });
    await exitEditMode(appAC.page);
    const dec = await appAC.page.evaluate(() => window.__threeTestEdit.decorated());
    assert(!dec, `expected the room NOT decorated with 1 of 2 slots filled, got ${JSON.stringify(dec)}`);
    ok('fully-decorated: partially-filled slots still read as not decorated');
  } catch(e){ bad('decorated: false with partially filled slots', e); }

  // 82. Filling the SECOND slot too flips it to decorated.
  try {
    await appAC.page.evaluate(({ rk, sid, aid }) => window.__threeTestEdit.setSlotAsset(rk, sid, aid),
      { rk: roomKey, sid: leftSlots[1], aid: 'testProp1' });
    await exitEditMode(appAC.page);
    const dec = await appAC.page.evaluate(() => window.__threeTestEdit.decorated());
    assert(dec, `expected the room decorated once every slot has an asset, got ${JSON.stringify(dec)}`);
    ok('fully-decorated: flips true once every move-object slot has a real asset');
  } catch(e){ bad('decorated: true once every slot is filled', e); }

  // 83. Persists to IndexedDB and survives a full reload (not just the
  //     in-memory DECORATED map) -- same rigor as the memorized-flag test.
  try {
    assert(await appAC.page.evaluate(() => window.__threeTestEdit.decorated()), 'setup: room not decorated before reload');
    await appAC.page.reload({ waitUntil: 'domcontentloaded' });
    await appAC.page.waitForFunction(() => {
      const el = document.getElementById('buildStamp');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    await openVR(appAC.page);
    await appAC.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
    await appAC.page.waitForTimeout(200);
    const survived = await appAC.page.evaluate(() => window.__threeTestEdit.decorated());
    assert(survived, `expected the decorated flag to survive a reload, got ${JSON.stringify(survived)}`);
    ok('fully-decorated flag persists in IndexedDB and survives a full reload');
  } catch(e){ bad('decorated flag survives reload (real IDB round-trip)', e); }
} finally {
  await appAC.close();
}

// --- Phase AD: "fully decorated" -- the door-naming half of the check
//     (only for a door whose target is NOT empty/locked -- see isRoomEmpty
//     and the locked-doors feature), and the vacuous-true case. ---
const appAD = await launchApp();
try {
  // root has two forward doors: 'e6' leads to a room with its OWN branch
  // (Bb4/Be7 -- 2 replies, so it's NOT empty and its door is an ordinary,
  // not locked, door -- naming IS required for root's decoration); 'g6'
  // leads to a genuine dead end (EMPTY -- see Phase AH) whose door is
  // LOCKED, so naming its target must NOT be required.
  await seedBackup(appAD.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Bd2' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Be7'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Bd2', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 e6 Nc3 Be7 e4', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 Nf6 c4 g6 Nc3 Bg7', white: 'a', black: 'b', result: '*' },
    ],
  });
  await openVR(appAD.page);
  const keyFor = (moves) => appAD.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  }, moves);
  const root = await keyFor(['d4','Nf6','c4']);
  const e6Room = await keyFor(['d4','Nf6','c4','e6','Nc3']);   // NOT empty -- naming required
  const g6Room = await keyFor(['d4','Nf6','c4','g6','Nc3']);   // EMPTY/locked -- naming NOT required
  await appAD.page.evaluate((k) => window.__threeTestEdit.enter(k), root);
  await appAD.page.waitForTimeout(300);
  const exitEditMode = async () => {
    await appAD.page.evaluate(() => window.__threeTestEdit.toggle());
    await appAD.page.evaluate(() => window.__threeTestEdit.toggle());
  };

  // 84. Neither forward door's target is named -> not decorated (e6Room, the
  //     non-empty one, still needs it).
  try {
    await exitEditMode();
    const dec = await appAD.page.evaluate(() => window.__threeTestEdit.decorated());
    assert(!dec, `expected the root room NOT decorated with both door targets unnamed, got ${JSON.stringify(dec)}`);
    ok('fully-decorated: unnamed forward door targets keep a room undecorated');
  } catch(e){ bad('decorated: false with unnamed door targets', e); }

  // 85. Naming ONLY the non-empty door's target (e6Room) -- and deliberately
  //     leaving the locked door's target (g6Room) unnamed -- already flips
  //     the room to decorated. This is the key differentiator: without the
  //     locked-target exemption, g6Room's missing name would still block it.
  try {
    await appAD.page.evaluate(({ k, n }) => window.__threeTestEdit.setRoomName(k, n), { k: e6Room, n: 'E6 room' });
    await exitEditMode();
    const dec = await appAD.page.evaluate(() => window.__threeTestEdit.decorated());
    assert(dec, `expected the root room decorated once the non-empty door's target is named, even with the locked door's (empty) target still unnamed, got ${JSON.stringify(dec)}`);
    ok('fully-decorated: naming the non-empty door\'s target is enough; a locked door\'s target is exempt from naming');
  } catch(e){ bad('decorated: true once the required target is named, locked target exempt', e); }

  // 86. Naming the locked door's target too (g6Room) doesn't change anything
  //     -- still decorated, confirming its name was never load-bearing.
  try {
    await appAD.page.evaluate(({ k, n }) => window.__threeTestEdit.setRoomName(k, n), { k: g6Room, n: 'G6 room' });
    await exitEditMode();
    const dec = await appAD.page.evaluate(() => window.__threeTestEdit.decorated());
    assert(dec, `expected the root room to remain decorated after also naming the locked door's target, got ${JSON.stringify(dec)}`);
    ok('fully-decorated: also naming a locked door\'s target is harmless (never required)');
  } catch(e){ bad('decorated: still true after also naming the locked target', e); }

  // 87. A room with nothing to decorate (no slots but its own center pair,
  //     no built forward doors -- its own next reply is unbuilt) is
  //     vacuously fully decorated by default.
  try {
    await appAD.page.evaluate((k) => window.__threeTestEdit.enter(k), g6Room);
    await appAD.page.waitForTimeout(300);
    await exitEditMode();
    const dec = await appAD.page.evaluate(() => window.__threeTestEdit.decorated());
    assert(dec, `expected a room with nothing left to decorate to be vacuously decorated, got ${JSON.stringify(dec)}`);
    ok('fully-decorated: a room with no slots and no forward doors is vacuously decorated');
  } catch(e){ bad('decorated: vacuously true with nothing to decorate', e); }
} finally {
  await appAD.close();
}

// --- Phase AE: "fully decorated" rooms get a 🎨 glyph on their digraph node
//     label, mirroring the memorized-room border (Phase Z). ---
const appAE = await launchApp();
try {
  await seedBackup(appAE.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
  });
  await appAE.page.click('.line-row');
  await appAE.page.waitForSelector('.data-row', { timeout: 10000 });
  await appAE.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
  await appAE.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });
  const roomFen = await appAE.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return c.fen();
  });

  // 88. No glyph by default.
  try {
    const label = await appAE.page.evaluate((fen) => window.__graphTestHooks.labelOf(fen), roomFen);
    assert(!/🎨/.test(label || ''), `expected no decorated glyph by default, got ${JSON.stringify(label)}`);
    ok('a graph node label has no decorated glyph by default');
  } catch(e){ bad('graph: no decorated glyph by default', e); }

  // 89. Marking the room decorated (same IDB key evaluateDecorated writes)
  //     and reopening the graph shows the glyph in the node's label.
  try {
    const roomKey = await appAE.page.evaluate((fen) => window.__graphTestHooks.roomKeyOf(fen), roomFen);
    assert(roomKey, `expected the room to resolve a VR room key, got ${JSON.stringify(roomKey)}`);
    await appAE.page.evaluate((rk) => window.__graphTestHooks.setDecorated(rk, true), roomKey);
    await appAE.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
    await appAE.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });
    const label = await appAE.page.evaluate((fen) => window.__graphTestHooks.labelOf(fen), roomFen);
    assert(/🎨/.test(label || ''), `expected the decorated glyph after marking + reopening the graph, got ${JSON.stringify(label)}`);
    ok('a decorated room shows the 🎨 glyph on its graph node label after reopening');
  } catch(e){ bad('graph: decorated glyph reflects a marked room', e); }
} finally {
  await appAE.close();
}

// --- Phase AF: "Jump to VR" from the room-info modal (click a digraph node,
//     then jump straight into that room in the VR walk). ---
const appAF = await launchApp();
try {
  await seedBackup(appAF.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
  });
  await appAF.page.click('.line-row');
  await appAF.page.waitForSelector('.data-row', { timeout: 10000 });
  await appAF.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
  await appAF.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });
  const fens = await appAF.page.evaluate(() => {
    const c1 = new Chess(); for(const m of ['d4']) c1.move(m, { sloppy: true });
    const c2 = new Chess(); for(const m of ['d4','Nf6','c4']) c2.move(m, { sloppy: true });
    return { preCastle: c1.fen(), room: c2.fen() };
  });

  // 90. A node with no owning castle (nothing built yet at that position) has
  //     no roomKey, so the Jump button stays hidden -- there's no VR room to
  //     jump to.
  try {
    await appAF.page.evaluate((fen) => window.__graphTestHooks.openRoomInfo(fen), fens.preCastle);
    await appAF.page.waitForSelector('#roomInfoOverlay', { state: 'visible', timeout: 5000 });
    const display = await appAF.page.evaluate(() => document.getElementById('roomInfoJumpBtn').style.display);
    assert(display === 'none', `expected the Jump button hidden for a node with no roomKey, got display=${JSON.stringify(display)}`);
    ok('room-info modal: Jump to VR is hidden for a node with no owning castle room');
    await appAF.page.evaluate(() => document.getElementById('roomInfoCloseBtn').click());
  } catch(e){ bad('room-info modal: Jump to VR hidden without a roomKey', e); }

  // 91. Clicking Jump with VR closed (re)builds the main world and lands
  //     directly in the target room, closing the room-info modal.
  try {
    await appAF.page.evaluate((fen) => window.__graphTestHooks.openRoomInfo(fen), fens.room);
    await appAF.page.waitForSelector('#roomInfoOverlay', { state: 'visible', timeout: 5000 });
    const display = await appAF.page.evaluate(() => document.getElementById('roomInfoJumpBtn').style.display);
    assert(display !== 'none', `expected the Jump button visible for a real castle room, got display=${JSON.stringify(display)}`);
    await appAF.page.evaluate(() => document.getElementById('roomInfoJumpBtn').click());
    await appAF.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
    const roomKey = await appAF.page.evaluate((fen) => window.__graphTestHooks.roomKeyOf(fen), fens.room);
    const state = await appAF.page.evaluate(() => ({
      room: window.__threeTestEdit.room(),
      overlay: document.getElementById('roomInfoOverlay').style.display,
    }));
    assert(state.room === roomKey, `expected to land directly in the target room, got ${state.room} (wanted ${roomKey})`);
    assert(state.overlay === 'none', 'expected the room-info modal to close after jumping');
    ok('room-info modal: "Jump to VR" with VR closed builds the world and lands in the target room');
  } catch(e){ bad('room-info modal: Jump to VR with VR closed', e); }

  // 92. With VR already open (fast path via jumpToRoom, no rebuild), jumping
  //     from a room-info modal opened UNDERNEATH the still-open VR overlay
  //     lands in the target room instantly.
  try {
    // step 91 left VR open in the target room -- walk back out to Main Street
    // first so this is a real jump, not a no-op re-entry into the same room.
    await appAF.page.evaluate(() => window.__threeTestEdit.enter('mainStreet'));
    await appAF.page.waitForTimeout(100);
    await appAF.page.evaluate((fen) => window.__graphTestHooks.openRoomInfo(fen), fens.room);
    await appAF.page.waitForSelector('#roomInfoOverlay', { state: 'visible', timeout: 5000 });
    await appAF.page.evaluate(() => document.getElementById('roomInfoJumpBtn').click());
    await appAF.page.waitForTimeout(200);
    const roomKey = await appAF.page.evaluate((fen) => window.__graphTestHooks.roomKeyOf(fen), fens.room);
    const state = await appAF.page.evaluate(() => ({
      room: window.__threeTestEdit.room(),
      overlay: document.getElementById('roomInfoOverlay').style.display,
      graphOverlay: document.getElementById('graphOverlay').style.display,
    }));
    assert(state.room === roomKey, `expected the fast path to land in the target room, got ${state.room} (wanted ${roomKey})`);
    assert(state.overlay === 'none', 'expected the room-info modal to close after jumping');
    assert(state.graphOverlay === 'flex', 'expected the digraph overlay to stay open underneath, not close on jump');
    ok('room-info modal: "Jump to VR" with VR already open takes the fast path (no rebuild)');
  } catch(e){ bad('room-info modal: Jump to VR fast path when VR already open', e); }

  // 93. With the digraph left open underneath (previous step), the VR
  //     overlay must actually be the TOP-STACKED element -- both overlays
  //     share the base .overlay z-index (20) with no tiebreak by DOM order
  //     otherwise, so a click meant for the VR canvas silently hit the
  //     graph's backdrop instead (the reported "Jump to VR doesn't quite
  //     work" symptom). Checks real hit-testing, not just the CSS number.
  try {
    const hit = await appAF.page.evaluate(() => {
      const wrap = document.getElementById('threeTestCanvasWrap');
      const r = wrap.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
      return { insideVR: !!(el && el.closest('#threeTestOverlay')), tag: el && el.tagName, id: el && el.id };
    });
    assert(hit.insideVR, `expected the VR canvas to be the top-stacked element under the digraph, got ${JSON.stringify(hit)}`);
    ok('VR overlay stacks above a still-open digraph overlay (clicks reach the canvas, not the graph backdrop)');
  } catch(e){ bad('VR overlay z-index stacks above the digraph overlay left open underneath', e); }
} finally {
  await appAF.close();
}

// --- Phase AG: "Import this variation" from a saved eval's expanded PV in
//     the move table -- mirrors the live engine panel's own pvMenu ->
//     "Import this variation" (see importEngineVariation/renderEngineLines),
//     reusing the exact same import core, just triggered from a saved
//     (not live) line. ---
const appAG = await launchApp();
try {
  const midFen = await appAG.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6']) c.move(m, { sloppy: true });
    return c.fen();
  });
  const evalLines = [
    { type: 'cp', value: 35, depth: 20, pv: '2.c4 e6', pvFen: midFen, pvUci: ['c2c4','e7e6'] },
    { type: 'cp', value: 20, depth: 18, pv: '2.Nf3 d5', pvFen: midFen, pvUci: ['g1f3','d7d5'] },
  ];
  await seedBackup(appAG.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], eval: evalLines[0], evalLines },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  });
  await appAG.page.click('.line-row');
  const rowSel = 'tr.data-row[data-opp="Nf6"]';
  await appAG.page.waitForSelector(rowSel, { timeout: 10000 });

  // 96. Expanding the saved eval (tapping its badge) shows an import
  //     (three-dot) menu button beside EACH of the two saved lines.
  try {
    await appAG.page.evaluate((sel) => document.querySelector(`${sel} .evaltag`).click(), rowSel);
    await appAG.page.waitForSelector(`${rowSel} + tr.meta-row .meta-pv-row`, { timeout: 5000 });
    const menuCount = await appAG.page.evaluate((sel) =>
      document.querySelector(sel).nextElementSibling.querySelectorAll('.meta-pv-menu').length, rowSel);
    assert(menuCount === 2, `expected an import menu button beside each of the 2 saved lines, got ${menuCount}`);
    ok('expanding a multi-line saved eval shows an "Import this variation" menu beside each line');
  } catch(e){ bad('eval continuation: import menu per saved line', e); }

  // 97. Clicking the first line's menu, then "Import this variation" in the
  //     popup, writes it into the tree -- the same importParsedLine core the
  //     paste-import UI (test 7) and the live engine panel both delegate to.
  try {
    await appAG.page.evaluate((sel) =>
      document.querySelector(sel).nextElementSibling.querySelector('.meta-pv-menu[data-pv-idx="0"]').click(), rowSel);
    await appAG.page.waitForSelector('#graphCtxMenu', { state: 'visible', timeout: 5000 });
    const label = await appAG.page.textContent('#graphCtxMenu div');
    assert(/Import this variation/.test(label || ''), `expected an "Import this variation" menu item, got ${JSON.stringify(label)}`);
    await appAG.page.evaluate(() => document.querySelector('#graphCtxMenu div').click());
    await appAG.page.waitForFunction((sel) => {
      const row = document.querySelector(sel);
      return row && row.querySelector('.ourReply')?.textContent?.trim() === 'c4';
    }, rowSel, { timeout: 10000 });
    ok('"Import this variation" from a saved eval line writes it into the tree');
  } catch(e){ bad('eval continuation: import this variation writes into tree', e); }
} finally {
  await appAG.close();
}

// --- Phase AH: locked doors -- a room with nothing built past it (no forward
//     moves) gets a doorway that can't be walked through, with a lock icon
//     until it's skinned (per-door or via a castle-wide default), mirroring
//     the ordinary/exit-door "building defaults" mechanism. ---
const appAH = await launchApp();
try {
  // root Alpha branches three ways: e6 leads to a room with a genuine BRANCH
  // of its own (Bb4/Be7 -- 2 replies, so it gets 2 real forward doors and is
  // NOT empty; a single continuing reply would instead just collapse into
  // the same corridor room with no new door -- see Phase X). g6 and d5 are
  // both genuine dead ends (EMPTY -- nothing built past either).
  await seedBackup(appAH.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Bd2' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Be7'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','d5'], reply: 'Nc3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Bd2', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 e6 Nc3 Be7 e4', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 Nf6 c4 g6 Nc3 Bg7', white: 'a', black: 'b', result: '*' },
      { id: 'g4', moves: 'd4 Nf6 c4 d5 Nc3 Bb4', white: 'a', black: 'b', result: '*' },
    ],
    assets: [{ id: 'vaultDoor', type: 'door', image: 'data:image/png;base64,iVBORw0KGgo=' }],
  });
  await openVR(appAH.page);
  const keyFor = (moves) => appAH.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  }, moves);
  const root = await keyFor(['d4','Nf6','c4']);
  const e6Room = await keyFor(['d4','Nf6','c4','e6','Nc3']);
  const g6Room = await keyFor(['d4','Nf6','c4','g6','Nc3']);
  const d5Room = await keyFor(['d4','Nf6','c4','d5','Nc3']);
  await appAH.page.evaluate((k) => window.__threeTestEdit.enter(k), root);
  await appAH.page.waitForTimeout(300);

  // 105. isRoomEmpty correctly distinguishes the continuing branch (e6) from
  //      the two genuine dead ends (g6, d5).
  try {
    const empty = await appAH.page.evaluate(({ e6, g6, d5 }) => ({
      e6: window.__threeTestEdit.isRoomEmpty(e6),
      g6: window.__threeTestEdit.isRoomEmpty(g6),
      d5: window.__threeTestEdit.isRoomEmpty(d5),
    }), { e6: e6Room, g6: g6Room, d5: d5Room });
    assert(empty.e6 === false, `expected the e6 room (has a further move) NOT empty, got ${empty.e6}`);
    assert(empty.g6 === true && empty.d5 === true, `expected both dead-end rooms empty, got g6=${empty.g6} d5=${empty.d5}`);
    ok('isRoomEmpty distinguishes a room with further moves from a genuine dead end');
  } catch(e){ bad('locked doors: isRoomEmpty detection', e); }

  // 106. A locked door has no teleport trigger (can't be walked through); an
  //      ordinary door to a non-empty room still does.
  try {
    const walk = await appAH.page.evaluate(({ e6, g6, d5 }) => ({
      e6: window.__threeTestEdit.canWalkTo(e6),
      g6: window.__threeTestEdit.canWalkTo(g6),
      d5: window.__threeTestEdit.canWalkTo(d5),
    }), { e6: e6Room, g6: g6Room, d5: d5Room });
    assert(walk.e6 === true, 'expected the e6 door (non-empty target) to still be walkable');
    assert(walk.g6 === false && walk.d5 === false, `expected both locked doors NOT walkable, got g6=${walk.g6} d5=${walk.d5}`);
    ok('a locked door has no teleport trigger; an ordinary door to a built room still does');
  } catch(e){ bad('locked doors: no teleport trigger', e); }

  // 107. An unskinned locked door shows a lock icon; the ordinary (unlocked,
  //      unskinned) door does not.
  try {
    const kinds = await appAH.page.evaluate(() => window.__threeTestEdit.scan().map(o => o.kind));
    const lockIcons = kinds.filter(k => k === 'locked-door-icon').length;
    assert(lockIcons === 2, `expected a lock icon on each of the 2 unskinned locked doors, got ${lockIcons}`);
    ok('an unskinned locked door shows a lock icon; an ordinary door does not');
  } catch(e){ bad('locked doors: lock icon on unskinned locked doors', e); }

  // 108. Skinning ONE locked door (g6) directly removes ITS icon (replaced by
  //      the door panel) while leaving the other locked door (d5) still
  //      showing its icon, unskinned -- and g6 is still not walkable.
  try {
    const assigned = await appAH.page.evaluate(
      ({ rk, tk, aid }) => window.__threeTestEdit.setDoorAssetForTarget(rk, tk, aid),
      { rk: root, tk: g6Room, aid: 'vaultDoor' });
    assert(assigned, 'setDoorAssetForTarget could not find the g6 door (test setup issue if not)');
    await appAH.page.waitForTimeout(300);
    const state = await appAH.page.evaluate(() => {
      const scan = window.__threeTestEdit.scan();
      return { lockIcons: scan.filter(o => o.kind === 'locked-door-icon').length };
    });
    assert(state.lockIcons === 1, `expected only d5's lock icon left after skinning g6's door, got ${state.lockIcons}`);
    const stillLocked = await appAH.page.evaluate((k) => window.__threeTestEdit.canWalkTo(k), g6Room);
    assert(stillLocked === false, 'expected the skinned g6 door to still be unwalkable (a skin does not unlock it)');
    ok('skinning one locked door removes its icon (door panel shows instead) without unlocking it, leaving other locked doors unaffected');
  } catch(e){ bad('locked doors: per-door skin removes its own icon only', e); }

  // 109. A castle-wide default locked-door skin (captured the same way the
  //      Room Geometry dialog's "make default" checkbox does) automatically
  //      applies to a DIFFERENT locked door in the same castle that has no
  //      per-door override of its own (d5) -- removing its icon too.
  try {
    await appAH.page.evaluate((k) => window.__threeTestEdit.captureBuildingDefaults(k), root);
    await appAH.page.waitForTimeout(300);
    const state = await appAH.page.evaluate(() => {
      const scan = window.__threeTestEdit.scan();
      const meshes = window.__threeTestEdit.meshes();
      return {
        lockIcons: scan.filter(o => o.kind === 'locked-door-icon').length,
        doorPanels: meshes.filter(m => m.kind === 'door-panel').length,
      };
    });
    assert(state.lockIcons === 0, `expected no lock icons left once the castle default covers every locked door, got ${state.lockIcons}`);
    assert(state.doorPanels === 2, `expected exactly both locked doors (g6, d5) to now show a door panel, got ${state.doorPanels}`);
    ok('a castle-wide default locked-door skin automatically covers other locked doors with no per-door override');
  } catch(e){ bad('locked doors: castle-wide default locked-door skin', e); }
} finally {
  await appAH.close();
}

// --- Phase AH2: skinning a locked door through the real in-world picker
//     offers to make it this castle's locked-door default right away (a
//     confirm prompt), instead of requiring the separate Room Geometry
//     "make default" step every other door category needs. ---
const appAH2 = await launchApp();
try {
  await seedBackup(appAH2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Bd2' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Be7'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','d5'], reply: 'Nc3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Bd2', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 e6 Nc3 Be7 e4', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 Nf6 c4 g6 Nc3 Bg7', white: 'a', black: 'b', result: '*' },
      { id: 'g4', moves: 'd4 Nf6 c4 d5 Nc3 Bb4', white: 'a', black: 'b', result: '*' },
    ],
    assets: [{ id: 'vaultDoor', type: 'door', image: 'data:image/png;base64,iVBORw0KGgo=' }],
  });
  await openVR(appAH2.page);
  const root = await appAH2.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  });
  const g6Room = await appAH2.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4','g6','Nc3']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  });
  await appAH2.page.evaluate((k) => window.__threeTestEdit.enter(k), root);
  await appAH2.page.waitForTimeout(300);
  await appAH2.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
  await appAH2.page.waitForTimeout(60);
  const g6DoorKey = await appAH2.page.evaluate(({ root, g6Room }) =>
    window.__threeTestEdit.exitsOf(root).find(e => e.target === g6Room)?.doorKey,
    { root, g6Room });
  assert(g6DoorKey, 'test setup issue: could not find g6\'s doorKey');

  // 114. Picking an asset for a locked door pops the "make this the locked
  //      door default for this building?" confirm (auto-accepted by the
  //      harness's global dialog handler, i.e. "Yes") -- and it takes
  //      effect immediately: a DIFFERENT, untouched locked door (d5) in the
  //      same castle now shows the same skin too, no separate "make
  //      default" step needed.
  try {
    await appAH2.page.evaluate(({ rk, dk }) => window.__threeTestEdit.target({ kind: 'door', roomKey: rk, doorKey: dk }),
      { rk: root, dk: g6DoorKey });
    await appAH2.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appAH2.page.evaluate(() => {
      const card = [...document.querySelectorAll('#pickerGrid .asset-card')]
        .find(c => !c.classList.contains('asset-card-color') && c.textContent.includes('vaultDoor'));
      card.click();
    });
    await appAH2.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
    await appAH2.page.waitForTimeout(300);
    const state = await appAH2.page.evaluate(() => {
      const scan = window.__threeTestEdit.scan();
      const meshes = window.__threeTestEdit.meshes();
      return {
        lockIcons: scan.filter(o => o.kind === 'locked-door-icon').length,
        doorPanels: meshes.filter(m => m.kind === 'door-panel').length,
      };
    });
    assert(state.lockIcons === 0, `expected no lock icons left -- the confirmed default should cover d5 too, got ${state.lockIcons}`);
    assert(state.doorPanels === 2, `expected both locked doors (g6, d5) to show a door panel after confirming the default, got ${state.doorPanels}`);
    ok('skinning a locked door through the real picker offers, and (on Yes) immediately applies, a castle-wide locked-door default');
  } catch(e){ bad('locked doors: picker offers to set the castle-wide default on skin assignment', e); }
} finally {
  await appAH2.close();
}

// --- Phase AI: top VR toolbar icon order -- the edit-only buttons (room
//     geometry / wall lists / assets) sit immediately right of the Edit
//     button, with no buttons that also show outside edit mode (board
//     position, memorize) wedged between them. ---
const appAI = await launchApp();
try {
  await seedBackup(appAI.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
  });
  await openVR(appAI.page);
  const roomKey = await appAI.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  });
  await appAI.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
  await appAI.page.waitForTimeout(200);
  const iconOrder = () => appAI.page.evaluate(() =>
    [...document.querySelectorAll('#threeTestCanvasWrap i.fa-solid')].map(i =>
      [...i.classList].find(c => c !== 'fa-solid')));

  // 110. Edit-only buttons (fa-ruler-combined, fa-list-ol, fa-cubes) come
  //      immediately after fa-pencil (Edit), before fa-chess-board (board
  //      position) or fa-brain (memorize) -- both of which also show outside
  //      edit mode and must not be wedged in between.
  try {
    const order = await iconOrder();
    const editIdx = order.indexOf('fa-pencil');
    const boardIdx = order.indexOf('fa-chess-board');
    const brainIdx = order.indexOf('fa-brain');
    const infoIdx = order.indexOf('fa-circle-info');
    assert(editIdx >= 0 && boardIdx > editIdx && brainIdx > editIdx && infoIdx > editIdx,
      `expected to find Edit, board, brain and info icons in order, got: ${JSON.stringify(order)}`);
    for(const editOnly of ['fa-ruler-combined', 'fa-list-ol', 'fa-cubes']){
      const idx = order.indexOf(editOnly);
      assert(idx > editIdx && idx < boardIdx && idx < brainIdx && idx < infoIdx,
        `expected ${editOnly} right after Edit and before board/brain/info, got order: ${JSON.stringify(order)}`);
    }
    ok('edit-only toolbar buttons sit immediately right of Edit, before board/brain/info');
  } catch(e){ bad('toolbar: edit-only buttons grouped right after Edit', e); }

  // 111. Memorize (fa-brain) is the rightmost status icon -- immediately left
  //      of Close (fa-circle-xmark); the decorated badge (fa-palette), when
  //      present in the DOM, sits immediately to memorize's own left. Order
  //      holds regardless of either badge's current show/hide state.
  try {
    const order = await iconOrder();
    const paletteIdx = order.indexOf('fa-palette');
    const brainIdx = order.indexOf('fa-brain');
    const closeIdx = order.indexOf('fa-circle-xmark');
    assert(paletteIdx >= 0 && brainIdx >= 0 && closeIdx >= 0,
      `expected to find the palette, brain and close icons, got: ${JSON.stringify(order)}`);
    assert(closeIdx - brainIdx === 1, `expected brain immediately left of close, got order: ${JSON.stringify(order)}`);
    assert(brainIdx - paletteIdx === 1, `expected the decorated badge immediately left of brain, got order: ${JSON.stringify(order)}`);
    ok('memorize is the rightmost status icon (next to Close); the decorated badge sits immediately to its left');
  } catch(e){ bad('toolbar: memorize rightmost, decorated badge immediately left of it', e); }

  // 112. The decorated badge is hidden until the current room's "fully
  //      decorated" flag (see evaluateDecorated) is actually true, then
  //      shows on the very same badge once it is -- no page/room reopen
  //      beyond the normal room rebuild needed.
  try {
    const before = await appAI.page.evaluate(() => window.__threeTestEdit.decoratedBadgeStyle());
    assert(before && before.display === 'none', `expected the decorated badge hidden by default, got ${JSON.stringify(before)}`);
    await appAI.page.evaluate((k) => window.__threeTestEdit.setDecorated(k, true), roomKey);
    await appAI.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);   // rebuild -> updateToolbar reads DECORATED fresh
    await appAI.page.waitForTimeout(150);
    const after = await appAI.page.evaluate(() => window.__threeTestEdit.decoratedBadgeStyle());
    assert(after && after.display !== 'none', `expected the decorated badge visible once the room is fully decorated, got ${JSON.stringify(after)}`);
    ok('the decorated badge shows in the VR toolbar exactly when the current room is fully decorated');
  } catch(e){ bad('toolbar: decorated badge reflects the room\'s fully-decorated flag', e); }

  // 113. Edit and its edit-only buttons (room geometry, wall lists, asset
  //      library) are wrapped in a single bordered "chip" -- visually one
  //      grouped cluster -- containing exactly those four icons, in order,
  //      and nothing else (hints/board/info stay outside it).
  try {
    const info = await appAI.page.evaluate(() => window.__threeTestEdit.editGroupInfo());
    assert(info, 'expected an editGroup wrapper element (test setup issue if not)');
    assert(info.hasBorder, `expected the edit-tools group to have a visible border, got ${JSON.stringify(info)}`);
    assert(JSON.stringify(info.icons) === JSON.stringify(['fa-pencil', 'fa-ruler-combined', 'fa-list-ol', 'fa-cubes']),
      `expected exactly Edit + its 3 edit-only icons inside the group, in order, got ${JSON.stringify(info.icons)}`);
    ok('Edit and its edit-only buttons are wrapped in a single bordered group');
  } catch(e){ bad('toolbar: edit-tools bordered group', e); }
} finally {
  await appAI.close();
}

// --- Phase AJ: a room's own name on the floor, a little way in from the
//     entrance -- hint-gated, clamped to stay clear of the far wall in a
//     shallow room, and spins to keep facing the camera as you walk. ---
const appAJ = await launchApp();
try {
  await seedBackup(appAJ.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
  });
  await openVR(appAJ.page);
  const root = await appAJ.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  });
  await appAJ.page.evaluate((k) => window.__threeTestEdit.enter(k), root);
  await appAJ.page.waitForTimeout(300);

  // 115. No label on an unnamed room, even with hints on.
  try {
    const label = await appAJ.page.evaluate(() => window.__threeTestEdit.roomNameFloorLabel());
    assert(label === null, `expected no floor label on an unnamed room, got ${JSON.stringify(label)}`);
    ok('no room-name floor label when the room has no name');
  } catch(e){ bad('room name floor label: none without a name', e); }

  // 116. Naming the room shows exactly one label, lying flat (normal ~ world
  //      up), positioned 4m in from the entrance (south wall here), centered
  //      on the cross axis, just above the floor.
  let size;
  try {
    await appAJ.page.evaluate((k) => window.__threeTestEdit.setRoomName(k, 'Vault Room'), root);
    await appAJ.page.evaluate((k) => window.__threeTestEdit.enter(k), root);   // rebuild
    await appAJ.page.waitForTimeout(200);
    size = await appAJ.page.evaluate((rk) => window.__threeTestEdit.roomSize(rk), root);
    const label = await appAJ.page.evaluate(() => window.__threeTestEdit.roomNameFloorLabel());
    assert(label && label.count === 1, `expected exactly one floor label, got ${JSON.stringify(label)}`);
    const expectedZ = size.d / 2 - 4;   // south entrance, 4m in (room is deep enough)
    assert(Math.abs(label.x) < 0.05 && Math.abs(label.z - expectedZ) < 0.05,
      `expected the label ~4m in from the south entrance (x~0, z~${expectedZ}), got x=${label.x} z=${label.z}`);
    assert(label.y > 0 && label.y < 0.1, `expected the label just above the floor, got y=${label.y}`);
    assert(Math.abs(label.normal.x) < 0.01 && label.normal.y > 0.99 && Math.abs(label.normal.z) < 0.01,
      `expected the label lying flat (normal ~ (0,1,0)), got ${JSON.stringify(label.normal)}`);
    ok('a named room shows exactly one floor label, lying flat, 4m in from the entrance');
  } catch(e){ bad('room name floor label: position/orientation for a named room', e); }

  // 117. Turning hints off hides it (a memory aid, not permanent decor);
  //      turning them back on brings it back.
  try {
    await appAJ.page.evaluate(() => document.querySelector('#threeTestCanvasWrap i.fa-lightbulb').closest('button').click());
    await appAJ.page.waitForTimeout(300);
    const off = await appAJ.page.evaluate(() => window.__threeTestEdit.roomNameFloorLabel());
    assert(off === null, `expected no floor label with hints off, got ${JSON.stringify(off)}`);
    await appAJ.page.evaluate(() => document.querySelector('#threeTestCanvasWrap i.fa-lightbulb').closest('button').click());
    await appAJ.page.waitForTimeout(300);
    const on = await appAJ.page.evaluate(() => window.__threeTestEdit.roomNameFloorLabel());
    assert(on !== null, 'expected the floor label back once hints are re-enabled');
    ok('the room-name floor label is hint-gated (hidden/shown with the hints toggle)');
  } catch(e){ bad('room name floor label: hint-gated', e); }

  // 118. Edge case: a room shallower than 4m + the far-wall margin clamps
  //      the label so it never crowds (or sits past) the far wall.
  try {
    await appAJ.page.evaluate((k) => window.__threeTestEdit.resize(k, { w: 11, d: 2.5, h: 6 }), root);
    await appAJ.page.waitForTimeout(200);
    const label = await appAJ.page.evaluate(() => window.__threeTestEdit.roomNameFloorLabel());
    const expectedZ = 2.5/2 - (2.5 - 0.6);   // clamped to (depth - far-wall margin), not the full 4m
    assert(label && Math.abs(label.z - expectedZ) < 0.05,
      `expected the label clamped clear of the far wall in a 2.5m-deep room (z~${expectedZ}), got ${JSON.stringify(label)}`);
    ok('room name floor label: clamped to stay clear of the far wall in a shallow room');
  } catch(e){ bad('room name floor label: shallow-room clamping', e); }

  // 119. The label spins so its "up" (readable-top) edge points AWAY from
  //      the camera's current position (like a floor decal read by someone
  //      standing over/behind it looking down-and-forward -- the far edge
  //      reads last, not the near edge), while staying flat (normal
  //      unchanged) -- teleporting to two different spots changes which way
  //      it faces.
  try {
    await appAJ.page.evaluate((k) => window.__threeTestEdit.resize(k, { w: 11, d: 13, h: 6 }), root);   // back to normal depth
    await appAJ.page.waitForTimeout(200);
    const before = await appAJ.page.evaluate(() => window.__threeTestEdit.roomNameFloorLabel());
    await appAJ.page.evaluate(({ x, z }) => window.__threeTestEdit.teleport(x, z, 0), { x: before.x + 5, z: before.z });
    await appAJ.page.waitForTimeout(300);
    const facingA = await appAJ.page.evaluate(() => window.__threeTestEdit.roomNameFloorLabel());
    await appAJ.page.evaluate(({ x, z }) => window.__threeTestEdit.teleport(x, z, 0), { x: before.x, z: before.z + 5 });
    await appAJ.page.waitForTimeout(300);
    const facingB = await appAJ.page.evaluate(() => window.__threeTestEdit.roomNameFloorLabel());
    assert(facingA.up.x < -0.9 && Math.abs(facingA.up.z) < 0.1,
      `expected "up" to point away from the camera at +x (i.e. toward -x), got ${JSON.stringify(facingA.up)}`);
    assert(facingB.up.z < -0.9 && Math.abs(facingB.up.x) < 0.1,
      `expected "up" to point away from the camera at +z after moving (i.e. toward -z), got ${JSON.stringify(facingB.up)}`);
    assert(facingA.normal.y > 0.99 && facingB.normal.y > 0.99, 'expected the label to stay flat while spinning to face the camera');
    ok('room name floor label spins to read right-side-up from the camera\'s position, staying flat');
  } catch(e){ bad('room name floor label: faces the camera as you move', e); }
} finally {
  await appAJ.close();
}

// --- Phase AK: crop/erase image editor -- fuzz/brush-size sliders persist to
//     localStorage across modal reopens, and an undo/redo history stack
//     (standard rotate-left/rotate-right icons) walks back/forward through
//     each committed crop/erase/brush mutation. ---
const appAK = await launchApp();
try {
  const srcUrl = await appAK.page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 100; c.height = 100;
    const cx = c.getContext('2d');
    cx.fillStyle = '#ff0000';
    cx.fillRect(0, 0, 100, 100);
    return c.toDataURL('image/png');
  });
  const waitReady = async () => appAK.page.waitForFunction(() => {
    const img = document.getElementById('cropImg');
    return img && img.naturalWidth > 0 && document.getElementById('cropOverlay').style.display === 'flex';
  }, { timeout: 5000 });
  const alphaProbe = async (dataUrl, points) => appAK.page.evaluate(async ({ dataUrl, points }) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    const id = cx.getImageData(0, 0, c.width, c.height).data;
    return { w: c.width, h: c.height, alphas: points.map(([x, y]) => id[(y * c.width + x) * 4 + 3]) };
  }, { dataUrl, points });
  const bucketErase = async (x, y) => appAK.page.evaluate(({ x, y }) => {
    const img = document.getElementById('cropImg');
    const r = img.getBoundingClientRect();
    const clientX = r.left + (x/100) * r.width, clientY = r.top + (y/100) * r.height;
    img.dispatchEvent(new PointerEvent('pointerdown', { clientX, clientY, bubbles: true }));
  }, { x, y });
  const brushClick = async (x, y) => appAK.page.evaluate(({ x, y }) => {
    const wrap = document.getElementById('cropWrap');
    const r = wrap.getBoundingClientRect();
    const clientX = r.left + (x/100) * r.width, clientY = r.top + (y/100) * r.height;
    wrap.dispatchEvent(new PointerEvent('pointerdown', { clientX, clientY, buttons: 1, bubbles: true }));
    wrap.dispatchEvent(new PointerEvent('pointerup', { clientX, clientY, bubbles: true }));
  }, { x, y });
  const historyState = () => appAK.page.evaluate(() => ({
    undoDisabled: document.getElementById('cropUndoBtn').disabled,
    redoDisabled: document.getElementById('cropRedoBtn').disabled,
  }));

  // 120. Fuzz (erase tolerance) and brush-size sliders default to the
  //      documented hardcoded values (32 / 30px) the first time, before
  //      anything has ever been saved.
  try {
    await appAK.page.evaluate((url) => window.__cropTestHooks.open(url), srcUrl);
    await waitReady();
    const defaults = await appAK.page.evaluate(() => ({
      tol: document.getElementById('cropTol').value,
      tolLabel: document.getElementById('cropTolVal').textContent,
      brush: document.getElementById('cropBrushSizeInput').value,
      brushLabel: document.getElementById('cropBrushSizeVal').textContent,
    }));
    assert(defaults.tol === '32' && defaults.tolLabel === '32', `expected fuzz to default to 32, got ${JSON.stringify(defaults)}`);
    assert(defaults.brush === '30' && defaults.brushLabel === '30px', `expected brush size to default to 30px, got ${JSON.stringify(defaults)}`);
    ok('crop editor: fuzz/brush-size sliders default to 32/30px with nothing saved yet');
    await appAK.page.evaluate(() => document.getElementById('cropCancelBtn').click());
    await appAK.page.evaluate(() => window.__cropTestHooks.result());
  } catch(e){ bad('crop editor: slider defaults before any save', e); }

  // 121. Changing either slider persists it to localStorage, and reopening
  //      the modal (a fresh cropImage() call, as happens each time the tool
  //      is opened) restores the saved values instead of resetting to the
  //      hardcoded defaults.
  try {
    await appAK.page.evaluate((url) => window.__cropTestHooks.open(url), srcUrl);
    await waitReady();
    await appAK.page.evaluate(() => {
      const tol = document.getElementById('cropTol');
      tol.value = '75'; tol.dispatchEvent(new Event('input'));
      const brush = document.getElementById('cropBrushSizeInput');
      brush.value = '90'; brush.dispatchEvent(new Event('input'));
    });
    const stored = await appAK.page.evaluate(() => ({
      tol: localStorage.getItem('cropEraseTol'), brush: localStorage.getItem('cropBrushSize'),
    }));
    assert(stored.tol === '75' && stored.brush === '90', `expected the new slider values persisted to localStorage, got ${JSON.stringify(stored)}`);
    await appAK.page.evaluate(() => document.getElementById('cropCancelBtn').click());
    await appAK.page.evaluate(() => window.__cropTestHooks.result());

    await appAK.page.evaluate((url) => window.__cropTestHooks.open(url), srcUrl);
    await waitReady();
    const reopened = await appAK.page.evaluate(() => ({
      tol: document.getElementById('cropTol').value,
      tolLabel: document.getElementById('cropTolVal').textContent,
      brush: document.getElementById('cropBrushSizeInput').value,
      brushLabel: document.getElementById('cropBrushSizeVal').textContent,
    }));
    assert(reopened.tol === '75' && reopened.tolLabel === '75', `expected fuzz to restore to the saved 75, got ${JSON.stringify(reopened)}`);
    assert(reopened.brush === '90' && reopened.brushLabel === '90px', `expected brush size to restore to the saved 90px, got ${JSON.stringify(reopened)}`);
    ok('crop editor: fuzz/brush-size sliders persist to localStorage and restore on reopen');
    await appAK.page.evaluate(() => document.getElementById('cropCancelBtn').click());
    await appAK.page.evaluate(() => window.__cropTestHooks.result());
  } catch(e){ bad('crop editor: slider values persist across reopens', e); }

  // 122. Undo/redo buttons start disabled (nothing to undo/redo yet); a real
  //      crop mutation enables Undo, and clicking it restores the pre-crop
  //      image (back to full 100x100) while enabling Redo.
  try {
    await appAK.page.evaluate((url) => window.__cropTestHooks.open(url), srcUrl);
    await waitReady();
    const initial = await historyState();
    assert(initial.undoDisabled && initial.redoDisabled, `expected both undo/redo disabled on open, got ${JSON.stringify(initial)}`);

    // drag the left crop bar in to 25% so a real (non-no-op) crop happens.
    await appAK.page.evaluate(() => {
      const bar = document.querySelector('.crop-bar.l');
      const wrap = document.getElementById('cropWrap');
      const r = wrap.getBoundingClientRect();
      bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left, clientY: r.top + r.height/2, bubbles: true }));
      bar.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width*0.25, clientY: r.top + r.height/2, buttons: 1, bubbles: true }));
    });
    await appAK.page.evaluate(() => document.getElementById('cropApplyBtn').click());
    await appAK.page.waitForFunction(() => document.getElementById('cropImg').naturalWidth === 75, { timeout: 5000 });
    const afterCrop = await historyState();
    assert(!afterCrop.undoDisabled && afterCrop.redoDisabled, `expected undo enabled/redo disabled right after a crop, got ${JSON.stringify(afterCrop)}`);

    await appAK.page.evaluate(() => document.getElementById('cropUndoBtn').click());
    await appAK.page.waitForFunction(() => document.getElementById('cropImg').naturalWidth === 100, { timeout: 5000 });
    const afterUndo = await historyState();
    assert(afterUndo.undoDisabled && !afterUndo.redoDisabled, `expected undo disabled/redo enabled after undoing back to the start, got ${JSON.stringify(afterUndo)}`);
    ok('crop editor: undo restores the pre-crop image and flips the undo/redo enabled state');

    await appAK.page.evaluate(() => document.getElementById('cropRedoBtn').click());
    await appAK.page.waitForFunction(() => document.getElementById('cropImg').naturalWidth === 75, { timeout: 5000 });
    const afterRedo = await historyState();
    assert(!afterRedo.undoDisabled && afterRedo.redoDisabled, `expected redo to reapply the crop and re-disable redo, got ${JSON.stringify(afterRedo)}`);
    ok('crop editor: redo reapplies the undone crop');
    await appAK.page.evaluate(() => document.getElementById('cropCancelBtn').click());
    await appAK.page.evaluate(() => window.__cropTestHooks.result());
  } catch(e){ bad('crop editor: undo/redo across a crop mutation', e); }

  // 123. Undo also unwinds a bucket (flood-fill) erase click back to the
  //      fully-opaque source image.
  try {
    await appAK.page.evaluate((url) => window.__cropTestHooks.open(url), srcUrl);
    await waitReady();
    await appAK.page.evaluate(() => document.getElementById('cropEraseBtn').click());
    await bucketErase(50, 50);
    await appAK.page.waitForFunction(() => document.getElementById('cropDims').textContent.startsWith('erased'), { timeout: 5000 });
    const erasedResult = await appAK.page.evaluate(() => document.getElementById('cropImg').src);
    const beforeUndo = await alphaProbe(erasedResult, [[50,50]]);
    assert(beforeUndo.alphas[0] === 0, `expected the bucket erase to have punched a transparent hole, got alpha ${beforeUndo.alphas[0]}`);

    await appAK.page.evaluate(() => document.getElementById('cropUndoBtn').click());
    await appAK.page.waitForFunction(() => {
      const img = document.getElementById('cropImg');
      return img.naturalWidth > 0;
    }, { timeout: 5000 });
    await appAK.page.evaluate(() => document.getElementById('cropSaveBtn').click());
    const result = await appAK.page.evaluate(() => window.__cropTestHooks.result());
    const afterUndo = await alphaProbe(result, [[50,50]]);
    assert(afterUndo.alphas[0] === 255, `expected undo to restore the fully-opaque source image, got alpha ${afterUndo.alphas[0]}`);
    ok('crop editor: undo unwinds a bucket-erase click back to the source image');
  } catch(e){ bad('crop editor: undo unwinds a bucket erase', e); }

  // 124. Undoing while brush mode is active with an uncommitted, in-progress
  //      stroke discards that stroke rather than baking it in as a side
  //      effect of navigating history -- and does not push a spurious extra
  //      history entry for it.
  try {
    await appAK.page.evaluate((url) => window.__cropTestHooks.open(url), srcUrl);
    await waitReady();
    // establish one real undo step first (a brush stroke), then re-enter
    // brush mode and draw a SECOND, never-committed stroke before undoing.
    await appAK.page.evaluate(() => document.getElementById('cropBrushBtn').click());
    await brushClick(30, 30);
    await appAK.page.evaluate(() => document.getElementById('cropBrushBtn').click());   // commit stroke #1
    const afterFirstStroke = await historyState();
    assert(!afterFirstStroke.undoDisabled, 'expected undo enabled after committing the first brush stroke');

    await appAK.page.evaluate(() => document.getElementById('cropBrushBtn').click());   // back into brush mode
    await brushClick(70, 70);   // draw stroke #2 but never exit brush mode to commit it

    await appAK.page.evaluate(() => document.getElementById('cropUndoBtn').click());
    await appAK.page.waitForTimeout(200);
    const afterUndo = await historyState();
    assert(afterUndo.undoDisabled, `expected undo to walk all the way back past stroke #1 (only one real step existed), got ${JSON.stringify(afterUndo)}`);
    const brushModeOff = await appAK.page.evaluate(() => document.getElementById('cropBrushCanvas').style.display !== 'block');
    assert(brushModeOff, 'expected undo to exit brush mode rather than leaving it active mid-navigation');

    await appAK.page.evaluate(() => document.getElementById('cropSaveBtn').click());
    const result = await appAK.page.evaluate(() => window.__cropTestHooks.result());
    const probe = await alphaProbe(result, [[30,30], [70,70]]);
    assert(probe.alphas[0] === 255, `expected undo to also discard the first committed stroke (fully back to source), got alpha ${probe.alphas[0]}`);
    assert(probe.alphas[1] === 255, `expected the never-committed second stroke to be discarded entirely, got alpha ${probe.alphas[1]}`);
    ok('crop editor: undo discards an uncommitted in-progress brush stroke instead of baking it in');
  } catch(e){ bad('crop editor: undo discards uncommitted brush strokes', e); }
} finally {
  await appAK.close();
}

// --- Phase AL: the asset picker's "New Asset" button (replacing the old
//     bare "Upload new…" quick-upload) opens the full asset editor -- id/
//     type/size fields plus Upload/Generate…/Crop -- as its own overlay
//     layered above the picker, with the Crop/Generate modals it can launch
//     layered above THAT in turn. ---
const appAL = await launchApp();
try {
  await seedBackup(appAL.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' }],
  });
  await appAL.page.click('.line-row');
  await appAL.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await appAL.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await appAL.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await appAL.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await appAL.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await appAL.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await appAL.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await appAL.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await appAL.page.waitForTimeout(400);
  await appAL.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
  await appAL.page.waitForTimeout(60);

  const zIndexOf = (sel) => appAL.page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? Number(getComputedStyle(el).zIndex) : null;
  }, sel);

  // 125. The picker no longer offers a bare quick-upload -- "New Asset…" is
  //      the only creation entry point, and opens the full editor overlay
  //      (id/type/resolution/image fields), pre-selecting the type the
  //      picker itself was scoped to (a wall's picker is scoped to
  //      "surface"), stacked above the still-visible picker underneath.
  try {
    await appAL.page.evaluate(() => window.__threeTestEdit.target({ kind: 'wall', wall: 'north' }));
    await appAL.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    const noOldUploadBtn = await appAL.page.evaluate(() => !document.getElementById('pickerUploadBtn'));
    assert(noOldUploadBtn, 'expected the old bare "Upload new…" button to be gone from the picker');
    await appAL.page.click('#pickerNewAssetBtn');
    await appAL.page.waitForSelector('#assetNewOverlay', { state: 'visible', timeout: 5000 });
    const pickerStillVisible = await appAL.page.evaluate(() =>
      getComputedStyle(document.getElementById('assetPickerOverlay')).display !== 'none');
    assert(pickerStillVisible, 'expected the picker to stay open underneath the New Asset modal');
    const [pickerZ, newAssetZ] = await Promise.all([zIndexOf('#assetPickerOverlay'), zIndexOf('#assetNewOverlay')]);
    assert(newAssetZ > pickerZ, `expected the New Asset modal (z=${newAssetZ}) to stack above the picker (z=${pickerZ})`);
    const initialType = await appAL.page.evaluate(() => document.getElementById('assetTypeInput').value);
    assert(initialType === 'surface', `expected the New Asset modal to default to the picker's own type (surface), got ${initialType}`);
    ok('picker "New Asset…" opens the full editor, pre-typed, stacked above the still-open picker');
    await appAL.page.click('#assetNewCloseBtn');
    await appAL.page.waitForSelector('#assetNewOverlay', { state: 'hidden', timeout: 5000 });
  } catch(e){ bad('picker New Asset: opens above the picker, pre-typed', e); }

  // 126. Generate… and Crop/Erase BG…, launched from inside the New Asset
  //      modal, stack above IT in turn (Crop requires an image staged first;
  //      Generate does not).
  try {
    await appAL.page.evaluate(() => window.__threeTestEdit.target({ kind: 'wall', wall: 'north' }));
    await appAL.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appAL.page.click('#pickerNewAssetBtn');
    await appAL.page.waitForSelector('#assetNewOverlay', { state: 'visible', timeout: 5000 });

    await appAL.page.click('#assetGenBtn');
    await appAL.page.waitForSelector('#assetGenOverlay', { state: 'visible', timeout: 5000 });
    const [newAssetZ1, genZ] = await Promise.all([zIndexOf('#assetNewOverlay'), zIndexOf('#assetGenOverlay')]);
    assert(genZ > newAssetZ1, `expected Generate… (z=${genZ}) to stack above the New Asset modal (z=${newAssetZ1})`);
    await appAL.page.click('#genCloseBtn');
    await appAL.page.waitForSelector('#assetGenOverlay', { state: 'hidden', timeout: 5000 });

    await appAL.page.setInputFiles('#assetImgFile', FIXTURE_PNG_PATH);
    await appAL.page.waitForSelector('#assetImgPreview', { timeout: 5000 });
    await appAL.page.click('#assetCropBtn');
    await appAL.page.waitForSelector('#cropOverlay', { state: 'visible', timeout: 5000 });
    const [newAssetZ2, cropZ] = await Promise.all([zIndexOf('#assetNewOverlay'), zIndexOf('#cropOverlay')]);
    assert(cropZ > newAssetZ2, `expected Crop/Erase BG… (z=${cropZ}) to stack above the New Asset modal (z=${newAssetZ2})`);
    await appAL.page.click('#cropCancelBtn');
    await appAL.page.waitForSelector('#cropOverlay', { state: 'hidden', timeout: 5000 });
    ok('Generate…/Crop launched from the New Asset modal stack above it');

    await appAL.page.click('#assetNewCloseBtn');
    await appAL.page.waitForSelector('#assetNewOverlay', { state: 'hidden', timeout: 5000 });
  } catch(e){ bad('picker New Asset: Generate/Crop stack above the New Asset modal', e); }

  // 127. Saving a new asset from the picker's New Asset modal closes it and
  //      refreshes the picker underneath so the new asset shows up right
  //      away, ready to pick; Cancel discards without creating anything.
  try {
    await appAL.page.evaluate(() => window.__threeTestEdit.target({ kind: 'wall', wall: 'north' }));
    await appAL.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appAL.page.click('#pickerNewAssetBtn');
    await appAL.page.waitForSelector('#assetNewOverlay', { state: 'visible', timeout: 5000 });
    await appAL.page.fill('#assetIdInput', 'test-wall-skin-1');
    await appAL.page.setInputFiles('#assetImgFile', FIXTURE_PNG_PATH);
    await appAL.page.waitForSelector('#assetImgPreview', { timeout: 5000 });
    await appAL.page.click('#assetsSaveBtn');
    await appAL.page.waitForSelector('#assetNewOverlay', { state: 'hidden', timeout: 5000 });
    await appAL.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    const cardIds = await appAL.page.evaluate(() =>
      [...document.querySelectorAll('#pickerGrid .asset-id')].map(el => el.textContent));
    assert(cardIds.some(t => t.includes('test-wall-skin-1')), `expected the new asset in the picker grid, got ${JSON.stringify(cardIds)}`);
    ok('New Asset: Save closes the modal and the new asset appears in the picker grid');

    // Cancel path: no second asset created.
    await appAL.page.click('#pickerNewAssetBtn');
    await appAL.page.waitForSelector('#assetNewOverlay', { state: 'visible', timeout: 5000 });
    await appAL.page.fill('#assetIdInput', 'test-wall-skin-2');
    await appAL.page.setInputFiles('#assetImgFile', FIXTURE_PNG_PATH);
    await appAL.page.waitForSelector('#assetImgPreview', { timeout: 5000 });
    await appAL.page.click('#assetsCancelBtn');
    await appAL.page.waitForSelector('#assetNewOverlay', { state: 'hidden', timeout: 5000 });
    const cardIdsAfterCancel = await appAL.page.evaluate(() =>
      [...document.querySelectorAll('#pickerGrid .asset-id')].map(el => el.textContent));
    assert(!cardIdsAfterCancel.some(t => t.includes('test-wall-skin-2')), 'expected Cancel to discard the in-progress new asset');
    ok('New Asset: Cancel discards without creating an asset');
    await appAL.page.click('#pickerCloseBtn');
    await appAL.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
  } catch(e){ bad('picker New Asset: Save/Cancel outcomes', e); }
} finally {
  await appAL.close();
}

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
