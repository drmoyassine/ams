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
    await user.click(await screen.findByRole('button', { name: '+ Evidence' }));
    const form = await screen.findByRole('dialog', { name: 'New evidence' });
    // kept simple: a title, document or data, an optional description, the file
    expect(within(form).queryByLabelText('Period')).toBeNull();
    expect(within(form).queryByLabelText('Confidentiality')).toBeNull();
    await user.type(within(form).getByLabelText('Title'), 'Course review minutes');
    expect((within(form).getByLabelText('Document') as HTMLInputElement).checked).toBe(true);
    await user.type(within(form).getByLabelText('Description'), 'Minutes of the course review committee');
    await user.upload(within(form).getByLabelText('File'), new File(['minutes v1'], 'minutes.pdf', { type: 'application/pdf' }));
    await user.click(within(form).getByRole('button', { name: 'Create evidence' }));
    // The new item's card opens by itself.
    const card = await screen.findByRole('region', { name: 'Evidence: Course review minutes' });
    await waitFor(() => expect(within(card).getAllByTestId('evidence-version').map((v) => v.textContent)).toEqual([expect.stringMatching(/^v1minutes\.pdf/)]));
    expect(within(card).getByText('Minutes of the course review committee')).toBeTruthy();
    await user.upload(screen.getByLabelText('Upload a new version'), new File(['minutes v2'], 'minutes-2.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(within(card).getAllByTestId('evidence-version')).toHaveLength(2));
    await waitFor(() => expect(within(card).getByTestId('evidence-meta').textContent).toMatch(/v2 · /));
    expect(within(card).getByTestId('evidence-kind').textContent).toBe('PDF');
  });

  it('attaches it to an item of the internal framework with a reason', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<QualityFrameworkPage api={a.framework} glossary={a.glossary} settings={a.settings} evidence={a.evidence} />));
    const item = await screen.findByRole('region', { name: 'Standard 3.2' }); // listed under Standard 3.0 without opening it
    await user.click(within(item).getByRole('button', { name: 'Actions for Standard 3.2' }));
    await user.click(screen.getByRole('menuitem', { name: 'Link evidence' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('Justification')).toBeNull(); // only once evidence is chosen
    await user.type(within(dialog).getByRole('combobox', { name: 'Search evidence' }), 'Course review');
    await user.click(await within(dialog).findByRole('option', { name: /Course review minutes/ }));
    expect(within(dialog).getByTestId('chosen-evidence').textContent).toContain('Course review minutes');
    await user.type(within(dialog).getByLabelText('Justification'), 'Minutes of the annual course review');
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
    await user.type(within(dialog).getByRole('combobox', { name: 'Search evidence' }), 'Teaching observation reports');
    expect(await within(dialog).findByText('No evidence matches "Teaching observation reports".')).toBeTruthy();
    await user.click(within(dialog).getByRole('option', { name: '+ Create new evidence "Teaching observation reports"' }));
    const create = await screen.findByRole('dialog', { name: 'New evidence' });
    expect((within(create).getByLabelText('Title') as HTMLInputElement).value).toBe('Teaching observation reports');
    await user.upload(within(create).getByLabelText('File'), new File(['observations'], 'observations.pdf', { type: 'application/pdf' }));
    await user.click(within(create).getByRole('button', { name: 'Create evidence' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New evidence' })).toBeNull());
    expect((await within(dialog).findByTestId('chosen-evidence')).textContent).toContain('Teaching observation reports');
    await user.type(within(dialog).getByLabelText('Justification'), 'Peer observation of teaching each semester');
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
    await user.type(within(suggestion).getByLabelText('Justification for Course review minutes'), 'Shows the program reviews assessment results every year');
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
    const item = await screen.findByRole('region', { name: 'Evidence: Course review minutes' });
    expect(screen.queryByRole('button', { name: '+ Evidence' })).toBeNull();
    expect(await menuOf(item, 'Course review minutes')).toEqual(['Download latest']);
  });
});

/** The labels of a card's ⋯ menu (closed again afterwards). */
async function menuOf(card: HTMLElement, title: string) {
  const user = userEvent.setup();
  const button = within(card).queryByRole('button', { name: `Actions for ${title}` });
  if (!button) return [];
  await user.click(button);
  const labels = within(screen.getByRole('menu')).getAllByRole('menuitem').map((m) => m.textContent);
  await user.keyboard('{Escape}');
  return labels;
}
/** The button that opens or closes a card (the first in it; the ⋯ menu comes after). */
const toggleOf = (card: HTMLElement) => within(card).getAllByRole('button')[0]!;
const cardNames = () => screen.getAllByTestId('evidence-card').map((c) => c.getAttribute('aria-label'));

describe('the evidence library', () => {
  it('shows on each closed card what it is, what it is linked to, and what needs attention', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    await a.evidence.create({ title: 'Graduate headcount', type: 'data', description: 'Graduates by program and year' });
    render(wrap(<EvidencePage api={a.evidence} framework={a.framework} />));

    const minutes = await screen.findByRole('region', { name: 'Evidence: Course review minutes' });
    expect(toggleOf(minutes).getAttribute('aria-expanded')).toBe('false');
    expect(within(minutes).getByTestId('evidence-kind').textContent).toBe('PDF');
    // Attached to Standard 3.2 and linked to the ABET requirement, both approved: nothing to flag.
    expect(within(minutes).getByTestId('evidence-meta').textContent).toMatch(/^Linked to 2v2 · \d+ \w{3} \d{4}$/);
    expect(await menuOf(minutes, 'Course review minutes')).toEqual(['Upload a new version', 'Link to a standard', 'Request an update', 'Download latest', 'Edit details', 'Archive']);

    const observations = screen.getByRole('region', { name: 'Evidence: Teaching observation reports' });
    expect(within(observations).getByTestId('evidence-meta').textContent).toContain('1 to review');

    const headcount = screen.getByRole('region', { name: 'Evidence: Graduate headcount' });
    expect(within(headcount).getByTestId('evidence-kind').textContent).toBe('DATA');
    expect(within(headcount).getByTestId('evidence-meta').textContent).toBe('Not linked');
    // No version yet: nothing to link or download.
    expect(await menuOf(headcount, 'Graduate headcount')).toEqual(['Open sheet', 'Ask people to fill in the form', 'Edit details', 'Archive']);
    await user.click(within(headcount).getByRole('button', { name: 'Actions for Graduate headcount' }));
    await user.click(screen.getByRole('menuitem', { name: 'Open sheet' }));
    expect(await within(headcount).findByRole('region', { name: 'Data' })).toBeTruthy(); // the sheet, inside the card
    expect(within(headcount).getByText('Graduates by program and year')).toBeTruthy();
    expect(within(headcount).getByText('No data saved yet.')).toBeTruthy();
  });

  it('links an item to a standard of the internal framework from its card, with a reason', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    const item = await a.evidence.create({ title: 'Assessment plan 2026', type: 'document' });
    await a.evidence.upload(item.id, new File(['plan'], 'plan.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    render(wrap(<EvidencePage api={a.evidence} framework={a.framework} />));
    const card = await screen.findByRole('region', { name: 'Evidence: Assessment plan 2026' });
    expect(within(card).getByTestId('evidence-kind').textContent).toBe('DOC');
    await user.click(within(card).getByRole('button', { name: 'Actions for Assessment plan 2026' }));
    await user.click(screen.getByRole('menuitem', { name: 'Link to a standard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link to a standard' });
    const select = within(dialog).getByLabelText('Standard');
    await waitFor(() => expect(within(select).getByRole('option', { name: /Assessment of learning/ })).toBeTruthy());
    expect((within(dialog).getByRole('button', { name: 'Link' }) as HTMLButtonElement).disabled).toBe(true); // the reason is required
    await user.selectOptions(select, ids.assessment!);
    await user.type(within(dialog).getByLabelText('Justification'), 'The plan the assessment committee follows');
    await user.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(within(card).getByTestId('evidence-meta').textContent).toMatch(/^Linked to 11 to review/));
    await user.click(toggleOf(card));
    const link = await within(card).findByTestId('evidence-link');
    expect(link.textContent).toMatch(/Internal 3\.2 · Assessment of learning.*Proposed.*The plan the assessment committee follows/s);
    await user.click(within(link).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(within(card).getByTestId('evidence-meta').textContent).not.toContain('to review'));
  });

  it('asks for an update of a document for a standard, with its title filled in', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<EvidencePage api={a.evidence} framework={a.framework} />));
    const card = await screen.findByRole('region', { name: 'Evidence: Assessment plan 2026' });
    await user.click(within(card).getByRole('button', { name: 'Actions for Assessment plan 2026' }));
    await user.click(screen.getByRole('menuitem', { name: 'Request an update' }));
    const pick = await screen.findByRole('dialog', { name: 'Request an update' });
    await waitFor(() => expect(within(pick).getByRole('option', { name: /Assessment of learning/ })).toBeTruthy());
    await user.selectOptions(within(pick).getByLabelText('Standard'), ids.assessment!);
    await user.click(within(pick).getByRole('button', { name: 'Continue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request evidence' });
    expect(within(dialog).getByText('Standard 3.2 · Assessment of learning')).toBeTruthy();
    expect((within(dialog).getByLabelText('What is needed') as HTMLInputElement).value).toBe('Assessment plan 2026');
    await user.type(within(dialog).getByLabelText('Ask (email)'), 'dean@partner.com');
    await user.click(within(dialog).getByRole('button', { name: 'Request' }));
    expect(await within(dialog).findByTestId('response-link')).toBeTruthy();
    expect((await a.evidence.requests(false)).map((r) => [r.title, r.internalTitle])).toEqual([['Assessment plan 2026', 'Assessment of learning']]);
  });

  it('edits the details, but keeps a document with files a document', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<EvidencePage api={a.evidence} framework={a.framework} />));
    const card = await screen.findByRole('region', { name: 'Evidence: Assessment plan 2026' });
    await user.click(within(card).getByRole('button', { name: 'Actions for Assessment plan 2026' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit details' });
    await user.click(within(dialog).getByRole('radio', { name: 'Data' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('this document has file versions; it cannot become data');
    await user.click(within(dialog).getByRole('radio', { name: 'Document' }));
    await user.type(within(dialog).getByLabelText('Description'), 'Approved by the council');
    await user.clear(within(dialog).getByLabelText('Title'));
    await user.type(within(dialog).getByLabelText('Title'), 'Assessment plan 2026-27');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('region', { name: 'Evidence: Assessment plan 2026-27' })).toBeTruthy();
  });

  it('archives an item out of the library, restores it from Archived, and filters the rest', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<EvidencePage api={a.evidence} framework={a.framework} />));
    const card = await screen.findByRole('region', { name: 'Evidence: Graduate headcount' });
    await user.click(within(card).getByRole('button', { name: 'Actions for Graduate headcount' }));
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Evidence: Graduate headcount' })).toBeNull());

    const filters = screen.getByRole('group', { name: 'Show' });
    await user.click(within(filters).getByRole('button', { name: 'Archived' }));
    expect(within(filters).getByRole('button', { name: 'Archived' }).getAttribute('aria-pressed')).toBe('true');
    const archived = await screen.findByRole('region', { name: 'Evidence: Graduate headcount' });
    expect(cardNames()).toEqual(['Evidence: Graduate headcount']);
    expect(within(archived).getByTestId('evidence-meta').textContent).toContain('Archived');
    expect(await menuOf(archived, 'Graduate headcount')).toEqual(['Open sheet', 'Edit details', 'Restore']);
    await user.click(within(archived).getByRole('button', { name: 'Actions for Graduate headcount' }));
    await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
    expect(await screen.findByText('Nothing matches.')).toBeTruthy();

    await user.click(within(filters).getByRole('button', { name: 'Data' }));
    await waitFor(() => expect(cardNames()).toEqual(['Evidence: Graduate headcount']));
    await user.click(within(filters).getByRole('button', { name: 'Documents' }));
    await waitFor(() => expect(cardNames()).not.toContain('Evidence: Graduate headcount'));
    await user.click(within(filters).getByRole('button', { name: 'Not linked' }));
    await waitFor(() => expect(cardNames()).toEqual(['Evidence: Graduate headcount']));
    await user.click(within(filters).getByRole('button', { name: 'To review' }));
    await waitFor(() => expect(cardNames()).toEqual(['Evidence: Teaching observation reports']));
  });

  it('lists every request in the institution under the Requests tab', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<EvidencePage api={a.evidence} framework={a.framework} />));
    const tabs = await screen.findByRole('tablist', { name: 'Evidence' });
    expect(within(tabs).getByRole('tab', { name: 'Library' }).getAttribute('aria-selected')).toBe('true');
    await user.click(within(tabs).getByRole('tab', { name: 'Requests' }));
    expect(within(tabs).getByRole('tab', { name: 'Requests' }).getAttribute('aria-selected')).toBe('true');
    const row = await screen.findByTestId('evidence-request');
    expect(row.textContent).toMatch(/Assessment plan 2026.*Requested.*Internal 3\.2 · Assessment of learning/s);
    expect(within(row).getByRole('button', { name: 'Cancel request' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Evidence' })).toBeNull();
  });
});
