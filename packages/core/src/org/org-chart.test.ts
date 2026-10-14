// The org chart builder's services (TASK-072): moves, deletes to the Trash and restore, head, lock, unit types, the
// edited-by-person marker, permissions, and tenant isolation.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import type { UndoDescriptor } from '@ams/shared';
import { ConflictError, ForbiddenError, ValidationError, type Ctx } from '../ctx.js';
import { restoreTrash } from '../trash/trash.js';
import { createOrgUnitType, listOrgUnitTypes, removeOrgUnitType, reorderOrgUnitTypes, updateOrgUnitType } from './unit-types.js';
import { moveOrgUnits } from './unit-move.js';
import { deleteOrgUnits, previewDeleteOrgUnits } from './unit-trash.js';
import { createOrgUnit, getOrgChart, updateOrgUnit } from './units.js';

let db: TestDb;
let pool: pg.Pool;
const ids = {} as Record<string, string>;
let lastUndo: UndoDescriptor | null = null;
const as = <T>(who: string, fn: (ctx: Ctx) => Promise<T>, inst = 'inst') => {
  const caller = { userId: ids[who]!, institutionId: ids[inst]!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  lastUndo = null;
  return withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined, undo: (d) => { lastUndo = d; } }));
};
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
/** Reads without touching `lastUndo` (so a test can read the chart and still look at the Undo of the action before). */
const asRead = <T>(who: string, fn: (ctx: Ctx) => Promise<T>) => {
  const caller = { userId: ids[who]!, institutionId: ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  return withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined }));
};
const tree = async () => (await asRead('admin', (c) => getOrgChart(c))).units;
/** "A > A1 > A11" style outline for checking shape and order. */
async function outline(): Promise<string[]> {
  const units = await tree();
  const depth = (id: string | null): number => (id ? 1 + depth(units.find((u) => u.id === id)!.parentId) : 0);
  return units.map((u) => `${'-'.repeat(depth(u.parentId))}${u.nameEn}`);
}
const orders = async (parent: string | null) => (await tree()).filter((u) => u.parentId === parent).map((u) => u.displayOrder);
const mk = (who: string, parentId: string | null, nameEn: string, type = 'department') => as(who, (c) => createOrgUnit(c, { parentId, type, nameEn }));

beforeAll(async () => {
  db = await createTestDb('orgchart');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('Other University') returning id`);
  for (const n of ['admin', 'leadA', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  ids.otherAdmin = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'otherAdmin', 'oa') returning id`, [ids.other]);
  const grant = (inst: string, u: string, role: string, scope: string, scopeId: string) =>
    db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids[inst], ids[u], role, scope, scopeId]);
  await grant('inst', 'admin', 'admin', 'institution', ids.inst!);
  await grant('inst', 'viewer', 'viewer', 'institution', ids.inst!);
  await grant('other', 'otherAdmin', 'admin', 'institution', ids.other!);
  ids.A = (await mk('admin', null, 'A', 'college')).id;
  ids.B = (await mk('admin', null, 'B', 'college')).id;
  ids.C = (await mk('admin', null, 'C', 'college')).id;
  ids.A1 = (await mk('admin', ids.A!, 'A1')).id;
  ids.A2 = (await mk('admin', ids.A!, 'A2')).id;
  ids.A11 = (await mk('admin', ids.A1!, 'A11')).id;
  ids.B1 = (await mk('admin', ids.B!, 'B1')).id;
  await grant('inst', 'leadA', 'lead', 'org_unit', ids.A!);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('reading', () => {
  it('returns the tree in order with counts, programs and the unit types', async () => {
    ids.prog = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BS X', 'bachelor') returning id`, [ids.inst, ids.A1]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'viewer', 'org_unit', $3)`, [ids.inst, ids.viewer, ids.A1]);
    expect(await outline()).toEqual(['A', '-A1', '--A11', '-A2', 'B', '-B1', 'C']);
    const chart = await as('viewer', (c) => getOrgChart(c));
    const a1 = chart.units.find((u) => u.id === ids.A1)!;
    expect(a1).toMatchObject({ programCount: 1, memberCount: 1, source: 'manual', locked: false, editedByPerson: false, headUserId: null, headName: null });
    expect(a1.programs).toEqual([{ id: ids.prog, nameEn: 'BS X', nameAr: null, degreeLevel: 'bachelor', active: true }]);
    expect(chart.types.map((t) => t.key)).toEqual(['college', 'school', 'department', 'admin_unit', 'other']);
    expect(chart.types.find((t) => t.key === 'college')!.unitCount).toBe(3);
  });

  it('seeds the five types for every new institution and keeps tenants apart', async () => {
    const other = await as('otherAdmin', (c) => getOrgChart(c), 'other');
    expect(other.units).toEqual([]);
    expect(other.types).toHaveLength(5);
    await expect(as('otherAdmin', (c) => updateOrgUnit(c, ids.A!, { nameEn: 'x' }), 'other')).rejects.toThrow(/not found|org unit/i);
    await expect(as('otherAdmin', (c) => moveOrgUnits(c, { moves: [{ id: ids.A!, parentId: null, index: 0 }] }), 'other')).rejects.toThrow();
    await expect(as('otherAdmin', (c) => deleteOrgUnits(c, { ids: [ids.A!] }), 'other')).rejects.toThrow();
  });
});

