# Full Backup — what it covers, and why a test guards it

**Rule: adding an object store or a meta key is a backup decision.** Make it
deliberately — either export it from `buildBackupData()` or name it in
`BACKUP_EXCLUDED_STORES` / `BACKUP_EXCLUDED_META` (both in `js/app.js`) with a
reason. A source-level test fails the build if you do neither.

## The bug this exists to prevent

`clearAllData()` (`js/db.js`) wipes **nine object stores, including `meta`**,
before a restore writes anything — that's what makes a restore a restore
rather than a merge. But `buildBackupData()` exports a **hand-maintained
allowlist**: a fixed set of stores, a fixed set of meta keys, and prefs copied
*field by field*.

Nothing keeps the two halves in step, and they drifted. Perfect Opening landed
as DB v8: `clearAllData` learned about it, because bumping `DB_VERSION` forces
you to look at that list, and the exporter did not.

The result was not a missing backup. It was a **destructive restore** —
restoring *any* backup, including one taken minutes earlier on the same
browser, silently reset your Perfect Opening configuration. That asymmetry is
the thing to watch for: the wipe list has a forcing function, the export list
has none.

## What is covered

| Data | Where it lives | Carried as |
|---|---|---|
| Games, opening systems, prefs | `games`, `lines`, `prefs` | `games`, `lines[].prefs[]` |
| Mnemonics + notes + disambiguator | `mnemonics`, `meta` | `mnemonics`, `mnemonicsNotes`, `moveDisambiguator` |
| VR layout, memorized, decorated | `meta` | `threeLayout`, `memorizedRooms`, `decoratedRooms` |
| **Spaced-repetition review history** | `meta` (`threeRoomReviews`) | `roomReviews` |
| **Per-rung grade statistics** (v8) | `meta` (`threeReviewGradeStats`) | `reviewGradeStats` |
| **Grade event log** (v8) | `meta` (`threeReviewGradeLog`) | `reviewGradeLog` |
| **Quiz step log** (v8) | `meta` (`threeQuizLog`) | `quizLog` |
| Memorized room-shape snapshots | `meta` | `memorizedShapes` |
| Digraph node positions | `meta` | `graphLayout` |
| **Perfect Opening settings** (v7) | `meta` | `perfectOpeningConfig` |
| Recently-used surface colours (v7) | `meta` | `recentSurfaceColors` |
| VR assets, object lists | `assets`, `objectLists` | `assets`, `objectLists` |
| Lichess / chess.com handles | localStorage | `lichessUser`, `chesscomUser` |

## What is deliberately left out

- **`analysisQueue`** and **`perfectOpeningQueue`** — transient engine work.
  Jobs are re-queued from the tree on demand, and a queue restored onto a
  different machine would resume work that machine never started. Perfect
  Opening's *config* travels; its in-flight job list does not. **A restore
  empties both, by design rather than by omission.**
- **`safetyBackup`** — the pre-restore rollback snapshot itself. Backing up a
  backup, and `clearAllData` deliberately spares it so an interrupted restore
  can still recover.
- **`builtCastlesCacheV2`**, **`gamesPositionIndexCache`** — derived caches,
  stamped with `BUILD_TAG` and rebuilt on demand.
- **`mnemDefaultOffered`**, **`assetsDefaultOffered`** — one-time "we already
  offered you the defaults" flags. Re-offering on a fresh browser is the
  better behaviour, so these must *not* travel.
- **The OpenAI API key** (`OPENAI_KEY_LS`, localStorage) — a credential should
  never ride along in a file you might share or upload.
- Other localStorage UI preferences (engine depth/threads, compact mode, the
  remembered "Show:" scope). A backup is a *data* backup; these are per-device
  view state and are cheap to re-set.

## The `version` field

`8` as of the review-statistics additions — the grade tally, the grade event
log and the quiz step log (v5 added `threeLayout`, v6 `objectLists`, v7
Perfect Opening's config). It says what a file **contains** — it is **not** a
compatibility gate. Every field in `applyBackupData()` is read behind a
`typeof` guard, so an older backup restores into a newer build unchanged, with
the newer fields simply left at their defaults. There is a test for exactly
that (a v6 file restoring cleanly), so keep the guards when adding fields.

## The guard

`test/run-tests.mjs`, phase **BGx** (`import-export`), three source-level
tests — no browser, they read `js/*.js` from disk:

1. every object store is exported or excluded;
2. every meta key the app writes is exported or excluded — detected through
   `setMeta('literal')`, `setMeta(SOME_KEY)` resolved via its `const`
   declaration, and the DB upgrade path's direct `metaStore.put`;
3. every pref field written anywhere is copied by the prefs map.

Plus round-trip tests that restore a backup carrying each field and re-export
it, proving both directions rather than just storage.

The audit was checked against real history: run against the pre-fix `app.js`
it reports exactly the gaps that existed (`perfectOpeningConfig`,
`recentSurfaceColors`, and the three unlisted stores), and clean against the
fixed one.

**If one of these fails, do not just add the key to the exclusion list to make
it green.** Ask whether losing that data on every restore is acceptable — the
answer is usually no, which is the entire point.
