// @vitest-environment jsdom
// Settings -> AI against the real API with a fake model and stubbed provider lists: accounts, models, limits, reading, tests.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@ams/api';
import { clearModelCache, createFakeAiModel, createFakeEmbedder, setAiModelForTests, setEmbedderForTests } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { settingsApi, type SettingsApi } from './lib/settings-api';
import { AiSettingsPage } from './pages/settings/ai';

configure({ asyncUtilTimeout: 10000 });

const KEY = 'sk-ui-test-key-4321';
let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const apiFor = (who: string): SettingsApi => settingsApi(createApi(((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch));
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}

beforeAll(async () => {
  process.env.APP_SECRET = 'u'.repeat(40);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('webai');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1), ($1, $3, 'lead', 'institution', $1)`, [ids.inst, ids.admin, ids.lead]);
}, 30000);
afterEach(() => { cleanup(); setAiModelForTests(null); setEmbedderForTests(null); });
afterAll(async () => { delete process.env.APP_SECRET; await pool.end(); await db.close(); });

const realFetch = globalThis.fetch;
/** The providers' model lists, answered locally. Anything else fails like a network error. */
const stubProviders = (urls: Record<string, unknown>) => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = Object.entries(urls).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
};
const OPENAI_LIST = { 'https://api.openai.com/v1/models': { data: [{ id: 'gpt-x' }, { id: 'gpt-y' }, { id: 'text-embedding-9' }, { id: 'whisper-1' }] } };
const GOOGLE_LIST = { 'https://generativelanguage.googleapis.com/v1beta/models': { models: [{ name: 'models/gem-1', supportedGenerationMethods: ['generateContent'] }] } };
afterEach(() => { globalThis.fetch = realFetch; });
beforeEach(async () => {
  await db.su.query(`delete from ai_setting`);
  await db.su.query(`delete from ai_account`);
  clearModelCache();
});

const seed = async () => {
  const admin = apiFor('admin');
  const openai = await admin.createAiAccount({ name: 'Work OpenAI', provider: 'openai', apiKey: KEY });
  const gemini = await admin.createAiAccount({ name: 'Home Gemini', provider: 'google', apiKey: 'gkey-google-7777' });
  const claude = await admin.createAiAccount({ name: 'Claude', provider: 'anthropic', apiKey: 'ant-key-abcdefgh-1111' });
  return { openai, gemini, claude };
};
const saveButton = () => screen.getByRole('button', { name: 'Save' });
const pick = async (user: ReturnType<typeof userEvent.setup>, label: string, text: string, option: string) => {
  const box = await screen.findByRole('combobox', { name: label });
  await user.clear(box);
  await user.type(box, text);
  await user.click(await screen.findByRole('option', { name: new RegExp(option) }));
};

describe('AI settings page', () => {
  it('tells a non-administrator that it is for administrators', async () => {
    render(wrap(<AiSettingsPage api={apiFor('lead')} />));
    expect(await screen.findByText(/Only an administrator/)).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Accounts' })).toBeNull();
  });

  it('opens on Accounts when there are none, with a one-sentence empty state, three tabs that scroll, and the global switch on top', async () => {
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    expect(await screen.findByTestId('accounts-empty')).toBeTruthy();
    expect(screen.getByTestId('accounts-empty').textContent).toMatch(/No accounts yet/);
    const tabs = screen.getByRole('tablist');
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Accounts', 'Models', 'Limits']);
    expect(tabs.className).toContain('overflow-x-auto');
    expect(screen.getByRole('tab', { name: 'Accounts' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('switch', { name: /AI is on/ })).toBeTruthy();
    // No account is assigned, so the server's own settings are the fallback, and the page says so.
    expect(screen.getByTestId('env-note').textContent).toMatch(/server's own settings/);
  });

  it('adds an account in a dialog: five providers with OpenRouter in the list, a Base URL only for OpenAI-compatible, a write-only key', { timeout: 20000 }, async () => {
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const dialog = screen.getByRole('dialog');
    const provider = within(dialog).getByLabelText('Provider') as HTMLSelectElement;
    expect([...provider.options].map((o) => o.value)).toEqual(['anthropic', 'openai', 'google', 'openrouter', 'openai_compatible']);
    expect([...provider.options].map((o) => o.textContent)).toContain('OpenRouter');
    expect(within(dialog).queryByLabelText('Base URL')).toBeNull();
    await user.selectOptions(provider, 'openrouter');
    expect(within(dialog).queryByLabelText('Base URL')).toBeNull(); // OpenRouter's address is built in
    await user.selectOptions(provider, 'openai_compatible');
    expect(within(dialog).getByLabelText('Base URL')).toBeTruthy();
    await user.selectOptions(provider, 'openai');
    expect((within(dialog).getByLabelText('Label') as HTMLInputElement).placeholder).toBe('OpenAI');
    const key = within(dialog).getByLabelText('API key') as HTMLInputElement;
    expect(key.type).toBe('password');
    await user.type(key, KEY);
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }));
    const list = await screen.findByRole('list', { name: 'AI accounts' });
    expect(within(list).getByRole('heading', { name: 'OpenAI' })).toBeTruthy();
    expect(within(list).getByTestId('key-OpenAI').textContent).toBe('Key ends in …4321');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain(KEY);
    expect((await db.su.query(`select api_key_enc from ai_account`)).rows[0].api_key_enc).not.toContain(KEY);
  });

  it('adding an account saves only the account: the dialog form never submits the settings form around it', { timeout: 20000 }, async () => {
    const user = userEvent.setup();
    const api = apiFor('admin');
    const saveSettings = vi.spyOn(api, 'updateAiSettings');
    render(wrap(<AiSettingsPage api={api} />));
    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('form')).toBeNull(); // forms do not nest
    await user.selectOptions(within(dialog).getByLabelText('Provider'), 'openrouter');
    await user.type(within(dialog).getByLabelText('API key'), 'sk-or-v1-abcdef123456');
    await user.type(within(dialog).getByLabelText('API key'), '{Enter}');
    const list = await screen.findByRole('list', { name: 'AI accounts' });
    expect(within(list).getByRole('heading', { name: 'OpenRouter' })).toBeTruthy();
    expect(saveSettings).not.toHaveBeenCalled();
    // It is still there after a reload of the page.
    cleanup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Accounts' }));
    expect(within(await screen.findByRole('list', { name: 'AI accounts' })).getByRole('heading', { name: 'OpenRouter' })).toBeTruthy();
  });

  it('shows an unexplained failure inside the dialog instead of failing silently', async () => {
    const user = userEvent.setup();
    const api = apiFor('admin');
    vi.spyOn(api, 'createAiAccount').mockRejectedValue(new Error('Failed to fetch'));
    render(wrap(<AiSettingsPage api={api} />));
    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/could not be saved: Failed to fetch/);
  });

  it('shows the server\'s reason when an account cannot be added', async () => {
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Provider'), 'openai_compatible');
    await user.type(within(dialog).getByLabelText('Base URL'), 'http://user:pw@host:11434/v1');
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('accounts-empty')).toBeTruthy();
  });

  it('edits an account: the key is replaced or removed but never shown; changing the provider says the key goes', { timeout: 20000 }, async () => {
    await seed();
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Accounts' }));
    await user.click(await screen.findByRole('button', { name: 'Edit Work OpenAI' }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText('API key') as HTMLInputElement).placeholder).toContain('ending in 4321');
    expect((within(dialog).getByLabelText('API key') as HTMLInputElement).value).toBe('');
    await user.selectOptions(within(dialog).getByLabelText('Provider'), 'google');
    expect(within(dialog).getByText(/Changing the provider removes the saved key/)).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText('Provider'), 'openai');
    await user.click(within(dialog).getByLabelText('Remove the saved key'));
    await user.click(within(dialog).getByRole('button', { name: 'Save account' }));
    await waitFor(() => expect(screen.getByTestId('key-Work OpenAI').textContent).toMatch(/No key yet|server's key/));
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it('deletes an account after a confirmation, and says which role blocks it when one is in use', { timeout: 20000 }, async () => {
    const { openai, gemini } = await seed();
    await apiFor('admin').updateAiSettings({ analysis: { accountId: openai.id, model: 'gpt-x' } });
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Accounts' }));
    expect(await screen.findByText('Used for Analysis')).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Delete Work OpenAI' }));
    await user.click(within(screen.getByRole('group', { name: /Confirm deleting Work OpenAI/ })).getByRole('button', { name: 'Delete account' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/"Work OpenAI" is used for Analysis/);
    await user.click(screen.getByRole('button', { name: 'Delete Home Gemini' }));
    await user.click(within(screen.getByRole('group', { name: /Confirm deleting Home Gemini/ })).getByRole('button', { name: 'Keep it' }));
    expect(screen.getByRole('button', { name: 'Delete Home Gemini' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete Home Gemini' }));
    await user.click(within(screen.getByRole('group', { name: /Confirm deleting Home Gemini/ })).getByRole('button', { name: 'Delete account' }));
    await waitFor(() => expect(screen.queryByText('Home Gemini')).toBeNull());
    expect((await db.su.query(`select id from ai_account where id = $1`, [gemini.id])).rowCount).toBe(0);
  });

  it('tests an account on its own', async () => {
    const { openai } = await seed();
    await apiFor('admin').updateAiSettings({ analysis: { accountId: openai.id, model: 'gpt-x' } });
    setAiModelForTests(createFakeAiModel([{ ok: true }]).model);
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Accounts' }));
    await user.click(await screen.findByRole('button', { name: 'Test Work OpenAI' }));
    expect((await screen.findByTestId('test-Work OpenAI')).textContent).toMatch(/Work OpenAI: working \(gpt-x\)/);
  });
});

describe('Models tab', () => {
  it('picks the analysis account and a model from the fetched list, filters while typing, and switches between a saved OpenAI and a Gemini with one dropdown', { timeout: 40000 }, async () => {
    const { openai, gemini } = await seed();
    stubProviders({ ...OPENAI_LIST, ...GOOGLE_LIST });
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Models' }));
    const select = (await screen.findByLabelText('Analysis account')) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    await user.selectOptions(select, 'Work OpenAI (OpenAI)');
    const box = await screen.findByRole('combobox', { name: 'Analysis model' });
    await user.click(box);
    const listbox = await screen.findByRole('listbox', { name: 'Analysis model suggestions' });
    await waitFor(() => expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual(['gpt-x', 'gpt-y'])); // chat models only
    await user.type(box, 'gpt-y');
    expect(within(listbox).getAllByRole('option')).toHaveLength(1);
    await user.click(screen.getByRole('option', { name: 'gpt-y' }));
    expect((box as HTMLInputElement).value).toBe('gpt-y');
    await user.click(screen.getByRole('switch', { name: /AI is on/ }));
    await user.click(saveButton());
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect((await db.su.query(`select analysis_account_id, model, enabled from ai_setting`)).rows[0]).toEqual({ analysis_account_id: openai.id, model: 'gpt-y', enabled: true });
    // Switch to the Gemini account: the model is cleared, the list changes, one save.
    await user.selectOptions(screen.getByLabelText('Analysis account'), 'Home Gemini (Google)');
    expect((screen.getByRole('combobox', { name: 'Analysis model' }) as HTMLInputElement).value).toBe('');
    await pick(user, 'Analysis model', 'gem', 'gem-1');
    await user.click(saveButton());
    await waitFor(async () => expect((await db.su.query(`select analysis_account_id, model from ai_setting`)).rows[0]).toEqual({ analysis_account_id: gemini.id, model: 'gem-1' }));
  });

  it('says why the list could not be fetched and lets the person type a model id; Refresh asks again', { timeout: 30000 }, async () => {
    await seed();
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Models' }));
    await user.selectOptions(await screen.findByLabelText('Analysis account'), 'Work OpenAI (OpenAI)'); // fetch is not stubbed: it fails
    expect(await screen.findByText(/Could not load the model list: could not reach api\.openai\.com.*Type a model id instead/)).toBeTruthy();
    const box = screen.getByRole('combobox', { name: 'Analysis model' });
    await user.type(box, 'my-own-model');
    expect(screen.getByText(/The text you typed will be used|No models listed/)).toBeTruthy();
    stubProviders(OPENAI_LIST);
    await user.click(screen.getByRole('button', { name: 'Refresh Analysis model list' }));
    expect(await screen.findByText(/2 models/)).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: /AI is on/ }));
    await user.click(saveButton());
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect((await db.su.query(`select model from ai_setting`)).rows[0].model).toBe('my-own-model');
  });

  it('supports the keyboard in the model picker: arrows move, Enter picks, Escape closes', { timeout: 20000 }, async () => {
    await seed();
    stubProviders(OPENAI_LIST);
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Models' }));
    await user.selectOptions(await screen.findByLabelText('Analysis account'), 'Work OpenAI (OpenAI)');
    const box = await screen.findByRole('combobox', { name: 'Analysis model' });
    await user.click(box);
    await waitFor(() => expect(within(screen.getByRole('listbox')).getAllByRole('option').length).toBeGreaterThan(0));
    expect(box.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    expect((box as HTMLInputElement).value).toBe('gpt-y');
    await user.click(box);
    await user.keyboard('{Escape}');
    expect(box.getAttribute('aria-expanded')).toBe('false');
  });

  it('reading: "same as analysis" by default, its own account and model when chosen, OCR on/off, a page cap and a language hint', { timeout: 40000 }, async () => {
    const { gemini } = await seed();
    stubProviders({ ...OPENAI_LIST, ...GOOGLE_LIST });
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Models' }));
    const account = (await screen.findByLabelText('Reading account')) as HTMLSelectElement;
    expect(account.value).toBe('');
    expect(screen.getByText(/Uses the analysis model for scanned pages/)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Reading model' })).toBeNull();
    expect((screen.getByRole('switch', { name: /Read scanned pages with AI/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Max AI-read pages per file') as HTMLInputElement).value).toBe('200');
    expect((screen.getByLabelText('OCR language hint') as HTMLSelectElement).value).toBe('');
    await user.selectOptions(account, 'Home Gemini (Google)');
    await pick(user, 'Reading model', 'gem', 'gem-1');
    await user.click(screen.getByRole('switch', { name: /Read scanned pages with AI/ }));
    const pages = screen.getByLabelText('Max AI-read pages per file');
    await user.clear(pages);
    await user.type(pages, '60');
    await user.selectOptions(screen.getByLabelText('OCR language hint'), 'Arabic');
    await user.click(saveButton());
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect((await db.su.query(`select vision_account_id, vision_model, ocr_enabled, ocr_max_pages, ocr_language from ai_setting`)).rows[0])
      .toEqual({ vision_account_id: gemini.id, vision_model: 'gem-1', ocr_enabled: false, ocr_max_pages: 60, ocr_language: 'ar' });
    // Back to the analysis model.
    await user.selectOptions(screen.getByLabelText('Reading account'), 'Same as analysis');
    await user.click(saveButton());
    await waitFor(async () => expect((await db.su.query(`select vision_account_id, vision_model from ai_setting`)).rows[0]).toEqual({ vision_account_id: null, vision_model: null }));
  });

  it('embeddings: only accounts whose provider has embeddings; the same OpenAI account as analysis; the vector size is found, not typed', { timeout: 40000 }, async () => {
    const { openai } = await seed();
    stubProviders(OPENAI_LIST);
    setEmbedderForTests(createFakeEmbedder());
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Models' }));
    const account = (await screen.findByLabelText('Embeddings account')) as HTMLSelectElement;
    expect([...account.options].map((o) => o.textContent)).toEqual(['None', 'Work OpenAI (OpenAI)', 'Home Gemini (Google)']); // no Anthropic
    expect(screen.queryByLabelText('Vector dimension')).toBeNull(); // no field to type it in
    expect(screen.getByTestId('embedding-dimension').textContent).toMatch(/found automatically when you save/);
    // Same account for analysis and embeddings.
    await user.selectOptions(screen.getByLabelText('Analysis account'), 'Work OpenAI (OpenAI)');
    await pick(user, 'Analysis model', 'gpt-x', 'gpt-x');
    await user.selectOptions(account, 'Work OpenAI (OpenAI)');
    await pick(user, 'Embedding model', 'embedding', 'text-embedding-9');
    await user.click(screen.getByRole('switch', { name: /Embeddings are on/ }));
    await user.click(saveButton());
    expect(await screen.findByText('Saved.')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('embedding-dimension').textContent).toMatch(/Vector size: 32 \(found automatically\)/));
    expect((await db.su.query(`select analysis_account_id, embed_account_id, embed_model, embed_dimension, embed_enabled from ai_setting`)).rows[0])
      .toEqual({ analysis_account_id: openai.id, embed_account_id: openai.id, embed_model: 'text-embedding-9', embed_dimension: 32, embed_enabled: true });
  });

  it('tests each role and shows the result; Test is held back while there are unsaved changes', { timeout: 40000 }, async () => {
    const { openai } = await seed();
    await apiFor('admin').updateAiSettings({ enabled: true, analysis: { accountId: openai.id, model: 'gpt-x' }, embeddings: { enabled: false, accountId: openai.id, model: 'emb-1' } });
    setAiModelForTests(createFakeAiModel([{ ok: true }]).model);
    setEmbedderForTests(createFakeEmbedder());
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Models' }));
    await user.click(await screen.findByRole('button', { name: 'Test analysis' }));
    expect((await screen.findByTestId('test-Analysis')).textContent).toMatch(/Analysis: working \(gpt-x\)/);
    await user.click(screen.getByRole('button', { name: 'Test reading' }));
    expect((await screen.findByTestId('test-Reading')).textContent).toMatch(/Reading: working \(gpt-x\)/);
    await user.click(screen.getByRole('button', { name: 'Test embeddings' }));
    expect((await screen.findByTestId('test-Embeddings')).textContent).toMatch(/Embeddings: working \(emb-1\), 32 values per text/);
    await waitFor(() => expect(screen.getByTestId('embedding-dimension').textContent).toMatch(/Vector size: 32/));
    await user.click(screen.getByRole('switch', { name: /Read scanned pages with AI/ }));
    expect((screen.getByRole('button', { name: 'Test analysis' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/You have unsaved changes/)).toBeTruthy();
  });

  it('shows why a test failed, without the key', { timeout: 30000 }, async () => {
    const { openai } = await seed();
    await apiFor('admin').updateAiSettings({ enabled: true, analysis: { accountId: openai.id, model: 'gpt-x' } });
    setAiModelForTests(createFakeAiModel([new Error(`401 rejected ${KEY}`)]).model);
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Models' }));
    await user.click(await screen.findByRole('button', { name: 'Test analysis' }));
    const result = await screen.findByTestId('test-Analysis');
    expect(result.textContent).toMatch(/failed\. .*rejected/);
    expect(result.textContent).not.toContain(KEY);
  });
});

describe('Limits tab', () => {
  it('has one cap: tokens in millions with a rough pages helper, no price fields, USD unavailable without a known price; recovery rounds under Advanced', { timeout: 30000 }, async () => {
    const { openai } = await seed();
    await apiFor('admin').updateAiSettings({ analysis: { accountId: openai.id, model: 'gpt-x' } });
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Limits' }));
    expect(screen.queryByLabelText(/Price per million/)).toBeNull();
    expect(screen.queryByLabelText('Max cost per run (USD)')).toBeNull();
    const unit = (await screen.findByLabelText('Cap unit')) as HTMLSelectElement;
    expect([...unit.options].map((o) => [o.value, o.disabled])).toEqual([['tokens', false], ['usd', true]]);
    expect(screen.getByText(/available only when the provider lists the model's price/)).toBeTruthy();
    const cap = screen.getByLabelText('Cap per analysis run') as HTMLInputElement;
    expect(cap.value).toBe('');
    await user.type(cap, '1.5');
    expect(screen.getByTestId('cap-helper').textContent).toMatch(/About 375 pages of source text \(a very rough guide\)/);
    const rounds = screen.getByLabelText('Recovery rounds') as HTMLInputElement;
    expect(rounds.value).toBe('2');
    expect([rounds.min, rounds.max, rounds.step]).toEqual(['0', '5', '1']);
    expect(screen.getByText('Advanced').tagName).toBe('SUMMARY');
    await user.clear(rounds);
    await user.type(rounds, '4');
    await user.click(saveButton());
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect((await db.su.query(`select max_tokens_per_run, cap_unit, max_recovery_rounds from ai_setting`)).rows[0]).toEqual({ max_tokens_per_run: 1_500_000, cap_unit: 'tokens', max_recovery_rounds: 4 });
    await waitFor(() => expect((screen.getByLabelText('Cap per analysis run') as HTMLInputElement).value).toBe('1.5'));
  });

  it('offers US dollars when the model\'s price is known (OpenRouter lists it)', { timeout: 30000 }, async () => {
    const router = await apiFor('admin').createAiAccount({ name: 'Router', provider: 'openrouter', apiKey: 'or-key-12345678' });
    stubProviders({
      'https://openrouter.ai/api/v1/models': { data: [{ id: 'vendor/chat', pricing: { prompt: '0.000003', completion: '0.000015' } }] },
      'https://openrouter.ai/api/v1/embeddings/models': { data: [] },
    });
    await apiFor('admin').updateAiSettings({ analysis: { accountId: router.id, model: 'vendor/chat' } });
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Limits' }));
    const unit = (await screen.findByLabelText('Cap unit')) as HTMLSelectElement;
    expect(unit.options[1]!.disabled).toBe(false);
    await user.selectOptions(unit, 'usd');
    await user.type(screen.getByLabelText('Cap per analysis run'), '2.5');
    await user.click(saveButton());
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect((await db.su.query(`select cap_unit, max_cost_usd_per_run from ai_setting`)).rows[0]).toEqual({ cap_unit: 'usd', max_cost_usd_per_run: '2.5000' });
  });

  it('shows the server\'s reason when a setting cannot be saved', async () => {
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('tab', { name: 'Models' }));
    await user.click(await screen.findByRole('switch', { name: /AI is on/ })); // on, with no model and no key
    await user.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(/choose a model/);
  });
});
