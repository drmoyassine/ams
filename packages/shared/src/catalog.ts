// The catalog's structure (DEC-046, step 2): what a degree is made of. General Education (one block for the institution, in areas with a
// minimum each), College requirements, the Major and the Concentration, each with core and elective credits; concentrations; elective
// slots in the study plan; minors as programs. The checks are flagged, never refused.
import { z } from 'zod';

export const PROGRAM_TYPES = ['degree', 'minor'] as const;
export type ProgramType = (typeof PROGRAM_TYPES)[number];
export const PROGRAM_TYPE_LABEL: Record<ProgramType, string> = { degree: 'Degree', minor: 'Minor' };

/** The blocks of a degree's requirements, in the order a catalog prints them. */
export const REQUIREMENT_BLOCKS = ['general_education', 'college', 'major', 'concentration'] as const;
export type RequirementBlock = (typeof REQUIREMENT_BLOCKS)[number];
export const BLOCK_LABEL: Record<RequirementBlock, string> = { general_education: 'General education', college: 'College requirements', major: 'Major requirements', concentration: 'Concentration requirements' };
export const REQUIREMENT_KINDS = ['core', 'elective'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

/** Institution-wide catalog settings: the credits of General Education. */
export const CatalogSettingsSchema = z.object({ genedCredits: z.number().min(0).max(200).nullable().default(null) }).strict();
export type CatalogSettings = z.infer<typeof CatalogSettingsSchema>;

const nullableNum = z.coerce.number().min(0).max(500).nullable().optional();

export const ConcentrationSchema = z.object({
  id: z.uuid(), programId: z.uuid(), code: z.string(), nameEn: z.string(), nameAr: z.string().nullable(), displayOrder: z.number().int(), active: z.boolean(),
});
export type Concentration = z.infer<typeof ConcentrationSchema>;
export const CreateConcentrationSchema = z.object({ programId: z.uuid(), code: z.string().trim().min(1).max(40), nameEn: z.string().trim().min(1), nameAr: z.string().trim().nullable().optional() });
export type CreateConcentration = z.infer<typeof CreateConcentrationSchema>;
export const UpdateConcentrationSchema = z.object({ code: z.string().trim().min(1).max(40).optional(), nameEn: z.string().trim().min(1).optional(), nameAr: z.string().trim().nullable().optional(), active: z.boolean().optional(), displayOrder: z.number().int().optional() }).strict();
export type UpdateConcentration = z.infer<typeof UpdateConcentrationSchema>;

export const GenedAreaSchema = z.object({
  id: z.uuid(), code: z.string(), nameEn: z.string(), nameAr: z.string().nullable(), minCredits: z.number(), displayOrder: z.number().int(), active: z.boolean(),
  /** The pool: the courses that count toward the area. */
  courseIds: z.array(z.uuid()),
});
export type GenedArea = z.infer<typeof GenedAreaSchema>;
export const CreateGenedAreaSchema = z.object({ code: z.string().trim().min(1).max(40), nameEn: z.string().trim().min(1), nameAr: z.string().trim().nullable().optional(), minCredits: z.coerce.number().min(0).max(100).default(0) });
export type CreateGenedArea = z.infer<typeof CreateGenedAreaSchema>;
export const UpdateGenedAreaSchema = z.object({ code: z.string().trim().min(1).max(40).optional(), nameEn: z.string().trim().min(1).optional(), nameAr: z.string().trim().nullable().optional(), minCredits: z.coerce.number().min(0).max(100).optional(), active: z.boolean().optional(), displayOrder: z.number().int().optional() }).strict();
export type UpdateGenedArea = z.infer<typeof UpdateGenedAreaSchema>;
export const SetAreaCoursesSchema = z.object({ courseIds: z.array(z.uuid()) }).strict();
export type SetAreaCourses = z.infer<typeof SetAreaCoursesSchema>;
export const GenedOverviewSchema = z.object({ settings: CatalogSettingsSchema, areas: z.array(GenedAreaSchema) });
export type GenedOverview = z.infer<typeof GenedOverviewSchema>;

/** The credits a program (or one concentration) asks of a block, core and elective. */
export const ProgramBlockSchema = z.object({ id: z.uuid(), programId: z.uuid(), concentrationId: z.uuid().nullable(), block: z.enum(REQUIREMENT_BLOCKS), requirement: z.enum(REQUIREMENT_KINDS), credits: z.number() });
export type ProgramBlock = z.infer<typeof ProgramBlockSchema>;
export const SetProgramBlockSchema = z.object({ programId: z.uuid(), concentrationId: z.uuid().nullable().optional(), block: z.enum(REQUIREMENT_BLOCKS), requirement: z.enum(REQUIREMENT_KINDS), credits: nullableNum }).strict();
export type SetProgramBlock = z.infer<typeof SetProgramBlockSchema>;

export const StudySlotSchema = z.object({
  id: z.uuid(), programId: z.uuid(), concentrationId: z.uuid().nullable(), block: z.enum(REQUIREMENT_BLOCKS), requirement: z.enum(REQUIREMENT_KINDS), areaId: z.uuid().nullable(), name: z.string(), rule: z.string().nullable(),
  credits: z.number(), year: z.number().int().nullable(), term: z.number().int().nullable(),
});
export type StudySlot = z.infer<typeof StudySlotSchema>;
export const CreateStudySlotSchema = z.object({
  programId: z.uuid(), concentrationId: z.uuid().nullable().optional(), block: z.enum(REQUIREMENT_BLOCKS), requirement: z.enum(REQUIREMENT_KINDS).default('elective'), areaId: z.uuid().nullable().optional(), name: z.string().trim().min(1),
  rule: z.string().trim().nullable().optional(), credits: z.coerce.number().positive().max(60), year: z.coerce.number().int().min(1).max(9).nullable().optional(), term: z.coerce.number().int().min(1).max(4).nullable().optional(),
});
export type CreateStudySlot = z.infer<typeof CreateStudySlotSchema>;
export const UpdateStudySlotSchema = CreateStudySlotSchema.omit({ programId: true }).partial().strict();
export type UpdateStudySlot = z.infer<typeof UpdateStudySlotSchema>;

/** One row of a program's study plan, as the requirements read it. */
export const StudyPlanCourseSchema = z.object({
  courseId: z.uuid(), code: z.string(), titleEn: z.string(), credits: z.number().nullable(), role: z.enum(['core', 'elective', 'service']), block: z.enum(REQUIREMENT_BLOCKS).nullable(),
  concentrationId: z.uuid().nullable(), year: z.number().int().nullable(), term: z.number().int().nullable(), areaIds: z.array(z.uuid()),
});
export type StudyPlanCourse = z.infer<typeof StudyPlanCourseSchema>;

export const REQUIREMENT_ISSUES = ['total_credits', 'gened_total', 'gened_area', 'block_credits', 'unplaced_course', 'no_concentration_credits', 'requisite_missing', 'requisite_order', 'requisite_cycle'] as const;
export const RequirementIssueSchema = z.object({ kind: z.enum(REQUIREMENT_ISSUES), message: z.string(), concentrationId: z.uuid().nullable().default(null), block: z.enum(REQUIREMENT_BLOCKS).nullable().default(null) });
export type RequirementIssue = z.infer<typeof RequirementIssueSchema>;
/** Credits asked and credits planned, for one block (and requirement) of a program or one of its concentrations. */
export const BlockTotalSchema = z.object({ concentrationId: z.uuid().nullable(), block: z.enum(REQUIREMENT_BLOCKS), requirement: z.enum(REQUIREMENT_KINDS), target: z.number().nullable(), planned: z.number() });
export type BlockTotal = z.infer<typeof BlockTotalSchema>;

/** A program's requirements as the page and the catalog read them: its concentrations, block credits, study plan, slots, and what the checks say. */
export const ProgramRequirementsSchema = z.object({
  programId: z.uuid(), programType: z.enum(PROGRAM_TYPES), credits: z.number().nullable(), genedCredits: z.number().nullable(),
  concentrations: z.array(ConcentrationSchema), blocks: z.array(ProgramBlockSchema), slots: z.array(StudySlotSchema), courses: z.array(StudyPlanCourseSchema),
  areas: z.array(GenedAreaSchema.omit({ courseIds: true }).extend({ planned: z.number() })),
  totals: z.array(BlockTotalSchema), issues: z.array(RequirementIssueSchema),
});
export type ProgramRequirements = z.infer<typeof ProgramRequirementsSchema>;
