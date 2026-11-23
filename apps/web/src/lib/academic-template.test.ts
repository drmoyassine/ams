// @vitest-environment jsdom
// The programs workbook (the owner, 2026-11-18): README first, IDs, required marks, dropdowns from the hidden Lists sheet, the program-name
// lookup, number checks; and what it holds reads back as the rows the import takes (the lookup column is ignored by the import).
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AcademicExport } from '@ams/shared';
import { academicWorkbookSheets, ACADEMIC_README } from './academic-template';
import { richWorkbookXlsx } from './sheet-io';
import { readAcademicFiles } from '../pages/settings/academic-io';

const data: AcademicExport = {
  programs: [{ ID: '11111111-1111-4111-8111-111111111111', 'Program code': 'BS-ME', 'Name (English)': 'BS Mechanical Engineering', 'Name (Arabic)': 'بكالوريوس الهندسة الميكانيكية', Unit: 'College of Engineering › Mechanical', 'Program level': 'Bachelor', 'SIS code': '', Mode: 'On-campus', Credits: 132, Years: 4, 'Contact hours': 2200, Language: 'English', Mission: 'To educate engineers.', Vision: '', Active: 'Yes' }],
  peos: [{ ID: '22222222-2222-4222-8222-222222222222', 'Program code': 'BS-ME', 'Program name': 'BS Mechanical Engineering', Code: 'PEO1', 'Statement (English)': 'Lead projects', 'Statement (Arabic)': '', Status: 'Draft' }],
  plos: [{ ID: '33333333-3333-4333-8333-333333333333', 'Program code': 'BS-ME', 'Program name': 'BS Mechanical Engineering', Code: 'PLO1', 'Statement (English)': 'Solve problems', 'Statement (Arabic)': '', 'Bloom level': 'Apply', ILOs: 'ILO1; ILO2', Status: 'Approved' }],
  courses: [{ ID: '44444444-4444-4444-8444-444444444444', 'Course code': 'MCE 410', Unit: 'College of Engineering › Mechanical', 'Year of study': 4, 'SIS code': '', 'Title (English)': 'Heat Transfer', 'Credit hours': 3 }],
  studyPlan: [{ 'Course code': 'MCE 410', 'Course title': 'Heat Transfer', 'Program code': 'BS-ME', Role: 'Core', Year: 4, Term: 1 }],
  clos: [], outline: [], materials: [], assessments: [], rubrics: [], sections: [],
  concentrations: [{ ID: '55555555-5555-4555-8555-555555555555', 'Program code': 'BS-ME', 'Program name': 'BS Mechanical Engineering', Code: 'THERM', 'Name (English)': 'Thermal Systems', 'Name (Arabic)': '', Active: 'Yes' }],
  blocks: [{ 'Program code': 'BS-ME', 'Program name': 'BS Mechanical Engineering', Concentration: '', Block: 'Major requirements', 'Core credits': 60, 'Elective credits': 9 }],
  genedAreas: [{ ID: '66666666-6666-4666-8666-666666666666', Code: 'ENG', 'Name (English)': 'English', 'Name (Arabic)': '', 'Minimum credits': 6, Courses: 'ENG 101; ENG 102' }],
  programAreas: [],
  catalog: [{ Setting: 'General education credits', Value: 36 }],
  slots: [{ ID: '', 'Program code': 'BS-ME', 'Program name': 'BS Mechanical Engineering', Concentration: '', Block: 'Major requirements', 'Slot name': 'Major elective', Rule: 'Any MCE 4xx', Area: '', Credits: 3, Year: 4, Term: 1 }],
  lists: {
    units: ['College of Engineering', 'College of Engineering › Mechanical'], languages: ['English', 'Arabic'], programLanguages: ['English', 'Arabic', 'Bilingual'], ilos: ['ILO1', 'ILO2'],
    programs: ['BS-ME'], coordinators: ['a@x.org'], types: ['Didactic'], levels: ['400'], categories: ['General education'], sustainability: ['None'], roles: ['Core', 'Elective', 'Service'],
    blocks: ['General education', 'Major requirements'], areas: ['ENG'], concentrations: ['THERM'], bloom: ['Apply'], coverage: ['Introduced'], kinds: ['Textbook'], assessmentCategories: ['Quiz'],
  },
};

