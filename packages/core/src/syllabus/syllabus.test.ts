// The syllabus services (TASK-123): who may do what in the workflow, rules that flag but never block an upsert, errors that stop a
// submission, approval writing the course's CLOs, tightened settings flagging an approved syllabus, and the escalation up the line.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SYLLABUS_SETTINGS, DEFAULT_SYLLABUS_TEMPLATE, emptySyllabus, emptyWorkbook, type SyllabusContent } from '@ams/shared';
import { importSyllabi } from './import.js';
import { ConflictError, ForbiddenError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createCourse, setCourseProgram } from '../outcomes/courses.js';
import { createOutcome } from '../outcomes/outcomes.js';
import {
  approveSyllabus, setCourseStaff, setSyllabusTemplate, getSyllabusTemplate, discardDraft, endorseSyllabus, escalateFlags, getSyllabusOverview, getSyllabusSettings, levelReached, listSyllabi, resolveSuggestion, returnSyllabus,
  saveSyllabusDraft, setSyllabusSettings, submitSyllabus, suggestChange, upsertSyllabus,
} from './syllabus.js';

let w: World;
const ids: Record<string, string> = {};
const note = async (user: string) => (await w.db.su.query(`select title, body from notification where user_id = $1 and kind = 'syllabus_flagged' order by created_at`, [w.ids[user]])).rows as { title: string; body: string }[];

/** A complete syllabus for the course: 4 CLOs over two PLOs, assessments adding to 100, one rubric. */
function complete(): SyllabusContent {
  const c = emptySyllabus();
  c.info = { titleEn: 'Heat Transfer', titleAr: '', credits: 3, languageOfDelivery: 'english', contactLecture: 3, contactLab: 0, contactOther: 0, courseType: 'didactic', courseLevel: '400', category: 'program_core', sustainability: 'none', prerequisiteIds: [], corequisiteIds: [] };
  c.description.en = 'Conduction, convection and radiation.'; c.methodology = 'Lectures and problem sessions.';
  c.materials = [{ kind: 'textbook', citation: 'Incropera, Fundamentals of Heat and Mass Transfer', isbn: '', year: null }];
  c.clos = ['a', 'b', 'c', 'd'].map((id, k) => ({ id, code: `CLO${k + 1}`, textEn: `Outcome ${k + 1}`, textAr: '', bloom: 'apply', ploId: k < 2 ? ids.plo1! : ids.plo2!, level: k < 3 ? 'R' : 'M' }));
  c.rubrics = [{ id: 'r', title: 'Problem solving', levels: [{ name: 'Proficient', min: 70, max: 100 }, { name: 'Developing', min: 0, max: 69 }], criteria: [{ name: 'Method', descriptions: ['Sound', 'Partly sound'] }] }];
  c.assessments = [
    { id: 'q', name: 'Quizzes', category: 'quiz', objective: '', weight: 50, dueWeek: 6, clos: [{ cloId: 'a', share: 50, rubricId: 'r' }, { cloId: 'b', share: 50, rubricId: 'r' }] },
    { id: 'f', name: 'Final exam', category: 'final', objective: '', weight: 50, dueWeek: 15, clos: [{ cloId: 'c', share: 50, rubricId: 'r' }, { cloId: 'd', share: 50, rubricId: 'r' }] },
  ];
  return c;
}

beforeAll(async () => {
  w = await buildWorld('syllabus');
  const p = w.ids.mech!;
  ids.course = (await w.as('alo', (c) => createCourse(c, { code: 'MCE 410', titleEn: 'Heat Transfer' }))).id;
  await w.as('alo', (c) => setCourseProgram(c, ids.course!, p, { role: 'core', year: 4 }));
  ids.plo1 = (await w.as('alo', (c) => createOutcome(c, { kind: 'plo', programId: p, code: 'PLO1', textEn: 'Solve problems' }))).id;
  ids.plo2 = (await w.as('alo', (c) => createOutcome(c, { kind: 'plo', programId: p, code: 'PLO2', textEn: 'Design systems' }))).id;
  // The course coordinator is `second` and an instructor is `outsider` (each only a viewer), the Dean is a lead of the unit, the chair is `coord` (lead of the program).
  ids.dean = (await w.db.su.query(`insert into app_user (institution_id, full_name, email) values ($1, 'dean', 'dean@x.org') returning id`, [w.ids.inst])).rows[0].id;
  const unit = (await w.db.su.query(`select org_unit_id from program where id = $1`, [p])).rows[0].org_unit_id;
  await w.db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'lead', 'org_unit', $3)`, [w.ids.inst, ids.dean, unit]);
  for (const u of ['second', 'outsider']) await w.db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'viewer', 'institution', $1)`, [w.ids.inst, w.ids[u]]);
  await w.db.su.query(`update course set coordinator_user_id = $1, org_unit_id = $2 where id = $3`, [w.ids.second, unit, ids.course]);
  await w.db.su.query(`insert into course_instructor (institution_id, course_id, user_id) values ($1, $2, $3)`, [w.ids.inst, ids.course, w.ids.outsider]);
}, 120000);
afterAll(() => w.close());
const withDean = async (fn: Parameters<World['as']>[1]) => {
  const { withIdentity } = await import('@ams/db');
  const caller = { userId: ids.dean!, institutionId: w.ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  return withIdentity(w.pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined, store: w.store }));
};

