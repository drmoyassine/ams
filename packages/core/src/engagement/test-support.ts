// Shared fixture for the engagement tests: a throwaway database with the three Appendix A frameworks published,
// a handful of users with different roles, and two ready-made engagements.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import type { CreateEngagement } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { importVersion, publishVersion, submitForReview } from '../framework/index.js';
import { createEngagement } from './engagements.js';

const FIXTURES = resolve(import.meta.dirname, '../../../db/fixtures');
export const loadFixture = (name: string) => JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as unknown;

export interface World {
  db: TestDb;
  pool: pg.Pool;
  ids: Record<string, string>;
  as<T>(who: string, fn: (ctx: Ctx) => Promise<T>): Promise<T>;
  create(who: string, over: Partial<CreateEngagement> & Pick<CreateEngagement, 'subjectType' | 'subjectId' | 'kind'>): ReturnType<typeof createEngagement>;
  close(): Promise<void>;
}

/** Users: admin (institution admin), alo (institution lead), coord (lead of the mechanical program), contrib, second, outsider. */
export async function buildWorld(label: string): Promise<World> {
  const db = await createTestDb(label);
  const pool = new pg.Pool({ connectionString: db.url });
  const ids: Record<string, string> = {};
  const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'alo', 'coord', 'contrib', 'second', 'outsider']) {
    ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $3) returning id`, [ids.inst, n, `${n}@x.org`]);
  }
  const unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.mech = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Mechanical Engineering', 'bachelor', '{mechanical}') returning id`, [ids.inst, unit]);
  const grant = (u: string, role: string, scope: string, scopeId: string) =>
    db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids.inst, ids[u], role, scope, scopeId]);
  await grant('admin', 'admin', 'institution', ids.inst!);
  await grant('alo', 'lead', 'institution', ids.inst!);
  await grant('coord', 'lead', 'program', ids.mech!);
  await grant('contrib', 'contributor', 'program', ids.mech!);

  const as: World['as'] = (who, fn) => {
    const caller = { userId: ids[who]!, institutionId: ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const };
    return withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined }));
  };
  for (const [key, name] of [['abet', 'abet-eac-2027-28'], ['wscuc', 'wscuc-2023'], ['puc', 'puc-2019']] as const) {
    ids[key] = await as('admin', async (ctx) => {
      const { version } = await importVersion(ctx, loadFixture(name), { autoApprove: true });
      await submitForReview(ctx, version.id);
      await publishVersion(ctx, version.id);
      return version.id;
    });
  }
  return {
    db, pool, ids, as,
    create: (who, over) => as(who, (ctx) => createEngagement(ctx, { frameworkVersionId: ids.abet!, reviewYear: 2027, leadUserId: ids.coord!, ...over })),
    close: async () => { await pool.end(); await db.close(); },
  };
}
