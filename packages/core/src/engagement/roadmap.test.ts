// Roadmap editing within the guardrails of PRD 8.5, key-date recomputation and manual phase advance.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../ctx.js';
import { addMember, getEngagement } from './engagements.js';
import { addLocalMilestone, advancePhase, deleteMilestone, reorderMilestones, updateEngagement, updateMilestone, withdrawEngagement } from './roadmap.js';
import { addDays } from './dates.js';
import { buildWorld, type World } from './test-support.js';

let w: World;
let eng: string; // ABET initial 2027, led by coord
let wsc: string; // WSCUC reaffirmation 2028, led by alo

const detail = (who: string, id: string) => w.as(who, (ctx) => getEngagement(ctx, id));
const ms = async (who: string, id: string) => (await detail(who, id)).milestones;
const key = async (id: string, templateKey: string) => (await ms('admin', id)).find((m) => m.templateKey === templateKey)!;

beforeAll(async () => {
  w = await buildWorld('roadmap');
  eng = (await w.create('coord', { subjectType: 'program', subjectId: w.ids.mech!, kind: 'initial' })).engagement.id;
  wsc = (await w.create('alo', { frameworkVersionId: w.ids.wscuc!, subjectType: 'institution', subjectId: w.ids.inst!, kind: 'reaffirmation', reviewYear: 2028, leadUserId: w.ids.alo! })).engagement.id;
  await w.as('coord', (ctx) => addMember(ctx, eng, { userId: w.ids.second!, role: 'co_lead' }));
  await w.as('coord', (ctx) => addMember(ctx, eng, { userId: w.ids.contrib!, role: 'contributor' }));
}, 60000);
afterAll(() => w.close());

describe('editing a milestone', () => {
  it('marks a renamed, re-dated or reassigned template milestone as modified', async () => {
    const m = await key(eng, 'pay_invoice');
    expect(m.origin).toBe('template');
    const out = await w.as('coord', (ctx) => updateMilestone(ctx, m.id, { name: 'Pay ABET invoice', dueDate: '2027-06-10', ownerId: w.ids.second!, description: 'Finance office' }));
    expect(out).toMatchObject({ name: 'Pay ABET invoice', dueDate: '2027-06-10', ownerId: w.ids.second, origin: 'modified', dateNeeded: false });
  });

  it('lets a co-lead edit but not a contributor', async () => {
    const m = await key(eng, 'review_team_conflicts');
    await w.as('second', (ctx) => updateMilestone(ctx, m.id, { description: 'Checked by the co-lead' }));
    await expect(w.as('contrib', (ctx) => updateMilestone(ctx, m.id, { name: 'x' }))).rejects.toThrow(ForbiddenError);
    await expect(w.as('outsider', (ctx) => updateMilestone(ctx, m.id, { name: 'x' }))).rejects.toThrow();
  });

  it('does not change the origin for a status change alone', async () => {
    const m = await key(eng, 'confirm_graduate');
    const out = await w.as('coord', (ctx) => updateMilestone(ctx, m.id, { status: 'in_progress' }));
    expect(out).toMatchObject({ status: 'in_progress', origin: 'template' });
  });

  it('sets and clears the completion time', async () => {
    const m = await key(eng, 'confirm_graduate');
    const done = await w.as('coord', (ctx) => updateMilestone(ctx, m.id, { status: 'done' }));
    expect(done.status).toBe('done');
    expect(done.completedAt).not.toBeNull();
    const back = await w.as('coord', (ctx) => updateMilestone(ctx, m.id, { status: 'in_progress' }));
    expect(back.completedAt).toBeNull();
  });
});

describe('skipping', () => {
  it('needs a reason for a required milestone, and un-skipping is always allowed', async () => {
    const m = await key(eng, 'rrev_fee');
    await expect(w.as('coord', (ctx) => updateMilestone(ctx, m.id, { status: 'skipped' }))).rejects.toThrow(/with a reason/);
    await expect(w.as('coord', (ctx) => updateMilestone(ctx, m.id, { status: 'skipped', skipReason: '   ' }))).rejects.toThrow(/with a reason/);
    const skipped = await w.as('coord', (ctx) => updateMilestone(ctx, m.id, { status: 'skipped', skipReason: 'Fee waived by ABET' }));
    expect(skipped).toMatchObject({ status: 'skipped', skipReason: 'Fee waived by ABET' });
    const un = await w.as('coord', (ctx) => updateMilestone(ctx, m.id, { status: 'not_started' }));
    expect(un).toMatchObject({ status: 'not_started', skipReason: null });
  });

  it('skips an optional (local) milestone without a reason', async () => {
    const local = await w.as('coord', (ctx) => addLocalMilestone(ctx, eng, { phase: 'self_study', name: 'Mock visit', type: 'task', required: false }));
    const out = await w.as('coord', (ctx) => updateMilestone(ctx, local.id, { status: 'skipped' }));
    expect(out.status).toBe('skipped');
  });
});

