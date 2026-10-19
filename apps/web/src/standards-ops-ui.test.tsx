// @vitest-environment jsdom
// Standards in operation (TASK-086) in the SPA against the real API: the Quality Management page's Standards tab, the ⋯ menu
// (Link evidence · Assign scope · Assign champion · Create cycle) by permission, the scope and champion dialogs with what is inherited
// and from where, "Back to inherited", hover cards, the same menu on an external standard (values inherited through mappings), the
// Create cycle dialog, and Settings -> Organization -> Institution -> Scope levels.
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
import { cyclesApi } from './lib/cycles-api';
import { evidenceApi } from './lib/evidence-api';
import { frameworkApi, type Requirement, type Version } from './lib/framework-api';
import { glossaryApi } from './lib/glossary-api';
import { scopeApi } from './lib/scope-api';
import { settingsApi } from './lib/settings-api';
import { OrganizationPage } from './pages/settings/organization';
import { QualityFrameworkPage } from './pages/settings/quality-framework';
import { QualityManagementPage } from './pages/quality-management';
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
  return { raw: a, evidence: evidenceApi(a, fetchAs(who)), framework: frameworkApi(a), glossary: glossaryApi(a), settings: settingsApi(a), scope: scopeApi(a), cycles: cyclesApi(a, fetchAs(who)) };
};
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const qm = (who: string) => {
  const a = apis(who);
  return <QualityManagementPage api={a.framework} evidence={a.evidence} apis={{ scope: a.scope, cycles: a.cycles, settings: a.settings }} />;
};
const menuNames = () => screen.getAllByRole('menuitem').map((m) => m.textContent);
const actions = (code: string) => screen.findByRole('button', { name: `Actions for Standard ${code}` });
const region = (code: string) => screen.findByRole('region', { name: `Standard ${code}` });
/** The card's own toggle (not its sub-standards'). */
const toggle = async (code: string) => (await region(code)).querySelector('button[data-tree-focus]') as HTMLElement;
const hoverTip = async (user: ReturnType<typeof userEvent.setup>, code: string) => {
  const b = await toggle(code);
  await user.hover(b);
  // The tooltip of that card (an earlier hover may not have ended: the pointer was on a dialog that has closed).
  return (await within(await region(code)).findByRole('tooltip')).textContent ?? '';
};
const unhover = async (user: ReturnType<typeof userEvent.setup>, code: string) => { await user.unhover(await toggle(code)); await waitFor(async () => expect(within(await region(code)).queryByRole('tooltip')).toBeNull()); };

let iqf: Requirement[];
let ext: { version: Version; sub: Requirement; top: Requirement };

beforeAll(async () => {
  db = await createTestDb('webstandardsops');
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
  ids.abetFw = abet.id;
  ids.abet = (await a.framework.versions(abet.id))[0]!.id;
  const reqs = await a.framework.requirements(ids.abet);
  const top = reqs.find((r) => !r.parentId && reqs.some((c) => c.parentId === r.id))!;
  const sub = reqs.find((r) => r.parentId === top.id)!;
  ext = { version: await a.framework.version(ids.abet), sub, top };
}, 180000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });
const code = (title: string) => iqf.find((r) => r.title === title)!.code;

