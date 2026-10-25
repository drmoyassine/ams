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

// ---- Responses ----------------------------------------------------------------------------------------------

const iso = z.string();

export const SectionRequirementSchema = z.object({
  requirementId: z.string(), code: z.string(), title: z.string(),
});
export type SectionRequirement = z.infer<typeof SectionRequirementSchema>;

export const ReportSectionSchema: z.ZodType<ReportSection> = z.lazy(() => z.object({
  id: z.string(), key: z.string(), parentId: z.string().nullable(),
  title: z.string(), blockType: z.enum(BLOCK_TYPES), displayOrder: z.number(),
  prompt: z.string().nullable(),
  requirements: z.array(SectionRequirementSchema),
  ownerId: z.string().nullable(), ownerName: z.string().nullable(), ownerUnresolved: z.boolean(),
  status: z.enum(SECTION_STATUSES), wordLimit: z.number().nullable(), wordCount: z.number().nullable(),
  content: z.unknown(),
  children: z.array(ReportSectionSchema),
}));
export interface ReportSection {
  id: string; key: string; parentId: string | null;
  title: string; blockType: BlockType; displayOrder: number;
  prompt: string | null;
  requirements: SectionRequirement[];
  ownerId: string | null; ownerName: string | null; ownerUnresolved: boolean;
  status: SectionStatus; wordLimit: number | null; wordCount: number | null;
  content: unknown;
  children: ReportSection[];
}

export const ReportSummarySchema = z.object({
  id: z.string(), title: z.string(), status: z.enum(REPORT_STATUSES), round: z.number(),
  kind: z.enum(TEMPLATE_KINDS), language: z.string(),
  frameworkVersionId: z.string(), templateKey: z.string(), templateName: z.string(),
  engagementId: z.string().nullable(), subjectKind: z.enum(REPORT_SUBJECT_KINDS).nullable(), subjectId: z.string().nullable(),
  subjectName: z.string().nullable(),
  requiresAttestation: z.boolean(), wordLimit: z.number().nullable(),
  sectionCount: z.number(), approvedSections: z.number(),
  createdAt: iso, updatedAt: iso,
});
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

export const ReportDetailSchema = ReportSummarySchema.extend({
  sections: z.array(ReportSectionSchema),
  wordCount: z.number(),
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