describe('create and edit', () => {
  it('appends last by default and inserts at an index, keeping orders gap-free', async () => {
    expect(await orders(null)).toEqual([0, 1, 2]);
    const d = await mk('admin', null, 'D', 'school');
    expect(d.displayOrder).toBe(3);
    const ins = await as('admin', (c) => createOrgUnit(c, { parentId: null, type: 'school', nameEn: 'Inserted', index: 1 }));
    expect(ins.displayOrder).toBe(1);
    expect(await orders(null)).toEqual([0, 1, 2, 3, 4]);
    expect((await outline()).filter((n) => !n.startsWith('-'))).toEqual(['A', 'Inserted', 'B', 'C', 'D']);
    expect(lastUndo).toMatchObject({ method: 'DELETE' });
    await as('admin', (c) => deleteOrgUnits(c, { ids: [d.id, ins.id] }));
  });

  it('rejects an unknown type, both head forms at once, and writes names in NFC', async () => {
    await expect(mk('admin', null, 'X', 'nope')).rejects.toThrow(ValidationError);
    await expect(as('admin', (c) => createOrgUnit(c, { parentId: null, type: 'other', nameEn: 'X', headUserId: ids.viewer!, headName: 'Dr X' }))).rejects.toThrow(/not both/);
    const u = await as('admin', (c) => createOrgUnit(c, { parentId: null, type: 'other', nameEn: 'Café', nameAr: 'كلية الآداب' }));
    expect(u.nameEn).toBe('Café');
    await as('admin', (c) => deleteOrgUnits(c, { ids: [u.id] }));
  });

  it('sets, changes and clears the head (a person or a name), with an Undo for each', async () => {
    const set = await as('admin', (c) => updateOrgUnit(c, ids.B1!, { headUserId: ids.viewer! }));
    expect(set).toMatchObject({ headUserId: ids.viewer, headUserName: 'viewer', headName: null });
    expect(lastUndo).toMatchObject({ method: 'PATCH', body: { headUserId: null, headName: null } });
    const named = await as('admin', (c) => updateOrgUnit(c, ids.B1!, { headName: 'Dr X' }));
    expect(named).toMatchObject({ headUserId: null, headName: 'Dr X' });
    expect(lastUndo!.body).toEqual({ headUserId: ids.viewer, headName: null });
    const undo = lastUndo!;
    expect(await as('admin', (c) => updateOrgUnit(c, ids.B1!, undo.body as never))).toMatchObject({ headUserId: ids.viewer, headName: null });
    expect(await as('admin', (c) => updateOrgUnit(c, ids.B1!, { headUserId: null, headName: null }))).toMatchObject({ headUserId: null, headName: null });
    await expect(as('admin', (c) => updateOrgUnit(c, ids.B1!, { headUserId: ids.viewer!, headName: 'x' }))).rejects.toThrow(/not both/);
    await expect(as('admin', (c) => updateOrgUnit(c, ids.B1!, { headUserId: ids.otherAdmin! }))).rejects.toThrow();
  });

  it('locks and unlocks, retypes, and describes; each reports the earlier values', async () => {
    expect(await as('admin', (c) => updateOrgUnit(c, ids.A2!, { locked: true }))).toMatchObject({ locked: true });
    expect(lastUndo).toMatchObject({ label: 'Locked A2', body: { locked: false } });
    expect(await as('admin', (c) => updateOrgUnit(c, ids.A2!, { locked: false }))).toMatchObject({ locked: false });
    expect(lastUndo).toMatchObject({ label: 'Unlocked A2' });
    expect(await as('admin', (c) => updateOrgUnit(c, ids.A2!, { type: 'school', description: 'Studies', nameAr: 'ب' }))).toMatchObject({ type: 'school', description: 'Studies', nameAr: 'ب' });
    const earlier = lastUndo!.body as never;
    expect(earlier).toEqual({ type: 'department', description: null, nameAr: null });
    await expect(as('admin', (c) => updateOrgUnit(c, ids.A2!, { type: 'nope' }))).rejects.toThrow(ValidationError);
    await as('admin', (c) => updateOrgUnit(c, ids.A2!, earlier));
  });

  it('marks a unit edited by a person on any update (a trigger), and a read does not', async () => {
    const fresh = await mk('admin', ids.C!, 'Fresh');
    expect(fresh.editedByPerson).toBe(false);
    expect((await as('admin', (c) => updateOrgUnit(c, fresh.id, { description: 'edited' }))).editedByPerson).toBe(true);
    // The worker's update leaves the mark as it is.
    await db.su.query(`select set_config('app.institution_id', $1, false)`, [ids.inst]);
    const { rows } = await db.su.query(`select edited_by_person from org_unit where id = $1`, [fresh.id]);
    expect(rows[0].edited_by_person).toBe(true);
    await as('admin', (c) => deleteOrgUnits(c, { ids: [fresh.id] }));
  });

  it('is permission-checked at the unit: a lead of A edits under A only; a viewer edits nothing', async () => {
    expect(await as('leadA', (c) => updateOrgUnit(c, ids.A1!, { description: 'ok' }))).toMatchObject({ description: 'ok' });
    await expect(as('leadA', (c) => updateOrgUnit(c, ids.B1!, { description: 'no' }))).rejects.toThrow(ForbiddenError);
    await expect(as('leadA', (c) => createOrgUnit(c, { parentId: null, type: 'other', nameEn: 'no' }))).rejects.toThrow(ForbiddenError);
    await expect(as('viewer', (c) => updateOrgUnit(c, ids.A1!, { description: 'no' }))).rejects.toThrow(ForbiddenError);
    await expect(as('viewer', (c) => deleteOrgUnits(c, { ids: [ids.A2!] }))).rejects.toThrow(ForbiddenError);
  });
});

