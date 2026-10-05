// M2 acceptance (PRD 18.4): "WSCUC reaffirmation, review year 2028" and "ABET EAC initial, BS Mechanical, review year
// 2027" are created through the same endpoint with the same request shape, and give the milestones and dates of
// Appendix A, with requirement counts that follow the applicability tags.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, params: unknown[] = []) => (await db.su.query(sql, params)).rows[0].id as string;
const fixture = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../packages/db/fixtures/${name}.json`), 'utf8')) as { requirements: { is_assessable: boolean; applies_when: unknown }[] };

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': `${ids[who]}:${ids.inst}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function publish(name: string): Promise<string> {
  const imported = await call('admin', 'POST', '/api/framework-versions/import', { file: fixture(name), autoApprove: true });
  const id = imported.body.version.id as string;
  expect((await call('admin', 'POST', `/api/framework-versions/${id}/submit`)).status).toBe(200);
  expect((await call('admin', 'POST', `/api/framework-versions/${id}/publish`)).status).toBe(200);
  return id;
}
/** Phase, key, due date (null when set manually), and whether it waits for a date. */
const roadmap = (milestones: { phase: string; templateKey: string; dueDate: string | null; dateNeeded: boolean; locked: boolean }[]) =>
  milestones.map((m) => [m.phase, m.templateKey, m.dueDate, m.dateNeeded] as const);

