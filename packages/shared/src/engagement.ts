// Inputs and outputs of the engagement API (PRD 8): one definition for the OpenAPI spec, the typed client and the SPA.
import { z } from 'zod';
import { ENGAGEMENT_KINDS, KEY_DATES, MILESTONE_TYPES, PHASE_TYPES } from './framework.js';

export const ENGAGEMENT_SUBJECT_TYPES = ['institution', 'program'] as const;
export const ENGAGEMENT_STATUSES = ['active', 'closed', 'withdrawn'] as const;
/** Roles a lead can give to an engagement member; the lead role itself only moves by handover. */
export const MEMBER_ROLES = ['co_lead', 'contributor', 'reviewer', 'viewer'] as const;
// `overdue` is computed from the due date, never stored (PRD 6.4).
export const MILESTONE_STATUSES = ['not_started', 'in_progress', 'done', 'skipped'] as const;
export const MILESTONE_ORIGINS = ['template', 'modified', 'local', 'decision', 'response'] as const;
export const ENGAGEMENT_REQUIREMENT_STATUSES = ['not_started', 'in_progress', 'ready_for_review', 'approved', 'needs_work'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const KeyDatesSchema = z.object(Object.fromEntries(KEY_DATES.map((k) => [k, isoDate.nullable().optional()])) as Record<(typeof KEY_DATES)[number], z.ZodOptional<z.ZodNullable<z.ZodString>>>).strict();

export const CreateEngagementSchema = z.object({
  frameworkVersionId: z.uuid(),
  subjectType: z.enum(ENGAGEMENT_SUBJECT_TYPES),
  subjectId: z.uuid(),
  kind: z.enum(ENGAGEMENT_KINDS),
  reviewYear: z.number().int().min(1990).max(2200),
  keyDates: KeyDatesSchema.optional(),
  /** Required: every engagement has exactly one lead from the start (PRD 4). */
  leadUserId: z.uuid(),
  title: z.string().min(1).optional(),
  previousEngagementId: z.uuid().optional(),
});
export type CreateEngagement = z.infer<typeof CreateEngagementSchema>;

export const UpdateEngagementSchema = z.object({
  title: z.string().min(1).optional(),
  reviewYear: z.number().int().min(1990).max(2200).optional(),
  keyDates: KeyDatesSchema.optional(),
});
export type UpdateEngagement = z.infer<typeof UpdateEngagementSchema>;

export const LOCAL_MILESTONE_TYPES = ['task', 'deliverable', 'submission', 'external_event'] as const;

export const UpdateMilestoneSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
  skipReason: z.string().nullable().optional(),
  /** Local milestones only. */
  phase: z.enum(PHASE_TYPES).optional(),
  /** Local deliverable milestones only: the report template this milestone produces. */
  deliverableTemplateKey: z.string().min(1).nullable().optional(),
}).strict();
export type UpdateMilestone = z.infer<typeof UpdateMilestoneSchema>;

export const AddMilestoneSchema = z.object({
  phase: z.enum(PHASE_TYPES),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  type: z.enum(LOCAL_MILESTONE_TYPES).default('task'),
  dueDate: isoDate.nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
  required: z.boolean().default(false),
  deliverableTemplateKey: z.string().min(1).optional(),
}).strict();
export type AddMilestone = z.infer<typeof AddMilestoneSchema>;

export const ReorderMilestonesSchema = z.object({ phase: z.enum(PHASE_TYPES), milestoneIds: z.array(z.uuid()).min(1) }).strict();
export type ReorderMilestones = z.infer<typeof ReorderMilestonesSchema>;

export const WithdrawSchema = z.object({ reason: z.string().trim().min(1) }).strict();

export const AddMemberSchema = z.object({ userId: z.uuid(), role: z.enum(MEMBER_ROLES) });
export type AddMember = z.infer<typeof AddMemberSchema>;
export const ChangeMemberSchema = z.object({ role: z.enum(MEMBER_ROLES) });
export const HandoverSchema = z.object({
  newLeadUserId: z.uuid(),
  /** What the outgoing lead becomes; null removes them from the engagement. */
  outgoingRole: z.enum(MEMBER_ROLES).nullable().default('co_lead'),
});
export type Handover = z.infer<typeof HandoverSchema>;

