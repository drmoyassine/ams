// @vitest-environment jsdom
// The programs workbook (the owner, 2026-11-18): README first, IDs, required marks, dropdowns from the hidden Lists sheet, the program-name
// lookup, number checks; and what it holds reads back as the rows the import takes (the lookup column is ignored by the import).
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProgramsExport } from '@ams/shared';
import { programsWorkbookSheets, README_LINES } from './programs-template';
import { richWorkbookXlsx } from './sheet-io';
import { readProgramFiles } from '../pages/settings/programs-io';

const data: ProgramsExport = {
  programs: [{ ID: '11111111-1111-4111-8111-111111111111', 'Program code': 'BS-ME', 'Name (English)': 'BS Mechanical Engineering', 'Name (Arabic)': 'بكالوريوس الهندسة الميكانيكية', Unit: 'College of Engineering › Mechanical', 'Program level': 'Bachelor', 'SIS code': '', Mode: 'On-campus', Credits: 132, Years: 4, 'Contact hours': 2200, Language: 'English', Mission: 'To educate engineers.', Vision: '', Active: 'Yes' }],
  peos: [{ ID: '22222222-2222-4222-8222-222222222222', 'Program code': 'BS-ME', 'Program name': 'BS Mechanical Engineering', Code: 'PEO1', 'Statement (English)': 'Lead projects', 'Statement (Arabic)': '', Status: 'Draft' }],
  plos: [{ ID: '33333333-3333-4333-8333-333333333333', 'Program code': 'BS-ME', 'Program name': 'BS Mechanical Engineering', Code: 'PLO1', 'Statement (English)': 'Solve problems', 'Statement (Arabic)': '', 'Bloom level': 'Apply', ILOs: 'ILO1; ILO2', Status: 'Approved' }],
  lists: { units: ['College of Engineering', 'College of Engineering › Mechanical'], languages: ['English', 'Arabic', 'Bilingual'], ilos: ['ILO1', 'ILO2'] },
};

describe('the programs workbook', () => {
  it('has a README first, the three sheets with IDs and checks, and a hidden Lists sheet', () => {
    const sheets = programsWorkbookSheets(data);
    expect(sheets.map((s) => [s.name, s.state ?? 'visible'])).toEqual([['README', 'visible'], ['Programs', 'visible'], ['PEOs', 'visible'], ['PLOs', 'visible'], ['Lists', 'hidden']]);
    expect(sheets[0]!.lines).toBe(README_LINES);
    const programs = sheets[1]!.columns!;
    expect(programs[0]).toMatchObject({ header: 'ID', grey: true });
    expect(programs.filter((c) => c.required).map((c) => c.header)).toEqual(['Program code', 'Name (English)', 'Name (Arabic)', 'Unit', 'Program level', 'Mode', 'Credits', 'Years', 'Contact hours', 'Language', 'Mission']);
    expect(programs.find((c) => c.header === 'Unit')!.check).toEqual({ list: 'Lists!$A$2:$A$3' });
    expect(programs.find((c) => c.header === 'Credits')!.check).toEqual({ whole: [1, 400] });
    const plos = sheets[3]!.columns!;
    expect(plos.find((c) => c.header === 'Program code')!.check).toEqual({ list: 'Programs!$B$2:$B$302' });
    expect(plos.find((c) => c.header === 'Program name')!.formula!(5)).toBe('IFERROR(INDEX(Programs!$C:$C,MATCH($B5,Programs!$B:$B,0)),"")');
    expect(plos.find((c) => c.header === 'Bloom level')!.check).toEqual({ list: 'Lists!$F$2:$F$7' });
    expect(plos.find((c) => c.header === 'ILOs')!.note).toMatch(/Codes: ILO1, ILO2\./);
  });

  it('writes an .xlsx that reads back as the rows the import takes', async () => {
    const blob = await richWorkbookXlsx(programsWorkbookSheets(data));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (process.env.TEMPLATE_OUT) writeFileSync(process.env.TEMPLATE_OUT, bytes);
    const { workbook } = await readProgramFiles([new File([bytes], 'Programs.xlsx')]);
    expect(workbook.programs).toHaveLength(1);
    expect(workbook.programs[0]).toMatchObject({ ID: '11111111-1111-4111-8111-111111111111', 'Program code': 'BS-ME', Unit: 'College of Engineering › Mechanical', Credits: '132' });
    expect(workbook.plos[0]).toMatchObject({ ID: '33333333-3333-4333-8333-333333333333', Code: 'PLO1', 'Bloom level': 'Apply', ILOs: 'ILO1; ILO2', Status: 'Approved' });
    // The prepared rows below (checks and the lookup formula only) are not read as data.
    expect(workbook.peos).toHaveLength(1);
  });
});
