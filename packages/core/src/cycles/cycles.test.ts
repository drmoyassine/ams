// Cycle services (TASK-078): templates, launching with rule resolution, input wiring (this cycle and the previous one), stage and
// output rules, approvals (only the named approver; "returned" reopens the producing stage), permissions, Undo, Trash and the
// tenant boundary.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import type { CreateCycleTemplate, CycleDetail, LaunchCycle, UndoDescriptor } from '@ams/shared';
import { LaunchCycleSchema } from '@ams/shared';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Ctx } from '../ctx.js';
import { MemoryStore } from '../evidence/memory-store.js';
import { restoreTrash } from '../trash/trash.js';
import {
  activateCycle, addInput, addOutput, addStage, cancelCycle, completeStage, createTemplate, decideApproval, deleteCycle, deleteInput, deleteOutput, deleteStage, deleteTemplate,
  finalizeOutput, getCycle, getMyWork, getTemplate, launchCycle, listCycles, listTemplates, publishTemplate, readOutputFile, reinstateTemplate, removeOutputFile, reopenOutput,
  reopenStage, resetStage, retireTemplate, reviseTemplate, revertCycleToDraft, setInputPick, setOutputNote, skipStage, startStage, toggleChecklist, updateCycle, updateOutput,
  updateStage, updateTemplate, uploadOutputFile, validateTemplate,
} from './index.js';

