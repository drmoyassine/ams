// @vitest-environment jsdom
// Evidence collection runs in the SPA (TASK-090): the runs of an item in its Collection section (period, due, status chip, what supplied it,
// the error of a failed one, and Run now / Retry / Skip / Mark supplied), the "BI is not configured" note, the Late / Failed / Due soon filters
// of the library, and My work with the evidence the owner owes and the notices of runs. Arabic names keep their own direction.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { BiCallError, collectTick, type BiCall, type BiCallResult, type BiClient, type BiRuntime } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { cyclesApi } from './lib/cycles-api';
import { evidenceApi } from './lib/evidence-api';
import { frameworkApi } from './lib/framework-api';
import { scopeApi } from './lib/scope-api';
import { settingsApi } from './lib/settings-api';
import { EvidencePage } from './pages/evidence';
import { MyWorkTab } from './pages/cycles/my-work';

configure({ asyncUtilTimeout: 10000 });

class FakeBi implements BiClient {
  calls: BiCall[] = [];
  script: (BiCallResult | Error)[] = [{ status: 202 }];
  async collect(call: BiCall): Promise<BiCallResult> {
    this.calls.push(call);
    const next = this.script.length > 1 ? this.script.shift()! : this.script[0]!;
    if (next instanceof Error) throw next;
    return next;
  }
}

let db: TestDb;
let pool: pg.Pool;
let withBi: ReturnType<typeof createApp>['app'];
let withoutBi: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const bi = new FakeBi();
const runtime: BiRuntime = { config: { baseUrl: 'https://bi.example.org', apiKey: 'k', endpoints: {}, publicUrl: 'https://ams.example.org', production: true }, client: bi };
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const authenticate = async (req: Request) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; };
const fetcherOf = (who: string, app = withBi) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apis = (who: string, app = withBi) => {
  const f = fetcherOf(who, app);
  const a = createApi(f);
  return { evidence: evidenceApi(a, f), framework: frameworkApi(a), settings: settingsApi(a, f), scope: scopeApi(a), cycles: cyclesApi(a, f) };
};
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const library = (who: string, app = withBi) => { const a = apis(who, app); return wrap(<EvidencePage api={a.evidence} framework={a.framework} apis={a} />); };
const myWork = (who: string) => wrap(<MyWorkTab apis={apis(who)} />);
const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const tickAt = (at: Date | string, client: BiRuntime = runtime) => collectTick(pool, { bi: client, store, now: () => new Date(at) });
const card = (title: string) => screen.findByRole('region', { name: `Evidence: ${title}` });
const openCard = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
  const c = await card(title);
  await user.click(within(c).getAllByRole('button')[0]!);
  return within(await within(c).findByTestId('collection-section'));
};
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const COLUMNS = [{ key: 'n', label: 'Headcount', type: 'integer' as const, required: true }];

beforeAll(async () => {
  db = await createTestDb('webcollection');
  pool = new pg.Pool({ connectionString: db.url });
  withBi = createApp({ pool, store, bi: runtime, authenticate }).app;
  withoutBi = createApp({ pool, store, authenticate }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'viewer', 'dean']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2 || '@x.org') returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['viewer', 'viewer'], ['dean', 'contributor']] as const) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u], role]);
  }
}, 120000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

