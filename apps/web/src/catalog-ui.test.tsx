// @vitest-environment jsdom
// The catalog's structure screens (DEC-046): General education (credits, areas, pools) and a program's requirements (concentrations, block
// credits, the study plan's blocks, elective slots, and what the checks flag), against the real API and database.
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
import { catalogApi } from './lib/catalog-api';
import { outcomesApi } from './lib/outcomes-api';
import { settingsApi } from './lib/settings-api';
import { GenedSection } from './pages/settings/gened';
import { ProgramPage } from './pages/settings/program-page';

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
const mount = (node: React.ReactNode) => {
  const router = createRouter({ routeTree: createRootRoute({ component: () => <>{node}</> }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
};
const apis = (who: string) => { const f = fetcherOf(who); return { api: settingsApi(createApi(f), f), outcomes: outcomesApi(f), catalog: catalogApi(f) }; };
const programPage = (who: string) => { const a = apis(who); return mount(<ProgramPage programId={ids.prog!} api={a.api} outcomes={a.outcomes} catalog={a.catalog} onSaved={() => undefined} onCancel={() => undefined} />); };

beforeAll(async () => {
  db = await createTestDb('webcatalog');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2 || '@x.org') returning id`, [ids.inst, n]);
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1), ($1, $3, 'viewer', 'institution', $1)`, [ids.inst, ids.admin, ids.viewer]);
  ids.unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Business') returning id`, [ids.inst]);
  ids.prog = await one(`insert into program (institution_id, org_unit_id, code, name_en, name_ar, degree_level, mode, credits, duration_years, contact_hours, language_of_instruction, mission) values ($1, $2, 'BBA', 'BBA Accounting', 'ب', 'bachelor', 'on_campus', 9, 4, 1500, 'English', 'To teach.') returning id`, [ids.inst, ids.unit]);
  for (const [code, title, credits] of [['ENG 101', 'English I', 3], ['ACC 201', 'Intermediate Accounting', 3], ['ACC 301', 'Auditing', 3]] as const) {
    ids[code] = await one(`insert into course (institution_id, org_unit_id, code, title_en, credits) values ($1, $2, $3, $4, $5) returning id`, [ids.inst, ids.unit, code, title, credits]);
    await db.su.query(`insert into course_program (institution_id, course_id, program_id, role) values ($1, $2, $3, 'core')`, [ids.inst, ids[code], ids.prog]);
  }
}, 120000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

describe('General education', () => {
  it('sets the credits, adds an area with its minimum and puts a course in its pool; a viewer can only read', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    mount(<GenedSection api={a.api} catalog={a.catalog} outcomes={a.outcomes} />);
    await screen.findByRole('button', { name: 'Add area' }); // shown once the person's permissions have loaded
    await user.type(await screen.findByLabelText('General education credits', { selector: 'input' }), '3');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await a.catalog.gened()).settings.genedCredits).toBe(3));
    await user.type(await screen.findByLabelText('Area code'), 'ENG');
    await user.type(screen.getByLabelText('Area name'), 'English');
    await user.click(screen.getByRole('button', { name: 'Add area' }));
    const area = await screen.findByTestId('area');
    expect(area.textContent).toMatch(/ENG English.*At least 3 credits · 0 courses/);
    await user.click(within(area).getByRole('button', { name: 'Pool of English' }));
    await user.click(await screen.findByLabelText('ENG 101 in English'));
    await user.click(screen.getByRole('button', { name: /^Save the pool \(1\)/ }));
    await waitFor(() => expect(screen.getByTestId('area').textContent).toMatch(/1 course in the pool/));
    expect((await a.catalog.gened()).settings.genedCredits).toBe(3);
    cleanup();
    const v = apis('viewer');
    mount(<GenedSection api={v.api} catalog={v.catalog} outcomes={v.outcomes} />);
    await screen.findByTestId('area');
    expect(screen.queryByRole('button', { name: 'Add area' })).toBeNull();
    expect(screen.getByText(/Academic Affairs changes it/)).toBeTruthy();
  });
});

describe('a program\'s requirements', () => {
  it('flags a plan that does not add up, then agrees once blocks, a concentration and a slot are set', async () => {
    const user = userEvent.setup();
    programPage('admin');
    const section = await screen.findByRole('region', { name: 'Requirements' });
    // No block yet: the courses are not counted.
    expect((await within(section).findByRole('list', { name: 'To look at' })).textContent).toMatch(/3 courses are in no block/);
    // The selects are enabled once the person's permissions have loaded.
    await waitFor(() => expect((within(section).getByLabelText('Block of ENG 101') as HTMLSelectElement).disabled).toBe(false));
    await user.selectOptions(within(section).getByLabelText('Block of ENG 101'), 'general_education');
    await waitFor(() => expect((within(section).getByLabelText('Block of ENG 101') as HTMLSelectElement).value).toBe('general_education'));
    await user.selectOptions(within(section).getByLabelText('Block of ACC 201'), 'major');
    await waitFor(() => expect((within(section).getByLabelText('Block of ACC 201') as HTMLSelectElement).value).toBe('major'));
    // A concentration, and a course in it.
    await user.type(within(section).getByLabelText('Concentration code'), 'AUD');
    await user.type(within(section).getByLabelText('Concentration name'), 'Auditing');
    await user.click(within(section).getByRole('button', { name: 'Add concentration' }));
    await within(section).findByRole('list', { name: 'Concentrations' });
    await user.selectOptions(await within(section).findByLabelText('Block of ACC 301'), 'concentration');
    await waitFor(() => expect((within(section).getByLabelText('Block of ACC 301') as HTMLSelectElement).value).toBe('concentration'));
    await user.selectOptions(await within(section).findByLabelText('Concentration of ACC 301'), (await catalogApi(fetcherOf('admin')).requirements(ids.prog!)).concentrations[0]!.id);
    // 3 + 3 + 3 = 9: the credits add up (no General education total is set on this program's check besides 3).
    await waitFor(() => expect((within(section).queryByRole('status')?.textContent ?? within(section).queryByRole('list', { name: 'To look at' })?.textContent)).toMatch(/credits add up/));
    // The credits asked of a block: Major core 6 while 3 are planned.
    const asked = within(section).getByLabelText('Core credits of Major requirements');
    await user.clear(asked); await user.type(asked, '6'); await user.tab();
    await waitFor(() => expect(within(section).getByRole('list', { name: 'To look at' }).textContent).toMatch(/Major core credits: 3 planned, 6 asked\./));
    // An elective slot of 3 credits in the Major raises the plan, but the elective is not core: the core is still short.
    await user.type(within(section).getByLabelText('Slot name'), 'Major elective');
    await user.type(within(section).getByLabelText('Slot rule'), 'Any ACC 4xx');
    await user.click(within(section).getByRole('button', { name: 'Add slot' }));
    expect((await within(section).findByTestId('slot')).textContent).toMatch(/Major elective.*Major requirements.*3 credits.*Any ACC 4xx/);
    await waitFor(() => expect(within(section).getByRole('list', { name: 'To look at' }).textContent).toMatch(/With Auditing, the blocks add up to 12 credits, the program has 9\./));
  }, 60000);

  it('is read-only for a viewer', async () => {
    programPage('viewer');
    const section = await screen.findByRole('region', { name: 'Requirements' });
    await within(section).findByLabelText('Block of ENG 101');
    expect((within(section).getByLabelText('Block of ENG 101') as HTMLSelectElement).disabled).toBe(true);
    expect(within(section).queryByRole('button', { name: 'Add slot' })).toBeNull();
  });
});
