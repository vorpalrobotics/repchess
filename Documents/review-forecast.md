# Review Forecast — design and phasing plan

**Status: Phases 1-5 built. The ripple projection (below) is the live
follow-on; its step 1, collecting per-rung grade statistics, is built.**

**In the UI it is called "VR Schedule"** — that is the hamburger item and the
modal's title. The code, the ids (`reviewForecast*`) and this document keep
the original name; renaming them would be churn across a lot of test
references for no user-visible gain.

## What it is for

Not "which rooms are due" — the digraph's Review lens already answers that,
and answers it better, because it shows you *where* they are so you can go and
walk them.

This answers a different question: **how much review is coming, and when.**
The stated use is **pacing new memorization**: if the next few days are heavy,
skip memorizing a new room today. That is the feature. Everything below is in
service of it, and anything that does not help you make that call is a lower
priority than something that does.

A second, cheaper question comes almost free from the same data and is worth
having: **how well-learned is this castle?** — the distribution of rooms across
the interval ladder, rather than across the calendar.

## The unit: moves AND rooms, everywhere

`threeRoomReviews` is keyed by **room**. You walk into a room, grade it once,
and the whole room moves along the ladder together. "Moves coming due" is not
stored — but it is derivable: each generated room carries `moveCount`
(`js/app.js`, in the `genRooms` builder — the sum of out-degree over the room's
members, i.e. how many of your replies are taught there).

**Every figure in this feature reads `N moves · M rooms`.** Not a hedge; they
answer different questions and either alone misleads:

- **Moves** is the measure of *repertoire* — how much of what you know is up
  for review.
- **Rooms** is the measure of *work* — you walk into a room once whether it
  holds 2 moves or 14. Three rooms holding 30 moves is one short session;
  twelve rooms holding 14 moves is twelve walks across a castle.

For pacing, rooms is arguably the more actionable of the two, which is exactly
why it can't be dropped.

## Bucket by DUE DATE, not by ladder step

The ladder is `[1, 3, 7, 21, 60, 180]` days, which looks like a ready-made set
of buckets and is not one. Those are *intervals*. A room at step 5 — a 180-day
interval — that falls due in four days belongs under "this week". Bucketing by
step would file it under "180" and make the forecast wrong in precisely the
case the forecast exists for.

| Bucket | Definition |
|---|---|
| **Overdue** | `roomReviewState() === 'overdue'` |
| **Due now** | `roomReviewState() === 'due'` |
| **Tomorrow** | `dueInDays() === 1` |
| **2–7 days** | rest of the week |
| **8–30 days** | |
| **31–90 days** | |
| **90+ days** | |
| **Not memorized yet** | no record and no memorized flag |

The first two delegate to `roomReviewState()` rather than re-deriving
"overdue", so this report and the digraph's Review lens can never disagree
about the same room. Its windows are proportional to the interval, which is a
rule worth not reinventing.

The **Not memorized yet** bucket is not optional. Without it a barely-started
castle and a fully-reviewed one look identical — the same reasoning
`roomReviewState` already gives for having four states rather than three. It
appears in the pie, greyed, and is **excluded from the calendar**: it has no
due date to place.

## Two rules that are easy to get wrong

**Locked rooms fold into their owner.** A locked room has no schedule of its
own; `reviewRoomKeyFor` reports its owner's. So the aggregation groups by
`reviewRoomKey`, sums `moveCount` across *every* generated room resolving to
that key, and counts **one** room per distinct key. Those moves genuinely are
part of what you review when you walk the owner. Counting them separately
would double-count — the exact bug that bit the digraph's coverage bars twice,
both times found only by a test.

**Clumping at 1–3 days is correct, not a bug.** `ROOM_REVIEW_FUZZ` (±15%)
deliberately has no effect below about a week: 15% of 3 days is ±11 hours and
due dates snap to local midnight, so short intervals absorb their own fuzz.
This feature is the first thing that will make that visible. Say so in the UI
rather than letting it read as a scheduling fault.

## Shape

