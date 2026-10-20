// @vitest-environment jsdom
// Cycle plans, the academic calendar and proposed runs (TASK-081, DEC-030) in the SPA against the real API: Settings -> Organization ->
// Institution -> Academic calendar; Quality Management -> Cycles -> Due to launch (filters, select several, Review and launch with the
// template and the evidence item fixed, Skip this period, gaps in the calendar) and the Plans tab (plans of evidence items, a plan
// that already existed on a standard is listed and not offered for change, New plan asks which evidence item). There is no
// "Set cycle plan…" on a standard any more.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, MemoryStore, seedFrameworks } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { cyclesApi } from './lib/cycles-api';
import { evidenceApi } from './lib/evidence-api';
import { frameworkApi, type Requirement } from './lib/framework-api';
import { glossaryApi } from './lib/glossary-api';
import { plansApi } from './lib/plans-api';
import { scopeApi } from './lib/scope-api';
import { settingsApi } from './lib/settings-api';
import { resetConfirmForTests } from './components/confirm-dialog';
import { OrganizationPage } from './pages/settings/organization';
import { QualityManagementPage, type QmTab } from './pages/quality-management';

configure({ asyncUtilTimeout: 10000 });

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
const apis = (who: string) => {
  const a = createApi(fetchAs(who));
  return { raw: a, evidence: evidenceApi(a, fetchAs(who)), framework: frameworkApi(a), glossary: glossaryApi(a), settings: settingsApi(a), scope: scopeApi(a), cycles: cyclesApi(a, fetchAs(who)), plans: plansApi(a) };
};
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const qm = (who: string, tab?: QmTab) => {
  const a = apis(who);
  return <QualityManagementPage api={a.framework} evidence={a.evidence} {...(tab ? { tab } : {})} apis={{ scope: a.scope, cycles: a.cycles, settings: a.settings, plans: a.plans, framework: a.framework, evidence: a.evidence }} />;
};
const pressWhenReady = async (user: ReturnType<typeof userEvent.setup>, scope: HTMLElement, name: string) => {
  await waitFor(() => expect((within(scope).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(within(scope).getByRole('button', { name }));
};
const setDate = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const COURSE = 'Course assessment (every semester)';
let iqf: Requirement[];

beforeAll(async () => {
  db = await createTestDb('webplans');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'contributor', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['contributor', 'contributor'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  ids.health = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'College of Health') returning id`, [ids.inst]);
  ids.physics = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'department', 'Physics') returning id`, [ids.inst]);
  ids.nursing = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BS Nursing', 'bachelor') returning id`, [ids.inst, ids.health]);
  ids.pharmacy = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BS Pharmacy', 'bachelor') returning id`, [ids.inst, ids.health]);
  await seedFrameworks(pool);
  const a = apis('admin');
  const qf = await a.framework.setUpQualityFramework({ template: true });
  ids.qv = qf.versions[0]!.id;
  ids.iqfFw = qf.framework!.id;
  for (const r of await a.framework.requirements(ids.qv)) await a.framework.reviewRequirement(r.id, 'approved');
  await a.framework.submit(ids.qv);
  await a.framework.publish(ids.qv);
  iqf = await a.framework.requirements(ids.qv);
  await a.cycles.installDefaultTemplates();
}, 180000);
afterEach(() => { cleanup(); resetConfirmForTests(); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('Settings -> Organization -> Institution -> Academic calendar', () => {
  it('is empty at first; an administrator adds years and terms with Arabic names, and an overlap is refused with the reason', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<OrganizationPage api={a.settings} />));
    expect(await screen.findByRole('heading', { name: 'Academic calendar' })).toBeTruthy();
    expect((await screen.findByTestId('calendar-empty')).textContent).toContain('No years or terms yet');
    const form = await screen.findByRole('form', { name: 'Add to the calendar' });
    const add = async (kind: 'Year' | 'Term', name: string, ar: string, start: string, end: string, accepted = true) => {
      await user.selectOptions(within(form).getByLabelText('Kind'), kind);
      await user.clear(within(form).getByLabelText('New name (English)')); await user.type(within(form).getByLabelText('New name (English)'), name);
      await user.clear(within(form).getByLabelText('New name (Arabic)')); if (ar) await user.type(within(form).getByLabelText('New name (Arabic)'), ar);
      setDate(within(form).getByLabelText('New start date'), start); setDate(within(form).getByLabelText('New end date'), end);
      await user.click(within(form).getByRole('button', { name: 'Add to the calendar' }));
      // The form empties itself once the server has taken it; the next one must not start before.
      if (accepted) await waitFor(() => expect((within(form).getByLabelText('New name (English)') as HTMLInputElement).value).toBe(''));
    };
    await add('Year', 'Current year', 'العام الحالي', iso(-100), iso(265));
    const years = await screen.findByRole('list', { name: 'Years' });
    await waitFor(() => expect(within(years).getAllByTestId('calendar-row')).toHaveLength(1));
    expect((within(years).getByLabelText('Name of Current year (Arabic)') as HTMLInputElement).value).toBe('العام الحالي');
    expect((within(years).getByLabelText('Name of Current year (Arabic)') as HTMLInputElement).dir).toBe('auto');
    await add('Term', 'Current term', '', iso(-10), iso(60));
    await add('Term', 'Next term', '', iso(90), iso(160));
    const terms = await screen.findByRole('list', { name: 'Terms' });
    await waitFor(() => expect(within(terms).getAllByTestId('calendar-row')).toHaveLength(2));
    await add('Term', 'Clashing term', '', iso(50), iso(100), false);
    expect((await screen.findByRole('alert')).textContent).toMatch(/overlaps another one in the academic calendar/);
    expect(within(terms).getAllByTestId('calendar-row')).toHaveLength(2);
  });

  it('edits dates and names, moves a term, switches it off and on, and deletes it after a question (with Undo from the toast)', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<OrganizationPage api={a.settings} />));
    await screen.findByRole('form', { name: 'Add to the calendar' });   // the person's permissions have arrived: the rows are editable
    const terms = await screen.findByRole('list', { name: 'Terms' });
    await user.clear(within(terms).getByLabelText('Name of Next term (Arabic)'));
    await user.type(within(terms).getByLabelText('Name of Next term (Arabic)'), 'الفصل التالي');
    await user.click(within(terms).getByRole('button', { name: 'Save Next term' }));
    await waitFor(() => expect((within(terms).getByLabelText('Name of Next term (Arabic)') as HTMLInputElement).value).toBe('الفصل التالي'));
    expect(within(terms).getByRole('button', { name: 'Move Current term up' }).hasAttribute('disabled')).toBe(true);
    await pressWhenReady(user, terms, 'Move Next term up');
    await waitFor(() => expect((within(terms).getAllByTestId('calendar-row')[0]!.querySelector('input') as HTMLInputElement).value).toBe('Next term'));
    await pressWhenReady(user, terms, 'Move Next term down');
    await waitFor(() => expect((within(terms).getAllByTestId('calendar-row')[0]!.querySelector('input') as HTMLInputElement).value).toBe('Current term'));
    await pressWhenReady(user, terms, 'Switch off Next term');
    await waitFor(() => expect(within(terms).getByRole('button', { name: 'Switch on Next term' })).toBeTruthy());
    await pressWhenReady(user, terms, 'Switch on Next term');
    await waitFor(() => expect(within(terms).getByRole('button', { name: 'Switch off Next term' })).toBeTruthy());

    // A short extra term: deleted after a question.
    const form = await screen.findByRole('form', { name: 'Add to the calendar' });
    await user.type(within(form).getByLabelText('New name (English)'), 'Winter break');
    setDate(within(form).getByLabelText('New start date'), iso(200)); setDate(within(form).getByLabelText('New end date'), iso(210));
    await user.click(within(form).getByRole('button', { name: 'Add to the calendar' }));
    await waitFor(() => expect(within(terms).getAllByTestId('calendar-row')).toHaveLength(3));
    await user.click(within(terms).getByRole('button', { name: 'Delete Winter break' }));
    const ask = await screen.findByRole('dialog', { name: 'Delete Winter break?' });
    await user.click(within(ask).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(within(terms).getAllByTestId('calendar-row')).toHaveLength(2));
  });

  it('is read-only for someone who cannot write the organization', async () => {
    const a = apis('viewer');
    render(wrap(<OrganizationPage api={a.settings} />));
    const terms = await screen.findByRole('list', { name: 'Terms' });
    await waitFor(() => expect(within(terms).getAllByTestId('calendar-row').length).toBe(2));
    for (const input of within(terms).getAllByRole('textbox')) expect((input as HTMLInputElement).disabled).toBe(true);
    expect(within(terms).queryByRole('button', { name: /^Save|Move|Switch|Delete/ })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add to the calendar' })).toBeNull();
  });
});

