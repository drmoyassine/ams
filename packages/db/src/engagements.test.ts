// M2 schema: row-level security by engagement access (PRD 6.4), one lead (6.9 #13) and the roadmap guardrails (#12).
// Like the other database rules, these bind the table owner: do not relax a trigger to make a test pass.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;

async function one(sql: string, params: unknown[] = []): Promise<string> {
  return (await db.su.query(sql, params)).rows[0].id as string;
}
const fails = (sql: string, params: unknown[], pattern: RegExp) => expect(db.su.query(sql, params)).rejects.toThrow(pattern);

/** An engagement and its lead assignment in one transaction (the lead rule is checked at commit). */
type Id = string | undefined; // the fixture ids are filled in beforeAll, so a lookup is typed possibly-undefined
async function makeEngagement(opts: { subjectType: 'institution' | 'program'; subjectId: Id; lead: Id; title: string; version?: Id }) {
  await db.su.query('begin');
  try {
    const e = await one(
      `insert into engagement (institution_id, framework_version_id, subject_type, subject_id, kind, title, review_year, lead_user_id)
       values ($1, $2, $3, $4, 'reaffirmation', $5, 2028, $6) returning id`,
      [ids.inst, opts.version ?? ids.version, opts.subjectType, opts.subjectId, opts.title, opts.lead]);
    await db.su.query(
      `insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'engagement_lead', 'engagement', $3)`,
      [ids.inst, opts.lead, e]);
    await db.su.query('commit');
    return e;
  } catch (err) {
    await db.su.query('rollback');
    throw err;
  }
}
const milestone = (eng: Id, over: { key?: string; phase?: string; locked?: boolean; required?: boolean; origin?: string; name?: string } = {}) =>
  one(
    `insert into milestone (institution_id, engagement_id, template_key, phase, name, type, locked, required, origin)
     values ($1, $2, $3, $4, $5, 'task', $6, $7, $8) returning id`,
    [ids.inst, eng, over.key ?? null, over.phase ?? 'self_study', over.name ?? 'M', over.locked ?? false, over.required ?? true, over.origin ?? 'template']);

beforeAll(async () => {
  db = await createTestDb('engagements');
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  const user = (n: string) => one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $3) returning id`, [ids.inst, n, `${n}@x.org`]);
  for (const n of ['leadA', 'leadB', 'progOne', 'progTwo', 'viewer', 'member', 'stranger']) ids[n] = await user(n);
  ids.unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'C') returning id`, [ids.inst]);
  ids.p1 = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'P1', 'bachelor') returning id`, [ids.inst, ids.unit]);
  ids.p2 = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'P2', 'bachelor') returning id`, [ids.inst, ids.unit]);
  const grant = (u: string, role: string, scope: string, scopeId: string) =>
    db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids.inst, ids[u], role, scope, scopeId]);
  await grant('progOne', 'contributor', 'program', ids.p1);
  await grant('progTwo', 'contributor', 'program', ids.p2);
  await grant('viewer', 'viewer', 'institution', ids.inst);

  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'A', 'A', 'institutional') returning id`, [ids.inst]);
  const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'F', 'both') returning id`, [ids.inst, acc]);
  const version = async (edition: string, publish: boolean) => {
    const v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, $3) returning id`, [ids.inst, fw, edition]);
    const r = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, review_status) values ($1, $2, 'R1', 'Standard', 'T', 'approved') returning id`, [ids.inst, v]);
    if (publish) {
      await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [v]);
      await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [v, ids.leadA]);
    }
    return { v, r };
  };
  const pub = await version('2023', true);
  ids.version = pub.v; ids.req = pub.r;
  const other = await version('2024', true);
  ids.otherVersion = other.v; ids.otherReq = other.r;
  ids.draft = (await version('draft', false)).v;

  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'lead', 'program', $3)`, [ids.inst, ids.leadA, ids.p1]);
  ids.engP1 = await makeEngagement({ subjectType: 'program', subjectId: ids.p1, lead: ids.leadA, title: 'P1 engagement' });
  ids.engP2 = await makeEngagement({ subjectType: 'program', subjectId: ids.p2, lead: ids.leadB, title: 'P2 engagement' });
  ids.engInst = await makeEngagement({ subjectType: 'institution', subjectId: ids.inst, lead: ids.leadB, title: 'Institution engagement' });
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'contributor', 'engagement', $3)`, [ids.inst, ids.member, ids.engInst]);
  for (const e of [ids.engP1, ids.engP2, ids.engInst]) {
    await milestone(e, { key: 'ssr_submit' });
    await db.su.query(`insert into engagement_requirement (institution_id, engagement_id, requirement_id) values ($1, $2, $3)`, [ids.inst, e, ids.req]);
  }
}, 30000);
afterAll(() => db.close());

const titlesFor = (u: string) =>
  db.as({ userId: ids[u], institutionId: ids.inst }, async (c) =>
    (await c.query(`select title from engagement order by title`)).rows.map((r) => r.title as string));

