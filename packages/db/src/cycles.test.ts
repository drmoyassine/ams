// Cycle rules in the database (TASK-078, migration 0059, DEC-029): tenant isolation, the worker cannot write, status moves, the
// shape is fixed once a cycle starts, a stage completes only when its required outputs are final, an approval is decided only by
// its named approver, a final output does not change, only drafts are deleted, the Trash accepts the new kind, and it is audited.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const q = (sql: string, p: unknown[] = []) => db.su.query(sql, p);
const asA = (who = 'ua') => ({ userId: ids[who]!, institutionId: ids.a! });

const newCycle = (inst = ids.a!, unit = ids.unit!, lead = ids.ua!) => one(
  `insert into cycle (institution_id, title, anchor_kind, anchor_id, responsible_unit_id, lead_user_id, start_date)
   values ($1, 'Annual report', 'org_unit', $2, $3, $4, '2026-09-01') returning id`, [inst, unit, unit, lead]);
const newStage = (cycle: string, key: string, order = 0, unit = ids.unit!) => one(
  `insert into cycle_stage (institution_id, cycle_id, key, name, display_order, responsible_unit_id) values ($1, $2, $3, $3, $4, $5) returning id`,
  [ids.a, cycle, key, order, unit]);
const newOutput = (stage: string, key: string, kind: string, extra: Record<string, unknown> = {}) => one(
  `insert into cycle_output (institution_id, stage_id, key, name, kind, required, approver_user_id) values ($1, $2, $3, $3, $4, $5, $6) returning id`,
  [ids.a, stage, key, kind, extra.required ?? true, extra.approver ?? null]);

beforeAll(async () => {
  db = await createTestDb('cycles');
  ids.a = await one(`insert into institution (name_en) values ('A') returning id`);
  ids.b = await one(`insert into institution (name_en) values ('B') returning id`);
  ids.ua = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ua', 'ua') returning id`, [ids.a]);
  ids.ua2 = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ua2', 'ua2') returning id`, [ids.a]);
  ids.ub = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ub', 'ub') returning id`, [ids.b]);
  ids.unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'C') returning id`, [ids.a]);
  ids.unitB = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'CB') returning id`, [ids.b]);
}, 60000);
afterAll(async () => { await db.close(); });