- **Modal** `#reviewForecastOverlay`, **Informational** under
  `Documents/modal-buttons.md` — bar with title + `Done` only. The scope
  dropdown and the view toggle are body controls, same call as the graph.
- **Hamburger:** top-level `menuReviewForecast`, "Review Forecast", near
  "Run VR". Not under Test — it isn't one.
- **Scope:** the `castleScopeLabel` dropdown, same as the digraph and move
  table. See the open question below about "All castles".
- **No new dependency.** The pie is inline SVG arc paths (~40 lines); the
  calendar is a CSS grid. That is how the coverage bars, mini-boards and the
  room-geometry plan are already drawn. A charting library for one modal is
  not worth its weight.

## Two costs to know about

1. **It needs `buildGeneratedCastle` per castle**, measured at "several
   SECONDS per render" and the reason the move table's room list is lazy. The
   report rides the existing `gatherBuiltCastles` cache and shows a spinner on
   a cold one. On a large repertoire the first open will not be instant.
2. **A castle memorized long ago but never reviewed shows as one giant overdue
   bar.** That is *correct* — `bootstrapRoomReview` dates the first review
   from the memorized timestamp, so everything old is genuinely overdue at
   step 0 — but it looks alarming. Surface it as its own line ("N rooms were
   memorized but never reviewed") rather than letting the chart imply neglect
   of work that was never started.

---

# Phasing plan

Each phase ships on its own and is useful on its own. The order is driven by
the pacing use case, not by how the UI reads top to bottom: the numbers that
answer "should I memorize today?" come first, the long-horizon views last.

## Phase 1 — the aggregation core, no UI ✅ BUILT

`buildReviewForecast(castles, reviews, memorized, opts)` in `js/app.js` — pure,
everything injected including the clock — with `reviewForecast(opts)` as the
thin async wrapper that fetches them. The bucket rule itself
(`reviewForecastBucket`, `REVIEW_FORECAST_BUCKETS`) lives in `js/db.js` beside
`roomReviewState`, which it delegates to, since that is where the scheduling
rules live and both modules can reach them.

Seven tests in phase EF: due-date-vs-ladder bucketing, locked-room exclusion,
the unmemorized and never-reviewed buckets, scoping by castle and by line, the
per-day map, the fully-shaped empty result, and one end-to-end run over real
castle generation and real IDB.

Two things worth knowing about what got built:

- **The result reports what locked rooms hold** (`locked: {moves, rooms}`),
  not just that they were skipped. It should always be zero — a room with no
  exits and no non-center pairs has no outgoing moves either — and if it ever
  is not, the forecast would be silently dropping moves from every total. A
  number you can see beats an assumption you can't, and there is a test
  asserting the zero.
- **`gatherBuiltCastles` now carries `entryPosKey`** per castle, so consumers
  can apply the "a castle root is never locked" exemption without guessing
  that `genRooms[0]` is the root. The coverage bars compute the same thing
  independently today and could be moved onto it.

Returns:

- the eight buckets, each `{ moves, rooms }`;
- the ladder-step distribution, each `{ step, days, moves, rooms }`;
- `neverReviewed` — memorized rooms with no grade yet;
- `perDay` — a `dueDate → { moves, rooms }` map, for Phase 5's calendar.

Pure over `gatherBuiltCastles()` + `ROOM_REVIEWS` + `MEMORIZED_ROOMS`. Lives
in `js/app.js` beside the graph's own aggregation (it needs the same
`reviewRoomKeyFor`/locked-room resolution, and that logic must not be
duplicated). Exposed through a test hook.

**This is where the whole feature's risk is**, so it is tested before anything
draws: locked-room folding (the double-count), bucket edges including the
`roomReviewState` delegation, the not-memorized bucket, scope filtering, and a
merged-corridor fixture. If Phase 1 is right the rest is rendering.

**Ships:** nothing visible. Worth it anyway — every later phase is a thin
renderer over this, and a bug here would be invisible in all of them.

## Phase 2 — the modal, with the numbers ✅ BUILT

