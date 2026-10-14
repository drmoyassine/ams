// @vitest-environment jsdom
// Settings -> Organization (TASK-069): two tabs, the institution logo, the logo in the shell and on the sign-in page, and
// Settings readable by every role. Against the real API and database; nothing leaves the machine.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, configure, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '@ams/api';
import { MemoryStore } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { frameworkApi } from './lib/framework-api';
import { glossaryApi } from './lib/glossary-api';
import { settingsApi, type SettingsApi } from './lib/settings-api';
import { FrameworksPage } from './pages/frameworks';
import { AppLayout } from './pages/layout';
import { LoginPage } from './pages/login';
import { GlossaryPage } from './pages/settings/glossary';
import { SettingsLayout } from './pages/settings/layout';
import { OrganizationPage } from './pages/settings/organization';
import { QualityFrameworkPage } from './pages/settings/quality-framework';

configure({ asyncUtilTimeout: 10000 });
// The app's own client (lib/api) takes `fetch` when it is first imported, so the delegate is in place before any import.
vi.hoisted(() => { (globalThis as { fetch: unknown }).fetch = (...a: unknown[]) => (globalThis as unknown as { __testFetch: (...x: unknown[]) => unknown }).__testFetch(...a); });
vi.mock('./lib/auth', () => ({ authClient: { getSession: async () => ({ data: { user: { id: 'u' } } }), signOut: async () => undefined, signIn: { email: async () => ({}) } } }));

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
let current = 'admin';
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const fetchAs = (who: () => string) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who()]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const settingsFor = (who: string): SettingsApi => { const f = fetchAs(() => who); return settingsApi(createApi(f), f); };
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
// A real 1x1 PNG, and a file that claims to be one but is text.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==', 'base64'));
const pngFile = (name = 'logo.png') => new File([PNG], name, { type: 'image/png' });

