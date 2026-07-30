# Handoff — status as of this note

Written at the end of a long session so a fresh agent (new chat, no memory of
the conversation that produced this) can pick up context quickly instead of
re-deriving it. **This file is a snapshot, not a standing doc** — update or
delete it as things change; don't let it silently rot into a source of
stale claims the way the docs it references almost did (see below).

## State at time of writing

- `main` is at commit `39346fb` (PR #152 merged). `js/app.js`'s `BUILD_TAG`
  is `-250`.
- No open PRs, no open threads, nothing in flight. Everything requested this
  session shipped and merged (list below for context, not because any of it
  needs further action).
- Working branch used throughout: `claude/sharp-meitner-4eputl`, currently
  even with `main` (safe to reset from `origin/main` if it looks behind or
  stale — see the recovery note below).

## What shipped this session (PRs #141–152, roughly in order)

- Phantom-en-passant `positionKey` fix (a chess-position identity bug that
  was splitting one true position into two different VR rooms) + a dynamic
  VR back-door fix that depended on it.
- VR room-size self-heal (`reconcileRoomBounds`) for rooms left too small by
  the above fix, plus a couple of stale toolbar tests found along the way.
- Version-stamped two persisted VR caches (`gatherBuiltCastles`,
  the games-position index) so a new deploy auto-invalidates them instead of
  silently serving stale-logic output.
- Move-table "compact mode": per-line expand + clickable moves, and a fix so
  editing inside an expanded compacted line live-refreshes its own summary
  row instead of going stale until a manual refresh.
- Move-object floor chain: fans out to every forward door (not just the
  first) from a corridor's last slot, and follows a live (unsaved-rebuild)
  nudge instead of only updating on the next full rebuild.
- Fixed a door-placement collision: multiple forward doors anchored to the
  same room member used to land on the exact same wall spot; now staggered.
- Word-only move-object labels (a typed placeholder, no image) are now
  selectable/movable like image-backed objects, instead of every click
  reopening the asset picker.
- Two-track rooms get their own per-lane floor chains (mirroring a
  corridor's chain) and per-lane "no entry" dead-end signs, instead of
  neither being supported at all for two-track rooms.
- A full documentation review (`Documents/*.md`, `README.md`, `CLAUDE.md`)
  and a full help-content review (`help/*.html`) — fixed several stale
  "not built yet" claims for features that had since shipped, a couple of
  broken cross-references, and one internally-inconsistent worked example.

## Known environment gotcha (already documented in `CLAUDE.md`)

The local git working directory has repeatedly reverted to a stale commit
mid-session in this environment — see `CLAUDE.md`'s "Known issue: the local
workspace can silently revert to a stale commit" section for the symptom and
the exact recovery commands. Nothing has ever been lost from git history
from this — only uncommitted edits are at risk, so commit+push promptly
rather than sitting on a large uncommitted diff.

## Where to look for more

- `CLAUDE.md` — standing conventions (testing policy, build/version
  discipline, git workflow, the environment gotcha above). Read this first;
  it's loaded automatically at the start of every session.
- `Documents/` — design notes for the castle/room model, each explicitly
  labeled with what's shipped vs. still proposed (just refreshed this
  session, so should be accurate as of `main` HEAD).
- `git log --oneline` / the PR list on GitHub — the actual authoritative
  history of what's been done and why (commit messages this session were
  written to explain the "why," not just the "what").
