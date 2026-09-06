# VR Slowness — open bug, investigation notes

**Status: UNRESOLVED.** Written so a future agent (or future me) can pick up
without re-deriving weeks of dead ends. Last updated at `BUILD_TAG` `-357`.

The symptom is that the VR walkthrough becomes unusable — roughly **5 seconds
per keypress** — on the user's main PC, for hours or days at a stretch, then
clears up on its own. Everything about the app *outside* VR stays responsive.
It has never reproduced on any other machine, or in incognito on any machine.

Read the "Ruled out" list before proposing a theory; most of the obvious ones
are already dead, several of them killed after being confidently asserted.

---

## The one reliable fix found so far

**Reset to Factory, then re-import a backup.** Confirmed by the user: after
the slowness had persisted across a cache clear, a hard reload, and a full
backup re-import, a factory reset plus re-import of the same data made VR
fast again immediately.

That distinction is the single most informative fact in this whole
investigation, because of how the two paths differ in `js/db.js`:

- **Full backup restore** → `clearAllData()` (line ~627): calls `.clear()` on
  each object store. The IndexedDB database file itself survives. In Chrome
  that leaves LevelDB tombstones behind until the storage layer compacts on
  its own schedule.
- **Reset to Factory** → `deleteEntireDatabase()` (line ~647):
  `indexedDB.deleteDatabase()`, plus `localStorage.clear()` and a reload
  (`js/app.js` ~7993). The database and its blob files are physically gone.

So whatever causes this survives having every object store emptied, but does
not survive the database being deleted. That points at the physical store
rather than at the app's own data — but see the contradiction below before
treating that as settled.

## Storage size readings (keep adding to this table)

The IndexedDB size for the affected origin is the cheapest hard signal we
have. Read it at DevTools → Application → Storage, per origin (`github.io`
and the githack origin are separate origins with separate databases).

| Date | Origin | State | IndexedDB size | VR |
|---|---|---|---|---|
| 2026-09-06 | `vorpalrobotics.github.io` | right after factory reset + import of that day's data | **69 MB** | fast |

**69 MB is the known-good baseline for ~17,933 games plus assets.** If a
future reading during a slow episode is several times that, the storage-bloat
theory is confirmed and the fix work becomes concrete. If it is still ~69 MB
while VR is crawling, the theory is dead and the store is exonerated.

## What the profiler actually showed

A DevTools Performance recording taken during a slow episode showed
`buildPositionIndex` → `indexOneGame` consuming 92.9% of a 16-second
recording, with the "1st/3rd party" panel attributing ~96% of main-thread
time to "Cloudflare CDN" — that is chess.js's own move-generation code, which
loads from esm.sh. This was **misread twice** before being pinned down:

- It is **one** call, not many. `buildPositionIndex` (`js/app.js` ~595)
  yields via `await nextPaint()` every 100 games, so each chunk is drawn as
  its own "Task → Animation frame fired" block. It looks like a repeating
  call and is not. The `console.trace` instrumentation confirmed exactly one
  invocation per boot.
- That single call is **legitimate boot work**, not a bug: the persisted
  index was stale, so it rebuilt. On this machine that costs 10–20 s, and
  `gatherBuiltCastles` right after it logged `built 14 castle(s) in 20162ms`
  (and `22782ms` on another run). While those run, VR is alive but crawls —
  which is a genuine ~40 s of slowness at every boot, and can masquerade as
  the real bug if you happen to enter VR right after loading.

A later recording taken during a slow episode with no indexing in flight
showed **seven parallel `Worker` threads plus a `stockfish-18-lite.js`
worker and a thread pool**, all fully busy. That led to the multi-threaded
Stockfish theory, which is now also dead (see below) — but note
`engine.init()` runs unconditionally at boot (`js/app.js` ~9566) and asks for
up to 8 threads, so seeing those threads busy shortly after a load is
expected and is not by itself evidence of anything.

## Ruled out

Each of these was tested and disproved; don't re-litigate without new evidence.

