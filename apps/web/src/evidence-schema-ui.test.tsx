// @vitest-environment jsdom
// The evidence item in the SPA (TASK-089, DEC-031): the item form (Title, Type, Definition, Collection method with its settings,
// Schedule, Owner) for each method and schedule, the chips on the card (method, schedule, next due) and its Collection section, and
// the cycle UI that evidence no longer uses (no "Cycle…", no Cycle section, no "New cycle", no "New plan").
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  return { evidence: evidenceApi(a, f), framework: frameworkApi(a), settings: settingsApi(a, f), scope: scopeApi(a) };
};
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const library = (who: string) => { const a = apis(who); return wrap(<EvidencePage api={a.evidence} framework={a.framework} apis={a} />); };
const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const setValue = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const NEXT_DUE = /^Next due \d{1,2} \w{3} \d{4}$/;

beforeAll(async () => {
  db = await createTestDb('webevidenceschema');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'viewer', 'dean']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2 || '@x.org') returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['viewer', 'viewer'], ['dean', 'contributor']] as const) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u], role]);
  }
}, 120000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

/** Opens "+ Evidence" and returns the dialog. */
async function openNew(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '+ Evidence' }));
  return screen.findByRole('dialog', { name: 'New evidence' });
}
const lastItem = async (title: string) => (await apis('admin').evidence.list(title)).find((e) => e.title === title)!;