describe('tenants and roles', () => {
  it('keeps each institution to its own cycles, stages, outputs, inputs and templates', async () => {
    const c = await newCycle();
    const s = await newStage(c, 'collect');
    const o = await newOutput(s, 'report', 'note');
    await q(`insert into cycle_input (institution_id, stage_id, key, name, source, pick_kind) values ($1, $2, 'ev', 'Evidence', 'pick', 'any')`, [ids.a, s]);
    await q(`insert into cycle_template (institution_id, key, name) values ($1, 't', 'T')`, [ids.a]);
    for (const t of ['cycle', 'cycle_stage', 'cycle_output', 'cycle_input', 'cycle_template']) {
      const mine = await db.as(asA(), (cl) => cl.query(`select institution_id from ${t}`));
      expect(mine.rows.length, t).toBeGreaterThan(0);
      const theirs = await db.as({ userId: ids.ub!, institutionId: ids.b! }, (cl) => cl.query(`select id from ${t}`));
      expect(theirs.rows, t).toEqual([]);
    }
    const upd = await db.as({ userId: ids.ub!, institutionId: ids.b! }, (cl) => cl.query(`update cycle set title = 'x' where id = $1`, [c]));
    expect(upd.rowCount).toBe(0);
    await expect(db.as({ userId: ids.ub!, institutionId: ids.b! }, (cl) => cl.query(
      `insert into cycle (institution_id, title, anchor_kind, anchor_id, responsible_unit_id, lead_user_id, start_date) values ($1, 'x', 'org_unit', $2, $2, $3, '2026-01-01')`, [ids.a, ids.unitB, ids.ub]))).rejects.toThrow(/row-level security|same institution/);
    expect(o).toBeTruthy();
  });

  it('refuses to name a person, unit, template or previous cycle of another institution', async () => {
    const ins = (lead: string, unit: string) => q(
      `insert into cycle (institution_id, title, anchor_kind, anchor_id, responsible_unit_id, lead_user_id, start_date) values ($1, 'x', 'org_unit', $2, $2, $3, '2026-01-01')`, [ids.a, unit, lead]).then(() => undefined);
    await expect(ins(ids.ub!, ids.unit!)).rejects.toThrow(/person of the same institution/);
    await expect(ins(ids.ua!, ids.unitB!)).rejects.toThrow(/unit of the same institution/);
    const c = await newCycle();
    const s = await newStage(c, 'x');
    await expect(q(`update cycle_stage set owner_user_id = $2 where id = $1`, [s, ids.ub])).rejects.toThrow(/person of the same institution/);
    const o = await newOutput(s, 'sign', 'approval');
    await expect(q(`update cycle_output set approver_user_id = $2 where id = $1`, [o, ids.ub])).rejects.toThrow(/person of the same institution/);
  });

  it('lets the worker read cycles but not write them', async () => {
    const w = { ...asA(), role: 'ams_worker' as const };
    const rows = await db.as(w, (cl) => cl.query(`select id from cycle`));
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const sql of [
      `insert into cycle (institution_id, title, anchor_kind, anchor_id, responsible_unit_id, lead_user_id, start_date) values ('${ids.a}', 'w', 'org_unit', '${ids.unit}', '${ids.unit}', '${ids.ua}', '2026-01-01')`,
      `update cycle set title = 'w'`, `delete from cycle`, `update cycle_stage set name = 'w'`, `update cycle_output set note = 'w'`, `update cycle_input set name = 'w'`,
      `update cycle_template set name = 'w'`, `insert into cycle_template (institution_id, key, name) values ('${ids.a}', 'w', 'w')`,
    ]) await expect(db.as(w, (cl) => cl.query(sql)), sql).rejects.toThrow(/permission denied/);
  });
});

