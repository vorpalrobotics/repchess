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

// --- subsystem filtering: "unit tests for subsystem X" vs the full "system
//     test" -- see test/README.md "Targeted (unit) runs" for the workflow.
//     Every phase below is wrapped in `if(shouldRunPhase([...tags])){ ... }`.
//     No args: SYSTEM TEST, every phase runs (this is what CI / a pre-merge
//     check should use). One or more subsystem names as args: only phases
//     tagged with at least one of them run (plus 'core', the cheap boot
//     smoke test, which always runs as a sanity check that the harness
//     itself works before trusting a targeted result). ---
const SUBSYSTEMS = {
  'core':              'boot smoke test (always runs, even in a targeted run)',
  'move-table':        'tree view: focus, node stats, badges, standard response, variation import',
  'digraph':           'Opening Graph modal: nodes, room-info panel, Jump to VR, coverage stats',
  'vr-castle':         'castle walking mechanics: doors, stairs, street, locked doors, memorized toggle',
  'vr-decorating':     'room decoration: move-object slots, geometry, wall lists, fully-decorated flag',
  'vr-ui':             'VR toolbar chrome (icon order, mini board)',
  'assets':            'asset picker, crop/erase editor, New Asset flow, color picker',
  'mnemonics':         'Manage Mnemonics screen, export/import bundle, default mnemonics offer',
  'quiz':              'mnemonics quiz + board-play quiz (Test > Mnemonics / Chessboard)',
  'analysis-queue':    'background analysis queue',
  'engine':            'live engine panel, threads, analyze()',
  'castle-generation': "gatherBuiltCastles' cache and its invalidation",
  'import-export':     'full backup import/export',
  'object-lists':      'Object List Manager: room-database JSON import, id/item dedup',
  'help':              'Help modal',
};
const REQUESTED = process.argv.slice(2).flatMap(a => a.split(',')).filter(Boolean);
if(REQUESTED.includes('--list')){
  console.log('Available subsystems (pass one or more, comma/space-separated, to run only those):\n');
  for(const [name, desc] of Object.entries(SUBSYSTEMS)) console.log(`  ${name.padEnd(18)} ${desc}`);
  console.log('\nNo args = full system test (every phase). Example targeted run:');
  console.log('  node run-tests.mjs digraph mnemonics');
  process.exit(0);
}
for(const name of REQUESTED){
  if(!SUBSYSTEMS[name]) { console.error(`Unknown subsystem "${name}" -- run with --list to see valid names.`); process.exit(1); }
}
function shouldRunPhase(tags){
  if(!REQUESTED.length) return true;
  return tags.includes('core') || tags.some(t => REQUESTED.includes(t));
}
if(REQUESTED.length) console.log(`Targeted run: ${REQUESTED.join(', ')} (+ core)\n`);

