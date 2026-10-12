// The requirement workspace: context, assignments, the status flow and who may take each step.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FrameworkExportSchema } from '@ams/shared';
import { ConflictError, ForbiddenError, ValidationError } from '../ctx.js';
import { addMember } from './engagements.js';
import { withdrawEngagement } from './roadmap.js';
import { assignRequirements, getWorkspace, listEngagementRequirements, setApplicability, updateRequirementWork } from './workspace.js';
import { buildWorld, loadFixture, type World } from './test-support.js';

let w: World;
let eng: string;
const item = async (code: string) => (await w.as('coord', (ctx) => listEngagementRequirements(ctx, eng))).items.find((i) => i.code === code)!;

beforeAll(async () => {
  w = await buildWorld('workspace');
  eng = (await w.create('coord', { subjectType: 'program', subjectId: w.ids.mech!, kind: 'initial' })).engagement.id;
  await w.as('coord', (ctx) => addMember(ctx, eng, { userId: w.ids.contrib!, role: 'contributor' }));
  await w.as('coord', (ctx) => addMember(ctx, eng, { userId: w.ids.outsider!, role: 'reviewer' })); // the assigned reviewer
  await w.as('coord', (ctx) => addMember(ctx, eng, { userId: w.ids.second!, role: 'reviewer' })); // a reviewer, not assigned
}, 60000);
afterAll(() => w.close());

describe('listing', () => {
  it('lists the engagement\'s requirements in tree order, with counts by status', async () => {
    const list = await w.as('coord', (ctx) => listEngagementRequirements(ctx, eng));
    const assessable = FrameworkExportSchema.parse(loadFixture('abet-eac-2027-28')).requirements.filter((r) => r.is_assessable).length;
    expect(list.items).toHaveLength(assessable);
    expect(list.items[0]!.code).toBe('Criterion 1');
    const codes = list.items.map((i) => i.code);
    expect(codes.indexOf('Criterion 3(1)')).toBeGreaterThan(codes.indexOf('Criterion 3'));
    expect(codes.indexOf('Criterion 3(7)')).toBeLessThan(codes.indexOf('Criterion 4'));
    expect(list.items.find((i) => i.code === 'Criterion 3(2)')!.parentCode).toBe('Criterion 3');
    expect(list.byStatus).toEqual({ not_started: assessable, in_progress: 0, ready_for_review: 0, approved: 0, needs_work: 0 });
  });
});

describe('workspace context', () => {
  it('gives the framework\'s text, path, notes with authority and a source link to the cited page', async () => {
    const ws = await w.as('coord', async (ctx) => getWorkspace(ctx, (await item('Criterion 5(a)')).id));
    expect(ws.requirement).toMatchObject({ code: 'Criterion 5(a)', levelLabel: 'Item', language: 'en', path: [{ code: 'Criterion 5', title: 'Curriculum' }] });
    expect(ws.requirement.title).toMatch(/^a minimum of 30 semester credit hours/);
    expect(ws.requirement.source).toMatchObject({ page: 9, quoteVerified: true });
    expect(ws.notes).toHaveLength(1);
    expect(ws.notes[0]).toMatchObject({ type: 'quantitative_norm', authority: 'required', norm: { min: 30 }, source: { quoteVerified: true } });
    expect(ws).toMatchObject({ workingNotes: null, reports: [], canAssign: true });
  });

  it('is readable by anyone who can see the engagement and by no one else', async () => {
    const id = (await item('Criterion 1')).id;
    await w.as('contrib', (ctx) => getWorkspace(ctx, id));
    await expect(w.as('alo', (ctx) => getWorkspace(ctx, id))).resolves.toBeDefined(); // institution-wide lead
    await expect(w.as('outsider', (ctx) => getWorkspace(ctx, id))).resolves.toBeDefined(); // a member of the engagement
  });
});

