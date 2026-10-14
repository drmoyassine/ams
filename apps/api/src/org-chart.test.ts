// The org chart through the five-step chain (TASK-072): every mutation answers with an Undo, and the Undo answers with the Redo
// (create, edit, head, lock, type change, move, delete, unit types); permissions; the refusal for units with programs.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { MemoryStore } from '@ams/core';
import { REPLAY_HEADER } from '@ams/shared';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
type Desc = { label: string; method: string; path: string; body?: unknown; kind?: 'undo' | 'redo' };
interface Out { status: number; body: any; undo: Desc | null } // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string | null, method: string, path: string, body?: unknown, replay?: 'undo' | 'redo'): Promise<Out> {
  const res = await app.request(path, {
    method,
    headers: {
      ...(who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(replay ? { [REPLAY_HEADER]: replay } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const header = res.headers.get('x-undo');
  return { status: res.status, body: text ? JSON.parse(text) : null, undo: header ? JSON.parse(decodeURIComponent(header)) : null };
}
const send = (who: string, d: Desc, as: 'undo' | 'redo') => call(who, d.method, d.path, d.body, as);
async function undoThenRedo(who: string, undo: Desc) {
  const undone = await send(who, undo, 'undo');
  expect(undone.status).toBeLessThan(300);
  expect(undone.undo).toMatchObject({ kind: 'redo' });
  const redone = await send(who, undone.undo!, 'redo');
  expect(redone.status).toBeLessThan(300);
  expect(redone.undo).toMatchObject({ kind: 'undo' });
  return { undone, redone };
}
const chart = async () => (await call('lead', 'GET', '/api/org-chart')).body as { units: any[]; types: any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
const unit = async (id: string) => (await chart()).units.find((u) => u.id === id);
const names = async () => (await chart()).units.map((u) => `${u.parentId ? '-' : ''}${u.nameEn}`);
const create = async (body: Record<string, unknown>) => (await call('lead', 'POST', '/api/org-units', { parentId: null, type: 'department', ...body })).body.id as string;

beforeAll(async () => {
  db = await createTestDb('apiorgchart');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store: new MemoryStore(), queue: { send: async () => undefined },
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [n, role] of [['lead', 'lead'], ['viewer', 'viewer'], ['admin', 'admin']] as const) {
    ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[n], role]);
  }
}, 30000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('permissions', () => {
  it('lets a viewer read the chart and nothing else; an anonymous caller gets 401', async () => {
    expect((await call('viewer', 'GET', '/api/org-chart')).status).toBe(200);
    expect((await call('viewer', 'GET', '/api/org-unit-types')).status).toBe(200);
    expect((await call(null, 'GET', '/api/org-chart')).status).toBe(401);
    expect((await call('viewer', 'POST', '/api/org-units', { parentId: null, type: 'college', nameEn: 'x' })).status).toBe(403);
    expect((await call('viewer', 'POST', '/api/org-units/move-many', { moves: [{ id: crypto.randomUUID(), parentId: null, index: 0 }] })).status).toBe(403);
    expect((await call('viewer', 'POST', '/api/org-units/delete', { ids: [crypto.randomUUID()] })).status).toBe(403);
    expect((await call('viewer', 'POST', '/api/org-unit-types', { labelEn: 'x' })).status).toBe(403);
  });
});

describe('undo and redo of every mutation', () => {
  it('create: undo deletes it to the Trash, redo restores it', async () => {
    const r = await call('lead', 'POST', '/api/org-units', { parentId: null, type: 'college', nameEn: 'Created' });
    expect(r.status).toBe(201);
    expect(r.undo).toMatchObject({ method: 'DELETE', path: `/api/org-units/${r.body.id}` });
    expect(r.undo!.kind).toBeUndefined();
    const { undone, redone } = await undoThenRedo('lead', r.undo!);
    expect(undone.undo!.path).toMatch(/\/api\/trash\/groups\/.+\/restore/);
    // The Undo deleted it, the Redo restored it, and the Redo offers the delete again.
    expect(await unit(r.body.id)).toBeTruthy();
    expect(redone.undo).toMatchObject({ method: 'POST', path: '/api/org-units/delete', body: { ids: [r.body.id] } });
  });

  it('edit, head, lock and type change: undo puts the earlier values back, redo the new ones', async () => {
    const u = await create({ nameEn: 'Edit me', type: 'college' });
    const edited = await call('lead', 'PATCH', `/api/org-units/${u}`, { nameEn: 'Edited', nameAr: 'معدل', description: 'd' });
    expect(edited.undo).toMatchObject({ method: 'PATCH', body: { nameEn: 'Edit me', nameAr: null, description: null } });
    await undoThenRedo('lead', edited.undo!);
    expect(await unit(u)).toMatchObject({ nameEn: 'Edited', nameAr: 'معدل' });

    const head = await call('lead', 'PATCH', `/api/org-units/${u}`, { headName: 'Dr X' });
    expect(await unit(u)).toMatchObject({ headName: 'Dr X' });
    await undoThenRedo('lead', head.undo!);
    expect(await unit(u)).toMatchObject({ headName: 'Dr X', headUserId: null });
    const person = await call('lead', 'PATCH', `/api/org-units/${u}`, { headUserId: ids.admin });
    expect(await unit(u)).toMatchObject({ headUserId: ids.admin, headUserName: 'admin', headName: null });
    const undone = await send('lead', person.undo!, 'undo');
    expect(await unit(u)).toMatchObject({ headUserId: null, headName: 'Dr X' });
    await send('lead', undone.undo!, 'redo');
    expect(await unit(u)).toMatchObject({ headUserId: ids.admin });

    const lock = await call('lead', 'PATCH', `/api/org-units/${u}`, { locked: true });
    await undoThenRedo('lead', lock.undo!);
    expect(await unit(u)).toMatchObject({ locked: true, source: 'manual' });

    const type = await call('lead', 'PATCH', `/api/org-units/${u}`, { type: 'school' });
    expect(type.undo!.label).toMatch(/Changed the type/);
    await undoThenRedo('lead', type.undo!);
    expect(await unit(u)).toMatchObject({ type: 'school' });
    expect((await call('lead', 'PATCH', `/api/org-units/${u}`, { type: 'nope' })).status).toBe(400);
  });

  it('move and reorder: undo restores every moved unit exactly; redo moves them again', async () => {
    const a = await create({ nameEn: 'MA' });
    const b = await create({ nameEn: 'MB' });
    const a1 = await create({ nameEn: 'MA1', parentId: a });
    const before = await names();
    const moved = await call('lead', 'POST', '/api/org-units/move-many', { moves: [{ id: a1, parentId: b, index: 0 }, { id: a, parentId: b, index: 1 }] });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ moved: 2, unchanged: false });
    const after = await names();
    expect(after).not.toEqual(before);
    const { undone, redone } = await undoThenRedo('lead', moved.undo!);
    expect(undone.status).toBe(200);
    expect(await names()).toEqual(after);
    // Undo once more: back to where it began.
    await send('lead', redone.undo!, 'undo');
    expect(await names()).toEqual(before);
    // A cycle is a 409 and changes nothing.
    const cyc = await call('lead', 'POST', '/api/org-units/move-many', { moves: [{ id: a, parentId: a1, index: 0 }] });
    expect(cyc.status).toBe(409);
    expect(JSON.stringify(cyc.body)).toMatch(/under itself/);
    expect(await names()).toEqual(before);
  });

  it('delete: refused with programs (listing them); otherwise to the Trash, undo restores, redo deletes again', async () => {
    const col = await create({ nameEn: 'DelCol', type: 'college' });
    const dep = await create({ nameEn: 'DelDep', parentId: col });
    const prog = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BS Del', 'bachelor') returning id`, [ids.inst, dep]);
    const refused = await call('lead', 'POST', '/api/org-units/delete', { ids: [col] });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/BS Del/);
    expect(JSON.stringify(refused.body)).toMatch(/Move or reassign/);
    expect((await call('lead', 'POST', '/api/org-units/delete-preview', { ids: [col] })).status).toBe(409);
    expect(await unit(col)).toBeTruthy();
    await db.su.query(`update program set org_unit_id = $1 where id = $2`, [(await chart()).units[0].id, prog]);

    const preview = await call('lead', 'POST', '/api/org-units/delete-preview', { ids: [col] });
    expect(preview.body.message).toMatch(/Delete DelCol and its 1 sub-unit/);
    const del = await call('lead', 'POST', '/api/org-units/delete', { ids: [col] });
    expect(del.status).toBe(200);
    expect(await unit(col)).toBeUndefined();
    expect(await unit(dep)).toBeUndefined();
    const { undone, redone } = await undoThenRedo('lead', del.undo!);
    expect(undone.body.restored.units).toBe(2);
    expect(redone.undo!.path).toMatch(/restore/);
    expect(await unit(col)).toBeUndefined();
    await send('lead', redone.undo!, 'undo');
    expect(await unit(dep)).toBeTruthy();
    // Single delete by id, and the Trash lists it under the org_unit kind.
    const solo = await create({ nameEn: 'Solo' });
    const single = await call('lead', 'DELETE', `/api/org-units/${solo}`);
    expect(single.status).toBe(200);
    const trash = await call('lead', 'GET', '/api/trash?kind=org_unit');
    expect(trash.body.total).toBeGreaterThan(0);
    await send('lead', single.undo!, 'undo');
  });

  it('delete of a restored unit whose parent is gone is a 409 with the choice', async () => {
    const p = await create({ nameEn: 'GoneParent' });
    const c = await create({ nameEn: 'OrphanChild', parentId: p });
    const delChild = await call('lead', 'DELETE', `/api/org-units/${c}`);
    await call('lead', 'DELETE', `/api/org-units/${p}`);
    const r = await send('lead', delChild.undo!, 'undo');
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ code: 'parent_missing' });
    const groupId = delChild.undo!.path.split('/')[4];
    const ok = await call('lead', 'POST', `/api/trash/groups/${groupId}/restore`, { atTopLevel: true });
    expect(ok.status).toBe(200);
    expect((await unit(c)).parentId).toBeNull();
  });

  it('unit types: add, rename, reorder and remove each undo and redo', async () => {
    const added = await call('lead', 'POST', '/api/org-unit-types', { labelEn: 'Centre', labelAr: 'مركز' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ key: 'centre', unitCount: 0 });
    await undoThenRedo('lead', added.undo!);
    const types = () => call('lead', 'GET', '/api/org-unit-types').then((r) => r.body as { id: string; key: string; labelEn: string; displayOrder: number }[]);
    const centre = (await types()).find((t) => t.key === 'centre')!;
    const renamed = await call('lead', 'PATCH', `/api/org-unit-types/${centre.id}`, { labelEn: 'Research centre' });
    await undoThenRedo('lead', renamed.undo!);
    expect((await types()).find((t) => t.key === 'centre')!.labelEn).toBe('Research centre');

    const list = await types();
    const reversed = [...list].reverse().map((t) => t.id);
    const re = await call('lead', 'POST', '/api/org-unit-types/reorder', { ids: reversed });
    expect(re.status).toBe(200);
    await undoThenRedo('lead', re.undo!);
    expect((await types()).map((t) => t.id)).toEqual(reversed);
    await call('lead', 'POST', '/api/org-unit-types/reorder', { ids: list.map((t) => t.id) });

    const removed = await call('lead', 'DELETE', `/api/org-unit-types/${centre.id}`);
    expect(removed.status).toBe(204);
    await undoThenRedo('lead', removed.undo!);
    expect((await types()).some((t) => t.key === 'centre')).toBe(false);
    const inUse = (await types()).find((t) => t.key === 'college')!;
    await create({ nameEn: 'UsesCollege', type: 'college' });
    const refused = await call('lead', 'DELETE', `/api/org-unit-types/${inUse.id}`);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/used by/);
  });
});
