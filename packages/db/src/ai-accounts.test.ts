// ai_account (DEC-025): tenant isolation, privileges, constraints, and migration 0045 turning old-style saved settings into accounts.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder, runMigrations } from './migrate.js';
import { createTestDb, type TestDb } from './test-db.js';

describe('ai_account', () => {
  let db: TestDb;
  const ids = {} as Record<string, string>;
  const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
  beforeAll(async () => {
    db = await createTestDb('aiacc');
    ids.a = await one(`insert into institution (name_en) values ('A') returning id`);
    ids.b = await one(`insert into institution (name_en) values ('B') returning id`);
    ids.userA = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'a', 'a@x.org') returning id`, [ids.a]);
  });
  afterAll(() => db.close());

  it('is isolated by RLS, writable by the app, read-only for the worker, and audited', async () => {
    ids.accA = await one(`insert into ai_account (institution_id, name, provider, api_key_enc, api_key_last4) values ($1, 'Work OpenAI', 'openai', 'v1:xxx', 'abcd') returning id`, [ids.a]);
    await db.su.query(`insert into ai_account (institution_id, name, provider) values ($1, 'Theirs', 'google')`, [ids.b]);
    const seen = await db.as({ userId: ids.userA, institutionId: ids.a }, async (c) => (await c.query(`select name from ai_account`)).rows);
    expect(seen).toEqual([{ name: 'Work OpenAI' }]);
    await db.as({ userId: ids.userA, institutionId: ids.a }, async (c) => {
      await c.query(`insert into ai_account (institution_id, name, provider) values ($1, 'Second', 'anthropic')`, [ids.a]);
      await c.query(`update ai_account set name = 'Second one' where name = 'Second'`);
      await c.query(`delete from ai_account where name = 'Second one'`);
    });
    await db.as({ userId: ids.userA, institutionId: ids.a }, async (c) => {
      await expect(c.query(`insert into ai_account (institution_id, name, provider) values ($1, 'Stolen', 'openai')`, [ids.b])).rejects.toThrow(/row-level security/);
    });
    await db.as({ userId: ids.userA, institutionId: ids.a, role: 'ams_worker' }, async (c) => {
      expect((await c.query(`select name from ai_account`)).rowCount).toBe(1);
      await expect(c.query(`update ai_account set name = 'x'`)).rejects.toThrow(/permission denied/);
    });
    await db.as({ userId: ids.userA, institutionId: ids.a, role: 'ams_worker' }, async (c) => {
      await expect(c.query(`delete from ai_account`)).rejects.toThrow(/permission denied/);
    });
    const audit = (await db.su.query(`select action from audit_event where target_type = 'ai_account' and institution_id = $1 order by created_at`, [ids.a])).rows.map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['insert', 'update', 'delete']));
  });

  it('takes the five providers; a Base URL only goes with openai_compatible; names are unique per institution', async () => {
    for (const p of ['anthropic', 'openai', 'google', 'openrouter']) {
      await db.su.query(`insert into ai_account (institution_id, name, provider) values ($1, $2, $3)`, [ids.a, `p-${p}`, p]);
    }
    await db.su.query(`insert into ai_account (institution_id, name, provider, base_url) values ($1, 'compat', 'openai_compatible', 'http://h/v1')`, [ids.a]);
    await expect(db.su.query(`insert into ai_account (institution_id, name, provider) values ($1, 'x', 'cohere')`, [ids.a])).rejects.toThrow(/ai_account_provider_check/);
    await expect(db.su.query(`insert into ai_account (institution_id, name, provider, base_url) values ($1, 'y', 'openrouter', 'http://evil/v1')`, [ids.a])).rejects.toThrow(/ai_account_base_url_check/);
    await expect(db.su.query(`insert into ai_account (institution_id, name, provider) values ($1, 'WORK openai', 'openai')`, [ids.a])).rejects.toThrow(/ai_account_name_idx/);
    await db.su.query(`insert into ai_account (institution_id, name, provider) values ($1, 'Work OpenAI', 'openai')`, [ids.b]); // another institution may reuse a name
  });

  it('assignments point at accounts; an account in use cannot be deleted; the cap unit and page cap are checked', async () => {
    await db.su.query(`insert into ai_setting (institution_id, analysis_account_id, embed_account_id, model) values ($1, $2, $2, 'm')`, [ids.a, ids.accA]);
    await expect(db.su.query(`delete from ai_account where id = $1`, [ids.accA])).rejects.toThrow(/foreign key/);
    expect((await db.su.query(`select cap_unit, ocr_enabled, ocr_max_pages, ocr_language from ai_setting where institution_id = $1`, [ids.a])).rows[0]).toEqual({ cap_unit: 'tokens', ocr_enabled: true, ocr_max_pages: 200, ocr_language: null });
    await expect(db.su.query(`update ai_setting set cap_unit = 'words' where institution_id = $1`, [ids.a])).rejects.toThrow(/ai_setting_cap_unit_check/);
    for (const n of [0, 5001]) await expect(db.su.query(`update ai_setting set ocr_max_pages = $2 where institution_id = $1`, [ids.a, n])).rejects.toThrow(/ai_setting_ocr_max_pages_check/);
    await expect(db.su.query(`update ai_setting set vision_account_id = $2 where institution_id = $1`, [ids.a, crypto.randomUUID()])).rejects.toThrow(/foreign key/);
  });
});

describe('migration 0045: saved settings become accounts', () => {
  const admin = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
  const name = `ams_aimig_${process.pid}`;
  const url = admin.replace(/\/[^/]*$/, `/${name}`);
  let su: pg.Client;
  const inst = {} as Record<string, string>;
  const row = async (k: string) => (await su.query(`select * from ai_setting where institution_id = $1`, [inst[k]])).rows[0];
  const accounts = async (k: string) => (await su.query(`select * from ai_account where institution_id = $1 order by name`, [inst[k]])).rows;

  beforeAll(async () => {
    const a = new pg.Client({ connectionString: admin });
    await a.connect();
    await a.query(`drop database if exists ${name}`);
    await a.query(`create database ${name}`);
    await a.end();
    // Everything up to 0044: the database as it was before this change.
    const old = mkdtempSync(join(tmpdir(), 'ams-mig-'));
    cpSync(migrationsFolder, old, { recursive: true });
    const journalPath = join(old, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((e) => e.idx <= 44);
    writeFileSync(journalPath, JSON.stringify(journal));
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    await migrate(drizzle(pool), { migrationsFolder: old });
    await pool.end();
    su = new pg.Client({ connectionString: url });
    await su.connect();
    expect((await su.query(`select to_regclass('ai_account') t`)).rows[0].t).toBeNull();

    for (const k of ['anthropic', 'compat', 'limits', 'both', 'embedOnly', 'none']) {
      inst[k] = (await su.query(`insert into institution (name_en) values ($1) returning id`, [k])).rows[0].id;
    }
    const ins = (k: string, cols: string, vals: unknown[]) => su.query(`insert into ai_setting (institution_id, ${cols}) values ($1, ${vals.map((_, i) => `$${i + 2}`).join(', ')})`, [inst[k], ...vals]);
    // Anthropic with a key, a model, a token limit, and an embeddings endpoint with its own key.
    await ins('anthropic', 'provider, model, api_key_enc, api_key_last4, max_tokens_per_run, enabled, embed_enabled, embed_base_url, embed_model, embed_api_key_enc, embed_api_key_last4, embed_dimension, max_recovery_rounds',
      ['anthropic', 'm-anthropic', 'v1:CIPHER-ANTHROPIC', 'abcd', 750000, true, true, 'http://embed.local:8080/v1', 'multilingual', 'v1:CIPHER-EMBED', '9999', 32, 4]);
    // OpenAI-compatible with a Base URL and no key; a USD limit with both prices.
    await ins('compat', 'provider, base_url, model, max_cost_usd_per_run, input_usd_per_mtok, output_usd_per_mtok, enabled', ['openai_compatible', 'http://host:11434/v1', 'local', 5, 3, 15, true]);
    // Only limits: no connection of its own, so the environment keeps being used.
    await ins('limits', 'max_tokens_per_run', [1000]);
    // Both limits: the token cap is kept, the cost limit is cleared (the two prices stay).
    await ins('both', 'provider, model, api_key_enc, api_key_last4, max_tokens_per_run, max_cost_usd_per_run, input_usd_per_mtok, output_usd_per_mtok', ['google', 'gem', 'v1:CIPHER-GOOGLE', 'wxyz', 2000, 9, 1, 2]);
    // Embeddings switched on without an endpoint cannot stay on.
    await ins('embedOnly', 'embed_enabled, embed_model', [true, 'orphan']);
    await runMigrations(url);
    // Migration 0070 moved everything to the ams schema; a connection opened before it still looks in public.
    await su.end();
    su = new pg.Client({ connectionString: url });
    await su.connect();
  }, 60000);

  afterAll(async () => {
    await su.end();
    const b = new pg.Client({ connectionString: admin });
    await b.connect();
    await b.query(`drop database if exists ${name} with (force)`);
    await b.end();
  });

  it('turns the connection into an account, keeping the ciphertext as it was, and points analysis at it', async () => {
    const analysis = (await accounts('anthropic')).find((x) => x.provider === 'anthropic')!;
    expect(analysis).toMatchObject({ name: 'Anthropic', provider: 'anthropic', base_url: null, api_key_enc: 'v1:CIPHER-ANTHROPIC', api_key_last4: 'abcd' });
    const s = await row('anthropic');
    expect(s).toMatchObject({ analysis_account_id: analysis.id, model: 'm-anthropic', enabled: true, max_recovery_rounds: 4, cap_unit: 'tokens', max_tokens_per_run: 750000 });
  });

  it('turns the embeddings endpoint into its own OpenAI-compatible account with its own key, and keeps model and size', async () => {
    const all = await accounts('anthropic');
    const emb = all.find((x) => x.provider === 'openai_compatible')!;
    expect(emb).toMatchObject({ name: 'Embeddings (OpenAI-compatible)', base_url: 'http://embed.local:8080/v1', api_key_enc: 'v1:CIPHER-EMBED', api_key_last4: '9999' });
    expect(await row('anthropic')).toMatchObject({ embed_account_id: emb.id, embed_enabled: true, embed_model: 'multilingual', embed_dimension: 32 });
  });

  it('clears the legacy keys so no key is kept twice, but leaves the legacy columns in place', async () => {
    const s = await row('anthropic');
    expect(s).toMatchObject({ api_key_enc: null, api_key_last4: null, embed_api_key_enc: null, embed_api_key_last4: null });
    expect(s).toHaveProperty('provider');
    expect(s).toHaveProperty('embed_base_url');
  });

  it('keeps an OpenAI-compatible Base URL, a keyless account, and a USD limit with its prices', async () => {
    const [acc] = await accounts('compat');
    expect(acc).toMatchObject({ name: 'OpenAI-compatible', provider: 'openai_compatible', base_url: 'http://host:11434/v1', api_key_enc: null });
    expect(await row('compat')).toMatchObject({ analysis_account_id: acc!.id, cap_unit: 'usd', max_cost_usd_per_run: '5.0000', input_usd_per_mtok: '3.0000', output_usd_per_mtok: '15.0000', max_tokens_per_run: null });
  });

  it('leaves a row with only limits on the environment (no account), and still marks its cap', async () => {
    expect(await accounts('limits')).toEqual([]);
    expect(await row('limits')).toMatchObject({ analysis_account_id: null, embed_account_id: null, cap_unit: 'tokens', max_tokens_per_run: 1000 });
  });

  it('keeps the token cap when both limits were set, and clears the cost limit', async () => {
    const [acc] = await accounts('both');
    expect(acc).toMatchObject({ name: 'Google (Gemini)', provider: 'google', api_key_enc: 'v1:CIPHER-GOOGLE' });
    expect(await row('both')).toMatchObject({ cap_unit: 'tokens', max_tokens_per_run: 2000, max_cost_usd_per_run: null, input_usd_per_mtok: '1.0000' });
  });

  it('switches off embeddings that had no endpoint, and gives every row the new defaults', async () => {
    expect(await row('embedOnly')).toMatchObject({ embed_enabled: false, embed_account_id: null, ocr_enabled: true, ocr_max_pages: 200, ocr_language: null, vision_account_id: null });
    expect(await accounts('embedOnly')).toEqual([]);
  });

  it('records the move in the audit trail with ciphertext only', async () => {
    const audit = (await su.query(`select after::text a from audit_event where target_type = 'ai_account'`)).rows.map((r) => r.a as string);
    expect(audit.length).toBeGreaterThanOrEqual(4);
    expect(audit.join(' ')).toContain('CIPHER-ANTHROPIC');
    expect(audit.join(' ')).not.toMatch(/sk-/);
  });
});
