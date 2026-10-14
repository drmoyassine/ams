// Languages over HTTP (TASK-070): the preferences route (own row only), the Languages settings routes (read for the
// organization's readers, change for administrators), the catalogue served to signed-in people with an ETag, and the narrow
// public sign-in read (only the sign-in keys, nothing else).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { EN_CATALOGUE, PUBLIC_UI_KEYS } from '@ams/shared';
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

beforeAll(async () => {
  db = await createTestDb('apilang');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en, name_ar, secondary_language, default_locale) values ('Gulf University', 'جامعة الخليج', 'ar', 'en') returning id`);
  for (const n of ['admin', 'lead', 'viewer', 'ext']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2 || '@x.org') returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id, expires_at) values ($1, $2, 'external_reviewer', 'institution', $1, now() + interval '1 day')`, [ids.inst, ids.ext]);
  await db.su.query(`insert into ui_translation (institution_id, language, key, source_hash, text, origin) values
    ($1, 'ar', 'login.title', 'h', 'تسجيل الدخول', 'ai'), ($1, 'ar', 'login.email', 'h', 'البريد الإلكتروني', 'ai'), ($1, 'ar', 'nav.settings', 'h', 'الإعدادات', 'ai'), ($1, 'ar', 'removed.key', 'h', 'x', 'ai'), ($1, 'fr', 'login.title', 'h', 'Connexion', 'ai')`, [ids.inst]);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('preferences: /api/me/preferences', () => {
  it('needs a signed-in person and changes only their own row', async () => {
    expect((await call(null, 'PATCH', '/api/me/preferences', { uiLocale: 'ar' })).status).toBe(401);
    const me = await json(await call('viewer', 'GET', '/api/me'));
    expect(me.language).toEqual({ secondaryLanguage: 'ar', defaultLocale: 'en', uiLocale: null, effectiveLocale: 'en' });
    const r = await call('viewer', 'PATCH', '/api/me/preferences', { uiLocale: 'ar' });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ secondaryLanguage: 'ar', defaultLocale: 'en', uiLocale: 'ar', effectiveLocale: 'ar' });
    expect((await db.su.query(`select ui_locale from app_user where id = $1`, [ids.viewer])).rows[0].ui_locale).toBe('ar');
    // Nobody else changed; the body cannot name another person.
    expect((await db.su.query(`select count(*)::int as n from app_user where ui_locale is not null`)).rows[0].n).toBe(1);
    expect((await call('lead', 'PATCH', '/api/me/preferences', { uiLocale: 'en', userId: ids.viewer })).status).toBe(400);
    expect((await db.su.query(`select ui_locale from app_user where id = $1`, [ids.viewer])).rows[0].ui_locale).toBe('ar');
  });

  it('accepts only English, the secondary language or null', async () => {
    expect((await call('lead', 'PATCH', '/api/me/preferences', { uiLocale: 'fr' })).status).toBe(400);
    expect((await call('lead', 'PATCH', '/api/me/preferences', { uiLocale: 'xx' })).status).toBe(400);
    expect((await call('lead', 'PATCH', '/api/me/preferences', {})).status).toBe(400);
    expect((await call('viewer', 'PATCH', '/api/me/preferences', { uiLocale: null })).status).toBe(200);
    // An external reviewer is a signed-in person too.
    expect((await call('ext', 'PATCH', '/api/me/preferences', { uiLocale: 'en' })).status).toBe(200);
  });
});

describe('the catalogue: /api/i18n/{language}', () => {
  it('needs sign-in, serves the secondary language only for known keys, with an ETag and 304', async () => {
    expect((await call(null, 'GET', '/api/i18n/ar')).status).toBe(401);
    const r = await call('viewer', 'GET', '/api/i18n/ar');
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.language).toBe('ar');
    expect(body.strings).toEqual({ 'login.title': 'تسجيل الدخول', 'login.email': 'البريد الإلكتروني', 'nav.settings': 'الإعدادات' }); // removed.key is not served
    const etag = r.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    expect(r.headers.get('cache-control')).toContain('no-cache');
    const again = await app.request('/api/i18n/ar', { headers: { ...as('viewer'), 'if-none-match': etag } });
    expect(again.status).toBe(304);
    await db.su.query(`update ui_translation set text = 'الإعدادات!' , updated_at = now() + interval '1 minute' where key = 'nav.settings'`);
    const changed = await call('viewer', 'GET', '/api/i18n/ar');
    expect(changed.headers.get('etag')).not.toBe(etag);
    expect((await app.request('/api/i18n/ar', { headers: { ...as('viewer'), 'if-none-match': etag } })).status).toBe(200);
  });

  it('answers 404 for a language that is not the secondary one and 400 for one that is not a language', async () => {
    expect((await call('viewer', 'GET', '/api/i18n/fr')).status).toBe(404);
    expect((await call('viewer', 'GET', '/api/i18n/en')).status).toBe(404);
    expect((await call('viewer', 'GET', '/api/i18n/klingon')).status).toBe(400);
  });
});

