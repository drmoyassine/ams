// Reports (PRD 10, TASK-091). Every report — an eligibility application, the self-study, an annual QA report — is the same
// object made from a report template of a framework version: a tree of typed sections with owners, reviewed and approved
// section by section, then internally approved and submitted (TASK-094). Never "met" or "compliant" (DEC-005): the internal
// approval is labelled exactly that, and official status only ever comes from accreditation_status.
import { z } from 'zod';
import { BLOCK_TYPES, TEMPLATE_KINDS } from './framework.js';

export { BLOCK_TYPES, TEMPLATE_KINDS };
export type BlockType = (typeof BLOCK_TYPES)[number];
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** The report's own state. `internally_approved` is the exact wording of DEC-005; `submitted` only 094's service reaches. */
export const REPORT_STATUSES = ['draft', 'internally_approved', 'submitted'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** A section's state (PRD 10.4 step 2; the review moves live in TASK-094). */
export const SECTION_STATUSES = ['draft', 'in_review', 'approved', 'returned'] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];

/**
 * What a QA report (no engagement) is about. An accreditation report is about an engagement instead; the two are
 * exclusive. The requirement set and the section owners come from the framework the template belongs to (TASK-091):
 * engagement reports take owners from the engagement's requirement owners, subject reports from the standards' champions.
 */
export const REPORT_SUBJECT_KINDS = ['institution', 'org_unit', 'program'] as const;
export type ReportSubjectKind = (typeof REPORT_SUBJECT_KINDS)[number];

// ---- Section content, per block type (PRD 10.3) -----------------------------------------------------------

/** Tiptap document (`doc`) as it was written, plus the plain text of it (the source of word counts and of the diff). */
export const NarrativeContentSchema = z.object({
  doc: z.unknown().optional(),
  text: z.string().default(''),
}).strict();
export type NarrativeContent = z.infer<typeof NarrativeContentSchema>;

/** A `data_table`'s rows: objects keyed by the template's column keys (or the bound dataset's), values text/number/null. */
export const DataTableContentSchema = z.object({
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(2000).default([]),
  /** The dataset version the rows last came from, when the section is bound to one. */
  datasetVersionId: z.uuid().nullable().default(null),
}).strict();
export type DataTableContent = z.infer<typeof DataTableContentSchema>;

/** An `attestation`: who signs, the statement, and the uploaded signed letter (the key names the object in storage). */
const AttestationShape = {
  signatoryName: z.string().trim().max(200).nullable().default(null),
  signatoryTitle: z.string().trim().max(200).nullable().default(null),
  statement: z.string().max(20000).nullable().default(null),
  fileKey: z.string().min(1).nullable().default(null),
  fileName: z.string().min(1).max(300).nullable().default(null),
  fileMime: z.string().min(1).max(200).nullable().default(null),
  fileSize: z.number().int().nonnegative().nullable().default(null),
};
/** The letter is stored whole: key, name, mime and size together or not at all. */
const letterWhole = (a: { fileKey?: string | null; fileName?: string | null; fileMime?: string | null; fileSize?: number | null }) => {
  const has = (v: unknown) => v !== null && v !== undefined;
  const any = has(a.fileKey) || has(a.fileName) || has(a.fileMime) || has(a.fileSize);
  return !any || (has(a.fileKey) && has(a.fileName) && has(a.fileMime) && has(a.fileSize));
};
export const AttestationContentSchema = z.object(AttestationShape).strict().refine(letterWhole, {
  message: 'a signed letter is stored whole: key, name, mime and size',
});
export type AttestationContent = z.infer<typeof AttestationContentSchema>;

/** An `appendix`: files drawn from evidence versions (the versions are checked at save time, in the tenant). */
export const AppendixContentSchema = z.object({
  items: z.array(z.object({
    evidenceVersionId: z.uuid(),
    label: z.string().trim().min(1).max(300),
  })).max(500).default([]),
}).strict();
export type AppendixContent = z.infer<typeof AppendixContentSchema>;

/** The generated blocks render at read time (TASK-093); until then their content stays empty. */
export const GeneratedContentSchema = z.object({}).strict();

