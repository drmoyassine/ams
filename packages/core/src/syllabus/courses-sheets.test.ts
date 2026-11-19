// The courses workbook (DEC-042): a course's record and study plan change at once, its content goes into its draft; a part of the content is
// replaced only when the file has rows for it; content that comes out the same makes no draft; and the export reads back unchanged.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoursesWorkbook } from '@ams/shared';
import { buildWorld, type World } from '../engagement/test-support.js';
import { updateProgram } from '../org/programs.js';
import { createOutcome } from '../outcomes/outcomes.js';
import { listCourses } from '../outcomes/courses.js';
import { exportCourses, upsertCourses } from './courses-sheets.js';
import { getSyllabusOverview } from './syllabus.js';

let w: World;
beforeAll(async () => {
  w = await buildWorld('coursesheets');
  await w.as('alo', (c) => updateProgram(c, w.ids.mech!, { code: 'BS-ME' }));
  await w.as('alo', (c) => createOutcome(c, { kind: 'plo', programId: w.ids.mech!, code: 'PLO1', textEn: 'Solve problems' }));
}, 120000);
afterAll(() => w.close());
const wb = (over: Partial<CoursesWorkbook>): CoursesWorkbook => ({ courses: [], studyPlan: [], clos: [], outline: [], materials: [], assessments: [], rubrics: [], sections: [], ...over });

describe('the courses workbook', () => {
  it('adds a course with its studyPlan at once and its CLOs into a draft; a preview writes nothing', async () => {
    const file = wb({
      courses: [{ 'Course code': 'MCE 101', 'Title (English)': 'Statics', Unit: 'Engineering', 'Credit hours': 3, 'Year of study': 1, 'Description (English)': 'Forces in equilibrium.' }],
      studyPlan: [{ 'Course code': 'MCE 101', 'Program code': 'BS-ME', Role: 'Core', Year: 1, Term: 1 }],
      clos: [{ 'Course code': 'MCE 101', CLO: 'CLO1', 'Outcome (English)': 'Resolve forces', 'Bloom level': 'Apply', PLO: 'PLO1', Coverage: 'Introduced' }],
    });
    const preview = await w.as('alo', (c) => upsertCourses(c, { workbook: file, apply: false }));
    expect(preview.rows.map((r) => [r.sheet, r.action])).toEqual([['Courses', 'add'], ['Study plan', 'add'], ['Content', 'draft']]);
    expect((await w.as('alo', (c) => listCourses(c))).some((x) => x.code === 'MCE 101')).toBe(false);
    const done = await w.as('alo', (c) => upsertCourses(c, { workbook: file, apply: true }));
    expect(done).toMatchObject({ added: 2, drafted: 1, skipped: 0 });
    const course = (await w.as('alo', (c) => listCourses(c))).find((x) => x.code === 'MCE 101')!;
    expect(course).toMatchObject({ titleEn: 'Statics', credits: 3, level: 1, placements: [{ programId: w.ids.mech, role: 'core', year: 1, term: 1 }], missing: [] });
    const open = (await w.as('alo', (c) => getSyllabusOverview(c, course.id))).open!;
    expect(open.content.clos.map((x) => [x.code, x.textEn, x.plos.length])).toEqual([['CLO1', 'Resolve forces', 1]]);
    expect(open.content.description.en).toBe('Forces in equilibrium.');
  });

  it('changes a record at once, leaves content parts the file has no rows for, and reads its own export back unchanged', async () => {
    const all = await w.as('alo', (c) => exportCourses(c));
    const row = all.courses.find((r) => r['Course code'] === 'MCE 101')!;
    expect(String(row.ID)).toMatch(/^[0-9a-f-]{36}$/);
    expect(all.clos.find((r) => r['Course code'] === 'MCE 101')).toMatchObject({ 'Course title': 'Statics', CLO: 'CLO1' });
    expect(all.lists.programs).toContain('BS-ME');
    const back = await w.as('alo', (c) => upsertCourses(c, { workbook: { courses: all.courses, studyPlan: all.studyPlan, clos: all.clos, outline: all.outline, materials: all.materials, assessments: all.assessments, rubrics: all.rubrics, sections: all.sections }, apply: false }));
    expect(back.rows.filter((r) => r.action !== 'unchanged').map((r) => `${r.sheet} ${r.code} ${r.action} ${r.message}`)).toEqual([]);
    // Only the Courses sheet, with a new year and a new title: the year applies at once, the title goes into the draft, the CLOs stay.
    const r = await w.as('alo', (c) => upsertCourses(c, { apply: true, workbook: wb({ courses: [{ ID: row.ID as string, 'Year of study': 2, 'Title (English)': 'Engineering Statics' }] }) }));
    expect(r.rows.map((x) => [x.sheet, x.action])).toEqual([['Courses', 'update'], ['Content', 'draft']]);
    const course = (await w.as('alo', (c) => listCourses(c))).find((x) => x.code === 'MCE 101')!;
    expect(course).toMatchObject({ level: 2, titleEn: 'Statics' }); // the title waits for approval
    const open = (await w.as('alo', (c) => getSyllabusOverview(c, course.id))).open!;
    expect(open.content.info.titleEn).toBe('Engineering Statics');
    expect(open.content.clos.map((x) => x.code)).toEqual(['CLO1']);
  });

  it('skips what it cannot place, with the reason', async () => {
    const r = await w.as('alo', (c) => upsertCourses(c, { apply: false, workbook: wb({
      courses: [{ 'Course code': 'XYZ 1', 'Title (English)': 'No unit' }],
      studyPlan: [{ 'Course code': 'MCE 101', 'Program code': 'NOPE' }],
    }) }));
    expect(r.rows.map((x) => [x.action, x.message])).toEqual([
      ['skip', 'a new course needs Unit, Credit hours'],
      ['skip', 'no program with the code NOPE'],
    ]);
  });
});
