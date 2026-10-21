// The evidence schema (migration 0064, TASK-089, DEC-031). Part 1 runs the migration over data written by the schema before it:
// description becomes definition, data becomes dataset, a dataset's own definition is merged into the item's and the column dropped, a
// dataset whose form is in use is collected by the form, and every existing row stays valid. Part 2 is the rules on the new columns.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from './migrate.js';
import { createTestDb, type TestDb } from './test-db.js';

const admin = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const TAG = '0064_evidence_schema';
const ids = {} as Record<string, string>;

/** Everything before the migration under test, as the schema was then. */
async function oldDatabase(label: string) {
  const name = `ams_${label}_${process.pid}`;
  const a = new pg.Client({ connectionString: admin });
  await a.connect();
  await a.query(`drop database if exists ${name}`);
  await a.query(`create database ${name}`);
  await a.end();
  const url = admin.replace(/\/[^/]*$/, `/${name}`);
  const dir = mkdtempSync(join(tmpdir(), 'ams-mig-'));
  mkdirSync(join(dir, 'meta'));
  for (const f of readdirSync(migrationsFolder)) if (f.endsWith('.sql') && !f.startsWith('0064') && !f.startsWith('0065')) copyFileSync(join(migrationsFolder, f), join(dir, f));
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag !== TAG && !e.tag.startsWith('0065'));
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  await migrate(drizzle(pool), { migrationsFolder: dir });
  await pool.end();
  const su = new pg.Client({ connectionString: url });
  await su.connect();
  return {
    su, url,
    async close() {
      await su.end();
      const b = new pg.Client({ connectionString: admin });
      await b.connect();
      await b.query(`drop database if exists ${name} with (force)`);
      await b.end();
    },
  };
}

