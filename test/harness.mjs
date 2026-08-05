// Offline test harness for repchess.
//
// The app pulls three.js / cytoscape / cytoscape-dagre / chess.js from public
// CDNs (esm.sh, cdnjs) that are unreachable in the CI/agent sandbox, so the app
// can't boot there. This harness serves the repo over http and uses Playwright
// request interception to satisfy those exact CDN URLs from locally-vendored
// builds under ./vendor (see build-vendor.mjs). Production is untouched — the
// interception lives only here.
//
// Requires the browser test hook: we set localStorage.threeTestDebug so
// openThreeTest exposes window.__threeTestEdit (scan/enter/toggle/…).

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const VENDOR = path.join(HERE, 'vendor');

// CDN URL → vendored file. Matched against the full request URL (query and all).
const CDN_MAP = [
  { re: /esm\.sh\/three@/,            file: 'three.mjs', type: 'application/javascript' },
  { re: /esm\.sh\/cytoscape-dagre@/,  file: 'cytoscape-dagre.mjs', type: 'application/javascript' },
  { re: /esm\.sh\/cytoscape@/,        file: 'cytoscape.mjs', type: 'application/javascript' },
  { re: /chess\.js\/.*chess(\.min)?\.js/, file: 'chess.js', type: 'application/javascript' },
  // the cm-chessboard piece sprite (SVG <use> art shared by the real boards and
  // both mini boards) -- only this one static asset is vendored, not the whole
  // cm-chessboard JS widget, which stays un-mocked/aborted like other non-core CDNs.
  { re: /cm-chessboard@.*\/pieces\/standard\.svg/, file: 'cm-chessboard-standard.svg', type: 'image/svg+xml' },
];

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

function startServer(){
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if(p === '/') p = '/index.html';
      const full = path.join(REPO, p);
      if(!full.startsWith(REPO)){ res.writeHead(403); res.end(); return; }
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Launch the app in a headless page with CDN interception in place.
// Returns { browser, page, close, consoleErrors, blockedCdn }.
// threeTestDebug=false boots the app the way a REAL user's browser does --
// no localStorage.threeTestDebug flag, so no __xTestHooks are exposed and
// every `if(!localStorage.getItem('threeTestDebug'))`-guarded boot path
// (there's exactly one today: maybeOfferDefaultMnemonics) actually runs.
// Every other test in this suite wants the flag ON (default), since that's
// what exposes the hooks tests drive things through -- this mode exists
// specifically to catch bugs that only manifest in real boot code the
// flag-gated majority of tests structurally can never reach.
export async function launchApp({ headless = true, threeTestDebug = true } = {}){
  const server = await startServer();
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium',
    headless,
  });
  // Block the app's COOP/COEP service worker: it reloads the page and wraps
  // cross-origin fetches to enable crossOriginIsolation for the Stockfish engine,
  // which defeats our CDN route interception. The VR/app work fine without it
  // (only the WASM engine needs SharedArrayBuffer).
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();

  const consoleErrors = [];
  const consoleLogs = [];   // every console.log text, in order -- for tests asserting on deliberate diagnostic logging (e.g. auto-import's verbose mode), not just error absence
  const blockedCdn = [];
  page.on('console', m => {
    if(m.type() === 'error') consoleErrors.push(m.text());
    if(m.type() === 'log') consoleLogs.push(m.text());
  });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));
  page.on('dialog', d => d.accept());   // auto-accept confirm() during restore etc.

  // turn on the in-app test hook before any app code runs (unless this
  // launch specifically wants a real-user boot, see threeTestDebug above)
  if(threeTestDebug){
    await page.addInitScript(() => { try { localStorage.setItem('threeTestDebug', '1'); } catch {} });
  }

  await page.route(/^https?:\/\//, async route => {
    const url = route.request().url();
    if(url.startsWith(origin)) return route.continue();          // our static server
    const hit = CDN_MAP.find(m => m.re.test(url));
    if(hit){
      const body = await readFile(path.join(VENDOR, hit.file));
      return route.fulfill({ status: 200, contentType: hit.type, body });
    }
    blockedCdn.push(url);        // cm-chessboard / chart / fonts — app degrades gracefully
    return route.abort();
  });

  await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });
  // app.js sets #buildStamp right after its (now-satisfied) static imports resolve
  await page.waitForFunction(() => {
    const el = document.getElementById('buildStamp');
    return el && el.textContent && el.textContent.trim().length > 0;
  }, { timeout: 15000 });

  return {
    browser, page, consoleErrors, consoleLogs, blockedCdn, origin,
    async close(){ await browser.close(); server.close(); },
  };
}

