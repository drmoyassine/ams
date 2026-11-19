// The academic workbook (DEC-045): programs and courses in ONE file. Programs apply first, so a course may name a program that only the
// file adds; a preview is the apply inside a savepoint that is taken back, so it shows exactly that and writes nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AcademicWorkbook } from '@ams/shared';
import { emptyAcademicWorkbook } from '@ams/shared';
import { buildWorld, type World } from '../engagement/test-support.js';
import { listPrograms } from '../org/programs.js';
import { listCourses } from '../outcomes/courses.js';
import { getProgramRequirements } from '../catalog/catalog.js';
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
    expect(course.placements).toEqual([{ programId: program.id, role: 'core', year: 1, term: 1, block: null, concentrationId: null }]);
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

describe('the degree\'s structure in the same file', () => {
  const structure = wb({
    catalog: [{ Setting: 'General education credits', Value: 6 }],
    genedAreas: [{ Code: 'HUM', 'Name (English)': 'Humanities', 'Minimum credits': 3, Courses: 'HUM 101; HUM 999' }],
    programs: [{ 'Program code': 'BS-ENG', 'Name (English)': 'BS Engineering', Unit: 'Engineering', 'Program level': 'Bachelor', Type: 'Degree', Mode: 'On-campus', Credits: 15, Years: 4, 'Contact hours': 1500, Language: 'English', Mission: 'To engineer.', 'Name (Arabic)': 'ب' },
      { 'Program code': 'MIN-ENG', 'Name (English)': 'Minor in Engineering', Unit: 'Engineering', 'Program level': 'Bachelor', Type: 'Minor', Credits: 9, Language: 'English', Mission: 'A minor.', 'Name (Arabic)': 'ب' }],
    concentrations: [{ 'Program code': 'BS-ENG', Code: 'DES', 'Name (English)': 'Design' }],
    blocks: [{ 'Program code': 'BS-ENG', Block: 'Major requirements', 'Core credits': 6, 'Elective credits': 3 }, { 'Program code': 'BS-ENG', Concentration: 'DES', Block: 'Concentration requirements', 'Core credits': 3 }],
    courses: [{ 'Course code': 'HUM 101', 'Title (English)': 'Ethics', Unit: 'Engineering', 'Credit hours': 3 }, { 'Course code': 'ENG 201', 'Title (English)': 'Mechanics', Unit: 'Engineering', 'Credit hours': 6 },
      { 'Course code': 'ENG 301', 'Title (English)': 'Design Studio', Unit: 'Engineering', 'Credit hours': 3 }],
    studyPlan: [{ 'Course code': 'HUM 101', 'Program code': 'BS-ENG', Role: 'Core', Block: 'General education', Year: 1, Term: 1 }, { 'Course code': 'ENG 201', 'Program code': 'BS-ENG', Role: 'Core', Block: 'Major requirements', Year: 2, Term: 1 },
      { 'Course code': 'ENG 301', 'Program code': 'BS-ENG', Role: 'Core', Block: 'Concentration requirements', Concentration: 'DES', Year: 3, Term: 1 }],
    slots: [{ 'Program code': 'BS-ENG', Block: 'Major requirements', 'Slot name': 'Major elective', Rule: 'Any ENG 4xx', Credits: 3, Year: 4, Term: 1 }, { 'Program code': 'BS-ENG', Block: 'General education', 'Slot name': 'GenEd elective', Area: 'HUM', Credits: 3, Year: 1, Term: 2 }],
  });

  it('previews and applies settings, areas and their pools, a minor, concentrations, block credits, the study plan with blocks and slots; the checks then agree', async () => {
    const preview = await w.as('alo', (c) => upsertAcademic(c, { workbook: structure, apply: false }));
    expect(preview.rows.filter((r) => r.action === 'skip')).toEqual([]);
    expect(preview.rows.find((r) => r.sheet === 'GenEd areas' && r.code === 'HUM courses')).toMatchObject({ action: 'update', message: '1 course in the pool; no course HUM 999.' });
    expect((await w.as('alo', (c) => listPrograms(c))).some((p) => p.code === 'BS-ENG')).toBe(false);
    const done = await w.as('alo', (c) => upsertAcademic(c, { workbook: structure, apply: true }));
    expect(done.skipped).toBe(0);
    const programs = await w.as('alo', (c) => listPrograms(c));
    const prog = programs.find((p) => p.code === 'BS-ENG')!;
    expect(programs.find((p) => p.code === 'MIN-ENG')).toMatchObject({ programType: 'minor', missing: [] });
    const r = await w.as('alo', (c) => getProgramRequirements(c, prog.id));
    expect(r.concentrations.map((k) => k.code)).toEqual(['DES']);
    expect(r.genedCredits).toBe(6);
    expect(r.slots.map((x) => [x.name, x.block, x.credits])).toEqual([['GenEd elective', 'general_education', 3], ['Major elective', 'major', 3]]);
    expect(r.courses.map((x) => [x.code, x.block, x.concentrationId ? 'DES' : null])).toEqual([['HUM 101', 'general_education', null], ['ENG 201', 'major', null], ['ENG 301', 'concentration', 'DES']]);
    // 3 + 3 (GenEd) + 9 (major) + 3 (concentration) = 18, not the 15 of the program: the check says so, and nothing else.
    expect(r.issues.map((i) => i.message)).toEqual(['With Design, the blocks add up to 18 credits, the program has 15.']);
    expect(r.areas.find((a) => a.code === 'HUM')!.planned).toBe(6);
  });

  it('exports the structure and reads it back unchanged', async () => {
    const all = await w.as('alo', (c) => exportAcademic(c));
    expect(all.concentrations.map((x) => x.Code)).toContain('DES');
    expect(all.blocks.map((x) => [x.Block, x['Core credits'], x['Elective credits']])).toContainEqual(['Major requirements', 6, 3]);
    expect(all.catalog).toEqual([{ Setting: 'General education credits', Value: 6 }]);
    expect(all.genedAreas[0]).toMatchObject({ Code: 'HUM', Courses: 'HUM 101' });
    expect(all.studyPlan.find((x) => x['Course code'] === 'ENG 301')).toMatchObject({ Block: 'Concentration requirements', Concentration: 'DES' });
    const { lists: _l, ...rows } = all; void _l;
    const back = await w.as('alo', (c) => upsertAcademic(c, { workbook: rows, apply: false }));
    expect(back.rows.filter((x) => x.action !== 'unchanged').map((x) => `${x.sheet} ${x.code} ${x.action} ${x.message}`)).toEqual([]);
  });

  it('skips, with the reason, a catalog row the person may not apply', async () => {
    const r = await w.as('contrib', (c) => upsertAcademic(c, { workbook: wb({ catalog: [{ Setting: 'General education credits', Value: 40 }] }), apply: false }));
    expect(r.rows).toEqual([expect.objectContaining({ sheet: 'Catalog settings', action: 'skip', message: expect.stringMatching(/permission/i) })]);
  });
});