describe('the course staff', () => {
  it('lets a writer name the coordinator and instructors, and refuses a stranger or someone who is not a person of the institution', async () => {
    await expect(w.as('contrib', (c) => setCourseStaff(c, ids.course!, { coordinatorUserId: w.ids.second!, instructorIds: [] }))).rejects.toThrow(ForbiddenError);
    await expect(w.as('alo', (c) => setCourseStaff(c, ids.course!, { coordinatorUserId: crypto.randomUUID(), instructorIds: [] }))).rejects.toThrow();
    const done = await w.as('alo', (c) => setCourseStaff(c, ids.course!, { coordinatorUserId: w.ids.second!, instructorIds: [w.ids.outsider!, w.ids.outsider!] }));
    expect(done).toEqual({ coordinatorUserId: w.ids.second, instructorIds: [w.ids.outsider] });
    const ov = await w.as('second', (c) => getSyllabusOverview(c, ids.course!));
    expect(ov.course).toMatchObject({ coordinatorName: 'second', instructors: [{ id: w.ids.outsider, name: 'outsider' }] });
  });
});

describe('the template', () => {
  it('is changed by an admin only; an optional field changes what is an error; a required section cannot be removed', async () => {
    const t = DEFAULT_SYLLABUS_TEMPLATE;
    await expect(w.as('second', (c) => setSyllabusTemplate(c, t))).rejects.toThrow(ForbiddenError);
    await expect(w.as('alo', (c) => setSyllabusTemplate(c, { ...t, sections: t.sections.filter((x) => x.key !== 'rubrics') }))).rejects.toThrow(ValidationError);
    expect((await w.as('second', (c) => getSyllabusTemplate(c))).optional).toEqual(['info.titleAr']);
    const added = await w.as('alo', (c) => setSyllabusTemplate(c, { optional: ['methodology', 'info.titleAr'], sections: [...t.sections, { key: 'custom:policies-1a2b', title: 'Policy links', help: 'Links to the policies', locked: false }] }));
    expect(added.sections.at(-1)?.title).toBe('Policy links');
    const ov = await w.as('second', (c) => getSyllabusOverview(c, ids.course!));
    expect(ov.template.sections.at(-1)?.key).toBe('custom:policies-1a2b');
    // With the methodology optional, an empty one is no longer an error.
    const content = { ...complete(), methodology: '' };
    const saved = await w.as('second', (c) => saveSyllabusDraft(c, ids.course!, { content }));
    expect(saved.issues.map((x) => x.code)).not.toContain('methodology.missing');
    await w.as('second', (c) => discardDraft(c, ids.course!));
    await w.as('alo', (c) => setSyllabusTemplate(c, t));
  });
});

describe('settings', () => {
  it('start at the defaults, are changed by an admin only, and refuse a minimum above a maximum', async () => {
    expect(await w.as('second', (c) => getSyllabusSettings(c))).toEqual(DEFAULT_SYLLABUS_SETTINGS);
    await expect(w.as('second', (c) => setSyllabusSettings(c, { ...DEFAULT_SYLLABUS_SETTINGS, maxClos: 6 }))).rejects.toThrow(ForbiddenError);
    await expect(w.as('alo', (c) => setSyllabusSettings(c, { ...DEFAULT_SYLLABUS_SETTINGS, minClos: 9 }))).rejects.toThrow();
  });
});