describe('assignments', () => {
  it('lets the lead assign an owner, a reviewer and a due date', async () => {
    const id = (await item('Criterion 1')).id;
    const ws = await w.as('coord', (ctx) => updateRequirementWork(ctx, id, { ownerId: w.ids.contrib!, reviewerId: w.ids.outsider!, dueDate: '2027-04-01' }));
    expect(ws.item).toMatchObject({ ownerId: w.ids.contrib, reviewerId: w.ids.outsider, dueDate: '2027-04-01' });
  });

  it('refuses assignments by anyone else, to non-members, and to the wrong kind of member', async () => {
    const id = (await item('Criterion 1')).id;
    await expect(w.as('contrib', (ctx) => updateRequirementWork(ctx, id, { ownerId: w.ids.contrib! }))).rejects.toThrow(ConflictError);
    await expect(w.as('coord', (ctx) => updateRequirementWork(ctx, id, { ownerId: w.ids.alo! }))).rejects.toThrow(ValidationError); // not a member
    await expect(w.as('coord', (ctx) => updateRequirementWork(ctx, id, { ownerId: w.ids.second! }))).rejects.toThrow(/can do that work/); // a reviewer cannot own
    await expect(w.as('coord', (ctx) => updateRequirementWork(ctx, id, { reviewerId: w.ids.contrib! }))).rejects.toThrow(/can do that work/); // a contributor cannot review
  });

  it('assigns several requirements at once, all or nothing', async () => {
    const ids = await Promise.all(['Criterion 2', 'Criterion 3', 'Criterion 4'].map(async (c) => (await w.as('coord', (ctx) => listEngagementRequirements(ctx, eng))).items.find((i) => i.code === c)!.requirementId));
    expect(await w.as('coord', (ctx) => assignRequirements(ctx, eng, { requirementIds: ids, ownerId: w.ids.contrib! }))).toEqual({ updated: 3 });
    expect((await item('Criterion 3')).ownerId).toBe(w.ids.contrib);
    await expect(w.as('coord', (ctx) => assignRequirements(ctx, eng, { requirementIds: [...ids, '00000000-0000-4000-8000-000000000000'], ownerId: null }))).rejects.toThrow(/nothing was assigned/);
    expect((await item('Criterion 3')).ownerId).toBe(w.ids.contrib); // rolled back
    await expect(w.as('contrib', (ctx) => assignRequirements(ctx, eng, { requirementIds: ids, ownerId: w.ids.contrib! }))).rejects.toThrow(ForbiddenError);
  });
});

describe('the status flow', () => {
  it('moves from not started to internally approved, one permitted step at a time', async () => {
    const id = (await item('Criterion 1')).id;
    const step = (who: string, status: Parameters<typeof updateRequirementWork>[2]['status']) => w.as(who, (ctx) => updateRequirementWork(ctx, id, { status }));

    expect((await w.as('contrib', (ctx) => getWorkspace(ctx, id))).allowedStatuses).toEqual(['in_progress']);
    expect((await step('contrib', 'in_progress')).item.status).toBe('in_progress');
    expect((await step('contrib', 'ready_for_review')).item.status).toBe('ready_for_review');
    expect((await w.as('contrib', (ctx) => getWorkspace(ctx, id))).allowedStatuses).toEqual(['in_progress']); // can only take it back

    await expect(step('contrib', 'approved')).rejects.toThrow(/only its reviewer/);
    await expect(step('second', 'approved')).rejects.toThrow(/only its reviewer/); // a reviewer, but not this one's
    expect((await w.as('outsider', (ctx) => getWorkspace(ctx, id))).allowedStatuses).toEqual(['approved', 'needs_work']);
    expect((await step('outsider', 'needs_work')).item.status).toBe('needs_work');
    expect((await step('contrib', 'in_progress')).item.status).toBe('in_progress');
    expect((await step('contrib', 'ready_for_review')).item.status).toBe('ready_for_review');
    expect((await step('outsider', 'approved')).item.status).toBe('approved');
    expect((await step('outsider', 'needs_work')).item.status).toBe('needs_work'); // reopening
  });

  it('refuses a jump that is not a step, and lets the lead do anything the roles allow', async () => {
    const other = (await item('Criterion 2')).id;
    await expect(w.as('coord', (ctx) => updateRequirementWork(ctx, other, { status: 'approved' }))).rejects.toThrow(/cannot go from not started to approved/);
    const ws = await w.as('coord', (ctx) => updateRequirementWork(ctx, other, { status: 'in_progress' }));
    expect(ws.item.status).toBe('in_progress');
  });

  it('keeps working notes to the owner and the lead', async () => {
    const id = (await item('Criterion 1')).id;
    expect((await w.as('contrib', (ctx) => updateRequirementWork(ctx, id, { workingNotes: 'Draft: see the advising handbook.' }))).workingNotes).toBe('Draft: see the advising handbook.');
    await expect(w.as('second', (ctx) => updateRequirementWork(ctx, id, { workingNotes: 'x' }))).rejects.toThrow(/only the owner/);
    const notOwned = (await item('Criterion 6')).id;
    await expect(w.as('contrib', (ctx) => updateRequirementWork(ctx, notOwned, { workingNotes: 'x' }))).rejects.toThrow(/only the owner/);
    expect((await w.as('coord', (ctx) => updateRequirementWork(ctx, notOwned, { workingNotes: 'Lead\'s note' }))).workingNotes).toBe('Lead\'s note');
  });
});