describe('the runs of an item', () => {
  it('lists each period with its due day, a status chip, what supplied it, and next due; a viewer sees them without the actions', async () => {
    const user = userEvent.setup();
    const a = apis('dean').evidence;
    const made = await a.create({ title: 'Course syllabi', type: 'document', schedule: { every: 'day', startDate: iso(-10), dueAfterDays: 5, timezone: 'UTC' }, methodConfig: { instructions: 'Upload the PDFs' } });
    await tickAt(dayAgo(2));   // two days ago: that day's run
    await tickAt(new Date());  // and the days since
    render(library('dean'));
    const section = await openCard(user, 'Course syllabi');
    const runs = await section.findAllByTestId('collection-run');
    expect(runs.length).toBeGreaterThanOrEqual(3);
    const first = runs[0]!;
    expect(within(first).getByTestId('run-status').textContent).toBe('Pending');
    expect(first.textContent).toMatch(/Due \w{3} \d{1,2}, \d{4}/);
    expect(section.getByTestId('collection-next-due').textContent).toMatch(/\d{4}$/);
    // The owner uploads a new version: the oldest open period is supplied by it and says so.
    await a.upload(made.id, new File(['x'], 'syllabi.pdf', { type: 'application/pdf' }));
    cleanup();
    render(library('dean'));
    const again = await openCard(user, 'Course syllabi');
    await waitFor(() => expect(again.getAllByTestId('run-status').some((c) => c.textContent === 'Supplied')).toBe(true));
    expect(again.getByTestId('run-version').textContent).toBe('Supplied by version 1');
    cleanup();

    render(library('viewer'));
    const viewerSection = await openCard(user, 'Course syllabi');
    await viewerSection.findAllByTestId('collection-run');
    expect(viewerSection.queryByRole('button', { name: 'Run now' })).toBeNull();
    expect(viewerSection.queryByRole('button', { name: /^Skip / })).toBeNull();
    expect(viewerSection.queryByRole('button', { name: /^Retry / })).toBeNull();
  });

  it('Run now makes this period\'s run and shows it; a second one is refused with the reason', async () => {
    const user = userEvent.setup();
    await apis('dean').evidence.create({ title: 'Faculty handbook', type: 'document' });
    render(library('dean'));
    const section = await openCard(user, 'Faculty handbook');
    expect((await section.findByTestId('no-runs')).textContent).toContain('Run now');
    await user.click(section.getByRole('button', { name: 'Run now' }));
    const run = await section.findByTestId('collection-run');
    expect(within(run).getByTestId('run-status').textContent).toBe('Pending');
    expect(run.textContent).toContain(new Date().toISOString().slice(0, 10));
    await user.click(await section.findByRole('button', { name: 'Run now' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/There is already a run for .*: it is pending/);
  });

  it('Skip this period asks for a reason, keeps it on the run, and the run is final', async () => {
    const user = userEvent.setup();
    await apis('dean').evidence.create({ title: 'Council minutes', type: 'document' });
    render(library('dean'));
    const section = await openCard(user, 'Council minutes');
    await user.click(await section.findByRole('button', { name: 'Run now' }));
    await section.findByTestId('collection-run');
    await waitFor(() => expect((section.getByRole('button', { name: /^Skip / }) as HTMLButtonElement).disabled).toBe(false)); // the list has settled
    await user.click(section.getByRole('button', { name: /^Skip / }));
    const dialog = await screen.findByRole('dialog', { name: /^Skip / });
    expect((within(dialog).getByRole('button', { name: 'Skip this period' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Reason'), 'The council did not meet');
    await user.click(within(dialog).getByRole('button', { name: 'Skip this period' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(within(section.getByTestId('collection-run')).getByTestId('run-status').textContent).toBe('Skipped'));
    const run = section.getByTestId('collection-run');
    expect(within(run).getByTestId('run-skip-reason').textContent).toBe('Skipped: The council did not meet');
    expect(within(run).queryByRole('button', { name: /^Skip / })).toBeNull();
  });

  it('Mark supplied chooses one of the item\'s own versions', async () => {
    const user = userEvent.setup();
    const a = apis('dean').evidence;
    const made = await a.create({ title: 'Annual report', type: 'document' });
    await db.su.query(`insert into evidence_version (institution_id, evidence_item_id, version_no, url) values ($1, $2, 1, 'https://x.example/a')`, [ids.inst, made.id]);
    await a.runNow(made.id);
    render(library('dean'));
    const section = await openCard(user, 'Annual report');
    await section.findByTestId('collection-run');
    await waitFor(() => expect((section.getByRole('button', { name: /^Mark .* supplied$/ }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(section.getByRole('button', { name: /^Mark .* supplied$/ }));
    const dialog = await screen.findByRole('dialog', { name: /supplied$/ });
    expect((within(dialog).getByLabelText('Version') as HTMLSelectElement).selectedOptions[0]!.textContent).toMatch(/^Version 1 · /);
    await user.click(within(dialog).getByRole('button', { name: 'Mark supplied' }));
    await waitFor(() => expect(section.getByTestId('run-status').textContent).toBe('Supplied'));
    expect(section.getByTestId('run-version').textContent).toBe('Supplied by version 1');
  });
});

describe('a failed BI call', () => {
  it('shows the error, the attempts and when the next one is, and Retry supplies it once the BI answers', async () => {
    const user = userEvent.setup();
    const a = apis('dean').evidence;
    const made = await a.create({ title: 'Retention', type: 'dataset', method: 'bi', methodConfig: { query: { metric: 'retention' } } });
    await db.su.query(`insert into dataset_spec (institution_id, evidence_item_id, columns) values ($1, $2, $3)`, [ids.inst, made.id, JSON.stringify(COLUMNS)]);
    bi.script = [new BiCallError('The BI answered 503: busy')];
    await a.runNow(made.id);
    render(library('dean'));
    const section = await openCard(user, 'Retention');
    const run = await section.findByTestId('collection-run');
    expect(within(run).getByTestId('run-status').textContent).toBe('Failed');
    expect(within(run).getByTestId('run-error').textContent).toBe('The BI answered 503: busy');
    expect(within(run).getByTestId('run-attempts').textContent).toMatch(/^Tried 1 of 5 times · next attempt /);
    bi.script = [{ status: 200, body: { rows: [{ n: 41 }], asOf: iso(0) } }];
    await user.click(within(run).getByRole('button', { name: /^Retry / }));
    await waitFor(() => expect(section.getByTestId('run-status').textContent).toBe('Supplied'));
    expect(section.getByTestId('run-version').textContent).toBe('Supplied by version 1');
    expect(section.queryByTestId('run-error')).toBeNull();
  });

  it('a BI item says so when the server has no BI configured, and the run fails with that reason', async () => {
    const user = userEvent.setup();
    const a = apis('dean', withoutBi).evidence;
    const made = await a.create({ title: 'Graduation rate', type: 'document', method: 'bi' });
    expect((await a.collectionConfig()).bi.configured).toBe(false);
    await a.runNow(made.id);
    render(library('dean', withoutBi));
    const section = await openCard(user, 'Graduation rate');
    expect((await section.findByTestId('bi-not-configured')).textContent).toMatch(/BI is not configured/);
    expect(within(await section.findByTestId('collection-run')).getByTestId('run-error').textContent).toContain('BI_BASE_URL');
    cleanup();
    // With the BI configured the note is gone.
    render(library('dean', withBi));
    const ok = await openCard(user, 'Graduation rate');
    await ok.findByTestId('collection-run');
    expect(ok.queryByTestId('bi-not-configured')).toBeNull();
  });

  it('a request run tells the owner when the person asked has no account', async () => {
    const user = userEvent.setup();
    const a = apis('dean').evidence;
    const made = await a.create({ title: 'Employer letters', type: 'document', method: 'request', methodConfig: { assigneeEmail: 'partner@example.com' } });
    await a.runNow(made.id);
    render(library('dean'));
    const section = await openCard(user, 'Employer letters');
    const run = await section.findByTestId('collection-run');
    expect(within(run).getByTestId('run-status').textContent).toBe('Requested');
    expect(within(run).getByTestId('run-no-account').textContent).toMatch(/no account here/);
  });
});

describe('the library finds late and failed items', () => {
  it('has Due soon, Late and Failed filters, and the Late and Failed chips on the cards', async () => {
    const user = userEvent.setup();
    const a = apis('dean').evidence;
    // Late: a daily item whose period ended days ago without a supply.
    await a.create({ title: 'Late one', type: 'document', schedule: { every: 'day', startDate: iso(-8), dueAfterDays: 0, timezone: 'UTC' } });
    await tickAt(dayAgo(3));
    await tickAt(new Date());
    const failedItem = await a.create({ title: 'Failed one', type: 'document', method: 'bi' });
    bi.script = [new BiCallError('down')];
    await a.runNow(failedItem.id);
    const soon = await a.create({ title: 'Soon one', type: 'document', schedule: { every: 'month', startDate: iso(-1), dueAfterDays: 3, timezone: 'UTC' } });
    expect(soon.nextDueAt).not.toBeNull();
    render(library('dean'));
    await card('Late one');
    const group = screen.getByRole('group', { name: 'Show' });
    await user.click(within(group).getByRole('button', { name: 'Late' }));
    expect(await card('Late one')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Evidence: Failed one' })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Evidence: Late one' })).getByTestId('evidence-late').textContent).toBe('Late');
    await user.click(within(group).getByRole('button', { name: 'Failed' }));
    expect(await card('Failed one')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Evidence: Late one' })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Evidence: Failed one' })).getByTestId('evidence-failed').textContent).toBe('Collection failed');
    await user.click(within(group).getByRole('button', { name: 'Due soon' }));
    expect(await card('Soon one')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Evidence: Failed one' })).toBeNull();
  });
});

describe('My work', () => {
  it('shows the evidence I owe as "Supply <evidence> for <period>" with an Open link, late ones flagged, and nothing for someone who owns none', async () => {
    const a = apis('dean').evidence;
    const mine = await a.create({ title: 'Safety audit', type: 'document', schedule: { every: 'day', startDate: iso(-6), dueAfterDays: 0, timezone: 'UTC' } });
    await tickAt(dayAgo(2));
    await tickAt(new Date());
    render(myWork('dean'));
    const section = await screen.findByTestId('my-evidence-runs');
    const rows = within(section).getAllByTestId('my-evidence-run').filter((r) => r.textContent?.includes('Safety audit'));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const lateRow = rows.find((r) => r.getAttribute('data-status') === 'late')!;
    expect(lateRow).toBeTruthy();
    expect(within(lateRow).getByTestId('run-status').textContent).toBe('Late');
    expect(lateRow.textContent).toMatch(/^Supply Safety audit for \d{4}-\d{2}-\d{2}/);
    expect(within(lateRow).getByRole('link', { name: 'Open Safety audit' }).getAttribute('href')).toBe(`/evidence?item=${mine.id}`);
    cleanup();

    render(myWork('viewer'));
    expect((await screen.findByTestId('my-work-empty')).textContent).toBe('Nothing is waiting for you.');
    expect(screen.queryByTestId('my-evidence-runs')).toBeNull();
  });

  it('tells the owner in a notification, with Open, when a run is due, late or failed', async () => {
    const a = apis('dean').evidence;
    const made = await a.create({ title: 'Lab inventory', type: 'document', method: 'bi' });
    bi.script = [new BiCallError('refused')];
    await a.runNow(made.id);
    // Used up: the owner is told once the attempts are.
    await db.su.query(`update evidence_collection_run set attempts = 4, status = 'failed', next_attempt_at = now() - interval '1 minute' where evidence_item_id = $1`, [made.id]);
    await tickAt(new Date());
    render(myWork('dean'));
    const notice = (await screen.findAllByTestId('my-notification')).find((n) => n.textContent?.includes('refused'))!;
    expect(notice.textContent).toContain('Open the evidence item to retry or skip this period.');
    expect(within(notice).getByRole('link', { name: 'Open the evidence Lab inventory' }).getAttribute('href')).toBe(`/evidence?item=${made.id}`);
  });

  it('keeps Arabic titles and periods in their own direction', async () => {
    const user = userEvent.setup();
    const a = apis('dean').evidence;
    await a.create({ title: 'تقرير المخرجات', type: 'document', schedule: { every: 'day', startDate: iso(-3), dueAfterDays: 3, timezone: 'UTC' } });
    await tickAt(new Date());
    render(myWork('dean'));
    const row = (await screen.findAllByTestId('my-evidence-run')).find((r) => r.textContent?.includes('تقرير المخرجات'))!;
    expect(row.querySelector('[dir="auto"]')!.textContent).toContain('تقرير المخرجات');
    cleanup();
    render(library('dean'));
    const section = await openCard(user, 'تقرير المخرجات');
    const run = (await section.findAllByTestId('collection-run'))[0]!;
    expect(run.querySelector('[dir="auto"]')).not.toBeNull();
  });
});