- **The app's data.** Same backup is fast on other machines and in incognito.
  Old backups are slow on this machine; new backups are fast elsewhere.
- **Machine hardware / GPU.** `chrome://gpu` shows everything hardware
  accelerated; three.js sample scenes run fine; a much weaker old PC runs the
  same data fine.
- **System load.** Task Manager shows ~90% idle throughout. (Caution: on an
  8-core machine one fully saturated core reads as ~88% idle, so this does
  *not* rule out a single busy thread — but it does rule out the 8-thread
  engine pool.)
- **Browser extensions.** MetaMask, Coinbase Wallet and others were removed,
  then *all* extensions were disabled. No change.
- **A system-level reboot.** No change.
- **Stockfish / engine analysis.** Perfect Opening is not merely disabled but
  has no project configured at all; the manual analysis queue is empty; no
  live analysis is running. A VR CPU guardrail shipped anyway (`-354`,
  below), which is worth keeping but did not fix this.
- **The transposition/redirect code changes made during this same period.**
  The user explicitly re-tested a hide/unhide/re-target sequence on a fast
  session and VR stayed fast; the slowness predates and outlives those
  changes.
- **A reload loop / service-worker cycling.** The `index.html` reload-loop
  detector has never fired more than a normal load count, and the
  `coi-serviceworker` registration stays stable while VR is actively slow.
- **`localStorage`.** The only keys the app writes are `threeHintsOn`, a
  one-time migration flag, and `threeTestDebug`. Nothing that could cause
  this — though note factory reset clears it and restore does not, so it
  cannot be *fully* excluded on the "what does factory reset do differently"
  axis alone.

## Behavioural fingerprint (the constraint set any theory must satisfy)

These come from the user's direct observation and are the tightest
constraints available. A theory that violates any of them is wrong.

- **Per-origin and independent.** Two tabs on two different origins have been
  slow simultaneously — but one recovered and behaved normally while the
  other stayed slow *for hours longer*. So they degrade and heal on their own
  schedules. This **rules out** any single shared resource (a shared storage
  process, a system-wide condition, the GPU) as the mechanism, and it retires
  the earlier "both slow at once" objection to the per-origin storage theory:
  they were independently bad, not commonly bad.
- **A full reboot never helps. Ever.** So it is not a stuck process, thread,
  or anything held in memory. It is persistent on-disk state.
- **It does eventually clear on its own**, sometimes after hours or days, with
  no intervention.
- **Factory reset always fixes it immediately; restoring a backup never
  does.** The difference is `deleteDatabase()` vs `clear()`ing the stores.

Persistent on-disk, per-origin, self-healing on a long timescale, curable
only by deleting the file: that is the behaviour of a **LevelDB that has
degraded structurally** (many small overlapping SST files / accumulated
tombstones from repeated large-value overwrites, making every read scan
many files) and is eventually put right by background compaction.
`clear()` cannot fix that — it writes *more* tombstones — while
`deleteDatabase()` removes the file outright. This is the leading theory. It
is a strong fit, not a proven finding; say so when reporting it.

## Corroborating Chromium bug (found 2026-09-06)

**[Chromium issue 41008118 — "IndexedDB becomes slower and slower after
adding and deleting db entries"](https://issues.chromium.org/issues/41008118)**
describes this exact failure mode: after inserting and then deleting a large
number of entries, queries run **10–40× slower** even against an empty store.
The cause is that IndexedDB does not delete records eagerly — it marks them
absent and overwrites append rather than replace, leaving tombstones that are
purged only when a **threshold-triggered, lazy compaction** eventually runs.

Every observed behaviour follows from that: persistent (it is on disk, so a
reboot is irrelevant), self-healing on an unpredictable timescale (compaction
runs when it runs), per-origin and independent (each origin has its own
LevelDB), absent in incognito (in-memory), curable by `deleteDatabase()` and
*not* by `clear()`. A 10–40× slowdown also matches the magnitude: normal VR
interaction becoming ~5 s per action.

**This implicates the app's own restore path as the trigger.**
`clearAllData()` deletes ~18,000 game records plus every asset and pref, and
the restore then immediately re-inserts ~18,000 — a mass delete-then-insert,
the precise pattern the bug is about. So **restoring a backup does not fix
the slowness; it is the most likely thing causing it**, which is exactly what
the user observed (restore never helps, factory reset always does). The user
had been restoring repeatedly while testing during the period the episodes
appeared.

That makes loose end #3 below (end a restore with a delete-and-recreate
rather than `clearAllData()`) the highest-value fix available, and it is now
evidence-backed rather than speculative. Note also that "only VR is slow" may
be partly perceptual: boot is *also* slow (the 20 s castle build), but a slow
boot reads as normal loading, whereas 5 s per keypress in an interactive 3D
walkthrough is glaring.

