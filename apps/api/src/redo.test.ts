// Redo through the five-step chain (TASK-065, DEC-026): the request an Undo sends (X-Replay: undo) answers with the
// descriptor that re-does the action, tagged kind 'redo'; the request a Redo sends answers with the Undo again. Every
// reversible kind, the refusals (frozen version, missing parent, id gone, permission), and the 6000-byte cap.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { MemoryStore } from '@ams/core';
import { REPLAY_HEADER } from '@ams/shared';
import { createApp } from './app.js';
import { MAX_UNDO_HEADER } from './chain.js';

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
/** What the client does: sends a descriptor as an Undo or a Redo. */
const send = (who: string, d: Desc, as: 'undo' | 'redo') => call(who, d.method, d.path, d.body, as);
/** Undo it, then Redo what the Undo offered; returns both answers and the Undo that the Redo offers again. */
async function undoThenRedo(who: string, undo: Desc) {
  const undone = await send(who, undo, 'undo');
  expect(undone.status).toBeLessThan(300);
  expect(undone.undo).toMatchObject({ kind: 'redo' });
  const redone = await send(who, undone.undo!, 'redo');
  expect(redone.status).toBeLessThan(300);
  expect(redone.undo).toMatchObject({ kind: 'undo' });
  return { undone, redone };
}
const codes = async (v: string) => ((await call('lead', 'GET', `/api/framework-versions/${v}/requirements`)).body as { code: string }[]).map((r) => r.code);

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
  db = await createTestDb('apiredo');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store: new MemoryStore(), queue: { send: async () => undefined },
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [n2, role] of [['lead', 'lead'], ['viewer', 'viewer'], ['admin', 'admin']] as const) {
    ids[n2] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n2]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[n2], role]);
  }
  const acc = (await call('lead', 'POST', '/api/accreditors', { name: 'Invented Council', shortName: 'IC', type: 'institutional' })).body.id;
  ids.fw = (await call('lead', 'POST', '/api/frameworks', { accreditorId: acc, name: 'Handbook', scope: 'institution' })).body.id;
}, 30000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('the tag', () => {
  it('only a request sent as an Undo or a Redo carries kind; an ordinary action does not', async () => {
    const x = await draft();
    const del = await call('lead', 'DELETE', `/api/requirements/${x.kid}`);
    expect(del.undo!.kind).toBeUndefined();
    const undone = await send('lead', del.undo!, 'undo');
    expect(undone.undo!.kind).toBe('redo');
    expect((await send('lead', undone.undo!, 'redo')).undo!.kind).toBe('undo');
    // The same restore sent without the header (the Trash page's button) offers the delete as an ordinary Undo.
    const y = await draft();
    const del2 = await call('lead', 'DELETE', `/api/requirements/${y.kid}`);
    const plain = await call('lead', 'POST', del2.undo!.path, {});
    expect(plain.undo).toMatchObject({ method: 'POST', path: '/api/requirements/delete', body: { ids: [y.kid] } });
    expect(plain.undo!.kind).toBeUndefined();
  });
});

