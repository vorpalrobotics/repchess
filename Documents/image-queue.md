# Image generation queue — design

**Status: agreed design, nothing built yet.**

Generation moves out of the one-at-a-time Generate dialog into a queue that
runs in the background. Finished images wait in a review list. Approving one
turns it into an asset and, when it was made for an object-list item, binds it
to that item.

It builds on existing pieces:
- the Generate dialog's model list, providers and settings (`js/assets.js`);
- the asset editor's save path and checks;
- the Analysis Queue's persisted, self-restarting model;
- object-list items' `assetId` binding.

## Decisions

| Question | Decision |
|---|---|
| Variants per job | **1.** Build the field, but default and offer only 1 for now. |
| Run while the VR walk is open | **Yes.** It is network work, not CPU work, and decorating while images arrive is the point. |
| Object-list prompts | Item name, plus a new optional per-item **Image instructions** field, plus the list's room context and the standing instructions. |
| Default asset type for list items | **Extruded (silhouette).** User did not choose; the default can be revised. |
| Unreviewed images in backups | **Excluded.** User did not choose; a restore discards them. |

## A job

One record per job in a new IDB store, `imageJobs`:

```json
{
  "id": "…", "createdAt": 0, "status": "queued",
  "prompt": "a brass clock",
  "standing": "flat cartoon style, …",
  "model": "runware:gpt-image-1-mini",
  "quality": "low", "size": "square", "transparent": true,
  "asset": { "id": "brass-clock", "type": "extruded", "keywords": "", "resolution": "normal" },
  "target": { "kind": "asset" },
  "result": { "image": "data:…", "cost": 0.005 },
  "error": null
}
```

- **`standing`** is a snapshot taken at queue time. Editing the standing
  instructions later must not change a batch that is already queued.
- **`status`** runs `queued` → `running` → `review` (awaiting approval), or
  `failed`. Approved and discarded jobs are deleted.
- **`target`** is `{ kind: 'asset' }` or
  `{ kind: 'objectListItem', listId, itemName }`. A later
  `{ kind: 'mnemonic', square, piece }` fits the same shape.
- **The asset type drives generation defaults:**
  - props: transparent, square;
  - surfaces: opaque, square;
  - facades: opaque, landscape.

## Running

- **Starts by itself**, like the Analysis Queue: no start button, and it
  resumes after a reload. A job left `running` by a closed tab goes back to
  `queued`.
- **Two jobs in flight at once**, through the existing provider functions
  (`generateOpenAI` / `generateRunware`), which need lifting out of the
  dialog's closure.
- **Failures:**
  - One automatic retry on a transient failure.
  - After that, the job is `failed`, keeps its error, and gets a Retry button.
  - A missing API key pauses the queue with a message, rather than failing
    every job.
- **Cost:**
  - A running total is shown, taken from the costs the providers report.
  - Queuing a large batch asks for confirmation first, naming the image count,
    model and quality.

## Entry points

1. **Generate dialog:** an **Add to queue** button beside Generate. The job
   takes the asset ID, type and keywords from the editor that opened it.
2. **Batch entry** (Image Queue → New batch): pick the model and settings once,
   then enter one subject per line. IDs are slugged from each line and can be
   edited before queuing or at review.
3. **Object lists:** **Generate missing images…** in the Object List Manager
   queues one job per item with no `assetId`.
   - A prompt template is shown for editing first. The default:
     `{item}. {imageInstructions}. From a {roomName}.` plus the standing
     instructions.
   - IDs default to `{list}-{item}`.

## Review

The **Image Queue** modal (hamburger menu) has two tabs: **Queue** and
**Review**. The Review tab carries a count badge. Each finished image offers:

- **Approve:** opens the normal asset editor pre-filled with the image, ID,
  type and keywords. Save goes through every existing check, including ID
  collisions.
- **Quick approve:** saves directly when the details are already valid.
- **Redo:** re-queues the job, optionally with an edited prompt.
- **Discard.**

Approving an `objectListItem` job also sets that item's `assetId`.

## The new object-list field

Add an optional `imagePrompt` string to each list item, shown in the editor as
**Image instructions**.

**Watch the rebuild sites.** Both of these construct items from
`{ name, assetId }` only, so the field would be silently dropped unless it is
added at each:
- the list editor's save (`js/objectLists.js`, `setObjectList` call);
- JSON import (`js/objectLists.js`, the `shaped` item builder).

This is the same class of bug that once dropped `story` from the Attributes
save.

**Backups:** full backup and restore copy object lists whole. There is a
backup drift test (see `Documents/backup-coverage.md`); extend it to cover the
new field.

## Phases

1. **Queue and review:** the job store and runner, the Image Queue modal, Add
   to queue from the Generate dialog, and Approve through the editor.
2. **Faster review and batches:** batch entry and Quick approve.
3. **Object lists:** the `imagePrompt` field, Generate missing images…, and
   bind-on-approve.
4. **Later:**
   - variants (more than 1);
   - generating missing move images for a castle's coverage;
   - queuing from a slot inside the VR walk.
