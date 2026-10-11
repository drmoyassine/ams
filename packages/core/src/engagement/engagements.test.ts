// The engagement service: the wizard transaction, permissions by role and scope, members and the lead handover.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engagementRequirement, withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { FrameworkExportSchema, type CreateEngagement } from '@ams/shared';
import { ForbiddenError, type Ctx } from '../index.js';
import { importVersion, publishVersion, submitForReview } from '../framework/index.js';
import { addMember, changeMemberRole, createEngagement, getEngagement, handoverLead, listEngagements, listMembers, removeMember } from './engagements.js';

const FIXTURES = resolve(import.meta.dirname, '../../../db/fixtures');
const load = (name: string) => JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as unknown;

let db: TestDb;
let pool: pg.Pool;
const ids = {} as Record<string, string>;

const as = <T>(who: string, fn: (ctx: Ctx) => Promise<T>) => {
  const caller = { userId: ids[who]!, institutionId: ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  return withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined }));
};
const create = (who: string, over: Partial<CreateEngagement> & Pick<CreateEngagement, 'subjectType' | 'subjectId' | 'kind'>) =>
  as(who, (ctx) => createEngagement(ctx, { frameworkVersionId: ids.abet!, reviewYear: 2027, leadUserId: ids.coord!, ...over }));

async function publishFixture(name: string) {
  return as('admin', async (ctx) => {
    const { version } = await importVersion(ctx, load(name));
    await submitForReview(ctx, version.id);
    await publishVersion(ctx, version.id);
    return version.id;
  });
}

