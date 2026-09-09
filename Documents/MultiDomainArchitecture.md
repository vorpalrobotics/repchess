# Multi-Domain Architecture — Design Discussion

Status: **nothing here is built.** This is the record of a design
conversation about extending the app beyond chess — specifically to music
(memorizing chord progressions, riffs and fills for songs) — and, in the
longer run, to other memorization domains entirely. It exists so the
thinking survives the conversation. No code has been written, no interface
has been committed to, and the recommendation below is a recommendation, not
a decision.

Read alongside `CastleDataModel.md` (room identity and persistence) and
`LinearSequencesAndRoomObjects.md` (runs, two-track rooms, and the
move-pair ↔ object association) — the music case leans almost entirely on
the machinery those two describe.

---

## 1. Why this is plausible: where the chess actually lives

The question "how hard is this?" turns on how deeply chess is woven into the
parts that would be reused. It is less deep than expected. Findings, as of
`BUILD_TAG -358`:

| Module | Lines | Domain coupling |
|---|---|---|
| `js/threeVR.js` | 9,435 | **Imports no chess code at all** — only `assets.js` and `objectLists.js` |
| `js/app.js` | 11,665 | The monolith: chess rules, the castle generator, move table, imports, wiring |
| `js/assets.js` | 1,823 | Domain-neutral already |
| `js/objectLists.js` | 1,138 | Domain-neutral already (one shipped list is **Solfège**) |
| `js/db.js` | 831 | Mixed — see below |
| `js/engine.js` | 444 | Chess-only, but cleanly isolated behind one class |

**The palace is already decoupled.** `openThreeTest` (`threeVR.js` ~8610)
consumes an opaque contract — rooms carrying a `posKey` identity string,
`exits`, `pairs`, `walls` — and never interprets it as chess. It has exactly
two chess couplings, both narrow:

1. It reads the chess `mnemonics` store directly and expects move atoms
   shaped `{to: <square>, piece: <name>}` — `getMnemonicsCached` (~3602) and
   `resolveMoveContent` (~3720), roughly six call sites.
2. It treats `posKey` as a FEN to draw the room-info mini board (~606).

**The generator is domain-neutral in substance.** `buildCastleGraph`,
`analyzeCastleStructure` and `buildGeneratedCastle` (`app.js` 1501, 2177,
1811) are graph algorithms — run detection, corridor collapse, two-track
packing — wearing chess clothes.

**The stores split cleanly.** `assets`, `objectLists` and `meta` are neutral;
`games`, `analysisQueue` and `perfectOpeningQueue` are chess-only; `lines`
and `prefs` are structurally neutral but chess-named; `mnemonics` is
`keyPath:'square'` (`db.js` 62) and is the one genuinely chess-shaped schema.

So the expensive, distinctive, hard-to-rebuild machinery — the palace, the
asset library, the object lists, the layout algorithms — is already neutral
or neutral-in-substance. What is chess-specific is the rules layer, the
engine, the import sources, and the mnemonic atom scheme.

## 2. What the app is, with the chess taken out

> A spatial memorization system for **stimulus → response sequences**.
> Nodes are reached by a sequence of steps and carry an **identity**, so
> different orders reaching the same place can merge. Each node holds the
> response being drilled. Un-branching runs collapse into corridors, branch
> points become rooms, and the whole becomes a walkable palace. Each step
> decomposes into **atoms** that map to memorable words and images.

Chess supplies six things: step = SAN move; identity = position key;
atoms = (destination square, piece); branching = opponent replies;
corpus = Lichess/chess.com; oracle = Stockfish. That list is the domain
interface, and it is smaller than the codebase suggests.

## 3. The music domain

### 3.1 The actual use case (from the user, not inferred)

Not performance. The user does not need to recall the palace in real time
while playing, and explicitly rules that out as a design constraint.

The use case is **mental review away from the instrument** — walking a song
in the mind while mowing the lawn or washing dishes, to stay in practice.
Today the user relies on muscle memory, which decays noticeably after about
two weeks and produces stumbles on individual chords. About 15 songs are
memorized, varying widely in complexity.

**This settles the biggest open question: the drill is a route, not a quiz.**
Music therefore does *not* need the (opponent move → my reply) pair
structure. It needs the simpler path through the existing machinery — an
ordered sequence of items pegged to objects along a wall, i.e. exactly the
Shakespeare's-plays case `LinearSequencesAndRoomObjects.md` was written from.

Memory palaces were invented for linear speeches, so linearity is the
native case here, not a compromise.

### 3.2 Scale

Popular songs have sections — intro / verse / chorus / bridge / outro —
ordered differently per song, with multiple verses and sometimes varied
choruses. That is roughly **5–10 rooms per song**, so 15 songs is on the
order of 100 rooms. Chess castles already run to hundreds, so performance is
a non-issue for this domain.

Complexity varies in *kind*, not just amount, and both kinds matter:

- **"Your Song" (Elton John)** — ~17 distinct chords in the verse and a
  different ~17 in the chorus. Complexity is in the *chord vocabulary*.
