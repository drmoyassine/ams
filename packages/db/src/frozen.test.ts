// PRD 6.9 invariants 1-3 (published is frozen, publish gate, sample reports never create requirements).
// These tests bind even the table owner: the triggers must not be relaxed to make anything pass.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;

async function one(sql: string, params: unknown[] = []): Promise<string> {
  return (await db.su.query(sql, params)).rows[0].id as string;
}
const fails = (sql: string, params: unknown[], pattern: RegExp) => expect(db.su.query(sql, params)).rejects.toThrow(pattern);

/** A draft version with one approved requirement, note, template, source document and page. */
async function makeVersion(edition: string) {
  const v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, $3) returning id`, [ids.inst, ids.fw, edition]);
  const d = await one(
    `insert into source_document (institution_id, framework_version_id, title, role, authority, file_path, sha256) values ($1, $2, 'Doc', 'standards', 'binding', 'p', $3) returning id`,
    [ids.inst, v, 'b'.repeat(64)]);
  const p = await one(`insert into source_page (institution_id, source_document_id, page_no, text, method) values ($1, $2, 1, 't', 'pdf_text') returning id`, [ids.inst, d]);
  const r = await one(
    `insert into requirement (institution_id, framework_version_id, code, level_label, title, review_status) values ($1, $2, 'R1', 'Standard', 'T', 'approved') returning id`, [ids.inst, v]);
  const n = await one(
    `insert into requirement_note (institution_id, requirement_id, type, text, authority, review_status) values ($1, $2, 'guidance', 't', 'example', 'approved') returning id`, [ids.inst, r]);
  const t = await one(
    `insert into report_template (institution_id, framework_version_id, key, name, kind) values ($1, $2, 'k', 'n', 'annual') returning id`, [ids.inst, v]);
  const jobId = await one(`insert into job (institution_id, type) values ($1, 'ai_extract') returning id`, [ids.inst]);
  const e = await one(
    `insert into extraction_item (institution_id, framework_version_id, job_id, kind, payload) values ($1, $2, $3, 'requirement', '{}') returning id`, [ids.inst, v, jobId]);
  return { v, d, p, r, n, t, e };
}
async function publish(v: string) {
  await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [v]);
  await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [v, ids.user]);
}

beforeAll(async () => {
  db = await createTestDb('frozen');
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  ids.user = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'A', 'a@x.org') returning id`, [ids.inst]);
  ids.acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'A', 'A', 'institutional') returning id`, [ids.inst]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'F', 'institution') returning id`, [ids.inst, ids.acc]);
});
afterAll(() => db.close());

