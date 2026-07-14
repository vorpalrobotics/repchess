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
export async function launchApp({ headless = true } = {}){
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
  const blockedCdn = [];
  page.on('console', m => { if(m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));
  page.on('dialog', d => d.accept());   // auto-accept confirm() during restore etc.

  // turn on the in-app test hook before any app code runs
  await page.addInitScript(() => { try { localStorage.setItem('threeTestDebug', '1'); } catch {} });

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
    browser, page, consoleErrors, blockedCdn, origin,
    async close(){ await browser.close(); server.close(); },
  };
}

// Restore a minimal backup through the real import path, seeding a user + lines
// so the generated world has systems to render. Returns when restore settles.
export async function seedBackup(page, backup){
  await page.setInputFiles('#backupImport', {
    name: 'seed.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  // importBackup logs "restored …"; wait for CURRENT_USER to reflect the seed
  await page.waitForFunction(
    u => document.getElementById('userId') && document.getElementById('userId').value === u,
    backup.user, { timeout: 10000 },
  );
}

// Open the VR "Build world" flow and wait for the render loop to be live.
export async function openVR(page){
  // the menu item lives in the collapsed hamburger, so click it programmatically
  // rather than via a visibility-gated UI click
  await page.evaluate(() => document.getElementById('menuThreeTest').click());
  await page.waitForFunction(() => !!window.__threeTestEdit, { timeout: 20000 });
  await page.waitForFunction(() => !!window.__threeTestState, { timeout: 20000 });
}
