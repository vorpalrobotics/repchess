# Testing the VR / app headlessly — a guide for future agents

**TL;DR:** the app can't boot in the sandbox because its CDN libraries are
network-blocked. There is a committed offline harness that fixes this. Use it to
*actually run* VR/app changes instead of only syntax-checking them.

```sh
cd test && npm install && npm test        # 150+ tests, phases A.. onward
```

This document is the "why and how"; [`test/README.md`](../test/README.md) is the
quick reference. If you change VR/world behavior, **run this harness before you
claim it works** — a green `node --check` says nothing about whether the world
renders.

**Before deciding how much of the suite to run for a given change**, read
[`../test/TESTING_POLICY.md`](../test/TESTING_POLICY.md) — a tiered policy
scoped to the size/risk of the change (a constant tweak needs no run at all;
a shared/core change may justify two full runs). Don't default to a full
run + revert + rerun + reapply + rerun cycle for every change regardless of
size; that's the exact pattern the policy exists to retire.

---

## Why the app won't boot in the sandbox

The app is a no-build static site that pulls these from public CDNs:

| Library | Source | Import site | Blocks boot? |
|---|---|---|---|
| cytoscape `3.28.1` | esm.sh | top-level in `js/app.js` | **yes** |
| cytoscape-dagre `2.5.0` | esm.sh | top-level in `js/app.js` | **yes** |
| chess.js `0.10.3` | cdnjs | classic `<script>` in `index.html` | effectively yes |
| three.js `0.160.0` | esm.sh | dynamic `import()` in `js/threeVR.js` | only for VR |
| cm-chessboard, Chart.js, Stockfish | unpkg/cdnjs/… | dynamic, tolerant | no |

The agent/CI sandbox denies outbound HTTPS to those CDN hosts (esm.sh, cdnjs,
unpkg) — both from the headless browser *and* from tool-level `curl`. When the
top-level esm.sh imports fail, `js/app.js` never finishes evaluating, so nothing
runs. That's the whole obstacle.

Note the asymmetry that makes the fix possible: the **npm registry is
reachable** in the sandbox even though the CDNs are not. So the exact library
versions can be installed with `npm` and vendored locally.

## How the harness works

`test/harness.mjs`:

1. Serves the repo over `http://127.0.0.1:<port>` (a tiny static file server).
2. Launches the preinstalled Chromium (`/opt/pw-browsers/chromium`) via
   Playwright.
3. **Intercepts the CDN URLs** with `page.route()` and fulfills them from
   locally-vendored builds in `test/vendor/` (committed). Everything same-origin
   passes through to the static server; un-mocked CDNs (cm-chessboard, fonts,
   Chart.js, Stockfish) are aborted and the app degrades gracefully.
4. Blocks the app's **COOP/COEP service worker**. That worker exists only to
   enable `crossOriginIsolated` for the Stockfish WASM engine; left enabled it
   reloads the page and re-wraps cross-origin fetches, which defeats the route
   interception. The VR/app work fine without it.

**Production is never touched.** The app keeps its real CDN URLs; the remapping
lives only in the harness. `test/vendor/` is dead weight to the deployed site
(index.html never references it) — it exists purely for tests.

## Writing a test

`harness.mjs` exports three helpers:

- `launchApp()` → `{ page, consoleErrors, blockedCdn, close }` — boots the app
  with interception in place and the `window.__threeTestEdit` debug hook enabled
  (it sets `localStorage.threeTestDebug` before any app code runs).
- `seedBackup(page, backup)` — restores a minimal backup through the *real*
  import path, so the world has systems/castles to render. Example seed for a
  white system that opens 1.d4:
  ```js
  await seedBackup(page, {
    version: 6, user: 'tester',
    lines: [{ id: 'L1', name: 'London', color: 'white', openingMoves: ['d4'], prefs: [] }],
  });
  ```
