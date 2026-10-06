// @vitest-environment jsdom
// Settings screens against the real API: institution and branding, the org chart, programs, and who sees what.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { settingsApi, type SettingsApi } from './lib/settings-api';
import { AppLayout } from './pages/layout';
import { OrganizationPage } from './pages/settings/organization';
import { ProgramsSettingsPage } from './pages/settings/programs';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const apiFor = (who: string): SettingsApi => settingsApi(createApi(((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch));
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
  it('shows Settings only to people who can manage something, and no Programs entry', async () => {
    render(wrap(<AppLayout api={apiFor('viewer')} />));
    await screen.findByTestId('institution-name');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByText('Programs')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
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
});

describe('organization settings', () => {
  it('lets an admin change the names and accent colour, and the shell picks the colour up', async () => {
    const user = userEvent.setup();
    render(wrap(<OrganizationPage api={apiFor('admin')} />));
    const name = await screen.findByLabelText('Name (English)');
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('Gulf University'));
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
    await waitFor(() => expect((colour as HTMLInputElement).value).toBe('#1f4e79'));
    fireEvent.change(colour, { target: { value: '#ffee00' } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/darker colour/);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a lead the org chart to edit but not the institution identity', async () => {
    render(wrap(<OrganizationPage api={apiFor('lead')} />));
    expect((await screen.findByLabelText('Name (English)') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(await screen.findByLabelText('Edit College of Engineering')).toBeTruthy();
    expect(screen.queryByLabelText('New top-level unit')).toBeNull();
  });

  it('builds and changes the org chart: add a top-level unit and a sub-unit, rename, and refuse a deactivation that would strand a child', async () => {
    const user = userEvent.setup();
    render(wrap(<OrganizationPage api={apiFor('admin')} />));
    await user.type(await screen.findByLabelText('New top-level unit'), 'Deanship of Research');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('Deanship of Research');

    await user.click(await screen.findByLabelText('Add a unit under College of Engineering'));
    await user.type(screen.getByLabelText('Name of the new unit under College of Engineering'), 'Mechanical Department');
    await user.click(screen.getByRole('button', { name: 'Add unit' }));
    const child = await screen.findByText('Mechanical Department');
    expect(child.closest('[data-testid="org-unit"]')!.getAttribute('style')).toMatch(/padding-inline-start: 2rem/);

    await user.click(screen.getByLabelText('Edit Mechanical Department'));
    const form = (await screen.findByLabelText('Unit name')).closest('form')!;
    await user.clear(within(form).getByLabelText('Unit name'));
    await user.type(within(form).getByLabelText('Unit name'), 'Department of Mechanical Engineering');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await screen.findByText('Department of Mechanical Engineering');

    await user.click(screen.getByLabelText('Edit College of Engineering'));
    const parentForm = (await screen.findAllByLabelText('Unit name'))[0]!.closest('form')!;
    const options = within(within(parentForm).getByLabelText('Unit parent')).getAllByRole('option').map((o) => o.textContent);
    expect(options).not.toContain('Department of Mechanical Engineering'); // a unit cannot move under its own sub-unit
    await user.click(within(parentForm).getByRole('button', { name: 'Deactivate' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/deactivate its sub-units first/);
  });
});

describe('programs settings', () => {
  it('adds a program with Arabic name and tags, edits it, and deactivates it', async () => {
    const user = userEvent.setup();
    render(wrap(<ProgramsSettingsPage api={apiFor('lead')} />));
    await user.click(await screen.findByRole('button', { name: 'Add program' }));
    const add = await screen.findByLabelText('Add program');
    await waitFor(() => expect(within(within(add).getByLabelText('Program org unit')).getAllByRole('option').length).toBeGreaterThan(1));
    await user.type(within(add).getByLabelText('Program name (English)'), 'BS Mechanical Engineering');
    await user.type(within(add).getByLabelText('Program name (Arabic)'), 'بكالوريوس الهندسة الميكانيكية');
    await user.selectOptions(within(add).getByLabelText('Program org unit'), ids.col!);
    await user.type(within(add).getByLabelText('Tags'), 'mechanical, engineering, mechanical');
    await user.click(within(add).getByRole('button', { name: 'Add program' }));
    const row = (await screen.findByText('بكالوريوس الهندسة الميكانيكية')).closest('[data-testid="program"]') as HTMLElement;
    expect(row.textContent).toMatch(/tags: mechanical, engineering/);
    expect(within(row).getByTestId('program-name').getAttribute('dir')).toBe('auto');

    await user.click(within(row).getByRole('button', { name: 'Edit BS Mechanical Engineering' }));
    const tags = await within(row).findByLabelText('Tags');
    await user.clear(tags);
    await user.type(tags, 'mechanical');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(row.textContent).toMatch(/tags: mechanical(?!, engineering)/));

    await user.click(within(row).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(screen.queryByText('بكالوريوس الهندسة الميكانيكية')).toBeNull());
    await user.click(screen.getByLabelText('Show inactive'));
    const back = (await screen.findByText('بكالوريوس الهندسة الميكانيكية')).closest('[data-testid="program"]') as HTMLElement;
    expect(back.textContent).toMatch(/Inactive/);
  });

  it('is read-only for someone who cannot write programs', async () => {
    await db.su.query(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'LLB Law', 'bachelor')`, [ids.inst, ids.other]);
    render(wrap(<ProgramsSettingsPage api={apiFor('viewer')} />));
    await screen.findAllByTestId('program');
    expect(screen.queryByRole('button', { name: 'Add program' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
  });
});
