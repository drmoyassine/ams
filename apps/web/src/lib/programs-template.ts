// The programs workbook as people fill it in (the owner, 2026-11-18): a README, the Programs, PEOs and PLOs sheets with IDs, required columns
// marked, dropdowns fed from a hidden Lists sheet (units as org-chart paths, levels, modes, languages, Bloom levels, statuses), the program
// codes of the Programs sheet as the dropdown of the other two (with the program's name looked up beside), and number checks.
import {
  BLOOM_WORDS, OUTCOME_STATUS_WORDS, PROGRAM_LEVEL_WORDS, PROGRAM_MODE_WORDS, PROGRAM_SHEETS, type ProgramsExport,
} from '@ams/shared';
import type { RichColumn, RichSheet } from './sheet-io';

/** Rows prepared below the data (dropdowns, checks and lookups) for new entries. */
export const SPARE_ROWS = 300;

export const README_LINES = [
  '# Programs workbook',
  'Use this workbook to add or update programs, their program educational objectives (PEOs) and program learning outcomes (PLOs), then import it in Settings > Organization > Programs > Import and export. The import shows a preview, row by row, before anything is changed.',
  '',
  '## The sheets',
  'Programs: one row per program. PEOs and PLOs: one row per outcome, each naming its program by its Program code.',
  'Columns marked * (yellow header) are required. A row missing one is still imported, and the program is flagged with what it lacks until it is filled in.',
  '',
  '## IDs (grey column)',
  'The ID is the record\'s own identifier, filled in when you export. Leave it as it is: with it, a row updates that exact record, even if you change its code. For a new program or outcome, leave the ID empty.',
  'Without an ID, a row is matched by its Program code (and, for PEOs and PLOs, by its Code within the program). Anything that matches nothing is added.',
  '',
  '## Dropdowns',
  'Unit, Program level, Mode, Language, Active, Bloom level and Status are picked from lists. Units are shown with their place in the org chart (College > Department).',
  'ILOs (PLOs sheet): the institutional learning outcomes the PLO serves, as their codes separated by ; (for example ILO1; ILO3). The codes are in the note on the column\'s header. The import links the PLO to exactly those ILOs; an empty cell leaves its links as they are.',
  'On the PEOs and PLOs sheets, Program code lists the codes typed on the Programs sheet, so a program added there can be picked straight away. Program name (grey) shows which program the code is: it is filled in by the workbook and ignored by the import.',
  '',
  '## What the import never does',
  'Nothing is deleted. To retire a PEO or PLO, set its Status to Retired; to take a program out of use, set Active to No.',
  'An empty cell leaves that field as it is. To change a value, type the new one.',
  '',
  '## Example',
  'Programs: Program code BS-ME, Name (English) BS Mechanical Engineering, Unit College of Engineering > Department of Mechanical Engineering, Program level Bachelor, Mode On-campus, Credits 132, Years 4, Contact hours 2200, Language English, Mission "To educate mechanical engineers.", Active Yes.',
  'PLOs: Program code BS-ME, Code PLO1, Statement (English) "Solve complex engineering problems", Bloom level Apply, Status Draft.',
  '',
  '## CSV',
  'The same three sheets can be exchanged as three CSV files with the same columns (no dropdowns). The import tells the files apart by their columns.',
];

const LISTS = 'Lists';
/** The hidden sheet's columns: each list, and the range the dropdowns read. */
function lists(data: ProgramsExport) {
  const cols = {
    Units: data.lists.units, 'Program levels': [...PROGRAM_LEVEL_WORDS], Modes: [...PROGRAM_MODE_WORDS], Languages: data.lists.languages,
    Active: ['Yes', 'No'], 'Bloom levels': [...BLOOM_WORDS], Statuses: [...OUTCOME_STATUS_WORDS],
  };
  const names = Object.keys(cols) as (keyof typeof cols)[];
  const longest = Math.max(1, ...names.map((n) => cols[n].length));
  const rows = Array.from({ length: longest }, (_, i) => Object.fromEntries(names.map((n) => [n, cols[n][i] ?? null])));
  const range = (n: keyof typeof cols) => {
    const letter = String.fromCharCode(65 + names.indexOf(n));
    return `${LISTS}!$${letter}$2:$${letter}$${Math.max(2, cols[n].length + 1)}`;
  };
  return { sheet: { name: LISTS, state: 'hidden' as const, columns: names.map((n) => ({ header: n, width: n === 'Units' ? 60 : 18 })), rows }, range };
}

