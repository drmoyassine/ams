// Evidence (PRD 6.5, 9): items owned by the institution, versions that are never changed, links with a reason.
import { z } from 'zod';
import { DataColumnSchema } from './dataset.js';

/** A document (a file people read) or data (figures the system reads). Kinds within each come later as sub-types. */
export const EVIDENCE_TYPES = ['document', 'data'] as const;
export const CONFIDENTIALITY_LEVELS = ['public', 'internal', 'restricted'] as const;
const iso = z.string();

export const EvidenceVersionSchema = z.object({
  id: z.string(), versionNo: z.number(), fileName: z.string().nullable(), mime: z.string().nullable(), size: z.number().nullable(),
  sha256: z.string().nullable(), url: z.string().nullable(), asOfDate: z.string().nullable(), notes: z.string().nullable(), createdAt: iso,
  /** For data: how many rows this version holds; null for files and links. */
  rowCount: z.number().nullable(),
});
export type EvidenceVersion = z.infer<typeof EvidenceVersionSchema>;

export const EvidenceItemSchema = z.object({
  id: z.string(), title: z.string(), description: z.string().nullable(), type: z.enum(EVIDENCE_TYPES), subtype: z.string().nullable(),
  ownerUnitId: z.string().nullable(), ownerUserId: z.string().nullable(), periodLabel: z.string().nullable(),
  confidentiality: z.enum(CONFIDENTIALITY_LEVELS), containsStudentData: z.boolean(), tags: z.array(z.string()),
  status: z.enum(['active', 'archived']), latest: EvidenceVersionSchema.nullable(), linkCount: z.number(),
  /** Links not yet approved or rejected. */
  proposedLinkCount: z.number(),
  /** Open requests to fill in this data item's form. */
  openRequestCount: z.number(),
  /** For data: whether its form takes responses, and responses not yet added to the data. */
  formOpen: z.boolean(), pendingResponses: z.number(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/** What a link points at: a requirement of an engagement, or an item of the institution's own framework. */
export const LinkTargetSchema = z.object({
  kind: z.enum(['engagement', 'internal']), code: z.string(), title: z.string().nullable(),
  engagementRequirementId: z.string().nullable(), engagementId: z.string().nullable(), engagementTitle: z.string().nullable(),
});
export const EvidenceLinkSchema = z.object({
  id: z.string(), evidenceItemId: z.string(), evidenceTitle: z.string(), evidenceVersionId: z.string(), versionNo: z.number(),
  latestVersionNo: z.number(), newerVersionAvailable: z.boolean(), periodLabel: z.string().nullable(),
  /** The evidence is older than the review year allows (PRD 9.3); engagement links only. */
  stale: z.boolean(),
  target: LinkTargetSchema, rationale: z.string(), reviewStatus: z.enum(['proposed', 'approved', 'rejected']),
  reviewComment: z.string().nullable(), linkedByName: z.string().nullable(), reviewedByName: z.string().nullable(), createdAt: iso,
});
export type EvidenceLink = z.infer<typeof EvidenceLinkSchema>;

export const EvidenceDetailSchema = z.object({ item: EvidenceItemSchema, versions: z.array(EvidenceVersionSchema), links: z.array(EvidenceLinkSchema) });
export type EvidenceDetail = z.infer<typeof EvidenceDetailSchema>;

/** Evidence attached to an internal item that an external requirement is mapped to: offered, never linked by itself. */
export const EvidenceSuggestionSchema = z.object({
  evidenceItemId: z.string(), evidenceVersionId: z.string(), title: z.string(), versionNo: z.number(), periodLabel: z.string().nullable(),
  internalCode: z.string(), internalTitle: z.string().nullable(), relation: z.enum(['covers', 'partly_covers', 'related']), internalRationale: z.string(),
});
export type EvidenceSuggestion = z.infer<typeof EvidenceSuggestionSchema>;

export const CreateEvidenceSchema = z.object({
  title: z.string().trim().min(1), description: z.string().trim().optional(), type: z.enum(EVIDENCE_TYPES), subtype: z.string().trim().min(1).optional(),
  ownerUnitId: z.uuid().optional(), periodLabel: z.string().trim().min(1).optional(),
  confidentiality: z.enum(CONFIDENTIALITY_LEVELS).default('internal'), containsStudentData: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1)).default([]),
  /** For a link to a document kept elsewhere (e.g. SharePoint): registers version 1 with this address. */
  url: z.url().optional(),
}).strict();
export type CreateEvidence = z.input<typeof CreateEvidenceSchema>;

export const UpdateEvidenceSchema = z.object({
  title: z.string().trim().min(1).optional(), description: z.string().trim().nullable().optional(),
  /** A document becomes data (or back) only while it holds no versions of the other kind. */
  type: z.enum(EVIDENCE_TYPES).optional(),
  ownerUnitId: z.uuid().nullable().optional(), periodLabel: z.string().trim().nullable().optional(),
  confidentiality: z.enum(CONFIDENTIALITY_LEVELS).optional(), containsStudentData: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1)).optional(), status: z.enum(['active', 'archived']).optional(),
}).strict();
export type UpdateEvidence = z.infer<typeof UpdateEvidenceSchema>;

