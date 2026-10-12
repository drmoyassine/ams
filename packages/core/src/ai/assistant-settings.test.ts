// Settings -> AI -> Models -> Assistant (DEC-027): the role's account and model (default: the analysis ones), its switch, the cap per
// answer, the readiness the panel shows, and the connection the assistant job opens. The model is always a fake.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ASSISTANT_TURN_TOKENS } from '@ams/shared';
import { withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { ConflictError, ForbiddenError, ValidationError, type Ctx } from '../ctx.js';
import { AssistantDisabledError, AiDisabledError, createFakeAiModel, runInAiScope, setAiModelForTests } from './index.js';
import { assistantReadiness, getAiSettings, loadAssistantRuntime, testAiConnection, updateAiSettings } from './settings.js';
import { createAiAccount, deleteAiAccount, listAiAccounts } from './accounts.js';

let db: TestDb;
let pool: pg.Pool;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const as = <T>(who: string, fn: (ctx: Ctx) => Promise<T>) => {
  const caller = { userId: ids[who]!, institutionId: ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  return withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined }));
};

beforeAll(async () => {
  process.env.APP_SECRET = 'a'.repeat(40);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('asstset');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1), ($1, $3, 'lead', 'institution', $1)`, [ids.inst, ids.admin, ids.lead]);
}, 30000);
afterAll(async () => { delete process.env.APP_SECRET; await pool.end(); await db.close(); });
beforeEach(async () => { await db.su.query('delete from ai_setting'); await db.su.query('delete from ai_account'); });
afterEach(() => setAiModelForTests(null));

const account = (name: string, provider: 'anthropic' | 'openai' = 'openai') => as('admin', (ctx) => createAiAccount(ctx, { name, provider, apiKey: `sk-${name}-0123456789` }));

describe('the assistant role', () => {
  it('defaults to the analysis model, on, with the default cap; only an administrator reads or changes it', async () => {
    const s = await as('admin', (ctx) => getAiSettings(ctx));
    expect(s.assistant).toEqual({ accountId: null, model: null, enabled: true, maxTokensPerTurn: DEFAULT_ASSISTANT_TURN_TOKENS });
    await expect(as('lead', (ctx) => getAiSettings(ctx))).rejects.toThrow(ForbiddenError);
    await expect(as('lead', (ctx) => updateAiSettings(ctx, { assistant: { enabled: false } }))).rejects.toThrow(ForbiddenError);
  });

  it('takes its own account and model, the switch and the cap; an account needs a model; the account is then "in use"', async () => {
    const a = await account('Analysis');
    const b = await account('Chat', 'anthropic');
    await as('admin', (ctx) => updateAiSettings(ctx, { enabled: true, analysis: { accountId: a.id, model: 'big-model' } }));
    await expect(as('admin', (ctx) => updateAiSettings(ctx, { assistant: { accountId: b.id } }))).rejects.toThrow(ValidationError);
    const s = await as('admin', (ctx) => updateAiSettings(ctx, { assistant: { accountId: b.id, model: 'small-model', maxTokensPerTurn: 20000, enabled: true } }));
    expect(s.assistant).toEqual({ accountId: b.id, model: 'small-model', enabled: true, maxTokensPerTurn: 20000 });
    expect((await as('admin', (ctx) => listAiAccounts(ctx))).find((x) => x.id === b.id)!.usedFor).toEqual(['assistant']);
    await expect(as('admin', (ctx) => deleteAiAccount(ctx, b.id))).rejects.toThrow(/used for Assistant/);
    await expect(as('admin', (ctx) => deleteAiAccount(ctx, b.id))).rejects.toBeInstanceOf(ConflictError);
    // Back to the analysis model.
    const back = await as('admin', (ctx) => updateAiSettings(ctx, { assistant: { accountId: null, model: null } }));
    expect(back.assistant).toMatchObject({ accountId: null, model: null, maxTokensPerTurn: 20000 });
    await as('admin', (ctx) => deleteAiAccount(ctx, b.id));
  });

  it('opens the assistant\'s connection with its own per-answer budget, apart from the analysis cap', async () => {
    const a = await account('Analysis');
    const b = await account('Chat', 'anthropic');
    await as('admin', (ctx) => updateAiSettings(ctx, { enabled: true, analysis: { accountId: a.id, model: 'big-model' }, cap: { tokens: 5_000_000 } }));
    setAiModelForTests(createFakeAiModel(['x']).model);
    let rt = await runInAiScope('job', () => as('lead', (ctx) => loadAssistantRuntime(ctx)));
    expect(rt.config).toMatchObject({ provider: 'openai', model: 'big-model' });
    expect(rt.budget.limits.maxTokens).toBe(DEFAULT_ASSISTANT_TURN_TOKENS);
    await as('admin', (ctx) => updateAiSettings(ctx, { assistant: { accountId: b.id, model: 'small-model', maxTokensPerTurn: 12345 } }));
    rt = await runInAiScope('job', () => as('lead', (ctx) => loadAssistantRuntime(ctx)));
    expect(rt.config).toMatchObject({ provider: 'anthropic', model: 'small-model', apiKey: 'sk-Chat-0123456789' });
    expect(rt.budget.limits.maxTokens).toBe(12345);
  });

  it('is refused plainly when AI or the assistant is switched off, and only inside a job', async () => {
    const a = await account('Analysis');
    await as('admin', (ctx) => updateAiSettings(ctx, { enabled: true, analysis: { accountId: a.id, model: 'm' }, assistant: { enabled: false } }));
    setAiModelForTests(createFakeAiModel(['x']).model);
    await expect(runInAiScope('job', () => as('lead', (ctx) => loadAssistantRuntime(ctx)))).rejects.toThrow(AssistantDisabledError);
    await as('admin', (ctx) => updateAiSettings(ctx, { assistant: { enabled: true }, enabled: false }));
    await expect(runInAiScope('job', () => as('lead', (ctx) => loadAssistantRuntime(ctx)))).rejects.toThrow(AiDisabledError);
    await expect(as('lead', (ctx) => loadAssistantRuntime(ctx))).rejects.toThrow(/inside a worker job|worker job/);
  });

  it('tells anyone whether the assistant can be used, and why not', async () => {
    const a = await account('Analysis');
    expect(await as('lead', (ctx) => assistantReadiness(ctx))).toMatchObject({ ok: false, reason: 'not_configured' });
    await as('admin', (ctx) => updateAiSettings(ctx, { enabled: true, analysis: { accountId: a.id, model: 'm' } }));
    expect(await as('lead', (ctx) => assistantReadiness(ctx))).toEqual({ ok: true });
    await as('admin', (ctx) => updateAiSettings(ctx, { assistant: { enabled: false } }));
    expect(await as('lead', (ctx) => assistantReadiness(ctx))).toMatchObject({ ok: false, reason: 'assistant_off' });
    await as('admin', (ctx) => updateAiSettings(ctx, { assistant: { enabled: true }, enabled: false }));
    expect(await as('lead', (ctx) => assistantReadiness(ctx))).toMatchObject({ ok: false, reason: 'ai_off' });
  });

  it('"Test" for the assistant uses its model and never returns a key', async () => {
    const a = await account('Analysis');
    const b = await account('Chat', 'anthropic');
    await as('admin', (ctx) => updateAiSettings(ctx, { enabled: true, analysis: { accountId: a.id, model: 'big-model' }, assistant: { accountId: b.id, model: 'small-model' } }));
    setAiModelForTests(createFakeAiModel([{ ok: true }]).model);
    const ok = await as('admin', (ctx) => testAiConnection(ctx, 'assistant'));
    expect(ok).toMatchObject({ ok: true, role: 'assistant', model: 'small-model', error: null });
    setAiModelForTests(createFakeAiModel([new Error('401 sk-Chat-0123456789 rejected')]).model);
    const bad = await as('admin', (ctx) => testAiConnection(ctx, 'assistant'));
    expect(bad.ok).toBe(false);
    expect(bad.error).not.toContain('sk-Chat-0123456789');
  });
});