describe('an import or an upsert never stops at a rule', () => {
  it('loads an empty syllabus by course code as a draft, flags its errors and tells the coordinator at once', async () => {
    const v = await w.as('second', (c) => upsertSyllabus(c, { courseCode: 'MCE 410', content: emptySyllabus(), source: 'import' }));
    expect(v).toMatchObject({ versionNo: 1, status: 'draft', source: 'import' });
    expect(v.errorCount).toBeGreaterThan(5);
    expect(v.flaggedSince).toEqual(expect.any(String));
    const notes = await note('second');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('MCE 410 syllabus needs attention');
    expect(await note('coord')).toHaveLength(0); // the chair hears later, if it is not fixed
  });

  it('allows only the coordinator or a course writer to edit it, and an instructor only to suggest', async () => {
    await expect(w.as('outsider', (c) => saveSyllabusDraft(c, ids.course!, { content: complete() }))).rejects.toThrow(ForbiddenError);
    await expect(w.as('contrib', (c) => saveSyllabusDraft(c, ids.course!, { content: complete() }))).rejects.toThrow(ForbiddenError);
    const ov = await w.as('outsider', (c) => getSyllabusOverview(c, ids.course!));
    expect(ov.can).toEqual({ edit: false, suggest: true, endorse: false, approve: false });
    expect((await w.as('second', (c) => getSyllabusOverview(c, ids.course!))).can).toMatchObject({ edit: true });
    await expect(w.as('second', (c) => upsertSyllabus(c, { courseCode: 'NOPE 1', content: emptySyllabus() }))).rejects.toThrow();
  });
});