/** The sheets of the workbook: an empty template when the data has no rows, else the export. */
export function programsWorkbookSheets(data: ProgramsExport): RichSheet[] {
  const { sheet: listSheet, range } = lists(data);
  const req = (k: keyof typeof PROGRAM_SHEETS, h: string) => (PROGRAM_SHEETS[k].required as readonly string[]).includes(h);
  const programCols: RichColumn[] = PROGRAM_SHEETS.programs.headers.map((h) => ({
    header: h, required: req('programs', h),
    ...(h === 'ID' ? { grey: true, width: 38 } : {}),
    ...(h === 'Name (Arabic)' ? { rtl: true, width: 34 } : {}),
    ...(h === 'Name (English)' ? { width: 34 } : {}),
    ...(h === 'Unit' ? { check: { list: range('Units') }, width: 48 } : {}),
    ...(h === 'Program level' ? { check: { list: range('Program levels') } } : {}),
    ...(h === 'Mode' ? { check: { list: range('Modes') } } : {}),
    ...(h === 'Language' ? { check: { list: range('Languages') } } : {}),
    ...(h === 'Active' ? { check: { list: range('Active') } } : {}),
    ...(h === 'Credits' ? { check: { whole: [1, 400] } } : {}),
    ...(h === 'Contact hours' ? { check: { whole: [1, 20000] } } : {}),
    ...(h === 'Years' ? { check: { decimal: [0.5, 12] } } : {}),
    ...(h === 'Mission' || h === 'Vision' ? { wrap: true, width: 60 } : {}),
  } as RichColumn));
  // Program code is column B of the Programs sheet, Name (English) column C.
  const codes = `Programs!$B$2:$B$${data.programs.length + 1 + SPARE_ROWS}`;
  const outcomeCols = (k: 'peos' | 'plos'): RichColumn[] => PROGRAM_SHEETS[k].headers.map((h) => ({
    header: h, required: req(k, h),
    ...(h === 'ID' ? { grey: true, width: 38 } : {}),
    ...(h === 'Program code' ? { check: { list: codes } } : {}),
    ...(h === 'Program name' ? { grey: true, width: 34, formula: (n: number) => `IFERROR(INDEX(Programs!$C:$C,MATCH($B${n},Programs!$B:$B,0)),"")` } : {}),
    ...(h === 'Statement (English)' ? { wrap: true, width: 60 } : {}),
    ...(h === 'Statement (Arabic)' ? { wrap: true, rtl: true, width: 50 } : {}),
    ...(h === 'Bloom level' ? { check: { list: range('Bloom levels') } } : {}),
    ...(h === 'ILOs' ? { width: 22, note: `The institutional learning outcomes this PLO serves, separated by ; (for example ILO1; ILO3). ${data.lists.ilos.length ? `Codes: ${data.lists.ilos.join(', ')}.` : 'No ILOs are defined yet (Settings > Organization > Learning outcomes).'} An empty cell leaves the PLO's links as they are.` } : {}),
    ...(h === 'Status' ? { check: { list: range('Statuses') } } : {}),
  } as RichColumn));
  return [
    { name: 'README', lines: README_LINES },
    { name: PROGRAM_SHEETS.programs.name, columns: programCols, rows: data.programs, spare: SPARE_ROWS },
    { name: PROGRAM_SHEETS.peos.name, columns: outcomeCols('peos'), rows: data.peos, spare: SPARE_ROWS },
    { name: PROGRAM_SHEETS.plos.name, columns: outcomeCols('plos'), rows: data.plos, spare: SPARE_ROWS },
    listSheet,
  ];
}
