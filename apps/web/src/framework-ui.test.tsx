// @vitest-environment jsdom
// UI tests run the real API (real routes, permissions, database rules) behind the typed client: no mocks of the contract.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { handlers, runJob } from '@ams/core';
import type { JobEnvelope } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { frameworkApi, type FrameworkApi } from './lib/framework-api';
import { FrameworksPage } from './pages/frameworks';
import { VersionPage } from './pages/version';
import { readStatus } from './pages/version/sources-section';

// Pages fill from real requests; a loaded machine (or CI) needs more than the default second.
configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const queued: JobEnvelope[] = [];
const ids = {} as Record<string, string>;

async function one(sql: string, params: unknown[] = []) { return (await db.su.query(sql, params)).rows[0].id as string; }
type Who = 'admin' | 'lead' | 'viewer';
const fetchAs = (who: Who) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apiFor = (who: Who): FrameworkApi => frameworkApi(createApi(fetchAs(who)), fetchAs(who));
/** Pages use router links, so they render inside a memory router; the page under test is the root route's component. */
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}

const file = (edition = '2023') => ({
  format: 'ams-framework', format_version: 1,
  accreditor: { name: 'Public University Council', short_name: 'PUC', type: 'institutional' },
  framework: { name: 'Institutional Guide', scope: 'institution' },
  version: { edition },
  config: {
    level_labels: ['Standard', 'Measure'],
    lifecycle_template: { phases: [{ type: 'self_study', name: 'Self-study', applies_to: ['reaffirmation'], milestones: [
      { key: 'submit', name: 'Submit', type: 'submission', deliverable: { report_template_key: 'report' }, due: { anchor: 'submission_date', offset_days: 0 } }] }] },
    decision_vocab: [{ code: 'ok', label: 'Accredited', outcome: 'accredited' }],
    finding_vocab: [{ code: 'c', label: 'Condition', requires_action: true }],
    response_vocab: [{ code: 'l', label: 'Letter', is_decision: true }],
    report_templates: [{ key: 'report', name: 'تقرير الدراسة الذاتية', kind: 'self_study', language: 'ar', structure: { sections: [{ key: 'A', title: 'المقدمة', block_type: 'narrative' }] } }],
  },
  source_documents: [{ ref: 'g', title: 'Guide', role: 'standards', authority: 'binding', pages: [{ page_no: 2, text: 'Institutions must publish their mission statement.', method: 'pdf_text' }] }],
  requirements: [
    { code: '1', parent_code: null, level_label: 'Standard', title: 'الرسالة والأهداف', language: 'ar', official_text: 'يجب أن تكون للمؤسسة رسالة معلنة.' },
    { code: '1-1', parent_code: '1', level_label: 'Measure', title: 'Mission statement',
      notes: [{ type: 'evidence_expectation', text: 'Publish the mission', authority: 'required', source: { document: 'g', page: 2, quote: 'must publish their mission statement' } }] },
  ],
});

/** New Standard opens a wizard; importing is its first choice. */
async function openImport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New Standard' }));
  const dialog = await screen.findByRole('dialog', { name: 'New Standard' });
  await user.click(within(dialog).getByRole('button', { name: /Import a file/ }));
}

async function importAs(who: Who, edition: string, autoApprove = false) {
  return apiFor(who).importFile({ file: file(edition), edition, ...(autoApprove ? { autoApprove } : {}) });
}

beforeAll(async () => {
  db = await createTestDb('webfw');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store, queue: { send: async (_type, envelope) => { queued.push(envelope); } },
    authenticate: async (req) => {
      const h = req.headers.get('x-test-user');
      if (!h) return null;
      const [userId, institutionId] = h.split(':');
      return { userId: userId!, institutionId: institutionId! };
    },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [who, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']] as const) {
    ids[who] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, `${who}@x.org`]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[who], role]);
  }
}, 30000);
afterEach(cleanup);
afterAll(async () => { await pool.end(); await db.close(); });

