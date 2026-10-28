// Documents and AI import (TASK-075, docs/ai-import.md): the shapes the API, the SPA and the worker share.
// One pattern for every place where the AI reads uploaded documents and fills drafts: a registry of uploads
// (`import_document`), the standards' source documents seen through the same row shape, an import run with proposals,
// and one undoable "apply".
import { z } from 'zod';
import { PreflightSchema } from './analysis-report.js';

/** Scope kinds a plain upload (`import_document`) can belong to. Extensible: add one here, in the migration's check and in the scope registry. */
export const IMPORT_SCOPE_KINDS = ['programs', 'org_chart', 'glossary'] as const;
export type ImportScopeKind = (typeof IMPORT_SCOPE_KINDS)[number];
/** Every place that can have a Docs tab. `framework_version` is the standards adapter: its rows are `source_document`. */
export const DOC_SCOPE_KINDS = ['framework_version', ...IMPORT_SCOPE_KINDS] as const;
export type DocScopeKind = (typeof DOC_SCOPE_KINDS)[number];

/** Reading state of an upload. `not_read` is only for a standards source nobody has asked to read yet. */
export const IMPORT_READ_STATUSES = ['queued', 'reading', 'read', 'needs_ocr', 'failed'] as const;
export type ImportReadStatus = (typeof IMPORT_READ_STATUSES)[number];
export const DOC_STATUSES = [...IMPORT_READ_STATUSES, 'not_read'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];
export const DOC_STATUS_LABEL: Record<DocStatus, string> = {
  queued: 'Waiting to be read', reading: 'Reading', read: 'Read', needs_ocr: 'Needs OCR', failed: 'Could not be read', not_read: 'Not read yet',
};

export const IMPORT_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type ImportRunStatus = (typeof IMPORT_RUN_STATUSES)[number];
/** A run in one of these holds its scope and target: no second run of the same target starts there until it ends. */
export const ACTIVE_IMPORT_STATUSES = ['queued', 'running'] as const satisfies readonly ImportRunStatus[];

export const IMPORT_STAGES = ['read', 'extract', 'verify', 'organise', 'propose', 'finalise'] as const;
export type ImportStage = (typeof IMPORT_STAGES)[number];

/**
 * pending: waiting for a decision. accepted / skipped: the person's decision. edited: the person changed the values (counts as
 * accepted). applied: written to the real records by Apply.
 */
export const IMPORT_PROPOSAL_STATUSES = ['pending', 'accepted', 'edited', 'skipped', 'applied'] as const;
export type ImportProposalStatus = (typeof IMPORT_PROPOSAL_STATUSES)[number];
/** The statuses Apply writes. */
export const APPLIABLE_PROPOSAL_STATUSES = ['accepted', 'edited'] as const;

export const IMPORT_APPLY_STATES = ['applied', 'undone'] as const;

/** Pages per extraction window and the pages two neighbouring windows share. */
export const IMPORT_WINDOW_PAGES = 8;
export const IMPORT_WINDOW_OVERLAP = 1;

const iso = z.string();

// ---- Documents --------------------------------------------------------------------------------------------------------

/** One document, whichever table holds it (`import_document` or the standards' `source_document`). */
export const DocumentRowSchema = z.object({
  id: z.string(),
  /** 'import': a plain upload. 'source': a standards source document (the adapter). */
  source: z.enum(['import', 'source']),
  scopeKind: z.enum(DOC_SCOPE_KINDS),
  scopeId: z.string().nullable(),
  /** What the list calls it: the file's name for an upload, the source's title for a standards source. */
  name: z.string(),
  /** The original file's name, when a file is held. */
  fileName: z.string().nullable(),
  /** A short word for the kind of file: PDF, Word, Excel, Image... */
  fileKind: z.string(),
  mime: z.string().nullable(),
  size: z.number().nullable(),
  pageCount: z.number().nullable(),
  status: z.enum(DOC_STATUSES),
  /** Plain words for the status ("Read: 12 pages, 2 need OCR"). */
  statusText: z.string(),
  needsOcrPages: z.number(),
  readError: z.string().nullable(),
  language: z.string(),
  hasFile: z.boolean(),
  uploadedBy: z.string().nullable(),
  uploadedByName: z.string().nullable(),
  uploadedAt: iso,
  /** Standards sources only: what the document is (Standards, Guidance...), who chose it, and how binding it is. */
  role: z.string().nullable(),
  roleOrigin: z.enum(['manual', 'ai', 'unset']).nullable(),
  authority: z.string().nullable(),
});
export type DocumentRow = z.infer<typeof DocumentRowSchema>;

/** A row of the Documents area: the document plus where it is used. */
export const DocumentListItemSchema = DocumentRowSchema.extend({
  place: z.object({ label: z.string(), href: z.string() }),
});
export type DocumentListItem = z.infer<typeof DocumentListItemSchema>;

export const DocumentFiltersSchema = z.object({
  /** A scope kind, or `kind:id`. */
  place: z.string().optional(),
  uploadedBy: z.uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  fileKind: z.string().optional(),
  status: z.enum(DOC_STATUSES).optional(),
  q: z.string().optional(),
});
export type DocumentFilters = z.infer<typeof DocumentFiltersSchema>;

