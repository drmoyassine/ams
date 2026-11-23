// The catalog's structure (DEC-046, step 2): General Education in areas, concentrations, block credits, elective slots and the checks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createCourse, setCourseProgram } from '../outcomes/courses.js';
import { updateProgram } from '../org/programs.js';
import {
  createConcentration, createGenedArea, createStudySlot, deleteConcentration, getProgramRequirements, listGenedAreas, setAreaCourses, setCatalogSettings, setProgramBlock, updateGenedArea, updateStudySlot,
} from './catalog.js';

let w: World;
const ids = {} as Record<string, string>;
beforeAll(async () => {
  w = await buildWorld('catalog');
  await w.as('alo', (c) => updateProgram(c, w.ids.mech!, { code: 'BS-ME', credits: 20 }));
  for (const [code, credits] of [['ENG 101', 3], ['HUM 101', 3], ['MCE 201', 6], ['MCE 301', 5]] as const) {
    ids[code] = (await w.as('alo', (c) => createCourse(c, { code, titleEn: code, credits, orgUnitId: null } as never))).id;
  }
}, 120000);
afterAll(() => w.close());
const req = () => w.as('alo', (c) => getProgramRequirements(c, w.ids.mech!));

describe('General Education', () => {
  it('is set by someone with program:write for the whole institution: the credits, the areas with a minimum, and each area\'s pool', async () => {
    await expect(w.as('contrib', (c) => setCatalogSettings(c, { genedCredits: 6 }))).rejects.toThrow(ForbiddenError);
    await expect(w.as('contrib', (c) => createGenedArea(c, { code: 'X', nameEn: 'X', minCredits: 0 }))).rejects.toThrow(ForbiddenError);
    expect(await w.as('alo', (c) => setCatalogSettings(c, { genedCredits: 6 }))).toEqual({ genedCredits: 6, freeElectiveCredits: null });
    const eng = await w.as('alo', (c) => createGenedArea(c, { code: 'ENG', nameEn: 'English', minCredits: 3 }));
    const hum = await w.as('alo', (c) => createGenedArea(c, { code: 'HUM', nameEn: 'Humanities', minCredits: 3 }));
    ids.eng = eng.id; ids.hum = hum.id;
    await w.as('alo', (c) => setAreaCourses(c, eng.id, [ids['ENG 101']!]));
    await w.as('alo', (c) => setAreaCourses(c, hum.id, [ids['HUM 101']!]));
    await expect(w.as('alo', (c) => createGenedArea(c, { code: 'eng', nameEn: 'Again', minCredits: 0 }))).rejects.toThrow();
    const all = await w.as('alo', (c) => listGenedAreas(c));
    expect(all.settings.genedCredits).toBe(6);
    expect(all.areas.map((a) => [a.code, a.minCredits, a.courseIds.length])).toEqual([['ENG', 3, 1], ['HUM', 3, 1]]);
  });
});

