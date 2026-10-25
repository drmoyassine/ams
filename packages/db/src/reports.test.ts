// The report tables' rules (TASK-091): a report starts as a draft; what it was made from never changes; it can only move
// draft -> internally approved -> submitted, and internal approval needs every section approved; a section's shape is
// frozen, its content changes only while the report is a draft and the section is draft or returned; a narrative's word
// count is recomputed by the database. The worker role reads reports and writes none (DEC-006).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;

async function one(sql: string, params: unknown[] = []): Promise<string> {
  const { rows } = await db.su.query(sql, params);
  return rows[0]!.id as string;
}

const STRUCTURE = {
  sections: [
    { key: 'intro', title: 'Introduction', block_type: 'narrative', requirement_codes: ['1.1'], word_limit: 500 },
    { key: 'data', title: 'Data', block_type: 'data_table', columns: [{ key: 'name', label: 'Name', type: 'text' }] },
  ],
};

beforeAll(async () => {
  db = await createTestDb('reports');
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  const user = (email: string) => one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, email]);
  ids.owner = await user('owner@x.org');
  ids.other = await user('other@y.org');
  ids.accreditor = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'WSCUC', 'WSCUC', 'institutional') returning id`, [ids.inst]);
  ids.framework = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'WSCUC 2024', 'institution') returning id`, [ids.inst, ids.accreditor]);
  ids.version = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2024') returning id`, [ids.inst, ids.framework]);
  ids.req1 = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, '1.1', 'Standard', 'Mission') returning id`, [ids.inst, ids.version]);
  ids.req2 = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, '1.2', 'Standard', 'Integrity') returning id`, [ids.inst, ids.version]);
  ids.template = await one(
    `insert into report_template (institution_id, framework_version_id, key, name, kind, structure, review_status) values ($1, $2, 'self_study', 'Self-Study Report', 'self_study', $3, 'approved') returning id`,
    [ids.inst, ids.version, JSON.stringify(STRUCTURE)]);
  // An engagement runs on a published edition (its trigger says so), so publish the version once its parts are in.
  await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [ids.version]);
  await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [ids.version, ids.owner]);
  // The lead check is deferred, so the engagement and its lead assignment go in one statement.
  await db.su.query(
    `with e as (insert into engagement (institution_id, framework_version_id, subject_type, subject_id, kind, title, review_year, lead_user_id) values ($1, $2, 'institution', $1, 'initial', 'Initial Accreditation 2026', 2026, $3) returning id, institution_id, lead_user_id)
     insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) select institution_id, lead_user_id, 'engagement_lead', 'engagement', id from e`,
    [ids.inst, ids.version, ids.other]);
  ids.engagement = await one(`select id from engagement where title = 'Initial Accreditation 2026'`);
  await db.su.query(`insert into engagement_requirement (institution_id, engagement_id, requirement_id, owner_id) values ($1, $2, $3, $4)`, [ids.inst, ids.engagement, ids.req1, ids.owner]);
  ids.report = await one(
    `insert into report (institution_id, title, framework_version_id, template_id, template_key, template_name, kind, engagement_id, round) values ($1, 'Self-Study Report', $2, $3, 'self_study', 'Self-Study Report', 'self_study', $4, 1) returning id`,
    [ids.inst, ids.version, ids.template, ids.engagement]);
  await db.su.query(
    `insert into report_section (institution_id, report_id, key, title, block_type, display_order, content, word_limit) values ($1, $2, 'intro', 'Introduction', 'narrative', 0, '{}'::jsonb, 500)`,
    [ids.inst, ids.report]);
  await db.su.query(
    `insert into report_section (institution_id, report_id, key, title, block_type, display_order, content, columns) values ($1, $2, 'data', 'Data', 'data_table', 1, '{}'::jsonb, $3::jsonb)`,
    [ids.inst, ids.report, JSON.stringify([{ key: 'name', label: 'Name', type: 'text' }])]);
  ids.section = await one(`select id from report_section where report_id = $1 and key = 'intro'`, [ids.report]);
  ids.table = await one(`select id from report_section where report_id = $1 and key = 'data'`, [ids.report]);
}, 60000);
afterAll(() => db.close());

