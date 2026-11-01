// Assessment of learning: the IE-001 plan, course attainment (the QAIEO method), results, corrective actions, the ILO rotation
// (TASK-114..117, docs/assessment-of-learning-plan.md 2-6). Words: "at or above target" / "below target", never "met" (DEC-005).
import { z } from 'zod';

export const PLAN_STATUSES = ['draft', 'submitted', 'endorsed', 'returned'] as const;
export const RESULT_KINDS = ['direct', 'indirect'] as const;
export const ACTION_STATUSES = ['open', 'in_progress', 'implemented', 'verified', 'not_effective', 'closed'] as const;
const year = z.string().regex(/^\d{4}-\d{2}$/, 'an academic year like 2026-27');
const n = z.number().nullable();
const t = z.string().nullable();
const opt = <T extends z.ZodType>(x: T) => x.nullable().optional();

/** Institution targets; a plan item may set its own. All optional: the institution decides them. */
export const AssessmentBenchmarksSchema = z.object({
  /** CLO: score (% of the CLO's marks) a student must reach, and the share of students who must reach it. */
  cloScore: z.number().min(0).max(100).optional(), cloShare: z.number().min(0).max(100).optional(),
  ploScore: z.number().min(0).max(100).optional(), ploShare: z.number().min(0).max(100).optional(),
  /** Indirect measures: mean score on its scale (e.g. 4 of 5), and the response rate a survey needs to count. */
  indirectScore: z.number().min(0).optional(), indirectScale: z.number().positive().optional(), minResponseRate: z.number().min(0).max(100).optional(),
}).strict();
export type AssessmentBenchmarks = z.infer<typeof AssessmentBenchmarksSchema>;

// ---- Plan (TASK-114) ---------------------------------------------------------------------------------------------------------

export const PlanItemSchema = z.object({
  id: z.uuid(), ploId: z.uuid(), assessIn: t, directCourseId: z.uuid().nullable(), directMethod: t, directRubric: t, indirectMethod: t, indirectFrequency: t,
  indirectRespondents: t, targetScore: n, targetShare: n, benchmark: t, responsible: t, collectionWindow: t, submitBy: t, reassessIn: t,
});
export type PlanItem = z.infer<typeof PlanItemSchema>;
export const PlanIssueSchema = z.object({ ploId: z.uuid().nullable(), message: z.string() });
export const AssessmentPlanSchema = z.object({
  id: z.uuid(), programId: z.uuid(), academicYear: z.string(), status: z.enum(PLAN_STATUSES), coordinator: t, endorsedBy: t, submittedOn: t, endorsedOn: t, notes: t,
  items: z.array(PlanItemSchema),
  /** What IE-001 asks that the plan does not yet show (a PLO without a direct method, a direct course not at mastery, no target...). */
  issues: z.array(PlanIssueSchema),
});
export type AssessmentPlan = z.infer<typeof AssessmentPlanSchema>;
export const CreatePlanSchema = z.object({ academicYear: year, copyFrom: opt(year) });
export const UpdatePlanSchema = z.object({
  status: z.enum(PLAN_STATUSES).optional(), coordinator: opt(z.string().trim()), endorsedBy: opt(z.string().trim()), notes: opt(z.string().trim()),
}).strict();
export type UpdatePlan = z.infer<typeof UpdatePlanSchema>;
export const SavePlanItemSchema = z.object({
  assessIn: opt(z.string().trim()), directCourseId: opt(z.uuid()), directMethod: opt(z.string().trim()), directRubric: opt(z.string().trim()),
  indirectMethod: opt(z.string().trim()), indirectFrequency: opt(z.string().trim()), indirectRespondents: opt(z.string().trim()),
  targetScore: opt(z.number().min(0)), targetShare: opt(z.number().min(0).max(100)), benchmark: opt(z.string().trim()), responsible: opt(z.string().trim()),
  collectionWindow: opt(z.string().trim()), submitBy: opt(z.iso.date()), reassessIn: opt(z.string().trim()),
}).strict();
export type SavePlanItem = z.infer<typeof SavePlanItemSchema>;

// ---- Course attainment (TASK-115, the QAIEO method) ---------------------------------------------------------------------------

export const AssessmentPartSchema = z.object({ id: z.uuid().optional(), label: z.string().trim().min(1), marks: z.number().positive(), cloIds: z.array(z.uuid()) });
export const CourseAssessmentSchema = z.object({
  id: z.uuid(), courseId: z.uuid(), term: z.string(), name: z.string(), totalMarks: z.number(), classAverage: n, students: z.number().int().nullable(),
  parts: z.array(AssessmentPartSchema.extend({ id: z.uuid() })),
});
export type CourseAssessment = z.infer<typeof CourseAssessmentSchema>;
export const SaveCourseAssessmentSchema = z.object({
  term: z.string().trim().min(1), name: z.string().trim().min(1), totalMarks: z.number().positive(), classAverage: opt(z.number().min(0)), students: opt(z.number().int().min(0)),
  parts: z.array(AssessmentPartSchema).max(200),
});
export type SaveCourseAssessment = z.infer<typeof SaveCourseAssessmentSchema>;

