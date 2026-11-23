// Quality Management as the IQF in operation (DEC-048): how often a standard asks for its evidence, who signs it off, and the
// submissions people make for their courses, programs and units. Nothing here says met, compliant or a score (DEC-005): a
// submission is "Internally approved" or "Returned for changes".
import { z } from 'zod';
import { isTimeZone } from './evidence.js';

// ---- Frequency ------------------------------------------------------------------------------------------------------------

/** 0 = Sunday … 6 = Saturday. */
const weekday = z.number().int().min(0).max(6);
/** 1st … 4th, or -1 for the last. */
const nth = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]);
const common = { timezone: z.string().trim().min(1).refine(isTimeZone, 'unknown time zone'), startDate: z.iso.date() };
/** A day of the month (1-31; a shorter month uses its last day) or the nth (or last) weekday of it. */
const dayOfMonth = z.union([z.object({ day: z.number().int().min(1).max(31) }).strict(), z.object({ nth, weekday }).strict()]);

/**
 * How often a standard asks for its evidence (the owner, 2026-11-23): every day; every week on a weekday (every Thursday); every
 * month on a day or the nth or last weekday (the last Monday); every semester in week N of each term of the academic calendar (week
 * 12, on a weekday or at the end of that week); every year in a month on a day or the nth or last weekday (the last Monday of
 * August). The due date ends the period it belongs to.
 */
export const FrequencyRuleSchema = z.discriminatedUnion('every', [
  z.object({ every: z.literal('day'), ...common }).strict(),
  z.object({ every: z.literal('week'), weekday, ...common }).strict(),
  z.object({ every: z.literal('month'), on: dayOfMonth, ...common }).strict(),
  z.object({ every: z.literal('semester'), week: z.number().int().min(1).max(30), weekday: weekday.optional(), ...common }).strict(),
  z.object({ every: z.literal('year'), month: z.number().int().min(1).max(12), on: dayOfMonth, ...common }).strict(),
]);
export type FrequencyRule = z.infer<typeof FrequencyRuleSchema>;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const NTH = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', [-1]: 'last' } as Record<number, string>;
const ord = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
const onText = (on: z.infer<typeof dayOfMonth>) => ('day' in on ? `on the ${ord(on.day)}` : `on the ${NTH[on.nth]} ${WEEKDAYS[on.weekday]}`);
/** The rule in words: "Every semester, week 12", "Every year, on the last Monday of August". */
export function describeFrequency(r: FrequencyRule): string {
  switch (r.every) {
    case 'day': return 'Every day';
    case 'week': return `Every week, on ${WEEKDAYS[r.weekday]}`;
    case 'month': return `Every month, ${onText(r.on)}`;
    case 'semester': return `Every semester, week ${r.week}${r.weekday !== undefined ? ` (${WEEKDAYS[r.weekday]})` : ''}`;
    case 'year': return `Every year, ${onText(r.on)} of ${MONTHS[r.month - 1]}`;
  }
}

// ---- Approval -------------------------------------------------------------------------------------------------------------

/**
 * A step a standard's submissions go through before the QA office and the champion, who always come last (the owner, 2026-11-23):
 * the coordinator of the course's program (or of the program itself), the head of the nearest unit of a type above the item (the
 * dean: the head of the College), or a named person.
 */
export const ApprovalStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('program_coordinator'), label: z.string().trim().min(1).max(80).optional() }).strict(),
  z.object({ kind: z.literal('unit_head'), unitType: z.string().trim().min(1).max(60), label: z.string().trim().min(1).max(80).optional() }).strict(),
  z.object({ kind: z.literal('person'), userId: z.uuid(), label: z.string().trim().min(1).max(80).optional() }).strict(),
]);
export type ApprovalStep = z.infer<typeof ApprovalStepSchema>;

