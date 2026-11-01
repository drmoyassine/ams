// Loading programs, PEOs and PLOs from the Integrated Assessment Plan rows: preview changes nothing; apply creates the missing school
// and programs, fills empty fields, adds outcomes as drafts with their source; a second load changes nothing; nothing recorded is
// overwritten; only an institution-wide writer may load.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { listPrograms } from '../org/programs.js';
import { getProgramOutcomes } from './outcomes.js';
import { loadOutcomesWorkbook, _forTests } from './workbook.js';

let w: World;
beforeAll(async () => { w = await buildWorld('workbook'); }, 120000);
afterAll(() => w.close());

const rows = {
  source: 'Integrated Assessment Plan v3',
  programs: [
    { programId: 'BS-ECE', title: 'Bachelor of Science in Electrical and Computer Engineering', mission: 'To deliver practice-oriented education.', school: 'School of Engineering and Computing (SEC)' },
    { programId: 'BS-MCE', title: 'BS Mechanical Engineering', mission: 'A different mission', school: 'School of Engineering and Computing (SEC)' },
    { programId: null, title: 'Orphan program', mission: null, school: null },
  ],
  peos: [{ id: 'ECE.PEO1', text: 'Practice and innovation', program: 'Bachelor of Science in Electrical and Computer Engineering' }],
  plos: [
    { id: 'ECE.SO1', text: 'An ability to identify, formulate, and solve complex engineering problems', program: 'Bachelor of Science in Electrical and Computer Engineering' },
    { id: 'MCE.SO1', text: 'An ability to identify problems', program: 'BS Mechanical Engineering' },
    { id: 'X.SO1', text: 'x', program: 'Unknown program' },
  ],
};

describe('loading the workbook', () => {
  it('reads schools and degree levels from the titles', () => {
    expect(_forTests.schoolOf('School of Engineering and Computing (SEC)')).toEqual({ name: 'School of Engineering and Computing', code: 'SEC' });
    expect(_forTests.degreeOf('Bachelor of Fine Arts in Interior Design')).toBe('bachelor');
    expect(_forTests.degreeOf('Master of Science in Robotics')).toBe('master');
  });

  it('previews without changing anything, then applies additively, and a second load changes nothing', async () => {
    await expect(w.as('coord', (c) => loadOutcomesWorkbook(c, { ...rows, apply: false }))).rejects.toThrow(ForbiddenError);
    const before = (await w.as('admin', (c) => listPrograms(c))).length;
    const preview = await w.as('admin', (c) => loadOutcomesWorkbook(c, { ...rows, apply: false }));
    expect(preview).toMatchObject({ applied: false, unitsCreated: ['School of Engineering and Computing'], programsCreated: ['Bachelor of Science in Electrical and Computer Engineering'], outcomesCreated: 3 });
    expect(preview.programsUpdated).toEqual([{ program: 'BS Mechanical Engineering', fields: ['code', 'mission'] }]);
    expect(preview.skipped.map((s) => s.row).sort()).toEqual(['Orphan program', 'X.SO1']);
    expect((await w.as('admin', (c) => listPrograms(c))).length).toBe(before);

    const done = await w.as('admin', (c) => loadOutcomesWorkbook(c, { ...rows, apply: true }));
    expect(done).toMatchObject({ applied: true, outcomesCreated: 3 });
    const ece = (await w.as('admin', (c) => listPrograms(c))).find((p) => p.code === 'BS-ECE')!;
    expect(ece).toMatchObject({ mission: 'To deliver practice-oriented education.', degreeLevel: 'bachelor' });
    const view = await w.as('admin', (c) => getProgramOutcomes(c, ece.id));
    expect(view.plos).toMatchObject([{ code: 'SO1', status: 'draft', source: 'Integrated Assessment Plan v3' }]);
    expect(view.peos.map((p) => p.code)).toEqual(['PEO1']);

    const again = await w.as('admin', (c) => loadOutcomesWorkbook(c, { ...rows, programs: rows.programs.map((p) => (p.programId === 'BS-MCE' ? { ...p, mission: 'Changed mission' } : p)), plos: [...rows.plos.slice(0, 2), { ...rows.plos[1]!, text: 'Reworded' }], apply: true }));
    expect(again).toMatchObject({ unitsCreated: [], programsCreated: [], programsUpdated: [], outcomesCreated: 0, outcomesUnchanged: 3 });
    expect(again.skipped.some((s) => s.row === 'BS Mechanical Engineering' && /mission differs/.test(s.reason))).toBe(true);
    expect(again.skipped.some((s) => s.row === 'MCE.SO1' && /other words/.test(s.reason))).toBe(true);
  });
});
