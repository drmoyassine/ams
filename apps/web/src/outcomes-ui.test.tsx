// @vitest-environment jsdom
// Courses, program outcomes and the curriculum map (TASK-105, TASK-112) through the Organization screen, against the real API and
// database: add a course with a CLO, put it in a program, add a PLO, map the CLO at a level, see the map and the coverage, add an ILO
// and link it, and a viewer who sees it all without the buttons.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '@ams/api';
import { MemoryStore } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApi } from './lib/api';
import { outcomesApi } from './lib/outcomes-api';
import { assessmentApi } from './lib/assessment-api';
import { settingsApi } from './lib/settings-api';
import { OrganizationPage, type OrganizationTab } from './pages/settings/organization';

configure({ asyncUtilTimeout: 30000 });
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
vi.mock('./lib/auth', () => ({ authClient: { getSession: async () => ({ data: { user: { id: 'u' } } }), signOut: async () => undefined, signIn: { email: async () => ({}) } } }));

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const fetchAs = (who: string) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
function page(who: string, tab: OrganizationTab) {
  const f = fetchAs(who);
  const ui = <OrganizationPage api={settingsApi(createApi(f), f)} outcomes={outcomesApi(f)} assessment={assessmentApi(f)} tab={tab} />;
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
}

beforeAll(async () => {
  db = await createTestDb('weboutcomes');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1), ($1, $3, 'viewer', 'institution', $1)`, [ids.inst, ids.admin, ids.viewer]);
  const unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.prog = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BS Electrical and Computer Engineering', 'bachelor') returning id`, [ids.inst, unit]);
}, 120000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

