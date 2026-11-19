// Programs, courses and learning outcomes (TASK-104, TASK-105, TASK-112; docs/assessment-of-learning-plan.md, DEC-036).
import { z } from 'zod';
import { REQUIREMENT_BLOCKS } from './catalog.js';

export const PROGRAM_MODES = ['on_campus', 'online', 'blended'] as const;
export const COURSE_ROLES = ['core', 'elective', 'service'] as const;
/** ilo: institution; peo, plo: program; pi: performance indicator under a PLO; clo: course. */
export const OUTCOME_KINDS = ['ilo', 'peo', 'plo', 'pi', 'clo'] as const;
export const OUTCOME_STATUSES = ['draft', 'approved', 'retired'] as const;
export const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** One CLO-PLO mapping level (DEC-036). `aliases` are read as this level on import ("D" for R); exactly one level is mastery. */
export const OutcomeLevelSchema = z.object({
  code: z.string().trim().min(1).max(8),
  name: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1).max(8)).default([]),
  mastery: z.boolean(),
});
export type OutcomeLevel = z.infer<typeof OutcomeLevelSchema>;
export const OutcomeLevelsSchema = z.array(OutcomeLevelSchema).min(1).max(6).superRefine((ls, ctx) => {
  const codes = ls.flatMap((l) => [l.code, ...l.aliases].map((c) => c.toUpperCase()));
  if (new Set(codes).size !== codes.length) ctx.addIssue({ code: 'custom', message: 'level codes and aliases must all differ' });
  if (ls.filter((l) => l.mastery).length !== 1) ctx.addIssue({ code: 'custom', message: 'exactly one level is the mastery level' });
});
export const DEFAULT_OUTCOME_LEVELS: OutcomeLevel[] = [
  { code: 'I', name: 'Introduced', aliases: [], mastery: false },
  { code: 'R', name: 'Reinforced', aliases: ['D'], mastery: false },
  { code: 'M', name: 'Mastered', aliases: [], mastery: true },
];
/** The level a code or alias stands for ("d" -> "R"), or null. */
export function resolveOutcomeLevel(levels: OutcomeLevel[], code: string | null | undefined): string | null {
  const c = (code ?? '').trim().toUpperCase();
  if (!c) return null;
  return levels.find((l) => l.code.toUpperCase() === c || l.aliases.some((a) => a.toUpperCase() === c))?.code ?? null;
}

// ---- Courses ---------------------------------------------------------------------------------------------------------------

const num = z.coerce.number();
export const CourseSchema = z.object({
  id: z.uuid(),
  orgUnitId: z.uuid().nullable(),
  code: z.string(),
  externalId: z.string().nullable(),
  titleEn: z.string(),
  titleAr: z.string().nullable(),
  description: z.string().nullable(),
  credits: z.number().nullable(),
  level: z.number().int().nullable(),
  languageOfInstruction: z.string().nullable(),
  active: z.boolean(),
  /** The programs it serves (ids), for lists and filters. */
  programIds: z.array(z.uuid()),
  /** How it serves each program: core, elective or service, in which year and term. */
  placements: z.array(z.object({ programId: z.uuid(), role: z.enum(COURSE_ROLES), year: z.number().int().nullable(), term: z.number().int().nullable(), block: z.enum(REQUIREMENT_BLOCKS).nullable(), concentrationId: z.uuid().nullable() })),
  cloCount: z.number().int(),
  /** The course has approved content: its titles, credits, description, language and CLOs then change only through a course draft. */
  approved: z.boolean(),
  /** What the course record still lacks (Unit, Credit hours, Study plan): flagged, not refused, on import and the API. */
  missing: z.array(z.string()),
});
export type Course = z.infer<typeof CourseSchema>;
const opt = <T extends z.ZodType>(t: T) => t.nullable().optional();
export const CreateCourseSchema = z.object({
  orgUnitId: opt(z.uuid()),
  code: z.string().trim().min(1).max(40),
  externalId: opt(z.string().trim().min(1)),
  titleEn: z.string().trim().min(1),
  titleAr: opt(z.string().trim()),
  description: opt(z.string().trim()),
  credits: opt(num.min(0).max(60)),
  level: opt(num.int().min(0).max(9)),
  languageOfInstruction: opt(z.string().trim()),
});
export type CreateCourse = z.infer<typeof CreateCourseSchema>;
export const UpdateCourseSchema = CreateCourseSchema.partial().extend({ active: z.boolean().optional() }).strict();
export type UpdateCourse = z.infer<typeof UpdateCourseSchema>;

