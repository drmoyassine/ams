// @vitest-environment jsdom
// The Cycle section of an evidence item's card (DEC-030, TASK-087) in the browser, against the real API and database: "Collect this
// regularly" (the plan dialog: template, repeat, first due date, owner; the evidence item's owner is the default), the plan with its next
// due date, "Start a cycle now" (the shared launch dialog with the item fixed), the open cycle and the past ones, "Stop repeating"
// (removed when it never made a cycle, switched off when it did), and the read-only view of someone who may not manage cycles.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { resetConfirmForTests } from './components/confirm-dialog';
import { createApi } from './lib/api';
import { cyclesApi } from './lib/cycles-api';
import { evidenceApi } from './lib/evidence-api';
import { frameworkApi } from './lib/framework-api';
import { plansApi } from './lib/plans-api';
import { scopeApi } from './lib/scope-api';
import { settingsApi } from './lib/settings-api';
import { EvidencePage } from './pages/evidence';

configure({ asyncUtilTimeout: 10000 });

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
const apis = (who: string) => {
  const a = createApi(fetcherOf(who));
  const f = fetcherOf(who);
  return { cycles: cyclesApi(a, f), settings: settingsApi(a, f), scope: scopeApi(a), evidence: evidenceApi(a, f), framework: frameworkApi(a), plans: plansApi(a) };
};
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const library = (who: string) => { const a = apis(who); return wrap(<EvidencePage api={a.evidence} framework={a.framework} cycleApis={a} />); };
const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const setDate = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

/** Opens the card of an evidence item through its ⋯ menu ("Cycle…") and returns its Cycle section. */
async function openCycle(user: ReturnType<typeof userEvent.setup>, title: string) {
  const card = await screen.findByRole('region', { name: `Evidence: ${title}` });
  await user.click(await within(card).findByRole('button', { name: `Actions for ${title}` }));
  await user.click(screen.getByRole('menuitem', { name: 'Cycle…' }));
  return within(card).findByTestId('evidence-cycle');
}