describe('the workflow', () => {
  it('refuses to submit a draft with errors, and accepts it once fixed; warnings do not stop it', async () => {
    const draft = (await w.as('second', (c) => getSyllabusOverview(c, ids.course!))).open!;
    await expect(w.as('second', (c) => submitSyllabus(c, draft.id))).rejects.toThrow(ValidationError);
    const fixed = await w.as('second', (c) => saveSyllabusDraft(c, ids.course!, { content: complete() }));
    expect(fixed).toMatchObject({ errorCount: 0, flaggedSince: null, versionNo: 1 });
    const sent = await w.as('second', (c) => submitSyllabus(c, fixed.id));
    expect(sent.status).toBe('in_review');
    await expect(w.as('second', (c) => saveSyllabusDraft(c, ids.course!, { content: complete() }))).rejects.toThrow(ConflictError);
  });

  it('lets an instructor suggest and the coordinator accept or decline, and tells the coordinator', async () => {
    const open = (await w.as('second', (c) => getSyllabusOverview(c, ids.course!))).open!;
    const s = await w.as('outsider', (c) => suggestChange(c, open.id, { section: 'clos', suggestion: 'Reword CLO 3 with a measurable verb' }));
    expect(s).toMatchObject({ status: 'open', byName: 'outsider' });
    expect((await note('second')).some((n) => n.title.startsWith('Suggestion on the MCE 410'))).toBe(true);
    await expect(w.as('outsider', (c) => resolveSuggestion(c, s.id, { decision: 'accepted' }))).rejects.toThrow(ForbiddenError);
    expect(await w.as('second', (c) => resolveSuggestion(c, s.id, { decision: 'declined', note: 'Fine as it is' }))).toEqual({ id: s.id, status: 'declined' });
    await expect(w.as('second', (c) => resolveSuggestion(c, s.id, { decision: 'accepted' }))).rejects.toThrow(ConflictError);
  });

  it('is endorsed by the chair, returned with a note on request, and approved only by the Dean', async () => {
    const open = (await w.as('second', (c) => getSyllabusOverview(c, ids.course!))).open!;
    await expect(w.as('second', (c) => endorseSyllabus(c, open.id))).rejects.toThrow(ForbiddenError);
    const back = await w.as('coord', (c) => returnSyllabus(c, open.id, 'CLO 4 needs a rubric descriptor'));
    expect(back).toMatchObject({ status: 'draft', returnedNote: 'CLO 4 needs a rubric descriptor' });
    await w.as('second', (c) => submitSyllabus(c, open.id));
    expect((await w.as('coord', (c) => endorseSyllabus(c, open.id))).status).toBe('endorsed');
    await expect(w.as('coord', (c) => approveSyllabus(c, open.id))).rejects.toThrow(ForbiddenError); // a chair does not approve
    const done = await withDean((c) => approveSyllabus(c, open.id, { effectiveFrom: 'Fall 2026' }));
    expect(done).toMatchObject({ status: 'approved', effectiveFrom: 'Fall 2026', approvedByName: 'dean', endorsedByName: 'coord' });
  });

  it('writes the course on approval: facts, CLOs, and each CLO linked to one PLO at its coverage level', async () => {
    const course = (await w.db.su.query(`select title_en, contact_lecture, course_type, level_band, category, language_of_instruction from course where id = $1`, [ids.course])).rows[0];
    expect(course).toMatchObject({ course_type: 'didactic', level_band: '400', category: 'program_core', language_of_instruction: 'English' });
    const rows = (await w.db.su.query(`select o.code, o.status, l.level, p.code as plo from learning_outcome o join outcome_link l on l.from_id = o.id join learning_outcome p on p.id = l.to_id where o.course_id = $1 and o.kind = 'clo' order by o.code`, [ids.course])).rows;
    expect(rows).toEqual([{ code: 'CLO1', status: 'approved', level: 'R', plo: 'PLO1' }, { code: 'CLO2', status: 'approved', level: 'R', plo: 'PLO1' }, { code: 'CLO3', status: 'approved', level: 'R', plo: 'PLO2' }, { code: 'CLO4', status: 'approved', level: 'M', plo: 'PLO2' }]);
    await expect(w.db.su.query(`update syllabus_version set content = '{}' where course_id = $1 and status = 'approved'`, [ids.course])).rejects.toThrow(/cannot be changed/);
  });

  it('makes a new version from the approved one, and approving it supersedes the old and retires a CLO it drops', async () => {
    const approved = (await w.as('second', (c) => getSyllabusOverview(c, ids.course!))).current!;
    const next = complete();
    next.clos = next.clos.slice(0, 3); // drop CLO4 (and what assessed it)
    next.assessments[1]!.clos = [{ cloId: 'c', share: 100, rubricId: 'r' }];
    const v2 = await w.as('second', (c) => saveSyllabusDraft(c, ids.course!, { content: { ...next, info: { ...next.info, credits: 4, contactLecture: 4 } } }));
    expect(v2.versionNo).toBe(2);
    await w.as('second', (c) => submitSyllabus(c, v2.id));
    await w.as('coord', (c) => endorseSyllabus(c, v2.id));
    await withDean((c) => approveSyllabus(c, v2.id));
    const ov = await w.as('second', (c) => getSyllabusOverview(c, ids.course!));
    expect(ov.current?.versionNo).toBe(2);
    expect(ov.history.map((h) => [h.versionNo, h.status])).toEqual([[2, 'approved'], [1, 'superseded']]);
    expect(approved.versionNo).toBe(1);
    const clos = (await w.db.su.query(`select code, status from learning_outcome where course_id = $1 and kind = 'clo' order by code`, [ids.course])).rows;
    expect(clos).toEqual([{ code: 'CLO1', status: 'approved' }, { code: 'CLO2', status: 'approved' }, { code: 'CLO3', status: 'approved' }, { code: 'CLO4', status: 'retired' }]);
    expect(Number((await w.db.su.query(`select credits from course where id = $1`, [ids.course])).rows[0].credits)).toBe(4);
  });

  it('discards a draft but never an approved version', async () => {
    const v = await w.as('second', (c) => saveSyllabusDraft(c, ids.course!, { content: complete() }));
    expect(await w.as('second', (c) => discardDraft(c, ids.course!))).toEqual({ deleted: true });
    expect(v.status).toBe('draft');
    expect((await w.as('second', (c) => getSyllabusOverview(c, ids.course!))).current?.versionNo).toBe(2);
  });
});

