// @vitest-environment jsdom
// The Report tab (runs list, report cards, deep link, Markdown export), the standard card's analysis line and the
// "Analyse sources" readiness checks. Part of it runs against the real API and database with a fake model; the cards'
// content (conflicts, links to the Mappings tab) is checked with a canned report.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createFakeAiModel, FIXTURE_GUIDE, FIXTURE_HANDBOOK, fixtureResponder, handlers, runJob, setAiModelForTests } from '@ams/core';
import type { AnalysisReport, JobEnvelope } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { AnalysisLine } from './components/standard-card';
import { createApi } from './lib/api';
import { frameworkApi, type FrameworkApi, type FrameworkListItem } from './lib/framework-api';
import { VersionPage } from './pages/version';
import { ReportTab, type ReportNav } from './pages/version/report-tab';

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
const drain = async () => { while (queued.length) await runJob(pool, 'analyse', queued.shift(), handlers, { store, queue }); };

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('webreport');
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
  ids.hb = hb.id;
  for (const [i, text] of FIXTURE_HANDBOOK.pages.entries()) await a.setPage(hb.id, i + 1, text);
  const g = await a.addDocument(ids.v, { title: FIXTURE_GUIDE.title, authority: 'interpretive', language: 'ar' });
  await a.setPage(g.id, 1, FIXTURE_GUIDE.pages[0]!);
  // Two finished runs, the older one first.
  setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
  ids.run1 = (await a.startAnalysis(ids.v)).id;
  await drain();
  ids.run2 = (await a.startAnalysis(ids.v)).id;
  await drain();
  setAiModelForTests(null);
}, 60000);
afterEach(() => { cleanup(); setAiModelForTests(null); vi.restoreAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => undefined); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('the Report tab', () => {
  it('is a tab of the version page that opens on the newest run, with the report in readable cards and links to the cards and source pages', async () => {
    const user = userEvent.setup();
    const where: unknown[] = [];
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('viewer')} initialTab="report" onOpenVersion={() => undefined} onLocation={(w) => where.push(w)} />));
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Requirements', 'Mappings', 'Report', 'Settings']);
    expect(screen.getByRole('tab', { name: 'Report' }).getAttribute('aria-selected')).toBe('true');
    const region = await screen.findByRole('region', { name: 'Analysis report' });
    expect(within(region).getByRole('heading', { level: 2, name: 'Analysis report' })).toBeTruthy();

    // The runs list: newest first, the newest selected, and the address follows.
    const runs = within(within(region).getByRole('navigation', { name: 'Analysis runs' })).getAllByRole('button');
    expect(runs).toHaveLength(2);
    expect(runs[0]!.getAttribute('aria-current')).toBe('true');
    expect(runs[0]!.textContent).toContain('Finished');
    expect(runs[0]!.textContent).toContain('7 requirements, 3 notes');
    await waitFor(() => expect(where).toContainEqual({ tab: 'report', run: ids.run2 }));

    // The sections, as cards with real headings.
    await within(region).findByTestId('report-summary');
    for (const h of ['Summary', 'Structure found', 'Requirements', 'Gaps and conflicts', 'Links to your quality framework', 'Configuration found', 'Before you publish']) {
      expect(within(region).getByRole('heading', { level: 3, name: h })).toBeTruthy();
    }
    // The fixture's guide holds no lifecycle, vocabulary or template: read, and the report says what it did not contain.
    const configCard = within(region).getByTestId('report-configuration');
    expect(within(configCard).getByTestId('config-document').textContent).toContain(`${FIXTURE_GUIDE.title}: nothing to take`);
    expect(within(configCard).getByRole('list', { name: 'Not found in the documents' }).textContent).toContain('No decision vocabulary was found in the documents.');
    const sources = within(region).getByTestId('report-sources');
    expect(within(sources).getAllByRole('row').map((r) => r.textContent)).toEqual([
      'DocumentRoleLanguagePagesFile textAI visionNot readable',
      `${FIXTURE_HANDBOOK.title}standardschosen by a personen9900`,
      `${FIXTURE_GUIDE.title}guidancedecided by the analysisar1100`,
    ]);
    expect(within(region).getByTestId('quotes-found').textContent).toBe('8 of 10 quotes found in the source (80%).');
    expect(within(region).getByTestId('report-structure').textContent).toContain('They were written to this version.');
    // Arabic keeps its own direction.
    expect(within(sources).getByText(FIXTURE_GUIDE.title).closest('[dir="auto"]')).toBeTruthy();
    // No score, no verdict.
    expect(region.textContent).not.toMatch(/compliant|\bmet\b|\bscore\b|readiness/i);

    // A requirement in the list opens its card on the Requirements tab.
    const notFound = within(region).getByRole('list', { name: 'Quote not found' });
    await user.click(within(notFound).getByRole('link', { name: '1.9' }));
    expect(await screen.findByRole('region', { name: 'Criterion 1.9' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Requirements' }).getAttribute('aria-selected')).toBe('true');
    expect(where).toContainEqual({ tab: 'requirements' });

    // A source page opens that source on that page.
    await user.click(screen.getByRole('tab', { name: 'Report' }));
    const list2 = await screen.findByRole('list', { name: 'Quote not found' });
    await user.click(within(list2).getByRole('link', { name: `${FIXTURE_HANDBOOK.title}, page 5` }));
    const source = await screen.findByRole('region', { name: FIXTURE_HANDBOOK.title });
    await waitFor(() => expect(within(source).getByRole('tab', { name: '5' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true');
  }, 60000);

  it('opens on the run named in the address and lets the person pick another', async () => {
    const user = userEvent.setup();
    const where: unknown[] = [];
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('viewer')} initialTab="report" initialRunId={ids.run1!} onOpenVersion={() => undefined} onLocation={(w) => where.push(w)} />));
    const nav = await screen.findByRole('navigation', { name: 'Analysis runs' });
    await waitFor(() => expect(within(nav).getAllByRole('button')[1]!.getAttribute('aria-current')).toBe('true'));
    expect(await within(await screen.findByRole('region', { name: 'Analysis report' })).findByTestId('report-summary')).toBeTruthy();
    await user.click(within(nav).getAllByRole('button')[0]!);
    await waitFor(() => expect(within(nav).getAllByRole('button')[0]!.getAttribute('aria-current')).toBe('true'));
    expect(where).toContainEqual({ tab: 'report', run: ids.run2 });
  }, 60000);

  it('shows live progress while a run is active, with no report buttons yet', async () => {
    await db.su.query(`insert into ai_setting (institution_id, model, enabled) values ($1, 'm', true)`, [ids.inst]);
    try {
      setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
      const a = apiFor('lead');
      const run = await a.startAnalysis(ids.v!);
      render(wrap(<VersionPage versionId={ids.v!} api={a} initialTab="report" initialRunId={run.id} onOpenVersion={() => undefined} />));
      const status = await screen.findByRole('status', { name: 'Analysis progress' });
      expect(status.textContent).toContain('Waiting for the worker');
      expect(screen.queryByRole('button', { name: 'Download as Markdown' })).toBeNull();
      await a.cancelAnalysis(run.id);
      queued.length = 0;
    } finally {
      await db.su.query(`delete from ai_setting where institution_id = $1`, [ids.inst]);
    }
  }, 60000);

  it('downloads the report as Markdown and prints it', async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    URL.createObjectURL = (b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:report'; };
    URL.revokeObjectURL = () => undefined;
    const print = vi.fn();
    window.print = print;
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('viewer')} initialTab="report" onOpenVersion={() => undefined} />));
    const button = await screen.findByRole('button', { name: 'Download as Markdown' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await user.click(button);
    expect(blobs).toHaveLength(1);
    const text = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(blobs[0]!); });
    expect(text).toMatch(/^# Analysis report: /);
    expect(text).toContain('## Before you publish');
    expect(text).toContain('8 of 10 quotes found in the source (80%)');
    expect(text).toContain('1.9');
    expect(text).not.toMatch(/compliant|\bmet\b|\bscore\b|readiness/i);
    await user.click(screen.getByRole('button', { name: 'Print / save as PDF' }));
    expect(print).toHaveBeenCalledTimes(1);
  }, 60000);

  it('says so when there is no run yet', async () => {
    const empty = await one(`insert into framework_version (institution_id, framework_id, edition) select institution_id, framework_id, '2031' from framework_version where id = $1 returning id`, [ids.v]);
    render(wrap(<VersionPage versionId={empty} api={apiFor('viewer')} initialTab="report" onOpenVersion={() => undefined} />));
    expect(await screen.findByText(/No analysis has run on this version yet/)).toBeTruthy();
  }, 60000);
});

