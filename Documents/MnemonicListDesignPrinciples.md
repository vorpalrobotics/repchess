# Mnemonic List Design Principles

**Version 1.1** — revised for the repchess castle context

---

## Context: what this document is about

Each castle room holds **objects** — physical props placed in the virtual room
(refrigerator, sink, countertop, ...). Each object is the mnemonic anchor for
one **move-pair** (opponent move + our response). When a room holds N move-pairs,
the user sees N objects and must recall which object maps to which move-pair.

The core challenge is **order**: the user needs to know that the refrigerator is
move-pair 1, the sink is move-pair 2, and so on. If that ordering must be
memorized separately, it adds cognitive load on top of an already-dense task.

This document defines principles for choosing and ordering those objects so that
the **ordering is self-recovering** — derivable from the objects' real-world
relationships rather than from rote memorization.

This matters most for **long forced lines** (runs): chains of 4–7 positions
where every move is essentially forced. A single room can host such a run along
one or both walls, with each object pinned to a specific move-pair by position.
If the object list follows a culturally known order (planets, musical notes,
days of the week), the user can reconstruct the sequence without separately
memorizing "object 3 is Earth."

---

## Goals

- Maximize long-term recall of move-pair order.
- Minimize rote memorization of which object = which position.
- Use existing cultural knowledge whenever possible.
- Create multiple independent retrieval paths for every sequence.

---

## Core philosophy: 7 independent retrieval paths

Ideally, a user can reconstruct the full move sequence through any of these
independently:

| # | Cue | Example |
|---|---|---|
| 1 | Environment (room theme) | "This is the kitchen" |
| 2 | Object category | "Kitchen objects, in workflow order" |
| 3 | Natural ordering rule | "Storage → prep → cook → clean" |
| 4 | Mnemonic phrase | "Chefs Often Refrigerate Delicious Soups" |
| 5 | Phonetic reinforcement | "Often" sounds like "Oven" |
| 6 | Semantic reinforcement | "Chefs" evokes cooking context |
| 7 | Vivid visual imagery | The specific scene placed in the room |

If you have all 7, losing any one doesn't break recall. If you only have the
mnemonic phrase, one forgotten word loses the whole sequence.

**Design target:** always have cues 1–3 plus at least one of 4–6 before you
accept a category for a room.

---

## Hierarchy of ordering mechanisms

When choosing how to order a room's objects, prefer the highest tier available:

1. **Existing cultural mnemonic** — a well-known phrase or acronym already in
   common use (planets, rainbow, musical scale). Strongest because the ordering
   is already in long-term memory.
2. **Adapted cultural mnemonic** — a familiar phrase lightly modified to cover
   the category. E.g., "Basic Original Parsley, Sage, Rosemary, Thyme" adapts
   the Simon & Garfunkel lyric to cover Basil and Oregano.
3. **Canonical sequence** — a fixed cultural sequence without a popular acronym:
   months of the year, days of the week, the periodic table, taxonomic ranks.
4. **Strong natural ordering** — an objective ordering rule inherent to the
   objects: size, weight, age, brightness, temperature, hardness,
   chronological, alphabetical.
5. **Generated mnemonic** — when none of the above fits, invent a phrase whose
   initials match the objects in a defensible order.

---

## Natural ordering rules (by strength)

### Very strong
Alphabetical · Numerical · Chronological · Size · Weight · Height · Distance ·
Age · Brightness · Temperature · Hardness

### Scientific
Taxonomic hierarchy · Evolutionary progression · Life cycle stages ·
Geological timeline · Astronomical distance · Atomic number

### Procedural
Recipe / cooking steps · Airport passenger journey · Laundry process ·
Manufacturing / assembly sequence · Medical procedure

### Functional
Complexity · Value · Frequency of use · Capacity · Speed · Power

### Weak (use only if nothing stronger exists)
Left-to-right · Front-to-back · Clockwise · Walking path · Top-to-bottom

Spatial orderings are the weakest: they are arbitrary from the user's
perspective and provide no retrieval path other than "I chose this direction."

---

## Design rules

1. **Never weaken a strong ordering to improve initials.** The category order
   takes precedence over mnemonic cleverness. Do not rearrange
   Mercury–Venus–Earth–Mars to improve the acronym.

2. **Canonical sequences must never be reordered.** Planets, rainbow colors,
   musical notes, and similar sequences are canonical and culturally fixed.
   Accept the acronym they produce; do not sort for convenience.

