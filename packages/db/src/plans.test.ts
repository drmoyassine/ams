// Academic calendar and cycle plans in the database (TASK-081, migration 0062): active terms of a kind never overlap, tenant isolation,
// the worker reads and never writes, a plan names things of its own institution only, the anchor shape per kind, one plan per
// anchor and template, a skipped period is recorded once, a run's plan is the institution's own, and the audit trail.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const q = (sql: string, p: unknown[] = []) => db.su.query(sql, p);
const asA = { get userId() { return ids.ua!; }, get institutionId() { return ids.a!; } };
const asB = { get userId() { return ids.ub!; }, get institutionId() { return ids.b!; } };

beforeAll(async () => {
  db = await createTestDb('plans');
  ids.a = await one(`insert into institution (name_en) values ('A') returning id`);
  ids.b = await one(`insert into institution (name_en) values ('B') returning id`);
  ids.ua = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ua', 'ua') returning id`, [ids.a]);
  ids.ub = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ub', 'ub') returning id`, [ids.b]);
  ids.unitA = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'CA') returning id`, [ids.a]);
  ids.unitB = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'CB') returning id`, [ids.b]);
  ids.progA = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'PA', 'bachelor') returning id`, [ids.a, ids.unitA]);
  ids.progB = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'PB', 'bachelor') returning id`, [ids.b, ids.unitB]);
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'A', 'A', 'institutional') returning id`, [ids.a]);
  ids.fwA = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'F', 'institution') returning id`, [ids.a, acc]);
  const accB = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'B', 'B', 'institutional') returning id`, [ids.b]);
  ids.fwB = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'FB', 'institution') returning id`, [ids.b, accB]);
  ids.evA = await one(`insert into evidence_item (institution_id, title, type) values ($1, 'E', 'document') returning id`, [ids.a]);
  ids.tplA = await one(`insert into cycle_template (institution_id, key, name, stages, status, version) values ($1, 'k', 'T', '[]', 'published', 1) returning id`, [ids.a]);
  ids.tplB = await one(`insert into cycle_template (institution_id, key, name, stages, status, version) values ($1, 'k', 'T', '[]', 'published', 1) returning id`, [ids.b]);
}, 60000);
afterAll(async () => { await db.close(); });

const term = (kind: string, start: string, end: string, name = `${kind} ${start}`, inst = ids.a!, active = true) => q(
  `insert into academic_term (institution_id, name, kind, start_date, end_date, active) values ($1, $2, $3, $4, $5, $6) returning id`, [inst, name, kind, start, end, active]);
const plan = (over: Record<string, unknown> = {}) => {
  const v = { inst: ids.a, kind: 'program', anchor: ids.progA, fw: null, code: null, tpl: ids.tplA, unit: null, owner: null, rec: JSON.stringify({ every: 1, unit: 'term' }), first: '2026-08-01', applies: '{}', mode: 'own', ...over };
  return q(`insert into cycle_plan (institution_id, anchor_kind, anchor_id, anchor_framework_id, anchor_code, template_id, responsible_unit_id, owner_user_id, recurrence, first_start, applies_to, mode)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12) returning id`, [v.inst, v.kind, v.anchor, v.fw, v.code, v.tpl, v.unit, v.owner, v.rec, v.first, v.applies, v.mode]);
};

describe('academic calendar', () => {
  it('lets terms and years overlap each other but not their own kind (active ones)', async () => {
    await term('year', '2026-08-15', '2027-08-14');
    await term('term', '2026-08-24', '2026-12-18');
    await term('term', '2027-01-18', '2027-05-14');
    await expect(term('term', '2026-12-18', '2027-02-01')).rejects.toThrow(/overlaps another one/);   // touching days overlap
    await expect(term('year', '2027-08-14', '2028-08-13')).rejects.toThrow(/overlaps another one/);
    await term('term', '2026-12-19', '2027-01-17');          // fits exactly between
    await term('term', '2026-09-01', '2026-10-01', 'dropped', ids.a!, false);   // an inactive one overlaps nothing
    await term('term', '2026-08-24', '2026-12-18', 'Fall 2026', ids.b!);        // another institution has its own calendar
  });

  it('checks the dates and the name, and re-checks overlap on update', async () => {
    await expect(term('term', '2030-02-01', '2030-01-01')).rejects.toThrow(/academic_term_dates_check/);
    await expect(term('term', '2030-01-01', '2030-02-01', '  ')).rejects.toThrow(/academic_term_name_check/);
    await expect(term('semester', '2030-01-01', '2030-02-01')).rejects.toThrow(/academic_term_kind_check/);
    await expect(q(`update academic_term set active = true where name = 'dropped'`)).rejects.toThrow(/overlaps another one/);
  });

  it('is isolated by institution, never written by the worker, and audited', async () => {
    expect((await db.as(asA, (c) => c.query(`select id from academic_term`))).rows.length).toBe(5);
    expect((await db.as(asB, (c) => c.query(`select id from academic_term`))).rows.length).toBe(1);
    expect((await db.as(asB, (c) => c.query(`update academic_term set name = 'x' where institution_id = $1`, [ids.a]))).rowCount).toBe(0);
    expect((await db.as({ ...asA, role: 'ams_worker' }, (c) => c.query(`select id from academic_term`))).rows.length).toBe(5);
    await expect(db.as({ ...asA, role: 'ams_worker' }, (c) => c.query(`delete from academic_term`))).rejects.toThrow(/permission denied/);
    await expect(db.as(asB, (c) => c.query(`insert into academic_term (institution_id, name, kind, start_date, end_date) values ($1, 'x', 'term', '2031-01-01', '2031-02-01')`, [ids.a]))).rejects.toThrow(/row-level security/);
    expect((await q(`select count(*)::int as n from audit_event where target_type = 'academic_term'`)).rows[0].n).toBeGreaterThan(0);
  });
});