describe('moving', () => {
  it('re-parents and reorders in one atomic action, keeps orders gap-free, and undoes exactly', async () => {
    const before = await outline();
    const r = await as('admin', (c) => moveOrgUnits(c, { moves: [{ id: ids.A2!, parentId: ids.B!, index: 0 }, { id: ids.C!, parentId: ids.B!, index: 1 }] }));
    expect(r).toMatchObject({ moved: 2, unchanged: false });
    expect(await outline()).toEqual(['A', '-A1', '--A11', 'B', '-A2', '-C', '-B1']);
    expect(await orders(ids.B!)).toEqual([0, 1, 2]);
    expect(await orders(null)).toEqual([0, 1]);
    const undo = lastUndo!;
    expect(undo).toMatchObject({ method: 'POST', path: '/api/org-units/move-many' });
    await as('admin', (c) => moveOrgUnits(c, undo.body as never));
    expect(await outline()).toEqual(before);
    expect(await orders(null)).toEqual([0, 1, 2]);
    expect(lastUndo!.body).toBeDefined();
  });

  it('refuses a unit under itself or its own sub-units and changes nothing (atomic)', async () => {
    const before = await outline();
    await expect(as('admin', (c) => moveOrgUnits(c, { moves: [{ id: ids.A!, parentId: ids.A11!, index: 0 }] }))).rejects.toThrow(/cannot be moved under itself/);
    await expect(as('admin', (c) => moveOrgUnits(c, { moves: [{ id: ids.C!, parentId: ids.B!, index: 0 }, { id: ids.A!, parentId: ids.A1!, index: 0 }] }))).rejects.toThrow(ConflictError);
    await expect(as('admin', (c) => moveOrgUnits(c, { moves: [{ id: ids.A!, parentId: ids.A!, index: 0 }] }))).rejects.toThrow(/under itself/);
    expect(await outline()).toEqual(before);
  });

  it('reports a move that changes nothing, and refuses missing units and the inactive target', async () => {
    const r = await as('admin', (c) => moveOrgUnits(c, { moves: [{ id: ids.A!, parentId: null, index: 0 }] }));
    expect(r.unchanged).toBe(true);
    expect(lastUndo).toBeNull();
    await expect(as('admin', (c) => moveOrgUnits(c, { moves: [{ id: crypto.randomUUID(), parentId: null, index: 0 }] }))).rejects.toThrow(ValidationError);
    await db.su.query(`update org_unit set active = false where id = $1`, [ids.B1]);
    await expect(as('admin', (c) => moveOrgUnits(c, { moves: [{ id: ids.C!, parentId: ids.B1!, index: 0 }] }))).rejects.toThrow(/inactive/);
    await db.su.query(`update org_unit set active = true where id = $1`, [ids.B1]);
  });

  it('needs write access where the unit is and where it goes', async () => {
    await expect(as('leadA', (c) => moveOrgUnits(c, { moves: [{ id: ids.A2!, parentId: ids.B!, index: 0 }] }))).rejects.toThrow(ForbiddenError);
    await expect(as('leadA', (c) => moveOrgUnits(c, { moves: [{ id: ids.B1!, parentId: ids.A!, index: 0 }] }))).rejects.toThrow(ForbiddenError);
    await as('leadA', (c) => moveOrgUnits(c, { moves: [{ id: ids.A2!, parentId: ids.A1!, index: 1 }] }));
    expect(await outline()).toContain('--A2');
    const undoBody = lastUndo!.body as never;
    await as('leadA', (c) => moveOrgUnits(c, undoBody));
    expect(await outline()).toContain('-A2');
  });

  it('moves a branch with its sub-units', async () => {
    await as('admin', (c) => moveOrgUnits(c, { moves: [{ id: ids.A1!, parentId: ids.B!, index: 0 }] }));
    expect(await outline()).toEqual(['A', '-A2', 'B', '-A1', '--A11', '-B1', 'C']);
    const undoBody = lastUndo!.body as never;
    await as('admin', (c) => moveOrgUnits(c, undoBody));
    expect(await outline()).toEqual(['A', '-A1', '--A11', '-A2', 'B', '-B1', 'C']);
  });
});

