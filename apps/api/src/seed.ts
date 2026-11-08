import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { autoMapStandards, getQualityFramework, importVersion, publishVersion, seedDefaultGlossary, setUpQualityFramework, submitForReview, validateVersion, type Ctx } from '@ams/core';
import { FrameworkExportSchema } from '@ams/shared';
import { fixturesFolder, withIdentity } from '@ams/db';
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

/**
 * After the first start: the first institution administrator's sign-in email follows ADMIN_EMAIL, and their displayed name follows
 * ADMIN_NAME when it is set. The password never follows the environment (a person changes it). Nothing changes when ADMIN_EMAIL is
 * already used by another account. Returns what changed.
 */
export async function syncAdmin(pool: pg.Pool, env: Pick<Env, 'ADMIN_EMAIL' | 'ADMIN_NAME'>): Promise<string[]> {
  const { rows: [admin] } = await pool.query<{ id: string; auth_id: string; email: string; full_name: string }>(
    `select u.id, u.auth_user_id as auth_id, au.email, u.full_name from app_user u
       join role_assignment r on r.user_id = u.id and r.role = 'admin' and r.scope_type = 'institution'
       join "user" au on au.id = u.auth_user_id
      order by u.created_at limit 1`);
  if (!admin) return [];
  const changed: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    const email = env.ADMIN_EMAIL?.trim();
    if (email && email.toLowerCase() !== admin.email.toLowerCase()) {
      const { rowCount } = await client.query(`select 1 from "user" where lower(email) = lower($1) union all select 1 from app_user where lower(email) = lower($1) and id <> $2`, [email, admin.id]);
      if (!rowCount) {
        await client.query(`update "user" set email = $1, "updatedAt" = now() where id = $2`, [email, admin.auth_id]);
        // A name that was only the old email follows the new one.
        await client.query(`update app_user set email = $1, full_name = case when full_name = $2 then $1 else full_name end where id = $3`, [email, admin.email, admin.id]);
        changed.push('email');
      }
    }
    const name = env.ADMIN_NAME;
    if (name) {
      const { rowCount } = await client.query(`update app_user set full_name = $1 where id = $2 and full_name <> $1`, [name, admin.id]);
      await client.query(`update "user" set name = $1, "updatedAt" = now() where id = $2 and name <> $1`, [name, admin.auth_id]);
      if (rowCount) changed.push('name');
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
  return changed;
}

/**
 * Optional demo data: imports and publishes each framework file in the fixtures folder that is not already in the
 * library (matched by accreditor short name and edition), as the institution's administrator. It goes through the
 * same importer and publish gate as a person would, so nothing is written that the UI could not write. Safe to run
 * on every start.
 */
export async function seedFrameworks(pool: pg.Pool, folder: string = fixturesFolder): Promise<string[]> {
  const { rows: [who] } = await pool.query(
    `select u.id as user_id, u.institution_id from app_user u join role_assignment r on r.user_id = u.id
      where r.role = 'admin' and r.scope_type = 'institution' order by u.created_at limit 1`);
  if (!who) return [];
  const added: string[] = [];
  for (const name of readdirSync(folder).filter((f) => f.endsWith('.json')).sort()) {
    const file = FrameworkExportSchema.parse(JSON.parse(readFileSync(join(folder, name), 'utf8')));
    const { rowCount } = await pool.query(
      `select 1 from framework_version fv join framework f on f.id = fv.framework_id join accreditor a on a.id = f.accreditor_id
        where a.short_name = $1 and fv.edition = $2`, [file.accreditor.short_name, file.version.edition]);
    if (rowCount) continue;
    const caller = { userId: who.user_id as string, institutionId: who.institution_id as string, requestId: crypto.randomUUID(), actorType: 'user' as const };
    await withIdentity(pool, caller, async (tx) => {
      const ctx: Ctx = { tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined };
      const { version } = await importVersion(ctx, file);
      const check = await validateVersion(ctx, version.id);
      if (!check.ok) throw new Error(`${name}: ${JSON.stringify(check)}`);
      await submitForReview(ctx, version.id);
      await publishVersion(ctx, version.id);
    });
    added.push(name);
  }
  return added;
}

/**
 * Starter glossary: the default internal terms, and a structural suggestion for how each standard's words map onto them,
 * applied only to what is not mapped yet (edits are never overwritten). Runs as the institution's administrator on every start.
 */
export async function seedGlossary(pool: pg.Pool): Promise<{ terms: number; mapped: number }> {
  const { rows: [who] } = await pool.query(
    `select u.id as user_id, u.institution_id from app_user u join role_assignment r on r.user_id = u.id
      where r.role = 'admin' and r.scope_type = 'institution' order by u.created_at limit 1`);
  if (!who) return { terms: 0, mapped: 0 };
  const caller = { userId: who.user_id as string, institutionId: who.institution_id as string, requestId: crypto.randomUUID(), actorType: 'user' as const };
  return withIdentity(pool, caller, async (tx) => {
    const ctx: Ctx = { tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined };
    // The glossary's level terms are the quality framework's level names, so an empty framework with default levels
    // is set up first when there is none; the institution renames and fills it in Settings.
    if (!(await getQualityFramework(ctx)).framework) await setUpQualityFramework(ctx, { template: true });
    const { added } = await seedDefaultGlossary(ctx);
    const { mapped } = await autoMapStandards(ctx);
    return { terms: added, mapped };
  });
}
