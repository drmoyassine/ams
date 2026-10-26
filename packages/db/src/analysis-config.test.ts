// Compiler step H (0050): what the worker may write into a draft version's lifecycle, vocabularies, rating method and report
// templates, and how the database marks a person's edit. The worker proposes into a draft; it never approves, publishes,
// deletes, or changes a part a person edited or made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const worker = () => ({ userId: ids.user, institutionId: ids.inst, role: 'ams_worker' as const });
const app = () => ({ userId: ids.user, institutionId: ids.inst });
const LIFE = JSON.stringify({ phases: [{ type: 'self_study', name: 'Self-study', applies_to: ['initial'], milestones: [] }] });
const LIFE2 = JSON.stringify({ phases: [{ type: 'review', name: 'Review', applies_to: ['initial'], milestones: [] }] });

async function version(edition: string) {
  const v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, $3) returning id`, [ids.inst, ids.fw, edition]);
  const d = await one(`insert into source_document (institution_id, framework_version_id, title, role, authority, file_path, sha256) values ($1, $2, 'Doc', 'policy_procedure', 'binding', 'p', $3) returning id`, [ids.inst, v, 'd'.repeat(64)]);
  return { v, d };
}
const row = async (v: string) => (await db.su.query(`select config_found, config_edited, lifecycle_template, decision_vocab, rating_method from framework_version where id = $1`, [v])).rows[0];
const aiTemplate = (v: string, d: string, key: string) =>
  `insert into report_template (institution_id, framework_version_id, key, name, kind, origin, source_document_id, source_page, source_quote, quote_verified) values ('${ids.inst}', '${v}', '${key}', 'Form', 'self_study', 'ai', '${d}', 1, 'q', true) returning id`;

beforeAll(async () => {
  db = await createTestDb('analysiscfg');
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  ids.user = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'A', 'a@x.org') returning id`, [ids.inst]);
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'A', 'A', 'institutional') returning id`, [ids.inst]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'F', 'institution') returning id`, [ids.inst, acc]);
});
afterAll(() => db.close());

describe('the worker writing configuration into a draft version', () => {
  it('fills an empty part, records it as its own, and may change it again until a person edits it', async () => {
    const { v } = await version('own');
    await db.as(worker(), (c) => c.query(
      `update framework_version set lifecycle_template = $2, decision_vocab = '[{"code":"ok","label":"Accredited","outcome":"accredited"}]', config_found = '{"lifecycle_template":{"runId":"r"},"decision_vocab":{"runId":"r"}}' where id = $1`, [v, LIFE]));
    expect((await row(v)).config_edited).toEqual({}); // the worker's own writes do not count as a person's edit
    await db.as(worker(), (c) => c.query(`update framework_version set lifecycle_template = $2 where id = $1`, [v, LIFE2]));
    expect((await row(v)).lifecycle_template.phases[0].name).toBe('Review');

    // A person edits the lifecycle: the database notes it, and only for the part that changed.
    await db.as(app(), (c) => c.query(`update framework_version set lifecycle_template = $2 where id = $1`, [v, LIFE]));
    expect((await row(v)).config_edited).toEqual({ lifecycle_template: true });
    await db.as(app(), (c) => c.query(`update framework_version set decision_vocab = decision_vocab, change_summary = 'x' where id = $1`, [v]));
    expect((await row(v)).config_edited).toEqual({ lifecycle_template: true });
    await expect(db.as(worker(), (c) => c.query(`update framework_version set lifecycle_template = $2 where id = $1`, [v, LIFE2]))).rejects.toThrow(/a person edited the lifecycle_template/);
    // The part the person did not touch is still the analysis's.
    await db.as(worker(), (c) => c.query(`update framework_version set decision_vocab = '[]' where id = $1`, [v]));
  });

  it('cannot change a part it did not write: one a person or an import filled stays as it is', async () => {
    const { v } = await version('foreign');
    await db.su.query(`update framework_version set decision_vocab = '[{"code":"ok","label":"Accredited","outcome":"accredited"}]', config_edited = '{}' where id = $1`, [v]);
    await expect(db.as(worker(), (c) => c.query(`update framework_version set decision_vocab = '[]' where id = $1`, [v]))).rejects.toThrow(/edited the decision_vocab|was not written by the analysis/);
    // An import (or a copy into a new version) inserts the part directly: nothing marks it, the rule still holds.
    const imported = await one(`insert into framework_version (institution_id, framework_id, edition, finding_vocab) values ($1, $2, 'imported', '[{"code":"c","label":"C","requires_action":true}]') returning id`, [ids.inst, ids.fw]);
    expect((await row(imported)).config_edited).toEqual({});
    await expect(db.as(worker(), (c) => c.query(`update framework_version set finding_vocab = '[]' where id = $1`, [imported]))).rejects.toThrow(/was not written by the analysis/);
    // An empty part is open to it.
    await db.as(worker(), (c) => c.query(`update framework_version set response_vocab = '[{"code":"l","label":"L"}]' where id = $1`, [imported]));
  });

  it('writes only into a draft, and never status, publication or review', async () => {
    const { v } = await version('draft');
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [v]);
    await expect(db.as(worker(), (c) => c.query(`update framework_version set lifecycle_template = $2 where id = $1`, [v, LIFE]))).rejects.toThrow(/only into a draft/);
    await db.su.query(`update framework_version set status = 'draft' where id = $1`, [v]);
    for (const sql of [
      `update framework_version set status = 'published' where id = $1`,
      `update framework_version set config_edited = '{"lifecycle_template":false}' where id = $1`,
      `update framework_version set published_by = null where id = $1`,
    ]) await expect(db.as(worker(), (c) => c.query(sql, [v])), sql).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`delete from framework_version where id = $1`, [v]))).rejects.toThrow(/permission denied/);
    // The internal quality framework drafts like any draft (TASK-107): the config-marking rule applies, not a blanket
    // refusal — and its level_labels stay the institution's (asserted with the requirement guard in mapping-proposals).
    const acc = await one(`select accreditor_id id from framework where id = $1`, [ids.fw]);
    const iqf = await one(`insert into framework (institution_id, accreditor_id, name, scope, internal) values ($1, $2, 'Quality', 'institution', true) returning id`, [ids.inst, acc]);
    const iv = await one(`insert into framework_version (institution_id, framework_id, edition, decision_vocab) values ($1, $2, 'q', '[{"code":"d","label":"D"}]') returning id`, [ids.inst, iqf]);
    await expect(db.as(worker(), (c) => c.query(`update framework_version set decision_vocab = '[]' where id = $1`, [iv]))).rejects.toThrow(/was not written by the analysis/);
    // A published version is immutable to everyone.
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [v]);
    await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [v, ids.user]);
    await expect(db.as(worker(), (c) => c.query(`update framework_version set lifecycle_template = $2 where id = $1`, [v, LIFE]))).rejects.toThrow(/only into a draft|immutable/);
  });
});