// ---- Cards with content a run of the fixtures does not produce ---------------------------------------------------------

const ref = (code: string | null, over: Record<string, unknown> = {}) => ({ code, title: null, requirementId: code ? `req-${code}` : null, documentId: 'doc-1', documentTitle: 'Handbook', page: 3, ...over });
const canned = (): AnalysisReport => ({
  reportVersion: 1, runId: 'run-1', versionId: 'v-1', generatedAt: '2026-10-10T10:00:00.000Z',
  summary: {
    status: 'succeeded', stage: 'finalise', error: null, startedBy: { id: 'u', name: 'Lena' }, startedAt: '2026-10-10T09:00:00.000Z', finishedAt: '2026-10-10T09:04:00.000Z', durationSeconds: 240,
    sources: [{ documentId: 'doc-1', title: 'Handbook', role: 'standards', roleDecidedBy: 'analysis', language: 'en', pages: 10, pagesNative: 8, pagesOcr: 1, pagesUnreadable: 1, warnings: ['1 page had no readable text and was not read by AI vision.'] }],
    used: { analysisModel: 'model-a', visionModel: 'model-v', embeddings: { used: true, model: 'embed-1', note: null }, inputTokens: 1000, outputTokens: 500, costUsd: 0.12, calls: 14, recoveryRounds: 2, promptVersions: {} },
  },
  structure: { levelLabelsProposed: ['Standard', 'Criterion'], levelLabelsWritten: ['Standard', 'Criterion'], levelLabelsNow: ['Standard', 'Criterion'], numbering: [{ levelLabel: 'Criterion', examples: ['1.1'] }], keyTerms: [{ term: 'mission', meaning: 'the purpose' }], scope: 'The whole institution' },
  requirements: { total: 2, notes: 0, byLevel: [{ level: 'Standard', count: 2 }], quotes: { found: 1, total: 2, percent: 50 }, quoteNotFound: [], lowConfidence: [], suggestedNotConfirmed: [], orphans: 0, deleted: [], keptYourEdits: 0, atRun: null },
  gaps: {
    recovered: [], confirmedAbsent: [], unresolved: [], uncoveredPages: [], rounds: 2, stopped: null,
    conflicts: [{
      ...ref('1.1'), key: 'conflict:1.1', kind: 'conflict', status: 'conflict', detail: 'different wording in two documents', reason: null, attempts: 0,
      variants: [{ documentId: 'doc-1', documentTitle: 'Handbook', page: 3, text: 'The board approves the budget.' }, { documentId: 'doc-2', documentTitle: 'دليل', page: 1, text: 'يعتمد المجلس الميزانية.' }],
    }],
  },
  mapping: {
    ran: true, skipped: null, retrieval: 'words and meaning', embeddingsNote: null, requirementsConsidered: 2,
    suggested: [{ ref: ref('1.1'), links: [{ internalCode: '2.1', internalTitle: 'Assessment', relation: 'partly_covers', rationale: null, reviewStatus: 'pending' }] }],
    byRelation: { covers: 0, partly_covers: 1, related: 0 }, noSuggestion: [ref('1.2')],
    newItems: [{ proposalId: 'p1', status: 'pending', code: '3', title: 'Graduate follow-up', parentCode: null, reason: null, covers: [{ externalCode: '1.2', requirementId: 'req-1.2', relation: 'covers' }] }],
    decisions: { linksWaiting: 1, linksAccepted: 0, linksDismissed: 0, newItemsWaiting: 1, newItemsAccepted: 0, newItemsDismissed: 0 }, stopped: null,
  },
  configuration: {
    ran: true, skipped: null, stopped: 'Reading the policy and template documents stopped at the spend limit; what was found so far was checked and written.',
    documents: [
      { documentId: 'doc-3', title: 'Process Guide', role: 'policy_procedure', found: ['lifecycle (pages 1 to 5)', 'vocabularies (pages 4 to 6)'], note: null },
      { documentId: 'doc-4', title: 'نموذج التقرير', role: 'report_template', found: ['report template "نموذج التقرير" (pages 1 to 3)'], note: null },
    ],
    sections: [
      { section: 'lifecycle_template', state: 'written', written: 3, flagged: 1, editedSince: false }, { section: 'decision_vocab', state: 'kept_your_edits', written: 0, flagged: 0, editedSince: true },
      { section: 'report_templates', state: 'written', written: 2, flagged: 0, editedSince: false },
    ],
    items: [
      { group: 'milestone', ref: 'self_study_report', label: 'Self-Study Report', detail: 'submission', documentId: 'doc-3', documentTitle: 'Process Guide', page: 2, quote: 'submits its Self-Study Report no later than July 1', status: 'written', reasons: ['the reviewer must set the due rule'], dueText: 'no later than July 1 of the calendar year of the visit', under: 'The self-study' },
      { group: 'template', ref: 'form', label: 'نموذج التقرير', detail: 'self_study, 1 section', documentId: 'doc-4', documentTitle: 'نموذج التقرير', page: 1, quote: 'مقدمة', status: 'written', reasons: [] },
      { group: 'decision', ref: null, label: 'Interim Report', detail: null, documentId: 'doc-3', documentTitle: 'Process Guide', page: 4, quote: 'Full Accreditation, Interim Report, or Not Accredited', status: 'flagged', reasons: ['no decision outcome could be chosen for it; add it by hand'] },
    ].map((i) => ({ ...i })) as AnalysisReport['configuration']['items'],
    flagged: [
      { group: 'decision', ref: null, label: 'Interim Report', detail: null, documentId: 'doc-3', documentTitle: 'Process Guide', page: 4, quote: 'Full Accreditation, Interim Report, or Not Accredited', status: 'flagged', reasons: ['no decision outcome could be chosen for it; add it by hand'] },
    ] as AnalysisReport['configuration']['flagged'],
    notFound: ['No finding vocabulary was found in the documents.'], deletedByPerson: [], milestonesNeedingDueRule: 1,
  },
  checklist: [
    { id: 'config_due_rules', label: '1 milestone found in the policy documents needs a due rule set by a reviewer (the documents\' wording is kept; no date was taken from them)', count: 1, level: 'look', link: { tab: 'settings', section: 'lifecycle', requirementId: null, documentId: null, page: null } },
    { id: 'conflicts', label: '1 conflict: the same code is worded differently in the sources', count: 1, level: 'look', link: { tab: 'requirements', section: null, requirementId: 'req-1.1', documentId: null, page: null } },
    { id: 'links_waiting', label: '1 suggested link to your quality framework waiting for a decision', count: 1, level: 'look', link: { tab: 'mappings', section: null, requirementId: null, documentId: null, page: null } },
  ],
  validation: { problems: ['a "required" note needs a quote found on its source page'], warnings: [] },
});

