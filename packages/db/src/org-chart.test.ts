// Org chart rules in the database (TASK-072, migration 0053): unit types are per institution (RLS) and seeded, a unit's type must
// exist and a type in use cannot be removed, the head is a person of the same institution (and one of two forms), the source
// is one of three, a person's update marks the unit (the worker's does not), and the Trash accepts the new kind.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;

beforeAll(async () => {
  db = await createTestDb('orgchartdb');
  ids.a = await one(`insert into institution (name_en) values ('A') returning id`);
  ids.b = await one(`insert into institution (name_en) values ('B') returning id`);
  ids.ua = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ua', 'ua') returning id`, [ids.a]);
  ids.ub = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ub', 'ub') returning id`, [ids.b]);
  ids.unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'C') returning id`, [ids.a]);
}, 60000);
afterAll(async () => { await db.close(); });

describe('unit types', () => {
  it('are seeded for every institution with the five defaults, in order', async () => {
    for (const inst of [ids.a, ids.b]) {
      const { rows } = await db.su.query(`select key, label_en, label_ar, display_order from org_unit_type where institution_id = $1 order by display_order`, [inst]);
      expect(rows.map((r) => r.key)).toEqual(['college', 'school', 'department', 'admin_unit', 'other']);
      expect(rows[0]).toMatchObject({ label_en: 'College', label_ar: 'كلية', display_order: 0 });
    }
  });

  it('are isolated by tenant: an institution sees and changes only its own', async () => {
    const mine = await db.as({ userId: ids.ua!, institutionId: ids.a! }, (c) => c.query(`select institution_id from org_unit_type`));
    expect(new Set(mine.rows.map((r) => r.institution_id))).toEqual(new Set([ids.a]));
    const upd = await db.as({ userId: ids.ua!, institutionId: ids.a! }, (c) => c.query(`update org_unit_type set label_en = 'x' where institution_id = $1`, [ids.b]));
    expect(upd.rowCount).toBe(0);
    await expect(db.as({ userId: ids.ua!, institutionId: ids.a! }, (c) => c.query(`insert into org_unit_type (institution_id, key, label_en) values ($1, 'x', 'x')`, [ids.b]))).rejects.toThrow(/row-level security/);
    const units = await db.as({ userId: ids.ub!, institutionId: ids.b! }, (c) => c.query(`select id from org_unit`));
    expect(units.rows).toEqual([]);
  });

  it('cannot be removed while a unit uses them, and a unit cannot name a missing type', async () => {
    await expect(db.su.query(`delete from org_unit_type where institution_id = $1 and key = 'college'`, [ids.a])).rejects.toThrow(/foreign key/);
    await expect(db.su.query(`insert into org_unit (institution_id, type, name_en) values ($1, 'nope', 'x')`, [ids.a])).rejects.toThrow(/foreign key/);
    // A key of another institution does not count.
    await db.su.query(`insert into org_unit_type (institution_id, key, label_en) values ($1, 'lab', 'Lab')`, [ids.b]);
    await expect(db.su.query(`insert into org_unit (institution_id, type, name_en) values ($1, 'lab', 'x')`, [ids.a])).rejects.toThrow(/foreign key/);
    await expect(db.su.query(`insert into org_unit_type (institution_id, key, label_en) values ($1, 'college', 'dup')`, [ids.a])).rejects.toThrow(/duplicate key/);
    await expect(db.su.query(`insert into org_unit_type (institution_id, key, label_en) values ($1, 'Bad Key', 'x')`, [ids.a])).rejects.toThrow(/org_unit_type_key_check/);
  });

  it('are audited like the units', async () => {
    const { rows } = await db.su.query(`select count(*)::int n from audit_event where target_type = 'org_unit_type'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

describe('unit columns', () => {
  it('default to manual, unlocked, unedited, order 0; the source is one of three', async () => {
    const { rows } = await db.su.query(`select source, locked, edited_by_person, display_order, head_user_id, head_name, description from org_unit where id = $1`, [ids.unit]);
    expect(rows[0]).toEqual({ source: 'manual', locked: false, edited_by_person: false, display_order: 0, head_user_id: null, head_name: null, description: null });
    await expect(db.su.query(`update org_unit set source = 'guess' where id = $1`, [ids.unit])).rejects.toThrow(/org_unit_source_check/);
    for (const s of ['image', 'directory', 'manual']) await db.su.query(`update org_unit set source = $2 where id = $1`, [ids.unit, s]);
  });

  it('take a head that is a person of the same institution, or a name, never both', async () => {
    await db.su.query(`update org_unit set head_user_id = $2 where id = $1`, [ids.unit, ids.ua]);
    await expect(db.su.query(`update org_unit set head_user_id = $2 where id = $1`, [ids.unit, ids.ub])).rejects.toThrow(/same institution/);
    await expect(db.su.query(`update org_unit set head_name = 'Dr X' where id = $1`, [ids.unit])).rejects.toThrow(/org_unit_head_check/);
    await db.su.query(`update org_unit set head_user_id = null, head_name = 'Dr X' where id = $1`, [ids.unit]);
  });

  it('are marked as edited by a person on an update by the application, but not on a worker update', async () => {
    await db.su.query(`update org_unit set edited_by_person = false where id = $1`, [ids.unit]);
    await db.as({ userId: ids.ua!, institutionId: ids.a! }, (c) => c.query(`update org_unit set description = 'x' where id = $1`, [ids.unit]));
    expect((await db.su.query(`select edited_by_person from org_unit where id = $1`, [ids.unit])).rows[0].edited_by_person).toBe(true);
    // The worker may only read org_unit (it has no UPDATE grant), so a sync that wants to write needs its own grant; the marker is kept.
    await expect(db.as({ userId: ids.ua!, institutionId: ids.a!, role: 'ams_worker' }, (c) => c.query(`update org_unit set description = 'y' where id = $1`, [ids.unit]))).rejects.toThrow(/permission denied/);
  });
});

describe('the Trash', () => {
  it('accepts the org_unit kind', async () => {
    await db.su.query(
      `insert into trash_item (institution_id, group_id, kind, label, payload, expires_at) values ($1, gen_random_uuid(), 'org_unit', 'C', '{}'::jsonb, now() + interval '30 days')`, [ids.a]);
    await expect(db.su.query(
      `insert into trash_item (institution_id, group_id, kind, label, payload, expires_at) values ($1, gen_random_uuid(), 'bogus', 'C', '{}'::jsonb, now())`, [ids.a])).rejects.toThrow(/trash_item_kind_check/);
  });
});
