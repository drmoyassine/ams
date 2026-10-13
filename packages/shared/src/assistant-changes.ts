// The assistant's bulk edits (DEC-027, Phase 2): the CHANGE SET format, the proposal the chat shows, and the confirm / apply /
// undo / redo shapes. A change set is an ordered list of operations; each operation is a typed record {op, targets, params}.
// The model picks operations and parameters; ordinary code (packages/core/src/assistant/changes) computes the exact rows.
// Nothing here changes anything: these are shapes the API, the worker and the SPA share.
import { z } from 'zod';

// ---- Limits ------------------------------------------------------------------------------------------------------------
/** The most item changes (rows touched, sub-items of a delete included) one apply may make; bigger requests are split in steps. */
export const MAX_ITEM_CHANGES = 500;
/** How long a confirmation (the "Do it" press) is good for. */
export const CONFIRMATION_MINUTES = 10;
/** The most operations in one change set. */
export const MAX_OPERATIONS = 12;
/** The longest text one rewritten or set field may hold. */
export const MAX_REWRITE_CHARS = 8000;

// ---- Filters (shared by recipes and the read tools) ---------------------------------------------------------------------
const word = z.string().trim().min(1).max(300);
const code = z.string().trim().min(1).max(100);
export const REQUIREMENT_ORIGINS = ['manual', 'import', 'ai'] as const;

/**
 * Which requirements of the version an operation applies to. Every condition given must hold (AND). An empty filter means
 * every requirement of the version. Text matching ignores case, diacritics and Arabic spelling variants.
 */
export const RequirementFilterSchema = z.object({
  ids: z.array(z.uuid()).max(2000).optional().describe('Exactly these requirements (ids from the tools or the screen context).'),
  level: z.union([word, z.array(word).max(10)]).optional().describe('Level name(s) such as "Indicator" (see get_version_summary).'),
  depth: z.number().int().min(0).max(10).optional().describe('Depth in the tree, 0 = top level.'),
  codeEquals: z.array(code).max(500).optional(),
  codeStartsWith: code.optional().describe('A code prefix, for example "3.2".'),
  codePattern: z.string().trim().min(1).max(200).optional().describe('A regular expression tested against the code.'),
  parentId: z.uuid().nullable().optional().describe('Direct children of this requirement (null: top level).'),
  parentCode: code.optional(),
  underId: z.uuid().optional().describe('All descendants of this requirement.'),
  underCode: code.optional(),
  textContains: word.optional().describe('Words in the title or the description.'),
  titleContains: word.optional(),
  descriptionContains: word.optional(),
  titleIsCode: z.boolean().optional().describe('The title is only the code (nothing else).'),
  descriptionEmpty: z.boolean().optional(),
  hasChildren: z.boolean().optional(),
  hasNotes: z.boolean().optional(),
  emptyHeading: z.boolean().optional().describe('No description, no sub-items and no notes.'),
  duplicateCode: z.boolean().optional().describe('The code is the same as an earlier item\'s once spacing, case and separators are ignored (the later ones match).'),
  isAssessable: z.boolean().optional(),
  language: z.string().trim().min(2).max(10).optional(),
  quoteNotFound: z.boolean().optional().describe('Has a source quote that was not found on its page.'),
  editedByPerson: z.boolean().optional(),
  origin: z.enum(REQUIREMENT_ORIGINS).optional(),
}).strict();
export type RequirementFilter = z.infer<typeof RequirementFilterSchema>;

/** True when no condition is set (the filter would match everything). */
export const filterIsEmpty = (f: RequirementFilter | undefined): boolean => !f || Object.values(f).every((v) => v === undefined);

// ---- Operations --------------------------------------------------------------------------------------------------------
const filter = RequirementFilterSchema;
export const EDITABLE_FIELDS = ['title', 'officialText', 'levelLabel', 'isAssessable', 'language'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const SetValuesSchema = z.object({
  title: z.string().trim().min(1).max(2000).optional(),
  officialText: z.string().max(MAX_REWRITE_CHARS).nullable().optional(),
  levelLabel: z.string().trim().min(1).max(80).optional(),
  isAssessable: z.boolean().optional(),
  language: z.string().trim().min(2).max(10).optional(),
}).strict().refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'give at least one field to set' });

const NoteTypes = ['guidance', 'evidence_expectation', 'data_request', 'quantitative_norm'] as const;
const NoteAuthorities = ['required', 'example', 'suggested', 'institution_defined'] as const;

const op = <T extends string, S extends z.ZodRawShape>(name: T, shape: S) => z.object({ op: z.literal(name), ...shape }).strict();