export const DocumentListSchema = z.object({
  items: z.array(DocumentListItemSchema),
  total: z.number(),
  /** The places and uploaders that appear, for the filters. */
  places: z.array(z.object({ value: z.string(), label: z.string() })),
  uploaders: z.array(z.object({ id: z.string(), name: z.string() })),
  fileKinds: z.array(z.string()),
  truncated: z.boolean(),
});
export type DocumentList = z.infer<typeof DocumentListSchema>;

export const ImportPageSchema = z.object({
  pageNo: z.number(), text: z.string(), method: z.string(), needsOcr: z.boolean(), warnings: z.array(z.string()),
});
export type ImportPage = z.infer<typeof ImportPageSchema>;

/** The scopes a person can open a Docs tab for, with what they may do there. */
export const DocScopeInfoSchema = z.object({
  kind: z.enum(DOC_SCOPE_KINDS), scopeId: z.string().nullable(), label: z.string(), canRead: z.boolean(), canWrite: z.boolean(),
  /** False for a standards version that is no longer a draft: documents and imports are fixed with it. */
  editable: z.boolean(),
  href: z.string(),
});
export type DocScopeInfo = z.infer<typeof DocScopeInfoSchema>;

export const UploadResultSchema = DocumentRowSchema;

// ---- Import targets and runs ------------------------------------------------------------------------------------------

export const ImportTargetInfoSchema = z.object({
  kind: z.string(), label: z.string(), description: z.string(), scopeKinds: z.array(z.string()),
  /** What the AI is asked to fill, in a few words ("programs", "units"). */
  itemsLabel: z.string(),
});
export type ImportTargetInfo = z.infer<typeof ImportTargetInfoSchema>;

export const ImportProgressSchema = z.object({
  stage: z.enum(IMPORT_STAGES).optional(),
  cursor: z.number().int().optional(),
  docsTotal: z.number().int().optional(),
  docsDone: z.number().int().optional(),
  windowsTotal: z.number().int().optional(),
  windowsDone: z.number().int().optional(),
  items: z.number().int().optional(),
});
export type ImportProgress = z.infer<typeof ImportProgressSchema>;

export const ImportUsageSchema = z.object({
  inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().nullable(), calls: z.number().int(),
});
export type ImportUsage = z.infer<typeof ImportUsageSchema>;

export const ImportCountsSchema = z.object({
  total: z.number().int(), pending: z.number().int(), accepted: z.number().int(), edited: z.number().int(), skipped: z.number().int(), applied: z.number().int(),
  flagged: z.number().int(),
});
export type ImportCounts = z.infer<typeof ImportCountsSchema>;

export const ImportRunSchema = z.object({
  id: z.string(), scopeKind: z.enum(DOC_SCOPE_KINDS), scopeId: z.string().nullable(), targetKind: z.string(), targetLabel: z.string(),
  documentIds: z.array(z.string()),
  status: z.enum(IMPORT_RUN_STATUSES), stage: z.enum(IMPORT_STAGES).nullable(),
  progress: ImportProgressSchema, usage: ImportUsageSchema, error: z.string().nullable(),
  startedBy: z.string().nullable(), startedByName: z.string().nullable(), startedAt: iso.nullable(), finishedAt: iso.nullable(), createdAt: iso,
  counts: ImportCountsSchema,
});
export type ImportRun = z.infer<typeof ImportRunSchema>;

export const ImportProposalSchema = z.object({
  id: z.string(), runId: z.string(), targetKind: z.string(), seq: z.number().int(),
  /** A short name for the table row and the toast, from the target ("BSc Nursing"). */
  label: z.string(),
  /** What the AI proposed. */
  payload: z.unknown(),
  /** What the person changed it to (null when untouched). */
  editedPayload: z.unknown().nullable(),
  /** The values Apply will use: the edited ones when there are any. */
  effective: z.unknown(),
  documentId: z.string().nullable(), documentName: z.string().nullable(), pageNo: z.number().int().nullable(),
  quote: z.string().nullable(), quoteVerified: z.boolean(), confidence: z.number().nullable(),
  /** Reasons to look at it first, in plain words. */
  flags: z.array(z.string()),
  status: z.enum(IMPORT_PROPOSAL_STATUSES),
  appliedRef: z.unknown().nullable(),
});
export type ImportProposal = z.infer<typeof ImportProposalSchema>;

export const ImportProposalListSchema = z.object({
  run: ImportRunSchema, proposals: z.array(ImportProposalSchema),
  /** The values a field may take, for the fields that have a fixed list (the review shows a choice instead of free text). */
  fieldOptions: z.record(z.string(), z.array(z.string())).default({}),
  /** Values offered for a field while another can still be typed (e.g. the existing units of the org chart). */
  fieldSuggestions: z.record(z.string(), z.array(z.string())).default({}),
});
export type ImportProposalList = z.infer<typeof ImportProposalListSchema>;

export const StartImportSchema = z.object({
  scopeKind: z.enum(DOC_SCOPE_KINDS), scopeId: z.uuid().nullable().default(null), targetKind: z.string().min(1),
  documentIds: z.array(z.uuid()).min(1).max(50),
});
export type StartImport = z.infer<typeof StartImportSchema>;

