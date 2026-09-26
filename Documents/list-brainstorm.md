# Object list brainstorm: design

**Status: phase 1 built.** The code is `js/listBrainstorm.js`, with
`runwareText` in `js/imageQueue.js`. Tests 505–511 are in phase LB. Phases 2
and 3 are not started.

## What it is

In a **new** list's editor, **Brainstorm with AI…**:

1. You describe the list you want.
2. A model on Runware suggests three candidate lists in the object-list shape.
3. **Refine** continues the conversation with your feedback.
4. **Use this** fills the editor. The ordinary Save, with every check it
   makes, creates the list.
5. Saving a brainstormed list offers to queue its images (`openImageQueueForList`).

## Decisions

| Question | Decision |
|---|---|
| Provider | **Runware**: the same key and WebSocket session as image generation (`textInference`). |
| Default model | **The cheaper one**, Claude Haiku 4.5. This is not a demanding task. Sonnet 4.6 and "Other model…" (any Runware model ID) are also offered. |
| Review | **Inside the dialog.** Candidates live only while it is open, and closing with unused ones asks first. |
| Candidates per brainstorm | **3.** |

### Model IDs

Runware names Claude models `anthropic:claude@…`; seen examples include
`anthropic:claude@opus-4.8` and `anthropic:claude@fable-5`. The two listed IDs,
`anthropic:claude@haiku-4.5` and `anthropic:claude@sonnet-4.6`, follow that
pattern but were **not verified** against Runware's model pages, which are
blocked from the development sandbox.

If one is wrong, Runware's own error message is shown, and "Other model…"
takes the correct ID.

## Getting output the app can use

1. **Standing instructions.**
   - **Principles.** The system prompt is a condensed
     `MnemonicListDesignPrinciples.md`: the ordering-tier hierarchy and the
     design rules.
   - **Vocabularies.** It lists the app's ordering and mnemonic keys.
   - **Output contract.** It gives the exact JSON shape and says "JSON only".
2. **Structured output where supported.** `outputFormat: 'JSON'` plus
   `jsonSchema` (the OpenAI-style envelope `{name, schema, strict}`). The two
   type fields are schema enums.

   If a model refuses the schema, `runwareText` repeats the request without
   it. This is the same fallback shape as refused native transparency for
   images.
3. **Forgiving parsing, strict checking.**
   - **Parsing:** `extractJson` strips code fences and surrounding prose.
   - **Unusable candidates** (dropped): an unknown ordering type, fewer than
     two items, or no name.
   - **Warnings** (kept with the candidate): a duplicate item (left out), a
     length outside the requested range, or a name that clashes with an
     existing list.
4. **One repair round.** If no candidate is usable, the specific problems are
   sent back in the same conversation ("Reply with the corrected JSON only").
   If it is still unusable, the failure is shown **with the raw reply**, so
   nothing paid for disappears silently.

   A `finishReason` of `length` is reported as a cut-off reply rather than
   repaired.

Each response's reported `cost` is summed and shown.

**Where the parameters go (fixed in build -459).** The first release sent
`systemPrompt`, `maxTokens` and `jsonSchema` at the top level of the task.
Runware refused that in real use: "Unsupported use of 'maxTokens' parameter.
This parameter is not supported for text inference."

- **The fix:** technical parameters go inside `settings`, and only
  `outputFormat` stays at the top level.
- **Retry without optional extras:** if Runware still refuses an optional
  parameter it names (`maxTokens`, `jsonSchema` or `outputFormat`, or
  `includeCost`), `runwareText` drops just that one and retries.
- **Test guard:** the test fake now enforces the `settings` rule with
  Runware's exact error text. The original fake accepted anything, which is
  why the tests did not catch this.

## Module boundaries

- **Imports.** `listBrainstorm.js` imports only `modalBar.js`.
  `objectLists.js`, its only importer, hands in its dependencies: `runwareText`
  and the Runware key's storage name (both re-exported through `assets.js`),
  the ordering and mnemonic vocabularies, existing list names, and the
  `onUse` callback.
- **Layering.** The dialog's z-index is 95. That puts it above the Object
  List Manager (30), its standalone New List modal (72) and the Image Queue
  (90).
- **Using a candidate.**
  - It sets `EDIT_FROM_BRAINSTORM`.
  - The list ID comes from the name, unique among existing lists.
  - Items go through `shapeItem`, so Image instructions carry over.
  - `mnemonic.source` is set to "AI brainstorm".
  - Save's image offer covers the items that have no image.

## Phases

1. **Core** (built): the dialog, the Runware text call, checking and repair,
   Refine, Use this, and the offer to queue images.
2. **Saved ideas and castle batches.**
   - A **List ideas** review list, persisted like the image queue and
     excluded from backups.
   - **Brainstorm for a castle**: several lists, one per room, deduplicated
     against existing lists.
3. **Extras.**
   - **Improve this list** on an existing list, with the changes shown as a
     diff.
   - Generating Image instructions for items that have none.
