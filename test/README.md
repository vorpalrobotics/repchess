# Offline VR/app test harness

Headless tests that actually boot the app and walk the VR world — including
things that can only be checked by rendering (e.g. "is the opening-move tile
placed under the street sign?").

## Why this exists

The app loads a few libraries from public CDNs:

| Library | Source (in the app) | How it's imported |
|---|---|---|
| three.js `0.160.0` | `esm.sh` | dynamic `import()` in `js/threeVR.js` (VR only) |
| cytoscape `3.28.1` | `esm.sh` | top-level in `js/app.js` (**boot-blocking**) |
| cytoscape-dagre `2.5.0` | `esm.sh` | top-level in `js/app.js` (**boot-blocking**) |
| chess.js `0.10.3` | `cdnjs` | classic `<script>` in `index.html` |

In the CI/agent sandbox those CDN hosts are **network-blocked**, so the app
can't boot there and browser-level tests were impossible. This harness fixes
that **without touching production**: it serves the repo over http and uses
Playwright request interception to satisfy those exact CDN URLs from
locally-vendored builds in [`vendor/`](vendor). The app's own CDN URLs are
unchanged — the remapping lives only in `harness.mjs`.

`cm-chessboard`, Chart.js and Stockfish are left un-mocked; the app already
degrades gracefully when they're absent, and the VR flow doesn't need them.

## Run

```sh
cd test
npm install     # playwright (browser is preinstalled at /opt/pw-browsers)
npm test
```

Expected: `4 passed, 0 failed`.

## What's tested (`run-tests.mjs`)

1. **App boots offline** — proves cytoscape/cytoscape-dagre/chess.js resolved
   from the vendored builds (otherwise `app.js` never evaluates).
2. **VR world renders** — proves three.js loaded and the render loop is live.
3. **Opening-move tile present** — a seeded white `1.d4` system shows its
   editable opening-move tile under the street sign (`slotId open-L1`).
4. **Tile is editable** — select → nudge → room rebuild keeps the tile.

Tests drive the app through its real paths (backup restore to seed data, the
`Run VR` menu action) and inspect the three.js scene via the app's built-in
`window.__threeTestEdit` debug hook (enabled here by setting
`localStorage.threeTestDebug`).

## Vendored libraries

`vendor/*.mjs` + `vendor/chess.js` are committed so tests run with no build
step. Regenerate them only when a library **version** changes in the app:

```sh
node build-vendor.mjs      # versions are pinned at the top of that file
```

Keep the versions in `build-vendor.mjs` in sync with the CDN URLs in
`index.html`, `js/app.js`, and `js/threeVR.js`.

## Adding a test

`harness.mjs` exports `launchApp()`, `seedBackup(page, backup)`, and
`openVR(page)`. A typical VR test: `launchApp()` → `seedBackup(...)` →
`openVR(page)` → assert against `window.__threeTestEdit.scan()` (scene userData)
or `window.__threeTestState` (player/room state).