describe('the cycle', () => {
  it('keeps the value sets, the cancel reason, the dates and the subject pair', async () => {
    const c = await newCycle();
    await expect(q(`update cycle set anchor_kind = 'x' where id = $1`, [c])).rejects.toThrow();
    await expect(q(`insert into cycle (institution_id, title, anchor_kind, anchor_id, responsible_unit_id, lead_user_id, start_date) values ($1, 'x', 'bogus', $2, $2, $3, '2026-01-01')`, [ids.a, ids.unit, ids.ua])).rejects.toThrow(/cycle_anchor_kind_check/);
    await expect(q(`update cycle set end_date = '2026-01-01' where id = $1`, [c])).rejects.toThrow(/cycle_dates_check/);
    await expect(q(`update cycle set subject_kind = 'program' where id = $1`, [c])).rejects.toThrow(/cycle_subject_pair_check/);
    await expect(q(`update cycle set subject_kind = 'course', subject_id = $2 where id = $1`, [c, ids.unit])).rejects.toThrow(/cycle_subject_kind_check/);
    await expect(q(`update cycle set status = 'cancelled' where id = $1`, [c])).rejects.toThrow(/cycle_cancel_reason_check/);
    await q(`update cycle set status = 'cancelled', cancel_reason = 'merged into another' where id = $1`, [c]);
    await expect(q(`update cycle set title = 'again' where id = $1`, [c])).rejects.toThrow(/cancelled cycle cannot change/);
  });

  it('starts as a draft, needs a stage to start, and moves only along the allowed paths', async () => {
    await expect(q(`insert into cycle (institution_id, title, anchor_kind, anchor_id, responsible_unit_id, lead_user_id, start_date, status) values ($1, 'x', 'org_unit', $2, $2, $3, '2026-01-01', 'active')`, [ids.a, ids.unit, ids.ua])).rejects.toThrow(/starts as a draft/);
    const c = await newCycle();
    await expect(q(`update cycle set status = 'active' where id = $1`, [c])).rejects.toThrow(/at least one stage/);
    await expect(q(`update cycle set status = 'completed' where id = $1`, [c])).rejects.toThrow(/cannot go from draft to completed/);
    const s = await newStage(c, 'one');
    await q(`update cycle set status = 'active' where id = $1`, [c]);
    await expect(q(`update cycle set status = 'completed' where id = $1`, [c])).rejects.toThrow(/every stage is completed or skipped/);
    // Back to draft only while nothing has started.
    await q(`update cycle set status = 'draft' where id = $1`, [c]);
    await q(`update cycle set status = 'active' where id = $1`, [c]);
    await q(`update cycle_stage set status = 'skipped', skip_reason = 'not needed' where id = $1`, [s]);
    await expect(q(`update cycle set status = 'draft' where id = $1`, [c])).rejects.toThrow(/no stage has started/);
    await q(`update cycle set status = 'completed' where id = $1`, [c]);
    await q(`update cycle set status = 'active' where id = $1`, [c]);   // reopening a completed cycle
    await q(`update cycle set status = 'completed' where id = $1`, [c]);
    await q(`update cycle set status = 'cancelled', cancel_reason = 'withdrawn' where id = $1`, [c]);
    await expect(q(`update cycle set status = 'active' where id = $1`, [c])).rejects.toThrow(/cancelled cycle cannot change/);
  });

  it('never changes its anchor, template or previous cycle', async () => {
    const prev = await newCycle();
    const c = await one(`insert into cycle (institution_id, title, anchor_kind, anchor_id, responsible_unit_id, lead_user_id, start_date, previous_cycle_id) values ($1, 'x', 'org_unit', $2, $2, $3, '2026-01-01', $4) returning id`, [ids.a, ids.unit, ids.ua, prev]);
    await expect(q(`update cycle set anchor_id = gen_random_uuid() where id = $1`, [c])).rejects.toThrow(/never change/);
    await expect(q(`update cycle set previous_cycle_id = null where id = $1`, [c])).rejects.toThrow(/never change/);
    await expect(q(`update cycle set previous_cycle_id = id where id = $1`, [prev])).rejects.toThrow(/never change|cycle_previous_self_check/);
    // A cycle another builds on cannot go back to draft.
    const s = await newStage(prev, 'one');
    await q(`update cycle set status = 'active' where id = $1`, [prev]);
    await expect(q(`update cycle set status = 'draft' where id = $1`, [prev])).rejects.toThrow(/builds on this one/);
    expect(s).toBeTruthy();
  });

  it('deletes only a draft, and its parts first', async () => {
    const c = await newCycle();
    const s = await newStage(c, 'one');
    const o = await newOutput(s, 'n', 'note');
    await q(`insert into cycle_input (institution_id, stage_id, key, name, source, output_id) values ($1, $2, 'i', 'I', 'stage_output', $3)`, [ids.a, s, o]);
    await expect(q(`delete from cycle where id = $1`, [c])).rejects.toThrow(/foreign key/);
    await q(`delete from cycle_input where stage_id = $1`, [s]);
    await q(`delete from cycle_output where stage_id = $1`, [s]);
    await q(`delete from cycle_stage where id = $1`, [s]);
    await q(`delete from cycle where id = $1`, [c]);
    const started = await newCycle();
    await newStage(started, 'one');
    await q(`update cycle set status = 'active' where id = $1`, [started]);
    await expect(q(`delete from cycle where id = $1`, [started])).rejects.toThrow(/only a draft cycle can be deleted/);
  });
});

