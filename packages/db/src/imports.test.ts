// Documents and AI import (0053): tenant isolation, audit, and exactly what the worker role may write (DEC-006): run, candidates and
// pages only; never a decision, an edit, an apply or the target's real records.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const worker = () => ({ userId: ids.user, institutionId: ids.inst, role: 'ams_worker' as const });
const app = () => ({ userId: ids.user, institutionId: ids.inst });
const other = () => ({ userId: ids.otherUser, institutionId: ids.other });
const sha = (c: string) => c.repeat(64);

const candidate = (runId: string, extra = '') => `insert into import_proposal (institution_id, run_id, target_kind, payload ${extra ? ', ' + extra.split('|')[0] : ''}) values ('${ids.inst}', '${runId}', 't', '{"name":"x"}'::jsonb ${extra ? ', ' + extra.split('|')[1] : ''}) returning id`;

beforeAll(async () => {
  db = await createTestDb('imports');
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('V') returning id`);
  ids.user = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'A', 'a@x.org') returning id`, [ids.inst]);
  ids.otherUser = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'B', 'b@x.org') returning id`, [ids.other]);
  ids.doc = await one(`insert into import_document (institution_id, scope_kind, file_name, mime, size, sha256, file_path) values ($1, 'org_chart', 'a.pdf', 'application/pdf', 10, $2, 'k/a') returning id`, [ids.inst, sha('a')]);
});
afterAll(() => db.close());

describe('import_document and import_page', () => {
  it('are isolated per institution, audited, and stamp who uploaded', async () => {
    const id = await db.as(app(), async (c) => (await c.query(`insert into import_document (institution_id, scope_kind, file_name, mime, size, sha256, file_path) values ($1, 'programs', 'b.pdf', 'application/pdf', 5, $2, 'k/b') returning id, created_by`, [ids.inst, sha('b')])).rows[0]);
    expect(id.created_by).toBe(ids.user);
    expect(await db.as(other(), async (c) => (await c.query(`select id from import_document`)).rowCount)).toBe(0);
    expect(await db.as(other(), async (c) => (await c.query(`select id from import_page`)).rowCount)).toBe(0);
    expect(Number((await db.su.query(`select count(*) from audit_event where target_type = 'import_document' and target_id = $1`, [id.id])).rows[0].count)).toBe(1);
    await expect(db.su.query(`insert into import_document (institution_id, scope_kind, file_name, mime, size, sha256, file_path) values ($1, 'evidence', 'c.pdf', 'x', 1, $2, 'k')`, [ids.inst, sha('c')])).rejects.toThrow(/import_document_scope_kind_check/);
    await expect(db.su.query(`insert into import_document (institution_id, scope_kind, file_name, mime, size, sha256, file_path) values ($1, 'glossary', 'c.pdf', 'x', 1, 'nothex', 'k')`, [ids.inst])).rejects.toThrow(/import_document_sha256_check/);
  });

  it('lets the worker record a reading (status, page count, pages) and nothing else about a document', async () => {
    await db.as(worker(), async (c) => {
      await c.query(`update import_document set read_status = 'read', page_count = 2 where id = $1`, [ids.doc]);
      await c.query(`insert into import_page (institution_id, import_document_id, page_no, text, method) values ($1, $2, 1, 'one', 'pdf_text'), ($1, $2, 2, 'two', 'ocr')`, [ids.inst, ids.doc]);
      await c.query(`update import_page set text = 'uno', warnings = '["x"]'::jsonb where import_document_id = $1 and page_no = 1`, [ids.doc]);
      await c.query(`delete from import_page where import_document_id = $1 and page_no = 2`, [ids.doc]);
    });
    for (const sql of [
      `update import_document set file_name = 'evil.pdf' where id = '${ids.doc}'`, `update import_document set scope_kind = 'programs' where id = '${ids.doc}'`,
      `update import_document set file_path = 'other' where id = '${ids.doc}'`, `update import_document set sha256 = '${sha('d')}' where id = '${ids.doc}'`,
      `delete from import_document where id = '${ids.doc}'`,
      `insert into import_document (institution_id, scope_kind, file_name, mime, size, sha256, file_path) values ('${ids.inst}', 'glossary', 'w.pdf', 'x', 1, '${sha('e')}', 'k')`,
    ]) await expect(db.as(worker(), (c) => c.query(sql)), sql).rejects.toThrow(/permission denied/);
    expect(await db.as(worker(), async (c) => (await c.query(`select page_no from import_page where import_document_id = $1`, [ids.doc])).rows)).toEqual([{ page_no: 1 }]);
  });
});

describe('import_run', () => {
  it('is isolated, audited, at most one active per place and target, and the worker cannot revive an ended run', async () => {
    const id = await db.as(app(), async (c) => (await c.query(`insert into import_run (institution_id, scope_kind, scope_id, target_kind, document_ids) values ($1, 'org_chart', null, 'one', array[$2::uuid]) returning id`, [ids.inst, ids.doc])).rows[0].id as string);
    await expect(db.su.query(`insert into import_run (institution_id, scope_kind, scope_id, target_kind, document_ids) values ($1, 'org_chart', null, 'one', array[$2::uuid])`, [ids.inst, ids.doc])).rejects.toThrow(/import_run_one_active_idx/);
    await db.su.query(`insert into import_run (institution_id, scope_kind, scope_id, target_kind, document_ids) values ($1, 'org_chart', null, 'two', array[$2::uuid])`, [ids.inst, ids.doc]); // another target is fine
    await expect(db.su.query(`insert into import_run (institution_id, scope_kind, target_kind, document_ids) values ($1, 'org_chart', 'three', '{}')`, [ids.inst])).rejects.toThrow(/import_run_documents_check/);
    expect(await db.as(other(), async (c) => (await c.query(`select id from import_run`)).rowCount)).toBe(0);
    await db.as(worker(), (c) => c.query(`update import_run set status = 'running', stage = 'extract', progress = '{"cursor":1}'::jsonb, usage = '{"calls":1}'::jsonb where id = $1`, [id]));
    await expect(db.as(worker(), (c) => c.query(`update import_run set started_by = null where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`update import_run set scope_kind = 'programs' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`delete from import_run where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await db.as(app(), (c) => c.query(`update import_run set status = 'cancelled' where id = $1`, [id]));
    await expect(db.as(worker(), (c) => c.query(`update import_run set status = 'running' where id = $1`, [id]))).rejects.toThrow(/has ended/);
    await expect(db.su.query(`update import_run set stage = 'bogus' where id = $1`, [id])).rejects.toThrow(/import_run_stage_check/);
    expect(Number((await db.su.query(`select count(*) from audit_event where target_type = 'import_run' and target_id = $1`, [id])).rows[0].count)).toBe(3);
  });
});