describe('a degree\'s requirements', () => {
  it('counts the study plan by block, concentration and core or elective, and flags what does not add up', async () => {
    const a = await w.as('alo', (c) => createConcentration(c, { programId: w.ids.mech!, code: 'THERM', nameEn: 'Thermal Systems' }));
    ids.therm = a.id;
    await expect(w.as('contrib', (c) => createConcentration(c, { programId: w.ids.mech!, code: 'X', nameEn: 'X' }))).rejects.toThrow(ForbiddenError);
    await w.as('alo', (c) => setCourseProgram(c, ids['ENG 101']!, w.ids.mech!, { role: 'core', year: 1, term: 1, block: 'general_education' }));
    await w.as('alo', (c) => setCourseProgram(c, ids['MCE 201']!, w.ids.mech!, { role: 'core', year: 2, term: 1, block: 'major' }));
    await w.as('alo', (c) => setCourseProgram(c, ids['MCE 301']!, w.ids.mech!, { role: 'core', year: 3, term: 1, block: 'concentration', concentrationIds: [ids.therm!] }));
    await w.as('alo', (c) => setCourseProgram(c, ids['HUM 101']!, w.ids.mech!, { role: 'elective', year: 1, term: 2 })); // in no block yet
    let r = await req();
    expect(r.courses.map((c) => [c.code, c.block, c.role])).toEqual([['ENG 101', 'general_education', 'core'], ['HUM 101', null, 'elective'], ['MCE 201', 'major', 'core'], ['MCE 301', 'concentration', 'core']]);
    expect(r.issues.map((i) => i.kind).sort()).toEqual(['gened_area', 'gened_total', 'total_credits', 'unplaced_course']);
    expect(r.issues.find((i) => i.kind === 'gened_total')!.message).toBe('General education: 3 credits planned, the institution asks 6.');
    expect(r.issues.find((i) => i.kind === 'gened_area')!.message).toBe('General education, Humanities: 0 credits planned, at least 3 asked.');
    expect(r.issues.find((i) => i.kind === 'total_credits')!.message).toBe('With Thermal Systems, the blocks add up to 14 credits, the program has 20.');
    // Place the course, add a major elective slot of 3 credits, and the total reaches 20 (6 + 6 + 3 + 5).
    await w.as('alo', (c) => setCourseProgram(c, ids['HUM 101']!, w.ids.mech!, { role: 'core', block: 'general_education' }));
    const slot = await w.as('alo', (c) => createStudySlot(c, { programId: w.ids.mech!, block: 'major', requirement: 'elective', name: 'Major elective', rule: 'Any MCE 4xx', credits: 3, year: 4, term: 1 }));
    ids.slot = slot.id;
    await expect(w.as('alo', (c) => createStudySlot(c, { programId: w.ids.mech!, block: 'major', name: 'Bad', requirement: 'elective', credits: 3, concentrationId: crypto.randomUUID() }))).rejects.toThrow();
    r = await req();
    expect(r.issues).toEqual([]);
    expect(r.totals.filter((t) => t.block === 'major').map((t) => [t.requirement, t.planned, t.target])).toEqual([['core', 6, null], ['elective', 3, null]]);
    expect(r.areas.map((a) => [a.code, a.planned])).toEqual([['ENG', 3], ['HUM', 3]]);
  });

  it('checks the credits asked of each block, per concentration, and a concentration nobody uses is deleted but one in use is deactivated', async () => {
    await w.as('alo', (c) => setProgramBlock(c, { programId: w.ids.mech!, block: 'major', requirement: 'core', credits: 9 }));
    await w.as('alo', (c) => setProgramBlock(c, { programId: w.ids.mech!, block: 'concentration', concentrationId: ids.therm!, requirement: 'core', credits: 5 }));
    await expect(w.as('alo', (c) => setProgramBlock(c, { programId: w.ids.mech!, block: 'concentration', requirement: 'core', credits: 5 }))).rejects.toThrow(/belongs to a concentration/);
    await expect(w.as('alo', (c) => setProgramBlock(c, { programId: w.ids.mech!, block: 'major', concentrationId: ids.therm!, requirement: 'core', credits: 5 }))).rejects.toThrow(/only the concentration block/);
    let r = await req();
    expect(r.issues.map((i) => i.message)).toEqual(['Major core credits: 6 planned, 9 asked.']);
    await w.as('alo', (c) => setProgramBlock(c, { programId: w.ids.mech!, block: 'major', requirement: 'core', credits: null })); // cleared
    expect((await req()).issues).toEqual([]);
    const empty = await w.as('alo', (c) => createConcentration(c, { programId: w.ids.mech!, code: 'EMPTY', nameEn: 'Empty track' }));
    r = await req();
    expect(r.issues.map((i) => [i.kind, i.message])).toEqual([['no_concentration_credits', 'Empty track has no courses or credits of its own.']]);
    expect((await w.as('alo', (c) => deleteConcentration(c, empty.id))).deleted).toBe(true);
    const used = await w.as('alo', (c) => deleteConcentration(c, ids.therm!));
    expect(used).toMatchObject({ deleted: false, concentration: { active: false } });
  });

  it('a minor has no General Education check and needs no mode, years, contact hours or PEOs', async () => {
    const [{ id }] = (await w.db.su.query(`insert into program (institution_id, org_unit_id, name_en, degree_level, program_type, code, credits, mission, language_of_instruction, name_ar) select institution_id, org_unit_id, 'Minor in Data', 'bachelor', 'minor', 'MIN-DATA', 15, 'To add data skills.', 'English', 'x' from program limit 1 returning id`)).rows;
    const r = await w.as('alo', (c) => getProgramRequirements(c, id));
    expect(r).toMatchObject({ programType: 'minor', credits: 15, issues: [] });
    const missing = (await w.as('alo', async (c) => (await import('../org/programs.js')).getProgram(c, id))).missing;
    expect(missing).toEqual([]);
    await w.as('alo', (c) => updateStudySlot(c, ids.slot!, { credits: 3, name: 'Major elective (any MCE 4xx)' }));
    await w.as('alo', (c) => updateGenedArea(c, ids.eng!, { minCredits: 3 }));
  });
});

