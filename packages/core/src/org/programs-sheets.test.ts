// Programs from the template (the owner, 2026-11-16): preview writes nothing, apply adds and updates by Program code, an empty cell leaves a
// field alone, a row that cannot be placed is skipped with the reason, what a program lacks is flagged, and the export reads back the rows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProgramsWorkbook } from '@ams/shared';
import { buildWorld, type World } from '../engagement/test-support.js';
import { exportPrograms, upsertPrograms } from './programs-sheets.js';
import { listPrograms } from './programs.js';

let w: World;
beforeAll(async () => { w = await buildWorld('programsheets'); }, 120000);
afterAll(() => w.close());

const workbook = (): ProgramsWorkbook => ({
  programs: [
    { 'Program code': 'BS-CE', 'Name (English)': 'BS Civil Engineering', 'Name (Arabic)': 'بكالوريوس الهندسة المدنية', Unit: 'engineering', 'Program level': 'Bachelor', Mode: 'On-campus', Credits: 132, Years: 4, 'Contact hours': 2200, Language: 'English', Mission: 'To educate civil engineers.' },
    { 'Program code': 'BS-X', 'Name (English)': 'BS Nowhere', Unit: 'Medicine', 'Program level': 'Bachelor' },
    { 'Program code': 'MS-CE', 'Name (English)': 'MS Civil Engineering', Unit: 'Engineering', 'Program level': 'master', Mode: 'part time' },
  ],
  peos: [{ 'Program code': 'BS-CE', Code: 'PEO1', 'Statement (English)': 'Lead engineering projects' }],
  plos: [
    { 'Program code': 'bs-ce', Code: 'PLO1', 'Statement (English)': 'Solve problems', 'Bloom level': 'Apply' },
    { 'Program code': 'NOPE', Code: 'PLO1', 'Statement (English)': 'x' },
  ],
});

describe('programs from the template', () => {
  it('previews without writing, then adds programs, PEOs and PLOs; skips what cannot be placed and flags what is missing', async () => {
    const before = (await w.as('alo', (c) => listPrograms(c))).length;
    const preview = await w.as('alo', (c) => upsertPrograms(c, { workbook: workbook(), apply: false }));
    expect(preview).toMatchObject({ applied: false, added: 4, skipped: 2 });
    expect((await w.as('alo', (c) => listPrograms(c))).length).toBe(before);
    const done = await w.as('alo', (c) => upsertPrograms(c, { workbook: workbook(), apply: true }));
    expect(done.rows.map((r) => [r.sheet, r.code, r.action])).toEqual([
      ['Programs', 'BS-CE', 'add'], ['Programs', 'BS-X', 'skip'], ['Programs', 'MS-CE', 'add'], ['PEOs', 'BS-CE PEO1', 'add'], ['PLOs', 'bs-ce PLO1', 'add'], ['PLOs', 'NOPE PLO1', 'skip'],
    ]);
    expect(done.rows.find((r) => r.code === 'BS-X')!.message).toBe('no unit "Medicine" in the org chart');
    expect(done.rows.find((r) => r.code === 'BS-CE')!.message).toBe('');
    expect(done.rows.find((r) => r.code === 'MS-CE')!.message).toMatch(/^Missing: Arabic name, Credits, Years, Contact hours, Language, Mission, PEOs, PLOs\.$/);
    const ce = (await w.as('alo', (c) => listPrograms(c))).find((p) => p.code === 'BS-CE')!;
    expect(ce).toMatchObject({ mode: 'on_campus', credits: 132, contactHours: 2200, missing: [] });
    expect((await w.as('alo', (c) => listPrograms(c))).find((p) => p.code === 'MS-CE')).toMatchObject({ mode: 'on_campus', degreeLevel: 'master' });
  });

  it('updates by Program code, leaves a field with an empty cell alone, and reports unchanged rows', async () => {
    const wb = workbook();
    wb.programs = [{ 'Program code': 'BS-CE', Credits: 130, Mission: '' } as never];
    wb.peos = []; wb.plos = [{ 'Program code': 'BS-CE', Code: 'plo1', 'Statement (English)': 'Solve complex problems', 'Bloom level': 'Apply' }];
    const r = await w.as('alo', (c) => upsertPrograms(c, { workbook: wb, apply: true }));
    expect(r.rows.map((x) => [x.code, x.action, x.message])).toEqual([['BS-CE', 'update', 'Changes: credits.'], ['BS-CE plo1', 'update', '']]);
    const ce = (await w.as('alo', (c) => listPrograms(c))).find((p) => p.code === 'BS-CE')!;
    expect(ce).toMatchObject({ credits: 130, mission: 'To educate civil engineers.' });
    expect((await w.as('alo', (c) => upsertPrograms(c, { workbook: wb, apply: true }))).rows.map((x) => x.action)).toEqual(['unchanged', 'unchanged']);
    // A viewer may not import.
    await expect(w.as('contrib', (c) => upsertPrograms(c, { workbook: wb, apply: false }))).rejects.toThrow();
  });

  it('exports every program it sees with its PEOs and PLOs, as rows that import back unchanged', async () => {
    const wb = await w.as('alo', (c) => exportPrograms(c));
    expect(wb.programs.find((r) => r['Program code'] === 'BS-CE')).toMatchObject({ Unit: 'Engineering', 'Program level': 'Bachelor', Mode: 'On-campus', Credits: 130, 'Contact hours': 2200, Active: 'Yes' });
    expect(wb.plos).toContainEqual({ 'Program code': 'BS-CE', Code: 'PLO1', 'Statement (English)': 'Solve complex problems', 'Statement (Arabic)': '', 'Bloom level': 'apply' });
    const back = await w.as('alo', (c) => upsertPrograms(c, { workbook: { programs: wb.programs.filter((r) => r['Program code']), peos: wb.peos, plos: wb.plos }, apply: false }));
    expect(back.rows.filter((r) => r.action !== 'unchanged')).toEqual([]);
  });
});
