// Academic calendar and cycle plans (TASK-081, DEC-029, docs/quality-management-plan.md "Worked examples"): the shapes the API, the
// SPA and the services share. A plan attaches a cycle template and a recurrence to an anchor; nodes of a standard inherit their
// nearest ancestor's plan, an external requirement follows its approved mapped IQF nodes' plans, and any level can override or opt
// out. Plans only PROPOSE runs; QA launches them (DEC-029). Nothing here says met, compliant or a score (DEC-005); nothing
// branches on an accreditor (DEC-002).
import { z } from 'zod';
import { CYCLE_ANCHOR_KINDS, CYCLE_SUBJECT_KINDS } from './cycles.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');
const text = z.string().trim();

// ---- Academic calendar (Settings -> Organization -> Institution) -------------------------------------------------------------

export const ACADEMIC_TERM_KINDS = ['term', 'year'] as const;
export type AcademicTermKind = (typeof ACADEMIC_TERM_KINDS)[number];

export const AcademicTermSchema = z.object({
  id: z.string(), name: z.string(), nameAr: z.string().nullable(), kind: z.enum(ACADEMIC_TERM_KINDS),
  startDate: z.string(), endDate: z.string(), active: z.boolean(), displayOrder: z.number(),
});
export type AcademicTerm = z.infer<typeof AcademicTermSchema>;
export const CreateAcademicTermSchema = z.object({
  name: text.min(1).max(80), nameAr: text.min(1).max(80).optional(), kind: z.enum(ACADEMIC_TERM_KINDS), startDate: day, endDate: day,
}).strict();
export type CreateAcademicTerm = z.infer<typeof CreateAcademicTermSchema>;
export const UpdateAcademicTermSchema = z.object({
  name: text.min(1).max(80).optional(), nameAr: text.max(80).nullable().optional(), startDate: day.optional(), endDate: day.optional(), active: z.boolean().optional(),
}).strict();
export type UpdateAcademicTerm = z.infer<typeof UpdateAcademicTermSchema>;
export const ReorderAcademicTermsSchema = z.object({ ids: z.array(z.uuid()).min(1).max(500) }).strict();
export type ReorderAcademicTerms = z.infer<typeof ReorderAcademicTermsSchema>;

// ---- CycleRecurrence ------------------------------------------------------------------------------------------------------------

export const RECURRENCE_UNITS = ['term', 'year', 'month'] as const;
export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number];

/**
 * `{ every: n, unit }`: every n-th term or year of the academic calendar, or every n months. `{ after: 'previous_ends', setBy: 'decision' }`:
 * the next run's date is set by a person when the previous one ends (an accreditor's decision fixes the next review: 6, 8 or 10
 * years); `dates` are the ones set so far, after the plan's first start.
 */
export const CycleRecurrenceSchema = z.union([
  z.object({ every: z.number().int().min(1).max(100), unit: z.enum(RECURRENCE_UNITS) }).strict(),
  z.object({ after: z.literal('previous_ends'), setBy: z.literal('decision'), dates: z.array(day).max(200).optional() }).strict(),
]);
export type CycleRecurrence = z.infer<typeof CycleRecurrenceSchema>;

/** Who a plan's runs are about, narrowing the node's scope: kinds, unit types, program levels, or an explicit list of unit/program ids. All empty = no narrowing. */
export const AppliesToSchema = z.object({
  kinds: z.array(z.enum(CYCLE_SUBJECT_KINDS)).max(3).optional(),
  unitTypes: z.array(z.string().min(1).max(60)).max(50).optional(),
  programLevels: z.array(z.string().min(1).max(60)).max(20).optional(),
  ids: z.array(z.uuid()).max(2000).optional(),
}).strict();
export type AppliesTo = z.infer<typeof AppliesToSchema>;