- `openVR(page)` — triggers the `Run VR` ("Build world") flow and waits for the
  render loop. (It clicks the menu item programmatically because it lives in the
  collapsed hamburger and isn't "visible" to a normal Playwright click.)

Inspect the running world through the app's built-in debug hook
(`window.__threeTestEdit`, only present because the harness set the flag):

| Call | Returns |
|---|---|
| `scan()` | every scene object with `userData.kind`, as `{kind, slotId, wall, roomKey, buildingKey, …}` — the main assertion surface |
| `meshes()` | geometry meshes with world positions (note: **Sprites are excluded**, so camera-facing billboards/tiles show up in `scan()` but not here) |
| `enter(roomKey)` | teleport into a room (forces a rebuild) |
| `toggle()` | flip edit mode |
| `target(ud)` | drive the edit-target path (select a prop by its userData) |
| `teleport(x,z,yaw)` / `pos()` | move / read the player |
| `memorized()` / `setMemorized(key,val)` | read/seed the 🧠 memorized-room flag without clicking the toolbar icon |
| `decorated()` / `setDecorated(key,val)` / `evaluateDecorated()` | same, for the "fully decorated" 🎨 flag |
| `isRoomEmpty(key)` | the locked-door "nothing built past here" check for a target room |
| `jumpToRoom(key)` | the fast-path teleport "Jump to VR" uses |

`__threeTestEdit` covers the 3D world specifically. As features accumulated,
each grew its own narrowly-scoped hook (all gated behind the same
`threeTestDebug` flag, all defined near the feature they test) rather than
piling more onto one giant object — check near the feature's own code for
the exact shape before writing a test against it:

| Hook | Covers |
|---|---|
| `window.__statsTestHooks` | `computeNodeStats` (Node Statistics / "complete to move N") |
| `window.__graphTestHooks` | the transposition-graph cytoscape instance and its own memorized/decorated setters |
| `window.__vrCacheTestHooks` | the `gatherBuiltCastles` in-memory cache — `isCached()`, `invalidate()`, plus direct calls into a couple of write paths |
| `window.__aqTestHooks` | the background analysis queue |
| `window.__oqTestHooks` | the opening quiz session |
| `window.__evalTestHooks` | saved/live engine evaluations |
| `window.__cropTestHooks` | the crop/erase image editor |
| `window.__miniBoardGridHtml` | the mini-board grid markup (VR toolbar icon, room-info modal) |

Grep `window.__` in `js/app.js`/`js/threeVR.js` for the current, authoritative
list — this table will drift as features are added; treat it as a starting
point, not ground truth.

Also available: `window.__threeTestState` = `{room, x, z, y, yaw, editMode}`,
updated every frame.

A typical VR test: `launchApp()` → `seedBackup(...)` → `openVR(page)` → assert on
`scan()` / `__threeTestState`. See `test/run-tests.mjs` for worked examples
(e.g. verifying the opening-move tile is placed under the street sign and
survives a select → nudge → rebuild).

### Gotchas worth knowing up front

- **Seeding needs data.** With no user/lines, `generateMainStreet` falls back to
  a single default street with no systems — so system-specific decorations won't
  appear. Seed a backup first.
- **`confirm()` dialogs.** Backup restore pops a confirm; the harness
  auto-accepts all dialogs (`page.on('dialog', d => d.accept())`).
- **Sprites vs meshes.** Move-image tiles and pair billboards are `THREE.Sprite`
  — assert them via `scan()` (by `slotId`), not `meshes()`.
- **Benign console noise.** Aborted CDNs, the Stockfish "could not load", and a
  harmless "reading 'scope'" from the blocked SW are expected; `run-tests.mjs`
  filters them so only a genuinely missing core dependency fails the boot check.

## Maintaining the vendored libraries

`test/vendor/*.mjs` + `test/vendor/chess.js` are committed so tests need no build
step. Rebuild them **only when a library version changes in the app**:

```sh
node test/build-vendor.mjs
```

Versions are pinned at the top of `build-vendor.mjs`; keep them in sync with the
CDN URLs in `index.html`, `js/app.js`, and `js/threeVR.js`. The script npm-installs
those exact versions into a temp dir and bundles them (three is copied as-is;
cytoscape / cytoscape-dagre are esbuild-bundled to single-file ESM; chess.js is a
UMD global served verbatim).

## Extending coverage

Only the VR-critical libraries are vendored today. If you need to test the 2D
board (cm-chessboard) or the history charts (Chart.js), vendor those the same
way: add them to `build-vendor.mjs`, produce an ESM bundle, and add a `CDN_MAP`
entry in `harness.mjs` mapping their CDN URL to the vendored file.