describe('report cards', () => {
  const run = { id: 'run-1', frameworkVersionId: 'v-1', status: 'succeeded', stage: 'finalise', progress: {}, model: 'model-a', promptVersions: {}, usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.12, calls: 14 }, error: null, startedBy: null, startedAt: '2026-10-10T09:00:00.000Z', finishedAt: '2026-10-10T09:04:00.000Z', createdAt: '2026-10-10T09:00:00.000Z', report: {} };
  const stub = { analysisRuns: async () => [run], analysisReport: async () => canned() } as unknown as FrameworkApi;
  const navs = () => ({ onShowRequirement: vi.fn(), onShowPage: vi.fn(), onShowMappings: vi.fn(), onShowSettings: vi.fn() }) satisfies ReportNav;

  it('shows the two wordings of a conflict side by side, the models used, and links to the Mappings tab', async () => {
    const user = userEvent.setup();
    const nav = navs();
    render(wrap(<ReportTab api={stub} versionId="v-1" runId="run-1" onSelectRun={() => undefined} nav={nav} title="Test" />));
    const conflicts = await screen.findByTestId('conflict-variants');
    const wordings = Array.from(conflicts.querySelectorAll('blockquote'));
    expect(wordings.map((b) => b.textContent)).toEqual(['Handbook, page 3The board approves the budget.', 'دليل, page 1يعتمد المجلس الميزانية.']);
    expect(conflicts.querySelector('blockquote p[dir="auto"], blockquote p span[dir="auto"]')).toBeTruthy();
    const summary = screen.getByTestId('report-summary');
    expect(summary.textContent).toContain('model-a');
    expect(summary.textContent).toContain('model-v');
    expect(summary.textContent).toContain('words and meaning (embed-1)');
    expect(summary.textContent).toContain('1 page had no readable text');
    expect(screen.getByTestId('mapping-decisions').textContent).toContain('links 0 accepted, 0 dismissed, 1 waiting');
    expect(screen.getByTestId('report-links').textContent).toContain('partly covers 2.1 Assessment');
    // No similarity number anywhere.
    expect(screen.getByTestId('report-mapping').textContent).not.toMatch(/similarity|\d\.\d{2,}/i);

    const check = within(screen.getByRole('list', { name: 'Before you publish' }));
    await user.click(check.getByRole('link', { name: /1 suggested link to your quality framework/ }));
    expect(nav.onShowMappings).toHaveBeenCalledTimes(1);
    await user.click(check.getByRole('link', { name: /1 conflict/ }));
    expect(nav.onShowRequirement).toHaveBeenCalledWith('req-1.1');
    await user.click(within(screen.getByTestId('report-links')).getByRole('link', { name: /partly covers/ }));
    expect(nav.onShowMappings).toHaveBeenCalledTimes(2);
    expect(screen.getByText('a "required" note needs a quote found on its source page')).toBeTruthy();
    await user.click(within(conflicts).getByRole('link', { name: 'دليل, page 1' }));
    expect(nav.onShowPage).toHaveBeenCalledWith('doc-2', 1);
  });

  it('lists the configuration found with its pages and the timing words as written, what was kept out and why, and links the checks to Settings', async () => {
    const user = userEvent.setup();
    const nav = navs();
    render(wrap(<ReportTab api={stub} versionId="v-1" runId="run-1" onSelectRun={() => undefined} nav={nav} title="Test" />));
    const card = await screen.findByTestId('report-configuration');
    expect(card.textContent).toContain('stopped at the spend limit');
    expect(within(card).getAllByTestId('config-document').map((d) => d.textContent)).toEqual([
      'Process Guide: lifecycle (pages 1 to 5), vocabularies (pages 4 to 6)', 'نموذج التقرير: report template "نموذج التقرير" (pages 1 to 3)',
    ]);
    expect(within(card).getAllByTestId('config-section').map((s) => s.textContent)).toEqual([
      'Lifecycle: written to the draft · 3 written · 1 flagged', 'Decision vocabulary: left as you edited it · 0 written · 0 flagged · you edited it since', 'Report templates: written to the draft · 2 written · 0 flagged',
    ]);
    expect(within(card).getByTestId('config-due-rules').textContent).toMatch(/1 milestone still needs a due rule set by a reviewer.*no date was taken from them/);
    const found = within(within(card).getByRole('list', { name: 'Configuration found' }));
    const milestone = found.getAllByTestId('config-item')[0]!;
    expect(milestone.textContent).toContain('Milestone in The self-study: Self-Study Report (submission)');
    expect(milestone.textContent).toContain('Due as written: no later than July 1 of the calendar year of the visit');
    expect(milestone.textContent).toContain('the reviewer must set the due rule');
    // Arabic keeps its own direction.
    expect(found.getAllByTestId('config-item')[1]!.querySelector('[dir="auto"]')).toBeTruthy();
    const flagged = within(card).getByRole('list', { name: 'Configuration flagged' });
    expect(flagged.textContent).toContain('Interim Report');
    expect(flagged.textContent).toContain('no decision outcome could be chosen for it');
    expect(flagged.textContent).toContain('Quote: Full Accreditation, Interim Report, or Not Accredited');
    expect(within(card).getByRole('list', { name: 'Not found in the documents' }).textContent).toBe('No finding vocabulary was found in the documents.');
    // No verdict and no score.
    expect(card.textContent).not.toMatch(/compliant|\bmet\b|\bscore\b|readiness/i);

    await user.click(within(milestone).getByRole('link', { name: 'Process Guide, page 2' }));
    expect(nav.onShowPage).toHaveBeenCalledWith('doc-3', 2);
    await user.click(within(screen.getByRole('list', { name: 'Before you publish' })).getByRole('link', { name: /needs a due rule set by a reviewer/ }));
    expect(nav.onShowSettings).toHaveBeenCalledWith('lifecycle');
  });

  it('says why the configuration was not read, when there was nothing to read', async () => {
    const skipped = { ...canned(), configuration: { ...canned().configuration, ran: false, skipped: 'This version has no policy and procedure, report template or guidance document, so there was nothing to read.', documents: [], sections: [], items: [], flagged: [], notFound: [], milestonesNeedingDueRule: 0, stopped: null } };
    const api = { analysisRuns: async () => [run], analysisReport: async () => skipped } as unknown as FrameworkApi;
    render(wrap(<ReportTab api={api} versionId="v-1" runId="run-1" onSelectRun={() => undefined} nav={navs()} title="Test" />));
    const card = await screen.findByTestId('report-configuration');
    expect(card.textContent).toContain('Not read: this version has no policy and procedure, report template or guidance document');
  });
});

