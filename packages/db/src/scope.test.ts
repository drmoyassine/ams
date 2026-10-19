// Scope levels, requirement scope and requirement champion in the database (TASK-086, migration 0061): seeded levels (also for a
// new institution), tenant isolation, the worker may read and never write, one scope and one champion per requirement and item,
// everything a row names belongs to the same institution, and the audit trail. These tables sit outside the frozen framework
// tables, so they can be written for a published version.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const q = (sql: string, p: unknown[] = []) => db.su.query(sql, p);
const asA = { get userId() { return ids.ua!; }, get institutionId() { return ids.a!; } };

beforeAll(async () => {
  db = await createTestDb('scopetables');
  ids.a = await one(`insert into institution (name_en) values ('A') returning id`);
  ids.b = await one(`insert into institution (name_en) values ('B') returning id`);
  ids.ua = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ua', 'ua') returning id`, [ids.a]);
  ids.ub = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ub', 'ub') returning id`, [ids.b]);
  ids.unitA = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'CA') returning id`, [ids.a]);
  ids.unitB = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'CB') returning id`, [ids.b]);
  ids.progA = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'PA', 'bachelor') returning id`, [ids.a, ids.unitA]);
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'A', 'A', 'institutional') returning id`, [ids.a]);
  ids.fwA = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'F', 'institution') returning id`, [ids.a, acc]);
}, 60000);
afterAll(async () => { await db.close(); });

const scope = (inst = ids.a!, fw = ids.fwA!, code = 'S1', level = 'program', items: string[] = []) => q(
  `insert into requirement_scope (institution_id, framework_id, code, level_key, item_ids) values ($1, $2, $3, $4, $5::uuid[]) returning id`, [inst, fw, code, level, items]);

describe('scope levels', () => {
  it('every institution has Institution, Unit, Program and Course, in order, from its first moment', async () => {
    for (const inst of [ids.a!, ids.b!]) {
      const { rows } = await q(`select key, kind, display_order, active from scope_level where institution_id = $1 order by display_order`, [inst]);
      expect(rows.map((r) => [r.key, r.kind, r.display_order, r.active])).toEqual([['institution', 'institution', 0, true], ['unit', 'org_unit', 1, true], ['program', 'program', 2, true], ['course', 'course', 3, true]]);
    }
  });

  it('keeps each institution to its own levels; the worker reads and never writes; keys and kinds are checked', async () => {
    expect((await db.as(asA, (c) => c.query(`select id from scope_level`))).rows).toHaveLength(4);
    const theirs = await db.as({ userId: ids.ub!, institutionId: ids.b! }, (c) => c.query(`update scope_level set label_en = 'x' where institution_id = $1`, [ids.a]));
    expect(theirs.rowCount).toBe(0);
    expect((await db.as({ ...asA, role: 'ams_worker' }, (c) => c.query(`select id from scope_level`))).rows).toHaveLength(4);
    await expect(db.as({ ...asA, role: 'ams_worker' }, (c) => c.query(`update scope_level set active = false`))).rejects.toThrow(/permission denied/);
    await expect(q(`insert into scope_level (institution_id, key, label_en, kind) values ($1, 'Bad Key', 'x', 'custom')`, [ids.a])).rejects.toThrow(/scope_level_key_check/);
    await expect(q(`insert into scope_level (institution_id, key, label_en, kind) values ($1, 'ok', 'x', 'galaxy')`, [ids.a])).rejects.toThrow(/scope_level_kind_check/);
    await expect(q(`insert into scope_level (institution_id, key, label_en, kind) values ($1, 'unit', 'dup', 'custom')`, [ids.a])).rejects.toThrow(/scope_level_key_idx/);
  });

  it('is audited', async () => {
    await db.as(asA, (c) => c.query(`update scope_level set label_en = 'Institution wide' where institution_id = $1 and key = 'institution'`, [ids.a]));
    const { rows } = await q(`select count(*)::int as n from audit_event where target_type = 'scope_level' and institution_id = $1`, [ids.a]);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

describe('requirement scope', () => {
  it('holds one scope per requirement, names a level of the institution, and lists only its own units or programs', async () => {
    await scope(ids.a!, ids.fwA!, 'S1', 'unit', [ids.unitA!]);
    await expect(scope(ids.a!, ids.fwA!, 'S1', 'program')).rejects.toThrow(/requirement_scope_unique_idx/);
    await expect(scope(ids.a!, ids.fwA!, 'S2', 'galaxy')).rejects.toThrow(/requirement_scope_level_fk/);
    await expect(scope(ids.a!, ids.fwA!, 'S3', 'unit', [ids.unitB!])).rejects.toThrow(/units of the same institution/);
    await expect(scope(ids.a!, ids.fwA!, 'S3', 'unit', [ids.progA!])).rejects.toThrow(/units of the same institution/);
    await expect(scope(ids.a!, ids.fwA!, 'S3', 'program', [ids.unitA!])).rejects.toThrow(/programs of the same institution/);
    await expect(scope(ids.a!, ids.fwA!, 'S3', 'course', [ids.unitA!])).rejects.toThrow(/no list of items/);
    await scope(ids.a!, ids.fwA!, 'S3', 'course', []);   // empty = all courses (the placeholder level)
    await scope(ids.a!, ids.fwA!, 'S4', 'program', [ids.progA!]);
  });

  it('is isolated by institution, takes a framework of the same institution only, and is audited', async () => {
    expect((await db.as(asA, (c) => c.query(`select id from requirement_scope`))).rows.length).toBeGreaterThan(0);
    expect((await db.as({ userId: ids.ub!, institutionId: ids.b! }, (c) => c.query(`select id from requirement_scope`))).rows).toEqual([]);
    await expect(db.as({ userId: ids.ub!, institutionId: ids.b! }, (c) => c.query(
      `insert into requirement_scope (institution_id, framework_id, code, level_key) values ($1, $2, 'X', 'unit')`, [ids.a, ids.fwA]))).rejects.toThrow(/row-level security|same institution/);
    await expect(q(`insert into requirement_scope (institution_id, framework_id, code, level_key) values ($1, $2, 'X', 'unit')`, [ids.b, ids.fwA])).rejects.toThrow(/standard must be one of the same institution/);
    await expect(db.as({ ...asA, role: 'ams_worker' }, (c) => c.query(`delete from requirement_scope`))).rejects.toThrow(/permission denied/);
    const { rows } = await q(`select count(*)::int as n from audit_event where target_type = 'requirement_scope'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

