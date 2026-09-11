# Multi-Domain Architecture — Design Discussion

Status: **nothing here is built.** This records a design conversation about
turning the app from a chess trainer that happens to use a memory palace
into a memory-palace system that happens to support chess. No code has been
written and no interface has been committed to; the recommendation below is
a recommendation, not a decision.

This revises an earlier draft that framed the work as "chess plus a music
domain." That framing was backwards — see §1.

Read alongside `CastleDataModel.md` (room identity and persistence) and
`LinearSequencesAndRoomObjects.md` (runs, two-track rooms, and the
move-pair ↔ object association), whose machinery nearly all of this reuses.

---

## 1. The core idea: chess is the outlier, not the base

The obvious framing is "generalize outward from chess." That is the wrong way
round. A traditional memory palace — ordered loci, each holding one vivid
image — is the *simple* case, and has thousands of years of evidence behind
it: speeches, lists, facts. Chess is the strange one, carrying three things
almost nothing else needs:

- a hierarchical **branching** structure (opponent replies)
- an **engine** for analysis
- a **specialized encoding** for moves (destination square × piece)

So the base case is a **general castle**: ordered rooms, one object per
locus, no branching, no engine. That alone supports real work — the 50 US
states with their capitals, rivers and cities; Shakespeare's plays with
characters and dates — with the ordering chosen by the user (plays by date
written; states alphabetically, by size, or by entry into the union).

Chess and music then become *configurations* of the general system rather
than peers of it, each adding only what is genuinely theirs:

| Domain | Adds |
|---|---|
| General | — (the base case) |
| Chess | branching, engine, square × piece encoding |
| Music | synth/audio, note & chord encodings, repeat rooms, timing |
| Cards / numbers | PAO-style compressed encodings |

**Strategic consequence:** the project stops depending on the music
hypothesis. An earlier draft made "does the palace actually help for music?"
the risk that could invalidate everything. With general castles as the
second step, that stops being load-bearing — general castles deliver value
on their own, and music becomes upside rather than the bet.

## 2. Where the chess actually lives

How hard this is turns on how deeply chess is woven into what would be
reused. Less deeply than expected. As of `BUILD_TAG -358`:

| Module | Lines | Domain coupling |
|---|---|---|
| `js/threeVR.js` | 9,435 | **Imports no chess code at all** — only `assets.js` and `objectLists.js` |
| `js/app.js` | 11,665 | The monolith: chess rules, castle generator, move table, imports, wiring |
| `js/assets.js` | 1,823 | Domain-neutral already |
| `js/objectLists.js` | 1,138 | Domain-neutral already (one shipped list is **Solfège**) |
| `js/db.js` | 831 | Mixed — see below |
| `js/engine.js` | 444 | Chess-only, cleanly isolated behind one class |

**The palace is already decoupled.** `openThreeTest` (`threeVR.js` ~8610)
consumes an opaque contract — rooms carrying a `posKey` identity string,
`exits`, `pairs`, `walls` — and never interprets it as chess. Two narrow
couplings only:

1. It reads the chess `mnemonics` store and expects atoms shaped
   `{to: <square>, piece: <name>}` — `getMnemonicsCached` (~3602) and
   `resolveMoveContent` (~3720), about six call sites.
2. It treats `posKey` as a FEN to draw the room-info mini board (~606).

**The generator is domain-neutral in substance.** `buildCastleGraph`,
`analyzeCastleStructure`, `buildGeneratedCastle` (`app.js` 1501, 2177, 1811)
are graph algorithms — run detection, corridor collapse, two-track packing —
wearing chess clothes.

**The stores split cleanly.** `assets`, `objectLists`, `meta` are neutral;
`games`, `analysisQueue`, `perfectOpeningQueue` are chess-only; `lines` and
`prefs` are structurally neutral but chess-named; `mnemonics` is
`keyPath:'square'` (`db.js` 62) — the one genuinely chess-shaped schema.

## 3. The unifying model: loci, windows, channels

### 3.1 The composite renderer is already generic

The move-pair billboard is a 768×768 canvas holding two 512×512 quadrants —
opponent pegged top-left, response pegged bottom-right, overlapping
diagonally (`threeVR.js` ~3516, ~3686). `drawMnemQuadrant(ctx, qx, qy,
content, beardImg)` takes already-neutral `{text, img}` content.

So **a chess move-pair is already a multi-channel composite image.** The only
chess-flavoured part is the assumption that there are exactly two channels
named *opponent* and *response*. A 2×2 grid for P/A/O/X is a layout change,
not an architectural one; a general castle's single object is the same
renderer with one channel.