describe('row-level security follows engagement access', () => {
  it('shows a program-scoped user only the engagements of their program', async () => {
    expect(await titlesFor('progOne')).toEqual(['P1 engagement']);
    expect(await titlesFor('progTwo')).toEqual(['P2 engagement']);
  });

  it('shows an institution-wide role every engagement and an engagement member only theirs', async () => {
    expect(await titlesFor('viewer')).toEqual(['Institution engagement', 'P1 engagement', 'P2 engagement']);
    expect(await titlesFor('member')).toEqual(['Institution engagement']);
    expect(await titlesFor('stranger')).toEqual([]);
  });

  it('gives milestones and requirements the same visibility as their engagement', async () => {
    for (const table of ['milestone', 'engagement_requirement']) {
      const n = (u: string) => db.as({ userId: ids[u], institutionId: ids.inst }, async (c) => (await c.query(`select count(*)::int as n from ${table}`)).rows[0].n as number);
      expect(await n('progOne')).toBe(1);
      expect(await n('member')).toBe(1);
      expect(await n('viewer')).toBe(3);
      expect(await n('stranger')).toBe(0);
    }
  });

  it('refuses a write into an engagement the caller cannot see', async () => {
    await expect(db.as({ userId: ids.progOne, institutionId: ids.inst }, (c) =>
      c.query(`insert into milestone (institution_id, engagement_id, phase, name, type, origin) values ($1, $2, 'review', 'x', 'task', 'local')`, [ids.inst, ids.engP2]),
    )).rejects.toThrow(/row-level security/);
  });

  it('does not let the worker write engagements', async () => {
    await expect(db.as({ userId: ids.viewer, institutionId: ids.inst, role: 'ams_worker' }, (c) =>
      c.query(`update engagement set title = 'x'`))).rejects.toThrow(/permission denied/);
  });
});

describe('engagement rules', () => {
  it('needs a published framework version', async () => {
    await expect(makeEngagement({ subjectType: 'institution', subjectId: ids.inst, lead: ids.leadA, title: 'x', version: ids.draft })).rejects.toThrow(/published framework version/);
  });

  it('fixes the version, subject and kind, and is never deleted', async () => {
    await fails(`update engagement set framework_version_id = $2 where id = $1`, [ids.engP1, ids.otherVersion], /cannot change/);
    await fails(`update engagement set kind = 'initial' where id = $1`, [ids.engP1], /cannot change/);
    await fails(`delete from engagement where id = $1`, [ids.engP1], /cannot be deleted/);
    await db.su.query(`update engagement set template_synced_version_id = $2, title = 'P1 engagement' where id = $1`, [ids.engP1, ids.otherVersion]);
  });

  it('needs a reason to withdraw', async () => {
    await fails(`update engagement set status = 'withdrawn' where id = $1`, [ids.engP2], /engagement_withdrawn_reason/);
  });
});

