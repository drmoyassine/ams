// Trash, bulk delete and Undo through the five-step chain (DEC-026): permissions, the X-Undo header on reversible
// actions (and its absence elsewhere), applying the descriptors, the restore refusals and their choices.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { MemoryStore } from '@ams/core';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
interface Out { status: number; body: any; undo: { label: string; method: string; path: string; body?: unknown } | null } // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string | null, method: string, path: string, body?: unknown): Promise<Out> {
  const res = await app.request(path, {
    method,
    headers: { ...(who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const header = res.headers.get('x-undo');
  return { status: res.status, body: text ? JSON.parse(text) : null, undo: header ? JSON.parse(decodeURIComponent(header)) : null };
}
/** What the client does with an Undo: sends the descriptor's request. */
const applyUndo = (who: string, u: NonNullable<Out['undo']>) => call(who, u.method, u.path, u.body);

let n = 0;
async function draft() {
  n += 1;
  const v = (await call('lead', 'POST', `/api/frameworks/${ids.fw}/versions`, { edition: `e${n}` })).body.id as string;
  const post = async (body: Record<string, unknown>) => (await call('lead', 'POST', `/api/framework-versions/${v}/requirements`, body)).body.id as string;
  const std = await post({ code: 'S1', levelLabel: 'Standard', title: 'Purposes', displayOrder: 3 });
  const kid = await post({ code: 'S1.1', levelLabel: 'CFR', title: 'Mission', parentId: std });
  const other = await post({ code: 'S2', levelLabel: 'Standard', title: 'Resources', displayOrder: 7 });
  return { v, std, kid, other };
}

beforeAll(async () => {
  db = await createTestDb('apitrash');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store: new MemoryStore(), queue: { send: async () => undefined },
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [n2, role] of [['lead', 'lead'], ['viewer', 'viewer']] as const) {
    ids[n2] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n2]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[n2], role]);
  }
  const acc = (await call('lead', 'POST', '/api/accreditors', { name: 'Invented Council', shortName: 'IC', type: 'institutional' })).body.id;
  ids.fw = (await call('lead', 'POST', '/api/frameworks', { accreditorId: acc, name: 'Handbook', scope: 'institution' })).body.id;
}, 30000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('routes and permissions', () => {
  it('documents the routes, needs a sign-in, and keeps deleting to people with framework:write', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
      '/api/trash', '/api/trash/count', '/api/trash/groups/{groupId}', '/api/trash/groups/{groupId}/restore', '/api/trash/items/{id}/restore', '/api/trash/items/{id}',
      '/api/requirements/delete', '/api/requirements/delete-preview', '/api/framework-versions/{id}/requirements/delete-all', '/api/framework-versions/{id}', '/api/frameworks/{id}', '/api/requirements/{id}/unsplit',
    ]));
    const x = await draft();
    expect((await call(null, 'GET', '/api/trash')).status).toBe(401);
    expect((await call(null, 'DELETE', `/api/requirements/${x.kid}`)).status).toBe(401);
    expect((await call('viewer', 'DELETE', `/api/requirements/${x.kid}`)).status).toBe(403);
    expect((await call('viewer', 'POST', '/api/requirements/delete', { ids: [x.kid] })).status).toBe(403);
    expect((await call('viewer', 'POST', '/api/requirements/delete-preview', { ids: [x.kid] })).status).toBe(403);
    expect((await call('viewer', 'DELETE', `/api/framework-versions/${x.v}`)).status).toBe(403);
    expect((await call('viewer', 'POST', `/api/framework-versions/${x.v}/requirements/delete-all`)).status).toBe(403);
    expect((await call('viewer', 'GET', '/api/trash')).body).toMatchObject({ total: 0, groups: [], retentionDays: 30 });
    expect((await call('viewer', 'GET', '/api/trash/count')).body).toEqual({ count: 0 });
    expect((await call('lead', 'POST', '/api/requirements/delete', { ids: [] })).status).toBe(400);
  });
});