const target = { frameworkId: z.uuid(), code: z.string().trim().min(1).max(200) };
/** Sets a standard's own frequency (`rule`), an opt-out of the inherited one (`optOut`), or neither: back to inherited. */
export const SetRequirementFrequencySchema = z.object({ ...target, rule: FrequencyRuleSchema.nullable().default(null), optOut: z.boolean().default(false) }).strict()
  .refine((x) => !(x.rule && x.optOut), { message: 'a frequency or an opt-out, not both' });
export type SetRequirementFrequency = z.input<typeof SetRequirementFrequencySchema>;
/** Sets a standard's own approval steps (the QA office and the champion follow them always); null: back to inherited. */
export const SetRequirementApprovalSchema = z.object({ ...target, steps: z.array(ApprovalStepSchema).max(10).nullable() }).strict();
export type SetRequirementApproval = z.infer<typeof SetRequirementApprovalSchema>;

/** Where a value comes from: the standard itself, or the code of the one it inherits from. */
export const QualitySourceSchema = z.object({ kind: z.enum(['own', 'parent']), code: z.string().nullable() });
/** A standard's frequency and approval steps: its own, what applies, and where that comes from. */
export const RequirementQualitySchema = z.object({
  code: z.string(),
  frequency: z.object({
    own: FrequencyRuleSchema.nullable(), optOut: z.boolean(),
    effective: FrequencyRuleSchema.nullable(), source: QualitySourceSchema.nullable(), text: z.string().nullable(),
  }),
  approval: z.object({ own: z.array(ApprovalStepSchema).nullable(), effective: z.array(ApprovalStepSchema), source: QualitySourceSchema.nullable() }),
});
export type RequirementQuality = z.infer<typeof RequirementQualitySchema>;

// ---- Submissions ----------------------------------------------------------------------------------------------------------

export const QUALITY_SUBJECT_KINDS = ['course', 'program', 'org_unit', 'institution'] as const;
export type QualitySubjectKind = (typeof QUALITY_SUBJECT_KINDS)[number];
/** Not started is a submission nobody has opened yet; the others are stored. */
export const SUBMISSION_STATUSES = ['not_started', 'draft', 'submitted', 'returned', 'approved'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];
export const SUBMISSION_STATUS_LABEL: Record<SubmissionStatus, string> = {
  not_started: 'Not started', draft: 'In progress', submitted: 'Submitted', returned: 'Returned for changes', approved: 'Internally approved',
};

export const SubmissionStepSchema = z.object({
  round: z.number(), ordinal: z.number(), kind: z.string(), label: z.string(),
  approvers: z.array(z.object({ id: z.string(), name: z.string() })),
  /** Nobody can take this step (no coordinator, no head, no QA office named): flagged, never guessed. */
  unresolved: z.boolean(),
  decision: z.enum(['pending', 'approved', 'returned', 'skipped']), decidedBy: z.string().nullable(), decidedAt: z.string().nullable(), note: z.string().nullable(),
});
export type SubmissionStep = z.infer<typeof SubmissionStepSchema>;

/** One evidence item a submission asks for, with what answers it. */
export const SubmissionEvidenceSchema = z.object({
  itemId: z.string(), title: z.string(), type: z.string(), method: z.string(),
  /** The standards it is linked to (the anchor or a sub-standard that shares its frequency). */
  codes: z.array(z.string()),
  versionId: z.string().nullable(), versionNo: z.number().nullable(), fileName: z.string().nullable(), asOfDate: z.string().nullable(),
  /** The newest version of the item, to reuse (for an item that is the same for everyone, such as a policy). */
  latestVersionId: z.string().nullable(), latestVersionNo: z.number().nullable(),
  /** A dataset's rows for this item and period (its course/program/unit column and its term column, when it has them). */
  rows: z.array(z.record(z.string(), z.unknown())).nullable(),
  note: z.string().nullable(),
});
export type SubmissionEvidence = z.infer<typeof SubmissionEvidenceSchema>;

