import pg from 'pg';
import { runMigrations } from './migrate.js';

const admin = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';

export interface TestDb {
  url: string;
  /** Superuser connection: seed data, inspect rows. */
  su: pg.Client;
  /** Runs fn in a transaction as `role` with the identity settings the middleware chain sets (DEC-010). */
  as<T>(
    id: { userId?: string; institutionId?: string; role?: 'ams_app' | 'ams_worker' },
    fn: (c: pg.Client) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export async function createTestDb(label: string): Promise<TestDb> {
  const name = `ams_${label}_${process.pid}`;
  const a = new pg.Client({ connectionString: admin });
  await a.connect();
  await a.query(`drop database if exists ${name}`);
  await a.query(`create database ${name}`);
  await a.end();
  const url = admin.replace(/\/[^/]*$/, `/${name}`);
  await runMigrations(url);
  const su = new pg.Client({ connectionString: url });
  await su.connect();
  return {
    url,
    su,
    async as(id, fn) {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        await c.query('begin');
        await c.query(`set local role ${id.role ?? 'ams_app'}`);
        await c.query(`select set_config('app.user_id', $1, true), set_config('app.institution_id', $2, true)`, [
          id.userId ?? '', id.institutionId ?? '',
        ]);
        const out = await fn(c);
        await c.query('commit');
        return out;
      } catch (e) {
        await c.query('rollback').catch(() => undefined);
        throw e;
      } finally {
        await c.end();
      }
    },
    async close() {
      await su.end();
      const b = new pg.Client({ connectionString: admin });
      await b.connect();
      await b.query(`drop database if exists ${name} with (force)`);
      await b.end();
    },
  };
}