describe('delete answers with how to take it back', () => {
  it('single delete: 204, X-Undo restores the whole subtree, and the Trash shows and then forgets it', async () => {
    const x = await draft();
    const del = await call('lead', 'DELETE', `/api/requirements/${x.std}`);
    expect(del.status).toBe(204);
    expect(del.undo).toMatchObject({ label: 'Deleted S1 and 1 sub-item', method: 'POST', path: expect.stringMatching(/^\/api\/trash\/groups\/[0-9a-f-]{36}\/restore$/) });
    expect((await call('lead', 'GET', `/api/framework-versions/${x.v}/requirements`)).body.map((r: { code: string }) => r.code)).toEqual(['S2']);
    const trash = (await call('lead', 'GET', '/api/trash')).body;
    const group = trash.groups.find((g: { label: string }) => g.label === 'S1 · Purposes');
    expect(group).toMatchObject({ kinds: ['requirement'], counts: { items: 1, subItems: 1 }, daysLeft: 30, deletedByName: 'lead' });
    expect((await call('lead', 'GET', `/api/trash/groups/${group.groupId}`)).body.contents[0].rows.map((r: { label: string }) => r.label)).toEqual(['S1 · Purposes', 'S1.1 · Mission']);
    expect((await call('lead', 'GET', '/api/trash/count')).body.count).toBeGreaterThan(0);
    const restored = await applyUndo('lead', del.undo!);
    expect(restored.status).toBe(200);
    // An Undo sent as such (no X-Replay here, as from the Trash page) offers to delete it again; redo.test.ts covers the tagged flow.
    expect(restored.undo).toMatchObject({ method: 'POST', path: '/api/requirements/delete', body: { ids: [x.std] } });
    expect(restored.body).toMatchObject({ restored: { requirements: 2 } });
    expect((await call('lead', 'GET', `/api/framework-versions/${x.v}/requirements`)).body.map((r: { code: string }) => r.code)).toEqual(['S1', 'S1.1', 'S2']);
    expect((await call('lead', 'GET', '/api/trash')).body.groups.some((g: { groupId: string }) => g.groupId === group.groupId)).toBe(false);
  });

  it('bulk delete with a preview, nested ids counted once, and Delete all for a version', async () => {
    const x = await draft();
    const preview = await call('lead', 'POST', '/api/requirements/delete-preview', { ids: [x.std, x.kid, x.other] });
    expect(preview.body).toMatchObject({ roots: 2, counts: { items: 2, subItems: 1, notes: 0 } });
    expect(preview.body.message).toBe('Delete S1, S2 and their 1 sub-item? You can restore them from the Trash for 30 days.');
    expect(preview.undo).toBeNull(); // a question changes nothing
    const del = await call('lead', 'POST', '/api/requirements/delete', { ids: [x.std, x.kid, x.other] });
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ items: 2, label: 'Deleted S1, S2 and 1 sub-item' });
    expect(del.undo).toMatchObject({ label: del.body.label });
    await applyUndo('lead', del.undo!);
    const all = await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements/delete-all`);
    expect(all.status).toBe(200);
    expect(all.body.label).toMatch(/^Deleted all 3 standards in IC Handbook e\d+$/);
    expect((await call('lead', 'GET', `/api/framework-versions/${x.v}/requirements`)).body).toEqual([]);
    expect((await applyUndo('lead', all.undo!)).body.restored).toMatchObject({ requirements: 3 });
    expect((await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements/delete-all`)).status).toBe(200);
    expect((await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements/delete-all`)).status).toBe(409);
  });

  it('a published version refuses to delete, and a restore into it says the version is no longer a draft', async () => {
    const x = await draft();
    const del = await call('lead', 'DELETE', `/api/requirements/${x.kid}`);
    await db.su.query(`update requirement set review_status = 'approved' where framework_version_id = $1`, [x.v]);
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [x.v]);
    await db.su.query(`update framework_version set status = 'published', published_by = $2, published_at = now() where id = $1`, [x.v, ids.lead]);
    const refused = await applyUndo('lead', del.undo!);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe('Cannot restore: the version is no longer a draft (it is published). A published version cannot be changed; copy what you need into a new version.');
    expect((await call('lead', 'DELETE', `/api/requirements/${x.std}`)).status).toBe(409);
    expect((await call('lead', 'DELETE', `/api/framework-versions/${x.v}`)).status).toBe(409);
  });

  it('a restore that needs a choice answers 409 with the choices, and takes the choice', async () => {
    const x = await draft();
    const child = await call('lead', 'DELETE', `/api/requirements/${x.kid}`);
    await call('lead', 'DELETE', `/api/requirements/${x.std}`);
    const refused = await applyUndo('lead', child.undo!);
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({ code: 'parent_missing', parentLabel: 'S1 · Purposes', nearestAncestor: null });
    const ok = await call('lead', 'POST', child.undo!.path, { atTopLevel: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ placedUnder: 'the top level' });
    // Unknown options are refused, not ignored.
    expect((await call('lead', 'POST', `/api/trash/groups/${crypto.randomUUID()}/restore`, { bogus: true })).status).toBe(400);
  });
});

describe('edits, moves and additions answer with their inverse', () => {
  it('edit: the header carries the earlier values, and an edit no longer resets the other fields', async () => {
    const x = await draft();
    const edit = await call('lead', 'PATCH', `/api/requirements/${x.std}`, { title: 'New purposes' });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ title: 'New purposes', displayOrder: 3, isAssessable: true, language: 'en' }); // position untouched
    expect(edit.undo).toEqual({ label: 'Edited S1', method: 'PATCH', path: `/api/requirements/${x.std}`, body: { title: 'Purposes' } });
    expect((await applyUndo('lead', edit.undo!)).body.title).toBe('Purposes');
    const cleared = await call('lead', 'PATCH', `/api/requirements/${x.kid}`, { officialText: 'Words' });
    expect(cleared.undo!.body).toEqual({ officialText: null });
    expect((await applyUndo('lead', cleared.undo!)).body.officialText).toBeNull();
  });

  it('offers no undo header when the earlier text is too long to carry in one', async () => {
    const x = await draft();
    await call('lead', 'PATCH', `/api/requirements/${x.kid}`, { officialText: 'x'.repeat(8000) });
    const edit = await call('lead', 'PATCH', `/api/requirements/${x.kid}`, { officialText: 'short' });
    expect(edit.status).toBe(200);
    expect(edit.undo).toBeNull();
  });

  it('move: the header moves it back to the earlier parent and position', async () => {
    const x = await draft();
    const move = await call('lead', 'POST', `/api/requirements/${x.kid}/move`, { parentId: x.other, displayOrder: 9 });
    expect(move.body).toMatchObject({ parentId: x.other, displayOrder: 9 });
    expect(move.undo).toEqual({ label: 'Moved S1.1', method: 'POST', path: `/api/requirements/${x.kid}/move`, body: { parentId: x.std, displayOrder: 0 } });
    expect((await applyUndo('lead', move.undo!)).body).toMatchObject({ parentId: x.std, displayOrder: 0 });
  });

  it('create: the header deletes it (to the Trash), for a requirement and a note; delete of a note is restorable', async () => {
    const x = await draft();
    const made = await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements`, { code: 'S3', levelLabel: 'Standard', title: 'Third' });
    expect(made.status).toBe(201);
    expect(made.undo).toEqual({ label: 'Added S3', method: 'DELETE', path: `/api/requirements/${made.body.id}` });
    expect((await applyUndo('lead', made.undo!)).status).toBe(204);
    const note = await call('lead', 'POST', `/api/requirements/${x.std}/notes`, { type: 'guidance', text: 'A note', authority: 'example' });
    expect(note.undo).toMatchObject({ method: 'DELETE', path: `/api/notes/${note.body.id}` });
    const gone = await applyUndo('lead', note.undo!);
    expect(gone.undo).toMatchObject({ label: 'Deleted a note on S1' });
    expect((await applyUndo('lead', gone.undo!)).body.restored).toEqual({ notes: 1 });
    expect((await call('lead', 'GET', `/api/requirements/${x.std}`)).body.notes).toHaveLength(1);
  });

  it('answers without an X-Undo header for reads and for refused requests', async () => {
    const x = await draft();
    expect((await call('lead', 'GET', `/api/requirements/${x.std}`)).undo).toBeNull();
    expect((await call('lead', 'POST', `/api/requirements/${x.std}/move`, { parentId: x.kid })).status).toBe(409); // under its own child
    expect((await call('lead', 'POST', `/api/requirements/${x.std}/move`, { parentId: x.kid })).undo).toBeNull();
  });

  it('merge and split give an undo too', async () => {
    const x = await draft();
    await call('lead', 'PATCH', `/api/requirements/${x.kid}`, { officialText: 'First part. Second part.' });
    const split = await call('lead', 'POST', `/api/requirements/${x.kid}/split`, { part: 'Second part.', code: 'S1.2' });
    expect(split.status).toBe(201);
    expect(split.undo).toMatchObject({ method: 'POST', path: `/api/requirements/${x.kid}/unsplit`, body: { createdId: split.body.created.id, officialText: 'First part. Second part.' } });
    expect((await applyUndo('lead', split.undo!)).body.officialText).toBe('First part. Second part.');
    const merge = await call('lead', 'POST', `/api/requirements/${x.kid}/merge`, { intoId: x.other });
    expect(merge.status).toBe(200);
    expect(merge.undo).toMatchObject({ label: 'Merged S1.1 into S2', body: { revertMerge: true } });
    expect((await applyUndo('lead', merge.undo!)).status).toBe(200);
    expect((await call('lead', 'GET', `/api/framework-versions/${x.v}/requirements`)).body.map((r: { code: string }) => r.code)).toContain('S1.1');
  });
});

