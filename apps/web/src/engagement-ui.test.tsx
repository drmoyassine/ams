// @vitest-environment jsdom
// The M2 screens against the real API (real routes, permissions, database rules) behind the typed client.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { engagementApi, type EngagementApi } from './lib/engagement-api';
import { frameworkApi } from './lib/framework-api';
import { EngagementPage } from './pages/engagement';
import { NewEngagementPage } from './pages/engagement-new';
import { EngagementsPage } from './pages/engagements';
import { RequirementWorkspacePage } from './pages/requirement-workspace';

// Pages fill from real requests; a loaded machine (or CI) needs more than the default second.
configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, params: unknown[] = []) => (await db.su.query(sql, params)).rows[0].id as string;
const fetchAs = (who: string) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apiFor = (who: string): EngagementApi => engagementApi(createApi(fetchAs(who)));
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
/** Pickers fill from a second request; wait for their options before choosing one. */
const optionsLoaded = (label: string, atLeast: number) => waitFor(() => expect(within(screen.getByLabelText(label)).getAllByRole('option').length).toBeGreaterThanOrEqual(atLeast));
const fixture = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../packages/db/fixtures/${name}.json`), 'utf8')) as unknown;

beforeAll(async () => {
  db = await createTestDb('webeng');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool,
    authenticate: async (req) => {
      const h = req.headers.get('x-test-user');
      if (!h) return null;
      const [userId, institutionId] = h.split(':');
      return { userId: userId!, institutionId: institutionId! };
    },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'coord', 'contrib', 'reviewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $3) returning id`, [ids.inst, n, `${n}@x.org`]);
  const unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.mech = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Mechanical Engineering', 'bachelor', '{mechanical}') returning id`, [ids.inst, unit]);
  const grant = (u: string, role: string, scope: string, scopeId: string) =>
    db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids.inst, ids[u], role, scope, scopeId]);
  await grant('admin', 'admin', 'institution', ids.inst!);
  await grant('coord', 'lead', 'program', ids.mech!);
  await grant('contrib', 'contributor', 'program', ids.mech!);
  await grant('reviewer', 'reviewer', 'program', ids.mech!);
  const fw = frameworkApi(createApi(fetchAs('admin')));
  const { version } = await fw.importFile({ file: fixture('abet-eac-2027-28'), autoApprove: true });
  await fw.submit(version.id);
  await fw.publish(version.id);
  ids.abet = version.id;
}, 60000);
afterEach(cleanup);
afterAll(async () => { await pool.end(); await db.close(); });

describe('engagements list and wizard', () => {
  it('shows the empty state, and offers "New engagement" only to those who may create one', async () => {
    render(wrap(<EngagementsPage api={apiFor('coord')} />));
    expect(await screen.findByText(/No engagements yet/)).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'New engagement' })).toBeTruthy();
    cleanup();
    render(wrap(<EngagementsPage api={apiFor('contrib')} />));
    await screen.findByText(/No engagements yet/);
    expect(screen.queryByRole('link', { name: 'New engagement' })).toBeNull();
  });

  it('creates an engagement from one screen, with the lead required', async () => {
    const user = userEvent.setup();
    let created = '';
    render(wrap(<NewEngagementPage api={apiFor('coord')} onCreated={(id) => { created = id; }} />));
    const create = await screen.findByRole('button', { name: 'Create engagement' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(within(screen.getByLabelText('Program')).getAllByRole('option').length).toBeGreaterThan(1));
    await user.selectOptions(screen.getByLabelText('Program'), ids.mech!);
    await waitFor(() => expect(within(screen.getByLabelText('Framework version')).getAllByRole('option').length).toBeGreaterThan(1));
    await user.selectOptions(screen.getByLabelText('Framework version'), ids.abet!);
    await user.selectOptions(screen.getByLabelText('Kind'), 'initial');
    await user.clear(screen.getByLabelText('Review year'));
    await user.type(screen.getByLabelText('Review year'), '2027');
    expect((create as HTMLButtonElement).disabled).toBe(true); // still no lead
    await waitFor(() => expect(within(screen.getByLabelText('Engagement lead')).getAllByRole('option').length).toBeGreaterThan(1));
    await user.selectOptions(screen.getByLabelText('Engagement lead'), ids.coord!);
    expect((create as HTMLButtonElement).disabled).toBe(false);
    await user.click(create);
    await waitFor(() => expect(created).not.toBe(''));
    const list = await apiFor('coord').list();
    expect(list).toEqual([expect.objectContaining({ id: created, kind: 'initial', reviewYear: 2027, currentPhase: 'eligibility', leadUserId: ids.coord })]);
    ids.eng = created;
  });

  it('lists the engagement with its accreditor, phase and lead', async () => {
    render(wrap(<EngagementsPage api={apiFor('contrib')} />));
    const list = await screen.findByRole('list', { name: 'Engagements' });
    expect(list.textContent).toMatch(/ABET/);
    expect(list.textContent).toMatch(/Eligibility/);
    expect(list.textContent).toMatch(/lead coord/);
  });
});

