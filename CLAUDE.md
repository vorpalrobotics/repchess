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
confirmation. Don't repeat the full run 2+ times "for stability" as a matter
of routine; that's real clock time with little payoff once a run is clean.
Only repeat a run when there's an actual reason to suspect flakiness (e.g. a
failure that looks timing-related, or you're specifically investigating a
flaky test). An occasional full multi-run pass as a sanity check is fine, but
it's not a required step for ordinary feature work.

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