export interface AttainmentRow { cloId: string; possible: number; achieved: number; attainment: number | null; weight: number }
export interface Attainment { clos: AttainmentRow[]; overall: number | null; unmapped: number; total: number }
/**
 * The QAIEO method (guidance 4.1, Table 2): in each assessment a part's marks are split equally among its CLOs; a CLO's achieved marks
 * are its share of the assessment times the class average. Summed over the assessments: per CLO the marks possible, achieved, the
 * attainment (%) and its weight in the course's assessment design (%). Marks on no CLO are "unmapped".
 */
export function computeAttainment(assessments: { totalMarks: number; classAverage: number | null; parts: { marks: number; cloIds: string[] }[] }[]): Attainment {
  const possible = new Map<string, number>(); const achieved = new Map<string, number>();
  let unmapped = 0; let total = 0;
  for (const a of assessments) {
    if (a.classAverage === null || a.totalMarks <= 0) continue;
    const ratio = a.classAverage / a.totalMarks;
    for (const p of a.parts) {
      total += p.marks;
      if (!p.cloIds.length) { unmapped += p.marks; continue; }
      const each = p.marks / p.cloIds.length;
      for (const c of p.cloIds) { possible.set(c, (possible.get(c) ?? 0) + each); achieved.set(c, (achieved.get(c) ?? 0) + each * ratio); }
    }
  }
  const mapped = [...possible.values()].reduce((s, v) => s + v, 0);
  const round = (v: number) => Math.round(v * 100) / 100;
  const clos = [...possible.entries()].map(([cloId, pos]) => ({
    cloId, possible: round(pos), achieved: round(achieved.get(cloId) ?? 0), attainment: pos ? round(((achieved.get(cloId) ?? 0) / pos) * 100) : null, weight: mapped ? round((pos / mapped) * 100) : 0,
  }));
  const ach = [...achieved.values()].reduce((s, v) => s + v, 0);
  return { clos, overall: mapped ? round((ach / mapped) * 100) : null, unmapped: round(unmapped), total: round(total) };
}

// ---- Results (TASK-115) and their standing against the target ------------------------------------------------------------------

export const OutcomeResultSchema = z.object({
  id: z.uuid(), outcomeId: z.uuid(), courseId: z.uuid().nullable(), term: z.string(), kind: z.enum(RESULT_KINDS), method: t,
  sampleSize: z.number().int().nullable(), studentsAtTarget: z.number().int().nullable(), shareAtTarget: n, meanScore: n, scaleMax: n, responseRate: n,
  source: t, notes: t, createdAt: z.string(),
  /** Against the plan item's target or the institution's: at_or_above, below, or none when no target applies. */
  standing: z.enum(['at_or_above', 'below', 'none']),
  target: z.string().nullable(),
});
export type OutcomeResult = z.infer<typeof OutcomeResultSchema>;
export const SaveResultSchema = z.object({
  outcomeId: z.uuid(), courseId: opt(z.uuid()), term: z.string().trim().min(1), kind: z.enum(RESULT_KINDS), method: opt(z.string().trim()),
  sampleSize: opt(z.number().int().min(0)), studentsAtTarget: opt(z.number().int().min(0)), shareAtTarget: opt(z.number().min(0).max(100)),
  meanScore: opt(z.number()), scaleMax: opt(z.number().positive()), responseRate: opt(z.number().min(0).max(100)), source: opt(z.string().trim()), notes: opt(z.string().trim()),
});
export type SaveResult = z.infer<typeof SaveResultSchema>;
/** Rows of a results sheet (a course report or survey export): the outcome by its code ("SO2", or "ECE 420 CLO3" for a CLO). */
export const ImportResultRowSchema = z.object({
  outcome: z.string().trim().min(1), term: z.string().trim().min(1), kind: z.enum(RESULT_KINDS), course: opt(z.string().trim()), method: opt(z.string().trim()),
  sampleSize: opt(z.number()), studentsAtTarget: opt(z.number()), shareAtTarget: opt(z.number()), meanScore: opt(z.number()), scaleMax: opt(z.number()), responseRate: opt(z.number()),
});
export type ImportResultRow = z.infer<typeof ImportResultRowSchema>;

/** The share of students at target from the counts when not given. */
export const shareOf = (r: { shareAtTarget: number | null; sampleSize: number | null; studentsAtTarget: number | null }) =>
  r.shareAtTarget ?? (r.sampleSize && r.studentsAtTarget !== null ? Math.round((r.studentsAtTarget / r.sampleSize) * 10000) / 100 : null);