let db: TestDb;
let pool: pg.Pool;
const store = new MemoryStore();
const ids = {} as Record<string, string>;
let lastUndo: UndoDescriptor | null = null;
const as = <T>(who: string, fn: (ctx: Ctx) => Promise<T>, inst = 'inst') => {
  const caller = { userId: ids[who]!, institutionId: ids[inst]!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  lastUndo = null;
  return withIdentity(pool, caller, (tx) => fn({ tx, caller, store, queue: { send: async () => undefined }, afterCommit: () => undefined, undo: (d) => { lastUndo = d; } }));
};
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const launch = (who: string, v: Partial<LaunchCycle> & Pick<LaunchCycle, 'anchorKind' | 'anchorId'>) => as(who, (c) => launchCycle(c, LaunchCycleSchema.parse({ startDate: '2026-09-01', ...v })));
const stageOf = (c: CycleDetail, key: string) => c.stages.find((s) => s.key === key)!;
const outputOf = (c: CycleDetail, stage: string, key: string) => stageOf(c, stage).outputs.find((o) => o.key === key)!;

/** A small annual review: collect -> QA review (an approval) -> final. Every rule is data. */
const ANNUAL: CreateCycleTemplate = {
  key: 'annual_review', name: 'Annual review', nameAr: 'المراجعة السنوية', anchorKinds: ['org_unit', 'program'], origin: 'manual',
  stages: [
    {
      key: 'collect', name: 'Collect', process: 'Gather the figures.', checklist: ['Pull enrolment', 'Pull results'], unit: { kind: 'subject' }, owner: { kind: 'head_of_unit' },
      startOffsetDays: 0, lengthDays: 14,
      outputs: [{ key: 'summary', name: 'Summary', kind: 'note', required: true }, { key: 'data', name: 'Data file', kind: 'document', required: false }],
      inputs: [{ key: 'last_final', name: 'Last year final note', from: { previousCycle: { stage: 'final', output: 'final_note' } }, required: true }],
    },
    {
      key: 'review', name: 'QA review', process: 'Review the summary.', checklist: [], unit: { kind: 'unit_type', type: 'admin_unit' }, owner: { kind: 'role', role: 'lead' },
      startOffsetDays: 14, lengthDays: 7,
      outputs: [{ key: 'signoff', name: 'QA sign-off', kind: 'approval', required: true, approver: { kind: 'head_of_unit' } }],
      inputs: [{ key: 'summary', name: 'Summary', from: { stage: 'collect', output: 'summary' }, required: true }],
    },
    {
      key: 'final', name: 'Final', process: '', checklist: [], unit: { kind: 'cycle' }, owner: { kind: 'cycle_lead' }, startOffsetDays: 21, lengthDays: 9,
      outputs: [{ key: 'final_note', name: 'Final note', kind: 'note', required: true }, { key: 'report', name: 'Report', kind: 'report', required: false, reportTemplateKey: 'annual' }],
      inputs: [
        { key: 'signoff', name: 'QA sign-off', from: { stage: 'review', output: 'signoff' }, required: true },
        { key: 'evidence', name: 'Evidence', from: { pick: 'evidence' }, required: false },
      ],
    },
  ],
};

beforeAll(async () => {
  db = await createTestDb('cyclesvc');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('Other University') returning id`);
  for (const n of ['admin', 'lead', 'contributor', 'viewer', 'headDept', 'qaHead', 'ownerOnly', 'unitLead', 'stranger']) {
    ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  }
  ids.otherAdmin = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'otherAdmin', 'oa') returning id`, [ids.other]);
  const grant = (inst: string, u: string, role: string, scope: string, scopeId: string) =>
    db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids[inst], ids[u], role, scope, scopeId]);
  const unit = (type: string, name: string, parent: string | null = null, head: string | null = null) =>
    one(`insert into org_unit (institution_id, type, name_en, parent_id, head_user_id) values ($1, $2, $3, $4, $5) returning id`, [ids.inst, type, name, parent, head]);
  ids.uni = await unit('college', 'Uni');
  ids.dept = await unit('department', 'Dept', ids.uni, ids.headDept);
  ids.dept2 = await unit('department', 'Dept2', ids.uni);
  ids.qa = await unit('admin_unit', 'QA Office', ids.uni, ids.qaHead);
  ids.prog = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BSc X', 'bachelor') returning id`, [ids.inst, ids.dept]);
  await grant('inst', 'admin', 'admin', 'institution', ids.inst!);
  await grant('inst', 'lead', 'lead', 'institution', ids.inst!);
  await grant('inst', 'contributor', 'contributor', 'institution', ids.inst!);
  for (const v of ['viewer', 'headDept', 'qaHead', 'ownerOnly', 'stranger']) await grant('inst', v, 'viewer', 'institution', ids.inst!);
  await grant('inst', 'unitLead', 'lead', 'org_unit', ids.dept2!);
  await grant('other', 'otherAdmin', 'admin', 'institution', ids.other!);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('templates', () => {
  it('are drafts until published; publishing bumps the version; only managers write', async () => {
    const t = await as('lead', (c) => createTemplate(c, ANNUAL));
    ids.tpl = t.id;
    expect(t).toMatchObject({ status: 'draft', version: 0, key: 'annual_review', cycleCount: 0 });
    expect(lastUndo).toMatchObject({ method: 'DELETE', path: `/api/cycle-templates/${t.id}` });
    await expect(as('viewer', (c) => createTemplate(c, { ...ANNUAL, key: 'x' }))).rejects.toThrow(ForbiddenError);
    await expect(as('contributor', (c) => createTemplate(c, { ...ANNUAL, key: 'x' }))).rejects.toThrow(ForbiddenError);
    await expect(as('unitLead', (c) => createTemplate(c, { ...ANNUAL, key: 'x' }))).rejects.toThrow(ForbiddenError);   // institution-wide settings
    await expect(as('lead', (c) => createTemplate(c, ANNUAL))).rejects.toThrow(ConflictError);                              // key taken
    // A draft is not offered for launching.
    await expect(launch('lead', { templateId: t.id, anchorKind: 'org_unit', anchorId: ids.dept! })).rejects.toThrow(/only a published template/);
    const pub = await as('lead', (c) => publishTemplate(c, t.id));
    expect(pub).toMatchObject({ status: 'published', version: 1 });
    expect(lastUndo).toMatchObject({ method: 'POST', path: `/api/cycle-templates/${t.id}/revise` });
    await expect(as('lead', (c) => publishTemplate(c, t.id))).rejects.toThrow(/already published/);
    await expect(as('lead', (c) => updateTemplate(c, t.id, { name: 'x' }))).rejects.toThrow(/Revise it into a draft/);
    expect((await as('viewer', (c) => listTemplates(c, { status: 'published' }))).map((x) => x.key)).toEqual(['annual_review']);
    expect((await as('viewer', (c) => listTemplates(c, { anchorKind: 'requirement' }))).length).toBe(0);   // does not fit
  });

  it('revise -> edit -> publish makes version 2; retire and reinstate keep the version', async () => {
    await as('lead', (c) => reviseTemplate(c, ids.tpl!));
    const edited = await as('lead', (c) => updateTemplate(c, ids.tpl!, { description: 'Yearly' }));
    expect(edited).toMatchObject({ description: 'Yearly', status: 'draft' });
    expect(lastUndo).toMatchObject({ method: 'PATCH', body: { description: null } });
    expect(await as('lead', (c) => publishTemplate(c, ids.tpl!))).toMatchObject({ version: 2 });
    expect(await as('lead', (c) => retireTemplate(c, ids.tpl!))).toMatchObject({ status: 'retired', version: 2 });
    await expect(launch('lead', { templateId: ids.tpl!, anchorKind: 'org_unit', anchorId: ids.dept! })).rejects.toThrow(/retired/);
    expect(await as('lead', (c) => reinstateTemplate(c, ids.tpl!))).toMatchObject({ status: 'published', version: 2 });
  });

  it('are checked in full before publishing: unique keys, inputs read earlier outputs, the previous run or a pick, no loops', async () => {
    const stage = (key: string, extra: Record<string, unknown> = {}) => ({ key, name: key, outputs: [{ key: 'out', name: 'out', kind: 'note' }], ...extra });
    const check = async (stages: unknown[]) => (await as('viewer', (c) => validateTemplate(c, { stages }))).issues.map((i) => i.message);
    expect(await check([stage('a'), stage('a')])).toEqual([expect.stringContaining('used twice')]);
    expect(await check([stage('a'), stage('b', { inputs: [{ key: 'i', name: 'i', from: { stage: 'a', output: 'out' } }] })])).toEqual([]);
    expect(await check([stage('a'), stage('b', { inputs: [{ key: 'i', name: 'i', from: { stage: 'zzz', output: 'out' } }] })])).toEqual([expect.stringContaining('no stage "zzz"')]);
    expect(await check([stage('a'), stage('b', { inputs: [{ key: 'i', name: 'i', from: { stage: 'a', output: 'nope' } }] })])).toEqual([expect.stringContaining('no output "nope"')]);
    expect(await check([stage('a', { inputs: [{ key: 'i', name: 'i', from: { stage: 'b', output: 'out' } }] }), stage('b')])).toEqual([expect.stringContaining('comes later')]);
    expect((await check([
      stage('a', { inputs: [{ key: 'i', name: 'i', from: { stage: 'b', output: 'out' } }] }), stage('b', { inputs: [{ key: 'j', name: 'j', from: { stage: 'a', output: 'out' } }] }),
    ]))[0]).toMatch(/loop: a -> b -> a/);
    expect(await check([stage('a', { inputs: [{ key: 'i', name: 'i', from: { stage: 'a', output: 'out' } }] })])).toEqual([expect.stringContaining('own output')]);
    expect(await check([stage('a', { inputs: [{ key: 'i', name: 'i', from: { previousCycle: { stage: 'a', output: 'out' } } }, { key: 'k', name: 'k', from: { pick: 'document' } }] })])).toEqual([]);
    expect(await check([stage('a', { inputs: [{ key: 'i', name: 'i', from: { previousCycle: { stage: 'a', output: 'nope' } } }] })])).toEqual([expect.stringContaining('no output "nope"')]);
    expect(await check([{ key: 'a', name: 'a', outputs: [{ key: 'o', name: 'o', kind: 'note', approver: { kind: 'head_of_unit' } }] }])).toEqual([expect.stringContaining('only an approval has an approver')]);
    expect((await as('viewer', (c) => validateTemplate(c, { stages: [{ key: 'Bad Key', name: 'x' }] }))).ok).toBe(false);

    const bad = await as('lead', (c) => createTemplate(c, { key: 'broken', name: 'Broken', anchorKinds: [], origin: 'manual', stages: [stage('a', { inputs: [{ key: 'i', name: 'i', from: { stage: 'b', output: 'out' } }] }), stage('b')] as never }));
    await expect(as('lead', (c) => publishTemplate(c, bad.id))).rejects.toThrow(/comes later/);
    await expect(as('lead', (c) => publishTemplate(c, (async () => (await as('lead', (cc) => createTemplate(cc, { key: 'empty', name: 'Empty', anchorKinds: [], origin: 'manual', stages: [] }))).id)() as never))).rejects.toThrow();
    // A never-published draft can be deleted (and Undo creates it again); a published one cannot.
    await as('lead', (c) => deleteTemplate(c, bad.id));
    expect(lastUndo).toMatchObject({ method: 'POST', path: '/api/cycle-templates', body: { key: 'broken' } });
    await expect(as('lead', (c) => deleteTemplate(c, ids.tpl!))).rejects.toThrow(/never been published|never published/);
  });

  it('keep names in NFC (Arabic included)', async () => {
    const decomposed = 'Café';
    const t = await as('lead', (c) => createTemplate(c, { key: 'nfc', name: decomposed, nameAr: 'مراجعة ', anchorKinds: [], origin: 'manual', stages: [{ key: 'a', name: 'Café stage', process: '', checklist: [], unit: { kind: 'cycle' }, owner: { kind: 'cycle_lead' }, startOffsetDays: 0, lengthDays: 1, outputs: [], inputs: [] }] }));
    expect(t.name).toBe('Café');
    expect(t.nameAr).toBe('مراجعة');
    expect(t.stages[0]!.name).toBe('Café stage');
    await as('lead', (c) => deleteTemplate(c, t.id));
  });
});

