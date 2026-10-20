// @vitest-environment jsdom
// Cycle plans, the academic calendar and proposed runs (TASK-081) in the SPA against the real API: Settings -> Organization -> Institution
// -> Academic calendar; "Set cycle plan…" in the ⋯ menu of a standard (the plan in effect, where it comes from, Opt out, Override, Back
// to inherited), the same through an approved mapping on an external standard, hover cards, Quality Management -> Cycles -> Due to launch
// (filters, select several, Review and launch, Skip this period, gaps in the calendar) and the Plans tab.
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
import { frameworkApi, type Requirement, type Version } from './lib/framework-api';
import { glossaryApi } from './lib/glossary-api';
import { plansApi } from './lib/plans-api';
import { scopeApi } from './lib/scope-api';
import { settingsApi } from './lib/settings-api';
import { resetConfirmForTests } from './components/confirm-dialog';
import { OrganizationPage } from './pages/settings/organization';
import { QualityManagementPage, type QmTab } from './pages/quality-management';
import { ExternalRequirements } from './pages/version/external-requirements';
import { tagOf } from './pages/version/review-dialogs';

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
const menuNames = () => screen.getAllByRole('menuitem').map((m) => m.textContent);
const actions = (code: string) => screen.findByRole('button', { name: `Actions for Standard ${code}` });
const region = (code: string) => screen.findByRole('region', { name: `Standard ${code}` });
const toggle = async (code: string) => (await region(code)).querySelector('button[data-tree-focus]') as HTMLElement;
const hoverTip = async (user: ReturnType<typeof userEvent.setup>, code: string) => {
  await user.hover(await toggle(code));
  return (await within(await region(code)).findByRole('tooltip')).textContent ?? '';
};
const unhover = async (user: ReturnType<typeof userEvent.setup>, code: string) => { await user.unhover(await toggle(code)); await waitFor(async () => expect(within(await region(code)).queryByRole('tooltip')).toBeNull()); };
const pressWhenReady = async (user: ReturnType<typeof userEvent.setup>, scope: HTMLElement, name: string) => {
  await waitFor(() => expect((within(scope).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(within(scope).getByRole('button', { name }));
};
const setDate = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const COURSE = 'Course assessment (every semester)';
let iqf: Requirement[];
let ext: { version: Version; sub: Requirement };

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
  const abet = (await a.framework.frameworks()).find((f) => f.accreditorShortName === 'ABET')!;
  ids.abet = (await a.framework.versions(abet.id))[0]!.id;
  const reqs = await a.framework.requirements(ids.abet);
  const top = reqs.find((r) => !r.parentId && reqs.some((c) => c.parentId === r.id))!;
  ext = { version: await a.framework.version(ids.abet), sub: reqs.find((r) => r.parentId === top.id)! };
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

describe('Set cycle plan… on a standard', () => {
  it('is in the ⋯ menu of a lead, not of a contributor', async () => {
    const user = userEvent.setup();
    const { unmount } = render(wrap(qm('lead')));
    await user.click(await actions('3.2'));
    expect(menuNames()).toContain('Set cycle plan…');
    unmount();
    render(wrap(qm('contributor')));
    await user.click(await actions('3.2'));
    expect(menuNames()).not.toContain('Set cycle plan…');
  });

  it('sets a plan on Standard 3: every term, for the programs; its sub-standards inherit it, labelled "From Standard 3", and the hover cards say so', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead')));
    await user.click(await actions('3.0'));
    await user.click(screen.getByRole('menuitem', { name: 'Set cycle plan…' }));
    const dialog = await screen.findByRole('dialog', { name: /Cycle plan/ });
    expect((await within(dialog).findByTestId('plans-none')).textContent).toContain('No plan applies here yet');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: COURSE })).toBeTruthy());
    await user.selectOptions(within(dialog).getByLabelText('Cycle template'), await within(dialog).findByRole('option', { name: COURSE }));
    expect((within(dialog).getByLabelText('Repeats') as HTMLSelectElement).value).toBe('term');
    setDate(within(dialog).getByLabelText('First run starts'), iso(-30));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Programs' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save plan' }));
    await waitFor(() => expect(within(dialog).getByTestId('effective-plan').textContent).toContain(COURSE));
    const row = within(dialog).getByTestId('effective-plan');
    expect(within(row).getByTestId('plan-recurrence').textContent).toMatch(/Every term/);
    expect(within(row).getByTestId('plan-source').textContent).toBe('(Own)');
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));

    expect(await hoverTip(user, '3.0')).toMatch(new RegExp(`Cycle plans\\s*${COURSE.replace(/[()]/g, '\\$&')} · Every term \\(Own\\)`));
    await unhover(user, '3.0');
    expect(await hoverTip(user, '3.2')).toMatch(/Every term \(From Standard 3\)/);
    await unhover(user, '3.2');
  });

  it('shows the inherited plan with its source on a sub-standard; Opt out stops it there; Back to inherited brings it back', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead')));
    await user.click(await actions('3.2'));
    await user.click(screen.getByRole('menuitem', { name: 'Set cycle plan…' }));
    const dialog = await screen.findByRole('dialog', { name: /Cycle plan/ });
    await waitFor(() => expect(within(dialog).getByTestId('plan-source').textContent).toBe('(From Standard 3)'));
    expect(within(dialog).queryByRole('button', { name: 'Back to inherited' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Opt out' }));
    await waitFor(() => expect(within(dialog).getByTestId('effective-plan').getAttribute('data-opted-out')).toBe('true'));
    expect(within(dialog).getByTestId('opted-out').textContent).toBe('Opted out');
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(await hoverTip(user, '3.2')).toMatch(new RegExp(`${COURSE.replace(/[()]/g, '\\$&')} · Opted out`));
    await unhover(user, '3.2');
    await user.click(await actions('3.2'));
    await user.click(screen.getByRole('menuitem', { name: 'Set cycle plan…' }));
    const again = await screen.findByRole('dialog', { name: /Cycle plan/ });
    await waitFor(() => expect(within(again).getByTestId('effective-plan').getAttribute('data-opted-out')).toBe('true'));
    await user.click(within(again).getByRole('button', { name: 'Back to inherited' }));
    await waitFor(() => expect(within(again).getByTestId('plan-source').textContent).toBe('(From Standard 3)'));
    expect(within(again).getByTestId('effective-plan').getAttribute('data-opted-out')).toBe('false');
  });

  it('overrides on a sub-standard with its own plan (every year), and goes Back to inherited', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead')));
    await user.click(await actions('3.2'));
    await user.click(screen.getByRole('menuitem', { name: 'Set cycle plan…' }));
    const dialog = await screen.findByRole('dialog', { name: /Cycle plan/ });
    await waitFor(() => expect(within(dialog).getByTestId('plan-source').textContent).toBe('(From Standard 3)'));
    await user.click(within(dialog).getByRole('button', { name: 'Override' }));
    expect((within(dialog).getByLabelText('Cycle template') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe(COURSE);
    await user.selectOptions(within(dialog).getByLabelText('Repeats'), 'year');
    await user.click(within(dialog).getByRole('button', { name: 'Save plan' }));
    await waitFor(() => expect(within(dialog).getByTestId('plan-source').textContent).toBe('(Own)'));
    expect(within(dialog).getByTestId('plan-recurrence').textContent).toMatch(/Every year/);
    await user.click(within(dialog).getByRole('button', { name: 'Back to inherited' }));
    await waitFor(() => expect(within(dialog).getByTestId('plan-source').textContent).toBe('(From Standard 3)'));
    expect(within(dialog).getByTestId('plan-recurrence').textContent).toMatch(/Every term/);
  });

  it('on an external standard shows the plan through its approved mapping ("From IQF 3.x"), not through a proposed one', async () => {
    const user = userEvent.setup();
    const lead = apis('lead');
    const assess = iqf.find((r) => r.title === 'Assessment of learning')!;
    const renderExt = async () => { const me = await lead.framework.me(); return render(wrap(<ExternalRequirements api={lead.framework} version={ext.version} me={me} evidence={lead.evidence} apis={{ scope: lead.scope, cycles: lead.cycles, settings: lead.settings, plans: lead.plans }} />)); };
    const m = await lead.framework.createMapping(ids.abet!, { externalRequirementId: ext.sub.id, internalRequirementId: assess.id, relation: 'covers', rationale: 'same ground' });
    await renderExt();
    await user.click(await screen.findByRole('button', { name: `Actions for ${tagOf(ext.sub)}` }));
    await user.click(screen.getByRole('menuitem', { name: 'Set cycle plan…' }));
    let dialog = await screen.findByRole('dialog', { name: /Cycle plan/ });
    expect((await within(dialog).findByTestId('plans-none')).textContent).toContain('No plan applies here yet');
    cleanup();
    await apis('admin').framework.reviewMapping(m.id, 'approved');
    await renderExt();
    await user.click(await screen.findByRole('button', { name: `Actions for ${tagOf(ext.sub)}` }));
    await user.click(screen.getByRole('menuitem', { name: 'Set cycle plan…' }));
    dialog = await screen.findByRole('dialog', { name: /Cycle plan/ });
    await waitFor(() => expect(within(dialog).getByTestId('plan-source').textContent).toBe(`(From IQF ${assess.code})`));
    expect(within(dialog).getByTestId('effective-plan').textContent).toContain(COURSE);
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    const card = await screen.findByRole('region', { name: tagOf(ext.sub) });
    await user.hover(card.querySelector('button[data-tree-focus]') as HTMLElement);
    const tip = await screen.findByRole('tooltip');
    await waitFor(() => expect(tip.textContent).toMatch(new RegExp(`Cycle plans\\s*${COURSE.replace(/[()]/g, '\\$&')} · Every term \\(From IQF ${assess.code.replace('.', '\\.')}\\)`)));
  });
});

describe('Quality Management -> Cycles -> Due to launch', () => {
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
    await user.selectOptions(within(section).getByLabelText('State'), 'upcoming');
    await waitFor(() => expect(within(section).getAllByTestId('due-run')).toHaveLength(2));
    await user.selectOptions(within(section).getByLabelText('State'), '');
    await user.selectOptions(within(section).getByLabelText('Who it is about'), `program:${ids.nursing}`);
    await waitFor(() => expect(within(section).getAllByTestId('due-run')).toHaveLength(2));
    await user.selectOptions(within(section).getByLabelText('Who it is about'), '');
    // 365 days ahead goes past the end of the calendar: said, not guessed.
    await user.selectOptions(within(section).getByLabelText('Look ahead'), '365');
    const gaps = await within(section).findByTestId('due-gaps');
    expect(gaps.textContent).toMatch(/No term defined for that period\./);
    expect(gaps.textContent).toContain('Add it to the academic calendar.');
  });

  it('selects two runs and reviews them one after the other in the shared launch dialog, template, subject and period already filled in', async () => {
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
    expect((within(dialog).getByLabelText('Who the cycle is about') as HTMLSelectElement).disabled).toBe(true);
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
  it('lists the plans with what they are attached to, how often, the next run and how many subjects; says where the calendar ends', async () => {
    render(wrap(qm('lead', 'plans')));
    const rows = await screen.findAllByTestId('plan-row');
    const own = screen.getAllByTestId('plan-row').filter((r) => r.getAttribute('data-mode') === 'own');
    expect(rows.length).toBeGreaterThan(0);
    const std = own.find((r) => r.textContent?.includes(COURSE) && within(r).getByTestId('plan-anchor-kind').textContent === 'Standard or requirement' && within(r).getByTestId('plan-recurrence').textContent === 'Every term')!;
    expect(within(std).getByTestId('plan-subjects').textContent).toBe('2');
    expect(within(std).getByTestId('plan-next').textContent).toMatch(/Current term|Next term/);
    expect(within(std).getByTestId('plan-gap').textContent).toMatch(/No term defined for that period/);
    expect(screen.getAllByTestId('plan-row').some((r) => r.getAttribute('data-mode') === 'opt_out')).toBe(false);   // the opt-out was removed again
  });

  it('attaches a plan to a unit whose next date is set by a decision, then records the date once the first run is made', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead', 'plans')));
    await user.click(await screen.findByRole('button', { name: 'New plan' }));
    const dialog = await screen.findByRole('dialog', { name: /Cycle plan/ });
    expect(within(dialog).getByTestId('plans-in-effect').textContent).toContain('Choose what the plan is attached to first');
    await user.selectOptions(within(dialog).getByLabelText('Attach the plan to'), 'org_unit');
    const which = await within(dialog).findByLabelText('Which one');
    await within(which).findByRole('option', { name: 'Physics' });
    await user.selectOptions(which, ids.physics!);
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Administrative unit review' })).toBeTruthy());
    await user.selectOptions(within(dialog).getByLabelText('Cycle template'), await within(dialog).findByRole('option', { name: 'Administrative unit review' }));
    await user.selectOptions(within(dialog).getByLabelText('Repeats'), 'decision');
    expect(within(dialog).queryByLabelText('Every (number)')).toBeNull();
    setDate(within(dialog).getByLabelText('First run starts'), iso(-3));
    await user.click(within(dialog).getByRole('button', { name: 'Save plan' }));
    await waitFor(() => expect(within(dialog).getByTestId('effective-plan').textContent).toContain('Administrative unit review'));
    expect(within(dialog).getByTestId('plan-recurrence').textContent).toMatch(/When the previous one ends/);
    expect(within(dialog).queryByRole('button', { name: 'Opt out' })).toBeNull();   // nothing above a unit to inherit from
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    const row = await waitFor(() => { const r = screen.getAllByTestId('plan-row').find((x) => x.textContent?.includes('Administrative unit review')); expect(r).toBeTruthy(); return r!; });
    expect(within(row).getByTestId('plan-anchor-kind').textContent).toBe('Unit');
    expect(within(row).getByTestId('plan-subjects').textContent).toBe('1');
    expect(within(row).getByTestId('plan-next').textContent).toMatch(/·/);

    // Its first run is made (from the proposal), and the plan then waits for the date a decision fixes.
    const lead = apis('lead');
    const due = (await lead.plans.due({ horizonDays: 30 })).runs.find((r) => r.templateName === 'Administrative unit review')!;
    await lead.cycles.launch({ templateId: due.templateId, anchorKind: due.anchorKind, anchorId: due.anchorId, startDate: due.periodStart, periodLabel: due.periodLabel, planId: due.planId, periodStart: due.periodStart, ...(due.responsibleUnitId ? { responsibleUnitId: due.responsibleUnitId } : {}) });
    cleanup();
    render(wrap(qm('lead', 'plans')));
    const waiting = await waitFor(() => { const r = screen.getAllByTestId('plan-row').find((x) => x.textContent?.includes('Administrative unit review') && x.textContent.includes('Waiting for the next date')); expect(r).toBeTruthy(); return r!; });
    setDate(within(waiting).getByLabelText('Date of the next run of Administrative unit review'), iso(20));
    await user.click(within(waiting).getByRole('button', { name: 'Set the date' }));
    await waitFor(() => expect(within(screen.getAllByTestId('plan-row').find((x) => x.textContent?.includes('Administrative unit review'))!).getByTestId('plan-next').textContent).not.toMatch(/Waiting/));
  });

  it('filters by what they are attached to and searches', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead', 'plans')));
    await waitFor(() => expect(screen.getAllByTestId('plan-row').length).toBeGreaterThanOrEqual(2));
    await user.selectOptions(screen.getByLabelText('Attached to'), 'org_unit');
    await waitFor(() => expect(screen.getAllByTestId('plan-row')).toHaveLength(1));
    await user.selectOptions(screen.getByLabelText('Attached to'), 'evidence_item');
    expect((await screen.findByTestId('no-plans')).textContent).toContain('No plan matches');
    await user.selectOptions(screen.getByLabelText('Attached to'), '');
    await user.type(screen.getByLabelText('Search plans'), 'administrative');
    await waitFor(() => expect(screen.getAllByTestId('plan-row')).toHaveLength(1));
  });

  it('is read-only for a viewer: the list, no New plan, no Change', async () => {
    render(wrap(qm('viewer', 'plans')));
    await waitFor(() => expect(screen.getAllByTestId('plan-row').length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole('button', { name: 'New plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Change the plan/ })).toBeNull();
    expect(screen.queryByRole('form', { name: /Next date for/ })).toBeNull();
  });
});
