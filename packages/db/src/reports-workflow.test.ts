// The workflow's database rules (TASK-094): every approve or return is kept and immutable (a returned needs its note);
// reopening an approved section sends an internally approved report back to draft in the same transaction — and the
// deferred trigger holds that even against a transaction that forgets; a submitted report lets nothing reopen; the
// submission snapshot is written once and never changed (PRD 6.9).
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
    { key: 'a', title: 'First', block_type: 'narrative', requirement_codes: ['1.1'] },
    { key: 'b', title: 'Second', block_type: 'narrative', requirement_codes: ['1.2'] },
  ],
};

beforeAll(async () => {
  db = await createTestDb('reports_workflow');
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  const user = (email: string) => one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, email]);
  ids.owner = await user('owner@x.org');
  ids.reviewer = await user('reviewer@x.org');
  ids.accreditor = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'WSCUC', 'WSCUC', 'institutional') returning id`, [ids.inst]);
  ids.framework = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'WSCUC 2024', 'institution') returning id`, [ids.inst, ids.accreditor]);
  ids.version = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2024') returning id`, [ids.inst, ids.framework]);
  ids.req1 = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, '1.1', 'Standard', 'Mission') returning id`, [ids.inst, ids.version]);
  ids.req2 = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, '1.2', 'Standard', 'Integrity') returning id`, [ids.inst, ids.version]);
  ids.template = await one(
    `insert into report_template (institution_id, framework_version_id, key, name, kind, structure, review_status) values ($1, $2, 'self_study', 'Self-Study Report', 'self_study', $3, 'approved') returning id`,
    [ids.inst, ids.version, JSON.stringify(STRUCTURE)]);
  await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [ids.version]);
  await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [ids.version, ids.owner]);
  await db.su.query(
    `with e as (insert into engagement (institution_id, framework_version_id, subject_type, subject_id, kind, title, review_year, lead_user_id) values ($1, $2, 'institution', $1, 'initial', 'Initial Accreditation 2026', 2026, $3) returning id, institution_id, lead_user_id)
     insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) select institution_id, lead_user_id, 'engagement_lead', 'engagement', id from e`,
    [ids.inst, ids.version, ids.reviewer]);
  ids.engagement = await one(`select id from engagement where title = 'Initial Accreditation 2026'`);
  ids.report = await one(
    `insert into report (institution_id, title, framework_version_id, template_id, template_key, template_name, kind, engagement_id, round) values ($1, 'Self-Study', $2, $3, 'self_study', 'Self-Study Report', 'self_study', $4, 1) returning id`,
    [ids.inst, ids.version, ids.template, ids.engagement]);
  ids.a = await one(
    `insert into report_section (institution_id, report_id, key, title, block_type, display_order, content, word_limit) values ($1, $2, 'a', 'First', 'narrative', 0, '{}'::jsonb, 500) returning id`,
    [ids.inst, ids.report]);
  ids.b = await one(
    `insert into report_section (institution_id, report_id, key, title, block_type, display_order, content, word_limit) values ($1, $2, 'b', 'Second', 'narrative', 1, '{}'::jsonb, 500) returning id`,
    [ids.inst, ids.report]);
}, 60000);
afterAll(() => db.close());

const fails = async (sql: string, params: unknown[], message: string) => {
  await expect(db.su.query(sql, params)).rejects.toThrow(message);
};

/** Approves a section: the decision is recorded, then the section moves. */
const approve = async (section: string | undefined) => {
  await db.su.query(`update report_section set status = 'in_review' where id = $1`, [section]);
  await db.su.query(
    `insert into report_section_decision (institution_id, section_id, decision, decided_by) values ($1, $2, 'approved', $3)`,
    [ids.inst, section, ids.reviewer]);
  await db.su.query(`update report_section set status = 'approved' where id = $1`, [section]);
};

