// @vitest-environment jsdom
// Settings screens against the real API: institution and branding, the org chart, programs, and who sees what.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { settingsApi, type SettingsApi } from './lib/settings-api';
import { outcomesApi } from './lib/outcomes-api';
import { syllabusApi } from './lib/syllabus-api';
import { AppLayout } from './pages/layout';
import { OrganizationPage } from './pages/settings/organization';
import { ProgramsSettingsPage } from './pages/settings/programs';
import { ProgramPage } from './pages/settings/program-page';
import { ApiKeysPage } from './pages/settings/api-keys';
import { apiKeysApi } from './lib/api-keys-api';
import { academicApi } from './lib/academic-api';
import { richWorkbookXlsx } from './lib/sheet-io';
import { academicWorkbookSheets } from './lib/academic-template';
import { readAcademicFiles } from './pages/settings/academic-io';

// Pages fill from real requests; a loaded machine (or CI) needs more than the default second.
configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const fetchFor = (who: string) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apiFor = (who: string): SettingsApi => { const f = fetchFor(who); return settingsApi(createApi(f), f); };
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}

beforeAll(async () => {
  db = await createTestDb('webset');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  ids.col = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'College of Engineering') returning id`, [ids.inst]);
  ids.other = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'College of Law') returning id`, [ids.inst]);
  const grant = (u: string, role: string, scope: string, id: string) => db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids.inst, ids[u], role, scope, id]);
  await grant('admin', 'admin', 'institution', ids.inst!);
  await grant('lead', 'lead', 'org_unit', ids.col!);
  await grant('viewer', 'viewer', 'institution', ids.inst!);
}, 30000);
afterEach(() => { cleanup(); document.documentElement.style.removeProperty('--primary'); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('app shell', () => {
  it('shows Settings to every role that can read the organization (read-only for those who cannot edit), and no Programs entry', async () => {
    render(wrap(<AppLayout api={apiFor('viewer')} />));
    await screen.findByTestId('institution-name');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByText('Programs')).toBeNull();
    expect(await screen.findByRole('link', { name: 'Settings' })).toBeTruthy();
    cleanup();
    render(wrap(<AppLayout api={apiFor('lead')} />));
    expect(await screen.findByRole('link', { name: 'Settings' })).toBeTruthy();
  });

  it('puts Settings directly above Sign out and shows the institution name', async () => {
    render(wrap(<AppLayout api={apiFor('admin')} />));
    const settings = await screen.findByRole('link', { name: 'Settings' });
    expect(settings.nextElementSibling?.textContent).toBe('Sign out');
    await waitFor(() => expect(screen.getByTestId('institution-name').textContent).toBe('Gulf University'));
  });

  it('opens the navigation in a drawer on small screens, and closes it on Escape, the backdrop or a followed link', async () => {
    const user = userEvent.setup();
    render(wrap(<AppLayout api={apiFor('admin')} />));
    await screen.findByRole('link', { name: 'Settings' });
    const button = screen.getByRole('button', { name: 'Open menu' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('app-drawer');
    await user.click(button);
    const drawer = screen.getByRole('dialog', { name: 'Menu' });
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(drawer.contains(document.activeElement)).toBe(true);
    // The same navigation, once: it moves into the drawer while it is open.
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(1);
    expect(within(drawer).getByRole('link', { name: 'Settings' }).nextElementSibling?.textContent).toBe('Sign out');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
    await user.click(button);
    await user.click(screen.getByTestId('drawer-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(button);
    await user.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Evidence' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('organization settings', () => {
  it('lets an admin change the names and accent colour, and the shell picks the colour up', async () => {
    const user = userEvent.setup();
    render(wrap(<OrganizationPage api={apiFor('admin')} />));
    const name = await screen.findByLabelText('Name (English)');
    await waitFor(() => { expect((name as HTMLInputElement).value).toBe('Gulf University'); expect((name as HTMLInputElement).disabled).toBe(false); });
    await user.type(screen.getByLabelText('Name (Arabic)'), 'جامعة الخليج');
    fireEvent.change(screen.getByLabelText('Accent colour'), { target: { value: '#1F4E79' } });
    expect((await screen.findByTestId('accent-preview')).textContent).toMatch(/contrast \d/);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('status')).textContent).toBe('Saved.');
    expect(await apiFor('admin').institution()).toMatchObject({ nameAr: 'جامعة الخليج', accentColor: '#1f4e79' });
    cleanup();
    render(wrap(<AppLayout api={apiFor('viewer')} />));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#1f4e79'));
  });

  it('refuses a colour that white text cannot be read on, before saving', async () => {
    render(wrap(<OrganizationPage api={apiFor('admin')} />));
    const colour = await screen.findByLabelText('Accent colour');
    await waitFor(() => { expect((colour as HTMLInputElement).value).toBe('#1f4e79'); expect((colour as HTMLInputElement).disabled).toBe(false); });
    fireEvent.change(colour, { target: { value: '#ffee00' } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/darker colour/);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a lead the org chart to edit but not the institution identity', async () => {
    render(wrap(<OrganizationPage api={apiFor('lead')} />));
    expect((await screen.findByLabelText('Name (English)') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(await screen.findByLabelText('Add a unit under College of Engineering')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add unit' })).toBeTruthy();
  });

  it('builds and changes the org chart: add a top-level unit and a sub-unit, rename, and refuse a deactivation that would strand a child', async () => {
    const user = userEvent.setup();
    render(wrap(<OrganizationPage api={apiFor('admin')} />));
    const addUnit = await screen.findByRole('button', { name: 'Add unit' });
    await waitFor(() => expect((addUnit as HTMLButtonElement).disabled).toBe(false)); // the chart has loaded
    await user.click(addUnit);
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Unit name (English)'), 'Deanship of Research');
    await user.click(within(dialog).getByRole('button', { name: 'Add unit' }));
    await screen.findByText('Deanship of Research');

    await user.click(await screen.findByLabelText('Add a unit under College of Engineering'));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading').textContent).toBe('New unit under College of Engineering');
    await user.type(within(dialog).getByLabelText('Unit name (English)'), 'Mechanical Department');
    await user.click(within(dialog).getByRole('button', { name: 'Add unit' }));
    const child = await screen.findByText('Mechanical Department');
    expect(child.closest('[data-testid="org-unit"]')!.getAttribute('data-depth')).toBe('1');

    await user.click(screen.getByLabelText('Open Mechanical Department'));
    dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Unit name (English)'));
    await user.type(within(dialog).getByLabelText('Unit name (English)'), 'Department of Mechanical Engineering');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Department of Mechanical Engineering');

    await user.click(screen.getByLabelText('Open College of Engineering'));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('Active'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/deactivate its sub-units first/);
  });
});

describe('programs settings', () => {
  it('adds a program on its own page: breadcrumb, the unit as an org-chart tree, every field required but the vision, PEOs and PLOs on the page', async () => {
    const user = userEvent.setup();
    ids.dept = await one(`insert into org_unit (institution_id, parent_id, type, name_en) values ($1, $2, 'department', 'Department of Mechanical Engineering') returning id`, [ids.inst, ids.col]);
    let savedId = '';
    render(wrap(<ProgramPage programId="new" api={apiFor('lead')} outcomes={outcomesApi(fetchFor('lead'))} onSaved={(id) => { savedId = id; }} onCancel={() => undefined} />));
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getAllByRole('listitem').map((li) => li.textContent?.replace('›', '').trim())).toEqual(['Settings', 'Programs', 'New program']);
    expect(within(crumbs).getByRole('link', { name: 'Programs' }).getAttribute('href')).toBe('/settings/programs');
    // The unit picker is the org chart: the department sits under its college.
    const unit = screen.getByLabelText('Unit') as HTMLSelectElement;
    await waitFor(() => expect([...unit.options].map((o) => o.text)).toContain('College of Engineering (College)'));
    const names = [...unit.options].map((o) => o.text);
    expect(names.indexOf('   └ Department of Mechanical Engineering (Department)')).toBe(names.indexOf('College of Engineering (College)') + 1);
    expect([...(screen.getByLabelText('Mode') as HTMLSelectElement).options].map((o) => o.text)).toEqual(['Choose', 'On-campus', 'Online', 'Blended']);
    expect(screen.queryByLabelText('Tags')).toBeNull();
    expect(screen.queryByLabelText('Discipline')).toBeNull();
    // Saving with nothing filled in says what is missing (the vision and the SIS code are optional).
    await user.click(await screen.findByRole('button', { name: 'Add program' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Fill in: Name (English), Name (Arabic), Unit, Program code, Mode, Credits, Years, Contact hours, Language, Mission, Description (English), at least one PEO, at least one PLO.');
    expect(savedId).toBe('');
    await user.type(screen.getByLabelText('Name (English)'), 'BS Mechanical Engineering');
    await user.type(screen.getByLabelText('Name (Arabic)'), 'بكالوريوس الهندسة الميكانيكية');
    await user.selectOptions(unit, ids.dept!);
    await user.type(screen.getByLabelText('Program code'), 'BS-ME');
    await user.selectOptions(screen.getByLabelText('Mode'), 'on_campus');
    await user.type(screen.getByLabelText('Credits'), '132');
    await user.type(screen.getByLabelText('Years'), '4');
    await user.type(screen.getByLabelText('Contact hours'), '2200');
    await user.selectOptions(screen.getByLabelText('Language'), 'English');
    await user.type(screen.getByLabelText('Mission'), 'To educate mechanical engineers.');
    await user.type(screen.getByLabelText('Description (English)'), 'A four-year degree in mechanical engineering.');
    await user.click(screen.getByRole('button', { name: 'Add PEO' }));
    await user.type(screen.getByLabelText('PEO 1 statement'), 'Graduates lead engineering work');
    await user.click(screen.getByRole('button', { name: 'Add PLO' }));
    await user.type(screen.getByLabelText('PLO 1 statement'), 'Solve engineering problems');
    await user.click(screen.getByRole('button', { name: 'Add program' }));
    await waitFor(() => expect(savedId).not.toBe(''));
    const saved = (await apiFor('lead').programs()).find((p) => p.id === savedId)!;
    expect(saved).toMatchObject({ code: 'BS-ME', orgUnitId: ids.dept, mode: 'on_campus', credits: 132, durationYears: 4, contactHours: 2200, languageOfInstruction: 'English', vision: null, description: 'A four-year degree in mechanical engineering.', descriptionAr: null, missing: [] });
    cleanup();
    // Opened again (its own address), the record is filled in and its PEO and PLO are listed to edit in place.
    render(wrap(<ProgramPage programId={savedId} api={apiFor('lead')} outcomes={outcomesApi(fetchFor('lead'))} syllabus={syllabusApi(fetchFor('lead'))} onSaved={() => undefined} onCancel={() => undefined} />));
    expect(await screen.findByRole('heading', { name: 'BS Mechanical Engineering' })).toBeTruthy();
    expect((screen.getByLabelText('Program code') as HTMLInputElement).value).toBe('BS-ME');
    await screen.findByText('Solve engineering problems');
    await user.clear(screen.getByLabelText('Credits')); await user.type(screen.getByLabelText('Credits'), '130');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('status');
    expect((await apiFor('lead').programs()).find((p) => p.id === savedId)!.credits).toBe(130);
  });

  it('lists programs with links to their pages, flags what a record lacks, and deactivates one', async () => {
    const user = userEvent.setup();
    await db.su.query(`insert into program (institution_id, org_unit_id, name_en, degree_level, code) values ($1, $2, 'BS Industrial Engineering', 'bachelor', 'BS-IE')`, [ids.inst, ids.col]);
    render(wrap(<ProgramsSettingsPage api={apiFor('lead')} />));
    expect((await screen.findByRole('link', { name: 'Add program' })).getAttribute('href')).toBe('/settings/programs/new');
    const ie = (await screen.findByText('BS Industrial Engineering')).closest('[data-testid="program"]') as HTMLElement;
    expect(within(ie).getByText(/^Missing: Arabic name, Mode, Credits, Years, Contact hours, Language, Mission, Description \(English\), PEOs, PLOs$/)).toBeTruthy();
    const me = (await screen.findByText('BS Mechanical Engineering')).closest('[data-testid="program"]') as HTMLElement;
    expect(within(me).queryByText(/^Missing/)).toBeNull();
    expect(within(me).getByRole('link', { name: 'Edit BS Mechanical Engineering' }).getAttribute('href')).toMatch(/^\/settings\/programs\/[0-9a-f-]{36}$/);
    await user.click(within(ie).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(screen.queryByText('BS Industrial Engineering')).toBeNull());
    await user.click(screen.getByLabelText('Show inactive'));
    expect(((await screen.findByText('BS Industrial Engineering')).closest('[data-testid="program"]') as HTMLElement).textContent).toMatch(/Inactive/);
  });

  it('is read-only for someone who cannot write programs', async () => {
    await db.su.query(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'LLB Law', 'bachelor')`, [ids.inst, ids.other]);
    render(wrap(<ProgramsSettingsPage api={apiFor('viewer')} />));
    await screen.findAllByTestId('program');
    expect(screen.queryByRole('link', { name: 'Add program' })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Edit / })).toBeNull();
    expect(screen.getAllByRole('link', { name: /^Open / }).length).toBeGreaterThan(0);
  });
});

describe('programs import and export', () => {
  it('previews a CSV row by row, then applies it: adds by Program code, skips what cannot be placed', async () => {
    const user = userEvent.setup();
    render(wrap(<ProgramsSettingsPage api={apiFor('admin')} programs={academicApi(fetchFor('admin'))} />));
    await user.click(await screen.findByRole('button', { name: 'Import and export' }));
    const panel = await screen.findByRole('region', { name: 'Import and export' });
    const csv = 'Program code,Name (English),Unit,Program level,Mode\nBS-CHE,BS Chemical Engineering,College of Engineering,Bachelor,On-campus\nBS-Q,BS Quantum,Nowhere,Bachelor,Online\n';
    await user.upload(await within(panel).findByLabelText('Workbook file'), new File([csv], 'programs.csv', { type: 'text/csv' }));
    const preview = await within(panel).findByRole('region', { name: 'Import preview' });
    expect(within(preview).getByText(/1 to add, 0 to update, 0 into drafts, 0 unchanged, 1 skipped/)).toBeTruthy();
    expect(within(preview).getByText('no unit "Nowhere" in the org chart')).toBeTruthy();
    expect(within(preview).getByText(/Missing: Arabic name, Credits/)).toBeTruthy();
    expect(screen.queryByText('BS Chemical Engineering')).toBeNull(); // nothing written yet
    await user.click(within(preview).getByRole('button', { name: 'Apply' }));
    await within(panel).findByRole('region', { name: 'Import result' });
    const row = (await screen.findByText('BS Chemical Engineering')).closest('[data-testid="program"]') as HTMLElement;
    expect(within(row).getByText(/^Missing:/)).toBeTruthy();
  });
});

describe('the academic workbook, round trip', () => {
  it('exports everything with IDs as a workbook that, read back and previewed, changes nothing', async () => {
    const api = academicApi(fetchFor('admin'));
    const all = await api.exportAll();
    expect(all.programs.length).toBeGreaterThan(0);
    expect(all.programs.every((r) => /^[0-9a-f-]{36}$/.test(String(r.ID)))).toBe(true);
    const blob = await richWorkbookXlsx(academicWorkbookSheets(all));
    const { workbook } = await readAcademicFiles([new File([await blob.arrayBuffer()], 'Academic workbook.xlsx')]);
    expect(workbook.programs).toHaveLength(all.programs.length);
    const preview = await api.upsert(workbook, false);
    expect(preview.rows.filter((r) => r.action !== 'unchanged').map((r) => `${r.sheet} ${r.code}: ${r.action} ${r.message}`)).toEqual([]);
  });
});

describe('API keys', () => {
  it('lets an admin issue a key, shows it once, lists it without its secret, and revokes it', async () => {
    const user = userEvent.setup();
    render(wrap(<ApiKeysPage api={apiKeysApi(fetchFor('admin'))} />));
    await user.type(await screen.findByLabelText('Key name'), 'Student system');
    await user.selectOptions(screen.getByLabelText('Key role'), 'lead');
    await user.click(screen.getByRole('button', { name: 'Issue key' }));
    const shown = await screen.findByTestId('new-key');
    const token = shown.textContent!;
    expect(token).toMatch(/^ams_[0-9a-f-]{36}_/);
    const list = await screen.findByRole('list', { name: 'API keys' });
    await within(list).findByText('Student system');
    expect(list.textContent).not.toContain(token);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('new-key')).toBeNull();
    // The key works until it is revoked.
    expect((await app.request('/api/programs', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    await user.click(within(list).getByRole('button', { name: 'Revoke Student system' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Revoke Student system?' })).getByRole('button', { name: 'Revoke' }));
    await within(list).findByText(/^Revoked/);
    expect((await app.request('/api/programs', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });
});