describe('Quality Management -> Cycles -> Due to launch', () => {
  beforeAll(async () => {
    // A plan on an evidence item that applies to the programs (every term), and a plan that already existed on a standard (written behind the
    // service's back: a new one is refused now), which stays listed.
    const a = apis('admin');
    ids.results = await one(`insert into evidence_item (institution_id, title, type, owner_unit_id) values ($1, 'Course results', 'document', $2) returning id`, [ids.inst, ids.health]);
    ids.syllabi = await one(`insert into evidence_item (institution_id, title, type, owner_unit_id, owner_user_id) values ($1, 'Syllabi', 'document', $2, $3) returning id`, [ids.inst, ids.health, ids.lead]);
    const course = (await a.cycles.templates({ status: 'published' })).find((t) => t.name === COURSE)!;
    ids.courseTpl = course.id;
    await a.plans.set({ anchorKind: 'evidence_item', anchorId: ids.results!, templateId: course.id, recurrence: { every: 1, unit: 'term' }, firstStart: iso(-30), appliesTo: { kinds: ['program'] } });
    const std = iqf.find((r) => r.title === 'Assessment of learning')!;
    await db.su.query(`insert into cycle_plan (institution_id, anchor_kind, anchor_framework_id, anchor_code, template_id, mode, recurrence, first_start) values ($1, 'requirement', $2, $3, $4, 'own', '{"every":1,"unit":"term"}', $5)`,
      [ids.inst, ids.iqfFw, std.code, course.id, iso(-30)]);
  });

  it('lists one run per program per term that the plan proposes, with filters, and names the stretch the calendar does not cover', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead', 'cycles')));
    const section = await screen.findByTestId('due-section');
    expect(within(section).getByRole('heading', { name: 'Due to launch' })).toBeTruthy();
    await waitFor(() => expect(within(section).getAllByTestId('due-run')).toHaveLength(4));
    const rows = within(section).getAllByTestId('due-run');
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['due', 'due', 'upcoming', 'upcoming']);
    expect(rows[0]!.textContent).toContain(`${COURSE} · Current term`);
    expect(rows.map((r) => r.textContent).join(' ')).toMatch(/BS Nursing/);
    expect(rows.map((r) => r.textContent).join(' ')).toMatch(/BS Pharmacy/);
    // No unit or program picker among the filters (those are Quality Assurance anchors, not offered).
    expect(within(section).queryByLabelText('Who it is about')).toBeNull();
    await user.selectOptions(within(section).getByLabelText('State'), 'upcoming');
    await waitFor(() => expect(within(section).getAllByTestId('due-run')).toHaveLength(2));
    await user.selectOptions(within(section).getByLabelText('State'), '');
    // 365 days ahead goes past the end of the calendar: said, not guessed.
    await user.selectOptions(within(section).getByLabelText('Look ahead'), '365');
    const gaps = await within(section).findByTestId('due-gaps');
    expect(gaps.textContent).toMatch(/No term defined for that period\./);
    expect(gaps.textContent).toContain('Add it to the academic calendar.');
  });

  it('selects two runs and reviews them one after the other in the shared launch dialog: the template and the evidence item are fixed, owner and start date are asked', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead', 'cycles')));
    const section = await screen.findByTestId('due-section');
    await waitFor(() => expect(within(section).getAllByTestId('due-run')).toHaveLength(4));
    const launchButton = within(section).getByRole('button', { name: /^Review and launch \(/ }) as HTMLButtonElement;
    expect(launchButton.disabled).toBe(true);
    await user.click(within(section).getByRole('checkbox', { name: `Select ${COURSE} Current term BS Nursing` }));
    await user.click(within(section).getByRole('checkbox', { name: `Select ${COURSE} Current term BS Pharmacy` }));
    await user.click(within(section).getByRole('button', { name: 'Review and launch (2)' }));
    let dialog = await screen.findByRole('dialog', { name: /Launch a proposed run/ });
    expect(within(dialog).getByTestId('proposal-facts').textContent).toMatch(/About: BS Nursing.*Period: Current term/);
    expect((within(dialog).getByLabelText('Template') as HTMLSelectElement).disabled).toBe(true);
    await waitFor(() => expect((within(dialog).getByLabelText('Template') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(COURSE));
    expect((within(dialog).getByLabelText('Evidence item') as HTMLSelectElement).disabled).toBe(true);
    await waitFor(() => expect((within(dialog).getByLabelText('Evidence item') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('Course results'));
    expect(within(dialog).queryByLabelText('Responsible unit')).toBeNull();
    expect(within(dialog).queryByLabelText('Cycle lead')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Create cycle' }));
    await within(dialog).findByTestId('launch-review');
    await user.click(within(dialog).getByRole('button', { name: 'Keep as a draft' }));
    // The next one opens at once.
    dialog = await screen.findByRole('dialog', { name: /Launch a proposed run/ });
    await waitFor(() => expect(within(dialog).getByTestId('proposal-facts').textContent).toMatch(/About: BS Pharmacy/));
    await user.click(within(dialog).getByRole('button', { name: 'Create cycle' }));
    await within(dialog).findByTestId('launch-review');
    await user.click(within(dialog).getByRole('button', { name: 'Keep as a draft' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(within(section).getAllByTestId('due-run')).toHaveLength(2));

    const made = (await apis('lead').cycles.list()).filter((c) => c.planId);
    expect(made.map((c) => [c.periodLabel, c.subjectName, c.status]).sort()).toEqual([['Current term', 'BS Nursing', 'draft'], ['Current term', 'BS Pharmacy', 'draft']]);
    expect(made[0]!.periodStart).toBe(iso(-10));
    expect(made.every((c) => c.leadUserId === ids.lead)).toBe(true);   // the owner defaults to the person launching
  });

  it('skips a period with a reason, and it is not proposed again', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead', 'cycles')));
    const section = await screen.findByTestId('due-section');
    await waitFor(() => expect(within(section).getAllByTestId('due-run')).toHaveLength(2));
    await user.click(within(section).getByRole('button', { name: `Skip this period: ${COURSE} Next term BS Nursing` }));
    const dialog = await screen.findByRole('dialog', { name: /Skip/ });
    const confirm = within(dialog).getByRole('button', { name: 'Skip this period' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Why is it skipped?'), 'No cohort this term');
    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(within(section).getAllByTestId('due-run')).toHaveLength(1));
    expect(within(section).getByTestId('due-run').textContent).toContain('BS Pharmacy');
    expect((await db.su.query(`select reason from cycle_plan_skip`)).rows.map((r) => r.reason)).toEqual(['No cohort this term']);
  });

  it('shows the section read-only to a viewer: no selecting, launching or skipping', async () => {
    render(wrap(qm('viewer', 'cycles')));
    const section = await screen.findByTestId('due-section');
    await waitFor(() => expect(within(section).getAllByTestId('due-run')).toHaveLength(1));
    expect(within(section).queryByRole('checkbox')).toBeNull();
    expect(within(section).queryByRole('button', { name: /Review and launch|Skip this period/ })).toBeNull();
  });
});

describe('Quality Management -> Plans', () => {
  it('lists the plans with what they are attached to, how often and the next run; a plan that existed on a standard is listed and cannot be changed here', async () => {
    render(wrap(qm('lead', 'plans')));
    const rows = await screen.findAllByTestId('plan-row');
    expect(rows).toHaveLength(2);
    const ev = rows.find((r) => within(r).getByTestId('plan-anchor-kind').textContent === 'Evidence item')!;
    expect(ev.textContent).toContain(COURSE);
    expect(ev.textContent).toContain('Course results');
    expect(within(ev).getByTestId('plan-recurrence').textContent).toBe('Every term');
    expect(within(ev).getByTestId('plan-next').textContent).toMatch(/Current term|Next term/);
    expect(within(ev).getByTestId('plan-gap').textContent).toMatch(/No term defined for that period/);
    expect(within(ev).getByRole('button', { name: /^Change the plan/ })).toBeTruthy();
    const std = rows.find((r) => within(r).getByTestId('plan-anchor-kind').textContent === 'Standard or requirement')!;
    expect(within(std).getByTestId('plan-recurrence').textContent).toBe('Every term');
    expect(within(std).queryByRole('button', { name: /^Change the plan/ })).toBeNull();   // no screen changes a plan on a standard
    expect(screen.queryByLabelText('Attached to')).toBeNull();                             // and no kind filter offers the Quality Assurance anchors
  });

  it('"New plan" asks which evidence item, then the template, how often, the first due date and the owner', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead', 'plans')));
    await user.click(await screen.findByRole('button', { name: 'New plan' }));
    const dialog = await screen.findByRole('dialog', { name: /Collect this regularly/ });
    expect((within(dialog).getByRole('button', { name: 'Save plan' }) as HTMLButtonElement).disabled).toBe(true);
    const which = within(dialog).getByLabelText('Evidence item');
    await within(which).findByRole('option', { name: 'Syllabi' });
    await user.selectOptions(which, ids.syllabi!);
    await waitFor(() => expect((within(dialog).getByLabelText('Cycle template') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('Evidence collection'));
    expect(within(dialog).queryByRole('option', { name: 'Annual program report' })).toBeNull();   // made for QA anchors: not offered
    expect((within(dialog).getByLabelText('Owner') as HTMLSelectElement).value).toBe(ids.lead);     // the evidence item's owner
    await user.selectOptions(within(dialog).getByLabelText('Repeats'), 'month');
    setDate(within(dialog).getByLabelText('Every (number)'), '3');
    setDate(within(dialog).getByLabelText('First due date'), iso(-3));
    await user.click(within(dialog).getByRole('button', { name: 'Save plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const row = await waitFor(() => { const r = screen.getAllByTestId('plan-row').find((x) => x.textContent?.includes('Evidence collection')); expect(r).toBeTruthy(); return r!; });
    expect(within(row).getByTestId('plan-anchor-kind').textContent).toBe('Evidence item');
    expect(row.textContent).toContain('Syllabi');
    expect(within(row).getByTestId('plan-recurrence').textContent).toBe('Every 3 months');
    expect(row.textContent).toContain('lead');
  });

  it('records the date a decision fixes, once the first run is made', async () => {
    const user = userEvent.setup();
    const lead = apis('lead');
    const evidenceCollection = (await lead.cycles.templates({ status: 'published' })).find((t) => t.name === 'Evidence collection')!;
    const other = await one(`insert into evidence_item (institution_id, title, type, owner_unit_id) values ($1, 'Accreditor decisions', 'document', $2) returning id`, [ids.inst, ids.health]);
    await lead.plans.set({ anchorKind: 'evidence_item', anchorId: other, templateId: evidenceCollection.id, recurrence: { after: 'previous_ends', setBy: 'decision' }, firstStart: iso(-3) });
    // Its first run is made (from the proposal), and the plan then waits for the date a decision fixes.
    const due = (await lead.plans.due({ horizonDays: 30 })).runs.find((r) => r.anchorId === other)!;
    await lead.cycles.launch({ templateId: due.templateId, anchorKind: due.anchorKind, anchorId: due.anchorId, startDate: due.periodStart, periodLabel: due.periodLabel, planId: due.planId, periodStart: due.periodStart });
    render(wrap(qm('lead', 'plans')));
    const waiting = await waitFor(() => { const r = screen.getAllByTestId('plan-row').find((x) => x.textContent?.includes('Accreditor decisions') && x.textContent.includes('Waiting for the next date')); expect(r).toBeTruthy(); return r!; });
    setDate(within(waiting).getByLabelText('Date of the next run of Evidence collection'), iso(20));
    await user.click(within(waiting).getByRole('button', { name: 'Set the date' }));
    await waitFor(() => expect(within(screen.getAllByTestId('plan-row').find((x) => x.textContent?.includes('Accreditor decisions'))!).getByTestId('plan-next').textContent).not.toMatch(/Waiting/));
  });

  it('searches', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead', 'plans')));
    await waitFor(() => expect(screen.getAllByTestId('plan-row').length).toBeGreaterThanOrEqual(3));
    await user.type(screen.getByLabelText('Search plans'), 'syllabi');
    await waitFor(() => expect(screen.getAllByTestId('plan-row')).toHaveLength(1));
    await user.clear(screen.getByLabelText('Search plans'));
    await user.type(screen.getByLabelText('Search plans'), 'nothing like this');
    expect((await screen.findByTestId('no-plans')).textContent).toContain('No plan matches');
  });

  it('is read-only for a viewer: the list, no New plan, no Change', async () => {
    render(wrap(qm('viewer', 'plans')));
    await waitFor(() => expect(screen.getAllByTestId('plan-row').length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole('button', { name: 'New plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Change the plan/ })).toBeNull();
    expect(screen.queryByRole('form', { name: /Next date for/ })).toBeNull();
  });
});
