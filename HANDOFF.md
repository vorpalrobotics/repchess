# Handoff — status as of this note

Written at the end of a long session so a fresh agent (new chat, no memory of
the conversation that produced this) can pick up context quickly instead of
re-deriving it. **This file is a snapshot, not a standing doc** — update or
delete it as things change; don't let it silently rot into a source of stale
claims. (One earlier version of this file described `BUILD_TAG -250` and
PR #152 long after both were history — that is exactly the failure mode to
avoid.)

## State at time of writing

- `main` is at commit `9823d79` (PR #206 merged). `js/app.js`'s `BUILD_TAG`
  is `-374`.
- No open PRs and nothing in flight. Everything requested this session
  shipped and merged.
- Working branch used throughout: `claude/project-onboarding-iozvt5`,
  currently even with `main` (safe to reset from `origin/main` if it looks
  behind or stale — see the recovery note below).

## The one genuinely open problem: VR slowness

**Read `Documents/VR-Slow-Bug-info.md` before touching this.** It is a full
writeup and is still current. The short version:

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

**Status of the trail:** the last data point was the user updating Chrome to
152.0.7977.82, on the theory that a recent Chromium regression might have
introduced it and the update might have fixed it. There has been **no report
either way since** — the issue has neither recurred nor been confirmed gone.
Treat it as open and unverified, not as fixed.

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
been stamped `-324` for many builds, meaning its re-save never lands. See
the doc's "loose ends" section.

Diagnostic instrumentation tagged `[perf-debug]` is still in place in
`index.html` and `js/app.js`, deliberately — do not strip it until this is
root-caused. It is all commented as TEMP.

## What shipped this session (PRs #199–206)

**Spaced-repetition room reviews (PR #202, phases R1–R5).** The largest piece,
and the one most likely to need follow-up:

- **The schedule** lives in `js/db.js` — a fixed ladder `1/3/7/21/60/180`
  days rather than SM-2's ease factor. `db.js` is a classic `<script>`, so
  both `threeVR.js` and `app.js` reach its functions as globals; they don't
  import each other, and both need the same rules. Put anything else shared
  between them there for the same reason.
- **A** advances and clamps, **C** resets to the bottom, **B** holds but a
  second consecutive B demotes. ±15% fuzz, due dates snapped to local
  midnight. Note the fuzz does nothing below ~a week (±15% of 3 days is
  absorbed by the midnight snap) — that's deliberate and commented.
- A memorized room with **no stored record** derives one from the memorized
  timestamp (`effectiveRoomReview`), so an existing repertoire joined the
  schedule with no migration.
- **In VR:** the brain icon tints by due state and opens a grading menu;
  `1`/`2`/`3` grade directly. Re-grading within one visit *replaces* rather
  than compounds (`preGradeRecord`).
- **In the graph:** the old Completeness checkbox became a **View dropdown**
  (Normal / Completeness / Review). Both lenses ride along as classes on
  every render, so switching is a pure restyle.
- **On door signs:** DUE / OVERDUE pills, also on elevator floor panels.
- **R5** docks a step off a room that's picked up a new door. The record
  carries a `dirtySeen` ledger of doors already accounted for — the dirty
  flag itself stays true until the user re-memorizes, so it can't be the
  trigger. `applyRoomReviewGrade` carries that ledger through a grade.
  **Its sweep runs on VR open only** — `MEMORIZED_SHAPES` is threeVR's to
  maintain, and one writer beats a graph render writing to a mirror copy, so
  a structural change reaches the graph's Review lens one walk late.

**Follow-ups from actually using it (PRs #204–206).** These came back as
reports after R1–R5 shipped, and are the shape of feedback to expect more of:

- **Marking a room memorized toasts its first review date**, and unmarking
  warns that the review history went with it.
- **A door sign carries one `mark`**, not just a due badge: a dim grey 🧠 for
  a room never learned, the DUE/OVERDUE pill for one with a review waiting,
  nothing at all when it's learned and up to date. The brain is the **emoji**,
  not Font Awesome — FA is a CDN webfont and a canvas draw of it is tofu
  whenever it hasn't loaded, which is every run under the offline harness.
- **A castle's entry room** is reached through a street building, not a door,
  so it had no sign to mark. Its marker rides the stat strip on the street
  entry billboard instead.
- **Jump to VR lands at a door INTO the room**, ~2.6m back and facing it,
  rather than inside — that's the position a review is done from. The door's
  placement is read off `exitMeta`, **not** the exit's stored `wall`/`offset`:
  `buildRoom` distributes a branching room's doors itself, and a memorized
  corridor's side-doors sit against a member, so the stored values point at
  the wrong wall. That cost a debugging round — don't "simplify" it back.
- **Manage Mnemonics' piece views honour the coverage scope**, greying the
  squares that piece never reaches inside it.

**Earlier in the session (PRs #199–203):**

- **Graph Completeness view** — recolours rooms by how much mnemonic work is
  left. Note the design correction that produced its fourth state: mnemonic
  atoms are a *global* `(square × piece)` vocabulary and the app ships a
  complete default set, so scoring on atoms alone painted every castle green.
  Room decoration is the axis that actually varies per castle.
- **Graph size guard** — refuses to draw past 500 moves and says how to
  narrow the scope.
- **Click-feedback flash** on the opening-system icon row.
- **Auto-import toasts** — one per platform, only when something new came in.
  The bottom-right corner became a single `#toastStack` column shared with the
  persistent new-transposition toast, since an auto-import is exactly what
  raises one of those.
- **`window.__appBootSettled`** (test flag only) — the boot promise chain is
  now returned rather than fired bare. The boot auto-import check is
  fire-and-forget and `launchApp` returns before it settles, so a test that
  changes the settings it reads mid-flight makes it run against half-applied
  state. Two test failures looked exactly like product bugs before this
  existed; anything else touching those settings wants the same wait.
- **A `no-cache` meta on `index.html`** — see the "Deploy/caching note"
  section below for why.
- `Documents/MultiDomainArchitecture.md` — a long design discussion about
  generalising beyond chess. **Nothing in it is built**, and the user
  explicitly deferred the refactor. Read it before proposing anything in that
  direction; don't start building from it without being asked.

## Open decisions the user has not settled

- **The ladder values** (`1/3/7/21/60/180`) and whether 180 days is the top
  step. Raised twice, never answered. They are now shipped and will start
  accruing real history, so changing them later means existing records sit at
  steps that mean something slightly different.
- **A due list / session planner** ("which rooms are due across everything")
  — proposed and explicitly deferred by the user. The data is all there now.

## Test-suite notes

- The full suite takes roughly an hour. **Do not run it unprompted** — see
  `CLAUDE.md`'s testing policy, which is explicit about the cost. Targeted
  runs (`npm test -- vr-castle`, `core`, etc.) are cheap and are what to use
  while iterating.
- **The last FULL run was at `-365`** (626 passed, 1 failed — see below).
  Everything from `-366` to `-374` was verified by targeted runs only. Not a
  concern in itself (each change ran the phases it touched), but if a full
  run is ever wanted before a release, that's the gap it would close.
- The `VR cache: invalidated by …` group was flaky in this environment — a
  different sub-test failing per run, and failing on unmodified `main` too.
  It did **not** fire in the last full run (626 passed, 1 failed at `-365`),
  so it may have been load-related. Don't chase it as a regression from your
  own change without first confirming against a stash.
- The one failure in that run was a **race in the floor-label facing test**,
  not a regression: it snapshotted the label's position on a fixed timeout
  while a resize was still rebuilding the room. Fixed here (it now waits for
  the label to reach its new depth). Mentioned because the same
  fixed-`waitForTimeout`-after-a-rebuild pattern appears elsewhere in the
  suite and is a latent source of the same flake.

## Known environment gotcha (already documented in `CLAUDE.md`)

The local git working directory has repeatedly reverted to a stale commit
mid-session in this environment — see `CLAUDE.md`'s "Known issue: the local
workspace can silently revert to a stale commit" section for the symptom and
the exact recovery commands. Nothing has ever been lost from git history
from this — only uncommitted edits are at risk, so commit+push promptly
rather than sitting on a large uncommitted diff.

## Deploy/caching note

`index.html` now carries `<meta http-equiv="Cache-Control" content="no-cache">`.
Every other file has a `?v=` cache-buster, but the document that *names* those
versions had nothing that could bust it, which is why a stale build tag kept
showing when testing branch builds through raw.githack.com. That meta governs
the **browser** only — a CDN in front of the page reads real HTTP headers, so
a stale copy there still needs a query string on the URL (`index.html?x=368`).

## Where to look for more

- `CLAUDE.md` — standing conventions (testing policy, build/version
  discipline, git workflow, the environment gotcha above). Read this first;
  it's loaded automatically at the start of every session.
- `Documents/VR-Slow-Bug-info.md` — the open bug above, in full.
- `Documents/` — design notes for the castle/room model, each explicitly
  labeled with what's shipped vs. still proposed.
- `help/` — the in-app Help topics, and the closest thing to a plain-language
  spec of what shipped. `marking-memorized.html` (the whole review system),
  `digraph-view.html` (the graph's view modes and size guard),
  `transpositions.html` (Find Transpositions and redirects),
  `mnemonics-customizing.html` (the coverage scope). **Several features still
  have no topic at all** — Analysis Queue, Perfect Opening, VR Assets, VR
  Object Lists, and full backup/restore. Worth writing if you're asked for a
  documentation pass.
- `git log --oneline` / the PR list on GitHub — the authoritative history of
  what's been done and why (commit messages are written to explain the
  "why," not just the "what").
