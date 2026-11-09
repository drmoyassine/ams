// @vitest-environment jsdom
// The syllabus screens (TASK-125): the editor with rules checked live, the flag banner, the workflow through each role (instructor
// suggests, coordinator submits, chair endorses, Dean approves), the Syllabi list with "Needs me", and the limits in Settings.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { emptySyllabus, emptyWorkbook, type SyllabusContent } from '@ams/shared';
import './i18n';
import { SyllabiList } from './components/syllabus/syllabi-list';
import { SyllabusAlertBar } from './components/syllabus/syllabus-alert-bar';
import { SyllabusImport } from './components/syllabus/syllabus-import';
import { SyllabusLimits } from './components/syllabus/syllabus-limits';
import { SyllabusTemplateEditor } from './components/syllabus/syllabus-template-editor';
import { writeSyllabusWorkbook } from './lib/syllabus-sheets';
import { createApi } from './lib/api';
import { settingsApi } from './lib/settings-api';
import { scopeApi } from './lib/scope-api';
import { syllabusApi } from './lib/syllabus-api';
import { SyllabusPage } from './pages/syllabus';

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
const apisOf = (who: string) => { const a = createApi(fetcherOf(who)); const f = fetcherOf(who); return { syllabus: syllabusApi(f), settings: settingsApi(a, f), scope: scopeApi(a) }; };
const wrap = (node: React.ReactNode) => {
  const router = createRouter({ routeTree: createRootRoute({ component: () => <>{node}</> }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
};
const page = (who: string) => { const a = apisOf(who); return wrap(<SyllabusPage courseId={ids.course!} api={a.syllabus} apis={{ settings: a.settings, scope: a.scope }} />); };

/** A complete syllabus: 4 CLOs over two PLOs, two assessments adding to 100, one rubric. */
function complete(): SyllabusContent {
  const c = emptySyllabus();
  c.info = { titleEn: 'Heat Transfer', titleAr: '', credits: 3, languageOfDelivery: 'english', contactLecture: 3, contactLab: 0, contactOther: 0, courseType: 'didactic', courseLevel: '400', category: 'program_core', sustainability: 'none', prerequisiteIds: [], corequisiteIds: [] };
  c.description.en = 'Conduction, convection and radiation.'; c.methodology = 'Lectures and problem sessions.';
  c.materials = [{ kind: 'textbook', citation: 'Incropera, Heat and Mass Transfer', isbn: '', year: null }];
  c.clos = ['a', 'b', 'c', 'd'].map((id, k) => ({ id, code: `CLO${k + 1}`, textEn: `Outcome ${k + 1}`, textAr: '', bloom: 'apply', ploId: k < 2 ? ids.plo1! : ids.plo2!, level: k < 3 ? 'R' : 'M' }));
  c.rubrics = [{ id: 'r', title: 'Problem solving', levels: [{ name: 'Proficient', min: 70, max: 100 }, { name: 'Developing', min: 0, max: 69 }], criteria: [{ name: 'Method', descriptions: ['Sound', 'Partly sound'] }] }];
  c.assessments = [
    { id: 'q', name: 'Quizzes', category: 'quiz', objective: '', weight: 50, dueWeek: 6, clos: [{ cloId: 'a', share: 50, rubricId: 'r' }, { cloId: 'b', share: 50, rubricId: 'r' }] },
    { id: 'f', name: 'Final exam', category: 'final', objective: '', weight: 50, dueWeek: 15, clos: [{ cloId: 'c', share: 50, rubricId: 'r' }, { cloId: 'd', share: 50, rubricId: 'r' }] },
  ];
  return c;
}

beforeAll(async () => {
  db = await createTestDb('websyllabus');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'coordinator', 'instructor', 'chair', 'dean']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2 || '@x.org') returning id`, [ids.inst, n]);
  ids.unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.prog = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Mechanical', 'bachelor', '{}') returning id`, [ids.inst, ids.unit]);
  const grant = (u: string, role: string, scope: string, scopeId: string) => db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids.inst, ids[u], role, scope, scopeId]);
  await grant('admin', 'admin', 'institution', ids.inst!);
  for (const u of ['coordinator', 'instructor']) await grant(u, 'viewer', 'institution', ids.inst!);
  await grant('chair', 'lead', 'program', ids.prog!); await grant('chair', 'viewer', 'institution', ids.inst!);
  await grant('dean', 'lead', 'org_unit', ids.unit!); await grant('dean', 'viewer', 'institution', ids.inst!);
  ids.course = await one(`insert into course (institution_id, org_unit_id, code, title_en, coordinator_user_id) values ($1, $2, 'MCE 410', 'Heat Transfer', $3) returning id`, [ids.inst, ids.unit, ids.coordinator]);
  await db.su.query(`insert into course_program (institution_id, course_id, program_id) values ($1, $2, $3)`, [ids.inst, ids.course, ids.prog]);
  await db.su.query(`insert into course_instructor (institution_id, course_id, user_id) values ($1, $2, $3)`, [ids.inst, ids.course, ids.instructor]);
  ids.plo1 = await one(`insert into learning_outcome (institution_id, kind, program_id, code, text_en) values ($1, 'plo', $2, 'PLO1', 'Solve problems') returning id`, [ids.inst, ids.prog]);
  ids.plo2 = await one(`insert into learning_outcome (institution_id, kind, program_id, code, text_en) values ($1, 'plo', $2, 'PLO2', 'Design systems') returning id`, [ids.inst, ids.prog]);
}, 120000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