describe('launching', () => {
  it('resolves unit, owner and approver per stage from the rules, sets dates from offsets and wires the inputs', async () => {
    const c = await launch('lead', { templateId: ids.tpl!, anchorKind: 'program', anchorId: ids.prog!, periodLabel: 'AY2026-27', leadUserId: ids.lead! });
    ids.c1 = c.id;
    expect(c).toMatchObject({ status: 'draft', templateVersion: 2, templateName: 'Annual review', anchorName: 'BSc X', responsibleUnitId: ids.dept, responsibleUnitName: 'Dept', leadName: 'lead', periodLabel: 'AY2026-27', stageCount: 3, unresolvedCount: 0 });
    expect(c.title).toBe('Annual review · BSc X · AY2026-27');
    expect(lastUndo).toMatchObject({ method: 'DELETE', path: `/api/cycles/${c.id}` });
    // Collect: the subject's unit (the program's department), owned by that unit's head.
    expect(stageOf(c, 'collect')).toMatchObject({ responsibleUnitId: ids.dept, ownerUserId: ids.headDept, ownerName: 'headDept', ownerUnresolved: false, unitUnresolved: false, startDate: '2026-09-01', endDate: '2026-09-15', status: 'not_started' });
    expect(stageOf(c, 'collect').checklist).toEqual([{ text: 'Pull enrolment', done: false, doneBy: null, doneAt: null }, { text: 'Pull results', done: false, doneBy: null, doneAt: null }]);
    // Review: the one unit of type admin_unit (QA office), owned by the one person with the role `lead`; the approver is the QA head.
    expect(stageOf(c, 'review')).toMatchObject({ responsibleUnitId: ids.qa, ownerUserId: ids.lead, startDate: '2026-09-15', endDate: '2026-09-22' });
    expect(outputOf(c, 'review', 'signoff')).toMatchObject({ approverUserId: ids.qaHead, approverName: 'qaHead', approverUnresolved: false, kind: 'approval', state: 'missing' });
    // Final: the cycle's unit and lead.
    expect(stageOf(c, 'final')).toMatchObject({ responsibleUnitId: ids.dept, ownerUserId: ids.lead, endDate: '2026-10-01' });
    expect(c.endDate).toBe('2026-10-01');
    expect(outputOf(c, 'final', 'report')).toMatchObject({ kind: 'report', reportPending: true, reportId: null, reportTemplateKey: 'annual' });
    // Inputs: an earlier stage's output, no previous cycle yet (shown as missing), and a pick.
    expect(stageOf(c, 'review').inputs[0]).toMatchObject({ source: 'stage_output', outputName: 'Summary', outputStageName: 'Collect', outputCycleId: c.id, satisfied: false });
    expect(stageOf(c, 'collect').inputs[0]).toMatchObject({ source: 'previous_cycle', outputId: null, previousMissing: true, satisfied: false });
    expect(stageOf(c, 'final').inputs.find((i) => i.key === 'evidence')).toMatchObject({ source: 'pick', pickKind: 'evidence', satisfied: false, outputId: null });
  });

  it('never guesses: a rule that finds nobody, or several, leaves the field empty and flagged', async () => {
    // Dept2 has no head: the collect owner is unresolved; the approver is still the QA head.
    const c = await launch('admin', { templateId: ids.tpl!, anchorKind: 'org_unit', anchorId: ids.dept2! });
    expect(stageOf(c, 'collect')).toMatchObject({ responsibleUnitId: ids.dept2, ownerUserId: null, ownerUnresolved: true });
    expect(c.unresolvedCount).toBe(1);
    // A second QA office makes "the unit of type admin_unit" ambiguous (not near the subject): the stage takes the cycle's unit, flagged.
    const qa2 = await one(`insert into org_unit (institution_id, type, name_en, parent_id) values ($1, 'admin_unit', 'QA Two', $2) returning id`, [ids.inst, ids.uni]);
    const d = await launch('admin', { templateId: ids.tpl!, anchorKind: 'org_unit', anchorId: ids.dept2! });
    expect(stageOf(d, 'review')).toMatchObject({ unitUnresolved: true, responsibleUnitId: ids.dept2, ownerUserId: null, ownerUnresolved: true });
    expect(outputOf(d, 'review', 'signoff')).toMatchObject({ approverUserId: null, approverUnresolved: true });
    expect(d.unresolvedCount).toBeGreaterThanOrEqual(3);
    // Two people with the role `lead` at the same level are ambiguous too.
    await db.su.query(`delete from org_unit where id = $1`, [qa2]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'lead', 'institution', $1)`, [ids.inst, ids.stranger]);
    const e = await launch('admin', { templateId: ids.tpl!, anchorKind: 'org_unit', anchorId: ids.dept2! });
    expect(stageOf(e, 'review')).toMatchObject({ unitUnresolved: false, ownerUserId: null, ownerUnresolved: true });
    await db.su.query(`delete from role_assignment where user_id = $1 and role = 'lead'`, [ids.stranger]);
    for (const x of [c, d, e]) await as('admin', (cc) => deleteCycle(cc, { id: x.id }));
  });

  it('needs a responsible unit, a fitting template and a real anchor of this institution', async () => {
    await expect(launch('admin', { templateId: ids.tpl!, anchorKind: 'requirement', anchorId: crypto.randomUUID() })).rejects.toThrow(/does not fit/);
    await expect(launch('admin', { anchorKind: 'org_unit', anchorId: crypto.randomUUID() })).rejects.toThrow(ValidationError);
    await expect(launch('admin', { anchorKind: 'program', anchorId: ids.dept! })).rejects.toThrow(/program not found/);
    await expect(launch('admin', { anchorKind: 'institution', anchorId: ids.other! })).rejects.toThrow(ValidationError);
    // An institution anchor has no unit of its own: say which unit is responsible.
    await expect(launch('admin', { anchorKind: 'institution', anchorId: ids.inst! })).rejects.toThrow(/Choose the unit responsible/);
    const ok = await launch('admin', { anchorKind: 'institution', anchorId: ids.inst!, responsibleUnitId: ids.uni!, title: 'Institutional review' });
    expect(ok).toMatchObject({ title: 'Institutional review', templateId: null, templateVersion: null, stageCount: 0, anchorName: 'Gulf University', responsibleUnitId: ids.uni });
    await expect(launch('admin', { anchorKind: 'org_unit', anchorId: ids.dept!, subjectKind: 'program', subjectId: crypto.randomUUID() })).rejects.toThrow(/program not found/);
    await expect(launch('admin', { anchorKind: 'org_unit', anchorId: ids.dept!, leadUserId: ids.otherAdmin! })).rejects.toThrow(ValidationError);
    await as('admin', (c) => deleteCycle(c, { id: ok.id }));
  });

  it('is for people who manage cycles where the cycle is: a viewer, a contributor and a lead of another unit cannot', async () => {
    for (const who of ['viewer', 'contributor', 'unitLead']) {
      await expect(launch(who, { templateId: ids.tpl!, anchorKind: 'org_unit', anchorId: ids.dept! }), who).rejects.toThrow(ForbiddenError);
    }
    // The lead of Dept2 manages cycles in Dept2 (the grant covers the unit).
    const mine = await launch('unitLead', { templateId: ids.tpl!, anchorKind: 'org_unit', anchorId: ids.dept2!, leadUserId: ids.unitLead! });
    expect(mine.canManage).toBe(true);
    expect((await as('lead', (c) => getCycle(c, mine.id))).canManage).toBe(true);
    await as('unitLead', (c) => deleteCycle(c, { id: mine.id }));
  });

  it('blank cycles are built by hand while they are drafts, and only then', async () => {
    const b = await launch('lead', { anchorKind: 'org_unit', anchorId: ids.dept! });
    expect(b.title).toBe('New cycle · Dept'.replace('New cycle · ', '') === 'Dept' ? 'Dept' : b.title);
    await expect(as('lead', (c) => activateCycle(c, b.id))).rejects.toThrow(/at least one stage/);
    const s1 = (await as('lead', (c) => addStage(c, b.id, { name: 'Gather', process: 'Do it', checklist: ['one'] }))).stages[0]!;
    expect(lastUndo).toMatchObject({ method: 'DELETE', path: `/api/cycle-stages/${s1.id}` });
    expect(s1).toMatchObject({ key: 'gather', responsibleUnitId: ids.dept, ownerUserId: null, ownerUnresolved: true, displayOrder: 0 });
    const withOut = await as('lead', (c) => addOutput(c, s1.id, { name: 'Findings', kind: 'note', required: true }));
    const out = withOut.stages[0]!.outputs[0]!;
    const s2 = (await as('lead', (c) => addStage(c, b.id, { name: 'Sign', ownerUserId: ids.ownerOnly! }))).stages[1]!;
    await expect(as('lead', (c) => addInput(c, s2.id, { name: 'Findings', fromOutputId: out.id, required: true }))).resolves.toBeTruthy();
    // An input reads only an earlier stage; an approval has the approver of its kind only.
    await expect(as('lead', (c) => addInput(c, s1.id, { name: 'Back', fromOutputId: out.id, required: true }))).rejects.toThrow(/earlier stage/);
    await expect(as('lead', (c) => addInput(c, s2.id, { name: 'Two', fromOutputId: out.id, pick: 'any', required: true }))).rejects.toThrow(/exactly one/);
    await expect(as('lead', (c) => addOutput(c, s2.id, { name: 'N', kind: 'note', required: true, approverUserId: ids.qaHead! }))).rejects.toThrow(/only an approval/);
    // Removing what is read is refused, naming the reader.
    await expect(as('lead', (c) => deleteStage(c, s1.id))).rejects.toThrow(/Another stage reads this/);
    await expect(as('lead', (c) => deleteOutput(c, out.id))).rejects.toThrow(/reads this/);
    const inputId = (await as('lead', (c) => getCycle(c, b.id))).stages[1]!.inputs[0]!.id;
    await as('lead', (c) => deleteInput(c, inputId));
    await as('lead', (c) => deleteStage(c, s2.id));
    expect((await as('lead', (c) => getCycle(c, b.id))).stages.map((s) => s.displayOrder)).toEqual([0]);
    await as('lead', (c) => activateCycle(c, b.id));
    await expect(as('lead', (c) => addStage(c, b.id, { name: 'Late' }))).rejects.toThrow(/only while the cycle is a draft/);
    await expect(as('lead', (c) => deleteStage(c, s1.id))).rejects.toThrow(/only while the cycle is a draft/);
    await as('lead', (c) => cancelCycle(c, b.id, { reason: 'test over' }));
  });
});

describe('running a cycle', () => {
  let c1: CycleDetail;
  const refresh = async () => { c1 = await as('lead', (c) => getCycle(c, ids.c1!)); return c1; };

  it('cannot work stages of a draft; launching starts it; going back to draft Undo-s the launch', async () => {
    await refresh();
    await expect(as('headDept', (c) => startStage(c, stageOf(c1, 'collect').id))).rejects.toThrow(/Launch the cycle/);
    const a = await as('lead', (c) => activateCycle(c, ids.c1!));
    expect(a.status).toBe('active');
    expect(lastUndo).toMatchObject({ method: 'POST', path: `/api/cycles/${ids.c1}/revert-to-draft` });
    expect((await as('lead', (c) => revertCycleToDraft(c, ids.c1!))).status).toBe('draft');
    expect(lastUndo).toMatchObject({ method: 'POST', path: `/api/cycles/${ids.c1}/activate` });
    await as('lead', (c) => activateCycle(c, ids.c1!));
    await expect(as('viewer', (c) => activateCycle(c, ids.c1!))).rejects.toThrow(ForbiddenError);
  });

  it('lets a stage owner work their stage whatever their role, and nobody else without cycle:work', async () => {
    await refresh();
    const collect = stageOf(c1, 'collect');
    expect(collect.canWork).toBe(true);                                               // the lead manages the cycle
    expect(stageOf(await as('stranger', (c) => getCycle(c, ids.c1!)), 'collect').canWork).toBe(false);
    expect(stageOf(await as('headDept', (c) => getCycle(c, ids.c1!)), 'collect').canWork).toBe(true);   // its owner
    // headDept is a plain viewer who owns the stage.
    await expect(as('stranger', (c) => startStage(c, collect.id))).rejects.toThrow(ForbiddenError);
    await expect(as('viewer', (c) => startStage(c, collect.id))).rejects.toThrow(ForbiddenError);
    const started = await as('headDept', (c) => startStage(c, collect.id));
    expect(stageOf(started, 'collect')).toMatchObject({ status: 'in_progress', canWork: true });
    expect(lastUndo).toMatchObject({ method: 'POST', path: `/api/cycle-stages/${collect.id}/reset` });
    const undo = lastUndo!;
    await expect(as('headDept', (c) => startStage(c, collect.id))).rejects.toThrow(/only a stage that has not started/);
    // The undo of starting puts it back, and the redo starts it again.
    expect(stageOf(await as('headDept', (c) => resetStage(c, collect.id)), 'collect').status).toBe('not_started');
    expect(undo.path).toBe(`/api/cycle-stages/${collect.id}/reset`);
    await as('headDept', (c) => startStage(c, collect.id));
    // The viewer sees but cannot fill; a contributor (cycle:work) can fill any stage of the institution.
    await expect(as('viewer', (c) => setOutputNote(c, outputOf(started, 'collect', 'summary').id, { note: 'x' }))).rejects.toThrow(ForbiddenError);
    await as('contributor', (c) => setOutputNote(c, outputOf(started, 'collect', 'summary').id, { note: 'Draft summary' }));
  });

  it('fills outputs: a note, a document (stored, served back, replaceable), a report slot that is only a stub', async () => {
    await refresh();
    const summary = outputOf(c1, 'collect', 'summary');
    expect(summary).toMatchObject({ kind: 'note', note: 'Draft summary', state: 'draft' });
    expect(lastUndo).toBeNull();
    const w = await as('headDept', (c) => setOutputNote(c, summary.id, { note: 'Enrolment is up 4%.' }));
    expect(outputOf(w, 'collect', 'summary').note).toBe('Enrolment is up 4%.');
    expect(lastUndo).toMatchObject({ method: 'PUT', path: `/api/cycle-outputs/${summary.id}/note`, body: { note: 'Draft summary' } });
    // Finalizing needs the content; completing needs the required outputs final, and says which.
    await expect(as('headDept', (c) => completeStage(c, stageOf(c1, 'collect').id))).rejects.toThrow(/These required outputs are not final: Summary/);
    const data = outputOf(c1, 'collect', 'data');
    await expect(as('headDept', (c) => finalizeOutput(c, data.id))).rejects.toThrow(/Upload the file/);
    await expect(as('headDept', (c) => setOutputNote(c, data.id, { note: 'x' }))).rejects.toThrow(/not a note/);
    const bytes = new TextEncoder().encode('year,students\n2026,1200\n');
    const up = await as('headDept', (c) => uploadOutputFile(c, data.id, { fileName: 'تقرير/data.csv', mime: 'text/csv', bytes }));
    expect(outputOf(up, 'collect', 'data')).toMatchObject({ state: 'draft', file: { name: 'تقرير_data.csv', mime: 'text/csv', size: bytes.byteLength } });
    expect(lastUndo).toMatchObject({ method: 'DELETE', path: `/api/cycle-outputs/${data.id}/file` });
    const back = await as('viewer', (c) => readOutputFile(c, data.id));
    expect(new TextDecoder().decode(back.bytes)).toBe('year,students\n2026,1200\n');
    expect(back).toMatchObject({ mime: 'text/csv', fileName: 'تقرير_data.csv' });
    const keys = [...store.objects.keys()].filter((k) => k.startsWith(`${ids.inst}/cycles/`));
    expect(keys.length).toBe(1);
    await as('headDept', (c) => removeOutputFile(c, data.id));
    expect((await as('viewer', (c) => getCycle(c, ids.c1!))).stages[0]!.outputs.find((o) => o.key === 'data')).toMatchObject({ state: 'missing', file: null });
    await expect(as('headDept', (c) => uploadOutputFile(c, data.id, { fileName: 'e.csv', mime: 'text/csv', bytes: new Uint8Array() }))).rejects.toThrow(/empty/);
    await as('headDept', (c) => finalizeOutput(c, summary.id));
    expect(lastUndo).toMatchObject({ method: 'POST', path: `/api/cycle-outputs/${summary.id}/reopen` });
    await expect(as('headDept', (c) => setOutputNote(c, summary.id, { note: 'changed' }))).rejects.toThrow(/Reopen it/);
    // Work on the toggles and the checklist.
    const ticked = await as('headDept', (c) => toggleChecklist(c, stageOf(c1, 'collect').id, { index: 0, done: true }));
    expect(stageOf(ticked, 'collect').checklist[0]).toMatchObject({ done: true, doneBy: ids.headDept });
    expect(lastUndo).toMatchObject({ body: { index: 0, done: false } });
    await expect(as('headDept', (c) => toggleChecklist(c, stageOf(c1, 'collect').id, { index: 9, done: true }))).rejects.toThrow(NotFoundError);
    const done = await as('headDept', (c) => completeStage(c, stageOf(c1, 'collect').id));
    expect(stageOf(done, 'collect')).toMatchObject({ status: 'completed', canWork: false });
    expect(stageOf(done, 'collect').completedAt).not.toBeNull();
    expect(stageOf(done, 'review').inputs[0]).toMatchObject({ satisfied: true, outputState: 'final' });
  });

  it('runs an approval: only the named approver decides; conditions and a return need a comment; a return reopens the producing stage', async () => {
    await refresh();
    const review = stageOf(c1, 'review');
    const sign = outputOf(c1, 'review', 'signoff');
    await as('lead', (c) => startStage(c, review.id));                               // the stage owner is the `lead` role holder
    // Not an admin, not the stage owner, not the cycle lead: only the named approver.
    for (const who of ['admin', 'lead', 'contributor', 'headDept']) {
      await expect(as(who, (c) => decideApproval(c, sign.id, { decision: 'approved' })), who).rejects.toThrow(/Only the named approver/);
    }
    await expect(as('qaHead', (c) => decideApproval(c, sign.id, { decision: 'returned' }))).rejects.toThrow(/comment is required/);
    await expect(as('qaHead', (c) => decideApproval(c, sign.id, { decision: 'approved_with_conditions', comment: '   ' }))).rejects.toThrow(/comment is required/);
    expect(stageOf(await as('qaHead', (c) => getCycle(c, ids.c1!)), 'review').outputs[0]!.canDecide).toBe(true);
    // A return sends the work back: the stage that made the summary is open again and its output is a draft.
    const returned = await as('qaHead', (c) => decideApproval(c, sign.id, { decision: 'returned', comment: 'Add the pass rates.' }));
    expect(outputOf(returned, 'review', 'signoff')).toMatchObject({ decision: 'returned', decisionLabel: 'Returned for changes', decisionComment: 'Add the pass rates.', state: 'draft' });
    expect(stageOf(returned, 'collect')).toMatchObject({ status: 'in_progress', completedAt: null });
    expect(outputOf(returned, 'collect', 'summary').state).toBe('draft');
    expect(stageOf(returned, 'review').status).toBe('in_progress');
    expect(stageOf(returned, 'review').inputs[0]).toMatchObject({ satisfied: false });
    // The producer fixes it and completes again; the approver decides again.
    await as('headDept', (c) => setOutputNote(c, outputOf(returned, 'collect', 'summary').id, { note: 'Enrolment up 4%; pass rate 91%.' }));
    await as('headDept', (c) => finalizeOutput(c, outputOf(returned, 'collect', 'summary').id));
    await as('headDept', (c) => completeStage(c, stageOf(returned, 'collect').id));
    const approved = await as('qaHead', (c) => decideApproval(c, sign.id, { decision: 'approved_with_conditions', comment: 'Re-check the dropout figure.' }));
    expect(outputOf(approved, 'review', 'signoff')).toMatchObject({ decision: 'approved_with_conditions', decisionLabel: 'Internally approved with conditions', state: 'final', finalisedBy: ids.qaHead, finalisedByName: 'qaHead', canDecide: false });
    await expect(as('qaHead', (c) => decideApproval(c, sign.id, { decision: 'approved' }))).rejects.toThrow(/has been decided/);
    await expect(as('qaHead', (c) => reopenOutput(c, sign.id))).rejects.toThrow(/not reopened/);
    // The output's wording never says met or compliant.
    expect(JSON.stringify(approved)).not.toMatch(/\bcompliant\b|\bmet\b/i);
    const done = await as('lead', (c) => completeStage(c, stageOf(approved, 'review').id));
    expect(stageOf(done, 'review').status).toBe('completed');
    expect(stageOf(done, 'final').inputs.find((i) => i.key === 'signoff')).toMatchObject({ satisfied: true });
  });

  it('reads a pick from evidence, the cycle completes with its last stage, and reopening a stage runs it again', async () => {
    await refresh();
    const evId = await one(`insert into evidence_item (institution_id, title, type) values ($1, 'Enrolment table', 'document') returning id`, [ids.inst]);
    const final = stageOf(c1, 'final');
    await as('lead', (c) => startStage(c, final.id));
    const evInput = final.inputs.find((i) => i.key === 'evidence')!;
    await expect(as('lead', (c) => setInputPick(c, evInput.id, { refKind: 'document', refId: evId }))).rejects.toThrow(/takes an evidence item/);
    await expect(as('lead', (c) => setInputPick(c, evInput.id, { refKind: 'evidence_item', refId: crypto.randomUUID() }))).rejects.toThrow(/not found/);
    const picked = await as('lead', (c) => setInputPick(c, evInput.id, { refKind: 'evidence_item', refId: evId }));
    expect(stageOf(picked, 'final').inputs.find((i) => i.key === 'evidence')).toMatchObject({ satisfied: true, refKind: 'evidence_item', refName: 'Enrolment table' });
    expect(lastUndo).toMatchObject({ method: 'PUT', body: { refKind: null, refId: null } });
    const note = outputOf(picked, 'final', 'final_note');
    await as('lead', (c) => setOutputNote(c, note.id, { note: 'Reviewed and filed.' }));
    await as('lead', (c) => finalizeOutput(c, note.id));
    // An optional report slot does not hold the stage back; it is a stub until the report engine exists.
    const report = outputOf(picked, 'final', 'report');
    await expect(as('lead', (c) => setOutputNote(c, report.id, { note: 'x' }))).rejects.toThrow(/not a note/);
    const finished = await as('lead', (c) => completeStage(c, final.id));
    expect(finished.status).toBe('completed');
    expect(finished.stagesDone).toBe(3);
    // Reopen: the cycle runs again, and a stage cannot change while the cycle is over.
    const reopened = await as('lead', (c) => reopenStage(c, final.id));
    expect(reopened.status).toBe('active');
    expect(stageOf(reopened, 'final').status).toBe('in_progress');
    expect(lastUndo).toMatchObject({ method: 'POST', path: `/api/cycle-stages/${final.id}/complete` });
    expect((await as('lead', (c) => completeStage(c, final.id))).status).toBe('completed');
    await expect(as('lead', (c) => skipStage(c, final.id, { reason: 'x' }))).rejects.toThrow(/cycle is completed/);
  });

  it('keeps the previous run for the next one: its final output feeds the new cycle\'s input', async () => {
    const next = await launch('lead', { templateId: ids.tpl!, anchorKind: 'program', anchorId: ids.prog!, periodLabel: 'AY2027-28', startDate: '2027-09-01' });
    ids.c2 = next.id;
    expect(next.previousCycleId).toBe(ids.c1);
    const input = stageOf(next, 'collect').inputs[0]!;
    expect(input).toMatchObject({ source: 'previous_cycle', outputCycleId: ids.c1, outputName: 'Final note', outputStageName: 'Final', outputState: 'final', satisfied: true, previousMissing: false });
    // A different subject does not pick it up.
    const other = await launch('lead', { templateId: ids.tpl!, anchorKind: 'org_unit', anchorId: ids.dept2! });
    expect(other.previousCycleId).toBeNull();
    // A cycle another builds on cannot be deleted or taken back to draft.
    await expect(as('lead', (c) => deleteCycle(c, { id: ids.c1! }))).rejects.toThrow(/only a draft can be deleted|A completed cycle/i);
    await as('lead', (c) => deleteCycle(c, { id: other.id }));
  });

  it('skips a stage with a reason, reopens it, and can cancel a started cycle with a reason (a draft is deleted, not cancelled)', async () => {
    const d = await launch('lead', { templateId: ids.tpl!, anchorKind: 'org_unit', anchorId: ids.dept2!, leadUserId: ids.lead! });
    await expect(as('lead', (c) => cancelCycle(c, d.id, { reason: 'no' }))).rejects.toThrow(/deleted, not cancelled/);
    await as('lead', (c) => activateCycle(c, d.id));
    const s = stageOf(d, 'collect');
    await expect(as('lead', (c) => skipStage(c, s.id, { reason: '   ' }))).rejects.toThrow(/reason/);
    const skipped = await as('lead', (c) => skipStage(c, s.id, { reason: 'Not applicable this year' }));
    expect(stageOf(skipped, 'collect')).toMatchObject({ status: 'skipped', skipReason: 'Not applicable this year' });
    expect(lastUndo).toMatchObject({ path: `/api/cycle-stages/${s.id}/reopen` });
    const back = await as('lead', (c) => reopenStage(c, s.id));
    expect(stageOf(back, 'collect')).toMatchObject({ status: 'not_started', skipReason: null });
    expect(lastUndo).toMatchObject({ path: `/api/cycle-stages/${s.id}/skip`, body: { reason: 'Not applicable this year' } });
    await expect(as('viewer', (c) => cancelCycle(c, d.id, { reason: 'x' }))).rejects.toThrow(ForbiddenError);
    const cancelled = await as('lead', (c) => cancelCycle(c, d.id, { reason: 'Replaced by a periodic review' }));
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Replaced by a periodic review' });
    expect(lastUndo).toBeNull();
    await expect(as('lead', (c) => startStage(c, s.id))).rejects.toThrow(/cancelled/);
    await expect(as('lead', (c) => deleteCycle(c, { id: d.id }))).rejects.toThrow(/cancelled cycle is not deleted/);
  });
});

describe('editing, listing and my work', () => {
  it('edits owners, units and dates (managers) with an Undo; a moved start moves a draft\'s stages', async () => {
    const c = await as('lead', (cc) => getCycle(cc, ids.c2!));
    const collect = stageOf(c, 'collect');
    const edited = await as('lead', (cc) => updateStage(cc, collect.id, { ownerUserId: ids.ownerOnly!, endDate: '2027-09-20' }));
    expect(stageOf(edited, 'collect')).toMatchObject({ ownerUserId: ids.ownerOnly, ownerUnresolved: false, endDate: '2027-09-20' });
    expect(lastUndo).toMatchObject({ method: 'PATCH', body: { ownerUserId: ids.headDept, endDate: '2027-09-15' } });
    await expect(as('contributor', (cc) => updateStage(cc, collect.id, { ownerUserId: ids.viewer! }))).rejects.toThrow(ForbiddenError);
    await expect(as('lead', (cc) => updateStage(cc, collect.id, { startDate: '2027-10-30' }))).rejects.toThrow(ConflictError);   // after its end date
    const shifted = await as('lead', (cc) => updateCycle(cc, ids.c2!, { startDate: '2027-09-08' }));
    expect(shifted).toMatchObject({ startDate: '2027-09-08', endDate: '2027-10-08' });
    expect(stageOf(shifted, 'collect')).toMatchObject({ startDate: '2027-09-08' });
    expect(lastUndo).toMatchObject({ body: { startDate: '2027-09-01', endDate: '2027-10-01' } });
    const undoBody = lastUndo!.body as never;
    await as('lead', (cc) => updateCycle(cc, ids.c2!, undoBody));
    expect(stageOf(await as('lead', (cc) => getCycle(cc, ids.c2!)), 'collect').startDate).toBe('2027-09-01');
    const approval = outputOf(edited, 'review', 'signoff');
    const swapped = await as('lead', (cc) => updateOutput(cc, approval.id, { approverUserId: ids.headDept! }));
    expect(outputOf(swapped, 'review', 'signoff').approverUserId).toBe(ids.headDept);
    expect(lastUndo).toMatchObject({ body: { approverUserId: ids.qaHead } });
  });

  it('lists with filters (anchor, subject, unit, status, owner, template) and names what it points at', async () => {
    const all = await as('viewer', (c) => listCycles(c));
    expect(all.length).toBeGreaterThanOrEqual(2);
    const byAnchor = await as('viewer', (c) => listCycles(c, { anchorKind: 'program', anchorId: ids.prog! }));
    expect(byAnchor.map((x) => x.periodLabel).sort()).toEqual(['AY2026-27', 'AY2027-28']);
    expect(byAnchor[0]).toMatchObject({ anchorName: 'BSc X', responsibleUnitName: 'Dept', templateName: 'Annual review' });
    expect((await as('viewer', (c) => listCycles(c, { status: 'completed' }))).map((x) => x.id)).toEqual([ids.c1]);
    expect((await as('viewer', (c) => listCycles(c, { ownerId: ids.ownerOnly! }))).map((x) => x.id)).toEqual([ids.c2]);
    expect((await as('viewer', (c) => listCycles(c, { unitId: ids.qa! }))).length).toBeGreaterThanOrEqual(2);
    expect((await as('viewer', (c) => listCycles(c, { templateId: ids.tpl!, q: 'ay2027' }))).map((x) => x.id)).toEqual([ids.c2]);
    expect(await as('viewer', (c) => listCycles(c, { subjectKind: 'org_unit' }))).toEqual([]);
    await expect(as('otherAdmin', (c) => getCycle(c, ids.c1!), 'other')).rejects.toThrow(NotFoundError);
    expect(await as('otherAdmin', (c) => listCycles(c), 'other')).toEqual([]);
    expect(await as('otherAdmin', (c) => listTemplates(c), 'other')).toEqual([]);
    await expect(as('otherAdmin', (c) => getTemplate(c, ids.tpl!), 'other')).rejects.toThrow(NotFoundError);
  });

  it('shows my stages and the approvals waiting for me', async () => {
    await as('lead', (c) => activateCycle(c, ids.c2!));
    const c2 = await as('lead', (c) => getCycle(c, ids.c2!));
    const mine = await as('ownerOnly', (c) => getMyWork(c));
    expect(mine.stages).toEqual([expect.objectContaining({ cycleId: ids.c2, stageName: 'Collect', status: 'not_started', missingOutputs: 1, missingInputs: 0, late: false })]);
    // Past its end date and not finished: late.
    const lateOne = await as('lead', (c) => updateStage(c, stageOf(c2, 'collect').id, { startDate: '2026-01-01', endDate: '2026-01-31' }));
    expect(stageOf(lateOne, 'collect').late).toBe(true);
    expect((await as('ownerOnly', (c) => getMyWork(c))).stages[0]).toMatchObject({ late: true, endDate: '2026-01-31' });
    expect(mine.approvals).toEqual([]);
    // The stage owner starts; the QA stage starts; the named approver then sees the approval waiting.
    await as('ownerOnly', (c) => startStage(c, stageOf(c2, 'collect').id));
    await as('lead', (c) => startStage(c, stageOf(c2, 'review').id));
    const waiting = await as('headDept', (c) => getMyWork(c));   // the approver was swapped to headDept above
    expect(waiting.approvals).toEqual([{ cycleId: ids.c2, cycleTitle: c2.title, stageId: stageOf(c2, 'review').id, stageName: 'QA review', outputId: outputOf(c2, 'review', 'signoff').id, outputName: 'QA sign-off', returnedBefore: false }]);
    expect((await as('stranger', (c) => getMyWork(c))).stages).toEqual([]);
  });
});

describe('the Trash', () => {
  it('deletes a draft with its stages, outputs and inputs, and restores it whole with the same ids', async () => {
    const d = await launch('lead', { templateId: ids.tpl!, anchorKind: 'org_unit', anchorId: ids.dept2!, periodLabel: 'trash me' });
    const del = await as('lead', (c) => deleteCycle(c, { id: d.id }));
    expect(del).toMatchObject({ counts: { items: 1, stages: 3 }, items: 1 });
    expect(lastUndo).toMatchObject({ method: 'POST', path: `/api/trash/groups/${del.groupId}/restore` });
    await expect(as('lead', (c) => getCycle(c, d.id))).rejects.toThrow(NotFoundError);
    const { rows } = await db.su.query(`select kind, label, counts from trash_item where group_id = $1`, [del.groupId]);
    expect(rows[0]).toMatchObject({ kind: 'cycle', counts: { items: 1, stages: 3, outputs: 5, inputs: 4 } });
    expect((await db.su.query(`select count(*)::int n from cycle_stage where cycle_id = $1`, [d.id])).rows[0].n).toBe(0);
    await expect(as('viewer', (c) => restoreTrash(c, { groupId: del.groupId }))).rejects.toThrow();
    const back = await as('lead', (c) => restoreTrash(c, { groupId: del.groupId }));
    expect(back.restored).toMatchObject({ cycles: 1, stages: 3, outputs: 5, inputs: 4 });
    expect(lastUndo).toMatchObject({ method: 'DELETE', path: `/api/cycles/${d.id}` });
    const again = await as('lead', (c) => getCycle(c, d.id));
    expect(again.stages.map((s) => s.id)).toEqual(d.stages.map((s) => s.id));
    expect(again.stages.flatMap((s) => s.inputs).map((i) => i.outputId)).toEqual(d.stages.flatMap((s) => s.inputs).map((i) => i.outputId));
    await as('lead', (c) => deleteCycle(c, { id: d.id }));
  });

  it('refuses to delete a cycle that has started, and a restore whose unit is gone says so', async () => {
    await expect(as('lead', (c) => deleteCycle(c, { id: ids.c2! }))).rejects.toThrow(/cancel it instead/);
    const unit = await one(`insert into org_unit (institution_id, type, name_en, parent_id) values ($1, 'department', 'Temp', $2) returning id`, [ids.inst, ids.uni]);
    const d = await launch('lead', { anchorKind: 'org_unit', anchorId: unit });
    const del = await as('lead', (c) => deleteCycle(c, { id: d.id }));
    await db.su.query(`delete from org_unit where id = $1`, [unit]);
    await expect(as('lead', (c) => restoreTrash(c, { groupId: del.groupId }))).rejects.toThrow(/unit this cycle names no longer exists/);
  });

  it('keeps a unit that cycles are responsible-for from being deleted', async () => {
    const { deleteOrgUnits } = await import('../org/unit-trash.js');
    const b = await launch('admin', { anchorKind: 'org_unit', anchorId: ids.dept2!, title: 'Blank in Dept2' });
    await expect(as('admin', (c) => deleteOrgUnits(c, { ids: [ids.dept2!] }))).rejects.toThrow(/Cannot delete Dept2: \d cycles? (is|are) the responsibility of it.*Blank in Dept2/);
    await as('admin', (c) => deleteCycle(c, { id: b.id }));
  });
});

describe('audit', () => {
  it('records who did what to a cycle', async () => {
    const { rows } = await db.su.query(`select action, actor_id from audit_event where target_type = 'cycle_output' and target_id = $1 order by created_at`, [(await as('lead', (c) => getCycle(c, ids.c1!))).stages[1]!.outputs[0]!.id]);
    expect(rows.map((r) => r.action)).toContain('update');
    expect(rows.some((r) => r.actor_id === ids.qaHead)).toBe(true);
  });
});