describe('the worker proposing report templates', () => {
  it('adds unreviewed AI templates to a draft and updates them while nobody has touched them', async () => {
    const { v, d } = await version('tpl');
    const t = await db.as(worker(), async (c) => (await c.query(aiTemplate(v, d, 'form'))).rows[0].id as string);
    await db.as(worker(), (c) => c.query(`update report_template set name = 'Better', structure = '{"sections":[]}', word_limit = 100, source_page = 2, quote_verified = false where id = $1`, [t]));
    expect((await db.su.query(`select origin, review_status, edited_by_person, name from report_template where id = $1`, [t])).rows[0]).toEqual({ origin: 'ai', review_status: 'pending', edited_by_person: false, name: 'Better' });
  });

  it('never adds a manual or approved template, never approves, deletes, or touches a person\'s', async () => {
    const { v, d } = await version('tpllimits');
    const t = await db.as(worker(), async (c) => (await c.query(aiTemplate(v, d, 'form'))).rows[0].id as string);
    for (const sql of [
      `insert into report_template (institution_id, framework_version_id, key, name, kind, origin) values ('${ids.inst}', '${v}', 'm', 'M', 'other', 'manual')`,
      `insert into report_template (institution_id, framework_version_id, key, name, kind, origin, review_status) values ('${ids.inst}', '${v}', 'p', 'P', 'other', 'ai', 'approved')`,
      `insert into report_template (institution_id, framework_version_id, key, name, kind, origin, edited_by_person) values ('${ids.inst}', '${v}', 'e', 'E', 'other', 'ai', true)`,
    ]) await expect(db.as(worker(), (c) => c.query(sql)), sql).rejects.toThrow(/only unreviewed AI items/);
    await expect(db.as(worker(), (c) => c.query(`update report_template set review_status = 'approved' where id = $1`, [t]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`update report_template set origin = 'manual' where id = $1`, [t]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`delete from report_template where id = $1`, [t]))).rejects.toThrow(/permission denied/);

    // A person edits it: the database marks it, and the worker is refused from then on.
    await db.as(app(), (c) => c.query(`update report_template set name = 'Ours' where id = $1`, [t]));
    expect((await db.su.query(`select edited_by_person from report_template where id = $1`, [t])).rows[0].edited_by_person).toBe(true);
    await expect(db.as(worker(), (c) => c.query(`update report_template set name = 'Again' where id = $1`, [t]))).rejects.toThrow(/a person made, edited or reviewed this report_template/);
    // A template that was imported or made by hand is not the analysis's to change.
    const imported = await one(`insert into report_template (institution_id, framework_version_id, key, name, kind, origin) values ($1, $2, 'imp', 'I', 'other', 'import') returning id`, [ids.inst, v]);
    await expect(db.as(worker(), (c) => c.query(`update report_template set name = 'x' where id = $1`, [imported]))).rejects.toThrow(/a person made, edited or reviewed/);
  });

  it('writes only into a draft version', async () => {
    const { v, d } = await version('tplreview');
    const t = await db.as(worker(), async (c) => (await c.query(aiTemplate(v, d, 'form'))).rows[0].id as string);
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [v]);
    await expect(db.as(worker(), (c) => c.query(aiTemplate(v, d, 'second')))).rejects.toThrow(/only into a draft/);
    await expect(db.as(worker(), (c) => c.query(`update report_template set name = 'x' where id = $1`, [t]))).rejects.toThrow(/only into a draft/);
    await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [v, ids.user]);
    await expect(db.as(worker(), (c) => c.query(aiTemplate(v, d, 'third')))).rejects.toThrow(/immutable/);
  });

  it('the run knows the configuration stages', async () => {
    const { v } = await version('stages');
    const run = await db.as(app(), async (c) => (await c.query(`insert into analysis_run (institution_id, framework_version_id, stage) values ($1, $2, 'write') returning id`, [ids.inst, v])).rows[0].id as string);
    for (const stage of ['config_survey', 'config_extract', 'config_write', 'embed']) {
      await db.as(worker(), (c) => c.query(`update analysis_run set stage = $2 where id = $1`, [run, stage]));
    }
    await expect(db.su.query(`update analysis_run set stage = 'config_other' where id = $1`, [run])).rejects.toThrow(/analysis_run_stage_check/);
  });
});