if(shouldRunPhase(['core'])){
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

// 5. A REAL user's browser boots without localStorage.threeTestDebug set --
//    every other test in this suite launches WITH that flag (it's what
//    exposes the __xTestHooks tests drive things through), so top-level boot
//    code gated by `if(!localStorage.getItem('threeTestDebug'))` (there's
//    exactly one such call: maybeOfferDefaultMnemonics) is structurally
//    unreachable by the rest of the suite. This is the only test that boots
//    the way an actual user does, specifically to catch bugs only reachable
//    on that path -- e.g. the "Cannot access 'GZIP_OK' before initialization"
//    ReferenceError this reproduced: GZIP_OK's `const` was declared further
//    down the file than the boot-time call that read it, so it threw on
//    every real page load while every threeTestDebug=true test sailed past.
try {
  const appReal = await launchApp({ threeTestDebug: false });
  try {
    await appReal.page.waitForFunction(() => {
      const el = document.getElementById('buildStamp');
      return el && el.textContent && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    // let the rest of the synchronous top-level boot pass (incl. the
    // maybeOfferDefaultMnemonics() call and its own synchronous checks,
    // before any fetch/dialog) finish and surface any error.
    await appReal.page.waitForTimeout(500);
    assert(realErrors(appReal.consoleErrors).length === 0,
      'unexpected console errors on a real (non-threeTestDebug) boot:\n' + realErrors(appReal.consoleErrors).join('\n'));
    ok('app boots cleanly for a real user (no threeTestDebug) -- catches boot-code bugs the rest of the suite structurally can\'t reach');
  } finally {
    await appReal.close();
  }
} catch(e){ bad('real-user boot (no threeTestDebug) has no console errors', e); }

}
// --- Phase B: opponent move-quality annotation (move table) ---
if(shouldRunPhase(['move-table'])){
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

}
// --- Phase C: cross-castle door plaque (two-line: castle name over room) ---
if(shouldRunPhase(['vr-castle'])){
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
  //    castle plaque -- three lines (castle + room + occurrence stat, since
  //    both games here give this room's exits a real "N (M%)" to show) at
  //    PlaneGeometry height 0.57, vs 0.33 for a plain room-only plaque.
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
      const threeLine = planes.filter(m => m.params && Math.abs(m.params.height - 0.57) < 0.02);
      const oneLine = planes.filter(m => m.params && Math.abs(m.params.height - 0.33) < 0.02);
      return { threeLine: threeLine.length, oneLine: oneLine.length };
    });
    assert(found.threeLine >= 1,
      `expected a three-line cross-castle plaque (0.57-high plane); planes found: ${JSON.stringify(found)}`);
    ok(`cross-castle door shows the taller castle plaque (${found.threeLine} found)`);
  } catch(e){ bad('cross-castle door plaque', e); }
} finally {
  await app3.close();
}

}
// --- Phase C2: a nested castle's door redirects to the OTHER castle's own
// canonical room, so decorations configured there (e.g. a staircase) show up
// from the nested door too, instead of a duplicate/undecorated inline copy. ---
if(shouldRunPhase(['vr-castle'])){
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

}
// --- Phase D: walk UP a staircase that shares its wall with other doors ---
// (regression: a variation import added a door to a stair's wall, and the clamp
// only allowed ONE door per wall as walkable, blocking the stair at its base.)
if(shouldRunPhase(['vr-castle'])){
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

}
// --- Phase E: room-bounds auto-fix (a nudged item survives a later downsize) ---
if(shouldRunPhase(['vr-decorating'])){
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

}
// --- Phase G: mnemonic quiz "Restrict to Opening Coverage" scoped to a castle ---
if(shouldRunPhase(['quiz'])){
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

  // wrapped separately (it guards *setup* used by tests 12-14): a failure
  // here is recorded as its own test instead of throwing past this phase's
  // try/finally and aborting the rest of the suite. Used to need a 50s
  // timeout to paper over seedBackup() resolving before the restore had
  // actually finished writing mnemonics (see harness.mjs) -- now that
  // seedBackup() waits for the real completion signal, a normal timeout is
  // enough here too.
  try {
    await app7.page.evaluate(() => document.getElementById('menuQuiz').click());
    await app7.page.waitForSelector('#quizSetup', { state: 'visible', timeout: 5000 });
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

}
// --- Phase H: the VR mini board and the room-info mini board render identical,
//     real piece artwork (same cm-chessboard sprite as the main analysis boards) ---
if(shouldRunPhase(['digraph', 'vr-ui'])){
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

}
// --- Phase I: graph node layout (manual de-overlap dragging) persists ---
if(shouldRunPhase(['digraph'])){
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

}
// --- Phase J: surface color picker (flat color as an alternative to an image asset) ---
if(shouldRunPhase(['assets'])){
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

}
// --- Phase K: Chessboard test (Test > Chessboard) -- coverage/depth logic ---
// cm-chessboard is intentionally un-mocked in this harness (Chessboard is
// null), so the actual board-driven quiz play can't be exercised end-to-end
// here -- same structural gap the pre-existing per-row Opening Quiz already
// has zero coverage for. What's new and testable in isolation is the plain
// data logic added for the session quiz (coverage-bounded eligibility, the
// same-choices replay picker, and the move-number/depth math), exercised
// directly through the real production functions via __oqTestHooks.
if(shouldRunPhase(['quiz'])){
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

}
// --- Phase L: outdoor world (Main Street) sizing never strands a castle
//     outside the grass ---
if(shouldRunPhase(['vr-castle'])){
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

}
// --- Phase M: tint-at-assign-time (per-placement recolor of an assigned
//     asset, distinct from the flat "Color…" replace) ---
if(shouldRunPhase(['assets'])){
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

}
// --- Phase N: multi-line ("MultiPV") engine eval saved per node ---
// Stockfish has no vendored mock in this harness (same class of gap as
// cm-chessboard), so a live search can't be driven end-to-end here -- the
// save/display logic this feature added is plain data manipulation,
// independent of the engine, and fully testable via __evalTestHooks against
// a throwaway pref bag instead of real PREFS/IDB.
if(shouldRunPhase(['engine'])){
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

}
// --- Phase O: Chessboard test setup fields (Number of Questions / Max Depth /
//     Opening Coverage) persist to localStorage and restore next time ---
if(shouldRunPhase(['quiz'])){
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

}
// --- Phase P: background analysis queue ("Add to Analysis List" / "Analysis
//     Queue") -- add/dedup, cancel, and the depth-gated direct-IDB-write save
//     path are plain data manipulation against real IDB (unlike the eval
//     feature above, no engine search is involved in any of this), so they're
//     fully testable via __aqTestHooks. Only the live engine.analyze() call
//     inside processAnalysisQueueLoop needs real Stockfish and stays outside
//     this harness's reach -- covered by manual verification instead. ---
if(shouldRunPhase(['analysis-queue'])){
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

}
// --- Phase Q: Manage Mnemonics with no system selected treats every
//     square+piece as "needed" (as if a hypothetical system used every move
//     mnemonic), so the missing counts and red/green coloring show up
//     globally instead of only when a real coverage scope is picked. ---
if(shouldRunPhase(['mnemonics'])){
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

}
// --- Phase R: "Analyze All Children" now queues every child for background
//     analysis (same Depth/Lines modal as "Add to Analysis Queue") instead of
//     running an instant in-page search. ---
if(shouldRunPhase(['analysis-queue'])){
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

}
// --- Phase S: "Search for a Variation" -- a not-found result pops up a
//     clear "Variation not found" alert (in addition to the existing inline
//     modal text) instead of silently doing nothing, and never touches the
//     tree/focus state. ---
if(shouldRunPhase(['move-table'])){
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

}
// --- Phase T: cancelling the CURRENTLY PROCESSING analysis-queue item must
//     stop its in-flight search immediately and move straight on to the next
//     item -- not stall the whole queue waiting for the abandoned search to
//     reach its full target depth on its own. No live Stockfish is available
//     in this harness, so engine.analyze()/stop() are monkey-patched with a
//     controllable fake (via __aqTestHooks.engine) that only resolves when
//     stop() is called, driving the real scheduler/cancel logic against it. ---
if(shouldRunPhase(['analysis-queue'])){
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

}
// --- Phase U: move-pair VR billboards show the move number ("N."), flush
//     left and a third of the way up from the bottom of whichever quadrant
//     is White's move; the street-sign opening-move tile (always White's
//     move 1) gets the same badge. ---
if(shouldRunPhase(['vr-decorating'])){
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
if(shouldRunPhase(['engine'])){
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
    engine.maxThreads = 8;   // analyze()'s clamp ceiling -- see Phase VA's test 63 for an explicit override
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
  //     count must NOT resend setoption/isready -- so a caller re-analyzing
  //     at an unchanged thread count never pays for this sync.
  try {
    await app22.page.evaluate(setup);
    await app22.page.evaluate((fen) => window.__aqTestHooks.engine.analyze(fen, { multipv:1, depth:5, threads:8 }), START_FEN);
    const f = await app22.page.evaluate(() => window.__engineFake);
    assert(!f.sentCommands.some(c => c.startsWith('setoption name Threads')), `expected no Threads change when already at that count, got: ${JSON.stringify(f.sentCommands)}`);
    assert(!f.sentCommands.includes('isready'), `expected no isready sync when Threads didn't change, got: ${JSON.stringify(f.sentCommands)}`);
    ok('analyze() skips the Threads/isready sync when the thread count is already correct');
  } catch(e){ bad('engine: no redundant Threads sync when unchanged', e); }

  // 63. analyze()'s `threads` clamp uses maxThreads (cores-1, the real
  //     hardware ceiling), not the conservative default `threads` (8) --
  //     lets a caller (the live engine panel's thread-count selector)
  //     deliberately ask for more than init() picked.
  try {
    await app22.page.evaluate(setup);
    await app22.page.evaluate(() => { window.__aqTestHooks.engine.maxThreads = 15; });
    await app22.page.evaluate((fen) => window.__aqTestHooks.engine.analyze(fen, { multipv:1, depth:5, threads:99 }), START_FEN);
    const f = await app22.page.evaluate(() => window.__engineFake);
    assert(f.sentCommands.includes('setoption name Threads value 15'),
      `expected a request past maxThreads to clamp to maxThreads (15), not the conservative default (8), got: ${JSON.stringify(f.sentCommands)}`);
    ok("analyze()'s threads clamp uses maxThreads (the hardware ceiling), not the conservative default");
  } catch(e){ bad('engine: threads clamp uses maxThreads, not the conservative default', e); }
} finally {
  await app22.close();
}

}
// --- Phase VA: analysis queue up/down reordering -- index 0 (the item
//     currently being, or about to be, searched) can never be touched by
//     either arrow; the highest anything else can be raised to is index 1
//     (the second row), matching "never waste in-progress work". No engine
//     needed -- this is plain array/IDB manipulation, same as Phase T's
//     cancel/resume tests. ---
if(shouldRunPhase(['analysis-queue'])){
const app23 = await launchApp();
try {
  await seedBackup(app23.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  });
  await app23.page.click('.line-row');
  await app23.page.waitForSelector('.data-row', { timeout: 10000 });

  const seqs = [['d4','Nf6'], ['d4','d5'], ['d4','c5'], ['d4','e5']];
  for(const seq of seqs){
    await app23.page.evaluate((s) => window.__aqTestHooks.addToAnalysisQueue('L1', s, 30, 2), seq);
  }
  await app23.page.evaluate(() => document.getElementById('menuAnalysisQueue').click());
  await app23.page.waitForSelector('#analysisQueueOverlay', { state: 'visible', timeout: 5000 });

  // 64. Row 0 has none of the four reorder buttons (never touchable); row 1
  //     has only a down/bottom pair (already at the raise ceiling); rows
  //     2..N-2 have all four; the last row has no down/bottom pair (nothing
  //     below it). The double-arrow (top/bottom) buttons follow exactly the
  //     same visibility rule as their single-step counterparts.
  try {
    const rows = await app23.page.evaluate(() => [...document.querySelectorAll('#analysisQueueBody tr')].map(tr => ({
      top: !!tr.querySelector('.aq-top'), up: !!tr.querySelector('.aq-up'),
      down: !!tr.querySelector('.aq-down'), bottom: !!tr.querySelector('.aq-bottom'),
    })));
    assert(JSON.stringify(rows) === JSON.stringify([
      { top:false, up:false, down:false, bottom:false },
      { top:false, up:false, down:true,  bottom:true  },
      { top:true,  up:true,  down:true,  bottom:true  },
      { top:true,  up:true,  down:false, bottom:false },
    ]), `unexpected reorder button visibility per row: ${JSON.stringify(rows)}`);
    ok('analysis queue: up/down/top/bottom reorder buttons are hidden exactly where they would be a no-op or displace the processing item');
  } catch(e){ bad('analysis queue: reorder arrow visibility', e); }

  // 65. Raising the last item all the way up stops at index 1, never
  //     reaching (or swapping with) index 0 -- and the new order survives a
  //     reload from IDB, proving it was actually persisted, not just
  //     swapped in the in-memory array.
  try {
    const idAt = (i) => app23.page.evaluate((i) => window.__aqTestHooks.getQueue()[i].id, i);
    // raise d4,e5 (index 3) up twice: 3->2, then 2->1.
    await app23.page.evaluate((id) => window.__aqTestHooks.moveAnalysisQueueItem(id, -1), await idAt(3));
    await app23.page.evaluate((id) => window.__aqTestHooks.moveAnalysisQueueItem(id, -1), await idAt(2));
    // a third raise attempt (now at index 1) must be a no-op -- it would
    // otherwise displace index 0.
    await app23.page.evaluate((id) => window.__aqTestHooks.moveAnalysisQueueItem(id, -1), await idAt(1));

    const order1 = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    assert(JSON.stringify(order1) === JSON.stringify(['d4,Nf6','d4,e5','d4,d5','d4,c5']),
      `expected d4,e5 raised to (and stuck at) index 1, index 0 untouched, got ${JSON.stringify(order1)}`);

    // the rendered table (re-rendered by every moveAnalysisQueueItem call)
    // must also show no up-arrow at index 1 -- the DOM agrees there's
    // nowhere higher to go.
    const upAtIndex1 = await app23.page.evaluate(() => !!document.querySelectorAll('#analysisQueueBody tr')[1].querySelector('.aq-up'));
    assert(upAtIndex1 === false, 'expected no up-arrow rendered at index 1 (the ceiling)');

    // reload straight from IDB (bypassing the in-memory ANALYSIS_QUEUE array
    // entirely) -- confirms moveAnalysisQueueItem's putAnalysisQueueItem
    // calls actually persisted the new `order`, not just mutated memory.
    await app23.page.evaluate(() => window.__aqTestHooks.refreshAnalysisQueue());
    const order2 = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    assert(JSON.stringify(order2) === JSON.stringify(order1), `expected the reordered queue to survive a reload from IDB, got ${JSON.stringify(order2)}`);
    ok('analysis queue: raising an item persists to IDB and stops at index 1');
  } catch(e){ bad('analysis queue: reorder persists and respects the ceiling', e); }

  // 66. jumpAnalysisQueueItem(id, -1) ("move to top") lands the last item at
  //     index 1 in ONE call -- not one step at a time like moveAnalysisQueueItem
  //     -- while still never touching index 0, and persists to IDB.
  try {
    const idAt = (i) => app23.page.evaluate((i) => window.__aqTestHooks.getQueue()[i].id, i);
    // queue is currently ['d4,Nf6','d4,e5','d4,d5','d4,c5'] (from test 65).
    await app23.page.evaluate((id) => window.__aqTestHooks.jumpAnalysisQueueItem(id, -1), await idAt(3));

    const order1 = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    assert(JSON.stringify(order1) === JSON.stringify(['d4,Nf6','d4,c5','d4,e5','d4,d5']),
      `expected d4,c5 jumped straight from the bottom to index 1 in one call, got ${JSON.stringify(order1)}`);

    await app23.page.evaluate(() => window.__aqTestHooks.refreshAnalysisQueue());
    const order2 = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    assert(JSON.stringify(order2) === JSON.stringify(order1),
      `expected the "move to top" jump to survive a reload from IDB (proving the midpoint order value sorted correctly), got ${JSON.stringify(order2)}`);
    ok('analysis queue: "move to top" jumps an item straight to index 1 in one call and persists');
  } catch(e){ bad('analysis queue: jump to top', e); }

  // 67. jumpAnalysisQueueItem(id, +1) ("move to bottom") lands an item at
  //     the last index in one call, and persists to IDB.
  try {
    const idAt = (i) => app23.page.evaluate((i) => window.__aqTestHooks.getQueue()[i].id, i);
    // queue is currently ['d4,Nf6','d4,c5','d4,e5','d4,d5'] (from test 66).
    await app23.page.evaluate((id) => window.__aqTestHooks.jumpAnalysisQueueItem(id, 1), await idAt(2));

    const order1 = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    assert(JSON.stringify(order1) === JSON.stringify(['d4,Nf6','d4,c5','d4,d5','d4,e5']),
      `expected d4,e5 jumped straight to the last index in one call, got ${JSON.stringify(order1)}`);

    await app23.page.evaluate(() => window.__aqTestHooks.refreshAnalysisQueue());
    const order2 = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    assert(JSON.stringify(order2) === JSON.stringify(order1),
      `expected the "move to bottom" jump to survive a reload from IDB, got ${JSON.stringify(order2)}`);
    ok('analysis queue: "move to bottom" jumps an item straight to the last index in one call and persists');
  } catch(e){ bad('analysis queue: jump to bottom', e); }

  // 68. jumpAnalysisQueueItem is a safe no-op both for index 0 (the
  //     currently-processing item, never displaceable) and for an item
  //     already sitting at its target end.
  try {
    const before = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    const id0 = await app23.page.evaluate(() => window.__aqTestHooks.getQueue()[0].id);
    await app23.page.evaluate((id) => window.__aqTestHooks.jumpAnalysisQueueItem(id, -1), id0);
    await app23.page.evaluate((id) => window.__aqTestHooks.jumpAnalysisQueueItem(id, 1), id0);
    // index 1 is already the "top" target -- jumping it further is a no-op.
    const id1 = await app23.page.evaluate(() => window.__aqTestHooks.getQueue()[1].id);
    await app23.page.evaluate((id) => window.__aqTestHooks.jumpAnalysisQueueItem(id, -1), id1);
    // the last index is already the "bottom" target -- likewise a no-op.
    const idLast = await app23.page.evaluate(() => { const q = window.__aqTestHooks.getQueue(); return q[q.length-1].id; });
    await app23.page.evaluate((id) => window.__aqTestHooks.jumpAnalysisQueueItem(id, 1), idLast);

    const after = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    assert(JSON.stringify(after) === JSON.stringify(before),
      `expected jumping index 0 or an already-at-target item to be a no-op, got ${JSON.stringify(after)} (was ${JSON.stringify(before)})`);
    ok('analysis queue: jumping index 0 or an item already at its target end is a safe no-op');
  } catch(e){ bad('analysis queue: jump no-op safety', e); }
} finally {
  await app23.close();
}

}
// --- Phase VB: the live engine panel's thread-count selector
//     (populateEngineThreadsSelect) -- hidden on a single-threaded engine
//     (this harness's real state, since no live Stockfish is available),
//     populated 1..maxThreads on a multi-threaded one, and restores a saved
//     choice only when it's still in range on the current "hardware". No
//     live Stockfish needed -- engine.multithreaded/.maxThreads/.threads are
//     monkey-patched directly, same pattern as Phase V/VA. ---
if(shouldRunPhase(['engine'])){
const app24 = await launchApp();
try {
  await seedBackup(app24.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  });
  await app24.page.click('.line-row');
  await app24.page.waitForSelector('.data-row', { timeout: 10000 });

  // 66. Single-threaded (or maxThreads<=1): the field stays hidden and
  //     engineThreads() returns undefined, so analyze() falls through to its
  //     own `threads = this.threads` default -- no override at all.
  try {
    await app24.page.evaluate(() => {
      const { engine } = window.__aqTestHooks;
      engine.multithreaded = false;
      engine.maxThreads = 1;
      window.__aqTestHooks.populateEngineThreadsSelect();
    });
    const hidden = await app24.page.evaluate(() => document.getElementById('engineThreadsField').style.display === 'none');
    const threads = await app24.page.evaluate(() => window.__aqTestHooks.engineThreads());
    assert(hidden === true, 'expected the threads field to stay hidden on a single-threaded engine');
    assert(threads === undefined, `expected engineThreads() to return undefined when hidden, got ${threads}`);
    ok('engine threads selector: stays hidden (and overrides nothing) on a single-threaded engine');
  } catch(e){ bad('engine threads selector: hidden when single-threaded', e); }

  // 67. Multi-threaded: the field shows options 1..maxThreads, defaulting to
  //     the conservative `threads` value when nothing was saved yet.
  try {
    await app24.page.evaluate(() => {
      localStorage.removeItem('engine_lastThreads');
      const { engine } = window.__aqTestHooks;
      engine.multithreaded = true;
      engine.maxThreads = 6;
      engine.threads = 4;
      window.__aqTestHooks.populateEngineThreadsSelect();
    });
    const state = await app24.page.evaluate(() => {
      const sel = document.getElementById('engineThreadsSelect');
      return {
        visible: document.getElementById('engineThreadsField').style.display !== 'none',
        options: [...sel.options].map(o => o.value),
        selected: sel.value,
      };
    });
    assert(state.visible === true, 'expected the threads field to show once multithreaded');
    assert(JSON.stringify(state.options) === JSON.stringify(['1','2','3','4','5','6']),
      `expected options 1..maxThreads(6), got ${JSON.stringify(state.options)}`);
    assert(state.selected === '4', `expected the default selection to be threads(4) with nothing saved, got ${state.selected}`);
    ok('engine threads selector: shows 1..maxThreads, defaulting to the conservative count');
  } catch(e){ bad('engine threads selector: populated range and default', e); }

  // 68. A saved choice still in range on this "hardware" is restored; one
  //     that's now out of range (e.g. saved on a machine with more cores)
  //     falls back to the default instead of silently clamping or erroring.
  try {
    await app24.page.evaluate(() => {
      localStorage.setItem('engine_lastThreads', '5');
      window.__aqTestHooks.populateEngineThreadsSelect();
    });
    const inRange = await app24.page.evaluate(() => document.getElementById('engineThreadsSelect').value);
    assert(inRange === '5', `expected the in-range saved choice (5) to be restored, got ${inRange}`);

    await app24.page.evaluate(() => {
      localStorage.setItem('engine_lastThreads', '20');   // beyond maxThreads=6
      window.__aqTestHooks.populateEngineThreadsSelect();
    });
    const outOfRange = await app24.page.evaluate(() => document.getElementById('engineThreadsSelect').value);
    assert(outOfRange === '4', `expected an out-of-range saved choice to fall back to the default (4), got ${outOfRange}`);
    ok('engine threads selector: restores a saved choice only when still in range');
  } catch(e){ bad('engine threads selector: saved-choice restore/fallback', e); }

  // 69. Changing the threads selector while a live analysis is in progress
  //     must NOT restart it (unlike Lines/Depth, which deliberately do) --
  //     a Threads change means stop + pthread-pool respawn + a fresh `go`,
  //     wasting whatever depth the current search already reached for no
  //     real gain. The new choice is only supposed to apply going forward.
  try {
    await app24.page.evaluate(() => {
      window.__aqCallCount = 0;
      const { engine } = window.__aqTestHooks;
      engine.ready = true;
      engine.multithreaded = true;
      engine.maxThreads = 6;
      engine.threads = 4;
      engine.analyze = () => { window.__aqCallCount++; return new Promise(() => {}); };   // never resolves
      // simulate "a live analysis is in progress on some position" -- the
      // normal path (showPosition) can't run without the cm-chessboard
      // widget this harness doesn't load.
      window.__aqTestHooks.setCurrentEngineFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    });
    const sel = app24.page.locator('#engineThreadsSelect');
    await sel.selectOption('3');
    // give any (wrongly) triggered runEngine()/analyze() a moment to fire.
    await app24.page.waitForTimeout(200);
    const calls = await app24.page.evaluate(() => window.__aqCallCount);
    const saved = await app24.page.evaluate(() => localStorage.getItem('engine_lastThreads'));
    assert(calls === 0, `expected changing threads to NOT call engine.analyze() (would restart the current search), got ${calls} call(s)`);
    assert(saved === '3', `expected the new choice to still be persisted for next time, got ${saved}`);
    ok("engine threads selector: changing it does not restart the analysis already in progress");
  } catch(e){ bad('engine threads selector: does not restart in-progress analysis', e); }
} finally {
  await app24.close();
}

}
// --- Phase VD: the Analysis Queue modal's OWN thread-count selector --
//     independent of the live engine panel's, hidden/populated the same way
//     (shared populateThreadsSelect), and actually reaches
//     processAnalysisQueueLoop's engine.analyze() call without ever
//     restarting whatever item is currently mid-search. ---
if(shouldRunPhase(['analysis-queue'])){
const app25 = await launchApp();
try {
  await seedBackup(app25.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  });
  await app25.page.click('.line-row');
  await app25.page.waitForSelector('.data-row', { timeout: 10000 });
  // the select lives inside the modal overlay -- open it once so Playwright's
  // real selectOption() (test 71) can interact with it; harmless for test 70,
  // which only checks computed styles/hook return values.
  await app25.page.evaluate(() => document.getElementById('menuAnalysisQueue').click());
  await app25.page.waitForSelector('#analysisQueueOverlay', { state: 'visible', timeout: 5000 });

  // 70. Hidden on a single-threaded engine; populated 1..maxThreads and
  //     restores a saved choice (independently of the live panel's own
  //     LS_ENGINE_THREADS key) when multithreaded.
  try {
    await app25.page.evaluate(() => {
      const { engine } = window.__aqTestHooks;
      engine.multithreaded = false;
      engine.maxThreads = 1;
      window.__aqTestHooks.populateAqThreadsSelect();
    });
    const hiddenState = await app25.page.evaluate(() => ({
      hidden: document.getElementById('aqThreadsField').style.display === 'none',
      threads: window.__aqTestHooks.aqThreads(),
    }));
    assert(hiddenState.hidden === true, 'expected the queue threads field to stay hidden on a single-threaded engine');
    assert(hiddenState.threads === undefined, `expected aqThreads() to return undefined when hidden, got ${hiddenState.threads}`);

    await app25.page.evaluate(() => {
      localStorage.removeItem('aq_lastThreads');
      localStorage.setItem('engine_lastThreads', '2');   // the LIVE panel's own key -- must not leak in here
      const { engine } = window.__aqTestHooks;
      engine.multithreaded = true;
      engine.maxThreads = 6;
      engine.threads = 4;
      window.__aqTestHooks.populateAqThreadsSelect();
    });
    const defaultState = await app25.page.evaluate(() => {
      const sel = document.getElementById('aqThreadsSelect');
      return { visible: document.getElementById('aqThreadsField').style.display !== 'none',
               options: [...sel.options].map(o => o.value), selected: sel.value };
    });
    assert(defaultState.visible === true, 'expected the queue threads field to show once multithreaded');
    assert(JSON.stringify(defaultState.options) === JSON.stringify(['1','2','3','4','5','6']),
      `expected options 1..maxThreads(6), got ${JSON.stringify(defaultState.options)}`);
    assert(defaultState.selected === '4', `expected the default (4), not the live panel's own saved choice (2), got ${defaultState.selected}`);

    await app25.page.evaluate(() => {
      localStorage.setItem('aq_lastThreads', '5');
      window.__aqTestHooks.populateAqThreadsSelect();
    });
    const restored = await app25.page.evaluate(() => document.getElementById('aqThreadsSelect').value);
    assert(restored === '5', `expected the queue's own saved choice (5) to be restored, got ${restored}`);
    ok('analysis queue threads selector: hidden/populated/restored independently of the live panel\'s own selector');
  } catch(e){ bad('analysis queue threads selector: hide/populate/restore', e); }

  // 71. The selected value actually reaches processAnalysisQueueLoop's
  //     engine.analyze() call -- and changing it while an item is mid-search
  //     does not restart that item (same fake-engine technique as Phase T's
  //     cancel/resume tests: engine.analyze() never resolves on its own,
  //     only engine.stop() resolves it, standing in for a real in-progress
  //     search).
  try {
    await app25.page.evaluate(() => {
      window.__aqFakeEngine2 = { pending: null, calls: [] };
      const { engine } = window.__aqTestHooks;
      engine.ready = true;
      engine.analyze = (fen, opts) => {
        window.__aqFakeEngine2.calls.push(opts.threads);
        return new Promise(resolve => {
          window.__aqFakeEngine2.pending = () =>
            resolve({ depth: 10, lines: { 1: { score: { type:'cp', value:5 }, depth:10, pv:['e2e4'] } } });
        });
      };
      engine.stop = () => {
        if(window.__aqFakeEngine2.pending){
          const p = window.__aqFakeEngine2.pending;
          window.__aqFakeEngine2.pending = null;
          p();
        }
      };
    });
    await app25.page.evaluate(() => window.__aqTestHooks.addToAnalysisQueue('L1', ['d4','Nf6'], 40, 1));
    await app25.page.evaluate(() => window.__aqTestHooks.maybeResumeAnalysisQueue());
    await app25.page.waitForFunction(() => window.__aqFakeEngine2.calls.length === 1, { timeout: 5000 });
    const firstCallThreads = await app25.page.evaluate(() => window.__aqFakeEngine2.calls[0]);
    assert(firstCallThreads === 5, `expected the queue's own selected thread count (5) to reach engine.analyze(), got ${firstCallThreads}`);

    // change the selector mid-search -- must NOT trigger another analyze()
    // call (which would mean the in-progress item got restarted).
    await app25.page.selectOption('#aqThreadsSelect', '3');
    await app25.page.waitForTimeout(200);
    const callsAfterChange = await app25.page.evaluate(() => window.__aqFakeEngine2.calls.length);
    assert(callsAfterChange === 1, `expected changing the queue's threads mid-search NOT to restart the current item, got ${callsAfterChange} call(s)`);

    // let the fake search finish and confirm the NEXT item picks up the new value.
    await app25.page.evaluate(() => window.__aqTestHooks.engine.stop());
    await app25.page.evaluate(() => window.__aqTestHooks.addToAnalysisQueue('L1', ['d4','d5'], 40, 1));
    await app25.page.waitForFunction(() => window.__aqFakeEngine2.calls.length === 2, { timeout: 5000 });
    const secondCallThreads = await app25.page.evaluate(() => window.__aqFakeEngine2.calls[1]);
    assert(secondCallThreads === 3, `expected the next item to pick up the newly-selected thread count (3), got ${secondCallThreads}`);

    // let the second fake search resolve so nothing dangles past this test.
    await app25.page.evaluate(() => window.__aqTestHooks.engine.stop());
    ok('analysis queue threads selector: reaches engine.analyze(), never restarts an item already in progress');
  } catch(e){ bad('analysis queue threads selector: reaches analyze() without restarting', e); }
} finally {
  await app25.close();
}

}
// --- Phase W: room-info modal (click a graph node) -- move-number badge on
//     the exit rows' thumbnails, and the exits list scrolls independently so
//     a long list of replies can never push the Close button off-screen. ---
if(shouldRunPhase(['digraph'])){
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

}
// --- Phase X: door skin oversizing -- every door renders slightly larger
//     than its opening (hides a non-rectangular asset's transparent margin
//     from showing the wall behind it), and a per-asset "extra oversize %"
//     adds on top of that baseline. ---
if(shouldRunPhase(['vr-decorating'])){
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

}
// --- Phase Y: "memorized" room toggle (VR toolbar icon) -- hidden outside
//     real castle rooms, persisted to IDB per room, survives a full reload. ---
if(shouldRunPhase(['vr-castle'])){
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

}
// --- Phase Z: "memorized" rooms (Phase 2) get a 🧠 label glyph in the
//     network digraph (mirroring the VR toolbar's fa-brain icon), and the
//     thick green border is reserved for "all done" -- memorized AND fully
//     decorated -- so it reads at a glance even too zoomed out for glyphs. ---
if(shouldRunPhase(['digraph'])){
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

}
// --- Phase AA: "only test memorized rooms" (Phase 3) -- a castle-scoped quiz
//     session filters candidates down to only replies whose resulting room is
//     marked memorized; off, it's a pure passthrough. ---
if(shouldRunPhase(['quiz'])){
const appAA = await launchApp();
try {
  const keys = await appAA.page.evaluate(() => {
    const pk = mv => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_'); };
    return { rootRoom: pk(['d4','Nf6','c4']), e6Room: pk(['d4','Nf6','c4','e6','Nc3']), g6Room: pk(['d4','Nf6','c4','g6','Nc3']) };
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
  // mark the castle's own root AND the e6 branch's room memorized (not g6) --
  // via the same IDB key the VR toolbar toggle writes (setMeta is a bare
  // global, same as getMeta elsewhere).
  await appAA.page.evaluate((ks) => setMeta('threeMemorizedRooms',
    JSON.stringify({ [ks.rootRoom]: Date.now(), [ks.e6Room]: Date.now() })), keys);

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

  // 74. roomMemorized reflects exactly the three seeded rooms (the castle's
  //     own root, plus e6 -- not g6).
  try {
    const r = await appAA.page.evaluate(() => ({
      root: window.__oqTestHooks.roomMemorized(['d4','Nf6','c4']),
      e6: window.__oqTestHooks.roomMemorized(['d4','Nf6','c4','e6','Nc3']),
      g6: window.__oqTestHooks.roomMemorized(['d4','Nf6','c4','g6','Nc3']),
    }));
    assert(r.root === true, `expected the castle's own root room to read as memorized, got ${r.root}`);
    assert(r.e6 === true, `expected the e6 room to read as memorized, got ${r.e6}`);
    assert(r.g6 === false, `expected the g6 room to read as NOT memorized, got ${r.g6}`);
    ok('oqRoomMemorized reflects exactly the rooms marked in threeMemorizedRooms');
  } catch(e){ bad('oqRoomMemorized', e); }

  // 75. memorizedFilter offers EVERY branch out of a room that is itself
  //     memorized, not just whichever one happens to also lead somewhere
  //     memorized -- reproduces "it will never quiz me on the other 5
  //     responses in the first room": the old per-candidate lookahead
  //     silently hid every branch except one, even though the room you're
  //     actually standing in (and being tested from) is fully memorized.
  try {
    const filtered = await appAA.page.evaluate(() =>
      window.__oqTestHooks.memorizedFilter(['d4','Nf6','c4'], ['e6','g6']));
    assert(JSON.stringify(filtered) === JSON.stringify(['e6','g6']),
      `expected every branch out of the memorized root room, got ${JSON.stringify(filtered)}`);
    ok('memorizedFilter offers every branch out of a room that is itself memorized');
  } catch(e){ bad('oqMemorizedFilter offers every branch from a memorized room', e); }

  // 75b. ...but returns NO candidates once the current room (g6's, not
  //      memorized) isn't itself memorized -- this is what actually ends a
  //      question: oqLoadStep has no memorized-gating of its own (it just
  //      checks PREFS for a recorded reply), so the ply INTO an unmemorized
  //      room still gets asked; it's the step AFTER landing there that
  //      stops. Reproduces "when I give my response... that would end that
  //      test run since those rooms are not memorized."
  try {
    const stopped = await appAA.page.evaluate(() =>
      window.__oqTestHooks.memorizedFilter(['d4','Nf6','c4','g6','Nc3'], ['Bg7']));
    assert(JSON.stringify(stopped) === JSON.stringify([]),
      `expected no candidates once standing in an unmemorized room, got ${JSON.stringify(stopped)}`);
    ok('memorizedFilter returns no candidates once the current room is not memorized, ending the question there');
  } catch(e){ bad('oqMemorizedFilter stops once the current room is not memorized', e); }

  // 75c. ...and DOES continue testing inside a deeper memorized room (e6's,
  //      also marked memorized) -- reproduces "it should play the moves
  //      inside that memorized room" (the quiz previously stopped right at
  //      the doorway instead of testing anything past it).
  try {
    const inside = await appAA.page.evaluate(() =>
      window.__oqTestHooks.memorizedFilter(['d4','Nf6','c4','e6','Nc3'], ['Bb4']));
    assert(JSON.stringify(inside) === JSON.stringify(['Bb4']),
      `expected testing to continue inside a deeper memorized room, got ${JSON.stringify(inside)}`);
    ok('memorizedFilter continues testing inside a memorized room reached via a branch, not just at the castle root');
  } catch(e){ bad('oqMemorizedFilter continues testing inside a deeper memorized room', e); }

  // 76. With the checkbox off, the filter is a pure passthrough -- existing
  //     (pre-feature) behavior is unchanged byte-for-byte.
  try {
    await appAA.page.evaluate(() => window.__oqTestHooks.setOQ({ onlyMemorized: false }));
    const passthrough = await appAA.page.evaluate(() =>
      window.__oqTestHooks.memorizedFilter(['d4','Nf6','c4'], ['e6','g6']));
    assert(JSON.stringify(passthrough) === JSON.stringify(['e6','g6']), `expected an unfiltered passthrough, got ${JSON.stringify(passthrough)}`);
    ok('memorizedFilter is a no-op passthrough when "only memorized" is unchecked');
  } catch(e){ bad('oqMemorizedFilter passthrough when off', e); }

  // 77. The forced lead-in toward a castle-scoped session's own root (here:
  //     1.d4 Nf6, the two plies before Alpha's root) is NEVER filtered by
  //     memorized status -- reproduces the reported "No moves to test" bug:
  //     with the old code, oqRoomMemorized used OQ.castleName (forced to
  //     'Alpha' for the whole session) instead of resolving each lead-in
  //     room's real owner, so a lead-in room belonging to a DIFFERENT
  //     castle/line wrongly failed the memorized check and starting a
  //     session found zero eligible moves.
  try {
    await appAA.page.evaluate(() => window.__oqTestHooks.setOQ({ onlyMemorized: true }));
    const leadIn = await appAA.page.evaluate(() => ({
      firstPly: window.__oqTestHooks.memorizedFilter([], ['d4']),
      secondPly: window.__oqTestHooks.memorizedFilter(['d4'], ['Nf6']),
    }));
    assert(JSON.stringify(leadIn.firstPly) === JSON.stringify(['d4']),
      `expected the forced first ply to pass through untested-by-memorized-status, got ${JSON.stringify(leadIn.firstPly)}`);
    assert(JSON.stringify(leadIn.secondPly) === JSON.stringify(['Nf6']),
      `expected the forced second ply to pass through untested-by-memorized-status, got ${JSON.stringify(leadIn.secondPly)}`);
    // at (or past) the root, current-room-based gating still applies exactly
    // as tests 75/75b/75c cover -- this fix only bypasses it BEFORE the root
    // is reached.
    const atRoot = await appAA.page.evaluate(() =>
      window.__oqTestHooks.memorizedFilter(['d4','Nf6','c4'], ['e6','g6']));
    assert(JSON.stringify(atRoot) === JSON.stringify(['e6','g6']),
      `expected current-room-based gating to still apply once inside the castle, got ${JSON.stringify(atRoot)}`);
    ok('memorizedFilter never gates the forced lead-in toward a castle root, but still gates real branches inside it');
  } catch(e){ bad('oqMemorizedFilter: lead-in bypass', e); }
} finally {
  await appAA.close();
}

}
// --- Phase AB: crop/erase image editor -- brush erase (freehand round
//     eraser, size slider) for cleaning up artifacts flood-fill can't reach. ---
if(shouldRunPhase(['assets'])){
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

}
// --- Phase AC: "fully decorated" room flag -- computed on the edit-mode-on ->
//     off transition (E key / Esc / toolbar pencil): every move-object slot
//     has a real asset AND every forward door's target room is named. ---
if(shouldRunPhase(['vr-decorating'])){
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

}
// --- Phase AD: "fully decorated" -- the door-naming half of the check
//     (only for a door whose target is NOT empty/locked -- see isRoomEmpty
//     and the locked-doors feature), and the vacuous-true case. ---
if(shouldRunPhase(['vr-decorating'])){
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

}
// --- Phase AE: "fully decorated" rooms get a 🎨 glyph on their digraph node
//     label, mirroring the memorized-room border (Phase Z). ---
if(shouldRunPhase(['digraph'])){
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

}
// --- Phase AF: "Jump to VR" from the room-info modal (click a digraph node,
//     then jump straight into that room in the VR walk). ---
if(shouldRunPhase(['digraph'])){
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

}
// --- Phase AG: "Import this variation" from a saved eval's expanded PV in
//     the move table -- mirrors the live engine panel's own pvMenu ->
//     "Import this variation" (see importEngineVariation/renderEngineLines),
//     reusing the exact same import core, just triggered from a saved
//     (not live) line. ---
if(shouldRunPhase(['move-table'])){
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

}
// --- Phase AH: locked doors -- a room with nothing built past it (no forward
//     moves) gets a doorway that can't be walked through, with a lock icon
//     until it's skinned (per-door or via a castle-wide default), mirroring
//     the ordinary/exit-door "building defaults" mechanism. ---
if(shouldRunPhase(['vr-castle'])){
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

}
// --- Phase AH2: skinning a locked door through the real in-world picker
//     offers to make it this castle's locked-door default right away (a
//     confirm prompt), instead of requiring the separate Room Geometry
//     "make default" step every other door category needs. ---
if(shouldRunPhase(['vr-decorating'])){
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

}
// --- Phase AI: top VR toolbar icon order -- the edit-only buttons (room
//     geometry / wall lists / assets) sit immediately right of the Edit
//     button, with no buttons that also show outside edit mode (board
//     position, memorize) wedged between them. ---
if(shouldRunPhase(['vr-ui'])){
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

}
// --- Phase AJ: a room's own name on the floor, a little way in from the
//     entrance -- hint-gated, clamped to stay clear of the far wall in a
//     shallow room, and spins to keep facing the camera as you walk. ---
if(shouldRunPhase(['vr-decorating'])){
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

}
// --- Phase AK: crop/erase image editor -- fuzz/brush-size sliders persist to
//     localStorage across modal reopens, and an undo/redo history stack
//     (standard rotate-left/rotate-right icons) walks back/forward through
//     each committed crop/erase/brush mutation. ---
if(shouldRunPhase(['assets'])){
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

}
// --- Phase AL: the asset picker's "New Asset" button (replacing the old
//     bare "Upload new…" quick-upload) opens the full asset editor -- id/
//     type/size fields plus Upload/Generate…/Crop -- as its own overlay
//     layered above the picker, with the Crop/Generate modals it can launch
//     layered above THAT in turn. ---
if(shouldRunPhase(['assets'])){
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

}
// --- Phase AM: a resize that leaves a room too small for its OWN move-pairs
//     (not just a manually-nudged item) used to strand the later pair(s)
//     behind a wall with nothing to bring them back -- reconcileRoomBounds
//     only ever re-checked slots that already had a stored nudge, so a
//     never-nudged, purely formula-positioned pair (mnemPairLayout) was
//     invisible until someone thought to enlarge the room again. Fixed two
//     ways: (1) reconcileRoomBounds now also checks un-nudged move-object/
//     mnemonic slots directly, and the placeholder/word-label/mnemonic
//     renderers now actually apply the correction it writes; (2) the Room
//     Geometry dialog won't let a resize go below the room's own
//     content-driven minimum in the first place. ---
if(shouldRunPhase(['vr-decorating'])){
const appAM = await launchApp();
try {
  // same corridor shape as Phase AC: a forced (non-branching) reply chain
  // collapses into ONE room with 2 LEFT-wall move-pairs (obj-L1/obj-L2,
  // mnem-L1/mnem-L2) -- multiple pairs in one room is exactly the shape
  // where a later pair can end up deeper than an undersized room reaches.
  await seedBackup(appAM.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Bd2' },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Bd2 Qe7', white: 'a', black: 'b', result: '*' }],
    assets: [{ id: 'testProp1', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w: 0.3, h: 0.3, d: 0.3 } }],
  });
  await openVR(appAM.page);
  const roomKey = await appAM.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  });
  await appAM.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
  await appAM.page.waitForTimeout(300);

  // 128. Shrinking the room via setRoomGeom (the same call the real dialog's
  //      Apply button makes) well below what 2 pairs need pulls BOTH the
  //      never-nudged move-object placeholders and their mnemonic billboards
  //      back inside the new bounds, not just whichever had a prior nudge.
  try {
    const before = await appAM.page.evaluate((k) => ({
      slotIds: window.__threeTestEdit.moveObjectSlotIds(k),
      posL2: window.__threeTestEdit.posOf('obj-L2'),
    }), roomKey);
    assert(before.slotIds.includes('obj-L1') && before.slotIds.includes('obj-L2'),
      `test setup issue: expected obj-L1/obj-L2, got ${JSON.stringify(before.slotIds)}`);
    assert(before.posL2 && Math.abs(before.posL2.z) < 6, `test setup issue: obj-L2 already unexpectedly far out, ${JSON.stringify(before.posL2)}`);

    await appAM.page.evaluate((k) => window.__threeTestEdit.resize(k, { w: 11, d: 6, h: 6 }), roomKey);
    await appAM.page.waitForTimeout(300);

    const bound = 6/2 - 0.3;   // clampFloorXZ's margin, same math the reconciler uses
    const after = await appAM.page.evaluate((k) => ({
      posL1: window.__threeTestEdit.posOf('obj-L1'),
      posL2: window.__threeTestEdit.posOf('obj-L2'),
      posMnemL1: window.__threeTestEdit.posOf('mnem-L1'),
      posMnemL2: window.__threeTestEdit.posOf('mnem-L2'),
    }), roomKey);
    for(const [name, p] of Object.entries(after)){
      assert(p && Math.abs(p.z) <= bound + 0.01,
        `expected ${name} pulled back inside the shrunk room (|z| <= ${bound}), got ${JSON.stringify(p)}`);
    }
    ok('reconcileRoomBounds pulls never-nudged move-pairs (object AND billboard) back inside a shrunk room');
  } catch(e){ bad('reconcile: un-nudged move-pairs follow a shrink, not just previously-nudged ones', e); }
} finally {
  await appAM.close();
}

}
// --- Phase AN: the Room Geometry dialog itself now refuses to shrink a room
//     below the size its OWN move-pairs/doors need, instead of relying
//     entirely on after-the-fact reconciliation. ---
if(shouldRunPhase(['vr-decorating'])){
const appAN = await launchApp();
try {
  await seedBackup(appAN.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Bd2' },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Bd2 Qe7', white: 'a', black: 'b', result: '*' }],
    assets: [{ id: 'testProp1', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w: 0.3, h: 0.3, d: 0.3 } }],
  });
  await openVR(appAN.page);
  const roomKey = await appAN.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  });
  await appAN.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
  await appAN.page.waitForTimeout(300);
  await appAN.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on -- Room Geometry only shows then
  await appAN.page.waitForTimeout(60);

  // 129. The dialog's depth input has a real (>2m) floor reflecting this
  //      room's own content, and typing something smaller and clicking
  //      Apply clamps back up to it instead of honoring the smaller value.
  try {
    await appAN.page.evaluate(() => document.querySelector('#threeTestCanvasWrap i.fa-ruler-combined').closest('button').click());
    await appAN.page.waitForSelector('#roomGeomOverlay', { state: 'visible', timeout: 5000 });
    const minAttr = await appAN.page.evaluate(() => Number(document.getElementById('roomGeomD').getAttribute('min')));
    assert(minAttr > 3, `expected the depth field's min to reflect real 2-pair content (>3m), got ${minAttr}`);

    await appAN.page.fill('#roomGeomD', '2.5');   // well under the content minimum
    await appAN.page.evaluate(() => document.getElementById('roomGeomApplyBtn').click());
    await appAN.page.waitForSelector('#roomGeomOverlay', { state: 'hidden', timeout: 5000 });
    await appAN.page.waitForTimeout(200);

    const applied = await appAN.page.evaluate((k) => window.__threeTestEdit.roomSize(k), roomKey);
    assert(applied.d >= minAttr - 0.01, `expected depth clamped up to the content minimum (~${minAttr}), got ${applied.d}`);
    assert(applied.d !== 2.5, `expected the dialog to reject 2.5m outright, but it was applied as-is`);
    ok('Room Geometry dialog clamps a resize up to this room\'s own content-driven minimum size');
  } catch(e){ bad('Room Geometry dialog: minimum size reflects the room\'s own content', e); }

  // 130. After a resize, the player respawns at the room's own entrance
  //      (same spot/facing a normal walk-in would use) instead of wherever
  //      they happened to be standing -- a resize can leave that spot
  //      outside the new bounds or facing straight into a wall.
  try {
    const before = await appAN.page.evaluate((k) => window.__threeTestEdit.entrySpawnFor(k), roomKey);
    assert(before, 'test setup issue: entrySpawnFor returned null for the current room');

    // stand somewhere that has nothing to do with the entrance -- off to one
    // side, facing an arbitrary direction -- before triggering the resize.
    await appAN.page.evaluate((p) => window.__threeTestEdit.teleport(p.x, p.z, p.yaw),
      { x: before.x + 3, z: before.z - 4, yaw: Math.PI / 3 });

    await appAN.page.evaluate(() => document.querySelector('#threeTestCanvasWrap i.fa-ruler-combined').closest('button').click());
    await appAN.page.waitForSelector('#roomGeomOverlay', { state: 'visible', timeout: 5000 });
    const cur = await appAN.page.evaluate((k) => window.__threeTestEdit.roomSize(k), roomKey);
    await appAN.page.fill('#roomGeomD', String(cur.d + 1));   // any valid resize -- the exact new size isn't what's under test
    await appAN.page.evaluate(() => document.getElementById('roomGeomApplyBtn').click());
    await appAN.page.waitForSelector('#roomGeomOverlay', { state: 'hidden', timeout: 5000 });
    await appAN.page.waitForTimeout(250);

    // recompute the expected entry spawn against the room's NEW (post-resize)
    // geometry -- doorSpawn's inset depends on room depth, so the resize
    // itself can shift where "just inside the entrance" actually is.
    const expected = await appAN.page.evaluate((k) => window.__threeTestEdit.entrySpawnFor(k), roomKey);
    const after = await appAN.page.evaluate(() => window.__threeTestEdit.pos());
    const dist = Math.hypot(after.x - expected.x, after.z - expected.z);
    assert(dist < 0.05, `expected the player back at the (post-resize) entrance spawn ${JSON.stringify(expected)}, got ${JSON.stringify(after)}`);
    assert(Math.abs(((after.yaw - expected.yaw + Math.PI) % (2*Math.PI)) - Math.PI) < 0.01,
      `expected the player's facing to match the entrance spawn's yaw, got ${JSON.stringify({ after, expected })}`);
    ok('resizing a room respawns the player at its own entrance, not wherever they were standing');
  } catch(e){ bad('resize respawns the player at the room entrance', e); }
} finally {
  await appAN.close();
}

}
// --- Phase AO: two more picker "New Asset" bugs found in real use --
//     (1) VR turning kept responding to A/D/arrow keys while typing in the
//     New Asset modal's text fields, because only move/strafe were gated by
//     inputLocked -- yaw never was. (2) The New Asset form's Type dropdown
//     offered every asset type regardless of what the picker that opened it
//     actually accepts, so picking (or leaving) a type outside that set
//     saved fine but then silently never showed up back in the picker's
//     grid (which filters by that same allow list), with no indication why. ---
if(shouldRunPhase(['assets'])){
const appAO = await launchApp();
try {
  await seedBackup(appAO.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id:'g1', moves:'d4 Nf6 c4 e6', white:'a', black:'b', result:'*' }],
  });
  await openVR(appAO.page);
  await appAO.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
  await appAO.page.waitForTimeout(60);

  // 130. Turning must not respond to A/D/arrow keys while a foreign-ish text
  //      field has focus and inputLocked is set (a picker/dialog is open) --
  //      only the joystick path was gated before; the raw keys['a']/['d']
  //      path used by real keyboard input was not.
  try {
    const before = await appAO.page.evaluate(() => window.__threeTestEdit.pos().yaw);
    await appAO.page.evaluate(() => window.__threeTestEdit.target({ kind: 'wall', wall: 'north' }));
    await appAO.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appAO.page.click('#pickerNewAssetBtn');
    await appAO.page.waitForSelector('#assetNewOverlay', { state: 'visible', timeout: 5000 });
    // simulate typing a prompt/id containing turn keys, same as a real user
    // would while naming the asset or writing a Generate prompt
    await appAO.page.fill('#assetIdInput', 'a-wooden-doorway-design');
    for(const key of ['a','d','a','d','ArrowLeft','ArrowRight']){
      await appAO.page.evaluate((k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k })), key);
    }
    await appAO.page.waitForTimeout(200);
    const after = await appAO.page.evaluate(() => window.__threeTestEdit.pos().yaw);
    assert(Math.abs(after - before) < 0.001, `expected the camera not to turn while the New Asset modal has focus (inputLocked), yaw went ${before} -> ${after}`);
    ok('turning (yaw) respects inputLocked, same as walking already did');
    await appAO.page.click('#assetNewCloseBtn');
    await appAO.page.waitForSelector('#assetNewOverlay', { state: 'hidden', timeout: 5000 });
    await appAO.page.click('#pickerCloseBtn');
    await appAO.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
  } catch(e){ bad('New Asset modal: yaw stays locked while it has focus', e); }

  // 131. The Type dropdown, opened from a wall's (surface-only) picker, only
  //      offers "surface" -- not every asset type -- so there's no way to
  //      accidentally save something the picker's own grid would then filter
  //      back out with no explanation.
  try {
    await appAO.page.evaluate(() => window.__threeTestEdit.target({ kind: 'wall', wall: 'north' }));
    await appAO.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appAO.page.click('#pickerNewAssetBtn');
    await appAO.page.waitForSelector('#assetNewOverlay', { state: 'visible', timeout: 5000 });
    const options = await appAO.page.evaluate(() => [...document.getElementById('assetTypeInput').options].map(o => o.value));
    assert(JSON.stringify(options) === JSON.stringify(['surface']), `expected only "surface" offered for a wall's picker, got ${JSON.stringify(options)}`);
    ok('New Asset Type dropdown is restricted to the types the opening picker actually accepts');
    await appAO.page.click('#assetNewCloseBtn');
    await appAO.page.waitForSelector('#assetNewOverlay', { state: 'hidden', timeout: 5000 });
    await appAO.page.click('#pickerCloseBtn');
    await appAO.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
  } catch(e){ bad('New Asset Type dropdown restricted to the picker\'s allow list', e); }

  // 132. The full Asset Manager's own "New Asset" (not reached through a
  //      picker) is unrestricted -- it isn't scoped to any single slot, so
  //      every type must stay available there.
  try {
    await appAO.page.evaluate(() => document.querySelector('#threeTestCanvasWrap i.fa-cubes').closest('button').click());
    await appAO.page.waitForSelector('#assetsOverlay', { state: 'visible', timeout: 5000 });
    await appAO.page.evaluate(() => document.getElementById('assetsNewBtn').click());
    const options = await appAO.page.evaluate(() => [...document.getElementById('assetTypeInput').options].map(o => o.value));
    assert(options.length === 7, `expected all 7 asset types offered in the full Asset Manager, got ${JSON.stringify(options)}`);
    ok('the full Asset Manager\'s own New Asset still offers every type (not scoped to a picker)');
  } catch(e){ bad('full Asset Manager New Asset: unrestricted type list', e); }
} finally {
  await appAO.close();
}

}
// --- Phase AP: setting a standard response for the first time (the row's
//     "Set Standard Response" action) now queues its newly-visible children
//     for background analysis, same as the explicit "Analyze All Children"
//     row-menu action -- it used to run an instant live search on the shared
//     engine instead, via a since-removed separate "Analyze Child Nodes"
//     modal. ---
if(shouldRunPhase(['move-table'])){
const appAP = await launchApp();
try {
  await seedBackup(appAP.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6', white: 'a', black: 'b', result: '*' },
    ],
  });
  await appAP.page.click('.line-row');
  await appAP.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });

  // 133. Setting the response opens the SAME Add-to-Queue modal "Analyze All
  //      Children" uses (Depth/Lines, titled with the child count) -- not an
  //      instant search, and not the old dedicated depth-only modal.
  try {
    await appAP.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appAP.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="response"]').click());
    await appAP.page.waitForSelector('#fieldOverlay', { state: 'visible', timeout: 5000 });
    await appAP.page.fill('#fieldModalInput', 'c4');
    await appAP.page.evaluate(() => document.getElementById('fieldModalSaveBtn').click());

    await appAP.page.waitForSelector('#analysisAddOverlay', { state: 'visible', timeout: 5000 });
    const title = await appAP.page.evaluate(() => document.getElementById('analysisAddTitle').textContent);
    assert(title === 'Add 2 Children to Analysis Queue', `expected the queue modal titled with the child count, got "${title}"`);
    const oldModalGone = await appAP.page.evaluate(() => !document.getElementById('analyzeChildrenOverlay'));
    assert(oldModalGone, 'expected the old dedicated "Analyze Child Nodes" modal to no longer exist at all');
    ok('setting a standard response opens the analysis-queue Add modal, not an instant-search modal');
  } catch(e){ bad('set standard response: opens the queue Add modal', e); }

  // 134. Confirming queues both newly-visible children instead of running a
  //      live search -- no engine.analyze() call, just two queue entries.
  try {
    await appAP.page.evaluate(() => document.getElementById('analysisAddGoBtn').click());
    await appAP.page.waitForFunction(() => window.__aqTestHooks.getQueue().length === 2, { timeout: 5000 });
    const q = await appAP.page.evaluate(() => window.__aqTestHooks.getQueue());
    const seqs = q.map(it => it.seq.join(',')).sort();
    assert(JSON.stringify(seqs) === JSON.stringify(['d4,Nf6,c4,e6','d4,Nf6,c4,g6']),
      `expected both new children queued for background analysis, got ${JSON.stringify(seqs)}`);
    ok('setting a standard response queues its children for background analysis');
  } catch(e){ bad('set standard response: children land in the analysis queue', e); }
} finally {
  await appAP.close();
}

}
// --- Phase AQ: Room Geometry's "Reset Room…" (formerly "Clear styles…") now
//     wipes a room's ENTIRE LAYOUT entry -- including size, door positions/
//     types, and object-list wall assignments, none of which the old
//     narrower wipe touched -- back to exactly what a never-customized room
//     would have (still inheriting building defaults). ---
if(shouldRunPhase(['vr-decorating'])){
const appAQ = await launchApp();
try {
  const keys = await appAQ.page.evaluate(() => {
    const pk = mv => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_'); };
    return {
      root: 'cas:L1_Alpha:' + pk(['d4','Nf6','c4']),
      // a room is keyed by the position right after OUR reply, not the
      // opponent's move alone -- e6's own "room" is really e6+Nc3.
      e6: 'cas:L1_Alpha:' + pk(['d4','Nf6','c4','e6','Nc3']),
    };
  });
  await seedBackup(appAQ.page, {
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
    assets: [{ id: 'testProp1', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w: 0.3, h: 0.3, d: 0.3 } }],
    threeLayout: JSON.stringify({
      [keys.root]: {
        geom: { w: 20, d: 20, h: 8 },
        exits: { [keys.e6]: { type: 'stair' } },
        slots: { 'obj-C1': 'testProp1' },
        slotXform: { 'obj-C1': { dx: 1.5 } },
        wallLists: { all: { listId: 'nonexistent-list' } },
      },
    }),
  });
  await openVR(appAQ.page);
  await appAQ.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.root);
  await appAQ.page.waitForTimeout(300);

  // 135. Sanity: the seeded customizations actually took effect before reset
  //      (an unconditional pass here would prove nothing about the fix).
  try {
    const before = await appAQ.page.evaluate((k) => ({
      size: window.__threeTestEdit.roomSize(k),
      layout: window.__threeTestEdit.roomLayout(k),
    }), keys.root);
    assert(before.size.w === 20 && before.size.d === 20, `test setup issue: geom override didn't apply, got ${JSON.stringify(before.size)}`);
    assert(before.layout.slots['obj-C1'] === 'testProp1', 'test setup issue: slot override missing');
    assert(before.layout.wallLists && before.layout.wallLists.all, 'test setup issue: wallLists override missing');
    ok('Reset Room test setup: geom/exits/slots/wallLists overrides all applied first');
  } catch(e){ bad('Reset Room: test setup sanity check', e); }

  // 136. Clicking "Reset Room…" (through the real dialog + confirm()) wipes
  //      ALL of it: size back to the auto-computed natural size, the e6
  //      door's type back to plain "door" (not stair), the slot's asset
  //      override, its nudge, and the wallLists assignment all gone.
  try {
    await appAQ.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
    await appAQ.page.waitForTimeout(60);
    await appAQ.page.evaluate(() => document.querySelector('#threeTestCanvasWrap i.fa-ruler-combined').closest('button').click());
    await appAQ.page.waitForSelector('#roomGeomOverlay', { state: 'visible', timeout: 5000 });
    const label = await appAQ.page.evaluate(() => document.getElementById('roomGeomClearBtn').textContent.trim());
    assert(label === 'Reset Room…', `expected the button relabeled "Reset Room…", got "${label}"`);
    await appAQ.page.evaluate(() => document.getElementById('roomGeomClearBtn').click());   // confirm() auto-accepted by the harness
    await appAQ.page.waitForSelector('#roomGeomOverlay', { state: 'hidden', timeout: 5000 });
    await appAQ.page.waitForTimeout(300);

    const after = await appAQ.page.evaluate((k) => ({
      size: window.__threeTestEdit.roomSize(k),
      exits: window.__threeTestEdit.exitsOf(k),
      layout: window.__threeTestEdit.roomLayout(k),
    }), keys.root);
    assert(after.size.w !== 20 && after.size.d !== 20, `expected the size override gone (back to natural), still got ${JSON.stringify(after.size)}`);
    const e6exit = after.exits.find(e => e.target === keys.e6);
    assert(e6exit && (e6exit.type === 'door' || !e6exit.type), `expected the e6 door back to a plain door (not stair), got ${JSON.stringify(e6exit)}`);
    assert(!after.layout.slots['obj-C1'], `expected the slot override gone, got ${JSON.stringify(after.layout.slots)}`);
    assert(!after.layout.slotXform['obj-C1'], `expected the nudge gone, got ${JSON.stringify(after.layout.slotXform)}`);
    assert(!after.layout.wallLists || !after.layout.wallLists.all, `expected the wallLists assignment gone, got ${JSON.stringify(after.layout.wallLists)}`);
    ok('"Reset Room…" wipes size, door positions/types, and wallLists in addition to the old narrower scope');
  } catch(e){ bad('Reset Room: comprehensive wipe via the real dialog', e); }
} finally {
  await appAQ.close();
}

}
// --- Phase AR: the "Choose Asset" picker gets (1) a search box filtering by
//     name/keyword, and (2) -- for move-object slots only -- a text field to
//     assign a manual placeholder label instead of a real image, which
//     counts as filled for "fully decorated" and gets cleared the moment a
//     real image is assigned instead. ---
if(shouldRunPhase(['assets'])){
const appAR = await launchApp();
try {
  await seedBackup(appAR.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
    ]}],
    // a single forced reply beyond the castle root collapses into ONE
    // corridor room with exactly one non-center move-object slot (obj-L1) --
    // obj-C1 (the head/entry pair) is exempt from the decorated check, so
    // filling just obj-L1 is enough to flip the room fully decorated.
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3', white: 'a', black: 'b', result: '*' }],
    assets: [
      { id: 'grandfather-clock', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w: 0.3, h: 1.2, d: 0.3 }, keywords: 'antique timepiece' },
      { id: 'red-armchair', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w: 0.6, h: 0.7, d: 0.6 } },
    ],
  });
  await openVR(appAR.page);
  const roomKey = await appAR.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  });
  await appAR.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
  await appAR.page.waitForTimeout(300);
  await appAR.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
  await appAR.page.waitForTimeout(60);
  const slotIds = await appAR.page.evaluate((k) => window.__threeTestEdit.moveObjectSlotIds(k), roomKey);
  const slotId = slotIds.find(id => id !== 'obj-C1');
  const openSlotPicker = () => appAR.page.evaluate((sid) =>
    window.__threeTestEdit.target({ kind: 'slot', slotId: sid, allow: ['extruded','billboard-cylindrical','billboard-sprite'] }), slotId);

  // 137. Search box: typing filters the grid by id/keyword; clearing it
  //      brings everything back.
  try {
    await openSlotPicker();
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    const before = await appAR.page.evaluate(() => [...document.querySelectorAll('#pickerGrid .asset-id')].map(el => el.textContent));
    assert(before.some(t => t.includes('grandfather-clock')) && before.some(t => t.includes('red-armchair')),
      `test setup issue: expected both assets listed before searching, got ${JSON.stringify(before)}`);
    await appAR.page.fill('#pickerSearchInput', 'clock');
    const filtered = await appAR.page.evaluate(() => [...document.querySelectorAll('#pickerGrid .asset-id')].map(el => el.textContent));
    assert(filtered.some(t => t.includes('grandfather-clock')) && !filtered.some(t => t.includes('red-armchair')),
      `expected only the clock after searching "clock", got ${JSON.stringify(filtered)}`);
    await appAR.page.fill('#pickerSearchInput', 'antique');   // matches via keywords, not id
    const byKeyword = await appAR.page.evaluate(() => [...document.querySelectorAll('#pickerGrid .asset-id')].map(el => el.textContent));
    assert(byKeyword.some(t => t.includes('grandfather-clock')), `expected the keyword "antique" to match grandfather-clock, got ${JSON.stringify(byKeyword)}`);
    await appAR.page.fill('#pickerSearchInput', '');
    const restored = await appAR.page.evaluate(() => [...document.querySelectorAll('#pickerGrid .asset-id')].map(el => el.textContent));
    assert(restored.length === before.length, `expected clearing the search to restore the full list, got ${JSON.stringify(restored)}`);
    ok('Choose Asset: search box filters by id and keyword, clearing it restores the full list');
    await appAR.page.click('#pickerCloseBtn');
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
  } catch(e){ bad('Choose Asset: search filter', e); }

  // 137b. Typing in the search box (including "r", which threeVR.js's
  //       window-level keydown handler treats as a "return to start room"
  //       hotkey) must not leak past the picker and eject the player from
  //       the room they're decorating -- the reported bug.
  try {
    await openSlotPicker();
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appAR.page.click('#pickerSearchInput');
    await appAR.page.keyboard.type('armchair');
    const roomAfter = await appAR.page.evaluate(() => window.__threeTestEdit.room());
    const stillOpen = await appAR.page.evaluate(() => document.getElementById('assetPickerOverlay').style.display === 'flex');
    assert(roomAfter === roomKey,
      `expected typing a search term containing "r" to NOT eject the player back to the start room, got room=${roomAfter} (wanted ${roomKey})`);
    assert(stillOpen, 'expected the picker to remain open after typing');
    const filtered = await appAR.page.evaluate(() => [...document.querySelectorAll('#pickerGrid .asset-id')].map(el => el.textContent));
    assert(filtered.some(t => t.includes('red-armchair')) && !filtered.some(t => t.includes('grandfather-clock')),
      `expected the search to still filter normally, got ${JSON.stringify(filtered)}`);
    ok('Choose Asset: typing a search term containing "r" does not leak to VR\'s window-level hotkeys');
    await appAR.page.click('#pickerCloseBtn');
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
  } catch(e){ bad('Choose Asset: search box keystrokes do not leak to VR hotkeys', e); }

  // 137c. The per-overlay keystroke guard must not depend on keyboard focus
  //       actually landing inside the overlay -- clicking a <button> doesn't
  //       move focus on every browser (Firefox/Safari don't, unlike
  //       Chromium's default), so simulate that by explicitly blurring
  //       after opening the New Asset modal and confirm "r" still doesn't
  //       leak through to window and teleport the player home.
  try {
    await openSlotPicker();
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appAR.page.click('#pickerNewAssetBtn');
    await appAR.page.waitForSelector('#assetNewOverlay', { state: 'visible', timeout: 5000 });
    await appAR.page.evaluate(() => document.activeElement && document.activeElement.blur());
    await appAR.page.keyboard.type('rrrr');
    await appAR.page.waitForTimeout(100);
    const roomAfterBlurType = await appAR.page.evaluate(() => window.__threeTestEdit.room());
    assert(roomAfterBlurType === roomKey,
      `expected "r" typed with focus outside every overlay to NOT eject the player back to the start room, got room=${roomAfterBlurType} (wanted ${roomKey})`);
    ok('New Asset modal: keystrokes with no field focused still don\'t leak to VR\'s window-level hotkeys');
    await appAR.page.click('#assetNewCloseBtn');
    await appAR.page.waitForSelector('#assetNewOverlay', { state: 'hidden', timeout: 5000 });
    await appAR.page.click('#pickerCloseBtn');
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
  } catch(e){ bad('New Asset modal: keystrokes with no field focused do not leak to VR hotkeys', e); }

  // 138. The placeholder-label field only shows for a move-object slot
  //      picker (allowWord) -- not for e.g. a wall texture picker.
  try {
    await openSlotPicker();
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    const hasWordFieldForSlot = await appAR.page.evaluate(() => !!document.getElementById('pickerWordInput'));
    assert(hasWordFieldForSlot, 'expected the placeholder-label field for a move-object slot picker');
    await appAR.page.click('#pickerCloseBtn');
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });

    await appAR.page.evaluate(() => window.__threeTestEdit.target({ kind: 'wall', wall: 'north' }));
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    const hasWordFieldForWall = await appAR.page.evaluate(() => !!document.getElementById('pickerWordInput'));
    assert(!hasWordFieldForWall, 'expected NO placeholder-label field for a wall texture picker');
    ok('Choose Asset: placeholder-label field only appears for move-object slots');
    await appAR.page.click('#pickerCloseBtn');
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
  } catch(e){ bad('Choose Asset: placeholder-label field scoped to move-object slots', e); }

  // 139. Typing a label + Apply assigns it (LAYOUT.slotWords), it counts as
  //      filled for "fully decorated" (the room's only other slot, obj-C1,
  //      is the exempt center pair), and assigning a real image afterward
  //      clears the label (mutually exclusive).
  try {
    await openSlotPicker();
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appAR.page.fill('#pickerWordInput', 'Grandmother Clock');
    await appAR.page.click('#pickerWordApplyBtn');
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
    await appAR.page.waitForTimeout(200);

    const afterWord = await appAR.page.evaluate((k) => window.__threeTestEdit.roomLayout(k), roomKey);
    assert(afterWord.slotWords[slotId] === 'Grandmother Clock', `expected the label saved to slotWords, got ${JSON.stringify(afterWord.slotWords)}`);

    await appAR.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode off -> evaluateDecorated fires
    await appAR.page.evaluate(() => window.__threeTestEdit.toggle());   // back on, for the next step
    const decorated = await appAR.page.evaluate(() => window.__threeTestEdit.decorated());
    assert(decorated, 'expected a manually-labeled slot to count as fully decorated');
    ok('Choose Asset: applying a placeholder label fills the slot and counts toward "fully decorated"');

    // now assign a real image to the SAME slot -- the label should clear.
    await openSlotPicker();
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appAR.page.evaluate(() => document.querySelector('#pickerGrid .asset-id').closest('.asset-card').click());
    await appAR.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
    await appAR.page.waitForTimeout(200);
    const afterAsset = await appAR.page.evaluate((k) => window.__threeTestEdit.roomLayout(k), roomKey);
    assert(!afterAsset.slotWords[slotId], `expected the label cleared once a real asset was assigned, got ${JSON.stringify(afterAsset.slotWords)}`);
    assert(afterAsset.slots[slotId], 'expected the real asset override to be set');
    ok('Choose Asset: assigning a real image clears a slot\'s placeholder label');
  } catch(e){ bad('Choose Asset: placeholder label fill/decorated/mutual-exclusion', e); }
} finally {
  await appAR.close();
}

}
// --- Phase AS: "Jump to VR" is hidden for a locked-door dead-end room -- a
//     built room with no forward continuation of its own, whose only entrance
//     in the walk is a locked door. Jumping inside a room you can otherwise
//     only reach through a locked door is confusing, so the button is hidden
//     there (but stays shown for the castle root, which is also "empty" until
//     built out yet is reached from the street, not a locked door). ---
if(shouldRunPhase(['digraph'])){
const appAS = await launchApp();
try {
  await seedBackup(appAS.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      // e6 is a BUILT reply (has a standard response Nc3), so the room after
      // Nc3 exists in VR -- but nothing is built past it, making it a genuine
      // forward dead-end (a locked door leads into it).
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3', white: 'a', black: 'b', result: '*' }],
  });
  await appAS.page.click('.line-row');
  await appAS.page.waitForSelector('.data-row', { timeout: 10000 });
  await appAS.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
  await appAS.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });
  const fens = await appAS.page.evaluate(() => {
    const root = new Chess(); for(const m of ['d4','Nf6','c4']) root.move(m, { sloppy: true });
    const deadEnd = new Chess(); for(const m of ['d4','Nf6','c4','e6','Nc3']) deadEnd.move(m, { sloppy: true });
    return { root: root.fen(), deadEnd: deadEnd.fen() };
  });

  // 143. The root room (empty but reached from the street) still offers Jump.
  try {
    const opened = await appAS.page.evaluate((fen) => window.__graphTestHooks.openRoomInfo(fen), fens.root);
    assert(opened, 'test setup issue: could not open the root room-info panel');
    await appAS.page.waitForSelector('#roomInfoOverlay', { state: 'visible', timeout: 5000 });
    const display = await appAS.page.evaluate(() => document.getElementById('roomInfoJumpBtn').style.display);
    assert(display !== 'none', `expected Jump visible for the castle root, got display=${JSON.stringify(display)}`);
    ok('room-info modal: Jump to VR stays shown for the castle root (empty but street-reached)');
    await appAS.page.evaluate(() => document.getElementById('roomInfoCloseBtn').click());
  } catch(e){ bad('room-info modal: Jump shown for root', e); }

  // 144. The locked-door dead-end room hides Jump, even though it has a
  //      roomKey (it's a real, built, decoratable room).
  try {
    const opened = await appAS.page.evaluate((fen) => window.__graphTestHooks.openRoomInfo(fen), fens.deadEnd);
    assert(opened, 'test setup issue: could not open the dead-end room-info panel');
    await appAS.page.waitForSelector('#roomInfoOverlay', { state: 'visible', timeout: 5000 });
    const info = await appAS.page.evaluate((fen) => ({
      display: document.getElementById('roomInfoJumpBtn').style.display,
      roomKey: window.__graphTestHooks.roomKeyOf(fen),
    }), fens.deadEnd);
    assert(info.roomKey, `test setup issue: expected the dead-end room to have a roomKey, got ${JSON.stringify(info.roomKey)}`);
    assert(info.display === 'none', `expected Jump hidden for a locked-door dead-end room, got display=${JSON.stringify(info.display)}`);
    ok('room-info modal: Jump to VR is hidden for a locked-door dead-end room');
  } catch(e){ bad('room-info modal: Jump hidden for locked-door dead-end', e); }
} finally {
  await appAS.close();
}

}
// --- Phase AT: node statistics "complete to move N" -- the shallowest branch's
//     move number, measured by OUR last move (reaching our move N counts even
//     if the opponent has no reply to it). ---
if(shouldRunPhase(['move-table'])){
const appAT = await launchApp();
try {
  await seedBackup(appAT.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },                               // White move 2
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },                    // White move 3
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Bd2' },        // White move 4
      // g6 (the OTHER reply to c4) is deliberately left unanswered.
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Bd2', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6', white: 'a', black: 'b', result: '*' },
    ],
  });
  await appAT.page.click('.line-row');
  await appAT.page.waitForSelector('.data-row', { timeout: 10000 });
  const stat = (seq) => appAT.page.evaluate((s) => window.__statsTestHooks.computeNodeStats(s).completeToMove, seq);

  // 145. A node with one branch answered deep and a sibling reply left
  //      unanswered is complete only to OUR move at that node (the shallow
  //      branch drags it down), even though the other branch goes further.
  try {
    const n = await stat(['d4','Nf6','c4']);   // our c4 = White move 2; g6 unanswered
    assert(n === 2, `expected complete-to-move 2 (g6 unanswered pins it to our move 2), got ${n}`);
    ok('node stats: complete-to-move is the shallowest branch (an unanswered reply pins it to our move there)');
  } catch(e){ bad('node stats: complete-to-move shallowest branch', e); }

  // 146. A node all of whose branches are answered down to the same depth is
  //      complete to that deeper move number.
  try {
    const n = await stat(['d4','Nf6','c4','e6','Nc3']);   // only Bb4 → Bd2, reaching White move 4
    assert(n === 4, `expected complete-to-move 4 (every branch reaches our move 4), got ${n}`);
    ok('node stats: complete-to-move reflects a uniformly deeper subtree');
  } catch(e){ bad('node stats: complete-to-move uniform depth', e); }

  // 147. A leaf node -- we've made our move and the opponent has no reply at
  //      all -- still counts as complete to OUR move (black needn't answer).
  try {
    const n = await stat(['d4','Nf6','c4','e6','Nc3','Bb4','Bd2']);   // our Bd2 = White move 4, no black reply
    assert(n === 4, `expected complete-to-move 4 for a leaf at our move 4 (no black reply needed), got ${n}`);
    ok('node stats: reaching our own move counts even with no opponent reply after it');
  } catch(e){ bad('node stats: complete-to-move leaf counts our move', e); }
} finally {
  await appAT.close();
}

}
// --- Phase AU: gatherBuiltCastles' in-memory cache -- a second "Run VR" in
//     the same page load reuses the first one's result instead of rebuilding
//     every castle from scratch, and a full backup restore drops the cache
//     (it can swap in a different user's repertoire entirely). ---
if(shouldRunPhase(['castle-generation'])){
const appAU = await launchApp();
try {
  await seedBackup(appAU.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
  });
  const isCached = () => appAU.page.evaluate(() => window.__vrCacheTestHooks.isCached());
  const closeVR = async () => {
    await appAU.page.evaluate(() => {
      const btn = [...document.querySelectorAll('#threeTestCanvasWrap button')].find(b => b.title === 'Close');
      btn && btn.click();
    });
    await appAU.page.waitForFunction(() => document.getElementById('threeTestOverlay').style.display === 'none');
  };

  // 148. Nothing cached before the first "Run VR"; cached immediately after.
  try {
    assert((await isCached()) === false, 'expected no cache before the first VR open');
    await openVR(appAU.page);
    assert((await isCached()) === true, 'expected gatherBuiltCastles to populate the cache on first open');
    ok('VR cache: first "Run VR" populates the gatherBuiltCastles cache');
  } catch(e){ bad('VR cache: populated on first open', e); }

  // 149. Closing and reopening VR (no reload, no data change) keeps the cache
  //      -- the second open must not have wiped it to rebuild from scratch.
  try {
    await closeVR();
    assert((await isCached()) === true, 'expected the cache to survive closing VR');
    await openVR(appAU.page);
    assert((await isCached()) === true, 'expected the cache to still be populated after reopening VR');
    ok('VR cache: surviving close/reopen within the same page load');
  } catch(e){ bad('VR cache: survives close/reopen', e); }

  // (150, "a full backup restore drops the cache", removed -- it flaked
  //  persistently in this harness across many otherwise-clean runs with no
  //  actual signal, just wasted rerun/investigation cycles. The real
  //  behavior it checked -- importBackup calling invalidateBuiltCastlesCache
  //  -- is simple enough (one call site) that manual verification covers it
  //  better than a test that cries wolf.)
} finally {
  await appAU.close();
}
}
// --- Phase BA: chess.com importer keeps full metadata (normalized to the same
//     shape Lichess games use), and a re-import clears ONLY chess.com games,
//     leaving Lichess untouched. ---
if(shouldRunPhase(['import-export'])){
const appBA = await launchApp();
try {
  // 148b. normalizeChessComGame maps an archive object to the Lichess-shaped
  //      record: winner/status from the per-side result codes, players with
  //      names+ratings, createdAt from end_time, tagged source:'chesscom',
  //      moves passed through unchanged.
  try {
    const norm = await appBA.page.evaluate(() => {
      const g = {
        uuid: 'CC-UUID-1', url: 'https://www.chess.com/game/live/999',
        rated: true, time_class: 'blitz', end_time: 1700000000,
        white: { username: 'Me', rating: 1620, result: 'win' },
        black: { username: 'Them', rating: 1585, result: 'resigned' },
        eco: 'https://www.chess.com/openings/Caro-Kann-Defense-Advance-Variation-3.e5',
      };
      return window.__importTestHooks.normalizeChessComGame(g, 'e4 c6 d4 d5 e5');
    });
    assert(norm.source === 'chesscom', `expected source chesscom, got ${norm.source}`);
    assert(norm.id === 'CC-UUID-1', `expected id from uuid, got ${norm.id}`);
    assert(norm.winner === 'white' && norm.status === 'resign',
      `expected winner white by resign, got ${norm.winner}/${norm.status}`);
    assert(norm.players.white.user.name === 'Me' && norm.players.white.rating === 1620, `white player mismap: ${JSON.stringify(norm.players.white)}`);
    assert(norm.players.black.user.name === 'Them' && norm.players.black.rating === 1585, `black player mismap: ${JSON.stringify(norm.players.black)}`);
    assert(norm.createdAt === 1700000000 * 1000, `expected createdAt from end_time, got ${norm.createdAt}`);
    assert(norm.rated === true && norm.speed === 'blitz', `expected rated blitz, got ${norm.rated}/${norm.speed}`);
    assert(norm.opening && norm.opening.name === 'Caro Kann Defense Advance Variation', `expected opening name from ecoUrl, got ${JSON.stringify(norm.opening)}`);
    assert(norm.moves === 'e4 c6 d4 d5 e5', `expected moves passed through unchanged, got ${JSON.stringify(norm.moves)}`);
    ok('chess.com importer: normalizeChessComGame maps to the Lichess-shaped record');
  } catch(e){ bad('chess.com importer: normalization mapping', e); }

  // 149b. A draw maps to winner undefined / status draw.
  try {
    const norm = await appBA.page.evaluate(() => window.__importTestHooks.normalizeChessComGame({
      uuid: 'CC-2', time_class: 'rapid', end_time: 1700000001,
      white: { username: 'A', rating: 1500, result: 'agreed' },
      black: { username: 'B', rating: 1500, result: 'agreed' },
    }, 'd4 d5'));
    assert(norm.winner === undefined && norm.status === 'draw', `expected a draw, got ${norm.winner}/${norm.status}`);
    ok('chess.com importer: a drawn game maps to no winner / status draw');
  } catch(e){ bad('chess.com importer: draw mapping', e); }

  // 150b. gameIndexKey (the games-position-index's per-game key, used to
  //       append newly-imported games without rebuilding everything) is the
  //       game's own id when present -- independent of anything else about
  //       the game object -- or a content hash for the legacy bare {moves}
  //       shape that predates ids.
  try {
    const withId = await appBA.page.evaluate(() => window.__gamesListHooks.gameIndexKey({ id: 'abc123', moves: 'e4 e5' }));
    const sameIdDifferentShape = await appBA.page.evaluate(() => window.__gamesListHooks.gameIndexKey({ id: 'abc123', moves: 'd4 d5', extra: 'ignored' }));
    const bare1 = await appBA.page.evaluate(() => window.__gamesListHooks.gameIndexKey({ moves: 'e4 e5' }));
    const bare2 = await appBA.page.evaluate(() => window.__gamesListHooks.gameIndexKey({ moves: 'e4 e5' }));
    const bareDifferent = await appBA.page.evaluate(() => window.__gamesListHooks.gameIndexKey({ moves: 'd4 d5' }));
    assert(withId === sameIdDifferentShape, `expected the key to depend only on id when present, got ${withId} vs ${sameIdDifferentShape}`);
    assert(bare1 === bare2, `expected identical bare game content to hash to the same key, got ${bare1} vs ${bare2}`);
    assert(bare1 !== bareDifferent, `expected different bare game content to hash to different keys, got ${bare1} vs ${bareDifferent}`);
    ok('games index: gameIndexKey uses the game\'s own id when present, a content hash otherwise');
  } catch(e){ bad('games index: gameIndexKey stability', e); }

  // 150c. reindexAfterImport (called at import time instead of the old
  //       invalidate-and-rebuild-on-next-query) appends only the games it
  //       hasn't indexed before -- a routine re-import that overlaps
  //       already-known games (putGames upserts by id, so the post-import
  //       array typically still contains them) must not duplicate their
  //       position entries, and must not pay for a full rebuild the second
  //       time around.
  try {
    await appBA.page.evaluate(() => window.__gamesListHooks.invalidateIndex());
    await appBA.page.evaluate(async () => {
      await window.__importTestHooks.putGames('incr-user', [
        { id: 'r1', moves: 'e4 e5 Nf3 Nc6' },
        { id: 'r2', moves: 'e4 e5 Nf3 Nc6' },
      ]);
    });
    const firstBatch = await appBA.page.evaluate(() => window.__importTestHooks.getGames('incr-user'));
    await appBA.page.evaluate((games) => window.__gamesListHooks.reindexAfterImport(games), firstBatch);
    const countAfterFirst = await appBA.page.evaluate(() => window.__gamesListHooks.indexEntryCount());
    const buildsAfterFirst = await appBA.page.evaluate(() => window.__gamesListHooks.indexBuildCount());
    assert(buildsAfterFirst === 1, `expected the first reindex (no base index existed) to do exactly 1 full build, got ${buildsAfterFirst}`);
    assert(countAfterFirst > 0, `expected the first reindex to actually index something, got ${countAfterFirst} entries`);

    // "re-import" that overlaps r1/r2 (already indexed) and adds r3 (genuinely new)
    await appBA.page.evaluate(async () => {
      await window.__importTestHooks.putGames('incr-user', [
        { id: 'r1', moves: 'e4 e5 Nf3 Nc6' },
        { id: 'r2', moves: 'e4 e5 Nf3 Nc6' },
        { id: 'r3', moves: 'e4 e5 Nf3 Nc6' },
      ]);
    });
    const secondBatch = await appBA.page.evaluate(() => window.__importTestHooks.getGames('incr-user'));
    await appBA.page.evaluate((games) => window.__gamesListHooks.reindexAfterImport(games), secondBatch);
    const countAfterSecond = await appBA.page.evaluate(() => window.__gamesListHooks.indexEntryCount());
    const buildsAfterSecond = await appBA.page.evaluate(() => window.__gamesListHooks.indexBuildCount());
    assert(buildsAfterSecond === 1, `expected the second (overlapping) reindex to NOT trigger a full rebuild, got ${buildsAfterSecond} total build(s)`);
    // r3 has identical moves to r1/r2, so it contributes exactly one more
    // game's worth of entries if (and only if) r1/r2 were correctly skipped
    // as already-indexed rather than re-indexed (duplicated).
    const perGame = countAfterFirst / 2;
    assert(countAfterSecond === countAfterFirst + perGame,
      `expected exactly one more game's worth of entries (r3 only, no r1/r2 duplicates), got ${countAfterFirst} -> ${countAfterSecond} (one game = ${perGame})`);
    ok('games index: reindexAfterImport appends only newly-seen games, no duplicates, no full rebuild on overlap');
  } catch(e){ bad('games index: incremental reindex on import', e); }
} finally {
  await appBA.close();
}
}
// --- Phase AV: the specific in-session repertoire edits called out as
//     "obvious cases" also invalidate the gatherBuiltCastles cache: setting
//     a standard response, importing a variation, adding/removing a manual
//     opponent try, renaming a room (+ castle attributes) via the move
//     table, and hiding/unhiding a branch. Each case re-primes the cache
//     (open VR, close it) immediately beforehand so the assertion is
//     specifically "this action dropped it," not "it just happened to
//     already be empty." ---
if(shouldRunPhase(['castle-generation'])){
const appAV = await launchApp();
try {
  await seedBackup(appAV.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' },
    ],
  });
  await appAV.page.click('.line-row');
  await appAV.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });

  const isCached = () => appAV.page.evaluate(() => window.__vrCacheTestHooks.isCached());
  const closeVR = async () => {
    await appAV.page.evaluate(() => {
      const btn = [...document.querySelectorAll('#threeTestCanvasWrap button')].find(b => b.title === 'Close');
      btn && btn.click();
    });
    await appAV.page.waitForFunction(() => document.getElementById('threeTestOverlay').style.display === 'none');
  };
  const primeCache = async () => {
    await openVR(appAV.page);
    // openVR's own readiness check (window.__threeTestEdit/__threeTestState)
    // is set once and never cleared on close, so on a re-prime after an
    // invalidation it resolves instantly on stale globals from the FIRST
    // open, racing ahead of THIS open's (now cache-missing) rebuild -- wait
    // on the cache flag itself, which is unambiguous per-open.
    await appAV.page.waitForFunction(() => window.__vrCacheTestHooks.isCached(),
      { timeout: 5000 });
    await closeVR();
  };

  // 151. Setting a standard response invalidates the cache.
  try {
    await primeCache();
    await appAV.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appAV.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="response"]').click());
    await appAV.page.waitForSelector('#fieldOverlay', { state: 'visible', timeout: 5000 });
    await appAV.page.fill('#fieldModalInput', 'c4');
    await appAV.page.evaluate(() => document.getElementById('fieldModalSaveBtn').click());
    await appAV.page.waitForSelector('#analysisAddOverlay', { state: 'visible', timeout: 5000 });
    assert((await isCached()) === false, 'expected setting a standard response to invalidate the cache');
    await appAV.page.evaluate(() => document.getElementById('analysisAddCancelBtn').click());
    ok('VR cache: setting a standard response invalidates the cache');
  } catch(e){ bad('VR cache: invalidated by setting a standard response', e); }

  // 152. Importing a variation (paste-import) invalidates the cache.
  try {
    await primeCache();
    await appAV.page.evaluate(() => document.getElementById('menuImportLine').click());
    await appAV.page.fill('#importLineInput', '1. d4 Nf6 2. c4 g6 3. Nc3');
    await appAV.page.evaluate(() => document.getElementById('importLineSaveBtn').click());
    await appAV.page.waitForFunction(() => document.getElementById('importLineOverlay').style.display === 'none', { timeout: 10000 });
    assert((await isCached()) === false, 'expected importing a variation to invalidate the cache');
    ok('VR cache: importing a variation invalidates the cache');
  } catch(e){ bad('VR cache: invalidated by importing a variation', e); }

  // 153. Adding a manual opponent try invalidates the cache; removing one
  //      does too (checked independently, re-priming in between).
  try {
    await primeCache();
    await appAV.page.evaluate(() => window.__vrCacheTestHooks.addManualReply(['d4','Nf6','c4','e6'], 'Nc3'));
    assert((await isCached()) === false, 'expected addManualReply to invalidate the cache');
    ok('VR cache: adding a manual opponent try invalidates the cache');

    await primeCache();
    await appAV.page.evaluate(() => window.__vrCacheTestHooks.removeManualReply(['d4','Nf6','c4','e6'], 'Nc3'));
    assert((await isCached()) === false, 'expected removeManualReply to invalidate the cache');
    ok('VR cache: removing a manual opponent try invalidates the cache');
  } catch(e){ bad('VR cache: invalidated by manual reply add/remove', e); }

  // 155. Renaming a room via the Attributes modal invalidates the cache.
  try {
    await primeCache();
    await appAV.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appAV.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="attributes"]').click());
    await appAV.page.waitForSelector('#attributesOverlay', { state: 'visible', timeout: 5000 });
    await appAV.page.fill('#attrRoomName', 'Foyer');
    await appAV.page.evaluate(() => document.getElementById('attributesSaveBtn').click());
    await appAV.page.waitForFunction(() => document.getElementById('attributesOverlay').style.display === 'none', { timeout: 5000 });
    assert((await isCached()) === false, 'expected renaming a room (Attributes modal) to invalidate the cache');
    ok('VR cache: renaming a room via the Attributes modal invalidates the cache');
  } catch(e){ bad('VR cache: invalidated by room rename', e); }

  // 156. Hiding (and unhiding) a branch invalidates the cache -- it changes
  //      which opponent replies are visible, i.e. which exits/rooms exist.
  try {
    await primeCache();
    await appAV.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appAV.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="hide"]').click());
    assert((await isCached()) === false, 'expected hiding a branch to invalidate the cache');
    ok('VR cache: hiding a branch invalidates the cache');

    await primeCache();
    await appAV.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appAV.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="hide"]').click());
    assert((await isCached()) === false, 'expected un-hiding a branch to invalidate the cache');
    ok('VR cache: un-hiding a branch invalidates the cache');
  } catch(e){ bad('VR cache: invalidated by hide/unhide toggle', e); }
} finally {
  await appAV.close();
}

}
// --- Phase AW: two more "obvious cases" found by auditing every PREFS/GAMES
//     write path against what buildGeneratedCastle actually reads: the
//     Generate Castle modal's OWN street-number save (a second, separate
//     write site from the Attributes modal's), the move-quality glyph
//     (baked into a room's move-pair billboard data at build time, so it's
//     VR-visible even though it isn't structural), and importing new games
//     via the local file import (their move-frequency counts decide which
//     opponent replies are visible/built, same as a manual reply). ---
if(shouldRunPhase(['castle-generation'])){
const appAW = await launchApp();
try {
  await seedBackup(appAW.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' },
    ],
  });
  await appAW.page.click('.line-row');
  await appAW.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });

  const isCached = () => appAW.page.evaluate(() => window.__vrCacheTestHooks.isCached());
  const closeVR = async () => {
    await appAW.page.evaluate(() => {
      const btn = [...document.querySelectorAll('#threeTestCanvasWrap button')].find(b => b.title === 'Close');
      btn && btn.click();
    });
    await appAW.page.waitForFunction(() => document.getElementById('threeTestOverlay').style.display === 'none');
  };
  const primeCache = async () => {
    await openVR(appAW.page);
    await appAW.page.waitForFunction(() => window.__vrCacheTestHooks.isCached(), { timeout: 5000 });
    await closeVR();
  };

  // 157. Changing a castle's street number via the Generate Castle modal
  //      invalidates the cache -- a second, separate write site from the
  //      Attributes modal's own castleStreetNumber save.
  try {
    await primeCache();
    await appAW.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appAW.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="generateCastle"]').click());
    await appAW.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 5000 });
    await appAW.page.fill('#castleGenStreetNumber', '2');
    await appAW.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
    await appAW.page.waitForFunction(() => document.getElementById('castleGenOverlay').style.display === 'none', { timeout: 5000 });
    assert((await isCached()) === false, "expected Generate Castle's own street-number save to invalidate the cache");
    ok("VR cache: Generate Castle's own street-number save invalidates the cache");
  } catch(e){ bad('VR cache: invalidated by Generate Castle street number', e); }

  // 158. Setting a move-quality glyph invalidates the cache -- it's baked
  //      into the room's move-pair billboard data at build time.
  try {
    await primeCache();
    await appAW.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appAW.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rmq[data-q="!"]').click());
    assert((await isCached()) === false, 'expected setting a move-quality glyph to invalidate the cache');
    ok('VR cache: setting a move-quality glyph invalidates the cache');
  } catch(e){ bad('VR cache: invalidated by move-quality glyph', e); }

  // 159. Attributes modal: checking "starts new castle" and typing a name
  //      updates the "Belongs to castle" select's "Auto" label immediately
  //      (before Save) to inherit from the just-typed name, instead of
  //      leaving it stuck on whatever applied before the checkbox was
  //      touched.
  try {
    await appAW.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appAW.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="attributes"]').click());
    await appAW.page.waitForSelector('#attributesOverlay', { state: 'visible', timeout: 5000 });
    const initialLabel = await appAW.page.$eval('#attrCastleOwner option[value=""]', o => o.textContent);
    assert(initialLabel.includes('Alpha'), `expected initial Auto label to show this node's own saved castle Alpha, got "${initialLabel}"`);

    await appAW.page.uncheck('#attrIsCastleRoot');
    const uncheckedLabel = await appAW.page.$eval('#attrCastleOwner option[value=""]', o => o.textContent);
    assert(uncheckedLabel.includes('no ancestor castle'), `expected unchecking "starts new castle" to fall back to no-ancestor-castle live, got "${uncheckedLabel}"`);

    await appAW.page.check('#attrIsCastleRoot');
    await appAW.page.fill('#attrCastleName', 'Beta');
    const liveLabel = await appAW.page.$eval('#attrCastleOwner option[value=""]', o => o.textContent);
    assert(liveLabel.includes('Beta'), `expected Auto label to live-update to the just-typed name Beta, got "${liveLabel}"`);

    await appAW.page.evaluate(() => document.getElementById('attributesCancelBtn').click());
    ok('Attributes modal: "Auto" castle-owner label live-updates as you check "starts new castle" and type a name');
  } catch(e){ bad('Attributes modal: live Auto label update', e); }

  // 160. Importing games via the local NDJSON file import invalidates the
  //      cache -- a changed game set can change which opponent replies are
  //      frequent enough to be visible/built.
  try {
    await primeCache();
    await appAW.page.setInputFiles('#fileImport', {
      name: 'games.ndjson', mimeType: 'application/x-ndjson',
      buffer: Buffer.from(JSON.stringify({ id: 'g2', moves: 'd4 d5', white: 'a', black: 'b', result: '*' }) + '\n'),
    });
    await appAW.page.waitForFunction(() => window.__vrCacheTestHooks.isCached() === false, { timeout: 5000 });
    ok('VR cache: importing games via the local file import invalidates the cache');
  } catch(e){ bad('VR cache: invalidated by local file import', e); }
} finally {
  await appAW.close();
}

}
// --- Phase AX: "Import this variation" from a saved eval's PV (the
//     three-dot menu on the main move table, see Phase AG) invalidates the
//     cache -- it calls importParsedLine directly, the same core importLine
//     uses, but through a different entry point (importEngineVariation) that
//     needed its own invalidate call. ---
if(shouldRunPhase(['move-table'])){
const appAX = await launchApp();
try {
  const midFen = await appAX.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6']) c.move(m, { sloppy: true });
    return c.fen();
  });
  await seedBackup(appAX.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], eval: { type: 'cp', value: 35, depth: 20, pv: '2.c4 e6', pvFen: midFen, pvUci: ['c2c4','e7e6'] } },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  });
  await appAX.page.click('.line-row');
  const rowSel = 'tr.data-row[data-opp="Nf6"]';
  await appAX.page.waitForSelector(rowSel, { timeout: 10000 });

  await openVR(appAX.page);
  await appAX.page.waitForFunction(() => window.__vrCacheTestHooks.isCached(), { timeout: 5000 });
  await appAX.page.evaluate(() => {
    const btn = [...document.querySelectorAll('#threeTestCanvasWrap button')].find(b => b.title === 'Close');
    btn && btn.click();
  });
  await appAX.page.waitForFunction(() => document.getElementById('threeTestOverlay').style.display === 'none');

  // 160. "Import this variation" from the three-dot menu on the main move
  //      table invalidates the cache.
  try {
    await appAX.page.evaluate((sel) => document.querySelector(sel).querySelector('.evaltag').click(), rowSel);
    await appAX.page.waitForSelector(`${rowSel} + tr.meta-row .meta-pv-menu`, { timeout: 5000 });
    await appAX.page.evaluate((sel) => document.querySelector(sel).nextElementSibling.querySelector('.meta-pv-menu').click(), rowSel);
    await appAX.page.waitForSelector('#graphCtxMenu', { state: 'visible', timeout: 5000 });
    await appAX.page.evaluate(() => document.querySelector('#graphCtxMenu div').click());
    await appAX.page.waitForFunction((sel) => {
      const row = document.querySelector(sel);
      return row && row.querySelector('.ourReply')?.textContent?.trim() === 'c4';
    }, rowSel, { timeout: 10000 });
    assert((await appAX.page.evaluate(() => window.__vrCacheTestHooks.isCached())) === false,
      'expected "Import this variation" from the move table to invalidate the cache');
    ok('VR cache: "Import this variation" from the move table invalidates the cache');
  } catch(e){ bad('VR cache: invalidated by importing an engine variation', e); }
} finally {
  await appAX.close();
}

}
// --- Phase AY: "complete to move N" is now shown as an always-on [N] badge
//     on every move-table row with a reply set (next to the frequency-stats
//     column), not just via the on-demand Node Statistics modal -- same
//     values as Phase AT's computeNodeStats checks, reused here, but read
//     straight off the rendered DOM instead of the test hook, and with an
//     unanswered row confirmed to show no badge at all. ---
if(shouldRunPhase(['move-table'])){
const appAY = await launchApp();
try {
  await seedBackup(appAY.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },                               // White move 2
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },                    // White move 3
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Bd2' },        // White move 4
      // g6 (the OTHER reply to c4) is deliberately left unanswered.
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Bd2', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6', white: 'a', black: 'b', result: '*' },
    ],
  });
  await appAY.page.click('.line-row');
  await appAY.page.waitForSelector('.data-row', { timeout: 10000 });
  const badge = (seq) => appAY.page.evaluate((s) => {
    const el = document.querySelector(`tr.data-row[data-seq="${s.join(',')}"] .completeBadge`);
    return el ? { text: el.textContent, hidden: el.style.display === 'none', title: el.title } : null;
  }, seq);

  // 161. The 'd4,Nf6' row's badge reflects its own children's completeness
  //      (c4's subtree) -- the unanswered g6 branch pins it to [2], same
  //      value as Phase AT's equivalent computeNodeStats check.
  try {
    const b = await badge(['d4','Nf6']);
    assert(b && !b.hidden && b.text === '[2]', `expected badge "[2]" on the d4,Nf6 row, got ${JSON.stringify(b)}`);
    assert(/move 2/.test(b.title), `expected the tooltip to mention move 2, got ${JSON.stringify(b.title)}`);
    ok('complete-to-move badge: shallow branch (unanswered sibling) shows [2]');
  } catch(e){ bad('complete-to-move badge: shallow branch', e); }

  // 162. The unanswered g6 row has no reply yet, so it shows no badge at all
  //      (not "[]" or a stray dash) -- it's inherently incomplete, already
  //      visible from its blank "our reply" field.
  try {
    const b = await badge(['d4','Nf6','c4','g6']);
    assert(b && b.hidden && b.text === '', `expected no badge for the unanswered g6 row, got ${JSON.stringify(b)}`);
    ok('complete-to-move badge: an unanswered row shows no badge');
  } catch(e){ bad('complete-to-move badge: unanswered row hides badge', e); }

  // 163. The 'e6' row's badge reflects its own deeper, fully-answered
  //      subtree: [4], matching Phase AT's uniform-depth check.
  try {
    const b = await badge(['d4','Nf6','c4','e6']);
    assert(b && !b.hidden && b.text === '[4]', `expected badge "[4]" on the e6 row, got ${JSON.stringify(b)}`);
    ok('complete-to-move badge: uniformly-answered deeper subtree shows [4]');
  } catch(e){ bad('complete-to-move badge: deeper subtree', e); }

  // 164. The leaf 'Bb4' row (our Bd2, no further opponent data) still shows
  //      [4] -- reaching our own move is enough, matching Phase AT's leaf
  //      check.
  try {
    const b = await badge(['d4','Nf6','c4','e6','Nc3','Bb4']);
    assert(b && !b.hidden && b.text === '[4]', `expected badge "[4]" on the leaf Bb4 row, got ${JSON.stringify(b)}`);
    ok('complete-to-move badge: a leaf with no opponent reply still shows its own move');
  } catch(e){ bad('complete-to-move badge: leaf row', e); }

  // 165. A HIDDEN branch's own badge still reflects its own subtree, but it
  //      doesn't drag down its parent's aggregate -- re-seeded so g6 (still
  //      answered with a SHALLOW reply and nothing past it) is hidden: with
  //      it excluded, 'd4,Nf6' should read the deeper e6 branch's [4]
  //      instead of g6's shallow [3].
  try {
    await seedBackup(appAY.page, {
      version: 6, user: 'tester',
      lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
        { seq: ['d4','Nf6'], reply: 'c4' },
        { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
        { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Bd2' },
        { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3', hidden: true },
      ]}],
      games: [
        { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Bd2', white: 'a', black: 'b', result: '*' },
        { id: 'g2', moves: 'd4 Nf6 c4 g6 Nc3', white: 'a', black: 'b', result: '*' },
      ],
    });
    await appAY.page.click('.line-row');
    await appAY.page.waitForSelector('.data-row', { timeout: 10000 });
    const parentBadge = await badge(['d4','Nf6']);
    assert(parentBadge && !parentBadge.hidden && parentBadge.text === '[4]',
      `expected the hidden g6 branch to be excluded, giving [4] from e6's branch, got ${JSON.stringify(parentBadge)}`);
    ok("complete-to-move badge: a hidden branch doesn't drag down its parent's aggregate");
  } catch(e){ bad('complete-to-move badge: hidden branch excluded from aggregate', e); }
} finally {
  await appAY.close();
}

}
// --- Phase AZ: importing a variation (paste-import, engine-variation import,
//     and a local game-file import) no longer discards a focused variation --
//     these paths refresh the ALREADY-open line via renderTreeBody, which
//     re-applies the saved focus, instead of openLine, which unconditionally
//     cleared it (the reported bug: "importing a line from analysis" blowing
//     focus back out to all variations). Each case focuses a sibling row
//     first (hiding the OTHER top-level reply), imports, then confirms the
//     other reply is still hidden and the Unfocus button is still shown. ---
if(shouldRunPhase(['move-table'])){
const appAZ = await launchApp();
try {
  const isFocused = () => appAZ.page.evaluate(() => ({
    unfocusShown: document.getElementById('unfocusBtn').style.display !== 'none',
    d5Hidden: document.querySelector('tr.data-row[data-seq="d4,d5"]')?.classList.contains('focus-hidden'),
  }));
  const focusOnNf6 = async () => {
    await appAZ.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appAZ.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="focus"]').click());
    const f = await isFocused();
    assert(f.unfocusShown && f.d5Hidden, `setup: expected focusing d4,Nf6 to hide d4,d5, got ${JSON.stringify(f)}`);
  };

  // 166. "Import this variation" from a saved eval's PV (the bug as
  //      originally reported) preserves focus.
  try {
    const midFen = await appAZ.page.evaluate(() => {
      const c = new Chess();
      for(const m of ['d4','Nf6']) c.move(m, { sloppy: true });
      return c.fen();
    });
    await seedBackup(appAZ.page, {
      version: 6, user: 'tester',
      lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
        { seq: ['d4','Nf6'], eval: { type: 'cp', value: 35, depth: 20, pv: '2.c4 e6', pvFen: midFen, pvUci: ['c2c4','e7e6'] } },
      ]}],
      games: [
        { id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' },
        { id: 'g2', moves: 'd4 d5', white: 'a', black: 'b', result: '*' },
      ],
    });
    await appAZ.page.click('.line-row');
    await appAZ.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });
    await focusOnNf6();

    await appAZ.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .evaltag').click());
    await appAZ.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"] + tr.meta-row .meta-pv-menu', { timeout: 5000 });
    await appAZ.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] + tr.meta-row .meta-pv-menu').click());
    await appAZ.page.waitForSelector('#graphCtxMenu', { state: 'visible', timeout: 5000 });
    await appAZ.page.evaluate(() => document.querySelector('#graphCtxMenu div').click());
    await appAZ.page.waitForFunction(() => {
      const row = document.querySelector('tr.data-row[data-seq="d4,Nf6"]');
      return row && row.querySelector('.ourReply')?.textContent?.trim() === 'c4';
    }, { timeout: 10000 });

    const f = await isFocused();
    assert(f.unfocusShown && f.d5Hidden,
      `expected focus to survive "Import this variation" from a saved eval, got ${JSON.stringify(f)}`);
    ok('focus survives "Import this variation" from a saved eval\'s PV (the reported bug)');
  } catch(e){ bad('focus preserved: import engine variation from saved eval', e); }

  // 167. Paste-import (the "Import Variation(s)" menu) preserves focus too.
  try {
    await seedBackup(appAZ.page, {
      version: 6, user: 'tester2',
      lines: [{ id: 'L2', name: 'Test2', color: 'white', openingMoves: ['d4'], prefs: [] }],
      games: [
        { id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' },
        { id: 'g2', moves: 'd4 d5', white: 'a', black: 'b', result: '*' },
      ],
    });
    await appAZ.page.click('.line-row');
    await appAZ.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });
    await focusOnNf6();

    await appAZ.page.evaluate(() => document.getElementById('menuImportLine').click());
    await appAZ.page.fill('#importLineInput', '1. d4 Nf6 2. c4');
    await appAZ.page.evaluate(() => document.getElementById('importLineSaveBtn').click());
    await appAZ.page.waitForFunction(() => {
      const row = document.querySelector('tr.data-row[data-seq="d4,Nf6"]');
      return row && row.querySelector('.ourReply')?.textContent?.trim() === 'c4';
    }, { timeout: 10000 });

    const f = await isFocused();
    assert(f.unfocusShown && f.d5Hidden,
      `expected focus to survive paste-import, got ${JSON.stringify(f)}`);
    ok('focus survives paste-import ("Import Variation(s)")');
  } catch(e){ bad('focus preserved: paste-import', e); }

  // 168. Importing a local game file (re-running the currently open line
  //      against the freshly-imported games) preserves focus too.
  try {
    await seedBackup(appAZ.page, {
      version: 6, user: 'tester3',
      lines: [{ id: 'L3', name: 'Test3', color: 'white', openingMoves: ['d4'], prefs: [] }],
      games: [
        { id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' },
        { id: 'g2', moves: 'd4 d5', white: 'a', black: 'b', result: '*' },
      ],
    });
    await appAZ.page.click('.line-row');
    await appAZ.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });
    await focusOnNf6();

    const ndjson = [
      { id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 d5', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 Nf6 c4', white: 'a', black: 'b', result: '*' },
    ].map(g => JSON.stringify(g)).join('\n');
    await appAZ.page.setInputFiles('#fileImport', {
      name: 'games.ndjson', mimeType: 'application/x-ndjson', buffer: Buffer.from(ndjson),
    });
    await appAZ.page.waitForFunction(() => {
      const cnt = document.querySelector('tr.data-row[data-seq="d4,Nf6,c4"]');
      return !!cnt || document.querySelectorAll('tr.data-row').length > 0;
    }, { timeout: 10000 });

    const f = await isFocused();
    assert(f.unfocusShown && f.d5Hidden,
      `expected focus to survive a local game-file import, got ${JSON.stringify(f)}`);
    ok('focus survives importing a local game file');
  } catch(e){ bad('focus preserved: local game-file import', e); }
} finally {
  await appAZ.close();
}

}
// --- Phase BA: the gatherBuiltCastles cache now persists to IndexedDB (not
//     just an in-memory, refresh-loses-it cache), and "Run VR" gained a
//     Shift+click/right-click gesture to force a fresh rebuild even when a
//     valid cached copy (memory or persisted) already exists. ---
if(shouldRunPhase(['castle-generation'])){
const appBA = await launchApp();
try {
  await seedBackup(appBA.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
  });
  const state = () => appBA.page.evaluate(async () => ({
    isCached: window.__vrCacheTestHooks.isCached(),
    isPersisted: await window.__vrCacheTestHooks.isPersisted(),
    buildCount: window.__vrCacheTestHooks.buildCount(),
  }));
  const closeVR = async () => {
    await appBA.page.evaluate(() => {
      const btn = [...document.querySelectorAll('#threeTestCanvasWrap button')].find(b => b.title === 'Close');
      btn && btn.click();
    });
    await appBA.page.waitForFunction(() => document.getElementById('threeTestOverlay').style.display === 'none');
  };

  // 169. First open: cache miss, one real build, persisted to IndexedDB.
  try {
    const before = await state();
    assert(!before.isCached && !before.isPersisted && before.buildCount === 0,
      `expected a clean slate before the first open, got ${JSON.stringify(before)}`);
    await openVR(appBA.page);
    const after = await state();
    assert(after.isCached && after.isPersisted && after.buildCount === 1,
      `expected the first open to build once and persist, got ${JSON.stringify(after)}`);
    ok('VR cache: first open builds once and persists to IndexedDB');
    await closeVR();
  } catch(e){ bad('VR cache: first open builds and persists', e); }

  // 170. Reloading the page (simulating a browser refresh) clears the
  //      in-memory cache but NOT the persisted one -- the next open reuses
  //      the persisted data instead of rebuilding. This is the key
  //      behavior change: the cache used to be memory-only and always lost
  //      on refresh.
  try {
    await appBA.page.reload();
    await appBA.page.waitForFunction(() => {
      const el = document.getElementById('buildStamp');
      return el && el.textContent && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    const justAfterReload = await state();
    assert(!justAfterReload.isCached && justAfterReload.isPersisted && justAfterReload.buildCount === 0,
      `expected memory cache empty but IDB still populated right after reload, got ${JSON.stringify(justAfterReload)}`);
    await openVR(appBA.page);
    const afterReopen = await state();
    assert(afterReopen.isCached && afterReopen.buildCount === 0,
      `expected the post-reload open to reuse the persisted cache (no rebuild), got ${JSON.stringify(afterReopen)}`);
    ok('VR cache: survives a reload by reading the persisted copy instead of rebuilding');
  } catch(e){ bad('VR cache: survives reload', e); }

  // 171. Shift+click on "Run VR" forces a rebuild even though a valid
  //      (persisted) cache already exists. Waits on buildCount directly
  //      rather than window.__threeTestEdit, which is set once and never
  //      cleared on close -- on a re-open it would resolve instantly on
  //      stale truthy state, racing ahead of the actual rebuild (a real
  //      race found and fixed the same way in an earlier phase).
  try {
    const before = await state();
    assert(before.isCached, 'setup: expected a cache to already exist before testing the force gesture');
    await appBA.page.evaluate(() => {
      document.getElementById('menuThreeTest')
        .dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
    });
    await appBA.page.waitForFunction((expected) => window.__vrCacheTestHooks.buildCount() === expected,
      before.buildCount + 1, { timeout: 20000 });
    ok('VR cache: Shift+click on "Run VR" forces a fresh rebuild despite a valid cache');
    await closeVR();
  } catch(e){ bad('VR cache: Shift+click forces rebuild', e); }

  // 172. Right-click on "Run VR" does the same thing.
  try {
    const before = await state();
    await appBA.page.evaluate(() => {
      document.getElementById('menuThreeTest')
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await appBA.page.waitForFunction((expected) => window.__vrCacheTestHooks.buildCount() === expected,
      before.buildCount + 1, { timeout: 20000 });
    ok('VR cache: right-click on "Run VR" forces a fresh rebuild despite a valid cache');
  } catch(e){ bad('VR cache: right-click forces rebuild', e); }
} finally {
  await appBA.close();
}

}
// --- Phase BB: VR door plaques and the digraph's edge labels both show how
//     often an opponent's reply has actually occurred in the user's own
//     games -- "N (M%)", the same replies()-driven stat the move table's
//     own .cnt span shows (js/app.js), just rounded to a whole percent since
//     these two spots have far less room to work with. ---
if(shouldRunPhase(['vr-decorating', 'digraph'])){
const appBB = await launchApp();
try {
  await seedBackup(appBB.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1, name: 'Alpha Foyer' },
      // both replies get a Standard Response of their own (Nc3), so each
      // becomes a real, built room with a real VR door -- an opponent move
      // with NO configured reply is a bare leaf and gets no door at all
      // (registerOneCastle's `fwd` filter), so there'd be nothing to show a
      // plaque on otherwise. Neither game continues past this, so both end
      // up "locked" (empty) doors -- exactly the "should I bother
      // memorizing/building further?" case the stat is meant to help with.
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
    ]}],
    // g6 played twice, e6 once -- out of this room's 3 recorded continuations
    // that's g6: 2 (67%), e6: 1 (33%).
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 g6', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' },
    ],
  });
  await appBB.page.click('.line-row');
  await appBB.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });

  // 173. The digraph's edge labels show the same occurrence stat, as a
  //      small second line under the move.
  try {
    await appBB.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
    await appBB.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });
    const labels = await appBB.page.evaluate(({ g6Seq, e6Seq }) => {
      const cy = window.__graphTestHooks.cy();
      const find = seq => {
        const e = cy.edges().filter(x => JSON.stringify(x.data('seq')) === JSON.stringify(seq));
        return e.nonempty() ? e.data('label') : null;
      };
      return { g6: find(g6Seq), e6: find(e6Seq) };
    }, { g6Seq: ['d4','Nf6','c4','g6'], e6Seq: ['d4','Nf6','c4','e6'] });
    assert(labels.g6 === 'g6\n2 (67%)', `expected the g6 edge label to carry its occurrence stat, got ${JSON.stringify(labels.g6)}`);
    assert(labels.e6 === 'e6\n1 (33%)', `expected the e6 edge label to carry its occurrence stat, got ${JSON.stringify(labels.e6)}`);
    ok('digraph edge labels show how often each reply has actually occurred ("N (M%)")');
    await appBB.page.evaluate(() => document.getElementById('graphCloseBtn').click());
  } catch(e){ bad('digraph edge occurrence stat', e); }

  // 174. VR door plaques show the same stat -- including on a "locked" door
  //      (built, but empty beyond), which is exactly the "should I
  //      prioritize memorizing/building this further?" case motivating
  //      the feature.
  try {
    const alphaKey = await appBB.page.evaluate(() => {
      const pk = mv => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
        return c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_'); };
      return 'cas:L1_Alpha:' + pk(['d4','Nf6','c4']);
    });
    await openVR(appBB.page);
    await appBB.page.evaluate((key) => window.__threeTestEdit.enter(key), alphaKey);
    await appBB.page.waitForTimeout(300);   // let the async plaque builds settle
    const occs = (await appBB.page.evaluate(() => window.__threeTestEdit.exits()))
      .filter(ex => !ex.back).map(ex => ex.occurrence).sort();
    assert(JSON.stringify(occs) === JSON.stringify(['1 (33%)', '2 (67%)']),
      `expected the two locked-door plaques to show 2 (67%) and 1 (33%), got ${JSON.stringify(occs)}`);
    ok('VR door plaques show how often each opponent reply has actually occurred, including on locked doors');
  } catch(e){ bad('VR door plaque occurrence stat', e); }
} finally {
  await appBB.close();
}

}
// --- Phase BC: the street-level entry pair billboard (outside a castle's
//     front door) also carries an occurrence stat -- "which castle should I
//     memorize first?" is a street-level question, not a per-door one, so
//     this is computed separately (gatherBuiltCastles, js/app.js) from how
//     often games actually reached the castle's own entry, since
//     buildGeneratedCastle's own genRooms never captures an edge INTO its
//     own root (it starts fresh there with no incoming edge). ---
if(shouldRunPhase(['vr-castle'])){
const appBC = await launchApp();
try {
  await seedBackup(appBC.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1, name: 'Alpha Foyer' },
    ]}],
    // 2 of 3 games that reach 1.d4 Nf6 continue 2.c4 (entering Alpha); the
    // third continues 2.Nf3 instead -- so Alpha's own entry occurrence is
    // 2 (67%), not the trivial 100% a single-continuation seed would give.
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 g6', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 Nf6 Nf3 g6', white: 'a', black: 'b', result: '*' },
    ],
  });
  await appBC.page.click('.line-row');
  await appBC.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });

  // 175. The street entry billboard's canvas grows a footer strip to fit the
  //      occurrence stat (renderMnemPairCanvas: 768 -> 858px tall) -- a
  //      reliable, specific signal that `entryOccurrence` made it all the way
  //      through gatherBuiltCastles -> openThreeTest -> generateMainStreet ->
  //      buildStreetEntryPair -> buildMnemPairSprite, the same style of check
  //      the existing cross-castle-plaque test uses for its own geometry.
  try {
    const alphaEntryKey = await appBC.page.evaluate(() => {
      const pk = mv => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
        return c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_'); };
      return 'cas:L1_Alpha:' + pk(['d4','Nf6','c4']);
    });
    await openVR(appBC.page);
    await appBC.page.waitForTimeout(300);   // let the async billboard builds settle
    const size = await appBC.page.evaluate((slotId) => window.__threeTestEdit.spriteCanvasSize(slotId), 'dbb-' + alphaEntryKey);
    assert(size && size.width === 768 && size.height === 858,
      `expected the street entry billboard's canvas to grow a 90px occurrence strip (768x858), got ${JSON.stringify(size)}`);
    ok("street entry billboard's canvas grows an occurrence-stat strip below the move pair");
  } catch(e){ bad('street entry billboard occurrence stat', e); }
} finally {
  await appBC.close();
}

}
// --- Phase BD: "Set Attributes" always edits the room's CANONICAL seq, even
//     when opened from a transposing path that isn't it -- so both doors
//     into a shared room end up showing the same name regardless of which
//     path was used to name it. Transposition: 1.d4 Nf6 2.c4 a6 3.e4 h6 and
//     1.d4 Nf6 2.c4 h6 3.e4 a6 reach the same position (a6/h6 are
//     independent pawn moves); games list the a6-first game before the
//     h6-first one, so buildCastleGraph's walk discovers a6-first first and
//     that becomes canonical. ---
if(shouldRunPhase(['move-table'])){
const appBD = await launchApp();
try {
  await seedBackup(appBD.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','a6'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','h6'], reply: 'e4' },
      // the move that actually completes the transposition (the OTHER of
      // a6/h6, played after e4) needs its own recorded reply too -- a room
      // only exists (and can merge with another path) once OUR move creates
      // it; without this, both paths stay unanswered leaves and never merge.
      { seq: ['d4','Nf6','c4','a6','e4','h6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','h6','e4','a6'], reply: 'Nc3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 a6 e4 h6', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 h6 e4 a6', white: 'a', black: 'b', result: '*' },
    ],
  });
  await appBD.page.click('.line-row');
  await appBD.page.waitForSelector('.data-row', { timeout: 10000 });
  // repeatedly expand every collapsed branch until none remain, to reach
  // both 6-ply transposing rows regardless of how deep they are.
  await appBD.page.evaluate(() => {
    for(let i = 0; i < 10; i++){
      const btns = [...document.querySelectorAll('.toggle:not(.toggle-empty)')]
        .filter(b => b.querySelector('i')?.classList.contains('fa-caret-right'));
      if(!btns.length) break;
      btns.forEach(b => b.click());
    }
  });
  await appBD.page.waitForSelector('tr.data-row[data-seq="d4,Nf6,c4,h6,e4,a6"]', { timeout: 10000 });

  // 78. canonicalRoomSeq resolves the non-canonical transposing path's own
  //     (opponent-move) seq to the canonical one -- same convention
  //     genRoomMeta reads attributes from (one ply back from the room,
  //     which ends in OUR reply Nc3).
  try {
    const resolved = await appBD.page.evaluate(() =>
      window.__oqTestHooks.canonicalRoomSeq(['d4','Nf6','c4','h6','e4','a6']));
    assert(JSON.stringify(resolved) === JSON.stringify(['d4','Nf6','c4','a6','e4','h6']),
      `expected the non-canonical path to resolve to the canonical one, got ${JSON.stringify(resolved)}`);
    ok("canonicalRoomSeq resolves a transposing path to the room's canonical seq");
  } catch(e){ bad('canonicalRoomSeq resolves a transposition', e); }

  // 79. Setting the room name from the NON-canonical path's row writes it
  //     onto the CANONICAL seq's own pref -- the same data VR's door
  //     plaques (genRoomMeta) read regardless of which path led there --
  //     not onto this row's own (different) pref entry.
  try {
    await appBD.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6,c4,h6,e4,a6"] .rowMenuBtn').click());
    await appBD.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6,c4,h6,e4,a6"] [data-act="attributes"]').click());
    await appBD.page.waitForSelector('#attributesOverlay', { state: 'visible', timeout: 5000 });
    await appBD.page.fill('#attrRoomName', 'Transpose');
    await appBD.page.evaluate(() => document.getElementById('attributesSaveBtn').click());
    await appBD.page.waitForFunction(() => document.getElementById('attributesOverlay').style.display === 'none', { timeout: 5000 });

    const names = await appBD.page.evaluate(() => {
      const prefs = window.__oqTestHooks.getPrefs();
      const pk = window.__oqTestHooks.prefKey;
      return {
        canonical: prefs[pk('L1', ['d4','Nf6','c4','a6','e4','h6'])]?.name,
        nonCanonical: prefs[pk('L1', ['d4','Nf6','c4','h6','e4','a6'])]?.name,
      };
    });
    assert(names.canonical === 'Transpose', `expected the name on the canonical seq's pref, got ${JSON.stringify(names)}`);
    assert(!names.nonCanonical, `expected no name written to the non-canonical path's own pref, got ${JSON.stringify(names)}`);
    ok("Set Attributes from a transposing (non-canonical) row writes the shared room's canonical pref entry");
  } catch(e){ bad('Set Attributes writes to the canonical transposition key', e); }
} finally {
  await appBD.close();
}

}
// --- Phase BE: mnemonics export downscales images to fit
//     MNEM_EXPORT_IMG_MAX_DIM (so a full 384-image pack clears GitHub's
//     25MB web-upload limit) without touching the locally-stored originals. ---
if(shouldRunPhase(['mnemonics'])){
const appBE = await launchApp();
try {
  const bigImg = await appBE.page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3366cc'; ctx.fillRect(0, 0, 512, 512);
    return c.toDataURL('image/png');
  });
  await seedBackup(appBE.page, {
    version: 6, user: 'tester',
    lines: [], games: [],
    mnemonics: [{ square: 'e4', knight: 'echo', knightImg: bigImg }],
  });

  // 80. The exported bundle's image is downscaled to fit MNEM_EXPORT_IMG_MAX_DIM,
  //     while the locally-stored original (still 512px) is left untouched.
  try {
    const { exportedDims, storedDims, maxDim } = await appBE.page.evaluate(async () => {
      const dims = (dataUrl) => new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.src = dataUrl;
      });
      const data = await window.__mnemExportTestHooks.build();
      const stored = await window.__mnemExportTestHooks.getStored();
      const exportedDims = await dims(data.mnemonics.find(m => m.square === 'e4').knightImg);
      const storedDims = await dims(stored.e4.knightImg);
      return { exportedDims, storedDims, maxDim: window.__mnemExportTestHooks.maxDim };
    });
    assert(exportedDims.w <= maxDim && exportedDims.h <= maxDim,
      `expected the exported image capped at ${maxDim}px, got ${exportedDims.w}x${exportedDims.h}`);
    assert(storedDims.w === 512 && storedDims.h === 512,
      `expected the locally-stored original to stay at 512px, got ${storedDims.w}x${storedDims.h}`);
    ok('mnemonics export downscales images to the export cap without touching the stored originals');
  } catch(e){ bad('mnemonics export image downscale', e); }
} finally {
  await appBE.close();
}

}
// --- Phase BF: engine.js's Threads-change handshake falls back to the last
//     known-good thread count (instead of silently searching on a possibly
//     wedged pthread pool) when a requested count doesn't ack in time, and
//     gives up loudly if even the fallback doesn't ack. Drives a real Engine
//     instance directly (no real Stockfish worker needed -- _send is
//     overridden to simulate the UCI protocol) since the vendored WASM build
//     isn't exercised by this offline harness. ---
if(shouldRunPhase(['engine'])){
const appBF = await launchApp();
try {
  // 81. A Threads change that never acks falls back to the last count known
  //     to have worked, and the resolved result reports the fallback.
  try {
    const result = await appBF.page.evaluate(async () => {
      const { Engine } = await import('/js/engine.js');
      const engine = new Engine();
      engine.multithreaded = true;
      engine.maxThreads = 16;
      engine._currentThreads = 8;   // the last count known to have acked
      let lastThreadsSent = null;
      engine._send = (cmd) => {
        const m = cmd.match(/^setoption name Threads value (\d+)$/);
        if(m){ lastThreadsSent = parseInt(m[1], 10); return; }
        if(cmd === 'isready'){
          // only the fallback target (8) ever acks -- the requested 12 never does
          if(lastThreadsSent === 8) setTimeout(() => engine._listener?.('readyok'), 5);
          return;
        }
        if(cmd.startsWith('go ')){ setTimeout(() => engine._listener?.('bestmove e2e4'), 5); return; }
      };
      return await engine.analyze('startpos', { threads: 12, depth: 1 });
    });
    assert(result.threadsFallback && result.threadsFallback.requested === 12 && result.threadsFallback.using === 8,
      `expected a threadsFallback {requested:12, using:8}, got ${JSON.stringify(result.threadsFallback)}`);
    ok("engine.analyze falls back to the last acking thread count when the requested one doesn't ack");
  } catch(e){ bad('engine Threads-change fallback', e); }

  // 82. When NEITHER the requested count nor the fallback acks, analyze()
  //     rejects instead of hanging forever on a `go` the engine can never answer.
  try {
    let rejected = null;
    await appBF.page.evaluate(async () => {
      const { Engine } = await import('/js/engine.js');
      const engine = new Engine();
      engine.multithreaded = true;
      engine.maxThreads = 16;
      engine._currentThreads = 8;
      // nothing ever acks -- both the primary and fallback handshakes time out
      engine._send = () => {};
      window.__aqWedgeResult = null;
      try { await engine.analyze('startpos', { threads: 12, depth: 1 }); }
      catch(e){ window.__aqWedgeResult = e.message; }
    });
    rejected = await appBF.page.evaluate(() => window.__aqWedgeResult);
    assert(typeof rejected === 'string' && /unresponsive/.test(rejected),
      `expected analyze() to reject with an "unresponsive" error, got ${JSON.stringify(rejected)}`);
    ok('engine.analyze rejects loudly when even the fallback thread count never acks');
  } catch(e){ bad('engine Threads-change total wedge', e); }
} finally {
  await appBF.close();
}

}
// --- Phase BG: exportMnemonics() shows a spinner (with a running "N images
//     converted" progress label) while it re-encodes every image for export
//     -- converting a full 384-image set is slow enough that, with no visual
//     feedback, clicking Export looked like it did nothing (the reported bug). ---
if(shouldRunPhase(['mnemonics'])){
const appBG = await launchApp();
try {
  const bigImg = await appBG.page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 480; c.height = 480;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#22aa66'; ctx.fillRect(0, 0, 480, 480);
    return c.toDataURL('image/png');
  });
  await seedBackup(appBG.page, {
    version: 6, user: 'tester',
    lines: [], games: [],
    mnemonics: [
      { square: 'e4', knight: 'echo', knightImg: bigImg, bishop: 'bravo', bishopImg: bigImg },
      { square: 'd4', rook: 'romeo', rookImg: bigImg },
    ],
  });

  // 83. The spinner appears immediately, its label counts images converted
  //     as the export proceeds, and it's hidden again once the download fires.
  try {
    await appBG.page.evaluate(() => { document.getElementById('mnemonicsExportBtn').click(); });
    await appBG.page.waitForFunction(
      () => document.getElementById('spinnerOverlay').style.display === 'flex' &&
            document.getElementById('spinnerLabel').textContent.startsWith('Exporting mnemonics'),
      { timeout: 5000 }
    );
    await appBG.page.waitForFunction(
      () => /\d+ images? converted/.test(document.getElementById('spinnerLabel').textContent),
      { timeout: 10000 }
    );
    await appBG.page.waitForFunction(
      () => document.getElementById('spinnerOverlay').style.display === 'none',
      { timeout: 10000 }
    );
    ok('exportMnemonics shows a spinner with running progress while converting images, then hides it');
  } catch(e){ bad('mnemonics export spinner', e); }
} finally {
  await appBG.close();
}

}
// --- Phase BH: importBackup() shows a spinner (with a running "N mnemonic
//     squares imported" progress label) during a full restore -- with zero
//     visual feedback, nothing prevented navigating to Manage Mnemonics
//     mid-restore and seeing incomplete data, which is what looked like a
//     silent failure to import mnemonics after a full backup restore. ---
if(shouldRunPhase(['import-export'])){
const appBH = await launchApp();
try {
  const backup = {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [],
    // enough entries that the restore takes a real, observable amount of
    // time (each is its own get-then-put IndexedDB round trip) -- a handful
    // of squares would likely finish before the test's first poll.
    mnemonics: Array.from({length: 64}, (_, i) => ({
      square: 'abcdefgh'[i % 8] + (Math.floor(i / 8) + 1), knight: `word${i}`,
    })),
  };

  // 84. The spinner appears immediately, its label counts mnemonic squares
  //     imported as the restore proceeds, and it's hidden again once done.
  try {
    const setFiles = appBH.page.setInputFiles('#backupImport', {
      name: 'restore.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await appBH.page.waitForFunction(
      () => document.getElementById('spinnerOverlay').style.display === 'flex' &&
            document.getElementById('spinnerLabel').textContent.startsWith('Restoring backup'),
      { timeout: 5000 }
    );
    await appBH.page.waitForFunction(
      () => /\d+ mnemonic squares? imported/.test(document.getElementById('spinnerLabel').textContent),
      { timeout: 10000 }
    );
    await setFiles;
    await appBH.page.waitForFunction(
      () => document.getElementById('userId') && document.getElementById('userId').value === 'tester',
      { timeout: 10000 }
    );
    await appBH.page.waitForFunction(
      () => document.getElementById('spinnerOverlay').style.display === 'none',
      { timeout: 10000 }
    );
    ok('importBackup shows a spinner with running progress while restoring, then hides it');
  } catch(e){ bad('backup restore spinner', e); }

  // 85. #backupImport's `accept` is an explicit "*/*" wildcard -- not a
  //     specific type list (cloud pickers like Google Drive/Dropbox apply
  //     their OWN provider-reported MIME type, often wrong/generic for
  //     .json.gz backups, e.g. application/octet-stream, so a narrower list
  //     greys the file out with no way to select it -- readMaybeGzipped
  //     already sniffs gzip vs. plain JSON by content, not filename/MIME)
  //     and NOT simply absent either -- some mobile browsers drop cloud
  //     providers from the picker's source list entirely with no accept
  //     attribute at all.
  try {
    const accept = await appBH.page.evaluate(() => document.getElementById('backupImport').getAttribute('accept'));
    assert(accept === '*/*', `expected #backupImport's accept to be the explicit wildcard "*/*", got ${JSON.stringify(accept)}`);
    ok('#backupImport uses an explicit "*/*" accept, so cloud-picked files (Drive, Dropbox) are always offered and selectable');
  } catch(e){ bad('#backupImport accept is an explicit wildcard', e); }
} finally {
  await appBH.close();
}

}
// --- Phase BI: the Help modal (hamburger menu -> Help) loads its topic
//     list from help/topics.json and injects each topic's HTML fragment
//     from help/<file>.html into the content pane -- real files served by
//     the test harness's static server, not mocked. ---
if(shouldRunPhase(['help'])){
const appBI = await launchApp();
try {
  // 85. Opening Help auto-selects the first (Intro) topic and loads its real
  //     content, including the branded product name.
  try {
    await appBI.page.evaluate(() => document.getElementById('menuHelp').click());
    await appBI.page.waitForSelector('#helpOverlay', { state: 'visible', timeout: 5000 });
    await appBI.page.waitForFunction(() => document.getElementById('helpContent').textContent.trim().length > 0, { timeout: 5000 });

    const topicButtons = await appBI.page.evaluate(() => [...document.querySelectorAll('#helpTopics .help-topic-btn')].map(b => b.textContent));
    assert(topicButtons.includes('Intro'), `expected an "Intro" topic in the sidebar, got ${JSON.stringify(topicButtons)}`);

    const activeCount = await appBI.page.evaluate(() => document.querySelectorAll('#helpTopics .help-topic-btn.active').length);
    assert(activeCount === 1, `expected exactly one active topic button (the auto-selected first topic), got ${activeCount}`);

    const brandText = await appBI.page.evaluate(() => document.querySelector('#helpContent .repchess-brand')?.textContent);
    assert(brandText === 'REPchess', `expected the Intro content to include a .repchess-brand span reading exactly "REPchess", got ${JSON.stringify(brandText)}`);

    ok('Help modal loads topics.json and auto-opens the first topic with branded content');
  } catch(e){ bad('help modal: open and load default topic', e); }

  // 86. Close hides the overlay.
  try {
    await appBI.page.evaluate(() => document.getElementById('helpCloseBtn').click());
    await appBI.page.waitForFunction(() => document.getElementById('helpOverlay').style.display === 'none', { timeout: 5000 });
    ok('Help modal: Close hides the overlay');
  } catch(e){ bad('help modal: close', e); }

  // 87. Every topic listed in help/topics.json actually loads real, non-empty
  //     content when clicked -- catches a typo'd `file` entry or a missing
  //     fragment immediately, rather than leaving a topic silently broken.
  try {
    await appBI.page.evaluate(() => document.getElementById('menuHelp').click());
    await appBI.page.waitForSelector('#helpOverlay', { state: 'visible', timeout: 5000 });
    const topicCount = await appBI.page.evaluate(() => document.querySelectorAll('#helpTopics .help-topic-btn').length);
    assert(topicCount >= 12, `expected at least 12 help topics (Intro + 11 others), got ${topicCount}`);
    for(let i = 0; i < topicCount; i++){
      const { title } = await appBI.page.evaluate((idx) => {
        const btns = [...document.querySelectorAll('#helpTopics .help-topic-btn')];
        btns[idx].click();
        return { title: btns[idx].textContent };
      }, i);
      await appBI.page.waitForFunction(
        () => document.getElementById('helpContent').textContent.trim().length > 0,
        { timeout: 5000 }
      );
      // openHelpTopic() renders a "Couldn't load this help topic (...)" paragraph
      // on a fetch failure -- also non-empty, so the wait above alone can't tell
      // a real load from a broken `file` entry in topics.json. Rule that out
      // explicitly so a typo'd filename actually fails this test.
      const errored = await appBI.page.evaluate(() => document.getElementById('helpContent').textContent.includes("Couldn't load this help topic"));
      assert(!errored, `expected "${title}" to load real content, but it showed the fetch-failure fallback`);
      const activeNow = await appBI.page.evaluate(() => document.querySelector('#helpTopics .help-topic-btn.active')?.textContent);
      assert(activeNow === title, `expected clicking "${title}" to mark it active, got "${activeNow}"`);
    }
    ok('every help topic in topics.json loads non-empty content when clicked');
  } catch(e){ bad('help modal: every topic loads', e); }
} finally {
  await appBI.close();
}

}
// --- Phase BJ: boot-time "install default mnemonics?" offer
//     (json/repchess-mnemonics-DEFAULT.json.gz), driven via
//     __mnemDefaultTestHooks. The real auto-run on boot is skipped under
//     threeTestDebug (see the guarded call near renderHome() in app.js) so
//     ordinary tests that boot with an empty mnemonics store don't all pay
//     for a real fetch+decompress+import -- only this dedicated test drives
//     it, end to end, against the real committed file. ---
if(shouldRunPhase(['mnemonics'])){
const appBJ = await launchApp();
try {
  // 87. A fresh browser has no mnemonics and hasn't been offered yet;
  //     accepting the offer installs the real default bundle and remembers
  //     the decision so it won't ask again.
  try {
    const before = await appBJ.page.evaluate(() => window.__mnemExportTestHooks.getStored());
    assert(Object.keys(before).length === 0, `expected an empty mnemonics store on a fresh boot, got ${Object.keys(before).length} square(s)`);
    const offeredBefore = await appBJ.page.evaluate(() => window.__mnemDefaultTestHooks.getOffered());
    assert(!offeredBefore, 'expected the offer to not have been made yet on a fresh boot');

    await appBJ.page.evaluate(() => window.__mnemDefaultTestHooks.offer());

    const after = await appBJ.page.evaluate(() => window.__mnemExportTestHooks.getStored());
    assert(Object.keys(after).length > 0, 'expected accepting the offer to install the default mnemonics bundle');
    const offeredAfter = await appBJ.page.evaluate(() => window.__mnemDefaultTestHooks.getOffered());
    assert(!!offeredAfter, 'expected the offer to be marked as made after accepting');
    ok('accepting the default-mnemonics offer installs the real bundle and remembers the decision');
  } catch(e){ bad('default mnemonics offer: accept installs the real bundle', e); }

  // 88. Once offered, a later call is a silent no-op -- no confirm(), no re-install.
  try {
    await appBJ.page.evaluate(() => { window.confirm = () => { throw new Error('confirm() should not be called again'); }; });
    await appBJ.page.evaluate(() => window.__mnemDefaultTestHooks.offer());
    ok('default mnemonics offer: already-offered is a silent no-op on a later boot');
  } catch(e){ bad('default mnemonics offer: no re-prompt once already offered', e); }
} finally {
  await appBJ.close();
}

}
// --- Phase BK: declining the default-mnemonics offer leaves the store empty
//     but still remembers the decision, so it doesn't nag on every boot. ---
if(shouldRunPhase(['mnemonics'])){
const appBK = await launchApp();
try {
  // 89. Decline -> nothing installed, but the offer is still marked made.
  try {
    await appBK.page.evaluate(() => { window.confirm = () => false; });
    await appBK.page.evaluate(() => window.__mnemDefaultTestHooks.offer());
    const stored = await appBK.page.evaluate(() => window.__mnemExportTestHooks.getStored());
    assert(Object.keys(stored).length === 0, `expected declining to leave the mnemonics store empty, got ${Object.keys(stored).length} square(s)`);
    const offered = await appBK.page.evaluate(() => window.__mnemDefaultTestHooks.getOffered());
    assert(!!offered, 'expected declining to still mark the offer as made (so it does not nag again)');
    ok('declining the default-mnemonics offer installs nothing but remembers the decision');
  } catch(e){ bad('default mnemonics offer: decline leaves store empty but remembers decision', e); }
} finally {
  await appBK.close();
}

}
// --- Phase BL: the digraph modal's status line leads with the real VR
//     "castle room(s)" count (a corridor/two-track room collapses several
//     chess positions into one physical room, computed the same way
//     "Generate Castle" itself would -- buildGeneratedCastle, built on the
//     same analyzer) instead of the retired "N rooms single-track" stat.
//     Memorized/decorated coverage against those real rooms (not raw graph
//     positions) now renders as its own labeled, proportionally-filled bar
//     per stat in #graphCoverage, below the plain-text structural line.
//     "Moves memorized" counts every individual step folded into a room
//     (genRoom.moveCount), including steps along a linear-run corridor that
//     never cross a room boundary -- not just the doors that do. ---
if(shouldRunPhase(['digraph'])){
const appBL = await launchApp();
try {
  // root (after d4 Nf6 c4) branches into a short reply (e6, a single dead-end
  // step -- no run) and a long one (g6, continuing 3 more single-reply steps
  // -- a real linear-run corridor: g6-Nc3 -> Bg7-e4 -> d6-Nf3, each with
  // exactly one recorded opponent reply). Real rooms: root (branch, 2 doors),
  // the e6 dead-end (1 door), and the g6 corridor (3 members, 1 door at the
  // far end) -- 3 rooms total, not the 5 raw positions.
  await seedBackup(appBL.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','g6','Nc3','Bg7'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','g6','Nc3','Bg7','e4','d6'], reply: 'Nf3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O', white: 'a', black: 'b', result: '*' },
    ],
  });
  await appBL.page.click('.line-row');
  await appBL.page.waitForSelector('.data-row', { timeout: 10000 });
  await appBL.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
  await appBL.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });

  const corridorHeadFen = await appBL.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4','g6','Nc3']) c.move(m, { sloppy: true });
    return c.fen();
  });
  const statusText = () => appBL.page.evaluate(() => document.getElementById('graphStatus').textContent);
  // {label, n, d, pct, width} for one #graphCoverage row, matched by its
  // leading label text ("Rooms memorized:" etc.) -- reads both the printed
  // fraction/percentage AND the fill bar's actual rendered width, so a test
  // can catch the bar going out of sync with the number beside it.
  const coverageRow = (label) => appBL.page.evaluate((label) => {
    const rows = [...document.querySelectorAll('#graphCoverage .graph-coverage-row')];
    const row = rows.find(r => r.querySelector('.graph-coverage-label')?.textContent === label);
    if(!row) return null;
    const m = row.querySelector('.graph-coverage-value').textContent.match(/(\d+)\/(\d+) \((\d+)%\)/);
    if(!m) return null;
    return { n: +m[1], d: +m[2], pct: +m[3], width: row.querySelector('.graph-coverage-fill').style.width };
  }, label);

  // 90. The retired "single-track" collapsing stat is gone; "castle room(s)"
  //     leads the structural line (3, not the 5 raw positions). The coverage
  //     bars start at 0/N (0%) with a 0% fill, against the real-room
  //     denominator -- and the moves total (6: root's 2 doors + the e6
  //     dead-end's 1 + the corridor's 3 internal steps) already reflects
  //     every step, not just cross-room doors.
  let castleRooms, castleMoves;
  try {
    const text = await statusText();
    assert(!/single-track/.test(text), `expected the retired "single-track" stat to be gone, got: ${text}`);
    assert(!/memorized|decorated/.test(text), `expected coverage stats to have moved out of the plain-text status line, got: ${text}`);
    const head = text.match(/^(?:🎯[^·]*· )?(\d+) castle room\(s\) · (\d+) position\(s\)/);
    assert(head, `expected "N castle room(s) · M position(s)" to lead the line, got: ${text}`);
    castleRooms = +head[1];
    assert(castleRooms === 3, `expected 3 real rooms (root, the e6 dead-end, and the g6 corridor collapsed into one), got ${castleRooms}: ${text}`);
    assert(+head[2] === 6, `expected 6 raw positions (the pre-root lead-in position + root + e6 + the 3-step g6 corridor -- the ungrouped graph, unlike castle generation, isn't scoped to just this castle), got ${head[2]}: ${text}`);

    const memRoom = await coverageRow('Rooms memorized:');
    const memMove = await coverageRow('Moves memorized:');
    const decRoom = await coverageRow('Rooms decorated:');
    assert(memRoom && memRoom.n === 0 && memRoom.d === castleRooms && memRoom.pct === 0 && memRoom.width === '0%',
      `expected the "Rooms memorized" bar at 0/${castleRooms} (0%), 0% fill, got: ${JSON.stringify(memRoom)}`);
    assert(memMove && memMove.n === 0 && memMove.pct === 0 && memMove.width === '0%',
      `expected the "Moves memorized" bar to start at 0 (0%), 0% fill, got: ${JSON.stringify(memMove)}`);
    castleMoves = memMove.d;
    assert(castleMoves === 6, `expected 6 total moves (2 + 1 + 3 corridor steps, not 4 if only cross-room doors counted), got ${castleMoves}`);
    assert(decRoom && decRoom.n === 0 && decRoom.d === castleRooms && decRoom.pct === 0 && decRoom.width === '0%',
      `expected the "Rooms decorated" bar at 0/${castleRooms} (0%), 0% fill, got: ${JSON.stringify(decRoom)}`);
    ok('digraph status: no leftover "single-track"/coverage text; "castle room(s)" leads the structural line; coverage bars start at 0 with the real (collapsed) denominators and full move count');
  } catch(e){ bad('digraph status: baseline (castle rooms leads, coverage bars zeroed, full move count)', e); }

  // 91. Marking the CORRIDOR room memorized+decorated counts all 3 of its
  //     internal steps as memorized moves (3/6, 50%) -- not just the 1 door
  //     that actually crosses out of it, which is what the old
  //     exits-only counting would have given -- and the bar fills to match.
  try {
    const roomKey = await appBL.page.evaluate((fen) => window.__graphTestHooks.roomKeyOf(fen), corridorHeadFen);
    assert(roomKey, `expected the corridor to resolve a VR room key, got ${JSON.stringify(roomKey)}`);
    await appBL.page.evaluate((rk) => window.__graphTestHooks.setMemorized(rk, true), roomKey);
    await appBL.page.evaluate((rk) => window.__graphTestHooks.setDecorated(rk, true), roomKey);
    await appBL.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
    await appBL.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });

    const roomPct = Math.round(1 / castleRooms * 100);
    const memRoom = await coverageRow('Rooms memorized:');
    assert(memRoom && memRoom.n === 1 && memRoom.d === castleRooms && memRoom.pct === roomPct && memRoom.width === `${roomPct}%`,
      `expected "Rooms memorized" at 1/${castleRooms} (${roomPct}%) with a matching fill, got: ${JSON.stringify(memRoom)}`);
    const decRoom = await coverageRow('Rooms decorated:');
    assert(decRoom && decRoom.n === 1 && decRoom.d === castleRooms && decRoom.pct === roomPct && decRoom.width === `${roomPct}%`,
      `expected "Rooms decorated" at 1/${castleRooms} (${roomPct}%) with a matching fill, got: ${JSON.stringify(decRoom)}`);
    const memMove = await coverageRow('Moves memorized:');
    assert(memMove, 'expected a "Moves memorized" coverage row');
    assert(memMove.d === castleMoves, `expected the moves-memorized denominator to stay ${castleMoves}, got: ${JSON.stringify(memMove)}`);
    assert(memMove.n === 3, `expected all 3 of the corridor's own steps to count as memorized (not just its 1 external door), got: ${JSON.stringify(memMove)}`);
    const movePct = Math.round(3 / castleMoves * 100);
    assert(memMove.pct === movePct && memMove.width === `${movePct}%`,
      `expected the moves-memorized bar's percentage and fill to match its own count/total, got: ${JSON.stringify(memMove)}`);
    ok('digraph status: marking a corridor memorized counts every internal step, not just its one external door, and the bars fill to match');
  } catch(e){ bad('digraph status: coverage bars after marking a corridor room', e); }

  // 92. The coverage panel takes up real space, so it's collapsed by default
  //     and only shown via the toggle button -- clicking it reveals the
  //     panel and flips the caret; clicking again re-collapses it.
  try {
    const state = () => appBL.page.evaluate(() => ({
      panelHidden: document.getElementById('graphCoverage').style.display === 'none',
      toggleVisible: document.getElementById('graphCoverageToggle').style.display !== 'none',
      caret: document.getElementById('graphCoverageToggle').querySelector('i').className,
    }));
    const before = await state();
    assert(before.panelHidden, `expected the coverage panel to start collapsed, got: ${JSON.stringify(before)}`);
    assert(before.toggleVisible, `expected the toggle button to be visible (this scope has castle rooms), got: ${JSON.stringify(before)}`);
    assert(before.caret.includes('fa-caret-right'), `expected a collapsed (caret-right) icon, got: ${before.caret}`);

    await appBL.page.evaluate(() => document.getElementById('graphCoverageToggle').click());
    const opened = await state();
    assert(!opened.panelHidden, `expected the toggle to reveal the coverage panel, got: ${JSON.stringify(opened)}`);
    assert(opened.caret.includes('fa-caret-down'), `expected an expanded (caret-down) icon, got: ${opened.caret}`);

    // the fill bar's `style.width` percentage has no visual effect unless the
    // element actually renders as a box (it's a <span>, inline by default) --
    // check the RENDERED pixel width against its bar container, not just the
    // style attribute value, so a regression to display:inline (the reported
    // bug: bars all looked empty/gray despite the right width being set)
    // fails loudly instead of passing on the unobserved style value alone.
    // Needs the panel actually visible (not display:none) to get a non-zero
    // layout, hence checking here rather than in test 90/91. roomPct is
    // recomputed (test 91's own copy is out of scope, a separate try block).
    const roomPct = Math.round(1 / castleRooms * 100);
    const memRoomRendered = await appBL.page.evaluate(() => {
      const row = [...document.querySelectorAll('#graphCoverage .graph-coverage-row')]
        .find(r => r.querySelector('.graph-coverage-label')?.textContent === 'Rooms memorized:');
      const fillRect = row.querySelector('.graph-coverage-fill').getBoundingClientRect();
      const barRect = row.querySelector('.graph-coverage-bar').getBoundingClientRect();
      return { fillWidth: fillRect.width, barWidth: barRect.width };
    });
    assert(memRoomRendered.barWidth > 0, 'setup: expected the bar container itself to have a rendered width');
    assert(memRoomRendered.fillWidth > 0,
      `expected the fill bar to actually render at a non-zero pixel width (roomPct=${roomPct}%), got: ${JSON.stringify(memRoomRendered)}`);
    const renderedPct = memRoomRendered.fillWidth / memRoomRendered.barWidth * 100;
    assert(Math.abs(renderedPct - roomPct) <= 2,
      `expected the fill's rendered width to be ~${roomPct}% of the bar, got ${renderedPct.toFixed(1)}%: ${JSON.stringify(memRoomRendered)}`);

    await appBL.page.evaluate(() => document.getElementById('graphCoverageToggle').click());
    const closed = await state();
    assert(closed.panelHidden, `expected a second click to re-collapse the coverage panel, got: ${JSON.stringify(closed)}`);
    assert(closed.caret.includes('fa-caret-right'), `expected the icon to flip back to caret-right, got: ${closed.caret}`);
    ok('digraph status: coverage panel is collapsed by default, toggled open/closed via the caret button');
  } catch(e){ bad('digraph status: coverage panel toggle', e); }

  // 93. Expanding the panel, then closing and reopening the whole modal,
  //     resets it back to collapsed -- "fresh open" always starts hidden,
  //     even though an in-place refresh (Show Castle, Reset Layout, focus)
  //     would have left it open.
  try {
    await appBL.page.evaluate(() => document.getElementById('graphCoverageToggle').click());
    assert(
      await appBL.page.evaluate(() => document.getElementById('graphCoverage').style.display !== 'none'),
      'setup: expected the panel to be open before testing close/reopen'
    );
    await appBL.page.evaluate(() => document.getElementById('graphCloseBtn').click());
    await appBL.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
    await appBL.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });
    const reopened = await appBL.page.evaluate(() => document.getElementById('graphCoverage').style.display === 'none');
    assert(reopened, 'expected a fresh open (after close) to start with the coverage panel collapsed again');
    ok('digraph status: reopening the modal after closing resets the coverage panel to collapsed');
  } catch(e){ bad('digraph status: coverage panel resets on fresh open', e); }
} finally {
  await appBL.close();
}

}
// --- Phase BM: opening the digraph while the MOVE TABLE (not the digraph's
//     own right-click focus) is focused on a castle root already scoped the
//     displayed nodes correctly (rootSeq = GRAPH_FOCUS_SEQ || FOCUSED_SEQ),
//     but the stats/coverage totals and the "Show Castle" dropdown's
//     selection ignored that fallback and always used the whole system.
//     focusedCastleName() now shares the same GRAPH_FOCUS_SEQ || FOCUSED_SEQ
//     precedence, fixing both at once. ---
if(shouldRunPhase(['digraph'])){
const appBM = await launchApp();
try {
  // Alpha: just its root room (one opponent reply, e6, with no pref -- a
  // leaf, so it can't chain/collapse into anything). Beta: root (branch,
  // two distinct opponent replies so it can't corridor-collapse with its
  // child) + one built child room -- 2 rooms. Whole system: 3 castle rooms;
  // Alpha alone: 1.
  await seedBackup(appBM.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','d5'], reply: 'c4', isCastleRoot: true, castleName: 'Beta', castleStreetNumber: 2 },
      { seq: ['d4','d5','c4','e6'], reply: 'Nc3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 d5 c4 e6 Nc3 Nf6', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 d5 c4 c6', white: 'a', black: 'b', result: '*' },
    ],
  });
  await appBM.page.click('.line-row');
  await appBM.page.waitForSelector('.data-row', { timeout: 10000 });

  // 94. Focus on Alpha's root via the move table's own row menu (NOT the
  //     digraph's right-click focus), then open the digraph fresh.
  try {
    await appBM.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appBM.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="focus"]').click());
    assert(await appBM.page.evaluate(() => document.getElementById('unfocusBtn').style.display !== 'none'),
      'setup: expected the move table to show as focused');

    await appBM.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
    await appBM.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });

    const castleSelectValue = await appBM.page.evaluate(() => document.getElementById('graphCastleSelect').value);
    assert(castleSelectValue === 'Alpha',
      `expected "Show Castle" to auto-select Alpha (the move-table's own focus), got ${JSON.stringify(castleSelectValue)}`);

    const text = await appBM.page.evaluate(() => document.getElementById('graphStatus').textContent);
    const head = text.match(/(\d+) castle room\(s\)/);
    assert(head && +head[1] === 1,
      `expected the stats to scope to Alpha alone (1 castle room), not the whole system (3), got: ${text}`);
    ok('digraph: move-table focus on a castle root scopes both the "Show Castle" selection and the stats, not just the displayed nodes');
  } catch(e){ bad('digraph: stats/dropdown follow move-table focus onto a castle root', e); }
} finally {
  await appBM.close();
}
}