describe('Quality Management -> Standards', () => {
  it('has a Standards tab with the institution\'s standards, full width, and no side panel', async () => {
    render(wrap(qm('lead')));
    expect(await screen.findByRole('heading', { name: 'Quality Management' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Standards']);   // the Cycles tab joins with TASK-080
    expect(screen.getByRole('tab', { name: 'Standards' }).getAttribute('aria-selected')).toBe('true');
    const list = await screen.findByRole('list', { name: 'Standards' });
    await waitFor(() => expect(list.textContent).toContain('Assessment of learning'));
    expect(screen.queryByRole('complementary')).toBeNull();
    // Operations, not authoring: no + Standard, no selection toolbar.
    expect(screen.queryByRole('button', { name: '+ Standard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish this version' })).toBeNull();
  });

  it('has the menu Link evidence · Assign scope · Assign champion · Create cycle for a lead; no Request evidence, no authoring', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead')));
    await user.click(await actions('3.2'));
    expect(menuNames()).toEqual(['Link evidence', 'Assign scope', 'Assign champion', 'Create cycle']);
  });

  it('shows only what the person may do: a contributor links evidence; a viewer has no menu', async () => {
    const user = userEvent.setup();
    const { unmount } = render(wrap(qm('contributor')));
    await user.click(await actions('3.2'));
    expect(menuNames()).toEqual(['Link evidence']);
    unmount();
    render(wrap(qm('viewer')));
    await region('3.2');
    expect(screen.queryByRole('button', { name: 'Actions for Standard 3.2' })).toBeNull();
  });

  it('shows the same menu on Settings -> Internal Quality Framework, followed by the authoring items, without Request evidence', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    // The published version is fixed: only the operations are offered there; a draft adds the authoring items.
    render(wrap(<QualityFrameworkPage api={a.framework} glossary={a.glossary} settings={a.settings} evidence={a.evidence} />));
    await user.click(await actions('3.2'));
    expect(menuNames()).toEqual(['Link evidence', 'Assign scope', 'Assign champion', 'Create cycle']);
    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: 'Start a new version' }));
    await waitFor(async () => expect((await screen.findByLabelText('Version') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('2 · Draft'));
    await user.click(await actions('3.0'));
    expect(menuNames()).toEqual(['Link evidence', 'Assign scope', 'Assign champion', 'Create cycle', 'Add sub-standard', 'Edit', 'Delete']);
    expect(screen.queryByRole('menuitem', { name: 'Request evidence' })).toBeNull();
  });
});