export const CourseProgramInputSchema = z.object({
  role: z.enum(COURSE_ROLES).default('core'),
  year: opt(num.int().min(1).max(9)),
  term: opt(num.int().min(1).max(4)),
  /** The block of the program's requirements the course sits in, and the concentration it is for (null: all). Left as they are when absent. */
  block: z.enum(REQUIREMENT_BLOCKS).nullable().optional(),
  concentrationId: z.uuid().nullable().optional(),
});
export type CourseProgramInput = z.infer<typeof CourseProgramInputSchema>;

// ---- Outcomes ----------------------------------------------------------------------------------------------------------------

export const LearningOutcomeSchema = z.object({
  id: z.uuid(),
  kind: z.enum(OUTCOME_KINDS),
  programId: z.uuid().nullable(),
  courseId: z.uuid().nullable(),
  parentId: z.uuid().nullable(),
  code: z.string(),
  textEn: z.string(),
  textAr: z.string().nullable(),
  bloomLevel: z.enum(BLOOM_LEVELS).nullable(),
  displayOrder: z.number().int(),
  status: z.enum(OUTCOME_STATUSES),
  approvedOn: z.string().nullable(),
  approvalRef: z.string().nullable(),
  source: z.string().nullable(),
});
export type LearningOutcome = z.infer<typeof LearningOutcomeSchema>;
export const CreateOutcomeSchema = z.object({
  kind: z.enum(OUTCOME_KINDS),
  programId: opt(z.uuid()),
  courseId: opt(z.uuid()),
  parentId: opt(z.uuid()),
  code: z.string().trim().min(1).max(40),
  textEn: z.string().trim().min(1),
  textAr: opt(z.string().trim()),
  bloomLevel: opt(z.enum(BLOOM_LEVELS)),
  displayOrder: z.number().int().optional(),
  status: z.enum(OUTCOME_STATUSES).optional(),
  approvedOn: opt(z.iso.date()),
  approvalRef: opt(z.string().trim()),
  source: opt(z.string().trim()),
});
export type CreateOutcome = z.infer<typeof CreateOutcomeSchema>;
export const UpdateOutcomeSchema = CreateOutcomeSchema.omit({ kind: true, programId: true, courseId: true, parentId: true }).partial().strict();
export type UpdateOutcome = z.infer<typeof UpdateOutcomeSchema>;

export const OutcomeLinkInputSchema = z.object({
  fromId: z.uuid(),
  toId: z.uuid(),
  /** CLO -> PLO only: a level code or alias; null for "linked, level not set". */
  level: z.string().trim().nullable().optional(),
});
export type OutcomeLinkInput = z.infer<typeof OutcomeLinkInputSchema>;
export const OutcomeLinkSchema = z.object({ fromId: z.uuid(), toId: z.uuid(), level: z.string().nullable() });
export type OutcomeLink = z.infer<typeof OutcomeLinkSchema>;

// ---- A program's outcomes, curriculum map and coverage -------------------------------------------------------------------

export const COVERAGE_ISSUES = [
  'plo_unmapped', 'plo_no_mastery', 'course_unmapped', 'clo_unmapped', 'plo_no_ilo', 'link_no_level',
  // The curriculum map built both ways (DEC-039): a course mapped top-down with no CLO behind it, top-down and CLO levels that differ,
  // and the syllabus rules' minimum and maximum PLOs and CLOs per course. Flags only: nothing is blocked.
  'course_map_no_clo', 'level_mismatch', 'course_plo_count', 'course_clo_count',
  // A PLO reached at a higher level in an earlier study year than at a lower one (mastered before it is introduced).
  'level_order',
] as const;
export const CoverageIssueSchema = z.object({
  kind: z.enum(COVERAGE_ISSUES),
  /** The outcome or course it is about. */
  refId: z.uuid(),
  label: z.string(),
  message: z.string(),
});
export type CoverageIssue = z.infer<typeof CoverageIssueSchema>;