describe('the editor', () => {
  it('starts a syllabus from the course, flags what is missing as you type, and clears an error as it is fixed', async () => {
    const user = userEvent.setup();
    render(page('coordinator'));
    await user.click(await screen.findByRole('button', { name: 'Start the syllabus from the course' }));
    const banner = await screen.findByTestId('flag-banner');
    expect(banner.textContent).toMatch(/need immediate attention/);
    expect((screen.getByRole('button', { name: 'Submit for review' }) as HTMLButtonElement).disabled).toBe(true);
    const info = screen.getByRole('region', { name: 'Basic course information' });
    expect(within(info).getByText(/Credit hours are required/)).toBeTruthy();
    await user.type(within(info).getByLabelText('Credit hours'), '3');
    await waitFor(() => expect(within(info).queryByText(/Credit hours are required/)).toBeNull());
    // The coverage choices carry the full names, never an abbreviation.
    await user.click(screen.getByRole('button', { name: '+ CLO' }));
    const cov = screen.getByLabelText('CLO1 coverage') as HTMLSelectElement;
    expect([...cov.options].map((o) => o.text)).toEqual(['Choose', 'Introduced', 'Reinforced', 'Mastered']);
    expect(within(screen.getByRole('region', { name: 'Course learning outcomes (CLOs)' })).getByText(/at least 3 are required/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '+ CLO' })); await user.click(screen.getByRole('button', { name: '+ CLO' }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Course learning outcomes (CLOs)' })).queryByText(/at least 3 are required/)).toBeNull());
  });

  it('saves a draft that still has errors (a rule never stops a save), and the Syllabi list flags it to its coordinator', async () => {
    const user = userEvent.setup();
    render(page('coordinator'));
    await user.click(await screen.findByRole('button', { name: 'Start the syllabus from the course' }));
    await user.type(await screen.findByLabelText('Credit hours'), '3');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(async () => expect((await apisOf('coordinator').syllabus.overview(ids.course!)).open?.status).toBe('draft'));
    cleanup();
    const a = apisOf('coordinator');
    render(wrap(<SyllabiList api={a.syllabus} />));
    const row = await screen.findByRole('region', { name: 'Syllabus: MCE 410' });
    expect(within(row).getByTestId('errors-chip').textContent).toMatch(/error/);
    expect(within(row).getByText('Needs you')).toBeTruthy();
  });
});

describe('the workflow through each role', () => {
  it('lets the coordinator fix and submit, an instructor suggest, the chair endorse and the Dean approve; approval writes the CLOs into the view', async () => {
    const user = userEvent.setup();
    await apisOf('coordinator').syllabus.save(ids.course!, { content: complete() });
    render(page('coordinator'));
    expect((await screen.findByTestId('syllabus-status')).textContent).toBe('Draft');
    const submit = screen.getByRole('button', { name: 'Submit for review' }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    expect(screen.queryByTestId('flag-banner')).toBeNull();
    await user.click(submit);
    await waitFor(() => expect(screen.getByTestId('syllabus-status').textContent).toBe('In review'));
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    cleanup();

    render(page('instructor'));
    expect(await screen.findByTestId('syllabus-view')).toBeTruthy(); // read-only for an instructor
    expect(screen.queryByRole('button', { name: 'Endorse' })).toBeNull();
    await user.type(screen.getByLabelText('Suggestion'), 'Give CLO 3 a measurable verb');
    await user.click(screen.getByRole('button', { name: 'Suggest' }));
    expect((await screen.findByTestId('suggestion')).textContent).toMatch(/measurable verb/);
    cleanup();

    render(page('chair'));
    await user.click(await screen.findByRole('button', { name: 'Endorse' }));
    await waitFor(() => expect(screen.getByTestId('syllabus-status').textContent).toBe('Endorsed'));
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull(); // a chair does not approve
    cleanup();

    render(page('dean'));
    await user.type(await screen.findByLabelText('Effective from (term)'), 'Fall 2026');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByTestId('syllabus-status').textContent).toBe('Approved'));
    const view = screen.getByTestId('syllabus-view');
    const clos = within(within(view).getByRole('region', { name: /Course learning outcomes/ })).getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(clos[0]).toContain('PLO1'); expect(clos[0]).toContain('Reinforced'); expect(clos[3]).toContain('Mastered');
    expect((await db.su.query(`select count(*)::int as n from learning_outcome where course_id = $1 and kind = 'clo' and status = 'approved'`, [ids.course])).rows[0].n).toBe(4);
  });

  it('lets the chair send it back with a note, which the coordinator then sees', async () => {
    const user = userEvent.setup();
    await apisOf('coordinator').syllabus.save(ids.course!, { content: complete() });
    const v = (await apisOf('coordinator').syllabus.overview(ids.course!)).open!;
    await apisOf('coordinator').syllabus.submit(v.id);
    render(page('chair'));
    await user.type(await screen.findByLabelText('Return note'), 'Rubric descriptors are too thin');
    await user.click(screen.getByRole('button', { name: 'Return to coordinator' }));
    await waitFor(() => expect(screen.getByTestId('syllabus-status').textContent).toBe('Draft'));
    cleanup();
    render(page('coordinator'));
    expect((await screen.findByTestId('returned-note')).textContent).toMatch(/too thin/);
  });
});

