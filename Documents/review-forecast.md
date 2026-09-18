# Review Forecast — design and phasing plan

**Status: proposed, not built.**

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

## Phase 1 — the aggregation core, no UI

The shared function everything else renders. `reviewForecast(scope)` returns:

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

## Phase 2 — the modal, with the numbers

Hamburger item, overlay, Informational bar, scope dropdown, spinner on a cold
cache. Body is two plain lists:

- the buckets, `N moves · M rooms` each, with a horizontal stacked bar for
  proportion (the coverage-bar idiom already in the digraph);
- the ladder-step distribution, same format.

No pie, no calendar. **This is already the whole pacing feature** — you can
open it, see "next 7 days: 84 moves · 19 rooms", and decide. Everything after
this phase makes it nicer to read, not more capable.

## Phase 3 — the pacing read

The one thing the feature exists for, made explicit instead of inferred:

- a prominent **next-7-days load**, since that is the window a "should I
  memorize today?" decision actually turns on;
- the same figure for today and tomorrow;
- the **never-reviewed** line from Phase 1;
- a plain-language summary line.

Small once Phases 1–2 exist, and it is the payload. Deliberately *not* merged
into Phase 2 so that phase can ship without waiting on wording.

**Open:** whether to go further and compare against a rolling average of what
you actually complete per day. That would turn "84 moves" into "about two
normal days' worth", which is a much better pacing signal — but nothing is
recorded about completed sessions today, so it needs its own store and its own
phase. Listed here, not scheduled.

## Phase 4 — the pie

Inline SVG, two modes on a toggle: by forecast bucket, and by ladder step.
Colours reuse the Review lens's palette so a room is the same colour in both
places. The ladder-step mode is the "how well-learned is this castle?" view,
and it is the one that will show whether the ladder is pitched right — a
repertoire that is always passing climbs steadily and piles up at the top.

## Phase 5 — the calendar

Month grid, one cell per day, `moves` with `rooms` subscripted. Forward/back
by month, plus a compact 6-month strip above for orientation — at 60- and
180-day intervals a single month shows almost nothing. Past days collapse into
the single Overdue figure; a calendar of the past is noise.

Consumes Phase 1's `perDay` map directly.

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
