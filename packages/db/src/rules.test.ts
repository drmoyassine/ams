import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;

async function one(sql: string, params: unknown[] = []): Promise<string> {
  const { rows } = await db.su.query(sql, params);
  return rows[0].id as string;
}

beforeAll(async () => {
  db = await createTestDb('rules');
  ids.instA = await one(`insert into institution (name_en) values ('Univ A') returning id`);
  ids.instB = await one(`insert into institution (name_en) values ('Univ B') returning id`);
  ids.college = await one(
    `insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.instA]);
  ids.progA = await one(
    `insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'Prog A', 'bachelor') returning id`,
    [ids.instA, ids.college]);
  ids.progB = await one(
    `insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'Prog B', 'bachelor') returning id`,
    [ids.instA, ids.college]);
  const user = (email: string, inst = ids.instA) => one(
    `insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [inst, email]);
  ids.contribA = await user('contrib-a@x.org');
  ids.admin = await user('admin@x.org');
  ids.otherInst = await user('b@y.org', ids.instB);
  const assign = (u: string, role: string, scope: string, scopeId: string) => db.su.query(
    `insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`,
    [ids.instA, u, role, scope, scopeId]);
  await assign(ids.contribA, 'contributor', 'program', ids.progA);
  await assign(ids.admin, 'admin', 'institution', ids.instA);
});
afterAll(() => db.close());

describe('RLS isolation', () => {
  it('a contributor scoped to program A cannot read program B (SQL with session settings)', async () => {
    const rows = await db.as({ userId: ids.contribA, institutionId: ids.instA }, async (c) =>
      (await c.query(`select id from program`)).rows.map((r) => r.id));
    expect(rows).toEqual([ids.progA]);
  });

  it('cannot update or delete another program through RLS', async () => {
    await db.as({ userId: ids.contribA, institutionId: ids.instA }, async (c) => {
      expect((await c.query(`update program set name_en = 'x' where id = $1`, [ids.progB])).rowCount).toBe(0);
      expect((await c.query(`delete from program where id = $1`, [ids.progB])).rowCount).toBe(0);
    });
  });

  it('an institution-scoped admin sees every program of the institution', async () => {
    const n = await db.as({ userId: ids.admin, institutionId: ids.instA }, async (c) =>
      (await c.query(`select id from program`)).rowCount);
    expect(n).toBe(2);
  });

  it('an org_unit-scoped role covers programs under that unit', async () => {
    const u = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'dean', 'dean@x.org') returning id`, [ids.instA]);
    await db.su.query(
      `insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'lead', 'org_unit', $3)`,
      [ids.instA, u, ids.college]);
    const n = await db.as({ userId: u, institutionId: ids.instA }, async (c) => (await c.query(`select 1 from program`)).rowCount);
    expect(n).toBe(2);
  });

  it('an expired role grants nothing', async () => {
    const u = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ext', 'ext@x.org') returning id`, [ids.instA]);
    await db.su.query(
      `insert into role_assignment (institution_id, user_id, role, scope_type, scope_id, expires_at)
       values ($1, $2, 'external_reviewer', 'program', $3, now() - interval '1 day')`, [ids.instA, u, ids.progA]);
    const n = await db.as({ userId: u, institutionId: ids.instA }, async (c) => (await c.query(`select 1 from program`)).rowCount);
    expect(n).toBe(0);
  });

  it('no identity means no rows', async () => {
    const n = await db.as({}, async (c) => (await c.query(`select 1 from program`)).rowCount);
    expect(n).toBe(0);
  });

  it('tenants are isolated from each other', async () => {
    const insts = await db.as({ userId: ids.otherInst, institutionId: ids.instB }, async (c) =>
      (await c.query(`select id from institution`)).rows.map((r) => r.id));
    expect(insts).toEqual([ids.instB]);
    const progs = await db.as({ userId: ids.otherInst, institutionId: ids.instB }, async (c) =>
      (await c.query(`select 1 from program`)).rowCount);
    expect(progs).toBe(0);
  });

  it('cannot insert a row into another tenant', async () => {
    await expect(db.as({ userId: ids.admin, institutionId: ids.instA }, (c) =>
      c.query(`insert into org_unit (institution_id, type, name_en) values ($1, 'other', 'x')`, [ids.instB]),
    )).rejects.toThrow(/row-level security/);
  });

  it('only admins may grant roles', async () => {
    await expect(db.as({ userId: ids.contribA, institutionId: ids.instA }, (c) =>
      c.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id)
               values ($1, $2, 'admin', 'institution', $1)`, [ids.instA, ids.contribA]),
    )).rejects.toThrow(/row-level security/);
  });
});

describe('audit trigger', () => {
  it('records the caller, action, target, before and after', async () => {
    await db.as({ userId: ids.admin, institutionId: ids.instA }, async (c) => {
      await c.query(`update program set name_en = 'Prog A2' where id = $1`, [ids.progA]);
    });
    const { rows } = await db.su.query(
      `select * from audit_event where target_id = $1 and action = 'update'`, [ids.progA]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: ids.admin, actor_type: 'user', target_type: 'program', institution_id: ids.instA,
    });
    expect(rows[0].before.name_en).toBe('Prog A');
    expect(rows[0].after.name_en).toBe('Prog A2');
  });

  it('records inserts and deletes, and stamps created_by / updated_by', async () => {
    const id = await db.as({ userId: ids.admin, institutionId: ids.instA }, async (c) => {
      const r = await c.query(
        `insert into org_unit (institution_id, type, name_en) values ($1, 'department', 'CS') returning id, created_by, updated_by`,
        [ids.instA]);
      expect(r.rows[0].created_by).toBe(ids.admin);
      expect(r.rows[0].updated_by).toBe(ids.admin);
      await c.query(`delete from org_unit where id = $1`, [r.rows[0].id]);
      return r.rows[0].id as string;
    });
    const { rows } = await db.su.query(`select action from audit_event where target_id = $1 order by at, id`, [id]);
    expect(rows.map((r) => r.action).sort()).toEqual(['delete', 'insert']);
  });

  it('is append-only: no update, delete or truncate, even for the table owner', async () => {
    await expect(db.su.query(`update audit_event set action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.su.query(`delete from audit_event`)).rejects.toThrow(/append-only/);
    await expect(db.su.query(`truncate audit_event`)).rejects.toThrow(/append-only/);
  });

  it('cannot be written directly by the application role', async () => {
    await expect(db.as({ userId: ids.admin, institutionId: ids.instA }, (c) =>
      c.query(`insert into audit_event (institution_id, actor_type, action, target_type) values ($1, 'user', 'forged', 'x')`, [ids.instA]),
    )).rejects.toThrow(/permission denied/);
  });

  it('is readable only by institution admins, within their tenant', async () => {
    const adminRows = await db.as({ userId: ids.admin, institutionId: ids.instA }, async (c) =>
      (await c.query(`select 1 from audit_event`)).rowCount);
    expect(adminRows).toBeGreaterThan(0);
    const contribRows = await db.as({ userId: ids.contribA, institutionId: ids.instA }, async (c) =>
      (await c.query(`select 1 from audit_event`)).rowCount);
    expect(contribRows).toBe(0);
  });
});

