# Handoff — status as of this note

Written at the end of a long session so a fresh agent (new chat, no memory of
the conversation that produced this) can pick up context quickly instead of
re-deriving it. **This file is a snapshot, not a standing doc** — update or
delete it as things change; don't let it silently rot into a source of stale
claims. (The version this replaced described `BUILD_TAG -250` and PR #152,
long after both were history — that is exactly the failure mode to avoid.)

## State at time of writing

- `main` is at commit `b96d050` (PR #198 merged). `js/app.js`'s `BUILD_TAG`
  is `-358`.
- No open PRs and nothing in flight. Everything requested this session
  shipped and merged.
- Working branch used throughout: `claude/project-onboarding-iozvt5`,
  currently even with `main` (safe to reset from `origin/main` if it looks
  behind or stale — see the recovery note below).

## The one genuinely open problem: VR slowness

**Read `Documents/VR-Slow-Bug-info.md` before touching this.** It is a full
writeup and is current as of this note. The short version:

VR becomes unusable (~5 s per keypress) on the user's main PC for hours or
days, then clears up on its own. Never reproduces on another machine or in
incognito. A **Reset to Factory** (which deletes the IndexedDB database)
fixes it immediately; **restoring a backup** (which only `clear()`s the
object stores) never does; a full reboot never does either.

The leading theory is tombstone-driven IndexedDB degradation — see
[Chromium issue 41008118](https://issues.chromium.org/issues/41008118),
which describes queries running 10–40× slower after a mass add/delete cycle
until a lazy compaction runs. That implicates the app's own restore path,
which deletes ~18,000 game records and immediately re-inserts ~18,000.
It is a strong fit, **not a proven finding** — don't report it as settled.

Two things were deliberately left undone, both awaiting the user's word:

1. **Move `safetyBackup` into its own IndexedDB database**, so a restore can
   end by deleting and recreating the main database (leaving it compact, the
   way factory reset does) without destroying the crash-recovery snapshot in
   the process. The user correctly pointed out that deleting the database
   naively would take the safety net with it; a separate database resolves
   that, and is actually safer than today. Design details are in the doc.
2. **Stamp the persisted caches with a format-version constant instead of
   `BUILD_TAG`.** Today every deploy invalidates both the position index and
   the built-castles cache, so every user pays a full rebuild (~40 s on the
   user's dataset) after every single push.

Also unexplained and worth a look: the persisted position-index cache has
been stamped `-324` for a dozen-plus builds, meaning its re-save never lands.
See the doc's "loose ends" section.

Diagnostic instrumentation tagged `[perf-debug]` is still in place in
`index.html` and `js/app.js`, deliberately — do not strip it until this is
root-caused. It is all commented as TEMP.

## What shipped this session (PRs #195–198)

- **Transposition/redirect fixes.** A background scan racing a full restore;
  concurrent `gatherBuiltCastles` calls racing on the shared `PREFS` global;
  `findBrokenRedirects` matching by a stale `anchor.seq` instead of by
  position; and the same function being blind to positions folded into a
  corridor/two-track room, which made hiding one branch of a fork wrongly
  clear an untouched sibling's redirect.
- **Find Transpositions folds descendant collisions into their ancestor.**
  Redirecting via the report auto-ports the source's subtree to the target,
  so after a later repair both castles share every position below the
  transposition point — which used to list as one group each (the user's
  "six pairs found" for what was really one). Only the top-most is
  actionable, so descendants now fold in and are counted on the survivor.
- **Find Transpositions batch resolve.** Radios per room plus one
  "Redirect Selected" button, so several groups resolve in a single press
  with one re-scan, instead of a full castle rebuild between each click.
- **VR CPU guardrail.** Entering VR caps the engine to one thread
  (`Engine.setThreadBudget`) and blocks Perfect Opening and the manual
  analysis queue from starting new jobs; both restored on exit.
- **UX:** a "Reading backup file…" spinner over the previously silent
  read/parse gap before the restore confirm; and the auto-repair toast
  reworded ("N rooms restored to normal — target disappeared (potential
  transposition)") since the old wording implied a redirect had been *fixed*
  when it had actually been cleared.

## Test-suite gotcha

The `VR cache: invalidated by …` group in `test/run-tests.mjs` is **flaky in
this environment** — a different sub-test fails on each run (manual reply
add/remove, hide/unhide toggle, local file import, manual-only engine
import), and it fails on unmodified `main` too. Don't chase it as a
regression from your own change without first confirming against a stash;
per `CLAUDE.md`, either fix the root cause if it's quick and obvious or
comment the case out with a one-line reason.

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
- `Documents/VR-Slow-Bug-info.md` — the open bug above, in full.
- `Documents/` — design notes for the castle/room model, each explicitly
  labeled with what's shipped vs. still proposed.
- `git log --oneline` / the PR list on GitHub — the authoritative history of
  what's been done and why (commit messages are written to explain the
  "why," not just the "what").
