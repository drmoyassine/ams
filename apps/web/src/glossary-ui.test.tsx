// @vitest-environment jsdom
// The glossary in Settings and the terms it puts on engagement screens, against the real API.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, seedFrameworks, seedGlossary } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { engagementApi, type EngagementApi } from './lib/engagement-api';
import { glossaryApi, type GlossaryApi } from './lib/glossary-api';
import { settingsApi, type SettingsApi } from './lib/settings-api';
import { EngagementPage } from './pages/engagement';
import { GlossaryPage } from './pages/settings/glossary';
import { VersionPage } from './pages/version';
import { frameworkApi } from './lib/framework-api';

// Pages fill from real requests; a loaded machine (or CI) needs more than the default second.
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
const apis = (who: string): { glossary: GlossaryApi; settings: SettingsApi; engagement: EngagementApi } => {
  const a = createApi(fetchAs(who));
  return { glossary: glossaryApi(a), settings: settingsApi(a), engagement: engagementApi(a) };
};
const fw = (who: string) => frameworkApi(createApi(fetchAs(who)));
const versionOf = async (short: string) => {
  const f = fw('admin');
  return (await f.versions((await f.frameworks()).find((x) => x.accreditorShortName === short)!.id))[0]!.id;
};
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}

beforeAll(async () => {
  db = await createTestDb('webgloss');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  const unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.mech = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Mechanical Engineering', 'bachelor', '{mechanical}') returning id`, [ids.inst, unit]);
  const grant = (u: string, role: string) => db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u], role]);
  await grant('admin', 'admin'); await grant('lead', 'lead'); await grant('viewer', 'viewer');
  await seedFrameworks(pool);
}, 60000);
afterEach(() => { cleanup(); try { localStorage.clear(); } catch { /* ignore */ } });
afterAll(async () => { await pool.end(); await db.close(); });

