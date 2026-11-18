// The courses workbook as people fill it in (DEC-042): a README; Courses, Placement, CLOs, Outline, Materials, Assessments, Rubrics and
// Sections with IDs, required columns marked and dropdowns fed from a hidden Lists sheet; the course codes of the Courses sheet as the
// dropdown of the others, with the course's title looked up beside; number checks.
import { COURSE_SHEETS, type CourseSheetKey, type CoursesExport, type CoursesLists } from '@ams/shared';
import type { RichColumn, RichSheet } from './sheet-io';

export const SPARE_ROWS = 300;

export const COURSES_README = [
  '# Courses workbook',
  'Use this workbook to add or update courses, the programs they serve and their content, then import it in Settings > Organization > Courses > Import and export. The import shows a preview, row by row, before anything is changed.',
  '',
  '## What changes at once, and what goes into a draft',
  'A course\'s record (Course code, Unit, Year of study, SIS code, Coordinator, Active) and the programs it serves (the Placement sheet) change at once.',
  'Its content (title, credit hours, contact hours, language, type, level, category, description, methodology, CLOs with their PLOs, outline, materials, assessments, rubrics) goes into the course\'s draft. The draft is approved as on the course page: the coordinator submits it, the chair endorses it, the Dean approves it. The syllabus is the report generated from the approved content.',
  '',
  '## The sheets',
  'Courses: one row per course. Placement: one row per course and program it serves. CLOs, Outline, Materials, Assessments, Rubrics, Sections: the course\'s content, each row naming its course by its Course code.',
  'Columns marked * (yellow header) are required. A course needs a Unit, its Credit hours and at least one program it serves.',
  '',
  '## IDs (grey column)',
  'The ID is the record\'s own identifier, filled in when you export. Leave it as it is: with it, a row updates that exact course (or CLO), even if you change its code. For a new course or CLO, leave the ID empty. Without an ID, a row is matched by its Course code (and a CLO by its code within the course).',
  '',
  '## How the content is read',
  'A part of a course\'s content (its CLOs, outline, materials, assessments, rubrics, sections) is replaced only when the file has rows for that course on that sheet: a file with only the Courses sheet leaves the CLOs as they are. On the Courses sheet, an empty cell leaves that field as it is.',
  'Content that comes out the same as the course already has makes no draft.',
  '',
  '## Dropdowns and lookups',
  'Unit, Coordinator, Language, Course type, Course level, Course category, Sustainability indicator, Active, Program code, Role, Bloom level, Coverage, Kind and Category are picked from lists. Units show their place in the org chart.',
  'On every other sheet, Course code lists the codes typed on the Courses sheet; Course title (grey) shows which course it is and is ignored by the import.',
  'PLO (CLOs sheet): the PLO codes the CLO maps to, separated by ; with their Coverage in the same order (for example PLO1; PLO3 and Introduced; Mastered).',
  '',
  '## What the import never does',
  'Nothing is deleted. To take a course out of use, set Active to No. A program a course serves is removed on the course page.',
  '',
  '## Policies',
  'Course policies will come from the Policies and Procedures module.',
];

const LIST_NAMES: [keyof CoursesLists | 'active', string][] = [
  ['units', 'Units'], ['programs', 'Programs'], ['coordinators', 'Coordinators'], ['languages', 'Languages'], ['types', 'Course types'], ['levels', 'Course levels'],
  ['categories', 'Categories'], ['sustainability', 'Sustainability'], ['active', 'Active'], ['roles', 'Roles'], ['bloom', 'Bloom levels'], ['coverage', 'Coverage'],
  ['kinds', 'Material kinds'], ['assessmentCategories', 'Assessment categories'],
];
const col = (n: number) => { let s = ''; let x = n + 1; while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); } return s; };

