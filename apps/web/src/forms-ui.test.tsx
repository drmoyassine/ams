// @vitest-environment jsdom
// Forms on data items in the SPA against the real API (DEC-020): answer through the public link and signed in, see the
// responses, add them to the data, and close the form.
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
import { AnswerFormPage, PublicFormPage } from './pages/answer-form';
import { RequestsPage } from './pages/requests';
import { RespondPage } from './pages/respond';
import { EvidencePage } from './pages/evidence';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const fetchAs = (who: string | null) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  if (who) headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apis = (who: string | null) => { const a = createApi(fetchAs(who)); return { evidence: evidenceApi(a, fetchAs(who)), framework: frameworkApi(a) }; };
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}

beforeAll(async () => {
  db = await createTestDb('webforms');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2 || '@x.org') returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  const a = apis('admin').evidence;
  ids.item = (await a.create({ title: 'Employer survey', type: 'dataset', definition: 'How our graduates do at work', method: 'form' })).id;
  await a.saveDataDefinition(ids.item, { columns: [
    { key: 'employer', label: 'Employer', type: 'text', required: true },
    { key: 'rating', label: 'Overall rating', type: 'choice', choices: ['Good', 'Fair', 'Poor'], help: 'Your overall view of our graduates' },
    { key: 'hires', label: 'Graduates hired', type: 'integer' },
  ] });
}, 120000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

