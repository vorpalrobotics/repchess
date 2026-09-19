# Review Forecast — design and phasing plan

**Status: Phases 1-5 built. Phase 6 is whatever real use turns up.**

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