describe('Languages settings routes', () => {
  it('lets organization readers see the status and the review table, but not an external reviewer', async () => {
    expect((await call(null, 'GET', '/api/settings/languages')).status).toBe(401);
    expect((await call('ext', 'GET', '/api/settings/languages')).status).toBe(403);
    const s = await json(await call('viewer', 'GET', '/api/settings/languages'));
    expect(s).toMatchObject({ secondaryLanguage: 'ar', defaultLocale: 'en', run: null, readiness: null });
    expect(s.catalogue).toMatchObject({ language: 'ar', translated: 3, reviewed: 0 });
    const admin = await json(await call('admin', 'GET', '/api/settings/languages'));
    expect(admin.readiness).toHaveProperty('ok'); // only people who can start a run see whether one can start
    const t = await json(await call('viewer', 'GET', '/api/settings/languages/translations?filter=needs_review&limit=2'));
    expect(t.total).toBe(3);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]).toHaveProperty('english');
  });

  it('lets only an administrator edit, mark reviewed, start, cancel and resume', async () => {
    for (const who of ['lead', 'viewer', 'ext']) {
      expect((await call(who, 'PUT', '/api/settings/languages/translations', { key: 'nav.settings', text: 'x' })).status).toBe(403);
      expect((await call(who, 'POST', '/api/settings/languages/translations/reviewed', {})).status).toBe(403);
      expect((await call(who, 'POST', '/api/settings/languages/translate', {})).status).toBe(403);
      expect((await call(who, 'POST', `/api/settings/languages/translate/${crypto.randomUUID()}/cancel`)).status).toBe(403);
      expect((await call(who, 'POST', `/api/settings/languages/translate/${crypto.randomUUID()}/resume`)).status).toBe(403);
      expect((await call(who, 'PATCH', '/api/institution', { secondaryLanguage: 'fr' })).status).toBe(403);
    }
    const saved = await call('admin', 'PUT', '/api/settings/languages/translations', { key: 'nav.settings', text: 'الإعدادات' });
    expect(saved.status).toBe(200);
    expect(await json(saved)).toMatchObject({ key: 'nav.settings', origin: 'person', reviewed: true });
    expect((await call('admin', 'PUT', '/api/settings/languages/translations', { key: 'nav.myRequests', text: 'طلباتي' })).status).toBe(400);
    expect((await call('admin', 'POST', '/api/settings/languages/translations/reviewed', {})).status).toBe(200);
    expect((await call('admin', 'POST', `/api/settings/languages/translate/${crypto.randomUUID()}/cancel`)).status).toBe(404);
  });

  it('starts a run through the queue and refuses a second while it is active', async () => {
    const r = await call('admin', 'POST', '/api/settings/languages/translate', { kind: 'ui' });
    // The test process has no AI configured: either the run is queued, or the readiness check says why not.
    if (r.status === 201) {
      const run = await json(r);
      expect(run).toMatchObject({ kind: 'ui', language: 'ar', status: 'queued' });
      expect((await call('admin', 'POST', '/api/settings/languages/translate', { kind: 'ui' })).status).toBe(409);
      expect((await call('admin', 'POST', `/api/settings/languages/translate/${run.id}/cancel`)).status).toBe(200);
    } else {
      expect(r.status).toBe(409);
    }
  });

  it('changes the institution\'s languages through PATCH /api/institution with the registry rules', async () => {
    expect((await call('admin', 'PATCH', '/api/institution', { secondaryLanguage: 'en' })).status).toBe(400);
    expect((await call('admin', 'PATCH', '/api/institution', { secondaryLanguage: 'nope' })).status).toBe(400);
    expect((await call('admin', 'PATCH', '/api/institution', { defaultLocale: 'fr' })).status).toBe(400);
    const r = await call('admin', 'PATCH', '/api/institution', { defaultLocale: 'ar' });
    expect(await json(r)).toMatchObject({ secondaryLanguage: 'ar', defaultLocale: 'ar' });
    expect((await json(await call('viewer', 'GET', '/api/me'))).language).toMatchObject({ defaultLocale: 'ar', effectiveLocale: 'ar' });
    await call('admin', 'PATCH', '/api/institution', { defaultLocale: 'en' });
  });
});

describe('public sign-in language: /api/public/i18n', () => {
  it('serves the language codes and only the sign-in keys, without signing in', async () => {
    const res = await call(null, 'GET', '/api/public/i18n');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(['defaultLocale', 'secondaryLanguage', 'strings']);
    expect(body.secondaryLanguage).toBe('ar');
    // nav.settings and removed.key are translated but are not sign-in keys; French is not the secondary language.
    expect(body.strings).toEqual({ 'login.title': 'تسجيل الدخول', 'login.email': 'البريد الإلكتروني' });
    for (const k of Object.keys(body.strings)) expect(PUBLIC_UI_KEYS).toContain(k);
    expect(PUBLIC_UI_KEYS.every((k) => k in EN_CATALOGUE)).toBe(true);
    // Not a place to ask for other keys.
    expect(Object.keys(await json(await app.request('/api/public/i18n?keys=nav.settings'))).sort()).toEqual(['defaultLocale', 'secondaryLanguage', 'strings']);
    expect((await json(await app.request('/api/public/i18n?keys=nav.settings'))).strings).not.toHaveProperty('nav.settings');
    expect(JSON.stringify(body)).not.toContain(ids.inst!);
  });

  it('does not change what /api/public/branding serves', async () => {
    const body = await json(await call(null, 'GET', '/api/public/branding'));
    expect(Object.keys(body).sort()).toEqual(['accentColor', 'logoUrl', 'name']);
  });
});