const fails = async (sql: string, params: unknown[], message: string) => {
  await expect(db.su.query(sql, params)).rejects.toThrow(message);
};

describe('report rules', () => {
  it('a report starts as a draft', async () => {
    await fails(
      `insert into report (institution_id, title, framework_version_id, template_id, template_key, template_name, kind, engagement_id, status) values ($1, 'x', $2, $3, 'self_study', 'n', 'self_study', $4, 'internally_approved')`,
      [ids.inst, ids.version, ids.template, ids.engagement], 'a report starts as a draft');
  });

  it('one report per template and round', async () => {
    await fails(
      `insert into report (institution_id, title, framework_version_id, template_id, template_key, template_name, kind, engagement_id, round) values ($1, 'again', $2, $3, 'self_study', 'n', 'self_study', $4, 1)`,
      [ids.inst, ids.version, ids.template, ids.engagement], 'report_engagement_template_round_idx');
  });

  it('what a report was made from cannot change; the title can', async () => {
    await fails(`update report set round = 2 where id = $1`, [ids.report], 'what a report was made from cannot change');
    await fails(`update report set requires_attestation = true where id = $1`, [ids.report], 'what a report was made from cannot change');
    await db.su.query(`update report set title = 'Self-Study 2026' where id = $1`, [ids.report]);
  });

  it('a narrative gets its word count from the database; other blocks get null', async () => {
    await db.su.query(`update report_section set content = $2::jsonb where id = $1`, [ids.section, JSON.stringify({ text: 'Hello brave new world ' })]);
    const { rows } = await db.su.query(`select word_count from report_section where id = $1`, [ids.section]);
    expect(rows[0]!.word_count).toBe(4);
    const t = await db.su.query(`select word_count from report_section where id = $1`, [ids.table]);
    expect(t.rows[0]!.word_count).toBeNull();
  });

  it('the shape of a section is frozen', async () => {
    await fails(`update report_section set block_type = 'appendix' where id = $1`, [ids.section], 'cannot change');
    await fails(`update report_section set key = 'other' where id = $1`, [ids.section], 'cannot change');
    await fails(`update report_section set title = 'Renamed' where id = $1`, [ids.section], 'cannot change');
  });

  it('a section owner must be a person of the same institution', async () => {
    const inst2 = await one(`insert into institution (name_en) values ('Desert College') returning id`);
    const stranger = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'stranger', 's@z.org') returning id`, [inst2]);
    await fails(`update report_section set owner_id = $2 where id = $1`, [ids.section, stranger], 'same institution');
    await db.su.query(`update report_section set owner_id = $2 where id = $1`, [ids.section, ids.owner]);
  });

});

describe('section and report lifecycle', () => {
  it('sections are added and removed only while the report is a draft', async () => {
    // A second report of the same template stays draft here.
    ids.report2 = await one(
      `insert into report (institution_id, title, framework_version_id, template_id, template_key, template_name, kind, engagement_id, round) values ($1, 'Self-Study Round 2', $2, $3, 'self_study', 'Self-Study Report', 'self_study', $4, 2) returning id`,
      [ids.inst, ids.version, ids.template, ids.engagement]);
    const extra = await one(
      `insert into report_section (institution_id, report_id, key, title, block_type, display_order, content) values ($1, $2, 'extra', 'Extra', 'narrative', 9, '{"text": "one two"}'::jsonb) returning id`,
      [ids.inst, ids.report2]);
    ids.extra = extra;
    const wc = await db.su.query(`select word_count from report_section where id = $1`, [extra]);
    expect(wc.rows[0]!.word_count).toBe(2);
    // A draft report's sections can still be removed; the round-1 report is a draft, so its table section can go (and come back).
    await db.su.query(`delete from report_section where id = $1`, [ids.table]);
    ids.table = await one(
      `insert into report_section (institution_id, report_id, key, title, block_type, display_order, content, columns) values ($1, $2, 'data', 'Data', 'data_table', 1, '{}'::jsonb, $3::jsonb) returning id`,
      [ids.inst, ids.report, JSON.stringify([{ key: 'name', label: 'Name', type: 'text' }])]);
    // Once the report leaves the draft, its sections are fixed.
    await db.su.query(`update report_section set status = 'in_review' where id = $1`, [extra]);
    await db.su.query(`update report_section set status = 'approved' where id = $1`, [extra]);
    await db.su.query(`update report set status = 'internally_approved' where id = $1`, [ids.report2]);
    await fails(
      `insert into report_section (institution_id, report_id, key, title, block_type, display_order, content) values ($1, $2, 'more', 'More', 'narrative', 8, '{}'::jsonb)`,
      [ids.inst, ids.report2], 'the sections of a report are fixed once it leaves the draft');
    await fails(`delete from report_section where id = $1`, [extra], 'the sections of a report are fixed once it leaves the draft');
  });

  it('content changes only while the report is a draft and the section is draft or returned', async () => {
    // report2 is internally approved: no writing in its sections, whatever their own state.
    await fails(`update report_section set content = $2::jsonb where id = $1`, [ids.extra, JSON.stringify({ text: 'no' })], 'written while the report is a draft');
    // In a draft report the section must be draft or returned to write: in_review is closed.
    await db.su.query(`update report_section set status = 'in_review' where id = $1`, [ids.section]);
    await fails(`update report_section set content = $2::jsonb where id = $1`, [ids.section, JSON.stringify({ text: 'reviewed' })], 'written while the report is a draft');
    await db.su.query(`update report_section set status = 'returned' where id = $1`, [ids.section]);
    await db.su.query(`update report_section set content = $2::jsonb where id = $1`, [ids.section, JSON.stringify({ text: 'revised words' })]);
    await fails(`update report_section set status = 'approved' where id = $1`, [ids.section], 'cannot become');
    await db.su.query(`update report_section set status = 'in_review' where id = $1`, [ids.section]);
    await db.su.query(`update report_section set status = 'approved' where id = $1`, [ids.section]);
    await db.su.query(`update report_section set status = 'draft' where id = $1`, [ids.section]); // approved -> draft reopens
    await fails(`update report_section set status = 'returned' where id = $1`, [ids.section], 'cannot become');
  });

  it('internal approval needs every section approved; submission stamps and the report never goes back', async () => {
    await fails(`update report set status = 'submitted' where id = $1`, [ids.report], 'cannot become'); // draft -> submitted is not a move
    await fails(`update report set status = 'internally_approved' where id = $1`, [ids.report], 'every section is approved');
    for (const id of [ids.section, ids.table]) {
      await db.su.query(`update report_section set status = 'in_review' where id = $1`, [id]);
      await db.su.query(`update report_section set status = 'approved' where id = $1`, [id]);
    }
    await fails(`update report set status = 'draft' where id = $1`, [ids.report2], 'cannot become'); // approved stays
    await db.as({ userId: ids.other, institutionId: ids.inst }, async (c) => {
      await c.query(`update report set status = 'internally_approved' where id = $1`, [ids.report]);
      expect((await c.query(`select approved_by from report where id = $1`, [ids.report])).rows[0]!.approved_by).toBe(ids.other);
      await c.query(`update report set status = 'submitted' where id = $1`, [ids.report]);
      const done = await c.query(`select submitted_by, submitted_at is not null as s from report where id = $1`, [ids.report]);
      expect(done.rows[0]!.submitted_by).toBe(ids.other);
      expect(done.rows[0]!.s).toBe(true);
    });
    await fails(`update report set status = 'draft' where id = $1`, [ids.report], 'cannot become');
    await fails(`update report_section set content = $2::jsonb where id = $1`, [ids.section, JSON.stringify({ text: 'late' })], 'written while the report is a draft');
  });

  it('the worker role reads reports and writes none (DEC-006)', async () => {
    const read = await db.as({ role: 'ams_worker', institutionId: ids.inst }, async (c) =>
      (await c.query(`select count(*)::int as n from report`)).rows[0]!.n);
    expect(read).toBe(2);
    await db.as({ role: 'ams_worker', userId: ids.other, institutionId: ids.inst }, async (c) => {
      await expect(c.query(`update report set title = 'worker' where id = $1`, [ids.report])).rejects.toThrow();
      await expect(c.query(
        `insert into report_section (institution_id, report_id, key, title, block_type, display_order, content) values ($1, $2, 'w', 'W', 'narrative', 9, '{}'::jsonb)`,
        [ids.inst, ids.report])).rejects.toThrow();
    });
  });
});