// ---- The standard card's one line ------------------------------------------------------------------------------------

describe('the standard card\'s analysis line', () => {
  type Summary = FrameworkListItem['versions'][number];
  const version = (analysis: Summary['analysis']): Summary => ({ id: 'ver-1', edition: '2030', status: 'draft', publishedAt: null, effectiveFrom: null, supersedesId: null, requirementCount: 3, assessableCount: 3, mappedCount: 0, engagementCount: 0, analysis });

  it('says running, finished with a link to the report, or failed with the reason', async () => {
    const view = render(wrap(<AnalysisLine v={version({ runId: 'r1', status: 'running', error: null })} />));
    expect((await screen.findByTestId('analysis-line')).textContent).toBe('Analysis running…');
    view.unmount();
    render(wrap(<AnalysisLine v={version({ runId: 'r2', status: 'succeeded', error: null })} />));
    const line = await screen.findByTestId('analysis-line');
    expect(line.textContent).toBe('Analysis finished · view report');
    expect(within(line).getByRole('link', { name: 'view report' }).getAttribute('href')).toMatch(/\/settings\/versions\/ver-1\?tab=report&run=r2/);
    cleanup();
    render(wrap(<AnalysisLine v={version({ runId: 'r3', status: 'failed', error: 'the model stopped answering' })} />));
    const failed = await screen.findByTestId('analysis-line');
    expect(failed.textContent).toBe('Analysis failed');
    expect(failed.getAttribute('title')).toBe('the model stopped answering');
    cleanup();
    const none = render(wrap(<AnalysisLine v={version(null)} />));
    expect(none.container.querySelector('[data-testid="analysis-line"]')).toBeNull();
  });
});

