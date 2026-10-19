// Installing the shipped default templates (TASK-079): published with origin "default", idempotent by key, never overwriting what the
// institution changed, launchable straight away, manage-only, and scoped to the institution.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { DEFAULT_CYCLE_TEMPLATE_KEYS, LaunchCycleSchema } from '@ams/shared';
import { ForbiddenError, type Ctx } from '../ctx.js';
import { MemoryStore } from '../evidence/memory-store.js';
import { installDefaultTemplates, launchCycle, listTemplates, reviseTemplate, updateTemplate, publishTemplate, retireTemplate } from './index.js';

let db: TestDb;
let pool: pg.Pool;
const store = new MemoryStore();
const ids = {} as Record<string, string>;
const as = <T>(who: string, fn: (ctx: Ctx) => Promise<T>, inst = 'inst') => {
  const caller = { userId: ids[who]!, institutionId: ids[inst]!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  return withIdentity(pool, caller, (tx) => fn({ tx, caller, store, queue: { send: async () => undefined }, afterCommit: () => undefined, undo: () => undefined }));
};
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;

beforeAll(async () => {
  db = await createTestDb('cycledefaults');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('Other University') returning id`);
  for (const n of ['lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  ids.otherAdmin = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'oa', 'oa') returning id`, [ids.other]);
  const grant = (inst: string, u: string, role: string) => db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids[inst], ids[u], role]);
  await grant('inst', 'lead', 'lead');
  await grant('inst', 'viewer', 'viewer');
  await grant('other', 'otherAdmin', 'admin');
  ids.dept = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'department', 'Physics') returning id`, [ids.inst]);
  ids.prog = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BSc Physics', 'bachelor') returning id`, [ids.inst, ids.dept]);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('installDefaultTemplates', () => {
  it('writes every default as a published version-1 template with origin "default", and only managers may', async () => {
    await expect(as('viewer', (c) => installDefaultTemplates(c))).rejects.toThrow(ForbiddenError);
    const r = await as('lead', (c) => installDefaultTemplates(c));
    expect(r.installed).toEqual([...DEFAULT_CYCLE_TEMPLATE_KEYS]);
    expect(r.existing).toEqual([]);
    const all = await as('viewer', (c) => listTemplates(c));
    expect(all).toHaveLength(DEFAULT_CYCLE_TEMPLATE_KEYS.length);
    for (const t of all) expect(t).toMatchObject({ status: 'published', version: 1, origin: 'default', cycleCount: 0 });
    expect(all.find((t) => t.key === 'annual_program_report')).toMatchObject({ name: 'Annual program report', nameAr: 'التقرير السنوي للبرنامج' });
  });

  it('is idempotent: a second run adds nothing and changes nothing', async () => {
    const before = await as('lead', (c) => listTemplates(c));
    const r = await as('lead', (c) => installDefaultTemplates(c));
    expect(r.installed).toEqual([]);
    expect(r.existing).toEqual([...DEFAULT_CYCLE_TEMPLATE_KEYS]);
    expect(await as('lead', (c) => listTemplates(c))).toEqual(before);
  });

  it('restores only what is missing and never overwrites an edited or retired default', async () => {
    const annual = (await as('lead', (c) => listTemplates(c))).find((t) => t.key === 'annual_program_report')!;
    await as('lead', (c) => reviseTemplate(c, annual.id));
    await as('lead', (c) => updateTemplate(c, annual.id, { name: 'Our annual report' }));
    await as('lead', (c) => publishTemplate(c, annual.id));
    const audit = (await as('lead', (c) => listTemplates(c))).find((t) => t.key === 'internal_audit')!;
    await as('lead', (c) => retireTemplate(c, audit.id));
    // One default was never installed (as when a later release ships a new one): remove it behind the service's back (triggers off).
    await db.su.query(`begin; set local session_replication_role = replica; delete from cycle_template where key = 'custom' and institution_id = '${ids.inst}'; commit;`);
    const r = await as('lead', (c) => installDefaultTemplates(c));
    expect(r.installed).toEqual(['custom']);
    const now = await as('lead', (c) => listTemplates(c));
    expect(now.find((t) => t.key === 'annual_program_report')).toMatchObject({ name: 'Our annual report', version: 2 });
    expect(now.find((t) => t.key === 'internal_audit')).toMatchObject({ status: 'retired' });
  });

  it('gives templates that launch: stages with their inputs wired', async () => {
    const t = (await as('lead', (c) => listTemplates(c))).find((x) => x.key === 'course_assessment')!;
    const c = await as('lead', (ctx) => launchCycle(ctx, LaunchCycleSchema.parse({ templateId: t.id, anchorKind: 'program', anchorId: ids.prog!, startDate: '2026-09-01' })));
    expect(c.stages.map((s) => s.key)).toEqual(['collect', 'analyse', 'report', 'close_loop']);
    expect(c.stages[1]!.inputs[0]).toMatchObject({ source: 'stage_output', outputName: 'Course results' });
  });

  it('is per institution: another institution has none until it installs its own', async () => {
    expect(await as('otherAdmin', (c) => listTemplates(c), 'other')).toEqual([]);
    expect((await as('otherAdmin', (c) => installDefaultTemplates(c), 'other')).installed).toHaveLength(DEFAULT_CYCLE_TEMPLATE_KEYS.length);
  });
});
