import type pg from 'pg';
import type { Env } from '@ams/shared';
import type { Auth } from './auth.js';

/**
 * Bootstrap: when the database has no institution and the ADMIN_* variables are set, create the institution, the
 * administrator's login and their institution-wide admin role. Runs once at startup on the owner connection
 * (there is no caller to authenticate yet); it is a no-op afterwards.
 */
export async function seedAdmin(
  pool: pg.Pool,
  auth: Auth,
  env: Pick<Env, 'INSTITUTION_NAME' | 'ADMIN_EMAIL' | 'ADMIN_PASSWORD'>,
): Promise<boolean> {
  const { INSTITUTION_NAME: name, ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = env;
  if (!name || !email || !password) return false;
  const existing = await pool.query('select 1 from institution limit 1');
  if (existing.rowCount) return false;

  const ctx = await auth.$context;
  const authUser = await ctx.internalAdapter.createUser({ email, name: email, emailVerified: true }, { method: 'admin' });
  await ctx.internalAdapter.linkAccount({
    userId: authUser.id, providerId: 'credential', accountId: authUser.id, password: await ctx.password.hash(password),
  });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: [inst] } = await client.query(`insert into institution (name_en) values ($1) returning id`, [name]);
    const { rows: [user] } = await client.query(
      `insert into app_user (institution_id, auth_user_id, full_name, email) values ($1, $2, $3, $3) returning id`,
      [inst.id, authUser.id, email]);
    await client.query(
      `insert into role_assignment (institution_id, user_id, role, scope_type, scope_id)
       values ($1, $2, 'admin', 'institution', $1)`, [inst.id, user.id]);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
  return true;
}
