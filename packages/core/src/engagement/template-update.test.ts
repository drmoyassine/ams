// Template-update review (PRD 8.5): a newer published framework version never changes a running engagement by itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LifecycleTemplateSchema, type LifecycleTemplate } from '@ams/shared';
import { ForbiddenError } from '../ctx.js';
import { loadConfig, newVersionFrom, publishVersion, submitForReview, updateVersionConfig } from '../framework/index.js';
import { addMember, getEngagement } from './engagements.js';
import { updateMilestone } from './roadmap.js';
import { applyTemplateUpdate, getTemplateUpdate } from './template-update.js';
import { buildWorld, type World } from './test-support.js';

let w: World;
let eng: string;
let newVersion: string;

const key = async (k: string) => (await w.as('coord', (ctx) => getEngagement(ctx, eng))).milestones.find((m) => m.templateKey === k);

beforeAll(async () => {
  w = await buildWorld('tplupdate');
  eng = (await w.create('coord', { subjectType: 'program', subjectId: w.ids.mech!, kind: 'initial' })).engagement.id;
  await w.as('coord', (ctx) => addMember(ctx, eng, { userId: w.ids.contrib!, role: 'contributor' }));
  // A local edit that a template update must never overwrite.
  const m = (await key('pay_invoice'))!;
  await w.as('coord', (ctx) => updateMilestone(ctx, m.id, { name: 'Pay the ABET invoice (finance)' }));
}, 60000);
afterAll(() => w.close());

describe('before a newer version is published', () => {
  it('has nothing to review', async () => {
    const u = await w.as('coord', (ctx) => getTemplateUpdate(ctx, eng));
    expect(u).toMatchObject({ available: false, toVersion: null, changes: [] });
  });
});

