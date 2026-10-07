// @vitest-environment jsdom
// UI tests run the real API (real routes, permissions, database rules) behind the typed client: no mocks of the contract.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { frameworkApi, type FrameworkApi } from './lib/framework-api';
import { FrameworksPage } from './pages/frameworks';
import { VersionPage } from './pages/version';

// Pages fill from real requests; a loaded machine (or CI) needs more than the default second.
configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;

async function one(sql: string, params: unknown[] = []) { return (await db.su.query(sql, params)).rows[0].id as string; }
type Who = 'admin' | 'lead' | 'viewer';
const apiFor = (who: Who): FrameworkApi => frameworkApi(createApi(((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch));
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
    pool,
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
    expect(await screen.findByText('Institutional Guide')).toBeTruthy();
    expect(await screen.findByText(/2023/)).toBeTruthy();
  });

  it('shows each version as "Version <edition>" with its status and date, and an Edit icon for a draft', async () => {
    render(wrap(<FrameworksPage api={apiFor('lead')} />));
    const rows = await screen.findAllByTestId('version-row');
    const row = rows.find((r) => /Version 2023/.test(r.textContent ?? ''))!;
    expect(row.textContent).toMatch(/Draft/);
    expect(row.textContent).toMatch(/Not published/);
    const link = within(row).getByRole('link', { name: /Edit version 2023 of Institutional Guide/ });
    expect(link.getAttribute('href')).toMatch(/^\/settings\/versions\//);
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
    expect(within(note).getByTestId('review').textContent).toBe('Pending review');
  });

  it('edits a requirement and returns it to review; a viewer sees no edit controls', async () => {
    const { version } = await importAs('admin', 'edit-flow', true);
    const user = userEvent.setup();
    const { unmount } = render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} onOpenVersion={() => undefined} />));
    const card = await screen.findByRole('region', { name: 'Measure 1-1' });
    expect(within(card).getByTestId('review').textContent).toBe('Reviewed: approved');
    await user.click(within(card).getByRole('button', { name: 'Actions for Measure 1-1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const title = within(dialog).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Mission statement (revised)');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Measure 1-1' })).getByTestId('review').textContent).toBe('Pending review'));
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
    await user.type(within(dialog).getByLabelText('Official text'), 'A vision is published.');
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
    const ai = notes.find((n) => within(n).getByTestId('authority').textContent === 'AI-suggested')!;
    await user.click(within(ai).getByRole('button', { name: 'Promote to suggested' }));
    await waitFor(() => expect(screen.getAllByTestId('authority').map((a) => a.textContent)).not.toContain('AI-suggested'));
    expect(screen.getAllByTestId('authority').map((a) => a.textContent)).toContain('Suggested');
  });

  it('edits the lifecycle as JSON: malformed JSON is stopped locally, invalid configuration is listed with paths', async () => {
    const { version } = await importAs('lead', 'json-editor');
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={apiFor('lead')} onOpenVersion={() => undefined} />));
    await user.click(await screen.findByRole('tab', { name: 'Lifecycle and vocabularies' }));
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
    await user.click(await screen.findByRole('tab', { name: 'Report templates' }));
    await user.click(await screen.findByRole('button', { name: /تقرير الدراسة الذاتية/ }));
    const area = await screen.findByLabelText('Template');
    await user.clear(area);
    await user.click(area);
    await user.paste(JSON.stringify({ name: 'T', kind: 'annual', structure: { sections: [{ key: 'X', title: 'X', block_type: 'data_table' }] } }));
    await user.click(screen.getByRole('button', { name: 'Save Template' }));
    expect((await screen.findByRole('list', { name: 'Validation issues' })).textContent).toMatch(/data_table needs columns/);
  });

  it('review and publish: blocked while unreviewed, then published, after which the version is read-only', async () => {
    const { version } = await importAs('admin', 'publish-flow');
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={apiFor('admin')} onOpenVersion={() => undefined} />));
    await user.click(await screen.findByRole('tab', { name: 'Review and publish' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/configuration is valid/);
    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(screen.getByTestId('version-status').textContent).toBe('In review'));
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect((await screen.findAllByRole('alert'))[0]!.textContent).toMatch(/publish gate/);

    // Approve everything through the API (as reviewers would in the other tabs), then publish.
    const a = apiFor('admin');
    await a.returnToDraft(version.id);
    for (const r of await a.requirements(version.id)) {
      await a.reviewRequirement(r.id, 'approved');
      for (const n of (await a.requirement(r.id)).notes) await a.reviewNote(n.id, 'approved');
    }
    await a.reviewTemplate(version.id, 'report', 'approved');
    await a.submit(version.id);
    await user.click(screen.getByRole('tab', { name: 'Requirements' }));
    await user.click(screen.getByRole('tab', { name: 'Review and publish' }));
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(screen.getByTestId('version-status').textContent).toBe('Published'));

    await user.click(screen.getByRole('tab', { name: 'Requirements' }));
    await user.click(within(await screen.findByRole('region', { name: 'Standard 1' })).getByRole('button', { name: /^Standard 1/ }));
    await screen.findByTestId('requirement-detail');
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Requirement' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add note' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Lifecycle and vocabularies' }));
    expect(screen.getByText(/configuration is read-only/)).toBeTruthy();
    expect((screen.getByLabelText('Lifecycle template') as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it('creates a new draft from a published version', async () => {
    const { version } = await importAs('admin', 'new-version-src', true);
    const a = apiFor('admin');
    await a.submit(version.id);
    await a.publish(version.id);
    let opened = '';
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={version.id} api={a} onOpenVersion={(id) => { opened = id; }} />));
    await user.click(await screen.findByRole('tab', { name: 'Review and publish' }));
    await user.type(await screen.findByPlaceholderText('e.g. 2025'), '2025');
    await user.click(screen.getByRole('button', { name: /Create a new draft/ }));
    await waitFor(() => expect(opened).not.toBe(''));
    expect((await a.version(opened)).status).toBe('draft');
  });
});
