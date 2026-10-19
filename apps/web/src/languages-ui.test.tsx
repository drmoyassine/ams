// @vitest-environment jsdom
// Languages in the interface (TASK-070): the header language menu, the language and direction of the page, strings merged over
// English with a fallback, the Languages section of Settings -> Organization (states, confirmation, review table, read-only), and
// the sign-in page's language. Against the real API and database; nothing leaves the machine.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@ams/api';
import { MemoryStore } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import i18n from './i18n';
import { createApi } from './lib/api';
import { resetContentLanguageForTests, resolveContent, useContentLanguage } from './lib/content-language';
import { formatBytes, formatDate, formatNumber } from './lib/intl';
import { activateLocale } from './lib/language';
import { settingsApi, type SettingsApi } from './lib/settings-api';
import { AppLayout } from './pages/layout';
import { LoginPage } from './pages/login';
import { OrganizationPage } from './pages/settings/organization';
import { act, renderHook } from '@testing-library/react';

configure({ asyncUtilTimeout: 10000 });
vi.hoisted(() => { (globalThis as { fetch: unknown }).fetch = (...a: unknown[]) => (globalThis as unknown as { __testFetch: (...x: unknown[]) => unknown }).__testFetch(...a); });
vi.mock('./lib/auth', () => ({ authClient: { getSession: async () => ({ data: { user: { id: 'u' } } }), signOut: async () => undefined, signIn: { email: async () => ({}) } } }));

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
const settingsFor = (who: string): SettingsApi => { const f = fetchAs(who); return settingsApi(createApi(f), f); };
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const q = (sql: string, p: unknown[] = []) => db.su.query(sql, p);

beforeAll(async () => {
  db = await createTestDb('weblang');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en, name_ar) values ('Gulf University', 'جامعة الخليج') returning id`);
  for (const n of ['admin', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  await q(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1), ($1, $3, 'viewer', 'institution', $1)`, [ids.inst, ids.admin, ids.viewer]);
}, 60000);
beforeEach(async () => {
  await q(`update institution set secondary_language = 'ar', default_locale = 'en'`);
  await q(`update app_user set ui_locale = null`);
  await q(`delete from ui_translation`);
  await q(`delete from translation_run`);
  await q(`insert into ui_translation (institution_id, language, key, source_hash, text, origin) values ($1, 'ar', 'nav.evidence', 'h', 'الأدلة', 'ai'), ($1, 'ar', 'nav.settings', 'h', 'الإعدادات', 'ai')`, [ids.inst]);
  activateLocale('en');
  try { window.localStorage.clear(); } catch { /* ignore */ }
});
afterEach(() => { cleanup(); activateLocale('en'); try { window.localStorage.clear(); } catch { /* ignore */ } });
afterAll(async () => { await pool.end(); await db.close(); });

