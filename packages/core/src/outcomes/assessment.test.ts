// Assessment of learning (TASK-114..117): the IE-001 plan and what it still lacks, course attainment by the QAIEO method and its PLO
// roll-up, results with their standing against the targets, importing results, corrective actions, and the ILO rotation report.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeAttainment } from '@ams/shared';
import { ConflictError, ForbiddenError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createCourse, setCourseProgram } from './courses.js';
import { createOutcome, setOutcomeLink } from './outcomes.js';
import {
  addAction, addResult, createPlan, getCourseAttainment, getIloReport, getProgramAssessment, importResults, recordCourseAttainment, saveCourseAssessment,
  saveIloSchedule, savePlanItem, setBenchmarks, updateAction, updatePlan,
} from './assessment.js';

let w: World;
const ids: Record<string, string> = {};
beforeAll(async () => {
  w = await buildWorld('assessment');
  const p = w.ids.mech!;
  ids.c1 = (await w.as('alo', (c) => createCourse(c, { code: 'MCE 410', titleEn: 'Heat Transfer' }))).id;
  await w.as('alo', (c) => setCourseProgram(c, ids.c1!, p, { role: 'core', year: 4 }));
  ids.so1 = (await w.as('alo', (c) => createOutcome(c, { kind: 'plo', programId: p, code: 'SO1', textEn: 'Solve problems' }))).id;
  ids.so2 = (await w.as('alo', (c) => createOutcome(c, { kind: 'plo', programId: p, code: 'SO2', textEn: 'Design' }))).id;
  ids.clo1 = (await w.as('alo', (c) => createOutcome(c, { kind: 'clo', courseId: ids.c1!, code: 'CLO1', textEn: 'Analyse conduction' }))).id;
  ids.clo2 = (await w.as('alo', (c) => createOutcome(c, { kind: 'clo', courseId: ids.c1!, code: 'CLO2', textEn: 'Design a heat exchanger' }))).id;
  await w.as('alo', (c) => setOutcomeLink(c, { fromId: ids.clo1!, toId: ids.so1!, level: 'M' }));
  await w.as('alo', (c) => setOutcomeLink(c, { fromId: ids.clo2!, toId: ids.so2!, level: 'R' }));
}, 120000);
afterAll(() => w.close());

describe('the QAIEO attainment method', () => {
  it('splits marks among CLOs, weighs them by the class average, and reports the design weight', () => {
    const a = computeAttainment([
      { totalMarks: 10, classAverage: 8, parts: [{ marks: 4, cloIds: ['a'] }, { marks: 6, cloIds: ['a', 'b'] }] },
      { totalMarks: 20, classAverage: 10, parts: [{ marks: 20, cloIds: ['b'] }] },
      { totalMarks: 10, classAverage: null, parts: [{ marks: 10, cloIds: ['a'] }] },
    ]);
    // a: possible 4+3 = 7, achieved 7*0.8 = 5.6 (80%); b: possible 3+20 = 23, achieved 2.4+10 = 12.4 (53.91%).
    expect(a.clos).toEqual([
      { cloId: 'a', possible: 7, achieved: 5.6, attainment: 80, weight: 23.33 },
      { cloId: 'b', possible: 23, achieved: 12.4, attainment: 53.91, weight: 76.67 },
    ]);
    expect(a.overall).toBe(60);
  });
});