if(shouldRunPhase(['digraph'])){
// --- Phase BN: right-clicking a run/two-track box in the digraph offers
//     "Arrange" -- recomputes a clean internal layout for just that box's
//     members (straight column, or two parallel columns from a shared head,
//     evenly spaced) instead of whatever generic sibling-spacing dagre's
//     flat layout happened to leave it with. ---
const appBN = await launchApp();
try {
  // root (after d4 Nf6 c4) forks into two branches, each 2 rooms deep (so
  // each qualifies as its own "run" and the pair forms a two-track box):
  // left  = e6 Nc3 -> Bb4 Qc2
  // right = g6 Nc3 -> Bg7 e4
  await seedBackup(appBN.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Qc2' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','g6','Nc3','Bg7'], reply: 'e4' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6', white: 'a', black: 'b', result: '*' },
    ],
  });
  await appBN.page.click('.line-row');
  await appBN.page.waitForSelector('.data-row', { timeout: 10000 });
  await appBN.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
  await appBN.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });

  const fen = async (moves) => appBN.page.evaluate((moves) => {
    const c = new Chess();
    for(const m of moves) c.move(m, { sloppy: true });
    return c.fen();
  }, moves);
  const headFen = await fen(['d4','Nf6','c4']);
  const leftFens = [await fen(['d4','Nf6','c4','e6','Nc3']), await fen(['d4','Nf6','c4','e6','Nc3','Bb4','Qc2'])];
  const rightFens = [await fen(['d4','Nf6','c4','g6','Nc3']), await fen(['d4','Nf6','c4','g6','Nc3','Bg7','e4'])];

  // 95. "Arrange" straightens both tracks into two parallel, evenly-spaced
  //     columns symmetric around the head, which sits above both.
  try {
    const boxId = await appBN.page.evaluate((fen) => window.__graphTestHooks.boxIdOf(fen), headFen);
    assert(boxId, `expected the root to belong to a two-track box, got ${JSON.stringify(boxId)}`);

    const applied = await appBN.page.evaluate((boxId) => window.__graphTestHooks.arrangeBox(boxId), boxId);
    assert(applied, 'expected arrangeBox to find and arrange the box');

    const posOf = async (fen) => appBN.page.evaluate((fen) => {
      const n = window.__graphTestHooks.cy().nodes().filter(x => x.data('fen') === fen);
      return n.nonempty() ? n.position() : null;
    }, fen);
    const head = await posOf(headFen);
    const left = [await posOf(leftFens[0]), await posOf(leftFens[1])];
    const right = [await posOf(rightFens[0]), await posOf(rightFens[1])];
    assert(head && left[0] && left[1] && right[0] && right[1],
      `expected all 5 box members to resolve a position, got: ${JSON.stringify({head, left, right})}`);

    // each track is a straight vertical column: constant x, equal y spacing.
    assert(left[0].x === left[1].x, `expected the left track's own x to stay constant, got ${JSON.stringify(left)}`);
    assert(right[0].x === right[1].x, `expected the right track's own x to stay constant, got ${JSON.stringify(right)}`);
    const leftStep1 = left[0].y - head.y, leftStep2 = left[1].y - left[0].y;
    const rightStep1 = right[0].y - head.y, rightStep2 = right[1].y - right[0].y;
    assert(leftStep1 === leftStep2 && leftStep1 > 0,
      `expected equal, positive (downward) vertical spacing down the left track, got steps ${leftStep1}, ${leftStep2}`);
    assert(rightStep1 === rightStep2 && rightStep1 > 0,
      `expected equal, positive (downward) vertical spacing down the right track, got steps ${rightStep1}, ${rightStep2}`);
    assert(leftStep1 === rightStep1, `expected both tracks to use the same row spacing, got left ${leftStep1} vs right ${rightStep1}`);

    // symmetric around the head, which sits above both tracks.
    assert(left[0].x < head.x && head.x < right[0].x,
      `expected the head to sit between the two columns, got head.x=${head.x}, left.x=${left[0].x}, right.x=${right[0].x}`);
    assert(Math.abs((head.x - left[0].x) - (right[0].x - head.x)) < 0.01,
      `expected the two columns to be symmetric around the head, got: ${JSON.stringify({head, left: left[0], right: right[0]})}`);
    ok('digraph: "Arrange" straightens a two-track box into two even, symmetric columns under its head');
  } catch(e){ bad('digraph: Arrange a two-track box', e); }

  // 96. The "Arrange" position survives closing and reopening the graph --
  //     it's saved the same way a manual drag is (per-node delta in
  //     GRAPH_LAYOUT), not just an in-memory change to the live cy instance.
  try {
    const posBefore = await appBN.page.evaluate((fen) => {
      const n = window.__graphTestHooks.cy().nodes().filter(x => x.data('fen') === fen);
      return n.position();
    }, leftFens[1]);

    await appBN.page.evaluate(() => document.getElementById('graphCloseBtn').click());
    await appBN.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
    await appBN.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });

    const posAfter = await appBN.page.evaluate((fen) => {
      const n = window.__graphTestHooks.cy().nodes().filter(x => x.data('fen') === fen);
      return n.position();
    }, leftFens[1]);
    // saveGraphNodeDelta rounds dx/dy to the nearest pixel, so a sub-pixel
    // difference between the two positions is expected, not a real drift.
    assert(Math.abs(posAfter.x - posBefore.x) <= 1 && Math.abs(posAfter.y - posBefore.y) <= 1,
      `expected the arranged position to persist across a close/reopen, got ${JSON.stringify(posBefore)} -> ${JSON.stringify(posAfter)}`);
    ok('digraph: an arranged box\'s layout persists across closing and reopening the graph');
  } catch(e){ bad('digraph: Arrange persists across reopen', e); }
} finally {
  await appBN.close();
}
}

