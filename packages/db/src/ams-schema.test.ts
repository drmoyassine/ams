// The AMS lives in its own schema (migration 0070, DEC-034 revised): `public` is left empty for the BI's analytic data, and a role
// of another product in the same database can see nothing of the AMS.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
beforeAll(async () => { db = await createTestDb('amsschema'); });
afterAll(async () => {
  await db.su.query('drop owned by bi_probe').catch(() => undefined);
  await db.su.query('drop role if exists bi_probe');
  await db.close();
});

describe('the ams schema', () => {
  it('holds every AMS table, leaves public empty, and is the default search path', async () => {
    const where = async (t: string) => (await db.su.query(`select table_schema from information_schema.tables where table_name = $1`, [t])).rows.map((r) => r.table_schema);
    expect(await where('app_user')).toEqual(['ams']);
    expect(await where('user')).toEqual(['ams']);
    expect((await db.su.query(`select count(*)::int n from pg_class where relnamespace = 'public'::regnamespace`)).rows[0].n).toBe(0);
    expect((await db.su.query('show search_path')).rows[0].search_path).toBe('ams, pg_catalog');
  });

  it('points every SECURITY DEFINER function at ams', async () => {
    const { rows } = await db.su.query(`select p.proname, array_to_string(p.proconfig, ',') cfg from pg_proc p
      where p.pronamespace = 'ams'::regnamespace and p.prosecdef`);
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) expect(r.cfg, r.proname).toContain('search_path=ams, pg_temp');
  });

  it('lets the AMS roles in and keeps another role out of ams and public', async () => {
    expect(await db.as({}, async (c) => (await c.query('select count(*)::int n from app_user')).rows[0].n)).toBe(0);
    await db.su.query(`drop role if exists bi_probe`);
    await db.su.query(`create role bi_probe login password 'probe-password'`);
    const url = new URL(db.url); url.username = 'bi_probe'; url.password = 'probe-password';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    try {
      await expect(c.query('select * from ams.app_user')).rejects.toThrow(/permission denied for schema ams/);
      await expect(c.query('select * from app_user')).rejects.toThrow(/permission denied|does not exist/);
      await expect(c.query('create table public.x (id int)')).rejects.toThrow(/permission denied for schema public/);
    } finally {
      await c.end();
    }
  });
});
