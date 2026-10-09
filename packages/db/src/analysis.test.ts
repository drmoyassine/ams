// Framework analysis (0039): analysis_run isolation, what the worker may draft, and the person-edit marker (DEC-022).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const worker = () => ({ userId: ids.user, institutionId: ids.inst, role: 'ams_worker' as const });
const app = () => ({ userId: ids.user, institutionId: ids.inst });

async function version(edition: string) {
  const v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, $3) returning id`, [ids.inst, ids.fw, edition]);
  const d = await one(`insert into source_document (institution_id, framework_version_id, title, role, authority, file_path, sha256) values ($1, $2, 'Doc', 'standards', 'binding', 'p', $3) returning id`, [ids.inst, v, 'c'.repeat(64)]);
  return { v, d };
}
const aiReq = (v: string, d: string, code: string) =>
  `insert into requirement (institution_id, framework_version_id, code, level_label, title, origin, source_document_id, source_page, source_quote) values ('${ids.inst}', '${v}', '${code}', 'Standard', 't', 'ai', '${d}', 1, 'q') returning id`;

beforeAll(async () => {
  db = await createTestDb('analysis');
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('V') returning id`);
  ids.user = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'A', 'a@x.org') returning id`, [ids.inst]);
  ids.otherUser = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'B', 'b@x.org') returning id`, [ids.other]);
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'A', 'A', 'institutional') returning id`, [ids.inst]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'F', 'institution') returning id`, [ids.inst, acc]);
});
afterAll(() => db.close());

describe('analysis_run', () => {
  it('is isolated per institution, at most one active per version, and the worker cannot revive an ended run', async () => {
    const { v } = await version('runs');
    const run = await db.as(app(), async (c) => (await c.query(`insert into analysis_run (institution_id, framework_version_id) values ($1, $2) returning id`, [ids.inst, v])).rows[0].id as string);
    await expect(db.su.query(`insert into analysis_run (institution_id, framework_version_id) values ($1, $2)`, [ids.inst, v])).rejects.toThrow(/analysis_run_one_active_idx/);
    expect(await db.as({ userId: ids.otherUser, institutionId: ids.other }, async (c) => (await c.query(`select id from analysis_run`)).rowCount)).toBe(0);
    await db.as(worker(), (c) => c.query(`update analysis_run set status = 'running', stage = 'survey' where id = $1`, [run]));
    await expect(db.as(worker(), (c) => c.query(`update analysis_run set started_by = null where id = $1`, [run]))).rejects.toThrow(/permission denied/);
    await db.as(app(), (c) => c.query(`update analysis_run set status = 'cancelled' where id = $1`, [run]));
    await expect(db.as(worker(), (c) => c.query(`update analysis_run set status = 'running' where id = $1`, [run]))).rejects.toThrow(/has ended/);
    await expect(db.su.query(`update analysis_run set stage = 'bogus' where id = $1`, [run])).rejects.toThrow(/analysis_run_stage_check/);
  });
});

describe('the worker drafting into a version', () => {
  it('adds unreviewed AI requirements and notes to a draft, and updates them while nobody has touched them', async () => {
    const { v, d } = await version('draft');
    const r = await db.as(worker(), async (c) => (await c.query(aiReq(v, d, 'A1'))).rows[0].id as string);
    await db.as(worker(), async (c) => {
      await c.query(`update requirement set title = 'better', official_text = 'words' where id = $1`, [r]);
      await c.query(`insert into requirement_note (institution_id, requirement_id, type, text, authority, origin) values ($1, $2, 'guidance', 'n', 'ai_suggested', 'ai')`, [ids.inst, r]);
    });
    const row = (await db.su.query(`select origin, review_status, edited_by_person from requirement where id = $1`, [r])).rows[0];
    expect(row).toEqual({ origin: 'ai', review_status: 'pending', edited_by_person: false });
  });

  it('never adds approved, manual or "required"-without-verified-quote items, and never approves or deletes', async () => {
    const { v, d } = await version('limits');
    const r = await db.as(worker(), async (c) => (await c.query(aiReq(v, d, 'B1'))).rows[0].id as string);
    for (const sql of [
      `insert into requirement (institution_id, framework_version_id, code, level_label, title, origin) values ('${ids.inst}', '${v}', 'M', 'x', 'x', 'manual')`,
      `insert into requirement (institution_id, framework_version_id, code, level_label, title, origin, review_status) values ('${ids.inst}', '${v}', 'P', 'x', 'x', 'ai', 'approved')`,
      `insert into requirement_note (institution_id, requirement_id, type, text, authority, origin) values ('${ids.inst}', '${r}', 'guidance', 'n', 'required', 'ai')`,
    ]) await expect(db.as(worker(), (c) => c.query(sql)), sql).rejects.toThrow(/integrity|only unreviewed|verified quote/);
    await expect(db.as(worker(), (c) => c.query(`update requirement set review_status = 'approved' where id = $1`, [r]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`delete from requirement where id = $1`, [r]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`update framework_version set status = 'published' where id = $1`, [v]))).rejects.toThrow(/permission denied/);
  });

  it('marks a person\'s edit, and then the worker cannot change that row', async () => {
    const { v, d } = await version('edited');
    const r = await db.as(worker(), async (c) => (await c.query(aiReq(v, d, 'C1'))).rows[0].id as string);
    await db.as(app(), (c) => c.query(`update requirement set title = 'mine' where id = $1`, [r]));
    expect((await db.su.query(`select edited_by_person from requirement where id = $1`, [r])).rows[0].edited_by_person).toBe(true);
    await expect(db.as(worker(), (c) => c.query(`update requirement set title = 'ai again' where id = $1`, [r]))).rejects.toThrow(/a person made, edited or reviewed/);
  });

  it('writes only into a draft: in review and published versions are refused (the frozen trigger is unchanged)', async () => {
    const { v, d } = await version('review');
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [v]);
    await expect(db.as(worker(), (c) => c.query(aiReq(v, d, 'D1')))).rejects.toThrow(/only into a draft/);
    await expect(db.as(worker(), (c) => c.query(`update framework_version set level_labels = '["X"]' where id = $1`, [v]))).rejects.toThrow(/only into a draft/);
    await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [v, ids.user]);
    await expect(db.as(worker(), (c) => c.query(aiReq(v, d, 'D2')))).rejects.toThrow(/immutable/);
  });

  it('sets a source\'s role only when no person chose it', async () => {
    const { v, d } = await version('roles');
    await db.as(worker(), (c) => c.query(`update framework_version set level_labels = '["Standard"]' where id = $1`, [v]));
    await expect(db.as(worker(), (c) => c.query(`update source_document set role = 'guidance', role_origin = 'ai' where id = $1`, [d]))).rejects.toThrow(/a person chose the role/);
    await db.su.query(`update source_document set role_origin = 'unset' where id = $1`, [d]);
    await db.as(worker(), (c) => c.query(`update source_document set role = 'guidance', role_origin = 'ai' where id = $1`, [d]));
    expect((await db.su.query(`select role, role_origin from source_document where id = $1`, [d])).rows[0]).toEqual({ role: 'guidance', role_origin: 'ai' });
  });
});

