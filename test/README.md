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
| cm-chessboard `8` piece sprite (`assets/pieces/standard.svg` only) | `unpkg` | `fetch()` in `js/app.js`/`js/threeVR.js` (mini boards) |

In the CI/agent sandbox those CDN hosts are **network-blocked**, so the app
can't boot there and browser-level tests were impossible. This harness fixes
that **without touching production**: it serves the repo over http and uses
Playwright request interception to satisfy those exact CDN URLs from
locally-vendored builds in [`vendor/`](vendor). The app's own CDN URLs are
unchanged — the remapping lives only in `harness.mjs`.

The cm-chessboard **JS widget**, Chart.js and Stockfish are left un-mocked;
the app already degrades gracefully when they're absent, and the VR flow
doesn't need them. Only the piece **sprite** (a static SVG, no bundling
needed) is vendored, since both mini boards (VR toolbar icon, graph room-info
modal) render their pieces from it directly via `fetch()` + inline SVG `<use>`
— not through the widget.

## Run

```sh
cd test
npm install     # playwright (browser is preinstalled at /opt/pw-browsers)
npm test
```

This is the **system test**: every phase in `run-tests.mjs` (200+ individual
checks), which takes roughly an hour. Only run it for large/structural
changes, or when you actually need the full-suite guarantee — see "Targeted
(unit) runs" below for everyday work.

Tests drive the app through its real paths (backup restore to seed data, the
`Run VR` menu action, real clicks) and inspect state via the app's built-in
`window.__threeTestEdit` / `window.__graphTestHooks` / etc. debug hooks
(enabled here by setting `localStorage.threeTestDebug`).

## Targeted (unit) runs

`run-tests.mjs` is organized into **phases** (one `launchApp()` + a themed
group of checks each), and every phase is tagged with one or more
**subsystems**. Passing subsystem names as CLI args runs only the phases
tagged with at least one of them — much faster than the full system test,
and the right default for day-to-day feature work:

```sh
node run-tests.mjs digraph mnemonics    # or comma-separated: digraph,mnemonics
node run-tests.mjs --list               # print every subsystem name + description
npm test                                # no args: full system test, unchanged
```

The `core` subsystem (the boot smoke test) always runs alongside a targeted
subsystem, even if you don't name it, as a cheap sanity check that the
harness itself works before trusting the targeted result. If a change
touches two subsystems, just list both — no need to fall back to the full
suite.

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

Adding a **new phase**: wrap it the same way every existing phase is —
`if(shouldRunPhase(['your-subsystem'])){ const appN = await launchApp(); try
{ ... } finally { await appN.close(); } }` — reusing an existing subsystem
name from the `SUBSYSTEMS` map near the top of `run-tests.mjs` if one fits,
or adding a new entry there (with a one-line description) if it genuinely
doesn't. A phase can list more than one tag if it doesn't cleanly belong to
just one. Adding a **test within an existing phase** needs no tagging at
all — it inherits that phase's subsystem(s) automatically.