`menuReviewForecast` in the hamburger, `#reviewForecastOverlay`, Informational
bar (title + `Done`), scope dropdown, spinner on a cold cache. Body is three
sections of labelled bars: **Coming due** (the buckets), **How well learned**
(the ladder rungs), and **Totals**.

No pie, no calendar. **This is already the whole pacing feature** — open it,
read the week, decide. Everything after makes it nicer to read, not more
capable.

Three things decided while building it:

- **The default scope is All castles.** The pacing decision is not made per
  castle: your load is whatever is due across the whole repertoire, and a
  per-castle default can show a quiet castle while tomorrow is heavy
  elsewhere. Per castle is one click away. There is a test asserting the
  default against the module's own scope state, not against the select's
  blank value, so it cannot pass by coincidence.
- **Bars scale to the largest row in their section, not to the section
  total.** A coverage bar is a *fraction of a whole*, so its track is the
  denominator; a forecast bucket is a *share*, and scaling eight buckets to
  their total renders a lopsided castle as eight slivers — which destroys
  exactly the thing this view is for.
- **One spinner across the whole open**, not one per half. Taking a second
  for the draw hides and re-shows it in between: a flicker on a warm cache
  and two loading flashes on a cold one.

Its tests deliberately do **not** re-test the rules Phase 1 covers. They check
the wiring and the modal's own two decisions: the default scope, and that the
numbers rendered are the aggregation's own (a renderer that recomputed
anything would be a second source of truth, which is what Phase 1 exists to
prevent).

## Phase 3 — the pacing read ✅ BUILT

Three cumulative load cards (**Due now**, **By tomorrow**, **Next 7 days**,
that last one highlighted) above everything else, then one sentence.

**The windows are cumulative, and overdue counts in all of them.** That is how
the work actually arrives: sit down tomorrow and you face what is overdue,
plus what was due today, plus tomorrow's own. Per-bucket numbers make you add
three of them in your head to get the one you wanted, and dropping overdue
would understate the load exactly when it is worst.

**The sentence is the payload, and it turns on a fact nobody had written down
yet:** a room you memorize today first falls due *tomorrow*
(`bootstrapRoomReview` dates it from the memorized timestamp plus one day). So
the number a "should I memorize today?" decision is really made against is
**tomorrow alone**, not the cumulative week — that is the pile the new room
would land on. Hence `tomorrowOnly` in the aggregation, deliberately not
cumulative, sitting next to windows that are.

It also names the **heaviest single day in the next 30**, which is the other
half of pacing ("is there a wall coming?"). Future days only: a past due date
is already counted as overdue, and a heaviest day in the past is not something
anyone can act on. Worth having because the scheduler's fuzz does nothing
below about a week, so short-interval pile-ups are real and this is the first
thing that can show one.

**It makes no recommendation, on purpose.** Nothing here knows how much you
can get through in a sitting, so a "that's too much" threshold would be a
guess dressed up as advice. There is a test asserting the wording stays
factual.

**Open, unchanged:** a rolling average of what you actually complete per day
would turn "24 moves" into "about two normal days' worth", which is a much
better signal — but nothing records completed sessions, so it needs its own
store and its own phase.

## Phase 4 — the pie ✅ BUILT

Inline SVG donuts, no new dependency. **Changed from the proposal:** not one
chart on a mode toggle, but **one ring per section, beside its own bars**.
That removes a control, shows both readings at once, and — the real reason —
lets the bars act as the ring's legend, so it needs no legend of its own and
no colour-matching squint.

**The ring is not a second reading of the bars.** The bars are scaled to the
largest row in their section, deliberately, so the shape of the week is
legible — and that scaling throws away "what share of the whole is this?".
The ring is exactly that share. They are complementary by construction, which
is why they sit side by side rather than as alternatives.

**Drawn as dash-offset circle segments, not arc paths.** No trig, no
large-arc-flag edge cases, and — the case that decided it — a single 100%
slice renders as a full ring instead of collapsing to a zero-length arc. That
is the classic way the path approach fails, on exactly the input you least
want it to: a fresh repertoire, where everything is one colour. There is a
test for it.

