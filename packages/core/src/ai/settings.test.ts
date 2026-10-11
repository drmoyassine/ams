// Settings -> AI (DEC-025): accounts (encrypted keys, never returned), assignments (analysis / reading / embeddings), the cap,
// the worker's view of them, the model list and the tests. The model is always a fake and fetch is stubbed: nothing reaches the network.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { ConflictError, ForbiddenError, ValidationError, type Ctx } from '../ctx.js';
import {
  AiBudget, AiDisabledError, AiScopeError, aiExtract, aiOcr, createAiRuntime, createFakeAiModel, createFakeEmbedder, embed, runInAiScope, setAiModelForTests, setEmbedderForTests,
} from './index.js';
import { cosine, rankBySimilarity, requirementEmbeddingItems, textHash, upsertEmbeddings } from './embeddings.js';
import { clearModelCache } from './models.js';
import { aiReadiness, getAiSettings, loadAiRuntime, testAiConnection, updateAiSettings } from './settings.js';
import { createAiAccount, deleteAiAccount, listAccountModels, listAiAccounts, testAiAccount, updateAiAccount } from './accounts.js';

const SECRET = 'k'.repeat(40);
const KEY = 'sk-test-0123456789abcd';
let db: TestDb;
let pool: pg.Pool;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const as = <T>(who: string, fn: (ctx: Ctx) => Promise<T>, role: 'ams_app' | 'ams_worker' = 'ams_app') => {
  const caller = { userId: ids[who]!, institutionId: ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const, role };
  return withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined }));
};
const asWorker = <T>(fn: (ctx: Ctx) => Promise<T>) => as('admin', fn, 'ams_worker');
const inJob = <T>(fn: () => Promise<T>) => runInAiScope('job', fn);
const reset = async () => { await db.su.query(`delete from ai_setting`); await db.su.query(`delete from ai_account`); clearModelCache(); };