beforeAll(async () => {
  db = await createTestDb('m2accept');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool,
    authenticate: async (req) => {
      const h = req.headers.get('x-test-user');
      if (!h) return null;
      const [userId, institutionId] = h.split(':');
      return { userId: userId!, institutionId: institutionId! };
    },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'alo', 'coord']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  const unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.mech = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Mechanical Engineering', 'bachelor', '{mechanical}') returning id`, [ids.inst, unit]);
  ids.civil = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Civil Engineering', 'bachelor', '{civil}') returning id`, [ids.inst, unit]);
  const grant = (u: string, role: string, scope: string, scopeId: string) =>
    db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids.inst, ids[u], role, scope, scopeId]);
  await grant('admin', 'admin', 'institution', ids.inst!);
  await grant('alo', 'lead', 'institution', ids.inst!); // the accreditation liaison officer runs the WSCUC cycle
  await grant('coord', 'lead', 'program', ids.mech!); // the program coordinator runs the ABET cycle
  ids.wscuc = await publish('wscuc-2023');
  ids.abet = await publish('abet-eac-2027-28');
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('M2 acceptance: two accreditors, one code path', () => {
  let wscuc: { engagement: { id: string }; requirementCounts: { applicable: number; notApplicable: number }; milestoneCount: number };
  let abet: typeof wscuc;

  it('creates both engagements through the same endpoint', async () => {
    const a = await call('alo', 'POST', '/api/engagements', {
      frameworkVersionId: ids.wscuc, subjectType: 'institution', subjectId: ids.inst, kind: 'reaffirmation', reviewYear: 2028,
      keyDates: { submission_date: '2028-03-01' }, leadUserId: ids.alo,
    });
    const b = await call('coord', 'POST', '/api/engagements', {
      frameworkVersionId: ids.abet, subjectType: 'program', subjectId: ids.mech, kind: 'initial', reviewYear: 2027, leadUserId: ids.coord,
    });
    expect([a.status, b.status]).toEqual([201, 201]);
    wscuc = a.body; abet = b.body;
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
  });

  it('WSCUC reaffirmation 2028: the Appendix A roadmap and dates', async () => {
    const d = (await call('alo', 'GET', `/api/engagements/${wscuc.engagement.id}`)).body;
    expect(d.engagement).toMatchObject({ kind: 'reaffirmation', reviewYear: 2028, currentPhase: 'self_study', subjectType: 'institution' });
    expect(roadmap(d.milestones)).toEqual([
      ['self_study', 'liaison_consultation', '2026-09-08', false], // submission date -540 days
      ['self_study', 'review_accreditation_history', '2026-10-08', false], // -510
      ['self_study', 'compliance_worksheet_draft', '2027-03-07', false], // -360
      ['self_study', 'essays_drafted', '2027-10-03', false], // -150
      ['self_study', 'internal_approval', '2028-01-16', false], // -45
      ['self_study', 'presidents_letter_signed', '2028-02-15', false], // -15
      ['self_study', 'submit_institutional_report', '2028-03-01', false],
      ['review', 'offsite_review', null, false],
      ['review', 'accreditation_visit', null, true], // waits for the visit date
      ['review', 'response_to_team_report', null, false],
      ['decision', 'commission_action', null, true], // waits for the decision date
      ['decision', 'action_letter_received', null, true], // 30 days after the commission action
      ['maintenance', 'annual_report', null, false],
      ['maintenance', 'follow_up_report', null, false],
      ['maintenance', 'start_next_cycle', null, false],
    ]);
    expect(d.phases.map((p: { type: string }) => p.type)).toEqual(['self_study', 'review', 'decision', 'maintenance']);
    const locked = d.milestones.filter((m: { locked: boolean }) => m.locked).map((m: { templateKey: string }) => m.templateKey).sort();
    expect(locked).toEqual(['commission_action', 'submit_institutional_report']);
  });

  it('ABET EAC initial 2027, BS Mechanical: the Appendix A roadmap and dates', async () => {
    const d = (await call('coord', 'GET', `/api/engagements/${abet.engagement.id}`)).body;
    expect(d.engagement).toMatchObject({ kind: 'initial', reviewYear: 2027, currentPhase: 'eligibility', subjectName: 'BS Mechanical Engineering' });
    expect(roadmap(d.milestones)).toEqual([
      ['eligibility', 'confirm_graduate', null, false],
      ['eligibility', 'rrev_request', '2026-08-15', false],
      ['eligibility', 'rrev_report', '2026-09-01', false],
      ['eligibility', 'rrev_fee', '2026-11-30', false],
      ['eligibility', 'rrev_recommendation', '2026-12-20', false],
      ['eligibility', 'notify_abet', '2027-01-15', false],
      ['eligibility', 'rfe_submit_initial', '2027-01-31', false],
      ['self_study', 'assign_criterion_owners', '2026-09-01', false],
      ['self_study', 'complete_tables', '2027-04-15', false],
      ['self_study', 'ssr_draft', '2027-05-15', false],
      ['self_study', 'internal_approval', '2027-06-15', false],
      ['self_study', 'ssr_submit', '2027-07-01', false],
      ['review', 'pay_invoice', '2027-05-31', false],
      ['review', 'review_team_conflicts', null, false],
      ['review', 'on_site_visit', null, true],
      ['decision', 'draft_statement_received', null, false],
      ['decision', 'due_process_response', null, true], // 30 days after the draft statement is received
      ['decision', 'july_commission_meeting', '2028-07-15', false],
      ['decision', 'final_statement_received', '2028-08-31', false],
      ['maintenance', 'report_program_changes', null, false],
      ['maintenance', 'start_next_cycle', null, false],
    ]);
    const locked = d.milestones.filter((m: { locked: boolean }) => m.locked).map((m: { templateKey: string }) => m.templateKey).sort();
    expect(locked).toEqual(['final_statement_received', 'rrev_recommendation', 'ssr_submit']);
  });

  it('entering a key date or completing a milestone resolves the dates that waited for it', async () => {
    await call('alo', 'PATCH', `/api/engagements/${wscuc.engagement.id}`, { keyDates: { visit_date: '2028-10-12', decision_date: '2029-02-10' } });
    const w = (await call('alo', 'GET', `/api/engagements/${wscuc.engagement.id}`)).body.milestones as { templateKey: string; dueDate: string }[];
    const due = (k: string) => w.find((m) => m.templateKey === k)!.dueDate;
    expect(due('accreditation_visit')).toBe('2028-10-12');
    expect(due('commission_action')).toBe('2029-02-10');
    expect(due('action_letter_received')).toBeNull(); // 30 days after the commission action is *done*, not after its due date
    const action = w.find((m) => m.templateKey === 'commission_action') as unknown as { id: string };
    const done = await call('alo', 'PATCH', `/api/milestones/${action.id}`, { status: 'done' });
    const completed = done.body.completedAt.slice(0, 10) as string;
    const after = (await call('alo', 'GET', `/api/engagements/${wscuc.engagement.id}`)).body.milestones.find((m: { templateKey: string }) => m.templateKey === 'action_letter_received');
    expect(after.dueDate).toBe(new Date(Date.parse(`${completed}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10));
  });

  it('requirement counts follow the applicability tags', async () => {
    const count = (name: string) => fixture(name).requirements.filter((r) => r.is_assessable).length;
    expect(wscuc.requirementCounts).toEqual({ applicable: count('wscuc-2023'), notApplicable: 0 });
    expect(abet.requirementCounts).toEqual({ applicable: count('abet-eac-2027-28'), notApplicable: 0 });

    // The same framework for a civil program: the Mechanical Program Criteria stay visible but are switched off.
    const civil = await call('admin', 'POST', '/api/engagements', {
      frameworkVersionId: ids.abet, subjectType: 'program', subjectId: ids.civil, kind: 'initial', reviewYear: 2027, leadUserId: ids.admin,
    });
    expect(civil.status).toBe(201);
    expect(civil.body.requirementCounts).toEqual({ applicable: count('abet-eac-2027-28') - 3, notApplicable: 3 });
    const list = (await call('admin', 'GET', `/api/engagements/${civil.body.engagement.id}/requirements`)).body.items as { code: string; applicable: boolean }[];
    expect(list.filter((i) => !i.applicable).map((i) => i.code).sort()).toEqual(['Mechanical 1', 'Mechanical 2', 'Program Criteria: Mechanical']);

    // Institution-wide WSCUC requirements are never program-scoped; an institution subject switches off the program-only ABET ones.
    const inst = await call('admin', 'POST', '/api/engagements', {
      frameworkVersionId: ids.abet, subjectType: 'institution', subjectId: ids.inst, kind: 'initial', reviewYear: 2027, leadUserId: ids.admin,
    });
    expect(inst.status).toBe(400); // ABET EAC reviews programs, not institutions
  });

  it('roadmap guardrails hold through the API', async () => {
    const d = (await call('coord', 'GET', `/api/engagements/${abet.engagement.id}`)).body;
    const m = (k: string) => d.milestones.find((x: { templateKey: string }) => x.templateKey === k);
    expect((await call('coord', 'DELETE', `/api/milestones/${m('ssr_submit').id}`)).status).toBe(409); // locked
    expect((await call('coord', 'DELETE', `/api/milestones/${m('rrev_fee').id}`)).status).toBe(409); // template: skip, don't delete
    expect((await call('coord', 'PATCH', `/api/milestones/${m('rrev_fee').id}`, { status: 'skipped' })).status).toBe(400); // reason needed
    expect((await call('coord', 'PATCH', `/api/milestones/${m('rrev_fee').id}`, { status: 'skipped', skipReason: 'Waived by ABET' })).status).toBe(200);
    expect((await call('coord', 'PATCH', `/api/milestones/${m('ssr_draft').id}`, { phase: 'review' })).status).toBe(409); // template milestones keep their phase
    expect((await call('coord', 'POST', `/api/engagements/${abet.engagement.id}/milestones`, { phase: 'review', name: 'Mock visit' })).status).toBe(201);
    const latest = (await call('coord', 'GET', `/api/engagements/${abet.engagement.id}`)).body;
    expect(latest.members).toHaveLength(1); // exactly one lead
    expect(latest.members[0]).toMatchObject({ role: 'engagement_lead', userId: ids.coord });
  });
});
