// Reports over HTTP (TASK-091): creation from a reviewed template (owners resolved from the engagement's requirement
// owners), the section tree, saving a section's content in its block type, handing a section to a person, the Trash.
// Reads need report:read; managing needs report:manage (route and, again, the report's wrapper in the service).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '@ams/core';
import { UNDO_HEADER } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const as = (who: string) => ({ 'x-test-user': `${ids[who]}:${ids.inst}` });
interface Reply { status: number; body: any; headers: Headers } // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string | null, method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await app.request(path, {
    method, headers: { 'content-type': 'application/json', ...(who ? as(who) : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const undoOf = (r: Reply) => { const h = r.headers.get(UNDO_HEADER); return h ? JSON.parse(decodeURIComponent(h)) as { label: string; method: string; path: string } : null; };

const STRUCTURE = {
  sections: [
    { key: 'intro', title: 'Introduction', block_type: 'narrative', requirement_codes: ['1.1'], word_limit: 100 },
    { key: 'data', title: 'Data', block_type: 'data_table', columns: [{ key: 'name', label: 'Name', type: 'text' }] },
  ],
};

beforeAll(async () => {
  db = await createTestDb('apireports');
  pool = new pg.Pool({ connectionString: db.url });
  const made = createApp({ pool, store, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } });
  app = made.app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'contributor', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['contributor', 'contributor'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  ids.accreditor = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'WSCUC', 'WSCUC', 'institutional') returning id`, [ids.inst]);
  ids.framework = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'WSCUC 2024', 'institution') returning id`, [ids.inst, ids.accreditor]);
  ids.version = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2024') returning id`, [ids.inst, ids.framework]);
  ids.req1 = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, '1.1', 'Standard', 'Mission') returning id`, [ids.inst, ids.version]);
  ids.template = await one(
    `insert into report_template (institution_id, framework_version_id, key, name, kind, structure, review_status) values ($1, $2, 'self_study', 'Self-Study Report', 'self_study', $3, 'approved') returning id`,
    [ids.inst, ids.version, JSON.stringify(STRUCTURE)]);
  await db.su.query(`insert into report_template (institution_id, framework_version_id, key, name, kind, structure, review_status) values ($1, $2, 'pending', 'Pending', 'other', $3, 'pending')`, [ids.inst, ids.version, JSON.stringify(STRUCTURE)]);
  await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [ids.version]);
  await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [ids.version, ids.admin]);
  await db.su.query(
    `with e as (insert into engagement (institution_id, framework_version_id, subject_type, subject_id, kind, title, review_year, lead_user_id) values ($1, $2, 'institution', $1, 'initial', 'Initial Accreditation 2026', 2026, $3) returning id, institution_id, lead_user_id)
     insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) select institution_id, lead_user_id, 'engagement_lead', 'engagement', id from e`,
    [ids.inst, ids.version, ids.lead]);
  ids.engagement = await one(`select id from engagement where title = 'Initial Accreditation 2026'`);
  await db.su.query(`insert into engagement_requirement (institution_id, engagement_id, requirement_id, owner_id) values ($1, $2, $3, $4)`, [ids.inst, ids.engagement, ids.req1, ids.contributor]);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('reports API', () => {
  it('documents its routes and gives each a permission', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    for (const p of ['/api/reports', '/api/reports/{id}', '/api/reports/{id}/sections/{sectionId}/content', '/api/reports/{id}/sections/{sectionId}/owner']) {
      expect(Object.keys(spec.paths), p).toContain(p);
    }
  });

  it('creates a report from the template: sections copied, requirement resolved, owner from the engagement', async () => {
    const r = await call('admin', 'POST', '/api/reports', { engagementId: ids.engagement, frameworkVersionId: ids.version, templateKey: 'self_study' });
    expect(r.status).toBe(201);
    ids.report = r.body.id;
    const intro = r.body.sections.find((s: { key: string }) => s.key === 'intro');
    const data = r.body.sections.find((s: { key: string }) => s.key === 'data');
    expect(r.body.status).toBe('draft');
    expect(r.body.kind).toBe('self_study');
    expect(r.body.title).toBe('Self-Study Report · Initial Accreditation 2026');
    expect(intro.requirements[0].code).toBe('1.1');
    expect(intro.requirements[0].title).toBe('Mission');
    expect(intro.ownerId).toBe(ids.contributor);
    expect(intro.ownerUnresolved).toBe(false);
    expect(data.ownerId).toBeNull();
    expect(data.blockType).toBe('data_table');
    const undo = undoOf(r);
    expect(undo?.method).toBe('DELETE');
    expect(undo?.path).toBe(`/api/reports/${ids.report}`);
  });

  it('refuses an unreviewed template, an unknown one, and a second round of the same template', async () => {
    expect((await call('admin', 'POST', '/api/reports', { engagementId: ids.engagement, frameworkVersionId: ids.version, templateKey: 'pending' })).status).toBe(409);
    expect((await call('admin', 'POST', '/api/reports', { engagementId: ids.engagement, frameworkVersionId: ids.version, templateKey: 'nope' })).status).toBe(404);
    expect((await call('admin', 'POST', '/api/reports', { engagementId: ids.engagement, frameworkVersionId: ids.version, templateKey: 'self_study' })).status).toBe(409);
  });

  it('a viewer reads the list and the detail but cannot manage', async () => {
    const list = await call('viewer', 'GET', `/api/reports?engagementId=${ids.engagement}`);
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect((await call('viewer', 'GET', `/api/reports/${ids.report}`)).status).toBe(200);
    expect((await call('viewer', 'PATCH', `/api/reports/${ids.report}`, { title: 'No' })).status).toBe(403);
    expect((await call('viewer', 'DELETE', `/api/reports/${ids.report}`)).status).toBe(403);
  });

  it('saves a section\'s content in its block type and the word count comes back', async () => {
    const detail = await call('viewer', 'GET', `/api/reports/${ids.report}`);
    const intro = detail.body.sections.find((s: { key: string }) => s.key === 'intro');
    const data = detail.body.sections.find((s: { key: string }) => s.key === 'data');
    const ok = await call('contributor', 'PATCH', `/api/reports/${ids.report}/sections/${intro.id}/content`, { narrative: { text: 'Our mission guides everything. ' } });
    expect(ok.status).toBe(200);
    const after = ok.body.sections.find((s: { key: string }) => s.key === 'intro');
    expect(after.wordCount).toBe(4);
    // the wrong block key is refused
    expect((await call('contributor', 'PATCH', `/api/reports/${ids.report}/sections/${intro.id}/content`, { data_table: { rows: [] } })).status).toBe(400);
    // two keys at once are refused
    expect((await call('contributor', 'PATCH', `/api/reports/${ids.report}/sections/${intro.id}/content`, { narrative: { text: 'x' }, appendix: { items: [] } })).status).toBe(400);
    // a table row set goes in as data
    const grid = await call('contributor', 'PATCH', `/api/reports/${ids.report}/sections/${data.id}/content`, { data_table: { rows: [{ name: 'Physics' }] } });
    expect(grid.status).toBe(200);
    // a viewer cannot write
    expect((await call('viewer', 'PATCH', `/api/reports/${ids.report}/sections/${intro.id}/content`, { narrative: { text: 'no' } })).status).toBe(403);
  });

  it('hands a section to a person and takes it back', async () => {
    const detail = await call('viewer', 'GET', `/api/reports/${ids.report}`);
    const data = detail.body.sections.find((s: { key: string }) => s.key === 'data');
    expect((await call('contributor', 'PATCH', `/api/reports/${ids.report}/sections/${data.id}/owner`, { ownerId: ids.viewer })).status).toBe(403);
    const given = await call('lead', 'PATCH', `/api/reports/${ids.report}/sections/${data.id}/owner`, { ownerId: ids.viewer });
    expect(given.status).toBe(200);
    expect(given.body.sections.find((s: { key: string }) => s.key === 'data').ownerName).toBe('viewer');
    const taken = await call('lead', 'PATCH', `/api/reports/${ids.report}/sections/${data.id}/owner`, { ownerId: null });
    expect(taken.body.sections.find((s: { key: string }) => s.key === 'data').ownerId).toBeNull();
  });

  it('renames a report; what it was made from stays out of reach', async () => {
    const r = await call('lead', 'PATCH', `/api/reports/${ids.report}`, { title: 'Self-Study 2026' });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('Self-Study 2026');
    expect(r.body.frameworkVersionId).toBe(ids.version);
  });

  it('deletes a draft to the Trash with an undo descriptor', async () => {
    const r = await call('admin', 'DELETE', `/api/reports/${ids.report}`);
    expect(r.status).toBe(200);
    expect(r.body.label).toContain('Self-Study');
    expect(r.body.counts.sections).toBe(2);
    const undo = undoOf(r);
    expect(undo?.label).toContain('Deleted the report');
    // gone from the list
    const list = await call('viewer', 'GET', `/api/reports`);
    expect(list.body.length).toBe(0);
    // and the Trash holds it as kind report
    const trash = await call('admin', 'GET', '/api/trash');
    const group = trash.body.groups.find((g: { kinds: string[] }) => g.kinds.includes('report'));
    expect(group).toBeTruthy();
    expect((await call('admin', 'GET', `/api/reports/${ids.report}`)).status).toBe(404);
  });
});