describe('the red bar', () => {
  it('stays at the top for the person it needs while errors stand, and not for someone it does not need yet', async () => {
    const a = apisOf('coordinator');
    // The earlier tests left a draft with errors on the course.
    await a.syllabus.save(ids.course!, { content: emptySyllabus() }).catch(() => undefined);
    render(wrap(<SyllabusAlertBar enabled api={a.syllabus} />));
    const bar = await screen.findByTestId('syllabus-alert-bar');
    expect(bar.textContent).toMatch(/1 syllabus has \d+ errors? and needs your attention/);
    expect(within(bar).getByRole('link', { name: /MCE 410 \(\d+\)/ })).toBeTruthy();
    cleanup();
    // The program chair is not reached on the first day.
    render(wrap(<SyllabusAlertBar enabled api={apisOf('chair').syllabus} />));
    await new Promise((r) => setTimeout(r, 600));
    expect(screen.queryByTestId('syllabus-alert-bar')).toBeNull();
    // Once the flag is days old the line reaches the chair, and the bar shows for the chair too.
    await db.su.query(`update syllabus_version set flagged_since = now() - interval '5 days' where course_id = $1 and error_count > 0`, [ids.course]);
    cleanup();
    render(wrap(<SyllabusAlertBar enabled api={apisOf('chair').syllabus} />));
    expect((await screen.findByTestId('syllabus-alert-bar')).textContent).toMatch(/need/);
  });
});