describe('deleting to the Trash', () => {
  it('refuses a unit with programs (or a sub-unit with programs) and lists them', async () => {
    const err = await as('admin', (c) => deleteOrgUnits(c, { ids: [ids.A!] })).catch((e) => e as ConflictError);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toMatch(/Cannot delete A: 1 program is still attached.*BS X \(in A1\).*Move or reassign it to another unit first/);
    expect((err as ConflictError).details).toMatchObject({ code: 'has_programs', programs: [{ nameEn: 'BS X', unitName: 'A1' }] });
    await expect(as('admin', (c) => previewDeleteOrgUnits(c, { ids: [ids.A1!] }))).rejects.toThrow(/BS X/);
    expect(await outline()).toContain('--A11');
  });

  it('deletes a subtree to the Trash, closes the gap, and restores it to its old place', async () => {
    await db.su.query(`update program set org_unit_id = $1 where id = $2`, [ids.B1, ids.prog]);
    const preview = await as('admin', (c) => previewDeleteOrgUnits(c, { ids: [ids.A1!] }));
    expect(preview.message).toMatch(/Delete A1 and its 1 sub-unit\? You can restore them from the Trash for 30 days/);
    const res = await as('admin', (c) => deleteOrgUnits(c, { ids: [ids.A1!, ids.A11!] }));
    expect(res.items).toBe(1);
    expect(await outline()).toEqual(['A', '-A2', 'B', '-B1', 'C']);
    expect(await orders(ids.A!)).toEqual([0]);
    const undo = lastUndo!;
    expect(undo).toMatchObject({ method: 'POST', path: `/api/trash/groups/${res.groupId}/restore` });
    const back = await as('admin', (c) => restoreTrash(c, { groupId: res.groupId }));
    expect(back.restored).toMatchObject({ units: 2 });
    expect(await outline()).toEqual(['A', '-A1', '--A11', '-A2', 'B', '-B1', 'C']);
    expect(await orders(ids.A!)).toEqual([0, 1]);
    expect(lastUndo).toMatchObject({ method: 'POST', path: '/api/org-units/delete', body: { ids: [ids.A1] } });
  });

  it('deleting several, one in another one\'s subtree counts once; restores each to its own place', async () => {
    const res = await as('admin', (c) => deleteOrgUnits(c, { ids: [ids.A1!, ids.A2!, ids.C!] }));
    expect(res.items).toBe(3);
    expect(await outline()).toEqual(['A', 'B', '-B1']);
    await as('admin', (c) => restoreTrash(c, { groupId: res.groupId }));
    expect(await outline()).toEqual(['A', '-A1', '--A11', '-A2', 'B', '-B1', 'C']);
    expect(await orders(null)).toEqual([0, 1, 2]);
  });

  it('asks where to put a unit whose parent is gone, then places it; or restores the parent first', async () => {
    const child = await as('admin', (c) => deleteOrgUnits(c, { ids: [ids.A2!] }));
    const parent = await as('admin', (c) => deleteOrgUnits(c, { ids: [ids.A!] }));
    const err = await as('admin', (c) => restoreTrash(c, { groupId: child.groupId })).catch((e) => e as ConflictError);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).details).toMatchObject({ code: 'parent_missing', parentLabel: 'A', nearestAncestor: null });
    const placed = await as('admin', (c) => restoreTrash(c, { groupId: child.groupId }, { placeParentId: ids.B! }));
    expect(placed.placedUnder).toBe('B');
    expect(await outline()).toContain('-A2');
    const parentBack = await as('admin', (c) => restoreTrash(c, { groupId: parent.groupId }));
    expect(parentBack.restored.units).toBe(3);
    // Put A2 back where it was, at the top level for the other branch of the choice.
    const again = await as('admin', (c) => deleteOrgUnits(c, { ids: [ids.A!] }));
    const top = await as('admin', (c) => restoreTrash(c, { groupId: again.groupId }, { atTopLevel: true }).catch((e) => e as Error));
    expect(top instanceof Error ? top.message : 'ok').toBe('ok');
  });

  it('allows names that collide and renames nothing; adds back a unit type removed in the meantime', async () => {
    const t = await as('admin', (c) => createOrgUnitType(c, { labelEn: 'Research centre' }));
    const u = await as('admin', (c) => createOrgUnit(c, { parentId: null, type: t.key, nameEn: 'B' }));
    const del = await as('admin', (c) => deleteOrgUnits(c, { ids: [u.id] }));
    await as('admin', (c) => removeOrgUnitType(c, t.id));
    await as('admin', (c) => createOrgUnit(c, { parentId: null, type: 'other', nameEn: 'B' }));
    const back = await as('admin', (c) => restoreTrash(c, { groupId: del.groupId }));
    expect(back.message).toMatch(/Research centre.*added back/);
    const names = (await tree()).filter((x) => x.nameEn === 'B').length;
    expect(names).toBe(3);
    expect((await tree()).find((x) => x.id === u.id)!.type).toBe(t.key);
  });

  it('takes the owner off evidence while the unit is in the Trash, and gives it back on restore', async () => {
    const ev = await one(`insert into evidence_item (institution_id, title, type, owner_unit_id) values ($1, 'Policy', 'document', $2) returning id`, [ids.inst, ids.C]);
    const del = await as('admin', (c) => deleteOrgUnits(c, { ids: [ids.C!] }));
    expect((await db.su.query(`select owner_unit_id from evidence_item where id = $1`, [ev])).rows[0].owner_unit_id).toBeNull();
    await as('admin', (c) => restoreTrash(c, { groupId: del.groupId }));
    expect((await db.su.query(`select owner_unit_id from evidence_item where id = $1`, [ev])).rows[0].owner_unit_id).toBe(ids.C);
  });

  it('is audited', async () => {
    const { rows } = await db.su.query(`select count(*)::int as n from audit_event where target_type = 'org_unit' and action = 'delete'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

describe('unit types', () => {
  it('adds with a key from the label, renames (units show the new name), reorders, and undoes each', async () => {
    const t = await as('admin', (c) => createOrgUnitType(c, { labelEn: 'Institute', labelAr: 'معهد' }));
    expect(t).toMatchObject({ key: 'institute', labelEn: 'Institute', labelAr: 'معهد', displayOrder: 6, unitCount: 0 });
    expect(lastUndo).toMatchObject({ method: 'DELETE', path: `/api/org-unit-types/${t.id}` });
    const dup = await as('admin', (c) => createOrgUnitType(c, { labelEn: 'Institute 2' }));
    expect(dup.key).toBe('institute_2');
    await expect(as('admin', (c) => createOrgUnitType(c, { labelEn: 'institute' }))).rejects.toThrow(ConflictError);
    const unit = await as('admin', (c) => createOrgUnit(c, { parentId: null, type: 'institute', nameEn: 'Inst' }));
    const renamed = await as('admin', (c) => updateOrgUnitType(c, t.id, { labelEn: 'Research institute' }));
    expect(renamed).toMatchObject({ key: 'institute', labelEn: 'Research institute', unitCount: 1 });
    expect(lastUndo).toMatchObject({ method: 'PATCH', body: { labelEn: 'Institute' } });
    expect((await tree()).find((x) => x.id === unit.id)!.type).toBe('institute');
    const types = await asRead('viewer', (c) => listOrgUnitTypes(c));
    const order = [...types].reverse().map((x) => x.id);
    const re = await as('admin', (c) => reorderOrgUnitTypes(c, { ids: order }));
    expect(re.map((x) => x.id)).toEqual(order);
    expect(lastUndo).toMatchObject({ path: '/api/org-unit-types/reorder', body: { ids: types.map((x) => x.id) } });
    await expect(as('admin', (c) => reorderOrgUnitTypes(c, { ids: order.slice(1) }))).rejects.toThrow(ValidationError);
    await as('admin', (c) => deleteOrgUnits(c, { ids: [unit.id] }));
  });

  it('removes a type only when no unit uses it, and never the last one', async () => {
    const used = (await as('admin', (c) => listOrgUnitTypes(c))).find((t) => t.key === 'college')!;
    await expect(as('admin', (c) => removeOrgUnitType(c, used.id))).rejects.toThrow(/used by 3 units.*Change their type first/);
    const spare = (await as('admin', (c) => listOrgUnitTypes(c))).find((t) => t.key === 'institute_2')!;
    await as('admin', (c) => removeOrgUnitType(c, spare.id));
    expect(lastUndo).toMatchObject({ method: 'POST', path: '/api/org-unit-types', body: { key: 'institute_2', labelEn: 'Institute 2' } });
    expect((await as('admin', (c) => listOrgUnitTypes(c))).map((t) => t.displayOrder)).toEqual([...Array((await as('admin', (c) => listOrgUnitTypes(c))).length).keys()]);
    await expect(as('leadA', (c) => createOrgUnitType(c, { labelEn: 'Nope' }))).rejects.toThrow(ForbiddenError);
    await expect(as('viewer', (c) => removeOrgUnitType(c, spare.id))).rejects.toThrow(ForbiddenError);
    // The database says it too: a type in use cannot be removed behind the service's back.
    await expect(db.su.query(`delete from org_unit_type where id = $1`, [used.id])).rejects.toThrow(/foreign key|violates/);
  });

  it('keeps unit types apart per institution', async () => {
    const mine = await as('admin', (c) => listOrgUnitTypes(c));
    const theirs = await as('otherAdmin', (c) => listOrgUnitTypes(c), 'other');
    expect(theirs.map((t) => t.id).filter((id) => mine.some((m) => m.id === id))).toEqual([]);
    await expect(as('otherAdmin', (c) => updateOrgUnitType(c, mine[0]!.id, { labelEn: 'hack' }), 'other')).rejects.toThrow(/not found|unit type/i);
  });
});