describe('redo after each kind of undo', () => {
  it('delete: redo deletes the same ids again as a new Trash group, and undoing that restores them with their ids', async () => {
    const x = await draft();
    const del = await call('lead', 'DELETE', `/api/requirements/${x.std}`);
    const undone = await send('lead', del.undo!, 'undo');
    expect(undone.undo).toMatchObject({ kind: 'redo', method: 'POST', path: '/api/requirements/delete', body: { ids: [x.std] } });
    expect(await codes(x.v)).toEqual(['S1', 'S1.1', 'S2']);
    const redone = await send('lead', undone.undo!, 'redo');
    expect(redone.status).toBe(200);
    expect(redone.body.groupId).not.toBe(del.undo!.path.split('/')[4]); // a new group
    expect(await codes(x.v)).toEqual(['S2']);
    expect((await send('lead', redone.undo!, 'undo')).status).toBe(200);
    expect(await codes(x.v)).toEqual(['S1', 'S1.1', 'S2']);
    expect(((await call('lead', 'GET', `/api/requirements/${x.std}`)).body).requirement.id).toBe(x.std);
  });

  it('delete several at once, and delete all of a version', async () => {
    const x = await draft();
    const many = await call('lead', 'POST', '/api/requirements/delete', { ids: [x.std, x.other] });
    const a = await undoThenRedo('lead', many.undo!);
    expect(a.undone.undo!.body).toEqual({ ids: expect.arrayContaining([x.std, x.other]) });
    expect(await codes(x.v)).toEqual([]);
    await send('lead', a.redone.undo!, 'undo');
    const all = await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements/delete-all`);
    const b = await undoThenRedo('lead', all.undo!);
    expect(b.undone.undo).toMatchObject({ path: `/api/framework-versions/${x.v}/requirements/delete-all` });
    expect(await codes(x.v)).toEqual([]);
  });

  it('restore from the Trash page: undoing it deletes again; redo restores', async () => {
    const x = await draft();
    const del = await call('lead', 'DELETE', `/api/requirements/${x.kid}`);
    const restored = await call('lead', 'POST', del.undo!.path, {});
    const { undone } = await undoThenRedo('lead', restored.undo!);
    expect(undone.undo!.path).toMatch(/\/api\/trash\/groups\/.+\/restore$/);
    expect(await codes(x.v)).toEqual(['S1', 'S1.1', 'S2']);
  });

  it('delete of a note, a link between standards and a version', async () => {
    const x = await draft();
    const note = await call('lead', 'POST', `/api/requirements/${x.std}/notes`, { type: 'guidance', text: 'Keep the minutes.', authority: 'suggested' });
    expect(note.status).toBe(201);
    const del = await call('lead', 'DELETE', `/api/notes/${note.body.id}`);
    const a = await undoThenRedo('lead', del.undo!);
    expect(a.undone.undo).toMatchObject({ method: 'DELETE', path: `/api/notes/${note.body.id}` });
    expect(((await call('lead', 'GET', `/api/requirements/${x.std}`)).body.notes as unknown[]).length).toBe(0);
    await send('lead', a.redone.undo!, 'undo');
    const ver = await call('lead', 'DELETE', `/api/framework-versions/${x.v}`);
    const b = await undoThenRedo('lead', ver.undo!);
    expect(b.undone.undo).toMatchObject({ method: 'DELETE', path: `/api/framework-versions/${x.v}` });
    expect((await call('lead', 'GET', `/api/framework-versions/${x.v}`)).status).toBe(404);
  });

  it('edit a requirement: redo writes the edited values again', async () => {
    const x = await draft();
    const edit = await call('lead', 'PATCH', `/api/requirements/${x.std}`, { title: 'Purposes and goals' });
    const { undone } = await undoThenRedo('lead', edit.undo!);
    expect(undone.undo).toMatchObject({ method: 'PATCH', path: `/api/requirements/${x.std}`, body: { title: 'Purposes and goals' } });
    expect((await call('lead', 'GET', `/api/requirements/${x.std}`)).body.requirement.title).toBe('Purposes and goals');
  });

  it('edit a note: redo writes the edited text again', async () => {
    const x = await draft();
    const note = await call('lead', 'POST', `/api/requirements/${x.std}/notes`, { type: 'guidance', text: 'First.', authority: 'suggested' });
    const edit = await call('lead', 'PATCH', `/api/notes/${note.body.id}`, { text: 'Second.' });
    const { undone } = await undoThenRedo('lead', edit.undo!);
    expect(undone.undo).toMatchObject({ method: 'PATCH', path: `/api/notes/${note.body.id}`, body: { text: 'Second.' } });
  });

  it('create: undo deletes it into the Trash, redo restores it with the same id', async () => {
    const x = await draft();
    const made = await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements`, { code: 'S3', levelLabel: 'Standard', title: 'New' });
    const { undone, redone } = await undoThenRedo('lead', made.undo!);
    expect(undone.undo).toMatchObject({ method: 'POST', path: expect.stringMatching(/\/restore$/) });
    expect(redone.undo).toMatchObject({ method: 'POST', path: '/api/requirements/delete', body: { ids: [made.body.id] } }); // the restore offers the delete again
    expect((await call('lead', 'GET', `/api/requirements/${made.body.id}`)).status).toBe(200);
  });

  it('move, indent and outdent: redo moves it there again', async () => {
    const x = await draft();
    const move = await call('lead', 'POST', `/api/requirements/${x.kid}/move`, { parentId: x.other, displayOrder: 0 });
    const { undone } = await undoThenRedo('lead', move.undo!);
    expect(undone.undo).toMatchObject({ method: 'POST', path: `/api/requirements/${x.kid}/move`, body: { parentId: x.other, displayOrder: 0 } });
    expect((await call('lead', 'GET', `/api/requirements/${x.kid}`)).body.requirement.parentId).toBe(x.other);
  });

  it('move several (drag and drop): redo puts the placements back at the target', async () => {
    const x = await draft();
    const moved = await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements/move-many`, { moves: [{ id: x.kid, parentId: x.other, index: 0 }] });
    expect(moved.status).toBe(200);
    const { undone } = await undoThenRedo('lead', moved.undo!);
    expect(undone.undo).toMatchObject({ path: `/api/framework-versions/${x.v}/requirements/move-many` });
    expect((await call('lead', 'GET', `/api/requirements/${x.kid}`)).body.requirement.parentId).toBe(x.other);
  });

  it('merge: redo merges again, and undoing that brings the requirement back', async () => {
    const x = await draft();
    const merge = await call('lead', 'POST', `/api/requirements/${x.kid}/merge`, { intoId: x.other });
    const { undone, redone } = await undoThenRedo('lead', merge.undo!);
    expect(undone.undo).toMatchObject({ method: 'POST', path: `/api/requirements/${x.kid}/merge`, body: { intoId: x.other, useMergedWording: false } });
    expect(await codes(x.v)).toEqual(['S1', 'S2']);
    expect(redone.undo!.body).toMatchObject({ revertMerge: true });
    expect((await send('lead', redone.undo!, 'undo')).status).toBe(200);
    expect(await codes(x.v)).toContain('S1.1');
  });

  it('split and unsplit: redo splits again (a new requirement), and unsplit works on that one', async () => {
    const x = await draft();
    await call('lead', 'PATCH', `/api/requirements/${x.kid}`, { officialText: 'First part. Second part.' });
    const split = await call('lead', 'POST', `/api/requirements/${x.kid}/split`, { part: 'Second part.', code: 'S1.2' });
    const undone = await send('lead', split.undo!, 'undo'); // unsplit
    expect(undone.undo).toMatchObject({ kind: 'redo', method: 'POST', path: `/api/requirements/${x.kid}/split`, body: { part: 'Second part.', code: 'S1.2', title: 'S1.2' } });
    expect(await codes(x.v)).not.toContain('S1.2');
    const redone = await send('lead', undone.undo!, 'redo');
    expect(redone.status).toBe(201);
    expect(await codes(x.v)).toContain('S1.2');
    expect(redone.body.original.officialText).toBe('First part.');
    expect(redone.undo).toMatchObject({ kind: 'undo', path: `/api/requirements/${x.kid}/unsplit`, body: { createdId: redone.body.created.id } });
    expect((await send('lead', redone.undo!, 'undo')).body.officialText).toBe('First part. Second part.');
  });

  it('the starting template and an edit of a quality item', async () => {
    const q = await call('admin', 'POST', '/api/quality-framework', {});
    const qv = q.body.versions[0].id as string;
    const tpl = await call('admin', 'POST', `/api/framework-versions/${qv}/quality-template`);
    expect(tpl.status).toBe(200);
    const total = tpl.body.length as number;
    const a = await undoThenRedo('admin', tpl.undo!);
    expect(a.undone.undo).toMatchObject({ method: 'POST', path: expect.stringMatching(/\/restore$/) });
    expect(((await call('admin', 'GET', `/api/framework-versions/${qv}/requirements`)).body as unknown[]).length).toBe(total);
    const item = (tpl.body as { id: string; code: string; title: string }[]).find((r) => r.code === '1')!;
    const edit = await call('admin', 'PATCH', `/api/quality-items/${item.id}`, { code: '1', title: 'Renamed area', description: '' });
    expect(edit.status).toBe(200);
    const b = await undoThenRedo('admin', edit.undo!);
    expect(b.undone.undo).toMatchObject({ method: 'PATCH', path: `/api/quality-items/${item.id}`, body: { code: '1', title: 'Renamed area' } });
    expect((await call('admin', 'GET', `/api/requirements/${item.id}`)).body.requirement.title).toBe('Renamed area');
  });
});

describe('a redo can be refused, and says why', () => {
  it('frozen version: the version was published after the undo', async () => {
    const x = await draft();
    const del = await call('lead', 'DELETE', `/api/requirements/${x.kid}`);
    const undone = await send('lead', del.undo!, 'undo');
    await db.su.query(`update requirement set review_status = 'approved' where framework_version_id = $1`, [x.v]);
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [x.v]);
    await db.su.query(`update framework_version set status = 'published', published_by = $2, published_at = now() where id = $1`, [x.v, ids.lead]);
    const refused = await send('lead', undone.undo!, 'redo');
    expect(refused.status).toBe(409);
    expect(refused.undo).toBeNull();
    expect(refused.body.message).toMatch(/draft|published|cannot/i);
    expect(await codes(x.v)).toEqual(['S1', 'S1.1', 'S2']); // nothing changed
  });

  it('missing parent: redoing a create (restore) after its parent was deleted', async () => {
    const x = await draft();
    const made = await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements`, { code: 'S1.2', levelLabel: 'CFR', title: 'Sub', parentId: x.std });
    const undone = await send('lead', made.undo!, 'undo');
    expect((await call('lead', 'DELETE', `/api/requirements/${x.std}`)).status).toBe(204);
    const refused = await send('lead', undone.undo!, 'redo');
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({ code: 'parent_missing' });
  });

  it('id gone: the Trash was emptied before the redo', async () => {
    const x = await draft();
    const made = await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements`, { code: 'S9', levelLabel: 'Standard', title: 'Gone' });
    const undone = await send('lead', made.undo!, 'undo');
    expect((await call('lead', 'DELETE', '/api/trash')).status).toBe(200);
    const refused = await send('lead', undone.undo!, 'redo');
    expect(refused.status).toBe(404);
    expect(refused.body.message).toMatch(/Trash/);
  });

  it('id gone: the requirement a redo would delete is not there any more', async () => {
    const x = await draft();
    const del = await call('lead', 'DELETE', `/api/requirements/${x.kid}`);
    const undone = await send('lead', del.undo!, 'undo');
    expect((await call('lead', 'DELETE', `/api/requirements/${x.kid}`)).status).toBe(204);
    expect((await send('lead', undone.undo!, 'redo')).status).toBeGreaterThanOrEqual(400);
  });

  it('permission: a redo runs the chain as the caller, so a viewer is refused', async () => {
    const x = await draft();
    const del = await call('lead', 'DELETE', `/api/requirements/${x.kid}`);
    const undone = await send('lead', del.undo!, 'undo');
    const refused = await send('viewer', undone.undo!, 'redo');
    expect(refused.status).toBe(403);
    expect(await codes(x.v)).toEqual(['S1', 'S1.1', 'S2']);
  });
});

describe('the size cap', () => {
  it('a redo whose descriptor is too long for a header is simply not offered', async () => {
    const x = await draft();
    const long = 'long text '.repeat(900);
    const edit = await call('lead', 'PATCH', `/api/requirements/${x.std}`, { officialText: long });
    expect(edit.undo).not.toBeNull(); // the earlier text (none) is short
    const undone = await send('lead', edit.undo!, 'undo');
    expect(undone.status).toBe(200);
    expect(undone.undo).toBeNull(); // the redo would carry `long`: over MAX_UNDO_HEADER
    expect(encodeURIComponent(JSON.stringify({ label: 'x', method: 'PATCH', path: 'p', body: { officialText: long }, kind: 'redo' })).length).toBeGreaterThan(MAX_UNDO_HEADER);
  });

  it('a descriptor just under the cap is still sent with its tag', async () => {
    const x = await draft();
    const text = 'a'.repeat(4000);
    const edit = await call('lead', 'PATCH', `/api/requirements/${x.std}`, { officialText: text });
    const undone = await send('lead', edit.undo!, 'undo');
    expect(undone.undo).toMatchObject({ kind: 'redo', body: { officialText: text } });
  });
});