describe('after a newer version is published', () => {
  beforeAll(async () => {
    newVersion = await w.as('admin', async (ctx) => {
      const { version: draft } = await newVersionFrom(ctx, w.ids.abet!, { edition: '2028-29', changeSummary: 'Test update' });
      const cfg = (await loadConfig(ctx, draft.id)) as { lifecycle_template: LifecycleTemplate };
      const lc = structuredClone(cfg.lifecycle_template);
      const phase = (type: string, kind = 'initial') => lc.phases.find((p) => p.type === type && p.applies_to.includes(kind as 'initial'))!;
      const ms = (type: string, k: string, kind = 'initial') => phase(type, kind).milestones.find((m) => m.key === k)!;
      phase('self_study').milestones.push({ key: 'mock_review', name: 'Internal mock review', type: 'task', due: { fixed: '05-01', year_offset: 0 }, required: true });
      phase('eligibility').milestones = phase('eligibility').milestones.filter((m) => m.key !== 'rrev_fee');
      ms('self_study', 'ssr_draft').due = { fixed: '05-01', year_offset: 0 };
      ms('self_study', 'complete_tables').name = 'Complete Tables 5-1, 6-1, 6-2 and D';
      ms('review', 'pay_invoice').name = 'Pay invoice (new name from the template)';
      phase('eligibility').milestones = phase('eligibility').milestones.filter((m) => m.key !== 'rrev_recommendation'); // a locked decision point
      await updateVersionConfig(ctx, draft.id, { lifecycleTemplate: LifecycleTemplateSchema.parse(lc) });
      await submitForReview(ctx, draft.id);
      await publishVersion(ctx, draft.id);
      return draft.id;
    });
  });

  it('lists the added, removed, re-dated and changed milestones, and flags protected and blocked ones', async () => {
    const u = await w.as('coord', (ctx) => getTemplateUpdate(ctx, eng));
    expect(u.available).toBe(true);
    expect(u.toVersion).toEqual({ id: newVersion, edition: '2028-29' });
    const byId = Object.fromEntries(u.changes.map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual([
      'added:mock_review', 'changed:complete_tables', 'changed:pay_invoice', 'redated:ssr_draft', 'removed:rrev_fee', 'removed:rrev_recommendation',
    ]);
    expect(byId['added:mock_review']).toMatchObject({ phase: 'self_study', protectedByEdit: false, blocked: null });
    expect(byId['redated:ssr_draft']!.before).toMatchObject({ dueRule: { fixed: '05-15', year_offset: 0 }, dueDate: '2027-05-15' });
    expect(byId['redated:ssr_draft']!.after).toMatchObject({ dueRule: { fixed: '05-01', year_offset: 0 }, dueDate: '2027-05-01' });
    expect(byId['changed:pay_invoice']!.protectedByEdit).toBe(true); // renamed locally
    expect(byId['removed:rrev_recommendation']!.blocked).toMatch(/locked/);
    expect(byId['removed:rrev_fee']).toMatchObject({ blocked: null, protectedByEdit: false });
  });

  it('does not change the engagement by itself', async () => {
    expect(await key('mock_review')).toBeUndefined();
    expect(await key('rrev_fee')).toBeDefined();
    expect((await key('ssr_draft'))!.dueDate).toBe('2027-05-15');
  });

  it('is for the lead and co-lead only', async () => {
    await expect(w.as('contrib', (ctx) => applyTemplateUpdate(ctx, eng, { toVersionId: newVersion, decisions: {} }))).rejects.toThrow(ForbiddenError);
  });

  it('needs a decision for every change, and the right version', async () => {
    await expect(w.as('coord', (ctx) => applyTemplateUpdate(ctx, eng, { toVersionId: newVersion, decisions: { 'added:mock_review': 'accept' } }))).rejects.toThrow(/decide every change/);
    const all = Object.fromEntries((await w.as('coord', (ctx) => getTemplateUpdate(ctx, eng))).changes.map((c) => [c.id, 'ignore' as const]));
    await expect(w.as('coord', (ctx) => applyTemplateUpdate(ctx, eng, { toVersionId: newVersion, decisions: { ...all, 'added:nope': 'accept' } }))).rejects.toThrow(/unknown change/);
    await expect(w.as('coord', (ctx) => applyTemplateUpdate(ctx, eng, { toVersionId: w.ids.abet!, decisions: all }))).rejects.toThrow(/not the newer version/);
  });

  it('applies accepted changes, never overwrites a local edit or removes a locked milestone, and honours ignores', async () => {
    const decisions = {
      'added:mock_review': 'accept', 'removed:rrev_fee': 'accept', 'redated:ssr_draft': 'accept',
      'changed:complete_tables': 'ignore', 'changed:pay_invoice': 'accept', 'removed:rrev_recommendation': 'accept',
    } as const;
    const tablesBefore = (await key('complete_tables'))!.name;
    const out = await w.as('coord', (ctx) => applyTemplateUpdate(ctx, eng, { toVersionId: newVersion, decisions }));
    expect(out.applied.sort()).toEqual(['added:mock_review', 'redated:ssr_draft', 'removed:rrev_fee']);
    expect(out.left.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'changed:complete_tables', reason: 'ignored' },
      { id: 'changed:pay_invoice', reason: 'you changed this milestone, so it is not overwritten' },
      { id: 'removed:rrev_recommendation', reason: expect.stringMatching(/locked/) },
    ]);

    expect(await key('mock_review')).toMatchObject({ origin: 'template', dueDate: '2027-05-01', phase: 'self_study', required: true });
    expect(await key('rrev_fee')).toBeUndefined();
    expect((await key('ssr_draft'))!.dueDate).toBe('2027-05-01');
    expect((await key('complete_tables'))!.name).toBe(tablesBefore); // ignored: unchanged
    expect((await key('pay_invoice'))!.name).toBe('Pay the ABET invoice (finance)'); // the lead's edit survives
    expect(await key('rrev_recommendation')).toBeDefined(); // locked: stays
  });

  it('records the version as reviewed, so nothing is left to review, and the roadmap follows it', async () => {
    const d = await w.as('coord', (ctx) => getEngagement(ctx, eng));
    expect(d.engagement.templateSyncedVersionId).toBe(newVersion);
    expect(d.engagement.frameworkVersionId).toBe(w.ids.abet); // the version it was built on never changes
    expect(await w.as('coord', (ctx) => getTemplateUpdate(ctx, eng))).toMatchObject({ available: false, changes: [] });
    expect(d.phases.map((p) => p.type)).toEqual(['eligibility', 'self_study', 'review', 'decision', 'maintenance']);
  });
});
