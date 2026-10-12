# Trash and Undo

What happens when a person deletes something in the AMS, what can be put back, and what is deliberately not deletable.
Decision: [DEC-026](/DECISIONS.md#DEC-026). Task: [TASK-062](/TASKS.md#TASK-062).

## The idea in four lines

- **Delete is a snapshot, not a flag.** The rows are really deleted from their own tables (no `deleted_at` anywhere, no
  query changed). In the same transaction, through the same five-step chain, a `trash_item` row keeps them: the rows of
  the deleted subtree with their dependents, as stored, with their original ids.
- **30 days.** `TRASH_RETENTION_DAYS` (`packages/shared/src/trash.ts`). The Trash page shows "N days left". A daily
  pg-boss job in the general `worker` service removes expired rows and the stored files they name.
- **One action, one group.** Everything one action deleted shares a `group_id`; Restore and Undo bring the group back
  together, all or nothing.
- **Undo is a descriptor.** Every reversible action answers with an `X-Undo` header saying how to take it back; the web
  client turns it into a toast and Ctrl/Cmd+Z.

## Inventory of delete paths

Every way a person can delete something today, and whether it goes through the Trash.

| Delete path | Service / route | Trash | What is kept (and how it comes back) |
|---|---|---|---|
| A requirement (standard, sub-standard) | `deleteRequirement`, `DELETE /api/requirements/{id}` | Yes, kind `requirement` | The whole subtree (sub-items), their notes, and the links to the institution's standards that name a code that goes with them. Restore puts the subtree back with the same ids. |
| Several requirements / multi-select | `deleteMany`, `POST /api/requirements/delete` | Yes, one group | One Trash item per selected top-level requirement. An id inside another selected id's subtree is not counted twice. |
| All requirements of a version ("Delete all standards in this version") | `deleteAllRequirements`, `POST /api/framework-versions/{id}/requirements/delete-all` | Yes, ONE item | Draft or in-review version only. |
| Merge a requirement into another | `mergeRequirement` | Yes, kind `requirement` | The merged-away requirement; Undo also moves its sub-items and notes back and restores the target's wording. |
| Split a requirement | `splitRequirement` | Undo only | Undo (`/unsplit`) puts the original's text back and sends the split-out requirement to the Trash. |
| A note | `deleteNote`, `DELETE /api/notes/{id}` | Yes, kind `note` | |
| A source document | `deleteSourceDocument`, `DELETE /api/source-documents/{id}` | Yes, kind `source_document` | The document, its pages and the analysis's proposals that cite it. **The original file stays in storage** until the item leaves the Trash. Still refused while a requirement, note or template cites it. |
| One source page | `deleteSourcePage` | Yes, kind `source_page` | |
| A report template | `deleteReportTemplate` | Yes, kind `report_template` | |
| A whole version (draft or in review) | `deleteVersion`, `DELETE /api/framework-versions/{id}` | Yes, kind `framework_version` | Requirements, notes, sources and pages, templates, analysis runs and proposals, the dismissals, and the file keys. Comes back as a draft. New: there was no way to delete a version before. |
| A whole external standard | `deleteFramework`, `DELETE /api/frameworks/{id}` | Yes, kind `framework` | The standard with all its versions (all must be drafts or in review), its links and its glossary aliases. The accreditor stays. |
| A link between an external and an internal requirement | `deleteMapping` | Yes, kind `mapping` | |
| An evidence link | `removeLink` | Yes, kind `evidence_link` | The link only; the evidence itself is never deleted. |
| A milestone the lead added | `deleteMilestone` | Yes, kind `milestone` | |

### Deliberately not covered

| What | Why |
|---|---|
| `audit_event` | Append-only by trigger. Never deletable, by anyone. |
| A published or retired framework version and everything in it | Frozen by trigger (`enforce_version_not_frozen`, `enforce_version_lifecycle`). Delete is refused; restore into one is refused too. |
| `accreditation_status` history, submission snapshots | Immutable by trigger (official status, DEC-005). |
| Evidence items, versions and files, dataset rows and answers | There is no delete path for them (they are retained as records); only an evidence *link* can be removed. |
| An engagement | Cannot be deleted (a database rule); it is withdrawn or closed. |
| Org units, programs, people | No delete path exists (they are made inactive). |
| An AI account | It holds an encrypted credential. Credentials are never copied into a snapshot. It keeps its own in-app confirmation. |
| Removing a member from an engagement, role assignments | Access control, not content. Adding the person back is an explicit grant. |
| Evidence requests (cancel), public form links (turn off, new link) | Status changes and security revocations, not deletions. A cancelled request stays visible. A revoked link must stay revoked. |
| Milestones removed by accepting a reviewed template update | The update is the reviewed action; re-running the next update brings them back. |
| An accreditor's logo | Replaced by uploading again. |
| Glossary alias unlink | A single mapping row of a term; re-map it. |
| Analysis runs, proposals, dismissals, jobs | System records. They travel inside the version or source that owns them but are never deleted on their own. |
| Evidence links and requests that name an internal item's code | Left where they are when the item is deleted (they are keyed by code, not by row). They are visible again if the item is restored or the code is used again. |
| Files in storage | Never deleted at delete time. The purge (or "Delete forever") removes them once nothing live names them. |

## Restore rules

`restoreTrash({ groupId } | { itemId }, options)` in `packages/core/src/trash/`. All or nothing; each refusal has its own message.

1. **Frozen versions.** The version must still be a draft or in review. Otherwise: "Cannot restore: the version is no
   longer a draft (it is published)...". A deleted version comes back as a **draft** (an in-review version too, since the
   database only lets a new version start as a draft).