export const ImportPreflightQuerySchema = z.object({
  scopeKind: z.enum(DOC_SCOPE_KINDS), scopeId: z.uuid().optional(), targetKind: z.string().min(1),
});
export const ImportPreflightSchema = PreflightSchema;

export const DecideProposalsSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(2000),
  decision: z.enum(['accept', 'skip', 'reset']),
});
export type DecideProposals = z.infer<typeof DecideProposalsSchema>;

export const EditProposalSchema = z.object({ payload: z.unknown() });

export const ImportApplyPreviewSchema = z.object({
  /** Proposals Apply would write (accepted or edited, not yet applied). */
  count: z.number().int(), skippedPending: z.number().int(),
  /** "Apply 12 programs to the Programs list? You can undo it." built on the server. */
  message: z.string(),
});
export type ImportApplyPreview = z.infer<typeof ImportApplyPreviewSchema>;

export const ImportApplyResultSchema = z.object({
  /** The stored apply (for Undo); null when the target wrote nothing. */
  applyId: z.string().nullable(),
  state: z.enum(IMPORT_APPLY_STATES),
  applied: z.number().int(),
  /** Proposals the target left alone, with the reason (for example, a record a person edited). */
  skipped: z.array(z.object({ proposalId: z.string(), label: z.string(), reason: z.string() })),
  message: z.string(),
});
export type ImportApplyResult = z.infer<typeof ImportApplyResultSchema>;

// ---- The run report ---------------------------------------------------------------------------------------------------

export const IMPORT_REPORT_VERSION = 1;
/**
 * The report of one import run, built on demand from what is stored (like the analysis report). Counts of what was read, found
 * and checked: never a score, a verdict or a prediction (DEC-005).
 */
export const ImportReportSchema = z.object({
  version: z.literal(IMPORT_REPORT_VERSION),
  run: ImportRunSchema,
  scopeLabel: z.string(),
  documents: z.array(z.object({
    documentId: z.string(), name: z.string(), pages: z.number().int(), pagesNative: z.number().int(), pagesOcr: z.number().int(), pagesUnreadable: z.number().int(),
    status: z.enum(DOC_STATUSES), readError: z.string().nullable(), warnings: z.array(z.string()),
  })),
  totals: z.object({ documents: z.number().int(), documentsRead: z.number().int(), pages: z.number().int(), ocrPages: z.number().int(), unreadablePages: z.number().int() }),
  proposals: ImportCountsSchema.extend({ quoteVerified: z.number().int(), quoteNotFound: z.number().int(), lowConfidence: z.number().int() }),
  /** Proposals that need a look, with the reasons. */
  flagged: z.array(z.object({
    proposalId: z.string(), label: z.string(), status: z.enum(IMPORT_PROPOSAL_STATUSES), reasons: z.array(z.string()),
    documentId: z.string().nullable(), documentName: z.string().nullable(), pageNo: z.number().int().nullable(),
  })),
  usage: ImportUsageSchema,
  models: z.object({ model: z.string().nullable(), role: z.enum(['analysis', 'reading']).nullable() }),
  promptVersion: z.string().nullable(),
  stoppedBy: z.enum(['budget', 'cancelled', 'error']).nullable(),
  stoppedMessage: z.string().nullable(),
  applies: z.array(z.object({ id: z.string(), state: z.enum(IMPORT_APPLY_STATES), applied: z.number().int(), appliedAt: iso, undoneAt: iso.nullable(), byName: z.string().nullable() })),
});
export type ImportReport = z.infer<typeof ImportReportSchema>;

// ---- Words ------------------------------------------------------------------------------------------------------------

const KINDS: Record<string, string> = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', odt: 'OpenDocument', rtf: 'Rich text', xls: 'Excel', xlsx: 'Excel', ods: 'OpenDocument', csv: 'CSV', tsv: 'TSV',
  ppt: 'PowerPoint', pptx: 'PowerPoint', odp: 'OpenDocument', png: 'Image', jpg: 'Image', jpeg: 'Image', tif: 'Image', tiff: 'Image', webp: 'Image',
};
/** A short label for the kind of file, from its name ("PDF", "Word", "Image"). */
export function fileKindOf(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return KINDS[ext] ?? 'File';
}
export const FILE_KINDS = [...new Set(Object.values(KINDS))].sort();

/** The status of an upload in words: "Read: 12 pages, 2 need OCR". */
export function documentStatusText(status: DocStatus, pages: number, needsOcr: number, error?: string | null): string {
  const p = `${pages} page${pages === 1 ? '' : 's'}`;
  switch (status) {
    case 'queued': return 'Waiting to be read';
    case 'reading': return 'Reading the file…';
    case 'read': return `Read: ${p}`;
    case 'needs_ocr': return `Read: ${p}, ${needsOcr} need${needsOcr === 1 ? 's' : ''} OCR`;
    case 'failed': return error ? `Could not be read: ${error}` : 'Could not be read';
    case 'not_read': return 'Not read yet';
  }
}
