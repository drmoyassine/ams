// @vitest-environment jsdom
// Step E in the Mappings tab and the Analysis panel, against the real API and database; the worker runs with a fake
// model (no network). Suggestions are proposals: a person accepts, rejects or dismisses them.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createFakeAiModel, FIXTURE_GUIDE, FIXTURE_HANDBOOK, fixtureResponder, handlers, mappingResponder, runJob, setAiModelForTests } from '@ams/core';
import type { AnalysisMapping, JobEnvelope } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { frameworkApi, type FrameworkApi } from './lib/framework-api';
import { VersionPage } from './pages/version';
import { mappingText, progressText } from './pages/version/analysis-panel';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const queued: JobEnvelope[] = [];
const queue = { send: async (_t: string, e: JobEnvelope) => { queued.push(e); } };
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
type Who = 'admin' | 'lead' | 'viewer';
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
const drain = async () => { while (queued.length) await runJob(pool, 'analyse', queued.shift(), handlers, { store, queue }); };

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('websuggest');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store, queue,
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [who, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']] as const) {
    ids[who] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, `${who}@x.org`]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[who], role]);
  }
  // The institution's quality framework, published.
  const admin = apiFor('admin');
  const { versions } = await admin.setUpQualityFramework({});
  const qv = versions[0]!.id;
  for (const [code, title, description] of [['1', 'Mission and governance', ''], ['1.1', 'Mission, vision and values', 'The institution states its mission.'], ['1.2', 'Integrity and ethics', ''], ['2', 'Teaching and learning', '']] as const) {
    await admin.addQualityItem(qv, { code, title, ...(description ? { description } : {}) });
  }
  await admin.publishQuality(qv);
  // An external standard with sources, analysed by the (fake) worker.
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Invented Council', 'IC', 'institutional') returning id`, [ids.inst]);
  const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Institutional Standards', 'institution') returning id`, [ids.inst, acc]);
  ids.v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2030') returning id`, [ids.inst, fw]);
  const a = apiFor('lead');
  const hb = await a.addDocument(ids.v, { title: FIXTURE_HANDBOOK.title, role: 'standards', authority: 'binding' });
  for (const [i, text] of FIXTURE_HANDBOOK.pages.entries()) await a.setPage(hb.id, i + 1, text);
  const g = await a.addDocument(ids.v, { title: FIXTURE_GUIDE.title, authority: 'interpretive', language: 'ar' });
  await a.setPage(g.id, 1, FIXTURE_GUIDE.pages[0]!);
  setAiModelForTests(createFakeAiModel([mappingResponder(fixtureResponder(), {
    fit: { '1': { '1': 'partly_covers' }, '1.1': { '1.1': 'covers' }, '1.2': { '1.2': 'covers', '1': 'related' } },
    newItems: (codes) => (codes.includes('1.1.1') ? [
      { parent_code: '1', code: '1.3', title: 'Published mission statement', description: 'The institution makes its mission statement public.', reason: 'No item asks for publication.', covers: [{ requirement: '1.1.1', relation: 'covers', reason: null }] },
      { parent_code: null, code: '3', title: 'Graduate follow-up', description: 'The institution follows up on its graduates.', reason: 'Nothing about graduates.', covers: [{ requirement: '3.9.1', relation: 'partly_covers', reason: null }] },
    ] : []),
  })]).model);
  await a.startAnalysis(ids.v);
  await drain();
  setAiModelForTests(null);
}, 90000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

describe('mapping texts (never a score)', () => {
  it('says what was suggested, how candidates were found, and why nothing was', () => {
    const base: AnalysisMapping = {
      skipped: null, iqfVersionId: null, retrieval: 'lexical only', embeddings: { used: false, embedded: 0, reused: 0, note: null }, requirements: 7, judged: 7, skippedDecided: 0,
      mapped: 4, noSuggestion: 3, links: { covers: 1, partly_covers: 2, related: 2, kept: 0 }, newItems: 2,
      shortlist: { requirements: 7, candidates: 40, perRequirement: 5.7, padded: 1, size: 8 }, judgedCodes: [], noSuggestionCodes: [], unplacedCodes: [], stopped: null,
    };
    expect(mappingText(base)).toBe('Suggested links: 4 requirements (1 covers, 2 partly covers, 2 related) · 3 without a suggestion · 2 suggested new IQF items · candidates found by words only');
    expect(mappingText({ ...base, retrieval: 'hybrid', stopped: 'budget', skippedDecided: 2 })).toContain('candidates found by words and meaning · stopped at the spend limit');
    expect(mappingText({ ...base, skipped: 'There is no quality framework to map onto yet: set it up in Settings.' })).toBe('No links suggested: there is no quality framework to map onto yet: set it up in Settings.');
    expect(mappingText(base)).not.toMatch(/%|score|compliant|\bmet\b/i);
    expect(progressText({ status: 'running', stage: 'map', progress: { mapTotal: 12, mapDone: 10 }, usage: { inputTokens: 0, outputTokens: 0, costUsd: null, calls: 0 } } as never)).toBe('Suggesting links to your quality framework · 10/12 requirements · 0 tokens');
  });
});