export const ProgramCourseRowSchema = z.object({
  courseId: z.uuid(),
  code: z.string(),
  titleEn: z.string(),
  role: z.enum(COURSE_ROLES),
  year: z.number().int().nullable(),
  term: z.number().int().nullable(),
  clos: z.array(LearningOutcomeSchema),
});
export const ProgramOutcomesSchema = z.object({
  programId: z.uuid(),
  levels: z.array(OutcomeLevelSchema),
  peos: z.array(LearningOutcomeSchema),
  plos: z.array(LearningOutcomeSchema),
  indicators: z.array(LearningOutcomeSchema),
  ilos: z.array(LearningOutcomeSchema),
  courses: z.array(ProgramCourseRowSchema),
  /** Links that touch this program: CLO->PLO (its courses' CLOs to its PLOs), PLO->ILO, PLO->PEO. */
  links: z.array(OutcomeLinkSchema),
  /**
   * Curriculum map (DEC-039), per PLO and course: `topDown` is the level the course is mapped at directly (null when it is not), `levels`
   * the levels its CLOs reach (codes, in level order) and `highest` the highest of them. A cell is listed when either side has it.
   */
  map: z.array(z.object({ ploId: z.uuid(), courseId: z.uuid(), topDown: z.string().nullable(), levels: z.array(z.string()), highest: z.string().nullable() })),
  coverage: z.array(CoverageIssueSchema),
  /**
   * Changes waiting for approval (DEC-039): per course of the program with a syllabus in progress, the mapping it proposes (its CLOs with
   * their PLOs and levels, and its own level per PLO). The live map above is what is approved.
   */
  drafts: z.array(z.object({
    courseId: z.uuid(), versionId: z.uuid(), versionNo: z.number().int(), status: z.enum(['draft', 'in_review', 'endorsed']), errorCount: z.number().int(),
    clos: z.array(z.object({ id: z.string(), code: z.string(), textEn: z.string(), plos: z.array(z.object({ ploId: z.string(), level: z.string() })) })),
    coverage: z.array(z.object({ ploId: z.string(), level: z.string() })),
  })),
});
export type ProgramOutcomes = z.infer<typeof ProgramOutcomesSchema>;

/** Maps a course to a PLO top-down at one level (a code or alias of the institution's levels); null takes the mapping away. */
export const CourseMapInputSchema = z.object({ courseId: z.uuid(), outcomeId: z.uuid(), level: z.string().trim().min(1).max(20).nullable() });
export type CourseMapInput = z.infer<typeof CourseMapInputSchema>;
export const CourseMapSchema = z.object({ courseId: z.uuid(), outcomeId: z.uuid(), level: z.string().nullable() });
export type CourseMap = z.infer<typeof CourseMapSchema>;

// ---- Loading programs and outcomes from a workbook (the Integrated Assessment Plan) ----------------------------------------

const cell = z.string().trim().nullable().optional();
/** Rows of the workbook's Programs, PEOs and PLOs sheets, read in the browser (headers as in the workbook). */
export const OutcomesWorkbookSchema = z.object({
  programs: z.array(z.object({ programId: cell, title: z.string().trim().min(1), mission: cell, vision: cell, school: cell })).max(500),
  peos: z.array(z.object({ id: z.string().trim().min(1), text: z.string().trim().min(1), program: z.string().trim().min(1) })).max(5000),
  plos: z.array(z.object({ id: z.string().trim().min(1), text: z.string().trim().min(1), program: z.string().trim().min(1) })).max(5000),
  /** Where the rows came from, kept on each outcome ("Integrated Assessment Plan v3"). */
  source: z.string().trim().min(1).max(200),
  /** The Baseline Findings rows (program review by rubric, TASK-118); optional. */
  findings: z.array(z.lazy(() => ReviewWorkbookRowSchema)).max(5000).default([]),
  /** false: say what would happen and change nothing. */
  apply: z.boolean().default(false),
});
export type OutcomesWorkbook = z.input<typeof OutcomesWorkbookSchema>;
export const OutcomesWorkbookResultSchema = z.object({
  applied: z.boolean(),
  unitsCreated: z.array(z.string()),
  programsCreated: z.array(z.string()),
  programsUpdated: z.array(z.object({ program: z.string(), fields: z.array(z.string()) })),
  outcomesCreated: z.number().int(),
  outcomesUnchanged: z.number().int(),
  findingsAdded: z.number().int(),
  findingsUnchanged: z.number().int(),
  /** Rows left alone, with why (an outcome whose code exists with other words, an unknown program). Nothing is overwritten. */
  skipped: z.array(z.object({ sheet: z.string(), row: z.string(), reason: z.string() })),
});
export type OutcomesWorkbookResult = z.infer<typeof OutcomesWorkbookResultSchema>;

// ---- Program review by rubric (TASK-118) ---------------------------------------------------------------------------------

