// Programs, courses and learning outcomes (TASK-104, TASK-105, TASK-112): the program record, courses in programs, outcomes of every
// kind, links with the configurable levels (DEC-036), the curriculum map and the coverage checks, and who may change what.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { listPrograms, updateProgram } from '../org/programs.js';
import { createOrgUnit, updateOrgUnit } from '../org/units.js';
import { createCourse, listCourses, removeCourseProgram, setCourseProgram, updateCourse } from './courses.js';
import {
  createOutcome, deleteOutcome, getOutcomeLevels, getProgramOutcomes, listIlos, removeOutcomeLink, setOutcomeLevels, setOutcomeLink, updateOutcome,
} from './outcomes.js';

let w: World;
beforeAll(async () => { w = await buildWorld('outcomes'); }, 120000);
afterAll(() => w.close());

describe('the program record', () => {
  it('keeps code, SIS id, mission, vision and facts; codes are unique', async () => {
    const p = await w.as('alo', (c) => updateProgram(c, w.ids.mech!, { code: 'BS-MCE', externalId: 'MCE01', mission: '  To educate engineers.  ', durationYears: 4, credits: 132, mode: 'full_time' }));
    expect(p).toMatchObject({ code: 'BS-MCE', externalId: 'MCE01', mission: 'To educate engineers.', durationYears: 4, credits: 132, mode: 'full_time' });
    expect((await w.as('alo', (c) => updateProgram(c, w.ids.mech!, { mission: '' }))).mission).toBeNull();
    expect((await w.as('contrib', (c) => listPrograms(c)))[0]).toMatchObject({ code: 'BS-MCE' });
  });
});

describe('the unit record', () => {
  it('keeps a unique code and a student-system id', async () => {
    const u = await w.as('admin', (c) => createOrgUnit(c, { parentId: null, type: 'college', nameEn: 'School of Engineering and Computing', code: 'SEC', externalId: 'S01' }));
    expect(u).toMatchObject({ code: 'SEC', externalId: 'S01' });
    await expect(w.as('admin', (c) => createOrgUnit(c, { parentId: null, type: 'college', nameEn: 'Other', code: 'sec' }))).rejects.toThrow(ConflictError);
    expect((await w.as('admin', (c) => updateOrgUnit(c, u.id, { code: null }))).code).toBeNull();
  });
});

describe('courses', () => {
  it('are created by a program writer, serve programs, and refuse a duplicate code', async () => {
    const c1 = await w.as('alo', (c) => createCourse(c, { code: 'MCE 210', titleEn: 'Thermodynamics I', credits: 3, level: 2 }));
    expect(c1).toMatchObject({ code: 'MCE 210', credits: 3, level: 2, programIds: [], cloCount: 0 });
    await expect(w.as('alo', (c) => createCourse(c, { code: 'mce 210', titleEn: 'Again' }))).rejects.toThrow(/already exists/);
    await expect(w.as('contrib', (c) => createCourse(c, { code: 'X 1', titleEn: 'x' }))).rejects.toThrow(ForbiddenError);
    const linked = await w.as('coord', (c) => setCourseProgram(c, c1.id, w.ids.mech!, { role: 'core', year: 2, term: 1 }));
    expect(linked.programIds).toEqual([w.ids.mech]);
    expect((await w.as('contrib', (c) => listCourses(c, { programId: w.ids.mech! }))).map((c) => c.code)).toEqual(['MCE 210']);
    expect((await w.as('alo', (c) => updateCourse(c, c1.id, { titleEn: 'Thermodynamics 1' }))).titleEn).toBe('Thermodynamics 1');
  });
});