describe('Assign scope and Assign champion', () => {
  it('sets a scope on a standard: its sub-standards take it ("From Standard 3"), and the hover card says so', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead')));
    await user.click(await actions('3.0'));
    await user.click(screen.getByRole('menuitem', { name: 'Assign scope' }));
    const dialog = await screen.findByRole('dialog', { name: /Assign scope/ });
    expect(within(dialog).getByTestId('scope-current').textContent).toContain('No scope set');
    await waitFor(() => expect(within(dialog).getAllByRole('option').map((o) => o.textContent)).toEqual(['Institution', 'Unit', 'Program', 'Course']));
    await user.selectOptions(within(dialog).getByLabelText('Level'), await within(dialog).findByRole('option', { name: 'Program' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Only these' }));
    await user.click(within(dialog).getByRole('checkbox', { name: /BS Nursing/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save scope' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(await hoverTip(user, '3.0')).toMatch(/Scope\s*Program: BS Nursing\s*\(Own\)/);
    await unhover(user, '3.0');
    expect(await hoverTip(user, '3.2')).toMatch(/Scope\s*Program: BS Nursing\s*\(From Standard 3\)/);
    await unhover(user, '3.2');
  });

  it('shows what a sub-standard inherits, overrides it, shows what it would be, and goes Back to inherited', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead')));
    await user.click(await actions('3.2'));
    await user.click(screen.getByRole('menuitem', { name: 'Assign scope' }));
    const dialog = await screen.findByRole('dialog', { name: /Assign scope/ });
    await waitFor(() => expect(within(dialog).getByTestId('scope-source').textContent).toBe('(From Standard 3)'));
    expect(within(dialog).getByTestId('scope-current').textContent).toContain('Program: BS Nursing');
    expect(within(dialog).queryByRole('button', { name: 'Back to inherited' })).toBeNull();
    // Start from the inherited value; change it to the Physics unit.
    await user.selectOptions(within(dialog).getByLabelText('Level'), await within(dialog).findByRole('option', { name: 'Unit' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Only these' }));
    await user.click(within(dialog).getByRole('checkbox', { name: /Physics/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save scope' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await hoverTip(user, '3.2')).toMatch(/Scope\s*Unit: Physics\s*\(Own\)/);
    await unhover(user, '3.2');

    await user.click(await actions('3.2'));
    await user.click(screen.getByRole('menuitem', { name: 'Assign scope' }));
    const again = await screen.findByRole('dialog', { name: /Assign scope/ });
    await waitFor(() => expect(within(again).getByTestId('scope-source').textContent).toBe('(Own)'));
    expect(within(again).getByTestId('scope-inherited').textContent).toMatch(/Without its own scope it would be:\s*Program: BS Nursing\s*\(From Standard 3\)/);
    await user.click(within(again).getByRole('button', { name: 'Back to inherited' }));
    await waitFor(() => expect(within(again).getByTestId('scope-source').textContent).toBe('(From Standard 3)'));
    await user.click(within(again).getByRole('button', { name: 'Cancel' }));
    expect(await hoverTip(user, '3.2')).toMatch(/\(From Standard 3\)/);
    await unhover(user, '3.2');
  });

  it('Course is a placeholder: selectable, with "No courses yet"; a level without a list covers all', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead')));
    await user.click(await actions('4.0'));
    await user.click(screen.getByRole('menuitem', { name: 'Assign scope' }));
    const dialog = await screen.findByRole('dialog', { name: /Assign scope/ });
    await user.selectOptions(await within(dialog).findByLabelText('Level'), await within(dialog).findByRole('option', { name: 'Course' }));
    expect(within(dialog).getByTestId('no-courses').textContent).toContain('No courses yet');
    expect(within(dialog).queryByRole('radio', { name: 'Only these' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Save scope' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await hoverTip(user, '4.0')).toMatch(/Scope\s*Course: all\s*\(Own\)/);
    await unhover(user, '4.0');
    await apis('lead').scope.clearScope({ frameworkId: ids.iqfFw!, code: '4' });
  });

  it('assigns an overall champion and one per program; inherited champions are labelled; Back to inherited removes the own ones', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead')));
    await user.click(await actions('3.0'));
    await user.click(screen.getByRole('menuitem', { name: 'Assign champion' }));
    const dialog = await screen.findByRole('dialog', { name: /Assign champion/ });
    expect(within(dialog).getByTestId('champion-current').textContent).toContain('No champion set');
    const overallSelect = await within(dialog).findByLabelText('Overall champion');
    await user.selectOptions(overallSelect, await within(overallSelect).findByRole('option', { name: 'admin' }));
    await user.click(within(dialog).getByRole('button', { name: 'Set champion' }));
    await waitFor(() => expect(within(dialog).getByTestId('champion-overall').textContent).toMatch(/admin\s*\(Own\)/));
    // Its scope (Program: BS Nursing) offers that program for its own champion.
    await user.selectOptions(await within(dialog).findByLabelText('Unit or program'), await within(dialog).findByRole('option', { name: 'BS Nursing' }));
    await user.selectOptions(within(dialog).getByLabelText('Champion for the unit or program'), ids.viewer!);
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(within(dialog).getByRole('list', { name: 'Champions set for units and programs' }).textContent).toContain('BS Nursing'));
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(await hoverTip(user, '3.2')).toMatch(/Champion\s*admin\s*\(From Standard 3\)/);
    await unhover(user, '3.2');
    const own = await hoverTip(user, '3.0');
    expect(own).toMatch(/admin\s*\(Own\)/);
    expect(own).toMatch(/BS Nursing: viewer\s*\(Own\)/);
    await unhover(user, '3.0');

    // The sub-standard overrides; Back to inherited removes its own champion and shows the parent's again.
    await user.click(await actions('3.2'));
    await user.click(screen.getByRole('menuitem', { name: 'Assign champion' }));
    const sub = await screen.findByRole('dialog', { name: /Assign champion/ });
    await waitFor(() => expect(within(sub).getByTestId('champion-overall').textContent).toMatch(/admin\s*\(From Standard 3\)/));
    const subSelect = within(sub).getByLabelText('Overall champion');
    await user.selectOptions(subSelect, await within(subSelect).findByRole('option', { name: 'lead' }));
    await user.click(within(sub).getByRole('button', { name: 'Set champion' }));
    await waitFor(() => expect(within(sub).getByTestId('champion-overall').textContent).toMatch(/lead\s*\(Own\)/));
    expect(within(sub).getByTestId('champion-inherited').textContent).toMatch(/Without its own champion it would be:\s*admin\s*\(From Standard 3\)/);
    await user.click(within(sub).getByRole('button', { name: 'Back to inherited' }));
    await waitFor(() => expect(within(sub).getByTestId('champion-overall').textContent).toMatch(/admin\s*\(From Standard 3\)/));
    await user.click(within(sub).getByRole('button', { name: 'Done' }));
  });
});

describe('an external standard', () => {
  const renderExt = (who: string) => {
    const a = apis(who);
    return a.framework.me().then((me) => render(wrap(<ExternalRequirements api={a.framework} version={ext.version} me={me} evidence={a.evidence} apis={{ scope: a.scope, cycles: a.cycles, settings: a.settings }} />)));
  };

  it('has the same menu first (Link evidence · Assign scope · Assign champion · Create cycle), then the rest', async () => {
    const user = userEvent.setup();
    await renderExt('lead');
    await user.click(await screen.findByRole('button', { name: `Actions for ${tagOf(ext.sub)}` }));
    const names = menuNames();
    expect(names.slice(0, 4)).toEqual(['Link evidence', 'Assign scope', 'Assign champion', 'Create cycle']);
    expect(names).toContain('Map to IQF…');
  });

  it('shows no operations to a viewer', async () => {
    const user = userEvent.setup();
    await renderExt('viewer');
    await screen.findByRole('region', { name: tagOf(ext.sub) });
    // At most "Show source": none of the operations.
    const menu = screen.queryByRole('button', { name: `Actions for ${tagOf(ext.sub)}` });
    if (menu) { await user.click(menu); expect(menuNames()).not.toEqual(expect.arrayContaining(['Assign scope'])); expect(menuNames()).not.toContain('Create cycle'); expect(menuNames()).not.toContain('Link evidence'); }
  });

  it('inherits scope and champion through an approved mapping, labelled with the IQF code; unites; asks for one when the mapped items disagree', async () => {
    const user = userEvent.setup();
    const lead = apis('lead');
    const a = lead.framework;
    const assess = iqf.find((r) => r.title === 'Assessment of learning')!;
    const other = iqf.find((r) => r.parentId && r.id !== assess.id)!;
    await lead.scope.setScope({ frameworkId: ids.iqfFw!, code: assess.code, levelKey: 'program', itemIds: [ids.nursing!] });
    await lead.scope.setChampion({ frameworkId: ids.iqfFw!, code: assess.code, userId: ids.admin! });
    // A proposed mapping passes nothing: nothing yet.
    const m = await a.createMapping(ids.abet!, { externalRequirementId: ext.sub.id, internalRequirementId: assess.id, relation: 'covers', rationale: 'same ground' });
    await renderExtHover(user, 'none');
    await apis('admin').framework.reviewMapping(m.id, 'approved');
    cleanup();
    const tip = await renderExtHover(user, 'tip');
    expect(tip).toMatch(new RegExp(`Scope\\s*Program: BS Nursing\\s*\\(From IQF ${assess.code.replace('.', '\\.')}\\)`));
    expect(tip).toMatch(new RegExp(`Champion\\s*admin\\s*\\(From IQF ${assess.code.replace('.', '\\.')}\\)`));
    cleanup();

    // A second approved mapping with a different champion and scope: united scope, "Needs a champion".
    await lead.scope.setScope({ frameworkId: ids.iqfFw!, code: other.code, levelKey: 'unit', itemIds: [ids.physics!] });
    await lead.scope.setChampion({ frameworkId: ids.iqfFw!, code: other.code, userId: ids.viewer! });
    const m2 = await a.createMapping(ids.abet!, { externalRequirementId: ext.sub.id, internalRequirementId: other.id, relation: 'related', rationale: 'also' });
    await apis('admin').framework.reviewMapping(m2.id, 'approved');
    const both = await renderExtHover(user, 'tip');
    expect(both).toMatch(/Program: BS Nursing/);
    expect(both).toMatch(/Unit: Physics/);
    expect(both).toMatch(/Needs a champion: the mapped IQF items do not agree/);
    cleanup();

    // Choosing a champion on the external requirement overrides it ("Own"); Back to inherited asks for one again.
    await renderExt('lead');
    await user.click(await screen.findByRole('button', { name: `Actions for ${tagOf(ext.sub)}` }));
    await user.click(screen.getByRole('menuitem', { name: 'Assign champion' }));
    const dialog = await screen.findByRole('dialog', { name: /Assign champion/ });
    await waitFor(() => expect(within(dialog).getByTestId('champion-current').textContent).toContain('Needs a champion'));
    const extSelect = within(dialog).getByLabelText('Overall champion');
    await user.selectOptions(extSelect, await within(extSelect).findByRole('option', { name: 'lead' }));
    await user.click(within(dialog).getByRole('button', { name: 'Set champion' }));
    await waitFor(() => expect(within(dialog).getByTestId('champion-overall').textContent).toMatch(/lead\s*\(Own\)/));
    expect(within(dialog).getByTestId('champion-inherited').textContent).toContain('Needs a champion');
    await user.click(within(dialog).getByRole('button', { name: 'Back to inherited' }));
    await waitFor(() => expect(within(dialog).getByTestId('champion-current').textContent).toContain('Needs a champion'));
  });

  async function renderExtHover(user: ReturnType<typeof userEvent.setup>, expectation: 'tip' | 'none'): Promise<string> {
    await renderExt('lead');
    const card = await screen.findByRole('region', { name: tagOf(ext.sub) });
    await user.hover(card.querySelector('button[data-tree-focus]') as HTMLElement);
    const tip = await screen.findByRole('tooltip');
    await waitFor(() => expect(tip.textContent).toContain('Mapped to IQF'));
    if (expectation === 'none') {
      await waitFor(() => expect(tip.textContent).toMatch(/Scope\s*No scope set/));
      expect(tip.textContent).toMatch(/Champion\s*No champion set/);
    } else await waitFor(() => expect(tip.textContent).toMatch(/\(From IQF/));
    return screen.getByRole('tooltip').textContent ?? '';
  }
});

describe('Create cycle', () => {
  it('says there is no published template and points to Settings -> Quality Management; still offers an empty cycle', async () => {
    const user = userEvent.setup();
    render(wrap(qm('lead')));
    await user.click(await actions('3.2'));
    await user.click(screen.getByRole('menuitem', { name: 'Create cycle' }));
    const dialog = await screen.findByRole('dialog', { name: /Create cycle/ });
    expect((await within(dialog).findByTestId('no-templates')).textContent).toMatch(/no published cycle templates.*Settings → Quality Management/);
    expect(within(dialog).getAllByRole('option', { name: 'No template (empty cycle)' })).toHaveLength(1);
  });

  it('creates a draft cycle anchored on the standard from a published template, then links to Quality Management', async () => {
    const user = userEvent.setup();
    const a = apis('lead');
    const tpl = await a.cycles.createTemplate({
      key: 'evidence_round', name: 'Evidence round', anchorKinds: ['requirement'],
      stages: [{ key: 'collect', name: 'Collect evidence', process: '', checklist: [], unit: { kind: 'subject' }, owner: { kind: 'cycle_lead' }, startOffsetDays: 0, lengthDays: 14, outputs: [{ key: 'note', name: 'Summary', kind: 'note', required: true }], inputs: [] }] as never,
    });
    await a.cycles.publishTemplate(tpl.id);
    // A template for another kind of anchor is not offered.
    const other = await a.cycles.createTemplate({ key: 'unit_only', name: 'Unit review', anchorKinds: ['org_unit'], stages: tpl.stages });
    await a.cycles.publishTemplate(other.id);

    render(wrap(qm('lead')));
    await user.click(await actions('3.2'));
    await user.click(screen.getByRole('menuitem', { name: 'Create cycle' }));
    const dialog = await screen.findByRole('dialog', { name: /Create cycle/ });
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Evidence round' })).toBeTruthy());
    expect(within(dialog).queryByRole('option', { name: 'Unit review' })).toBeNull();
    expect(within(dialog).queryByTestId('no-templates')).toBeNull();
    // A subject is needed (the cycle's unit comes from it).
    await user.selectOptions(within(dialog).getByLabelText('Who the cycle is about'), '');
    expect((within(dialog).getByRole('button', { name: 'Create cycle' }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(within(dialog).getByLabelText('Template'), tpl.id);
    await user.selectOptions(within(dialog).getByLabelText('Who the cycle is about'), `program:${ids.nursing}`);
    await user.clear(within(dialog).getByLabelText('Start date'));
    await user.type(within(dialog).getByLabelText('Start date'), '2026-11-01');
    await user.selectOptions(within(dialog).getByLabelText('Cycle lead'), ids.admin!);
    await user.click(within(dialog).getByRole('button', { name: 'Create cycle' }));
    const done = await within(dialog).findByTestId('cycle-confirmation');
    expect(done.textContent).toMatch(/Evidence round.*was created as a draft/);
    expect(within(done).getByRole('link', { name: 'Open Quality Management' }).getAttribute('href')).toBe('/quality-management');

    const cycles = await a.cycles.list({});
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ anchorKind: 'requirement', subjectKind: 'program', subjectId: ids.nursing, status: 'draft', startDate: '2026-11-01', leadUserId: ids.admin });
    expect(cycles[0]!.anchorName).toContain(code('Assessment of learning'));
  });

  it('is offered only to someone who manages cycles', async () => {
    const user = userEvent.setup();
    render(wrap(qm('contributor')));
    await user.click(await actions('3.2'));
    expect(menuNames()).not.toContain('Create cycle');
  });
});

describe('Settings -> Organization -> Institution -> Scope levels', () => {
  it('lists Institution, Unit, Program, Course (Course: No courses yet); an administrator adds, renames, reorders and deactivates; nothing is deleted', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<OrganizationPage api={a.settings} />));
    const list = await screen.findByRole('list', { name: 'Scope levels' });
    const rows = () => within(list).getAllByTestId('scope-level-row');
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(rows().map((r) => (within(r).getAllByRole('textbox')[0] as HTMLInputElement).value)).toEqual(['Institution', 'Unit', 'Program', 'Course']);
    expect(within(rows()[3]!).getByTestId('scope-level-what').textContent).toBe('No courses yet');
    expect(within(rows()[1]!).getByTestId('scope-level-what').textContent).toBe('Units: 2');
    expect(within(rows()[2]!).getByTestId('scope-level-what').textContent).toBe('Programs: 2');

    const form = await screen.findByRole('form', { name: 'Add level' });
    await user.type(within(form).getByLabelText('New level (English)'), 'Research centre');
    await user.type(within(form).getByLabelText('New level (Arabic)'), 'مركز بحثي');
    await user.click(within(form).getByRole('button', { name: 'Add level' }));
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect((within(rows()[4]!).getAllByRole('textbox')[1] as HTMLInputElement).dir).toBe('auto');
    expect(within(rows()[4]!).getByTestId('scope-level-what').textContent).toBe('No list: covers all');

    await user.clear(within(list).getByLabelText('Name of Research centre (English)'));
    await user.type(within(list).getByLabelText('Name of Research centre (English)'), 'Centre');
    await user.click(within(list).getByRole('button', { name: 'Save Research centre' }));
    await waitFor(() => expect(within(list).getByLabelText('Name of Centre (English)')).toBeTruthy());
    await user.click(within(list).getByRole('button', { name: 'Move Centre up' }));
    await waitFor(() => expect((within(rows()[3]!).getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('Centre'));
    await user.click(within(list).getByRole('button', { name: 'Deactivate Centre' }));
    await waitFor(() => expect(within(list).getByRole('button', { name: 'Reactivate Centre' })).toBeTruthy());
    expect(within(list).queryByRole('button', { name: /^Remove|^Delete/ })).toBeNull();
    // An inactive level leaves the scope picker.
    expect((await a.scope.levels()).find((l) => l.labelEn === 'Centre')!.active).toBe(false);
    await user.click(within(list).getByRole('button', { name: 'Reactivate Centre' }));
  });

  it('is read-only for someone who cannot write the organization', async () => {
    const a = apis('viewer');
    render(wrap(<OrganizationPage api={a.settings} />));
    const list = await screen.findByRole('list', { name: 'Scope levels' });
    await waitFor(() => expect(within(list).getAllByTestId('scope-level-row').length).toBeGreaterThanOrEqual(4));
    for (const input of within(list).getAllByRole('textbox')) expect((input as HTMLInputElement).disabled).toBe(true);
    expect(within(list).queryByRole('button', { name: /^Save|Move|Deactivate/ })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add level' })).toBeNull();
  });
});