describe('cycle plans', () => {
  it('names an anchor in the shape its kind needs', async () => {
    await plan();                                                                          // a program
    await plan({ kind: 'institution', anchor: ids.a });
    await plan({ kind: 'evidence_item', anchor: ids.evA });
    await plan({ kind: 'framework', anchor: null, fw: ids.fwA });                           // a whole standard
    await plan({ kind: 'requirement', anchor: null, fw: ids.fwA, code: 'Q1' });             // a requirement by standard and code
    await expect(plan({ kind: 'requirement', anchor: null, fw: ids.fwA, code: null })).rejects.toThrow(/cycle_plan_anchor_check/);
    await expect(plan({ kind: 'requirement', anchor: ids.progA, fw: ids.fwA, code: 'Q2' })).rejects.toThrow(/cycle_plan_anchor_check/);
    await expect(plan({ kind: 'program', anchor: null })).rejects.toThrow(/cycle_plan_anchor_check|anchor must be a program/);
    await expect(plan({ kind: 'galaxy', anchor: ids.progA })).rejects.toThrow(/cycle_plan_anchor_kind_check/);
  });

  it('holds one plan per anchor and template, an own plan needs a recurrence and a first start, an opt-out does not', async () => {
    await expect(plan()).rejects.toThrow(/cycle_plan_anchor_idx/);
    await expect(plan({ kind: 'requirement', anchor: null, fw: ids.fwA, code: 'Q1' })).rejects.toThrow(/cycle_plan_anchor_idx/);
    await expect(plan({ kind: 'requirement', anchor: null, fw: ids.fwA, code: 'Q3', rec: null })).rejects.toThrow(/cycle_plan_own_check/);
    await expect(plan({ kind: 'requirement', anchor: null, fw: ids.fwA, code: 'Q3', first: null })).rejects.toThrow(/cycle_plan_own_check/);
    await plan({ kind: 'requirement', anchor: null, fw: ids.fwA, code: 'Q3', rec: null, first: null, mode: 'opt_out' });
    await expect(plan({ kind: 'requirement', anchor: null, fw: ids.fwA, code: 'Q3', mode: 'maybe' })).rejects.toThrow(/cycle_plan_mode_check/);
  });

  it('names things of its own institution only', async () => {
    await expect(plan({ tpl: ids.tplB })).rejects.toThrow(/anchor_idx|template must be one of the same institution/);
    await expect(plan({ kind: 'evidence_item', anchor: ids.evA, tpl: ids.tplB })).rejects.toThrow(/template must be one of the same institution/);
    await expect(plan({ kind: 'program', anchor: ids.progB })).rejects.toThrow(/anchor must be a program of the same institution/);
    await expect(plan({ kind: 'org_unit', anchor: ids.unitB })).rejects.toThrow(/anchor must be a unit of the same institution/);
    await expect(plan({ kind: 'institution', anchor: ids.b })).rejects.toThrow(/anchor must be the institution itself/);
    await expect(plan({ kind: 'evidence_item', anchor: ids.progA })).rejects.toThrow(/anchor must be an evidence item of the same institution/);
    await expect(plan({ kind: 'framework', anchor: null, fw: ids.fwB })).rejects.toThrow(/standard must be one of the same institution/);
    await expect(plan({ kind: 'org_unit', anchor: ids.unitA, unit: ids.unitB })).rejects.toThrow(/responsible unit must be a unit of the same institution/);
    await expect(plan({ kind: 'org_unit', anchor: ids.unitA, owner: ids.ub })).rejects.toThrow(/owner must be a person of the same institution/);
    await expect(plan({ kind: 'org_unit', anchor: ids.unitA, applies: JSON.stringify({ ids: [ids.progB] }) })).rejects.toThrow(/apply only to units and programs of the same institution/);
    await plan({ kind: 'org_unit', anchor: ids.unitA, applies: JSON.stringify({ kinds: ['program'], ids: [ids.progA, ids.unitA] }), unit: ids.unitA, owner: ids.ua });
  });

  it('is isolated by institution, never written by the worker, and audited', async () => {
    expect((await db.as(asB, (c) => c.query(`select id from cycle_plan`))).rows).toEqual([]);
    expect((await db.as({ ...asA, role: 'ams_worker' }, (c) => c.query(`select id from cycle_plan`))).rows.length).toBeGreaterThan(0);
    await expect(db.as({ ...asA, role: 'ams_worker' }, (c) => c.query(`update cycle_plan set active = false`))).rejects.toThrow(/permission denied/);
    await expect(db.as({ ...asA, role: 'ams_worker' }, (c) => c.query(`insert into cycle_plan_skip (institution_id, plan_id, period_start, reason) values ($1, gen_random_uuid(), '2026-01-01', 'x')`, [ids.a]))).rejects.toThrow(/permission denied/);
    await expect(db.as(asB, (c) => c.query(`insert into cycle_plan (institution_id, anchor_kind, anchor_id, template_id, recurrence, first_start) values ($1, 'program', $2, $3, '{}', '2026-01-01')`, [ids.a, ids.progA, ids.tplA]))).rejects.toThrow(/row-level security|same institution/);
    expect((await q(`select count(*)::int as n from audit_event where target_type = 'cycle_plan'`)).rows[0].n).toBeGreaterThan(0);
  });
});