const iso = z.string();
export const EngagementSchema = z.object({
  id: z.string(), title: z.string(), kind: z.enum(ENGAGEMENT_KINDS), status: z.enum(ENGAGEMENT_STATUSES),
  reviewYear: z.number(), keyDates: z.record(z.string(), z.string().nullable()),
  currentPhase: z.enum(PHASE_TYPES).nullable(),
  subjectType: z.enum(ENGAGEMENT_SUBJECT_TYPES), subjectId: z.string(), subjectName: z.string(),
  frameworkVersionId: z.string(), frameworkId: z.string(), frameworkName: z.string(), accreditorShortName: z.string(), edition: z.string(),
  leadUserId: z.string(), leadName: z.string(),
  previousEngagementId: z.string().nullable(), templateSyncedVersionId: z.string().nullable(),
  createdAt: iso,
});
export type Engagement = z.infer<typeof EngagementSchema>;

export const MemberSchema = z.object({
  userId: z.string(), fullName: z.string(), email: z.string(), role: z.enum(['engagement_lead', ...MEMBER_ROLES]),
});
export type Member = z.infer<typeof MemberSchema>;

export const MilestoneSchema = z.object({
  id: z.string(), engagementId: z.string(), templateKey: z.string().nullable(),
  phase: z.enum(PHASE_TYPES), name: z.string(), description: z.string().nullable(), type: z.enum(MILESTONE_TYPES),
  dueDate: z.string().nullable(), dueRule: z.unknown().nullable(), dateNeeded: z.boolean(), overdue: z.boolean(),
  ownerId: z.string().nullable(), status: z.enum(MILESTONE_STATUSES), completedAt: iso.nullable(),
  deliverable: z.unknown().nullable(), sourceRef: z.unknown().nullable(), recurrence: z.unknown().nullable(),
  displayOrder: z.number(), origin: z.enum(MILESTONE_ORIGINS), locked: z.boolean(), required: z.boolean(), skipReason: z.string().nullable(),
});
export type Milestone = z.infer<typeof MilestoneSchema>;

export const PhaseSummarySchema = z.object({
  type: z.enum(PHASE_TYPES), name: z.string(),
  requiredTotal: z.number(), requiredDone: z.number(), milestoneCount: z.number(),
  current: z.boolean(),
});
export type PhaseSummary = z.infer<typeof PhaseSummarySchema>;

export const EngagementDetailSchema = z.object({
  engagement: EngagementSchema,
  phases: z.array(PhaseSummarySchema),
  /** Whether the lead can advance now: every required milestone of the current phase is done or skipped. */
  canAdvance: z.boolean(),
  members: z.array(MemberSchema),
  requirementCounts: z.object({ applicable: z.number(), notApplicable: z.number() }),
  milestones: z.array(MilestoneSchema),
});
export type EngagementDetail = z.infer<typeof EngagementDetailSchema>;

export const CreateEngagementResultSchema = z.object({
  engagement: EngagementSchema,
  requirementCounts: z.object({ applicable: z.number(), notApplicable: z.number() }),
  milestoneCount: z.number(),
});

// ---- Template update review (PRD 8.5) -------------------------------------------------------------------------