export function coursesWorkbookSheets(data: CoursesExport): RichSheet[] {
  const values = (k: keyof CoursesLists | 'active') => (k === 'active' ? ['Yes', 'No'] : data.lists[k]);
  const longest = Math.max(1, ...LIST_NAMES.map(([k]) => values(k).length));
  const listRows = Array.from({ length: longest }, (_, i) => Object.fromEntries(LIST_NAMES.map(([k, name]) => [name, values(k)[i] ?? null])));
  const range = (k: keyof CoursesLists | 'active') => { const c = col(LIST_NAMES.findIndex(([x]) => x === k)); return `Lists!$${c}$2:$${c}$${Math.max(2, values(k).length + 1)}`; };
  const courseHeaders = COURSE_SHEETS.courses.headers;
  const codeCol = col(courseHeaders.indexOf('Course code'));
  const titleCol = col(courseHeaders.indexOf('Title (English)'));
  const codes = `Courses!$${codeCol}$2:$${codeCol}$${data.courses.length + 1 + SPARE_ROWS}`;
  const titleLookup = (codeColumn: string) => (n: number) => `IFERROR(INDEX(Courses!$${titleCol}:$${titleCol},MATCH($${codeColumn}${n},Courses!$${codeCol}:$${codeCol},0)),"")`;
  const sheet = (k: CourseSheetKey): RichSheet => {
    const headers = COURSE_SHEETS[k].headers;
    const codeColumn = col(headers.indexOf('Course code'));
    const columns: RichColumn[] = headers.map((h) => ({
      header: h, required: COURSE_SHEETS[k].required.includes(h),
      ...(h === 'ID' ? { grey: true, width: 38 } : {}),
      ...(h === 'Course code' && k !== 'courses' ? { check: { list: codes } } : {}),
      ...(h === 'Course title' ? { grey: true, width: 34, formula: titleLookup(codeColumn) } : {}),
      ...(k === 'courses' && h === 'Unit' ? { check: { list: range('units') }, width: 48 } : {}),
      ...(k === 'courses' && h === 'Coordinator' ? { check: { list: range('coordinators') }, width: 30 } : {}),
      ...(h === 'Language of delivery' ? { check: { list: range('languages') } } : {}),
      ...(h === 'Course type' ? { check: { list: range('types') } } : {}),
      ...(h === 'Course level' ? { check: { list: range('levels') } } : {}),
      ...(h === 'Course category' ? { check: { list: range('categories') } } : {}),
      ...(h === 'Sustainability indicator' ? { check: { list: range('sustainability') } } : {}),
      ...(h === 'Active' ? { check: { list: range('active') } } : {}),
      ...(h === 'Program code' ? { check: { list: range('programs') } } : {}),
      ...(h === 'Role' ? { check: { list: range('roles') } } : {}),
      ...(h === 'Bloom level' ? { check: { list: range('bloom') } } : {}),
      ...(h === 'Coverage' ? { width: 22 } : {}),
      ...(h === 'PLO' ? { width: 18, note: 'The PLO codes this CLO maps to, separated by ; (with their Coverage in the same order).' } : {}),
      ...(h === 'Kind' ? { check: { list: range('kinds') } } : {}),
      ...(k === 'assessments' && h === 'Category' ? { check: { list: range('assessmentCategories') } } : {}),
      ...(h === 'Credit hours' ? { check: { decimal: [0, 30] } } : {}),
      ...(['Lecture hours', 'Lab hours', 'Other hours'].includes(h) ? { check: { decimal: [0, 60] } } : {}),
      ...(h === 'Year of study' ? { check: { whole: [0, 9] } } : {}),
      ...(k === 'placement' && (h === 'Year' || h === 'Term') ? { check: { whole: [1, 9] } } : {}),
      ...(['Title (English)', 'Description (English)', 'Teaching methodology', 'Outcome (English)', 'Topic', 'Citation', 'Objective', 'Description', 'Text', 'How assessments work', 'Pass percentage and submission details'].includes(h) ? { wrap: true, width: 50 } : {}),
      ...(h === 'Outcome (Arabic)' ? { wrap: true, rtl: true, width: 45 } : {}),
    } as RichColumn));
    return { name: COURSE_SHEETS[k].name, columns, rows: data[k], spare: SPARE_ROWS };
  };
  return [
    { name: 'README', lines: COURSES_README },
    ...(Object.keys(COURSE_SHEETS) as CourseSheetKey[]).map(sheet),
    { name: 'Lists', state: 'hidden', columns: LIST_NAMES.map(([, name]) => ({ header: name, width: name === 'Units' ? 60 : 24 })), rows: listRows },
  ];
}
