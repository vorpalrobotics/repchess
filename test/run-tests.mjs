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

// seedBackup `games[].players` shorthand for "tester played White/Black
// against `opp`" -- Compare Games / Browse Games only count a game toward the
// user's own play at all when userColorInGame resolves it to CURRENT_LINE's
// own color, so most seeds need this now, not just the perspective-specific
// tests that originally introduced players/winner.
const pWhite = (opp='opp') => ({ white: { user: { name: 'tester' } }, black: { user: { name: opp } } });
const pBlack = (opp='opp') => ({ white: { user: { name: opp } }, black: { user: { name: 'tester' } } });

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
  'memorized-stability': 'memorized-room shape snapshot, dirty detection, and the side-door mechanism for linear rooms',
  'auto-import':       'daily auto-import from Lichess/chess.com: sizing heuristics, daily gate, boot trigger',
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
try {
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

} catch(e){ bad("phase @ line 79 (tags: ['core'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase B: opponent move-quality annotation (move table) ---
if(shouldRunPhase(['move-table'])){
try {
const app2 = await launchApp();
try {
  // seed a white 1.d4 line plus a game so the opponent reply (Nf6) appears as a row
  await seedBackup(app2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'London', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
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

  // 7a. Importing's writes actually commit to IndexedDB, not just the
  //     in-memory PREFS cache -- the whole point of batching every write
  //     from an import into ONE transaction (see db.js's setPrefsBatch,
  //     which importLine now uses instead of one setPref() round-trip per
  //     move) is to make it fast, and it would be a bad trade if that meant
  //     the write only "looked" done because PREFS was already updated in
  //     memory while the real commit hadn't landed. Reload and reopen.
  try {
    await app2.page.reload({ waitUntil: 'domcontentloaded' });
    await app2.page.waitForFunction(() => {
      const el = document.getElementById('buildStamp');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    await app2.page.click('.line-row');
    await app2.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
    const reply = (await app2.page.textContent('tr.data-row[data-opp="Nf6"] .ourReply')).trim();
    assert(reply === 'c4', `expected the imported reply to survive a reload, got '${reply}'`);
    ok('import-variation: the batched write actually commits to IndexedDB (survives a reload), not just PREFS in memory');
  } catch(e){ bad('import-variation persists across reload', e); }

  // 7b0. Importing shows a spinner for the duration of the write, then hides
  //      it -- even though batching makes a typical import fast now, a
  //      large paste is still real synchronous parsing plus one real
  //      IndexedDB commit, and there was previously no feedback at all that
  //      anything was happening until the dialog closed.
  try {
    await app2.page.evaluate(() => document.getElementById('menuImportLine').click());
    await app2.page.fill('#importLineInput', '1. d4 Nf6 2. c4 g6 3. Nc3');
    await app2.page.evaluate(() => document.getElementById('importLineSaveBtn').click());
    // showSpinner() runs synchronously as the very first line of importLine,
    // before its first await -- by the time the click's own evaluate()
    // resolves, the overlay is already showing.
    const shownRightAway = await app2.page.evaluate(() =>
      getComputedStyle(document.getElementById('spinnerOverlay')).display !== 'none');
    assert(shownRightAway, 'expected the spinner to appear immediately on Import');
    await app2.page.waitForFunction(() =>
      getComputedStyle(document.getElementById('spinnerOverlay')).display === 'none', { timeout: 10000 });
    ok('import-variation: a spinner shows for the duration of the import, then hides');
  } catch(e){ bad('import-variation spinner', e); }

  // 7b1. Two variations pasted TOGETHER that both add a manual opponent try
  //      at the exact same position (sharing everything but their final
  //      move) both survive -- the shared batch (keyed by pref key, see
  //      importParsedLine's own comment) must fold both writes into one
  //      combined manualReplies list, not let the second one clobber the
  //      first from a stale read.
  try {
    await app2.page.evaluate(() => document.getElementById('menuImportLine').click());
    await app2.page.fill('#importLineInput',
      '1. d4 Nf6 2. c4 e6 3. Nc3 Bb4\n1. d4 Nf6 2. c4 e6 3. Nc3 g6');
    await app2.page.evaluate(() => document.getElementById('importLineSaveBtn').click());
    await app2.page.waitForFunction(() => document.getElementById('importLineOverlay').style.display === 'none', { timeout: 10000 });
    const rows = await app2.page.evaluate(() => [
      !!document.querySelector('tr.data-row[data-seq="d4,Nf6,c4,e6,Nc3,Bb4"]'),
      !!document.querySelector('tr.data-row[data-seq="d4,Nf6,c4,e6,Nc3,g6"]'),
    ]);
    assert(rows[0] && rows[1], `expected BOTH manual tries (Bb4 and g6) to survive the combined paste, got ${JSON.stringify(rows)}`);
    ok('import-variation: two variations pasted together that both add a manual try at the same position both survive');
  } catch(e){ bad('import-variation: same-position manual tries from one paste do not clobber each other', e); }

  // 7b. The move table's own rows (not just Compare Games) are clickable
  //     mini-board chips too: the opponent move and the standard reply both
  //     carry .pv-move + data-fen, and clicking either opens the mini board
  //     at the resulting position -- the delegated .pv-move handler is
  //     generic, so this is the same mechanism Compare Games already uses.
  try {
    const oppFen = await app2.page.evaluate((sel) => document.querySelector(`${sel} .move .pv-move`)?.dataset.fen, rowSel);
    assert(oppFen && oppFen.includes(' w '), `expected the opponent move's (Nf6, Black's) data-fen to be a White-to-move position, got "${oppFen}"`);
    await app2.page.evaluate((sel) => document.querySelector(`${sel} .move .pv-move`).click(), rowSel);
    let floatVisible = await app2.page.evaluate(() => document.getElementById('pvFloat').style.display === 'block');
    assert(floatVisible, 'expected clicking the opponent move to open the mini board');

    const replyFen = await app2.page.evaluate((sel) => document.querySelector(`${sel} .ourReply .pv-move`)?.dataset.fen, rowSel);
    assert(replyFen && replyFen.includes(' b '), `expected the reply's (c4, White's) data-fen to be a Black-to-move position, got "${replyFen}"`);
    await app2.page.evaluate((sel) => document.querySelector(`${sel} .ourReply .pv-move`).click(), rowSel);
    floatVisible = await app2.page.evaluate(() => document.getElementById('pvFloat').style.display === 'block');
    assert(floatVisible, 'expected clicking the standard reply to open the mini board');
    ok('move table: the opponent move and standard reply are both clickable mini-board chips, like Compare Games');
  } catch(e){ bad('move table: main moves open a mini board on click', e); }
} finally {
  await app2.close();
}

} catch(e){ bad('Phase B: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase C: cross-castle door plaque (two-line: castle name over room) ---
if(shouldRunPhase(['vr-castle'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase C: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase C2: a nested castle's door redirects to the OTHER castle's own
// canonical room, so decorations configured there (e.g. a staircase) show up
// from the nested door too, instead of a duplicate/undecorated inline copy. ---
if(shouldRunPhase(['vr-castle'])){
try {
const appC2 = await launchApp();
try {
  const keys = await appC2.page.evaluate(() => {
    const pk = mv => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_'); };
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase C2: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase D: walk UP a staircase that shares its wall with other doors ---
// (regression: a variation import added a door to a stair's wall, and the clamp
// only allowed ONE door per wall as walkable, blocking the stair at its base.)
if(shouldRunPhase(['vr-castle'])){
try {
const app4 = await launchApp();
try {
  const keys = await app4.page.evaluate(() => {
    const pk = mv => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_'); };
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase D: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase E: room-bounds auto-fix (a nudged item survives a later downsize) ---
if(shouldRunPhase(['vr-decorating'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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
    // async), so poll rather than trust a fixed delay. NOTE: a stored size
    // smaller than the room's own content floor now SELF-HEALS --
    // reconcileRoomBounds grows it back up to relaxedContentMin on the next
    // buildRoom -- so the room won't actually stay 4x4. The invariant under
    // test is that the nudged billboard ends up inside the room's ACTUAL
    // (healed) footprint, whatever that resolves to, not stranded in a wall;
    // assert against the live roomSize rather than a hard-coded 4x4 bound.
    const inBounds = (p, sz) => p && sz && Math.abs(p.x) <= sz.w/2 - 0.3 + 0.05 && Math.abs(p.z) <= sz.d/2 - 0.3 + 0.05;
    const afterResize = await app5.page.evaluate(async ({ rk }) => {
      const dbg = window.__threeTestEdit;
      dbg.resize(rk, { w: 4, d: 4, h: 3 });
      let out = null;
      const deadline = Date.now() + 8000;
      while(Date.now() < deadline){
        const pos = dbg.posOf('mnem-C1'), sz = dbg.roomSize(rk);
        if(pos && sz && Math.abs(pos.x) <= sz.w/2 - 0.3 + 0.05 && Math.abs(pos.z) <= sz.d/2 - 0.3 + 0.05){ out = { pos, sz }; break; }
        await new Promise(r => setTimeout(r, 100));
      }
      return out || { pos: dbg.posOf('mnem-C1'), sz: dbg.roomSize(rk) };
    }, { rk: room });
    assert(inBounds(afterResize.pos, afterResize.sz),
      `billboard stayed outside the room's footprint after resize: ${JSON.stringify(afterResize)}`);

    const afterReentry = await app5.page.evaluate(async (rk) => {
      const dbg = window.__threeTestEdit;
      dbg.enter('mainStreet');
      await new Promise(r => setTimeout(r, 150));
      dbg.enter(rk);
      await new Promise(r => setTimeout(r, 150));
      return { pos: dbg.posOf('mnem-C1'), sz: dbg.roomSize(rk) };
    }, room);
    assert(inBounds(afterReentry.pos, afterReentry.sz),
      `billboard drifted back out after a re-entry: ${JSON.stringify(afterReentry)}`);

    ok('a nudged billboard stays inside the room\'s footprint after a resize (too-small size self-heals)');
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase E: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase F: translate gizmo drag (phase 1: floor/moveObject/mnemonic props) ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appGZ = await launchApp();
try {
  await seedBackup(appGZ.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
    ]}],
    games: [ { id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' } ],
  }, { defaultPlayerColor: 'white' });
  await appGZ.page.click('.line-row');
  await appGZ.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await appGZ.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await appGZ.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await appGZ.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await appGZ.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await appGZ.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await appGZ.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await appGZ.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await appGZ.page.waitForTimeout(400);
  // baseline camera pose (level, no gizmo lift) -- captured before any
  // selection exists, for 11e to compare the tilted/lifted pose against.
  const camBaseline = await appGZ.page.evaluate(() => ({ y: window.__threeTestState.y, pitch: window.__threeTestState.pitch }));
  // mnem-C1 (the entry room's own move-pair billboard) is always present,
  // unlike a move-object prop which needs an asset assigned first -- same
  // shortcut Phase E's keyboard-nudge test above relies on. It's a
  // 'mnemonic' kind, one of the three GIZMO_KINDS.
  await appGZ.page.evaluate(() => {
    window.__threeTestEdit.toggle();
    window.__threeTestEdit.target({ kind: 'accessory', slotId: 'mnem-C1' });
  });
  await appGZ.page.waitForTimeout(100);

  // 11b. A mnemonic (free-floating: horizontal + vertical) selection gets
  //      all three gizmo arrows. (A kind with no vertical lift, e.g. a
  //      floor prop, wouldn't get "up" -- see GIZMO_KINDS/onKeyDown's own
  //      h/l guard -- not separately exercised here since reaching a
  //      move-object/floor prop needs an asset-bound slot, more setup than
  //      this phase's always-present entry-room billboard needs.)
  try {
    const axes = await appGZ.page.evaluate(() => window.__threeTestEdit.gizmoAxes());
    assert(JSON.stringify([...axes].sort()) === JSON.stringify(['up','x','z']),
      `expected a mnemonic selection to show all three gizmo arrows, got ${JSON.stringify(axes)}`);
    ok('translate gizmo: a free-floating (mnemonic) selection shows x/z/up arrows');
  } catch(e){ bad('translate gizmo: arrow set for a mnemonic selection', e); }

  // 11b2. The outline/gizmo materials are transparent (not just
  //       depthTest:false) so they compete in three.js's transparent render
  //       queue, not the opaque one -- the opaque queue always draws
  //       entirely before the transparent queue regardless of renderOrder,
  //       and a door skin's own material IS transparent, so an
  //       opaque-but-depthTest:false arrow at even a very high renderOrder
  //       still drew BEFORE a door skin and was then painted over by it.
  //       Reported bug: arrows rendering underneath door skins.
  try {
    const info = await appGZ.page.evaluate(() => window.__threeTestEdit.selectionRenderInfo());
    assert(info.outline && info.outline.transparent && info.outline.depthTest === false && info.outline.renderOrder > 0,
      `expected the selection outline material to be transparent+depthTest:false+high renderOrder, got ${JSON.stringify(info.outline)}`);
    assert(info.gizmo && info.gizmo.transparent && info.gizmo.depthTest === false && info.gizmo.renderOrder > 0,
      `expected the gizmo arrow material to be transparent+depthTest:false+high renderOrder, got ${JSON.stringify(info.gizmo)}`);
    ok('translate gizmo: outline/arrow materials are transparent so they draw on top of transparent things like a door skin, not just opaque ones');
  } catch(e){ bad('translate gizmo: outline/arrow render queue (transparent+depthTest+renderOrder)', e); }

  // 11c. Dragging the "x" arrow (wall-relative -- always world +X in every
  //      room, regardless of which way the player is facing, see AXIS_X's
  //      own comment) via a REAL pointer sequence (not a hook bypassing the
  //      raycast/plane-projection math) moves the billboard along that
  //      axis with height unchanged, coalesces the whole drag into exactly
  //      one undo entry (same rule a held arrow key follows), and undo
  //      reverts it.
  try {
    const before = await appGZ.page.evaluate(() => window.__threeTestEdit.posOf('mnem-C1'));
    const undoBefore = await appGZ.page.evaluate(() => window.__threeTestEdit.undoDepth());
    const pt = await appGZ.page.evaluate(() => window.__threeTestEdit.gizmoArrowScreenPoint('x'));
    assert(pt, 'expected a screen point for the "x" gizmo arrow');

    await appGZ.page.mouse.move(pt.x, pt.y);
    await appGZ.page.mouse.down();
    await appGZ.page.mouse.move(pt.x + 70, pt.y, { steps: 6 });
    await appGZ.page.mouse.up();
    await appGZ.page.waitForTimeout(100);

    const after = await appGZ.page.evaluate(() => window.__threeTestEdit.posOf('mnem-C1'));
    const dx = after.x - before.x, dz = after.z - before.z, dy = after.y - before.y;
    assert(dx > 0.15, `expected the "x" drag to move the billboard along +X, got dx=${dx}`);
    assert(Math.abs(dz) < 0.05, `expected the "x" drag to leave Z essentially unchanged, got dz=${dz}`);
    assert(Math.abs(dy) < 0.05, `expected a horizontal drag to leave height unchanged, got dy=${dy}`);

    const undoAfter = await appGZ.page.evaluate(() => window.__threeTestEdit.undoDepth());
    assert(undoAfter === undoBefore + 1, `expected the whole drag to coalesce into exactly one undo entry, got ${undoBefore} -> ${undoAfter}`);
    await appGZ.page.evaluate(() => window.__threeTestEdit.undo());
    await appGZ.page.waitForTimeout(200);   // undo rebuilds the room asynchronously (refreshAssetMap().then(buildRoom)) -- posOf reads the live scene
    const reverted = await appGZ.page.evaluate(() => window.__threeTestEdit.posOf('mnem-C1'));
    assert(Math.abs(reverted.x - before.x) < 0.02, `expected undo to put the billboard back where it started, got ${JSON.stringify(reverted)} vs ${JSON.stringify(before)}`);
    ok('translate gizmo: dragging the "x" arrow moves along that axis, coalesces to one undo step, and undo reverts it');
  } catch(e){ bad('translate gizmo: "x" arrow drag', e); }

  // 11c2. Reported mobile bug: a gizmo-arrow drag would "stop working after a
  //       short distance," and once threw the user clean out of VR entirely.
  //       Root cause -- the OS can decide mid-touch-drag that it's actually a
  //       page scroll and hand off to native scrolling, which fires
  //       pointercancel instead of pointerup; onGizmoPointerUp only ever
  //       listened for pointerup, so gizmoDrag was left stuck non-null with
  //       its pointermove listener still live on window, applying every
  //       later pointer move anywhere on the page to this now-stale
  //       room/slot. Fixed with touch-action:none (stops the takeover before
  //       it starts) plus an actual pointercancel handler as a safety net.
  //       Playwright's mouse API can't simulate a real touch-cancel, so this
  //       drives the same real pointerdown/pointermove path as 11c via
  //       page.mouse, then dispatches a synthetic pointercancel (matching
  //       pointerId) the way the OS would -- proving the drag stops
  //       immediately, doesn't leak, and a fresh drag afterward still works.
  try {
    const before = await appGZ.page.evaluate(() => window.__threeTestEdit.posOf('mnem-C1'));
    const pt = await appGZ.page.evaluate(() => window.__threeTestEdit.gizmoArrowScreenPoint('x'));
    assert(pt, 'expected a screen point for the "x" gizmo arrow');

    await appGZ.page.mouse.move(pt.x, pt.y);
    await appGZ.page.mouse.down();
    await appGZ.page.mouse.move(pt.x + 40, pt.y, { steps: 4 });
    const active = await appGZ.page.evaluate(() => window.__threeTestEdit.gizmoDragActive());
    assert(active, 'expected a gizmo drag to be in progress mid-move');
    const midway = await appGZ.page.evaluate(() => window.__threeTestEdit.posOf('mnem-C1'));
    assert(midway.x - before.x > 0.05, `expected the partial drag to have already moved the billboard, got dx=${midway.x - before.x}`);

    // real mouse pointerdown/move in Chromium use pointerId 1 -- match it so
    // the cancel is recognized as ending THIS drag (see onGizmoPointerEnd's
    // own pointerId check).
    await appGZ.page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
    const activeAfterCancel = await appGZ.page.evaluate(() => window.__threeTestEdit.gizmoDragActive());
    assert(!activeAfterCancel, 'expected pointercancel to immediately end the drag (gizmoDrag cleared)');

    // further pointer movement with no drag active must NOT keep nudging the
    // object -- this is exactly the leak that let a stray later pointermove
    // (e.g. from walking around, or just lifting the finger elsewhere) keep
    // silently mutating a stale room/slot.
    await appGZ.page.mouse.move(pt.x + 120, pt.y, { steps: 4 });
    await appGZ.page.mouse.up();
    await appGZ.page.waitForTimeout(80);
    const afterStrayMove = await appGZ.page.evaluate(() => window.__threeTestEdit.posOf('mnem-C1'));
    assert(Math.abs(afterStrayMove.x - midway.x) < 0.02,
      `expected no further movement after pointercancel, got ${JSON.stringify(midway)} -> ${JSON.stringify(afterStrayMove)}`);

    // a fresh drag right afterward still works -- the cancel path didn't
    // leave any listener stuck/removed in a way that breaks the next one.
    const pt2 = await appGZ.page.evaluate(() => window.__threeTestEdit.gizmoArrowScreenPoint('x'));
    await appGZ.page.mouse.move(pt2.x, pt2.y);
    await appGZ.page.mouse.down();
    await appGZ.page.mouse.move(pt2.x + 60, pt2.y, { steps: 6 });
    await appGZ.page.mouse.up();
    await appGZ.page.waitForTimeout(100);
    const finalPos = await appGZ.page.evaluate(() => window.__threeTestEdit.posOf('mnem-C1'));
    assert(finalPos.x - afterStrayMove.x > 0.15, `expected a fresh drag after the cancel to still move the billboard, got dx=${finalPos.x - afterStrayMove.x}`);
    ok('translate gizmo: a pointercancel (OS-interrupted touch drag) ends the drag cleanly with no leak, and a fresh drag afterward still works');
  } catch(e){ bad('translate gizmo: pointercancel mid-drag does not leak/stick', e); }

  // 11d. Dragging the "up" arrow moves height only, and arrow-key nudging
  //      still works immediately afterward -- the gizmo is an alternative
  //      input method for the exact same selectedProp/setSlotXformLive
  //      path, not a replacement that disables the keyboard one.
  try {
    // mnem-C1 is still selected from 11c (undo doesn't clear selection, and
    // re-targeting an already-selected slot would just toggle it off -- see
    // handleEditTarget's accessory-kind branch).
    const before = await appGZ.page.evaluate(() => window.__threeTestEdit.posOf('mnem-C1'));
    const pt = await appGZ.page.evaluate(() => window.__threeTestEdit.gizmoArrowScreenPoint('up'));
    assert(pt, 'expected a screen point for the "up" gizmo arrow');

    await appGZ.page.mouse.move(pt.x, pt.y);
    await appGZ.page.mouse.down();
    await appGZ.page.mouse.move(pt.x, pt.y - 60, { steps: 6 });
    await appGZ.page.mouse.up();
    await appGZ.page.waitForTimeout(100);

    const afterUp = await appGZ.page.evaluate(() => window.__threeTestEdit.posOf('mnem-C1'));
    assert(afterUp.y - before.y > 0.1, `expected dragging "up" to raise the billboard, got dy=${afterUp.y - before.y}`);
    assert(Math.abs(afterUp.x - before.x) < 0.05 && Math.abs(afterUp.z - before.z) < 0.05,
      `expected a vertical drag to leave the horizontal position unchanged, got ${JSON.stringify({before, afterUp})}`);

    await appGZ.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })));
    await appGZ.page.waitForTimeout(80);
    const afterKey = await appGZ.page.evaluate(() => window.__threeTestEdit.posOf('mnem-C1'));
    assert(afterKey.x - afterUp.x > 0.05, `expected ArrowRight to still nudge the billboard after a gizmo drag, got dx=${afterKey.x - afterUp.x}`);
    ok('translate gizmo: dragging "up" moves height only, and keyboard nudging still works right after');
  } catch(e){ bad('translate gizmo: "up" arrow drag + keyboard coexistence', e); }

  // 11e. Selecting a gizmo-eligible prop eases the camera up and tilts it
  //      down (EDIT_TILT_LIFT/EDIT_TILT_PITCH) so the two horizontal arrows
  //      are never viewed edge-on; deselecting eases it back to level. Only
  //      needs to observe __threeTestState's y/pitch -- mnem-C1 is already
  //      selected from 11c/11d.
  try {
    await appGZ.page.waitForTimeout(400);   // let the eased tilt/lift converge
    const tilted = await appGZ.page.evaluate(() => ({ y: window.__threeTestState.y, pitch: window.__threeTestState.pitch }));
    assert(tilted.y - camBaseline.y > 0.5, `expected selecting a gizmo-eligible prop to lift the camera, got ${camBaseline.y} -> ${tilted.y}`);
    assert(tilted.pitch < camBaseline.pitch - 0.1, `expected selecting a gizmo-eligible prop to tilt the camera down, got ${camBaseline.pitch} -> ${tilted.pitch}`);

    await appGZ.page.evaluate(() => window.__threeTestEdit.target({ kind: 'accessory', slotId: 'mnem-C1' }));   // toggle off (already selected)
    await appGZ.page.waitForTimeout(400);
    const level = await appGZ.page.evaluate(() => ({ y: window.__threeTestState.y, pitch: window.__threeTestState.pitch }));
    assert(Math.abs(level.y - camBaseline.y) < 0.05, `expected deselecting to ease the camera back down, got ${camBaseline.y} vs ${level.y}`);
    assert(Math.abs(level.pitch - camBaseline.pitch) < 0.02, `expected deselecting to ease the camera pitch back level, got ${camBaseline.pitch} vs ${level.pitch}`);
    ok('translate gizmo: selecting eases the camera up/down-tilted, deselecting eases it back to level');
  } catch(e){ bad('translate gizmo: camera tilt/lift on selection', e); }
} finally {
  await appGZ.close();
}

} catch(e){ bad('Phase F: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase F2: translate gizmo drag, extended to wall and ceiling props ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appGZ2 = await launchApp();
try {
  // reuses Phase CK's exact "Fan" fixture (3 forward doors branching off the
  // same merged room, from where the opponent's Nc3 reply could go 3 ways)
  // -- a plain single-line castle (Phase F's own fixture) never branches at
  // all, so it has no real doors anywhere (room.exits stays empty and there's
  // no wh-*/eye-level wall slot to test at all -- everything nudgeable is
  // either a move-object/mnemonic pair or a ground-level wall/ceiling spot).
  await seedBackup(appGZ2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Fan', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'a3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Be7'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','e6','Nc3','d5'], reply: 'cxd5' },
      // a SEPARATE "Solo" castle whose root forks 3 ways immediately, with
      // NO preceding forced chain -- unlike "Fan" above (whose branch sits
      // at the TAIL of an otherwise-linear run, which is still classified
      // 'corridor' end to end, see analyzeCastleStructure's own `run.length
      // >= 2` requirement), a node that forks from move 1 never joins any
      // run OR a clean two-track (that needs exactly 2 children), so it
      // falls to the 'solo:'+id fallback -- castleSign.type stays unset.
      // This is the actual "no linear sequence" room 11n needs.
      { seq: ['d4','d5'], reply: 'c4', isCastleRoot: true, castleName: 'Solo', castleStreetNumber: 2 },
      { seq: ['d4','d5','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','d5','c4','c6'], reply: 'Nc3' },
      { seq: ['d4','d5','c4','dxc4'], reply: 'e4' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 a3', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 e6 Nc3 Be7 e4', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 Nf6 c4 e6 Nc3 d5 cxd5', white: 'a', black: 'b', result: '*' },
      { id: 'g4', moves: 'd4 d5 c4 e6 Nc3', white: 'a', black: 'b', result: '*' },
      { id: 'g5', moves: 'd4 d5 c4 c6 Nc3', white: 'a', black: 'b', result: '*' },
      { id: 'g6', moves: 'd4 d5 c4 dxc4 e4', white: 'a', black: 'b', result: '*' },
    ],
    // billboard-cylindrical (not extruded): its mesh geometry is real and
    // synchronous (a plain PlaneGeometry) -- an extruded asset instead traces
    // its shape from the loaded image asynchronously, and this placeholder
    // 1x1 PNG never produces one, leaving an empty Group that Box3 measures
    // as a degenerate (0,0,0) box (which is exactly what broke the very
    // first version of the tests below: the ceiling gizmo's origin came out
    // at the room's floor instead of its ceiling).
    assets: [{ id: 'propA', name: 'propA', type: 'billboard-cylindrical', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w: 0.6, h: 0.6 } }],
  }, { defaultPlayerColor: 'white' });
  await openVR(appGZ2.page);
  const roomKey2 = await appGZ2.page.evaluate(() => {
    const c = new Chess(); for(const m of ['d4','Nf6','c4']) c.move(m,{sloppy:true});
    return 'cas:L1_Fan:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  });

  // 11e2. Still on Main Street (before walking into the castle below): the
  //       "Fan" building's own lawn sign (kind 'sign', no slotId at all --
  //       keyed by buildingKey instead, see selectSign/setSignPosLive) is the
  //       only place this fixture puts a 'sign'-kind object, and its
  //       buildingKey is that castle's entry room key -- the very roomKey2
  //       just computed above (generateMainStreet sets `target: c.entryKey`
  //       as the buildingKey, and that entryKey is what enter(roomKey2)
  //       below relies on being the Fan castle's real room). Confirms 'sign'
  //       gets x/z arrows only (ground-clamped, no vertical) and a real drag
  //       moves it via setSignPosLive, not the slotXform store.
  try {
    const before = await appGZ2.page.evaluate((bk) => window.__threeTestEdit.signWorldPos(bk), roomKey2);
    assert(before, 'test setup issue: expected to find the "Fan" building\'s lawn sign in the scene');
    // stand a few meters back facing it squarely -- Main Street's own default
    // spawn has no reason to already be looking at any one building's sign.
    await appGZ2.page.evaluate((p) => window.__threeTestEdit.teleport(p.x, p.z + 4, 0), before);
    await appGZ2.page.waitForTimeout(100);

    await appGZ2.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
    await appGZ2.page.waitForTimeout(60);
    await appGZ2.page.evaluate((bk) => window.__threeTestEdit.target({ kind: 'sign', roomKey: 'mainStreet', buildingKey: bk }), roomKey2);
    await appGZ2.page.waitForTimeout(150);
    const axes = await appGZ2.page.evaluate(() => window.__threeTestEdit.gizmoAxes());
    assert(JSON.stringify([...axes].sort()) === JSON.stringify(['x','z']),
      `expected a sign selection to show x/z arrows only, no vertical, got ${JSON.stringify(axes)}`);

    const pt = await appGZ2.page.evaluate(() => window.__threeTestEdit.gizmoArrowScreenPoint('x'));
    assert(pt, 'expected a screen point for the sign\'s "x" gizmo arrow');

    await appGZ2.page.mouse.move(pt.x, pt.y);
    await appGZ2.page.mouse.down();
    await appGZ2.page.mouse.move(pt.x + 70, pt.y, { steps: 6 });
    await appGZ2.page.mouse.up();
    await appGZ2.page.waitForTimeout(100);

    const after = await appGZ2.page.evaluate((bk) => window.__threeTestEdit.signWorldPos(bk), roomKey2);
    assert(Math.abs(after.x - before.x) + Math.abs(after.z - before.z) > 0.15,
      `expected the "x" drag to move the sign, got before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    assert(Math.abs(after.y - before.y) < 0.02, `expected a sign drag to leave height unchanged, got dy=${after.y - before.y}`);
    ok('translate gizmo: a building lawn sign shows x/z arrows only, and a real drag moves it (setSignPosLive)');

    await appGZ2.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode back off, restoring state for the tests below
    await appGZ2.page.waitForTimeout(60);
  } catch(e){ bad('translate gizmo: sign gizmo (arrow set + drag)', e); }

  await appGZ2.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey2);
  // enter() always spawns at the fixed local (0,0) -- fine for tests that
  // don't care where the player stands, but this room's own ceiling
  // hang-point (ceilingSlots) is ALSO always at local (0,0), so (0,0) plants
  // the camera directly beneath it: an edge case real play never produces
  // (walking in normally lands you at the room's own entrance, well off to
  // one side of center -- see entrySpawnFor) but that made a later gizmo
  // screen-point genuinely fall outside the canvas. Stand at the room's own
  // real entry spawn instead, same as actually walking in would.
  const spawn2 = await appGZ2.page.evaluate((k) => window.__threeTestEdit.entrySpawnFor(k), roomKey2);
  await appGZ2.page.evaluate(({ x, z, yaw }) => window.__threeTestEdit.teleport(x, z, yaw), spawn2);
  await appGZ2.page.waitForTimeout(400);
  const camBaseline2 = await appGZ2.page.evaluate(() => ({ y: window.__threeTestState.y, pitch: window.__threeTestState.pitch }));
  await appGZ2.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
  await appGZ2.page.waitForTimeout(60);

  // assigns asset 'propA' to slotId via the real picker (allowWord/allow are
  // generic to any empty-slot marker, wall/ceiling included -- see
  // handleEditTarget's own 'slot' branch).
  async function assignPropA(slotId){
    await appGZ2.page.evaluate((sid) => window.__threeTestEdit.target({ kind: 'slot', slotId: sid, allow: ['extruded','billboard-cylindrical'] }), slotId);
    await appGZ2.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appGZ2.page.evaluate(() => {
      const card = [...document.querySelectorAll('#pickerGrid .asset-card')].find(c => c.textContent.includes('propA'));
      card.click();
    });
    await appGZ2.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
    await appGZ2.page.waitForTimeout(150);
  }

  // 11f. Ceiling: the always-present hang-point (ceilingSlots -- 'ceil-c')
  //      gets x/z (its own horizontal plane) but no vertical arrow at all --
  //      its height is always room.size.h-derived, never nudgeable (see
  //      nudgeSelected's own 'ceiling' branch).
  try {
    await assignPropA('ceil-c');
    await appGZ2.page.evaluate(() => window.__threeTestEdit.target({ kind: 'accessory', slotId: 'ceil-c' }));
    await appGZ2.page.waitForTimeout(500);   // let the (upward, for ceiling) tilt/lift converge
    const axes = await appGZ2.page.evaluate(() => window.__threeTestEdit.gizmoAxes());
    assert(JSON.stringify([...axes].sort()) === JSON.stringify(['x','z']),
      `expected a ceiling selection to show only x/z (no up), got ${JSON.stringify(axes)}`);
    ok('translate gizmo: a ceiling prop shows x/z arrows only, no vertical');
  } catch(e){ bad('translate gizmo: arrow set for a ceiling prop', e); }

  // 11g. Dragging the ceiling prop's "x" arrow moves it in the ceiling's own
  //      plane, height unchanged -- same drag math as a floor/mnemonic prop,
  //      just anchored at the ceiling. ceil-c sits at the room's own centre
  //      (x=0,z=0), the same camera-facing geometry Phase F's mnem-C1 test
  //      already relies on for a reliable, non-degenerate screen-space drag.
  try {
    const before = await appGZ2.page.evaluate(() => window.__threeTestEdit.posOf('ceil-c'));
    const pt = await appGZ2.page.evaluate(() => window.__threeTestEdit.gizmoArrowScreenPoint('x'));
    assert(pt, 'expected a screen point for the ceiling\'s "x" gizmo arrow');

    await appGZ2.page.mouse.move(pt.x, pt.y);
    await appGZ2.page.mouse.down();
    await appGZ2.page.mouse.move(pt.x + 70, pt.y, { steps: 6 });
    await appGZ2.page.mouse.up();
    await appGZ2.page.waitForTimeout(100);

    const after = await appGZ2.page.evaluate(() => window.__threeTestEdit.posOf('ceil-c'));
    assert(after.x - before.x > 0.15, `expected the "x" drag to move the ceiling prop along +X, got dx=${after.x - before.x}`);
    assert(Math.abs(after.z - before.z) < 0.05, `expected the "x" drag to leave Z essentially unchanged, got dz=${after.z - before.z}`);
    assert(Math.abs(after.y - before.y) < 0.02, `expected a ceiling drag to leave height unchanged (no vertical DOF), got dy=${after.y - before.y}`);
    ok('translate gizmo: dragging a ceiling prop\'s "x" arrow slides it in the ceiling plane, height fixed');
  } catch(e){ bad('translate gizmo: ceiling "x" arrow drag', e); }

  // 11h. Selecting the ceiling prop tilts the camera UP (not down) and still
  //      lifts it, since its arrows sit overhead rather than at eye level;
  //      deselecting eases back to level.
  try {
    const tilted = await appGZ2.page.evaluate(() => ({ y: window.__threeTestState.y, pitch: window.__threeTestState.pitch }));
    assert(tilted.y - camBaseline2.y > 0.5, `expected selecting the ceiling prop to lift the camera, got ${camBaseline2.y} -> ${tilted.y}`);
    assert(tilted.pitch > camBaseline2.pitch + 0.1, `expected selecting the ceiling prop to tilt the camera UP, got ${camBaseline2.pitch} -> ${tilted.pitch}`);

    await appGZ2.page.evaluate(() => window.__threeTestEdit.target({ kind: 'accessory', slotId: 'ceil-c' }));   // toggle off
    // the ceiling's up-tilt can be much steeper than the fixed 10-degree
    // down-tilt (see EDIT_TILT_UP_MIN/MAX) -- easing is exponential decay, so
    // unwinding a bigger swing to within the same absolute tolerance takes
    // more real time; Phase F's 400ms (tuned for the always-10-degree case)
    // isn't always enough here.
    await appGZ2.page.waitForTimeout(700);
    const level = await appGZ2.page.evaluate(() => ({ y: window.__threeTestState.y, pitch: window.__threeTestState.pitch }));
    assert(Math.abs(level.y - camBaseline2.y) < 0.05, `expected deselecting the ceiling prop to ease the camera back down, got ${camBaseline2.y} vs ${level.y}`);
    assert(Math.abs(level.pitch - camBaseline2.pitch) < 0.02, `expected deselecting the ceiling prop to ease the camera pitch back level, got ${camBaseline2.pitch} vs ${level.pitch}`);
    ok('translate gizmo: selecting a ceiling prop tilts the camera UP (not down) and lifts it, deselecting eases back to level');
  } catch(e){ bad('translate gizmo: camera tilt/lift for a ceiling prop', e); }

  // wall props: discover real slot ids from whatever the generator actually
  // built for this room (lowWallSlots/doorFlankSlots depend on where its
  // doors landed) rather than assuming a specific wall. doorFlankSlots keys
  // its id only on wall+side, so multiple forward doors sharing a wall (this
  // fixture's whole point, see Phase CK) collide onto the SAME id, each
  // instance a real marker at its own door's offset -- picking a duplicated
  // id would land on an arbitrary one of them, so only IDs appearing exactly
  // once are usable here.
  const wallSlotIds = await appGZ2.page.evaluate(() =>
    window.__threeTestEdit.scan().filter(o => o.kind === 'slot' && o.slotId).map(o => o.slotId));
  const counts = wallSlotIds.reduce((m, id) => (m.set(id, (m.get(id) || 0) + 1), m), new Map());
  const unique = (prefix) => wallSlotIds.find(id => id.startsWith(prefix) && counts.get(id) === 1);
  const eyeLevelWallId = unique('wh-');
  const groundWallId = unique('wl-');
  // the wall name is embedded in the id itself (wh-<wall>-l/r, wl-<wall>) --
  // north/south run along world X, east/west along world Z (wallSpan).
  const axisForWallId = (id) => (['north','south'].includes(id.split('-')[1]) ? 'x' : 'z');

  // 11i. An eye-level wall prop (not `ground`) gets exactly ONE horizontal
  //      arrow -- along the wall itself, whichever world axis that wall
  //      actually runs on -- plus "up" (it can still be raised/lowered on
  //      the wall). Two horizontal arrows would be redundant/misleading:
  //      a wall piece has only one horizontal DOF to begin with.
  try {
    assert(eyeLevelWallId, 'test setup issue: expected an eye-level (wh-*) wall slot in this room');
    await assignPropA(eyeLevelWallId);
    await appGZ2.page.evaluate((sid) => window.__threeTestEdit.target({ kind: 'accessory', slotId: sid }), eyeLevelWallId);
    await appGZ2.page.waitForTimeout(200);
    // `enter()` always spawns facing a fixed compass direction (yaw 0),
    // which has no reason to be anywhere near THIS wall (its own exit,
    // 11i-11m's "Fan" fixture's back door, sits on a different wall
    // entirely) -- stand a couple of meters in front of it, facing it
    // squarely, so 11k's real mouse drag lands on-screen instead of
    // clicking wherever an arbitrary spawn yaw happens to be looking.
    const wallName = eyeLevelWallId.split('-')[1];
    const outNormal = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 }, east: { x: 1, z: 0 } }[wallName];
    const wallPos = await appGZ2.page.evaluate((sid) => window.__threeTestEdit.posOf(sid), eyeLevelWallId);
    const standoff = 2.5;
    await appGZ2.page.evaluate(({ x, z, yaw }) => window.__threeTestEdit.teleport(x, z, yaw), {
      x: wallPos.x - outNormal.x * standoff,
      z: wallPos.z - outNormal.z * standoff,
      yaw: Math.atan2(-outNormal.x, -outNormal.z),
    });
    await appGZ2.page.waitForTimeout(400);   // let the tilt/lift/pitch easing re-settle at the new (still level, wall-excluded) pose
    const axes = await appGZ2.page.evaluate(() => window.__threeTestEdit.gizmoAxes());
    const expectedAxis = axisForWallId(eyeLevelWallId);
    assert(JSON.stringify([...axes].sort()) === JSON.stringify([expectedAxis, 'up'].sort()),
      `expected an eye-level wall prop to show its own along-wall axis (${expectedAxis}) plus up, got ${JSON.stringify(axes)}`);
    ok('translate gizmo: an eye-level wall prop shows exactly one horizontal (along-wall) arrow plus up');
  } catch(e){ bad('translate gizmo: arrow set for an eye-level wall prop', e); }

  // 11j. ArrowRight still nudges the wall prop along the wall (dOffset) --
  //      the real keyboard path nudgeSelected's 'wall' branch always had,
  //      exercised here since nothing else in the suite happened to. Height
  //      stays fixed (no key pressed for it).
  try {
    const before = await appGZ2.page.evaluate((sid) => window.__threeTestEdit.posOf(sid), eyeLevelWallId);
    await appGZ2.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })));
    await appGZ2.page.waitForTimeout(80);
    const after = await appGZ2.page.evaluate((sid) => window.__threeTestEdit.posOf(sid), eyeLevelWallId);
    const moved = axisForWallId(eyeLevelWallId) === 'x' ? Math.abs(after.x - before.x) : Math.abs(after.z - before.z);
    assert(moved > 0.05, `expected ArrowRight to nudge the wall prop along the wall, got ${JSON.stringify({before, after})}`);
    assert(Math.abs(after.y - before.y) < 0.02, `expected ArrowRight to leave the wall prop's height unchanged, got dy=${after.y - before.y}`);
    ok('translate gizmo: ArrowRight still nudges an eye-level wall prop along the wall (dOffset)');
  } catch(e){ bad('translate gizmo: keyboard nudge on an eye-level wall prop', e); }

  // 11k. Dragging the wall prop's "up" arrow raises it, horizontal position
  //      unchanged -- always non-degenerate regardless of which wall this
  //      is on (vertical is orthogonal to every wall's own axis).
  try {
    const before = await appGZ2.page.evaluate((sid) => window.__threeTestEdit.posOf(sid), eyeLevelWallId);
    const pt = await appGZ2.page.evaluate(() => window.__threeTestEdit.gizmoArrowScreenPoint('up'));
    assert(pt, 'expected a screen point for the wall prop\'s "up" gizmo arrow');

    await appGZ2.page.mouse.move(pt.x, pt.y);
    await appGZ2.page.mouse.down();
    await appGZ2.page.mouse.move(pt.x, pt.y - 60, { steps: 6 });
    await appGZ2.page.mouse.up();
    await appGZ2.page.waitForTimeout(100);

    const after = await appGZ2.page.evaluate((sid) => window.__threeTestEdit.posOf(sid), eyeLevelWallId);
    assert(after.y - before.y > 0.1, `expected dragging "up" to raise the wall prop, got dy=${after.y - before.y}`);
    assert(Math.abs(after.x - before.x) < 0.05 && Math.abs(after.z - before.z) < 0.05,
      `expected a vertical drag to leave the wall prop's horizontal position unchanged, got ${JSON.stringify({before, after})}`);
    ok('translate gizmo: dragging a wall prop\'s "up" arrow raises it, horizontal position unchanged');
  } catch(e){ bad('translate gizmo: "up" arrow drag on an eye-level wall prop', e); }

  // 11l. Unlike floor/moveObject/mnemonic/ceiling, selecting a wall prop
  //      does NOT tilt or lift the camera -- facing a wall to select
  //      something on it already keeps its one horizontal arrow
  //      perpendicular to the sightline (see tick()'s own gizmoTiltActive
  //      comment), so the degenerate-edge-on case the tilt exists for
  //      doesn't arise here.
  try {
    const state = await appGZ2.page.evaluate(() => ({ y: window.__threeTestState.y, pitch: window.__threeTestState.pitch }));
    assert(Math.abs(state.y - camBaseline2.y) < 0.05, `expected no camera lift while a wall prop is selected, got ${camBaseline2.y} -> ${state.y}`);
    assert(Math.abs(state.pitch - camBaseline2.pitch) < 0.02, `expected no camera tilt while a wall prop is selected, got ${camBaseline2.pitch} -> ${state.pitch}`);
    ok('translate gizmo: selecting a wall prop does not tilt or lift the camera');
  } catch(e){ bad('translate gizmo: camera stays level for a wall prop', e); }

  // 11m. A "ground" wall prop (floor-standing, back against the wall -- see
  //      lowWallSlots) has its height pinned at 0 and gets NO "up" arrow at
  //      all, just its one along-wall axis.
  try {
    if(groundWallId){
      // deselect the eye-level prop (still selected from 11k/11l) before
      // touching a different slot -- re-targeting it toggles it off.
      await appGZ2.page.evaluate((sid) => window.__threeTestEdit.target({ kind: 'accessory', slotId: sid }), eyeLevelWallId);
      await assignPropA(groundWallId);
      await appGZ2.page.evaluate((sid) => window.__threeTestEdit.target({ kind: 'accessory', slotId: sid }), groundWallId);
      await appGZ2.page.waitForTimeout(200);
      const axes = await appGZ2.page.evaluate(() => window.__threeTestEdit.gizmoAxes());
      const expectedAxis = axisForWallId(groundWallId);
      assert(JSON.stringify([...axes].sort()) === JSON.stringify([expectedAxis]),
        `expected a ground wall prop to show only its along-wall axis (${expectedAxis}), no up, got ${JSON.stringify(axes)}`);
      ok('translate gizmo: a ground (floor-standing) wall prop shows only its along-wall axis, no up');
    } else {
      ok('translate gizmo: ground wall prop test skipped (no wl-* slot in this room\'s door layout)');
    }
  } catch(e){ bad('translate gizmo: arrow set for a ground wall prop', e); }

  // 11n. The "Solo" castle's own root (forks 3 ways from move 1, no
  //      preceding forced chain -- neither a 'corridor' run nor a clean
  //      two-track, see its own seed comment above) gets no floor chain at
  //      all on a full build; nudging a move-object there must not
  //      spuriously conjure one into the live scene either. Reported bug:
  //      rebuildMoveObjectChainLive (the live-nudge path) never checked
  //      castleSign.type the way buildRoom's full build does, so any
  //      move-object edit in a non-corridor/non-two-track room briefly grew
  //      a chain that vanished again only on the next full rebuild (e.g.
  //      leaving edit mode).
  try {
    const soloRoomKey = await appGZ2.page.evaluate(() => {
      const c = new Chess(); for(const m of ['d4','d5','c4']) c.move(m,{sloppy:true});
      return 'cas:L1_Solo:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
    });
    await appGZ2.page.evaluate((k) => window.__threeTestEdit.enter(k), soloRoomKey);
    await appGZ2.page.waitForTimeout(200);

    const before = await appGZ2.page.evaluate(() =>
      window.__threeTestEdit.scan().some(o => o.kind === 'moveObjectChainGroup'));
    assert(!before, 'test setup issue: expected no chain in this non-corridor, non-two-track room before any edit');

    const slotIds = await appGZ2.page.evaluate((k) => window.__threeTestEdit.moveObjectSlotIds(k), soloRoomKey);
    const slotId = slotIds.find(id => id !== 'obj-C1') || slotIds[0];
    assert(slotId, 'test setup issue: expected at least one move-object slot in the Solo room');
    await assignPropA(slotId);
    await appGZ2.page.evaluate((sid) => window.__threeTestEdit.target({ kind: 'accessory', slotId: sid }), slotId);
    await appGZ2.page.waitForTimeout(150);
    await appGZ2.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })));
    await appGZ2.page.waitForTimeout(80);

    const after = await appGZ2.page.evaluate(() =>
      window.__threeTestEdit.scan().some(o => o.kind === 'moveObjectChainGroup'));
    assert(!after, 'expected nudging a move-object in a non-corridor, non-two-track room to NOT spawn a floor chain');
    ok('memorization-aid: nudging a move-object in a non-corridor, non-two-track room does not spuriously add a chain');
  } catch(e){ bad('memorization-aid: no spurious chain outside corridor/two-track rooms', e); }
} finally {
  await appGZ2.close();
}
} catch(e){ bad('Phase F2: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase G: mnemonic quiz "Restrict to Opening Coverage" scoped to a castle ---
if(shouldRunPhase(['quiz'])){
try {
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
  }, { defaultPlayerColor: 'white' });

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

} catch(e){ bad('Phase G: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase H: the VR mini board and the room-info mini board render identical,
//     real piece artwork (same cm-chessboard sprite as the main analysis boards) ---
if(shouldRunPhase(['digraph', 'vr-ui'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase H: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase I: graph node layout (manual de-overlap dragging) persists ---
if(shouldRunPhase(['digraph'])){
try {
const app9 = await launchApp();
try {
  await seedBackup(app9.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
      { seq: ['d4','Nf6','c4'], reply: 'e6' },
    ]}],
    games: [{ id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase I: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase J: surface color picker (flat color as an alternative to an image asset) ---
if(shouldRunPhase(['assets'])){
try {
const app10 = await launchApp();
try {
  await seedBackup(app10.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase J: uncaught error outside a numbered test (setup or otherwise)', e); }
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
try {
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
    }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad("phase @ line 1005 (tags: ['quiz'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase L: outdoor world (Main Street) sizing never strands a castle
//     outside the grass ---
if(shouldRunPhase(['vr-castle'])){
try {
const app12 = await launchApp();
try {
  await seedBackup(app12.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase L: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase M: tint-at-assign-time (per-placement recolor of an assigned
//     asset, distinct from the flat "Color…" replace) ---
if(shouldRunPhase(['assets'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase M: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase N: multi-line ("MultiPV") engine eval saved per node ---
// Stockfish has no vendored mock in this harness (same class of gap as
// cm-chessboard), so a live search can't be driven end-to-end here -- the
// save/display logic this feature added is plain data manipulation,
// independent of the engine, and fully testable via __evalTestHooks against
// a throwaway pref bag instead of real PREFS/IDB.
if(shouldRunPhase(['engine'])){
try {
const app14 = await launchApp();
try {
  await seedBackup(app14.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad("phase @ line 1336 (tags: ['engine'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase O: Chessboard test setup fields (Number of Questions / Max Depth /
//     Opening Coverage) persist to localStorage and restore next time ---
if(shouldRunPhase(['quiz'])){
try {
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

} catch(e){ bad('Phase O: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase P: background analysis queue ("Add to Analysis List" / "Analysis
//     Queue") -- add/dedup, cancel, and the depth-gated direct-IDB-write save
//     path are plain data manipulation against real IDB (unlike the eval
//     feature above, no engine search is involved in any of this), so they're
//     fully testable via __aqTestHooks. Only the live engine.analyze() call
//     inside processAnalysisQueueLoop needs real Stockfish and stays outside
//     this harness's reach -- covered by manual verification instead. ---
if(shouldRunPhase(['analysis-queue'])){
try {
const app16 = await launchApp();
try {
  await seedBackup(app16.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6','c4'], eval: { type:'cp', value:60, depth:20, pv:'1.d4 Nf6 2.c4' } },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad("phase @ line 1591 (tags: ['analysis-queue'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase Q: Manage Mnemonics with no system selected treats every
//     square+piece as "needed" (as if a hypothetical system used every move
//     mnemonic), so the missing counts and red/green coloring show up
//     globally instead of only when a real coverage scope is picked. ---
if(shouldRunPhase(['mnemonics'])){
try {
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

} catch(e){ bad('Phase Q: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase R: "Analyze All Children" now queues every child for background
//     analysis (same Depth/Lines modal as "Add to Analysis Queue") instead of
//     running an instant in-page search. ---
if(shouldRunPhase(['analysis-queue'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase R: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase S: "Search for a Variation" -- a not-found result pops up a
//     clear "Variation not found" alert (in addition to the existing inline
//     modal text) instead of silently doing nothing, and never touches the
//     tree/focus state. ---
if(shouldRunPhase(['move-table'])){
try {
const app19 = await launchApp();
try {
  await seedBackup(app19.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase S: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase S2: the move table's own "Show Castle" dropdown (next to Expand
//     All) -- the common "find a castle by name, then look for unfilled
//     sub-branches" workflow as a single select, instead of hunting through
//     the tree for the right row's three-dot menu. Mirrors the digraph's own
//     dropdown (Phase BM), including the adjunct: focusing the old-fashioned
//     way (a row's own "Focus on this Variation") is detected and reflected
//     back into the dropdown automatically -- for a castle root AND for a
//     named room, each of which resolve to their own option value. ---
if(shouldRunPhase(['move-table'])){
try {
const appS2 = await launchApp();
try {
  // same minimal two-castle fixture as Phase BM's digraph test: Alpha (a
  // leaf root, one opponent reply) and Beta (a genuine branch: two distinct
  // opponent replies, e6/c6, so its own root row can't corridor-collapse
  // away) on two different first moves off d4, so focusing one leaves the
  // other's root row genuinely present and hideable elsewhere in the tree.
  // Beta's own e6 child is additionally named "Vault" -- a room with a name
  // but no isCastleRoot of its own, the case the dropdown's room-listing is
  // for; its sibling c6 stays deliberately unnamed as the true-negative case.
  await seedBackup(appS2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','d5'], reply: 'c4', isCastleRoot: true, castleName: 'Beta', castleStreetNumber: 2 },
      { seq: ['d4','d5','c4','e6'], reply: 'Nc3', name: 'Vault' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 d5 c4 e6 Nc3 Nf6', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 d5 c4 c6', white: 'a', black: 'b', result: '*' },
    ],
  }, { defaultPlayerColor: 'white' });
  await appS2.page.click('.line-row');
  await appS2.page.waitForSelector('.data-row', { timeout: 10000 });

  // 56a. Named rooms are loaded LAZILY: right after the line opens (a real
  //      tree render, exactly like an import triggers), the dropdown already
  //      shows its castle-only skeleton (cheap -- no graph analysis needed
  //      to just list castle names) but has NOT yet paid for enumerating any
  //      castle's own rooms (buildGeneratedCastle) -- that only happens once
  //      the dropdown is actually about to be opened (focus/mousedown), so a
  //      tree re-render never pays for a room listing nobody's looking at.
  try {
    const beforeFocus = await appS2.page.evaluate(() => ({
      visible: getComputedStyle(document.getElementById('tableCastleWrap')).display !== 'none',
      castleValues: [...document.getElementById('tableCastleSelect').options].map(o => o.value),
      roomOptionCount: document.querySelectorAll('#tableCastleSelect option[value^="room:"]').length,
    }));
    assert(beforeFocus.visible, 'expected the dropdown visible as soon as castles are defined, before any room analysis');
    assert(JSON.stringify(beforeFocus.castleValues) === JSON.stringify(['', 'castle:Alpha', 'castle:Beta']),
      `expected the castle-only skeleton (no rooms yet), got ${JSON.stringify(beforeFocus.castleValues)}`);
    assert(beforeFocus.roomOptionCount === 0, `expected no room options before the dropdown is opened, got ${beforeFocus.roomOptionCount}`);
    ok('move table: "Show Castle" shows castles immediately but defers named-room enumeration until opened');
  } catch(e){ bad('move table: "Show Castle" named rooms load lazily, not on every render', e); }

  // named rooms are loaded lazily -- computing them (buildGeneratedCastle per
  // castle) is real graph analysis, expensive enough that doing it on every
  // tree render (every import, every compact/visibility toggle) measurably
  // slowed the whole app down for a dropdown opened far less often than that.
  // See loadTableCastleRooms: it only runs once this select is actually
  // about to be opened (focus/mousedown), so tests that inspect or pick a
  // named room need to focus it first, exactly like a real user would by
  // clicking it open.
  await appS2.page.evaluate(() => document.getElementById('tableCastleSelect').focus());

  // 56b. The dropdown appears once castles are defined: each castle is its
  //      own <optgroup> (so its rooms render indented, for free, under a
  //      bold, non-selectable header), with a "(whole castle)" entry plus
  //      any of its NAMED rooms -- Alpha has none, Beta has "Vault".
  try {
    const info = await appS2.page.evaluate(() => {
      const sel = document.getElementById('tableCastleSelect');
      return {
        visible: getComputedStyle(document.getElementById('tableCastleWrap')).display !== 'none',
        values: [...sel.options].map(o => o.value),
        groupLabels: [...sel.querySelectorAll('optgroup')].map(g => g.label),
        vaultText: sel.querySelector('option[value="room:0"]')?.textContent,
        vaultGroup: sel.querySelector('option[value="room:0"]')?.closest('optgroup')?.label,
      };
    });
    assert(info.visible, 'expected the "Show Castle" dropdown to be visible once castles are defined');
    assert(JSON.stringify(info.values) === JSON.stringify(['', 'castle:Alpha', 'castle:Beta', 'room:0']),
      `expected All, Alpha's (whole castle), Beta's (whole castle), then Beta's "Vault" room, got ${JSON.stringify(info.values)}`);
    assert(JSON.stringify(info.groupLabels) === JSON.stringify(['Alpha', 'Beta']),
      `expected one optgroup per castle, got ${JSON.stringify(info.groupLabels)}`);
    assert(info.vaultText === 'Vault', `expected the named room's option text to be "Vault", got ${JSON.stringify(info.vaultText)}`);
    assert(info.vaultGroup === 'Beta', `expected "Vault" nested under Beta's own optgroup, got ${JSON.stringify(info.vaultGroup)}`);
    ok('move table: "Show Castle" dropdown groups each castle in an optgroup, with its named rooms indented underneath');
  } catch(e){ bad('move table: "Show Castle" dropdown presence/options', e); }

  // 56c. Picking a castle focuses the tree on it exactly like the row-level
  //      "Focus on this Variation" would -- Unfocus appears, and the OTHER
  //      castle's own root row is hidden as a sibling branch.
  try {
    await appS2.page.selectOption('#tableCastleSelect', 'castle:Alpha');
    await appS2.page.waitForTimeout(50);
    const state = await appS2.page.evaluate(() => ({
      unfocusShown: document.getElementById('unfocusBtn').style.display !== 'none',
      betaHidden: document.querySelector('tr.data-row[data-seq="d4,d5"]').classList.contains('focus-hidden'),
    }));
    assert(state.unfocusShown, 'expected picking a castle to engage focus (Unfocus button shown)');
    assert(state.betaHidden, 'expected Beta\'s own root row to be hidden as a sibling branch while Alpha is focused');
    ok('move table: picking a castle from the dropdown focuses the tree on it, hiding sibling branches');
  } catch(e){ bad('move table: "Show Castle" selection engages real focus', e); }

  // 56d. Picking "All" clears focus again.
  try {
    await appS2.page.selectOption('#tableCastleSelect', '');
    await appS2.page.waitForTimeout(50);
    const state = await appS2.page.evaluate(() => ({
      unfocusShown: document.getElementById('unfocusBtn').style.display !== 'none',
      betaHidden: document.querySelector('tr.data-row[data-seq="d4,d5"]').classList.contains('focus-hidden'),
    }));
    assert(!state.unfocusShown, 'expected "All" to clear focus (Unfocus button hidden)');
    assert(!state.betaHidden, 'expected Beta\'s root row to be visible again once focus is cleared');
    ok('move table: "Show Castle" → All clears focus');
  } catch(e){ bad('move table: "Show Castle" → All clears focus', e); }

  // 56e. Picking a named ROOM (not a whole castle) focuses the tree on that
  //      room's own row -- hiding both its inner sibling (c6, Beta's other
  //      branch) and its outer sibling (Alpha's own root, "d4,Nf6") exactly
  //      like focusing any other row would.
  try {
    await appS2.page.selectOption('#tableCastleSelect', 'room:0');
    await appS2.page.waitForTimeout(50);
    const state = await appS2.page.evaluate(() => ({
      unfocusShown: document.getElementById('unfocusBtn').style.display !== 'none',
      c6Hidden: document.querySelector('tr.data-row[data-seq="d4,d5,c4,c6"]').classList.contains('focus-hidden'),
      alphaHidden: document.querySelector('tr.data-row[data-seq="d4,Nf6"]').classList.contains('focus-hidden'),
    }));
    assert(state.unfocusShown, 'expected picking a named room to engage focus (Unfocus button shown)');
    assert(state.c6Hidden, 'expected Vault\'s own sibling (c6) to be hidden while Vault is focused');
    assert(state.alphaHidden, 'expected Alpha\'s root row (an outer sibling) to be hidden while Vault is focused');
    ok('move table: picking a named room from the dropdown focuses the tree on it, same as any other row');
    await appS2.page.evaluate(() => document.getElementById('unfocusBtn').click());
  } catch(e){ bad('move table: "Show Castle" named-room selection engages real focus', e); }

  // 56f. Adjunct: focusing the OLD way (a row's own three-dot "Focus on this
  //      Variation") is detected automatically and reflected back into the
  //      dropdown -- no need to also use the dropdown for it to notice --
  //      for a castle root AND, separately, for a named (non-root) room.
  try {
    await appS2.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appS2.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="focus"]').click());
    const castleValue = await appS2.page.evaluate(() => document.getElementById('tableCastleSelect').value);
    assert(castleValue === 'castle:Alpha', `expected focusing Alpha's root row the old way to auto-select it, got ${JSON.stringify(castleValue)}`);

    await appS2.page.evaluate(() => document.getElementById('unfocusBtn').click());
    await appS2.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,d5,c4,e6"] .rowMenuBtn').click());
    await appS2.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,d5,c4,e6"] [data-act="focus"]').click());
    const roomValue = await appS2.page.evaluate(() => document.getElementById('tableCastleSelect').value);
    assert(roomValue === 'room:0', `expected focusing the "Vault" row the old way to auto-select it (room:0), got ${JSON.stringify(roomValue)}`);
    ok('move table: focusing a castle root OR a named room the old-fashioned way (row menu) auto-selects it in "Show Castle"');
  } catch(e){ bad('move table: old-fashioned row-menu focus syncs the dropdown (castle and room)', e); }

  // 56g. Focusing a row that is neither a castle root nor a named room (c6,
  //      Vault's own unnamed sibling) leaves the dropdown on "All" -- it
  //      only ever reflects a genuine castle/room match, not focus in general.
  try {
    await appS2.page.evaluate(() => document.getElementById('unfocusBtn').click());
    await appS2.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,d5,c4,c6"] .rowMenuBtn').click());
    await appS2.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,d5,c4,c6"] [data-act="focus"]').click());
    const state = await appS2.page.evaluate(() => ({
      unfocusShown: document.getElementById('unfocusBtn').style.display !== 'none',
      value: document.getElementById('tableCastleSelect').value,
    }));
    assert(state.unfocusShown, 'setup: expected the row-menu focus to have engaged');
    assert(state.value === '', `expected the dropdown to stay on "All" for an unnamed, non-castle-root focus, got ${JSON.stringify(state.value)}`);
    ok('move table: focusing an unnamed, non-castle-root row leaves "Show Castle" on All');
  } catch(e){ bad('move table: non-castle, unnamed focus does not falsely select an option', e); }
} finally {
  await appS2.close();
}
} catch(e){ bad('Phase S2: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase T: cancelling the CURRENTLY PROCESSING analysis-queue item must
//     stop its in-flight search immediately and move straight on to the next
//     item -- not stall the whole queue waiting for the abandoned search to
//     reach its full target depth on its own. No live Stockfish is available
//     in this harness, so engine.analyze()/stop() are monkey-patched with a
//     controllable fake (via __aqTestHooks.engine) that only resolves when
//     stop() is called, driving the real scheduler/cancel logic against it. ---
if(shouldRunPhase(['analysis-queue'])){
try {
const app20 = await launchApp();
try {
  await seedBackup(app20.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad("phase @ line 1952 (tags: ['analysis-queue'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase U: move-pair VR billboards show the move number ("N."), flush
//     left and a third of the way up from the bottom of whichever quadrant
//     is White's move; the street-sign opening-move tile (always White's
//     move 1) gets the same badge. ---
if(shouldRunPhase(['vr-decorating'])){
try {
const app21 = await launchApp();
try {
  await seedBackup(app21.page, {
    version: 6, user: 'tester',
    lines: [
      { id: 'L1', name: 'London', color: 'white', openingMoves: ['d4'], prefs: [] },
      { id: 'B1', name: 'Sicilian', color: 'black', openingMoves: ['e4'], prefs: [{ seq: ['e4'], reply: 'c5' }] },
      { id: 'B2', name: 'Undecided', color: 'black', openingMoves: ['d4'], prefs: [] },
    ],
  }, { defaultPlayerColor: 'white' });
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

  // 61. A Black system's street tile shows the door-style opponent/response
  //     PAIR composite (White's trigger + our prepared reply diagonally
  //     below it), not the plain single-move tile -- proven by the canvas
  //     itself: a plain tile is always a 512x512 square (buildOpeningMoveSprite's
  //     fixed px), while the pair composite is 768x768 (MNEM_PAIR_SIZE, no
  //     occurrence strip on a street tile) -- and the "1." badge still lands
  //     in the opponent (White) quadrant's corner, same as a door pair's own.
  try {
    const size = await app21.page.evaluate(() => window.__threeTestEdit.spriteCanvasSize('open-B1'));
    assert(size && size.width === 768 && size.height === 768,
      `expected the 768x768 pair-composite canvas, got ${JSON.stringify(size)}`);
    const oppBadge = await app21.page.evaluate(() => window.__threeTestEdit.spriteHasWhiteInk('open-B1', 14, 300, 110, 70, 'dark'));
    assert(oppBadge === true, `expected the "1." badge in the opponent (White) quadrant, got ${oppBadge}`);
    ok('Black system street tile: shows the opponent/response pair composite when a reply is prepared');
  } catch(e){ bad('VR billboard: Black system street tile shows the reply pair', e); }

  // 62. A Black system with NO reply configured yet falls back to the same
  //     plain single-move tile a White system uses (just the opponent's
  //     trigger move) -- the pair composite only replaces it once there's
  //     something real to pair it with.
  try {
    const size = await app21.page.evaluate(() => window.__threeTestEdit.spriteCanvasSize('open-B2'));
    assert(size && size.width === 512 && size.height === 512,
      `expected the plain 512x512 single tile with no reply configured, got ${JSON.stringify(size)}`);
    ok('Black system street tile: stays a plain single tile until a reply is configured');
  } catch(e){ bad('VR billboard: Black system street tile without a reply', e); }
} finally {
  await app21.close();
}

} catch(e){ bad('Phase U: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase V0: the empty ceiling slot's marker (the "click here to add a
//     chandelier/skylight" target) is generously sized so it's visible
//     without tilting the camera all the way up, especially in a small/low
//     room -- the reported bug: on a small room it was too small to notice
//     was there at all. ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appV0 = await launchApp();
try {
  await seedBackup(appV0.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
  }, { defaultPlayerColor: 'white' });
  await openVR(appV0.page);
  // roomB is the built-in demo house's smallest room (4x4x3, also the
  // elevator car for start's north exit) -- exactly the "small room" shape
  // the reported bug was about.
  await appV0.page.evaluate(() => window.__threeTestEdit.enter('roomB'));
  await appV0.page.waitForTimeout(150);
  await appV0.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
  await appV0.page.waitForTimeout(60);

  // 160. The marker is a CircleGeometry tripled from its original 0.5 radius.
  try {
    const marker = await appV0.page.evaluate(() =>
      window.__threeTestEdit.meshes().find(m => m.kind === 'slot' && m.slotId === 'ceil-c'));
    assert(marker, 'expected a ceiling slot marker mesh in edit mode (test setup issue if not found)');
    assert(marker.type === 'CircleGeometry', `expected the ceiling marker to be a CircleGeometry, got ${marker.type}`);
    assert(marker.params.radius === 1.5, `expected the ceiling marker radius tripled to 1.5, got ${marker.params.radius}`);
    ok('VR edit mode: the empty ceiling slot marker is tripled in size for visibility');
  } catch(e){ bad('VR edit mode: ceiling slot marker size', e); }
} finally {
  await appV0.close();
}
} catch(e){ bad('Phase V0: uncaught error outside a numbered test (setup or otherwise)', e); }
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
try {
const app22 = await launchApp();
try {
  await seedBackup(app22.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad("phase @ line 2159 (tags: ['engine'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase VA: analysis queue drag-to-reorder -- index 0 (the item
//     currently being, or about to be, searched) can never be dragged, nor
//     be a valid drop target (the lowest anything else can land is index 1),
//     matching "never waste in-progress work". Most of this is plain
//     array/IDB manipulation, same as Phase T's cancel/resume tests; one
//     test drives a real pointer drag to check the visual drop-indicator
//     feedback too. ---
if(shouldRunPhase(['analysis-queue'])){
try {
const app23 = await launchApp();
try {
  await seedBackup(app23.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
  await app23.page.click('.line-row');
  await app23.page.waitForSelector('.data-row', { timeout: 10000 });

  const seqs = [['d4','Nf6'], ['d4','d5'], ['d4','c5'], ['d4','e5']];
  for(const seq of seqs){
    await app23.page.evaluate((s) => window.__aqTestHooks.addToAnalysisQueue('L1', s, 30, 2), seq);
  }
  await app23.page.evaluate(() => document.getElementById('menuAnalysisQueue').click());
  await app23.page.waitForSelector('#analysisQueueOverlay', { state: 'visible', timeout: 5000 });

  // 64. Row 0 (the processing item) has no grab handle -- it can never be
  //     dragged. Every other row does.
  try {
    const grabs = await app23.page.evaluate(() => [...document.querySelectorAll('#analysisQueueBody tr')].map(tr => !!tr.querySelector('.aq-grab')));
    assert(JSON.stringify(grabs) === JSON.stringify([false, true, true, true]),
      `expected a grab handle on every row except index 0, got ${JSON.stringify(grabs)}`);
    ok('analysis queue: drag handle is hidden on index 0 (the processing item), shown on every other row');
  } catch(e){ bad('analysis queue: grab handle visibility', e); }

  // 65. reorderAnalysisQueue moves an item to an arbitrary target index and
  //     persists it -- the new order survives a reload from IDB, proving it
  //     was actually written, not just spliced in memory -- and a target
  //     below 1 clamps there instead of reaching (or displacing) index 0.
  try {
    const idAt = (i) => app23.page.evaluate((i) => window.__aqTestHooks.getQueue()[i].id, i);
    // queue starts ['d4,Nf6','d4,d5','d4,c5','d4,e5']; drag the last item
    // (d4,e5, index 3) to land right after index 0.
    await app23.page.evaluate((id) => window.__aqTestHooks.reorderAnalysisQueue(id, 1), await idAt(3));
    const order1 = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    assert(JSON.stringify(order1) === JSON.stringify(['d4,Nf6','d4,e5','d4,d5','d4,c5']),
      `expected d4,e5 moved to index 1, index 0 untouched, got ${JSON.stringify(order1)}`);

    // a target of 0 (or anything below 1) clamps to 1 -- it can never land
    // before, or swap with, index 0.
    await app23.page.evaluate((id) => window.__aqTestHooks.reorderAnalysisQueue(id, 0), await idAt(2));
    const order2 = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    assert(order2[0] === 'd4,Nf6', `expected index 0 to stay put even when the drop target clamps to 1, got ${JSON.stringify(order2)}`);

    // reload straight from IDB (bypassing the in-memory ANALYSIS_QUEUE array
    // entirely) -- confirms reorderAnalysisQueue's renumbered `order` fields
    // actually persisted for every item, not just the moved one.
    await app23.page.evaluate(() => window.__aqTestHooks.refreshAnalysisQueue());
    const order3 = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    assert(JSON.stringify(order3) === JSON.stringify(order2), `expected the reordered queue to survive a reload from IDB, got ${JSON.stringify(order3)}`);
    ok('analysis queue: reorderAnalysisQueue persists to IDB and clamps its target to index 1');
  } catch(e){ bad('analysis queue: reorderAnalysisQueue persists and respects the floor', e); }

  // 66. reorderAnalysisQueue is a safe no-op for index 0 regardless of
  //     target, and for dropping an item back at its own current index.
  try {
    const before = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    const id0 = await app23.page.evaluate(() => window.__aqTestHooks.getQueue()[0].id);
    await app23.page.evaluate((id) => window.__aqTestHooks.reorderAnalysisQueue(id, 3), id0);
    const id2 = await app23.page.evaluate(() => window.__aqTestHooks.getQueue()[2].id);
    await app23.page.evaluate((id) => window.__aqTestHooks.reorderAnalysisQueue(id, 2), id2);
    const after = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().map(it => it.seq.join(',')));
    assert(JSON.stringify(after) === JSON.stringify(before),
      `expected moving index 0 or dropping an item at its own current index to be a no-op, got ${JSON.stringify(after)} (was ${JSON.stringify(before)})`);
    ok('analysis queue: reorderAnalysisQueue is a safe no-op for index 0 and a same-index drop');
  } catch(e){ bad('analysis queue: reorder no-op safety', e); }

  // 67. A real pointer drag (mouse down on the grab handle, move, mouse up)
  //     shows the drop-indicator bar and dims the dragged row while held,
  //     then commits the move and clears both on release -- checks the
  //     actual DnD interaction end to end, not just the underlying
  //     reorderAnalysisQueue call the handlers above already cover.
  try {
    // queue is currently ['d4,Nf6','d4,d5','d4,e5','d4,c5'] (from test 65/66).
    const grabPoint = await app23.page.evaluate(() => {
      const grab = document.querySelectorAll('#analysisQueueBody tr')[1].querySelector('.aq-grab');
      const r = grab.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const dropY = await app23.page.evaluate(() => {
      const r = document.querySelectorAll('#analysisQueueBody tr')[3].getBoundingClientRect();
      return r.bottom - 2;   // past the last row's midpoint -- drop at the end
    });

    await app23.page.mouse.move(grabPoint.x, grabPoint.y);
    await app23.page.mouse.down();
    await app23.page.mouse.move(grabPoint.x, dropY, { steps: 5 });

    const duringDrag = await app23.page.evaluate(() => ({
      indicatorPresent: !!document.querySelector('.aq-drop-indicator'),
      draggedRowDimmed: !!document.querySelector('#analysisQueueBody tr.aq-dragging'),
    }));
    assert(duringDrag.indicatorPresent, 'expected the drop-indicator bar to appear while dragging');
    assert(duringDrag.draggedRowDimmed, 'expected the dragged row to be visually dimmed while dragging');

    await app23.page.mouse.up();
    // the actual splice/renumber/persist/re-render in reorderAnalysisQueue
    // happens after an IDB write, asynchronously past pointerup itself --
    // wait for it rather than assuming it's already settled by the time the
    // next evaluate() round-trips.
    await app23.page.waitForFunction(
      () => window.__aqTestHooks.getQueue()[3]?.seq.join(',') === 'd4,d5',
      { timeout: 5000 }
    );

    const after = await app23.page.evaluate(() => ({
      order: window.__aqTestHooks.getQueue().map(it => it.seq.join(',')),
      indicatorGone: !document.querySelector('.aq-drop-indicator'),
      noneDimmed: !document.querySelector('#analysisQueueBody tr.aq-dragging'),
    }));
    assert(JSON.stringify(after.order) === JSON.stringify(['d4,Nf6','d4,e5','d4,c5','d4,d5']),
      `expected d4,d5 dragged from index 1 to the end, got ${JSON.stringify(after.order)}`);
    assert(after.indicatorGone, 'expected the drop-indicator bar to be removed after releasing');
    assert(after.noneDimmed, 'expected no row to still be dimmed after releasing');
    ok('analysis queue: a real pointer drag shows the drop-indicator bar and commits the move on release');
  } catch(e){ bad('analysis queue: pointer-drag end to end', e); }

  // 69. Deleting a repertoire line also drops any of ITS rows from the
  //     analysis queue store -- not just the in-memory ANALYSIS_QUEUE mirror.
  //     Confirmed by reloading straight from IDB via refreshAnalysisQueue(),
  //     which bypasses the delete handler's own in-memory prune entirely, so
  //     a leftover row would only show up after this reload.
  try {
    await app23.page.evaluate(() => document.getElementById('analysisQueueCloseBtn').click());
    await app23.page.evaluate(() => document.getElementById('backBtn').click());
    await app23.page.waitForSelector('.line-row', { timeout: 10000 });

    const beforeCount = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().length);
    assert(beforeCount > 0, `expected the queue seeded earlier in this phase to still be non-empty before deleting its line, got ${beforeCount}`);

    // .line-delete is an icon-only button (Font Awesome glyph, unloaded in
    // this offline harness) that Playwright's strict actionability check
    // can treat as zero-size/"not visible" -- dispatch the click directly,
    // same as the backBtn/analysisQueueCloseBtn calls just above. The
    // harness's global dialog listener still auto-accepts the confirm().
    await app23.page.evaluate(() => document.querySelector('.line-delete').click());
    await app23.page.waitForSelector('.line-row', { state: 'detached', timeout: 10000 });

    const afterMemory = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().length);
    assert(afterMemory === 0, `expected deleting the only line to prune every one of its items from the in-memory queue mirror, got ${afterMemory} left`);

    await app23.page.evaluate(() => window.__aqTestHooks.refreshAnalysisQueue());
    const afterReload = await app23.page.evaluate(() => window.__aqTestHooks.getQueue().length);
    assert(afterReload === 0, `expected the deleted line's queue rows to also be gone from IDB (not just the in-memory mirror), got ${afterReload} left after reloading from IDB`);
    ok('deleting a line also drops its rows from the analysis queue store, not just the in-memory mirror');
  } catch(e){ bad('analysis queue: deleteLine purges matching queue rows from IDB', e); }

  // 70. updateLine resolves `false` (a detectable no-op) instead of silently
  //     resolving as if it had succeeded, when `id` no longer matches any
  //     stored line -- L1 was just deleted by test 69.
  try {
    const result = await app23.page.evaluate(() => window.__linesTestHooks.updateLine('L1', {name:'should not stick'}));
    assert(result === false, `expected updateLine on a deleted line id to resolve false, got ${result}`);
    ok('updateLine resolves false (not a silent no-op success) when the target line id no longer exists');
  } catch(e){ bad('updateLine: false on a nonexistent id', e); }
} finally {
  await app23.close();
}

} catch(e){ bad("phase @ line 2248 (tags: ['analysis-queue'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase VB: the live engine panel's thread-count selector
//     (populateEngineThreadsSelect) -- hidden on a single-threaded engine
//     (this harness's real state, since no live Stockfish is available),
//     populated 1..maxThreads on a multi-threaded one, and restores a saved
//     choice only when it's still in range on the current "hardware". No
//     live Stockfish needed -- engine.multithreaded/.maxThreads/.threads are
//     monkey-patched directly, same pattern as Phase V/VA. ---
if(shouldRunPhase(['engine'])){
try {
const app24 = await launchApp();
try {
  await seedBackup(app24.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad("phase @ line 2388 (tags: ['engine'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase VD: the Analysis Queue modal's OWN thread-count selector --
//     independent of the live engine panel's, hidden/populated the same way
//     (shared populateThreadsSelect), and actually reaches
//     processAnalysisQueueLoop's engine.analyze() call without ever
//     restarting whatever item is currently mid-search. ---
if(shouldRunPhase(['analysis-queue'])){
try {
const app25 = await launchApp();
try {
  await seedBackup(app25.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase VD: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase W: room-info modal (click a graph node) -- move-number badge on
//     the exit rows' thumbnails, and the exits list scrolls independently so
//     a long list of replies can never push the Close button off-screen. ---
if(shouldRunPhase(['digraph'])){
try {
const appW1 = await launchApp();
try {
  await seedBackup(appW1.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
    mnemonics: [{ square: 'f6', knight: 'foxtrot', knightImg: 'data:image/png;base64,iVBORw0KGgo=' }],
  }, { defaultPlayerColor: 'white' });
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
  }, { defaultPlayerColor: 'black' });
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

} catch(e){ bad('Phase W: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase X: door skin oversizing -- every door renders slightly larger
//     than its opening (hides a non-rectangular asset's transparent margin
//     from showing the wall behind it), and a per-asset "extra oversize %"
//     adds on top of that baseline. ---
if(shouldRunPhase(['vr-decorating'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase X: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase Y: "memorized" room toggle (VR toolbar icon) -- hidden outside
//     real castle rooms, persisted to IDB per room, survives a full reload. ---
if(shouldRunPhase(['vr-castle'])){
try {
const appY = await launchApp();
try {
  const keys = await appY.page.evaluate(() => {
    const pk = mv => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_'); };
    return { alpha: pk(['d4','Nf6','c4']) };
  });
  await seedBackup(appY.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase Y: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase Z: "memorized" rooms (Phase 2) get a 🧠 label glyph in the
//     network digraph (mirroring the VR toolbar's fa-brain icon), and the
//     thick green border is reserved for "all done" -- memorized AND fully
//     decorated -- so it reads at a glance even too zoomed out for glyphs. ---
if(shouldRunPhase(['digraph'])){
try {
const appZ = await launchApp();
try {
  await seedBackup(appZ.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase Z: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AA: "only test memorized rooms" (Phase 3) -- a castle-scoped quiz
//     session filters candidates down to only replies whose resulting room is
//     marked memorized; off, it's a pure passthrough. ---
if(shouldRunPhase(['quiz'])){
try {
const appAA = await launchApp();
try {
  const keys = await appAA.page.evaluate(() => {
    const pk = mv => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_'); };
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase AA: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AB: crop/erase image editor -- brush erase (freehand round
//     eraser, size slider) for cleaning up artifacts flood-fill can't reach. ---
if(shouldRunPhase(['assets'])){
try {
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

  // 80. Regression: AI-generated "transparent background" exports routinely
  //     carry a faint near-transparent haze across the WHOLE canvas rather
  //     than clean 0 alpha -- at the old AUTO_CROP_ALPHA=0 threshold every
  //     haze pixel counted as content, so the computed bounds were the full
  //     image and Auto-crop did nothing. A haze well under the new 24
  //     threshold must be excluded from the bounds; real (near-opaque)
  //     content must still be picked up correctly.
  try {
    const hazyUrl = await appAB.page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 100; c.height = 100;
      const cx = c.getContext('2d');
      cx.fillStyle = 'rgba(200,150,100,0.03)';    // alpha ~8/255 -- a faint haze reaching every edge
      cx.fillRect(0, 0, 100, 100);
      cx.fillStyle = 'rgba(255,0,0,1)';           // solid content, a 40x40 square at [30,70)
      cx.fillRect(30, 30, 40, 40);
      return c.toDataURL('image/png');
    });
    await appAB.page.evaluate((url) => window.__cropTestHooks.open(url), hazyUrl);
    await appAB.page.waitForFunction(() => {
      const img = document.getElementById('cropImg');
      return img && img.naturalWidth > 0 && document.getElementById('cropOverlay').style.display === 'flex';
    }, { timeout: 5000 });
    await appAB.page.evaluate(() => document.getElementById('cropAutoBtn').click());
    await appAB.page.evaluate(() => document.getElementById('cropSaveBtn').click());
    const result = await appAB.page.evaluate(() => window.__cropTestHooks.result());
    assert(typeof result === 'string' && result.startsWith('data:image/png'), `expected a saved PNG data-URL, got ${JSON.stringify(result)}`);
    const probe = await alphaProbe(result, [[0,0]]);
    assert(probe.w === 40 && probe.h === 40,
      `expected Auto-crop to trim the 100x100 haze down to the 40x40 solid content, got ${probe.w}x${probe.h}`);
    ok('crop editor: Auto-crop excludes a faint whole-canvas haze, finds the real content bounds');
  } catch(e){ bad('crop editor: Auto-crop is not fooled by a near-transparent haze', e); }
} finally {
  await appAB.close();
}

} catch(e){ bad('Phase AB: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AC: "fully decorated" room flag -- computed on the edit-mode-on ->
//     off transition (E key / Esc / toolbar pencil): every move-object slot
//     has a real asset AND every forward door's target room is named. ---
if(shouldRunPhase(['vr-decorating'])){
try {
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
  }, { defaultPlayerColor: 'white' });
  await openVR(appAC.page);
  const roomKey = await appAC.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
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

  // 84. Typing a placeholder label into the per-slot picker clears any prior
  //     asset override (setup for the Remove test below) -- driven through
  //     the real dialog (openPropManager), not a direct LAYOUT poke.
  try {
    await appAC.page.evaluate(({ rk, sid }) => window.__threeTestEdit.openPropManager(rk, sid),
      { rk: roomKey, sid: leftSlots[0] });
    await appAC.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appAC.page.fill('#pickerWordInput', 'StaleTestLabel');
    await appAC.page.click('#pickerWordApplyBtn');
    await appAC.page.waitForFunction(() => document.getElementById('assetPickerOverlay').style.display === 'none', { timeout: 5000 });
    const afterApply = await appAC.page.evaluate((rk) => window.__threeTestEdit.layoutSnapshot()[rk], roomKey);
    assert(afterApply.slotWords && afterApply.slotWords[leftSlots[0]] === 'StaleTestLabel',
      `test setup issue: expected the label override to apply, got ${JSON.stringify(afterApply.slotWords)}`);
    assert(!afterApply.slots || !afterApply.slots[leftSlots[0]],
      'test setup issue: expected the prior asset override cleared by setting a label');
    ok('per-slot picker: typing a placeholder label clears any prior asset override');
  } catch(e){ bad('per-slot picker: label override applies', e); }

  // 85. "Remove" in the per-slot picker must also clear a manual placeholder
  //     label, not just an asset id -- previously setSlotOverride(...,null)
  //     only cleared the word half when SETTING a new asset, never when
  //     REMOVING, so a label-only override could never actually be deleted
  //     (reported live: "deleting the asset" left the stale label showing
  //     forever, through a reload, even after reassigning a wall list).
  try {
    await appAC.page.evaluate(({ rk, sid }) => window.__threeTestEdit.openPropManager(rk, sid),
      { rk: roomKey, sid: leftSlots[0] });
    await appAC.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appAC.page.waitForSelector('#pickerRemoveBtn', { state: 'visible', timeout: 5000 });
    await appAC.page.click('#pickerRemoveBtn');
    await appAC.page.waitForFunction(() => document.getElementById('assetPickerOverlay').style.display === 'none', { timeout: 5000 });
    const afterRemove = await appAC.page.evaluate((rk) => window.__threeTestEdit.layoutSnapshot()[rk], roomKey);
    assert(!afterRemove.slotWords || !afterRemove.slotWords[leftSlots[0]],
      `expected "Remove" to also clear a label-only override, got ${JSON.stringify(afterRemove.slotWords)}`);
    ok('per-slot picker: "Remove" clears a label-only override instead of leaving it stuck forever');
  } catch(e){ bad('per-slot picker: Remove clears a label-only override', e); }
} finally {
  await appAC.close();
}

} catch(e){ bad('Phase AC: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AD: "fully decorated" -- the door-naming half of the check
//     (only for a door whose target is NOT empty/locked -- see isRoomEmpty
//     and the locked-doors feature), and the vacuous-true case. ---
if(shouldRunPhase(['vr-decorating'])){
try {
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
  }, { defaultPlayerColor: 'white' });
  await openVR(appAD.page);
  const keyFor = (moves) => appAD.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
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

} catch(e){ bad('Phase AD: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AD2: "fully decorated" -- a WALL-LIST item's own word/label now
//     counts as filled, same as a manual placeholder label typed straight
//     onto the slot (LAYOUT.slotWords) already did. Previously only a list
//     item with an image asset bound counted, silently blocking "decorated"
//     on any room whose wall lists were assigned but not yet illustrated --
//     reported live: a real two-track room (both lanes wall-listed, one
//     ending in a locked door) that should have read as decorated. ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appAD2 = await launchApp();
try {
  // genuine two-track room: LEFT lane has 2 real chain members (e6,Nc3 then
  // Bb4,Bd2) before its own branch -- one child unbuilt (a6, becomes a
  // LOCKED door: isRoomEmpty) and one built further (O-O e4, an ordinary
  // open door needing its target named). RIGHT lane also has 2 members
  // (d5,Nf3 then c6,Bg5), left as a plain dead end. Matches the reported
  // room shape: a two-lane sequence with a locked door on one side.
  await seedBackup(appAD2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Bd2' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4','Bd2','O-O'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','d5'], reply: 'Nf3' },
      { seq: ['d4','Nf6','c4','d5','Nf3','c6'], reply: 'Bg5' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Bd2 a6', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Bd2 O-O e4', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 Nf6 c4 d5 Nf3 c6 Bg5', white: 'a', black: 'b', result: '*' },
    ],
    // label-only items (assetId: null) -- exactly the "list assigned, but
    // only labeled, no images yet" case reported live.
    objectLists: [
      { id: 'lane_list', name: 'Lane List', roomName: '', category: '',
        orderingType: 'procedural', orderingRule: '',
        items: [{ name: 'First', assetId: null }, { name: 'Second', assetId: null }],
        mnemonic: { type: 'generated_phrase', initialism: '', phrase: '', source: '' } },
      // a 3rd item beyond lane_list's own 2, for testing that the real O-O
      // door (this lane's sole VISIBLE exit -- the locked a6 door doesn't
      // occupy a room.exits slot at all) continues the SAME list onto its
      // own head object.
      { id: 'lane_list3', name: 'Lane List 3', roomName: '', category: '',
        orderingType: 'procedural', orderingRule: '',
        items: [{ name: 'First', assetId: null }, { name: 'Second', assetId: null }, { name: 'Third', assetId: null }],
        mnemonic: { type: 'generated_phrase', initialism: '', phrase: '', source: '' } },
    ],
  }, { defaultPlayerColor: 'white' });
  await openVR(appAD2.page);
  const keyFor = (mv) => appAD2.page.evaluate((moves) => {
    const c = new Chess();
    for(const m of moves) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  }, mv);
  const root = await keyFor(['d4','Nf6','c4']);
  const openTarget = await keyFor(['d4','Nf6','c4','e6','Nc3','Bb4','Bd2','O-O','e4']);
  await appAD2.page.evaluate((k) => window.__threeTestEdit.enter(k), root);
  await appAD2.page.waitForTimeout(300);
  const exitEditMode = async () => {
    await appAD2.page.evaluate(() => window.__threeTestEdit.toggle());
    await appAD2.page.evaluate(() => window.__threeTestEdit.toggle());
  };

  // 87b. Setup: a genuine two-track room with 2 real move-object slots per
  //      lane, and (confirmed via the mesh scan) a real locked-door icon on
  //      the unbuilt branch -- the exact shape reported.
  try {
    const ids = await appAD2.page.evaluate((k) => window.__threeTestEdit.moveObjectSlotIds(k), root);
    const nonCenter = ids.filter(id => id !== 'obj-C1').sort();
    assert(JSON.stringify(nonCenter) === JSON.stringify(['obj-L1','obj-L2','obj-R1','obj-R2']),
      `test setup issue: expected 2 fillable slots per lane, got ${JSON.stringify(ids)}`);
    const meshKinds = await appAD2.page.evaluate(() => window.__threeTestEdit.meshes().map(m => m.kind));
    assert(meshKinds.includes('locked-door-icon'), `test setup issue: expected a locked-door icon on the unbuilt branch, got ${JSON.stringify(meshKinds)}`);
    ok('fully-decorated setup: a genuine two-track room with 2 real slots per lane and a locked door on one branch');
  } catch(e){ bad('fully-decorated (wall-list labels) setup', e); }

  // 87c. Before assigning anything: not decorated (unfilled slots, unnamed
  //      open-door target).
  try {
    await exitEditMode();
    const dec = await appAD2.page.evaluate(() => window.__threeTestEdit.decorated());
    assert(!dec, `expected the room NOT decorated before assigning wall lists, got ${JSON.stringify(dec)}`);
    ok('fully-decorated (wall-list labels): not decorated before wall lists are assigned');
  } catch(e){ bad('fully-decorated (wall-list labels): baseline false', e); }

  // 87d. Assign the label-only list to BOTH lanes and name the one door that
  //      actually needs it (the open, non-empty target -- the locked door's
  //      target is exempt, left unnamed on purpose, matching the reported
  //      setup where naming it anyway is harmless per test 86 above). This
  //      alone should now flip the room to fully decorated -- a wall-list
  //      item's own word counts as filled, same as a typed placeholder label.
  try {
    await appAD2.page.evaluate((k) => window.__threeTestEdit.setWallList(k, 'left', 'lane_list'), root);
    await appAD2.page.evaluate((k) => window.__threeTestEdit.setWallList(k, 'right', 'lane_list'), root);
    await appAD2.page.evaluate(({ k, n }) => window.__threeTestEdit.setRoomName(k, n), { k: openTarget, n: 'Open target' });
    await exitEditMode();
    const dec = await appAD2.page.evaluate(() => window.__threeTestEdit.decorated());
    assert(dec, `expected the room decorated once both lanes have a (label-only) wall list assigned and the open door is named, got ${JSON.stringify(dec)}`);
    ok('fully-decorated: a wall-list item\'s own label counts as filled, even with no image bound');
  } catch(e){ bad('fully-decorated: wall-list label-only counts as filled', e); }

  // 87e. A stale per-slot override (e.g. a hand-placed test prop left over
  //      from before the wall list existed) must not keep blocking the list
  //      forever once you (re)assign it -- reported live: assigning a wall
  //      list to a lane didn't change what the room showed at all, because a
  //      manual per-slot override from earlier testing still won under the
  //      old resolution order, with no way to tell from the Wall Lists dialog
  //      (whose preview only shows the list's own contents) that anything was
  //      blocking it. Assigning/reassigning a bucket's list now clears that
  //      bucket's own stale per-slot overrides so the pick actually takes
  //      effect immediately; a deliberate override set AFTER that point still
  //      wins, unchanged from before.
  try {
    await appAD2.page.evaluate((k) => window.__threeTestEdit.setWallList(k, 'left', null), root);
    await appAD2.page.evaluate(({ k, sid, w }) => window.__threeTestEdit.setSlotWord(k, sid, w),
      { k: root, sid: 'obj-L1', w: 'OldTestLabel' });
    const beforeReassign = await appAD2.page.evaluate((k) => window.__threeTestEdit.layoutSnapshot()[k], root);
    assert(beforeReassign.slotWords && beforeReassign.slotWords['obj-L1'] === 'OldTestLabel',
      `test setup issue: expected the stale override to apply, got ${JSON.stringify(beforeReassign.slotWords)}`);
    await appAD2.page.evaluate((k) => window.__threeTestEdit.setWallList(k, 'left', 'lane_list'), root);
    const afterReassign = await appAD2.page.evaluate((k) => window.__threeTestEdit.layoutSnapshot()[k], root);
    assert(!afterReassign.slotWords || !afterReassign.slotWords['obj-L1'],
      `expected (re)assigning the wall list to clear the stale per-slot override, got ${JSON.stringify(afterReassign.slotWords)}`);
    const listWord = await appAD2.page.evaluate((k) => window.__threeTestEdit.slotListWord(k, 'obj-L1'), root);
    assert(listWord === 'First', `expected the slot to now resolve to the list's own first item, got ${JSON.stringify(listWord)}`);
    ok('wall list assignment clears a stale per-slot override so the list actually takes effect');
  } catch(e){ bad('wall list assignment clears stale per-slot overrides', e); }

  // 87f. exits carry fromSide/fromOrder through from graph generation to
  //      render time -- the data plumbing continuationListItem depends on to
  //      tell which lane/member a door belongs to. The locked a6 door never
  //      occupies a room.exits slot at all (an unbuilt/leaf exit isn't part
  //      of this room's own exits array -- see genRooms' own `unbuilt`
  //      comment), so O-O is this lane's ONLY entry here despite the real
  //      branch -- which is exactly what makes the O-O door eligible for
  //      "exactly one door" continuation below, even though two tries were
  //      actually recorded from Bd2's position.
  try {
    const exits = await appAD2.page.evaluate((k) => window.__threeTestEdit.exitsFor(k), root);
    const leftExits = exits.filter(e => !e.back && e.fromSide === 'left');
    assert(leftExits.length === 1, `test setup issue: expected exactly 1 door slot for the left lane (the locked a6 door isn't one), got ${JSON.stringify(leftExits)}`);
    assert(leftExits[0].fromOrder === 2, `expected the door tagged fromOrder=2 (Bd2 is the lane's 2nd member), got ${JSON.stringify(leftExits[0])}`);
    ok('room exits carry fromSide/fromOrder through from graph generation to render time');
  } catch(e){ bad('room exits: fromSide/fromOrder threading', e); }

  // 87f2. That real O-O door -- this lane's one and only VISIBLE exit --
  //      actually continues the SAME wall list assigned to the lane, end to
  //      end through the real castle generator (not a synthetic room/ex).
  try {
    await appAD2.page.evaluate((k) => window.__threeTestEdit.setWallList(k, 'left', 'lane_list3'), root);
    const exits = await appAD2.page.evaluate((k) => window.__threeTestEdit.exitsFor(k), root);
    const oO = exits.find(e => !e.back && e.fromSide === 'left');
    const result = await appAD2.page.evaluate(({ k, t }) => window.__threeTestEdit.continuationListItemForRealDoor(k, t),
      { k: root, t: oO.target });
    assert(result && result.word === 'Third',
      `expected the real O-O door to continue lane_list3's 3rd item (0-based index 2), got ${JSON.stringify(result)}`);
    ok('a real castle-generated single door continues its lane\'s own wall list end to end');
  } catch(e){ bad('continuationListItem: real single-door case via the actual castle generator', e); }

  // 87g. When a lane ends in exactly one door (no branch), that door's own
  //      head object continues the SAME wall list right where the lane's own
  //      members left off -- requested live, after the reported wall-list
  //      fix above, as the natural next step: "in the case where there is
  //      exactly 1 door ... I want the move pair by that door to continue
  //      using the object list's next item". Exercised directly against
  //      continuationListItem (root has a real wall list assigned, but no
  //      real single-door branch is constructible without a genuine
  //      transposition, so the exits shape is supplied synthetically).
  try {
    const result = await appAD2.page.evaluate((k) =>
      window.__threeTestEdit.continuationListItem(k,
        { twoTrack: true, exits: [{ back: false, fromSide: 'left', fromOrder: 1 }] },
        { fromSide: 'left', fromOrder: 1 }),
      root);
    assert(result && result.word === 'Second',
      `expected the list's next item (0-based index 1) to continue onto the lane's sole door, got ${JSON.stringify(result)}`);
    ok('continuationListItem: a lane\'s single door continues the wall list at the next index');
  } catch(e){ bad('continuationListItem: single-door case', e); }

  // 87h. ...but not when the tail branches into more than one door (like the
  //      real a6/O-O branch above) -- there's no single "next" item to
  //      continue with.
  try {
    const result = await appAD2.page.evaluate((k) =>
      window.__threeTestEdit.continuationListItem(k,
        { twoTrack: true, exits: [
          { back: false, fromSide: 'left', fromOrder: 1 },
          { back: false, fromSide: 'left', fromOrder: 1 },
        ] },
        { fromSide: 'left', fromOrder: 1 }),
      root);
    assert(result === null, `expected a branch (2 doors from the same lane) to NOT continue the list, got ${JSON.stringify(result)}`);
    ok('continuationListItem: a branch (more than one door on the same lane) does not continue the list');
  } catch(e){ bad('continuationListItem: branch case returns null', e); }

  // 87i. ...and not when the resolved bucket has no wall list assigned, or
  //      the continuation index runs past the assigned list's own length.
  try {
    const noList = await appAD2.page.evaluate((k) =>
      window.__threeTestEdit.continuationListItem(k,
        { twoTrack: false, exits: [{ back: false, fromSide: 'left', fromOrder: 1 }] },
        { fromSide: 'left', fromOrder: 1 }),
      root);
    assert(noList === null, `expected no continuation when the resolved bucket has no wall list assigned, got ${JSON.stringify(noList)}`);
    const pastEnd = await appAD2.page.evaluate((k) =>
      window.__threeTestEdit.continuationListItem(k,
        { twoTrack: true, exits: [{ back: false, fromSide: 'left', fromOrder: 5 }] },
        { fromSide: 'left', fromOrder: 5 }),
      root);
    assert(pastEnd === null, `expected an index past the list's own length to return null, got ${JSON.stringify(pastEnd)}`);
    ok('continuationListItem: no list assigned, or index past the list\'s own length, both return null');
  } catch(e){ bad('continuationListItem: no-list / past-end cases', e); }
} finally {
  await appAD2.close();
}
} catch(e){ bad('Phase AD2: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AE: "fully decorated" rooms get a 🎨 glyph on their digraph node
//     label, mirroring the memorized-room border (Phase Z). ---
if(shouldRunPhase(['digraph'])){
try {
const appAE = await launchApp();
try {
  await seedBackup(appAE.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase AE: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AF: "Jump to VR" from the room-info modal (click a digraph node,
//     then jump straight into that room in the VR walk). ---
if(shouldRunPhase(['digraph'])){
try {
const appAF = await launchApp();
try {
  await seedBackup(appAF.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase AF: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AG: "Import this variation" from a saved eval's expanded PV in
//     the move table -- mirrors the live engine panel's own pvMenu ->
//     "Import this variation" (see importEngineVariation/renderEngineLines),
//     reusing the exact same import core, just triggered from a saved
//     (not live) line. ---
if(shouldRunPhase(['move-table'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase AG: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AG2: "Import this variation" must not disturb expand/collapse
//     state on nodes it merely re-touches (unchanged reply, already existed)
//     -- the reported bug: importing a PV whose early steps duplicate an
//     already-configured path force-collapsed those steps every time,
//     dramatically changing the tree's look even though nothing there
//     actually changed. Only genuinely new nodes should get a fresh
//     (expanded, matching manual "Set Standard Response") default. ---
if(shouldRunPhase(['move-table'])){
try {
const appAG2 = await launchApp();
try {
  const midFen = await appAG2.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4','e6']) c.move(m, { sloppy: true });
    return c.fen();
  });
  await seedBackup(appAG2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
      // the e6 node's own saved PV re-plays its ALREADY-configured standard
      // reply (Nc3) before adding one genuinely new ply (Bg7) -- importing it
      // re-touches both the Nf6 and e6 nodes with UNCHANGED reply values.
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3',
        eval: { type: 'cp', value: 20, depth: 18, pv: '5.Nc3 Bg7', pvFen: midFen, pvUci: ['b1c3','f8g7'] } },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bg7', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
  await appAG2.page.click('.line-row');
  const nf6Sel = 'tr.data-row[data-seq="d4,Nf6"]';
  const e6Sel = 'tr.data-row[data-seq="d4,Nf6,c4,e6"]';
  await appAG2.page.waitForSelector(e6Sel, { timeout: 10000 });

  // 97b. Both rows start expanded (the default absent an explicit collapsed
  //      pref) -- confirm the test's own starting state before importing.
  const toggleState = async (sel) => appAG2.page.evaluate(
    (s) => document.querySelector(s)?.querySelector('.toggle')?.innerHTML.includes('caret-down'), sel);
  try {
    assert(await toggleState(nf6Sel), 'test setup issue: expected the Nf6 row to start expanded');
    assert(await toggleState(e6Sel), 'test setup issue: expected the e6 row to start expanded');
  } catch(e){ bad('import stability: setup (both rows start expanded)', e); }

  // 97c. Importing the e6 node's own saved PV (which re-touches Nf6 and e6
  //      with their unchanged existing replies) leaves both still expanded.
  try {
    await appAG2.page.evaluate((sel) => document.querySelector(`${sel} .evaltag`).click(), e6Sel);
    await appAG2.page.waitForSelector(`${e6Sel} + tr.meta-row .meta-pv-menu`, { timeout: 5000 });
    await appAG2.page.evaluate((sel) =>
      document.querySelector(sel).nextElementSibling.querySelector('.meta-pv-menu[data-pv-idx="-1"]').click(), e6Sel);
    await appAG2.page.waitForSelector('#graphCtxMenu', { state: 'visible', timeout: 5000 });
    await appAG2.page.evaluate(() => document.querySelector('#graphCtxMenu div').click());
    // the reply values here are UNCHANGED by this import (that's the point of
    // the test), so there's no new DOM value to wait on -- wait on the
    // logged "imported N move(s)..." confirmation instead, which fires right
    // before importEngineVariation's own (synchronous) renderTreeBody call.
    await appAG2.page.waitForFunction(() => /imported \d+ move/.test(document.getElementById('progress').textContent), { timeout: 10000 });
    assert(await toggleState(nf6Sel), 'expected the Nf6 row to STAY expanded after import (it was merely re-touched with the same reply)');
    assert(await toggleState(e6Sel), 'expected the e6 row to STAY expanded after import (it was merely re-touched with the same reply)');
    ok('"Import this variation" leaves already-expanded, unchanged nodes expanded instead of force-collapsing them');
  } catch(e){ bad('import stability: re-touched nodes keep their expand state', e); }
} finally {
  await appAG2.close();
}
} catch(e){ bad("phase @ line 3720 (tags: ['move-table'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AH: locked doors -- a room with nothing built past it (no forward
//     moves) gets a doorway that can't be walked through, with a lock icon
//     until it's skinned (per-door or via a castle-wide default), mirroring
//     the ordinary/exit-door "building defaults" mechanism. ---
if(shouldRunPhase(['vr-castle'])){
try {
const appAH = await launchApp();
try {
  // root Alpha branches four ways: e6 leads to a room with a genuine BRANCH
  // of its own (Bb4/Be7 -- 2 replies, so it gets 2 real forward doors and is
  // NOT empty; a single continuing reply would instead just collapse into
  // the same corridor room with no new door -- see Phase X). g6 and d5 are
  // both genuine dead ends (EMPTY -- nothing built past either, and each is
  // only a single-member "room" with no in-room wall content of its own).
  // e5 is the reported-bug shape: a LINEAR, unbranched chain (Nc3, then e4)
  // merges into one multi-member corridor room that then dead-ends with no
  // further reply -- it has zero forward doors, same as g6/d5, but (unlike
  // them) real wall content of its own (e4, the corridor's 2nd member), so
  // it must NOT read as empty/locked.
  await seedBackup(appAH.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Bd2' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Be7'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','d5'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e5'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e5','Nc3','Nc6'], reply: 'e4' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Bd2', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 e6 Nc3 Be7 e4', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 Nf6 c4 g6 Nc3 Bg7', white: 'a', black: 'b', result: '*' },
      { id: 'g4', moves: 'd4 Nf6 c4 d5 Nc3 Bb4', white: 'a', black: 'b', result: '*' },
      { id: 'g5', moves: 'd4 Nf6 c4 e5 Nc3 Nc6 e4', white: 'a', black: 'b', result: '*' },
    ],
    assets: [{ id: 'vaultDoor', type: 'door', image: 'data:image/png;base64,iVBORw0KGgo=' }],
  }, { defaultPlayerColor: 'white' });
  await openVR(appAH.page);
  const keyFor = (moves) => appAH.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  }, moves);
  const root = await keyFor(['d4','Nf6','c4']);
  const e6Room = await keyFor(['d4','Nf6','c4','e6','Nc3']);
  const g6Room = await keyFor(['d4','Nf6','c4','g6','Nc3']);
  const d5Room = await keyFor(['d4','Nf6','c4','d5','Nc3']);
  const e5Room = await keyFor(['d4','Nf6','c4','e5','Nc3']);
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

  // 105b. A multi-member corridor room that dead-ends (no forward exit of
  //       its own) still reads as NOT empty, because it holds real wall
  //       content (its 2nd member, e4) -- the reported bug: this exact shape
  //       was misread as a locked door despite having moves to walk through.
  try {
    const empty = await appAH.page.evaluate((k) => window.__threeTestEdit.isRoomEmpty(k), e5Room);
    assert(empty === false, `expected the multi-member corridor (e5->Nc3->e4, no further reply) NOT empty despite no forward door, got ${empty}`);
    ok('isRoomEmpty: a dead-ending multi-member corridor is not treated as an empty/locked room');
  } catch(e){ bad('locked doors: multi-member corridor dead end is not empty', e); }

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

} catch(e){ bad('Phase AH: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AH2: skinning a locked door through the real in-world picker
//     offers to make it this castle's locked-door default right away (a
//     confirm prompt), instead of requiring the separate Room Geometry
//     "make default" step every other door category needs. ---
if(shouldRunPhase(['vr-decorating'])){
try {
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
  }, { defaultPlayerColor: 'white' });
  await openVR(appAH2.page);
  const root = await appAH2.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  });
  const g6Room = await appAH2.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4','g6','Nc3']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
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

} catch(e){ bad('Phase AH2: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AH3: same isRoomEmpty fix, but for a two-track room -- a root
//     that branches into two even-depth single-child chains (e6/g6, each 2
//     rooms deep) merges into one two-track room. When BOTH tracks dead-end
//     with no further reply, the room has zero forward exits of its own,
//     same shape as the corridor case, but it clearly holds real branching
//     content (left AND right track pairs) and must not read as empty. ---
if(shouldRunPhase(['vr-castle'])){
try {
const appAH3 = await launchApp();
try {
  await seedBackup(appAH3.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Qc2' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','g6','Nc3','Bg7'], reply: 'e4' },
    ]}],
    // stop exactly at Qc2/e4 -- no further move on either track, so the
    // resulting two-track room has no forward door of its own to check.
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Qc2', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6 Nc3 Bg7 e4', white: 'a', black: 'b', result: '*' },
    ],
  }, { defaultPlayerColor: 'white' });
  await openVR(appAH3.page);
  const root = await appAH3.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  });

  // 106b. The two-track room (both tracks dead-ending, no forward door)
  //       still reads as NOT empty, because it holds real left/right wall
  //       content -- same bug, two-track shape.
  try {
    await appAH3.page.evaluate((k) => window.__threeTestEdit.enter(k), root);
    await appAH3.page.waitForTimeout(300);
    const hasDivider = await appAH3.page.evaluate(() =>
      window.__threeTestEdit.meshes().some(m => m.kind === 'divider'));
    assert(hasDivider, 'test setup issue: expected a two-track divider mesh, confirming this really is a two-track room');
    const empty = await appAH3.page.evaluate((k) => window.__threeTestEdit.isRoomEmpty(k), root);
    assert(empty === false, `expected the dead-ending two-track room NOT empty despite no forward door, got ${empty}`);
    ok('isRoomEmpty: a dead-ending two-track room is not treated as an empty/locked room');
  } catch(e){ bad('locked doors: two-track dead end is not empty', e); }
} finally {
  await appAH3.close();
}
} catch(e){ bad("phase @ line 4008 (tags: ['vr-castle'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AI: top VR toolbar icon order -- the edit-only buttons (room
//     geometry / wall lists / assets) sit immediately right of the Edit
//     button, with no buttons that also show outside edit mode (board
//     position, memorize) wedged between them. ---
if(shouldRunPhase(['vr-ui'])){
try {
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
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  });
  await appAI.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
  await appAI.page.waitForTimeout(200);
  // scope to the toolbar itself ([data-three-toolbar]) -- the VR pane also
  // contains the Help overlay, whose documentation text carries the same inline
  // fa-solid icons, which a pane-wide selector would wrongly count as buttons.
  const iconOrder = () => appAI.page.evaluate(() =>
    [...document.querySelectorAll('#threeTestCanvasWrap [data-three-toolbar] i.fa-solid')].map(i =>
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

  // 111. The right-hand status cluster, in order, is decorated (fa-palette),
  //      dirty (fa-triangle-exclamation), memorize (fa-brain), then Close
  //      (fa-circle-xmark) -- memorize is the rightmost tool, immediately left
  //      of Close, with the two badges filing in to its left. All four live in
  //      the DOM regardless of the badges' current show/hide state.
  try {
    const order = await iconOrder();
    const paletteIdx = order.indexOf('fa-palette');
    const dirtyIdx = order.indexOf('fa-triangle-exclamation');
    const brainIdx = order.indexOf('fa-brain');
    const closeIdx = order.indexOf('fa-circle-xmark');
    assert(paletteIdx >= 0 && dirtyIdx >= 0 && brainIdx >= 0 && closeIdx >= 0,
      `expected to find the palette, dirty, brain and close icons, got: ${JSON.stringify(order)}`);
    assert(closeIdx - brainIdx === 1, `expected brain immediately left of close, got order: ${JSON.stringify(order)}`);
    assert(brainIdx - dirtyIdx === 1, `expected the dirty badge immediately left of brain, got order: ${JSON.stringify(order)}`);
    assert(dirtyIdx - paletteIdx === 1, `expected the decorated badge immediately left of the dirty badge, got order: ${JSON.stringify(order)}`);
    ok('right cluster order: decorated, dirty, memorize, Close (memorize rightmost, next to Close)');
  } catch(e){ bad('toolbar: right status cluster order (decorated, dirty, memorize, close)', e); }

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

  // 113. Edit and its edit-only buttons (undo, redo, room geometry, wall
  //      lists, asset library) are wrapped in a single bordered "chip" --
  //      visually one grouped cluster -- containing exactly those icons, in
  //      order, and nothing else (hints/board/info stay outside it).
  try {
    const info = await appAI.page.evaluate(() => window.__threeTestEdit.editGroupInfo());
    assert(info, 'expected an editGroup wrapper element (test setup issue if not)');
    assert(info.hasBorder, `expected the edit-tools group to have a visible border, got ${JSON.stringify(info)}`);
    assert(JSON.stringify(info.icons) === JSON.stringify(['fa-pencil', 'fa-rotate-left', 'fa-rotate-right', 'fa-ruler-combined', 'fa-list-ol', 'fa-cubes']),
      `expected exactly Edit + undo/redo + its edit-only icons inside the group, in order, got ${JSON.stringify(info.icons)}`);
    ok('Edit and its edit-only buttons (incl. undo/redo) are wrapped in a single bordered group');
  } catch(e){ bad('toolbar: edit-tools bordered group', e); }
} finally {
  await appAI.close();
}

} catch(e){ bad('Phase AI: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AJ: a room's own name on the floor, a little way in from the
//     entrance -- hint-gated, clamped to stay clear of the far wall in a
//     shallow room, and spins to keep facing the camera as you walk. ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appAJ = await launchApp();
try {
  await seedBackup(appAJ.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
  await openVR(appAJ.page);
  const root = await appAJ.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
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

  // 118. A too-shallow stored size self-heals: reconcileRoomBounds grows a
  //      room's depth back up to its content floor (relaxedContentMin, min 8m)
  //      on the next buildRoom, so an attempted 2.5m depth never persists. The
  //      floor label then sits at its normal 4m-in position in the healed
  //      room, not crammed against a far wall. (The label's own far-wall clamp
  //      is kept as defense but is no longer reachable via a saved size, since
  //      no room can be shallower than the content floor.)
  try {
    await appAJ.page.evaluate((k) => window.__threeTestEdit.resize(k, { w: 11, d: 2.5, h: 6 }), root);
    await appAJ.page.evaluate((k) => window.__threeTestEdit.enter(k), root);   // rebuild -> heal
    await appAJ.page.waitForTimeout(200);
    const healed = await appAJ.page.evaluate((rk) => window.__threeTestEdit.roomSize(rk), root);
    assert(healed.d > 2.5 + 0.01, `expected the too-shallow depth to self-heal above 2.5m, got ${healed.d}`);
    const label = await appAJ.page.evaluate(() => window.__threeTestEdit.roomNameFloorLabel());
    const expectedZ = healed.d / 2 - 4;   // normal 4m-in placement, room is now deep enough
    assert(label && Math.abs(label.z - expectedZ) < 0.05,
      `expected the label at the normal 4m-in position in the healed room (z~${expectedZ}), got ${JSON.stringify(label)}`);
    ok('room name floor label: a too-shallow room self-heals its depth and the label sits normally');
  } catch(e){ bad('room name floor label: shallow-room self-heal', e); }

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

} catch(e){ bad('Phase AJ: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AK: crop/erase image editor -- fuzz/brush-size sliders persist to
//     localStorage across modal reopens, and an undo/redo history stack
//     (standard rotate-left/rotate-right icons) walks back/forward through
//     each committed crop/erase/brush mutation. ---
if(shouldRunPhase(['assets'])){
try {
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

} catch(e){ bad('Phase AK: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AL: the asset picker's "New Asset" button (replacing the old
//     bare "Upload new…" quick-upload) opens the full asset editor -- id/
//     type/size fields plus Upload/Generate…/Crop -- as its own overlay
//     layered above the picker, with the Crop/Generate modals it can launch
//     layered above THAT in turn. ---
if(shouldRunPhase(['assets'])){
try {
const appAL = await launchApp();
try {
  await seedBackup(appAL.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [{ id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' }],
  }, { defaultPlayerColor: 'white' });
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

  // 128. The New Asset modal's "click the backdrop to close" gesture must
  //      not misfire on an ordinary text-selection drag that starts inside a
  //      field and ends over the backdrop -- reported live: sweep-selecting
  //      a size input to overtype it made the whole modal (and all
  //      in-progress work) vanish, with no console error. Browsers fire the
  //      resulting "click" on the nearest common ancestor of the
  //      mousedown/mouseup targets, which is the overlay itself once the
  //      drag leaves the field -- simulated directly via dispatched events
  //      (real mouse-drag text selection isn't reliably reproducible in
  //      headless Chromium) rather than guessed at through an actual drag.
  try {
    // a synthetic 'slot' target (a real move-object slot needs a built
    // castle with chain members, which this minimal fixture has none of) --
    // handleEditTarget's 'slot' branch only ever reads ud.allow/ud.slotId,
    // so a made-up slotId is fine for opening a prop-scoped picker.
    await appAL.page.evaluate(() => window.__threeTestEdit.target({ kind: 'slot', slotId: 'fake-slot', allow: ['billboard-cylindrical','extruded'] }));
    await appAL.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appAL.page.click('#pickerNewAssetBtn');
    await appAL.page.waitForSelector('#assetNewOverlay', { state: 'visible', timeout: 5000 });
    await appAL.page.fill('#assetSizeW', '2.5');
    await appAL.page.evaluate(() => {
      document.getElementById('assetSizeW').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.getElementById('assetNewOverlay').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const stillOpen = await appAL.page.evaluate(() => document.getElementById('assetNewOverlay').style.display !== 'none');
    assert(stillOpen, 'expected a drag-selection ending on the backdrop (mousedown started elsewhere) to NOT close the New Asset modal');
    const stillTyped = await appAL.page.evaluate(() => document.getElementById('assetSizeW').value);
    assert(stillTyped === '2.5', `expected the in-progress edit to survive, got ${JSON.stringify(stillTyped)}`);
    ok('New Asset modal: a text-selection drag ending on the backdrop does not close it');
  } catch(e){ bad('New Asset modal: backdrop-click false positive from a text-selection drag', e); }

  // 129. A genuine backdrop click (mousedown AND click both directly on the
  //      backdrop itself, no drag) still closes the modal as before.
  try {
    await appAL.page.evaluate(() => {
      const ov = document.getElementById('assetNewOverlay');
      ov.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      ov.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await appAL.page.waitForSelector('#assetNewOverlay', { state: 'hidden', timeout: 5000 });
    await appAL.page.click('#pickerCloseBtn');
    await appAL.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
    ok('New Asset modal: a genuine backdrop click (no drag) still closes it');
  } catch(e){ bad('New Asset modal: genuine backdrop click still closes it', e); }
} finally {
  await appAL.close();
}

} catch(e){ bad('Phase AL: uncaught error outside a numbered test (setup or otherwise)', e); }
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
try {
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
  }, { defaultPlayerColor: 'white' });
  await openVR(appAM.page);
  const roomKey = await appAM.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
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

    // d=6 is below what 2 side pairs need, so reconcileRoomBounds self-heals the
    // room's depth back up to its content floor rather than cramming the pairs
    // against a too-near wall. Every pair (never-nudged object placeholders AND
    // their mnemonic billboards) then sits at its natural computed position
    // INSIDE the healed footprint -- assert against the actual healed size.
    const sz = await appAM.page.evaluate((k) => window.__threeTestEdit.roomSize(k), roomKey);
    assert(sz.d > 6.01, `expected the too-small depth to self-heal above the requested 6m, got ${sz.d}`);
    const bound = sz.d/2 - 0.3;
    const after = await appAM.page.evaluate((k) => ({
      posL1: window.__threeTestEdit.posOf('obj-L1'),
      posL2: window.__threeTestEdit.posOf('obj-L2'),
      posMnemL1: window.__threeTestEdit.posOf('mnem-L1'),
      posMnemL2: window.__threeTestEdit.posOf('mnem-L2'),
    }), roomKey);
    for(const [name, p] of Object.entries(after)){
      assert(p && Math.abs(p.z) <= bound + 0.01,
        `expected ${name} inside the healed room (|z| <= ${bound}), got ${JSON.stringify(p)}`);
    }
    ok('a too-small room self-heals its depth so its move-pairs (object AND billboard) fit inside');
  } catch(e){ bad('reconcile: un-nudged move-pairs follow a shrink, not just previously-nudged ones', e); }
} finally {
  await appAM.close();
}

} catch(e){ bad("phase @ line 4594 (tags: ['vr-decorating'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AN: the Room Geometry dialog itself now refuses to shrink a room
//     below the size its OWN move-pairs/doors need, instead of relying
//     entirely on after-the-fact reconciliation. ---
if(shouldRunPhase(['vr-decorating'])){
try {
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
  }, { defaultPlayerColor: 'white' });
  await openVR(appAN.page);
  const roomKey = await appAN.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
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

} catch(e){ bad('Phase AN: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AN2: a genuinely simple room -- one door (or none), no side
//     move-pairs -- doesn't need the generous 11x13 castle-generation floor;
//     the Room Geometry dialog's minimum now relaxes down to 8x8 for it,
//     instead of being stuck at whatever size the room happened to be
//     generated/authored at. A room that actually has more content (side
//     pairs, 2+ doors on one wall) still keeps its larger real minimum --
//     covered by Phase AN's own >3m assertion above, unchanged. ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appAN2 = await launchApp();
try {
  await seedBackup(appAN2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
  }, { defaultPlayerColor: 'white' });
  await openVR(appAN2.page);
  // roomC is a plain hand-authored demo room (10x10x4) with exactly one
  // door -- a back exit to 'start' -- and no move-object slots at all: the
  // simplest possible "single door, no side pairs" shape.
  await appAN2.page.evaluate(() => window.__threeTestEdit.enter('roomC'));
  await appAN2.page.waitForTimeout(150);
  await appAN2.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
  await appAN2.page.waitForTimeout(60);

  // 162. The dialog's width/depth floors relax to 8m (SMALL_ROOM_MIN), well
  //      below roomC's own original 10x10 hand-authored size, and a resize
  //      to exactly 8x8 is accepted rather than clamped back up.
  try {
    await appAN2.page.evaluate(() => document.querySelector('#threeTestCanvasWrap i.fa-ruler-combined').closest('button').click());
    await appAN2.page.waitForSelector('#roomGeomOverlay', { state: 'visible', timeout: 5000 });
    const mins = await appAN2.page.evaluate(() => ({
      w: Number(document.getElementById('roomGeomW').getAttribute('min')),
      d: Number(document.getElementById('roomGeomD').getAttribute('min')),
    }));
    assert(mins.w === 8 && mins.d === 8, `expected the relaxed 8x8 floor for a single-door room with no side pairs, got ${JSON.stringify(mins)}`);

    await appAN2.page.fill('#roomGeomW', '8');
    await appAN2.page.fill('#roomGeomD', '8');
    await appAN2.page.evaluate(() => document.getElementById('roomGeomApplyBtn').click());
    await appAN2.page.waitForSelector('#roomGeomOverlay', { state: 'hidden', timeout: 5000 });
    await appAN2.page.waitForTimeout(200);
    const applied = await appAN2.page.evaluate(() => window.__threeTestEdit.roomSize('roomC'));
    assert(Math.abs(applied.w - 8) < 0.01 && Math.abs(applied.d - 8) < 0.01,
      `expected 8x8 to be accepted as-is (not clamped back up), got ${JSON.stringify(applied)}`);
    ok('Room Geometry dialog: a simple single-door room can be resized down to 8x8');
  } catch(e){ bad('Room Geometry dialog: relaxed minimum for a simple single-door room', e); }
} finally {
  await appAN2.close();
}
} catch(e){ bad("phase @ line 4749 (tags: ['vr-decorating'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
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
try {
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
    assert(options.length === 6, `expected all 6 asset types offered in the full Asset Manager, got ${JSON.stringify(options)}`);
    ok('the full Asset Manager\'s own New Asset still offers every type (not scoped to a picker)');
  } catch(e){ bad('full Asset Manager New Asset: unrestricted type list', e); }
} finally {
  await appAO.close();
}

} catch(e){ bad("phase @ line 4801 (tags: ['assets'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AP: setting a standard response for the first time (the row's
//     "Set Standard Response" action) now queues its newly-visible children
//     for background analysis, same as the explicit "Analyze All Children"
//     row-menu action -- it used to run an instant live search on the shared
//     engine instead, via a since-removed separate "Analyze Child Nodes"
//     modal. ---
if(shouldRunPhase(['move-table'])){
try {
const appAP = await launchApp();
try {
  await seedBackup(appAP.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 g6', white: 'a', black: 'b', result: '*' },
    ],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad("phase @ line 4883 (tags: ['move-table'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AQ: Room Geometry's "Reset Room…" (formerly "Clear styles…") now
//     wipes a room's ENTIRE LAYOUT entry -- including size, door positions/
//     types, and object-list wall assignments, none of which the old
//     narrower wipe touched -- back to exactly what a never-customized room
//     would have (still inheriting building defaults). ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appAQ = await launchApp();
try {
  const keys = await appAQ.page.evaluate(() => {
    const pk = mv => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_'); };
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase AQ: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AR: the "Choose Asset" picker gets (1) a search box filtering by
//     name/keyword, and (2) -- for move-object slots only -- a text field to
//     assign a manual placeholder label instead of a real image, which
//     counts as filled for "fully decorated" and gets cleared the moment a
//     real image is assigned instead. ---
if(shouldRunPhase(['assets'])){
try {
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
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  });
  await appAR.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
  await appAR.page.waitForTimeout(300);
  await appAR.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
  await appAR.page.waitForTimeout(60);
  const slotIds = await appAR.page.evaluate((k) => window.__threeTestEdit.moveObjectSlotIds(k), roomKey);
  const slotId = slotIds.find(id => id !== 'obj-C1');
  const openSlotPicker = () => appAR.page.evaluate((sid) =>
    window.__threeTestEdit.target({ kind: 'slot', slotId: sid, allow: ['extruded','billboard-cylindrical'] }), slotId);

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

} catch(e){ bad('Phase AR: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AR2: switching an asset's Type must not silently discard its
//     size -- renderTypeFields used to re-derive width/height/depth from
//     the asset's ORIGINALLY-loaded size (or, for a brand-new asset, the
//     new type's hardcoded default), throwing away anything currently
//     typed into the fields, whether that's the just-loaded saved size or
//     an in-progress unsaved edit made before switching type. ---
if(shouldRunPhase(['assets'])){
try {
const appAR2 = await launchApp();
try {
  await seedBackup(appAR2.page, {
    version: 6, user: 'tester',
    lines: [],
    assets: [{ id: 'resize-me', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w: 2, h: 3, d: 0.4 } }],
  });
  await appAR2.page.evaluate(() => document.getElementById('menuAssets').click());
  await appAR2.page.waitForSelector('#assetsGrid .asset-card', { timeout: 5000 });
  await appAR2.page.evaluate(() => {
    const card = [...document.querySelectorAll('#assetsGrid .asset-card')].find(c => c.textContent.includes('resize-me'));
    card.click();
  });
  await appAR2.page.waitForSelector('#assetSizeW', { timeout: 5000 });

  // 90. Switching an EXISTING asset's type carries its saved size over --
  //     not the new type's hardcoded default.
  try {
    const before = await appAR2.page.evaluate(() => ({
      w: document.getElementById('assetSizeW').value, h: document.getElementById('assetSizeH').value,
    }));
    assert(before.w === '2' && before.h === '3', `expected the saved size to show initially, got ${JSON.stringify(before)}`);
    await appAR2.page.selectOption('#assetTypeInput', 'billboard-cylindrical');
    const afterSwitch = await appAR2.page.evaluate(() => ({
      w: document.getElementById('assetSizeW').value, h: document.getElementById('assetSizeH').value,
    }));
    assert(afterSwitch.w === '2' && afterSwitch.h === '3',
      `expected width/height to carry over to billboard, not reset to its 0.8/1 default, got ${JSON.stringify(afterSwitch)}`);
    ok('asset editor: switching type carries an EXISTING asset\'s saved size over, not the new type\'s default');
  } catch(e){ bad('asset editor: type switch preserves an existing asset\'s size', e); }

  // 91. Switching type ALSO carries over a size the user just typed THIS
  //     session (before saving) -- not just the originally-loaded value.
  //     Depth (never editable on a billboard) correctly falls back to the
  //     original saved 0.4 rather than 0 once back on extruded.
  try {
    await appAR2.page.fill('#assetSizeW', '5');
    await appAR2.page.fill('#assetSizeH', '6');
    await appAR2.page.selectOption('#assetTypeInput', 'extruded');
    const afterBack = await appAR2.page.evaluate(() => ({
      w: document.getElementById('assetSizeW').value, h: document.getElementById('assetSizeH').value,
      d: document.getElementById('assetSizeD').value,
    }));
    assert(afterBack.w === '5' && afterBack.h === '6',
      `expected the just-typed 5/6 to carry over back to extruded, got ${JSON.stringify(afterBack)}`);
    assert(afterBack.d === '0.4', `expected depth to fall back to the original saved 0.4 (never had a live value to carry), got ${afterBack.d}`);
    ok('asset editor: switching type carries over an in-progress (unsaved) size edit');
  } catch(e){ bad('asset editor: type switch preserves an in-progress size edit', e); }
} finally {
  await appAR2.close();
}
} catch(e){ bad('Phase AR2: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AR3: 'billboard-sprite' (a full always-faces-camera sprite,
//     tilting on every axis) removed as a choosable asset type --
//     'billboard-cylindrical' (Y-axis-only rotation) is correct for
//     virtually everything a prop asset is used for, so it's now the default
//     for a brand-new asset too (previously 'extruded'). An asset already
//     saved under the removed type keeps working: db.js's getAllAssets
//     normalizes it to 'billboard-cylindrical' on every read (not a one-time
//     migration -- the stored record itself is left untouched), so every
//     consumer (the asset manager's grid/editor, and threeVR.js's ASSET_BY_ID)
//     sees it as cylindrical. ---
if(shouldRunPhase(['assets'])){
try {
const appAR3 = await launchApp();
try {
  await seedBackup(appAR3.page, {
    version: 6, user: 'tester',
    lines: [],
    // saved under the removed type, from before this change existed.
    assets: [{ id: 'legacy-sprite', type: 'billboard-sprite', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w: 0.6, h: 0.6 } }],
  });
  await appAR3.page.evaluate(() => document.getElementById('menuAssets').click());
  await appAR3.page.waitForSelector('#assetsGrid .asset-card', { timeout: 5000 });

  // 92. A brand-new asset defaults to "Billboard (cylindrical)", not
  //     "Extruded" -- and "Billboard (sprite)" is no longer offered at all.
  try {
    await appAR3.page.evaluate(() => document.getElementById('assetsNewBtn').click());
    await appAR3.page.waitForSelector('#assetTypeInput', { timeout: 5000 });
    const type = await appAR3.page.evaluate(() => document.getElementById('assetTypeInput').value);
    assert(type === 'billboard-cylindrical', `expected a brand-new asset to default to billboard-cylindrical, got ${JSON.stringify(type)}`);
    const optionValues = await appAR3.page.evaluate(() =>
      [...document.getElementById('assetTypeInput').options].map(o => o.value));
    assert(!optionValues.includes('billboard-sprite'),
      `expected "billboard-sprite" to no longer be offered as a choosable type, got ${JSON.stringify(optionValues)}`);
    ok('New Asset: defaults to billboard-cylindrical, and billboard-sprite is no longer offered');
    await appAR3.page.evaluate(() => document.getElementById('assetsCancelBtn').click());
  } catch(e){ bad('New Asset: cylindrical default, sprite type removed', e); }

  // 93. An asset already saved under the removed 'billboard-sprite' type
  //     shows (and opens in the editor) as billboard-cylindrical, not with a
  //     blank/broken type selection or a stale "sprite" label.
  try {
    await appAR3.page.waitForSelector('#assetsGrid .asset-card', { timeout: 5000 });
    const cardLabel = await appAR3.page.evaluate(() => {
      const card = [...document.querySelectorAll('#assetsGrid .asset-card')].find(c => c.textContent.includes('legacy-sprite'));
      return card ? card.querySelector('.asset-type')?.textContent : null;
    });
    assert(cardLabel === 'Prop: Billboard (cylindrical)',
      `expected the legacy asset's grid card to show the cylindrical label, got ${JSON.stringify(cardLabel)}`);
    await appAR3.page.evaluate(() => {
      const card = [...document.querySelectorAll('#assetsGrid .asset-card')].find(c => c.textContent.includes('legacy-sprite'));
      card.click();
    });
    await appAR3.page.waitForSelector('#assetTypeInput', { timeout: 5000 });
    const openedType = await appAR3.page.evaluate(() => document.getElementById('assetTypeInput').value);
    assert(openedType === 'billboard-cylindrical', `expected the legacy asset to open as billboard-cylindrical, got ${JSON.stringify(openedType)}`);
    ok('legacy billboard-sprite asset: shows and opens as billboard-cylindrical in the manager UI');
    await appAR3.page.evaluate(() => document.getElementById('assetsCancelBtn').click());
  } catch(e){ bad('legacy billboard-sprite asset: normalized in the manager UI', e); }

  // 94. getAllAssets() itself normalizes the type on every read -- the single
  //     choke point every consumer (asset manager, threeVR.js's ASSET_BY_ID)
  //     loads assets through, confirmed directly against the stored record.
  try {
    const type = await appAR3.page.evaluate(async () => {
      const assets = await getAllAssets();
      return assets.find(a => a.id === 'legacy-sprite')?.type;
    });
    assert(type === 'billboard-cylindrical', `expected getAllAssets to normalize the type, got ${JSON.stringify(type)}`);
    ok('getAllAssets: normalizes a legacy billboard-sprite asset to billboard-cylindrical on every read');
  } catch(e){ bad('getAllAssets: normalizes legacy billboard-sprite type', e); }
} finally {
  await appAR3.close();
}
} catch(e){ bad('Phase AR3: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AS: "Jump to VR" is hidden for a locked-door dead-end room -- a
//     built room with no forward continuation of its own, whose only entrance
//     in the walk is a locked door. Jumping inside a room you can otherwise
//     only reach through a locked door is confusing, so the button is hidden
//     there (but stays shown for the castle root, which is also "empty" until
//     built out yet is reached from the street, not a locked door). ---
if(shouldRunPhase(['digraph'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad("phase @ line 5197 (tags: ['digraph'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase AS2: positionKey strips a "phantom" en-passant target (one a FEN
//     records after any pawn double-push, but that no enemy pawn can actually
//     capture) so two move orders transposing into the identical board -- one
//     of which played the double-push last -- resolve to the SAME position
//     (and thus the same digraph node / castle room / VR room key). A
//     genuinely capturable en-passant is a real difference and is kept. ---
if(shouldRunPhase(['digraph'])){
try {
const appAS2 = await launchApp();
try {
  // 145. The exact case reported in the field: the "boiler room" reached two
  //      ways -- one order's last move is c2-c4 (FEN ep target c3, but Black
  //      has no pawn on b4/d4 to take it -> phantom), the other order arrived
  //      at the same board with the c-pawn already there (no ep target). Both
  //      must key the same, and to the ep-stripped form.
  try {
    const r = await appAS2.page.evaluate(() => {
      const board = 'r1bqkb1r/ppp1pp1p/2n2np1/3p4/2PP1B2/4PN2/PP3PPP/RN1QKB1R b KQkq';
      const withPhantom = window.__positionKey(board + ' c3 0 7');
      const withoutEp  = window.__positionKey(board + ' - 0 7');
      return { withPhantom, withoutEp };
    });
    assert(r.withPhantom === r.withoutEp,
      `expected the phantom-ep and no-ep positions to key identically, got ${JSON.stringify(r)}`);
    assert(/ -$/.test(r.withPhantom), `expected the key to end with a stripped ep, got ${JSON.stringify(r.withPhantom)}`);
    ok('positionKey: a phantom en-passant target is stripped, merging the two transposing paths into one position');
  } catch(e){ bad('positionKey: phantom en-passant stripped', e); }

  // 146. A genuinely capturable en-passant (a real difference in the legal
  //      moves) is preserved -- after 1.e4 d5 2.e5 f5, White's e5 pawn can
  //      take f6 en passant, so the target must survive.
  try {
    const kept = await appAS2.page.evaluate(() =>
      window.__positionKey('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3'));
    assert(/ f6$/.test(kept), `expected a genuinely capturable ep (f6) to be kept, got ${JSON.stringify(kept)}`);
    ok('positionKey: a genuinely capturable en-passant target is preserved');
  } catch(e){ bad('positionKey: capturable en-passant preserved', e); }

  // 147. A position with no en-passant field at all is unchanged (regression
  //      guard: the normalization must not disturb the common case).
  try {
    const plain = await appAS2.page.evaluate(() =>
      window.__positionKey('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'));
    assert(plain === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
      `expected an ep-less position to key unchanged, got ${JSON.stringify(plain)}`);
    ok('positionKey: a position with no en-passant target is unchanged');
  } catch(e){ bad('positionKey: no-ep position unchanged', e); }
} finally {
  await appAS2.close();
}
} catch(e){ bad("Phase AS2 (tags: ['digraph'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AT: node statistics "complete to move N" -- the shallowest branch's
//     move number, measured by OUR last move (reaching our move N counts even
//     if the opponent has no reply to it). ---
if(shouldRunPhase(['move-table'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad('Phase AT: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AU: gatherBuiltCastles' in-memory cache -- a second "Run VR" in
//     the same page load reuses the first one's result instead of rebuilding
//     every castle from scratch, and a full backup restore drops the cache
//     (it can swap in a different user's repertoire entirely). ---
if(shouldRunPhase(['castle-generation'])){
try {
const appAU = await launchApp();
try {
  await seedBackup(appAU.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
  }, { defaultPlayerColor: 'white' });
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
} catch(e){ bad('Phase AU: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BA: chess.com importer keeps full metadata (normalized to the same
//     shape Lichess games use), and a re-import clears ONLY chess.com games,
//     leaving Lichess untouched. ---
if(shouldRunPhase(['import-export'])){
try {
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
} catch(e){ bad('Phase BA: uncaught error outside a numbered test (setup or otherwise)', e); }
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
try {
const appAV = await launchApp();
try {
  await seedBackup(appAV.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' },
    ],
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad("phase @ line 5478 (tags: ['castle-generation'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
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
try {
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad("phase @ line 5593 (tags: ['castle-generation'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AX: "Import this variation" from a saved eval's PV (the
//     three-dot menu on the main move table, see Phase AG) invalidates the
//     cache -- it calls importParsedLine directly, the same core importLine
//     uses, but through a different entry point (importEngineVariation) that
//     needed its own invalidate call. ---
if(shouldRunPhase(['move-table'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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

  // 161. importEngineVariation can also be called with a startSeq that ends on
  //      OUR OWN move -- the live engine panel's "Analyse" button does exactly
  //      this once a reply is chosen (childrenSeq = [...lineSeq, reply], see
  //      renderBranch's btnEval.onclick), so a short PV from that position can
  //      consist of nothing but a single further opponent move with no reply
  //      after it. importParsedLine then only queues a manualReplies update
  //      (no 'reply' write), so importEngineVariation's persistence guard must
  //      not key off "count" (the number of replies written) -- it must commit
  //      the batch whenever anything was queued at all, or the manual reply
  //      only lives in the in-memory PREFS mutation and silently vanishes on
  //      reload (also skipping the cache invalidation below). Reached here via
  //      the test-only hook since driving this from the live engine panel would
  //      need a real engine, unavailable in this offline harness.
  const newRowSel = 'tr.data-row[data-seq="d4,Nf6,c4,e6"]';
  let ourMoveFen;
  try {
    await openVR(appAX.page);
    await appAX.page.waitForFunction(() => window.__vrCacheTestHooks.isCached(), { timeout: 5000 });
    await appAX.page.evaluate(() => {
      const btn = [...document.querySelectorAll('#threeTestCanvasWrap button')].find(b => b.title === 'Close');
      btn && btn.click();
    });
    await appAX.page.waitForFunction(() => document.getElementById('threeTestOverlay').style.display === 'none');

    ourMoveFen = await appAX.page.evaluate(() => {
      const c = new Chess();
      for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
      return c.fen();
    });
    await appAX.page.evaluate(({ fen }) =>
      window.__engineImportTestHooks.importEngineVariation(['d4','Nf6','c4'], fen, ['e7e6'], 1),
      { fen: ourMoveFen });

    await appAX.page.waitForSelector(newRowSel, { timeout: 5000 });
    ok('manual-only engine import: the new opponent try renders immediately from the in-memory PREFS mutation');
  } catch(e){ bad('manual-only engine import: renders immediately', e); }

  // 162. Same import must still invalidate the castle-generation cache, even
  //      though no "reply" was written -- the "count" the old code guarded on
  //      stayed 0 here since the PV was just one opponent move.
  try {
    assert((await appAX.page.evaluate(() => window.__vrCacheTestHooks.isCached())) === false,
      'expected a manual-only engine import (no "reply" written) to still invalidate the cache');
    ok('VR cache: a manual-only engine import (startSeq ending on our own move) still invalidates the cache');
  } catch(e){ bad('VR cache: invalidated by a manual-only engine import', e); }

  // 163. And it must actually be persisted to IndexedDB, not just mutated in
  //      the in-memory PREFS object -- reload and confirm it's still there.
  try {
    await appAX.page.reload({ waitUntil: 'domcontentloaded' });
    await appAX.page.waitForFunction(() => {
      const el = document.getElementById('buildStamp');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    await appAX.page.click('.line-row');
    await appAX.page.waitForSelector(rowSel, { timeout: 10000 });
    await appAX.page.waitForSelector(newRowSel, { timeout: 5000 });
    ok('manual-only engine import: the new opponent try survives a full reload (real IDB round-trip)');
  } catch(e){ bad('manual-only engine import: survives reload', e); }
} finally {
  await appAX.close();
}

} catch(e){ bad('Phase AX: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AY: "complete to move N" is now shown as an always-on [N] badge
//     on every move-table row with a reply set (next to the frequency-stats
//     column), not just via the on-demand Node Statistics modal -- same
//     values as Phase AT's computeNodeStats checks, reused here, but read
//     straight off the rendered DOM instead of the test hook, and with an
//     unanswered row confirmed to show no badge at all. ---
if(shouldRunPhase(['move-table'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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
    }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad("phase @ line 5752 (tags: ['move-table'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
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
try {
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
    }, { defaultPlayerColor: 'white' });
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
    }, { defaultPlayerColor: 'white' });
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
    }, { defaultPlayerColor: 'white' });
    await appAZ.page.click('.line-row');
    await appAZ.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });
    await focusOnNf6();

    // the local-file import REPLACES GAMES wholesale, so (now that the move
    // table only counts games where the signed-in user played the line's own
    // color) these need real players matching this sub-test's remembered
    // Lichess handle ('tester3') or every row -- including the ones asserted
    // on below -- would vanish under the color filter.
    const p3 = { white: { user: { name: 'tester3' } }, black: { user: { name: 'opp' } } };
    const ndjson = [
      { id: 'g1', moves: 'd4 Nf6', players: p3, result: '*' },
      { id: 'g2', moves: 'd4 d5', players: p3, result: '*' },
      { id: 'g3', moves: 'd4 Nf6 c4', players: p3, result: '*' },
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

} catch(e){ bad("phase @ line 5852 (tags: ['move-table'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase AZ3: "Import this variation" (the row-menu saved-eval/PV import)
//     now does a TARGETED re-render (just the imported-into row's own
//     subtree, via the same expandWith a manual "Set Standard Response"
//     uses) instead of a full renderTreeBody -- measured as the dominant
//     cost of a large-repertoire import (several SECONDS), dwarfing both the
//     batched IndexedDB write and everything else in a full render. Checks
//     both halves of that: an UNRELATED sibling row is provably untouched
//     (a full rebuild would destroy and recreate every row, including this
//     one), and the target's own ancestor still gets its "complete to move"
//     badge refreshed correctly even though its own subtree wasn't rebuilt. ---
if(shouldRunPhase(['move-table'])){
try {
const appAZ3 = await launchApp();
try {
  // d4,Nf6,c4,e6 carries a saved eval/PV (Nc3 Bb4) to import through the row
  // menu; d4,Nf6 is its own ancestor (badge should go from [2] -- e6 as yet
  // unanswered -- to [3] once the import gives e6 a reply); d4,d5 is a
  // completely unrelated sibling branch off the SAME root the import must
  // never touch.
  const midFen = await appAZ3.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4','e6']) c.move(m, { sloppy: true });
    return c.fen();
  });
  await seedBackup(appAZ3.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
      { seq: ['d4','Nf6','c4','e6'], eval: { type: 'cp', value: 10, depth: 18, pv: '3.Nc3 Bb4', pvFen: midFen, pvUci: ['b1c3','f8b4'] } },
      { seq: ['d4','d5'], reply: 'c4' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 d5 c4', white: 'a', black: 'b', result: '*' },
    ],
  }, { defaultPlayerColor: 'white' });
  await appAZ3.page.click('.line-row');
  await appAZ3.page.waitForSelector('tr.data-row[data-seq="d4,d5"]', { timeout: 10000 });

  // 168b. Before the import: the ancestor's badge is [2] (e6 unanswered
  //       pins it there), and mark the unrelated sibling row so a later
  //       check can prove its own DOM node specifically survived untouched
  //       (a full rebuild would tear down and recreate every row, wiping
  //       any property/attribute stamped onto it here).
  let ancestorBadgeBefore;
  try {
    ancestorBadgeBefore = await appAZ3.page.evaluate(() =>
      document.querySelector('tr.data-row[data-seq="d4,Nf6"] .completeBadge')?.textContent);
    assert(ancestorBadgeBefore === '[2]', `setup: expected the ancestor's starting badge to be [2], got ${JSON.stringify(ancestorBadgeBefore)}`);
    await appAZ3.page.evaluate(() => {
      document.querySelector('tr.data-row[data-seq="d4,d5"]').dataset.untouchedMarker = 'still-here';
    });
    ok('targeted re-render setup: ancestor badge starts at [2], sibling row marked for the untouched-DOM check below');
  } catch(e){ bad('targeted re-render setup', e); }

  // 168c. "Import this variation" from d4,Nf6,c4,e6's saved eval/PV.
  try {
    await appAZ3.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6,c4,e6"] .evaltag').click());
    await appAZ3.page.waitForSelector('tr.data-row[data-seq="d4,Nf6,c4,e6"] + tr.meta-row .meta-pv-menu', { timeout: 5000 });
    await appAZ3.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6,c4,e6"] + tr.meta-row .meta-pv-menu').click());
    await appAZ3.page.waitForSelector('#graphCtxMenu', { state: 'visible', timeout: 5000 });
    await appAZ3.page.evaluate(() => document.querySelector('#graphCtxMenu div').click());
    await appAZ3.page.waitForFunction(() => {
      const row = document.querySelector('tr.data-row[data-seq="d4,Nf6,c4,e6"]');
      return row && row.querySelector('.ourReply')?.textContent?.trim() === 'Nc3';
    }, { timeout: 10000 });
    ok('targeted re-render: "Import this variation" writes the new reply into the target row');
  } catch(e){ bad('targeted re-render: import writes the target row', e); }

  // 168d. The unrelated sibling (d4,d5) is the SAME DOM node as before --
  //       proof this was a targeted subtree update, not a full renderTreeBody
  //       (which tears down and rebuilds literally every row in the tree).
  try {
    const stillMarked = await appAZ3.page.evaluate(() =>
      document.querySelector('tr.data-row[data-seq="d4,d5"]')?.dataset.untouchedMarker === 'still-here');
    assert(stillMarked, 'expected the unrelated sibling row\'s own DOM node to survive untouched (proof of a targeted, not full, re-render)');
    ok('targeted re-render: an unrelated sibling branch\'s own DOM node is provably untouched');
  } catch(e){ bad('targeted re-render: unrelated branch left untouched', e); }

  // 168e. The ANCESTOR's own badge (d4,Nf6, not itself rebuilt) still
  //       refreshes correctly -- [2] -> [3] now that e6 has a reply -- even
  //       though only d4,Nf6,c4,e6's own subtree was actually re-rendered.
  try {
    const ancestorBadgeAfter = await appAZ3.page.evaluate(() =>
      document.querySelector('tr.data-row[data-seq="d4,Nf6"] .completeBadge')?.textContent);
    assert(ancestorBadgeAfter === '[3]', `expected the ancestor's badge to refresh to [3] after the import, got ${JSON.stringify(ancestorBadgeAfter)}`);
    ok('targeted re-render: an untouched ancestor\'s own "complete to move" badge still refreshes correctly');
  } catch(e){ bad('targeted re-render: ancestor badge refresh', e); }
} finally {
  await appAZ3.close();
}
} catch(e){ bad('Phase AZ3: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BA: the gatherBuiltCastles cache now persists to IndexedDB (not
//     just an in-memory, refresh-loses-it cache), and "Run VR" gained a
//     Shift+click/right-click gesture to force a fresh rebuild even when a
//     valid cached copy (memory or persisted) already exists. ---
if(shouldRunPhase(['castle-generation'])){
try {
const appBA = await launchApp();
try {
  await seedBackup(appBA.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
  }, { defaultPlayerColor: 'white' });
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
    // the spinner label is set synchronously (before openMainVRWorld's first
    // await), so capturing it in the SAME evaluate() call as the dispatch
    // catches it reliably -- confirms the cache-clear, not just "Building
    // world…" (the reported ask: some visible confirmation the cache was
    // actually cleared, not silently reused).
    const labelAtDispatch = await appBA.page.evaluate(() => {
      document.getElementById('menuThreeTest')
        .dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
      return document.getElementById('spinnerLabel').textContent;
    });
    assert(/Cache cleared/.test(labelAtDispatch), `expected the spinner to say "Cache cleared" during a forced rebuild, got "${labelAtDispatch}"`);
    await appBA.page.waitForFunction((expected) => window.__vrCacheTestHooks.buildCount() === expected,
      before.buildCount + 1, { timeout: 20000 });
    ok('VR cache: Shift+click on "Run VR" forces a fresh rebuild despite a valid cache, with a "Cache cleared" spinner');
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

  // 172b. A persisted copy stamped with a DIFFERENT build version is treated
  //       as stale: after a reload the next open rebuilds (and re-stamps)
  //       rather than serving a castle generated by the old code. This is what
  //       makes a deployed castle-gen change (positionKey, room-size floor, …)
  //       show up on the next reload instead of silently persisting the old
  //       world until a manual force-rebuild.
  try {
    // ensure a valid persisted copy exists, then corrupt just its build stamp.
    const staled = await appBA.page.evaluate(() => window.__vrCacheTestHooks.stalePersistedVersion());
    assert(staled, 'test setup issue: expected a persisted cache to re-stamp');
    await appBA.page.reload();
    await appBA.page.waitForFunction(() => {
      const el = document.getElementById('buildStamp');
      return el && el.textContent && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    const afterReload = await state();
    assert(!afterReload.isCached && afterReload.isPersisted && afterReload.buildCount === 0,
      `expected the stale-stamped copy still persisted (unread) right after reload, got ${JSON.stringify(afterReload)}`);
    await openVR(appBA.page);
    const afterReopen = await state();
    assert(afterReopen.isCached && afterReopen.buildCount === 1,
      `expected a build-version mismatch to force a rebuild, got ${JSON.stringify(afterReopen)}`);
    ok('VR cache: a persisted copy from a different build version is rebuilt, not reused');
  } catch(e){ bad('VR cache: build-version mismatch triggers rebuild', e); }
} finally {
  await appBA.close();
}

} catch(e){ bad('Phase BA: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BB: VR door plaques and the digraph's edge labels both show how
//     often an opponent's reply has actually occurred in the user's own
//     games -- "N (M%)", the same replies()-driven stat the move table's
//     own .cnt span shows (js/app.js), just rounded to a whole percent since
//     these two spots have far less room to work with. ---
if(shouldRunPhase(['vr-decorating', 'digraph'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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
        return window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_'); };
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

} catch(e){ bad('Phase BB: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BC: the street-level entry pair billboard (outside a castle's
//     front door) also carries an occurrence stat -- "which castle should I
//     memorize first?" is a street-level question, not a per-door one, so
//     this is computed separately (gatherBuiltCastles, js/app.js) from how
//     often games actually reached the castle's own entry, since
//     buildGeneratedCastle's own genRooms never captures an edge INTO its
//     own root (it starts fresh there with no incoming edge). ---
if(shouldRunPhase(['vr-castle'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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
        return window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_'); };
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

} catch(e){ bad("phase @ line 6167 (tags: ['vr-castle'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
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
try {
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad("phase @ line 6221 (tags: ['move-table'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BE: mnemonics export downscales images to fit
//     MNEM_EXPORT_IMG_MAX_DIM (so a full 384-image pack clears GitHub's
//     25MB web-upload limit) without touching the locally-stored originals. ---
if(shouldRunPhase(['mnemonics'])){
try {
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

} catch(e){ bad('Phase BE: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BF: engine.js's Threads-change handshake falls back to the last
//     known-good thread count (instead of silently searching on a possibly
//     wedged pthread pool) when a requested count doesn't ack in time, and
//     gives up loudly if even the fallback doesn't ack. Drives a real Engine
//     instance directly (no real Stockfish worker needed -- _send is
//     overridden to simulate the UCI protocol) since the vendored WASM build
//     isn't exercised by this offline harness. ---
if(shouldRunPhase(['engine'])){
try {
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

  // 83. init() re-entrancy: app.js calls engine.init() unconditionally at
  //     boot AND (guarded by `if(!engine.ready)`) from any live-analysis
  //     request, which can easily race the boot call while Stockfish is
  //     still cold-loading. Two concurrent init() calls must share one
  //     in-flight attempt (not each start their own _doInit(), which used to
  //     risk one call's cleanup path terminating the OTHER call's already-
  //     working Worker) -- but a LATER, non-concurrent call after that
  //     attempt settles should still get a fresh try. Drives _doInit()
  //     directly (a real Worker/Stockfish handshake isn't needed to test
  //     the guard around it).
  try {
    const result = await appBF.page.evaluate(async () => {
      const { Engine } = await import('/js/engine.js');
      const engine = new Engine();
      let doInitCalls = 0;
      engine._doInit = () => {
        doInitCalls++;
        return new Promise(resolve => setTimeout(resolve, 30));
      };
      await Promise.all([engine.init(), engine.init()]);
      const callsAfterConcurrent = doInitCalls;
      await engine.init();   // after settling, a later call should retry
      return { callsAfterConcurrent, callsAfterLater: doInitCalls };
    });
    assert(result.callsAfterConcurrent === 1, `expected two concurrent init() calls to share one _doInit() run, got ${result.callsAfterConcurrent}`);
    assert(result.callsAfterLater === 2, `expected a later, non-concurrent init() call to retry (not be permanently wedged), got ${result.callsAfterLater}`);
    ok('engine.init(): concurrent calls share one in-flight attempt; a later call after it settles still retries');
  } catch(e){ bad('engine init() re-entrancy guard', e); }

  // 84. A failed init() attempt must still let a later call retry (the
  //     cleared-on-settle promise shouldn't only clear on success), and
  //     every caller that raced the SAME failed attempt should see that
  //     same failure rather than one succeeding and one hanging.
  try {
    const result = await appBF.page.evaluate(async () => {
      const { Engine } = await import('/js/engine.js');
      const engine = new Engine();
      let doInitCalls = 0;
      engine._doInit = () => {
        doInitCalls++;
        return doInitCalls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve();
      };
      const settled = await Promise.allSettled([engine.init(), engine.init()]);
      const bothRejected = settled.every(r => r.status === 'rejected' && r.reason.message === 'boom');
      let retrySucceeded = false;
      try { await engine.init(); retrySucceeded = true; } catch {}
      return { bothRejected, doInitCalls, retrySucceeded };
    });
    assert(result.bothRejected, 'expected both concurrent callers racing the same failed attempt to see the same rejection');
    assert(result.doInitCalls === 2, `expected a later call after a failure to retry with a fresh _doInit(), got ${result.doInitCalls} total calls`);
    assert(result.retrySucceeded === true, 'expected the retry to succeed since the second _doInit() resolves');
    ok('engine.init(): a failed attempt still lets a later call retry, and concurrent callers share the same failure');
  } catch(e){ bad('engine init() re-entrancy guard: failure + retry', e); }
} finally {
  await appBF.close();
}

} catch(e){ bad("phase @ line 6353 (tags: ['engine'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BG: exportMnemonics() shows a spinner (with a running "N images
//     converted" progress label) while it re-encodes every image for export
//     -- converting a full 384-image set is slow enough that, with no visual
//     feedback, clicking Export looked like it did nothing (the reported bug). ---
if(shouldRunPhase(['mnemonics'])){
try {
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

} catch(e){ bad('Phase BG: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BH: importBackup() shows a spinner (with a running "N mnemonic
//     squares imported" progress label) during a full restore -- with zero
//     visual feedback, nothing prevented navigating to Manage Mnemonics
//     mid-restore and seeing incomplete data, which is what looked like a
//     silent failure to import mnemonics after a full backup restore. ---
if(shouldRunPhase(['import-export'])){
try {
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

  // 86. A round trip through import THEN export must preserve every field a
  //     backup claims to carry -- specifically the ones a prior review found
  //     silently dropped: the per-node `compareGames` toggle, and the
  //     graphLayout/decoratedRooms/memorizedShapes meta blobs (all three
  //     documented as persisted "the same way" as threeLayout/memorizedRooms,
  //     which WERE already covered). Seed a backup carrying all four, restore
  //     it through the real #backupImport path, confirm each lands in IDB via
  //     getPref/getMeta, then rebuild a fresh export (buildBackupData, the
  //     download-free half of exportBackup) and confirm it still has them --
  //     proving the fields survive both directions, not just storage.
  try {
    const roundTripBackup = {
      version: 6, user: 'tester',
      lines: [{
        id: 'L-RT', name: 'RoundTrip', color: 'white', openingMoves: ['d4'],
        prefs: [{ seq: ['d4'], reply: 'Nf6', compareGames: true }],
      }],
      games: [],
      graphLayout: JSON.stringify({ 'L-RT|root': { 'd4': {dx:5,dy:7} } }),
      decoratedRooms: JSON.stringify({ 'cas:L-RT:root': 1700000000000 }),
      memorizedShapes: JSON.stringify({ 'cas:L-RT:root': { kind:'corridor', exitPosKeys:['d4'] } }),
    };
    await seedBackup(appBH.page, roundTripBackup);

    const restoredPref = await appBH.page.evaluate(() => window.__aqTestHooks.getPref('L-RT', ['d4']));
    assert(restoredPref?.compareGames === true, `expected compareGames:true to survive the restore, got ${JSON.stringify(restoredPref)}`);

    const restoredMeta = await appBH.page.evaluate(() => Promise.all([
      window.__backupTestHooks.getMeta('graphLayout'),
      window.__backupTestHooks.getMeta('threeDecoratedRooms'),
      window.__backupTestHooks.getMeta('threeMemorizedShapes'),
    ]));
    assert(restoredMeta[0] === roundTripBackup.graphLayout, `expected graphLayout meta to survive the restore, got ${restoredMeta[0]}`);
    assert(restoredMeta[1] === roundTripBackup.decoratedRooms, `expected threeDecoratedRooms meta to survive the restore, got ${restoredMeta[1]}`);
    assert(restoredMeta[2] === roundTripBackup.memorizedShapes, `expected threeMemorizedShapes meta to survive the restore, got ${restoredMeta[2]}`);

    const rebuilt = await appBH.page.evaluate(() => window.__backupTestHooks.buildBackupData());
    const rebuiltPref = rebuilt.lines.find(l => l.id === 'L-RT')?.prefs.find(p => p.seq.join(',') === 'd4');
    assert(rebuiltPref?.compareGames === true, `expected a fresh export to still carry compareGames:true, got ${JSON.stringify(rebuiltPref)}`);
    assert(rebuilt.graphLayout === roundTripBackup.graphLayout, `expected a fresh export to still carry graphLayout, got ${rebuilt.graphLayout}`);
    assert(rebuilt.decoratedRooms === roundTripBackup.decoratedRooms, `expected a fresh export to still carry decoratedRooms, got ${rebuilt.decoratedRooms}`);
    assert(rebuilt.memorizedShapes === roundTripBackup.memorizedShapes, `expected a fresh export to still carry memorizedShapes, got ${rebuilt.memorizedShapes}`);
    ok('backup round trip: compareGames + graphLayout/decoratedRooms/memorizedShapes survive both restore and a fresh re-export');
  } catch(e){ bad('backup round trip: previously-dropped fields now survive', e); }

  // 87. If applyBackupData throws partway through the write phase (a record
  //     malformed in a way the shallow top-level validation -- data.lines is
  //     an array -- can't catch up front), importBackup must automatically
  //     roll back to a snapshot of whatever was there before, so a bad file
  //     can't leave the browser with neither the old nor a complete new
  //     copy. Covers the in-session case (tab stays alive to run the catch
  //     block); test 88 covers the crash-survives case.
  try {
    const goodBackup = {
      version: 6, user: 'goodUser',
      lines: [{ id: 'L-GOOD', name: 'Good', color: 'white', openingMoves: ['e4'], prefs: [{ seq: ['e4'], reply: 'e5' }] }],
      games: [],
    };
    await seedBackup(appBH.page, goodBackup);

    const badBackup = {
      version: 6, user: 'badUser',
      // seq:null throws inside setPref's prefKey (seq.join is not a function
      // on null) -- deep enough that the shallow top-level checks pass it through.
      lines: [{ id: 'L-BAD', name: 'Bad', color: 'white', openingMoves: ['d4'], prefs: [{ seq: null, reply: 'd5' }] }],
      games: [],
    };
    const genBefore = await appBH.page.evaluate(() => window.__importBackupGen());
    await appBH.page.setInputFiles('#backupImport', {
      name: 'bad.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(badBackup)),
    });
    // the rollback's own applyBackupData call reaches the same trailing
    // _importBackupGen++ a clean restore would -- so this settles even
    // though the FIRST (failing) attempt never got that far.
    await appBH.page.waitForFunction((n) => window.__importBackupGen() > n, genBefore, { timeout: 15000 });

    const userId = await appBH.page.evaluate(() => document.getElementById('userId').value);
    assert(userId === 'goodUser', `expected the failed import to roll back the remembered Lichess handle to "goodUser", got ${userId}`);

    const [lines, goodPref, hasSafety] = await appBH.page.evaluate(() => Promise.all([
      window.__linesTestHooks.getLines(),
      window.__aqTestHooks.getPref('L-GOOD', ['e4']),
      window.__backupTestHooks.hasSafetyBackup(),
    ]));
    assert(lines.length === 1 && lines[0].id === 'L-GOOD', `expected the pre-restore line to survive the rollback, got ${JSON.stringify(lines)}`);
    assert(!lines.some(l => l.id === 'L-BAD'), `expected the failed import's own data to NOT be present after rollback, got ${JSON.stringify(lines)}`);
    assert(goodPref?.reply === 'e5', `expected the pre-restore pref to survive the rollback, got ${JSON.stringify(goodPref)}`);
    assert(hasSafety === false, `expected the safety-backup row to be cleared once the rollback succeeded, got hasSafetyBackup=${hasSafety}`);
    ok('importBackup: a mid-restore failure automatically rolls back to the pre-restore snapshot (in-session)');
  } catch(e){ bad('importBackup: automatic in-session rollback on failure', e); }

  // 88. The safety snapshot is persisted to IDB (not just held in memory), so
  //     it survives the TAB dying mid-restore, not just a thrown JS error.
  //     Simulate that: leave one user's data live, but plant a DIFFERENT
  //     snapshot in the safetyBackup store (as importBackup would have, right
  //     before wiping, had a "restore" to that state been interrupted before
  //     ever confirming completion) -- then reload the page and confirm the
  //     real boot sequence (maybeRecoverFromInterruptedRestore, wired in
  //     right before the first renderHome()) replays it automatically.
  try {
    const staleBackup = {
      version: 6, user: 'staleUser',
      lines: [{ id: 'L-STALE', name: 'Stale', color: 'white', openingMoves: ['c4'], prefs: [] }],
      games: [],
    };
    await seedBackup(appBH.page, staleBackup);

    const recoverSnapshot = {
      version: 6, user: 'recoverUser', exportedAt: new Date().toISOString(),
      lines: [{ id: 'L-RECOVER', name: 'Recover', color: 'white', openingMoves: ['e4'], prefs: [{ seq: ['e4'], reply: 'e5' }] }],
      games: [], mnemonics: [],
    };
    await appBH.page.evaluate((snap) => window.__backupTestHooks.persistSafetyBackup(snap), recoverSnapshot);

    await appBH.page.reload({ waitUntil: 'domcontentloaded' });
    await appBH.page.waitForFunction(() => {
      const el = document.getElementById('buildStamp');
      return el && el.textContent && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    await appBH.page.waitForFunction(() => window.__importBackupGen && window.__importBackupGen() > 0, { timeout: 15000 });

    const userId = await appBH.page.evaluate(() => document.getElementById('userId').value);
    assert(userId === 'recoverUser', `expected boot-time recovery to restore the remembered Lichess handle to "recoverUser", got ${userId}`);

    const [lines, recoveredPref, hasSafety] = await appBH.page.evaluate(() => Promise.all([
      window.__linesTestHooks.getLines(),
      window.__aqTestHooks.getPref('L-RECOVER', ['e4']),
      window.__backupTestHooks.hasSafetyBackup(),
    ]));
    assert(lines.length === 1 && lines[0].id === 'L-RECOVER', `expected the orphaned safety snapshot to be restored on boot, got ${JSON.stringify(lines)}`);
    assert(!lines.some(l => l.id === 'L-STALE'), `expected the pre-crash live data to be replaced by the recovered snapshot, got ${JSON.stringify(lines)}`);
    assert(recoveredPref?.reply === 'e5', `expected the recovered snapshot's pref data to be present, got ${JSON.stringify(recoveredPref)}`);
    assert(hasSafety === false, `expected the safety-backup row to be cleared once boot-time recovery succeeded, got hasSafetyBackup=${hasSafety}`);
    ok('boot-time recovery: an orphaned safety snapshot (simulating a crash mid-restore) is replayed automatically on the next page load');
  } catch(e){ bad('boot-time recovery from an orphaned safety snapshot', e); }
} finally {
  await appBH.close();
}

} catch(e){ bad('Phase BH: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BI: the Help modal (hamburger menu -> Help) loads its topic
//     list from help/topics.json and injects each topic's HTML fragment
//     from help/<file>.html into the content pane -- real files served by
//     the test harness's static server, not mocked. ---
if(shouldRunPhase(['help'])){
try {
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

} catch(e){ bad('Phase BI: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BJ: boot-time "install default mnemonics?" offer
//     (json/repchess-mnemonics-DEFAULT.json.gz), driven via
//     __mnemDefaultTestHooks. The real auto-run on boot is skipped under
//     threeTestDebug (see the guarded call near renderHome() in app.js) so
//     ordinary tests that boot with an empty mnemonics store don't all pay
//     for a real fetch+decompress+import -- only this dedicated test drives
//     it, end to end, against the real committed file. ---
if(shouldRunPhase(['mnemonics'])){
try {
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

} catch(e){ bad("phase @ line 6605 (tags: ['mnemonics'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BK: declining the default-mnemonics offer leaves the store empty
//     but still remembers the decision, so it doesn't nag on every boot. ---
if(shouldRunPhase(['mnemonics'])){
try {
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

} catch(e){ bad('Phase BK: uncaught error outside a numbered test (setup or otherwise)', e); }
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
try {
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
  }, { defaultPlayerColor: 'white' });
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

} catch(e){ bad("phase @ line 6672 (tags: ['digraph'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BM: opening the digraph while the MOVE TABLE (not the digraph's
//     own right-click focus) is focused on a castle root already scoped the
//     displayed nodes correctly (rootSeq = GRAPH_FOCUS_SEQ || FOCUSED_SEQ),
//     but the stats/coverage totals and the "Show Castle" dropdown's
//     selection ignored that fallback and always used the whole system.
//     focusedCastleName() now shares the same GRAPH_FOCUS_SEQ || FOCUSED_SEQ
//     precedence, fixing both at once. ---
if(shouldRunPhase(['digraph'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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
} catch(e){ bad("phase @ line 6860 (tags: ['digraph'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}

if(shouldRunPhase(['digraph'])){
try {
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
  }, { defaultPlayerColor: 'white' });
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
} catch(e){ bad("phase @ line 6912 (tags: ['digraph'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}

if(shouldRunPhase(['vr-decorating'])){
try {
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
  }, { defaultPlayerColor: 'white' });
  await openVR(appBO.page);
  const keyFor = (moves) => appBO.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
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
} catch(e){ bad("phase @ line 7020 (tags: ['vr-decorating'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}

if(shouldRunPhase(['vr-decorating'])){
try {
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
  }, { defaultPlayerColor: 'white' });
  await openVR(appBP.page);
  const alphaRoot = await appBP.page.evaluate(() => {
    const c = new Chess(); for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  });
  const betaRoot = await appBP.page.evaluate(() => {
    const c = new Chess(); for(const m of ['d4','d5','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Beta:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
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
} catch(e){ bad("phase @ line 7102 (tags: ['vr-decorating'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}

if(shouldRunPhase(['vr-decorating'])){
try {
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
  }, { defaultPlayerColor: 'white' });
  await openVR(appBQ.page);
  const keyFor = (moves) => appBQ.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
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
} catch(e){ bad("phase @ line 7161 (tags: ['vr-decorating'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BR: an entrance door's skin also becomes its destination room's
//     own exit/back door skin (setDoorOverride), so walking out looks like
//     walking back through the same door you came in. A transposition (two
//     different rooms leading to the same target) last-write-wins: whichever
//     entrance door was styled most recently sets the target's exit door. ---
if(shouldRunPhase(['vr-decorating'])){
try {
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
  }, { defaultPlayerColor: 'white' });
  await openVR(appBR.page);
  const keyFor = (moves) => appBR.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
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
} catch(e){ bad('Phase BR: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BS: past ELEV_PANEL_MAX_ROWS (7) floors, an elevator car's
//     button panel splits into a SECOND panel to the right of the door
//     (buildElevatorPanels), hard-capped at ELEV_MAX_FLOORS (14) -- past
//     that, the Room Geometry editor's "Elevator" choice is rejected. ---
if(shouldRunPhase(['vr-decorating'])){
try {
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
  }, { defaultPlayerColor: 'white' });
  await openVR(appBS.page);
  const keyFor = (moves) => appBS.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
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
} catch(e){ bad('Phase BS: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase BT: an elevator car is capped at ELEV_MAX_FLOORS (14) -- past
//     that, the Room Geometry editor's "Elevator" choice is rejected with
//     an explanatory message (mirrors the existing "too few floors" reject). ---
if(shouldRunPhase(['vr-decorating'])){
try {
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
  }, { defaultPlayerColor: 'white' });
  await openVR(appBT.page);
  const keyFor = (moves) => appBT.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
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
} catch(e){ bad('Phase BT: uncaught error outside a numbered test (setup or otherwise)', e); }
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
try {
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
  }, { defaultPlayerColor: 'white' });
  await openVR(appBU.page);
  const roomKey = await appBU.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
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
} catch(e){ bad("phase @ line 7759 (tags: ['vr-decorating'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase AV: "Browse Games" (née "Games with this Position") -- matching
//     (transposition vs exact line), result-from-your-perspective, and the
//     modal itself. ---
if(shouldRunPhase(['move-table'])){
try {
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
      // tester played BLACK in this one -- still reaches "d4 Nf6" by move text,
      // but it's an opponent's choice (their 1.d4), not tester's own White prep.
      { id: 'lg4', moves: 'd4 Nf6 Nf3 g6', createdAt: 500,
        players: { white: { user: { name: 'opp4' } }, black: { user: { name: 'tester' } } } },
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
  //       per-platform chesscom_lastUser resolves your color even though the
  //       remembered Lichess handle ("tester" here) is a different string --
  //       each platform's identity is tracked independently, so a chess.com
  //       handle that doesn't match your Lichess one still works.
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
    // chess.com identity -- only the remembered Lichess handle, keeping the
    // two platforms' identities from bleeding into each other.
    const lichessCrossMatch = await H('color', {
      players: { white: { user: { name: 'MyChessComHandle' } }, black: { user: { name: 'opp' } } },
    });
    assert(asWhite === 'win', `expected the chess.com-identity match to resolve White's win from the user's perspective, got ${asWhite}`);
    assert(asBlack === 'black', `expected the chess.com-identity match to resolve Black, got ${asBlack}`);
    assert(lichessCrossMatch === null, `expected a Lichess-shaped game to NOT match against the chess.com identity, got ${lichessCrossMatch}`);
    ok('games-list: a chess.com game matches your per-platform chess.com handle even when it differs from your Lichess handle');
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
  //      the shallow "d4 Nf6" position where tester actually played White
  //      (lg1, lg2) -- NOT the bare game (color undeterminable) or lg4
  //      (tester was Black in that one, an opponent's 1.d4, not tester's own
  //      White prep), even though both also reach this position by move text.
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
    assert(info.rows === 2, `expected only the 2 games where tester played White (lg1, lg2) -- not the bare game or Black-side lg4, got ${info.rows}`);
    assert(/\b2\b/.test(info.summary), `expected the summary to report 2 games, got "${info.summary}"`);
    assert(/as White/.test(info.summary), `expected the summary to say "as White", got "${info.summary}"`);
    assert(info.hasLichessLink, 'expected at least one clickable lichess-linked row');
    assert(info.lichessBadges === 2, `expected 2 lichess (knight) badges (lg1, lg2), got ${info.lichessBadges}`);
    assert(info.chesscomBadges === 0, `expected 0 chess.com badges -- the only chess.com-shaped games here (bare, lg4) are both filtered out, got ${info.chesscomBadges}`);
    ok('games-list: modal opens from the menu and lists only the games where the user played the line\'s own color');
    await appAV.page.evaluate(() => document.getElementById('gamesListCloseBtn').click());
  } catch(e){ bad('games-list: modal open + render, filtered to the line\'s own color', e); }

  // 154a. Closing on a backdrop click must not misfire on an ordinary text-
  //       selection drag that starts inside the moves-filter input and ends
  //       over the backdrop -- same class of bug as the New Asset modal's
  //       own (see Phase AL): browsers fire the resulting "click" on the
  //       nearest common ancestor of the mousedown/mouseup targets, which is
  //       the overlay itself once the drag leaves the field.
  try {
    await appAV.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appAV.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="gamesHere"]').click());
    await appAV.page.waitForSelector('#gamesListOverlay', { state: 'visible', timeout: 5000 });
    await appAV.page.evaluate(() => {
      document.getElementById('gamesListMovesInput').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.getElementById('gamesListOverlay').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const stillOpen = await appAV.page.evaluate(() => document.getElementById('gamesListOverlay').style.display !== 'none');
    assert(stillOpen, 'expected a drag-selection ending on the backdrop (mousedown started elsewhere) to NOT close the Browse Games modal');
    ok('Browse Games modal: a text-selection drag ending on the backdrop does not close it');

    await appAV.page.evaluate(() => {
      const ov = document.getElementById('gamesListOverlay');
      ov.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      ov.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await appAV.page.waitForSelector('#gamesListOverlay', { state: 'hidden', timeout: 5000 });
    ok('Browse Games modal: a genuine backdrop click (no drag) still closes it');
  } catch(e){ bad('Browse Games modal: backdrop-click false positive from a text-selection drag', e); }

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

  // 154e. A persisted index stamped with a DIFFERENT build version is treated
  //       as stale and rebuilt -- positionKey feeds this index, so a deployed
  //       change to the position-identity rule must not keep matching against
  //       an index built by the old code. (154d rebuilt+re-persisted the index
  //       under the current stamp, so there's a valid copy to re-stamp here.)
  try {
    const staled = await appAV.page.evaluate(() => window.__gamesListHooks.stalePersistedIndexVersion());
    assert(staled, 'test setup issue: expected a persisted index to re-stamp');
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
      `expected the real transposition results despite the stale-version blob, got ${JSON.stringify(byPos)}`);
    assert(buildCount === 1, `expected a build-version mismatch to discard the blob and rebuild, got ${buildCount} build(s)`);
    ok('games-list: a persisted index from a different build version is rebuilt, not reused');
  } catch(e){ bad('games-list: index build-version mismatch triggers rebuild', e); }
} finally {
  await appAV.close();
}
} catch(e){ bad('Phase AV: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase AV2: "Browse Games" -- the generalized modal (title, moves
//     input, pre-fill from a three-dot node, live re-filtering, the color
//     filter radios, and the hamburger entry point). ---
if(shouldRunPhase(['move-table'])){
try {
const appAV2 = await launchApp();
try {
  await seedBackup(appAV2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
    ]}],
    games: [
      { id: 'wg1', moves: 'd4 Nf6 c4 e6', createdAt: 3000,
        players: { white: { user: { name: 'tester' } }, black: { user: { name: 'opp1' } } } },
      { id: 'wg2', moves: 'd4 Nf6 c4 g6', createdAt: 2000,
        players: { white: { user: { name: 'tester' } }, black: { user: { name: 'opp2' } } } },
      { id: 'bg1', moves: 'd4 Nf6 c4 d5', createdAt: 1000,
        players: { white: { user: { name: 'opp3' } }, black: { user: { name: 'tester' } } } },
    ],
  });
  await appAV2.page.click('.line-row');
  await appAV2.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });

  // 156. Opening from the three-dot node pre-fills the moves input with that
  //      node's own move sequence, defaults the color filter to the line's
  //      own color (White here), and titles the modal "Browse Games".
  try {
    await appAV2.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] .rowMenuBtn').click());
    await appAV2.page.evaluate(() => document.querySelector('tr.data-row[data-seq="d4,Nf6"] [data-act="gamesHere"]').click());
    await appAV2.page.waitForSelector('#gamesListOverlay', { state: 'visible', timeout: 5000 });
    await appAV2.page.waitForFunction(() => document.querySelectorAll('#gamesListBody .games-row').length > 0, { timeout: 5000 });
    const state = await appAV2.page.evaluate(() => ({
      title: document.querySelector('#gamesListOverlay h2').textContent.trim(),
      moves: document.getElementById('gamesListMovesInput').value,
      activeColor: document.querySelector('.games-color-btn.active')?.dataset.color,
      rows: document.querySelectorAll('#gamesListBody .games-row').length,
    }));
    assert(state.title === 'Browse Games', `expected the modal title "Browse Games", got "${state.title}"`);
    assert(state.moves === '1. d4 Nf6', `expected the moves input pre-filled with "1. d4 Nf6", got "${state.moves}"`);
    assert(state.activeColor === 'white', `expected the color filter to default to White (the line's own color), got "${state.activeColor}"`);
    assert(state.rows === 2, `expected 2 games (the White-side games only), got ${state.rows}`);
    ok('Browse Games: opening from a node pre-fills the moves input and defaults to the line\'s own color');
  } catch(e){ bad('Browse Games: node pre-fill + defaults', e); }

  // 157. Editing the moves input re-filters the list live (after the debounce).
  try {
    await appAV2.page.fill('#gamesListMovesInput', '1. d4 Nf6 2. c4 g6');
    await appAV2.page.waitForFunction(() => document.querySelectorAll('#gamesListBody .games-row').length === 1, { timeout: 5000 });
    ok('Browse Games: editing the moves input live-refilters the list');
  } catch(e){ bad('Browse Games: live re-filter on input', e); }

  // 158. The color filter buttons act as radios; "Either" includes both
  //      colors, and "Black" narrows down to just the Black-side game.
  try {
    await appAV2.page.fill('#gamesListMovesInput', '1. d4 Nf6');
    await appAV2.page.evaluate(() => document.querySelector('.games-color-btn[data-color="either"]').click());
    await appAV2.page.waitForFunction(() => document.querySelectorAll('#gamesListBody .games-row').length === 3, { timeout: 5000 });
    const eitherActive = await appAV2.page.evaluate(() =>
      [...document.querySelectorAll('.games-color-btn')].filter(b => b.classList.contains('active')).map(b => b.dataset.color));
    assert(JSON.stringify(eitherActive) === JSON.stringify(['either']), `expected only "either" active, got ${JSON.stringify(eitherActive)}`);

    await appAV2.page.evaluate(() => document.querySelector('.games-color-btn[data-color="black"]').click());
    await appAV2.page.waitForFunction(() => document.querySelectorAll('#gamesListBody .games-row').length === 1, { timeout: 5000 });
    const summary = await appAV2.page.evaluate(() => document.getElementById('gamesListSummary').textContent);
    assert(/as Black/.test(summary), `expected the summary to say "as Black", got "${summary}"`);
    ok('Browse Games: color filter buttons act as radios (Black/White/Either)');
    await appAV2.page.evaluate(() => document.getElementById('gamesListCloseBtn').click());
  } catch(e){ bad('Browse Games: color filter radios', e); }

  // 159. The hamburger's "Browse Games" item, directly below "Search for a
  //      Variation" in the menu, opens the SAME modal blank (no pre-filled
  //      moves, "Either" selected).
  try {
    const menuOrder = [...await appAV2.page.evaluate(() => [...document.getElementById('menuList').children].map(el => el.id))];
    const searchIdx = menuOrder.indexOf('menuSearchLine');
    const browseIdx = menuOrder.indexOf('menuBrowseGames');
    assert(searchIdx >= 0 && browseIdx === searchIdx + 1,
      `expected "Browse Games" directly after "Search for a Variation" in the menu, got order ${JSON.stringify(menuOrder)}`);

    await appAV2.page.evaluate(() => document.getElementById('menuBrowseGames').click());
    await appAV2.page.waitForSelector('#gamesListOverlay', { state: 'visible', timeout: 5000 });
    const state = await appAV2.page.evaluate(() => ({
      moves: document.getElementById('gamesListMovesInput').value,
      activeColor: document.querySelector('.games-color-btn.active')?.dataset.color,
    }));
    assert(state.moves === '', `expected the moves input blank when opened from the hamburger, got "${state.moves}"`);
    assert(state.activeColor === 'either', `expected "Either" selected by default from the hamburger, got "${state.activeColor}"`);
    ok('Browse Games: hamburger menu item opens blank with "Either" selected, placed after "Search for a Variation"');
  } catch(e){ bad('Browse Games: hamburger entry point', e); }
} finally {
  await appAV2.close();
}
} catch(e){ bad('Phase AV2: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase AV2b: while the (one-time, per game-set) position index build is
//     in flight, the moves input and mode/color buttons lock instead of
//     accepting keystrokes -- each keystroke used to kick off its own
//     redundant full rebuild (since _posIndex.games stays stale until the
//     FIRST one finishes), compounding into multi-second per-character lag on
//     a large game database (the reported bug). A BIG_N past the 100-game
//     chunk boundary (see the "move-table" chunking phase below) guarantees
//     the build spans a couple of yielded frames, giving the test a real
//     window to observe the disabled state in. ---
if(shouldRunPhase(['move-table'])){
try {
const appAV2b = await launchApp();
try {
  const BIG_N = 230;
  await seedBackup(appAV2b.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['e4'], prefs: [] }],
    games: Array.from({ length: BIG_N }, (_, i) => ({
      id: `sg${i}`, moves: 'e4 e5 Nf3 Nc6', createdAt: i,
      players: { white: { user: { name: 'tester' }, rating: 1500 }, black: { user: { name: 'opp' }, rating: 1500 } },
    })),
  });
  await appAV2b.page.click('.line-row');
  await appAV2b.page.waitForSelector('tr.data-row', { timeout: 10000 });

  // 159b. Right after opening (before the index build finishes), the moves
  //       input and the mode/color buttons are all disabled; they re-enable
  //       once indexing completes, and the final list is still correct.
  try {
    const rightAfterOpen = await appAV2b.page.evaluate(() => {
      document.getElementById('menuBrowseGames').click();
      return {
        moves: document.getElementById('gamesListMovesInput').disabled,
        pos: document.getElementById('gamesModePos').disabled,
        line: document.getElementById('gamesModeLine').disabled,
        colors: [...document.querySelectorAll('.games-color-btn')].map(b => b.disabled),
      };
    });
    assert(rightAfterOpen.moves === true, 'expected the moves input disabled while the position index is still building');
    assert(rightAfterOpen.pos === true && rightAfterOpen.line === true, 'expected the mode buttons disabled while indexing');
    assert(rightAfterOpen.colors.every(Boolean), 'expected the color filter buttons disabled while indexing');

    await appAV2b.page.waitForFunction(() => document.getElementById('gamesListMovesInput').disabled === false, { timeout: 5000 });
    const afterIndexed = await appAV2b.page.evaluate(() => ({
      pos: document.getElementById('gamesModePos').disabled,
      line: document.getElementById('gamesModeLine').disabled,
      colors: [...document.querySelectorAll('.games-color-btn')].map(b => b.disabled),
      summary: document.getElementById('gamesListSummary').textContent,
    }));
    assert(afterIndexed.pos === false && afterIndexed.line === false, 'expected the mode buttons re-enabled once indexing finishes');
    assert(afterIndexed.colors.every(v => v === false), 'expected the color filter buttons re-enabled once indexing finishes');
    assert(afterIndexed.summary.includes(String(BIG_N)), `expected the summary to report all ${BIG_N} matched games once indexing finishes, got "${afterIndexed.summary}"`);
    ok('Browse Games: moves input + mode/color buttons lock during the one-time position-index build, then re-enable');
  } catch(e){ bad('Browse Games: controls lock during indexing', e); }
} finally {
  await appAV2b.close();
}
} catch(e){ bad('Phase AV2b: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase AV3: Browse Games from the hamburger must lazy-load GAMES itself
//     (the reported bug) -- opened as the very first thing this page load,
//     before any line's openLine() has had a chance to populate GAMES into
//     memory, it used to just alert "Import your games first" (easy to
//     mistake for "there are no games") despite real imported games already
//     sitting in IndexedDB. A page reload resets in-memory state the same
//     way a returning user's first click of the session would. ---
if(shouldRunPhase(['move-table'])){
try {
const appAV3 = await launchApp();
try {
  await seedBackup(appAV3.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [] }],
    games: [{ id: 'wg1', moves: 'd4 Nf6 c4 e6', createdAt: 3000,
      players: { white: { user: { name: 'tester' } }, black: { user: { name: 'opp1' } } } }],
  });
  await appAV3.page.reload();
  await appAV3.page.waitForFunction(() => {
    const el = document.getElementById('buildStamp');
    return el && el.textContent && el.textContent.trim().length > 0;
  }, { timeout: 15000 });

  // 161. Clicking "Browse Games" straight from a fresh reload (no line
  //      opened yet) still finds the real, already-imported games.
  try {
    await appAV3.page.evaluate(() => document.getElementById('menuBrowseGames').click());
    await appAV3.page.waitForSelector('#gamesListOverlay', { state: 'visible', timeout: 5000 });
    await appAV3.page.waitForFunction(() => document.querySelectorAll('#gamesListBody .games-row').length > 0, { timeout: 5000 });
    const rows = await appAV3.page.evaluate(() => document.querySelectorAll('#gamesListBody .games-row').length);
    assert(rows === 1, `expected the one already-imported game to show up, got ${rows} rows`);
    ok('Browse Games: hamburger entry lazy-loads GAMES when opened before any line');
  } catch(e){ bad('Browse Games: lazy-load GAMES from a fresh reload', e); }
} finally {
  await appAV3.close();
}
} catch(e){ bad("phase @ line 8155 (tags: ['move-table'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
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
try {
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
} catch(e){ bad("phase @ line 8195 (tags: ['move-table'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase AY2: Object List Manager's room-database JSON import -- two code
//     review fixes: (1) an auto-generated list id (no explicit list.id) is
//     disambiguated against every id already produced in the SAME import, so
//     two different rooms that slugify to the same room/list name pair don't
//     silently clobber each other; (2) a duplicate item name within one
//     list's items array is deduped (first occurrence wins), matching what
//     the editor's own "Add item" already enforces by hand. ---
if(shouldRunPhase(['object-lists'])){
try {
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
} catch(e){ bad("phase @ line 8250 (tags: ['object-lists'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase AY3: Object List Manager -- four more code-review fixes:
//     (1) re-importing a list preserves an existing item's asset binding
//     even when the item's name only changed case; (2) an asset's `image`
//     data is HTML-escaped before landing in an <img src="..."> attribute,
//     so a crafted/corrupted value can't break out and inject markup;
//     (3) a list record written straight to IDB with roomName/category/
//     orderingRule missing or null (the shape a raw backup restore can
//     produce, bypassing this module's own import normalization) opens and
//     saves cleanly instead of showing "null"/"undefined" or throwing;
//     (4) an id-less entry dropped during import is now counted and
//     surfaced, not silently discarded. ---
if(shouldRunPhase(['object-lists'])){
try {
const appAY3 = await launchApp();
try {
  await seedBackup(appAY3.page, {
    version: 6, user: 'tester',
    lines: [],
    assets: [
      { id: 'ovenAsset', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w:0.3,h:0.3,d:0.3 } },
      // all-lowercase id (unlike ovenAsset above) so typing it verbatim into
      // the New Asset editor round-trips through saveEditor's own
      // .toLowerCase() unchanged -- for the duplicate-id regression test.
      { id: 'dup-check-asset', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w:0.3,h:0.3,d:0.3 } },
    ],
    // a malformed record (finding 3): written verbatim by the raw
    // backup-restore path (js/app.js's `for(const list of data.objectLists)
    // await setObjectList(...)`), never touched by this module's own
    // normalizeImport -- exactly how a real, non-editor-authored backup
    // could reach the editor.
    objectLists: [{ id: 'bare_test', name: 'Broken List', roomName: null, category: null,
      orderingType: 'generated_mnemonic', orderingRule: null,
      items: [{ name: 'Thing', assetId: null }],
      mnemonic: { type: 'generated_phrase', initialism: '', phrase: '', source: '' } }],
  });
  await appAY3.page.evaluate(() => document.getElementById('menuObjectLists').click());
  await appAY3.page.waitForSelector('#objlistGrid .objlist-card', { timeout: 5000 });

  const openCard = async (matchText) => {
    await appAY3.page.evaluate((t) => {
      const card = [...document.querySelectorAll('#objlistGrid .objlist-card')].find(c => c.textContent.includes(t));
      card.click();
    }, matchText);
    await appAY3.page.waitForSelector('#objlistEditor', { state: 'visible', timeout: 5000 });
  };

  // 162. A record with roomName/category/orderingRule null (never normalized
  //      by this module -- seeded via the raw backup path) opens with an
  //      EMPTY room-name field (not the literal text "null"), and Save
  //      completes without throwing (back to the index grid, not stuck on
  //      the editor with a silent JS error).
  try {
    await openCard('Broken List');
    const roomVal = await appAY3.page.evaluate(() => document.getElementById('ol_room').value);
    assert(roomVal === '', `expected an empty Room Name field for a null roomName, got ${JSON.stringify(roomVal)}`);
    await appAY3.page.evaluate(() => document.getElementById('ol_save').click());
    await appAY3.page.waitForSelector('#objlistGrid', { state: 'visible', timeout: 5000 });
    ok('object lists: a record with null roomName/category/orderingRule opens and saves without crashing');
  } catch(e){ bad('object lists: defensive handling of a malformed (raw-restored) record', e); }

  // 163. Re-importing the same list with an item's name differing only in
  //      case (Oven -> OVEN) preserves its existing asset binding instead of
  //      silently dropping it.
  try {
    await appAY3.page.setInputFiles('#objlistImportFile', {
      name: 'r1.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ rooms: [{ name: 'Kitchen', lists: [
        { id: 'kit_fix', name: 'Fixtures', items: [{ name: 'Oven', assetId: 'ovenAsset' }, 'Sink'] },
      ]}]})),
    });
    await appAY3.page.waitForSelector('#objlistGrid .objlist-card', { timeout: 5000 });
    await appAY3.page.setInputFiles('#objlistImportFile', {
      name: 'r2.json', mimeType: 'application/json',
      // same list id, re-imported with NO assetId on the (differently-cased)
      // item -- the fix should recover 'ovenAsset' from the previous save.
      buffer: Buffer.from(JSON.stringify({ rooms: [{ name: 'Kitchen', lists: [
        { id: 'kit_fix', name: 'Fixtures', items: ['OVEN', 'Sink'] },
      ]}]})),
    });
    await appAY3.page.waitForTimeout(300);
    await openCard('Fixtures');
    const boundId = await appAY3.page.evaluate(() =>
      [...document.querySelectorAll('#ol_items tr')].find(tr => /oven/i.test(tr.textContent))
        ?.querySelector('.objlist-asset-id')?.textContent);
    assert(boundId === 'ovenAsset', `expected the case-differing re-import to keep the "ovenAsset" binding, got ${JSON.stringify(boundId)}`);
    await appAY3.page.evaluate(() => document.getElementById('ol_cancel').click());
    ok('object lists: re-import preserves an asset binding across an item-name case change');
  } catch(e){ bad('object lists: case-insensitive asset-binding preservation on re-import', e); }

  // 164. The asset's `image` is escaped before landing in the thumbnail's
  //      <img src="...">: a crafted value that would otherwise break out of
  //      the attribute and add a real onerror handler must NOT actually
  //      execute when the (deliberately broken) image fails to load.
  try {
    await appAY3.page.evaluate(async () => {
      await setAsset('evilAsset', { id: 'evilAsset', type: 'extruded',
        image: 'not-a-real-image.png" onerror="window.__objlistXssFired=true' });
    });
    await appAY3.page.evaluate(() => document.getElementById('menuObjectLists').click());
    await appAY3.page.waitForSelector('#objlistGrid .objlist-card', { timeout: 5000 });
    await openCard('Fixtures');
    await appAY3.page.evaluate(() => {
      const btn = [...document.querySelectorAll('#ol_items [data-pick]')][0];
      btn.click();
    });
    await appAY3.page.waitForSelector('#objlistPickOverlay', { state: 'visible', timeout: 5000 });
    await appAY3.page.fill('#objlistPickFilter', 'evilAsset');
    await appAY3.page.waitForFunction(() => document.querySelectorAll('#objlistPickGrid .asset-card').length === 1, { timeout: 5000 });
    await appAY3.page.evaluate(() => document.querySelector('#objlistPickGrid .asset-card').click());
    await appAY3.page.waitForTimeout(400);   // let the (broken) <img> attempt to load and fire onerror if unescaped
    const fired = await appAY3.page.evaluate(() => window.__objlistXssFired === true);
    assert(!fired, 'expected the crafted image string NOT to execute as markup (src must be escaped)');
    // structural proof alongside the behavioral one above: the whole crafted
    // string landed in ONE src attribute -- no separate onerror attribute was
    // parsed out of it (getAttribute('src') itself decodes &quot; back to "
    // on read, same as any other attribute, so it's not the right thing to
    // check here; a stray onerror attribute is).
    const hasOnerrorAttr = await appAY3.page.evaluate(() =>
      [...document.querySelectorAll('#ol_items img')][0]?.hasAttribute('onerror'));
    assert(hasOnerrorAttr === false, `expected no separate onerror attribute on the <img> (src must be escaped as one value), got hasAttribute=${hasOnerrorAttr}`);
    ok('object lists: asset image data is escaped in <img src>, not injectable as markup');
  } catch(e){ bad('object lists: <img src> escaping', e); }

  // 165. Importing a bare array with one id-less entry imports the valid one
  //      and reports the skip (not just added/updated), both in the
  //      returned counts and the alert shown to the user.
  try {
    let alertMsg = null;
    const onDialog = d => { alertMsg = d.message(); };   // read-only -- harness's own listener still accepts it
    appAY3.page.once('dialog', onDialog);
    await appAY3.page.evaluate(() => document.getElementById('ol_cancel')?.click());
    await appAY3.page.setInputFiles('#objlistImportFile', {
      name: 'bare.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify([
        { id: 'valid_one', name: 'Valid List', items: [{ name: 'A', assetId: null }] },
        { name: 'No Id List', items: [{ name: 'B', assetId: null }] },   // dropped: no id
      ])),
    });
    await appAY3.page.waitForFunction(() =>
      [...document.querySelectorAll('#objlistGrid .objlist-card')].some(c => c.textContent.includes('Valid List')),
      { timeout: 5000 });
    assert(alertMsg && /1 skipped/.test(alertMsg), `expected the import-complete alert to mention the 1 skipped entry, got ${JSON.stringify(alertMsg)}`);
    ok('object lists: an id-less entry is counted and reported as skipped, not silently dropped');
  } catch(e){ bad('object lists: skipped-entry count surfaced on import', e); }

  // 166. The item picker's "New Asset…" button (previously the only way to
  //      get an image for a list item was to cancel out to menu -> Manage VR
  //      Assets, create it there, then come back and re-open this picker)
  //      opens the real standalone New Asset editor; saving it assigns the
  //      new asset straight to the item being picked for and closes the
  //      picker, with the item's row showing the new thumbnail immediately
  //      (not stale until the manager is reopened).
  try {
    await appAY3.page.evaluate(() => document.getElementById('ol_cancel')?.click());
    await appAY3.page.evaluate(() => document.getElementById('menuObjectLists').click());
    await appAY3.page.waitForSelector('#objlistGrid .objlist-card', { timeout: 5000 });
    await openCard('Valid List');
    await appAY3.page.evaluate(() => document.querySelector('#ol_items [data-pick]').click());
    await appAY3.page.waitForSelector('#objlistPickOverlay', { state: 'visible', timeout: 5000 });
    await appAY3.page.click('#objlistPickNewAsset');
    await appAY3.page.waitForSelector('#assetNewOverlay', { state: 'visible', timeout: 5000 });
    await appAY3.page.fill('#assetIdInput', 'test-objlist-newasset-1');
    await appAY3.page.setInputFiles('#assetImgFile', FIXTURE_PNG_PATH);
    await appAY3.page.waitForSelector('#assetImgPreview', { timeout: 5000 });
    await appAY3.page.click('#assetsSaveBtn');
    await appAY3.page.waitForSelector('#assetNewOverlay', { state: 'hidden', timeout: 5000 });
    await appAY3.page.waitForSelector('#objlistPickOverlay', { state: 'hidden', timeout: 5000 });
    const boundId = await appAY3.page.evaluate(() =>
      document.querySelector('#ol_items tr .objlist-asset-id')?.textContent);
    assert(boundId === 'test-objlist-newasset-1', `expected the item bound to the freshly-created asset, got ${JSON.stringify(boundId)}`);
    const thumbSrc = await appAY3.page.evaluate(() => document.querySelector('#ol_items tr img')?.getAttribute('src') || null);
    assert(thumbSrc && thumbSrc.startsWith('data:image'), `expected the item row's thumbnail to show the new asset's image immediately, got ${JSON.stringify(thumbSrc)}`);
    ok('object lists: item picker\'s New Asset button creates and assigns an asset without leaving the list manager');
  } catch(e){ bad('object lists: "New Asset…" escape hatch from the item picker', e); }

  // 167. Regression: typing an id that already exists into the New Asset
  //      modal opened from THIS path (never having opened the full Asset
  //      Manager this session, so its own ASSETS cache would otherwise be
  //      stale/empty) is still caught -- Save shows the duplicate-id error
  //      and does NOT silently overwrite the existing asset.
  try {
    await appAY3.page.evaluate(() => document.querySelector('#ol_items [data-pick]').click());
    await appAY3.page.waitForSelector('#objlistPickOverlay', { state: 'visible', timeout: 5000 });
    await appAY3.page.click('#objlistPickNewAsset');
    await appAY3.page.waitForSelector('#assetNewOverlay', { state: 'visible', timeout: 5000 });
    await appAY3.page.fill('#assetIdInput', 'dup-check-asset');   // already exists (seeded at phase setup)
    await appAY3.page.setInputFiles('#assetImgFile', FIXTURE_PNG_PATH);
    await appAY3.page.waitForSelector('#assetImgPreview', { timeout: 5000 });
    await appAY3.page.click('#assetsSaveBtn');
    await appAY3.page.waitForSelector('#assetsError:has-text("already exists")', { timeout: 5000 });
    const stillOpen = await appAY3.page.evaluate(() => document.getElementById('assetNewOverlay').style.display !== 'none');
    assert(stillOpen, 'expected the New Asset modal to stay open on a duplicate id, not silently save');
    const dupImage = await appAY3.page.evaluate(async () => (await getAllAssets()).find(a => a.id === 'dup-check-asset')?.image);
    assert(dupImage === 'data:image/png;base64,iVBORw0KGgo=', `expected the original dup-check-asset image untouched, got ${JSON.stringify(dupImage)}`);
    await appAY3.page.evaluate(() => document.getElementById('assetsCancelBtn').click());
    ok('object lists: New Asset\'s duplicate-id check works even when Manage VR Assets was never opened this session');
  } catch(e){ bad('object lists: duplicate-id guard reaches a fresh ASSETS cache from this path', e); }

  // 168. Drag-to-reorder (grip icon + pointer drag, same strategy as the
  //      analysis queue's) replaces the old up/down arrows: a real pointer
  //      drag shows the drop-indicator bar and dims the dragged row while
  //      held, both clear immediately on release, the move commits to the
  //      working EDIT.items array, and Save persists the new order to IDB.
  try {
    // test 167 leaves the item picker open underneath its own New Asset
    // modal (only that inner modal was cancelled) -- close it first so it
    // doesn't intercept clicks meant for the grid/editor below.
    await appAY3.page.evaluate(() => {
      document.getElementById('objlistPickCancel')?.click();
      document.getElementById('ol_cancel')?.click();
    });
    await appAY3.page.evaluate(() => document.getElementById('menuObjectLists').click());
    await appAY3.page.waitForSelector('#objlistGrid', { state: 'visible', timeout: 5000 });
    await appAY3.page.click('#objlistNewBtn');
    await appAY3.page.waitForSelector('#objlistEditor', { state: 'visible', timeout: 5000 });
    await appAY3.page.fill('#ol_id', 'drag_test_list');
    await appAY3.page.fill('#ol_name', 'Drag Test');
    for(const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']){
      await appAY3.page.fill('#ol_newitem', name);
      await appAY3.page.click('#ol_additembtn');
    }
    const namesBefore = await appAY3.page.evaluate(() => [...document.querySelectorAll('#ol_items tr')].map(tr => tr.dataset.name));
    assert(JSON.stringify(namesBefore) === JSON.stringify(['Alpha','Bravo','Charlie','Delta']),
      `expected the four items added in order, got ${JSON.stringify(namesBefore)}`);

    // drag Delta (last, index 3) all the way up to land at index 0.
    const grabPoint = await appAY3.page.evaluate(() => {
      const grab = document.querySelectorAll('#ol_items tr')[3].querySelector('.objlist-grab');
      const r = grab.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const topY = await appAY3.page.evaluate(() => {
      const r = document.querySelectorAll('#ol_items tr')[0].getBoundingClientRect();
      return r.top + 2;   // just inside the first row's top -- well above its midpoint
    });

    await appAY3.page.mouse.move(grabPoint.x, grabPoint.y);
    await appAY3.page.mouse.down();
    await appAY3.page.mouse.move(grabPoint.x, topY, { steps: 6 });

    const duringDrag = await appAY3.page.evaluate(() => ({
      indicatorPresent: !!document.querySelector('.objlist-drop-indicator'),
      draggedRowDimmed: !!document.querySelector('#ol_items tr.objlist-dragging'),
    }));
    assert(duringDrag.indicatorPresent, 'expected the drop-indicator bar to appear while dragging');
    assert(duringDrag.draggedRowDimmed, 'expected the dragged row to be visually dimmed while dragging');

    await appAY3.page.mouse.up();
    await appAY3.page.waitForFunction(() =>
      [...document.querySelectorAll('#ol_items tr')].map(tr => tr.dataset.name)[0] === 'Delta',
      { timeout: 5000 });

    const after = await appAY3.page.evaluate(() => ({
      names: [...document.querySelectorAll('#ol_items tr')].map(tr => tr.dataset.name),
      indicatorGone: !document.querySelector('.objlist-drop-indicator'),
      noneDimmed: !document.querySelector('#ol_items tr.objlist-dragging'),
    }));
    assert(JSON.stringify(after.names) === JSON.stringify(['Delta','Alpha','Bravo','Charlie']),
      `expected Delta dragged from index 3 to index 0, got ${JSON.stringify(after.names)}`);
    assert(after.indicatorGone, 'expected the drop-indicator bar to be removed after releasing');
    assert(after.noneDimmed, 'expected no row to still be dimmed after releasing');

    await appAY3.page.click('#ol_save');
    await appAY3.page.waitForSelector('#objlistGrid', { state: 'visible', timeout: 5000 });
    const saved = await appAY3.page.evaluate(async () => {
      const lists = await getAllObjectLists();
      return lists.find(l => l.id === 'drag_test_list')?.items.map(it => it.name);
    });
    assert(JSON.stringify(saved) === JSON.stringify(['Delta','Alpha','Bravo','Charlie']),
      `expected the dragged order to survive Save (persisted to IDB), got ${JSON.stringify(saved)}`);
    ok('object lists: drag-to-reorder shows the drop-indicator bar, commits on release, and persists on Save');
  } catch(e){ bad('object lists: drag-to-reorder end to end', e); }
} finally {
  await appAY3.close();
}
} catch(e){ bad("phase @ line 8309 (tags: ['object-lists'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase AY3B: Object List Manager -- "Quiz this list", a recall drill
//     over a list's own items (mirrors js/app.js's Opening Quiz shape:
//     sequential questions, hit/miss tally, a summary screen with a replay
//     option -- but tests raw list memorization instead of chess moves).
//     Requested live as a way to actually test yourself on a list's
//     contents, not just view them in the editor. ---
if(shouldRunPhase(['object-lists'])){
try {
const appQL = await launchApp();
try {
  await seedBackup(appQL.page, {
    version: 6, user: 'tester',
    lines: [],
    assets: [{ id: 'ovenAsset', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w:0.3,h:0.3,d:0.3 } }],
    objectLists: [{ id: 'quiz_list', name: 'Quiz List', roomName: '', category: '',
      orderingType: 'procedural', orderingRule: '',
      items: [{ name: 'Oven', assetId: 'ovenAsset' }, { name: 'Sink', assetId: null }, { name: 'Fridge', assetId: null }],
      mnemonic: { type: 'generated_phrase', initialism: '', phrase: '', source: '' } }],
  });
  await appQL.page.evaluate(() => document.getElementById('menuObjectLists').click());
  await appQL.page.waitForSelector('#objlistGrid .objlist-card', { timeout: 5000 });
  await appQL.page.evaluate(() => {
    const card = [...document.querySelectorAll('#objlistGrid .objlist-card')].find(c => c.textContent.includes('Quiz List'));
    card.click();
  });
  await appQL.page.waitForSelector('#objlistEditor', { state: 'visible', timeout: 5000 });

  // 166. "Quiz this list" appears for a populated list and starts at item 1,
  //      showing the bound IMAGE (not the room-name text) as the cue for an
  //      illustrated item.
  try {
    await appQL.page.waitForSelector('#ol_quiz', { timeout: 5000 });
    await appQL.page.click('#ol_quiz');
    await appQL.page.waitForSelector('.objlist-quiz-card', { timeout: 5000 });
    const progress = await appQL.page.evaluate(() => document.querySelector('.objlist-quiz-progress').textContent);
    assert(progress.includes('Item 1 of 3'), `expected to start at item 1 of 3, got ${JSON.stringify(progress)}`);
    const hasImg = await appQL.page.evaluate(() => !!document.querySelector('.objlist-quiz-img'));
    assert(hasImg, 'expected the first (illustrated) item to show its bound image as the cue');
    ok('object list quiz: starts at item 1, showing the bound image for an illustrated item');
  } catch(e){ bad('object list quiz: opens and shows the first item', e); }

  // 167. A wrong answer is marked a miss and reveals the correct name.
  try {
    await appQL.page.fill('#olq_answer', 'Toaster');
    await appQL.page.click('#olq_submit');
    const feedback = await appQL.page.evaluate(() => document.getElementById('olq_feedback').textContent);
    assert(feedback.includes('Oven'), `expected the miss feedback to reveal "Oven", got ${JSON.stringify(feedback)}`);
    assert(feedback.includes('✗') || /it was/i.test(feedback), `expected miss feedback, got ${JSON.stringify(feedback)}`);
    ok('object list quiz: a wrong answer is marked a miss and reveals the correct item');
  } catch(e){ bad('object list quiz: wrong answer feedback', e); }

  // 168. The 2nd (un-illustrated) item shows a plain numbered slot instead of
  //      an image, and a correct answer (case/whitespace-insensitive) is a hit.
  try {
    await appQL.page.click('#olq_submit');   // "Next" (relabeled after test 167's reveal)
    const slotText = await appQL.page.evaluate(() => document.querySelector('.objlist-quiz-slot')?.textContent);
    assert(slotText === '#2', `expected a plain "#2" slot cue for the un-illustrated 2nd item, got ${JSON.stringify(slotText)}`);
    await appQL.page.fill('#olq_answer', '  sink  ');
    await appQL.page.click('#olq_submit');
    const feedback = await appQL.page.evaluate(() => document.getElementById('olq_feedback').textContent);
    assert(feedback.includes('Correct') || feedback.includes('✓'), `expected a hit for a case/whitespace-different correct answer, got ${JSON.stringify(feedback)}`);
    ok('object list quiz: an un-illustrated item shows a numbered slot, and matching is case/whitespace-insensitive');
  } catch(e){ bad('object list quiz: numbered-slot cue and lenient matching', e); }

  // 169. Skip counts as a miss too, and the last item's button reads "Finish"
  //      -- clicking it lands on the summary with the right tally.
  try {
    await appQL.page.click('#olq_submit');   // "Next" into item 3
    const finishLabel = await appQL.page.evaluate(() => document.getElementById('olq_submit').textContent);
    // not yet answered -- still "Check" until Skip/submit reveals the answer
    assert(finishLabel === 'Check', `expected "Check" before answering the last item, got ${JSON.stringify(finishLabel)}`);
    await appQL.page.click('#olq_skip');
    const revealedFinishLabel = await appQL.page.evaluate(() => document.getElementById('olq_submit').textContent);
    assert(revealedFinishLabel === 'Finish', `expected the last item's button to read "Finish" after answering, got ${JSON.stringify(revealedFinishLabel)}`);
    await appQL.page.click('#olq_submit');
    await appQL.page.waitForSelector('.objlist-quiz-score', { timeout: 5000 });
    const tally = await appQL.page.evaluate(() => document.querySelector('.objlist-quiz-card, #objlistQuiz').textContent);
    assert(/1 hit/.test(tally) && /2 misses/.test(tally), `expected a tally of 1 hit, 2 misses, got ${JSON.stringify(tally)}`);
    ok('object list quiz: skip counts as a miss, and the summary shows the right hit/miss tally');
  } catch(e){ bad('object list quiz: skip and end-of-quiz summary', e); }

  // 170. "Quiz again" restarts at item 1 with a reset score; "Quit quiz"
  //      mid-run returns to the editor, not the list grid.
  try {
    await appQL.page.click('#olq_again');
    const progress = await appQL.page.evaluate(() => document.querySelector('.objlist-quiz-progress').textContent);
    assert(progress.includes('Item 1 of 3') && progress.includes('0 correct, 0 missed'),
      `expected a fresh restart at item 1 with score reset, got ${JSON.stringify(progress)}`);
    await appQL.page.click('#olq_quit');
    await appQL.page.waitForSelector('#objlistEditor', { state: 'visible', timeout: 5000 });
    const quizHidden = await appQL.page.evaluate(() => document.getElementById('objlistQuiz').style.display === 'none');
    assert(quizHidden, 'expected quitting mid-quiz to hide the quiz panel and return to the editor');
    ok('object list quiz: "Quiz again" resets the score, and "Quit quiz" returns to the editor');
  } catch(e){ bad('object list quiz: replay and quit', e); }

  // 171. A case-insensitive PREFIX of 3+ letters counts as correct (typing
  //      "SIN" for "Sink") -- full typing rigor without making it tedious --
  //      but a shorter prefix does not.
  try {
    await appQL.page.click('#ol_quiz');
    await appQL.page.waitForSelector('.objlist-quiz-card', { timeout: 5000 });
    await appQL.page.fill('#olq_answer', 'ov');   // 2 letters of "Oven" -- too short
    await appQL.page.click('#olq_submit');
    let feedback = await appQL.page.evaluate(() => document.getElementById('olq_feedback').textContent);
    assert(!feedback.includes('Correct') && !feedback.includes('✓'),
      `expected a 2-letter prefix to NOT count as correct, got ${JSON.stringify(feedback)}`);
    await appQL.page.click('#olq_submit');   // Next -> item 2 (Sink)
    await appQL.page.fill('#olq_answer', 'SIN');   // 3 letters, different case
    await appQL.page.click('#olq_submit');
    feedback = await appQL.page.evaluate(() => document.getElementById('olq_feedback').textContent);
    assert(feedback.includes('Correct') || feedback.includes('✓'),
      `expected a 3-letter case-insensitive prefix ("SIN" for "Sink") to count as correct, got ${JSON.stringify(feedback)}`);
    assert(feedback.includes('Sink'), `expected a partial-match hit to also reveal the full name "Sink", got ${JSON.stringify(feedback)}`);
    ok('object list quiz: a 3+ letter case-insensitive prefix counts as correct, shorter does not');
  } catch(e){ bad('object list quiz: partial-match answer rule', e); }

  // 171b. An EXACT match's hit feedback does NOT redundantly repeat the name
  //      (the user already typed it in full) -- only a partial match does.
  try {
    await appQL.page.click('#olq_submit');   // Next -> item 3 (Fridge)
    await appQL.page.fill('#olq_answer', 'Fridge');
    await appQL.page.click('#olq_submit');
    const feedback = await appQL.page.evaluate(() => document.getElementById('olq_feedback').textContent);
    assert(feedback.includes('Correct') && !feedback.includes('Fridge'),
      `expected an exact-match hit to say just "Correct", not repeat the name, got ${JSON.stringify(feedback)}`);
    ok('object list quiz: an exact-match hit does not redundantly repeat the name');
  } catch(e){ bad('object list quiz: exact-match hit feedback stays plain', e); }
} finally {
  await appQL.close();
}
} catch(e){ bad('Phase AY3B: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase AY3C: "Quiz a Castle's Lists" (Object List Manager toolbar) --
//     combines every object list actually assigned to any wall bucket
//     anywhere in a chosen castle into one quiz; a castle with nothing
//     assigned is excluded from the picker entirely. Requested live as the
//     natural companion to "Quiz this list" -- study exactly what a given
//     memory palace actually uses, not one list in isolation. No VR walk
//     needed here -- the provider reads LAYOUT + the abstract castle graph
//     directly (gatherBuiltCastles), so this is seeded via threeLayout. ---
if(shouldRunPhase(['object-lists'])){
try {
const appCQ = await launchApp();
try {
  const rootKey = await appCQ.page.evaluate(() => {
    const c = new Chess();
    for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  });
  await seedBackup(appCQ.page, {
    version: 6, user: 'tester',
    lines: [
      { id: 'L1', name: 'Used Castle Line', color: 'white', openingMoves: ['d4'], prefs: [
        { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      ]},
      // a second, otherwise-valid castle with NO wall list assigned -- must
      // not show up in the picker (nothing to quiz there).
      { id: 'L2', name: 'Unused Castle Line', color: 'white', openingMoves: ['e4'], prefs: [
        { seq: ['e4','e5'], reply: 'Nf3', isCastleRoot: true, castleName: 'Beta', castleStreetNumber: 1 },
      ]},
    ],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'e4 e5 Nf3', white: 'a', black: 'b', result: '*' },
    ],
    objectLists: [{ id: 'castle_quiz_list', name: 'Castle Quiz List', roomName: '', category: '',
      orderingType: 'procedural', orderingRule: '',
      items: [{ name: 'Alpha Item', assetId: null }, { name: 'Beta Item', assetId: null }],
      mnemonic: { type: 'generated_phrase', initialism: '', phrase: '', source: '' } }],
    threeLayout: JSON.stringify({ [rootKey]: { wallLists: { all: { listId: 'castle_quiz_list' } } } }),
  });
  // 172. Test > Object Lists (hamburger menu) jumps straight to the
  //      castle-scoped quiz picker, skipping the list grid entirely -- and
  //      only the castle with a wall-list assignment appears in it.
  try {
    await appCQ.page.evaluate(() => document.getElementById('menuTestObjectLists').click());
    await appCQ.page.waitForSelector('#olcq_select', { timeout: 5000 });
    const gridHidden = await appCQ.page.evaluate(() => document.getElementById('objlistGrid').style.display === 'none');
    assert(gridHidden, 'expected Test > Object Lists to skip the list grid and land directly on the castle picker');
    const optionLabels = await appCQ.page.evaluate(() =>
      [...document.querySelectorAll('#olcq_select option')].map(o => o.textContent));
    assert(JSON.stringify(optionLabels) === JSON.stringify(['Alpha']),
      `expected only the used castle ("Alpha") in the picker, got ${JSON.stringify(optionLabels)}`);
    ok('Test > Object Lists: jumps straight to the castle picker, which excludes unused castles');
  } catch(e){ bad('Quiz a Castle: Test-menu shortcut and picker filtering', e); }

  // 173. Starting the quiz combines the castle's own assigned list's items,
  //      with each un-illustrated item's slot labeled by its source list.
  try {
    await appCQ.page.click('#olcq_start');
    await appCQ.page.waitForSelector('.objlist-quiz-card', { timeout: 5000 });
    const title = await appCQ.page.evaluate(() => document.querySelector('#objlistQuiz .objlist-h3').textContent);
    assert(title.includes('Used Castle Line') && title.includes('Alpha'),
      `expected the quiz title to name the line and castle, got ${JSON.stringify(title)}`);
    const slot = await appCQ.page.evaluate(() => document.querySelector('.objlist-quiz-slot').textContent);
    assert(slot === 'Castle Quiz List #1', `expected the slot label to carry the source list's own name, got ${JSON.stringify(slot)}`);
    await appCQ.page.fill('#olq_answer', 'Alpha Item');
    await appCQ.page.click('#olq_submit');
    await appCQ.page.click('#olq_submit');   // Next
    await appCQ.page.fill('#olq_answer', 'bet');   // 3-letter prefix of "Beta Item"
    await appCQ.page.click('#olq_submit');
    await appCQ.page.click('#olq_submit');   // Finish
    await appCQ.page.waitForSelector('.objlist-quiz-score', { timeout: 5000 });
    const tally = await appCQ.page.evaluate(() => document.getElementById('objlistQuiz').textContent);
    assert(/2 hits/.test(tally) && /0 misses/.test(tally), `expected 2 hits, 0 misses, got ${JSON.stringify(tally)}`);
    ok('Quiz a Castle: combines the assigned list\'s items into one quiz, ending on the right tally');
  } catch(e){ bad('Quiz a Castle: end-to-end quiz run', e); }

  // 174. "Done" from the summary returns to the list grid, not the editor.
  try {
    await appCQ.page.click('#olq_done');
    await appCQ.page.waitForSelector('#objlistGrid', { state: 'visible', timeout: 5000 });
    const quizHidden = await appCQ.page.evaluate(() => document.getElementById('objlistQuiz').style.display === 'none');
    assert(quizHidden, 'expected "Done" to hide the quiz panel and return to the list grid');
    ok('Quiz a Castle: "Done" returns to the list grid');
  } catch(e){ bad('Quiz a Castle: returns to the grid when done', e); }
} finally {
  await appCQ.close();
}
} catch(e){ bad('Phase AY3C: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase AY3D: each object list's card (and its own editor) shows which
//     castle(s) actually use it -- "Unused", the single castle's name, or
//     "<castle> + N more" -- requested live so a list can be assigned to
//     only ONE castle at a time without accidentally reusing it and
//     colliding two rooms' worth of associations in memory. Reuses the same
//     usageByListId() provider "Quiz a Castle's Lists" already needed (see
//     Phase AY3C), so this is seeded via threeLayout the same way -- no VR
//     walk needed. ---
if(shouldRunPhase(['object-lists'])){
try {
const appLU = await launchApp();
try {
  const rootKeyFor = (page, lineId, castleName, moves) => page.evaluate(({ lineId, castleName, moves }) => {
    const c = new Chess();
    for(const m of moves) c.move(m, { sloppy: true });
    return `cas:${lineId}_${castleName}:` + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  }, { lineId, castleName, moves });
  const alphaKey = await rootKeyFor(appLU.page, 'L1', 'Alpha', ['d4','Nf6','c4']);
  const betaKey = await rootKeyFor(appLU.page, 'L2', 'Beta', ['e4','e5','Nf3']);
  const gammaKey = await rootKeyFor(appLU.page, 'L3', 'Gamma', ['c4','e5','Nc3']);
  await seedBackup(appLU.page, {
    version: 6, user: 'tester',
    lines: [
      { id: 'L1', name: 'Line A', color: 'white', openingMoves: ['d4'], prefs: [
        { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      ]},
      { id: 'L2', name: 'Line B', color: 'white', openingMoves: ['e4'], prefs: [
        { seq: ['e4','e5'], reply: 'Nf3', isCastleRoot: true, castleName: 'Beta', castleStreetNumber: 1 },
      ]},
      { id: 'L3', name: 'Line C', color: 'white', openingMoves: ['c4'], prefs: [
        { seq: ['c4','e5'], reply: 'Nc3', isCastleRoot: true, castleName: 'Gamma', castleStreetNumber: 1 },
      ]},
    ],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'e4 e5 Nf3', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'c4 e5 Nc3', white: 'a', black: 'b', result: '*' },
    ],
    objectLists: [
      // used by BOTH Alpha and Beta -- exercises the "+ N more" form.
      { id: 'shared_list', name: 'Shared List', roomName: '', category: '',
        orderingType: 'procedural', orderingRule: '',
        items: [{ name: 'Thing', assetId: null }],
        mnemonic: { type: 'generated_phrase', initialism: '', phrase: '', source: '' } },
      // used by exactly one castle -- exercises the plain single-castle form.
      { id: 'solo_list', name: 'Solo List', roomName: '', category: '',
        orderingType: 'procedural', orderingRule: '',
        items: [{ name: 'Thing', assetId: null }],
        mnemonic: { type: 'generated_phrase', initialism: '', phrase: '', source: '' } },
      // assigned nowhere -- exercises "Unused".
      { id: 'idle_list', name: 'Idle List', roomName: '', category: '',
        orderingType: 'procedural', orderingRule: '',
        items: [{ name: 'Thing', assetId: null }],
        mnemonic: { type: 'generated_phrase', initialism: '', phrase: '', source: '' } },
    ],
    threeLayout: JSON.stringify({
      [alphaKey]: { wallLists: { all: { listId: 'shared_list' } } },
      [betaKey]: { wallLists: { all: { listId: 'shared_list' } } },
      [gammaKey]: { wallLists: { all: { listId: 'solo_list' } } },
    }),
  });
  await appLU.page.evaluate(() => document.getElementById('menuObjectLists').click());
  await appLU.page.waitForSelector('#objlistGrid .objlist-card', { timeout: 5000 });

  const cardUsage = (name) => appLU.page.evaluate((n) => {
    const card = [...document.querySelectorAll('#objlistGrid .objlist-card')]
      .find(c => c.querySelector('.objlist-card-name')?.textContent === n);
    const el = card && card.querySelector('.objlist-card-usage');
    return el ? { text: el.textContent, unused: el.classList.contains('objlist-card-unused') } : null;
  }, name);

  // 175. A list used by two castles shows "<first castle> + 1 more".
  try {
    const usage = await cardUsage('Shared List');
    assert(usage && usage.text === 'Alpha + 1 more',
      `expected "Alpha + 1 more" for a list used by 2 castles, got ${JSON.stringify(usage)}`);
    assert(!usage.unused, 'expected a used list\'s card NOT to carry the "unused" styling class');
    ok('object list card: a list used by 2 castles shows "<first castle> + 1 more"');
  } catch(e){ bad('object list card: multi-castle usage summary', e); }

  // 176. A list used by exactly one castle shows that castle's own name.
  try {
    const usage = await cardUsage('Solo List');
    assert(usage && usage.text === 'Gamma', `expected the single using castle's own name, got ${JSON.stringify(usage)}`);
    ok('object list card: a list used by exactly one castle shows its name');
  } catch(e){ bad('object list card: single-castle usage summary', e); }

  // 177. A list used nowhere shows "Unused", styled distinctly.
  try {
    const usage = await cardUsage('Idle List');
    assert(usage && usage.text === 'Unused', `expected "Unused" for a list with no castle usage, got ${JSON.stringify(usage)}`);
    assert(usage.unused, 'expected an unused list\'s card to carry the "unused" styling class');
    ok('object list card: a list used nowhere shows "Unused"');
  } catch(e){ bad('object list card: unused summary', e); }

  // 178. The details/editor view lists EVERY castle using the list, each
  //      disambiguated with its own opening-system (line) name.
  try {
    await appLU.page.evaluate(() => {
      const card = [...document.querySelectorAll('#objlistGrid .objlist-card')]
        .find(c => c.querySelector('.objlist-card-name')?.textContent === 'Shared List');
      card.click();
    });
    await appLU.page.waitForSelector('#ol_id', { timeout: 5000 });
    const usedInText = await appLU.page.evaluate(() => {
      const h3 = [...document.querySelectorAll('#objlistEditor h3')].find(h => h.textContent.trim() === 'Used in');
      return h3 ? h3.nextElementSibling.textContent : null;
    });
    assert(usedInText && usedInText.includes('Alpha') && usedInText.includes('Line A'),
      `expected the "Used in" section to name Alpha (Line A), got ${JSON.stringify(usedInText)}`);
    assert(usedInText.includes('Beta') && usedInText.includes('Line B'),
      `expected the "Used in" section to also name Beta (Line B), got ${JSON.stringify(usedInText)}`);
    ok('object list editor: "Used in" section lists every using castle with its own line name');
    await appLU.page.evaluate(() => document.getElementById('ol_cancel').click());
  } catch(e){ bad('object list editor: "Used in" section', e); }

  // 179. A brand-new (unsaved) list has no "Used in" section at all -- there's
  //      no id yet for any castle to have possibly used.
  try {
    await appLU.page.waitForSelector('#objlistGrid .objlist-card', { timeout: 5000 });
    await appLU.page.click('#objlistNewBtn');
    await appLU.page.waitForSelector('#ol_id', { timeout: 5000 });
    const hasUsedInSection = await appLU.page.evaluate(() =>
      [...document.querySelectorAll('#objlistEditor h3')].some(h => h.textContent.trim() === 'Used in'));
    assert(!hasUsedInSection, 'expected a brand-new unsaved list to have no "Used in" section');
    ok('object list editor: a brand-new unsaved list has no "Used in" section');
    await appLU.page.evaluate(() => document.getElementById('ol_cancel').click());
  } catch(e){ bad('object list editor: no "Used in" section for a new list', e); }
} finally {
  await appLU.close();
}
} catch(e){ bad('Phase AY3D: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase AZ2: "Compare Games" (three-dot menu) -- one row per move you've
//     actually played from this exact line in your own games (not a modal,
//     unlike "Browse Games"). The header row carries the node's own configured
//     standard reply, boldfaced, with its eval read straight from that real
//     child node's own PREFS entry; every OTHER played move gets its own
//     indented row below, sorted by count. "Analyze Others" (the header's
//     bolt icon) background-analyzes all the "other" rows at once, at a
//     shallow, independently-configured depth, jumped to the front of the
//     analysis queue (interrupting whatever's running) and run at the live
//     engine panel's own thread count. ---
if(shouldRunPhase(['move-table'])){
try {
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
      // all White (tester's own White-line moves) -- Compare Games now only
      // counts games where the user actually played the line's own color.
      { id: 'g1', moves: 'd4 Nf6 c4 e6', players: pWhite('opp1') },    // played the configured standard (c4) x1 -- included, boldfaced
      { id: 'g2', moves: 'd4 Nf6 Nf3 g6', players: pWhite('opp2') },   // alternate: Nf3 x1
      { id: 'g3', moves: 'd4 Nf6 Nf3 d5', players: pWhite('opp3') },   // alternate: Nf3 x2 total
      { id: 'g4', moves: 'd4 Nf6 g3 g6', players: pWhite('opp4') },    // alternate: g3 x1
      { id: 'g5', moves: 'd4 g6 c4 Bg7', players: pWhite('opp5') },    // no reply configured here: c4 x1
      { id: 'g6', moves: 'd4 g6 Nf3 Bg7', players: pWhite('opp6') },   // Nf3 x2 total
      { id: 'g7', moves: 'd4 g6 Nf3 d6', players: pWhite('opp7') },
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
} catch(e){ bad("phase @ line 8452 (tags: ['move-table'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
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
try {
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
      // tester played Black in all of these -- a Black line's Compare Games
      // only counts games where tester was actually Black.
      { id: 'g1', moves: 'e4 e5 Nf3 Nc6', players: pBlack('opp1') },
      { id: 'g2', moves: 'e4 c5 Nf3 d6', players: pBlack('opp2') },
      { id: 'g3', moves: 'e4 c5 Nf3 Nc6', players: pBlack('opp3') },
      { id: 'g4', moves: 'e4 e6 d4 d5', players: pBlack('opp4') },
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
} catch(e){ bad("phase @ line 8789 (tags: ['move-table'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase BC2: Compare Games rows also show each move's win/loss/draw
//     record ("+W =D −L", the same notation "Browse Games"' own summary line
//     uses), computed from the SAME userColorInGame/gameOutcomeForUser
//     helpers. Only games where tester actually played CURRENT_LINE's own
//     color count at all (toward the play count, not just the record) --
//     a legacy bare/unknown-color game, or one where tester played the
//     OTHER side (an opponent's choice, not tester's own repertoire move),
//     is excluded outright, not just missing a record. ---
if(shouldRunPhase(['move-table'])){
try {
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
      // tester played BLACK here (an opponent's 1.d4, not tester's own White
      // prep) -- reaches "d4 Nf6" by move text but must be excluded entirely,
      // not just missing a record. If it leaked in, it'd inflate Nf3 to 3x.
      { id: 'g5', moves: 'd4 Nf6 Nf3 e5',
        players: { white: { user: { name: 'opp5' } }, black: { user: { name: 'tester' } } } },
    ],
  });
  await appBC2.page.click('.line-row');
  await appBC2.page.waitForSelector('tr.data-row[data-seq="d4,Nf6"]', { timeout: 10000 });
  const rowSel = 'tr.data-row[data-seq="d4,Nf6"]';

  // 170. c4 (the standard, 1 win) shows "+1=+1 =0 −0" on the header row --
  //      a leading colour-coded NET score (wins minus losses), then the
  //      full breakdown; Nf3 (1 loss, 1 draw) shows "-1=+0 =1 −1"; g3
  //      (1 win) shows "+1=+1 =0 −0".
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
          count: r.querySelector('em').textContent.trim(),
          record: rowRecord(r),
          winClass: winClass(r),
        })),
        isRealTable: meta.querySelector('.meta-actual-alt-table')?.tagName === 'TABLE'
          && meta.querySelectorAll('.meta-actual-alt-table tr.meta-actual-alt-row').length === 2,
      };
    }, rowSel);
    assert(state.standard === '+1=+1 =0 −0', `expected the standard's (c4) record "+1=+1 =0 −0", got "${state.standard}"`);
    assert(state.standardWinClass === 'meta-actual-record-good', `expected the standard's net score coloured "good" (net +1), got "${state.standardWinClass}"`);
    const nf3 = state.alts.find(a => a.move === 'Nf3'), g3 = state.alts.find(a => a.move === 'g3');
    assert(nf3?.count === '(2×)', `expected Nf3's count to stay 2x (g5, where tester played Black, must be excluded), got "${nf3?.count}"`);
    assert(nf3?.record === '-1=+0 =1 −1', `expected Nf3's record "-1=+0 =1 −1", got "${JSON.stringify(nf3)}"`);
    assert(nf3?.winClass === 'meta-actual-record-bad', `expected Nf3's net score coloured "bad" (net -1), got "${nf3?.winClass}"`);
    assert(g3?.record === '+1=+1 =0 −0', `expected g3's record "+1=+1 =0 −0", got "${JSON.stringify(g3)}"`);
    assert(g3?.winClass === 'meta-actual-record-good', `expected g3's net score coloured "good" (net +1), got "${g3?.winClass}"`);
    assert(state.isRealTable, 'expected the "other move" rows to be a real <table> (Nf3 + g3 as <tr>s), so their columns actually align');
    ok('Compare Games: each row shows its own win/loss/draw record (net score colour-coded), aligned in a real table');
  } catch(e){ bad('Compare Games: win/loss/draw record per row', e); }
} finally {
  await appBC2.close();
}
} catch(e){ bad("phase @ line 8862 (tags: ['move-table'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
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
try {
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
      // tester played White here -- the White line's move table only
      // counts games where tester actually played White.
      { id: 'g1', moves: 'd4 Nf6 c4 e6', players: pWhite('opp1') },
      // tester played Black in both -- the Black line's Compare Games only
      // counts games where tester actually played Black.
      { id: 'g2', moves: 'e4 e5 Nf3 Nc6', players: pBlack('opp2') },   // matches the configured Black reply (e5) -- boldfaced in the header, not excluded
      { id: 'g3', moves: 'e4 c5 Nf3 d6', players: pBlack('opp3') },    // divergent: Black played c5 instead
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
} catch(e){ bad("phase @ line 8944 (tags: ['move-table'])" + ': uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase BW: five row-menu actions that no test ever clicked before now --
//     Add to Analysis Queue, Node Statistics, Quiz this Variation, Add
//     Opponent Move, and Remove This Move (the manual-reply counterpart). ---
if(shouldRunPhase(['move-table'])){
try {
const appBW = await launchApp();
try {
  await seedBackup(appBW.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
    ]}],
    games: [ { id: 'g1', moves: 'd4 Nf6 c4 e6', white: 'a', black: 'b', result: '*' } ],
  }, { defaultPlayerColor: 'white' });
  await appBW.page.click('.line-row');
  const rowSel = 'tr.data-row[data-seq="d4,Nf6"]';
  await appBW.page.waitForSelector(rowSel, { timeout: 10000 });

  // 176. "Add to Analysis Queue" opens the single-seq Add modal (untitled
  //      with a child count, unlike the multi-child "Add Children" action)
  //      and queues exactly that one seq.
  try {
    await appBW.page.evaluate(s => document.querySelector(`${s} .rowMenuBtn`).click(), rowSel);
    await appBW.page.evaluate(s => document.querySelector(`${s} [data-act="addToAnalysisQueue"]`).click(), rowSel);
    await appBW.page.waitForSelector('#analysisAddOverlay', { state: 'visible', timeout: 5000 });
    const title = await appBW.page.evaluate(() => document.getElementById('analysisAddTitle').textContent);
    assert(title === 'Add to Analysis Queue', `expected the single-seq modal title, got "${title}"`);
    await appBW.page.evaluate(() => document.getElementById('analysisAddGoBtn').click());
    await appBW.page.waitForFunction(() => window.__aqTestHooks.getQueue().length === 1, { timeout: 5000 });
    const q = await appBW.page.evaluate(() => window.__aqTestHooks.getQueue());
    assert(q[0].seq.join(',') === 'd4,Nf6', `expected the row's own seq queued, got ${JSON.stringify(q[0].seq)}`);
    ok('row menu: "Add to Analysis Queue" queues this row\'s own seq');
  } catch(e){ bad('row menu: Add to Analysis Queue', e); }

  // 177. "Node Statistics" shows an alert with the node count / branch factor
  //      for this row's children (childrenSeq, i.e. past the standard reply).
  try {
    let alertMsg = null;
    appBW.page.once('dialog', d => { alertMsg = d.message(); });
    await appBW.page.evaluate(s => document.querySelector(`${s} .rowMenuBtn`).click(), rowSel);
    await appBW.page.evaluate(s => document.querySelector(`${s} [data-act="nodeStats"]`).click(), rowSel);
    await appBW.page.waitForTimeout(400);
    assert(alertMsg && /Nodes below this point/.test(alertMsg), `expected the node-stats alert, got: ${alertMsg}`);
    ok('row menu: "Node Statistics" shows the node-count/branch-factor alert');
  } catch(e){ bad('row menu: Node Statistics', e); }

  // 178. "Quiz this Variation" calls openOpeningQuiz -- in this harness the
  //      cm-chessboard widget is deliberately unmocked (see test/README.md),
  //      so the reachable, real behavior is the same "could not be loaded"
  //      degradation the Test > Chessboard menu item already falls back to;
  //      this proves the row button is actually wired to the real function
  //      (it wasn't clicked by any prior test) rather than confirming the
  //      full quiz flow, which needs a real board library to observe.
  try {
    let alertMsg = null;
    appBW.page.once('dialog', d => { alertMsg = d.message(); });
    await appBW.page.evaluate(s => document.querySelector(`${s} .rowMenuBtn`).click(), rowSel);
    await appBW.page.evaluate(s => document.querySelector(`${s} [data-act="openingQuiz"]`).click(), rowSel);
    await appBW.page.waitForTimeout(300);
    assert(alertMsg && /could not be loaded/i.test(alertMsg), `expected the chessboard-unavailable alert, got: ${alertMsg}`);
    ok('row menu: "Quiz this Variation" reaches openOpeningQuiz (degrades gracefully without cm-chessboard)');
  } catch(e){ bad('row menu: Quiz this Variation', e); }

  // 179-180. "Add Opponent Move" records a manual try under this row's
  //          children (a new data-row appears with a 0 count); the new
  //          row's own menu then offers "Remove This Move" (only shown for
  //          manual replies), which removes it again.
  try {
    await appBW.page.evaluate(s => document.querySelector(`${s} .rowMenuBtn`).click(), rowSel);
    await appBW.page.evaluate(s => document.querySelector(`${s} [data-act="addMove"]`).click(), rowSel);
    await appBW.page.waitForSelector('#fieldOverlay', { state: 'visible', timeout: 5000 });
    await appBW.page.fill('#fieldModalInput', 'g6');
    await appBW.page.evaluate(() => document.getElementById('fieldModalSaveBtn').click());
    const manualSel = 'tr.data-row[data-seq="d4,Nf6,c4,g6"]';
    await appBW.page.waitForSelector(manualSel, { timeout: 5000 });
    ok('row menu: "Add Opponent Move" records a manual try as a new child row');
  } catch(e){ bad('row menu: Add Opponent Move', e); }

  try {
    const manualSel = 'tr.data-row[data-seq="d4,Nf6,c4,g6"]';
    await appBW.page.evaluate(s => document.querySelector(`${s} .rowMenuBtn`).click(), manualSel);
    const removeVisible = await appBW.page.evaluate(s =>
      getComputedStyle(document.querySelector(`${s} [data-act="removeManual"]`)).display !== 'none', manualSel);
    assert(removeVisible, 'expected "Remove This Move" to be visible on a manually-added row');
    await appBW.page.evaluate(s => document.querySelector(`${s} [data-act="removeManual"]`).click(), manualSel);
    await appBW.page.waitForSelector(manualSel, { state: 'detached', timeout: 5000 });
    ok('row menu: "Remove This Move" removes the manual try again');
  } catch(e){ bad('row menu: Remove This Move', e); }

  assert(realErrors(appBW.consoleErrors).length === 0,
    'unexpected console errors:\n' + realErrors(appBW.consoleErrors).join('\n'));
} finally {
  await appBW.close();
}
} catch(e){ bad('Phase BW: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase BX: doors (and elevators) now teleport in VR edit mode too --
//     previously blocked outright, leaving no way to reach the next room
//     short of exiting edit mode first. enterRoom clears any selected prop
//     and refreshes the edit HUD on every transition so edit mode carries
//     over cleanly instead of leaving stale state (a dangling selection
//     that would hijack arrow-key input into nudging an object back in the
//     room you just left). ---
if(shouldRunPhase(['vr-castle'])){
try {
const appBX = await launchApp();
try {
  await seedBackup(appBX.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      // the root needs a SECOND branch (g6) or the whole e6/Nc3/Bb4/e3 chain
      // merges into one corridor room WITH the root itself (a single-branch
      // root is just the first member of the run, not its own separate
      // room) -- confirmed via the Castle Preview report while building this
      // test ("1 rooms (1 corridor)"). With two branches the root stays its
      // own 'branch' room with two real doors.
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      // e6's own room also needs further built content (a second reply below
      // it) so it isn't a genuine dead end -- isRoomEmpty would otherwise
      // make the root's e6 door a LOCKED one (correctly, by design: nothing
      // built past it), leaving nothing for this test to walk through.
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'e3' },
      { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },   // g6 stays a locked leaf; unused by this test
    ]}],
    games: [
      { id:'g1', moves:'d4 Nf6 c4 e6 Nc3 Bb4', white:'a', black:'b', result:'*' },
      { id:'g2', moves:'d4 Nf6 c4 g6 Nc3 Bg7', white:'a', black:'b', result:'*' },
    ],
  }, { defaultPlayerColor: 'white' });
  await appBX.page.click('.line-row');
  await appBX.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await appBX.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await appBX.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await appBX.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await appBX.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await appBX.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await appBX.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await appBX.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await appBX.page.waitForTimeout(400);

  // 179. Walking forward through a door in edit mode reaches the next room
  //      (previously blocked entirely) and edit mode stays ON. No prop is
  //      selected here -- selecting one swallows ALL non-nudge keys,
  //      including w/ArrowUp (see onKeyDown's "no walking/turning while
  //      selected" early return), so walking with something selected isn't
  //      a real scenario reachable from the keyboard at all.
  try {
    const r = await appBX.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      dbg.toggle();   // edit mode ON
      const before = dbg.exitInfo();
      if(!before.length) return { err: `no forward exit found, got ${JSON.stringify(before)}` };
      const m = before[0];
      const cx = (m.box.minX + m.box.maxX) / 2, cz = (m.box.minZ + m.box.maxZ) / 2;
      const yawTo = Math.atan2(-m.thru.x, -m.thru.z);
      const roomBefore = window.__threeTestState.room;
      dbg.teleport(cx, cz, yawTo);
      await new Promise(r => setTimeout(r, 700));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      const deadline = Date.now() + 8000;
      while(Date.now() < deadline && window.__threeTestState.room === roomBefore){
        await new Promise(r => setTimeout(r, 150));
      }
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
      return { roomBefore, roomAfter: window.__threeTestState.room, editModeAfter: dbg.editMode() };
    });
    assert(!r.err, r.err);
    assert(r.roomAfter && r.roomAfter !== r.roomBefore,
      `blocked at the door in edit mode -- room did not change (before/after ${r.roomBefore} / ${r.roomAfter})`);
    assert(r.editModeAfter === true, 'expected edit mode to stay ON after walking through the door');
    ok('VR edit mode: walking forward through a door reaches the next room and stays in edit mode');
  } catch(e){ bad('VR edit mode: door teleport unblocked', e); }

  // 180. A prop selected in one room doesn't carry over once ANY room
  //      transition fires (enterRoom is the single funnel point -- doors,
  //      elevators, and also the touch joystick, which unlike keyboard
  //      input isn't blocked by a selection at all, so this IS a reachable
  //      real-world path even though walking-by-keyboard isn't). Drives the
  //      transition directly via dbg.enter rather than fighting the
  //      selected-prop key-swallowing above, since what's under test is
  //      enterRoom's own cleanup, not any particular trigger mechanism.
  try {
    const r = await appBX.page.evaluate(() => {
      const dbg = window.__threeTestEdit;
      // this room's OWN center pair (mnem-C1) renders at its PARENT's door,
      // not in-room (see isRoomEmpty's doc comment) -- mnem-L1 (this
      // corridor's 2nd member) is what's actually placed here to select.
      dbg.target({ kind: 'accessory', slotId: 'mnem-L1' });
      const selectedBefore = dbg.selected();
      // the back exit (the door we walked in through) is always present and
      // guaranteed valid within this ephemeral castle-preview session --
      // unlike 'mainStreet', which this session never registers at all.
      const back = dbg.exits().find(e => e.back);
      dbg.enter(back.target);
      return { selectedBefore, selectedAfter: dbg.selected(), editModeAfter: dbg.editMode() };
    });
    assert(r.selectedBefore, `test setup issue: selecting the anchor pair didn't stick, got ${JSON.stringify(r.selectedBefore)}`);
    assert(r.selectedAfter === null, `expected the prior room's selection to be cleared, got ${JSON.stringify(r.selectedAfter)}`);
    assert(r.editModeAfter === true, 'expected edit mode to stay ON across the transition');
    ok('VR edit mode: a selected prop is cleared on any room transition (enterRoom)');
  } catch(e){ bad('VR edit mode: selection cleared on room transition', e); }

  // 181. B instantly takes the room's own back door -- no walking required.
  try {
    const r = await appBX.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      // start back at the root (dbg.enter from the previous check landed here)
      const root = dbg.room();
      const fwd = dbg.exitInfo();
      if(!fwd.length) return { err: `no forward exit from root, got ${JSON.stringify(fwd)}` };
      dbg.enter(fwd[0].target);   // jump into the child room, as if just walked in
      const child = dbg.room();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
      await new Promise(res => setTimeout(res, 700));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'b' }));
      return { root, child, roomAfterB: dbg.room() };
    });
    assert(!r.err, r.err);
    assert(r.child !== r.root, `test setup issue: entering the forward exit should land in a different room, stayed at ${r.root}`);
    assert(r.roomAfterB === r.root, `expected B to take the room's own back door to ${r.root}, got ${r.roomAfterB}`);
    ok('VR: B instantly takes the current room\'s own back door');
  } catch(e){ bad('VR: B key (instant back door)', e); }

  // 182. B is a harmless no-op where there's no back exit at all -- the
  //      castle's own root/entry room, in this ephemeral preview session
  //      (no backToStreet door here; see the earlier "always present...
  //      unlike mainStreet" comment -- this session never registers a real
  //      street either, so the root is the one guaranteed backless room).
  try {
    const r = await appBX.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      const before = dbg.room();   // test 181 left us back at the root
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
      await new Promise(res => setTimeout(res, 400));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'b' }));
      return { before, after: dbg.room() };
    });
    assert(r.after === r.before, `expected B with no back exit to be a no-op, went from ${r.before} to ${r.after}`);
    ok('VR: B is a no-op in a room with no back exit');
  } catch(e){ bad('VR: B key no-op without a back exit', e); }
} finally {
  await appBX.close();
}
} catch(e){ bad('Phase BX: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase BY: R and H were swapped -- R now resets to the CURRENT room's
//     own entrance (previously it always jumped all the way to Main Street);
//     H is the new "go all the way back to Main Street" shortcut (what R
//     used to do). On Main Street itself, R matches H (no separate
//     "entrance" to distinguish there). ---
if(shouldRunPhase(['vr-castle'])){
try {
const appBY = await launchApp();
try {
  await seedBackup(appBY.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [ { id:'g1', moves:'d4 Nf6 c4 e6', white:'a', black:'b', result:'*' } ],
  }, { defaultPlayerColor: 'white' });
  await appBY.page.click('.line-row');
  await appBY.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await appBY.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await appBY.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await appBY.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await appBY.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await appBY.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await appBY.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await appBY.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await appBY.page.waitForTimeout(400);

  // 181. R resets to the current (castle) room's own entrance, not Main
  //      Street -- and stays in that room.
  try {
    const r = await appBY.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      const roomBefore = dbg.room();
      const expected = dbg.entrySpawnFor(roomBefore);
      dbg.teleport(3, -3, 1.2);   // wander off from the entrance
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
      await new Promise(res => setTimeout(res, 700));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'r' }));
      return { roomBefore, roomAfter: dbg.room(), pos: dbg.pos(), expected };
    });
    assert(r.roomAfter === r.roomBefore, `R should stay in the same room, went from ${r.roomBefore} to ${r.roomAfter}`);
    assert(Math.abs(r.pos.x - r.expected.x) < 0.05 && Math.abs(r.pos.z - r.expected.z) < 0.05,
      `expected R to land at this room's entrySpawnFor ${JSON.stringify(r.expected)}, got ${JSON.stringify(r.pos)}`);
    ok('R resets to the current room\'s own entrance (not Main Street)');
  } catch(e){ bad('VR keys: R resets to this room\'s own entrance', e); }

  // 182. H is the new "return all the way to Main Street" shortcut (R's old job).
  try {
    const r = await appBY.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      const start = dbg.startSpawn();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' }));
      const deadline = Date.now() + 8000;
      while(Date.now() < deadline && dbg.room() !== start.room){
        await new Promise(res => setTimeout(res, 150));
      }
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'h' }));
      return { room: dbg.room(), pos: dbg.pos(), start };
    });
    assert(r.room === r.start.room, `expected H to land on Main Street (${r.start.room}), got ${r.room}`);
    assert(Math.abs(r.pos.x - r.start.x) < 0.05 && Math.abs(r.pos.z - r.start.z) < 0.05,
      `expected H to land at the true start spawn ${JSON.stringify(r.start)}, got ${JSON.stringify(r.pos)}`);
    ok('H resets all the way back to Main Street (the old R behavior)');
  } catch(e){ bad('VR keys: H resets to Main Street', e); }

  // 183. On Main Street itself, R matches H -- there's no separate
  //      "entrance" distinct from the street's own start there.
  try {
    const r = await appBY.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      const start = dbg.startSpawn();
      dbg.teleport(start.x + 20, start.z + 20, 0.5);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
      await new Promise(res => setTimeout(res, 700));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'r' }));
      return { room: dbg.room(), pos: dbg.pos(), start };
    });
    assert(r.room === r.start.room, `expected R on Main Street to stay on Main Street, got ${r.room}`);
    assert(Math.abs(r.pos.x - r.start.x) < 0.05 && Math.abs(r.pos.z - r.start.z) < 0.05,
      `expected R on Main Street to match the true start spawn ${JSON.stringify(r.start)}, got ${JSON.stringify(r.pos)}`);
    ok('R on Main Street itself matches H (no separate entrance to distinguish)');
  } catch(e){ bad('VR keys: R on Main Street matches H', e); }
} finally {
  await appBY.close();
}
} catch(e){ bad('Phase BY: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase BZ: edit-mode undo/redo. Every edit funnels through either
//     applyEdit (structural: skins, geometry) or the two *Live setters
//     (continuous drags: nudge/scale/rotate), so a single generic
//     snapshot-before-mutation hook (snapshotLayoutForUndo/
//     snapshotForXformEdit) covers all of it. A held-key drag coalesces into
//     ONE undo step regardless of how many individual nudges fired. ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appBZ = await launchApp();
try {
  await seedBackup(appBZ.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [ { id:'g1', moves:'d4 Nf6 c4 e6', white:'a', black:'b', result:'*' } ],
  }, { defaultPlayerColor: 'white' });
  await appBZ.page.click('.line-row');
  await appBZ.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await appBZ.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await appBZ.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await appBZ.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await appBZ.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await appBZ.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await appBZ.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await appBZ.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await appBZ.page.waitForTimeout(400);
  await appBZ.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode ON

  // 184. Undoing with nothing on the stack is a harmless no-op.
  try {
    const depth = await appBZ.page.evaluate(() => window.__threeTestEdit.undoDepth());
    assert(depth === 0, `expected an empty undo stack on a fresh room, got ${depth}`);
    await appBZ.page.evaluate(() => window.__threeTestEdit.undo());
    const stillZero = await appBZ.page.evaluate(() => window.__threeTestEdit.undoDepth());
    assert(stillZero === 0, `undo with nothing to undo should stay a no-op, got depth ${stillZero}`);
    ok('undo/redo: undoing with an empty stack is a harmless no-op');
  } catch(e){ bad('undo/redo: empty-stack no-op', e); }

  // 185. A structural edit (room resize, via applyEdit) is undoable/redoable.
  try {
    const roomKey = await appBZ.page.evaluate(() => window.__threeTestEdit.room());
    const before = await appBZ.page.evaluate(k => window.__threeTestEdit.layoutSnapshot()[k]?.geom || null, roomKey);
    await appBZ.page.evaluate(k => window.__threeTestEdit.resize(k, { w: 20, d: 20, h: 6 }), roomKey);
    const afterResize = await appBZ.page.evaluate(k => window.__threeTestEdit.layoutSnapshot()[k]?.geom, roomKey);
    assert(afterResize && afterResize.w === 20, `expected the resize to land in LAYOUT, got ${JSON.stringify(afterResize)}`);
    const depthAfter = await appBZ.page.evaluate(() => window.__threeTestEdit.undoDepth());
    assert(depthAfter === 1, `expected exactly one undo step for one resize call, got ${depthAfter}`);

    await appBZ.page.evaluate(() => window.__threeTestEdit.undo());
    const afterUndo = await appBZ.page.evaluate(k => window.__threeTestEdit.layoutSnapshot()[k]?.geom || null, roomKey);
    assert(JSON.stringify(afterUndo) === JSON.stringify(before), `expected the resize undone, got ${JSON.stringify(afterUndo)} (wanted ${JSON.stringify(before)})`);
    const redoDepth = await appBZ.page.evaluate(() => window.__threeTestEdit.redoDepth());
    assert(redoDepth === 1, `expected the undone edit to land on the redo stack, got depth ${redoDepth}`);

    await appBZ.page.evaluate(() => window.__threeTestEdit.redo());
    const afterRedo = await appBZ.page.evaluate(k => window.__threeTestEdit.layoutSnapshot()[k]?.geom, roomKey);
    assert(afterRedo && afterRedo.w === 20, `expected redo to bring the resize back, got ${JSON.stringify(afterRedo)}`);
    ok('undo/redo: a structural edit (room resize) is undoable and redoable');
  } catch(e){ bad('undo/redo: structural edit (resize)', e); }

  // 186-187. A held-key drag (many rapid nudges on the same prop) coalesces
  //          into ONE undo step, not one per keypress; undoing it restores
  //          the prop's original position; the real Ctrl+Z / Ctrl+Shift+Z key
  //          bindings drive the same undo/redo (not just the test hooks).
  try {
    const r = await appBZ.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      dbg.target({ kind: 'accessory', slotId: 'mnem-C1' });
      const before = dbg.posOf('mnem-C1');
      const depthBefore = dbg.undoDepth();
      for(let i = 0; i < 15; i++){
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
        await new Promise(res => setTimeout(res, 20));
      }
      await new Promise(res => setTimeout(res, 100));
      const nudged = dbg.posOf('mnem-C1');
      const depthAfterDrag = dbg.undoDepth();

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
      await new Promise(res => setTimeout(res, 200));
      const afterCtrlZ = dbg.posOf('mnem-C1');

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true }));
      await new Promise(res => setTimeout(res, 200));
      const afterCtrlShiftZ = dbg.posOf('mnem-C1');

      return { before, nudged, depthBefore, depthAfterDrag, afterCtrlZ, afterCtrlShiftZ };
    });
    assert(r.nudged.x > r.before.x + 1, `test setup issue: 15 nudges didn't move the prop far enough, before=${r.before.x} after=${r.nudged.x}`);
    assert(r.depthAfterDrag === r.depthBefore + 1,
      `expected 15 rapid nudges to coalesce into exactly 1 undo step, went from ${r.depthBefore} to ${r.depthAfterDrag}`);
    assert(Math.abs(r.afterCtrlZ.x - r.before.x) < 0.01,
      `expected Ctrl+Z to restore the pre-drag position ${r.before.x}, got ${r.afterCtrlZ.x}`);
    ok('undo/redo: a held-key drag coalesces into one undo step, and Ctrl+Z restores the pre-drag position');
    assert(Math.abs(r.afterCtrlShiftZ.x - r.nudged.x) < 0.01,
      `expected Ctrl+Shift+Z (redo) to restore the post-drag position ${r.nudged.x}, got ${r.afterCtrlShiftZ.x}`);
    ok('undo/redo: Ctrl+Shift+Z (real key binding) redoes the drag');
  } catch(e){ bad('undo/redo: coalesced drag + real Ctrl+Z/Ctrl+Shift+Z key bindings', e); }
} finally {
  await appBZ.close();
}
} catch(e){ bad('Phase BZ: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CA: Object List Manager index is now a two-level browse --
//     a category grid (Home, Zoo, ...) at the top, drilling into one
//     category's own list-cards on click -- the flat alphabetical grid
//     buried everything together once the room database grew past a
//     handful of categories. A single-category collection (or none at all)
//     skips the picker entirely, straight to the list grid, since there's
//     nothing meaningful to choose between. Search always spans every
//     category regardless of the current view. ---
if(shouldRunPhase(['object-lists'])){
try {
const appCA = await launchApp();
try {
  await appCA.page.evaluate(() => document.getElementById('menuObjectLists').click());
  await appCA.page.waitForSelector('#objectListsOverlay', { state: 'visible', timeout: 5000 });

  // 188. Importing lists across two categories shows the CATEGORY grid, not
  //      list cards directly -- and with the right per-category counts.
  try {
    await appCA.page.setInputFiles('#objlistImportFile', {
      name: 'rooms.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        rooms: [
          { name: 'Kitchen', category: 'Home', lists: [
            { name: 'Fixtures', items: ['Oven', 'Sink'] },
          ]},
          { name: 'Bathroom', category: 'Home', lists: [
            { name: 'Fittings', items: ['Toilet', 'Sink 2'] },
          ]},
          { name: 'Reptile House', category: 'Zoo', lists: [
            { name: 'Snakes', items: ['Cobra', 'Python'] },
          ]},
        ],
      })),
    });
    await appCA.page.waitForSelector('#objlistGrid .objlist-category-card', { timeout: 5000 });
    const cats = await appCA.page.evaluate(() => [...document.querySelectorAll('#objlistGrid .objlist-category-card')].map(c => ({
      name: c.querySelector('.objlist-category-name').textContent,
      count: c.querySelector('.objlist-card-count').textContent,
    })));
    assert(cats.length === 2, `expected 2 category cards (Home, Zoo), got ${cats.length}: ${JSON.stringify(cats)}`);
    const home = cats.find(c => c.name === 'Home'), zoo = cats.find(c => c.name === 'Zoo');
    assert(home && /^2 list/.test(home.count), `expected Home to show 2 lists, got ${JSON.stringify(home)}`);
    assert(zoo && /^1 list/.test(zoo.count), `expected Zoo to show 1 list, got ${JSON.stringify(zoo)}`);
    const noListCardsYet = await appCA.page.evaluate(() => document.querySelectorAll('#objlistGrid .objlist-card').length === 0);
    assert(noListCardsYet, 'expected no list-cards visible before drilling into a category');
    ok('Object List Manager: multiple categories show a category grid, not list cards');
  } catch(e){ bad('Object List Manager: category grid on import', e); }

  // 189. Clicking a category drills into just that category's list-cards,
  //      with a breadcrumb back button.
  try {
    await appCA.page.evaluate(() => {
      const card = [...document.querySelectorAll('#objlistGrid .objlist-category-card')].find(c => c.textContent.includes('Home'));
      card.click();
    });
    await appCA.page.waitForSelector('#objlistGrid .objlist-card', { timeout: 5000 });
    const state = await appCA.page.evaluate(() => ({
      crumbVisible: getComputedStyle(document.getElementById('objlistBreadcrumb')).display !== 'none',
      crumbText: document.getElementById('objlistBreadcrumb').textContent,
      cardNames: [...document.querySelectorAll('#objlistGrid .objlist-card .objlist-card-name')].map(n => n.textContent),
    }));
    assert(state.crumbVisible, 'expected the breadcrumb (back button) to be visible once drilled into a category');
    assert(/Home/.test(state.crumbText), `expected the breadcrumb to name the current category, got "${state.crumbText}"`);
    assert(state.cardNames.length === 2 && state.cardNames.every(n => /Kitchen|Bathroom/.test(n)),
      `expected only Home's 2 lists shown, got ${JSON.stringify(state.cardNames)}`);
    ok('Object List Manager: clicking a category shows only that category\'s lists, with a breadcrumb');
  } catch(e){ bad('Object List Manager: drilling into a category', e); }

  // 190. The back button returns to the category grid.
  try {
    await appCA.page.evaluate(() => {
      const btn = [...document.querySelectorAll('#objlistBreadcrumb button')][0];
      btn.click();
    });
    await appCA.page.waitForSelector('#objlistGrid .objlist-category-card', { timeout: 5000 });
    const backAtTop = await appCA.page.evaluate(() => document.querySelectorAll('#objlistGrid .objlist-category-card').length === 2);
    assert(backAtTop, 'expected the back button to return to the 2-category grid');
    ok('Object List Manager: the breadcrumb back button returns to the category grid');
  } catch(e){ bad('Object List Manager: back button', e); }

  // 191. Searching spans every category regardless of the current view
  //      (search escapes browsing), and clearing the search restores
  //      whatever category view was active before -- drill into Zoo first,
  //      search for something in Home, clear, and confirm still in Zoo.
  try {
    await appCA.page.evaluate(() => {
      const card = [...document.querySelectorAll('#objlistGrid .objlist-category-card')].find(c => c.textContent.includes('Zoo'));
      card.click();
    });
    await appCA.page.waitForSelector('#objlistGrid .objlist-card', { timeout: 5000 });
    await appCA.page.fill('#objlistFilterText', 'Kitchen');
    await appCA.page.waitForFunction(() => {
      const names = [...document.querySelectorAll('#objlistGrid .objlist-card .objlist-card-name')].map(n => n.textContent);
      return names.length === 1 && /Kitchen/.test(names[0]);
    }, { timeout: 5000 });
    const crumbHiddenWhileSearching = await appCA.page.evaluate(() =>
      getComputedStyle(document.getElementById('objlistBreadcrumb')).display === 'none');
    assert(crumbHiddenWhileSearching, 'expected the breadcrumb hidden while a cross-category search is active');
    await appCA.page.fill('#objlistFilterText', '');
    await appCA.page.waitForSelector('#objlistGrid .objlist-card', { timeout: 5000 });
    const backInZoo = await appCA.page.evaluate(() => {
      const names = [...document.querySelectorAll('#objlistGrid .objlist-card .objlist-card-name')].map(n => n.textContent);
      return names.length === 1 && /Snakes/.test(names[0]);
    });
    assert(backInZoo, 'expected clearing the search to restore the Zoo category view (not reset to the category grid)');
    ok('Object List Manager: search spans all categories and clearing it restores the prior category view');
  } catch(e){ bad('Object List Manager: search bypasses/restores category browsing', e); }
} finally {
  await appCA.close();
}
} catch(e){ bad('Phase CA: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CB: the VR Wall Object Lists dialog's <select> now groups its
//     options into per-category <optgroup>s (Category -> list name), same
//     two-level structure as the Object List Manager's card browsing, using
//     the <select> element's own native grouping rather than a custom
//     picker. Lists within a category still sort best-run-length-match
//     first; categories sort alphabetically. ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appCB = await launchApp();
try {
  await seedBackup(appCB.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [ { id:'g1', moves:'d4 Nf6 c4 e6', white:'a', black:'b', result:'*' } ],
    objectLists: [
      { id: 'home_kitchen', name: 'Kitchen: Fixtures', roomName: 'Kitchen', category: 'Home',
        orderingType: 'procedural', orderingRule: '',
        items: [{ name: 'Oven', assetId: null }],
        mnemonic: { type: 'generated_phrase', initialism: '', phrase: '', source: '' } },
      { id: 'zoo_reptiles', name: 'Reptile House: Snakes', roomName: 'Reptile House', category: 'Zoo',
        orderingType: 'natural_ordering', orderingRule: '',
        items: [{ name: 'Cobra', assetId: null }],
        mnemonic: { type: 'generated_phrase', initialism: '', phrase: '', source: '' } },
    ],
  }, { defaultPlayerColor: 'white' });
  await appCB.page.evaluate(() => document.querySelector('.line-row').click());
  await appCB.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await appCB.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await appCB.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await appCB.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await appCB.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await appCB.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await appCB.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await appCB.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await appCB.page.waitForTimeout(400);

  // 192. wallListOptionsHtml groups the two seeded lists under their own
  //      <optgroup> (Home, Zoo), alphabetically, each containing its list.
  try {
    const html = await appCB.page.evaluate(() => {
      const dbg = window.__threeTestEdit;
      return dbg.wallListOptionsHtml(dbg.room(), 'all');
    });
    const groups = [...html.matchAll(/<optgroup label="([^"]+)">(.*?)<\/optgroup>/gs)]
      .map(m => ({ label: m[1], html: m[2] }));
    assert(groups.length === 2, `expected 2 optgroups (Home, Zoo), got ${groups.length}: ${JSON.stringify(groups.map(g=>g.label))}`);
    assert(groups[0].label === 'Home' && groups[1].label === 'Zoo',
      `expected optgroups alphabetically (Home, Zoo), got ${JSON.stringify(groups.map(g=>g.label))}`);
    assert(/Kitchen: Fixtures/.test(groups[0].html), `expected the Home optgroup to contain the Kitchen list, got ${groups[0].html}`);
    assert(/Reptile House: Snakes/.test(groups[1].html), `expected the Zoo optgroup to contain the Reptile House list, got ${groups[1].html}`);
    ok('VR wall-lists dialog: options are grouped into per-category optgroups');
  } catch(e){ bad('VR wall-lists dialog: category optgroups', e); }
} finally {
  await appCB.close();
}
} catch(e){ bad('Phase CB: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase CB2: a wall list assigned to a single-run room's 'all' bucket
//     must skip the center/anchor slot -- its pair is the arrival move
//     (the same pair the previous room's own door object already shows via
//     doorPairContent reusing this room's center slot), not a step of
//     walking THIS room's own sequence. Was giving list item[0] to the
//     center slot, shifting the room's own L1..Ln down by one and
//     reporting one slot too many in bucketSlotCount/the dialog's "N
//     move-pair slots" label. ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appCB2 = await launchApp();
try {
  await seedBackup(appCB2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      // Seq: a 3-member plain corridor (C1 anchor + L1 + L2).
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Seq', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'e3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O', white: 'a', black: 'b', result: '*' },
    ],
    objectLists: [
      { id: 'seq_list', name: 'Seq List', roomName: '', category: '',
        orderingType: 'procedural', orderingRule: '',
        items: [{ name: 'First', assetId: null }, { name: 'Second', assetId: null }],
        mnemonic: { type: 'generated_phrase', initialism: '', phrase: '', source: '' } },
      // an ordering rule but no phrase -- the mnemonic plaque should still
      // mount to show the rule alone (see buildWallListPlaques).
      { id: 'rule_only_list', name: 'Rule Only List', roomName: '', category: '',
        orderingType: 'procedural', orderingRule: 'Size order: smallest to largest',
        items: [{ name: 'First', assetId: null }, { name: 'Second', assetId: null }],
        mnemonic: { type: 'generated_phrase', initialism: '', phrase: '', source: '' } },
    ],
  }, { defaultPlayerColor: 'white' });
  await openVR(appCB2.page);

  const roomKey = await appCB2.page.evaluate(() => {
    const c = new Chess(); for(const m of ['d4','Nf6','c4']) c.move(m,{sloppy:true});
    return 'cas:L1_Seq:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  });
  await appCB2.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
  await appCB2.page.waitForTimeout(200);

  // 193. bucketSlotCount excludes the center slot: a 3-slot room (C1+L1+L2)
  //      reports 2 ("N move-pair slots" in the dialog), matching the room's
  //      own 2-item walk sequence, not the 3 total slots including arrival.
  try {
    const slots = await appCB2.page.evaluate(() => window.__threeTestEdit.moveObjectSlotsFull());
    assert(slots.length === 3, `expected 3 total slots (C1+L1+L2), got ${slots.length}: ${JSON.stringify(slots)}`);
    const need = await appCB2.page.evaluate((k) => window.__threeTestEdit.wallBucketSlotCount(k, 'all'), roomKey);
    assert(need === 2, `expected bucketSlotCount to exclude the center slot (2, not 3), got ${need}`);
    ok('wall lists: bucketSlotCount excludes the center/anchor slot');
  } catch(e){ bad('wall lists: bucketSlotCount excludes center', e); }

  // 194. Assigning a 2-item list to the 'all' bucket gives item[0] ("First")
  //      to L1 and item[1] ("Second") to L2 -- C1 (the arrival pair) gets
  //      no list-driven content at all, not "First".
  try {
    await appCB2.page.evaluate((k) => window.__threeTestEdit.setWallList(k, 'all', 'seq_list'), roomKey);
    await appCB2.page.waitForTimeout(200);
    const c1 = await appCB2.page.evaluate((k) => window.__threeTestEdit.slotListWord(k, 'obj-C1'), roomKey);
    const l1 = await appCB2.page.evaluate((k) => window.__threeTestEdit.slotListWord(k, 'obj-L1'), roomKey);
    const l2 = await appCB2.page.evaluate((k) => window.__threeTestEdit.slotListWord(k, 'obj-L2'), roomKey);
    assert(c1 === null, `expected the center slot to have no list-driven word (arrival pair, not part of the sequence), got ${JSON.stringify(c1)}`);
    assert(l1 === 'First', `expected L1 to get the list's first item, got ${JSON.stringify(l1)}`);
    assert(l2 === 'Second', `expected L2 to get the list's second item, got ${JSON.stringify(l2)}`);
    ok('wall lists: item[0] lands on the room\'s own first (L1) slot, never the center/arrival slot');
  } catch(e){ bad('wall lists: list items map to L1..Ln, skipping center', e); }

  // 195. A list with an ordering rule but no phrase still gets a wall
  //      plaque (showing just the rule) -- was gated on the phrase alone,
  //      silently dropping the whole plaque (rule included) whenever only
  //      the ordering rule was set.
  try {
    await appCB2.page.evaluate((k) => window.__threeTestEdit.setWallList(k, 'all', 'seq_list'), roomKey);
    await appCB2.page.waitForTimeout(200);
    const noPlaque = await appCB2.page.evaluate(() => window.__threeTestEdit.hasWallListPlaque());
    assert(!noPlaque, 'expected no plaque for a list with neither a phrase nor an ordering rule');
    await appCB2.page.evaluate((k) => window.__threeTestEdit.setWallList(k, 'all', 'rule_only_list'), roomKey);
    await appCB2.page.waitForTimeout(200);
    const hasPlaque = await appCB2.page.evaluate(() => window.__threeTestEdit.hasWallListPlaque());
    assert(hasPlaque, 'expected a plaque showing just the ordering rule when the list has one but no phrase');
    ok('wall list mnemonic plaque: shows for an ordering-rule-only list, not gated on a phrase');
  } catch(e){ bad('wall list mnemonic plaque: ordering rule alone is enough to mount it', e); }
} finally {
  await appCB2.close();
}
} catch(e){ bad('Phase CB2: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase CB2b: the "Wall object lists" dialog's own "+ New..." button --
//     both the empty-state ("no lists yet") variant and each bucket's own
//     shortcut -- opens objectLists.js's standalone New List modal (same
//     "escape out and create, then get auto-assigned" pattern as the asset
//     picker's "+ New Asset" button) without leaving the wall-lists dialog,
//     and a list created from a bucket's own button lands assigned to that
//     bucket immediately, no reopen needed. ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appCB2b = await launchApp();
try {
  // same "Seq" 3-slot corridor fixture as Phase CB2, but with NO object
  // lists seeded at all -- the dialog's empty state is exactly what needs
  // its own "+ New List..." entry point.
  await seedBackup(appCB2b.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Seq', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'e3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O', white: 'a', black: 'b', result: '*' },
    ],
  }, { defaultPlayerColor: 'white' });
  await openVR(appCB2b.page);
  const roomKey = await appCB2b.page.evaluate(() => {
    const c = new Chess(); for(const m of ['d4','Nf6','c4']) c.move(m,{sloppy:true});
    return 'cas:L1_Seq:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  });
  await appCB2b.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
  await appCB2b.page.waitForTimeout(200);
  await appCB2b.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on -- wallListsBtn only shows in edit mode
  await appCB2b.page.waitForTimeout(100);
  await appCB2b.page.evaluate(() => document.querySelector('[title="Wall object lists"]').click());
  await appCB2b.page.waitForSelector('#wallListsOverlay', { state: 'visible', timeout: 5000 });

  // 195b. Empty state: no lists yet, so there's a "+ New List..." button
  //       (not just a dead-end message pointing at the menu) -- creating one
  //       there has no single bucket to assign to, so it just gets created
  //       and the dialog re-renders with real bucket rows now that a list exists.
  try {
    const emptyBtnVisible = await appCB2b.page.evaluate(() => !!document.getElementById('wlEmptyNewBtn'));
    assert(emptyBtnVisible, 'expected a "+ New List..." button in the empty-state wall-lists dialog');
    await appCB2b.page.evaluate(() => document.getElementById('wlEmptyNewBtn').click());
    await appCB2b.page.waitForSelector('#objlistNewOverlay .modal', { state: 'visible', timeout: 5000 });
    await appCB2b.page.fill('#ol_id', 'test_list_1');
    await appCB2b.page.fill('#ol_name', 'Test List One');
    await appCB2b.page.evaluate(() => document.getElementById('ol_save').click());
    await appCB2b.page.waitForSelector('#objlistNewOverlay', { state: 'hidden', timeout: 5000 });
    await appCB2b.page.waitForSelector('#wallListsOverlay .wl-bucket', { timeout: 5000 });
    const optionsHtml = await appCB2b.page.evaluate(() => document.querySelector('#wallListsOverlay .wl-select').innerHTML);
    assert(/Test List One/.test(optionsHtml), `expected the freshly-created list as an option, got ${optionsHtml}`);
    ok('VR wall-lists dialog: empty state offers a "+ New List..." button that creates a list and reveals the bucket rows');
  } catch(e){ bad('VR wall-lists dialog: empty-state "+ New List..." button', e); }

  // 195c. A bucket's own "+ New..." button creates a list AND assigns it to
  //       that exact bucket immediately -- confirmed by the bucket's <select>
  //       showing the new list selected right after the modal closes, with
  //       no manual pick needed (same "nothing left to decide" reasoning as
  //       the asset picker's own "+ New Asset" auto-assign).
  try {
    const bucket = await appCB2b.page.evaluate(() => document.querySelector('#wallListsOverlay .wl-bucket').dataset.bucket);
    await appCB2b.page.evaluate(() => document.querySelector('#wallListsOverlay .wl-newlist').click());
    await appCB2b.page.waitForSelector('#objlistNewOverlay .modal', { state: 'visible', timeout: 5000 });
    await appCB2b.page.fill('#ol_id', 'test_list_2');
    await appCB2b.page.fill('#ol_name', 'Test List Two');
    await appCB2b.page.evaluate(() => document.getElementById('ol_save').click());
    await appCB2b.page.waitForSelector('#objlistNewOverlay', { state: 'hidden', timeout: 5000 });
    await appCB2b.page.waitForTimeout(150);
    const selectedVal = await appCB2b.page.evaluate((b) => {
      const sel = document.querySelector(`#wallListsOverlay .wl-select[data-bucket="${b}"]`);
      return sel ? sel.value : null;
    }, bucket);
    assert(selectedVal === 'test_list_2', `expected the bucket's own new list to be auto-selected, got ${selectedVal}`);
    // persists past a rebuild -- close and reopen the dialog on a fresh room build.
    await appCB2b.page.evaluate(() => document.getElementById('wlCloseBtn').click());
    await appCB2b.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
    await appCB2b.page.waitForTimeout(200);
    await appCB2b.page.evaluate(() => document.querySelector('[title="Wall object lists"]').click());
    await appCB2b.page.waitForSelector('#wallListsOverlay .wl-bucket', { timeout: 5000 });
    const persistedVal = await appCB2b.page.evaluate((b) => {
      const sel = document.querySelector(`#wallListsOverlay .wl-select[data-bucket="${b}"]`);
      return sel ? sel.value : null;
    }, bucket);
    assert(persistedVal === 'test_list_2', `expected the auto-assignment to persist across a room rebuild, got ${persistedVal}`);
    ok('VR wall-lists dialog: a bucket\'s own "+ New..." button creates and auto-assigns a list to that bucket, and it persists');
  } catch(e){ bad('VR wall-lists dialog: per-bucket "+ New..." auto-assign', e); }
} finally {
  await appCB2b.close();
}
} catch(e){ bad('Phase CB2b: uncaught error outside a numbered test (setup or otherwise)', e); }
}
// --- Phase CB3: the entryNoStreet exception -- a castle's own entry room,
//     walked via the report preview (no street building to show its own
//     entry pair on instead), has nowhere else that pair is shown at all,
//     so its center/anchor slot IS list-drivable there -- unlike the same
//     slot in the normal "Run VR" world, where the previous room's own
//     door object already shows it (see Phase CB2). Same exception
//     computeFullyDecorated and buildSlots' render-skip already carve out
//     for this slot. ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appCB3 = await launchApp();
try {
  await seedBackup(appCB3.page, {
    version: 6, user: 'tester',
    // a castle root with NOTHING beyond its own entry reply -- no games
    // continuation either, so there's no unbuilt reply to complicate the
    // read: moveObjectSlots is exactly [C1], nothing more.
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
    ]}],
    games: [ { id: 'g1', moves: 'd4 Nf6 c4', white: 'a', black: 'b', result: '*' } ],
    objectLists: [
      { id: 'entry_list', name: 'Entry List', roomName: '', category: '',
        orderingType: 'procedural', orderingRule: '',
        items: [{ name: 'Solo', assetId: null }],
        mnemonic: { type: 'generated_phrase', initialism: '', phrase: '', source: '' } },
    ],
  }, { defaultPlayerColor: 'white' });
  await appCB3.page.evaluate(() => document.querySelector('.line-row').click());
  await appCB3.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await appCB3.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn').click());
  await appCB3.page.evaluate(() => document.querySelector('tr.data-row[data-opp="Nf6"] [data-act="generateCastle"]').click());
  await appCB3.page.waitForSelector('#castleGenOverlay', { state: 'visible', timeout: 8000 });
  await appCB3.page.evaluate(() => document.getElementById('castleGenGoBtn').click());
  await appCB3.page.waitForSelector('#castleReportOverlay', { state: 'visible', timeout: 15000 });
  await appCB3.page.evaluate(() => document.getElementById('castleWalkBtn').click());
  await appCB3.page.waitForFunction(() => !!window.__threeTestEdit && !!window.__threeTestState, { timeout: 20000 });
  await appCB3.page.waitForTimeout(400);

  // 196. In the report-preview walk, the entry room's own center slot IS
  //      list-drivable: bucketSlotCount is 1 (not 0), and assigning a
  //      1-item list gives that item straight to the C1 slot.
  try {
    const slots = await appCB3.page.evaluate(() => window.__threeTestEdit.moveObjectSlotsFull());
    assert(slots.length === 1 && slots[0].side === 'center', `expected exactly one (center) slot, got ${JSON.stringify(slots)}`);
    const roomKey = await appCB3.page.evaluate(() => window.__threeTestEdit.room());
    const need = await appCB3.page.evaluate((k) => window.__threeTestEdit.wallBucketSlotCount(k, 'all'), roomKey);
    assert(need === 1, `expected bucketSlotCount to count the center slot here (entryNoStreet), got ${need}`);
    await appCB3.page.evaluate((k) => window.__threeTestEdit.setWallList(k, 'all', 'entry_list'), roomKey);
    await appCB3.page.waitForTimeout(200);
    const c1 = await appCB3.page.evaluate((k) => window.__threeTestEdit.slotListWord(k, 'obj-C1'), roomKey);
    assert(c1 === 'Solo', `expected the entry room's C1 slot to get the list's only item (entryNoStreet), got ${JSON.stringify(c1)}`);
    ok('wall lists: entryNoStreet makes the entry room\'s own center slot list-drivable');
  } catch(e){ bad('wall lists: entryNoStreet exception for the center slot', e); }
} finally {
  await appCB3.close();
}
} catch(e){ bad('Phase CB3: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CC: memorized-room-stability Phase 3 -- a memorized linear
//     (corridor) room keeps its shape when a new variation lands on one of
//     its interior members, instead of splitting like an unmemorized room
//     does. Two identically-shaped 4-member corridors (Alpha, Beta) get the
//     SAME interior branch added after setup; Alpha is left unmemorized (the
//     control -- proves the edit really would split it) and Beta is marked
//     memorized first (proves the side-door mechanism actually changes the
//     outcome, not just "nothing broke"). ---
if(shouldRunPhase(['memorized-stability'])){
try {
const appCC = await launchApp();
try {
  const keys = await appCC.page.evaluate(() => {
    const pk = (inst, mv) => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return 'cas:' + inst + ':' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_'); };
    const fenAt = (mv) => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true}); return c.fen(); };
    return {
      alpha: pk('L1_Alpha', ['d4','Nf6','c4']),
      beta: pk('L1_Beta', ['d4','d5','c4']),
      betaFen: fenAt(['d4','d5','c4']),
    };
  });
  await seedBackup(appCC.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      // Alpha: 4-member corridor (c4 / Nc3 / e3 / Bd3), left unmemorized -- the control.
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'e3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4','e3','O-O'], reply: 'Bd3' },
      // Beta: identically-shaped corridor on a different opening try, gets memorized.
      { seq: ['d4','d5'], reply: 'c4', isCastleRoot: true, castleName: 'Beta', castleStreetNumber: 2 },
      { seq: ['d4','d5','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','d5','c4','e6','Nc3','Nf6'], reply: 'e3' },
      { seq: ['d4','d5','c4','e6','Nc3','Nf6','e3','Be7'], reply: 'Bd3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 d5 c4 e6 Nc3 Nf6 e3 Be7 Bd3 O-O', white: 'a', black: 'b', result: '*' },
    ],
  }, { defaultPlayerColor: 'white' });
  await openVR(appCC.page);

  const shapeOf = (k) => appCC.page.evaluate((k) => window.__threeTestEdit.roomShape(k), k);
  const doorsOf = (k) => appCC.page.evaluate((k) =>
    (window.__threeTestEdit.exits(k) || []).filter(e => !e.back).length, k);

  // 193. Setup sanity: both Alpha and Beta start as 4-member corridors with
  //      no forward doors (their tails are unreplied game leaves).
  try {
    const a = await shapeOf(keys.alpha), b = await shapeOf(keys.beta);
    assert(a && a.kind === 'corridor' && a.members.length === 4,
      `expected Alpha to start as a 4-member corridor, got ${JSON.stringify(a)}`);
    assert(b && b.kind === 'corridor' && b.members.length === 4,
      `expected Beta to start as a 4-member corridor, got ${JSON.stringify(b)}`);
    assert((await doorsOf(keys.alpha)) === 0 && (await doorsOf(keys.beta)) === 0,
      'expected neither corridor to have a forward door yet (both tails are unreplied leaves)');
    ok('memorized-stability setup: Alpha and Beta both start as identically-shaped 4-member corridors');
  } catch(e){ bad('memorized-stability setup: both corridors start as 4-member', e); }

  // 194. Marking Beta memorized captures a shape snapshot matching its live shape.
  try {
    await appCC.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.beta);
    await appCC.page.waitForTimeout(200);
    await appCC.page.evaluate(() => window.__threeTestEdit.toggleMemorized());
    const live = await shapeOf(keys.beta);
    const snap = await appCC.page.evaluate((k) => window.__threeTestEdit.memorizedShape(k), keys.beta);
    assert(snap && JSON.stringify(snap.members) === JSON.stringify(live.members),
      `expected the memorized snapshot's members to match the live shape, got snap=${JSON.stringify(snap)} live=${JSON.stringify(live)}`);
    ok('memorized-stability: marking Beta memorized snapshots its live 4-member shape');
  } catch(e){ bad('memorized-stability: memorize captures matching snapshot', e); }

  // Add the SAME interior branch to both castles: a new opponent try (g6,
  // replied to with e4) alongside the existing 3rd-move opponent reply
  // (Bb4 / Nf6 respectively) -- i.e. right after each corridor's 2nd member
  // (the Nc3 reply), squarely interior to both rooms.
  const closeVR = async () => {
    await appCC.page.evaluate(() => {
      const btn = [...document.querySelectorAll('#threeTestCanvasWrap button')].find(b => b.title === 'Close');
      btn && btn.click();
    });
    await appCC.page.waitForFunction(() => document.getElementById('threeTestOverlay').style.display === 'none');
  };
  await closeVR();
  await appCC.page.evaluate(() => document.querySelector('.line-row').click());
  await appCC.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 10000 });
  await appCC.page.evaluate(() => document.getElementById('menuImportLine').click());
  await appCC.page.fill('#importLineInput',
    '1. d4 Nf6 2. c4 e6 3. Nc3 g6 4. e4\n1. d4 d5 2. c4 e6 3. Nc3 g6 4. e4');
  await appCC.page.evaluate(() => document.getElementById('importLineSaveBtn').click());
  await appCC.page.waitForFunction(() => document.getElementById('importLineOverlay').style.display === 'none', { timeout: 10000 });
  await openVR(appCC.page);
  // openVR's own readiness check (__threeTestEdit/__threeTestState) is set
  // once and never cleared on close, so it can resolve on stale globals from
  // the FIRST open, racing ahead of THIS open's (now cache-missing) rebuild
  // -- same known race Phase AV's primeCache() works around. Wait on the
  // rebuilt cache itself instead, which is unambiguous per-open.
  await appCC.page.waitForFunction(() => window.__vrCacheTestHooks && window.__vrCacheTestHooks.isCached(), { timeout: 10000 });

  // 195. Beta (memorized before the edit): stays a 4-member corridor and
  //      gains exactly one forward door -- to the new branch alone. Its
  //      original tail content never became a separately-doored room.
  try {
    const b = await shapeOf(keys.beta);
    assert(b && b.kind === 'corridor' && b.members.length === 4,
      `expected memorized Beta to KEEP its 4-member shape after the interior branch, got ${JSON.stringify(b)}`);
    const doors = await doorsOf(keys.beta);
    assert(doors === 1, `expected exactly 1 new forward door (the side-door to the new branch), got ${doors}`);
    ok('memorized-stability Phase 3: a memorized corridor keeps its shape and gains a single side-door');
  } catch(e){ bad('memorized-stability Phase 3: memorized room preserved via side-door', e); }

  // 200. The side-door isn't just present -- it's positioned near its SIBLING
  //      member's own wall slot, not the member the branch actually forked
  //      FROM. The branch is at M2 (Nc3, L1); its sibling is M3 (the reply
  //      that already occupied that decision point, L2) -- lining up with L2
  //      is what makes it read as "an alternate to L2," not "hanging off L1."
  //      West wall (a left-side sequence). The door itself sits
  //      MEMBER_DOOR_OFFSET (1.7m) past L2 (further from the entrance, i.e. a
  //      MORE negative z, since z decreases going north).
  try {
    const slots = await appCC.page.evaluate((k) => window.__threeTestEdit.moveObjectSlotsFull(k), keys.beta);
    const l2 = slots.find(s => s.side === 'left' && s.order === 2);
    assert(l2, `expected an L2 slot on Beta, got ${JSON.stringify(slots)}`);
    const exits = await appCC.page.evaluate((k) => window.__threeTestEdit.exits(k), keys.beta);
    const door = exits.find(e => !e.back);
    assert(door, `expected exactly one forward door on Beta, got ${JSON.stringify(exits)}`);
    assert(door.wall === 'west', `expected the side-door on the west (left) wall, got ${JSON.stringify(door)}`);
    const expected = l2.z - 1.7;
    assert(Math.abs(door.offset - expected) < 0.01,
      `expected the door ~1.7m past its sibling L2 (L2.z=${l2.z}, expected offset=${expected}), got ${JSON.stringify(door)}`);
    ok('memorized-stability Phase 3: the side-door sits near its SIBLING member\'s slot, not the entrance');
  } catch(e){ bad('memorized-stability Phase 3: side-door positioned near its sibling member', e); }

  // 197. Beta stays memorized (its content is fully preserved, side-door and
  //      all) but now reads DIRTY -- isRoomDirty was originally scoped to
  //      non-linear rooms only, deferred until Phase 3 gave a linear room's
  //      exitPosKeys somewhere stable to diff against; that's exactly what
  //      just happened, so the toolbar's dirty badge should now light up.
  try {
    await appCC.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.beta);
    await appCC.page.waitForTimeout(200);
    const stillMemorized = await appCC.page.evaluate(() => window.__threeTestEdit.memorized());
    assert(stillMemorized, 'expected Beta to remain memorized -- its content is preserved, not stale');
    const dirty = await appCC.page.evaluate(() => window.__threeTestEdit.isRoomDirty());
    assert(dirty, 'expected Beta to read dirty now that its live exitPosKeys include the new side-door');
    const badge = await appCC.page.evaluate(() => window.__threeTestEdit.dirtyBadgeStyle());
    assert(badge && badge.display !== 'none', `expected the dirty toolbar badge visible, got ${JSON.stringify(badge)}`);
    ok('memorized-stability: a memorized linear room with a new side-door stays memorized AND reads dirty');
  } catch(e){ bad('memorized-stability: linear-room dirty detection (Phase 3 closes the Phase 2 gap)', e); }

  // 196. Alpha (never memorized, the control): the SAME edit splits it --
  //      its original room key shrinks to 2 members and shows 2 forward
  //      doors (one to the new branch, one to what used to be silently
  //      inside the room but is now a separate, newly-orphaned room).
  try {
    const a = await shapeOf(keys.alpha);
    assert(a && a.kind === 'corridor' && a.members.length === 2,
      `expected unmemorized Alpha to SPLIT down to its first 2 members, got ${JSON.stringify(a)}`);
    const doors = await doorsOf(keys.alpha);
    assert(doors === 2, `expected 2 forward doors (new branch + the split-off back half), got ${doors}`);
    ok('memorized-stability control: an unmemorized corridor splits on the identical interior branch');
  } catch(e){ bad('memorized-stability control: unmemorized room still splits (proves the mechanism matters)', e); }

  // 201. The digraph shows the same dirty (⚠️) signal as VR for Beta, and the
  //      node carries a native-tooltip explanation (attachGraphHoverTooltip).
  try {
    await closeVR();
    await appCC.page.evaluate(() => document.querySelector('.line-row').click());
    await appCC.page.waitForSelector('.data-row', { timeout: 10000 });
    await appCC.page.evaluate(() => document.getElementById('buildGraphBtn').onclick());
    await appCC.page.waitForFunction(() => !!window.__graphTestHooks, { timeout: 10000 });
    const node = await appCC.page.evaluate((fen) => {
      const n = window.__graphTestHooks.cy().nodes().filter(x => x.data('fen') === fen);
      return n.nonempty() ? { label: n.data('label'), dirty: n.data('dirty'), tooltip: n.data('tooltip') } : null;
    }, keys.betaFen);
    assert(node, `expected to find Beta's own node in the digraph, fen=${keys.betaFen}`);
    assert(/⚠️/.test(node.label || ''), `expected the dirty glyph in Beta's label, got ${JSON.stringify(node.label)}`);
    assert(node.dirty === true, `expected data('dirty') true on Beta's node, got ${JSON.stringify(node.dirty)}`);
    assert(typeof node.tooltip === 'string' && node.tooltip.length > 0,
      `expected a non-empty tooltip on Beta's node, got ${JSON.stringify(node.tooltip)}`);
    ok('memorized-stability: the digraph shows the dirty glyph and a tooltip for Beta');
  } catch(e){ bad('memorized-stability: digraph dirty glyph + tooltip', e); }
} finally {
  await appCC.close();
}
} catch(e){ bad('Phase CC: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CD: row menu's "Copy Moves" action copies the moves up to and
//     including that row, formatted for round-tripping straight back through
//     Import Line ("1. d4 Nf6 2. c4 e6"). ---
if(shouldRunPhase(['move-table'])){
try {
const appCD = await launchApp();
try {
  await seedBackup(appCD.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
    ]}],
    games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4', white: 'a', black: 'b', result: '*' }],
  }, { defaultPlayerColor: 'white' });
  await appCD.page.evaluate(() => document.querySelector('.line-row').click());
  await appCD.page.waitForSelector('tr.data-row[data-seq="d4,Nf6,c4,e6"]', { timeout: 10000 });

  // stub navigator.clipboard.writeText so the test doesn't depend on real
  // clipboard permissions in headless Chromium -- captures the string instead.
  await appCD.page.evaluate(() => {
    window.__copiedText = null;
    navigator.clipboard.writeText = (t) => { window.__copiedText = t; return Promise.resolve(); };
  });

  // 198. "Copy Moves" lives right after "Set Move Quality" and carries a
  //      copy icon.
  try {
    await appCD.page.evaluate(() =>
      document.querySelector('tr.data-row[data-seq="d4,Nf6,c4,e6"] .rowMenuBtn').click());
    // the quality control is a wrapping <div>, not a top-level data-act item --
    // find its position via the .row-menu-quality div's own class instead.
    const order = await appCD.page.evaluate(() =>
      [...document.querySelectorAll('tr.data-row[data-seq="d4,Nf6,c4,e6"] .row-menu > *')]
        .map(el => el.classList.contains('row-menu-quality') ? 'quality' : (el.dataset?.act || el.tagName)));
    const qualityPos = order.indexOf('quality');
    const copyPos = order.indexOf('copyMoves');
    assert(qualityPos >= 0 && copyPos === qualityPos + 1,
      `expected copyMoves immediately after the quality control, got order ${JSON.stringify(order)}`);
    const iconClass = await appCD.page.evaluate(() =>
      document.querySelector('tr.data-row[data-seq="d4,Nf6,c4,e6"] [data-act="copyMoves"] i')?.className);
    assert(/fa-copy/.test(iconClass || ''), `expected a copy icon, got ${JSON.stringify(iconClass)}`);
    ok('Copy Moves sits right after Set Move Quality with a copy icon');
  } catch(e){ bad('Copy Moves: menu placement and icon', e); }

  // 199. Clicking it copies "1. d4 Nf6 2. c4 e6" -- the moves up to and
  //      including THIS row (which ends in the opponent's e6, not our
  //      further-down Nc3/Bb4) -- in the exact format Import Line accepts,
  //      so it round-trips.
  try {
    await appCD.page.evaluate(() =>
      document.querySelector('tr.data-row[data-seq="d4,Nf6,c4,e6"] [data-act="copyMoves"]').click());
    const copied = await appCD.page.evaluate(() => window.__copiedText);
    assert(copied === '1. d4 Nf6 2. c4 e6',
      `expected the formatted move list, got ${JSON.stringify(copied)}`);
    ok('Copy Moves copies a correctly move-numbered, Import-Line-ready string');
  } catch(e){ bad('Copy Moves: copied text format', e); }
} finally {
  await appCD.close();
}
} catch(e){ bad('Phase CD: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CE: a plain corridor room's move-object slots get a floor chain
//     linking them in walk order (buildMoveObjectChain) -- the visual
//     "these are a forced sequence" signal discussed as a memorization-
//     strategy gap (a short 2-move corridor has no half-wall divider the
//     way a two-track room does, so nothing distinguished it from "two
//     moves, two separate doors"). A two-track room gets its own divider
//     PLUS its own chain per lane (each lane is its own forced sequence too,
//     same gap, just two of them side by side) -- see Phase CM for the
//     fuller two-track chain fan-out/isolation coverage; this phase's own
//     two-track case (test 203) just confirms the basic per-lane count. ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appCE = await launchApp();
try {
  await seedBackup(appCE.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      // Chain: 4-member plain corridor.
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Chain', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'e3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4','e3','O-O'], reply: 'Bd3' },
      // Fork: a genuine two-track (two 2-member arms off a shared head).
      { seq: ['d4','d5'], reply: 'c4', isCastleRoot: true, castleName: 'Fork', castleStreetNumber: 2 },
      { seq: ['d4','d5','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','d5','c4','e6','Nc3','Nf6'], reply: 'e3' },
      { seq: ['d4','d5','c4','g6'], reply: 'Nc3' },
      { seq: ['d4','d5','c4','g6','Nc3','Bg7'], reply: 'e3' },
      // Vault: a corridor whose single internal continuation (Nc6/Bc4) ends
      // at a SINGLE forward door -- Black's only reply (Bc5) starts a nested
      // castle (Annex), so the door isn't a branch/two-track, just a plain
      // hand-off to another castle's room. Mirrors the real bug report: a
      // corridor's terminal chain link should reach that door's own
      // pair-object (buildDoorPair), not stop at the room's last own slot.
      { seq: ['e4','e5'], reply: 'Nf3', isCastleRoot: true, castleName: 'Vault', castleStreetNumber: 3 },
      { seq: ['e4','e5','Nf3','Nc6'], reply: 'Bc4' },
      { seq: ['e4','e5','Nf3','Nc6','Bc4','Bc5'], reply: 'c3', isCastleRoot: true, castleName: 'Annex', castleStreetNumber: 4 },
      // Stub: a genuinely clean dead end -- one move, and NO recorded game
      // goes even a single ply past it (unlike Chain, whose g1 keeps going
      // with an opponent reply -- d5 -- nobody's prepared a response to
      // yet). castleSign.unbuilt must be empty here for the dead-end sign
      // test to mean anything.
      { seq: ['c4','c5'], reply: 'Nf3', isCastleRoot: true, castleName: 'Stub', castleStreetNumber: 5 },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 d5 c4 e6 Nc3 Nf6 e3 Be7', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 d5 c4 g6 Nc3 Bg7 e3 Nf6', white: 'a', black: 'b', result: '*' },
      { id: 'g4', moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6', white: 'a', black: 'b', result: '*' },
      { id: 'g5', moves: 'c4 c5 Nf3', white: 'a', black: 'b', result: '*' },
    ],
    assets: [
      { id: 'doorSkin1', type: 'door', image: 'data:image/png;base64,iVBORw0KGgo=' },
    ],
  }, { defaultPlayerColor: 'white' });
  await openVR(appCE.page);

  const keys = await appCE.page.evaluate(() => {
    const pk = (inst, mv) => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return 'cas:' + inst + ':' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_'); };
    return {
      chain: pk('L1_Chain', ['d4','Nf6','c4']), fork: pk('L1_Fork', ['d4','d5','c4']),
      vault: pk('L1_Vault', ['e4','e5','Nf3']), annex: pk('L1_Annex', ['e4','e5','Nf3','Nc6','Bc4','Bc5','c3']),
      stub: pk('L1_Stub', ['c4','c5','Nf3']),
    };
  });

  // 202. The 4-member corridor gets exactly 3 chain segments: one from the
  //      room's entry (name floor-label spot, not the C1 anchor slot -- C1's
  //      own position is often bare, so the walk starts at the always-present
  //      name label instead) to L1, then one per remaining consecutive pair.
  try {
    await appCE.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.chain);
    await appCE.page.waitForTimeout(200);
    const slots = await appCE.page.evaluate(() => window.__threeTestEdit.moveObjectSlotsFull());
    const segs = await appCE.page.evaluate(() => window.__threeTestEdit.chainSegments());
    const entryPos = await appCE.page.evaluate(() => window.__threeTestEdit.chainEntryPos());
    assert(slots.length === 4, `expected 4 move-object slots on Chain, got ${slots.length}`);
    assert(segs.length === 3, `expected 3 chain segments (4 slots - 1), got ${segs.length}: ${JSON.stringify(segs)}`);
    const ordered = slots.slice().sort((a, b) =>
      ({center:0,left:1,right:2}[a.side] - {center:0,left:1,right:2}[b.side]) || (a.order - b.order));
    const path = [entryPos, ...ordered.slice(1)];
    for(let i = 0; i < path.length - 1; i++){
      const a = path[i], b = path[i+1];
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const hit = segs.some(s => Math.abs(s.x - mx) < 0.01 && Math.abs(s.z - mz) < 0.01);
      assert(hit, `expected a chain segment at the midpoint of walk-point ${i} and ${i+1} (${mx},${mz}), got ${JSON.stringify(segs)}`);
    }
    ok('memorization-aid: a plain corridor gets a floor chain linking consecutive move-object slots');
  } catch(e){ bad('memorization-aid: corridor chain segment count and placement', e); }

  // 203. The two-track room ALSO gets a chain -- one per lane (2 members
  //      each here, both lanes' own tails are unbuilt leaves, not real
  //      doors, so 1 internal segment each -- entry-L1/L1-L2 and
  //      entry-R1/R1-R2 -- 4 total, on top of its own divider).
  try {
    await appCE.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.fork);
    await appCE.page.waitForTimeout(200);
    const slots = await appCE.page.evaluate(() => window.__threeTestEdit.moveObjectSlotsFull());
    const segs = await appCE.page.evaluate(() => window.__threeTestEdit.chainSegments());
    const entryPos = await appCE.page.evaluate(() => window.__threeTestEdit.chainEntryPos());
    assert(segs.length === 4, `expected 4 chain segments (2 lanes x 2 members - 1 each), got ${segs.length}: ${JSON.stringify(segs)}`);
    for(const side of ['left', 'right']){
      const s1 = slots.find(s => s.side === side && s.order === 1);
      const s2 = slots.find(s => s.side === side && s.order === 2);
      assert(s1 && s2, `expected 2 members on the ${side} lane, got ${JSON.stringify(slots)}`);
      for(const [a, b] of [[entryPos, s1], [s1, s2]]){
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const hit = segs.some(s => Math.abs(s.x - mx) < 0.01 && Math.abs(s.z - mz) < 0.01);
        assert(hit, `expected a ${side}-lane chain segment at (${mx},${mz}), got ${JSON.stringify(segs)}`);
      }
    }
    ok('memorization-aid: a two-track room gets its own chain per lane, in addition to its divider');
  } catch(e){ bad('memorization-aid: two-track room gets per-lane chains', e); }

  // 204. Nudging a slot moves the chain's endpoint with it -- the chain
  //      follows the object's ACTUAL (possibly manually repositioned)
  //      location, not the default computed slot position it would
  //      otherwise sit at (the bug reported from a real decorated room: the
  //      chain ran off toward a stale default position instead of the
  //      object the user had dragged elsewhere).
  try {
    await appCE.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.chain);
    await appCE.page.waitForTimeout(200);
    const slots = await appCE.page.evaluate(() => window.__threeTestEdit.moveObjectSlotsFull());
    const l1 = slots.find(s => s.side === 'left' && s.order === 1);
    assert(l1, `expected an L1 slot on Chain, got ${JSON.stringify(slots)}`);
    const entryPos = await appCE.page.evaluate(() => window.__threeTestEdit.chainEntryPos());
    await appCE.page.evaluate((args) => window.__threeTestEdit.nudgeSlot(args.k, args.id, 2, -1), { k: keys.chain, id: l1.id });
    await appCE.page.waitForTimeout(200);
    const segs = await appCE.page.evaluate(() => window.__threeTestEdit.chainSegments());
    const expected = { x: (entryPos.x + (l1.x + 2)) / 2, z: (entryPos.z + (l1.z - 1)) / 2 };
    const hit = segs.some(s => Math.abs(s.x - expected.x) < 0.01 && Math.abs(s.z - expected.z) < 0.01);
    assert(hit, `expected a chain segment following L1's nudged position (midpoint ${JSON.stringify(expected)}), got ${JSON.stringify(segs)}`);
    ok('memorization-aid: the chain follows a slot\'s actual nudged position, not its stale default');
  } catch(e){ bad('memorization-aid: chain endpoint tracks a manually nudged slot', e); }

  // 205. A corridor's terminal chain link reaches past the room's own last
  //      slot to its single forward door's own pair-object position (the bug
  //      reported from a real decorated room: "Master Suite" -- the chain
  //      stopped at the room's own C1/L1 slots and never reached the door's
  //      horse-statue pair-object beyond them). The walk starts at the room's
  //      name floor-label spot, not the C1 anchor slot itself.
  try {
    await appCE.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.vault);
    await appCE.page.waitForTimeout(200);
    const slots = await appCE.page.evaluate(() => window.__threeTestEdit.moveObjectSlotsFull());
    assert(slots.length === 2, `expected 2 move-object slots on Vault (C1 + L1), got ${slots.length}: ${JSON.stringify(slots)}`);
    const l1 = slots.find(s => s.side === 'left' && s.order === 1);
    assert(l1, `expected an L1 slot on Vault, got ${JSON.stringify(slots)}`);
    const entryPos = await appCE.page.evaluate(() => window.__threeTestEdit.chainEntryPos());
    const doorPos = await appCE.page.evaluate((args) => window.__threeTestEdit.doorObjBasePos(args.k, args.target), { k: keys.vault, target: keys.annex });
    assert(doorPos, `expected Vault to have a forward door to Annex's entry room ${keys.annex}`);
    const segs = await appCE.page.evaluate(() => window.__threeTestEdit.chainSegments());
    assert(segs.length === 2, `expected 2 chain segments (entry-L1, then L1-door), got ${segs.length}: ${JSON.stringify(segs)}`);
    const internalMid = { x: (entryPos.x + l1.x) / 2, z: (entryPos.z + l1.z) / 2 };
    const doorMid = { x: (l1.x + doorPos.x) / 2, z: (l1.z + doorPos.z) / 2 };
    const hitInternal = segs.some(s => Math.abs(s.x - internalMid.x) < 0.01 && Math.abs(s.z - internalMid.z) < 0.01);
    const hitDoor = segs.some(s => Math.abs(s.x - doorMid.x) < 0.01 && Math.abs(s.z - doorMid.z) < 0.01);
    assert(hitInternal, `expected the entry-L1 chain segment at ${JSON.stringify(internalMid)}, got ${JSON.stringify(segs)}`);
    assert(hitDoor, `expected the terminal chain segment reaching the door's pair-object at ${JSON.stringify(doorMid)}, got ${JSON.stringify(segs)}`);
    ok('memorization-aid: a corridor\'s terminal chain link reaches its forward door\'s own pair-object');
  } catch(e){ bad('memorization-aid: corridor chain reaches the forward door\'s pair-object', e); }

  // 206. A room with no forward exit at all AND no unbuilt (played but
  //      unprepared) opponent replies gets a skinnable "no entry" sign on
  //      the wall a forward door would have used (built-in icon by
  //      default), so a genuine dead end reads as intentional rather than
  //      "not built yet" -- distinct from a locked door, which is a real
  //      (if unbuilt) reply. A room WITH a forward door gets no such sign,
  //      and neither does a room whose sequence LOOKS like a dead end
  //      (no built forward door) but actually has an unbuilt reply on
  //      record (Chain -- g1 keeps going with d5 past its last prepared
  //      move, nobody's built a response to it yet): showing "the line
  //      ends here" there would contradict the room's own "unbuilt: d5"
  //      sign and be actively misleading.
  try {
    await appCE.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.stub);
    await appCE.page.waitForTimeout(200);
    const before = await appCE.page.evaluate(() => window.__threeTestEdit.deadEndSign());
    assert(before.wall === 'north', `expected the Stub dead-end sign on the north wall, got ${JSON.stringify(before)}`);
    assert(before.icon && !before.panel, `expected the built-in no-entry icon (no override yet), got ${JSON.stringify(before)}`);

    // a room with a real forward door (Vault) gets no dead-end sign at all.
    await appCE.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.vault);
    await appCE.page.waitForTimeout(200);
    const vaultSign = await appCE.page.evaluate(() => window.__threeTestEdit.deadEndSign());
    assert(!vaultSign.icon && !vaultSign.panel, `expected no dead-end sign on a room with a forward door, got ${JSON.stringify(vaultSign)}`);

    // Chain has no BUILT forward door either, but its last prepared move
    // (Bd3) has an unbuilt reply on record (d5, from g1) -- the sequence
    // doesn't genuinely end there, so it must NOT get the no-entry sign.
    await appCE.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.chain);
    await appCE.page.waitForTimeout(200);
    const chainSign = await appCE.page.evaluate(() => window.__threeTestEdit.deadEndSign());
    assert(!chainSign.icon && !chainSign.panel, `expected no dead-end sign on a room with an unbuilt reply, got ${JSON.stringify(chainSign)}`);

    // skinning it through the real picker (edit mode + the marker's own
    // click target) swaps the built-in icon for the custom panel.
    await appCE.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.stub);
    await appCE.page.waitForTimeout(200);
    await appCE.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
    await appCE.page.waitForTimeout(60);
    await appCE.page.evaluate((k) => window.__threeTestEdit.target({ kind: 'dead-end', roomKey: k }), keys.stub);
    await appCE.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appCE.page.evaluate(() => {
      const card = [...document.querySelectorAll('#pickerGrid .asset-card')]
        .find(c => !c.classList.contains('asset-card-color') && c.textContent.includes('doorSkin1'));
      card.click();
    });
    await appCE.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
    await appCE.page.waitForTimeout(150);
    const overrideId = await appCE.page.evaluate((k) => window.__threeTestEdit.deadEndOverrideId(k), keys.stub);
    assert(overrideId === 'doorSkin1', `expected the dead-end sign's override to be doorSkin1, got ${overrideId}`);
    const after = await appCE.page.evaluate(() => window.__threeTestEdit.deadEndSign());
    assert(after.panel && !after.icon, `expected the custom skin panel (not the built-in icon) once assigned, got ${JSON.stringify(after)}`);
    ok('memorization-aid: a dead-end room gets a skinnable no-entry sign; a real door or an unbuilt reply suppresses it');
  } catch(e){ bad('memorization-aid: dead-end sign presence, default icon, unbuilt-reply gate, and skinning', e); }
} finally {
  await appCE.close();
}
} catch(e){ bad('Phase CE: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CF: spacebar jump-forward and click-to-walk-through-a-door --
//     both cover ground fast while testing/decorating. A jump advances in
//     small steps rather than one leap straight to the target point, so it
//     can't skip clean over a door's trigger box (only ~2m deep) or land
//     inside a wall; stepping into a door ends the jump at that door's OWN
//     recorded spawn point, discarding whatever jump distance was left
//     (not some arbitrary distance further into the new room). A click
//     does the same door lookup for a deliberate tap, with no facing
//     requirement (findDoorTrigger/fireDoorTrigger, shared with tick()'s
//     own forward-walk trigger check). ---
if(shouldRunPhase(['vr-castle'])){
try {
const appCF = await launchApp();
try {
  await seedBackup(appCF.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['e4'], prefs: [
      // Nav: a single-continuation corridor (C1 + L1) with ONE forward
      // door to a nested castle (NavB) -- same shape as Phase CE's
      // Vault/Annex, reused here for movement rather than decoration.
      // NavB needs its OWN further continuation (Nf6/d4) beyond its entry
      // reply -- with nothing beyond, isRoomEmpty would mark it a "locked"
      // door (a real, if unbuilt, dead end) instead of a real walkable one.
      { seq: ['e4','e5'], reply: 'Nf3', isCastleRoot: true, castleName: 'Nav', castleStreetNumber: 1 },
      { seq: ['e4','e5','Nf3','Nc6'], reply: 'Bc4' },
      { seq: ['e4','e5','Nf3','Nc6','Bc4','Bc5'], reply: 'c3', isCastleRoot: true, castleName: 'NavB', castleStreetNumber: 2 },
      { seq: ['e4','e5','Nf3','Nc6','Bc4','Bc5','c3','Nf6'], reply: 'd4' },
    ]}],
    games: [
      { id: 'g1', moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4', white: 'a', black: 'b', result: '*' },
    ],
  }, { defaultPlayerColor: 'white' });
  await openVR(appCF.page);

  const keys = await appCF.page.evaluate(() => {
    const pk = (inst, mv) => { const c = new Chess(); for(const m of mv) c.move(m,{sloppy:true});
      return 'cas:' + inst + ':' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_'); };
    return {
      nav: pk('L1_Nav', ['e4','e5','Nf3']),
      navB: pk('L1_NavB', ['e4','e5','Nf3','Nc6','Bc4','Bc5','c3']),
    };
  });

  // the forward door's wall is a HASH of its target key (doorWallFor) --
  // north/east/west, never assumed -- so every test below looks it up via
  // the real exits() rather than guessing a compass direction. YAW_FOR_WALL
  // is the facing that walks INTO each wall (cameraForwardVec's own
  // convention: {x:-sin(yaw), z:-cos(yaw)}).
  const YAW_FOR_WALL = { north: 0, south: Math.PI, east: -Math.PI / 2, west: Math.PI / 2 };
  await appCF.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.nav);
  await appCF.page.waitForTimeout(200);
  const navExits = await appCF.page.evaluate((k) => window.__threeTestEdit.exits(k), keys.nav);
  const doorEx = navExits.find(e => e.target === keys.navB);
  assert(doorEx, `expected Nav to have a forward door to NavB, got ${JSON.stringify(navExits)}`);
  const doorWall = doorEx.wall;
  const freeWall = ['north', 'east', 'west'].find(w => w !== doorWall);   // guaranteed door-free -- only one of the three carries the single forward door
  // a door's offset is only 0 along its own wall's lateral axis for a
  // SINGLE north door (see doorPlacements) -- an east/west door's offset is
  // a z-coordinate some distance south of the room's head (ewSouth), not
  // room-center-relative. So the door's box center (what a jump/click needs
  // to actually land in) is NOT just "(0,0) toward that wall" in general --
  // compute it from the wall's fixed coordinate (wallSpan) + the door's own
  // lateral offset.
  const navSize = await appCF.page.evaluate((k) => window.__threeTestEdit.roomSize(k), keys.nav);
  const wallFixed = { north: -navSize.d / 2, south: navSize.d / 2, east: navSize.w / 2, west: -navSize.w / 2 }[doorWall];
  const doorAxisIsX = (doorWall === 'north' || doorWall === 'south');
  const doorBoxCenter = doorAxisIsX ? { x: doorEx.offset, z: wallFixed } : { x: wallFixed, z: doorEx.offset };
  // the room-center point ALONG the door's own wall, at the door's lateral
  // offset -- the correct starting point to walk/jump straight through it.
  const doorApproachStart = doorAxisIsX ? { x: doorEx.offset, z: 0 } : { x: 0, z: doorEx.offset };

  // 207. Indoor/outdoor jump distances are configured 2m / 10m.
  try {
    const dist = await appCF.page.evaluate(() => window.__threeTestEdit.jumpDistances());
    assert(dist.indoor === 2, `expected a 2m indoor jump, got ${JSON.stringify(dist)}`);
    assert(dist.outdoor === 10, `expected a 10m outdoor jump, got ${JSON.stringify(dist)}`);
    ok('jump-forward: indoor/outdoor distances are 2m / 10m');
  } catch(e){ bad('jump-forward: configured distances', e); }

  // 208. A single indoor jump in open space (facing a plain wall with no
  //      door, well clear of it) moves the player forward by ~2m in the
  //      facing direction -- not less (blocked early) or more (overshoot).
  try {
    await appCF.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.nav);
    await appCF.page.waitForTimeout(200);
    await appCF.page.evaluate((yv) => window.__threeTestEdit.setPlayerPos(0, 0, yv), YAW_FOR_WALL[freeWall]);
    await appCF.page.evaluate(() => window.__threeTestEdit.jump());
    const after = await appCF.page.evaluate(() => window.__threeTestEdit.playerPos());
    const expected = { x: -Math.sin(YAW_FOR_WALL[freeWall]) * 2, z: -Math.cos(YAW_FOR_WALL[freeWall]) * 2 };
    assert(after.room === keys.nav, `expected to stay in Nav for an unobstructed jump, got ${after.room}`);
    assert(Math.abs(after.x - expected.x) < 0.05 && Math.abs(after.z - expected.z) < 0.05,
      `expected to land ~2m toward the free ${freeWall} wall ${JSON.stringify(expected)}, got (${after.x},${after.z})`);
    ok('jump-forward: a single unobstructed indoor jump covers ~2m');
  } catch(e){ bad('jump-forward: single unobstructed jump distance', e); }

  // 209. Repeated jumps toward a plain wall (no door) stop right at the
  //      wall -- never exceed it, and never change rooms.
  try {
    await appCF.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.nav);
    await appCF.page.waitForTimeout(200);
    const size = await appCF.page.evaluate((k) => window.__threeTestEdit.roomSize(k), keys.nav);
    await appCF.page.evaluate((yv) => window.__threeTestEdit.setPlayerPos(0, 0, yv), YAW_FOR_WALL[freeWall]);
    for(let i = 0; i < 20; i++) await appCF.page.evaluate(() => window.__threeTestEdit.jump());
    const after = await appCF.page.evaluate(() => window.__threeTestEdit.playerPos());
    const half = (freeWall === 'east' || freeWall === 'west') ? size.w / 2 : size.d / 2;
    const coord = (freeWall === 'east' || freeWall === 'west') ? after.x : after.z;
    const mag = Math.abs(coord);
    assert(after.room === keys.nav, `expected to stay in Nav (no door on the ${freeWall} wall), got ${after.room}`);
    assert(mag <= half + 0.01, `expected the jump to stop AT the ${freeWall} wall, not past it (coord=${coord}, half=${half})`);
    assert(mag > half - 1, `expected the jump to reach close to the ${freeWall} wall, got coord=${coord} (half=${half})`);
    ok('jump-forward: repeated jumps into a plain wall stop right at it');
  } catch(e){ bad('jump-forward: stops at a wall, does not overshoot', e); }

  // 210. Jumping toward the room's forward door lands EXACTLY at that
  //      door's own recorded spawn point in the new room -- not some
  //      arbitrary distance further in, matching a physical walk-through.
  //      Waits out enterRoom's own 0.6s teleport-lock cooldown first, or
  //      the very first jump's door-trigger check would be skipped.
  try {
    await appCF.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.nav);
    await appCF.page.waitForTimeout(700);
    const before = await appCF.page.evaluate(() => window.__threeTestEdit.exitMetaList());
    const expected = before.find(m => m.target === keys.navB);
    assert(expected, `expected Nav to have an exit trigger targeting NavB, got ${JSON.stringify(before)}`);
    // start ALIGNED with the door's own lateral offset (see doorApproachStart
    // -- an east/west door's box isn't centered on the room, only a single
    // north door's is), then walk straight into the wall it's on.
    await appCF.page.evaluate((args) => window.__threeTestEdit.setPlayerPos(args.p.x, args.p.z, args.yaw),
      { p: doorApproachStart, yaw: YAW_FOR_WALL[doorWall] });
    for(let i = 0; i < 10; i++){
      const cur = await appCF.page.evaluate(() => window.__threeTestEdit.playerPos());
      if(cur.room === keys.navB) break;
      await appCF.page.evaluate(() => window.__threeTestEdit.jump());
    }
    const after = await appCF.page.evaluate(() => window.__threeTestEdit.playerPos());
    assert(after.room === keys.navB, `expected to have jumped through into NavB, got ${after.room}`);
    assert(Math.abs(after.x - expected.spawn.x) < 0.05 && Math.abs(after.z - expected.spawn.z) < 0.05,
      `expected to land exactly at NavB's own entrance spawn ${JSON.stringify(expected.spawn)}, got (${after.x},${after.z})`);
    ok('jump-forward: jumping through a door lands at its own spawn, not further in');
  } catch(e){ bad('jump-forward: lands at the door\'s own spawn point', e); }

  // 211. Clicking a world point inside a door's trigger box (no facing
  //      requirement) walks straight through it to the same spawn point.
  //      Clicks doorBoxCenter (this room's own local trigger-box center),
  //      NOT an exitMeta entry's .spawn -- that's the DESTINATION room's
  //      coordinates (where enterRoom lands you once through), a different
  //      frame entirely from a point you'd click on in the room you're
  //      currently standing in.
  try {
    await appCF.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.nav);
    await appCF.page.waitForTimeout(700);
    const moved = await appCF.page.evaluate((p) => window.__threeTestEdit.walkClickAt(p.x, p.z), doorBoxCenter);
    assert(moved, 'expected clicking inside the door\'s trigger box to walk through it');
    const after = await appCF.page.evaluate(() => window.__threeTestEdit.playerPos());
    assert(after.room === keys.navB, `expected the click to walk into NavB, got ${after.room}`);
    ok('click-to-walk: tapping a door walks straight through it');
  } catch(e){ bad('click-to-walk: tapping inside a door\'s trigger box', e); }

  // 212. Clicking a point NOT inside any door's trigger box does nothing.
  try {
    await appCF.page.evaluate((k) => window.__threeTestEdit.enter(k), keys.nav);
    await appCF.page.waitForTimeout(700);
    const moved = await appCF.page.evaluate(() => window.__threeTestEdit.walkClickAt(0, 0));   // room center, nowhere near a door
    assert(!moved, 'expected clicking open floor (no door there) to do nothing');
    const after = await appCF.page.evaluate(() => window.__threeTestEdit.playerPos());
    assert(after.room === keys.nav, `expected to stay in Nav, got ${after.room}`);
    ok('click-to-walk: clicking open floor away from any door does nothing');
  } catch(e){ bad('click-to-walk: no false positive away from a door', e); }
} finally {
  await appCF.close();
}
} catch(e){ bad('Phase CF: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CG: a transposition room's single back door leads to the room
//     the player actually walked in from THIS visit (roomEnteredFrom), not
//     permanently to whichever parent the castle-builder discovered first.
//     A round-trip into the room's own child must not clobber that memory
//     (only a FORWARD crossing records where you came from). ---
if(shouldRunPhase(['vr-castle'])){
try {
const appCG = await launchApp();
try {
  // a6/h6 transpose: root -> X (via a6) and root -> Y (via h6) both lead to
  // one SHARED room (after Nc3). X is discovered first, so shared's static
  // back exit targets X. The g6 child is a BRANCH room (two replies) so the
  // shared room can't fold into a two-track (which would swallow its forward
  // doors); each child chain continues far enough not to be a locked door.
  await seedBackup(appCG.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','a6'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','h6'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','a6','e4','h6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','h6','e4','a6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','a6','e4','h6','Nc3','g6'], reply: 'e5' },
      { seq: ['d4','Nf6','c4','a6','e4','h6','Nc3','g6','e5','Ng8'], reply: 'd5' },
      { seq: ['d4','Nf6','c4','a6','e4','h6','Nc3','g6','e5','Nh5'], reply: 'd5' },
      { seq: ['d4','Nf6','c4','a6','e4','h6','Nc3','b6'], reply: 'e5' },
      { seq: ['d4','Nf6','c4','a6','e4','h6','Nc3','b6','e5','Ng8'], reply: 'd5' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 a6 e4 h6 Nc3 g6 e5 Ng8 d5', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 h6 e4 a6 Nc3', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 Nf6 c4 a6 e4 h6 Nc3 b6 e5 Ng8 d5', white: 'a', black: 'b', result: '*' },
      { id: 'g4', moves: 'd4 Nf6 c4 a6 e4 h6 Nc3 g6 e5 Nh5 d5', white: 'a', black: 'b', result: '*' },
    ],
  }, { defaultPlayerColor: 'white' });
  await openVR(appCG.page);
  const cgKey = (moves) => appCG.page.evaluate((mv) => {
    const c = new Chess();
    for(const m of mv) c.move(m, { sloppy: true });
    return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  }, moves);
  const cgRoot = await cgKey(['d4','Nf6','c4']);
  const cgX = await cgKey(['d4','Nf6','c4','a6','e4']);
  const cgY = await cgKey(['d4','Nf6','c4','h6','e4']);
  const cgShared = await cgKey(['d4','Nf6','c4','a6','e4','h6','Nc3']);
  const cgVest = await cgKey(['d4','Nf6','c4','a6','e4','h6','Nc3','g6','e5']);
  // click through the LIVE trigger matching `matchFn` (exitInfo is the real
  // exitMeta -- the fix rewires the back trigger's target, so navigation has
  // to be driven through it, not through the static exits list). Waits past
  // the 0.6s teleport lock each hop.
  const cgClickDoor = async (matchFn, label) => {
    await appCG.page.waitForTimeout(700);
    const live = await appCG.page.evaluate(() => window.__threeTestEdit.exitInfo());
    const m = live.find(matchFn);
    assert(m, `${label}: no matching live door trigger`);
    const c = { x: (m.box.minX + m.box.maxX) / 2, z: (m.box.minZ + m.box.maxZ) / 2 };
    await appCG.page.evaluate((p) => window.__threeTestEdit.walkClickAt(p.x, p.z), c);
    await appCG.page.waitForTimeout(150);
    return (await appCG.page.evaluate(() => window.__threeTestEdit.playerPos())).room;
  };
  const cgFwd = await appCG.page.evaluate((k) =>
    window.__threeTestEdit.exits(k).filter(e => !e.back).map(e => e.target), cgShared);

  // 213. Entering the shared room via its canonical first parent (X), the
  //      back door returns to X.
  try {
    await appCG.page.evaluate((k) => window.__threeTestEdit.enter(k), cgRoot);
    let r = await cgClickDoor(m => m.target === cgX, 'root->X');
    assert(r === cgX, `expected to walk into X, got ${r}`);
    r = await cgClickDoor(m => m.target === cgShared, 'X->shared');
    assert(r === cgShared, `expected to walk into the shared room, got ${r}`);
    r = await cgClickDoor(m => !cgFwd.includes(m.target), 'shared back (via X)');
    assert(r === cgX, `expected the back door to return to X (walked in from there), got ${r}`);
    ok('transposition back door: entering via the canonical parent returns there');
  } catch(e){ bad('transposition back door: canonical parent round-trip', e); }

  // 214. Entering via the OTHER parent (Y), the same single back door now
  //      returns to Y -- even after a round-trip into the shared room's own
  //      child (which must not overwrite the entered-from memory, since only
  //      a forward crossing records it).
  try {
    const xFwd = await appCG.page.evaluate((k) =>
      window.__threeTestEdit.exits(k).filter(e => !e.back).map(e => e.target), cgX);
    let r = await cgClickDoor(m => !xFwd.includes(m.target), 'X back');
    assert(r === cgRoot, `expected X's back door to lead to the root, got ${r}`);
    r = await cgClickDoor(m => m.target === cgY, 'root->Y');
    assert(r === cgY, `expected to walk into Y, got ${r}`);
    r = await cgClickDoor(m => m.target === cgShared, 'Y->shared');
    assert(r === cgShared, `expected to walk into the shared room, got ${r}`);
    r = await cgClickDoor(m => m.target === cgVest, 'shared->child');
    assert(r === cgVest, `expected to walk into the child room, got ${r}`);
    const vFwd = await appCG.page.evaluate((k) =>
      window.__threeTestEdit.exits(k).filter(e => !e.back).map(e => e.target), cgVest);
    r = await cgClickDoor(m => !vFwd.includes(m.target), 'child back');
    assert(r === cgShared, `expected the child's back door to return to the shared room, got ${r}`);
    r = await cgClickDoor(m => !cgFwd.includes(m.target), 'shared back (via Y)');
    assert(r === cgY, `expected the back door to return to Y this time, got ${r}`);
    ok('transposition back door: entering via the other parent returns there, child round-trips don\'t clobber it');
  } catch(e){ bad('transposition back door: non-canonical parent + child round-trip', e); }
} finally {
  await appCG.close();
}
} catch(e){ bad('Phase CG: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CH: stored-size self-heal. reconcileRoomBounds grows a saved size
//     override (LAYOUT[roomKey].geom) up to the room's own content floor
//     (relaxedContentMin) on buildRoom, so an override left too small -- e.g.
//     one kept under a room's key after the phantom-en-passant canonicalization
//     merged another path's doors into it -- can't trap billboards/doors in the
//     walls. Only ever GROWS a sub-floor override; a valid/larger one is left
//     as-is; elevator cars (which legitimately shrink) are exempt. ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appCH = await launchApp();
try {
  // a 3-member plain corridor (C1 anchor + L1 + L2 on the west wall).
  await seedBackup(appCH.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Seq', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'e3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O', white: 'a', black: 'b', result: '*' },
    ],
  }, { defaultPlayerColor: 'white' });
  await openVR(appCH.page);
  const roomKey = await appCH.page.evaluate(() => {
    const c = new Chess(); for(const m of ['d4','Nf6','c4']) c.move(m,{sloppy:true});
    return 'cas:L1_Seq:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  });
  await appCH.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
  await appCH.page.waitForTimeout(200);
  const base = await appCH.page.evaluate((k) => window.__threeTestEdit.roomSize(k), roomKey);

  // 213. A deliberately-too-small stored override (well under the content
  //      floor, written straight to LAYOUT via the resize hook, bypassing the
  //      dialog's own clamp) is grown back up on the next buildRoom: both the
  //      effective size AND the persisted geom reach at least the base size,
  //      and every pair sits inside.
  try {
    await appCH.page.evaluate((k) => window.__threeTestEdit.resize(k, { w: 4, d: 5, h: 6 }), roomKey);
    await appCH.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);   // rebuild -> heal
    await appCH.page.waitForTimeout(200);
    const eff = await appCH.page.evaluate((k) => window.__threeTestEdit.roomSize(k), roomKey);
    assert(eff.d >= base.d - 0.01 && eff.w >= base.w - 0.01,
      `expected the effective size healed up to at least the base (${base.w}x${base.d}), got ${eff.w}x${eff.d}`);
    const stored = await appCH.page.evaluate((k) => window.__threeTestEdit.roomLayout(k), roomKey);
    assert(stored.geom && stored.geom.d >= base.d - 0.01 && stored.geom.w >= base.w - 0.01,
      `expected the PERSISTED override grown to the content floor, got ${JSON.stringify(stored.geom)}`);
    const slots = await appCH.page.evaluate(() => window.__threeTestEdit.moveObjectSlotsFull());
    const farthest = Math.min(...slots.map(s => s.z));
    assert(farthest > -eff.d / 2, `expected every pair inside the north wall (z > ${-eff.d / 2}), farthest at ${farthest}`);
    ok('room size: a too-small override self-heals up to the content floor, keeping pairs off the walls');
  } catch(e){ bad('room size: too-small override self-heals', e); }

  // 214. A LARGER override is left exactly as saved -- the heal is a floor,
  //      never a pin to the computed size, so a user's deliberate roomy resize
  //      survives.
  try {
    await appCH.page.evaluate(({ k, w, d }) => window.__threeTestEdit.resize(k, { w, d, h: 6 }), { k: roomKey, w: base.w + 6, d: base.d + 8 });
    await appCH.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
    await appCH.page.waitForTimeout(200);
    const eff = await appCH.page.evaluate((k) => window.__threeTestEdit.roomSize(k), roomKey);
    assert(Math.abs(eff.d - (base.d + 8)) < 0.01 && Math.abs(eff.w - (base.w + 6)) < 0.01,
      `expected a larger override left untouched (${base.w + 6}x${base.d + 8}), got ${eff.w}x${eff.d}`);
    ok('room size: a larger override is honored as-is (the heal is a floor, not a pin)');
  } catch(e){ bad('room size: larger override honored', e); }
} finally {
  await appCH.close();
}
} catch(e){ bad('Phase CH: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CI: a compacted (hoisted) run's own move labels are tappable
//     pv-move chips (previously plain text -- couldn't open the mini board),
//     and its triangle expands JUST that one line in place (per-move rows,
//     each with its own menu) without leaving compact mode for the whole
//     table -- previously the triangle rendered as the disabled/non-clickable
//     .toggle-empty placeholder, so shortening a compacted line meant
//     uncompacting (and re-compacting) the entire tree. ---
if(shouldRunPhase(['move-table'])){
try {
const appCI = await launchApp();
try {
  // a 3-pair forced run (Nf6/c4, e6/Nc3, Bb4/e3) then a real 2-way branch
  // (O-O vs c5) -- long enough to compact (>=2 forced pairs), with a genuine
  // continuation past the run to confirm collapsing restores it untouched.
  await seedBackup(appCI.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'e3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 e3 c5',  white: 'a', black: 'b', result: '*' },
    ],
  }, { defaultPlayerColor: 'white' });
  await appCI.page.click('.line-row');
  await appCI.page.waitForSelector('tr.data-row', { timeout: 10000 });

  // turn compact mode on (re-renders the already-open line) -- the run
  // collapses into one .compact-run row.
  await appCI.page.click('#compactModeBtn');
  await appCI.page.waitForSelector('tr.compact-run', { timeout: 10000 });

  // 216. The compact row's move labels are real pv-move chips: tapping one
  //      opens the mini board float, same as any other move in the tree.
  try {
    const chipCount = await appCI.page.evaluate(() =>
      document.querySelector('tr.compact-run td.move').querySelectorAll('.pv-move').length);
    assert(chipCount === 6, `expected 6 tappable chips (3 forced pairs), got ${chipCount}`);
    await appCI.page.evaluate(() => document.querySelector('tr.compact-run .pv-move').click());
    await appCI.page.waitForSelector('#pvFloat.pv-move-active, .pv-move-active', { timeout: 5000 }).catch(() => {});
    const active = await appCI.page.evaluate(() => !!document.querySelector('tr.compact-run .pv-move.pv-move-active'));
    assert(active, 'expected tapping a compacted move to open the mini board (pv-move-active)');
    ok('compact mode: a compacted run\'s move labels are tappable (mini board opens)');
  } catch(e){ bad('compact mode: compacted moves are clickable', e); }

  // 217. The triangle is live (not the disabled .toggle-empty placeholder)
  //      and expands JUST this line: its 3 forced moves render as normal
  //      per-move rows (each with data-opp and its own working row menu),
  //      while the table's OWN compact-run row (and its continuation into
  //      O-O/c5) stays exactly as it was -- compact mode is untouched
  //      everywhere else.
  try {
    const notEmpty = await appCI.page.evaluate(() =>
      !document.querySelector('tr.compact-run button.toggle').classList.contains('toggle-empty'));
    assert(notEmpty, 'expected the compact row\'s triangle to be a live (non-empty) toggle');

    // real Playwright click(), not evaluate()-click: this button's icon-only
    // layout collapses to a zero-height bounding box (a pre-existing .iconbtn
    // characteristic, not specific to this row), which trips Playwright's
    // actionability "visible" check for a real click.
    await appCI.page.evaluate(() => document.querySelector('tr.compact-run button.toggle').click());
    await appCI.page.waitForSelector('tr.data-row[data-opp="Nf6"]', { timeout: 5000 });
    const opps = await appCI.page.evaluate(() =>
      [...document.querySelectorAll('tr.data-row[data-opp]')].map(tr => tr.dataset.opp));
    assert(opps.includes('Nf6') && opps.includes('e6') && opps.includes('Bb4'),
      `expected the run's 3 forced moves as individual rows, got ${JSON.stringify(opps)}`);

    // one of the newly-expanded rows has a REAL row menu (three-dot -> Set
    // Standard Response etc.), unlike the compact-run row's single Analyse
    // button -- confirms these are genuine per-move rows, not another
    // read-only summary.
    const hasRowMenu = await appCI.page.evaluate(() =>
      !!document.querySelector('tr.data-row[data-opp="Nf6"] .rowMenuBtn'));
    assert(hasRowMenu, 'expected an expanded forced move to have its own row menu');

    // the run's own downstream branch (O-O / c5) still shows too, past the
    // expanded forced moves -- expansion resumes normal recursive rendering,
    // it doesn't stop at the run's own extent.
    const branchOpps = await appCI.page.evaluate(() =>
      [...document.querySelectorAll('tr.data-row[data-opp]')].map(tr => tr.dataset.opp));
    assert(branchOpps.includes('O-O') && branchOpps.includes('c5'),
      `expected the run's downstream branch (O-O/c5) visible once expanded, got ${JSON.stringify(branchOpps)}`);
    ok('compact mode: expanding one line renders its forced moves (with real per-move menus) plus its downstream branch');
  } catch(e){ bad('compact mode: expand-this-line renders full per-move rows', e); }

  // 218. Collapsing the SAME line again hides the per-move rows and brings
  //      back the compact-run row's own (untouched) continuation -- a clean
  //      round trip, not a one-way expansion. The expanded rows stay IN the
  //      DOM (their ancestor branch-row is just display:none, like the
  //      table's other collapsible branches) rather than being torn down --
  //      so visibility (offsetParent), not mere presence, is what to check.
  try {
    await appCI.page.evaluate(() => document.querySelector('tr.compact-run button.toggle').click());
    await appCI.page.waitForFunction(() => {
      const el = document.querySelector('tr.data-row[data-opp="Nf6"]');
      return !el || !el.offsetParent;
    }, { timeout: 5000 });
    const visibleOpps = () => appCI.page.evaluate(() =>
      [...document.querySelectorAll('tr.data-row[data-opp]')].filter(tr => tr.offsetParent).map(tr => tr.dataset.opp));
    const oppsAfterCollapse = await visibleOpps();
    assert(!oppsAfterCollapse.includes('Nf6') && !oppsAfterCollapse.includes('e6') && !oppsAfterCollapse.includes('Bb4'),
      `expected the forced-move rows hidden after collapsing, got ${JSON.stringify(oppsAfterCollapse)}`);
    assert(oppsAfterCollapse.includes('O-O') && oppsAfterCollapse.includes('c5'),
      `expected the run's own continuation (O-O/c5) still visible after collapsing, got ${JSON.stringify(oppsAfterCollapse)}`);
    const stillCompact = await appCI.page.evaluate(() => !!document.querySelector('tr.compact-run'));
    assert(stillCompact, 'expected the row to still be a compact-run row after collapsing (compact mode untouched)');
    ok('compact mode: collapsing an expanded line restores the compact row and its own continuation');
  } catch(e){ bad('compact mode: collapse-this-line round trip', e); }
} finally {
  await appCI.close();
}
} catch(e){ bad('Phase CI: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CI2: editing a move INSIDE an expanded compacted line refreshes
//     the ancestor compact-run row's own summary live -- no reload needed.
//     Reported bug: expanding a line, then deleting one of its own moves,
//     left the still-visible compact summary showing the deleted move until
//     the page was refreshed. Fixed via renderBranch's new notifyDirty param
//     (threaded alongside noCompactUntil), called by every mutation that can
//     change a compact run's shape/label; renderCompactRunRow's rebuildSelf
//     re-derives the run fresh and patches its own label/end-seq in place. ---
if(shouldRunPhase(['move-table'])){
try {
const appCI2 = await launchApp();
try {
  // pair1 (Nf6/c4) and pair2 (e6/Nc3) are real-game-backed; pair3 (Bb4/e3) is
  // PURELY manual (no game reaches it -- the one seeded game stops right at
  // Nc3) so it's deletable via "Remove This Move", the exact reported action.
  await seedBackup(appCI2.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4' },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3'], manualReplies: ['Bb4'] },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'e3' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3', white: 'a', black: 'b', result: '*' },
    ],
  }, { defaultPlayerColor: 'white' });
  await appCI2.page.click('.line-row');
  await appCI2.page.waitForSelector('tr.data-row', { timeout: 10000 });
  await appCI2.page.click('#compactModeBtn');
  await appCI2.page.waitForSelector('tr.compact-run', { timeout: 10000 });

  const labelText = () => appCI2.page.evaluate(() =>
    document.querySelector('tr.compact-run .compact-run-label').textContent);

  // 219. Baseline: the compact row's label covers all 3 pairs (6 chips)
  //      before any edit.
  try {
    const before = await appCI2.page.evaluate(() =>
      document.querySelector('tr.compact-run .compact-run-label').querySelectorAll('.pv-move').length);
    assert(before === 6, `expected 6 chips (3 pairs) before any edit, got ${before}`);
    ok('compact mode: baseline label covers all 3 forced pairs, including the manual one');
  } catch(e){ bad('compact mode notifyDirty: baseline label', e); }

  // 220. Expand the line, delete its own manual move (Bb4) via "Remove This
  //      Move" from WITHIN the expanded view, and confirm the still-visible
  //      compact-run row's summary shrinks to 2 pairs immediately -- no
  //      reload, no re-collapsing first.
  try {
    await appCI2.page.evaluate(() => document.querySelector('tr.compact-run button.toggle').click());
    await appCI2.page.waitForSelector('tr.data-row[data-opp="Bb4"]', { timeout: 5000 });

    await appCI2.page.evaluate(() => {
      const tr = document.querySelector('tr.data-row[data-opp="Bb4"]');
      tr.querySelector('.rowMenuBtn').click();
      tr.querySelector('[data-act="removeManual"]').click();
    });
    await appCI2.page.waitForFunction(() =>
      document.querySelector('tr.compact-run .compact-run-label').querySelectorAll('.pv-move').length === 4,
      { timeout: 5000 });

    const chipTexts = await appCI2.page.evaluate(() =>
      [...document.querySelector('tr.compact-run .compact-run-label').querySelectorAll('.pv-move')].map(c => c.textContent));
    assert(!chipTexts.includes('Bb4') && !chipTexts.includes('e3'),
      `expected the deleted pair gone from the LIVE compact summary (no reload), got ${JSON.stringify(chipTexts)}`);
    assert(chipTexts.includes('Nf6') && chipTexts.includes('c4') && chipTexts.includes('e6') && chipTexts.includes('Nc3'),
      `expected the remaining 2 pairs still in the summary, got ${JSON.stringify(chipTexts)}`);

    const newDataSeq = await appCI2.page.evaluate(() => document.querySelector('tr.compact-run').dataset.seq);
    assert(newDataSeq === 'd4,Nf6,c4,e6,Nc3', `expected the compact row's own seq identity shortened to the new end, got ${newDataSeq}`);

    const stillCompact = await appCI2.page.evaluate(() => !!document.querySelector('tr.compact-run'));
    assert(stillCompact, 'expected the row to remain a valid (now-2-pair) compact row, not dissolve');
    ok('compact mode: deleting a move from an expanded line live-updates the ancestor compact summary');
  } catch(e){ bad('compact mode notifyDirty: live label update on delete', e); }
} finally {
  await appCI2.close();
}
} catch(e){ bad('Phase CI2: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CJ: a corridor's move-object chain fans out to EVERY forward door,
//     not just the first, and follows a nudged slot/door-object live (no
//     rebuild needed). Reported: a 2-item corridor room whose tail branches
//     into 3 opponent continuations only got a chain link to the first of
//     the 3 doors, and dragging the room's own move-object left the chain
//     pointing at its old default spot until the room was re-entered. ---
if(shouldRunPhase(['vr-decorating'])){
try {
const appCJ = await launchApp();
try {
  // a 2-member corridor (C1 anchor + L1) whose tail (after L1's own reply)
  // branches into 3 real opponent tries, each with its own saved reply --
  // 3 forward doors off the SAME last slot.
  await seedBackup(appCJ.page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
      { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Fan', castleStreetNumber: 1 },
      { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'a3' },
      { seq: ['d4','Nf6','c4','e6','Nc3','Be7'], reply: 'e4' },
      { seq: ['d4','Nf6','c4','e6','Nc3','d5'], reply: 'cxd5' },
    ]}],
    games: [
      { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 a3', white: 'a', black: 'b', result: '*' },
      { id: 'g2', moves: 'd4 Nf6 c4 e6 Nc3 Be7 e4', white: 'a', black: 'b', result: '*' },
      { id: 'g3', moves: 'd4 Nf6 c4 e6 Nc3 d5 cxd5', white: 'a', black: 'b', result: '*' },
    ],
    assets: [
      { id: 'testProp1', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w: 0.3, h: 0.3, d: 0.3 } },
    ],
  }, { defaultPlayerColor: 'white' });
  await openVR(appCJ.page);
  const roomKey = await appCJ.page.evaluate(() => {
    const c = new Chess(); for(const m of ['d4','Nf6','c4']) c.move(m,{sloppy:true});
    return 'cas:L1_Fan:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
  });
  await appCJ.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
  await appCJ.page.waitForTimeout(200);

  // 221. The chain has one internal link (entry->L1) plus one per forward
  //      door (3), fanning out from the SAME last slot (L1) -- not just the
  //      first door.
  let targets, l1;
  try {
    const slots = await appCJ.page.evaluate(() => window.__threeTestEdit.moveObjectSlotsFull());
    l1 = slots.find(s => s.side === 'left' && s.order === 1);
    assert(l1, `expected an L1 slot, got ${JSON.stringify(slots)}`);
    const exits = await appCJ.page.evaluate((k) => window.__threeTestEdit.exits(k), roomKey);
    targets = exits.filter(e => !e.back).map(e => e.target);
    assert(targets.length === 3, `expected 3 forward doors, got ${JSON.stringify(exits)}`);

    const segs = await appCJ.page.evaluate(() => window.__threeTestEdit.chainSegments());
    assert(segs.length === 4, `expected 4 chain segments (1 internal + 3 door links), got ${segs.length}: ${JSON.stringify(segs)}`);

    const entryPos = await appCJ.page.evaluate(() => window.__threeTestEdit.chainEntryPos());
    const internalMid = { x: (entryPos.x + l1.x) / 2, z: (entryPos.z + l1.z) / 2 };
    const hitInternal = segs.some(s => Math.abs(s.x - internalMid.x) < 0.01 && Math.abs(s.z - internalMid.z) < 0.01);
    assert(hitInternal, `expected the entry-L1 segment at ${JSON.stringify(internalMid)}, got ${JSON.stringify(segs)}`);

    for(const target of targets){
      const doorPos = await appCJ.page.evaluate((args) => window.__threeTestEdit.doorObjBasePos(args.k, args.target), { k: roomKey, target });
      const mid = { x: (l1.x + doorPos.x) / 2, z: (l1.z + doorPos.z) / 2 };
      const hit = segs.some(s => Math.abs(s.x - mid.x) < 0.01 && Math.abs(s.z - mid.z) < 0.01);
      assert(hit, `expected a chain segment from L1 to door target ${target} at ${JSON.stringify(mid)}, got ${JSON.stringify(segs)}`);
    }
    ok('memorization-aid: a corridor\'s chain fans out to every forward door, not just the first');
  } catch(e){ bad('memorization-aid: chain fans out to all forward doors', e); }

  // 222. Selecting and arrow-key-nudging L1's own move-object (the REAL
  //      interactive flow, not the nudgeSlot test shortcut) moves every chain
  //      segment touching it LIVE -- the entry-L1 link and all 3 L1-door
  //      links -- with no room rebuild/re-entry.
  try {
    await appCJ.page.evaluate((args) => window.__threeTestEdit.setSlotAsset(args.rk, 'obj-L1', 'testProp1'), { rk: roomKey });
    await appCJ.page.waitForTimeout(150);

    await appCJ.page.evaluate(async () => {
      const dbg = window.__threeTestEdit;
      dbg.toggle();
      await new Promise(r => setTimeout(r, 60));
      dbg.target({ kind: 'accessory', slotId: 'obj-L1' });
      await new Promise(r => setTimeout(r, 60));
    });
    const sel = await appCJ.page.evaluate(() => window.__threeTestEdit.selected());
    assert(sel && sel.slotId === 'obj-L1', `test setup issue: expected obj-L1 selected, got ${JSON.stringify(sel)}`);

    for(let i = 0; i < 5; i++){
      await appCJ.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })));
      await appCJ.page.waitForTimeout(30);
    }
    await appCJ.page.waitForTimeout(100);

    const l1After = await appCJ.page.evaluate(() => window.__threeTestEdit.posOf('obj-L1'));
    assert(l1After && Math.abs(l1After.x - l1.x) > 0.05, `nudge didn't move L1 far enough to test with, got ${JSON.stringify(l1After)}`);

    const entryPos = await appCJ.page.evaluate(() => window.__threeTestEdit.chainEntryPos());
    const expectedInternal = { x: (entryPos.x + l1After.x) / 2, z: (entryPos.z + l1After.z) / 2 };
    const segsAfter = await appCJ.page.evaluate(() => window.__threeTestEdit.chainSegments());
    const hitInternalAfter = segsAfter.some(s => Math.abs(s.x - expectedInternal.x) < 0.01 && Math.abs(s.z - expectedInternal.z) < 0.01);
    assert(hitInternalAfter, `expected the entry-L1 link to follow the LIVE nudge (no rebuild) to ${JSON.stringify(expectedInternal)}, got ${JSON.stringify(segsAfter)}`);

    for(const target of targets){
      const doorPos = await appCJ.page.evaluate((args) => window.__threeTestEdit.doorObjBasePos(args.k, args.target), { k: roomKey, target });
      const mid = { x: (l1After.x + doorPos.x) / 2, z: (l1After.z + doorPos.z) / 2 };
      const hit = segsAfter.some(s => Math.abs(s.x - mid.x) < 0.01 && Math.abs(s.z - mid.z) < 0.01);
      assert(hit, `expected the L1-door link to target ${target} to follow the LIVE nudge to ${JSON.stringify(mid)}, got ${JSON.stringify(segsAfter)}`);
    }
    ok('memorization-aid: nudging a move-object live-updates every chain segment touching it, no rebuild needed');
  } catch(e){ bad('memorization-aid: chain follows a live (unsaved-rebuild) nudge', e); }
} finally {
  await appCJ.close();
}
} catch(e){ bad('Phase CJ: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CK: multiple forward doors anchored to the SAME room member (a
//     branch at a corridor's own tail, not a two-track) land on distinct,
//     staggered wall+offset positions instead of colliding on the exact same
//     spot. This is the "v1 known gap" the code used to explicitly flag as
//     unhandled -- found while building Phase CJ's own fan-out fixture,
//     which happens to hit this exact shape (3 forward doors off the same
//     last slot L1). Reuses that identical fixture. ---
if(shouldRunPhase(['castle-generation', 'vr-decorating'])){
try {
  const appCK = await launchApp();
  try {
    await seedBackup(appCK.page, {
      version: 6, user: 'tester',
      lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
        { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Fan', castleStreetNumber: 1 },
        { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
        { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'a3' },
        { seq: ['d4','Nf6','c4','e6','Nc3','Be7'], reply: 'e4' },
        { seq: ['d4','Nf6','c4','e6','Nc3','d5'], reply: 'cxd5' },
      ]}],
      games: [
        { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 a3', white: 'a', black: 'b', result: '*' },
        { id: 'g2', moves: 'd4 Nf6 c4 e6 Nc3 Be7 e4', white: 'a', black: 'b', result: '*' },
        { id: 'g3', moves: 'd4 Nf6 c4 e6 Nc3 d5 cxd5', white: 'a', black: 'b', result: '*' },
      ],
    }, { defaultPlayerColor: 'white' });
    await openVR(appCK.page);
    const roomKey = await appCK.page.evaluate(() => {
      const c = new Chess(); for(const m of ['d4','Nf6','c4']) c.move(m,{sloppy:true});
      return 'cas:L1_Fan:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
    });

    // 223. The 3 forward doors off the same last member (L1) each land on a
    //      distinct wall+offset -- not stacked on top of each other.
    try {
      const exits = await appCK.page.evaluate((k) => window.__threeTestEdit.exits(k), roomKey);
      const forward = exits.filter(e => !e.back);
      assert(forward.length === 3, `expected 3 forward doors, got ${JSON.stringify(exits)}`);

      const combos = new Set(forward.map(e => `${e.wall}@${e.offset}`));
      assert(combos.size === 3, `expected 3 distinct wall+offset combos (no collision), got ${JSON.stringify([...combos])} from ${JSON.stringify(forward)}`);

      // staggered along the same wall by exactly DOOR_SPACING (5.6) between
      // consecutive doors, mirroring the existing byWall east/west convention.
      const wall = forward[0].wall;
      assert(forward.every(e => e.wall === wall), `expected all 3 doors on the same wall (same source member), got ${JSON.stringify(forward)}`);
      const offsets = forward.map(e => e.offset).sort((a, b) => b - a);
      for(let i = 1; i < offsets.length; i++){
        const gap = offsets[i - 1] - offsets[i];
        assert(Math.abs(gap - 5.6) < 0.001, `expected consecutive doors DOOR_SPACING (5.6) apart, got gap ${gap} in ${JSON.stringify(offsets)}`);
      }
      ok('castle generation: doors sharing the same source member stagger instead of colliding');
    } catch(e){ bad('castle generation: same-member doors land on distinct staggered positions', e); }
  } finally {
    await appCK.close();
  }
} catch(e){ bad('Phase CK: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CK2: a room with exactly ONE forward door places it opposite
//     the entrance (north, since every generated room's back door is always
//     south -- see registerOneCastle) instead of the hash (doorWallFor) that
//     spreads MULTIPLE doors across walls to avoid collisions -- nothing to
//     spread with just one, and straight ahead as you walk in is simplest to
//     navigate. ---
if(shouldRunPhase(['castle-generation', 'vr-decorating'])){
try {
  const appCK2 = await launchApp();
  try {
    // A single, UNBRANCHED continuation would just merge into the SAME room
    // (a corridor -- see analyzeCastleStructure's chainNext/runs) rather
    // than create a door at all, so a genuine one-door room needs its lone
    // continuation to be a nested castle's own root: a foreign-castle
    // redirect never merges (buildCastleGraph/analyzeCastleStructure's own
    // `roomIds.has(e.target)` check skips it), so it's a real door, and with
    // no OTHER branch here there's exactly one of them.
    await seedBackup(appCK2.page, {
      version: 6, user: 'tester',
      lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
        { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Single', castleStreetNumber: 1 },
        { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3', isCastleRoot: true, castleName: 'SingleNested', castleStreetNumber: 2 },
      ]}],
      games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3', white: 'a', black: 'b', result: '*' }],
    }, { defaultPlayerColor: 'white' });
    await openVR(appCK2.page);
    const roomKey = await appCK2.page.evaluate(() => {
      const c = new Chess(); for(const m of ['d4','Nf6','c4']) c.move(m,{sloppy:true});
      return 'cas:L1_Single:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
    });

    // 225. The single forward door lands on north, not wherever the hash
    //      happens to send it.
    try {
      const exits = await appCK2.page.evaluate((k) => window.__threeTestEdit.exits(k), roomKey);
      const forward = exits.filter(e => !e.back);
      assert(forward.length === 1, `test setup issue: expected exactly one forward door, got ${JSON.stringify(exits)}`);
      assert(forward[0].wall === 'north', `expected the sole forward door opposite the entrance (north), got ${forward[0].wall}`);
      ok('castle generation: a room with exactly one forward door places it opposite the entrance (north)');
    } catch(e){ bad('castle generation: single forward door lands opposite the entrance', e); }
  } finally {
    await appCK2.close();
  }
} catch(e){ bad('Phase CK2: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CL: a move-object slot given only a placeholder WORD label (no
//     image) is selectable/movable just like an image-backed accessory --
//     clicking it selects for nudging instead of always reopening "pick an
//     asset". Reported: a named-only object had no way to be moved because
//     every click on it went straight back to the asset picker. ---
if(shouldRunPhase(['vr-decorating'])){
try {
  const appCL = await launchApp();
  try {
    await seedBackup(appCL.page, {
      version: 6, user: 'tester',
      lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
        { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
        { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
      ]}],
      games: [{ id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3', white: 'a', black: 'b', result: '*' }],
    }, { defaultPlayerColor: 'white' });
    await openVR(appCL.page);
    const roomKey = await appCL.page.evaluate(() => {
      const c = new Chess(); for(const m of ['d4','Nf6','c4']) c.move(m,{sloppy:true});
      return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
    });
    await appCL.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
    await appCL.page.waitForTimeout(200);
    await appCL.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
    await appCL.page.waitForTimeout(60);
    const slotIds = await appCL.page.evaluate((k) => window.__threeTestEdit.moveObjectSlotIds(k), roomKey);
    const slotId = slotIds.find(id => id !== 'obj-C1');
    assert(slotId, `test setup issue: expected a non-center move-object slot, got ${JSON.stringify(slotIds)}`);

    // assign a placeholder WORD label (no image) via the real picker UI --
    // same flow a user takes from an empty slot (mirrors Phase AR's test 139).
    await appCL.page.evaluate((sid) => window.__threeTestEdit.target({ kind: 'slot', slotId: sid, allow: ['extruded','billboard-cylindrical'] }), slotId);
    await appCL.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
    await appCL.page.fill('#pickerWordInput', 'Grandfather Clock');
    await appCL.page.click('#pickerWordApplyBtn');
    await appCL.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
    await appCL.page.waitForTimeout(150);

    // 224. The word plaque's scene object is tagged 'accessory' now, not
    //      'slot' -- a real click on it selects for movement instead of
    //      reopening the asset picker.
    try {
      const kind = await appCL.page.evaluate((sid) => window.__threeTestEdit.kindOf(sid), slotId);
      assert(kind === 'accessory', `expected the word plaque tagged 'accessory' (selectable), got '${kind}'`);
      ok('move-object word label: the built plaque is selectable ("accessory"), not a direct picker trip ("slot")');
    } catch(e){ bad('move-object word label: plaque is tagged accessory, not slot', e); }

    // 225. Selecting it via the real edit-target flow and arrow-key nudging
    //      moves the plaque live -- same as an image-backed accessory. The
    //      gear icon (not exercised here, covered by openPropManager's
    //      existing allowWord wiring) is what re-opens the picker now.
    try {
      const before = await appCL.page.evaluate((sid) => window.__threeTestEdit.posOf(sid), slotId);
      await appCL.page.evaluate((sid) => window.__threeTestEdit.target({ kind: 'accessory', slotId: sid }), slotId);
      const sel = await appCL.page.evaluate(() => window.__threeTestEdit.selected());
      assert(sel && sel.slotId === slotId, `expected the word plaque selected, got ${JSON.stringify(sel)}`);

      for(let i = 0; i < 5; i++){
        await appCL.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })));
        await appCL.page.waitForTimeout(30);
      }
      await appCL.page.waitForTimeout(100);
      const after = await appCL.page.evaluate((sid) => window.__threeTestEdit.posOf(sid), slotId);
      assert(after && Math.abs(after.x - before.x) > 0.05, `expected the plaque to move live on nudge, before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
      ok('move-object word label: arrow-key nudge moves the plaque live, same as an image accessory');
    } catch(e){ bad('move-object word label: real select+nudge flow moves the plaque', e); }
  } finally {
    await appCL.close();
  }
} catch(e){ bad('Phase CL: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CM: a two-track room's two lanes each get their OWN floor chain
//     (mirroring a plain corridor's single chain), both fanning out from the
//     shared entrance, each fanning to only ITS OWN lane's forward door(s) --
//     not the other lane's. Reported: for consistency with corridors, a
//     two-track room's lanes should be chained the same way a corridor's
//     items are. Root branches after c4 into a 2-member left lane (L1, L2)
//     whose tail (L2's own reply) itself branches into 2 forward doors, and
//     a 2-member right lane (R1, R2) that genuinely dead-ends (no forward
//     door, no unbuilt reply) -- one fixture covering both the fan-out and
//     the "only this lane's own doors" isolation in one room. ---
if(shouldRunPhase(['vr-decorating'])){
try {
  const appCM = await launchApp();
  try {
    await seedBackup(appCM.page, {
      version: 6, user: 'tester',
      lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
        { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
        { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
        { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Qc2' },
        { seq: ['d4','Nf6','c4','e6','Nc3','Bb4','Qc2','O-O'], reply: 'a3' },
        { seq: ['d4','Nf6','c4','e6','Nc3','Bb4','Qc2','a6'], reply: 'e4' },
        { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
        { seq: ['d4','Nf6','c4','g6','Nc3','Bg7'], reply: 'e4' },
      ]}],
      games: [
        { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O a3', white: 'a', black: 'b', result: '*' },
        { id: 'g2', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Qc2 a6 e4', white: 'a', black: 'b', result: '*' },
        { id: 'g3', moves: 'd4 Nf6 c4 g6 Nc3 Bg7 e4', white: 'a', black: 'b', result: '*' },
      ],
      assets: [
        { id: 'testProp1', type: 'extruded', image: 'data:image/png;base64,iVBORw0KGgo=', size: { w: 0.3, h: 0.3, d: 0.3 } },
      ],
    }, { defaultPlayerColor: 'white' });
    await openVR(appCM.page);
    const roomKey = await appCM.page.evaluate(() => {
      const c = new Chess(); for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
      return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
    });
    await appCM.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
    await appCM.page.waitForTimeout(200);

    // 226. Left lane (L1, L2, 2 forward doors off L2) gets 4 segments
    //      (entry-L1, L1-L2, L2-door1, L2-door2); right lane (R1, R2, no
    //      forward door) gets exactly 2 (entry-R1, R1-R2) -- 6 total.
    let slots, targets, l1, l2, r1, r2;
    try {
      slots = await appCM.page.evaluate(() => window.__threeTestEdit.moveObjectSlotsFull());
      l1 = slots.find(s => s.side === 'left' && s.order === 1);
      l2 = slots.find(s => s.side === 'left' && s.order === 2);
      r1 = slots.find(s => s.side === 'right' && s.order === 1);
      r2 = slots.find(s => s.side === 'right' && s.order === 2);
      assert(l1 && l2 && r1 && r2, `expected L1/L2/R1/R2 slots, got ${JSON.stringify(slots)}`);

      const exits = await appCM.page.evaluate((k) => window.__threeTestEdit.exits(k), roomKey);
      targets = exits.filter(e => !e.back).map(e => e.target);
      assert(targets.length === 2, `expected 2 forward doors (both off the left lane), got ${JSON.stringify(exits)}`);

      const segs = await appCM.page.evaluate(() => window.__threeTestEdit.chainSegments());
      assert(segs.length === 6, `expected 6 chain segments (4 left + 2 right), got ${segs.length}: ${JSON.stringify(segs)}`);

      const entryPos = await appCM.page.evaluate(() => window.__threeTestEdit.chainEntryPos());
      const mid = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
      const hasSeg = (p) => segs.some(s => Math.abs(s.x - p.x) < 0.01 && Math.abs(s.z - p.z) < 0.01);

      assert(hasSeg(mid(entryPos, l1)), `expected entry-L1 segment, got ${JSON.stringify(segs)}`);
      assert(hasSeg(mid(l1, l2)), `expected L1-L2 segment, got ${JSON.stringify(segs)}`);
      assert(hasSeg(mid(entryPos, r1)), `expected entry-R1 segment, got ${JSON.stringify(segs)}`);
      assert(hasSeg(mid(r1, r2)), `expected R1-R2 segment, got ${JSON.stringify(segs)}`);
      for(const target of targets){
        const doorPos = await appCM.page.evaluate((args) => window.__threeTestEdit.doorObjBasePos(args.k, args.target), { k: roomKey, target });
        assert(hasSeg(mid(l2, doorPos)), `expected an L2-door segment to ${target}, got ${JSON.stringify(segs)}`);
      }
      // no segment fans out from R2 (right lane has no forward door)
      assert(!segs.some(s => Math.abs(s.z - r2.z) < 0.01 && Math.abs(s.x - r2.x) > 0.01),
        `expected no door-link segment off R2 (right lane has no forward door), got ${JSON.stringify(segs)}`);
      ok('two-track: each lane gets its own chain, fanning to only its own forward door(s)');
    } catch(e){ bad('two-track: per-lane chains with correct fan-out and isolation', e); }

    // 227. Nudging LEFT lane's L1 live-updates only left-lane segments
    //      (entry-L1, L1-L2); right-lane segments are untouched.
    try {
      await appCM.page.evaluate((args) => window.__threeTestEdit.setSlotAsset(args.rk, 'obj-L1', 'testProp1'), { rk: roomKey });
      await appCM.page.waitForTimeout(150);
      await appCM.page.evaluate(async () => {
        const dbg = window.__threeTestEdit;
        dbg.toggle();
        await new Promise(r => setTimeout(r, 60));
        dbg.target({ kind: 'accessory', slotId: 'obj-L1' });
        await new Promise(r => setTimeout(r, 60));
      });
      const sel = await appCM.page.evaluate(() => window.__threeTestEdit.selected());
      assert(sel && sel.slotId === 'obj-L1', `test setup issue: expected obj-L1 selected, got ${JSON.stringify(sel)}`);

      for(let i = 0; i < 5; i++){
        await appCM.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })));
        await appCM.page.waitForTimeout(30);
      }
      await appCM.page.waitForTimeout(100);

      const l1After = await appCM.page.evaluate(() => window.__threeTestEdit.posOf('obj-L1'));
      assert(l1After && Math.abs(l1After.x - l1.x) > 0.05, `nudge didn't move L1 far enough to test with, got ${JSON.stringify(l1After)}`);

      const entryPos = await appCM.page.evaluate(() => window.__threeTestEdit.chainEntryPos());
      const segsAfter = await appCM.page.evaluate(() => window.__threeTestEdit.chainSegments());
      const mid = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
      const hasSeg = (p) => segsAfter.some(s => Math.abs(s.x - p.x) < 0.01 && Math.abs(s.z - p.z) < 0.01);

      assert(hasSeg(mid(entryPos, l1After)), `expected entry-L1 to follow the nudge, got ${JSON.stringify(segsAfter)}`);
      assert(hasSeg(mid(l1After, l2)), `expected L1-L2 to follow the nudge, got ${JSON.stringify(segsAfter)}`);
      // right lane's own segments are untouched by a left-lane nudge
      assert(hasSeg(mid(entryPos, r1)), `expected entry-R1 unchanged after a left-lane nudge, got ${JSON.stringify(segsAfter)}`);
      assert(hasSeg(mid(r1, r2)), `expected R1-R2 unchanged after a left-lane nudge, got ${JSON.stringify(segsAfter)}`);
      assert(segsAfter.length === 6, `expected still 6 segments total after the nudge, got ${segsAfter.length}: ${JSON.stringify(segsAfter)}`);
      ok('two-track: nudging one lane\'s slot live-updates only that lane\'s chain, the other lane\'s is untouched');
    } catch(e){ bad('two-track: live nudge updates only the nudged lane\'s chain', e); }
  } finally {
    await appCM.close();
  }
} catch(e){ bad('Phase CM: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CN: a two-track room's two lanes dead-end INDEPENDENTLY -- a
//     lane with no forward door and no unbuilt reply gets its own skinnable
//     "no entry" sign, centered in its own half of the north wall, while a
//     lane with a real forward door gets none. Reuses Phase CM's exact
//     fixture (left lane has 2 forward doors; right lane genuinely
//     dead-ends). ---
if(shouldRunPhase(['vr-decorating'])){
try {
  const appCN = await launchApp();
  try {
    await seedBackup(appCN.page, {
      version: 6, user: 'tester',
      lines: [{ id: 'L1', name: 'Test', color: 'white', openingMoves: ['d4'], prefs: [
        { seq: ['d4','Nf6'], reply: 'c4', isCastleRoot: true, castleName: 'Alpha', castleStreetNumber: 1 },
        { seq: ['d4','Nf6','c4','e6'], reply: 'Nc3' },
        { seq: ['d4','Nf6','c4','e6','Nc3','Bb4'], reply: 'Qc2' },
        { seq: ['d4','Nf6','c4','e6','Nc3','Bb4','Qc2','O-O'], reply: 'a3' },
        { seq: ['d4','Nf6','c4','e6','Nc3','Bb4','Qc2','a6'], reply: 'e4' },
        { seq: ['d4','Nf6','c4','g6'], reply: 'Nc3' },
        { seq: ['d4','Nf6','c4','g6','Nc3','Bg7'], reply: 'e4' },
      ]}],
      games: [
        { id: 'g1', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O a3', white: 'a', black: 'b', result: '*' },
        { id: 'g2', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Qc2 a6 e4', white: 'a', black: 'b', result: '*' },
        { id: 'g3', moves: 'd4 Nf6 c4 g6 Nc3 Bg7 e4', white: 'a', black: 'b', result: '*' },
      ],
      assets: [
        { id: 'doorSkin1', type: 'door', image: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
    }, { defaultPlayerColor: 'white' });
    await openVR(appCN.page);
    const roomKey = await appCN.page.evaluate(() => {
      const c = new Chess(); for(const m of ['d4','Nf6','c4']) c.move(m, { sloppy: true });
      return 'cas:L1_Alpha:' + window.__positionKey(c.fen()).replace(/[^a-zA-Z0-9]/g,'_');
    });
    await appCN.page.evaluate((k) => window.__threeTestEdit.enter(k), roomKey);
    await appCN.page.waitForTimeout(200);

    // 228. Exactly one no-continuation icon, on the RIGHT half of the north
    //      wall (positive x, quarter-width offset) -- the dead-ending lane.
    //      Nothing on the left half (real forward doors there).
    try {
      const size = await appCN.page.evaluate((k) => window.__threeTestEdit.roomSize(k), roomKey);
      const quarter = size.w / 4;
      const meshes = await appCN.page.evaluate(() => window.__threeTestEdit.meshes());
      const icons = meshes.filter(m => m.kind === 'no-continuation-icon');
      assert(icons.length === 1, `expected exactly 1 no-entry icon (right lane only), got ${icons.length}: ${JSON.stringify(icons)}`);
      assert(Math.abs(icons[0].x - quarter) < 0.01, `expected the icon centered in the RIGHT half (x=${quarter}), got x=${icons[0].x}`);
      assert(icons[0].wall === 'north', `expected the icon on the north wall, got ${icons[0].wall}`);
      ok('two-track: the dead-ending lane gets its own no-entry sign, centered in its own half');
    } catch(e){ bad('two-track: per-lane no-entry sign presence and position', e); }

    // 229. Skinning the right lane's sign through the real picker (edit mode
    //      + the marker's own click target, tagged track:'right') applies
    //      ONLY to that lane -- the whole-room (untracked) and left-lane
    //      overrides stay null.
    try {
      await appCN.page.evaluate(() => window.__threeTestEdit.toggle());   // edit mode on
      await appCN.page.waitForTimeout(60);
      await appCN.page.evaluate((k) => window.__threeTestEdit.target({ kind: 'dead-end', roomKey: k, track: 'right' }), roomKey);
      await appCN.page.waitForSelector('#assetPickerOverlay', { state: 'visible', timeout: 5000 });
      await appCN.page.evaluate(() => {
        const card = [...document.querySelectorAll('#pickerGrid .asset-card')]
          .find(c => !c.classList.contains('asset-card-color') && c.textContent.includes('doorSkin1'));
        card.click();
      });
      await appCN.page.waitForSelector('#assetPickerOverlay', { state: 'hidden', timeout: 5000 });
      await appCN.page.waitForTimeout(150);

      const rightOverride = await appCN.page.evaluate((k) => window.__threeTestEdit.deadEndOverrideId(k, 'right'), roomKey);
      assert(rightOverride === 'doorSkin1', `expected the right lane's override to be doorSkin1, got ${rightOverride}`);
      const leftOverride = await appCN.page.evaluate((k) => window.__threeTestEdit.deadEndOverrideId(k, 'left'), roomKey);
      assert(!leftOverride, `expected the left lane's own override untouched, got ${leftOverride}`);
      const wholeRoomOverride = await appCN.page.evaluate((k) => window.__threeTestEdit.deadEndOverrideId(k), roomKey);
      assert(!wholeRoomOverride, `expected the whole-room (untracked) override untouched, got ${wholeRoomOverride}`);

      const meshes = await appCN.page.evaluate(() => window.__threeTestEdit.meshes());
      assert(!meshes.some(m => m.kind === 'no-continuation-icon'), `expected the built-in icon replaced by the custom panel, got ${JSON.stringify(meshes.filter(m => m.kind === 'no-continuation-icon'))}`);
      ok('two-track: a lane\'s dead-end sign is independently skinnable, without affecting the other lane or the whole-room override');
    } catch(e){ bad('two-track: per-lane dead-end sign skinning is independent', e); }
  } finally {
    await appCN.close();
  }
} catch(e){ bad('Phase CN: uncaught error outside a numbered test (setup or otherwise)', e); }
}

// --- Phase CO: auto-import Phase 1 -- pure sizing heuristics that estimate
//     how far back a DUE-but-never-run-today auto-check should look, from
//     how long it's been since the newest already-stored game for that
//     platform. Deliberately biased to overshoot (see the functions' own doc
//     comment in app.js): a floor so a short absence still gets fully
//     covered, a cap so a long absence doesn't balloon into one enormous
//     request. Pure functions over a plain games array -- no seeded backup,
//     no DB, no network needed. ---
if(shouldRunPhase(['auto-import'])){
try {
const appCO = await launchApp();
try {
  const defaults = await appCO.page.evaluate(() => window.__autoImportTestHooks.defaults);

  // 230. lastGameDateForSource finds the max createdAt among games matching
  //      the requested source ONLY, ignoring the other platform's games and
  //      picking the newest (not the first) when several match.
  try {
    const games = [
      { source: 'chesscom', createdAt: 1000 },
      { players: {}, createdAt: 5000 },          // lichess-shaped (has `players`)
      { source: 'chesscom', createdAt: 3000 },   // newest chesscom
    ];
    const cc = await appCO.page.evaluate((gs) => window.__autoImportTestHooks.lastGameDateForSource(gs, 'chesscom'), games);
    const lc = await appCO.page.evaluate((gs) => window.__autoImportTestHooks.lastGameDateForSource(gs, 'lichess'), games);
    const none = await appCO.page.evaluate((gs) => window.__autoImportTestHooks.lastGameDateForSource(gs, 'lichess'), []);
    assert(cc === 3000, `expected the newest chess.com game's createdAt (3000), got ${cc}`);
    assert(lc === 5000, `expected the newest (only) lichess game's createdAt (5000), got ${lc}`);
    assert(none === null, `expected null for a platform with no games at all, got ${none}`);
    ok('auto-import: lastGameDateForSource picks the newest same-platform game, ignoring the other platform');
  } catch(e){ bad('auto-import: lastGameDateForSource', e); }

  // 231. estimateChessComAutoMonths: no prior chess.com game at all falls back
  //      to the same default the manual download modal already offers.
  try {
    const months = await appCO.page.evaluate(() => window.__autoImportTestHooks.estimateChessComAutoMonths([]));
    assert(months === defaults.chesscomDefault, `expected the manual default (${defaults.chesscomDefault}) with no prior chess.com game, got ${months}`);
    ok('auto-import: estimateChessComAutoMonths falls back to the manual default with no prior chess.com game');
  } catch(e){ bad('auto-import: estimateChessComAutoMonths default', e); }

  // 232. estimateChessComAutoMonths: a game dated slightly in the FUTURE
  //      (clamped to 0 elapsed days, robust against any real clock drift
  //      between this assertion and the function's own Date.now() call --
  //      unlike "createdAt: now", which sits exactly on ceil()'s integer
  //      boundary and any nonzero drift flips it) floors at the minimum; a
  //      45-day-old game (well clear of the 30/60-day ceil boundaries) lands
  //      mid-range; a ~800-day-old game clamps at the cap instead of
  //      requesting an absurd number of months.
  try {
    const dayMs = 86400000;
    const future = await appCO.page.evaluate(({now, dayMs}) => window.__autoImportTestHooks.estimateChessComAutoMonths([{ source: 'chesscom', createdAt: now + 10*dayMs }]), { now: Date.now(), dayMs });
    const midRange = await appCO.page.evaluate(({now, dayMs}) => window.__autoImportTestHooks.estimateChessComAutoMonths([{ source: 'chesscom', createdAt: now - 45*dayMs }]), { now: Date.now(), dayMs });
    const veryOld = await appCO.page.evaluate(({now, dayMs}) => window.__autoImportTestHooks.estimateChessComAutoMonths([{ source: 'chesscom', createdAt: now - 800*dayMs }]), { now: Date.now(), dayMs });
    assert(future === defaults.chesscomMin, `expected a future-dated (0-elapsed-day) game to floor at the minimum (${defaults.chesscomMin}), got ${future}`);
    assert(midRange === 3, `expected a 45-day-old game to estimate 3 months back, got ${midRange}`);
    assert(veryOld === defaults.chesscomMax, `expected an ~800-day-old game to clamp at the cap (${defaults.chesscomMax}), got ${veryOld}`);
    ok('auto-import: estimateChessComAutoMonths floors/scales/caps correctly from days-since-last-game');
  } catch(e){ bad('auto-import: estimateChessComAutoMonths floor/scale/cap', e); }

  // 233. estimateLichessAutoMaxGames: same shape of test, but for Lichess's
  //      game-count-based API and its own default/min/max/per-day constants.
  //      The mid-range case uses 2 days + 1 hour (2.0417 days), not a clean
  //      multiple of a day -- days*150 landing exactly on an integer (as a
  //      whole number of days, or any tenth of a day, would given 150's
  //      factors) is exactly the same boundary-flip risk as test 232's
  //      "today" case, just easier to trip over by accident when picking a
  //      round day count.
  try {
    const noPrior = await appCO.page.evaluate(() => window.__autoImportTestHooks.estimateLichessAutoMaxGames([]));
    assert(noPrior === defaults.lichessDefault, `expected the manual default (${defaults.lichessDefault}) with no prior lichess game, got ${noPrior}`);

    const dayMs = 86400000;
    const future = await appCO.page.evaluate(({now, dayMs}) => window.__autoImportTestHooks.estimateLichessAutoMaxGames([{ players: {}, createdAt: now + 10*dayMs }]), { now: Date.now(), dayMs });
    assert(future === defaults.lichessMin, `expected a future-dated (0-elapsed-day) game to floor at the minimum (${defaults.lichessMin}), got ${future}`);

    const midRange = await appCO.page.evaluate(({now, dayMs}) => window.__autoImportTestHooks.estimateLichessAutoMaxGames([{ players: {}, createdAt: now - (2*dayMs + dayMs/24) }]), { now: Date.now(), dayMs });
    assert(midRange === 307, `expected a ~2.04-day-old game to estimate 307 games back, got ${midRange}`);

    const longAbsence = await appCO.page.evaluate(({now, dayMs}) => window.__autoImportTestHooks.estimateLichessAutoMaxGames([{ players: {}, createdAt: now - 10*dayMs }]), { now: Date.now(), dayMs });
    assert(longAbsence === defaults.lichessMax, `expected a 10-day absence to clamp at the cap (${defaults.lichessMax}), got ${longAbsence}`);
    ok('auto-import: estimateLichessAutoMaxGames floors/scales/caps correctly from days-since-last-game');
  } catch(e){ bad('auto-import: estimateLichessAutoMaxGames floor/scale/cap', e); }
} finally {
  await appCO.close();
}
} catch(e){ bad('Phase CO: uncaught error outside a numbered test (setup or otherwise)', e); }
}

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