- **"Edge of Seventeen"** — 3 chords, with the complexity in *riffs, fills
  and inversions* used to create variety.

A model that only holds chord symbols handles the first song and fails the
second.

### 3.3 Song form breaks the identity model — use repeat rooms

This is the one genuinely new architectural problem.

Chess identity is **state-keyed**: the position determines what follows, so
two paths reaching the same position *should* merge. Song form is not
state-keyed. Verse 2 may be musically identical to Verse 1 but exits to a
bridge instead of a chorus. Merging them gives one room two exits with no way
to tell which applies.

There is also a hard technical objection: `processExit` dedups by position
and will not re-walk an existing node, so verse → chorus → verse → chorus
would produce a **cycle**, and `analyzeCastleStructure` assumes a DAG.
Modelling repeats as revisits would likely break the generator outright.

And it violates a core memory-palace principle — one locus per item, so that
recall never collides.

**Proposal: each occurrence is its own room on the route**, even when
musically identical, with repeats represented the way music notation already
represents them. A repeat room is small and holds one thing: 𝄆 *as Verse 1* 𝄇.
You walk in, recall Verse 1, walk out. Variations extend naturally —
*as Verse 1, except the last two bars are …* — which is how a musician would
describe it to another player anyway.

This is adjacent to the existing redirect machinery but **not the same
thing**: a redirect removes the room and routes the door onward, whereas a
repeat room stays on the route. Treat it as its own concept rather than
bending redirects to fit.

### 3.4 Content model

A room's wall holds an ordered sequence of **musical events**, not chord
symbols:

- **chord** + optional voicing/inversion
- **riff** — a short note sequence; itself ordered, so a corridor-within-a-
  room, which the existing object-chain machinery already handles
- **fill** — the same, at a transition

**Atoms and modifiers.** The mnemonic attaches to the atom alone; everything
else is a badge. So Am-held-two-bars and Am-held-four-bars share one word and
one image, as do Am and its inversions.

**Duration.** The user sidesteps duration entirely in their own practice —
they follow their mental audio, where chord changes are obvious — but wants
the system to be more general than one person's method. Resolution:
**duration is an optional modifier with no default rendering.** Unset means
nothing appears and nothing changes.

There is existing precedent for exactly this shape: a chess move is an atom
plus optional badges — `moveQuality` glyphs, the move-number corner
(`drawMoveNumberBadge`), and the disambiguator "beard" image. Duration is the
same pattern.

Two rendering options were considered:

- **A badge** (note-value glyph or a number on the object) — cheap, reuses
  existing machinery, does not disturb layout. Preferred.
- **Spacing** (a four-bar chord occupies four slots, so you walk further) —
  more elegant, since walking pace maps to musical pace, and it fits the
  existing behaviour where room length scales with run length. But it makes
  layout depend on duration, so a later edit reflows the room — precisely
  what the memorized-room-stability work exists to prevent. Later, if at all.

### 3.5 Atoms generalize better than expected

Chess atoms are (destination square × piece) — 64 × 6. Music's natural atoms
are **(chord root × quality)** — 12 × ~8. The same *shape*: a 2-D grid of
(primary, secondary) → {word, image, sound}. The mnemonic manager's grid
editor therefore generalizes rather than needing a rewrite, which is a much
better outcome than the `square`-keyed schema suggested.

Riff notes need a second, smaller scheme — 12 pitch classes × octave.

### 3.6 Audio — the genuinely new capability

The room-info panel's chess mini board becomes, in music, **click the room
to hear a synth play its chords/notes**. Same hook, and the music version is
strictly the more useful of the two: the mini board shows a position you
could already infer, while the music preview delivers the thing you are
actually trying to recall.

**Synthesize rather than record.** Web Audio can generate a chord from its
symbol, so there is no need to capture 17 chords for one song. This sidesteps
the asset pipeline entirely (`assets.js` is built around image crop / webp /
resolution tiers, none of which transfers) and is *better* for pitch
anchoring: a synthesized C3 is identical every time, where a recording drifts
with instrument and tuning. Stored audio assets become a later refinement for
what synthesis cannot capture — a particular riff articulation, say.

Two playback modes, serving different purposes:

- **On demand** (click a room) — for editing and spot-checking.
- **Play-through** — walk the route in order, sounding each room on entry.
  This is the training loop for the actual use case: it builds the
  sound ↔ image ↔ name association by repetition, and it is what would
  transfer to reviewing a song mentally away from the app.

**Pitch anchoring.** A stated goal is associating specific sounds with
specific chords to build some semblance of absolute pitch — the user already
uses the C3–D3–E3 intro riff of "Edge of Seventeen" as a mental pitch anchor.
The app is unusually well suited to this because it already has the image and
word halves of the association built; adding a consistent synthesized sound
completes a three-way association, which is close to how pitch training
actually works.

### 3.7 Lyrics

Open. Recommendation is to keep them **out of the palace initially**: nodes
already have a `note` field, so attaching a lyric line costs nothing and does
not compete for wall space. Lyrics are already linear, and most players have
them memorized through singing; pegging them to objects risks crowding out
the thing that actually gets stumbled on, which is chords.

