# REPchess — Opening Repertoire Builder & VR Memory Palace

A single-page web app that helps you build, analyze, and memorize a chess
opening repertoire from your own game history — with an optional Three.js
"memory palace" VR walkthrough for actually committing lines to memory.

Live at: https://vorpalrobotics.github.io/repchess/

## What it does

- **Download games**: fetch your recent games directly from the public
  Lichess or Chess.com APIs (no server, no API key required), or import a
  local NDJSON/PGN file, pasted variations, or a bulk set of move-image
  PNGs.
- **Find frequent replies**: pick a starting move and see every reply your
  opponents actually played at that point, sorted by frequency.
- **Build a repertoire**: for each opponent reply, enter your preferred
  response and expand the line recursively, as deep as your games go.
  Includes a network/digraph view of the whole tree (transpositions,
  move quality, memorized/decorated status) alongside the move table.
- **Engine analysis**: a Stockfish engine (WASM, multi-threaded when
  cross-origin-isolated) runs live evaluations and a background analysis
  queue over your repertoire.
- **Mnemonics**: attach an image or note to any move, quiz yourself on them,
  and test your recognition against a live chessboard.
- **VR memory palace**: "Run VR" walks your repertoire as an explorable
  Three.js castle — one room per real decision point, forced sequences
  collapsed into corridors/two-track rooms with objects pegged to each
  move-pair, doors for real branches, elevators for wide branch points.
  Decorate rooms with your own uploaded/generated images (Asset Manager),
  mark rooms memorized, and jump straight into any room from the digraph.
  See `CLAUDE.md` and `Documents/` for the design/implementation notes.
- **Persistence**: everything (repertoire, mnemonics, VR layout/assets) is
  saved in the browser's IndexedDB, and can be exported/imported as backup
  JSON files.

## Running locally

Static HTML + ES modules, no build step. Libraries (cytoscape,
cytoscape-dagre, three.js, chess.js, cm-chessboard, Chart.js, Stockfish)
load from CDNs at runtime. Just open `index.html` in a browser, or serve
the directory with any static file server.

## Testing

See `CLAUDE.md` and `test/README.md` — there's a self-contained offline
Playwright harness (`cd test && npm install && npm test`) that vendors the
CDN libraries locally so the app and VR walkthrough can actually be booted
and exercised in a sandboxed/CI environment.

## Deployment

The site auto-deploys to GitHub Pages via `.github/workflows/deploy-pages.yml` on every push to `main`. In the repo settings, **Settings → Pages → Source** must be set to **GitHub Actions**.

## Learn more

- `CLAUDE.md` — conventions for working on this codebase (testing, build/
  version discipline, git workflow).
- `Documents/` — design notes for the castle/room model, linear-sequence
  packing, object lists, and the VR asset pipeline, each labeled with what's
  shipped vs. still proposed.
- `help/` — the in-app Help modal's own topic pages.