beforeAll(async () => {
  db = await createTestDb('webevcycle');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'viewer', 'owner', 'librarian']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['viewer', 'viewer'], ['owner', 'contributor'], ['librarian', 'viewer']] as const) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u], role]);
  }
  ids.library = await one(`insert into org_unit (institution_id, type, name_en, head_user_id) values ($1, 'department', 'Library', $2) returning id`, [ids.inst, ids.librarian]);
  await apis('admin').cycles.installDefaultTemplates();
  const a = apis('admin');
  for (const title of ['Syllabi', 'Exam papers', 'Policies']) {
    const e = await a.evidence.create({ title, type: 'document' } as never);
    ids[title] = e.id;
    await db.su.query(`update evidence_item set owner_unit_id = $1, owner_user_id = $2 where id = $3`, [ids.library, ids.owner, e.id]);
  }
}, 120000);
afterEach(() => { cleanup(); resetConfirmForTests(); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('the Cycle section of an evidence item', () => {
  it('says the item is not collected on a schedule; "Collect this regularly" sets the plan (the item\'s owner is the default) and shows its next due date', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    const section = await openCycle(user, 'Syllabi');
    expect((await within(section).findByTestId('evidence-cycle-none')).textContent).toMatch(/not collected on a schedule/);
    await user.click(within(section).getByRole('button', { name: 'Collect this regularly' }));
    const dialog = await screen.findByRole('dialog', { name: /Collect this regularly/ });
    await waitFor(() => expect((within(dialog).getByLabelText('Cycle template') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('Evidence collection'));
    // Only templates that fit an evidence item are offered, and the owner starts as the evidence item's owner.
    expect(within(dialog).queryByRole('option', { name: 'Annual program report' })).toBeNull();
    await waitFor(() => expect((within(dialog).getByLabelText('Owner') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('owner'));
    expect((within(dialog).getByLabelText('Repeats') as HTMLSelectElement).value).toBe('year');
    await user.selectOptions(within(dialog).getByLabelText('Repeats'), 'month');
    setDate(within(dialog).getByLabelText('First due date'), iso(-3));
    await user.click(within(dialog).getByRole('button', { name: 'Save plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const plan = await within(section).findByTestId('evidence-plan');
    expect(plan.textContent).toContain('Evidence collection');
    expect(within(plan).getByTestId('plan-recurrence').textContent).toBe('Every month');
    expect(plan.textContent).toContain('owner');
    expect(within(plan).getByTestId('plan-next').textContent).toMatch(/·/);   // a label and a date
    const stored = (await apis('admin').plans.list()).find((p) => p.anchorId === ids.Syllabi);
    expect(stored).toMatchObject({ anchorKind: 'evidence_item', ownerUserId: ids.owner, active: true });
    // The run that falls due appears in Cycles -> Due to launch.
    expect((await apis('admin').plans.due({ horizonDays: 60 })).runs.some((r) => r.planId === stored!.id && r.anchorId === ids.Syllabi && r.state === 'due')).toBe(true);
    // The button now changes the plan.
    expect(within(section).getByRole('button', { name: 'Change the plan' })).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'Collect this regularly' })).toBeNull();
  });

  it('"Start a cycle now" opens the launch dialog for this item; the open cycle is linked, then listed with the past ones', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    const section = await openCycle(user, 'Syllabi');
    await user.click(await within(section).findByRole('button', { name: 'Start a cycle now' }));
    const dialog = await screen.findByRole('dialog', { name: /New cycle/ });
    expect((within(dialog).getByLabelText('Evidence item') as HTMLSelectElement).disabled).toBe(true);
    await waitFor(() => expect((within(dialog).getByLabelText('Evidence item') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('Syllabi'));
    await waitFor(() => expect((within(dialog).getByLabelText('Template') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('Evidence collection'));
    await waitFor(() => expect((within(dialog).getByLabelText('Owner') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('owner'));
    await user.click(within(dialog).getByRole('button', { name: 'Create cycle' }));
    const review = await within(dialog).findByTestId('launch-review');
    // The head of the evidence's unit is the reviewer; the owner owns both stages: nothing is left to choose.
    expect(within(review).getByRole('status').textContent).toBe('Everything is set.');
    await user.click(within(review).getByRole('button', { name: 'Keep as a draft' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const made = (await apis('admin').cycles.list({ anchorKind: 'evidence_item', anchorId: ids.Syllabi! }))[0]!;
    expect(made).toMatchObject({ status: 'draft', leadUserId: ids.owner, templateName: 'Evidence collection', planId: null });
    const open = await within(section).findByTestId('evidence-open-cycle');
    expect(within(open).getByRole('link', { name: made.title }).getAttribute('href')).toBe(`/quality-management/cycles/${made.id}`);
    // Cancelled cycles move to the past ones.
    const a = apis('admin').cycles;
    await a.activate(made.id);
    await a.cancel(made.id, 'Not needed this term');
    cleanup();
    render(library('admin'));
    const again = await openCycle(user, 'Syllabi');
    const past = await within(again).findByTestId('evidence-past-cycles');
    expect(within(past).getByRole('link', { name: made.title })).toBeTruthy();
    expect(within(past).getByTestId('evidence-cycle-row').getAttribute('data-status')).toBe('cancelled');
    expect(within(again).queryByTestId('evidence-open-cycle')).toBeNull();
  });

  it('"Stop repeating" asks first, and removes a plan that never made a cycle', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    const section = await openCycle(user, 'Syllabi');
    await within(section).findByTestId('evidence-plan');
    await user.click(within(section).getByRole('button', { name: 'Stop repeating' }));
    const ask = await screen.findByRole('dialog', { name: 'Stop repeating?' });
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect((await apis('admin').plans.list()).some((p) => p.anchorId === ids.Syllabi)).toBe(true);   // nothing changed
    await user.click(within(section).getByRole('button', { name: 'Stop repeating' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Stop repeating?' })).getByRole('button', { name: 'Stop repeating' }));
    await waitFor(() => expect(within(section).getByTestId('evidence-cycle-none')).toBeTruthy());
    expect((await apis('admin').plans.list()).some((p) => p.anchorId === ids.Syllabi)).toBe(false);
    expect(within(section).getByRole('button', { name: 'Collect this regularly' })).toBeTruthy();
  });

  it('switches a plan off instead when it has made a cycle, and "Collect this regularly" plans it again', async () => {
    const user = userEvent.setup();
    const admin = apis('admin');
    const tpl = (await admin.cycles.templates({ status: 'published' })).find((t) => t.name === 'Evidence collection')!;
    const plan = await admin.plans.set({ anchorKind: 'evidence_item', anchorId: ids['Exam papers']!, templateId: tpl.id, recurrence: { every: 1, unit: 'month' }, firstStart: iso(-3), ownerUserId: ids.owner });
    const run = (await admin.plans.due({ horizonDays: 5 })).runs.find((r) => r.planId === plan.id)!;
    await admin.cycles.launch({ templateId: tpl.id, anchorKind: 'evidence_item', anchorId: ids['Exam papers']!, startDate: run.periodStart, periodLabel: run.periodLabel, planId: plan.id, periodStart: run.periodStart });
    render(library('admin'));
    const section = await openCycle(user, 'Exam papers');
    expect((await within(section).findByTestId('evidence-open-cycle')).textContent).toContain('Evidence collection');
    await within(section).findByTestId('evidence-plan');
    await user.click(await within(section).findByRole('button', { name: 'Stop repeating' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Stop repeating?' })).getByRole('button', { name: 'Stop repeating' }));
    await waitFor(() => expect(within(section).getByTestId('plan-stopped').textContent).toBe('Stopped'));
    expect((await admin.plans.list()).find((p) => p.id === plan.id)).toMatchObject({ active: false });
    expect(within(section).queryByRole('button', { name: 'Stop repeating' })).toBeNull();
    expect(within(section).getByRole('button', { name: 'Collect this regularly' })).toBeTruthy();
    expect(within(section).queryByTestId('plan-next')).toBeNull();   // a stopped plan proposes nothing
    // The cycle it made stays.
    expect(within(section).getByTestId('evidence-open-cycle')).toBeTruthy();
  });

  it('is read-only for someone who may not manage cycles: the plan and the cycles are visible, no buttons', async () => {
    const user = userEvent.setup();
    const admin = apis('admin');
    const tpl = (await admin.cycles.templates({ status: 'published' })).find((t) => t.name === 'Evidence collection')!;
    await admin.plans.set({ anchorKind: 'evidence_item', anchorId: ids.Policies!, templateId: tpl.id, recurrence: { every: 2, unit: 'year' }, firstStart: iso(30), ownerUserId: ids.owner });
    render(library('viewer'));
    const card = await screen.findByRole('region', { name: 'Evidence: Policies' });
    // The viewer has no ⋯ menu; the card opens with its title.
    await user.click(within(card).getAllByRole('button')[0]!);
    const section = await within(card).findByTestId('evidence-cycle');
    const plan = await within(section).findByTestId('evidence-plan');
    expect(within(plan).getByTestId('plan-recurrence').textContent).toBe('Every 2 years');
    expect(within(section).queryByRole('button', { name: /Collect this regularly|Change the plan|Start a cycle now|Stop repeating/ })).toBeNull();
  });
});
