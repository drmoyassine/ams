// The academic workbook as people fill it in (DEC-045): ONE file with a README; Programs, PEOs, PLOs; Courses, Study plan, CLOs, Outline,
// Materials, Assessments, Rubrics, Sections; and a hidden Lists sheet. IDs (grey), required columns marked, dropdowns, lookups and number
// checks as before. Program code on the PEOs, PLOs and Study plan sheets lists the codes typed on the Programs sheet, and Course code on the
// course sheets lists the codes of the Courses sheet, so a program and its courses can be written in the same file.
import {
  ACADEMIC_SHEETS, BLOOM_WORDS, OUTCOME_STATUS_WORDS, PROGRAM_LEVEL_WORDS, PROGRAM_MODE_WORDS, type AcademicExport, type AcademicSheetKey,
} from '@ams/shared';
import type { RichColumn, RichSheet } from './sheet-io';

/** Rows prepared below the data (dropdowns, checks and lookups) for new entries. */
export const SPARE_ROWS = 300;

export const ACADEMIC_README = [
  '# Academic workbook',
  'One workbook for programs, their program educational objectives (PEOs) and program learning outcomes (PLOs), courses, the study plan (the programs each course serves) and the courses\' content. Fill in what you need, leave the other sheets empty, and import it in Settings > Organization > Programs or Courses > Import and export. The import shows a preview, row by row, before anything is changed.',
  '',
  '## The sheets',
  'Programs: one row per program. PEOs and PLOs: one row per outcome, each naming its program by its Program code.',
  'Courses: one row per course. Study plan: one row per course and program it serves, with its role, year and term. CLOs, Outline, Materials, Assessments, Rubrics, Sections: the course\'s content, each row naming its course by its Course code.',
  'Columns marked * (yellow header) are required. A row missing one is still imported, and the record is flagged with what it lacks until it is filled in. A course needs a Unit, its Credit hours and at least one program in the Study plan.',
  '',
  '## Order, and what changes at once',
  'Programs, PEOs and PLOs are applied first, then courses, the study plan and content, so a course may name a program that is added in the same file.',
  'A program\'s record, PEOs and PLOs, a course\'s record (Course code, Unit, Year of study, SIS code, Coordinator, Active) and its Study plan change at once.',
  'A course\'s content (title, credit hours, contact hours, language, type, level, category, description, methodology, CLOs with their PLOs, outline, materials, assessments, rubrics) goes into the course\'s draft and is approved as on the course page: the coordinator submits it, the chair endorses it, the Dean approves it. Content that comes out the same as the course already has makes no draft.',
  '',
  '## IDs (grey column)',
  'The ID is the record\'s own identifier, filled in when you export. Leave it as it is: with it, a row updates that exact record, even if you change its code. For a new record, leave the ID empty.',
  'Without an ID, a row is matched by its Program code (a PEO or PLO by its Code within the program) or its Course code (a CLO by its code within the course). Anything that matches nothing is added.',
  '',
  '## How the content is read',
  'A part of a course\'s content (its CLOs, outline, materials, assessments, rubrics, sections) is replaced only when the file has rows for that course on that sheet: a file with only the Courses sheet leaves the CLOs as they are. On the Courses and Programs sheets, an empty cell leaves that field as it is.',
  '',
  '## Dropdowns and lookups',
  'Unit, Program level, Mode, Language, Active, Coordinator, Course type, Course level, Course category, Sustainability indicator, Role, Bloom level, Coverage, Kind, Category and Status are picked from lists. Units are shown with their place in the org chart (College > Department).',
  'Program code (PEOs, PLOs, Study plan) lists the codes typed on the Programs sheet; Course code (every course sheet) lists the codes typed on the Courses sheet. Program name and Course title (grey) show which record the code is: they are filled in by the workbook and ignored by the import.',
  'ILOs (PLOs sheet): the institutional learning outcomes the PLO serves, as their codes separated by ; (for example ILO1; ILO3). An empty cell leaves the PLO\'s links as they are.',
  'PLO (CLOs sheet): the PLO codes the CLO maps to, separated by ; with their Coverage in the same order (for example PLO1; PLO3 and Introduced; Mastered).',
  '',
  '## What the import never does',
  'Nothing is deleted. To retire a PEO or PLO, set its Status to Retired; to take a program or a course out of use, set Active to No. A course is taken out of a program on the course page.',
  '',
  '## CSV',
  'The sheets can also be exchanged as CSV files, one per sheet, with the same columns (no dropdowns). The import tells the files apart by their columns. Older files that call the Study plan sheet "Placement" are still read.',
  '',
  '## Policies',
  'Course policies will come from the Policies and Procedures module.',
];

