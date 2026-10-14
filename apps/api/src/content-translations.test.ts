// The IQF / external standards translation routes (TASK-071) over HTTP: who may read, who may translate, edit and review (also a
// published version), validation, and that the English is never touched. The job itself is tested in core with a fake model.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore, createFakeAiModel, setAiModelForTests } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const as = (who: string) => ({ 'x-test-user': `${ids[who]}:${ids.inst}`, 'content-type': 'application/json' });
const call = (who: string | null, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: who ? as(who) : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const base = (v: string) => `/api/framework-versions/${v}/translations`;

beforeAll(async () => {
  db = await createTestDb('apicontenttr');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en, secondary_language, default_locale) values ('Gulf University', 'ar', 'en') returning id`);
  for (const n of ['admin', 'lead', 'viewer', 'ext']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2 || '@x.org') returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id, expires_at) values ($1, $2, 'external_reviewer', 'institution', $1, now() + interval '1 day')`, [ids.inst, ids.ext]);
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Accreditor', 'ACC', 'institutional') returning id`, [ids.inst]);
  const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Standards', 'institution') returning id`, [ids.inst, acc]);
  const iqf = await one(`insert into framework (institution_id, accreditor_id, name, scope, internal) values ($1, $2, 'IQF', 'institution', true) returning id`, [ids.inst, acc]);
  ids.version = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2027') returning id`, [ids.inst, fw]);
  ids.iqfVersion = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '1') returning id`, [ids.inst, iqf]);
  ids.req = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, official_text, review_status) values ($1, $2, 'S1', 'Standard', 'Governance', 'The institution is governed well.', 'approved') returning id`, [ids.inst, ids.version]);
  ids.note = await one(`insert into requirement_note (institution_id, requirement_id, type, text, authority, review_status) values ($1, $2, 'guidance', 'Show the charter.', 'example', 'approved') returning id`, [ids.inst, ids.req]);
  await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, review_status) values ($1, $2, '1', 'Standard', 'Quality', 'approved') returning id`, [ids.inst, ids.iqfVersion]);
  await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [ids.version]);
  await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [ids.version, ids.admin]);
}, 60000);
afterEach(() => setAiModelForTests(null));
afterAll(async () => { await pool.end(); await db.close(); });

describe('reading the translations of a version', () => {
  it('needs sign-in and framework:read (not an external reviewer), and tells standards from the IQF', async () => {
    expect((await call(null, 'GET', base(ids.version!))).status).toBe(401);
    expect((await call('ext', 'GET', base(ids.version!))).status).toBe(403);
    expect((await call('ext', 'GET', `${base(ids.version!)}/map`)).status).toBe(403);
    expect((await call('ext', 'GET', `${base(ids.version!)}/items`)).status).toBe(403);
    const s = await json(await call('viewer', 'GET', base(ids.version!)));
    expect(s).toMatchObject({ kind: 'standard', secondaryLanguage: 'ar', total: 3, translated: 0, run: null, readiness: null });
    expect((await json(await call('viewer', 'GET', base(ids.iqfVersion!)))).kind).toBe('iqf');
    expect((await json(await call('admin', 'GET', base(ids.version!)))).readiness).toHaveProperty('ok');
    expect((await call('viewer', 'GET', base(crypto.randomUUID()))).status).toBe(404);
    expect((await call('viewer', 'GET', `${base('not-a-uuid')}`)).status).toBe(400);
    const items = await json(await call('viewer', 'GET', `${base(ids.version!)}/items?filter=missing&limit=2`));
    expect(items.total).toBe(3);
    expect(items.rows).toHaveLength(2);
    expect(items.rows[0]).toMatchObject({ code: 'S1', english: 'Governance', text: null });
    expect(await json(await call('viewer', 'GET', `${base(ids.version!)}/map`))).toEqual({ versionId: ids.version, kind: 'standard', language: 'ar', entries: [] });
  });
});

describe('translating, editing and reviewing', () => {
  it('lets a lead (framework:write) and an administrator, not a viewer or an external reviewer, edit and review - also on a published version', async () => {
    for (const who of ['viewer', 'ext']) {
      expect((await call(who, 'PUT', base(ids.version!), { entityId: ids.req, field: 'title', text: 'x' })).status).toBe(403);
      expect((await call(who, 'POST', `${base(ids.version!)}/reviewed`, {})).status).toBe(403);
      expect((await call(who, 'POST', `${base(ids.version!)}/translate`, {})).status).toBe(403);
      expect((await call(who, 'POST', `${base(ids.version!)}/runs/${crypto.randomUUID()}/cancel`)).status).toBe(403);
      expect((await call(who, 'POST', `${base(ids.version!)}/runs/${crypto.randomUUID()}/resume`)).status).toBe(403);
    }
    const saved = await call('lead', 'PUT', base(ids.version!), { entityId: ids.req, field: 'title', text: 'الحوكمة' });
    expect(saved.status).toBe(200);
    expect(await json(saved)).toMatchObject({ entityId: ids.req, field: 'title', code: 'S1', english: 'Governance', text: 'الحوكمة', origin: 'person', reviewed: true, stale: false });
    // The unofficial standard's English is unchanged.
    expect((await db.su.query(`select title from requirement where id = $1`, [ids.req])).rows[0].title).toBe('Governance');
    expect((await call('admin', 'PUT', base(ids.version!), { entityId: ids.req, field: 'note', text: 'x' })).status).toBe(404); // the id is a requirement, not a note
    expect((await call('admin', 'PUT', base(ids.version!), { entityId: ids.note, field: 'note', text: 'أظهر الميثاق' })).status).toBe(200);
    expect((await call('admin', 'PUT', base(ids.version!), { entityId: ids.req, field: 'title', text: '' })).status).toBe(400);
    expect((await call('admin', 'PUT', base(ids.version!), { entityId: ids.req, field: 'bogus', text: 'x' })).status).toBe(400);
    expect((await call('admin', 'PUT', base(ids.version!), { entityId: ids.req, field: 'title', text: 'x', extra: 1 })).status).toBe(400);
    await db.su.query(`insert into content_translation (institution_id, kind, framework_version_id, entity_id, field, language, source_hash, text, origin) values ($1, 'standard', $2, $3, 'statement', 'ar', 'h', 'آلة', 'ai')`, [ids.inst, ids.version, ids.req]);
    expect(await json(await call('lead', 'POST', `${base(ids.version!)}/reviewed`, { items: [{ entityId: ids.req, field: 'statement' }] }))).toEqual({ marked: 1 });
    const map = await json(await call('viewer', 'GET', `${base(ids.version!)}/map`));
    expect(map.entries).toHaveLength(3);
    // The statement's stored hash is not the hash of the English, so it shows out of date; the two person rows do not.
    expect(map.entries.filter((e: { stale: boolean }) => e.stale).map((e: { field: string }) => e.field)).toEqual(['statement']);
  });

  it('starts a run for the version through the queue (never a second while one is active), cancels and resumes it', async () => {
    setAiModelForTests(createFakeAiModel([() => ({ translations: [] })]).model);
    const started = await call('lead', 'POST', `${base(ids.iqfVersion!)}/translate`, { retranslateStale: false });
    expect(started.status).toBe(201);
    const run = await json(started);
    expect(run).toMatchObject({ kind: 'iqf', language: 'ar', scopeId: ids.iqfVersion, status: 'queued' });
    expect((await call('lead', 'POST', `${base(ids.iqfVersion!)}/translate`, {})).status).toBe(409);
    // Another version's address cannot reach this run.
    expect((await call('lead', 'POST', `${base(ids.version!)}/runs/${run.id}/cancel`)).status).toBe(404);
    expect((await call('lead', 'POST', `${base(ids.iqfVersion!)}/runs/${run.id}/cancel`)).status).toBe(200);
    expect((await call('lead', 'POST', `${base(ids.iqfVersion!)}/runs/${run.id}/cancel`)).status).toBe(409);
    expect((await call('lead', 'POST', `${base(ids.iqfVersion!)}/runs/${run.id}/resume`)).status).toBe(200);
    expect((await json(await call('viewer', 'GET', base(ids.iqfVersion!)))).run).toMatchObject({ id: run.id, status: 'queued' });
    expect((await call('lead', 'POST', `${base(ids.iqfVersion!)}/translate`, { retranslateStale: 'yes' })).status).toBe(400);
  });

  it('does not offer the Languages settings kinds for content: that route only starts the interface catalogue', async () => {
    expect((await call('admin', 'POST', '/api/settings/languages/translate', { kind: 'standard' })).status).toBe(400);
    expect((await call('admin', 'POST', '/api/settings/languages/translate', { kind: 'iqf' })).status).toBe(400);
  });
});
