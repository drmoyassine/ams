// @vitest-environment jsdom
// Compiler step H in the UI: the Settings tabs mark what the analysis found ("Found by the analysis · page N", with the source
// quote), keep editing as before and say when a person has edited a part; the readiness list names the documents that can
// supply configuration; the progress strip speaks of the configuration stages. Real API and database, a fake model.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { configResponder, createFakeAiModel, FIXTURE_POLICY, FIXTURE_TEMPLATE_DOC, handlers, runJob, setAiModelForTests } from '@ams/core';
import type { AnalysisRun, JobEnvelope } from '@ams/shared';
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
const fetchAs = (who: 'lead' | 'viewer') => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apiFor = (who: 'lead' | 'viewer'): FrameworkApi => frameworkApi(createApi(fetchAs(who)), fetchAs(who));
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const drain = async () => { while (queued.length) await runJob(pool, 'analyse', queued.shift(), handlers, { store, queue }); };

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('webconfig');
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
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Invented Authority', 'IA', 'institutional') returning id`, [ids.inst]);
  const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Process Rules', 'institution') returning id`, [ids.inst, acc]);
  ids.v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2032') returning id`, [ids.inst, fw]);
  const a = apiFor('lead');
  for (const d of [{ ...FIXTURE_POLICY, role: 'policy_procedure' }, { ...FIXTURE_TEMPLATE_DOC, role: 'report_template' }]) {
    const doc = await a.addDocument(ids.v, { title: d.title, role: d.role as 'policy_procedure', authority: 'interpretive' });
    for (const [i, text] of d.pages.entries()) await a.setPage(doc.id, i + 1, text);
  }
  setAiModelForTests(createFakeAiModel([configResponder().reply]).model);
  ids.run = (await a.startAnalysis(ids.v)).id;
  await drain();
  setAiModelForTests(null);
}, 60000);
afterEach(() => { cleanup(); setAiModelForTests(null); });
// Requests of the last page may still be on their way when the tests end; let them finish before the pool closes.
afterAll(async () => { cleanup(); await new Promise((r) => setTimeout(r, 500)); await pool.end(); await db.close(); });

describe('Settings: what the analysis found in the configuration', () => {
  it('marks the lifecycle and vocabularies with their pages and source quotes, and keeps editing as before', async () => {
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('lead')} initialTab="settings" initialSection="lifecycle" onOpenVersion={() => undefined} />));
    const marks = await screen.findAllByTestId('found-by');
    // Lifecycle, decision, finding and response vocabularies were written; the rating method was not (kept out).
    expect(marks.map((m) => m.getAttribute('aria-label'))).toEqual([
      'Lifecycle template: where the analysis found it', 'Decision vocabulary: where the analysis found it', 'Finding vocabulary: where the analysis found it', 'Response vocabulary: where the analysis found it',
    ]);
    expect(marks[1]!.textContent).toContain('Found by the analysis · 2 items, with their pages');
    // The list under each marker carries the page and the quote.
    await user.click(within(marks[1]!).getByText(/Found by the analysis/));
    const items = within(marks[1]!).getAllByTestId('found-by-item').map((i) => i.textContent);
    const full = items.find((i) => i?.startsWith('full_accreditation'));
    expect(full).toContain(`full_accreditation · ${FIXTURE_POLICY.title}, page 4`);
    expect(full).toContain('Full Accreditation is granted for a term of six years');
    // The lifecycle's milestones are listed by key with their pages.
    await user.click(within(marks[0]!).getByText(/Found by the analysis/));
    expect(within(marks[0]!).getAllByTestId('found-by-item').map((i) => i.textContent).join('\n')).toContain('self_study_report');
    expect(within(marks[0]!).getAllByTestId('found-by-item').map((i) => i.textContent).join('\n')).toMatch(/page 2/);
    // Nothing says "edited" yet; the JSON editors still work and still show the document's own words and the reviewer's flag.
    expect(marks.every((m) => !/You have edited this/.test(m.textContent ?? ''))).toBe(true);
    const lifecycle = screen.getByLabelText('Lifecycle template') as HTMLTextAreaElement;
    expect(lifecycle.value).toContain('"due_pending": true');
    expect(lifecycle.value).toContain('no later than July 1 of the calendar year of the visit');

    // A person edits the decision vocabulary: the marker keeps its pages and now says so.
    const area = screen.getByLabelText('Decision vocabulary');
    await user.clear(area);
    await user.click(area);
    await user.paste(JSON.stringify([{ code: 'ok', label: 'Accredited', outcome: 'accredited' }]));
    await user.click(screen.getByRole('button', { name: 'Save Decision vocabulary' }));
    await waitFor(() => expect(screen.getAllByTestId('found-by')[1]!.textContent).toContain('You have edited this; a new analysis leaves it as it is.'));
    cleanup();

    // A new analysis leaves it alone (the database refuses the worker otherwise), and the report says so.
    setAiModelForTests(createFakeAiModel([configResponder().reply]).model);
    const a = apiFor('lead');
    const run2 = await a.startAnalysis(ids.v!);
    await drain();
    const v = await a.version(ids.v!);
    expect(v.decisionVocab).toEqual([{ code: 'ok', label: 'Accredited', outcome: 'accredited' }]);
    const report = await a.analysisReport(run2.id);
    expect(report.configuration.sections.find((s) => s.section === 'decision_vocab')).toMatchObject({ state: 'kept_your_edits', editedSince: true });
  }, 60000);

  it('marks a template the analysis wrote with its page and its sections\' pages, and shows when a person has edited it', async () => {
    const user = userEvent.setup();
    const a = apiFor('lead');
    render(wrap(<VersionPage versionId={ids.v!} api={a} initialTab="settings" initialSection="templates" onOpenVersion={() => undefined} />));
    await user.click(await screen.findByRole('button', { name: /Self-Study Report Form/ }));
    const mark = await screen.findByTestId('found-by');
    expect(mark.textContent).toContain('Found by the analysis · page 1, and 6 sections with their pages');
    await user.click(within(mark).getByText(/Found by the analysis/));
    const lines = within(mark).getAllByTestId('found-by-item').map((i) => i.textContent);
    expect(lines.some((l) => l?.includes('section B.1') && l.includes('page 1'))).toBe(true);
    expect(lines.some((l) => l?.includes('section S7') && l.includes('page 3'))).toBe(true);
    expect(mark.textContent).not.toContain('You have edited this');
    // Editing goes on as before; after a save the template is marked as the person's.
    const area = screen.getByLabelText('Template') as HTMLTextAreaElement;
    const value = JSON.parse(area.value) as { name: string };
    value.name = 'Our self-study form';
    await user.clear(area);
    await user.click(area);
    await user.paste(JSON.stringify(value));
    await user.click(screen.getByRole('button', { name: 'Save Template' }));
    await waitFor(() => expect(screen.getByTestId('found-by').textContent).toContain('You have edited this; a new analysis leaves it as it is.'));
  }, 60000);

  it('names the documents that can supply configuration in the readiness list, and a viewer sees the marks but no editors', async () => {
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('lead')} initialTab="settings" initialSection="sources" onOpenVersion={() => undefined} />));
    const panel = await screen.findByRole('region', { name: 'Analysis' });
    await user.click(await within(panel).findByText(/Before you start/));
    const checks = within(panel).getAllByTestId('preflight-check').map((c) => c.textContent ?? '');
    expect(checks.some((t) => /Documents that can supply configuration: 2 /.test(t))).toBe(true);
    cleanup();
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('viewer')} initialTab="settings" initialSection="lifecycle" onOpenVersion={() => undefined} />));
    expect((await screen.findAllByTestId('found-by')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Save Lifecycle template' })).toBeNull();
  }, 60000);
});

