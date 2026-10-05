// Instantiation (PRD 8.3) against the real published Appendix A frameworks.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engagement, engagementRequirement, requirement, roleAssignment, withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { FrameworkExportSchema } from '@ams/shared';
import type { Ctx } from '../index.js';
import { importVersion, publishVersion, submitForReview } from '../framework/index.js';
import { instantiateRequirements } from './instantiate.js';

const FIXTURES = resolve(import.meta.dirname, '../../../db/fixtures');
const load = (name: string) => JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as unknown;

let db: TestDb;
let pool: pg.Pool;
const ids = {} as Record<string, string>;

const run = <T>(fn: (ctx: Ctx) => Promise<T>) => {
  const caller = { userId: ids.admin!, institutionId: ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  return withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined }));
};

async function publishFixture(name: string): Promise<string> {
  return run(async (ctx) => {
    const { version } = await importVersion(ctx, load(name), { autoApprove: true });
    await submitForReview(ctx, version.id);
    await publishVersion(ctx, version.id);
    return version.id;
  });
}

async function engage(versionId: string, subject: { type: 'institution' | 'program'; id: string }, kind: 'initial' | 'reaffirmation') {
  return run(async (ctx) => {
    const [e] = await ctx.tx.insert(engagement).values({
      institutionId: ids.inst!, frameworkVersionId: versionId, subjectType: subject.type, subjectId: subject.id, kind,
      title: 'test', reviewYear: 2027, leadUserId: ids.admin!,
    }).returning();
    await ctx.tx.insert(roleAssignment).values({ institutionId: ids.inst!, userId: ids.admin!, role: 'engagement_lead', scopeType: 'engagement', scopeId: e!.id });
    const counts = await instantiateRequirements(ctx, e!);
    const rows = await ctx.tx.select({ code: requirement.code, applicable: engagementRequirement.applicable })
      .from(engagementRequirement).innerJoin(requirement, eq(requirement.id, engagementRequirement.requirementId))
      .where(eq(engagementRequirement.engagementId, e!.id));
    return { counts, rows };
  });
}

beforeAll(async () => {
  db = await createTestDb('instantiate');
  pool = new pg.Pool({ connectionString: db.url });
  const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  ids.admin = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'Admin', 'a@x.org') returning id`, [ids.inst]);
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.inst, ids.admin]);
  const unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.mech = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Mechanical Engineering', 'bachelor', '{mechanical}') returning id`, [ids.inst, unit]);
  ids.civil = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Civil Engineering', 'bachelor', '{civil}') returning id`, [ids.inst, unit]);
  ids.abet = await publishFixture('abet-eac-2027-28');
  ids.wscuc = await publishFixture('wscuc-2023');
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('requirement instantiation', () => {
  it('creates one row per assessable requirement, switching on only those that match', async () => {
    const assessable = FrameworkExportSchema.parse(load('abet-eac-2027-28')).requirements.filter((r) => r.is_assessable);
    const { counts, rows } = await engage(ids.abet!, { type: 'program', id: ids.mech! }, 'initial');
    expect(rows).toHaveLength(assessable.length);
    expect(counts.applicable + counts.notApplicable).toBe(assessable.length);
    const on = new Set(rows.filter((r) => r.applicable).map((r) => r.code));
    expect(on.has('Criterion 1')).toBe(true);
    expect(on.has('Criterion 5(a)')).toBe(true);
    expect(on.has('Mechanical 1')).toBe(true);
    expect(on.has('I.C.5.a')).toBe(true);
    expect(rows.filter((r) => !r.applicable)).toEqual([]); // every ABET requirement applies to a mechanical program
  });

  it('keeps the Mechanical Program Criteria visible but switched off for another discipline', async () => {
    const { rows } = await engage(ids.abet!, { type: 'program', id: ids.civil! }, 'initial');
    const off = rows.filter((r) => !r.applicable).map((r) => r.code).sort();
    expect(off).toEqual(['Mechanical 1', 'Mechanical 2', 'Program Criteria: Mechanical']);
  });

  it('switches off program-only requirements for an institution subject', async () => {
    const { rows } = await engage(ids.abet!, { type: 'institution', id: ids.inst! }, 'initial');
    const off = new Set(rows.filter((r) => !r.applicable).map((r) => r.code));
    expect(off.has('Mechanical 1')).toBe(true);
    expect(off.has('I.C.5.a')).toBe(true); // I.C is scoped to programs
    expect(off.has('Criterion 1')).toBe(false);
  });

  it('applies every WSCUC requirement to an institution', async () => {
    const assessable = FrameworkExportSchema.parse(load('wscuc-2023')).requirements.filter((r) => r.is_assessable);
    const { counts, rows } = await engage(ids.wscuc!, { type: 'institution', id: ids.inst! }, 'reaffirmation');
    expect(rows).toHaveLength(assessable.length);
    expect(counts.notApplicable).toBe(0);
  });
});