export const CONTENT_BY_BLOCK: { [K in BlockType]: z.ZodType } = {
  narrative: NarrativeContentSchema,
  data_table: DataTableContentSchema,
  attestation: AttestationContentSchema,
  appendix: AppendixContentSchema,
  compliance_matrix: GeneratedContentSchema,
  evidence_index: GeneratedContentSchema,
  feedback_response: GeneratedContentSchema,
};

/** Parses one section's content against its block type; callers turn a failure into a ValidationError. */
export function parseContent(blockType: BlockType, content: unknown) {
  return CONTENT_BY_BLOCK[blockType].parse(content ?? {});
}

/** Word count of a narrative's plain text: runs of non-whitespace (Arabic included — NFC text splits the same way). */
export function countWords(text: string): number {
  const t = text.normalize('NFC').trim();
  return t ? t.split(/\s+/).length : 0;
}

// ---- Requests -----------------------------------------------------------------------------------------------

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'letters, digits, _ . - only');

export const CreateReportSchema = z.object({
  frameworkVersionId: z.uuid(),
  templateKey: key,
  /** An accreditation report: for one engagement, whose framework version must be this one. */
  engagementId: z.uuid().optional(),
  /** A QA report: about the institution, a unit or a program (owners then come from the champions). */
  subjectKind: z.enum(REPORT_SUBJECT_KINDS).optional(),
  subjectId: z.uuid().optional(),
  title: z.string().trim().min(1).max(300).optional(),
  /** Which submission round this report answers; the first is 1 (used from M5). */
  round: z.number().int().min(1).optional(),
}).strict().refine((r) => (r.engagementId !== undefined) !== (r.subjectKind !== undefined), {
  message: 'a report is for an engagement, or about a subject — exactly one of the two',
}).refine((r) => (r.subjectKind === undefined) === (r.subjectId === undefined), {
  message: 'a subject is named whole: kind and id',
});
export type CreateReport = z.infer<typeof CreateReportSchema>;

export const UpdateReportSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
}).strict();
export type UpdateReport = z.infer<typeof UpdateReportSchema>;

/**
 * Content of one section. The API accepts only the key that matches the section's block type (the service checks), so the
 * editor cannot cross-write a narrative into a table. Attestation is `.partial()`: a person may fill the statement first
 * and upload the signed letter later.
 */
export const UpdateSectionContentSchema = z.object({
  narrative: NarrativeContentSchema.optional(),
  data_table: DataTableContentSchema.optional(),
attestation: z.object(AttestationShape).partial().refine(letterWhole, {
    message: 'a signed letter is stored whole: key, name, mime and size',
  }).optional(),
  appendix: AppendixContentSchema.optional(),
}).strict();
export type UpdateSectionContent = z.infer<typeof UpdateSectionContentSchema>;

export const SetSectionOwnerSchema = z.object({
  ownerId: z.uuid().nullable(),
}).strict();
export type SetSectionOwner = z.infer<typeof SetSectionOwnerSchema>;

// ---- Workflow (PRD 10.4 steps 2 to 5, TASK-094) -------------------------------------------------------------

/** A reviewer's move on a section: approve it, or send it back with a note (what to fix); reopening an approved section
 *  of an internally approved report is a `returned` too. The database refuses a `returned` without the note. */
export const DecideSectionSchema = z.object({
  decision: z.enum(['approved', 'returned']),
  note: z.string().trim().min(1).max(2000).optional(),
}).strict().refine((d) => d.decision !== 'returned' || d.note !== undefined, {
  message: 'returning a section needs a note saying what to fix',
});
export type DecideSection = z.infer<typeof DecideSectionSchema>;

/** "Mark submitted" (step 5): the accreditor's own reference (portal id, receipt) may be known now or later. */
export const MarkSubmittedSchema = z.object({
  ref: z.string().trim().min(1).max(300).optional(),
}).strict();
export type MarkSubmitted = z.infer<typeof MarkSubmittedSchema>;

// ---- Responses ----------------------------------------------------------------------------------------------

const iso = z.string();

export const SectionRequirementSchema = z.object({
  requirementId: z.string(), code: z.string(), title: z.string(),
});
export type SectionRequirement = z.infer<typeof SectionRequirementSchema>;

/** The latest review decision on a section — what the writer reads when a section comes back (kept in report_section_decision). */
export const SectionDecisionInfoSchema = z.object({
  decision: z.enum(['approved', 'returned']),
  note: z.string().nullable(),
  decidedBy: z.string(), decidedByName: z.string().nullable(), decidedAt: iso,
});
export type SectionDecisionInfo = z.infer<typeof SectionDecisionInfoSchema>;