describe('the progress strip and the counts speak of the configuration', () => {
  const base = { id: 'r', frameworkVersionId: 'v', status: 'running', model: null, promptVersions: {}, usage: { inputTokens: 100, outputTokens: 50, costUsd: null, calls: 3 }, error: null, startedBy: null, startedAt: null, finishedAt: null, createdAt: '2026-10-10T09:00:00.000Z', report: {} };
  it('describes each configuration stage with its own counts', () => {
    const run = (stage: AnalysisRun['stage'], progress: AnalysisRun['progress']) => ({ ...base, stage, progress }) as AnalysisRun;
    expect(progressText(run('config_survey', { configDocsTotal: 3, configDocsDone: 1 }))).toBe('Looking for the lifecycle, vocabularies and report templates · document 2 of 3 · 150 tokens');
    expect(progressText(run('config_extract', { configWindowsTotal: 5, configWindowsDone: 2, configItems: 11, windowsTotal: 9, windowsDone: 9, items: 40 }))).toBe('Reading the process and template documents · 2/5 windows · 11 configuration items so far · 150 tokens');
    expect(progressText(run('config_write', { configItems: 1 }))).toBe('Checking quotes and writing the configuration · 1 configuration item so far · 150 tokens');
    // The earlier stages are unchanged.
    expect(progressText(run('extract', { windowsTotal: 9, windowsDone: 4, items: 12 }))).toBe('Taking out requirements and notes · 4/9 windows · 12 items so far · 150 tokens');
  });
  it('adds what was written and kept out to the run\'s counts, as counts only', () => {
    const stats = { pagesRead: 1, requirementsByLevel: {}, requirements: 0, notes: 0, quoteVerified: 0, quoteVerifiedShare: 0, unverified: 0, orphans: 0, lowConfidence: 0, added: 0, updated: 0, keptHumanEdits: 0, configItems: 25, configWritten: 21, configFlagged: 4 };
    expect(statsText(stats)).toContain('21 configuration items written · 4 kept out as flagged');
    expect(statsText({ ...stats, configWritten: 1, configFlagged: 0 })).toContain('1 configuration item written');
    expect(statsText(stats)).not.toMatch(/compliant|\bmet\b|\bscore\b/i);
  });
});
