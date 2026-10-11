// F2 through the five-step chain: create a standard from files (then upload each file to its source), the source viewer's
// page+highlight, the "needs a look" list, merge and split.
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
async function call(who: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = {
    method,
    headers: { ...(who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {}), ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? (body as unknown as BodyInit) : JSON.stringify(body) }),
  };
  const res = await app.request(path, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const PAGE = 'المعيار الأول\nيَجِبُ أَنْ تَكُونَ لِلْمُؤَسَّسَةِ رِسَالَةٌ مُعْلَنَةٌ.\nThe institution must publish its mission statement.';

beforeAll(async () => {
  db = await createTestDb('apireview');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store: new MemoryStore(), queue: { send: async () => undefined },
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [n, role] of [['lead', 'lead'], ['viewer', 'viewer']] as const) {
    ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[n], role]);
  }
}, 30000);
afterAll(async () => { await pool.end(); await db.close(); });

const newStandard = { accreditor: { name: 'Invented Council', shortName: 'IC' }, name: 'Institutional Standards', scope: 'institution', edition: '2030', files: [{ name: 'Handbook.pdf', size: 12 }, { name: 'دليل.docx' }] };

describe('create from files API', () => {
  it('is documented, needs a sign-in and framework:write', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
      '/api/framework-versions/from-files', '/api/source-documents/{id}/pages/{pageNo}/view', '/api/framework-versions/{id}/review-items',
      '/api/requirements/{id}/merge', '/api/requirements/{id}/split', '/api/source-limits',
    ]));
    expect((await call(null, 'POST', '/api/framework-versions/from-files', newStandard)).status).toBe(401);
    expect((await call('viewer', 'POST', '/api/framework-versions/from-files', newStandard)).status).toBe(403);
    const lim = await call('viewer', 'GET', '/api/source-limits');
    expect(lim).toMatchObject({ status: 200, body: { maxFiles: 40 } });
    expect(lim.body.maxFileBytes).toBeGreaterThan(0);
  });

  it('creates everything in one call, then each file is uploaded to its document', async () => {
    const r = await call('lead', 'POST', '/api/framework-versions/from-files', newStandard);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ accreditor: { shortName: 'IC', created: true }, framework: { name: 'Institutional Standards', scope: 'institution' }, version: { edition: '2030', status: 'draft' } });
    expect(r.body.documents.map((d: { title: string }) => d.title)).toEqual(['Handbook', 'دليل']);
    ids.version = r.body.version.id;
    ids.accreditor = r.body.accreditor.id;
    ids.doc = r.body.documents[0].id;
    const up = await call('lead', 'PUT', `/api/source-documents/${ids.doc}/file?fileName=${encodeURIComponent('Handbook.pdf')}`, new TextEncoder().encode('%PDF-1.7 handbook'), { 'content-type': 'application/pdf' });
    expect(up).toMatchObject({ status: 200, body: { fileName: 'Handbook.pdf', roleOrigin: 'unset', size: 17 } });
    const docs = await call('viewer', 'GET', `/api/framework-versions/${ids.version}/source-documents`);
    expect(docs.body.map((d: { hasFile: boolean }) => d.hasFile).sort()).toEqual([false, true]); // the second one is still waiting for its file: visible, retryable
  });

  it('reuses an accreditor by id, and answers the rules with 400 and 409', async () => {
    const again = await call('lead', 'POST', '/api/framework-versions/from-files', { accreditorId: ids.accreditor, name: 'Programme Standards', scope: 'program', edition: '2031', files: [{ name: 'a.pdf' }] });
    expect(again).toMatchObject({ status: 201, body: { accreditor: { id: ids.accreditor, created: false } } });
    const none = await call('lead', 'POST', '/api/framework-versions/from-files', { name: 'X', scope: 'program', edition: '1', files: [{ name: 'a.pdf' }] });
    expect(none.status).toBe(400);
    expect(JSON.stringify(none.body)).toMatch(/existing accreditor or give a new one/);
    const empty = await call('lead', 'POST', '/api/framework-versions/from-files', { ...newStandard, accreditor: undefined, accreditorId: ids.accreditor, name: 'Y', files: [] });
    expect(empty.status).toBe(400);
    const dup = await call('lead', 'POST', '/api/framework-versions/from-files', { accreditorId: ids.accreditor, name: 'institutional standards', scope: 'institution', edition: '2032', files: [{ name: 'a.pdf' }] });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toMatch(/already has a standard called/);
    const huge = await call('lead', 'POST', '/api/framework-versions/from-files', { accreditorId: ids.accreditor, name: 'Z', scope: 'both', edition: '1', files: [{ name: 'huge.pdf', size: 10 ** 12 }] });
    expect(huge.status).toBe(400);
    expect(huge.body.message).toMatch(/huge\.pdf.*larger than/);
  });
});