// -- Recipes: the model chooses the recipe and its filter / parameters; code computes every row. --
export const SwapTitleAndDescriptionOp = op('swap_title_and_description', {
  filter: filter.default({}),
  direction: z.enum(['statement_to_title', 'title_to_statement']).default('statement_to_title')
    .describe('statement_to_title: where the title is only the code, the statement (the description) becomes the title. title_to_statement: the reverse.'),
});
export const SetFieldByFilterOp = op('set_field_by_filter', {
  filter: filter.default({}),
  field: z.enum(EDITABLE_FIELDS),
  value: z.union([z.string().max(MAX_REWRITE_CHARS), z.boolean(), z.null()]),
});
export const CopyFieldOp = op('copy_field', {
  filter: filter.default({}),
  from: z.enum(['code', 'title', 'officialText', 'translationEn']),
  to: z.enum(['title', 'officialText', 'translationEn']),
  onlyIfEmpty: z.boolean().default(false).describe('Leave items whose target already has text.'),
});
export const PrefixOrReplaceTextOp = op('prefix_or_replace_text', {
  filter: filter.default({}),
  field: z.enum(['title', 'officialText', 'translationEn']),
  mode: z.enum(['prefix', 'suffix', 'replace']),
  text: z.string().max(500).optional().describe('For prefix / suffix: the text to add.'),
  find: z.string().min(1).max(500).optional().describe('For replace: what to find (literal, or a regular expression when regex is true).'),
  replaceWith: z.string().max(500).optional().describe('For replace: what to put instead (empty removes it).'),
  regex: z.boolean().default(false),
  caseInsensitive: z.boolean().default(false),
});
export const RecodeOp = op('recode', {
  filter: filter.default({}),
  mapping: z.array(z.object({ from: code, to: code }).strict()).max(500).optional().describe('Explicit old code -> new code pairs.'),
  pattern: z.object({ find: z.string().min(1).max(200), replaceWith: z.string().max(200), regex: z.boolean().default(false) }).strict().optional()
    .describe('Or a find / replace applied to every matching code.'),
});
export const ReparentByRuleOp = op('reparent_by_rule', {
  filter,
  newParent: z.object({ id: z.uuid().optional(), code: code.optional(), root: z.boolean().optional() }).strict()
    .refine((p) => [p.id, p.code, p.root].filter((x) => x !== undefined).length === 1, { message: 'name exactly one of id, code or root' }),
  position: z.enum(['end', 'start']).default('end'),
});
export const DeleteByFilterOp = op('delete_by_filter', {
  filter: filter.refine((f) => !filterIsEmpty(f), { message: 'a delete needs a filter: it will not delete everything' }),
  reason: z.string().max(200).optional().describe('Why, in a few words (for the confirmation).'),
});
export const BulkSetAssessableOp = op('bulk_set_assessable', { filter, value: z.boolean() });
export const BulkSetLevelLabelOp = op('bulk_set_level_label', { filter, label: z.string().trim().min(1).max(80) });

// -- General operations --
export const SetFieldsOp = op('set_fields', {
  items: z.array(z.object({ id: z.uuid(), set: SetValuesSchema }).strict()).min(1).max(2000).optional().describe('Per-item values.'),
  targets: filter.optional().describe('Or: every item matching this filter gets the same values (below).'),
  set: SetValuesSchema.optional(),
}).refine((o) => (o.items ? !o.targets && !o.set : !!o.targets && !!o.set), { message: 'give either items, or targets with set' });
export const SetNoteFieldsOp = op('set_note_fields', {
  noteIds: z.array(z.uuid()).min(1).max(2000).optional(),
  requirements: filter.optional().describe('Or: the notes of the requirements matching this filter (narrowed by noteType / authority).'),
  noteType: z.enum(NoteTypes).optional(),
  authority: z.enum([...NoteAuthorities, 'ai_suggested']).optional().describe('Only notes that now have this authority.'),
  set: z.object({
    text: z.string().trim().min(1).max(MAX_REWRITE_CHARS).optional(),
    type: z.enum(NoteTypes).optional(),
    authority: z.enum(NoteAuthorities).optional(),
  }).strict().refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'give at least one field to set' }),
}).refine((o) => !!o.noteIds || !!o.requirements, { message: 'name the notes (noteIds) or the requirements whose notes to change' });
export const MoveOp = op('move', {
  moves: z.array(z.object({ id: z.uuid(), parentId: z.uuid().nullable(), index: z.number().int().min(0).optional() }).strict()).min(1).max(2000)
    .describe('Reparent and / or reorder: the item, its new parent (null: top level) and its position among the new siblings (default: the end).'),
});
export const CreateRequirementOp = op('create_requirement', {
  parentId: z.uuid().nullable().optional(),
  parentCode: code.optional(),
  code,
  title: z.string().trim().min(1).max(2000),
  levelLabel: z.string().trim().min(1).max(80).optional(),
  officialText: z.string().max(MAX_REWRITE_CHARS).optional(),
  isAssessable: z.boolean().optional(),
  language: z.string().trim().min(2).max(10).optional(),
});
export const MergeOp = op('merge', { id: z.uuid(), intoId: z.uuid(), useMergedWording: z.boolean().default(false) });
export const SplitOp = op('split', { id: z.uuid(), part: z.string().trim().min(1).max(MAX_REWRITE_CHARS), code, title: z.string().trim().min(1).max(2000).optional() });
export const AcceptSuggestedLinksOp = op('accept_suggested_links', {
  mappingIds: z.array(z.uuid()).min(1).max(2000).optional().describe('Specific suggested links; default: every pending AI-suggested link of the version that says "covers".'),
  relation: z.enum(['covers', 'partly_covers', 'related']).optional().describe('With no mappingIds: only suggested links with this relation (default covers).'),
});
export const DismissSuggestedLinksOp = op('dismiss_suggested_links', {
  mappingIds: z.array(z.uuid()).min(1).max(2000).optional(),
  relation: z.enum(['covers', 'partly_covers', 'related']).optional(),
});
export const REWRITE_FIELDS = ['title', 'officialText', 'translationEn'] as const;
export const RewriteTextOp = op('rewrite_text', {
  field: z.enum(REWRITE_FIELDS),
  instruction: z.string().trim().max(300).optional().describe('What the person asked for (for the record), e.g. "translate to English".'),
  items: z.array(z.object({ id: z.uuid(), text: z.string().trim().min(1).max(MAX_REWRITE_CHARS) }).strict()).min(1).max(2000).optional()
    .describe('The new text per item, written by you. Or give setId from draft_rewrites.'),
  setId: z.string().max(80).optional().describe('The id draft_rewrites returned: its texts are used as they are.'),
}).refine((o) => !!o.items !== !!o.setId, { message: 'give either items or setId' });
export const CreateDraftOp = op('create_draft', {
  edition: z.string().trim().min(1).max(80).describe('The edition name of the new draft, e.g. "2025-V2".'),
  changeSummary: z.string().trim().max(500).optional(),
});