describe('stages', () => {
  it('are added and removed only while the cycle is a draft, and keep their key and cycle', async () => {
    const c = await newCycle();
    const s = await newStage(c, 'one');
    await expect(newStage(c, 'one', 1)).rejects.toThrow(/cycle_stage_key_idx/);
    await expect(q(`update cycle_stage set key = 'two' where id = $1`, [s])).rejects.toThrow(/never change/);
    await expect(q(`update cycle_stage set key = 'Bad Key' where id = $1`, [s])).rejects.toThrow();
    await q(`update cycle set status = 'active' where id = $1`, [c]);
    await expect(newStage(c, 'late', 1)).rejects.toThrow(/only while the cycle is a draft/);
    await expect(q(`delete from cycle_stage where id = $1`, [s])).rejects.toThrow(/only while the cycle is a draft/);
    await expect(q(`update cycle_stage set display_order = 5 where id = $1`, [s])).rejects.toThrow(/order of stages is fixed/);
    // Dates, owners and units may still change on a running cycle.
    await q(`update cycle_stage set owner_user_id = $2, start_date = '2026-09-01', end_date = '2026-09-30' where id = $1`, [s, ids.ua2]);
    await expect(q(`update cycle_stage set end_date = '2026-08-01' where id = $1`, [s])).rejects.toThrow(/cycle_stage_dates_check/);
  });

  it('move not_started -> in_progress -> completed, skip with a reason, and reopen', async () => {
    const c = await newCycle();
    const s = await newStage(c, 'one');
    await expect(q(`update cycle_stage set status = 'in_progress' where id = $1`, [s])).rejects.toThrow(/only while the cycle is active/);
    await q(`update cycle set status = 'active' where id = $1`, [c]);
    await expect(q(`update cycle_stage set status = 'completed' where id = $1`, [s])).rejects.toThrow(/cannot go from not_started to completed/);
    await expect(q(`update cycle_stage set status = 'skipped' where id = $1`, [s])).rejects.toThrow(/cycle_stage_skip_reason_check/);
    await q(`update cycle_stage set status = 'in_progress' where id = $1`, [s]);
    const started = (await q(`select started_at from cycle_stage where id = $1`, [s])).rows[0];
    expect(started.started_at).not.toBeNull();
    await q(`update cycle_stage set status = 'completed' where id = $1`, [s]);
    expect((await q(`select completed_at from cycle_stage where id = $1`, [s])).rows[0].completed_at).not.toBeNull();
    await q(`update cycle_stage set status = 'in_progress' where id = $1`, [s]);
    expect((await q(`select completed_at from cycle_stage where id = $1`, [s])).rows[0].completed_at).toBeNull();
    await q(`update cycle_stage set status = 'skipped', skip_reason = 'covered elsewhere' where id = $1`, [s]);
    await q(`update cycle_stage set status = 'not_started' where id = $1`, [s]);
    expect((await q(`select skip_reason from cycle_stage where id = $1`, [s])).rows[0].skip_reason).toBeNull();
  });

  it('complete only when every required output is final (an optional one may stay empty)', async () => {
    const c = await newCycle();
    const s = await newStage(c, 'one');
    const must = await newOutput(s, 'must', 'note');
    await newOutput(s, 'may', 'document', { required: false });
    await q(`update cycle set status = 'active' where id = $1`, [c]);
    await q(`update cycle_stage set status = 'in_progress' where id = $1`, [s]);
    await expect(q(`update cycle_stage set status = 'completed' where id = $1`, [s])).rejects.toThrow(/every required output is final/);
    await q(`update cycle_output set note = 'done', state = 'final' where id = $1`, [must]);
    await q(`update cycle_stage set status = 'completed' where id = $1`, [s]);
    await q(`update cycle set status = 'completed' where id = $1`, [c]);
    await expect(q(`update cycle_stage set owner_user_id = $2 where id = $1`, [s, ids.ua])).rejects.toThrow(/can no longer change/);
  });
});

