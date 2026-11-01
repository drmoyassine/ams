// Programs, courses and learning outcomes (TASK-104, TASK-105, TASK-112; docs/assessment-of-learning-plan.md, DEC-036).
import { z } from 'zod';

export const PROGRAM_MODES = ['full_time', 'part_time', 'online', 'blended'] as const;
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
  cloCount: z.number().int(),
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

export const COVERAGE_ISSUES = ['plo_unmapped', 'plo_no_mastery', 'course_unmapped', 'clo_unmapped', 'plo_no_ilo', 'link_no_level'] as const;
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
  /** Curriculum map: per PLO and course, the levels its CLOs reach (codes, in level order) and the highest. */
  map: z.array(z.object({ ploId: z.uuid(), courseId: z.uuid(), levels: z.array(z.string()), highest: z.string().nullable() })),
  coverage: z.array(CoverageIssueSchema),
});
export type ProgramOutcomes = z.infer<typeof ProgramOutcomesSchema>;