describe('the Excel import', () => {
  it('loads a workbook as drafts, flags what breaks a rule without refusing it, and reports each course', async () => {
    const user = userEvent.setup();
    const wb = emptyWorkbook();
    wb.courses.push({ 'Course code': 'MCE 410', 'Title (English)': 'Heat Transfer', 'Credit hours': 3 }, { 'Course code': 'GHOST 1', 'Title (English)': 'Nothing' });
    wb.clos.push({ 'Course code': 'MCE 410', CLO: 'CLO1', 'Outcome (English)': 'Analyse conduction', 'Bloom level': 'Analyze', PLO: 'PLO1', Coverage: 'Introduced' });
    const blob = await writeSyllabusWorkbook(wb);
    const file = new File([await blob.arrayBuffer()], 'syllabi.xlsx', { type: blob.type });
    // A draft in progress is replaced by the import, so start from the state the earlier tests left (an open draft or none).
    render(wrap(<SyllabusImport api={apisOf('coordinator').syllabus} />));
    await user.upload(await screen.findByLabelText('Syllabus workbook'), file);
    const result = await screen.findByTestId('import-result');
    expect(result.textContent).toMatch(/1 syllabus loaded, 1 flagged/);
    expect(result.textContent).toMatch(/MCE 410: Loaded as a draft/);
    expect(result.textContent).toMatch(/GHOST 1: Skipped: no such course/);
    const open = (await apisOf('coordinator').syllabus.overview(ids.course!)).open!;
    expect(open).toMatchObject({ status: 'draft', source: 'excel import' });
    expect(open.content.clos[0]).toMatchObject({ code: 'CLO1', level: 'I', bloom: 'analyze' });
  });
});

describe('the template', () => {
  it('lets an admin add a section and make a field optional; it then appears in the coordinator\'s draft, and a required section cannot be removed', async () => {
    const user = userEvent.setup();
    const a = apisOf('admin');
    render(wrap(<SyllabusTemplateEditor canWrite api={a.syllabus} />));
    const list = await screen.findByRole('list', { name: 'Sections' });
    expect(within(list).queryByRole('button', { name: /^Remove Basic course information/ })).toBeNull(); // only added sections can be removed
    await user.type(screen.getByLabelText('New section title'), 'Industry links');
    await user.click(screen.getByRole('button', { name: '+ Section' }));
    await user.click(screen.getByLabelText('Teaching methodology is required'));
    await user.click(screen.getByRole('button', { name: 'Save the sections' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Saved/);
    cleanup();
    await a.syllabus.discard(ids.course!).catch(() => undefined);
    render(page('coordinator'));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Start a new version' })); // the course has an approved version from the workflow tests
    const industry = await screen.findByRole('region', { name: 'Industry links' });
    expect(within(industry).getByLabelText('Industry links')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Teaching methodology' })).queryByText(/methodology is required/)).toBeNull();
    // Put the template back.
    await a.syllabus.setTemplate((await import('@ams/shared')).DEFAULT_SYLLABUS_TEMPLATE);
  });
});

describe('the limits', () => {
  it('lets an admin tighten a limit and flags the syllabus; the Syllabi list filters to the errors', async () => {
    const user = userEvent.setup();
    const a = apisOf('admin');
    render(wrap(<SyllabusLimits canWrite api={a.syllabus} />));
    const max = await screen.findByLabelText('Maximum CLOs per course') as HTMLInputElement;
    await waitFor(() => expect(max.value).toBe('8')); // the saved value has loaded
    await user.clear(max); await user.type(max, '3');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Saved/);
    cleanup();
    render(wrap(<SyllabiList api={a.syllabus} />));
    await user.click(await screen.findByRole('button', { name: 'With errors' }));
    const row = await screen.findByRole('region', { name: 'Syllabus: MCE 410' });
    expect(within(row).getByTestId('errors-chip')).toBeTruthy();
    await a.syllabus.setSettings({ ...(await a.syllabus.settings()), maxClos: 8 });
  });

  it('shows a viewer the limits read-only', async () => {
    render(wrap(<SyllabusLimits canWrite={false} api={apisOf('instructor').syllabus} />));
    expect((await screen.findByLabelText('Maximum CLOs per course') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