describe('the academic workbook', () => {
  it('has a README first, every sheet with IDs and checks (Study plan, not Placement), and one hidden Lists sheet', () => {
    const sheets = academicWorkbookSheets(data);
    expect(sheets.map((s) => [s.name, s.state ?? 'visible'])).toEqual([
      ['README', 'visible'], ['Programs', 'visible'], ['PEOs', 'visible'], ['PLOs', 'visible'], ['Concentrations', 'visible'], ['Requirement blocks', 'visible'], ['Courses', 'visible'], ['Study plan', 'visible'],
      ['Elective slots', 'visible'], ['GenEd areas', 'visible'], ['Program GenEd areas', 'visible'], ['Catalog settings', 'visible'], ['CLOs', 'visible'], ['Outline', 'visible'], ['Materials', 'visible'], ['Assessments', 'visible'], ['Rubrics', 'visible'], ['Sections', 'visible'], ['Lists', 'hidden']]);
    expect(sheets[0]!.lines).toBe(ACADEMIC_README);
    const by = (n: string) => sheets.find((s) => s.name === n)!.columns!;
    expect(by('Programs')[0]).toMatchObject({ header: 'ID', grey: true });
    expect(by('Programs').filter((c) => c.required).map((c) => c.header)).toEqual(['Program code', 'Name (English)', 'Name (Arabic)', 'Unit', 'Program level', 'Mode', 'Credits', 'Years', 'Contact hours', 'Language', 'Mission', 'Description (English)']);
    expect(by('Programs').find((c) => c.header === 'Unit')!.check).toEqual({ list: 'Lists!$A$2:$A$3' });
    expect(by('Programs').find((c) => c.header === 'Credits')!.check).toEqual({ whole: [1, 400] });
    expect(by('PLOs').find((c) => c.header === 'Program code')!.check).toEqual({ list: 'Programs!$B$2:$B$302' });
    expect(by('PLOs').find((c) => c.header === 'Program name')!.formula!(5)).toBe('IFERROR(INDEX(Programs!$C:$C,MATCH($B5,Programs!$B:$B,0)),"")');
    expect(by('PLOs').find((c) => c.header === 'ILOs')!.note).toMatch(/Codes: ILO1, ILO2\./);
    // The Study plan names programs from the Programs sheet and courses from the Courses sheet, with the course's title looked up.
    expect(by('Study plan').find((c) => c.header === 'Program code')!.check).toEqual({ list: 'Programs!$B$2:$B$302' });
    expect(by('Study plan').find((c) => c.header === 'Course code')!.check).toEqual({ list: 'Courses!$B$2:$B$302' });
    expect(by('Study plan').find((c) => c.header === 'Role')!.check).toEqual({ list: 'Lists!$P$2:$P$4' });
    // The catalog's structure: blocks from the Lists sheet, concentrations from the Concentrations sheet, areas from the GenEd areas sheet.
    expect(by('Study plan').find((c) => c.header === 'Block')!.check).toEqual({ list: 'Lists!$D$2:$D$3' });
    // Several concentrations in a Study plan row are separated by ; so it has no dropdown, the Requirement blocks sheet has one.
    expect(by('Study plan').find((c) => c.header === 'Concentration')!.check).toBeUndefined();
    expect(by('Requirement blocks').find((c) => c.header === 'Concentration')!.check).toEqual({ list: 'Concentrations!$D$2:$D$302' });
    expect(by('Elective slots').find((c) => c.header === 'Area')!.check).toEqual({ list: "'GenEd areas'!$B$2:$B$302" });
    expect(by('Requirement blocks').find((c) => c.header === 'Program code')!.check).toEqual({ list: 'Programs!$B$2:$B$302' });
    expect(by('Programs').find((c) => c.header === 'Type')!.check).toEqual({ list: 'Lists!$C$2:$C$3' });
    expect(by('CLOs').find((c) => c.header === 'Course code')!.check).toEqual({ list: 'Courses!$B$2:$B$302' });
    expect(by('Courses').find((c) => c.header === 'Unit')!.check).toEqual({ list: 'Lists!$A$2:$A$3' });
  });

  it('writes an .xlsx that reads back as the rows the import takes, and reads an older file whose sheet is called Placement', async () => {
    const blob = await richWorkbookXlsx(academicWorkbookSheets(data));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (process.env.TEMPLATE_OUT) writeFileSync(process.env.TEMPLATE_OUT, bytes);
    const { workbook } = await readAcademicFiles([new File([bytes], 'Academic workbook.xlsx')]);
    expect(workbook.programs).toHaveLength(1);
    expect(workbook.programs[0]).toMatchObject({ ID: '11111111-1111-4111-8111-111111111111', 'Program code': 'BS-ME', Unit: 'College of Engineering › Mechanical', Credits: '132' });
    expect(workbook.plos[0]).toMatchObject({ ID: '33333333-3333-4333-8333-333333333333', Code: 'PLO1', 'Bloom level': 'Apply', ILOs: 'ILO1; ILO2', Status: 'Approved' });
    expect(workbook.courses[0]).toMatchObject({ 'Course code': 'MCE 410', 'Credit hours': '3' });
    expect(workbook.studyPlan).toHaveLength(1);
    expect(workbook.studyPlan[0]).toMatchObject({ 'Course code': 'MCE 410', 'Program code': 'BS-ME', Role: 'Core', Year: '4', Term: '1' });
    expect(workbook.concentrations[0]).toMatchObject({ Code: 'THERM' });
    expect(workbook.blocks[0]).toMatchObject({ Block: 'Major requirements', 'Core credits': '60', 'Elective credits': '9' });
    expect(workbook.genedAreas[0]).toMatchObject({ Code: 'ENG', 'Minimum credits': '6', Courses: 'ENG 101; ENG 102' });
    expect(workbook.catalog).toEqual([{ Setting: 'General education credits', Value: '36' }]);
    expect(workbook.slots[0]).toMatchObject({ 'Slot name': 'Major elective', Credits: '3', Rule: 'Any MCE 4xx' });
    // The prepared rows below (checks and the lookup formula only) are not read as data.
    expect(workbook.peos).toHaveLength(1);
    const sheets = academicWorkbookSheets(data).map((s) => (s.name === 'Study plan' ? { ...s, name: 'Placement' } : s));
    const legacy = await readAcademicFiles([new File([new Uint8Array(await (await richWorkbookXlsx(sheets)).arrayBuffer())], 'Courses.xlsx')]);
    expect(legacy.workbook.studyPlan).toHaveLength(1);
  });

  it('tells CSV files apart by their headers', async () => {
    const csv = (h: string) => new File([`${h}\nx\n`], 'f.csv', { type: 'text/csv' });
    const read = async (h: string) => Object.entries((await readAcademicFiles([csv(h)])).workbook).filter(([, v]) => v.length).map(([k]) => k);
    expect(await read('Program code,Name (English),Mission')).toEqual(['programs']);
    expect(await read('Program code,Code,Statement (English),Bloom level')).toEqual(['plos']);
    expect(await read('Program code,Code,Statement (English)')).toEqual(['peos']);
    expect(await read('Course code,Title (English),Credit hours')).toEqual(['courses']);
    expect(await read('Course code,Program code,Role,Year,Term')).toEqual(['studyPlan']);
    expect(await read('Program code,Code,Name (English),Name (Arabic)')).toEqual(['concentrations']);
    expect(await read('Program code,Concentration,Block,Core credits,Elective credits')).toEqual(['blocks']);
    expect(await read('Program code,Slot name,Credits')).toEqual(['slots']);
    expect(await read('Code,Name (English),Minimum credits,Courses')).toEqual(['genedAreas']);
    expect(await read('Setting,Value')).toEqual(['catalog']);
    expect(await read('Course code,CLO,Outcome (English)')).toEqual(['clos']);
  });
});