describe('the language menu in the header', () => {
  it('is hidden when the institution has no secondary language', async () => {
    await q(`update institution set secondary_language = null`);
    render(wrap(<AppLayout api={settingsFor('viewer')} />));
    await screen.findAllByText('Evidence');
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(screen.queryByTestId('language-menu')).toBeNull();
  });

  it('offers English and the language by its own name, and switching sets lang, dir, script and the strings at once', async () => {
    const user = userEvent.setup();
    const api = settingsFor('viewer');
    render(wrap(<AppLayout api={api} />));
    const menus = await screen.findAllByRole('group', { name: 'Interface language' }); // top bar and sidebar
    const menu = menus[0]!;
    expect(within(menu).getAllByRole('button').map((b) => b.textContent)).toEqual(['English', 'العربية']);
    expect(within(menu).getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.dir).toBe('ltr');
    await user.click(within(menu).getByRole('button', { name: 'العربية' }));
    await waitFor(() => expect(document.documentElement.lang).toBe('ar'));
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.dataset.script).toBe('arabic');
    // Translated where the catalogue has the key, English where it does not.
    await waitFor(() => expect(screen.getAllByText('الأدلة').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Accreditations').length).toBeGreaterThan(0);
    // Saved on the person, on the server.
    await waitFor(async () => expect((await q(`select ui_locale from app_user where id = $1`, [ids.viewer])).rows[0].ui_locale).toBe('ar'));
    expect((await api.me()).language).toMatchObject({ uiLocale: 'ar', effectiveLocale: 'ar' });
    // The browser keeps only a hint for the next first paint.
    expect(window.localStorage.getItem('ams.locale')).toBe('ar');
    // And back.
    await user.click(within(screen.getAllByRole('group', { name: 'Interface language' })[0]!).getByRole('button', { name: 'English' }));
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.dataset.script).toBe('latin');
    await waitFor(async () => expect((await q(`select ui_locale from app_user where id = $1`, [ids.viewer])).rows[0].ui_locale).toBe('en'));
  });

  it("applies the person's saved language at once on load, and the institution's default for people who have not chosen", async () => {
    await q(`update app_user set ui_locale = 'ar' where id = $1`, [ids.viewer]);
    render(wrap(<AppLayout api={settingsFor('viewer')} />));
    await waitFor(() => expect(document.documentElement.lang).toBe('ar'));
    expect(document.documentElement.dir).toBe('rtl');
    cleanup();
    await q(`update app_user set ui_locale = null`);
    await q(`update institution set default_locale = 'ar'`);
    activateLocale('en');
    render(wrap(<AppLayout api={settingsFor('admin')} />));
    await waitFor(() => expect(document.documentElement.lang).toBe('ar'));
    // The institution's Arabic name is shown to people using the Arabic interface.
    await waitFor(() => expect(screen.getByTestId('institution-name').textContent).toBe('جامعة الخليج'));
  });

  it('puts the previous language back when saving fails', async () => {
    const api = settingsFor('viewer');
    const failing: SettingsApi = { ...api, updateMyPreferences: async () => { throw new Error('offline'); } };
    const user = userEvent.setup();
    render(wrap(<AppLayout api={failing} />));
    const menu = (await screen.findAllByRole('group', { name: 'Interface language' }))[0]!;
    await user.click(within(menu).getByRole('button', { name: 'العربية' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
  });
});

describe('Languages section (Settings -> Organization)', () => {
  it('with no secondary language shows only the choice, no catalogue', async () => {
    await q(`update institution set secondary_language = null`);
    render(wrap(<OrganizationPage api={settingsFor('admin')} />));
    const heading = await screen.findByRole('heading', { name: 'Languages' });
    expect(heading).toBeTruthy();
    const select = await screen.findByLabelText('Secondary language');
    expect((select as HTMLSelectElement).value).toBe('');
    expect(screen.queryByTestId('catalogue-status')).toBeNull();
    expect(screen.getByText('English (cannot be changed)')).toBeTruthy();
    expect(within(select).getAllByRole('option').length).toBeGreaterThan(29);
    expect(within(select).queryByRole('option', { name: /\(English\)$/ })).toBeNull();
    // Details no longer carries a language select.
    expect(screen.queryByLabelText('Default language')).toBeNull();
  });

  it('shows the catalogue status and the review table, and the section sits between Logo and Org chart', async () => {
    render(wrap(<OrganizationPage api={settingsFor('admin')} />));
    await screen.findByTestId('catalogue-status');
    await screen.findByRole('heading', { name: 'Details' });
    await screen.findByRole('heading', { name: 'Org chart' });
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Details', 'Logo', 'Languages', 'Org chart', 'Scope levels']);
    expect(screen.getByTestId('catalogue-counts').textContent).toMatch(/^2 of \d+ strings translated, 0 reviewed$/);
    expect((screen.getByLabelText('Secondary language') as HTMLSelectElement).value).toBe('ar');
    expect((await screen.findAllByTestId('review-row')).length).toBeGreaterThan(2);
    expect(screen.getByRole('button', { name: 'Translate the interface' })).toBeTruthy();
  });

  it('edits a translation (it becomes a person\'s and reviewed) and marks one reviewed', async () => {
    const user = userEvent.setup();
    render(wrap(<OrganizationPage api={settingsFor('admin')} />));
    await screen.findByTestId('catalogue-status');
    await user.type(screen.getByLabelText('Search keys and texts'), 'nav.settings');
    const row = await screen.findByTestId('review-row');
    expect(within(row).getByText('nav.settings')).toBeTruthy();
    expect(within(row).getByText('AI translation, not reviewed')).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(within(screen.getByTestId('review-row')).getByText('AI translation, reviewed')).toBeTruthy());
    await user.click(within(screen.getByTestId('review-row')).getByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Translation of nav.settings');
    await user.clear(box);
    await user.type(box, 'الضبط');
    await user.click(within(screen.getByTestId('review-row')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(screen.getByTestId('review-row')).getByText('Written by a person')).toBeTruthy());
    expect((await q(`select text, origin, reviewed from ui_translation where key = 'nav.settings'`)).rows[0]).toEqual({ text: 'الضبط', origin: 'person', reviewed: true });
  });

  it('shows the server\'s refusal when an edit breaks a placeholder', async () => {
    const user = userEvent.setup();
    render(wrap(<OrganizationPage api={settingsFor('admin')} />));
    await screen.findByTestId('catalogue-status');
    await user.type(screen.getByLabelText('Search keys and texts'), 'nav.myRequests');
    const row = await screen.findByTestId('review-row');
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Translation of nav.myRequests'));
    await user.type(screen.getByLabelText('Translation of nav.myRequests'), 'طلباتي');
    await user.click(within(screen.getByTestId('review-row')).getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/placeholder/);
  });

  it('asks before changing the secondary language, keeps the old translations, and does nothing on Cancel', async () => {
    const user = userEvent.setup();
    render(wrap(<OrganizationPage api={settingsFor('admin')} />));
    await screen.findByTestId('catalogue-status');
    await waitFor(() => expect((screen.getByLabelText('Secondary language') as HTMLSelectElement).disabled).toBe(false));
    await user.selectOptions(screen.getByLabelText('Secondary language'), 'fr');
    await user.click(screen.getByRole('button', { name: 'Save languages' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/kept, not deleted/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await q(`select secondary_language from institution`)).rows[0].secondary_language).toBe('ar');
    await user.click(screen.getByRole('button', { name: 'Save languages' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Change language' }));
    await waitFor(async () => expect((await q(`select secondary_language, default_locale from institution`)).rows[0]).toEqual({ secondary_language: 'fr', default_locale: 'en' }));
    expect((await q(`select count(*)::int as n from ui_translation where language = 'ar'`)).rows[0].n).toBe(2);
    await screen.findByText(/0 of \d+ strings translated/);
  });

  it('sets the default interface language', async () => {
    const user = userEvent.setup();
    render(wrap(<OrganizationPage api={settingsFor('admin')} />));
    await screen.findByTestId('catalogue-status');
    const def = screen.getByLabelText('Default interface language');
    await waitFor(() => expect((def as HTMLSelectElement).disabled).toBe(false));
    expect(within(def).getAllByRole('option').map((o) => o.textContent)).toEqual(['English', 'العربية']);
    await user.selectOptions(def, 'ar');
    await user.click(screen.getByRole('button', { name: 'Save languages' }));
    await waitFor(async () => expect((await q(`select default_locale from institution`)).rows[0].default_locale).toBe('ar'));
  });

  it('is read-only for someone who cannot edit', async () => {
    render(wrap(<OrganizationPage api={settingsFor('viewer')} />));
    await screen.findByTestId('catalogue-status');
    expect((screen.getByLabelText('Secondary language') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Default interface language') as HTMLSelectElement).disabled).toBe(true);
    for (const name of ['Save languages', 'Translate the interface', 'Mark all as reviewed', 'Edit', 'Mark reviewed']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getAllByTestId('read-only-note').length).toBeGreaterThan(0);
    expect((await screen.findAllByTestId('review-row')).length).toBeGreaterThan(0);
  });

  it('says why translation cannot start when AI is off, and shows a run with its progress and set-aside items', async () => {
    await q(`insert into ai_setting (institution_id, enabled) values ($1, false) on conflict do nothing`, [ids.inst]);
    await q(`update ai_setting set enabled = false`);
    await q(`insert into translation_run (institution_id, kind, language, status, progress, usage, report, error) values ($1, 'ui', 'ar', 'stopped', '{"total":100,"done":40,"flagged":1,"batches":1,"cursor":1}', '{"inputTokens":1000,"outputTokens":500,"costUsd":null,"calls":2}', '{"flagged":[{"id":"json.save","reason":"placeholder {{label}} is missing or was changed"}]}', 'AI token budget for this run is used up')`, [ids.inst]);
    render(wrap(<OrganizationPage api={settingsFor('admin')} />));
    const run = await screen.findByTestId('translation-run');
    expect(within(run).getByTestId('run-status').textContent).toBe('Stopped at the spend limit');
    expect(within(run).getByText('40 of 100 translated, 1 set aside')).toBeTruthy();
    expect(within(run).getByText('1,500 tokens in 2 calls')).toBeTruthy();
    expect(within(run).getByText('json.save')).toBeTruthy();
    expect(await within(run).findByRole('button', { name: 'Resume' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Translate the interface' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Translation cannot start yet/)).toBeTruthy();
    await q(`delete from ai_setting`);
  });
});

describe('the sign-in page', () => {
  const branding = async () => ({ name: null, accentColor: null, logoUrl: null });
  it('speaks the institution\'s default language from the public strings and can switch to English', async () => {
    const user = userEvent.setup();
    const languages = async () => ({ defaultLocale: 'ar', secondaryLanguage: 'ar', strings: { 'login.title': 'تسجيل الدخول', 'login.email': 'البريد' } });
    render(wrap(<LoginPage branding={branding} languages={languages} />));
    await screen.findByRole('heading', { name: 'تسجيل الدخول' });
    expect(screen.getByText('البريد')).toBeTruthy();
    expect(screen.getByText('Password')).toBeTruthy(); // not translated: falls back to English
    expect(document.documentElement.dir).toBe('rtl');
    const group = screen.getByTestId('login-language');
    expect(within(group).getByRole('button', { name: 'العربية' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(within(group).getByRole('button', { name: 'English' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('is plain English when the language read fails or there is no secondary language', async () => {
    render(wrap(<LoginPage branding={branding} languages={async () => { throw new Error('offline'); }} />));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByTestId('login-language')).toBeNull();
  });

  it('uses the language this browser used last when it is still valid', async () => {
    window.localStorage.setItem('ams.locale', 'ar');
    const languages = async () => ({ defaultLocale: 'en', secondaryLanguage: 'ar', strings: { 'login.title': 'تسجيل الدخول' } });
    render(wrap(<LoginPage branding={branding} languages={languages} />));
    await screen.findByRole('heading', { name: 'تسجيل الدخول' });
  });
});

describe('formatting and the content language hook', () => {
  it('formats dates, numbers and sizes with the active language', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatDate('2026-10-05T12:00:00Z', { month: 'long', timeZone: 'UTC' })).toBe('October');
    expect(formatBytes(3 * 1048576)).toBe('3.0 MB');
    activateLocale('de');
    expect(formatNumber(1234567.5)).toBe('1.234.567,5');
    expect(formatDate('2026-10-05T12:00:00Z', { month: 'long', timeZone: 'UTC' })).toBe('Oktober');
    activateLocale('en');
    expect(i18n.language).toBe('en');
  });

  it('resolves content for original, English and the secondary language, falling back to English and saying so', () => {
    const v = { original: 'النص الأصلي', en: 'The English', secondary: null };
    expect(resolveContent(v, 'original')).toEqual({ text: 'النص الأصلي', shown: 'original', fellBack: false });
    expect(resolveContent(v, 'en')).toEqual({ text: 'The English', shown: 'en', fellBack: false });
    expect(resolveContent(v, 'secondary')).toEqual({ text: 'The English', shown: 'en', fellBack: true });
    expect(resolveContent({ original: 'only' }, 'secondary')).toEqual({ text: 'only', shown: 'original', fellBack: true });
    expect(resolveContent({}, 'en').text).toBe('');
  });

  it('keeps the person\'s choice for the session and shares it between components', () => {
    resetContentLanguageForTests();
    const a = renderHook(() => useContentLanguage());
    const b = renderHook(() => useContentLanguage());
    expect(a.result.current.mode).toBe('original');
    act(() => a.result.current.setMode('secondary'));
    expect(b.result.current.mode).toBe('secondary');
    expect(b.result.current.resolve({ en: 'E', secondary: 'S' }).text).toBe('S');
    resetContentLanguageForTests();
  });
});