export const OperationSchema = z.discriminatedUnion('op', [
  SwapTitleAndDescriptionOp, SetFieldByFilterOp, CopyFieldOp, PrefixOrReplaceTextOp, RecodeOp, ReparentByRuleOp, DeleteByFilterOp,
  BulkSetAssessableOp, BulkSetLevelLabelOp,
  SetFieldsOp, SetNoteFieldsOp, MoveOp, CreateRequirementOp, MergeOp, SplitOp, AcceptSuggestedLinksOp, DismissSuggestedLinksOp, RewriteTextOp, CreateDraftOp,
]);
export type Operation = z.infer<typeof OperationSchema>;
export type OperationName = Operation['op'];

/** The recipes: operations whose rows are computed by a fixed rule. */
export const RECIPE_OPS = [
  'swap_title_and_description', 'set_field_by_filter', 'copy_field', 'prefix_or_replace_text', 'recode', 'reparent_by_rule', 'delete_by_filter',
  'bulk_set_assessable', 'bulk_set_level_label',
] as const satisfies readonly OperationName[];
export const GENERAL_OPS = [
  'set_fields', 'set_note_fields', 'move', 'create_requirement', 'merge', 'split', 'accept_suggested_links', 'dismiss_suggested_links', 'rewrite_text', 'create_draft',
] as const satisfies readonly OperationName[];

/** The operation in plain words, for the confirmation card. */
export const OP_LABELS: Record<OperationName, string> = {
  swap_title_and_description: 'Put the statement in the title',
  set_field_by_filter: 'Set a field',
  copy_field: 'Copy a field',
  prefix_or_replace_text: 'Add or replace text',
  recode: 'Change codes',
  reparent_by_rule: 'Move under a new parent',
  delete_by_filter: 'Delete (to the Trash)',
  bulk_set_assessable: 'Set assessable',
  bulk_set_level_label: 'Set the level name',
  set_fields: 'Edit fields',
  set_note_fields: 'Edit notes',
  move: 'Move or reorder',
  create_requirement: 'Add an item',
  merge: 'Merge into another item',
  split: 'Split an item',
  accept_suggested_links: 'Accept suggested links',
  dismiss_suggested_links: 'Dismiss suggested links',
  rewrite_text: 'Rewrite text (written by the assistant)',
  create_draft: 'Start a new draft version',
};

/** What propose_changes takes. `create_draft` stands alone (later edits target the new draft's ids, in a later confirmed step). */
export const ChangeSetInputSchema = z.object({
  versionId: z.uuid().describe('The version whose items the operations change. Filters search this version.'),
  summary: z.string().trim().min(1).max(400).describe('One plain sentence: what will be done and where.'),
  operations: z.array(OperationSchema).min(1).max(MAX_OPERATIONS),
}).strict().superRefine((v, ctx) => {
  if (v.operations.some((o) => o.op === 'create_draft') && v.operations.length > 1) {
    ctx.addIssue({ code: 'custom', path: ['operations'], message: 'creating a draft is a separate step: propose it alone, then propose the edits for the new draft' });
  }
});
export type ChangeSetInput = z.infer<typeof ChangeSetInputSchema>;