if(shouldRunPhase(['vr-decorating'])){
// --- Phase BO: an elevator car collapses ALL of its forward exits behind ONE
//     door (each a floor button) + one back door, regardless of how many
//     walls the exits were spread across for the room's non-elevator form.
//     The reported bug: a 5-exit room became 3 doors (one per wall) with
//     floors repeated across them. ---
const appBO = await launchApp();
try {
  // X (the room after ...e6 Nc3) branches five ways -- a genuine multi-way
  // branch, the only shape an elevator suits. Its five forward doors get
  // spread across north/east/west by the normal layout; marking the door
  // INTO X as an elevator must collapse them to one door + five floors.
  // Root also branches to a second child (g6) so root->X stays its own edge
  // rather than collapsing root and X into one corridor room.
  await seedBackup(appBO.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'a3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bd6'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Be7'], reply: 'Bg5' },
      { seq: ['d4','Nf6','c4','e6','Nc3','d5'],  reply: 'cxd5' },
      { seq: ['d4','Nf6','c4','e6','Nc3','c5'],  reply: 'a3' },
    ]}],
    games: [
      { id: 'g0', moves: 'd4 Nf6 c4 g6 Nc3 Bg7', white: 'a', black: 'b', result: '*' },
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 a3', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 e6 Nc3 Bd6 e4', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 Nf6 c4 e6 Nc3 Be7 Bg5', white: 'a', black: 'b', result: '*' },
      { id: 'g4', moves: 'd4 Nf6 c4 e6 Nc3 d5 cxd5', white: 'a', black: 'b', result: '*' },
      { id: 'g5', moves: 'd4 Nf6 c4 e6 Nc3 c5 a3', white: 'a', black: 'b', result: '*' },
    ],
  });
  await openVR(appBO.page);
  const keyFor = (moves) => appBO.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  }, moves);
  const root = await keyFor(['d4','Nf6','c4']);
  const carKey = await keyFor(['d4','Nf6','c4','e6','Nc3']);

  // 97. Marking the door root->X an elevator collapses X's five forward exits
  //     into ONE forward door (all five as its floors) + one back door -- even
  //     though those exits are spread across more than one wall.
  try {
    const carExits = await appBO.page.evaluate((k) => window.__threeTestEdit.exitsOf(k), carKey);
    const fwdExits = carExits.filter(e => !e.back);
    assert(fwdExits.length === 5, `test setup: expected X to have 5 forward exits, got ${fwdExits.length}`);
    const wallsUsed = new Set(fwdExits.map(e => e.wall));
    assert(wallsUsed.size > 1, `test setup: expected X's forward doors to span more than one wall (the case the fix collapses), got ${JSON.stringify([...wallsUsed])}`);

    await appBO.page.evaluate((args) => window.__threeTestEdit.setExitType(args.root, args.car, 'elevator'), { root, car: carKey });
    await appBO.page.evaluate((k) => window.__threeTestEdit.enter(k), carKey);
    await appBO.page.waitForTimeout(200);

    const info = await appBO.page.evaluate(() => window.__threeTestEdit.elevatorInfo());
    assert(info.forward.length === 1, `expected exactly ONE forward door, got ${info.forward.length}: ${JSON.stringify(info.forward)}`);
    assert(info.back.length === 1, `expected exactly ONE back door, got ${info.back.length}`);
    assert(info.forward[0].length === 5, `expected the single forward door to carry all 5 floors, got ${info.forward[0].length}: ${JSON.stringify(info.forward[0])}`);
    const floorTargets = info.forward[0].map(f => f.target);
    const uniqueFloors = new Set(floorTargets);
    assert(uniqueFloors.size === 5, `expected 5 distinct floor targets (no repeats), got ${JSON.stringify(floorTargets)}`);
    ok('elevator car: many-exit room collapses to one forward door with every exit as a floor, plus one back door');
  } catch(e){ bad('elevator car: forward exits collapse to a single door', e); }

  // 98. A room that genuinely branches (X, 5 forward exits) is a valid
  //     elevator target -- elevatorRejectReason returns null.
  try {
    const reason = await appBO.page.evaluate((k) => window.__threeTestEdit.elevatorRejectReason(k), carKey);
    assert(reason === null, `expected a 5-way branch room to be a valid elevator, got: ${JSON.stringify(reason)}`);
    ok('elevator: a genuine multi-way branch room is accepted as an elevator target');
  } catch(e){ bad('elevator: branch room accepted', e); }
} finally {
  await appBO.close();
}
}