describe('frameworks page', () => {
  it('lets a viewer read but not import; shows the empty state', async () => {
    render(wrap(<FrameworksPage api={apiFor('viewer')} />));
    expect(await screen.findByText(/No standards yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New Standard' })).toBeNull();
  });

  it('imports a pasted file, reports counts, and lists the new framework with its draft', async () => {
    const user = userEvent.setup();
    render(wrap(<FrameworksPage api={apiFor('lead')} />));
    await openImport(user);
    const box = await screen.findByLabelText('Standard JSON');
    await user.click(box);
    await user.paste(JSON.stringify(file('2023')));
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/2 requirements, 1 documents, 1 templates/);
    const card = await screen.findByRole('region', { name: 'Institutional Guide' });
    expect(card.textContent).toMatch(/Version 2023 · Draft/);
  });

  it('shows each standard as a card: accreditor, name, scope and the version in use, with the versions inside', async () => {
    const user = userEvent.setup();
    render(wrap(<FrameworksPage api={apiFor('lead')} />));
    const card = await screen.findByRole('region', { name: 'Institutional Guide' });
    expect(card.textContent).toContain('Institutional · Version 2023 · Draft'); // scope, version and its state, under the name
    expect(card.textContent).not.toContain('PUC ·');
    expect(within(card).queryByRole('link')).toBeNull(); // no button on the closed card
    expect(within(card).queryByTestId('version-row')).toBeNull(); // versions are inside, until it is opened
    await user.click(within(card).getByRole('button', { name: /^Institutional Guide/ }));
    const row = within(card).getAllByTestId('version-row').find((r) => /Version 2023/.test(r.textContent ?? ''))!;
    expect(row.textContent).toMatch(/Draft/);
    expect(row.textContent).toMatch(/Not published/);
    expect(row.textContent).toMatch(/2 requirements · 0\/2 mapped/);
    expect(within(row).getByRole('link', { name: /Edit version 2023 of Institutional Guide/ }).getAttribute('href')).toMatch(/^\/settings\/versions\//);
    expect(within(card).getByTestId('standard-summary').textContent).toMatch(/2 requirements.*0 of 2 mapped.*0 engagements use it/);
    expect(within(card).getByText('Public University Council')).toBeTruthy();
  });

  it('offers open, details, a new version and a new edition from the card menu', async () => {
    const user = userEvent.setup();
    render(wrap(<FrameworksPage api={apiFor('lead')} />));
    const card = await screen.findByRole('region', { name: 'Institutional Guide' });
    expect(within(card).queryByRole('img', { name: 'PUC logo' })).toBeNull(); // the short name on a tile until there is a logo
    await user.click(within(card).getByRole('button', { name: 'Actions for Institutional Guide' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Open', 'Edit details', 'Start a new version', 'Import a new edition']);
  });

  it('starts a new version from the card, and a viewer gets no editing actions', async () => {
    const user = userEvent.setup();
    const { unmount } = render(wrap(<FrameworksPage api={apiFor('lead')} />));
    const card = await screen.findByRole('region', { name: 'Institutional Guide' });
    await user.click(within(card).getByRole('button', { name: /^Institutional Guide/ }));
    await user.click(within(card).getByRole('button', { name: 'Start a new version' }));
    await user.type(within(card).getByLabelText('New edition'), '2026');
    await user.click(within(card).getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(within(card).queryByLabelText('New edition')).toBeNull());
    unmount();
    render(wrap(<FrameworksPage api={apiFor('viewer')} />));
    const ro = await screen.findByRole('region', { name: 'Institutional Guide' });
    expect(ro.textContent).toMatch(/Version 2026 · Draft/); // the newest version is shown on the card
    await user.click(within(ro).getByRole('button', { name: 'Actions for Institutional Guide' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Open', 'Details']);
    await user.keyboard('{Escape}');
    await user.click(within(ro).getByRole('button', { name: /^Institutional Guide/ }));
    expect(within(ro).queryByRole('button', { name: 'Start a new version' })).toBeNull();
    expect(within(ro).queryByRole('button', { name: 'Import a new edition' })).toBeNull();
  });

  it('creates a standard from scratch through the wizard, which then closes', async () => {
    const user = userEvent.setup();
    render(wrap(<FrameworksPage api={apiFor('lead')} />));
    await user.click(await screen.findByRole('button', { name: 'New Standard' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Standard' });
    await user.click(within(dialog).getByRole('button', { name: /Start from scratch/ }));
    await user.type(within(dialog).getByLabelText('Accreditor name'), 'National Board');
    await user.type(within(dialog).getByLabelText('Short name'), 'NB');
    await user.type(within(dialog).getByLabelText('Standard name'), 'Quality Handbook');
    await user.click(within(dialog).getByRole('button', { name: 'Create standard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Quality Handbook')).toBeTruthy();
  });

  it('closes the wizard with Escape and keeps the page free of import and create forms', async () => {
    const user = userEvent.setup();
    render(wrap(<FrameworksPage api={apiFor('lead')} />));
    await screen.findByRole('button', { name: 'New Standard' });
    expect(screen.queryByLabelText('Standard JSON')).toBeNull();
    expect(screen.queryByText('Create a standard from scratch')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'New Standard' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows malformed JSON and every server-side problem', async () => {
    const user = userEvent.setup();
    render(wrap(<FrameworksPage api={apiFor('lead')} />));
    await openImport(user);
    const box = await screen.findByLabelText('Standard JSON');
    await user.click(box);
    await user.paste('{ nope');
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Not valid JSON/);

    await user.clear(box);
    const broken = file('x'); broken.requirements[1]!.parent_code = 'ghost'; broken.requirements.push({ ...broken.requirements[0]! });
    await user.click(box);
    await user.paste(JSON.stringify(broken));
    await user.click(screen.getByRole('button', { name: 'Import' }));
    const list = await screen.findByRole('list', { name: 'Import problems' });
    expect(list.textContent).toMatch(/unknown parent ghost/);
    expect(list.textContent).toMatch(/duplicate code 1/);
  });
});

describe('version page', () => {
  it('shows requirements as cards, items indented under their parent, notes with authority badges and verified quotes, and gives Arabic content its own direction', async () => {
    const { version } = await importAs('lead', 'tree-view');
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} onOpenVersion={() => undefined} />));
    const top = await screen.findByRole('region', { name: 'Standard 1' });
    expect(await screen.findAllByTestId('requirement-card')).toHaveLength(2);
    expect(top.querySelector('[dir="auto"]')?.textContent).toContain('الرسالة والأهداف');
    const items = screen.getByRole('list', { name: 'Items of Standard 1' }); // listed under its parent, not inside it
    expect(within(top).queryByText('Mission statement')).toBeNull();
    const sub = within(items).getByRole('region', { name: 'Measure 1-1' });
    await user.click(within(sub).getByRole('button', { name: /^Measure 1-1/ }));
    const note = await within(sub).findByTestId('note');
    expect(within(note).getByTestId('authority').textContent).toBe('Required');
    expect(within(note).getByTestId('quote-state').textContent).toBe('Quote verified');
    // An external standard's lines carry no review status: publishing the version is the review (DEC-022).
    expect(within(note).queryByTestId('review')).toBeNull();
    expect(within(note).queryByRole('button', { name: /Approve|Reject/ })).toBeNull();
    expect(within(sub).queryByTestId('review')).toBeNull();
  });

  it('edits a requirement without per-line review labels or approve/reject; a viewer sees no edit controls', async () => {
    const { version } = await importAs('admin', 'edit-flow', true);
    const user = userEvent.setup();
    const { unmount } = render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} onOpenVersion={() => undefined} />));
    const card = await screen.findByRole('region', { name: 'Measure 1-1' });
    expect(within(card).queryByTestId('review')).toBeNull(); // the seed-style auto-approved data shows no label
    await user.click(within(card).getByRole('button', { name: 'Actions for Measure 1-1' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Add measure', 'Edit', 'Merge into another requirement', 'Split', 'Move to…', 'Delete']); // no Approve / Reject
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const title = within(dialog).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Mission statement (revised)');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('region', { name: 'Measure 1-1' }).textContent).toContain('Mission statement (revised)'));
    expect(within(screen.getByRole('region', { name: 'Measure 1-1' })).queryByTestId('review')).toBeNull();
    expect(screen.getByRole('region', { name: 'Measure 1-1' }).textContent).toContain('Mission statement (revised)');
    unmount();

    render(wrap(<VersionPage versionId={version.id} api={apiFor('viewer')} onOpenVersion={() => undefined} />));
    const ro = await screen.findByRole('region', { name: 'Measure 1-1' });
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Requirement' })).toBeNull();
    await user.click(within(ro).getByRole('button', { name: /^Measure 1-1/ }));
    expect(within(ro).queryByRole('form', { name: 'Add note' })).toBeNull();
  });

  it('adds a requirement from a dialog, under a parent, at the next level', async () => {
    const { version } = await importAs('lead', 'add-req');
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} onOpenVersion={() => undefined} />));
    const top = await screen.findByRole('region', { name: 'Standard 1' });
    await user.click(within(top).getByRole('button', { name: 'Actions for Standard 1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Add measure' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Under') as HTMLSelectElement).selectedOptions[0]!.textContent).toContain('Standard 1');
    expect((within(dialog).getByLabelText('Level') as HTMLSelectElement).value).toBe('Measure');
    await user.type(within(dialog).getByLabelText('Code'), '1-2');
    await user.type(within(dialog).getByLabelText('Title'), 'Vision statement');
    await user.type(within(dialog).getByLabelText('Description'), 'A vision is published.');
    await user.click(within(dialog).getByRole('button', { name: 'Add requirement' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const added = await within(screen.getByRole('list', { name: 'Items of Standard 1' })).findByRole('region', { name: 'Measure 1-2' });
    expect(added.textContent).toContain('Vision statement');
    expect(added.getAttribute('aria-label')).toBe('Measure 1-2');
  });

  it('adds a note whose quote is verified against the stored page, and flags one that is not', async () => {
    const { version } = await importAs('lead', 'add-note');
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} onOpenVersion={() => undefined} />));
    await user.click(within(await screen.findByRole('region', { name: 'Standard 1' })).getByRole('button', { name: /^Standard 1/ }));
    const form = await screen.findByRole('form', { name: 'Add note' });
    await user.type(within(form).getByLabelText('Note text'), 'Complete the worksheet');
    await user.selectOptions(within(form).getByLabelText('Authority'), 'required');
    await user.selectOptions(within(form).getByLabelText('Source document'), 'Guide');
    await user.type(within(form).getByLabelText('Source page'), '2');
    await user.type(within(form).getByLabelText('Source quote'), 'a sentence that is not on the page');
    await user.click(within(form).getByRole('button', { name: 'Add note' }));
    const notes = await screen.findAllByTestId('note');
    expect(within(notes[0]!).getByTestId('quote-state').textContent).toBe('Quote NOT verified');
  });

  it('promotes an AI-suggested note only through an explicit person action', async () => {
    const { version } = await importAs('lead', 'ai-note');
    const reqs = await apiFor('lead').requirements(version.id);
    await db.su.query(
      `insert into requirement_note (institution_id, requirement_id, type, text, authority, origin) values ($1, $2, 'guidance', 'Inferred by the extractor', 'ai_suggested', 'ai')`, [ids.inst, reqs[0]!.id]);
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} onOpenVersion={() => undefined} />));
    await user.click(within(await screen.findByRole('region', { name: 'Standard 1' })).getByRole('button', { name: /^Standard 1/ }));
    const notes = await screen.findAllByTestId('note');
    const analysisLabel = 'Suggested by the analysis (not confirmed in the source)';
    const ai = notes.find((n) => within(n).getByTestId('authority').textContent === analysisLabel)!;
    await user.click(within(ai).getByRole('button', { name: 'Promote to suggested' }));
    await waitFor(() => expect(screen.getAllByTestId('authority').map((a) => a.textContent)).not.toContain(analysisLabel));
    expect(screen.getAllByTestId('authority').map((a) => a.textContent)).toContain('Suggested');
  });

  it('edits the lifecycle as JSON: malformed JSON is stopped locally, invalid configuration is listed with paths', async () => {
    const { version } = await importAs('lead', 'json-editor');
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} onOpenVersion={() => undefined} />));
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Lifecycle and vocabularies' }));
    const area = await screen.findByLabelText('Lifecycle template');
    await user.clear(area);
    await user.click(area);
    await user.paste('{ "phases": ');
    expect((await screen.findAllByRole('alert'))[0]!.textContent).toMatch(/Not valid JSON/);
    expect((screen.getByRole('button', { name: 'Save Lifecycle template' }) as HTMLButtonElement).disabled).toBe(true);

    await user.clear(area);
    await user.click(area);
    await user.paste('{ "phases": [] }');
    await user.click(screen.getByRole('button', { name: 'Save Lifecycle template' }));
    const issues = await screen.findByRole('list', { name: 'Validation issues' });
    expect(issues.textContent).toMatch(/phases/);
  });

  it('edits a report template as JSON and shows server validation', async () => {
    const { version } = await importAs('lead', 'tpl-editor');
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} onOpenVersion={() => undefined} />));
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Report templates' }));
    await user.click(await screen.findByRole('button', { name: /تقرير الدراسة الذاتية/ }));
    const area = await screen.findByLabelText('Template');
    await user.clear(area);
    await user.click(area);
    await user.paste(JSON.stringify({ name: 'T', kind: 'annual', structure: { sections: [{ key: 'X', title: 'X', block_type: 'data_table' }] } }));
    await user.click(screen.getByRole('button', { name: 'Save Template' }));
    expect((await screen.findByRole('list', { name: 'Validation issues' })).textContent).toMatch(/data_table needs columns/);
  });

  it('names the standard in the header, and moves a version through review with one button that follows its state', async () => {
    const { version } = await importAs('admin', 'publish-flow');
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={apiFor('admin')} onOpenVersion={() => undefined} />));
    expect(await screen.findByRole('heading', { level: 1, name: 'Institutional Guide' })).toBeTruthy();
    expect(document.querySelector('header')!.textContent).toContain('Public University Council · Institutional');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Requirements', 'Mappings', 'Settings']);
    expect(screen.queryByTestId('config-problems')).toBeNull(); // the configuration is valid
    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(screen.getByTestId('version-status').textContent).toBe('In review'));
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Download JSON', 'Return to draft']);
    await user.click(screen.getByRole('menuitem', { name: 'Return to draft' }));
    await waitFor(() => expect(screen.getByTestId('version-status').textContent).toBe('Draft'));

    // Nothing is approved line by line: publishing the version is the review (DEC-022), and records who published.
    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(screen.getByTestId('version-status').textContent).toBe('Published'));
    expect(await apiFor('admin').version(version.id)).toMatchObject({ status: 'published', publishedBy: ids.admin });
    expect((await apiFor('admin').requirements(version.id)).map((r) => r.reviewStatus)).toEqual(['pending', 'pending']); // not mass-approved
    expect(await screen.findByRole('button', { name: 'Start a new version' })).toBeTruthy();

    await user.click(within(await screen.findByRole('region', { name: 'Standard 1' })).getByRole('button', { name: /^Standard 1/ }));
    await screen.findByTestId('requirement-detail');
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Requirement' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add note' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Lifecycle and vocabularies' }));
    expect(screen.getByText(/configuration is read-only/)).toBeTruthy();
    expect((screen.getByLabelText('Lifecycle template') as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it('lists a required note without a verified quote as a problem, and a requirement quote not found as a softer warning', async () => {
    const { version } = await importAs('lead', 'warnings');
    const [std] = await apiFor('lead').requirements(version.id);
    const doc = (await apiFor('lead').documents(version.id))[0]!;
    await db.su.query(`update requirement set origin = 'ai', source_document_id = $2, source_page = 2, source_quote = 'not on the page', quote_verified = false where id = $1`, [std!.id, doc.id]);
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} onOpenVersion={() => undefined} />));
    const warn = await screen.findByTestId('content-warnings');
    expect(warn.textContent).toContain('1 thing to check before publishing (not blocking)');
    await user.click(within(warn).getByRole('button'));
    expect(within(warn).getByRole('list', { name: 'Warnings' }).textContent).toContain('quote was not found in the sources: 1');
    expect(screen.queryByTestId('config-problems')).toBeNull();
    const card = screen.getByRole('region', { name: 'Standard 1' });
    expect(within(card).getByTestId('ai-marker')).toBeTruthy();
    expect(within(card).getByTestId('quote-not-found')).toBeTruthy();

    await db.su.query(
      `insert into requirement_note (institution_id, requirement_id, type, text, authority, origin, source_document_id, source_page, source_quote, quote_verified) values ($1, $2, 'guidance', 'Keep minutes', 'required', 'ai', $3, 2, 'minutes are kept', false)`,
      [ids.inst, std!.id, doc.id]);
    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect((await screen.findByRole('list', { name: 'Problems' })).textContent).toMatch(/"required" note needs a quote found on its source page/);
    expect(screen.getByTestId('version-status').textContent).toBe('Draft');
    expect((await screen.findByTestId('config-problems')).textContent).toContain('1 problem to fix before this version can be published');
  });

  it('starts a new version from the header of a published one', async () => {
    const { version } = await importAs('admin', 'new-version-src', true);
    const a = apiFor('admin');
    await a.submit(version.id);
    await a.publish(version.id);
    let opened = '';
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={a} onOpenVersion={(id) => { opened = id; }} />));
    await user.click(await screen.findByRole('button', { name: 'Start a new version' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('New edition'), '2025');
    await user.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(opened).not.toBe(''));
    expect((await a.version(opened)).status).toBe('draft');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('edits the standard\'s details and the accreditor\'s, and its logo, in Settings, even on a published version', async () => {
    const { version } = await importAs('admin', 'details-src', true);
    const a = apiFor('admin');
    await a.submit(version.id);
    await a.publish(version.id);
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} initialTab="settings" onOpenVersion={() => undefined} />));
    let form = await screen.findByRole('form', { name: 'Details' });
    const name = within(form).getByLabelText('Standard name');
    await user.clear(name);
    await user.type(name, 'Institutional Accreditation Guide');
    await user.selectOptions(within(form).getByLabelText('Scope'), 'both');
    await user.type(within(form).getByLabelText('Website'), 'https://puc.example.org');
    await user.click(within(form).getByRole('button', { name: 'Save details' }));
    expect((await screen.findByRole('status')).textContent).toBe('Saved.');
    expect(await screen.findByRole('heading', { level: 1, name: 'Institutional Accreditation Guide' })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('header')!.textContent).toContain('· Institutional and programmatic'));

    const png = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])], 'puc.png', { type: 'image/png' });
    form = screen.getByRole('form', { name: 'Details' }); // saved details re-render the form
    await user.upload(within(form).getByLabelText('Logo file'), png);
    expect((await screen.findAllByRole('img', { name: 'PUC logo' }))[0]!.getAttribute('src')).toMatch(/^\/api\/accreditors\/[\w-]+\/logo\?v=\d+$/);
    await user.click(within(form).getByRole('button', { name: 'Remove logo' }));
    await waitFor(() => expect(screen.queryByRole('img', { name: 'PUC logo' })).toBeNull());
    await userEvent.setup({ applyAccept: false }).upload(within(form).getByLabelText('Logo file'), new File(['<svg onload="x()"/>'], 'x.svg', { type: 'image/svg+xml' }));
    expect((await within(form).findByRole('alert')).textContent).toMatch(/PNG, JPEG or WebP/);
    await a.updateFramework(version.frameworkId, { name: 'Institutional Guide', scope: 'institution' }); // leave it as the other tests expect
  });

  it('keeps sources under Settings: add one with its original, read and correct its pages, and fixed once published', async () => {
    const { version } = await importAs('lead', 'sources-ui');
    const user = userEvent.setup();
    const { unmount } = render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} initialTab="settings" initialSection="sources" onOpenVersion={() => undefined} />));
    const section = await screen.findByRole('region', { name: 'Sources' });
    const guide = await within(section).findByRole('region', { name: 'Guide' });
    expect(guide.textContent).toContain('Standards'); // readable labels, not codes
    expect(guide.textContent).toContain('Binding');

    await user.click(within(section).getByRole('button', { name: '+ Source' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Policy manual 2025');
    await user.selectOptions(within(dialog).getByLabelText('What it is'), 'policy_procedure');
    await user.upload(within(dialog).getByLabelText('Original file'), new File(['%PDF-1.7 manual'], 'manual.pdf', { type: 'application/pdf' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const manual = await within(section).findByRole('region', { name: 'Policy manual 2025' });
    expect(manual.textContent).toContain('Policy and procedure');
    expect(within(manual).getByRole('link', { name: 'manual.pdf' }).getAttribute('href')).toMatch(/^\/api\/source-documents\/[\w-]+\/file$/);

    const add = within(manual).getByRole('form', { name: 'Add page to Policy manual 2025' });
    await user.type(within(add).getByLabelText('Page text'), 'Programs report annually.');
    await user.click(within(add).getByRole('button', { name: 'Add page' }));
    const text = await within(manual).findByLabelText('Text of page 1');
    await user.clear(text);
    await user.type(text, 'Programs report every year.');
    await user.click(within(manual).getByRole('button', { name: 'Save page 1' }));
    await waitFor(async () => expect((await apiFor('lead').pages((await apiFor('lead').documents(version.id)).find((d) => d.title === 'Policy manual 2025')!.id))[0]!.text).toBe('Programs report every year.'));
    unmount();

    // Once published, its sources are read, not edited.
    const a = apiFor('admin');
    await a.submit(version.id);
    await a.publish(version.id);
    render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} initialTab="settings" initialSection="sources" onOpenVersion={() => undefined} />));
    const ro = await screen.findByRole('region', { name: 'Sources' });
    expect(within(ro).queryByRole('button', { name: '+ Source' })).toBeNull();
    const fixed = await within(ro).findByRole('region', { name: 'Policy manual 2025' });
    await user.click(within(fixed).getByRole('button', { name: /^Policy and procedure/ }));
    expect((await within(fixed).findByTestId('page-text')).textContent).toBe('Programs report every year.');
    expect(within(fixed).queryByRole('form')).toBeNull();
  });

  it('reads a source file into pages from a button, showing queued, then done, and a quiet viewer', async () => {
    const { version } = await importAs('lead', 'reading-ui');
    const a = apiFor('lead');
    const doc = await a.addDocument(version.id, { title: 'Programs list', role: 'other', authority: 'informational' });
    await a.uploadSourceFile(doc.id, new File(['id,name\n1,Mechanical\n2,Civil\n'], 'programs.csv', { type: 'text/csv' }));
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} initialTab="settings" initialSection="sources" onOpenVersion={() => undefined} />));
    const card = await screen.findByRole('region', { name: 'Programs list' });
    await user.click(within(card).getByRole('button', { name: /^Other/ }));
    expect((await within(card).findByRole('status', { name: 'Reading status of Programs list' })).textContent).toBe('Not read yet');
    await user.click(within(card).getByRole('button', { name: 'Read this file' }));
    await waitFor(() => expect(within(card).getByRole('status', { name: 'Reading status of Programs list' }).textContent).toBe('Reading the file…'));
    expect((within(card).getByRole('button', { name: 'Read this file' }) as HTMLButtonElement).disabled).toBe(true);
    // The worker picks the job up.
    await runJob(pool, 'extract_text', queued.shift(), handlers, { store });
    await waitFor(() => expect(within(card).getByRole('status', { name: 'Reading status of Programs list' }).textContent).toBe('Read: 1 page'));
    expect((await within(card).findByLabelText('Text of page 1') as HTMLTextAreaElement).value).toBe('id,name\n1,Mechanical\n2,Civil');
    expect(within(card).getByRole('button', { name: 'Read this file again' })).toBeTruthy();
    cleanup();

    // Someone who cannot edit sees the status but no button.
    render(wrap(<VersionPage versionId={version.id} api={apiFor('viewer')} initialTab="settings" initialSection="sources" onOpenVersion={() => undefined} />));
    const ro = await screen.findByRole('region', { name: 'Programs list' });
    await userEvent.setup().click(within(ro).getByRole('button', { name: /^Other/ }));
    expect((await within(ro).findByRole('status', { name: 'Reading status of Programs list' })).textContent).toBe('Read: 1 page');
    expect(within(ro).queryByRole('button', { name: /Read this file/ })).toBeNull();
  });

  it('describes where reading stands', () => {
    const d = { title: 'x', storedPages: 4, pageCount: 4, needsOcrPages: 2 } as Parameters<typeof readStatus>[0];
    expect(readStatus({ ...d, textStatus: 'ocr_needed' })).toBe('Read: 4 pages, 2 need OCR');
    expect(readStatus({ ...d, textStatus: 'failed' })).toMatch(/could not be read/);
    expect(readStatus({ ...d, textStatus: 'pending' })).toBe('Not read yet');
  });
});