// ---- The proposal part of an assistant message ---------------------------------------------------------------------------
export const CHANGE_PROPOSAL_STATUSES = ['pending', 'applied', 'failed', 'cancelled', 'superseded', 'stale'] as const;
export type ChangeProposalStatus = (typeof CHANGE_PROPOSAL_STATUSES)[number];

export const ChangeExampleSchema = z.object({ code: z.string(), field: z.string(), before: z.string(), after: z.string() });
export const ChangeSkippedSchema = z.object({ code: z.string().nullable(), reason: z.string() });
export const ChangeDeleteSchema = z.object({ code: z.string(), title: z.string(), subItems: z.number().int(), notes: z.number().int() });
export type ChangeExample = z.infer<typeof ChangeExampleSchema>;

export const ChangeCountsSchema = z.object({
  /** Item changes (rows touched; a delete counts its sub-items). */
  items: z.number().int(),
  byOperation: z.array(z.object({ op: z.string(), label: z.string(), items: z.number().int() })),
  deletes: z.number().int(),
  /** Links to other standards that name a code that changes (they are keyed by code and do not move). */
  linksByCode: z.number().int().default(0),
  writtenByAssistant: z.number().int().default(0),
});
export type ChangeCounts = z.infer<typeof ChangeCountsSchema>;

export const ChangeResultSchema = z.object({
  changeSetId: z.uuid(),
  state: z.enum(['applied', 'undone']),
  message: z.string(),
  items: z.number().int(),
  appliedAt: z.string(),
  newVersionId: z.uuid().nullable().optional(),
});
export type ChangeResult = z.infer<typeof ChangeResultSchema>;

export const ChangeProposalPartSchema = z.object({
  id: z.string(), type: z.literal('change_proposal'),
  status: z.enum(CHANGE_PROPOSAL_STATUSES),
  versionId: z.uuid(),
  versionLabel: z.string(),
  summary: z.string(),
  operations: z.array(OperationSchema),
  /** SHA-256 of the exact operations: the confirmation is tied to it. */
  changeSetHash: z.string(),
  /** SHA-256 of the exact rows and values the operations produce on the data as it was when the proposal was made. */
  planHash: z.string(),
  counts: ChangeCountsSchema,
  examples: z.array(ChangeExampleSchema),
  skipped: z.array(ChangeSkippedSchema),
  skippedCount: z.number().int(),
  deletes: z.array(ChangeDeleteSchema),
  deletesCount: z.number().int(),
  warnings: z.array(z.string()).default([]),
  /** The dry run through the services found nothing in the way. */
  dryRun: z.object({ ok: z.boolean(), problems: z.array(z.string()) }),
  /** More than the limit matched: this is the first step; this many item changes are left for the next. */
  remaining: z.number().int().default(0),
  newDraft: z.object({ edition: z.string() }).nullable().default(null),
  result: ChangeResultSchema.nullable().default(null),
  error: z.string().nullable().default(null),
});
export type ChangeProposalPart = z.infer<typeof ChangeProposalPartSchema>;

// ---- API shapes -----------------------------------------------------------------------------------------------------------
export const ConfirmChangeSchema = z.object({
  /** `ready`: a one-time token was issued. `stale`: the proposal can no longer be applied as shown (the data changed, or something is in the way); `message` says what. */
  status: z.enum(['ready', 'stale']),
  message: z.string().nullable(),
  /** A one-time permission, valid for CONFIRMATION_MINUTES, for exactly this change set. Shown to nobody; the button sends it back at once. */
  token: z.string().nullable(),
  expiresAt: z.string().nullable(),
  changeSetHash: z.string(),
  part: ChangeProposalPartSchema,
});
export const ApplyChangeBodySchema = z.object({ token: z.string().min(20).max(200) }).strict();
export const ApplyChangeResultSchema = z.object({
  status: z.enum(['applied', 'failed', 'stale']),
  message: z.string(),
  part: ChangeProposalPartSchema,
});
export const ChangeSetStateSchema = z.object({
  id: z.uuid(), state: z.enum(['applied', 'undone']), message: z.string(), items: z.number().int(), versionId: z.uuid(),
  part: ChangeProposalPartSchema.nullable(),
});

export const WrittenTextSchema = z.object({
  id: z.uuid(), requirementId: z.uuid(), field: z.enum(REWRITE_FIELDS), changeSetId: z.uuid(), hasPrevious: z.boolean(), writtenAt: z.string(),
});
export type WrittenText = z.infer<typeof WrittenTextSchema>;