## Chrome version correlation — CHECK THIS FIRST

**The user recalls these episodes beginning around a recent Chrome update,
and not occurring before it.** If that holds up it reframes everything: the
app's write patterns may have been survivable for months and only became
pathological under a new Chrome storage implementation — i.e. a Chrome
regression, not an app bug.

A further Chrome update landed on 2026-09-06 while this was being
investigated (to **152.0.7977.82**). **That is a natural experiment: if the
episodes stop after it, the cause was almost certainly the previous Chrome
build.** Before spending effort anywhere else, ask the user whether it has
recurred since updating, and record the Chrome version alongside each entry
in the size table above.

Caveat on that: a search of the Chrome 152 release notes and the Chromium
tracker turned up **no evidence of an IndexedDB fix in 152** specifically,
and issue 41008118 above is long-standing rather than a recent regression. So
the Chrome-update correlation may well be coincidence, or a change in
compaction thresholds/timing rather than a fix. Treat "the update fixed it"
as unconfirmed until several days of normal use pass without an episode.

## Why VR specifically, and not the rest of the app

This asymmetry was unexplained for a long time and is worth understanding,
because it is what ties a storage problem to a *rendering* symptom.

Most of the app reads IndexedDB at boot and then works from memory. **VR is
the exception: it can write a large blob to IndexedDB while you move.**
`buildRoom` (`js/threeVR.js` ~5665) runs on every room transition and opens
with `reconcileRoomBounds`, which calls `persistLayout()` when it has to
correct anything (`~5620`, and `~5548` when a room's geometry grows).
`persistLayout()` is `setMeta(LAYOUT_KEY, JSON.stringify(LAYOUT))` — a
synchronous stringify of the entire layout object on the main thread, plus a
write of the result. Edit-mode actions call it far more often still
(`applyEdit`, `setSlotXformLive`, `setSignPosLive`, undo/redo, and ~20 more
sites).

So VR repeatedly rewrites one large value in the `meta` store — exactly the
access pattern that degrades a LevelDB, and exactly the operation that a
degraded LevelDB makes slow. The same store also takes the two big cache
blobs (`gamesPositionIndexCache`, `builtCastlesCacheV2`) on every boot. That
is a plausible mechanism for the app *causing* its own store's degradation as
well as suffering from it — but note it has **not** been measured; nobody has
yet confirmed `persistLayout` is slow during an episode, or how big `LAYOUT`
actually is on this profile. Measuring that is high-value and cheap:
`JSON.stringify(LAYOUT).length` from the console during an episode, and time
a `persistLayout()` call.

## Loose ends worth chasing

1. **The persisted position-index stamp is frozen at `-324`.** Every boot
   logs `[games index] persisted index is from a different build (-324, want
   -357) -- rebuilding`, across a dozen-plus builds since `-324`. That means
   the re-save is not landing. The write is deliberately fire-and-forget
   (`setMeta(POSITION_INDEX_CACHE_KEY, …)` in `positionIndex` and
   `reindexAfterImport`, `js/app.js` ~665 and ~699), so a failure — quota,
   a too-large value, or the page navigating before the write commits — would
   be silent. **This is the highest-value loose end**: if it is failing, the
   user pays a full 10–20 s rebuild *and* a large failed write on every single
   boot, forever. Check the console for
   `[perf-debug] unhandled promise rejection` after a boot settles.
2. **Both persisted caches are stamped with `BUILD_TAG`**
   (`POSITION_INDEX_CACHE_KEY`, `BUILT_CASTLES_CACHE_KEY`), which changes on
   every deploy. So every user pays a full index rebuild *and* a full castle
   rebuild after every single push — roughly 40 s on this dataset, ~25 times
   in one session. A separate format-version constant, bumped only when the
   index or castle-generation logic actually changes, would make routine
   deploys free. This is a real inefficiency independent of the bug.
3. **Restore leaves the database physically bloated.** Ending a restore with
   a delete-and-recreate rather than `clearAllData()` would let a restore fix
   the problem the way factory reset does. This changes restore's
   crash-safety design (the `safetyBackup` store is deliberately spared by
   `clearAllData`), so get the user's explicit go-ahead first. Note the
   safety copy is gzipped and *is* cleared on a successful restore
   (`importBackup`, `js/app.js` ~6467) — it is not a permanent second copy,
   so don't repeat that claim.

## Instrumentation already in place (do not remove yet)

All tagged `[perf-debug]`; filter the console on that string. Marked "TEMP
diagnostic (2026-09) … Remove once root-caused" in the source. Present as of
`-357`:

- `index.html` (~line 30-70), before `coi-serviceworker.min.js` loads: a
  `sessionStorage`-backed page-load counter that logs every load and alerts
  on 4+ within 20 s, plus a full `navigator.serviceWorker.getRegistrations()`
  dump. Fires on **every** page load — if these two lines don't appear, the
  build under test is not the one you think it is.
- `js/app.js` ~27: `window.__repchessAppBootCount` guard — errors if the
  module's top-level code somehow runs twice in one document.
- `js/app.js` ~35: a global `unhandledrejection` logger. See loose end #1.
- `js/app.js` ~566 / ~600: `console.trace` on
  `invalidatePositionIndexCache` and `buildPositionIndex`, so any rebuild
  reports its own call stack.

## What to ask the user for, next time it happens

In rough order of value per unit of the user's time:

1. **IndexedDB size** for the slow origin (Application → Storage). Compare
   against the 69 MB baseline above and add a row to the table.
2. **Performance monitor** (DevTools → ⋮ → More tools → Performance monitor),
   read *during* an episode: CPU usage near 100% means the main thread is
   computing (JS or GC); near 0% while VR is stuck means it is waiting on
   something. Plus JS heap size — a sawtooth on a large heap means GC
   pressure. This is the cheapest live measurement and has never been
   captured yet.
3. **Chrome's own task manager** (`Shift+Esc`) during an episode: shows
   whether the tab's renderer, the GPU process, or a utility process
   (the storage service lives in one) is burning CPU.
4. **Console, filtered to `perf-debug`**, after a boot settles.
5. A **Performance recording** during an episode — press *Stop*, not reset,
   even if the page looks frozen; the trace is captured throughout. One
   earlier attempt was abandoned mid-recording and that minute of data was
   exactly what was needed.

## Related work that shipped during this investigation

Keep these; they are independently correct even though none fixed this bug.

- `-354` (PR #196) — **VR CPU guardrail**: entering VR caps the engine to one
  thread via the new `Engine.setThreadBudget()` and blocks Perfect Opening
  and the manual analysis queue from starting new background jobs while VR is
  open; both restored on exit. Motivated by the (now-dead) Stockfish theory,
  but correct on its own terms: a multi-threaded background search should
  never compete with VR for CPU.
- `-349`/`-350`/`-351` (PR #195) — restore-race, `gatherBuiltCastles`
  concurrency, `findBrokenRedirects` position-matching, and an import spinner.
- `-355`/`-356`/`-357` (PR #197) — transposition fixes: descendant-collision
  folding, corridor-blind redirect repair, and repair-toast wording.
