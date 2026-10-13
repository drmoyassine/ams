// The sign-in page's one public read (TASK-069): app_public_branding() is how the API reads the institution before anyone
// is authenticated. It must return only the name, locale (to choose the name), accent colour and logo file, and nothing at
// all unless the deployment has exactly one institution; and without it the application role still sees no institution rows.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';
import { resolvePublicBranding } from './identity.js';

let db: TestDb;
let pool: pg.Pool;

beforeAll(async () => {
  db = await createTestDb('pubbrand');
  pool = new pg.Pool({ connectionString: db.url });
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('public branding', () => {
  it('returns nothing while there is no institution', async () => {
    expect(await resolvePublicBranding(pool)).toBeNull();
  });

  it('returns exactly the display fields of the one institution', async () => {
    await db.su.query(`insert into institution (name_en, name_ar, country, default_locale, accent_color, logo_path, logo_mime, logo_updated_at)
      values ('Gulf University', 'جامعة الخليج', 'Qatar', 'ar', '#1f3b66', 'x/institution/logo-1', 'image/png', now())`);
    const r = await resolvePublicBranding(pool);
    expect(Object.keys(r!).sort()).toEqual(['accentColor', 'defaultLocale', 'logoMime', 'logoPath', 'logoUpdatedAt', 'nameAr', 'nameEn']);
    expect(r).toMatchObject({ nameEn: 'Gulf University', nameAr: 'جامعة الخليج', accentColor: '#1f3b66', logoMime: 'image/png' });
  });

  it('stays closed to the application role: no table access without an identity, only the function', async () => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role ams_app');
      const { rows } = await c.query('select count(*)::int as n from institution'); // RLS: no identity, no rows
      expect(rows[0].n).toBe(0);
      const fn = await c.query('select count(*)::int as n from app_public_branding()');
      expect(fn.rows[0].n).toBe(1);
      await c.query('rollback');
    } finally { c.release(); }
    // not callable by the background role
    const w = await pool.connect();
    try {
      await w.query('begin');
      await w.query('set local role ams_worker');
      await expect(w.query('select * from app_public_branding()')).rejects.toThrow(/permission denied/);
    } finally { await w.query('rollback').catch(() => undefined); w.release(); }
  });

  it('shows nothing once there is more than one institution (never a guess)', async () => {
    await db.su.query(`insert into institution (name_en) values ('Another University')`);
    expect(await resolvePublicBranding(pool)).toBeNull();
  });
});