export const ReviewLevelSchema = z.object({ code: z.string().trim().min(1).max(40), name: z.string().trim().min(1), description: z.string().default('') });
export const ReviewCriterionSchema = z.object({ no: z.number().int().min(1).max(50), name: z.string().trim().min(1), questions: z.string().default(''), evidence: z.string().default('') });
/** The rubric and its maturity levels: configuration, not code. Levels are internal maturity, never an accreditation judgement. */
export const ReviewRubricSchema = z.object({ name: z.string().trim().min(1), levels: z.array(ReviewLevelSchema).min(1).max(8), criteria: z.array(ReviewCriterionSchema).min(1).max(50) });
export type ReviewRubric = z.infer<typeof ReviewRubricSchema>;
export const DEFAULT_REVIEW_RUBRIC: ReviewRubric = {
  "name": "Assessment of learning: program review",
  "levels": [
    {
      "code": "not_evident",
      "name": "Not evident",
      "description": "No documented practice found."
    },
    {
      "code": "emerging",
      "name": "Emerging",
      "description": "Some documents exist but are incomplete, inconsistent or not in use."
    },
    {
      "code": "developing",
      "name": "Developing",
      "description": "Documented and partly in use; gaps against the policy or the key questions."
    },
    {
      "code": "established",
      "name": "Established",
      "description": "Documented, current, in regular use, with evidence of review."
    },
    {
      "code": "pending",
      "name": "Pending review",
      "description": "Cannot be judged from the sources seen so far."
    }
  ],
  "criteria": [
    {
      "no": 1,
      "name": "Program mission",
      "questions": "Does the program have a published mission statement? Is it aligned with the university mission and its constituencies?",
      "evidence": "Program catalog, website, self-study"
    },
    {
      "no": 2,
      "name": "Educational objectives",
      "questions": "Are objectives clearly stated, measurable, consistent with stakeholder needs, and reviewed on a set cycle? Are changes over recent years documented?",
      "evidence": "Program document, advisory board minutes, review records"
    },
    {
      "no": 3,
      "name": "Program learning outcomes",
      "questions": "Are PLOs documented, measurable, and adequate in breadth and depth to achieve the objectives? Do they use appropriate cognitive levels and avoid overlap?",
      "evidence": "Approved program document, catalog"
    },
    {
      "no": 4,
      "name": "PLO-to-CLO mapping",
      "questions": "Is every PLO addressed by courses at introduced, reinforced and mastered levels? Does every course map to at least one PLO? Are there orphan or over-covered outcomes?",
      "evidence": "Curriculum map, course syllabi"
    },
    {
      "no": 5,
      "name": "Assessment design",
      "questions": "Is there a documented assessment plan with direct and indirect measures for each PLO, designated courses, a schedule, targets, and rubrics? Do course assessments actually test the CLOs?",
      "evidence": "Assessment plan, syllabi, assessment instruments"
    },
    {
      "no": 6,
      "name": "Assessment results",
      "questions": "Is the plan being carried out regularly? Are results collected and analyzed against targets for each PLO, with a stated sample and method?",
      "evidence": "Assessment reports, data sets, dashboards"
    },
    {
      "no": 7,
      "name": "Closing the loop",
      "questions": "Are findings used for action plans on curriculum, teaching and resources? Is there evidence of follow-up and re-assessment?",
      "evidence": "Action plans, committee minutes, revised syllabi"
    },
    {
      "no": 8,
      "name": "Stakeholder input and external validation",
      "questions": "Is there input from students, graduates, employers and industry? Have accreditor or external reviewer recommendations been addressed? Do indirect measures inform outcomes?",
      "evidence": "Surveys, advisory board records, review reports, accreditor observations"
    }
  ]
};

