# Handoff — status as of this note

Written at the end of a long session so a fresh agent (new chat, no memory of
the conversation that produced this) can pick up context quickly instead of
re-deriving it. **This file is a snapshot, not a standing doc** — update or
delete it as things change; don't let it silently rot into a source of stale
claims. (One earlier version described `BUILD_TAG -250` and PR #152 long after
both were history; another told the next session that the VR-cache test flake
was "load-related" and not worth chasing, which was wrong and cost that
session the diagnosis twice over. Both are exactly the failure mode to avoid.)

## State at time of writing

- `main` is at commit `43f0e38` (PR #216 merged). `js/app.js`'s `BUILD_TAG`
  is `-387`.
- Module versions: `js/app.js?v=…-387`, `js/db.js?v=…-63`,
  `threeVR.js?v=…-284`, `assets.js?v=…-80`. **`assets.js` is imported from
  three files** (`app.js`, `threeVR.js`, `objectLists.js`) — bump all three
  together or the browser loads two copies of the module with separate state.
- No open PRs and nothing in flight. Everything requested this session
  shipped and merged.
- Working branch: `claude/project-onboarding-iozvt5`, currently even with
  `main` (safe to reset from `origin/main` if it looks behind or stale — see
  the recovery note below).
- **The last full suite run was at `-383`**: 667 passed, 2 failed, both one
  harness bug that is now fixed. `-384` to `-387` were verified by targeted
  runs only. See *Test-suite notes* before running anything.

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

## The big thread: the board quiz feeds the review schedule

Phases **Q0 → Q4** (PRs #208–212; #207 was a help-topics pass), from a design
discussion the user opened about how self-testing should interact with spaced
repetition. The governing rules, all confirmed with the user rather than
assumed — **these are what a fresh agent would otherwise get wrong:**

- **A missed move blames the room containing the DOOR, not the room beyond
  it.** If Qb2 sits on a door of the SOLARIUM leading into the STUDY, missing
  it means SOLARIUM needs review. At answer time that's
  `OQ.seq.slice(0, -1)` (`oqMissedRoomSeq`). A move deep inside a long
  sequence belongs to whichever room holds that sequence, which falls out of
  the room-anchor mapping under *Standing traps*.
- **The quiz demotes but never promotes.** A quiz walks one path, so it asks
  one door per room. A miss is conclusive; a hit says nothing about the doors
  it didn't ask. Climbing the ladder stays something you grade yourself,
  standing in the room, having recalled all of it.
- **One step, not a reset** — evidence about one door. And **once per room
  per session**: a wrong answer can be retried, a path can re-enter a room by
  transposition, and "Again, same questions" replays a set you were just
  shown the answers to. `OQ.demoted` is that ledger.
- **"Uncertain about next move"** is armed BEFORE the move — the user's
  correction to an earlier sketch, and the right call, since the board
  auto-advances ~200 ms after a correct answer. Right-but-guessing keeps the
  ladder step and only pulls the next review forward to half the interval
  (`softenRoomReview`). It can never push a review out.
- **"Give up on this move"** reveals the answer, scores one miss, carries on.
  Without it the quiz was a trap — a wrong answer snapped back and asked
  again with no way past a move you don't know.

Per phase: **Q0** the room-anchor mapping (a real bug, confirmed by a test
written to fail first — see *Standing traps*). **Q1** misses demote, with the
attribution above; the status line names the room whether or not it moved,
because "attributed to the Solarium, nothing changed" and "attributed to
nothing" are different situations. **Q2** "only rooms due for review" as a
third quiz scope (three-way `#oqRoomFilter`, `LS_OQ_ROOMFILTER` migrating the
old boolean); each question *starts* in a due room at one of its own doors,
worst-overdue first. Note `oqPrepareDueQuestion` appends one opponent reply —
a room's `seq` ends with OUR move, but a question must be posed where it's
our turn. **Q4** the end-of-session change list and its undo.

Q4's two deliberate limits are worth preserving: a room something else has
changed since (a VR grade in another tab) is **left alone** and marked out of
reach rather than undone, since that newer judgement beats reverting an older
one; and undoing does **not** re-arm the room — ledger entries stay, flagged
`undone`, because a room you already missed isn't fresh evidence again.
Ledger entries carry the **whole** previous and written records, not just the
step numbers: undo restores the due date, lapse count and `dirtySeen` exactly,
and rebuilding from a step would invent them.

(There was no Q3 — the sketch's Q3 folded into Q2.)

## Since then (PRs #215–216): decorating and the graph's lenses

**Surface brightness/contrast (`-384`).** A tint is `material.color`, which
three.js MULTIPLIES the texture by, so every tint except white darkens and
none can brighten. "Tint…" became **"Adjust…"**: a dialog with a tiled live
preview, brightness/contrast sliders, and the tint swatches it had. Tint and
brightness/contrast are independent.

- The tint **stayed** on `material.color` deliberately. It multiplies in
  LINEAR space in the shader while a canvas filter works on sRGB bytes, so
  folding it into the canvas would have silently restyled every already-
  tinted surface. A surface at the defaults skips the canvas pass entirely.
- The filter string is ONE function in `db.js` (`surfaceAdjustFilter`),
  handed to `ctx.filter` by both the preview and the renderer. A preview that
  computes its own version of "the same" adjustment is one that eventually
  lies.
- Order is brightness/contrast **then** tint, both places. Contrast does not
  commute with a multiply.
- Storage rides free: `threeLayout` is stringified wholesale with no schema.
  Defaults are never written, so an unadjusted surface keeps the bare id
  string it stored before.
- The preview is **unlit**, so the room reads darker than the swatch. There's
  a line under it saying so. If that misleads in practice, the fallback is an
  in-world live preview — the obstacle is that the dialog is a full-screen
  overlay covering the VR canvas and would need to become a docked panel.
  Slider range is 0.25–2.5, one constant in `db.js`.

**`DOOR_VIEW_DIST` 2.6 → 3.1 (`-384`)** — jumping to a room framed the door
but cropped the top of its sign, and the sign is what you're out there to
recall.

**The graph notices a grade made in VR (`-385`).** You can jump into a room
from the Review lens, grade it, and come back — the graph stays open
underneath VR the whole time, and was still showing what it computed before
you left. Fixed by `refreshGraphRoomState()`, an **in-place restyle, not a
rebuild**: a rebuild costs a spinner and seconds and throws away pan/zoom and
any manual arrangement. It's called from `refreshMemorizedRoomsAndTree()`,
which VR close already ran for the move table.

**Locked rooms stop asking for impossible work (`-386`, `-387`).** A locked
room — no moves out, so its only doorway is a locked door — is one you can
never stand in. Completeness now leaves it on its atom score instead of
"not decorated yet"; the Review lens shows it **its owner's** schedule (the
room whose door leads in — the same attribution the quiz uses) instead of
grey "not memorized"; and both room coverage bars measure against rooms you
can walk into, so they can reach 100%. The review summary now counts ROOMS,
which is what its words say — it counted nodes, so a merged corridor was
reported once per position.

## Earlier this session, and still the background

**Spaced-repetition room reviews (PR #202, phases R1–R5)** — the substrate:

- **The schedule** lives in `js/db.js` — a fixed ladder `1/3/7/21/60/180`
  days rather than SM-2's ease factor. `db.js` is a classic `<script>`, so
  both `threeVR.js` and `app.js` reach its functions as globals; they don't
  import each other and both need the same rules. **Put anything else shared
  between them there** — `demoteRoomReview`, `softenRoomReview` and
  `surfaceAdjustFilter` were written there for that reason, and
  `dueInDays`/`duePhrase` were later moved out of `threeVR.js` when `app.js`
  needed the same phrasing.
- **A** advances and clamps, **C** resets to the bottom, **B** holds but a
  second consecutive B demotes. ±15% fuzz, due dates snapped to local
  midnight. The fuzz does nothing below ~a week (±15% of 3 days is absorbed
  by the midnight snap) — deliberate and commented.
- A memorized room with **no stored record** derives one from the memorized
  timestamp (`effectiveRoomReview`), so an existing repertoire joined with no
  migration.
- **In VR:** the brain tints by due state and opens a grading menu; `1`/`2`/`3`
  grade directly. Re-grading within one visit *replaces* (`preGradeRecord`).
- **In the graph:** a **View dropdown** (Normal / Completeness / Review). Both
  lenses ride along as classes on every render, so switching is a pure
  restyle.
- **On door signs:** DUE / OVERDUE pills, also on elevator floor panels.
- **R5** docks a step off a room that's picked up a new door. `dirtySeen`
  ledgers the doors already accounted for; the dirty flag itself stays true
  until re-memorized, so it can't be the trigger. **Its sweep runs on VR open
  only** — `MEMORIZED_SHAPES` is threeVR's to maintain, so a structural change
  reaches the graph's Review lens one walk late.

**Follow-ups from real use (PRs #204–206)** — the shape of feedback to expect:

- Marking a room memorized toasts its first review date; unmarking warns the
  history went with it.
- **A door sign carries one `mark`**: dim grey 🧠 for never learned, the
  DUE/OVERDUE pill for a review waiting, nothing when up to date. The brain is
  the **emoji**, not Font Awesome — FA is a CDN webfont and a canvas draw of it
  is tofu whenever it hasn't loaded, which is every offline-harness run.
- **A castle's entry room** is reached through a street building, so it has no
  door sign; its marker rides the stat strip on the street entry billboard.
- **Jump to VR lands at a door INTO the room**, facing it. The door's
  placement is read off `exitMeta`, **not** the exit's stored `wall`/`offset`:
  `buildRoom` distributes a branching room's doors itself, and a memorized
  corridor's side-doors sit against a member, so the stored values point at
  the wrong wall. That cost a debugging round — don't "simplify" it back.
- **Manage Mnemonics' piece views honour the coverage scope.**

**Older (PRs #199–203):** Graph Completeness view (note the design correction
that produced its fourth state — mnemonic atoms are a *global* `(square ×
piece)` vocabulary and the app ships a complete default set, so scoring on
atoms alone painted every castle green; room decoration is the axis that
varies per castle); the 500-move graph size guard; click-feedback flash;
auto-import toasts in a shared `#toastStack`; `window.__appBootSettled`; the
`no-cache` meta (see *Deploy/caching note*).

`Documents/MultiDomainArchitecture.md` is a design discussion about
generalising beyond chess. **Nothing in it is built** and the user explicitly
deferred the refactor. Read it before proposing anything in that direction;
don't start building from it unasked.

## Standing traps

### A position is not a room

A linear run of positions merges into ONE VR room, anchored at the first; the
rest are **members**, with no room of their own to stand in, decorate or
memorize. Two sibling runs off a head become a single two-track room the same
way (`analyzeCastleStructure` pairs them when the head has exactly two
out-edges).

So `castleRoomKey(instanceId, positionKey(fen))` is correct only for an
ANCHOR. On a member it yields a key for a room that does not exist, and
everything stored per-room — memorized, decorated, review schedule, layout —
silently reads as absent. No error, just wrong answers.

**Fixed in `-377`** by `buildRoomAnchorIndex` / `roomKeyForPosKey` (next to
`castleRoomKey` in `js/app.js`). Resolve through those for any position that
might not be an anchor. Two existing call sites were wrong: `oqRoomMemorized`
(memorized-only quizzing dead-ended one move into every corridor, presenting
as sessions being oddly shallow) and `roomKeyForRoom` in the graph render
(glyphs and lenses lit only each corridor's anchor, and "Jump to VR" from any
other node landed on Main Street). Everything written since resolves through
the index from the start.

Covered by **Phase EN**.

### Room-level questions are not node-level questions

The same trap in a second dress, and it bit twice in `-386`/`-387`. A graph
node is a POSITION; "can you walk into this room" is a question about the
generated ROOM. The last position of any merged corridor has no forward move,
so a node-level "is this a dead end" test quietly exempts the tail of every
corridor — and then a corridor's own positions disagree with each other about
a room they share.

Also: **"no forward continuation" is not the same as locked.** A room whose
replies exist but aren't built out yet still HAS doors (locked ones), and VR
lets you in to see them. The authority is `threeVR.js`'s `isRoomEmpty` — no
exits AND no non-center move-pairs — and `GRAPH_UNDECORABLE_ROOMS` /
`roomIsDecorable` in `app.js` mirror it. The pairs half matters for merged
rooms: a corridor whose forward moves are all internal has no exits of its
own but is walked into normally.

Note `data.lockedDeadEnd` (used only to hide "Jump to VR") still uses the
older node-level rule. It's a mild over-approximation there and was left
alone deliberately — changing Jump's behaviour wasn't asked for.

### Fixture premises go stale

Three times now a test has been "passing" while testing nothing, because the
castle shape it assumed had changed: `Phase AS` (its "dead-end room" was
really a member of the entry corridor — grown from one branch to three, since
two sibling runs pair into a two-track room and three is the minimum that
leaves a reply standing as its own room), `Phase EC` (no locked room with
COMPLETE atoms, so the case couldn't be caught), and `Phase EH` test 381
(memorizing a room that can't be memorized). When a test in this area passes
suspiciously easily, check its fixture actually has the shape it claims.

## Open decisions the user has not settled

- **The ladder values** (`1/3/7/21/60/180`) and whether 180 days is the top
  step. Raised three times, never answered. Now shipped and accruing real
  history, so changing them later means existing records sit at steps that
  mean something slightly different.
- **Whether a clean quiz hit should ever promote a room.** Currently never,
  for the asymmetry reason above. Flagged twice, not objected to, not
  explicitly settled.

## Test-suite notes

- The full suite takes roughly an hour. **Do not run it unprompted** — see
  `CLAUDE.md`'s testing policy, which is explicit about the cost. Targeted
  runs (`npm test -- move-table`, `digraph`, `assets`, `castle-generation`,
  `core`, `quiz`, `vr-decorating`) are cheap and are what to use while
  iterating.
- **Last FULL run: `-383`** — 667 passed, 2 failed, both the same harness bug
  (below), nothing in the app implicated. `-384`…`-387` ran only the phases
  they touched.
- **The `VR cache: invalidated by …` flake is FIXED, and this file's previous
  diagnosis of it was wrong.** It was never load-related. Each VR-cache phase
  had its own `closeVR` doing `btn && btn.click()` — the toolbar renders a
  beat after the overlay, so when the button wasn't there yet it clicked
  *nothing, silently*, and the `display:none` wait that followed had **no
  explicit timeout** and burned the full 30 s default. That's why a
  *different* sub-test failed each run: every one of them closes VR, so
  whichever lost the race failed. Fixed by a shared `closeVR(page)` in
  `test/harness.mjs` that waits for the button and bounds both waits at 20 s;
  phases AU/AV/AW/BA use it.
- **Recognise this cascade shape.** The dead `closeVR` left the VR overlay
  *open*, so the next test's clicks landed on the three.js canvas — one flake
  showing up as two failures, the second in a test that had nothing wrong with
  it. If two adjacent tests fail and the second's error mentions
  `<canvas … three.js>` intercepting pointer events, that is ONE bug.
- **Five other copies of the old `closeVR` pattern remain** (phases Y2, AX ×2,
  CC, DY — grep `b.title === 'Close'`). Same latent hazard, left alone
  deliberately: those phases weren't failing and changing them would have been
  unverifiable churn. Worth folding into the shared helper next time one of
  them flakes, or during a full run.
- The **fixed-`waitForTimeout`-after-a-rebuild** pattern is a separate latent
  race (it caused the floor-label failure at `-365`). Prefer `waitForFunction`
  on the thing you actually care about.

## Known environment gotcha (already documented in `CLAUDE.md`)

The local git working directory has repeatedly reverted to a stale commit
mid-session in this environment — see `CLAUDE.md`'s "Known issue: the local
workspace can silently revert to a stale commit" for the symptom and the exact
recovery commands. Nothing has ever been lost from git history; only
uncommitted edits are at risk, so commit+push promptly rather than sitting on
a large uncommitted diff.

## Deploy/caching note

`index.html` carries `<meta http-equiv="Cache-Control" content="no-cache">`.
Every other file has a `?v=` cache-buster, but the document that *names* those
versions had nothing that could bust it, which is why a stale build tag kept
showing when testing branch builds through raw.githack.com. That meta governs
the **browser** only — a CDN in front of the page reads real HTTP headers, so
a stale copy there still needs a query string on the URL (`index.html?x=387`).

A deploy can move more than `app.js`: `-384` moved `db.js`, `threeVR.js` and
`assets.js` as well. Each module's own `?v=` is bumped only when that module
changed — except `assets.js`, whose three importers must always agree.

## Where to look for more

- `CLAUDE.md` — standing conventions (testing policy, build/version
  discipline, git workflow, the environment gotcha above). Read this first;
  it's loaded automatically at the start of every session.
- `Documents/VR-Slow-Bug-info.md` — the open bug above, in full.
- `Documents/` — design notes for the castle/room model, each labeled with
  what's shipped vs. still proposed.
- `help/` — the in-app Help topics, and the closest thing to a plain-language
  spec of what shipped. `marking-memorized.html` (the review system, including
  how the quiz feeds it), `board-testing.html` (the quiz: scopes, give-up,
  uncertain, the end-of-session change list), `digraph-view.html` (the view
  modes, locked rooms, the size guard), `decorating-castle.html` (surfaces and
  the Adjust dialog), `transpositions.html`, `mnemonics-customizing.html`,
  `analysis-queue.html`, `vr-assets.html`, `object-lists.html`,
  `backup-and-reset.html`.
  **Perfect Opening deliberately has no topic** — the user considers it an
  experiment and isn't sure it stays in the app, so don't document it without
  asking. Everything else in the hamburger menu is covered.
- `git log --oneline` / the PR list on GitHub — the authoritative history of
  what's been done and why (commit messages explain the "why", not just the
  "what").