3. **Only optimize initials when the ordering is naturally flexible.** If the
   natural ordering is "large to small" and there are ties, breaking ties on
   initial is acceptable. If there are no ties, it is not.

4. **Prefer culturally familiar sequences over invented ones.** A generated
   mnemonic requires the user to also remember the phrase. A cultural sequence
   (the planets, the musical scale) is already in memory.

5. **Match category length to sequence length.** A category that maps to exactly
   N objects avoids having to remember which N of K items you used. For a
   5-move run, pick a 5-object category.

---

## Category selection by sequence length

When choosing a category for a run of N move-pairs, prefer a culturally ordered
set that has exactly N members:

| N | Candidate categories |
|---|---|
| 7 | Do–Re–Mi–Fa–Sol–La–Ti; days of the week; deadly sins; Snow White's dwarfs |
| 8 | Planets (My Very Educated Mother Just Served Us Nachos); musical notes A–G + octave |
| 6 | Six wives of Henry VIII; beer flight stages; faces of a die |
| 5 | Senses; fingers; Great Lakes (HOMES) |
| 4 | Seasons; cardinal directions; playing card suits; golf majors |
| 3 | Traffic light colors; gold/silver/bronze; past/present/future |
| 2 | Salt & pepper; lock & key; hammer & nail |

A category with a well-known existing mnemonic (tier 1) is preferred over a
canonical sequence of the same length.

---

## Worked examples

### Kitchen (procedural ordering: food workflow)

Objects: Countertop, Oven, Refrigerator, Dishwasher, Sink

Ordering rule: **Procedural — food lifecycle** (store → prep → cook → serve →
clean). Even without a mnemonic, the ordering is recoverable from how a kitchen
actually works.

Mnemonic: **"Chefs Often Refrigerate Delicious Soups."**

> Phonetic reinforcement: "Often" → Oven; "Refrigerate" → Refrigerator.

---

### Herb garden (adapted cultural mnemonic: Simon & Garfunkel)

Objects: Basil, Oregano, Parsley, Sage, Rosemary, Thyme

Ordering rule: **Adapted existing song** — "Scarborough Fair" already fixes
Parsley, Sage, Rosemary, Thyme in cultural memory; the first two are prepended.

Mnemonic: **"Basic Original Parsley, Sage, Rosemary, Thyme."**

> "Basic" phonetically reinforces Basil; "Original" phonetically reinforces
> Oregano. The rest is verbatim from the lyric.

Note: the Basil/Oregano order is not canonical — it was chosen to fit the
adapted phrase. This is acceptable because the pair (Basil, Oregano) has no
intrinsic ordering; adding them before the Scarborough Fair sequence is the
minimal adaptation.

---

## Phonetic reinforcement

Prefer mnemonic words that share sounds (not just initials) with the target
object. This creates a second, sound-based retrieval path from phrase to object.

| Mnemonic word | Target object |
|---|---|
| Basic | Basil |
| Original | Oregano |
| Often | Oven |
| Refrigerate | Refrigerator |

When generating a mnemonic phrase, try to satisfy phonetic reinforcement before
settling for initial-only.

---

## JSON schema for mnemonic metadata

Each room's mnemonic data should be stored with enough structure to identify
which retrieval paths are present:

```json
{
  "category": "Kitchen appliances",
  "ordering_rule": "procedural: food lifecycle (store → prep → cook → serve → clean)",
  "ordering_tier": 3,
  "objects": ["Refrigerator", "Countertop", "Oven", "Dishwasher", "Sink"],
  "mnemonic": {
    "type": "generated_phrase",
    "initialism": "RODS",
    "phrase": "Chefs Often Refrigerate Delicious Soups",
    "source": null
  }
}
```

`type` values: `existing_phrase` · `adapted_existing_phrase` · `existing_song` ·
`generated_phrase`

`ordering_tier` values: 1 = existing cultural mnemonic · 2 = adapted cultural ·
3 = canonical sequence · 4 = strong natural ordering · 5 = generated mnemonic

---

## Guiding principle

> **Do not optimize one retrieval cue at the expense of a stronger one.**

Canonical order takes precedence over a clever acronym. Existing cultural
knowledge takes precedence over a freshly invented phrase. The ordering rule
is the foundation; the mnemonic phrase is a supplement.