2. **Parent gone.** A requirement whose parent no longer exists is not guessed at. The refusal is a 409 with
   `details: { code: 'parent_missing', parentLabel, nearestAncestor }`. The caller chooses with `placeParentId` (any
   requirement of the same version, offered: the nearest ancestor that still exists) or `atTopLevel: true`. The Trash page
   asks with a dialog. Restoring the parent first needs no choice.
3. **Code taken.** *Decision: rename.* If `(version, code)` is taken again, the restored requirement gets
   `"<code> (restored)"`, then `"<code> (restored 2)"`, and so on; the result lists `renamed: [{ from, to }]` and the message
   says so. `codeConflict: 'refuse'` stops instead with `details.code = 'code_taken'`. Links to other standards are keyed by
   code, so a renamed requirement does not get its old links back (they are counted as dropped, so they never attach to the
   other item that now has the code).
4. **Links to other standards** (mappings): taken with a requirement only when it was the last one in the standard (any
   version) bearing the code; brought back only if both codes still exist and an identical link does not. Otherwise they
   are dropped and counted in `dropped.mappings`.
5. **AI dismissals.** An AI-made requirement or note that comes back is no longer "dismissed": a database trigger on insert
   removes the matching `analysis_dismissal` (so the analysis sees it again). Deleting a whole version removes its
   dismissals and restoring puts them back.
6. **Citations of a deleted source** are dropped (with `quote_verified` cleared) and the message says how many.
7. **Merge.** Restoring a merged-away requirement moves its sub-items and notes back from the target and restores the
   target's earlier wording (`revertMerge`, on by default; only what is still where the merge left it moves).
8. **Notes, pages, templates, versions, standards, links, milestones** each check what they hang from (the requirement, the
   document, the standard, the engagement is active) and for a clash (page number, template key, edition), with a message.
9. **Permissions.** Restoring needs the permission that deleting needed (`framework:write` for the library, `evidence:write`
   for evidence links, `engagement:manage` for milestones). A person sees the Trash items of the kinds they may delete, plus
   anything they deleted themselves; an administrator holds every permission and so sees all. "Delete forever" and "Empty
   trash" need the same.

Every restore is audited: the rows come back as `insert` events by the person, and `trash_item` has its own light event
(without the payload).

## The purge

