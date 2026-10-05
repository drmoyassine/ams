import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const admin = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const dbName = `ams_schema_${process.pid}`;
const url = admin.replace(/\/[^/]*$/, `/${dbName}`);
let client: pg.Client;

beforeAll(async () => {
  const a = new pg.Client({ connectionString: admin });
  await a.connect();
  await a.query(`drop database if exists ${dbName}`);
  await a.query(`create database ${dbName}`);
  await a.end();
  await runMigrations(url);
  client = new pg.Client({ connectionString: url });
  await client.connect();
});
afterAll(async () => {
  await client.end();
  const a = new pg.Client({ connectionString: admin });
  await a.connect();
  await a.query(`drop database if exists ${dbName}`);
  await a.end();
});

const TABLES = ['institution', 'org_unit', 'program', 'app_user', 'role_assignment', 'comment', 'audit_event', 'job', 'extraction_item'];

describe('core schema', () => {
  it('creates every M0 table with id and audit columns', async () => {
    for (const t of TABLES) {
      const { rows } = await client.query(
        `select column_name from information_schema.columns where table_name = $1`, [t]);
      const cols = rows.map((r) => r.column_name);
      expect(cols, t).toEqual(expect.arrayContaining(['id', 'created_at', 'created_by', 'updated_at', 'updated_by']));
      if (t !== 'institution') expect(cols, t).toContain('institution_id');
    }
  });

  async function seed() {
    const { rows: [i] } = await client.query(`insert into institution (name_en) values ('U') returning id`);
    const { rows: [u] } = await client.query(
      `insert into app_user (institution_id, full_name, email) values ($1, 'A', 'a@x.org') returning id`, [i.id]);
    return { inst: i.id as string, user: u.id as string };
  }

  it('limits engagement_lead and co_lead to engagement scope', async () => {
    const { inst, user } = await seed();
    const insert = (role: string, scope: string) => client.query(
      `insert into role_assignment (institution_id, user_id, role, scope_type, scope_id)
       values ($1, $2, $3, $4, gen_random_uuid())`, [inst, user, role, scope]);
    await expect(insert('engagement_lead', 'program')).rejects.toThrow(/role_assignment_engagement_roles/);
    await expect(insert('co_lead', 'institution')).rejects.toThrow(/role_assignment_engagement_roles/);
    await insert('engagement_lead', 'engagement');
  });

  it('requires expires_at for external_reviewer', async () => {
    const { inst, user } = await seed();
    const q = (exp: string | null) => client.query(
      `insert into role_assignment (institution_id, user_id, role, scope_type, scope_id, expires_at)
       values ($1, $2, 'external_reviewer', 'program', gen_random_uuid(), $3)`, [inst, user, exp]);
    await expect(q(null)).rejects.toThrow(/role_assignment_external_reviewer_expires/);
    await q('2030-01-01');
  });

  it('rejects an unknown degree level', async () => {
    const { inst } = await seed();
    const { rows: [o] } = await client.query(
      `insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'C') returning id`, [inst]);
    await expect(client.query(
      `insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'P', 'phd')`,
      [inst, o.id])).rejects.toThrow();
  });
});