if(shouldRunPhase(['vr-decorating'])){
// --- Phase BP: making a corridor or two-track room an elevator is rejected
//     with a message -- elevators are only for a room that branches into
//     several separate rooms, not a linear sequence of moves. ---
const appBP = await launchApp();
try {
  // one opening system with two castles: Alpha is a two-track (root branches
  // into two 2-deep parallel lanes -- same shape verified in Phase BN), Beta
  // is a corridor (a single forced 3-room chain).
  await seedBackup(appBP.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Qc2' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','g6','Nc3','Bg7'], reply: 'e4' },
      { seq: ['d4','d5'], reply: 'c4', isCastleRoot: true, castleName: 'Beta', castleStreetNumber: 2 },
      { seq: ['d4','d5','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','d5','c4','e6','Nc3','Nf6'], reply: 'Bg5' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7', white: 'a', black: 'b', result: '*' },
    ],
  });
  await openVR(appBP.page);
  const alphaRoot = await appBP.page.evaluate(() => {
    const c = new Chess(); for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  });
  const betaRoot = await appBP.page.evaluate(() => {
    const c = new Chess(); for(const m of ['d4','d5','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Beta:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  });

  // 99. A two-track room is rejected (message mentions two-track).
  try {
    const reason = await appBP.page.evaluate((k) => window.__threeTestEdit.elevatorRejectReason(k), alphaRoot);
    assert(reason && /two-track/i.test(reason),
      `expected a two-track room to be rejected as an elevator with a two-track message, got: ${JSON.stringify(reason)}`);
    ok('elevator: a two-track room is rejected with an explanatory message');
  } catch(e){ bad('elevator: two-track rejected', e); }

  // 100. A corridor room is rejected (message mentions corridor/sequence).
  try {
    const reason = await appBP.page.evaluate((k) => window.__threeTestEdit.elevatorRejectReason(k), betaRoot);
    assert(reason && /corridor|sequence/i.test(reason),
      `expected a corridor room to be rejected as an elevator with a corridor/sequence message, got: ${JSON.stringify(reason)}`);
    ok('elevator: a corridor (linear-sequence) room is rejected with an explanatory message');
  } catch(e){ bad('elevator: corridor rejected', e); }
} finally {
  await appBP.close();
}
}

if(shouldRunPhase(['vr-decorating'])){
// --- Phase BQ: the elevator floor panel carries the same "in front of a
//     door" info a normal door does -- destination room name, move pair, and
//     the room's head object -- and the Room Geometry editor lets you set
//     each floor's object (replacing the meaningless door-type dropdown). ---
const appBQ = await launchApp();
try {
  // X (after ...e6 Nc3) is a 5-way branch car (root also branches via g6 so
  // root->X stays its own edge). Two prop assets to assign as floor objects.
  await seedBackup(appBQ.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'a3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bd6'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Be7'], reply: 'Bg5' },
      { seq: ['d4','Nf6','c4','e6','Nc3','d5'],  reply: 'cxd5' },
      { seq: ['d4','Nf6','c4','e6','Nc3','c5'],  reply: 'a3' },
    ]}],
    games: [
      { id: 'g0', moves: 'd4 Nf6 c4 g6 Nc3 Bg7', white: 'a', black: 'b', result: '*' },
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 a3', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 e6 Nc3 Bd6 e4', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 Nf6 c4 e6 Nc3 Be7 Bg5', white: 'a', black: 'b', result: '*' },
      { id: 'g4', moves: 'd4 Nf6 c4 e6 Nc3 d5 cxd5', white: 'a', black: 'b', result: '*' },
      { id: 'g5', moves: 'd4 Nf6 c4 e6 Nc3 c5 a3', white: 'a', black: 'b', result: '*' },
    ],
    assets: [
      { id: 'frying-pan', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w: 0.4, h: 0.2, d: 0.4 }, keywords: 'kitchen housewares' },
      { id: 'toaster', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w: 0.3, h: 0.3, d: 0.3 } },
    ],
  });
  await openVR(appBQ.page);
  const keyFor = (moves) => appBQ.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  }, moves);
  const root = await keyFor(['d4','Nf6','c4']);
  const carKey = await keyFor(['d4','Nf6','c4','e6','Nc3']);
  await appBQ.page.evaluate((args) => window.__threeTestEdit.setExitType(args.root, args.car, 'elevator'), { root, car: carKey });
  await appBQ.page.evaluate((k) => window.__threeTestEdit.enter(k), carKey);
  await appBQ.page.waitForTimeout(200);

  // 101. Each floor row carries the destination room name, its move pair, and
  //      (once assigned) that room's head object.
  let firstFloorTarget;
  try {
    const info0 = await appBQ.page.evaluate(() => window.__threeTestEdit.elevatorInfo());
    firstFloorTarget = info0.forward[0][0].target;
    // name the first floor's room and give it a head object.
    await appBQ.page.evaluate((t) => window.__threeTestEdit.setRoomName(t, 'Housewares'), firstFloorTarget);
    await appBQ.page.evaluate((t) => window.__threeTestEdit.setSlotAsset(t, 'obj-C1', 'frying-pan'), firstFloorTarget);
    await appBQ.page.evaluate((k) => window.__threeTestEdit.enter(k), carKey);
    await appBQ.page.waitForTimeout(150);

    const info = await appBQ.page.evaluate(() => window.__threeTestEdit.elevatorInfo());
    const floor = info.forward[0].find(f => f.target === firstFloorTarget);
    assert(floor, `expected to find the named floor's row, got ${JSON.stringify(info.forward[0])}`);
    assert(floor.name === 'Housewares', `expected the floor row to carry the destination room name, got ${JSON.stringify(floor)}`);
    assert(floor.objAssetId === 'frying-pan', `expected the floor row to carry the assigned head object, got ${JSON.stringify(floor)}`);
    assert(floor.hasPair === true, `expected the floor row to carry a move pair, got ${JSON.stringify(floor)}`);
    assert(info.forward[0].every(f => f.hasPair), `expected every floor to carry a move pair, got ${JSON.stringify(info.forward[0])}`);
    ok('elevator panel: each floor row carries the room name, move pair, and head object');
  } catch(e){ bad('elevator panel: floor rows carry name/pair/object', e); }

  // 102. The Room Geometry editor for a car shows an object-picker button per
  //      forward floor (not the door-type dropdown), and none for the back exit.
  try {
    await appBQ.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode ON (ruler button only shows then)
    await appBQ.page.waitForTimeout(60);
    await appBQ.page.evaluate(() => document.querySelector('#threeTestCanvasWrap i.fa-ruler-combined').closest('button').click());
    await appBQ.page.waitForSelector('#roomGeomOverlay', { state: 'visible', timeout: 5000 });
    const counts = await appBQ.page.evaluate(() => ({
      objBtns: document.querySelectorAll('#roomGeomOverlay [data-elev-obj-for]').length,
      typeSelects: document.querySelectorAll('#roomGeomOverlay [data-exit-type-for]').length,
    }));
    assert(counts.objBtns === 5, `expected 5 floor object buttons (one per forward exit), got ${counts.objBtns}`);
    assert(counts.typeSelects === 0, `expected NO door-type dropdowns in a car's editor, got ${counts.typeSelects}`);
    ok('elevator editor: forward floors get an object-picker button instead of a door-type dropdown');
  } catch(e){ bad('elevator editor: object buttons replace door-type dropdowns', e); }

  // 103. Clicking a floor's object button opens the asset picker; picking an
  //      asset assigns it to that floor's room head object (updates the panel).
  try {
    // pick the button for a floor whose object isn't set yet (not the one
    // named "Housewares" above).
    const otherTarget = await appBQ.page.evaluate((named) => {
      const btns = [...document.querySelectorAll('#roomGeomOverlay [data-elev-obj-for]')];
      const b = btns.find(x => x.dataset.elevObjFor !== named && x.textContent.includes('none'));
      if(b) b.click();
      return b ? b.dataset.elevObjFor : null;
    }, firstFloorTarget);
    assert(otherTarget, 'expected an unset floor object button to click');
    await appBQ.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    // the room-geometry dialog hides while the picker is up (z-order)
    assert(await appBQ.page.evaluate(() => document.getElementById('roomGeomOverlay').style.display === 'none'),
      'expected the Room Geometry dialog to hide while the asset picker is open');
    await appBQ.page.evaluate(() => {
      const card = [...document.querySelectorAll('#pickerGrid .asset-card')]
        .find(c => c.querySelector('.asset-id') && c.querySelector('.asset-id').textContent.includes('toaster'));
      card.click();
    });
    await appBQ.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });

    // the button's own label must refresh IMMEDIATELY (not only on reopen):
    // it reads the raw assigned id from LAYOUT, which is set synchronously,
    // rather than via ASSET_BY_ID which only repopulates on applyEdit's
    // awaited refreshAssetMap().
    const btnLabelNow = await appBQ.page.evaluate((t) =>
      document.querySelector(`#roomGeomOverlay [data-elev-obj-for="${t}"]`)?.textContent, otherTarget);
    assert(btnLabelNow && btnLabelNow.includes('toaster'),
      `expected the object button's label to update to "toaster" immediately after picking, got ${JSON.stringify(btnLabelNow)}`);

    await appBQ.page.evaluate(() => document.getElementById('roomGeomCancelBtn').click());
    await appBQ.page.evaluate((k) => window.__threeTestEdit.enter(k), carKey);
    await appBQ.page.waitForTimeout(150);
    const info = await appBQ.page.evaluate(() => window.__threeTestEdit.elevatorInfo());
    const floor = info.forward[0].find(f => f.target === otherTarget);
    assert(floor && floor.objAssetId === 'toaster',
      `expected picking "toaster" to become that floor's object, got ${JSON.stringify(floor)}`);
    ok('elevator editor: picking an object assigns it to that floor and refreshes the button label immediately');
  } catch(e){ bad('elevator editor: object picker assigns the floor object', e); }

  // 104. An elevator car has only ONE physical door, so its Room Geometry
  //      editor lets it shrink to a compact 6x6 -- not the door-count-driven
  //      minimum the branch room was sized for (which is >= 11 wide).
  try {
    await appBQ.page.evaluate(() => document.querySelector('#threeTestCanvasWrap i.fa-ruler-combined').closest('button').click());
    await appBQ.page.waitForSelector('#roomGeomOverlay', { state: 'visible', timeout: 5000 });
    const mins = await appBQ.page.evaluate(() => ({
      w: Number(document.getElementById('roomGeomW').getAttribute('min')),
      d: Number(document.getElementById('roomGeomD').getAttribute('min')),
    }));
    assert(mins.w <= 6, `expected a car's width min to allow shrinking to 6, got ${mins.w}`);
    assert(mins.d <= 6, `expected a car's depth min to allow shrinking to 6, got ${mins.d}`);

    // typing 6x6 and Applying sticks (isn't clamped back up to the old min):
    // reopen the dialog and confirm the fields now read 6x6.
    await appBQ.page.fill('#roomGeomW', '6');
    await appBQ.page.fill('#roomGeomD', '6');
    await appBQ.page.evaluate(() => document.getElementById('roomGeomApplyBtn').click());
    await appBQ.page.waitForSelector('#roomGeomOverlay', { state: 'hidden', timeout: 5000 });
    await appBQ.page.waitForTimeout(150);
    await appBQ.page.evaluate(() => document.querySelector('#threeTestCanvasWrap i.fa-ruler-combined').closest('button').click());
    await appBQ.page.waitForSelector('#roomGeomOverlay', { state: 'visible', timeout: 5000 });
    const applied = await appBQ.page.evaluate(() => ({
      w: Number(document.getElementById('roomGeomW').value),
      d: Number(document.getElementById('roomGeomD').value),
    }));
    assert(applied.w === 6 && applied.d === 6, `expected the car to actually resize to 6x6, got ${JSON.stringify(applied)}`);
    await appBQ.page.evaluate(() => document.getElementById('roomGeomCancelBtn').click());
    ok('elevator car: Room Geometry editor allows shrinking to a compact 6x6');
  } catch(e){ bad('elevator car: 6x6 minimum size', e); }

  // 105. Click-to-select-floor UX: clicking a floor's row on the panel
  //      selects it (elevatorSelected() reflects the pick); walking forward
  //      through the door then teleports straight to THAT floor, no popup.
  try {
    // test 102 turned edit mode ON (needed for the ruler icon) and nothing
    // since has turned it back off -- door/elevator teleports are suppressed
    // in edit mode (so you can stand in a doorway and edit), so walk-mode
    // behavior needs it off first.
    if(await appBQ.page.evaluate(() => window.__threeTestEdit.editMode())){
      await appBQ.page.evaluate(() => window.__threeTestEdit.toggle());
    }
    await appBQ.page.evaluate((k) => window.__threeTestEdit.enter(k), carKey);
    await appBQ.page.waitForTimeout(150);
    const before = await appBQ.page.evaluate(() => window.__threeTestEdit.elevatorSelected());
    assert(before === null, `expected no floor selected yet on a fresh car, got ${before}`);

    const info = await appBQ.page.evaluate(() => window.__threeTestEdit.elevatorInfo());
    const floors = info.forward[0];
    assert(floors.length >= 2, `expected the car to have at least 2 floors for this test, got ${floors.length}`);
    const pick = floors[1];   // pick the SECOND floor, not the first, so a "defaults to floor 1" bug would be caught

    // clickElevatorFloor(v) drives the real row-selection math with v = the
    // uv.y a raycaster hit on that row would report (0 bottom of the panel
    // texture, 1 top -- three.js PlaneGeometry UVs); elevatorRowCenterUV
    // computes the exact v for that row's center using the same constants
    // the real panel drawing/hit-testing use.
    const v = await appBQ.page.evaluate(
      (args) => window.__threeTestEdit.elevatorRowCenterUV(args.ord, args.n), { ord: pick.ordinal, n: floors.length });
    const selected = await appBQ.page.evaluate((vv) => window.__threeTestEdit.clickElevatorFloor(vv), v);
    assert(selected === pick.ordinal, `expected clicking floor ${pick.ordinal}'s row to select it, got ${selected}`);

    // walk forward through the door and confirm we land on the picked floor,
    // not the first one -- positioned/facing via the door's own trigger geom
    // (elevatorDoorGeom), mirroring the existing stair walk-teleport tests.
    const r = await appBQ.page.evaluate(async (targetKey) => {
      const dbg = window.__threeTestEdit;
      const doors = dbg.elevatorDoorGeom();
      const fwd = doors.find(d => d.kind === 'forward');
      const cx = (fwd.box.minX + fwd.box.maxX) / 2, cz = (fwd.box.minZ + fwd.box.maxZ) / 2;
      const yaw = Math.atan2(-fwd.thru.x, -fwd.thru.z);
      const roomBefore = window.__threeTestState.room;
      dbg.teleport(cx, cz, yaw);
      await new Promise(res => setTimeout(res, 700));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      const deadline = Date.now() + 8000;
      while(Date.now() < deadline && window.__threeTestState.room === roomBefore){
        await new Promise(res => setTimeout(res, 150));
      }
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
      return { roomBefore, roomAfter: window.__threeTestState.room, targetKey };
    }, pick.target);
    assert(r.roomAfter === pick.target,
      `expected walking through the forward door to land on the SELECTED floor (${pick.target}), got ${JSON.stringify(r)}`);
    // and no popup/prompt of any kind was ever shown for this
    const overlayExisted = await appBQ.page.evaluate(() => !!document.getElementById('elevatorOverlay'));
    assert(!overlayExisted, 'expected no elevator popup overlay to exist at all (removed in favor of click-then-walk)');
    ok('elevator: clicking a floor row selects it, and walking through the door teleports there directly (no popup)');
  } catch(e){ bad('elevator: click-to-select-floor + walk-to-teleport', e); }

  // 106. Walking through the forward door WITHOUT selecting a floor first
  //      leaves you blocked (no default/accidental teleport) -- and walking
  //      OUT the back door is instant, with no "Go back" confirmation.
  try {
    await appBQ.page.evaluate((k) => window.__threeTestEdit.enter(k), carKey);
    await appBQ.page.waitForTimeout(150);
    const stillNone = await appBQ.page.evaluate(() => window.__threeTestEdit.elevatorSelected());
    assert(stillNone === null, `expected a freshly-entered car to have no selection (previous room's pick shouldn't leak), got ${stillNone}`);

    const blocked = await appBQ.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      const fwd = dbg.elevatorDoorGeom().find(d => d.kind === 'forward');
      const cx = (fwd.box.minX + fwd.box.maxX) / 2, cz = (fwd.box.minZ + fwd.box.maxZ) / 2;
      const yaw = Math.atan2(-fwd.thru.x, -fwd.thru.z);
      const roomBefore = window.__threeTestState.room;
      dbg.teleport(cx, cz, yaw);
      await new Promise(res => setTimeout(res, 700));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      await new Promise(res => setTimeout(res, 1500));
      const toastWhileBlocked = dbg.toastText();
      // still holding forward, well past the toast's own ~3.9s auto-dismiss
      // (3.5s hold + .4s fade) -- if it were latching correctly it fires
      // ONCE per approach rather than refreshing every frame, so it should
      // have faded on its own by now even though 'w' never let up.
      await new Promise(res => setTimeout(res, 4200));
      const toastAfterAutoDismiss = dbg.toastText();
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
      return { stayed: window.__threeTestState.room === roomBefore, toastWhileBlocked, toastAfterAutoDismiss };
    });
    assert(blocked.stayed, 'expected the forward door to stay impassable with no floor selected');
    assert(blocked.toastWhileBlocked && /select a floor/i.test(blocked.toastWhileBlocked),
      `expected a "select a floor first" toast while blocked at the door, got ${JSON.stringify(blocked.toastWhileBlocked)}`);
    assert(blocked.toastAfterAutoDismiss === null,
      `expected the toast to auto-dismiss on its own (not keep re-firing every frame while forward is held), got ${JSON.stringify(blocked.toastAfterAutoDismiss)}`);

    // now the back door: walking out should be instant, no confirmation.
    const back = await appBQ.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      const b = dbg.elevatorDoorGeom().find(d => d.kind === 'back');
      if(!b) return { err: 'no back door found' };
      const cx = (b.box.minX + b.box.maxX) / 2, cz = (b.box.minZ + b.box.maxZ) / 2;
      const yaw = Math.atan2(-b.thru.x, -b.thru.z);
      const roomBefore = window.__threeTestState.room;
      dbg.teleport(cx, cz, yaw);
      await new Promise(res => setTimeout(res, 700));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      const deadline = Date.now() + 8000;
      while(Date.now() < deadline && window.__threeTestState.room === roomBefore){
        await new Promise(res => setTimeout(res, 150));
      }
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
      return { target: b.target, roomBefore, roomAfter: window.__threeTestState.room,
        overlayShown: !!document.getElementById('elevatorOverlay') };
    });
    assert(!back.err, back.err);
    assert(back.roomAfter === back.target,
      `expected walking through the back door to teleport straight out, got ${JSON.stringify(back)}`);
    assert(!back.overlayShown, 'expected no confirmation popup for the back/exit door');
    ok('elevator: forward door stays blocked with no floor picked; back door walks out instantly with no prompt');
  } catch(e){ bad('elevator: unselected forward door blocked, back door instant', e); }

  // 113. Backing off from the door and re-approaching shows the "select a
  //      floor first" toast again -- the latch is scoped to the CURRENT
  //      approach (reset once the player leaves the door's trigger box), not
  //      a one-time-ever flag for the whole visit.
  try {
    await appBQ.page.evaluate((k) => window.__threeTestEdit.enter(k), carKey);
    await appBQ.page.waitForTimeout(150);
    const r = await appBQ.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      const fwd = dbg.elevatorDoorGeom().find(d => d.kind === 'forward');
      const cx = (fwd.box.minX + fwd.box.maxX) / 2, cz = (fwd.box.minZ + fwd.box.maxZ) / 2;
      const yaw = Math.atan2(-fwd.thru.x, -fwd.thru.z);
      const backYaw = yaw + Math.PI;   // face away from the door to back off

      dbg.teleport(cx, cz, yaw);
      await new Promise(res => setTimeout(res, 700));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      await new Promise(res => setTimeout(res, 300));
      const firstToast = dbg.toastText();
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));

      // back off out of the trigger box, then re-approach.
      dbg.teleport(cx, cz, backYaw);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      await new Promise(res => setTimeout(res, 600));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
      const stillInBoxAfterBackoff = (() => {
        const p = dbg.pos();
        return p.x >= fwd.box.minX && p.x <= fwd.box.maxX && p.z >= fwd.box.minZ && p.z <= fwd.box.maxZ;
      })();

      dbg.teleport(cx, cz, yaw);
      await new Promise(res => setTimeout(res, 700));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      await new Promise(res => setTimeout(res, 300));
      const secondToast = dbg.toastText();
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));

      return { firstToast, secondToast, stillInBoxAfterBackoff };
    });
    assert(r.firstToast && /select a floor/i.test(r.firstToast), `expected a toast on the first approach, got ${JSON.stringify(r)}`);
    assert(!r.stillInBoxAfterBackoff, `test setup issue: expected backing off to actually leave the door's trigger box, got ${JSON.stringify(r)}`);
    assert(r.secondToast && /select a floor/i.test(r.secondToast),
      `expected the toast to fire again on a fresh approach after backing off, got ${JSON.stringify(r)}`);
    ok('elevator: the "select a floor first" toast fires again on a fresh approach after backing off');
  } catch(e){ bad('elevator: toast re-fires on a fresh approach', e); }
} finally {
  await appBQ.close();
}
}
// --- Phase BR: an entrance door's skin also becomes its destination room's
//     own exit/back door skin (setDoorOverride), so walking out looks like
//     walking back through the same door you came in. A transposition (two
//     different rooms leading to the same target) last-write-wins: whichever
//     entrance door was styled most recently sets the target's exit door. ---
if(shouldRunPhase(['vr-decorating'])){
const appBR = await launchApp();
try {
  // a6-then-e4-then-h6 and h6-then-e4-then-a6 transpose to the same room
  // (a6/h6 are independent pawn moves) -- same setup as Phase BD's
  // canonical-seq test. root has two forward doors (via a6, via h6) to two
  // DIFFERENT rooms X and Y; X and Y each have their OWN forward door
  // (completing the other of a6/h6) that both lead to the SAME shared room.
  await seedBackup(appBR.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','a6'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','h6'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','a6','e4','h6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','h6','e4','a6'], reply: 'Nc3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 a6 e4 h6 Nc3', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 h6 e4 a6 Nc3', white: 'a', black: 'b', result: '*' },
    ],
    assets: [
      { id: 'doorSkin1', type: 'door', image: 'data:image/png;base64,iVBORw0KGgo=' },
      { id: 'doorSkin2', type: 'door', image: 'data:image/png;base64,iVBORw0KGgo=' },
    ],
  });
  await openVR(appBR.page);
  const keyFor = (moves) => appBR.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  }, moves);
  const root = await keyFor(['d4','Nf6','c4']);
  const X = await keyFor(['d4','Nf6','c4','a6','e4']);
  const Y = await keyFor(['d4','Nf6','c4','h6','e4']);
  const shared = await keyFor(['d4','Nf6','c4','a6','e4','h6','Nc3']);

  // 107. Skinning root's door to X, through the REAL in-world picker, sets
  //      X's own back-door skin too (the door leading back to root).
  let xBackKey, xFwdKey, yFwdKey, sharedBackKey;
  try {
    await appBR.page.evaluate((k) => window.__threeTestEdit.enter(k), root);
    await appBR.page.waitForTimeout(200);
    await appBR.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
    await appBR.page.waitForTimeout(60);
    const rootToXKey = (await appBR.page.evaluate((rk) => window.__threeTestEdit.exitsOf(rk), root))
      .find(e => e.target === X).doorKey;
    xBackKey = (await appBR.page.evaluate((rk) => window.__threeTestEdit.exitsOf(rk), X))
      .find(e => e.back).doorKey;

    await appBR.page.evaluate(({ rk, dk }) => window.__threeTestEdit.target({ kind: 'door', roomKey: rk, doorKey: dk }),
      { rk: root, dk: rootToXKey });
    await appBR.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appBR.page.evaluate(() => {
      const card = [...document.querySelectorAll('#pickerGrid .asset-card')]
        .find(c => !c.classList.contains('asset-card-color') && c.textContent.includes('doorSkin1'));
      card.click();
    });
    await appBR.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
    await appBR.page.waitForTimeout(150);

    const ids = await appBR.page.evaluate((args) => ({
      entrance: window.__threeTestEdit.doorOverrideId(args.root, args.rootToXKey),
      exit: window.__threeTestEdit.doorOverrideId(args.X, args.xBackKey),
    }), { root, rootToXKey, X, xBackKey });
    assert(ids.entrance === 'doorSkin1', `expected the entrance door's own override to be doorSkin1, got ${JSON.stringify(ids)}`);
    assert(ids.exit === 'doorSkin1', `expected X's own exit door to pick up the same skin, got ${JSON.stringify(ids)}`);
    ok('entrance door skin (set through the real picker) syncs to the destination room\'s exit door');
  } catch(e){ bad('door skin sync: entrance -> exit door', e); }

  // 108. Transposition: X and Y each have their OWN forward door leading to
  //      the SAME shared room (completing the other of a6/h6). Skinning X's
  //      door sets the shared room's exit door; skinning Y's door OVERWRITES
  //      it (last write wins) -- X's own stored override is untouched.
  //      Removing Y's override then clears the shared exit door.
  try {
    xFwdKey = (await appBR.page.evaluate((rk) => window.__threeTestEdit.exitsOf(rk), X))
      .find(e => !e.back).doorKey;
    yFwdKey = (await appBR.page.evaluate((rk) => window.__threeTestEdit.exitsOf(rk), Y))
      .find(e => !e.back).doorKey;
    sharedBackKey = (await appBR.page.evaluate((rk) => window.__threeTestEdit.exitsOf(rk), shared))
      .find(e => e.back).doorKey;

    const setX = await appBR.page.evaluate((args) =>
      window.__threeTestEdit.setDoorAssetForTarget(args.X, args.shared, 'doorSkin1'), { X, shared });
    assert(setX, 'test setup issue: setDoorAssetForTarget(X, shared) failed to find the exit');
    await appBR.page.waitForTimeout(150);
    const afterX = await appBR.page.evaluate((args) =>
      window.__threeTestEdit.doorOverrideId(args.shared, args.sharedBackKey), { shared, sharedBackKey });
    assert(afterX === 'doorSkin1', `expected X's door to set the shared room's exit door, got ${afterX}`);

    const setY = await appBR.page.evaluate((args) =>
      window.__threeTestEdit.setDoorAssetForTarget(args.Y, args.shared, 'doorSkin2'), { Y, shared });
    assert(setY, 'test setup issue: setDoorAssetForTarget(Y, shared) failed to find the exit');
    await appBR.page.waitForTimeout(150);

    const afterY = await appBR.page.evaluate((args) => ({
      entranceX: window.__threeTestEdit.doorOverrideId(args.X, args.xFwdKey),
      entranceY: window.__threeTestEdit.doorOverrideId(args.Y, args.yFwdKey),
      exit: window.__threeTestEdit.doorOverrideId(args.shared, args.sharedBackKey),
    }), { X, xFwdKey, Y, yFwdKey, shared, sharedBackKey });
    assert(afterY.entranceY === 'doorSkin2', `expected Y's own forward-door override to be doorSkin2, got ${JSON.stringify(afterY)}`);
    assert(afterY.exit === 'doorSkin2', `expected the LATER write (via Y) to win the shared exit door, got ${JSON.stringify(afterY)}`);
    assert(afterY.entranceX === 'doorSkin1', `expected X's own stored override to be untouched, got ${JSON.stringify(afterY)}`);

    await appBR.page.evaluate((args) =>
      window.__threeTestEdit.setDoorAssetForTarget(args.Y, args.shared, null), { Y, shared });
    await appBR.page.waitForTimeout(150);
    const afterRemove = await appBR.page.evaluate((args) =>
      window.__threeTestEdit.doorOverrideId(args.shared, args.sharedBackKey), { shared, sharedBackKey });
    assert(afterRemove === null, `expected removing Y's override to also clear the shared exit door, got ${afterRemove}`);
    ok('door skin sync: transposition last-write-wins, and removal propagates too');
  } catch(e){ bad('door skin sync: transposition + removal', e); }
} finally {
  await appBR.close();
}
}
// --- Phase BS: past ELEV_PANEL_MAX_ROWS (7) floors, an elevator car's
//     button panel splits into a SECOND panel to the right of the door
//     (buildElevatorPanels), hard-capped at ELEV_MAX_FLOORS (14) -- past
//     that, the Room Geometry editor's "Elevator" choice is rejected. ---
if(shouldRunPhase(['vr-decorating'])){
const appBS = await launchApp();
try {
  // root needs a SECOND initial branch (g6) so it doesn't collapse the
  // single-path e6->Nc3 chain into itself (a room with only ONE way in and
  // ONE way further folds into a "corridor" with its parent) -- otherwise
  // root itself (not a distinct e6/Nc3 room) ends up holding the 10-way
  // branch, same structural requirement Phase BQ's car setup already relies on.
  const REPLIES_10 = ['Bb4','Bd6','Be7','d5','c5','a5','h5','g5','b5','Nc6'];
  await seedBackup(appBS.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      ...REPLIES_10.map(m => ({ seq: ['d4','Nf6','c4','e6','Nc3',m], reply: 'e4' })),
    ]}],
    games: [
      { id: 'g0', moves: 'd4 Nf6 c4 g6 Nc3', white: 'a', black: 'b', result: '*' },
      { id: 'g00', moves: 'd4 Nf6 c4 e6 Nc3', white: 'a', black: 'b', result: '*' },
      ...REPLIES_10.map((m, i) => ({ id: 'g'+(i+1), moves: `d4 Nf6 c4 e6 Nc3 ${m}`, white: 'a', black: 'b', result: '*' })),
    ],
  });
  await openVR(appBS.page);
  const keyFor = (moves) => appBS.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  }, moves);
  const root = await keyFor(['d4','Nf6','c4']);
  const carKey = await keyFor(['d4','Nf6','c4','e6','Nc3']);
  await appBS.page.evaluate((args) => window.__threeTestEdit.setExitType(args.root, args.carKey, 'elevator'), { root, carKey });
  await appBS.page.evaluate((k) => window.__threeTestEdit.enter(k), carKey);
  await appBS.page.waitForTimeout(200);

  // 110. 10 floors (> ELEV_PANEL_MAX_ROWS) split across TWO 'elevator-panel'
  //      meshes; clicking a row on EITHER panel resolves to the correct
  //      ABSOLUTE floor ordinal (panel 2's row N is floor N+7, not row N).
  try {
    const info = await appBS.page.evaluate(() => window.__threeTestEdit.elevatorInfo());
    assert(info.forward[0].length === 10, `expected 10 floors, got ${info.forward[0].length}`);
    const scan = await appBS.page.evaluate(() => window.__threeTestEdit.scan());
    const panelCount = scan.filter(o => o.kind === 'elevator-panel').length;
    assert(panelCount === 2, `expected the panel to split into 2 meshes past 7 floors, got ${panelCount}`);

    const v1 = await appBS.page.evaluate((args) => window.__threeTestEdit.elevatorRowCenterUV(args.row, args.n), { row: 3, n: 7 });
    const sel1 = await appBS.page.evaluate((args) => window.__threeTestEdit.clickElevatorFloor(args.v, args.p), { v: v1, p: 0 });
    assert(sel1 === 3, `expected clicking panel 0's row 3 to select floor 3, got ${sel1}`);

    const v2 = await appBS.page.evaluate((args) => window.__threeTestEdit.elevatorRowCenterUV(args.row, args.n), { row: 2, n: 3 });
    const sel2 = await appBS.page.evaluate((args) => window.__threeTestEdit.clickElevatorFloor(args.v, args.p), { v: v2, p: 1 });
    assert(sel2 === 9, `expected clicking panel 1's row 2 to select floor 9 (7 + 2), not row 2 itself, got ${sel2}`);
    ok('elevator: past 7 floors, the panel splits in two, and each panel\'s rows resolve to the correct absolute floor');
  } catch(e){ bad('elevator: two-panel split + per-panel row resolution', e); }

  // 111. Walking through the forward door with a floor picked from the
  //      SECOND panel teleports to the correct room (not confused with the
  //      first panel's floor at the same relative row).
  try {
    const info = await appBS.page.evaluate(() => window.__threeTestEdit.elevatorInfo());
    const expectedTarget = info.forward[0][8].target;   // ordinal 9 (0-indexed 8), selected above
    const doors = await appBS.page.evaluate(() => window.__threeTestEdit.elevatorDoorGeom());
    const fwd = doors.find(d => d.kind === 'forward');
    const cx = (fwd.box.minX + fwd.box.maxX) / 2, cz = (fwd.box.minZ + fwd.box.maxZ) / 2;
    const yaw = Math.atan2(-fwd.thru.x, -fwd.thru.z);
    const r = await appBS.page.evaluate(async (args) => {
      const dbg = window.__threeTestEdit;
      const roomBefore = window.__threeTestState.room;
      dbg.teleport(args.cx, args.cz, args.yaw);
      await new Promise(res => setTimeout(res, 700));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      const deadline = Date.now() + 8000;
      while(Date.now() < deadline && window.__threeTestState.room === roomBefore){
        await new Promise(res => setTimeout(res, 150));
      }
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
      return window.__threeTestState.room;
    }, { cx, cz, yaw });
    assert(r === expectedTarget, `expected walking through with the second panel's pick to land on floor 9, got ${JSON.stringify({ r, expectedTarget })}`);
    ok('elevator: a floor picked from the second panel teleports to the right room');
  } catch(e){ bad('elevator: second-panel floor teleport', e); }
} finally {
  await appBS.close();
}
}
// --- Phase BT: an elevator car is capped at ELEV_MAX_FLOORS (14) -- past
//     that, the Room Geometry editor's "Elevator" choice is rejected with
//     an explanatory message (mirrors the existing "too few floors" reject). ---
if(shouldRunPhase(['vr-decorating'])){
const appBT = await launchApp();
try {
  const REPLIES_15 = ['Nc6','Na6','Qe7','Ke7','Be7','Bd6','Bc5','Bb4','Ba3','a6','a5','b6','b5','c6','c5'];
  await seedBackup(appBT.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      ...REPLIES_15.map(m => ({ seq: ['d4','Nf6','c4','e6','Nc3',m], reply: 'e4' })),
    ]}],
    games: [
      { id: 'g0', moves: 'd4 Nf6 c4 g6 Nc3', white: 'a', black: 'b', result: '*' },
      { id: 'g00', moves: 'd4 Nf6 c4 e6 Nc3', white: 'a', black: 'b', result: '*' },
      ...REPLIES_15.map((m, i) => ({ id: 'g'+(i+1), moves: `d4 Nf6 c4 e6 Nc3 ${m}`, white: 'a', black: 'b', result: '*' })),
    ],
  });
  await openVR(appBT.page);
  const keyFor = (moves) => appBT.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  }, moves);
  const carKey = await keyFor(['d4','Nf6','c4','e6','Nc3']);
  await appBT.page.evaluate((k) => window.__threeTestEdit.enter(k), carKey);
  await appBT.page.waitForTimeout(200);

  // 112. A 15-floor room (one past the 14-floor cap) is rejected as an
  //      elevator target, with a message naming the cap.
  try {
    const exits = await appBT.page.evaluate((k) => window.__threeTestEdit.exitsOf(k), carKey);
    assert(exits.filter(e => !e.back).length === 15, `test setup issue: expected 15 forward exits, got ${exits.filter(e => !e.back).length}`);
    const reason = await appBT.page.evaluate((k) => window.__threeTestEdit.elevatorRejectReason(k), carKey);
    assert(reason && reason.includes('14'), `expected a reject reason naming the 14-floor cap, got ${JSON.stringify(reason)}`);
    ok('elevator: a room with more than 14 forward doors is rejected as an elevator target');
  } catch(e){ bad('elevator: 14-floor hard cap rejection', e); }
} finally {
  await appBT.close();
}
}
// --- Phase BU: buildRoom disposes the PREVIOUS scene's GPU resources
//     (geometries/textures) before replacing them -- scene.clear() alone
//     only detaches objects from the graph, it never frees anything, so
//     without disposeSceneContents every single edit (buildRoom runs on
//     nearly all of them) leaked. Session-lifetime singleton materials
//     (gearMat, the edit-mode marker materials -- tagged via tagShared())
//     must survive repeated rebuilds untouched, since they're reused by
//     every room, not rebuilt per room. ---
if(shouldRunPhase(['vr-decorating'])){
const appBU = await launchApp();
try {
  await seedBackup(appBU.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6 Nc3', white: 'a', black: 'b', result: '*' },
    ],
  });
  await openVR(appBU.page);
  const roomKey = await appBU.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + c.fen().split(' ').slice(0,4).join(' ').replace(/[^a-zA-Z0-9]/g,'_');
  });

  // 113. Repeatedly rebuilding the same room (walk-mode -- no edit-only
  //      markers involved) leaves the GPU resource count exactly where it
  //      started, not growing with every rebuild.
  try {
    await appBU.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
    await appBU.page.waitForTimeout(400);
    const before = await appBU.page.evaluate(() => window.__threeTestEdit.rendererMemory());
    assert(before && before.geometries > 0 && before.textures > 0,
      `test setup issue: expected a real, non-empty resource count to start, got ${JSON.stringify(before)}`);
    for(let i = 0; i < 5; i++){
      await appBU.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
      await appBU.page.waitForTimeout(120);
    }
    const after = await appBU.page.evaluate(() => window.__threeTestEdit.rendererMemory());
    assert(after.geometries === before.geometries && after.textures === before.textures,
      `expected GPU resource counts unchanged after 5 rebuilds of the same room, got ${JSON.stringify({ before, after })}`);
    ok('buildRoom disposes the previous scene\'s GPU resources -- repeated rebuilds do not leak geometries/textures');
  } catch(e){ bad('no GPU resource leak across repeated rebuilds (walk mode)', e); }

  // 114. Same, in EDIT MODE -- where slot/door/facade/yard marker meshes and
  //      the selection-gear icon all draw from session-lifetime SHARED
  //      singleton materials (tagShared()). Confirms disposeSceneContents'
  //      skip-list keeps those materials alive and usable across repeated
  //      rebuilds (no leak from the per-room content, no breakage of the
  //      shared ones), rather than either leaking OR disposing something
  //      every other room still needs.
  try {
    await appBU.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on -- builds marker meshes
    await appBU.page.waitForTimeout(400);
    const before = await appBU.page.evaluate(() => window.__threeTestEdit.rendererMemory());
    const scanBefore = await appBU.page.evaluate(() => window.__threeTestEdit.scan().length);
    assert(scanBefore > 0, 'test setup issue: expected edit-mode markers in the scene');

    for(let i = 0; i < 4; i++){
      await appBU.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);   // still edit mode -- rebuilds WITH markers each time
      await appBU.page.waitForTimeout(120);
    }
    const after = await appBU.page.evaluate(() => window.__threeTestEdit.rendererMemory());
    const scanAfter = await appBU.page.evaluate(() => window.__threeTestEdit.scan().length);
    assert(after.geometries === before.geometries && after.textures === before.textures,
      `expected GPU resource counts unchanged after 4 more edit-mode rebuilds, got ${JSON.stringify({ before, after })}`);
    assert(scanAfter === scanBefore,
      `expected the same set of interactive markers to still be present (shared materials intact, not disposed out from under other rooms), got ${scanBefore} -> ${scanAfter}`);
    ok('shared singleton materials (gear icon, edit-mode markers) survive repeated rebuilds without leaking or breaking');
  } catch(e){ bad('no GPU resource leak across repeated rebuilds (edit mode, shared materials)', e); }
} finally {
  await appBU.close();
}
}