describe('outputs', () => {
  async function running(kind: string, extra: Record<string, unknown> = {}) {
    const c = await newCycle();
    const s = await newStage(c, 'one');
    const o = await newOutput(s, 'out', kind, extra);
    await q(`update cycle set status = 'active' where id = $1`, [c]);
    return { c, s, o };
  }

  it('are filled only while their stage is in progress; final needs the content for its kind', async () => {
    const { s, o } = await running('note');
    await expect(q(`update cycle_output set note = 'x', state = 'draft' where id = $1`, [o])).rejects.toThrow(/start the stage/);
    await q(`update cycle_stage set status = 'in_progress' where id = $1`, [s]);
    await expect(q(`update cycle_output set state = 'final' where id = $1`, [o])).rejects.toThrow(/cycle_output_final_check/);
    await q(`update cycle_output set note = 'x', state = 'draft' where id = $1`, [o]);
    await q(`update cycle_output set state = 'final' where id = $1`, [o]);
    const row = (await q(`select finalised_by, finalised_at from cycle_output where id = $1`, [o])).rows[0];
    expect(row.finalised_at).not.toBeNull();
    // A final output does not change; reopened it does.
    await expect(q(`update cycle_output set note = 'y' where id = $1`, [o])).rejects.toThrow(/reopen it first/);
    await q(`update cycle_output set state = 'draft' where id = $1`, [o]);
    expect((await q(`select finalised_at from cycle_output where id = $1`, [o])).rows[0].finalised_at).toBeNull();
    await q(`update cycle_output set note = 'y' where id = $1`, [o]);
  });

  it('stamp who finalised from the session, not from the request', async () => {
    const { s, o } = await running('note');
    await q(`update cycle_stage set status = 'in_progress' where id = $1`, [s]);
    await db.as(asA('ua2'), (cl) => cl.query(`update cycle_output set note = 'z', state = 'final', finalised_by = $2 where id = $1`, [o, ids.ua]));
    expect((await q(`select finalised_by from cycle_output where id = $1`, [o])).rows[0].finalised_by).toBe(ids.ua2);
  });

  it('keep their shape: kind-specific columns, the key, and (after the draft) required and name', async () => {
    const { s: s0, o } = await running('note');
    await q(`update cycle_stage set status = 'in_progress' where id = $1`, [s0]);
    await expect(q(`update cycle_output set file_key = 'x' where id = $1`, [o])).rejects.toThrow(/cycle_output_file_kind_check/);
    await expect(q(`update cycle_output set kind = 'document' where id = $1`, [o])).rejects.toThrow(/never change/);
    await expect(q(`update cycle_output set required = false where id = $1`, [o])).rejects.toThrow(/fixed once the cycle has started/);
    await expect(q(`update cycle_output set decision = 'approved' where id = $1`, [o])).rejects.toThrow(/cycle_output_decision_kind_check|named approver/);
    await expect(q(`update cycle_output set approver_user_id = $2 where id = $1`, [o, ids.ua])).rejects.toThrow(/cycle_output_approver_kind_check/);
    await expect(q(`update cycle_output set report_id = gen_random_uuid() where id = $1`, [o])).rejects.toThrow(/cycle_output_report_kind_check/);
    const { s, o: doc } = await running('document');
    await q(`update cycle_stage set status = 'in_progress' where id = $1`, [s]);
    await q(`update cycle_output set file_key = 'k', file_name = 'a.pdf', file_mime = 'application/pdf', file_size = 3, state = 'final' where id = $1`, [doc]);
  });

  it('are decided only by the named approver; conditions and a return need a comment', async () => {
    const { s, o } = await running('approval', { approver: ids.ua });
    await q(`update cycle_stage set status = 'in_progress' where id = $1`, [s]);
    // The service-level actor is not the approver, and a session with no person at all is not either.
    await expect(db.as(asA('ua2'), (cl) => cl.query(`update cycle_output set decision = 'approved', state = 'final' where id = $1`, [o]))).rejects.toThrow(/only the named approver/);
    await expect(q(`update cycle_output set decision = 'approved', state = 'final' where id = $1`, [o])).rejects.toThrow(/only the named approver/);
    await expect(db.as(asA('ua'), (cl) => cl.query(`update cycle_output set decision = 'returned', state = 'draft' where id = $1`, [o]))).rejects.toThrow(/cycle_output_comment_check/);
    await expect(db.as(asA('ua'), (cl) => cl.query(`update cycle_output set decision = 'approved_with_conditions', decision_comment = '  ', state = 'final' where id = $1`, [o]))).rejects.toThrow(/cycle_output_comment_check/);
    // A returned approval is not final; the approver can decide again.
    await expect(db.as(asA('ua'), (cl) => cl.query(`update cycle_output set decision = 'returned', decision_comment = 'add data', state = 'final' where id = $1`, [o]))).rejects.toThrow(/cycle_output_final_check/);
    await db.as(asA('ua'), (cl) => cl.query(`update cycle_output set decision = 'returned', decision_comment = 'add data', state = 'draft' where id = $1`, [o]));
    await db.as(asA('ua'), (cl) => cl.query(`update cycle_output set decision = 'approved_with_conditions', decision_comment = 'by June', state = 'final' where id = $1`, [o]));
    const row = (await q(`select decision, finalised_by from cycle_output where id = $1`, [o])).rows[0];
    expect(row).toEqual({ decision: 'approved_with_conditions', finalised_by: ids.ua });
    // Signed off: the approver cannot be swapped out, and the decision does not change.
    await expect(q(`update cycle_output set approver_user_id = $2 where id = $1`, [o, ids.ua2])).rejects.toThrow(/cannot change its approver/);
    await expect(db.as(asA('ua'), (cl) => cl.query(`update cycle_output set decision = 'approved', decision_comment = null where id = $1`, [o]))).rejects.toThrow(/reopen it first/);
  });

  it('start empty, and are added or removed only in a draft', async () => {
    const c = await newCycle();
    const s = await newStage(c, 'one');
    await expect(q(`insert into cycle_output (institution_id, stage_id, key, name, kind, state) values ($1, $2, 'x', 'x', 'note', 'draft')`, [ids.a, s])).rejects.toThrow(/starts empty/);
    const o = await newOutput(s, 'x', 'note');
    await q(`delete from cycle_output where id = $1`, [o]);
    const o2 = await newOutput(s, 'y', 'note');
    await q(`update cycle set status = 'active' where id = $1`, [c]);
    await expect(newOutput(s, 'late', 'note')).rejects.toThrow(/only while the cycle is a draft/);
    await expect(q(`delete from cycle_output where id = $1`, [o2])).rejects.toThrow(/only while the cycle is a draft/);
  });
});