describe('tightening a limit flags the syllabi that now break it', () => {
  it('flags the approved syllabus without touching it, and tells the coordinator', async () => {
    const before = (await w.db.su.query(`select content from syllabus_version where course_id = $1 and status = 'approved'`, [ids.course])).rows[0].content;
    await w.as('alo', (c) => setSyllabusSettings(c, { ...DEFAULT_SYLLABUS_SETTINGS, minClos: 5 }));
    const flagged = (await w.as('second', (c) => listSyllabi(c, { flagged: true })));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ code: 'MCE 410', errorCount: 1, needsMyAttention: true });
    expect((await w.db.su.query(`select content from syllabus_version where course_id = $1 and status = 'approved'`, [ids.course])).rows[0].content).toEqual(before);
    expect((await note('second')).filter((n) => n.title === 'MCE 410 syllabus needs attention').length).toBeGreaterThanOrEqual(2);
  });

  it('goes up the line as the days pass: the chair, then the Dean, then the VPAA, each told once', async () => {
    expect((await w.as('coord', (c) => listSyllabi(c, { mine: true })))).toHaveLength(0); // day 0: only the coordinator
    await w.db.su.query(`update syllabus_version set flagged_since = now() - interval '4 days' where course_id = $1 and status = 'approved'`, [ids.course]);
    expect((await w.as('coord', (c) => escalateFlags(c))).notified).toBeGreaterThan(0);
    expect((await w.as('coord', (c) => listSyllabi(c, { mine: true }))).map((r) => r.code)).toEqual(['MCE 410']);
    expect((await note('coord')).length).toBe(1);
    expect((await w.as('alo', (c) => listSyllabi(c, { mine: true })))).toHaveLength(0); // the VPAA is not reached yet
    await w.db.su.query(`update syllabus_version set flagged_since = now() - interval '20 days' where course_id = $1 and status = 'approved'`, [ids.course]);
    await w.as('coord', (c) => escalateFlags(c));
    expect((await w.as('alo', (c) => listSyllabi(c, { mine: true }))).map((r) => r.code)).toEqual(['MCE 410']);
    expect((await note('alo')).length).toBeGreaterThan(0);
    expect((await w.as('coord', (c) => escalateFlags(c))).notified).toBe(0); // once per level
    expect(levelReached(new Date(Date.now() - 20 * 86_400_000), DEFAULT_SYLLABUS_SETTINGS)).toBe(3);
  });

  it('clears the flag when the syllabus is fixed or the limit relaxed', async () => {
    await w.as('alo', (c) => setSyllabusSettings(c, DEFAULT_SYLLABUS_SETTINGS));
    expect(await w.as('second', (c) => listSyllabi(c, { flagged: true }))).toEqual([]);
    expect((await w.db.su.query(`select flagged_since, escalation_level from syllabus_version where status = 'approved'`)).rows[0]).toEqual({ flagged_since: null, escalation_level: 0 });
  });
});

describe('the Excel import', () => {
  it('loads each course as a draft, flags what breaks a rule without refusing it, skips an unknown course, and replaces a draft', async () => {
    const wb = emptyWorkbook();
    wb.courses.push({ 'Course code': 'MCE 410', 'Title (English)': 'Heat Transfer', 'Credit hours': 3 }, { 'Course code': 'NOPE 999', 'Title (English)': 'Ghost' });
    wb.clos.push({ 'Course code': 'MCE 410', CLO: 'CLO1', 'Outcome (English)': 'Analyse conduction', 'Bloom level': 'Analyze', PLO: 'PLO1', Coverage: 'Introduced' });
    const r = await w.as('second', (c) => importSyllabi(c, wb));
    expect(r.results.map((x) => [x.courseCode, x.status])).toEqual([['MCE 410', 'loaded'], ['NOPE 999', 'unknown_course']]);
    expect(r.results[0]!.errors).toBeGreaterThan(3);
    expect(r).toMatchObject({ loaded: 1, flagged: 1 });
    const open = (await w.as('second', (c) => getSyllabusOverview(c, ids.course!))).open!;
    expect(open.content.clos[0]).toMatchObject({ code: 'CLO1', ploId: ids.plo1, level: 'I', bloom: 'analyze' });
    expect(open.source).toBe('excel import');
    // Importing again replaces the draft (the version number stays).
    const again = await w.as('second', (c) => importSyllabi(c, wb));
    expect(again.results[0]).toMatchObject({ status: 'loaded', versionNo: open.versionNo });
  });

  it('skips a course the importer may not edit, and one already in review, and loads the rest', async () => {
    const wb = emptyWorkbook();
    wb.courses.push({ 'Course code': 'MCE 410', 'Title (English)': 'Heat Transfer' });
    expect((await w.as('contrib', (c) => importSyllabi(c, wb))).results[0]).toMatchObject({ status: 'not_allowed' });
    // Put it in review: a complete draft, submitted.
    const done = await w.as('second', (c) => saveSyllabusDraft(c, ids.course!, { content: complete() }));
    await w.as('second', (c) => submitSyllabus(c, done.id));
    expect((await w.as('second', (c) => importSyllabi(c, wb))).results[0]).toMatchObject({ status: 'in_review' });
    await w.as('coord', (c) => returnSyllabus(c, done.id, 'back'));
    await w.as('second', (c) => discardDraft(c, ids.course!));
  });
});