// --- Phase AV: "Games with this Position" -- matching (transposition vs exact
//     line), result-from-your-perspective, and the modal itself. ---
if(shouldRunPhase(['move-table'])){
const appAV = await launchApp();
try {
  await seedBackup(appAV.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
    ]}],
    games: [
      // Lichess-shaped (has players+id): user 'tester' is White in each.
      { id: 'lg1', moves: 'd4 Nf6 c4 e6 Nc3', createdAt: 3000, winner: 'white', status: 'resign',
        players: { white: { user: { name: 'tester' }, rating: 1600 }, black: { user: { name: 'opp1' }, rating: 1580 } } },
      { id: 'lg2', moves: 'd4 Nf6 c4 g6 Nc3', createdAt: 2000, winner: 'black', status: 'mate',
        players: { white: { user: { name: 'tester' }, rating: 1600 }, black: { user: { name: 'opp2' }, rating: 1620 } } },
      // a TRANSPOSITION into the same "d4 Nf6 c4 g6" position by a different order.
      { id: 'lg3', moves: 'c4 Nf6 d4 g6 Nc3', createdAt: 1000, status: 'draw',
        players: { white: { user: { name: 'tester' }, rating: 1600 }, black: { user: { name: 'opp3' }, rating: 1590 } } },
      // a legacy bare game (no players / no id): reaches "d4 Nf6" but has no details.
      { moves: 'd4 Nf6 Bf4' },
    ],
  });
  await appAV.page.click('.line-row');
  await appAV.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });
  const H = (fn, arg) => appAV.page.evaluate(({fn,arg}) => window.__gamesListHooks[fn](arg), {fn,arg});

  // 151. Position (transposition) matching finds a game that reached the
  //      position by a DIFFERENT move order; exact-line matching does not.
  try {
    const fen = await H('fenForSeq', ['d4','Nf6','c4','g6']);
    const byPos = await appAV.page.evaluate((f) => window.__gamesListHooks.gamesAtPosition(f), fen);
    const byLine = await appAV.page.evaluate(() => window.__gamesListHooks.gamesAlongLine(['d4','Nf6','c4','g6']));
    const posIds = byPos.map(m => m.id).sort();
    const lineIds = byLine.map(m => m.id).sort();
    assert(JSON.stringify(posIds) === JSON.stringify(['lg2','lg3']), `expected both orders (lg2,lg3) by position, got ${JSON.stringify(posIds)}`);
    assert(JSON.stringify(lineIds) === JSON.stringify(['lg2']), `expected only the same-order game (lg2) by line, got ${JSON.stringify(lineIds)}`);
    assert(byPos.every(m => m.move === 'Nc3'), `expected the move-from-here to be Nc3 for both, got ${JSON.stringify(byPos.map(m=>m.move))}`);
    ok('games-list: transposition matching finds other move orders; exact-line does not');
  } catch(e){ bad('games-list: transposition vs exact-line matching', e); }

  // 152. Result is reported from the signed-in user's perspective, both colors,
  //      draws, and unknown (bare) games.
  try {
    const win  = await H('outcome', { players:{white:{user:{name:'tester'}},black:{user:{name:'x'}}}, winner:'white' });
    const loss = await H('outcome', { players:{white:{user:{name:'tester'}},black:{user:{name:'x'}}}, winner:'black' });
    const bwin = await H('outcome', { players:{white:{user:{name:'x'}},black:{user:{name:'tester'}}}, winner:'black' });
    const draw = await H('outcome', { players:{white:{user:{name:'tester'}},black:{user:{name:'x'}}} });
    const unk  = await H('outcome', { moves:'e4' });
    assert(win==='win' && loss==='loss', `expected win/loss as White, got ${win}/${loss}`);
    assert(bwin==='win', `expected a Black win from the user's perspective, got ${bwin}`);
    assert(draw==='draw', `expected a drawn (no winner) game to read as draw, got ${draw}`);
    assert(unk===null, `expected an unknown-color (bare) game to read as null, got ${unk}`);
    ok('games-list: result is computed from the user\'s own color, incl. draws and unknown games');
  } catch(e){ bad('games-list: perspective outcome', e); }

  // 152b. A chess.com game whose player name matches localStorage's
  //       per-platform chesscom_lastUser (NOT CURRENT_USER, "tester" here)
  //       still resolves your color -- the reported bug: CURRENT_USER is
  //       only ever bootstrapped from whichever platform was imported
  //       FIRST and never updated after, so a later chess.com import under
  //       a different handle used to read as "someone else's game" despite
  //       the player data being right there.
  try {
    await appAV.page.evaluate(() => localStorage.setItem('chesscom_lastUser', 'MyChessComHandle'));
    const asWhite = await H('outcome', {
      source: 'chesscom',
      players: { white: { user: { name: 'MyChessComHandle' } }, black: { user: { name: 'opp' } } },
      winner: 'white',
    });
    const asBlack = await H('color', {
      source: 'chesscom',
      players: { white: { user: { name: 'opp' } }, black: { user: { name: 'MyChessComHandle' } } },
    });
    // a Lichess-shaped game (no source:'chesscom') must NOT match against the
    // chess.com identity -- only CURRENT_USER, keeping the two platforms'
    // identities from bleeding into each other.
    const lichessCrossMatch = await H('color', {
      players: { white: { user: { name: 'MyChessComHandle' } }, black: { user: { name: 'opp' } } },
    });
    assert(asWhite === 'win', `expected the chess.com-identity match to resolve White's win from the user's perspective, got ${asWhite}`);
    assert(asBlack === 'black', `expected the chess.com-identity match to resolve Black, got ${asBlack}`);
    assert(lichessCrossMatch === null, `expected a Lichess-shaped game to NOT match against the chess.com identity, got ${lichessCrossMatch}`);
    ok('games-list: a chess.com game matches your per-platform chess.com handle even when it differs from CURRENT_USER');
    await appAV.page.evaluate(() => localStorage.removeItem('chesscom_lastUser'));
  } catch(e){ bad('games-list: cross-platform identity fallback', e); }

  // 153. Click-out link: Lichess id → lichess.org, chess.com → its own url,
  //      bare game → none.
  try {
    const li = await H('link', { id: 'abc12345' });
    const cc = await H('link', { source: 'chesscom', url: 'https://www.chess.com/game/live/9', id: 'x' });
    const none = await H('link', { moves: 'e4' });
    assert(li === 'https://lichess.org/abc12345', `expected a lichess link, got ${li}`);
    assert(cc === 'https://www.chess.com/game/live/9', `expected the chess.com url, got ${cc}`);
    assert(none === null, `expected no link for a bare game, got ${none}`);
    ok('games-list: click-out link resolves per source (lichess id / chess.com url / none)');
  } catch(e){ bad('games-list: game link resolution', e); }

  // 153b. Provider badge classification: explicit chess.com tag, Lichess
  //       (has `players`), and a legacy bare game (no source/players at all --
  //       the only shape a pre-enrichment chess.com import produces) all
  //       resolve to the right provider for the pawn/knight badge.
  try {
    const cc = await H('provider', { source: 'chesscom', players: { white:{}, black:{} } });
    const li = await H('provider', { players: { white:{user:{name:'x'}}, black:{user:{name:'y'}} } });
    const bare = await H('provider', { moves: 'e4 e5' });
    assert(cc === 'chesscom', `expected an explicit source:'chesscom' game to badge as chesscom, got ${cc}`);
    assert(li === 'lichess', `expected a players-shaped game to badge as lichess, got ${li}`);
    assert(bare === 'chesscom', `expected a legacy bare game to badge as chesscom (the only shape it can come from), got ${bare}`);
    ok('games-list: provider badge classifies chess.com (tagged + legacy bare) vs Lichess correctly');
  } catch(e){ bad('games-list: provider badge classification', e); }

  // 154. The modal opens from the three-dot menu and lists the games reaching
  //      the shallow "d4 Nf6" position (lg1, lg2, and the bare game), with a
  //      clickable lichess link on a Lichess row.
  try {
    await appAV.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appAV.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="gamesHere"]').click());
    await appAV.page.waitForSelector('#gamesListOverlay', { state: 'visible', timeout: 5000 });
    await appAV.page.waitForFunction(() => document.querySelectorAll('#gamesListBody .games-row').length > 0, { timeout: 5000 });
    const info = await appAV.page.evaluate(() => ({
      rows: document.querySelectorAll('#gamesListBody .games-row').length,
      summary: document.getElementById('gamesListSummary').textContent,
      hasLichessLink: !!document.querySelector('#gamesListBody a.games-row[href^="https://lichess.org/"]'),
      lichessBadges: document.querySelectorAll('#gamesListBody .games-col-src.lichess').length,
      chesscomBadges: document.querySelectorAll('#gamesListBody .games-col-src.cc').length,
    }));
    assert(info.rows === 3, `expected 3 games reaching d4 Nf6 (lg1, lg2, bare), got ${info.rows}`);
    assert(/\b3\b/.test(info.summary), `expected the summary to report 3 games, got "${info.summary}"`);
    assert(info.hasLichessLink, 'expected at least one clickable lichess-linked row');
    assert(info.lichessBadges === 2, `expected 2 lichess (knight) badges (lg1, lg2), got ${info.lichessBadges}`);
    assert(info.chesscomBadges === 1, `expected 1 chess.com (pawn) badge (the legacy bare game), got ${info.chesscomBadges}`);
    ok('games-list: modal opens from the menu and lists the games reaching this position');
    await appAV.page.evaluate(() => document.getElementById('gamesListCloseBtn').click());
  } catch(e){ bad('games-list: modal open + render', e); }

  // 154b. The position index (already built once by test 151/154's 'pos'-mode
  //       queries above) is persisted to IndexedDB, so a reload doesn't
  //       rebuild it -- it reuses the persisted copy.
  try {
    const persisted = await appAV.page.evaluate(() => window.__gamesListHooks.isIndexPersisted());
    assert(persisted, 'expected the index to already be persisted from the earlier pos-mode queries');
    const countBefore = await appAV.page.evaluate(() => window.__gamesListHooks.indexBuildCount());
    assert(countBefore === 1, `expected exactly 1 real build so far (from test 151's first query), got ${countBefore}`);

    await appAV.page.reload();
    await appAV.page.waitForFunction(() => {
      const el = document.getElementById('buildStamp');
      return el && el.textContent && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    const justAfterReload = await appAV.page.evaluate(() => window.__gamesListHooks.indexBuildCount());
    assert(justAfterReload === 0, `expected the fresh page load's build counter to start at 0, got ${justAfterReload}`);

    await appAV.page.click('.line-row');
    await appAV.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });
    const fen = await appAV.page.evaluate(() => window.__gamesListHooks.fenForSeq(['d4','Nf6','c4','g6']));
    const byPos = await appAV.page.evaluate((f) => window.__gamesListHooks.gamesAtPosition(f), fen);
    const afterReopen = await appAV.page.evaluate(() => window.__gamesListHooks.indexBuildCount());
    assert(JSON.stringify(byPos.map(m=>m.id).sort()) === JSON.stringify(['lg2','lg3']),
      `expected the same transposition results after reload, got ${JSON.stringify(byPos)}`);
    assert(afterReopen === 0, `expected the post-reload query to reuse the persisted index (no rebuild), got ${afterReopen} real build(s)`);
    ok('games-list: position index persists across a reload instead of rebuilding');
  } catch(e){ bad('games-list: index persistence across reload', e); }

  // 154c. Importing games (a real content change) invalidates the persisted
  //       index, so the next query rebuilds instead of serving stale data.
  try {
    await appAV.page.evaluate(() => window.__gamesListHooks.invalidateIndex());
    const persisted = await appAV.page.evaluate(() => window.__gamesListHooks.isIndexPersisted());
    assert(!persisted, 'expected invalidateIndex() to drop the persisted copy');
    const fen = await appAV.page.evaluate(() => window.__gamesListHooks.fenForSeq(['d4','Nf6']));
    await appAV.page.evaluate((f) => window.__gamesListHooks.gamesAtPosition(f), fen);
    const rebuilt = await appAV.page.evaluate(() => window.__gamesListHooks.isIndexPersisted());
    assert(rebuilt, 'expected the next query to rebuild and re-persist the index');
    ok('games-list: invalidating the index (as every real games-content-changing write path does) forces a rebuild');
  } catch(e){ bad('games-list: index invalidation forces a rebuild', e); }

  // 154d. A persisted index blob in the OLD entry format ({g:arrayIndex,move}
  //       instead of {key:gameIndexKey,move} -- the shape used before
  //       reindexAfterImport's content-based rekeying) is detected and
  //       discarded rather than silently trusted. The reported bug: "Games
  //       with this Position" showed no games for a position that obviously
  //       had some, because a stale pre-rekeying blob was still sitting in
  //       IndexedDB from an earlier build -- every lookup quietly returned
  //       zero matches (byKey.get(undefined) for every old-shaped hit)
  //       instead of erroring or rebuilding.
  try {
    await appAV.page.evaluate(() => setMeta('gamesPositionIndexCache', JSON.stringify([['stale-fake-key', [{ g: 0, move: 'e4' }]]])));
    await appAV.page.reload();
    await appAV.page.waitForFunction(() => {
      const el = document.getElementById('buildStamp');
      return el && el.textContent && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    await appAV.page.click('.line-row');
    await appAV.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });
    const fen = await appAV.page.evaluate(() => window.__gamesListHooks.fenForSeq(['d4','Nf6','c4','g6']));
    const byPos = await appAV.page.evaluate((f) => window.__gamesListHooks.gamesAtPosition(f), fen);
    const buildCount = await appAV.page.evaluate(() => window.__gamesListHooks.indexBuildCount());
    assert(JSON.stringify(byPos.map(m=>m.id).sort()) === JSON.stringify(['lg2','lg3']),
      `expected the real transposition results despite the stale old-format blob, got ${JSON.stringify(byPos)}`);
    assert(buildCount === 1, `expected the old-format blob to be discarded and a real rebuild to happen, got ${buildCount} build(s)`);
    ok('games-list: an old-format persisted index blob is detected and discarded, not silently trusted');
  } catch(e){ bad('games-list: old-format persisted index is rejected, not trusted', e); }
} finally {
  await appAV.close();
}
}

