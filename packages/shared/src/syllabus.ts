// The course syllabus (DEC-038, TASK-121): the AIU Course Syllabus Template as the course schema. A syllabus is one document per course
// and version; this file is its typed shape, the template (sections, help, which fields an admin may make optional), the settings
// (minimum and maximum CLOs and PLOs, escalation days) and ONE rule checker that the screen, the import and the API all use.
// A rule never blocks storing or importing a syllabus: it returns issues, which are flagged; only submitting for review is refused while
// an error stands. Named interfaces (not inferred object types) keep the API's route chain under the compiler's limit (TS7056).
import { z } from 'zod';
import { BLOOM_LEVELS, resolveOutcomeLevel, type OutcomeLevel } from './outcomes.js';

// ---- Vocabularies --------------------------------------------------------------------------------------------------------------

export const LANGUAGES_OF_DELIVERY = ['english', 'arabic', 'bilingual'] as const;
export const COURSE_TYPES = ['didactic', 'lab', 'studio', 'internship', 'independent_study', 'project'] as const;
export const COURSE_LEVELS = ['100', '200', '300', '400'] as const;
export const COURSE_CATEGORIES = ['general_education', 'program_core', 'program_elective', 'free_elective'] as const;
export const SUSTAINABILITY = ['focused', 'related', 'none'] as const;
export const MATERIAL_KINDS = ['textbook', 'recommended', 'material', 'software'] as const;
export const ASSESSMENT_CATEGORIES = ['quiz', 'assignment', 'midterm', 'final', 'project', 'lab', 'presentation', 'participation', 'other'] as const;
export const SDGS = Array.from({ length: 17 }, (_, i) => String(i + 1));
export const SYLLABUS_STATUSES = ['draft', 'in_review', 'endorsed', 'approved', 'superseded'] as const;
export type SyllabusStatus = (typeof SYLLABUS_STATUSES)[number];
/** The sections of the syllabus, in the order of AIU's template. */
export const SECTION_KEYS = ['info', 'description', 'clos', 'outline', 'materials', 'assessments', 'rubrics', 'methodology'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** Words for the vocabularies, shared by the screens and the Excel import and export. */
export const LABEL: Record<string, string> = {
  english: 'English', arabic: 'Arabic', bilingual: 'Bilingual',
  didactic: 'Didactic', lab: 'Lab', studio: 'Studio', internship: 'Internship', independent_study: 'Independent study', project: 'Project',
  general_education: 'General education', program_core: 'Program core', program_elective: 'Program elective', free_elective: 'Free elective',
  focused: 'Sustainability-focused', related: 'Sustainability-related', none: 'None',
  textbook: 'Required textbook', recommended: 'Recommended reading', material: 'Material', software: 'Software',
  quiz: 'Quiz', assignment: 'Assignment', midterm: 'Midterm exam', final: 'Final exam', presentation: 'Presentation', participation: 'Participation', other: 'Other',
  remember: 'Remember', understand: 'Understand', apply: 'Apply', analyze: 'Analyze', evaluate: 'Evaluate', create: 'Create',
  draft: 'Draft', in_review: 'In review', endorsed: 'Endorsed', approved: 'Approved', superseded: 'Superseded',
};

// ---- The document ------------------------------------------------------------------------------------------------------------

export interface SyllabusInfo {
  titleEn: string; titleAr: string; credits: number | null;
  languageOfDelivery: string; contactLecture: number | null; contactLab: number | null; contactOther: number | null;
  courseType: string; courseLevel: string; category: string; sustainability: string;
  prerequisiteIds: string[]; corequisiteIds: string[];
}
/** One CLO: its text, Bloom level, the ONE PLO it maps to and the coverage level (a code of the institution's levels: Introduced, Reinforced, Mastered). */
export interface SyllabusClo { id: string; code: string; textEn: string; textAr: string; bloom: string; ploId: string; level: string }
export interface SyllabusWeek { week: number | null; topic: string; reading: string; lab: string; cloIds: string[]; sdgs: string[]; assessmentId: string; activity: string }
export interface SyllabusMaterial { kind: string; citation: string; isbn: string; year: number | null }
/** The share of an assessment that goes to a CLO (percent of the assessment), and the rubric that scores it. */
export interface SyllabusAssessmentClo { cloId: string; share: number | null; rubricId: string }
export interface SyllabusAssessment { id: string; name: string; category: string; objective: string; weight: number | null; dueWeek: number | null; clos: SyllabusAssessmentClo[] }
export interface SyllabusRubric { id: string; title: string; levels: { name: string; min: number | null; max: number | null }[]; criteria: { name: string; descriptions: string[] }[] }
export interface SyllabusContent {
  info: SyllabusInfo; description: { en: string; ar: string };
  clos: SyllabusClo[]; outline: SyllabusWeek[]; materials: SyllabusMaterial[];
  assessments: SyllabusAssessment[]; rubrics: SyllabusRubric[];
  assessmentNotes: { passPercentage: string; howItWorks: string };
  methodology: string;
  /** Sections an admin added to the template (key to text). */
  custom: Record<string, string>;
}

const s = z.string().default('');
const n = z.number().nullable().default(null);
const strs = z.array(z.string()).default([]);
export const SyllabusContentSchema: z.ZodType<SyllabusContent, SyllabusContent> = z.object({
  info: z.object({
    titleEn: s, titleAr: s, credits: n, languageOfDelivery: s, contactLecture: n, contactLab: n, contactOther: n,
    courseType: s, courseLevel: s, category: s, sustainability: s, prerequisiteIds: strs, corequisiteIds: strs,
  }).default({ titleEn: '', titleAr: '', credits: null, languageOfDelivery: '', contactLecture: null, contactLab: null, contactOther: null, courseType: '', courseLevel: '', category: '', sustainability: '', prerequisiteIds: [], corequisiteIds: [] }),
  description: z.object({ en: s, ar: s }).default({ en: '', ar: '' }),
  clos: z.array(z.object({ id: z.string().min(1), code: s, textEn: s, textAr: s, bloom: s, ploId: s, level: s })).default([]),
  outline: z.array(z.object({ week: n, topic: s, reading: s, lab: s, cloIds: strs, sdgs: strs, assessmentId: s, activity: s })).default([]),
  materials: z.array(z.object({ kind: s, citation: s, isbn: s, year: n })).default([]),
  assessments: z.array(z.object({
    id: z.string().min(1), name: s, category: s, objective: s, weight: n, dueWeek: n,
    clos: z.array(z.object({ cloId: s, share: n, rubricId: s })).default([]),
  })).default([]),
  rubrics: z.array(z.object({
    id: z.string().min(1), title: s,
    levels: z.array(z.object({ name: s, min: n, max: n })).default([]),
    criteria: z.array(z.object({ name: s, descriptions: strs })).default([]),
  })).default([]),
  assessmentNotes: z.object({ passPercentage: s, howItWorks: s }).default({ passPercentage: '', howItWorks: '' }),
  methodology: s,
  custom: z.record(z.string(), z.string()).default({}),
}) as unknown as z.ZodType<SyllabusContent, SyllabusContent>;

export const emptySyllabus = (): SyllabusContent => SyllabusContentSchema.parse({});

// ---- Settings ------------------------------------------------------------------------------------------------------------------

/** The limits and the escalation of flagged syllabi: an institution setting (DEC-038). The coordinator is told at once; the chair, the Dean and the VPAA after these many days. */
export interface SyllabusSettings {
  minClos: number; maxClos: number; minPlos: number; maxPlos: number;
  /** A CLO carrying less than this share of the course grade is warned about. */
  minCloWeightPct: number;
  escalateDays: { chair: number; dean: number; vpaa: number };
}
export const DEFAULT_SYLLABUS_SETTINGS: SyllabusSettings = { minClos: 3, maxClos: 8, minPlos: 1, maxPlos: 5, minCloWeightPct: 5, escalateDays: { chair: 3, dean: 7, vpaa: 14 } };
const count = z.number().int().min(0).max(50);
export const SyllabusSettingsSchema: z.ZodType<SyllabusSettings, SyllabusSettings> = z.object({
  minClos: count, maxClos: count, minPlos: count, maxPlos: count, minCloWeightPct: z.number().min(0).max(100),
  escalateDays: z.object({ chair: z.number().int().min(0).max(365), dean: z.number().int().min(0).max(365), vpaa: z.number().int().min(0).max(365) }),
}).superRefine((v, ctx) => {
  if (v.minClos > v.maxClos) ctx.addIssue({ code: 'custom', path: ['minClos'], message: 'the minimum number of CLOs is above the maximum' });
  if (v.minPlos > v.maxPlos) ctx.addIssue({ code: 'custom', path: ['minPlos'], message: 'the minimum number of PLOs is above the maximum' });
  if (!(v.escalateDays.chair <= v.escalateDays.dean && v.escalateDays.dean <= v.escalateDays.vpaa)) ctx.addIssue({ code: 'custom', path: ['escalateDays'], message: 'escalation goes up the line: chair, then Dean, then VPAA' });
}) as unknown as z.ZodType<SyllabusSettings, SyllabusSettings>;

// ---- The template (configuration) --------------------------------------------------------------------------------------------

export interface SyllabusSectionDef { key: string; title: string; help: string; /** The rules depend on this section: it cannot be removed. */ locked: boolean }
/** Fields a coordinator must fill before submitting. An admin may make the unlocked ones optional (`optional` lists their keys). */
export interface SyllabusTemplate { sections: SyllabusSectionDef[]; optional: string[] }

/** The fields a template may mark optional. Everything else the checker asks for is locked: the CLOs, their PLO and coverage, the weights and the rubrics. */
export const OPTIONAL_FIELDS = [
  'info.titleAr', 'info.languageOfDelivery', 'info.courseType', 'info.courseLevel', 'info.category', 'info.sustainability', 'info.contact',
  'description.en', 'methodology', 'materials.textbook',
] as const;

/** The fields an admin may make optional, in words. */
export const OPTIONAL_FIELD_LABEL: Record<(typeof OPTIONAL_FIELDS)[number], string> = {
  'info.titleAr': 'Arabic course title', 'info.languageOfDelivery': 'Language of delivery', 'info.courseType': 'Course type', 'info.courseLevel': 'Course level', 'info.category': 'Course category',
  'info.sustainability': 'Sustainability indicator', 'info.contact': 'Contact hours', 'description.en': 'Course description', methodology: 'Teaching methodology', 'materials.textbook': 'A required textbook',
};
/** The built-in sections the rules depend on: they stay, in any order and under any name. The others are fixed too, but their fields may be optional. */
export const BUILT_IN_SECTIONS = SECTION_KEYS as readonly string[];
export const CUSTOM_PREFIX = 'custom:';
export const MAX_CUSTOM_SECTIONS = 12;

export const SyllabusTemplateSchema: z.ZodType<SyllabusTemplate, SyllabusTemplate> = z.object({
  sections: z.array(z.object({ key: z.string().min(1).max(60), title: z.string().trim().min(1).max(120), help: z.string().trim().max(1000).default(''), locked: z.boolean() })).min(SECTION_KEYS.length).max(SECTION_KEYS.length + MAX_CUSTOM_SECTIONS),
  optional: z.array(z.string()).default([]),
}).superRefine((t, ctx) => {
  const keys = t.sections.map((x) => x.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['sections'], message: 'a section appears twice' });
  for (const k of SECTION_KEYS) if (!keys.includes(k)) ctx.addIssue({ code: 'custom', path: ['sections'], message: `the section "${DEFAULT_SYLLABUS_TEMPLATE.sections.find((x) => x.key === k)?.title ?? k}" cannot be removed: the rules depend on it` });
  for (const x of t.sections) {
    if (!BUILT_IN_SECTIONS.includes(x.key) && !x.key.startsWith(CUSTOM_PREFIX)) ctx.addIssue({ code: 'custom', path: ['sections'], message: `unknown section ${x.key}` });
    if (BUILT_IN_SECTIONS.includes(x.key) && x.locked !== (DEFAULT_SYLLABUS_TEMPLATE.sections.find((d) => d.key === x.key)?.locked ?? false)) ctx.addIssue({ code: 'custom', path: ['sections'], message: `"${x.title}": whether the rules depend on a built-in section cannot be changed` });
  }
  for (const o of t.optional) if (!(OPTIONAL_FIELDS as readonly string[]).includes(o)) ctx.addIssue({ code: 'custom', path: ['optional'], message: `${o} cannot be made optional: the rules need it (CLOs, their PLO and coverage, the weights and the rubrics are always required)` });
}) as unknown as z.ZodType<SyllabusTemplate, SyllabusTemplate>;