**The ladder ring ramps light-to-dark up the rungs** rather than reusing the
bars' single colour. The rungs are one quantity, not seven categories, so the
bars share a colour — but seven identical blues make a ring nobody can read,
and "how much has climbed" is the whole reading it offers.

Its tests check the share arithmetic, not pixels: slices tile the ring exactly
(each starts where the last ended, the last ends at the circumference), each
is proportional to its bucket and says so in its tooltip, zero buckets produce
no slice at all, and a ring with nothing in it is omitted rather than drawn
empty.

## Phase 5 — the calendar ✅ BUILT

Month grid, one cell per day, moves with rooms under them, shaded by load.
Consumes Phase 1's `perDay` map directly and computes no schedule of its own.

**Changed from the proposal:** no forward/back arrows. The strip above *is*
the navigation — each month is a button — which is one control instead of
three and makes "jump to the busy month" a single click rather than repeated
paging. The strip spans at least six months, because the ladder tops out at
180 days and a shorter one would hide the far end of a mature repertoire,
extending to cover whatever is actually scheduled and capped at twelve so a
stray far-future date cannot produce a hundred columns.

**Future days only.** A past due date is already counted as overdue and that
figure sits at the top of the modal; drawing it again across a month of grey
squares would be a calendar of the past, which is noise you cannot act on.

**Cell shading is scaled within the displayed month** — the same call the bars
make, for the same reason: it makes that month's own shape readable.
Cross-month comparison is what the strip is for, so nothing is lost by not
also attempting it in the grid.

**Picking a month is a view change, not a query.** It redraws from the
forecast already in hand (`RF_LAST`); the modal is a snapshot and does not
live-update, so a month click has no business walking every room again. On a
large repertoire that would make paging cost the same as opening the modal.

Two things worth knowing for the next person:

- **Changing scope resets the month.** Otherwise picking March and then
  switching to a castle whose schedule is all in January strands you on an
  empty grid that looks like the castle has nothing due.
- **`renderReviewForecast` bumps a counter into `body.dataset.rfGen`.** A test
  waiting for a re-render cannot wait on "the grid exists" — the previous
  render's grid is still in the DOM until the new `innerHTML` lands, so that
  wait is satisfied by stale markup and reads the old month. The
  scope-reset test failed exactly that way before the counter existed. Same
  reason `applyBackupData` has `__importBackupGen`.

## Phase 6 — extensions

Whatever survives contact with actual use. Candidates, unscheduled: "All
castles" if it was not pulled forward (see below), a heat strip over a year,
and the completed-sessions average from Phase 3.

---

## Open question worth settling before Phase 2

**"Per castle for now" and the pacing use case pull in opposite directions.**

Scoping to one castle is what was asked for, and it is the right unit for
"how well-learned is this castle?". But the pacing decision is not per castle:
when you decide whether to memorize a new room today, your review load is
whatever is due across your *whole repertoire*, in every castle. A per-castle
forecast can tell you a castle is quiet while tomorrow is genuinely heavy
elsewhere.

Making the scope dropdown's first entry **"All castles"** costs almost nothing
once Phase 1 takes a scope argument — but it changes what the default view
means, so it is a decision rather than an implementation detail. Recommendation:
include it from Phase 2 and default to it, with per-castle a click away.

---

# The ripple projection

## The problem

The forecast shows each room's **next** review and nothing after it. That is
not a conservative estimate, it is a **non-uniformly wrong** one: the error is
zero on day 0 and grows with the horizon, so the part of the calendar that
looks emptiest is the part that is least trustworthy.

A room on rung 0 graded successfully every time falls due on day 1, day 4
(1+3), day 11 (4+7), then day 32. That is **three appearances inside the
30-day window; the calendar shows one.** A room on rung 3 (21 days) appears
once and then not again until day 81 — there the snapshot is exactly right.

So the understatement is concentrated in low-rung rooms, which is precisely
the population the pacing decision is made against, and it makes days 2-7 —
the window that decision actually looks at — read far freer than they are.

