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
  const ui = <OrganizationPage api={settingsApi(createApi(f), f)} outcomes={outcomesApi(f)} tab={tab} />;
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

  it('adds a PLO, maps the CLO at a level and shows the map and the coverage', async () => {
    const user = userEvent.setup();
    page('admin', 'programs');
    await user.click(await screen.findByRole('button', { name: 'Outcomes of BS Electrical and Computer Engineering' }));
    const plos = await screen.findByRole('region', { name: 'Program learning outcomes' });
    await user.click(within(plos).getByRole('button', { name: 'Add PLO' }));
    await user.type(within(plos).getByLabelText('PLO code'), 'SO1');
    await user.type(within(plos).getByLabelText('PLO statement'), 'Solve complex engineering problems');
    await user.click(within(plos).getByRole('button', { name: 'Add PLO' }));
    const coverage = await screen.findByRole('region', { name: 'Coverage' });
    await within(coverage).findByText('SO1 has no course outcome mapped to it');
    await user.click(await screen.findByRole('button', { name: 'ECE 420 SO1: not mapped' }));
    await user.selectOptions(await screen.findByLabelText('CLO1 level for SO1'), 'M');
    await screen.findByRole('button', { name: 'ECE 420 SO1: Mastered' });
    await within(coverage).findByText(/Every PLO is mapped and reaches mastery/);
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
});