export const DEFAULT_SYLLABUS_TEMPLATE: SyllabusTemplate = {
  optional: ['info.titleAr'],
  sections: [
    { key: 'info', title: 'Basic course information', locked: true, help: 'Course code and title (the English name is mandatory, also for Arabic-taught courses, because accreditors need it), language of delivery, credit and contact hours (lecture, lab, other), prerequisites and co-requisites, type, level, category and the sustainability indicator.' },
    { key: 'description', title: 'Course description', locked: false, help: 'Start with the course role (introductory, intermediate, advanced), state its purpose and scope and the major topics, the target audience, the key skills students gain, and how it connects theory to practice. Keep it concise and objective.' },
    { key: 'clos', title: 'Course learning outcomes (CLOs)', locked: true, help: 'One row per CLO with its Bloom level. Each CLO maps to one PLO and says whether it Introduces, Reinforces or Masters it.' },
    { key: 'outline', title: 'Course outline', locked: false, help: 'Week by week: topic and reading, lab or other sessions, the CLOs and SDGs it serves, and the assessment that falls in the week.' },
    { key: 'materials', title: 'Textbooks, materials and software', locked: false, help: 'Required and recommended reading in the approved citation format, and the software required.' },
    { key: 'assessments', title: 'Assessment plan', locked: true, help: 'Each assessment with its weight and due week, the CLOs it assesses (and their share) and the rubric that scores each CLO. Weights add up to 100%.' },
    { key: 'rubrics', title: 'Rubrics', locked: true, help: 'Each rubric has performance levels and criteria, with a description of each criterion at each level.' },
    { key: 'methodology', title: 'Teaching methodology', locked: false, help: 'How the course is taught: lectures, demonstrations, discussions, hands-on and project-based learning.' },
  ],
};

