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
  frameworkVersionId: z.string(), frameworkName: z.string(), accreditorShortName: z.string(), edition: z.string(),
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

export const EngagementDetailSchema = z.object({
  engagement: EngagementSchema,
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
