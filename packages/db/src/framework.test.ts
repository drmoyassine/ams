import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;

async function one(sql: string, params: unknown[] = []): Promise<string> {
  return (await db.su.query(sql, params)).rows[0].id as string;
}

beforeAll(async () => {
  db = await createTestDb('framework');
  ids.instA = await one(`insert into institution (name_en) values ('A') returning id`);
  ids.instB = await one(`insert into institution (name_en) values ('B') returning id`);
  ids.admin = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'Admin', 'a@x.org') returning id`, [ids.instA]);
  ids.acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Western Commission', 'WSCUC', 'institutional') returning id`, [ids.instA]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Handbook', 'institution') returning id`, [ids.instA, ids.acc]);
  ids.ver = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2023') returning id`, [ids.instA, ids.fw]);
  ids.doc = await one(
    `insert into source_document (institution_id, framework_version_id, title, role, authority, file_path, sha256)
     values ($1, $2, 'Handbook', 'standards', 'binding', 'frameworks/h.pdf', $3) returning id`, [ids.instA, ids.ver, 'a'.repeat(64)]);
  ids.req = await one(
    `insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, 'Standard 1', 'Standard', 'Defining Institutional Purposes') returning id`,
    [ids.instA, ids.ver]);
});
afterAll(() => db.close());

const reject = (sql: string, params: unknown[], pattern: RegExp) =>
  expect(db.su.query(sql, params)).rejects.toThrow(pattern);

describe('framework library schema', () => {
  it('has every PRD 6.2 table with the tenant key, audit columns and provenance fields', async () => {
    for (const t of ['accreditor', 'framework', 'framework_version', 'source_document', 'source_page', 'requirement', 'requirement_note', 'report_template']) {
      const cols = (await db.su.query(`select column_name from information_schema.columns where table_name = $1`, [t])).rows.map((r) => r.column_name);
      expect(cols, t).toEqual(expect.arrayContaining(['id', 'institution_id', 'created_at', 'created_by', 'updated_at', 'updated_by']));
    }
    for (const t of ['requirement', 'requirement_note', 'report_template']) {
      const cols = (await db.su.query(`select column_name from information_schema.columns where table_name = $1`, [t])).rows.map((r) => r.column_name);
      expect(cols, t).toEqual(expect.arrayContaining([
        'origin', 'source_document_id', 'source_page', 'source_quote', 'quote_verified', 'review_status', 'reviewed_by', 'reviewed_at',
      ]));
    }
  });

  it('defaults a new version to draft with empty configuration', async () => {
    const { rows: [v] } = await db.su.query(`select status, level_labels, lifecycle_template, rating_method from framework_version where id = $1`, [ids.ver]);
    expect(v).toEqual({ status: 'draft', level_labels: [], lifecycle_template: {}, rating_method: null });
  });

  it('enforces enumerations in the database', async () => {
    await reject(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'x', 'x', 'bogus')`, [ids.instA], /accreditor_type_check/);
    await reject(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'x', 'galaxy')`, [ids.instA, ids.acc], /framework_scope_check/);
    await reject(`update framework_version set status = 'live' where id = $1`, [ids.ver], /framework_version_status_check|illegal framework version status/);
    await reject(`insert into requirement_note (institution_id, requirement_id, type, text, authority) values ($1, $2, 'guidance', 't', 'mandatory')`,
      [ids.instA, ids.req], /requirement_note_authority_check/);
    await reject(`insert into report_template (institution_id, framework_version_id, key, name, kind) values ($1, $2, 'k', 'n', 'essay')`,
      [ids.instA, ids.ver], /report_template_kind_check/);
  });

  it('requires publisher and time on a published version', async () => {
    const empty = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, 'empty') returning id`, [ids.instA, ids.fw]);
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [empty]);
    await reject(`update framework_version set status = 'published' where id = $1`, [empty], /framework_version_published_fields/);
  });

  it('ties codes to their version and templates to their key', async () => {
    await reject(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, 'Standard 1', 'Standard', 'dup')`,
      [ids.instA, ids.ver], /requirement_version_code_idx/);
    await db.su.query(`insert into report_template (institution_id, framework_version_id, key, name, kind) values ($1, $2, 'annual', 'Annual', 'annual')`, [ids.instA, ids.ver]);
    await reject(`insert into report_template (institution_id, framework_version_id, key, name, kind) values ($1, $2, 'annual', 'Again', 'annual')`,
      [ids.instA, ids.ver], /report_template_version_key_idx/);
  });

  it('a verified quote needs a quote, and document checksums must be sha-256 hex', async () => {
    await reject(`insert into requirement_note (institution_id, requirement_id, type, text, authority, quote_verified) values ($1, $2, 'guidance', 't', 'required', true)`,
      [ids.instA, ids.req], /requirement_note_verified_quote_check/);
    await reject(`insert into source_document (institution_id, framework_version_id, title, role, authority, file_path, sha256) values ($1, $2, 't', 'standards', 'binding', 'p', 'nothex')`,
      [ids.instA, ids.ver], /source_document_sha256_check/);
    await db.su.query(`insert into requirement_note (institution_id, requirement_id, type, text, authority, source_document_id, source_page, source_quote, quote_verified)
                       values ($1, $2, 'guidance', 't', 'required', $3, 4, 'verbatim sentence', true)`, [ids.instA, ids.req, ids.doc]);
  });

  it('one page number per document', async () => {
    await db.su.query(`insert into source_page (institution_id, source_document_id, page_no, text, method) values ($1, $2, 1, 'text', 'pdf_text')`, [ids.instA, ids.doc]);
    await reject(`insert into source_page (institution_id, source_document_id, page_no, text, method) values ($1, $2, 1, 'again', 'ocr')`, [ids.instA, ids.doc], /source_page_doc_page_idx/);
    await reject(`insert into source_page (institution_id, source_document_id, page_no, text, method) values ($1, $2, 0, 'zero', 'ocr')`, [ids.instA, ids.doc], /source_page_no_check/);
  });
});