describe('import_proposal: what the worker may and may not do', () => {
  it('adds pending candidates to a working run, checks them and merges them, and nothing more', async () => {
    const runId = await one(`insert into import_run (institution_id, scope_kind, scope_id, target_kind, document_ids, status) values ($1, 'glossary', null, 'w', array[$2::uuid], 'running') returning id`, [ids.inst, ids.doc]);
    const p = await db.as(worker(), async (c) => (await c.query(candidate(runId))).rows[0].id as string);
    await db.as(worker(), async (c) => {
      await c.query(`update import_proposal set quote_verified = true, flags = '["x"]'::jsonb, page_no = 3, confidence = 0.5, label = 'L' where id = $1`, [p]);
      await c.query(`update import_proposal set candidate = false, seq = 1 where id = $1`, [p]);
    });
    // Released: a person's now. The worker can neither change nor remove it.
    await expect(db.as(worker(), (c) => c.query(`update import_proposal set flags = '[]'::jsonb where id = $1`, [p]))).rejects.toThrow(/released to people/);
    await expect(db.as(worker(), (c) => c.query(`delete from import_proposal where id = $1`, [p]))).rejects.toThrow(/released to people/);
    const cand = await db.as(worker(), async (c) => (await c.query(candidate(runId))).rows[0].id as string);
    await db.as(worker(), (c) => c.query(`delete from import_proposal where id = $1`, [cand])); // a candidate can be merged away
  });

  it('cannot decide, edit, apply, or add anything but a pending candidate; and not while the run is not working', async () => {
    const runId = await one(`insert into import_run (institution_id, scope_kind, scope_id, target_kind, document_ids, status) values ($1, 'programs', null, 'w', array[$2::uuid], 'running') returning id`, [ids.inst, ids.doc]);
    const p = await db.as(worker(), async (c) => (await c.query(candidate(runId))).rows[0].id as string);
    for (const sql of [
      `update import_proposal set status = 'accepted' where id = '${p}'`, `update import_proposal set edited_payload = '{}'::jsonb where id = '${p}'`,
      `update import_proposal set applied_ref = '{}'::jsonb where id = '${p}'`, `update import_proposal set payload = '{}'::jsonb where id = '${p}'`,
      `update import_proposal set run_id = '${runId}' where id = '${p}'`, `insert into import_apply (institution_id, run_id, user_id, target_kind, scope_kind, proposal_ids, summary, counts) values ('${ids.inst}', '${runId}', '${ids.user}', 't', 'programs', '{}', 's', '{}'::jsonb)`,
      `select * from import_apply`,
    ]) await expect(db.as(worker(), (c) => c.query(sql)), sql).rejects.toThrow(/permission denied/);
    for (const extra of [`status|'accepted'`, `edited_payload|'{}'::jsonb`, `applied_ref|'{}'::jsonb`, `candidate|false`]) {
      await expect(db.as(worker(), (c) => c.query(candidate(runId, extra))), extra).rejects.toThrow(/only pending candidates|permission denied/);
    }
    await db.su.query(`update import_run set status = 'failed' where id = $1`, [runId]);
    await expect(db.as(worker(), (c) => c.query(candidate(runId)))).rejects.toThrow(/adds proposals only while it works/);
    // The worker cannot reach the target's real records at all.
    for (const t of ['org_unit', 'program', 'requirement']) {
      await expect(db.as(worker(), (c) => c.query(`delete from ${t}`)), t).rejects.toThrow(/permission denied/);
    }
    await expect(db.as(worker(), (c) => c.query(`insert into org_unit (institution_id, type, name_en) values ('${ids.inst}', 'college', 'x')`))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`update trash_item set label = 'x'`))).rejects.toThrow(/permission denied/);
  });

  it('lets a person (the app role) edit, decide and apply, but only those columns, and is isolated per institution', async () => {
    const runId = await one(`insert into import_run (institution_id, scope_kind, scope_id, target_kind, document_ids, status) values ($1, 'glossary', null, 'x', array[$2::uuid], 'succeeded') returning id`, [ids.inst, ids.doc]);
    const p = await one(`insert into import_proposal (institution_id, run_id, target_kind, payload, candidate) values ($1, $2, 'x', '{"a":1}'::jsonb, false) returning id`, [ids.inst, runId]);
    await db.as(app(), (c) => c.query(`update import_proposal set edited_payload = '{"a":2}'::jsonb, status = 'edited' where id = $1`, [p]));
    await db.as(app(), (c) => c.query(`update import_proposal set status = 'applied', applied_ref = '{"id":"u"}'::jsonb where id = $1`, [p]));
    await expect(db.as(app(), (c) => c.query(`update import_proposal set payload = '{}'::jsonb where id = $1`, [p]))).rejects.toThrow(/permission denied/);
    await expect(db.as(app(), (c) => c.query(`update import_proposal set quote_verified = true where id = $1`, [p]))).rejects.toThrow(/permission denied/);
    await expect(db.as(app(), (c) => c.query(`delete from import_proposal where id = $1`, [p]))).rejects.toThrow(/permission denied/);
    expect(await db.as(other(), async (c) => (await c.query(`select id from import_proposal`)).rowCount)).toBe(0);
    await expect(db.su.query(`update import_proposal set status = 'approved' where id = $1`, [p])).rejects.toThrow(/import_proposal_status_check/);
    // The stored apply cannot be rewritten, only undone and redone; the audit trail names the person.
    const a = await db.as(app(), async (c) => (await c.query(`insert into import_apply (institution_id, run_id, user_id, target_kind, scope_kind, proposal_ids, summary, counts, inverse) values ($1, $2, $3, 'x', 'glossary', array[$4::uuid], 'Applied 1', '{"applied":1}'::jsonb, '{"t":1}'::jsonb) returning id`, [ids.inst, runId, ids.user, p])).rows[0].id as string);
    await db.as(app(), (c) => c.query(`update import_apply set state = 'undone', undone_at = now(), inverse = '{"t":2}'::jsonb where id = $1`, [a]));
    await expect(db.as(app(), (c) => c.query(`update import_apply set summary = 'other' where id = $1`, [a]))).rejects.toThrow(/cannot be rewritten/);
    await expect(db.as(app(), (c) => c.query(`update import_apply set user_id = '${ids.otherUser}' where id = $1`, [a]))).rejects.toThrow(/cannot be rewritten|foreign key/);
    expect(await db.as(other(), async (c) => (await c.query(`select id from import_apply`)).rowCount)).toBe(0);
    expect(Number((await db.su.query(`select count(*) from audit_event where target_type = 'import_apply' and target_id = $1 and actor_id = $2`, [a, ids.user])).rows[0].count)).toBe(2);
  });
});

describe('the Trash and the new kind', () => {
  it('accepts the import_document kind', async () => {
    await db.su.query(`insert into trash_item (institution_id, group_id, kind, label, payload, expires_at) values ($1, gen_random_uuid(), 'import_document', 'a.pdf', '{}'::jsonb, now() + interval '30 days')`, [ids.inst]);
    await expect(db.su.query(`insert into trash_item (institution_id, group_id, kind, label, payload, expires_at) values ($1, gen_random_uuid(), 'evidence_file', 'a.pdf', '{}'::jsonb, now())`, [ids.inst])).rejects.toThrow(/trash_item_kind_check/);
  });
});