describe('migration 0064 over data written by the schema before it', () => {
  let old: Awaited<ReturnType<typeof oldDatabase>>;
  const one = async (sql: string, p: unknown[] = []) => (await old.su.query(sql, p)).rows[0].id as string;
  const item = (title: string, type: string, description: string | null) =>
    one(`insert into evidence_item (institution_id, title, type, description) values ($1, $2, $3, $4) returning id`, [ids.inst, title, type, description]);
  const spec = (itemId: string, definition: string | null, formOpen = false) =>
    old.su.query(`insert into dataset_spec (institution_id, evidence_item_id, definition, form_open) values ($1, $2, $3, $4)`, [ids.inst, itemId, definition, formOpen]);

  beforeAll(async () => {
    old = await oldDatabase('evidencemig');
    ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
    ids.user = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'Owner', 'o@x.org') returning id`, [ids.inst]);
    ids.doc = await item('Strategic plan', 'document', 'The approved plan');
    ids.docNone = await item('Minutes', 'document', null);
    ids.both = await item('Retention', 'data', 'Item words');
    ids.bothSpec = 'Spec words';
    await spec(ids.both, ids.bothSpec);
    ids.onlySpec = await item('Graduation', 'data', null);
    await spec(ids.onlySpec, '  Graduation within six years  ');
    ids.same = await item('Enrollment', 'data', 'Headcount by program');
    await spec(ids.same, 'Headcount by program');
    ids.blankSpec = await item('Faculty', 'data', 'Faculty by rank');
    await spec(ids.blankSpec, '   ');
    ids.noSpec = await item('Salaries', 'data', null);
    ids.formOpen = await item('Employer survey', 'data', null);
    await spec(ids.formOpen, null, true);
    ids.answered = await item('Alumni survey', 'data', null);
    await spec(ids.answered, null, false);
    await old.su.query(`insert into dataset_response (institution_id, evidence_item_id, answers, via) values ($1, $2, '{"q":"a"}', 'link')`, [ids.inst, ids.answered]);
    // Some history the migration must leave alone.
    await old.su.query(`insert into evidence_version (institution_id, evidence_item_id, version_no, url) values ($1, $2, 1, 'https://x.example/plan')`, [ids.inst, ids.doc]);
    const before = (await old.su.query(`select count(*)::int as n from audit_event`)).rows[0].n as number;
    ids.auditBefore = String(before);

    const sql = readFileSync(join(migrationsFolder, `${TAG}.sql`), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) await old.su.query(statement);
  }, 120000);
  afterAll(() => old.close());

  const row = async (id: string) => (await old.su.query(`select * from evidence_item where id = $1`, [id])).rows[0];

  it('renames description to definition, and drops the dataset\'s own', async () => {
    const cols = (t: string) => old.su.query(`select column_name from information_schema.columns where table_name = $1`, [t]).then((r) => r.rows.map((x) => x.column_name as string));
    expect(await cols('evidence_item')).toEqual(expect.arrayContaining(['definition', 'method', 'method_config', 'schedule', 'next_due_at', 'last_run_at']));
    expect(await cols('evidence_item')).not.toContain('description');
    expect(await cols('dataset_spec')).not.toContain('definition');
    expect((await row(ids.doc!)).definition).toBe('The approved plan');
    expect((await row(ids.docNone!)).definition).toBeNull();
  });

  it('renames the type data to dataset and leaves documents', async () => {
    for (const k of ['both', 'onlySpec', 'same', 'blankSpec', 'noSpec', 'formOpen', 'answered']) expect((await row(ids[k]!)).type, k).toBe('dataset');
    for (const k of ['doc', 'docNone']) expect((await row(ids[k]!)).type, k).toBe('document');
    await expect(old.su.query(`insert into evidence_item (institution_id, title, type) values ($1, 'x', 'data')`, [ids.inst])).rejects.toThrow(/evidence_item_type_check/);
  });

  it('merges the dataset\'s definition into the item\'s: copied when the item has none, appended when both differ, nothing lost, nothing doubled', async () => {
    expect((await row(ids.onlySpec!)).definition).toBe('Graduation within six years');
    expect((await row(ids.both!)).definition).toBe('Item words\n\nSpec words');
    expect((await row(ids.same!)).definition).toBe('Headcount by program');
    expect((await row(ids.blankSpec!)).definition).toBe('Faculty by rank');
    expect((await row(ids.noSpec!)).definition).toBeNull();
  });

  it('collects by hand unless the dataset\'s form is in use; schedule and runs start empty', async () => {
    for (const k of ['doc', 'docNone', 'both', 'onlySpec', 'same', 'blankSpec', 'noSpec']) expect(await row(ids[k]!), k).toMatchObject({ method: 'manual', method_config: {}, schedule: null, next_due_at: null, last_run_at: null });
    for (const k of ['formOpen', 'answered']) expect(await row(ids[k]!), k).toMatchObject({ method: 'form', method_config: {}, schedule: null });
  });

  it('keeps every existing row valid and the history it had', async () => {
    // A no-op update re-checks every constraint and trigger on every row.
    await old.su.query(`update evidence_item set title = title`);
    expect((await old.su.query(`select count(*)::int as n from evidence_item`)).rows[0].n).toBe(9);
    expect((await old.su.query(`select count(*)::int as n from evidence_version`)).rows[0].n).toBe(1);
    expect((await old.su.query(`select count(*)::int as n from dataset_spec`)).rows[0].n).toBe(6);
    // The data fixes were audited like any other update (the audit trigger is intact).
    expect((await old.su.query(`select count(*)::int as n from audit_event`)).rows[0].n).toBeGreaterThan(Number(ids.auditBefore));
  });

  it('keeps the rules that named the old type, now for datasets', async () => {
    await expect(old.su.query(`insert into dataset_spec (institution_id, evidence_item_id) values ($1, $2)`, [ids.inst, ids.docNone])).rejects.toThrow(/only dataset evidence has a dataset specification/);
    await expect(old.su.query(
      `insert into evidence_request (institution_id, title, assignee_email, data_item_id) values ($1, 'Fill it', 'a@b.org', $2)`, [ids.inst, ids.docNone],
    )).rejects.toThrow(/dataset evidence/);
    await old.su.query(`insert into evidence_request (institution_id, title, assignee_email, data_item_id) values ($1, 'Fill it', 'a@b.org', $2)`, [ids.inst, ids.formOpen]);
  });
});

describe('the rules on the new columns', () => {
  let db: TestDb;
  const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
  const app = () => ({ userId: ids.u, institutionId: ids.i });

  beforeAll(async () => {
    db = await createTestDb('evidenceschemarules');
    ids.i = await one(`insert into institution (name_en) values ('U') returning id`);
    ids.j = await one(`insert into institution (name_en) values ('V') returning id`);
    ids.u = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'A', 'a@x.org') returning id`, [ids.i]);
    ids.v = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'B', 'b@x.org') returning id`, [ids.j]);
    ids.unitJ = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Other') returning id`, [ids.j]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.i, ids.u]);
    ids.doc = await one(`insert into evidence_item (institution_id, title, type, owner_user_id) values ($1, 'Doc', 'document', $2) returning id`, [ids.i, ids.u]);
    ids.ds = await one(`insert into evidence_item (institution_id, title, type, owner_user_id) values ($1, 'Data', 'dataset', $2) returning id`, [ids.i, ids.u]);
  }, 60000);
  afterAll(() => db.close());

  const set = (id: string, sql: string, p: unknown[] = []) => db.su.query(`update evidence_item set ${sql} where id = $1`, [id, ...p]);

  it('defaults a new item to manual collection, no schedule', async () => {
    expect((await db.su.query(`select method, method_config, schedule, next_due_at, last_run_at from evidence_item where id = $1`, [ids.doc])).rows[0])
      .toEqual({ method: 'manual', method_config: {}, schedule: null, next_due_at: null, last_run_at: null });
  });

  it('accepts the five methods, survey included, and no other', async () => {
    for (const m of ['manual', 'bi', 'survey']) await set(ids.doc!, `method = '${m}', method_config = '{}'`);
    await set(ids.ds!, `method = 'form'`);
    await expect(set(ids.doc!, `method = 'pigeon'`)).rejects.toThrow(/evidence_item_method_check/);
    await expect(set(ids.doc!, `method_config = '[]'`)).rejects.toThrow(/evidence_item_method_config_check/);
    await set(ids.ds!, `method = 'manual'`);
  });

  it('the form belongs to a dataset', async () => {
    await expect(set(ids.doc!, `method = 'form'`)).rejects.toThrow(/evidence_item_form_dataset_check/);
    await expect(set(ids.ds!, `method = 'form', type = 'document'`)).rejects.toThrow(/evidence_item_form_dataset_check/);
  });

  it('a request names exactly one person (of this institution) or one address', async () => {
    await set(ids.doc!, `method = 'request', method_config = $2::jsonb`, [JSON.stringify({ assigneeUserId: ids.u })]);
    await set(ids.doc!, `method = 'request', method_config = $2::jsonb`, [JSON.stringify({ assigneeEmail: 'a@b.org', note: 'x' })]);
    await expect(set(ids.doc!, `method = 'request', method_config = '{}'`)).rejects.toThrow(/evidence_item_request_check/);
    await expect(set(ids.doc!, `method = 'request', method_config = $2::jsonb`, [JSON.stringify({ assigneeUserId: ids.u, assigneeEmail: 'a@b.org' })])).rejects.toThrow(/evidence_item_request_check/);
    await expect(set(ids.doc!, `method = 'request', method_config = $2::jsonb`, [JSON.stringify({ assigneeUserId: ids.v })])).rejects.toThrow(/same institution/);
    await expect(set(ids.doc!, `method = 'request', method_config = $2::jsonb`, [JSON.stringify({ assigneeUserId: 'not-an-id' })])).rejects.toThrow(/named by id/);
    await set(ids.doc!, `method = 'manual', method_config = '{}'`);
  });

  it('a BI endpoint is a name, never an address', async () => {
    await set(ids.ds!, `method = 'bi', method_config = $2::jsonb`, [JSON.stringify({ endpointKey: 'warehouse-1', period: 'year' })]);
    for (const bad of ['http://bi.example.org', 'a/b', '1bad', 'x y']) {
      await expect(set(ids.ds!, `method = 'bi', method_config = $2::jsonb`, [JSON.stringify({ endpointKey: bad })]), bad).rejects.toThrow(/evidence_item_bi_check/);
    }
    await set(ids.ds!, `method = 'manual', method_config = '{}'`);
  });

  it('a schedule has a kind, a start date, days to due and a time zone', async () => {
    const ok = { every: 'semester', startDate: '2026-09-01', dueAfterDays: 14, timezone: 'Asia/Dubai' };
    await set(ids.doc!, `schedule = $2::jsonb, next_due_at = now()`, [JSON.stringify(ok)]);
    for (const bad of [
      { ...ok, every: 'decade' }, { ...ok, startDate: '09/01/2026' }, { ...ok, dueAfterDays: -1 }, { ...ok, dueAfterDays: '14' }, { ...ok, dueAfterDays: 4000 },
      { ...ok, timezone: '' }, { ...ok, timezone: 5 }, { every: 'week' },
    ]) await expect(set(ids.doc!, `schedule = $2::jsonb`, [JSON.stringify(bad)]), JSON.stringify(bad)).rejects.toThrow(/evidence_item_schedule_check/);
    await set(ids.doc!, `schedule = null, next_due_at = null`);
  });

  it('what an item names belongs to its institution', async () => {
    await expect(set(ids.doc!, `owner_user_id = $2`, [ids.v])).rejects.toThrow(/owner must be a person of the same institution/);
    await expect(set(ids.doc!, `owner_unit_id = $2`, [ids.unitJ])).rejects.toThrow(/owner unit must be a unit of the same institution/);
  });

  it('keeps tenant isolation, the worker\'s read-only access and the audit trail', async () => {
    const other = { userId: ids.v, institutionId: ids.j };
    expect((await db.as(other, (c) => c.query(`select id from evidence_item`))).rows).toEqual([]);
    // The app changes the new columns; the worker reads them and cannot write.
    await db.as(app(), (c) => c.query(`update evidence_item set method = 'bi', method_config = '{"period":"year"}', schedule = '{"every":"month","startDate":"2026-01-01","dueAfterDays":5,"timezone":"UTC"}', next_due_at = now(), last_run_at = now() where id = $1`, [ids.ds]));
    expect((await db.as({ ...app(), role: 'ams_worker' }, (c) => c.query(`select method, method_config, schedule, next_due_at, last_run_at from evidence_item where id = $1`, [ids.ds]))).rows[0].method).toBe('bi');
    await expect(db.as({ ...app(), role: 'ams_worker' }, (c) => c.query(`update evidence_item set method = 'manual' where id = $1`, [ids.ds]))).rejects.toThrow(/permission denied/);
    const audited = await db.su.query(`select after -> 'method' as method, before -> 'method' as was from audit_event where target_type = 'evidence_item' and target_id = $1 and action = 'update' order by created_at desc limit 1`, [ids.ds]);
    expect(audited.rows[0]).toMatchObject({ method: 'bi', was: 'manual' });
  });
});