export const ReviewFindingSchema = z.object({
  id: z.uuid(), programId: z.uuid(), criterionNo: z.number().int(), level: z.string(), finding: z.string(), evidence: z.string().nullable(), gaps: z.string().nullable(),
  auditDate: z.string(), pass: z.number().int(), basis: z.string().nullable(), source: z.string().nullable(), createdAt: z.string(), createdByName: z.string().nullable(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export const AddReviewFindingSchema = z.object({
  criterionNo: z.number().int().min(1), level: z.string().trim().min(1), finding: z.string().trim().min(1), evidence: z.string().trim().nullable().optional(),
  gaps: z.string().trim().nullable().optional(), auditDate: z.iso.date().optional(), pass: z.number().int().min(1).max(99).optional(), basis: z.string().trim().nullable().optional(),
});
export type AddReviewFinding = z.infer<typeof AddReviewFindingSchema>;
/** The latest level per program and criterion, for the heatmap. */
export const ReviewSummarySchema = z.object({
  rubric: ReviewRubricSchema,
  programs: z.array(z.object({ programId: z.uuid(), name: z.string(), school: z.string().nullable(), levels: z.record(z.string(), z.string()), lastAudit: z.string().nullable() })),
});
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;
export const ProgramReviewSchema = z.object({ rubric: ReviewRubricSchema, findings: z.array(ReviewFindingSchema) });
export type ProgramReview = z.infer<typeof ProgramReviewSchema>;
/** Rows of the workbook's Baseline Findings sheet. A row identical to one already recorded is not added twice. */
export const ReviewWorkbookRowSchema = z.object({
  program: z.string().trim().min(1), criterionNo: z.number().int().min(1), level: z.string().trim().min(1), finding: z.string().trim().min(1),
  evidence: z.string().trim().nullable().optional(), gaps: z.string().trim().nullable().optional(), auditDate: z.string().trim().nullable().optional(),
  pass: z.number().int().min(1).max(99).optional(), basis: z.string().trim().nullable().optional(),
});
export type ReviewWorkbookRow = z.infer<typeof ReviewWorkbookRowSchema>;

// ---- The curriculum map as a matrix (DEC-039) --------------------------------------------------------------------------------

/** How a course reaches one outcome on the map: the level, how it was set, and (for an ILO) through which PLOs. */
export interface MatrixCell {
  level: string | null;
  /** top: the course is mapped directly; clo: only its CLOs; both: both, agreeing or not; via: an ILO, through PLOs. */
  from: 'top' | 'clo' | 'both' | 'via';
  /** A top-down level with no CLO behind it, or one that differs from the CLOs'. */
  warn: boolean;
  via: string[];
}
export interface MatrixRow { courseId: string; code: string; titleEn: string; role: string; year: number | null; term: number | null; cells: Record<string, MatrixCell> }
export interface CurriculumMatrix {
  plos: LearningOutcome[];
  ilos: LearningOutcome[];
  /** Courses grouped by study year, in year and term order; courses with no year last. */
  groups: { year: number | null; rows: MatrixRow[] }[];
  /** Per outcome id, how many courses reach it at each level code. */
  totals: Record<string, Record<string, number>>;
}

/**
 * The program's curriculum map as rows (courses, by study year) and columns (its PLOs, then the institution's ILOs). A PLO cell is the
 * course's own level when it is mapped top-down, else the highest its CLOs reach; an ILO cell is the highest level the course reaches
 * on the PLOs linked to that ILO. One function for the screen and the download.
 */
export function curriculumMatrix(v: ProgramOutcomes): CurriculumMatrix {
  const order = new Map(v.levels.map((l, i) => [l.code, i]));
  const higher = (a: string | null, b: string | null) => (!a ? b : !b ? a : (order.get(b) ?? -1) > (order.get(a) ?? -1) ? b : a);
  const plos = v.plos.filter((p) => p.status !== 'retired');
  const ilos = v.ilos.filter((i) => i.status !== 'retired');
  const totals: CurriculumMatrix['totals'] = {};
  const count = (id: string, level: string | null) => { if (level) { const t = (totals[id] ??= {}); t[level] = (t[level] ?? 0) + 1; } };
  const rows: MatrixRow[] = v.courses.map((c) => {
    const cloIds = new Set(c.clos.map((o) => o.id));
    const cells: Record<string, MatrixCell> = {};
    for (const p of plos) {
      const m = v.map.find((x) => x.ploId === p.id && x.courseId === c.courseId);
      if (!m) continue;
      const backed = v.links.some((l) => l.toId === p.id && cloIds.has(l.fromId));
      const level = m.topDown ?? m.highest;
      cells[p.id] = { level, from: m.topDown ? (backed ? 'both' : 'top') : 'clo', warn: !!m.topDown && (!backed || (!!m.highest && m.highest !== m.topDown)), via: [] };
      count(p.id, level);
    }
    for (const i of ilos) {
      let level: string | null = null; const via: string[] = [];
      for (const p of plos) {
        const cell = cells[p.id];
        if (!cell?.level || !v.links.some((l) => l.fromId === p.id && l.toId === i.id)) continue;
        level = higher(level, cell.level); via.push(p.code);
      }
      if (via.length) { cells[i.id] = { level, from: 'via', warn: false, via }; count(i.id, level); }
    }
    return { courseId: c.courseId, code: c.code, titleEn: c.titleEn, role: c.role, year: c.year, term: c.term, cells };
  });
  const years = [...new Set(rows.map((r) => r.year))].sort((a, b) => (a ?? 99) - (b ?? 99));
  return { plos, ilos, groups: years.map((year) => ({ year, rows: rows.filter((r) => r.year === year) })), totals };
}