describe('section decisions', () => {
  it('a returned decision carries a note; decisions are kept as they were made', async () => {
    await db.su.query(`update report_section set status = 'in_review' where id = $1`, [ids.a]);
    await fails(
      `insert into report_section_decision (institution_id, section_id, decision, decided_by) values ($1, $2, 'returned', $3)`,
      [ids.inst, ids.a, ids.reviewer], 'report_section_decision_note_check');
    const id = await one(
      `insert into report_section_decision (institution_id, section_id, decision, note, decided_by) values ($1, $2, 'returned', 'tighten the mission text', $3) returning id`,
      [ids.inst, ids.a, ids.reviewer]);
    try {
      await db.su.query(`update report_section_decision set note = 'changed my mind' where id = $1`, [id]);
      console.log('PROBE UPDATE RESOLVED');
    } catch (e) {
      console.log('PROBE UPDATE ERR:', (e as Error).message);
      const probe = await db.su.query(`select d.section_id, d.institution_id, exists(select 1 from report_section s where s.id = d.section_id and s.institution_id = d.institution_id) as ok from report_section_decision d where d.id = $1`, [id]);
      console.log('PROBE row:', JSON.stringify(probe.rows));
      const src = await db.su.query(`select prosrc from pg_proc where proname = 'report_section_decision_rules'`);
      console.log('PROBE fn:', (src.rows[0] as { prosrc: string }).prosrc.slice(0, 400));
    }
    await fails(`update report_section_decision set note = 'changed my mind' where id = $1`, [id], 'kept as it was made');
    await fails(`delete from report_section_decision where id = $1`, [id], 'kept as it was made');
    await db.su.query(`update report_section set status = 'returned' where id = $1`, [ids.a]);
  });

  it('the decider is a person of the same institution', async () => {
    const inst2 = await one(`insert into institution (name_en) values ('Desert College') returning id`);
    const stranger = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'stranger', 's@z.org') returning id`, [inst2]);
    await fails(
      `insert into report_section_decision (institution_id, section_id, decision, note, decided_by) values ($1, $2, 'returned', 'x', $3)`,
      [ids.inst, ids.a, stranger], 'the decider must be a person of the same institution');
  });
});

describe('internal approval, reopening and submission', () => {
  it('internal approval stamps; reopening an approved section demotes the report in the same transaction and clears the stamps', async () => {
    await fails(`update report set status = 'internally_approved' where id = $1`, [ids.report], 'every section is approved');
    await approve(ids.b);
    await db.su.query(`update report_section set status = 'in_review' where id = $1`, [ids.a]);
    await approve(ids.a);
    await db.as({ userId: ids.reviewer, institutionId: ids.inst }, async (c) => {
      await c.query(`update report set status = 'internally_approved' where id = $1`, [ids.report]);
      const stamped = await c.query(`select approved_by, approved_at is not null as t from report where id = $1`, [ids.report]);
      expect(stamped.rows[0]!.approved_by).toBe(ids.reviewer);
      expect(stamped.rows[0]!.t).toBe(true);
    });
    // A direct demotion is not a move: an approved section must be reopened first.
    await fails(`update report set status = 'draft' where id = $1`, [ids.report], 'returns to draft only when one of its sections was reopened');
    // The real reopen: the decision, the section and the report move together.
    await db.su.query(
      `begin;
       insert into report_section_decision (institution_id, section_id, decision, note, decided_by) values ('${ids.inst}', '${ids.a}', 'returned', 'a figure moved', '${ids.reviewer}');
       update report_section set status = 'draft' where id = '${ids.a}';
       update report set status = 'draft' where id = '${ids.report}';
       commit`);
    const after = await db.su.query(`select status, approved_at, approved_by from report where id = $1`, [ids.report]);
    expect(after.rows[0]!.status).toBe('draft');
    expect(after.rows[0]!.approved_at).toBeNull();
    expect(after.rows[0]!.approved_by).toBeNull();
    const section = await db.su.query(`select status from report_section where id = $1`, [ids.a]);
    expect(section.rows[0]!.status).toBe('draft');
  });

  it('a forgotten demotion is stopped at commit, and nothing of the transaction survives', async () => {
    // Back to internally approved first.
    await db.su.query(`update report_section set status = 'in_review' where id = $1`, [ids.a]);
    await approve(ids.a);
    await db.su.query(`update report set status = 'internally_approved' where id = $1`, [ids.report]);
    await fails(
      `begin; update report_section set status = 'draft' where id = '${ids.b}'; commit`,
      [], 'reopen the report to draft in the same transaction');
    const untouched = await db.su.query(`select status from report_section where id = $1`, [ids.b]);
    expect(untouched.rows[0]!.status).toBe('approved');
  });

  it('submission stamps and locks; after it nothing reopens', async () => {
    await db.as({ userId: ids.reviewer, institutionId: ids.inst }, async (c) => {
      await c.query(`update report set status = 'submitted' where id = $1`, [ids.report]);
      const done = await c.query(`select submitted_by, submitted_at is not null as t from report where id = $1`, [ids.report]);
      expect(done.rows[0]!.submitted_by).toBe(ids.reviewer);
      expect(done.rows[0]!.t).toBe(true);
    });
    await fails(
      `begin; update report_section set status = 'draft' where id = '${ids.a}'; commit`,
      [], 'an internally approved or submitted report has an unapproved section');
    await fails(`update report set status = 'draft' where id = $1`, [ids.report], 'cannot become');
  });
});

describe('submission snapshot', () => {
  const sha = 'a'.repeat(64);
  it('one per report, carrying its round; immutable once written', async () => {
    await fails(
      `insert into submission_snapshot (institution_id, report_id, round, manifest, sha256) values ($1, $2, 2, '{}'::jsonb, $3)`,
      [ids.inst, ids.report, sha], "a snapshot carries its report's round");
    await fails(
      `insert into submission_snapshot (institution_id, report_id, round, manifest, sha256) values ($1, $2, 1, '{}'::jsonb, 'nothex')`,
      [ids.inst, ids.report], 'submission_snapshot_sha256_check');
    ids.snapshot = await one(
      `insert into submission_snapshot (institution_id, report_id, round, manifest, export_files, sha256) values ($1, $2, 1, $3::jsonb, '[{"kind":"attestation_letter","key":"r/letter.pdf"}]'::jsonb, $4) returning id`,
      [ids.inst, ids.report, JSON.stringify({ report: { id: ids.report }, sections: [], evidence: [], changes: [] }), sha]);
    await fails(
      `insert into submission_snapshot (institution_id, report_id, round, manifest, sha256) values ($1, $2, 1, '{}'::jsonb, $3)`,
      [ids.inst, ids.report, sha], 'submission_snapshot_report_idx');
    await fails(`update submission_snapshot set manifest = '{"x":1}'::jsonb where id = $1`, [ids.snapshot], 'a submission snapshot is immutable');
    await fails(`delete from submission_snapshot where id = $1`, [ids.snapshot], 'a submission snapshot is immutable');
  });

  it('a snapshot belongs to a report of the same institution', async () => {
    const inst2 = await one(`insert into institution (name_en) values ('Desert College') returning id`);
    // The BEFORE trigger fires before the per-report unique index, so the right error wins.
    await expect(db.su.query(
      `insert into submission_snapshot (institution_id, report_id, round, manifest, sha256) values ($1, $2, 1, '{}'::jsonb, $3)`,
      [inst2, ids.report, sha])).rejects.toThrow('a snapshot belongs to a report of the same institution');
  });
});