describe('forms', () => {
  it('opens the form and makes a public link', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<EvidencePage api={a.evidence} framework={a.framework} />));
    await user.click(within(await screen.findByRole('region', { name: 'Evidence: Employer survey' })).getAllByRole('button')[0]!); // opens its card
    const panel = await screen.findByRole('region', { name: 'Dataset' });
    await user.click(await within(panel).findByRole('tab', { name: 'Form' }));
    const form = await within(panel).findByRole('region', { name: 'Form' });
    expect(within(form).getByText('Your overall view of our graduates')).toBeTruthy(); // the preview
    await user.click(within(form).getByRole('switch', { name: 'Accepting responses' }));
    await user.click(await within(form).findByRole('button', { name: 'Create public link' }));
    const link = (await within(form).findByLabelText('Public form link') as HTMLInputElement).value;
    ids.token = link.split('/f/')[1]!;
    expect(ids.token.length).toBeGreaterThan(20);
    expect((within(form).getByLabelText('Form link for AMS users') as HTMLInputElement).value).toContain(`/forms/${ids.item}`);
  });

  it('anyone answers through the public link; answers are checked first', async () => {
    const user = userEvent.setup();
    render(wrap(<PublicFormPage token={ids.token!} api={apis(null).evidence} />));
    expect(await screen.findByRole('heading', { name: 'Employer survey' })).toBeTruthy();
    expect(screen.getByText('Gulf University')).toBeTruthy();
    await user.type(screen.getByLabelText(/Graduates hired/), 'a few');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Employer is required')).toBeTruthy();
    expect(screen.getByText('enter a number')).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: /^Employer/ }), 'شركة الكهرباء');
    await user.click(screen.getByRole('radio', { name: 'Good' }));
    await user.clear(screen.getByLabelText(/Graduates hired/));
    await user.type(screen.getByLabelText(/Graduates hired/), '12');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect((await screen.findByRole('status')).textContent).toContain('Your response was received');
  });

  it('a signed-in person answers in the AMS', async () => {
    const user = userEvent.setup();
    render(wrap(<AnswerFormPage itemId={ids.item!} api={apis('viewer').evidence} />));
    await user.type(await screen.findByRole('textbox', { name: /^Employer/ }), 'SABIC');
    await user.click(screen.getByRole('radio', { name: 'Fair' }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('the responses are added to the data in one step; closing the form closes the link', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<EvidencePage api={a.evidence} framework={a.framework} />));
    const card = await screen.findByRole('region', { name: 'Evidence: Employer survey' });
    // The closed card says the form is open and two responses wait to be added.
    expect(within(card).getByTestId('evidence-meta').textContent).toBe('Online formForm open2 newNot linked');
    await user.click(within(card).getAllByRole('button')[0]!); // opens it
    const panel = await screen.findByRole('region', { name: 'Dataset' });
    await user.click(await within(panel).findByRole('tab', { name: 'Responses (2 new)' }));
    const responses = await within(panel).findByRole('region', { name: 'Responses' });
    const rows = await within(responses).findAllByTestId('data-response');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('viewer'), expect.stringContaining('Public link')]);
    await user.click(within(responses).getByRole('button', { name: 'Add 2 responses to the data' }));
    expect((await within(responses).findByRole('status')).textContent).toContain('version 1 (2 rows)');
    await user.click(within(panel).getByRole('tab', { name: 'Sheet' }));
    await waitFor(() => expect((within(panel).getByLabelText('Employer, row 1') as HTMLInputElement).value).toBe('شركة الكهرباء'));

    await user.click(within(panel).getByRole('tab', { name: 'Form' }));
    await user.click(await within(panel).findByRole('switch', { name: 'Accepting responses' }));
    await waitFor(() => expect(within(panel).getByText('Not accepting responses')).toBeTruthy());
    cleanup();
    render(wrap(<PublicFormPage token={ids.token!} api={apis(null).evidence} />));
    expect((await screen.findByRole('alert')).textContent).toContain('closed');
  });

  it('asks specific people to fill in the form, which works even while it is closed', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<EvidencePage api={a.evidence} framework={a.framework} />));
    await user.click(within(await screen.findByRole('region', { name: 'Evidence: Employer survey' })).getAllByRole('button')[0]!); // opens its card
    const panel = await screen.findByRole('region', { name: 'Dataset' });
    await user.click(await within(panel).findByRole('tab', { name: 'Form' }));
    await user.click(await within(panel).findByRole('button', { name: 'Ask people to fill it in' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Ask (email addresses)'), 'viewer@x.org, hr@partner.com');
    await user.type(within(dialog).getByLabelText('Message'), 'For the 2025 review');
    await user.click(within(dialog).getByRole('button', { name: 'Send requests' }));
    expect((await within(dialog).findByText(/In their requests in the AMS/)).textContent).toContain('viewer');
    const url = (within(dialog).getByLabelText('One-time link') as HTMLInputElement).value;
    const token = url.split('/respond/')[1]!;
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(await within(panel).findAllByTestId('evidence-request')).toHaveLength(2);
    // The card lists them too, and says on its closed face that a request is open.
    const card = screen.getByRole('region', { name: 'Evidence: Employer survey' });
    expect(await within(within(card).getByRole('region', { name: 'Requests for this item' })).findAllByTestId('evidence-request')).toHaveLength(2);
    await waitFor(() => expect(within(card).getByTestId('evidence-meta').textContent).toContain('Open request'));
    cleanup();

    // The AMS user fills it in from Requests.
    const v = apis('viewer');
    render(wrap(<RequestsPage api={v.evidence} framework={v.framework} />));
    await user.click(await screen.findByRole('button', { name: 'Fill in the form' }));
    const answer = await screen.findByRole('dialog');
    expect(await within(answer).findByText('For the 2025 review')).toBeTruthy();
    await user.type(await within(answer).findByRole('textbox', { name: /^Employer/ }), 'NEOM');
    await user.click(within(answer).getByRole('button', { name: 'Submit' }));
    expect(await within(answer).findByRole('status')).toBeTruthy();
    expect(within(answer).queryByRole('button', { name: 'Submit another response' })).toBeNull();
    await user.click(within(answer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByTestId('evidence-request').textContent).toContain('Supplied'));
    cleanup();

    // The partner fills it in through the one-time link, once.
    render(wrap(<RespondPage token={token} api={apis(null).evidence} />));
    await user.type(await screen.findByRole('textbox', { name: /^Employer/ }), 'Red Sea Global');
    await user.click(screen.getByRole('radio', { name: 'Good' }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('status')).toBeTruthy();
    cleanup();
    render(wrap(<RespondPage token={token} api={apis(null).evidence} />));
    expect((await screen.findByRole('alert')).textContent).toContain('has been used');

    const responses = await a.evidence.responses(ids.item!);
    expect(responses.filter((r) => r.includedInVersionNo === null).map((r) => r.answers.employer)).toEqual(['Red Sea Global', 'NEOM']);
  });
});
