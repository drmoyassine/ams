// @vitest-environment jsdom
// An external standard's requirements and the institution's quality framework (IQF), against the real API and database:
// "Map to IQF…" and "Link evidence" in the ⋯ menu of any requirement, the hover card (mapped IQF items, inherited and direct
// evidence, one batched request), editing a mapping's commentary, and the same layout as the IQF page.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within, act } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, MemoryStore, seedFrameworks } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { SPLIT_ASIDE_CLASS, SPLIT_CLASS, SPLIT_LIST_CLASS } from './components/requirements-layout';
import { targetText } from './components/evidence-links';
import { createApi } from './lib/api';
import { evidenceApi, type EvidenceApi } from './lib/evidence-api';
import { frameworkApi, type Requirement } from './lib/framework-api';
import { glossaryApi } from './lib/glossary-api';
import { settingsApi } from './lib/settings-api';
import { QualityFrameworkPage } from './pages/settings/quality-framework';
import { VersionPage } from './pages/version';
import { tagOf } from './pages/version/review-dialogs';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
let requests: string[] = [];
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const fetchAs = (who: string) => ((input: RequestInfo | URL, init?: RequestInit) => {
  requests.push(typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url);
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apis = (who: string) => {
  const a = createApi(fetchAs(who));
  return { evidence: evidenceApi(a, fetchAs(who)), framework: frameworkApi(a), glossary: glossaryApi(a), settings: settingsApi(a) };
};
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
/** jsdom has no media queries: say whether the screen is wide enough (1280px) for the panel beside the list. */
function screenIs(wide: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: wide && q.includes('1280'), media: q, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
const version = (who: string, evidence?: EvidenceApi) => {
  const a = apis(who);
  return <VersionPage versionId={ids.abet!} api={a.framework} evidence={evidence ?? a.evidence} onOpenVersion={() => undefined} />;
};
/** The button that opens a requirement's card (named by its code and title; a region's own button, not its sub-items'). */
const toggleOf = async (r: Requirement) => (await screen.findByRole('region', { name: tagOf(r) })).querySelector('button[data-tree-focus]') as HTMLElement;
const openMenu = async (user: ReturnType<typeof userEvent.setup>, r: Requirement) => {
  await user.click(await screen.findByRole('button', { name: `Actions for ${tagOf(r)}` }));
};
let sub: Requirement; // a requirement below the top level (any level can be mapped and linked)
let top: Requirement;

beforeAll(async () => {
  db = await createTestDb('webexternaliqf');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  await seedFrameworks(pool);

  // The quality framework from the template plus an item with an Arabic title, published.
  const a = apis('admin');
  const qf = await a.framework.setUpQualityFramework({ template: true });
  const qv = qf.versions[0]!.id;
  await a.framework.addQualityItem(qv, { code: '9', title: 'جودة التعلم والتعليم' });
  for (const r of await a.framework.requirements(qv)) await a.framework.reviewRequirement(r.id, 'approved');
  await a.framework.submit(qv);
  await a.framework.publish(qv);
  const iqf = await a.framework.requirements(qv);
  ids.assessment = iqf.find((r) => r.title === 'Assessment of learning')!.id;
  ids.assessmentCode = iqf.find((r) => r.title === 'Assessment of learning')!.code;
  ids.arabic = iqf.find((r) => r.code === '9')!.id;

  const abet = (await a.framework.frameworks()).find((f) => f.accreditorShortName === 'ABET')!;
  ids.abet = (await a.framework.versions(abet.id))[0]!.id;
  const reqs = await a.framework.requirements(ids.abet);
  top = reqs.find((r) => !r.parentId && reqs.some((c) => c.parentId === r.id))!;
  sub = reqs.find((r) => r.parentId === top.id)!;

  // Evidence on the IQF item (approved), so it reaches `sub` through an approved mapping; and some linked to `sub` itself.
  const mk = async (title: string) => {
    const item = await a.evidence.create({ title, type: 'document', periodLabel: 'AY2025-26', url: `https://intranet.example.edu/${encodeURIComponent(title)}` });
    return (await a.evidence.get(item.id)).versions[0]!.id;
  };
  ids.minutes = await mk('Course review minutes');
  ids.audit = await mk('Laboratory safety audit');
  const l = await a.evidence.linkInternal(ids.assessment!, { evidenceVersionId: ids.minutes!, rationale: 'Annual review of assessment results' });
  await a.evidence.review(l.id, { decision: 'approved' });
  const m = await a.framework.createMapping(ids.abet!, { externalRequirementId: sub.id, internalRequirementId: ids.assessment!, relation: 'covers', rationale: 'Assessment is reviewed every year' });
  await a.framework.reviewMapping(m.id, 'approved');
  ids.mapping = m.id;
}, 120000);
afterEach(() => { cleanup(); screenIs(false); requests = []; });
afterAll(async () => { await pool.end(); await db.close(); });

describe('the ⋯ menu of an external requirement', () => {
  it('offers Map to IQF… and Link evidence to someone who may write each, at any level, and neither to a viewer', async () => {
    screenIs(false);
    const user = userEvent.setup();
    const { unmount } = render(wrap(version('lead')));
    await openMenu(user, sub);
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(expect.arrayContaining(['Map to IQF…', 'Link evidence']));
    await user.keyboard('{Escape}');
    await openMenu(user, top);
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(expect.arrayContaining(['Map to IQF…', 'Link evidence']));
    unmount();

    render(wrap(version('viewer')));
    await screen.findByRole('region', { name: tagOf(sub) });
    await user.click(await screen.findByRole('button', { name: `Actions for ${tagOf(sub)}` }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent).filter((t) => t === 'Map to IQF…' || t === 'Link evidence')).toEqual([]);
  });
});

describe('Map to IQF…', () => {
  it('searches the IQF (English and Arabic), proposes several mappings with a relation and a commentary each, and skips what is already mapped', async () => {
    screenIs(false);
    const user = userEvent.setup();
    render(wrap(version('lead')));
    await openMenu(user, sub);
    await user.click(screen.getByRole('menuitem', { name: 'Map to IQF…' }));
    const dialog = await screen.findByRole('dialog');
    const search = await within(dialog).findByLabelText('Search IQF items');
    // The item already mapped is listed but cannot be picked again.
    expect((await within(dialog).findByRole('checkbox', { name: new RegExp(`^${ids.assessmentCode}\\b`) }) as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByText('(already mapped)')).toBeTruthy();

    await user.type(search, 'جودة');
    const arabic = within(dialog).getByRole('checkbox', { name: /جودة التعلم والتعليم/ });
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1);
    expect(arabic.closest('label')!.querySelector('[dir="auto"]')).toBeTruthy();
    await user.click(arabic);
    await user.clear(search);
    await user.type(search, 'faculty');
    await user.click(within(dialog).getAllByRole('checkbox')[0]!);
    await user.clear(search);

    const chosen = within(dialog).getAllByTestId('chosen-iqf');
    expect(chosen).toHaveLength(2);
    expect(within(chosen[0]!).getByLabelText(/^Relation to/)).toHaveProperty('value', 'covers'); // the default
    await user.selectOptions(within(chosen[1]!).getByLabelText(/^Relation to/), 'partly_covers');
    await user.type(within(chosen[0]!).getByLabelText(/^Commentary for/), 'نص تعليق بالعربية');
    expect(within(dialog).getAllByText('Commentary (optional)')).toHaveLength(2);
    await user.click(within(dialog).getByRole('button', { name: 'Propose 2 mappings' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const made = (await apis('admin').framework.mappings(ids.abet!)).mappings.filter((x) => x.externalCode === sub.code && x.id !== ids.mapping);
    expect(made).toHaveLength(2);
    expect(made.map((x) => x.reviewStatus)).toEqual(['pending', 'pending']); // proposed; a reviewer approves
    expect(made.find((x) => x.internalCode === '9')).toMatchObject({ relation: 'covers', rationale: 'نص تعليق بالعربية' });
    expect(made.find((x) => x.internalCode !== '9')).toMatchObject({ relation: 'partly_covers', rationale: null });
    expect(await screen.findByText(/Mapping of .* proposed/)).toBeTruthy();
  });
});

describe('the hover card', () => {
  it('shows the mapped IQF items with their state and the evidence: inherited from the IQF item, and linked directly; one request for the whole page', async () => {
    screenIs(false);
    const user = userEvent.setup();
    await apis('lead').evidence.linkLibrary(sub.id, { evidenceVersionId: ids.audit!, rationale: 'The audit covers this criterion' });
    render(wrap(version('lead')));
    const button = await toggleOf(sub);
    await waitFor(() => expect(requests.filter((r) => r.includes('requirement-context'))).toHaveLength(1));
    await user.hover(button);
    const tip = await screen.findByRole('tooltip');
    await waitFor(() => expect(tip.textContent).toContain('Mapped to IQF'));
    expect(tip.textContent).toContain(ids.assessmentCode);
    expect(tip.textContent).toContain('Assessment of learning');
    expect(tip.textContent).toContain('Covers');
    expect(within(tip).getAllByTestId('review')[0]!.textContent).toContain('approved'); // its status badge
    expect(tip.textContent).toContain(`Inherited from IQF ${ids.assessmentCode}`);
    const inherited = within(tip).getByRole('list', { name: `Evidence inherited from IQF ${ids.assessmentCode}` });
    expect(inherited.textContent).toContain('Course review minutes');
    expect(inherited.textContent).toContain('v1');
    expect(inherited.textContent).toContain('AY2025-26');
    expect(within(tip).getByRole('list', { name: 'Directly linked evidence' }).textContent).toContain('Laboratory safety audit');
    expect(tip.querySelector('[dir="auto"]')).toBeTruthy();
    await user.unhover(button);
    // Hovering other cards asks for nothing more.
    await user.hover(await toggleOf(top));
    await screen.findByRole('tooltip');
    expect(requests.filter((r) => r.includes('requirement-context'))).toHaveLength(1);
  });

  it('says Loading… until the answer has arrived, and shows the same card when the keyboard focus reaches the requirement', async () => {
    screenIs(false);
    const real = apis('lead').evidence;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: EvidenceApi = { ...real, requirementContext: async (v) => { await gate; return real.requirementContext(v); } };
    render(wrap(version('lead', slow)));
    const button = await toggleOf(sub);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => button.focus());
    const tip = await screen.findByRole('tooltip'); // keyboard focus is enough
    expect(tip.textContent).toContain('Loading…');
    release();
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toContain('Mapped to IQF'));
    expect(screen.getByRole('tooltip').textContent).toContain('Course review minutes');
    act(() => button.blur());
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});

describe('Link evidence', () => {
  it('links several pieces to the requirement itself, each with its reason, described as an external target; they carry over by code', async () => {
    screenIs(false);
    const user = userEvent.setup();
    const a = apis('lead');
    const item = await a.evidence.create({ title: 'Faculty workload policy', type: 'document', url: 'https://intranet.example.edu/workload' });
    render(wrap(version('lead')));
    await openMenu(user, top);
    await user.click(screen.getByRole('menuitem', { name: 'Link evidence' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox'));
    await user.click(await within(dialog).findByRole('option', { name: /Faculty workload policy/ }));
    await user.type(within(dialog).getByLabelText('Justification'), 'Defines the workload rules this criterion asks for');
    await user.click(within(dialog).getByRole('button', { name: 'Link evidence' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const links = await a.evidence.internalLinks(top.id);
    expect(links).toHaveLength(1);
    expect(links[0]!).toMatchObject({ evidenceTitle: 'Faculty workload policy', reviewStatus: 'proposed', rationale: 'Defines the workload rules this criterion asks for', target: { kind: 'external', code: top.code } });
    expect(targetText(links[0]!.target)).toMatch(new RegExp(`^ABET ${top.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(external\\)`));
    // The card opened to show it, with its state.
    const card = await screen.findByRole('region', { name: tagOf(top) });
    expect((await within(card).findByTestId('evidence-link')).textContent).toContain('Faculty workload policy');
    // The evidence's own record says where it is linked.
    expect((await a.evidence.get(item.id)).links.map((l) => l.target.kind)).toEqual(['external']);
  });

  it('describes targets: internal, external with the standard and its code, engagement', () => {
    expect(targetText({ kind: 'external', code: '1.2', title: 'Faculty', frameworkLabel: 'ABET', engagementRequirementId: null, engagementId: null, engagementTitle: null })).toBe('ABET 1.2 (external) · Faculty');
    expect(targetText({ kind: 'internal', code: '3.2', title: 'Assessment', engagementRequirementId: null, engagementId: null, engagementTitle: null })).toBe('Internal 3.2 · Assessment');
    expect(targetText({ kind: 'engagement', code: 'C1', title: null, engagementRequirementId: 'x', engagementId: 'y', engagementTitle: 'Mech 2027' })).toBe('Mech 2027 · C1');
  });
});

describe('the Mappings tab', () => {
  it('edits the commentary of a mapping in place (back to review), also adding one where there is none', async () => {
    screenIs(false);
    const user = userEvent.setup();
    const a = apis('lead');
    render(wrap(<VersionPage versionId={ids.abet!} api={a.framework} evidence={a.evidence} initialTab="mappings" onOpenVersion={() => undefined} />));
    const tree = await screen.findByRole('tree', { name: 'Requirements to map' });
    await user.click(await within(tree).findByRole('button', { name: new RegExp(`^${sub.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }));
    const row = (await screen.findAllByTestId('mapping'))[0]!;
    expect(row.textContent).toContain('Assessment is reviewed every year');
    await user.click(within(row).getByRole('button', { name: `Edit commentary on ${ids.assessmentCode}` }));
    const box = within(row).getByLabelText(`Commentary for ${ids.assessmentCode}`);
    await user.clear(box);
    await user.type(box, 'Reviewed in the annual assessment cycle');
    await user.click(within(row).getByRole('button', { name: 'Save commentary' }));
    await waitFor(() => expect(screen.getAllByTestId('mapping')[0]!.textContent).toContain('Reviewed in the annual assessment cycle'));
    const saved = (await a.framework.mappings(ids.abet!)).mappings.find((m) => m.id === ids.mapping)!;
    expect(saved).toMatchObject({ rationale: 'Reviewed in the annual assessment cycle', reviewStatus: 'pending' });
    await a.framework.reviewMapping(ids.mapping!, 'approved'); // leave it approved for the other tests
  });
});

describe('layout', () => {
  it('gives the external standard and the IQF the same container, tree and detail panel classes, with "Select…" in the panel', async () => {
    screenIs(true);
    const ext = render(wrap(version('lead')));
    const extLayout = await ext.findByTestId('requirements-layout');
    expect(extLayout.className).toBe(SPLIT_CLASS);
    expect(within(extLayout).getByTestId('requirement-list').className).toBe(SPLIT_LIST_CLASS);
    expect(within(extLayout).getByTestId('source-panel').className).toBe(SPLIT_ASIDE_CLASS);
    expect(within(extLayout).getByTestId('source-panel').textContent).toMatch(/^Select a requirement/);
    ext.unmount();

    const a = apis('lead');
    const iqf = render(wrap(<QualityFrameworkPage api={a.framework} glossary={a.glossary} settings={a.settings} evidence={a.evidence} />));
    const iqfLayout = await iqf.findByTestId('requirements-layout');
    expect(iqfLayout.className).toBe(SPLIT_CLASS);
    expect(within(iqfLayout).getByTestId('requirement-list').className).toBe(SPLIT_LIST_CLASS);
    expect(within(iqfLayout).getByTestId('detail-panel').className).toBe(SPLIT_ASIDE_CLASS);
    expect(within(iqfLayout).getByTestId('detail-panel').textContent).toMatch(/^Select a standard/);
    // Opening a standard shows its description in the panel, as opening a requirement shows its source.
    const user = userEvent.setup();
    await user.click(await within(iqfLayout).findByRole('button', { name: /Standard 1\.0\s*Mission and governance/ }));
    expect((await within(iqfLayout).findByTestId('iqf-detail')).textContent).toContain('Mission and governance');
  });

  it('keeps one column on a narrow screen for both', async () => {
    screenIs(false);
    const ext = render(wrap(version('lead')));
    await screen.findByRole('list', { name: 'Requirements' });
    expect(screen.queryByTestId('requirements-layout')).toBeNull();
    ext.unmount();
  });
});