describe('skipped periods and runs made by a plan', () => {
  const skip = (kind: string | null, id: string | null, start = '2026-08-24', reason = 'no students', planId = ids.plan!) => q(
    `insert into cycle_plan_skip (institution_id, plan_id, subject_kind, subject_id, period_start, reason) values ($1, $2, $3, $4, $5, $6) returning id`, [ids.a, planId, kind, id, start, reason]);

  it('records a skip once per plan, subject and period, with a reason', async () => {
    ids.plan = (await q(`select id from cycle_plan where anchor_kind = 'evidence_item'`)).rows[0].id;
    await skip('program', ids.progA!);
    await expect(skip('program', ids.progA!)).rejects.toThrow(/cycle_plan_skip_idx/);
    await skip('program', ids.progA!, '2027-01-18');
    await skip(null, null, '2027-01-18');
    await expect(skip(null, null, '2027-01-18')).rejects.toThrow(/cycle_plan_skip_idx/);
    await expect(skip('program', ids.progA!, '2028-01-01', '   ')).rejects.toThrow(/cycle_plan_skip_reason_check/);
    await expect(skip('program', null, '2028-01-01')).rejects.toThrow(/cycle_plan_skip_subject_pair_check/);
    await expect(skip('course', ids.progA!, '2028-01-01')).rejects.toThrow(/cycle_plan_skip_subject_kind_check/);
  });

  it('belongs to a plan of the same institution', async () => {
    const theirs = (await plan({ inst: ids.b, kind: 'program', anchor: ids.progB, tpl: ids.tplB })).rows[0].id;
    await expect(skip('program', ids.progA!, '2029-01-01', 'x', theirs)).rejects.toThrow(/plan must be one of the same institution/);
    expect((await db.as(asB, (c) => c.query(`select id from cycle_plan_skip`))).rows).toEqual([]);
  });

  it('a cycle names its plan and the period it covers, both or neither, and a plan of its own institution', async () => {
    const cyc = (planId: string | null, period: string | null, inst = ids.a!, unit = ids.unitA!, user = ids.ua!) => q(
      `insert into cycle (institution_id, title, anchor_kind, anchor_id, responsible_unit_id, lead_user_id, start_date, plan_id, period_start)
       values ($1, 'c', 'program', $2, $3, $4, '2026-08-24', $5, $6) returning id`, [inst, ids.progA, unit, user, planId, period]);
    await cyc(null, null);
    await cyc(ids.plan!, '2026-08-24');
    await expect(cyc(ids.plan!, null)).rejects.toThrow(/cycle_plan_period_check/);
    const theirs = (await q(`select id from cycle_plan where institution_id = $1`, [ids.b])).rows[0].id;
    await expect(cyc(theirs, '2026-08-24')).rejects.toThrow(/plan must be one of the same institution/);
    await expect(q(`delete from cycle_plan where id = $1`, [ids.plan])).rejects.toThrow(/foreign key|cycle_plan_id_fk|violates/);
  });
});
