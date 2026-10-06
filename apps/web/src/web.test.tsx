// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './i18n';
import { createApi } from './lib/api';
import { settingsApi } from './lib/settings-api';
import { ProgramsSettingsPage } from './pages/settings/programs';

afterEach(cleanup);

const programs = [
  { id: '11111111-1111-4111-8111-111111111111', orgUnitId: '22222222-2222-4222-8222-222222222222', nameEn: 'Computer Science', nameAr: null, degreeLevel: 'bachelor', discipline: null, tags: [], active: true },
  { id: '33333333-3333-4333-8333-333333333333', orgUnitId: '22222222-2222-4222-8222-222222222222', nameEn: 'Law', nameAr: 'القانون', degreeLevel: 'master', discipline: null, tags: [], active: true },
];

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
);

/** Answers by path, like the API would: the page asks for the caller, the programs and the org units. */
const serve = (routes: Record<string, { status?: number; body: unknown }>) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const hit = Object.entries(routes).find(([path]) => String(input).endsWith(path));
    const r = hit?.[1] ?? { status: 404, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
const me = { userId: 'u', institutionId: 'i', roles: ['viewer'], permissions: ['program:read', 'org:read'] };

describe('Programs (in Settings)', () => {
  it('loads programs through the typed client with credentials, and lets content pick its direction', async () => {
    const fetcher = serve({ '/api/me': { body: me }, '/api/programs': { body: programs }, '/api/org-units': { body: [] } });
    render(wrap(<ProgramsSettingsPage api={settingsApi(createApi(fetcher as unknown as typeof fetch))} />));
    const names = await screen.findAllByTestId('program-name');
    expect(names.map((n) => n.textContent)).toEqual(['Computer Science', 'القانون']);
    expect(names.every((n) => n.getAttribute('dir') === 'auto')).toBe(true);
    const call = fetcher.mock.calls.find(([u]) => String(u).endsWith('/api/programs')) as unknown as [string, RequestInit];
    expect(call[1].credentials).toBe('include');
    expect(screen.queryByRole('button', { name: 'Add program' })).toBeNull(); // read-only without program:write
  });

  it('shows an empty state', async () => {
    const fetcher = serve({ '/api/me': { body: me }, '/api/programs': { body: [] }, '/api/org-units': { body: [] } });
    render(wrap(<ProgramsSettingsPage api={settingsApi(createApi(fetcher as unknown as typeof fetch))} />));
    expect(await screen.findByText('No programs visible to you yet.')).toBeTruthy();
  });

  it('shows an error when the API refuses', async () => {
    const fetcher = serve({ '/api/me': { body: me }, '/api/programs': { status: 401, body: {} }, '/api/org-units': { body: [] } });
    render(wrap(<ProgramsSettingsPage api={settingsApi(createApi(fetcher as unknown as typeof fetch))} />));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load programs.');
  });
});

describe('LoginPage', () => {
  it('submits credentials and reports failure', async () => {
    const { LoginPage } = await import('./pages/login');
    const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
    const signIn = vi.fn(async () => ({ error: { message: 'bad' } })) as never;
    const root = createRootRoute();
    const login = createRoute({ getParentRoute: () => root, path: '/login', component: () => <LoginPage signIn={signIn} /> });
    const router = createRouter({ routeTree: root.addChildren([login]), history: createMemoryHistory({ initialEntries: ['/login'] }) });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'a@b.edu');
    await user.type(screen.getByLabelText('Password'), 'secret-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Sign-in failed'));
    expect(signIn).toHaveBeenCalledWith({ email: 'a@b.edu', password: 'secret-password' });
  });
});
