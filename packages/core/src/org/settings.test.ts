// Settings services: institution identity and branding, the org chart, and program edits, with who may do what.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { ConflictError, ForbiddenError, ValidationError, type Ctx } from '../ctx.js';
import { getInstitution, updateInstitution } from './institution.js';
import { updateProgram } from './programs.js';
import { moveOrgUnits } from './unit-move.js';
import { createOrgUnit, listOrgUnits, updateOrgUnit } from './units.js';

let db: TestDb;
let pool: pg.Pool;
const ids = {} as Record<string, string>;
const as = <T>(who: string, fn: (ctx: Ctx) => Promise<T>) => {
  const caller = { userId: ids[who]!, institutionId: ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  return withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined }));
};
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;

beforeAll(async () => {
  db = await createTestDb('settings');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'leadA', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  ids.colA = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'College A') returning id`, [ids.inst]);
  ids.colB = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'College B') returning id`, [ids.inst]);
  ids.progA = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BS Physics', 'bachelor') returning id`, [ids.inst, ids.colA]);
  const grant = (u: string, role: string, scope: string, scopeId: string) =>
    db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids.inst, ids[u], role, scope, scopeId]);
  await grant('admin', 'admin', 'institution', ids.inst!);
  await grant('leadA', 'lead', 'org_unit', ids.colA!);
  await grant('viewer', 'viewer', 'institution', ids.inst!);
}, 30000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('institution identity and branding', () => {
  it('is readable by everyone and changed only by an admin', async () => {
    expect(await as('viewer', (c) => getInstitution(c))).toMatchObject({ nameEn: 'Gulf University', nameAr: null, accentColor: null, defaultLocale: 'en' });
    const out = await as('admin', (c) => updateInstitution(c, { nameEn: 'Gulf University of Science', nameAr: 'جامعة الخليج', country: 'KW', defaultLocale: 'ar', accentColor: '#1F4E79' }));
    expect(out).toEqual({ id: ids.inst, nameEn: 'Gulf University of Science', nameAr: 'جامعة الخليج', country: 'KW', defaultLocale: 'ar', accentColor: '#1f4e79', logoVersion: null });
    await expect(as('leadA', (c) => updateInstitution(c, { nameEn: 'x' }))).rejects.toThrow(ForbiddenError);
    await expect(as('viewer', (c) => updateInstitution(c, { nameEn: 'x' }))).rejects.toThrow(ForbiddenError);
  });

  it('refuses a colour that white text cannot be read on, or that is not #rrggbb, and clears it with null', async () => {
    await expect(as('admin', (c) => updateInstitution(c, { accentColor: '#ffee00' }))).rejects.toThrow(ValidationError);
    await expect(as('admin', (c) => updateInstitution(c, { accentColor: 'blue' }))).rejects.toThrow(ValidationError);
    expect((await as('admin', (c) => updateInstitution(c, { accentColor: null }))).accentColor).toBeNull();
  });
});