export const TEMPLATE_CHANGE_KINDS = ['added', 'removed', 'redated', 'changed'] as const;
export const TemplateChangeSchema = z.object({
  /** Stable: `<kind>:<template key>`. */
  id: z.string(),
  kind: z.enum(TEMPLATE_CHANGE_KINDS),
  templateKey: z.string(),
  name: z.string(),
  phase: z.enum(PHASE_TYPES),
  /** The milestone was changed locally, so accepting this change would not overwrite it and has no effect. */
  protectedByEdit: z.boolean(),
  /** A locked milestone cannot be removed from an engagement. */
  blocked: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
export type TemplateChange = z.infer<typeof TemplateChangeSchema>;

export const TemplateUpdateSchema = z.object({
  available: z.boolean(),
  fromVersion: z.object({ id: z.string(), edition: z.string() }),
  toVersion: z.object({ id: z.string(), edition: z.string() }).nullable(),
  changes: z.array(TemplateChangeSchema),
});
export type TemplateUpdate = z.infer<typeof TemplateUpdateSchema>;

export const ApplyTemplateUpdateSchema = z.object({
  toVersionId: z.uuid(),
  /** A decision for every change: accept or ignore, item by item. */
  decisions: z.record(z.string(), z.enum(['accept', 'ignore'])),
}).strict();
export type ApplyTemplateUpdate = z.infer<typeof ApplyTemplateUpdateSchema>;

// ---- Requirement workspace (PRD 8.4) --------------------------------------------------------------------------

export const NOTE_TYPES = ['guidance', 'evidence_expectation', 'data_request', 'quantitative_norm'] as const;
export const NOTE_AUTHORITIES = ['required', 'example', 'suggested', 'ai_suggested', 'institution_defined'] as const;

export const EngagementRequirementSchema = z.object({
  id: z.string(), engagementId: z.string(), requirementId: z.string(),
  code: z.string(), title: z.string(), levelLabel: z.string(), parentCode: z.string().nullable(), displayOrder: z.number(),
  applicable: z.boolean(), naReason: z.string().nullable(),
  ownerId: z.string().nullable(), reviewerId: z.string().nullable(),
  status: z.enum(ENGAGEMENT_REQUIREMENT_STATUSES), dueDate: z.string().nullable(),
});
export type EngagementRequirement = z.infer<typeof EngagementRequirementSchema>;

export const RequirementListSchema = z.object({
  items: z.array(EngagementRequirementSchema),
  /** Counts of applicable requirements by status. */
  byStatus: z.record(z.string(), z.number()),
});
export type RequirementList = z.infer<typeof RequirementListSchema>;

const sourceLink = z.object({ documentId: z.string(), page: z.number(), quote: z.string().nullable(), quoteVerified: z.boolean() }).nullable();

export const WorkspaceSchema = z.object({
  item: EngagementRequirementSchema,
  requirement: z.object({
    code: z.string(), title: z.string(), levelLabel: z.string(), officialText: z.string().nullable(), language: z.string(), translationEn: z.string().nullable(),
    path: z.array(z.object({ code: z.string(), title: z.string() })),
    source: sourceLink,
  }),
  notes: z.array(z.object({ id: z.string(), type: z.enum(NOTE_TYPES), text: z.string(), authority: z.enum(NOTE_AUTHORITIES), norm: z.unknown().nullable(), source: sourceLink })),
  workingNotes: z.string().nullable(),
  /** Statuses the caller may move this requirement to now. */
  allowedStatuses: z.array(z.enum(ENGAGEMENT_REQUIREMENT_STATUSES)),
  canAssign: z.boolean(),
  canEdit: z.boolean(),
  /** Report sections that cite this requirement: filled in when reports exist (M4). */
  reports: z.array(z.object({ reportId: z.string(), title: z.string(), sectionKey: z.string() })),
  history: z.array(z.object({ at: z.string(), actorName: z.string().nullable(), action: z.string(), changes: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })) })),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const UpdateRequirementWorkSchema = z.object({
  status: z.enum(ENGAGEMENT_REQUIREMENT_STATUSES).optional(),
  workingNotes: z.string().nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
  reviewerId: z.uuid().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
}).strict();
export type UpdateRequirementWork = z.infer<typeof UpdateRequirementWorkSchema>;

export const SetApplicabilitySchema = z.object({ applicable: z.boolean(), reason: z.string().trim().min(1, 'a reason is required') }).strict();
export type SetApplicability = z.infer<typeof SetApplicabilitySchema>;

export const AssignRequirementsSchema = z.object({
  requirementIds: z.array(z.uuid()).min(1),
  ownerId: z.uuid().nullable().optional(),
  reviewerId: z.uuid().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
}).strict();
export type AssignRequirements = z.infer<typeof AssignRequirementsSchema>;

export const UserSummarySchema = z.object({ id: z.string(), fullName: z.string(), email: z.string() });
export type UserSummary = z.infer<typeof UserSummarySchema>;