describe('deletions the analysis remembers (0041, step D)', () => {
  it('records a person\'s deletion of an AI requirement or note, never of their own rows, and keeps the record to itself', async () => {
    const { v, d } = await version('dismiss');
    const r = await db.as(worker(), async (c) => (await c.query(aiReq(v, d, 'E1'))).rows[0].id as string);
    const n = await db.as(worker(), async (c) => (await c.query(`insert into requirement_note (institution_id, requirement_id, type, text, authority, origin) values ($1, $2, 'guidance', 'Keep the minutes.', 'ai_suggested', 'ai') returning id`, [ids.inst, r])).rows[0].id as string);
    const mine = await db.as(app(), async (c) => (await c.query(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, 'E2', 'Standard', 'mine') returning id`, [ids.inst, v])).rows[0].id as string);
    await db.as(app(), async (c) => {
      await c.query(`delete from requirement_note where id = $1`, [n]);
      await c.query(`delete from requirement where id = any($1)`, [[r, mine]]);
    });
    const rows = (await db.su.query(`select kind, code, note_text, institution_id, created_by from analysis_dismissal where framework_version_id = $1 order by kind`, [v])).rows;
    expect(rows).toEqual([
      { kind: 'note', code: 'E1', note_text: 'Keep the minutes.', institution_id: ids.inst, created_by: ids.user },
      { kind: 'requirement', code: 'E1', note_text: null, institution_id: ids.inst, created_by: ids.user },
    ]);
    // Read by the worker, invisible to other institutions, and never changed or removed by the app.
    expect(await db.as(worker(), async (c) => (await c.query(`select id from analysis_dismissal where framework_version_id = $1`, [v])).rowCount)).toBe(2);
    expect(await db.as({ userId: ids.otherUser, institutionId: ids.other }, async (c) => (await c.query(`select id from analysis_dismissal`)).rowCount)).toBe(0);
    await expect(db.as(app(), (c) => c.query(`delete from analysis_dismissal where framework_version_id = $1`, [v]))).rejects.toThrow(/permission denied/);
    await expect(db.as(app(), (c) => c.query(`update analysis_dismissal set code = 'x' where framework_version_id = $1`, [v]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`insert into analysis_dismissal (institution_id, framework_version_id, kind, code) values ($1, $2, 'requirement', 'x')`, [ids.inst, v]))).rejects.toThrow(/permission denied/);
    await expect(db.su.query(`insert into analysis_dismissal (institution_id, framework_version_id, kind, code) values ($1, $2, 'note', 'x')`, [ids.inst, v])).rejects.toThrow(/note_text_check/);
  });

  it('knows the new stages and keeps the recovery rounds setting in range', async () => {
    const { v } = await version('stages');
    const run = await db.as(app(), async (c) => (await c.query(`insert into analysis_run (institution_id, framework_version_id, stage) values ($1, $2, 'gaps') returning id`, [ids.inst, v])).rows[0].id as string);
    await db.as(worker(), (c) => c.query(`update analysis_run set stage = 'recover' where id = $1`, [run]));
    await db.su.query(`insert into ai_setting (institution_id) values ($1)`, [ids.other]);
    expect((await db.su.query(`select max_recovery_rounds from ai_setting where institution_id = $1`, [ids.other])).rows[0].max_recovery_rounds).toBe(2);
    await expect(db.su.query(`update ai_setting set max_recovery_rounds = 6 where institution_id = $1`, [ids.other])).rejects.toThrow(/ai_setting_recovery_rounds_check/);
    await expect(db.su.query(`update ai_setting set max_recovery_rounds = -1 where institution_id = $1`, [ids.other])).rejects.toThrow(/ai_setting_recovery_rounds_check/);
  });
});
