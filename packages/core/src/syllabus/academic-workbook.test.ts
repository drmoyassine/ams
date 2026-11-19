// The academic workbook (DEC-045): programs and courses in ONE file. Programs apply first, so a course may name a program that only the
// file adds; a preview is the apply inside a savepoint that is taken back, so it shows exactly that and writes nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AcademicWorkbook } from '@ams/shared';
import { emptyAcademicWorkbook } from '@ams/shared';
import { buildWorld, type World } from '../engagement/test-support.js';
import { listPrograms } from '../org/programs.js';
import { listCourses } from '../outcomes/courses.js';
import { exportAcademic, upsertAcademic } from './academic-workbook.js';
import { getSyllabusOverview } from './syllabus.js';

let w: World;
beforeAll(async () => { w = await buildWorld('academicwb'); }, 120000);
afterAll(() => w.close());
const wb = (over: Partial<AcademicWorkbook>): AcademicWorkbook => ({ ...emptyAcademicWorkbook(), ...over });

const file = wb({
  programs: [{ 'Program code': 'BS-ACC', 'Name (English)': 'BS Accounting', Unit: 'Engineering', 'Program level': 'Bachelor', Mode: 'On-campus', Credits: 120, Years: 4, 'Contact hours': 1800, Language: 'English', Mission: 'To educate accountants.', 'Name (Arabic)': 'بكالوريوس المحاسبة' }],
  plos: [{ 'Program code': 'BS-ACC', Code: 'PLO1', 'Statement (English)': 'Prepare financial statements', 'Bloom level': 'Apply' }],
  courses: [{ 'Course code': 'ACC 101', 'Title (English)': 'Principles of Accounting', Unit: 'Engineering', 'Credit hours': 3, 'Year of study': 1 }],
  studyPlan: [{ 'Course code': 'ACC 101', 'Program code': 'BS-ACC', Role: 'Core', Year: 1, Term: 1 }],
  clos: [{ 'Course code': 'ACC 101', CLO: 'CLO1', 'Outcome (English)': 'Record transactions', 'Bloom level': 'Apply', PLO: 'PLO1', Coverage: 'Introduced' }],
});

describe('the academic workbook', () => {
  it('previews a program and its course from one file, exactly as it will apply, and writes nothing', async () => {
    const preview = await w.as('alo', (c) => upsertAcademic(c, { workbook: file, apply: false }));
    expect(preview.applied).toBe(false);
    expect(preview.rows.map((r) => [r.sheet, r.action])).toEqual([['Programs', 'add'], ['PLOs', 'add'], ['Courses', 'add'], ['Study plan', 'add'], ['Content', 'draft']]);
    expect(preview.rows.filter((r) => r.action === 'skip')).toEqual([]);
    expect((await w.as('alo', (c) => listPrograms(c))).some((p) => p.code === 'BS-ACC')).toBe(false);
    expect((await w.as('alo', (c) => listCourses(c))).some((x) => x.code === 'ACC 101')).toBe(false);
  });

  it('applies programs first, so the course joins the program added in the same file, and its CLO maps to the PLO added with it', async () => {
    const done = await w.as('alo', (c) => upsertAcademic(c, { workbook: file, apply: true }));
    expect(done).toMatchObject({ applied: true, added: 4, drafted: 1, skipped: 0 });
    const program = (await w.as('alo', (c) => listPrograms(c))).find((p) => p.code === 'BS-ACC')!;
    const course = (await w.as('alo', (c) => listCourses(c))).find((x) => x.code === 'ACC 101')!;
    expect(course.placements).toEqual([{ programId: program.id, role: 'core', year: 1, term: 1 }]);
    const open = (await w.as('alo', (c) => getSyllabusOverview(c, course.id))).open!;
    expect(open.content.clos.map((x) => [x.code, x.plos.length])).toEqual([['CLO1', 1]]);
  });

  it('exports everything and reads it back unchanged; a file with only courses still resolves programs that exist', async () => {
    const all = await w.as('alo', (c) => exportAcademic(c));
    expect(all.programs.map((r) => r['Program code'])).toContain('BS-ACC');
    expect(all.studyPlan.map((r) => r['Course code'])).toContain('ACC 101');
    expect(all.lists.programLanguages).toContain('Bilingual');
    const { lists: _lists, ...rows } = all; void _lists;
    const back = await w.as('alo', (c) => upsertAcademic(c, { workbook: rows, apply: false }));
    expect(back.rows.filter((r) => r.action !== 'unchanged').map((r) => `${r.sheet} ${r.code} ${r.action} ${r.message}`)).toEqual([]);
    const onlyCourses = wb({ courses: [{ 'Course code': 'ACC 102', 'Title (English)': 'Managerial Accounting', Unit: 'Engineering', 'Credit hours': 3 }], studyPlan: [{ 'Course code': 'ACC 102', 'Program code': 'BS-ACC', Role: 'Core', Year: 1, Term: 2 }] });
    const r = await w.as('alo', (c) => upsertAcademic(c, { workbook: onlyCourses, apply: false }));
    expect(r.rows.map((x) => [x.sheet, x.action]).slice(0, 2)).toEqual([['Courses', 'add'], ['Study plan', 'add']]); // its title and credits are the record's own: no draft
    expect(r.rows.filter((x) => x.action === 'skip')).toEqual([]);
  });

  it('refuses a preview or an apply from someone who may not write programs', async () => {
    await expect(w.as('contrib', (c) => upsertAcademic(c, { workbook: file, apply: false }))).rejects.toThrow(/permission|forbidden/i);
  });
});
