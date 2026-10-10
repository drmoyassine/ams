// @vitest-environment jsdom
// Settings -> AI against the real API with a fake model: admin only, write-only key, spend limits, embeddings, test connection.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '@ams/api';
import { createFakeAiModel, createFakeEmbedder, setAiModelForTests, setEmbedderForTests } from '@ams/core';
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

const openTab = async (user: ReturnType<typeof userEvent.setup>, name: string) => { await user.click(await screen.findByRole('tab', { name })); };

describe('AI settings page', () => {
  it('tells a non-administrator that it is for administrators', async () => {
    render(wrap(<AiSettingsPage api={apiFor('lead')} />));
    expect(await screen.findByText(/Only an administrator/)).toBeTruthy();
    expect(screen.queryByLabelText('API key')).toBeNull();
  });

  it('shows the provider as plain text, not a dropdown that cannot open', async () => {
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    expect((await screen.findByLabelText('Provider')).tagName).not.toBe('SELECT');
  });

  it('saves the connection with a write-only key and shows only that it is set', { timeout: 20000 }, async () => {
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    const keyInput = await screen.findByLabelText('API key');
    expect(keyInput.getAttribute('type')).toBe('password');
    expect(screen.getByRole('switch', { name: /AI is on/ })).toBeTruthy();
    await user.type(screen.getByLabelText('Model'), 'some-model');
    await user.type(keyInput, KEY);
    await user.click(screen.getByRole('switch', { name: /AI is on/ }));
    await openTab(user, 'Limits');
    await user.type(screen.getByLabelText('Max tokens per run'), '200000');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect((screen.getByLabelText('Max tokens per run') as HTMLInputElement).value).toBe('200000'); // still on the Limits tab after saving
    await openTab(user, 'Connection');
    await waitFor(() => expect((screen.getByLabelText('API key') as HTMLInputElement).placeholder).toContain('ending in 4321'));
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain(KEY);
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('some-model');
    expect((screen.getByRole('switch', { name: /AI is on/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('sets the recovery rounds next to the spend limits: 2 by default, 0 to 5', async () => {
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await openTab(user, 'Limits');
    const rounds = await screen.findByLabelText('Recovery rounds') as HTMLInputElement;
    expect(rounds.value).toBe('2');
    await user.clear(rounds);
    await user.type(rounds, '4');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect((await db.su.query(`select max_recovery_rounds from ai_setting where institution_id = $1`, [ids.inst])).rows[0].max_recovery_rounds).toBe(4);
    cleanup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await openTab(user, 'Limits');
    const again = await screen.findByLabelText('Recovery rounds') as HTMLInputElement;
    await waitFor(() => expect(again.value).toBe('4'));
    // The field itself keeps to 0..5 (the API refuses anything else too).
    expect([again.min, again.max, again.step]).toEqual(['0', '5', '1']);
  });

  it('shows the server\'s reason when a limit cannot be saved', async () => {
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await openTab(user, 'Limits');
    await user.type(await screen.findByLabelText('Max cost per run (USD)'), '5');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/price per million/);
  });

  it('saves the embeddings section, with its own write-only key', async () => {
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await openTab(user, 'Embeddings');
    await user.click(await screen.findByRole('switch', { name: /Embeddings are on/ }));
    await user.type(screen.getByLabelText('Base URL'), 'http://embed.local:8080/v1');
    await user.type(screen.getByLabelText('Embedding model'), 'multilingual-model');
    await user.type(screen.getByLabelText('Vector dimension'), '32');
    await user.type(screen.getByLabelText('Embeddings API key'), 'embed-key-7788');
    expect(screen.getByText(/multilingual model/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText('Embeddings API key') as HTMLInputElement).placeholder).toContain('ending in 7788'));
    expect(document.body.innerHTML).not.toContain('embed-key-7788');
  });

  it('tests the connection and shows the result for both the model and the embeddings', async () => {
    const user = userEvent.setup();
    setAiModelForTests(createFakeAiModel([{ ok: true }]).model);
    setEmbedderForTests(createFakeEmbedder());
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    const result = await screen.findByTestId('ai-test-result');
    expect(within(result).getByText(/Model: connected \(some-model\)/)).toBeTruthy();
    expect(within(result).getByText(/Embeddings: connected, 32 values per text/)).toBeTruthy();
  });

  it('shows why the test failed, without the key', async () => {
    const user = userEvent.setup();
    setAiModelForTests(createFakeAiModel([new Error(`401 rejected ${KEY}`)]).model);
    setEmbedderForTests(createFakeEmbedder());
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    const result = await screen.findByTestId('ai-test-result');
    expect(within(result).getByText(/failed\. .*rejected/)).toBeTruthy();
    expect(result.textContent).not.toContain(KEY);
  });

  it('removes a saved key when asked', async () => {
    const user = userEvent.setup();
    render(wrap(<AiSettingsPage api={apiFor('admin')} />));
    await user.click(await screen.findByRole('switch', { name: /AI is on/ })); // switch off first: AI cannot be on without a key
    await user.click(screen.getAllByRole('checkbox', { name: /Remove the saved key/ })[0]!);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('API key-status').textContent).toBe('No key saved.'));
  });
});
