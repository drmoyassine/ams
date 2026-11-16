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
import { syllabusApi } from './lib/syllabus-api';
import { OrganizationPage, type OrganizationTab } from './pages/settings/organization';
import { ProgramQualityTab } from './pages/program-quality';
import { ProgramPage } from './pages/settings/program-page';
import { useMe } from './lib/me';
import type { SettingsApi } from './lib/settings-api';

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
  const ui = <OrganizationPage api={settingsApi(createApi(f), f)} outcomes={outcomesApi(f)} assessment={assessmentApi(f)} syllabus={syllabusApi(f)} tab={tab} />;
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
}

/** The program's own page (Settings -> Organization -> Programs -> the program). */
function programPage(who: string) {
  const f = fetchAs(who);
  const ui = <ProgramPage programId={ids.prog!} api={settingsApi(createApi(f), f)} outcomes={outcomesApi(f)} syllabus={syllabusApi(f)} onSaved={() => undefined} onCancel={() => undefined} />;
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
}

/** Quality Management -> Programs: each program's assessment of learning and review. */
function QmPrograms({ settings, f }: { settings: SettingsApi; f: typeof fetch }) {
  const me = useMe(settings);
  return <ProgramQualityTab me={me.data} settings={settings} outcomes={outcomesApi(f)} assessment={assessmentApi(f)} />;
}
function qmPage(who: string) {
  const f = fetchAs(who);
  const ui = <QmPrograms settings={settingsApi(createApi(f), f)} f={f} />;
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
  // A complete record (the program's page refuses to save without one) with one PEO already.
  await db.su.query(`update program set name_ar = 'بكالوريوس الهندسة الكهربائية', code = 'BS-ECE', mode = 'on_campus', credits = 130, duration_years = 4, contact_hours = 2000, language_of_instruction = 'English', mission = 'To educate engineers.' where id = $1`, [ids.prog]);
  await db.su.query(`insert into learning_outcome (institution_id, kind, program_id, code, text_en) values ($1, 'peo', $2, 'PEO0', 'Graduates keep learning')`, [ids.inst, ids.prog]);
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

  // A program's PEOs and PLOs are added and edited on its own page (there is no Outcomes page and no dialog).
  const openOutcomesDialog = async (_user?: unknown) => {
    expect(screen.queryByRole('button', { name: /^Outcomes of / })).toBeNull();
    cleanup();
    programPage('admin');
    await screen.findByRole('heading', { name: 'BS Electrical and Computer Engineering' });
    return document.body;
  };

  it('adds a PLO in the program dialog, maps the CLO at a level and shows the map and the coverage', async () => {
    const user = userEvent.setup();
    page('admin', 'programs');
    const dlg = await openOutcomesDialog(user);
    await user.click(within(dlg).getByRole('button', { name: 'Add PLO' }));
    await user.clear(within(dlg).getByLabelText('PLO 1 code')); // it starts as PLO1
    await user.type(within(dlg).getByLabelText('PLO 1 code'), 'SO1');
    await user.type(within(dlg).getByLabelText('PLO 1 statement'), 'Solve complex engineering problems');
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await screen.findByRole('status');
    cleanup();
    page('admin', 'map');
    const pick = await screen.findByLabelText('Program') as HTMLSelectElement;
    await waitFor(() => expect(pick.selectedOptions[0]!.textContent).toMatch(/BS Electrical and Computer Engineering/));
    const coverage = await screen.findByRole('region', { name: 'Coverage' });
    await within(coverage).findByText('SO1 has no course mapped to it');
    // The hint says what a click does; an empty cell is a button.
    screen.getByText(/Click a cell to set the course's level for a PLO or to link its CLOs/);
    await user.click(await screen.findByRole('button', { name: 'ECE 420 SO1: not mapped' }));
    // A change goes into the course's syllabus draft (DEC-039): the cell shows it waiting, the live map and coverage do not move yet.
    await user.selectOptions(await screen.findByLabelText('CLO1 level for SO1'), 'M');
    await screen.findByRole('button', { name: 'ECE 420 SO1: Mastered, waiting for approval (was not mapped)' });
    const pending = screen.getByRole('region', { name: 'Changes waiting for approval' });
    within(pending).getByText(/ECE 420 · v1 draft/);
    within(coverage).getByText('SO1 has no course mapped to it');
    // Submitting it is refused while the syllabus has errors (it is far from complete), and says so.
    await user.click(within(pending).getByRole('button', { name: 'Submit it for approval' }));
    expect((await within(pending).findByRole('status')).textContent).toMatch(/ECE 420: the syllabus has \d+ errors to fix/);
    // For the tests that follow, the mapping is as if approved: CLO1 -> SO1 at M, and no draft.
    await db.su.query(`delete from syllabus_version`);
    const so1 = (await db.su.query(`select id from learning_outcome where code = 'SO1'`)).rows[0].id;
    const clo1 = (await db.su.query(`select id from learning_outcome where code = 'CLO1' and kind = 'clo'`)).rows[0].id;
    await db.su.query(`insert into outcome_link (institution_id, from_id, to_id, level) values ($1, $2, $3, 'M')`, [ids.inst, clo1, so1]);
    cleanup();
    page('admin', 'map');
    const coverage2 = await screen.findByRole('region', { name: 'Coverage' });
    await screen.findByRole('button', { name: 'ECE 420 SO1: Mastered' });
    await waitFor(() => expect(within(coverage2).queryByText(/SO1/)).toBeNull());
    // The syllabus rules' minimum CLOs per course is flagged here too (ECE 420 has one CLO; the default minimum is three).
    within(coverage2).getByText('ECE 420 has 1 CLO; the syllabus rules ask for at least 3');
  });

  it('adds PEOs and several PLOs in one dialog (Add another brings the next code), and edits the recorded ones in the same dialog', async () => {
    const user = userEvent.setup();
    page('admin', 'programs');
    const dlg = await openOutcomesDialog(user);
    // The recorded PLO is listed in the dialog, editable in place.
    await within(dlg).findByText('Solve complex engineering problems');
    await user.click(within(dlg).getByRole('button', { name: 'Add PEO' }));
    expect((within(dlg).getByLabelText('PEO 1 code') as HTMLInputElement).value).toBe('PEO1'); // the next code after PEO0
    await user.type(within(dlg).getByLabelText('PEO 1 statement'), 'Graduates lead engineering projects');
    await user.click(within(dlg).getByRole('button', { name: 'Add PLO' }));
    // The first row already holds the next code after the PLOs the program has; replace it.
    await user.clear(within(dlg).getByLabelText('PLO 1 code'));
    await user.type(within(dlg).getByLabelText('PLO 1 code'), 'PLO7');
    await user.type(within(dlg).getByLabelText('PLO 1 statement'), 'Communicate effectively');
    const plosGroup = within(dlg).getByRole('group', { name: 'Program learning outcomes (PLOs) *' });
    await user.click(within(plosGroup).getByRole('button', { name: 'Add another' }));
    expect((within(plosGroup).getByLabelText('PLO 2 code') as HTMLInputElement).value).toBe('PLO8');
    await user.type(within(plosGroup).getByLabelText('PLO 2 statement'), 'Work in teams');
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await screen.findByRole('status');
    // Opened again, the dialog lists them all as recorded; one is edited in place and saved on its own.
    const again = await openOutcomesDialog(user);
    const plos = within(again).getByRole('group', { name: 'Program learning outcomes (PLOs) *' });
    await within(plos).findByText('Work in teams');
    expect(within(plos).getByText('Communicate effectively')).toBeTruthy();
    within(within(again).getByRole('group', { name: 'Program educational objectives (PEOs) *' })).getByText('Graduates lead engineering projects');
    await user.click(within(plos).getByRole('button', { name: 'Edit PLO8' }));
    const statement = within(plos).getByLabelText('PLO statement') as HTMLInputElement;
    await user.clear(statement);
    await user.type(statement, 'Work effectively in teams');
    await user.click(within(plos).getByRole('button', { name: 'Save' }));
    await within(plos).findByText('Work effectively in teams');
    // A PLO's performance indicators are added under it, in the dialog.
    const so1 = within(plos).getAllByTestId('outcome').find((li) => li.textContent?.includes('SO1'))!;
    await user.click(within(so1).getByRole('button', { name: '0 performance indicators' }));
    await user.click(within(so1).getByRole('button', { name: 'Add indicator' }));
    await user.type(within(so1).getByLabelText('indicator code'), 'SO1.1');
    await user.type(within(so1).getByLabelText('indicator statement'), 'Identify the problem');
    await user.click(within(so1).getByRole('button', { name: 'Add indicator' }));
    await within(so1).findByText('Identify the problem');
    // Under the PLO: its courses and CLOs at a glance, opening into the same block as the map's By PLO view (DEC-039).
    const courses = within(so1).getByRole('button', { name: 'SO1 courses and CLOs: 1 course · I 0 · R 0 · M 1 · 1 CLO' });
    await user.click(courses);
    within(so1).getByText('CLOs: CLO1');
    expect(within(so1).getByLabelText('ECE 420 level for SO1 (by PLO)')).toBeTruthy();
  });

  it('maps a course to a PLO top-down from the PLO view as a draft change, and asks before moving a CLO to another PLO', async () => {
    const user = userEvent.setup();
    page('admin', 'map');
    await user.click(await screen.findByRole('tab', { name: 'By PLO' }));
    const plo7 = await screen.findByRole('group', { name: 'PLO7 courses' });
    within(plo7).getByText('No course mapped yet.');
    await user.selectOptions(within(plo7).getByLabelText('Course for PLO7'), 'ECE 420 Digital Signal Processing');
    await user.selectOptions(within(plo7).getByLabelText('Level for PLO7'), 'M');
    await user.click(within(plo7).getByRole('button', { name: 'Map' }));
    // Waiting for approval, and flagged: the course would cover PLO7 at M with no CLO behind it.
    await within(plo7).findByText('waiting for approval');
    within(plo7).getByText('Mastered (course), no CLO');
    within(screen.getByRole('region', { name: 'Changes waiting for approval' })).getByText(/ECE 420 · v1 draft/);
    // CLO1 already serves SO1 and the rules allow one PLO per CLO: linking it to PLO7 asks to move it.
    await user.click(within(plo7).getByRole('button', { name: 'Link CLOs' }));
    within(plo7).getByText(/Showing ECE 420's syllabus draft \(v1\)/);
    await user.selectOptions(within(plo7).getByLabelText('CLO1 level for PLO7'), 'R');
    const ask = await screen.findByRole('dialog', { name: 'Move CLO1 to PLO7?' });
    await user.click(within(ask).getByRole('button', { name: 'Move it' }));
    await within(plo7).findByText('Mastered (course), CLOs reach Reinforced');
    const draft = (await db.su.query(`select content from syllabus_version`)).rows[0].content;
    expect(draft.clos[0].plos).toEqual([{ ploId: (await db.su.query(`select id from learning_outcome where code = 'PLO7'`)).rows[0].id, level: 'R' }]);
    // The grid shows the same cell waiting; the live map still has CLO1 on SO1.
    await user.click(screen.getByRole('tab', { name: 'By course' }));
    await screen.findByRole('button', { name: 'ECE 420 PLO7: Mastered (course), CLOs reach Reinforced, waiting for approval (was not mapped)' });
    // CLO1 moved to PLO7 in the draft: its SO1 cell would empty (the live map keeps it until approval).
    screen.getByRole('button', { name: 'ECE 420 SO1: not mapped, waiting for approval (was Mastered)' });
    // Leave things as approved for the later tests.
    await db.su.query(`delete from syllabus_version`);
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
    // The PLO's links to ILOs and PEOs are chips under it in the program's dialog.
    const dlg = await openOutcomesDialog(user);
    await user.click(await within(dlg).findByRole('button', { name: 'Link SO1 to ILO1' }));
    await within(dlg).findByRole('button', { name: 'Unlink SO1 to ILO1' });
    cleanup();
    // A viewer has no Edit and no Outcomes button; the PLOs are read on the Curriculum map, by PLO.
    page('viewer', 'programs');
    await screen.findByText('BS Electrical and Computer Engineering');
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Outcomes of / })).toBeNull();
    cleanup();
    page('viewer', 'map');
    expect((await screen.findByRole('button', { name: 'ECE 420 SO1: Mastered' })).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('form', { name: 'Add a course to the program' })).toBeNull();
    // ILOs are columns after the PLOs: ECE 420 reaches ILO1 through SO1, at SO1's level; the totals row counts the courses.
    expect(screen.getByRole('img', { name: 'ECE 420 ILO1: Mastered (through SO1)' }).textContent).toBe('M');
    expect(screen.getByLabelText('SO1 totals: 0 Introduced, 0 Reinforced, 1 Mastered')).toBeTruthy();
    expect(screen.getByText('Year not set')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download (Excel)' })).toBeTruthy();
    const user2 = userEvent.setup();
    await user2.click(screen.getByRole('tab', { name: 'By PLO' }));
    await screen.findByText('Solve complex engineering problems');
  });

  it('adds a review finding on a criterion and shows it in the Review heatmap', async () => {
    const user = userEvent.setup();
    // A program's review is in Quality Management -> Programs, under the review of every program.
    qmPage('admin');
    const criterion = await screen.findByRole('listitem', { name: '4. PLO-to-CLO mapping' });
    expect(within(criterion).getByText('Not reviewed')).toBeTruthy();
    await user.click(within(criterion).getByRole('button', { name: 'Add finding' }));
    await user.selectOptions(within(criterion).getByLabelText('Level'), 'Developing');
    await user.type(within(criterion).getByLabelText('Finding'), 'Map with levels for one course; others missing.');
    await user.click(within(criterion).getByRole('button', { name: 'Add finding' }));
    await within(criterion).findByText('Map with levels for one course; others missing.');
    await screen.findByLabelText('BS Electrical and Computer Engineering, PLO-to-CLO mapping: Developing');
  });

  it('plans, computes attainment, records results against the target, and starts a corrective action', async () => {
    const user = userEvent.setup();
    await db.su.query(`update institution set assessment_benchmarks = '{"ploScore": 85, "cloScore": 70}'`);
    qmPage('admin');
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