export const LinkEvidenceSchema = z.object({ evidenceVersionId: z.uuid(), rationale: z.string().trim().min(1, 'say why this evidence supports it') }).strict();
export type LinkEvidence = z.infer<typeof LinkEvidenceSchema>;
export const ReviewLinkSchema = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().trim().min(1).optional() }).strict();
export type ReviewLink = z.infer<typeof ReviewLinkSchema>;

/** The year a period label starts in ("AY2025-26" → 2025, "2024" → 2024), or null when it names none. */
export const periodYear = (label: string | null | undefined): number | null => {
  const m = /(19|20)\d{2}/.exec(label ?? '');
  return m ? Number(m[0]) : null;
};
/** PRD 9.3: evidence is stale for an engagement when its period starts before the review year minus this many years. */
export const STALE_AFTER_YEARS = 3;

// ---- Requests (DEC-018) --------------------------------------------------------------------------------------------

export const EVIDENCE_REQUEST_STATUSES = ['open', 'supplied', 'cancelled'] as const;
/** Days a one-time response link stays valid. */
export const REQUEST_LINK_DAYS = 30;

export const EvidenceRequestSchema = z.object({
  id: z.string(), internalCode: z.string().nullable(), internalTitle: z.string().nullable(),
  /** A form request: the data item whose form is to be filled in (else a file is asked for). */
  dataItemId: z.string().nullable(), dataItemTitle: z.string().nullable(), title: z.string(), message: z.string().nullable(),
  assigneeEmail: z.string(), assigneeName: z.string().nullable(), assigneeHasAccount: z.boolean(), dueDate: z.string().nullable(),
  status: z.enum(EVIDENCE_REQUEST_STATUSES), overdue: z.boolean(), requestedByName: z.string().nullable(), createdAt: z.string(),
  suppliedAt: z.string().nullable(), suppliedNote: z.string().nullable(), linkExpiresAt: z.string().nullable(),
  evidenceItemId: z.string().nullable(),
});
export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;

/** What a new request (or a new link for one) returns: the one-time link secret is shown once and never stored. */
export const IssuedRequestSchema = z.object({ request: EvidenceRequestSchema, linkToken: z.string().nullable() });
export type IssuedRequest = z.infer<typeof IssuedRequestSchema>;

export const CreateEvidenceRequestSchema = z.object({
  title: z.string().trim().min(1, 'say what is needed'),
  assigneeEmail: z.email('enter an email address').trim().toLowerCase(),
  message: z.string().trim().min(1).optional(),
  dueDate: z.iso.date().optional(),
}).strict();
export type CreateEvidenceRequest = z.infer<typeof CreateEvidenceRequestSchema>;

/** Ask one or more people to fill in a data item's form; each gets their own request. */
export const CreateFormRequestSchema = z.object({
  assigneeEmails: z.array(z.email('enter email addresses').trim().toLowerCase()).min(1, 'enter at least one email address').max(50),
  message: z.string().trim().min(1).optional(),
  dueDate: z.iso.date().optional(),
}).strict();
export type CreateFormRequest = z.infer<typeof CreateFormRequestSchema>;

/** What the one-time link page shows: only this request, and for a form request the form's questions. */
export const RequestByLinkSchema = z.object({
  title: z.string(), message: z.string().nullable(), dueDate: z.string().nullable(), internalCode: z.string().nullable(), internalTitle: z.string().nullable(),
  requestedByName: z.string().nullable(), institutionName: z.string(),
  form: z.object({ definition: z.string().nullable(), columns: z.array(DataColumnSchema) }).nullable(),
});
export type RequestByLink = z.infer<typeof RequestByLinkSchema>;
