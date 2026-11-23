// @vitest-environment jsdom
// The course page (DEC-042): a new course needs a unit, credit hours and a program it serves; once its content is approved, the title and
// credit hours change only through the draft, while the record (code, year, SIS code) still saves at once.
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
import { outcomesApi } from './lib/outcomes-api';
import { settingsApi } from './lib/settings-api';
import { syllabusApi } from './lib/syllabus-api';
import { CoursePage } from './pages/settings/course-page';

configure({ asyncUtilTimeout: 15000 });
let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids.admin}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const render_ = (courseId: string, onSaved: (id: string) => void = () => undefined) => {
  const node = <CoursePage courseId={courseId} api={settingsApi(createApi(fetcher), fetcher)} outcomes={outcomesApi(fetcher)} syllabus={syllabusApi(fetcher)} onSaved={onSaved} onCancel={() => undefined} />;
  const router = createRouter({ routeTree: createRootRoute({ component: () => <>{node}</> }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
};

beforeAll(async () => {
  db = await createTestDb('webcoursepage');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  ids.admin = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'Admin', 'admin@x.org') returning id`, [ids.inst]);
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.inst, ids.admin]);
  ids.unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.prog = await one(`insert into program (institution_id, org_unit_id, code, name_en, degree_level, tags) values ($1, $2, 'BSME', 'BS Mechanical', 'bachelor', '{}') returning id`, [ids.inst, ids.unit]);
}, 120000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

describe('a new course', () => {
  it('asks for the unit, credit hours and a program, then saves the course with its placement', async () => {
    const user = userEvent.setup();
    let saved = '';
    render_('new', (id) => { saved = id; });
    const code = await screen.findByLabelText('Course code');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add course' })).toBeTruthy()); // shown once the person may write
    await user.type(code, 'MCE 410');
    await user.type(screen.getByLabelText('Course title'), 'Heat Transfer');
    await user.click(screen.getByRole('button', { name: 'Add course' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Unit, Credit hours, A program \(its study plan\)/);
    await user.selectOptions(screen.getByLabelText('Owning unit'), ids.unit!);
    await user.type(screen.getByLabelText('Credit hours'), '3');
    await waitFor(() => expect(screen.getByRole('option', { name: /BSME/ })).toBeTruthy());
    await user.selectOptions(screen.getByLabelText('Program'), ids.prog!);
    await user.click(screen.getByRole('button', { name: 'Add course' }));
    await waitFor(() => expect(saved || screen.queryByRole('alert')?.textContent).toMatch(/^[0-9a-f-]{36}$/));
    const c = (await outcomesApi(fetcher).courses()).find((x) => x.id === saved)!;
    expect(c).toMatchObject({ code: 'MCE 410', credits: 3, orgUnitId: ids.unit, programIds: [ids.prog], missing: [], approved: false });
    ids.course = saved;
  }, 30000);
});

describe('a course with approved content', () => {
  it('locks the title and credit hours on the page and refuses them over the API, while the record still saves', async () => {
    await db.su.query(`update syllabus_version set status = 'approved' where course_id = $1`, [ids.course]).catch(() => undefined);
    const has = (await db.su.query(`select 1 from syllabus_version where course_id = $1 and status = 'approved'`, [ids.course])).rowCount;
    if (!has) {
      const s = syllabusApi(fetcher);
      await s.save(ids.course!, { content: await s.starting(ids.course!) });
      await db.su.query(`update syllabus_version set status = 'approved' where course_id = $1`, [ids.course]);
    }
    const user = userEvent.setup();
    render_(ids.course!);
    // One Basic information box: the record's own fields (no title or credit hours: those are the content's, shown once below), the
    // Course Coordinator, and the course information, description and methodology of the content.
    const box = await screen.findByRole('region', { name: 'Basic information' });
    const record = await within(box).findByRole('form', { name: 'Course record' });
    expect(within(record).queryByLabelText('Course title')).toBeNull();
    expect(within(record).queryByLabelText('Credit hours')).toBeNull();
    expect(within(box).getByRole('region', { name: 'Course Coordinator' })).toBeTruthy();
    expect(await within(box).findByRole('region', { name: 'Course description' })).toBeTruthy();
    expect(within(box).getByRole('region', { name: 'Teaching methodology' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Course staff' })).toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Basic Information', 'CLOs', 'Course Outline', 'Course Material', 'Course Assessment', 'Course Policies']);
    await expect(outcomesApi(fetcher).updateCourse(ids.course!, { titleEn: 'Something else' })).rejects.toThrow(/draft/);
    await user.type(within(record).getByLabelText('SIS code'), 'MCE410-SIS');
    await user.click(within(record).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await outcomesApi(fetcher).courses()).find((x) => x.id === ids.course)?.externalId).toBe('MCE410-SIS'));
    // The other tabs show one part of the content each.
    await user.click(screen.getByRole('tab', { name: 'CLOs' }));
    const clos = await screen.findByRole('tabpanel', { name: 'CLOs' });
    expect(within(clos).queryByRole('region', { name: 'Course description' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Course Policies' }));
    expect(await within(await screen.findByRole('tabpanel', { name: 'Course Policies' })).findByRole('region', { name: 'Assessment policies' })).toBeTruthy();
  }, 30000);
});