describe('locked and template milestones', () => {
  it('never deletes a locked milestone, and skips rather than deletes template milestones', async () => {
    const locked = await key(eng, 'ssr_submit');
    expect(locked.locked).toBe(true);
    await expect(w.as('coord', (ctx) => deleteMilestone(ctx, locked.id))).rejects.toThrow(/locked and cannot be deleted/);
    const tpl = await key(eng, 'pay_invoice');
    await expect(w.as('coord', (ctx) => deleteMilestone(ctx, tpl.id))).rejects.toThrow(/skip it instead/);
  });

  it('keeps template milestones in their phase and on their report template', async () => {
    const m = await key(eng, 'ssr_draft');
    await expect(w.as('coord', (ctx) => updateMilestone(ctx, m.id, { phase: 'review' }))).rejects.toThrow(/only milestones you added/);
    const submit = await key(eng, 'ssr_submit');
    await expect(w.as('coord', (ctx) => updateMilestone(ctx, submit.id, { deliverableTemplateKey: 'readiness' }))).rejects.toThrow(/cannot be changed/);
  });
});

describe('local milestones', () => {
  it('adds, moves between phases, reorders and deletes', async () => {
    const a = await w.as('coord', (ctx) => addLocalMilestone(ctx, eng, { phase: 'self_study', name: 'Steering committee', type: 'task', dueDate: '2027-02-01' }));
    const b = await w.as('coord', (ctx) => addLocalMilestone(ctx, eng, { phase: 'self_study', name: 'Board approval', type: 'task' }));
    expect(a).toMatchObject({ origin: 'local', locked: false, required: false, templateKey: null, phase: 'self_study' });
    expect(b.displayOrder).toBe(a.displayOrder + 1);

    const moved = await w.as('coord', (ctx) => updateMilestone(ctx, a.id, { phase: 'review' }));
    expect(moved.phase).toBe('review');

    const phase = (await ms('coord', eng)).filter((m) => m.phase === 'self_study').sort((x, y) => x.displayOrder - y.displayOrder).map((m) => m.id);
    const reversed = [...phase].reverse();
    const out = await w.as('coord', (ctx) => reorderMilestones(ctx, eng, { phase: 'self_study', milestoneIds: reversed }));
    expect(out.map((m) => m.id)).toEqual(reversed);
    await expect(w.as('coord', (ctx) => reorderMilestones(ctx, eng, { phase: 'self_study', milestoneIds: phase.slice(1) }))).rejects.toThrow(/exactly the milestones/);
    await expect(w.as('coord', (ctx) => reorderMilestones(ctx, eng, { phase: 'self_study', milestoneIds: [...phase.slice(1), phase[1]!] }))).rejects.toThrow(/exactly the milestones/);

    await w.as('coord', (ctx) => deleteMilestone(ctx, a.id));
    expect((await ms('coord', eng)).some((m) => m.id === a.id)).toBe(false);
  });

  it('cannot add a phase an engagement of this kind does not have', async () => {
    await expect(w.as('alo', (ctx) => addLocalMilestone(ctx, wsc, { phase: 'eligibility', name: 'x', type: 'task' }))).rejects.toThrow(/phases cannot be added/);
  });

  it('attaches a known report template to a local deliverable, and refuses an unknown one', async () => {
    const m = await w.as('coord', (ctx) => addLocalMilestone(ctx, eng, { phase: 'review', name: 'Extra report', type: 'deliverable', deliverableTemplateKey: 'interim' }));
    expect(m.deliverable).toEqual({ report_template_key: 'interim' });
    await expect(w.as('coord', (ctx) => addLocalMilestone(ctx, eng, { phase: 'review', name: 'x', type: 'deliverable', deliverableTemplateKey: 'nope' }))).rejects.toThrow(/no report template/);
    await expect(w.as('coord', (ctx) => addLocalMilestone(ctx, eng, { phase: 'review', name: 'x', type: 'task', deliverableTemplateKey: 'interim' }))).rejects.toThrow(/only a deliverable or submission/);
  });
});