describe('framework library access rules', () => {
  const as = (userId: string, institutionId: string, role?: 'ams_app' | 'ams_worker') => ({ userId, institutionId, role });

  it('is isolated by institution', async () => {
    const own = await db.as(as(ids.admin!, ids.instA!), async (c) => (await c.query(`select count(*)::int n from requirement`)).rows[0].n);
    expect(own).toBeGreaterThan(0);
    const other = await db.as(as(ids.admin!, ids.instB!), async (c) => (await c.query(`select count(*)::int n from requirement`)).rows[0].n);
    expect(other).toBe(0);
    await expect(db.as(as(ids.admin!, ids.instB!), (c) =>
      c.query(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'x', 'y', 'regulatory')`, [ids.instA]),
    )).rejects.toThrow(/row-level security/);
  });

  it('audits changes with the caller as actor', async () => {
    const id = await db.as(as(ids.admin!, ids.instA!), async (c) =>
      (await c.query(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Audited', 'both') returning id`, [ids.instA, ids.acc])).rows[0].id);
    const { rows } = await db.su.query(`select actor_id, action, target_type from audit_event where target_id = $1`, [id]);
    expect(rows).toEqual([{ actor_id: ids.admin, action: 'insert', target_type: 'framework' }]);
  });

  it('the worker role cannot write requirements, notes, templates, versions or review status', async () => {
    const w = as(ids.admin!, ids.instA!, 'ams_worker');
    for (const sql of [
      `update requirement set review_status = 'approved'`,
      `update requirement_note set review_status = 'approved'`,
      `update report_template set review_status = 'approved'`,
      `update framework_version set status = 'published'`,
    ]) {
      await expect(db.as(w, (c) => c.query(sql)), sql).rejects.toThrow(/permission denied/);
    }
    // Since the analysis (0039) the worker may draft AI-made requirements into a draft, but never a person's kind of row.
    await expect(db.as(w, (c) => c.query(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ('${ids.instA}', '${ids.ver}', 'W1', 'x', 'x')`)))
      .rejects.toThrow(/only unreviewed AI items|only into a draft|immutable/);
  });

  it('the worker role can store extracted page text', async () => {
    await db.as(as(ids.admin!, ids.instA!, 'ams_worker'), async (c) => {
      await c.query(`insert into source_page (institution_id, source_document_id, page_no, text, method) values ($1, $2, 2, 'ocr text', 'ocr')`, [ids.instA, ids.doc]);
      await c.query(`update source_document set text_status = 'extracted', page_count = 2 where id = $1`, [ids.doc]);
    });
    await expect(db.as(as(ids.admin!, ids.instA!, 'ams_worker'), (c) =>
      c.query(`update source_document set title = 'renamed' where id = $1`, [ids.doc]))).rejects.toThrow(/permission denied/);
  });
});