describe('courses, outcomes and the curriculum map', () => {
  it('adds a course with a CLO and puts it in a program', async () => {
    const user = userEvent.setup();
    page('admin', 'courses');
    await user.click(await screen.findByRole('button', { name: 'Add course' }));
    const form = await screen.findByRole('form', { name: 'Add course' });
    await user.type(within(form).getByLabelText('Course code'), 'ECE 420');
    await user.type(within(form).getByLabelText('Course title'), 'Digital Signal Processing');
    await user.type(within(form).getByLabelText('Credits'), '3');
    await user.click(within(form).getByRole('button', { name: 'Add course' }));
    await user.click(await screen.findByRole('button', { name: /ECE 420 Digital Signal Processing/ }));
    await user.selectOptions(await screen.findByLabelText('Program'), 'BS Electrical and Computer Engineering');
    await user.click(within(screen.getByRole('form', { name: 'Add to a program' })).getByRole('button', { name: 'Add' }));
    await screen.findByText(/3 credits · 0 CLOs · BS Electrical and Computer Engineering/);
    await user.click(screen.getByRole('button', { name: 'Add CLO' }));
    await user.type(await screen.findByLabelText('CLO code'), 'CLO1');
    await user.type(screen.getByLabelText('CLO statement'), 'Analyse discrete-time signals');
    await user.selectOptions(screen.getByLabelText('CLO Bloom level'), 'analyze');
    await user.click(screen.getByRole('button', { name: 'Add CLO' }));
    await screen.findByText('Analyse discrete-time signals');
  });

  const openOutcomesDialog = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: 'Outcomes of BS Electrical and Computer Engineering' }));
    await user.click(await screen.findByRole('button', { name: 'Add PEOs and PLOs' }));
    return screen.findByRole('dialog', { name: 'Edit BS Electrical and Computer Engineering' });
  };

  it('adds a PLO in the program dialog, maps the CLO at a level and shows the map and the coverage', async () => {
    const user = userEvent.setup();
    page('admin', 'programs');
    const dlg = await openOutcomesDialog(user);
    await user.click(within(dlg).getByRole('button', { name: 'Add PLO' }));
    await user.type(within(dlg).getByLabelText('PLO 1 code'), 'SO1');
    await user.type(within(dlg).getByLabelText('PLO 1 statement'), 'Solve complex engineering problems');
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The map and the coverage are on their own tab, not on the program's Outcomes page.
    expect(screen.queryByRole('region', { name: 'Curriculum map' })).toBeNull();
    cleanup();
    page('admin', 'map');
    const pick = await screen.findByLabelText('Program') as HTMLSelectElement;
    await waitFor(() => expect(pick.selectedOptions[0]!.textContent).toMatch(/BS Electrical and Computer Engineering/));
    const coverage = await screen.findByRole('region', { name: 'Coverage' });
    await within(coverage).findByText('SO1 has no course outcome mapped to it');
    await user.click(await screen.findByRole('button', { name: 'ECE 420 SO1: not mapped' }));
    await user.selectOptions(await screen.findByLabelText('CLO1 level for SO1'), 'M');
    await screen.findByRole('button', { name: 'ECE 420 SO1: Mastered' });
    await within(coverage).findByText(/Every PLO is mapped and reaches mastery/);
  });

  it('adds PEOs and several PLOs in one dialog: Add another brings the next code, and the panel has no add buttons of its own', async () => {
    const user = userEvent.setup();
    page('admin', 'programs');
    await user.click(await screen.findByRole('button', { name: 'Outcomes of BS Electrical and Computer Engineering' }));
    await screen.findByRole('region', { name: 'Program learning outcomes' });
    expect(screen.queryByRole('button', { name: 'Add PLO' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add PEO' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Add PEOs and PLOs' }));
    const dlg = await screen.findByRole('dialog', { name: 'Edit BS Electrical and Computer Engineering' });
    await user.click(within(dlg).getByRole('button', { name: 'Add PEO' }));
    await user.type(within(dlg).getByLabelText('PEO 1 code'), 'PEO1');
    await user.type(within(dlg).getByLabelText('PEO 1 statement'), 'Graduates lead engineering projects');
    await user.click(within(dlg).getByRole('button', { name: 'Add PLO' }));
    // The first row already holds the next code after the PLOs the program has; replace it.
    await user.clear(within(dlg).getByLabelText('PLO 1 code'));
    await user.type(within(dlg).getByLabelText('PLO 1 code'), 'PLO7');
    await user.type(within(dlg).getByLabelText('PLO 1 statement'), 'Communicate effectively');
    const plosGroup = within(dlg).getByRole('group', { name: 'Program learning outcomes (PLOs)' });
    await user.click(within(plosGroup).getByRole('button', { name: 'Add another' }));
    expect((within(plosGroup).getByLabelText('PLO 2 code') as HTMLInputElement).value).toBe('PLO8');
    await user.type(within(plosGroup).getByLabelText('PLO 2 statement'), 'Work in teams');
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const plos = await screen.findByRole('region', { name: 'Program learning outcomes' });
    await within(plos).findByText('Work in teams');
    expect(within(plos).getByText('Communicate effectively')).toBeTruthy();
    expect(within(await screen.findByRole('region', { name: 'Program educational objectives' })).getByText('Graduates lead engineering projects')).toBeTruthy();
  });

  it('adds an ILO, links a PLO to it, and shows a viewer everything without the buttons', async () => {
    const user = userEvent.setup();
    const first = page('admin', 'outcomes');
    await user.click(await screen.findByRole('button', { name: 'Add ILO' }));
    await user.type(await screen.findByLabelText('ILO code'), 'ILO1');
    await user.type(screen.getByLabelText('ILO statement'), 'Critical thinking');
    await user.click(screen.getByRole('button', { name: 'Add ILO' }));
    await screen.findByText('Critical thinking');
    expect(screen.getByLabelText('Level 2 name')).toHaveProperty('value', 'Reinforced');
    first.unmount();
    page('admin', 'programs');
    await user.click(await screen.findByRole('button', { name: 'Outcomes of BS Electrical and Computer Engineering' }));
    await user.click(await screen.findByRole('button', { name: 'Link SO1 to ILO1' }));
    await screen.findByRole('button', { name: 'Unlink SO1 to ILO1' });
    cleanup();
    page('viewer', 'programs');
    await user.click(await screen.findByRole('button', { name: 'Outcomes of BS Electrical and Computer Engineering' }));
    await screen.findByText('Solve complex engineering problems');
    expect(screen.queryByRole('button', { name: 'Add PLO' })).toBeNull();
    expect((await screen.findByRole('button', { name: 'Unlink SO1 to ILO1' })).hasAttribute('disabled')).toBe(true);
    cleanup();
    page('viewer', 'map');
    expect((await screen.findByRole('button', { name: 'ECE 420 SO1: Mastered' })).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('form', { name: 'Add a course to the program' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'ECE 420 SO1: Mastered' })).toBeTruthy());
  });

  it('adds a review finding on a criterion and shows it in the Review heatmap', async () => {
    const user = userEvent.setup();
    page('admin', 'programs');
    await user.click(await screen.findByRole('button', { name: 'Outcomes of BS Electrical and Computer Engineering' }));
    const criterion = await screen.findByRole('listitem', { name: '4. PLO-to-CLO mapping' });
    expect(within(criterion).getByText('Not reviewed')).toBeTruthy();
    await user.click(within(criterion).getByRole('button', { name: 'Add finding' }));
    await user.selectOptions(within(criterion).getByLabelText('Level'), 'Developing');
    await user.type(within(criterion).getByLabelText('Finding'), 'Map with levels for one course; others missing.');
    await user.click(within(criterion).getByRole('button', { name: 'Add finding' }));
    await within(criterion).findByText('Map with levels for one course; others missing.');
    await user.click(screen.getByRole('button', { name: '← Programs' }));
    await user.click(screen.getByRole('tab', { name: 'Review' }));
    await screen.findByLabelText('BS Electrical and Computer Engineering, PLO-to-CLO mapping: Developing');
  });

  it('plans, computes attainment, records results against the target, and starts a corrective action', async () => {
    const user = userEvent.setup();
    await db.su.query(`update institution set assessment_benchmarks = '{"ploScore": 85, "cloScore": 70}'`);
    page('admin', 'programs');
    await user.click(await screen.findByRole('button', { name: 'Outcomes of BS Electrical and Computer Engineering' }));
    const card = await screen.findByRole('region', { name: 'Assessment' });
    await user.clear(await within(card).findByLabelText('Academic year'));
    await user.type(within(card).getByLabelText('Academic year'), '2026-27');
    await user.click(within(card).getByRole('button', { name: /Start plan/ }));
    await within(card).findByText('SO1 has no direct measure in a course');
    await user.click(within(card).getByRole('button', { name: 'Plan for SO1' }));
    await user.selectOptions(within(card).getByLabelText('Direct course'), 'ECE 420');
    await user.type(within(card).getByLabelText('Direct method'), 'Final exam questions');
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(card).queryByText('SO1 has no direct measure in a course')).toBeNull());

    await user.click(within(card).getByRole('tab', { name: 'Attainment' }));
    await user.type(within(card).getByLabelText('Term'), 'Spring 2026');
    await user.click(await within(card).findByRole('button', { name: 'Add assessment' }));
    await user.type(within(card).getByLabelText('Assessment name'), 'Final');
    await user.type(within(card).getByLabelText('Class average'), '16');
    await user.type(within(card).getByLabelText('Part 1 marks'), '20');
    await user.click(within(card).getByLabelText('Part 1 assesses CLO1'));
    await user.click(within(card).getByRole('button', { name: 'Save assessment' }));
    await within(card).findByText(/PLOs: SO1 80%/);
    await user.click(within(card).getByRole('button', { name: 'Record as results' }));
    await within(card).findByText('Recorded 2 results.');

    await user.click(within(card).getByRole('tab', { name: 'Results' }));
    const table = await within(card).findByRole('table', { name: 'Results' });
    const row = within(table).getAllByRole('row').find((r) => r.textContent?.startsWith('SO1'))!;
    expect(row.textContent).toContain('Below target');
    await user.click(within(card).getByRole('tab', { name: /Actions \(1 gaps\)/ }));
    await user.click(await within(card).findByRole('button', { name: 'Start action' }));
    await user.type(within(card).getByLabelText('Action'), 'More practice on discrete-time systems');
    await user.click(within(card).getByRole('button', { name: 'Save action' }));
    await within(card).findByText(/Action: More practice on discrete-time systems/);
    await waitFor(() => expect(within(card).getByRole('tab', { name: 'Actions' })).toBeTruthy());
  });
});
