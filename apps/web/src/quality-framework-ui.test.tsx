// @vitest-environment jsdom
// The institution's own quality framework in Settings, against the real API.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, seedFrameworks } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { frameworkApi } from './lib/framework-api';
import { glossaryApi } from './lib/glossary-api';
import { settingsApi } from './lib/settings-api';
import { QualityFrameworkPage } from './pages/settings/quality-framework';
import { VersionPage } from './pages/version';
import { within } from '@testing-library/react';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const apiOf = (who: string) => createApi(((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch);
const apiFor = (who: string) => frameworkApi(apiOf(who));
const extra = (who: string) => ({ glossary: glossaryApi(apiOf(who)), settings: settingsApi(apiOf(who)) });
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}

beforeAll(async () => {
  db = await createTestDb('webquality');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  await seedFrameworks(pool, undefined);
}, 60000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

describe('quality framework settings', () => {
  it('is set up by an editor with the level names they choose, and a viewer only reads it', async () => {
    const user = userEvent.setup();
    const { unmount } = render(wrap(<QualityFrameworkPage api={apiFor('viewer')} {...extra('viewer')} />));
    expect(await screen.findByText(/has not been set up yet/)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Set up the internal quality framework' })).toBeNull();
    unmount();

    render(wrap(<QualityFrameworkPage api={apiFor('lead')} {...extra('lead')} />));
    const levels = await screen.findByLabelText('Level names');
    await waitFor(() => expect((levels as HTMLInputElement).value).toBe('Standard, Sub-standard'));
    await user.clear(levels);
    await user.type(levels, 'Pillar, Standard, Indicator');
    await user.click(screen.getByRole('button', { name: 'Set up' }));
    const version = (await screen.findByLabelText('Version')) as HTMLSelectElement;
    expect(version.selectedOptions[0]!.textContent).toBe('1 · Draft');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Requirements', 'Definitions', 'Review and publish']);
    // the versions' own editor is this page: the requirements tab is open first, with the add form
    expect(await screen.findByRole('form', { name: 'Add requirement' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Definitions' }));
    // the definitions are part of this page: its level terms are the levels just chosen
    const levelTerms = await screen.findByRole('region', { name: 'Requirement levels' });
    await waitFor(() => expect(within(levelTerms).getAllByTestId('term').map((t) => t.textContent?.match(/^(Pillar|Standard|Indicator)/)?.[1])).toEqual(['Pillar', 'Standard', 'Indicator']));
    // levels are renamed where the terms are, and the terms follow
    const level1 = screen.getByLabelText('Level 1 name');
    await user.clear(level1);
    await user.type(level1, 'Theme');
    await user.click(screen.getByRole('button', { name: 'Save level names' }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Requirement levels' })).getAllByTestId('term').map((t) => t.textContent?.match(/^(Theme|Pillar|Standard|Indicator)/)?.[1])).toEqual(['Theme', 'Standard', 'Indicator']));
  });

  it('opens a version with only the tabs that apply to the institution\'s own framework', async () => {
    const api = apiFor('lead');
    const { versions } = await api.qualityFramework();
    render(wrap(<VersionPage versionId={versions[0]!.id} api={api} onOpenVersion={() => undefined} />));
    expect(await screen.findByRole('heading', { name: 'Version 1' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Requirements', 'Review and publish']);
    expect(screen.getByRole('link', { name: 'Internal Quality Framework' })).toBeTruthy();
  });
});

describe('mappings tab', () => {
  it('maps a requirement of a standard onto an item of the internal quality framework, and an approver reviews it', async () => {
    const user = userEvent.setup();
    const admin = apiFor('admin');
    const { versions } = await admin.qualityFramework();
    const qv = versions[0]!.id;
    const std = await admin.createRequirement(qv, { code: 'Q1', levelLabel: 'Pillar', title: 'Teaching quality' });
    const sub = await admin.createRequirement(qv, { code: 'Q1.1', levelLabel: 'Standard', title: 'Course review', parentId: std.id });
    for (const r of [std, sub]) await admin.reviewRequirement(r.id, 'approved');
    await admin.submit(qv);
    await admin.publish(qv);

    const abet = (await admin.frameworks()).find((f) => f.accreditorShortName === 'ABET')!;
    const abetVersion = (await admin.versions(abet.id))[0]!;
    const reqs = await admin.requirements(abetVersion.id);
    const target = reqs.find((r) => r.isAssessable)!;

    render(wrap(<VersionPage versionId={abetVersion.id} api={apiFor('lead')} onOpenVersion={() => undefined} />));
    await user.click(await screen.findByRole('tab', { name: 'Mappings' }));
    const tree = await screen.findByRole('tree', { name: 'Requirements to map' });
    await user.click(await within(tree).findByRole('button', { name: new RegExp(target.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }));
    expect(await screen.findByText('Not mapped to your internal quality framework yet.')).toBeTruthy();

    const item = await screen.findByLabelText('Internal Quality Framework item');
    await waitFor(() => expect((item as HTMLSelectElement).options.length).toBe(3));
    await user.selectOptions(item, [...(item as HTMLSelectElement).options].find((o) => o.textContent?.includes('Course review'))!.value);
    await user.selectOptions(screen.getByLabelText('Relation'), 'partly_covers');
    await user.type(screen.getByLabelText('Why'), 'Annual course review');
    await user.click(screen.getByRole('button', { name: 'Propose mapping' }));

    const row = await screen.findByTestId('mapping');
    expect(row.textContent).toContain('Course review');
    expect(row.textContent).toContain('Pending review');
    expect(within(row).getByRole('combobox').closest('select')!.value).toBe('partly_covers');
    await user.click(within(row).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByTestId('mapping').textContent).toContain('Reviewed: approved'));
    expect((await admin.mappings(abetVersion.id)).mappings).toHaveLength(1);
  });

  it('shows the viewer the mappings without the controls to change them', async () => {
    const admin = apiFor('admin');
    const abet = (await admin.frameworks()).find((f) => f.accreditorShortName === 'ABET')!;
    const abetVersion = (await admin.versions(abet.id))[0]!;
    const target = (await admin.requirements(abetVersion.id)).find((r) => r.isAssessable)!;
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={abetVersion.id} api={apiFor('viewer')} onOpenVersion={() => undefined} />));
    await user.click(await screen.findByRole('tab', { name: 'Mappings' }));
    const tree = await screen.findByRole('tree', { name: 'Requirements to map' });
    await user.click(await within(tree).findByRole('button', { name: new RegExp(target.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }));
    expect(await screen.findByTestId('mapping')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Map to an internal quality framework item' })).toBeNull();
  });
});