### 3.2 PAO has two modes, and they need different machinery

Worth separating before building, because they bind loci to the sequence
differently:

- **Compression** — classic competitive PAO. Person from item 1, Action from
  item 2, Object from item 3, fused into one image. *Three items, one locus.*
  This is how card and number systems work.
- **Attribute channels** — one item decomposed into facets. For music:
  person = chord root, action = fingering, object = inversion.
  *One item, several channels.*

Chess is the first kind: a move-pair fuses two consecutive plies into one
locus. The music proposal is the second. Both are wanted eventually.

### 3.3 The model that covers all of it

> A **locus** binds to a **window of N items** and renders **C channels**.
> Each channel draws from *(item index within the window, facet of that
> item)*, resolved through a per-channel **dictionary**.

| Case | Window | Channels | Mapping | Facet |
|---|---|---|---|---|
| General factoid | 1 | 1 | channel ← item 0 | the item itself |
| Chess | 2 | 2 | channel *i* ← item *i* | (square, piece) |
| Classic PAO (cards, numbers) | 3 | 3 | channel *i* ← item *i* | role *i* |
| Music PAOX | 1 | 3–4 | all channels ← item 0 | root / fingering / inversion / timing |

One mechanism spans every case. This is the central abstraction of the whole
proposal.

### 3.4 Dictionaries mostly exist already

A dictionary maps a facet value → {word, image, sound}. That is the
`mnemonics` store generalized: today it maps square → per-piece word and
image, i.e. a two-level keyed lookup, which is exactly the shape needed.

`objectLists.js` is a *different* concept and stays as it is: named **ordered
lists** with per-item asset binding, used to skin room walls. Ordered list ≠
keyed dictionary; both are wanted.

Note the encouraging detail that the atom schemes are the same *shape* across
domains, so the mnemonic manager's grid editor generalizes rather than being
rewritten: chess is 64 squares × 6 pieces; music is 12 roots × ~8 qualities;
a PAO deck is 52 cards × 3 roles.

### 3.5 Ordering is a genuinely new concept

Chess order derives from the move tree; music order is the arrangement. But
general castles have an **arbitrary chosen sort key** — plays by date
written, states alphabetically or by size or by entry into the union. The app
has no such concept today.

Proposal: **an ordering is fixed per castle.** "States alphabetically" and
"states by size" are two castles sharing one item dictionary, not one castle
with a switchable view. Re-ordering re-routes the palace, and a re-routed
palace is a different palace as far as memory is concerned — so modelling it
as one castle would be actively misleading.

## 4. The domains

### 4.1 General — the base case

