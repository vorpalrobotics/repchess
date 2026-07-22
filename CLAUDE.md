# repchess — notes for Claude Code

Chess opening-repertoire trainer with a VR "memory palace" walkthrough.
Static site (HTML + ES modules), **no build step**; libraries load from CDNs.
Deployed via GitHub Pages.

## Testing the VR / app headlessly (important)

The app imports three.js, cytoscape, cytoscape-dagre and chess.js from public
CDNs (esm.sh, cdnjs). **Those CDNs are network-blocked in the agent/CI sandbox**,
so the app cannot boot in a plain headless browser here.

There is a self-contained offline harness that fixes this — use it to actually
verify VR/app changes (not just syntax-check):

```sh
cd test && npm install && npm test
```

It serves the repo and intercepts the CDN URLs with locally-vendored library
builds (`test/vendor/`, committed), then boots the app and walks the VR world.
See [`test/README.md`](test/README.md). Add cases to `test/run-tests.mjs`;
reuse `launchApp` / `seedBackup` / `openVR` from `test/harness.mjs` and inspect
the scene via the app's `window.__threeTestEdit` hook. When a library **version**
changes in the source, rerun `node test/build-vendor.mjs`.

Run the suite **once** per feature/fix — a single clean run is enough
confirmation, for the new/changed test too. Do **not** additionally disable
the fix, rerun to watch the test fail, then restore and rerun again — that
"verify by reversion" cycle triples the wall-clock cost for routine changes
and is reserved for cases with a specific reason to distrust the test itself
(it's asserting something subtle, or you're not fully sure the assertion
would actually catch the bug). Don't repeat the full run 2+ times "for
stability" as a matter of routine either — real clock time, little payoff on
a clean run. Reserve extra runs for an actual reason to suspect flakiness in
*this* change (e.g. a new failure that looks timing-related).

If a test fails and investigation shows it's flaky/load-sensitive rather than
a real regression, don't sink time re-running to confirm — either fix the
root cause if it's quick and obvious, or just disable that one test (comment
it out with a one-line reason, matching the precedent at the "150 ... removed
-- it flaked" comment in run-tests.mjs) and move on. A full-suite multi-run
stress pass is only for major/structural changes (e.g. touching the harness
itself), not ordinary feature work.

## Version / cache-buster discipline

Every deploy must be identifiable in the browser:

- `js/app.js` — bump `const BUILD_TAG = '-N'` (shown in the page heading).
- `index.html` — bump `js/app.js?v=…-N`.
- Bump a module's own `?v=` cache-buster (e.g. `threeVR.js?v=…`) **only when
  that module changed**; `app.js` imports each with its version.

Keep these in lockstep so the visible build tag confirms exactly what deployed.

## Git workflow

Feature branch → PR → merge (do not commit straight to `main`). Only open a PR
when asked. GitHub Pages serves from `main`.