describe('the plan (IE-001)', () => {
  it('has a row per PLO, says what is missing, and is fixed once endorsed', async () => {
    const plan = await w.as('coord', (c) => createPlan(c, w.ids.mech!, { academicYear: '2026-27' }));
    expect(plan.items.map((i) => i.ploId)).toEqual([ids.so1, ids.so2]);
    expect(plan.issues.filter((i) => i.ploId === ids.so1).map((i) => i.message)).toEqual([
      'SO1 has no direct measure in a course', 'SO1 has no indirect measure', 'SO1 has no target (set one here or the institution\'s PLO target)',
      'SO1 has no assessment term (each PLO is assessed directly at least every two years)',
    ]);
    await expect(w.as('coord', (c) => createPlan(c, w.ids.mech!, { academicYear: '2026-27' }))).rejects.toThrow(ConflictError);
    const item2 = plan.items[1]!;
    const after = await w.as('coord', (c) => savePlanItem(c, item2.id, { directCourseId: ids.c1, directMethod: 'Design project', indirectMethod: 'Exit survey', targetShare: 70, targetScore: 70, assessIn: 'Fall 2026' }));
    expect(after.issues.filter((i) => i.ploId === ids.so2).map((i) => i.message)).toEqual(['MCE 410 does not reach SO2 at the mastery level (M) on the curriculum map']);
    await expect(w.as('contrib', (c) => savePlanItem(c, item2.id, { directMethod: 'x' }))).rejects.toThrow(ForbiddenError);
    const sub = await w.as('coord', (c) => updatePlan(c, plan.id, { status: 'submitted', coordinator: 'Assessment coordinator' }));
    expect(sub.submittedOn).toBeTruthy();
    await w.as('coord', (c) => updatePlan(c, plan.id, { status: 'endorsed' }));
    await expect(w.as('coord', (c) => savePlanItem(c, item2.id, { directMethod: 'x' }))).rejects.toThrow(/endorsed plan is fixed/);
    const next = await w.as('coord', (c) => createPlan(c, w.ids.mech!, { academicYear: '2027-28', copyFrom: '2026-27' }));
    expect(next.items.find((i) => i.ploId === ids.so2)).toMatchObject({ directMethod: 'Design project', targetShare: 70 });
  });
});

describe('attainment, results and actions', () => {
  it('records course attainment as results, rolls CLOs up to PLOs, and judges them against the targets', async () => {
    await expect(w.as('alo', (c) => saveCourseAssessment(c, ids.c1!, { term: 'Spring 2026', name: 'Quiz 1', totalMarks: 10, classAverage: 8, parts: [{ label: 'Q1', marks: 5, cloIds: [ids.clo1!] }] })))
      .rejects.toThrow(/add up to 5/);
    await w.as('alo', (c) => saveCourseAssessment(c, ids.c1!, { term: 'Spring 2026', name: 'Quiz 1', totalMarks: 10, classAverage: 8, students: 17, parts: [{ label: 'Q1', marks: 4, cloIds: [ids.clo1!] }, { label: 'Q2', marks: 6, cloIds: [ids.clo1!, ids.clo2!] }] }));
    await w.as('alo', (c) => saveCourseAssessment(c, ids.c1!, { term: 'Spring 2026', name: 'Final', totalMarks: 20, classAverage: 10, students: 17, parts: [{ label: 'Design', marks: 20, cloIds: [ids.clo2!] }] }));
    const att = await w.as('contrib', (c) => getCourseAttainment(c, ids.c1!, 'Spring 2026'));
    expect(att.plos.map((p) => [p.code, p.attainment])).toEqual([['SO1', 80], ['SO2', 53.91]]);
    expect((await w.as('alo', (c) => recordCourseAttainment(c, ids.c1!, 'Spring 2026'))).recorded).toBe(4);
    expect((await w.as('alo', (c) => recordCourseAttainment(c, ids.c1!, 'Spring 2026'))).recorded).toBe(4); // replaces, not doubles

    await w.as('alo', (c) => setBenchmarks(c, { ploScore: 70, cloScore: 70, indirectScore: 4 }));
    let view = await w.as('coord', (c) => getProgramAssessment(c, w.ids.mech!));
    // Attainment gives a mean, not a share of students: it is judged on the score target (SO2: its plan's 70%; the others: the institution's).
    const attained = view.results.filter((r) => r.source === 'Course attainment (QAIEO method)');
    expect(attained.map((r) => [r.outcomeId === ids.so1 ? 'SO1' : r.outcomeId === ids.so2 ? 'SO2' : 'CLO', r.standing]).sort())
      .toEqual([['CLO', 'at_or_above'], ['CLO', 'below'], ['SO1', 'at_or_above'], ['SO2', 'below']]);
    const so2Attained = attained.find((r) => r.outcomeId === ids.so2)!;
    const r2 = await w.as('coord', (c) => addResult(c, { outcomeId: ids.so2!, courseId: ids.c1, term: 'Spring 2026', kind: 'direct', method: 'Design rubric', sampleSize: 17, studentsAtTarget: 9 }));
    await w.as('coord', (c) => addResult(c, { outcomeId: ids.so2!, term: 'Spring 2026', kind: 'indirect', method: 'Course survey', meanScore: 4.33, scaleMax: 5, responseRate: 71 }));
    await expect(w.as('coord', (c) => addResult(c, { outcomeId: ids.so2!, term: 'x', kind: 'direct', sampleSize: 3, studentsAtTarget: 4 }))).rejects.toThrow(ValidationError);
    view = await w.as('coord', (c) => getProgramAssessment(c, w.ids.mech!));
    expect(view.results.find((r) => r.id === r2.id)).toMatchObject({ standing: 'below', target: '70% of students at ≥ 70%' });
    expect(view.results.find((r) => r.kind === 'indirect')).toMatchObject({ standing: 'at_or_above' });
    expect(view.openGaps.map((g) => g.resultId).sort()).toEqual([r2.id, so2Attained.id].sort());

    const act = await w.as('coord', (c) => addAction(c, w.ids.mech!, { outcomeId: ids.so2, resultId: r2.id, gap: '52.9% of students at target vs 70%', action: 'Targeted design exercises', owner: 'Course coordinator', implementIn: 'Fall 2026', verificationPlan: 'Re-assess SO2 in Spring 2027' }));
    expect((await w.as('coord', (c) => getProgramAssessment(c, w.ids.mech!))).openGaps.map((g) => g.resultId)).toEqual([so2Attained.id]);
    await expect(w.as('coord', (c) => updateAction(c, act.id, { status: 'verified' }))).rejects.toThrow(/re-assessment result/);
    const r3 = await w.as('coord', (c) => addResult(c, { outcomeId: ids.so2!, term: 'Spring 2027', kind: 'direct', sampleSize: 20, studentsAtTarget: 16 }));
    expect(await w.as('coord', (c) => updateAction(c, act.id, { status: 'verified', verifiedResultId: r3.id }))).toMatchObject({ status: 'verified' });
  });

  it('imports results rows by outcome code, PLO or "course CLO", and lists what it cannot place', async () => {
    const rows = [
      { outcome: 'SO1', term: 'Fall 2026', kind: 'direct' as const, sampleSize: 20, studentsAtTarget: 15 },
      { outcome: 'MCE 410 CLO2', term: 'Fall 2026', kind: 'indirect' as const, meanScore: 4.1, scaleMax: 5 },
      { outcome: 'SO9', term: 'Fall 2026', kind: 'direct' as const },
    ];
    const preview = await w.as('coord', (c) => importResults(c, w.ids.mech!, rows, { apply: false, source: 'CAP sheet' }));
    expect(preview).toEqual({ added: 2, skipped: [{ row: 'SO9 Fall 2026', reason: 'no PLO of this program, or CLO of its courses, with that code' }] });
    await w.as('coord', (c) => importResults(c, w.ids.mech!, rows, { apply: true, source: 'CAP sheet' }));
    const view = await w.as('coord', (c) => getProgramAssessment(c, w.ids.mech!));
    expect(view.results.filter((r) => r.source === 'CAP sheet').map((r) => [r.term, r.outcomeId === ids.clo2 ? 'CLO2' : 'SO1', r.courseId === ids.c1]).sort())
      .toEqual([['Fall 2026', 'CLO2', true], ['Fall 2026', 'SO1', false]]);
  });
});