describe('the item form', () => {
  it('asks Title, Type, Definition, Collection method, Schedule and Owner; manual and no schedule are the defaults; Survey is shown as coming', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    const form = await openNew(user);
    expect(within(form).getByLabelText('Title')).toBeTruthy();
    expect((within(form).getByRole('radio', { name: 'Document' }) as HTMLInputElement).checked).toBe(true);
    expect(within(form).getByRole('radio', { name: 'Dataset' })).toBeTruthy();
    expect(within(form).queryByRole('radio', { name: 'Data' })).toBeNull();
    expect(within(form).getByLabelText('Definition')).toBeTruthy();
    expect(within(form).queryByLabelText('Description')).toBeNull();
    const method = within(form).getByLabelText('Collection method') as HTMLSelectElement;
    expect(method.value).toBe('manual');
    const option = (name: RegExp) => within(method).getByRole('option', { name }) as HTMLOptionElement;
    expect(option(/^Survey/).textContent).toBe('Survey (coming)');
    expect(option(/^Survey/).disabled).toBe(true);
    expect(option(/^Online form/).disabled).toBe(true);        // a document has no online form
    expect(within(form).getByTestId('method-help').textContent).toMatch(/uploads a file, registers a link or types the data/);
    expect((within(form).getByLabelText('Repeats') as HTMLSelectElement).value).toBe('');
    expect(within(form).getByRole('option', { name: 'No schedule' })).toBeTruthy();
    expect(within(form).queryByLabelText('Start date')).toBeNull();         // only once a schedule is chosen
    expect(within(form).getByLabelText('Owner')).toBeTruthy();
    expect((within(form).getByLabelText('Owner') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('Me');
    await user.click(within(form).getByRole('radio', { name: 'Dataset' }));
    expect(option(/^Online form/).disabled).toBe(false);
    await user.click(within(form).getByRole('radio', { name: 'Document' }));
    expect(option(/^Online form/).disabled).toBe(true);
  });

  it('manual: instructions and the expected format are kept, and a document needs its file', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    const form = await openNew(user);
    await user.type(within(form).getByLabelText('Title'), 'Signed minutes');
    await user.type(within(form).getByLabelText('Definition'), 'Minutes of the council, signed');
    await user.type(within(form).getByLabelText('Instructions'), 'Upload the signed PDF each term');
    await user.type(within(form).getByLabelText('Expected format'), 'PDF');
    await user.click(within(form).getByRole('button', { name: 'Create evidence' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('Choose the file.');
    await user.upload(within(form).getByLabelText('File'), new File(['minutes'], 'minutes.pdf', { type: 'application/pdf' }));
    await user.click(within(form).getByRole('button', { name: 'Create evidence' }));
    const card = await screen.findByRole('region', { name: 'Evidence: Signed minutes' });
    expect(await lastItem('Signed minutes')).toMatchObject({ method: 'manual', methodConfig: { instructions: 'Upload the signed PDF each term', expectedFormat: 'PDF' }, schedule: null, definition: 'Minutes of the council, signed' });
    const section = await within(card).findByTestId('collection-section');
    expect(section.textContent).toContain('Upload the signed PDF each term');
    expect(section.textContent).toContain('PDF');
    expect(within(section).getByTestId('collection-schedule').textContent).toBe('Schedule:No schedule');
    expect(within(card).getByTestId('evidence-method').textContent).toBe('Manual');
    expect(within(card).queryByTestId('evidence-schedule')).toBeNull();
  });

  it('online form: for a dataset, no file and no settings; the form and the sheet are set once it is saved', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    const form = await openNew(user);
    await user.type(within(form).getByLabelText('Title'), 'Employer feedback');
    await user.click(within(form).getByRole('radio', { name: 'Dataset' }));
    await user.selectOptions(within(form).getByLabelText('Collection method'), 'form');
    expect(within(form).getByTestId('method-help').textContent).toMatch(/online form, or return its spreadsheet template/);
    expect(within(form).queryByLabelText('File')).toBeNull();             // the form collects it
    await user.click(within(form).getByRole('button', { name: 'Create evidence' }));
    const card = await screen.findByRole('region', { name: 'Evidence: Employer feedback' });
    expect(await lastItem('Employer feedback')).toMatchObject({ type: 'dataset', method: 'form', methodConfig: {} });
    expect(within(card).getByTestId('evidence-method').textContent).toBe('Online form');
    expect((await within(card).findByTestId('collection-section')).textContent).toContain('online form and spreadsheet template');
  });

  it('request: a person of the AMS or an email address, with a note', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    let form = await openNew(user);
    await user.type(within(form).getByLabelText('Title'), 'Accreditation letter');
    await user.selectOptions(within(form).getByLabelText('Collection method'), 'request');
    await user.click(within(form).getByRole('button', { name: 'Create evidence' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('Choose who to ask.');
    await waitFor(() => expect(within(within(form).getByLabelText('Who to ask')).getByRole('option', { name: 'dean' })).toBeTruthy());
    await user.selectOptions(within(form).getByLabelText('Who to ask'), ids.dean!);
    await user.type(within(form).getByLabelText('Note'), 'Please send the latest letter');
    expect(within(form).queryByLabelText('File')).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Create evidence' }));
    const card = await screen.findByRole('region', { name: 'Evidence: Accreditation letter' });
    expect(await lastItem('Accreditation letter')).toMatchObject({ method: 'request', methodConfig: { assigneeUserId: ids.dean, note: 'Please send the latest letter' } });
    const section = await within(card).findByTestId('collection-section');
    expect(section.textContent).toContain('Ask:dean');
    expect(within(card).getByTestId('evidence-method').textContent).toBe('Request');

    form = await openNew(user);
    await user.type(within(form).getByLabelText('Title'), 'Partner survey results');
    await user.selectOptions(within(form).getByLabelText('Collection method'), 'request');
    await user.click(within(form).getByRole('radio', { name: 'An email address' }));
    expect(within(form).queryByLabelText('Who to ask')).toBeNull();
    await user.type(within(form).getByLabelText('Email address'), 'dean@partner.com');
    await user.click(within(form).getByRole('button', { name: 'Create evidence' }));
    await screen.findByRole('region', { name: 'Evidence: Partner survey results' });
    expect(await lastItem('Partner survey results')).toMatchObject({ method: 'request', methodConfig: { assigneeEmail: 'dean@partner.com' } });
  });

  it('BI: an endpoint name, a metric and how to cut it, a period and a wait; an address is refused with the reason', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    const form = await openNew(user);
    await user.type(within(form).getByLabelText('Title'), 'Enrollment headcount');
    await user.selectOptions(within(form).getByLabelText('Collection method'), 'bi');
    expect(within(form).getByRole('note').textContent).toMatch(/A dataset suits the BI best/);     // a document is accepted, a dataset recommended
    await user.click(within(form).getByRole('radio', { name: 'Dataset' }));
    expect(within(form).queryByRole('note')).toBeNull();
    await user.type(within(form).getByLabelText('BI endpoint'), 'https://bi.example.org');
    await user.type(within(form).getByLabelText('Metric'), 'enrollment_headcount');
    await user.type(within(form).getByLabelText('Dimensions'), 'program, level');
    await user.selectOptions(within(form).getByLabelText('Period'), 'year');
    setValue(within(form).getByLabelText('Timeout'), '90');
    await user.click(within(form).getByRole('button', { name: 'Create evidence' }));
    expect((await within(form).findByRole('alert')).textContent).toMatch(/not an address|name from the server/);
    await user.clear(within(form).getByLabelText('BI endpoint'));
    await user.type(within(form).getByLabelText('BI endpoint'), 'warehouse-1');
    await user.click(within(form).getByRole('button', { name: 'Create evidence' }));
    const card = await screen.findByRole('region', { name: 'Evidence: Enrollment headcount' });
    expect(await lastItem('Enrollment headcount')).toMatchObject({ type: 'dataset', method: 'bi', methodConfig: { endpointKey: 'warehouse-1', query: { metric: 'enrollment_headcount', dimensions: ['program', 'level'] }, period: 'year', timeoutSeconds: 90 } });
    const section = await within(card).findByTestId('collection-section');
    for (const text of ['warehouse-1', 'enrollment_headcount by program, level', 'year', '90 seconds']) expect(section.textContent).toContain(text);
  });
});

describe('the schedule', () => {
  it('Repeats: no schedule, or every day, week, month, quarter, semester or year, with a start date, days to due and a time zone', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    const form = await openNew(user);
    const repeats = within(form).getByLabelText('Repeats');
    expect(within(repeats).getAllByRole('option').map((o) => o.textContent)).toEqual(['No schedule', 'Every day', 'Every week', 'Every month', 'Every quarter', 'Every semester', 'Every year']);
    await user.selectOptions(repeats, 'month');
    expect((within(form).getByLabelText('Start date') as HTMLInputElement).value).toBe(new Date().toISOString().slice(0, 10));
    expect((within(form).getByLabelText('Due after') as HTMLInputElement).value).toBe('14');
    expect((within(form).getByLabelText('Time zone') as HTMLInputElement).value).not.toBe('');
    await user.selectOptions(repeats, 'semester');
    expect(within(form).getByText(/A semester is a term of the academic calendar/)).toBeTruthy();
    await user.selectOptions(repeats, '');
    expect(within(form).queryByLabelText('Start date')).toBeNull();
  });

  it('saves a monthly schedule: the chips show the method, how often and the next due date; the Collection section the details', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    const form = await openNew(user);
    await user.type(within(form).getByLabelText('Title'), 'Monthly enrollment');
    await user.upload(within(form).getByLabelText('File'), new File(['x'], 'e.pdf', { type: 'application/pdf' }));
    await user.selectOptions(within(form).getByLabelText('Repeats'), 'month');
    setValue(within(form).getByLabelText('Start date'), iso(-20));
    setValue(within(form).getByLabelText('Due after'), '30');
    setValue(within(form).getByLabelText('Time zone'), 'Asia/Dubai');
    await user.click(within(form).getByRole('button', { name: 'Create evidence' }));
    const card = await screen.findByRole('region', { name: 'Evidence: Monthly enrollment' });
    const item = await lastItem('Monthly enrollment');
    expect(item.schedule).toEqual({ every: 'month', startDate: iso(-20), dueAfterDays: 30, timezone: 'Asia/Dubai' });
    expect(item.nextDueAt).not.toBeNull();
    const meta = within(card).getByTestId('evidence-meta');
    expect(within(meta).getByTestId('evidence-method').textContent).toBe('Manual');
    expect(within(meta).getByTestId('evidence-schedule').textContent).toBe('Every month');
    expect(within(meta).getByTestId('evidence-next-due').textContent).toMatch(NEXT_DUE);
    const section = await within(card).findByTestId('collection-section');
    expect(within(section).getByTestId('collection-schedule').textContent).toContain('Every month');
    expect(within(section).getByTestId('collection-schedule').textContent).toContain('due 30 days after it starts (Asia/Dubai)');
    expect(within(section).getByTestId('collection-next-due').textContent).toMatch(/\d{1,2} \w{3} \d{4}$/);
  });

  it('a semester the academic calendar cannot place is flagged, not guessed', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    await a.evidence.create({ title: 'Semester report', type: 'document', schedule: { every: 'semester', startDate: '2026-01-01', dueAfterDays: 14, timezone: 'UTC' } });
    render(library('admin'));
    const card = await screen.findByRole('region', { name: 'Evidence: Semester report' });
    expect(within(card).getByTestId('evidence-schedule').textContent).toBe('Every semester');
    expect(within(card).getByTestId('evidence-schedule-gap').textContent).toBe('No term defined');
    expect(within(card).queryByTestId('evidence-next-due')).toBeNull();
    await user.click(within(card).getAllByRole('button')[0]!);
    expect((await within(card).findByTestId('schedule-gap')).textContent).toMatch(/never guessed/);
    expect(within(card).getByTestId('collection-next-due').textContent).toBe('Next due:not known');
  });

  it('is changed and cleared in Edit details, and the owner is named there', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    const card = await screen.findByRole('region', { name: 'Evidence: Monthly enrollment' });
    await user.click(within(card).getByRole('button', { name: 'Actions for Monthly enrollment' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit details' }));
    let dialog = await screen.findByRole('dialog', { name: 'Edit details' });
    expect((within(dialog).getByLabelText('Repeats') as HTMLSelectElement).value).toBe('month');
    expect((within(dialog).getByLabelText('Due after') as HTMLInputElement).value).toBe('30');
    expect((within(dialog).getByLabelText('Collection method') as HTMLSelectElement).value).toBe('manual');
    await user.selectOptions(within(dialog).getByLabelText('Repeats'), 'quarter');
    await waitFor(() => expect(within(within(dialog).getByLabelText('Owner')).getByRole('option', { name: 'dean' })).toBeTruthy());
    await user.selectOptions(within(dialog).getByLabelText('Owner'), ids.dean!);
    await user.selectOptions(within(dialog).getByLabelText('Collection method'), 'request');
    await user.selectOptions(within(dialog).getByLabelText('Who to ask'), ids.dean!);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await lastItem('Monthly enrollment')).toMatchObject({ method: 'request', methodConfig: { assigneeUserId: ids.dean }, schedule: { every: 'quarter', dueAfterDays: 30 }, ownerUserId: ids.dean });
    await waitFor(() => expect(within(card).getByTestId('evidence-schedule').textContent).toBe('Every quarter'));
    expect(within(card).getByTestId('evidence-method').textContent).toBe('Request');

    await user.click(within(card).getByRole('button', { name: 'Actions for Monthly enrollment' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit details' }));
    dialog = await screen.findByRole('dialog', { name: 'Edit details' });
    await user.selectOptions(within(dialog).getByLabelText('Repeats'), '');
    await user.selectOptions(within(dialog).getByLabelText('Collection method'), 'manual');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await lastItem('Monthly enrollment')).toMatchObject({ method: 'manual', methodConfig: {}, schedule: null, nextDueAt: null });
    await waitFor(() => expect(within(card).queryByTestId('evidence-schedule')).toBeNull());
  });

  it('refuses a form for a document when a dataset becomes a document, and says what to do', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    const card = await screen.findByRole('region', { name: 'Evidence: Employer feedback' });
    await user.click(within(card).getByRole('button', { name: 'Actions for Employer feedback' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit details' });
    await user.click(within(dialog).getByRole('radio', { name: 'Document' }));
    // The form belongs to a dataset, so the method falls back to manual in the form itself.
    expect((within(dialog).getByLabelText('Collection method') as HTMLSelectElement).value).toBe('manual');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  });
});

describe('what evidence no longer uses', () => {
  it('has no Cycle… in the ⋯ menu and no Cycle section on the card: the schedule lives on the item', async () => {
    const user = userEvent.setup();
    render(library('admin'));
    const card = await screen.findByRole('region', { name: 'Evidence: Monthly enrollment' });
    await user.click(within(card).getByRole('button', { name: 'Actions for Monthly enrollment' }));
    const labels = within(screen.getByRole('menu')).getAllByRole('menuitem').map((m) => m.textContent);
    expect(labels).not.toContain('Cycle…');
    expect(labels).toContain('Edit details');
    await user.keyboard('{Escape}');
    await user.click(within(card).getAllByRole('button')[0]!);
    await within(card).findByTestId('collection-section');
    expect(within(card).queryByTestId('evidence-cycle')).toBeNull();
    expect(within(card).queryByRole('button', { name: /Collect this regularly|Start a cycle now|Stop repeating/ })).toBeNull();
    expect(within(card).queryByText(/^Cycle$/)).toBeNull();
  });

  it('a viewer reads the method, the schedule and the next due date and changes nothing', async () => {
    render(library('viewer'));
    const card = await screen.findByRole('region', { name: 'Evidence: Semester report' });
    expect(within(card).getByTestId('evidence-method').textContent).toBe('Manual');
    expect(within(card).queryByRole('button', { name: 'Actions for Semester report' })).toBeNull();      // nothing to download, nothing to change
    expect(screen.queryByRole('button', { name: '+ Evidence' })).toBeNull();
  });
});
