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

**Don't run the full suite (`npm test`) on your own initiative — it costs the
user real development-cycle time (roughly an hour's worth across a session),
and only the user can weigh that cost against a given change.** Write/update
the test cases for whatever you changed as normal, but stop short of
executing `npm test`. If you judge a change large or risky enough to warrant
a run, say so and ask; proceed only once the user actually says to run it.
The user may also just tell you to run it outright — do so then, no need to
re-ask. Static/syntax-level self-checks (reading the diff, reasoning through
the logic) are still expected; they're not a substitute for the harness, but
they're free and don't require asking.

When the user does have you run it: once is enough confirmation, including
for the new/changed test. Do **not** additionally disable the fix, rerun to
watch the test fail, then restore and rerun again — that "verify by
reversion" cycle multiplies the cost for routine changes and is reserved for
cases with a specific reason to distrust the test itself (it's asserting
something subtle, or you're not fully sure the assertion would actually
catch the bug) -- and even then, only with the user's go-ahead given the time
cost. Don't repeat the run 2+ times "for stability" as a matter of routine
either. If a run turns up a failure that investigation shows is flaky/
load-sensitive rather than a real regression, don't sink further runs into
chasing it — either fix the root cause if it's quick and obvious, or just
disable that one test (comment it out with a one-line reason, matching the
precedent at the "150 ... removed -- it flaked" comment in run-tests.mjs) and
move on.

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
