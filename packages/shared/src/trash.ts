// Trash and undo (DEC-026): the shapes the API, the SPA and the worker share.
import { z } from 'zod';

/** How long a deleted item stays in the Trash before the daily purge removes it for good. Shown in the UI. */
export const TRASH_RETENTION_DAYS = 30;

/** What a Trash row holds. Each kind is one thing a person deleted; its rows travel together in the payload. */
export const TRASH_KINDS = [
  'requirement', 'note', 'source_document', 'source_page', 'report_template', 'framework_version', 'framework', 'mapping', 'evidence_link', 'milestone',
] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];

/** Plain words for each kind, in the singular and plural, for labels and filters. */
export const TRASH_KIND_LABELS: Record<TrashKind, { one: string; many: string }> = {
  requirement: { one: 'Standard', many: 'Standards' },
  note: { one: 'Note', many: 'Notes' },
  source_document: { one: 'Source document', many: 'Source documents' },
  source_page: { one: 'Source page', many: 'Source pages' },
  report_template: { one: 'Report template', many: 'Report templates' },
  framework_version: { one: 'Version', many: 'Versions' },
  framework: { one: 'Standard (whole)', many: 'Standards (whole)' },
  mapping: { one: 'Link between standards', many: 'Links between standards' },
  evidence_link: { one: 'Evidence link', many: 'Evidence links' },
  milestone: { one: 'Milestone', many: 'Milestones' },
};

/**
 * How to take back an action. Returned in the `X-Undo` response header (percent-encoded JSON) of every reversible
 * mutation; the client shows "label . Undo" and, on Undo, sends `method path` with `body`. A failed undo answers with
 * the reason in `message` (for example "Cannot restore: the version is no longer a draft").
 */
export const UndoDescriptorSchema = z.object({
  /** What happened, in plain words: "Deleted 2.1 and 6 sub-items". */
  label: z.string(),
  method: z.enum(['POST', 'PATCH', 'PUT', 'DELETE']),
  path: z.string(),
  body: z.unknown().optional(),
  /**
   * Set by the API chain, never by a service. `'redo'`: the request that returned it was an Undo (see REPLAY_HEADER), so
   * this descriptor re-does the original action. Absent (or `'undo'`): an ordinary action, or the request was a Redo, so
   * this descriptor takes it back again.
   */
  kind: z.enum(['undo', 'redo']).optional(),
});
export type UndoDescriptor = z.infer<typeof UndoDescriptorSchema>;
export const UNDO_HEADER = 'X-Undo';
/** Sent by the client with the request an undo descriptor makes (`undo`) or the request a redo descriptor makes (`redo`). */
export const REPLAY_HEADER = 'X-Replay';

/** What is in one Trash row, counted in plain words. */
export const TrashCountsSchema = z.record(z.string(), z.number());

export const TrashItemSchema = z.object({
  id: z.string(), groupId: z.string(), kind: z.enum(TRASH_KINDS),
  label: z.string(), context: z.string().nullable(), counts: TrashCountsSchema,
  deletedBy: z.string().nullable(), deletedByName: z.string().nullable(), deletedAt: z.string(), expiresAt: z.string(), daysLeft: z.number(),
});
export type TrashItem = z.infer<typeof TrashItemSchema>;

/** Items deleted in one action. */
export const TrashGroupSchema = z.object({
  groupId: z.string(), deletedAt: z.string(), expiresAt: z.string(), daysLeft: z.number(),
  deletedBy: z.string().nullable(), deletedByName: z.string().nullable(),
  label: z.string(), counts: TrashCountsSchema, kinds: z.array(z.enum(TRASH_KINDS)), items: z.array(TrashItemSchema),
});
export type TrashGroup = z.infer<typeof TrashGroupSchema>;

export const TrashListSchema = z.object({ retentionDays: z.number(), groups: z.array(TrashGroupSchema), total: z.number() });
export type TrashList = z.infer<typeof TrashListSchema>;

/** One row of what a Trash item holds (the subtree), for opening a group. */
export const TrashContentSchema = z.object({
  itemId: z.string(), kind: z.enum(TRASH_KINDS), label: z.string(),
  rows: z.array(z.object({ table: z.string(), id: z.string(), label: z.string(), depth: z.number() })),
});
export type TrashContent = z.infer<typeof TrashContentSchema>;

export const DeleteResultSchema = z.object({
  groupId: z.string(),
  /** The same words the Undo toast shows. */
  label: z.string(),
  counts: TrashCountsSchema,
  items: z.number(),
});
export type DeleteResult = z.infer<typeof DeleteResultSchema>;

export const DeletePreviewSchema = z.object({
  /** The selected rows after dropping those already inside another selected row's subtree. */
  roots: z.number(),
  counts: TrashCountsSchema,
  /** "Delete 2.1 and its 6 sub-items and 11 notes?" built on the server so every screen says it the same way. */
  message: z.string(),
  label: z.string(),
});
export type DeletePreview = z.infer<typeof DeletePreviewSchema>;

export const RestoreOptionsSchema = z.object({
  /** Put a requirement whose parent is gone under this requirement instead. */
  placeParentId: z.uuid().optional(),
  /** Put a requirement whose parent is gone at the top level. */
  atTopLevel: z.boolean().optional(),
  /** A code already taken in the version: 'rename' (default) gives the restored one the next free number, 'refuse' stops. */
  codeConflict: z.enum(['rename', 'refuse']).optional(),
  /** For a merge: move the children and notes back from the requirement they were merged into (default: yes). */
  revertMerge: z.boolean().optional(),
}).strict();
export type RestoreOptions = z.infer<typeof RestoreOptionsSchema>;

export const RestoreResultSchema = z.object({
  groupId: z.string(),
  label: z.string(),
  /** What came back, by kind of row. */
  restored: TrashCountsSchema,
  /** Links whose other side no longer exists, and so were not brought back. */
  dropped: TrashCountsSchema,
  /** Codes that were taken in the meantime, and the code the restored one got. */
  renamed: z.array(z.object({ from: z.string(), to: z.string() })),
  /** Where a requirement whose parent was gone was put. */
  placedUnder: z.string().nullable(),
  message: z.string(),
});
export type RestoreResult = z.infer<typeof RestoreResultSchema>;

/** The answer when a restore needs a choice (HTTP 409 with these details). */
export const RestoreChoiceSchema = z.object({
  code: z.enum(['parent_missing', 'code_taken']),
  itemId: z.string(),
  /** The requirement the item sat under, as it was called. */
  parentLabel: z.string().nullable(),
  /** The nearest requirement above it that still exists, if any. */
  nearestAncestor: z.object({ id: z.string(), label: z.string() }).nullable(),
});
export type RestoreChoice = z.infer<typeof RestoreChoiceSchema>;

/** Plain wording of a count: "6 sub-items", "1 note". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