// ---- "Analyse sources" says why not before the click -------------------------------------------------------------------

describe('Analyse sources readiness', () => {
  it('disables the button with the first blocking reason, lists the checks, and enables it once the AI is on', async () => {
    const user = userEvent.setup();
    await db.su.query(`insert into ai_setting (institution_id, model, enabled) values ($1, 'm', false)`, [ids.inst]);
    try {
      const a = apiFor('lead');
      render(wrap(<VersionPage versionId={ids.v!} api={a} initialTab="settings" initialSection="sources" onOpenVersion={() => undefined} />));
      const panel = await screen.findByRole('region', { name: 'Analysis' });
      const button = await within(panel).findByRole('button', { name: 'Analyse sources' });
      await waitFor(() => expect(button.getAttribute('title')).toMatch(/switched off/));
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(panel.textContent).toMatch(/AI is switched off/);
      await user.click(within(panel).getByText(/Before you start/));
      const checks = within(panel).getAllByTestId('preflight-check').map((c) => c.textContent);
      expect(checks.some((t) => t?.startsWith('Fix') && /switched off/.test(t))).toBe(true);
      expect(checks.some((t) => t?.startsWith('OK') && /This version is a draft/.test(t))).toBe(true);
      expect(within(panel).getAllByRole('link', { name: 'Open Settings -> AI' }).length).toBeGreaterThan(0);
      // The key is never in the answer.
      expect(JSON.stringify(await a.analysisPreflight(ids.v!))).not.toMatch(/sk-|apiKey/i);
      cleanup();

      await db.su.query(`update ai_setting set enabled = true where institution_id = $1`, [ids.inst]);
      setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
      render(wrap(<VersionPage versionId={ids.v!} api={a} initialTab="settings" initialSection="sources" onOpenVersion={() => undefined} />));
      const panel2 = await screen.findByRole('region', { name: 'Analysis' });
      await waitFor(() => expect((within(panel2).getByRole('button', { name: 'Analyse sources' }) as HTMLButtonElement).disabled).toBe(false));
      expect(within(panel2).queryByText(/switched off/)).toBeNull();
    } finally {
      await db.su.query(`delete from ai_setting where institution_id = $1`, [ids.inst]);
    }
  }, 60000);
});
