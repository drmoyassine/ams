// @vitest-environment jsdom
// Evidence in the SPA against the real API: add a file, attach it once to the internal framework, see it offered on a
// mapped accreditor requirement, link it there with that requirement's own reason, and approve the link.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, MemoryStore, seedFrameworks } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { engagementApi } from './lib/engagement-api';
import { evidenceApi } from './lib/evidence-api';
import { frameworkApi } from './lib/framework-api';
import { glossaryApi } from './lib/glossary-api';
import { settingsApi } from './lib/settings-api';
import { EvidencePage } from './pages/evidence';
import { RequirementWorkspacePage } from './pages/requirement-workspace';
import { QualityFrameworkPage } from './pages/settings/quality-framework';

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
  return { evidence: evidenceApi(a, fetchAs(who)), framework: frameworkApi(a), engagement: engagementApi(a), glossary: glossaryApi(a), settings: settingsApi(a) };
};
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}

beforeAll(async () => {
  db = await createTestDb('webevidence');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  const unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.mech = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Mechanical Engineering', 'bachelor', '{mechanical}') returning id`, [ids.inst, unit]);
  await seedFrameworks(pool);

  // The internal framework from the template, published; an ABET engagement; one ABET requirement mapped onto
  // "Assessment of learning" (approved).
  const a = apis('admin');
  const qf = await a.framework.setUpQualityFramework({ template: true });
  const qv = qf.versions[0]!.id;
  for (const r of await a.framework.requirements(qv)) await a.framework.reviewRequirement(r.id, 'approved');
  await a.framework.submit(qv);
  await a.framework.publish(qv);
  ids.assessment = (await a.framework.requirements(qv)).find((r) => r.title === 'Assessment of learning')!.id;
  const abet = (await a.framework.frameworks()).find((f) => f.accreditorShortName === 'ABET')!;
  const abetVersion = (await a.framework.versions(abet.id))[0]!.id;
  const eng = await a.engagement.create({ frameworkVersionId: abetVersion, subjectType: 'program', subjectId: ids.mech!, kind: 'initial', reviewYear: 2027, leadUserId: ids.admin! });
  const item = (await a.engagement.requirements(eng.engagement.id)).items.find((i) => i.applicable)!;
  ids.er = item.id;
  const m = await a.framework.createMapping(abetVersion, { externalRequirementId: item.requirementId, internalRequirementId: ids.assessment!, relation: 'covers' });
  await a.framework.reviewMapping(m.id, 'approved');
}, 120000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

describe('evidence', () => {
  it('adds a file to the repository and a newer version of it', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<EvidencePage api={a.evidence} framework={a.framework} />));
    await user.click(await screen.findByRole('button', { name: 'Add evidence' }));
    const form = screen.getByRole('form', { name: 'Add evidence' });
    await user.type(within(form).getByLabelText('Title'), 'Course review minutes');
    await user.type(within(form).getByLabelText('Period'), 'AY2025-26');
    await user.upload(within(form).getByLabelText('File'), new File(['minutes v1'], 'minutes.pdf', { type: 'application/pdf' }));
    await user.click(within(form).getByRole('button', { name: 'Add evidence' }));
    const detail = await screen.findByRole('region', { name: 'Evidence: Course review minutes' });
    await waitFor(() => expect(within(detail).getAllByTestId('evidence-version').map((v) => v.textContent)).toEqual([expect.stringMatching(/^v1minutes\.pdf/)]));
    await user.upload(within(detail).getByLabelText('Upload a new version'), new File(['minutes v2'], 'minutes-2.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(within(detail).getAllByTestId('evidence-version')).toHaveLength(2));
    expect(await within(screen.getByRole('list', { name: 'Evidence' })).findByText(/· v2/)).toBeTruthy();
  });

  it('attaches it to an item of the internal framework with a reason', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<QualityFrameworkPage api={a.framework} glossary={a.glossary} settings={a.settings} evidence={a.evidence} />));
    const item = await screen.findByRole('region', { name: 'Standard 3.2' }); // listed under Standard 3.0 without opening it
    await user.click(within(item).getByRole('button', { name: 'Actions for Standard 3.2' }));
    await user.click(screen.getByRole('menuitem', { name: 'Link evidence' }));
    const dialog = await screen.findByRole('dialog');
    const pick = within(dialog).getByLabelText('Evidence', { selector: 'select' }) as HTMLSelectElement;
    await waitFor(() => expect(pick.options.length).toBeGreaterThan(0));
    await user.selectOptions(pick, within(dialog).getByRole('option', { name: /Course review minutes/ }));
    await user.type(within(dialog).getByLabelText('Why it supports this'), 'Minutes of the annual course review');
    await user.click(within(dialog).getByRole('button', { name: 'Link evidence' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const link = await within(item).findByTestId('evidence-link');
    expect(link.textContent).toContain('Proposed');
    await user.click(within(link).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(within(item).getByTestId('evidence-link').textContent).toContain('Approved'));
  });

  it('creates evidence that is not in the repository yet, from the same dialog', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<QualityFrameworkPage api={a.framework} glossary={a.glossary} settings={a.settings} evidence={a.evidence} />));
    const item = await screen.findByRole('region', { name: 'Standard 3.1' });
    await user.click(within(item).getByRole('button', { name: 'Actions for Standard 3.1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Link evidence' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('New evidence'));
    await user.type(within(dialog).getByLabelText('New evidence title'), 'Teaching observation reports');
    await user.upload(within(dialog).getByLabelText('File'), new File(['observations'], 'observations.pdf', { type: 'application/pdf' }));
    await user.type(within(dialog).getByLabelText('Why it supports this'), 'Peer observation of teaching each semester');
    await user.click(within(dialog).getByRole('button', { name: 'Link evidence' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await within(item).findByTestId('evidence-link')).textContent).toContain('Teaching observation reports');
    expect((await a.evidence.list('Teaching observation')).map((e) => e.latest?.fileName)).toEqual(['observations.pdf']);
  });

  it('offers it on the mapped ABET requirement, links it with that requirement\'s own reason, and approves the link', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<RequirementWorkspacePage id={ids.er!} api={a.engagement} evidence={a.evidence} />));
    const card = await screen.findByRole('region', { name: 'Evidence' });
    const suggestion = await within(card).findByTestId('evidence-suggestion');
    expect(suggestion.textContent).toMatch(/Course review minutes.*Assessment of learning.*covers this requirement/s);
    await user.type(within(suggestion).getByLabelText(/Why Course review minutes supports this requirement/), 'Shows the program reviews assessment results every year');
    await user.click(within(suggestion).getByRole('button', { name: 'Link' }));
    const link = await within(card).findByTestId('evidence-link');
    expect(link.textContent).toMatch(/Proposed.*Shows the program reviews assessment results every year/s);
    await waitFor(() => expect(within(card).queryByTestId('evidence-suggestion')).toBeNull()); // linked now
    await user.click(within(link).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(within(card).getByTestId('evidence-link').textContent).toContain('Approved'));
  });

  it('lets a viewer read evidence but not add, link or review', async () => {
    const a = apis('viewer');
    render(wrap(<RequirementWorkspacePage id={ids.er!} api={a.engagement} evidence={a.evidence} />));
    const card = await screen.findByRole('region', { name: 'Evidence' });
    await within(card).findByTestId('evidence-link');
    expect(within(card).queryByRole('button', { name: /Approve|Reject|Remove|Link/ })).toBeNull();
    cleanup();
    render(wrap(<EvidencePage api={a.evidence} framework={a.framework} />));
    await screen.findByText('Course review minutes');
    expect(screen.queryByRole('button', { name: 'Add evidence' })).toBeNull();
  });
});
