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
    expect(r.rows.map((x) => [x.code, x.action, x.message])).toEqual([['BS-CE', 'update', 'Changes: credits.'], ['BS-CE plo1', 'update', 'Changes: textEn.']]);
    const ce = (await w.as('alo', (c) => listPrograms(c))).find((p) => p.code === 'BS-CE')!;
    expect(ce).toMatchObject({ credits: 130, mission: 'To educate civil engineers.' });
    expect((await w.as('alo', (c) => upsertPrograms(c, { workbook: wb, apply: true }))).rows.map((x) => x.action)).toEqual(['unchanged', 'unchanged']);
    // A viewer may not import.
    await expect(w.as('contrib', (c) => upsertPrograms(c, { workbook: wb, apply: false }))).rejects.toThrow();
  });

  it('exports every program it sees with IDs, unit paths and the dropdowns\' lists, as rows that import back unchanged', async () => {
    const wb = await w.as('alo', (c) => exportPrograms(c));
    const ce = wb.programs.find((r) => r['Program code'] === 'BS-CE')!;
    expect(ce).toMatchObject({ Unit: 'Engineering', 'Program level': 'Bachelor', Mode: 'On-campus', Credits: 130, 'Contact hours': 2200, Active: 'Yes' });
    expect(String(ce.ID)).toMatch(/^[0-9a-f-]{36}$/);
    expect(wb.plos.find((r) => r.Code === 'PLO1' && r['Program code'] === 'BS-CE')).toMatchObject({ 'Program name': 'BS Civil Engineering', 'Statement (English)': 'Solve complex problems', 'Bloom level': 'Apply', Status: 'Draft' });
    expect(wb.lists.units).toContain('Engineering');
    expect(wb.lists.languages[0]).toBe('English');
    const back = await w.as('alo', (c) => upsertPrograms(c, { workbook: { programs: wb.programs, peos: wb.peos, plos: wb.plos }, apply: false }));
    expect(back.rows.filter((r) => r.action !== 'unchanged')).toEqual([]);
  });

  it('updates by ID even when the code changes, retires an outcome by its Status, finds a unit by its org-chart path, and refuses a code already taken', async () => {
    const wb = await w.as('alo', (c) => exportPrograms(c));
    const ce = wb.programs.find((r) => r['Program code'] === 'BS-CE')!;
    const plo = wb.plos.find((r) => r['Program code'] === 'BS-CE' && r.Code === 'PLO1')!;
    const dept = (await w.db.su.query(`insert into org_unit (institution_id, parent_id, type, name_en) select institution_id, id, 'department', 'Civil' from org_unit where name_en = 'Engineering' returning id`)).rows[0].id as string;
    const r = await w.as('alo', (c) => upsertPrograms(c, { apply: true, workbook: {
      programs: [{ ...ce, 'Program code': 'BSCE', Unit: 'Engineering › Civil' }],
      peos: [],
      plos: [{ ...plo, 'Program code': 'BSCE', Code: 'PLO-A', Status: 'Retired' }],
    } }));
    expect(r.rows.map((x) => [x.sheet, x.action, x.message.replace(/ Missing:.*$/, '')])).toEqual([
      ['Programs', 'update', 'Changes: orgUnitId, code (code was BS-CE).'],
      ['PLOs', 'update', 'Changes: code, status (code was PLO1).'],
    ]);
    const now = (await w.as('alo', (c) => listPrograms(c))).find((p) => p.id === ce.ID)!;
    expect(now).toMatchObject({ code: 'BSCE', orgUnitId: dept });
    expect((await w.db.su.query(`select code, status from learning_outcome where id = $1`, [plo.ID])).rows[0]).toEqual({ code: 'PLO-A', status: 'retired' });
    // A code another program holds is refused (the row is skipped, nothing changes); an unknown ID is refused.
    const clash = await w.as('alo', (c) => upsertPrograms(c, { apply: true, workbook: { programs: [{ ID: ce.ID as string, 'Program code': 'MS-CE' }, { ID: '00000000-0000-4000-8000-000000000000', 'Program code': 'ZZ' }], peos: [], plos: [] } }));
    expect(clash.rows.map((x) => [x.action, x.message])).toEqual([
      ['skip', 'the Program code MS-CE belongs to another program (MS Civil Engineering)'],
      ['skip', 'no program with the ID 00000000-0000-4000-8000-000000000000 (leave the ID empty to add a program)'],
    ]);
  });
});