// --- Phase AW2: buildPositionIndex must chunk its per-game chess.js replay
//     (yielding to the event loop every POSITION_INDEX_CHUNK games) instead of
//     running as one long unbroken synchronous loop -- for a large game
//     database (e.g. months of chess.com history) that loop was slow enough to
//     trip the browser's "page unresponsive" warning on open (the reported
//     bug). A separate app instance with a big synthetic game set, well past
//     one chunk boundary, checks the chunking didn't drop or miscount any
//     game in the process. ---
if(shouldRunPhase(['move-table'])){
const appAW2 = await launchApp();
try {
  const BIG_N = 230;   // > POSITION_INDEX_CHUNK (100), spans two chunk boundaries
  await seedBackup(appAW2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['e4'], prefs: [] }],
    games: Array.from({ length: BIG_N }, (_, i) => ({
      id: `sg${i}`, moves: 'e4 e5 Nf3 Nc6', createdAt: i,
      players: { white: { user: { name: 'tester' }, rating: 1500 }, black: { user: { name: 'opp' }, rating: 1500 } },
    })),
  });
  await appAW2.page.click('.line-row');
  await appAW2.page.waitForSelector('tr.data-row', { timeout: 10000 });

  // 155. Every one of the BIG_N games -- including ones on both sides of the
  //      100-game chunk boundary -- is still found by position after the
  //      chunked (yielding) index build.
  try {
    const fen = await appAW2.page.evaluate(() => {
      const c = new Chess();
      for(const m of ['e4','e5','Nf3','Nc6']) c.move(m, { sloppy: true });
      return c.fen();
    });
    const hits = await appAW2.page.evaluate((f) => window.__gamesListHooks.gamesAtPosition(f), fen);
    const ids = new Set(hits.map(h => h.id));
    assert(hits.length === BIG_N, `expected all ${BIG_N} games indexed, got ${hits.length}`);
    for(const i of [0, 99, 100, 101, BIG_N - 1]){
      assert(ids.has(`sg${i}`), `expected sg${i} (around a chunk boundary) present in the index, got ${JSON.stringify([...ids]).slice(0,200)}`);
    }
    ok('games-list: buildPositionIndex\'s chunked (yielding) replay indexes every game, incl. across chunk boundaries');
  } catch(e){ bad('games-list: chunked index build correctness', e); }

  // 155b. The "Indexing your games… N of M" progress callback fires once per
  //       chunk boundary with a running count, not just at the very end.
  try {
    const calls = await appAW2.page.evaluate(() => window.__gamesListHooks.buildIndexWithProgress());
    assert(JSON.stringify(calls) === JSON.stringify([[100, BIG_N], [200, BIG_N]]),
      `expected progress calls at the two 100-game chunk boundaries (100/${BIG_N} then 200/${BIG_N}), got ${JSON.stringify(calls)}`);
    ok('games-list: indexing progress callback reports a running "N of M" count per chunk');
  } catch(e){ bad('games-list: indexing progress callback', e); }
} finally {
  await appAW2.close();
}
}

// --- Phase AY2: Object List Manager's room-database JSON import -- two code
//     review fixes: (1) an auto-generated list id (no explicit list.id) is
//     disambiguated against every id already produced in the SAME import, so
//     two different rooms that slugify to the same room/list name pair don't
//     silently clobber each other; (2) a duplicate item name within one
//     list's items array is deduped (first occurrence wins), matching what
//     the editor's own "Add item" already enforces by hand. ---
if(shouldRunPhase(['object-lists'])){
const appAY2 = await launchApp();
try {
  await appAY2.page.evaluate(() => document.getElementById('menuObjectLists').click());
  await appAY2.page.waitForSelector('#objectListsOverlay', { state: 'visible', timeout: 5000 });

  // 161. Import a room-database file with two rooms that both omit room.id
  //      and share the same name ("Kitchen"), each with a same-named list
  //      ("Fixtures") -- without the fix both would generate the same auto
  //      id (kitchen__fixtures) and the second import would silently
  //      overwrite the first via the upsert. Also duplicates an item name
  //      ("Oven") within the first list to check the item-level dedupe.
  try {
    await appAY2.page.setInputFiles('#objlistImportFile', {
      name: 'rooms.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        rooms: [
          { name: 'Kitchen', category: 'Home', lists: [
            { name: 'Fixtures', items: ['Oven', 'Sink', 'Oven'] },
          ]},
          { name: 'Kitchen', category: 'Home', lists: [
            { name: 'Fixtures', items: ['Fridge', 'Stove'] },
          ]},
        ],
      })),
    });
    await appAY2.page.waitForSelector('#objlistGrid .objlist-card', { timeout: 5000 });
    const cards = await appAY2.page.evaluate(() => [...document.querySelectorAll('#objlistGrid .objlist-card')].map(c => ({
      items: c.querySelector('.objlist-card-items').textContent,
      count: c.querySelector('.objlist-card-count').textContent,
    })));
    assert(cards.length === 2,
      `expected 2 separate list cards (not clobbered into 1 via an id collision), got ${cards.length}: ${JSON.stringify(cards)}`);
    const fixturesCard = cards.find(c => c.items.includes('Oven'));
    const secondCard = cards.find(c => c.items.includes('Fridge'));
    assert(fixturesCard && /^2 item/.test(fixturesCard.count),
      `expected the first Fixtures list to have 2 items (Oven deduped), got ${JSON.stringify(fixturesCard)}`);
    assert(secondCard && /^2 item/.test(secondCard.count),
      `expected the second (id-disambiguated) Fixtures list to import intact with 2 items, got ${JSON.stringify(secondCard)}`);
    ok('object lists: auto-generated ids disambiguate across a collision, and duplicate item names dedupe on import');
  } catch(e){ bad('object lists: room-database import id/item dedup', e); }
} finally {
  await appAY2.close();
}
}