// Restore a minimal backup through the real import path, seeding a user + lines
// so the generated world has systems to render. Returns when restore settles.
//
// `opts.defaultPlayerColor` ('white'|'black'), when given, fills in a
// `players` field for every game in `backup.games` that doesn't already have
// one -- `backup.user` (restored as the Lichess handle, see applyBackupData's
// lichessUser/data.user back-compat fallback) on that color, a synthetic
// opponent on the other. The app now only counts a game toward
// move-frequency/node-stats/castle generation
// (and Find Games/Compare Games) when it can determine the signed-in user
// actually played the CURRENT line's own color, so most seeds need this to
// produce any visible rows/rooms at all.
// A game that already specifies `players` is left untouched (so a test can
// still seed a deliberately WRONG-side or genuinely undeterminable-color
// game by giving it explicit players, or none, and omitting this option /
// not relying on it for that one game). Single-color only -- a seed mixing
// a White and a Black line in one call needs per-game `players` instead,
// since there's no one right default for both.
export async function seedBackup(page, backup, opts = {}){
  const { defaultPlayerColor } = opts;
  let data = backup;
  if(defaultPlayerColor && Array.isArray(backup.games)){
    const testerSide = defaultPlayerColor === 'black' ? 'black' : 'white';
    const oppSide = testerSide === 'white' ? 'black' : 'white';
    const testerName = backup.user || 'tester';   // must match the restored Lichess handle (backup.user), not a hardcoded name
    data = {
      ...backup,
      games: backup.games.map((g, i) => g.players ? g : {
        ...g,
        players: { [testerSide]: { user: { name: testerName } }, [oppSide]: { user: { name: `opp${i}` } } },
      }),
    };
  }
  // importBackup sets the restored lichess/chesscom handles and userId.value
  // near the very START, well before games/lines/mnemonics are actually
  // written -- polling that (as this used to) can resolve while the restore
  // is still mid-flight, racing whatever the caller does next.
  // __importBackupGen only bumps at the very end (after renderHome()), so
  // wait for THAT instead: capture the count before triggering the import,
  // then wait for it to move past that value.
  const before = await page.evaluate(() => window.__importBackupGen ? window.__importBackupGen() : 0);
  await page.setInputFiles('#backupImport', {
    name: 'seed.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  });
  await page.waitForFunction(
    n => window.__importBackupGen && window.__importBackupGen() > n,
    before, { timeout: 15000 },
  );
}

// Mocks Lichess's ndjson game-export endpoint (fetchLatest's own URL) for one
// username, returning `games` verbatim -- one JSON object per line, matching
// exactly what fetchLatest's streaming parser expects. Call AFTER launchApp():
// registered as its own page.route matching only this URL, layered on top of
// (not replacing) launchApp's broad CDN-interception route, which still
// governs every other request untouched.
export async function mockLichessGames(page, username, games){
  const body = games.map(g => JSON.stringify(g)).join('\n');
  await page.route(new RegExp(`lichess\\.org/api/games/user/${username}`), route =>
    route.fulfill({ status: 200, contentType: 'application/x-ndjson', body }));
}

// Open the VR "Build world" flow and wait for the render loop to be live.
export async function openVR(page){
  // the menu item lives in the collapsed hamburger, so click it programmatically
  // rather than via a visibility-gated UI click
  await page.evaluate(() => document.getElementById('menuThreeTest').click());
  await page.waitForFunction(() => !!window.__threeTestEdit, { timeout: 20000 });
  await page.waitForFunction(() => !!window.__threeTestState, { timeout: 20000 });
}