describe('invariant 13: one lead', () => {
  it('rejects an engagement without its lead assignment, at commit', async () => {
    await db.su.query('begin');
    await db.su.query(
      `insert into engagement (institution_id, framework_version_id, subject_type, subject_id, kind, title, review_year, lead_user_id)
       values ($1, $2, 'institution', $1, 'initial', 'no lead', 2027, $3)`, [ids.inst, ids.version, ids.leadA]);
    await expect(db.su.query('commit')).rejects.toThrow(/exactly one engagement lead/);
  });

  it('rejects a lead assignment held by someone other than lead_user_id', async () => {
    await db.su.query('begin');
    const e = await one(
      `insert into engagement (institution_id, framework_version_id, subject_type, subject_id, kind, title, review_year, lead_user_id)
       values ($1, $2, 'institution', $1, 'initial', 'wrong lead', 2027, $3) returning id`, [ids.inst, ids.version, ids.leadA]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'engagement_lead', 'engagement', $3)`, [ids.inst, ids.leadB, e]);
    await expect(db.su.query('commit')).rejects.toThrow(/exactly one engagement lead/);
  });

  it('rejects removing the lead, or adding a second one', async () => {
    await fails(`delete from role_assignment where role = 'engagement_lead' and scope_id = $1`, [ids.engP2], /exactly one engagement lead/);
    await fails(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'engagement_lead', 'engagement', $3)`, [ids.inst, ids.leadA, ids.engP2], /exactly one engagement lead/);
  });

  it('allows a handover when the assignment and lead_user_id change together', async () => {
    await db.su.query('begin');
    await db.su.query(`delete from role_assignment where role = 'engagement_lead' and scope_id = $1`, [ids.engInst]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'engagement_lead', 'engagement', $3)`, [ids.inst, ids.leadA, ids.engInst]);
    await db.su.query(`update engagement set lead_user_id = $2 where id = $1`, [ids.engInst, ids.leadA]);
    await db.su.query('commit');
    const { rows } = await db.su.query(`select lead_user_id from engagement where id = $1`, [ids.engInst]);
    expect(rows[0].lead_user_id).toBe(ids.leadA);
  });

  it('does not ask a withdrawn engagement for a lead', async () => {
    const e = await makeEngagement({ subjectType: 'institution', subjectId: ids.inst, lead: ids.leadB, title: 'to withdraw' });
    await db.su.query('begin');
    await db.su.query(`update engagement set status = 'withdrawn', withdrawn_reason = 'not pursuing' where id = $1`, [e]);
    await db.su.query(`delete from role_assignment where role = 'engagement_lead' and scope_id = $1`, [e]);
    await db.su.query('commit');
  });
});

describe('invariant 12: roadmap guardrails', () => {
  it('never deletes or unlocks a locked milestone', async () => {
    const m = await milestone(ids.engP1, { key: 'decision', phase: 'decision', locked: true, name: 'Decision' });
    await fails(`delete from milestone where id = $1`, [m], /locked and cannot be deleted/);
    await fails(`update milestone set locked = false where id = $1`, [m], /cannot be unlocked/);
    const free = await milestone(ids.engP1, { key: 'optional', required: false });
    await db.su.query(`delete from milestone where id = $1`, [free]);
  });

  it('skips a required milestone only with a reason', async () => {
    const m = await milestone(ids.engP1, { key: 'req1' });
    await fails(`update milestone set status = 'skipped' where id = $1`, [m], /milestone_skip_reason/);
    await fails(`update milestone set status = 'skipped', skip_reason = '  ' where id = $1`, [m], /milestone_skip_reason/);
    await db.su.query(`update milestone set status = 'skipped', skip_reason = 'accreditor waived it' where id = $1`, [m]);
    const opt = await milestone(ids.engP1, { key: 'opt1', required: false });
    await db.su.query(`update milestone set status = 'skipped' where id = $1`, [opt]);
    await db.su.query(`update milestone set status = 'not_started' where id = $1`, [m]); // un-skipping is always allowed
  });

  it('keeps template milestones in their phase, required and keyed, and lets only the origin move to modified', async () => {
    const m = await milestone(ids.engP1, { key: 'fixed1', phase: 'review' });
    await fails(`update milestone set phase = 'decision' where id = $1`, [m], /only local milestones/);
    await fails(`update milestone set required = false where id = $1`, [m], /required comes from the template/);
    await fails(`update milestone set template_key = 'other' where id = $1`, [m], /template key/);
    await fails(`update milestone set origin = 'local' where id = $1`, [m], /origin cannot change/);
    await db.su.query(`update milestone set origin = 'modified', name = 'Renamed', due_date = '2028-07-01' where id = $1`, [m]);
    await fails(`update milestone set origin = 'template' where id = $1`, [m], /origin cannot change/);
  });

  it('lets a local milestone move between phases', async () => {
    const m = await milestone(ids.engP1, { origin: 'local', phase: 'self_study', name: 'Board approval' });
    await db.su.query(`update milestone set phase = 'review' where id = $1`, [m]);
    await db.su.query(`delete from milestone where id = $1`, [m]);
  });

  it('does not duplicate a template milestone within an engagement', async () => {
    await fails(`insert into milestone (institution_id, engagement_id, template_key, phase, name, type) values ($1, $2, 'ssr_submit', 'self_study', 'dup', 'task')`, [ids.inst, ids.engP1], /milestone_engagement_template_key_idx/);
  });

  it('requires done milestones to carry a completion time', async () => {
    const m = await milestone(ids.engP1, { key: 'done1' });
    await fails(`update milestone set status = 'done' where id = $1`, [m], /milestone_done_completed_at/);
    await db.su.query(`update milestone set status = 'done', completed_at = now() where id = $1`, [m]);
  });
});

describe('engagement requirements', () => {
  it('only link requirements of the engagement\'s framework version', async () => {
    await fails(`insert into engagement_requirement (institution_id, engagement_id, requirement_id) values ($1, $2, $3)`, [ids.inst, ids.engP2, ids.otherReq], /does not belong/);
    await fails(`update engagement_requirement set requirement_id = $2 where engagement_id = $1`, [ids.engP2, ids.otherReq], /cannot change/);
  });

  it('are unique per engagement and requirement', async () => {
    await fails(`insert into engagement_requirement (institution_id, engagement_id, requirement_id) values ($1, $2, $3)`, [ids.inst, ids.engP2, ids.req], /engagement_requirement_unique_idx/);
  });
});

describe('audit', () => {
  it('records milestone changes with the caller\'s id', async () => {
    const m = await milestone(ids.engInst, { key: 'audited', phase: 'review' });
    await db.as({ userId: ids.leadA, institutionId: ids.inst }, (c) => c.query(`update milestone set name = 'Audited' where id = $1`, [m]));
    const { rows } = await db.su.query(`select actor_id from audit_event where target_type = 'milestone' and target_id = $1 and action = 'update'`, [m]);
    expect(rows.map((r) => r.actor_id)).toEqual([ids.leadA]);
  });
});
