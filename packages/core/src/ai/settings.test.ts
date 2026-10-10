// Settings -> AI: who may change it, that the key never comes back, the worker's view of it, the connection test, and
// the embeddings table (DEC-023). The model is always a fake: nothing reaches the network.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { ForbiddenError, ValidationError, type Ctx } from '../ctx.js';
import {
  AiBudget, AiDisabledError, AiScopeError, createAiRuntime, createFakeAiModel, createFakeEmbedder, embed, runInAiScope, setAiModelForTests, setEmbedderForTests,
} from './index.js';
import { cosine, rankBySimilarity, requirementEmbeddingItems, textHash, upsertEmbeddings } from './embeddings.js';
import { getAiSettings, loadAiRuntime, testAiConnection, updateAiSettings } from './settings.js';

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

beforeAll(async () => {
  process.env.APP_SECRET = SECRET;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('aiset');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
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
afterAll(async () => { delete process.env.APP_SECRET; await pool.end(); await db.close(); });
beforeEach(() => { setAiModelForTests(null); });
afterEach(() => { setAiModelForTests(null); setEmbedderForTests(null); });

describe('Settings -> AI', () => {
  it('is for the admin only', async () => {
    await expect(as('lead', (c) => getAiSettings(c))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(as('viewer', (c) => updateAiSettings(c, { model: 'x' }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(as('lead', (c) => testAiConnection(c))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await as('admin', (c) => getAiSettings(c))).toMatchObject({ provider: 'anthropic', enabled: false, keyConfigured: false, keyLast4: null, embeddings: { enabled: false } });
  });

  it('stores the key encrypted and returns only that it is set and its last 4 characters', async () => {
    const saved = await as('admin', (c) => updateAiSettings(c, { model: 'some-model', apiKey: KEY, maxTokensPerRun: 50000, enabled: true }));
    expect(saved).toMatchObject({ model: 'some-model', keyConfigured: true, keyLast4: 'abcd', keySource: 'settings', maxTokensPerRun: 50000, enabled: true });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    const raw = (await db.su.query(`select api_key_enc, api_key_last4 from ai_setting`)).rows[0];
    expect(raw.api_key_enc).not.toContain(KEY);
    expect(raw.api_key_enc).toMatch(/^v1:/);
    const audit = (await db.su.query(`select before::text b, after::text a from audit_event where target_type = 'ai_setting'`)).rows;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some((r) => `${r.a}${r.b}`.includes(KEY))).toBe(false);
    expect(JSON.stringify(await as('admin', (c) => getAiSettings(c)))).not.toContain(KEY);
  });

  it('keeps the key when it is not in the update, and removes it with null', async () => {
    expect(await as('admin', (c) => updateAiSettings(c, { maxTokensPerRun: 60000 }))).toMatchObject({ keyConfigured: true, keyLast4: 'abcd' });
    expect(await as('admin', (c) => updateAiSettings(c, { apiKey: null, enabled: false }))).toMatchObject({ keyConfigured: false, keyLast4: null });
    await as('admin', (c) => updateAiSettings(c, { apiKey: KEY, enabled: true }));
  });

  it('checks the limits and what must be set before AI is switched on', async () => {
    await expect(as('admin', (c) => updateAiSettings(c, { maxCostUsdPerRun: 5 }))).rejects.toBeInstanceOf(ValidationError);
    expect(await as('admin', (c) => updateAiSettings(c, { maxCostUsdPerRun: 5, inputUsdPerMTok: 3, outputUsdPerMTok: 15 }))).toMatchObject({ maxCostUsdPerRun: 5, inputUsdPerMTok: 3, outputUsdPerMTok: 15 });
    await as('admin', (c) => updateAiSettings(c, { enabled: false, model: null, apiKey: null }));
    await expect(as('admin', (c) => updateAiSettings(c, { enabled: true }))).rejects.toThrow(/model/);
    await expect(as('admin', (c) => updateAiSettings(c, { enabled: true, model: 'some-model' }))).rejects.toThrow(/API key/);
    await as('admin', (c) => updateAiSettings(c, { enabled: true, model: 'some-model', apiKey: KEY }));
  });
});

describe('the worker opens the connection', () => {
  it('decrypts the key and builds the budget from the saved limits, only inside a job', async () => {
    await expect(asWorker((c) => loadAiRuntime(c))).rejects.toBeInstanceOf(AiScopeError);
    const rt = await inJob(() => asWorker((c) => loadAiRuntime(c)));
    expect(rt.config).toEqual({ provider: 'anthropic', model: 'some-model', apiKey: KEY, baseUrl: null });
    expect(rt.budget.limits).toMatchObject({ maxTokens: 60000, maxCostUsd: 5, inputUsdPerMTok: 3, outputUsdPerMTok: 15 });
    expect(rt.embedding).toBeUndefined();
  });

  it('refuses when AI is switched off', async () => {
    await as('admin', (c) => updateAiSettings(c, { enabled: false }));
    await expect(inJob(() => asWorker((c) => loadAiRuntime(c)))).rejects.toBeInstanceOf(AiDisabledError);
    await as('admin', (c) => updateAiSettings(c, { enabled: true }));
  });
});

describe('Test connection', () => {
  it('reports ok through the model, even when AI is switched off', async () => {
    const fake = createFakeAiModel([{ ok: true }]);
    setAiModelForTests(fake.model);
    await as('admin', (c) => updateAiSettings(c, { enabled: false }));
    const r = await as('admin', (c) => testAiConnection(c));
    expect(r).toMatchObject({ ok: true, model: 'some-model', error: null, embeddings: null });
    expect(fake.calls).toHaveLength(1);
    await as('admin', (c) => updateAiSettings(c, { enabled: true }));
  });

  it('reports a failure with the reason and without the key', async () => {
    setAiModelForTests(createFakeAiModel([new Error(`401 bad key ${KEY}`)]).model);
    const r = await as('admin', (c) => testAiConnection(c));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('bad key');
    expect(r.error).not.toContain(KEY);
  });

  it('is the only entry outside a job: nothing else can call the model there', async () => {
    setAiModelForTests(createFakeAiModel([{ ok: true }]).model);
    await expect(as('admin', (c) => loadAiRuntime(c, { requireEnabled: false }))).rejects.toBeInstanceOf(AiScopeError);
  });
});

describe('embeddings settings', () => {
  it('needs a base URL, model and dimension to be switched on, and never returns its key', async () => {
    await expect(as('admin', (c) => updateAiSettings(c, { embeddings: { enabled: true } }))).rejects.toBeInstanceOf(ValidationError);
    const saved = await as('admin', (c) => updateAiSettings(c, {
      embeddings: { enabled: true, baseUrl: 'http://embed.local:8080/v1', model: 'multilingual-model', dimension: 32, apiKey: 'emb-key-98765' },
    }));
    expect(saved.embeddings).toEqual({ enabled: true, baseUrl: 'http://embed.local:8080/v1', model: 'multilingual-model', dimension: 32, keyConfigured: true, keyLast4: '8765' });
    expect(JSON.stringify(saved)).not.toContain('emb-key-98765');
    expect((await db.su.query(`select embed_api_key_enc from ai_setting`)).rows[0].embed_api_key_enc).not.toContain('emb-key-98765');
  });

  it('puts the embedding endpoint in the run, and the connection test checks it too', async () => {
    const rt = await inJob(() => asWorker((c) => loadAiRuntime(c)));
    expect(rt.embedding).toEqual({ baseUrl: 'http://embed.local:8080/v1', model: 'multilingual-model', dimension: 32, apiKey: 'emb-key-98765' });
    setAiModelForTests(createFakeAiModel([{ ok: true }]).model);
    setEmbedderForTests(createFakeEmbedder());
    expect((await as('admin', (c) => testAiConnection(c))).embeddings).toMatchObject({ ok: true, dimension: 32, error: null });
    setEmbedderForTests(() => ({ vectors: [[1, 2]] }));
    expect((await as('admin', (c) => testAiConnection(c))).embeddings).toMatchObject({ ok: false });
  });
});

describe('embed', () => {
  const runtime = () => createAiRuntime({ provider: 'anthropic', model: 'm', apiKey: KEY }, new AiBudget({ maxTokens: 100 }), { baseUrl: 'http://x', model: 'e', dimension: 32, apiKey: '' });

  it('is worker-only, logged, and counted against the run budget', async () => {
    setEmbedderForTests(createFakeEmbedder());
    await expect(embed(['a'], { runtime: runtime() })).rejects.toBeInstanceOf(AiScopeError);
    const rt = runtime();
    const { vectors, usage } = await inJob(() => embed(['alpha beta', 'gamma'], { runtime: rt }));
    expect(vectors).toHaveLength(2);
    expect(usage).toMatchObject({ task: 'embed', model: 'e', count: 2, ok: true, costUsd: null });
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(rt.budget.totalTokens).toBe(usage.inputTokens);
    expect(rt.calls).toEqual([usage]);
    await expect(inJob(() => embed(['x'.repeat(600)], { runtime: rt }))).rejects.toMatchObject({ name: 'BudgetExceeded' });
  });

  it('fails clearly when embeddings are not set up or the dimension is wrong', async () => {
    await expect(inJob(() => embed(['a'], { runtime: createAiRuntime({ provider: 'anthropic', model: 'm', apiKey: '' }) }))).rejects.toThrow(/not set up/);
    setEmbedderForTests(() => ({ vectors: [[1, 2, 3]] }));
    await expect(inJob(() => embed(['a'], { runtime: runtime() }))).rejects.toThrow(/3 dimensions/);
  });
});

describe('requirement embeddings', () => {
  const cfg = { baseUrl: 'http://x', model: 'e', dimension: 32, apiKey: '' };
  const run = () => createAiRuntime({ provider: 'anthropic', model: 'm', apiKey: KEY }, new AiBudget(), cfg);

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

describe('providers', () => {
  const NEW_KEY = 'new-provider-key-5678';
  const row = async () => (await db.su.query(`select provider, base_url, api_key_enc, api_key_last4, enabled from ai_setting`)).rows[0];
  const env = (vars: Record<string, string | undefined>) => {
    const keys = ['AI_PROVIDER', 'AI_MODEL', 'AI_BASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'OPENAI_COMPATIBLE_API_KEY'];
    const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    return () => { for (const k of keys) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } };
  };

  it('removes the saved key when the provider changes, so it is never sent to another company', async () => {
    // Earlier tests left an Anthropic key saved and AI on.
    expect(await row()).toMatchObject({ provider: 'anthropic', enabled: true });
    expect((await row()).api_key_enc).toBeTruthy();
    // AI is on and the new provider has no key: refused, and nothing changes.
    await expect(as('admin', (c) => updateAiSettings(c, { provider: 'openai' }))).rejects.toThrow(/key for the new provider/);
    expect(await row()).toMatchObject({ provider: 'anthropic', api_key_last4: 'abcd' });
    // Switch off first: the switch itself drops the key.
    const dto = await as('admin', (c) => updateAiSettings(c, { provider: 'openai', enabled: false }));
    expect(dto).toMatchObject({ provider: 'openai', keyConfigured: false, keyLast4: null, keySource: 'none' });
    expect(await row()).toMatchObject({ provider: 'openai', api_key_enc: null, api_key_last4: null });
  });

  it('keeps a key entered in the same save as the provider change, and keeps a key when the provider is unchanged', async () => {
    const dto = await as('admin', (c) => updateAiSettings(c, { provider: 'google', apiKey: NEW_KEY }));
    expect(dto).toMatchObject({ provider: 'google', keyConfigured: true, keyLast4: '5678' });
    expect(await as('admin', (c) => updateAiSettings(c, { provider: 'google', maxTokensPerRun: 70000 }))).toMatchObject({ keyLast4: '5678' });
    const rt = await inJob(() => asWorker((c) => loadAiRuntime(c, { requireEnabled: false })));
    expect(rt.config).toMatchObject({ provider: 'google', apiKey: NEW_KEY, baseUrl: null });
  });

  it('openai_compatible: needs a valid Base URL, works without a key, and drops the URL for other providers', async () => {
    await expect(as('admin', (c) => updateAiSettings(c, { provider: 'openai_compatible' }))).rejects.toThrow(/Base URL/);
    await expect(as('admin', (c) => updateAiSettings(c, { provider: 'openai_compatible', baseUrl: 'ftp://host/v1' }))).rejects.toThrow(/http/);
    await expect(as('admin', (c) => updateAiSettings(c, { provider: 'openai_compatible', baseUrl: 'http://u:p@host/v1' }))).rejects.toThrow(/user name or password/);
    await expect(as('admin', (c) => updateAiSettings(c, { baseUrl: 'http://host/v1' }))).rejects.toThrow(/only for the OpenAI-compatible/);
    const dto = await as('admin', (c) => updateAiSettings(c, { provider: 'openai_compatible', baseUrl: 'http://host:11434/v1', model: 'local', enabled: true }));
    expect(dto).toMatchObject({ provider: 'openai_compatible', baseUrl: 'http://host:11434/v1', keyConfigured: false, enabled: true });
    expect(await row()).toMatchObject({ base_url: 'http://host:11434/v1', api_key_enc: null });
    const rt = await inJob(() => asWorker((c) => loadAiRuntime(c)));
    expect(rt.config).toEqual({ provider: 'openai_compatible', model: 'local', apiKey: '', baseUrl: 'http://host:11434/v1' });
    // Back to a hosted provider: the Base URL goes.
    await as('admin', (c) => updateAiSettings(c, { provider: 'anthropic', apiKey: KEY, model: 'some-model' }));
    expect(await row()).toMatchObject({ provider: 'anthropic', base_url: null, api_key_last4: 'abcd' });
  });

  it('test connection runs through the chosen provider settings', async () => {
    const seenConfigs: unknown[] = [];
    const fake = createFakeAiModel([{ ok: true }]);
    setAiModelForTests((cfg) => { seenConfigs.push(cfg); return fake.model; });
    await as('admin', (c) => updateAiSettings(c, { provider: 'openai_compatible', baseUrl: 'http://host:11434/v1', model: 'local' }));
    expect(await as('admin', (c) => testAiConnection(c))).toMatchObject({ ok: true, model: 'local' });
    expect(seenConfigs[0]).toMatchObject({ provider: 'openai_compatible', baseUrl: 'http://host:11434/v1' });
    await as('admin', (c) => updateAiSettings(c, { provider: 'anthropic', apiKey: KEY, model: 'some-model' }));
  });

  it('environment fallback: the key of the chosen provider only, and a saved key still wins', async () => {
    await db.su.query(`delete from ai_setting`);
    const restore = env({ AI_PROVIDER: 'openai', AI_MODEL: 'env-model', ANTHROPIC_API_KEY: 'anthropic-env-key-1', OPENAI_API_KEY: 'openai-env-key-2222' });
    try {
      expect(await as('admin', (c) => getAiSettings(c))).toMatchObject({ provider: 'openai', model: 'env-model', keySource: 'environment', enabled: true });
      expect((await inJob(() => asWorker((c) => loadAiRuntime(c)))).config).toMatchObject({ provider: 'openai', apiKey: 'openai-env-key-2222' });
      // A saved key wins over the environment.
      await as('admin', (c) => updateAiSettings(c, { provider: 'openai', apiKey: NEW_KEY, model: 'm', enabled: true }));
      expect((await inJob(() => asWorker((c) => loadAiRuntime(c)))).config.apiKey).toBe(NEW_KEY);
      // Another provider's environment key is never borrowed.
      await as('admin', (c) => updateAiSettings(c, { provider: 'google', apiKey: null, enabled: false }));
      await expect(inJob(() => asWorker((c) => loadAiRuntime(c, { requireEnabled: false })))).rejects.toThrow(/API key/);
    } finally { restore(); }
    // openai_compatible from the environment: Base URL from AI_BASE_URL, key optional.
    await db.su.query(`delete from ai_setting`);
    const restore2 = env({ AI_PROVIDER: 'openai_compatible', AI_MODEL: 'env-model', AI_BASE_URL: 'http://ollama:11434/v1' });
    try {
      expect((await inJob(() => asWorker((c) => loadAiRuntime(c)))).config).toEqual({ provider: 'openai_compatible', model: 'env-model', apiKey: '', baseUrl: 'http://ollama:11434/v1' });
    } finally { restore2(); }
  });
});