/** One period of a plan: when a run starts, when the period ends, and its label ("Fall 2026", "AY2026-27", "2026-2032"). */
export const PeriodSchema = z.object({ start: z.string(), end: z.string().nullable(), label: z.string() });
export type Period = z.infer<typeof PeriodSchema>;
/** A stretch of the horizon the calendar does not cover: said, never guessed. */
export const PeriodGapSchema = z.object({ from: z.string(), to: z.string(), reason: z.enum(['no_term', 'no_year', 'no_date']) });
export type PeriodGap = z.infer<typeof PeriodGapSchema>;

// ---- Plans -----------------------------------------------------------------------------------------------------------------

/** Where a plan can be attached. A requirement is named by its standard and code (like scope), so it carries over to new versions; `framework` is the whole standard (the IQF). */
export const PLAN_ANCHOR_KINDS = ['institution', 'org_unit', 'program', 'framework', 'requirement', 'evidence_item'] as const;
export type PlanAnchorKind = (typeof PLAN_ANCHOR_KINDS)[number];
export const PLAN_MODES = ['own', 'opt_out'] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

/** Names an anchor: `anchorId` for institution/unit/program/evidence item, `frameworkId` for a whole standard, `frameworkId` + `code` for a requirement. */
export const PlanTargetSchema = z.object({
  anchorKind: z.enum(PLAN_ANCHOR_KINDS), anchorId: z.uuid().optional(), frameworkId: z.uuid().optional(), code: z.string().trim().min(1).max(200).optional(),
}).strict();
export type PlanTarget = z.infer<typeof PlanTargetSchema>;

export const SetPlanSchema = PlanTargetSchema.extend({
  templateId: z.uuid(),
  mode: z.enum(PLAN_MODES).default('own'),
  recurrence: CycleRecurrenceSchema.optional(), firstStart: day.optional(),
  responsibleUnitId: z.uuid().nullable().optional(), ownerUserId: z.uuid().nullable().optional(),
  appliesTo: AppliesToSchema.default({}), active: z.boolean().default(true),
}).strict();
export type SetPlan = z.input<typeof SetPlanSchema>;

export const CyclePlanSchema = z.object({
  id: z.string(), anchorKind: z.enum(PLAN_ANCHOR_KINDS), anchorId: z.string().nullable(), frameworkId: z.string().nullable(), code: z.string().nullable(), anchorName: z.string().nullable(),
  templateId: z.string(), templateName: z.string(), mode: z.enum(PLAN_MODES),
  recurrence: CycleRecurrenceSchema.nullable(), firstStart: z.string().nullable(),
  responsibleUnitId: z.string().nullable(), responsibleUnitName: z.string().nullable(), ownerUserId: z.string().nullable(), ownerName: z.string().nullable(),
  appliesTo: AppliesToSchema, active: z.boolean(),
  /** The next run not yet launched (or skipped): its start date and label; null when there is none in the next two years or the calendar has a gap. */
  nextDue: z.string().nullable(), nextLabel: z.string().nullable(),
  /** The plan waits for a person to set the next date (recurrence "after the previous one ends"). */
  waitingForDate: z.boolean(),
  /** A stretch the calendar does not cover (the screen says "No term defined for that period"). */
  gap: PeriodGapSchema.nullable(),
  subjectCount: z.number(),
  /** The caller may change it. */
  canManage: z.boolean(),
});
export type CyclePlan = z.infer<typeof CyclePlanSchema>;