describe('versions, standards and "Delete forever"', () => {
  it('deletes and restores a draft version through the API, and removes forever', async () => {
    const x = await draft();
    const del = await call('lead', 'DELETE', `/api/framework-versions/${x.v}`);
    expect(del.status).toBe(200);
    expect(del.body.counts).toMatchObject({ requirements: 3 });
    expect((await call('lead', 'GET', `/api/framework-versions/${x.v}`)).status).toBe(404);
    expect((await applyUndo('lead', del.undo!)).status).toBe(200);
    expect((await call('lead', 'GET', `/api/framework-versions/${x.v}`)).body.status).toBe('draft');
    const again = await call('lead', 'DELETE', `/api/framework-versions/${x.v}`);
    expect((await call('viewer', 'DELETE', `/api/trash/groups/${again.body.groupId}`)).status).toBe(404); // not theirs to see
    expect((await call('lead', 'DELETE', `/api/trash/groups/${again.body.groupId}`)).body).toEqual({ removed: 1 });
    expect((await applyUndo('lead', again.undo!)).status).toBe(404);
  });

  it('empties the Trash for the person who may', async () => {
    await draft().then((x) => call('lead', 'DELETE', `/api/requirements/${x.kid}`));
    expect((await call('viewer', 'DELETE', '/api/trash')).body).toEqual({ removed: 0 });
    const emptied = await call('lead', 'DELETE', '/api/trash');
    expect(emptied.body.removed).toBeGreaterThan(0);
    expect((await call('lead', 'GET', '/api/trash')).body.total).toBe(0);
  });
});
