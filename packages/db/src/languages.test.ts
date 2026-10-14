// Languages (migration 0055, TASK-070): the secondary-language rules, the person's interface language, what the worker may write
// into ui_translation (only unreviewed AI rows, never a person's), tenant isolation, and the narrow public sign-in reads.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';
import { resolvePublicLanguages } from './identity.js';

let db: TestDb;
let pool: pg.Pool;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const app = () => ({ userId: ids.user, institutionId: ids.inst });
const worker = () => ({ userId: ids.user, institutionId: ids.inst, role: 'ams_worker' as const });

beforeAll(async () => {
  db = await createTestDb('languages');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('V') returning id`);
  ids.user = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'A', 'a@x.org') returning id`, [ids.inst]);
  ids.otherUser = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'B', 'b@x.org') returning id`, [ids.other]);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('secondary language and default locale', () => {
  it('has no secondary language by default, and the default must be English or the secondary language', async () => {
    expect((await db.su.query(`select secondary_language, default_locale from institution where id = $1`, [ids.inst])).rows[0]).toEqual({ secondary_language: null, default_locale: 'en' });
    await expect(db.su.query(`update institution set default_locale = 'ar' where id = $1`, [ids.inst])).rejects.toThrow(/institution_default_locale_check/);
    await expect(db.su.query(`update institution set secondary_language = 'en' where id = $1`, [ids.inst])).rejects.toThrow(/institution_secondary_language_check/);
    await expect(db.su.query(`update institution set secondary_language = 'Arabic' where id = $1`, [ids.inst])).rejects.toThrow(/institution_secondary_language_check/);
    await db.su.query(`update institution set secondary_language = 'ar', default_locale = 'ar' where id = $1`, [ids.inst]);
  });

  it("a person's language must be English or the secondary language", async () => {
    await db.as(app(), (c) => c.query(`update app_user set ui_locale = 'ar' where id = $1`, [ids.user]));
    await db.as(app(), (c) => c.query(`update app_user set ui_locale = 'en' where id = $1`, [ids.user]));
    await expect(db.as(app(), (c) => c.query(`update app_user set ui_locale = 'fr' where id = $1`, [ids.user]))).rejects.toThrow(/English or the institution/);
    await db.as(app(), (c) => c.query(`update app_user set ui_locale = 'ar' where id = $1`, [ids.user]));
  });

  it("changing the secondary language sends people back to the default and fixes a default that no longer fits; translations are kept", async () => {
    await db.as(app(), (c) => c.query(`insert into ui_translation (institution_id, language, key, source_hash, text, origin) values ($1, 'ar', 'nav.settings', 'h', 'الإعدادات', 'ai')`, [ids.inst]));
    await db.su.query(`update institution set secondary_language = 'fr' where id = $1`, [ids.inst]);
    expect((await db.su.query(`select default_locale from institution where id = $1`, [ids.inst])).rows[0].default_locale).toBe('en');
    expect((await db.su.query(`select ui_locale from app_user where id = $1`, [ids.user])).rows[0].ui_locale).toBeNull();
    expect((await db.su.query(`select count(*)::int as n from ui_translation where language = 'ar'`)).rows[0].n).toBe(1);
    await db.su.query(`update institution set secondary_language = 'ar', default_locale = 'ar' where id = $1`, [ids.inst]);
  });
});

describe('ui_translation', () => {
  it('is isolated per institution and never holds English', async () => {
    expect(await db.as({ userId: ids.otherUser, institutionId: ids.other }, async (c) => (await c.query(`select id from ui_translation`)).rowCount)).toBe(0);
    await expect(db.su.query(`insert into ui_translation (institution_id, language, key, source_hash, text, origin) values ($1, 'en', 'k', 'h', 't', 'ai')`, [ids.inst])).rejects.toThrow(/ui_translation_language_check/);
    await expect(db.su.query(`insert into ui_translation (institution_id, language, key, source_hash, text, origin) values ($1, 'ar', 'nav.settings', 'h', 'dup', 'ai')`, [ids.inst])).rejects.toThrow(/ui_translation_key_idx/);
  });

  it('lets the worker add only unreviewed AI rows, and change the text of an AI row nobody reviewed', async () => {
    await db.as(worker(), (c) => c.query(`insert into ui_translation (institution_id, language, key, source_hash, text, origin) values ($1, 'ar', 'nav.evidence', 'h1', 'الأدلة', 'ai')`, [ids.inst]));
    await expect(db.as(worker(), (c) => c.query(`insert into ui_translation (institution_id, language, key, source_hash, text, origin, reviewed) values ($1, 'ar', 'k1', 'h', 't', 'ai', true)`, [ids.inst]))).rejects.toThrow(/only unreviewed AI/);
    await expect(db.as(worker(), (c) => c.query(`insert into ui_translation (institution_id, language, key, source_hash, text, origin) values ($1, 'ar', 'k2', 'h', 't', 'person')`, [ids.inst]))).rejects.toThrow(/only unreviewed AI/);
    await db.as(worker(), (c) => c.query(`update ui_translation set text = 'الأدلّة', source_hash = 'h2' where key = 'nav.evidence'`));
    // It cannot mark anything reviewed or as a person's (no column grant), and cannot delete.
    await expect(db.as(worker(), (c) => c.query(`update ui_translation set reviewed = true where key = 'nav.evidence'`))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`update ui_translation set origin = 'person' where key = 'nav.evidence'`))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`delete from ui_translation where key = 'nav.evidence'`))).rejects.toThrow(/permission denied/);
  });

  it("never touches a person's row or a reviewed row", async () => {
    await db.as(app(), (c) => c.query(`insert into ui_translation (institution_id, language, key, source_hash, text, origin, reviewed) values ($1, 'ar', 'a.person', 'h', 'mine', 'person', true), ($1, 'ar', 'a.reviewed', 'h', 'ok', 'ai', true)`, [ids.inst]));
    await expect(db.as(worker(), (c) => c.query(`update ui_translation set text = 'machine' where key = 'a.person'`))).rejects.toThrow(/person wrote or reviewed/);
    await expect(db.as(worker(), (c) => c.query(`update ui_translation set text = 'machine' where key = 'a.reviewed'`))).rejects.toThrow(/person wrote or reviewed/);
    expect((await db.su.query(`select text from ui_translation where key = 'a.person'`)).rows[0].text).toBe('mine');
  });

  it('is audited', async () => {
    const n = (await db.su.query(`select count(*)::int as n from audit_event where target_type = 'ui_translation'`)).rows[0].n;
    expect(n).toBeGreaterThan(0);
  });
});

describe('translation_run', () => {
  it('has at most one active run per kind and language, and the worker cannot revive an ended one', async () => {
    const run = await db.as(app(), async (c) => (await c.query(`insert into translation_run (institution_id, kind, language) values ($1, 'ui', 'ar') returning id`, [ids.inst])).rows[0].id as string);
    await expect(db.su.query(`insert into translation_run (institution_id, kind, language) values ($1, 'ui', 'ar')`, [ids.inst])).rejects.toThrow(/translation_run_one_active_idx/);
    await db.as(worker(), (c) => c.query(`update translation_run set status = 'running' where id = $1`, [run]));
    await expect(db.as(worker(), (c) => c.query(`update translation_run set started_by = null where id = $1`, [run]))).rejects.toThrow(/permission denied/);
    await db.as(app(), (c) => c.query(`update translation_run set status = 'stopped' where id = $1`, [run]));
    await expect(db.as(worker(), (c) => c.query(`update translation_run set status = 'running' where id = $1`, [run]))).rejects.toThrow(/has ended/);
    await expect(db.su.query(`update translation_run set kind = 'bogus' where id = $1`, [run])).rejects.toThrow(/translation_run_kind_check/);
  });

  it("accepts the 'translate' job type", async () => {
    await db.su.query(`insert into job (institution_id, type) values ($1, 'translate')`, [ids.inst]);
  });
});

describe('public sign-in language reads', () => {
  // A deployment serves one institution, so these run in a database of their own.
  let pub: TestDb;
  let pubPool: pg.Pool;
  beforeAll(async () => {
    pub = await createTestDb('languages_pub');
    pubPool = new pg.Pool({ connectionString: pub.url });
  }, 60000);
  afterAll(async () => { await pubPool.end(); await pub.close(); });

  it('returns nothing while there is no institution', async () => {
    expect(await resolvePublicLanguages(pubPool, ['login.title'])).toBeNull();
  });

  it('returns the codes and exactly the keys asked for, nothing else', async () => {
    const inst = (await pub.su.query(`insert into institution (name_en, secondary_language, default_locale) values ('U', 'ar', 'ar') returning id`)).rows[0].id as string;
    await pub.su.query(`insert into ui_translation (institution_id, language, key, source_hash, text, origin) values ($1, 'ar', 'login.title', 'h', 'تسجيل الدخول', 'ai'), ($1, 'ar', 'nav.evidence', 'h', 'الأدلة', 'ai'), ($1, 'fr', 'login.title', 'h', 'Connexion', 'ai')`, [inst]);
    const r = await resolvePublicLanguages(pubPool, ['login.title', 'login.email']);
    expect(r).toEqual({ defaultLocale: 'ar', secondaryLanguage: 'ar', strings: { 'login.title': 'تسجيل الدخول' } });
    expect((await resolvePublicLanguages(pubPool, ['login.title']))!.strings).not.toHaveProperty('nav.evidence');
  });

  it('returns nothing when the deployment has more than one institution', async () => {
    await pub.su.query(`insert into institution (name_en) values ('Second')`);
    expect(await resolvePublicLanguages(pubPool, ['login.title'])).toBeNull();
  });
});