const openMappings = async (who: Who) => {
  const user = userEvent.setup();
  render(wrap(<VersionPage versionId={ids.v!} api={apiFor(who)} onOpenVersion={() => undefined} />));
  await user.click(await screen.findByRole('tab', { name: 'Mappings' }));
  return { user, panel: await screen.findByRole('region', { name: 'Suggestions from the analysis' }) };
};
const filterButton = (panel: HTMLElement, label: string) => within(panel).getByRole('button', { name: new RegExp(`^${label} \\(`) });

describe('suggestions in the Mappings tab', () => {
  it('groups suggested links by requirement with the relation and the model\'s reason; Arabic and English text keep their own direction', async () => {
    const { panel } = await openMappings('lead');
    expect(within(panel).getByRole('heading', { name: 'Suggested links' })).toBeTruthy();
    expect(filterButton(panel, 'Suggested').textContent).toContain('(4)');
    expect(filterButton(panel, 'Suggested').getAttribute('aria-pressed')).toBe('true');
    expect(filterButton(panel, 'Accepted').textContent).toContain('(0)');
    const groups = within(panel).getAllByTestId('suggestion-group');
    expect(groups.map((g) => within(g).getByRole('heading').textContent)).toEqual(['1 Mission and Purposes', '1.1 Mission statement', '1.2 Integrity']);
    const integrity = groups[2]!;
    const links = within(integrity).getAllByTestId('suggested-link');
    expect(links.map((l) => l.textContent)).toEqual([
      expect.stringContaining('Related1 Mission and governance'), expect.stringContaining('Covers1.2 Integrity and ethics'),
    ]);
    expect(links[1]!.textContent).toContain('is asked for by "Integrity and ethics"');
    expect(within(links[1]!).getByTestId('ai-marker')).toBeTruthy();
    // Institutional text is shown with dir="auto"; nothing reads as a score or an outcome.
    expect(links[1]!.querySelectorAll('[dir="auto"]').length).toBeGreaterThan(0);
    expect(panel.textContent).not.toMatch(/%|score|compliant|\bmet\b|confidence/i);
  });

  it('accepts every suggested "covers" link of the view only after a confirmation, and leaves the others as suggestions', async () => {
    const { user, panel } = await openMappings('lead');
    await user.click(within(panel).getByRole('button', { name: 'Accept all that cover (2)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept 2 suggested links?' });
    expect(dialog.textContent).toContain('Links that only partly cover or are related stay as suggestions');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(filterButton(panel, 'Suggested').textContent).toContain('(4)'); // nothing happened

    await user.click(within(panel).getByRole('button', { name: 'Accept all that cover (2)' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Accept 2 links' }));
    expect((await within(panel).findByRole('status')).textContent).toBe('Accepted 2 links.');
    await waitFor(() => expect(filterButton(panel, 'Suggested').textContent).toContain('(2)'));
    expect(filterButton(panel, 'Accepted').textContent).toContain('(2)');
    expect(within(panel).queryByRole('button', { name: /Accept all that cover/ })).toBeNull(); // none left that cover
    await user.click(filterButton(panel, 'Accepted'));
    expect(within(panel).getAllByTestId('suggested-link').map((l) => l.textContent)).toEqual([
      expect.stringContaining('Covers1.1 Mission, vision and values'), expect.stringContaining('Covers1.2 Integrity and ethics'),
    ]);
    expect((await apiFor('lead').mappings(ids.v!)).mappings.filter((m) => m.reviewStatus === 'approved')).toHaveLength(2);
  });

  it('accepts or rejects one link at a time, and a rejected one can be reconsidered', async () => {
    const { user, panel } = await openMappings('lead');
    await user.click(within(panel).getByRole('button', { name: 'Reject link of 1 to 1' }));
    await waitFor(() => expect(filterButton(panel, 'Rejected').textContent).toContain('(1)'));
    await user.click(filterButton(panel, 'Rejected'));
    expect(within(panel).getByTestId('suggested-link').textContent).toContain('Partly covers1 Mission and governance');
    expect(within(panel).queryByRole('button', { name: 'Reject link of 1 to 1' })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Accept link of 1 to 1' }));
    await waitFor(() => expect(filterButton(panel, 'Accepted').textContent).toContain('(3)'));
  });

  it('shows the suggested new IQF items; without an IQF draft they cannot be accepted yet and the way forward is said', async () => {
    const { user, panel } = await openMappings('lead');
    expect(await within(panel).findByRole('heading', { name: 'Suggested new IQF items' })).toBeTruthy();
    const items = within(panel).getAllByTestId('suggested-item');
    expect(items.map((i) => i.getAttribute('aria-label'))).toEqual(['Suggested new IQF item 1.3', 'Suggested new IQF item 3']);
    expect(items[0]!.textContent).toContain('AI-drafted');
    expect(items[0]!.textContent).toContain('Published mission statement');
    expect(items[0]!.textContent).toContain('Under 1 Mission and governance');
    expect(items[0]!.textContent).toContain('1.1.1 (covers)');
    expect(items[1]!.textContent).toContain('At the top level');
    expect(within(panel).getByRole('note').textContent).toMatch(/no draft version.*Start a new version of the IQF/);
    expect((within(panel).getByRole('button', { name: 'Accept suggested item 1.3' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(panel).getByRole('button', { name: 'Dismiss suggested item 3' }));
    await waitFor(() => expect(within(panel).queryByRole('region', { name: 'Suggested new IQF item 3' })).toBeNull());
    expect(panel.textContent).toContain('0 accepted, 1 dismissed. A later analysis does not suggest them again.');
  });

  it('accepts a suggested item with the person\'s edits once the IQF has a draft: it is added to the draft and its links accepted', async () => {
    await apiFor('admin').newQualityVersion();
    const { user, panel } = await openMappings('lead');
    expect(within(panel).queryByRole('note')).toBeNull();
    await user.click(await within(panel).findByRole('button', { name: 'Accept suggested item 1.3' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept suggested new IQF item' });
    expect((within(dialog).getByLabelText('Code') as HTMLInputElement).value).toBe('1.3');
    expect((within(dialog).getByLabelText('Goes under') as HTMLSelectElement).value).toBe('1');
    // A code the draft already uses is refused with the reason; the dialog stays so the edit is not lost.
    await user.clear(within(dialog).getByLabelText('Code'));
    await user.type(within(dialog).getByLabelText('Code'), '1.1');
    await user.clear(within(dialog).getByLabelText('Title'));
    await user.type(within(dialog).getByLabelText('Title'), 'Public mission statement');
    await user.click(within(dialog).getByRole('button', { name: 'Accept and add to the IQF draft' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/code 1\.1 is already used/);
    await user.clear(within(dialog).getByLabelText('Code'));
    await user.type(within(dialog).getByLabelText('Code'), '1.3');
    await user.click(within(dialog).getByRole('button', { name: 'Accept and add to the IQF draft' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await within(panel).findByRole('status')).textContent).toBe('Added to the IQF draft.');
    await waitFor(() => expect(within(panel).queryByRole('region', { name: 'Suggested new IQF item 1.3' })).toBeNull());
    expect(panel.textContent).toContain('1 accepted, 1 dismissed');

    const { versions } = await apiFor('admin').qualityFramework();
    const draft = versions[versions.length - 1]!;
    const reqs = await apiFor('admin').requirements(draft.id);
    expect(reqs.find((r) => r.code === '1.3')).toMatchObject({ title: 'Public mission statement', origin: 'ai', reviewStatus: 'pending' });
    const link = (await apiFor('lead').mappings(ids.v!)).mappings.find((m) => m.externalCode === '1.1.1');
    expect(link).toMatchObject({ internalCode: '1.3', reviewStatus: 'approved', origin: 'ai', relation: 'covers' });
  });

  it('shows a viewer the suggestions without any control to decide them', async () => {
    const { panel } = await openMappings('viewer');
    expect(within(panel).getAllByTestId('suggested-link').length).toBeGreaterThan(0);
    expect(within(panel).queryByRole('button', { name: /^(Accept|Reject|Dismiss) (link|suggested|all)/ })).toBeNull();
  });
});

describe('the analysis panel after step E', () => {
  it('lists what the run suggested, in counts and words', async () => {
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('lead')} initialTab="settings" initialSection="sources" onOpenVersion={() => undefined} />));
    const panel = await screen.findByRole('region', { name: 'Analysis' });
    const summary = await within(panel).findByTestId('mapping-summary');
    expect(summary.textContent).toBe('Suggested links: 3 requirements (2 covers, 1 partly covers, 1 related) · 4 without a suggestion · 2 suggested new IQF items · candidates found by words only');
  });
});