`purge_trash` is a job type in the `worker` queue group (`QUEUE_GROUPS`, compose `WORKER_QUEUES`). `startWorker` declares a
pg-boss schedule (`17 3 * * *`, daily, UTC); the tick has no job row. It asks the database which tenants have expired items
(`trash_expired_institutions()`, the one question the worker's role may ask across tenants), then purges each tenant in a
normal identity transaction as a **system** actor with the `ams_worker` database role: files first, then the rows. The
worker's role can delete expired `trash_item` rows of its tenant and nothing else (tests in `packages/db/src/trash.test.ts`).
A row whose file could not be removed is kept for the next day.

## Undo

A reversible action returns `X-Undo: <percent-encoded JSON>`:

```json
{ "label": "Deleted 2.1 and 6 sub-items", "method": "POST", "path": "/api/trash/groups/<id>/restore", "body": {} }
```

| Action | Undo descriptor |
|---|---|
| Delete (any kind), delete many, delete all | `POST /api/trash/groups/{groupId}/restore` |
| Restore (from the Trash page, or as the Undo of a delete) | the delete again (see Redo below) |
| Create a requirement / note / link | `DELETE` it (which lands in the Trash) |
| Edit a requirement / note / mapping | `PATCH` it with the earlier values of the fields that changed (the item returns to review, as any edit does) |
| Edit an IQF item (code, title, description) | `PATCH /api/quality-items/{id}` with the earlier values (renumbers sub-standards back) |
| Move, indent, outdent | `POST /api/requirements/{id}/move` with the earlier parent and position |
| Drag and drop, Move to… (one or several items) | `POST /api/framework-versions/{id}/requirements/move-many` with `placements`: runs of items to put back after the sibling they followed |
| Apply the starting template | `POST /api/framework-versions/{id}/requirements/delete-all` |
| Merge | restore the Trash group with `revertMerge: true` |
| Split | `POST /api/requirements/{id}/unsplit` |
| Change a note's authority | `POST /api/notes/{id}/authority` with the earlier one (not for the AI's own label) |

