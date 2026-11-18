// Courses as a workbook (the owner, 2026-11-18, DEC-042): the course is the master record. One template exports and imports courses with
// their record, the programs they serve and their content (CLOs with their PLOs, outline, materials, assessments, rubrics), as .xlsx or
// CSV. The record and the placements change at once; the content goes into each course's draft, approved as on the course page.
import { z } from 'zod';
import { SYLLABUS_SHEETS } from './syllabus-sheets.js';

const CONTENT_COURSE_HEADERS = SYLLABUS_SHEETS.courses.headers.filter((h) => h !== 'Course code' && h !== 'Title (Arabic)' && h !== 'Description (Arabic)');

export const COURSE_SHEETS = {
  courses: {
    name: 'Courses',
    headers: ['ID', 'Course code', 'Unit', 'Year of study', 'SIS code', ...CONTENT_COURSE_HEADERS, 'Coordinator', 'Active'] as readonly string[],
    required: ['Course code', 'Title (English)', 'Unit', 'Credit hours'] as readonly string[],
  },
  placement: { name: 'Placement', headers: ['Course code', 'Course title', 'Program code', 'Role', 'Year', 'Term'] as readonly string[], required: ['Course code', 'Program code'] as readonly string[] },
  clos: { name: 'CLOs', headers: ['ID', 'Course code', 'Course title', ...SYLLABUS_SHEETS.clos.headers.filter((h) => h !== 'Course code')] as readonly string[], required: ['Course code', 'CLO', 'Outcome (English)'] as readonly string[] },
  outline: { name: 'Outline', headers: SYLLABUS_SHEETS.outline.headers as readonly string[], required: ['Course code', 'Week', 'Topic'] as readonly string[] },
  materials: { name: 'Materials', headers: SYLLABUS_SHEETS.materials.headers as readonly string[], required: ['Course code', 'Kind', 'Citation'] as readonly string[] },
  assessments: { name: 'Assessments', headers: SYLLABUS_SHEETS.assessments.headers as readonly string[], required: ['Course code', 'Assessment'] as readonly string[] },
  rubrics: { name: 'Rubrics', headers: SYLLABUS_SHEETS.rubrics.headers as readonly string[], required: ['Course code', 'Rubric'] as readonly string[] },
  sections: { name: 'Sections', headers: SYLLABUS_SHEETS.sections.headers as readonly string[], required: ['Course code', 'Section'] as readonly string[] },
};
export type CourseSheetKey = keyof typeof COURSE_SHEETS;
/** The sheets that hold a course's content (each replaces that part of the content only when the file has rows for the course). */
export const CONTENT_SHEETS = ['clos', 'outline', 'materials', 'assessments', 'rubrics', 'sections'] as const;

export type CourseSheetRow = Record<string, string | number | null>;
export type CoursesWorkbook = Record<CourseSheetKey, CourseSheetRow[]>;
const rows = z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(20000).default([]);
export const CoursesWorkbookSchema: z.ZodType<CoursesWorkbook, CoursesWorkbook> = z.object({
  courses: rows, placement: rows, clos: rows, outline: rows, materials: rows, assessments: rows, rubrics: rows, sections: rows,
}).strict() as unknown as z.ZodType<CoursesWorkbook, CoursesWorkbook>;
export const emptyCoursesWorkbook = (): CoursesWorkbook => ({ courses: [], placement: [], clos: [], outline: [], materials: [], assessments: [], rubrics: [], sections: [] });

/** The choices for the template's dropdowns. */
export interface CoursesLists {
  units: string[]; programs: string[]; coordinators: string[];
  languages: string[]; types: string[]; levels: string[]; categories: string[]; sustainability: string[];
  roles: string[]; bloom: string[]; coverage: string[]; kinds: string[]; assessmentCategories: string[];
}
export interface CoursesExport extends CoursesWorkbook { lists: CoursesLists }
export const CoursesExportSchema = z.any() as unknown as z.ZodType<CoursesExport, CoursesExport>;

export interface UpsertCourses { workbook: CoursesWorkbook; apply: boolean }
export const UpsertCoursesSchema: z.ZodType<UpsertCourses, UpsertCourses> = z.object({ workbook: CoursesWorkbookSchema, apply: z.boolean() }).strict() as unknown as z.ZodType<UpsertCourses, UpsertCourses>;
export interface UpsertCoursesRow {
  sheet: string; row: number; code: string;
  /** add / update / unchanged / skip for the record and placements; draft for content that went (or would go) into the course's draft. */
  action: 'add' | 'update' | 'unchanged' | 'skip' | 'draft';
  message: string;
}
export interface UpsertCoursesResult { applied: boolean; added: number; updated: number; drafted: number; unchanged: number; skipped: number; rows: UpsertCoursesRow[] }
export const UpsertCoursesResultSchema = z.any() as unknown as z.ZodType<UpsertCoursesResult, UpsertCoursesResult>;

/** Which sheet a CSV file is, from its headers. */
export function courseSheetOfHeaders(headers: string[]): CourseSheetKey | null {
  const h = new Set(headers.map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (h.has('programcode') && h.has('role')) return 'placement';
  if (h.has('clo') && h.has('outcomeenglish')) return 'clos';
  if (h.has('week') && h.has('topic')) return 'outline';
  if (h.has('kind') && h.has('citation')) return 'materials';
  if (h.has('assessment') && h.has('ofgrade')) return 'assessments';
  if (h.has('rubric') && h.has('criterion')) return 'rubrics';
  if (h.has('section') && h.has('text')) return 'sections';
  if (h.has('coursecode') && (h.has('creditHours'.toLowerCase()) || h.has('titleenglish'))) return 'courses';
  return null;
}