export const SubmissionSummarySchema = z.object({
  /** null while not started. */
  id: z.string().nullable(),
  frameworkId: z.string(), code: z.string(), title: z.string(),
  subjectKind: z.enum(QUALITY_SUBJECT_KINDS), subjectId: z.string().nullable(), subjectName: z.string(),
  periodKey: z.string(), periodLabel: z.string(), periodStart: z.string(), dueAt: z.string(),
  status: z.enum(SUBMISSION_STATUSES), late: z.boolean(), dueSoon: z.boolean(),
  submitter: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** What the person may do: submit (they are the submitter), decide (the current step is theirs), or only read. */
  can: z.object({ edit: z.boolean(), submit: z.boolean(), decide: z.boolean() }),
  /** The step now waiting (its label), when submitted. */
  waitingOn: z.string().nullable(),
  evidenceDone: z.number(), evidenceTotal: z.number(),
});
export type SubmissionSummary = z.infer<typeof SubmissionSummarySchema>;
export const SubmissionDetailSchema = SubmissionSummarySchema.extend({
  evidence: z.array(SubmissionEvidenceSchema), steps: z.array(SubmissionStepSchema), round: z.number(),
});
export type SubmissionDetail = z.infer<typeof SubmissionDetailSchema>;

/** A standard as Quality Management shows it: read-only, with its sub-standards and what each asks for. */
export interface QualityStandardNode { code: string; title: string; statement: string | null; depth: number; frequency: string | null; evidence: { id: string; title: string }[]; children: QualityStandardNode[] }
export const QualityStandardNodeSchema: z.ZodType<QualityStandardNode> = z.lazy(() => z.object({
  code: z.string(), title: z.string(), statement: z.string().nullable(), depth: z.number(), frequency: z.string().nullable(),
  evidence: z.array(z.object({ id: z.string(), title: z.string() })), children: z.array(QualityStandardNodeSchema),
}));
/** One tab of Quality Management: a top-level IQF standard the person is linked to by scope (DEC-048). */
export const QualityTabSchema = z.object({
  frameworkId: z.string(), code: z.string(), title: z.string(),
  /** Why the person sees it: they submit, approve, or (administrators and the QA office) read it. */
  roles: z.array(z.enum(['submit', 'approve', 'read'])),
  toSubmit: z.number(), toApprove: z.number(),
});
export type QualityTab = z.infer<typeof QualityTabSchema>;
export const QualityTabsSchema = z.object({ frameworkId: z.string().nullable(), versionId: z.string().nullable(), tabs: z.array(QualityTabSchema) });
export type QualityTabs = z.infer<typeof QualityTabsSchema>;
export const QualityTabDetailSchema = z.object({
  standard: QualityStandardNodeSchema,
  /** The periods that can be shown, newest first (the current one first). */
  periods: z.array(z.object({ key: z.string(), label: z.string() })),
  submissions: z.array(SubmissionSummarySchema),
});
export type QualityTabDetail = z.infer<typeof QualityTabDetailSchema>;

export const SaveSubmissionEvidenceSchema = z.object({ itemId: z.uuid(), versionId: z.uuid().nullable(), note: z.string().trim().max(4000).nullable().optional() }).strict();
export type SaveSubmissionEvidence = z.infer<typeof SaveSubmissionEvidenceSchema>;
/** Opens (or returns) the submission of a standard for an item and a period. */
export const OpenSubmissionSchema = z.object({ frameworkId: z.uuid(), code: z.string().trim().min(1), subjectKind: z.enum(QUALITY_SUBJECT_KINDS), subjectId: z.uuid().nullable(), periodKey: z.string().trim().min(1).max(60) }).strict();
export type OpenSubmission = z.infer<typeof OpenSubmissionSchema>;
export const DecideSubmissionSchema = z.object({ decision: z.enum(['approved', 'returned']), note: z.string().trim().max(4000).optional() }).strict()
  .refine((x) => x.decision !== 'returned' || !!x.note, { message: 'say what to change when returning it' });
export type DecideSubmission = z.infer<typeof DecideSubmissionSchema>;