describe('invariant 1: published is frozen', () => {
  it('lets a draft version change freely', async () => {
    const x = await makeVersion('draft-ok');
    await db.su.query(`update requirement set title = 'edited' where id = $1`, [x.r]);
    await db.su.query(`update requirement_note set text = 'edited' where id = $1`, [x.n]);
    await db.su.query(`delete from report_template where id = $1`, [x.t]);
  });

  it('rejects any change under a published version, on every table', async () => {
    const x = await makeVersion('2023');
    await publish(x.v);
    const frozen = /immutable/;
    await fails(`update requirement set title = 'x' where id = $1`, [x.r], frozen);
    await fails(`delete from requirement where id = $1`, [x.r], frozen);
    await fails(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, 'NEW', 'x', 'x')`, [ids.inst, x.v], frozen);
    await fails(`update requirement_note set text = 'x' where id = $1`, [x.n], frozen);
    await fails(`delete from requirement_note where id = $1`, [x.n], frozen);
    await fails(`insert into requirement_note (institution_id, requirement_id, type, text, authority) values ($1, $2, 'guidance', 'x', 'example')`, [ids.inst, x.r], frozen);
    await fails(`update report_template set name = 'x' where id = $1`, [x.t], frozen);
    await fails(`delete from report_template where id = $1`, [x.t], frozen);
    await fails(`update source_document set title = 'x' where id = $1`, [x.d], frozen);
    await fails(`update source_page set text = 'x' where id = $1`, [x.p], frozen);
    await fails(`delete from source_page where id = $1`, [x.p], frozen);
    await fails(`update extraction_item set status = 'accepted' where id = $1`, [x.e], frozen);
  });

  it('cannot move a row into a published version either', async () => {
    const a = await makeVersion('move-src');
    const b = await makeVersion('move-dst');
    await publish(b.v);
    await fails(`update requirement set framework_version_id = $2 where id = $1`, [a.r, b.v], /immutable/);
    await fails(`update requirement set framework_version_id = $2 where id = $1`, [b.r, a.v], /immutable/);
  });

  it('freezes the version row: only published -> retired, and no deletion', async () => {
    const x = await makeVersion('2024');
    await publish(x.v);
    await fails(`update framework_version set edition = 'renamed' where id = $1`, [x.v], /only its status may change/);
    await fails(`update framework_version set lifecycle_template = '{"a":1}' where id = $1`, [x.v], /only its status may change/);
    await fails(`update framework_version set status = 'draft' where id = $1`, [x.v], /status cannot change/);
    await fails(`delete from framework_version where id = $1`, [x.v], /cannot be deleted/);
    await db.su.query(`update framework_version set status = 'retired' where id = $1`, [x.v]);
    await fails(`update framework_version set status = 'published' where id = $1`, [x.v], /status cannot change/);
    await fails(`update requirement set title = 'x' where id = $1`, [x.r], /retired and immutable/);
  });

  it('enforces the status graph and starts new versions as drafts', async () => {
    const x = await makeVersion('graph');
    await fails(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [x.v, ids.user], /illegal framework version status/);
    await fails(`update framework_version set status = 'retired' where id = $1`, [x.v], /illegal framework version status/);
    await fails(`insert into framework_version (institution_id, framework_id, edition, status) values ($1, $2, 'born-published', 'published')`, [ids.inst, ids.fw], /must start as draft/);
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [x.v]);
    await db.su.query(`update framework_version set status = 'draft' where id = $1`, [x.v]);
  });
});

describe('invariant 2: publish gate', () => {
  async function inReview(edition: string) {
    const x = await makeVersion(edition);
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [x.v]);
    return x;
  }
  const tryPublish = (v: string) =>
    db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [v, ids.user]);

  it('refuses while a requirement is not approved', async () => {
    const x = await inReview('gate-req');
    await db.su.query(`update requirement set review_status = 'pending' where id = $1`, [x.r]);
    await expect(tryPublish(x.v)).rejects.toThrow(/1 requirement\(s\) are not approved/);
    await db.su.query(`update requirement set review_status = 'approved' where id = $1`, [x.r]);
    await tryPublish(x.v);
  });

  it('refuses while a note is not approved', async () => {
    const x = await inReview('gate-note');
    await db.su.query(`update requirement_note set review_status = 'rejected' where id = $1`, [x.n]);
    await expect(tryPublish(x.v)).rejects.toThrow(/note\(s\) are not approved/);
  });

  it('refuses a required note without a verified quote', async () => {
    const x = await inReview('gate-quote');
    await db.su.query(`update requirement_note set authority = 'required' where id = $1`, [x.n]);
    await expect(tryPublish(x.v)).rejects.toThrow(/required note\(s\) lack a verified quote/);
    await db.su.query(`update requirement_note set source_document_id = $2, source_page = 1, source_quote = 'the sentence', quote_verified = true where id = $1`, [x.n, x.d]);
    await tryPublish(x.v);
  });

  it.each([
    ['requirement', (x: Awaited<ReturnType<typeof makeVersion>>) => ['requirement', x.r]],
    ['requirement_note', (x: Awaited<ReturnType<typeof makeVersion>>) => ['requirement_note', x.n]],
    ['report_template', (x: Awaited<ReturnType<typeof makeVersion>>) => ['report_template', x.t]],
  ])('refuses an AI-originated %s without a source reference', async (_label, pick) => {
    const x = await inReview(`gate-ai-${_label}`);
    const [table, id] = pick(x) as [string, string];
    await db.su.query(`update ${table} set origin = 'ai', review_status = 'approved' where id = $1`, [id]);
    await expect(tryPublish(x.v)).rejects.toThrow(/AI-originated item\(s\) lack a source reference/);
    await db.su.query(`update ${table} set source_document_id = $2, source_page = 3, source_quote = 'q' where id = $1`, [id, x.d]);
    await tryPublish(x.v);
  });
});

describe('invariant 3: sample reports never create requirements', () => {
  async function sampleDoc() {
    const v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, $3) returning id`, [ids.inst, ids.fw, `sample-${Math.random()}`]);
    const d = await one(
      `insert into source_document (institution_id, framework_version_id, title, role, authority, file_path, sha256) values ($1, $2, 'Sample SSR', 'sample_report', 'informational', 'p', $3) returning id`,
      [ids.inst, v, 'c'.repeat(64)]);
    return { v, d };
  }

  it('blocks requirements and required notes sourced from a sample report', async () => {
    const { v, d } = await sampleDoc();
    await fails(`insert into requirement (institution_id, framework_version_id, code, level_label, title, source_document_id) values ($1, $2, 'S1', 'x', 'x', $3)`, [ids.inst, v, d], /sample reports never create requirements/);
    const r = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, 'S2', 'x', 'x') returning id`, [ids.inst, v]);
    await fails(`insert into requirement_note (institution_id, requirement_id, type, text, authority, source_document_id) values ($1, $2, 'guidance', 't', 'required', $3)`, [ids.inst, r, d], /sample reports never create requirements/);
    // An example note quoting a sample report is allowed: it creates no obligation.
    await db.su.query(`insert into requirement_note (institution_id, requirement_id, type, text, authority, source_document_id) values ($1, $2, 'guidance', 't', 'example', $3)`, [ids.inst, r, d]);
  });

  it('blocks accepting an extraction proposal from a sample report, but not leaving it pending', async () => {
    const { v, d } = await sampleDoc();
    const job = await one(`insert into job (institution_id, type) values ($1, 'ai_extract') returning id`, [ids.inst]);
    const mk = (kind: string, payload: string, status: string) => db.su.query(
      `insert into extraction_item (institution_id, framework_version_id, job_id, kind, payload, source_document_id, status) values ($1, $2, $3, $4, $5, $6, $7)`,
      [ids.inst, v, job, kind, payload, d, status]);
    await mk('requirement', '{}', 'pending');
    await expect(mk('requirement', '{}', 'accepted')).rejects.toThrow(/sample reports never create requirements/);
    await expect(mk('note', '{"authority":"required"}', 'edited')).rejects.toThrow(/sample reports never create requirements/);
    await mk('note', '{"authority":"example"}', 'accepted');
    await mk('requirement', '{}', 'rejected');
  });
});