describe('org chart', () => {
  it('lets whoever may write at a place add units there, and no one else', async () => {
    const top = await as('admin', (c) => createOrgUnit(c, { parentId: null, type: 'college', nameEn: 'College C', nameAr: 'كلية ج' }));
    expect(top).toMatchObject({ parentId: null, nameAr: 'كلية ج', active: true });
    ids.deptA = (await as('leadA', (c) => createOrgUnit(c, { parentId: ids.colA!, type: 'department', nameEn: 'Physics Dept' }))).id;
    await expect(as('leadA', (c) => createOrgUnit(c, { parentId: ids.colB!, type: 'department', nameEn: 'x' }))).rejects.toThrow(ForbiddenError);
    await expect(as('leadA', (c) => createOrgUnit(c, { parentId: null, type: 'college', nameEn: 'x' }))).rejects.toThrow(ForbiddenError);
    await expect(as('viewer', (c) => createOrgUnit(c, { parentId: ids.colA!, type: 'department', nameEn: 'x' }))).rejects.toThrow(ForbiddenError);
    expect((await as('viewer', (c) => listOrgUnits(c))).map((u) => u.nameEn)).toEqual(['College A', 'Physics Dept', 'College B', 'College C']);
  });

  it('renames and retypes, and moves a unit only where the caller may write at both ends', async () => {
    expect(await as('leadA', (c) => updateOrgUnit(c, ids.deptA!, { nameEn: 'Department of Physics', type: 'school' }))).toMatchObject({ nameEn: 'Department of Physics', type: 'school' });
    const to = (parentId: string) => ({ moves: [{ id: ids.deptA!, parentId, index: 0 }] });
    await expect(as('leadA', (c) => moveOrgUnits(c, to(ids.colB!)))).rejects.toThrow(ForbiddenError);
    await as('admin', (c) => moveOrgUnits(c, to(ids.colB!)));
    expect((await as('admin', (c) => listOrgUnits(c))).find((u) => u.id === ids.deptA)!.parentId).toBe(ids.colB);
    await as('admin', (c) => moveOrgUnits(c, to(ids.colA!)));
  });

  it('never creates a cycle', async () => {
    await expect(as('admin', (c) => moveOrgUnits(c, { moves: [{ id: ids.colA!, parentId: ids.deptA!, index: 0 }] }))).rejects.toThrow(/under itself/);
    await expect(as('admin', (c) => moveOrgUnits(c, { moves: [{ id: ids.colA!, parentId: ids.colA!, index: 0 }] }))).rejects.toThrow(/under itself/);
  });

  it('deactivates only a unit with nothing active under it, and reactivates only under an active parent', async () => {
    await expect(as('admin', (c) => updateOrgUnit(c, ids.colA!, { active: false }))).rejects.toThrow(/deactivate its sub-units first/);
    await as('admin', (c) => updateOrgUnit(c, ids.deptA!, { active: false }));
    await expect(as('admin', (c) => updateOrgUnit(c, ids.colA!, { active: false }))).rejects.toThrow(/move or deactivate its programs first/);
    await expect(as('admin', (c) => createOrgUnit(c, { parentId: ids.deptA!, type: 'other', nameEn: 'x' }))).rejects.toThrow(ConflictError);
    await as('admin', (c) => updateOrgUnit(c, ids.deptA!, { active: true }));
  });

  it('is audited', async () => {
    const { rows } = await db.su.query(`select count(*)::int as n from audit_event where target_type = 'org_unit' and target_id = $1`, [ids.deptA]);
    expect(rows[0].n).toBeGreaterThanOrEqual(3);
  });
});

describe('program edits', () => {
  it('edits within the caller\'s scope, de-duplicates tags and keeps Arabic names', async () => {
    const out = await as('leadA', (c) => updateProgram(c, ids.progA!, { nameEn: 'BS Applied Physics', nameAr: 'بكالوريوس الفيزياء التطبيقية', tags: ['physics', 'science', 'physics'], discipline: 'Physics' }));
    expect(out).toMatchObject({ nameEn: 'BS Applied Physics', nameAr: 'بكالوريوس الفيزياء التطبيقية', tags: ['physics', 'science'], discipline: 'Physics', active: true });
    await expect(as('viewer', (c) => updateProgram(c, ids.progA!, { nameEn: 'x' }))).rejects.toThrow(ForbiddenError);
  });

  it('moves a program only where the caller may write, and never into an inactive unit', async () => {
    await expect(as('leadA', (c) => updateProgram(c, ids.progA!, { orgUnitId: ids.colB! }))).rejects.toThrow(ForbiddenError);
    ids.colD = await one(`insert into org_unit (institution_id, type, name_en, active) values ($1, 'college', 'Closed College', false) returning id`, [ids.inst]);
    await expect(as('admin', (c) => updateProgram(c, ids.progA!, { orgUnitId: ids.colD! }))).rejects.toThrow(/inactive unit/);
    expect((await as('admin', (c) => updateProgram(c, ids.progA!, { orgUnitId: ids.colB! }))).orgUnitId).toBe(ids.colB);
  });

  it('deactivates and reactivates a program', async () => {
    expect((await as('admin', (c) => updateProgram(c, ids.progA!, { active: false }))).active).toBe(false);
    expect((await as('admin', (c) => updateProgram(c, ids.progA!, { active: true }))).active).toBe(true);
  });
});