describe('inputs', () => {
  it('read an earlier output or a pick, never both, and are fixed once the cycle starts', async () => {
    const c = await newCycle();
    const s1 = await newStage(c, 'one');
    const s2 = await newStage(c, 'two', 1);
    const o = await newOutput(s1, 'out', 'note');
    await expect(q(`insert into cycle_input (institution_id, stage_id, key, name, source, output_id) values ($1, $2, 'a', 'A', 'pick', $3)`, [ids.a, s2, o])).rejects.toThrow(/cycle_input_pick_check/);
    await expect(q(`insert into cycle_input (institution_id, stage_id, key, name, source, output_id, ref_kind, ref_id) values ($1, $2, 'a', 'A', 'stage_output', $3, 'document', gen_random_uuid())`, [ids.a, s2, o])).rejects.toThrow(/cycle_input_pick_check/);
    await expect(q(`insert into cycle_input (institution_id, stage_id, key, name, source, ref_kind) values ($1, $2, 'a', 'A', 'pick', 'document')`, [ids.a, s2])).rejects.toThrow(/cycle_input_ref_pair_check/);
    const i = await one(`insert into cycle_input (institution_id, stage_id, key, name, source, output_id) values ($1, $2, 'a', 'A', 'stage_output', $3) returning id`, [ids.a, s2, o]);
    const pick = await one(`insert into cycle_input (institution_id, stage_id, key, name, source, pick_kind) values ($1, $2, 'p', 'P', 'pick', 'document') returning id`, [ids.a, s2]);
    await q(`update cycle set status = 'active' where id = $1`, [c]);
    await expect(q(`update cycle_input set output_id = null where id = $1`, [i])).rejects.toThrow(/wiring of an input is fixed/);
    await expect(q(`update cycle_input set source = 'pick' where id = $1`, [i])).rejects.toThrow(/never change/);
    await q(`update cycle_input set ref_kind = 'document', ref_id = gen_random_uuid() where id = $1`, [pick]);
    await expect(q(`delete from cycle_input where id = $1`, [i])).rejects.toThrow(/only while the cycle is a draft/);
  });
});

