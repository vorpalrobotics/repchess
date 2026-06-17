# REPchess — Lichess Opening Repertoire Builder

A single-page web app that helps you build and maintain a chess opening repertoire from your own Lichess game history.

Live at: https://vorpalrobotics.github.io/repchess/

## What it does

- **Download games**: Enter a Lichess username and a max game count, and the app fetches your recent games directly from the public Lichess API (no server, no API key required).
- **Find frequent replies**: Pick a starting move (e.g. `d4`), and the app scans your downloaded games to show every reply your opponents played at that point, sorted by frequency and percentage.
- **Build a repertoire**: For each opponent reply, enter your preferred response and expand the line to see how opponents replied to *that*, recursively, as deep as your games go.
- **Keep notes**: Attach a free-text note to any line in the tree.
- **Persistence**: Your chosen replies and notes are saved in the browser's `localStorage`, keyed by Lichess username, so your repertoire tree rebuilds automatically next time you visit.
- **Manual import**: If you'd rather not hit the Lichess API, you can import a local NDJSON file of games instead.

## Running locally

This is a static HTML file with no build step or dependencies beyond a CDN-hosted copy of `chess.js`. Just open `index.html` in a browser, or serve the directory with any static file server.

## Deployment

The site auto-deploys to GitHub Pages via `.github/workflows/deploy-pages.yml` on every push to `main`. In the repo settings, **Settings → Pages → Source** must be set to **GitHub Actions**.

## Status

Early stage. Known gaps:
- The "Side" (White/Black) selector isn't wired up yet — game matching doesn't filter by color.
- The "Analyse" button is a placeholder (no engine evaluation yet).
- No board/PGN preview for individual games.
- No export of the built repertoire outside of browser `localStorage`.