## Why 50% is the wrong fallback

At p=0.5 half of every review resets to rung 0 and a 1-day interval, and
almost nothing ever climbs to rung 5. That contradicts the observed behaviour
of a real repertoire, where rooms do climb. It would print a frightening
number, and the natural response to a frightening number is to stop
memorizing — wrong in the expensive direction.

The fallback should be **~0.85, blended rather than switched**:

    p(rung) = (A_seen + k · 0.85) / (n_seen + k)          with k ≈ 5

which gives the prior on day one and slides to measured data as evidence
arrives, with no "not enough data yet" cliff and no threshold to argue about.

## B is the modelling problem, not C

The obvious two-state model — succeed and advance, fail and come back
tomorrow — is wrong for this ladder, and wrong in both directions at once.

B **holds** the rung (two consecutive B's demote one), and B is probably the
*modal* grade: "90 percent right" on a room holding fourteen move-pairs is a
B, not an A. A two-state model would miss that most reviews neither advance
nor reset, and would treat every non-A as a reset to a 1-day interval.

So the projection models all three grades, which costs one extra probability
and carrying `lastGrade` through the simulation.

## Compute it exactly, not by sampling

No Monte Carlo. Each room starts as probability mass 1.0 at
`(due_day, rung, lastGrade)`; at each due day the mass splits three ways into
future cells; sum across rooms weighted by `moveCount`. That is the exact
expected load per day, linear in rooms × horizon × rungs.

The reason to insist: it is **deterministic**, so the tests are
hand-verifiable numbers rather than tolerance bands around sampled noise.

## Present it as a layer, not a mode

A checkbox that *replaces* the numbers creates a mode you can forget you are
in, and conflates fact with estimate — the scheduled counts are real due
dates, the ripple is a guess. Show the calendar cell as scheduled (solid) plus
projected (hatched), and scope the ripple to the **calendar and the pacing
lines only**. The donut and the ladder table are snapshot-shaped concepts
(bucket by current due date) and rippling them muddies what they mean.

## Two assumptions to state rather than model

- **Overdue work happens today.** A projection has to assume when the backlog
  gets cleared. Modelling a drain rate is a rabbit hole; the honest one-liner
  next to the number is worth more: *"projects what happens if you review each
  room on the day it comes due."*
- **Fuzz is ignored.** Nominal intervals artificially sharpen distant peaks,
  but `ROOM_REVIEW_FUZZ` does nothing below a week by design and the ripple's
  value is near-term. Smearing each arrival over its ±15% window at rungs ≥ 7
  days is a later refinement.

Neither is a reason to wait; both are reasons to say what the number means
next to the number.

## Steps

**Step 1 — collect the statistics. BUILT.** Two stores, deliberately:

- `REVIEW_GRADE_STATS_KEY` (`threeReviewGradeStats`), a `{rung: {A,B,C}}`
  tally folded by `tallyReviewGrade`. Lifetime totals, never forgets.
- `REVIEW_GRADE_LOG_KEY` (`threeReviewGradeLog`), one `{t, r, n, d, g}` row
  per graded review, capped at 20k (~1MB, roughly a decade). Both are written
  by `recordReviewGrade` under one serialized queue.

No UI reads either yet, deliberately: the data is worthless until it has been
accumulating, so shipping collection first means the projection arrives with
real numbers instead of pure prior. Every day it is not shipped is a day of
data that cannot be recovered.

**The log exists because the tally has two blind spots, and both are
unrecoverable after the fact** -- the first version of this shipped with only
the tally and had to be widened before the thin data became months of it:

- **Room size.** The tally cannot answer "do big rooms grade worse", and the
  answer cannot be reconstructed later: `moveCount` is recomputed from the
  CURRENT repertoire on every render, so how big a room was when it was graded
  in March is not something the app keeps. Rooms grow as replies are added,
  and they split. `n` records it at the moment of grading (threaded through
  `ROOMS[key].moveCount`, added for this).
- **The interval that actually ran.** The tally files a grade under its
  NOMINAL rung, but a rung-2 room reviewed 25 days late is evidence about 25
  days, not 7. Late reviews fail more, and charging those failures to an
  interval that was never tested makes the rung look worse than it is --
  worst for someone working through an overdue backlog, i.e. exactly when the
  report is most wanted. `d` records the real elapsed days.

The tally is derivable from the log and not the reverse, so of the two the log
is the one that had to exist before the data started arriving. Both are kept
because they lose different things: the tally survives the log's rollover.

**A third store: the quiz step log** (`QUIZ_LOG_KEY`, `threeQuizLog`), one
`{t, k, o, p, r, d}` row per move the board quiz asks, capped at 10k (rows
carry a room key, so they run ~145 bytes against the grade log's ~50).

It is a different INSTRUMENT, not more of the same data, and the difference
matters for calibration:

| | VR grade | Quiz step |
|---|---|---|
| Scored by | you | the app |
| Granularity | the whole room | one move |
| Cue | the move objects, all at once | the position, then one move at a time |
| Matches a real game | loosely | closely |

Self-graded recall is vulnerable to mistaking recognition for recall — with
the object in view it is easy to feel "yes, I knew that". The quiz cannot make
that mistake, which makes it the better instrument for asking what your real
retention is, even though the grade remains what drives the schedule.

It is deliberately NOT folded into the grade tally. That tally measures how
you GRADE, and mixing a second instrument's verdicts into it would corrupt
exactly the distribution the projection reads — the same reason
`demoteRoomReview` is excluded from it.

`k` (the room key) is here and not in the grade log, so this is the store any
later room-shaped analysis has to join through: occurrence frequency, castle,
room size, or how much new material was memorized during the interval.

Outcomes are one per step, written when the step RESOLVES rather than when it
is attempted, so a wrong answer followed by a correct retry is one `miss`
rather than a miss plus a hit: `hit`, `unsure` (correct but flagged as
guessing), `miss`, `reveal` (gave up). A wrong attempt outranks the unsure
flag — producing the wrong move is harder evidence than feeling shaky about
the right one.

Three rules it is worth not re-deriving later:

- **Attributed to the rung the review was ON**, never the one it moved to. The
  grade judges the interval just completed, so an A at rung 2 is evidence
  about the 7-day rung. Filing it forward measures the wrong interval, and in
  the flattering direction.
- **Grades only.** `demoteRoomReview` (a structural change or a board-quiz
  miss) changes a schedule without being a verdict on the interval, and
  `softenRoomReview` is about timing rather than recall. Folding either in
  would bias the rates with evidence about something else.
- **A correction replaces.** Re-grading within one visit replaces rather than
  compounds (`threeVR.js`'s `preGradeRecord`), so the tally un-counts what the
  visit already contributed — otherwise a fumbled grade menu inflates the very
  statistics this exists to measure.

It travels in the backup (v8's `reviewGradeStats`). Unlike a review schedule
there is nothing to reconstruct it from, so a restore that dropped it would
reset months of measurement to zero silently.

**Step 2 — the projection.** The pure expectation-propagation function and the
calendar layer, same shape as `buildReviewForecast`: all the risk in one
testable function, a thin renderer over it.

**Step 3 — surface the rates.** Show the measured per-rung success rates, which
makes the projection's assumptions inspectable rather than magic — and is
independently interesting: a 95% success rate at the 21-day rung says the
ladder is too conservative there, 50% at 7 days says it is too aggressive.
Same data could eventually tune the ladder itself.

## A cheaper answer to the same question

The ripple answers "what does the next month look like?". The actual question
is "can I afford another room?", and there is a single number for that. Given
per-rung success rates each room has an expected long-run review rate, and the
sum across the repertoire is a **maintenance cost in moves/day at
equilibrium** — a mature room at 180 days costs almost nothing, a room stuck
at rung 0 costs a review every day. One line ("your repertoire costs ~34
moves/day to maintain") may drive the memorize-or-not decision better than any
calendar, and it falls out of the same machinery.