const col = (n: number) => { let s = ''; let x = n + 1; while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); } return s; };
const WIDE = new Set(['Statement (English)', 'Title (English)', 'Description (English)', 'Teaching methodology', 'Outcome (English)', 'Topic', 'Citation', 'Objective', 'Description', 'Text', 'How assessments work', 'Pass percentage and submission details']);

export function academicWorkbookSheets(data: AcademicExport): RichSheet[] {
  const L = data.lists;
  // One hidden sheet, one column per list; `range` is the cells a dropdown reads.
  const lists: [string, string[]][] = [
    ['Units', L.units], ['Program levels', [...PROGRAM_LEVEL_WORDS]], ['Modes', [...PROGRAM_MODE_WORDS]], ['Program languages', L.programLanguages], ['Active', ['Yes', 'No']],
    ['Bloom levels', [...BLOOM_WORDS]], ['Statuses', [...OUTCOME_STATUS_WORDS]], ['Coordinators', L.coordinators], ['Delivery languages', L.languages], ['Course types', L.types],
    ['Course levels', L.levels], ['Categories', L.categories], ['Sustainability', L.sustainability], ['Roles', L.roles], ['Coverage', L.coverage], ['Material kinds', L.kinds],
    ['Assessment categories', L.assessmentCategories],
  ];
  const longest = Math.max(1, ...lists.map(([, v]) => v.length));
  const listRows = Array.from({ length: longest }, (_, i) => Object.fromEntries(lists.map(([n, v]) => [n, v[i] ?? null])));
  const range = (name: string) => { const i = lists.findIndex(([n]) => n === name); const c = col(i); return `Lists!$${c}$2:$${c}$${Math.max(2, lists[i]![1].length + 1)}`; };

  const progHeaders = ACADEMIC_SHEETS.programs.headers as readonly string[];
  const courseHeaders = ACADEMIC_SHEETS.courses.headers as readonly string[];
  const pCode = col(progHeaders.indexOf('Program code')); const pName = col(progHeaders.indexOf('Name (English)'));
  const cCode = col(courseHeaders.indexOf('Course code')); const cTitle = col(courseHeaders.indexOf('Title (English)'));
  const programCodes = `Programs!$${pCode}$2:$${pCode}$${data.programs.length + 1 + SPARE_ROWS}`;
  const courseCodes = `Courses!$${cCode}$2:$${cCode}$${data.courses.length + 1 + SPARE_ROWS}`;

  const columnsOf = (k: AcademicSheetKey): RichColumn[] => {
    const def = ACADEMIC_SHEETS[k];
    const headers = def.headers as readonly string[];
    const required = def.required as readonly string[];
    const own = col(headers.indexOf(k === 'peos' || k === 'plos' ? 'Program code' : 'Course code'));
    return headers.map((h) => ({
      header: h, required: required.includes(h),
      ...(h === 'ID' ? { grey: true, width: 38 } : {}),
      // Programs
      ...(k === 'programs' && h === 'Name (English)' ? { width: 34 } : {}),
      ...(h === 'Name (Arabic)' ? { rtl: true, width: 34 } : {}),
      ...((k === 'programs' || k === 'courses') && h === 'Unit' ? { check: { list: range('Units') }, width: 48 } : {}),
      ...(h === 'Program level' ? { check: { list: range('Program levels') } } : {}),
      ...(h === 'Mode' ? { check: { list: range('Modes') } } : {}),
      ...(k === 'programs' && h === 'Language' ? { check: { list: range('Program languages') } } : {}),
      ...(h === 'Active' ? { check: { list: range('Active') } } : {}),
      ...(k === 'programs' && h === 'Credits' ? { check: { whole: [1, 400] } } : {}),
      ...(k === 'programs' && h === 'Contact hours' ? { check: { whole: [1, 20000] } } : {}),
      ...(h === 'Years' ? { check: { decimal: [0.5, 12] } } : {}),
      ...(h === 'Mission' || h === 'Vision' ? { wrap: true, width: 60 } : {}),
      // PEOs, PLOs
      ...((k === 'peos' || k === 'plos') && h === 'Program code' ? { check: { list: programCodes } } : {}),
      ...(h === 'Program name' ? { grey: true, width: 34, formula: (n: number) => `IFERROR(INDEX(Programs!$${pName}:$${pName},MATCH($${own}${n},Programs!$${pCode}:$${pCode},0)),"")` } : {}),
      ...(h === 'Statement (Arabic)' ? { wrap: true, rtl: true, width: 50 } : {}),
      ...(h === 'Bloom level' ? { check: { list: range('Bloom levels') } } : {}),
      ...(h === 'ILOs' ? { width: 22, note: `The institutional learning outcomes this PLO serves, separated by ; (for example ILO1; ILO3). ${L.ilos.length ? `Codes: ${L.ilos.join(', ')}.` : 'No ILOs are defined yet (Settings > Organization > Learning outcomes).'}` } : {}),
      ...((k === 'peos' || k === 'plos') && h === 'Status' ? { check: { list: range('Statuses') } } : {}),
      // Courses and their content
      ...(k === 'studyPlan' && h === 'Program code' ? { check: { list: programCodes } } : {}),
      ...(k !== 'courses' && !['programs', 'peos', 'plos'].includes(k) && h === 'Course code' ? { check: { list: courseCodes } } : {}),
      ...(h === 'Course title' ? { grey: true, width: 34, formula: (n: number) => `IFERROR(INDEX(Courses!$${cTitle}:$${cTitle},MATCH($${own}${n},Courses!$${cCode}:$${cCode},0)),"")` } : {}),
      ...(k === 'courses' && h === 'Coordinator' ? { check: { list: range('Coordinators') }, width: 30 } : {}),
      ...(h === 'Language of delivery' ? { check: { list: range('Delivery languages') } } : {}),
      ...(h === 'Course type' ? { check: { list: range('Course types') } } : {}),
      ...(h === 'Course level' ? { check: { list: range('Course levels') } } : {}),
      ...(h === 'Course category' ? { check: { list: range('Categories') } } : {}),
      ...(h === 'Sustainability indicator' ? { check: { list: range('Sustainability') } } : {}),
      ...(k === 'studyPlan' && h === 'Role' ? { check: { list: range('Roles') } } : {}),
      ...(k === 'clos' && h === 'Coverage' ? { width: 22 } : {}),
      ...(k === 'clos' && h === 'PLO' ? { width: 18, note: 'The PLO codes this CLO maps to, separated by ; (with their Coverage in the same order).' } : {}),
      ...(h === 'Kind' ? { check: { list: range('Material kinds') } } : {}),
      ...(k === 'assessments' && h === 'Category' ? { check: { list: range('Assessment categories') } } : {}),
      ...(h === 'Credit hours' ? { check: { decimal: [0, 30] } } : {}),
      ...(['Lecture hours', 'Lab hours', 'Other hours'].includes(h) ? { check: { decimal: [0, 60] } } : {}),
      ...(h === 'Year of study' ? { check: { whole: [0, 9] } } : {}),
      ...(k === 'studyPlan' && (h === 'Year' || h === 'Term') ? { check: { whole: [1, 9] } } : {}),
      ...(WIDE.has(h) && !(k === 'plos' && h === 'Statement (English)') ? { wrap: true, width: 50 } : {}),
      ...(k === 'peos' || k === 'plos' ? (h === 'Statement (English)' ? { wrap: true, width: 60 } : {}) : {}),
      ...(h === 'Outcome (Arabic)' ? { wrap: true, rtl: true, width: 45 } : {}),
    } as RichColumn));
  };
  const sheet = (k: AcademicSheetKey): RichSheet => ({ name: ACADEMIC_SHEETS[k].name, columns: columnsOf(k), rows: data[k], spare: SPARE_ROWS });
  return [
    { name: 'README', lines: ACADEMIC_README },
    sheet('programs'), sheet('peos'), sheet('plos'), sheet('courses'), sheet('studyPlan'), sheet('clos'), sheet('outline'), sheet('materials'), sheet('assessments'), sheet('rubrics'), sheet('sections'),
    { name: 'Lists', state: 'hidden', columns: lists.map(([n]) => ({ header: n, width: n === 'Units' ? 60 : 24 })), rows: listRows },
  ];
}
