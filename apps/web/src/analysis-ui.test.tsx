// @vitest-environment jsdom
// Framework analysis in the version's Settings -> Sources, against the real API and database; the worker runs with a
// fake model (no network).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createFakeAiModel, FIXTURE_GUIDE, FIXTURE_HANDBOOK, fixtureResponder, handlers, runJob, setAiModelForTests } from '@ams/core';
import type { JobEnvelope } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { frameworkApi, type FrameworkApi } from './lib/framework-api';
import { VersionPage } from './pages/version';
import { progressText, statsText } from './pages/version/analysis-panel';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const queued: JobEnvelope[] = [];
const queue = { send: async (_t: string, e: JobEnvelope) => { queued.push(e); } };
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
type Who = 'lead' | 'viewer';
const fetchAs = (who: Who) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apiFor = (who: Who): FrameworkApi => frameworkApi(createApi(fetchAs(who)), fetchAs(who));
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('webanalysis');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store, queue,
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [who, role] of [['lead', 'lead'], ['viewer', 'viewer']] as const) {
    ids[who] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, `${who}@x.org`]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[who], role]);
  }
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Invented Council', 'IC', 'institutional') returning id`, [ids.inst]);
  const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Institutional Standards', 'institution') returning id`, [ids.inst, acc]);
  ids.v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2030') returning id`, [ids.inst, fw]);
  const a = apiFor('lead');
  const hb = await a.addDocument(ids.v, { title: FIXTURE_HANDBOOK.title, role: 'standards', authority: 'binding' });
  for (const [i, text] of FIXTURE_HANDBOOK.pages.entries()) await a.setPage(hb.id, i + 1, text);
  const g = await a.addDocument(ids.v, { title: FIXTURE_GUIDE.title, authority: 'interpretive', language: 'ar' });
  await a.setPage(g.id, 1, FIXTURE_GUIDE.pages[0]!);
}, 30000);
afterEach(() => { cleanup(); setAiModelForTests(null); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('analysis in the version settings', () => {
  it('starts from "Analyse sources", shows progress while the worker runs, then the run with its counts and AI-marked requirements', async () => {
    setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('lead')} initialTab="settings" initialSection="sources" onOpenVersion={() => undefined} />));
    const panel = await screen.findByRole('region', { name: 'Analysis' });
    expect(await within(panel).findByText('Not analysed yet.')).toBeTruthy();
    // The guide's role was left open; the analysis decides it.
    expect((await screen.findByRole('region', { name: FIXTURE_GUIDE.title })).textContent).toContain('Role not set');

    await user.click(within(panel).getByRole('button', { name: 'Analyse sources' }));
    expect((await within(panel).findByRole('status', { name: 'Analysis progress' })).textContent).toMatch(/Waiting for the worker/);
    expect(within(panel).getByRole('button', { name: 'Stop' })).toBeTruthy();
    // A few steps in: the strip follows the run.
    for (let i = 0; i < 6; i++) await runJob(pool, 'analyse', queued.shift(), handlers, { store, queue });
    await waitFor(() => expect(within(panel).getByRole('status', { name: 'Analysis progress' }).textContent).toMatch(/Taking out requirements and notes · 1\/3 windows · 6 items so far · 60 tokens/), { timeout: 15000 });
    while (queued.length) await runJob(pool, 'analyse', queued.shift(), handlers, { store, queue });
    const runs = await within(panel).findByRole('list', { name: 'Recent analyses' }, { timeout: 15000 });
    await waitFor(() => expect(runs.textContent).toContain('Finished'), { timeout: 15000 });
    expect(runs.textContent).toContain('7 requirements (1 Standard, 3 Criterion, 3 Indicator) · 3 notes · quotes found in the source: 80% · 1 without a parent · 1 low confidence');
    expect(within(panel).queryByRole('status', { name: 'Analysis progress' })).toBeNull();
    await waitFor(async () => expect((await screen.findByRole('region', { name: FIXTURE_GUIDE.title })).textContent).toContain('Guidance (AI)'));
    cleanup();

    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('viewer')} onOpenVersion={() => undefined} />));
    const records = await screen.findByRole('region', { name: 'Criterion 1.9' });
    expect(within(records).getByTestId('ai-marker').textContent).toBe('AI');
    expect(within(records).getByTestId('quote-not-found').textContent).toBe('Quote not found in source');
    const mission = await screen.findByRole('region', { name: 'Criterion 1.1' });
    expect(within(mission).queryByTestId('quote-not-found')).toBeNull();
    await userEvent.setup().click(within(mission).getByRole('button', { name: /^Criterion 1\.1/ }));
    expect((await within(mission).findByTestId('requirement-source')).textContent).toContain('(page 3)');
    // The Arabic note keeps its own direction.
    const note = (await within(mission).findAllByTestId('note'))[0]!;
    expect(note.querySelector('[dir="auto"]')?.textContent).toContain('المؤسسة');
    expect(within(note).getByTestId('ai-marker')).toBeTruthy();
    // A viewer sees runs but cannot start one.
    cleanup();
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('viewer')} initialTab="settings" initialSection="sources" onOpenVersion={() => undefined} />));
    const ro = await screen.findByRole('region', { name: 'Analysis' });
    await within(ro).findByRole('list', { name: 'Recent analyses' });
    expect(within(ro).queryByRole('button', { name: 'Analyse sources' })).toBeNull();
  }, 60000);

  it('says where a run stands and what it found, in words, never as a score', () => {
    const base = { id: 'r', frameworkVersionId: 'v', model: null, promptVersions: {}, error: null, startedBy: null, startedAt: null, finishedAt: null, createdAt: '', report: {} };
    expect(progressText({ ...base, status: 'running', stage: 'survey', progress: { docsTotal: 2, docsDone: 1 }, usage: { inputTokens: 1000, outputTokens: 234, costUsd: 0.0312, calls: 2 } }))
      .toBe('Looking at each document · document 2 of 2 · 1,234 tokens, $0.03');
    expect(statsText(undefined)).toBe('');
    expect(statsText({ pagesRead: 1, requirementsByLevel: { Standard: 1 }, requirements: 1, notes: 0, quoteVerified: 1, quoteVerifiedShare: 1, unverified: 0, orphans: 0, lowConfidence: 0, added: 1, updated: 0, keptHumanEdits: 2 }))
      .toBe('1 requirement (1 Standard) · 0 notes · quotes found in the source: 100% · 2 of your edits kept');
  });
});