describe('requirement champion', () => {
  const champ = (user: string, kind: string | null = null, item: string | null = null, code = 'C1', inst = ids.a!) => q(
    `insert into requirement_champion (institution_id, framework_id, code, scope_item_kind, scope_item_id, user_id) values ($1, $2, $3, $4, $5, $6) returning id`, [inst, ids.fwA, code, kind, item, user]);

  it('holds one overall champion and one per unit or program, per requirement', async () => {
    await champ(ids.ua!);
    await expect(champ(ids.ua!)).rejects.toThrow(/requirement_champion_unique_idx/);
    await champ(ids.ua!, 'org_unit', ids.unitA!);
    await expect(champ(ids.ua!, 'org_unit', ids.unitA!)).rejects.toThrow(/requirement_champion_unique_idx/);
    await champ(ids.ua!, 'program', ids.progA!);
    await champ(ids.ua!, null, null, 'C2');
  });

  it('is all-or-nothing about the item, a known kind, and people and items of the same institution', async () => {
    await expect(champ(ids.ua!, 'org_unit', null, 'C9')).rejects.toThrow(/requirement_champion_item_check|unit of the same institution/);
    await expect(champ(ids.ua!, null, ids.unitA!, 'C9')).rejects.toThrow(/requirement_champion_item_check/);
    await expect(champ(ids.ua!, 'course', ids.unitA!, 'C9')).rejects.toThrow(/requirement_champion_item_kind_check/);
    await expect(champ(ids.ub!, null, null, 'C9')).rejects.toThrow(/person of the same institution/);
    await expect(champ(ids.ua!, 'org_unit', ids.unitB!, 'C9')).rejects.toThrow(/unit of the same institution/);
    await expect(champ(ids.ua!, 'program', ids.unitA!, 'C9')).rejects.toThrow(/program of the same institution/);
  });

  it('is isolated by institution, never written by the worker, and audited', async () => {
    expect((await db.as({ userId: ids.ub!, institutionId: ids.b! }, (c) => c.query(`select id from requirement_champion`))).rows).toEqual([]);
    expect((await db.as({ ...asA, role: 'ams_worker' }, (c) => c.query(`select id from requirement_champion`))).rows.length).toBeGreaterThan(0);
    await expect(db.as({ ...asA, role: 'ams_worker' }, (c) => c.query(`update requirement_champion set user_id = $1`, [ids.ua]))).rejects.toThrow(/permission denied/);
    const { rows } = await q(`select count(*)::int as n from audit_event where target_type = 'requirement_champion'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});