beforeAll(async () => {
  db = await createTestDb('weborg');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en, name_ar, accent_color) values ('Gulf University', 'جامعة الخليج', '#1f3b66') returning id`);
  for (const n of ['admin', 'lead', 'viewer', 'ext']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  ids.col = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'College of Engineering') returning id`, [ids.inst]);
  await db.su.query(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BS Physics', 'bachelor')`, [ids.inst, ids.col]);
  const grant = (u: string, role: string) => db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u], role]);
  await grant('admin', 'admin'); await grant('lead', 'lead'); await grant('viewer', 'viewer');
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id, expires_at) values ($1, $2, 'external_reviewer', 'institution', $1, now() + interval '1 day')`, [ids.inst, ids.ext]);
}, 30000);
afterEach(() => { cleanup(); document.documentElement.style.removeProperty('--primary'); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('Organization: two tabs, deep-linkable', () => {
  // The real router, signed in as whoever `current` names (the page's own requests go to the test API).
  async function openRouter(path: string) {
    (globalThis as unknown as { __testFetch: unknown }).__testFetch = fetchAs(() => current);
    const { router, queryClient } = await import('./router');
    queryClient.clear();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await act(async () => { await router.navigate({ href: path, replace: true }); });
    return router;
  }

  it('opens on Institution with Details, Logo and Org chart in that order, and no Languages yet', async () => {
    current = 'admin';
    const router = await openRouter('/settings/organization');
    const tabs = await screen.findByRole('tablist', { name: 'Organization' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Institution', 'Programs']);
    expect(within(tabs).getByRole('tab', { name: 'Institution' }).getAttribute('aria-selected')).toBe('true');
    const panel = await screen.findByRole('tabpanel');
    await within(panel).findByRole('heading', { name: 'Details' });
    await within(panel).findByRole('heading', { name: 'Org chart' });
    expect(within(panel).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Details', 'Logo', 'Org chart']);
    expect(screen.queryByText('Languages')).toBeNull();
    expect(router.state.location.pathname).toBe('/settings/organization');
  });

  it('follows the tab in the address, opens a deep link on Programs, and removes Programs from the Settings menu', async () => {
    current = 'admin';
    const router = await openRouter('/settings/organization?tab=programs');
    const programs = await screen.findByRole('tab', { name: 'Programs' });
    expect(programs.getAttribute('aria-selected')).toBe('true');
    await screen.findByText('BS Physics');
    const menu = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(menu).getByRole('link', { name: 'Organization' })).toBeTruthy();
    expect(within(menu).queryByRole('link', { name: 'Programs' })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Institution' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'institution' }));
    await screen.findByRole('heading', { name: 'Logo' });
    await user.click(screen.getByRole('tab', { name: 'Programs' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'programs' }));
    await screen.findByText('BS Physics');
  });

  it('moves between the tabs with the arrow keys (the focused tab is the selected one)', async () => {
    current = 'admin';
    await openRouter('/settings/organization');
    const user = userEvent.setup();
    const institution = await screen.findByRole('tab', { name: 'Institution' });
    institution.focus();
    expect(institution.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'Programs' }).getAttribute('tabindex')).toBe('-1');
    await user.keyboard('{ArrowRight}');
    const programs = screen.getByRole('tab', { name: 'Programs' });
    await waitFor(() => expect(programs.getAttribute('aria-selected')).toBe('true'));
    expect(document.activeElement).toBe(programs);
    await user.keyboard('{Home}');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Institution' }).getAttribute('aria-selected')).toBe('true'));
    await user.keyboard('{End}');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Programs' }).getAttribute('aria-selected')).toBe('true'));
  });

  it('sends the old Programs address to the Programs tab, and ignores an unknown tab', async () => {
    current = 'admin';
    const router = await openRouter('/settings/programs');
    await screen.findByRole('tab', { name: 'Programs' });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Programs' }).getAttribute('aria-selected')).toBe('true'));
    expect(router.state.location.pathname).toBe('/settings/organization');
    expect(router.state.location.search).toEqual({ tab: 'programs' });
    await act(async () => { await router.navigate({ to: '/settings/organization', search: { tab: 'nonsense' } as never }); });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Institution' }).getAttribute('aria-selected')).toBe('true'));
  });
});

describe('institution logo', () => {
  it('is uploaded, previewed, shown in the header with the name as alt text, and removed again', async () => {
    const user = userEvent.setup();
    const api = settingsFor('admin');
    render(wrap(<OrganizationPage api={api} />));
    await screen.findByText('No logo uploaded');
    expect(await screen.findByText(/PNG, JPEG or WebP, up to 512 KB/)).toBeTruthy();
    await user.upload(screen.getByLabelText('Logo file'), pngFile());
    const preview = await screen.findByAltText('Logo of Gulf University');
    expect(preview.getAttribute('src')).toMatch(/^\/api\/institution\/logo\?v=\d+$/);
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
    cleanup();
    render(wrap(<AppLayout api={api} />));
    const marks = await screen.findAllByTestId('institution-logo'); // the top bar (small screens) and the sidebar
    for (const mark of marks) {
      expect(mark.getAttribute('alt')).toBe('Gulf University');
      expect(mark.getAttribute('src')).toMatch(/^\/api\/institution\/logo\?v=\d+$/);
    }
    cleanup();
    render(wrap(<OrganizationPage api={api} />));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await screen.findByText('No logo uploaded');
    expect(await api.institution()).toMatchObject({ logoVersion: null });
  });

  it('refuses SVG and big files before sending, and shows the server\'s refusal when the bytes are not an image', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(wrap(<OrganizationPage api={settingsFor('admin')} />));
    const input = await screen.findByLabelText('Logo file');
    await user.upload(input, new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/SVG logos are not accepted/);
    await user.upload(input, new File([new Uint8Array(513 * 1024)], 'big.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/larger than 512 KB/));
    await user.upload(input, new File(['not an image at all'], 'fake.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/must be a PNG, JPEG or WebP/));
    expect(screen.getByText('No logo uploaded')).toBeTruthy();
  });

  it('falls back to the institution name in the header when there is no logo, or the file will not load', async () => {
    const api = settingsFor('viewer');
    render(wrap(<AppLayout api={api} />));
    await waitFor(() => expect(screen.getByTestId('institution-name').textContent).toBe('Gulf University'));
    expect(screen.queryByTestId('institution-logo')).toBeNull();
    cleanup();
    await settingsFor('admin').uploadInstitutionLogo(pngFile());
    render(wrap(<AppLayout api={api} />));
    for (const mark of await screen.findAllByTestId('institution-logo')) fireEvent.error(mark);
    await waitFor(() => expect(screen.getByTestId('institution-name').textContent).toBe('Gulf University'));
    expect(screen.queryByTestId('institution-logo')).toBeNull();
    await settingsFor('admin').removeInstitutionLogo();
  });

  it('is shown, with no controls, to someone who cannot edit it', async () => {
    await settingsFor('admin').uploadInstitutionLogo(pngFile());
    render(wrap(<OrganizationPage api={settingsFor('viewer')} />));
    await screen.findByAltText('Logo of Gulf University');
    expect(screen.queryByLabelText('Logo file')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    await settingsFor('admin').removeInstitutionLogo();
  });
});

describe('sign-in page', () => {
  it('shows the institution name, logo and accent colour it is given, and the plain page when it is given nothing', async () => {
    const branding = async () => ({ name: 'جامعة الخليج', accentColor: '#1f3b66', logoUrl: '/api/public/branding/logo?v=1' });
    render(wrap(<LoginPage branding={branding} />));
    const logo = await screen.findByTestId('institution-logo');
    expect(logo.getAttribute('alt')).toBe('جامعة الخليج');
    expect(logo.getAttribute('src')).toBe('/api/public/branding/logo?v=1');
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#1f3b66'));
    fireEvent.error(logo);
    await waitFor(() => expect(screen.getByTestId('login-institution').textContent).toBe('جامعة الخليج'));
    expect(screen.getByTestId('login-institution').querySelector('[dir="auto"]')).toBeTruthy();
    cleanup();
    render(wrap(<LoginPage branding={async () => { throw new Error('offline'); }} />));
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('login-institution')).toBeNull();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy();
  });

  it('is filled from the one public read, without signing in', async () => {
    await settingsFor('admin').uploadInstitutionLogo(pngFile());
    const noUser = ((input: RequestInfo | URL, init?: RequestInit) => app.request(input as string, init)) as typeof fetch;
    const res = await settingsApi(createApi(noUser), noUser).publicBranding();
    expect(res).toMatchObject({ name: 'Gulf University', accentColor: '#1f3b66' });
    expect(res.logoUrl).toMatch(/^\/api\/public\/branding\/logo\?v=\d+$/);
    render(wrap(<LoginPage branding={() => settingsApi(createApi(noUser), noUser).publicBranding()} />));
    expect((await screen.findByTestId('institution-logo')).getAttribute('alt')).toBe('Gulf University');
    await settingsFor('admin').removeInstitutionLogo();
  });
});

describe('Settings for every role', () => {
  const settingsLinks = async (who: string) => {
    render(wrap(<SettingsLayout api={settingsFor(who)} trashApi={{ count: async () => ({ count: 0 }) } as never} />));
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    // the menu depends on the person's permissions, which arrive together with /api/me
    await within(nav).findByRole('link', { name: 'Assistant memory' });
    const names = within(nav).getAllByRole('link').map((a) => a.textContent!.replace(/\d+$/, '').trim());
    cleanup();
    return names;
  };

  it('shows the Settings entry to every role that can read the organization, and not to an external reviewer', async () => {
    for (const who of ['admin', 'lead', 'viewer']) {
      render(wrap(<AppLayout api={settingsFor(who)} />));
      expect(await screen.findByRole('link', { name: 'Settings' })).toBeTruthy();
      cleanup();
    }
    render(wrap(<AppLayout api={settingsFor('ext')} />));
    await screen.findByRole('button', { name: 'Sign out' });
    expect((await settingsFor('ext').me()).permissions).not.toContain('org:read');
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); }); // the shell has had its answer too
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });

  it('lists the pages each role may open: Trash for editors, AI for administrators, the rest for everyone', async () => {
    const base = ['Organization', 'Internal Quality Framework', 'External Standards', 'Documents'];
    expect(await settingsLinks('viewer')).toEqual([...base, 'Assistant memory']);
    expect(await settingsLinks('lead')).toEqual([...base, 'Trash', 'Assistant memory']);
    expect(await settingsLinks('admin')).toEqual([...base, 'Trash', 'Assistant memory', 'AI']);
  });

  it('shows the Organization tabs read-only to a viewer, with the one-line note', async () => {
    const user = userEvent.setup();
    render(wrap(<OrganizationPage api={settingsFor('viewer')} />));
    const name = await screen.findByLabelText('Name (English)') as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Gulf University'));
    expect(name.disabled).toBe(true);
    expect((screen.getByLabelText('Accent colour') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    await screen.findByLabelText('Org chart');
    expect(screen.queryByLabelText(/^Add a unit under /)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add unit' })).toBeNull();
    await waitFor(() => expect(screen.getAllByText('You can view this; ask an administrator to change it.').length).toBe(3)); // details, logo, org chart
    await user.click(screen.getByRole('tab', { name: 'Programs' }));
    await screen.findByText('BS Physics');
    expect(screen.queryByRole('button', { name: 'Add program' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(screen.getAllByText('You can view this; ask an administrator to change it.')).toHaveLength(1);
  });

  it('shows a lead the org chart and programs to edit, and the institution details read-only', async () => {
    const user = userEvent.setup();
    render(wrap(<OrganizationPage api={settingsFor('lead')} />));
    expect(((await screen.findByLabelText('Name (English)')) as HTMLInputElement).disabled).toBe(true);
    expect(await screen.findByLabelText('Add a unit under College of Engineering')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('You can view this; ask an administrator to change it.')).toHaveLength(2)); // details, logo
    await user.click(screen.getByRole('tab', { name: 'Programs' }));
    expect(await screen.findByRole('button', { name: 'Add program' })).toBeTruthy();
    expect(screen.queryByText('You can view this; ask an administrator to change it.')).toBeNull();
  });

  it('shows the quality framework, its terms and the external standards read-only to a viewer', async () => {
    const f = fetchAs(() => 'viewer');
    const api = createApi(f);
    render(wrap(<QualityFrameworkPage api={frameworkApi(api, f)} glossary={glossaryApi(api)} settings={settingsFor('viewer')} />));
    await screen.findByRole('heading', { name: 'Internal Quality Framework' });
    await screen.findByText('You can view this; ask an administrator to change it.');
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
    cleanup();
    render(wrap(<GlossaryPage api={glossaryApi(api)} settings={settingsFor('viewer')} />));
    await screen.findByText('You can view this; ask an administrator to change it.');
    expect(screen.queryByRole('button', { name: 'Add starter terms' })).toBeNull();
    cleanup();
    render(wrap(<FrameworksPage api={frameworkApi(api, f)} />));
    await screen.findByText('You can view this; ask an administrator to change it.');
    expect(screen.queryByRole('button', { name: 'New Standard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create from files' })).toBeNull();
    cleanup();
    // and an editor does not get the note
    const fl = fetchAs(() => 'lead');
    render(wrap(<FrameworksPage api={frameworkApi(createApi(fl), fl)} />));
    await screen.findByRole('button', { name: 'New Standard' });
    expect(screen.queryByText('You can view this; ask an administrator to change it.')).toBeNull();
  });
});
