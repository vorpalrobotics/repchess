// Headless tests for the VR world, run against the offline harness.
//   cd test && npm install && npm test
import { launchApp, seedBackup, openVR } from './harness.mjs';

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

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