describe('glossary settings', () => {
  it('starts empty for an editor and adds the starter terms', async () => {
    const user = userEvent.setup();
    const a = apis('lead');
    render(wrap(<GlossaryPage api={a.glossary} settings={a.settings} />));
    expect(await screen.findByText('No terms yet.')).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Add starter terms' }));
    expect(await screen.findByText(/No level names yet/)).toBeTruthy(); // levels come from the internal quality framework
    cleanup();
    await fw('lead').setUpQualityFramework({ levelLabels: ['Standard', 'Sub-standard'] });
    render(wrap(<GlossaryPage api={a.glossary} settings={a.settings} />));
    const levels = await screen.findByRole('region', { name: 'Levels' });
    expect(within(levels).getAllByTestId('term').map((t) => t.textContent)).toEqual([expect.stringContaining('Standard'), expect.stringContaining('Sub-standard')]);
    expect(levels.textContent).toMatch(/Named by depth/);
    expect(screen.queryByRole('button', { name: 'Map unmapped terms automatically' })).toBeNull(); // it lives on each standard
    expect(screen.queryByText(/How each standard's words map/)).toBeNull();
  });

  it('maps a standard\'s own words on that standard\'s Terminology tab, automatically', async () => {
    const user = userEvent.setup();
    const a = apis('lead');
    render(wrap(<VersionPage versionId={await versionOf('ABET')} api={fw('lead')} glossary={a.glossary} onOpenVersion={() => undefined} />));
    await user.click(await screen.findByRole('tab', { name: 'Terminology' }));
    await user.click(await screen.findByRole('button', { name: 'Map unmapped terms automatically' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/\d+ term\(s\) mapped/);
    const table = await screen.findByRole('table', { name: 'Terminology of ABET' });
    const chosen = (label: string) => (within(table).getByLabelText(label) as HTMLSelectElement).selectedOptions[0]!.textContent;
    await waitFor(() => expect(chosen('ABET Criterion maps to')).toBe('Standard'));
    expect(chosen('ABET Item maps to')).toBe('Sub-standard');
    expect(chosen('ABET deficiency maps to')).toBe('Required action');
    expect(chosen('ABET readiness maps to')).toBe('Not mapped');
    expect(within(table).queryByLabelText('WSCUC CFR maps to')).toBeNull(); // only this standard's words
  });

  it('offers only terms of the right kind for each external word, and remaps one', async () => {
    const user = userEvent.setup();
    const a = apis('lead');
    render(wrap(<VersionPage versionId={await versionOf('WSCUC')} api={fw('lead')} glossary={a.glossary} onOpenVersion={() => undefined} />));
    await user.click(await screen.findByRole('tab', { name: 'Terminology' }));
    const cfr = (await screen.findByLabelText('WSCUC CFR maps to')) as HTMLSelectElement;
    await waitFor(() => expect([...cfr.options].map((o) => o.textContent)).toEqual(['Not mapped', 'Standard', 'Sub-standard']));
    const group = [...cfr.options].find((o) => o.textContent === 'Standard')!.value;
    await user.selectOptions(cfr, group);
    await waitFor(async () => expect((await a.glossary.glossary()).aliases.find((x) => x.externalTerm === 'CFR')?.termId).toBe(group));
  });

  it('adds a term and edits its Arabic label and definition', async () => {
    const user = userEvent.setup();
    const a = apis('lead');
    render(wrap(<GlossaryPage api={a.glossary} settings={a.settings} />));
    await user.click(await screen.findByRole('button', { name: 'Add term' }));
    await user.type(screen.getByLabelText('New term'), 'Quality cycle');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const general = await screen.findByRole('region', { name: 'Other terms' });
    await user.click(await within(general).findByLabelText('Edit Quality cycle'));
    await user.type(await screen.findByLabelText('Term (Arabic)'), 'دورة الجودة');
    await user.type(screen.getByLabelText('Definition (English)'), 'One turn of plan, do, check, act.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(general.textContent).toMatch(/دورة الجودة/));
    expect(general.textContent).toMatch(/One turn of plan, do, check, act\./);
  });

  it('is read-only for someone who cannot edit', async () => {
    const a = apis('viewer');
    render(wrap(<GlossaryPage api={a.glossary} settings={a.settings} />));
    await screen.findByRole('region', { name: 'Levels' });
    expect(screen.queryByRole('button', { name: /Edit / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add term' })).toBeNull();
    cleanup();
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={await versionOf('ABET')} api={fw('viewer')} glossary={a.glossary} onOpenVersion={() => undefined} />));
    await user.click(await screen.findByRole('tab', { name: 'Terminology' }));
    expect(((await screen.findByLabelText('ABET Criterion maps to')) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Map unmapped terms automatically' })).toBeNull();
  });
});

describe('terms on engagement screens', () => {
  it('shows the institution\'s word beside the standard\'s, and follows the Terms choice', async () => {
    await seedGlossary(pool);
    const a = apis('admin');
    const versions = await a.engagement.versions((await a.engagement.frameworks()).find((f) => f.accreditorShortName === 'ABET')!.id);
    const created = await a.engagement.create({ frameworkVersionId: versions[0]!.id, subjectType: 'program', subjectId: ids.mech!, kind: 'initial', reviewYear: 2027, leadUserId: ids.admin! });
    const user = userEvent.setup();
    render(wrap(<EngagementPage id={created.engagement.id} api={a.engagement} />));
    await user.click(await screen.findByRole('tab', { name: 'Requirements' }));
    const levelOf = async (code: string) => (await screen.findByText(code)).closest('li')!.querySelector('[data-testid="level"]')!.textContent;
    await waitFor(async () => expect(await levelOf('Criterion 1')).toBe('Standard · Criterion'));
    expect(await levelOf('Criterion 5(a)')).toBe('Sub-standard · Item');
    await user.selectOptions(screen.getByLabelText('Terms'), 'internal');
    await waitFor(async () => expect(await levelOf('Criterion 1')).toBe('Standard'));
    await user.selectOptions(screen.getByLabelText('Terms'), 'standard');
    await waitFor(async () => expect(await levelOf('Criterion 1')).toBe('Criterion'));
  });
});
