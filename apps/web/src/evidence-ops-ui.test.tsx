// @vitest-environment jsdom
// The evidence library's new controls (TASK-119): the fields of the add/edit dialog beyond the method (owning unit, period,
// confidentiality, tags, student data), deleting an item from its menu (it goes to the Trash), and selecting several items to change
// them at once or delete them.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { evidenceApi } from './lib/evidence-api';
import { frameworkApi } from './lib/framework-api';
import { scopeApi } from './lib/scope-api';
import { settingsApi } from './lib/settings-api';
import { EvidencePage } from './pages/evidence';

configure({ asyncUtilTimeout: 15000 });
let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const fetcherOf = (who: string) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apis = (who: string) => { const a = createApi(fetcherOf(who)); const f = fetcherOf(who); return { evidence: evidenceApi(a, f), framework: frameworkApi(a), settings: settingsApi(a, f), scope: scopeApi(a) }; };
const library = (who: string) => {
  const a = apis(who);
  const router = createRouter({ routeTree: createRootRoute({ component: () => <EvidencePage api={a.evidence} framework={a.framework} apis={a} /> }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
};

beforeAll(async () => {
  db = await createTestDb('webevidenceops');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2 || '@x.org') returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['viewer', 'viewer']] as const) await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u], role]);
  ids.unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Institutional Effectiveness') returning id`, [ids.inst]);
}, 120000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

describe('the add and edit dialog', () => {
  it('sets the owning unit, period, confidentiality, tags and student data, and keeps them when edited', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    await user.click(await screen.findByRole('button', { name: '+ Evidence' }));
    const form = await screen.findByRole('dialog', { name: 'New evidence' });
    expect(within(form).getByRole('group', { name: 'Ownership and handling' })).toBeTruthy();
    await user.type(within(form).getByLabelText('Title'), 'First-year retention rate');
    await user.click(within(form).getByRole('radio', { name: 'Dataset' }));
    await user.selectOptions(within(form).getByLabelText('Owning unit'), 'Institutional Effectiveness');
    await user.type(within(form).getByLabelText('Period covered'), '2026-27');
    await user.selectOptions(within(form).getByLabelText('Confidentiality'), 'restricted');
    await user.type(within(form).getByLabelText('Tags'), 'kpi, RISE, kpi');
    await user.click(within(form).getByLabelText('Contains student data'));
    await user.click(within(form).getByRole('button', { name: 'Create evidence' }));
    await waitFor(async () => expect((await apis('admin').evidence.list('First-year')).length).toBe(1));
    const item = (await apis('admin').evidence.list('First-year'))[0]!;
    expect(item).toMatchObject({ type: 'dataset', ownerUnitId: ids.unit, periodLabel: '2026-27', confidentiality: 'restricted', tags: ['kpi', 'RISE'], containsStudentData: true });
  });
});

describe('deleting and bulk changes', () => {
  it('deletes an item from its menu, then selects several to tag, archive and delete them together', async () => {
    const user = userEvent.setup();
    const ev = apis('admin').evidence;
    for (const t of ['KPI one', 'KPI two', 'Single item']) await ev.create({ title: t, type: 'dataset' });
    render(library('admin'));
    await screen.findByText('Single item');
    await user.click(screen.getByRole('button', { name: 'Actions for Single item' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Single item')).toBeNull());
    expect((await ev.list(undefined, { includeArchived: true })).some((e) => e.title === 'Single item')).toBe(false);

    await user.click(await screen.findByRole('checkbox', { name: 'Select KPI one' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select KPI two' }));
    const bar = await screen.findByRole('region', { name: 'Bulk actions' });
    expect(within(bar).getByRole('status').textContent).toBe('2 selected');
    await user.type(within(bar).getByLabelText('Add tags'), 'kpi');
    await user.selectOptions(within(bar).getByLabelText('Set owning unit'), 'Institutional Effectiveness');
    await user.click(within(bar).getByRole('button', { name: 'Apply to 2' }));
    await waitFor(async () => expect((await ev.list('KPI')).every((e) => e.tags.includes('kpi') && e.ownerUnitId === ids.unit)).toBe(true));
    await user.click(within(bar).getByRole('button', { name: 'Archive' }));
    await waitFor(async () => expect((await ev.list('KPI')).length).toBe(0));
  });

  it('shows a viewer no checkboxes and no Delete', async () => {
    render(library('viewer'));
    await screen.findByRole('list', { name: 'Evidence' });
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
