// content_translation (migration 0057, TASK-071): tenant isolation, audit, shape checks, what the worker may write (only
// unreviewed AI rows; never a person's or a reviewed row), and the frozen-version rule: a PUBLISHED version cannot change, but its
// translations - a separate table beside the English - can still be added, edited and reviewed.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
let pool: pg.Pool;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const app = () => ({ userId: ids.user, institutionId: ids.inst });
const worker = () => ({ userId: ids.user, institutionId: ids.inst, role: 'ams_worker' as const });
const insert = (entity: string, field: string, extra = `'ai', false`, version = ids.version) =>
  `insert into content_translation (institution_id, kind, framework_version_id, entity_id, field, language, source_hash, text, origin, reviewed) values ('${ids.inst}', 'standard', '${version}', '${entity}', '${field}', 'ar', 'h', 'نص', ${extra})`;

beforeAll(async () => {
  db = await createTestDb('contenttranslation');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = await one(`insert into institution (name_en, secondary_language, default_locale) values ('U', 'ar', 'en') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('V') returning id`);
  ids.user = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'A', 'a@x.org') returning id`, [ids.inst]);
  ids.otherUser = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'B', 'b@x.org') returning id`, [ids.other]);
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'A', 'A', 'institutional') returning id`, [ids.inst]);
  const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'F', 'institution') returning id`, [ids.inst, acc]);
  ids.version = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2027') returning id`, [ids.inst, fw]);
  ids.req = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, review_status) values ($1, $2, 'R1', 'Standard', 'Title', 'approved') returning id`, [ids.inst, ids.version]);
  ids.req2 = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, review_status) values ($1, $2, 'R2', 'Standard', 'Title two', 'approved') returning id`, [ids.inst, ids.version]);
  ids.note = await one(`insert into requirement_note (institution_id, requirement_id, type, text, authority, review_status) values ($1, $2, 'guidance', 't', 'example', 'approved') returning id`, [ids.inst, ids.req]);
  await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [ids.version]);
  await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [ids.version, ids.user]);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('content_translation and a published version', () => {
  it('the English of a published version cannot change, but a translation can be added, edited and reviewed beside it', async () => {
    await expect(db.su.query(`update requirement set title = 'x' where id = $1`, [ids.req])).rejects.toThrow(/immutable/);
    await expect(db.su.query(`update requirement_note set text = 'x' where id = $1`, [ids.note])).rejects.toThrow(/immutable/);
    await expect(db.su.query(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, 'R9', 'Standard', 'New')`, [ids.inst, ids.version])).rejects.toThrow(/immutable/);
    // The application role adds, edits and reviews translations of that same version.
    await db.as(app(), (c) => c.query(insert(ids.req!, 'title', `'person', true`)));
    await db.as(app(), (c) => c.query(insert(ids.req!, 'statement')));
    await db.as(app(), (c) => c.query(`update content_translation set text = 'تعديل', reviewed = true where entity_id = $1 and field = 'statement'`, [ids.req]));
    expect((await db.su.query(`select count(*)::int as n from content_translation where framework_version_id = $1`, [ids.version])).rows[0].n).toBe(2);
    expect((await db.su.query(`select title from requirement where id = $1`, [ids.req])).rows[0].title).toBe('Title');
  });
});

describe('content_translation rows', () => {
  it('is isolated per institution, never holds English, has one row per entity, field and language, and only known kinds and fields', async () => {
    expect(await db.as({ userId: ids.otherUser, institutionId: ids.other }, async (c) => (await c.query(`select id from content_translation`)).rowCount)).toBe(0);
    await expect(db.as({ userId: ids.otherUser, institutionId: ids.other }, (c) => c.query(insert(ids.req2!, 'title')))).rejects.toThrow(/row-level security/);
    await expect(db.su.query(insert(ids.req2!, 'title').replace("'ar'", "'en'"))).rejects.toThrow(/content_translation_language_check/);
    await expect(db.su.query(insert(ids.req!, 'title'))).rejects.toThrow(/content_translation_entity_idx/);
    await expect(db.su.query(insert(ids.req2!, 'bogus'))).rejects.toThrow(/content_translation_field_check/);
    await expect(db.su.query(insert(ids.req2!, 'title').replace("'standard'", "'glossary'"))).rejects.toThrow(/content_translation_kind_check/);
    await expect(db.su.query(insert(ids.req2!, 'title', `'robot', false`))).rejects.toThrow(/content_translation_origin_check/);
    // The same text in another language is another row.
    await db.su.query(insert(ids.req!, 'title').replace("'ar'", "'fr'"));
  });

  it('lets the worker add only unreviewed AI rows, and change the text of an unreviewed AI row', async () => {
    await db.as(worker(), (c) => c.query(insert(ids.req2!, 'title')));
    await expect(db.as(worker(), (c) => c.query(insert(ids.req2!, 'statement', `'ai', true`)))).rejects.toThrow(/only unreviewed AI/);
    await expect(db.as(worker(), (c) => c.query(insert(ids.req2!, 'statement', `'person', false`)))).rejects.toThrow(/only unreviewed AI/);
    await db.as(worker(), (c) => c.query(`update content_translation set text = 'جديد', source_hash = 'h2' where entity_id = $1 and field = 'title'`, [ids.req2]));
    // No column grant for reviewed or origin, and no delete.
    await expect(db.as(worker(), (c) => c.query(`update content_translation set reviewed = true where entity_id = $1`, [ids.req2]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`update content_translation set origin = 'person' where entity_id = $1`, [ids.req2]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`delete from content_translation where entity_id = $1`, [ids.req2]))).rejects.toThrow(/permission denied/);
  });

  it("never touches a person's row or a reviewed row", async () => {
    // From the first test: req/title is a person's, req/statement is reviewed AI.
    await expect(db.as(worker(), (c) => c.query(`update content_translation set text = 'machine' where entity_id = $1 and field = 'title' and language = 'ar'`, [ids.req]))).rejects.toThrow(/person wrote or reviewed/);
    await expect(db.as(worker(), (c) => c.query(`update content_translation set text = 'machine' where entity_id = $1 and field = 'statement'`, [ids.req]))).rejects.toThrow(/person wrote or reviewed/);
    expect((await db.su.query(`select text from content_translation where entity_id = $1 and field = 'title' and language = 'ar'`, [ids.req])).rows[0].text).toBe('نص');
  });

  it('is audited, and the worker can see the English it translates', async () => {
    expect((await db.su.query(`select count(*)::int as n from audit_event where target_type = 'content_translation'`)).rows[0].n).toBeGreaterThan(0);
    expect(await db.as(worker(), async (c) => (await c.query(`select r.id from requirement r join requirement_note n on n.requirement_id = r.id join framework_version v on v.id = r.framework_version_id join framework f on f.id = v.framework_id`)).rowCount)).toBe(1);
  });

  it('keeps a translation when the version or requirement is gone (rows are not tied by foreign keys), so a restore from the Trash finds it again', async () => {
    const fk = (await db.su.query(`select count(*)::int as n from pg_constraint where conrelid = 'content_translation'::regclass and contype = 'f' and confrelid::regclass::text in ('requirement', 'requirement_note', 'framework_version')`)).rows[0].n;
    expect(fk).toBe(0);
  });
});

describe('translation_run kinds', () => {
  it("accepts 'iqf' and 'standard' scoped to a version, one active run per scope, and nothing else", async () => {
    const run = (kind: string, scope: string | null) => db.su.query(`insert into translation_run (institution_id, kind, language, scope_id) values ($1, $2, 'ar', $3) returning id`, [ids.inst, kind, scope]);
    await run('standard', ids.version!);
    await expect(run('standard', ids.version!)).rejects.toThrow(/translation_run_one_active_idx/);
    await run('standard', ids.req!); // another scope may run at the same time
    await run('iqf', ids.version!);
    await expect(run('glossary', null)).rejects.toThrow(/translation_run_kind_check/);
  });
});