Ordered rooms, one object per locus, no branching, no engine, no audio. A
castle is an ordered set of items plus a dictionary binding each to an image.
Multi-facet items (a state's capital, rivers, cities) are either several
channels at one locus (§3.3) or several loci, which is an open question.

This is deliberately the *simplest* thing that is still genuinely useful, and
it is the step that proves the interface is honest.

### 4.2 Chess — what is actually specific

Branching, engine, and the square × piece encoding. Everything else it uses
is general. Its identity model is **state-keyed** (a position determines what
follows), which matters in §4.3.

### 4.3 Music

**The use case (from the user, not inferred).** Not performance — recalling
the palace in real time while playing is explicitly out of scope. The use
case is **mental review away from the instrument**: walking a song in the
mind while mowing the lawn or washing dishes, to stay in practice. Muscle
memory decays noticeably after about two weeks and produces stumbles on
individual chords. About 15 songs are memorized, of widely varying
complexity.

**This settles the drill question: it is a route, not a quiz.** Music does
not need the stimulus→response pair structure at all — it needs an ordered
sequence pegged to objects, i.e. exactly the Shakespeare's-plays case
`LinearSequencesAndRoomObjects.md` was written from. Memory palaces were
invented for linear speeches, so linearity is the native case here.

**Scale.** Sections — intro / verse / chorus / bridge / outro — ordered
differently per song, with multiple and sometimes varied verses and choruses:
roughly **5–10 rooms per song**, so ~100 rooms for 15 songs. Chess castles
already run to hundreds, so performance is a non-issue.

Complexity varies in *kind*, and both kinds must be supported:

- **"Your Song"** — ~17 distinct chords in the verse and a different ~17 in
  the chorus. Complexity is in the *chord vocabulary*.
- **"Edge of Seventeen"** — 3 chords, with complexity in *riffs, fills and
  inversions*. A model holding only chord symbols handles the first song and
  fails the second.

**Song form breaks state-keyed identity — use repeat rooms.** Verse 2 may be
musically identical to Verse 1 but exits to a bridge instead of a chorus.
Merging them gives one room two exits with no way to tell which applies.
There is also a hard technical objection: `processExit` dedups by position
and will not re-walk an existing node, so verse → chorus → verse → chorus
would produce a **cycle**, and `analyzeCastleStructure` assumes a DAG.
Merging would likely break the generator outright. It also violates the
one-locus-per-item principle.

So **each occurrence is its own room**, with repeats represented the way
notation already does it: a small room holding 𝄆 *as Verse 1* 𝄇. Variations
extend naturally — *as Verse 1, except the last two bars are …*. This is
adjacent to the existing redirect machinery but **not the same**: a redirect
removes the room and routes the door onward; a repeat room stays on the
route. Treat it as its own concept.

**Content model.** A wall holds ordered *musical events*: chord (+ optional
voicing/inversion), riff (a short note sequence — itself ordered, so a
corridor-within-a-room, which the object-chain machinery already handles),
and fill. In PAOX terms these are channels on one item (§3.3).

**Duration.** The user sidesteps it in their own practice — they follow their
mental audio, where changes are obvious — but wants the system more general
than one person's method. Resolution: **an optional modifier with no default
rendering.** Unset means nothing appears and nothing changes. The mnemonic
attaches to the atom alone, so Am-held-two-bars and Am-held-four-bars share
one word and image, as do a chord and its inversions.

Precedent exists: a chess move is an atom plus optional badges —
`moveQuality` glyphs, the move-number corner (`drawMoveNumberBadge`), the
disambiguator "beard" image. Two rendering options were considered:

- **A badge** (note-value glyph or number) — cheap, reuses existing
  machinery, does not disturb layout. **Preferred.**
- **Spacing** (a four-bar chord occupies four slots, so you walk further) —
  elegant, and fits the existing room-length-scales-with-run-length
  behaviour. But layout would depend on duration, so a later edit reflows the
  room — precisely what the memorized-room-stability work exists to prevent.
  Later, if at all.

**Audio — the genuinely new capability.** The room-info panel's chess mini
board becomes *click the room to hear a synth play its chords/notes*. Same
hook; the music version is the more useful of the two, since the mini board
shows a position you could already infer while the music preview delivers the
thing you are trying to recall.

*Synthesize rather than record.* Web Audio can generate a chord from its
symbol, so there is no need to capture 17 chords per song. This sidesteps the
asset pipeline (`assets.js` is built around image crop / webp / resolution
tiers, none of which transfers) and is *better* for pitch anchoring: a
synthesized C3 is identical every time, where a recording drifts with
instrument and tuning. Stored audio becomes a later refinement for what
synthesis cannot capture, such as a particular riff articulation.

Two playback modes:

- **On demand** (click a room) — for editing and spot-checking.
- **Play-through** — walk the route in order, sounding each room on entry.
  This is the training loop for the real use case, and what would transfer to
  reviewing a song mentally away from the app.

*Pitch anchoring.* A stated goal is building some semblance of absolute pitch
by associating specific sounds with specific chords — the user already uses
the C3–D3–E3 intro riff of "Edge of Seventeen" as a mental anchor. The app is
unusually well placed for this because it already has the image and word
halves; a consistent synthesized sound completes a three-way association.

**Lyrics.** Open. Recommendation: keep them **out of the palace initially** —
nodes already have a `note` field, so attaching a lyric line costs nothing
and does not compete for wall space. Lyrics are already linear and usually
memorized through singing; pegging them to objects risks crowding out the
thing that actually gets stumbled on, which is chords.

## 5. Alternatives considered

**A — Fork to a separate app (REPmusic, or one app per domain).** Fastest to
something usable, zero risk to chess, freedom to make a mess. But it
duplicates the two things that took longest and are already domain-neutral:
the palace, and the asset / object-list libraries. They diverge immediately,
every VR bug gets fixed twice, and **two origins means two IndexedDB
databases, hence two asset libraries maintained by hand.** "Converge later"
almost never happens, though an AI porting patches makes it less fatal than
usual.

Sizing argues against it. Under the general-first framing the per-domain
delta is even smaller than it looked: music adds a song model, audio synth,
repeat rooms and encodings — well under 2,000 lines — against roughly 12,000
lines of palace, assets and object lists reused. Forking 27,000 lines to add
2,000 is a bad trade, and it forks the dictionaries too.

**B — Launch-time mode switch (Chess / Music / General).** Rejected. Mode is
global state that need not exist, and it requires *the same internal
refactor* as C while delivering worse UX. Worst of both.

**C — Domain as an attribute of the castle/repertoire.** No mode picker. The
home screen lists repertoires — chess systems, songs, and general castles
together; opening one activates its domain module. Chess-only menu items
appear only for chess repertoires. **One palace holds everything** — a street
of chess castles beside a street of song castles beside the US-states castle
— which is truer to memory-palace practice and is a feature, not a
compromise. Assets and dictionaries are shared. **Recommended.**

**D — Full plugin packs.** The endgame, and cheap to reach *from* C: with no
build step a domain pack is just an ES module `import()`ed by id, so D is
mostly a registry plus packaging. Doing D first would mean designing the
interface while guessing, with only one real domain to guess from.

## 6. Recommended path

**C, staged, letting D fall out later.**

1. **Refactor chess into a domain module.** Pure refactor, chess still the
   only domain, behaviour identical. The existing test suite is the safety
   net, which is why this goes first.
2. **Plain general castle — one channel, one object per locus.**
   Deliberately trivial: no branching, no engine, no audio, no PAO. Its job
   is to *prove the interface is honest* while being cheap enough to throw
   away if it is not. This is the step that de-risks everything after it, and
   the one that would expose a bad interface designed in step 1.
3. **PAOX channels.** Generalize the pair renderer to N channels with
   per-channel dictionaries, and add the window model (§3.3).
4. **Music = PAOX + two additions:** synth/audio, and repeat rooms.
   Everything else falls out of steps 2 and 3.

Schema work lands across steps 1–3: `mnemonics` from `square`-keyed to
`(domain, dictionary, key)`-keyed, and a `domain` field on castles defaulting
to `'chess'`. Both need migrations, and **both touch the backup format** —
see `importBackup`/`applyBackupData`.

## 7. Interface sketch

Not committed to — what the conversation implies:

```
structure     buildRooms(repertoire) → genRooms[]   chess: graph walk · music: sections · general: ordered items
              nodeIdentity(path)                    chess: position key · music/general: occurrence-keyed
              ordering                              general: explicit sort key (§3.5)
loci          window()                              how many items one locus binds (§3.3)
              channels()                            how many images compose the locus
              facetOf(item, channel)                → dictionary key
dictionaries  dictionary(name) → key → {word,img,sound}    generalizes the mnemonics store
presentation  renderRoomPreview(room)               chess: mini board · music: chords + play
              resolveSlotContent(...)               replaces threeVR's direct mnemonic read
              badgesFor(item)                       chess: quality, disambig · music: duration, inversion
optional      audio · analysis engine · import sources · repertoire editor
```

The "optional" row is what makes forking unattractive: music does not
implement engine or import, chess does not implement audio, general
implements neither. Nobody carries anybody else's weight.

## 8. Open questions

1. **Multi-facet general items** — for the 50 states, is a state's capital /
   rivers / cities several channels at one locus, or several loci? (§4.1)
2. **One object per chord, or one per bar?** The user sidesteps this by
   following their mental audio; §4.3 proposes optional duration badges as
   the general answer, but it is unresolved for someone who does not hear the
   changes as obviously.
3. **Should a room play the chord, the individual notes, or both on demand?**
4. **Lyrics in the palace or in notes?** (§4.3 proposes notes.)
5. **How are riffs decomposed** — one object per note, or one object per riff
   with notes as a sub-sequence?
6. **Do repeat rooms need a structured "delta" model** for varied repeats, or
   is free text enough?
7. **Do general castles need branching at all?** Assumed not, but a decision
   tree ("if the patient presents X…") is a plausible general use case that
   would want it — and chess's branching machinery already exists.

## 9. What would invalidate this

- **If step 2 (the plain general castle) turns out to need interface changes
  that step 1 cannot accommodate**, the seams were drawn wrongly and step 1
  needs redoing. This is the main structural risk, and it is why step 2 is
  deliberately trivial and early.
- **If music disappoints**, steps 1–3 still stand on their own. This is the
  main gain from the general-first framing: music is no longer load-bearing.
- **If general castles want branching after all** (Q7), the domains become
  *more* alike rather than less, since the branching machinery already
  exists — a benign failure.
- **If duration turns out to be essential rather than optional**, §4.3's
  badge approach may be insufficient and layout-affecting spacing returns,
  with the memorized-room-stability conflict it brings.