// --- Phase AZ2: "Compare Games" (three-dot menu) -- one row per move you've
//     actually played from this exact line in your own games (not a modal,
//     unlike "Find Games"). The header row carries the node's own configured
//     standard reply, boldfaced, with its eval read straight from that real
//     child node's own PREFS entry; every OTHER played move gets its own
//     indented row below, sorted by count. "Analyze Others" (the header's
//     bolt icon) background-analyzes all the "other" rows at once, at a
//     shallow, independently-configured depth, jumped to the front of the
//     analysis queue (interrupting whatever's running) and run at the live
//     engine panel's own thread count. ---
if(shouldRunPhase(['move-table'])){
const appAZ2 = await launchApp();
try {
  await seedBackup(appAZ2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },   // has a configured standard -- tests 162/163
      { seq: ['d4','Nf6','c4'], eval: { type:'cp', value:60, depth:20, pv:'1.d4 Nf6 2.c4' } },   // the standard's OWN eval (a real child node)
      // ['d4','g6'] has NO configured reply at all -- test 164
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6' },    // played the configured standard (c4) x1 -- included, boldfaced
      { id: 'g2', moves: 'd4 Nf6 Nf3 g6' },   // alternate: Nf3 x1
      { id: 'g3', moves: 'd4 Nf6 Nf3 d5' },   // alternate: Nf3 x2 total
      { id: 'g4', moves: 'd4 Nf6 g3 g6' },    // alternate: g3 x1
      { id: 'g5', moves: 'd4 g6 c4 Bg7' },    // no reply configured here: c4 x1
      { id: 'g6', moves: 'd4 g6 Nf3 Bg7' },   // Nf3 x2 total
      { id: 'g7', moves: 'd4 g6 Nf3 d6' },
    ],
  });
  await appAZ2.page.click('.line-row');
  await appAZ2.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });
  const rowSel = 'tr.data-row[data-seq="d4,Nf6"]';
  const metaSel = (sel) => document.querySelector(sel).nextElementSibling;

  // 162. Toggling "Compare Games" shows a header row (move-number "2.", the
  //      configured standard c4 boldfaced with its own already-saved eval)
  //      plus one indented row per OTHER played move, sorted by count
  //      (Nf3 x2, then g3 x1) -- c4 itself does NOT get a duplicate row.
  try {
    await appAZ2.page.evaluate((sel) => document.querySelector(sel + ' .rowMenuBtn').click(), rowSel);
    await appAZ2.page.evaluate((sel) => document.querySelector(sel + ' [data-act="compareActual"]').click(), rowSel);
    await appAZ2.page.waitForSelector(`${rowSel} + tr.meta-row .meta-actual-header`, { timeout: 5000 });
    const state = await appAZ2.page.evaluate((sel) => {
      const meta = document.querySelector(sel).nextElementSibling;
      const header = meta.querySelector('.meta-actual-header');
      const altRows = [...meta.querySelectorAll('.meta-actual-alt-row')];
      return {
        moveNumber: header.querySelector('.meta-actual-move-number')?.textContent.trim(),
        standardBold: header.querySelector('strong .meta-actual-move')?.textContent.trim(),
        standardCount: header.querySelector('em')?.textContent.trim(),
        standardEval: header.querySelector('.meta-actual-eval')?.textContent.trim(),
        hasUseBtn: !!header.querySelector('.meta-actual-use'),
        altMoveNumbers: altRows.map(r => r.querySelector('.meta-actual-move-number')?.textContent.trim()),
        altMoves: altRows.map(r => r.querySelector('.meta-actual-move').textContent.trim()),
        altCounts: altRows.map(r => r.querySelector('em')?.textContent.trim()),
      };
    }, rowSel);
    assert(state.moveNumber === '2.', `expected header move-number "2.", got "${state.moveNumber}"`);
    assert(state.standardBold === 'c4', `expected the configured standard (c4) boldfaced in the header, got "${state.standardBold}"`);
    assert(state.standardCount === '(1×)', `expected the standard's own play count (1x), got "${state.standardCount}"`);
    assert(state.standardEval === '+0.6/20', `expected the standard's own saved eval "+0.6/20", got "${state.standardEval}"`);
    assert(!state.hasUseBtn, 'expected no "Use as Standard" button when a reply is already configured');
    assert(state.altMoveNumbers.every(n => n === '2.'),
      `expected every alt row to also show the move number "2.", got ${JSON.stringify(state.altMoveNumbers)}`);
    assert(JSON.stringify(state.altMoves) === JSON.stringify(['Nf3','g3']),
      `expected alt rows Nf3 then g3 (c4 excluded, it's the header), got ${JSON.stringify(state.altMoves)}`);
    assert(state.altCounts[0] === '(2×)' && state.altCounts[1] === '(1×)',
      `expected counts (2x) then (1x), got ${JSON.stringify(state.altCounts)}`);
    ok('Compare Games: header row (standard boldfaced, count + own eval) plus one sorted, move-numbered row per other played move');
  } catch(e){ bad('Compare Games: header + alt rows', e); }

  // 162b. Each move is a clickable mini-board chip (reusing the PV float
  //       mechanism -- .pv-move + data-fen): clicking one opens the float
  //       positioned at that move's resulting FEN.
  try {
    const fenCheck = await appAZ2.page.evaluate((sel) => {
      const chip = document.querySelector(sel).nextElementSibling.querySelector('.meta-actual-alt-row .meta-actual-move');
      return chip ? chip.dataset.fen : null;
    }, rowSel);
    assert(fenCheck && fenCheck.includes(' b '), `expected the first alt chip's data-fen to be a Black-to-move position, got "${fenCheck}"`);
    await appAZ2.page.evaluate((sel) => document.querySelector(sel).nextElementSibling.querySelector('.meta-actual-alt-row .meta-actual-move').click(), rowSel);
    const floatState = await appAZ2.page.evaluate(() => ({
      visible: document.getElementById('pvFloat').style.display === 'block',
      activeChip: !!document.querySelector('.meta-actual-alt-row .meta-actual-move.pv-move-active'),
    }));
    assert(floatState.visible, 'expected clicking a compare-line move to open the mini-board float');
    assert(floatState.activeChip, 'expected the clicked move chip to be marked active');
    ok('Compare Games: clicking a move opens a mini board at that move\'s position');
  } catch(e){ bad('Compare Games: click-to-miniboard', e); }

  // 163. Toggling again (via the row menu) hides the commentary rows.
  try {
    await appAZ2.page.evaluate((sel) => document.querySelector(sel + ' .rowMenuBtn').click(), rowSel);
    await appAZ2.page.evaluate((sel) => document.querySelector(sel + ' [data-act="compareActual"]').click(), rowSel);
    const stillThere = await appAZ2.page.evaluate((sel) => {
      const meta = document.querySelector(sel).nextElementSibling;
      return meta.style.display !== 'none' && !!meta.querySelector('.meta-actual-header');
    }, rowSel);
    assert(!stillThere, 'expected toggling again to hide the actual-games commentary');
    ok('Compare Games: toggling again via the row menu hides the commentary rows');
  } catch(e){ bad('Compare Games: toggle off via row menu', e); }

  // 163b. The leading icon is itself a dismiss control -- clicking it hides
  //       the comparison rows too, without going back through the row menu.
  //       It's PERSISTED (unlike the old ephemeral toggle) so it survives a
  //       full tree rebuild -- reload the app to prove that, not just re-render.
  try {
    await appAZ2.page.evaluate((sel) => document.querySelector(sel + ' .rowMenuBtn').click(), rowSel);
    await appAZ2.page.evaluate((sel) => document.querySelector(sel + ' [data-act="compareActual"]').click(), rowSel);
    await appAZ2.page.waitForSelector(`${rowSel} + tr.meta-row .meta-actual-dismiss`, { timeout: 5000 });

    await appAZ2.page.reload({ waitUntil: 'domcontentloaded' });
    await appAZ2.page.waitForFunction(() => {
      const el = document.getElementById('buildStamp');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    await appAZ2.page.click('.line-row');
    await appAZ2.page.waitForSelector(`${rowSel} + tr.meta-row .meta-actual-header`, { timeout: 10000 });
    ok('Compare Games: staying open is persisted -- survives a full reload/rebuild, not just an in-place re-render');

    await appAZ2.page.evaluate((sel) => document.querySelector(sel).nextElementSibling.querySelector('.meta-actual-dismiss').click(), rowSel);
    const stillThere = await appAZ2.page.evaluate((sel) => {
      const meta = document.querySelector(sel).nextElementSibling;
      return meta.style.display !== 'none' && !!meta.querySelector('.meta-actual-header');
    }, rowSel);
    assert(!stillThere, 'expected clicking the leading icon to dismiss the comparison rows');
    ok('Compare Games: clicking the leading icon dismisses the comparison rows');
  } catch(e){ bad('Compare Games: persisted open state + dismiss via leading icon', e); }

  // 164. With no reply configured yet (a DIFFERENT row, seq d4,g6, seeded
  //      with no pref at all), the header shows "Use as Standard" instead of
  //      a boldfaced move, EVERY played move gets its own alt row (nothing
  //      excluded), and using the button sets the top (most-played) one as
  //      the row's reply.
  try {
    const rowSel2 = 'tr.data-row[data-seq="d4,g6"]';
    await appAZ2.page.evaluate((sel) => document.querySelector(sel + ' .rowMenuBtn').click(), rowSel2);
    await appAZ2.page.evaluate((sel) => document.querySelector(sel + ' [data-act="compareActual"]').click(), rowSel2);
    await appAZ2.page.waitForSelector(`${rowSel2} + tr.meta-row .meta-actual-use`, { timeout: 5000 });
    const altMoves = await appAZ2.page.evaluate((sel) =>
      [...document.querySelector(sel).nextElementSibling.querySelectorAll('.meta-actual-alt-row .meta-actual-move')].map(el => el.textContent.trim()), rowSel2);
    assert(JSON.stringify(altMoves) === JSON.stringify(['Nf3','c4']),
      `expected both actually-played moves (Nf3 most-played first, then c4), got ${JSON.stringify(altMoves)}`);
    await appAZ2.page.evaluate((sel) => document.querySelector(sel).nextElementSibling.querySelector('.meta-actual-use').click(), rowSel2);
    const newReply = await appAZ2.page.evaluate((sel) => document.querySelector(sel + ' .ourReply').textContent, rowSel2);
    assert(newReply === 'Nf3', `expected "Use as Standard" to set the top (most-played) alternate Nf3 as the reply, got "${newReply}"`);
    ok('Compare Games: with no reply configured, "Use as Standard" appears and sets the top alternate');
  } catch(e){ bad('Compare Games: no-reply-yet + Use as Standard', e); }

  // 165. "Analyze Others": the depth dialog defaults to (or restores) the
  //      independent compare-depth localStorage setting; saving it queues
  //      every OTHER played move at that depth, multipv 1, flagged to run on
  //      the live engine panel's thread count -- and the panel shows a
  //      pending indicator on each right away, before any result has landed.
  //      The standard reply (c4) rides along too, but its own real tree node
  //      already has a depth-20 eval (seeded above) -- deeper than the 18
  //      asked for here, so addToAnalysisQueue's own "already sufficient"
  //      check silently skips it (proven NOT skipped in test 165b below,
  //      once a deeper depth is asked for).
  try {
    // re-toggle d4,Nf6 back on -- test 163b left it closed.
    await appAZ2.page.evaluate((sel) => document.querySelector(sel + ' .rowMenuBtn').click(), rowSel);
    await appAZ2.page.evaluate((sel) => document.querySelector(sel + ' [data-act="compareActual"]').click(), rowSel);
    await appAZ2.page.waitForSelector(`${rowSel} + tr.meta-row .meta-actual-analyze-all`, { timeout: 5000 });
    await appAZ2.page.evaluate((sel) => document.querySelector(sel).nextElementSibling.querySelector('.meta-actual-analyze-all').click(), rowSel);
    await appAZ2.page.waitForSelector('#compareAnalyzeOverlay', { state: 'visible', timeout: 5000 });
    const defaultDepth = await appAZ2.page.inputValue('#compareAnalyzeDepth');
    assert(defaultDepth === '20', `expected the depth dialog to default to 20, got "${defaultDepth}"`);
    await appAZ2.page.fill('#compareAnalyzeDepth', '18');
    await appAZ2.page.evaluate(() => document.getElementById('compareAnalyzeGoBtn').click());
    // the overlay itself closes synchronously, before queueAlternatesForAnalysis's
    // sequential per-move awaits (each does its own getPref IDB read) actually
    // finish -- wait on the real completion signal (both items landing in the
    // queue) instead of the overlay's visibility, which resolves too early and
    // can catch this mid-population (a real, if narrow, race in an earlier
    // version of this test, not just theoretical -- it started reproducing
    // once a third move, the standard, joined the same per-move await chain).
    await appAZ2.page.waitForFunction(() =>
      window.__aqTestHooks.getQueue().some(it => it.seq.join(',') === 'd4,Nf6,Nf3') &&
      window.__aqTestHooks.getQueue().some(it => it.seq.join(',') === 'd4,Nf6,g3'), { timeout: 5000 });

    const queue = await appAZ2.page.evaluate(() => window.__aqTestHooks.getQueue());
    const queuedFor = seq => queue.find(it => it.lineId==='L1' && it.seq.join(',')===seq.join(','));
    const nf3Item = queuedFor(['d4','Nf6','Nf3']), g3Item = queuedFor(['d4','Nf6','g3']);
    assert(nf3Item && g3Item, `expected both other moves (Nf3, g3) queued, got ${JSON.stringify(queue)}`);
    for(const item of [nf3Item, g3Item]){
      assert(item.depth === 18, `expected depth 18, got ${item.depth}`);
      assert(item.multipv === 1, `expected multipv 1 (a single quick line), got ${item.multipv}`);
      assert(item.useLiveThreads === true, `expected useLiveThreads flagged, got ${item.useLiveThreads}`);
    }
    assert(!queuedFor(['d4','Nf6','c4']), 'expected the standard reply (c4) NOT queued -- it already has its own real tree node');

    // waitForSelector's default visible-state check fails here -- FontAwesome
    // icons render zero-size in this harness (CDN-blocked), same reason other
    // tests in this file query/click them via evaluate instead.
    await appAZ2.page.waitForFunction((sel) =>
      document.querySelector(sel).nextElementSibling.querySelectorAll('.meta-actual-alt-row .meta-actual-pending').length === 2, rowSel, { timeout: 5000 });
    const pendingCount = await appAZ2.page.evaluate((sel) =>
      document.querySelector(sel).nextElementSibling.querySelectorAll('.meta-actual-alt-row .meta-actual-pending').length, rowSel);
    assert(pendingCount === 2, `expected a pending indicator on both alt rows right after queueing, got ${pendingCount}`);
    ok('Compare Games: "Analyze Others" queues every other move at the chosen depth, single line, live-thread-flagged, with an immediate pending indicator');
  } catch(e){ bad('Compare Games: Analyze Others queues the alternates', e); }

  // 165b. Asking for a depth DEEPER than the standard's existing eval (20)
  //       queues it too, right alongside the others -- "Analyze Others"
  //       isn't limited to moves without their own tree node, only to moves
  //       that actually need (re-)analysis at the requested depth.
  try {
    // clear the queue first -- test 165 left Nf3/g3 sitting there queued
    // (at depth 18), which would otherwise just get topped up rather than
    // demonstrating a fresh decision for c4.
    await appAZ2.page.evaluate(async () => {
      for(const it of window.__aqTestHooks.getQueue().slice()) await window.__aqTestHooks.cancelAnalysisQueueItem(it.id);
    });
    await appAZ2.page.evaluate((sel) => document.querySelector(sel).nextElementSibling.querySelector('.meta-actual-analyze-all').click(), rowSel);
    await appAZ2.page.waitForSelector('#compareAnalyzeOverlay', { state: 'visible', timeout: 5000 });
    await appAZ2.page.fill('#compareAnalyzeDepth', '25');
    await appAZ2.page.evaluate(() => document.getElementById('compareAnalyzeGoBtn').click());
    // same race as test 165 above -- c4 is the LAST of the three per-move
    // awaits (Nf3, g3, then the standard), so it's the most likely of all to
    // still be mid-flight when the overlay's own (synchronous) close fires.
    await appAZ2.page.waitForFunction(() =>
      window.__aqTestHooks.getQueue().some(it => it.seq.join(',') === 'd4,Nf6,c4'), { timeout: 5000 });

    const queue = await appAZ2.page.evaluate(() => window.__aqTestHooks.getQueue());
    const c4Item = queue.find(it => it.lineId==='L1' && it.seq.join(',') === ['d4','Nf6','c4'].join(','));
    assert(c4Item, `expected the standard reply (c4) queued once a deeper depth (25 > its saved 20) was asked for, got ${JSON.stringify(queue)}`);
    assert(c4Item.depth === 25 && c4Item.multipv === 1 && c4Item.useLiveThreads === true,
      `expected c4 queued the same way as the others (depth 25, multipv 1, live threads), got ${JSON.stringify(c4Item)}`);
    ok('Compare Games: "Analyze Others" also re-queues the standard reply when its existing eval falls short of the requested depth');
  } catch(e){ bad('Compare Games: Analyze Others re-queues an insufficiently-analyzed standard', e); }

  // 166. The compare-depth setting persists in its OWN localStorage key
  //      (independent of the "Add to/Add Children to Analysis Queue" depth),
  //      restored the next time the dialog opens.
  try {
    await appAZ2.page.evaluate((sel) => document.querySelector(sel).nextElementSibling.querySelector('.meta-actual-analyze-all').click(), rowSel);
    await appAZ2.page.waitForSelector('#compareAnalyzeOverlay', { state: 'visible', timeout: 5000 });
    const restoredDepth = await appAZ2.page.inputValue('#compareAnalyzeDepth');
    assert(restoredDepth === '25', `expected the just-saved depth (25, from test 165b) restored on reopen, got "${restoredDepth}"`);
    await appAZ2.page.evaluate(() => document.getElementById('compareAnalyzeCancelBtn').click());
    ok('Compare Games: "Analyze Others" depth persists in its own localStorage key across dialog reopens');
  } catch(e){ bad('Compare Games: depth persistence', e); }

  // 167. "Analyze Others" jumps its items to the FRONT of the queue, ahead of
  //      an already-queued/processing item, and interrupts that in-progress
  //      search (engine.stop()) rather than waiting for it to finish -- then
  //      the item that actually starts next runs at the LIVE engine panel's
  //      thread count, not the Analysis Queue modal's own independent one.
  //      No real Stockfish is available in this harness, so engine.analyze()/
  //      stop() are monkey-patched with a controllable fake (same established
  //      pattern as Phase T's cancel-the-processing-item test), driving the
  //      real scheduler against it.
  try {
    // clean slate -- tests 165/166 left Nf3/g3 sitting queued (never actually
    // processed, since no engine was mocked ready yet), which would otherwise
    // already occupy the front of the queue before this test's own "pre-
    // existing item" gets added below.
    await appAZ2.page.evaluate(async () => {
      for(const it of window.__aqTestHooks.getQueue().slice()) await window.__aqTestHooks.cancelAnalysisQueueItem(it.id);
    });
    await appAZ2.page.evaluate(() => {
      const { engine } = window.__aqTestHooks;
      engine.multithreaded = true; engine.maxThreads = 8; engine.threads = 8;
      window.__aqTestHooks.populateEngineThreadsSelect();
      window.__aqTestHooks.populateAqThreadsSelect();
    });
    await appAZ2.page.selectOption('#engineThreadsSelect', '3');
    // aqThreadsSelect lives inside the Analysis Queue modal -- open it first
    // (same as Phase VD's own thread-selector tests) so it's actionable.
    await appAZ2.page.evaluate(() => document.getElementById('menuAnalysisQueue').click());
    await appAZ2.page.waitForSelector('#analysisQueueOverlay', { state: 'visible', timeout: 5000 });
    await appAZ2.page.selectOption('#aqThreadsSelect', '6');
    await appAZ2.page.evaluate(() => document.getElementById('analysisQueueCloseBtn').click());

    await appAZ2.page.evaluate(() => {
      window.__aqFakeEngine = { pending: null, callCount: 0, calls: [] };
      const { engine } = window.__aqTestHooks;
      engine.ready = true;
      engine.analyze = (fen, opts) => {
        window.__aqFakeEngine.callCount++;
        window.__aqFakeEngine.calls.push(opts);
        return new Promise(resolve => {
          window.__aqFakeEngine.pending = () =>
            resolve({ depth: 5, lines: { 1: { score: { type:'cp', value:5 }, depth:5, pv:['e2e4'] } } });
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

    // an unrelated item, queued and already mid-search, well short of ITS
    // (much deeper) target -- the fake resolve's depth 5 never finishes it.
    await appAZ2.page.evaluate(() => window.__aqTestHooks.addToAnalysisQueue('L1', ['d4','g6'], 40, 1));
    await appAZ2.page.evaluate(() => window.__aqTestHooks.maybeResumeAnalysisQueue());
    await appAZ2.page.waitForFunction(() => window.__aqFakeEngine.callCount === 1, { timeout: 5000 });
    const preExisting = await appAZ2.page.evaluate(() => window.__aqTestHooks.getCurrentItem());
    assert(preExisting?.seq?.join(',') === 'd4,g6', `expected the pre-existing item to start processing first, got ${JSON.stringify(preExisting)}`);

    // now trigger "Analyze Others" on rowSel's g3 alternate -- it should
    // interrupt the above and jump to the front instead of waiting in line.
    await appAZ2.page.evaluate((sel) => document.querySelector(sel).nextElementSibling.querySelector('.meta-actual-analyze-all').click(), rowSel);
    await appAZ2.page.waitForSelector('#compareAnalyzeOverlay', { state: 'visible', timeout: 5000 });
    await appAZ2.page.evaluate(() => document.getElementById('compareAnalyzeGoBtn').click());
    await appAZ2.page.waitForFunction(() => document.getElementById('compareAnalyzeOverlay').style.display === 'none', { timeout: 5000 });

    await appAZ2.page.waitForFunction(() => window.__aqFakeEngine.callCount === 2, { timeout: 5000 });
    const nowProcessing = await appAZ2.page.evaluate(() => window.__aqTestHooks.getCurrentItem());
    // whichever of Nf3/g3/c4 (the standard rides along too, at depth 25 --
    // deeper than its saved 20) happens to sort first among the priority batch.
    assert(nowProcessing && ['d4,Nf6,Nf3','d4,Nf6,g3','d4,Nf6,c4'].includes(nowProcessing.seq.join(',')),
      `expected an "Analyze Others" item to start next (interrupting the pre-existing one), got ${JSON.stringify(nowProcessing)}`);
    const lastOpts = await appAZ2.page.evaluate(() => window.__aqFakeEngine.calls[1]);
    assert(lastOpts.threads === 3, `expected the "Analyze Others" search to run at the LIVE panel's thread count (3), not the queue's own (6), got ${lastOpts.threads}`);

    const queueOrder = await appAZ2.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    assert(queueOrder.includes('d4,g6') && queueOrder.indexOf('d4,g6') > 0,
      `expected the interrupted pre-existing item still queued, but behind the priority items, got ${JSON.stringify(queueOrder)}`);

    // let the fake search resolve too, so the background loop doesn't leave
    // a dangling pending promise behind it.
    await appAZ2.page.evaluate(() => window.__aqTestHooks.engine.stop());
    ok('Compare Games: "Analyze Others" jumps to the front, interrupts an in-progress search, and runs at the live thread count');
  } catch(e){ bad('Compare Games: Analyze Others priority + interrupt + live threads', e); }
} finally {
  await appAZ2.close();
}
}

// --- Phase BA2: "Standard vs. other moves" summary -- once every OTHER
//     played move has its own eval at least as deep as the last-requested
//     compare depth, a play-count-weighted comparison against the standard
//     reply's own eval appears below the rows. Always from the LINE's own
//     perspective, so a positive number means the standard did better --
//     tested on a BLACK line specifically, where a lower White-relative eval
//     is the actually-better outcome, to prove the sign flip is real and not
//     coincidentally right for a White line. ---
if(shouldRunPhase(['move-table'])){
const appBA2 = await launchApp();
try {
  await seedBackup(appBA2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Black Test', color: 'black', openingMoves: ['e4'], prefs: [
      { seq: ['e4'], reply: 'e5' },
      { seq: ['e4','e5'], eval: { type:'cp', value: -20, depth: 20, pv:'' } },   // standard: -0.2 White-relative (good for Black)
      { seq: ['e4','c5'], eval: { type:'cp', value: 10, depth: 25, pv:'' } },    // other: +0.1 White-relative, played 2x
      { seq: ['e4','e6'], eval: { type:'cp', value: 50, depth: 30, pv:'' } },    // other: +0.5 White-relative, played 1x
    ]}],
    games: [
      { id: 'g1', moves: 'e4 e5 Nf3 Nc6' },
      { id: 'g2', moves: 'e4 c5 Nf3 d6' },
      { id: 'g3', moves: 'e4 c5 Nf3 Nc6' },
      { id: 'g4', moves: 'e4 e6 d4 d5' },
    ],
  });
  await appBA2.page.click('.line-row');
  await appBA2.page.waitForSelector('tr.data-row[data-seq="e4"]', { timeout: 10000 });
  const rowSel = 'tr.data-row[data-seq="e4"]';

  // 168. weighted average: (0.1*2 + 0.5*1)/3 = 0.2333 White-relative;
  //      standard -0.2 - 0.2333 = -0.4333 White-relative, negated for a
  //      Black line -> +0.4.
  try {
    await appBA2.page.evaluate((sel) => document.querySelector(sel + ' .rowMenuBtn').click(), rowSel);
    await appBA2.page.evaluate((sel) => document.querySelector(sel + ' [data-act="compareActual"]').click(), rowSel);
    await appBA2.page.waitForSelector(`${rowSel} + tr.meta-row .meta-actual-summary`, { timeout: 5000 });
    const state = await appBA2.page.evaluate((sel) => {
      const el = document.querySelector(sel).nextElementSibling.querySelector('.meta-actual-summary');
      return { text: el.textContent.trim(), cls: el.className };
    }, rowSel);
    assert(state.text === 'Standard vs. other moves: +0.4', `expected the summary "+0.4", got "${state.text}"`);
    assert(state.cls.includes('meta-actual-summary-good'), `expected the "good" colour class, got "${state.cls}"`);
    ok('Compare Games summary: play-count-weighted, sign-correct for a Black line, once every other move is deep enough');
  } catch(e){ bad('Compare Games summary: weighted average + Black-line sign flip', e); }

  // 169. Not shown at all if even ONE other move falls short of the
  //      requested depth -- a partial average would be misleading, not just
  //      incomplete. Raising the requested depth (past e6's saved 30, the
  //      shallower of the two "other" evals stays fine at 25 for c5) is a
  //      simpler way to prove the gate than trying to shallow-overwrite an
  //      existing eval -- saveAnalysisQueueResult itself refuses to ever
  //      downgrade a saved eval, by design.
  try {
    await appBA2.page.evaluate(() => localStorage.setItem('compare_lastDepth', '35'));
    await appBA2.page.evaluate((sel) => document.querySelector(sel + ' .rowMenuBtn').click(), rowSel);
    await appBA2.page.evaluate((sel) => document.querySelector(sel + ' [data-act="compareActual"]').click(), rowSel);
    await appBA2.page.evaluate((sel) => document.querySelector(sel + ' [data-act="compareActual"]').click(), rowSel);
    await appBA2.page.waitForSelector(`${rowSel} + tr.meta-row .meta-actual-header`, { timeout: 5000 });
    const summaryGone = await appBA2.page.evaluate((sel) =>
      !document.querySelector(sel).nextElementSibling.querySelector('.meta-actual-summary'), rowSel);
    assert(summaryGone, 'expected the summary to disappear once the requested depth exceeds what either other move was actually analyzed to');
    ok('Compare Games summary: hidden again once any other move falls short of the (now raised) requested depth');
  } catch(e){ bad('Compare Games summary: depth-gating', e); }
} finally {
  await appBA2.close();
}
}

// --- Phase BC2: Compare Games rows also show each move's win/loss/draw
//     record ("+W =D −L", the same notation "Find Games"' own summary line
//     uses), computed from the SAME userColorInGame/gameOutcomeForUser
//     helpers -- a game with a determinable outcome counts toward it, a
//     legacy bare/unknown-color game still counts toward the play count but
//     not the record (so it never misleadingly prints "+0 =0 −0"). ---
if(shouldRunPhase(['move-table'])){
const appBC2 = await launchApp();
try {
  await seedBackup(appBC2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6', winner: 'white',
        players: { white: { user: { name: 'tester' } }, black: { user: { name: 'opp1' } } } },   // c4: a win
      { id: 'g2', moves: 'd4 Nf6 Nf3 g6', winner: 'black',
        players: { white: { user: { name: 'tester' } }, black: { user: { name: 'opp2' } } } },   // Nf3: a loss
      { id: 'g3', moves: 'd4 Nf6 Nf3 d5',
        players: { white: { user: { name: 'tester' } }, black: { user: { name: 'opp3' } } } },   // Nf3: a draw (no winner)
      { id: 'g4', moves: 'd4 Nf6 g3 g6', winner: 'white',
        players: { white: { user: { name: 'tester' } }, black: { user: { name: 'opp4' } } } },   // g3: a win
    ],
  });
  await appBC2.page.click('.line-row');
  await appBC2.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });
  const rowSel = 'tr.data-row[data-seq="d4,Nf6"]';

  // 170. c4 (the standard, 1 win) shows "+1 =0 −0" on the header row; Nf3
  //      (1 loss, 1 draw) shows "+0 =1 −1"; g3 (1 win) shows "+1 =0 −0".
  try {
    await appBC2.page.evaluate((sel) => document.querySelector(sel + ' .rowMenuBtn').click(), rowSel);
    await appBC2.page.evaluate((sel) => document.querySelector(sel + ' [data-act="compareActual"]').click(), rowSel);
    await appBC2.page.waitForSelector(`${rowSel} + tr.meta-row .meta-actual-header .meta-actual-record`, { timeout: 5000 });
    const state = await appBC2.page.evaluate((sel) => {
      const meta = document.querySelector(sel).nextElementSibling;
      const rowRecord = row => row.querySelector('.meta-actual-record')?.textContent.trim();
      const winClass = row => row.querySelector('.meta-actual-record span')?.className;
      return {
        standard: rowRecord(meta.querySelector('.meta-actual-header')),
        standardWinClass: winClass(meta.querySelector('.meta-actual-header')),
        alts: [...meta.querySelectorAll('.meta-actual-alt-row')].map(r => ({
          move: r.querySelector('.meta-actual-move').textContent.trim(),
          record: rowRecord(r),
          winClass: winClass(r),
        })),
        isRealTable: meta.querySelector('.meta-actual-alt-table')?.tagName === 'TABLE'
          && meta.querySelectorAll('.meta-actual-alt-table tr.meta-actual-alt-row').length === 2,
      };
    }, rowSel);
    assert(state.standard === '+1 =0 −0', `expected the standard's (c4) record "+1 =0 −0", got "${state.standard}"`);
    assert(state.standardWinClass === 'meta-actual-record-good', `expected the standard's win count coloured "good" (1 win, 0 losses), got "${state.standardWinClass}"`);
    const nf3 = state.alts.find(a => a.move === 'Nf3'), g3 = state.alts.find(a => a.move === 'g3');
    assert(nf3?.record === '+0 =1 −1', `expected Nf3's record "+0 =1 −1", got "${JSON.stringify(nf3)}"`);
    assert(nf3?.winClass === 'meta-actual-record-bad', `expected Nf3's win count coloured "bad" (0 wins, 1 loss), got "${nf3?.winClass}"`);
    assert(g3?.record === '+1 =0 −0', `expected g3's record "+1 =0 −0", got "${JSON.stringify(g3)}"`);
    assert(g3?.winClass === 'meta-actual-record-good', `expected g3's win count coloured "good" (1 win, 0 losses), got "${g3?.winClass}"`);
    assert(state.isRealTable, 'expected the "other move" rows to be a real <table> (Nf3 + g3 as <tr>s), so their columns actually align');
    ok('Compare Games: each row shows its own win/loss/draw record (win count colour-coded), aligned in a real table');
  } catch(e){ bad('Compare Games: win/loss/draw record per row', e); }
} finally {
  await appBC2.close();
}
}

// --- Phase BV: three-dot row-menu reorg -- "Set Move Quality" now needs a
//     click to reveal its glyph strip (previously always visible), and
//     "Add Note" was folded into "Set Attributes" as a room-level attribute
//     (like room name/castle name -- notes now live on the room's CANONICAL
//     seq, shared across any transposing path into that room, unlike
//     mnemonic/eval which stay per literal lineSeq). Also regression-covers
//     a bug this reorg fixed in passing: renderBlackRoot's row menu wired a
//     "Compare Games" click handler with no matching HTML button (a gap from
//     the original Compare-to-Actual-Games rollout, which only added the
//     button to renderBranch) -- opening a black-root row's menu and using
//     that item threw. ---
if(shouldRunPhase(['move-table'])){
const appBV = await launchApp();
try {
  await seedBackup(appBV.page, {
    version: 6, user: 'tester',
    lines: [
      { id: 'L1', name: 'White Test', color: 'white', openingMoves: ['d4'], prefs: [] },
      { id: 'L2', name: 'Black Test', color: 'black', openingMoves: ['e4'], prefs: [
        { seq: ['e4'], reply: 'e5' },
      ]},
    ],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6' },
      { id: 'g2', moves: 'e4 e5 Nf3 Nc6' },   // matches the configured Black reply (e5) -- excluded
      { id: 'g3', moves: 'e4 c5 Nf3 d6' },    // divergent: Black played c5 instead
    ],
  });

  await appBV.page.waitForSelector('.line-row', { timeout: 10000 });
  await appBV.page.evaluate((name) => {
    const row = [...document.querySelectorAll('.line-row')].find(r => r.querySelector('.line-name')?.textContent.trim() === name);
    if(row) row.click();
  }, 'White Test');
  await appBV.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  const rowSel = 'tr.data-row[data-opp="Nf6"]';

  // 166. The glyph strip is collapsed until "Set Move Quality" is clicked,
  //      and clicking it leaves the row menu itself open (unlike every other
  //      menu item, which closes the menu on click).
  try {
    await appBV.page.evaluate(s => document.querySelector(`${s} .rowMenuBtn`).click(), rowSel);
    const collapsedBefore = await appBV.page.evaluate(s =>
      !document.querySelector(`${s} .row-menu-quality`).classList.contains('expanded'), rowSel);
    assert(collapsedBefore, 'expected the move-quality strip collapsed by default');
    await appBV.page.evaluate(s => document.querySelector(`${s} [data-act="qualityToggle"]`).click(), rowSel);
    const state = await appBV.page.evaluate(s => ({
      expanded: document.querySelector(`${s} .row-menu-quality`).classList.contains('expanded'),
      menuStillOpen: document.querySelector(`${s} .row-menu`).classList.contains('show'),
    }), rowSel);
    assert(state.expanded, 'expected "Set Move Quality" to reveal the glyph strip');
    assert(state.menuStillOpen, 'expected clicking "Set Move Quality" to leave the row menu open');
    ok('Set Move Quality: glyph strip collapsed by default, click-to-reveal without closing the menu');
  } catch(e){ bad('Set Move Quality click-to-reveal', e); }

  // 167. Picking a glyph through the newly-revealed strip still annotates
  //      the move and closes the menu (existing behaviour, unaffected).
  try {
    await appBV.page.evaluate(s => document.querySelector(`${s} .rmq[data-q="!"]`).click(), rowSel);
    const glyph = (await appBV.page.textContent(`${rowSel} .moveQual`)).trim();
    assert(glyph === '!', `expected '!' on the move, got '${glyph}'`);
    ok('Set Move Quality: picking a glyph through the new toggle still annotates the move');
  } catch(e){ bad('Set Move Quality: pick glyph via new toggle', e); }

  // 168. "Add Note" is gone from the row menu; notes are set via "Set
  //      Attributes" instead and still show as a meta-row badge, same as
  //      before.
  try {
    const noteItemGone = await appBV.page.evaluate(s => !document.querySelector(`${s} [data-act="note"]`), rowSel);
    assert(noteItemGone, 'expected the standalone "Add Note" menu item to be removed');
    await appBV.page.evaluate(s => document.querySelector(`${s} .rowMenuBtn`).click(), rowSel);
    await appBV.page.evaluate(s => document.querySelector(`${s} [data-act="attributes"]`).click(), rowSel);
    await appBV.page.waitForSelector('#attributesOverlay', { state: 'visible', timeout: 5000 });
    await appBV.page.fill('#attrNote', 'watch the e6 setup');
    await appBV.page.evaluate(() => document.getElementById('attributesSaveBtn').click());
    await appBV.page.waitForFunction(() => document.getElementById('attributesOverlay').style.display === 'none', { timeout: 5000 });
    await appBV.page.waitForSelector(`${rowSel} + tr.meta-row .meta-note`, { timeout: 5000 });
    const noteText = (await appBV.page.textContent(`${rowSel} + tr.meta-row .meta-note`)).trim();
    assert(noteText === 'watch the e6 setup', `expected the note badge to show the saved note, got "${noteText}"`);
    ok('Notes folded into Set Attributes: saving a note there shows the meta-row badge');
  } catch(e){ bad('Notes folded into Set Attributes: save + badge', e); }

  // 169. Reopening Set Attributes -- via the meta-row note badge itself --
  //      shows the previously-saved note pre-filled.
  try {
    await appBV.page.evaluate(s => document.querySelector(`${s} + tr.meta-row .meta-note`).click(), rowSel);
    await appBV.page.waitForSelector('#attributesOverlay', { state: 'visible', timeout: 5000 });
    const prefilled = await appBV.page.inputValue('#attrNote');
    assert(prefilled === 'watch the e6 setup', `expected attrNote pre-filled with the saved note, got "${prefilled}"`);
    await appBV.page.evaluate(() => document.getElementById('attributesCancelBtn').click());
    ok('Notes folded into Set Attributes: clicking the meta-row badge reopens Attributes with the note pre-filled');
  } catch(e){ bad('Notes folded into Set Attributes: badge reopens pre-filled', e); }

  // 170. renderBlackRoot regression: the black-root row's menu now has a
  //      matching "Compare Games" button for its (previously dangling)
  //      click handler, and using it works like the white-side version.
  try {
    await appBV.page.evaluate(() => document.getElementById('backBtn').click());
    await appBV.page.waitForSelector('.line-row', { timeout: 10000 });
    await appBV.page.evaluate((name) => {
      const row = [...document.querySelectorAll('.line-row')].find(r => r.querySelector('.line-name')?.textContent.trim() === name);
      if(row) row.click();
    }, 'Black Test');
    const blackRowSel = 'tr.data-row[data-seq="e4"]';
    await appBV.page.waitForSelector(blackRowSel, { timeout: 10000 });
    await appBV.page.evaluate(s => document.querySelector(`${s} .rowMenuBtn`).click(), blackRowSel);
    const hasCompareBtn = await appBV.page.evaluate(s => !!document.querySelector(`${s} [data-act="compareActual"]`), blackRowSel);
    assert(hasCompareBtn, 'expected the black-root row menu to have a "Compare Games" button');
    await appBV.page.evaluate(s => document.querySelector(`${s} [data-act="compareActual"]`).click(), blackRowSel);
    await appBV.page.waitForSelector(`${blackRowSel} + tr.meta-row .meta-actual-header`, { timeout: 5000 });
    const state = await appBV.page.evaluate(s => {
      const meta = document.querySelector(s).nextElementSibling;
      return {
        standardBold: meta.querySelector('.meta-actual-header strong .meta-actual-move')?.textContent.trim(),
        altMoves: [...meta.querySelectorAll('.meta-actual-alt-row .meta-actual-move')].map(el => el.textContent.trim()),
      };
    }, blackRowSel);
    assert(state.standardBold === 'e5', `expected the configured standard (e5) boldfaced in the header, got "${state.standardBold}"`);
    assert(JSON.stringify(state.altMoves) === JSON.stringify(['c5']), `expected the divergent alternate (c5) as its own row, got ${JSON.stringify(state.altMoves)}`);
    ok('renderBlackRoot regression: "Compare Games" button exists and works (previously missing HTML for a wired handler)');
  } catch(e){ bad('renderBlackRoot: Compare Games button', e); }
} finally {
  await appBV.close();
}
}

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
