import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;

async function one(sql: string, params: unknown[] = []) { return (await db.su.query(sql, params)).rows[0].id as string; }

type Who = 'admin' | 'lead' | 'reviewer' | 'viewer';
async function call(who: Who | null, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const file = () => ({
  format: 'ams-framework', format_version: 1,
  accreditor: { name: 'Western Commission', short_name: 'WSCUC', type: 'institutional' },
  framework: { name: 'Handbook', scope: 'institution' },
  version: { edition: '2023' },
  config: {
    level_labels: ['Standard', 'CFR'],
    lifecycle_template: { phases: [{ type: 'self_study', name: 'Self-study', applies_to: ['reaffirmation'], milestones: [
      { key: 'submit', name: 'Submit report', type: 'submission', deliverable: { report_template_key: 'report' }, due: { anchor: 'submission_date', offset_days: 0 } }] }] },
    decision_vocab: [{ code: 'ok', label: 'Reaffirm', outcome: 'accredited', term_options: [6, 8, 10] }],
    finding_vocab: [{ code: 'rec', label: 'Recommendation', requires_action: true }],
    response_vocab: [{ code: 'letter', label: 'Action letter', is_decision: true }],
    report_templates: [{ key: 'report', name: 'Institutional Report', kind: 'self_study', structure: { sections: [{ key: 'A', title: 'Intro', block_type: 'narrative' }] } }],
  },
  source_documents: [{ ref: 'h', title: 'Handbook', role: 'standards', authority: 'binding', pages: [{ page_no: 3, text: 'Institutions must publish their mission statement.', method: 'pdf_text' }] }],
  requirements: [
    { code: 'Standard 1', parent_code: null, level_label: 'Standard', title: 'Purposes', display_order: 1 },
    { code: 'CFR 1.1', parent_code: 'Standard 1', level_label: 'CFR', title: 'Mission', official_text: 'The institution publishes its mission.',
      notes: [{ type: 'evidence_expectation', text: 'Publish the mission', authority: 'required', source: { document: 'h', page: 3, quote: 'must publish their mission statement' } }] },
  ],
});

beforeAll(async () => {
  db = await createTestDb('apifw');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool,
    authenticate: async (req) => {
      const h = req.headers.get('x-test-user');
      if (!h) return null;
      const [userId, institutionId] = h.split(':');
      return { userId: userId!, institutionId: institutionId! };
    },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [who, role] of [['admin', 'admin'], ['lead', 'lead'], ['reviewer', 'reviewer'], ['viewer', 'viewer']] as const) {
    ids[who] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, `${who}@x.org`]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[who], role]);
  }
}, 30000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('framework API', () => {
  let versionId: string;

  it('documents every framework route in the OpenAPI spec', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    for (const p of ['/api/frameworks', '/api/framework-versions/import', '/api/framework-versions/{id}/publish', '/api/requirements/{id}/notes', '/api/framework-versions/{id}/export']) {
      expect(Object.keys(spec.paths), p).toContain(p);
    }
  });

  it('requires authentication and the right role', async () => {
    expect((await call(null, 'GET', '/api/frameworks')).status).toBe(401);
    expect((await call('viewer', 'GET', '/api/frameworks')).status).toBe(200);
    expect((await call('viewer', 'POST', '/api/framework-versions/import', { file: file() })).status).toBe(403);
    expect((await call('reviewer', 'POST', '/api/accreditors', { name: 'A', shortName: 'A', type: 'regulatory' })).status).toBe(403);
  });

  it('imports a file as a draft and lists it', async () => {
    const res = await call('lead', 'POST', '/api/framework-versions/import', { file: file() });
    expect(res.status).toBe(201);
    expect(res.body.counts).toEqual({ requirements: 2, documents: 1, templates: 1 });
    versionId = res.body.version.id;
    expect(res.body.version.status).toBe('draft');
    const list = await call('viewer', 'GET', '/api/frameworks');
    expect(list.body).toEqual([expect.objectContaining({ name: 'Handbook', accreditorShortName: 'WSCUC' })]);
    const versions = await call('viewer', 'GET', `/api/frameworks/${list.body[0].id}/versions`);
    expect(versions.body.map((v: { edition: string }) => v.edition)).toEqual(['2023']);
  });

  it('serves the tree and a requirement with its notes', async () => {
    const tree = await call('viewer', 'GET', `/api/framework-versions/${versionId}/requirements`);
    expect(tree.body.map((r: { code: string; depth: number }) => [r.code, r.depth])).toEqual([['Standard 1', 0], ['CFR 1.1', 1]]);
    const detail = await call('viewer', 'GET', `/api/requirements/${tree.body[1].id}`);
    expect(detail.body.notes[0]).toMatchObject({ authority: 'required', quoteVerified: true, origin: 'import', reviewStatus: 'pending' });
    expect((await call('viewer', 'GET', `/api/requirements/${versionId}`)).status).toBe(404);
  });

  it('validates input and reports every issue', async () => {
    const bad = await call('lead', 'POST', `/api/framework-versions/${versionId}/requirements`, { code: '', levelLabel: 'x', title: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_request');
    const badConfig = await call('lead', 'PATCH', `/api/framework-versions/${versionId}/config`, { levelLabels: [] });
    expect(badConfig.status).toBe(400);
    expect(badConfig.body.issues.length).toBeGreaterThan(0);
    const dupe = await call('lead', 'POST', `/api/framework-versions/${versionId}/requirements`, { code: 'CFR 1.1', levelLabel: 'CFR', title: 'dup' });
    expect(dupe.status).toBe(409);
    expect(dupe.body.message).toMatch(/requirement_version_code_idx/);
  });

  it('publishes an external standard without per-line approval: the publisher is the review (DEC-022)', async () => {
    const check = await call('lead', 'GET', `/api/framework-versions/${versionId}/validation`);
    expect(check.body).toEqual({ ok: true, issues: [], warnings: [] });
    expect((await call('lead', 'POST', `/api/framework-versions/${versionId}/submit`)).status).toBe(200);
    expect((await call('lead', 'POST', `/api/framework-versions/${versionId}/publish`)).status).toBe(403);
    const published = await call('admin', 'POST', `/api/framework-versions/${versionId}/publish`);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ status: 'published', publishedBy: ids.admin });
  });

  it('rejects every edit after publishing with 409', async () => {
    const tree = (await call('lead', 'GET', `/api/framework-versions/${versionId}/requirements`)).body as { id: string }[];
    const edits = [
      call('lead', 'PATCH', `/api/requirements/${tree[1]!.id}`, { title: 'changed' }),
      call('lead', 'POST', `/api/framework-versions/${versionId}/requirements`, { code: 'NEW', levelLabel: 'CFR', title: 'new' }),
      call('lead', 'DELETE', `/api/requirements/${tree[1]!.id}`),
      call('lead', 'PUT', `/api/framework-versions/${versionId}/report-templates/report`, { name: 'x', kind: 'self_study', structure: { sections: [{ key: 'A', title: 'A', block_type: 'narrative' }] } }),
      call('lead', 'PATCH', `/api/framework-versions/${versionId}/config`, { changeSummary: 'x' }),
    ];
    for (const r of await Promise.all(edits)) {
      expect(r.status).toBe(409);
      expect(r.body.message).toMatch(/immutable/);
    }
  });

  it('exports the published version and creates a new draft from it', async () => {
    const exported = await call('viewer', 'GET', `/api/framework-versions/${versionId}/export`);
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({ format: 'ams-framework', version: { edition: '2023' } });
    const next = await call('lead', 'POST', `/api/framework-versions/${versionId}/new-version`, { edition: '2024', changeSummary: 'Edited CFR 1.1' });
    expect(next.status).toBe(201);
    expect(next.body).toMatchObject({ requirementsCopied: 2, version: { status: 'draft', supersedesId: versionId } });
    const tree = (await call('lead', 'GET', `/api/framework-versions/${next.body.version.id}/requirements`)).body as { id: string }[];
    expect((await call('lead', 'PATCH', `/api/requirements/${tree[1]!.id}`, { officialText: 'Revised.' })).status).toBe(200);
    // And a published version can be retired by an admin only.
    expect((await call('lead', 'POST', `/api/framework-versions/${versionId}/retire`)).status).toBe(403);
    expect((await call('admin', 'POST', `/api/framework-versions/${versionId}/retire`)).body.status).toBe('retired');
  });

  it('manages notes and templates through the API', async () => {
    const created = await call('lead', 'POST', '/api/framework-versions/import', { file: file(), edition: 'scratch' });
    const vid = created.body.version.id as string;
    const tree = (await call('lead', 'GET', `/api/framework-versions/${vid}/requirements`)).body as { id: string }[];
    const noAi = await call('lead', 'POST', `/api/requirements/${tree[1]!.id}/notes`, { type: 'guidance', text: 't', authority: 'ai_suggested' });
    expect(noAi.status).toBe(400);
    const note = await call('lead', 'POST', `/api/requirements/${tree[1]!.id}/notes`, { type: 'guidance', text: 'Example', authority: 'example' });
    expect(note.status).toBe(201);
    const renamed = await call('lead', 'PATCH', `/api/notes/${note.body.id}`, { text: 'Edited' });
    expect(renamed.body.text).toBe('Edited');
    expect((await call('lead', 'POST', `/api/notes/${note.body.id}/authority`, { authority: 'required' })).status).toBe(409); // no verified quote
    expect((await call('lead', 'DELETE', `/api/notes/${note.body.id}`)).status).toBe(204);
    const badTemplate = await call('lead', 'PUT', `/api/framework-versions/${vid}/report-templates/t2`, { name: 'T', kind: 'annual', structure: { sections: [{ key: 'T', title: 'T', block_type: 'data_table' }] } });
    expect(badTemplate.status).toBe(400);
    expect(badTemplate.body.issues[0].message).toMatch(/data_table needs columns/);
    const validation = await call('lead', 'GET', `/api/framework-versions/${vid}/validation`);
    expect(validation.body).toEqual({ ok: true, issues: [], warnings: [] });
    expect((await call('lead', 'DELETE', `/api/framework-versions/${vid}/report-templates/report`)).status).toBe(204);
    expect((await call('lead', 'GET', `/api/framework-versions/${vid}/validation`)).body.ok).toBe(false);
  });

  it('stores source documents and pages for quote verification', async () => {
    const created = await call('lead', 'POST', '/api/framework-versions/import', { file: file(), edition: 'sources' });
    const vid = created.body.version.id as string;
    const doc = await call('lead', 'POST', `/api/framework-versions/${vid}/source-documents`, { title: 'Amendment', role: 'amendment', authority: 'binding', filePath: 'a.pdf', sha256: 'e'.repeat(64) });
    expect(doc.status).toBe(201);
    const page = await call('lead', 'POST', `/api/source-documents/${doc.body.id}/pages`, { pageNo: 1, text: 'Amended text.', method: 'pdf_text' });
    expect(page.status).toBe(201);
    expect((await call('viewer', 'GET', `/api/source-documents/${doc.body.id}/pages/1`)).body.text).toBe('Amended text.');
    expect((await call('viewer', 'GET', `/api/source-documents/${doc.body.id}/pages/2`)).status).toBe(404);
    expect((await call('viewer', 'GET', `/api/framework-versions/${vid}/source-documents`)).body).toHaveLength(2);
  });
});
