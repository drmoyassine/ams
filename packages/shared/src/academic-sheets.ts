// The academic workbook (the owner, 2026-11-19, DEC-045): ONE file for programs, their PEOs and PLOs, courses, the study plan (the programs a
// course serves, with role, year and term) and each course's CLOs, outline, materials, assessments, rubrics and sections. It is the
// programs workbook and the courses workbook (DEC-041, DEC-042) as one, so a program and its courses can go in together; the rules of each
// part are unchanged. Applied in order: programs, PEOs and PLOs, then courses, study plan and content, in one transaction.
import { z } from 'zod';
import { COURSE_SHEETS, LEGACY_SHEET_NAMES, courseSheetOfHeaders, emptyCoursesWorkbook, type CourseSheetKey, type CoursesLists, type CoursesWorkbook, type UpsertCoursesRow } from './courses-sheets.js';
import { PROGRAM_SHEETS, sheetOfHeaders, type ProgramSheetKey, type ProgramsWorkbook, type UpsertProgramsRow } from './programs-sheets.js';

export type AcademicSheetKey = ProgramSheetKey | CourseSheetKey;
/** The sheets in the order of the file (and of the apply). */
export const ACADEMIC_SHEET_ORDER = ['programs', 'peos', 'plos', 'courses', 'studyPlan', 'clos', 'outline', 'materials', 'assessments', 'rubrics', 'sections'] as const satisfies readonly AcademicSheetKey[];
export const ACADEMIC_SHEETS = { ...PROGRAM_SHEETS, ...COURSE_SHEETS } as const;
export const academicSheetName = (k: AcademicSheetKey): string => ACADEMIC_SHEETS[k].name;
/** The name of a sheet as an older file spelled it, mapped to today's name. */
export const currentSheetName = (name: string): string => LEGACY_SHEET_NAMES[name] ?? name;

export type AcademicWorkbook = ProgramsWorkbook & CoursesWorkbook;
export const emptyAcademicWorkbook = (): AcademicWorkbook => ({ programs: [], peos: [], plos: [], ...emptyCoursesWorkbook() });
const rows = z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(20000).default([]);
export const AcademicWorkbookSchema: z.ZodType<AcademicWorkbook, AcademicWorkbook> = z.object({
  programs: rows, peos: rows, plos: rows, courses: rows, studyPlan: rows, clos: rows, outline: rows, materials: rows, assessments: rows, rubrics: rows, sections: rows,
}).strict() as unknown as z.ZodType<AcademicWorkbook, AcademicWorkbook>;

/** The choices for the template's dropdowns: the programs part's and the courses part's. */
export type AcademicLists = CoursesLists & { /** The languages a program is taught in (the course lists' `languages` are the languages of delivery). */ programLanguages: string[]; /** The ILO codes, for the PLOs' ILOs column. */ ilos: string[] };
export interface AcademicExport extends AcademicWorkbook { lists: AcademicLists }
export const AcademicExportSchema = z.any() as unknown as z.ZodType<AcademicExport, AcademicExport>;

export interface UpsertAcademic { workbook: AcademicWorkbook; apply: boolean }
export const UpsertAcademicSchema: z.ZodType<UpsertAcademic, UpsertAcademic> = z.object({ workbook: AcademicWorkbookSchema, apply: z.boolean() }).strict() as unknown as z.ZodType<UpsertAcademic, UpsertAcademic>;

export type UpsertAcademicRow = UpsertProgramsRow | UpsertCoursesRow;
export interface UpsertAcademicResult { applied: boolean; added: number; updated: number; drafted: number; unchanged: number; skipped: number; rows: (UpsertProgramsRow | UpsertCoursesRow)[] }
export const UpsertAcademicResultSchema = z.any() as unknown as z.ZodType<UpsertAcademicResult, UpsertAcademicResult>;

/** Which sheet a CSV file is, from its headers (programs, PEOs, PLOs first, then the courses' sheets). */
export function academicSheetOfHeaders(headers: string[]): AcademicSheetKey | null {
  const h = new Set(headers.map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '')));
  // A PLO row names its program and has a statement; a course content row names a course. Courses' Study plan has Program code AND Role.
  if (h.has('coursecode') || h.has('programcode') && h.has('role')) return courseSheetOfHeaders(headers);
  return sheetOfHeaders(headers) ?? courseSheetOfHeaders(headers);
}