/** A data_table's columns, from the template (a data_table section is born with them or with a dataset binding). */
export const SectionColumnSchema = z.object({
  key: z.string(), label: z.string(), type: z.enum(['text', 'number', 'date', 'enum']), options: z.array(z.string()).optional(),
});
export type SectionColumn = z.infer<typeof SectionColumnSchema>;

export const ReportSectionSchema: z.ZodType<ReportSection> = z.lazy(() => z.object({
  id: z.string(), key: z.string(), parentId: z.string().nullable(),
  title: z.string(), blockType: z.enum(BLOCK_TYPES), displayOrder: z.number(),
  prompt: z.string().nullable(),
  requirements: z.array(SectionRequirementSchema),
  ownerId: z.string().nullable(), ownerName: z.string().nullable(), ownerUnresolved: z.boolean(),
  status: z.enum(SECTION_STATUSES), wordLimit: z.number().nullable(), wordCount: z.number().nullable(),
  columns: z.array(SectionColumnSchema).nullable(), datasetBinding: z.unknown().optional(),
  content: z.unknown(),
  lastDecision: SectionDecisionInfoSchema.nullable(),
  children: z.array(ReportSectionSchema),
}));
export interface ReportSection {
  id: string; key: string; parentId: string | null;
  title: string; blockType: BlockType; displayOrder: number;
  prompt: string | null;
  requirements: SectionRequirement[];
  ownerId: string | null; ownerName: string | null; ownerUnresolved: boolean;
  status: SectionStatus; wordLimit: number | null; wordCount: number | null;
  columns: SectionColumn[] | null; datasetBinding?: unknown;
  content: unknown;
  lastDecision: SectionDecisionInfo | null;
  children: ReportSection[];
}

export const ReportSummarySchema = z.object({
  id: z.string(), title: z.string(), status: z.enum(REPORT_STATUSES), round: z.number(),
  kind: z.enum(TEMPLATE_KINDS), language: z.string(),
  frameworkVersionId: z.string(), templateKey: z.string(), templateName: z.string(),
  engagementId: z.string().nullable(), subjectKind: z.enum(REPORT_SUBJECT_KINDS).nullable(), subjectId: z.string().nullable(),
  subjectName: z.string().nullable(),
  requiresAttestation: z.boolean(), wordLimit: z.number().nullable(),
  submittedRef: z.string().nullable(),
  sectionCount: z.number(), approvedSections: z.number(),
  createdAt: iso, updatedAt: iso,
});
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

export const ReportDetailSchema = ReportSummarySchema.extend({
  sections: z.array(ReportSectionSchema),
  wordCount: z.number(),
  snapshotId: z.string().nullable(),
});
export type ReportDetail = z.infer<typeof ReportDetailSchema>;

/**
 * The detail as the OpenAPI document describes it: the section tree is recursive, which the generator cannot expand
 * (see apps/api/src/routes/templates.ts), so the routes declare it as an array of opaque objects. Every response is
 * still validated with ReportDetailSchema in the service.
 */
export const ReportDetailDocSchema = ReportSummarySchema.extend({
  sections: z.array(z.unknown()),
  wordCount: z.number(),
  snapshotId: z.string().nullable(),
});

export const ReportFilterSchema = z.object({
  engagementId: z.uuid().optional(),
  subjectKind: z.enum(REPORT_SUBJECT_KINDS).optional(),
  subjectId: z.uuid().optional(),
  frameworkVersionId: z.uuid().optional(),
  status: z.enum(REPORT_STATUSES).optional(),
  q: z.string().trim().min(1).max(200).optional(),
}).strict();
export type ReportFilter = z.infer<typeof ReportFilterSchema>;

// ---- Snapshots and the round diff (PRD 10.4 step 4, 11.4; TASK-094) -----------------------------------------

/** One word-level piece of a section diff: what stayed, what the last round had, what this round adds. */
export interface DiffChunk { t: 'same' | 'add' | 'del'; s: string }

/** A section that changed since the previous round's snapshot; unchanged sections are not listed. */
export interface SectionDiff { key: string; title: string; chunks: DiffChunk[] }