describe('applicability override', () => {
  it('switches a requirement off or on with a reason, and a switched-off requirement is not worked on', async () => {
    const id = (await item('Criterion 8')).id;
    await expect(w.as('coord', (ctx) => setApplicability(ctx, id, { applicable: false, reason: '  ' }))).rejects.toThrow(/reason/);
    await expect(w.as('contrib', (ctx) => setApplicability(ctx, id, { applicable: false, reason: 'x' }))).rejects.toThrow(ForbiddenError);
    const off = await w.as('coord', (ctx) => setApplicability(ctx, id, { applicable: false, reason: 'Covered by the institutional review' }));
    expect(off.item).toMatchObject({ applicable: false, naReason: 'Covered by the institutional review' });
    expect(off.allowedStatuses).toEqual([]);
    await expect(w.as('coord', (ctx) => updateRequirementWork(ctx, id, { status: 'in_progress' }))).rejects.toThrow(/not applicable/);
    await expect(w.as('coord', (ctx) => setApplicability(ctx, id, { applicable: false, reason: 'again' }))).rejects.toThrow(/already/);
    const list = await w.as('coord', (ctx) => listEngagementRequirements(ctx, eng));
    expect(Object.values(list.byStatus).reduce((a, b) => a + b, 0)).toBe(list.items.filter((i) => i.applicable).length);
    const on = await w.as('coord', (ctx) => setApplicability(ctx, id, { applicable: true, reason: 'The visit team asked for it' }));
    expect(on.item).toMatchObject({ applicable: true, naReason: 'The visit team asked for it' });
  });
});

describe('history', () => {
  it('lists the changes with who made them, for anyone who can see the engagement', async () => {
    const id = (await item('Criterion 1')).id;
    const ws = await w.as('coord', (ctx) => getWorkspace(ctx, id));
    const statuses = ws.history.filter((h) => h.changes.status).map((h) => [h.actorName, h.changes.status!.to]);
    expect(statuses).toContainEqual(['contrib', 'ready_for_review']);
    expect(statuses).toContainEqual(['outsider', 'approved']);
    expect(statuses[0]).toEqual(['outsider', 'needs_work']); // newest first
    expect(ws.history.some((h) => h.changes.owner_id?.to === w.ids.contrib)).toBe(true);
    const asMember = await w.as('contrib', (ctx) => getWorkspace(ctx, id));
    expect(asMember.history.length).toBe(ws.history.length);
  });
});

describe('a withdrawn engagement', () => {
  it('can no longer be worked on', async () => {
    const id = (await item('Criterion 7')).id;
    await w.as('coord', (ctx) => withdrawEngagement(ctx, eng, 'Not pursuing this cycle'));
    await expect(w.as('coord', (ctx) => updateRequirementWork(ctx, id, { status: 'in_progress' }))).rejects.toThrow(/withdrawn/);
    const ws = await w.as('coord', (ctx) => getWorkspace(ctx, id));
    expect(ws).toMatchObject({ allowedStatuses: [], canAssign: false, canEdit: false });
  });
});