/** Where a result stands against a target: the share of students when both are known, else the mean score. */
export function standingOf(r: { kind: 'direct' | 'indirect'; shareAtTarget: number | null; sampleSize: number | null; studentsAtTarget: number | null; meanScore: number | null },
  target: { score?: number | null; share?: number | null; indirectScore?: number | null }): { standing: 'at_or_above' | 'below' | 'none'; target: string | null } {
  const share = shareOf(r);
  if (r.kind === 'indirect') {
    if (target.indirectScore === undefined || target.indirectScore === null || r.meanScore === null) return { standing: 'none', target: null };
    return { standing: r.meanScore >= target.indirectScore ? 'at_or_above' : 'below', target: `mean ≥ ${target.indirectScore}` };
  }
  if (share !== null && target.share !== undefined && target.share !== null) {
    return { standing: share >= target.share ? 'at_or_above' : 'below', target: `${target.share}% of students${target.score !== null && target.score !== undefined ? ` at ≥ ${target.score}%` : ''}` };
  }
  if (r.meanScore !== null && target.score !== undefined && target.score !== null) return { standing: r.meanScore >= target.score ? 'at_or_above' : 'below', target: `score ≥ ${target.score}%` };
  return { standing: 'none', target: null };
}

// ---- Corrective actions (TASK-116) ------------------------------------------------------------------------------------------------

export const CorrectiveActionSchema = z.object({
  id: z.uuid(), programId: z.uuid(), outcomeId: z.uuid().nullable(), resultId: z.uuid().nullable(), gap: z.string(), rootCause: t, action: t, owner: t,
  implementIn: t, verificationPlan: t, status: z.enum(ACTION_STATUSES), verifiedResultId: z.uuid().nullable(), verificationNote: t, createdAt: z.string(),
});
export type CorrectiveAction = z.infer<typeof CorrectiveActionSchema>;
export const SaveActionSchema = z.object({
  outcomeId: opt(z.uuid()), resultId: opt(z.uuid()), gap: z.string().trim().min(1), rootCause: opt(z.string().trim()), action: opt(z.string().trim()),
  owner: opt(z.string().trim()), implementIn: opt(z.string().trim()), verificationPlan: opt(z.string().trim()), status: z.enum(ACTION_STATUSES).optional(),
  verifiedResultId: opt(z.uuid()), verificationNote: opt(z.string().trim()),
});
export type SaveAction = z.infer<typeof SaveActionSchema>;

/** Everything the program's Assessment card shows. */
export const ProgramAssessmentSchema = z.object({
  benchmarks: AssessmentBenchmarksSchema,
  plans: z.array(z.object({ id: z.uuid(), academicYear: z.string(), status: z.enum(PLAN_STATUSES) })),
  results: z.array(OutcomeResultSchema),
  actions: z.array(CorrectiveActionSchema),
  /** Below-target results with no corrective action yet: IE-001 says the cycle is incomplete without one. */
  openGaps: z.array(z.object({ resultId: z.uuid(), outcomeId: z.uuid(), term: z.string() })),
});
export type ProgramAssessment = z.infer<typeof ProgramAssessmentSchema>;

// ---- ILO rotation and the institutional report (TASK-117) -------------------------------------------------------------------------

export const IloScheduleRowSchema = z.object({ id: z.uuid(), iloId: z.uuid(), academicYear: z.string(), mechanism: t, indirectMeasure: t });
export type IloScheduleRow = z.infer<typeof IloScheduleRowSchema>;
export const SaveIloScheduleSchema = z.object({ iloId: z.uuid(), academicYear: year, mechanism: opt(z.string().trim()), indirectMeasure: opt(z.string().trim()) });
export type SaveIloSchedule = z.infer<typeof SaveIloScheduleSchema>;
/** Per ILO: when it is assessed, the PLOs linked to it across programs, and their latest direct results. */
export const IloReportSchema = z.object({
  schedule: z.array(IloScheduleRowSchema),
  ilos: z.array(z.object({
    iloId: z.uuid(), code: z.string(), text: z.string(), years: z.array(z.string()),
    plos: z.array(z.object({ ploId: z.uuid(), code: z.string(), programId: z.uuid(), program: z.string(), latest: OutcomeResultSchema.nullable() })),
    /** Programs with at least one linked PLO, and how many of their latest direct results are at or above target. */
    programs: z.number().int(), atOrAbove: z.number().int(), below: z.number().int(), noResult: z.number().int(),
  })),
  /** Missing: an ILO no program's PLO links to; years with no ILO scheduled in the five-year window. */
  issues: z.array(z.string()),
});
export type IloReport = z.infer<typeof IloReportSchema>;