describe('the ILO rotation', () => {
  it('schedules ILOs by year and reports the linked PLOs and their latest results', async () => {
    const ilo1 = await w.as('admin', (c) => createOutcome(c, { kind: 'ilo', code: 'ILO1', textEn: 'Critical thinking' }));
    await w.as('admin', (c) => createOutcome(c, { kind: 'ilo', code: 'ILO2', textEn: 'Communication' }));
    await w.as('alo', (c) => setOutcomeLink(c, { fromId: ids.so1!, toId: ilo1.id }));
    await w.as('admin', (c) => saveIloSchedule(c, { iloId: ilo1.id, academicYear: '2026-27', mechanism: 'Embedded assessment in capstones' }));
    await expect(w.as('coord', (c) => saveIloSchedule(c, { iloId: ilo1.id, academicYear: '2027-28' }))).rejects.toThrow(ForbiddenError);
    const r = await w.as('alo', (c) => getIloReport(c));
    expect(r.ilos[0]).toMatchObject({ code: 'ILO1', years: ['2026-27'], programs: 1, atOrAbove: 1, below: 0, noResult: 0, plos: [{ code: 'SO1' }] });
    expect(r.issues).toEqual(['ILO2 is not linked from any program\'s PLO', 'ILO2 has no year in the rotation']);
  });
});