describe('prerequisites against the study plan', () => {
  it('flags a prerequisite that is not in the plan, not earlier, or a cycle; alternatives need only one; nothing flagged when the order is right', async () => {
    const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;
    const req = async (course: string, requisite: string, group: number | null) => q(`insert into course_requisite (institution_id, course_id, requisite_id, kind, group_no) values ($1, $2, $3, 'prerequisite', $4)`, [w.ids.inst, ids[course], ids[requisite], group]);
    // MCE 301 is year 3; MCE 201 year 2 term 1; ENG 101 year 1 term 1; HUM 101 year 1 term 2 (see the tests above).
    await w.as('alo', (c) => setCourseProgram(c, ids['MCE 301']!, w.ids.mech!, { role: 'core', year: 3, term: 1 }));
    await w.as('alo', (c) => setCourseProgram(c, ids['MCE 201']!, w.ids.mech!, { role: 'core', year: 2, term: 1 }));
    const extra = (await w.as('alo', (c) => createCourse(c, { code: 'PHY 100', titleEn: 'Physics', credits: 3, orgUnitId: null } as never))).id; ids['PHY 100'] = extra;
    const issues = async () => (await req_()).issues.filter((i) => i.kind.startsWith('requisite')).map((i) => i.message);
    const req_ = () => w.as('alo', (c) => getProgramRequirements(c, w.ids.mech!));
    // MCE 301 needs MCE 201 (earlier: fine) and PHY 100 or ENG 101 (ENG 101 is earlier: one is enough).
    await req('MCE 301', 'MCE 201', 1); await req('MCE 301', 'PHY 100', 2); await req('MCE 301', 'ENG 101', 2);
    expect(await issues()).toEqual([]);
    // PHY 100 only: it is not in this study plan.
    await q(`delete from course_requisite where course_id = $1 and requisite_id = $2`, [ids['MCE 301'], ids['ENG 101']]);
    expect(await issues()).toEqual(['MCE 301 needs PHY 100, which is not in this study plan.']);
    // MCE 201 needs MCE 301, which comes later; and MCE 301 needs MCE 201: a cycle, and the order is wrong.
    await q(`delete from course_requisite where course_id = $1 and requisite_id = $2`, [ids['MCE 301'], ids['PHY 100']]);
    await req('MCE 201', 'MCE 301', null);
    const found = await issues();
    expect(found).toContain('MCE 201 (year 2 term 1) needs MCE 301 first, but MCE 301 is not earlier in the plan.');
    expect(found).toContain('MCE 201 is its own prerequisite, through a chain of prerequisites.');
    expect(found).toContain('MCE 301 is its own prerequisite, through a chain of prerequisites.');
    await q(`delete from course_requisite where course_id = $1`, [ids['MCE 201']]);
    expect(await issues()).toEqual([]);
  });
});
