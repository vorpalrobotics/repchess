# Handoff — status as of this note

Written at the end of a long session so a fresh agent (new chat, no memory of
the conversation that produced this) can pick up context quickly instead of
re-deriving it. **This file is a snapshot, not a standing doc** — update or
delete it as things change; don't let it silently rot into a source of stale
claims. (One earlier version described `BUILD_TAG -250` and PR #152 long after
both were history; another told the next session that the VR-cache test flake
was "load-related" and not worth chasing, which turned out to be wrong — see
*Test-suite notes*. Both are exactly the failure mode to avoid.)

## State at time of writing

- `main` is at commit `593b033` (PR #213 merged). `js/app.js`'s `BUILD_TAG`
  is `-383`.
- No open PRs and nothing in flight. Everything requested this session
  shipped and merged.
- Working branch used throughout: `claude/project-onboarding-iozvt5`,
  currently even with `main` (safe to reset from `origin/main` if it looks
  behind or stale — see the recovery note below).
- **A full suite run was done at `-383`**: 667 passed, 2 failed, both traced
  to one harness bug that is now fixed. Details under *Test-suite notes* —
  read that section before running anything.

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

## The main thread of this session: the board quiz feeds the review schedule

Phases **Q0 → Q4** (PRs #208–212; #207 was the help-topics pass), starting
from a design discussion the user opened about how self-testing should
interact with spaced repetition. The
governing rules, all confirmed with the user rather than assumed:

- **Attribution: a missed move blames the room containing the DOOR, not the
  room beyond it.** The user's own framing: if Qb2 sits on a door of the
  SOLARIUM leading into the STUDY, missing it means SOLARIUM needs review.
  At answer time that's `OQ.seq.slice(0, -1)` (`oqMissedRoomSeq`). A move
  deep inside a long sequence belongs to whichever room holds that sequence,
  which falls out of the room-anchor mapping below.
- **Asymmetry: the quiz can demote but never promote.** A quiz walks one
  path, so it asks one door per room. A miss is conclusive; a hit says
  nothing about the doors it didn't ask about. Advancing up the ladder stays
  something you grade yourself, standing in the room, having recalled all
  of it.
- **One step, not a reset** — it's evidence about one door. And **once per
  room per session**, however many times you miss in it: a wrong answer can
  be retried, a path can re-enter a room by transposition, and "Again, same
  questions" replays a set you were just shown the answers to. None of that
  is fresh evidence. `OQ.demoted` is that ledger.
- **"Uncertain about next move"** (armed BEFORE the move — the user's
  correction to an earlier sketch of mine, and the right call, since the
  board auto-advances ~200 ms after a correct answer). Right-but-guessing
  keeps the ladder step and only pulls the next review forward to half the
  interval (`softenRoomReview`). It can never push a review out.
- **"Give up on this move"** reveals the answer, scores one miss, and carries
  on down the line. Without it the quiz was a trap — a wrong answer snapped
  back and asked again with no way past a move you simply don't know.

What each phase added:

- **Q0** — the room-anchor mapping. See *Standing trap* below; this was a
  real bug, confirmed by a test written to fail first.
- **Q1** — misses demote, with the attribution rules above. The status line
  names the room ("that move lives in Solarium") whether or not it moved,
  because "attributed to the Solarium, nothing changed" and "attributed to
  nothing at all" are different situations.
- **Q2** — **"only rooms due for review"** as a third quiz scope, replacing
  the old "only memorized" checkbox with a three-way `#oqRoomFilter` select
  (`LS_OQ_ROOMFILTER` migrates the old boolean). Each question *starts* in a
  due room at one of its own doors rather than walking from the opening and
  hoping to reach it; the due queue is worst-overdue first, so a session cut
  short still covered what you're most behind on. Note `oqPrepareDueQuestion`
  appends one opponent reply: a room's `seq` ends with OUR move, but a
  question must be posed where it's our turn.
- **Q4** — the end-of-session change list and its undo. The summary names
  every room the session moved, what happened to it, and when it's now due.
  One undo covers the session as a unit. Two deliberate limits, both worth
  preserving: a room something else has changed since (a VR grade in another
  tab) is **left alone** and marked out of reach rather than undone, since
  that newer judgement beats reverting an older one; and undoing does **not**
  re-arm the room — ledger entries stay, flagged `undone`, because a room you
  already missed isn't fresh evidence again.

(There was no Q3 — the numbering came from the original sketch and Q3 was
folded into Q2.)

Ledger entries carry the **whole** previous and written records (`prev` /
`next`), not just the two step numbers: undo has to restore the due date,
lapse count and `dirtySeen` list exactly, and rebuilding from a step would
invent them.

`dueInDays` / `duePhrase` now live in **`js/db.js`**, moved out of
`threeVR.js` so `app.js` can reach them. Same reason `demoteRoomReview` is
there — see the note on `db.js` below. `roomReviewMatches` is also new there:
the "has anything touched this since?" check the undo needs.

## Earlier this session, and still the relevant background

**Spaced-repetition room reviews (PR #202, phases R1–R5)** — the substrate
everything above builds on:

- **The schedule** lives in `js/db.js` — a fixed ladder `1/3/7/21/60/180`
  days rather than SM-2's ease factor. `db.js` is a classic `<script>`, so
  both `threeVR.js` and `app.js` reach its functions as globals; they don't
  import each other, and both need the same rules. **Put anything else shared
  between them there for the same reason** — that's now happened three times
  (`demoteRoomReview`, `softenRoomReview`, `dueInDays`/`duePhrase`).
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

**Follow-ups from actually using it (PRs #204–206)** — the shape of feedback
to expect more of:

- **Marking a room memorized toasts its first review date**, and unmarking
  warns that the review history went with it.
- **A door sign carries one `mark`**: a dim grey 🧠 for a room never learned,
  the DUE/OVERDUE pill for one with a review waiting, nothing at all when
  it's learned and up to date. The brain is the **emoji**, not Font Awesome —
  FA is a CDN webfont and a canvas draw of it is tofu whenever it hasn't
  loaded, which is every run under the offline harness.
- **A castle's entry room** is reached through a street building, not a door,
  so it had no sign to mark. Its marker rides the stat strip on the street
  entry billboard instead.
- **Jump to VR lands at a door INTO the room**, ~2.6 m back and facing it,
  rather than inside — that's the position a review is done from. The door's
  placement is read off `exitMeta`, **not** the exit's stored `wall`/`offset`:
  `buildRoom` distributes a branching room's doors itself, and a memorized
  corridor's side-doors sit against a member, so the stored values point at
  the wrong wall. That cost a debugging round — don't "simplify" it back.
- **Manage Mnemonics' piece views honour the coverage scope**, greying the
  squares that piece never reaches inside it.

**Older still (PRs #199–203):** Graph Completeness view (note the design
correction that produced its fourth state — mnemonic atoms are a *global*
`(square × piece)` vocabulary and the app ships a complete default set, so
scoring on atoms alone painted every castle green; room decoration is the
axis that actually varies per castle); the graph size guard at 500 moves;
click-feedback flash; auto-import toasts in a shared `#toastStack`;
`window.__appBootSettled`; the `no-cache` meta (see *Deploy/caching note*).

`Documents/MultiDomainArchitecture.md` is a long design discussion about
generalising beyond chess. **Nothing in it is built**, and the user
explicitly deferred the refactor. Read it before proposing anything in that
direction; don't start building from it without being asked.

## Standing trap: a position is not a room

A linear run of positions merges into ONE VR room, anchored at the first;
the rest are **members** of it, with no room of their own to stand in,
decorate, or memorize. Two sibling runs off a head become a single
two-track room the same way (`analyzeCastleStructure` pairs them when the
head has exactly two out-edges).

So `castleRoomKey(instanceId, positionKey(fen))` is correct only for an
ANCHOR. Called on a member it yields a key for a room that does not exist,
and everything stored per-room — memorized, decorated, review schedule,
layout — silently reads as absent. No error, just wrong answers.

**Fixed in `-377`** by `buildRoomAnchorIndex` / `roomKeyForPosKey` (next to
`castleRoomKey` in `js/app.js`). Resolve through those, not through
`castleRoomKey` directly, for any position that might not be an anchor. Two
existing call sites were wrong and are now fixed:

- `oqRoomMemorized` — "only test memorized rooms" dead-ended one move into
  every memorized corridor, so long forcing lines were largely unreachable
  by memorized-only quizzing. It presented as sessions being oddly shallow.
- `roomKeyForRoom` in the graph render — the 🧠/🎨 glyphs and the Review and
  Completeness lenses lit only each corridor's anchor, and "Jump to VR" from
  any other node landed you on Main Street, since its key matched no room.

Everything written since (the quiz's miss attribution in `oqDemoteMissedRoom`
/ `oqSoftenUnsureRoom`, and `oqDueRooms`) resolves through the index from the
start — which is the only reason a miss deep inside a corridor blames the
corridor instead of silently doing nothing.

Covered by **Phase EN**. Note `Phase AS`'s fixture had to grow from one
branch to three: with one, the "dead-end room" it claimed to test was
actually a member of the entry corridor, and with two the head and both
branches pair into one two-track room. Three is the smallest branch count
that leaves a reply standing as its own room — worth knowing when writing
any fixture that needs a specific room shape.

## Open decisions the user has not settled

- **The ladder values** (`1/3/7/21/60/180`) and whether 180 days is the top
  step. Raised three times, never answered. They are now shipped and
  accruing real history, so changing them later means existing records sit at
  steps that mean something slightly different.
- **Whether a clean quiz hit should ever promote a room.** Currently never,
  for the asymmetry reason above. Flagged to the user twice; not objected to,
  but not explicitly settled either.

(The old "due list / session planner" item on this list is **done** — that's
Q2.)

## Test-suite notes

- The full suite takes roughly an hour. **Do not run it unprompted** — see
  `CLAUDE.md`'s testing policy, which is explicit about the cost. Targeted
  runs (`npm test -- castle-generation`, `quiz`, `core`, …) are cheap and are
  what to use while iterating.
- **The last FULL run was at `-383`**: 667 passed, 2 failed. Both failures
  were the same harness bug, now fixed (below), and nothing in the app was
  implicated.
- **The `VR cache: invalidated by …` flake is FIXED, and the old diagnosis
  in this file was wrong.** It was never load-related. Each VR-cache phase
  had its own `closeVR` doing `btn && btn.click()` — the toolbar renders a
  beat after the overlay, so when the button wasn't there yet it clicked
  *nothing, silently*, and the `display:none` wait that followed had **no
  explicit timeout** and burned the full 30 s default. That's why a
  *different* sub-test failed each run: every one of them closes VR, so
  whichever lost the race was the one that failed. Fixed by a shared
  `closeVR(page)` in `test/harness.mjs` that waits for the button and bounds
  both waits at 20 s; phases AU/AV/AW/BA use it.
- **Watch for this cascade shape generally.** The dead `closeVR` left the VR
  overlay *open*, so the next test's clicks landed on the three.js canvas —
  which is how one flake showed up as two failures, the second in a test
  ("Attributes modal: live Auto label update") that had nothing wrong with
  it. If two adjacent tests fail and the second one's error mentions
  `<canvas … three.js>` intercepting pointer events, you have one bug, not
  two. Test 159 now shuts the overlay defensively.
- **Five other copies of the old `closeVR` pattern remain** (phases Y2, AX
  ×2, CC, DY — grep `b.title === 'Close'`). They're the same latent hazard.
  They were left alone deliberately: those phases weren't failing, and
  changing them would have been churn that couldn't be verified without
  another full run. Worth folding into the shared helper next time one of
  them flakes, or next time a full run is happening anyway.
- The **fixed-`waitForTimeout`-after-a-rebuild** pattern is a separate latent
  source of races (it caused the floor-label facing failure at `-365`, fixed
  by waiting for the label to reach its new depth). Prefer `waitForFunction`
  on the thing you actually care about.

## Known environment gotcha (already documented in `CLAUDE.md`)

The local git working directory has repeatedly reverted to a stale commit
mid-session in this environment — see `CLAUDE.md`'s "Known issue: the local
workspace can silently revert to a stale commit" section for the symptom and
the exact recovery commands. Nothing has ever been lost from git history
from this — only uncommitted edits are at risk, so commit+push promptly
rather than sitting on a large uncommitted diff.

## Deploy/caching note

`index.html` carries `<meta http-equiv="Cache-Control" content="no-cache">`.
Every other file has a `?v=` cache-buster, but the document that *names* those
versions had nothing that could bust it, which is why a stale build tag kept
showing when testing branch builds through raw.githack.com. That meta governs
the **browser** only — a CDN in front of the page reads real HTTP headers, so
a stale copy there still needs a query string on the URL (`index.html?x=383`).

Remember that a deploy can move more than `app.js`: `-383` moved `db.js`
(`-62`) and `threeVR.js` (`-283`) as well, and each module's own `?v=` is
bumped only when that module changed.

## Where to look for more

- `CLAUDE.md` — standing conventions (testing policy, build/version
  discipline, git workflow, the environment gotcha above). Read this first;
  it's loaded automatically at the start of every session.
- `Documents/VR-Slow-Bug-info.md` — the open bug above, in full.
- `Documents/` — design notes for the castle/room model, each explicitly
  labeled with what's shipped vs. still proposed.
- `help/` — the in-app Help topics, and the closest thing to a plain-language
  spec of what shipped. `marking-memorized.html` (the whole review system,
  including how the quiz feeds it), `board-testing.html` (the quiz itself:
  scopes, give-up, uncertain, and the end-of-session change list),
  `digraph-view.html` (the graph's view modes and size guard),
  `transpositions.html`, `mnemonics-customizing.html`, `analysis-queue.html`,
  `vr-assets.html`, `object-lists.html`, `backup-and-reset.html`.
  **Perfect Opening deliberately has no topic** — the user considers it an
  experiment and isn't sure it stays in the app, so don't document it without
  asking. Everything else in the hamburger menu is covered.
- `git log --oneline` / the PR list on GitHub — the authoritative history of
  what's been done and why (commit messages are written to explain the
  "why," not just the "what").
