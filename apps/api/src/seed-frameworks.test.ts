// The demo seed publishes the Appendix A frameworks through the normal importer, once.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { seedFrameworks } from './seed.js';

let db: TestDb;
let pool: pg.Pool;

beforeAll(async () => {
  db = await createTestDb('seedfw');
  pool = new pg.Pool({ connectionString: db.url });
}, 30000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('seedFrameworks', () => {
  it('does nothing until there is an administrator', async () => {
    expect(await seedFrameworks(pool)).toEqual([]);
  });

  it('publishes the three fixtures once, and is a no-op on the next start', async () => {
    const inst = (await db.su.query(`insert into institution (name_en) values ('U') returning id`)).rows[0].id;
    const user = (await db.su.query(`insert into app_user (institution_id, full_name, email) values ($1, 'Admin', 'a@x.org') returning id`, [inst])).rows[0].id;
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [inst, user]);

    expect(await seedFrameworks(pool)).toEqual(['abet-eac-2027-28.json', 'puc-2019.json', 'wscuc-2023.json']);
    const { rows } = await db.su.query(`select a.short_name, fv.status from framework_version fv join framework f on f.id = fv.framework_id join accreditor a on a.id = f.accreditor_id order by 1`);
    expect(rows).toEqual([{ short_name: 'ABET', status: 'published' }, { short_name: 'PUC', status: 'published' }, { short_name: 'WSCUC', status: 'published' }]);

    expect(await seedFrameworks(pool)).toEqual([]);
    expect((await db.su.query(`select count(*)::int as n from framework_version`)).rows[0].n).toBe(3);
  });
});