describe('source page view API', () => {
  it('returns the page with the range of the cited quote, Arabic written without marks included', async () => {
    const doc = await one(`insert into source_document (institution_id, framework_version_id, title, role, authority, file_path, sha256) values ($1,$2,'Handbook','standards','binding','p',$3) returning id`, [ids.inst, ids.version, 'c'.repeat(64)]);
    ids.pdoc = doc;
    await db.su.query(`insert into source_page (institution_id, source_document_id, page_no, text, method) values ($1,$2,1,$3,'pdf_text')`, [ids.inst, doc, PAGE]);
    const q = encodeURIComponent('يجب أن تكون للمؤسسة رسالة معلنة');
    const hit = await call('viewer', 'GET', `/api/source-documents/${doc}/pages/1/view?quote=${q}`);
    expect(hit.status).toBe(200);
    expect(hit.body.page.text.slice(hit.body.highlight.start, hit.body.highlight.end)).toBe('يَجِبُ أَنْ تَكُونَ لِلْمُؤَسَّسَةِ رِسَالَةٌ مُعْلَنَةٌ');
    const miss = await call('viewer', 'GET', `/api/source-documents/${doc}/pages/1/view?quote=${encodeURIComponent('nothing like this appears')}`);
    expect(miss.body).toMatchObject({ highlight: null, quoteFoundOnPage: null, quoteGiven: true, pageNos: [1] });
    expect((await call('viewer', 'GET', `/api/source-documents/${doc}/pages/9/view`)).body.page).toBeNull();
    expect((await call('viewer', 'GET', `/api/source-documents/${doc}/pages/0/view`)).status).toBe(400);
    expect((await call(null, 'GET', `/api/source-documents/${doc}/pages/1/view`)).status).toBe(401);
  });
});

describe('merge, split and review items API', () => {
  const req = (code: string, text: string | null = null, parent: string | null = null) => one(
    `insert into requirement (institution_id, framework_version_id, parent_id, code, level_label, title, official_text, origin, source_document_id, source_page, source_quote, quote_verified)
     values ($1,$2,$3,$4,'Standard',$4,$5,'ai',$6,1,'The institution must publish its mission statement.',false) returning id`, [ids.inst, ids.version, parent, code, text, ids.pdoc]);

  it('lists what needs a look', async () => {
    const r = await req('R1', 'x');
    const list = await call('viewer', 'GET', `/api/framework-versions/${ids.version}/review-items`);
    expect(list.status).toBe(200);
    expect(list.body.requirements).toEqual([{ id: r, quoteNotFound: true, lowConfidence: false, orphan: false }]);
    await db.su.query(`delete from requirement where id = $1`, [r]);
  });

  it('merges one requirement into another and splits a part out of one; both need framework:write', async () => {
    const a = await req('A', 'Alpha. Beta.');
    const b = await req('B', 'Bravo.');
    const child = await req('A.1', null, a);
    expect((await call('viewer', 'POST', `/api/requirements/${a}/merge`, { intoId: b })).status).toBe(403);
    expect((await call('viewer', 'POST', `/api/requirements/${a}/split`, { part: 'Beta.', code: 'A2' })).status).toBe(403);

    const split = await call('lead', 'POST', `/api/requirements/${a}/split`, { part: 'Beta.', code: 'A2' });
    expect(split.status).toBe(201);
    expect(split.body.original).toMatchObject({ id: a, officialText: 'Alpha.', editedByPerson: true });
    expect(split.body.created).toMatchObject({ code: 'A2', officialText: 'Beta.', origin: 'manual', quoteVerified: false });
    expect((await call('lead', 'POST', `/api/requirements/${a}/split`, { part: 'Gamma.', code: 'A3' })).status).toBe(400);
    const b2 = await req('B2', 'Echo. Foxtrot.');
    expect((await call('lead', 'POST', `/api/requirements/${b2}/split`, { part: 'Foxtrot.', code: 'A2' })).status).toBe(409); // the code is taken

    const merged = await call('lead', 'POST', `/api/requirements/${a}/merge`, { intoId: b });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({ movedChildren: 1, movedNotes: 0, requirement: { id: b, officialText: 'Bravo.', editedByPerson: true } });
    expect((await call('lead', 'GET', `/api/requirements/${a}`)).status).toBe(404);
    expect((await db.su.query(`select parent_id from requirement where id = $1`, [child])).rows[0].parent_id).toBe(b);
    expect((await call('lead', 'POST', `/api/requirements/${b}/merge`, { intoId: b })).status).toBe(400);
  });

  it('refuses both on a published version', async () => {
    const a = await req('P1', 'One. Two.');
    const b = await req('P2', 'Three.');
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [ids.version]);
    await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [ids.version, ids.lead]);
    expect((await call('lead', 'POST', `/api/requirements/${a}/merge`, { intoId: b })).status).toBe(409);
    expect((await call('lead', 'POST', `/api/requirements/${a}/split`, { part: 'Two.', code: 'P3' })).status).toBe(409);
    expect((await db.su.query(`select count(*)::int as n from requirement where id = any($1)`, [[a, b]])).rows[0].n).toBe(2);
  });
});