/** Word-level diff of two texts: runs of non-whitespace compared by longest common subsequence, joined with single
 *  spaces (the diff is for reading, not for rebuilding the original). Sides over 4000 words collapse to one replace. */
export function diffWords(before: string, after: string): DiffChunk[] {
  const a = before.normalize('NFC').trim().split(/\s+/).filter((w) => w.length > 0);
  const b = after.normalize('NFC').trim().split(/\s+/).filter((w) => w.length > 0);
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return [{ t: 'add', s: b.join(' ') }];
  if (b.length === 0) return [{ t: 'del', s: a.join(' ') }];
  const n = a.length, m = b.length;
  const chunks: DiffChunk[] = [];
  const push = (t: DiffChunk['t'], w: string) => {
    const last = chunks[chunks.length - 1];
    if (last && last.t === t) last.s = `${last.s} ${w}`;
    else chunks.push({ t, s: w });
  };
  if (n > 4000 || m > 4000) {
    push('del', a.join(' ')); push('add', b.join(' '));
    return chunks;
  }
  // Longest common subsequence, table walked from the end; dp[i][j] = LCS length of a[i..] and b[j..].
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j] ? (dp[at(i + 1, j + 1)] ?? 0) + 1 : Math.max(dp[at(i + 1, j)] ?? 0, dp[at(i, j + 1)] ?? 0);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]!); i++; j++; }
    else if ((dp[at(i + 1, j)] ?? 0) >= (dp[at(i, j + 1)] ?? 0)) { push('del', a[i++]!); }
    else { push('add', b[j++]!); }
  }
  while (i < n) push('del', a[i++]!);
  while (j < m) push('add', b[j++]!);
  return chunks;
}

/** A cited evidence version in a snapshot: what an `[E:…]` or an appendix item pointed at, with its hash. */
export interface SnapshotEvidence {
  versionId: string; evidenceItemId: string; title: string; versionNo: number;
  fileName: string | null; sha256: string | null;
}

/** The approval that counts for a snapshot section: the latest `approved` decision (reopens start the review over). */
export interface SnapshotApproval { decidedBy: string; decidedByName: string | null; decidedAt: string }

export interface SnapshotSection {
  id: string; key: string; title: string; blockType: BlockType;
  wordCount: number | null;
  requirements: SectionRequirement[];
  approvals: SnapshotApproval[];
  content: unknown;
}

/** Everything the accreditor would see, frozen: the report, its sections and content, the cited evidence with hashes,
 *  the attestation, and the word-level changes against the previous round's snapshot (empty on the first round). */
export interface SnapshotManifest {
  report: {
    id: string; title: string; round: number; kind: TemplateKind; language: string;
    frameworkVersionId: string; templateKey: string; templateName: string;
    engagementId: string | null; subjectKind: ReportSubjectKind | null; subjectId: string | null;
    wordLimit: number | null; wordCount: number; requiresAttestation: boolean;
    approvedAt: string; approvedBy: string; approvedByName: string | null;
  };
  sections: SnapshotSection[];
  evidence: SnapshotEvidence[];
  attestation: { signatoryName: string | null; fileName: string | null } | null;
  changes: SectionDiff[];
}

export const SubmissionSnapshotSchema = z.object({
  id: z.string(), reportId: z.string(), round: z.number(),
  manifest: z.record(z.string(), z.unknown()),
  sha256: z.string(), createdAt: iso,
});
export type SubmissionSnapshot = z.infer<typeof SubmissionSnapshotSchema>;

/** The text a snapshot section is diffed on (plain text of a narrative; the rows of a table; labels of an appendix). */
export function diffableText(section: Pick<SnapshotSection, 'blockType' | 'content'>): string {
  const c = (section.content ?? {}) as { text?: unknown; rows?: unknown; items?: unknown; statement?: unknown };
  if (section.blockType === 'narrative') return typeof c.text === 'string' ? c.text : '';
  if (section.blockType === 'data_table' && Array.isArray(c.rows)) {
    return c.rows.map((r) => Object.values((r ?? {}) as Record<string, unknown>).join(' ')).join('\n');
  }
  if (section.blockType === 'appendix' && Array.isArray(c.items)) {
    return c.items.map((i) => String((i as { label?: unknown })?.label ?? '')).join('\n');
  }
  return typeof c.statement === 'string' ? c.statement : '';
}