## 4. Alternatives considered

**A — Fork to a separate REPmusic app.** Fastest to something usable, zero
risk to chess, freedom to make a mess. But it duplicates the two things that
took longest and are already domain-neutral: the palace, and the asset /
object-list libraries. They diverge immediately, every VR bug gets fixed
twice, and — concretely — **two origins means two IndexedDB databases, hence
two asset libraries to maintain by hand.** "Converge later" almost never
happens, though an AI porting patches makes it less fatal than usual.

Sizing argues against it: the music-specific pieces are a song model, a
linear song → rooms generator, a chord-grid atom scheme, a song editor and
audio synthesis — call it 1,500–2,500 lines — against roughly 12,000 lines
of palace, assets and object lists being reused. Forking 27,000 lines to add
2,000 is a bad trade.

**B — Launch-time mode switch (Chess / Music / …).** Rejected. Mode is global
state that does not need to exist, and this option requires *the same
internal refactor as C* while delivering worse UX. Worst of both.

**C — Domain as an attribute of the repertoire.** No mode picker. The home
screen lists repertoires — chess systems and songs together; opening one
activates its domain module. Chess-only menu items (Import Games, Analysis,
Perfect Opening) appear only for chess repertoires. **One palace holds
everything** — a street of chess castles beside a street of song castles,
which is truer to memory-palace practice and is a feature rather than a
compromise. Assets and object lists are shared. The cost is the real
refactor. **Recommended.**

**D — Full plugin packs.** The endgame, and cheap to reach *from* C: with no
build step, a domain pack is just an ES module `import()`ed by id, so D is
mostly a registry plus packaging. Doing D first would mean designing the
interface while guessing at it with only one real domain.

## 5. Recommended path

**C, staged, letting D fall out later.**

1. **Refactor with no music at all.** Extract `domains/chess.js` from
   `app.js` behind an explicit interface, chess still the only domain,
   behaviour identical. The existing test suite is the safety net, which is
   exactly why this goes first.
2. **Invert the mnemonic coupling.** Stop letting `threeVR.js` read the chess
   store; have the domain hand it pre-resolved `{word, image}` per slot. Six
   call sites through `resolveMoveContent` — the only real coupling in the
   palace.
3. **Generalize two schemas.** `mnemonics` from `square`-keyed to
   `(domain, atomId)`-keyed; add `domain` to `lines`, defaulting to
   `'chess'`. Both need migrations, and **both touch the backup format** —
   see `importBackup`/`applyBackupData`.
4. **Add music minimally.** Hand-entered songs, sections as rooms, chords as
   wall objects, repeat rooms, a 12 × 8 chord mnemonic grid, synthesized
   playback. No engine, no import, no lyrics.

## 6. Interface sketch

Not committed to — a sketch of what the conversation implies:

```
structure     buildRooms(repertoire) → genRooms[]    chess: graph walk · music: sections in order
              nodeIdentity(path)                     chess: position key · music: occurrence-keyed
atoms         atomGrid()                             chess: 64 squares × 6 pieces · music: 12 roots × ~8 qualities
              atomOf(step) → {primary, secondary}    drives mnemonic lookup
              badgesFor(step)                        chess: quality, disambig · music: duration, inversion
presentation  renderRoomPreview(room)                chess: mini board · music: chords + play control
              resolveSlotContent(step) → {word,img}  replaces threeVR's direct mnemonic read
optional      audio · analysis engine · import sources · repertoire editor
```

The "optional" row is what makes the fork unattractive: music simply does not
implement engine or import, and chess does not implement audio. Neither
carries the other's weight.

## 7. Open questions

1. **Does the palace actually help?** The whole premise is untested for
   music. Before any refactor, build the palace for **one** song the user is
   genuinely shaky on after two weeks, and check whether the mental
   walkthrough holds up while doing the dishes. Cheap to run, and it can
   invalidate everything below it.
2. **One object per chord, or one per bar?** The user sidesteps this by
   following their mental audio. §3.4 proposes optional duration badges as
   the general answer, but this is unresolved for a user who does not hear
   the changes as obviously.
3. **Should the room play the chord, the individual notes, or both on
   demand?**
4. **Lyrics in the palace or in notes?** (§3.7 proposes notes.)
5. **How are riffs decomposed** — one object per note, or one object per riff
   with the notes as a sub-sequence?
6. **Do repeat rooms need their own "delta" model** for varied repeats, or is
   a free-text note enough?

## 8. What would invalidate this

- If the one-song prototype (Q1) shows the palace does not aid mental review,
  none of the rest matters.
- If music turns out to want branching after all (alternate arrangements,
  improvised variations as first-class), the "music is linear" premise
  weakens and the generator's branching machinery becomes relevant again —
  which would make the domains *more* alike, not less, so this is a benign
  failure.
- If duration turns out to be essential rather than optional, §3.4's badge
  approach may not be enough and layout-affecting spacing comes back on the
  table, with the memorized-room-stability conflict it brings.