beforeAll(async () => {
  db = await createTestDb('engagementsvc');
  pool = new pg.Pool({ connectionString: db.url });
  const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  const user = async (n: string, active = true) => { ids[n] = await one(`insert into app_user (institution_id, full_name, email, active) values ($1, $2, $3, $4) returning id`, [ids.inst, n, `${n}@x.org`, active]); };
  for (const n of ['admin', 'alo', 'coord', 'contrib', 'second', 'outsider']) await user(n);
  await user('inactive', false);
  const unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.mech = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Mechanical Engineering', 'bachelor', '{mechanical}') returning id`, [ids.inst, unit]);
  ids.civil = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Civil Engineering', 'bachelor', '{civil}') returning id`, [ids.inst, unit]);
  const grant = (u: string, role: string, scope: string, scopeId: string) =>
    db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids.inst, ids[u], role, scope, scopeId]);
  await grant('admin', 'admin', 'institution', ids.inst!);
  await grant('alo', 'lead', 'institution', ids.inst!);
  await grant('coord', 'lead', 'program', ids.mech!);
  await grant('contrib', 'contributor', 'program', ids.mech!);
  ids.abet = await publishFixture('abet-eac-2027-28');
  ids.wscuc = await publishFixture('wscuc-2023');
  const draft = await as('admin', async (ctx) => (await importVersion(ctx, load('puc-2019'))).version.id);
  ids.draft = draft;
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('create engagement (the wizard transaction)', () => {
  it('creates the engagement, its lead, requirements and milestones for a program-scoped lead', async () => {
    const r = await create('coord', { subjectType: 'program', subjectId: ids.mech!, kind: 'initial', keyDates: { visit_date: '2027-10-18' } });
    ids.engAbet = r.engagement.id;
    expect(r.engagement).toMatchObject({ kind: 'initial', status: 'active', reviewYear: 2027, currentPhase: 'eligibility', leadUserId: ids.coord, subjectName: 'BS Mechanical Engineering', accreditorShortName: 'ABET' });
    expect(r.engagement.title).toMatch(/ABET .*2027 — BS Mechanical Engineering/);
    expect(r.engagement.templateSyncedVersionId).toBe(ids.abet);
    const assessable = FrameworkExportSchema.parse(load('abet-eac-2027-28')).requirements.filter((x) => x.is_assessable).length;
    expect(r.requirementCounts).toEqual({ applicable: assessable, notApplicable: 0 });

    const d = await as('coord', (ctx) => getEngagement(ctx, r.engagement.id));
    expect(d.members).toEqual([{ userId: ids.coord, fullName: 'coord', email: 'coord@x.org', role: 'engagement_lead' }]);
    const date = (k: string) => d.milestones.find((m) => m.templateKey === k)!;
    expect(date('ssr_submit')).toMatchObject({ dueDate: '2027-07-01', origin: 'template', locked: true, status: 'not_started' });
    expect(date('on_site_visit')).toMatchObject({ dueDate: '2027-10-18', dateNeeded: false });
    expect(date('due_process_response')).toMatchObject({ dueDate: null, dateNeeded: true });
    expect(d.milestones).toHaveLength(r.milestoneCount);
  });

  it('switches the Mechanical Program Criteria off for another discipline, using the same code', async () => {
    const r = await create('alo', { subjectType: 'program', subjectId: ids.civil!, kind: 'initial', leadUserId: ids.alo! });
    expect(r.requirementCounts.notApplicable).toBe(3);
    const rows = await as('alo', (ctx) => ctx.tx.select().from(engagementRequirement).where(eq(engagementRequirement.engagementId, r.engagement.id)));
    expect(rows.filter((x) => !x.applicable)).toHaveLength(3);
  });

  it('creates a WSCUC reaffirmation for the institution with the Appendix A dates', async () => {
    const r = await as('alo', (ctx) => createEngagement(ctx, {
      frameworkVersionId: ids.wscuc!, subjectType: 'institution', subjectId: ids.inst!, kind: 'reaffirmation', reviewYear: 2028,
      keyDates: { submission_date: '2028-03-01' }, leadUserId: ids.alo!,
    }));
    ids.engWscuc = r.engagement.id;
    expect(r.engagement.currentPhase).toBe('self_study');
    const d = await as('alo', (ctx) => getEngagement(ctx, r.engagement.id));
    const m = (k: string) => d.milestones.find((x) => x.templateKey === k)!;
    expect(m('liaison_consultation').dueDate).toBe('2026-09-08');
    expect(m('submit_institutional_report')).toMatchObject({ dueDate: '2028-03-01', locked: true });
    expect(d.milestones.some((x) => x.templateKey === 'sav_preparation')).toBe(false);
    expect(r.requirementCounts.notApplicable).toBe(0);
  });

  it('refuses callers without the permission at that scope', async () => {
    await expect(create('contrib', { subjectType: 'program', subjectId: ids.mech!, kind: 'initial' })).rejects.toThrow(ForbiddenError);
    await expect(create('coord', { subjectType: 'program', subjectId: ids.civil!, kind: 'initial' })).rejects.toThrow(ForbiddenError); // lead of another program
    await expect(create('coord', { frameworkVersionId: ids.wscuc!, subjectType: 'institution', subjectId: ids.inst!, kind: 'reaffirmation' })).rejects.toThrow(ForbiddenError);
    await expect(create('outsider', { subjectType: 'program', subjectId: ids.mech!, kind: 'initial' })).rejects.toThrow(ForbiddenError);
  });

  it('refuses a draft version, a framework of the wrong scope, an inactive lead and a missing lead', async () => {
    await expect(create('alo', { frameworkVersionId: ids.draft!, subjectType: 'institution', subjectId: ids.inst!, kind: 'initial' })).rejects.toThrow(/published/);
    await expect(create('alo', { subjectType: 'institution', subjectId: ids.inst!, kind: 'initial' })).rejects.toThrow(/program reviews/);
    await expect(create('alo', { subjectType: 'program', subjectId: ids.mech!, kind: 'initial', leadUserId: ids.inactive! })).rejects.toThrow(/active user/);
    await expect(as('alo', (ctx) => createEngagement(ctx, { frameworkVersionId: ids.abet!, subjectType: 'program', subjectId: ids.mech!, kind: 'initial', reviewYear: 2027 } as CreateEngagement))).rejects.toThrow();
  });

  it('is atomic: a failure leaves nothing behind', async () => {
    const before = (await db.su.query(`select count(*)::int as n from engagement`)).rows[0].n as number;
    await expect(create('alo', { subjectType: 'program', subjectId: '00000000-0000-4000-8000-000000000000', kind: 'initial' })).rejects.toThrow();
    expect((await db.su.query(`select count(*)::int as n from engagement`)).rows[0].n).toBe(before);
  });
});

describe('who sees which engagements', () => {
  it('shows each caller the engagements their roles cover', async () => {
    const titles = async (who: string) => (await as(who, (ctx) => listEngagements(ctx))).map((e) => e.subjectName).sort();
    expect(await titles('admin')).toEqual(['BS Civil Engineering', 'BS Mechanical Engineering', 'Gulf University']);
    expect(await titles('coord')).toEqual(['BS Mechanical Engineering']);
    expect(await titles('contrib')).toEqual(['BS Mechanical Engineering']);
    await expect(titles('outsider')).rejects.toThrow(ForbiddenError); // holds no role anywhere
  });
});