/** fetch replaced by canned provider answers; `seen` lists the addresses asked. */
let seen: string[];
let replies: Record<string, { status?: number; body: unknown }>;
const realFetch = globalThis.fetch;
const stubFetch = () => {
  seen = []; replies = {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    const hit = Object.entries(replies).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(hit[1].body), { status: hit[1].status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
};

const env = (vars: Record<string, string | undefined>) => {
  const keys = ['AI_PROVIDER', 'AI_MODEL', 'AI_BASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'OPENAI_COMPATIBLE_API_KEY', 'OPENROUTER_API_KEY'];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  return () => { for (const k of keys) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } };
};

beforeAll(async () => {
  process.env.APP_SECRET = SECRET;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('aiset');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('Other University') returning id`);
  for (const n of ['admin', 'lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  const grant = (u: string, role: string) => db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u], role]);
  await grant('admin', 'admin'); await grant('lead', 'lead'); await grant('viewer', 'viewer');
  ids.acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Some Commission', 'SC', 'institutional') returning id`, [ids.inst]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Handbook', 'institution') returning id`, [ids.inst, ids.acc]);
  ids.ver = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2023') returning id`, [ids.inst, ids.fw]);
  const req = (code: string, title: string, text: string | null, parent: string | null) =>
    one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, official_text, parent_id) values ($1, $2, $3, 'Level', $4, $5, $6) returning id`, [ids.inst, ids.ver, code, title, text, parent]);
  ids.std = await req('1', 'Institutional purposes', null, null);
  ids.r1 = await req('1.1', 'Mission', 'The institution states its mission publicly.', ids.std!);
  ids.r2 = await req('1.2', 'Governance', 'Governing board oversight of finances.', ids.std!);
  ids.r3 = await req('1.3', 'Library', 'Library resources support learning and research.', ids.std!);
}, 30000);
afterAll(async () => { delete process.env.APP_SECRET; globalThis.fetch = realFetch; await pool.end(); await db.close(); });
beforeEach(() => { setAiModelForTests(null); stubFetch(); });
afterEach(() => { setAiModelForTests(null); setEmbedderForTests(null); globalThis.fetch = realFetch; });

describe('AI accounts', () => {
  beforeAll(reset);

  it('are for the admin only', async () => {
    await expect(as('lead', (c) => listAiAccounts(c))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(as('viewer', (c) => createAiAccount(c, { provider: 'openai', apiKey: KEY }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(as('lead', (c) => deleteAiAccount(c, crypto.randomUUID()))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(as('lead', (c) => getAiSettings(c))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(as('lead', (c) => testAiConnection(c))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(as('lead', (c) => listAccountModels(c, crypto.randomUUID()))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await as('admin', (c) => listAiAccounts(c))).toEqual([]);
  });

  it('store the key encrypted and return only that it is set and its last 4 characters', async () => {
    const a = await as('admin', (c) => createAiAccount(c, { name: 'Work OpenAI', provider: 'openai', apiKey: KEY }));
    expect(a).toMatchObject({ name: 'Work OpenAI', provider: 'openai', baseUrl: null, keyConfigured: true, keyLast4: 'abcd', keySource: 'saved', usedFor: [] });
    expect(JSON.stringify(a)).not.toContain(KEY);
    const raw = (await db.su.query(`select api_key_enc, api_key_last4 from ai_account`)).rows[0];
    expect(raw.api_key_enc).toMatch(/^v1:/);
    expect(raw.api_key_enc).not.toContain(KEY);
    const audit = (await db.su.query(`select before::text b, after::text a from audit_event where target_type = 'ai_account'`)).rows;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some((r) => `${r.a}${r.b}`.includes(KEY))).toBe(false);
    expect(JSON.stringify(await as('admin', (c) => listAiAccounts(c)))).not.toContain(KEY);
  });

  it('default their label to the provider, keep names unique, and need a Base URL only for OpenAI-compatible', async () => {
    const g = await as('admin', (c) => createAiAccount(c, { provider: 'google', apiKey: 'gkey-1234567890' }));
    expect(g.name).toBe('Google');
    expect((await as('admin', (c) => createAiAccount(c, { provider: 'google', apiKey: 'gkey-1234567890' }))).name).toBe('Google 2');
    await expect(as('admin', (c) => createAiAccount(c, { name: 'work openai', provider: 'openai' }))).rejects.toBeInstanceOf(ValidationError);
    await expect(as('admin', (c) => createAiAccount(c, { provider: 'openai_compatible' }))).rejects.toThrow(/Base URL/);
    await expect(as('admin', (c) => createAiAccount(c, { provider: 'openai_compatible', baseUrl: 'http://u:p@host/v1' }))).rejects.toThrow(/user name or password/);
    await expect(as('admin', (c) => createAiAccount(c, { provider: 'openai', baseUrl: 'http://host/v1' }))).rejects.toThrow(/only for the OpenAI-compatible/);
    const local = await as('admin', (c) => createAiAccount(c, { name: 'Local Ollama', provider: 'openai_compatible', baseUrl: 'http://host:11434/v1' }));
    expect(local).toMatchObject({ baseUrl: 'http://host:11434/v1', keyConfigured: false, keySource: 'none' });
    const or = await as('admin', (c) => createAiAccount(c, { provider: 'openrouter', apiKey: 'or-key-12345678' }));
    expect(or).toMatchObject({ name: 'OpenRouter', provider: 'openrouter', baseUrl: null });
  });

  it('keep the key when it is not in the update, replace it, or remove it with null', async () => {
    const a = (await as('admin', (c) => listAiAccounts(c))).find((x) => x.name === 'Work OpenAI')!;
    expect(await as('admin', (c) => updateAiAccount(c, a.id, { name: 'Work OpenAI (main)' }))).toMatchObject({ name: 'Work OpenAI (main)', keyLast4: 'abcd' });
    expect(await as('admin', (c) => updateAiAccount(c, a.id, { apiKey: 'another-key-wxyz' }))).toMatchObject({ keyLast4: 'wxyz' });
    expect(await as('admin', (c) => updateAiAccount(c, a.id, { apiKey: null }))).toMatchObject({ keyConfigured: false, keyLast4: null, keySource: 'none' });
    await as('admin', (c) => updateAiAccount(c, a.id, { apiKey: KEY, name: 'Work OpenAI' }));
  });

  it('remove their key when the provider changes, unless a new key comes in the same save', async () => {
    const a = await as('admin', (c) => createAiAccount(c, { name: 'Switcher', provider: 'anthropic', apiKey: KEY }));
    const moved = await as('admin', (c) => updateAiAccount(c, a.id, { provider: 'openai' }));
    expect(moved).toMatchObject({ provider: 'openai', keyConfigured: false, keyLast4: null });
    expect((await db.su.query(`select api_key_enc from ai_account where id = $1`, [a.id])).rows[0].api_key_enc).toBeNull();
    const again = await as('admin', (c) => updateAiAccount(c, a.id, { provider: 'google', apiKey: 'new-google-key-5678' }));
    expect(again).toMatchObject({ provider: 'google', keyConfigured: true, keyLast4: '5678' });
    // Moving to OpenAI-compatible needs its Base URL; moving away drops it.
    await expect(as('admin', (c) => updateAiAccount(c, a.id, { provider: 'openai_compatible' }))).rejects.toThrow(/Base URL/);
    const compat = await as('admin', (c) => updateAiAccount(c, a.id, { provider: 'openai_compatible', baseUrl: 'http://host:1/v1' }));
    expect(compat.baseUrl).toBe('http://host:1/v1');
    expect((await as('admin', (c) => updateAiAccount(c, a.id, { provider: 'openrouter', apiKey: 'or-key-87654321' }))).baseUrl).toBeNull();
    await as('admin', (c) => deleteAiAccount(c, a.id));
  });

  it('are per institution', async () => {
    await db.su.query(`insert into ai_account (institution_id, name, provider) values ($1, 'Theirs', 'openai')`, [ids.other]);
    expect((await as('admin', (c) => listAiAccounts(c))).map((x) => x.name)).not.toContain('Theirs');
    const theirs = (await db.su.query(`select id from ai_account where name = 'Theirs'`)).rows[0].id as string;
    await expect(as('admin', (c) => updateAiAccount(c, theirs, { name: 'Mine now' }))).rejects.toThrow(/does not exist/);
    await expect(as('admin', (c) => updateAiAccount(c, crypto.randomUUID(), { name: 'Nope' }))).rejects.toThrow(/does not exist/);
    await db.su.query(`delete from ai_account where name = 'Theirs'`);
  });

  it('cannot be deleted while a role uses them, and the message says which', async () => {
    const accounts = await as('admin', (c) => listAiAccounts(c));
    const openai = accounts.find((x) => x.name === 'Work OpenAI')!;
    await as('admin', (c) => updateAiSettings(c, { analysis: { accountId: openai.id, model: 'm-1' } }));
    expect((await as('admin', (c) => listAiAccounts(c))).find((x) => x.id === openai.id)!.usedFor).toEqual(['analysis']);
    const err = await as('admin', (c) => deleteAiAccount(c, openai.id)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toMatch(/"Work OpenAI" is used for Analysis\. Choose another account there/);
    await expect(as('admin', (c) => updateAiAccount(c, openai.id, { provider: 'google' }))).rejects.toBeInstanceOf(ConflictError);
    await as('admin', (c) => updateAiSettings(c, { analysis: { accountId: null, model: null } }));
    await as('admin', (c) => deleteAiAccount(c, accounts.find((x) => x.name === 'Google 2')!.id));
    expect((await as('admin', (c) => listAiAccounts(c))).map((x) => x.name)).not.toContain('Google 2');
  });
});

describe('assignments', () => {
  let openai: string; let google: string; let local: string; let anthropic: string;
  beforeAll(async () => {
    await reset();
    openai = (await as('admin', (c) => createAiAccount(c, { name: 'Work OpenAI', provider: 'openai', apiKey: KEY }))).id;
    google = (await as('admin', (c) => createAiAccount(c, { name: 'Gemini', provider: 'google', apiKey: 'gkey-abcdefgh-9999' }))).id;
    local = (await as('admin', (c) => createAiAccount(c, { name: 'Local', provider: 'openai_compatible', baseUrl: 'http://host:11434/v1' }))).id;
    anthropic = (await as('admin', (c) => createAiAccount(c, { name: 'Claude', provider: 'anthropic', apiKey: 'ant-key-abcdefgh-1111' }))).id;
  });

  it('switch the analysis model between a saved OpenAI and a Gemini account with one change', async () => {
    const dto = await as('admin', (c) => updateAiSettings(c, { enabled: true, analysis: { accountId: openai, model: 'gpt-x' } }));
    expect(dto).toMatchObject({ enabled: true, analysis: { accountId: openai, model: 'gpt-x' } });
    expect((await inJob(() => asWorker((c) => loadAiRuntime(c)))).config).toEqual({ provider: 'openai', model: 'gpt-x', apiKey: KEY, baseUrl: null });
    // A new account without a new model clears the model (it belonged to the other provider).
    await expect(as('admin', (c) => updateAiSettings(c, { analysis: { accountId: google } }))).rejects.toThrow(/choose a model/); // AI is on
    expect((await as('admin', (c) => updateAiSettings(c, { enabled: false, analysis: { accountId: google } }))).analysis).toEqual({ accountId: google, model: null });
    await expect(as('admin', (c) => updateAiSettings(c, { enabled: true }))).rejects.toThrow(/model/);
    await as('admin', (c) => updateAiSettings(c, { enabled: true, analysis: { accountId: google, model: 'gem-1' } }));
    expect((await inJob(() => asWorker((c) => loadAiRuntime(c)))).config).toEqual({ provider: 'google', model: 'gem-1', apiKey: 'gkey-abcdefgh-9999', baseUrl: null });
  });

  it('refuse an account that does not exist, and AI on without a key', async () => {
    await expect(as('admin', (c) => updateAiSettings(c, { analysis: { accountId: crypto.randomUUID(), model: 'm' } }))).rejects.toThrow(/does not exist/);
    const bare = (await as('admin', (c) => createAiAccount(c, { name: 'Bare', provider: 'openai' }))).id;
    await as('admin', (c) => updateAiSettings(c, { enabled: false, analysis: { accountId: bare, model: 'm' } }));
    await expect(as('admin', (c) => updateAiSettings(c, { enabled: true }))).rejects.toThrow(/API key/);
    await as('admin', (c) => updateAiSettings(c, { analysis: { accountId: google, model: 'gem-1' }, enabled: true }));
    await as('admin', (c) => deleteAiAccount(c, bare));
  });

  it('reading defaults to the analysis model; a different account and model can be assigned, with the OCR options', async () => {
    let rt = await inJob(() => asWorker((c) => loadAiRuntime(c)));
    expect(rt.vision).toBeUndefined();
    expect(rt.ocr).toEqual({ enabled: true, maxPages: 200, language: null });
    await expect(as('admin', (c) => updateAiSettings(c, { reading: { accountId: openai } }))).rejects.toThrow(/choose a model for reading/);
    const dto = await as('admin', (c) => updateAiSettings(c, { reading: { accountId: openai, model: 'vision-1', ocrEnabled: false, maxPages: 50, language: 'ar' } }));
    expect(dto.reading).toEqual({ accountId: openai, model: 'vision-1', ocrEnabled: false, maxPages: 50, language: 'ar' });
    rt = await inJob(() => asWorker((c) => loadAiRuntime(c)));
    expect(rt.config.provider).toBe('google');
    expect(rt.vision).toEqual({ provider: 'openai', model: 'vision-1', apiKey: KEY, baseUrl: null });
    expect(rt.ocr).toEqual({ enabled: false, maxPages: 50, language: 'ar' });
    // aiOcr uses the reading connection, the budget and the call log of the run.
    const seenConfigs: { provider: string; model: string }[] = [];
    setAiModelForTests((cfg) => { seenConfigs.push(cfg); return createFakeAiModel(['page text']).model; });
    const { text, usage } = await inJob(() => aiOcr({ image: new Uint8Array([1, 2, 3]), lang: 'en', runtime: rt }));
    expect(text).toBe('page text');
    expect(seenConfigs[0]).toMatchObject({ provider: 'openai', model: 'vision-1' });
    expect(usage).toMatchObject({ provider: 'openai', model: 'vision-1' });
    expect(rt.calls).toHaveLength(1);
    // Analysis still uses its own.
    await inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema: z.object({ ok: z.boolean() }), runtime: rt }).catch(() => undefined));
    expect(seenConfigs.at(-1)).toMatchObject({ provider: 'google', model: 'gem-1' });
    // Back to "same as analysis".
    await as('admin', (c) => updateAiSettings(c, { reading: { accountId: null, model: null, ocrEnabled: true, maxPages: 200, language: 'auto' } }));
    rt = await inJob(() => asWorker((c) => loadAiRuntime(c)));
    expect(rt.vision).toBeUndefined();
    expect(rt.ocr).toEqual({ enabled: true, maxPages: 200, language: null });
  });

  it('a reading account with no usable key does not break analysis: the runtime says why reading cannot run', async () => {
    const bare = (await as('admin', (c) => createAiAccount(c, { name: 'NoKey', provider: 'anthropic' }))).id;
    await as('admin', (c) => updateAiSettings(c, { reading: { accountId: bare, model: 'v' } }));
    const rt = await inJob(() => asWorker((c) => loadAiRuntime(c)));
    expect(rt.config.provider).toBe('google');
    expect(rt.visionError).toMatch(/API key/);
    expect(rt.vision).toBeUndefined();
    await as('admin', (c) => updateAiSettings(c, { reading: { accountId: null, model: null } }));
    await as('admin', (c) => deleteAiAccount(c, bare));
  });

  it('embeddings: not for Anthropic; the size is found by a probe, not typed; one OpenAI account serves analysis and embeddings', async () => {
    const embedder = createFakeEmbedder();
    setEmbedderForTests(embedder);
    await expect(as('admin', (c) => updateAiSettings(c, { embeddings: { enabled: true, accountId: anthropic, model: 'm' } }))).rejects.toThrow(/no embedding models/);
    await expect(as('admin', (c) => updateAiSettings(c, { embeddings: { enabled: true } }))).rejects.toThrow(/account and an embedding model/);
    // The same OpenAI account that does analysis also does embeddings: no second key.
    await as('admin', (c) => updateAiSettings(c, { analysis: { accountId: openai, model: 'gpt-x' } }));
    const dto = await as('admin', (c) => updateAiSettings(c, { embeddings: { enabled: true, accountId: openai, model: 'emb-1' } }));
    expect(dto.embeddings).toEqual({ enabled: true, accountId: openai, model: 'emb-1', dimension: 32 });
    expect(embedder.calls).toHaveLength(1); // the probe
    const rt = await inJob(() => asWorker((c) => loadAiRuntime(c)));
    expect(rt.embedding).toEqual({ provider: 'openai', baseUrl: null, model: 'emb-1', apiKey: KEY, dimension: 32 });
    expect(rt.config.apiKey).toBe(KEY);
    expect((await db.su.query(`select count(distinct analysis_account_id)::int a, count(distinct embed_account_id)::int e from ai_setting`)).rows[0]).toEqual({ a: 1, e: 1 });
    // Saving again with the same model does not probe again; another model does, and the size follows it.
    await as('admin', (c) => updateAiSettings(c, { embeddings: { enabled: true, accountId: openai, model: 'emb-1' } }));
    expect(embedder.calls).toHaveLength(1);
    setEmbedderForTests(() => ({ vectors: [new Array<number>(64).fill(1)] }));
    expect((await as('admin', (c) => updateAiSettings(c, { embeddings: { model: 'emb-2' } }))).embeddings).toMatchObject({ model: 'emb-2', dimension: 64 });
    // A model that does not answer is not saved.
    setEmbedderForTests(() => { throw new Error('404 no such model sk-hidden'); });
    await expect(as('admin', (c) => updateAiSettings(c, { embeddings: { model: 'emb-3' } }))).rejects.toThrow(/did not answer.*no such model/);
    expect((await as('admin', (c) => getAiSettings(c))).embeddings.model).toBe('emb-2');
    // Google and OpenAI-compatible accounts are fine too.
    setEmbedderForTests(createFakeEmbedder());
    expect((await as('admin', (c) => updateAiSettings(c, { embeddings: { accountId: google, model: 'g-emb' } }))).embeddings).toMatchObject({ dimension: 32 });
    await as('admin', (c) => updateAiSettings(c, { embeddings: { accountId: local, model: 'l-emb' } }));
    const viaLocal = await inJob(() => asWorker((c) => loadAiRuntime(c)));
    expect(viaLocal.embedding).toMatchObject({ provider: 'openai_compatible', baseUrl: 'http://host:11434/v1', model: 'l-emb' });
  });

  it('switching embeddings off drops them from the run, and an account without a key cannot be switched on', async () => {
    await as('admin', (c) => updateAiSettings(c, { embeddings: { enabled: false } }));
    expect((await inJob(() => asWorker((c) => loadAiRuntime(c)))).embedding).toBeUndefined();
    const bare = (await as('admin', (c) => createAiAccount(c, { name: 'Bare2', provider: 'openai' }))).id;
    await expect(as('admin', (c) => updateAiSettings(c, { embeddings: { enabled: true, accountId: bare, model: 'e' } }))).rejects.toThrow(/API key/);
    await as('admin', (c) => deleteAiAccount(c, bare));
  });
});

describe('the cap: tokens always, USD only when the price is known', () => {
  let openai: string; let router: string;
  beforeAll(async () => {
    await reset();
    openai = (await as('admin', (c) => createAiAccount(c, { name: 'Work OpenAI', provider: 'openai', apiKey: KEY }))).id;
    router = (await as('admin', (c) => createAiAccount(c, { name: 'Router', provider: 'openrouter', apiKey: 'or-key-12345678' }))).id;
  });

  it('a tokens cap becomes the run budget, and the run stops with BudgetExceeded', async () => {
    await as('admin', (c) => updateAiSettings(c, { enabled: true, analysis: { accountId: openai, model: 'gpt-x' }, cap: { unit: 'tokens', tokens: 1000 } }));
    expect((await as('admin', (c) => getAiSettings(c))).cap).toEqual({ unit: 'tokens', tokens: 1000, usd: null, usdAvailable: false });
    const rt = await inJob(() => asWorker((c) => loadAiRuntime(c)));
    expect(rt.budget.limits).toMatchObject({ maxTokens: 1000, maxCostUsd: null });
    setAiModelForTests(createFakeAiModel([{ ok: true }], { inputTokens: 600, outputTokens: 500 }).model);
    const schema = z.object({ ok: z.boolean() });
    await inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime: rt }));
    await expect(inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime: rt }))).rejects.toMatchObject({ name: 'BudgetExceeded', limit: 'tokens' });
  });

  it('USD is refused when the provider does not list the model\'s price (nobody types prices)', async () => {
    await expect(as('admin', (c) => updateAiSettings(c, { cap: { unit: 'usd', usd: 5 } }))).rejects.toThrow(/price/);
    expect((await as('admin', (c) => getAiSettings(c))).cap.unit).toBe('tokens');
    // The settings DTO has no price fields at all.
    expect(JSON.stringify(await as('admin', (c) => getAiSettings(c)))).not.toMatch(/UsdPerMTok|price/i);
  });

  it('USD works on OpenRouter, where the model list gives the price; the cost is counted and the run stops at the cap', async () => {
    replies['https://openrouter.ai/api/v1/models'] = { body: { data: [{ id: 'vendor/chat', pricing: { prompt: '0.000003', completion: '0.000015' } }, { id: 'vendor/unpriced' }] } };
    replies['https://openrouter.ai/api/v1/embeddings/models'] = { body: { data: [] } };
    const dto = await as('admin', (c) => updateAiSettings(c, { analysis: { accountId: router, model: 'vendor/chat' }, cap: { unit: 'usd', usd: 0.01, tokens: null } }));
    expect(dto.cap).toEqual({ unit: 'usd', tokens: null, usd: 0.01, usdAvailable: true });
    const rt = await inJob(() => asWorker((c) => loadAiRuntime(c)));
    expect(rt.config).toMatchObject({ provider: 'openrouter', model: 'vendor/chat', apiKey: 'or-key-12345678' });
    expect(rt.budget.limits).toEqual({ maxTokens: null, maxCostUsd: 0.01, inputUsdPerMTok: 3, outputUsdPerMTok: 15 });
    setAiModelForTests(createFakeAiModel([{ ok: true }], { inputTokens: 1000, outputTokens: 500 }).model); // 0.003 + 0.0075 = 0.0105
    const schema = z.object({ ok: z.boolean() });
    await inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime: rt }));
    expect(rt.budget.costUsd).toBeCloseTo(0.0105);
    await expect(inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime: rt }))).rejects.toMatchObject({ name: 'BudgetExceeded', limit: 'cost' });
  });

  it('choosing a model without a listed price takes USD away again', async () => {
    replies['https://openrouter.ai/api/v1/models'] = { body: { data: [{ id: 'vendor/chat', pricing: { prompt: '0.000003', completion: '0.000015' } }, { id: 'vendor/unpriced' }] } };
    await expect(as('admin', (c) => updateAiSettings(c, { analysis: { model: 'vendor/unpriced' } }))).rejects.toThrow(/price/);
    const dto = await as('admin', (c) => updateAiSettings(c, { analysis: { model: 'vendor/unpriced' }, cap: { unit: 'tokens', tokens: 2_000_000 } }));
    expect(dto.cap).toEqual({ unit: 'tokens', tokens: 2_000_000, usd: 0.01, usdAvailable: false });
  });

  it('a USD cap whose price is gone is refused at run time rather than silently ignored', async () => {
    await db.su.query(`update ai_setting set cap_unit = 'usd', input_usd_per_mtok = null, output_usd_per_mtok = null`);
    await expect(inJob(() => asWorker((c) => loadAiRuntime(c)))).rejects.toThrow(/USD cap needs the model/);
    expect(await as('admin', (c) => aiReadiness(c))).toMatchObject({ ok: false });
    await as('admin', (c) => updateAiSettings(c, { cap: { unit: 'tokens' } }));
  });
});

describe('the worker opens the connection', () => {
  beforeAll(async () => {
    await reset();
    const a = await as('admin', (c) => createAiAccount(c, { name: 'Work OpenAI', provider: 'openai', apiKey: KEY }));
    await as('admin', (c) => updateAiSettings(c, { enabled: true, analysis: { accountId: a.id, model: 'gpt-x' } }));
  });

  it('only inside a job, and refuses when AI is switched off', async () => {
    await expect(asWorker((c) => loadAiRuntime(c))).rejects.toBeInstanceOf(AiScopeError);
    await as('admin', (c) => updateAiSettings(c, { enabled: false }));
    await expect(inJob(() => asWorker((c) => loadAiRuntime(c)))).rejects.toBeInstanceOf(AiDisabledError);
    expect(await inJob(() => asWorker((c) => loadAiRuntime(c, { requireEnabled: false })))).toMatchObject({ config: { provider: 'openai' } });
    expect(await as('admin', (c) => aiReadiness(c))).toMatchObject({ ok: false });
    await as('admin', (c) => updateAiSettings(c, { enabled: true }));
    expect(await as('admin', (c) => aiReadiness(c))).toEqual({ ok: true });
    await expect(as('admin', (c) => loadAiRuntime(c, { requireEnabled: false }))).rejects.toBeInstanceOf(AiScopeError);
  });

  it('the worker role can read accounts but never change them', async () => {
    await db.as({ userId: ids.admin, institutionId: ids.inst, role: 'ams_worker' }, async (c) => {
      expect((await c.query(`select name from ai_account`)).rowCount).toBe(1);
      await expect(c.query(`update ai_account set name = 'x'`)).rejects.toThrow(/permission denied/);
    });
  });
});

describe('Test', () => {
  let openai: string; let google: string;
  beforeAll(async () => {
    await reset();
    openai = (await as('admin', (c) => createAiAccount(c, { name: 'Work OpenAI', provider: 'openai', apiKey: KEY }))).id;
    google = (await as('admin', (c) => createAiAccount(c, { name: 'Gemini', provider: 'google', apiKey: 'gkey-abcdefgh-9999' }))).id;
    await as('admin', (c) => updateAiSettings(c, { enabled: false, analysis: { accountId: openai, model: 'gpt-x' } }));
  });

  it('analysis: one tiny call through the saved account, even when AI is off; failures hide the key', async () => {
    const fake = createFakeAiModel([{ ok: true }]);
    setAiModelForTests(fake.model);
    expect(await as('admin', (c) => testAiConnection(c))).toMatchObject({ ok: true, role: 'analysis', model: 'gpt-x', error: null, dimension: null });
    expect(fake.calls).toHaveLength(1);
    setAiModelForTests(createFakeAiModel([new Error(`401 bad key ${KEY}`)]).model);
    const r = await as('admin', (c) => testAiConnection(c));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('bad key');
    expect(r.error).not.toContain(KEY);
  });

  it('reading: sends a fixed picture to the reading model', async () => {
    const seenConfigs: { provider: string; model: string }[] = [];
    const fake = createFakeAiModel(['']);
    setAiModelForTests((cfg) => { seenConfigs.push(cfg); return fake.model; });
    await as('admin', (c) => updateAiSettings(c, { reading: { accountId: google, model: 'gem-vision' } }));
    expect(await as('admin', (c) => testAiConnection(c, 'reading'))).toMatchObject({ ok: true, role: 'reading', model: 'gem-vision' });
    expect(seenConfigs[0]).toMatchObject({ provider: 'google', model: 'gem-vision' });
    expect(JSON.stringify(fake.calls[0])).toContain('image/png');
    setAiModelForTests(createFakeAiModel([new Error('400 this model does not accept image input')]).model);
    expect(await as('admin', (c) => testAiConnection(c, 'reading'))).toMatchObject({ ok: false, error: expect.stringContaining('image input') });
  });

  it('embeddings: finds and stores the vector size', async () => {
    expect(await as('admin', (c) => testAiConnection(c, 'embeddings'))).toMatchObject({ ok: false, error: expect.stringContaining('Choose an embeddings account') });
    setEmbedderForTests(createFakeEmbedder());
    await as('admin', (c) => updateAiSettings(c, { embeddings: { enabled: true, accountId: openai, model: 'emb-1' } }));
    await db.su.query(`update ai_setting set embed_dimension = 8`);
    expect(await as('admin', (c) => testAiConnection(c, 'embeddings'))).toMatchObject({ ok: true, role: 'embeddings', model: 'emb-1', dimension: 32 });
    expect((await as('admin', (c) => getAiSettings(c))).embeddings.dimension).toBe(32);
    setEmbedderForTests(() => { throw new Error(`401 nope ${KEY}`); });
    const bad = await as('admin', (c) => testAiConnection(c, 'embeddings'));
    expect(bad.ok).toBe(false);
    expect(bad.error).not.toContain(KEY);
  });

  it('an account: tries the model it is assigned (or the one given), else proves the key with the model list', async () => {
    const fake = createFakeAiModel([{ ok: true }]);
    setAiModelForTests(fake.model);
    expect(await as('admin', (c) => testAiAccount(c, openai))).toMatchObject({ ok: true, model: 'gpt-x', role: null });
    expect(fake.calls).toHaveLength(1);
    expect(await as('admin', (c) => testAiAccount(c, openai, { model: 'other-model' }))).toMatchObject({ ok: true, model: 'other-model' });
    // The Gemini account is assigned to reading only: its reading model is tried.
    expect(await as('admin', (c) => testAiAccount(c, google))).toMatchObject({ ok: true, model: 'gem-vision' });
    await as('admin', (c) => updateAiSettings(c, { reading: { accountId: null, model: null } }));
    // No model to try: the key is checked by fetching the model list (no inference).
    replies['https://generativelanguage.googleapis.com/v1beta/models'] = { body: { models: [] } };
    const calls = fake.calls.length;
    expect(await as('admin', (c) => testAiAccount(c, google))).toMatchObject({ ok: true, model: null });
    expect(fake.calls.length).toBe(calls);
    replies['https://generativelanguage.googleapis.com/v1beta/models'] = { status: 403, body: {} };
    expect(await as('admin', (c) => testAiAccount(c, google))).toMatchObject({ ok: false, error: expect.stringContaining('did not accept the key') });
  });
});

describe('model list', () => {
  it('is fetched on the server for the account, filtered by kind, cached, and refreshed on request; a failure is a message, not a crash', async () => {
    await reset();
    const a = await as('admin', (c) => createAiAccount(c, { name: 'Work OpenAI', provider: 'openai', apiKey: KEY }));
    replies['https://api.openai.com/v1/models'] = { body: { data: [{ id: 'gpt-x' }, { id: 'text-embedding-9' }, { id: 'whisper-1' }] } };
    const chat = await as('admin', (c) => listAccountModels(c, a.id, { kind: 'chat' }));
    expect(chat).toMatchObject({ models: [{ id: 'gpt-x', kind: 'chat' }], error: null, cached: false });
    expect((await as('admin', (c) => listAccountModels(c, a.id, { kind: 'embedding' }))).models.map((m) => m.id)).toEqual(['text-embedding-9']);
    expect(seen).toHaveLength(1); // the second call came from the cache
    expect((await as('admin', (c) => listAccountModels(c, a.id))).models).toHaveLength(3);
    await as('admin', (c) => listAccountModels(c, a.id, { refresh: true }));
    expect(seen).toHaveLength(2);
    // Editing the account (a new key) starts a fresh list.
    await as('admin', (c) => updateAiAccount(c, a.id, { apiKey: 'a-brand-new-key-0000' }));
    await as('admin', (c) => listAccountModels(c, a.id));
    expect(seen).toHaveLength(3);
    replies['https://api.openai.com/v1/models'] = { status: 401, body: {} };
    const failed = await as('admin', (c) => listAccountModels(c, a.id, { refresh: true }));
    expect(failed.models).toEqual([]);
    expect(failed.error).toMatch(/did not accept the key/);
    expect(JSON.stringify(failed)).not.toContain('a-brand-new-key-0000');
    const bare = await as('admin', (c) => createAiAccount(c, { name: 'Bare', provider: 'openai' }));
    expect((await as('admin', (c) => listAccountModels(c, bare.id))).error).toMatch(/no API key/);
  });
});

describe('environment fallback (no account assigned)', () => {
  it('uses the key of the chosen provider only, including OPENROUTER_API_KEY, and an assigned account wins', async () => {
    await reset();
    const restore = env({ AI_PROVIDER: 'openai', AI_MODEL: 'env-model', ANTHROPIC_API_KEY: 'anthropic-env-key-1', OPENAI_API_KEY: 'openai-env-key-2222' });
    try {
      expect(await as('admin', (c) => getAiSettings(c))).toMatchObject({ enabled: true, analysis: { accountId: null, model: 'env-model' }, environment: { provider: 'openai', model: 'env-model', keyPresent: true } });
      expect((await inJob(() => asWorker((c) => loadAiRuntime(c)))).config).toEqual({ provider: 'openai', model: 'env-model', apiKey: 'openai-env-key-2222', baseUrl: null });
      expect(await as('admin', (c) => aiReadiness(c))).toEqual({ ok: true });
      // Saving only limits keeps the environment in force (no model is copied out of it).
      await as('admin', (c) => updateAiSettings(c, { enabled: true, cap: { unit: 'tokens', tokens: 5000 } }));
      expect((await inJob(() => asWorker((c) => loadAiRuntime(c)))).config).toMatchObject({ provider: 'openai', model: 'env-model' });
      // An assigned account wins over the environment.
      const a = await as('admin', (c) => createAiAccount(c, { provider: 'google', apiKey: 'gkey-abcdefgh-9999' }));
      await as('admin', (c) => updateAiSettings(c, { analysis: { accountId: a.id, model: 'gem' } }));
      expect((await inJob(() => asWorker((c) => loadAiRuntime(c)))).config).toMatchObject({ provider: 'google', apiKey: 'gkey-abcdefgh-9999' });
      // An account with no key of its own uses the environment's key for ITS provider, never another's.
      const bare = await as('admin', (c) => createAiAccount(c, { name: 'Bare OpenAI', provider: 'openai' }));
      expect(bare).toMatchObject({ keySource: 'environment', keyConfigured: false });
      await as('admin', (c) => updateAiSettings(c, { analysis: { accountId: bare.id, model: 'gpt' } }));
      expect((await inJob(() => asWorker((c) => loadAiRuntime(c)))).config.apiKey).toBe('openai-env-key-2222');
      const noKey = await as('admin', (c) => createAiAccount(c, { name: 'Bare Gemini', provider: 'google' }));
      await as('admin', (c) => updateAiSettings(c, { enabled: false, analysis: { accountId: noKey.id, model: 'c' } }));
      await expect(inJob(() => asWorker((c) => loadAiRuntime(c, { requireEnabled: false })))).rejects.toThrow(/API key/);
    } finally { restore(); }
    await reset();
    const restore2 = env({ AI_PROVIDER: 'openrouter', AI_MODEL: 'vendor/env', OPENROUTER_API_KEY: 'or-env-key-777777' });
    try {
      expect((await inJob(() => asWorker((c) => loadAiRuntime(c)))).config).toEqual({ provider: 'openrouter', model: 'vendor/env', apiKey: 'or-env-key-777777', baseUrl: null });
    } finally { restore2(); }
    await reset();
    const restore3 = env({ AI_PROVIDER: 'openai_compatible', AI_MODEL: 'env-model', AI_BASE_URL: 'http://ollama:11434/v1' });
    try {
      expect((await inJob(() => asWorker((c) => loadAiRuntime(c)))).config).toEqual({ provider: 'openai_compatible', model: 'env-model', apiKey: '', baseUrl: 'http://ollama:11434/v1' });
    } finally { restore3(); }
    const restore4 = env({});
    try {
      expect(await as('admin', (c) => aiReadiness(c))).toMatchObject({ ok: false });
      expect(await as('admin', (c) => getAiSettings(c))).toMatchObject({ enabled: false });
    } finally { restore4(); }
  });
});

describe('embed', () => {
  const cfg = { provider: 'openai', baseUrl: null, model: 'e', dimension: 32, apiKey: '' };
  const runtime = () => createAiRuntime({ provider: 'anthropic', model: 'm', apiKey: KEY }, new AiBudget({ maxTokens: 100 }), cfg);

  it('is worker-only, logged, and counted against the run budget', async () => {
    setEmbedderForTests(createFakeEmbedder());
    await expect(embed(['a'], { runtime: runtime() })).rejects.toBeInstanceOf(AiScopeError);
    const rt = runtime();
    const { vectors, usage } = await inJob(() => embed(['alpha beta', 'gamma'], { runtime: rt }));
    expect(vectors).toHaveLength(2);
    expect(usage).toMatchObject({ task: 'embed', provider: 'openai', model: 'e', count: 2, ok: true, costUsd: null });
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(rt.budget.totalTokens).toBe(usage.inputTokens);
    expect(rt.calls).toEqual([usage]);
    await expect(inJob(() => embed(['x'.repeat(600)], { runtime: rt }))).rejects.toMatchObject({ name: 'BudgetExceeded' });
  });

  it('fails clearly when embeddings are not set up or the dimension is wrong; a dimension of 0 is a probe that accepts any size', async () => {
    await expect(inJob(() => embed(['a'], { runtime: createAiRuntime({ provider: 'anthropic', model: 'm', apiKey: '' }) }))).rejects.toThrow(/not set up/);
    setEmbedderForTests(() => ({ vectors: [[1, 2, 3]] }));
    await expect(inJob(() => embed(['a'], { runtime: runtime() }))).rejects.toThrow(/3 dimensions/);
    const probe = createAiRuntime({ provider: 'anthropic', model: 'm', apiKey: '' }, new AiBudget(), { ...cfg, dimension: 0 });
    expect((await inJob(() => embed(['a'], { runtime: probe }))).vectors).toEqual([[1, 2, 3]]);
  });
});

describe('requirement embeddings', () => {
  const cfg = { provider: 'openai', baseUrl: null, model: 'e', dimension: 32, apiKey: '' };
  const run = () => createAiRuntime({ provider: 'anthropic', model: 'm', apiKey: KEY }, new AiBudget(), cfg);
  beforeAll(async () => { await db.su.query(`delete from embedding`); });

  it('builds the text from level path, code, title and description', async () => {
    const items = await as('admin', (c) => requirementEmbeddingItems(c, [ids.r1!]));
    expect(items).toEqual([{ ownerType: 'requirement', ownerId: ids.r1, text: 'Path: 1 Institutional purposes\n1.1 Mission\nThe institution states its mission publicly.' }]);
  });

  it('embeds only what changed: the same text and model are skipped', async () => {
    const embedder = createFakeEmbedder();
    setEmbedderForTests(embedder);
    const items = await as('admin', (c) => requirementEmbeddingItems(c, [ids.r1!, ids.r2!, ids.r3!]));
    const first = await inJob(() => asWorker((c) => upsertEmbeddings(c, items, run())));
    expect(first).toMatchObject({ embedded: 3, skipped: 0 });
    const again = await inJob(() => asWorker((c) => upsertEmbeddings(c, items, run())));
    expect(again).toMatchObject({ embedded: 0, skipped: 3, usage: null });
    expect(embedder.calls).toHaveLength(1);
    const changed = items.map((i) => (i.ownerId === ids.r2 ? { ...i, text: `${i.text} Revised.` } : i));
    expect(await inJob(() => asWorker((c) => upsertEmbeddings(c, changed, run())))).toMatchObject({ embedded: 1, skipped: 2 });
    expect(embedder.calls.at(-1)).toEqual([changed[1]!.text]);
    // A different model is a new vector set.
    const other = createAiRuntime({ provider: 'anthropic', model: 'm', apiKey: KEY }, new AiBudget(), { ...cfg, model: 'e2' });
    expect(await inJob(() => asWorker((c) => upsertEmbeddings(c, items, other)))).toMatchObject({ embedded: 3 });
    expect((await db.su.query(`select count(*)::int n from embedding`)).rows[0].n).toBe(6);
    expect((await db.su.query(`select text_hash from embedding where owner_id = $1 and model = 'e'`, [ids.r2])).rows[0].text_hash).toBe(textHash(changed[1]!.text));
  });

  it('ranks candidates by cosine similarity, best first, limited to k and to the candidates', async () => {
    setEmbedderForTests(createFakeEmbedder());
    const { vectors } = await inJob(() => embed(['Library resources support learning'], { runtime: run() }));
    const ranked = await as('admin', (c) => rankBySimilarity(c, vectors[0]!, [ids.r1!, ids.r2!, ids.r3!], 2, 'e'));
    expect(ranked.map((r) => r.ownerId)[0]).toBe(ids.r3);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.similarity).toBeGreaterThan(ranked[1]!.similarity);
    expect(await as('admin', (c) => rankBySimilarity(c, vectors[0]!, [ids.r1!], 5, 'e'))).toHaveLength(1);
    expect(await as('admin', (c) => rankBySimilarity(c, vectors[0]!, [], 5, 'e'))).toEqual([]);
  });

  it('cosine handles identical, orthogonal, zero and mismatched vectors', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([1], [1, 2])).toBe(0);
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1);
  });
});
