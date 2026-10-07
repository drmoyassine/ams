// Evidence requests over HTTP (DEC-018): a one-time link opens one request, without an account, and works once.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const as = (who: string) => ({ 'x-test-user': `${ids[who]}:${ids.inst}` });
async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method, headers: { 'content-type': 'application/json', ...(who ? as(who) : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const upload = (path: string, text: string, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { ...headers, 'content-type': 'application/pdf' }, body: new TextEncoder().encode(text) });

beforeAll(async () => {
  db = await createTestDb('apirequests');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2 || '@x.org') returning id`, [ids.inst, n]);
  for (const [u, role] of [['lead', 'lead'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  const qf = await call('lead', 'POST', '/api/quality-framework', { template: true });
  const items = await call('lead', 'GET', `/api/framework-versions/${qf.body.versions[0].id}/requirements`);
  ids.item = (items.body as { id: string; title: string }[]).find((r) => r.title === 'Assessment of learning')!.id;
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('evidence requests API', () => {
  it('a signed-in person asked answers from their requests', async () => {
    expect((await call('viewer', 'POST', `/api/requirements/${ids.item}/evidence-requests`, { title: 'x', assigneeEmail: 'lead@x.org' })).status).toBe(403);
    const made = await call('lead', 'POST', `/api/requirements/${ids.item}/evidence-requests`, { title: 'Exit survey', assigneeEmail: 'viewer@x.org' });
    expect(made.status).toBe(201);
    expect(made.body.linkToken).toBeNull();
    const mine = await call('viewer', 'GET', '/api/evidence-requests?mine=true');
    expect(mine.body.map((r: { id: string }) => r.id)).toEqual([made.body.request.id]);
    const res = await upload(`/api/evidence-requests/${made.body.request.id}/answer?fileName=exit.pdf&note=${encodeURIComponent('Spring cohort')}`, 'exit', as('viewer'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'supplied', suppliedNote: 'Spring cohort' });
  });

  it('a one-time link shows the request and takes one answer, with no account', async () => {
    const made = await call('lead', 'POST', `/api/requirements/${ids.item}/evidence-requests`, { title: 'Employer survey', assigneeEmail: 'hr@partner.com', message: 'Last year' });
    const token = made.body.linkToken as string;
    expect(token).toBeTruthy();
    const shown = await call(null, 'GET', `/api/response-links/${token}`);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ title: 'Employer survey', message: 'Last year', institutionName: 'Gulf University' });
    expect(shown.body).not.toHaveProperty('assigneeEmail');
    expect((await call(null, 'GET', '/api/response-links/not-a-real-link-not-a-real-link')).status).toBe(404);
    // The link opens this request only: it does not sign anyone in elsewhere.
    expect((await app.request('/api/evidence', { headers: { 'x-link': token } })).status).toBe(401);

    expect((await upload(`/api/response-links/${token}/answer?fileName=survey.pdf`, 'employers')).status).toBe(204);
    expect((await upload(`/api/response-links/${token}/answer?fileName=again.pdf`, 'again')).status).toBe(404);
    expect((await call(null, 'GET', `/api/response-links/${token}`)).status).toBe(404);
    const all = await call('lead', 'GET', `/api/requirements/${ids.item}/evidence-requests`);
    expect(all.body.find((r: { id: string }) => r.id === made.body.request.id)).toMatchObject({ status: 'supplied', evidenceItemId: expect.any(String) });
  });

  it('a new link replaces the old one; cancelling closes it', async () => {
    const made = await call('lead', 'POST', `/api/requirements/${ids.item}/evidence-requests`, { title: 'Board minutes', assigneeEmail: 'board@partner.com' });
    const renewed = await call('lead', 'POST', `/api/evidence-requests/${made.body.request.id}/new-link`);
    expect(renewed.status).toBe(200);
    expect((await call(null, 'GET', `/api/response-links/${made.body.linkToken}`)).status).toBe(404);
    expect((await call(null, 'GET', `/api/response-links/${renewed.body.linkToken}`)).status).toBe(200);
    expect((await call('lead', 'POST', `/api/evidence-requests/${made.body.request.id}/cancel`)).status).toBe(200);
    expect((await call(null, 'GET', `/api/response-links/${renewed.body.linkToken}`)).status).toBe(404);
  });
});