describe('members', () => {
  it('lets the lead add members, and a co-lead add other members but not hand over', async () => {
    let members = await as('coord', (ctx) => addMember(ctx, ids.engAbet!, { userId: ids.second!, role: 'co_lead' }));
    expect(members.map((m) => [m.fullName, m.role])).toEqual([['coord', 'engagement_lead'], ['second', 'co_lead']]);
    members = await as('second', (ctx) => addMember(ctx, ids.engAbet!, { userId: ids.contrib!, role: 'contributor' }));
    expect(members.map((m) => m.role)).toEqual(['engagement_lead', 'co_lead', 'contributor']);
    await expect(as('second', (ctx) => handoverLead(ctx, ids.engAbet!, { newLeadUserId: ids.second!, outgoingRole: 'co_lead' }))).rejects.toThrow(ForbiddenError);
  });

  it('refuses members without manage permission, duplicates, inactive users and changes to the lead', async () => {
    await expect(as('contrib', (ctx) => addMember(ctx, ids.engAbet!, { userId: ids.outsider!, role: 'viewer' }))).rejects.toThrow(ForbiddenError);
    await expect(as('outsider', (ctx) => addMember(ctx, ids.engAbet!, { userId: ids.outsider!, role: 'viewer' }))).rejects.toThrow(); // cannot even see it
    await expect(as('coord', (ctx) => addMember(ctx, ids.engAbet!, { userId: ids.contrib!, role: 'viewer' }))).rejects.toThrow(/already/);
    await expect(as('coord', (ctx) => addMember(ctx, ids.engAbet!, { userId: ids.inactive!, role: 'viewer' }))).rejects.toThrow(/active user/);
    await expect(as('coord', (ctx) => changeMemberRole(ctx, ids.engAbet!, ids.coord!, 'viewer'))).rejects.toThrow(/handing the lead over/);
    await expect(as('coord', (ctx) => removeMember(ctx, ids.engAbet!, ids.coord!))).rejects.toThrow(/hand the lead role over/);
  });

  it('changes and removes members', async () => {
    let members = await as('coord', (ctx) => changeMemberRole(ctx, ids.engAbet!, ids.contrib!, 'reviewer'));
    expect(members.find((m) => m.fullName === 'contrib')!.role).toBe('reviewer');
    members = await as('coord', (ctx) => removeMember(ctx, ids.engAbet!, ids.contrib!));
    expect(members.map((m) => m.fullName)).toEqual(['coord', 'second']);
    await expect(as('coord', (ctx) => removeMember(ctx, ids.engAbet!, ids.contrib!))).rejects.toThrow(/not a member/);
  });
});

describe('lead handover (exactly one lead, always)', () => {
  it('moves the lead to a member; the outgoing lead becomes a co-lead', async () => {
    const members = await as('coord', (ctx) => handoverLead(ctx, ids.engAbet!, { newLeadUserId: ids.second!, outgoingRole: 'co_lead' }));
    expect(members.map((m) => [m.fullName, m.role])).toEqual([['second', 'engagement_lead'], ['coord', 'co_lead']]);
    const d = await as('second', (ctx) => getEngagement(ctx, ids.engAbet!));
    expect(d.engagement.leadUserId).toBe(ids.second);
    expect(d.engagement.leadName).toBe('second');
    await expect(as('coord', (ctx) => handoverLead(ctx, ids.engAbet!, { newLeadUserId: ids.coord!, outgoingRole: null }))).rejects.toThrow(ForbiddenError);
  });

  it('lets an admin hand the lead to anyone, removing the outgoing lead', async () => {
    const members = await as('admin', (ctx) => handoverLead(ctx, ids.engAbet!, { newLeadUserId: ids.contrib!, outgoingRole: null }));
    expect(members.map((m) => [m.fullName, m.role])).toEqual([['contrib', 'engagement_lead'], ['coord', 'co_lead']]);
    await expect(as('admin', (ctx) => handoverLead(ctx, ids.engAbet!, { newLeadUserId: ids.contrib!, outgoingRole: null }))).rejects.toThrow(/already the lead/);
    const { rows } = await db.su.query(`select count(*)::int as n from role_assignment where role = 'engagement_lead' and scope_id = $1`, [ids.engAbet]);
    expect(rows[0].n).toBe(1);
  });

  it('records the handover in the audit trail', async () => {
    const { rows } = await db.su.query(`select count(*)::int as n from audit_event where target_type = 'engagement' and target_id = $1 and action = 'update'`, [ids.engAbet]);
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
    expect((await as('admin', (ctx) => listMembers(ctx, ids.engAbet!))).length).toBe(2);
  });
});