describe('templates', () => {
  it('keep a key, a version that only goes up, and do not change once published', async () => {
    const t = await one(`insert into cycle_template (institution_id, key, name, anchor_kinds, stages) values ($1, 'annual', 'Annual', array['org_unit','program'], '[]') returning id`, [ids.a]);
    await expect(q(`insert into cycle_template (institution_id, key, name) values ($1, 'annual', 'Dup')`, [ids.a])).rejects.toThrow(/cycle_template_key_idx/);
    await expect(q(`insert into cycle_template (institution_id, key, name) values ($1, 'Bad Key', 'x')`, [ids.a])).rejects.toThrow(/cycle_template_key_check/);
    await expect(q(`update cycle_template set anchor_kinds = array['galaxy'] where id = $1`, [t])).rejects.toThrow(/cycle_template_anchor_kinds_check/);
    await expect(q(`update cycle_template set stages = '{}'::jsonb where id = $1`, [t])).rejects.toThrow(/cycle_template_stages_check/);
    await expect(q(`update cycle_template set key = 'other' where id = $1`, [t])).rejects.toThrow(/never changes/);
    await expect(q(`update cycle_template set status = 'published' where id = $1`, [t])).rejects.toThrow(/cycle_template_version_check/);
    await q(`update cycle_template set status = 'published', version = 1 where id = $1`, [t]);
    await expect(q(`update cycle_template set stages = '[{"key":"x"}]' where id = $1`, [t])).rejects.toThrow(/revise it into a draft/);
    await expect(q(`update cycle_template set version = 0, status = 'draft' where id = $1`, [t])).rejects.toThrow(/never goes down/);
    await expect(q(`delete from cycle_template where id = $1`, [t])).rejects.toThrow(/never published/);
    await q(`update cycle_template set status = 'draft' where id = $1`, [t]);
    await q(`update cycle_template set stages = '[{"key":"x"}]' where id = $1`, [t]);
    const d = await one(`insert into cycle_template (institution_id, key, name) values ($1, 'scratch', 'S') returning id`, [ids.a]);
    await q(`delete from cycle_template where id = $1`, [d]);
  });
});

describe('the Trash and the audit trail', () => {
  it('accepts the cycle kind', async () => {
    await q(`insert into trash_item (institution_id, group_id, kind, label, payload, expires_at) values ($1, gen_random_uuid(), 'cycle', 'C', '{}'::jsonb, now() + interval '30 days')`, [ids.a]);
    await expect(q(`insert into trash_item (institution_id, group_id, kind, label, payload, expires_at) values ($1, gen_random_uuid(), 'bogus', 'C', '{}'::jsonb, now())`, [ids.a])).rejects.toThrow(/trash_item_kind_check/);
  });

  it('audits every change to every cycle table', async () => {
    for (const t of ['cycle', 'cycle_stage', 'cycle_output', 'cycle_input', 'cycle_template']) {
      const { rows } = await q(`select count(*)::int n from audit_event where target_type = $1`, [t]);
      expect(rows[0].n, t).toBeGreaterThan(0);
    }
  });
});