Services report it with `ctx.undo?.(descriptor)` (the API's `Ctx` listens; jobs and most tests do not). A service that calls
others reports **last**, so the outermost action wins. The chain sets the header only for a successful response. An edit
whose earlier text is too long for a header (more than 6000 bytes percent-encoded, `MAX_UNDO_HEADER`, counted after the tag
below is added) offers no undo, or no redo.

## Redo (TASK-065)

Redo is the same mechanism run once more, not a second one. Every undo descriptor points at an ordinary endpoint, and that
endpoint already reports how to reverse *itself*; so the answer to an Undo is, by construction, the descriptor that re-does
the action.

- **Tagging.** The client sends `X-Replay: undo` with the request an undo descriptor makes and `X-Replay: redo` with the one a
  redo descriptor makes (`REPLAY_HEADER`, `@ams/shared`). The chain, which alone knows the request, adds `kind: 'redo'` to the
  descriptor the request reported (`kind: 'undo'` when the request was a redo). A request without the header is an ordinary
  action and its descriptor carries no `kind`. Services never set `kind`. Same single `X-Undo` header, the same 6000-byte cap,
  the same "last report wins" rule, the same five-step chain: an undo or redo is checked for permission, runs in its own
  transaction with the identity set, and meets the frozen-version triggers exactly like the original action.
- **What each undo answers with** (the redo descriptor):

| Undone action | Redo descriptor (what the Undo's answer carries) |
|---|---|
| Delete one / many / all, a note, mapping, version, standard, ... | the Undo was a restore; it answers with the delete again: `POST /api/requirements/delete {ids}`, `.../requirements/delete-all`, `DELETE /api/notes/{id}`, `/api/mappings/{id}`, `/api/framework-versions/{id}`, ... (`packages/core/src/trash/redo.ts`, built from the Trash payload before the rows are marked restored). Deleting again makes a **new Trash group**; ids are the original ids, so a delete after a restore works even when a code was renamed on restore |
| Create a requirement / note / link | the Undo deleted it; it answers with the restore of that Trash group (same id) |
| Edit a requirement / note / mapping / IQF item, note authority | the Undo was a `PATCH` with the earlier values; it answers with a `PATCH` of the edited values |
| Move, indent, outdent | the Undo was a `move`; it answers with a `move` to where it had been put |
| Drag and drop, Move to... | the Undo was `move-many` with placements; it answers with `move-many` placements back at the target |
| Apply the starting template | the Undo was delete-all; it answers with the restore of that group (template rows with their ids) |
| Merge | the Undo was a restore with `revertMerge`; it answers with `POST /api/requirements/{id}/merge {intoId, useMergedWording}` (the merge records `useMergedWording` in its Trash payload) |
| Split | the Undo was `unsplit`; it answers with `POST /api/requirements/{id}/split {part, code, title}`. Redo creates a **new** requirement (a new id), because unsplit sends the split-out one to the Trash and the original must get its shortened text again; the answer to that redo is an `unsplit` of the new id |
| Unsplit | same as the row above, read the other way |
| A restore made from the Trash page | it offers the delete again as an ordinary Undo (label "Restored ..."); no `kind` |

- **Refusals** come from the redo's own endpoint and are shown as they are: a version that was published meanwhile ("Cannot
  restore: the version is no longer a draft ..." / the delete's refusal), a parent that was deleted meanwhile (409
  `parent_missing`), an id that is gone (404, e.g. the Trash was emptied), a viewer (403). Nothing changes when a redo is refused.
- **Cannot be redone**: nothing that has an undo today. What is not covered is a redo that would not fit the header (the same
  6000-byte cap: a very long text edited in, then undone, offers no Redo), a group made of several items of different kinds
  (no action produces one), and an Undo whose answer is empty (a move that changed nothing). In those cases no Redo is offered;
  there is never a Redo button that cannot work. A merge restored from the Trash page *without* `revertMerge` redoes as a plain delete.

Client (`apps/web/src/lib/undo.ts`, `components/undo-toaster.tsx`): `createApi`'s fetch wrapper hands every response to the
undo bus, so every call through the typed client gets a toast with no per-screen code. The toast is `role="status"`,
shows 9 seconds (longer while hovered or focused), stacks (4), has an "Undo" button that is reachable by keyboard and a
dismiss button. A failed undo shows the server's reason ("Could not undo ...: Cannot restore: the version is no longer a
draft ...") as an alert. **Ctrl/Cmd+Z** undoes the latest action of the current screen (its address) when focus is not in
a text field; each screen keeps 20. After an undo (or a redo) all queries are refreshed.

Redo on the client: each screen also keeps a **redo stack** of 20, filled by the descriptor an Undo's answer carries. After an
undo the toast reads "Undone: <label>" with a **Redo** button (same 9 seconds, `role="status"`, the button is reachable by
keyboard). **Ctrl/Cmd+Shift+Z** and **Ctrl/Cmd+Y** redo the latest undone action of the screen when focus is not in a text
field. Redo offers the Undo again ("Redone: <label>", with Undo), so the two walk back and forth. **Any new action clears the
redo stack of the screen**: every successful non-GET request that is not an undo or redo, whether or not it offers an undo.
A refused redo shows the server's reason as an alert ("Could not redo ...: <reason>") and the entry stays on the stack.

## For the next feature (drag-and-drop, multi-select)

- Bulk delete: `api.previewDelete(ids)` for the question, `api.deleteMany(ids)` for the action; one Trash group, one toast.
- A new reversible mutation: call `reportUndo(ctx, { label, method, path, body })` at the end of the service. Nothing else
  is needed on the client.
- A drag that moves several rows: move each, then report one descriptor that restores them all (a new endpoint that takes
  the list), because only the last descriptor of a request is sent.
- Confirmation: `const confirm = useConfirm()` from `components/confirm-dialog`; a lint rule forbids `confirm`, `alert`,
  `prompt` and `window.*` in `apps/web`.

## Known limits

- Replacing a source's file (`uploadSourceFile`) leaves the old object in storage; that was so before and is not part of the Trash.
- A very large version is one `jsonb` payload (its pages included); there is no size cap on the snapshot.
- Evidence links and requests keyed by an IQF item's code stay when the item is deleted and are not part of its snapshot.