// ---- The rule checker ----------------------------------------------------------------------------------------------------------

export type IssueSeverity = 'error' | 'warning';
export interface SyllabusIssue { severity: IssueSeverity; code: string; section: SectionKey; message: string; /** The CLO, assessment, rubric or week the issue is about, by its id or number. */ ref?: string }
export interface SyllabusCheckContext {
  settings: SyllabusSettings; levels: OutcomeLevel[];
  /** The PLOs of the programs the course serves; when given, a CLO's PLO must be one of them. */
  allowedPloIds?: ReadonlySet<string> | undefined;
  /** How many programs the course serves (a course needs at least one). */
  programCount?: number | undefined;
  /** Template keys an admin made optional. */
  optional?: ReadonlySet<string> | undefined;
  /** Courses that exist, to check requisites. */
  knownCourseIds?: ReadonlySet<string> | undefined;
}

const blank = (v: string | null | undefined) => !v || !v.trim();
const sum = (xs: (number | null)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
const pct = (x: number) => `${Math.round(x * 100) / 100}%`;

/** The share of the course grade each CLO carries: the sum, over the assessments that assess it, of weight times the CLO's share. */
export function cloWeights(c: SyllabusContent): Map<string, number> {
  const w = new Map<string, number>(c.clos.map((x) => [x.id, 0]));
  for (const a of c.assessments) for (const l of a.clos) if (w.has(l.cloId)) w.set(l.cloId, w.get(l.cloId)! + ((a.weight ?? 0) * (l.share ?? 0)) / 100);
  return w;
}

/**
 * Every rule, in one place. Errors stop a submission for review; warnings do not; neither stops an import or an upsert.
 * An issue says where it is (`section`, `ref`) so the editor can show it beside the field.
 */
export function checkSyllabus(c: SyllabusContent, ctx: SyllabusCheckContext): SyllabusIssue[] {
  const issues: SyllabusIssue[] = [];
  const opt = ctx.optional ?? new Set<string>();
  const add = (severity: IssueSeverity, code: string, section: SectionKey, message: string, ref?: string) => issues.push({ severity, code, section, message, ...(ref !== undefined ? { ref } : {}) });
  const need = (key: string, empty: boolean, code: string, section: SectionKey, message: string) => { if (empty && !opt.has(key)) add('error', code, section, message); };
  const { settings: st } = ctx;
  const i = c.info;

  // -- Basic information
  need('info.titleEn', blank(i.titleEn), 'info.title', 'info', 'The English course title is required (also for Arabic-taught courses).');
  need('info.titleAr', blank(i.titleAr), 'info.titleAr', 'info', 'The Arabic course title is missing.');
  if (i.credits === null || i.credits <= 0) add('error', 'info.credits', 'info', 'Credit hours are required.');
  need('info.languageOfDelivery', blank(i.languageOfDelivery), 'info.language', 'info', 'The language of delivery is required.');
  need('info.contact', i.contactLecture === null && i.contactLab === null && i.contactOther === null, 'info.contact', 'info', 'Contact hours (lecture, lab, other) are required.');
  need('info.courseType', blank(i.courseType), 'info.type', 'info', 'The course type is required.');
  need('info.courseLevel', blank(i.courseLevel), 'info.level', 'info', 'The course level is required.');
  need('info.category', blank(i.category), 'info.category', 'info', 'The course category is required.');
  need('info.sustainability', blank(i.sustainability), 'info.sustainability', 'info', 'The sustainability indicator is required.');
  if (ctx.programCount !== undefined && ctx.programCount < 1) add('error', 'info.programs', 'info', 'The course serves no program: put it in at least one program.');
  const contact = sum([i.contactLecture, i.contactLab, i.contactOther]);
  if (i.credits !== null && i.credits > 0 && (i.contactLecture !== null || i.contactLab !== null || i.contactOther !== null) && contact < i.credits) {
    add('warning', 'info.contactHours', 'info', `Contact hours (${contact}) are fewer than the credit hours (${i.credits}); they should align with the credit hour policy.`);
  }
  if (ctx.knownCourseIds) for (const id of [...i.prerequisiteIds, ...i.corequisiteIds]) if (!ctx.knownCourseIds.has(id)) add('error', 'info.requisite', 'info', 'A prerequisite or co-requisite is not a course of the institution.', id);

  // -- Description and methodology
  need('description.en', blank(c.description.en), 'description.missing', 'description', 'The course description is required.');
  need('methodology', blank(c.methodology), 'methodology.missing', 'methodology', 'The teaching methodology is required.');

  // -- CLOs, their PLO and coverage level
  const n = c.clos.length;
  if (n < st.minClos) add('error', 'clos.min', 'clos', `The course has ${n} CLO${n === 1 ? '' : 's'}; at least ${st.minClos} are required.`);
  if (n > st.maxClos) add('error', 'clos.max', 'clos', `The course has ${n} CLOs; at most ${st.maxClos} are allowed.`);
  const plos = new Set(c.clos.map((x) => x.ploId).filter(Boolean));
  if (plos.size < st.minPlos) add('error', 'plos.min', 'clos', `The CLOs map to ${plos.size} PLO${plos.size === 1 ? '' : 's'}; at least ${st.minPlos} are required.`);
  if (plos.size > st.maxPlos) add('error', 'plos.max', 'clos', `The CLOs map to ${plos.size} PLOs; at most ${st.maxPlos} are allowed.`);
  const seen = new Set<string>();
  for (const x of c.clos) {
    const label = x.code || 'A CLO';
    if (seen.has(x.id)) add('error', 'clos.duplicate', 'clos', `${label} appears twice.`, x.id);
    seen.add(x.id);
    if (blank(x.textEn)) add('error', 'clo.text', 'clos', `${label} has no text.`, x.id);
    if (!(BLOOM_LEVELS as readonly string[]).includes(x.bloom)) add('error', 'clo.bloom', 'clos', `${label} has no Bloom level.`, x.id);
    if (blank(x.ploId)) add('error', 'clo.plo', 'clos', `${label} is not mapped to a PLO.`, x.id);
    else if (ctx.allowedPloIds && !ctx.allowedPloIds.has(x.ploId)) add('error', 'clo.ploInvalid', 'clos', `${label} is mapped to a PLO of a program this course does not serve.`, x.id);
    if (blank(x.level)) add('error', 'clo.level', 'clos', `${label} has no coverage level (Introduced, Reinforced or Mastered).`, x.id);
    else if (!resolveOutcomeLevel(ctx.levels, x.level)) add('error', 'clo.levelInvalid', 'clos', `${label} has an unknown coverage level "${x.level}".`, x.id);
  }

  // -- Outline
  const cloIds = new Set(c.clos.map((x) => x.id));
  const weeks = new Set<number>();
  for (const w of c.outline) {
    const ref = w.week === null ? undefined : String(w.week);
    if (w.week === null || !Number.isInteger(w.week) || w.week < 1) add('error', 'outline.week', 'outline', 'A week has no valid number.');
    else if (weeks.has(w.week)) add('error', 'outline.duplicateWeek', 'outline', `Week ${w.week} appears twice.`, ref);
    else weeks.add(w.week);
    if (blank(w.topic)) add('error', 'outline.topic', 'outline', `Week ${w.week ?? '?'} has no topic.`, ref);
    for (const id of w.cloIds) if (!cloIds.has(id)) add('error', 'outline.clo', 'outline', `Week ${w.week ?? '?'} maps to a CLO the course does not have.`, ref);
    if (!w.cloIds.length && !blank(w.topic) && !/exam|quiz|review|midterm|final/i.test(w.topic)) add('warning', 'outline.noClo', 'outline', `Week ${w.week ?? '?'} is not mapped to any CLO.`, ref);
  }

  // -- Materials
  need('materials.textbook', !c.materials.some((m) => m.kind === 'textbook' && !blank(m.citation)), 'materials.textbook', 'materials', 'At least one required textbook is needed.');

  // -- Assessment plan
  const rubricIds = new Set(c.rubrics.map((r) => r.id));
  const total = sum(c.assessments.map((a) => a.weight));
  if (!c.assessments.length) add('error', 'assessments.none', 'assessments', 'The course has no assessments.');
  else if (!near(total, 100)) add('error', 'assessments.total', 'assessments', `The assessment weights add up to ${pct(total)}, not 100%.`);
  const assessed = new Set<string>();
  for (const a of c.assessments) {
    const label = a.name || 'An assessment';
    if (blank(a.name)) add('error', 'assessment.name', 'assessments', 'An assessment has no name.', a.id);
    if (!(ASSESSMENT_CATEGORIES as readonly string[]).includes(a.category)) add('error', 'assessment.category', 'assessments', `${label} has no category.`, a.id);
    if (a.weight === null || a.weight < 0) add('error', 'assessment.weight', 'assessments', `${label} has no weight.`, a.id);
    if (a.dueWeek === null || !Number.isInteger(a.dueWeek) || a.dueWeek < 1) add('error', 'assessment.dueWeek', 'assessments', `${label} has no due week.`, a.id);
    if (!a.clos.length) {
      if (a.category !== 'participation') add('error', 'assessment.noClo', 'assessments', `${label} assesses no CLO.`, a.id);
      continue;
    }
    const shares = sum(a.clos.map((l) => l.share));
    if (!near(shares, 100)) add('error', 'assessment.shares', 'assessments', `The CLO shares of ${label} add up to ${pct(shares)}, not 100%.`, a.id);
    for (const l of a.clos) {
      if (!cloIds.has(l.cloId)) { add('error', 'assessment.clo', 'assessments', `${label} assesses a CLO the course does not have.`, a.id); continue; }
      assessed.add(l.cloId);
      const code = c.clos.find((x) => x.id === l.cloId)?.code ?? 'a CLO';
      if (blank(l.rubricId)) add('error', 'assessment.rubric', 'assessments', `${label} has no rubric for ${code}.`, a.id);
      else if (!rubricIds.has(l.rubricId)) add('error', 'assessment.rubricUnknown', 'assessments', `${label} uses a rubric that is not in the syllabus (${code}).`, a.id);
    }
  }
  for (const x of c.clos) if (!assessed.has(x.id)) add('error', 'clo.notAssessed', 'assessments', `${x.code || 'A CLO'} is not assessed by any assessment.`, x.id);
  const weights = cloWeights(c);
  for (const x of c.clos) {
    const w = weights.get(x.id) ?? 0;
    if (assessed.has(x.id) && w < st.minCloWeightPct) add('warning', 'clo.lowWeight', 'assessments', `${x.code || 'A CLO'} carries only ${pct(w)} of the grade; the design may not measure it well.`, x.id);
  }

  // -- Rubrics
  for (const r of c.rubrics) {
    const label = r.title || 'A rubric';
    if (blank(r.title)) add('error', 'rubric.title', 'rubrics', 'A rubric has no title.', r.id);
    if (r.levels.length < 2) add('error', 'rubric.levels', 'rubrics', `${label} needs at least two performance levels.`, r.id);
    if (r.levels.some((l) => blank(l.name))) add('error', 'rubric.levelName', 'rubrics', `${label} has a level with no name.`, r.id);
    if (!r.criteria.length) add('error', 'rubric.criteria', 'rubrics', `${label} has no criteria.`, r.id);
    else if (r.criteria.some((k) => blank(k.name) || r.levels.some((_, j) => blank(k.descriptions[j])))) add('error', 'rubric.descriptions', 'rubrics', `${label}: every criterion needs a name and a description at every level.`, r.id);
  }
  return issues;
}

export const errorsOf = (issues: SyllabusIssue[]) => issues.filter((x) => x.severity === 'error');

// ---- What the services return and take --------------------------------------------------------------------------------------

export interface SyllabusVersion {
  id: string; courseId: string; versionNo: number; status: SyllabusStatus; content: SyllabusContent;
  issues: SyllabusIssue[]; errorCount: number; warningCount: number;
  /** When the syllabus first had an error, and how far up the line the flag has gone (0 coordinator, 1 chair, 2 Dean, 3 VPAA). */
  flaggedSince: string | null; escalationLevel: number;
  effectiveFrom: string | null; source: string | null; returnedNote: string | null;
  submittedAt: string | null; endorsedAt: string | null; approvedAt: string | null;
  submittedByName: string | null; endorsedByName: string | null; approvedByName: string | null; updatedAt: string;
}
export interface SyllabusSuggestion { id: string; versionId: string; section: string; suggestion: string; status: 'open' | 'accepted' | 'declined'; byName: string | null; createdAt: string; resolutionNote: string | null }
export interface SyllabusPlo { id: string; code: string; textEn: string; programId: string; programName: string }
/** Everything the course's Syllabus tab needs, in one read. */
export interface SyllabusOverview {
  course: { id: string; code: string; titleEn: string; titleAr: string | null; credits: number | null; unitName: string | null; coordinatorName: string | null; coordinatorUserId: string | null; instructors: { id: string; name: string }[]; programIds: string[] };
  /** The approved version, and the version in progress (draft, in review or endorsed). */
  current: SyllabusVersion | null; open: SyllabusVersion | null;
  history: { id: string; versionNo: number; status: SyllabusStatus; effectiveFrom: string | null; approvedAt: string | null }[];
  suggestions: SyllabusSuggestion[];
  /** What the signed-in person may do with it. */
  can: { edit: boolean; suggest: boolean; endorse: boolean; approve: boolean };
  settings: SyllabusSettings; template: SyllabusTemplate; levels: OutcomeLevel[]; plos: SyllabusPlo[];
  courses: { id: string; code: string; titleEn: string }[];
}
export interface SyllabusListRow {
  courseId: string; code: string; titleEn: string; unitName: string | null; coordinatorName: string | null;
  currentVersionNo: number | null; currentApprovedAt: string | null; openStatus: SyllabusStatus | null;
  errorCount: number; warningCount: number; flaggedSince: string | null; escalationLevel: number; needsMyAttention: boolean;
}
const lenient = <T>() => z.any() as unknown as z.ZodType<T, T>;
export const SyllabusOverviewSchema = lenient<SyllabusOverview>();
export const SyllabusVersionSchema = lenient<SyllabusVersion>();
export const SyllabusListSchema = lenient<SyllabusListRow[]>();
export const SyllabusSuggestionSchema = lenient<SyllabusSuggestion>();

export interface SaveSyllabus { content: SyllabusContent; source?: string | undefined }
export const SaveSyllabusSchema: z.ZodType<SaveSyllabus, SaveSyllabus> = z.object({ content: SyllabusContentSchema, source: z.string().trim().max(200).optional() }).strict() as unknown as z.ZodType<SaveSyllabus, SaveSyllabus>;
/** Upsert by course code (the API and the import): always makes or updates a draft; only people approve. */
export interface UpsertSyllabus extends SaveSyllabus { courseCode: string }
export const UpsertSyllabusSchema: z.ZodType<UpsertSyllabus, UpsertSyllabus> = z.object({ courseCode: z.string().trim().min(1), content: SyllabusContentSchema, source: z.string().trim().max(200).optional() }).strict() as unknown as z.ZodType<UpsertSyllabus, UpsertSyllabus>;
export const CourseStaffSchema = z.object({ coordinatorUserId: z.uuid().nullable(), instructorIds: z.array(z.uuid()).max(50) }).strict();
export type CourseStaff = z.infer<typeof CourseStaffSchema>;
export const SuggestSchema = z.object({ section: z.string().trim().min(1).max(40), suggestion: z.string().trim().min(1).max(4000) }).strict();
export type Suggest = z.infer<typeof SuggestSchema>;
export const ResolveSuggestionSchema = z.object({ decision: z.enum(['accepted', 'declined']), note: z.string().trim().max(1000).optional() }).strict();
export type ResolveSuggestion = z.infer<typeof ResolveSuggestionSchema>;
export const SyllabusNoteSchema = z.object({ note: z.string().trim().max(2000).optional() }).strict();
export const ApproveSyllabusSchema = z.object({ effectiveFrom: z.string().trim().max(40).optional() }).strict();
