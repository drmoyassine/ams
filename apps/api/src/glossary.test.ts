import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';
import { seedFrameworks } from './seed.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeAll(async () => {
  db = await createTestDb('apigloss');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  const grant = (u: string, role: string) => db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u], role]);
  await grant('admin', 'admin'); await grant('lead', 'lead'); await grant('viewer', 'viewer');
  await seedFrameworks(pool);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('glossary API', () => {
  it('documents its routes and needs authentication', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    for (const p of ['/api/glossary', '/api/glossary/external-terms', '/api/glossary/terms', '/api/glossary/terms/{id}', '/api/glossary/aliases', '/api/glossary/auto-map', '/api/glossary/seed-defaults']) expect(Object.keys(spec.paths), p).toContain(p);
    expect((await call(null, 'GET', '/api/glossary')).status).toBe(401);
  });

  it('lets a lead seed, map and edit, and everyone read', async () => {
    expect((await call('viewer', 'POST', '/api/glossary/seed-defaults')).status).toBe(403);
    expect((await call('lead', 'POST', '/api/glossary/seed-defaults')).body.added).toBeGreaterThanOrEqual(8);
    const mapped = await call('lead', 'POST', '/api/glossary/auto-map', {});
    expect(mapped.body.mapped).toBeGreaterThan(20);
    const g = (await call('viewer', 'GET', '/api/glossary')).body;
    expect(g.terms.length).toBeGreaterThanOrEqual(8);
    expect(g.aliases.length).toBe(mapped.body.mapped);

    const ext = (await call('viewer', 'GET', '/api/glossary/external-terms')).body as { accreditorShortName: string; frameworkId: string; terms: { externalTerm: string; termId: string | null }[] }[];
    expect(ext.map((s) => s.accreditorShortName)).toEqual(['ABET', 'PUC', 'WSCUC']);
    const wscuc = ext.find((s) => s.accreditorShortName === 'WSCUC')!;
    const group = g.terms.find((t: { key: string }) => t.key === 'requirement_group').id;
    expect((await call('lead', 'PUT', '/api/glossary/aliases', { frameworkId: wscuc.frameworkId, source: 'level_label', externalTerm: 'CFR', termId: group })).status).toBe(204);
    const after = (await call('viewer', 'GET', '/api/glossary/external-terms')).body.find((s: { accreditorShortName: string }) => s.accreditorShortName === 'WSCUC');
    expect(after.terms.find((t: { externalTerm: string }) => t.externalTerm === 'CFR').termId).toBe(group);
    const wrongKind = g.terms.find((t: { key: string }) => t.key === 'observation').id;
    expect((await call('lead', 'PUT', '/api/glossary/aliases', { frameworkId: wscuc.frameworkId, source: 'level_label', externalTerm: 'CFR', termId: wrongKind })).status).toBe(409);
    expect((await call('lead', 'PUT', '/api/glossary/aliases', { frameworkId: wscuc.frameworkId, source: 'level_label', externalTerm: 'Nope', termId: group })).status).toBe(400);
  });

  it('adds and edits terms with Arabic labels', async () => {
    const t = await call('lead', 'POST', '/api/glossary/terms', { kind: 'general', labelEn: 'Quality cycle', labelAr: 'دورة الجودة' });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ key: 'quality_cycle', labelAr: 'دورة الجودة' });
    expect((await call('lead', 'POST', '/api/glossary/terms', { kind: 'general', labelEn: 'Quality cycle' })).status).toBe(409);
    expect((await call('lead', 'PATCH', `/api/glossary/terms/${t.body.id}`, { definitionEn: 'One turn of plan, do, check, act.' })).body.definitionEn).toBe('One turn of plan, do, check, act.');
    expect((await call('viewer', 'PATCH', `/api/glossary/terms/${t.body.id}`, { labelEn: 'x' })).status).toBe(403);
    expect((await call('lead', 'POST', '/api/glossary/terms', { kind: 'general', labelEn: 'x', key: 'Bad Key' })).status).toBe(400);
  });
});