describe('engagement page', () => {
  it('shows the phases and a roadmap whose milestones carry their origin, lock and dates', async () => {
    render(wrap(<EngagementPage id={ids.eng!} api={apiFor('coord')} />));
    const phases = await screen.findByLabelText('Phases');
    expect(within(phases).getAllByText(/required/)).toHaveLength(5);
    const advance = screen.getByRole('button', { name: 'Advance to next phase' }) as HTMLButtonElement;
    expect(advance.disabled).toBe(true);
    const selfStudy = await screen.findByRole('region', { name: 'Self-Study Report' });
    const ssr = within(selfStudy).getAllByTestId('milestone').find((m) => /Submit Self-Study Report/.test(m.textContent ?? ''))!;
    expect(within(ssr).getByTestId('origin').textContent).toBe('From template');
    expect(ssr.textContent).toMatch(/Locked/);
    expect(ssr.textContent).toMatch(/2027-07-01/);
    const visit = within(await screen.findByRole('region', { name: 'Review' })).getAllByTestId('milestone').find((m) => /visit/i.test(m.textContent ?? ''))!;
    expect(visit.textContent).toMatch(/Date needed/);
  });

  it('resolves dates when a key date is entered', async () => {
    const user = userEvent.setup();
    render(wrap(<EngagementPage id={ids.eng!} api={apiFor('coord')} />));
    const input = await screen.findByLabelText('Visit date');
    await user.type(input, '2027-10-18');
    await user.tab();
    await waitFor(async () => {
      const review = within(await screen.findByRole('region', { name: 'Review' }));
      expect(review.getAllByTestId('milestone').some((m) => /2027-10-18/.test(m.textContent ?? ''))).toBe(true);
    });
  });

  it('adds a local milestone, asks for a reason before skipping a required one, and marks edits as modified', async () => {
    const user = userEvent.setup();
    render(wrap(<EngagementPage id={ids.eng!} api={apiFor('coord')} />));
    const section = await screen.findByRole('region', { name: 'Self-Study Report' });
    await user.type(within(section).getByLabelText('Add a milestone to self study'), 'Steering committee');
    await user.click(within(section).getByRole('button', { name: 'Add' }));
    const local = await within(section).findByText('Steering committee');
    expect(within(local.closest('[data-testid="milestone"]') as HTMLElement).getByTestId('origin').textContent).toBe('Added locally');

    await user.selectOptions(within(section).getByLabelText('Status of Complete Tables 5-1, 6-1, 6-2, D-1, D-2'), 'skipped');
    const reason = await within(section).findByLabelText(/Reason for skipping Complete Tables/);
    await user.type(reason, 'Tables are prepared by the registrar');
    await user.click(within(section).getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(section.textContent).toMatch(/Skipped: Tables are prepared by the registrar/));

    const row = within(section).getAllByTestId('milestone').find((m) => /Assign criterion owners/.test(m.textContent ?? ''))!;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const name = within(row).getByLabelText('Milestone name');
    await user.clear(name);
    await user.type(name, 'Assign owners for each criterion');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    const renamed = await within(section).findByText('Assign owners for each criterion');
    expect(within(renamed.closest('[data-testid="milestone"]') as HTMLElement).getByTestId('origin').textContent).toBe('Modified');
  });

  it('hides roadmap controls from someone who cannot edit it', async () => {
    render(wrap(<EngagementPage id={ids.eng!} api={apiFor('contrib')} />));
    await screen.findByLabelText('Phases');
    expect(screen.queryByRole('button', { name: 'Advance to next phase' })).toBeNull();
    expect(screen.queryByLabelText(/Add a milestone/)).toBeNull();
    expect((screen.getByLabelText('Visit date') as HTMLInputElement).disabled).toBe(true);
  });

  it('adds a member and hands over the lead role from the members tab', async () => {
    const user = userEvent.setup();
    render(wrap(<EngagementPage id={ids.eng!} api={apiFor('coord')} />));
    await user.click(await screen.findByRole('tab', { name: 'Members' }));
    await optionsLoaded('Person to add', 3);
    await user.selectOptions(await screen.findByLabelText('Person to add'), ids.contrib!);
    await user.selectOptions(screen.getByLabelText('Role to give'), 'contributor');
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    await waitFor(() => expect(within(screen.getByLabelText('Person to add')).queryByRole('option', { name: 'contrib' })).toBeNull());
    await user.selectOptions(await screen.findByLabelText('Person to add'), ids.reviewer!);
    await user.selectOptions(screen.getByLabelText('Role to give'), 'reviewer');
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    const members = await screen.findByRole('list', { name: 'Members' });
    await waitFor(() => expect(members.textContent).toMatch(/contrib/));
    expect(members.textContent).toMatch(/Engagement lead/);
    expect(screen.getByRole('button', { name: 'Hand over' })).toBeTruthy();
  });
});