describe('outcomes, links, map and coverage', () => {
  it('builds a program\'s outcomes, maps CLOs to PLOs with levels (D read as R) and reports coverage', async () => {
    const ilo = await w.as('alo', (c) => createOutcome(c, { kind: 'ilo', code: 'ILO1', textEn: 'Critical thinking' }));
    await expect(w.as('coord', (c) => createOutcome(c, { kind: 'ilo', code: 'ILO2', textEn: 'x' }))).rejects.toThrow(ForbiddenError);
    const peo = await w.as('coord', (c) => createOutcome(c, { kind: 'peo', programId: w.ids.mech!, code: 'PEO1', textEn: 'Successful careers' }));
    const plo1 = await w.as('coord', (c) => createOutcome(c, { kind: 'plo', programId: w.ids.mech!, code: 'SO1', textEn: 'Solve complex problems', bloomLevel: 'apply' }));
    const plo2 = await w.as('coord', (c) => createOutcome(c, { kind: 'plo', programId: w.ids.mech!, code: 'SO2', textEn: 'Design' }));
    const pi = await w.as('coord', (c) => createOutcome(c, { kind: 'pi', parentId: plo1.id, code: 'SO1.1', textEn: 'Identify problems' }));
    expect(pi.programId).toBe(w.ids.mech);
    await expect(w.as('coord', (c) => createOutcome(c, { kind: 'plo', programId: w.ids.mech!, code: 'so1', textEn: 'dup' }))).rejects.toThrow(/already a PLO/);
    const [course] = await w.as('alo', (c) => listCourses(c, { programId: w.ids.mech! }));
    const clo1 = await w.as('alo', (c) => createOutcome(c, { kind: 'clo', courseId: course!.id, code: 'CLO1', textEn: 'Apply the first law' }));
    const clo2 = await w.as('alo', (c) => createOutcome(c, { kind: 'clo', courseId: course!.id, code: 'CLO2', textEn: 'Analyse cycles' }));

    await w.as('coord', (c) => setOutcomeLink(c, { fromId: clo1.id, toId: plo1.id, level: 'I' }));
    expect(await w.as('coord', (c) => setOutcomeLink(c, { fromId: clo2.id, toId: plo1.id, level: 'd' }))).toMatchObject({ level: 'R' });
    await w.as('coord', (c) => setOutcomeLink(c, { fromId: clo2.id, toId: plo2.id, level: null }));
    await expect(w.as('coord', (c) => setOutcomeLink(c, { fromId: clo1.id, toId: plo2.id, level: 'Z' }))).rejects.toThrow(ValidationError);
    await expect(w.as('coord', (c) => setOutcomeLink(c, { fromId: plo1.id, toId: ilo.id, level: 'M' }))).rejects.toThrow(/only a CLO-PLO/);
    await w.as('coord', (c) => setOutcomeLink(c, { fromId: plo1.id, toId: ilo.id }));
    await w.as('coord', (c) => setOutcomeLink(c, { fromId: plo1.id, toId: peo.id }));
    await expect(w.as('contrib', (c) => setOutcomeLink(c, { fromId: clo1.id, toId: plo2.id, level: 'I' }))).rejects.toThrow(ForbiddenError);

    const view = await w.as('contrib', (c) => getProgramOutcomes(c, w.ids.mech!));
    expect(view.plos.map((p) => p.code)).toEqual(['SO1', 'SO2']);
    expect(view.indicators.map((p) => p.code)).toEqual(['SO1.1']);
    expect(view.courses[0]).toMatchObject({ code: 'MCE 210', year: 2, clos: [{ code: 'CLO1' }, { code: 'CLO2' }] });
    expect(view.map.find((m) => m.ploId === plo1.id)).toMatchObject({ levels: ['I', 'R'], highest: 'R' });
    const kinds = view.coverage.map((i) => `${i.kind}:${i.label}`).sort();
    expect(kinds).toEqual(['link_no_level:MCE 210 CLO2', 'plo_no_ilo:SO2', 'plo_no_mastery:SO1', 'plo_no_mastery:SO2'].sort());

    await w.as('coord', (c) => setOutcomeLink(c, { fromId: clo2.id, toId: plo1.id, level: 'M' }));
    expect((await w.as('coord', (c) => getProgramOutcomes(c, w.ids.mech!))).coverage.some((i) => i.kind === 'plo_no_mastery' && i.label === 'SO1')).toBe(false);
    await w.as('coord', (c) => removeOutcomeLink(c, plo1.id, peo.id));
    expect((await w.as('coord', (c) => getProgramOutcomes(c, w.ids.mech!))).links.some((l) => l.toId === peo.id)).toBe(false);
    expect((await w.as('contrib', (c) => listIlos(c))).map((i) => i.code)).toEqual(['ILO1']);
  });

  it('keeps approved outcomes for the record and takes links away with a course that leaves the program', async () => {
    const view = await w.as('coord', (c) => getProgramOutcomes(c, w.ids.mech!));
    const so2 = view.plos.find((p) => p.code === 'SO2')!;
    await w.as('coord', (c) => updateOutcome(c, so2.id, { status: 'approved', approvedOn: '2026-10-01' }));
    await expect(w.as('coord', (c) => deleteOutcome(c, so2.id))).rejects.toThrow(ConflictError);
    const course = view.courses[0]!;
    await w.as('coord', (c) => removeCourseProgram(c, course.courseId, w.ids.mech!));
    const after = await w.as('coord', (c) => getProgramOutcomes(c, w.ids.mech!));
    expect(after.courses).toEqual([]);
    expect(after.links.filter((l) => view.courses[0]!.clos.some((o) => o.id === l.fromId))).toEqual([]);
    // A CLO cannot link to a PLO of a program its course is not in.
    await expect(w.as('coord', (c) => setOutcomeLink(c, { fromId: course.clos[0]!.id, toId: so2.id, level: 'I' }))).rejects.toThrow(/not part of/);
  });

  it('lets the institution rename or reorder levels, but not drop one in use', async () => {
    expect((await w.as('alo', (c) => getOutcomeLevels(c))).map((l) => l.code)).toEqual(['I', 'R', 'M']);
    const view = await w.as('coord', (c) => getProgramOutcomes(c, w.ids.mech!));
    const course = await w.as('alo', (c) => createCourse(c, { code: 'MCE 300', titleEn: 'Design' }));
    await w.as('coord', (c) => setCourseProgram(c, course.id, w.ids.mech!, { role: 'core' }));
    const clo = await w.as('alo', (c) => createOutcome(c, { kind: 'clo', courseId: course.id, code: 'CLO1', textEn: 'Design a system' }));
    await w.as('coord', (c) => setOutcomeLink(c, { fromId: clo.id, toId: view.plos[0]!.id, level: 'M' }));
    await expect(w.as('alo', (c) => setOutcomeLevels(c, [{ code: 'I', name: 'Introduced', aliases: [], mastery: true }]))).rejects.toThrow(/use the level M/);
    await expect(w.as('alo', (c) => setOutcomeLevels(c, [{ code: 'I', name: 'x', aliases: [], mastery: false }]))).rejects.toThrow();
    const renamed = await w.as('alo', (c) => setOutcomeLevels(c, [
      { code: 'I', name: 'Introduced', aliases: [], mastery: false }, { code: 'R', name: 'Developed', aliases: ['D'], mastery: false }, { code: 'M', name: 'Mastered', aliases: [], mastery: true },
    ]));
    expect(renamed[1]!.name).toBe('Developed');
    await expect(w.as('coord', (c) => setOutcomeLevels(c, renamed))).rejects.toThrow(ForbiddenError);
  });
});