export const PlanSourceSchema = z.object({ kind: z.enum(['own', 'parent', 'iqf', 'framework']), code: z.string().nullable() });
export type PlanSource = z.infer<typeof PlanSourceSchema>;
/** What a node ends up with for one template, and where it comes from; `optedOut`: the node (or an ancestor) stopped inheriting it. */
export const EffectivePlanSchema = z.object({
  templateId: z.string(), templateName: z.string(), planId: z.string(), recurrence: CycleRecurrenceSchema.nullable(), firstStart: z.string().nullable(),
  source: PlanSourceSchema, /** For an `iqf` source: every mapped IQF code that gives this plan. */ sourceCodes: z.array(z.string()), optedOut: z.boolean(),
});
export type EffectivePlan = z.infer<typeof EffectivePlanSchema>;
export const OwnPlanSchema = z.object({ planId: z.string(), templateId: z.string(), templateName: z.string(), mode: z.enum(PLAN_MODES), recurrence: CycleRecurrenceSchema.nullable(), firstStart: z.string().nullable(), active: z.boolean() });
export type OwnPlan = z.infer<typeof OwnPlanSchema>;
/** The plans of one requirement: set on it, in effect (own, mapped, parent, whole-standard), and what "Back to inherited" would give. */
export const NodePlansSchema = z.object({ own: z.array(OwnPlanSchema), effective: z.array(EffectivePlanSchema), inherited: z.array(EffectivePlanSchema) });
export type NodePlans = z.infer<typeof NodePlansSchema>;

/** Plans set on a requirement or a whole standard, for the dialog. */
export const TargetPlansSchema = z.object({ own: z.array(CyclePlanSchema), effective: z.array(EffectivePlanSchema), inherited: z.array(EffectivePlanSchema) });
export type TargetPlans = z.infer<typeof TargetPlansSchema>;

export const SetNextDateSchema = z.object({ date: day }).strict();

// ---- Proposed runs ---------------------------------------------------------------------------------------------------------

export const DueRunSchema = z.object({
  planId: z.string(), planLabel: z.string(),
  templateId: z.string(), templateName: z.string(),
  /** The cycle's anchor as launching needs it (a standard version / requirement row for a standard plan). */
  anchorKind: z.enum(CYCLE_ANCHOR_KINDS), anchorId: z.string(), anchorName: z.string().nullable(),
  subjectKind: z.enum(CYCLE_SUBJECT_KINDS).nullable(), subjectId: z.string().nullable(), subjectName: z.string().nullable(),
  periodStart: z.string(), periodEnd: z.string().nullable(), periodLabel: z.string(),
  /** `due`: the period has begun; `upcoming`: it begins within the horizon. */
  state: z.enum(['due', 'upcoming']),
  responsibleUnitId: z.string().nullable(), responsibleUnitName: z.string().nullable(), ownerUserId: z.string().nullable(), ownerName: z.string().nullable(),
  /** The subject's previous run of the same plan, if any (what `previous_cycle` inputs will read). */
  previousCycleId: z.string().nullable(),
  /** Where the plan comes from, as an anchor label. */
  canLaunch: z.boolean(),
});
export type DueRun = z.infer<typeof DueRunSchema>;
export const DueGapSchema = z.object({ planId: z.string(), planLabel: z.string(), from: z.string(), to: z.string(), reason: z.enum(['no_term', 'no_year', 'no_date']) });
export type DueGap = z.infer<typeof DueGapSchema>;
export const DueRunsSchema = z.object({ runs: z.array(DueRunSchema), gaps: z.array(DueGapSchema), horizonDays: z.number() });
export type DueRuns = z.infer<typeof DueRunsSchema>;
export const DueRunsQuerySchema = z.object({
  horizonDays: z.coerce.number().int().min(0).max(1100).optional(), templateId: z.uuid().optional(), subjectId: z.uuid().optional(), planId: z.uuid().optional(), state: z.enum(['due', 'upcoming']).optional(),
});
export type DueRunsQuery = z.infer<typeof DueRunsQuerySchema>;
/** The default look-ahead for "Due to launch", in days. */
export const DUE_HORIZON_DAYS = 120;

export const SkipDueRunSchema = z.object({
  planId: z.uuid(), subjectKind: z.enum(CYCLE_SUBJECT_KINDS).nullable().default(null), subjectId: z.uuid().nullable().default(null),
  periodStart: day, reason: text.min(1).max(2000),
}).strict().refine((v) => (v.subjectKind === null) === (v.subjectId === null), { message: 'give the subject kind and id together, or neither', path: ['subjectId'] });
export type SkipDueRun = z.input<typeof SkipDueRunSchema>;