describe('dates follow key dates and completions', () => {
  it('resolves a date that waited for a key date, and re-resolves template dates when the review year changes', async () => {
    expect(await key(eng, 'on_site_visit')).toMatchObject({ dueDate: null, dateNeeded: true });
    const { datesChanged } = await w.as('coord', (ctx) => updateEngagement(ctx, eng, { keyDates: { visit_date: '2027-10-18' } }));
    expect(datesChanged).toBe(1);
    expect(await key(eng, 'on_site_visit')).toMatchObject({ dueDate: '2027-10-18', dateNeeded: false });

    const before = await key(eng, 'ssr_submit');
    expect(before.dueDate).toBe('2027-07-01');
    await w.as('coord', (ctx) => updateEngagement(ctx, eng, { reviewYear: 2028 }));
    expect((await key(eng, 'ssr_submit')).dueDate).toBe('2028-07-01');
    await w.as('coord', (ctx) => updateEngagement(ctx, eng, { reviewYear: 2027 }));
    expect((await key(eng, 'ssr_submit')).dueDate).toBe('2027-07-01');
  });

  it('keeps a date a person set when the rule is recomputed', async () => {
    const m = await key(eng, 'pay_invoice');
    expect(m.origin).toBe('modified');
    expect(m.dueDate).toBe('2027-06-10');
    await w.as('coord', (ctx) => updateEngagement(ctx, eng, { reviewYear: 2029 }));
    expect((await key(eng, 'pay_invoice')).dueDate).toBe('2027-06-10');
    await w.as('coord', (ctx) => updateEngagement(ctx, eng, { reviewYear: 2027 }));
  });

  it('removes a key date when it is set to null', async () => {
    await w.as('coord', (ctx) => updateEngagement(ctx, eng, { keyDates: { visit_date: null } }));
    expect(await key(eng, 'on_site_visit')).toMatchObject({ dueDate: null, dateNeeded: true });
    expect((await detail('coord', eng)).engagement.keyDates).toEqual({});
  });

  it('resolves "N days after another milestone" once that milestone is done', async () => {
    const draft = await key(eng, 'draft_statement_received');
    const due = await key(eng, 'due_process_response');
    expect(due).toMatchObject({ dueDate: null, dateNeeded: true });
    const done = await w.as('coord', (ctx) => updateMilestone(ctx, draft.id, { status: 'done' }));
    const completedOn = done.completedAt!.slice(0, 10);
    expect((await key(eng, 'due_process_response')).dueDate).toBe(addDays(completedOn, 30));
  });
});

describe('phase advance', () => {
  it('is refused while required milestones in the current phase are open, naming them', async () => {
    const d = await detail('coord', eng);
    expect(d.canAdvance).toBe(false);
    expect(d.phases.map((p) => [p.type, p.current])).toEqual([['eligibility', true], ['self_study', false], ['review', false], ['decision', false], ['maintenance', false]]);
    await expect(w.as('coord', (ctx) => advancePhase(ctx, eng))).rejects.toThrow(/required milestone\(s\) in this phase are not done or skipped/);
  });

  it('advances phase by phase once the required milestones are done or skipped, and stops at the last', async () => {
    const order = ['eligibility', 'self_study', 'review', 'decision', 'maintenance'];
    for (let i = 0; i < order.length - 1; i++) {
      for (const m of (await ms('coord', eng)).filter((x) => x.phase === order[i] && x.required && x.status !== 'done' && x.status !== 'skipped')) {
        await w.as('coord', (ctx) => updateMilestone(ctx, m.id, i % 2 ? { status: 'done' } : { status: 'skipped', skipReason: 'Not applicable to this program' }));
      }
      const d = await detail('coord', eng);
      expect(d.canAdvance).toBe(true);
      const next = await w.as('coord', (ctx) => advancePhase(ctx, eng));
      expect(next.currentPhase).toBe(order[i + 1]);
    }
    expect((await detail('coord', eng)).canAdvance).toBe(false);
    await expect(w.as('coord', (ctx) => advancePhase(ctx, eng))).rejects.toThrow(/last phase/);
  });

  it('reports progress as completed required milestones over required milestones', async () => {
    const d = await detail('alo', wsc);
    const self = d.phases.find((p) => p.type === 'self_study')!;
    expect(self.requiredTotal).toBe(7);
    expect(self.requiredDone).toBe(0);
    const first = (await ms('alo', wsc)).find((m) => m.templateKey === 'liaison_consultation')!;
    await w.as('alo', (ctx) => updateMilestone(ctx, first.id, { status: 'done' }));
    expect((await detail('alo', wsc)).phases.find((p) => p.type === 'self_study')!.requiredDone).toBe(1);
  });
});

describe('withdrawing', () => {
  it('is the lead\'s alone, needs a reason, and freezes the roadmap', async () => {
    await expect(w.as('second', (ctx) => withdrawEngagement(ctx, eng, 'no longer pursuing'))).rejects.toThrow(ForbiddenError);
    await expect(w.as('coord', (ctx) => withdrawEngagement(ctx, eng, '  '))).rejects.toThrow();
    const out = await w.as('coord', (ctx) => withdrawEngagement(ctx, eng, 'No longer pursuing accreditation'));
    expect(out).toMatchObject({ status: 'withdrawn', withdrawnReason: 'No longer pursuing accreditation' });
    const m = await key(eng, 'pay_invoice');
    await expect(w.as('coord', (ctx) => updateMilestone(ctx, m.id, { name: 'x' }))).rejects.toThrow(/withdrawn/);
    await expect(w.as('coord', (ctx) => advancePhase(ctx, eng))).rejects.toThrow(/withdrawn/);
    expect((await detail('coord', eng)).canAdvance).toBe(false);
  });
});
