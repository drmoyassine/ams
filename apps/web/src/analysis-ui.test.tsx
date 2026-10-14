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
import { createFakeAiModel, FIXTURE_GAPPY, FIXTURE_GUIDE, FIXTURE_HANDBOOK, fixtureResponder, gappyResponder, handlers, runJob, setAiModelForTests } from '@ams/core';
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
  // Step D: a source whose first extraction leaves gaps.
  const acc2 = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Invented Board', 'IB', 'programmatic') returning id`, [ids.inst]);
  const fw2 = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Teaching Standards', 'program') returning id`, [ids.inst, acc2]);
  ids.g = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2031') returning id`, [ids.inst, fw2]);
  const gd = await a.addDocument(ids.g, { title: FIXTURE_GAPPY.title, role: 'standards', authority: 'binding' });
  ids.gdoc = gd.id;
  for (const [i, text] of FIXTURE_GAPPY.pages.entries()) await a.setPage(gd.id, i + 1, text);
}, 30000);
afterEach(() => { cleanup(); setAiModelForTests(null); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('analysis in the version settings', () => {
  it('starts from "Analyse sources", shows progress while the worker runs, then the run with its counts and AI-marked requirements', async () => {
    setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('lead')} initialTab="docs" onOpenVersion={() => undefined} />));
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
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('viewer')} initialTab="docs" onOpenVersion={() => undefined} />));
    const ro = await screen.findByRole('region', { name: 'Analysis' });
    await within(ro).findByRole('list', { name: 'Recent analyses' });
    expect(within(ro).queryByRole('button', { name: 'Analyse sources' })).toBeNull();
  }, 60000);

  it('shows the recovery rounds in the strip, then the gaps, unresolved first, each linking to its requirement card or source page', async () => {
    await db.su.query(`insert into ai_setting (institution_id, model, enabled, max_recovery_rounds) values ($1, 'm', true, 1)`, [ids.inst]);
    try {
      setAiModelForTests(createFakeAiModel([gappyResponder().reply]).model);
      const user = userEvent.setup();
      render(wrap(<VersionPage versionId={ids.g!} api={apiFor('lead')} initialTab="docs" onOpenVersion={() => undefined} />));
      const panel = await screen.findByRole('region', { name: 'Analysis' });
      const start = await within(panel).findByRole('button', { name: 'Analyse sources' });
      await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false)); // once the sources are listed
      await user.click(start);
      await within(panel).findByRole('status', { name: 'Analysis progress' });
      // read, survey, structure, extract, gaps: the first round's three questions are next.
      for (let i = 0; i < 5; i++) await runJob(pool, 'analyse', queued.shift(), handlers, { store, queue });
      await waitFor(() => expect(within(panel).getByRole('status', { name: 'Analysis progress' }).textContent).toMatch(/^Asking about the gaps · round 1 of 1 · 0\/3 questions · 6 items so far/), { timeout: 15000 });
      while (queued.length) await runJob(pool, 'analyse', queued.shift(), handlers, { store, queue });

      const gaps = await within(panel).findByRole('region', { name: 'Gaps' }, { timeout: 15000 });
      expect(gaps.textContent).toContain('1 to look at · Recovery used all its rounds.');
      // Only what needs a person is listed at first: 2.4's quote is still not found.
      let rows = within(gaps).getAllByTestId('gap');
      expect(rows.map((r) => r.textContent)).toEqual([`UnresolvedQuote not found2.4${FIXTURE_GAPPY.title}, page 4its quote was not found on the page`]);
      await user.click(within(gaps).getByRole('button', { name: 'Show all 3 gaps' }));
      rows = within(gaps).getAllByTestId('gap');
      expect(rows.map((r) => r.textContent?.split(FIXTURE_GAPPY.title)[0])).toEqual(['UnresolvedQuote not found2.4', 'Confirmed absentPossibly missing2.5', 'RecoveredPossibly missing2.3']);
      expect(rows[1]!.textContent).toContain('The numbering goes from 2.4 to 2.6; there is no 2.5.');
      expect((await within(panel).findByRole('list', { name: 'Recent analyses' })).textContent).toContain('1 recovery round · 1 gap recovered · 1 unresolved');

      // The page link opens the source on that page.
      await user.click(within(rows[0]!).getByRole('link', { name: `${FIXTURE_GAPPY.title}, page 4` }));
      const source = await screen.findByRole('region', { name: FIXTURE_GAPPY.title });
      await waitFor(() => expect(within(source).getByRole('tab', { name: '4' }).getAttribute('aria-selected')).toBe('true'));
      // The code links to the requirement card, opened on the Requirements tab.
      await user.click(within(rows[0]!).getByRole('link', { name: '2.4' }));
      const card = await screen.findByRole('region', { name: 'Criterion 2.4' });
      expect(card.id).toMatch(/^requirement-/);
      expect(await within(card).findByTestId('requirement-detail')).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'Requirements' }).getAttribute('aria-selected')).toBe('true');
      // 2.3, which the first extraction missed, is in the draft.
      expect(await screen.findByRole('region', { name: 'Criterion 2.3' })).toBeTruthy();
    } finally {
      await db.su.query(`delete from ai_setting where institution_id = $1`, [ids.inst]);
    }
  }, 60000);

  it('says where a run stands and what it found, in words, never as a score', () => {
    const base = { id: 'r', frameworkVersionId: 'v', model: null, promptVersions: {}, error: null, startedBy: null, startedAt: null, finishedAt: null, createdAt: '', report: {} };
    expect(progressText({ ...base, status: 'running', stage: 'survey', progress: { docsTotal: 2, docsDone: 1 }, usage: { inputTokens: 1000, outputTokens: 234, costUsd: 0.0312, calls: 2 } }))
      .toBe('Looking at each document · document 2 of 2 · 1,234 tokens, $0.03');
    expect(statsText(undefined)).toBe('');
    expect(statsText({ pagesRead: 1, requirementsByLevel: { Standard: 1 }, requirements: 1, notes: 0, quoteVerified: 1, quoteVerifiedShare: 1, unverified: 0, orphans: 0, lowConfidence: 0, added: 1, updated: 0, keptHumanEdits: 2 }))
      .toBe('1 requirement (1 Standard) · 0 notes · quotes found in the source: 100% · 2 of your edits kept');
    expect(statsText({ pagesRead: 1, requirementsByLevel: {}, requirements: 0, notes: 0, quoteVerified: 0, quoteVerifiedShare: 0, unverified: 0, orphans: 0, lowConfidence: 0, added: 0, updated: 0, keptHumanEdits: 0,
      recoveryRounds: 2, gapsRecovered: 3, gapsUnresolved: 1, conflicts: 1, uncoveredPages: 2, dismissedSkipped: 4 }))
      .toBe('0 requirements · 0 notes · quotes found in the source: 0% · 2 recovery rounds · 3 gaps recovered · 1 unresolved · 1 conflict · 2 pages not covered · 4 items you deleted were not re-added');
    expect(progressText({ ...base, status: 'running', stage: 'recover', progress: { round: 2, maxRounds: 2, tasksTotal: 3, tasksDone: 1, windowsTotal: 4, windowsDone: 4, items: 12 }, usage: { inputTokens: 10, outputTokens: 5, costUsd: null, calls: 1 } }))
      .toBe('Asking about the gaps · round 2 of 2 · 1/3 questions · 12 items so far · 15 tokens');
  });
});