describe('requirement workspace', () => {
  let reqId: string;

  it('shows the framework text and notes with authority, and lets the lead assign work', async () => {
    const list = await apiFor('coord').requirements(ids.eng!);
    reqId = list.items.find((i) => i.code === 'Criterion 5(a)')!.id;
    render(wrap(<RequirementWorkspacePage id={reqId} api={apiFor('coord')} />));
    expect((await screen.findByTestId('official-text')).textContent).toMatch(/^a minimum of 30 semester credit hours/);
    expect((await screen.findByTestId('authority')).textContent).toBe('Required');
    expect(screen.getByLabelText('Context').textContent).toMatch(/quote verified/);
    await optionsLoaded('Owner', 2);
    fireEvent.change(await screen.findByLabelText('Owner'), { target: { value: ids.contrib } });
    await vi.waitFor(async () => expect((await apiFor('coord').workspace(reqId)).item.ownerId).toBe(ids.contrib), { timeout: 4000, interval: 100 });
    await optionsLoaded('Reviewer', 2);
    fireEvent.change(screen.getByLabelText('Reviewer'), { target: { value: ids.reviewer } });
    await vi.waitFor(async () => expect((await apiFor('coord').workspace(reqId)).item.reviewerId).toBe(ids.reviewer), { timeout: 4000, interval: 100 });
  });

  it('takes the requirement through its steps: the owner works, the reviewer approves, and the label says "Internally approved"', async () => {
    const user = userEvent.setup();
    render(wrap(<RequirementWorkspacePage id={reqId} api={apiFor('contrib')} />));
    const actions = await screen.findByLabelText('Status actions');
    expect(within(actions).queryByRole('button', { name: 'Internally approved' })).toBeNull();
    await user.click(within(actions).getByRole('button', { name: 'In progress' }));
    await user.click(await within(await screen.findByLabelText('Status actions')).findByRole('button', { name: 'Ready for review' }));
    await waitFor(() => expect(screen.getAllByTestId('requirement-status')[0]!.textContent).toBe('Ready for review'));
    await user.type(screen.getByLabelText('Working notes'), 'Transcript audit attached');
    await user.click(screen.getByRole('button', { name: 'Save notes' }));
    await waitFor(async () => expect((await apiFor('contrib').workspace(reqId)).workingNotes).toBe('Transcript audit attached'));
    expect(screen.queryByLabelText('Owner')).toBeNull(); // assignment is the lead's
    cleanup();

    render(wrap(<RequirementWorkspacePage id={reqId} api={apiFor('reviewer')} />));
    const reviewActions = await screen.findByLabelText('Status actions');
    expect(within(reviewActions).queryByRole('button', { name: 'In progress' })).toBeNull();
    await user.click(within(reviewActions).getByRole('button', { name: 'Internally approved' }));
    await waitFor(() => expect(screen.getAllByTestId('requirement-status')[0]!.textContent).toBe('Internally approved'));
    expect(document.body.textContent).not.toMatch(/\bcompliant\b/i);
    const history = screen.getByLabelText('History');
    expect(history.textContent).toMatch(/reviewer/);
  });

  it('lets the lead switch a requirement off with a reason', async () => {
    const user = userEvent.setup();
    const id = (await apiFor('coord').requirements(ids.eng!)).items.find((i) => i.code === 'Criterion 8')!.id;
    render(wrap(<RequirementWorkspacePage id={id} api={apiFor('coord')} />));
    const field = await screen.findByLabelText('Applicability reason');
    const button = screen.getByRole('button', { name: 'Mark not applicable' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.type(field, 'Covered by the institutional review');
    await user.click(button);
    await waitFor(() => expect(screen.getByText(/Not applicable: Covered by the institutional review/)).toBeTruthy());
  });
});