describe('worker role', () => {
  it('cannot grant roles or change programs', async () => {
    await expect(db.as({ userId: ids.admin, institutionId: ids.instA, role: 'ams_worker' }, (c) =>
      c.query(`update program set name_en = 'w'`))).rejects.toThrow(/permission denied/);
    await expect(db.as({ userId: ids.admin, institutionId: ids.instA, role: 'ams_worker' }, (c) =>
      c.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id)
               values ($1, $2, 'admin', 'institution', $1)`, [ids.instA, ids.admin]))).rejects.toThrow(/permission denied/);
  });

  it('cannot change an extraction item status (AI cannot approve)', async () => {
    const jobId = await one(`insert into job (institution_id, type) values ($1, 'ai_extract') returning id`, [ids.instA]);
    const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'A', 'A', 'regulatory') returning id`, [ids.instA]);
    const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'F', 'both') returning id`, [ids.instA, acc]);
    const ver = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '1') returning id`, [ids.instA, fw]);
    const item = await db.as({ userId: ids.admin, institutionId: ids.instA, role: 'ams_worker' }, async (c) => {
      const r = await c.query(
        `insert into extraction_item (institution_id, framework_version_id, job_id, kind, payload)
         values ($1, $3, $2, 'requirement', '{}') returning id`, [ids.instA, jobId, ver]);
      return r.rows[0].id as string;
    });
    await expect(db.as({ userId: ids.admin, institutionId: ids.instA, role: 'ams_worker' }, (c) =>
      c.query(`update extraction_item set status = 'accepted' where id = $1`, [item]))).rejects.toThrow(/permission denied/);
    await expect(db.as({ userId: ids.admin, institutionId: ids.instA, role: 'ams_worker' }, (c) =>
      c.query(`update extraction_item set flags = array['x'] where id = $1`, [item]))).resolves.toBeDefined();
  });
});
